# LaunchpadService::step_align_price

File: `contracts/launchpad/launchpad/app/src/service.rs` L1218-L1274
Caller: `LaunchpadService::graduate` (L717), when `launch.step == GradStep::AlignPrice`.

## 1. Purpose

Before the launchpad deposits its pool liquidity (`AddLiquidity`), this step checks whether the
RivrDEX pair already holds reserves (a third party seeded it) and, if the pair price `rw/rt` is more
than 1 % away from the curve's target price `pv/pt`, performs a single exact-input swap from the
launchpad's own wVARA or launch tokens to move the pair toward the target. It then rewrites the
per-launch deposit budgets `wvara_budget` / `token_budget` that `step_add_liquidity` uses
(L1286-L1291).

## 2. Inputs and context

- `launch: &Launch` is a **clone** taken inside `graduate` at L703 while `launch.lock = true` was set
  (L702). Every field read here (`liquidity_added`, `pair`, `wvara_is_token0`, `pool_vara`,
  `pool_tokens`, `wvara_budget`, `token_budget`, `token`) is the value at the start of the step, not
  live state.
- `gas: &GasConfig` is a copy of live config read at L672.
- Values written by earlier steps that this step consumes:
  - `pair`, `wvara_is_token0`: `step_find_or_create_pair` L1210-L1214 (`wvara_is_token0 = token0 == wvara`).
  - `pool_vara`: `commit_trade` L1109 (`escrow.saturating_sub(graduation_fee)`), overwriting the launch-time target from L439/L470.
  - `wvara_budget = pool_vara`, `token_budget = pool_tokens`: `commit_trade` L1111-L1112; launch-time init at L470-L471.
  - `pool_tokens`: snapshot at launch, `config.total_supply - config.curve_supply` (L244).
  - Allowances to the pair: `ApproveToken` approves `pool_tokens` (L709), `ApproveWvara` approves `pool_vara` (L713).

## 3. Block-by-block

### L1222-L1224 idempotency guard
Returns `Ok(())` if `launch.liquidity_added`. `liquidity_added` is set only by
`mark_liquidity_added` (L1327). `graduate` L696-L697 rewinds `AddLiquidity` -> `AlignPrice` only when
`!liquidity_added`, so this guard covers a step value that reached AlignPrice by other means.

### L1225-L1226 reserves read (await #1)
`wire::pair_get_reserves` (wire.rs L217-L219) sends `Pair/GetReserves`, decoded as `(U256, U256)`.
Vendored pair source: `get_reserves` returns `(st.reserve0, st.reserve1)`
(vendor/vara-amm/contracts/pair/app/src/services/pair/mod.rs L506-L508). These are the pair's
**tracked** reserves, updated only at swap/liquidity finalisation (funcs.rs L599-L601); no `sync` or
`skim` export exists in the pair services (grep found none), so direct token donations to the pair do
not move these values.
Ordering into `(rw, rt)` relies on `wvara_is_token0` from L1213.
Error paths: `Send`, `Timeout`, `Reply`, `Decode` (wire.rs L78-L87, L45-L53) propagate via `?`.

This is the first await. From here on, any panic in this function happens in a later execution
segment than the one that set `launch.lock = true` at L702 (see section 6).

### L1227-L1231 empty-pair short circuit
If either reserve is zero, returns `Ok(())` without touching budgets. An unseeded pair (or one where
only one tracked reserve is zero) proceeds to AddLiquidity with the original budgets.

### L1232-L1238 1 % tolerance
`lhs = rw * pt`, `rhs = rt * pv`, `diff = |lhs - rhs|`; aligned if `diff * 100 <= rhs`. The tolerance
is relative to `rhs` (pair-token side), so it is asymmetric in price terms (a price above target by
x % and below target by x % compare against the same `rhs`, but `diff` is in units of `rt*pv`).
U256 `*` panics on overflow (uint-0.10.x uint.rs L354, `panic!("arithmetic operation overflow")`).
Magnitudes: `rw` is bounded by wVARA supply (u128 native value), `rt` by the token's total supply,
`pt`, `pv` by config; products stay below 2^256 for realistic configs, but nothing in this function
bounds them.

