# fp-check: batch 4 (Gear-specific review findings), verdict summary

Details and code references live in gear-review.md. This file records the verification outcome only.

| ID | Verdict | Severity | Evidence |
|---|---|---|---|
| C-1 | TRUE POSITIVE | Critical | gstd-codegen 1.10.0 lib.rs:393-411 queues the send before the reply deposit, and wire.rs maps a later failure to "not sent". Reproduced by audit_poc.rs::poc_gear_c1 |
| C-2 | TRUE POSITIVE | Critical | Same as ARITHOFL-001 (batch 2), reproduced |
| C-3 | TRUE POSITIVE | Critical | Same as the CANCELSAFETY family (batches 2-3); CANCELSAFETY-001 reproduced |
| H-1 | TRUE POSITIVE | High | service.rs:789 `failed_early` has no delay, and step failures are recorded as Failed (:756-764). Code-traced |
| M-1 | TRUE POSITIVE | Medium | `pre_add_reserves` is not cleared on non-timeout failures (:1314-1319); the resume heuristic is at :1294-1300. Code-traced |
| M-2 | TRUE POSITIVE | Medium | Reconcile requires exact equality (:641-663). Confirmed independently by the audit-context dossier |
| M-3 | TRUE POSITIVE | Medium | Zero-gas value sends (wire.rs:286-291) to program recipients. Matters for a program treasury or multisig |
| M-4 | TRUE POSITIVE | Medium (trust model) | Gas config and timeout are read live by in-flight launches with no bounds |
| L-1 | TRUE POSITIVE | Low/Medium | The per-launch busy lock serialises trades. Throughput and UX limit for popular launches |
| L-2 | TRUE POSITIVE | Low | Global `wvara_expected` attribution in Settle |
| L-3 | UNVERIFIED | Low | Sandwich within the 2-3 % tolerances; needs an economic test |
| I-1..I-5 | Informational | Info | I-4 duplicates STRCMP-001 |

All gate reviews for the true positives pass on process, reachability, impact, math and environment. For H-1, M-1 and M-4 the PoC gate rests on code tracing rather than execution. Executable regression tests will be added alongside the fixes.

---

## Per-phase records

**Format:**
- P1 = data flow (trust boundary, API contract, environment, cross-reference)
- P2 = exploitability
- P3 = impact
- P4 = PoC
- P5 = devil's advocate (13 questions; the key ones are noted)
- Gates = 1 Process, 2 Reachability, 3 Impact, 4 PoC, 5 Math, 6 Environment

Kept at the level of conditions and remediation by design.

### C-1
- **P1:**
  - Untrusted caller-chosen gas.
  - The gstd contract queues the send before the deposit (codegen lib.rs:393-411).
  - No runtime protection.
  - The same mapping is used at four call sites.
- **P2:** caller-controlled; a gas window exists (empirical).
- **P3:** loss of escrow value, which is primary custody.
- **P4:** executed PoC `poc_gear_c1` (fails while the bug exists). Negative PoC: buys with normal gas behave correctly (trade.rs).
- **P5:**
  - Q1-Q3: no legitimate rationale; the wrapper conflated two error classes.
  - Q7: window observed.
  - Q10: Gear's commit-on-success causes it.
  - Q13: re-read wire.rs:72-87.
- **Gates:** all PASS.
- **Verdict: TRUE POSITIVE, Critical.**

### H-1
- **P1:**
  - Caller-chosen gas makes a step's outgoing call fail as `Send`, which is recorded as `Failed` (:756-764).
  - `failed_early` unwind has no delay (:789).
- **P2:** permissionless and cheap; no math bound involved.
- **P3:** the listing is permanently aborted. No theft; availability and integrity of the product promise are lost.
- **P4:** pseudocode/condition-level only. Executable PoC skipped for now: it shares the gas-window mechanism already executed in C-1 and CANCELSAFETY-001. A regression test is added with the unwind-delay fix.
- **P5:**
  - Q2: an immediate unwind was intended for genuinely early failures.
  - Q9: primary control.
  - Q13: re-read :756-764 and :785-811.
- **Gates:** 1, 2, 3, 5, 6 PASS; 4 PASS (mechanism executed elsewhere; justified skip).
- **Verdict: TRUE POSITIVE, High.**

### M-1
- **P1:**
  - The reserve snapshot is written before the AddLiquidity send and is not cleared on definitive failure (:1314-1319).
  - The resume heuristic trusts reserve growth (:1294-1300).
  - The pair is externally writable.
- **P2:** requires a failed AddLiquidity, plus third-party liquidity of comparable size before the retry.
- **P3:** pool liquidity is not owned or locked by the protocol, and accounting misreports.
- **P4:** condition-level. Executable PoC deferred to the fix's regression test, because it needs a multi-actor sequence across the retry.
- **P5:** Q8: practical but capital-intensive. Q13: re-read.
- **Gates:** PASS (gate 4 by justified deferral).
- **Verdict: TRUE POSITIVE, Medium.**

### M-2
- **P1:** exact-equality balance checks in reconcile (:641-663). The VFT balance is externally writable via transfers.
- **P