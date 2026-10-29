# step_settle — app/src/service.rs L1363-L1399

## 1. Purpose

Last real step of graduation (`GradStep::Settle`, dispatched at service.rs L723; `Settle.next() == Done`, state.rs L100). It:

1. Queries the three VFT role-holder lists and derives `renounced` (L1364-L1367).
2. Reads the launchpad's wVARA balance, compares it with the **global** `State.wvara_expected`, and burns any excess back to native VARA, recording it as `recovered` (L1369-L1376).
3. Reads the launchpad's balance of the launch token and transfers all of it to `addrs.lp_dead` (L1379-L1385).
4. In one synchronous state closure (L1386-L1397): records `roles_renounced`, charges the pair-creation fee against escrow, moves the remaining escrow plus `recovered` into `launch.protocol_fees`, zeroes escrow, and adjusts `total_liabilities` by `-pair_fee + recovered`.

No share of the leftover goes to `creator_fees`; everything lands in `protocol_fees` (L1393). `creator_fees` is written only in `commit_trade` (L1101) and `claim_creator_fees` (L840).

## 2. Inputs and context

- `launch: &Launch` — a clone taken in `graduate` at L703, under `lock = true` (L702). Fields used from the snapshot: `token`, `addrs.wvara`, `addrs.lp_dead`. Fields read **fresh** from state inside the closure: `pair_created_by_us`, `pair_creation_fee`, `escrow` (L1387-L1391).
- `me` = `exec::program_id()` (L705).
- `gas` = live gas config (`self.gas()`, L672).
- Caller: `graduate` only (L723). Reachable by anyone (permissionless `graduate`, L668-L670) once the launch's `step == Settle` and state is `Graduating` or retryable `Failed` (L684-L699).

## 3. Line-by-line

### L1364-L1367 role queries
Three `vft_role_holders` calls (wire.rs L191-L193 → `call_typed` → `call`, wire.rs L70-L88, L90-L109). Each is a request/reply to the launch token program; `?` propagates any `CallError`. `renounced` is true only when all three vectors are empty. The result is **recorded, not enforced**: a non-empty list does not return an error; L1388 writes `roles_renounced = renounced` either way. Prior steps `RevokeMinter/RevokeBurner/RevokeAdmin` (L720-L722, `step_revoke` L1348-L1361) only remove `me`; other holders (e.g., any account the VFT was initialised with or granted by `me` earlier) are not touched there.

### L1369-L1376 wVARA leftover
- `held` = `vft_balance_of(wvara, me)` (wire.rs L181-L183). Awaited reply.
- `expected` = `st.wvara_expected` read after the reply lands (L1370), with no await between L1369's resume and L1370.
- If `held > expected`: `leftover = held - expected`, `wvara_burn(wvara, leftover)` (wire.rs L278-L280, `call_null`, value 0), then `recovered = leftover.low_u128()` (L1375) — a truncating conversion of U256 to u128.
- `wvara_expected` is global across launches (state.rs L220-L221). Writers:
  - `step_wrap` adds `pool_vara` **after** the mint await returns (L1183 then L1186).
  - `mark_liquidity_added` subtracts `pool_vara` (saturating) (L1326), regardless of how much wVARA `step_add_liquidity` actually deposited (`amount_w` ≤ `pool_vara`, L1286-L1291).
  - `unwind_wrapped` subtracts `pool_vara` on the wrapped path after a burn (L1408).
- Therefore `held - expected` at L1373 equals the sum, across all launches, of: wVARA not consumed by this launch's AddLiquidity (pool_vara − amount_w, plus/minus AlignPrice swap effects L1245-L1260), wVARA for any other launch whose mint has executed but whose `step_wrap` has not yet reached L1186 (in-flight reply or timed-out-but-landed mint — the L1178 comment acknowledges this case), leftover from other launches that passed AddLiquidity but have not yet run Settle, and any wVARA transferred to the launchpad by third parties. Nothing in step_settle attributes the excess to this launch specifically.
- Native VARA returned by the burn is assumed to arrive in the program's balance; the function never checks `exec::value_available()` before/after.

