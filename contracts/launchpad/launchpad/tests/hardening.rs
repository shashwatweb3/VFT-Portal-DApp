//! Regression tests for the audit remediation (docs/audit/mainnet-audit-2026-10.md).
mod common;

use common::*;
use launchpad_app::wire::encode_call;
use launchpad_client::{launchpad::Launchpad as _, GradStep, LaunchState};
use sails_rs::prelude::*;

const GIGA: u64 = 1_000_000_000;

/// Whatever gas a `graduate` carries, it leaves the launch unlocked and resumable: a message too
/// poor to send fails the step retryably, and one that runs dry in a continuation has its lock
/// released by the critical hook. Scanning gas upwards still ends in a full graduation.
#[tokio::test]
async fn starved_graduate_at_any_gas_leaves_the_launch_resumable() {
    let h = setup().await;
    let token = h.launch("Guard Floor", "GF").await;
    h.buy(token, BUYER, vara(1_000)).await;
    assert_eq!(h.info(token).await.state, LaunchState::Ready);
    let system = h.system();
    let program = system.get_program(h.launchpad_id).unwrap();
    let mut gas = GIGA;
    while h.info(token).await.state != LaunchState::Graduated {
        assert!(gas < 750 * GIGA, "graduation never completed");
        let _ = program.send_bytes_with_gas(KEEPER, encode_call("Launchpad", "Graduate", (token,)), gas, 0);
        system.run_to_block(system.block_height() + 5);
        let info = h.info(token).await;
        assert!(!info.lock, "{:?} at {gas} gas left the lock set", info.step);
        assert!(h.program_balance() >= h.liabilities().await, "solvent at {gas} gas");
        gas += 5 * GIGA;
    }
    println!("graduated after scanning up to ~{} Ggas", gas / GIGA);
}

/// Same for buys: a starved buy is either rejected, reverted, or marked stuck for an immediate
/// `Reconcile`; it never leaves the launch blocked or the books off.
#[tokio::test]
async fn starved_buy_at_any_gas_is_recoverable() {
    let h = setup().await;
    let token = h.launch("Guard Buy", "GB").await;
    let system = h.system();
    let program = system.get_program(h.launchpad_id).unwrap();
    for gas in (GIGA..750 * GIGA).step_by((GIGA / 2) as usize) {
        let payload = encode_call("Launchpad", "Buy", (token, U256::zero(), u32::MAX));
        let _ = program.send_bytes_with_gas(BUYER, payload, gas, vara(10));
        system.run_to_block(system.block_height() + 5);
        let info = h.info(token).await;
        if let Some(busy) = &info.busy {
            assert!(busy.stuck, "buy at {gas} gas left a live trade behind");
            h.svc().reconcile(token).with_params(|p| p.with_actor_id(actor(KEEPER))).await.unwrap().unwrap();
            assert!(h.info(token).await.busy.is_none());
        }
        let info = h.info(token).await;
        assert_eq!(h.liabilities().await, info.escrow + info.creator_fees + info.protocol_fees, "books at {gas} gas");
        if vft_balance(system, token, actor(BUYER)) > U256::zero() {
            println!("first buy delivered at ~{} Ggas", gas / GIGA);
            return;
        }
    }
    core::panic!("buy never ran");
}

/// Attacker creates the pair and seeds it with raw (base-unit) amounts.
fn seed_pair_raw(h: &Harness, who: u64, token: ActorId, wvara_amt: U256, token_amt: U256) -> ActorId {
    let system = h.system();
    call_raw(system, h.factory, who, encode_call("Factory", "CreatePair", (h.wvara, token)), vara(1));
    let pair = factory_get_pair(system, h.factory, h.wvara, token);
    add_liquidity_raw(h, who, pair, token, wvara_amt, token_amt);
    pair
}

