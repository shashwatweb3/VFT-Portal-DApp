import { HexString } from '@gear-js/api'
import { mnemonicGenerate } from '@polkadot/util-crypto'
import { GearKeyring } from '@gear-js/api'
import { UNITS, alice, charlie, connect, ensureFunded, fmtVara, hexOf, loadSails, readDeployed, send } from './lib.js'

/**
 * M5 done-signal on the dev node:
 * 1. a fresh wallet with 0 VARA gets a voucher and launches a token (gas paid by the voucher);
 * 2. a second voucher request from the same wallet is refused;
 * 3. Bob sells out the curve and the keeper (voucher-server) graduates it unattended.
 */
const VOUCHER_API = process.env.VOUCHER_API ?? 'http://127.0.0.1:4010'

function assert(cond: unknown, msg: string): asserts cond {
	if (!cond) throw new Error(`ASSERT: ${msg}`)
}

async function main() {
	const d = readDeployed()
	const { api, parser } = await connect()
	const lp = await loadSails(api, parser, 'launchpad.idl', d.launchpad)
	const L = lp.services.Launchpad

	const fresh = await GearKeyring.fromMnemonic(mnemonicGenerate(), 'fresh')
	const before = (await api.balance.findOut(fresh.address)).toBigInt()
	assert(before === 0n, 'fresh wallet starts with 0 VARA')

	const req = () =>
		fetch(`${VOUCHER_API}/voucher`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3000' },
			body: JSON.stringify({ address: fresh.address }),
		})
	const first = await req()
	assert(first.status === 200, `voucher issued (got ${first.status})`)
	const { voucherId } = (await first.json()) as { voucherId: HexString }
	console.log('voucher', voucherId)
	const second = await req()
	assert(second.status === 429, `second voucher refused (got ${second.status})`)

	const meta = {
		name: `Gasless ${Date.now().toString(36)}`,
		symbol: 'GAS',
		description: 'launched with a voucher',
		image: 'ipfs://gasless',
		website: null,
		telegram: null,
		twitter: null,
		discord: null,
		tokenomics: null,
	}
	const tx = L.functions.Launch(meta, Array(32).fill(1), 0n)
	tx.withAccount(fresh)
	tx.withVoucher(voucherId)
	tx.withGas(110_000_000_000n)
	const { response } = await tx.signAndSend()
	const launched: any = await response()
	assert(launched.ok, `gasless launch failed: ${JSON.stringify(launched)}`)
	const token = launched.ok as HexString
	const after = (await api.balance.findOut(fresh.address)).toBigInt()
	console.log('gasless launch', token, '| creator balance', fmtVara(before), '->', fmtVara(after))
	assert(after === 0n, 'creator spent nothing')
	const info: any = await L.queries.LaunchInfo(token).call()
	assert(info.creator === hexOf(fresh), 'creator recorded as the fresh wallet')

	// Sell out with Bob, then wait for the keeper.
	// Charlie, not Bob: Bob is the keeper account in this setup.
	const buyer = await charlie()
	await ensureFunded(api, await alice(), buyer, 2_000n * UNITS)
	const done: any = await send(L.functions.Buy(token, 0n, 4_294_967_295), buyer, 1_000n * UNITS)
	assert(done.ok?.completed_curve, 'curve completed')
	const deadline = Date.now() + 180_000
	let state = ''
	while (Date.now() < deadline) {
		state = ((await L.queries.LaunchInfo(token).call()) as any).state
		if (state === 'Graduated') break
		await new Promise((r) => setTimeout(r, 3000))
	}
	assert(state === 'Graduated', `keeper graduated the launch (state ${state})`)
	console.log('keeper graduated', token)
	console.log('GASLESS OK')
	await api.disconnect()
}

main().catch((e) => {
	console.error(e)
	process.exit(1)
})
