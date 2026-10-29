# run_buy — app/src/service.rs L1068-L1094

## 1. Purpose

Internal (non-exported) async helper that executes a pre-validated `BuyPlan`: it moves the curve and
records the in-flight trade (`apply_buy`), pays any sell-out refund, sends one `Vft.Transfer` of
`pending.tokens` from the launchpad to the buyer, and then, depending on the reply outcome, commits
(`commit_trade`), reverts and refunds (`revert_trade` + `pay`), or marks the trade stuck (`mark_stuck`)
for later `reconcile`.

There is exactly one await (L1081). Everything before it is persisted when the message suspends;
everything after it runs in the reply continuation.

## 2. Callers and what they hand in

| Caller | Line | Plan origin | Result handling |
|---|---|---|---|
| `buy` (exported, payable) | L539 | `check_buy(st, &token, msg::value(), min_tokens_out)` at L536-538; `Err` -> panic, so attached value returns to sender | Result returned to the buyer |
| `launch` (exported, payable) | L511 | `check_buy(st, &token, value, first_buy_min_tokens_out)` at L509; `Err` -> explicit `pay(creator, value)` L514 | Result discarded with `let _ =` (L511); `launch` returns `Ok(token)` at L519 regardless of `TransferFailed` / `TradeStuck` |

What `check_buy` (L204-226) establishes and run_buy relies on:
- buys not paused (L205), `gross >= min_trade_vara` (L208), launch exists (L211), `state == Trading` (L212),
  `busy.is_none() && !lock` (L215), `tokens_out >= min_tokens_out` (L219), `tokens_out != 0` (L222).
- All of these are checked in a `with_state` borrow; the caller then calls run_buy, which re-borrows mutably at
  L1076. No await separates `check_buy` from `apply_buy` in either caller (buy: L536-539; launch: L509-511), so the
  checked state is the state `apply_buy` mutates.

What `plan_buy` (L128-154) establishes:
- Non-sell-out path (L132-139): `tokens_out < real_remaining`, `refund = 0`, `gross_used = gross`.
- Sell-out path (L141-153): `tokens_out = real_remaining`; `net_needed = min(buy_cost_for_tokens(...), net)` (L143-144);
  `gross_used = min(gross_for_net(net_needed, fee_bps), gross)` (L145); `refund = gross - gross_used` (L149), which
  cannot underflow because of the `.min(gross)` at L145. `split` is recomputed on `gross_used` (L146), so
  `split.net` may differ from `net_needed` by fee rounding; nothing re-checks that `split.net >= net_needed`.
- `completes_curve` is set but run_buy never reads it; completion is recomputed in `commit_trade` from
  `real_remaining.is_zero()` (L1104).

## 3. Block-by-block

### 3.1 Gas snapshot (L1074)
`self.gas()` (L276-278) clones `st.config.gas` live. The snapshot is taken once and used for the single transfer.
Admin `set_gas` (L1001) during the await does not affect this call.

### 3.2 apply_buy (L1076, body L157-182)
Single `with_state_mut` borrow:
- `trade_seq += 1` (L159); `PendingTrade` built with `vara_gross = plan.gross_used` (L164), `vara_net = split.net`
  (L165), fees (L166-167), `tokens = tokens_out` (L168), and absolute snapshots of `virtual_vara`, `virtual_tokens`,
  `real_remaining`, `escrow` (L169-172); `stuck = false` (L173).
- Curve move: `virtual_vara += net` (L175), `virtual_tokens -= tokens_out` (L176), `real_remaining -= tokens_out`
  (L177), `escrow += net` (L178). L177 cannot underflow because `plan_buy` caps `tokens_out <= real_remaining`
  (L132/L142). L176: `tokens_out <= real_remaining` and the relation `real_remaining <= virtual_tokens` is not
  checked here (see assumptions). `U256` subtraction panics on underflow; `escrow` is `u128` `+=` (overflow behavior
  depends on build profile; unclear, see open questions).
- `busy = Some(pending.clone())` (L179) — this is the lock that serialises the launch across the await.
- `st.owe(split.net)` (L180, checked add L252-257). Only the net is booked as a liability here; the fee portion
  (`gross_used - net`) and the refund are not.

