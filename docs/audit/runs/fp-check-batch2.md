# fp-check: batch 2 (deep verification, executable PoCs)

Bugs: ARITHOFL-001, CANCELSAFETY-001 (representing the CANCELSAFETY-001..005 family) and RESDISC-001 (representing the RESDISC-001..005 family).

These are routed to **deep** verification: async control flow plus a cross-program trust boundary (launchpad ↔ RivrDEX pair / VFT).

PoCs live in contracts/launchpad/launchpad/tests/audit_poc.rs. Run them with `cargo test --release --test audit_poc` from contracts/launchpad/launchpad.

---

## BUG A: ARITHOFL-001, division by zero in `step_align_price` bricks graduation

### Step 0: Claim
- **What:** an attacker pre-creates the RivrDEX pair for a live launch and seeds it with dust.
- **Root cause:** at sell-out, `graduate` reaches AlignPrice (service.rs:1221). There `rw_target = isqrt(floor(k/pt)·pv + (k mod pt)·pv / pt)` rounds to 0, and the `else` branch computes `k / rw_target` (service.rs:1254), which panics.
- **Why it sticks:** the panic happens after the `pair_get_reserves` await (:1225), while `launch.lock = true` (set at :702). Nothing clears it.
- **Bug class:** integer bounds / DoS of custody.
- **Threat model:** any unprivileged account with about 2 VARA.

### Phase 1: Data flow
- **1.1 Trust boundaries:**
  - The pair reserves `(rw, rt)` come from an external program, and anyone can create and seed that program (Factory.CreatePair is permissionless; vendor/vara-amm).
  - `pv` (pool_vara) and `pt` (pool_tokens) are internal and derived from config.
  - Validation before the division: only `rw.is_zero() || rt.is_zero()` returns early (:1229), plus the 1 % price-tolerance check (:1236). Neither prevents `rw_target = 0`.
- **1.2 API contracts:**
  - `primitive_types::U256` division panics on a zero divisor, the same as native integers. Checked via the PoC panic text "division by zero".
  - RivrDEX `AddLiquidity` mints LP when `sqrt(a·b) > MINIMUM_LIQUIDITY (1000)`, so 1001/1001 is accepted. Confirmed: the PoC seed succeeded.
- **1.3 Environment:**
  - Rust's safe arithmetic turns this into a panic, not memory corruption.
  - Gear keeps state committed before the await (lock = true); the trap only reverts the continuation.
  - No runtime protection clears the lock.
- **1.4 Cross-references:**
  - Similar code in `step_add_liquidity` divides by `pv`/`pt`, which are config-derived and non-zero.
  - The existing tests seed with ≥1e6 / 1e24 (feedback.rs:378), so `rw_target` never hits 0. That's why the bug was missed.

### Phase 2: Exploitability
- **2.1 Attacker control:** the attacker fully controls the seed amounts `(rw, rt)` within RivrDEX's minimum.
- **2.2 Math:**
  - Let `pv ≈ 5.91e14` (591 VARA in planck) and `pt = 2e26`.
  - With `rw = rt = 1001`, `k = 1.002e6 < pt`, so `floor(k/pt) = 0`.
  - The remainder term is `1.002e6 · 5.91e14 / 2e26 = 5.92e20 / 2e26 = 0` (integer).
  - So `isqrt(0) = 0`, and `rw ≥ rw_target` sends execution down the `else` branch, where `k / 0` panics.
  - More generally, `rw_target = 0` iff `k·pv < pt`, i.e. `rw·rt < pt/pv ≈ 3.4e11`. Any seed with `sqrt(rw·rt) ∈ (1000, ~5.8e5)` triggers it, so the attacker has a wide window.
- **2.3 Race feasibility:** none needed. The seed can be placed at any time before sell-out, because the pair address is deterministic per token.
- **2.4 Adversarial cost:** about 1 VARA pair fee plus dust plus gas. A griefer, or a competitor of the token, profits from bricking it.

