//! Shared gtest harness: deploys the real RivrDEX Factory + Pair code, a wVARA program, the
//! ported Tokenator VFT code and the launchpad, then exposes raw-message helpers for the
//! programs we have no generated client for.
#![allow(dead_code)]

use launchpad_app::wire::{decode_reply, encode_call};
use launchpad_client::{
    launchpad::Launchpad as LaunchpadService, Addrs, Config, GasConfig, Launchpad as _,
    LaunchpadCtors as _, LaunchpadProgram, TokenMeta,
};
use sails_rs::{
    client::*,
    gtest::{Program, System},
    prelude::*,
};
use std::path::PathBuf;

pub const UNITS: u128 = 1_000_000_000_000; // 1 VARA in planck
pub const TOKEN: u128 = 1_000_000_000_000_000_000; // 1 token (18 decimals)

pub const ADMIN: u64 = 10;
pub const CREATOR: u64 = 11;
pub const BUYER: u64 = 12;
pub const BUYER2: u64 = 13;
pub const KEEPER: u64 = 14;
pub const TREASURY: u64 = 900;
pub const FEE_TO: u64 = 901;
pub const FACTORY_ID: u64 = 1000;
pub const WVARA_ID: u64 = 1001;
pub const LP_DEAD: [u8; 32] = [1u8; 32];

pub const RAISE_VARA: u128 = 600;
pub const GRAD_FEE_VARA: u128 = 3;
pub const PAIR_FEE_VARA: u128 = 1;
pub const TOTAL_SUPPLY_TOKENS: u128 = 1_000_000_000;
pub const CURVE_SUPPLY_TOKENS: u128 = 800_000_000;

pub struct Harness {
    pub env: GtestEnv,
    pub launchpad: Actor<LaunchpadProgram, GtestEnv>,
    pub launchpad_id: ActorId,
    pub factory: ActorId,
    pub wvara: ActorId,
    pub vft_code: CodeId,
}

fn wasm_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests-wasm")
}

fn read_wasm(name: &str) -> Vec<u8> {
    let path = wasm_dir().join(name);
    std::fs::read(&path).unwrap_or_else(|e| core::panic!("missing {} ({e}); see tests-wasm/README.md", path.display()))
}

pub fn actor(id: u64) -> ActorId {
    ActorId::from(id)
}

pub fn vara(n: u128) -> u128 {
    n * UNITS
}

pub fn tokens(n: u128) -> U256 {
    U256::from(n) * U256::from(TOKEN)
}

/// Sends raw bytes to a program and returns the successful reply payload.
pub fn call_raw(system: &System, program: ActorId, from: u64, payload: Vec<u8>, value: u128) -> Vec<u8> {
    let program = system.get_program(program).expect("program exists");
    let mid = program.send_bytes_with_value(from, payload, value);
    let result = system.run_next_block();
    assert!(
        result.succeed.contains(&mid),
        "message to {:?} failed: {:?}",
        program.id(),
        result.failed
    );
    result
        .log()
        .iter()
        .find(|log| log.reply_to() == Some(mid))
        .map(|log| log.payload().to_vec())
        .expect("reply present")
}

pub fn query<T: Decode>(system: &System, program: ActorId, service: &str, method: &str, args: impl Encode) -> T {
    let reply = call_raw(system, program, ADMIN, encode_call(service, method, args), 0);
    decode_reply(service, method, &reply).expect("decodable reply")
}

pub fn vft_balance(system: &System, token: ActorId, who: ActorId) -> U256 {
    query(system, token, "Vft", "BalanceOf", (who,))
}

pub fn vft_roles(system: &System, token: ActorId, which: &str) -> Vec<ActorId> {
    query(system, token, "Vft", which, ())
}

pub fn vft_approve(system: &System, token: ActorId, from: u64, spender: ActorId, value: U256) -> bool {
    let reply = call_raw(system, token, from, encode_call("Vft", "Approve", (spender, value)), 0);
    decode_reply("Vft", "Approve", &reply).unwrap()
}

pub fn factory_get_pair(system: &System, factory: ActorId, a: ActorId, b: ActorId) -> ActorId {
    query(system, factory, "Factory", "GetPair", (a, b))
}

pub fn pair_reserves(system: &System, pair: ActorId) -> (U256, U256) {
    query(system, pair, "Pair", "GetReserves", ())
}

