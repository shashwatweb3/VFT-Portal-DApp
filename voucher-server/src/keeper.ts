import { GearApi, HexString } from '@gear-js/api'
import type { KeyringPair } from '@polkadot/keyring/types'
import { Sails } from 'sails-js'

export type LaunchView = {
	state: string
	step: string
	ready_at: number | string
	fail_retryable: boolean
	failed_since: number | string | null
	graduation_timeout_blocks: number | string
	busy: { stuck: boolean; expires_at: number | string } | null
	lock: boolean
	lock_expires_at: number | string
}

export type KeeperAction = 'graduate' | 'unwind' | 'reconcile' | 'none'

/** Mirrors `GradStep::is_unwindable`. */
const UNWINDABLE_STEPS = ['WrapVara', 'FindOrCreatePair', 'ApproveToken', 'ApproveWvara']

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout>
	return Promise.race([
		p,
		new Promise<T>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms)
		}),
	]).finally(() => clearTimeout(timer))
}

/** Exponential backoff per launch so a launch that keeps failing does not burn gas every tick. */
export class Backoff {
	private state = new Map<string, { failures: number; nextAt: number }>()

	constructor(
		private readonly baseMs = 6_000,
		private readonly maxMs = 3_600_000,
		private readonly maxFailures = 12,
		private readonly now: () => number = Date.now
	) {}

	ready(key: string): boolean {
		const s = this.state.get(key)
		return !s || (s.failures < this.maxFailures && this.now() >= s.nextAt)
	}

	failed(key: string) {
		const failures = (this.state.get(key)?.failures ?? 0) + 1
		const delay = Math.min(this.maxMs, this.baseMs * 2 ** failures)
		this.state.set(key, { failures, nextAt: this.now() + delay })
	}

	succeeded(key: string) {
		this.state.delete(key)
	}

	gaveUp(key: string) {
		return (this.state.get(key)?.failures ?? 0) >= this.maxFailures
	}
}

/**
 * What the keeper should do for one launch. Pure so it can be tested without a chain.
 * Graduation is permissionless; the keeper exists only so nobody has to remember to call it.
 */
export function decide(launch: LaunchView, head: number): KeeperAction {
	// A trade whose reply timed out, or whose message died after sending, waits for Reconcile.
	if (launch.busy) return launch.busy.stuck || head >= Number(launch.busy.expires_at) ? 'reconcile' : 'none'
	// A lock past its expiry was abandoned by a trapped message; the next call resumes the step.
	if (launch.lock && head < Number(launch.lock_expires_at)) return 'none'
	const timeout = Number(launch.graduation_timeout_blocks)
	switch (launch.state) {
		case 'Ready':
			return head >= Number(launch.ready_at) + timeout ? 'unwind' : 'graduate'
		case 'Graduating':
			return 'graduate'
		case 'Failed': {
			// The contract only allows an early unwind once the failure has lasted the timeout;
			// until then a forced failure is simply retried.
			const unwindable =
				UNWINDABLE_STEPS.includes(launch.step) &&
				launch.failed_since !== null &&
				head >= Number(launch.failed_since) + timeout
			if (unwindable) return 'unwind'
			return launch.fail_retryable ? 'graduate' : 'none'
		}
		default:
			return 'none'
	}
}

const FN: Record<Exclude<KeeperAction, 'none'>, 'Graduate' | 'Unwind' | 'Reconcile'> = {
	graduate: 'Graduate',
	unwind: 'Unwind',
	reconcile: 'Reconcile',
}
const PAGE = 100

export class Keeper {
	private running = false
	private readonly backoff = new Backoff()

	constructor(
		private readonly api: GearApi,
		private readonly sails: Sails,
		private readonly signer: KeyringPair,
		private readonly log: (msg: string) => void = console.log
	) {}

	private get svc() {
		return this.sails.services.Launchpad
	}

	private async send(fn: 'Graduate' | 'Unwind' | 'Reconcile', token: HexString) {
		const tx = this.svc.functions[fn](token)
		tx.withAccount(this.signer)
		tx.withGas(700_000_000_000n)
		const { response } = await withTimeout(tx.signAndSend(), 60_000, `${fn} submit`)
		return withTimeout(response(), 120_000, `${fn} reply`)
	}

	/** One pass over every launch; returns the actions taken. */
	async tick(): Promise<Array<{ token: HexString; action: KeeperAction; result: unknown }>> {
		if (this.running) return []
		this.running = true
		try {
			const head = (await this.api.rpc.chain.getHeader()).number.toNumber()
			const count = Number(await this.svc.queries.LaunchCount().call())
			const tokens: HexString[] = []
			for (let offset = 0; offset < count; offset += PAGE) {
				tokens.push(...((await this.svc.queries.LaunchesPage(offset, PAGE).call()) as HexString[]))
			}
			const done: Array<{ token: HexString; action: KeeperAction; result: unknown }> = []
			for (const token of tokens) {
				const info = (await this.svc.queries.LaunchInfo(token).call()) as LaunchView | null
				if (!info) continue
				const action = decide(info, head)
				if (action === 'none' || !this.backoff.ready(token)) continue
				try {
					const result = (await this.send(FN[action], token)) as
						| { ok?: unknown; err?: unknown }
						| undefined
					if (result && 'err' in result) throw new Error(JSON.stringify(result.err))
					this.backoff.succeeded(token)
					this.log(`[keeper] ${action} ${token} -> ${JSON.stringify(result)}`)
					done.push({ token, action, result })
				} catch (e) {
					// One stuck launch must not block the others; retried with exponential backoff.
					this.backoff.failed(token)
					const tail = this.backoff.gaveUp(token) ? ' (giving up until restart; needs an operator)' : ''
					this.log(`[keeper] ${action} ${token} failed: ${String(e)}${tail}`)
				}
			}
			return done
		} finally {
			this.running = false
		}
	}
}
