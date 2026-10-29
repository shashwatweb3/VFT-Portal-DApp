'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { HexString } from '@gear-js/api'
import {
	CandlestickSeries,
	ColorType,
	CrosshairMode,
	HistogramSeries,
	createChart,
	type CandlestickData,
	type IChartApi,
	type ISeriesApi,
	type MouseEventParams,
	type UTCTimestamp,
} from 'lightweight-charts'

import { CURVE } from '@/lib/consts'
import { compact, formatPrice, initialPriceE18, mcapFromE18, priceFromE18 } from '@/lib/curve/market'
import { cn } from '@/lib/utils'
import { gql } from './curve-tables'
import { Tabs } from './ui'

type Interval = '60' | '300' | '3600' | '86400'
type Mode = 'mcap' | 'price'
type Candle = { bucketStart: string; open: string; high: string; low: string; close: string; volumeVara: string }
type Bar = { time: UTCTimestamp; open: number; high: number; low: number; close: number }

const CANDLES_QUERY = `query Candles($token: String!, $interval: Int!) {
  curveLaunchById(id: $token) { v0 t0 }
  curveCandles(where: { launch: { id_eq: $token }, interval_eq: $interval }, orderBy: bucketStart_ASC, limit: 1000) {
    bucketStart open high low close volumeVara
  }
}`

// Tokenator palette (globals.css): lime primary for up, form error red for down.
const UP = '#B4FF69'
const DOWN = '#FF4F4F'
const GRID = 'rgba(253,253,253,0.04)'
const TEXT = 'rgba(253,253,253,0.6)'

const fmt = (mode: Mode, v: number) => (mode === 'mcap' ? compact(v) : formatPrice(v))

/**
 * Market-cap (or price) candles in VARA for one launch. Each candle opens at the previous
 * close so the series is continuous even when a bucket starts with a jump. The view is fitted
 * only on first load and on interval/mode changes, so polling never resets the user's zoom.
 */
