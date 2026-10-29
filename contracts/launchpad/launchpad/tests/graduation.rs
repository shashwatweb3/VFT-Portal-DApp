mod common;

use common::*;
use launchpad_client::{launchpad::Launchpad as _, GradStep, LaunchState};
#[allow(unused_imports)]
use sails_rs::gtest::Program;
use sails_rs::prelude::*;

async fn sell_out(h: &Harness, token: ActorId) {
    h.buy(token, BUYER, vara(300)).await;
    let receipt = h.buy(token, BUYER2, vara(1_000)).await;
    assert!(receipt.completed_curve);
    assert_eq!(h.info(token).await.state, LaunchState::Ready);
}

async fn graduate_step(h: &Harness, token: ActorId) -> Result<GradStep, launchpad_client::LaunchpadError> {
    h.svc()
        .graduate(token)
        .with_params(|p| p.with_actor_id(actor(KEEPER)))
        .await
        .expect("graduate call")
}

/// M0 spike + M2: the launchpad drives wVARA mint, Factory.CreatePair, Pair.AddLiquidity,
/// LP transfer to the dead address and the VFT role renounce against the real RivrDEX code.
#[tokio::test]
async fn graduation_lists_on_rivrdex_burns_lp_and_renounces_roles() {
    let h = setup().await;
    let token = h.launch("Grad One", "G1").await;
    sell_out(&h, token).await;
    let ready = h.info(token).await;
    let pool_vara = ready.pool_vara;
    let liabilities_before = h.svc().total_liabilities().await.unwrap();

    let mut steps = Vec::new();
    for _ in 0..12 {
        let next = graduate_step(&h, token).await.unwrap_or_else(|e| core::panic!("step failed: {e:?}"));
        steps.push(next.clone());
        if next == GradStep::Done {
            break;
        }
    }
    assert_eq!(steps.last(), Some(&GradStep::Done), "steps: {steps:?}");

    let system = h.system();
    let info = h.info(token).await;
    assert_eq!(info.state, LaunchState::Graduated);
    assert!(info.pair_created_by_us);
    assert!(info.roles_renounced);
    assert_eq!(info.escrow, 0);

    // Pair exists in the factory and holds the pool.
    let pair = factory_get_pair(system, h.factory, h.wvara, token);
    assert_eq!(pair, info.pair);
    assert!(!pair.is_zero());
    let (t0, _) = pair_tokens(system, pair);
    let (r0, r1) = pair_reserves(system, pair);
    let (wvara_reserve, token_reserve) = if t0 == h.wvara { (r0, r1) } else { (r1, r0) };
    assert_eq!(wvara_reserve, U256::from(pool_vara));
    assert_eq!(token_reserve, tokens(TOTAL_SUPPLY_TOKENS - CURVE_SUPPLY_TOKENS));
    assert_eq!(vft_balance(system, token, pair), token_reserve);
    assert_eq!(vft_balance(system, h.wvara, pair), wvara_reserve);

    // LP tokens went to RivrDEX's dead address; the launchpad keeps none.
    let dead = ActorId::from(LP_DEAD);
    assert!(vft_balance(system, pair, dead) > U256::zero());
    assert_eq!(vft_balance(system, pair, h.launchpad_id), U256::zero());
    assert_eq!(vft_balance(system, pair, dead), info.lp_burned + U256::from(1000u32)); // + MINIMUM_LIQUIDITY

    // Every VFT role is gone.
    for role in ["Admins", "Minters", "Burners"] {
        assert!(vft_roles(system, token, role).is_empty(), "{role} not renounced");
    }
    // The launchpad holds no wVARA and no curve tokens any more.
    assert_eq!(vft_balance(system, h.wvara, h.launchpad_id), U256::zero());
    assert_eq!(vft_balance(system, token, h.launchpad_id), U256::zero());

    // Liabilities dropped by the pool VARA and the pair fee; the rest of the graduation fee
    // became protocol revenue.
    let liabilities_after = h.svc().total_liabilities().await.unwrap();
    assert_eq!(liabilities_after, liabilities_before - pool_vara - vara(PAIR_FEE_VARA));
    assert_eq!(
        liabilities_after,
        info.creator_fees + info.protocol_fees,
        "only fees remain owed"
    );
    assert!(info.protocol_fees >= vara(GRAD_FEE_VARA) - vara(PAIR_FEE_VARA));

    // Calling graduate again is a no-op at Done.
    assert_eq!(graduate_step(&h, token).await.unwrap(), GradStep::Done);
}

