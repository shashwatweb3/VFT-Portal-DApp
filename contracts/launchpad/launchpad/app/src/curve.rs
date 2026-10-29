//! Constant-product bonding curve with virtual reserves (pump.fun style), integer-only.
//!
//! All rounding favours the launchpad: buyers get `floor` tokens, sellers get `floor` VARA, the
//! cost of a capped buy is rounded `up`. Quantities: VARA in planck (12 decimals), tokens in base
//! units (18 decimals). Products are at most ~1e45, far below `U256::MAX`.

use sails_rs::prelude::*;

pub const BPS: u128 = 10_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CurveParams {
    pub v0: U256,
    pub t0: U256,
}

/// Derives the virtual reserves so that selling exactly `curve_supply` tokens nets `net_raise`
/// VARA and the final spot price equals the pool's opening price `pool_vara / pool_tokens`.
///
/// With `a = t0 - curve_supply`:  `v0 = net_raise * a / curve_supply` and
/// `(v0 + net_raise) / a = pool_vara / pool_tokens`, which solves to
/// `a = net_raise * curve_supply * pool_tokens / (pool_vara * curve_supply - net_raise * pool_tokens)`.
/// Returns `None` when the pool would open below the curve's average price (denominator <= 0).
pub fn derive_params(
    net_raise: U256,
    pool_vara: U256,
    curve_supply: U256,
    pool_tokens: U256,
) -> Option<CurveParams> {
    let lhs = pool_vara.checked_mul(curve_supply)?;
    let rhs = net_raise.checked_mul(pool_tokens)?;
    let denominator = lhs.checked_sub(rhs)?;
    if denominator.is_zero() {
        return None;
    }
    let numerator = net_raise.checked_mul(curve_supply)?.checked_mul(pool_tokens)?;
    let a = numerator / denominator;
    if a.is_zero() {
        return None;
    }
    let t0 = curve_supply.checked_add(a)?;
    let v0 = net_raise.checked_mul(a)? / curve_supply;
    Some(CurveParams { v0, t0 })
}

/// Tokens received for `vara_in` (already net of fees): `vt * dv / (vs + dv)`.
pub fn buy_tokens_out(vs: U256, vt: U256, vara_in: U256) -> U256 {
    if vara_in.is_zero() {
        return U256::zero();
    }
    vt.saturating_mul(vara_in) / (vs + vara_in)
}

/// Net VARA needed to receive exactly `tokens_out`: `ceil(vs * dt / (vt - dt))`.
pub fn buy_cost_for_tokens(vs: U256, vt: U256, tokens_out: U256) -> U256 {
    if tokens_out.is_zero() {
        return U256::zero();
    }
    let remaining = vt - tokens_out;
    let numerator = vs.saturating_mul(tokens_out);
    let (quotient, rem) = numerator.div_mod(remaining);
    if rem.is_zero() {
        quotient
    } else {
        quotient + U256::one()
    }
}

/// Gross VARA returned for `tokens_in` before fees: `vs * dt / (vt + dt)`.
pub fn sell_vara_out(vs: U256, vt: U256, tokens_in: U256) -> U256 {
    if tokens_in.is_zero() {
        return U256::zero();
    }
    vs.saturating_mul(tokens_in) / (vt + tokens_in)
}

