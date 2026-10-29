# apply_buy / revert_trade — app/src/service.rs L157-L200

## 1. Purpose

`apply_buy` (L157-L182) moves the curve optimistically for a planned buy, takes a snapshot of the
fields it changes, books the net VARA into `escrow` and `total_liabilities`, and stores the snapshot
in `launch.busy` as the in-flight `PendingTrade`. It is synchronous and called only from `run_buy`
(L1076), before the VFT `Transfer` await (L1081).

`revert_trade` (L184-L200) undoes an applied trade of either side using that snapshot. It restores the
three curve fields and `escrow` absolutely from the snapshot, clears `busy`, and adjusts
`total_liabilities` by the escrow delta it observes at revert time (not by an amount stored in the
snapshot). Callers: `run_buy` failure branch (L1084), `sell` failure branch (L608), `reconcile`
revert branch (L654).

## 2. Inputs and assumptions

### apply_buy
- `st: &mut State` — borrowed through `with_state_mut` (L1076, L272-L274).
- `token` — must exist in `st.launches`; `launch_mut` panics `LaunchNotFound` otherwise (state.rs
  L240-L244). Existence was checked in `check_buy` (L211).
- `buyer` — `msg::source()` (L534) or the launch creator (L317 → L511).
- `plan: &BuyPlan` — produced by `plan_buy` (L128-L154) via `check_buy` (L204-L226). The plan is
  computed from the same launch snapshot that `apply_buy` mutates: in `buy` (L536-L539) and in
  `launch` (L509-L511) there is no await between `check_buy` and `run_buy` → `apply_buy`
  (L1074-L1076 is synchronous). So the curve fields `plan_buy` read are the ones `apply_buy` mutates.
- `apply_buy` itself performs no checks on `state`, `busy`, `lock`, `paused_buys`, slippage or
  zero-output. Each of those is established only in `check_buy` (L205-L224). `apply_buy` overwrites
  `launch.busy` unconditionally (L179).

### revert_trade
- `pending` — either the value `apply_buy`/`sell` returned (run_buy L1076, sell L556-L603) or a clone
  read from `launch.busy` (reconcile L630-L631). Its `prev_*` fields were captured before the
  mutation (L169-L172, L590-L593).
- Assumes `launch.escrow` has not been changed by any other writer since the trade was applied; the
  liability delta (L189-L193) and the absolute restore (L194) are only equal to the trade's own
  contribution under that condition (see §4).
- Assumes `launch.busy` still holds this same trade; it does not compare `pending.seq` against
  `launch.busy` before clearing it (L195).

## 3. Block-by-block

### apply_buy
- L158: `launch_mut` (panics if missing).
- L159: `trade_seq += 1` — u64, with workspace `overflow-checks = true` (contracts/launchpad/Cargo.toml
  L22-L23), so overflow panics. `trade_seq` is not part of the snapshot and is never reverted.
- L160-L174: snapshot. `vara_gross = plan.gross_used` (not `msg::value()`; the excess `plan.refund`
  is excluded). `vara_net`, `fee_creator`, `fee_protocol` from `plan.split`; `split_fee`
  (curve.rs L95-L105) yields `net + creator + protocol == gross_used` (net = gross - fee L100,
  protocol = fee - creator L103, creator ≤ fee L98). `prev_virtual_vara`, `prev_virtual_tokens`,
  `prev_real_remaining`, `prev_escrow` read before L175. `stuck: false`.
- L175: `virtual_vara += net` (U256 `+`; primitive-types/uint `Add` panics on overflow).
- L176: `virtual_tokens -= tokens_out`. Cannot underflow given L177 does not: `derive_params` sets
  `t0 = curve_supply + a` with `a > 0` (curve.rs L38-L41), launch initialises `virtual_tokens = t0`,
  `real_remaining = curve_supply` (L451, L453); buys decrement both by the same amount (L176-L177),
  sells increment both by the same amount (L597-L598), revert restores both from one snapshot
  (L187-L188). So `virtual_tokens - real_remaining == a` throughout.
- L177: `real_remaining -= tokens_out`. `plan_buy` returns `tokens_out < real_remaining` (L132) or
  caps `tokens_out = real_remaining` (L142), so `tokens_out ≤ real_remaining` given the plan is
  fresh (§2).
