import { CURVE } from '@/lib/consts'
import { formatUnits, parseUnits } from '@/lib/utils'
import type { Launch, LaunchState, Quote } from '@/lib/sails/launchpad'

export type CurveStatus = LaunchState

/** sails-js returns numbers as number | string | bigint; normalise once at the edge. */
export const big = (v: number | string | bigint | null | undefined): bigint =>
	v === null || v === undefined ? BigInt(0) : BigInt(v)

export const formatVara = (planck: bigint, digits = 4) => {
	const full = formatUnits(planck, CURVE.VARA_DECIMALS)
	const [int, frac = ''] = full.split('.')
	const trimmed = frac.slice(0, digits).replace(/0+$/, '')
	return trimmed ? `${int}.${trimmed}` : int
}

export const formatTokens = (units: bigint, digits = 2) => {
	const full = formatUnits(units, CURVE.TOKEN_DECIMALS)
	const [int, frac = ''] = full.split('.')
	const withSep = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
	const trimmed = frac.slice(0, digits).replace(/0+$/, '')
	return trimmed ? `${withSep}.${trimmed}` : withSep
}

export const parseVara = (value: string) => parseUnits(value || '0', CURVE.VARA_DECIMALS)
export const parseTokens = (value: string) => parseUnits(value || '0', CURVE.TOKEN_DECIMALS)

/** Spot price in planck per whole token, from the launch's virtual reserves. */
export const spotPricePlanck = (launch: Launch): bigint => {
	const vt = big(launch.virtual_tokens)
	if (vt === BigInt(0)) return BigInt(0)
	return (big(launch.virtual_vara) * BigInt(10) ** BigInt(CURVE.TOKEN_DECIMALS)) / vt
}

/** `price_after_e18` is planck per token base unit times 1e18, i.e. planck per whole token. */
export const priceE18ToPlanckPerToken = (priceE18: bigint) => priceE18

export const soldTokens = (launch: Launch) =>
	big(launch.curve_supply) - big(launch.real_remaining)

export const progressBps = (launch: Launch): number => {
	const supply = big(launch.curve_supply)
	if (supply === BigInt(0)) return 0
	return Number((soldTokens(launch) * BigInt(10000)) / supply)
}

/** Mirrors `Launch::lock_held`: a lock past `lock_expires_at` was abandoned and no longer blocks.
 * Without a head block the lock is taken at face value. */
export const lockHeld = (launch: Launch, headBlock?: number) =>
	launch.lock && (headBlock === undefined || headBlock < Number(launch.lock_expires_at))

export const isTradable = (launch: Launch | null | undefined, headBlock?: number) =>
	!!launch && launch.state === 'Trading' && !launch.busy && !lockHeld(launch, headBlock)

export const canSell = (launch: Launch | null | undefined, headBlock?: number) =>
	!!launch && (launch.state === 'Trading' || launch.state === 'Aborted') && !launch.busy && !lockHeld(launch, headBlock)

export const minOutWithSlippage = (amountOut: bigint, slippageBps: number) =>
	amountOut - (amountOut * BigInt(slippageBps)) / BigInt(10000)

export const quoteOut = (quote: Quote | undefined) => (quote ? big(quote.amount_out) : BigInt(0))

export const STATUS_LABEL: Record<CurveStatus, string> = {
	Trading: 'On curve',
	Ready: 'Curve complete',
	Graduating: 'Graduating',
	Graduated: 'Graduated',
	Failed: 'Graduation paused',
	Aborted: 'Sell-back only',
}

export const GRAD_STEP_INDEX: Record<string, number> = {
	WrapVara: 1,
	FindOrCreatePair: 2,
	ApproveToken: 3,
	ApproveWvara: 4,
	AlignPrice: 5,
	AddLiquidity: 6,
	BurnLp: 7,
	RevokeMinter: 8,
	RevokeBurner: 9,
	RevokeAdmin: 10,
	Settle: 11,
	Done: 11,
}
export const GRAD_STEPS_TOTAL = 11

/** Steps after which the pool VARA is still ours to pull back (mirrors `GradStep::is_unwindable`). */
const UNWINDABLE_STEPS = ['WrapVara', 'FindOrCreatePair', 'ApproveToken', 'ApproveWvara']

/** Mirrors the contract's `unwind` precondition so the button only shows when it will work. The
 * timeout is the launch's own (frozen at creation); a failure must persist that long first. */
export const isUnwindableNow = (launch: Launch, headBlock?: number) => {
	if (headBlock === undefined || lockHeld(launch, headBlock) || launch.busy) return false
	const timeout = Number(launch.graduation_timeout_blocks)
	if (launch.state === 'Failed')
		return (
			UNWINDABLE_STEPS.includes(String(launch.step)) &&
			launch.failed_since !== null &&
			headBlock >= Number(launch.failed_since) + timeout
		)
	if (launch.state === 'Ready') return headBlock >= Number(launch.ready_at) + timeout
	return false
}

export async function termsHash(version: string): Promise<number[]> {
	const bytes = new TextEncoder().encode(version)
	const digest = await crypto.subtle.digest('SHA-256', bytes)
	return Array.from(new Uint8Array(digest))
}
