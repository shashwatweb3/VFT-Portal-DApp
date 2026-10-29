# Launchpad: Gear/Vara security review (read-only)

Scope: `contracts/launchpad/launchpad/app/src/{lib,state,curve,wire,service}.rs` and `contracts/launchpad/vft/app/src/lib.rs`. I also read `docs/audit/{threat-model,invariants,findings}.md`, the tests (to understand intended behaviour only) and the RivrDEX code under `vendor/vara-amm` (as context).

How runtime and library behaviour was checked: every claim about gstd, sails or the runtime cites the crate source in `~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/`. The files used are `gstd-1.10.0`, `gstd-codegen-1.10.0`, `sails-macros-core-0.10.2` and `core-processor-1.10.0`.

Paths below are relative to `contracts/launchpad/launchpad/app/src/` unless they say otherwise.

## Gear facts this report relies on (all checked in the crate sources)

| # | Fact | Source |
|---|---|---|
| G1 | `send_*_for_reply` first **commits the outgoing message**, then calls `exec::reply_deposit(..)?`. If the deposit fails, the function returns `Err`, but the message has already been sent. | `gstd-codegen-1.10.0/src/lib.rs:509-513` |
| G2 | When the program does not have enough gas for a send's `gas_limit` or for the reply deposit, the syscall fails with a *recoverable* error (`FallibleExecutionError::NotEnoughGas`). It does not trap. | `core-processor-1.10.0/src/ext.rs:413-416, 453-457, 976-985, 1403-1409` |
| G3 | State written before an `exec::wait` is kept. If the code traps after the wake-up (panic, out of gas and so on), only the `critical` hook runs, inside `handle_signal`. | `gstd-1.10.0/src/critical.rs:39-47, 133-140`; `async_runtime/mod.rs:84-94` |
| G4 | Sails 0.10.2 generates a `handle_signal` that only calls `gstd::handle_signal()`, unless the program supplies its own. The launchpad sets no critical hook (it has no `critical::`, `set_hook` or `handle_signal =`). | `sails-macros-core-0.10.2/src/program/mod.rs:254-257, 320-329` |
| G5 | `up_to(0)` returns `Err(EmptyWaitDuration)` *after* the message has already been sent. | `gstd-1.10.0/src/msg/macros.rs:47-55`, `async_runtime/locks.rs:60-63` |
| G6 | An error reply resolves the future to `Err(ErrorReply)`. Replies are matched by `reply_to`, so another program cannot spoof one. | `gstd-1.10.0/src/msg/async.rs:42-63`, `async_runtime/signals.rs:69-90` |
| G7 | `wait_up_to` waits only as many blocks as the remaining gas can pay for. The continuation then runs on whatever gas the original message has left. | `gstd-1.10.0/src/msg/macros.rs:45-47`; `core-processor ext.rs:1314-1345` |
| G8 | RivrDEX first mint requires `sqrt(a*b) >= 1000`, so a pool needs only `a*b ≈ 1e6`. | `vendor/vara-amm/contracts/pair/app/src/services/pair/amm_math.rs:4, 218-228` |

---

## Findings

### C-1 (Critical, CONFIRMED): a message that was sent but whose reply deposit failed is treated as "not sent", so buyers get free tokens and can drain the escrow

**Where:** `wire.rs:78-79`, which maps every `Err` from `send_bytes_with_gas_for_reply` to `CallError::Send`. The callers treat `Send` as "nothing happened":

- `service.rs:1083-1086` (buy): reverts the curve and refunds `vara_gross`.
- `service.rs:607-609` (sell).
- `service.rs:756-764` (graduation step).
- `service.rs:800-806` (unwind).

**Why it happens:** by G1 and G2, a caller can choose a gas limit that covers the send's `gas_for_token_ops` but not `gas_for_reply_deposit`. The send commits, the deposit fails, and gstd returns `Err`. The handler then finishes normally, which publishes the VFT `Transfer` *and* the refund.

**Attack (any user):**
1. Attacker sends `Buy(token, 0, deadline)` with value V (for example 1,000 VARA) and gas = system reserve + pre-send work + `gas_for_token_ops` + a few gigagas, which is less than `gas_for_reply_deposit` (20 B in the tests).
2. `apply_buy` runs, then the send commits, then `reply_deposit` fails and returns `Err(Send)`. `revert_trade` restores the curve and `pay(buyer, V)` refunds the value.
3. The VFT executes `Transfer(attacker, tokens)`. The attacker now holds the tokens and has their VARA back. The launchpad's books still count those tokens as unsold.
4. Attacker sends `Sell(token, tokens, ...)` and receives the curve price out of the escrow. Repeating steps 1-4 drains the escrow until `EscrowExhausted`.

