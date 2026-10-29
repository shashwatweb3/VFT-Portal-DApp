# commit_trade — app/src/service.rs L1096-L1172

## 1. Purpose

Finalizes a trade whose VFT transfer has been confirmed (or reconciled as landed). It:
- books the trade fee into `creator_fees` / `protocol_fees` and into `total_liabilities` (L1101-1102, L1131);
- clears the in-flight trade marker `busy` (L1103);
- for a Buy that leaves `real_remaining == 0`, flips the launch to `Ready`, stamps `ready_at`, and fixes `pool_vara`, `wvara_budget`, `token_budget` (L1104-1118);
- for a Sell, pays (or defers) the seller's net proceeds via `pay_seller` (L1152);
- emits `Bought`/`Sold` and, if applicable, `Ready` (L1136-1170);
- returns a `TradeReceipt` (L1119-1130, L1171).

It is synchronous (`fn`, not `async fn`, L1098). It performs no awaits and does not start graduation.

## 2. Callers and the state they hand in

| Caller | Line | Context |
|---|---|---|
| `sell` | L606 | After `vft_transfer_from(token, seller, me, amount)` returned `Ok(true)` (L605). |
| `run_buy` | L1082 | After `vft_transfer(token, buyer, pending.tokens)` returned `Ok(true)` (L1081). Reached from `buy` (L539) and from `launch`'s first buy (L511). |
| `reconcile` | L649 | After `vft_balance_of(token, me)` equals `real_remaining + pool_tokens` (L641-648). |

In every path, `pending` is a clone of the `PendingTrade` that was written into `launch.busy` before the await (`apply_buy` L179, `sell` L600, `reconcile` L630-631 clones from `busy`).

Pre-await writes the caller has already made (and which `commit_trade` does not touch):
- Buy (`apply_buy` L175-180): `virtual_vara += net`, `virtual_tokens -= tokens_out`, `real_remaining -= tokens_out`, `escrow += net`, `owe(net)`. The fee portion `gross_used - net` is in the program's native balance but is not yet in `total_liabilities`.
- Sell (`sell` L596-601): `virtual_vara -= gross`, `virtual_tokens += amount`, `real_remaining += amount`, `escrow -= gross`, `settle(gross)`. Neither fee nor net is owed at this point.

So `commit_trade` is where the fee half of each trade (and, for sells, the net half via `pay_seller`) becomes a liability.

## 3. Block-by-block

### 3.1 Fee booking and busy clear (L1099-1103)
- `launch_mut` panics `LaunchNotFound` if absent (state.rs L240-244); callers already resolved the launch.
- `creator_fees += pending.fee_creator`, `protocol_fees += pending.fee_protocol` — plain `u128 +=`, unchecked (L1101-1102). No `overflow-checks` setting found in any Cargo.toml under the crate, so release-wasm behaviour on overflow is wrap (open question).
- `busy = None` unconditionally (L1103). There is no check that `launch.busy` is `Some` or that its `seq == pending.seq`. Correctness of this relies on the callers: during the await, `buy`/`launch` (`check_buy` L215), `sell` (L561), `graduate` (L678), `unwind` (L793) all refuse while `busy.is_some()`, and `reconcile` requires `busy` stuck and sets `lock` (L627-634). So no second trade for this token can be written into `busy` between apply and commit.

Fee composition: `split_fee` (curve.rs L95-105) gives `fee = gross*fee_bps/BPS`, `creator = min(gross*creator_bps/BPS, fee)`, `protocol = fee - creator`, `net = gross - fee`. Hence `fee_creator + fee_protocol == fee` and `net + fee == gross` exactly, for both sides.

