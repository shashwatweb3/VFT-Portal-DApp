# step_add_liquidity — app/src/service.rs L1276-L1322

Helper `mark_liquidity_added` (L1324-L1329) is included as part of this unit.

## 1. Purpose

Graduation step `GradStep::AddLiquidity` (dispatched at service.rs L718). It deposits the launch's
wVARA and curve tokens into the RivrDEX pair at the ratio `pool_vara : pool_tokens` (the curve's
final price), capped by the per-launch budgets that `step_align_price` may have shifted. It also
holds the resume logic for a deposit whose reply was lost: a reserve snapshot
(`pre_add_reserves`) is written before sending, and on re-entry the current reserves are compared
with it to decide whether the earlier deposit landed.

## 2. Inputs and context

- `launch: &Launch` — a clone taken inside `graduate` at L703, after `lock = true` was set at L702.
  It is not re-read after any await in this function; every field used (`liquidity_added`, `pair`,
  `wvara_is_token0`, `pool_vara`, `pool_tokens`, `wvara_budget`, `token_budget`,
  `pre_add_reserves`, `token`, `addrs.wvara`) is the value at L703.
- `me` — program id; unused (`let _ = me;` L1280).
- `gas: &GasConfig` — read live from Config by `graduate` L672 (not snapshotted per launch).
- Caller context: `graduate` (L670-L775) runs exactly one step per message (L706-L725). Between the
  AlignPrice step and this step there is at least one message boundary, so any account can trade on
  the pair in between.
- On a retry from `Failed` with `step == AddLiquidity && !liquidity_added`, `graduate` rewinds to
  `AlignPrice` (L696-L698). So after any failed attempt of this step, the next call runs AlignPrice
  first, then this step on a further call.

## 3. Block-by-block

### L1277-L1279 idempotence guard
Returns Ok if `liquidity_added` is set. `liquidity_added` is written only in `mark_liquidity_added`
(L1327) (and the initializer). Since the flag comes from the L703 clone, and the launch is locked
(L702) for the duration, no concurrent writer to this launch's flag exists while this runs.

### L1281-L1282 reserve read (await #1)
`wire::pair_get_reserves` (wire.rs L217-L219) → `call_typed` "Pair"/"GetReserves". Returns whatever
(U256, U256) the pair replies with; decode checks only the service/method prefix (wire.rs L45-L53).
Error variants: Send (wire.rs L79, L82), Timeout (L85), Reply (L86), Decode (L47-L52). All map to
`?` → step fails, `graduate` sets Failed + retryable (L756-L764; `is_retryable` always true,
wire.rs L33-L35). Reserves are reordered into (wVARA, token) by `wvara_is_token0`, which was set by
`step_find_or_create_pair` from `pair_get_tokens` (L1209-L1214).

### L1284-L1291 deposit amounts
- `pv = pool_vara` (u128 → U256), `pt = pool_tokens`.
- `amount_w = min(wvara_budget, pv)` (L1286).
- `amount_t = amount_w * pt / pv` (L1287). Division by `pv`: if `pool_vara == 0` this divides by
  zero. `pool_vara` is set at Ready by `commit_trade` L1109 as `escrow.saturating_sub(graduation_fee)`;
  saturating_sub yields 0 if escrow <= graduation_fee. Nothing in this function checks `pv > 0`.
  The launch-time value (L242-L243) panics on underflow but is overwritten at L1109.
- If `amount_t > token_budget`, clamp `amount_t = token_budget` and recompute
  `amount_w = amount_t * pv / pt` (L1288-L1291). Division by `pt`: reached only when
  `amount_t > token_budget`; if `pt == 0` then `amount_t == 0` at L1287 so the branch is not
  taken (0 > x false for U256).
- U256 `*` in the `uint` crate panics on overflow; multiplications at L1287, L1290, L1295-L1296,
  L1304-L1305 have no checked arithmetic. Magnitudes depend on token supply config and on the pair's
  reported reserves (rw, rt from L1281, an external reply).
