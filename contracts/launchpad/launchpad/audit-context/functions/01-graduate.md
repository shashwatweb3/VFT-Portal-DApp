# graduate — app/src/service.rs L668-L775

All line numbers refer to `app/src/service.rs` unless prefixed `state.rs:` or `wire.rs:`.

## 1. Purpose

`graduate(token)` is the only driver of the graduation state machine. It is `#[export]`, has no caller check (L669-L670), and runs exactly one `GradStep` per call (doc comment L668). An off-chain keeper is expected to call it in a loop until it returns `Done`. Each step sends one or more cross-program messages and awaits each reply. The per-launch `lock` stays set the whole time.

The step order is fixed by `GradStep::next` (state.rs:87-L101): WrapVara -> FindOrCreatePair -> ApproveToken -> ApproveWvara -> AlignPrice -> AddLiquidity -> BurnLp -> RevokeMinter -> RevokeBurner -> RevokeAdmin -> Settle -> Done.

## 2. Inputs, actors, preconditions

- `token: ActorId`, supplied by the caller. If it does not exist, `st.launch` / `st.launch_mut` panic `LaunchNotFound` (state.rs:240-250). This happens before any await (L673, L677).
- The call is non-payable: `ensure_no_value` panics if value is attached (L671, L122-L126).
- Caller: anyone. No `msg::source()` check anywhere in L670-L775.
- Gas config is read live from `Config` at entry (L672, L276-L278). It is not snapshotted per launch, so an admin `set_gas` between steps changes what later steps use.

## 3. Block-by-block

### 3.1 Early exit (L673-L675)
If the state is `Graduated`, it returns `Ok(Done)` without taking the lock or writing state.

### 3.2 Entry critical section (L676-L704), synchronous, before any await
- `busy.is_some()` -> panic `TradeInProgress` (L678-L680).
- `lock` -> panic `GraduationInProgress` (L681-L683).
- State transitions:
  - `Ready` -> `Graduating`, and `step` is forced to `WrapVara` (L685-L688). `Ready` is written only by `commit_trade` (L1107), which also sets `ready_at`, `pool_vara = escrow.saturating_sub(graduation_fee)`, `wvara_budget = pool_vara`, `token_budget = pool_tokens` (L1108-L1112).
  - `Graduating` -> unchanged (L689).
  - `Failed` -> panic `NotRetryable` if `!fail_retryable` (L691-L693). Otherwise the state becomes `Graduating` (L694). If `step == AddLiquidity && !liquidity_added`, `step` is rewound to `AlignPrice` (L696-L698).
  - Any other state (`Trading`, `Aborted`) -> panic `NotGraduating` (L700).
- `lock = true` (L702). A full clone of `Launch` is taken as `launch` (L703). Every step function then reads this pre-await snapshot.

Because the panics happen before any await, they revert this message's writes and the attached value.

### 3.3 Dispatch (L705-L725)
`me = exec::program_id()` (L705). There is one arm per step. ApproveToken and ApproveWvara are inline `vft_approve` calls. They discard the returned `bool` with `.map(|_| ())` (L709-L716), so a `false` reply counts as success.

### 3.4 Unlock (L726)
`lock = false` is written right after the step future resolves, whether it returned `Ok` or `Err`. No code path other than reaching this line clears `lock` for graduation. Unwind (L801) and reconcile (L639) clear only the locks they set themselves.

### 3.5 `step == Done` guard (L727-L729)
This guard runs only if the state was `Graduating`/`Failed` with `step == Done`. The only writer that sets `step = Done` (L735, with `next == Done`) also sets `state = Graduated` in the same closure (L737-L738), and `Graduated` exits at L673. Nothing found in service.rs reaches L724/L727 with `step == Done`.

### 3.6 Success (L731-L755)
`step = step.next()`, `fail_reason` cleared (L735-L736). If next is `Done`, `state = Graduated` (L737-L739). This branch does not reset `fail_retryable`. It emits `GraduationStep` (L741). On `Done` it emits `Graduated` from a fresh state read (L743-L752).

