# unwind / unwind_wrapped

File: `contracts/launchpad/launchpad/app/src/service.rs`
- `unwind` (public, `#[export]`, async): L777-L814
- `unwind_wrapped` (private, async): L1401-L1422

## 1. Purpose

`unwind` is a permissionless recovery path. It moves a launch that is either (a) `Ready` for at least
`graduation_timeout_blocks`, or (b) `Failed` at a step where `GradStep::is_unwindable()` holds, to
`Aborted`. Before the state flip it calls `unwind_wrapped` to convert the pool wVARA back to native VARA and
restore the escrow/liability bookkeeping that `step_wrap` moved. After `Aborted`, `sell` accepts the launch
again (L558) and `graduate` refuses it (L700, `_ => panic!("NotGraduating")`). Buys stay closed because
`buy` only accepts `Trading` (per system context).

## 2. Inputs and preconditions

| Input | Source | Checked where |
|---|---|---|
| `token: ActorId` | caller | `launch_mut` panics `LaunchNotFound` if absent (state.rs L240-L244) |
| attached value | caller | `ensure_no_value` L781 -> L122-L126 panics if non-zero |
| `msg::source()` | caller | never read; no access control |

Gate (inside one synchronous `with_state_mut`, L783-L798):
- `stale_ready = state == Ready && block_height >= ready_at + timeout` (L787-L788). `ready_at` is set in
  `commit_trade` at L1108 when the sell-out buy lands. `timeout` is `config.graduation_timeout_blocks`, read
  live (L785), set by admin in `set_limits` (L1041) with no bounds. `overflow-checks = true` in the
  workspace release profile (contracts/launchpad/Cargo.toml L22-L23), so `ready_at + timeout` panics on u32
  overflow instead of wrapping.
- `failed_early = state == Failed && step.is_unwindable()` (L789). `is_unwindable` (state.rs L105-L113) is
  true for `WrapVara | FindOrCreatePair | ApproveToken | ApproveWvara`. `launch.step` on a Failed launch is
  the step that failed: `graduate` only advances `step` on `Ok` (L731-L735); the `Err` arm (L756-L764)
  leaves it.
- `fail_retryable` is not consulted. `CallError::is_retryable` returns `true` for every variant
  (wire.rs L33-L35), so every Failed launch is also retryable via `graduate`.
- `lock || busy.is_some()` panics `GraduationInProgress` (L793-L795).
- `lock = true` (L796), then a clone of the launch and a snapshot of the global `wvara_expected` (L784,
  L797) are returned.

States not covered by the gate: `Graduating` with `lock == false` (a launch that completed one or more
steps and then had no further `graduate` call) is neither `Ready` nor `Failed`, so `unwind` panics
`NotUnwindable` (L790-L792). Recovery from that state is only via `graduate` (L689), which is
permissionless.

## 3. Block-by-block

### unwind
- L781-L782: no value; `gas` is a clone of the live `config.gas` (L276-L278).
- L783-L798: gate + lock + snapshots (see above). Because the gate and `lock = true` are in the same
  synchronous closure, no other message for this launch can interleave between check and lock.