pub fn pair_tokens(system: &System, pair: ActorId) -> (ActorId, ActorId) {
    query(system, pair, "Pair", "GetTokens", ())
}

#[derive(Encode)]
struct FactoryConfig {
    gas_for_token_ops: u64,
    gas_for_reply_deposit: u64,
    reply_timeout: u32,
    gas_for_full_tx: u64,
    gas_for_pair_creation: u64,
    gas_to_change_fee_to: u64,
}

pub fn gas_config() -> GasConfig {
    GasConfig {
        gas_for_vft_init: 60_000_000_000,
        gas_for_token_ops: 20_000_000_000,
        gas_for_reply_deposit: 20_000_000_000,
        reply_timeout: 100,
        gas_for_create_pair: 320_000_000_000,
        gas_for_add_liquidity: 220_000_000_000,
    }
}

pub fn config(vft_code: CodeId, factory: ActorId, wvara: ActorId) -> Config {
    Config {
        vft_code_id: vft_code,
        addrs: Addrs {
            rivr_factory: factory,
            wvara,
            lp_dead: ActorId::from(LP_DEAD),
            treasury: actor(TREASURY),
        },
        raise_target_vara: vara(RAISE_VARA),
        graduation_fee_vara: vara(GRAD_FEE_VARA),
        pair_creation_fee_vara: vara(PAIR_FEE_VARA),
        total_supply: tokens(TOTAL_SUPPLY_TOKENS),
        curve_supply: tokens(CURVE_SUPPLY_TOKENS),
        token_decimals: 18,
        fee_bps: 100,
        creator_fee_bps: 50,
        min_trade_vara: vara(1),
        min_free_balance: vara(5),
        graduation_timeout_blocks: 1_000,
        launch_cooldown_blocks: 0,
        gas: gas_config(),
    }
}

pub fn meta(name: &str, symbol: &str) -> TokenMeta {
    TokenMeta {
        name: name.into(),
        symbol: symbol.into(),
        description: "A curve-launched token".into(),
        image: "ipfs://image".into(),
        website: None,
        telegram: None,
        twitter: None,
        discord: None,
        tokenomics: None,
    }
}

pub async fn setup() -> Harness {
    let system = System::new();
    system.init_logger_with_default_filter("gwasm=debug,gtest=info,sails_rs=debug");
    for user in [ADMIN, CREATOR, BUYER, BUYER2, KEEPER] {
        system.mint_to(user, vara(1_000_000));
    }

    // RivrDEX: Pair code + Factory program (same config its own tests use).
    let pair_code = system.submit_code(read_wasm("rivr_pair.opt.wasm"));
    let factory_id = {
    let factory = Program::from_binary_with_id(&system, FACTORY_ID, read_wasm("rivr_factory.opt.wasm"));
    let factory_cfg = FactoryConfig {
        gas_for_token_ops: 20_000_000_000,
        gas_for_reply_deposit: 20_000_000_000,
        reply_timeout: 100,
        gas_for_full_tx: 100_000_000_000,
        gas_for_pair_creation: 200_000_000_000,
        gas_to_change_fee_to: 20_000_000_000,
    };
    let mut init = String::from("New").encode();
    init.extend((pair_code, actor(ADMIN), actor(FEE_TO), factory_cfg, actor(TREASURY)).encode());
    let mid = factory.send_bytes(ADMIN, init);
    let res = system.run_next_block();
    assert!(res.succeed.contains(&mid), "factory init failed");
    factory.id()
    };

    // wVARA: awesome-sails test app (Vft + VftNativeExchange), constructor `New()`.
    let wvara_id = {
    let wvara = Program::from_binary_with_id(&system, WVARA_ID, read_wasm("wvara.opt.wasm"));
    let mid = wvara.send_bytes(ADMIN, String::from("New").encode());
    let res = system.run_next_block();
    assert!(res.succeed.contains(&mid), "wvara init failed");
    // awesome-sails VFT storage is sharded and allocated lazily: the first shard must be
    // allocated before any mint (mainnet wVARA has done this long ago).
    for method in ["AllocateNextBalancesShard", "AllocateNextAllowancesShard"] {
        let mid = wvara.send_bytes(ADMIN, encode_call("VftExtension", method, ()));
        let res = system.run_next_block();
        assert!(res.succeed.contains(&mid), "wvara {method} failed");
    }
    wvara.id()
    };

    let vft_code = system.submit_code(tokenator_vft::WASM_BINARY);
    let launchpad_code = system.submit_code(launchpad::WASM_BINARY);

    let env = GtestEnv::new(system, actor(ADMIN));
    let launchpad = env
        .deploy::<LaunchpadProgram>(launchpad_code, b"launchpad".to_vec())
        .new(config(vft_code, factory_id, wvara_id))
        .await
        .expect("launchpad deploys");
    let launchpad_id = launchpad.id();
    // Operating reserve: pays child-program deposits and pair creation.
    launchpad
        .launchpad()
        .top_up_reserve()
        .with_params(|p| p.with_actor_id(actor(ADMIN)).with_value(vara(50)))
        .await
        .expect("top up");

    Harness {
        env,
        launchpad,
        launchpad_id,
        factory: factory_id,
        wvara: wvara_id,
        vft_code,
    }
}

