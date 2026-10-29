---
id: CARGOLINT-001
bug_class: cargo-lint-config
title: Workspace declares no lint policy (no forbid(unsafe_code), no deny(unused_must_use))
location: contracts/launchpad/Cargo.toml:1
function: n/a
confidence: High
worker: worker-12
fp_verdict: TRUE_POSITIVE
fp_rationale: "Verified no [workspace.lints] or crate-level lint attributes in contracts/launchpad/Cargo.toml; hardening gap"
severity: LOW
attack_vector: Remote
exploitability: Theoretical
severity_rationale: "Defense-in-depth: missing lint policy, no direct exploit"
---

## Description
No `[lints]`/`[workspace.lints]` table, no crate-level `#![forbid]`/`#![deny]`, no clippy.toml and no RUSTFLAGS exist anywhere in the workspace. The code has zero `unsafe`, which is the ideal moment to set `forbid(unsafe_code)`. `unused_must_use` is left at warn even though the contract depends on handling results of cross-program calls.

## Code
```toml
# contracts/launchpad/Cargo.toml: [workspace] with no [workspace.lints]
```

## Data flow
- **Source:** build configuration.
- **Sink:** compiler diagnostics.
- **Validation:** none.

## Reachability trace
Build-time only.

## Impact
Hardening gap. Regressions such as newly introduced `unsafe` or ignored `Result`s are not caught by CI. Note that `let _ =` and `bool` returns bypass `unused_must_use` regardless (see the RESDISC findings).

## Mitigations checked
- No existing lint configuration found.

## Recommendation
Add `[workspace.lints.rust] unsafe_code = "forbid"`, `unused_must_use = "deny"`, plus clippy `unwrap_used`/`expect_used`/`arithmetic_side_effects` = "warn". Mark `pay`/`send_value` `#[must_use]`.

(Recreated from worker-12's report after the original output directory was cleared.)