- L799: `me = exec::program_id()`.
- L800: `await unwind_wrapped(&launch_snapshot, me, expected_snapshot, &gas)`. Suspension point; other
  messages (other launches' `graduate`, `sell`, `reconcile`, `claim_*`, and other `unwind`s) run here.
- L801: `lock = false` unconditionally, before inspecting the result.
- L802-L806: on `Err`, returns `LaunchpadError::GraduationFailed { step: snapshot.step, reason,
  retryable: true }`. No state field other than `lock` is written on this path; the launch remains
  `Ready` or `Failed`, and no event is emitted. Any writes that `unwind_wrapped` made before its error
  persist (in practice none: each branch writes only after its final await succeeds; see below).
- L807-L811: `state = Aborted`; reads `escrow` after `unwind_wrapped`'s writes.
- L812: emits `Unwound { token, escrow }`; `.expect("event")` panics on emission failure, after the state
  writes above. In Gear a panic after an await rolls back only the current execution segment (open
  question below).

### unwind_wrapped, branch A: `launch.wrapped == true` (L1405-L1415)
- `launch.wrapped` is from the snapshot taken under lock. Writers of `wrapped` are `step_wrap` (L1189) and
  this function (L1410); both run only under `lock`, so the snapshot equals live state while the lock is held.
- L1406: `wvara_burn(wvara, pool_vara)`, no balance pre-check.
- L1407-L1413 on success: `wvara_expected = saturating_sub(pool_vara)`; `wrapped = false`;
  `escrow += pool_vara`; `owe(pool_vara)` (checked add, state.rs L252-L257). These are the exact inverses of
  `step_wrap`'s writes at L1186-L1190 (`wvara_expected += pool`, `settle(pool)`, `wrapped = true`,
  `escrow -= pool`).
- On `Err` from the burn (any of Send/Timeout/Reply/Decode), returns early; none of the four writes happen.
  A `Timeout` or `Decode` error does not exclude that the burn executed on the wVARA side
  (wire.rs L80-L87, L57-L67). A subsequent `unwind` would re-enter branch A (wrapped still true) and send
  another `Burn(pool_vara)` without consulting the balance.
- `pool_vara` used for the burn and for booking is the snapshot value. `pool_vara` writers per context are
  `launch`, `commit_trade` (L1109), and `step_align_price`; `AlignPrice` is not in the unwindable set, so on
  a Failed-at-unwindable-step launch `pool_vara` is the value set at L1109 unless a prior `AlignPrice` ran
  and a later retry re-entered an earlier step (graduate's retry rewrite at L696-L698 only moves
  AddLiquidity -> AlignPrice, never earlier).

### unwind_wrapped, branch B: `launch.wrapped == false` (L1416-L1421)
- L1416: `held = vft_balance_of(wvara, me)` — the program's total wVARA balance, shared by all launches.
- L1417: condition `held >= expected_snapshot + pool`. `expected_snapshot` was read at L784 before this
  await; `step_wrap` reads `wvara_expected` after its own balance await (L1179-L1180). The ordering differs
  between the two functions.
- L1419: if true, `wvara_burn(pool)`. No bookkeeping writes follow: the comment (L1418) states escrow still
  counts the VARA because `step_wrap` never reached its writes (L1185-L1191 only run after a successful
  mint). `wvara_expected` is not touched, consistent with `step_wrap` not having incremented it.
- If false, returns `Ok(())` with no external effect; `unwind` then sets `Aborted`.
- The balance inference attributes any wVARA above `expected` to this launch. Sources of such wVARA
  include: this launch's mint that executed after its reply timed out (the intended case); another launch's
  unbooked mint; another launch's mint that landed during this await while `expected_snapshot` predates
  that launch's `wvara_expected +=`; and wVARA transferred to the program by any third party.
- A `Ready` launch (stale_ready path) never ran `step_wrap`, so in that path a burn at L1419 is always
  attributed to wVARA from one of the non-self sources above.

## 4. External calls

| Callee | Kind | Sent | Assumed / depended on |
|---|---|---|---|
| `wire::wvara_burn` (wire.rs L278-L280 -> `call_null` L111-L130 -> `call` L70-L88) | external-black-box (wVARA VftNativeExchange `Burn`) | `Burn(amount)` with 0 value, `gas_for_token_ops` | That `Ok` means `amount` wVARA was burned from the launchpad and `amount` native VARA returned to the launchpad 1:1. `Ok` is any empty reply or a reply with matching prefix (L57-L67); return payload is not checked further. Err does not imply non-execution for Timeout/Decode. |
| `wire::vft_balance_of` (wire.rs L181-L183 -> `call_typed` L90-L109) | external-black-box (wVARA `Vft::BalanceOf`) | `BalanceOf(me)` | That the returned U256 is the launchpad's current wVARA balance. Value is taken as-is. |
| `State::owe` (state.rs L252-L257) | internal | — | checked add; panics `LiabilityOverflow`. |
| `State::launch_mut` (state.rs L240-L244) | internal | — | panics if launch absent. |
| `GradStep::is_unwindable` (state.rs L105-L113) | internal | — | defines the Failed-step gate. |
| `fail_reason` (L255-L257) / `CallError::describe` (wire.rs L24-L31) | internal | — | string only. |
| `emit_event` | external-source-available (sails) | `Unwound` | `.expect` panics on failure. |

