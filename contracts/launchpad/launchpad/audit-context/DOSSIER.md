# Launchpad (Tokenator Curve Launch): System Dossier

Scope: `contracts/launchpad/launchpad/app/src/{lib.rs,state.rs,curve.rs,wire.rs,service.rs}` (2331 lines).
This is a context model, not a findings list. It describes structure, invariants and assumptions. An
"unenforced assumption" means nothing in the mapped code establishes it. It is not a claim that it is false.

Per-function records live in three directories (the orchestration wrote them to different roots):
- `contracts/launchpad/launchpad/audit-context/functions/` (01 graduate, 02 commit_trade, 03 step_settle, 04 step_add_liquidity, 05 step_align_price, 09 run_buy, 10 sell, 11 reconcile, 12 apply_buy/revert_trade)
- `contracts/launchpad/audit-context/functions/` (07 unwind, 08 plan_buy, plus older duplicates of several functions)
- `/Users/adityakrx/VFT-Portal-DApp/audit-context/functions/` (06 step_wrap, 05 sell older copy)

Line numbers below are for `app/src/service.rs` unless prefixed.

---

## 1. Context for the two design questions in the user request

The user asked: (1) how "all VARA raised goes into the pool" fits with "liquidity is added at the curve's
final price", and how the planned ~$50 creator / ~$50 RivrDEX split of the leftover would fit; (2) what
happens if the keeper goes down. This section is the structural model those questions sit on, as
implemented today. Design choices belong to the owner, so this section does not recommend one.

### 1.1 How the raise, the final price and the pool are tied together today

- `curve_params_for` (L239-L251) works at config time:
  - `net = split_fee(raise_target_vara).net` (gross target minus the trade fee)
  - `pool_vara_cfg = net - graduation_fee_vara`, which panics `RaiseBelowGraduationFee` if negative
  - `pool_tokens = total_supply - curve_supply`
  - `derive_params(net_raise = net, pool_vara = pool_vara_cfg, curve_supply, pool_tokens)` (curve.rs L24-L44)
- `derive_params` solves v0/t0 so that (a) selling exactly `curve_supply` nets `net` VARA into escrow, and
  (b) the curve's final spot price `(v0 + net) / a` equals `pool_vara_cfg / pool_tokens`. So the design
  already prices the pool at the curve's final price using `net - graduation_fee`, not the full escrow.
  It returns None (the config panics with `CurveParams`) when the pool would open below the curve's average price.
- `commit_trade` (L1109) recomputes at sell-out: `pool_vara = escrow.saturating_sub(graduation_fee)`.
  This overwrites the launch-time `pool_vara` (L456). In practice escrow at sell-out differs from the
  calibrated `net` (floor rounding in buy_tokens_out/sell_vara_out, the ceil cost on the capped last buy,
  and the fee-rounding slack kept in escrow at plan_buy L144-L146). So the realised pool VARA, and therefore the
  pool's opening price, drifts from the designed one by that difference. AlignPrice/AddLiquidity
  (1%/2% tolerances) then work against `pool_vara / pool_tokens` as recomputed, not the config value.
- The rest of escrow (`graduation_fee`) stays in escrow through graduation. At Settle (L1386-L1396):
  - `pair_fee = pair_created_by_us ? min(pair_creation_fee, escrow) : 0`, which covers the pair creation
    fee paid earlier from the program's free reserve (step 2)
  - `protocol_fees += escrow - pair_fee + recovered` (recovered = burned wVARA surplus over global `wvara_expected`)
  - No creator share of the graduation fee exists. `creator_fees` is written only by commit_trade
    L1101 (per-trade fee) and claim_creator_fees L840. No "RivrDEX share" exists as a separate recipient
    beyond `pair_creation_fee` paid to the factory. All of it goes to `protocol_fees`, which is paid to
    `launch.addrs.treasury` by permissionless `claim_protocol_fees`.
- Mapping to the user's plan: "pool gets the amount matching the final price" corresponds to
  `pool_vara = escrow - graduation_fee` plus the derive_params calibration. "~$100 left over" corresponds
  to `graduation_fee_vara` (a fixed VARA amount, not USD). "~$50 to RivrDEX" has a partial counterpart
  in `pair_creation_fee` (only when we create the pair). "~$50 to creator at graduation" has no counterpart.
- Related constraints: `set_fees` enforces `graduation_fee >= pair_creation_fee` (L1018) but only for later
  changes. The constructor (`lib.rs` L25) does not validate Config. Each Launch snapshots
  `graduation_fee`/`pair_creation_fee` at launch (L457-L458).

