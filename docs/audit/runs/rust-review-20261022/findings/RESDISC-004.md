---
id: RESDISC-004
bug_class: result-discarded
title: First-buy-skipped refund in launch ignores send result after spawn await
location: contracts/launchpad/launchpad/app/src/service.rs:514
function: launch
confidence: Medium
worker: worker-7
fp_verdict: TRUE_POSITIVE
fp_rationale: "Loss mechanism refuted: orchestrator PoC poc_resdisc_001_sub_ed_refund_is_not_lost shows gear 1.10 does not reject sub-ED sends (charge_message_value checks only value_counter; InsufficientValue is builtin-actor only), and the sub-ED refund was delivered. Residual valid observation is a hardening gap: send result at service.rs:514 is dropped with no pending_payouts fallback if a send ever fails for another reason"
severity: LOW
attack_vector: Remote
exploitability: Theoretical
severity_rationale: "Defense-in-depth: no realistic send-failure path found after PoC refuted the sub-ED premise; residual risk is untracked value if msg send fails for other causes"
---

## Description
In `launch`, after the VFT spawn `.await`, a first buy that fails `check_buy` is refunded with `pay(creator, value);` and the `bool` (from the send `Result`) is discarded. Because this is post-await, Gear no longer refunds attached value on trap, so a failed send strands the creator's VARA in the program as untracked balance while the call returns `Err(FirstBuySkipped)` implying a refund. Interleaving messages between the spawn and resumption (e.g. admin `set_paused_buys`, `set_limits` raising `min_trade_vara`) are exactly what drive this branch; the send fails deterministically if `value` is non-zero and below ED (`MessageError::InsufficientValue`), which the pre-await check (`value < min_trade_vara`) does not exclude when `min_trade_vara < ED`.

## Code
```rust
match self.with_state(|st| check_buy(st, &token, value, first_buy_min_tokens_out)) {
    Ok(plan) => { let _ = self.run_buy(token, creator, plan).await; }
    Err(reason) => {
        pay(creator, value);                       // result discarded
        return Err(LaunchpadError::FirstBuySkipped(String::from(reason)));
    }
}
```

## Data flow
- **Source:** creator's attached value on `Launch`.
- **Sink:** `pay(creator, value)` at service.rs:514.
- **Validation:** none on send outcome.

## Reachability trace
`Launch` → `create_program_bytes_with_gas_for_reply(...).await` → `check_buy` returns `Err` → `pay` (ignored).

## Impact
Creator's first-buy VARA lost on send failure; accounting drift.

## Mitigations checked
- No `#[must_use]`; no fallback booking. (Note also `let _ = self.run_buy(...)` at line 511 discards the first-buy `Result`, so a `TransferFailed`/`TradeStuck` first buy is reported as plain `Ok(token)`; documented by the adjacent comment, events still emitted.)

## Recommendation
On `!pay(...)`, record a `pending_payouts` entry and `st.owe(value)`; consider surfacing the first-buy outcome in the return value instead of `let _ =`.