### 3.2 Completion test (L1104)
`completed = pending.side == Side::Buy && launch.real_remaining.is_zero()`.
- Reads the live `real_remaining`, which `apply_buy` set at L177; the busy guard above keeps it unchanged until commit.
- `real_remaining` reaches zero only through `plan_buy`'s sell-out branch, which caps `tokens_out = real_remaining` (L142). The non-sell-out branch requires `tokens_out < real_remaining` (L132), so it leaves `real_remaining > 0`.
- The test does not look at `launch.state`. It relies on the state being `Trading` because `check_buy` required it (L212) before the await and nothing that changes `state` (`graduate` L684-701, `unwind` L807-809) can run while `busy` is set.

### 3.3 Ready transition (L1106-1118)
- `state = Ready` (L1107). This is the only write of `LaunchState::Ready` in the program (grep for `LaunchState::Ready =` / `state = LaunchState::Ready` yields only L1107).
- `ready_at = exec::block_height()` (L1108). On the `reconcile` path this is the block of the reconcile message, not of the original buy. `unwind` uses `ready_at + graduation_timeout_blocks` (L788) to decide when anyone can abort a stale Ready launch.
- `pool_vara = escrow.saturating_sub(graduation_fee)` (L1109). This overwrites the launch-time target `pool_vara_target` written at L456 (`net_raise - graduation_fee_vara`, L240-243). Structural consequences:
  - Everything in `escrow` at sell-out except `graduation_fee` is assigned to the pool. Any excess of actual escrow over the designed `net_raise` (rounding in favour of the launchpad, curve.rs L3-4: buys floor tokens, sells floor VARA, capped buy cost rounds up L55-67) goes to `pool_vara`, not to fees.
  - `graduation_fee` is a per-launch snapshot (L457) of `config.graduation_fee_vara`; `set_fees` (L1012-1026) changes only future launches.
  - The leftover `escrow - pool_vara` is what `step_settle` later converts: `escrow` is reduced by `pool_vara` at wrap (L1190), then by `pair_creation_fee` if `pair_created_by_us` (L1390-1391), and the rest plus any recovered wVARA becomes `protocol_fees` (L1393). No share of this leftover is credited to `creator_fees` anywhere (creator_fees writers: L1101, L840 only).
  - If `escrow < graduation_fee`, `pool_vara = 0` silently (saturating). Whether escrow can be below `graduation_fee` at sell-out depends on the curve: `derive_params` is constructed so that buying exactly `curve_supply` costs `net_raise` (curve.rs L17-23) and `curve_params_for` requires `net_raise > graduation_fee` (L241-243, plus `derive_params` returns None when `pool_vara == 0` because `lhs - rhs` underflows, curve.rs L30-32). Escrow equals `virtual_vara - v0` across buys/sells/reverts (buys add `net` to both, L175/L178; sells subtract `gross` from both, L596/L599; revert restores both, L186/L194). With `virtual_tokens = t0 - curve_supply` at sell-out and the product only growing under floor rounding, `virtual_vara` at sell-out is at least the designed final value up to the integer rounding of `v0`/`t0` (curve.rs L37-42); the unit test bounds that gap at < 1 VARA for the plan numbers (curve.rs L147-153). The zero branch therefore depends on `graduation_fee` not sitting within that rounding gap of `net_raise`; nothing at L1109 itself enforces `pool_vara > 0`.
  - Downstream, `pool_vara` is a divisor in `step_add_liquidity` (L1287, L1290 multiply/divide by `pv`) and a target in `step_align_price` (L1227, L1240). `pool_vara == 0` is not guarded there.
- `wvara_budget = pool_vara`, `token_budget = pool_tokens` (L1111-1112). These reset the launch-time values (L470-471) to the actual pool amounts. `step_align_price` later moves value between them (L1251, L1259, L1270-1271).
- The pool price the graduation targets is `pool_vara / pool_tokens` (L1218-1220, L1283-1287), not the curve's final spot `virtual_vara / virtual_tokens`. They coincide only by construction of `derive_params` (curve.rs L18-19, test L155-166 within 0.1%); after L1109 recomputes `pool_vara` from actual escrow, the pool price and the curve spot each shift by the escrow excess, over different denominators (`pool_tokens` vs `t0 - curve_supply`).
- `Event::Ready` is prepared (L1113-1117) and emitted after the trade event (L1168-1170).

