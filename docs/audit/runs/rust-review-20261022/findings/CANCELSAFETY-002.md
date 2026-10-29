---
id: CANCELSAFETY-002
bug_class: cancel-safety
title: Sell commits curve move and busy=Some(stuck=false) before await; starved continuation wedges launch (reconcile requires stuck=true)
location: contracts/launchpad/launchpad/app/src/service.rs:600
function: sell
confidence: High
worker: worker-11
fp_verdict: TRUE_POSITIVE
fp_rationale: "Verified sell sets busy=Some(stuck=false) and moves curve before await (service.rs:600); resolution only in continuation and reconcile requires stuck=true; same mechanism reproduced for Graduate"
severity: CRITICAL
attack_vector: Remote
exploitability: Reliable
severity_rationale: "Any token holder can permanently brick a trading launch and lock all its escrowed VARA with one gas-starved Sell"
---

## Description
Before awaiting `Vft.TransferFrom`, `sell` applies the curve move (`virtual_vara`, `virtual_tokens`, `real_remaining`, `escrow`, `total_liabilities`) and sets `launch.busy = Some(pending)` with `pending.stuck = false`. The commit (`commit_trade` → `busy = None`), the revert, and `mark_stuck` all live in the continuation. The seller can send the message with only enough gas for the pre-await part and the send. The continuation then runs out of gas, or the message is evicted from the waitlist for lack of rent, and `busy` stays `Some` with `stuck = false` forever. The only recovery path, `reconcile`, explicitly requires `p.stuck` (`_ => panic!("NotStuck")`, line 632), so there is no way out.

## Code
```rust
// service.rs:596-616
launch.virtual_vara -= U256::from(gross);
launch.virtual_tokens += amount;
launch.real_remaining += amount;
launch.escrow -= gross;
launch.busy = Some(pending.clone());   // stuck: false
st.settle(gross);
...
match wire::vft_transfer_from(token, seller, me, amount, &gas).await {   // continuation may never run
    Ok(true) => Ok(self.commit_trade(token, &pending)),
    Ok(false) | Err(..) => { self.with_state_mut(|st| revert_trade(st, token, &pending)); ... }
    Err(CallError::Timeout) => { self.with_state_mut(|st| mark_stuck(st, token)); ... }
}
// reconcile, service.rs:630-633
let pending = match &launch.busy { Some(p) if p.stuck => p.clone(), _ => panic!("NotStuck") };
```

## Data flow
- **Source:** any token holder sends `Sell(token, amount, ..)` with a deliberately small gas limit. The amount can be tiny as long as `split.net > 0`, and tokens can be bought on the curve or the DEX.
- **Sink:** `launch.busy = Some(stuck=false)` persisted at service.rs:600; the code that resolves it is in the continuation and never runs
- **Validation:** no check on remaining gas, and `reconcile` refuses trades that are not marked stuck

## Reachability trace
`Sell` → `with_state_mut` (curve moved, busy set) → `vft_transfer_from(..).await` → waitlist → continuation traps out of gas. After that, `Buy`/`check_buy` → `TradeInProgress`, `Sell` → `TradeInProgress` (line 561), `Graduate` → `TradeInProgress` (line 678), `Unwind` → `GraduationInProgress` (line 793), and `Reconcile` → `NotStuck`.

## Impact
Any holder can permanently brick a trading (or aborted) launch for everyone else: no buys, no sells, no graduation, no unwind. All VARA escrowed for that curve is locked forever and token holders cannot exit. The VFT TransferFrom may also have executed, moving tokens to the launchpad while `escrow` was decremented and `total_liabilities` settled without anyone being paid. That leaves the accounting permanently inconsistent.

## Mitigations checked
- No `gstd::critical` hook, no `exec::system_reserve_gas`, and no `handle_signal` logic that restores state anywhere in `launchpad/app`. Searching for `critical|reserve|handle_signal` finds only comments.
- No admin or timeout-based escape hatch clears `lock` / `busy`. Every admin setter (`set_gas`, `set_addresses`, `set_limits`, …) touches only config. No exported method writes `lock = false` or `busy = None` outside the post-await code paths.
- The gtest suite cannot reproduce this: gtest messages are sent with plenty of gas and replies land in the same block (docs/audit/test-matrix.md:47). No test sends a gas-starved message to the launchpad.
- docs/audit/threat-model.md A2/A3 treat `busy`/`lock` as protection against interleaving but do not consider a continuation that never completes.

## Recommendation
Require a minimum `exec::gas_available()` before changing state, and make `busy` recoverable. Record the block at which the trade was opened and let `reconcile` treat any `busy` trade older than `reply_timeout + margin` as stuck; its balance-based resolution already handles that case. Alternatively, register a `gstd::critical` hook with a system reservation that sets `stuck = true` on trap.
