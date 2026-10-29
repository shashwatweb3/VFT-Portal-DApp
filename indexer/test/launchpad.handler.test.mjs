// Pure-logic tests for the launchpad handler helpers (node --test, no DB needed).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bucketStart, candleId, foldCandle, progressBps, tradeId } from '../lib/processing/launchpad/launchpad.handler.js'

test('trade and candle ids are deterministic', () => {
  assert.equal(tradeId('0xab', 7), '0xab-7')
  const t = new Date('2026-10-19T12:34:56.789Z')
  assert.equal(bucketStart(t, 60).toISOString(), '2026-10-19T12:34:00.000Z')
  assert.equal(bucketStart(t, 3600).toISOString(), '2026-10-19T12:00:00.000Z')
  assert.equal(candleId('0xab', 60, bucketStart(t, 60).getTime()), `0xab-60-${Date.parse('2026-10-19T12:34:00Z')}`)
})

test('candles fold open/high/low/close/volume', () => {
  let c = foldCandle(undefined, 10n, 5n)
  assert.deepEqual(c, { open: 10n, high: 10n, low: 10n, close: 10n, volumeVara: 5n, trades: 1 })
  c = foldCandle(c, 14n, 1n)
  c = foldCandle(c, 8n, 2n)
  assert.deepEqual(c, { open: 10n, high: 14n, low: 8n, close: 8n, volumeVara: 8n, trades: 3 })
})

test('progress is basis points of the curve supply', () => {
  assert.equal(progressBps(0n, 800n), 0)
  assert.equal(progressBps(400n, 800n), 5000)
  assert.equal(progressBps(800n, 800n), 10000)
  assert.equal(progressBps(1n, 0n), 0)
})