### 1.2 Who drives graduation today

- The last buy (`commit_trade`, L1104-L1118) only sets `state = Ready`, `ready_at`, `pool_vara`, budgets
  and emits `Event::Ready`. It does not run any graduation step. `run_buy` ignores `plan.completes_curve`.
- `graduate` is already permissionless (`#[export]`, no caller check, L669). Each call runs exactly one
  `GradStep` (12 steps: WrapVara, FindOrCreatePair, ApproveToken, ApproveWvara, AlignPrice, AddLiquidity,
  BurnLp, RevokeMinter, RevokeBurner, RevokeAdmin, Settle, Done). Each step awaits at least one external
  program, so a full graduation takes about 11 or more separate messages. The doc comment (L668) assumes an off-chain keeper loops it.
- If nobody calls graduate:
  - Ready: after `graduation_timeout_blocks` anyone may `unwind` → Aborted (sells reopen at frozen curve,
    buys closed for good).
  - Graduating (between steps): no timeout and no unwind path (unwind gate L787-L792 accepts only Ready/Failed).
    The launch waits until someone calls graduate again.
  - Failed at WrapVara..ApproveWvara: anyone may unwind (no timeout on this branch) or retry graduate.
  - Failed at AlignPrice or later: only graduate retry (always retryable, see 3.4). No unwind.
- Anyone can already trigger graduation once sold out. The operational dependency is on someone sending
  the roughly 11 follow-up messages, not on permission. Gear async constraints (one reply per await, one
  step per message so a failure persists the step) are why the steps are split. Inlining into the last buy
  would put the buyer's message on the hook for all external awaits and their failure modes.

---

## 2. Actors and trust boundaries

| Actor | Trust | Entrypoints | What it reaches |
|---|---|---|---|
| Trader (any account) | untrusted | `buy` (payable), `sell`, `quote_*`, queries | Curve reserves, escrow, total_liabilities, PendingTrade, VFT Transfer/TransferFrom, native sends (refunds, seller payouts), pending_payouts; the sell-out buy flips Ready |
| Creator | untrusted | `launch` (payable first buy), `claim_creator_fees` | VFT program spawn (admin code_id), names/cooldown maps, a new Launch with snapshotted addrs/fees; creator_fees payout |
| Graduation caller / keeper (anyone) | untrusted | `graduate`, `unwind`, `reconcile` | Every external program (wVARA mint/burn, Factory CreatePair paid from reserve, Pair swap/addLiquidity, LP transfer, VFT role revocation), global `wvara_expected`, total_liabilities, lock |
| Anyone | untrusted | `claim_protocol_fees` (pays treasury), `claim_payout` (own), `top_up_reserve` (payable) | protocol_fees → treasury; free balance |
| Admin | trusted | `set_raise_target/addresses/gas/vft_code_id/fees/limits/admin/paused_buys` | Config for future launches; `gas` and `graduation_timeout_blocks`, `min_*`, `paused_buys` are read live by existing launches |
| Treasury | trusted | (recipient only) | protocol_fees |
| Spawned VFT | semi-trusted | replies to Transfer/TransferFrom/BalanceOf/Approve/role queries/Revoke | Decides trade commit vs revert, reconcile branch, roles_renounced |
| RivrDEX Factory / Pair / LP | semi-trusted | replies to GetPair/CreatePair/GetTokens/GetReserves/GetAmountOut/Swap/AddLiquidity/LP BalanceOf/Transfer | Pair address, token order, reserves driving AlignPrice/AddLiquidity sizing and resume detection |
| wVARA VftNativeExchange | semi-trusted | replies to Mint/Burn/BalanceOf/Approve | Global wVARA balance used for mint-skip, unbooked-mint detection, settle surplus |
| Third party on the pair | untrusted | direct RivrDEX calls (pre-create pair, seed, swap, donate tokens/wVARA to launchpad) | Pair reserves between steps; launchpad's wVARA/token balances that the code reads in aggregate |
| Reply handlers (implicit) | n/a | any await resumes | Interleaving: every await lets other messages run, including other launches' graduations |

Key boundary property: one program custodies all launches' VARA, wVARA, tokens and LP. Balances read
from external programs are program-wide aggregates, while bookkeeping is per-launch, except
`wvara_expected` and `total_liabilities`, which are global scalars.

---

## 3. State model: who reads and writes what, and cross-function invariants

### 3.1 Liability accounting (`State.total_liabilities`)

