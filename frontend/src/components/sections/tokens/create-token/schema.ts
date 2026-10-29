import { z } from 'zod'

const MAX_FILE_SIZE = 5000000
const ACCEPTED_IMAGE_TYPES = [
	'image/jpeg',
	'image/jpg',
	'image/png',
	'image/webp',
	'image/gif',
]

const optionalHttpsUrl = z.url({ protocol: /^https$/ }).or(z.literal(''))

const telegramUrl = z.url({
	protocol: /^https$/,
	hostname: /^(t\.me)$/,
})

const twitterUrl = z.url({
	protocol: /^https$/,
	hostname: /^(x\.com)$/,
})

const telegramUsername = z
	.string()
	.regex(/^@[A-Za-z][A-Za-z0-9_]{4,31}$/, {
		message:
			'Telegram username must start with @ and contain 5-32 letters, digits, or underscores',
	})
	.transform((value) => `https://t.me/${value.slice(1)}`)

const twitterUsername = z
	.string()
	.regex(/^@[A-Za-z0-9_]{1,15}$/, {
		message:
			'Twitter username must start with @ and contain up to 15 letters, digits, or underscores',
	})
	.transform((value) => `https://x.com/${value.slice(1)}`)

// related to: https://github.com/colinhacks/zod/issues/3675
const handleUnionError = (_: string, ctx: z.core.$RefinementCtx<string>) => {
	if (!ctx.issues.length) return

	ctx.issues = []

	ctx.addIssue({
		code: 'custom',
		message: 'Invalid URL or username',
	})
}

const telegramLinkSchema = z
	.union([telegramUrl, telegramUsername, z.literal('')])
	.superRefine(handleUnionError)

const twitterLinkSchema = z
	.union([twitterUrl, twitterUsername, z.literal('')])
	.superRefine(handleUnionError)

/** Field rules shared by both launch modes; cross-field checks live on each mode's schema. */
const tokenFields = z
	.object({
		name: z
			.string()
			.regex(/^([A-Za-z ]+)$/, { message: 'Only Latin letters are allowed' })
			.min(2, { message: 'Name must be at least 2 characters' })
			.max(10, { message: 'Name must be no more than 10 characters' }),
		symbol: z
			.string()
			.regex(/^[A-Za-z]+$/, { message: 'Only Latin letters are allowed' })
			.min(2, { message: 'Symbol must be at least 2 characters long' })
			.max(8, { message: 'Symbol must be no more than 8 characters long' }),
		decimals: z.nullable(
			z
				.number()
				.min(1, { message: 'Min number of decimals is 1' })
				.max(100, { message: 'Max number of decimals is 100' })
				.positive()
				.nullable()
				.refine((val) => val !== null, { message: 'Required' })
				.transform((value) => value ?? null)
		),
		description: z
			.string()
			.regex(/^[\x00-\x7F]+$/, { message: 'Only Latin letters are allowed' })
			.min(2, { message: 'Description must be at least 2 characters long' })
			.max(500, {
				message: 'Description must be no more than 500 characters long',
			}),
		image: z
			.any()
			.refine((file) => file?.size > 0, 'Required image')
			.refine((file) => file?.size <= MAX_FILE_SIZE, `Max image size is 5MB.`)
			.refine(
				(file) => ACCEPTED_IMAGE_TYPES.includes(file?.type),
				'Only .jpg, .jpeg, .png and .webp .gif formats are supported.'
			)
			.transform((value) => value ?? null),

		external_links: z.object({
			website: optionalHttpsUrl,
			telegram: telegramLinkSchema,
			twitter: twitterLinkSchema,
			discord: optionalHttpsUrl,
			tokenomics: optionalHttpsUrl,
		}),

		initial_supply: z.nullable(
			z
				.number()
				.min(2, {
					message: 'Initial Supply must be at least 2 characters long',
				})
				.max(3000000000000, {
					message: 'Initial Supply must be no more than 3000000000000',
				})
				.positive()
				.nullable()
				.refine((val) => val !== null, { message: 'Required' })
				.transform((value) => value ?? null)
		),

		max_supply: z.nullable(
			z
				.number()
				.min(2, { message: 'Max Supply must be at least 2 characters long' })
				.max(3000000000000, {
					message: 'Max Supply must be no more than 3000000000000',
				})
				.positive()
				.nullable()
				.refine((val) => val !== null, { message: 'Required' })
				.transform((value) => value ?? null)
		),
	})

export const createTokenSchema = tokenFields
	.refine((data) => data.decimals && data.decimals > 0, {
		message: 'Decimals cannot be less than 0',
		path: ['decimals'],
	})
	.refine(
		(data) =>
			data.initial_supply &&
			data.max_supply &&
			data.initial_supply > 0 &&
			data.max_supply > 0 &&
			data.initial_supply <= data.max_supply,
		{
			message: 'Initial Supply cannot be greater than Max Supply',
			path: ['initial_supply'],
		}
	)
	.refine(
		(data) =>
			data.initial_supply &&
			data.max_supply &&
			data.initial_supply > 0 &&
			data.max_supply > 0 &&
			data.max_supply >= data.initial_supply,
		{
			message: 'Initial Supply cannot be greater than Max Supply',
			path: ['max_supply'],
		}
	)

export type ICreateTokenForm = z.infer<typeof createTokenSchema>

export const createTokenDefault: ICreateTokenForm = {
	name: '',
	symbol: '',
	decimals: null,
	image: null,
	description: '',
	external_links: {
		website: '',
		telegram: '',
		twitter: '',
		discord: '',
		tokenomics: '',
	},
	initial_supply: null,
	max_supply: null,
}

/** Curve launches fix supply and decimals in the launchpad; the creator may add a first buy. */
export const createCurveTokenSchema = tokenFields
	.omit({ decimals: true, initial_supply: true, max_supply: true })
	.extend({
		first_buy: z
			.string()
			.regex(/^\d*(\.\d{0,12})?$/, { message: 'Enter a VARA amount' })
			.optional()
			.or(z.literal('')),
		accept_terms: z.boolean().refine((v) => v, { message: 'Please accept the terms' }),
	})

export type ICreateCurveTokenForm = z.infer<typeof createCurveTokenSchema>

export const createCurveTokenDefault: ICreateCurveTokenForm = {
	name: '',
	symbol: '',
	image: null,
	description: '',
	external_links: {
		website: '',
		telegram: '',
		twitter: '',
		discord: '',
		tokenomics: '',
	},
	first_buy: '',
	accept_terms: false,
}

/** The wizard keeps one form state; classic-only fields are simply unused on the curve path. */
export type ICreateAnyTokenForm = ICreateTokenForm & Partial<Pick<ICreateCurveTokenForm, 'first_buy' | 'accept_terms'>>
