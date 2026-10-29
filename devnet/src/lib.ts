import { GearApi, GearKeyring, HexString, generateCodeHash } from '@gear-js/api'
import { KeyringPair } from '@polkadot/keyring/types'
import { Sails, TransactionBuilder } from 'sails-js'
import { SailsIdlParser } from 'sails-js-parser'
import { u8aToHex } from '@polkadot/util'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const NODE = process.env.NODE_ADDRESS ?? 'ws://127.0.0.1:9944'
export const UNITS = 1_000_000_000_000n // 1 VARA
export const TOKEN = 10n ** 18n

export const LP_DEAD: HexString = ('0x' + '01'.repeat(32)) as HexString

export function wasm(name: string): Buffer {
	return readFileSync(join(ROOT, 'wasm', name))
}

export function idl(name: string): string {
	return readFileSync(join(ROOT, 'idl', name), 'utf8')
}

export async function connect() {
	const api = await GearApi.create({ providerAddress: NODE })
	const parser = await SailsIdlParser.new()
	return { api, parser }
}

export async function loadSails(api: GearApi, parser: SailsIdlParser, idlName: string, programId?: HexString) {
	const sails = new Sails(parser)
	sails.parseIdl(idl(idlName))
	sails.setApi(api)
	if (programId) sails.setProgramId(programId)
	return sails
}

export const alice = (): Promise<KeyringPair> => GearKeyring.fromSuri('//Alice')
export const bob = (): Promise<KeyringPair> => GearKeyring.fromSuri('//Bob')
export const charlie = (): Promise<KeyringPair> => GearKeyring.fromSuri('//Charlie')

export async function send<T>(tx: TransactionBuilder<T>, signer: KeyringPair, value = 0n, gas?: bigint): Promise<T> {
	tx.withAccount(signer)
	if (value > 0n) tx.withValue(value)
	if (gas) tx.withGas(gas)
	else await tx.calculateGas(true, 15)
	const { response } = await tx.signAndSend()
	return response()
}

/** Deploys a program via a ctor TransactionBuilder and returns its program id. */
export async function deploy(tx: TransactionBuilder<unknown>, signer: KeyringPair, gas: bigint, value = 0n): Promise<HexString> {
	tx.withAccount(signer)
	if (value > 0n) tx.withValue(value)
	tx.withGas(gas)
	const { response } = await tx.signAndSend()
	await response()
	const programId = (tx as unknown as { programId?: HexString }).programId
	if (!programId) throw new Error('no programId on ctor tx')
	return programId
}

/** Uploads wasm as code only (no program) and returns its CodeId. */
export async function uploadCode(api: GearApi, signer: KeyringPair, bytes: Buffer): Promise<HexString> {
	let codeHash: HexString
	try {
		codeHash = (await api.code.upload(bytes)).codeHash
	} catch (e) {
		// The code id is the blake2 hash of the bytes, so an existing upload is reusable.
		if (String(e).includes('Code already exists')) return (await api.code.upload(bytes).catch(() => null), generateCodeHash(bytes))
		throw e
	}
	await new Promise<void>((resolve, reject) => {
		api.code
			.signAndSend(signer, ({ events, status }) => {
				if (status.isInBlock) {
					for (const { event } of events) {
						if (api.events.system.ExtrinsicFailed.is(event)) reject(new Error('code upload failed'))
					}
					resolve()
				}
			})
			.catch(reject)
	})
	return codeHash
}

export interface Deployed {
	node: string
	wvara: HexString
	rivrFactory: HexString
	rivrPairCode: HexString
	vftCode: HexString
	launchpad: HexString
	treasury: HexString
}

export const DEPLOYED_PATH = join(ROOT, 'deployed.json')

export function readDeployed(): Deployed {
	if (!existsSync(DEPLOYED_PATH)) throw new Error('run `pnpm deploy` first')
	return JSON.parse(readFileSync(DEPLOYED_PATH, 'utf8'))
}

export function writeDeployed(d: Deployed) {
	writeFileSync(DEPLOYED_PATH, JSON.stringify(d, null, 2))
}

/** Tops up `to` from `from` when its free balance is below `min` (dev chain only funds Alice/Bob). */
export async function ensureFunded(api: GearApi, from: KeyringPair, to: KeyringPair, min: bigint) {
	const free = (await api.balance.findOut(to.address)).toBigInt()
	if (free >= min) return
	await new Promise<void>((resolve, reject) => {
		api.tx.balances
			.transferKeepAlive(to.address, min * 2n)
			.signAndSend(from, ({ status, dispatchError }) => {
				if (dispatchError) reject(new Error(dispatchError.toString()))
				if (status.isInBlock) resolve()
			})
			.catch(reject)
	})
}

/** 0x-prefixed 32-byte public key of a keypair (what Sails `actor_id` args expect). */
export const hexOf = (pair: KeyringPair): HexString => u8aToHex(pair.addressRaw) as HexString

export const fmtVara = (planck: bigint) => `${Number(planck / 1_000_000n) / 1_000_000} VARA`
export const fmtTokens = (units: bigint) => `${(units / TOKEN).toLocaleString()} tokens`
