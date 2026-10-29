# LaunchpadService::run_buy — micro analysis

File: `contracts/launchpad/launchpad/app/src/service.rs` L1068-L1094 (internal, not exported).
Callers: `launch` (L511, first buy, result discarded with `let _ =`) and `buy` (L539, result returned).

## 1. Purpose

Takes a `BuyPlan` already validated by `check_buy` (L204-226), moves the curve and books the net
VARA as escrow (`apply_buy`), returns any sell-out excess to the buyer before the await, sends a
`Vft.Transfer(buyer, tokens)` to the token program and resolves on the reply:

| Reply outcome | Branch | State effect | Value effect |
|---|---|---|---|
| `Ok(true)` | L1082 | `commit_trade`: fees booked, `busy=None`, maybe `Ready` | none (gross kept) |
| `Ok(false)`, `Send`, `Reply`, `Decode` | L1083-1087 | `revert_trade`: curve + escrow restored, `busy=None`, `settle(net)` | `pay(buyer, vara_gross)` |
| `Timeout` | L1088-1092 | `mark_stuck`: `busy.stuck=true` | none (gross kept, fees unbooked) |

## 2. Inputs and preconditions

- `token`, `buyer` (= `msg::source()` at L534 or creator at L317), `plan` by value.
- `plan` was computed by `check_buy` against the state at that moment. Both callers invoke
  `run_buy` synchronously after `check_buy` with no await in between (L536-539; L509-511), so the
  snapshot is the same state `apply_buy` writes into. `check_buy` established: buys not paused
  (L205), gross >= min_trade_vara (L208), launch exists (L211), `state == Trading` (L212),
  `busy.is_none() && !lock` (L215), `tokens_out >= min_tokens_out` (L219), `tokens_out != 0` (L222).
- `run_buy` itself re-checks none of these.
- The value backing `plan.gross_used + plan.refund` (= `gross`, L134/L149) is `msg::value()` of the
  current message (L535 / L318). `run_buy` does not read `msg::value()`; the identity
  `plan.gross_used + plan.refund == msg::value()` is established by `plan_buy` L134 (refund 0,
  gross_used = gross) and L145/L149 (`gross_used = min(..., gross)`, `refund = gross - gross_used`).
- In `launch`, `value` was also included in the reserve check `exec::value_available().saturating_sub(value)` (L369-371).

## 3. Block-by-block

### L1074 `let gas = self.gas();`
Reads live `config.gas` (L276-278). Admin `set_gas` (L998-1002) can change it between messages; the
value used for this call is the one at entry.

### L1075-1076 apply_buy (L157-182)
- `launch_mut` panics `LaunchNotFound` if absent (state.rs L240-244); unreachable given `check_buy` L211.
- `trade_seq += 1` (L159) — u64, overflow-checks on (Cargo.toml L23).
- Snapshot `PendingTrade` with `prev_*` fields and `stuck:false` (L160-174). `vara_gross = plan.gross_used`
  (L164), not the full `gross`; the refunded excess is not in the snapshot.
- Curve moves: `virtual_vara += net` (L175), `virtual_tokens -= tokens_out` (L176),
  `real_remaining -= tokens_out` (L177), `escrow += net` (L178, u128, panics on overflow per
  overflow-checks). U256 subtraction panics on underflow. `tokens_out <= real_remaining` holds by
  `plan_buy` L132 (strict <) or L142 (= real_remaining). `real_remaining <= virtual_tokens` relies on
  `virtual_tokens = t0 - sold = a + real_remaining` with `t0 = curve_supply + a` (curve.rs L41) and
  both decremented by the same amount in buy (L176-177) and incremented by the same amount in sell
  (L597-598).
- `busy = Some(pending.clone())` (L179) — this is the per-launch mutex every other mutating path
  checks (L215, L561, L630-632, L678, L793).
- `st.owe(net)` (L180): only the net leg is booked as liability. The fee leg
  (`fee_creator + fee_protocol`) is held in the program's balance but not in `total_liabilities`
  until `commit_trade` L1131.
