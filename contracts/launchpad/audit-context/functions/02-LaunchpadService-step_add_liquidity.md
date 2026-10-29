# LaunchpadService::step_add_liquidity

File: `contracts/launchpad/launchpad/app/src/service.rs` L1276-L1322 (helper `mark_liquidity_added` L1324-L1329).
Sole caller: `LaunchpadService::graduate` L718, dispatched when `launch.step == GradStep::AddLiquidity`.

## 1. Purpose

Graduation step 6 of 11 (`GradStep` order, state.rs L71-L84, `next()` L87-L102). It deposits this launch's
wVARA and its pool tokens into the RivrDEX pair at the curve's final price `pool_vara / pool_tokens`,
bounded by the post-AlignPrice budgets `wvara_budget` / `token_budget`. It also resumes after a lost
AddLiquidity reply by comparing current pair reserves against a snapshot stored before the send.
On success it sets `liquidity_added = true` and subtracts `pool_vara` from the program-wide
`wvara_expected`.

## 2. Inputs and the snapshot it runs on

- `launch: &Launch` is a **clone** taken inside `graduate` at L703, after `lock = true` (L702). Every
  field read in this function (`liquidity_added`, `pair`, `wvara_is_token0`, `pool_vara`, `pool_tokens`,
  `wvara_budget`, `token_budget`, `pre_add_reserves`, `addrs.wvara`, `token`) is the value at L703, not live
  state. Writes go to live state through `with_state_mut` (L1314, L1325-L1328).
- `me` is unused (`let _ = me;` L1280).
- `gas: &GasConfig` is a clone of live config at `graduate` L672 (`gas()` L276-L278).

Upstream values the function consumes, and where they come from:

| Field | Written at | Note |
|---|---|---|
| `pool_vara` | commit_trade L1109: `escrow.saturating_sub(graduation_fee)` | saturating; can be 0 if escrow < graduation_fee |
| `pool_tokens` | launch L454 from `curve_params_for` L244 (`total_supply - curve_supply`) | derive_params returns None when pool_tokens = 0 (curve.rs L36-L40), so non-zero at launch time |
| `wvara_budget`, `token_budget` | init L470-L471; reset at Ready L1111-L1112; rewritten by step_align_price L1270-L1271 | AlignPrice credits `min_out`, not actual output (L1251, L1259) |
| `pair`, `wvara_is_token0` | step_find_or_create_pair L1212-L1213 | `wvara_is_token0 = (token0 == wvara)`; token1 not compared to anything (L1209 binds `_token1`) |
| `pre_add_reserves` | init `None` L469; set only at L1314 | never reset to `None` anywhere (grep: only L469, L1294, L1314) |
| `liquidity_added` | init false L468; set only in mark_liquidity_added L1327 | |

## 3. Control flow, block by block

### B0 — early exit (L1277-L1279)
`if launch.liquidity_added { return Ok(()) }`. Uses the L703 snapshot. Makes the step idempotent once
mark_liquidity_added has run in a prior invocation.

### B1 — read reserves (L1281-L1282)
`wire::pair_get_reserves(launch.pair)` -> `(r0, r1)`; mapped into `(rw, rt)` using `wvara_is_token0`.
First await. On any `CallError` the step returns `Err` via `?` with no state written.
Pair side: `get_reserves` (vara-amm pair mod.rs L506) returns the pair's stored `reserve0/reserve1`, which
are only changed by its own accounting (add_liquidity_core funcs.rs L130-L139, swap finalize L599-L603,
remove L258-L265, migrate L344-L345). Direct token donations to the pair address do not change them.

### B2 — deposit sizing (L1284-L1291)
```
pv = pool_vara; pt = pool_tokens
amount_w = min(wvara_budget, pv)
amount_t = amount_w * pt / pv              // L1287: divides by pv
if amount_t > token_budget {
    amount_t = token_budget
    amount_w = amount_t * pv / pt          // L1290: divides by pt
}
```
- Ratio `amount_w : amount_t` is the target price `pv : pt`, floor-rounded.
- `amount_w <= pv` and `amount_w <= wvara_budget` (L1286); `amount_t <= token_budget` (L1288-L1289).
  After the L1290 recompute, `amount_w = floor(token_budget*pv/pt) <= previous amount_w` because
  `token_budget < amount_w*pt/pv`, so both caps still hold.
