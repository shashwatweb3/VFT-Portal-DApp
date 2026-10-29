// Adversarial simulations against the compiled handlers with an in-memory Store that enforces FKs.
// Tests marked todo document CONFIRMED defects (they fail today; remove `todo` once fixed).
import { test } from 'node:test'
import assert from 'node:assert/strict'
process.env.RPC_ENDPOINT ??= 'ws://127.0.0.1:9944'
process.env.FACTORY_PROGRAM ??= '0x01'
const { LocalStorage } = await import('../lib/processing/storage/local.storage.js')
const { EntitiesService } = await import('../lib/processing/entities.service.js')
const { BatchService } = await import('../lib/processing/batch.service.js')
const { LaunchpadHandler } = await import('../lib/processing/launchpad/launchpad.handler.js')
const { TransferredHandler } = await import('../lib/processing/coin/transferred.handler.js')
const { EventsProcessing } = await import('../lib/processing/events.processing.js')
const { getLaunchpadEventsParser } = await import('../lib/types/launchpad.events.js')
const { Coin, CurveLaunch, CurveTrade, CurveCandle, AccountBalance, Factory, Transfer, MemcoinFactoryEvent } = await import('../lib/model/index.js')

const LP = '0x' + 'aa'.repeat(32), TOKEN = '0x' + '11'.repeat(32), PAIR = '0x' + 'bb'.repeat(32)
const A = '0x' + 'a1'.repeat(32), B = '0x' + 'b2'.repeat(32), CREATOR = '0x' + 'c3'.repeat(32)
const T0 = new Date('2026-10-19T12:00:00Z')
const info = (n, source = TOKEN) => ({ blockNumber: n, source, destination: '0x', messageId: '0x' + n.toString(16), txHash: '0x' + n.toString(16), timestamp: new Date(T0.getTime() + n * 1000) })

class FakeStore {
  tables = new Map()
  fkErrors = []
  t(cls) { const k = cls.name; if (!this.tables.has(k)) this.tables.set(k, new Map()); return this.tables.get(k) }
  has(cls, id) { return this.t(cls).has(id) }
  async save(x) {
    for (const e of Array.isArray(x) ? x : [x]) {
      const refs = { CurveLaunch: [['coin', Coin]], CurveTrade: [['launch', CurveLaunch]], CurveCandle: [['launch', CurveLaunch]], AccountBalance: [['coin', Coin]], Transfer: [['coin', Coin]] }[e.constructor.name] ?? []
      for (const [f, cls] of refs) if (e[f] && !this.has(cls, e[f].id) && !(this.pendingBatch ?? new Set()).has(cls.name + e[f].id)) this.fkErrors.push(`${e.constructor.name}.${f} -> ${e[f].id} not saved yet`)
      this.t(e.constructor).set(e.id, Object.assign(Object.create(Object.getPrototypeOf(e)), e))
    }
  }
  async findOne(cls, { where }) {
    const rows = [...this.t(cls).values()].filter((r) => Object.entries(where).every(([k, v]) => (v && typeof v === 'object' ? r[k]?.id === v.id : r[k] === v)))
    const r = rows[0]
    return r ? Object.assign(Object.create(Object.getPrototypeOf(r)), r) : undefined
  }
  async find(cls) { return [...this.t(cls).values()] }
  async remove() {}
}

async function mk(store = new FakeStore()) {
  const storage = new LocalStorage(store)
  storage.loadFactory = async () => { storage.setFactory(new Factory({ id: '0x01', address: '0x01', meta: '', coinMeta: '' })) }
  await storage.waitInit()
  const state = { store, storage }
  // each call = one processor batch
  state.batch = async (fn) => {
    storage.setStore(store)
    const svc = new EntitiesService(storage, new BatchService(store), {})
    await fn(svc)
    await svc.saveAll()
  }
  return state
}
const launched = { type: 'Launched', token: TOKEN, creator: CREATOR, name: 'N', symbol: 'S', decimals: 18, description: '', image: '', v0: 10n ** 12n, t0: 10n ** 27n, curveSupply: 8n * 10n ** 26n, poolTokens: 2n * 10n ** 26n, raiseTargetVara: 1000n }
const lp = new LaunchpadHandler(LP)
const xfer = (svc, n, from, to, amount) => new TransferredHandler().handle({ type: 'Transferred', from, to, amount }, info(n), svc)
const NULL = '0x' + '00'.repeat(32)
const trade = (type, seq, trader, vara, tokens, soldAfter) => ({ type, token: TOKEN, seq, trader, vara, tokens, fee: 1n, soldAfter, escrowAfter: 5n, priceAfterE18: 7n })

