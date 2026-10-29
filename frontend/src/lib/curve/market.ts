import { useQuery } from '@tanstack/react-query'
import type { HexString } from '@gear-js/api'

import { CURVE } from '@/lib/consts'
import { gql } from '@/components/sections/tokens/curve/curve-tables'

/**
 * Market data for the curve board and token page, derived client-side from the indexer
 * (no server aggregates exist). Everything is in VARA: there is no price oracle, and with a
 * fixed 1B supply FDV equals market cap, so only market cap is shown.
 */

const DAY_MS = 86_400_000
const SUPPLY_TOKENS = 1_000_000_000
const E18 = BigInt(10) ** BigInt(18)

/** Planck per whole token -> market cap in whole VARA (float, display only). */
export const mcapFromE18 = (priceE18: bigint | string) => (Number(BigInt(priceE18)) / 1e12) * SUPPLY_TOKENS
/** Planck per whole token -> VARA per token (float, display only). */
export const priceFromE18 = (priceE18: bigint | string) => Number(BigInt(priceE18)) / 1e12
/** Planck (string) -> whole VARA (float, display only). */
export const planckToVara = (planck: bigint | string) => Number(BigInt(planck) / BigInt(1e6)) / 1e6

/** Price the curve starts at: v0 / t0. */
export const initialPriceE18 = (v0: bigint | string, t0: bigint | string) =>
	BigInt(t0) === BigInt(0) ? BigInt(0) : (BigInt(v0) * E18) / BigInt(t0)

/** Price when the last curve token is sold: k / t_end^2 with k = v0 * t0, t_end = t0 - curve supply. */
export const graduationPriceE18 = (v0: bigint | string, t0: bigint | string, curveSupply: bigint | string) => {
	const tEnd = BigInt(t0) - BigInt(curveSupply)
	return tEnd <= BigInt(0) ? BigInt(0) : (BigInt(v0) * BigInt(t0) * E18) / (tEnd * tEnd)
}

export const pctChange = (from: bigint | string | undefined, to: bigint | string) => {
	if (from === undefined || BigInt(from) === BigInt(0)) return undefined
	return (Number(BigInt(to)) / Number(BigInt(from)) - 1) * 100
}