### L1379-L1385 stray tokens
- `tokens_left = vft_balance_of(token, me)`; if nonzero, `vft_transfer(token, lp_dead, tokens_left)`; a `false` reply maps to `Err(CallError::Reply)` (L1382-L1384).
- This is the launchpad's full balance of the token, not a launch-scoped budget figure (`token_budget` is not consulted). In `Graduating` state `busy` cannot be set by trades (sell is Trading/Aborted only, per system context; `graduate` panics if `busy.is_some()`, L678-L680), so no pending trade tokens are in flight for this launch.

### L1386-L1397 accounting closure
- `l.roles_renounced = renounced` (L1388).
- `pair_fee = pair_created_by_us ? min(pair_creation_fee, escrow) : 0` (L1390). The pair fee was paid out of the free reserve at step 2 (`factory_create_pair` with value, L1200; comment L1201-L1202), not from escrow, and not booked against liabilities at that time.
- `l.escrow -= pair_fee` (L1391) — cannot underflow because of the `min`.
- `l.protocol_fees += l.escrow + recovered` (L1393) — plain `+` on u128 (overflow panics in debug; wasm release behaviour depends on profile — see open questions).
- `l.escrow = 0` (L1394).
- `st.settle(pair_fee)` (L1395, state.rs L259-L264) decreases `total_liabilities` with checked_sub, panicking on underflow.
- `st.owe(recovered)` (L1396, state.rs L252-L257) increases liabilities with checked_add.
- Net liability effect: escrow (a liability) is converted 1:1 into protocol_fees (also a liability) except `pair_fee`, which leaves liabilities because it was already spent from the reserve; `recovered` is newly booked as a liability backed by the burn proceeds.

Escrow value at this point: `commit_trade` sets `pool_vara = escrow − graduation_fee` (L1109, saturating); `step_wrap` does `escrow -= pool_vara` (L1190). So escrow entering Settle equals `min(escrow_at_ready, graduation_fee)` — i.e., the graduation fee, unless escrow at sell-out was below it. `set_fees` enforces `graduation_fee_vara >= pair_creation_fee_vara` at L1018 for future configs; `pair_creation_fee_vara` has no setter (only reads at L458, L1018), and lib.rs contains no check relating the two at init (no match for either name in lib.rs). The `min` at L1390 covers the case where escrow < pair_creation_fee; the difference is then absorbed by the reserve without being charged anywhere.

## 4. Paths and partial completion

All external calls precede the state closure. Every error path returns before L1386, so on error **no** state from this step is written; `graduate` then marks `Failed` with `fail_retryable = true` (L756-L764; `is_retryable` always true, wire.rs L33-L35). On retry, Settle re-runs from the top.

Side effects that are **not** rolled back on a later error inside the same step:
- Path A: `wvara_burn` succeeds (L1374), then `vft_balance_of(token)` or `vft_transfer` errors (L1379-L1384). The burn's native VARA is now in the program's free balance; `recovered` was never booked. On retry `held == expected` (assuming no other movement), so `recovered = 0` and the burned amount stays unbooked (it ends up in `free_balance`, i.e. `value_available - total_liabilities`, L1063).
- Path B: `wvara_burn` returns `Timeout` after executing on the wVARA side. Same as Path A on retry.
- Path C: `vft_transfer` to lp_dead times out after executing: retry reads `tokens_left == 0`, skips. Converges.
- Path D: role-query failures: no side effects.

Gear message semantics: state writes before an await are persisted at the await; `lock` (L702) is the only guard against a second `graduate`/`unwind` on the same launch during these awaits (L681-L683, L793-L795). Other launches' `graduate`/`unwind` are not blocked and can mutate `wvara_expected` and the wVARA balance between L1369's send and reply, and between this step's calls.

