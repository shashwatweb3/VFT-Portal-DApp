import { cn } from '@/lib/utils'
import Link from 'next/link'
import {
	Accordion,
	AccordionContent,
	AccordionItem,
	AccordionTrigger,
} from '@/components/ui/accordion'
import { Sprite } from '@/components/ui/sprite'
import { CURVE_ENABLED } from '@/lib/consts'

type Props = {
	className?: string
}

export function HomepageFAQ({ className }: Props) {
	return (
		<section
			className={cn('container pt-25 pb-12.5 sm:py-18 lg:py-25', className)}
		>
			<h2 className="text-primary text-center text-[32px] leading-none">FAQ</h2>
			<Accordion
				className="mx-auto mt-8 grid max-w-[920px] gap-y-4 sm:gap-y-8 lg:gap-y-5"
				type="multiple"
			>
				{ITEMS.map((item, i) => (
					<AccordionItem key={i} value={`item-${i}`} className="">
						<AccordionTrigger
							noIcon
							className="link-white font-silkscreen radix-state-open:opacity-100 sm:py-[5px]"
						>
							<span className="text-[16px] leading-none sm:text-[24px]">
								{item.question}
							</span>
							<span className="shrink-0 grow-0">
								<Sprite
									name="accordion-minus"
									className="group-radix-state-open:block hidden size-8 sm:size-10"
								/>
								<Sprite
									name="accordion-plus"
									className="group-radix-state-open:hidden size-8 sm:size-10"
								/>
							</span>
						</AccordionTrigger>
						<AccordionContent
							className="font-poppins text-[14px] leading-normal text-[#FDFDFD]/80 sm:text-[22px]"
							classNameInner="pt-3 sm:pt-4"
						>
							<div className="space-y-4">{item.answer}</div>
						</AccordionContent>
						{i !== ITEMS.length - 1 && (
							<div className="mt-4 h-px w-full bg-[#FDFDFD]/[2%] sm:mt-8 lg:mt-5" />
						)}
					</AccordionItem>
				))}
			</Accordion>
		</section>
	)
}

const CURVE_QA = [
	{
		question: 'What is a Curve Launch?',
		answer: (
			<>
				<p>
					A Curve Launch puts your token on a bonding curve instead of asking you
					for liquidity up front. Anyone can buy and sell against the curve, and
					each buy moves the price up a little. Trades settle in an open-source
					smart contract. Its admin can pause new buys but cannot withdraw the VARA
					people pay in.
				</p>
			</>
		),
	},
	{
		question: 'What happens at graduation?',
		answer: (
			<>
				<p>
					When 800,000,000 tokens have been sold on the curve, anyone can trigger
					graduation (our keeper does it automatically). The launchpad opens a
					RivrDEX pool with the VARA the curve raised, minus trading fees and a
					small listing fee, and the remaining 200,000,000 tokens. The LP
					tokens are burned and every mint, burn and admin role on the token is
					renounced. From then on the token trades on RivrDEX.
				</p>
			</>
		),
	},
	{
		question: 'What are the fees on the curve?',
		answer: (
			<>
				<p>
					Each curve trade pays a 1 % fee on the VARA side: 0.5 % to the token&apos;s
					creator and 0.5 % to the protocol treasury. Creators claim their share
					from the token page. After graduation, trading fees are RivrDEX&apos;s pool
					fees.
				</p>
			</>
		),
	},
	{
		question: 'Can I still create a classic token?',
		answer: (
			<>
				<p>
					Yes. Choose Classic VFT in the create flow to set your own supply and
					decimals and keep the admin, mint and burn roles. You then list on
					RivrDEX yourself whenever you are ready.
				</p>
			</>
		),
	},
]

