import { HexString } from '@gear-js/api'
import { UNITS, alice, bob, connect, ensureFunded, charlie, loadSails, readDeployed, send } from './lib.js'

/** Creates one launch that stays on the curve (~25 % sold) for UI checks. */
const d = readDeployed()
const { api, parser } = await connect()
const L = (await loadSails(api, parser, 'launchpad.idl', d.launchpad)).services.Launchpad
const creator = await alice()
const meta = {
	name: `Demo Curve ${Date.now().toString(36).slice(-4)}`,
	symbol: 'DEMO',
	description: 'A token still on its bonding curve, for UI checks.',
	image: 'ipfs://demo',
	website: null, telegram: null, twitter: null, discord: null, tokenomics: null,
}
const res: any = await send(L.functions.Launch(meta, Array(32).fill(7), 0n), creator, 20n * UNITS)
const token = res.ok as HexString
await ensureFunded(api, creator, await charlie(), 500n * UNITS)
await send(L.functions.Buy(token, 0n, 4_294_967_295), await bob(), 40n * UNITS)
await send(L.functions.Buy(token, 0n, 4_294_967_295), await charlie(), 25n * UNITS)
console.log('SEEDED', token)
await api.disconnect()
