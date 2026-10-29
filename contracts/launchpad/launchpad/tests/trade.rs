mod common;

use common::*;
use launchpad_client::{launchpad::Launchpad as _, LaunchState, Side};
use sails_rs::prelude::*;

#[tokio::test]
async fn buy_moves_tokens_escrow_and_fees() {
    let h = setup().await;
    let token = h.launch("Trade One", "T1").await;
    let paid = vara(50);

    let quote = h.svc().quote_buy(token, paid).await.unwrap();
    let receipt = h.buy(token, BUYER, paid).await;

    assert_eq!(receipt.side, Side::Buy);
    assert_eq!(receipt.tokens, quote.amount_out);
    assert_eq!(receipt.fee, paid / 100);
    assert!(!receipt.completed_curve);
    assert_eq!(vft_balance(h.system(), token, actor(BUYER)), receipt.tokens);

    let info = h.info(token).await;
    assert_eq!(info.escrow, paid - paid / 100);
    assert_eq!(info.creator_fees + info.protocol_fees, paid / 100);
    assert_eq!(info.trade_seq, 1);
    assert!(info.busy.is_none());
    assert_eq!(h.svc().total_liabilities().await.unwrap(), paid);
    // Price moved up.
    assert!(launchpad_app::curve::price_e18(info.virtual_vara, info.virtual_tokens) > launchpad_app::curve::price_e18(info.v0, info.t0));
}

#[tokio::test]
async fn sell_returns_less_than_paid_and_keeps_invariants() {
    let h = setup().await;
    let token = h.launch("Trade Two", "T2").await;
    let paid = vara(100);
    let receipt = h.buy(token, BUYER, paid).await;

    let before = h.balance(BUYER);
    let sold = h.sell(token, BUYER, receipt.tokens).await;
    assert_eq!(sold.side, Side::Sell);
    assert!(sold.vara < paid, "round trip costs the fee on both legs");
    assert!(h.balance(BUYER) > before, "seller was paid");
    assert_eq!(vft_balance(h.system(), token, actor(BUYER)), U256::zero());

    let info = h.info(token).await;
    assert_eq!(info.real_remaining, tokens(CURVE_SUPPLY_TOKENS));
    assert_eq!(info.virtual_tokens, info.t0);
    assert_eq!(info.escrow, info.virtual_vara.low_u128() - info.v0.low_u128());
    assert!(info.virtual_vara * info.virtual_tokens >= info.v0 * info.t0, "k never decreases");
    assert!(h.program_balance() >= h.liabilities().await + vara(5));
    assert_eq!(
        h.svc().total_liabilities().await.unwrap(),
        info.escrow + info.creator_fees + info.protocol_fees
    );
}

#[tokio::test]
async fn buy_rejects_slippage_and_returns_value() {
    let h = setup().await;
    let token = h.launch("Trade Three", "T3").await;
    let before = h.balance(BUYER);
    let res = h
        .svc()
        .buy(token, U256::MAX, u32::MAX)
        .with_params(|p| p.with_actor_id(actor(BUYER)).with_value(vara(10)))
        .await;
    assert!(res.is_err());
    let info = h.info(token).await;
    assert_eq!(info.escrow, 0);
    assert!(info.busy.is_none());
    // Only gas was spent: the 10 VARA came back with the error reply.
    assert!(h.balance(BUYER) > before - vara(10));
}

