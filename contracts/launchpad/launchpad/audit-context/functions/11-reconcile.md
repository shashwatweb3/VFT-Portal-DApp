# reconcile — `app/src/service.rs` L619-L664

## 1. Purpose

Exported, permissionless (`#[export]`, L621-L622; no `ensure_admin`, no `msg::source()` check). It resolves a
`PendingTrade` that `run_buy` (L1088-L1091) or `sell` (L611-L615) left in `launch.busy` with `stuck = true`
after the VFT transfer reply timed out. It does this by asking the token for the launchpad's own balance
(L637-L638) and comparing it with two predicted values (L641-L647). On a match it either commits the trade
(L648-L652), or reverts it and refunds a buyer (L653-L660). On no match, or if the balance query fails, it
returns `Err(Unreconcilable)` and the trade stays pending (L640, L661-L662).

Returns `Ok(true)` = committed, `Ok(false)` = reverted.

## 2. Inputs and preconditions

| Input | Source | Checked where |
|---|---|---|
| `token: ActorId` | caller argument | `st.launch_mut(&token)` panics `LaunchNotFound` if no launch exists (state.rs L240-L244) |
| `msg::value()` | caller | `ensure_no_value()` L623 → panics if non-zero (L122-L126) |
| `launch.lock` | state | must be false, L627-L629 (`ReconcileInProgress`) |
| `launch.busy` | state | must be `Some(p)` with `p.stuck == true`, L630-L633 (`NotStuck`) |

Not checked: `launch.state`. The function does not look at `LaunchState`. It relies on `busy` only being
`Some` while the launch is in `Trading` (buy, `check_buy` L212) or `Trading | Aborted` (sell, L558).
`graduate` (L678) and `unwind` (L793) both refuse to start while `busy.is_some()`, and they are the only paths
into `Graduating`/`Graduated`/`Aborted`. So a stuck trade can only exist in `Trading` or `Aborted`.

## 3. Block-by-block

### 3.1 Pre-await segment (L623-L638)

- L624 `self.gas()` takes a live copy of `config.gas` (L276-L278). The admin can change it with `set_gas`
  (L998-L1002), and it is not snapshotted per launch.
- L625-L636: the guard checks and `launch.lock = true` run in one synchronous closure. The function clones
  `pending` out of `busy` (L631). That clone is what drives the commit/revert decision later; `busy` is not
  re-read after the await.
- L637-L638: `wire::vft_balance_of(token, me, &gas).await` is the **only await**. Before it, the state written
  is `lock = true`. In Gear, state written before a wait is persisted when the message suspends.

### 3.2 Interleaving window (during the L638 await)

While `lock == true` and `busy == Some(stuck)`:
- `buy`: `check_buy` rejects if `busy.is_some() || lock` (L215-L217).
- `sell`: rejects on `busy.is_some() || lock` (L561-L563).
- `reconcile`: rejects on `lock` (L627-L629).
- `graduate`: rejects on `busy.is_some()` (L678-L680).
- `unwind`: rejects on `lock || busy.is_some()` (L793-L795).
- Claims (`claim_creator_fees` L819, `claim_protocol_fees` L849, `claim_payout` L875) do not look at `lock`
  or `busy`. They can run during the window and change `creator_fees`, `protocol_fees`, `pending_payouts` and
  `total_liabilities`. None of these are inputs to the reconcile decision, but `total_liabilities` is mutated
  later by `commit_trade` (`owe`, L1131) and `revert_trade` (`settle`/`owe`, L196-L199).
- Admin setters can change `config` during the window. The reconcile decision only uses launch fields
  (`real_remaining`, `pool_tokens`), and those setters do not write them.

Result: the launch fields that feed the comparison (`real_remaining`, `pool_tokens`, `busy`) cannot be changed
by any other entrypoint during the await.

### 3.3 Post-await segment (L639-L663)