impl Harness {
    pub fn system(&self) -> &System {
        self.env.system()
    }

    pub fn svc(&self) -> Service<launchpad_client::launchpad::LaunchpadImpl, GtestEnv> {
        self.launchpad.launchpad()
    }

    pub async fn launch(&self, name: &str, symbol: &str) -> ActorId {
        self.svc()
            .launch(meta(name, symbol), [7u8; 32], U256::zero())
            .with_params(|p| p.with_actor_id(actor(CREATOR)))
            .await
            .expect("launch call")
            .expect("launch ok")
    }

    pub async fn buy(&self, token: ActorId, who: u64, value: u128) -> launchpad_client::TradeReceipt {
        self.svc()
            .buy(token, U256::zero(), u32::MAX)
            .with_params(|p| p.with_actor_id(actor(who)).with_value(value))
            .await
            .expect("buy call")
            .expect("buy ok")
    }

    pub async fn sell(&self, token: ActorId, who: u64, amount: U256) -> launchpad_client::TradeReceipt {
        assert!(vft_approve(self.system(), token, who, self.launchpad_id, amount));
        self.svc()
            .sell(token, amount, 0, u32::MAX)
            .with_params(|p| p.with_actor_id(actor(who)))
            .await
            .expect("sell call")
            .expect("sell ok")
    }

    pub async fn info(&self, token: ActorId) -> launchpad_client::Launch {
        self.svc().launch_info(token).await.expect("query").expect("launch exists")
    }

    pub fn balance(&self, who: u64) -> u128 {
        self.system().balance_of(who)
    }
}

/// Sends a Launchpad call as raw bytes WITHOUT running a block, so several messages can be
/// queued into the same block (needed to exercise the busy lock / graduation lock).
pub fn queue_launchpad_call(h: &Harness, from: u64, method: &str, args: impl Encode, value: u128) -> MessageId {
    let program = h.system().get_program(h.launchpad_id).expect("launchpad");
    program.send_bytes_with_value(from, encode_call("Launchpad", method, args), value)
}

/// Debug-formats a result and appends the UTF-8 text of any byte list in it, so panic payloads
/// returned as `ReplyHasError(code, [112, 97, ...])` become searchable text.
pub fn err_text<T: core::fmt::Debug>(res: &Result<T, impl core::fmt::Debug>) -> String {
    let raw = match res {
        Ok(v) => format!("Ok({v:?})"),
        Err(e) => format!("{e:?}"),
    };
    let mut decoded = String::new();
    if let (Some(start), Some(end)) = (raw.find('['), raw.rfind(']')) {
        let bytes: Vec<u8> = raw[start + 1..end]
            .split(',')
            .filter_map(|n| n.trim().parse::<u8>().ok())
            .collect();
        decoded = String::from_utf8_lossy(&bytes).into_owned();
    }
    format!("{raw} :: {decoded}")
}

impl Harness {
    pub async fn set_gas(&self, gas: GasConfig) {
        self.svc()
            .set_gas(gas)
            .with_params(|p| p.with_actor_id(actor(ADMIN)))
            .await
            .expect("set_gas");
    }

    pub fn program_balance(&self) -> u128 {
        self.system().balance_of(self.launchpad_id)
    }

    pub async fn liabilities(&self) -> u128 {
        self.svc().total_liabilities().await.expect("query")
    }
}
