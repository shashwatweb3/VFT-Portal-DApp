//! defect: run them with `cargo test --test feedback -- --ignored` to see the failing assertion.
mod common;

use common::*;
use launchpad_app::{curve, wire::encode_call};
use launchpad_client::{launchpad::Launchpad as _, Addrs, GradStep, LaunchState, LaunchpadError};
use sails_rs::{gtest::System, prelude::*};

// ------------------------------------------------------------------------------- helpers

/// Program-wide invariants: held >= owed; owed == sum of per-launch books + pending payouts;
/// k never below its initial value; escrow covers selling every outstanding token back.
async fn inv(h: &Harness, launches: &[ActorId], traders: &[u64], label: &str) {
    let liab = h.liabilities().await;
    let bal = h.program_balance();
    assert!(bal >= liab, "[{label}] balance {bal} < liabilities {liab}");
    let mut sum = 0u128;
    for t in launches {
        let i = h.info(*t).await;
        sum += i.escrow + i.creator_fees + i.protocol_fees;
        assert!(
            i.virtual_vara * i.virtual_tokens >= i.v0 * i.t0,
            "[{label}] k decreased"
        );
        if matches!(i.state, LaunchState::Trading | LaunchState::Aborted) {
            let sold = i.curve_supply - i.real_remaining;
            let all_back = curve::sell_vara_out(i.virtual_vara, i.virtual_tokens, sold);
            assert!(
                all_back <= U256::from(i.escrow),
                "[{label}] escrow {} cannot cover selling all {sold} back ({all_back})",
                i.escrow
            );
        }
        for who in traders {
            sum += h.svc().pending_payout(*t, actor(*who)).await.unwrap();
        }
    }
    assert_eq!(liab, sum, "[{label}] liabilities != sum of books");
}

async fn try_sell(h: &Harness, token: ActorId, who: u64, amount: U256) -> String {
    assert!(vft_approve(h.system(), token, who, h.launchpad_id, amount));
    let r = h
        .svc()
        .sell(token, amount, 0, u32::MAX)
        .with_params(|p| p.with_actor_id(actor(who)))
        .await;
    err_text(&r)
}

async fn grad(h: &Harness, token: ActorId) -> Result<GradStep, LaunchpadError> {
    h.svc()
        .graduate(token)
        .with_params(|p| p.with_actor_id(actor(KEEPER)))
        .await
        .expect("graduate call")
}

async fn grad_to_done(h: &Harness, token: ActorId) {
    for _ in 0..20 {
        if grad(h, token).await.unwrap_or_else(|e| core::panic!("grad: {e:?}")) == GradStep::Done {
            return;
        }
    }
    core::panic!("never reached Done");
}

fn raw_ok(system: &System, dest: ActorId, from: u64, payload: Vec<u8>, value: u128) {
    call_raw(system, dest, from, payload, value);
}

/// Attacker wraps `wvara_amt`, creates the pair if needed and seeds it with the given amounts.
fn seed_pair(h: &Harness, who: u64, token: ActorId, wvara_amt: U256, token_amt: U256) -> ActorId {
    let system = h.system();
    let mint = (wvara_amt.low_u128()).max(vara(1));
    raw_ok(system, h.wvara, who, encode_call("VftNativeExchange", "Mint", ()), mint);
    let mut pair = factory_get_pair(system, h.factory, h.wvara, token);
    if pair.is_zero() {
        raw_ok(system, h.factory, who, encode_call("Factory", "CreatePair", (h.wvara, token)), vara(1));
        pair = factory_get_pair(system, h.factory, h.wvara, token);
    }
    assert!(vft_approve(system, h.wvara, who, pair, wvara_amt));
    assert!(vft_approve(system, token, who, pair, token_amt));
    let (t0, _) = pair_tokens(system, pair);
    let (a0, a1) = if t0 == h.wvara { (wvara_amt, token_amt) } else { (token_amt, wvara_amt) };
    let program = system.get_program(pair).unwrap();
    let mid = program.send_bytes_with_gas(
        who,
        encode_call("Pair", "AddLiquidity", (a0, a1, U256::zero(), U256::zero(), u64::MAX)),
        300_000_000_000,
        0,
    );
    let res = system.run_next_block();
    assert!(res.succeed.contains(&mid), "seed AddLiquidity");
    system.run_to_block(system.block_height() + 3);
    pair
}

