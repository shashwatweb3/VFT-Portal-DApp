# sell — app/src/service.rs L542-L617

## Purpose
`sell` is an exported, async, non-payable entrypoint. A token holder sells `amount` curve tokens back to the
bonding curve. The function moves the curve, the escrow and the global liabilities, and stores a `PendingTrade` snapshot in `launch.busy`.
All of this happens **before** the single await (`Vft::TransferFrom(seller -> launchpad)`).
The reply outcome then picks one of three paths:
- commit: fees are booked, and the seller is paid or the payout is deferred;
- revert: the snapshot is restored;
- stuck: state stays moved, `busy.stuck = true`, and `reconcile` resolves it later.

## Inputs and actors
- `msg::source()` = seller (untrusted; may be a user or a program) (L554).
- `token: ActorId` is the key into `State.launches`. `st.launch` panics `LaunchNotFound` if the key is absent (state.rs L246-L250).
- `amount: U256` is the number of tokens to sell. The only check is that it is non-zero (L564). Before the await, nothing checks it against `launch.sold()` or the seller's balance.
- `min_vara_out: u128` is the slippage floor on the **net** amount (L573).
- `deadline_block: u32` is compared to `exec::block_height()` (L551).
- `msg::value()` must be 0 (`ensure_no_value`, L122-L126, called L550).

## Phase 1 — synchronous, pre-await (L550-L603)
Every check in this phase panics on failure. Gear reverts every state write of the current execution on panic, and no await
has happened yet, so a panic here leaves no state behind.

1. L550: the call must carry no value. L551-L553: the deadline check.
2. L555: `gas = self.gas()` clones `st.config.gas`, read live (L276-L278). It is not snapshotted per launch.
3. L558: state gate. Only `Trading` or `Aborted` pass. `Ready`, `Graduating`, `Failed` and `Graduated` are excluded.
4. L561: mutual exclusion, `busy.is_none() && !lock`. This is the only guard that keeps two trades on one launch from overlapping, and the same for a trade and a graduation step, or a trade and a reconcile.
5. L564: `amount != 0`.
6. L567: `gross = sell_vara_out(vs, vt, amount) = vs*amount / (vt+amount)` (curve.rs L70-L75). Because
   `amount > 0`, `gross < vs` whenever `vs > 0` and `vt > 0`, so L596 `virtual_vara -= gross`
   cannot underflow. `saturating_mul` (curve.rs L74) caps the numerator at U256::MAX instead of panicking.
7. L568: escrow bound, `gross <= escrow`, else `EscrowExhausted`. This is the only check that keeps
   L599 `escrow -= gross` from underflowing. It also makes the L571 `low_u128()` lossless.
8. L572: `split_fee(gross, launch.fee_bps, launch.creator_fee_bps)` (curve.rs L95-L105):
   - `fee = gross*fee_bps/1e4`
   - `creator = min(gross*creator_bps/1e4, fee)`
   - `net = gross - fee`
   - `protocol = fee - creator`

   The fee bps are the launch's snapshot (state.rs L186-L187, written at launch L480-L481). `net + creator + protocol == gross` holds exactly.
   `gross * fee_bps` is plain `u128` multiplication (curve.rs L96-L97).
9. L573: slippage check on `split.net`. L576: `split.net != 0`.
10. L579-L602: mutation.
    - `trade_seq += 1` (L580). The `PendingTrade` snapshot records the pre-trade `virtual_vara`, `virtual_tokens`,
      `real_remaining` and `escrow` (L581-L595).
    - `virtual_vara -= gross` (L596), `virtual_tokens += amount` (L597), `real_remaining += amount` (L598),
      `escrow -= gross` (L599), `busy = Some(pending)` (L600).
    - `st.settle(gross)` (L601): `total_liabilities -= gross`, which panics `LiabilityUnderflow` on underflow (state.rs L259-L264).
      The full gross (net plus both fees) leaves the liability total here. The fees come back only at commit (L1131), and the net only if the payout is deferred (L298).

This phase does not check:
- `st.paused_buys` (only `check_buy` reads it, L205);
- `config.min_trade_vara` (buys only, L208);
- `amount <= launch.sold()`;
- `real_remaining + amount <= curve_supply`.