Gear semantics relied on: `msg::send_bytes_with_gas_for_reply(...).up_to(Some(timeout))` (wire.rs
L78-L83). A reply timeout ends the wait; it does not cancel the outgoing message.

## 5. State touched

Reads: `st.wvara_expected` (L784), `st.config.graduation_timeout_blocks` (L785), `config.gas` (L782),
`launch.{state, ready_at, step, lock, busy, wrapped, pool_vara, addrs.wvara, token, escrow}`.

Writes:
- `launch.lock` true (L796), false (L801).
- branch A only: `st.wvara_expected` (L1408), `launch.wrapped` (L1410), `launch.escrow` (L1411),
  `st.total_liabilities` (L1412).
- `launch.state = Aborted` (L809) on success.

Not written by unwind (persist into Aborted): `pair`, `pair_created_by_us`, `wvara_is_token0`,
`wvara_budget`, `token_budget`, `step`, `fail_reason`, `fail_retryable`, `pool_vara`, `graduation_fee`
(still inside escrow). Outstanding approvals from `ApproveToken` (L709) and `ApproveWvara` (L713) to
`launch.pair` are not revoked. The pair-creation fee paid from the operating reserve at L1200 when
`pair_created_by_us` is not charged to escrow on this path; the only place that charges it is
`step_settle` (L1390-L1395), which never runs for an Aborted launch.

## 6. Invariants

- I1. Gate and lock acquisition are atomic: L783-L798 is a single synchronous closure.
- I2. Mutual exclusion with `graduate`, `sell`, `reconcile` on the same launch via `lock` (graduate L681,
  sell L561, reconcile L627 check `lock`; unwind sets it L796).
- I3. `lock` is cleared on both Ok and Err returns of `unwind_wrapped` (L801). A panic inside the await
  (e.g. `owe` overflow at L1412) is not covered by this clear (open question on Gear rollback scope).
- I4. Branch A writes are the exact inverse of `step_wrap` writes (L1407-L1413 vs L1186-L1190), and occur
  only after the burn returned `Ok`.
- I5. Branch B performs no bookkeeping writes (L1416-L1421).
- I6. `Aborted` is terminal for unwind: re-entry fails the gate (L787-L792), and `graduate` rejects it (L700).
- I7. After success, `launch.state == Aborted` and `escrow` includes `pool_vara` if branch A ran (L1411)
  or was never removed if `wrapped` was false (L1185-L1191 never ran).

## 7. Assumptions

- A1. A `Failed` launch at an unwindable step has had no value moved into the pair. Established by
  `is_unwindable` excluding `AlignPrice` and later (state.rs L105-L113) together with graduate only
  advancing `step` on success (L731-L735). No direct check of `liquidity_added` or pair reserves in unwind.
- A2. Branch A's `Burn(pool_vara)` draws only this launch's wVARA. Nothing found: the burn is against a
  balance shared across launches and no balance check precedes it (L1406).
- A3. A branch A burn that returned Err did not execute. Nothing found: Timeout/Decode outcomes are not
  distinguished from non-execution (wire.rs L80-L87); a retry re-sends the burn (L1405-L1406).
