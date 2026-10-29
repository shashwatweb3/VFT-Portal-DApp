---
id: RESDISC-002
bug_class: result-discarded
title: Refund after failed VFT transfer ignores send result; buyer's gross is lost on send failure
location: contracts/launchpad/launchpad/app/src/service.rs:1085
function: run_buy
confidence: Medium
worker: worker-7
fp_verdict: TRUE_POSITIVE
fp_rationale: "Loss mechanism refuted: orchestrator PoC poc_resdisc_001_sub_ed_refund_is_not_lost shows gear 1.10 does not reject sub-ED sends (charge_message_value checks only value_counter; InsufficientValue is builtin-actor only), and the sub-ED refund was delivered. Residual valid observation is a hardening gap: send result at service.rs:1085 is dropped with no pending_payouts fallback if a send ever fails for another reason"
severity: LOW
attack_vector: Remote
exploitability: Theoretical
severity_rationale: "Defense-in-depth: no realistic send-failure path found after PoC refuted the sub-ED premise; residual risk is untracked value if msg send fails for other causes"
---

## Description
After the awaited `Vft.Transfer` fails (`Ok(false)`, `Send`, `Reply`, `Decode`), `run_buy` reverts the curve, settles the escrow liability (`revert_trade` → `st.settle`) and then refunds with `pay(buyer, pending.vara_gross);`, discarding the `bool` derived from the send `Result`. This runs after an `.await`, so attached value is no longer auto-refunded by a trap; if the send fails the liability has already been removed and the buyer's VARA is permanently absorbed into the untracked reserve.

The send fails deterministically whenever `vara_gross` is non-zero and below the existential deposit (Gear `MessageError::InsufficientValue`). `vara_gross >= min_trade_vara`, but `set_limits` places no lower bound on `min_trade_vara` relative to ED, so this is reachable under any config where `min_trade_vara < ED`; other send failures are equally swallowed.

## Code
```rust
Ok(false) | Err(CallError::Send) | Err(CallError::Reply) | Err(CallError::Decode) => {
    self.with_state_mut(|st| revert_trade(st, token, &pending)); // liability settled
    pay(buyer, pending.vara_gross);                               // result discarded
    Err(LaunchpadError::TransferFailed)
}
```

## Data flow
- **Source:** buyer's attached value (`msg::value()` in `buy`/`launch`).
- **Sink:** `pay(buyer, pending.vara_gross)` at service.rs:1085.
- **Validation:** none on the send outcome; `min_trade_vara` not constrained to `>= existential_deposit()` in `set_limits` (service.rs:1029-1042).

## Reachability trace
`Buy` → `run_buy` → `wire::vft_transfer(...).await` returns error → `revert_trade` → `pay(...)` (ignored).

## Impact
Loss of the buyer's full trade amount on refund failure, plus accounting drift (value held but not owed). Handler returns `Err(TransferFailed)`, implying a refund that did not happen.

## Mitigations checked
- No `#[must_use]`; no fallback to `pending_payouts`.
- Post-await, so Gear's trap-before-await auto-refund does not apply.

## Recommendation
On `!pay(...)`, book the amount into `pending_payouts` and `st.owe(amount)` instead of dropping it; enforce `min_trade_vara >= existential_deposit()` in `set_limits`.
