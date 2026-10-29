'use client'

import { useApi } from '@gear-js/react-hooks'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { GearApi, HexString } from '@gear-js/api'
import { TransactionBuilder, ZERO_ADDRESS } from 'sails-js'
import { useCallback, useMemo } from 'react'

import { CURVE, LAUNCHPAD } from '@/lib/consts'
import { useAuth } from '@/lib/hooks/use-auth'
import { LaunchpadProgram, type Launch, type Quote, type TokenMeta, type TradeReceipt } from './launchpad'
import { SailsProgram as VftProgram } from './meme-ft'
import { termsHash } from '@/lib/curve'

export const launchpadEnabled = () => LAUNCHPAD.ADDRESS.length === 66

type Signer = { address: string; signer: unknown }

export const vouchersEnabled = () => LAUNCHPAD.VOUCHER_API.length > 0

/**
 * Returns a usable voucher for `address`: an unexpired one it already holds for the launchpad
 * (so a cancelled signature does not burn the day's sponsorship), or a fresh one from the
 * voucher service. Undefined means the user pays gas.
 */
async function getVoucher(api: GearApi, address: string): Promise<HexString | undefined> {
	if (!vouchersEnabled()) return undefined
	try {
		const head = (await api.rpc.chain.getHeader()).number.toNumber()
		const existing = await api.voucher.getAllForAccount(address, LAUNCHPAD.ADDRESS)
		for (const [id, details] of Object.entries(existing)) {
			if (Number(details.expiry) > head + 5) return id as HexString
		}
	} catch {
		// fall through to the service
	}
	try {
		const res = await fetch(`${LAUNCHPAD.VOUCHER_API}/voucher`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ address }),
		})
		if (!res.ok) return undefined
		const data = (await res.json()) as { voucherId?: HexString }
		return data.voucherId
	} catch {
		return undefined
	}
}

export type LaunchResult = { token: HexString; sponsored: boolean; firstBuySkipped?: string }

async function run<T>(
	tx: TransactionBuilder<T>,
	account: Signer,
	opts: { value?: bigint; voucher?: HexString } = {}
): Promise<T> {
	tx.withAccount(account.address, { signer: account.signer as never })
	if (opts.value && opts.value > BigInt(0)) tx.withValue(opts.value)
	if (opts.voucher) tx.withVoucher(opts.voucher)
	await tx.calculateGas(true, 15)
	const { response } = await tx.signAndSend()
	return response()
}

function unwrap<T>(res: { ok: T } | { err: unknown }): T {
	if ('ok' in res) return res.ok
	throw new Error(describeError((res as { err: unknown }).err))
}

export function describeError(err: unknown): string {
	if (typeof err === 'string') return err
	if (err && typeof err === 'object') {
		const [key, value] = Object.entries(err as Record<string, unknown>)[0] ?? ['Error', null]
		if (value && typeof value === 'object' && 'reason' in (value as object)) {
			const v = value as { step?: string; reason?: string }
			return `${key} at ${v.step}: ${v.reason}`
		}
		return value ? `${key}: ${String(value)}` : key
	}
	return String(err)
}