fn wvara_side(h: &Harness, pair: ActorId) -> (U256, U256) {
    let (t0, _) = pair_tokens(h.system(), pair);
    let (r0, r1) = pair_reserves(h.system(), pair);
    if t0 == h.wvara { (r0, r1) } else { (r1, r0) }
}

// ------------------------------------------------------------- 1. value conservation

#[tokio::test]
async fn fb_value_conservation_through_full_lifecycle() {
    let h = setup().await;
    let traders = [CREATOR, BUYER, BUYER2];
    let token = h
        .svc()
        .launch(meta("Cons One", "C1"), [1u8; 32], U256::zero())
        .with_params(|p| p.with_actor_id(actor(CREATOR)).with_value(vara(20)))
        .await
        .unwrap()
        .unwrap();
    let ls = [token];
    inv(&h, &ls, &traders, "launch+first buy").await;
    h.buy(token, BUYER, vara(1)).await;
    inv(&h, &ls, &traders, "min buy").await;
    let r = h.buy(token, BUYER, vara(150)).await;
    inv(&h, &ls, &traders, "buy 150").await;
    h.sell(token, BUYER, r.tokens / 3).await;
    inv(&h, &ls, &traders, "sell 1/3").await;
    // Dust sells (net < ED) are deferred; three of them still stay below ED.
    for i in 0..3 {
        h.sell(token, BUYER, tokens(1_000_000)).await;
        inv(&h, &ls, &traders, &format!("dust {i}")).await;
    }
    let dust = h.svc().pending_payout(token, actor(BUYER)).await.unwrap();
    assert!(dust > 0);
    let claim = h.svc().claim_payout(token).with_params(|p| p.with_actor_id(actor(BUYER))).await.unwrap();
    println!("dust pending {dust}, claim -> {claim:?}");
    // Sell-out with a large refund.
    let before = h.program_balance();
    let r = h.buy(token, BUYER2, vara(5_000)).await;
    assert!(r.completed_curve);
    assert!(h.program_balance() - before < vara(1_000), "excess refunded");
    inv(&h, &ls, &traders, "sell-out").await;
    h.svc().claim_creator_fees(token).with_params(|p| p.with_actor_id(actor(CREATOR))).await.unwrap().unwrap();
    inv(&h, &ls, &traders, "creator claim").await;
    // Graduate step by step, checking every step.
    loop {
        let s = grad(&h, token).await.unwrap();
        inv(&h, &ls, &traders, &format!("grad -> {s:?}")).await;
        if s == GradStep::Done {
            break;
        }
    }
    h.svc().claim_protocol_fees(token).with_params(|p| p.with_actor_id(actor(KEEPER))).await.unwrap().unwrap();
    inv(&h, &ls, &traders, "protocol claim").await;
    // After everything: the only liability left is the stranded dust payout.
    let leftover = h.liabilities().await;
    println!("final liabilities {leftover}, free {}", h.program_balance() - leftover);
    assert_eq!(leftover, 0, "nothing stays owed once everything is claimed");
    assert_eq!(vft_balance(h.system(), token, h.launchpad_id), U256::zero());
    assert_eq!(vft_balance(h.system(), h.wvara, h.launchpad_id), U256::zero());
    // Unwind on Graduated is refused.
    let u = h.svc().unwind(token).with_params(|p| p.with_actor_id(actor(KEEPER))).await;
    assert!(err_text(&u).contains("NotUnwindable"), "{}", err_text(&u));
}

