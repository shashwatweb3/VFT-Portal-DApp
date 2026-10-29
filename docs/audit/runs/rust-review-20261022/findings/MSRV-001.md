---
id: MSRV-001
bug_class: msrv-mismatch
title: No rust-version declared; toolchain pinned only via rust-toolchain.toml
location: contracts/launchpad/Cargo.toml:5
function: n/a
confidence: Medium
worker: worker-12
fp_verdict: TRUE_POSITIVE
fp_rationale: "Verified [workspace.package] has no rust-version; toolchain pinned only via rust-toolchain.toml; hardening/reproducibility gap"
severity: LOW
attack_vector: Remote
exploitability: Theoretical
severity_rationale: "Defense-in-depth: build reproducibility, no direct exploit"
---

## Description
No workspace member declares `rust-version`. The compiler is pinned only by rust-toolchain.toml (1.91.0), which Cargo does not enforce for downstream builds. Builds with other toolchains are known to fail to link (1.99).

## Code
```toml
[workspace.package]  # no rust-version
```

## Data flow
- **Source:** build configuration.
- **Sink:** toolchain selection.
- **Validation:** rust-toolchain.toml only.

## Reachability trace
Build-time only.

## Impact
Reproducibility. An auditor or deployer building with a different rustc can produce a different wasm from the one audited.

## Mitigations checked
- rust-toolchain.toml pins 1.91.0.

## Recommendation
Set `rust-version = "1.91"` in `[workspace.package]`. Publish wasm hashes with a reproducible build (the gear-wasm-builder Docker image) for the deployed code IDs.

(Recreated from worker-12's report after the original output directory was cleared.)