#[tokio::test]
async fn graduation_price_is_continuous_with_the_curve() {
    let h = setup().await;
    let token = h.launch("Grad Two", "G2").await;
    sell_out(&h, token).await;
    let ready = h.info(token).await;
    let curve_price = launchpad_app::curve::price_e18(ready.virtual_vara, ready.virtual_tokens);
    let pool_price = launchpad_app::curve::price_e18(U256::from(ready.pool_vara), ready.pool_tokens);
    let diff = if curve_price > pool_price { curve_price - pool_price } else { pool_price - curve_price };
    // Within 0.3 % (integer parameter rounding plus the 3 VARA graduation fee on ~594).
    assert!(diff * U256::from(1000u32) <= pool_price * U256::from(3u32), "curve {curve_price} pool {pool_price}");
}

#[tokio::test]
async fn trades_are_rejected_while_graduating_and_after() {
    let h = setup().await;
    let token = h.launch("Grad Three", "G3").await;
    sell_out(&h, token).await;
    graduate_step(&h, token).await.unwrap(); // WrapVara done -> Graduating
    let buy = h
        .svc()
        .buy(token, U256::zero(), u32::MAX)
        .with_params(|p| p.with_actor_id(actor(BUYER)).with_value(vara(5)))
        .await;
    assert!(err_text(&buy).contains("NotTrading"), "{}", err_text(&buy));
    assert!(vft_approve(h.system(), token, BUYER, h.launchpad_id, tokens(1)));
    let sell = h
        .svc()
        .sell(token, tokens(1), 0, u32::MAX)
        .with_params(|p| p.with_actor_id(actor(BUYER)))
        .await;
    assert!(err_text(&sell).contains("NotTrading"), "{}", err_text(&sell));
}

#[tokio::test]
async fn pre_seeded_pair_is_reused_not_recreated() {
    let h = setup().await;
    let token = h.launch("Grad Four", "G4").await;
    sell_out(&h, token).await;
    // A griefer creates the pair first.
    let payload = launchpad_app::wire::encode_call("Factory", "CreatePair", (h.wvara, token));
    call_raw(h.system(), h.factory, BUYER, payload, vara(1));
    let pair = factory_get_pair(h.system(), h.factory, h.wvara, token);
    assert!(!pair.is_zero());

    loop {
        let next = graduate_step(&h, token).await.unwrap();
        if next == GradStep::Done {
            break;
        }
    }
    let info = h.info(token).await;
    assert_eq!(info.pair, pair);
    assert!(!info.pair_created_by_us);
    assert_eq!(info.state, LaunchState::Graduated);
    // The pair fee was not spent, so the whole graduation fee is protocol revenue.
    assert_eq!(info.protocol_fees, vara(GRAD_FEE_VARA) + (h.liabilities().await - info.creator_fees - vara(GRAD_FEE_VARA)));
}

#[tokio::test]
async fn stale_ready_launch_can_be_unwound_and_sold_back() {
    let h = setup().await;
    let token = h.launch("Grad Five", "G5").await;
    sell_out(&h, token).await;

    let early = h
        .svc()
        .unwind(token)
        .with_params(|p| p.with_actor_id(actor(KEEPER)))
        .await;
    assert!(early.is_err(), "not stale yet");

    h.system().run_to_block(h.system().block_height() + 1_001);
    h.svc()
        .unwind(token)
        .with_params(|p| p.with_actor_id(actor(KEEPER)))
        .await
        .unwrap()
        .unwrap();
    let info = h.info(token).await;
    assert_eq!(info.state, LaunchState::Aborted);

    let held = vft_balance(h.system(), token, actor(BUYER2));
    let before = h.balance(BUYER2);
    let receipt = h.sell(token, BUYER2, held).await;
    assert!(receipt.vara > 0);
    assert!(h.balance(BUYER2) > before);
}