Writers: apply_buy (+net L180), commit_trade (+fees L1131), pay_seller (+net if deferred), sell (−gross L601),
revert_trade (Buy −net / Sell +gross), step_wrap (−pool_vara L1187), step_settle (−pair_fee +recovered),
unwind_wrapped (+pool_vara L1412), claim_* (−paid).

Cross-function invariant (derived): for each launch outside a pending trade,
`contribution = escrow + creator_fees_unclaimed + protocol_fees_unclaimed` (+ pending_payouts globally).
The supporting evidence: Buy nets +gross_used across apply+commit (records 02, 09, 12). Sell nets −gross+fee.
step_wrap moves pool_vara out of escrow and out of liabilities together (L1187-L1190). unwind_wrapped is
its exact inverse (L1406-L1413). Settle zeroes escrow into protocol_fees, minus pair_fee, which leaves liabilities because
it was paid from reserve earlier, plus recovered.
- During a pending trade the contribution deviates: a Buy has +net owed and fees unbooked. A Sell has
  liabilities reduced by gross before the seller is paid. Readers of `free_balance` during awaits
  (L369-L373, L973, L1063) see the transient value (record 10).
- Between Wrap and AddLiquidity, the VARA is held as wVARA tracked by `wvara_expected`, not by liabilities.
- `owe`/`settle` are checked and panic. `overflow-checks = true` in `contracts/launchpad/Cargo.toml` L23,
  so plain u128 `+`/`-` also panic. Records 02, 03, 06, 09 and 10 list this as "unclear / need to inspect",
  while records 07 and 12 cite Cargo.toml L23. This dossier confirms that L23 sets it: arithmetic
  panics, it does not wrap.

### 3.2 Curve state (`virtual_vara`, `virtual_tokens`, `real_remaining`, `escrow`)

Writers: apply_buy, sell, revert_trade (and step_wrap/step_settle/unwind_wrapped for escrow only).
- I-curve-1: `virtual_tokens - real_remaining == a > 0` across buy/sell/revert (records 08, 12).
- I-curve-2: `escrow == virtual_vara - v0` while Trading/Aborted (record 08). It breaks deliberately at
  step_wrap (escrow −= pool_vara without touching virtual_vara) and is restored by unwind_wrapped. After
  Aborted, sells pay from escrow that still includes graduation_fee, and gross <= escrow is checked at L568.
- I-curve-3: Ready is written only when a Buy commit leaves `real_remaining == 0` (L1104), and only
  plan_buy's sell-out branch (L142) can make real_remaining 0.
- revert_trade restores absolute snapshots. Its correctness relies on no other escrow writer running while
  `busy` is Some. That is enforced by busy checks in check_buy L215, sell L561, graduate L678 and unwind L793.
  Claims and admin setters do not check busy, but they do not write curve/escrow.

### 3.3 Mutual exclusion (`busy`, `lock`)

- `busy: Option<PendingTrade>` is set by apply_buy/sell before the single VFT await. It is cleared by commit_trade
  (L1103) or revert_trade (L195). mark_stuck sets `stuck = true`, and only reconcile (requires stuck) resolves it.
- `lock: bool` is set by graduate (L702), unwind (L796) and reconcile (L634) inside a synchronous closure. It is cleared
  by graduate L726, unwind L801 and reconcile L639, each in the post-await continuation.
- Cross-function invariant (derived): busy and lock are each checked by every other entrypoint that
  mutates the same launch's curve or graduation state, so at most one such message per launch is in flight.
  They are not checked by claims or admin setters, and are not per-program, so different launches interleave freely.
- Cross-function dependency: both flags are cleared only by post-await code of the same function. Every
  record carries the open question of whether a trap in a post-await segment leaves the pre-await write
  (`lock = true` / `busy = Some(stuck=false)`) persisted. No signal/critical hook or admin reset exists in app/src.
  If the earlier write persists, the launch has no in-code recovery path. Records 01, 02, 06, 07, 09, 10 and 11 list
  this as unresolved.

### 3.4 Graduation state machine (`state`, `step`, `fail_reason`, `fail_retryable`, `ready_at`)

- LaunchState: Trading → Ready (commit_trade) → Graduating (graduate) ⇄ Failed (graduate) → Graduated (with step=Done).
  Ready or Failed(unwindable) → Aborted (unwind). Aborted is terminal (graduate panics NotGraduating). Sells are allowed in Trading and Aborted.
- Step advances only on Ok (L731-L735). On Err the step stays and state = Failed, retryable.
- `CallError::is_retryable` is always true (wire.rs L33-L35), so `NotRetryable` (L690) is unreachable via
  service.rs writes. The only `fail_retryable = false` write is the init value at L477 (record 01).
