'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { HexString } from '@gear-js/api'
import { useAlert } from '@gear-js/react-hooks'

import { Sprite } from '@/components/ui/sprite'
import { useAuth } from '@/lib/hooks/use-auth'
import { LAUNCHPAD } from '@/lib/consts'
import { big, formatTokens, formatVara, progressBps } from '@/lib/curve'
import {
	age,
	compact,
	mcapFromE18,
	planckToVara,
	useTokenMarket,
	type HolderView,
	type TokenTrade,
} from '@/lib/curve/market'
import type { Launch } from '@/lib/sails/launchpad'
import {
	describeError,
	useLaunchInfo,
	useLaunchpad,
	usePendingPayout,
	useRaiseTarget,
	useVftBalance,
} from '@/lib/sails/use-launchpad'
import { getSafeHttpsUrl } from '@/lib/sanitize'
import { cn, copyToClipboard, prettyWord } from '@/lib/utils'
import { StatusBadge } from './curve-progress'
import { PriceChart } from './price-chart'
import { TradePanel } from './trade-panel'
import { timeAgo } from './curve-tables'
import { AddressAvatar, Delta, Panel, SplitBar, Tabs, TokenAvatar } from './ui'

export type CurveTokenMeta = {
	name: string
	symbol: string
	image?: string | null
	description?: string | null
	website?: string | null
	twitter?: string | null
	telegram?: string | null
	discord?: string | null
	tokenomics?: string | null
}

type Market = NonNullable<ReturnType<typeof useTokenMarket>['data']>
const ONE_VARA = BigInt(10) ** BigInt(12)
const ZERO = BigInt(0)

// ---------------------------------------------------------------- header

function Chip({ children, onClick, href, title }: { children: React.ReactNode; onClick?: () => void; href?: string; title?: string }) {
	const cls =
		'font-poppins flex h-7 items-center gap-1.5 rounded-md border border-[#2E3B55] bg-[#0F1B34] px-2 text-[12px] text-[#FDFDFD]/80 transition hover:border-[#B4FF69]/60 hover:text-[#FDFDFD]'
	if (href)
		return (
			<a href={href} target="_blank" rel="noreferrer" className={cls} title={title}>
				{children}
			</a>
		)
	return (
		<button type="button" onClick={onClick} className={cls} title={title}>
			{children}
		</button>
	)
}

function HeaderStat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
	return (
		<div className="flex flex-col gap-0.5">
			<span className="text-[11px] text-[#FDFDFD]/55">{label}</span>
			<span className="flex items-baseline gap-2 text-[16px] font-semibold tabular-nums max-sm:text-[14px]">
				{value}
				{sub && <span className="text-[11px] font-medium">{sub}</span>}
			</span>
		</div>
	)
}