/// Spot price scaled by 1e18: planck per token base unit times 1e18.
pub fn price_e18(vs: U256, vt: U256) -> U256 {
    if vt.is_zero() {
        return U256::zero();
    }
    vs.saturating_mul(U256::exp10(18)) / vt
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FeeSplit {
    pub net: u128,
    pub fee: u128,
    pub creator: u128,
    pub protocol: u128,
}

/// Splits a gross VARA amount into net + fee (fee_bps of gross), with `creator_bps` of gross
/// going to the creator and the remainder of the fee to the protocol.
pub fn split_fee(gross: u128, fee_bps: u16, creator_bps: u16) -> FeeSplit {
    let fee = gross * fee_bps as u128 / BPS;
    let creator = gross * creator_bps as u128 / BPS;
    let creator = creator.min(fee);
    FeeSplit {
        net: gross - fee,
        fee,
        creator,
        protocol: fee - creator,
    }
}

/// Smallest gross amount whose fee split leaves at least `net`.
pub fn gross_for_net(net: u128, fee_bps: u16) -> u128 {
    let keep = BPS - fee_bps as u128;
    let gross = net * BPS / keep;
    if split_fee(gross, fee_bps, 0).net >= net {
        gross
    } else {
        gross + 1
    }
}

/// Reserve below which a pool cannot express the listing price precisely (one base unit is then
/// more than 0.01 % of that side), so swaps alone cannot align it.
pub const MIN_ALIGNED_RESERVE: u64 = 10_000;

/// The one action that moves a seeded pair towards the listing price `pv / pt`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Align {
    /// Empty pool, or already within 1 % of the listing price.
    Aligned,
    /// Tokens too cheap: swap this much wVARA in.
    SwapWvaraIn(U256),
    /// Tokens too expensive: swap this many tokens in.
    SwapTokensIn(U256),
    /// Pool too shallow for a precise swap: deposit at its own ratio first.
    Deepen { wvara: U256, tokens: U256 },
}

/// Plans the next alignment action for a pair holding `rw` wVARA and `rt` tokens. Both
/// constant-product targets are square roots of checked products (`rw'^2 = k*pv/pt`,
/// `rt'^2 = k*pt/pv`), so nothing divides by a computed target. Swaps spend at most half a
/// budget and a deepening deposit at most a quarter. `None` means an intermediate overflowed.
pub fn plan_alignment(
    rw: U256,
    rt: U256,
    pv: U256,
    pt: U256,
    wvara_budget: U256,
    token_budget: U256,
) -> Option<Align> {
    if rw.is_zero() || rt.is_zero() || pv.is_zero() || pt.is_zero() {
        return Some(Align::Aligned);
    }
    // price = rw / rt vs target pv / pt, compared cross-multiplied; 1 % tolerance.
    let lhs = rw.checked_mul(pt)?;
    let rhs = rt.checked_mul(pv)?;
    let diff = if lhs > rhs { lhs - rhs } else { rhs - lhs };
    if diff.checked_mul(U256::from(100u32))? <= rhs {
        return Some(Align::Aligned);
    }
    let k = rw.checked_mul(rt)?;
    let rw_target = (k.checked_mul(pv)? / pt).integer_sqrt();
    let rt_target = (k.checked_mul(pt)? / pv).integer_sqrt();
    let min = U256::from(MIN_ALIGNED_RESERVE);
    if rw_target < min || rt_target < min {
        // Scale both reserves by f so that f^2*k*pv >= min^2*pt and f^2*k*pt >= min^2*pv.
        let min2 = min * min;
        let need_w = ceil_div(min2.checked_mul(pt)?, k.checked_mul(pv)?);
        let need_t = ceil_div(min2.checked_mul(pv)?, k.checked_mul(pt)?);
        let extra = need_w.max(need_t).integer_sqrt() + U256::one();
        let wvara = rw.checked_mul(extra)?;
        let tokens = rt.checked_mul(extra)?;
        if wvara <= wvara_budget / U256::from(4u32) && tokens <= token_budget / U256::from(4u32) {
            return Some(Align::Deepen { wvara, tokens });
        }
        // Too dear to deepen at this ratio: swap towards the target first; once the pool is
        // near it, deepening is cheap.
    }
    // The pair takes 0.35 % (0.30 LP + 0.05 treasury) of the input; gross the input up for it.
    let gross = |net: U256| Some(net.checked_mul(U256::from(10_000u32))? / U256::from(9_965u32) + U256::one());
    if rw < rw_target {
        Some(Align::SwapWvaraIn(gross(rw_target - rw)?.min(wvara_budget / U256::from(2u32))))
    } else {
        Some(Align::SwapTokensIn(gross(rt_target.saturating_sub(rt))?.min(token_budget / U256::from(2u32))))
    }
}

