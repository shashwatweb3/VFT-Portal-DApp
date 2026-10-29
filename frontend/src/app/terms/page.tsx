import type { Metadata } from 'next'
import Link from 'next/link'
import { LAUNCHPAD } from '@/lib/consts'

export const metadata: Metadata = { title: 'Terms' }

const SECTIONS: [string, string[]][] = [
	[
		'What Tokenator is',
		[
			'Tokenator is an interface to smart contracts on Vara Network. It lets you create tokens and trade them on a bonding curve. The contracts are open source and anyone can call them without this website.',
			'Trades settle in the Curve Launch contract. Its admin can pause new buys and tune gas budgets, but cannot withdraw the VARA held by the curve; funds move only by the contract rules described here.',
		],
	],
	[
		'Curve launches',
		[
			'A curve token has a fixed supply of 1,000,000,000. 800,000,000 are sold on the bonding curve and 200,000,000 are reserved for the RivrDEX pool.',
			'When the curve sells out, anyone can trigger graduation. The contract adds the VARA the curve raised, minus trading fees and a small listing fee, and the reserved tokens to a RivrDEX pool at the curve\'s final price, burns the LP tokens and renounces every mint, burn and admin role on the token.',
			'If graduation cannot complete, anyone can unwind it and holders can sell back at the frozen curve. Buying stays closed after an unwind.',
			'Each curve trade pays a 1 % fee on the VARA side: half to the token creator and half to the protocol treasury.',
		],
	],
	[
		'Your responsibilities as a creator',
		[
			'You confirm you have the right to use the name, symbol and image of your token and that it does not impersonate a person, project or brand.',
			'You are responsible for how you describe and promote your token. Tokenator does not endorse any token.',
			'Your acceptance of these terms is recorded on chain with your launch as a hash of this version.',
		],
	],
	[
		'Risks',
		[
			'Token prices can fall to zero. Most curve tokens never sell out. Smart contracts can contain bugs. Only use VARA you can afford to lose.',
			'Removing a token from this interface does not remove it from the chain.',
		],
	],
	[
		'Reporting',
		[
			'To report a token that impersonates someone or uses content you own, contact the Tokenator team with the token address. We may stop showing it in this interface.',
		],
	],
]

export default function TermsPage() {
	return (
		<div className="container my-10 flex flex-col gap-8">
			<Link href="/" className="link-white font-poppins w-max text-[14px]">
				← Back to Tokenator
			</Link>
			<h1 className="text-[28px] text-primary max-sm:text-[16px]">Terms</h1>
			<p className="font-poppins text-[14px] text-[#A4AAB6]">
				Version {LAUNCHPAD.TERMS_VERSION}. Draft pending legal review.
			</p>
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
