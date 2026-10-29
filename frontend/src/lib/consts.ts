import { HexString } from '@gear-js/api'

const publicEnv = (value: string | undefined, fallback: string) =>
	value && value.trim() ? value : fallback

export const ADDRESS = {
	NODE: publicEnv(
		process.env.NEXT_PUBLIC_NODE_ADDRESS,
		'wss://rpc.vara.network',
	),
	IPFS_UPLOAD: publicEnv(
		process.env.NEXT_PUBLIC_IPFS_UPLOAD_ADDRESS,
		'https://pinata-proxy.tokenator.club/files/upload',
	),
	IPFS_GETAWAY: publicEnv(
		process.env.NEXT_PUBLIC_IPFS_GETAWAY,
		'https://sapphire-advisory-bird-981.mypinata.cloud/ipfs',
	),
}

export const CONTRACT_ADDRESS = {
	ADDRESS: publicEnv(
		process.env.NEXT_PUBLIC_CONTRACT_ADDRESS,
		'0x729fa6dda815fd49bb4cae215a9904edd3c4d941ed51448eeca94ef2f69fd6a3',
	) as HexString,
}

export const EXPLORER = {
	BACK: publicEnv(
		process.env.NEXT_PUBLIC_EXPLORER,
		'https://explorer.tokenator.club/graphql',
	),
}

export const LAUNCHPAD = {
	ADDRESS: publicEnv(process.env.NEXT_PUBLIC_LAUNCHPAD_ADDRESS, '') as HexString,
	VOUCHER_API: publicEnv(process.env.NEXT_PUBLIC_VOUCHER_API, ''),
	RIVRDEX_APP: publicEnv(
		process.env.NEXT_PUBLIC_RIVRDEX_APP,
		'https://app.rivrdex.io',
	),
	/** Version string hashed into `terms_hash` on every launch. Bump when the terms change. */
	TERMS_VERSION: 'tokenator-curve-terms-v1',
}

/** True when this build points at a launchpad; every Curve Launch surface is gated on it. */
export const CURVE_ENABLED = (process.env.NEXT_PUBLIC_LAUNCHPAD_ADDRESS ?? '').trim().length === 66

export const CURVE = {
	VARA_DECIMALS: 12,
	TOKEN_DECIMALS: 18,
	/** Blocks a trade stays valid after signing (~3 s blocks). */
	DEADLINE_BLOCKS: 60,
	QUOTE_POLL_MS: 3000,
	/** Keep this much VARA aside for the existential deposit and gas. */
	KEEP_VARA: BigInt(2) * BigInt(10) ** BigInt(12),
}
