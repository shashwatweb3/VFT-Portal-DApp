import { Sails, getFnNamePrefix, getServiceNamePrefix } from "sails-js";
import { SailsIdlParser } from "sails-js-parser";
import { readFileSync } from "fs";
import { HexString } from ".";
import { safeUnwrapToBigInt } from "./event.utils";

/**
 * Decodes events emitted by the Curve Launch program (service "Launchpad").
 * Every event carries post-trade state, so handlers never recompute curve math.
 */
export enum LaunchpadEventType {
  Launched = "Launched",
  Bought = "Bought",
  Sold = "Sold",
  Ready = "Ready",
  TradeStuck = "TradeStuck",
  Reconciled = "Reconciled",
  GraduationStep = "GraduationStep",
  GraduationFailed = "GraduationFailed",
  ImbalancedListing = "ImbalancedListing",
  Graduated = "Graduated",
  Unwound = "Unwound",
  FeesClaimed = "FeesClaimed",
  PayoutClaimed = "PayoutClaimed",
}

export type LaunchedEvent = {
  type: LaunchpadEventType.Launched;
  token: string;
  creator: string;
  name: string;
  symbol: string;
  decimals: number;
  description: string;
  image: string;
  v0: bigint;
  t0: bigint;
  curveSupply: bigint;
  poolTokens: bigint;
  raiseTargetVara: bigint;
};

export type TradeEvent = {
  type: LaunchpadEventType.Bought | LaunchpadEventType.Sold;
  token: string;
  seq: number;
  trader: string;
  vara: bigint;
  tokens: bigint;
  fee: bigint;
  soldAfter: bigint;
  escrowAfter: bigint;
  priceAfterE18: bigint;
};

export type ReadyEvent = { type: LaunchpadEventType.Ready; token: string; escrow: bigint; poolVara: bigint };
export type StuckEvent = { type: LaunchpadEventType.TradeStuck; token: string; seq: number };
export type ReconciledEvent = { type: LaunchpadEventType.Reconciled; token: string; seq: number; committed: boolean };
export type GraduationStepEvent = { type: LaunchpadEventType.GraduationStep; token: string; step: string };
export type GraduationFailedEvent = {
  type: LaunchpadEventType.GraduationFailed;
  token: string;
  step: string;
  reason: string;
  retryable: boolean;
};
export type ImbalancedListingEvent = { type: LaunchpadEventType.ImbalancedListing; token: string; pair: string };
export type GraduatedEvent = {
  type: LaunchpadEventType.Graduated;
  token: string;
  pair: string;
  wvaraInPool: bigint;
  tokensInPool: bigint;
  lpBurned: bigint;
  rolesRenounced: boolean;
};
export type UnwoundEvent = { type: LaunchpadEventType.Unwound; token: string; escrow: bigint };
export type ClaimEvent = {
  type: LaunchpadEventType.FeesClaimed | LaunchpadEventType.PayoutClaimed;
  token: string;
  to: string;
  amount: bigint;
};

export type LaunchpadEvent =
  | LaunchedEvent
  | TradeEvent
  | ReadyEvent
  | StuckEvent
  | ReconciledEvent
  | GraduationStepEvent
  | GraduationFailedEvent
  | ImbalancedListingEvent
  | GraduatedEvent
  | UnwoundEvent
  | ClaimEvent;

const b = (v: unknown) => safeUnwrapToBigInt(v as string | number | bigint | null) ?? 0n;
const n = (v: unknown) => Number(v);
const s = (v: unknown) => String(v);
/** Unit enum variants decode as a bare string in sails-js; data variants as `{ Name: ... }`. */
const variant = (v: unknown) => (typeof v === "string" ? v : Object.keys(v as object)[0]);

let instance: LaunchpadEventsParser | undefined;

export async function getLaunchpadEventsParser(): Promise<LaunchpadEventsParser> {
  if (!instance) {
    instance = new LaunchpadEventsParser();
    await instance.init();
  }
  return instance;
}

