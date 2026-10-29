import { readFileSync, writeFileSync, existsSync } from 'node:fs'

/**
 * One voucher per address per window. Persisted to a JSON file so a restart does not reset
 * the limit (the spam this guards against is cheap to retry).
 */
export class IssueLimiter {
	private issued: Record<string, { at: number; voucherId: string }> = {}

	constructor(
		private readonly windowMs: number,
		private readonly stateFile?: string,
		private readonly now: () => number = Date.now
	) {
		if (stateFile && existsSync(stateFile)) {
			this.issued = JSON.parse(readFileSync(stateFile, 'utf8'))
		}
	}

	/** Milliseconds until `address` may receive another voucher; 0 when allowed now. */
	retryAfterMs(address: string): number {
		const last = this.issued[address.toLowerCase()]
		if (!last) return 0
		return Math.max(0, last.at + this.windowMs - this.now())
	}

	record(address: string, voucherId: string) {
		this.issued[address.toLowerCase()] = { at: this.now(), voucherId }
		if (this.stateFile) writeFileSync(this.stateFile, JSON.stringify(this.issued, null, 2))
	}

	forget(address: string) {
		delete this.issued[address.toLowerCase()]
		if (this.stateFile) writeFileSync(this.stateFile, JSON.stringify(this.issued, null, 2))
	}

	lastVoucher(address: string): string | undefined {
		return this.issued[address.toLowerCase()]?.voucherId
	}
}

/** Accepts SS58 or 0x-hex 32-byte addresses; returns the 0x hex public key or undefined. */
export function normaliseAddress(input: unknown, decode: (a: string) => Uint8Array): `0x${string}` | undefined {
	if (typeof input !== 'string' || input.length < 40 || input.length > 70) return undefined
	try {
		const bytes = decode(input)
		if (bytes.length !== 32) return undefined
		return `0x${Buffer.from(bytes).toString('hex')}`
	} catch {
		return undefined
	}
}

/** At most `max` events per key in a sliding window; old entries are pruned on every call. */
export class SlidingCap {
	private events = new Map<string, number[]>()

	constructor(
		private readonly windowMs: number,
		private readonly max: number,
		private readonly now: () => number = Date.now
	) {}

	allow(key: string): boolean {
		const t = this.now()
		const recent = (this.events.get(key) ?? []).filter((x) => x > t - this.windowMs)
		if (recent.length >= this.max) {
			this.events.set(key, recent)
			return false
		}
		recent.push(t)
		this.events.set(key, recent)
		if (this.events.size > 10_000) {
			for (const [k, v] of this.events) if (!v.some((x) => x > t - this.windowMs)) this.events.delete(k)
		}
		return true
	}
}