- Result: `amount_w <= pv`, `amount_w <= wvara_budget` (when not clamped by tokens);
  when clamped, `amount_t == token_budget` and `amount_w` is derived, so `amount_w <= wvara_budget`
  holds only because `amount_t*pv/pt <= (amount_w_original*pt/pv)*pv/pt <= amount_w_original`
  (integer flooring makes it monotone non-increasing). Rounding loss on either side stays in the
  launchpad; `step_settle` later burns leftover tokens (L1379-L1385) and recovers leftover wVARA
  as protocol revenue (L1369-L1376).

Budgets origin: `commit_trade` L1111-L1112 sets `wvara_budget = pool_vara`, `token_budget =
pool_tokens`. `step_align_price` rewrites them at L1268-L1272 using `min_out` (L1251, L1259), not the
actual swap output, and `amount_in` as computed (not a measured spend).

### L1294-L1301 lost-reply resume heuristic
If `pre_add_reserves = Some((prev_w, prev_t))`, the deposit is declared landed iff
`rw >= prev_w + 0.95*amount_w` AND `rt >= prev_t + 0.95*amount_t` (integer `*95/100`). If landed,
`mark_liquidity_added` and return Ok — no AddLiquidity is sent.

Structural facts:
- `amount_w`/`amount_t` used here are recomputed from the *current* budgets (L1286-L1291), not the
  amounts that were sent in the earlier attempt. Between the attempts, the forced AlignPrice rerun
  (L696-L698) can rewrite the budgets (L1268-L1272), so the threshold can differ from the amounts
  actually sent.
- The test is on aggregate reserves only. Any reserve growth from any source (a third-party
  AddLiquidity, a direct transfer + sync, swaps that net-increase both sides is impossible for a
  constant-product swap but deposits by others are not) satisfies it. The comment at L1292-L1293
  states others' reserves "don't count"; the code does not distinguish the source of the growth.
- Conversely, a deposit that did land is not detected if reserves on either side have since fallen
  (e.g. a swap removing tokens after the deposit, or the AlignPrice rerun's own swap at L1250/L1258,
  which removes one side from the pool). In that case the function falls through and sends a second
  AddLiquidity.
- `pre_add_reserves` is written only at L1314 (grep: L469 initializes None, L1314 sets Some). It is
  never cleared, including after `mark_liquidity_added`.
- No LP-balance check is made here; `step_burn_lp` (L1332-L1336) treats zero LP as "already went
  out", relying on this step having verified liquidity.

### L1302-L1310 price tolerance
If both reserves are non-zero: `|rw*pt - rt*pv| * 50 > rt*pv` → `Err(CallError::Reply)` (2%
tolerance). Retry goes through AlignPrice (1% tolerance at L1236). If either reserve is zero the
check is skipped entirely (L1302), including the one-side-zero case, and the deposit is sent at the
pv:pt ratio. `step_align_price` also returns early on any zero reserve (L1229-L1231).

### L1312-L1313 approvals (await #2, #3)
`wire::vft_approve` (wire.rs L177-L179) returns `Result<bool, CallError>`. The `?` propagates only
`Err`; an `Ok(false)` reply is discarded and execution continues. Approvals set the allowance to the
exact `amount_t` / `amount_w` (replacing the full-budget approvals from ApproveToken/ApproveWvara,
L709-L716, as far as VFT `Approve` semantics are replace-not-add — not verified here).
If await #2 succeeds and #3 fails, the token allowance has been changed and the step fails; the
retry rewinds to AlignPrice, whose swap (L1250/L1258) then runs against the reduced token allowance
set here (amount_t) rather than pool_tokens.

### L1314 snapshot write
`pre_add_reserves = Some((rw, rt))` with the reserves read at L1281, i.e. before awaits #2 and #3.
Any pair activity between L1281 and the actual AddLiquidity execution is inside the "growth" window
of the next resume check. The write is committed to state at the next await (L1319).

