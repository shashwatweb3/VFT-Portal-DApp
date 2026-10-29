import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GearApi, GearKeyring, HexString } from '@gear-js/api'
import { decodeAddress } from '@polkadot/util-crypto'
import { Sails } from 'sails-js'
import { SailsIdlParser } from 'sails-js-parser'

import { IssueLimiter, SlidingCap, normaliseAddress } from './rate-limit.ts'
import { Keeper, withTimeout } from './keeper.ts'

const env = (key: string, fallback?: string) => {
	const v = process.env[key] ?? fallback
	if (v === undefined || v === '') throw new Error(`${key} is required`)
	return v
}

const NODE = env('NODE_ADDRESS', 'ws://127.0.0.1:9944')
const LAUNCHPAD = env('LAUNCHPAD_ADDRESS') as HexString
// Gas a sponsored Launch may use; the voucher is sized from the chain's own gas price.
const LAUNCH_GAS = BigInt(env('LAUNCH_GAS', '120000000000'))
// Short lifetime: a voucher is for launching now, not a gas budget to keep (~3 s blocks).
const DURATION = Number(env('VOUCHER_DURATION_BLOCKS', '600'))
const WINDOW_MS = Number(env('RATE_LIMIT_HOURS', '24')) * 3600_000
const PER_IP_PER_HOUR = Number(env('PER_IP_PER_HOUR', '3'))
const GLOBAL_PER_HOUR = Number(env('GLOBAL_PER_HOUR', '120'))
// Stop issuing below this issuer balance (VARA), so the keeper's gas is never starved.
const ISSUER_FLOOR_PLANCK = BigInt(Math.round(Number(env('ISSUER_FLOOR_VARA', '200')))) * 10n ** 12n
// Only trust X-Forwarded-For when running behind a known proxy that sets it.
const TRUST_PROXY = env('TRUST_PROXY', 'false') === 'true'
const ORIGINS = env('ALLOWED_ORIGINS', 'http://localhost:3000').split(',').map((o) => o.trim())
const PORT = Number(env('PORT', '4010'))
const KEEPER_MS = Number(env('KEEPER_INTERVAL_MS', '6000'))
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly extra: Record<string, unknown> = {}
	) {
		super(message)
	}
}

function json(res: ServerResponse, status: number, body: unknown, origin?: string) {
	res.writeHead(status, {
		'Content-Type': 'application/json',
		...(origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
	})
	res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage, limit = 4096): Promise<Record<string, unknown>> {
	let size = 0
	const chunks: Buffer[] = []
	for await (const chunk of req) {
		size += (chunk as Buffer).length
		if (size > limit) throw new HttpError(413, 'body too large')
		chunks.push(chunk as Buffer)
	}
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
		return parsed as Record<string, unknown>
	} catch {
		throw new HttpError(400, 'body must be a JSON object')
	}
}

function clientIp(req: IncomingMessage): string {
	if (TRUST_PROXY) {
		const fwd = req.headers['x-forwarded-for']
		const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim()
		if (first) return first
	}
	return req.socket.remoteAddress ?? 'unknown'
}