### L1239-L1240 target computation
`k = rw * rt` (constant product before fees). `rw_target = isqrt(floor(k * pv / pt))` computed as
`k/pt*pv + (k%pt)*pv/pt` to avoid forming `k*pv`. Derivation: keeping `rw'*rt' = k` and
`rw'/rt' = pv/pt` gives `rw'^2 = k*pv/pt`.
- `k / pt` and `k % pt` panic if `pt == 0`. `pt > 0` is enforced at launch by
  `curve_params_for` -> `derive_params` returning `None` when `a == 0` (curve.rs L36-L39; with
  `pool_tokens == 0`, numerator is 0) -> panic at service.rs L251. `pool_tokens` is a launch snapshot
  and is not rewritten afterwards (grep: only L454, L1112 read it into other fields).
- `pv > 0` at launch time is enforced by `derive_params` L32 (`checked_sub` fails when
  `pool_vara*curve_supply < net*pool_tokens`, including `pool_vara == 0`). But `launch.pool_vara` used
  here is the value rewritten at commit_trade L1109 = `escrow.saturating_sub(graduation_fee)`;
  nothing found at L1109 asserts it is non-zero. If `pv == 0`: `rhs == 0`, the tolerance check passes
  only if `lhs == 0` (it is not, since `rw, pt > 0`), `rw_target == 0`, the else branch runs, and
  `k / rw_target` at L1254 divides by zero.
- `rw_target` can be 0 also when `k*pv/pt < 1`; same L1254 path.

### L1241 deadline
`exec::block_timestamp() + 600_000` ms. The pair rejects if `block_timestamp() > deadline`
(funcs.rs L413). Gear timestamps are ms; the pair compares the same clock.

### L1243 gross-up closure
`gross(net) = net * 10000 / 9965 + 1`. Comment (L1242) states the pair takes 0.35 % of input.
What the pair actually does to reserves (vendored source):
- treasury fee `amount_in * 5 / 10000` is removed from the input only if `treasury_id != 0`
  (funcs.rs L417-L421, amm_math.rs L100-L107);
- `amount_in_for_pool = amount_in - treasury_fee` is **added to the reserve in full**
  (funcs.rs L512-L516, L524-L528); the 0.30 % LP fee affects only `amount_out`
  (amm_math.rs L280-L302), not the reserve increment.
So the input reserve grows by about `gross(delta) * 0.9995` (or `gross(delta)` with treasury off),
i.e. by about 1.003x the computed `delta`, and `k` grows by the retained LP fee. The post-swap
reserves therefore do not land exactly on `rw_target`/`rt_target`; the residual offset is of order
0.3 % of the delta. This is compared later against the 2 % tolerance in AddLiquidity (L1307).

### L1245-L1251 branch A: `rw < rw_target` (pair price below target; wVARA in)
- `amount_in = min(gross(rw_target - rw), wvara_budget / 2)`. The `/2` cap means one AlignPrice run
  spends at most half of the current wVARA budget; if the needed delta is larger the pool is left
  partly aligned (see section 5, retry loop).
- `amount_in >= 1` unless `wvara_budget <= 1` (then `amount_in` may be 0).
- Await #2: `pair_get_amount_out(pair, amount_in, wvara_in_dir)` (wire.rs L221-L228). Pair source
  mod.rs L407-L429: computes from **current tracked reserves** and returns
  `unwrap_or_default()` -> **0 on any math error** (zero amount_in, zero reserves, overflow).
- `min_out = out * 98 / 100`.
- Await #3: `pair_swap_exact_in(pair, amount_in, min_out, dir, deadline)` (wire.rs L230-L248), sent
  with `g.gas_for_add_liquidity`, decoded with `check_null_reply` (wire.rs L57-L68; empty reply = Ok).
  Pair `swap_exact_tokens_for_tokens` is `#[export(unwrap_result)]` (mod.rs L276-L294), so a pair
  `Err` becomes a panic -> error reply -> `CallError::Reply` (wire.rs L84-L86).
  Pair-side preconditions (funcs.rs L404-L415): not migrated, `gas_available >= gas_for_full_tx`,
  pair lock free, deadline. Then `out < amount_out_min` -> error (L457-L459); constant-product check
  (L555-L562); `TransferFrom(launchpad -> pair, amount_in)` on the input token, then
  `Transfer(pair -> launchpad, amount_out)` on the output token (funcs.rs L1001-L1011); on failed
  output transfer, the input is refunded and Err returned (L1013-L1021).
  The input TransferFrom draws on the allowance set at L713 (`pool_vara`), which covers
  `amount_in <= wvara_budget/2` as long as `wvara_budget <= 2*pool_vara`.
