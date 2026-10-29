---
id: ARITHOFL-002
bug_class: arithmetic-overflow
title: Unchecked u32 `ready_at + graduation_timeout_blocks` in unwind panics when the timeout is large
location: contracts/launchpad/launchpad/app/src/service.rs:788
function: unwind
confidence: Low
worker: worker-2
fp_verdict: LIKELY_TP
fp_rationale: "Verified u32 ready_at + timeout at service.rs:788 with no bound in set_limits; panics only if admin sets a near-u32::MAX timeout, pre-await so it reverts cleanly"
severity: LOW
attack_vector: Remote
exploitability: Theoretical
severity_rationale: "Needs a pathological admin timeout value; consequence is loss of the stale-Ready unwind hatch, no state corruption"
---

## Description
`unwind` checks staleness with `exec::block_height() >= launch.ready_at + timeout`. Release builds
have `overflow-checks = true`, so this u32 addition panics whenever
`ready_at + graduation_timeout_blocks > u32::MAX`. `set_limits` accepts any u32 timeout without
validation, so a large value (for example `u32::MAX` to mean "never auto-unwind" or "very long")
makes the stale-Ready unwind path panic. For a Failed launch the panic also blocks the
`failed_early` path, because `stale_ready` is evaluated first.

## Code
```rust
let timeout = st.config.graduation_timeout_blocks;
let launch = st.launch_mut(&token);
let stale_ready = launch.state == LaunchState::Ready
    && exec::block_height() >= launch.ready_at + timeout;   // u32 overflow -> panic
let failed_early = launch.state == LaunchState::Failed && launch.step.is_unwindable();
```
(`&&` short-circuits, so the addition only runs for `Ready` launches. The Failed path is not affected.)

## Data flow
- **Source:** `graduation_timeout_blocks` set by the admin through `set_limits` (no bounds check). `ready_at` is the block height when the curve sold out.
- **Sink:** u32 `+` at service.rs:788.
- **Validation:** none.

## Reachability trace
admin `set_limits(.., graduation_timeout_blocks = u32::MAX, ..)` → a launch reaches Ready → anyone calls `unwind(token)` → overflow panic.

## Impact
The stale-Ready escape hatch cannot be used for those launches: the call panics before its first
await, so there is no state corruption. Sellers stay locked in a Ready launch that no one
graduates. Admin-configuration dependent, so low.

## Mitigations checked
- The panic is pre-await, so it reverts cleanly, but the unwind is unavailable.
- `launch_cooldown_blocks` uses `saturating_add` (line 356). The inconsistency suggests saturation was intended here too.

## Recommendation
Use `launch.ready_at.saturating_add(timeout)`, and/or bound `graduation_timeout_blocks` in `set_limits`.
