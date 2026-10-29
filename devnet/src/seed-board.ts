import { GearKeyring, HexString } from '@gear-js/api'
import type { KeyringPair } from '@polkadot/keyring/types'
import { UNITS, alice, connect, hexOf, loadSails, readDeployed, send } from './lib.js'

/**
 * Seeds the local board with 10 curve launches and ~10 minutes of organic-looking trading so
 * charts, the live feed, king of the hill and graduation all have real data. Dev chain only.
 * Usage: npx tsx src/seed-board.ts [rounds=24] [pauseSeconds=15]
 */
const ROUNDS = Number(process.argv[2] ?? 24)
const PAUSE_MS = Number(process.argv[3] ?? 15) * 1000
const TRADERS = 12

const TOKENS: Array<{ name: string; symbol: string; description: string; target: number }> = [
	{ name: 'Moon Frog', symbol: 'FROG', description: 'The frog that jumped off the curve and onto RivrDEX.', target: 1.0 },
	{ name: 'Vara Cat', symbol: 'VCAT', description: 'Nine lives, one bonding curve.', target: 1.0 },
	{ name: 'Gear Gnome', symbol: 'GNOME', description: 'Tiny gnome, big gears. Built on Vara.', target: 0.93 },
	{ name: 'Based Otter', symbol: 'OTTER', description: 'Floats on the curve, holds paws with holders.', target: 0.87 },
	{ name: 'Rocket Yak', symbol: 'YAK', description: 'A yak with a rocket. Questions?', target: 0.64 },
	{ name: 'Degen Duck', symbol: 'DDUCK', description: 'Quack first, research later.', target: 0.48 },
	{ name: 'Squirrel', symbol: 'SQRL', description: 'Stacking acorns and VARA for winter.', target: 0.31 },
	{ name: 'Sea Turtle', symbol: 'TURTL', description: 'Slow and steady wins the curve.', target: 0.22 },
	{ name: 'Laser Lynx', symbol: 'LYNX', description: 'Sharp eyes, sharper chart.', target: 0.12 },
	{ name: 'Koala Club', symbol: 'KOALA', description: 'Sleeps 20 hours a day, holds the rest.', target: 0.05 },
]

const avatar = (seed: string) => `https://api.dicebear.com/9.x/pixel-art/svg?seed=${encodeURIComponent(seed)}`
const rand = (min: number, max: number) => min + Math.random() * (max - min)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const vara = (n: number) => BigInt(Math.round(n * 1e6)) * 1_000_000n

async function main() {
	const d = readDeployed()
	const { api, parser } = await connect()
	const L = (await loadSails(api, parser, 'launchpad.idl', d.launchpad)).services.Launchpad
	const vftFor = async (token: HexString) => (await loadSails(api, parser, 'tokenator_vft.idl', token)).services.Vft

	// 1. Traders, funded in one batch from //Alice.
	const traders: KeyringPair[] = []
	for (let i = 1; i <= TRADERS; i++) traders.push(await GearKeyring.fromSuri(`//Trader${i}`))
	const funder = await alice()
	await new Promise<void>((resolve, reject) => {
		api.tx.utility
			.batchAll(traders.map((t) => api.tx.balances.transferKeepAlive(t.address, 20_000n * UNITS)))
			.signAndSend(funder, ({ status, dispatchError }) => {
				if (dispatchError) reject(new Error(dispatchError.toString()))
				else if (status.isInBlock) resolve()
			})
			.catch(reject)
	})
	console.log(`funded ${TRADERS} traders`)

	// 2. Launches, each by a different creator with a small first buy.
	const launched: Array<{ token: HexString; target: number; symbol: string }> = []
	for (const [i, t] of TOKENS.entries()) {
		const creator = traders[i % TRADERS]
		const meta = {
			name: t.name,
			symbol: t.symbol,
			description: t.description,
			image: avatar(t.name),
			website: null,
			telegram: null,
			twitter: null,
			discord: null,
			tokenomics: null,
		}
		const res: any = await send(L.functions.Launch(meta, Array(32).fill(1), 0n), creator, vara(rand(2, 10)))
		if (!res.ok) {
			console.log(`launch ${t.name} failed: ${JSON.stringify(res)}`)
			continue
		}
		launched.push({ token: res.ok as HexString, target: t.target, symbol: t.symbol })
		console.log(`launched ${t.symbol} ${res.ok}`)
	}

	// 3. Trading rounds: buy toward each target, with occasional profit-taking.
	const progress = async (token: HexString) => {
		const info: any = await L.queries.LaunchInfo(token).call()
		const sold = BigInt(info.curve_supply) - BigInt(info.real_remaining)
		return { state: info.state as string, frac: Number((sold * 10_000n) / BigInt(info.curve_supply)) / 10_000 }
	}
	for (let round = 1; round <= ROUNDS; round++) {
		const lastRound = round === ROUNDS
		for (const l of launched) {
			const { state, frac } = await progress(l.token)
			if (state !== 'Trading') continue
			const remainingRounds = ROUNDS - round + 1
			const behind = l.target - frac
			if (behind <= 0.005 && !lastRound) continue
			const trader = traders[Math.floor(rand(0, TRADERS))]
			try {
				if (Math.random() < 0.22 && frac > 0.08) {
					// Profit-taking: sell part of a holder's bag.
					const vft = await vftFor(l.token)
					const held = BigInt(await vft.queries.BalanceOf(hexOf(trader)).call())
					if (held > 0n) {
						const amount = (held * BigInt(Math.floor(rand(15, 45)))) / 100n
						await send(vft.functions.Approve(d.launchpad, amount), trader)
						const r: any = await send(L.functions.Sell(l.token, amount, 0n, 4_294_967_295), trader)
						if (r.ok) console.log(`r${round} ${l.symbol} SELL ${Number(r.ok.vara) / 1e12} VARA`)
						continue
					}
				}
				// Buy size scales with how far behind target this token is (the curve gets pricier).
				const spend = l.target >= 1 && lastRound ? 900 : Math.max(1.2, rand(0.6, 1.4) * (behind * 600) / remainingRounds * 1.6)
				const r: any = await send(L.functions.Buy(l.token, 0n, 4_294_967_295), trader, vara(spend))
				if (r.ok) console.log(`r${round} ${l.symbol} BUY ${spend.toFixed(2)} VARA${r.ok.completed_curve ? ' (curve complete)' : ''}`)
			} catch (e) {
				console.log(`r${round} ${l.symbol} trade skipped: ${String(e).slice(0, 80)}`)
			}
		}
		if (!lastRound) await sleep(PAUSE_MS)
	}
	for (const l of launched) {
		const { state, frac } = await progress(l.token)
		console.log(`${l.symbol.padEnd(6)} ${state.padEnd(10)} ${(frac * 100).toFixed(1)} % sold`)
	}
	console.log('SEEDED BOARD')
	await api.disconnect()
}

main().catch((e) => {
	console.error(e)
	process.exit(1)
})