function HeaderBar({
	token,
	meta,
	launch,
	market,
	creatorHoldsBps,
}: {
	token: HexString
	meta: CurveTokenMeta
	launch: Launch
	market?: Market
	creatorHoldsBps: number
}) {
	const alert = useAlert()
	const mcap = mcapFromE18(market?.curveLaunchById?.priceE18 ?? '0') || 0
	const stats24 = market?.stats['24h']
	const socials = [
		['web', getSafeHttpsUrl(meta.website ?? undefined)],
		['twitter', getSafeHttpsUrl(meta.twitter ?? undefined)],
		['telegram', getSafeHttpsUrl(meta.telegram ?? undefined)],
		['discord', getSafeHttpsUrl(meta.discord ?? undefined)],
	].filter(([, h]) => !!h) as [string, string][]

	return (
		<div className="font-poppins flex flex-wrap items-center gap-x-8 gap-y-4 rounded-2xl border border-[#2E3B55] bg-[#1D2C4B] px-5 py-4 max-sm:px-4">
			<div className="flex min-w-0 items-center gap-4">
				<Link
					href="/tokens"
					aria-label="Back to tokens"
					className="flex size-9 shrink-0 items-center justify-center rounded-full border border-[#2E3B55] text-[#FDFDFD]/80 transition hover:border-[#B4FF69] hover:text-primary"
				>
					←
				</Link>
				<TokenAvatar src={meta.image} alt={meta.name} size={56} className="rounded-xl" />
				<div className="flex min-w-0 flex-col gap-2">
					<div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
						<h1 className="font-ps2p text-primary truncate text-[18px] max-sm:text-[13px]">{meta.name}</h1>
						<span className="font-silkscreen text-[14px] text-[#FDFDFD]/70">{meta.symbol}</span>
						<StatusBadge launch={launch} />
					</div>
					<div className="flex flex-wrap items-center gap-1.5">
						<Chip onClick={() => copyToClipboard({ value: token, alert })} title="Copy token address">
							{prettyWord(token, 4)} <Sprite name="copy" color="#B4FF69" className="size-3" />
						</Chip>
						<Chip onClick={() => copyToClipboard({ value: window.location.href, alert })} title="Copy link">
							<Sprite name="link" color="#B4FF69" className="size-3" /> Share
						</Chip>
						<span className="font-poppins flex h-7 items-center gap-1.5 rounded-md border border-[#2E3B55] bg-[#0F1B34] px-2 text-[12px] text-[#FDFDFD]/80">
							<span className="bg-primary size-1.5 rounded-full" /> Vara
						</span>
						{creatorHoldsBps > 0 && (
							<span
								className="flex h-7 items-center rounded-md border border-[#2E3B55] bg-[#0F1B34] px-2 text-[12px] text-[#FDFDFD]/80"
								title="Share of supply the creator's wallet holds"
							>
								Dev {(creatorHoldsBps / 100).toFixed(1)}%
							</span>
						)}
						{socials.map(([name, h]) => (
							<Chip key={name} href={h} title={name}>
								<Sprite name={name} color="#B4FF69" className="size-3.5" />
							</Chip>
						))}
					</div>
				</div>
			</div>
			<div className="ml-auto flex flex-wrap items-center gap-x-8 gap-y-3 max-lg:ml-0">
				<HeaderStat label="Market cap" value={`${compact(mcap)} VARA`} sub={<Delta value={stats24?.change} />} />
				<HeaderStat label="24h vol" value={stats24 ? `${compact(stats24.volume)} VARA` : '—'} />
				<HeaderStat label="Holders" value={market?.coinById?.holders ?? '—'} />
				<HeaderStat label="ATH" value={market ? `${compact(market.athMcap)} VARA` : '—'} />
				<HeaderStat label="Age" value={market?.curveLaunchById ? age(market.curveLaunchById.createdAt) : '—'} />
			</div>
		</div>
	)
}

// ---------------------------------------------------------------- trades

function TradeRow({ t, symbol }: { t: TokenTrade; symbol: string }) {
	const buy = t.side === 'BUY'
	return (
		<div className="grid grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-0.5 px-4 py-2 text-[12px] transition hover:bg-[#FDFDFD]/[3%]">
			<span className="row-span-2">
				<AddressAvatar address={t.trader} size={22} />
			</span>
			<span className="truncate tabular-nums text-[#FDFDFD]/85">{prettyWord(t.trader, 4)}</span>
			<span className={cn('text-right font-semibold tabular-nums', buy ? 'text-primary' : 'text-[#FF4F4F]')}>
				{buy ? '+' : '−'}
				{compact(Number(BigInt(t.tokens) / BigInt(10) ** BigInt(18)))} {symbol}
			</span>
			<span className="text-[11px] text-[#FDFDFD]/45">{timeAgo(t.timestamp)}</span>
			<span className="text-right text-[11px] tabular-nums text-[#FDFDFD]/55">
				{compact(planckToVara(t.vara))} VARA @ {compact(mcapFromE18(t.priceAfterE18))}
			</span>
		</div>
	)
}

function TradesFeed({ market, symbol, me }: { market?: Market; symbol: string; me?: string }) {
	const [tab, setTab] = useState<'recent' | 'yours'>('recent')
	const trades = market?.curveTrades ?? []
	const list = tab === 'yours' ? trades.filter((t) => t.trader === me) : trades
	return (
		<Panel
			title="Trades"
			action={<Tabs value={tab} onChange={setTab} options={[{ value: 'recent', label: 'Recent' }, { value: 'yours', label: 'Yours' }]} />}
			className="h-full"
			bodyClassName="min-h-0 flex-1 overflow-y-auto py-1 [scrollbar-color:#2E3B55_transparent] [scrollbar-width:thin]"
		>
			{!market ? (
				<div className="flex animate-pulse flex-col gap-2 p-4">
					{[0, 1, 2, 3, 4].map((i) => (
						<div key={i} className="h-9 rounded-md bg-[#FDFDFD]/[4%]" />
					))}
				</div>
			) : list.length === 0 ? (
				<p className="px-4 py-8 text-center text-[12px] text-[#FDFDFD]/50">
					{tab === 'yours' ? (me ? 'You have not traded this token yet.' : 'Connect a wallet to see your trades.') : 'No trades yet'}
				</p>
			) : (
				list.slice(0, 200).map((t) => <TradeRow key={t.seq} t={t} symbol={symbol} />)
			)}
		</Panel>
	)
}

