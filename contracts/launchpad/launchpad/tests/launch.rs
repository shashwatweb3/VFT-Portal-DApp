mod common;

use common::*;
use launchpad_client::{launchpad::Launchpad as _, LaunchState};
use sails_rs::prelude::*;


#[tokio::test]
async fn launch_spawns_vft_owned_by_launchpad_with_full_supply() {
    let h = setup().await;
    let token = h.launch("Alpha Coin", "ALPHA").await;
    let system = h.system();

    assert_eq!(vft_balance(system, token, h.launchpad_id), tokens(TOTAL_SUPPLY_TOKENS));
    for role in ["Admins", "Minters", "Burners"] {
        assert_eq!(vft_roles(system, token, role), vec![h.launchpad_id], "{role}");
    }
    let total: U256 = query(system, token, "Vft", "TotalSupply", ());
    let max: U256 = query(system, token, "Vft", "MaxSupply", ());
    assert_eq!(total, tokens(TOTAL_SUPPLY_TOKENS));
    assert_eq!(max, tokens(TOTAL_SUPPLY_TOKENS));

    let info = h.info(token).await;
    assert_eq!(info.state, LaunchState::Trading);
    assert_eq!(info.creator, actor(CREATOR));
    assert_eq!(info.real_remaining, tokens(CURVE_SUPPLY_TOKENS));
    assert_eq!(info.escrow, 0);
    assert!(info.v0 > U256::zero() && info.t0 > info.curve_supply);
    assert_eq!(h.svc().launches().await.unwrap(), vec![token]);
}

#[tokio::test]
async fn launch_rejects_duplicate_names_case_insensitively() {
    let h = setup().await;
    h.launch("Beta", "BETA").await;
    assert!(h.svc().name_taken("  beta ".into()).await.unwrap());
    let dup = h
        .svc()
        .launch(meta("BETA", "B2"), [0u8; 32], U256::zero())
        .with_params(|p| p.with_actor_id(actor(CREATOR)))
        .await;
    assert!(dup.is_err(), "duplicate name must be rejected");
    assert_eq!(h.svc().launches().await.unwrap().len(), 1);
    // Same normalisation as `launch`: inner whitespace collapses.
    h.launch("Beta Max", "BMAX").await;
    assert!(h.svc().name_taken("beta   MAX".into()).await.unwrap());
}

#[tokio::test]
async fn launch_with_first_buy_gives_creator_tokens_at_floor_price() {
    let h = setup().await;
    let first_buy = vara(20);
    let before = h.balance(CREATOR);
    let token = h
        .svc()
        .launch(meta("Gamma", "GAM"), [1u8; 32], U256::zero())
        .with_params(|p| p.with_actor_id(actor(CREATOR)).with_value(first_buy))
        .await
        .unwrap()
        .unwrap();
    let held = vft_balance(h.system(), token, actor(CREATOR));
    assert!(held > U256::zero(), "creator received tokens");
    let info = h.info(token).await;
    assert_eq!(info.escrow, first_buy * 99 / 100, "net of the 1 % fee is escrowed");
    assert_eq!(info.creator_fees, first_buy * 50 / 10_000);
    assert_eq!(info.protocol_fees, first_buy * 50 / 10_000);
    assert_eq!(info.real_remaining, tokens(CURVE_SUPPLY_TOKENS) - held);
    assert!(h.balance(CREATOR) <= before - first_buy, "creator paid for the buy");
}

#[tokio::test]
async fn launch_refuses_when_operating_reserve_is_too_low() {
    let h = setup().await;
    // Drain the reserve requirement by raising the minimum far above what the program holds.
    h.svc()
        .set_limits(vara(1), vara(1_000_000), 1_000, 0)
        .with_params(|p| p.with_actor_id(actor(ADMIN)))
        .await
        .unwrap();
    let res = h
        .svc()
        .launch(meta("Delta", "DEL"), [0u8; 32], U256::zero())
        .with_params(|p| p.with_actor_id(actor(CREATOR)))
        .await;
    assert!(res.is_err(), "LowReserve must reject the launch");
    assert!(!h.svc().name_taken("Delta".into()).await.unwrap(), "name is released");
}

#[tokio::test]
async fn spawn_failure_releases_the_name_and_refunds_the_first_buy() {
    let h = setup().await;
    h.svc()
        .set_vft_code_id(CodeId::from([9u8; 32]))
        .with_params(|p| p.with_actor_id(actor(ADMIN)))
        .await
        .unwrap();
    let before = h.balance(CREATOR);
    let res = h
        .svc()
        .launch(meta("Epsilon", "EPS"), [0u8; 32], U256::zero())
        .with_params(|p| p.with_actor_id(actor(CREATOR)).with_value(vara(10)))
        .await
        .unwrap();
    assert!(matches!(res, Err(launchpad_client::LaunchpadError::SpawnFailed(_))), "{res:?}");
    assert!(!h.svc().name_taken("Epsilon".into()).await.unwrap(), "name released");
    assert!(h.balance(CREATOR) > before - vara(1), "first-buy value refunded");
    assert_eq!(h.svc().launches().await.unwrap().len(), 0);
    assert_eq!(h.liabilities().await, 0);
}

#[tokio::test]
async fn first_buy_slippage_is_rejected_before_the_spawn() {
    let h = setup().await;
    let before = h.balance(CREATOR);
    let res = h
        .svc()
        .launch(meta("Zeta", "ZET"), [0u8; 32], U256::MAX)
        .with_params(|p| p.with_actor_id(actor(CREATOR)).with_value(vara(10)))
        .await;
    assert!(err_text(&res).contains("Slippage"), "{}", err_text(&res));
    assert!(!h.svc().name_taken("Zeta".into()).await.unwrap());
    assert!(h.balance(CREATOR) > before - vara(1), "value returned by the trap");
}

#[tokio::test]
async fn launch_cooldown_limits_one_creator() {
    let h = setup().await;
    h.svc()
        .set_limits(vara(1), vara(5), 1_000, 100)
        .with_params(|p| p.with_actor_id(actor(ADMIN)))
        .await
        .unwrap();
    h.launch("Cool One", "C1").await;
    let again = h
        .svc()
        .launch(meta("Cool Two", "C2"), [0u8; 32], U256::zero())
        .with_params(|p| p.with_actor_id(actor(CREATOR)))
        .await;
    assert!(err_text(&again).contains("LaunchCooldown"), "{}", err_text(&again));
    // A different creator is unaffected, and the first creator may launch again after the cooldown.
    h.svc()
        .launch(meta("Other Creator", "OC"), [0u8; 32], U256::zero())
        .with_params(|p| p.with_actor_id(actor(BUYER)))
        .await
        .unwrap()
        .unwrap();
    h.system().run_to_block(h.system().block_height() + 101);
    h.launch("Cool Three", "C3").await;
}
