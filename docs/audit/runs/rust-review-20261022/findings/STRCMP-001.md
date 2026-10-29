---
id: STRCMP-001
bug_class: string-comparison
title: name_taken query canonicalises names differently from launch's uniqueness key
location: contracts/launchpad/launchpad/app/src/service.rs:978
function: name_taken
confidence: High
worker: worker-9
fp_verdict: TRUE_POSITIVE
fp_rationale: "Verified name_taken uses trim().to_lowercase() while launch collapses inner whitespace with to_ascii_lowercase; query-only mismatch, launch remains authoritative"
severity: LOW
attack_vector: Remote
exploitability: Reliable
severity_rationale: "Advisory query returns wrong answer; no fund or state impact"
---

## Description
`name_taken` checks `st.names.contains(&name.trim().to_lowercase())`, while `launch` builds the stored key with `split_ascii_whitespace().collect::<Vec<_>>().join(" ").to_ascii_lowercase()` (service.rs:326-331). A name with repeated inner spaces ("Moon  Frog") is reported free by the query but rejected by `launch` with `NameTaken`.

## Code
```rust
pub fn name_taken(&self, name: String) -> bool {
    self.with_state(|st| st.names.contains(&name.trim().to_lowercase()))
}
```

## Data flow
- **Source:** query argument from any caller.
- **Sink:** read-only `HashSet::contains`.
- **Validation:** `launch` independently re-canonicalises and enforces uniqueness before its first await (service.rs:351).

## Reachability trace
Any caller → `Launchpad::NameTaken(name)` → `name_taken`.

## Impact
Advisory query only. On-chain uniqueness holds. A rejected `launch` traps before its first await, so its attached value is refunded. UX inconsistency.

## Mitigations checked
- `launch` is authoritative.
- Non-printable/Unicode names are rejected by the `printable` check (service.rs:322).

## Recommendation
Factor one `fn name_key(&str) -> String` and use it in both `launch` and `name_taken`.

(Recreated from worker-9's report after the original output directory was cleared.)