export const useLaunchpad = () => {
	const { api, isApiReady } = useApi()
	const { walletAccount: account } = useAuth()
	const queryClient = useQueryClient()

	const program = useMemo(() => {
		if (!api || !launchpadEnabled()) return undefined
		return new LaunchpadProgram(api, LAUNCHPAD.ADDRESS)
	}, [api])

	const deadline = useCallback(async () => {
		if (!api) return 4_294_967_295
		const header = await api.rpc.chain.getHeader()
		return header.number.toNumber() + CURVE.DEADLINE_BLOCKS
	}, [api])

	const requireAccount = () => {
		if (!account) throw new Error('Connect a wallet first')
		if (!program) throw new Error('Launchpad is not configured')
		return { account, program }
	}

	const invalidate = (token?: HexString) => {
		queryClient.invalidateQueries({ queryKey: ['launch', token] })
		queryClient.invalidateQueries({ queryKey: ['quote', token] })
		queryClient.invalidateQueries({ queryKey: ['vft-balance', token] })
		queryClient.invalidateQueries({ queryKey: ['pending-payout', token] })
	}

	const launch = useCallback(
		async (meta: TokenMeta, firstBuy: bigint, minTokensOut: bigint): Promise<LaunchResult> => {
			const { account, program } = requireAccount()
			const voucher = api ? await getVoucher(api, account.address) : undefined
			const hash = await termsHash(LAUNCHPAD.TERMS_VERSION)
			const res = await run(program.launchpad.launch(meta, hash, minTokensOut), account, {
				value: firstBuy,
				voucher,
			})
			if ('ok' in res) {
				const token = res.ok as HexString
				invalidate(token)
				return { token, sponsored: !!voucher }
			}
			const err = res.err as Record<string, unknown>
			if (err && typeof err === 'object' && 'firstBuySkipped' in err) {
				// The token was created; only the first buy was refunded. Find it by creator + name.
				const count = await program.launchpad.launchCount().withAddress(ZERO_ADDRESS).call()
				const from = Math.max(0, Number(count) - 25)
				const tokens = await program.launchpad.launchesPage(from, 25).withAddress(ZERO_ADDRESS).call()
				for (const t of [...tokens].reverse()) {
					const info = await program.launchpad.launchInfo(t).withAddress(ZERO_ADDRESS).call()
					if (info && info.creator === account.decodedAddress && info.name === meta.name) {
						invalidate(t as HexString)
						return { token: t as HexString, sponsored: !!voucher, firstBuySkipped: String(err.firstBuySkipped) }
					}
				}
			}
			throw new Error(describeError(res.err))
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[account, program, api]
	)

	const buy = useCallback(
		async (token: HexString, vara: bigint, minTokensOut: bigint): Promise<TradeReceipt> => {
			const { account, program } = requireAccount()
			const res = await run(program.launchpad.buy(token, minTokensOut, await deadline()), account, {
				value: vara,
			})
			invalidate(token)
			return unwrap(res)
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[account, program, deadline]
	)

	const sell = useCallback(
		async (
			token: HexString,
			amount: bigint,
			minVaraOut: bigint
		): Promise<{ receipt: TradeReceipt; deferred: boolean }> => {
			const { account, program } = requireAccount()
			if (!api) throw new Error('Api is not ready')
			// Approve first (separate signature); the launchpad pulls with TransferFrom.
			const vft = new VftProgram(api, token)
			const allowance = await vft.vft
				.allowance(account.decodedAddress, LAUNCHPAD.ADDRESS)
				.withAddress(ZERO_ADDRESS)
				.call()
			if (BigInt(allowance) < amount) {
				await run(vft.vft.approve(LAUNCHPAD.ADDRESS, amount), account)
			}
			const res = await run(program.launchpad.sell(token, amount, minVaraOut, await deadline()), account)
			invalidate(token)
			const receipt = unwrap(res)
			// Below the existential deposit the contract holds the payout for a later claim.
			const deferred = BigInt(receipt.vara) < api.existentialDeposit.toBigInt()
			return { receipt, deferred }
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[account, program, api, deadline]
	)

	const graduate = useCallback(
		async (token: HexString) => {
			const { account, program } = requireAccount()
			const res = await run(program.launchpad.graduate(token), account)
			invalidate(token)
			return unwrap(res)
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[account, program]
	)

	const unwind = useCallback(
		async (token: HexString) => {
			const { account, program } = requireAccount()
			const res = await run(program.launchpad.unwind(token), account)
			invalidate(token)
			return unwrap(res)
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[account, program]
	)

	const claimCreatorFees = useCallback(
		async (token: HexString) => {
			const { account, program } = requireAccount()
			const res = await run(program.launchpad.claimCreatorFees(token), account)
			invalidate(token)
			return BigInt(unwrap(res))
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[account, program]
	)

	const claimPayout = useCallback(
		async (token: HexString) => {
			const { account, program } = requireAccount()
			const res = await run(program.launchpad.claimPayout(token), account)
			invalidate(token)
			return BigInt(unwrap(res))
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[account, program]
	)

	return {
		isReady: isApiReady && !!program,
		program,
		launch,
		buy,
		sell,
		graduate,
		unwind,
		claimCreatorFees,
		claimPayout,
	}
}

/** Live launch state straight from the chain (never from the indexer). */
export const useLaunchInfo = (token: HexString | undefined, enabled = true) => {
	const { program, isReady } = useLaunchpad()
	return useQuery({
		queryKey: ['launch', token],
		enabled: enabled && isReady && !!token,
		refetchInterval: CURVE.QUOTE_POLL_MS,
		queryFn: async (): Promise<Launch | null> => {
			const info = await program!.launchpad.launchInfo(token!).withAddress(ZERO_ADDRESS).call()
			return info ?? null
		},
	})
}

export const useQuote = (
	token: HexString | undefined,
	side: 'buy' | 'sell',
	amount: bigint,
	enabled = true
) => {
	const { program, isReady } = useLaunchpad()
	return useQuery({
		queryKey: ['quote', token, side, amount.toString()],
		enabled: enabled && isReady && !!token && amount > BigInt(0),
		refetchInterval: CURVE.QUOTE_POLL_MS,
		queryFn: async (): Promise<Quote> => {
			const svc = program!.launchpad
			const q = side === 'buy' ? svc.quoteBuy(token!, amount) : svc.quoteSell(token!, amount)
			return q.withAddress(ZERO_ADDRESS).call()
		},
	})
}

export const useVftBalance = (token: HexString | undefined, owner: HexString | undefined) => {
	const { api, isApiReady } = useApi()
	return useQuery({
		queryKey: ['vft-balance', token, owner],
		enabled: isApiReady && !!api && !!token && !!owner,
		refetchInterval: CURVE.QUOTE_POLL_MS,
		queryFn: async () => {
			const vft = new VftProgram(api!, token!)
			return BigInt(await vft.vft.balanceOf(owner!).withAddress(ZERO_ADDRESS).call())
		},
	})
}

export const useVaraBalance = (address: string | undefined) => {
	const { api, isApiReady } = useApi()
	return useQuery({
		queryKey: ['vara-balance', address],
		enabled: isApiReady && !!api && !!address,
		refetchInterval: CURVE.QUOTE_POLL_MS,
		queryFn: async () => (await api!.balance.findOut(address!)).toBigInt(),
	})
}

export const useRaiseTarget = () => {
	const { program, isReady } = useLaunchpad()
	return useQuery({
		queryKey: ['launchpad-config'],
		enabled: isReady,
		refetchInterval: 15_000,
		queryFn: async () => {
			const cfg = await program!.launchpad.config().withAddress(ZERO_ADDRESS).call()
			return {
				raiseTargetVara: BigInt(cfg.raise_target_vara),
				feeBps: Number(cfg.fee_bps),
				creatorFeeBps: Number(cfg.creator_fee_bps),
				minTradeVara: BigInt(cfg.min_trade_vara),
				totalSupply: BigInt(cfg.total_supply),
				curveSupply: BigInt(cfg.curve_supply),
				decimals: Number(cfg.token_decimals),
				graduationTimeoutBlocks: Number(cfg.graduation_timeout_blocks),
				headBlock: (await program!.api.rpc.chain.getHeader()).number.toNumber(),
			}
		},
	})
}

/** Sell proceeds held for `who` because they were below the existential deposit. */
export const usePendingPayout = (token: HexString | undefined, who: HexString | undefined) => {
	const { program, isReady } = useLaunchpad()
	return useQuery({
		queryKey: ['pending-payout', token, who],
		enabled: isReady && !!token && !!who,
		refetchInterval: CURVE.QUOTE_POLL_MS * 2,
		queryFn: async () => BigInt(await program!.launchpad.pendingPayout(token!, who!).withAddress(ZERO_ADDRESS).call()),
	})
}