**Impact:**
- The whole escrow of every Trading launch: the sum of all buyers' VARA. The attacker needs no capital, because the value comes back each round.
- The same class breaks graduation and unwind:
  - **Unwind double-burn:** a `wvara_burn` that executes but reports `Send` leaves `wrapped=true` (`service.rs:1405-1414`). A second `Unwind` then burns `pool_vara` again out of the *shared* wVARA balance, so another wrapped launch B can never complete AddLiquidity. B is stuck at a step that cannot be unwound.
  - **Graduation steps:** mints, burns and CreatePair execute while being reported as failures.

**Fix:**
- In `wire::call`, separate the cases. A failure of `send_bytes_with_gas` itself means "not sent". A failure of `reply_deposit` or `up_to` after the send must either panic (safe only when no earlier await happened in the same message, which is true for `buy` and `sell`) or be treated like `Timeout`, that is "stuck, reconcile from balances".
- Better still: send with `send_bytes_with_gas` and call `exec::reply_deposit` yourself so the two failures can be told apart.
- Add a gas guard at entry (see C-3).

### C-2 (Critical, CONFIRMED): a dust pre-seed makes AlignPrice divide by zero after an await, which freezes the whole raise forever

**Where:**
- `service.rs:1239-1240`: `rw_target = isqrt(k*pv/pt)` is 0 whenever `k*pv < pt`.
- `service.rs:1245`: `rw < 0` is false, so execution takes the else branch.
- `service.rs:1254`: `rt_target = k / rw_target` is a U256 division by zero, which panics.
- The panic happens after the `pair_get_reserves` await (`service.rs:1225`). `launch.lock = true` was set at `service.rs:702` and committed at the first wait (G3). No hook clears it (G4).

**Attack (cost: 1 VARA pair fee plus dust):**
1. After `Launched`, the attacker buys `min_trade_vara` of tokens, mints 2,000 planck of wVARA, calls `Factory.CreatePair(wVARA, token)`, approves both tokens, and calls `Pair.AddLiquidity(2000, 2000, ...)`. Then k = 4e6, which is enough for G8.
2. The curve sells out and the keeper runs `Graduate` through steps 1-4.
3. Step 5 (`AlignPrice`): the prices are more than 1% apart. With `k*pv = 4e6 * ~5e14 < pt = 2e26`, `rw_target` is 0, the step panics, and the trap leaves the lock set.

**Impact:**
- The launch stays in `Graduating` with `lock=true`, permanently:
  - `graduate` panics with "GraduationInProgress" (`service.rs:681`).
  - `unwind` requires a Failed or Ready state and `!lock` (`service.rs:790-794`).
  - Sells are closed (`service.rs:558`).
  - There is no admin escape.
- `pool_vara` (wrapped) plus the graduation fee, which is about 100% of the raise, is locked forever.
- Existing tests seed with k ≥ 1e30 (`tests/feedback.rs:378`), so they miss this.

**Fix:**
- If `rw_target.is_zero()`, treat the pool as "tokens far too cheap" and buy with the capped budget, or skip.
- Use checked math everywhere after an await and turn errors into `Err(CallError::…)`.
- Add the C-3 safety net.

### C-3 (Critical, CONFIRMED in code; runtime per G3/G7): any trap after an await (including out-of-gas chosen by the caller) leaves `busy` or `lock` set forever

**Where:**
- `busy` is set before the await at `service.rs:179` (buy) and `service.rs:600` (sell).
- `lock` is set at `service.rs:634` (reconcile), `service.rs:702` (graduate) and `service.rs:796` (unwind).
- These flags are cleared only by code that runs after the await (`service.rs:639, 726, 801`, `commit_trade`, `revert_trade`).
- There is no `critical::set_hook` and no custom `handle_signal` (G4).
- `reconcile` needs `busy.stuck == true` (`service.rs:631-632`), so a `busy` that was never marked stuck cannot be cleared by anything.

**Attack (gas only):**
- **Graduation:** on a Ready launch, the attacker sends `Graduate(token)` with gas covering the system reserve (10 B, `gstd config.rs:30`, `futures.rs:74`), the send, the reply deposit and one block of waitlist rent, but not the continuation. The reply wakes the message, it runs out of gas, and `lock` stays `true` with the state `Graduating`. The result is the same permanent freeze as C-2.
- **Trading:** the same trick on `Sell(token, 1 unit, …)` (sells have no minimum) leaves `busy=Some(stuck:false)`. Buys, sells and graduation are then blocked forever, and the whole escrow is frozen.

