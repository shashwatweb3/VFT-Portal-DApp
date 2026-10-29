//! Executable proofs of concept for the mainnet audit findings. Each test asserts the SAFE
//! behaviour, so it fails while the bug exists and passes once it is fixed.
mod common;

use common::*;
use launchpad_app::wire::encode_call;
use launchpad_client::{launchpad::Launchpad as _, GradStep, LaunchState};
use sails_rs::{gtest::System, prelude::*};

async fn grad(h: &Harness, token: ActorId) -> Result<GradStep, String> {
    match h.svc().graduate(token).with_params(|p| p.with_actor_id(actor(KEEPER))).await {
        Ok(Ok(step)) => Ok(step),
        Ok(Err(e)) => Err(format!("{e:?}")),
        Err(e) => Err(format!("trap: {e:?}")),
    }
}

fn raw_ok(system: &System, dest: ActorId, from: u64, payload: Vec<u8>, value: u128) {
    call_raw(system, dest, from, payload, value);
}

/// Attacker creates the pair and seeds it with raw (base-unit) amounts.
fn seed_pair_raw(h: &Harness, who: u64, token: ActorId, wvara_amt: U256, token_amt: U256) -> ActorId {
    let system = h.system();
    raw_ok(system, h.wvara, who, encode_call("VftNativeExchange", "Mint", ()), vara(1));
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

/// ARITHOFL-001: a dust-seeded pair (sqrt(a*b) just above RivrDEX's 1000 minimum) makes
/// `rw_target` round to 0 in AlignPrice; `k / rw_target` then panics after an await with the
/// graduation lock held. Safe behaviour: graduation still reaches Done.
#[tokio::test]
async fn poc_arithofl_001_dust_seed_must_not_brick_graduation() {
    let h = setup().await;
    let token = h.launch("Dust Seed", "DUST").await;
    h.buy(token, BUYER2, vara(300)).await;
    let pair = seed_pair_raw(&h, BUYER2, token, U256::from(1_001u64), U256::from(1_001u64));
    let (r0, r1) = pair_reserves(h.system(), pair);
    println!("seeded reserves {r0} / {r1}");
    h.buy(token, BUYER, vara(1_000)).await;
    assert_eq!(h.info(token).await.state, LaunchState::Ready);

    let mut log = Vec::new();
    let mut done = false;
    for _ in 0..25 {
        let r = grad(&h, token).await;
        log.push(format!("{r:?}"));
        if r == Ok(GradStep::Done) {
            done = true;
            break;
        }
    }
    let info = h.info(token).await;
    println!("steps: {log:?}\nfinal state {:?} step {:?} lock {}", info.state, info.step, info.lock);
    assert!(done && info.state == LaunchState::Graduated, "graduation bricked: {:?} at {:?}, lock={}", info.state, info.step, info.lock);
}

/// CANCELSAFETY-001: a permissionless `graduate` sent with just enough gas to set the lock and
/// send the outbound message, but not enough for its continuation, must not freeze the launch.
#[tokio::test]
async fn poc_cancelsafety_001_gas_starved_graduate_must_not_freeze() {
    let h = setup().await;
    let token = h.launch("Starve", "STRV").await;
    h.buy(token, BUYER, vara(1_000)).await;
    assert_eq!(h.info(token).await.state, LaunchState::Ready);

    // Find a gas limit where the first step's outbound send happens but the continuation dies.
    let system = h.system();
    let program = system.get_program(h.launchpad_id).unwrap();
    let mut stuck_at = None;
    for gas in (2_000_000_000u64..60_000_000_000).step_by(1_000_000_000) {
        let _ = program.send_bytes_with_gas(BUYER2, encode_call("Launchpad", "Graduate", (token,)), gas, 0);
        system.run_to_block(system.block_height() + 30);
        let info = h.info(token).await;
        if info.lock {
            stuck_at = Some(gas);
            break;
        }
        if info.step != GradStep::WrapVara {
            break; // the step completed with this gas; starving no longer possible here
        }
    }
    println!("lock left set by starved message at gas {stuck_at:?}");
    // Let any reply timeout elapse, then an honest keeper must be able to finish graduation.
    system.run_to_block(system.block_height() + 200);
    let mut done = false;
    for _ in 0..25 {
        if grad(&h, token).await == Ok(GradStep::Done) {
            done = true;
            break;
        }
    }
    let info = h.info(token).await;
    assert!(done, "launch frozen after gas-starved graduate: state {:?} step {:?} lock {}", info.state, info.step, info.lock);
}

/// RESDISC-001: the buy that completes the curve over-pays by less than the existential
/// deposit. The refund send is rejected by the runtime and its `bool` is dropped, so the excess
/// is neither delivered nor booked. Safe behaviour: the buyer can still recover it (delivered
/// or held as a pending payout), and program liabilities account for it.
#[tokio::test]
async fn poc_resdisc_001_sub_ed_refund_is_not_lost() {
    use sails_rs::gtest::constants::EXISTENTIAL_DEPOSIT;
    let h = setup().await;
    let token = h.launch("Refund", "RFND").await;
    h.buy(token, BUYER2, vara(300)).await;
    let big = vara(5_000);
    let q = h.svc().quote_buy(token, big).await.unwrap();
    assert!(q.completes_curve);
    let gross_used = big - q.refund_vara;
    let overpay = EXISTENTIAL_DEPOSIT - 1;
    let free_before = h.svc().free_balance().await.unwrap();
    let prog_before = h.program_balance();
    let buyer_before = h.balance(BUYER);
    let prog_before_buy = prog_before;
    let r = h.buy(token, BUYER, gross_used + overpay).await;
    let _ = prog_before_buy;
    let buyer_after = h.balance(BUYER);
    let mailbox = h.system().get_mailbox(actor(BUYER));
    println!("buyer paid net {} (gross_used {gross_used}); program balance delta {}", buyer_before as i128 - buyer_after as i128, h.program_balance() as i128 - prog_before as i128);
    let _ = mailbox;
    assert!(r.completed_curve);
    let pending = h.svc().pending_payout(token, actor(BUYER)).await.unwrap();
    let free_after = h.svc().free_balance().await.unwrap();
    println!("ED {EXISTENTIAL_DEPOSIT}; overpay {overpay}; pending payout {pending}; free reserve delta {}", free_after as i128 - free_before as i128);
    // Gear 1.10 (core-processor ext.rs `charge_message_value`) only checks the program has the
    // value; it does not reject sub-ED sends, so the refund reaches the (live) buyer.
    let paid = buyer_before - buyer_after;
    assert_eq!(h.program_balance() - prog_before, gross_used, "program kept part of the overpay");
    // gtest bills gas as value, so compare with the same buy made without the overpay: a lost
    // refund shows up as the full `overpay`; the refund's own send and reply handling cost the
    // overpaying buyer a little gas on top (about a fifth of it here).
    let twin_token = h.launch("Refund Twin", "RFTW").await;
    h.buy(twin_token, BUYER2, vara(300)).await;
    let twin_q = h.svc().quote_buy(twin_token, big).await.unwrap();
    assert_eq!(big - twin_q.refund_vara, gross_used, "identical curves");
    let twin_before = h.balance(BUYER);
    h.buy(twin_token, BUYER, gross_used).await;
    let paid_exact = twin_before - h.balance(BUYER);
    let extra = paid.abs_diff(paid_exact);
    println!("paid {paid} with overpay, {paid_exact} without; difference {extra}");
    assert!(extra < overpay / 2, "sub-ED refund of {overpay} planck lost (buyer paid {extra} more)");
}

/// Gear review C-1: `send_bytes_with_gas_for_reply` sends first and only then charges the reply
/// deposit. With a gas limit that covers the send but not the deposit, `wire::call` returns
/// `CallError::Send`, `run_buy` reverts and refunds — yet the VFT transfer was already queued.
/// Safe behaviour: a buyer never ends up with both the tokens and the refund.
#[tokio::test]
async fn poc_gear_c1_send_ok_deposit_fails_must_not_give_free_tokens() {
    let h = setup().await;
    let token = h.launch("Free Lunch", "FREE").await;
    let system = h.system();
    let program = system.get_program(h.launchpad_id).unwrap();
    let value = vara(10);
    let mut hit = None;
    for gas in (1_000_000_000u64..80_000_000_000).step_by(250_000_000) {
        let tok_before = vft_balance(system, token, actor(BUYER));
        let bal_before = h.balance(BUYER);
        let payload = launchpad_app::wire::encode_call("Launchpad", "Buy", (token, U256::zero(), u32::MAX));
        let _ = program.send_bytes_with_gas(BUYER, payload, gas, value);
        system.run_to_block(system.block_height() + 5);
        let got_tokens = vft_balance(system, token, actor(BUYER)) > tok_before;
        // Buyer spent at most gas (value came back) yet received tokens.
        let spent = bal_before.saturating_sub(h.balance(BUYER));
        if got_tokens && spent < value / 2 {
            hit = Some((gas, spent));
            break;
        }
        if got_tokens {
            break; // a normal successful buy at this gas; no window below it
        }
    }
    println!("free-token window: {hit:?}");
    assert!(hit.is_none(), "buyer received tokens AND the refund at gas {hit:?}");
}