- L639 sets `lock = false` unconditionally, **before** the result is examined. Everything after it up to the
  return is synchronous (no further await): `commit_trade` is a sync fn (L1098), `revert_trade` is a sync fn
  (L184), and `pay` → `wire::send_value` is fire-and-forget `msg::send_bytes_with_gas` (wire.rs L286-L291).
  So clearing `lock` early does not open an interleaving window inside this message.
- L640: any `CallError` (Send / Timeout / Reply / Decode, wire.rs L70-L109) becomes `Err(Unreconcilable)`.
  `busy` stays `Some(stuck)` and `lock` is false, so the caller can retry.
- L641-L647 computes:
  - `committed_expected = launch.real_remaining + launch.pool_tokens` (current, already-moved curve value)
  - `reverted_expected = pending.prev_real_remaining + launch.pool_tokens` (snapshot from before the trade)
  These are U256 additions. Both terms are bounded by `total_supply` (the launch is built with
  `real_remaining = curve_supply` and `pool_tokens = total_supply - curve_supply`, L439, L453-L454, L244).
- Branch A, `held == committed_expected` (L648-L652): calls `commit_trade(token, &pending)`, which
  - adds the fees to `creator_fees`/`protocol_fees` (L1101-L1102)
  - sets `busy = None` (L1103)
  - for a Buy with `real_remaining == 0`, sets `state = Ready`, `ready_at`, `pool_vara`, `wvara_budget`,
    `token_budget` (L1104-L1118)
  - calls `owe(fee_creator + fee_protocol)` (L1131)
  - for a Sell, calls `pay_seller` (L1152), which sends `vara_net` or defers it into `pending_payouts` + `owe`
    (L288-L301)

  Then it emits `Reconciled{committed:true}`.
- Branch B, `held == reverted_expected` (L653-L660): calls `revert_trade`, which restores `virtual_vara`,
  `virtual_tokens`, `real_remaining` and `escrow` from the snapshot, sets `busy = None`, and calls
  `settle(escrow_delta)` for a Buy or `owe(escrow_delta)` for a Sell (L184-L200). For a Buy it then calls
  `pay(pending.trader, pending.vara_gross)` (L655-L657) and **ignores the boolean result**. It emits
  `Reconciled{committed:false}`.
- Branch C (L661-L662): `Err(Unreconcilable)`. No state change beyond `lock = false`.

Branch order: committed is tested first. The two predicted values differ by `pending.tokens` (Buy:
`real_remaining = prev - tokens`, L177; Sell: `real_remaining = prev + amount`, L598), and `pending.tokens` is
non-zero (Buy: `ZeroOutput` check L222-L224; Sell: `ZeroInput` L564-L566). So the two branches are mutually
exclusive.

## 4. Invariants this function depends on

**I1 — balance baseline.** Outside of a pending trade, the launchpad's VFT balance must equal
`real_remaining + pool_tokens`.
- Origin: the VFT seeds `initial_supply` to `admin` (fungible-token `services/vft/mod.rs` L70-L72). The
  launchpad passes `initial_supply = total_supply` and `admin_id = exec::program_id()` (service.rs L399-L401),
  and `real_remaining + pool_tokens = curve_supply + (total_supply - curve_supply) = total_supply`
  (L244, L453-L454).
- Kept by: each committed buy moves `tokens` out (L1081) and lowers `real_remaining` by the same amount
  (L177). Each committed sell moves `amount` in (L605) and raises `real_remaining` by the same amount (L598).
- Not kept against: inbound transfers from third parties. Any holder can call `Vft.Transfer(to=launchpad)`;
  the VFT's `transfer` has no recipient restriction (fungible-token vft/funcs.rs L41-L53, vft/mod.rs
  L112-L124). Nothing in the launchpad accounts for unsolicited inflows. Also not kept against: any VFT
  mint/burn to or from the launchpad. Mint/burn are gated by the minter/burner role sets (extended_vft/mod.rs
  L110-L113, L130-L133), and the launchpad holds those roles until the RevokeMinter/RevokeBurner steps.