- L1287 is unconditional division by `pv`. U256 division by zero panics. `pv = 0` happens iff
  `escrow <= graduation_fee` at commit_trade L1109. Nothing in this function or in `graduate` checks it.
- U256 `*` (primitive-types) panics on overflow. Magnitudes: wVARA in planck, tokens in 18-decimals
  (curve.rs L4-L5 comment: products ~1e45), so `amount_w * pt` is far below 2^256 for configured values.
- Either amount can be 0 (e.g. if budgets were driven to zero). The pair rejects zero desired amounts
  (`ZeroLiquidity`, funcs.rs L61-L63) which surfaces as `CallError::Reply`.

### B3 — resume detection (L1294-L1301)
Runs only if `pre_add_reserves` is `Some((prev_w, prev_t))`:
```
landed = rw >= prev_w + amount_w*95/100 && rt >= prev_t + amount_t*95/100
if landed { mark_liquidity_added(launch); return Ok(()) }
```
Structural facts:
- The thresholds use `amount_w/amount_t` computed **in this invocation** (B2), from the current budgets.
  The deposit that may have landed was sized in an earlier invocation from the budgets at that time.
  Budgets are rewritten between the two by step_align_price (L1270-L1271), which `graduate` forces to rerun
  before any AddLiquidity retry (L696-L698). So the compared amount and the sent amount can differ.
- The test is "both reserves grew by >= 95 % of our amounts since the snapshot". The cause of the growth is
  not identified: any AddLiquidity by any account between the snapshot and now that grows both reserves by
  that much satisfies it. Swaps move the reserves in opposite directions (funcs.rs L512-L530), so a single
  swap cannot satisfy both inequalities; a sequence of trades plus third-party liquidity can.
- Reserve decreases after our deposit (RemoveLiquidity by others, swaps) can make `landed` false even
  though our deposit landed.
- The snapshot `(prev_w, prev_t)` is the reserves read at B1 of the earlier invocation (L1314 writes `(rw, rt)`
  from L1281), i.e. before that invocation's two approve awaits, not at the moment AddLiquidity was sent.
- `pre_add_reserves` is not cleared after use. A stale snapshot from an earlier failed invocation is
  overwritten only when a later invocation reaches L1314.
- If `landed` is false, execution falls through to a fresh deposit attempt.
- The `+` at L1295/L1296 is U256 addition (panics on overflow); operands are reserve-sized.

### B4 — price guard (L1302-L1310)
Only when both `rw` and `rt` are non-zero: `|rw*pt - rt*pv| * 50 > rt*pv` -> `Err(CallError::Reply)`.
That is a 2 % tolerance relative to `rt*pv`. Comment at L1303 relies on AlignPrice having just run
(1 % tolerance there, L1236). Returning `CallError::Reply` makes graduate mark the launch `Failed`
with `fail_retryable = true` (wire.rs L33-L35 always true; graduate L757-L764), and the next
`graduate` call rewinds step to AlignPrice (L696-L698).
- When exactly one of `rw`/`rt` is zero the guard is skipped. The pair's `calculate_optimal_amounts`
  (amm_math.rs L40-L46) then calls `quote`, which errors `InsufficientLiquidity` when either reserve is zero
  (amm_math.rs L21-L23), so AddLiquidity fails with `Reply`.
- When both are zero (empty pool) the guard is skipped and the deposit sets the opening price at
  `amount_w : amount_t` (pair accepts desired amounts verbatim, amm_math.rs L40-L43); first mint locks
  `MINIMUM_LIQUIDITY = 1000` LP to `LP_DEAD` (funcs.rs L119-L125, amm_math.rs L4).
- The reserves checked are from B1; two awaits (B5) follow before AddLiquidity is sent, during which the
  pair can be traded by anyone.

### B5 — approvals (L1312-L1313)
`vft_approve(token, pair, amount_t)` then `vft_approve(wvara, pair, amount_w)`. Each is `call_typed::<bool>`
(wire.rs L177-L179). The `bool` is discarded (`?` only propagates `CallError`).
- Tokenator VFT `approve` (vft lib.rs L325-L342) sets the allowance to exactly `value` and returns
  `prev != value`; `false` means "unchanged" (or owner == spender). Discarding it is consistent with that
  implementation.
