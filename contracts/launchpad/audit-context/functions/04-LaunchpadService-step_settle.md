# LaunchpadService::step_settle

File: `contracts/launchpad/launchpad/app/src/service.rs` L1363-L1399
Caller: `LaunchpadService::graduate` (service.rs L723), only when `launch.step == GradStep::Settle`.

## 1. Purpose

Last graduation step before `Done`. It (a) observes whether the VFT role sets are empty, (b) burns any
wVARA the launchpad holds above the program-wide `wvara_expected` and books the returned VARA as this
launch's protocol fee, (c) transfers all launchpad-held units of `launch.token` to `launch.addrs.lp_dead`,
(d) charges the pair-creation fee against the remaining escrow, and (e) moves the remaining escrow plus
the recovered wVARA amount into `protocol_fees`, adjusting `total_liabilities`.

## 2. Inputs and context

- `launch: &Launch` is a clone taken at graduate L703, inside the same synchronous closure that set
  `launch.lock = true` (L702). Fields read from the clone: `token`, `addrs.wvara`, `addrs.lp_dead`
  (L1364-1381). Fields read from live state in the final closure: `pair_created_by_us`,
  `pair_creation_fee`, `escrow`, `protocol_fees` (L1387-1394).
- `me = exec::program_id()` (graduate L705).
- `gas: &GasConfig` is a clone of live config gas taken at graduate L672.
- Preconditions enforced by `graduate` before reaching this function: launch not busy (L678), not locked
  (L681), state in {Ready, Graduating, Failed+retryable} (L684-700). Reaching `Settle` requires the step
  sequence `RevokeAdmin -> Settle` (state.rs L99) having returned `Ok` earlier.

## 3. Block-by-block

### 3.1 Role observation (L1364-L1367)
Three awaited queries `vft_role_holders(token, "Admins"|"Minters"|"Burners")` (wire.rs L191-193 ->
`call_typed`, L90-109). Each await is a suspension point. Any error (`Send`, `Timeout`, `Reply`, `Decode`;
wire.rs L78-87, L45-53) returns early via `?` with no state written.
`renounced = admins.is_empty() && minters.is_empty() && burners.is_empty()` (L1367). This is an
observation only: a non-empty set does not return an error; it is recorded in `l.roles_renounced` (L1388)
and later emitted in `Event::Graduated` (graduate L750). Nothing in this function requires the roles to be
gone before graduation is marked done.

In the launchpad's own VFT, the queries return the set contents (vft lib.rs L380-387, L405-407). The VFT
code is chosen by admin via `vft_code_id`, so the actual responder is whatever that code is.

### 3.2 Leftover wVARA (L1369-L1376)
- `held = vft_balance_of(addrs.wvara, me)` (L1369), an await to the wVARA program (black box: real wVARA is
  the awesome-sails app per tests-wasm/README.md L3; no source in repo).
- `expected = st.wvara_expected` read synchronously after resumption (L1370). `held` reflects wVARA's state
  when wVARA processed the query; `expected` reflects launchpad state at resumption. Between these two
  points other launchpad messages may run (per-launch lock only, graduate L681/L702), including other
  launches' `step_wrap` (L1186 increments), `mark_liquidity_added` (L1326 decrements) and
  `unwind_wrapped` (L1408 decrements), and third-party wVARA transfers to the launchpad.
- If `held > expected`, `leftover = held - expected` (L1373) is burned via `wvara_burn` (L1374; wire.rs
  L278-280, `call_null` with value 0). `recovered = leftover.low_u128()` (L1375) truncates to the low 128
  bits; the burn amount is the full U256 `leftover`.
- `wvara_expected` is program-wide (state.rs L220-221), not per launch. Attribution of the entire
  `held - expected` surplus to *this* launch rests on every other source of launchpad wVARA being booked in
  `wvara_expected`. Sources of wVARA that are not booked there:
  - this launch's own unpooled remainder: `mark_liquidity_added` subtracts the full `pool_vara`
    (L1326) although `step_add_liquidity` may deposit `amount_w < pool_vara` (L1286-1291) and
    `step_align_price` may move wVARA in or out (L1251, L1259). This is the designed source (comment L1368).
  - third-party donations of wVARA to the launchpad (exercised in tests/feedback.rs L436-437).
  - another launch's mint that executed but whose reply did not arrive: `step_wrap` only increments
    `wvara_expected` after a successful mint reply (L1183 `?` then L1186); `unwind_wrapped` acknowledges
    this case (L1416-1419 "Minted but never booked").
  - wVARA returned by an AlignPrice swap of another launch that is between swap and add.
  The function does not distinguish these; all go to this launch's `protocol_fees`.
