# Threat model

## Assets

1. **Escrowed VARA** per launch: what buyers paid in, net of fees. Owed back to sellers at the curve price until graduation, then moves to the RivrDEX pool.
2. **Accrued fees**: creator and protocol shares, pull-claimed.
3. **Pending payouts**: sell proceeds below the existential deposit, claimable once they reach it.
4. **Operating reserve**: operator-funded VARA that pays child-program deposits and the 1 VARA RivrDEX pair-creation fee shortfall.
5. **Curve token supply**: 1,000,000,000 tokens held by the launchpad until sold or pooled.
6. **Token integrity**: no one can mint, burn or kill a curve token after launch except the launchpad, and no one at all after graduation.
7. **Issuer/keeper hot wallets** (off-chain service).

## Actors

| Actor | Can | Must not be able to |
|---|---|---|
| Buyer / seller | Buy, sell, claim own pending payout, call Graduate/Unwind/Reconcile | Receive more than the curve price; move others' funds; trade during graduation |
| Creator | Launch (optionally with a first buy), claim creator fees | Hold any VFT role; mint, burn, kill, change metadata; withdraw escrow |
| Launchpad admin (multisig in production) | Set future-launch parameters, gas budgets, addresses, pause buys, top up reserve | Touch escrow, fees or a live launch's frozen parameters; pause sells or claims |
| Keeper (any account) | Drive graduation and unwinds | Anything else; graduation is permissionless |
| Griefer | Create the RivrDEX pair first, seed it at any ratio, donate tokens/LP/wVARA, spam launches | Block graduation permanently, strand funds, make the pool open at a price that lets them drain it |
| RivrDEX / wVARA programs | Execute calls we send | (trusted third party; failures handled as recorded steps) |

## Trust boundaries

- Launchpad ⇄ VFT: the launchpad is the VFT's only admin/minter/burner until it renounces at graduation.
- Launchpad ⇄ RivrDEX Factory/Pair and wVARA: async messages with explicit gas, reply deposit and `up_to` timeouts. Their errors are panics; the launchpad records them as a failed step.
- Voucher server ⇄ chain: the issuer pays gas only (vouchers cannot carry value; verified in `pallets/gear/src/lib.rs:1830-1840`).
- Indexer ⇄ chain: read-only. The UI never derives trade permission or graduation state from the indexer.

## Attacks and controls

| # | Attack | Control | Evidence |
|---|---|---|---|
| A1 | Creator rugs via VFT roles (burn curve inventory, mint, kill) | Launchpad is the only role holder; `initial_supply == max_supply`; roles renounced minter → burner → admin at graduation | `ex_burner_cannot_burn_curve_inventory_and_creator_holds_no_roles`, `graduation_lists_on_rivrdex_burns_lp_and_renounces_roles` |
| A2 | Interleaved trades corrupt the curve while a transfer is in flight | Per-launch `busy` lock; second trade traps before any await (value returns) | `interleaved_trade_is_rejected_while_one_is_in_flight` |
| A3 | Two Graduate (or Graduate + Unwind) calls in one block run a step twice | Per-launch `lock` held across the step's awaits | `concurrent_graduate_calls_run_the_step_once` |
| A4 | Value kept after a post-await panic | No panics after an await; every post-await failure refunds explicitly; first-buy slippage checked before the spawn | `first_buy_slippage_is_rejected_before_the_spawn`, `spawn_failure_releases_the_name_and_refunds_the_first_buy`, `failed_transfer_reverts_curve_and_refunds_buyer` |
| A5 | Pair pre-created and seeded at a bad ratio (dust, huge, or over-priced) | `AlignPrice` swaps the pool to the curve's final price before depositing; deposit only at the target ratio; leftover tokens to `LP_DEAD`, leftover wVARA (the seeder's) to protocol | `fb_preseed_*` (3), `pre_seeded_pair_with_reserves_…` |
| A6 | Donated LP or someone else's reserves trick graduation into skipping AddLiquidity | Resume detection compares reserves against a snapshot taken just before our own deposit | `fb_preseed_large_reserves_skips_add_liquidity`, `fb_donations_do_not_strand_value` |
| A7 | A step fails mid-graduation and funds strand | Steps are idempotent and resumable; steps 1–4 unwindable; stale `Ready` unwindable after the timeout; sells reopen at the frozen curve | `failed_step_is_resumable_and_charges_the_pair_fee_once`, `unwind_after_wrap_recovers_the_pool_vara_for_sellers`, `stale_ready_launch_can_be_unwound_and_sold_back` |
| A8 | Reply timeout then late execution double-spends | Timeout marks the trade `stuck`; only `Reconcile` (reading the real VFT balance) resolves it | code only; timeouts cannot be produced in gtest (gap) |
| A9 | Dust sells to a fresh account fail below ED | Payouts below ED are deferred to `pending_payouts` and claimable | `dust_sells_are_deferred_until_they_reach_the_existential_deposit` |
| A10 | Admin steals funds | No admin value-out; parameter changes affect future launches only (each launch snapshots addresses and fees) | code review |
| A11 | Launch spam drains the operator | Per-creator launch cooldown on chain; voucher per wallet per 24 h, per-IP and global caps, issuer floor, 10-minute lifetime, sized to one launch's gas; `LowReserve` stops launches below `min_free_balance` | `voucher-server/test/unit.test.ts`, `launch_refuses_when_operating_reserve_is_too_low`, devnet `gasless.ts` |
| A12 | Impersonation / illegal content | ASCII-only, case- and whitespace-normalised name uniqueness; terms with on-chain `terms_hash`; proxy magic-byte sniffing, size/rate limits, upload logging | `fb_limits_and_name_uniqueness`; proxy probes; reserved-name list not implemented |