- wVARA approve (awesome-sails vft lib.rs L82-L107) sets the allowance (values beyond its `Allowance` type
  saturate to MAX, L87-L88), stores the block height alongside (L94), returns `Result<bool, Error>`.
  Whether the deployed wVARA uses this exact version and whether allowances expire by block height is not
  established here (open question).
- These overwrite the larger allowances set at ApproveToken/ApproveWvara (graduate L709, L713), so the pair's
  pull is bounded per-token by the exact deposit amounts from B2.
- If the first approve succeeds and the second fails, the token allowance is already set to `amount_t`; the
  step returns `Err`, `pre_add_reserves` is not updated.

### B6 — snapshot write (L1314)
`pre_add_reserves = Some((rw, rt))` in live state. Written after both approvals succeed, before the send.
This write persists across the following await (Gear commits state at the wait point), so it survives a
timeout or a panic in the continuation.

### B7 — send AddLiquidity (L1315-L1319)
- `(amount0, amount1)` ordered by `wvara_is_token0` (L1315).
- `min0 = amount0*97/100`, `min1 = amount1*97/100` (L1316-L1317).
- `deadline_ms = block_timestamp + 600_000` (L1318). Pair compares `exec::block_timestamp() > deadline`
  (funcs.rs L67-L69) — same unit.
- `wire::pair_add_liquidity` is `call_null` with `gas_for_add_liquidity`, value 0 (wire.rs L251-L270);
  the reply is accepted if empty or carrying the `Pair/AddLiquidity` prefix (wire.rs L57-L68).
