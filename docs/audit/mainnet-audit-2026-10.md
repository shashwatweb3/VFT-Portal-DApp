# Curve Launch: pre-mainnet security audit (internal, AI-assisted)

**Verdict: NOT READY FOR MAINNET.** There are 4 critical and 3 high-severity issues, several of them reproduced by executable tests. An external audit is still required after the fixes.

## Method
- **Rust security review:** 15 bug-class workers, plus dedup and false-positive/severity judges. Output in runs/rust-review-20261022/.
- **Gear/Sails semantics review:** checked against the gstd 1.10 / sails 0.10.2 / core-processor sources. Output in runs/gear-review.md.
- **Function-level context dossier:** contracts/launchpad/launchpad/audit-context/.
- **False-positive verification:** fp-check (runs/fp-check-batch1..4.md).
- **Executable proofs of concept:** contracts/launchpad/launchpad/tests/audit_poc.rs.
- **Dimensional analysis:** Step 1 only (scoping). The annotation steps were not run, because they edit contract source.

## Findings to fix before mainnet
| # | Severity | Issue | Status |
|---|---|---|---|
| 1 | Critical | A cross-program call whose reply deposit fails after the message was queued is treated as "not sent", so trades are reverted while the transfer still executes | Reproduced |
| 2 | Critical | Graduation price alignment can divide by zero on a dust-seeded pair, freezing the launch | Reproduced |
| 3 | Critical | Any trap or out-of-gas after an await leaves a launch's lock/busy flag set forever (graduate, buy, sell) | Reproduced |
| 4 | High | The same freeze reaches reconcile and unwind, the recovery paths | Code-traced |
| 5 | High | A forced early graduation failure can be unwound immediately, aborting the listing | Code-traced |
| 6 | Medium | AddLiquidity resume trusts a stale reserve snapshot | Code-traced |
| 7 | Medium | Reconcile requires an exact balance match | Code-traced |
| 8 | Medium | Zero-gas payouts to program accounts (for example a multisig treasury) bounce but are booked as paid | Code-traced |
| 9 | Medium | Admin gas and timeout settings affect live launches with no bounds | Code-traced |
| 10 | Medium | Swap timeout during alignment leaves budgets stale (conditional) | Code-traced |
| 11 | Medium | State grows without bound; the launches query is not paginated | Analytic |
| 12 | Low/Med | The one-trade-at-a-time lock per launch limits throughput on popular curves | Code-traced |

## Remediation plan
1. **Call wrapper:** any failure after the message is queued must trap (reverting the send) or be treated as "stuck", never "not sent".
2. **Gas guard:** at the start of every async entrypoint, require enough gas for all sends, deposits and continuations, before any state change.
3. **Lock expiry:** record the block at which lock/busy was set. Once it is older than the reply timeout plus a margin, permissionless recovery can clear it. Optionally also add a gstd critical hook.
4. **Price alignment:** compute both targets with overflow-checked square roots and no division by a computed target. Handle dust pools explicitly. No unchecked arithmetic after an await.
5. **Unwind delay:** require Failed to persist for the graduation timeout before an early unwind.
6. **AddLiquidity resume:** clear the snapshot on definitive failures, and detect a landed deposit from our own LP balance change.
7. **Reconcile:** use a `>=` comparison and treat surplus as a donation.
8. **Payouts:** use pull claims with reply tracking, or re-credit failed sends to pending payouts. Mark sends `#[must_use]`.
9. **Admin config:** snapshot gas and timeout per launch; bound setters; validate the curve parameters in every config setter.
10. **Scale:** prune graduated launches from hot state, paginate queries, and consider fire-and-forget buys to remove the per-launch trade lock.
11. **Hardening:** workspace lint policy (`forbid(unsafe_code)`, `deny(unused_must_use)`); declared `rust-version`; reproducible wasm hashes.

## Checked and found sound
- Pre-await validation returns value on rejection.
- Curve rounding never favours the trader.
- Slippage and deadline are enforced.
- The escrow-exhaustion guard holds.
- Token roles are held only by the launchpad until renounced.
- Fees are fixed per launch at creation.
- Replies cannot be spoofed.
- No handler iterates an unbounded collection.

## Remediation status (2026-10-26)
All 11 plan items are implemented in `contracts/launchpad`. Regression tests live in `tests/audit_poc.rs` (all 4 PoCs pass), `tests/hardening.rs` and the `launchpad-app` unit tests.