**Impact:** a permanent freeze of all VARA in any chosen launch, for the cost of one transaction.

**Fix:**
1. At the entry of every async handler, require `exec::gas_available() >= worst-case budget` (sends + deposits + rent for `reply_timeout` blocks + continuation + system reserve). Panic *before* setting `busy` or `lock`.
2. Call `gstd::critical::set_hook` right after setting `busy`/`lock` to mark the trade stuck or release the lock, and raise `Config::set_system_reserve` so the hook can run.
3. Add an admin or timeout escape that clears a `lock` older than N blocks (findings.md C7 is related).

### H-1 (High, CONFIRMED): anyone can permanently abort any launch at graduation by forcing a step 1-4 failure and calling `Unwind` straight away

**Where:**
- `wire.rs:78-82`: insufficient gas for the outgoing `gas_limit` gives `Err(Send)` (G2) and does not trap.
- `service.rs:756-764`: the step is recorded as `Failed` with `retryable=true`, and the state is committed.
- `service.rs:789`: `failed_early` has **no delay**, so `Unwind` is open to anyone at once.
- `service.rs:807-811`: the launch becomes `Aborted` and buys are closed for good.

**Attack:**
1. On `Ready`, the attacker sends `Graduate(token)` with gas just below `gas_for_token_ops` after the entry work. `vft_balance_of` cannot be sent, so the launch becomes `Failed{step: WrapVara}`.
2. In the same or the next block, the attacker sends `Unwind(token)` with normal gas. `wrapped=false`, so the launch becomes `Aborted`.

The front-run of `CreatePair` between GetPair and CreatePair is another way in (`service.rs:1198-1200`). Natural transient failures can also be turned into aborts.

**Impact:**
- Any successful curve is denied its listing, for the cost of gas.
- Holders can only sell back at the frozen curve, paying the `fee_bps` sell fee.
- The creator's launch is destroyed.
- No VARA is stolen.

**Fix:**
- Require `Failed` to have lasted `graduation_timeout_blocks` (store `failed_at`) before `failed_early` unwind is allowed.
- Make an under-gassed `Graduate` panic, using the gas guard from C-3, instead of recording `Failed`.

### M-1 (Medium, CONFIRMED): resuming AddLiquidity trusts a stale `pre_add_reserves`, so the attacker's own deposit is booked as ours

**Where:**
- `service.rs:1314`: the snapshot is stored *before* the AddLiquidity send.
- `service.rs:1319`: a `Send` (G2) or an error reply returns `Err`, but the snapshot is never cleared.
- On retry, `service.rs:696-697` sends the flow back to AlignPrice and then AddLiquidity. `service.rs:1294-1300` then accepts "the reserves grew by 95% of our amounts" as proof that our deposit landed.

**Attack:**
1. The attacker calls `Graduate` at AddLiquidity with gas that covers the two approves (the snapshot is committed at the next wait) but not `gas_for_add_liquidity`. The result is `Err(Send)` and `Failed`.
   - Alternative: move the price more than 3% between the approves and AddLiquidity, so the pair rejects the 97% minimums.
2. The attacker adds liquidity of at least 95% of our `amount_w` and `amount_t` at the target ratio.
3. Anyone calls `Graduate` twice (AlignPrice is a no-op, then AddLiquidity). `landed` is true, so `mark_liquidity_added` runs without any deposit from us.
4. BurnLp sees no LP and returns Ok. Settle sees `held > expected` and burns our `pool_vara` of wVARA into **protocol_fees**. Our 200M pool tokens go to `LP_DEAD`.

**Impact:**
- The pool consists only of the attacker's removable LP, so they can rug DEX buyers.
- About `pool_vara` (roughly 98% of the raise) goes to the treasury instead of locked liquidity.
- `Graduated{wvara_in_pool}` reports a false amount.
- The attacker needs about a pool's worth of capital, which they can withdraw afterwards.

**Fix:**
- Clear `pre_add_reserves` on any outcome except a genuine `Timeout`.
- Detect "landed" from the launchpad's own LP balance change, using a snapshot of our LP balance before the call; minted LP goes to `msg::source`.

### M-2 (Medium, CONFIRMED): `Reconcile` requires an exact balance, so anyone can make a stuck trade unrecoverable with a 1-unit donation

**Where:** `service.rs:641-663`. `held == committed_expected` or `held == reverted_expected`, else `Unreconcilable`, and `busy` stays set forever.