- A4. In branch B, wVARA above `expected_snapshot` belongs to this launch. Nothing found: `expected` is
  snapshot before the balance await (L784 vs L1416); no per-launch attribution; donations and other
  launches' unbooked/in-flight mints satisfy the same predicate. Also, `step_settle` of another launch
  sweeps wVARA above `wvara_expected` as its own protocol revenue (L1369-L1376, L1393, L1396), so an unbooked
  mint of this launch can be consumed by another launch's Settle before unwind runs; branch B then sees
  `held < expected + pool` and burns nothing, while this launch's escrow still counts `pool_vara`.
- A5. When branch B finds no excess, the timed-out mint will never execute later. Nothing found: Gear's
  reply timeout does not cancel the message (wire.rs L78-L83); a late mint after `Aborted` would leave
  unbooked wVARA with no further path for this launch.
- A6. When a mint (step_wrap L1183) returned a non-timeout Err, the attached `pool_vara` value returned to
  the launchpad. Nothing found in this code; depends on Gear value-return semantics for errored messages
  and on wVARA's behavior.
- A7. wVARA `Burn` returns native value 1:1 to the caller. Nothing found (black box).
- A8. `graduation_timeout_blocks` is a reasonable value. Nothing found: `set_limits` (L1041) has no bounds.
  At 0, `stale_ready` holds in the same block the launch becomes Ready, so `unwind` and `graduate` race for
  the first lock acquisition (graduate L685-L687 moves Ready -> Graduating synchronously, after which unwind
  fails its gate). At values where `ready_at + timeout > u32::MAX`, L788 panics under overflow-checks, so
  the stale-ready path is unreachable.
- A9. `launch.busy` is `None` for Ready/Failed launches. The gate checks it (L793); `commit_trade` clears it
  (L1103) on the sell-out buy.
- A10. The pair-creation fee spent from reserve (L1200) does not need to be recovered on unwind. Nothing
  found; only `step_settle` (L1390-L1395) charges it.
- A11. Leftover approvals to `launch.pair` for `pool_tokens` and `pool_vara` wVARA (L709, L713) are inert after
  Aborted. Nothing found; unwind does not reset them, and the wVARA allowance applies to the program's
  shared wVARA balance.

## 8. Cross-function coupling

- `step_wrap` (L1174-L1193) is the inverse; branch selection depends on `wrapped`, which `step_wrap` sets
  only after a successful or balance-inferred mint.
- `step_settle` of any launch (L1369-L1376) and `unwind_wrapped` branch B both interpret "wVARA above
  `wvara_expected`" — the former as protocol revenue, the latter as this launch's pool.
- `mark_liquidity_added` (L1324-L1329) decrements `wvara_expected`; unreachable for an unwindable launch.
- `sell` (L558-L561) consumes the restored escrow after Aborted.
- With respect to the user's question on keeper liveness: `graduate` is already permissionless (L668-L670);
  the only time-based path is unwind's `stale_ready`, which moves the launch away from graduation.

## 9. Open questions

- Unclear; need to inspect gstd async semantics for whether a panic after an await (e.g. `.expect("event")`
  at L812 or `owe` at L1412) rolls back state written in earlier execution segments, including `lock = true`
  at L796. If not, a panic in the continuation leaves `lock` set.
- Unclear; need to inspect the wVARA VftNativeExchange source for `Burn`: whether it pays out to
  `msg::source`, whether it replies with an error or panics on insufficient balance, and whether value
  is returned on a failed `Mint`.
- Unclear; need to inspect the RivrDEX Pair source to determine whether a pair can call `TransferFrom` on wVARA
  / the launch token outside `AddLiquidity` initiated by the launchpad (relevant to the unrevoked approvals).
- Unclear; need to inspect `step_align_price` to confirm it never writes `pool_vara` on a path where `step`
  later becomes an unwindable step.
- Unclear; need to inspect `sell` to confirm how the `graduation_fee` portion of escrow is treated for an
  Aborted launch (it stays in escrow after unwind).
