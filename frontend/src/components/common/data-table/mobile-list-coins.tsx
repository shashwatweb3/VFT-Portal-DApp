import { useState } from 'react'
import {
	type AlertContainerFactory,
	useAlert,
	useAccount,
} from '@gear-js/react-hooks'
import Image from 'next/image'
import Link from 'next/link'

import { ChevronDown } from 'lucide-react'
import { Sprite } from '@/components/ui/sprite'
import { getSafeImageSrc } from '@/lib/sanitize'

import {
	Accordion,
	AccordionContent,
	AccordionItem,
	AccordionTrigger,
} from '@/components/ui/accordion'
import { useFetchBalances } from '@/lib/hooks/use-fetch-balances'
import {
	copyToClipboard,
	formatDistributedPercentage,
	formatUnits,
	prettyWord,
} from '@/lib/utils'

import * as Separator from '@radix-ui/react-separator'
import {
	DropdownMenu,
	DropdownMenuTrigger,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
} from '@radix-ui/react-dropdown-menu'
import { useRouter } from 'next/navigation'
import { Mint } from '../token-mint'
import { Token } from '@/lib/hooks/use-fetch-coins'
import { CoinStatus } from '@/components/sections/tokens/all-coins/table.columns'

type ContentLayoutProps = {
	data: Token[]
}

type ButtonsProps = {
	id: `0x${string}`
	availableMint: bigint
	decimals: number
}

export function MobileList({ data }: ContentLayoutProps) {
	const { balances } = useFetchBalances()
	const alert = useAlert()
	const { account } = useAccount()

	const handleCopyClickAddress = async (
		address: string,
		alert?: AlertContainerFactory
	) => {
		await copyToClipboard({ value: address, alert })
	}

	return (
		<div className="font-poppins flex flex-col gap-4">
			{data.length > 0 ? (
				data.map((i: Token) => {
					const balance = balances.find((b) => b.coin.id === i.id)?.balance
					const isAdmin = i.admins.find((i) => i === account?.decodedAddress)

					const format = (value: string) =>
						formatUnits(BigInt(value), i.decimals)

					return (
						<Accordion
							className="space-y-6"
							type="single"
							collapsible
							defaultValue={`item-0`}
							key={i.id}
						>
							<AccordionItem
								key={i.name}
								value={`item-${i}`}
								className="radix-state-open:ring-brand z-0 rounded-lg bg-[#1D2C4B]"
							>
								<AccordionTrigger noIcon className="p-4 md:px-8">
									<div className="flex gap-3">
										<div className="flex flex-col items-center">
											<Image
												src={getSafeImageSrc(i.image)}
												key={i.id}
												alt={''}
												width={60}
												height={60}
												unoptimized={true}
												className="size-10 rounded-full object-cover"
												onError={(e) => {
													const target = e.target as HTMLImageElement
													target.onerror = null // prevents looping
													target.src = '/images/no-token.png'
												}}
											/>
											{isAdmin && (
												<p className="font-ps2p -m-2 w-max rounded-sm bg-white p-1 text-[5px] text-black uppercase">
													Creator
												</p>
											)}
										</div>
										<div>
											<span className="block text-sm">{i.name}</span>
											<div className="flex gap-1 text-sm">
												{balance && <span>{format(balance)}</span>}
												<span>{i.symbol}</span>
											</div>
										</div>
									</div>
									<div className="flex gap-5">
										{isAdmin && (
											<Buttons
												id={i.id}
												availableMint={
													BigInt(i.maxSupply) - BigInt(i.circulatingSupply)
												}
												decimals={i.decimals}
											/>
										)}
										<span className="group-radix-state-open:rotate-180 flex size-7.5 shrink-0 transform-gpu self-start rounded-full px-1.5 pt-[7px] pb-[5px] transition-transform duration-300">
											<ChevronDown className="size-4.5" />
										</span>
									</div>
								</AccordionTrigger>
								<AccordionContent className="px-4 pb-5 text-base text-[#535352]">
									<div className="-mt-3">
										<Separator.Root className="my-[15px] bg-[#FDFDFD]/[4%] data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px" />
									</div>
									<div className="flex flex-col gap-2">
										{i.kind && (
											<div className="flex items-center justify-between">
												<span className="text-[#FDFDFD]/[80%]">Status</span>
												<CoinStatus token={i} />
											</div>
										)}
										<div className="flex justify-between">
											<span className="text-[#FDFDFD]/[80%]">
												Initial Supply
											</span>
											<span className="text-[#FDFDFD]">
												{format(i.initialSupply)}
											</span>
										</div>
										<div className="flex justify-between">
											<span className="text-[#FDFDFD]/[80%]">Max Supply</span>
											<span className="text-[#FDFDFD]">
												{format(i.maxSupply)}
											</span>
										</div>
										<div className="flex justify-between">
											<span className="text-[#FDFDFD]/[80%]">Total Supply</span>
											<span className="text-[#FDFDFD]">
												{format(i.circulatingSupply)}
											</span>
										</div>
										<div className="flex justify-between">
											<span className="text-[#FDFDFD]/[80%]">Distributed</span>
											<span className="text-[#FDFDFD]">
												{formatDistributedPercentage(
													i.distributed,
													i.maxSupply
												)}
												%
											</span>
										</div>
										<div className="flex justify-between">
											<span className="text-[#FDFDFD]/[80%]">Holders</span>
											<span className="text-[#FDFDFD]">{i.holders}</span>
										</div>
										<div className="flex justify-between">
											<span className="text-[#FDFDFD]/[80%]">Address</span>
											<div className="flex items-center justify-center gap-3">
												<span className="text-[#FDFDFD]">
													{prettyWord(i.id)}
												</span>
												<button
													onClick={(e) => {
														e.stopPropagation()
														handleCopyClickAddress(i.id, alert)
													}}
												>
													<Sprite name="copy" size={16} color="#FDFDFD" />
												</button>
											</div>
										</div>
									</div>
									<Link href={`/tokens/${i.id}/`}>
										<button className="bg-primary font-ps2p mt-3 w-full rounded-lg py-2 text-[11px] text-[#242424]">
											Coin Page
										</button>
									</Link>
								</AccordionContent>
							</AccordionItem>
						</Accordion>
					)
				})
			) : (
				<div className="flex flex-col gap-2 rounded-md bg-[#1D2C4B] px-3 py-5 text-center text-[20px]">
					<h3 className="font-silkscreen">No matching tokens</h3>
					<p className="text-[16px] text-white/[80%]">
						Nothing matched your search yet. Try a different token name, symbol,
						or address.
					</p>
				</div>
			)}
		</div>
	)
}