- L178: `escrow += net` — u128, overflow panics (overflow-checks).
- L179: `busy = Some(pending.clone())`.
- L180: `st.owe(net)` — checked add, panics `LiabilityOverflow` (state.rs L252-L257).
- Not booked here: the fee part `gross_used - net` (creator + protocol). It is in the program's
  native balance from L1076 onward but enters `total_liabilities` only in `commit_trade` (L1131) and
  the per-launch accumulators only at L1101-L1102.
- L181: returns the snapshot by value; the copy in `busy` and the returned copy are equal at return.

### revert_trade
- L185: `launch_mut`.
- L186-L188: absolute restore of `virtual_vara`, `virtual_tokens`, `real_remaining`.
- L189-L193: `escrow_delta` = `escrow - prev_escrow` for Buy, `prev_escrow - escrow` for Sell. Plain
  u128 subtraction; panics if the current escrow is on the wrong side of `prev_escrow`.
  With no intervening writer, Buy delta = `plan.split.net` (L178), Sell delta = `gross` (L599).
- L194: `escrow = prev_escrow` (absolute).
- L195: `busy = None` (no seq comparison).
- L196-L199: Buy → `settle(delta)` (checked sub, panics `LiabilityUnderflow`, state.rs L259-L264),
  reversing `owe(net)` at L180. Sell → `owe(delta)`, reversing `settle(gross)` at L601.
- Not touched: `trade_seq`, `creator_fees`, `protocol_fees`, `state`, `ready_at`, `pool_vara`,
  budgets, `lock`. Fees are not touched because they were never booked before commit (L1101-L1102,
  L1131); `state`/`ready_at`/`pool_vara` because the Ready flip happens only in `commit_trade`
  (L1104-L1112), which does not run on a reverted trade.
- No value movement. Native refunds are the caller's job: `run_buy` pays `vara_gross` (L1085),
  `reconcile` pays `vara_gross` for Buy (L655-L657); Sell revert pays nothing (tokens never moved).

## 4. Cross-function dependencies and interleaving

Exclusion of other `escrow`/curve writers while `busy.is_some()`:
- `check_buy` rejects when `busy.is_some() || lock` (L215).
- `sell` rejects (L561).
- `graduate` rejects busy (L678) — this gates `step_wrap` (`escrow -= pool_vara` L1190) and
  `step_settle` (L1391, L1394).
- `unwind` rejects busy (L793) — gates `unwind_wrapped` (`escrow += pool_vara` L1411).
- `reconcile` only proceeds when `busy` is `Some(stuck)` (L630-L632) and sets `lock` (L634); a second
  reconcile is refused by `lock` (L627).
These are every `escrow` writer found in service.rs (grep of `.escrow ... =`: L178, L194, L599,
L1190, L1391, L1394, L1411). Under this exclusion, at revert time `escrow - prev_escrow` equals the
trade's own delta, so the absolute restore at L194 and the liability delta at L196-L199 agree.

Liability accounting per path (Buy), starting from liabilities L and native balance B before the
message, with msg value V = gross_used + refund:
- apply: L + net; B + V.
- refund paid (L1079): B + gross_used (send result ignored).
- Transfer fails → revert: L; then `pay(buyer, gross_used)` (L1085), B. Fee part never entered L.
- Transfer Ok(true) → commit: L + net + fee (L1131) = L + gross_used.
- Timeout → `mark_stuck` (L233-L237): L + net remains; fee part (gross_used - net) sits in native
  balance outside L, so it is counted in `free_balance` (L973) until reconcile.
- Reconcile revert: same as fail path (L654-L657) except it runs after a second await
  (`vft_balance_of` L638), with `lock` cleared at L639 before `revert_trade` at L654 (no await
  between them).

Liability accounting (Sell): sell's prelude settles `gross` (L601); revert owes the same delta
(L198); commit does `owe(fee)` (L1131) and `pay_seller` either sends `net` or defers it with
`owe(net)` (L293-L299).

`total_liabilities` is global (state.rs L219). Between apply and revert, other launches' trades and
graduation steps may run during the await (L1081, L605, L638) and change it. `settle(delta)` at L197
requires `total_liabilities ≥ delta` at that moment; that holds if every other path's owe/settle is
balanced, which is a global property, not something revert_trade checks.

