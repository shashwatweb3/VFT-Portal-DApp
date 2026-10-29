'use client'

import { STATUS_LABEL } from '@/lib/curve'
import type { Launch } from '@/lib/sails/launchpad'
import { cn } from '@/lib/utils'

export function StatusBadge({ launch, className }: { launch: Launch; className?: string }) {
	return (
		<span
			className={cn(
				'font-ps2p w-max rounded-sm p-1 text-[8px] uppercase',
				launch.state === 'Graduated' ? 'bg-primary text-black' : 'bg-white text-black',
				className
			)}
		>
			{STATUS_LABEL[launch.state]}
		</span>
	)
}