test('holders: pair-before-Graduated correction in one batch', async () => {
  const s = await mk()
  await s.batch(async (svc) => {
    await lp.handle(launched, info(1, LP), svc)
    await xfer(svc, 2, LP, CREATOR, 100n); await xfer(svc, 2, LP, A, 100n)
    await xfer(svc, 3, LP, PAIR, 1000n)
    await lp.handle({ type: 'Graduated', token: TOKEN, pair: PAIR, wvaraInPool: 1n, tokensInPool: 1n, lpBurned: 1n, rolesRenounced: true }, info(4, LP), svc)
  })
  const c = await s.store.findOne(Coin, { where: { id: TOKEN } })
  assert.equal(c.holders, 2)
})

test('holders: correction across batches and Graduated delivered twice', async () => {
  const s = await mk()
  await s.batch(async (svc) => { await lp.handle(launched, info(1, LP), svc); await xfer(svc, 2, LP, A, 100n); await xfer(svc, 3, LP, PAIR, 1000n) })
  const grad = { type: 'Graduated', token: TOKEN, pair: PAIR, wvaraInPool: 1n, tokensInPool: 1n, lpBurned: 1n, rolesRenounced: true }
  await s.batch(async (svc) => { await lp.handle(grad, info(4, LP), svc); await lp.handle(grad, info(4, LP), svc) })
  await s.batch(async (svc) => { await lp.handle(grad, info(5, LP), svc) })
  assert.equal((await s.store.findOne(Coin, { where: { id: TOKEN } })).holders, 1)
})

test('holders: pair drained to zero before Graduated, then Graduated', async () => {
  const s = await mk()
  await s.batch(async (svc) => {
    await lp.handle(launched, info(1, LP), svc)
    await xfer(svc, 2, LP, PAIR, 1000n); await xfer(svc, 3, PAIR, A, 1000n)
    await lp.handle({ type: 'Graduated', token: TOKEN, pair: PAIR, wvaraInPool: 1n, tokensInPool: 1n, lpBurned: 1n, rolesRenounced: true }, info(4, LP), svc)
  })
  assert.equal((await s.store.findOne(Coin, { where: { id: TOKEN } })).holders, 1)
})

test('holders: sell to zero then rebuy', async () => {
  const s = await mk()
  await s.batch(async (svc) => {
    await lp.handle(launched, info(1, LP), svc)
    await xfer(svc, 2, LP, A, 100n); await xfer(svc, 3, A, LP, 100n); await xfer(svc, 4, LP, A, 5n)
  })
  assert.equal((await s.store.findOne(Coin, { where: { id: TOKEN } })).holders, 1)
})

test('FK: Launched + Bought + candles in same batch saves without FK violation', async () => {
  const s = await mk()
  await s.batch(async (svc) => {
    await lp.handle(launched, info(1, LP), svc)
    await lp.handle(trade('Bought', 1, A, 10n, 100n, 100n), info(1, LP), svc)
    await lp.handle(trade('Bought', 2, B, 10n, 100n, 200n), info(1, LP), svc)
  })
  assert.deepEqual(s.store.fkErrors, [])
  const l = await s.store.findOne(CurveLaunch, { where: { id: TOKEN } })
  assert.equal(l.tradeCount, 2)
  assert.equal(s.store.t(CurveCandle).size, 4)
})