- Ready → Graduating always restarts at WrapVara (L685-L688). A Failed retry at AddLiquidity with
  `!liquidity_added` rewinds to AlignPrice (L696-L698).
- `is_unwindable` (state.rs L105-L113) = {WrapVara, FindOrCreatePair, ApproveToken, ApproveWvara}.
  The state.rs:52 doc comment says "Ready or Failed" with a timeout. The code applies the timeout only to Ready
  (L787-L789). Record 01 raises this mismatch and record 07 confirms the code shape.
- Disagreement between records: record 01 lists the Done arm at L724/L727 as possibly unreachable (no
  writer sets step=Done without Graduated), and no other record addresses it. It is carried as open.

### 3.5 Pool sizing (`pool_vara`, `wvara_budget`, `token_budget`, `pool_tokens`)

- pool_vara: written at launch L456 (config-derived) and overwritten at Ready L1109 (`escrow - graduation_fee`,
  saturating). It is not rewritten after that, and record 07 asks to confirm this for unwindable steps.
- wvara_budget/token_budget: set at Ready to pool_vara/pool_tokens and rewritten by step_align_price (L1268-L1272)
  using `min_out` (98% of a quote), not realised output.
- step_add_liquidity sizes `amount_w <= min(wvara_budget, pool_vara)`, `amount_t <= token_budget`.
- Cross-function invariant (derived): `pool_vara` is the single number shared by step_wrap (escrow −, wvara_expected +),
  mark_liquidity_added (wvara_expected −), unwind_wrapped (escrow +, wvara_expected −) and step_add_liquidity
  (divisor, cap). The amount actually deposited (`amount_w`) is allowed to be smaller. The gap is absorbed only by
  step_settle's aggregate `held - wvara_expected` surplus burn, which goes to protocol_fees.
- `pool_vara > 0` is a divisor precondition (L1287, align path L1240/L1254). Nothing at L1109 enforces it.
  Config-time `net >= graduation_fee` (L241-L243) is the closest guard (records 01, 02, 04, 05, 06).

### 3.6 Global wVARA accounting (`State.wvara_expected`)

- Doc (state.rs L220): "wVARA the program holds for launches that wrapped but have not added liquidity yet."
- Writers: step_wrap +pool_vara (after the mint reply), mark_liquidity_added −pool_vara (saturating),
  unwind_wrapped −pool_vara (saturating).
- Readers that take `held - wvara_expected` as belonging to the current launch:
  step_wrap (mint skip if held >= expected + pool_vara, L1181), unwind_wrapped branch B (unbooked mint detection),
  step_settle (surplus burn to protocol_fees).
- Cross-function property (derived): this attribution is sound only if every wVARA movement in or out of the
  program is mirrored in wvara_expected at the same instant. The records list the movements that are not mirrored:
  other launches' mint-reply-before-booking windows, AlignPrice swaps (wVARA in/out), amount_w < pool_vara
  deposits, settle burns, and third-party transfers to the program. Concurrent graduations of different launches
  are not excluded by any lock.
- Record 07 notes unwind snapshots `expected` before its balance await (L784). Record 06 notes step_wrap reads
  `expected` after its await (L1180). So the two readers sample the global at different points relative to their own awaits.

### 3.7 Fees and payouts

- creator_fees/protocol_fees: += per trade at commit (split of fee_bps, creator_fee_bps snapshotted at launch).
  protocol_fees += graduation leftover at Settle. They are paid by claim_creator_fees (creator only) and claim_protocol_fees (anyone → treasury).
- pending_payouts: sub-ED or failed-enqueue seller proceeds (pay_seller L293-L299), claimed by claim_payout.
- `send_value` (wire.rs L286-L291) sends with gas 0, and `true` means only that the message was enqueued. Buyer refunds
  (L1079, L1085, L656) discard the bool, after liabilities were already settled for the refunded amount.

### 3.8 Admin config and live reads

- Snapshotted per launch: addrs (incl. treasury, wvara, factory, lp_dead), fee_bps, creator_fee_bps, graduation_fee,
  pair_creation_fee, curve params, pool_tokens.
- Read live: `config.gas` (every async entrypoint, via `self.gas()` L276-L278), `graduation_timeout_blocks` (unwind),
  `min_trade_vara`, `min_free_balance`, `paused_buys`, `vft_code_id`, `raise_target_vara` (future launches).
- `set_limits` does not bound `graduation_timeout_blocks`, so `ready_at + timeout` (L788) can overflow-panic for
  large values, and 0 lets unwind compete with graduate in the Ready block (record 07).