- A panic inside `apply_buy` occurs before the await, so the whole message reverts and the
  attached value returns with the error reply (Gear semantics; not in repo).

### L1077-1080 refund before the await
- Only on the sell-out branch of `plan_buy` can `refund > 0` (L149).
- `pay` → `wire::send_value` (L229-231, wire.rs L286-291): `value == 0` → `true`; otherwise
  `msg::send_bytes_with_gas(to, [], 0, value).is_ok()`. Gas limit 0.
- The `bool` result is discarded at L1079. If the send is rejected (`is_ok()==false`), the refund
  amount stays in the program balance and is in no liability counter (it was never `owe`d; apply_buy
  owes only `split.net` of `gross_used`).
- The send happens before the await. In Gear, a message's outgoing sends are committed when the
  execution reaches `wait` (the await), so the refund is dispatched regardless of how the transfer
  resolves (runtime semantics, not in repo). On the revert branch the buyer gets `vara_gross`
  (= gross_used) back at L1085; refund + vara_gross = gross (plan_buy L149), so the full attached
  value is returned across the two sends when both are accepted.

### L1081 the await — `wire::vft_transfer(token, buyer, pending.tokens, &gas)`
Path: `vft_transfer` (wire.rs L163-165) → `call_typed::<bool>` (L90-109) with gas
`gas_for_token_ops`, value 0, reply deposit `gas_for_reply_deposit`, timeout `reply_timeout` →
`call` (L70-88):
- `msg::send_bytes_with_gas_for_reply` fails → `Send` (L78-79). Message not sent.
- `up_to(Some(timeout))` fails → `Send` (L81-82). The message has already been sent at L78 at this
  point; `Send` here does not imply the transfer did not execute. Unclear when `up_to` can fail (gstd).
- Awaited reply error: `GstdError::Timeout` → `Timeout`; any other error (callee panic/error reply,
  e.g. VFT `InsufficientBalance` panic at vft lib.rs L132) → `Reply` (L84-87).
- Successful reply bytes decoded by `decode_reply` (L45-53): service must be "Vft", method
  "Transfer", then `bool`; mismatch or bad bytes → `Decode`.

Callee (`Vft.Transfer`, vft lib.rs L344-352 → `State::transfer` L125-140):
- `from == to || value == 0` → returns `false`, no state change (L126-128). `value != 0` by
  `check_buy` L222; `from == to` occurs only when `buyer == launchpad` program id.
- Insufficient balance → panic (L132) → error reply → `Reply`; VFT state rolled back.
- Otherwise moves balance, emits event, returns `true`.
- The token program is the one spawned by `launch` from `config.vft_code_id` (L411-413), which is
  admin-chosen; the in-repo VFT is described above, other code is not.

While suspended, any message may run against shared `State` (sails `RefCell`, borrow released
before the await since `with_state_mut` closures return at L1076). The `busy` mutex keeps
other trade/graduation/unwind paths off this launch (L215, L561, L678, L793). `reconcile`
requires `busy.stuck == true` (L630-632), and `stuck` is false during the await (L173), so
reconcile panics `NotStuck`. Paths that do not check `busy`: `claim_creator_fees` (L819-846),
`claim_protocol_fees` (L849-872), `claim_payout` (L875-897), admin setters (L984-1058),
`top_up_reserve` (L1062), `launch` (other tokens), queries. None of these write the launch's
curve fields, `busy`, or `escrow`; claims write `creator_fees`/`protocol_fees` (L840, L866), which
the pending fees are not yet added to.

### L1082 Ok(true) → `commit_trade(token, &pending)` (L1098-1172)
- Adds `fee_creator`/`fee_protocol` to launch counters (L1101-1102) with `+=` (overflow panics).
- `busy = None` (L1103) unconditionally — no seq comparison.
- `completed = side == Buy && real_remaining == 0` (L1104) → `state = Ready`, `ready_at`,
  `pool_vara = escrow.saturating_sub(graduation_fee)` (L1109), budgets (L1111-1112), Ready event.