/// After an unwind from a step at which the pair fee was already spent, escrow is short of the
/// curve's sell-back obligation by the pair fee, so the last holders cannot fully exit.
#[tokio::test]
async fn fb_unwind_after_pair_created_strands_last_sellers() {
    let h = setup().await;
    let token = h.launch("Unwind Short", "US").await;
    h.buy(token, BUYER, vara(300)).await;
    h.buy(token, BUYER2, vara(1_000)).await;
    assert_eq!(grad(&h, token).await.unwrap(), GradStep::FindOrCreatePair);
    assert_eq!(grad(&h, token).await.unwrap(), GradStep::ApproveToken); // pair created, fee spent
    let mut gas = gas_config();
    gas.gas_for_token_ops = 1_000_000;
    h.set_gas(gas).await;
    assert!(grad(&h, token).await.is_err());
    h.set_gas(gas_config()).await;
    h.system().run_to_block(h.system().block_height() + 1_001);
    h.svc().unwind(token).with_params(|p| p.with_actor_id(actor(KEEPER))).await.unwrap().unwrap();
    assert_eq!(h.info(token).await.state, LaunchState::Aborted);
    let b1 = vft_balance(h.system(), token, actor(BUYER));
    let b2 = vft_balance(h.system(), token, actor(BUYER2));
    let first = try_sell(&h, token, BUYER, b1).await;
    let last = try_sell(&h, token, BUYER2, b2).await;
    println!("first: {first}\nlast: {last}");
    assert!(!last.contains("EscrowExhausted"), "last seller blocked: {last}");
}

// ---------------------------------------------------------------------- 2. concurrency

#[tokio::test]
async fn fb_concurrency_locks_hold() {
    let h = setup().await;
    let token = h.launch("Conc One", "CC").await;
    let r = h.buy(token, BUYER, vara(100)).await;
    // buy + sell in the same block
    assert!(vft_approve(h.system(), token, BUYER, h.launchpad_id, r.tokens));
    let b = queue_launchpad_call(&h, BUYER2, "Buy", (token, U256::zero(), u32::MAX), vara(10));
    let s = queue_launchpad_call(&h, BUYER, "Sell", (token, r.tokens / 2, 0u128, u32::MAX), 0);
    let res = h.system().run_next_block();
    assert!(res.succeed.contains(&b) && res.failed.contains(&s), "sell must hit busy lock");
    h.system().run_next_block();
    inv(&h, &[token], &[BUYER, BUYER2], "buy+sell").await;
    // sell + sell same block
    let s1 = queue_launchpad_call(&h, BUYER, "Sell", (token, r.tokens / 4, 0u128, u32::MAX), 0);
    let s2 = queue_launchpad_call(&h, BUYER, "Sell", (token, r.tokens / 4, 0u128, u32::MAX), 0);
    let res = h.system().run_next_block();
    assert!(res.succeed.contains(&s1) && res.failed.contains(&s2));
    h.system().run_next_block();
    inv(&h, &[token], &[BUYER, BUYER2], "sell+sell").await;
    // reconcile when not stuck
    let rc = h.svc().reconcile(token).with_params(|p| p.with_actor_id(actor(KEEPER))).await;
    assert!(err_text(&rc).contains("NotStuck"), "{}", err_text(&rc));
    // completing buy + graduate in one block: graduate sees busy
    let b = queue_launchpad_call(&h, BUYER2, "Buy", (token, U256::zero(), u32::MAX), vara(2_000));
    let g = queue_launchpad_call(&h, KEEPER, "Graduate", (token,), 0);
    let res = h.system().run_next_block();
    assert!(res.succeed.contains(&b) && res.failed.contains(&g));
    h.system().run_next_block();
    assert_eq!(h.info(token).await.state, LaunchState::Ready);
    // two creator claims in one block: paid once
    let before = h.balance(CREATOR);
    let c1 = queue_launchpad_call(&h, CREATOR, "ClaimCreatorFees", (token,), 0);
    let c2 = queue_launchpad_call(&h, CREATOR, "ClaimCreatorFees", (token,), 0);
    let res = h.system().run_next_block();
    assert!(res.succeed.contains(&c1) && res.succeed.contains(&c2));
    let fees_paid = h.balance(CREATOR) - before;
    assert!(fees_paid <= vara(2_000) / 200 + vara(1), "paid once: {fees_paid}");
    assert_eq!(h.info(token).await.creator_fees, 0);
    inv(&h, &[token], &[BUYER, BUYER2], "claims").await;
    // fail at FindOrCreatePair, then retry-graduate + unwind in one block
    assert_eq!(grad(&h, token).await.unwrap(), GradStep::FindOrCreatePair);
    let mut gas = gas_config();
    gas.gas_for_create_pair = 1_000_000;
    h.set_gas(gas).await;
    assert!(grad(&h, token).await.is_err());
    h.set_gas(gas_config()).await;
    h.system().run_to_block(h.system().block_height() + 1_001); // past the unwind delay
    let g = queue_launchpad_call(&h, KEEPER, "Graduate", (token,), 0);
    let u = queue_launchpad_call(&h, BUYER, "Unwind", (token,), 0);
    let res = h.system().run_next_block();
    assert!(res.succeed.contains(&g) && res.failed.contains(&u), "unwind must hit the lock");
    h.system().run_to_block(h.system().block_height() + 5);
    let info = h.info(token).await;
    assert!(!info.lock);
    println!("after graduate||unwind: state {:?} step {:?}", info.state, info.step);
    grad_to_done(&h, token).await;
    inv(&h, &[token], &[BUYER, BUYER2], "graduated").await;
}