- Constructor `new(config)` does not validate fee_bps < 10000, creator_fee_bps <= fee_bps, or
  graduation_fee >= pair_creation_fee. `set_fees` validates them for later changes only. No writer of
  `pair_creation_fee_vara` after init was found in service.rs by grep. Whether set_addresses carries it is not traced.

---

## 4. End-to-end flows

### 4.1 Launch
`launch` (payable): checks name/cooldown/LowReserve, spawns VFT from admin `vft_code_id` (await), seeds balance
(initial_supply to launchpad as admin per fungible-token vft/mod.rs L70-L72), builds the Launch from config with `pool_vara`
at its config value, and optionally runs `run_buy` with the attached value as the creator's first buy (its result is discarded with `let _`, L511).

### 4.2 Buy
check_buy (state Trading, not paused, not busy/locked, slippage, tokens_out != 0) → plan_buy → run_buy:
refund excess (send, bool ignored) → apply_buy (curve move, escrow += net, busy, owe(net)) → await VFT Transfer →
- Ok(true): commit_trade (fees, busy=None, maybe Ready)
- Ok(false)/Send/Reply/Decode: revert_trade + refund gross_used (bool ignored)
- Timeout: mark_stuck → later reconcile

### 4.3 Sell
Trading or Aborted, non-payable → compute gross/split, check gross <= escrow → curve move, escrow −= gross, settle(gross), busy →
await VFT TransferFrom (needs prior approve) → commit (fees, pay_seller or defer) / revert (owe gross back) / mark_stuck.

### 4.4 Reconcile
Requires busy.stuck, lock set → await VFT BalanceOf(launchpad) →
`held == real_remaining + pool_tokens` → commit. `held == prev_real_remaining + pool_tokens` → revert (+ buyer refund).
Any other value → Unreconcilable (busy stays). There is no other clearing path. The branch is decided by the aggregate balance only (record 11).

### 4.5 Graduation (one step per graduate message)
1. WrapVara: balance check (mint-skip heuristic) → Mint(pool_vara) with value → book escrow −, liabilities −, wvara_expected +, wrapped.
2. FindOrCreatePair: GetPair, else CreatePair (fee from reserve) → GetTokens → pair, wvara_is_token0, pair_created_by_us.
3. ApproveToken (pool_tokens) / 4. ApproveWvara (pool_vara) to pair: the returned bool is ignored.
5. AlignPrice: if the pair has non-zero reserves off by >1% from pv/pt, swap up to half a budget. Budgets are rebooked by min_out.
6. AddLiquidity: skip the 2% price check if either reserve is zero. Resume detection compares reserves to `pre_add_reserves` (≥95% growth).
   Approve again → AddLiquidity → mark_liquidity_added (wvara_expected −= pool_vara).
7. BurnLp: transfer the entire LP balance to lp_dead.
8-10. RevokeMinter/Burner/Admin: revoke only if the launchpad is listed.
11. Settle: role snapshot → burn the wVARA surplus over the global expected → leftover tokens to lp_dead →
    escrow (graduation_fee) − pair_fee + recovered → protocol_fees, escrow = 0 → state Graduated, step Done.

### 4.6 Unwind
Gate: stale Ready (timeout) or Failed at an unwindable step, and no lock/busy. If wrapped: Burn(pool_vara) → inverse booking.
If not wrapped: if the wVARA balance exceeds the expected snapshot by >= pool_vara, burn it (unbooked mint), else no-op → state Aborted.
Approvals to the pair are not revoked. The pair creation fee is not recovered.

---

## 5. Fragility clusters (where complexity concentrates)

1. Global wVARA attribution (`wvara_expected` vs aggregate balance) shared by step_wrap, unwind_wrapped, step_settle, mark_liquidity_added, across concurrent launches.
2. Post-await trap persistence of `lock`/`busy`: every async entrypoint sets a flag pre-await and clears it post-await, with no reset path.
3. Timeout semantics for every external call: Mint with value, CreatePair with fee, Swap, AddLiquidity, Burn, Transfer/TransferFrom. Timeout does not cancel the message, and recovery relies on balance or reserve heuristics.
4. AlignPrice ⇄ AddLiquidity loop: U256 math on external reserves (div by rw_target, pt, pool_vara), min_out bookkeeping, a rewind that can change recomputed amounts used by resume detection, and third-party movement of the pair between steps.
5. Escrow and pool_vara drift: realised sell-out escrow vs the calibrated net_raise, saturating `escrow - graduation_fee`, graduation_fee vs pair_creation_fee, and the leftover routing that is entirely to protocol.
6. Liveness of multi-message graduation: no on-chain driver, no timeout or unwind from Graduating or from Failed at AlignPrice or later.
7. Reconcile exact-equality on the aggregate VFT balance: unsolicited transfers, pair allowance spending in Aborted, and late execution of the timed-out message.
8. Native value sends with gas 0 and ignored bools for refunds, after liabilities are already settled.
9. Unvalidated constructor config and live-read admin knobs (gas, timeout) during an in-flight graduation.