### L1315-L1319 deposit (await #4)
Orders amounts by `wvara_is_token0`; `min = 97%` of desired on each side; deadline =
`block_timestamp + 10 min` (ms). `wire::pair_add_liquidity` (wire.rs L251-L270) is `call_null`: success
is either an empty payload or a prefixed empty reply (wire.rs L57-L68). The pair's actual amounts
taken and LP minted are not returned and not checked by the caller. Gas is `gas_for_add_liquidity`
(live config).
Outcomes:
- Ok → `mark_liquidity_added`, return Ok.
- Timeout → the deposit may or may not have executed; step fails retryable; the snapshot from L1314
  drives the next resume check.
- Reply/Decode/Send → step fails; for Decode the call executed but the reply prefix did not match;
  this is handled the same as non-execution, i.e. it also relies on the resume heuristic.

### L1324-L1329 mark_liquidity_added
`wvara_expected = wvara_expected.saturating_sub(pool_vara)` (global counter) and
`liquidity_added = true`. It subtracts `pool_vara` (the full amount wrapped at L1186), not
`amount_w`. The difference `pool_vara - amount_w` (plus or minus AlignPrice's budget movement)
remains in the launchpad wVARA balance above `wvara_expected`, and `step_settle` treats
`held - wvara_expected` as this launch's leftover (L1369-L1376). Because `wvara_expected` and the
wVARA balance are global across launches, this attribution holds only if no other launch's wVARA
movement interleaves.

## 4. Cross-function dependencies

| Callee | Kind | What this function depends on |
|---|---|---|
| `wire::pair_get_reserves` | internal wrapper over external Pair | Reserves reflect the pair's state; ordering token0/token1 is consistent with `GetTokens` used at L1209. |
| `wire::vft_approve` (token, wvara) | internal wrapper over external VFT / wVARA | Allowance set to exactly the value; bool result ignored. |
| `wire::pair_add_liquidity` | internal wrapper over external Pair | Pair pulls at most desired amounts via TransferFrom, respects mins and deadline, mints LP to caller (msg source). None of this is observable from the empty reply. |
| `mark_liquidity_added` | internal | Flag + global counter update. |
| `commit_trade` (upstream) | internal | Sets pool_vara, wvara_budget, token_budget (L1109-L1112). |
| `step_align_price` (upstream) | internal | Brings price within 1% and rewrites budgets (L1268-L1272). |
| `step_wrap` (upstream) | internal | wVARA for pool_vara minted and `wvara_expected += pool_vara` (L1185-L1191). |
| `graduate` (caller) | internal | Lock set, clone taken, one step per message, rewind to AlignPrice on retry. |

## 5. Invariants and assumptions (summary)

- Called only with `launch.lock == true` and state Graduating (graduate L681-L702).
- `pool_vara > 0` — nothing found that enforces it at Ready (L1109 saturating_sub).
- Launchpad holds >= amount_w wVARA and >= amount_t tokens attributable to this launch — nothing found
  in this function; wVARA balance is shared globally.
- Reserve growth since snapshot ⇔ our deposit landed — heuristic only (L1295-L1296).
- `Ok(false)` from approve is acceptable — nothing found that handles it (L1312-L1313).
- The pair contract at `launch.pair` is the genuine RivrDEX pair — established by
  `factory_get_pair` in step_find_or_create_pair (L1198, L1204), trusting the factory.

## 6. Open questions

- Gear semantics: if a panic (U256 overflow at L1287/L1290/L1295/L1304-L1307 or division by zero at
  L1287) happens in the continuation after an await, is `lock = true` from graduate L702 left
  committed? unclear; need to inspect gstd async/panic state-commit semantics.
- RivrDEX Pair AddLiquidity: does it use optimal amounts (Uniswap V2 router-style) or take desired
  amounts as-is, and is there a MINIMUM_LIQUIDITY lock on first deposit? unclear; need to inspect
  RivrDEX Pair source.
- Does RivrDEX AddLiquidity pull via TransferFrom from `msg::source()` and mint LP to it? unclear;
  need to inspect RivrDEX Pair source.
- VFT/wVARA `Approve` semantics (replace vs. increase; returns false when unchanged?) unclear; need
  to inspect contracts/fungible-token and wVARA VftNativeExchange source.
- Does the pair accept direct token transfers followed by a `sync`/`skim`, allowing reserve changes
  without AddLiquidity? unclear; need to inspect RivrDEX Pair source.
