# plan_buy — micro-analysis

File: `launchpad/app/src/service.rs` L128-L154 (crate at `contracts/launchpad/launchpad/app`).
Callees: `curve::split_fee` (curve.rs L95-L105), `curve::buy_tokens_out` (L47-L52),
`curve::buy_cost_for_tokens` (L55-L67), `curve::gross_for_net` (L108-L116).
Callers: `check_buy` (service.rs L218), `quote_buy` (service.rs L905).
Build profile: `contracts/launchpad/Cargo.toml` L22-L23 sets `overflow-checks = true` for release, so
every `+ - *` on `u128`/`U256` below panics on overflow rather than wrapping.

## 1. Purpose

Pure function. Given a `&Launch` and a gross VARA amount, it returns a `BuyPlan` (L112-L118):
`gross_used`, `refund`, `split` (net/fee/creator/protocol), `tokens_out`, `completes_curve`. It
reads `launch.fee_bps`, `launch.creator_fee_bps`, `launch.virtual_vara`, `launch.virtual_tokens`,
`launch.real_remaining`. It writes no state. The plan is the only place the sell-out buy is sized:
it decides how many tokens the last buyer receives, how much of their VARA is kept, and therefore
how much net VARA the final buy adds to `Launch.escrow` (applied later by `apply_buy` L175-L178).

## 2. Inputs and preconditions

| Input | Source | Bound established where |
|---|---|---|
| `gross` | `msg::value()` in `buy` (L535) or `launch` (L318); arbitrary `vara_in` in `quote_buy` (L902) | `check_buy` L208 enforces `gross >= min_trade_vara`; no upper bound other than the account's balance. `quote_buy` enforces nothing. |
| `launch.fee_bps` | snapshot of `config.fee_bps` at launch time (L480) | `set_fees` L1015 enforces `fee_bps < 10_000` and `creator_fee_bps <= fee_bps`. The constructor (`lib.rs` L25 -> `State::new` state.rs L225-L238) stores `Config` with no validation. |
| `virtual_vara`, `virtual_tokens`, `real_remaining` | `launch` L450-L453 from `derive_params`, then mutated by `apply_buy` L175-L177, `sell` L596-L598, `revert_trade` L186-L188 | see invariant I1 |

## 3. Block-by-block

### L129-L131: optimistic plan
- `split_fee(gross, fee_bps, creator_fee_bps)` (curve.rs L95-L105): `fee = floor(gross*fee_bps/10000)`,
  `creator = min(floor(gross*creator_bps/10000), fee)`, `net = gross - fee`, `protocol = fee - creator`.
  `gross - fee` underflows (panics) only if `fee_bps > 10000`; prevented by `set_fees` L1015 but not by the
  constructor. `creator <= fee` holds on every path due to the `min` at L98, so `protocol` never underflows.
- `buy_tokens_out(vs, vt, net)` (curve.rs L47-L52): returns 0 when `net == 0`; else
  `floor(vt.saturating_mul(net) / (vs + net))`. Floor rounds against the buyer. `vs + net` cannot be 0 when
  `net > 0`. `saturating_mul` caps at `U256::MAX`; with `vt <= ~1.07e27` (curve.rs test L139) and `net <= u128::MAX`,
  the product is below `U256::MAX`, so the saturation branch is not reached from these inputs.

### L132-L140: non-completing path
If `tokens_out < real_remaining`, return `gross_used = gross`, `refund = 0`, the L129 split, and
`completes_curve = false`. `tokens_out` can be 0 here (small `net` relative to price); `plan_buy` does not
reject it — `check_buy` L222 does (`ZeroOutput`). `quote_buy` returns it as-is.

Strict `<` means `tokens_out == real_remaining` falls through to the sell-out path.

### L141-L153: sell-out path (`tokens_out >= real_remaining`)
- L142: `tokens_out = real_remaining`. After `apply_buy` L177, `real_remaining` becomes exactly 0, which is
  what `commit_trade` L1104 tests to flip the launch to `Ready`.
