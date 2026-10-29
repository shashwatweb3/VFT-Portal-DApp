---
id: ARITHOFL-001
bug_class: arithmetic-overflow
title: Division by zero in AlignPrice (rw_target == 0) after await permanently locks a graduating launch
location: contracts/launchpad/launchpad/app/src/service.rs:1254
function: step_align_price
confidence: High
worker: worker-2
fp_verdict: TRUE_POSITIVE
fp_rationale: "Verified at service.rs:1254 and reproduced by gtest PoC: dust-seeded pair (1001/1001) makes rw_target=0, else-branch k/rw_target panics after await, leaving lock=true/Graduating forever"
severity: CRITICAL
attack_vector: Remote
exploitability: Reliable
severity_rationale: "Permissionless, ~1 VARA attack permanently freezes a sold-out launch's pool VARA, fee escrow and pool tokens with no recovery path; repeatable against every launch"
---

## Description
`step_align_price` reads the RivrDEX pair reserves `(rw, rt)` and computes
`rw_target = sqrt(k * pv / pt)` with `k = rw * rt`. If an attacker pre-seeds the pair with a
tiny pool, `k * pv < pt` and `rw_target` comes out as **0**. The `rw < rw_target` check is then
false, so execution takes the `else` branch and runs `k / rw_target`. That is a U256 division by
zero, which always panics (`uint::div_mod` does `assert!(your_bits != 0, "division by zero")`),
whatever `overflow-checks` is set to.

The panic happens after at least one `.await` (`pair_get_reserves`). In Gear, state committed
before the first await stays committed: `launch.lock = true` and `state = Graduating` (set in
`graduate` at line 702). The `lock = false` reset at line 726 never runs. Every later call then
fails:
- `graduate` panics `GraduationInProgress` (line 681)
- `unwind` needs `Ready`/`Failed` and `!lock`, so it panics
- `reconcile`, `buy` and `sell` reject (`lock`, or state not Trading/Aborted)

No admin method clears `lock`.

## Code
```rust
let (r0, r1) = wire::pair_get_reserves(launch.pair, gas).await?;   // await -> lock=true committed
let (rw, rt) = if launch.wvara_is_token0 { (r0, r1) } else { (r1, r0) };
...
if diff * U256::from(100u32) <= rhs { return Ok(()); }              // dust seed is far off-price
let k = rw * rt;
let rw_target = (k / pt * pv + (k % pt) * pv / pt).integer_sqrt();  // == 0 when k*pv < pt
...
let (wvara_budget, token_budget) = if rw < rw_target {              // false when rw_target == 0
    ...
} else {
    let rt_target = k / rw_target;                                  // line 1254: divide by zero -> panic
```

## Data flow
- **Source:** pair reserves set by an attacker who calls `Factory.CreatePair(wVARA, token)` (permissionless) and the pair's `AddLiquidity` with dust amounts (e.g. 1001 planck wVARA + 1001 token base units; RivrDEX only needs `sqrt(a*b) >= 1000`).
- **Sink:** `k / rw_target` at service.rs:1254.
- **Validation:** none. The only checks are `rw.is_zero() || rt.is_zero()` and the 1% price tolerance, and a dust seed fails the tolerance check, so it falls through to the division.

Worked numbers: pt = 200M * 1e18 = 2e26, and pv is about 3e17 planck (~300k VARA) or 5.9e14 (592 VARA). Then pt/pv is about 6.7e8 to 3.4e11, and a seed with k = 1001*1001 ≈ 1e6 is below it, so `k*pv/pt` floors to 0 and `rw_target = 0`. This holds for any realistic pool_vara below about 2e8 VARA.

## Reachability trace
attacker: buy 1001 base units of token on the curve → `Factory.CreatePair` → `Pair.AddLiquidity(1001, 1001)` → curve sells out → keeper (or anyone) calls `graduate` through WrapVara, FindOrCreatePair (returns the attacker's pair), ApproveToken, ApproveWvara → `graduate` at AlignPrice → `step_align_price` → `k / rw_target` panics.

## Impact
Permanent DoS and loss of funds for the launch. All of these are stuck forever with no recovery path:
- the full pool VARA (already wrapped to wVARA and counted in `wvara_expected`)
- the remaining graduation-fee escrow
- the 200M pool tokens

Token holders can never sell back, and the curve never lists. It costs the attacker about 1 VARA (pair-creation fee), dust, and gas. It can be repeated against every launch.

## Mitigations checked
- overflow-checks are irrelevant here: divide-by-zero panics unconditionally.
- Tests cover a cheap seed (1e6 wVARA with 1e24 tokens, k = 1e30, rw_target > 0). They do not cover the case where k < pt/pv.
- No admin escape hatch resets `lock`. Gear keeps pre-await state when the handler traps after an await.

## Recommendation
Do not divide by `rw_target` when it is zero. Treat `rw_target == 0` (or `rw_target <= rw`, using
`checked_div`) as a reason to buy tokens with wVARA, or return `Err(CallError::Reply)`. More
generally, make every post-await computation in graduation steps non-panicking (checked ops that
map to `CallError`). Clear `lock` with a guard pattern, or add an admin/timeout-based lock reset
for launches whose lock has been held longer than N blocks.
