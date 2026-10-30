import { HexString } from '@gear-js/api'
import { AlertContainerFactory } from '@gear-js/react-hooks'
import clsx, { ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { ADDRESS } from './consts'
import { assertWritesEnabled } from './staging'

export const copyToClipboard = async ({
	alert,
	value,
	successfulText,
}: {
	alert?: AlertContainerFactory
	value: string
	successfulText?: string
}) => {
	const onSuccess = () => {
		if (alert) {
			alert.success(successfulText || 'Copied')
		}
	}
	const onError = () => {
		if (alert) {
			alert.error('Copy error')
		}
	}

	function unsecuredCopyToClipboard(text: string) {
		const textArea = document.createElement('textarea')
		textArea.value = text
		document.body.appendChild(textArea)
		textArea.focus()
		textArea.select()
		try {
			document.execCommand('copy')
			onSuccess()
		} catch (err) {
			console.error('Unable to copy to clipboard', err)
			onError()
		}
		document.body.removeChild(textArea)
	}

	if (window.isSecureContext && navigator.clipboard) {
		navigator.clipboard
			.writeText(value)
			.then(() => onSuccess())
			.catch(() => onError())
	} else {
		unsecuredCopyToClipboard(value)
	}
}

export const isMobileDevice = () =>
	/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
		navigator.userAgent
	)

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs))
}

export const prettyWord = (word: string, length: number = 8) => {
	return word.slice(0, length) + '...' + word.slice(-4)
}

export const isValidHexString = (value: string): value is HexString => {
	return /^0x[0-9A-Fa-f]+$/.test(value)
}

// TODO: remove
export function compactFormatNumber(
	num: number | bigint,
	options: Intl.NumberFormatOptions = {
		notation: 'compact',
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	}
) {
	return Intl.NumberFormat('en-US', options).format(num)
}

export const getGatewayUrl = (ipfsUrl: string) => {
	const ipfsHash = ipfsUrl.split('ipfs://')[1]
	return `${ADDRESS.IPFS_GETAWAY}/${ipfsHash}`
}

export const uploadToIpfs = async (files: File[]) => {
	assertWritesEnabled()
	const formData = new FormData()
	files.forEach((file) => formData.append('file', file))

	const response = await fetch(ADDRESS.IPFS_UPLOAD, {
		method: 'POST',
		body: formData,
	})
	if (!response.ok) throw new Error(response.statusText)

	const result = await (response.json() as Promise<
		Record<'ipfsHash', string>[]
	>)
	return result.map(({ ipfsHash }) => `ipfs://${ipfsHash}`)
}

export function parseUnits(value: string, decimals: number) {
	if (!/^(-?)([0-9]*)\.?([0-9]*)$/.test(value))
		throw new Error(`Number \`${value}\` is not a valid decimal number.`)

	let [integer, fraction = '0'] = value.split('.')

	const negative = integer.startsWith('-')
	if (negative) integer = integer.slice(1)

	// trim trailing zeros.
	fraction = fraction.replace(/(0+)$/, '')

	// round off if the fraction is larger than the number of decimals.
	if (decimals === 0) {
		if (Math.round(Number(`.${fraction}`)) === 1)
			integer = `${BigInt(integer) + BigInt(1)}`
		fraction = ''
	} else if (fraction.length > decimals) {
		const [left, unit, right] = [
			fraction.slice(0, decimals - 1),
			fraction.slice(decimals - 1, decimals),
			fraction.slice(decimals),
		]

		const rounded = Math.round(Number(`${unit}.${right}`))
		if (rounded > 9)
			fraction = `${BigInt(left) + BigInt(1)}0`.padStart(left.length + 1, '0')
		else fraction = `${left}${rounded}`

		if (fraction.length > decimals) {
			fraction = fraction.slice(1)
			integer = `${BigInt(integer) + BigInt(1)}`
		}

		fraction = fraction.slice(0, decimals)
	} else {
		fraction = fraction.padEnd(decimals, '0')
	}

	return BigInt(`${negative ? '-' : ''}${integer}${fraction}`)
}

export function formatUnits(value: bigint, decimals: number) {
	let display = value.toString()

	const negative = display.startsWith('-')
	if (negative) display = display.slice(1)

	display = display.padStart(decimals, '0')

	let [integer, fraction] = [
		display.slice(0, display.length - decimals),
		display.slice(display.length - decimals),
	]
	fraction = fraction.replace(/(0+)$/, '')
	return `${negative ? '-' : ''}${integer || '0'}${
		fraction ? `.${fraction}` : ''
	}`
}

export function formatDistributedPercentage(
	distributed: string,
	maxSupply: string
) {
	const ZERO = BigInt(0)
	const PERCENT_MULTIPLIER = BigInt(100)
	const DECIMAL_SCALE = BigInt(100) // 2 digits after comma
	const DECIMAL_DIGITS = 2

	const distributedValue = BigInt(distributed)
	const maxSupplyValue = BigInt(maxSupply)

	if (distributedValue <= ZERO || maxSupplyValue <= ZERO) {
		console.warn(
			`Invalid values for distributed (${distributed}) or maxSupply (${maxSupply}). Both should be positive integers.`
		)

		return '0'
	}

	const scaledPercent =
		(distributedValue * PERCENT_MULTIPLIER * DECIMAL_SCALE) / maxSupplyValue

	if (scaledPercent === ZERO) return '0'

	const integerPart = scaledPercent / DECIMAL_SCALE
	const fractionalPart = scaledPercent % DECIMAL_SCALE

	if (fractionalPart === ZERO) return integerPart.toString()

	return `${integerPart}.${fractionalPart
		.toString()
		.padStart(DECIMAL_DIGITS, '0')
		.replace(/0+$/, '')}`
}