async function main() {
	const api = await GearApi.create({ providerAddress: NODE })
	// A dropped node connection leaves the API object unusable here; exit so the supervisor
	// (systemd / docker restart policy) brings the service back with a fresh connection.
	api.on('disconnected', () => {
		console.error('[voucher] node disconnected, exiting for a clean restart')
		process.exit(1)
	})
	const issuer = await GearKeyring.fromSuri(env('ISSUER_SEED'))
	const keeperSigner = await GearKeyring.fromSuri(env('KEEPER_SEED'))
	if (issuer.address === keeperSigner.address) {
		console.warn('[voucher] ISSUER_SEED and KEEPER_SEED are the same account; their nonces can collide')
	}
	const limiter = new IssueLimiter(WINDOW_MS, process.env.STATE_FILE ?? join(ROOT, 'voucher-state.json'))
	const perIp = new SlidingCap(3600_000, PER_IP_PER_HOUR)
	const global = new SlidingCap(3600_000, GLOBAL_PER_HOUR)

	const valuePerGas = BigInt(
		((api.consts as any).gearBank.gasMultiplier.toJSON() as { valuePerGas: string | number }).valuePerGas
	)
	// 10 % headroom for the transaction fee on top of the message gas.
	const VOUCHER_PLANCK = (LAUNCH_GAS * valuePerGas * 11n) / 10n
	console.log(`[voucher] gas price ${valuePerGas} planck/gas -> voucher ${VOUCHER_PLANCK} planck for ${LAUNCH_GAS} gas`)

	const sails = new Sails(await SailsIdlParser.new())
	sails.parseIdl(readFileSync(join(ROOT, 'idl', 'launchpad.idl'), 'utf8'))
	sails.setApi(api)
	sails.setProgramId(LAUNCHPAD)
	const keeper = new Keeper(api, sails, keeperSigner)

	let issuing = Promise.resolve()

	async function issueVoucher(spender: HexString): Promise<HexString> {
		const balance = (await api.balance.findOut(issuer.address)).toBigInt()
		if (balance < ISSUER_FLOOR_PLANCK + VOUCHER_PLANCK) throw new HttpError(503, 'sponsorship is paused')
		const { extrinsic, voucherId } = await api.voucher.issue(spender, VOUCHER_PLANCK, DURATION, [LAUNCHPAD], false)
		await withTimeout(
			new Promise<void>((resolve, reject) => {
				extrinsic
					.signAndSend(issuer, ({ status, dispatchError }) => {
						if (dispatchError) reject(new Error(dispatchError.toString()))
						else if (status.isInBlock) resolve()
						else if (status.isDropped || status.isInvalid || status.isUsurped) reject(new Error(status.type))
					})
					.catch(reject)
			}),
			60_000,
			'voucher issue'
		)
		return voucherId as HexString
	}

	const server = createServer(async (req, res) => {
		const origin = req.headers.origin && ORIGINS.includes(req.headers.origin) ? req.headers.origin : undefined
		if (req.method === 'OPTIONS') {
			res.writeHead(204, {
				...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
				'Access-Control-Allow-Methods': 'POST, OPTIONS',
				'Access-Control-Allow-Headers': 'Content-Type',
			})
			return res.end()
		}
		if (req.url === '/health') {
			const ok = api.isConnected
			return json(res, ok ? 200 : 503, { ok, launchpad: LAUNCHPAD })
		}
		if (req.url !== '/voucher' || req.method !== 'POST') return json(res, 404, { error: 'not found' }, origin)
		if (req.headers.origin && !origin) return json(res, 403, { error: 'origin not allowed' })

		try {
			const body = await readJson(req)
			const spender = normaliseAddress(body.address, (a) => decodeAddress(a))
			if (!spender) throw new HttpError(400, 'invalid address')

			const wait = limiter.retryAfterMs(spender)
			if (wait > 0) throw new HttpError(429, 'one gas-sponsored launch per wallet per day', { retryAfterMs: wait })
			const ip = clientIp(req)
			if (!perIp.allow(ip)) throw new HttpError(429, 'too many sponsored launches from this network')
			if (!global.allow('all')) throw new HttpError(503, 'sponsorship is busy, try again later')

			// Serialise issuing so two requests for one address cannot both pass the limiter.
			const result = issuing.then(async () => {
				if (limiter.retryAfterMs(spender) > 0) throw new HttpError(429, 'one gas-sponsored launch per wallet per day')
				// Record first: a crash after issuing must not allow a second voucher.
				limiter.record(spender, 'pending')
				try {
					const voucherId = await issueVoucher(spender)
					limiter.record(spender, voucherId)
					return voucherId
				} catch (e) {
					limiter.forget(spender)
					throw e
				}
			})
			issuing = result.then(
				() => undefined,
				() => undefined
			)
			const voucherId = await result
			console.log(`[voucher] issued ${voucherId} to ${spender} from ${ip}`)
			return json(res, 200, { voucherId, durationBlocks: DURATION, gasLimit: LAUNCH_GAS.toString() }, origin)
		} catch (e) {
			if (e instanceof HttpError) return json(res, e.status, { error: e.message, ...e.extra }, origin)
			console.error('[voucher] error', e)
			return json(res, 500, { error: 'could not issue voucher' }, origin)
		}
	})

	server.listen(PORT, () => console.log(`[voucher] listening on :${PORT} for launchpad ${LAUNCHPAD}`))
	setInterval(() => {
		keeper.tick().catch((e) => console.error('[keeper] tick failed', e))
	}, KEEPER_MS)
}

main().catch((e) => {
	console.error(e)
	process.exit(1)
})
