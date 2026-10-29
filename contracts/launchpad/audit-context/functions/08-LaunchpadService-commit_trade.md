# LaunchpadService::commit_trade

File: `contracts/launchpad/launchpad/app/src/service.rs` L1096-L1172 (private, not `#[export]`; sync `fn`).

## 1. Purpose

Finalises a trade whose VFT leg is confirmed (or inferred confirmed by `reconcile`). It books the
trade's fees into per-launch accumulators and into `total_liabilities`, clears `launch.busy`, and on a
buy that leaves `real_remaining == 0` moves the launch to `Ready`, overwriting `pool_vara`,
`wvara_budget`, `token_budget` and `ready_at`. For sells it then pays (or defers) the seller's net VARA.
It emits `Bought`/`Sold` and optionally `Ready`, and returns a `TradeReceipt`.

It does not touch the curve (virtual reserves, real_remaining, escrow): those were moved by the caller
before the await (`apply_buy` L175-L178 for buys, `sell` L596-L599 for sells).

## 2. Callers and the state they hand over

| Caller | Line | Context at call |
|---|---|---|
| `run_buy` | L1082 | After `vft_transfer(token, buyer, tokens)` returned `Ok(true)`. `apply_buy` (L157-L182) already set `busy = Some(pending)`, moved the curve, `escrow += net`, `owe(net)`. Any refund was sent before the await (L1077-L1080). |
| `sell` | L606 | After `vft_transfer_from(token, seller, me, amount)` returned `Ok(true)`. Pre-await closure (L556-L603) set `busy`, moved curve, `escrow -= gross`, `settle(gross)`. |
| `reconcile` | L649 | After `vft_balance_of` returned `held == real_remaining + pool_tokens` (L644, L648). `lock` was set true L634 and cleared L639 before this call. `pending` is a clone of `launch.busy` taken at L631 before the await. |

`run_buy` itself is reached from `buy` (L539) and from `launch`'s first buy (L511, whose result is
discarded with `let _`).

## 3. Inputs

- `token: ActorId` - resolved via `st.launch_mut(&token)` (L1100), which panics `LaunchNotFound` (state.rs L240-L244).
- `pending: &PendingTrade` - passed by the caller, not re-read from `launch.busy`. In `run_buy`/`sell` it is the value returned by the pre-await closure; in `reconcile` it is a clone from L631.

## 4. Block-by-block

### 4.1 Fee booking and busy clear (L1099-L1103)
- `creator_fees += pending.fee_creator`, `protocol_fees += pending.fee_protocol` (L1101-L1102). `+=` on `u128`; release profile has `overflow-checks = true` (contracts/launchpad/Cargo.toml L23), so overflow panics.
- `busy = None` (L1103) unconditionally. No comparison of `launch.busy` against `pending.seq` or `pending.stuck`.

Fee components come from `curve::split_fee` (curve.rs L95-L105): `fee = gross*fee_bps/BPS`,
`creator = min(gross*creator_bps/BPS, fee)`, `protocol = fee - creator`, `net = gross - fee`. Hence
`net + creator + protocol == gross` exactly for both sides (buy split at L129/L146, sell split at L572).

### 4.2 Completion test (L1104)
`completed = pending.side == Buy && launch.real_remaining.is_zero()`. It reads the *current*
`real_remaining`, not `plan.completes_curve` (BuyPlan L117) nor `pending.tokens`. For buys, the
in-flight state has `real_remaining = prev_real_remaining - tokens` (L177); `plan_buy` caps
`tokens_out = real_remaining` on sell-out (L142), so a sell-out buy leaves `real_remaining == 0`.
A sell never triggers completion (`side == Buy` guard).

No check of `launch.state` before writing `Ready` (L1107). The caller paths gate on state only before
the await: `check_buy` requires `Trading` (L212); `sell` allows `Trading | Aborted` (L558). While
`busy.is_some()`, `graduate` (L678) and `unwind` (L793) panic and `buy`/`sell` reject (L215, L561),
so the launch state stays as it was at trade start for the paths read here.