- L143: `net_needed = buy_cost_for_tokens(vs, vt, rr)` (curve.rs L55-L67) = `ceil(vs*rr / (vt - rr))`.
  Divides by `vt - rr`; requires `vt > rr` (I1). If `rr == 0` it returns 0 (L56-L58) before dividing.
- L144: `net_needed.min(net).low_u128()`. Mathematically, `floor(vt*net/(vs+net)) >= rr` implies
  `net*(vt-rr) >= vs*rr`, hence `net >= ceil(vs*rr/(vt-rr))`; so the `min` does not change the value
  under exact arithmetic. It also guarantees the `low_u128()` truncation is lossless because `net` is a
  `u128`.
- L145: `gross_used = gross_for_net(net_needed, fee_bps).min(gross)`.
  `gross_for_net` (curve.rs L108-L116): `keep = 10000 - fee_bps` (panics if `fee_bps > 10000`), `g0 =
  floor(net*10000/keep)` (division by zero if `fee_bps == 10000`; `net*10000` overflows u128 above ~3.4e34),
  returns `g0` if `split_fee(g0, fee_bps, 0).net >= net`, else `g0 + 1`. On both paths the returned `g`
  satisfies `net(g) >= net_needed`: for `g0+1`, `net(g) >= g*keep/10000 > net_needed`. The result is not
  proven minimal; it can exceed the smallest sufficient gross by one planck-step of fee rounding.
  The `.min(gross)` clamp: when it binds, `gross_used = gross` and `net(gross) >= net_needed` already holds
  (from the L144 argument), so the sufficiency property survives the clamp.
- L146: split recomputed on `gross_used` with the creator share. `split.net` here is `net(gross_used)`, which
  is `>= net_needed` and can exceed it by the fee-rounding slack (a few planck). That slack is not refunded;
  it enters `virtual_vara` and `escrow` through `apply_buy` L175/L178.
  `split.net` with `creator_bps` equals `split_fee(gross_used, fee_bps, 0).net` because `net = gross - fee`
  does not depend on `creator_bps` (curve.rs L100).
- L149: `refund = gross - gross_used`; no underflow because of the `.min(gross)` at L145.
- L152: `completes_curve = true`.

## 4. Invariants

- **I1 `virtual_tokens - real_remaining == a > 0` for the life of a Trading launch.** Initial: `virtual_tokens =
  t0 = curve_supply + a` (curve.rs L41), `real_remaining = curve_supply` (service.rs L451, L453), `a > 0`
  (curve.rs L38). Every mutation moves both by the same amount: `apply_buy` L176-L177, `sell` L597-L598,
  `revert_trade` L187-L188. This is what keeps the division at curve.rs L61 non-zero at L143.
- **I2 `escrow == virtual_vara - v0`.** Both start at 0 offset (L450, L455); `apply_buy` adds `split.net` to both
  (L175, L178); `sell` subtracts `gross` from both (L596, L599); `revert_trade` restores both (L186, L194).
  Consequently the escrow at completion equals `virtual_vara_final - v0`, and the final curve spot price is
  `(v0 + escrow) / a`.
- **I3 the sell-out plan leaves `real_remaining == 0`.** L142 sets `tokens_out = real_remaining`; `apply_buy` L177
  subtracts it. `commit_trade` L1104 derives completion from this, not from `plan.completes_curve`.
- **I4 `gross_used + refund == gross`** on both paths (L134-L135, L148-L149).
- **I5 `split.net(gross_used) >= buy_cost_for_tokens(vs, vt, rr)` on the sell-out path** (curve.rs L111-L115,
  plus the L144 inequality when the L145 clamp binds).
- **I6 `split.creator <= split.fee`, `split.protocol = split.fee - split.creator`** (curve.rs L98, L103).

## 5. Assumptions

