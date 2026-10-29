---
stage: final-report
threat_model: REMOTE
severity_filter: all
total_primaries: 19
reported_findings: 19
---

# Rust Security Review — Final Report

**Scope:** contracts/launchpad (Vara/Gear Sails bonding-curve launchpad + VFT)
**Threat Model:** REMOTE
**Severity Filter:** all
**Primaries (after dedup):** 19
**Reported:** 19 (after FP and severity filter)

## Severity distribution (reported)
| Severity | Count |
|----------|-------|
| CRITICAL | 4 |
| HIGH | 2 |
| MEDIUM | 2 |
| LOW | 11 |

All 19 primaries survived FP review (14 TRUE_POSITIVE, 5 LIKELY_TP). None were rejected; see `fp-summary.md`.

## Key takeaways
- **The systemic problem is cancel-safety across Gear awaits (CANCELSAFETY-001..005).** Each permissionless entry point (Graduate, Sell, Buy, Reconcile, Unwind) commits `lock`/`busy` before an `.await` and clears it only in the continuation. The caller controls the gas limit, so the continuation can be starved. There is no gas floor, no critical hook, and no expiring lock. The orchestrator **reproduced** this for Graduate with an executable gtest PoC (`contracts/launchpad/launchpad/tests/audit_poc.rs`).
- **ARITHOFL-001 (reproduced):** a dust-seeded RivrDEX pair (1001/1001) turns `rw_target` into 0 in AlignPrice. The `k / rw_target` division then panics after the await, and the launch is left `Graduating`/`lock=true` forever.
- **RESDISC-001..005 are downgraded to hardening gaps.** All five assumed that Gear rejects sends with 0 < value < ED. An orchestrator PoC (`poc_resdisc_001_sub_ed_refund_is_not_lost`) disproves this for gear 1.10: the sub-ED refund is delivered. They are reported only as LOW/Theoretical discarded-result gaps. Their finding bodies still describe the disproved mechanism.

## CRITICAL (4)

### ARITHOFL-001 — Division by zero in AlignPrice (rw_target == 0) after await permanently locks a graduating launch
- **Location:** `contracts/launchpad/launchpad/app/src/service.rs:1254` (`step_align_price`)
- **Bug class:** arithmetic-overflow
- **Attack vector:** Remote
- **Exploitability:** Reliable
- **Also affects:** — (standalone primary)
- **FP verdict:** TRUE_POSITIVE — Verified at service.rs:1254 and reproduced by gtest PoC: dust-seeded pair (1001/1001) makes rw_target=0, else-branch k/rw_target panics after await, leaving lock=true/Graduating forever
- **Severity rationale:** Permissionless, ~1 VARA attack permanently freezes a sold-out launch's pool VARA, fee escrow and pool tokens with no recovery path; repeatable against every launch

#### Description
`step_align_price` reads the RivrDEX pair reserves `(rw, rt)` and computes
`rw_target = sqrt(k * pv / pt)` with `k = rw * rt`. If an attacker pre-seeds the pair with a
tiny pool, `k * pv < pt` and `rw_target` comes out as **0**. The `rw < rw_target` check is then
false, so execution takes the `else` branch and runs `k / rw_target`. That is a U256 division by
zero, which always panics (`uint::div_mod` does `assert!(your_bits != 0, "division by zero")`),
whatever `overflow-checks` is set to.

The panic happens after at least one `.await` (`pair_get_reserves`). In Gear, state committed
before the first await stays committed: `launch.lock = true` and `state = Graduating` (set in
`graduate` at line 702). The `lock = false` reset at line 726 never runs. Every later call then
fails:
- `graduate` panics `GraduationInProgress` (line 681)
- `unwind` needs `Ready`/`Failed` and `!lock`, so it panics
- `reconcile`, `buy` and `sell` reject (`lock`, or state not Trading/Aborted)

No admin method clears `lock`.

#### Code
```rust
let (r0, r1) = wire::pair_get_reserves(launch.pair, gas).await?;   // await -> lock=true committed
let (rw, rt) = if launch.wvara_is_token0 { (r0, r1) } else { (r1, r0) };
...
if diff * U256::from(100u32) <= rhs { return Ok(()); }              // dust seed is far off-price
let k = rw * rt;
let rw_target = (k / pt * pv + (k % pt) * pv / pt).integer_sqrt();  // == 0 when k*pv < pt
...
let (wvara_budget, token_budget) = if rw < rw_target {              // false when rw_target == 0
    ...
} else {
    let rt_target = k / rw_target;                                  // line 1254: divide by zero -> panic
```

#### Data flow
- **Source:** pair reserves set by an attacker who calls `Factory.CreatePair(wVARA, token)` (permissionless) and the pair's `AddLiquidity` with dust amounts (e.g. 1001 planck wVARA + 1001 token base units; RivrDEX only needs `sqrt(a*b) >= 1000`).
- **Sink:** `k / rw_target` at service.rs:1254.
- **Validation:** none. The only checks are `rw.is_zero() || rt.is_zero()` and the 1% price tolerance, and a dust seed fails the tolerance check, so it falls through to the division.

