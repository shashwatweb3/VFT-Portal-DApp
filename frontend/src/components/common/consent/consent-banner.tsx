'use client'

import Link from 'next/link'
import Script from 'next/script'
import { useSyncExternalStore } from 'react'

const KEY = 'tokenator-analytics-consent'
type Choice = 'granted' | 'denied'

function readChoice(): Choice | null {
	try {
		const v = window.localStorage.getItem(KEY)
		return v === 'granted' || v === 'denied' ? v : null
	} catch {
		return null
	}
}

const listeners = new Set<() => void>()
let memoryChoice: Choice | null = null

function subscribe(listener: () => void) {
	listeners.add(listener)
	return () => listeners.delete(listener)
}

/** Server render and first hydration see "unknown", so nothing renders until the client reads storage. */
const getSnapshot = (): Choice | null | 'unknown' => memoryChoice ?? readChoice()
const getServerSnapshot = (): 'unknown' => 'unknown'

/** Google Tag Manager loads only after the visitor accepts analytics. */
export function AnalyticsConsent({ gtmId }: { gtmId: string }) {
	const stored = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
	const ready = stored !== 'unknown'
	const choice = stored === 'unknown' ? null : stored

	const decide = (value: Choice) => {
		try {
			window.localStorage.setItem(KEY, value)
		} catch {
			// storage blocked: the choice holds for this page view only
		}
		memoryChoice = value
		listeners.forEach((l) => l())
	}

	return (
		<>
			{choice === 'granted' && (
				<Script id="gtm" strategy="afterInteractive">
					{`(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
})(window,document,'script','dataLayer','${gtmId}');`}
				</Script>
			)}
			{ready && choice === null && (
				<div className="fixed inset-x-0 bottom-0 z-[15] p-4">
					<div className="container">
						<div className="flex items-center justify-between gap-5 rounded-2xl border-2 border-[#2E3B55] bg-[#1D2C4B] p-5 font-poppins text-[14px] max-md:flex-col">
							<p className="text-[#FDFDFD]/80">
								We use analytics cookies to see how Tokenator is used. Nothing loads until you
								choose.{' '}
								<Link href="/privacy" className="link link-primary">
									Privacy
								</Link>
							</p>
							<div className="flex shrink-0 gap-3">
								<button
									type="button"
									onClick={() => decide('denied')}
									className="btn border-2 !border-[#2E3B55] bg-[#0F1B34] py-3 text-[#FDFDFD]"
								>
									Decline
								</button>
								<button type="button" onClick={() => decide('granted')} className="btn btn--primary py-3">
									Accept
								</button>
							</div>
						</div>
					</div>
				</div>
			)}
		</>
	)
}
