import { EntitiesService } from "../entities.service";
import { EventInfo } from "../event-info.type";
import {
  Coin,
  CoinKind,
  CurveCandle,
  CurveLaunch,
  CurveStatus,
  CurveTrade,
} from "../../model";
import {
  GraduatedEvent,
  GraduationFailedEvent,
  GraduationStepEvent,
  LaunchedEvent,
  LaunchpadEvent,
  LaunchpadEventType,
  ReadyEvent,
  TradeEvent,
} from "../../types/launchpad.events";

/** Candle bucket sizes in seconds. */
export const CANDLE_INTERVALS = [60, 300, 3600, 86400];

/** Deterministic ids so a replayed block overwrites instead of duplicating. */
export const tradeId = (token: string, seq: number) => `${token}-${seq}`;
export const candleId = (token: string, interval: number, bucketStartMs: number) =>
  `${token}-${interval}-${bucketStartMs}`;

export const bucketStart = (timestamp: Date, intervalSeconds: number) => {
  const size = intervalSeconds * 1000;
  return new Date(Math.floor(timestamp.getTime() / size) * size);
};

export const progressBps = (sold: bigint, curveSupply: bigint) =>
  curveSupply === 0n ? 0 : Number((sold * 10_000n) / curveSupply);

/** Folds one trade into an existing candle (or opens a new one). Pure, for testing. */
export function foldCandle(
  candle: Pick<CurveCandle, "open" | "high" | "low" | "close" | "volumeVara" | "trades"> | undefined,
  price: bigint,
  vara: bigint
) {
  if (!candle) {
    return { open: price, high: price, low: price, close: price, volumeVara: vara, trades: 1 };
  }
  return {
    open: candle.open,
    high: price > candle.high ? price : candle.high,
    low: price < candle.low ? price : candle.low,
    close: price,
    volumeVara: candle.volumeVara + vara,
    trades: candle.trades + 1,
  };
}

export class LaunchpadHandler {
  constructor(private readonly launchpadAddress: string) {}

  async handle(event: LaunchpadEvent, info: EventInfo, store: EntitiesService) {
    switch (event.type) {
      case LaunchpadEventType.Launched:
        return this.onLaunched(event, info, store);
      case LaunchpadEventType.Bought:
      case LaunchpadEventType.Sold:
        return this.onTrade(event, info, store);
      case LaunchpadEventType.Ready:
        return this.onReady(event, info, store);
      case LaunchpadEventType.TradeStuck:
        return this.setStatus(event.token, CurveStatus.STUCK, info, store, [CurveStatus.TRADING]);
      case LaunchpadEventType.Reconciled:
        // A reconciled completing buy has already emitted Ready; only undo STUCK.
        return this.setStatus(event.token, CurveStatus.TRADING, info, store, [CurveStatus.STUCK]);
      case LaunchpadEventType.GraduationStep:
        return this.onStep(event, info, store);
      case LaunchpadEventType.GraduationFailed:
        return this.onFailed(event, info, store);
      case LaunchpadEventType.Graduated:
        return this.onGraduated(event, info, store);
      case LaunchpadEventType.Unwound:
        return this.setStatus(event.token, CurveStatus.ABORTED, info, store);
      default:
        // ImbalancedListing / FeesClaimed / PayoutClaimed are kept in the raw event log only.
        return;
    }
  }

  private async onLaunched(event: LaunchedEvent, info: EventInfo, store: EntitiesService) {
    if (await store.getCoin(event.token)) {
      console.warn(`[launchpad] ${event.token}: coin already exists`);
      return;
    }
    const totalSupply = event.curveSupply + event.poolTokens;
    // The VFT emits nothing at init, so the Coin row and the launchpad's balance come from here;
    // without the Coin row every later Transfer from this token would be dropped by main.ts.
    const coin = new Coin({
      id: event.token,
      memeId: `curve-${event.token}`,
      name: event.name,
      symbol: event.symbol,
      decimals: event.decimals,
      description: event.description,
      image: event.image,
      initialSupply: totalSupply,
      maxSupply: totalSupply,
      circulatingSupply: totalSupply,
      minted: 0n,
      burned: 0n,
      holders: 0,
      distributed: 0n,
      admins: [this.launchpadAddress],
      screenshots: [],
      createdBy: event.creator,
      timestamp: info.timestamp,
      kind: CoinKind.CURVE,
      excludedHolders: [this.launchpadAddress],
      factory: store.getFactory(),
    });
    const launch = new CurveLaunch({
      id: event.token,
      coin,
      creator: event.creator,
      status: CurveStatus.TRADING,
      v0: event.v0,
      t0: event.t0,
      curveSupply: event.curveSupply,
      poolTokens: event.poolTokens,
      raiseTargetVara: event.raiseTargetVara,
      sold: 0n,
      escrow: 0n,
      priceE18: event.t0 === 0n ? 0n : (event.v0 * 10n ** 18n) / event.t0,
      progressBps: 0,
      volumeVara: 0n,
      feesVara: 0n,
      tradeCount: 0,
      lastSeq: 0,
      createdAt: info.timestamp,
      updatedAt: info.timestamp,
    });
    await store.setCoin(coin);
    store.setCurveLaunch(launch);
    const balance = await store.getAccountBalance(this.launchpadAddress, coin);
    balance.balance = totalSupply;
    await store.setAccountBalance(balance);
  }