### 4.3 Ready transition (L1106-L1118)
- `state = Ready`, `ready_at = exec::block_height()` (L1107-L1108). `ready_at` drives `unwind`'s
  `stale_ready` check (L787-L788).
- `pool_vara = escrow.saturating_sub(graduation_fee)` (L1109). This overwrites the launch-time target
  `pool_vara_target` set at L456. `saturating_sub` means if `escrow < graduation_fee` the result is 0
  with no error; nothing in this function asserts `escrow >= graduation_fee`. The launch-time
  `curve_params_for` (L240-L243) asserts `net(raise_target) >= graduation_fee_vara` for the config,
  but escrow at sell-out is a function of curve rounding, not of that target directly.
- `wvara_budget = U256::from(pool_vara)`, `token_budget = pool_tokens` (L1111-L1112), overwriting
  L470-L471.
- The `graduation_fee` portion (`escrow - pool_vara`) is left in `escrow`; `step_wrap` later does
  `escrow -= pool_vara` and `settle(pool_vara)` (L1186-L1190), and `step_settle` converts the
  remainder of escrow (minus `pair_creation_fee.min(escrow)`) into `protocol_fees` (L1390-L1394).

Escrow relationship: `apply_buy` adds `net` to both `virtual_vara` and `escrow` (L175, L178); `sell`
subtracts `gross` from both (L596, L599); `revert_trade` restores both from the snapshot (L186, L194).
So during Trading `escrow == virtual_vara - v0` holds on these paths, and at sell-out
`escrow = virtual_vara_final - v0`.

### 4.4 Receipt (L1119-L1130)
- `vara`: `vara_gross` for buys (excludes any refund), `vara_net` for sells.
- `fee = fee_creator + fee_protocol` (unchecked sum at L1127; cannot overflow given split_fee bounds).
- `price_after_e18 = launch.price_e18()` (state.rs L195-L197 -> curve.rs L78-L83, zero when vt is 0).

### 4.5 Liability booking (L1131)
`st.owe(fee_creator + fee_protocol)` (state.rs L252-L257, checked_add, panics `LiabilityOverflow`).

Net liability effect per path, combined with the caller's pre-await writes:
- Buy: `owe(net)` (L180) + `owe(fees)` (L1131) = `owe(gross_used)`; value received = `gross_used + refund`, refund paid at L1079.
- Sell, immediate pay: `settle(gross)` (L601) + `owe(fees)` (L1131) = `-net`; value sent = `net` via `pay_seller`.
- Sell, deferred: additionally `owe(net)` in `pay_seller` (L298) and `pending_payouts += net` (L297).

### 4.6 Post-closure reads (L1134-L1135)
Separate borrow reads `sold()` (state.rs L191-L193, `curve_supply - real_remaining`, U256 sub) and
`escrow`. No state mutation between closure and this read.

### 4.7 Side-specific tail (L1136-L1167)
- Buy: emits `Bought` (L1138-L1149) with `.expect("event")`.
- Sell: calls `pay_seller` (L1152) then emits `Sold` with `deferred`.

`pay_seller` (L288-L301), all paths:
1. `vara_net == 0` -> return false, nothing sent, nothing owed (L290-L292). `sell` rejects `split.net == 0` (L576), so unreachable from `sell`; reachable from `reconcile` only if the stuck pending had net 0, which `sell` already prevents.
2. `vara_net >= existential_deposit()` (wire.rs L293-L295) and `send_value` returns true -> return false (L293-L294). `send_value` (wire.rs L286-L291) is `msg::send_bytes_with_gas(to, [], 0, value).is_ok()`: a 0-gas message carrying value; `is_ok` reflects only that the send was queued.
3. Otherwise (sub-ED, or send returned Err) -> `pending_payouts[(token, trader)] += net`, `owe(net)`, return true (L296-L300). `+=` on the map entry is overflow-checked.

There is no `settle` on path 2: the gross was already settled pre-await (L601).

### 4.8 Ready event (L1168-L1170)
Emitted after the trade event.

## 5. Invariants

