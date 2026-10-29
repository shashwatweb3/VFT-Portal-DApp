# Invariants

Each invariant names where it is enforced and which test checks it.

| # | Invariant | Enforced in | Checked by |
|---|---|---|---|
| I1 | `total_liabilities == Σ_launches(escrow + creator_fees + protocol_fees) + Σ pending_payouts` | `State::owe/settle` on every value movement (`state.rs`) | `sell_returns_less_than_paid_and_keeps_invariants`, `curve_product_never_decreases_and_program_stays_solvent`, `dust_sells_…`, graduation tests |
| I2 | Program balance ≥ `total_liabilities` (solvency); the excess is the operating reserve | Value only leaves via sell payouts, refunds, claims, wVARA mint (pool), CreatePair fee | `curve_product_never_decreases_and_program_stays_solvent`, `failed_step_is_resumable_…`, `unwind_after_wrap_…`, devnet smoke |
| I3 | Curve product never decreases: `virtual_vara × virtual_tokens ≥ v0 × t0` | Floor rounding on outputs, ceil on capped buy cost (`curve.rs`) | `round_trip_never_favours_the_trader` (unit), `curve_product_never_decreases_…` |
| I4 | `escrow == virtual_vara − v0` while trading | `apply_buy`, sell path, `revert_trade` | `sell_returns_less_than_paid_…`, `curve_product_never_decreases_…` |
| I5 | `sold ≤ curve_supply`; the launch flips to `Ready` exactly when `sold == curve_supply` | Sell-out cap in `plan_buy`; flip in `commit_trade` | `sell_out_caps_the_last_buy_refunds_excess_and_flips_ready` |
| I6 | VFT roles: `{launchpad}` until the three revoke steps of graduation, `∅` after; creator never holds a role | `launch` sets `admin_id = program_id`; revoke steps in order | `launch_spawns_vft_…`, `graduation_lists_on_rivrdex_…` |
| I7 | Max supply = initial supply = 1e27 base units; nothing can mint | VFT `max_supply` has no setter; launch passes equal values | `launch_spawns_vft_…` |
| I8 | No trade while `busy` or `lock` is set or state ≠ Trading (sells also allowed in Aborted) | `check_buy`, sell guard | `interleaved_trade_…`, `trades_are_rejected_while_graduating_and_after` |
| I9 | Graduation steps are idempotent; a re-run after success is a no-op | balance/reserve/role re-queries per step | `failed_step_is_resumable_…`, `concurrent_graduate_calls_…` |
| I10 | At `Graduated`: pool holds `pool_vara` wVARA + 200M tokens at the curve price (plus any pre-seed), launchpad holds 0 wVARA, 0 curve tokens, 0 LP; LP at `LP_DEAD` | graduation steps 5–11 | `graduation_lists_on_rivrdex_…`, `pre_seeded_pair_with_reserves_…`, devnet smoke |
| I11 | Pool opening price equals the curve's final price within rounding (no instant arb) | `derive_params` | `final_curve_price_equals_pool_opening_price` (unit), `graduation_price_is_continuous_with_the_curve` (≤ 0.3 %) |
| I12 | A rejected call with attached value returns it (trap before first await) | all validation before awaits | `buy_rejects_slippage_and_returns_value`, `first_buy_slippage_…` |
