---
id: RESDISC-001
bug_class: result-discarded
title: Sell-out excess refund send result discarded; sub-ED refund silently lost and left untracked
location: contracts/launchpad/launchpad/app/src/service.rs:1079
function: run_buy
confidence: High
worker: worker-7
fp_verdict: TRUE_POSITIVE
fp_rationale: "Loss mechanism refuted: orchestrator PoC poc_resdisc_001_sub_ed_refund_is_not_lost shows gear 1.10 does not reject sub-ED sends (charge_message_value checks only value_counter; InsufficientValue is builtin-actor only), and the sub-ED refund was delivered. Residual valid observation is a hardening gap: send result at service.rs:1079 is dropped with no pending_payouts fallback if a send ever fails for another reason"
severity: LOW
attack_vector: Remote
exploitability: Theoretical
severity_rationale: "Defense-in-depth: no realistic send-failure path found after PoC refuted the sub-ED premise; residual risk is untracked value if msg send fails for other causes"
---

## Description
`pay()` wraps `wire::send_value`, which collapses the `Result` of `msg::send_bytes_with_gas` into a `bool` (`.is_ok()`). In `run_buy`, the excess refund for a curve-completing buy is paid with `pay(buyer, refund);` and the returned `bool` is dropped. When the send fails the refund is neither retried nor booked into `pending_payouts`/`total_liabilities`: the native value stays in the program as untracked "free" balance and the buyer loses it.

The failure is reachable deterministically: Gear rejects any message whose value is non-zero but below the existential deposit (`MessageError::InsufficientValue = 307`, "In case of non-zero message value must be greater than existential deposit", gear-core-errors 1.10.0). `refund = gross - gross_used` is fully controlled by how much the final buyer over-pays, so any refund in `1..ED` is guaranteed to fail. The code already knows about this rule (it defers sub-ED seller payouts in `pay_seller` and rejects sub-ED claims with `BelowExistentialDeposit`), but the buy-side refund path ignores it.

## Code
```rust
let pending = self.with_state_mut(|st| apply_buy(st, token, buyer, &plan));
if refund > 0 {
    // Excess over the sell-out cost goes straight back before the await.
    pay(buyer, refund);          // bool (= send Result.is_ok()) discarded
}
match wire::vft_transfer(token, buyer, pending.tokens, &gas).await {
```
```rust
// wire.rs
pub fn send_value(to: ActorId, value: u128) -> bool {
    if value == 0 { return true; }
    msg::send_bytes_with_gas(to, [], 0, value).is_ok()
}
```

## Data flow
- **Source:** attached value `msg::value()` of the curve-completing `Buy` (or the first buy in `Launch`), attacker/user-controlled.
- **Sink:** `pay(buyer, refund)` at service.rs:1079 whose failure result is dropped.
- **Validation:** none — no `refund >= existential_deposit()` check, no fallback into `pending_payouts`.

## Reachability trace
`Buy` (service.rs:525) → `check_buy` → `plan_buy` (sell-out branch, `refund = gross - gross_used`) → `run_buy` → `pay(buyer, refund)` (result ignored).

## Impact
The buyer who completes the curve loses any refund below ED (up to ED-1 planck; on Vara ED is a non-trivial VARA amount). The lost value is not accounted as a liability, so it silently inflates the program's "free" reserve, breaking the accounting invariant `balance == liabilities + reserve` that the docs rely on. Any other send failure (e.g., runtime rejection) also loses the whole refund.

## Mitigations checked
- No `#[must_use]` on `pay`/`send_value`; rustc does not warn on a dropped `bool`.
- `pay_seller` handles the same failure correctly by deferring into `pending_payouts`; `run_buy` does not.
- Not covered by a gtest with sub-ED refund (tests buy with round amounts).

## Recommendation
Check the result: on failure (or when `refund < existential_deposit()`), credit `pending_payouts[(token, buyer)] += refund` and `st.owe(refund)`, exactly like `pay_seller`. Mark `pay`/`send_value` `#[must_use]`.