Accounting at this point (relative to the moment before the message): program balance `+gross`
(attached value), `total_liabilities +net`.

### 3.3 Refund before the await (L1077-1080)
`pay(buyer, refund)` -> `wire::send_value` (L286-291): returns `true` for 0, else
`msg::send_bytes_with_gas(to, [], 0, value).is_ok()`. The boolean is discarded at L1079. If the send is refused,
the refund amount remains in the program balance and is not recorded in `total_liabilities` or
`pending_payouts`; `top_up_reserve` / `free_balance` compute free balance as
`value_available - total_liabilities` (L1063), so such an amount is counted as free.

The send uses gas 0 (L290). The comment at L284-285 states this targets "a user" so it bypasses the mailbox.
`buyer` is `msg::source()` (L534) or the launch creator (L317), which may be a program; nothing in run_buy or its
callers restricts it to a user account.

The refund is sent before the transfer is known to succeed; all later paths (commit, revert, stuck) assume it has
already been delivered. Revert pays `pending.vara_gross` = `gross_used` (L1085), not `gross`, so the total returned
on a reverted sell-out buy is `refund + gross_used = gross` only if both sends succeed.

### 3.4 The await: `wire::vft_transfer(token, buyer, pending.tokens, &gas)` (L1081)
`vft_transfer` (wire.rs L163-165) -> `call_typed` (L90-109) -> `call` (L70-88):
- `msg::send_bytes_with_gas_for_reply(dest, payload, gas_for_token_ops, 0, gas_for_reply_deposit)`; a synchronous
  send error -> `CallError::Send` (L78-79).
- `.up_to(Some(reply_timeout))` error -> `CallError::Send` (L81-82).
- awaited reply: `GstdError::Timeout` -> `CallError::Timeout`; any other error -> `CallError::Reply` (L84-87). This
  includes error replies caused by a callee panic or out-of-gas.
- success bytes -> `decode_reply::<bool>("Vft","Transfer", bytes)` (L45-53): mismatched service/method prefix or
  undecodable body -> `CallError::Decode`.

So the outcome space is `Ok(true) | Ok(false) | Err(Send|Reply|Decode|Timeout)`. The `match` at L1081-1093 is
exhaustive over these.

During the await, other messages may execute. With `busy = Some`:
- `check_buy` rejects (L215) -> `buy` panics, `launch` first-buys of *this* token are impossible anyway.
- `sell` panics (L561).
- `graduate` panics (L678).
- `unwind` panics (L793).
- `reconcile` panics `NotStuck` because `stuck == false` (L630-633).
- Not gated by `busy`: `claim_creator_fees`, `claim_protocol_fees`, `claim_payout`, admin setters, `top_up_reserve`,
  queries, and every action on other launches. `commit_trade` later adds to `creator_fees`/`protocol_fees` with `+=`
  (L1101-1102), so concurrent claims that zero those fields do not conflict with an absolute restore.

### 3.5 Ok(true) -> commit_trade (L1082)
Read in 02-commit_trade.md. What run_buy depends on (L1098-1172):
- fees booked into the launch (L1101-1102) and `st.owe(fee_creator + fee_protocol)` (L1131). Since
  `split.protocol = fee - creator` (curve.rs L104), after commit liabilities have grown by `net + fee = gross_used`.
- `busy = None` (L1103).
- If `real_remaining.is_zero()` (L1104): `state = Ready`, `ready_at = block_height`, `pool_vara = escrow
  .saturating_sub(graduation_fee)` (L1109), budgets reset (L1111-1112), `Ready` event (L1168-1170). run_buy does
  not start graduation; no graduation step is invoked from this path.
- `Bought` event via `emit_event(...).expect("event")` (L1138-1149).

### 3.6 Ok(false) | Send | Reply | Decode -> revert + refund (L1083-1087)
- `revert_trade` (L184-200): restores the four curve fields and `escrow` from absolute snapshots (L186-188, L194),
  clears `busy` (L195), and `st.settle(escrow - prev_escrow)` (L190, L197) = `settle(net)`, undoing L180.