---

## 6. Unenforced assumptions (verbatim from the per-function records; established by nothing)

graduate:
- No panic or out-of-gas occurs between the first await and L726. Otherwise lock=true persists with no other clearing path. Candidates: settle underflow L1187/L1395, owe L1396, escrow -= L1190, U256 mul/div in align L1233-L1259 (div by rw_target L1254), div by pool_vara L1287, expect at L1267
- pool_vara > 0 at graduation, since it is a divisor after awaits (L1287, L1240/L1254 path)
- The launchpad's wVARA balance minus the global wvara_expected is attributable to the current launch (used by WrapVara mint-skip and Settle recovered burn)
- vft_approve success means the allowance was set (the returned bool is ignored)
- The pair returned by the factory actually trades {wvara, token}
- The AlignPrice swap moved the price into tolerance and the budgets reflect the actual received amounts
- The AddLiquidity resume detection uses the same amounts as the original send
- The LP balance burned is the LP minted by our deposit
- Gas config is stable across the steps of one graduation
- Someone keeps calling graduate until Done (one step per call)

commit_trade:
- fee accumulators and fee_creator+fee_protocol do not overflow u128
- emit_event never fails (panic after await would revert commit while busy stays Some with stuck=false, which reconcile rejects at L630-632)
- ready_at + graduation_timeout_blocks fits in u32

step_settle:
- held - wvara_expected is wVARA belonging to this launch
- No other launch has a minted-but-unbooked wVARA balance when Settle reads its balance
- mark_liquidity_added subtracting pool_vara matches wVARA actually deposited
- wvara_burn returns exactly leftover native VARA to the launchpad
- leftover fits in u128
- Burned VARA is booked as recovered even if a later call in the step fails
- graduation_fee >= pair_creation_fee
- Role-holder queries are truthful
- protocol_fees + escrow + recovered does not overflow

step_add_liquidity (+ mark_liquidity_added):
- pool_vara > 0 (divisor at L1287)
- U256 products at L1287, L1290, L1295-L1296, L1304-L1305 do not overflow (uint panics)
- Reserves grown by >=95% of the recomputed amounts since snapshot means our deposit landed
- A deposit that landed is detected even if reserves later decrease (swaps, AlignPrice rerun swap)
- Approve Ok(false) is not a failure
- Launchpad holds >= amount_w wVARA and >= amount_t tokens attributable to this launch
- Empty AddLiquidity reply implies pair took amounts within mins and minted LP to launchpad

LaunchpadService::step_align_price:
- pool_tokens (pt) != 0 before k/pt and k%pt
- rw_target != 0 before k / rw_target in branch B; rw_target rounds to 0 when k*pv < pt and that case always takes branch B
- U256 products rw*pt, rt*pv, rw*rt, (k/pt)*pv do not overflow
- Pair reserves and the GetAmountOut quote are honest and do not change across the awaits at L1225/L1248/L1250
- Pair swap fee is 0.35%
- A timed-out swap did not execute, so leaving budgets unchanged is correct
- Allowance from ApproveToken/ApproveWvara covers amount_in on every pass
- pool_vara > 0

step_wrap:
- held - wvara_expected >= pool_vara means this launch's own earlier mint landed (the surplus is not tied to this launch; it can come from other launches' unbooked mints, post-AddLiquidity leftovers, or third-party transfers)
- held (L1179) and expected (L1180) describe the same moment; expected is read after the await, so other launches' commits in between are counted
- wvara_expected equals the sum of pool_vara over wrapped launches that have not added liquidity yet
- An empty or prefixed Mint reply means exactly pool_vara wVARA was credited to me
- pool_vara > 0
- u128 += at L1186 and -= at L1190 do not wrap
- A panic in the booking closure leaves lock consistent