const QA = [
	{
		question: 'What is Tokenator?',
		answer: (
			<>
				<p>
					Tokenator is a no-code token launcher on Vara Network. Deploy a
					standard VFT (Vara Fungible Token) smart contract in minutes -
					memecoins, utility tokens, DAO governance tokens, reward points, or
					anything else. You set the name, supply, symbol, and logo. The
					contract is deployed automatically
					{CURVE_ENABLED ? (
						<>
							. With a Classic VFT the platform has no admin role on your token. With a
							Curve Launch the launchpad contract holds the token&apos;s roles until
							graduation and renounces all of them when the token lists on RivrDEX.
						</>
					) : (
						<>, and full ownership belongs to you. The platform has zero admin access to your token.</>
					)}
				</p>
			</>
		),
	},
	{
		question: 'How do I create my own token?',
		answer: (
			<>
				<p>
					Connect your{' '}
					<Link
						href="https://wiki.vara.network/docs/vara-network/account"
						className="link link-primary"
						target="_blank"
						rel="noreferrer"
					>
						Vara account
					</Link>
					, then click &quot;Create token.&quot; Fill in the name, description,
					symbol, supply, and any additional settings - social links,
					tokenomics, logo. Hit deploy, and your VFT smart contract goes live on
					Vara Network automatically. No code required.
				</p>
			</>
		),
	},
	{
		question: 'Can I mint more tokens after launch?',
		answer: (
			<>
				<p>
					Yes - if the initial supply is below your set maximum, you can mint
					additional tokens at any time as the owner. That said, it&apos;s worth
					finalizing your token&apos;s supply policy before launch: predictable
					issuance builds trust with your holders.
				</p>
			</>
		),
	},
	{
		question: 'How do I distribute my token?',
		answer: (
			<>
				<p>
					Once deployed, transfer tokens directly to any Vara address via the
					portal. Your distribution strategy is entirely up to you - airdrops,
					community rewards, vesting schedules, public sales, or anything else.
					Your token, your rules.
				</p>
			</>
		),
	},
	{
		question: 'Can I list my token on a DEX?',
		answer: (
			<>
				<p>
					Yes. The easiest way is to list directly on{' '}
					<Link
						href="https://rivrdex.io/docs/features/creating-pairs"
						className="link link-primary"
						target="_blank"
						rel="noreferrer"
					>
						RivrDEX Mainnet
					</Link>{' '}
					- the native DEX on Vara Network. After deploying your token, head to
					RivrDEX, create a liquidity pool, and your token is tradeable. Anyone
					can add liquidity and start trading permissionlessly.
				</p>
			</>
		),
	},
	{
		question:
			"What should I consider when setting up my token's initial supply?",
		answer: (
			<>
				<p>
					Think about your token&apos;s purpose and who should hold it - early
					users, the community, a treasury, a team. Large supplies suit
					high-volume use cases (points, rewards); smaller supplies work better
					for governance or scarce assets. Look at similar projects for
					reference, and define your distribution plan before launch.
				</p>
			</>
		),
	},
	{
		question: 'How can I ensure my token is secure?',
		answer: (
			<>
				<p>
					{CURVE_ENABLED
						? 'Your token contract follows the VFT standard on Vara Network. For Classic tokens the platform holds no admin keys; for curve tokens the launchpad contract holds them until graduation and then renounces mint, burn and admin for good.'
						: 'Your token contract follows the VFT standard on Vara Network, and the platform holds no admin keys.'}{' '}
					For broader security:
					communicate transparently with your community, use secure distribution
					practices, and - if you plan to build significant value around the
					token - consider a third-party audit.
				</p>
			</>
		),
	},
	{
		question: 'Do I need coding skills to launch a token?',
		answer: (
			<>
				<p>
					Not at all. Tokenator handles smart contract deployment automatically
					- no Solidity, no Rust, no CLI. If you can fill in a form, you can
					launch a token on Vara Network.
				</p>
			</>
		),
	},
	{
		question: 'What does it cost to create a token?',
		answer: (
			<>
				<p>
					{CURVE_ENABLED
						? 'A Classic VFT costs only network gas. Curve launches can be gas-sponsored (one per wallet per day) when sponsorship is available. Either way, keep a small amount of VARA in your wallet for later transactions.'
						: 'Launching a token costs only network gas. You need a small amount of VARA in your wallet to cover fees for deployment, minting, and transfers.'}
				</p>
				<p>
					Note: the{' '}
					<Link
						href="https://docs.polkadot.com/reference/glossary/#existential-deposit"
						className="link link-primary"
						target="_blank"
						rel="noreferrer"
					>
						Existential Deposit
					</Link>{' '}
					on the Vara Network is 1 VARA, so keep at least 2 VARA in your account
					to stay active and cover transactions.
				</p>
			</>
		),
	},
	{
		question: 'How do I get people to use my token?',
		answer: (
			<>
				<p>
					Start by giving your token real utility or a compelling story. Share
					it on X, crypto forums, and community chats. List it on{' '}
					<Link
						href="https://rivrdex.io/docs/features/creating-pairs"
						className="link link-primary"
						target="_blank"
						rel="noreferrer"
					>
						RivrDEX Mainnet
					</Link>{' '}
					so anyone can trade it instantly. Airdrops, early-holder rewards, and
					partnerships are great ways to grow an initial community.
				</p>
				<p>
					Whatever your token is for - a meme, a project, a DAO - a clear
					purpose makes it spread.
				</p>
			</>
		),
	},
]

const ITEMS = CURVE_ENABLED ? [...CURVE_QA, ...QA] : QA