### 3.7 Failure (L756-L773)
`state = Failed`, `fail_reason`, and `fail_retryable = err.is_retryable()` (L757-L763). `CallError::is_retryable` returns `true` unconditionally (wire.rs:33-35). The only writer of `fail_retryable` other than the launch-time `false` (L477) is L763. So after any graduation failure `fail_retryable == true`, and the `NotRetryable` panic at L691-L693 is unreachable through writes found in service.rs. On failure `step` is not advanced, so a retry reruns the same step (except for the AddLiquidity rewind at L696-L698). It returns `Err(GraduationFailed{..})` instead of panicking, so the state writes stick.

## 4. Lock held across awaits, and panic paths after an await

`lock = true` is committed before the first await (L702). It is cleared only at L726. In Gear, a message that awaits a reply persists its state at the wait point. A panic (or out-of-gas) in a later continuation reverts only that continuation's writes. Lines that can panic between the first await and L726:

- `st.settle(..)` underflow panic `LiabilityUnderflow` (state.rs:259-264). Called in `step_wrap` L1187 and `step_settle` L1395.
- `st.owe(..)` overflow (state.rs:252-257). Called in `step_settle` L1396.
- `l.escrow -= launch.pool_vara` (L1190), u128 subtraction.
- U256 arithmetic in `step_align_price`: `rw * pt`, `rt * pv`, `rw * rt` (L1233-L1239). There is division by `pt` (L1240) and by `rw_target` (L1254); `rw_target` is 0 when `k*pv/pt < 1`. There are subtractions `launch.wvara_budget - amount_in` / `launch.token_budget - amount_in` (L1251, L1259).
- `step_add_liquidity`: `amount_w * pt / pv` (L1287) and `amount_t * pv / pt` (L1290). Division by `pv = pool_vara` happens after the `pair_get_reserves` await at L1281.
- `self.emit_event(..).expect("event")` inside `step_align_price` (L1267).
- `leftover.low_u128()` truncates rather than panics (L1375).

No signal handler, critical hook, or admin lock-reset was found in app/src (grep for `critical|handle_signal|handle_reply|lock` outside service.rs returned only state.rs comments). Lines L741, L752 and L771 (`expect("event")`) come after L726, so a panic there reverts that continuation including the unlock.

## 5. Per-step callees

All steps use `wire::call` (wire.rs:70-88). Send failure maps to `Send`. A timeout maps to `Timeout`. Any other gstd error (callee panic or error reply) maps to `Reply`. `decode_reply` checks only the service/method prefix (wire.rs:45-53). `check_null_reply` accepts an empty payload as success (wire.rs:57-68).

### WrapVara -> step_wrap (L1174-L1193)
- If the snapshot says `launch.wrapped`, it returns Ok (L1175-L1177).
- It reads the launchpad's wVARA `BalanceOf` (L1179) and compares it with the *global* `wvara_expected + pool_vara` (L1180-L1181). If the balance is lower, it mints with `pool_vara` attached as value (L1183).
- It then books `wvara_expected += pool_vara`, `settle(pool_vara)`, `wrapped = true`, `escrow -= pool_vara` (L1185-L1191).
- Depends on: the wVARA balance attributable to "already minted for this launch" equals `held - wvara_expected`. Several things also move the held wVARA balance without updating `wvara_expected`: other launches' AlignPrice swaps (L1250, L1258), their AddLiquidity deposits of `amount_w`, which can differ from the `pool_vara` subtracted at L1326, and their Settle burns (L1374). Nothing found that partitions the wVARA balance per launch.
- Depends on the wVARA program minting exactly `value` 1:1 (black-box semantics).