// --------------------------------------------------------------------- 3. curve edges

#[tokio::test]
async fn fb_curve_edges_and_rounding_drift() {
    let h = setup().await;
    let token = h.launch("Edge One", "E1").await;
    let traders = [BUYER, BUYER2];
    // min trade
    let r = h.buy(token, BUYER, vara(1)).await;
    assert!(r.tokens > U256::zero());
    let below = h.svc().buy(token, U256::zero(), u32::MAX)
        .with_params(|p| p.with_actor_id(actor(BUYER)).with_value(vara(1) - 1)).await;
    assert!(err_text(&below).contains("BelowMinTrade"));
    // sell of one base unit
    let one = try_sell(&h, token, BUYER, U256::one()).await;
    println!("sell 1 unit: {one}");
    assert!(one.contains("ZeroOutput"), "{one}");
    // rounding drift: many alternating trades
    for i in 0..30u128 {
        let r = h.buy(token, if i % 2 == 0 { BUYER } else { BUYER2 }, vara(1 + (i * 37) % 23)).await;
        h.sell(token, if i % 2 == 0 { BUYER } else { BUYER2 }, r.tokens * U256::from(2u32) / U256::from(3u32)).await;
        if i % 10 == 9 {
            inv(&h, &[token], &traders, &format!("drift {i}")).await;
        }
    }
    // everyone sells everything back
    for who in [BUYER, BUYER2] {
        let bal = vft_balance(h.system(), token, actor(who));
        if !bal.is_zero() {
            h.sell(token, who, bal).await;
        }
    }
    let i = h.info(token).await;
    assert_eq!(i.real_remaining, i.curve_supply);
    println!("residual escrow after full sell-back: {} planck", i.escrow);
    inv(&h, &[token], &traders, "all back").await;
    // big sell then buys
    let r = h.buy(token, BUYER, vara(400)).await;
    h.sell(token, BUYER, r.tokens).await;
    h.buy(token, BUYER2, vara(50)).await;
    inv(&h, &[token], &traders, "after big sell").await;
    // a buy exactly equal to the remaining cost: completes, zero refund
    let i = h.info(token).await;
    let cost = curve::buy_cost_for_tokens(i.virtual_vara, i.virtual_tokens, i.real_remaining).low_u128();
    let gross = curve::gross_for_net(cost, i.fee_bps);
    let q = h.svc().quote_buy(token, gross).await.unwrap();
    assert!(q.completes_curve && q.refund_vara == 0, "{q:?}");
    let q1 = h.svc().quote_buy(token, gross - 1).await.unwrap();
    println!("gross-1: completes {} out {} of {}", q1.completes_curve, q1.amount_out, i.real_remaining);
    let r = h.buy(token, BUYER2, gross).await;
    assert!(r.completed_curve);
    inv(&h, &[token], &traders, "exact sell-out").await;
}