- `pay(buyer, pending.vara_gross)` (L1085); return value discarded. On refusal, `gross_used` stays in the balance
  unrecorded (same structure as 3.3).
- Returns `Err(TransferFailed)` (L1086) — a normal reply, not a panic, so the state writes in this continuation
  persist.
- `trade_seq` is not decremented by `revert_trade`; seq numbers are consumed by reverted trades.

The four error kinds are treated as "the transfer did not happen". For `Send` this follows from no message being
dispatched (L79) or the timeout wrapper failing (L82; whether the message was already queued at that point is
not determined in-repo, see open questions). For `Ok(false)`, `Reply`, and `Decode` it depends on the VFT program's
behaviour (see assumptions): `Decode` in particular is produced from a *success* reply whose bytes did not match
(L49-52), and nothing establishes that a success reply with an unexpected encoding implies no balance change.

### 3.7 Timeout -> mark_stuck (L1088-1092)
- `mark_stuck` (L233-237) sets `busy.stuck = true` if `busy` is `Some`; it is `Some` because only `commit_trade`,
  `revert_trade`, and `reconcile` clear it and all are blocked/unreachable while this trade is unresolved.
- Emits `TradeStuck` with `.expect("event")` (L1090).
- Returns `Err(TradeStuck)`.
- Persistent state left: curve moved, `escrow` includes `net`, liabilities include `net`, fees not booked, `busy`
  stuck. `gross_used - net` sits in the balance unrecorded until `reconcile` (L622-664) commits (books fees via
  `commit_trade`) or reverts (L654-657, pays `vara_gross`, refund already paid at L1079).
- The VFT reply may still arrive after the timeout; gstd drops it (no handler resumes). The token transfer may or
  may not have executed.
- Until reconcile, the launch is blocked for buy/sell/graduate/unwind (3.4). For a sell-out buy, the `Ready`
  transition is deferred to `reconcile`'s `commit_trade` (L649).

`reconcile` decides by `held == real_remaining + pool_tokens` (commit) or `held == prev_real_remaining +
pool_tokens` (revert) (L641-653), else `Unreconcilable` and `busy` stays stuck. This presumes the launchpad's VFT
balance equals exactly curve-unsold + pool tokens.

## 4. Execution context: panics after the await

Under gstd async semantics, state written before `.await` (apply_buy, the refund send) is committed when the
message waits; a panic in the reply continuation rolls back only the continuation. Panic sites reachable after
L1081:
- `commit_trade`: `launch_mut` (state.rs L240-244, cannot miss here), `st.owe` overflow (L252-257), `+=` on
  `creator_fees`/`protocol_fees` (u128), `emit_event(...).expect("event")` (L1149, L1169).
- revert path: `st.settle` underflow (L259-264), `launch.escrow - pending.prev_escrow` (L190).
- stuck path: `emit_event(...).expect("event")` (L1090).

If any of these panic, the continuation's writes (including `busy = None` or `stuck = true`) are discarded and
`busy` remains `Some` with `stuck == false`, which `reconcile` rejects (L630-633), `check_buy`/`sell`/`graduate`/
`unwind` reject. The launch comment at L506-508 states "Nothing may panic after the spawn await"; nothing in-repo
establishes that `emit_event` cannot fail.

## 5. Invariants (each with line)

1. While the transfer is in flight, `launch.busy == Some(pending)` with `stuck == false` (L179, L173); every
   curve/escrow writer on this launch checks `busy` (L215, L561, L678, L793), so `revert_trade`'s absolute restore
   (L186-194) does not clobber another trade's writes.
2. `tokens_out <= real_remaining` at apply time (plan_buy L132/L142), so L177 does not underflow.
3. `refund + gross_used == gross` (L145 `.min(gross)`, L149).
4. Liability booking across the trade: `+net` at apply (L180); `+fee` at commit (L1131) giving `+gross_used`; `-net`
   at revert (L197) giving 0; `+net` held while stuck.
5. Exactly one outbound transfer request per call, for `pending.tokens` to `buyer` (L1081).
6. On every non-panicking path, run_buy returns a `Result` rather than panicking, so continuation writes persist
   (L1082, L1086, L1091).
