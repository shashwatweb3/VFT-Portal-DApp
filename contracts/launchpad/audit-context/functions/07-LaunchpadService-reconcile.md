# LaunchpadService::reconcile

File: `contracts/launchpad/launchpad/app/src/service.rs` L619-L664
Entrypoint: `Launchpad.Reconcile(token) -> Result<bool, LaunchpadError>`, `#[export] async`, permissionless.

## 1. Purpose

This resolves a trade left in `Launch.busy` with `stuck = true`. A trade is marked stuck only when the VFT transfer reply timed out: `run_buy` at L1088-1091 and `sell` at L611-614 both call `mark_stuck` (L233-237). The function reads the launchpad's absolute balance of `token` and compares it with two expected values:

- committed: `launch.real_remaining + launch.pool_tokens` (L644). `real_remaining` already holds the post-trade value, because `apply_buy` (L177) and `sell` (L598) move it before the await.
- reverted: `pending.prev_real_remaining + launch.pool_tokens` (L645).

If the balance matches committed, it calls `commit_trade`. If it matches reverted, it calls `revert_trade` and, for a buy, refunds `vara_gross`. Any other balance returns `Err(Unreconcilable)`.

## 2. Block-by-block

### L623 `ensure_no_value()`
This panics if `msg::value() != 0` (L122-126). Because it runs before the await, a panic here reverts the whole message.

### L624 `let gas = self.gas()`
This clones the live `st.config.gas` (L276-278). The admin can change it through `SetGas`. It supplies `gas_for_token_ops`, `gas_for_reply_deposit` and `reply_timeout` to the BalanceOf call (wire.rs L181-183, L99-106).

### L625-636 pre-await guard (one execution, before the await)
- `st.launch_mut(&token)` panics `LaunchNotFound` on an unknown token (state.rs L240-244).
- L627: if `launch.lock` is set, it panics `ReconcileInProgress`. The same flag is set by graduate (L702) and unwind (L796), so the panic message also covers those cases.
- L630-633: it requires `busy == Some(p)` with `p.stuck`, otherwise it panics `NotStuck`. It clones `p` into the local `pending`.
- L634: sets `launch.lock = true`.
- **There is no check of `launch.state`.** `busy` is only set by `apply_buy` (L179) and `sell` (L600). Those run only in `Trading` (check_buy L212) or `Trading | Aborted` (sell L558). Graduate (L678) and unwind (L793) refuse to run while `busy.is_some()`, and `commit_trade` is the only thing that changes state from a trade. So while `busy` is set, the state stays `Trading` or `Aborted`. That is established by those guards, not by reconcile.

### L637-638 the await: `wire::vft_balance_of(token, me, &gas)`
- `call_typed(token, "Vft", "BalanceOf", (me,), gas_for_token_ops, 0, g)` (wire.rs L181-183). It sends with a reply deposit and `up_to(Some(reply_timeout))` (L78-83).
- Outcomes:
  - `Send`: send failed, or `up_to` failed.
  - `Timeout`: `GstdError::Timeout`.
  - `Reply`: any other error reply, including a callee panic.
  - `Decode`: the reply prefix is not `"Vft"/"BalanceOf"` or the body fails to decode as U256 (L45-53).
  - `Ok(U256)`.
- The callee is the spawned VFT. Its `balance_of` (vft lib.rs L415-417, L99-101) returns the map value or 0, and it has no side effects. Its code comes from the admin's `vft_code_id`. The prefix check is the only validation of the reply. The returned U256 is the callee's claim and is trusted as the launchpad's balance.
- **While suspended:** `lock = true` and `busy = Some(stuck)`. Buy (L215), Sell (L561), Graduate (L678/L681), Unwind (L793) and another Reconcile (L627) all refuse. Calls that do not check lock or busy can still run: ClaimCreatorFees, ClaimProtocolFees, ClaimPayout, the admin setters, TopUpReserve and queries. None of these write `real_remaining`, `pool_tokens`, `busy` or the launch's VFT balance. External actors can still change the launchpad's VFT balance during the suspension, using VFT `Transfer` (lib.rs L345) or `TransferToUsers` (L225) with the launchpad as recipient.