unwind / unwind_wrapped:
- Branch A Burn(pool_vara) consumes only this launch's wVARA
- A branch A burn that returned Err (Timeout/Decode) did not execute, so retry burning again is correct
- In branch B, wVARA above expected belongs to this launch
- A timed-out mint that is not visible in balance will never execute after Aborted
- Errored Mint returned attached pool_vara value to the launchpad
- wVARA Burn returns native VARA 1:1 to the launchpad
- graduation_timeout_blocks is bounded sensibly; 0 lets unwind race graduate in the Ready block, large values make L788 overflow-panic
- Pair-creation fee paid from reserve need not be recovered on unwind
- Approvals to launch.pair for pool_tokens and pool_vara wVARA are inert after Aborted

plan_buy:
- launch.fee_bps < 10000 (else div-by-zero curve.rs L110, underflow L109/L100)
- gross*fee_bps and net_needed*10000 fit in u128
- escrow at completion equals the net_raise derive_params was calibrated on, so pool_vara = escrow - graduation_fee (L1109) prices the pool at the curve's final price

run_buy:
- tokens_out <= virtual_tokens on sell-out path (L176 U256 sub)
- Pre-await refund send (L1079) is delivered
- Post-revert refund send of vara_gross (L1085) is delivered
- buyer is a user account so a gas-0 value message is delivered immediately
- VFT Ok(false) means no balance moved
- Err(Decode) means no transfer occurred
- Err(Send) from up_to failure (wire.rs L82) means no message was dispatched
- Ok(true) means buyer received exactly pending.tokens
- A stuck buy is resolvable because launchpad VFT balance equals real_remaining + pool_tokens (or prev_real_remaining + pool_tokens)
- emit_event cannot fail after the await (else continuation rolls back leaving busy Some, stuck false)

sell:
- amount <= launch.sold() (real_remaining + amount <= curve_supply); otherwise sold() underflows in commit_trade
- VFT TransferFrom returning Ok(true) means tokens actually moved to the launchpad
- send_value true means the seller received net VARA
- Launchpad VFT balance equals real_remaining + pool_tokens so reconcile can resolve a timed-out sell
- Post-await code (owe, sold, emit_event.expect) does not panic; otherwise busy stays set with curve moved
- gross * fee_bps fits in u128
- total_liabilities temporarily reduced by gross during await is acceptable to free_balance/launch LowReserve readers

reconcile:
- The launchpad's VFT balance changes only through its own trades and graduation (no unsolicited inbound transfers, no external mint/burn)
- Which branch runs reflects whether the trader's transfer executed. In fact it reflects only the aggregate balance: an inflow of exactly pending.tokens from any account switches the branch.
- At the time BalanceOf is answered, the timed-out Transfer/TransferFrom has either been fully applied or will never be applied
- The buyer refund pay(trader, vara_gross) succeeds
- The post-await segment does not trap; otherwise the lock=true persisted at L634 would remain
- In Aborted state, the pool_tokens allowance granted to the pair at ApproveToken has not been spent

apply_buy / revert_trade:
- Global total_liabilities >= escrow_delta at Buy revert (settle does not underflow)
- fee_bps <= 10000 and split_fee does not underflow when building the snapshot
- Native refunds around revert succeed
- VFT Ok(false)/Send/Reply/Decode means no tokens moved, justifying revert

---

## 7. Where records disagree or overlap

- overflow-checks: records 02, 03, 06, 09 and 10 list it as an open question. Records 07 and 12 cite `contracts/launchpad/Cargo.toml` L23 `overflow-checks = true`. This was verified during synthesis: L23 is present.
- fee_bps bound: record 08 says set_fees L1015 enforces it after deploy and the constructor does not. Record 12 says "setter not inspected". Synthesis confirms set_fees checks `creator_fee_bps > fee_bps || fee_bps >= BPS` and `graduation_fee >= pair_creation_fee`. The constructor does not check either.
- unwind timeout: the state.rs:52 doc comment ("Ready or Failed" timeout, cited by record 01) differs from the code (timeout only on the Ready branch, L787-L789, record 07).
- Ready → graduation trigger: record 02 says the last buy only sets Ready. Record 09 confirms that run_buy ignores `completes_curve` (read only by quote at L914). They agree. The keeper is the only driver described in-repo (doc comment L668). Record 02 lists the off-chain keeper/indexer path as uninspected.
- Duplicate older function files exist under `contracts/launchpad/audit-context/functions/` and `/Users/adityakrx/VFT-Portal-DApp/audit-context/functions/` with different numbering. This dossier uses the records supplied in the task.

---

## 8. Unresolved (carried forward from every record, deduplicated)