/// `who` deposits raw amounts into an existing pair (minting the wVARA it needs first).
fn add_liquidity_raw(h: &Harness, who: u64, pair: ActorId, token: ActorId, wvara_amt: U256, token_amt: U256) {
    let system = h.system();
    let need = wvara_amt.low_u128();
    if need > 0 {
        call_raw(system, h.wvara, who, encode_call("VftNativeExchange", "Mint", ()), need.max(vara(1)));
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
    let reply = res.log().iter().find(|l| l.reply_to() == Some(mid)).map(|l| String::from_utf8_lossy(l.payload()).into_owned());
    assert!(res.succeed.contains(&mid), "AddLiquidity: {reply:?}");
    system.run_to_block(system.block_height() + 3);
}

/// A dust-seeded pair is deepened and re-aligned: the listing opens at the curve's final price
/// and almost all of the pool VARA goes in.
#[tokio::test]
async fn dust_seed_lists_at_the_curve_price() {
    let h = setup().await;
    let token = h.launch("Dust List", "DL").await;
    h.buy(token, BUYER2, vara(300)).await;
    let pair = seed_pair_raw(&h, BUYER2, token, U256::from(1_001u64), U256::from(1_001u64));
    h.buy(token, BUYER, vara(1_000)).await;
    let info = h.info(token).await;
    let (pv, pt) = (U256::from(info.pool_vara), info.pool_tokens);
    for _ in 0..25 {
        let step = h.svc().graduate(token).with_params(|p| p.with_actor_id(actor(KEEPER))).await;
        if matches!(step, Ok(Ok(GradStep::Done))) {
            break;
        }
    }
    assert_eq!(h.info(token).await.state, LaunchState::Graduated);
    let (r0, r1) = pair_reserves(h.system(), pair);
    let (t0, _) = pair_tokens(h.system(), pair);
    let (rw, rt) = if t0 == h.wvara { (r0, r1) } else { (r1, r0) };
    let (lhs, rhs) = (rw * pt, rt * pv);
    let diff = if lhs > rhs { lhs - rhs } else { rhs - lhs };
    assert!(diff * U256::from(100u32) <= rhs, "listed at {rw}/{rt}, curve price {pv}/{pt}");
    // Alignment stops within 1 %, and the pair deposits at its own ratio; the rest of the pool
    // VARA comes back as protocol revenue at Settle.
    assert!(rw * U256::from(100u32) >= pv * U256::from(99u32), "pool got {rw} of {pv} wVARA");
    assert_eq!(vft_balance(h.system(), h.wvara, h.launchpad_id), U256::zero());
}

/// Starves `FindOrCreatePair` of gas, which anyone can do by front-running the keeper with a
/// low-gas `graduate`, so the launch is `Failed` at an unwindable step.
async fn force_early_failure(h: &Harness, token: ActorId) {
    let step = h.svc().graduate(token).with_params(|p| p.with_actor_id(actor(KEEPER))).await;
    assert_eq!(step.unwrap().unwrap(), GradStep::FindOrCreatePair);
    let mut gas = gas_config();
    gas.gas_for_create_pair = 1_000_000;
    h.set_gas(gas).await;
    let failed = h.svc().graduate(token).with_params(|p| p.with_actor_id(actor(BUYER))).await;
    assert!(failed.unwrap().is_err());
    h.set_gas(gas_config()).await;
    assert_eq!(h.info(token).await.state, LaunchState::Failed);
}

async fn unwind_text(h: &Harness, token: ActorId) -> String {
    err_text(&h.svc().unwind(token).with_params(|p| p.with_actor_id(actor(BUYER))).await)
}

/// A forced early failure cannot be unwound on the spot; the keeper's retry clears it and the
/// listing goes ahead.
#[tokio::test]
async fn forced_early_failure_is_retried_not_unwound() {
    let h = setup().await;
    let token = h.launch("Unwind Delay", "UD").await;
    h.buy(token, BUYER, vara(2_000)).await;
    force_early_failure(&h, token).await;
    assert!(unwind_text(&h, token).await.contains("NotUnwindable"));

    let step = h.svc().graduate(token).with_params(|p| p.with_actor_id(actor(KEEPER))).await;
    assert_eq!(step.unwrap().unwrap(), GradStep::ApproveToken);
    assert_eq!(h.info(token).await.failed_since, None, "a completed step clears the failure");
    for _ in 0..20 {
        let step = h.svc().graduate(token).with_params(|p| p.with_actor_id(actor(KEEPER))).await;
        if step.unwrap().unwrap() == GradStep::Done {
            break;
        }
    }
    assert_eq!(h.info(token).await.state, LaunchState::Graduated);
}

/// The delay counts from the first failure, so failed retries in between neither extend it nor
/// shorten it, and a launch that really cannot list is still unwound in the end.
#[tokio::test]
async fn persistent_early_failure_unwinds_after_the_timeout() {
    let h = setup().await;
    let token = h.launch("Unwind Late", "UL").await;
    h.buy(token, BUYER, vara(2_000)).await;
    force_early_failure(&h, token).await;
    let since = h.info(token).await.failed_since.expect("failure recorded");

    h.system().run_to_block(since + 600);
    let mut gas = gas_config();
    gas.gas_for_create_pair = 1_000_000;
    h.set_gas(gas).await;
    let retry = h.svc().graduate(token).with_params(|p| p.with_actor_id(actor(KEEPER))).await;
    assert!(retry.unwrap().is_err());
    h.set_gas(gas_config()).await;
    assert_eq!(h.info(token).await.failed_since, Some(since), "a failed retry keeps the first failure");
    assert!(unwind_text(&h, token).await.contains("NotUnwindable"));

    h.system().run_to_block(since + 1_000);
    h.svc().unwind(token).with_params(|p| p.with_actor_id(actor(BUYER))).await.unwrap().unwrap();
    assert_eq!(h.info(token).await.state, LaunchState::Aborted);
}

/// A rejected deposit must not leave a snapshot behind that someone else's liquidity can later
/// satisfy: the retry deposits for real and the LP is burned.
#[tokio::test]
async fn rejected_deposit_is_redone_after_third_party_liquidity() {
    let h = setup().await;
    let token = h.launch("Resume Snap", "RS").await;
    h.buy(token, BUYER, vara(300)).await;
    h.buy(token, BUYER2, vara(1_000)).await;
    let mut step = GradStep::WrapVara;
    while step != GradStep::AddLiquidity {
        step = h.svc().graduate(token).with_params(|p| p.with_actor_id(actor(KEEPER))).await.unwrap().unwrap();
    }
    let mut gas = gas_config();
    gas.gas_for_add_liquidity = 30 * GIGA; // the pair's own gas check rejects the deposit
    h.set_gas(gas).await;
    let failed = h.svc().graduate(token).with_params(|p| p.with_actor_id(actor(KEEPER))).await;
    assert!(failed.unwrap().is_err());
    h.set_gas(gas_config()).await;
    let info = h.info(token).await;
    assert!(!info.liquidity_added);
    assert_eq!(info.pre_add_balances, None, "a rejected deposit leaves nothing to resume");

    // Someone else deposits about as much at the curve price.
    let pair = info.pair;
    let all = vft_balance(h.system(), token, actor(BUYER));
    call_raw(h.system(), token, BUYER, encode_call("Vft", "Transfer", (actor(BUYER2), all)), 0);
    add_liquidity_raw(&h, BUYER2, pair, token, U256::from(info.pool_vara), info.pool_tokens);

    for _ in 0..20 {
        let step = h.svc().graduate(token).with_params(|p| p.with_actor_id(actor(KEEPER))).await;
        if step.unwrap().unwrap() == GradStep::Done {
            break;
        }
    }
    let info = h.info(token).await;
    assert_eq!(info.state, LaunchState::Graduated);
    assert!(info.lp_burned > U256::zero(), "our own deposit was made and its LP burned");
    assert_eq!(vft_balance(h.system(), h.wvara, h.launchpad_id), U256::zero());
}

/// Fees for a program treasury (e.g. a multisig): a keeper-triggered send bounces, because a
/// program cannot run a gasless message, and the amount is re-credited instead of booked as
/// paid. The treasury then claims it and is paid in the reply.
#[tokio::test]
async fn bounced_payout_to_a_program_is_recredited_and_claimable() {
    let h = setup().await;
    let system = h.system();
    let proxy = sails_rs::gtest::Program::from_binary_with_id(system, 4_000, test_proxy::WASM_BINARY);
    let init = proxy.send_bytes(ADMIN, Vec::<u8>::new());
    assert!(system.run_next_block().succeed.contains(&init));
    let treasury = proxy.id();
    let addrs = |treasury| launchpad_client::Addrs {
        rivr_factory: h.factory,
        wvara: h.wvara,
        lp_dead: ActorId::from(LP_DEAD),
        treasury,
    };
    h.svc().set_addresses(addrs(treasury)).with_params(|p| p.with_actor_id(actor(ADMIN))).await.unwrap();
    let token = h.launch("Multisig Fees", "MF").await;
    h.buy(token, BUYER, vara(400)).await;
    let fees = h.info(token).await.protocol_fees;
    let liabilities = h.liabilities().await;
    let start = system.balance_of(treasury);

    let paid = h.svc().claim_protocol_fees(token).with_params(|p| p.with_actor_id(actor(KEEPER))).await;
    assert_eq!(paid.unwrap(), Ok(fees));
    system.run_to_block(system.block_height() + 3);
    assert_eq!(h.info(token).await.protocol_fees, 0);
    assert_eq!(system.balance_of(treasury), start, "the gasless send did not reach the program");
    assert_eq!(
        h.svc().pending_payout(token, treasury).await.unwrap(),
        fees,
        "the bounced send is owed again, not booked as paid"
    );
    assert_eq!(h.liabilities().await, liabilities, "fees moved to the pending payout");
    assert!(h.program_balance() >= h.liabilities().await, "the bounced value came back");

    // The treasury program claims it and gets the value in the reply.
    let claim = encode_call("Launchpad", "ClaimPayout", (token,));
    let mid = proxy.send_bytes_with_gas(ADMIN, (h.launchpad_id, claim).encode(), 100 * GIGA, 0);
    assert!(system.run_next_block().succeed.contains(&mid));
    system.run_to_block(system.block_height() + 2);
    assert_eq!(system.balance_of(treasury), start + fees);
    assert_eq!(h.svc().pending_payout(token, treasury).await.unwrap(), 0);
    assert_eq!(h.liabilities().await, liabilities - fees);
    h.svc().set_addresses(addrs(actor(TREASURY))).with_params(|p| p.with_actor_id(actor(ADMIN))).await.unwrap();
}

/// Every setter validates the resulting config, and a live launch keeps the graduation timeout
/// it was created with, so lowering it cannot re-open the instant unwind.
#[tokio::test]
async fn admin_setters_are_bounded_and_live_launches_keep_their_timeout() {
    let h = setup().await;
    let mut s = h.svc();
    let admin = |p: sails_rs::client::GtestParams| p.with_actor_id(actor(ADMIN));
    let rejected = [
        err_text(&s.set_limits(vara(1), vara(5), 0, 0).with_params(admin).await),
        err_text(&s.set_limits(0, vara(5), 1_000, 0).with_params(admin).await),
        err_text(&s.set_fees(100, 200, vara(3)).with_params(admin).await),
        err_text(&s.set_fees(100, 50, 0).with_params(admin).await),
        err_text(&s.set_raise_target(vara(2)).with_params(admin).await),
        err_text(&s.set_gas(launchpad_client::GasConfig { gas_for_reply_deposit: 0, ..gas_config() }).with_params(admin).await),
        err_text(&s.set_gas(launchpad_client::GasConfig { reply_timeout: 0, ..gas_config() }).with_params(admin).await),
        err_text(&s.set_gas(launchpad_client::GasConfig { gas_for_add_liquidity: 700 * GIGA, ..gas_config() }).with_params(admin).await),
    ];
    for e in &rejected {
        assert!(e.contains("BadConfig"), "{e}");
    }

    let token = h.launch("Frozen Wait", "FW").await;
    h.buy(token, BUYER, vara(2_000)).await;
    force_early_failure(&h, token).await;
    s.set_limits(vara(1), vara(5), 600, 0).with_params(admin).await.unwrap();
    let since = h.info(token).await.failed_since.unwrap();
    h.system().run_to_block(since + 700);
    assert!(unwind_text(&h, token).await.contains("NotUnwindable"), "the launch keeps its 1000 blocks");
    h.system().run_to_block(since + 1_000);
    h.svc().unwind(token).with_params(|p| p.with_actor_id(actor(BUYER))).await.unwrap().unwrap();
}

#[tokio::test]
async fn launches_are_paged() {
    let h = setup().await;
    let a = h.launch("Page One", "P1").await;
    let b = h.launch("Page Two", "P2").await;
    let c = h.launch("Page Three", "P3").await;
    let s = h.svc();
    assert_eq!(s.launch_count().await.unwrap(), 3);
    assert_eq!(s.launches_page(0, 2).await.unwrap(), vec![a, b]);
    assert_eq!(s.launches_page(2, 2).await.unwrap(), vec![c]);
    assert_eq!(s.launches_page(3, 2).await.unwrap(), Vec::<ActorId>::new());
    assert_eq!(s.launches_page(0, u32::MAX).await.unwrap().len(), 3);
}

async fn graduate_until(h: &Harness, token: ActorId, stop: GradStep) {
    for _ in 0..60 {
        let info = h.info(token).await;
        if info.step == stop || info.state == LaunchState::Graduated {
            return;
        }
        let _ = h.svc().graduate(token).with_params(|p| p.with_actor_id(actor(KEEPER))).await;
    }
    core::panic!("graduation stuck at {:?}", h.info(token).await.step);
}

/// A pair seeded deep and far above the curve price cannot be aligned with the launch's budget.
/// Alignment gives up after a bounded number of rounds and the launch lists at the pool's own
/// price instead of failing at AddLiquidity forever with its escrow locked.
#[tokio::test]
async fn deep_mispriced_seed_still_lists() {
    let h = setup().await;
    let token = h.launch("Deep Seed", "DEEP").await;
    h.buy(token, BUYER2, vara(300)).await;
    let seed_tokens = vft_balance(h.system(), token, actor(BUYER2));
    let pair = seed_pair_raw(&h, BUYER2, token, U256::from(vara(200_000)), seed_tokens);
    h.buy(token, BUYER, vara(1_000)).await;
    assert_eq!(h.info(token).await.state, LaunchState::Ready);

    graduate_until(&h, token, GradStep::Done).await;
    let info = h.info(token).await;
    assert_eq!(info.state, LaunchState::Graduated);
    assert!(info.lp_burned > U256::zero(), "our deposit was made and its LP burned");
    let (r0, r1) = pair_reserves(h.system(), pair);
    println!("pool after listing {r0} / {r1}");
    assert!(h.program_balance() >= h.liabilities().await);
    assert_eq!(vft_balance(h.system(), h.wvara, h.launchpad_id), U256::zero());
}