  private async onTrade(event: TradeEvent, info: EventInfo, store: EntitiesService) {
    const launch = await store.getCurveLaunch(event.token);
    if (!launch) {
      console.warn(`[launchpad] trade for unknown launch ${event.token}`);
      return;
    }
    if (event.seq <= launch.lastSeq) {
      // Already applied (replayed range): trades and candles are keyed by seq, aggregates are not.
      return;
    }
    if (event.seq !== launch.lastSeq + 1) {
      // Gaps mean a missed event (or a reconcile that committed late); flag, never guess.
      console.warn(`[launchpad] ${event.token}: seq gap ${launch.lastSeq} -> ${event.seq}`);
    }
    store.addCurveTrade(
      new CurveTrade({
        id: tradeId(event.token, event.seq),
        launch,
        seq: event.seq,
        side: event.type === LaunchpadEventType.Bought ? "BUY" : "SELL",
        trader: event.trader,
        vara: event.vara,
        tokens: event.tokens,
        fee: event.fee,
        priceAfterE18: event.priceAfterE18,
        soldAfter: event.soldAfter,
        blockNumber: info.blockNumber,
        timestamp: info.timestamp,
      })
    );
    for (const interval of CANDLE_INTERVALS) {
      const start = bucketStart(info.timestamp, interval);
      const id = candleId(event.token, interval, start.getTime());
      const existing = await store.getCurveCandle(id);
      store.setCurveCandle(
        new CurveCandle({
          id,
          launch,
          interval,
          bucketStart: start,
          ...foldCandle(existing, event.priceAfterE18, event.vara),
        })
      );
    }
    launch.sold = event.soldAfter;
    launch.escrow = event.escrowAfter;
    launch.priceE18 = event.priceAfterE18;
    launch.progressBps = progressBps(event.soldAfter, launch.curveSupply);
    launch.volumeVara += event.vara;
    launch.feesVara += event.fee;
    launch.tradeCount += 1;
    launch.lastSeq = Math.max(launch.lastSeq, event.seq);
    launch.updatedAt = info.timestamp;
    store.setCurveLaunch(launch);
  }

  private async onReady(event: ReadyEvent, info: EventInfo, store: EntitiesService) {
    const launch = await store.getCurveLaunch(event.token);
    if (!launch) return;
    launch.status = CurveStatus.READY;
    launch.poolVara = event.poolVara;
    launch.escrow = event.escrow;
    launch.updatedAt = info.timestamp;
    store.setCurveLaunch(launch);
  }

  private async onStep(event: GraduationStepEvent, info: EventInfo, store: EntitiesService) {
    const launch = await store.getCurveLaunch(event.token);
    if (!launch) return;
    if (launch.status !== CurveStatus.GRADUATED) launch.status = CurveStatus.GRADUATING;
    launch.gradStep = event.step;
    launch.failReason = null;
    launch.updatedAt = info.timestamp;
    store.setCurveLaunch(launch);
  }

  private async onFailed(event: GraduationFailedEvent, info: EventInfo, store: EntitiesService) {
    const launch = await store.getCurveLaunch(event.token);
    if (!launch) return;
    launch.status = CurveStatus.FAILED;
    launch.gradStep = event.step;
    launch.failReason = event.reason;
    launch.updatedAt = info.timestamp;
    store.setCurveLaunch(launch);
  }

  private async onGraduated(event: GraduatedEvent, info: EventInfo, store: EntitiesService) {
    const launch = await store.getCurveLaunch(event.token);
    if (!launch) return;
    // Status flips to GRADUATED only here, never from progress.
    launch.status = CurveStatus.GRADUATED;
    launch.pair = event.pair;
    launch.poolVara = event.wvaraInPool;
    launch.lpBurned = event.lpBurned;
    launch.rolesRenounced = event.rolesRenounced;
    launch.escrow = 0n;
    launch.graduatedAt = info.timestamp;
    launch.updatedAt = info.timestamp;
    store.setCurveLaunch(launch);
    const coin = await store.getCoin(event.token);
    if (coin) {
      if (!coin.excludedHolders.includes(event.pair)) {
        // The pair received its tokens during AddLiquidity, before this event named it, so the
        // transfer handler already counted it as a holder. Undo that once.
        const pairBalance = await store.getAccountBalance(event.pair, coin);
        if (pairBalance.balance > 0n && coin.holders > 0) coin.holders -= 1;
        coin.excludedHolders = [...coin.excludedHolders, event.pair];
      }
      coin.admins = event.rolesRenounced ? [] : coin.admins;
      await store.setCoin(new Coin({ ...coin }));
    }
  }

  private async setStatus(
    token: string,
    status: CurveStatus,
    info: EventInfo,
    store: EntitiesService,
    onlyFrom?: CurveStatus[]
  ) {
    const launch = await store.getCurveLaunch(token);
    if (!launch) return;
    if (onlyFrom && !onlyFrom.includes(launch.status)) return;
    launch.status = status;
    launch.updatedAt = info.timestamp;
    store.setCurveLaunch(launch);
  }
}
