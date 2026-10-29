# fp-check: batch 1 (standard verification)

Target: contracts/launchpad/launchpad/app/src/service.rs (Gear/Sails, gstd 1.10.0). All three routed to **standard** verification: single component, no cross-program trust boundary in the bug path, clear claims. Escalation checkpoints evaluated at Step 1 and Step 5 below; none triggered.

---

## BUG 1: STRCMP-001, `name_taken` normalises differently from `launch`

**Step 0, claim.** `name_taken(name)` (service.rs:977-979) checks `st.names.contains(name.trim().to_lowercase())`. `launch` (service.rs:326-331) builds the key with `split_ascii_whitespace().join(" ").to_ascii_lowercase()`. For an input with repeated inner whitespace (for example "Moon  Frog" when "moon frog" exists), the query says the name is free, but `launch` panics with `NameTaken`. Bug class: logic / inconsistent canonicalisation. Threat model: any caller.

**Step 1, data flow.** Source: the caller's own query argument (untrusted, but only affects the caller's own read). Sink: a read-only `HashSet::contains`. No state writes. `launch` independently recomputes the canonical key and enforces uniqueness at service.rs:351 before any await. No escalation trigger: one component, no async in the bug path.

**Step 2, exploitability.** Attacker control: yes, over their own query input only. Math: a mismatch occurs iff `trim(lower(n)) != join(split_ws(lower(n)))`, i.e. the name has ≥2 consecutive inner whitespace chars or non-space ASCII whitespace (tab). `launch` rejects tabs anyway via `printable` (service.rs:322). Race: N/A, the query is read-only.

**Step 3, impact.** The query is advisory UI data. The on-chain uniqueness invariant is enforced in `launch` with the canonical key, so it holds. The failing `launch` panics before its first `.await`, so Gear refunds the attached value (gstd semantics: a trap before the first await reverts the message and returns its value). This is an operational/UX inconsistency, not a primary control failure.

**Step 4, PoC.**
```
existing: names = {"moon frog"}
user: name_taken("Moon  Frog") -> key "moon  frog" -> false   // says free
user: launch({name:"Moon  Frog"}) -> key "moon frog" -> contains -> panic NameTaken
result: message reverted, value refunded, no state change
```
Negative PoC: `name_taken("moon frog")` → true, which agrees with `launch`.

**Step 5, devil's advocate.** (1) Not pattern-matching; the inconsistency is real. (2) No trust-boundary confusion: the attacker only controls their own query. (3) Math shown above. (4) Not a defense-in-depth failure; the primary control in `launch` is intact. (5) Not hallucinated; both lines re-read. (6) No hidden exploit: no state or value moves. (7) No invented mitigation; the refund-before-await rule is gstd's documented message semantics and the panic is at service.rs:351, before the spawn await at :413.

