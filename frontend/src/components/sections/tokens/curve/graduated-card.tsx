'use client'

import Link from 'next/link'
import { Sprite } from '@/components/ui/sprite'
import { LAUNCHPAD } from '@/lib/consts'
import { big, formatTokens, formatVara } from '@/lib/curve'
import type { Launch } from '@/lib/sails/launchpad'

export function GraduatedCard({ launch }: { launch: Launch }) {
	const pair = launch.pair as string
	return (
		<div className="flex flex-col gap-5">
			<h3 className="uppercase max-sm:text-[14px]">Graduated</h3>
			<p className="font-poppins text-[14px] text-[#FDFDFD]/80">
				Trading moved to RivrDEX. The curve sent {formatVara(big(launch.pool_vara), 0)}{' '}
				<span className="font-silkscreen">VARA</span> and {formatTokens(big(launch.pool_tokens), 0)} tokens into the
				pool.{big(launch.lp_burned) > BigInt(0) && ' The LP tokens were sent to the burn address.'}
				{launch.roles_renounced && ' Every mint, burn and admin role on the token is renounced.'}
			</p>
			<Link
				href={LAUNCHPAD.RIVRDEX_APP}
				target="_blank"
				rel="noreferrer"
				className="btn btn--primary w-full gap-2 py-3"
			>
				Trade on RivrDEX
				<Sprite name="arrow-right-up" className="size-4" aria-hidden />
			</Link>
			<a
				href={`${LAUNCHPAD.RIVRDEX_APP}/pool/${pair}`}
				target="_blank"
				rel="noreferrer"
				className="link link-primary font-poppins mx-auto text-[14px]"
			>
				View pool
			</a>
		</div>
	)
}
