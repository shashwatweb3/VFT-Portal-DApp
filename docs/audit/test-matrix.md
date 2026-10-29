# Test matrix

Run `cargo test --workspace` in `contracts/launchpad` (47 tests), `node --test test/*.test.mjs` in `indexer` (12 pass + 2 documented `todo`), `pnpm test` in `voucher-server` (6), and the devnet scripts against `gear --dev`.

## Contract — unit (`launchpad/app/src/curve.rs`, `wire.rs`)

| Test | Proves |
|---|---|
| `derive_params_matches_plan_numbers` | Plan parameters (a ≈ 267.9M, v0 ≈ 198.9) fall out of the solver |
| `selling_out_the_curve_raises_the_net_target` | Selling exactly the curve supply raises the net target (< 1 VARA rounding) |
| `final_curve_price_equals_pool_opening_price` | No-arb condition within 0.1 % |
| `round_trip_never_favours_the_trader` | 50 buy/sell round trips never return more than paid |
| `buy_cost_inverts_tokens_out` | Capped-buy cost is the exact inverse, rounded up |
| `fee_split_is_exact` | 1 % = 0.5 % + 0.5 %; gross-for-net within 1 planck |
| `derive_params_rejects_pool_below_average_price` | Impossible parameter sets are refused |
| `call_payload_is_service_method_args`, `reply_prefix_is_checked`, `vft_init_payload_starts_with_constructor_name` | Hand-written Sails v1 wire format |

## Contract — gtest against real RivrDEX + wVARA wasm

| File | Tests | What they prove |
|---|---|---|
| `launch.rs` | 7 | VFT owned by launchpad with full supply and equal max; case-insensitive names; first buy at floor; `LowReserve`; spawn failure refunds and releases the name; first-buy slippage rejected before the spawn; per-creator launch cooldown |
| `trade.rs` | 10 | Buy/sell books, fees, liabilities; slippage refund; sell-out cap with exact refund and `Ready`; fee claims; creator cannot burn curve inventory; busy lock; forced transfer failure reverts and refunds; dust payouts deferred and claimable; k never decreases and program stays solvent |
| `graduation.rs` | 9 | Full listing (pair, reserves, LP at dead, roles empty, liabilities); price continuity ≤ 0.3 %; no trades while graduating; pre-created empty pair reused; stale `Ready` unwind and sell-back; concurrent Graduate runs once; failed step resumes and charges the pair fee once; unwind after wrap; pre-seeded pair handled |
| `feedback.rs` (Phase 4 attacker) | 11 | Value conservation at every step of a full lifecycle; concurrency (buy+sell, sell+sell, buy+graduate, double claims, graduate+unwind); curve edges and 30-round drift; authorization and value rejection on every admin and non-payable method; every graduation step forced to fail then resumed; donations of LP/tokens/wVARA; dust-, large- and expensive-ratio pre-seeds (regressions for the three HIGH findings); unwind after pair creation lets every seller exit; name normalisation and length limits |

## Live dev node (`devnet/`)

| Script | Proves |
|---|---|
| `deploy.ts` | Whole stack deploys with sails-js 0.5.1 + @gear-js/api 0.44.2 |
| `smoke.ts` | Launch with first buy → buy → sell → sell-out → all 11 graduation steps → pool, LP and roles verified on chain (`SMOKE OK`) |
| `gasless.ts` | A 0-VARA wallet launches through a voucher and still has 0 VARA; second voucher refused (429); keeper graduates unattended (`GASLESS OK`) |

## Indexer and services

| Suite | Proves |
|---|---|
| `indexer/test/launchpad.handler.test.mjs` | Deterministic ids, candle folding, progress bps |
| Live squid run against the dev node | Launch, 4 trades, 5 candles, 10+ graduation steps, `GRADUATED` with pair/LP/roles; holders exclude launchpad and pair (3 real holders) |
| Migration on a populated DB | Existing coins backfilled as `CLASSIC` |
| `voucher-server/test/unit.test.ts` | Rate limiter window and case-folding, address normalisation, keeper decisions, per-IP/global caps, keeper backoff, timeouts |
| `indexer/test/feedback.sim.test.mjs` | Holder exclusion across batches and replays, Reconcile status guard, trade replay idempotency, null-token rejection |

## Known gaps

- **Reply timeouts** cannot be produced in gtest (replies land in the same block), so `TradeStuck`/`Reconcile` and the timeout branches of graduation are covered by code review only. A gclient test on a node with a deliberately slow callee would close this.
- **Retryability**: every call failure is marked retryable; a permanent failure after step 5 can only be retried, not unwound (finding C7).
- **Mainnet RivrDEX bytecode** is assumed equal to `vara-amm` master; verify the deployed code hash before mainnet.
- **The ported VFT** replaces the live Tokenator VFT for curve tokens; it is IDL-identical but is new code and in audit scope.