- Not kept against: pool-token outflows during graduation (AlignPrice swap, AddLiquidity). These only happen
  in `Graduating`, which cannot hold a stuck trade (L678). But a launch can reach `Aborted` via `unwind` only
  from Ready or from Failed at WrapVara..ApproveWvara (state.rs L105-L113), which is before any token outflow.
  ApproveToken (L709-L711) has granted the pair an allowance of `pool_tokens` by then. Whether the pair can
  spend that allowance without a launchpad-initiated call is outside this code (open question).

**I2 — exact equality is the only accept condition** (L648, L653). Any drift in I1 by any non-zero amount
other than exactly `±pending.tokens` lands in Branch C. Branch C has no terminal fallback: the only writers
that clear `busy` are `revert_trade` L195 and `commit_trade` L1103 (grep of `busy =` in app/src), and both are
reached here only under exact equality. No admin path clears `busy` or `stuck`.

**I3 — outcome attribution follows balance, not provenance.** The decision reads only the aggregate balance.
Branch A versus Branch B is decided by whether `held` equals one of two numbers that differ by
`pending.tokens`. It is not decided by whether the trader's own transfer executed.
- For a stuck Sell, the committed value is the reverted value plus `amount`. A transfer of `amount` to the
  launchpad from any account moves `held` from the reverted value to the committed value.
- For a stuck Buy, the reverted value is the committed value plus `tokens`. A transfer of `tokens` back to the
  launchpad after the buyer's tokens landed moves `held` from the committed value to the reverted value, and
  Branch B then pays `vara_gross` to the trader (L656).

**I4 — mutual exclusion via `lock` + `busy`.** Established at L634 together with the `busy` checks in every
trade and graduation entrypoint (L215, L561, L627, L678, L793). This holds for every path into the window.

**I5 — the liability accounting pairs up with earlier steps.**
- Buy: `apply_buy` owed `net` (L180). Revert settles `escrow_delta` = net (L190, L197) and pays
  `vara_gross` (L656). Commit owes the fees (L1131).
- Sell: `sell` settled `gross` (L601). Revert owes `gross` (L192, L198). Commit owes the fees (L1131), and
  `pay_seller` either pays `net` or owes it into `pending_payouts` (L296-L299).

## 5. Assumptions

| # | Assumption | Established by |
|---|---|---|
| A1 | The launchpad's VFT balance changes only through its own trade/graduation calls (I1) | nothing found — inbound `Vft.Transfer` to the launchpad is unrestricted (vft/funcs.rs L41-L53) |
| A2 | At the time BalanceOf is processed, the timed-out transfer has either been fully applied or will never be applied | nothing found — `call` drops the waiter on timeout (wire.rs L80-L87); nothing cancels the original message. Ordering between the original Transfer/TransferFrom and the later BalanceOf at the VFT is a runtime property not checked here |
| A3 | `pending` (cloned pre-await, L631) still equals `launch.busy` after the await | lock + busy guards (L215, L561, L627, L678, L793); no re-check after the await |
| A4 | `real_remaining` and `pool_tokens` do not change during the await | same guards; `pool_tokens` is written only at launch (L454) |
| A5 | The `BalanceOf` reply from `token` is truthful | `token` is the spawned program from `config.vft_code_id` (L411-L413, admin-set L1005-L1009); the code identity is not verified here |
| A6 | The buyer refund `pay(trader, vara_gross)` succeeds | nothing found — result ignored at L656; liability already settled by `revert_trade` (L197), so a failed send leaves the value as untracked free balance |
| A7 | The post-await segment does not trap; otherwise the persisted `lock = true` from L634 would remain | nothing found — traps possible in `settle`/`owe` (state.rs L252-L264), `emit_event(...).expect` (L650-L651, L658-L659, and inside `commit_trade`), and gas exhaustion of the reply-handling segment (budget `gas_for_reply_deposit`, wire.rs L104). Nothing other than reconcile/graduate/unwind post-await lines writes `lock = false` |
| A8 | A stuck trade exists only in Trading or Aborted, so `commit_trade`'s Ready transition (L1104-L1108) can only fire from Trading | `check_buy` L212 (buys only in Trading), `sell` L558, graduate/unwind busy guards L678/L793 |