**Gates.** 1 Process PASS · 2 Reachability PASS · **3 Real Impact FAIL** (UX only; uniqueness and funds unaffected) · 4 PoC PASS · 5 Math PASS · 6 Environment PASS (Gear's refund behaviour removes any value impact).

**Verdict: BUG #1 FALSE POSITIVE (as a security issue).** It's a correctness bug worth fixing: share one `name_key()` helper between `launch` and `name_taken`. Severity: Info.

---

## BUG 2: COOLDOWN-RESET, failed spawn removes `last_launch_by_creator`

**Step 0, claim.** On the spawn-failure path (service.rs:428-436), `last_launch_by_creator.remove(&creator)` deletes the creator's entry instead of restoring the previous timestamp, which might clear an active cooldown and enable spam launches or voucher drain.

**Step 1, data flow.** Entry is written at service.rs:360 (`insert(creator, now)`) only after the guard at service.rs:355-358 passes. The guard panics if `now < last + cooldown`. So reaching :360 implies that any previous entry `last` satisfies `now ≥ last + cooldown` (saturating add). The removal happens after the await in the same message.

**Step 2, exploitability / math.**
Let `L` be the previous timestamp (possibly absent) and `c` the cooldown. Reaching :360 requires `now ≥ L + c`.
- If the old value were restored, a later launch at block `n' ≥ now` passes iff `n' ≥ L + c`. That is already true since `n' ≥ now ≥ L + c`.
- With removal, a later launch always passes.

So both behaviours admit exactly the same set of future launches. The removal can never shorten a cooldown that was still active. Race: another launch by the same creator interleaving during the spawn await sees `last = now` (inserted before the await) and is blocked, which is correct.

Can an attacker force spawn failures repeatedly to launch-spam for free? Spawn inputs are config-fixed (`vft_code_id`, gas) plus validated metadata lengths. No attacker-controlled path to a VFT init trap was found. Even so, each attempt costs gas, which the voucher pays only once per voucher, and the voucher server caps per IP and globally.

**Step 3, impact.** No cooldown bypass. A failed spawn correctly refunds `value` (service.rs:434) and frees the name.

**Step 4, PoC (attempted).**
```
t=100 creator launches OK            -> last=100
t=105 launch again                   -> 105 < 100+20 -> panic LaunchCooldown   (blocked, as intended)
t=130 launch, spawn fails            -> guard passes (130 >= 120), insert 130, then remove
t=131 launch                         -> allowed; with a restored value 100: 131 >= 120 -> also allowed
```
The attack trace produces no difference from intended behaviour. Negative PoC: the t=105 attempt stays blocked in both variants.

**Step 5, devil's advocate.** (1) It looked dangerous; the algebra says otherwise. (2) N/A. (3) Proven above. (4) N/A. (5) Re-read :355-360 and :428-433, confirmed. (6) Considered a forced-spawn-failure DoS loop: no attacker-controlled failure found, and gas and voucher caps bound it. (7) No invented validation; the guard is in code.

**Gates.** 1 PASS · 2 Reachability PASS (path reachable) · **3 Real Impact FAIL** · 4 **PoC FAIL** (no divergence from intended behaviour) · **5 Math FAIL** (proof shows an active cooldown cannot be cleared) · 6 PASS.

**Verdict: BUG #2 FALSE POSITIVE.** Removing an entry that was necessarily already expired is equivalent to restoring it.

---

## BUG 3: RESDISC lead, `let _ = self.run_buy(...)` in `launch` (service.rs:511)

**Step 0, claim.** The first buy's `Result` is discarded, so a failed first buy might lose the creator's VARA, or `launch` might report success while the buy failed.

**Step 1, data flow.** `run_buy` (service.rs:1068-1091) handles every outcome internally:
- `Ok(true)` → `commit_trade`.
- `Ok(false)/Send/Reply/Decode` → `revert_trade` restores the reserves, `real_remaining` and escrow, and calls `st.settle(escrow_delta)` for liabilities (service.rs:184-200). Then `pay(buyer, pending.vara_gross)`, where `vara_gross = plan.gross_used` (service.rs:164). The excess `plan.refund` was already paid before the await (service.rs:1078-1081). Total returned = gross_used + refund = attached value.
- `Timeout` → `mark_stuck` + `TradeStuck` event. The funds stay escrowed and the permissionless `reconcile` path resolves them, the same as any normal stuck buy.

**Step 2, exploitability.** The caller cannot steer `run_buy` into a lossy path: the outcomes depend on the VFT transfer reply, and the VFT is the launchpad's own freshly spawned program. Math: value conservation holds as shown above. Race: the launch is locked by `busy` inside `apply_buy`, the same as normal buys.

**Step 3, impact.** No value loss and no accounting break. The only effect is that `launch` returns `Ok(token)` even when the first buy was reverted or got stuck. The frontend then cannot show "first buy refunded" for the TransferFailed case: `firstBuySkipped` is only set for the pre-check `Err` path (use-launchpad.ts:128-135, service.rs:512-516). This is a UX/reporting gap.

**Step 4, PoC.**
```
creator: launch(meta, value=10 VARA)
spawn OK -> check_buy OK -> run_buy: VFT transfer replies false
-> revert_trade, pay(creator, gross_used) (+refund earlier)  => creator made whole
-> launch returns Ok(token)   // UI shows success with no first-buy notice
```
Negative PoC: the success path returns Ok and the creator holds their tokens.

**Step 5, devil's advocate.** (1) `let _ =` looks like a classic dropped error; tracing shows every branch handled. (2) N/A. (3) Conservation shown. (4) Defense-in-depth only: reporting. (5) Re-read :1068-1091 and :184-200. (6) The stuck case is real but identical to normal-buy stuck handling, which is covered by `reconcile`. (7) No invented mitigations; all cited.

**Gates.** 1 PASS · 2 PASS · **3 Real Impact FAIL** (reporting only) · 4 PASS · 5 PASS · 6 PASS.

**Verdict: BUG #3 FALSE POSITIVE (as a security issue).** It's a correctness improvement: map `Err(TransferFailed)` to `Err(FirstBuySkipped("transfer failed, refunded"))` and `Err(TradeStuck)` to a distinct error, so the creator is told. Severity: Low/Info.

---

## Exploit-chain check
- Bugs 1 and 3 are reporting/UX inconsistencies, and bug 2 is equivalent to the intended behaviour. Combined, none of them moves value or bypasses a guard.
- No chain found.

## Summary
- **0 TRUE POSITIVES, 3 FALSE POSITIVES** (as security vulnerabilities).
- **Follow-ups worth doing:** bug 1 (shared name canonicaliser), Info; bug 3 (surface the first-buy failure to the caller), Low.

---

# Addendum: Step 6 completion (13-item false-positive checklist and environment analysis)

## Environment protections (Phase 1 / Gate 6), shared by all three
- **Runtime:** Gear wasm32, built with `overflow-checks = true` in release, so arithmetic overflow traps rather than wraps.
- **Message semantics:** when a handler traps before its first `.await`, the message is reverted and its attached value goes back to the sender. This is relied on and covered by tests (contracts/launchpad/launchpad/tests/trade.rs and feedback.rs: trap-before-await refund cases).
- **No shared-memory concurrency:** messages execute one at a time per program. Interleaving is only possible at `.await` points.
- **Sails:** method arguments are SCALE-decoded. A malformed decode traps before the handler runs.

None of these *creates* the alleged bugs. For bug 1, Gate 6 rests on the message-revert rule above: it removes any value impact of the rejected launch.

## Bug 1, STRCMP-001: 13-item checklist
1. **Validation chain:** `launch` re-canonicalises and checks at :326-:351, before any await. 1a. **Conditional flow:** the mismatch needs ≥2 consecutive spaces. Tabs and other non-space whitespace are rejected by `printable` at :322.
2. **Defensive patterns:** the uniqueness check in `launch` is the primary control and works.
3. **Exploitable path:** none to state or value. The query is read-only.
4. **Data source:** the caller's own argument; it only affects that caller's own view.
5. **Bounds:** N/A. No arithmetic.
6. **TOCTOU:** the query is time t and launch is time t+n. Between them another user can also take the name. That's an inherent advisory-query race, and the authoritative check sits in `launch`.
7. **API contract:** `HashSet::contains` is exact match, which explains the divergence.
8. **Internal vs external:** `names` is internal state written only by `launch`.
9. **Pattern vs analysis:** traced, not pattern-matched.
10. **Concurrency:** single-threaded per message, as above.
11. **Real impact:** UX only.
12. **Defense-in-depth vs primary:** the query is a convenience. The primary control is intact.
13. **Rigor:** all items applied. **Verdict unchanged: FALSE POSITIVE (Info).**

## Bug 2, COOLDOWN-RESET: 13-item checklist
1. **Validation chain:** the guard at :355-358 precedes the insert at :360. 1a. **Conditional flow:** reaching the removal at :432 implies `now ≥ L + c`. Proven equivalent to restoring the old value.
2. **Defensive patterns:** the removal is cleanup on the failure path, a red-flag category ("reporting issues in error handling/cleanup").
3. **Exploitable path:** none produces a divergence.
4. **Data source:** `exec::block_height()` and `msg::source()` come from the runtime; they are not attacker-forgeable.
5. **Bounds:** `saturating_add` cannot overflow; the algebra is in Step 2.
6. **TOCTOU:** during the spawn await the entry is `now`. An interleaved launch by the same creator is blocked, which is correct.
7. **API contract:** `HashMap::remove` and `insert` are exact.
8. **Internal vs external:** internal state.
9. **Pattern vs analysis:** looked like a reset; the maths refutes it.
10. **Concurrency:** only at await points, handled.
11. **Real impact:** none.
12. **Defense-in-depth:** the per-creator cooldown is itself defense-in-depth behind the voucher-server caps.
13. **Rigor:** applied. **Verdict unchanged: FALSE POSITIVE.**

## Bug 3, discarded `run_buy` result: 13-item checklist
1. **Validation chain:** `check_buy` precedes `run_buy`, and `run_buy` handles every reply variant at :1084-1090. 1a. **Conditional flow:** every `CallError` variant matches; the match is exhaustive, so the compiler enforces it.
2. **Defensive patterns:** revert + refund on failure, stuck-marking on timeout.
3. **Exploitable path:** the caller cannot pick the failure branch. It depends on the reply from the launchpad's own VFT.
4. **Data source:** the VFT reply is from a trusted program the launchpad instantiated.
5. **Bounds:** conservation holds: refund + gross_used = attached value, and liabilities are settled via `st.settle(escrow_delta)`.
6. **TOCTOU:** the `busy` lock set in `apply_buy` covers the await.
7. **API contract:** `let _ =` drops only the return value. All side effects already happened inside `run_buy`.
8. **Internal vs external:** internal.
9. **Pattern vs analysis:** "dropped Result" is a red-flag pattern; tracing shows it's handled.
10. **Concurrency:** await interleaving is guarded by `busy`.
11. **Real impact:** a reporting gap only.
12. **Defense-in-depth:** the primary fund-safety controls are intact.
13. **Rigor:** applied. **Verdict unchanged: FALSE POSITIVE (Low, reporting).**

## Scope note
- This batch covers the three leads raised during the review.
- The rust-review findings (STRCMP-001, CARGOLINT-001, MSRV-001 and anything the remaining workers file) go through the rust-review dedup and fp judges once all workers finish. Any surviving finding at Medium or above then gets its own fp-check pass.