## Phase 2 — the await (L604-L605)
The call chain is `wire::vft_transfer_from(token, seller, me, amount, &gas)` (wire.rs L167-L175), then `call_typed`
(wire.rs L90-L109), then `call` (wire.rs L70-L88).
- If `msg::send_bytes_with_gas_for_reply` fails, the result is `CallError::Send` (L78-L79). If `up_to` fails, the result is also `Send` (L81-L82).
- On an await error, `GstdError::Timeout` maps to `Timeout`. Any other error (callee panic or error reply) maps to `Reply` (L84-L87).
- The reply is decoded by `decode_reply` (wire.rs L45-L53). The service/method prefix must equal `"Vft"`/`"TransferFrom"`, else the result is `Decode`. The body is decoded as `bool`.
- `token` is the program spawned from `config.vft_code_id` (L411-L417), so it is semi-trusted. The VFT's
  initial supply goes to `admin_id = exec::program_id()` (L401; fungible-token vft/mod.rs L70-L72).
  The tokens outside the launchpad therefore total `sold()` only as long as nothing else mints tokens or moves launchpad-held tokens.
- The gas values (`gas_for_token_ops`, `gas_for_reply_deposit`, `reply_timeout`) come from live config (L555).

Other messages execute during the await. On this launch, every state-changing entrypoint that
touches the curve or escrow is gated on `busy`: `check_buy` L215, `sell` L561, `graduate` L678, `unwind` L793.
`reconcile` requires `busy.stuck` (L631), which is false while the call is in flight (L594).

Entrypoints not gated on `busy`:
- `claim_creator_fees` (L819-L846)
- `claim_protocol_fees` (L849-L872)
- `claim_payout` (L875-L897)
- queries, other launches' trades, `launch`, admin setters

These touch `total_liabilities`, `creator_fees`, `protocol_fees`, `pending_payouts` and config, but not this launch's
escrow or curve.

While the call is in flight, `total_liabilities` is `gross` lower than its value after commit or after revert,
even though the native VARA is still held. Three readers see this lowered figure: `free_balance` (L973), `top_up_reserve` (L1063) and the
`LowReserve` check in `launch` (L369-L373).

Also while in flight, `real_remaining` exceeds `curve_supply` if `amount > sold()`. `Launch::sold()`
(state.rs L191-L193) is an unchecked U256 subtraction. It is called in `commit_trade` (L1135) and `progress_bps`
(state.rs L199-L204). `launch_info` (L942-L944) returns the struct without calling it.

## Phase 3 — outcomes (L605-L616)
### `Ok(true)`: `commit_trade(token, &pending)` (L1098-L1172)
- `creator_fees += fee_creator`, `protocol_fees += fee_protocol`, `busy = None` (L1101-L1103).
- `completed` is false for sells (L1104), so there is no state flip.
- `st.owe(fee_creator + fee_protocol)` (L1131).
- `sold()` is evaluated (L1135) and panics if `real_remaining > curve_supply`.
- `pay_seller` (L288-L301):
  - If `net >= existential_deposit()` and `send_value(trader, net)` returns true, the seller is paid and no liability is added.
  - Otherwise `pending_payouts[(token, trader)] += net` and `owe(net)`.
  - `net == 0` returns early, which sell cannot reach (L576).
- `send_value` (wire.rs L286-L291) sends with gas 0 and reports only whether the send was queued
  (`is_ok()`). It does not observe whether the value was delivered.
- Events are emitted with `.expect("event")` (L1153-L1165).

### `Ok(false) | Send | Reply | Decode`: `revert_trade` (L184-L200)
- vs, vt, `real_remaining` and escrow are restored from the snapshot, and `busy = None`.
- It calls `owe(prev_escrow - launch.escrow)` (L192, L198). The delta is recomputed
  from the current `launch.escrow`, so it equals `gross` only if nothing wrote escrow while `busy` was set.
- No VARA moves, because the seller attached none.

### `Timeout`: `mark_stuck` (L233-L237)
- `busy.stuck = true`. Curve, escrow and liabilities stay in the moved state, and a `TradeStuck` event is emitted.
- The launch then rejects buy, sell, graduate and unwind (all gated on `busy`) until `reconcile` (L622-L664) resolves it:
  - commit iff the launchpad VFT balance `== real_remaining + pool_tokens` (the post-sell value, L644, L648);
  - revert iff the balance `== prev_real_remaining + pool_tokens` (L645, L653);
  - any other balance returns `Unreconcilable` and leaves `busy` unchanged (L661-L663).
- The equality holds only if the launchpad's VFT balance changes solely through this program's own accounting.
  Nothing in the launchpad prevents a third party from transferring tokens to the launchpad address.