1. After return, `launch.busy == None` (L1103).
2. Fees are added to the accumulators and to `total_liabilities` by the same amount in the same closure (L1101-L1102, L1131).
3. `Ready` is entered only from a Buy whose post-trade `real_remaining == 0` (L1104-L1107).
4. On entering Ready: `pool_vara <= escrow`, `wvara_budget == pool_vara`, `token_budget == pool_tokens` (L1109-L1112).
5. Seller payout leaves liabilities consistent: paid -> no booking; deferred -> `pending_payouts` and `total_liabilities` both increase by `net` (L297-L298).

## 6. Assumptions

| Assumption | Established by |
|---|---|
| `pending` is the trade currently recorded in `launch.busy` (same seq) | Callers only: `run_buy`/`sell` hold it from the same message; `reconcile` clones at L631 with `lock` set L634. commit_trade itself checks nothing. |
| No other trade/graduation/unwind ran on this launch between the pre-await write and this call | `busy.is_some()` guards in `check_buy` L215, `sell` L561, `graduate` L678, `unwind` L793. |
| Launch state is still the pre-await state (Trading for buys) when Ready is written | Same busy guards; admin setters not inspected for launch.state writes -> see open questions. |
| `escrow >= graduation_fee` at sell-out | nothing found in this function (L1109 saturates). Launch-time config check L240-L243 is on raise target, not on actual escrow. |
| `net + fee_creator + fee_protocol == gross` in `pending` | `curve::split_fee` curve.rs L95-L105. |
| `send_value` returning true means the seller will receive value | `msg::send_bytes_with_gas(...).is_ok()` wire.rs L290 only; delivery of a 0-gas value message is runtime behavior (black box). |
| The program's free balance covers `vara_net` when sending to seller | nothing found in this function; relies on `total_liabilities` accounting elsewhere. |
| `reconcile`'s balance equality means the transfer executed | reconcile L641-L648 (balance comparison only; third-party transfers to the launchpad alter `held`). |
| No panic occurs after state writes in this function (event emission, overflow) | nothing found; `.expect("event")` at L1149, L1165, L1169 and checked arithmetic L1101-L1102, L1131, L297-L298 can panic. |

## 7. Calls

- `State::launch_mut` (state.rs L240) - panics on unknown token.
- `exec::block_height` (gstd, black box) - ready_at.
- `Launch::price_e18` / `curve::price_e18` - pure.
- `State::owe` (state.rs L252) - checked add.
- `Launch::sold` (state.rs L191) - U256 sub.
- `pay_seller` (L288) -> `wire::existential_deposit` (wire.rs L293), `wire::send_value` (wire.rs L286) -> `msg::send_bytes_with_gas` (gstd, black box).
- `emit_event` (sails-rs generated) - `.expect`.

## 8. Open questions

- unclear; need to inspect Gear/gstd semantics for a panic after an await: whether the pre-await writes (busy = Some, curve moved, liabilities) remain committed while the post-await commit_trade writes are rolled back, and what then happens to the launch (busy stays Some with stuck=false, which `reconcile` L631 rejects).
- unclear; need to inspect whether any admin setter or other path writes `launch.state` or `launch.graduation_fee` while `busy.is_some()` (set_fees L1012-L1024 touches config only per grep, but full body not read here).
- unclear; need to inspect whether a late reply for a timed-out `vft_transfer`/`vft_transfer_from` can still resume the original future and reach commit_trade a second time after `reconcile` already committed (gstd reply-timeout behaviour in wire.rs L70).
- unclear; need to inspect whether escrow at sell-out can be below `graduation_fee` given `buy_cost_for_tokens` ceil rounding (curve.rs L55-L67) and `gross_for_net` min-capping at L144-L145, making pool_vara 0 via L1109.
- unclear; need to inspect what `send_value` with 0 gas does for a program destination or a sub-ED residual on the recipient, i.e., whether value returned to the launchpad is ever re-booked.
- Sells in `Aborted` state accrue creator/protocol fees through L1101-L1102 like Trading sells; unclear whether that is intended for aborted launches (design question).