- `st.owe(fee_creator + fee_protocol)` (L1131) — after this, booked liability for the trade is
  `net + fee = gross_used` (curve.rs L100-104: `net = gross - fee`, `protocol = fee - creator`).
- Emits `Bought` (L1138-1149) with `.expect("event")`, Ready event (L1168-1170).
- Any panic in commit_trade (overflow, event) occurs after the await: in Gear the post-await
  continuation's changes revert while pre-await changes (apply_buy, refund send) remain committed
  (runtime semantics). The resulting state would be `busy = Some(stuck:false)` with no live future;
  every busy-guarded path refuses it and reconcile requires `stuck` (L631). Same outcome if the
  continuation runs out of the `gas_for_reply_deposit` gas.

### L1083-1087 Ok(false) | Send | Reply | Decode → revert + refund gross_used
- `revert_trade` (L184-200): restores `virtual_vara`, `virtual_tokens`, `real_remaining`, `escrow`
  from the snapshot; `escrow_delta = escrow - prev_escrow` (L190) — equals `net` because nothing
  else wrote `escrow` while `busy` was set (see suspension section); `busy = None`; `settle(delta)`.
- `pay(buyer, pending.vara_gross)` (L1085); bool result discarded. If rejected, the gross_used
  amount stays in balance and is in no liability counter (net was just settled; fee was never owed).
- Returns `Err(TransferFailed)`. For `buy`, this is a successful message reply carrying an `Err`
  value, so the runtime does not return attached value; the explicit `pay` is the only return path.
- This branch treats `Send` (including the post-send `up_to` failure), `Reply`, and `Decode` as
  "transfer did not happen". For `Decode`, the callee replied successfully, so its state changes
  persisted; whether tokens moved depends on the callee's behavior, not checked here.

### L1088-1092 Timeout → mark_stuck
- `mark_stuck` (L233-237) sets `stuck = true` on whatever `busy` holds; no seq check. Only this
  future can have changed `busy` since L1076 (guards cited above), so it is this trade's pending.
- Emits `TradeStuck`, returns `Err(TradeStuck)`. No value moves; gross_used stays in balance with
  `net` booked and the fee leg unbooked. The trade is then resolved only by `reconcile`
  (L622-664), which commits or reverts based on the launchpad's VFT balance and, on revert, pays
  `vara_gross` (L655-657).
- The timeout branch defers to reconcile the question of whether the transfer executed. Whether the
  Transfer message can still execute after the timeout fires (e.g. it is delayed in the queue) and
  whether a late reply is ignored by gstd are runtime questions, not answered in repo.

## 4. Value custody per branch (gross = msg::value)

| Branch | Out of program | Booked liability delta | Unbooked residue in balance |
|---|---|---|---|
| commit | refund (if accepted) | +gross_used | 0 (refund rejected → refund) |
| revert | refund + gross_used (if accepted) | 0 | 0, or rejected amounts |
| timeout | refund (if accepted) | +net | fee (until reconcile), plus rejected refund |
| post-await panic | refund | +net | fee, permanently with `busy` set |

During the in-flight and stuck windows the unbooked fee leg is counted as "free" by
`launch`'s reserve check (L369-372) and `top_up_reserve` (L1063), both of which compute
`value_available - total_liabilities`.

## 5. Caller-specific notes

- `launch` (L505-518): first buy discards `run_buy`'s result (`let _`) and returns `Ok(token)`
  (L519); a `TransferFailed` or `TradeStuck` is not surfaced in the reply. `check_buy` at L509 uses
  live config/paused flag post-spawn-await; the launch was just inserted with `busy: None, lock:false`.
- `buy` (L525-540): the deadline check (L531) and `check_buy` panic before state changes, returning
  value.

## 6. Invariants / assumptions summary

See structured record. Key unenforced items: discarded `pay` results (L1079, L1085); `Decode`
and post-send `Send` treated as non-execution (L1083); post-await panic/out-of-gas leaves
`busy` set with `stuck=false` (L173, L631); no seq check in `mark_stuck`/`commit_trade`.
