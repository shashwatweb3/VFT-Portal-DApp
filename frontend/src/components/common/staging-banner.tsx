'use client'

import { useEffect, useState } from 'react'
import { isStagingHost, STAGING_READ_ONLY_MESSAGE } from '@/lib/staging'

export function StagingBanner() {
	const [visible, setVisible] = useState(false)

	useEffect(() => {
		setVisible(isStagingHost(window.location.hostname))
	}, [])

	if (!visible) return null

	return (
		<div
			role="note"
			className="bg-primary font-poppins border-b border-black/10 px-4 py-2 text-center text-[12px] leading-snug font-semibold text-[#0F1B34]"
		>
			{STAGING_READ_ONLY_MESSAGE}
		</div>
	)
}
