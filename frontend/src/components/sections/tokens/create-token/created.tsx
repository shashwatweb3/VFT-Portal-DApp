'use client'

import React from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { AnimationCoins } from '@/components/common/animation-coins'
import { getSafeImageSrc } from '@/lib/sanitize'
import { useAtom } from 'jotai'
import { createdTokenAtom } from '.'

interface Props {
	name: string
	image: string
	launched?: boolean
}

export const Created = ({ name, image, launched }: Props) => {
	const imageSrc = getSafeImageSrc(image)
	const [createdToken] = useAtom(createdTokenAtom)

	return (
		<>
			<AnimationCoins />
			<h3 className="text-center uppercase max-sm:text-center max-sm:text-[16px]">
				{launched ? 'Token launched' : 'Token created'}
			</h3>
			<div className="flex flex-col gap-5 font-poppins max-sm:text-center">
				<div className="mx-auto flex flex-col items-center justify-center gap-3 rounded-[42px] border-2 border-[#2E3B55] bg-[#172542] p-7 max-sm:p-5">
					<div className="font-ps2p uppercase text-primary max-sm:text-[10px]">{name}</div>
					<Image
						src={imageSrc}
						alt={`Logo ${name}`}
						width={100}
						height={100}
						unoptimized={true}
						className="h-25 w-25 rounded-full object-cover max-sm:size-20"
						onError={(e) => {
							const target = e.target as HTMLImageElement
							target.onerror = null // prevents looping
							target.src = '/images/no-token.png'
						}}
					/>
				</div>

				<p className="mx-auto w-2/3 text-center max-sm:w-full">
					{launched
						? 'Your token is live on the curve. Share the token page so people can buy in; it lists on RivrDEX by itself when the curve sells out.'
						: 'You will find your token in the portfolio. Now you can share it with your community.'}
				</p>
				<div className="mt-7 flex gap-3 font-ps2p">
					{launched && createdToken && (
						<Link href={`/tokens/${createdToken}`} className="mx-auto">
							<button className="rounded-lg bg-primary px-15 py-3 text-black max-sm:px-6 max-sm:text-[12px]">
								Open token page
							</button>
						</Link>
					)}
					<Link href="/tokens/my" className="mx-auto">
						<button
							className={
								launched && createdToken
									? 'rounded-lg border-2 border-[#2E3B55] bg-[#0F1B34] px-10 py-3 text-[#FDFDFD] max-sm:px-4 max-sm:text-[12px]'
									: 'rounded-lg bg-primary px-15 py-3 text-black max-sm:text-[12px]'
							}
						>
							My Tokens
						</button>
					</Link>
				</div>
			</div>
		</>
	)
}
