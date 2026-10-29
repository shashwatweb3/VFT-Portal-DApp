# step_align_price (app/src/service.rs L1218-L1274)

## 1. Purpose

Graduation step `GradStep::AlignPrice` (state.rs L76). Before depositing liquidity, if the RivrDEX
wVARA/token pair already holds reserves (a third party created and seeded it), the launchpad swaps
into it once so the pair's price moves toward the curve's final price `pool_vara / pool_tokens`.
It then rewrites the launch's deposit budgets (`wvara_budget`, `token_budget`) that
`step_add_liquidity` (L1286-L1291) consumes.

Doc comment (L1218-L1220) claims idempotence: an aligned pool is a no-op.

## 2. Inputs and context

- `launch: &Launch` is a **clone** taken inside `graduate` at L703, after `lock = true` (L702). All
  fields read here (`liquidity_added`, `pair`, `wvara_is_token0`, `pool_vara`, `pool_tokens`,
  `wvara_budget`, `token_budget`, `token`) are the snapshot values, not live storage.
- `gas: &GasConfig` is read live from config in `graduate` (L672).
- Caller: only `graduate` L717. Reached when `launch.step == AlignPrice`, which happens:
  - after `ApproveWvara` succeeds (state.rs L93), or
  - on retry from `Failed` when the failed step was `AddLiquidity` and `!liquidity_added` (L696-L698).
  - on retry from `Failed` at `AlignPrice` itself (state stays at the failed step, L690-L699).
- `AlignPrice` is not in `is_unwindable` (state.rs L105-L112): once the launch is at this step,
  `unwind` (L789) is unavailable; the only exit is forward progress through `graduate`.

Upstream values:
- `pool_vara = escrow.saturating_sub(graduation_fee)` at sell-out (L1109); `wvara_budget = pool_vara`,
  `token_budget = pool_tokens` (L1111-L1112). Also initialised at launch (L470-L471).
- `pool_tokens = config.total_supply - config.curve_supply` (L244).
- `pair` and `wvara_is_token0` written by `step_find_or_create_pair` (L1210-L1214); `wvara_is_token0`
  is `token0 == wvara` from the pair's own `GetTokens` reply (L1209).
- Allowances: `ApproveToken` approves the pair for `pool_tokens` (L709); `ApproveWvara` for `pool_vara`
  (L713). The swap here is expected to spend from those allowances; `step_add_liquidity` re-approves the
  exact deposit (comment L1311, calls L1312-L1313).

## 3. Block-by-block

### L1222-L1224 early exit
Returns `Ok` when snapshot `liquidity_added` is true. `liquidity_added` is set only in
`mark_liquidity_added` (L1327).

### L1225-L1226 reserves
`pair_get_reserves` (wire.rs L217-L219): `call_typed` to `Pair::GetReserves`, decoded as `(U256,U256)`
after checking the service/method prefix (wire.rs L45-L53). Any send failure, timeout, error reply,
or decode mismatch returns `Err` and the step fails (propagated by `?`). The values are whatever the
pair replies; nothing cross-checks them against balances. The pair is semi-trusted RivrDEX code but its
reserves are set by untrusted third parties trading/seeding it.
`(rw, rt)` orientation uses snapshot `wvara_is_token0` (L1226).

### L1227-L1231 zero-reserve exit
If either reserve is zero, returns `Ok` without swapping. An empty pair (fresh, or created by us at
step 2) passes here. A pair with exactly one zero reserve also passes as "aligned".

### L1232-L1238 tolerance check
`lhs = rw*pt`, `rhs = rt*pv`; returns `Ok` when `|lhs-rhs|*100 <= rhs` (1 % relative to `rhs`).
Arithmetic is plain `U256` `*`/`-`; no `checked_*` is used. `diff` is computed with an ordered branch
(L1235) so it does not underflow.
If `pv == 0`, `rhs == 0` and the check passes only if `lhs == 0`, which is impossible here because
`rw, pt` are nonzero when reached (unless `pt == 0`).

### L1239-L1240 target reserve
`k = rw*rt`; `rw_target = isqrt( floor(k/pt)*pv + floor((k%pt)*pv/pt) )`, i.e. approximately
`sqrt(k*pv/pt)`, the wVARA reserve at which `rw/rt == pv/pt` on the constant-product curve with no fee.
- `k / pt` and `k % pt` divide by `pt`; nothing in this function checks `pt != 0`.
- `rw_target` is 0 whenever `k*pv/pt < 1` (e.g. dust reserves with `pv < pt`). This matters at L1254.
- Formula ignores the pair's swap fee, so the post-swap price is computed against fee-free k.