// -------------------------------------------------------------------- 4. authorization

#[tokio::test]
async fn fb_authorization_and_value_rejection() {
    let h = setup().await;
    let token = h.launch("Auth One", "A1").await;
    h.buy(token, BUYER, vara(200)).await;
    let mut s = h.svc();
    let who = |p: sails_rs::client::GtestParams| p.with_actor_id(actor(BUYER));
    let bad = Addrs { rivr_factory: actor(BUYER), wvara: actor(BUYER), lp_dead: actor(BUYER), treasury: actor(BUYER) };
    let results = [
        ("set_raise_target", err_text(&s.set_raise_target(1).with_params(who).await)),
        ("set_addresses", err_text(&s.set_addresses(bad).with_params(who).await)),
        ("set_gas", err_text(&s.set_gas(gas_config()).with_params(who).await)),
        ("set_vft_code_id", err_text(&s.set_vft_code_id(CodeId::zero()).with_params(who).await)),
        ("set_fees", err_text(&s.set_fees(100, 50, vara(3)).with_params(who).await)),
        ("set_limits", err_text(&s.set_limits(0, 0, 0, 0).with_params(who).await)),
        ("set_admin", err_text(&s.set_admin(actor(BUYER)).with_params(who).await)),
        ("set_paused_buys", err_text(&s.set_paused_buys(true).with_params(who).await)),
    ];
    for (m, e) in &results {
        assert!(e.contains("Unauthorized"), "{m}: {e}");
    }
    assert_eq!(s.admin().await.unwrap(), actor(ADMIN));
    // value attached to non-payable methods comes back
    let before = h.balance(BUYER2);
    let v = |p: sails_rs::client::GtestParams| p.with_actor_id(actor(BUYER2)).with_value(vara(7));
    let vals = [
        err_text(&s.sell(token, tokens(1), 0, u32::MAX).with_params(v).await),
        err_text(&s.graduate(token).with_params(v).await),
        err_text(&s.unwind(token).with_params(v).await),
        err_text(&s.reconcile(token).with_params(v).await),
        err_text(&s.claim_payout(token).with_params(v).await),
        err_text(&s.claim_protocol_fees(token).with_params(v).await),
    ];
    for e in &vals {
        assert!(e.contains("ValueNotAccepted"), "{e}");
    }
    let lost = before - h.balance(BUYER2);
    println!("6 rejected value calls cost {lost} planck");
    assert!(lost < vara(7), "attached 7 VARA each must come back; lost {lost}");
    // claims
    let c = s.claim_creator_fees(token).with_params(who).await;
    assert!(err_text(&c).contains("Unauthorized"), "{}", err_text(&c));
    let unknown = actor(4242);
    let c = s.claim_creator_fees(unknown).with_params(who).await;
    assert!(err_text(&c).contains("LaunchNotFound"), "{}", err_text(&c));
    let c = s.claim_protocol_fees(unknown).with_params(who).await;
    assert!(err_text(&c).contains("LaunchNotFound"), "{}", err_text(&c));
    let c = s.claim_payout(unknown).with_params(who).await;
    println!("claim_payout unknown token: {}", err_text(&c));
    // graduate on Trading
    let g = s.graduate(token).with_params(who).await;
    assert!(err_text(&g).contains("NotGraduating"), "{}", err_text(&g));
    let u = s.unwind(token).with_params(who).await;
    assert!(err_text(&u).contains("NotUnwindable"), "{}", err_text(&u));
    // protocol fees always go to the frozen treasury, whoever calls
    let t_before = h.balance(TREASURY);
    s.claim_protocol_fees(token).with_params(who).await.unwrap().unwrap();
    assert!(h.balance(TREASURY) > t_before);
    // admin-only setters do not touch existing launches' frozen terms
    s.set_fees(9_000, 0, vara(3)).with_params(|p| p.with_actor_id(actor(ADMIN))).await.unwrap();
    assert_eq!(h.info(token).await.fee_bps, 100);
    inv(&h, &[token], &[BUYER], "auth").await;
}