What the Ready transition does not do: it does not call or schedule `graduate`. `graduate` is a separate, permissionless export (L668-670) that accepts `Ready` and moves it to `Graduating/WrapVara` (L685-688), one step per call. While `Ready`, buys are refused (`check_buy` L212) and sells are refused (`sell` L558 accepts only `Trading | Aborted`). After `graduation_timeout_blocks` from `ready_at`, anyone can `unwind` (L787-791) to `Aborted` (L809), where only sells reopen.

### 3.4 Receipt (L1119-1130)
- `vara` = `vara_gross` for Buy (this is `gross_used`, excluding the sell-out refund paid at L1079), `vara_net` for Sell.
- `fee = fee_creator + fee_protocol` (unchecked add).
- `price_after_e18` from live virtual reserves (state.rs L195-197).

### 3.5 Liability booking (L1131)
`st.owe(fee_creator + fee_protocol)` — `checked_add`, panics `LiabilityOverflow` (state.rs L252-257). Combined with caller pre-await writes:
- Buy: total delta = `owe(net)` + `owe(fee)` = `owe(gross_used)`. Matches value retained (msg value minus refund).
- Sell: total delta = `settle(gross)` + `owe(fee)` + (`owe(net)` only if deferred in `pay_seller` L296-299). If paid immediately, net leaves the balance and is not owed.
This maintains `total_liabilities == Σ escrow + Σ creator_fees + Σ protocol_fees + Σ pending_payouts` (doc at state.rs L218), restricted to the trade's contribution. The Ready transition itself moves no value and changes no liability: `pool_vara` stays inside `escrow` until `step_wrap` (L1186-1190) settles it.

### 3.6 Post-state reads and events (L1134-1170)
- `sold()` = `curve_supply - real_remaining` (state.rs L191-193), `escrow` read in a separate borrow (L1134-1135).
- Buy: emits `Bought` (L1138-1149).
- Sell: `pay_seller` (L288-301): returns false without action if `vara_net == 0` (unreachable from `sell`, which panics on `split.net == 0` at L576); else if `vara_net >= existential_deposit()` and `send_value` returns true, paid; otherwise accrues into `pending_payouts[(token, trader)]` and `owe(vara_net)`. `send_value` (wire.rs L286-291) is `msg::send_bytes_with_gas(to, [], 0, value).is_ok()` — it queues a message; delivery of the value is not observed by the caller.
- Every `emit_event(...).expect("event")` (L1149, L1165, L1169) is a panic site.

## 4. Execution context: panics after the await

`commit_trade` always runs in the continuation after an await (L605/L1081/L638). The comment at L506-507 states "Nothing may panic after the spawn await". Panic sites in `commit_trade`:
- `launch_mut`/`launch` `LaunchNotFound` (state.rs L243, L249);
- `owe` overflow (L1131; and in `pay_seller` L298);
- `emit_event(...).expect("event")` (L1149, L1165, L1169);
- unchecked arithmetic if overflow checks are enabled (L1101-1102, L1127, L1131 argument).

If the continuation panics, the writes made in this execution segment are reverted while the pre-await writes (`apply_buy` / `sell` block, including `busy = Some(pending)` with `stuck: false`) persist. `reconcile` only accepts `busy` with `stuck == true` (L630-632), and `mark_stuck` is only called on `CallError::Timeout` (L611-612, L1088-1089). Whether Gear reverts only the continuation segment is a runtime property (open question).

## 5. Invariants (each with line)

