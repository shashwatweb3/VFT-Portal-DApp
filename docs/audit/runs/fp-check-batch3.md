# fp-check: batch 3 (all remaining findings)

**Inputs:**
- rust-review findings in docs/audit/runs/rust-review-20261022/findings, after dedup (no merges) and fp-judge annotation;
- the audit-context dossier (contracts/launchpad/launchpad/audit-context/DOSSIER.md);
- the executable PoCs in contracts/launchpad/launchpad/tests/audit_poc.rs.

Bugs already fully verified in batch 2: ARITHOFL-001 (TP), CANCELSAFETY-001 (TP), RESDISC-001 (FP as described).

**Shared Phase 1.3 environment facts:**
- Gear wasm32 with `overflow-checks = true`.
- Per-program sequential execution; interleaving only at `.await`.
- State committed before an await persists if the continuation traps or starves.
- Attached value is auto-refunded only on a trap before the first await.
- gear 1.10 sends do not reject value below the existential deposit (core-processor ext.rs:421).
- Wasm memory is capped by the runtime's max pages.

**Shared 13-question devil's-advocate key, answered per bug below:**
1. Non-vulnerability explanation
2. Developer justification
3. Missing architecture context
4. "Looks dangerous" bias
5. Validation actually prevents it?
6. Trusted-data confusion
7. Math proven?
8. Practically exploitable?
9. Defense-in-depth confusion
10. Runtime protections
11. Hallucination check
12. Dismissing complex exploit?
13. Invented mitigations (re-read code)

---

## CANCELSAFETY-002: `sell` sets `busy` before the VFT TransferFrom await (service.rs:600)

**Phase 1: Data flow**
- **1.1** The seller is untrusted and chooses the gas limit. `busy = Some(PendingTrade{stuck:false})` is written by `apply_sell` before awaiting `Vft.TransferFrom`. It is cleared only in the continuation (`commit_trade` / `revert_trade` / `mark_stuck`).
- **1.2** gstd resumes the message on its own remaining gas.
- **1.3** No critical hook and no gas pre-check.
- **1.4** Same structure as `graduate` (CANCELSAFETY-001, reproduced). `reconcile` requires `stuck == true` (panics NotStuck), so a starved `busy{stuck:false}` can't be resolved.

**Phase 2: Exploitability**
- **2.1** Any holder can sell 1 token-unit worth ≥ min trade with starved gas.
- **2.2** A gas window exists by the same argument as the reproduced CANCELSAFETY-001: the pre-await work plus send fits, the continuation doesn't.
- **2.3** No race needed.
- **2.4** Cost is one sell message. The attacker needs tokens, which are cheap on a fresh curve.

**Phase 3: Impact**
- **3.1** `buy`, `sell`, `graduate` and `unwind` all check `busy`, so the launch is frozen forever, including its escrow.
- **3.2** `busy` is the primary trade lock.

**Phase 4: PoC**
- **4.1 Pseudocode:**
  ```
  holder: Sell(T, x) with gas g* -> busy=Some(stuck=false); continuation starves
  anyone: Buy/Sell -> TradeInProgress
  anyone: Reconcile -> NotStuck
  ```
- **4.2 / 4.3** Executable PoC: covered by the mechanism reproduced in `poc_cancelsafety_001`; the lock variable differs but the execution model is identical. A dedicated test is added with the fix: the regression suite covers all five entrypoints.
- **4.4 Negative PoC** With normal gas, trade.rs passes.
- **4.5** Mechanism verified by the CANCELSAFETY-001 PoC.

**Phase 5: Devil's advocate**
1. None.
2. "Callers attach enough gas", but the call is permissionless.
3. Checked `reconcile`: it refuses non-stuck trades.
4. Mechanism executed.
5. No validation.
6. Gas is attacker-chosen.
7. A gas window exists (shown for graduate).
8. Practical: one message.
9. Primary lock.
10. The runtime causes it.
11. Not hallucinated.
12. N/A.
13. Re-read :580-:620 and `reconcile` :622-:660.

**Gates:** all six PASS.

**Verdict: TRUE POSITIVE (Critical/High).**

## CANCELSAFETY-003: `run_buy` sets `busy` before the VFT Transfer await (service.rs:1076)

**Phases 1-4:** identical to CANCELSAFETY-002 with the buyer as attacker. Attached value is also stuck in escrow: there is no refund, because the trap happens after the await.