// --------------------------------------------------------------- 5. graduation attacks

/// Griefer seeds the pair with dust wVARA and many tokens (token price ~0) before sell-out.
#[tokio::test]
async fn fb_preseed_cheap_ratio_hijacks_listing() {
    let h = setup().await;
    let token = h.launch("Seed Cheap", "SC").await;
    h.buy(token, BUYER2, vara(300)).await;
    let pair = seed_pair(&h, BUYER2, token, U256::from(1_000_000u64), tokens(1_000_000));
    h.buy(token, BUYER, vara(1_000)).await;
    let pool_vara = h.info(token).await.pool_vara;
    grad_to_done(&h, token).await;
    let info = h.info(token).await;
    let (w, t) = wvara_side(&h, pair);
    println!("pool_vara {pool_vara}; pair wvara {w} tokens {t}; protocol_fees {}", info.protocol_fees);
    inv(&h, &[token], &[BUYER, BUYER2], "cheap seed").await;
    assert!(w * U256::from(100u32) >= U256::from(pool_vara) * U256::from(99u32), "pool got {w} of {pool_vara} wVARA");
}

/// Griefer seeds at a very high token price: only a sliver of the 200M pool tokens goes in.
#[tokio::test]
async fn fb_preseed_expensive_ratio_strands_pool_tokens() {
    let h = setup().await;
    let token = h.launch("Seed Dear", "SD").await;
    h.buy(token, BUYER2, vara(300)).await;
    let _pair = seed_pair(&h, BUYER2, token, U256::from(vara(20)), tokens(1_000));
    h.buy(token, BUYER, vara(1_000)).await;
    grad_to_done(&h, token).await;
    let stranded = vft_balance(h.system(), token, h.launchpad_id);
    println!("curve tokens left in launchpad after Graduated: {stranded}");
    assert!(vft_roles(h.system(), token, "Admins").is_empty());
    assert_eq!(stranded, U256::zero(), "pool tokens stranded");
}

/// Griefer seeds reserves >= our amounts: AddLiquidity is skipped as "already added".
#[tokio::test]
async fn fb_preseed_large_reserves_skips_add_liquidity() {
    let h = setup().await;
    let token = h.launch("Seed Big", "SB").await;
    h.buy(token, BUYER2, vara(300)).await;
    let pair = seed_pair(&h, BUYER2, token, U256::from(vara(600)), tokens(210_000_000));
    let (w0, _) = wvara_side(&h, pair);
    h.buy(token, BUYER, vara(1_000)).await;
    let pool_vara = h.info(token).await.pool_vara;
    grad_to_done(&h, token).await;
    let info = h.info(token).await;
    let (w1, _) = wvara_side(&h, pair);
    let stranded = vft_balance(h.system(), token, h.launchpad_id);
    println!("pair wvara before {w0} after {w1}; pool_vara {pool_vara}; stranded tokens {stranded}; protocol_fees {} lp_burned {}", info.protocol_fees, info.lp_burned);
    inv(&h, &[token], &[BUYER, BUYER2], "big seed").await;
    assert!(w1 > w0, "our liquidity never went in");
}