## 6. Callees

- `ensure_no_value` (internal, L122-L126): panics on attached value. Pre-await, so the panic reverts all
  state.
- `self.gas` (internal, L276-L278): live config copy.
- `State::launch_mut` / `State::launch` (internal, state.rs L240-L250): panic `LaunchNotFound`. The post-await
  calls (L639, L642) cannot fail because launches are never removed (no `launches.remove` found in service.rs;
  inserted only at L483).
- `exec::program_id` (gstd): self address.
- `wire::vft_balance_of` (internal, wire.rs L181-L183 → `call_typed` L90-L109 → `call` L70-L88):
  - Sends `Vft.BalanceOf(me)` with `gas_for_token_ops`, value 0, reply deposit `gas_for_reply_deposit`,
    timeout `reply_timeout`.
  - Every failure path returns `Err`: send fails → Send (L79, L82); timeout → Timeout (L85); error reply →
    Reply (L86); bad prefix/body → Decode (L47-L52).
  - The success path returns the decoded U256. This value is trusted as the balance.
  - The remote VFT (black-box at runtime; reference source in contracts/fungible-token, `balance_of`
    vft/mod.rs L152-L155) returns the stored balance or 0.
- `commit_trade` (internal, L1098-L1172): clears `busy`, books fees, possibly flips to Ready, pays/defers the
  seller, emits events. The caller relies on it to clear `busy` (L1103) on every path; it has no early
  returns.
- `revert_trade` (internal, L184-L200): restores the curve and escrow from the snapshot, clears `busy`
  (L195), and adjusts liabilities. There are no early returns. Can trap on `settle` underflow (state.rs
  L259-L264).
- `pay` → `wire::send_value` (internal, L229-L231, wire.rs L286-L291): sends with zero gas. Returns `true` for
  value 0 or a successful enqueue. The caller ignores the result.
- `emit_event` (sails): `.expect("event")` traps on error.

## 7. Shared state touched

- `Launch.lock` (W L634, L639)
- `Launch.busy` (R L630; W through commit_trade L1103 or revert_trade L195)
- `Launch.real_remaining`, `pool_tokens` (R L644-L645); `virtual_vara`/`virtual_tokens`/`real_remaining`/
  `escrow` (W revert_trade)
- `Launch.creator_fees`/`protocol_fees`/`state`/`ready_at`/`pool_vara`/`wvara_budget`/`token_budget`
  (W commit_trade)
- `State.total_liabilities` (W owe/settle)
- `State.pending_payouts` (W pay_seller)
- Native balance (out: pay, send_value)
- External: VFT balance of the launchpad (R)

## 8. Open questions

- unclear; need to inspect Gear message ordering/waitlist semantics: can the original timed-out
  `Transfer`/`TransferFrom` execute at the VFT after the later `BalanceOf` has been answered (e.g. the original
  went to the VFT's waitlist or was re-queued)? A2 depends on this.
- unclear; need to inspect gstd post-await panic semantics: confirm that a trap in the reply-resumed segment
  rolls back L639's `lock = false` and leaves L634's `lock = true` persisted (A7).
- unclear; need to inspect the RivrDEX Pair source: can the pair use the `pool_tokens` allowance from
  ApproveToken (L709) outside a launchpad-initiated AddLiquidity? That would move the Aborted-state baseline.
- unclear; need to inspect whether the code deployed under `config.vft_code_id` matches
  contracts/fungible-token (initial-supply-to-admin, transfer semantics).
- unclear; need to inspect callers/tests: no off-chain or admin path to resolve Branch C was found in
  app/src. Inspect the keeper/indexer for a manual procedure.