### Panics after the await
A panic in the reply continuation reverts only that continuation's writes. The Phase-1 writes stay: `busy` set, curve moved, liabilities settled.
Operations reachable after the await that can panic:
- `owe` overflow (state.rs L252-L257);
- `sold()` underflow (state.rs L192);
- `emit_event(..).expect`;
- `launch_mut` LaunchNotFound, which cannot fire because no code in service.rs removes launches.

## Accounting identity (per launch, sell path)
Commit:
- escrow −gross
- creator_fees +c, protocol_fees +p
- liabilities −gross +c +p (+net if deferred)
- native balance −net (if paid)

Because `net + c + p = gross` (curve.rs L100-L104), liabilities track the change in held value exactly on both pay paths. One exception: if `send_value` returns true and the value is not delivered, the liability is gone but the value is still held.

Revert: every field returns to the snapshot, and liabilities go −gross +gross.

## Aborted-state specifics
- `unwind` (L780-L814) sets `Aborted` after `unwind_wrapped` (L1403-L1422). If `pool_vara` had been wrapped and booked, `unwind_wrapped` adds it back to escrow (L1405-L1413).
  Escrow in Aborted then equals the Ready-time escrow (buy nets minus sell grosses). That escrow includes the `graduation_fee`
  portion, because `pool_vara = escrow - graduation_fee` (L1109).
- A pair-creation fee paid by us came from the operating reserve, not from escrow (L1200-L1203).
- In Aborted, sells keep moving `virtual_*` and `real_remaining`, while buys stay closed (`check_buy` L212).
  The launchpad still holds `pool_tokens`. An `ApproveToken` step may already have given the pair
  an allowance of `pool_tokens` (L709), and unwind does not revoke it (L1403-L1422).
- In Aborted, the L568 escrow bound is the only cap on total sell-back. What keeps the curve's quoted gross for every outstanding token within escrow is the curve's rounding (curve.rs L3-L4,
  L46-L52, L70-L75).

## Invariants
1. `gross <= escrow` is checked before `escrow -= gross` (L568, L599).
2. `gross < virtual_vara` when `virtual_tokens > 0` and `virtual_vara > 0` (curve.rs L74), so L596 does not underflow.
3. `net + fee_creator + fee_protocol == gross` (curve.rs L100-L104).
4. At most one trade per launch is in flight: `busy`/`lock` are checked at L561 and `busy` is set at L600.
5. Pre-await panics revert entirely. Post-await code has no intended panics, which relies on owe, sold and emit not panicking.
6. The snapshot fields in `PendingTrade` are the pre-mutation values (L590-L593 come before L596-L599).

## Assumptions
- `amount <= sold()` and `real_remaining + amount <= curve_supply`: sell checks neither. It relies on the transfer
  succeeding, and holders could hold more than sold() only if launchpad-held tokens left by some other route.
- Nothing else writes escrow while `busy` is set (needed by `revert_trade` L192). This is established by the busy gates
  at L215, L561, L678 and L793. `step_wrap`, `step_settle` and `unwind_wrapped` run only through graduate or unwind.
- VFT `TransferFrom` returning `Ok(true)` means tokens moved: nothing found. The code is semi-trusted and comes from an admin-set code_id.
- `send_value` returning true means the seller received the value: wire.rs L290 reports only that the send was queued.
- `gross * fee_bps` fits in u128 (curve.rs L96): bounded by gross <= escrow. Nothing caps escrow explicitly.
- The launchpad VFT balance equals `real_remaining + pool_tokens` when reconcile runs: nothing found that prevents external deposits.
- Sells have no pause: `paused_buys` is read only at L205, and no sell-side pause exists.

## Open questions
- unclear; need to inspect the release profile (Cargo.toml `overflow-checks`) to know whether u128 `*`/`-` in `split_fee` and `escrow -= gross` panic or wrap.
- unclear; need to inspect Gear semantics for value sent with gas 0 to a program destination (seller = program), and whether that value bounces back to the launchpad without a matching liability.
- unclear; need to inspect whether a late `TransferFrom` reply arriving after the `up_to` timeout can wake any future or is discarded.
- unclear; need to inspect fungible-token TransferFrom to confirm it returns `true` only when balances move and panics (→ Reply) on insufficient allowance or balance.
- unclear; need to inspect whether the launchpad's VFT balance can change in Aborted state (e.g. through the pair allowance from ApproveToken), which would break the reconcile equality.
