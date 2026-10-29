import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeAddress } from '@polkadot/util-crypto'
import { IssueLimiter, SlidingCap, normaliseAddress } from '../src/rate-limit.ts'
import { Backoff, decide, withTimeout } from '../src/keeper.ts'

const HOUR = 3600_000

test('limiter allows one voucher per address per window', () => {
	let now = 1_000_000
	const limiter = new IssueLimiter(24 * HOUR, undefined, () => now)
	assert.equal(limiter.retryAfterMs('0xAB'), 0)
	limiter.record('0xAB', '0xv1')
	assert.equal(limiter.retryAfterMs('0xab'), 24 * HOUR, 'case-insensitive')
	now += 23 * HOUR
	assert.equal(limiter.retryAfterMs('0xab'), HOUR)
	now += HOUR
	assert.equal(limiter.retryAfterMs('0xab'), 0)
	assert.equal(limiter.lastVoucher('0xAB'), '0xv1')
})

test('addresses normalise from SS58 and hex, and reject junk', () => {
	const alice = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY'
	const hex = normaliseAddress(alice, (a) => decodeAddress(a))
	assert.equal(hex, '0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d')
	assert.equal(normaliseAddress(hex, (a) => decodeAddress(a)), hex)
	assert.equal(normaliseAddress('nope', (a) => decodeAddress(a)), undefined)
	assert.equal(normaliseAddress(42, (a) => decodeAddress(a)), undefined)
})

test('keeper graduates ready launches and unwinds stale or dead ones', () => {
	const base = {
		step: 'WrapVara',
		ready_at: 100,
		fail_retryable: true,
		failed_since: null,
		graduation_timeout_blocks: 1000,
		busy: null,
		lock: false,
		lock_expires_at: 0,
	}
	assert.equal(decide({ ...base, state: 'Trading' }, 150), 'none')
	assert.equal(decide({ ...base, state: 'Ready' }, 150), 'graduate')
	assert.equal(decide({ ...base, state: 'Ready' }, 1100), 'unwind')
	assert.equal(decide({ ...base, state: 'Graduating' }, 150), 'graduate')
	assert.equal(decide({ ...base, state: 'Graduated' }, 150), 'none')
	// Failures: retried until the contract's unwind delay has passed, then unwound if early.
	const failed = { ...base, state: 'Failed', step: 'FindOrCreatePair', failed_since: 200 }
	assert.equal(decide(failed, 250), 'graduate')
	assert.equal(decide(failed, 1200), 'unwind')
	assert.equal(decide({ ...failed, fail_retryable: false }, 250), 'none')
	assert.equal(decide({ ...failed, step: 'AddLiquidity' }, 5000), 'graduate', 'late steps never unwind')
	// Locks: held until they expire, then the step is resumed.
	assert.equal(decide({ ...base, state: 'Graduating', lock: true, lock_expires_at: 400 }, 150), 'none')
	assert.equal(decide({ ...base, state: 'Graduating', lock: true, lock_expires_at: 400 }, 400), 'graduate')
	// Trades in flight: reconciled once stuck or expired.
	const busy = { ...base, state: 'Trading', busy: { stuck: false, expires_at: 300 } }
	assert.equal(decide(busy, 150), 'none')
	assert.equal(decide(busy, 300), 'reconcile')
	assert.equal(decide({ ...busy, busy: { stuck: true, expires_at: 300 } }, 150), 'reconcile')
})

test('sliding caps limit per key and recover after the window', () => {
	let now = 0
	const cap = new SlidingCap(3600_000, 2, () => now)
	assert.equal(cap.allow('1.2.3.4'), true)
	assert.equal(cap.allow('1.2.3.4'), true)
	assert.equal(cap.allow('1.2.3.4'), false)
	assert.equal(cap.allow('5.6.7.8'), true, 'other keys unaffected')
	now += 3600_001
	assert.equal(cap.allow('1.2.3.4'), true)
})

test('keeper backoff grows and gives up', () => {
	let now = 0
	const b = new Backoff(1000, 60_000, 3, () => now)
	assert.equal(b.ready('t'), true)
	b.failed('t')
	assert.equal(b.ready('t'), false)
	now += 2000
	assert.equal(b.ready('t'), true)
	b.failed('t')
	b.failed('t')
	assert.equal(b.gaveUp('t'), true)
	now += 10_000_000
	assert.equal(b.ready('t'), false, 'stays parked after giving up')
	b.succeeded('t')
	assert.equal(b.ready('t'), true)
})

test('withTimeout rejects slow promises', async () => {
	await assert.rejects(withTimeout(new Promise(() => {}), 10, 'slow'), /timed out/)
	assert.equal(await withTimeout(Promise.resolve(7), 10, 'fast'), 7)
})