1. After return, `launch.busy == None` (L1103).
2. Trade fee is booked exactly once per committed trade: `creator_fees`/`protocol_fees` += split parts (L1101-1102) and `total_liabilities` += their sum (L1131).
3. `state = Ready` is written only here and only when the committed trade is a Buy and `real_remaining == 0` (L1104-1107).
4. At the Ready flip, `pool_vara + min(escrow, graduation_fee) == escrow` (L1109).
5. At the Ready flip, `wvara_budget == pool_vara` and `token_budget == pool_tokens` (L1111-1112).
6. The Ready flip moves no native value and changes no liability (no `owe`/`settle` on the completed branch, L1106-1118).
7. A Sell's net is either sent or recorded in `pending_payouts` with a matching `owe` (L288-301).

## 6. Assumptions

| Assumption | Established by |
|---|---|
| `launch.busy` holds the same trade as `pending` (same seq) when commit runs | Caller guards: `check_buy` L215, `sell` L561, `graduate` L678, `unwind` L793, `reconcile` L627-634. Not checked in `commit_trade` (L1103). |
| Launch state is `Trading` for a Buy reaching the completion branch | `check_buy` L212 before await; busy guards above prevent state writes during await. Not re-checked at L1104-1107. |
| The VFT transfer actually moved the tokens | `wire::vft_transfer` / `vft_transfer_from` returning `Ok(true)` (L605, L1081) — external VFT program (code set by admin); or `reconcile`'s balance equality L648. |
| `escrow >= graduation_fee` at sell-out so `pool_vara > 0` | Indirectly by `curve_params_for` L241-243 + `derive_params` construction (curve.rs L24-44) and rounding direction; nothing at L1109 enforces it. |
| `fee_creator + fee_protocol` and fee accumulators do not overflow u128 | Nothing found (L1101-1102, L1127 unchecked; L1131 checked only for the liabilities sum). |
| `emit_event` does not fail | Nothing found; `.expect("event")` at L1149/L1165/L1169. |
| `send_value` true means seller receives value | wire.rs L290 — `is_ok()` of message enqueue only. |
| Someone calls `graduate` after Ready | Nothing found in `commit_trade`; `graduate` is permissionless (L670); otherwise `unwind` becomes callable by anyone after timeout (L787-788). |
| `ready_at + graduation_timeout_blocks` fits u32 | Nothing found (L788 unchecked add on `ready_at` written at L1108). |

## 7. Callees

- `State::launch_mut` / `launch` (state.rs L240-250): panic on missing launch.
- `exec::block_height` (gstd, external): source of `ready_at`.
- `Launch::price_e18` -> `curve::price_e18` (curve.rs L78-83): returns 0 if `vt == 0`; `vt` at sell-out is `t0 - curve_supply = a > 0` (curve.rs L38-41).
- `State::owe` (state.rs L252-257): checked add, panics on overflow.
- `Launch::sold` (state.rs L191-193): unchecked U256 sub; `real_remaining <= curve_supply` holds because sells add back only tokens previously bought — not enforced here.
- `pay_seller` (L288-301) -> `wire::existential_deposit` (wire.rs L293-295), `wire::send_value` (wire.rs L286-291), `State::owe`.
- `emit_event` (sails-generated, external black box): `.expect` on result.

## 8. Relation to the graduation-fee split and keeper questions (structure only)

- The split between pool VARA and leftover VARA is decided at L1109: pool = escrow minus a fixed per-launch `graduation_fee`. The leftover is consumed by `step_settle` as pair-creation fee (if we created the pair) and the remainder as `protocol_fees` (L1390-1394) paid to `launch.addrs.treasury` (L860-862). There is no creator component of the leftover in the current code; creator income is trade-fee `creator_fees` only.
- `config.graduation_fee_vara` is documented as covering "pair creation, LP account ED and gas" (state.rs L38-39) and `set_fees` requires it `>= pair_creation_fee_vara` (L1018-1019).
- The Ready flip is the end of the sell-out buy's handling; graduation requires further messages. `graduate` already accepts any caller (L668-670). The last buy cannot run graduation within `commit_trade` because `commit_trade` is synchronous and each graduation step awaits external replies (L706-725).
