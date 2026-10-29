import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = { title: 'Privacy' }

const SECTIONS: [string, string[]][] = [
	[
		'What is public by design',
		[
			'Wallet addresses, token metadata and every trade are recorded on Vara Network and are public. Our explorer indexes that public data.',
		],
	],
	[
		'What we collect',
		[
			'Analytics (Google Tag Manager) load only if you accept them in the banner. We do not send your wallet address to analytics.',
			'When you request a gas-sponsored launch, our voucher service stores your wallet address and the time of the request to enforce one launch per wallet per day.',
			'Images you upload are pinned to IPFS through our proxy, which logs the request IP, file name, type and size so abuse reports can be traced.',
		],
	],
	[
		'Your choices',
		[
			'You can change your analytics choice by clearing this site’s storage. Anything written to the chain or to IPFS cannot be deleted by us.',
		],
	],
]

export default function PrivacyPage() {
	return (
		<div className="container my-10 flex flex-col gap-8">
			<Link href="/" className="link-white font-poppins w-max text-[14px]">
				← Back to Tokenator
			</Link>
			<h1 className="text-[28px] text-primary max-sm:text-[16px]">Privacy</h1>
			<p className="font-poppins text-[14px] text-[#A4AAB6]">Draft pending legal review.</p>
			<div className="flex flex-col gap-8 rounded-2xl bg-[#1D2C4B] p-8 font-poppins max-sm:p-5">
				{SECTIONS.map(([title, paras]) => (
					<section key={title} className="flex flex-col gap-3">
						<h2 className="font-ps2p text-[16px] uppercase max-sm:text-[12px]">{title}</h2>
						{paras.map((p) => (
							<p key={p} className="text-[16px] leading-normal text-[#FDFDFD]/80">
								{p}
							</p>
						))}
					</section>
				))}
			</div>
		</div>
	)
}