### FindOrCreatePair -> step_find_or_create_pair (L1195-L1216)
- `GetPair(wvara, token)` (L1198). If it returns zero, it calls `CreatePair` with `pair_creation_fee` attached from the program balance (L1200) and sets `pair_created_by_us = true` (L1203). That write is persisted even if the re-query at L1204 fails or returns zero (`Err(Reply)` L1205-L1207).
- If `GetPair` is non-zero (a third party pre-created the pair), creation is skipped and `pair_created_by_us` stays false.
- `GetTokens` sets `wvara_is_token0 = (token0 == wvara)` (L1209-L1214). The code does not check that `{token0, token1} == {wvara, token}` (nothing found).
- The pair address comes from the factory reply. The factory is semi-trusted.

### ApproveToken / ApproveWvara (L709-L716)
They approve `pair` for `pool_tokens` / `pool_vara`. The returned bool is ignored. AddLiquidity re-approves exact amounts later (L1312-L1313), so after these two steps the only consumer of the allowances is the AlignPrice swap. Unclear whether the Pair's swap pulls via `TransferFrom` (see open questions).

### AlignPrice -> step_align_price (L1221-L1274)
- It returns Ok if `liquidity_added` (snapshot), if either reserve is zero, or if the price is within 1% (L1222-L1238).
- Otherwise it swaps toward `rw_target = sqrt(k*pv/pt)` (L1240). It spends at most half of the current budget (L1247, L1255). `min_out` is 98% of the `GetAmountOut` the pair itself quotes (L1248-L1249, L1256-L1257).
- The budget books `min_out`, not the actual received amount (L1251, L1259). It writes `wvara_budget` / `token_budget` (L1268-L1272).
- It does not check that the price ends up within tolerance after the swap. Success is reported once the swap reply returns (L1273).
- A timed-out swap that actually executed leaves the budgets unchanged (the write at L1268 is never reached). The next attempt reruns AlignPrice from fresh reserves.
- `ImbalancedListing` is emitted with `expect` (L1261-L1267).

### AddLiquidity -> step_add_liquidity (L1276-L1322)
- It returns Ok if `liquidity_added` (L1277-L1279).
- Amounts: `amount_w = min(wvara_budget, pv)`, `amount_t = amount_w*pt/pv`, capped by `token_budget` (L1286-L1291).
- Resume detection: if `pre_add_reserves` is `Some`, the deposit counts as landed when both reserves grew by at least 95% of the *currently recomputed* amounts (L1294-L1301). The amounts are recomputed from the current budgets, which a rewound AlignPrice may have changed in between (L696-L698 -> L1268-L1272).
- If the reserves are non-zero and the price is more than 2% off, it returns `Err(Reply)` (L1302-L1310). The rewind at L696-L698 then sends the retry back through AlignPrice.
- It approves exact amounts (L1312-L1313; bools ignored, `?` only on CallError). It writes `pre_add_reserves` before sending (L1314). Then `AddLiquidity` runs with 97% mins (L1316-L1319), followed by `mark_liquidity_added` (L1320).
- `mark_liquidity_added` (L1324-L1329): `wvara_expected = wvara_expected.saturating_sub(pool_vara)` uses `pool_vara`, not the `amount_w` actually deposited. It also sets `liquidity_added = true`.
- Retry after an AddLiquidity timeout: L696-L698 rewinds to AlignPrice because `liquidity_added` is false. AlignPrice then reads reserves that may already include our deposit (L1225) and may swap again before AddLiquidity's landed check runs.

### BurnLp -> step_burn_lp (L1331-L1344)
- It reads the LP `BalanceOf` on the pair (L1332). Zero means Ok, with the comment assuming it already went out (L1333-L1336). Otherwise it transfers the whole balance to `lp_dead` (L1338). A `false` reply gives `Err(Reply)` (L1339-L1341). It does `lp_burned += lp` (L1342).
- The LP balance includes any LP someone else transferred to the launchpad. Nothing found that limits the burn to LP minted by our deposit.
- If a transfer timed out but executed, the next attempt sees a zero balance and returns Ok. `lp_burned` then stays at its previous value.

