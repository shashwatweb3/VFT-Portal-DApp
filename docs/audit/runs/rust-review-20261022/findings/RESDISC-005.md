---
id: RESDISC-005
bug_class: result-discarded
title: Spawn-failure refund in launch ignores send_value result
location: contracts/launchpad/launchpad/app/src/service.rs:434
function: launch
confidence: Medium
worker: worker-7
fp_verdict: TRUE_POSITIVE
fp_rationale: "Loss mechanism refuted: orchestrator PoC poc_resdisc_001_sub_ed_refund_is_not_lost shows gear 1.10 does not reject sub-ED sends (charge_message_value checks only value_counter; InsufficientValue is builtin-actor only), and the sub-ED refund was delivered. Residual valid observation is a hardening gap: send result at service.rs:434 is dropped with no pending_payouts fallback if a send ever fails for another reason"
severity: LOW
attack_vector: Remote
exploitability: Theoretical
severity_rationale: "Defense-in-depth: no realistic send-failure path found after PoC refuted the sub-ED premise; residual risk is untracked value if msg send fails for other causes"
---

## Description
If the VFT spawn fails or times out, `launch` rolls back the name/cooldown and refunds with `wire::send_value(creator, value);`, discarding the returned `bool` (the collapsed `msg::send` `Result`). This is after the spawn `.await`, so the runtime will not auto-refund; a failed send (e.g. `0 < value < ED` → `MessageError::InsufficientValue`, possible when `min_trade_vara < ED`) loses the creator's VARA with no recorded liability, while returning `Err(SpawnFailed)`.

## Code
```rust
Err(reason) => {
    self.with_state_mut(|st| {
        st.names.remove(&name_key);
        st.last_launch_by_creator.remove(&creator);
    });
    wire::send_value(creator, value);              // result discarded
    return Err(LaunchpadError::SpawnFailed(reason));
}
```

## Data flow
- **Source:** creator's attached value on `Launch`.
- **Sink:** `wire::send_value` at service.rs:434.
- **Validation:** none on send outcome.

## Reachability trace
`Launch` → `create_program_bytes_with_gas_for_reply` → `up_to(reply_timeout)` → `.await` returns `Err` (init trap / timeout) → `send_value` (ignored).

## Impact
Creator's attached VARA lost on send failure; accounting drift. On a reply timeout the program may also have actually been created, but that is outside this class.

## Mitigations checked
- No `#[must_use]`; no deferral.

## Recommendation
Check the result and fall back to a claimable `pending_payouts`-style credit (keyed per creator) with `st.owe(value)`.
