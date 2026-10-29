---
id: CANCELSAFETY-004
bug_class: cancel-safety
title: Reconcile sets lock before balance query await; starved continuation leaves lock and stuck trade permanently unresolved
location: contracts/launchpad/launchpad/app/src/service.rs:634
function: reconcile
confidence: Medium
worker: worker-11
fp_verdict: TRUE_POSITIVE
fp_rationale: "Verified reconcile sets lock=true at service.rs:634 and clears only after vft_balance_of await; gas-starved Reconcile leaves lock held and stuck trade unresolvable"
severity: HIGH
attack_vector: Remote
exploitability: Difficult
severity_rationale: "Same permanent-freeze impact as CANCELSAFETY-001 but requires a stuck (timed-out) trade to exist first, which the attacker cannot force"
---

## Description
`reconcile` is permissionless. When a trade is stuck, it sets `launch.lock = true`, awaits `Vft.BalanceOf`, and clears the lock only in the continuation (line 639). An attacker who calls `Reconcile(token)` with too little gas for the continuation (or for waitlist rent) leaves `lock = true` permanently. Every later `reconcile` then panics with `ReconcileInProgress`, the stuck `busy` trade can never be resolved, and trading, graduation and unwind all stay blocked.

## Code
```rust
// service.rs:625-639
let pending = self.with_state_mut(|st| {
    let launch = st.launch_mut(&token);
    if launch.lock { panic!("ReconcileInProgress") }
    let pending = match &launch.busy { Some(p) if p.stuck => p.clone(), _ => panic!("NotStuck") };
    launch.lock = true;
    pending
});
let held = wire::vft_balance_of(token, me, &gas).await;          // continuation may never run
self.with_state_mut(|st| st.launch_mut(&token).lock = false);
```

## Data flow
- **Source:** attacker-chosen gas limit on a permissionless `Reconcile` message
- **Sink:** `launch.lock = true` at service.rs:634; the clear at service.rs:639 is skipped
- **Validation:** none

## Reachability trace
Any trade times out (the `TradeStuck` event is publicly visible) → the attacker front-runs the keeper with a gas-starved `Reconcile(token)` → `lock = true` persisted → `vft_balance_of(..).await` → continuation runs out of gas. After that, `reconcile` → `ReconcileInProgress`, and `buy`/`sell`/`graduate`/`unwind` are blocked by `busy`/`lock`.

## Impact
Any temporary reply timeout becomes a permanent freeze of the launch and its escrow, including the buyer's stuck VARA. It requires a stuck trade to exist. The attacker cannot force one directly, but the design explicitly expects them to happen.

## Mitigations checked
- No `gstd::critical` hook, no `exec::system_reserve_gas`, and no `handle_signal` logic that restores state anywhere in `launchpad/app`. Searching for `critical|reserve|handle_signal` finds only comments.
- No admin or timeout-based escape hatch clears `lock` / `busy`. Every admin setter (`set_gas`, `set_addresses`, `set_limits`, …) touches only config. No exported method writes `lock = false` or `busy = None` outside the post-await code paths.
- The gtest suite cannot reproduce this: gtest messages are sent with plenty of gas and replies land in the same block (docs/audit/test-matrix.md:47). No test sends a gas-starved message to the launchpad.
- docs/audit/threat-model.md A2/A3 treat `busy`/`lock` as protection against interleaving but do not consider a continuation that never completes.

## Recommendation
Do not hold a lock across the query at all. The reconcile decision is checked against current state after the reply anyway, so a sequence check on `pending.seq` can replace the lock. Alternatively, make the lock expire after `reply_timeout + margin` blocks, and require a minimum `exec::gas_available()` before the await.
