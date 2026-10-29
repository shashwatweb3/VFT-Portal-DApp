'use client'

import { useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'

import { Sprite } from '@/components/ui/sprite'
import {
	copyToClipboard,
	formatDistributedPercentage,
	formatUnits,
	prettyWord,
} from '@/lib/utils'
import { getSafeHttpsUrl, getSafeImageSrc } from '@/lib/sanitize'
import { useAlert } from '@gear-js/react-hooks'
import { HexString } from '@gear-js/api'
import { useFetchBalances } from '@/lib/hooks/use-fetch-balances'
import { useAuth } from '@/lib/hooks/use-auth'
import { Mint } from '@/components/common/token-mint'
import { CurveTokenSkeleton, CurveTokenView } from '@/components/sections/tokens/curve/curve-token-view'
import { launchpadEnabled, useLaunchInfo } from '@/lib/sails/use-launchpad'

export interface IToken {
	description: string
	decimals: number
	distributed: string
	image: string
	id: `0x${string}`
	name: string
	symbol: string
	initialSupply: string
	maxSupply: string
	createdBy: HexString
	burned: string
	minted: string
	circulatingSupply: string
	holders: string
	telegram?: string
	twitter?: string
	website?: string
	discord?: string
	tokenomics?: string
}

type Props = {
	token: IToken
}

function SocialLink({ platform, href }: { platform: string; href: string }) {
	return (
		<Link href={href} target="_blank" rel="noreferrer">
			<Sprite name={platform} color="#B4FF69" className="size-5" />
		</Link>
	)
}

export function Token({ token: { id, ...token } }: Props) {
	const [isOpenMintModal, setIsOpenMintModal] = useState(false)
	const { walletAccount } = useAuth()
	const { balances } = useFetchBalances(isOpenMintModal)

	const alert = useAlert()
	// Curve tokens have a fixed supply and no roles to mint or burn; their stats live in the curve block.
	const { data: launch, isLoading: launchLoading } = useLaunchInfo(id, launchpadEnabled())
	const isCurve = !!launch

	const onCopyLink = async () => {
		if (window) {
			await copyToClipboard({ value: window.location.href, alert })
		}
	}
	const onCopyAddress = async () => {
		await copyToClipboard({ value: id, alert })
	}

	const isAdmin = walletAccount?.decodedAddress === token.createdBy

	// Curve tokens get the trading terminal; wait for the chain before choosing a layout so it does not flash.
	if (launchpadEnabled() && launchLoading) return <CurveTokenSkeleton />
	if (isCurve) return <CurveTokenView token={id} meta={token} />

	const tokenBalance = balances?.find(
		(balance) => balance.coin.id === id
	)?.balance

	const formattedBalance = formatUnits(
		BigInt(tokenBalance || '0'),
		token.decimals
	)

	const availableMint =
		BigInt(token.maxSupply) - BigInt(token.circulatingSupply)
	const websiteHref = getSafeHttpsUrl(token.website)
	const twitterHref = getSafeHttpsUrl(token.twitter)
	const discordHref = getSafeHttpsUrl(token.discord)
	const telegramHref = getSafeHttpsUrl(token.telegram)
	const tokenomicsHref = getSafeHttpsUrl(token.tokenomics)
	const imageSrc = getSafeImageSrc(token.image)

	const stats: [string, string][] = [
		['Holders', String(token.holders)],
		['Total supply', formatUnits(BigInt(token.circulatingSupply), token.decimals)],
		['Distributed', `${formatDistributedPercentage(token.distributed, token.maxSupply)}%`],
		['Minted', formatUnits(BigInt(token.minted), token.decimals)],
		['Burned', formatUnits(BigInt(token.burned), token.decimals)],
		['Initial supply', formatUnits(BigInt(token.initialSupply), token.decimals)],
		['Max supply', formatUnits(BigInt(token.maxSupply), token.decimals)],
		['Decimals', String(token.decimals)],
	]
	const canSend = !!tokenBalance && BigInt(tokenBalance) > 0 && !!walletAccount

	return (
		<section className="font-poppins my-6 flex flex-col gap-4 max-sm:my-4">
			<Mint
				isMintModalOpen={isOpenMintModal}
				available={availableMint}
				decimals={token.decimals}
				id={id}
				mintModalHandler={setIsOpenMintModal}
			/>
			<div className="flex flex-wrap items-start gap-6 rounded-2xl border border-[#2E3B55] bg-[#1D2C4B] p-5 max-sm:p-4">
				<div className="flex min-w-0 flex-1 basis-[420px] items-start gap-4">
					<Link
						href="/tokens"
						aria-label="Back to tokens"
						className="flex size-9 shrink-0 items-center justify-center rounded-full border border-[#2E3B55] text-[#FDFDFD]/80 transition hover:border-[#B4FF69] hover:text-primary"
					>
						←
					</Link>
					<Image
						src={imageSrc}
						alt={`Logo ${token.name}`}
						width={72}
						height={72}
						className="size-[72px] shrink-0 rounded-xl object-cover max-sm:size-14"
						unoptimized={true}
						onError={(e) => {
							const target = e.target as HTMLImageElement
							target.onerror = null // prevents looping
							target.src = '/images/no-token.png'
						}}
					/>
					<div className="flex min-w-0 flex-col gap-2">
						<div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
							<h1 className="font-ps2p text-primary truncate text-[20px] max-sm:text-[14px]">{token.name}</h1>
							<span className="font-silkscreen text-[14px] text-[#FDFDFD]/70">{token.symbol}</span>
							{tokenBalance && (
								<span className="text-[12px] text-[#FDFDFD]/60">
									You hold <span className="text-primary font-semibold">{formattedBalance}</span>
								</span>
							)}
						</div>
						<div className="flex flex-wrap items-center gap-1.5 text-[12px]">
							<button
								className="flex h-7 items-center gap-1.5 rounded-md border border-[#2E3B55] bg-[#0F1B34] px-2 text-[#FDFDFD]/80 transition hover:border-[#B4FF69]/60"
								onClick={onCopyAddress}
							>
								{prettyWord(id, 4)} <Sprite name="copy" color="#B4FF69" className="size-3" />
							</button>
							<button
								className="flex h-7 items-center gap-1.5 rounded-md border border-[#2E3B55] bg-[#0F1B34] px-2 text-[#FDFDFD]/80 transition hover:border-[#B4FF69]/60"
								onClick={onCopyLink}
							>
								<Sprite name="link" color="#B4FF69" className="size-3" /> Share
							</button>
							{tokenomicsHref && (
								<Link
									href={tokenomicsHref}
									target="_blank"
									rel="noreferrer"
									className="flex h-7 items-center gap-1.5 rounded-md border border-[#2E3B55] bg-[#0F1B34] px-2 text-[#FDFDFD]/80 transition hover:border-[#B4FF69]/60"
								>
									<Sprite name="tokenomics" color="#B4FF69" className="size-3" /> Tokenomics
								</Link>
							)}
							{websiteHref && <SocialLink platform="web" href={websiteHref} />}
							{twitterHref && <SocialLink platform="twitter" href={twitterHref} />}
							{discordHref && <SocialLink platform="discord" href={discordHref} />}
							{telegramHref && <SocialLink platform="telegram" href={telegramHref} />}
						</div>
						{token.description && (
							<p className="max-w-[640px] break-words text-[13px] leading-relaxed text-[#FDFDFD]/80">{token.description}</p>
						)}
						{(canSend || isAdmin) && (
							<div className="mt-1 flex flex-wrap items-center gap-2">
								{canSend && (
									<Link href={`/tokens/${id}/send/`} className="btn btn--primary px-5 py-2.5 md:py-2.5 md:text-[13px]">
										Send
									</Link>
								)}
								{isAdmin && availableMint > 0 && (
									<button
										onClick={() => setIsOpenMintModal(true)}
										className="btn border border-[#2E3B55] bg-[#0F1B34] px-5 py-2.5 text-[#FDFDFD] md:py-2.5 md:text-[13px]"
									>
										Mint tokens
									</button>
								)}
								{isAdmin && canSend && (
									<Link
										href={`/tokens/${id}/burn/`}
										className="btn border border-[#2E3B55] bg-[#0F1B34] px-5 py-2.5 text-[#FDFDFD] md:py-2.5 md:text-[13px]"
									>
										Burn
									</Link>
								)}
							</div>
						)}
					</div>
				</div>
				<dl className="grid w-full max-w-[520px] grid-cols-2 gap-x-6 gap-y-2 rounded-xl border border-[#2E3B55] bg-[#0F1B34]/50 p-4 text-[12px] sm:grid-cols-4 lg:w-auto">
					{stats.map(([k, v]) => (
						<div key={k} className="flex min-w-0 flex-col gap-0.5">
							<dt className="text-[11px] text-[#FDFDFD]/55">{k}</dt>
							<dd className="truncate font-semibold tabular-nums" title={v}>
								{v}
							</dd>
						</div>
					))}
				</dl>
			</div>
		</section>
	)
}