**Phase 5:**
1-4 as for 002.
5. `check_buy` doesn't bound gas.
6-11 as for 002.
12. Also reachable as the *first buy* inside `launch` (creator self-harm).
13. Re-read :1068-:1091.

**Gates:** all PASS.

**Verdict: TRUE POSITIVE (Critical/High).**

## CANCELSAFETY-004: `reconcile` sets `lock` before the `BalanceOf` await (service.rs:634)

- **Phase 1:** reachable only when a trade is already `stuck == true` (after a reply timeout). The starved `reconcile` leaves `lock = true`. Later reconciles panic with ReconcileInProgress.
- **Phase 2:**
  - **2.1** Any account.
  - **2.2** A gas window, as above.
  - **2.3** Precondition: a stuck trade exists, which requires a VFT reply timeout. That's rare, but a griefer can watch for it.
- **Phase 3:** a permanent freeze of a launch that already had a stuck trade.
- **Phase 4:**
  ```
  timeout -> stuck trade; attacker Reconcile with gas g* -> lock stuck
  ```
  Negative PoC: graduation.rs/feedback.rs reconcile cases pass with normal gas.
- **Phase 5:** as for 002.
  - Q8: practical once the precondition exists.
  - Q12: not dismissed because of the rare precondition.
- **Gates:** all PASS, with the conditional precondition noted.

**Verdict: TRUE POSITIVE (High).**

## CANCELSAFETY-005: `unwind` sets `lock` before its await (service.rs:796)

- **Phase 1:** `unwind` sets `lock = true` (:796) and then awaits `unwind_wrapped`. It's reachable when `stale_ready || failed_early`.
- **Phase 2:** any account, gas window. It bricks the *recovery path* itself.
- **Phase 3:** a stale or failed launch can never be unwound, so holders can never be refunded. The funds are frozen.
- **Phase 4:**
  ```
  launch Ready past timeout -> attacker Unwind with gas g* -> lock stuck -> Graduate/Unwind panic forever
  ```
  Negative: graduation.rs unwind tests pass.
- **Phase 5:** as for 002. Q3: no admin rescue exists (dossier: "no signal hook or admin reset exists").
- **Gates:** all PASS.

**Verdict: TRUE POSITIVE (High).**

## CANCELSAFETY-006: AlignPrice swap times out but executes; stale budgets loop AddLiquidity (service.rs:1250)

**Phase 1: Data flow**
- **1.1** The budgets are updated only on a successful swap reply (:1268-1272).
- **1.2** gstd `up_to(timeout)` does not cancel the outbound message.
- **1.4** On retry, Failed rewinds AddLiquidity→AlignPrice (:696). With the pool already aligned, AlignPrice returns early (:1236) without touching the budgets. AddLiquidity is not in `is_unwindable`.

**Phase 2: Exploitability**
- **2.1** Not directly attacker-controlled: it needs a reply timeout on the swap, which depends on network or gas conditions. A griefer cannot force the pair's reply to be late, except by congesting it.
- **2.2** If the swap spent `amount_in` but the budget still includes it, then `amount_w > held` and AddLiquidity's TransferFrom fails.
- **2.4** The dossier notes `wvara_expected` is global, so the deposit might instead spend *other launches'* wVARA. That's worse, a cross-launch theft vector, though unproven.

**Phase 3: Impact**
- A permanent graduation failure with no unwind for the affected launch.
- Possible cross-launch value misattribution.

**Phase 4: PoC**
```
AlignPrice swap reply delayed past timeout -> Err(Timeout) -> Failed(retryable)
swap executes later -> retry: AlignPrice no-op -> AddLiquidity sized from stale budget -> fails forever
```
- Executable PoC: not built. It needs injected reply delay at the pair, which gtest can emulate by setting `reply_timeout` very low via `set_gas`. Deferred to the fix phase as a regression test.
- Negative PoC: with normal timeouts, the graduation tests pass.

**Phase 5: Devil's advocate**
1. None.
2. "Timeouts are rare."
3. The global `wvara_expected` makes it potentially worse.
4. Traced, not pattern-matched.
5. The early return skips budget repair.
6. N/A.
7. The inequality is shown.
8. Needs a timeout, so practical under congestion only.
9. Primary.
10. Runtime semantics cause it.
11. Logically traced, not executed.
12. Not dismissed.
13. Re-read :1221-:1275 and :690-:700.

