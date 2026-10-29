---
stage: fp-judge
threat_model: REMOTE
primaries_evaluated: 19
true_positives: 14
likely_tp: 5
likely_fp: 0
false_positives: 0
out_of_scope: 0
---

# FP-Judge Summary

Dedup ran (19 in, 19 primaries, 0 merges). No primary carries `also_known_as`.

## Verdict counts (primaries)
| Verdict | Count |
|---------|-------|
| TRUE_POSITIVE | 14 |
| LIKELY_TP | 5 |
| LIKELY_FP | 0 |
| FALSE_POSITIVE | 0 |
| OUT_OF_SCOPE | 0 |

## Severity counts (survivors)
| Severity | Count |
|----------|-------|
| CRITICAL | 4 |
| HIGH | 2 |
| MEDIUM | 2 |
| LOW | 11 |

## Per-primary verdicts
| ID | Bug class | Verdict | Severity | Rationale |
|----|-----------|---------|----------|-----------|
| ARITHOFL-001 | arithmetic-overflow | TRUE_POSITIVE | CRITICAL | Reproduced by gtest PoC: a dust-seeded pair makes rw_target=0, so k/rw_target panics after the await and lock stays true forever |
| CANCELSAFETY-001 | cancel-safety | TRUE_POSITIVE | CRITICAL | Reproduced by gtest PoC: a gas-starved Graduate leaves lock=true (service.rs:702/726) and the launch is frozen |
| CANCELSAFETY-002 | cancel-safety | TRUE_POSITIVE | CRITICAL | Sell sets busy=Some(stuck=false) before the await; reconcile requires stuck=true, so a starved continuation wedges the launch |
| CANCELSAFETY-003 | cancel-safety | TRUE_POSITIVE | CRITICAL | run_buy/apply_buy busy set before the transfer await; same mechanism as the reproduced CANCELSAFETY-001 |
| CANCELSAFETY-004 | cancel-safety | TRUE_POSITIVE | HIGH | Reconcile lock held across the balance query; needs a stuck trade to exist first |
| CANCELSAFETY-005 | cancel-safety | TRUE_POSITIVE | HIGH | Unwind lock held across unwind_wrapped; a starved continuation blocks unwind and graduate |
| CANCELSAFETY-006 | cancel-safety | LIKELY_TP | MEDIUM | A swap timeout leaves stale budgets; AddLiquidity is not unwindable; needs a reply timeout |
| RESEXHAUST-001 | resource-exhaustion | LIKELY_TP | MEDIUM | Append-only state and an unpaginated launches() query; costly sybil growth |
| ARITHOFL-002 | arithmetic-overflow | LIKELY_TP | LOW | Unchecked u32 add in unwind; needs a pathological admin timeout |
| ASSERTREACH-001 | assertion-reachable | LIKELY_TP | LOW | Post-await curve_params_for panic; needs inconsistent admin config |
| CANCELSAFETY-007 | cancel-safety | LIKELY_TP | LOW | Gas-starved Launch mostly harms the caller; orphaned VFT and name squat |
| RESDISC-001 | result-discarded | TRUE_POSITIVE | LOW | Hardening gap: pay result dropped at 1079. The sub-ED loss premise was refuted by the orchestrator PoC (gear 1.10 delivers sub-ED sends) |
| RESDISC-002 | result-discarded | TRUE_POSITIVE | LOW | Hardening gap: pay result dropped at 1085. The sub-ED loss premise was refuted by the orchestrator PoC (gear 1.10 delivers sub-ED sends) |
| RESDISC-003 | result-discarded | TRUE_POSITIVE | LOW | Hardening gap: pay result dropped at 656. The sub-ED loss premise was refuted by the orchestrator PoC (gear 1.10 delivers sub-ED sends) |
| RESDISC-004 | result-discarded | TRUE_POSITIVE | LOW | Hardening gap: pay result dropped at 514. The sub-ED loss premise was refuted by the orchestrator PoC (gear 1.10 delivers sub-ED sends) |
| RESDISC-005 | result-discarded | TRUE_POSITIVE | LOW | Hardening gap: send_value result dropped at 434. The sub-ED loss premise was refuted by the orchestrator PoC (gear 1.10 delivers sub-ED sends) |
| STRCMP-001 | string-comparison | TRUE_POSITIVE | LOW | name_taken canonicalisation differs from launch; affects the query only |
| CARGOLINT-001 | cargo-lint-config | TRUE_POSITIVE | LOW | Hardening gap: no lint policy |
| MSRV-001 | msrv-mismatch | TRUE_POSITIVE | LOW | Hardening gap: no rust-version |

## Common FP patterns observed
- None. Every primary's premise matched the code. Findings that depend on admin config (ARITHOFL-002, ASSERTREACH-001) were kept as LIKELY_TP/LOW instead of OUT_OF_SCOPE, because the config is on-chain admin state, not local attacker access.

- Disproved premise: RESDISC-001..005 all assumed that Gear rejects sends with 0 < value < ED. Orchestrator evidence (core-processor-1.10.0 ext.rs charge_message_value; passing PoC poc_resdisc_001_sub_ed_refund_is_not_lost) shows the send is not rejected and the refund arrives. The value-loss impact is refuted. Each finding is kept only as a TRUE_POSITIVE/LOW/Theoretical hardening gap: the bool result is discarded and there is no pending_payouts fallback. The finding bodies and titles still describe the refuted mechanism.

## Areas that need deeper analysis
- Fix the systemic cancel-safety problem (CANCELSAFETY-001..007) with one design: a gas floor before any pre-await state change, lock and busy flags stamped with a block height and able to expire, and/or a gstd critical hook with a system reservation. The orchestrator reproduced CANCELSAFETY-001.
- CANCELSAFETY-006: check whether AddLiquidity sized from a stale wvara_budget can use wVARA that belongs to other launches. wvara_expected is pooled across launches, so the stuck-graduation finding may also allow cross-launch fund misuse.
- ARITHOFL-001 compounds CANCELSAFETY-001: any panic after an await in a graduation step leaves the lock permanently held. Audit every post-await computation for panics.