function Buttons({ id, availableMint, decimals }: ButtonsProps) {
	const [isOpenMintModal, setIsOpenMintModal] = useState(false)
	const [open, setOpen] = useState(false)
	const router = useRouter()

	return (
		<>
			<Mint
				isMintModalOpen={isOpenMintModal}
				available={availableMint}
				decimals={decimals}
				id={id}
				mintModalHandler={setIsOpenMintModal}
			/>

			<DropdownMenu open={open} onOpenChange={setOpen}>
				<DropdownMenuTrigger asChild>
					<button type="button" className="link-primary -mr-2 inline-flex">
						<Sprite name="more" color="white" className="size-6" />
					</button>
				</DropdownMenuTrigger>
				<DropdownMenuContent
					align="end"
					side="top"
					className="bg-red-5 font-poppins flex min-w-35 flex-col gap-3 rounded-lg border-2 border-[#2E3B55] bg-[#1D2C4B] p-4 text-[14px] leading-none tracking-[0.03em] md:mt-2"
				>
					<DropdownMenuItem
						onClick={(e: { stopPropagation: () => void }) => {
							e.stopPropagation()
							router.push(`/tokens/${id}/send/`)
						}}
						className="flex gap-4"
					>
						<Sprite
							name="arrow-right-up"
							color="#FDFDFD/[30%]"
							className="size-5"
						/>
						Send
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem
						onClick={(e: { stopPropagation: () => void }) => {
							e.stopPropagation()
							setIsOpenMintModal(true)
						}}
						className="flex gap-4"
					>
						<Sprite name="coins" color="#FDFDFD/[30%]" className="size-5" />
						Mint Tokens
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem
						onClick={(e: { stopPropagation: () => void }) => {
							e.stopPropagation()
							router.push(`/tokens/${id}/burn/`)
						}}
						className="flex gap-4"
					>
						<Sprite name="fire" color="#FDFDFD/[30%]" className="size-5" />
						Burn
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</>
	)
}
