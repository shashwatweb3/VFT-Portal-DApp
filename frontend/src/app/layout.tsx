import '@/styles/globals.css'
import type { Metadata } from 'next'
import { Silkscreen, Poppins, Press_Start_2P } from 'next/font/google'
import { Header } from '@/components/layouts/base/header'
import { ReactNode } from 'react'
import { GearApiProvider } from '@/components/providers/gear-api'
import { AnalyticsConsent } from '@/components/common/consent/consent-banner'
import { CURVE_ENABLED } from '@/lib/consts'

const GTM_ID = 'GTM-PRHTXR49'

const silkscreen = Silkscreen({
	display: 'swap',
	subsets: ['latin'],
	weight: ['400', '700'],
	variable: '--font-silkscreen',
})

const pressStart2P = Press_Start_2P({
	display: 'swap',
	subsets: ['latin'],
	weight: ['400'],
	variable: '--font-ps2p',
})

const poppins = Poppins({
	display: 'swap',
	subsets: ['latin'],
	weight: ['400', '600'],
	variable: '--font-poppins',
})
const siteConfig = {
	name: 'Tokenator',
}

export const metadata: Metadata = {
	title: {
		default: CURVE_ENABLED ? 'Tokenator 2.0 - Launch a token on Vara' : 'Tokenator - Deploy a VFT on Vara',
		template: `%s | ${siteConfig.name}`,
	},
	description:
		CURVE_ENABLED
			? 'Launch a token on Vara on a bonding curve. When the curve sells out it graduates to RivrDEX with the LP tokens burned.'
			: 'Deploy a VFT smart contract to Vara Network in minutes. No code. Yours forever. After launch, list your token on RivrDEX - the native DEX on Vara Network.',
}

export default function RootLayout({
	children,
}: Readonly<{
	children: ReactNode
}>) {
	return (
		// A wallet SDK writes Telegram viewport CSS variables onto <html> before hydration.
		<html
			lang="en"
			suppressHydrationWarning
			className={`${silkscreen.variable} ${poppins.variable} ${pressStart2P.variable}`}
		>
			<body className="flex min-h-screen flex-col font-ps2p [--header-height:5.625rem] sm:[--header-height:4.375rem] lg:[--header-height:6.25rem]">
				<GearApiProvider>
					<Header />
				</GearApiProvider>
				{children}
				<AnalyticsConsent gtmId={GTM_ID} />
			</body>
		</html>
	)
}