| Item | Change | Test |
|---|---|---|
| 1 Call wrapper | Send with no deposit, then charge the deposit and set the timeout, trapping on failure so the send is reverted | `poc_gear_c1_*` |
| 2 Gas guard | **Changed design.** An up-front guard cannot ship on Gear: `gas_available` is forbidden during RPC gas estimation, and any headroom check beyond actual use fails the estimator's second pass, so no wallet could send. Instead each locking entrypoint sets a gstd critical hook (`on_trap`), and gstd system-reserves gas for it. A continuation that runs dry or panics releases its lock or marks its trade stuck at once. Config bounds keep the costliest message under the block limit | `poc_cancelsafety_001_*`, `starved_graduate_at_any_gas_leaves_the_launch_resumable`, `starved_buy_at_any_gas_is_recoverable` |
| 3 Lock expiry | `lock_expires_at` and `PendingTrade::expires_at`; `graduate`, `unwind` and `reconcile` resume once a deadline passes. This is the backstop behind the critical hook from item 2 (the plan's optional part) | `in_flight_trades_expire_at_their_deadline` (unit); the hook itself is covered by the item 2 tests |
| 4 Price alignment | `curve::plan_alignment` (checked square roots, deepening of dust pools, exact approvals); checked arithmetic after awaits | `poc_arithofl_001_*`, `dust_seed_lists_at_the_curve_price`, curve unit tests |
| 5 Unwind delay | `failed_since` is kept across failed retries; an early unwind needs `graduation_timeout_blocks` | `forced_early_failure_is_retried_not_unwound`, `persistent_early_failure_unwinds_after_the_timeout` |
| 6 AddLiquidity resume | The snapshot is our own (token, LP) balances; it is cleared on rejection; a resume revokes allowances before resolving; AlignPrice is never re-run over an unresolved deposit | `rejected_deposit_is_redone_after_third_party_liquidity` |
| 7 Reconcile | `>=` matching; a donation-made ambiguity resolves in the trader's favour | `reconcile_tolerates_donations_and_favours_the_trader` (unit) |
| 8 Payouts | Tracked value sends plus a `#[handle_reply]` re-credit of bounces; claims pay in the reply; `send_value` is `#[must_use]` | `bounced_payout_to_a_program_is_recredited_and_claimable` |
| 9 Admin config | `validate_config` runs in the constructor and every setter; the graduation timeout is frozen per launch; gas is bounded rather than snapshotted, so live launches stay fixable if costs rise | `admin_setters_are_bounded_and_live_launches_keep_their_timeout` |
| 10 Scale | `MAX_LAUNCHES` cap (10 000, about 14 MB of the 32 MiB limit), `LaunchesPage`/`LaunchCount`. Fire-and-forget buys were not adopted: the per-launch lock is what makes trade reverts safe | `launches_are_paged` |
| 11 Hardening | Workspace lints (`forbid(unsafe_code)`, `deny(unused_must_use)`), `rust-version = 1.91.0`, `scripts/wasm-hashes.sh` producing `wasm-hashes.txt` | Clean rebuilds reproduce the hashes on the build machine |

Real node: `devnet` deploy + `smoke.ts` pass against a local `gear --dev` 1.10 node using RPC gas estimation (launch, buy, sell, sell-out, all graduation steps, LP burned). That run is what exposed the gas-estimation problem in item 2.

### Post-remediation review (2026-10-28)
A fresh review of the remediated contract found further issues, fixed as below. The smoke run above was repeated on the fixed build and passes.

| Issue | Fix | Test |
|---|---|---|
| wVARA was tracked by one shared balance: a wrap whose continuation trapped, or whose reply timed out but landed, left its mint unbooked, so another launch's `Settle` could burn it as leftover and the program end a pool short. `Settle`'s own burn had the same gap on retry | Mints and burns are recorded in `wvara_in_flight` when sent and booked in `#[handle_reply]`, which runs on the reply deposit whatever the continuation does; `Settle` measures leftover only while nothing is in flight | `wvara_ops_are_booked_by_their_reply` (unit). gtest could not produce the starved window for `WrapVara`: below the threshold the whole message reverts |
| A pair seeded deep and far off the curve price could never be aligned, and AlignPrice is not unwindable, so the escrow froze | After `MAX_ALIGN_ROUNDS` (8) actions, or once the budget is spent, the launch lists at the pool's own price | `deep_mispriced_seed_still_lists` (fails with the cap removed) |
| A launch starved after its spawn cleared the creator's cooldown, so the reserve could be drained one existential deposit at a time | The trap hook keeps the cooldown | (one-line change) |
| `pair_created_by_us` was set after the `CreatePair` reply, so a starved continuation left the pair fee on the reserve | Set before the send; cleared only if the send failed or was rejected | (one-line change) |
| A `Decode` error on a trade transfer reverted the trade, though the VFT had replied with success | Treated like a timeout: the trade is marked stuck and reconciled from balances | existing trade tests |
| `NameTaken` normalised names differently from `Launch` | One `name_key` function | `launch_rejects_duplicate_names_case_insensitively` |
| `QuoteSell` capped at the escrow while `Sell` rejects such a sale | The quote returns zero output | — |

Not changed: `Launch` still reports `Ok` when the creator's first buy failed (the buy's own events and the refund show it), and `validate_config` still duplicates the curve derivation.

Still required before mainnet: a public-testnet run with the real keeper, including forced failures (gtest delivers replies in-block, so timeouts and lost replies were not exercised end to end); cross-machine confirmation of the wasm hashes; and the external audit.