/// Donations: wVARA to the launchpad before WrapVara, LP to the launchpad before BurnLp,
/// curve tokens straight to the pair.
#[tokio::test]
async fn fb_donations_do_not_strand_value() {
    let h = setup().await;
    let token = h.launch("Donate", "DN").await;
    h.buy(token, BUYER2, vara(300)).await;
    h.buy(token, BUYER, vara(1_000)).await;
    let info = h.info(token).await;
    // Seed at exactly the pool's ratio (1/1000 scale) so no imbalance, then donate LP + wVARA + tokens.
    let pair = seed_pair(&h, BUYER2, token, U256::from(info.pool_vara / 1000), info.pool_tokens / U256::from(1000u32));
    let lp = vft_balance(h.system(), pair, actor(BUYER2));
    raw_ok(h.system(), pair, BUYER2, encode_call("Vft", "Transfer", (h.launchpad_id, lp)), 0);
    raw_ok(h.system(), h.wvara, BUYER2, encode_call("VftNativeExchange", "Mint", ()), info.pool_vara);
    raw_ok(h.system(), h.wvara, BUYER2, encode_call("Vft", "Transfer", (h.launchpad_id, U256::from(info.pool_vara))), 0);
    raw_ok(h.system(), token, BUYER2, encode_call("Vft", "Transfer", (pair, tokens(1_000_000))), 0);
    let bal_before = h.program_balance();
    grad_to_done(&h, token).await;
    let after = h.info(token).await;
    let (w, t) = wvara_side(&h, pair);
    println!(
        "lp donated {lp} lp_burned {}; pair wvara {w} tokens {t}; program balance delta {}; free {}",
        after.lp_burned,
        h.program_balance() as i128 - bal_before as i128,
        h.program_balance() - h.liabilities().await
    );
    assert_eq!(vft_balance(h.system(), h.wvara, h.launchpad_id), U256::zero());
    assert_eq!(vft_balance(h.system(), pair, h.launchpad_id), U256::zero());
    assert_eq!(vft_balance(h.system(), token, h.launchpad_id), U256::zero());
    for role in ["Admins", "Minters", "Burners"] {
        assert!(vft_roles(h.system(), token, role).is_empty());
    }
    inv(&h, &[token], &[BUYER, BUYER2], "donations").await;
}

/// Fails every step once with a starved gas budget, then resumes.
#[tokio::test]
async fn fb_fail_every_step_then_resume() {
    let h = setup().await;
    let token = h.launch("Fail Each", "FE").await;
    h.buy(token, BUYER, vara(300)).await;
    h.buy(token, BUYER2, vara(1_000)).await;
    let mut failures = Vec::new();
    for _ in 0..25 {
        let step = h.info(token).await.step;
        if h.info(token).await.state == LaunchState::Graduated {
            break;
        }
        let mut gas = gas_config();
        match step.clone() {
            GradStep::AddLiquidity => gas.gas_for_add_liquidity = 105_000_000_000, // just above pair full_tx
            GradStep::FindOrCreatePair => gas.gas_for_create_pair = 1_000_000,
            _ => gas.gas_for_token_ops = 1_000_000,
        }
        if !failures.iter().any(|(s, _): &(GradStep, String)| *s == step) {
            h.set_gas(gas).await;
            let r = grad(&h, token).await;
            failures.push((step.clone(), format!("{r:?}")));
            h.set_gas(gas_config()).await;
            inv(&h, &[token], &[BUYER, BUYER2], &format!("failed {step:?}")).await;
        }
        let r = grad(&h, token).await;
        assert!(r.is_ok(), "resume of {step:?} failed: {r:?}");
        inv(&h, &[token], &[BUYER, BUYER2], &format!("resumed {step:?}")).await;
    }
    for f in &failures {
        println!("{f:?}");
    }
    let info = h.info(token).await;
    assert_eq!(info.state, LaunchState::Graduated);
    assert!(info.roles_renounced);
    assert_eq!(vft_balance(h.system(), token, h.launchpad_id), U256::zero());
    assert_eq!(vft_balance(h.system(), h.wvara, h.launchpad_id), U256::zero());
    assert_eq!(vft_balance(h.system(), info.pair, h.launchpad_id), U256::zero());
    let (w, t) = wvara_side(&h, info.pair);
    assert_eq!(w, U256::from(info.pool_vara));
    assert_eq!(t, info.pool_tokens);
}

