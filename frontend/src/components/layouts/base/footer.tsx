import Link from 'next/link'
import { Sprite } from '@/components/ui/sprite'
import { SOCIALS } from '@/lib/data/socials'
import { cn } from '@/lib/utils'
import { CURVE_ENABLED } from '@/lib/consts'

export function Footer() {
	return (
		<footer className="font-poppins container pt-12.5 pb-20 md:pt-18 md:pb-45 lg:pt-25 lg:pb-12">
			<div className="flex justify-between gap-5 max-lg:flex-wrap max-lg:items-center sm:gap-10">
				{/*Link*/}
				<div className="">
					<Link href="/" className="hocus:opacity-80 transition-opacity">
						<span className="sr-only">Tokenator Logo</span>
						<Sprite
							name="logo-tokenator"
							className="h-11 w-18 sm:h-[86px] sm:w-[156px]"
						/>
					</Link>
				</div>
				{/*Navigation*/}
				{LINKS.map((link, index) => (
					<div
						key={index}
						className={cn(
							'order-last grid basis-full grid-cols-2 max-md:gap-x-5 sm:max-md:justify-between md:block md:basis-[280px] md:space-y-5 lg:order-none lg:basis-auto',
							index === 0
								? ''
								: 'mt-0 max-sm:border-t max-sm:border-[#FDFDFD]/[2%] max-sm:pt-5'
						)}
					>
						<p className="text-[14px] leading-normal font-semibold text-[#FDFDFD]/80 sm:basis-60 sm:text-[22px] sm:text-[#FDFDFD]">
							{link.title}
						</p>
						<ul className="space-y-4 text-[14px] leading-normal sm:space-y-5 sm:text-[18px]">
							{link.menu.map((item, i) => (
								<li key={i}>
									<Link
										href={item.url}
										className="link-white"
										target={item.url.includes('https') ? '_blank' : '_self'}
										rel={item.url.includes('https') ? 'noreferrer' : undefined}
									>
										{item.title}
									</Link>
								</li>
							))}
						</ul>
					</div>
				))}
				{/*Socials*/}
				<div className="w-fit">
					<ul className="flex items-center justify-between space-x-1 sm:space-x-4 md:space-x-8">
						{Object.values(SOCIALS).map((item, i) => (
							<li key={i}>
								<Link
									href={item.url}
									className="link-primary p-2 sm:p-0"
									target="_blank"
									rel="noreferrer"
								>
									<span className="sr-only">{item.title}</span>
									<Sprite
										name={item.icon}
										className="inline-block size-6 sm:size-9"
										aria-hidden
									/>
								</Link>
							</li>
						))}
					</ul>
				</div>
			</div>
		</footer>
	)
}

const LINKS = [
	{
		title: 'Tokenator - Vara Token Launcher',
		menu: [
			{
				title: 'All Tokens',
				url: '/tokens',
			},
			...(CURVE_ENABLED ? [{ title: 'Curve Launches', url: '/tokens?filter=curve' }] : []),
			{
				title: 'My Tokens',
				url: '/tokens/my',
			},
			{
				title: 'Create Token',
				url: '/tokens/create',
			},
			{
				title: 'List on RivrDEX',
				url: 'https://app.rivrdex.io/',
			},
		],
	},
	{
		title: 'Resources',
		menu: [
			{
				title: 'Vara Network',
				url: 'https://vara.network',
			},
			{
				title: 'Vara Wiki',
				url: 'https://wiki.vara.network',
			},
			{
				title: 'IDEA',
				url: 'https://idea.gear-tech.io',
			},
			{
				title: 'Terms',
				url: '/terms',
			},
			{
				title: 'Privacy',
				url: '/privacy',
			},
		],
	},
]