### L639 lock release, before any decision
`lock = false` runs before the `held` result is examined, so it runs on every reply outcome. Lines L639-L663 are one synchronous continuation with no further await, so nothing can interleave between the release and the decision.

Structural fact: in Gear, a panic in the continuation rolls back that continuation's state changes, including L639. If anything in L641-L663 panics, `lock` remains `true` as written at L634 in the pre-await execution. These are the panic sites in the continuation:
- `launch()` (L642, a token that existed before cannot vanish; no remove path was observed in the State write list)
- U256 `+` overflow at L644 and L645 (the `Add` impl panics on overflow)
- `commit_trade` → `st.owe` `LiabilityOverflow` (state.rs L252-257)
- `pay_seller` → `owe` (L298)
- `revert_trade` → `st.settle` `LiabilityUnderflow` (L259-264), the u128 subtraction at L190/L192, and `st.owe` (L198)
- `emit_event(...).expect("event")` (L650-651, L658-659, and inside commit_trade L1149/L1165/L1169)

Nothing else clears `lock` for this launch: only L639, L726 and L801 write `false`.

### L640 error mapping
Every `CallError`, including Timeout, becomes `Err(Unreconcilable)`, and it is returned after the lock release. `busy` stays stuck, so the call can be retried.

### L641-647 expected values
These read the live `launch.real_remaining` and `launch.pool_tokens` and the snapshot `pending.prev_real_remaining`. Two facts keep them consistent:
- `pool_tokens` is written only at launch (L454).
- `real_remaining` is written by `apply_buy`, `sell` and `revert_trade` only. All three are blocked while `busy` is set.

So the live `real_remaining` equals the post-trade value written by the stuck trade. Neither `pending.seq` nor any field of `pending` is compared against `launch.busy` after the await. The match depends on nothing having replaced `busy` during the suspension, and the lock and busy guards above are what ensure that.

For a buy, `tokens > 0` (check_buy L222). For a sell, `amount > 0` (L564). So committed and reverted always differ by `pending.tokens`: committed = prev − tokens for a buy, prev + tokens for a sell. At most one branch can match.

### L648-652 committed branch → `commit_trade(token, &pending)` (L1098-1172)
- It adds `fee_creator` and `fee_protocol` to the launch fees (L1101-1102), clears `busy` (L1103), and calls `owe(fee_creator + fee_protocol)` (L1131).
- For a buy with `real_remaining == 0`, it sets `state = Ready`, `ready_at = exec::block_height()` (the block of the reconcile, not the original trade, L1108), `pool_vara = escrow - graduation_fee` (saturating, L1109), and the wvara/token budgets.
- For a sell, it calls `pay_seller` (L288-301): it sends `vara_net` if `>= ED` and the send succeeds, otherwise it credits `pending_payouts` and `owe`s. Before the await, `sell` already ran `settle(gross)` (L601). At commit, fees are re-owed, and net is paid or re-owed.
- For a buy, `apply_buy` owed `net` (L180). The fees were taken from the attached value at buy time and are owed here.
- It returns a `TradeReceipt`. Reconcile discards it and returns `Ok(true)` after emitting `Reconciled{committed:true}`.

### L653-660 reverted branch → `revert_trade` (L184-200), then refund for a buy
- It restores `virtual_vara`, `virtual_tokens`, `real_remaining` and `escrow` from the snapshot, and clears `busy`.
- Buy: `settle(escrow − prev_escrow)`, which equals `plan.split.net` (L178/L180).
- Sell: `owe(prev_escrow − escrow)`, which equals `gross` (L599/L601).
- For a buy, `pay(pending.trader, pending.vara_gross)` (L656) → `send_value` (wire.rs L286-291): a 0-gas value send, and the boolean result is **ignored**. If the send returns false, nothing is recorded in `pending_payouts` or liabilities. The VARA stays in the program's free balance with no liability booked for the trader.
- The amount refunded is `vara_gross = plan.gross_used` (L164). The excess `plan.refund` was already paid before the await in `run_buy` (L1077-1080), so attached value minus that early refund equals `vara_gross`.
- For a sell, there is no refund and no token movement. The seller's allowance to the launchpad is untouched (TransferFrom did not land, by premise of the match).
- The event is `Reconciled{committed:false}` and the return is `Ok(false)`.

