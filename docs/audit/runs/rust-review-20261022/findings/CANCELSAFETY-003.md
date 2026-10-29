---
id: CANCELSAFETY-003
bug_class: cancel-safety
title: run_buy commits curve move and busy before VFT transfer await; gas-starved buy wedges launch permanently
location: contracts/launchpad/launchpad/app/src/service.rs:1076
function: run_buy
confidence: High
worker: worker-11
fp_verdict: TRUE_POSITIVE
fp_rationale: "Verified apply_buy sets busy=Some(stuck=false) before vft_transfer await in run_buy (service.rs:1076); reconcile rejects non-stuck trades; same gas-starvation mechanism as reproduced CANCELSAFETY-001"
severity: CRITICAL
attack_vector: Remote
exploitability: Reliable
severity_rationale: "For one min_trade_vara buy any account permanently bricks a trading launch and its escrow"
---

## Description
`run_buy` is reached from `buy` and from `launch`'s first buy. It calls `apply_buy`, which moves the curve, increases `escrow` and `total_liabilities`, and sets `launch.busy = Some(pending)` with `stuck = false`. It may also refund the sell-out excess via `pay` right away. Then it awaits `Vft.Transfer`, and all resolution (`commit_trade`, `revert_trade`, `mark_stuck`) is in the continuation. A buyer can attach `min_trade_vara` with a gas limit that leaves too little for the continuation or for waitlist rent. The continuation then traps or is evicted, `busy` stays `Some(stuck=false)` forever, and `reconcile` refuses it (`NotStuck`).

## Code
```rust
// service.rs:1074-1093
let pending = self.with_state_mut(|st| apply_buy(st, token, buyer, &plan));   // busy = Some(stuck=false)
if refund > 0 { pay(buyer, refund); }
match wire::vft_transfer(token, buyer, pending.tokens, &gas).await {          // continuation may never run
    Ok(true) => Ok(self.commit_trade(token, &pending)),
    ... => { revert_trade(..); pay(buyer, pending.vara_gross); ... }
    Err(CallError::Timeout) => { mark_stuck(st, token); ... }
}
```

## Data flow
- **Source:** `Buy(token, min_tokens_out, deadline)` from any account with `min_trade_vara` attached and a low gas limit
- **Sink:** `launch.busy` persisted by `apply_buy` (service.rs:179); resolution sits in the continuation of service.rs:1081
- **Validation:** no check on remaining gas

## Reachability trace
`Buy` → `check_buy` → `run_buy` → `apply_buy` (busy set) → `vft_transfer(..).await` → continuation runs out of gas. After that, every `Buy`/`Sell`/`Graduate`/`Unwind` is rejected with `TradeInProgress`/`GraduationInProgress`, and `Reconcile` panics with `NotStuck`.

## Impact
For the price of one minimum trade, an attacker permanently blocks a whole launch and locks its funds. The attacker may even receive the tokens if the Transfer executed. If the attacking buy is the one that sells out the curve, the excess refund has already been paid but the launch never reaches `Ready`, so the full raise is stranded. Escrow and liabilities stay inconsistent forever.

## Mitigations checked
- No `gstd::critical` hook, no `exec::system_reserve_gas`, and no `handle_signal` logic that restores state anywhere in `launchpad/app`. Searching for `critical|reserve|handle_signal` finds only comments.
- No admin or timeout-based escape hatch clears `lock` / `busy`. Every admin setter (`set_gas`, `set_addresses`, `set_limits`, …) touches only config. No exported method writes `lock = false` or `busy = None` outside the post-await code paths.
- The gtest suite cannot reproduce this: gtest messages are sent with plenty of gas and replies land in the same block (docs/audit/test-matrix.md:47). No test sends a gas-starved message to the launchpad.
- docs/audit/threat-model.md A2/A3 treat `busy`/`lock` as protection against interleaving but do not consider a continuation that never completes.

## Recommendation
Same as CANCELSAFETY-002: require a minimum `exec::gas_available()` before `apply_buy`, and let `reconcile` take over any `busy` trade older than `reply_timeout + margin` blocks (or set `stuck` from a `gstd::critical` hook on trap).
