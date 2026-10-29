'use client'

import { useEffect, useMemo, useState } from 'react'
import { useAlert } from '@gear-js/react-hooks'
import { HexString } from '@gear-js/api'

import { Input } from '@/components/ui/input'
import { WalletModal } from '@/components/common/wallet-new/components/wallet-modal'
import { useAuth } from '@/lib/hooks/use-auth'
import { CURVE } from '@/lib/consts'
import {
	big,
	canSell,
	formatTokens,
	formatVara,
	GRAD_STEP_INDEX,
	GRAD_STEPS_TOTAL,
	isTradable,
	isUnwindableNow,
	minOutWithSlippage,
	parseTokens,
	parseVara,
	quoteOut,
	spotPricePlanck,
} from '@/lib/curve'
import type { Launch } from '@/lib/sails/launchpad'
import {
	describeError,
	useLaunchpad,
	useQuote,
	useRaiseTarget,
	useVaraBalance,
	useVftBalance,
} from '@/lib/sails/use-launchpad'
import { cn } from '@/lib/utils'
import { SegmentedControl } from './segmented-control'
import { GraduatedCard } from './graduated-card'

type Side = 'buy' | 'sell'
const SLIPPAGE_OPTIONS = [50, 100, 300] // bps
const VARA_CHIPS = ['1', '5', '10', '25']
const PCT_CHIPS = [25, 50, 100]
const ZERO = BigInt(0)

type Props = {
	token: HexString
	launch: Launch
	symbol: string
}