Panic after await: `revert_trade` executes in the continuation after the transfer reply. If it
panics (L190/L192 subtraction, L197 `LiabilityUnderflow`, L198 `LiabilityOverflow`), Gear rolls back
only that continuation's writes; the pre-await writes from `apply_buy` (curve moved, `busy` set,
`owe(net)`) and the refund send at L1079 stay. The follow-up `pay` at L1085 would not happen.

Reconcile and the snapshot: in reconcile, `reverted_expected` (L645) is computed from
`pending.prev_real_remaining` and `committed_expected` (L644) from the live `launch.real_remaining`
(the post-apply value). `revert_trade` then restores `real_remaining` to the same
`prev_real_remaining` value that defined `reverted_expected`.

## 5. Invariants

1. Snapshot captured before mutation: `prev_*` read at L169-L172 precede writes at L175-L178.
2. `virtual_tokens - real_remaining` is constant (= `a`) across apply (L176-L177) and revert
   (L187-L188).
3. apply/revert are inverse on `(virtual_vara, virtual_tokens, real_remaining, escrow, busy)` —
   L175-L179 vs L186-L195 — and on `total_liabilities` when no other `escrow` writer ran
   (L180 vs L197; L601 vs L198).
4. Fees are not booked until commit: neither function touches `creator_fees`/`protocol_fees`
   (only L1101-L1102), and `total_liabilities` receives the fee only at L1131.
5. `vara_gross == plan.gross_used` excludes `plan.refund` (L164, L149), so the post-revert refund at
   L1085 plus the pre-await refund at L1079 sum to `msg::value()` (L145, L149).
6. `trade_seq` is strictly increasing and not reverted (L159, absent from L184-L200).

## 6. Assumptions and where established

| Assumption | Established by |
|---|---|
| Launch exists | `check_buy` L211; `launch_mut` panics otherwise (state.rs L243) |
| `busy` is None and `lock` false at apply | `check_buy` L215 only; `apply_buy` overwrites L179 without checking |
| Launch is Trading at apply | `check_buy` L212 only |
| Plan computed against current curve state | No await between check_buy and apply_buy (L536-L539, L509-L511, L1074-L1076) |
| `tokens_out ≤ real_remaining` | `plan_buy` L132/L142 |
| `tokens_out ≤ virtual_tokens` | Invariant 2 via `derive_params` `a > 0` (curve.rs L38-L41) |
| No other writer of `escrow` between apply and revert | busy gates at L215, L561, L678, L793; reconcile lock L627/L634 |
| `launch.busy` still equals `pending` at revert | Same gates; revert itself does not compare seq (L195) |
| `total_liabilities ≥ delta` at Buy revert | Global balance of owe/settle across all launches; nothing local |
| `fee_bps ≤ 10000` so split_fee does not underflow | nothing found in this function (curve.rs L96-L100; setter not inspected) |
| Refund send at L1079 and revert-time pay at L1085 succeed | nothing found; `pay` result ignored (L229-L231, wire.rs L286-L291) |

## 7. Callees

- `State::launch_mut` (state.rs L240-L244): panics if missing.
- `State::owe` (state.rs L252-L257): checked add.
- `State::settle` (state.rs L259-L264): checked sub.
- `curve::split_fee` (curve.rs L95-L105), via plan: net + creator + protocol = gross.
- `PendingTrade::clone` (derived, state.rs L124).
- External (by callers, not by these functions): `wire::vft_transfer` → `call` (wire.rs L70-L88)
  classifies `GstdError::Timeout` as `Timeout`, any other reply error as `Reply`, and `up_to`/send
  failure as `Send`; the callee VFT (semi-trusted spawned code) decides `Ok(true)`/`Ok(false)`.
  A VFT that returns `Ok(false)` or errors after having moved tokens leads the caller to revert
  while tokens left the launchpad; this is the outcome reconcile exists for only on the Timeout
  branch.

## 8. Open questions

- unclear; need to inspect `set_fees` for a `fee_bps ≤ 10000` / `creator_fee_bps ≤ fee_bps` bound
  (affects split_fee arithmetic used to build the snapshot).
- unclear; need to confirm gstd 1.10 rollback semantics for a panic in an async continuation
  (whether pre-await writes from `apply_buy` and the L1079 send persist as described in §4).
- unclear; need to inspect the Tokenator VFT `Transfer` implementation to confirm it cannot return
  `Ok(false)` / an error reply after debiting the launchpad (the run_buy revert branch L1083-L1086
  assumes no tokens moved).
