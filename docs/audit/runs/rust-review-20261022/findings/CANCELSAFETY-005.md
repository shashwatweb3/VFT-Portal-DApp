---
id: CANCELSAFETY-005
bug_class: cancel-safety
title: Unwind sets lock before wVARA await; starved continuation blocks both unwind and graduation forever
location: contracts/launchpad/launchpad/app/src/service.rs:796
function: unwind
confidence: High
worker: worker-11
fp_verdict: TRUE_POSITIVE
fp_rationale: "Verified unwind sets lock=true at service.rs:796 and clears only after unwind_wrapped await; gas-starved Unwind blocks unwind and graduate permanently"
severity: HIGH
attack_vector: Remote
exploitability: Reliable
severity_rationale: "Permanently bricks the escape hatch and the launch escrow; precondition is a stale-Ready or early-Failed launch"
---

## Description
`unwind` becomes permissionless once a launch has sat in `Ready` past the timeout, or is `Failed` at an unwindable step. It sets `launch.lock = true` and then awaits `wvara_burn` / `vft_balance_of`. Both `lock = false` and the move to `Aborted` happen only in the continuation. A gas-starved `Unwind` message leaves the lock set permanently: further `Unwind` and `Graduate` calls panic with `GraduationInProgress`, and the state never reaches `Aborted`, so sells never reopen. If the continuation dies after a `wvara_burn` actually executed, the VARA is back in the program but `wrapped`, `escrow` and `wvara_expected` are never updated.

## Code
```rust
// service.rs:783-801
let (launch, expected) = self.with_state_mut(|st| {
    ...
    if launch.lock || launch.busy.is_some() { panic!("GraduationInProgress") }
    launch.lock = true;
    (launch.clone(), expected)
});
let result = self.unwind_wrapped(&launch, me, expected, &gas).await;   // continuation may never run
self.with_state_mut(|st| st.launch_mut(&token).lock = false);
```

## Data flow
- **Source:** attacker-chosen gas limit on a permissionless `Unwind` message
- **Sink:** `launch.lock = true` at service.rs:796; the clear at service.rs:801 is skipped
- **Validation:** none

## Reachability trace
Launch sits in `Ready` for `graduation_timeout_blocks` (or is `Failed` at steps 1-4) → `Unwind` with low gas → lock persisted → `unwind_wrapped(..).await` → continuation runs out of gas → every recovery path is blocked.

## Impact
One message bricks the recovery path that is meant to return pool VARA to escrow and reopen sells. The launch's entire escrow is locked permanently and holders can no longer sell.

## Mitigations checked
- No `gstd::critical` hook, no `exec::system_reserve_gas`, and no `handle_signal` logic that restores state anywhere in `launchpad/app`. Searching for `critical|reserve|handle_signal` finds only comments.
- No admin or timeout-based escape hatch clears `lock` / `busy`. Every admin setter (`set_gas`, `set_addresses`, `set_limits`, …) touches only config. No exported method writes `lock = false` or `busy = None` outside the post-await code paths.
- The gtest suite cannot reproduce this: gtest messages are sent with plenty of gas and replies land in the same block (docs/audit/test-matrix.md:47). No test sends a gas-starved message to the launchpad.
- docs/audit/threat-model.md A2/A3 treat `busy`/`lock` as protection against interleaving but do not consider a continuation that never completes.

## Recommendation
Same fixes as CANCELSAFETY-001: require a minimum `gas_available()` before taking the lock, use a block-stamped lock that expires and can be taken over after `reply_timeout + margin`, or register a `gstd::critical` hook with a system reservation that clears the lock on trap.