Worked numbers: pt = 200M * 1e18 = 2e26, and pv is about 3e17 planck (~300k VARA) or 5.9e14 (592 VARA). Then pt/pv is about 6.7e8 to 3.4e11, and a seed with k = 1001*1001 ≈ 1e6 is below it, so `k*pv/pt` floors to 0 and `rw_target = 0`. This holds for any realistic pool_vara below about 2e8 VARA.

#### Reachability trace
attacker: buy 1001 base units of token on the curve → `Factory.CreatePair` → `Pair.AddLiquidity(1001, 1001)` → curve sells out → keeper (or anyone) calls `graduate` through WrapVara, FindOrCreatePair (returns the attacker's pair), ApproveToken, ApproveWvara → `graduate` at AlignPrice → `step_align_price` → `k / rw_target` panics.

#### Impact
Permanent DoS and loss of funds for the launch. All of these are stuck forever with no recovery path:
- the full pool VARA (already wrapped to wVARA and counted in `wvara_expected`)
- the remaining graduation-fee escrow
- the 200M pool tokens

Token holders can never sell back, and the curve never lists. It costs the attacker about 1 VARA (pair-creation fee), dust, and gas. It can be repeated against every launch.

#### Mitigations checked
- overflow-checks are irrelevant here: divide-by-zero panics unconditionally.
- Tests cover a cheap seed (1e6 wVARA with 1e24 tokens, k = 1e30, rw_target > 0). They do not cover the case where k < pt/pv.
- No admin escape hatch resets `lock`. Gear keeps pre-await state when the handler traps after an await.

#### Recommendation
Do not divide by `rw_target` when it is zero. Treat `rw_target == 0` (or `rw_target <= rw`, using
`checked_div`) as a reason to buy tokens with wVARA, or return `Err(CallError::Reply)`. More
generally, make every post-await computation in graduation steps non-panicking (checked ops that
map to `CallError`). Clear `lock` with a guard pattern, or add an admin/timeout-based lock reset
for launches whose lock has been held longer than N blocks.

---

### CANCELSAFETY-001 — Graduate sets per-launch lock before await; gas-starved continuation leaves lock=true forever, freezing launch and its escrow
- **Location:** `contracts/launchpad/launchpad/app/src/service.rs:702` (`graduate`)
- **Bug class:** cancel-safety
- **Attack vector:** Remote
- **Exploitability:** Reliable
- **Also affects:** — (standalone primary)
- **FP verdict:** TRUE_POSITIVE — Verified lock=true at service.rs:702 cleared only post-await at 726, no gas floor/critical hook/escape hatch; reproduced by gtest PoC (gas-starved Graduate leaves lock=true at WrapVara, launch frozen)
- **Severity rationale:** Any account can permanently freeze every sold-out launch's escrow with one cheap gas-starved message; reproduced

#### Description
`graduate` is permissionless. It writes `launch.state = Graduating` and `launch.lock = true` synchronously, then awaits a cross-program reply. The lock is cleared only in the continuation (line 726). Under Gear semantics, state written before the first `.await` is persisted when the message enters the waitlist. The continuation runs later on whatever gas is *left* in the caller's original message, and the caller chooses that gas limit. An attacker sends `Graduate(token)` with just enough gas to run the pre-await section and dispatch the outbound message. That message's own gas (`gas_for_token_ops`) and `gas_for_reply_deposit` are deducted at send time, leaving too little to run the continuation or to pay waitlist rent for `reply_timeout` blocks. The continuation then traps on out-of-gas (or the message is evicted from the waitlist), and `lock = false` never executes. This is the Gear version of a future cancelled at an await point with half-written state and no drop guard.

#### Code
```rust
// service.rs:676-726
let (step, launch) = self.with_state_mut(|st| {
    let launch = st.launch_mut(&token);
    if launch.busy.is_some() { panic!("TradeInProgress") }
    if launch.lock { panic!("GraduationInProgress") }
    match launch.state {
        LaunchState::Ready => { launch.state = LaunchState::Graduating; launch.step = GradStep::WrapVara; }
        ...
    }
    launch.lock = true;                      // committed at the first await
    (launch.step, launch.clone())
});
let outcome = match step {
    GradStep::WrapVara => self.step_wrap(&launch, me, &gas).await,   // waits; continuation uses leftover caller gas
    ...
};
self.with_state_mut(|st| st.launch_mut(&token).lock = false);       // never reached if continuation traps
```

#### Data flow
- **Source:** attacker-chosen gas limit on a `Launchpad/Graduate` message (permissionless, no value)
- **Sink:** `launch.lock = true` persisted at service.rs:702; the matching clear at service.rs:726 never executes
- **Validation:** none. There is no minimum `gas_available()` check before the await, no gas reserved for the continuation, and no critical hook.

#### Reachability trace
`Graduate(token)` (any account; launch in `Ready`/`Graduating`/retryable `Failed`) → `with_state_mut` sets `lock = true` → `step_*().await` → waitlist → reply arrives / timeout → continuation runs out of gas → trap. After that, `Graduate` → `panic!("GraduationInProgress")` (line 681), `Unwind` → `panic!("GraduationInProgress")` (lines 793-794), and `Sell` → state is `Graduating`, so `panic!("NotTrading")`.

#### Impact
One cheap message permanently freezes a graduating launch with no way to recover. Graduation can never progress, the launch can never be unwound, and sells are closed. The full escrow (about the raise target in VARA, or the wrapped pool wVARA) and that launch's creator/protocol fee bookkeeping are stranded in the launchpad forever. Any griefer can do this to every launch the moment its curve sells out, and can front-run the keeper's own Graduate in the same block. `total_liabilities` stays inflated, which also reduces `free_balance` for the whole program.

#### Mitigations checked
- No `gstd::critical` hook, no `exec::system_reserve_gas`, and no `handle_signal` logic that restores state anywhere in `launchpad/app`. Searching for `critical|reserve|handle_signal` finds only comments.
- No admin or timeout-based escape hatch clears `lock` / `busy`. Every admin setter (`set_gas`, `set_addresses`, `set_limits`, …) touches only config. No exported method writes `lock = false` or `busy = None` outside the post-await code paths.
- The gtest suite cannot reproduce this: gtest messages are sent with plenty of gas and replies land in the same block (docs/audit/test-matrix.md:47). No test sends a gas-starved message to the launchpad.
- docs/audit/threat-model.md A2/A3 treat `busy`/`lock` as protection against interleaving but do not consider a continuation that never completes.

#### Recommendation
Make the continuation gas-safe and the lock self-healing:
1. Before the first await, require `exec::gas_available()` to exceed a configured minimum that covers the worst-case continuation plus waitlist rent for `reply_timeout` blocks. Panic before any state change otherwise.
2. Store the lock as `Option<(u32 /*block*/, MessageId)>` and let a later `Graduate`/`Unwind` take over a lock older than `reply_timeout + margin` blocks. The steps are already written to be idempotent and resumable.
3. And/or use `gstd::critical::set_hook` with a system reservation (`exec::system_reserve_gas`) to clear the lock in `handle_signal` when the message traps after an await.

---

### CANCELSAFETY-002 — Sell commits curve move and busy=Some(stuck=false) before await; starved continuation wedges launch (reconcile requires stuck=true)
- **Location:** `contracts/launchpad/launchpad/app/src/service.rs:600` (`sell`)
- **Bug class:** cancel-safety
- **Attack vector:** Remote
- **Exploitability:** Reliable
- **Also affects:** — (standalone primary)
- **FP verdict:** TRUE_POSITIVE — Verified sell sets busy=Some(stuck=false) and moves curve before await (service.rs:600); resolution only in continuation and reconcile requires stuck=true; same mechanism reproduced for Graduate
- **Severity rationale:** Any token holder can permanently brick a trading launch and lock all its escrowed VARA with one gas-starved Sell

#### Description
Before awaiting `Vft.TransferFrom`, `sell` applies the curve move (`virtual_vara`, `virtual_tokens`, `real_remaining`, `escrow`, `total_liabilities`) and sets `launch.busy = Some(pending)` with `pending.stuck = false`. The commit (`commit_trade` → `busy = None`), the revert, and `mark_stuck` all live in the continuation. The seller can send the message with only enough gas for the pre-await part and the send. The continuation then runs out of gas, or the message is evicted from the waitlist for lack of rent, and `busy` stays `Some` with `stuck = false` forever. The only recovery path, `reconcile`, explicitly requires `p.stuck` (`_ => panic!("NotStuck")`, line 632), so there is no way out.

#### Code
```rust
// service.rs:596-616
launch.virtual_vara -= U256::from(gross);
launch.virtual_tokens += amount;
launch.real_remaining += amount;
launch.escrow -= gross;
launch.busy = Some(pending.clone());   // stuck: false
st.settle(gross);
...
match wire::vft_transfer_from(token, seller, me, amount, &gas).await {   // continuation may never run
    Ok(true) => Ok(self.commit_trade(token, &pending)),
    Ok(false) | Err(..) => { self.with_state_mut(|st| revert_trade(st, token, &pending)); ... }
    Err(CallError::Timeout) => { self.with_state_mut(|st| mark_stuck(st, token)); ... }
}
// reconcile, service.rs:630-633
let pending = match &launch.busy { Some(p) if p.stuck => p.clone(), _ => panic!("NotStuck") };
```

#### Data flow
- **Source:** any token holder sends `Sell(token, amount, ..)` with a deliberately small gas limit. The amount can be tiny as long as `split.net > 0`, and tokens can be bought on the curve or the DEX.
- **Sink:** `launch.busy = Some(stuck=false)` persisted at service.rs:600; the code that resolves it is in the continuation and never runs
- **Validation:** no check on remaining gas, and `reconcile` refuses trades that are not marked stuck

#### Reachability trace
`Sell` → `with_state_mut` (curve moved, busy set) → `vft_transfer_from(..).await` → waitlist → continuation traps out of gas. After that, `Buy`/`check_buy` → `TradeInProgress`, `Sell` → `TradeInProgress` (line 561), `Graduate` → `TradeInProgress` (line 678), `Unwind` → `GraduationInProgress` (line 793), and `Reconcile` → `NotStuck`.

#### Impact
Any holder can permanently brick a trading (or aborted) launch for everyone else: no buys, no sells, no graduation, no unwind. All VARA escrowed for that curve is locked forever and token holders cannot exit. The VFT TransferFrom may also have executed, moving tokens to the launchpad while `escrow` was decremented and `total_liabilities` settled without anyone being paid. That leaves the accounting permanently inconsistent.

#### Mitigations checked
- No `gstd::critical` hook, no `exec::system_reserve_gas`, and no `handle_signal` logic that restores state anywhere in `launchpad/app`. Searching for `critical|reserve|handle_signal` finds only comments.
- No admin or timeout-based escape hatch clears `lock` / `busy`. Every admin setter (`set_gas`, `set_addresses`, `set_limits`, …) touches only config. No exported method writes `lock = false` or `busy = None` outside the post-await code paths.
- The gtest suite cannot reproduce this: gtest messages are sent with plenty of gas and replies land in the same block (docs/audit/test-matrix.md:47). No test sends a gas-starved message to the launchpad.
- docs/audit/threat-model.md A2/A3 treat `busy`/`lock` as protection against interleaving but do not consider a continuation that never completes.

#### Recommendation
Require a minimum `exec::gas_available()` before changing state, and make `busy` recoverable. Record the block at which the trade was opened and let `reconcile` treat any `busy` trade older than `reply_timeout + margin` as stuck; its balance-based resolution already handles that case. Alternatively, register a `gstd::critical` hook with a system reservation that sets `stuck = true` on trap.

---

### CANCELSAFETY-003 — run_buy commits curve move and busy before VFT transfer await; gas-starved buy wedges launch permanently
- **Location:** `contracts/launchpad/launchpad/app/src/service.rs:1076` (`run_buy`)
- **Bug class:** cancel-safety
- **Attack vector:** Remote
- **Exploitability:** Reliable
- **Also affects:** — (standalone primary)
- **FP verdict:** TRUE_POSITIVE — Verified apply_buy sets busy=Some(stuck=false) before vft_transfer await in run_buy (service.rs:1076); reconcile rejects non-stuck trades; same gas-starvation mechanism as reproduced CANCELSAFETY-001
- **Severity rationale:** For one min_trade_vara buy any account permanently bricks a trading launch and its escrow

#### Description
`run_buy` is reached from `buy` and from `launch`'s first buy. It calls `apply_buy`, which moves the curve, increases `escrow` and `total_liabilities`, and sets `launch.busy = Some(pending)` with `stuck = false`. It may also refund the sell-out excess via `pay` right away. Then it awaits `Vft.Transfer`, and all resolution (`commit_trade`, `revert_trade`, `mark_stuck`) is in the continuation. A buyer can attach `min_trade_vara` with a gas limit that leaves too little for the continuation or for waitlist rent. The continuation then traps or is evicted, `busy` stays `Some(stuck=false)` forever, and `reconcile` refuses it (`NotStuck`).

#### Code
```rust
// service.rs:1074-1093
let pending = self.with_state_mut(|st| apply_buy(st, token, buyer, &plan));   // busy = Some(stuck=false)
if refund > 0 { pay(buyer, refund); }
match wire::vft_transfer(token, buyer, pending.tokens, &gas).await {          // continuation may never run
    Ok(true) => Ok(self.commit_trade(token, &pending)),
    ... => { revert_trade(..); pay(buyer, pending.vara_gross); ... }
    Err(CallError::Timeout) => { mark_stuck(st, token); ... }
}
```

#### Data flow
- **Source:** `Buy(token, min_tokens_out, deadline)` from any account with `min_trade_vara` attached and a low gas limit
- **Sink:** `launch.busy` persisted by `apply_buy` (service.rs:179); resolution sits in the continuation of service.rs:1081
- **Validation:** no check on remaining gas

#### Reachability trace
`Buy` → `check_buy` → `run_buy` → `apply_buy` (busy set) → `vft_transfer(..).await` → continuation runs out of gas. After that, every `Buy`/`Sell`/`Graduate`/`Unwind` is rejected with `TradeInProgress`/`GraduationInProgress`, and `Reconcile` panics with `NotStuck`.

#### Impact
For the price of one minimum trade, an attacker permanently blocks a whole launch and locks its funds. The attacker may even receive the tokens if the Transfer executed. If the attacking buy is the one that sells out the curve, the excess refund has already been paid but the launch never reaches `Ready`, so the full raise is stranded. Escrow and liabilities stay inconsistent forever.

#### Mitigations checked
- No `gstd::critical` hook, no `exec::system_reserve_gas`, and no `handle_signal` logic that restores state anywhere in `launchpad/app`. Searching for `critical|reserve|handle_signal` finds only comments.
- No admin or timeout-based escape hatch clears `lock` / `busy`. Every admin setter (`set_gas`, `set_addresses`, `set_limits`, …) touches only config. No exported method writes `lock = false` or `busy = None` outside the post-await code paths.
- The gtest suite cannot reproduce this: gtest messages are sent with plenty of gas and replies land in the same block (docs/audit/test-matrix.md:47). No test sends a gas-starved message to the launchpad.
- docs/audit/threat-model.md A2/A3 treat `busy`/`lock` as protection against interleaving but do not consider a continuation that never completes.

#### Recommendation
Same as CANCELSAFETY-002: require a minimum `exec::gas_available()` before `apply_buy`, and let `reconcile` take over any `busy` trade older than `reply_timeout + margin` blocks (or set `stuck` from a `gstd::critical` hook on trap).

---

## HIGH (2)

### CANCELSAFETY-004 — Reconcile sets lock before balance query await; starved continuation leaves lock and stuck trade permanently unresolved
- **Location:** `contracts/launchpad/launchpad/app/src/service.rs:634` (`reconcile`)
- **Bug class:** cancel-safety
- **Attack vector:** Remote
- **Exploitability:** Difficult
- **Also affects:** — (standalone primary)
- **FP verdict:** TRUE_POSITIVE — Verified reconcile sets lock=true at service.rs:634 and clears only after vft_balance_of await; gas-starved Reconcile leaves lock held and stuck trade unresolvable
- **Severity rationale:** Same permanent-freeze impact as CANCELSAFETY-001 but requires a stuck (timed-out) trade to exist first, which the attacker cannot force

#### Description
`reconcile` is permissionless. When a trade is stuck, it sets `launch.lock = true`, awaits `Vft.BalanceOf`, and clears the lock only in the continuation (line 639). An attacker who calls `Reconcile(token)` with too little gas for the continuation (or for waitlist rent) leaves `lock = true` permanently. Every later `reconcile` then panics with `ReconcileInProgress`, the stuck `busy` trade can never be resolved, and trading, graduation and unwind all stay blocked.

#### Code
```rust
// service.rs:625-639
let pending = self.with_state_mut(|st| {
    let launch = st.launch_mut(&token);
    if launch.lock { panic!("ReconcileInProgress") }
    let pending = match &launch.busy { Some(p) if p.stuck => p.clone(), _ => panic!("NotStuck") };
    launch.lock = true;
    pending
});
let held = wire::vft_balance_of(token, me, &gas).await;          // continuation may never run
self.with_state_mut(|st| st.launch_mut(&token).lock = false);
```

#### Data flow
- **Source:** attacker-chosen gas limit on a permissionless `Reconcile` message
- **Sink:** `launch.lock = true` at service.rs:634; the clear at service.rs:639 is skipped
- **Validation:** none

#### Reachability trace
Any trade times out (the `TradeStuck` event is publicly visible) → the attacker front-runs the keeper with a gas-starved `Reconcile(token)` → `lock = true` persisted → `vft_balance_of(..).await` → continuation runs out of gas. After that, `reconcile` → `ReconcileInProgress`, and `buy`/`sell`/`graduate`/`unwind` are blocked by `busy`/`lock`.

#### Impact
Any temporary reply timeout becomes a permanent freeze of the launch and its escrow, including the buyer's stuck VARA. It requires a stuck trade to exist. The attacker cannot force one directly, but the design explicitly expects them to happen.

#### Mitigations checked
- No `gstd::critical` hook, no `exec::system_reserve_gas`, and no `handle_signal` logic that restores state anywhere in `launchpad/app`. Searching for `critical|reserve|handle_signal` finds only comments.
- No admin or timeout-based escape hatch clears `lock` / `busy`. Every admin setter (`set_gas`, `set_addresses`, `set_limits`, …) touches only config. No exported method writes `lock = false` or `busy = None` outside the post-await code paths.
- The gtest suite cannot reproduce this: gtest messages are sent with plenty of gas and replies land in the same block (docs/audit/test-matrix.md:47). No test sends a gas-starved message to the launchpad.
- docs/audit/threat-model.md A2/A3 treat `busy`/`lock` as protection against interleaving but do not consider a continuation that never completes.

#### Recommendation
Do not hold a lock across the query at all. The reconcile decision is checked against current state after the reply anyway, so a sequence check on `pending.seq` can replace the lock. Alternatively, make the lock expire after `reply_timeout + margin` blocks, and require a minimum `exec::gas_available()` before the await.

---

### CANCELSAFETY-005 — Unwind sets lock before wVARA await; starved continuation blocks both unwind and graduation forever
- **Location:** `contracts/launchpad/launchpad/app/src/service.rs:796` (`unwind`)
- **Bug class:** cancel-safety
- **Attack vector:** Remote
- **Exploitability:** Reliable
- **Also affects:** — (standalone primary)
- **FP verdict:** TRUE_POSITIVE — Verified unwind sets lock=true at service.rs:796 and clears only after unwind_wrapped await; gas-starved Unwind blocks unwind and graduate permanently
- **Severity rationale:** Permanently bricks the escape hatch and the launch escrow; precondition is a stale-Ready or early-Failed launch

#### Description
`unwind` becomes permissionless once a launch has sat in `Ready` past the timeout, or is `Failed` at an unwindable step. It sets `launch.lock = true` and then awaits `wvara_burn` / `vft_balance_of`. Both `lock = false` and the move to `Aborted` happen only in the continuation. A gas-starved `Unwind` message leaves the lock set permanently: further `Unwind` and `Graduate` calls panic with `GraduationInProgress`, and the state never reaches `Aborted`, so sells never reopen. If the continuation dies after a `wvara_burn` actually executed, the VARA is back in the program but `wrapped`, `escrow` and `wvara_expected` are never updated.

#### Code
```rust
// service.rs:783-801
let (launch, expected) = self.with_state_mut(|st| {
    ...
    if launch.lock || launch.busy.is_some() { panic!("GraduationInProgress") }
    launch.lock = true;
    (launch.clone(), expected)
});
let result = self.unwind_wrapped(&launch, me, expected, &gas).await;   // continuation may never run
self.with_state_mut(|st| st.launch_mut(&token).lock = false);
```

#### Data flow
- **Source:** attacker-chosen gas limit on a permissionless `Unwind` message
- **Sink:** `launch.lock = true` at service.rs:796; the clear at service.rs:801 is skipped
- **Validation:** none

#### Reachability trace
Launch sits in `Ready` for `graduation_timeout_blocks` (or is `Failed` at steps 1-4) → `Unwind` with low gas → lock persisted → `unwind_wrapped(..).await` → continuation runs out of gas → every recovery path is blocked.

#### Impact
One message bricks the recovery path that is meant to return pool VARA to escrow and reopen sells. The launch's entire escrow is locked permanently and holders can no longer sell.

#### Mitigations checked
- No `gstd::critical` hook, no `exec::system_reserve_gas`, and no `handle_signal` logic that restores state anywhere in `launchpad/app`. Searching for `critical|reserve|handle_signal` finds only comments.
- No admin or timeout-based escape hatch clears `lock` / `busy`. Every admin setter (`set_gas`, `set_addresses`, `set_limits`, …) touches only config. No exported method writes `lock = false` or `busy = None` outside the post-await code paths.
- The gtest suite cannot reproduce this: gtest messages are sent with plenty of gas and replies land in the same block (docs/audit/test-matrix.md:47). No test sends a gas-starved message to the launchpad.
- docs/audit/threat-model.md A2/A3 treat `busy`/`lock` as protection against interleaving but do not consider a continuation that never completes.

#### Recommendation
Same fixes as CANCELSAFETY-001: require a minimum `gas_available()` before taking the lock, use a block-stamped lock that expires and can be taken over after `reply_timeout + margin`, or register a `gstd::critical` hook with a system reservation that clears the lock on trap.

---

## MEDIUM (2)

### CANCELSAFETY-006 — AlignPrice swap that times out but executes leaves wvara/token budgets stale; AddLiquidity then fails forever at a non-unwindable step
- **Location:** `contracts/launchpad/launchpad/app/src/service.rs:1250` (`step_align_price`)
- **Bug class:** cancel-safety
- **Attack vector:** Remote
- **Exploitability:** Difficult
- **Also affects:** — (standalone primary)
- **FP verdict:** LIKELY_TP — Verified budgets updated only after swap reply (service.rs:1250-1272), aligned-pool early return on retry, add_liquidity sizes from stale wvara_budget, AddLiquidity not unwindable; trigger needs a swap reply timeout
- **Severity rationale:** Requires a reply timeout the attacker can encourage but not force; stuck graduation, and stale wVARA budget may also draw on other launches' pooled wVARA

Details: `findings/CANCELSAFETY-006.md`

---

### RESEXHAUST-001 — Unbounded growth of launches/launch_order/names/pending_payouts and full-vector `launches` query
- **Location:** `contracts/launchpad/launchpad/app/src/service.rs:484` (`launch`)
- **Bug class:** resource-exhaustion
- **Attack vector:** Remote
- **Exploitability:** Difficult
- **Also affects:** — (standalone primary)
- **FP verdict:** LIKELY_TP — Verified append-only launches/launch_order/names/pending_payouts and unpaginated launches() query; growth is sybil-driven and costly
- **Severity rationale:** Remote DoS requiring large allocation/sybil cost; unpaginated query degrades sooner, memory exhaustion would freeze the whole program

Details: `findings/RESEXHAUST-001.md`

---

## LOW (11)

### ARITHOFL-002 — Unchecked u32 `ready_at + graduation_timeout_blocks` in unwind panics when the timeout is large
- **Location:** `contracts/launchpad/launchpad/app/src/service.rs:788` (`unwind`)
- **Bug class:** arithmetic-overflow
- **Attack vector:** Remote
- **Exploitability:** Theoretical
- **Also affects:** — (standalone primary)
- **FP verdict:** LIKELY_TP — Verified u32 ready_at + timeout at service.rs:788 with no bound in set_limits; panics only if admin sets a near-u32::MAX timeout, pre-await so it reverts cleanly
- **Severity rationale:** Needs a pathological admin timeout value; consequence is loss of the stale-Ready unwind hatch, no state corruption

Details: `findings/ARITHOFL-002.md`

---

### ASSERTREACH-001 — curve_params_for panics after the spawn await in launch (zero-value path never pre-validates config)
- **Location:** `contracts/launchpad/launchpad/app/src/service.rs:439` (`launch`)
- **Bug class:** assertion-reachable
- **Attack vector:** Remote
- **Exploitability:** Theoretical
- **Also affects:** — (standalone primary)
- **FP verdict:** LIKELY_TP — Verified: curve_params_for (panic! / unchecked sub) runs after the spawn await at service.rs:439 and is pre-validated only when value != 0; triggers only under inconsistent admin config
- **Severity rationale:** Requires admin misconfiguration (raise target net below graduation fee); impact is burned names, orphaned VFTs and reserve ED drain

Details: `findings/ASSERTREACH-001.md`

---

### CANCELSAFETY-007 — Launch reserves name and cooldown before spawn await; trap after await strands creator value and leaves name reserved with no launch
- **Location:** `contracts/launchpad/launchpad/app/src/service.rs:385` (`launch`)
- **Bug class:** cancel-safety
- **Attack vector:** Remote
- **Exploitability:** Reliable
- **Also affects:** — (standalone primary)
- **FP verdict:** LIKELY_TP — Verified name/cooldown reserved before spawn await with rollback only in continuation; gas-starved Launch mainly harms the caller (own value/name), orphans a VFT and spends reserve ED
- **Severity rationale:** Self-inflicted value loss plus name squatting and orphaned VFT; negligible third-party impact

Details: `findings/CANCELSAFETY-007.md`

---

### CARGOLINT-001 — Workspace declares no lint policy (no forbid(unsafe_code), no deny(unused_must_use))
- **Location:** `contracts/launchpad/Cargo.toml:1` (`n/a`)
- **Bug class:** cargo-lint-config
- **Attack vector:** Remote
- **Exploitability:** Theoretical
- **Also affects:** — (standalone primary)
- **FP verdict:** TRUE_POSITIVE — Verified no [workspace.lints] or crate-level lint attributes in contracts/launchpad/Cargo.toml; hardening gap
- **Severity rationale:** Defense-in-depth: missing lint policy, no direct exploit

Details: `findings/CARGOLINT-001.md`

---

### MSRV-001 — No rust-version declared; toolchain pinned only via rust-toolchain.toml
- **Location:** `contracts/launchpad/Cargo.toml:5` (`n/a`)
- **Bug class:** msrv-mismatch
- **Attack vector:** Remote
- **Exploitability:** Theoretical
- **Also affects:** — (standalone primary)
- **FP verdict:** TRUE_POSITIVE — Verified [workspace.package] has no rust-version; toolchain pinned only via rust-toolchain.toml; hardening/reproducibility gap
- **Severity rationale:** Defense-in-depth: build reproducibility, no direct exploit

Details: `findings/MSRV-001.md`

---

### RESDISC-001 — Sell-out excess refund send result discarded; sub-ED refund silently lost and left untracked
- **Location:** `contracts/launchpad/launchpad/app/src/service.rs:1079` (`run_buy`)
- **Bug class:** result-discarded
- **Attack vector:** Remote
- **Exploitability:** Theoretical
- **Also affects:** — (standalone primary)
- **FP verdict:** TRUE_POSITIVE — Loss mechanism refuted: orchestrator PoC poc_resdisc_001_sub_ed_refund_is_not_lost shows gear 1.10 does not reject sub-ED sends (charge_message_value checks only value_counter; InsufficientValue is builtin-actor only), and the sub-ED refund was delivered. Residual valid observation is a hardening gap: send result at service.rs:1079 is dropped with no pending_payouts fallback if a send ever fails for another reason
- **Severity rationale:** Defense-in-depth: no realistic send-failure path found after PoC refuted the sub-ED premise; residual risk is untracked value if msg send fails for other causes

Details: `findings/RESDISC-001.md`

---

### RESDISC-002 — Refund after failed VFT transfer ignores send result; buyer's gross is lost on send failure
- **Location:** `contracts/launchpad/launchpad/app/src/service.rs:1085` (`run_buy`)
- **Bug class:** result-discarded
- **Attack vector:** Remote
- **Exploitability:** Theoretical
- **Also affects:** — (standalone primary)
- **FP verdict:** TRUE_POSITIVE — Loss mechanism refuted: orchestrator PoC poc_resdisc_001_sub_ed_refund_is_not_lost shows gear 1.10 does not reject sub-ED sends (charge_message_value checks only value_counter; InsufficientValue is builtin-actor only), and the sub-ED refund was delivered. Residual valid observation is a hardening gap: send result at service.rs:1085 is dropped with no pending_payouts fallback if a send ever fails for another reason
- **Severity rationale:** Defense-in-depth: no realistic send-failure path found after PoC refuted the sub-ED premise; residual risk is untracked value if msg send fails for other causes

Details: `findings/RESDISC-002.md`

---

### RESDISC-003 — Reconcile revert refund ignores send result after liability is settled
- **Location:** `contracts/launchpad/launchpad/app/src/service.rs:656` (`reconcile`)
- **Bug class:** result-discarded
- **Attack vector:** Remote
- **Exploitability:** Theoretical
- **Also affects:** — (standalone primary)
- **FP verdict:** TRUE_POSITIVE — Loss mechanism refuted: orchestrator PoC poc_resdisc_001_sub_ed_refund_is_not_lost shows gear 1.10 does not reject sub-ED sends (charge_message_value checks only value_counter; InsufficientValue is builtin-actor only), and the sub-ED refund was delivered. Residual valid observation is a hardening gap: send result at service.rs:656 is dropped with no pending_payouts fallback if a send ever fails for another reason
- **Severity rationale:** Defense-in-depth: no realistic send-failure path found after PoC refuted the sub-ED premise; residual risk is untracked value if msg send fails for other causes

Details: `findings/RESDISC-003.md`

---

### RESDISC-004 — First-buy-skipped refund in launch ignores send result after spawn await
- **Location:** `contracts/launchpad/launchpad/app/src/service.rs:514` (`launch`)
- **Bug class:** result-discarded
- **Attack vector:** Remote
- **Exploitability:** Theoretical
- **Also affects:** — (standalone primary)
- **FP verdict:** TRUE_POSITIVE — Loss mechanism refuted: orchestrator PoC poc_resdisc_001_sub_ed_refund_is_not_lost shows gear 1.10 does not reject sub-ED sends (charge_message_value checks only value_counter; InsufficientValue is builtin-actor only), and the sub-ED refund was delivered. Residual valid observation is a hardening gap: send result at service.rs:514 is dropped with no pending_payouts fallback if a send ever fails for another reason
- **Severity rationale:** Defense-in-depth: no realistic send-failure path found after PoC refuted the sub-ED premise; residual risk is untracked value if msg send fails for other causes

Details: `findings/RESDISC-004.md`

---

### RESDISC-005 — Spawn-failure refund in launch ignores send_value result
- **Location:** `contracts/launchpad/launchpad/app/src/service.rs:434` (`launch`)
- **Bug class:** result-discarded
- **Attack vector:** Remote
- **Exploitability:** Theoretical
- **Also affects:** — (standalone primary)
- **FP verdict:** TRUE_POSITIVE — Loss mechanism refuted: orchestrator PoC poc_resdisc_001_sub_ed_refund_is_not_lost shows gear 1.10 does not reject sub-ED sends (charge_message_value checks only value_counter; InsufficientValue is builtin-actor only), and the sub-ED refund was delivered. Residual valid observation is a hardening gap: send result at service.rs:434 is dropped with no pending_payouts fallback if a send ever fails for another reason
- **Severity rationale:** Defense-in-depth: no realistic send-failure path found after PoC refuted the sub-ED premise; residual risk is untracked value if msg send fails for other causes

Details: `findings/RESDISC-005.md`

---

### STRCMP-001 — name_taken query canonicalises names differently from launch's uniqueness key
- **Location:** `contracts/launchpad/launchpad/app/src/service.rs:978` (`name_taken`)
- **Bug class:** string-comparison
- **Attack vector:** Remote
- **Exploitability:** Reliable
- **Also affects:** — (standalone primary)
- **FP verdict:** TRUE_POSITIVE — Verified name_taken uses trim().to_lowercase() while launch collapses inner whitespace with to_ascii_lowercase; query-only mismatch, launch remains authoritative
- **Severity rationale:** Advisory query returns wrong answer; no fund or state impact

Details: `findings/STRCMP-001.md`

---

## Scope notes
- Scope is contracts/launchpad only. launchpad/tests/, tests-wasm/, target/, vendor/vara-amm and awesome-sails are excluded (context only).
- Run note: the output directory was moved mid-run. The coverage files of workers 1, 3-6, 8-10 and 12-15 were lost. STRCMP-001, CARGOLINT-001 and MSRV-001 were recreated from the worker reports.
- Dedup: 19 findings in, 19 primaries, no merges. Related groups: cancel-safety (CANCELSAFETY-001..007), discarded send results (RESDISC-001..005), and panicking post-await arithmetic (ARITHOFL-001/002). One fix design covers all of CANCELSAFETY-001..007: a gas floor before pre-await state changes, block-stamped lock/busy flags that expire, and/or a gstd critical hook with a system reservation.
- Config-dependent findings (ARITHOFL-002, ASSERTREACH-001) are kept as LOW. They need inconsistent or pathological on-chain admin configuration.

## Artifacts
- `findings/*.md` — individual finding files (frontmatter carries `fp_verdict`, `severity`, `merged_into`, `also_known_as`)
- `fp-summary.md` — FP-judge summary
- `dedup-summary.md` — dedup summary
- `REPORT.sarif` — SARIF 2.1.0 machine-readable export of the same findings