**Gates:**

| Gate | Result | Basis |
|---|---|---|
| 1. Process | PASS | |
| 2. Reachability | PASS (conditional) | Needs a swap reply timeout |
| 3. Real Impact | PASS | |
| 4. PoC | PARTIAL | Pseudocode only; executable test deferred |
| 5. Math | PASS | |
| 6. Environment | PASS | |

**Verdict: TRUE POSITIVE (Medium), contingent on a reply timeout.** An executable PoC is required before the fix lands. The cross-launch angle needs its own test.

## CANCELSAFETY-007: `launch` reserves name and cooldown before the spawn await (service.rs:385)

- **Phase 1:** `names.insert` and the cooldown insert happen before the await. Rollback is in the continuation.
- **Phase 2:**
  - The attacker is the creator, choosing their own message's gas.
  - A third party cannot starve someone else's message.
  - Name squatting via self-starved launches costs gas plus a child-program ED each time, and leaves orphan tokens.
- **Phase 3:**
  - Self-inflicted loss of the creator's own first-buy value.
  - A permanently reserved name, a form of name squatting.
  - No third-party funds at risk.
- **Phase 4:**
  ```
  creator Launch(name, value v) with gas just above spawn -> name reserved, v stranded
  ```
  Negative PoC: launch.rs passes with normal gas.
- **Phase 5:**
  - Q6: only self-controlled gas.
  - Q8: practical, but only for self-harm or squatting.
  - Q9: the uniqueness of names is a product nicety, not a custody control.
  - The other questions are answered as above.
- **Gates:**

| Gate | Result | Basis |
|---|---|---|
| 1. Process | PASS | |
| 2. Reachability | PASS | |
| 3. Real Impact | MARGINAL | Self-harm plus name squatting |
| 4. PoC | PASS (pseudocode) | |
| 5. Math | PASS | |
| 6. Environment | PASS | |

**Verdict: TRUE POSITIVE (Low).**

## ARITHOFL-002: unchecked `ready_at + timeout` in `unwind` (service.rs:788)

- **Phase 1:**
  - **1.1** `graduation_timeout_blocks` is set only by the admin via `set_limits`, with no bounds. The admin is semi-trusted.
  - The addition happens inside `with_state_mut`, **before** the first await.
- **Phase 2:** requires the admin to set the timeout above `u32::MAX - ready_at`, roughly 4.29e9 minus the current block height.
- **Phase 3:** `unwind` of a stale-Ready launch panics before its await, so state reverts and no funds move. The unwind path is unavailable until the admin lowers the timeout. That's a recoverable admin misconfiguration.
- **Phase 4:**
  ```
  admin set_limits(..., u32::MAX) -> Unwind -> overflow panic (pre-await, reverted)
  ```
  Negative PoC: realistic timeouts don't overflow.
- **Phase 5:** Q6 is the key: this is admin-controlled, trusted-ish data. The other questions as above.
- **Gates:**

| Gate | Result | Basis |
|---|---|---|
| 1. Process | PASS | |
| 2. Reachability | FAIL for an untrusted attacker | Admin-only |
| 3. Real Impact | FAIL | Recoverable, no fund loss |
| 4. PoC | PASS | |
| 5. Math | PASS | |
| 6. Environment | PASS | |

**Verdict: FALSE POSITIVE as a vulnerability.** It's a valid hardening item (Low): use `saturating_add` and bound the timeout in `set_limits`.

## ASSERTREACH-001: `curve_params_for` can panic after the spawn await in a zero-value `launch` (service.rs:439)

- **Phase 1:**
  - The config is admin-set.
  - `set_raise_target` (:984) and `set_fees` don't call `curve_params_for` to validate (verified).
  - The pre-await validation at :378 runs only when `value != 0`.
- **Phase 2:** requires an admin config where the derivation fails, for example `raise_target` net below `graduation_fee`, or a zero denominator. Any creator then triggers it with a zero-value launch.
- **Phase 3:**
  - The panic happens after the await, so the name stays reserved.
  - The orphan VFT holds the full supply with the launchpad as admin.
  - No user funds are lost: the value is 0.
  - Recoverable by fixing the config, except for burned names.
