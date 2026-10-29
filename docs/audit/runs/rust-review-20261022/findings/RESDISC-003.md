---
id: RESDISC-003
bug_class: result-discarded
title: Reconcile revert refund ignores send result after liability is settled
location: contracts/launchpad/launchpad/app/src/service.rs:656
function: reconcile
confidence: Medium
worker: worker-7
fp_verdict: TRUE_POSITIVE
fp_rationale: "Loss mechanism refuted: orchestrator PoC poc_resdisc_001_sub_ed_refund_is_not_lost shows gear 1.10 does not reject sub-ED sends (charge_message_value checks only value_counter; InsufficientValue is builtin-actor only), and the sub-ED refund was delivered. Residual valid observation is a hardening gap: send result at service.rs:656 is dropped with no pending_payouts fallback if a send ever fails for another reason"
severity: LOW
attack_vector: Remote
exploitability: Theoretical
severity_rationale: "Defense-in-depth: no realistic send-failure path found after PoC refuted the sub-ED premise; residual risk is untracked value if msg send fails for other causes"
---

## Description
When `reconcile` determines a stuck buy did not land, it calls `revert_trade` (which settles the escrow liability) and then `pay(pending.trader, pending.vara_gross);`, dropping the boolean result of the underlying `msg::send_bytes_with_gas`. `reconcile` is permissionless and runs after an `.await`, so a failed send (e.g. `vara_gross` below ED → `MessageError::InsufficientValue`) leaves the buyer unpaid with no recorded debt, and the function still returns `Ok(false)` / emits `Reconciled { committed: false }` as if refunded.

## Code
```rust
} else if held == reverted_expected {
    self.with_state_mut(|st| revert_trade(st, token, &pending));
    if pending.side == Side::Buy {
        pay(pending.trader, pending.vara_gross);   // result discarded
    }
    self.emit_event(Event::Reconciled { token, seq: pending.seq, committed: false })
```

## Data flow
- **Source:** original buyer's attached value recorded in `PendingTrade.vara_gross`.
- **Sink:** `pay(...)` at service.rs:656.
- **Validation:** none on send outcome.

## Reachability trace
`Buy` → `run_buy` → transfer reply `Timeout` → `mark_stuck`; any caller → `Reconcile` (service.rs:622) → `vft_balance_of(...).await` → `revert_trade` → `pay` (ignored).

## Impact
Buyer's VARA lost and untracked on any refund send failure; misleading success event.

## Mitigations checked
- No `#[must_use]`, no deferral to `pending_payouts`.

## Recommendation
On failure, credit `pending_payouts[(token, trader)]` and `st.owe(vara_gross)` so the buyer can `ClaimPayout` later.