// --------------------------------------------------------------------- 6. limits/names

#[tokio::test]
async fn fb_limits_and_name_uniqueness() {
    let h = setup().await;
    let launch = |name: String, sym: &'static str, value: u128| {
        let mut s = h.svc();
        async move {
            s.launch(meta(&name, sym), [0u8; 32], U256::zero())
                .with_params(|p| p.with_actor_id(actor(CREATOR)).with_value(value))
                .await
        }
    };
    h.svc().top_up_reserve().with_params(|p| p.with_actor_id(actor(ADMIN)).with_value(vara(500))).await.unwrap();
    // very large first buy: capped and refunded, curve completes at launch
    let before = h.balance(CREATOR);
    let big = launch("Whale".into(), "W", vara(500_000)).await.unwrap().unwrap();
    let i = h.info(big).await;
    assert_eq!(i.state, LaunchState::Ready);
    assert!(before - h.balance(CREATOR) < vara(700), "refunded");
    inv(&h, &[big], &[CREATOR], "whale").await;
    // name lengths
    assert!(launch("x".repeat(64), "L", 0).await.unwrap().is_ok());
    assert!(err_text(&launch("y".repeat(65), "L", 0).await).contains("BadName"));
    // Non-ASCII names are rejected outright (the create form only allows Latin letters).
    assert!(err_text(&launch("é".repeat(10), "L", 0).await).contains("BadName"));
    let mut m = meta("Desc", "D");
    m.description = "d".repeat(501);
    let r = h.svc().launch(m, [0u8; 32], U256::zero()).with_params(|p| p.with_actor_id(actor(CREATOR))).await;
    assert!(err_text(&r).contains("BadDescription"));
    // case / whitespace / unicode
    assert!(launch("Doge".into(), "D1", 0).await.unwrap().is_ok());
    assert!(err_text(&launch(" DOGE ".into(), "D2", 0).await).contains("NameTaken"));
    let homoglyphs = [
        ("Ｄｏｇｅ", "fullwidth"),
        ("Dоge", "cyrillic o"),
        ("Do\u{200B}ge", "zero-width space"),
        ("Do ge", "inner space"),
        ("Doge\u{00A0}", "trailing nbsp"),
    ];
    let mut accepted = Vec::new();
    for (n, label) in homoglyphs {
        let r = launch(n.into(), "H", 0).await;
        if matches!(r, Ok(Ok(_))) {
            accepted.push(label);
        } else {
            println!("{label}: {}", err_text(&r));
        }
    }
    println!("look-alike names accepted next to 'Doge': {accepted:?}");
    // Only the genuinely different ASCII name "Do ge" may pass; every Unicode look-alike is refused.
    assert!(accepted.iter().all(|l| *l == "inner space"), "look-alikes accepted: {accepted:?}");
    // symbol uniqueness is not enforced
    assert!(launch("Other".into(), "D1", 0).await.unwrap().is_ok());
    // oversized metadata (image URL is unbounded)
    let mut m = meta("Huge Image", "HI");
    m.image = "i".repeat(60_000);
    let r = h.svc().launch(m, [0u8; 32], U256::zero()).with_params(|p| p.with_actor_id(actor(CREATOR))).await;
    assert!(err_text(&r).contains("LinkTooLong"), "oversized image must be refused");
}