- Booked result: `(wvara_budget - amount_in, token_budget + min_out)`. The pair's actual
  `amount_out` (computed at swap time from then-current reserves, funcs.rs L450-L455) is `>= min_out`
  on success but is not read back; the difference `actual_out - min_out` (at least ~2 % of `out`)
  is held by the launchpad but not counted in `token_budget`.
- `wvara_budget - amount_in` cannot underflow since `amount_in <= wvara_budget/2`.

### L1252-L1260 branch B: `rw >= rw_target` (pair price above or at target; tokens in)
- Also taken when `rw == rw_target` (rounding) even though the tolerance check failed.
- `rt_target = k / rw_target` (panics if `rw_target == 0`, see above).
- `amount_in = min(gross(rt_target.saturating_sub(rt)), token_budget / 2)`. If `rt_target <= rt`
  (possible from integer rounding), `gross(0) = 1`, so `amount_in = 1` (or 0 if `token_budget <= 1`).
- Await #2/#3 mirror branch A in the `!wvara_in_dir` direction.
- Booked result: `(wvara_budget + min_out, token_budget - amount_in)`; same `min_out` vs actual-output
  gap, now in wVARA. The token allowance (L709, `pool_tokens`) covers `amount_in <= token_budget/2`
  while `token_budget <= 2*pool_tokens`.
- wVARA received here lands in the launchpad's program-wide wVARA balance, which is shared across
  launches and tracked only by the aggregate `State.wvara_expected` (state.rs L221). This function
  does not touch `wvara_expected`.

### L1261-L1267 event
`ImbalancedListing { token, pair, reserve0: r0, reserve1: r1 }` with the **pre-swap** reserves read at
L1225. `.expect("event")` panics on emit failure (after three awaits).

### L1268-L1272 budget write
Overwrites `wvara_budget` / `token_budget` on the live launch with values derived from the L703
snapshot (not a delta on live state). Concurrent writers of these fields for the same token during
the awaits: `commit_trade` (L1111-L1112) only on Trading->Ready transition, and other graduate calls
are excluded by `lock` (L681-L682). So the overwrite is not racing another writer of the same
fields, provided `lock` holds.

## 4. External calls summary

