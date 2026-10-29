'use client'

import Ticker from 'framer-motion-ticker'
import Link from 'next/link'
import { CURVE_ENABLED } from '@/lib/consts'

type Props = {
	className?: string
}

export function HeroTicker({}: Props) {
	return (
		<Link
			href="/#about"
			onClick={(e) => {
				e.preventDefault()
				const element = document.getElementById('about')
				element?.scrollIntoView({ behavior: 'smooth' })
			}}
			className="relative z-1 bg-[#C3C5EA] py-3 text-[12px] leading-none text-[#242424] select-none sm:py-5 sm:text-[20px]"
		>
			<Ticker duration={120}>
				{Array.from({ length: 10 }).map((_, i) => (
					<p key={i} className="ml-12.5">
						Launch your token · Memecoins · Utility tokens · DAO tokens · Reward
						tokens · {CURVE_ENABLED ? 'Bonding curve · Lists on RivrDEX · ' : 'DeFi · '}Vara Network
					</p>
				))}
			</Ticker>
		</Link>
	)
}
