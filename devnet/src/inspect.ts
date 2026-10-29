import { HexString } from '@gear-js/api'
import { bob, charlie, connect, fmtVara, hexOf, loadSails, readDeployed } from './lib.js'

const d = readDeployed()
const { api, parser } = await connect()
const lp = await loadSails(api, parser, 'launchpad.idl', d.launchpad)
const L = lp.services.Launchpad
const launches = (await L.queries.Launches().call()) as HexString[]
const token = (process.argv[2] as HexString) ?? launches[launches.length - 1]
const info: any = await L.queries.LaunchInfo(token).call()
const liabilities = BigInt(await L.queries.TotalLiabilities().call())
const free = BigInt(await L.queries.FreeBalance().call())
const programBalance = (await api.balance.findOut(d.launchpad)).toBigInt()
console.log({ token, state: info.state, step: info.step, escrow: fmtVara(BigInt(info.escrow)), pool_vara: fmtVara(BigInt(info.pool_vara)), creator_fees: fmtVara(BigInt(info.creator_fees)), protocol_fees: fmtVara(BigInt(info.protocol_fees)), liabilities: fmtVara(liabilities), free: fmtVara(free), programBalance: fmtVara(programBalance), lock: info.lock, busy: info.busy })
for (const [name, pair] of [['bob', await bob()], ['charlie', await charlie()]] as const) {
	const pending = BigInt(await L.queries.PendingPayout(token, hexOf(pair)).call())
	console.log(name, 'pending payout', fmtVara(pending))
}
await api.disconnect()