#[tokio::test]
async fn sell_out_caps_the_last_buy_refunds_excess_and_flips_ready() {
    let h = setup().await;
    let token = h.launch("Trade Four", "T4").await;
    h.buy(token, BUYER, vara(200)).await;

    let before = h.balance(BUYER2);
    let program_before = h.program_balance();
    let overpay = vara(1_000);
    let quote = h.svc().quote_buy(token, overpay).await.unwrap();
    assert!(quote.completes_curve);
    assert!(quote.refund_vara > 0);

    let receipt = h.buy(token, BUYER2, overpay).await;
    assert!(receipt.completed_curve);
    assert_eq!(receipt.tokens, quote.amount_out);
    // The program keeps exactly the capped gross; the excess went back to the buyer.
    assert_eq!(h.program_balance() - program_before, overpay - quote.refund_vara);
    let spent = before - h.balance(BUYER2);
    assert!(spent < overpay - quote.refund_vara + vara(5), "excess refunded (gas is billed as value in gtest)");

    let info = h.info(token).await;
    assert_eq!(info.state, LaunchState::Ready);
    assert_eq!(info.real_remaining, U256::zero());
    assert_eq!(info.pool_vara, info.escrow - vara(GRAD_FEE_VARA));
    // Net raise lands within rounding of the configured target.
    let net_target = vara(RAISE_VARA) * 99 / 100;
    assert!(info.escrow + vara(1) >= net_target && info.escrow <= net_target + vara(1));

    let late = h
        .svc()
        .buy(token, U256::zero(), u32::MAX)
        .with_params(|p| p.with_actor_id(actor(BUYER)).with_value(vara(5)))
        .await;
    assert!(late.is_err(), "no buys once Ready");
}

#[tokio::test]
async fn creator_and_protocol_can_claim_fees() {
    let h = setup().await;
    let token = h.launch("Trade Five", "T5").await;
    h.buy(token, BUYER, vara(400)).await;
    let expected = vara(400) * 50 / 10_000;

    let before = h.balance(CREATOR);
    let claimed = h
        .svc()
        .claim_creator_fees(token)
        .with_params(|p| p.with_actor_id(actor(CREATOR)))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(claimed, expected);
    assert!(h.balance(CREATOR) > before);

    let treasury_before = h.balance(TREASURY);
    let protocol = h
        .svc()
        .claim_protocol_fees(token)
        .with_params(|p| p.with_actor_id(actor(KEEPER)))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(protocol, expected);
    assert_eq!(h.balance(TREASURY), treasury_before + expected);

    let info = h.info(token).await;
    assert_eq!(info.creator_fees, 0);
    assert_eq!(info.protocol_fees, 0);
    assert_eq!(h.svc().total_liabilities().await.unwrap(), info.escrow);

    let stranger = h
        .svc()
        .claim_creator_fees(token)
        .with_params(|p| p.with_actor_id(actor(BUYER)))
        .await;
    assert!(stranger.is_err());
}

#[tokio::test]
async fn ex_burner_cannot_burn_curve_inventory_and_creator_holds_no_roles() {
    let h = setup().await;
    let token = h.launch("Trade Six", "T6").await;
    // The creator never gets a role on a curve token.
    for role in ["Admins", "Minters", "Burners"] {
        assert!(!vft_roles(h.system(), token, role).contains(&actor(CREATOR)));
    }
    let program = h.system().get_program(token).unwrap();
    let mid = program.send_bytes(
        CREATOR,
        launchpad_app::wire::encode_call("Vft", "Burn", (h.launchpad_id, tokens(1))),
    );
    let res = h.system().run_next_block();
    assert!(res.failed.contains(&mid), "creator burn must fail");
    assert_eq!(vft_balance(h.system(), token, h.launchpad_id), tokens(TOTAL_SUPPLY_TOKENS));
}

#[tokio::test]
async fn interleaved_trade_is_rejected_while_one_is_in_flight() {
    let h = setup().await;
    let token = h.launch("Trade Seven", "T7").await;
    let first = queue_launchpad_call(&h, BUYER, "Buy", (token, U256::zero(), u32::MAX), vara(50));
    let second = queue_launchpad_call(&h, BUYER2, "Buy", (token, U256::zero(), u32::MAX), vara(50));
    let before2 = h.balance(BUYER2);
    let res = h.system().run_next_block();
    assert!(res.succeed.contains(&first), "first buy executes");
    assert!(res.failed.contains(&second), "second buy hits the busy lock");
    // Let the first buy's transfer reply land.
    h.system().run_next_block();
    let info = h.info(token).await;
    assert!(info.busy.is_none());
    assert_eq!(info.escrow, vara(50) - vara(50) / 100, "only the first buy moved the curve");
    assert!(h.balance(BUYER2) > before2 - vara(1), "rejected buyer got the 50 VARA back");
    assert_eq!(vft_balance(h.system(), token, actor(BUYER2)), U256::zero());
}