function Row({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
	return (
		<div className="flex w-full items-center justify-between gap-3 px-3 py-2 odd:bg-[#FDFDFD]/[2%]">
			<span className="font-poppins text-[12px] font-semibold text-[#FDFDFD]/[80%]">{label}</span>
			<span className={cn('font-poppins text-right text-[12px]', highlight && 'text-primary')}>{value}</span>
		</div>
	)
}

/** Parses user input; returns undefined for anything that is not a plain positive decimal. */
function parseAmount(side: Side, raw: string): bigint | undefined {
	const value = raw.trim()
	if (!value) return ZERO
	if (!/^\d*\.?\d*$/.test(value) || value === '.') return undefined
	try {
		return side === 'buy' ? parseVara(value) : parseTokens(value)
	} catch {
		return undefined
	}
}

export function TradePanel({ token, launch, symbol }: Props) {
	const aborted = launch.state === 'Aborted'
	const [side, setSide] = useState<Side>(aborted ? 'sell' : 'buy')
	const [amount, setAmount] = useState('')
	// Exact balance chosen with the 100 % chip, so no dust is left behind.
	const [exactAmount, setExactAmount] = useState<bigint | undefined>()
	const [slippageBps, setSlippageBps] = useState(100)
	const [pending, setPending] = useState<string | false>(false)
	const [walletOpen, setWalletOpen] = useState(false)
	const alert = useAlert()
	const { walletAccount } = useAuth()
	const { buy, sell, graduate, unwind, isReady } = useLaunchpad()
	const { data: config } = useRaiseTarget()
	const { data: varaBalance } = useVaraBalance(walletAccount?.address)
	const { data: tokenBalance } = useVftBalance(token, walletAccount?.decodedAddress)

	useEffect(() => {
		if (aborted) setSide('sell')
	}, [aborted])

	const parsed = useMemo(() => exactAmount ?? parseAmount(side, amount), [amount, side, exactAmount])
	const amountUnits = parsed ?? ZERO

	const { data: quote, isError: quoteError } = useQuote(token, side, amountUnits)
	const out = quoteOut(quote)
	const minOut = minOutWithSlippage(out, slippageBps)
	const price = spotPricePlanck(launch)
	const priceAfter = quote ? big(quote.price_after_e18) : price
	const impactBps = price > ZERO ? Math.abs(Number(((priceAfter - price) * BigInt(10000)) / price)) : 0
	const feePct = (Number(launch.fee_bps) / 100).toString()

	const tradable = side === 'buy' ? isTradable(launch, config?.headBlock) : canSell(launch, config?.headBlock)
	const minTrade = config?.minTradeVara ?? ZERO
	const balancesLoaded = varaBalance !== undefined

	let blocker: string | undefined
	if (!isReady) blocker = 'Connecting…'
	else if (launch.state === 'Graduating' || launch.state === 'Ready')
		blocker = `Graduating · step ${GRAD_STEP_INDEX[launch.step] ?? 1}/${GRAD_STEPS_TOTAL}`
	else if (launch.busy) blocker = 'A trade is settling, try again in a moment'
	else if (launch.state === 'Failed') blocker = 'Graduation paused'
	else if (!tradable) blocker = 'Trading is closed on this curve'
	else if (parsed === undefined) blocker = side === 'buy' ? 'Enter a VARA amount' : `Enter a ${symbol} amount`
	else if (side === 'buy' && amountUnits > ZERO && amountUnits < minTrade)
		blocker = `Minimum buy is ${formatVara(minTrade, 0)} VARA`
	else if (side === 'buy' && walletAccount && balancesLoaded && amountUnits > (varaBalance ?? ZERO) - CURVE.KEEP_VARA)
		blocker = `Insufficient VARA (keep ≥ ${formatVara(CURVE.KEEP_VARA, 0)} VARA for ED and gas)`
	else if (side === 'sell' && walletAccount && tokenBalance !== undefined && amountUnits > tokenBalance)
		blocker = `You hold ${formatTokens(tokenBalance)} ${symbol}`
	else if (quoteError) blocker = 'Quote unavailable'

	const canSubmit = !!walletAccount && !blocker && amountUnits > ZERO && out > ZERO && !pending

	const run = async (label: string, action: () => Promise<void>) => {
		setPending(label)
		try {
			await action()
		} catch (e) {
			alert.error(describeError(e instanceof Error ? e.message : e))
		} finally {
			setPending(false)
		}
	}

	const onSubmit = () => {
		if (!walletAccount) return setWalletOpen(true)
		return run(side === 'buy' ? 'Buying' : 'Approve 1/2, then sell 2/2', async () => {
			if (side === 'buy') {
				const receipt = await buy(token, amountUnits, minOut)
				alert.success(
					receipt.completed_curve
						? 'You completed the curve. Graduation starts now.'
						: `Bought ${formatTokens(big(receipt.tokens))} ${symbol}`
				)
			} else {
				const { receipt, deferred } = await sell(token, amountUnits, minOut)
				alert.success(
					deferred
						? `Sold. ${formatVara(big(receipt.vara))} VARA is held for you until your payouts reach 1 VARA; claim it below.`
						: `Sold for ${formatVara(big(receipt.vara))} VARA`
				)
			}
			setAmount('')
			setExactAmount(undefined)
		})
	}

	const onGraduate = () =>
		run('Graduating', async () => {
			const step = await graduate(token)
			alert.success(`Graduation step done: ${String(step)}`)
		})

	const onUnwind = () =>
		run('Unwinding', async () => {
			await unwind(token)
			alert.success('Graduation unwound. Holders can now sell back at the curve price.')
		})

	if (launch.state === 'Graduated') {
		return (
			<aside className="min-w-0 rounded-2xl bg-[#1D2C4B] p-6 font-poppins border border-[#2E3B55]">
				<GraduatedCard launch={launch} />
			</aside>
		)
	}

	const actionButton = (label: string, onClick: () => void, enabled: boolean) => (
		<button
			type="button"
			onClick={onClick}
			disabled={!enabled || !!pending || !walletAccount}
			className="btn btn--primary font-ps2p w-full py-3 disabled:bg-[#D0D3D9]"
		>
			{label}
		</button>
	)

	return (
		<aside className="flex min-w-0 flex-col gap-5 rounded-2xl bg-[#1D2C4B] p-6 font-poppins max-sm:p-4 border border-[#2E3B55]">
			<SegmentedControl<Side>
				value={side}
				onChange={(v) => {
					setSide(v)
					setAmount('')
					setExactAmount(undefined)
				}}
				options={[
					{ value: 'buy', label: 'Buy', disabled: aborted },
					{ value: 'sell', label: 'Sell' },
				]}
			/>
			{aborted && (
				<p className="text-[12px] text-[#FDFDFD]/80">
					Graduation was unwound. You can sell back at the frozen curve price; buying is closed.
				</p>
			)}

			<Input
				label="Amount"
				placeholder="0"
				type="text"
				value={amount}
				suffix={side === 'buy' ? 'VARA' : symbol}
				onChange={(e) => {
					setExactAmount(undefined)
					setAmount(e.target.value.replace(',', '.'))
				}}
				disabled={!tradable || !!pending}
			/>
			<div className="flex flex-wrap gap-2">
				{side === 'buy'
					? VARA_CHIPS.map((chip) => (
							<button
								key={chip}
								type="button"
								onClick={() => {
									setExactAmount(undefined)
									setAmount(chip)
								}}
								className="rounded-sm border-2 border-[#2E3B55] px-2 py-1 text-[12px] transition hocus:border-primary"
							>
								{chip} VARA
							</button>
						))
					: PCT_CHIPS.map((pct) => (
							<button
								key={pct}
								type="button"
								disabled={!tokenBalance}
								onClick={() => {
									const units = ((tokenBalance ?? ZERO) * BigInt(pct)) / BigInt(100)
									setExactAmount(units)
									setAmount(formatTokens(units, 6).replace(/,/g, ''))
								}}
								className="rounded-sm border-2 border-[#2E3B55] px-2 py-1 text-[12px] transition disabled:opacity-40 hocus:border-primary"
							>
								{pct} %
							</button>
						))}
			</div>
			{walletAccount && (
				<p className="text-[12px] text-[#FDFDFD]/80">
					Balance:{' '}
					<span className="text-primary">
						{side === 'buy'
							? `${formatVara(varaBalance ?? ZERO)} VARA`
							: `${formatTokens(tokenBalance ?? ZERO)} ${symbol}`}
					</span>
				</p>
			)}

			<div className="rounded-lg border-2 border-[#2E3B55]">
				<Row
					label="You receive ≈"
					value={
						out > ZERO ? (side === 'buy' ? `${formatTokens(out)} ${symbol}` : `${formatVara(out)} VARA`) : '—'
					}
				/>
				<Row label="Price impact" value={quote ? `${(impactBps / 100).toFixed(2)} %` : '—'} />
				<Row label={`Fee ${feePct} %`} value={quote ? `${formatVara(big(quote.fee_vara))} VARA` : '—'} />
				<Row
					label="Min received"
					value={
						out > ZERO
							? side === 'buy'
								? `${formatTokens(minOut)} ${symbol}`
								: `${formatVara(minOut)} VARA`
							: '—'
					}
				/>
				{quote?.completes_curve && (
					<Row label="This buy completes the curve" value={`refund ${formatVara(big(quote.refund_vara))} VARA`} highlight />
				)}
			</div>

			<div className="flex items-center justify-between gap-3">
				<span className="text-[12px] font-semibold text-[#FDFDFD]/[80%]">Slippage</span>
				<div className="flex gap-2">
					{SLIPPAGE_OPTIONS.map((bps) => (
						<button
							key={bps}
							type="button"
							onClick={() => setSlippageBps(bps)}
							className={cn(
								'rounded-sm border-2 px-2 py-1 text-[12px] transition',
								slippageBps === bps ? 'border-primary text-primary' : 'border-[#2E3B55] hocus:border-primary'
							)}
						>
							{bps / 100} %
						</button>
					))}
				</div>
			</div>

			{blocker && <p className="text-[12px] text-[#FF4F4F]">{blocker}</p>}

			{launch.state === 'Ready' && actionButton('Start graduation', onGraduate, true)}
			{launch.state === 'Failed' && launch.fail_retryable && actionButton('Retry graduation', onGraduate, true)}
			{isUnwindableNow(launch, config?.headBlock) &&
				actionButton('Unwind and reopen sells', onUnwind, true)}
			{!['Ready', 'Failed', 'Graduating'].includes(launch.state) && (
				<button
					type="button"
					onClick={onSubmit}
					disabled={!!walletAccount && !canSubmit}
					className="btn btn--primary font-ps2p w-full py-3 disabled:bg-[#D0D3D9]"
				>
					{!walletAccount ? (
						'Connect Wallet'
					) : pending ? (
						<span className="flex w-full justify-center">
							{pending}
							<span className="w-6 after:flex after:animate-dots after:content-['']" />
						</span>
					) : side === 'buy' ? (
						`Buy ${symbol}`
					) : (
						`Sell ${symbol}`
					)}
				</button>
			)}
			{side === 'sell' && !aborted && (
				<p className="text-center text-[11px] text-[#FDFDFD]/60">
					Selling takes two signatures: an approval, then the sale.
				</p>
			)}
			<p className="text-center text-[11px] text-[#FDFDFD]/60">
				Trades settle in an open-source smart contract. Its admin cannot withdraw the VARA held by the curve.
			</p>
			<WalletModal onClose={() => setWalletOpen(false)} open={walletOpen} setOpen={setWalletOpen} />
		</aside>
	)
}