| # | Call | Callee source | What this function depends on |
|---|------|---------------|-------------------------------|
| 1 | `Pair/GetReserves` | vendored, mod.rs L506 | Returns tracked reserves in (token0, token1) order matching `wvara_is_token0`. Pair address is whatever factory `GetPair` returned (L1198/L1204); the vendored code applies only if that address runs this code. |
| 2 | `Pair/GetAmountOut` | vendored, mod.rs L407-L429 | Quote from reserves at the time of this call (not those of #1); returns 0 on error instead of failing. |
| 3 | `Pair/SwapExactTokensForTokens` | vendored, mod.rs L277, funcs.rs L395-L617 | Enforces `out >= min_out`; pulls `amount_in` via TransferFrom; pays `out` to `msg::source()` (the launchpad, funcs.rs L505). Success reply is empty/null. |
| - | `wire::call` | in-repo, wire.rs L70-L88 | `up_to(Some(reply_timeout))`; timeout -> `CallError::Timeout`; any error reply -> `CallError::Reply`. A timed-out message may still execute later at the pair. |
| - | `CallError::is_retryable` | wire.rs L33-L35 | Always `true`, so every failure of this step leaves the launch `Failed` + retryable (graduate L756-L764). |

## 5. Interaction with graduate / retry

- On `Ok`, graduate sets `step = AddLiquidity` (L732-L735).
- On `Err`, graduate sets `state = Failed`, `fail_retryable = true`, `step` unchanged (AlignPrice)
  (L759-L764). Next `graduate` re-enters at AlignPrice (L690-L699).
- `AlignPrice` is not in `is_unwindable` (state.rs L105-L113), so after this step fails the launch
  can only be retried via `graduate`, not `unwind`.
- If one AlignPrice run leaves the price more than 2 % off (budget cap of `/2`, or interleaved
  third-party swaps), `step_add_liquidity` returns `Err(Reply)` (L1307-L1308); retry rewinds to
  AlignPrice (L696-L697). Each loop spends at most half the current input budget; nothing bounds the
  number of iterations, and the price can be moved back by any third party between iterations since
  the pair is open.
- Timeout on await #3: the swap may complete at the pair after the launchpad has recorded failure.
  Budgets are not updated (L1268 not reached). On retry, L1225 reads the post-swap reserves; if now
  within 1 %, the function returns `Ok` at L1237 with the **pre-swap** budgets. Nothing found
  reconciles budgets with actual launchpad balances in this function or in `step_add_liquidity`
  (which reads only reserves, L1281).

## 6. Panic sites after the first await

L1233/L1234/L1239/L1240 (U256 overflow, `pt == 0`), L1240 (`k % pt`), L1254 (`rw_target == 0`),
L1267 (`expect("event")`). In Gear's async model, each reply resumes in a new execution; state
committed in the segment containing L702 (`lock = true`, `state = Graduating`) persists if a later
segment panics. The only lock-clearing writes for graduate are at L726 (after the step returns). A
panic after an await in this function therefore leaves `launch.lock == true` with no in-code path
clearing it (grep: `lock = false` only at L639, L726, L801). Whether gstd/sails run any cleanup on
panic in a resumed future is an open question.

## 7. Invariants (what must hold)

1. `pool_tokens > 0` for L1240 to not panic — established at launch by curve.rs L36-L39 / service.rs L251.
2. `pool_vara > 0` and `rw_target > 0` for L1254 — `pool_vara > 0` only established at launch for the target value; the live value comes from L1109 with no check found.
3. `amount_in <= budget/2` so the subtractions at L1251/L1259 do not underflow — L1247, L1255.
4. Budgets after this step equal `old ± amount_in` and `old ± min_out`, not actual output — L1251, L1259.
5. The approval set in ApproveToken/ApproveWvara covers `amount_in` — L709/L713 vs L1247/L1255; holds while budgets stay <= 2x the approved amount.
6. After a successful run, pair price is not guaranteed within 1 % (budget cap, gross-up mismatch, interleaving) — L1247/L1255 caps; AddLiquidity re-checks at 2 % (L1307).

## 8. Assumptions and where they are established

- Pair reserves reflect a state against which a one-shot swap moves the price predictably — nothing found; reserves can change between await #1, #2 and #3 since other messages execute at the pair while the launchpad waits.
- `out` from GetAmountOut is a meaningful lower bound — the pair returns 0 on error (mod.rs L427); nothing found in this function rejects `out == 0`, in which case `min_out == 0` and the swap has no slippage bound.
- Budgets track what the launchpad holds for this launch — partial: established on the success path at L1268-L1272 with `min_out` (an under-count of output); not established on the timeout-then-executed path (section 5); program-wide wVARA is pooled (state.rs L221).
- The pair at `launch.pair` runs the vendored RivrDEX code — established only by the factory's `GetPair` reply (L1198/L1204); the factory address is admin-set config snapshotted at launch.
- Fee model of 0.35 % taken from reserves (comment L1242) — not matching vendored pair: reserves grow by `amount_in - treasury_fee` (funcs.rs L512-L516), treasury fee only when `treasury_id != 0` (L417-L421).
- `launch` snapshot is still current at L1268 — established by `lock` (L681-L682, L702) excluding other graduate/unwind/reconcile on the same token; trades are excluded because state is Graduating/Failed.
- `gas_for_add_liquidity` suffices for the pair's `gas_for_full_tx` check (funcs.rs L407) — nothing found linking the two values; failure yields `CallError::Reply`.

## 9. Open questions

- unclear; need to inspect whether gstd/sails-rs 0.10.2 async runtime performs any state rollback or lock cleanup when a resumed future panics (affects `launch.lock` after panics in section 6).
- unclear; need to inspect `commit_trade` / curve completion path to confirm whether `escrow > graduation_fee` always holds at L1109 (determines whether `pv == 0` reaches L1240/L1254).
- unclear; need to inspect step_add_liquidity and step_settle together to determine where the unbooked `actual_out - min_out` surplus and any timeout-path budget mismatch end up (Settle burns wVARA above `wvara_expected` at L1372-L1375 and sends leftover tokens to `lp_dead` at L1379-L1384).
- unclear; need to inspect the deployed mainnet RivrDEX pair code hash to confirm it matches `vendor/vara-amm/contracts/pair` (fee constants, GetAmountOut default-0 behaviour, absence of sync/skim).
- unclear; need to inspect whether a pair with one zero tracked reserve and one non-zero (L1229) is reachable, and how AddLiquidity behaves against it.