### L661-663 mismatch → `Err(Unreconcilable)`
No state change happens beyond the lock release. `busy` stays `Some(stuck)`, so the launch stays frozen: buy, sell, graduate and unwind all refuse while busy. Nothing found clears `busy` except `commit_trade`/`revert_trade` reached from run_buy, sell or reconcile. No admin override path to clear `busy` was found among the setters (L984-1058 in the entrypoint list).

## 3. The central assumption: the balance identity

Reconcile depends on this invariant holding whenever no trade is in flight:

> VFT.balance_of(launchpad) == launch.real_remaining + launch.pool_tokens

Where it is established:
- Launch: `initial_supply = total_supply` minted to `admin_id = launchpad` (L399-401, vft lib.rs L79-81). `real_remaining = curve_supply` (L453). `pool_tokens = total_supply − curve_supply` (L244). So the identity holds at creation with zero trades.
- Buy commit: the launchpad sends `tokens` (L1081), and `real_remaining -= tokens` (L177).
- Sell commit: the launchpad receives `amount` (L605), and `real_remaining += amount` (L598).
- Revert: no movement, and the snapshot is restored.

Where nothing enforces it:
- Any account can `Transfer` or `TransferToUsers` tokens to the launchpad (vft lib.rs L345-352, L225-255). The launchpad cannot refuse incoming VFT. Any such inflow, of any size and at any time, including during the reconcile await, makes `held` differ from both expected values unless it exactly offsets the trade. **Nothing found** prevents or accounts for third-party inflows.
- The launchpad holds minter, burner and admin roles in the VFT (lib.rs L93-95), so `Mint`/`Burn` can change its balance. A grep of service.rs found no launchpad call to `Mint`/`Burn` on the launch token. The only token-side calls are `vft_transfer` (L1081, L1338 on the pair's LP, L1381 in settle), `vft_transfer_from` (L605) and `vft_approve` (L709, L1312). Calls at L1312/L1338/L1381 happen in graduation steps that cannot run while `busy` is set.
- `ApproveToken` (L709) grants the pair an allowance of `pool_tokens` over the launchpad's balance. If graduation fails at `ApproveWvara` and is unwound (`is_unwindable` covers ApproveToken/ApproveWvara, state.rs L105-113), the launch becomes `Aborted` (L809) and sells reopen. No revocation of that allowance was found in unwind (L780-814). The identity then also depends on the RivrDEX pair not calling `TransferFrom(launchpad, ...)` outside AddLiquidity. That is unclear; see open questions.
- The callee is assumed to report the launchpad's real balance. The VFT code is admin-chosen (`vft_code_id`), and the reply is checked only for prefix and decode.

## 4. Message-ordering assumption

The design assumes that when a reply timed out, the original Transfer/TransferFrom has already executed or will never execute by the time BalanceOf is processed. Otherwise, a reverted match followed by a late-executing transfer would move tokens after the revert and refund. Nothing in reconcile establishes this. It rests on Gear's queue ordering: the Transfer was sent earlier, from the same source, to the same destination. Reconcile itself places no minimum delay since `stuck` was set and no `seq`/block check.

## 5. Value accounting summary

| Path | total_liabilities delta (pre-await + reconcile) | native out |
|---|---|---|
| Buy committed | +net (L180) +fees (L1131) | early refund (L1079) |
| Buy reverted | +net −net = 0 | early refund + vara_gross (L656, result ignored) |
| Sell committed | −gross (L601) +fees (L1131) [+net if deferred, L298] | vara_net if sent (L293) |
| Sell reverted | −gross +gross = 0 | none |

## 6. Callers

Only the external dispatch (`Launchpad.Reconcile`). No internal caller.