export class LaunchpadEventsParser {
  private sails?: Sails;

  async init() {
    const idl = readFileSync("./assets/launchpad.idl", "utf-8");
    const parser = await SailsIdlParser.new();
    this.sails = new Sails(parser);
    this.sails.parseIdl(idl);
  }

  getEvent(payload: HexString): LaunchpadEvent | undefined {
    if (!this.sails) throw new Error("sails is not initialized");
    const serviceName = getServiceNamePrefix(payload);
    const fnName = getFnNamePrefix(payload);
    const service = this.sails.services[serviceName];
    if (!service || !service.events[fnName]) return undefined;
    const e = service.events[fnName].decode(payload) as Record<string, unknown>;
    const token = s(e.token);
    // Every launchpad event names a real token; an empty or zeroed body is not one of ours.
    if (!e.token || /^0x0+$/.test(token)) return undefined;

    switch (fnName) {
      case LaunchpadEventType.Launched:
        return {
          type: LaunchpadEventType.Launched,
          token,
          creator: s(e.creator),
          name: s(e.name),
          symbol: s(e.symbol),
          decimals: n(e.decimals),
          description: s(e.description),
          image: s(e.image),
          v0: b(e.v0),
          t0: b(e.t0),
          curveSupply: b(e.curve_supply),
          poolTokens: b(e.pool_tokens),
          raiseTargetVara: b(e.raise_target_vara),
        };
      case LaunchpadEventType.Bought:
        return {
          type: LaunchpadEventType.Bought,
          token,
          seq: n(e.seq),
          trader: s(e.trader),
          vara: b(e.vara_in),
          tokens: b(e.tokens_out),
          fee: b(e.fee),
          soldAfter: b(e.sold_after),
          escrowAfter: b(e.escrow_after),
          priceAfterE18: b(e.price_after_e18),
        };
      case LaunchpadEventType.Sold:
        return {
          type: LaunchpadEventType.Sold,
          token,
          seq: n(e.seq),
          trader: s(e.trader),
          vara: b(e.vara_out),
          tokens: b(e.tokens_in),
          fee: b(e.fee),
          soldAfter: b(e.sold_after),
          escrowAfter: b(e.escrow_after),
          priceAfterE18: b(e.price_after_e18),
        };
      case LaunchpadEventType.Ready:
        return { type: LaunchpadEventType.Ready, token, escrow: b(e.escrow), poolVara: b(e.pool_vara) };
      case LaunchpadEventType.TradeStuck:
        return { type: LaunchpadEventType.TradeStuck, token, seq: n(e.seq) };
      case LaunchpadEventType.Reconciled:
        return { type: LaunchpadEventType.Reconciled, token, seq: n(e.seq), committed: Boolean(e.committed) };
      case LaunchpadEventType.GraduationStep:
        return { type: LaunchpadEventType.GraduationStep, token, step: variant(e.step) };
      case LaunchpadEventType.GraduationFailed:
        return {
          type: LaunchpadEventType.GraduationFailed,
          token,
          step: variant(e.step),
          reason: s(e.reason),
          retryable: Boolean(e.retryable),
        };
      case LaunchpadEventType.ImbalancedListing:
        return { type: LaunchpadEventType.ImbalancedListing, token, pair: s(e.pair) };
      case LaunchpadEventType.Graduated:
        return {
          type: LaunchpadEventType.Graduated,
          token,
          pair: s(e.pair),
          wvaraInPool: b(e.wvara_in_pool),
          tokensInPool: b(e.tokens_in_pool),
          lpBurned: b(e.lp_burned),
          rolesRenounced: Boolean(e.roles_renounced),
        };
      case LaunchpadEventType.Unwound:
        return { type: LaunchpadEventType.Unwound, token, escrow: b(e.escrow) };
      case LaunchpadEventType.FeesClaimed:
      case LaunchpadEventType.PayoutClaimed:
        return { type: fnName as ClaimEvent["type"], token, to: s(e.to), amount: b(e.amount) };
    }
    return undefined;
  }
}