### RevokeMinter / RevokeBurner / RevokeAdmin -> step_revoke (L1348-L1361)
- It queries the holders and skips if `me` is not in the list (L1356-L1359). Otherwise it calls `Revoke*Role(me)` (L1360).
- Depends on the spawned VFT's role queries reflecting the real authority (semi-trusted VFT code set by admin).

### Settle -> step_settle (L1363-L1399)
- It queries the three role lists. `renounced` means all three are empty (L1364-L1367), so other holders count as not renounced.
- It reads the wVARA balance. Any excess over the global `wvara_expected` is burned and booked as `recovered` (L1369-L1376). This uses the same global attribution assumption as WrapVara.
- It transfers all launchpad-held units of `token` to `lp_dead` (L1379-L1385).
- Booking (L1386-L1397): `pair_fee = min(pair_creation_fee, escrow)` if `pair_created_by_us`. Then `escrow -= pair_fee`, `protocol_fees += escrow + recovered`, `escrow = 0`, `settle(pair_fee)`, `owe(recovered)`.
- The leftover escrow at this point is `graduation_fee` (escrow minus the `pool_vara` taken in WrapVara, L1190). All of it, minus the pair fee, becomes protocol revenue. `creator_fees` is not written in Settle.
- A timed-out wVARA burn that executed: on retry, `held` is lower, so `recovered` is 0 and the native VARA that came back is not added to liabilities.

## 6. Interaction with other entrypoints during a step

- `buy` requires `Trading` (L212). `sell` requires `Trading|Aborted` (L558). Both are therefore excluded during `Graduating`/`Failed`/`Ready`.
- `reconcile` requires `busy` stuck (L630-L633). `graduate` refuses to start if `busy.is_some()` (L678). `reconcile` checks `lock` (L627).
- `unwind` requires `!lock && busy.is_none()` (L793) and either stale `Ready` (L787-L788) or `Failed` at an unwindable step (L789, state.rs:105-L113). There is no timeout on the `Failed` branch. Once a step fails, `unwind` (-> Aborted) and `graduate` retry (-> Graduating) are both open to any caller. The first one to take the lock wins.
- From `Failed` at AlignPrice or later (non-unwindable), `graduate` retry is the only exit (L690-L699, L789).
- From `Ready`, `graduate` and `unwind` compete once `ready_at + timeout` has passed.
- Other launches' graduations run concurrently. The lock is per launch (L702). They share `wvara_expected` and the single wVARA balance of `me`.

## 7. Facts relevant to the design questions in the triggering request

- Pool sizing: `pool_vara = escrow - graduation_fee` at sell-out (L1109). The deposit is at price `pool_vara / pool_tokens` (L1284-L1291). The curve parameters are derived so that the final net raise minus `graduation_fee_vara` matches that price (L239-L253). So "all the VARA goes into the pool" applies only to `escrow - graduation_fee`. The `graduation_fee` portion stays in escrow until Settle (L1390-L1394).
- Graduation fee split: Settle sends everything to `protocol_fees` (L1393). The creator receives only trade fees accrued in `creator_fees` (L1101). No creator share of the graduation fee and no RivrDEX transfer was found.
- Trigger: the sell-out buy only sets `Ready` (L1104-L1118). It does not call into graduation. `graduate` is already permissionless (no source check, L670). Liveness needs about 11 successful calls (one per step, L87-L101), each by any account. If no one calls, `unwind` opens after `graduation_timeout_blocks` (L787-L788).

## 8. Invariants (as enforced)

1. At most one graduate/unwind/reconcile message is in flight per launch: `lock` is checked and set in one synchronous closure (L681-L683, L702; L793-L796; L627-L634).
2. Graduation does not start while a trade is pending (L678-L680).
3. A step advances only on `Ok` from the step function (L731-L735). On `Err` the step is unchanged (L759-L764).
4. `Graduated` is set only together with `step = Done` (L737-L738).
5. A retry from `Failed` at AddLiquidity with `!liquidity_added` re-runs AlignPrice first (L696-L698).
6. Every graduation failure is recorded as retryable (L758, wire.rs:33-35).