### Phase 3: Impact
- **3.1 Real impact:** permanent loss of availability of custodied funds. Frozen for that launch:
  - the escrow, about 591 wVARA already wrapped plus the graduation fee;
  - the 200M pool tokens;
  - every holder's ability to trade, since buy/sell are blocked in Graduating and `unwind` panics with GraduationInProgress (:794).
  - The launchpad has no admin rescue path.
- **3.2 Primary vs defense-in-depth:** the lock is the primary concurrency control, and its failure mode is fail-closed forever. That's a primary-control flaw, not defense-in-depth.

### Phase 4: PoC
- **4.1 Pseudocode:**
  ```
  attacker: wVARA.Mint(1 VARA); Factory.CreatePair(wVARA, T); Pair.AddLiquidity(1001, 1001)
  users:    buy until sell-out -> state Ready
  keeper:   Graduate x4 -> FindOrCreatePair (finds attacker pair) .. ApproveWvara OK
  keeper:   Graduate -> AlignPrice: reserves(1001,1001) -> rw_target=0 -> k/0 PANIC (lock=true persists)
  anyone:   Graduate/Unwind -> panic GraduationInProgress, forever
  ```
- **4.2 / 4.3 Executable unit-test PoC:** `poc_arithofl_001_dust_seed_must_not_brick_graduation` **FAILS as expected**. Observed:
  - seeded reserves 1001 / 1001;
  - steps Ok(FindOrCreatePair), Ok(ApproveToken), Ok(ApproveWvara), Ok(AlignPrice), then a trap with "panicked with 'division by zero'" on every retry;
  - final state Graduating, step AlignPrice, lock = true.
- **4.4 Negative PoC:** with a normal seed (≥1e6 wVARA / 1e24 tokens, feedback.rs:374) or no seed (graduation.rs), graduation completes. The precondition is `rw·rt < pt/pv`.
- **4.5 PoC verification:** the assertion fails exactly on the predicted step with the predicted panic message.

### Phase 5: Devil's advocate (13 questions)
1. **Non-vulnerability explanation?** None. Dividing by a value that can be zero is unintended.
2. **Developer justification?** The developer assumed `rw_target > 0` because realistic pools are large; the code was written against hostile seeds but tested only with big ones.
3. **Missing architecture context?** Checked RivrDEX's minimum (1000) and pair-creation permissions. Neither prevents the seed.
4. **Pattern bias?** No, it's proven by execution.
5. **Does validation prevent it?** The zero-reserve check doesn't cover `rw_target = 0`.
6. **Trusted-data confusion?** No. The reserves are attacker-written.
7. **Math proven?** Yes, both algebraically and by the PoC.
8. **Practically exploitable?** Yes, for about 2 VARA.
9. **Defense-in-depth confusion?** No, the primary control fails closed.
10. **Runtime protections?** Rust and Gear convert it to a trap, and the trap is exactly what freezes the lock.
11. **Hallucination?** No, reproduced.
12. **Dismissing a complex exploit?** N/A, it's simple.
13. **Invented mitigations?** Re-read :1221-1260 and :702-726 after concluding. No lock release on trap, no admin unlock.

### Gates
| Gate | Result | Basis |
|---|---|---|
| 1. Process | PASS | All phases completed |
| 2. Reachability | PASS | PoC |
| 3. Real Impact | PASS | Permanent custody freeze |
| 4. PoC | PASS | Executable test |
| 5. Math | PASS | Algebraic proof |
| 6. Environment | PASS | The trap causes the freeze |

**Verdict: BUG A TRUE POSITIVE (High).** Dust-seeded pair makes AlignPrice divide by zero after an await, freezing the launch's escrow and pool tokens permanently.

---

## BUG B: CANCELSAFETY-001..005, lock/busy set before an await is never cleared when the continuation starves

### Step 0: Claim
- `graduate` (:702), `sell` (:600), `run_buy` (:1076), `reconcile` (:634) and `unwind` (:796) set `lock`/`busy` in state, then `.await` a reply.
- They clear it only in the continuation.
- The continuation runs on the remaining gas of the *caller's* message, and the caller chooses that gas.

