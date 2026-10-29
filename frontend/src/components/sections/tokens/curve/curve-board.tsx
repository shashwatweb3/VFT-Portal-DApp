'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import Ticker from 'framer-motion-ticker'

import { age, compact, formatPrice, planckToVara, useBoard, type BoardToken, type BoardTrade } from '@/lib/curve/market'
import { cn, prettyWord } from '@/lib/utils'
import { AddressAvatar, Delta, LiveDot, Panel, Sparkline, Tabs, TokenAvatar } from './ui'

type Sort = 'trending' | 'top' | 'gainers' | 'new' | 'graduated'

const isLive = (t: BoardToken) => t.status === 'TRADING' || t.status === 'STUCK'
const isGraduated = (t: BoardToken) => t.status === 'GRADUATED'
const href = (id: string) => `/tokens/${id}`
const price = (t: BoardToken) => t.mcap / 1e9

/** Activity score for "trending": 24h trades and volume, decayed by idle time. */
const trendScore = (t: BoardToken) => {
	const idleMin = (Date.now() - Date.parse(t.updatedAt)) / 60_000
	return (t.trades24h * 2 + t.vol24h / 10) / (1 + idleMin / 60)
}

function sortTokens(tokens: BoardToken[], sort: Sort) {
	const by = (f: (t: BoardToken) => number) => (a: BoardToken, b: BoardToken) => f(b) - f(a)
	switch (sort) {
		case 'top':
			return tokens.filter((t) => !isGraduated(t)).sort(by((t) => t.mcap))
		case 'gainers':
			return tokens.filter(isLive).sort(by((t) => t.change24h ?? -Infinity))
		case 'new':
			return tokens.filter((t) => !isGraduated(t)).sort(by((t) => Date.parse(t.createdAt)))
		case 'graduated':
			return tokens.filter(isGraduated).sort(by((t) => Date.parse(t.graduatedAt ?? t.updatedAt)))
		default:
			return tokens.filter((t) => !isGraduated(t)).sort(by(trendScore))
	}
}

// ---------------------------------------------------------------- ticker + king

function LiveTicker({ trades }: { trades: BoardTrade[] }) {
	if (!trades.length) return null
	const newest = trades[0]
	return (
		<div className="relative z-1 -mx-4 flex items-center gap-4 bg-[#C3C5EA] py-2.5 text-[12px] leading-none text-[#242424] select-none sm:text-[13px]">
			<Link
				key={newest.id}
				href={href(newest.launch.id)}
				className={cn(
					'font-poppins ml-4 flex shrink-0 animate-pulse items-center gap-2 rounded-md px-3 py-1.5 font-semibold',
					newest.side === 'BUY' ? 'bg-primary' : 'bg-[#FF4F4F] text-white'
				)}
			>
				<AddressAvatar address={newest.trader} size={16} />
				{prettyWord(newest.trader, 3)} {newest.side === 'BUY' ? 'bought' : 'sold'} {compact(planckToVara(newest.vara))} VARA of{' '}
				{newest.launch.coin.symbol}
				<TokenAvatar src={newest.launch.coin.image} alt="" size={16} className="rounded" />
			</Link>
			<div className="min-w-0 flex-1 overflow-hidden">
				<Ticker duration={60}>
					{trades.slice(1, 24).map((t) => (
						<Link key={t.id} href={href(t.launch.id)} className="font-poppins ml-8 flex items-center gap-2 whitespace-nowrap">
							<TokenAvatar src={t.launch.coin.image} alt="" size={16} className="rounded" />
							<span className={t.side === 'BUY' ? 'font-semibold text-[#1D6B00]' : 'font-semibold text-[#B3261E]'}>
								{t.side === 'BUY' ? 'BUY' : 'SELL'}
							</span>
							{compact(planckToVara(t.vara))} VARA · {t.launch.coin.symbol}
						</Link>
					))}
				</Ticker>
			</div>
		</div>
	)
}