| # | Assumption | Established by |
|---|---|---|
| A1 | `launch.fee_bps < 10_000` (else div-by-zero at curve.rs L110 / underflow at L109, L100) | `set_fees` L1015 for values set after deploy; **nothing found** for the constructor `Config` (lib.rs L25, state.rs L225-L238) |
| A2 | `launch.creator_fee_bps <= launch.fee_bps` | `set_fees` L1015; constructor not checked, but `split_fee` L98 clamps so no arithmetic failure results |
| A3 | `virtual_tokens > real_remaining` when entering L143 | I1, rooted in `derive_params` L38 |
| A4 | The launch is in `Trading`, not `busy`, not `lock`ed, so the plan is applied against the same reserves it was computed from | `check_buy` L212-L217; `buy` L537->L539 and `launch` L509->L511 call `run_buy` whose `apply_buy` (L1076) runs before the first await (L1081). `quote_buy` L905 checks none of these. |
| A5 | `gross` is small enough that `gross*fee_bps` and `net_needed*10000` fit in u128 | Bounded by total VARA issuance in practice; **nothing found** in code; overflow panics per Cargo.toml L23 |
| A6 | The escrow accumulated at completion matches the `net_raise` that `derive_params` was calibrated with, so that `pool_vara = escrow - graduation_fee` (commit_trade L1109) prices the pool at the curve's final price | `curve_params_for` L240-L251 calibrates `v0,t0` on `split_fee(raise_target).net` and `pool_vara = net - graduation_fee`; **nothing found** that enforces `escrow_final == net_raise`. Per I2, `escrow_final = virtual_vara_final - v0`, and `virtual_vara_final` depends on the trade path because each buy floors `tokens_out` (curve.rs L51), each sell floors `vara_out` (L74), and the sell-out buy keeps `net(gross_used) - net_needed` slack (L146). Tests bound the clean single-buy deviation below 1 VARA (curve.rs L147-L153) but no test covers multi-trade paths. |
| A7 | Gross fees on the sell-out buy are charged only on `gross_used`, not on the refunded part | L146 recomputes the split on `gross_used`; `apply_buy` L164-L167 records that split |

## 6. Callers and how they use the plan

- `check_buy` L218-L225: applies slippage (`tokens_out < min_tokens_out`) and `ZeroOutput`. On the sell-out
  path `tokens_out = real_remaining`, so a buyer's `min_tokens_out` above the remaining supply rejects.
- `run_buy` L1075-L1080: pays `plan.refund` via `pay` before the VFT transfer await; the `bool` result of
  `pay` is discarded (L1079). On transfer failure it pays back `pending.vara_gross` = `gross_used` (L164, L1085).
- `commit_trade` L1101-L1117: books `split.creator`/`split.protocol`, then sets `pool_vara =
  escrow.saturating_sub(graduation_fee)` and budgets. `plan.completes_curve` is never read here.
- `quote_buy` L902-L917: calls `plan_buy` on any launch state (no `Trading` check), exposes
  `completes_curve` and `refund_vara`. On a launch with `real_remaining == 0` (Ready/Graduated), `plan_buy`
  takes the sell-out path with `tokens_out = 0`, `net_needed = 0`, `gross_used = gross_for_net(0) = 0`,
  `refund = gross`, `completes_curve = true`.

## 7. Relationship to graduation (context for the user's questions)

- `plan_buy` itself does not start graduation. It only sizes the last buy so `real_remaining` reaches 0;
  the transition to `Ready` happens in `commit_trade` L1106-L1108, which is reached only after the VFT transfer
  reply (`run_buy` L1082) or a later `reconcile` (L649). Graduation steps are a separate entrypoint.
- Everything net of trade fees that buyers paid in minus what sellers took out stays in `escrow` (I2); at
  completion the whole escrow less the fixed `graduation_fee` becomes `pool_vara` (L1109). There is no
  separate creator/RivrDEX graduation split computed in `plan_buy` or `commit_trade`; the trade-fee split
  (`creator_fees`/`protocol_fees`) is per-trade from `split_fee`.

## 8. Open questions

- unclear; need to inspect `step_wrap`/`step_align_price`/`step_settle` to see how a deviation of `escrow`
  from the calibrated `net_raise` (A6) is absorbed (whether `pool_vara`/`wvara_budget` is re-derived from
  price or used as-is).
- unclear; need to inspect deployment scripts / initial `Config` to confirm constructor values satisfy A1/A2,
  since `new` does not validate.
- unclear; need to inspect `wire::send_value` to see whether a failed refund send at `run_buy` L1079 leaves
  the refund amount in the program's free balance with no liability record.
