---
id: CANCELSAFETY-001
bug_class: cancel-safety
title: Graduate sets per-launch lock before await; gas-starved continuation leaves lock=true forever, freezing launch and its escrow
location: contracts/launchpad/launchpad/app/src/service.rs:702
function: graduate
confidence: High
worker: worker-11
fp_verdict: TRUE_POSITIVE
fp_rationale: "Verified lock=true at service.rs:702 cleared only post-await at 726, no gas floor/critical hook/escape hatch; reproduced by gtest PoC (gas-starved Graduate leaves lock=true at WrapVara, launch frozen)"
severity: CRITICAL
attack_vector: Remote
exploitability: Reliable
severity_rationale: "Any account can permanently freeze every sold-out launch's escrow with one cheap gas-starved message; reproduced"
---

## Description
`graduate` is permissionless. It writes `launch.state = Graduating` and `launch.lock = true` synchronously, then awaits a cross-program reply. The lock is cleared only in the continuation (line 726). Under Gear semantics, state written before the first `.await` is persisted when the message enters the waitlist. The continuation runs later on whatever gas is *left* in the caller's original message, and the caller chooses that gas limit. An attacker sends `Graduate(token)` with just enough gas to run the pre-await section and dispatch the outbound message. That message's own gas (`gas_for_token_ops`) and `gas_for_reply_deposit` are deducted at send time, leaving too little to run the continuation or to pay waitlist rent for `reply_timeout` blocks. The continuation then traps on out-of-gas (or the message is evicted from the waitlist), and `lock = false` never executes. This is the Gear version of a future cancelled at an await point with half-written state and no drop guard.

## Code
```rust
// service.rs:676-726
let (step, launch) = self.with_state_mut(|st| {
    let launch = st.launch_mut(&token);
    if launch.busy.is_some() { panic!("TradeInProgress") }
    if launch.lock { panic!("GraduationInProgress") }
    match launch.state {
        LaunchState::Ready => { launch.state = LaunchState::Graduating; launch.step = GradStep::WrapVara; }
        ...
    }
    launch.lock = true;                      // committed at the first await
    (launch.step, launch.clone())
});
let outcome = match step {
    GradStep::WrapVara => self.step_wrap(&launch, me, &gas).await,   // waits; continuation uses leftover caller gas
    ...
};
self.with_state_mut(|st| st.launch_mut(&token).lock = false);       // never reached if continuation traps
```

## Data flow
- **Source:** attacker-chosen gas limit on a `Launchpad/Graduate` message (permissionless, no value)
- **Sink:** `launch.lock = true` persisted at service.rs:702; the matching clear at service.rs:726 never executes
- **Validation:** none. There is no minimum `gas_available()` check before the await, no gas reserved for the continuation, and no critical hook.

## Reachability trace
`Graduate(token)` (any account; launch in `Ready`/`Graduating`/retryable `Failed`) → `with_state_mut` sets `lock = true` → `step_*().await` → waitlist → reply arrives / timeout → continuation runs out of gas → trap. After that, `Graduate` → `panic!("GraduationInProgress")` (line 681), `Unwind` → `panic!("GraduationInProgress")` (lines 793-794), and `Sell` → state is `Graduating`, so `panic!("NotTrading")`.

## Impact
One cheap message permanently freezes a graduating launch with no way to recover. Graduation can never progress, the launch can never be unwound, and sells are closed. The full escrow (about the raise target in VARA, or the wrapped pool wVARA) and that launch's creator/protocol fee bookkeeping are stranded in the launchpad forever. Any griefer can do this to every launch the moment its curve sells out, and can front-run the keeper's own Graduate in the same block. `total_liabilities` stays inflated, which also reduces `free_balance` for the whole program.

## Mitigations checked
- No `gstd::critical` hook, no `exec::system_reserve_gas`, and no `handle_signal` logic that restores state anywhere in `launchpad/app`. Searching for `critical|reserve|handle_signal` finds only comments.
- No admin or timeout-based escape hatch clears `lock` / `busy`. Every admin setter (`set_gas`, `set_addresses`, `set_limits`, …) touches only config. No exported method writes `lock = false` or `busy = None` outside the post-await code paths.
- The gtest suite cannot reproduce this: gtest messages are sent with plenty of gas and replies land in the same block (docs/audit/test-matrix.md:47). No test sends a gas-starved message to the launchpad.
- docs/audit/threat-model.md A2/A3 treat `busy`/`lock` as protection against interleaving but do not consider a continuation that never completes.

## Recommendation
Make the continuation gas-safe and the lock self-healing:
1. Before the first await, require `exec::gas_available()` to exceed a configured minimum that covers the worst-case continuation plus waitlist rent for `reply_timeout` blocks. Panic before any state change otherwise.
2. Store the lock as `Option<(u32 /*block*/, MessageId)>` and let a later `Graduate`/`Unwind` take over a lock older than `reply_timeout + margin` blocks. The steps are already written to be idempotent and resumable.
3. And/or use `gstd::critical::set_hook` with a system reservation (`exec::system_reserve_gas`) to clear the lock in `handle_signal` when the message traps after an await.