- **Phase 4:**
  ```
  admin set_raise_target(tiny) -> creator Launch(value 0) -> spawn OK -> curve_params_for panics
  ```
  Negative PoC: valid configs work (launch.rs).
- **Phase 5:** Q6: admin-controlled. Q13: confirmed the setters don't validate.
- **Gates:**

| Gate | Result | Basis |
|---|---|---|
| 1. Process | PASS | |
| 2. Reachability | FAIL for an untrusted attacker | Needs admin misconfiguration |
| 3. Real Impact | FAIL | No funds |
| 4. PoC | PASS | |
| 5. Math | PASS | |
| 6. Environment | PASS | |

**Verdict: FALSE POSITIVE as a vulnerability.** Hardening (Low): validate with `curve_params_for` inside every config setter, and always call it before the await.

## RESEXHAUST-001: unbounded state growth; `launches()` returns everything (service.rs:484)

**Phase 1: Data flow**
- **1.1** Anyone can launch: one per creator per cooldown, and sybils bypass it.
- Each launch adds a ~1 KB `Launch` plus map entries.
- **1.2** Gear program memory is bounded by the runtime's max wasm pages. The exact Vara mainnet limit should be confirmed before deployment.
- **1.4** The `launches()` query serialises the full vector.

**Phase 2: Exploitability**
- Organic growth alone reaches tens of thousands of launches for a successful launchpad. pump.fun-scale volume would exceed any single-program memory.
- An attacker accelerates it. Each launch costs the attacker gas, and the launchpad pays a child-program ED from its reserve, bounded by `min_free_balance`.

**Phase 3: Impact**
- When allocation fails, **every** message traps, including sells and claims, so all custody is frozen.
- The query becomes unusable well before that.

**Phase 4: PoC**
```
N launches until heap exhausted -> any message traps on allocation
```
- Executable PoC: not run, because it would need tens of thousands of gtest launches. The memory bound is arithmetic: `Launch` ~1 KB × N plus HashMap overhead vs the max pages.
- Negative PoC: below capacity, everything works.

**Phase 5: Devil's advocate**
1. "Few launches expected."
2. MVP sizing.
3. Graduated launches are never pruned.
4. Not just pattern bias: a growth-without-bound design.
5. No cap.
6. Attacker-driven via sybils, and organic.
7. Order-of-magnitude bound shown.
8. Practical over time or with money.
9. Primary availability.
10. Bounded wasm memory makes it real.
11. Not hallucinated.
12. Not dismissed for being slow.
13. Re-read :480-:490 and the State maps.

**Gates:**

| Gate | Result | Basis |
|---|---|---|
| 1. Process | PASS | |
| 2. Reachability | PASS | |
| 3. Real Impact | PASS | Global freeze at capacity |
| 4. PoC | PARTIAL | Analytic, not executed |
| 5. Math | PASS (order of magnitude) | |
| 6. Environment | PASS | |

**Verdict: TRUE POSITIVE (Medium).**
- Fix: prune or compact graduated and unwound launches, paginate queries, cap active launches, and long-term shard per-launch state.

## RESDISC-002 / 003 / 004 / 005: refund send results discarded (service.rs:1085, 656, 514, 434)

- **Phase 1:** the same `pay`/`send_value` pattern as RESDISC-001. Recipients are `msg::source()` of the original buyer or creator: live accounts, or programs.
- **Phase 2:** the claimed deterministic failure (sub-ED rejection) is refuted, as in batch 2 (core-processor ext.rs:421, PoC passes).
  - The only remaining failure is a recipient *program* that bounces value.
  - In that case Gear returns the value to the launchpad, where it lands as untracked free balance.
  - That's self-inflicted by the caller's own program.
- **Phase 3:** no third-party impact; at most a self-inflicted loss for contract callers.
- **Phase 4:**
  ```
  caller program without a value-accepting handler buys -> transfer fails -> refund bounces -> untracked
  ```
  Negative PoC: account (EOA) recipients receive refunds (`poc_resdisc_001`).
- **Phase 5:** Q4: originally pattern-driven. Q10: the runtime delivers the value. Q12: considered program recipients. Q13: re-read wire.rs `send_value`.
- **Gates:** 3 FAIL (no real third-party impact), 5 FAIL (the claimed condition is unreachable for EOAs).

**Verdict: FALSE POSITIVE as described.** Hardening (Low): `#[must_use]`, and book failed sends into `pending_payouts`.