**Attack:** once any trade is `stuck` (a reply timeout, or C-1/C-3 after their fixes map those cases to stuck), the attacker sends `Vft.Transfer(launchpad, 1)`. Every later `Reconcile` returns `Unreconcilable`.

**Impact:** a permanent freeze of that launch's trading, graduation and escrow.

**Fix:** compare with `>=` against the committed value (any surplus is a donation), or reconcile on the trader's balance change. Add an admin or timeout escape.

### M-3 (Medium, CONFIRMED code; runtime: a failed message's value goes back to its sender): payouts with zero gas to *program* accounts bounce, and the books still record them as paid

**Where:** `wire.rs:286-291` sends with `gas_limit 0`. Affected callers:
- `pay_seller`: `service.rs:293`
- refunds: `service.rs:434, 514, 656, 1079, 1085`
- claims: `service.rs:836, 862, 888`

For a program destination, the 0-gas dispatch fails and the value returns to the launchpad. gstd silently drops the unexpected reply (`signals.rs:83-86`). `settle()` or `creator_fees = 0` has already run, so the VARA becomes unbooked reserve. There is no withdraw path for the reserve.

**Impact:** a contract-wallet or aggregator trader, a program creator, or a program `treasury` loses 100% of each payout.

**Fix:**
- If `exec::program_id` checks are not available, send with `gas_limit >= mailbox_threshold` and a reply deposit, and use `handle_reply` to re-credit a failed payout to `pending_payouts`.
- Or make every payout a pull claim that uses `send_for_reply`.

### M-4 (Medium, CONFIRMED): admin parameters change *live* launches, which contradicts threat-model A10

**Where:**
- `service.rs:276-278` and `1001`: `config.gas` is used by every launch on every call.
- `service.rs:785`: `graduation_timeout_blocks` is read live.
- No validation in `set_gas` or `new`.

**Attack (compromised or careless admin):**
- `SetGas{reply_timeout: 0}`: by G5, every call sends and then returns `Err(Send)`. Every `Buy` delivers the tokens *and* refunds the buyer (the same drain as C-1).
- `SetLimits{graduation_timeout_blocks: 0}`: anyone can `Unwind` any Ready launch before the keeper graduates it.
- Gas budgets set below the callees' needs force `Failed`, which H-1 then turns into `Aborted`.

**Fix:**
- Snapshot `GasConfig` and `graduation_timeout_blocks` per launch, or bound them with `reply_timeout >= 1` and sensible minimums.
- Map an `up_to` failure to "stuck" (see C-1).
- Use a two-step `set_admin`.

### L-1 (Low/Medium, CONFIRMED lock logic; SUSPECTED queue-ordering assumption): the per-launch `busy` lock lets one cheap trade per block lock out every other trader

**Where:** `service.rs:215, 561`. Extrinsic messages from a block are queued ahead of the VFT transfer that the first trade sends. Every other `Buy` or `Sell` on that launch in the same block panics with `TradeInProgress`.

**Attack:** a griefer submits a 1-unit `Sell` (sells have no minimum) as the first message every block.

**Impact:** trading on a chosen curve is denied; the griefer pays one transaction fee per block. Letting only their own trades through also gives them ordering power.

**Fix:** add a minimum sell size. Consider queueing trades or doing the curve maths in one execution with a VFT pull pattern.

### L-2 (Low, CONFIRMED logic; needs a mint timeout or the C-1 class): Settle sweeps *global* wVARA above `wvara_expected`, which can take another launch's minted-but-unbooked wVARA

**Where:** `service.rs:1369-1376`, together with `step_wrap` booking only on success (`service.rs:1183-1191`).

**Sequence:**
1. Launch A's mint executes but is reported as failed (timeout, or C-1).
2. Launch C's Settle burns A's `pool_vara` and books it as C's `protocol_fees`.
3. A retries and mints again.

**Impact:** liabilities exceed the balance by `pool_vara` (breaks I2).

**Fix:** track wVARA per launch, or sweep only after every launch's wrap state is settled.

### L-3 (Low, SUSPECTED): AlignPrice and AddLiquidity can be sandwiched within their tolerances

**Where:** `service.rs:1248-1250` (98% `min_out`, computed one message round before the swap) and `service.rs:1312-1319` (two awaits between the 2% price check and the 97% minimums).

**Impact:** at most about 2% of `amount_in` (≤ `pool_vara/2`) per AlignPrice run, and a pool opening a few percent off the curve price. Each repeat needs a forced failure (H-1).

**Fix:** tighter tolerances, and compute the minimums from the snapshot rather than from a fresh quote.

### Info