- The burned VARA is assumed to arrive in the launchpad's native balance. No balance check
  (`exec::value_available`) follows the burn. The amount booked is `recovered`, not a measured delta.
- If the burn reply times out or errors (`?` at L1374), the function returns before the final closure;
  if the burn actually executed, the next retry sees `held` reduced and books nothing — the returned VARA
  then sits in the program balance with no liability entry.

### 3.3 Leftover curve tokens (L1379-L1385)
- `tokens_left = vft_balance_of(token, me)` (L1379), await.
- If non-zero, `vft_transfer(token, lp_dead, tokens_left)` (L1381). In the launchpad VFT, `transfer`
  returns `false` when `from == to` or value zero and panics on insufficient balance (vft lib.rs L125-132,
  L345-352). A `false` reply maps to `Err(CallError::Reply)` (L1382-1384); a panic arrives as
  `CallError::Reply` (wire.rs L86). If `lp_dead == me`, every retry returns `false`.
- The balance moved is the launchpad's entire holding of `token`, whatever its origin (pool remainder,
  AlignPrice swap output, donations). No per-launch token accounting is compared against it.
- Ordering: the wVARA burn (L1374) has already completed when this transfer is attempted. A failure here
  returns `Err` after the burn landed, and `recovered` is a local that is not persisted (L1371). On retry,
  `held <= expected` (the surplus is gone), so `recovered = 0`; the burned VARA is in the native balance
  without a liability entry.

### 3.4 Final accounting (L1386-L1397), synchronous
Within one `with_state_mut` closure:
1. `l.roles_renounced = renounced` (L1388).
2. `pair_fee = if l.pair_created_by_us { min(pair_creation_fee, escrow) } else { 0 }` (L1390).
   `pair_created_by_us` is set only after a successful `factory_create_pair` reply (L1200, L1203). The fee
   itself left the program at L1200 out of the operating reserve, not out of liabilities (comment L1201).
3. `l.escrow -= pair_fee` (L1391); cannot underflow because of the `min` at L1390.
4. `l.protocol_fees += l.escrow + recovered` (L1393); checked arithmetic in release
   (`overflow-checks = true`, contracts/launchpad/Cargo.toml L22-23) — overflow panics.
5. `l.escrow = 0` (L1394).
6. `st.settle(pair_fee)` (L1395) -> `checked_sub`, panics "LiabilityUnderflow" (state.rs L259-264).
7. `st.owe(recovered)` (L1396) -> `checked_add`, panics "LiabilityOverflow" (state.rs L252-257).

Net liability change: escrow (already a liability) is relabelled as protocol fee (no change), `-pair_fee`,
`+recovered`. The remaining escrow at this point, in the normal path, is `escrow_at_ready - pool_vara`
where `pool_vara = escrow_at_ready.saturating_sub(graduation_fee)` (commit_trade L1109) and
`step_wrap` removed `pool_vara` (L1190). So remaining escrow equals `min(escrow_at_ready, graduation_fee)`.
`set_fees` requires `graduation_fee_vara >= pair_creation_fee_vara` (L1018) for future launches; both are
snapshotted at launch (L457 and the pair_creation_fee snapshot).

A panic inside this closure happens in a reply-handling execution after awaits. Under Gear semantics that
execution's writes are discarded, while `lock = true` written in graduate's first execution (L702) persists,
and graduate's unlock (L726) never runs. Unclear what (if anything) clears `lock` afterwards; see open
questions.

### 3.5 Return
`Ok(())` (L1398). graduate then clears `lock` (L726), sets `step = Done`, `state = Graduated` (L735-739)
and emits events. Once `Graduated`, graduate short-circuits (L673), so step_settle cannot run twice on the
success path.