fn ceil_div(a: U256, b: U256) -> U256 {
    let (q, r) = a.div_mod(b);
    if r.is_zero() {
        q
    } else {
        q + U256::one()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const M: u128 = 1_000_000;
    const TOKEN: u128 = 1_000_000_000_000_000_000; // 1e18
    const VARA: u128 = 1_000_000_000_000; // 1e12

    fn tokens(n_millions: u128) -> U256 {
        U256::from(n_millions * M) * U256::from(TOKEN)
    }

    fn vara(whole: u128) -> U256 {
        U256::from(whole) * U256::from(VARA)
    }

    /// The plan's worked example in USD-as-VARA units: raise 600, net 594, pool 592, 800M/200M.
    #[test]
    fn derive_params_matches_plan_numbers() {
        let p = derive_params(vara(594), vara(592), tokens(800), tokens(200)).unwrap();
        let a = p.t0 - tokens(800);
        // a ≈ 267.9M tokens, t0 ≈ 1,067.9M, v0 ≈ 198.9 VARA
        let a_millions = (a / U256::from(TOKEN) / U256::from(M)).as_u128();
        assert!((267..=268).contains(&a_millions), "a = {a_millions}M");
        let v0_whole = (p.v0 / U256::from(VARA)).as_u128();
        assert!((198..=199).contains(&v0_whole), "v0 = {v0_whole}");
    }

    #[test]
    fn selling_out_the_curve_raises_the_net_target() {
        let p = derive_params(vara(594), vara(592), tokens(800), tokens(200)).unwrap();
        let cost = buy_cost_for_tokens(p.v0, p.t0, tokens(800));
        // cost == net raise up to integer rounding of the derived params (< 1 VARA here)
        let diff = if cost > vara(594) { cost - vara(594) } else { vara(594) - cost };
        assert!(diff < vara(1), "cost {cost} vs 594 VARA");
    }

    #[test]
    fn final_curve_price_equals_pool_opening_price() {
        let p = derive_params(vara(594), vara(592), tokens(800), tokens(200)).unwrap();
        let cost = buy_cost_for_tokens(p.v0, p.t0, tokens(800));
        let vs_final = p.v0 + cost;
        let vt_final = p.t0 - tokens(800);
        let curve = price_e18(vs_final, vt_final);
        let pool = price_e18(vara(592), tokens(200));
        let diff = if curve > pool { curve - pool } else { pool - curve };
        // within 0.1 %
        assert!(diff * U256::from(1000u32) < pool, "curve {curve} pool {pool}");
    }

    #[test]
    fn round_trip_never_favours_the_trader() {
        let p = derive_params(vara(594), vara(592), tokens(800), tokens(200)).unwrap();
        let (mut vs, mut vt) = (p.v0, p.t0);
        for i in 1..50u128 {
            let dv = U256::from(i * 7) * U256::from(VARA) / U256::from(10u32);
            let out = buy_tokens_out(vs, vt, dv);
            vs += dv;
            vt -= out;
            let back = sell_vara_out(vs, vt, out);
            assert!(back <= dv, "step {i}: got back {back} for {dv}");
            vs -= back;
            vt += out;
        }
    }

    #[test]
    fn buy_cost_inverts_tokens_out() {
        let p = derive_params(vara(594), vara(592), tokens(800), tokens(200)).unwrap();
        let dv = vara(37);
        let out = buy_tokens_out(p.v0, p.t0, dv);
        let cost = buy_cost_for_tokens(p.v0, p.t0, out);
        assert!(cost <= dv);
        assert!(buy_tokens_out(p.v0, p.t0, cost) >= out);
    }

    #[test]
    fn fee_split_is_exact() {
        let s = split_fee(10_000 * VARA, 100, 50);
        assert_eq!(s.fee, 100 * VARA);
        assert_eq!(s.creator, 50 * VARA);
        assert_eq!(s.protocol, 50 * VARA);
        assert_eq!(s.net, 9_900 * VARA);
        let g = gross_for_net(s.net, 100);
        assert!(split_fee(g, 100, 50).net >= s.net);
        // sufficient and within one planck of the exact inverse (floor fee rounding)
        assert!(g <= s.net * BPS / (BPS - 100) + 1);
        assert!(split_fee(g - 2, 100, 50).net < s.net);
    }

    #[test]
    fn derive_params_rejects_pool_below_average_price() {
        // pool 100 with net 594 would need the pool to open below the curve's average price
        assert!(derive_params(vara(594), vara(100), tokens(800), tokens(200)).is_none());
    }

    /// Listing price of the test config: ~592 VARA against 200M tokens.
    fn listing() -> (U256, U256) {
        (vara(592), tokens(200))
    }

    fn off_by_percent(rw: U256, rt: U256) -> U256 {
        let (pv, pt) = listing();
        let (lhs, rhs) = (rw * pt, rt * pv);
        let diff = if lhs > rhs { lhs - rhs } else { rhs - lhs };
        diff * U256::from(10_000u32) / rhs // basis points
    }

    /// Applies an action to a frictionless constant-product pool (fees ignored, which only
    /// makes the gross-up overshoot slightly).
    fn apply(rw: U256, rt: U256, action: Align) -> (U256, U256) {
        match action {
            Align::Aligned => (rw, rt),
            Align::SwapWvaraIn(a) => (rw + a, rt - rt * a / (rw + a)),
            Align::SwapTokensIn(a) => (rw - rw * a / (rt + a), rt + a),
            Align::Deepen { wvara, tokens } => (rw + wvara, rt + tokens),
        }
    }

    #[test]
    fn dust_seed_is_deepened_then_aligned_without_dividing_by_zero() {
        let (pv, pt) = listing();
        let (mut rw, mut rt) = (U256::from(1_001u32), U256::from(1_001u32));
        let mut actions = Vec::new();
        for _ in 0..4 {
            let a = plan_alignment(rw, rt, pv, pt, pv, pt).expect("no overflow");
            actions.push(a);
            if a == Align::Aligned {
                break;
            }
            (rw, rt) = apply(rw, rt, a);
        }
        assert!(matches!(actions[0], Align::Deepen { .. }), "{actions:?}");
        assert_eq!(*actions.last().unwrap(), Align::Aligned, "{actions:?}");
        assert!(off_by_percent(rw, rt) <= U256::from(100u32));
        if let Align::Deepen { wvara, .. } = actions[0] {
            assert!(wvara < vara(1), "deepening a dust seed costs dust: {wvara}");
        }
    }

    #[test]
    fn far_off_seeds_converge_from_either_side() {
        let (pv, pt) = listing();
        let seeds = [
            (U256::from(1_000_000u64), tokens(1)),       // tokens far too cheap
            (vara(20), tokens(1) / U256::from(1_000u32)), // tokens far too expensive
            (vara(1), U256::from(1u32)),                 // one base unit of token
            (U256::from(1u32), U256::from(10_000_000u64)),
        ];
        for (seed_w, seed_t) in seeds {
            let (mut rw, mut rt) = (seed_w, seed_t);
            let mut done = false;
            for _ in 0..8 {
                match plan_alignment(rw, rt, pv, pt, pv, pt).expect("no overflow") {
                    Align::Aligned => {
                        done = true;
                        break;
                    }
                    a => (rw, rt) = apply(rw, rt, a),
                }
            }
            assert!(done, "seed {seed_w}/{seed_t} did not converge: {rw}/{rt}");
        }
    }

    #[test]
    fn aligned_and_empty_pools_need_nothing() {
        let (pv, pt) = listing();
        assert_eq!(plan_alignment(U256::zero(), U256::zero(), pv, pt, pv, pt), Some(Align::Aligned));
        assert_eq!(plan_alignment(pv / 1000, pt / 1000, pv, pt, pv, pt), Some(Align::Aligned));
    }

    #[test]
    fn huge_reserves_report_overflow_instead_of_trapping() {
        let (pv, pt) = listing();
        assert_eq!(plan_alignment(U256::MAX / 2, U256::MAX / 2, pv, pt, pv, pt), None);
    }
}
