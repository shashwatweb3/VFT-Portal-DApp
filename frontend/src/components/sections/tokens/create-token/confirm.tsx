'use client'

import React, { useState } from 'react'
import Image from 'next/image'
import { useAtom } from 'jotai'

import { ICreateTokenForm } from './schema'
import { useAlert } from '@gear-js/react-hooks'
import { createdTokenAtom, launchModeAtom, stepAtom } from '.'
import { Created } from './created'
import { cn, getGatewayUrl, parseUnits, uploadToIpfs } from '@/lib/utils'
import { useMessages } from '@/lib/sails/use-send-message-factory'
import { useAuth } from '@/lib/hooks/use-auth'
import { Input } from '@/components/ui/input'
import { describeError, launchpadEnabled, useLaunchpad, useRaiseTarget, vouchersEnabled } from '@/lib/sails/use-launchpad'
import { formatVara, parseVara } from '@/lib/curve'
import { CURVE } from '@/lib/consts'
import Link from 'next/link'

interface Props {
	data: ICreateTokenForm | undefined
}

function InfoRow({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex w-full items-center justify-between p-3 odd:bg-[#FDFDFD]/[2%]">
			<span className="font-poppins text-[12px] font-semibold text-[#FDFDFD]/[80%]">{label}</span>
			<p className="ml-2 text-right text-[x-small]">{value}</p>
		</div>
	)
}

export const ConfirmCreate = ({ data }: Props) => {
	const [isPending, setIsPending] = useState(false)
	const [, setStep] = useAtom(stepAtom)
	const [mode] = useAtom(launchModeAtom)
	const [, setCreatedToken] = useAtom(createdTokenAtom)
	const [isCreated, setIsCreated] = useState(false)
	const [imageLink, setImageLink] = useState('')
	const [firstBuy, setFirstBuy] = useState('')
	const [acceptTerms, setAcceptTerms] = useState(false)
	const { walletAccount } = useAuth()
	const sendMessage = useMessages()
	const { launch } = useLaunchpad()
	const { data: curveConfig } = useRaiseTarget()
	const alert = useAlert()
	const curve = mode === 'curve' && launchpadEnabled()

	const onCreate = async () => {
		if (!data) return
		if (!walletAccount) {
			alert.error('Connect a wallet first')
			return
		}
		setIsPending(true)

		try {
			const [ipfsUrl] = await uploadToIpfs([data.image])
			const linkIPFSImage = getGatewayUrl(ipfsUrl)
			setImageLink(linkIPFSImage)
			if (!walletAccount || !linkIPFSImage) return

			const external_links = {
				image: linkIPFSImage,
				website: data?.external_links?.website || null,
				telegram: data?.external_links?.telegram || null,
				twitter: data?.external_links?.twitter || null,
				discord: data?.external_links?.discord || null,
				tokenomics: data?.external_links?.tokenomics || null,
			}

			if (curve) {
				const value = firstBuy ? parseVara(firstBuy) : BigInt(0)
				const result = await launch(
					{
						name: data.name,
						symbol: data.symbol,
						description: data.description,
						...external_links,
					},
					value,
					BigInt(0)
				)
				setCreatedToken(result.token)
				if (result.firstBuySkipped) {
					alert.error(`Token launched, but the first buy was refunded (${result.firstBuySkipped}). You can buy from the token page.`)
				}
				setIsCreated(true)
				return
			}

			const decimals = data.decimals || 0
			// parsing here and not in the schema,
			// because the schema values are being set to come back to previous step
			const inititalSupply = parseUnits(data.initial_supply?.toString() || '0', decimals).toString()
			const maxSupply = parseUnits(data.max_supply?.toString() || '0', decimals).toString()

			const sendMessageResult = await sendMessage('createFungibleProgram', {
				name: data.name,
				symbol: data.symbol,
				decimals,
				description: data.description,
				external_links,
				initial_supply: inititalSupply,
				max_supply: maxSupply,
				admin_id: walletAccount.decodedAddress,
			})

			if (sendMessageResult) {
				setIsCreated(true)
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : describeError(error)
			console.error('Error sending message:', error)
			alert.error('Error sending message: ' + errorMessage)
		} finally {
			setIsPending(false)
		}
	}

	const firstBuyPlanck = (() => {
		try {
			return firstBuy ? parseVara(firstBuy) : BigInt(0)
		} catch {
			return -BigInt(1)
		}
	})()
	const firstBuyError =
		firstBuyPlanck < BigInt(0)
			? 'Enter a VARA amount'
			: firstBuyPlanck > BigInt(0) && curveConfig && firstBuyPlanck < curveConfig.minTradeVara
				? `Minimum first buy is ${formatVara(curveConfig.minTradeVara, 0)} VARA`
				: ''
	const canConfirm = !isPending && (!curve || (acceptTerms && !firstBuyError))

	return (
		<div className="flex flex-col items-center gap-3 overflow-hidden">
			<h1 className="text-primary text-[28px] max-sm:text-center max-sm:text-[16px]">
				{curve ? 'Launch Token' : 'Create Token'}
			</h1>
			<div className="bg-blue-light flex w-[660px] flex-col gap-6 rounded-[40px] p-10 max-sm:w-full max-sm:rounded-[20px]">
				<div className="mx-auto w-2/5 max-sm:w-[70%]">
					<ol className="flex w-full items-center">
						<li className="after:border-primary flex w-full items-center text-[#0F1B34] after:inline-block after:h-1 after:w-full after:border-4 after:border-b after:content-['']">
							<span className="bg-primary flex size-10 shrink-0 items-center justify-center rounded-full max-sm:size-7 max-sm:text-[12px]">
								1
							</span>
						</li>
						<li
							className={cn(
								"flex w-full items-center text-[#0F1B34] after:inline-block after:h-1 after:w-full after:border-4 after:border-b after:border-[#D0D3D9] after:content-['']",
								isCreated && 'after:border-primary'
							)}
						>
							<span className="bg-primary flex size-10 shrink-0 items-center justify-center rounded-full max-sm:size-7 max-sm:text-[12px]">
								2
							</span>
						</li>
						<li className="flex w-0 items-center text-[#0F1B34] max-sm:w-auto">
							<span
								className={cn(
									'flex size-10 shrink-0 items-center justify-center rounded-full bg-[#D0D3D9] max-sm:size-7 max-sm:text-[12px]',
									isCreated && 'bg-primary'
								)}
							>
								3
							</span>
						</li>
					</ol>
				</div>
				{!isCreated ? (
					<>
						<h3 className="text-center uppercase">Confirm Details</h3>
						{data && (
							<div className="font-poppins flex flex-col gap-5 break-words">
								<div className="flex justify-center">
									<Image
										src={URL.createObjectURL(data.image)}
										alt={`Logo ${data.name}`}
										width={100}
										height={100}
										unoptimized={true}
										className="size-25 rounded-full object-cover"
										onError={(e) => {
											const target = e.target as HTMLImageElement
											target.onerror = null // prevents looping
											target.src = '/images/no-token.png'
										}}
									/>
								</div>

								<div className="flex justify-between">
									<div className="w-1/2">
										<span className="text-sm text-[#A4AAB6]">Name/Symbol</span>
										<p>
											{data.name}
											<span className="text-sm opacity-80"> {data.symbol}</span>
										</p>
									</div>

									<div className="w-1/2">
										<span className="text-sm text-[#A4AAB6]">{curve ? 'Supply / Curve target' : 'Decimals'}</span>
										<p>
											{curve
												? `1,000,000,000 / ${curveConfig ? formatVara(curveConfig.raiseTargetVara, 0) : '…'} VARA`
												: data.decimals}
										</p>
									</div>
								</div>

								{!curve && (
									<div className="flex justify-between">
										<div className="w-1/2">
											<span className="text-sm text-[#A4AAB6]">Initial Supply</span>
											<p>{data.initial_supply?.toLocaleString('us')}</p>
										</div>

										<div className="w-1/2">
											<span className="text-sm text-[#A4AAB6]">Max Supply</span>
											<p>{data.max_supply?.toLocaleString('us')}</p>
										</div>
									</div>
								)}

								{(data.external_links.website || data.external_links.twitter) && (
									<div className="flex justify-between max-sm:flex-col">
										{data.external_links.website && (
											<div className="w-1/2 max-sm:w-full">
												<span className="text-sm text-[#A4AAB6]">Website</span>
												<p className="">{data.external_links.website}</p>
											</div>
										)}

										{data.external_links.twitter && (
											<div className="w-1/2 max-sm:w-full">
												<span className="text-sm text-[#A4AAB6]">Twitter</span>
												<p>{data.external_links.twitter}</p>
											</div>
										)}
									</div>
								)}

								{(data.external_links.telegram || data.external_links.discord) && (
									<div className="flex justify-between max-sm:flex-col">
										{data.external_links.telegram && (
											<div className="w-1/2 max-sm:w-full">
												<span className="text-sm text-[#A4AAB6]">Telegram</span>
												<p>{data.external_links.telegram}</p>
											</div>
										)}

										{data.external_links.discord && (
											<div className="w-1/2 max-sm:w-full">
												<span className="text-sm text-[#A4AAB6]">Discord</span>
												<p>{data.external_links.discord}</p>
											</div>
										)}
									</div>
								)}

								<div className="break-words">
									<span className="text-sm text-[#A4AAB6]">Description</span>
									<p>{data.description}</p>
								</div>

								{curve && (
									<>
										<div className="flex flex-col rounded-lg border-2 border-[#2E3B55]">
											{vouchersEnabled() && (
												<InfoRow label="Gas sponsored by Tokenator" value="one launch per wallet per day" />
											)}
											<InfoRow
												label="Trade fee 1 %"
												value={`${((curveConfig?.creatorFeeBps ?? 50) / 100).toFixed(1)} % you / ${(((curveConfig?.feeBps ?? 100) - (curveConfig?.creatorFeeBps ?? 50)) / 100).toFixed(1)} % protocol`}
											/>
											<InfoRow
												label="Lists on RivrDEX"
												value="when the curve sells out · the VARA raised, minus fees and a small listing fee, goes into the pool with 20 % of the supply · LP tokens are burned"
											/>
											<InfoRow label="Roles" value="no mint, burn or admin keys after graduation" />
										</div>
										<Input
											label="First buy (optional)"
											placeholder="0"
											type="number"
											min="0"
											step="any"
											value={firstBuy}
											suffix="VARA"
											onChange={(e) => setFirstBuy(e.target.value)}
											error={firstBuyError}
											tooltip="Buy at the opening price in the same transaction. It is your VARA, not the voucher's, and it is shown publicly as 'Creator holds X %'."
										/>
										{firstBuyPlanck > BigInt(0) && !firstBuyError && (
											<p className="text-sm text-[#A4AAB6]">
												You will hold tokens bought with {formatVara(firstBuyPlanck)} VARA at launch. Keep ≥{' '}
												{formatVara(CURVE.KEEP_VARA, 0)} VARA for gas.
											</p>
										)}
										<label className="flex cursor-pointer items-start gap-3 text-sm">
											<input
												type="checkbox"
												checked={acceptTerms}
												onChange={(e) => setAcceptTerms(e.target.checked)}
												className="mt-1 size-4 accent-primary"
											/>
											<span className="text-[#FDFDFD]/80">
												I accept the{' '}
												<Link href="/terms" target="_blank" className="link link-primary">
													Tokenator curve launch terms
												</Link>
												. The token is mine to promote; the curve
												contract, not Tokenator, holds buyers&apos; VARA until graduation.
											</span>
										</label>
									</>
								)}
							</div>
						)}

						<div className="mt-7 flex gap-3">
							<button
								className="mx-auto w-full rounded-lg bg-[#0F1B34] py-3 text-white max-sm:text-[3vw]"
								onClick={() => setStep('create')}
								disabled={isPending}
							>
								Back
							</button>
							<button
								className="bg-primary mx-auto w-full rounded-lg py-3 text-black disabled:bg-[#D0D3D9]"
								onClick={onCreate}
								disabled={!canConfirm}
							>
								{isPending ? (
									<span className="mx-auto flex w-1/2 max-sm:w-4/5 max-sm:text-[3vw]">
										Pending
										<span className="after:animate-dots w-full after:flex after:content-['']"></span>
									</span>
								) : curve ? (
									'Launch'
								) : (
									'Confirm'
								)}
							</button>
						</div>
					</>
				) : (
					<Created name={data!.name} image={imageLink} launched={curve} />
				)}
			</div>
		</div>
	)
}