export function PriceChart({ token, className }: { token: HexString; className?: string }) {
	const [interval, setInterval] = useState<Interval>('60')
	const [mode, setMode] = useState<Mode>('mcap')
	const [legend, setLegend] = useState<Bar | null>(null)
	const container = useRef<HTMLDivElement>(null)
	const chart = useRef<IChartApi | null>(null)
	const candles = useRef<ISeriesApi<'Candlestick'> | null>(null)
	const volume = useRef<ISeriesApi<'Histogram'> | null>(null)
	const fitKey = useRef('')
	const modeRef = useRef<Mode>(mode)
	useEffect(() => {
		modeRef.current = mode
	}, [mode])

	const { data, isLoading, isError } = useQuery({
		queryKey: ['curve-candles', token, interval],
		refetchInterval: CURVE.QUOTE_POLL_MS * 2,
		refetchIntervalInBackground: false,
		queryFn: () => gql<{ curveLaunchById: { v0: string; t0: string } | null; curveCandles: Candle[] }>(CANDLES_QUERY, { token, interval: Number(interval) }),
	})

	useEffect(() => {
		if (!container.current) return
		const c = createChart(container.current, {
			autoSize: true,
			layout: {
				background: { type: ColorType.Solid, color: 'transparent' },
				textColor: TEXT,
				fontFamily: 'var(--font-poppins), sans-serif',
				fontSize: 11,
				attributionLogo: false,
				panes: { separatorColor: '#2E3B55', separatorHoverColor: 'rgba(253,253,253,0.08)', enableResize: false },
			},
			grid: { vertLines: { color: GRID }, horzLines: { color: GRID } },
			crosshair: { mode: CrosshairMode.Normal },
			rightPriceScale: { borderColor: '#2E3B55' },
			timeScale: { borderColor: '#2E3B55', timeVisible: true, secondsVisible: false, rightOffset: 4 },
		})
		candles.current = c.addSeries(CandlestickSeries, {
			upColor: UP,
			downColor: DOWN,
			borderUpColor: UP,
			borderDownColor: DOWN,
			wickUpColor: UP,
			wickDownColor: DOWN,
			priceFormat: { type: 'custom', formatter: (v: number) => fmt(modeRef.current, v), minMove: 1e-12 },
		})
		// Volume lives in its own pane so the main scale never stretches below zero.
		volume.current = c.addSeries(
			HistogramSeries,
			{ priceFormat: { type: 'custom', formatter: (v: number) => compact(v) }, lastValueVisible: false, priceLineVisible: false },
			1
		)
		const [pricePane, volumePane] = c.panes()
		pricePane.setStretchFactor(0.78)
		volumePane.setStretchFactor(0.22)
		candles.current.priceScale().applyOptions({ scaleMargins: { top: 0.1, bottom: 0.08 } })
		const onMove = (p: MouseEventParams) => {
			const bar = candles.current && (p.seriesData.get(candles.current) as CandlestickData<UTCTimestamp> | undefined)
			setLegend(bar && 'open' in bar ? (bar as Bar) : null)
		}
		c.subscribeCrosshairMove(onMove)
		// Layout can settle after the first fit (skeleton -> grid), which leaves candles bunched up;
		// re-fit whenever the container's width actually changes.
		let lastWidth = container.current.clientWidth
		const resize = new ResizeObserver(([entry]) => {
			const w = Math.round(entry.contentRect.width)
			if (Math.abs(w - lastWidth) < 2) return
			lastWidth = w
			requestAnimationFrame(() => c.timeScale().fitContent())
		})
		resize.observe(container.current)
		chart.current = c
		return () => {
			resize.disconnect()
			c.unsubscribeCrosshairMove(onMove)
			c.remove()
			chart.current = null
		}
	}, [])

	const rows = useMemo(() => {
		if (!data) return []
		const conv = mode === 'mcap' ? mcapFromE18 : priceFromE18
		// Indexer candles open at the price after their first trade. The first candle really opens
		// at the launch price (v0 / t0); every later one opens at the previous close.
		const l = data.curveLaunchById
		let prevClose: number | undefined = l ? conv(initialPriceE18(l.v0, l.t0)) : undefined
		return data.curveCandles.map((k) => {
			const time = Math.floor(Date.parse(k.bucketStart) / 1000) as UTCTimestamp
			const close = conv(k.close)
			const open = prevClose ?? conv(k.open)
			const high = Math.max(conv(k.high), open, close)
			const low = Math.min(conv(k.low), open, close)
			prevClose = close
			return { time, open, high, low, close, vol: Number(BigInt(k.volumeVara) / BigInt(1e6)) / 1e6 }
		})
	}, [data, mode])

	useEffect(() => {
		if (!data || !candles.current || !volume.current) return
		candles.current.setData(rows.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })))
		volume.current.setData(
			rows.map((r) => ({ time: r.time, value: r.vol, color: r.close >= r.open ? 'rgba(180,255,105,0.45)' : 'rgba(255,79,79,0.45)' }))
		)
		const key = `${interval}:${mode}`
		if (fitKey.current !== key && rows.length) {
			fitKey.current = key
			chart.current?.timeScale().fitContent()
		}
	}, [data, rows, interval, mode])

	const shown: Bar | null = legend ?? rows[rows.length - 1] ?? null
	const change = shown ? ((shown.close - shown.open) / (shown.open || 1)) * 100 : 0
	const empty = !isLoading && !isError && data && data.curveCandles.length === 0

	return (
		<div className={cn('font-poppins flex flex-col overflow-hidden rounded-2xl border border-[#2E3B55] bg-[#1D2C4B]', className)}>
			<div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#2E3B55] px-4 py-2.5">
				<Tabs<Interval>
					value={interval}
					onChange={setInterval}
					options={[
						{ value: '60', label: '1m' },
						{ value: '300', label: '5m' },
						{ value: '3600', label: '1h' },
						{ value: '86400', label: '1D' },
					]}
				/>
				<div className="flex items-center gap-1 text-[12px]">
					<button
						type="button"
						onClick={() => setMode('price')}
						className={cn('font-medium transition', mode === 'price' ? 'text-primary' : 'text-[#FDFDFD]/50 hover:text-[#FDFDFD]')}
					>
						Price
					</button>
					<span className="text-[#FDFDFD]/30">/</span>
					<button
						type="button"
						onClick={() => setMode('mcap')}
						className={cn('font-medium transition', mode === 'mcap' ? 'text-primary' : 'text-[#FDFDFD]/50 hover:text-[#FDFDFD]')}
					>
						MCap
					</button>
					<span className="font-silkscreen ml-3 text-[11px] text-[#FDFDFD]/50">VARA</span>
				</div>
			</div>
			<div className="flex min-h-[28px] flex-wrap items-center gap-x-3 gap-y-1 px-4 pt-2 text-[11px] tabular-nums text-[#FDFDFD]/60">
				{shown && (
					<>
						<span>
							O <span className={change >= 0 ? 'text-primary' : 'text-[#FF4F4F]'}>{fmt(mode, shown.open)}</span>
						</span>
						<span>
							H <span className={change >= 0 ? 'text-primary' : 'text-[#FF4F4F]'}>{fmt(mode, shown.high)}</span>
						</span>
						<span>
							L <span className={change >= 0 ? 'text-primary' : 'text-[#FF4F4F]'}>{fmt(mode, shown.low)}</span>
						</span>
						<span>
							C <span className={change >= 0 ? 'text-primary' : 'text-[#FF4F4F]'}>{fmt(mode, shown.close)}</span>
						</span>
						<span className={change >= 0 ? 'text-primary' : 'text-[#FF4F4F]'}>
							{change >= 0 ? '+' : ''}
							{change.toFixed(2)}%
						</span>
					</>
				)}
			</div>
			<div className="relative h-[420px] w-full max-lg:h-[340px] max-sm:h-[260px]">
				<div ref={container} className="absolute inset-0" />
				{(isLoading || empty || isError) && (
					<div className="absolute inset-0 flex items-center justify-center text-[13px] text-[#FDFDFD]/60">
						{isLoading ? 'Loading chart…' : isError ? 'Explorer unavailable' : 'No trades yet'}
					</div>
				)}
			</div>
		</div>
	)
}
