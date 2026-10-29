---
stage: dedup-judge
total_findings_in: 19
working_set_size: 19
unparseable_locations: 0
multi_locations: 0
tier1_merges: 0
tier2_merges: 0
tier3_merges: 0
primaries_after_dedup: 19
related_groups: 3
---

# Dedup Summary

Threat model: REMOTE (scope contracts/launchpad; Vara/Gear Sails launchpad + VFT). No finding carried `merged_into` or `also_known_as` from a prior pass.

## Location parse health
| Class | Count | Example IDs |
|-------|-------|-------------|
| parseable (`path:line`) | 19 | ARITHOFL-001, CANCELSAFETY-001, RESDISC-001, ... |
| markdown-link (recovered) | 0 | — |
| multi-location (skipped Tier 1) | 0 | — |
| unparseable (skipped Tier 1) | 0 | — |

Path-string drift note: CANCELSAFETY-001..007 (worker-11) use `launchpad/app/src/service.rs` (relative to scope root), while all other service.rs findings use `contracts/launchpad/launchpad/app/src/service.rs`. Per protocol, paths are not absolutized, so these are distinct bucket keys. For safety, the cross-worker candidate pairs were nonetheless reviewed as if they shared a file (see Tier 3 notes) — none qualify for merging either way.

No-function findings (excluded from Tiers 2–3): CARGOLINT-001, MSRV-001 (`function: n/a`).

## Tier 1 — exact-location same-class merges (deterministic)
None. No two findings share `(path, line, bug_class)`. CARGOLINT-001 (`Cargo.toml:1`, cargo-lint-config) and MSRV-001 (`Cargo.toml:5`, msrv-mismatch) differ in both line and class and remain separate.

## Tier 2 — same construct in same function (snippet-confirmed)
None.

Candidate reviewed and rejected:
| IDs | Function | Reason not merged |
|-----|----------|-------------------|
| RESDISC-001, RESDISC-002 | run_buy | Different `pay(...)` calls: pre-await sell-out excess refund `pay(buyer, refund)` at 1079 vs post-transfer-failure refund `pay(buyer, pending.vara_gross)` at 1085; 6 lines apart, distinct constructs |

## Tier 3 — cross-class same-bug merges (LLM-confirmed)
None.

Candidates reviewed (treating both service.rs path spellings as the same file) and rejected:
| IDs | Function | Reason not merged |
|-----|----------|-------------------|
| ARITHOFL-001, CANCELSAFETY-006 | step_align_price | Different constructs: `k / rw_target` divide-by-zero (1254) vs swap-timeout leaving stale `wvara_budget`/`token_budget` (1250 / 1286) |
| ARITHOFL-002, CANCELSAFETY-005 | unwind | u32 `ready_at + timeout` overflow (788) vs `lock = true` held across `unwind_wrapped().await` (796) |
| ASSERTREACH-001, CANCELSAFETY-007, RESDISC-004, RESDISC-005, RESEXHAUST-001 | launch | Five distinct constructs: post-await `curve_params_for` panic (439); name/cooldown reserved before spawn await (385); discarded `pay(creator, value)` (514); discarded `send_value` on spawn failure (434); unbounded `launch_order.push` (484) |
| CANCELSAFETY-003, RESDISC-001, RESDISC-002 | run_buy | `apply_buy` busy set across `vft_transfer().await` (1076) vs discarded refund results (1079, 1085) |
| CANCELSAFETY-004, RESDISC-003 | reconcile | `lock = true` across `vft_balance_of().await` (634) vs discarded revert refund `pay` (656) |

## Tier 4 — Related (NOT merged — cross-reference only)
| Pattern | Finding IDs | Shared fix location |
|---------|-------------|---------------------|
| State (lock/busy/name/budgets) committed before an await with resolution only in a continuation that can be gas-starved or time out; no self-healing / gas floor / critical hook | CANCELSAFETY-001, CANCELSAFETY-002, CANCELSAFETY-003, CANCELSAFETY-004, CANCELSAFETY-005, CANCELSAFETY-006, CANCELSAFETY-007 | launchpad/app/src/service.rs (graduate, sell, run_buy, reconcile, unwind, step_align_price, launch) |
| `pay`/`send_value` bool result discarded on refund paths; sub-ED or failed sends lose VARA untracked (no `pending_payouts` fallback, no `#[must_use]`) | RESDISC-001, RESDISC-002, RESDISC-003, RESDISC-004, RESDISC-005 | contracts/launchpad/launchpad/app/src/service.rs (`pay` / `wire::send_value`) |
| Panicking arithmetic in post-await / escape-hatch paths | ARITHOFL-001, ARITHOFL-002 | contracts/launchpad/launchpad/app/src/service.rs |

Cross-class cross-references worth noting: ASSERTREACH-001 and CANCELSAFETY-007 both concern `launch` post-spawn-await state stranding (different triggers); ARITHOFL-001 compounds CANCELSAFETY-001 (both leave `lock = true` permanently after a post-await trap in graduation); CARGOLINT-001 references the RESDISC family (`#[must_use]` on `pay`).

## Bug-class counts (primaries only, after dedup)
| Bug class | Count |
|-----------|-------|
| cancel-safety | 7 |
| result-discarded | 5 |
| arithmetic-overflow | 2 |
| assertion-reachable | 1 |
| resource-exhaustion | 1 |
| string-comparison | 1 |
| cargo-lint-config | 1 |
| msrv-mismatch | 1 |