## 4. Invariants this function maintains or relies on

- I1: `l.escrow == 0` after success (L1394).
- I2: `pair_fee <= l.escrow` before subtraction (L1390), so L1391 cannot underflow.
- I3: Liability bookkeeping mirrors value movements: `-pair_fee` for the reserve-paid pair fee, `+recovered`
  for the VARA returned by burn (L1395-1396). Relies on `total_liabilities >= pair_fee`, which holds if
  the global "total_liabilities >= sum of escrows" invariant holds (state.rs L218-219), since
  `pair_fee <= l.escrow`.
- I4: All state writes happen in one synchronous closure after every await (L1386-1397); failure at any
  await writes nothing.

## 5. Assumptions

- A1: All wVARA held above `wvara_expected` belongs to this launch. Established by: nothing found
  (wvara_expected is program-wide, state.rs L221; unbooked sources listed in 3.2).
- A2: `held` and `wvara_expected` describe the same moment. Established by: nothing found (await at
  L1369 between the two reads; no cross-launch serialization).
- A3: `wvara_burn(leftover)` returns exactly `leftover` native VARA to the launchpad, and its `Ok`
  reply means it happened. Established by: nothing found (black box; no value_available check).
- A4: `recovered` fits in u128 (`low_u128` at L1375). Established by: nothing found.
- A5: All launchpad-held `token` units are disposable to lp_dead. Established by: nothing found; no
  per-launch token ledger is compared (L1379-1381).
- A6: `lp_dead != me` and lp_dead accepts transfers. Established by: nothing found (SetAddresses /
  launch snapshot not validated here; vft lib.rs L126 returns false on self-transfer).
- A7: Role sets being empty is not required for graduation. Recorded at L1388; not enforced. The previous
  steps `step_revoke` (L1348-1361) skip revocation if `me` is absent and do not touch other holders.
- A8: `pair_created_by_us` reflects whether this launchpad paid the pair fee. Established by L1203, only on
  the path where the create_pair reply succeeded; a timed-out create_pair that executed leaves it false.
- A9: The remaining escrow is the graduation fee. Established by commit_trade L1109 + step_wrap L1190;
  `min(escrow_at_ready, graduation_fee)`.
- A10: Recovery burn and token sweep complete in the same execution chain as the accounting. Not
  established; `recovered` is a local (L1371) and is lost on any failure after L1374.

## 6. Calls

| Callee | Kind | Depends on it for |
| --- | --- | --- |
| `wire::vft_role_holders` x3 (wire.rs L191) | internal wrapper -> external VFT | Vec of role holders; empty sets set `roles_renounced` |
| `wire::vft_balance_of(wvara)` (wire.rs L181) | wrapper -> black box wVARA | `held` |
| `wire::wvara_burn` (wire.rs L278) | wrapper -> black box wVARA | burn of `leftover` and native VARA return |
| `wire::vft_balance_of(token)` | wrapper -> VFT (admin-chosen code) | `tokens_left` |
| `wire::vft_transfer(token, lp_dead)` (wire.rs L163) | wrapper -> VFT | `true` iff moved; false/panic -> Err |
| `State::settle` / `State::owe` (state.rs L252-264) | internal | checked liability update; panic on under/overflow |
| `wire::call`/`call_typed`/`call_null` (wire.rs L70-130) | internal | maps all failures to CallError (always retryable, L33-35); reply prefix checked |

## 7. Open questions

- Unclear whether anything clears `launch.lock` if the final closure panics (L1395/L1396/L1393); need
  to inspect whether any path besides graduate L726 / unwind L801 / reconcile writes `lock = false`.
- Unclear how the real wVARA (awesome-sails VftNativeExchange) Burn behaves on insufficient balance and
  whether it sends value with a reply or a separate message; need to inspect awesome-sails rev 1ec7991.
- Unclear whether `lp_dead` is validated against zero / the launchpad address anywhere; need to inspect
  `set_addresses` (service.rs ~L995) and `LaunchpadProgram::new`.
- Unclear whether concurrent graduation of two launches can make `held - expected` include another
  launch's in-flight wVARA (A2); need to trace interleavings of step_wrap / step_align_price /
  step_add_liquidity across launches against L1369-1370.