Gear / gstd runtime
- Does a panic or out-of-gas in an async continuation leave the pre-await writes (graduate L702, unwind L796, reconcile L634 `lock = true`; apply_buy/sell `busy = Some(stuck=false)`) persisted? Does sails generate any signal/critical hook that resets them? (records 01, 02, 04, 05, 06, 07, 09, 10, 11, 12)
- Can an Err at wire.rs L82 (`up_to` failure) happen after the message was already queued? (09)
- Is a late reply after an `up_to` timeout discarded? Can the original timed-out Transfer/TransferFrom execute after reconcile's BalanceOf is answered? (10, 11)
- For a value-carrying message (Mint, CreatePair) whose reply times out or errors, is the value returned, and how is that surfaced? (06, 07)
- For a gas-0 value send to a program (not a user) destination, is the value returned to the launchpad, and is send_value's bool still true? (09, 10)
- Can sails `emit_event` fail, so that `.expect` at L1090/L1149/L1165/L1169/L1267/L809/L812 panics in a continuation? (02, 05, 09)

wVARA VftNativeExchange
- Mint: success reply payload, whether it can credit less than the value, behaviour at value == 0 or below ED. (06)
- Burn: does it return exact native VARA to the launchpad (not to the mailbox)? Behaviour on insufficient balance, and is it all-or-nothing? (01, 03, 07)
- Approve: replace vs increase semantics, and when it returns false. (04)

RivrDEX
- Does SwapExactTokensForTokens pull input via TransferFrom against the allowance? Is its success reply sent before or after the output transfer (multi-stage IDL, SwapRefund)? (01, 05)
- What is the real swap fee vs the hard-coded 0.35%, and what are the deadline units (ms vs s)? (05)
- AddLiquidity: optimal-amount logic (spends below desired?), MINIMUM_LIQUIDITY on first deposit, LP recipient = msg::source. (01, 04)
- Can reserves change without AddLiquidity (direct transfer plus sync/skim)? (04)
- Can the pair TransferFrom wVARA/token outside a launchpad-initiated call using the unrevoked approvals (L709/L713), including in the Aborted state? (07, 10, 11)
- CreatePair fee and refund semantics: is pair_creation_fee exactly the amount spent? (03)

Tokenator VFT
- Does the code under `config.vft_code_id` match `contracts/fungible-token`? (11)
- Transfer/TransferFrom: does true occur only on balance movement, and do false/panic imply no change? Does a success reply always decode as ("Vft", method, bool)? (09, 10, 12)
- Role queries and the init admin_id: which non-launchpad accounts can hold roles? (03)

Curve and sizing
- Quantify the maximum gap between actual sell-out escrow and the calibrated net_raise (v0/t0 rounding curve.rs L37-L42, floor/ceil, sell-out slack). When does L1109 saturate to pool_vara = 0? (02, 05, 08)
- Confirm `t0 >= curve_supply` so `virtual_tokens -= tokens_out` (L176) cannot underflow on the sell-out path. (09)
- Can split.net on the sell-out path (recomputed at L146 from gross_used) be below buy_cost_for_tokens for real_remaining, and does L144 `.min(net)` let the last buyer pay less than cost? (09)
- How is escrow deviation from the calibrated net_raise absorbed across step_wrap / step_align_price / step_settle? (08)
- Token and VARA decimals (curve.rs says 12/18): which reserve sizes make rw_target round to 0? (05)
- Confirm pool_vara is never rewritten on a path where the step becomes unwindable. (07)

Graduation economics and liveness
- Is the leftover split (graduation_fee → pair fee + protocol_fees, step_settle L1390-L1394) intended to include a creator share? No creator_fees writer exists outside L1101 and L840. (02; also the user's question 1)
- How does `Event::Ready` (L1168-L1170) trigger graduate calls in the off-chain keeper/indexer? Is there any off-chain procedure for a persistent Unreconcilable? (02, 11; also the user's question 2)
- Is the Done arm at L724/L727 reachable? (01)
- Does the unwind doc comment (state.rs:52) match the code (no timeout on the Failed branch)? (01)
- How does sell treat the graduation_fee portion still in escrow after Aborted? (07)
- Is sell/buy gating in Graduating/Failed sufficient to keep snapshot budgets stable across AlignPrice awaits? (05)
- Can any path change Launch.escrow while the state is Ready/Graduating/Failed before WrapVara books? (06)

Config
- Constructor validation of fee_bps < 10000, creator_fee_bps <= fee_bps and graduation_fee_vara >= pair_creation_fee_vara: confirmed absent in lib.rs `new`. Deployment scripts and the initial Config values are uninspected. (03, 08)
- Is there a post-init writer of `pair_creation_fee_vara` (e.g. inside set_addresses)? Not traced.
- What is the effect of a failed refund send at run_buy L1079 (bool discarded)? (08)