test('Reconciled after Ready must not flip READY back to TRADING (contract emits Bought, Ready, Reconciled)', async () => {
  const s = await mk()
  await s.batch(async (svc) => {
    await lp.handle(launched, info(1, LP), svc)
    await lp.handle({ type: 'TradeStuck', token: TOKEN, seq: 1 }, info(2, LP), svc)
    await lp.handle(trade('Bought', 1, A, 10n, 100n, 8n * 10n ** 26n), info(3, LP), svc)
    await lp.handle({ type: 'Ready', token: TOKEN, escrow: 5n, poolVara: 4n }, info(3, LP), svc)
    await lp.handle({ type: 'Reconciled', token: TOKEN, seq: 1, committed: true }, info(3, LP), svc)
  })
  assert.equal((await s.store.findOne(CurveLaunch, { where: { id: TOKEN } })).status, 'READY')
})

test('replaying the identical trade event twice must not double-count volume/tradeCount', async () => {
  const s = await mk()
  await s.batch(async (svc) => {
    await lp.handle(launched, info(1, LP), svc)
    await lp.handle(trade('Bought', 1, A, 10n, 100n, 100n), info(2, LP), svc)
    await lp.handle(trade('Bought', 1, A, 10n, 100n, 100n), info(2, LP), svc)
  })
  const l = await s.store.findOne(CurveLaunch, { where: { id: TOKEN } })
  assert.equal(l.tradeCount, 1); assert.equal(l.volumeVara, 10n)
})

test('classic path: self-transfer must not change balance', { todo: true }, async () => {
  const s = await mk()
  await s.batch(async (svc) => { await lp.handle(launched, info(1, LP), svc); await xfer(svc, 2, LP, A, 100n); await xfer(svc, 3, A, A, 40n) })
  const bal = [...s.store.t(AccountBalance).values()].find((b) => b.address === A)
  assert.equal(bal.balance, 100n)
})

test('zero-amount transfer from a non-holder must not decrement holders', { todo: true }, async () => {
  const s = await mk()
  await s.batch(async (svc) => { await lp.handle(launched, info(1, LP), svc); await xfer(svc, 2, LP, A, 100n); await xfer(svc, 3, B, A, 0n) })
  assert.equal((await s.store.findOne(Coin, { where: { id: TOKEN } })).holders, 1)
})

test('unknown token: trade / graduated / ready / transfer are ignored without throwing', async () => {
  const s = await mk()
  await s.batch(async (svc) => {
    await lp.handle(trade('Bought', 1, A, 1n, 1n, 1n), info(1, LP), svc)
    await lp.handle({ type: 'Graduated', token: TOKEN, pair: PAIR, wvaraInPool: 1n, tokensInPool: 1n, lpBurned: 1n, rolesRenounced: true }, info(2, LP), svc)
    await lp.handle({ type: 'Ready', token: TOKEN, escrow: 1n, poolVara: 1n }, info(3, LP), svc)
    await lp.handle({ type: 'Unwound', token: TOKEN, escrow: 1n }, info(3, LP), svc)
  })
  assert.equal(s.store.t(CurveLaunch).size, 0)
})

test('undecodable launchpad payloads never throw out of handleLaunchpadEvent', async () => {
  const s = await mk()
  const parser = await getLaunchpadEventsParser()
  const hex = (b) => '0x' + Buffer.from(b).toString('hex')
  const prefix = Buffer.concat([Buffer.from([9 << 2]), Buffer.from('Launchpad'), Buffer.from([8 << 2]), Buffer.from('Launched')])
  const cases = ['0x01', '0x00', '0xff'.padEnd(20, 'f'), hex(prefix), hex(Buffer.concat([prefix, Buffer.alloc(40, 1)])),
    hex(Buffer.concat([Buffer.from([9 << 2]), Buffer.from('Launchpad'), Buffer.from([7 << 2]), Buffer.from('Mystery'), Buffer.alloc(8)]))]
  await s.batch(async (svc) => {
    const p = new EventsProcessing(svc, undefined, undefined, parser, lp)
    for (const c of cases) await p.handleLaunchpadEvent(c, info(1, LP))
  })
  assert.equal(s.store.t(CurveLaunch).size, 0)
})