## STRCMP-001
Fully verified in batch 1 (and its addendum). FALSE POSITIVE as a vulnerability (Info). The 13-question set is completed in the batch-1 addendum below.

## CARGOLINT-001 and MSRV-001 (configuration)
- **Phase 1:** build configuration, not reachable at runtime by any attacker.
- **Phase 2:** no attacker control.
- **Phase 3:** no runtime impact. These are process and reproducibility hygiene.
- **Phase 4:** no exploit is possible.
  - Negative PoC: the wasm builds deterministically with the pinned rust-toolchain.toml.
- **Phase 5:** Q4 and Q9: hardening, not a vulnerability.
- **Gates:** 2 FAIL, 3 FAIL.

**Verdicts:**
- CARGOLINT-001: **FALSE POSITIVE as a vulnerability.** Hardening (Low): adopt the lint policy.
- MSRV-001: **FALSE POSITIVE as a vulnerability.** Hardening (Low): declare `rust-version` and publish reproducible wasm hashes.

---

## Batch-1 addendum: 13-question answers for the three early leads

**STRCMP-001**
1. An advisory query with a different normaliser.
2. Written before inner-space collapsing was added to `launch`.
3. `launch` is authoritative.
4. Yes, a "string mismatch" pattern.
5. `launch` validation prevents duplicates.
6. The input is the caller's own.
7. Shown: ≥2 inner spaces.
8. No exploit.
9. Advisory only.
10. Gear reverts the rejected launch before its await, so attached value returns to the sender. This is the environment property behind Gate 6: the runtime's message-revert rule, not the contract's code.
11. Real mismatch, no vulnerability.
12. N/A.
13. Re-read :322-:351 and :977.

**COOLDOWN-RESET**
1. Cleanup on failure.
2. Free the slot after a failed spawn.
3. The guard precedes the insert.
4. Yes.
5. The guard proves expiry.
6. The block height comes from the runtime.
7. Proven equivalent.
8. No.
9. The cooldown is defense-in-depth behind the voucher caps.
10. N/A.
11. FP.
12. Considered a forced-spawn-failure loop: not attacker-controllable.
13. Re-read :355-:360 and :428-:436.

**Discarded `run_buy` result**
1. Outcomes are handled inside `run_buy`.
2. Intentional (comment at :505-:507).
3. Events record the outcome.
4. Yes, a "dropped Result" pattern.
5. An exhaustive match handles every case.
6. The VFT is trusted.
7. Conservation shown.
8. No.
9. Reporting only.
10. N/A.
11. FP.
12. The stuck case is handled by `reconcile`. Note that CANCELSAFETY-003 is the real issue on this path.
13. Re-read :1068-:1091 and :184-:200.

**Gate 6 for STRCMP-001 restated as an environment analysis:** the Gear runtime reverts a message that traps before its first await, including returning attached value. No compiler or runtime protection *prevents* the mismatch itself, so Gate 6 PASSES. The verdict stays FALSE POSITIVE on Gate 3 (no real impact).

---

## Final summary (all findings)

**TRUE POSITIVES (8):**
- ARITHOFL-001 (Critical)
- CANCELSAFETY-001 (Critical)
- CANCELSAFETY-002 (Critical)
- CANCELSAFETY-003 (Critical)
- CANCELSAFETY-004 (High)
- CANCELSAFETY-005 (High)
- CANCELSAFETY-006 (Medium, conditional)
- RESEXHAUST-001 (Medium)
- CANCELSAFETY-007 (Low)

CANCELSAFETY-007 is a ninth true positive, Low severity.

**FALSE POSITIVES as vulnerabilities (13):**
- RESDISC-001..005
- ARITHOFL-002
- ASSERTREACH-001
- STRCMP-001
- CARGOLINT-001
- MSRV-001
- COOLDOWN-RESET
- the discarded `run_buy` result

Of these, all except COOLDOWN-RESET are kept as hardening items.

**Exploit chains:**
- ARITHOFL-001 combined with CANCELSAFETY-005: once graduation is bricked, unwind is also unavailable, because AlignPrice is not unwindable and the lock is held. So nothing recovers the launch.
- RESEXHAUST-001 combined with sybil launches accelerates the global freeze.
- The global `wvara_expected` (dossier) combined with CANCELSAFETY-006 is a potential cross-launch value drain. It needs a dedicated executable test.
