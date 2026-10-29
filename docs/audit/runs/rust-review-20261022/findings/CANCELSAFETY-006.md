---
id: CANCELSAFETY-006
bug_class: cancel-safety
title: AlignPrice swap that times out but executes leaves wvara/token budgets stale; AddLiquidity then fails forever at a non-unwindable step
location: contracts/launchpad/launchpad/app/src/service.rs:1250
function: step_align_price
confidence: Medium
worker: worker-11
fp_verdict: LIKELY_TP
fp_rationale: "Verified budgets updated only after swap reply (service.rs:1250-1272), aligned-pool early return on retry, add_liquidity sizes from stale wvara_budget, AddLiquidity not unwindable; trigger needs a swap reply timeout"
severity: MEDIUM
attack_vector: Remote
exploitability: Difficult
severity_rationale: "Requires a reply timeout the attacker can encourage but not force; stuck graduation, and stale wVARA budget may also draw on other launches' pooled wVARA"
---

## Description
`step_align_price` sends `Pair.SwapExactTokensForTokens` and updates `wvara_budget` / `token_budget` only after a successful reply (lines 1268-1272). In Gear, a `wait_up_to` timeout does not cancel the outbound message, so after `Err(Timeout)` the swap can still execute and spend launchpad wVARA (or tokens). The sequence that follows:
1. The step returns `Err`. `graduate` marks the launch `Failed` (retryable) and leaves `step = AlignPrice` with the old budgets.
2. On retry the pool is already aligned, so AlignPrice returns `Ok` early (lines 1236-1238) without touching the budgets.
3. `step_add_liquidity` sizes `amount_w = wvara_budget.min(pv)` from the stale, too-high budget, approves, and calls `AddLiquidity`. The call fails because the launchpad no longer holds that much wVARA (or tokens, in the sell direction).
4. `Err` → `Failed`; the retry rewinds to `AlignPrice` (a no-op), `AddLiquidity` fails again, and the loop never ends.

`AddLiquidity` is not in `is_unwindable()`, so `unwind` is not available either.

## Code
```rust
// service.rs:1245-1272
let amount_in = gross(rw_target - rw).min(launch.wvara_budget / U256::from(2u32));
let out = wire::pair_get_amount_out(launch.pair, amount_in, wvara_in_dir, gas).await?;
let min_out = out * U256::from(98u32) / U256::from(100u32);
wire::pair_swap_exact_in(launch.pair, amount_in, min_out, wvara_in_dir, deadline_ms, gas).await?;  // Timeout => early return, swap may still land
(launch.wvara_budget - amount_in, launch.token_budget + min_out)
...
self.with_state_mut(|st| { l.wvara_budget = wvara_budget; l.token_budget = token_budget; });   // skipped on timeout
// service.rs:1286
let mut amount_w = launch.wvara_budget.min(pv);   // stale on retry
```

## Data flow
- **Source:** the attacker pre-seeds the pair off-price (a documented threat) so AlignPrice has to swap, and the swap reply times out (queue congestion or a slow callee; the reply timeout is a config constant)
- **Sink:** the budgets are never reconciled with the executed swap, and `step_add_liquidity` uses them at service.rs:1286-1290
- **Validation:** the balance is never re-read (unlike `step_wrap`, which trusts the wVARA balance over its flag), and no pre-swap snapshot exists (unlike `pre_add_reserves`)

## Reachability trace
`Graduate` (AlignPrice) → `pair_swap_exact_in(..).await` → `Err(Timeout)` → `Failed` → `Graduate` retry → AlignPrice no-op → `AddLiquidity` → `pair_add_liquidity` fails (insufficient balance) → `Failed` → loop.

## Impact
Graduation is permanently stuck at AddLiquidity. The launchpad holds the pool's wVARA and tokens, there is no unwind path, and there is no admin path either because the budgets cannot be set. The launch's funds are stranded. The trigger needs a reply timeout on the swap, which the attacker can make more likely but cannot force reliably, hence Medium confidence.

## Mitigations checked
- The `pre_add_reserves` snapshot protects only against AddLiquidity's own lost reply, not AlignPrice's.
- AlignPrice is idempotent (a no-op when the pool is aligned), and that is exactly what hides the stale budget on retry.
- Timeout branches are not covered by gtest (docs/audit/test-matrix.md:47).

## Recommendation
Size the deposit from actual balances instead of cached budgets: `vft_balance_of(wvara, me)` minus other launches' `wvara_expected`, and `vft_balance_of(token, me)`. Alternatively, save a balance snapshot before sending the swap and reconcile the budgets on resume, the same way `pre_add_reserves` works.