### Phase 1: Data flow
- **1.1 Trust boundary:** the message gas limit is chosen by any sender and is untrusted. The lock is internal state.
- **1.2 API contract:**
  - In gstd, an awaiting message is parked in the waitlist and resumed with its own remaining gas when the reply arrives.
  - If that gas is insufficient, the continuation traps (GasLimitExceeded) or the message is evicted.
  - State committed before the await persists: Gear commits state at each `wait`.
- **1.3 Environment:**
  - No critical hook (`gstd::critical`) is installed.
  - No gas reservation is made.
  - No minimum-gas check precedes the lock.
- **1.4 Cross-references:**
  - The trade path's `busy` + `TradeStuck` + `reconcile` design handles reply *timeouts*, but not continuation death before `mark_stuck` runs.
  - `reconcile` refuses `busy` with `stuck = false` (NotStuck).

### Phase 2: Exploitability
- **2.1 Control:** any account picks the gas limit of `Graduate`, `Buy` or `Sell`. `Graduate` is permissionless.
- **2.2 Bounds:** the PoC sweeps the gas limit from 2e9 to 6e10 in 1e9 steps. Values exist where the pre-await part completes (lock = true and the outbound message is sent) but the continuation can't finish.
- **2.3 Race:** not needed.
- **2.4 Adversarial cost:** one cheap message per launch. It can grief every launch at sell-out, or any trading launch via a starved `Buy`/`Sell` (CANCELSAFETY-002/003).

### Phase 3: Impact
- **3.1:** a permanent freeze of a launch's custody, the same impact class as Bug A. For buy and sell, the trader's attached or locked value is stuck as well.
- **3.2:** the lock is the primary control.

### Phase 4: PoC
- **4.1 Pseudocode:**
  ```
  sell-out -> Ready
  attacker: Graduate(T) with gas g where pre-await code + send fits, continuation does not
  -> lock=true committed; continuation traps / evicted
  keeper (after 200 blocks): Graduate x25 -> panic GraduationInProgress each time
  ```
- **4.2 / 4.3 Executable PoC:** `poc_cancelsafety_001_gas_starved_graduate_must_not_freeze` **FAILS as expected**. Final state: Graduating, step WrapVara, lock = true. The honest keeper's calls all return UserspacePanic ("GraduationInProgress").
- **4.4 Negative PoC:** with sufficient gas, as in every graduation.rs test, the lock clears and graduation completes.
- **4.5 PoC verification:** the assertion fails as predicted.

### Phase 5: Devil's advocate
1. **Non-vulnerability explanation?** Locks across awaits are normal. The defect is the missing expiry or recovery path.
2. **Developer justification?** Developers often assume the keeper always attaches enough gas. But the methods are permissionless.
3. **Missing context?** Checked for critical hooks, reservations and admin overrides. None exist.
4. **Pattern bias?** No, it's executed.
5. **Validation?** There's no gas check.
6. **Trusted data?** No. Gas is caller-chosen.
7. **Math?** The gas window was found empirically.
8. **Practical?** Yes, one message.
9. **Defense-in-depth?** No, primary.
10. **Runtime protections?** Gear's waitlist eviction makes it worse, not better.
11. **Hallucination?** No, reproduced.
12. **Complexity dismissal?** N/A.
13. **Invented mitigations?** Re-read :670-726. The lock is cleared only at :726, in the continuation.

### Gates
All six PASS: process, reachability (PoC), impact (permanent freeze), PoC, math (gas window shown), environment.

**Verdict: BUG B TRUE POSITIVE (High).** Gas-starved continuations leave the per-launch lock or busy flag set permanently, freezing custody. This applies to CANCELSAFETY-001/002/003/005 by the same mechanism. CANCELSAFETY-004 (reconcile) needs a prior stuck trade (Medium). CANCELSAFETY-006/007 are judged separately by the fp judge.

---

## BUG C: RESDISC-001..005, refund `send` result discarded; sub-ED refunds claimed to be lost

### Step 0: Claim
- `pay`/`send_value` return `bool`, which is ignored at five refund sites.
- The claim: Gear rejects any send with `0 < value < ED` (`InsufficientValue`, 307), so the refund is lost and stays in the program as untracked free balance.

