import { decodeAddress } from '@polkadot/util-crypto'
import { UNITS, alice, connect, fmtVara } from './lib.js'

/**
 * Sends dev-chain VARA from //Alice to any wallet so it can trade on the local node.
 * Usage: npx tsx src/fund.ts <ss58-or-0x-address> [vara=2000]
 */
const [, , target, amountArg] = process.argv
if (!target) {
	console.error('usage: npx tsx src/fund.ts <address> [vara]')
	process.exit(1)
}
decodeAddress(target) // throws on a malformed address
const amount = BigInt(amountArg ?? '2000') * UNITS
const { api } = await connect()
const from = await alice()
await new Promise<void>((resolve, reject) => {
	api.tx.balances
		.transferKeepAlive(target, amount)
		.signAndSend(from, ({ status, dispatchError }) => {
			if (dispatchError) reject(new Error(dispatchError.toString()))
			else if (status.isInBlock) resolve()
		})
		.catch(reject)
})
const balance = (await api.balance.findOut(target)).toBigInt()
console.log(`funded ${target}: balance now ${fmtVara(balance)}`)
await api.disconnect()