- **I-1:** after a timeout the gstd signal entry stays registered (`async.rs:42-47` removes only the lock). A late reply then calls `exec::wake` on a finished message and `handle_reply` panics (`signals.rs:80`). The state is unaffected. Value carried by such a late reply (for example a failed wVARA mint's refund) should be checked in a gclient test. SUSPECTED.
- **I-2:** a spawn whose reply times out or fails after the send releases the name and refunds the creator (`service.rs:427-436`). The VFT may still be created and would hold 1e27 tokens owned by the launchpad, leaving an orphan token with a duplicate name.
- **I-3:** dust sells to new `(token, trader)` keys grow `pending_payouts` without bound (`service.rs:297`). This is state bloat only.
- **I-4:** the `name_taken` query normalises names (`trim().to_lowercase()`, `service.rs:978`) differently from `launch` (collapsed ASCII whitespace, `service.rs:326-331`), so the UI can show a name as free when `launch` will reject it.
- **I-5:** `ApproveToken` and `ApproveWvara` ignore a `false` reply (`service.rs:709-716`). This is harmless because AddLiquidity approves again.

---

## Checked and found SAFE

| Attack class | Why it is safe (code reference) |
|---|---|
| Value kept after a validation failure | All buy, sell and launch checks run before the first await and use `panic!`, so the value comes back: `service.rs:531-538, 550-603, 319-409`. After the spawn, the first-buy failure path refunds explicitly (`service.rs:509-516`). |
| Interleaved trades / reentrancy | `busy` is set synchronously before the await (`service.rs:179, 600`) and checked by buy, sell, graduate and unwind (`service.rs:215, 561, 678, 793`). Claims touch only fee and payout fields, which are booked at commit. |
| Two concurrent graduation, unwind or reconcile calls | `lock` (`service.rs:634, 681-702, 793-796`). |
| Cross-launch `wvara_expected` races in normal operation | It is read *after* the balance await (`service.rs:1180, 1370`). FIFO wake order books the earlier mint first. Only unbooked mints are at risk (L-2). |
| Spoofed or mis-routed replies | gstd matches on `reply_to` (G6). `decode_reply` and `check_null_reply` check the service and method prefix (`wire.rs:45-68`). Error replies become `Err` (`async.rs:58-63`). |
| Unit-returning callees | Empty auto-replies are accepted (`wire.rs:57-68`). RivrDEX `unwrap_result` methods panic on error, which gives an error reply (`vendor/.../pair/mod.rs:200-218, 276-293`). |
| Curve rounding / many-small-trades drain | Outputs are rounded down and the capped-buy cost is rounded up (`curve.rs:46-75`), so k never decreases. Fee rounding down only matters below 100 planck. Buys have a minimum (`service.rs:208`). |
| Slippage and deadline | Honoured for buy (`service.rs:219, 531`) and sell (`service.rs:551, 573`). |
| Sell-out buy refund | The early refund plus `gross_used` equals `gross`. A failed transfer refunds `gross_used` only (`service.rs:1075-1086`). Reconcile pays `vara_gross` (`service.rs:655-657`). |
| Sell beyond escrow | `EscrowExhausted` guard (`service.rs:568`). The Aborted curve is restored exactly by `unwind_wrapped` (`service.rs:1405-1413`). |
| VFT role capture / mint | Only `admin_id` = launchpad gets roles (`vft/lib.rs:93-95`, `service.rs:401`). Every grant, revoke, kill and metadata call is admin-gated (`vft/lib.rs:152-156, 257-322`). `initial == max` supply and mint is capped (`service.rs:399-400`, `vft/lib.rs:176`). Revokes are skipped once a role is gone (`service.rs:1356-1360`). |
| Admin redirecting existing funds | `addrs` (treasury, factory, wVARA) and the fees are snapshotted per launch (`service.rs:478-481, 860`). There is no admin value-out. The exceptions are the live gas and timeout settings (M-4). |
| Pre-seed price economics | AlignPrice trades toward the target price against the seeder, which favours the launchpad (`service.rs:1245-1260`). Leftover wVARA goes to protocol fees and leftover tokens to `LP_DEAD` (`service.rs:1369-1385`). The exception is the division by zero (C-2). |
| Donated LP / donated wVARA | Donated LP is burned (`service.rs:1331-1343`). Donated wVARA ends up as protocol fees or reserve, and the donor only loses (findings.md C8). |
| Claims | State changes only after `pay` succeeds (`service.rs:836-842, 862-868, 888-894`). The ED check prevents dust failures. The program-recipient case is M-3. |
| Unbounded iteration in handlers | None. `launches()` returns the whole Vec, but it is query-only (`service.rs:946-949`). |