export const compact = (n: number) => {
	const abs = Math.abs(n)
	if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`
	if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`
	if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`
	return n.toFixed(abs < 10 ? 2 : 0)
}

/** Tiny prices such as 0.00000036: keep 3 significant digits. */
export const formatPrice = (n: number) => {
	if (n === 0) return '0'
	if (n >= 1) return n.toFixed(4)
	const digits = Math.min(14, Math.max(2, -Math.floor(Math.log10(n)) + 2))
	return n.toFixed(digits)
}

export const age = (iso: string) => {
	const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000))
	if (s < 60) return `${s}s`
	if (s < 3600) return `${Math.floor(s / 60)}m`
	if (s < 86400) return `${Math.floor(s / 3600)}h`
	return `${Math.floor(s / 86400)}d`
}

// ---------------------------------------------------------------- board

export type BoardRow = {
	id: string
	creator: string
	status: 'TRADING' | 'STUCK' | 'READY' | 'GRADUATING' | 'GRADUATED'
	v0: string
	t0: string
	curveSupply: string
	priceE18: string
	progressBps: number
	tradeCount: number
	volumeVara: string
	createdAt: string
	updatedAt: string
	graduatedAt: string | null
	pair: string | null
	poolVara: string | null
	coin: {
		name: string
		symbol: string
		image: string | null
		description: string
		holders: number
		website: string | null
		twitter: string | null
		telegram: string | null
		discord: string | null
	}
	spark: { close: string }[]
	before: { priceAfterE18: string }[]
	ath: { high: string }[]
}

export type BoardTrade = {
	id: string
	side: 'BUY' | 'SELL'
	trader: string
	vara: string
	tokens: string
	timestamp: string
	launch: { id: string; coin: { symbol: string; image: string | null } }
}

/** A board row with derived market numbers. */
export type BoardToken = BoardRow & {
	mcap: number
	change24h: number | undefined
	vol24h: number
	trades24h: number
	athMcap: number
	sparkline: number[]
	isNew: boolean
}

const BOARD_QUERY = `query Board($t24: DateTime!) {
  curveLaunches(where: { status_in: [TRADING, STUCK, READY, GRADUATING, GRADUATED] }, orderBy: updatedAt_DESC, limit: 100) {
    id creator status v0 t0 curveSupply priceE18 progressBps tradeCount volumeVara createdAt updatedAt graduatedAt pair poolVara
    coin { name symbol image description holders website twitter telegram discord }
    spark: candles(where: { interval_eq: 300 }, orderBy: bucketStart_DESC, limit: 96) { close }
    before: trades(where: { timestamp_lt: $t24 }, orderBy: seq_DESC, limit: 1) { priceAfterE18 }
    ath: candles(where: { interval_eq: 3600 }, orderBy: high_DESC, limit: 1) { high }
  }
  recent: curveTrades(where: { timestamp_gte: $t24 }, orderBy: timestamp_DESC, limit: 5000) {
    id side trader vara tokens timestamp
    launch { id coin { symbol image } }
  }
}`

export function deriveBoard(rows: BoardRow[], recent: BoardTrade[], now = Date.now()): BoardToken[] {
	const vol = new Map<string, { vara: number; n: number }>()
	for (const t of recent) {
		const v = vol.get(t.launch.id) ?? { vara: 0, n: 0 }
		v.vara += planckToVara(t.vara)
		v.n += 1
		vol.set(t.launch.id, v)
	}
	return rows.map((r) => {
		// 24h baseline: the last trade price before the window, or the launch price for younger tokens.
		const base = r.before[0]?.priceAfterE18 ?? initialPriceE18(r.v0, r.t0)
		const athE18 = r.ath[0] ? (BigInt(r.ath[0].high) > BigInt(r.priceE18) ? r.ath[0].high : r.priceE18) : r.priceE18
		const spark = [mcapFromE18(initialPriceE18(r.v0, r.t0))]
		const closes = [...r.spark].reverse().map((c) => mcapFromE18(c.close))
		return {
			...r,
			mcap: mcapFromE18(r.priceE18),
			change24h: pctChange(base, r.priceE18),
			vol24h: vol.get(r.id)?.vara ?? 0,
			trades24h: vol.get(r.id)?.n ?? 0,
			athMcap: mcapFromE18(athE18),
			// Under 96 five-minute candles the series starts at the launch price, so a young token still has a shape.
			sparkline: r.spark.length < 96 ? spark.concat(closes) : closes,
			isNew: now - Date.parse(r.createdAt) < DAY_MS,
		}
	})
}

export function useBoard() {
	return useQuery({
		queryKey: ['curve-board-v2'],
		refetchInterval: CURVE.QUOTE_POLL_MS * 2,
		refetchIntervalInBackground: false,
		queryFn: async () => {
			const t24 = new Date(Date.now() - DAY_MS).toISOString()
			const data = await gql<{ curveLaunches: BoardRow[]; recent: BoardTrade[] }>(BOARD_QUERY, { t24 })
			return { tokens: deriveBoard(data.curveLaunches, data.recent), recent: data.recent }
		},
	})
}

// ---------------------------------------------------------------- token page

export type TokenTrade = {
	seq: number
	side: 'BUY' | 'SELL'
	trader: string
	vara: string
	tokens: string
	priceAfterE18: string
	timestamp: string
}

export type HolderRow = { address: string; balance: string }

type TokenMarketData = {
	curveLaunchById: {
		createdAt: string
		v0: string
		t0: string
		curveSupply: string
		priceE18: string
		volumeVara: string
		tradeCount: number
		ath: { high: string }[]
		before: { priceAfterE18: string }[]
	} | null
	coinById: { holders: number; excludedHolders: string[] } | null
	curveTrades: TokenTrade[]
	accountBalances: HolderRow[]
}

const TOKEN_QUERY = `query TokenMarket($token: String!, $t24: DateTime!) {
  curveLaunchById(id: $token) {
    createdAt v0 t0 curveSupply priceE18 volumeVara tradeCount
    ath: candles(where: { interval_eq: 60 }, orderBy: high_DESC, limit: 1) { high }
    before: trades(where: { timestamp_lt: $t24 }, orderBy: seq_DESC, limit: 1) { priceAfterE18 }
  }
  coinById(id: $token) { holders excludedHolders }
  curveTrades(where: { launch: { id_eq: $token } }, orderBy: seq_DESC, limit: 1000) {
    seq side trader vara tokens priceAfterE18 timestamp
  }
  accountBalances(where: { coin: { id_eq: $token }, balance_gt: "0" }, orderBy: balance_DESC, limit: 100) {
    address balance
  }
}`

export type WindowStats = {
	change: number | undefined
	volume: number
	buys: number
	sells: number
	buyVolume: number
	sellVolume: number
	buyers: number
	sellers: number
}

/** Stats over trades newer than `sinceMs`; `trades` is newest first. */
export function windowStats(trades: TokenTrade[], sinceMs: number, launchPriceE18: bigint, currentE18: string): WindowStats {
	const inWindow = trades.filter((t) => Date.parse(t.timestamp) >= sinceMs)
	const before = trades.find((t) => Date.parse(t.timestamp) < sinceMs)
	const s: WindowStats = { change: undefined, volume: 0, buys: 0, sells: 0, buyVolume: 0, sellVolume: 0, buyers: 0, sellers: 0 }
	const buyers = new Set<string>()
	const sellers = new Set<string>()
	for (const t of inWindow) {
		const v = planckToVara(t.vara)
		s.volume += v
		if (t.side === 'BUY') {
			s.buys += 1
			s.buyVolume += v
			buyers.add(t.trader)
		} else {
			s.sells += 1
			s.sellVolume += v
			sellers.add(t.trader)
		}
	}
	s.buyers = buyers.size
	s.sellers = sellers.size
	s.change = pctChange(before?.priceAfterE18 ?? launchPriceE18, currentE18)
	return s
}

export type HolderView = HolderRow & { bought: number; sold: number; firstSeen?: string }

/** Joins balances with each holder's lifetime curve flow (VARA spent / received). */
export function holderViews(holders: HolderRow[], trades: TokenTrade[]): HolderView[] {
	const flow = new Map<string, { bought: number; sold: number }>()
	for (const t of trades) {
		const f = flow.get(t.trader) ?? { bought: 0, sold: 0 }
		if (t.side === 'BUY') f.bought += planckToVara(t.vara)
		else f.sold += planckToVara(t.vara)
		flow.set(t.trader, f)
	}
	return holders.map((h) => ({ ...h, bought: flow.get(h.address)?.bought ?? 0, sold: flow.get(h.address)?.sold ?? 0 }))
}

export function useTokenMarket(token: HexString) {
	return useQuery({
		queryKey: ['curve-token-market', token],
		refetchInterval: CURVE.QUOTE_POLL_MS * 2,
		refetchIntervalInBackground: false,
		queryFn: async () => {
			const t24 = new Date(Date.now() - DAY_MS).toISOString()
			const d = await gql<TokenMarketData>(TOKEN_QUERY, { token, t24 })
			const l = d.curveLaunchById
			const launchPriceE18 = l ? initialPriceE18(l.v0, l.t0) : BigInt(0)
			const athE18 = l?.ath[0] && BigInt(l.ath[0].high) > BigInt(l.priceE18) ? l.ath[0].high : l?.priceE18
			// Windows are anchored to fetch time so rendering stays pure; they refresh with every poll.
			const now = Date.now()
			const price = l?.priceE18 ?? '0'
			const stats = {
				'5m': windowStats(d.curveTrades, now - 300_000, launchPriceE18, price),
				'1h': windowStats(d.curveTrades, now - 3_600_000, launchPriceE18, price),
				'24h': windowStats(d.curveTrades, now - DAY_MS, launchPriceE18, price),
			}
			return {
				stats,
				...d,
				launchPriceE18,
				athMcap: athE18 ? mcapFromE18(athE18) : 0,
				graduationMcap: l ? mcapFromE18(graduationPriceE18(l.v0, l.t0, l.curveSupply)) : 0,
				holders: holderViews(d.accountBalances, d.curveTrades),
			}
		},
	})
}