- Error mapping (wire.rs L78-L87): send failure -> `Send`; reply timeout -> `Timeout`; any error reply
  (including the pair's `unwrap_result` panic on `PairError`) -> `Reply`.

Pair behaviour (vendor/vara-amm/contracts/pair/app/src/services/pair/funcs.rs L46-L161):
1. Rejects if migrated, `gas_available < gas_for_full_tx`, zero desired, pair lock busy, deadline passed (L55-L69).
2. `calculate_optimal_amounts` (amm_math.rs L32-L67): may use less than desired on one side; enforces the
   97 % mins against the optimal amount.
3. Sets pair lock `Busy(AddLiqRefund)` (L89-L95), `transfer_from(token0, sender)` then
   `transfer_from(token1, sender)` (L929-L938). If token1 pull fails it attempts to return token0 (L940-L947);
   if that return also fails, the error propagates with the pair lock not freed (recovery is admin-only
   `recover_paused_core` L707-L746).
4. Mints LP to `sender` = the launchpad (L126), then adds `amount_a/amount_b` to reserves and frees lock
   (L130-L150).
So a successful reply means both tokens moved and reserves grew by exactly the optimal amounts. A `Timeout`
leaves every outcome open: not executed, executed fully, or executing.

### B8 — commit (L1320, L1324-L1329)
`mark_liquidity_added`: `wvara_expected = wvara_expected.saturating_sub(pool_vara)`;
`liquidity_added = true`. Then `Ok(())`; graduate advances step to BurnLp (L731-L736).
- The decrement is `pool_vara`, not the wVARA actually taken by the pair. The pair can take less than
  `amount_w` (optimal-amount path), and `amount_w` itself can be below `pool_vara` (L1286, L1290). The
  difference stays in the launchpad's wVARA balance but is no longer counted in `wvara_expected`.
- The same decrement happens on the B3 `landed` path, where no wVARA may have left this launch at all.
- `saturating_sub` hides an underflow of `wvara_expected` instead of panicking.

## 4. State written

| Location | What | When |
|---|---|---|
| L1314 | `launch.pre_add_reserves = Some((rw, rt))` | after both approvals |
| L1326 | `State.wvara_expected -= pool_vara` (saturating) | B3 landed or B7 success |
| L1327 | `launch.liquidity_added = true` | same |
| external | token and wVARA allowances launchpad->pair | B5 |
| external | pair reserves, LP balance of launchpad, VFT/wVARA balances | B7 (inside pair) |

Not written: `wvara_budget`, `token_budget`, `lp_burned`, `escrow`, `total_liabilities`, events (graduate
emits `GraduationStep` at L741).

## 5. Interaction with the caller (`graduate` L670-L775)

- `lock = true` at L702 before the step; `lock = false` at L726 after the step future resolves. L726 is
  the only reset on this path. If the continuation panics after any await in this function (candidates:
  L1287 division by zero, L1290 division by zero, U256 overflow at L1287/L1290/L1295/L1296/L1304/L1305/L1307),
  execution ends before L726. Gear keeps state committed at the last wait point, so `lock` stays `true`
  and `state` stays `Graduating`. `graduate` then panics `GraduationInProgress` on every call (L681-L683) and
  `unwind` panics too (L793-L795). No `handle_signal` / critical hook exists in the launchpad (grep found none).
- On `Err`, graduate sets `Failed`, `fail_retryable = true` for every CallError (wire.rs L33-L35, L758-L763).
  Retry path L690-L698: step rewinds to AlignPrice if `!liquidity_added`. AlignPrice then may swap again
  (spending up to half of a budget per run, L1247, L1255) and rewrites budgets before AddLiquidity reruns.
- `unwind` is not available at this step: `is_unwindable` covers only WrapVara..ApproveWvara (state.rs L105-L113).
  A launch that fails at AlignPrice/AddLiquidity can only move forward via graduate.
- Per-launch exclusion during the awaits: graduate/unwind blocked by `lock` (L681, L793). Other launches'
  graduate/unwind are not blocked and touch the shared `wvara_expected` and the shared wVARA balance:
  step_wrap L1179-L1186 (reads `held >= expected + pool_vara`), step_settle L1369-L1376 (burns `held - expected`
  as that launch's `recovered` protocol revenue), unwind L784 / unwind_wrapped L1416-L1419.

## 6. Cross-function accounting relation (wvara_expected)

`wvara_expected` is described as "wVARA the program holds for launches that wrapped but have not added
liquidity yet" (state.rs L220-L221). It is incremented by `pool_vara` at step_wrap L1186 and decremented by
`pool_vara` here (L1326) and at unwind_wrapped L1408. The wVARA balance itself is a single balance in the
wVARA program for all launches. Consequences that follow from the code:
- After this step, `held - wvara_expected` includes `pool_vara - (wVARA actually pulled by the pair)` for this
  launch. step_settle of whichever launch runs Settle next (L1372-L1376) burns the whole surplus and books it
  to that launch's `protocol_fees` (L1393) and `total_liabilities` (L1396). Nothing ties the surplus to the
  launch that produced it.
- Between B7 send and B8 commit (pending reply), `wvara_expected` still counts this launch, while the wVARA
  may already be in the pair. Another launch's step_wrap in that window sees `held < expected + pool_vara`
  and mints (not "already") — consistent. Another launch's step_settle sees a smaller surplus — consistent.
- B5 approves the pair for `amount_w` of wVARA drawn from the shared balance; the pair's pull is bounded
  by that allowance, not by per-launch holdings.

## 7. Invariants (what must hold at L1319 send time)

1. `amount_w <= min(wvara_budget, pool_vara)` and `amount_t <= token_budget` — L1286-L1291.
2. `amount_w * pt ≈ amount_t * pv` (floor) — L1287 / L1290.
3. Pair allowances equal exactly `amount_t` (token) and `amount_w` (wVARA) — L1312-L1313.
4. `pre_add_reserves` holds reserves read at L1281 of this invocation — L1314.
5. If pair non-empty on both sides, B1-time price is within 2 % of `pv/pt` — L1302-L1310.
6. Pair accepts at most 3 % slippage per side vs desired — L1316-L1317, enforced by pair amm_math L49, L61.
7. `liquidity_added` transitions false->true only via mark_liquidity_added (L1327), and at most once
   because B0 short-circuits later invocations (L1277) — but B0 reads the L703 clone, so the true value is
   whatever was persisted before graduate cloned.

## 8. Assumptions

| Assumption | Established by |
|---|---|
| `pool_vara > 0` (L1287 divisor) | nothing found; commit_trade L1109 uses saturating_sub |
| `pool_tokens > 0` (L1290 divisor) | curve::derive_params returns None when pool_tokens = 0 (curve.rs L36-L40) at launch L439; pool_tokens never rewritten afterwards |
| `launch.pair` is the genuine RivrDEX pair for (wVARA, token) | step_find_or_create_pair L1198-L1214 via factory GetPair (semi-trusted factory) |
| `wvara_is_token0` correctly orients reserves/amounts | step_find_or_create_pair L1213; token1 not checked to be the launch token (L1209 `_token1`) |
| Budgets reflect what this launch really holds | step_align_price L1251/L1259 credit `min_out`; actual output not read back; nothing found that reconciles budgets with balances |
| Reserve growth of >=95 % of current amounts since snapshot means our deposit landed | nothing found; growth source not identified (L1295-L1296) |
| Current amounts equal the amounts sent in the earlier invocation | nothing found; budgets can be rewritten by AlignPrice between invocations (L696-L698, L1270-L1271) |
| Price at pair execution time is within tolerance | only B1-time check (L1302-L1310) plus pair-side 97 % mins (L1316-L1317) |
| Approve `false` return means "unchanged", not failure | Tokenator VFT lib.rs L325-L342; awesome-sails vft lib.rs L82-L107 for wVARA (deployed version unverified) |
| `Ok` from pair_add_liquidity means both tokens moved and LP minted to launchpad | pair funcs.rs L97-L150 (vendor source; deployed pair code version unverified) |
| `wvara_expected >= pool_vara` at decrement | nothing found; saturating_sub at L1326 masks violation |
| No panic occurs between first await and return (else lock stuck) | nothing found; no signal handler in launchpad |
| Pair's `gas_for_full_tx` <= `gas_for_add_liquidity` | nothing found; admin-set GasConfig, pair rejects otherwise (funcs.rs L58-L60) |

## 9. Callees

| Callee | Kind | Caller depends on |
|---|---|---|
| `wire::pair_get_reserves` (wire.rs L217-L219) -> Pair.GetReserves (pair mod.rs L506) | external-source-available | stored reserves as (reserve0, reserve1) in token0/token1 order; unaffected by raw donations |
| `wire::vft_approve` token (wire.rs L177) -> Tokenator VFT approve (vft lib.rs L325-L342) | internal (repo source) | sets exact allowance; bool ignored |
| `wire::vft_approve` wVARA -> awesome-sails vft approve (lib.rs L82-L107) | external-source-available | sets allowance (saturates to MAX), Err -> Reply |
| `wire::pair_add_liquidity` (wire.rs L251-L270) -> Pair.AddLiquidity (pair mod.rs L201-L220, funcs.rs L46-L161) | external-source-available | Ok implies both transfer_from succeeded, reserves updated, LP minted to launchpad; may use less than desired on one side |
| `wire::call` / `call_null` (wire.rs L70-L88, L111-L130) | internal | maps timeout->Timeout, error reply->Reply, send fail->Send; empty reply accepted |
| `mark_liquidity_added` (L1324-L1329) | internal | sets flag, decrements wvara_expected by pool_vara |
| `with_state_mut` (L272-L274) | internal | RefCell borrow; no nested borrow in closures here |
| `exec::block_timestamp` | Gear runtime | ms timestamp matching pair deadline unit |

## 10. Open questions

- unclear; need to inspect whether `escrow` at Ready (commit_trade L1109) can be <= `graduation_fee` for any
  config admitted by `new`/`set_raise_target`/`set_fees`, which would make L1287 divide by zero.
- unclear; need to inspect the deployed mainnet wVARA program version to confirm Approve semantics,
  reply encoding (`bool` with `Vft/Approve` prefix), and whether allowances stored with block height expire.
- unclear; need to inspect the deployed RivrDEX pair code to confirm it matches vendor/vara-amm funcs.rs
  (lock semantics, optimal amounts, reply on error).
- unclear; need to inspect sails-rs 0.10.2 / gstd 1.10.0 behaviour for a panic in an async continuation, to
  confirm that `lock = true` from L702 remains persisted (no automatic cleanup).
- unclear; need to inspect whether `Reconcile` or any admin entrypoint can clear `Launch.lock` or move a
  `Graduating` launch out of a stuck state.
- unclear; need to inspect step_burn_lp L1331-L1344: it transfers the launchpad's entire LP balance of the
  pair, so LP from a third-party deposit counted as "landed" or donated LP is also burned; and whether LP
  minted to the launchpad on a late-landing duplicate deposit is handled.