### Phase 1: Data flow
- **1.1:** the refund amount is attacker-chosen (the overpay on the curve-completing buy).
- **1.2 API contract, verified in source:**
  - gear 1.10 `core-processor-1.10.0/src/ext.rs:421` `charge_message_value` only checks that the program's value counter covers the amount.
  - The send path has no existential-deposit check.
  - `InsufficientValue = 307` is defined in gear-core-errors-1.10.0/src/lib.rs:132, but in this version it's raised only for builtin actors (gtest-1.10.0/src/manager/block_exec.rs:738).
- **1.3 Environment:**
  - The buyer is a live account, since it just paid gas and value.
  - Delivering value below the existential deposit to an existing account doesn't reap it.
- **1.4 Cross-references:** `pay_seller` defers small payouts into `pending_payouts`, which is conservative and fine.

### Phase 2: Exploitability
- **2.1:** the buyer controls the refund size.
- **2.2 Math:** the failure condition would be "send rejected". Per 1.2 it is not rejected for any value ≤ the program's balance.
- **2.3:** N/A.
- **2.4:** no attacker benefit even in theory. The only loser would be the buyer themselves.

### Phase 3: Impact
None demonstrated. The residual risk is that an unrelated send failure would go untracked. No such failure mode is identified for a live recipient with sufficient program balance.

### Phase 4: PoC
- **4.1 Pseudocode:**
  ```
  quote_buy(T, 5000 VARA) -> gross_used
  buy(T) with value gross_used + (ED-1)
  ```
- **4.2 / 4.3 Executable PoC:** `poc_resdisc_001_sub_ed_refund_is_not_lost` **PASSES**:
  - program balance delta = gross_used, exactly 299999999999997 planck;
  - buyer net cost = gross_used + ~0.79 VARA (gas), which is less than gross_used + overpay (0.999999999999 VARA);
  - so the refund was delivered.
- **4.4 Negative PoC:** a refund of 0 skips the send (`send_value` returns early), so it's trivially safe.
- **4.5 Verification:** the claimed loss does not occur.

### Phase 5: Devil's advocate
1. **Non-vulnerability explanation?** Value transfer to live accounts works below the existential deposit.
2. **Developer justification?** The sends can't fail in practice. Still, ignoring the result is poor hygiene.
3. **Missing context?** The mainnet runtime could differ from gtest. The core-processor code is shared, and the runtime pallet's bank transfer to an existing account is unaffected by the existential deposit.
4. **Pattern bias?** Yes. The original claim came from a documented-but-unused error code.
5. **Validation?** N/A.
6. **Trusted data?** N/A.
7. **Math?** The failure condition is unreachable.
8. **Practical?** No.
9. **Defense-in-depth?** The ignored bool is a hygiene gap only.
10. **Runtime?** The runtime is exactly what delivers the value.
11. **Hallucination?** The worker's premise was wrong; the test proves it.
12. **Dismissing?** Considered recipients that are programs without a `handle` for value: refunds go to `msg::source()`. A buyer program that traps on receiving value could bounce it. Gear then returns the value to the launchpad as untracked free balance. That's a self-inflicted loss by a caller program, so Low.
13. **Invented mitigation?** Re-read wire.rs `send_value` and ext.rs:421.

### Gates
| Gate | Result | Basis |
|---|---|---|
| 1. Process | PASS | All phases completed |
| 2. Reachability | PASS | Path is reachable |
| 3. Real Impact | **FAIL** | No loss for EOAs |
| 4. PoC | **FAIL** | The PoC shows the refund delivered |
| 5. Math | **FAIL** | The rejection condition doesn't exist in gear 1.10 |
| 6. Environment | PASS | No environmental protection relied on |

**Verdict: BUG C FALSE POSITIVE (as described).** It's a hygiene follow-up only: mark `pay`/`send_value` `#[must_use]` and book failures into `pending_payouts`, so a recipient program that bounces value isn't silently credited to free balance (Low).
