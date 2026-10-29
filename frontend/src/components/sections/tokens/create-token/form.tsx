'use client'

import { ChangeEvent, useEffect } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'

import { Input } from '@/components/ui/input'
import {
	createTokenDefault,
	createTokenSchema,
	createCurveTokenSchema,
	ICreateTokenForm,
} from '@/components/sections/tokens/create-token/schema'
import { SegmentedControl } from '@/components/sections/tokens/curve/segmented-control'
import { launchpadEnabled } from '@/lib/sails/use-launchpad'
import { TooltipContainer } from '@/components/ui/tooltip'
import { Sprite } from '@/components/ui/sprite'
import { InputArea } from '@/components/ui/InputArea'
import { useAtom } from 'jotai'

import { dataTokenAtom, launchModeAtom, stepAtom, type LaunchMode } from '.'
import { cn } from '@/lib/utils'
import { BackButton } from '@/components/common/back-button'

export const CreateForm = () => {
	const [, setStep] = useAtom(stepAtom)
	const [dataToken, setDataToken] = useAtom(dataTokenAtom)
	const [mode, setMode] = useAtom(launchModeAtom)
	const curve = mode === 'curve' && launchpadEnabled()

	const {
		handleSubmit,
		formState: { errors, touchedFields, dirtyFields },
		control,
		trigger,
		watch,
		setValue,
	} = useForm<ICreateTokenForm>({
		mode: 'onChange',
		defaultValues: dataToken || createTokenDefault,
		// The curve path fixes decimals and supply in the launchpad, so those fields are not validated.
		resolver: zodResolver((curve ? createCurveTokenSchema.omit({ first_buy: true, accept_terms: true }) : createTokenSchema) as never),
	})

	const [max_supply, initial_supply, decimals, image] = watch([
		'max_supply',
		'initial_supply',
		'decimals',
		'image',
	])

	useEffect(() => {
		if (dirtyFields.max_supply || dirtyFields.initial_supply) {
			trigger('initial_supply')
			trigger('max_supply')
		}
	}, [max_supply, initial_supply])

	useEffect(() => {
		if (dirtyFields.decimals) {
			trigger('decimals')
		}
	}, [decimals])

	useEffect(() => {
		if (dirtyFields.image) {
			trigger('image')
		}
	}, [image])

	const onSubmit = (data: ICreateTokenForm) => {
		setDataToken(data)
		setStep('confirm')
	}

	const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0]
		if (!file) return

		setValue('image', file, { shouldValidate: true })
		setDataToken((prev) => ({
			...prev!,
			image: file,
		}))
		trigger('image')
	}

	return (
		<div className="ju my-10 flex items-start max-sm:flex-col">
			<BackButton />
			<div className="flex flex-col items-center gap-3 max-sm:w-full">
				<h1 className="text-primary text-[28px] max-sm:text-center max-sm:text-[16px]">
					Create Token
				</h1>
				<div className="bg-blue-light flex w-[660px] flex-col gap-6 rounded-[40px] p-3 max-sm:w-full max-sm:rounded-[20px]">
					<div className="mx-auto w-2/5 max-sm:mt-5 max-sm:w-[70%]">
						<ol className="flex w-full items-center">
							<li className="flex w-full items-center text-[#0F1B34] after:inline-block after:h-1 after:w-full after:border-4 after:border-b after:border-[#D0D3D9] after:content-['']">
								<span className="bg-primary flex size-10 shrink-0 items-center justify-center rounded-full max-sm:size-7 max-sm:text-[12px]">
									1
								</span>
							</li>
							<li className="flex w-full items-center text-[#0F1B34] after:inline-block after:h-1 after:w-full after:border-4 after:border-b after:border-[#D0D3D9] after:content-['']">
								<span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[#D0D3D9] max-sm:size-7 max-sm:text-[12px]">
									2
								</span>
							</li>
							<li className="flex w-0 items-center text-[#0F1B34] max-sm:w-auto">
								<span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[#D0D3D9] max-sm:size-7 max-sm:text-[12px]">
									3
								</span>
							</li>
						</ol>
					</div>
					{launchpadEnabled() && (
						<SegmentedControl<LaunchMode>
							value={mode}
							onChange={setMode}
							options={[
								{ value: 'curve', label: 'Launch on curve', hint: 'gas-sponsored · lists on RivrDEX' },
								{ value: 'classic', label: 'Classic VFT', hint: 'you set supply and roles' },
							]}
						/>
					)}
					<h3 className="text-center uppercase">Token Details</h3>
					<form
						className="font-poppins flex flex-col gap-5"
						onSubmit={handleSubmit(onSubmit)}
					>
						<div className="flex flex-col gap-2">
							<Controller
								name="name"
								control={control}
								render={({ field, fieldState: { error } }) => (
									<Input
										{...field}
										label="Token Name"
										placeholder="My Vara Coin"
										error={error?.message}
									/>
								)}
							/>
						</div>

						<div className="flex justify-between gap-5">
							<div className="flex w-full flex-col gap-2">
								<Controller
									name="symbol"
									control={control}
									render={({ field, fieldState: { error } }) => (
										<Input
											{...field}
											label="Symbol"
											placeholder="HUM"
											error={error?.message}
										/>
									)}
								/>
							</div>
							{!curve && (
							<div className="flex w-full flex-col gap-2">
								<Controller
									name="decimals"
									control={control}
									render={({ field, fieldState: { error } }) => (
										<Input
											{...field}
											label="Decimals"
											placeholder="18"
											type="number"
											onChange={(e) => {
												const value = e.target.value
												field.onChange(value ? parseInt(value) : null)
											}}
											error={
												touchedFields.decimals || errors.decimals
													? errors.decimals?.message || error?.message
													: ''
											}
											tooltip="The number of decimals for token"
										/>
									)}
								/>
							</div>
							)}
						</div>
						{curve && (
							<div className="flex items-center gap-2 text-sm text-[#A4AAB6]">
								Supply 1,000,000,000 · 18 decimals · fixed by the curve
								<TooltipContainer
									trigger={<Sprite name="question" className="size-4 text-[#FDFDFD]/[40%]" />}
									delay={0}
								>
									<p className="max-w-60 text-center">
										80 % of the supply is sold on the bonding curve; 20 % is reserved for the RivrDEX pool. Every mint, burn and admin role is renounced at graduation.
									</p>
								</TooltipContainer>
							</div>
						)}

						<div className="flex flex-col gap-2">
							<label htmlFor="image-upload" className="font-poppins text-sm">
								Image
							</label>
							<input
								name="image"
								id="image-upload"
								type="file"
								accept="image/*"
								onChange={(e) => handleFileChange(e)}
								className="block w-full text-sm text-gray-500 file:mr-4 file:rounded-full file:border-0 file:bg-blue-50 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-blue-700 hover:file:bg-blue-100"
							/>
							{errors.image && (
								<p className="mt-1 text-xs text-red-500">
									{errors.image.message?.toString()}
								</p>
							)}
						</div>

						{!curve && (
						<div className="flex justify-between gap-5 max-sm:flex-col">
							<div className="flex w-full flex-col gap-2">
								<Controller
									name="initial_supply"
									control={control}
									render={({ field, fieldState: { error } }) => (
										<Input
											{...field}
											label="Initial Supply"
											placeholder="Initial number of your tokens"
											type="number"
											onChange={(e) => {
												const value = e.target.value
												field.onChange(value ? parseInt(value) : null)
											}}
											error={
												touchedFields.initial_supply || errors.initial_supply
													? errors.initial_supply?.message || error?.message
													: ''
											}
											tooltip="The number of created tokens"
										/>
									)}
								/>
							</div>
							<div className="flex w-full flex-col gap-2">
								<Controller
									name="max_supply"
									control={control}
									render={({ field, fieldState: { error } }) => (
										<Input
											{...field}
											label="Max Supply"
											placeholder="Total number of your tokens"
											error={
												touchedFields.max_supply || errors.max_supply
													? errors.max_supply?.message || error?.message
													: ''
											}
											type="number"
											onChange={(e) => {
												const value = e.target.value
												field.onChange(value ? parseInt(value) : null)
											}}
											tooltip="The maximum number of tokens"
										/>
									)}
								/>
							</div>
						</div>
						)}

						<div className="flex justify-between gap-5 max-sm:flex-col">
							<div className="flex w-full flex-col gap-2">
								<Controller
									name="external_links.website"
									control={control}
									render={({ field, fieldState: { error } }) => (
										<Input
											{...field}
											label="Website (optional)"
											placeholder="Add a link to website"
											error={error?.message}
										/>
									)}
								/>
							</div>
							<div className="flex w-full flex-col gap-2">
								<Controller
									name="external_links.telegram"
									control={control}
									render={({ field, fieldState: { error } }) => (
										<Input
											{...field}
											label="Telegram (optional)"
											placeholder="Add @username or link"
											error={error?.message}
										/>
									)}
								/>
							</div>
						</div>

						<div className="flex justify-between gap-5 max-sm:flex-col">
							<div className="flex w-full flex-col gap-2">
								<Controller
									name="external_links.twitter"
									control={control}
									render={({ field, fieldState: { error } }) => (
										<Input
											{...field}
											label="Twitter (optional)"
											placeholder="Add @username or link"
											error={error?.message}
										/>
									)}
								/>
							</div>
							<div className="flex w-full flex-col gap-2">
								<Controller
									name="external_links.discord"
									control={control}
									render={({ field, fieldState: { error } }) => (
										<Input
											{...field}
											label="Discord (optional)"
											placeholder="Add a link to Discord"
											error={error?.message}
										/>
									)}
								/>
							</div>
						</div>

						<div className="flex justify-between gap-5">
							<div className="flex w-full flex-col gap-2">
								<Controller
									name="external_links.tokenomics"
									control={control}
									render={({ field, fieldState: { error } }) => (
										<Input
											{...field}
											label="Tokenomics (optional)"
											placeholder="Add a link to tokenomics"
											error={error?.message}
										/>
									)}
								/>
							</div>
						</div>

						<div className="flex flex-col gap-2">
							<Controller
								name="description"
								control={control}
								render={({ field, fieldState: { error } }) => (
									<>
										<InputArea
											{...field}
											label="Description"
											placeholder="Tell people more about your token"
											error={error?.message}
										/>
										<span
											className={cn(
												'text-right text-[13px] text-[#767F92]',
												error?.message && 'text-[#FF4F4F]'
											)}
										>
											{field?.value?.length || 0}
											/500
										</span>
									</>
								)}
							/>
						</div>

						<button
							type="submit"
							className="font-ps2p hover:bg-primary mx-auto rounded-lg bg-[#D0D3D9] px-35 py-3 text-black max-sm:mb-5 max-sm:w-full max-sm:px-0"
						>
							Next
						</button>
					</form>
				</div>
			</div>
		</div>
	)
}