#[tokio::test]
async fn concurrent_graduate_calls_run_the_step_once() {
    let h = setup().await;
    let token = h.launch("Grad Six", "G6").await;
    sell_out(&h, token).await;
    let escrow_before = h.info(token).await.escrow;
    let first = queue_launchpad_call(&h, KEEPER, "Graduate", (token,), 0);
    let second = queue_launchpad_call(&h, BUYER, "Graduate", (token,), 0);
    let res = h.system().run_next_block();
    assert!(res.succeed.contains(&first));
    assert!(res.failed.contains(&second), "second call hits the graduation lock");
    h.system().run_to_block(h.system().block_height() + 3);
    let info = h.info(token).await;
    assert!(info.wrapped);
    assert!(!info.lock);
    assert_eq!(info.escrow, escrow_before - info.pool_vara, "pool VARA wrapped exactly once");
    assert_eq!(vft_balance(h.system(), h.wvara, h.launchpad_id), U256::from(info.pool_vara));
}

#[tokio::test]
async fn failed_step_is_resumable_and_charges_the_pair_fee_once() {
    let h = setup().await;
    let token = h.launch("Grad Seven", "G7").await;
    sell_out(&h, token).await;
    let liabilities_ready = h.liabilities().await;
    let pool_vara = h.info(token).await.pool_vara;

    assert_eq!(graduate_step(&h, token).await.unwrap(), GradStep::FindOrCreatePair);
    let mut gas = gas_config();
    gas.gas_for_create_pair = 1_000_000; // factory runs out of gas -> error reply
    h.set_gas(gas).await;
    let failed = graduate_step(&h, token).await;
    assert!(
        matches!(failed, Err(launchpad_client::LaunchpadError::GraduationFailed { step: GradStep::FindOrCreatePair, retryable: true, .. })),
        "{failed:?}"
    );
    let info = h.info(token).await;
    assert_eq!(info.state, LaunchState::Failed);
    assert!(!info.lock);
    assert!(!info.pair_created_by_us, "a failed CreatePair must not be booked");
    assert_eq!(h.liabilities().await, liabilities_ready - pool_vara);

    h.set_gas(gas_config()).await;
    loop {
        if graduate_step(&h, token).await.unwrap() == GradStep::Done {
            break;
        }
    }
    let info = h.info(token).await;
    assert_eq!(info.state, LaunchState::Graduated);
    assert!(info.pair_created_by_us);
    assert_eq!(h.liabilities().await, liabilities_ready - pool_vara - vara(PAIR_FEE_VARA));
    assert_eq!(h.liabilities().await, info.creator_fees + info.protocol_fees);
    assert!(h.program_balance() >= h.liabilities().await);
}

#[tokio::test]
async fn unwind_after_wrap_recovers_the_pool_vara_for_sellers() {
    let h = setup().await;
    let token = h.launch("Grad Eight", "G8").await;
    sell_out(&h, token).await;
    let escrow_ready = h.info(token).await.escrow;
    assert_eq!(graduate_step(&h, token).await.unwrap(), GradStep::FindOrCreatePair);
    let mut gas = gas_config();
    gas.gas_for_create_pair = 1_000_000;
    h.set_gas(gas).await;
    assert!(graduate_step(&h, token).await.is_err());
    assert_eq!(h.info(token).await.state, LaunchState::Failed);

    let early = h.svc().unwind(token).with_params(|p| p.with_actor_id(actor(KEEPER))).await;
    assert!(err_text(&early).contains("NotUnwindable"), "{}", err_text(&early));
    h.system().run_to_block(h.system().block_height() + 1_001);
    h.svc()
        .unwind(token)
        .with_params(|p| p.with_actor_id(actor(KEEPER)))
        .await
        .unwrap()
        .unwrap();
    let info = h.info(token).await;
    assert_eq!(info.state, LaunchState::Aborted);
    assert!(!info.wrapped && !info.lock);
    assert_eq!(info.escrow, escrow_ready, "pool VARA is back in escrow");
    assert_eq!(vft_balance(h.system(), h.wvara, h.launchpad_id), U256::zero());
    assert_eq!(h.liabilities().await, info.escrow + info.creator_fees + info.protocol_fees);
    assert!(h.program_balance() >= h.liabilities().await);

    // Holders can exit at the frozen curve; nobody can buy.
    let held = vft_balance(h.system(), token, actor(BUYER));
    let receipt = h.sell(token, BUYER, held).await;
    assert!(receipt.vara > 0);
    let buy = h
        .svc()
        .buy(token, U256::zero(), u32::MAX)
        .with_params(|p| p.with_actor_id(actor(BUYER2)).with_value(vara(5)))
        .await;
    assert!(err_text(&buy).contains("NotTrading"), "{}", err_text(&buy));
}