`claim_protocol_fees` (L849-L871) has no state or lock check, so it can be called for this launch at any time; it is synchronous (no await), so it cannot interleave inside the closure.

## 5. Invariants this function maintains or relies on

- I1: After success, `launch.escrow == 0` (L1394).
- I2: `pair_fee <= escrow` before subtraction (L1390 `min`).
- I3: Liability delta of the closure is `recovered - pair_fee` (L1395-L1396), and `escrow → protocol_fees` is liability-neutral (L1393-L1394).
- I4: Settle writes state only after every external call succeeded (L1364-L1385 all `?`/early-return before L1386).
- I5: `roles_renounced` reflects a point-in-time query and does not gate completion (L1367, L1388, Ok at L1398).

## 6. Assumptions

| Claim | Established by |
|---|---|
| `held - expected` is attributable to this launch | nothing found; `wvara_expected` is global (state.rs L221) and other launches mutate it after their awaits (L1186, L1326, L1408) |
| No other launch has a landed-but-unbooked mint when Settle reads balance | nothing found; step_wrap books only after mint reply (L1183-L1186) |
| `wvara_burn` returns exactly `leftover` native VARA to the launchpad | nothing found (external wVARA program; no balance check after) |
| `leftover` fits in u128 | nothing found; `low_u128()` truncates (L1375) |
| Escrow at Settle equals the graduation fee | commit_trade L1109 + step_wrap L1190; only if escrow at Ready ≥ graduation_fee (saturating_sub at L1109) |
| graduation_fee ≥ pair_creation_fee | set_fees L1018 for later configs; nothing found for initial config (lib.rs) |
| Pair fee was actually paid when `pair_created_by_us` | step_find_or_create_pair L1200-L1203 sets flag only after `factory_create_pair` returned Ok; a Timeout that executed leaves the flag false |
| All VFT tokens held by `me` belong to this launch's leftover | token is per-launch (L1379 uses launch.token); no other launch holds it |
| VFT role queries are truthful | nothing found (semi-trusted spawned VFT) |
| `lp_dead` is a sink | config/admin (trusted), snapshot in launch.addrs |
| protocol_fees + escrow + recovered does not overflow u128 | nothing found (plain `+`, L1393) |
| total_liabilities ≥ pair_fee | state.rs L262 panics otherwise |

## 7. Relation to the user question (structure only)

- Distribution of the "graduation fee" leftover: the code puts all of it (minus pair fee) plus recovered wVARA into `protocol_fees` (L1393), paid to `addrs.treasury` by `claim_protocol_fees` (L860-L862). A creator split would require a write to `creator_fees` here; none exists.
- The pool receives `pool_vara = escrow − graduation_fee` (L1109) wrapped at L1183, deposited at final curve price `pool_vara/pool_tokens` (L1284-L1291). Any wVARA not deposited returns via L1372-L1376.
- Trigger: `graduate` is already permissionless (L668-L670), one step per call; the sell-out buy only flips to Ready (L1104-L1108) and does not invoke graduation.

## 8. Open questions

- unclear; need to inspect Cargo.toml release profile for `overflow-checks` to know whether L1393 `+` wraps or panics.
- unclear; need to inspect lib.rs `new` for any init-time check that `graduation_fee_vara >= pair_creation_fee_vara` (grep found no reference in lib.rs).
- unclear; need to inspect the wVARA VftNativeExchange `Burn` implementation to confirm it sends exactly `amount` native VARA back to the caller and fails (rather than partially burns) when balance is insufficient.
- unclear; need to inspect the Tokenator VFT `Admins/Minters/Burners` query implementations and its init (admin_id) to know which accounts other than the launchpad can hold roles.
- unclear; need to inspect RivrDEX Factory `CreatePair` refund behaviour (overpaid / failed fee) to know whether `pair_creation_fee` is the exact amount spent.