function KingBanner({ t }: { t: BoardToken }) {
	return (
		<Link
			href={href(t.id)}
			className="font-poppins group relative flex items-center gap-4 overflow-hidden rounded-2xl border border-[#B4FF69]/60 bg-[linear-gradient(90deg,rgba(180,255,105,0.12),rgba(29,44,75,1)_45%)] px-5 py-4 transition hover:border-[#B4FF69] max-sm:flex-wrap"
		>
			<TokenAvatar src={t.coin.image} alt={t.coin.name} size={56} />
			<div className="flex min-w-0 flex-col gap-1">
				<span className="font-ps2p bg-primary w-max rounded-sm px-1.5 py-1 text-[8px] uppercase text-black">👑 King of the hill</span>
				<span className="truncate text-[18px] font-semibold">
					{t.coin.name} <span className="font-silkscreen text-primary text-[14px]">{t.coin.symbol}</span>
				</span>
			</div>
			<div className="ml-auto flex items-center gap-8 max-sm:ml-0 max-sm:w-full max-sm:justify-between max-sm:gap-3">
				<Metric label="Market cap" value={`${compact(t.mcap)} VARA`} />
				<Metric label="24h" value={<Delta value={t.change24h} />} />
				<div className="flex w-48 flex-col gap-1.5 max-sm:w-28">
					<span className="text-[11px] text-[#FDFDFD]/60">Bonding curve {(t.progressBps / 100).toFixed(1)}%</span>
					<div className="h-1.5 overflow-hidden rounded-full bg-[#0F1B34]">
						<div className="bg-primary h-full rounded-full" style={{ width: `${t.progressBps / 100}%` }} />
					</div>
				</div>
				<span className="text-primary text-[18px] transition group-hover:translate-x-1 max-sm:hidden">→</span>
			</div>
		</Link>
	)
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
	return (
		<div className="flex flex-col gap-0.5">
			<span className="text-[11px] text-[#FDFDFD]/60">{label}</span>
			<span className="text-[14px] font-semibold tabular-nums">{value}</span>
		</div>
	)
}

// ---------------------------------------------------------------- summary panels

function MiniRow({ t, right }: { t: BoardToken; right: React.ReactNode }) {
	return (
		<Link href={href(t.id)} className="grid grid-cols-[minmax(0,1fr)_auto_64px] items-center gap-3 px-4 py-2 text-[12px] transition hover:bg-[#FDFDFD]/[4%]">
			<span className="flex min-w-0 items-center gap-2">
				<TokenAvatar src={t.coin.image} alt="" size={22} className="rounded-md" />
				<span className="truncate font-semibold">{t.coin.symbol}</span>
			</span>
			<span className="tabular-nums text-right text-[#FDFDFD]/80">{compact(t.mcap)}</span>
			<span className="text-right">{right}</span>
		</Link>
	)
}

function MiniHead({ cols }: { cols: [string, string, string] }) {
	return (
		<div className="grid grid-cols-[minmax(0,1fr)_auto_64px] gap-3 px-4 pt-2 pb-1 text-[10px] uppercase tracking-wider text-[#FDFDFD]/45">
			<span>{cols[0]}</span>
			<span className="text-right">{cols[1]}</span>
			<span className="text-right">{cols[2]}</span>
		</div>
	)
}

function EmptyMini({ text }: { text: string }) {
	return <p className="px-4 py-6 text-center text-[12px] text-[#FDFDFD]/50">{text}</p>
}

