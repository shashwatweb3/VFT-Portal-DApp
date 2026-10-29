'use client'

import Image from 'next/image'
import { getSafeImageSrc } from '@/lib/sanitize'
import { cn } from '@/lib/utils'

/** Deterministic two-tone avatar for a wallet address (no external requests). */
export function AddressAvatar({ address, size = 20 }: { address: string; size?: number }) {
	let h = 0
	for (let i = 2; i < Math.min(address.length, 18); i++) h = (h * 31 + address.charCodeAt(i)) >>> 0
	const a = h % 360
	const b = (a + 40 + ((h >> 9) % 80)) % 360
	return (
		<span
			aria-hidden
			className="inline-block shrink-0 rounded-full"
			style={{
				width: size,
				height: size,
				background: `radial-gradient(circle at 30% 30%, hsl(${a} 85% 62%), hsl(${b} 70% 32%))`,
			}}
		/>
	)
}

export function TokenAvatar({ src, alt, size, className }: { src: string | null | undefined; alt: string; size: number; className?: string }) {
	return (
		<Image
			src={getSafeImageSrc(src ?? '')}
			alt={alt}
			width={size}
			height={size}
			unoptimized
			className={cn('shrink-0 rounded-lg bg-[#0F1B34] object-cover', className)}
			style={{ width: size, height: size }}
			onError={(e) => {
				const t = e.target as HTMLImageElement
				t.onerror = null
				t.src = '/images/no-token.png'
			}}
		/>
	)
}

/** Signed % change; colour is always paired with a sign. */
export function Delta({ value, chip, className }: { value: number | undefined; chip?: boolean; className?: string }) {
	if (value === undefined || !Number.isFinite(value)) return <span className={cn('text-[#FDFDFD]/40', className)}>—</span>
	const up = value >= 0
	const text = `${up ? '+' : ''}${Math.abs(value) >= 1000 ? value.toFixed(0) : value.toFixed(2)}%`
	return (
		<span
			className={cn(
				'tabular-nums',
				up ? 'text-primary' : 'text-[#FF4F4F]',
				chip && (up ? 'rounded-md bg-[#B4FF69]/10 px-1.5 py-0.5' : 'rounded-md bg-[#FF4F4F]/10 px-1.5 py-0.5'),
				className
			)}
		>
			{chip && (up ? '▲ ' : '▼ ')}
			{text}
		</span>
	)
}

/** Inline SVG sparkline; fewer than two points draws nothing rather than a fake trend. */
export function Sparkline({ points, width = 120, height = 32 }: { points: number[]; width?: number; height?: number }) {
	if (points.length < 2) return <span className="text-[11px] text-[#FDFDFD]/40">—</span>
	const min = Math.min(...points)
	const max = Math.max(...points)
	const span = max - min || 1
	const step = width / (points.length - 1)
	const ys = points.map((p) => height - 2 - ((p - min) / span) * (height - 4))
	const d = ys.map((y, i) => `${i ? 'L' : 'M'}${(i * step).toFixed(1)},${y.toFixed(1)}`).join(' ')
	const up = points[points.length - 1] >= points[0]
	const stroke = up ? '#B4FF69' : '#FF4F4F'
	const id = `spark-${up ? 'u' : 'd'}`
	return (
		<svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden className="overflow-visible">
			<defs>
				<linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
					<stop offset="0%" stopColor={stroke} stopOpacity="0.25" />
					<stop offset="100%" stopColor={stroke} stopOpacity="0" />
				</linearGradient>
			</defs>
			<path d={`${d} L${width},${height} L0,${height} Z`} fill={`url(#${id})`} />
			<path d={d} fill="none" stroke={stroke} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
		</svg>
	)
}

/** Two-sided bar for buys vs sells and similar pairs. */
export function SplitBar({ left, right }: { left: number; right: number }) {
	const total = left + right
	const pct = total > 0 ? (left / total) * 100 : 50
	return (
		<div className="flex h-1.5 w-full gap-1">
			<div className="bg-primary h-full rounded-full transition-[width] duration-500" style={{ width: `${pct}%` }} />
			<div className="h-full flex-1 rounded-full bg-[#FF4F4F]" />
		</div>
	)
}

export function Panel({
	title,
	action,
	children,
	className,
	bodyClassName,
}: {
	title: React.ReactNode
	action?: React.ReactNode
	children: React.ReactNode
	className?: string
	bodyClassName?: string
}) {
	return (
		<section className={cn('font-poppins flex min-w-0 flex-col rounded-2xl border border-[#2E3B55] bg-[#1D2C4B]', className)}>
			<header className="flex items-center justify-between gap-3 border-b border-[#2E3B55] px-4 py-3">
				<h3 className="font-ps2p text-[10px] uppercase tracking-wide text-[#FDFDFD]">{title}</h3>
				{action}
			</header>
			<div className={cn('min-w-0', bodyClassName)}>{children}</div>
		</section>
	)
}

/** Compact underline tabs for dense cards. */
export function Tabs<T extends string>({
	value,
	onChange,
	options,
	className,
}: {
	value: T
	onChange: (v: T) => void
	options: { value: T; label: React.ReactNode }[]
	className?: string
}) {
	return (
		<div role="tablist" className={cn('flex items-center gap-1', className)}>
			{options.map((o) => (
				<button
					key={o.value}
					type="button"
					role="tab"
					aria-selected={value === o.value}
					onClick={() => onChange(o.value)}
					className={cn(
						'font-poppins rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors',
						value === o.value ? 'bg-[#B4FF69]/12 text-primary' : 'text-[#FDFDFD]/60 hover:text-[#FDFDFD]'
					)}
				>
					{o.label}
				</button>
			))}
		</div>
	)
}

export function LiveDot() {
	return (
		<span className="relative inline-flex size-2">
			<span className="bg-primary absolute inline-flex size-full animate-ping rounded-full opacity-60" />
			<span className="bg-primary relative inline-flex size-2 rounded-full" />
		</span>
	)
}