#[tokio::test]
async fn failed_transfer_reverts_curve_and_refunds_buyer() {
    let h = setup().await;
    let token = h.launch("Trade Eight", "T8").await;
    let mut gas = gas_config();
    gas.gas_for_token_ops = 1; // VFT transfer runs out of gas -> error reply
    h.set_gas(gas).await;
    let before = h.balance(BUYER);
    let res = h
        .svc()
        .buy(token, U256::zero(), u32::MAX)
        .with_params(|p| p.with_actor_id(actor(BUYER)).with_value(vara(40)))
        .await
        .unwrap();
    assert_eq!(res, Err(launchpad_client::LaunchpadError::TransferFailed));
    let info = h.info(token).await;
    assert!(info.busy.is_none());
    assert_eq!(info.escrow, 0);
    assert_eq!(info.real_remaining, tokens(CURVE_SUPPLY_TOKENS));
    assert_eq!(info.virtual_vara, info.v0);
    assert_eq!(h.liabilities().await, 0);
    assert!(h.balance(BUYER) > before - vara(1), "40 VARA refunded, only gas spent");
    assert_eq!(vft_balance(h.system(), token, actor(BUYER)), U256::zero());
    h.set_gas(gas_config()).await;
    h.buy(token, BUYER, vara(40)).await;
}

#[tokio::test]
async fn dust_sells_are_deferred_until_they_reach_the_existential_deposit() {
    let h = setup().await;
    let token = h.launch("Trade Nine", "T9").await;
    h.buy(token, BUYER, vara(100)).await;
    let dust = tokens(1_000_000); // ~0.2 VARA at the opening price
    let quote = h.svc().quote_sell(token, dust).await.unwrap();
    assert!(quote.amount_out < U256::from(vara(1)), "below ED");
    let before = h.balance(BUYER);
    let receipt = h.sell(token, BUYER, dust).await;
    assert!(receipt.vara > 0);
    assert!(h.balance(BUYER) < before, "nothing was paid out yet (only gas spent)");
    let pending = h.svc().pending_payout(token, actor(BUYER)).await.unwrap();
    assert_eq!(pending, receipt.vara);
    let early = h
        .svc()
        .claim_payout(token)
        .with_params(|p| p.with_actor_id(actor(BUYER)))
        .await
        .unwrap();
    assert_eq!(early, Err(launchpad_client::LaunchpadError::BelowExistentialDeposit));
    let mut total = pending;
    while total < vara(1) {
        total += h.sell(token, BUYER, dust).await.vara;
    }
    assert_eq!(h.svc().pending_payout(token, actor(BUYER)).await.unwrap(), total);
    let before = h.balance(BUYER);
    let paid = h
        .svc()
        .claim_payout(token)
        .with_params(|p| p.with_actor_id(actor(BUYER)))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(paid, total);
    assert!(h.balance(BUYER) > before);
    assert_eq!(h.svc().pending_payout(token, actor(BUYER)).await.unwrap(), 0);
    let info = h.info(token).await;
    assert_eq!(h.liabilities().await, info.escrow + info.creator_fees + info.protocol_fees);
    assert!(h.program_balance() >= h.liabilities().await);
}

#[tokio::test]
async fn curve_product_never_decreases_and_program_stays_solvent() {
    let h = setup().await;
    let token = h.launch("Trade Ten", "T10").await;
    let k0 = {
        let i = h.info(token).await;
        i.v0 * i.t0
    };
    for round in 0..5u128 {
        let r = h.buy(token, BUYER, vara(20 + round * 7)).await;
        h.sell(token, BUYER, r.tokens / 3).await;
        let i = h.info(token).await;
        assert!(i.virtual_vara * i.virtual_tokens >= k0, "k only drifts in the curve's favour");
        assert_eq!(i.escrow, (i.virtual_vara - i.v0).low_u128());
        assert_eq!(h.liabilities().await, i.escrow + i.creator_fees + i.protocol_fees);
        assert!(h.program_balance() >= h.liabilities().await + vara(5), "reserve intact");
    }
}