function SummaryPanels({ tokens, recent }: { tokens: BoardToken[]; recent: BoardTrade[] }) {
	const trending = sortTokens(tokens, 'trending').slice(0, 5)
	const graduated = sortTokens(tokens, 'graduated').slice(0, 5)
	const gainers = sortTokens(tokens, 'gainers').filter((t) => (t.change24h ?? 0) > 0).slice(0, 5)
	return (
		<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
			<Panel title="🔥 Trending" bodyClassName="pb-2">
				<MiniHead cols={['Token', 'Mcap', '24h Δ']} />
				{trending.length ? trending.map((t) => <MiniRow key={t.id} t={t} right={<Delta value={t.change24h} />} />) : <EmptyMini text="No live tokens" />}
			</Panel>
			<Panel title="🎓 Just graduated" bodyClassName="pb-2">
				<MiniHead cols={['Token', 'Mcap', 'When']} />
				{graduated.length ? (
					graduated.map((t) => (
						<MiniRow key={t.id} t={t} right={<span className="text-[#FDFDFD]/60">{age(t.graduatedAt ?? t.updatedAt)} ago</span>} />
					))
				) : (
					<EmptyMini text="No graduations yet" />
				)}
			</Panel>
			<Panel title="🚀 Gainers" bodyClassName="pb-2">
				<MiniHead cols={['Token', 'Mcap', '24h Δ']} />
				{gainers.length ? gainers.map((t) => <MiniRow key={t.id} t={t} right={<Delta value={t.change24h} />} />) : <EmptyMini text="No gainers in 24h" />}
			</Panel>
			<Panel
				title="Live trades"
				action={
					<span className="flex items-center gap-1.5 text-[11px] text-primary">
						<LiveDot /> Live
					</span>
				}
				className="border-[#B4FF69]/30"
				bodyClassName="pb-2"
			>
				<div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-4 pt-2 pb-1 text-[10px] uppercase tracking-wider text-[#FDFDFD]/45">
					<span>Trader</span>
					<span className="text-right">Amount</span>
				</div>
				{recent.length ? (
					recent.slice(0, 5).map((t) => (
						<Link
							key={t.id}
							href={href(t.launch.id)}
							className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-2 text-[12px] transition hover:bg-[#FDFDFD]/[4%]"
						>
							<span className="flex min-w-0 items-center gap-2">
								<AddressAvatar address={t.trader} size={22} />
								<span className="truncate tabular-nums text-[#FDFDFD]/80">{prettyWord(t.trader, 4)}</span>
							</span>
							<span className="flex items-center gap-1.5 tabular-nums">
								<span className={t.side === 'BUY' ? 'text-primary' : 'text-[#FF4F4F]'}>
									{t.side === 'BUY' ? '+' : '−'}
									{compact(planckToVara(t.vara))}
								</span>
								<span className="text-[#FDFDFD]/60">{t.launch.coin.symbol}</span>
							</span>
						</Link>
					))
				) : (
					<EmptyMini text="No trades in 24h" />
				)}
			</Panel>
		</div>
	)
}

// ---------------------------------------------------------------- table

function CurveCell({ t }: { t: BoardToken }) {
	if (isGraduated(t))
		return <span className="font-ps2p bg-primary rounded-sm px-1.5 py-1 text-[7px] uppercase text-black">On RivrDEX</span>
	if (t.status === 'READY' || t.status === 'GRADUATING')
		return <span className="font-ps2p rounded-sm bg-white px-1.5 py-1 text-[7px] uppercase text-black">Graduating</span>
	const pct = t.progressBps / 100
	return (
		<div className="flex w-full flex-col gap-1">
			<div className="flex justify-between text-[11px] tabular-nums text-[#FDFDFD]/70">
				<span>{pct.toFixed(1)}%</span>
				{t.status === 'STUCK' && <span className="text-[#FF4F4F]">stuck</span>}
			</div>
			<div className="h-1.5 overflow-hidden rounded-full bg-[#0F1B34]">
				<div className={cn('h-full rounded-full', pct >= 80 ? 'bg-primary' : 'bg-[#B4FF69]/70')} style={{ width: `${pct}%` }} />
			</div>
		</div>
	)
}

const COLS = 'grid-cols-[minmax(220px,1.6fr)_120px_110px_100px_140px_140px_60px_70px_70px_56px]'
const th = 'text-[10px] font-medium uppercase tracking-wider text-[#FDFDFD]/45'

function TokenTable({ tokens }: { tokens: BoardToken[] }) {
	const router = useRouter()
	return (
		<div className="font-poppins overflow-x-auto rounded-2xl border border-[#2E3B55] bg-[#1D2C4B]">
			<div className="min-w-[1180px]">
				<div className={cn('grid items-center gap-4 border-b border-[#2E3B55] px-4 py-3', COLS)}>
					<span className={th}>Token</span>
					<span className={cn(th, 'text-right')}>Price · 24h</span>
					<span className={cn(th, 'text-right')}>Market cap</span>
					<span className={cn(th, 'text-right')}>24h vol</span>
					<span className={cn(th, 'text-center')}>Trend</span>
					<span className={th}>Bonding curve</span>
					<span className={cn(th, 'text-right')}>Age</span>
					<span className={cn(th, 'text-right')}>Holders</span>
					<span className={cn(th, 'text-right')}>Txns</span>
					<span className={cn(th, 'text-right')}>Trade</span>
				</div>
				{tokens.map((t) => (
					<div
						key={t.id}
						role="link"
						tabIndex={0}
						onClick={() => router.push(href(t.id))}
						onKeyDown={(e) => e.key === 'Enter' && router.push(href(t.id))}
						className={cn(
							'font-poppins grid cursor-pointer items-center gap-4 border-b border-[#2E3B55]/60 px-4 py-3 text-[13px] transition last:border-b-0',
							'hover:bg-[#FDFDFD]/[4%] hover:shadow-[inset_2px_0_0_#B4FF69] focus-visible:bg-[#FDFDFD]/[4%] focus-visible:outline-none',
							COLS
						)}
					>
						<span className="flex min-w-0 items-center gap-3">
							<TokenAvatar src={t.coin.image} alt={t.coin.name} size={40} />
							<span className="flex min-w-0 flex-col">
								<span className="truncate font-semibold">{t.coin.name}</span>
								<span className="flex items-center gap-2 text-[11px] text-[#FDFDFD]/55">
									<span className="font-silkscreen text-primary">{t.coin.symbol}</span>
									<span className="flex items-center gap-1">
										by <AddressAvatar address={t.creator} size={11} /> {prettyWord(t.creator, 3)}
									</span>
								</span>
							</span>
						</span>
						<span className="flex flex-col items-end tabular-nums">
							<span>{formatPrice(price(t))}</span>
							<Delta value={t.change24h} className="text-[11px]" />
						</span>
						<span className="text-right font-semibold tabular-nums">{compact(t.mcap)}</span>
						<span className="text-right tabular-nums text-[#FDFDFD]/80">{t.vol24h ? compact(t.vol24h) : '—'}</span>
						<span className="flex justify-center">
							<Sparkline points={t.sparkline} width={120} height={30} />
						</span>
						<CurveCell t={t} />
						<span className="text-right tabular-nums text-[#FDFDFD]/70">{age(t.createdAt)}</span>
						<span className="text-right tabular-nums">{t.coin.holders}</span>
						<span className="text-right tabular-nums text-[#FDFDFD]/70">{t.trades24h || t.tradeCount}</span>
						<span className="flex justify-end">
							<Link
								href={href(t.id)}
								onClick={(e) => e.stopPropagation()}
								aria-label={`Trade ${t.coin.symbol}`}
								className="flex size-8 items-center justify-center rounded-full border border-[#2E3B55] text-primary transition hover:border-[#B4FF69] hover:bg-[#B4FF69]/10"
							>
								<svg viewBox="0 0 24 24" className="size-4" fill="currentColor" aria-hidden>
									<path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" />
								</svg>
							</Link>
						</span>
					</div>
				))}
			</div>
		</div>
	)
}

// ---------------------------------------------------------------- board

export function CurveBoard() {
	const [sort, setSort] = useState<Sort>('trending')
	const [search, setSearch] = useState('')
	const { data, isLoading, isError } = useBoard()
	const tokens = useMemo(() => data?.tokens ?? [], [data])
	const recent = data?.recent ?? []
	const king = useMemo(() => tokens.filter(isLive).sort((a, b) => b.progressBps - a.progressBps)[0], [tokens])
	const shown = useMemo(() => {
		const q = search.trim().toLowerCase()
		const list = sortTokens(tokens, sort)
		return q ? list.filter((t) => `${t.coin.name} ${t.coin.symbol} ${t.id}`.toLowerCase().includes(q)) : list
	}, [tokens, sort, search])

	if (isError)
		return (
			<p className="font-poppins rounded-2xl border border-[#2E3B55] bg-[#1D2C4B] p-4 text-[13px] text-[#FDFDFD]/70">
				The explorer is unreachable, so live curve data is hidden. Tokens below still load from the chain.
			</p>
		)

	return (
		<section className="flex flex-col gap-6">
			<LiveTicker trades={recent} />
			{isLoading ? (
				<div className="grid animate-pulse gap-4 md:grid-cols-2 xl:grid-cols-4">
					{Array.from({ length: 4 }).map((_, i) => (
						<div key={i} className="h-[248px] rounded-2xl bg-[#1D2C4B]" />
					))}
				</div>
			) : (
				<>
					{king && <KingBanner t={king} />}
					<SummaryPanels tokens={tokens} recent={recent} />
				</>
			)}
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="flex flex-wrap items-center gap-4">
					<h2 className="text-[20px] text-primary max-sm:text-[15px]">Curve market</h2>
					<Tabs<Sort>
						value={sort}
						onChange={setSort}
						options={[
							{ value: 'trending', label: 'Trending' },
							{ value: 'top', label: 'Top' },
							{ value: 'gainers', label: 'Gainers' },
							{ value: 'new', label: 'New' },
							{ value: 'graduated', label: 'Graduated' },
						]}
					/>
				</div>
				<input
					value={search}
					onChange={(e) => setSearch(e.target.value)}
					placeholder="Search name, ticker or address"
					aria-label="Search curve tokens"
					className="font-poppins h-9 w-72 rounded-lg border border-[#2E3B55] bg-[#0F1B34] px-3 text-[13px] text-[#FDFDFD] placeholder:text-[#FDFDFD]/40 focus:border-[#B4FF69] focus:outline-none max-sm:w-full"
				/>
			</div>
			{isLoading ? (
				<div className="h-[420px] animate-pulse rounded-2xl bg-[#1D2C4B]" />
			) : shown.length === 0 ? (
				<p className="font-poppins rounded-2xl border border-[#2E3B55] bg-[#1D2C4B] p-6 text-center text-[13px] text-[#FDFDFD]/60">
					{search ? 'No tokens match your search.' : 'No tokens here yet.'}
				</p>
			) : (
				<TokenTable tokens={shown} />
			)}
			<p className="font-poppins -mt-3 text-[11px] text-[#FDFDFD]/45">
				Prices and market caps are in VARA. 24h change for tokens younger than a day is measured from the launch price.
			</p>
		</section>
	)
}