const th = 'pb-2 text-left text-[10px] font-medium uppercase tracking-wider text-[#FDFDFD]/45'
const td = 'py-2.5 text-[13px] tabular-nums'

function TradesTab({ market, symbol }: { market: Market; symbol: string }) {
	if (!market.curveTrades.length) return <p className="py-8 text-center text-[13px] text-[#FDFDFD]/50">No trades yet</p>
	return (
		<div className="overflow-x-auto">
			<table className="w-full min-w-[640px] border-collapse">
				<thead>
					<tr>
						<th className={th}>Type</th>
						<th className={th}>Account</th>
						<th className={cn(th, 'text-right')}>VARA</th>
						<th className={cn(th, 'text-right')}>{symbol}</th>
						<th className={cn(th, 'text-right')}>MCap after</th>
						<th className={cn(th, 'text-right')}>Time</th>
					</tr>
				</thead>
				<tbody>
					{market.curveTrades.slice(0, 100).map((t) => (
						<tr key={t.seq} className="border-t border-[#2E3B55]/60 hover:bg-[#FDFDFD]/[3%]">
							<td className={td}>
								<span
									className={cn(
										'rounded-md px-1.5 py-0.5 text-[11px] font-semibold',
										t.side === 'BUY' ? 'bg-[#B4FF69]/12 text-primary' : 'bg-[#FF4F4F]/12 text-[#FF4F4F]'
									)}
								>
									{t.side === 'BUY' ? 'Buy' : 'Sell'}
								</span>
							</td>
							<td className={td}>
								<span className="flex items-center gap-2">
									<AddressAvatar address={t.trader} size={18} />
									{prettyWord(t.trader, 4)}
								</span>
							</td>
							<td className={cn(td, 'text-right')}>{formatVara(BigInt(t.vara), 2)}</td>
							<td className={cn(td, 'text-right')}>{formatTokens(BigInt(t.tokens), 0)}</td>
							<td className={cn(td, 'text-right text-[#FDFDFD]/70')}>{compact(mcapFromE18(t.priceAfterE18))}</td>
							<td className={cn(td, 'text-right text-[#FDFDFD]/60')}>{timeAgo(t.timestamp)}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	)
}

// ---------------------------------------------------------------- holders

type Tag = 'Curve' | 'Pool' | 'Creator' | 'You'

function holderTags(h: HolderView, launch: Launch, me?: string): Tag[] {
	const tags: Tag[] = []
	if (h.address === LAUNCHPAD.ADDRESS) tags.push('Curve')
	if (launch.state === 'Graduated' && h.address === launch.pair) tags.push('Pool')
	if (h.address === launch.creator) tags.push('Creator')
	if (me && h.address === me) tags.push('You')
	return tags
}

function HoldersTab({ market, launch, supply, me }: { market: Market; launch: Launch; supply: bigint; me?: string }) {
	if (!market.holders.length) return <p className="py-8 text-center text-[13px] text-[#FDFDFD]/50">No holders yet</p>
	const pct = (b: string) => (supply > ZERO ? Number((BigInt(b) * BigInt(1_000_000)) / supply) / 10_000 : 0)
	return (
		<div className="overflow-x-auto">
			<table className="w-full min-w-[640px] border-collapse">
				<thead>
					<tr>
						<th className={cn(th, 'w-8')}>#</th>
						<th className={th}>Holder</th>
						<th className={cn(th, 'text-right')}>Held</th>
						<th className={cn(th, 'text-right')}>% supply</th>
						<th className={cn(th, 'text-right')}>Bought</th>
						<th className={cn(th, 'text-right')}>Sold</th>
					</tr>
				</thead>
				<tbody>
					{market.holders.slice(0, 50).map((h, i) => (
						<tr key={h.address} className="border-t border-[#2E3B55]/60 hover:bg-[#FDFDFD]/[3%]">
							<td className={cn(td, 'text-[#FDFDFD]/45')}>{i + 1}</td>
							<td className={td}>
								<span className="flex items-center gap-2">
									<AddressAvatar address={h.address} size={18} />
									{prettyWord(h.address, 4)}
									{holderTags(h, launch, me).map((tag) => (
										<span
											key={tag}
											className={cn(
												'rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase',
												tag === 'You' ? 'bg-primary text-black' : 'bg-[#FDFDFD]/10 text-[#FDFDFD]/80'
											)}
										>
											{tag}
										</span>
									))}
								</span>
							</td>
							<td className={cn(td, 'text-right')}>{compact(Number(BigInt(h.balance) / BigInt(10) ** BigInt(18)))}</td>
							<td className={cn(td, 'text-right')}>{pct(h.balance).toFixed(2)}%</td>
							<td className={cn(td, 'text-right', h.bought ? 'text-primary' : 'text-[#FDFDFD]/40')}>
								{h.bought ? `${compact(h.bought)} VARA` : '—'}
							</td>
							<td className={cn(td, 'text-right', h.sold ? 'text-[#FF4F4F]' : 'text-[#FDFDFD]/40')}>
								{h.sold ? `${compact(h.sold)} VARA` : '—'}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	)
}

/** Top-10 concentration among real holders (the curve and the pool are excluded). */
function HolderDistribution({ market, launch, supply }: { market: Market; launch: Launch; supply: bigint }) {
	const excluded = new Set([LAUNCHPAD.ADDRESS as string, ...(market.coinById?.excludedHolders ?? []), launch.state === 'Graduated' ? (launch.pair as string) : ''])
	const real = market.holders.filter((h) => !excluded.has(h.address))
	const top = real.slice(0, 10).reduce((s, h) => s + BigInt(h.balance), ZERO)
	const all = real.reduce((s, h) => s + BigInt(h.balance), ZERO)
	const topPct = supply > ZERO ? Number((top * BigInt(10_000)) / supply) / 100 : 0
	const restPct = supply > ZERO ? Number(((all - top) * BigInt(10_000)) / supply) / 100 : 0
	const lockedPct = Math.max(0, 100 - topPct - restPct)
	return (
		<Panel title={`Holders (${market.coinById?.holders ?? real.length})`} bodyClassName="flex flex-col gap-3 p-4 text-[12px]">
			<div className="flex h-2 w-full overflow-hidden rounded-full bg-[#0F1B34]">
				<div className="bg-primary h-full" style={{ width: `${topPct}%` }} />
				<div className="h-full bg-[#C3C5EA]" style={{ width: `${restPct}%` }} />
			</div>
			<div className="flex flex-col gap-1.5 tabular-nums">
				<Legend color="bg-primary" label="Top 10" value={`${topPct.toFixed(1)}%`} />
				<Legend color="bg-[#C3C5EA]" label="Other holders" value={`${restPct.toFixed(1)}%`} />
				<Legend
					color="bg-[#2E3B55]"
					label={launch.state === 'Graduated' ? 'RivrDEX pool' : 'Curve and pool reserve'}
					value={`${lockedPct.toFixed(1)}%`}
				/>
			</div>
		</Panel>
	)
}

function Legend({ color, label, value }: { color: string; label: string; value: string }) {
	return (
		<div className="flex items-center justify-between">
			<span className="flex items-center gap-2 text-[#FDFDFD]/70">
				<span className={cn('size-2 rounded-full', color)} /> {label}
			</span>
			<span>{value}</span>
		</div>
	)
}

// ---------------------------------------------------------------- about

function AboutTab({ token, meta, launch }: { token: HexString; meta: CurveTokenMeta; launch: Launch }) {
	const { data: cfg } = useRaiseTarget()
	const alert = useAlert()
	const rows: [string, React.ReactNode][] = [
		[
			'Token address',
			<button key="t" type="button" className="flex items-center gap-2" onClick={() => copyToClipboard({ value: token, alert })}>
				{prettyWord(token, 6)} <Sprite name="copy" color="#B4FF69" className="size-3" />
			</button>,
		],
		[
			'Creator',
			<span key="c" className="flex items-center gap-2">
				<AddressAvatar address={launch.creator as string} size={16} /> {prettyWord(launch.creator as string, 6)}
			</span>,
		],
		['Total supply', `${formatTokens(big(launch.curve_supply) + big(launch.pool_tokens), 0)} ${meta.symbol}`],
		['Sold on the curve', `${formatTokens(big(launch.curve_supply), 0)} ${meta.symbol}`],
		['Reserved for the RivrDEX pool', `${formatTokens(big(launch.pool_tokens), 0)} ${meta.symbol}`],
		[
			'Trade fee',
			cfg
				? `${cfg.feeBps / 100}% (${cfg.creatorFeeBps / 100}% to the creator, ${(cfg.feeBps - cfg.creatorFeeBps) / 100}% to the platform)`
				: '—',
		],
		['Minting', 'Fixed supply. Mint, burn and admin roles are renounced at graduation.'],
	]
	return (
		<div className="flex flex-col gap-5">
			{meta.description && <p className="text-[14px] leading-relaxed text-[#FDFDFD]/85">{meta.description}</p>}
			<div className="overflow-hidden rounded-xl border border-[#2E3B55]">
				{rows.map(([k, v]) => (
					<div key={k} className="flex items-center justify-between gap-4 px-4 py-2.5 text-[13px] odd:bg-[#FDFDFD]/[2%]">
						<span className="text-[#FDFDFD]/60">{k}</span>
						<span className="text-right tabular-nums">{v}</span>
					</div>
				))}
			</div>
			<p className="text-[12px] leading-relaxed text-[#FDFDFD]/55">
				When every curve token is sold, the VARA raised (minus fees) and the reserved tokens are added to a RivrDEX pool at
				the curve&apos;s final price, and the LP tokens are burned so the liquidity cannot be pulled.
			</p>
		</div>
	)
}

// ---------------------------------------------------------------- right rail

function StatsCard({ market }: { market?: Market }) {
	const [win, setWin] = useState<'5m' | '1h' | '24h'>('24h')
	const s = market?.stats[win]
	return (
		<Panel
			title="Stats"
			action={
				<Tabs
					value={win}
					onChange={setWin}
					options={[
						{ value: '5m', label: '5m' },
						{ value: '1h', label: '1h' },
						{ value: '24h', label: '24h' },
					]}
				/>
			}
			bodyClassName="flex flex-col gap-4 p-4 text-[12px] tabular-nums"
		>
			{!s ? (
				<div className="h-32 animate-pulse rounded-md bg-[#FDFDFD]/[4%]" />
			) : (
				<>
					<div className="flex items-center justify-between">
						<span className="flex items-center gap-2 text-[#FDFDFD]/60">
							Price change <Delta value={s.change} chip />
						</span>
						<span className="text-[#FDFDFD]/60">
							Volume <span className="font-semibold text-[#FDFDFD]">{compact(s.volume)} VARA</span>
						</span>
					</div>
					<Split l={`${s.buys} buys`} r={`${s.sells} sells`} a={s.buys} b={s.sells} />
					<Split l={`${compact(s.buyVolume)} buy vol`} r={`${compact(s.sellVolume)} sell vol`} a={s.buyVolume} b={s.sellVolume} />
					<Split l={`${s.buyers} buyers`} r={`${s.sellers} sellers`} a={s.buyers} b={s.sellers} />
				</>
			)}
		</Panel>
	)
}

function Split({ l, r, a, b }: { l: string; r: string; a: number; b: number }) {
	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex justify-between">
				<span className="text-primary">{l}</span>
				<span className="text-[#FF4F4F]">{r}</span>
			</div>
			<SplitBar left={a} right={b} />
		</div>
	)
}

function CurveCard({ launch, market, symbol }: { launch: Launch; market?: Market; symbol: string }) {
	const graduated = launch.state === 'Graduated'
	const done = graduated || launch.state === 'Ready' || launch.state === 'Graduating'
	const bps = done ? 10_000 : progressBps(launch)
	const mcap = market?.curveLaunchById ? mcapFromE18(market.curveLaunchById.priceE18) : 0
	const grad = market?.graduationMcap ?? 0
	const ath = Math.max(market?.athMcap ?? 0, mcap)
	const rows: [string, React.ReactNode][] = [
		graduated
			? ['Sent to pool', `${formatVara(big(launch.pool_vara), 2)} VARA`]
			: ['Raised on curve', `${formatVara(big(launch.escrow), 2)} VARA`],
		['Left on curve', `${formatTokens(big(launch.real_remaining), 0)} ${symbol}`],
		['Reserved for pool', `${formatTokens(big(launch.pool_tokens), 0)} ${symbol}`],
	]
	return (
		<Panel
			title="Bonding curve"
			action={<span className="text-primary text-[12px] font-semibold tabular-nums">{(bps / 100).toFixed(bps > 9_990 && bps < 10_000 ? 2 : 1)}%</span>}
			bodyClassName="flex flex-col gap-4 p-4 text-[12px] tabular-nums"
		>
			<div className="h-2.5 w-full overflow-hidden rounded-full bg-[#0F1B34]">
				<div
					className="h-full rounded-full bg-[linear-gradient(90deg,#7FD13B,#B4FF69)] transition-[width] duration-500"
					style={{ width: `${bps / 100}%` }}
				/>
			</div>
			{!done && grad > 0 && (
				<p className="text-[#FDFDFD]/65">
					Graduates to RivrDEX at about <span className="text-primary font-semibold">{compact(grad)} VARA</span> market cap.
				</p>
			)}
			{graduated && (
				<a
					href={`${LAUNCHPAD.RIVRDEX_APP}/pool/${launch.pair as string}`}
					target="_blank"
					rel="noreferrer"
					className="text-primary flex items-center justify-between rounded-lg border border-[#B4FF69]/40 bg-[#B4FF69]/[6%] px-3 py-2 font-semibold transition hover:bg-[#B4FF69]/12"
				>
					Pool live on RivrDEX <span>↗</span>
				</a>
			)}
			<div className="flex flex-col gap-1.5">
				<div className="flex justify-between text-[#FDFDFD]/60">
					<span>
						MC <span className="font-semibold text-[#FDFDFD]">{compact(mcap)}</span>
					</span>
					<span>
						ATH <span className="font-semibold text-[#FDFDFD]">{compact(ath)}</span>
					</span>
				</div>
				<div className="h-1.5 w-full overflow-hidden rounded-full bg-[#0F1B34]">
					<div className="h-full rounded-full bg-[#C3C5EA]" style={{ width: `${ath ? (mcap / ath) * 100 : 0}%` }} />
				</div>
			</div>
			<div className="overflow-hidden rounded-lg border border-[#2E3B55]">
				{rows.map(([k, v]) => (
					<div key={k} className="flex justify-between gap-3 px-3 py-2 odd:bg-[#FDFDFD]/[2%]">
						<span className="text-[#FDFDFD]/60">{k}</span>
						<span>{v}</span>
					</div>
				))}
			</div>
		</Panel>
	)
}

function ClaimsCard({ token, launch }: { token: HexString; launch: Launch }) {
	const { walletAccount } = useAuth()
	const me = walletAccount?.decodedAddress as HexString | undefined
	const { data: pending } = usePendingPayout(token, me)
	const { claimCreatorFees, claimPayout } = useLaunchpad()
	const alert = useAlert()
	const [busy, setBusy] = useState(false)
	const isCreator = !!me && me === launch.creator
	const creatorFees = big(launch.creator_fees)
	const showPayout = !!me && (pending ?? ZERO) > ZERO
	const showFees = isCreator && creatorFees > ZERO
	if (!showPayout && !showFees) return null

	const claim = async (fn: (t: HexString) => Promise<bigint>, what: string) => {
		setBusy(true)
		try {
			alert.success(`Claimed ${formatVara(await fn(token))} VARA ${what}`)
		} catch (e) {
			alert.error(describeError(e instanceof Error ? e.message : e))
		} finally {
			setBusy(false)
		}
	}
	const row = (label: string, amount: bigint, onClick: () => void) => (
		<div className="flex items-center justify-between gap-3">
			<span className="text-[#FDFDFD]/75">
				{label}: <span className="text-primary font-semibold">{formatVara(amount)} VARA</span>
			</span>
			<button type="button" disabled={busy || amount < ONE_VARA} onClick={onClick} className="btn btn--primary px-4 py-2 md:py-2 md:text-[12px] disabled:bg-[#D0D3D9]">
				{amount < ONE_VARA ? 'At 1 VARA' : 'Claim'}
			</button>
		</div>
	)
	return (
		<Panel title="Claimable" className="border-[#B4FF69]/40" bodyClassName="flex flex-col gap-3 p-4 text-[12px]">
			{showPayout && row('From small sells', pending!, () => claim(claimPayout, 'from small sells'))}
			{showFees && row('Your creator fees', creatorFees, () => claim(claimCreatorFees, 'in creator fees'))}
		</Panel>
	)
}

// ---------------------------------------------------------------- page

export function CurveTokenSkeleton() {
	return (
		<div className="my-6 flex animate-pulse flex-col gap-4">
			<div className="h-[92px] rounded-2xl bg-[#1D2C4B]" />
			<div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px] xl:grid-cols-[300px_minmax(0,1fr)_360px]">
				<div className="hidden h-[600px] rounded-2xl bg-[#1D2C4B] xl:block" />
				<div className="h-[520px] rounded-2xl bg-[#1D2C4B]" />
				<div className="h-[520px] rounded-2xl bg-[#1D2C4B]" />
			</div>
		</div>
	)
}

type CenterTab = 'holders' | 'trades' | 'about'

/** pump.fun-style terminal for a curve token: trades feed, chart and tabs, and the trading rail. */
export function CurveTokenView({ token, meta }: { token: HexString; meta: CurveTokenMeta }) {
	const { walletAccount } = useAuth()
	const me = walletAccount?.decodedAddress as string | undefined
	const { data: launch, isLoading } = useLaunchInfo(token)
	const { data: market } = useTokenMarket(token)
	const { data: creatorHeld } = useVftBalance(token, launch ? (launch.creator as HexString) : undefined)
	const [tab, setTab] = useState<CenterTab>('holders')
	const supply = useMemo(() => (launch ? big(launch.curve_supply) + big(launch.pool_tokens) : ZERO), [launch])

	if (isLoading || !launch) return <CurveTokenSkeleton />
	const creatorHoldsBps = creatorHeld && supply > ZERO ? Number((creatorHeld * BigInt(10_000)) / supply) : 0

	return (
		<section className="font-poppins my-6 flex flex-col gap-4 max-sm:my-4">
			<HeaderBar token={token} meta={meta} launch={launch} market={market} creatorHoldsBps={creatorHoldsBps} />
			{launch.state === 'Failed' && (
				<p className="rounded-xl border border-[#FF4F4F]/50 bg-[#FF4F4F]/[8%] px-4 py-3 text-[13px] text-[#FF4F4F]">
					Graduation paused at step {String(launch.step)}: {launch.fail_reason || 'reply error'}.{' '}
					{launch.fail_retryable ? 'Anyone can retry it from the trade panel.' : 'It cannot be retried; it can be unwound once eligible.'}
				</p>
			)}
			<div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_360px] lg:grid-rows-[auto_1fr] xl:grid-cols-[300px_minmax(0,1fr)_360px]">
				{/* The feed matches the centre column's height and scrolls inside itself; it never drives row height. */}
				<div className="relative hidden min-w-0 xl:col-start-1 xl:row-span-2 xl:row-start-1 xl:block xl:self-stretch">
					<div className="absolute inset-0">
						<TradesFeed market={market} symbol={meta.symbol} me={me} />
					</div>
				</div>
				<div className="min-w-0 lg:col-start-1 lg:row-start-1 xl:col-start-2">
					<PriceChart token={token} />
				</div>
				<div className="flex min-w-0 flex-col gap-4 lg:col-start-2 lg:row-span-2 lg:row-start-1 xl:col-start-3">
					<TradePanel token={token} launch={launch} symbol={meta.symbol} />
					<ClaimsCard token={token} launch={launch} />
					<CurveCard launch={launch} market={market} symbol={meta.symbol} />
					<StatsCard market={market} />
					{market && <HolderDistribution market={market} launch={launch} supply={supply} />}
				</div>
				<div className="min-w-0 lg:col-start-1 lg:row-start-2 xl:col-start-2">
					<Panel
						title={
							<Tabs<CenterTab>
								value={tab}
								onChange={setTab}
								className="font-poppins normal-case"
								options={[
									{ value: 'holders', label: `Holders${market?.coinById ? ` ${market.coinById.holders}` : ''}` },
									{ value: 'trades', label: `Trades${market ? ` ${market.curveLaunchById?.tradeCount ?? market.curveTrades.length}` : ''}` },
									{ value: 'about', label: 'About' },
								]}
							/>
						}
						bodyClassName="p-4"
					>
						{tab === 'about' ? (
							<AboutTab token={token} meta={meta} launch={launch} />
						) : !market ? (
							<div className="h-40 animate-pulse rounded-md bg-[#FDFDFD]/[4%]" />
						) : tab === 'holders' ? (
							<HoldersTab market={market} launch={launch} supply={supply} me={me} />
						) : (
							<TradesTab market={market} symbol={meta.symbol} />
						)}
					</Panel>
				</div>
			</div>
		</section>
	)
}