#[tokio::test]
async fn pre_seeded_pair_with_reserves_lists_at_its_ratio_and_recovers_leftover_wvara() {
    let h = setup().await;
    let token = h.launch("Grad Nine", "G9").await;
    let bought = h.buy(token, BUYER2, vara(300)).await;
    // The griefer wraps VARA, creates the pair and seeds it at a price far above the curve's.
    let system = h.system();
    call_raw(system, h.wvara, BUYER2, launchpad_app::wire::encode_call("VftNativeExchange", "Mint", ()), vara(20));
    call_raw(system, h.factory, BUYER2, launchpad_app::wire::encode_call("Factory", "CreatePair", (h.wvara, token)), vara(1));
    let pair = factory_get_pair(system, h.factory, h.wvara, token);
    assert!(vft_approve(system, h.wvara, BUYER2, pair, U256::from(vara(20))));
    assert!(vft_approve(system, token, BUYER2, pair, bought.tokens));
    let (t0, _) = pair_tokens(system, pair);
    let (a0, a1) = if t0 == h.wvara { (U256::from(vara(20)), tokens(1_000)) } else { (tokens(1_000), U256::from(vara(20))) };
    let program = system.get_program(pair).unwrap();
    let mid = program.send_bytes_with_gas(
        BUYER2,
        launchpad_app::wire::encode_call("Pair", "AddLiquidity", (a0, a1, U256::zero(), U256::zero(), u64::MAX)),
        300_000_000_000,
        0,
    );
    let res = system.run_next_block();
    assert!(res.succeed.contains(&mid), "griefer seeds the pair");
    system.run_to_block(system.block_height() + 3);
    let (r0, r1) = pair_reserves(system, pair);
    assert!(!r0.is_zero() && !r1.is_zero());

    h.buy(token, BUYER, vara(1_000)).await;
    assert_eq!(h.info(token).await.state, LaunchState::Ready);
    let liabilities_ready = h.liabilities().await;
    let pool_vara = h.info(token).await.pool_vara;
    loop {
        if graduate_step(&h, token).await.unwrap() == GradStep::Done {
            break;
        }
    }
    let info = h.info(token).await;
    assert_eq!(info.state, LaunchState::Graduated);
    assert!(!info.pair_created_by_us);
    assert!(info.roles_renounced);
    // The pool followed the seeded ratio, so part of the pool VARA could not go in and came
    // back as protocol revenue; nothing is stranded in wVARA.
    assert_eq!(vft_balance(h.system(), h.wvara, h.launchpad_id), U256::zero());
    assert!(info.protocol_fees > vara(GRAD_FEE_VARA), "leftover wVARA recovered: {}", info.protocol_fees);
    assert_eq!(h.liabilities().await, info.creator_fees + info.protocol_fees);
    assert!(h.liabilities().await < liabilities_ready, "pool VARA left the books");
    assert!(h.program_balance() >= h.liabilities().await);
    let lp_dead = vft_balance(h.system(), pair, ActorId::from(LP_DEAD));
    assert!(lp_dead > U256::from(1000u32) && vft_balance(h.system(), pair, h.launchpad_id).is_zero());
    let _ = pool_vara;
}