### L1241 deadline
`block_timestamp() + 600_000` ms. Passed to the pair as `deadline: u64` (rivr_pair.idl L144);
the IDL describes it as "Unix timestamp" (L143), units not otherwise confirmed.

### L1242-L1243 gross-up
`gross(net) = net*10000/9965 + 1`: hard-codes a 0.35 % input fee (comment L1242). Nothing reads the
pair's actual fee config.

### L1245-L1251 branch A: `rw < rw_target` (tokens too cheap)
- `amount_in = min(gross(rw_target - rw), wvara_budget/2)` (L1247). Subtraction is safe in-branch.
  The cap halves the **current** budget on every invocation.
- `out = pair_get_amount_out(pair, amount_in, wvara_is_token0)` (L1248; wire.rs L221-L228), a quote.
- `min_out = out*98/100` (L1249).
- `pair_swap_exact_in(pair, amount_in, min_out, dir, deadline)` (L1250; wire.rs L230-L248): `call_null`
  with `gas_for_add_liquidity`, value 0. Success means the reply was empty or carried a matching
  `Pair/SwapExactTokensForTokens` prefix (wire.rs L57-L68). The reply carries no amount; the actual
  output is never observed.
- New budgets: `wvara_budget - amount_in`, `token_budget + min_out` (L1251). The token side is credited
  with `min_out`, not the actual received amount. `wvara_budget - amount_in` cannot underflow because
  `amount_in <= wvara_budget/2`.

### L1252-L1260 branch B: `rw >= rw_target` (tokens too expensive)
- `rt_target = k / rw_target` (L1254): divides by `rw_target` with no zero check. Branch B is taken
  whenever `rw_target == 0` (since `rw >= 0`), so the zero case of L1240 always lands here.
- `amount_in = min(gross(rt_target.saturating_sub(rt)), token_budget/2)` (L1255). With saturating_sub,
  the minimum `amount_in` is `gross(0) = 1` token unit.
- Branch B also includes `rw == rw_target`, where no wVARA-side move is needed but a swap of at least
  1 unit is still sent.
- Quote with direction `!wvara_is_token0` (L1256), `min_out = 98 %` (L1257), swap (L1258).
- New budgets: `wvara_budget + min_out`, `token_budget - amount_in` (L1259). wVARA side credited with
  `min_out`, not actual.

### L1261-L1267 event
Emits `ImbalancedListing` with the pre-swap reserves; `.expect("event")` panics on emit failure.

### L1268-L1272 state write
Writes the computed budgets to live storage via `with_state_mut`. This is the only write the function
performs, and it occurs only after the swap reply. Returns `Ok`, after which `graduate` advances to
`AddLiquidity` (L732-L735).

## 4. Interaction with neighbours

- **One swap per call.** `graduate` advances to `AddLiquidity` on `Ok` regardless of whether the pool
  reached the target. `step_add_liquidity` re-checks the price with a 2 % tolerance (L1302-L1310) and
  returns `Err(Reply)` if off; `CallError::is_retryable` is always true (wire.rs L33-L35); the retry in
  `graduate` resets `AddLiquidity -> AlignPrice` (L696-L698). Progress therefore comes from repeated
  keeper/anyone calls, each capped at half of the remaining budget of the swapped side.
- **No path back.** Unwind is not available from `AlignPrice`/`AddLiquidity` (state.rs L105-L112).
  A pair whose price cannot be brought within 2 % keeps the launch cycling in Failed/Graduating.
- **Budget vs holdings.** Budgets are bookkeeping; holdings are external balances. After branch A,
  actual tokens received >= `min_out` (if the pair honours its slippage bound) so `token_budget`
  understates holdings; after branch B, `wvara_budget` understates wVARA held. `step_add_liquidity`
  deposits from budgets (L1286-L1291) and `step_settle` sweeps residuals: wVARA `held - wvara_expected`
  is burned and booked as protocol revenue (L1369-L1376, L1393); leftover tokens go to `lp_dead`
  (L1379-L1385).
- **`wvara_expected` (global).** Not touched here. Branch A spends up to `wvara_budget/2` of this
  launch's wVARA from the launchpad's single wVARA balance, which is shared with other launches between
  `step_wrap` (L1186) and `mark_liquidity_added` (L1326). `mark_liquidity_added` subtracts the full
  `pool_vara` regardless of what was swapped or deposited.
- **Allowances.** Swaps consume the pair allowance granted at L709/L713; `step_add_liquidity`
  re-approves the exact deposit (L1312-L1313). Whether the pair pulls via `TransferFrom` (allowance) is
  inferred from the RivrDEX IDL message-status names (`SendingMsgToTransferTokenIn`, idl L77) only.