7. Completion (`Ready`) is decided only in `commit_trade` from `real_remaining.is_zero()` (L1104); run_buy itself
   never transitions state beyond `busy`.

## 6. Assumptions

| Claim | Established by |
|---|---|
| Launch is Trading, not busy/locked, plan satisfies slippage and non-zero output | `check_buy` L204-226, called synchronously before run_buy in both callers (L509, L537) |
| No await between `check_buy` and `apply_buy` | caller structure L536-539 and L509-511 |
| `tokens_out <= virtual_tokens` so L176 does not underflow | indirectly: `buy_tokens_out` returns `< vt` for non-sell-out (curve.rs L51); sell-out sets `tokens_out = real_remaining`, and `real_remaining <= virtual_tokens` is not checked anywhere found — nothing found in run_buy/apply_buy; depends on `derive_params` producing `t0 >= curve_supply` (not inspected here) |
| Refund send succeeds | nothing found (return discarded L1079) |
| Revert refund send succeeds | nothing found (return discarded L1085) |
| `buyer` is a user account, so a gas-0 value send is delivered immediately | nothing found (comment only, wire.rs L284-285) |
| `Ok(false)` from VFT means no balance moved | nothing found; VFT is a spawned program whose code_id is admin-set |
| `Err(Reply)` means no balance moved | Gear runtime rollback of a failed callee execution; not in-repo |
| `Err(Decode)` means no balance moved | nothing found (Decode arises from a success reply, wire.rs L47-52) |
| `Err(Send)` from `up_to` (L82) means no message was dispatched | unclear; see open questions |
| `Ok(true)` means the buyer received exactly `pending.tokens` | nothing found; trusted from the VFT reply |
| Launchpad VFT balance equals `real_remaining + pool_tokens`, enabling reconcile of a stuck buy | nothing found in run_buy; `reconcile` L641-653 relies on it |
| `emit_event` does not fail after the await | nothing found (`.expect("event")` L1090, L1149, L1169) |
| Gas snapshot at L1074 is sufficient for the transfer and reply | admin config `set_gas` L1001; not validated |

## 7. Callees

| Callee | Kind | What run_buy depends on |
|---|---|---|
| `self.gas()` L276 | internal | Live clone of `config.gas` for this transfer |
| `apply_buy` L157-182 | internal | Curve move, `escrow += net`, `busy = Some`, `owe(net)`; returns the pending snapshot used by every later branch |
| `pay` L229 -> `wire::send_value` wire.rs L286-291 | internal / runtime | Value send with gas 0; returns bool that run_buy ignores |
| `wire::vft_transfer` wire.rs L163 -> `call_typed` L90 -> `call` L70 -> `decode_reply` L45 | internal wrappers over gstd | Maps every outcome into `Ok(bool)` or one of four `CallError`s; Timeout distinguished from other errors |
| Spawned VFT `Vft.Transfer` | external, semi-trusted (code_id admin-set) | Truthful bool; transfer from launchpad's own balance; no balance change on false/error |
| `commit_trade` L1098-1172 | internal | Books fees + `owe(fee)`, clears busy, flips Ready on sell-out, emits Bought/Ready |
| `revert_trade` L184-200 | internal | Absolute restore of curve/escrow, clears busy, `settle(net)` |
| `mark_stuck` L233-237 | internal | Sets `stuck = true` so `reconcile` (L631) accepts the trade |
| `emit_event` (sails) | external-source-available (not inspected) | Assumed infallible (`expect`) |

## 8. Relation to the graduation and keeper questions (structure only)

- The sell-out buy is the only path that sets `real_remaining` to zero; its success branch flips `Ready` inside
  `commit_trade` (L1104-1118). Graduation is a separate `graduate` call (L670), which is already permissionless;
  run_buy performs no graduation work and sends only one outbound message.
- If the sell-out buy times out, `Ready` is not reached until `reconcile` commits (L649), and `graduate` is blocked
  by `busy` (L678) in the meantime.
- The VARA that becomes `pool_vara` is `escrow - graduation_fee` at commit time (L1109). The fees of the sell-out
  buy are booked to `creator_fees`/`protocol_fees` (L1101-1102), not to escrow, so they are outside `pool_vara`.