## 5. Failure paths

| Point | Outcome | State effect |
|---|---|---|
| L1225 Err | step fails, Failed/retryable | none |
| L1248/L1256 Err | step fails | none; no swap sent |
| L1250/L1258 Err(Reply/Decode/Send) | step fails | budgets unchanged; swap outcome unknown for Decode |
| L1250/L1258 Err(Timeout) | step fails | budgets unchanged; swap may have executed on the pair |
| L1240 `pt == 0` or L1254 `rw_target == 0` | U256 division by zero panics inside the continuation after an `await` | see open question on `lock` |
| L1233/L1234/L1239/L1240 multiplication overflow | U256 `*` panics on overflow | see open question on `lock` |
| L1267 emit fails | panic | same |

After a timeout at the swap, the next retry re-reads reserves and recomputes from the **un-decremented**
snapshot budgets; the budgets no longer describe what the launchpad holds for this launch.

## 6. Invariants (cited)

1. Only state written is `wvara_budget`/`token_budget` of this launch, only after a successful swap
   reply (L1268-L1272).
2. Each invocation sends at most one swap, with `amount_in <= budget/2` of the input side
   (L1247, L1255).
3. The budget of the input side never underflows (L1251, L1259 with caps at L1247, L1255).
4. The output-side budget is credited with `min_out = 98 %` of a quote taken one `await` earlier, not
   with the realised output (L1249-L1251, L1257-L1259).
5. No swap when `liquidity_added` (L1222), when either reserve is zero (L1229), or within 1 % (L1236).

## 7. Assumptions

- `pt != 0`: established by nothing in this function; depends on admin config `total_supply > curve_supply` (L244) — nothing found enforcing it at L244.
- `rw_target != 0` before L1254: nothing found.
- U256 products at L1233, L1234, L1239, L1240 do not overflow: nothing found (no checked arithmetic); bounded only by token/wVARA supplies held by the pair.
- Pair reserves reflect real balances and the reply of `GetReserves` is honest: RivrDEX Pair (black box; IDL only).
- Pair's swap fee is 0.35 % (L1242-L1243): nothing found reading it from the pair.
- Pair delivers `>= amount_out_min` when the swap reply is success: RivrDEX Pair (black box); the reply is `null` (idl L144), no amount is returned.
- Reserves are unchanged between L1225, L1248 and L1250: nothing found; each `await` is an interleaving point where anyone can trade on the pair.
- Snapshot budgets equal live budgets: `graduate` holds `lock` (L702) across the call and only graduate/commit_trade/launch write budgets; commit_trade cannot run in Graduating state (buy/sell gating) — gating of sell in Graduating not re-verified here.
- Allowance from L709/L713 covers `amount_in`: holds because `amount_in <= budget/2 <= pool_*` on the first pass; after earlier swaps or partial allowance consumption, nothing found re-approving before the swap.
- A timed-out swap did not execute: nothing found; budgets are not reconciled against balances.
- `wvara_is_token0` matches the pair's actual token order: established by `step_find_or_create_pair` L1209-L1213 from the pair's own reply.
- `pool_vara > 0`: `commit_trade` L1109 uses `saturating_sub`; nothing found guaranteeing escrow > graduation_fee at sell-out.

## 8. Open questions

- unclear; need to inspect gstd async semantics: when the continuation panics after an `await` (L1240, L1254, overflow, L1267), whether `lock = true` written at L702 before the first await persists, leaving `graduate` and `unwind` permanently panicking with "GraduationInProgress" (L681-L682, L793-L794). No `handle_signal`/reply-panic recovery was seen in service.rs.
- unclear; need to inspect RivrDEX Pair source: whether `SwapExactTokensForTokens` pulls input via `TransferFrom` against the launchpad's allowance, and whether its success reply is sent before or after the output transfer completes (idl L65-L93 show a multi-message pipeline with `SwapRefund`).
- unclear; need to inspect RivrDEX Pair source: actual fee rate vs the 0.35 % hard-coded at L1243, and whether `deadline` is milliseconds.
- unclear; need to inspect units of `pool_vara` (VARA base units) vs `pool_tokens` (token base units) to determine for which reserve sizes `rw_target` rounds to 0 at L1240.
- unclear; need to inspect whether `sell` is rejected in `Graduating`/`Failed` states, which is what keeps the snapshot budgets/escrow stable across the awaits.
- unclear; need to inspect whether escrow at sell-out can be below `graduation_fee`, making `pool_vara == 0` (L1109) and `rhs == 0` at L1234.
