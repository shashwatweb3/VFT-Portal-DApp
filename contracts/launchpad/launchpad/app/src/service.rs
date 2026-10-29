use crate::{
    curve,
    state::*,
    wire::{self, CallError},
};
extern crate alloc;

use alloc::rc::Rc;
use gstd::prog::ProgramGenerator;
use sails_rs::{
    cell::RefCell,
    gstd::{exec, msg},
    prelude::*,
};

#[event]
#[derive(Debug, Clone, Encode, Decode, TypeInfo)]
pub enum Event {
    Launched {
        token: ActorId,
        creator: ActorId,
        name: String,
        symbol: String,
        decimals: u8,
        description: String,
        image: String,
        v0: U256,
        t0: U256,
        curve_supply: U256,
        pool_tokens: U256,
        raise_target_vara: u128,
        fee_bps: u16,
        creator_fee_bps: u16,
        terms_hash: [u8; 32],
    },
    Bought {
        token: ActorId,
        seq: u64,
        trader: ActorId,
        vara_in: u128,
        fee: u128,
        tokens_out: U256,
        sold_after: U256,
        escrow_after: u128,
        price_after_e18: U256,
    },
    Sold {
        token: ActorId,
        seq: u64,
        trader: ActorId,
        tokens_in: U256,
        fee: u128,
        vara_out: u128,
        deferred: bool,
        sold_after: U256,
        escrow_after: u128,
        price_after_e18: U256,
    },
    Ready {
        token: ActorId,
        escrow: u128,
        pool_vara: u128,
    },
    TradeStuck {
        token: ActorId,
        seq: u64,
    },
    Reconciled {
        token: ActorId,
        seq: u64,
        committed: bool,
    },
    GraduationStep {
        token: ActorId,
        step: GradStep,
    },
    GraduationFailed {
        token: ActorId,
        step: GradStep,
        reason: String,
        retryable: bool,
    },
    ImbalancedListing {
        token: ActorId,
        pair: ActorId,
        reserve0: U256,
        reserve1: U256,
    },
    Graduated {
        token: ActorId,
        pair: ActorId,
        wvara_in_pool: u128,
        tokens_in_pool: U256,
        lp_burned: U256,
        roles_renounced: bool,
    },
    Unwound {
        token: ActorId,
        escrow: u128,
    },
    FeesClaimed {
        token: ActorId,
        to: ActorId,
        amount: u128,
        creator: bool,
    },
    PayoutClaimed {
        token: ActorId,
        to: ActorId,
        amount: u128,
    },
}

/// Everything a buy needs to move the curve, computed before any state is touched.
struct BuyPlan {
    gross_used: u128,
    refund: u128,
    split: curve::FeeSplit,
    tokens_out: U256,
    completes_curve: bool,
}

// ---------------------------------------------------------------------- stateless helpers

fn ensure_no_value() {
    if msg::value() != 0 {
        panic!("ValueNotAccepted")
    }
}

fn plan_buy(launch: &Launch, gross: u128) -> BuyPlan {
    let split = curve::split_fee(gross, launch.fee_bps, launch.creator_fee_bps);
    let net = U256::from(split.net);
    let mut tokens_out = curve::buy_tokens_out(launch.virtual_vara, launch.virtual_tokens, net);
    if tokens_out < launch.real_remaining {
        return BuyPlan {
            gross_used: gross,
            refund: 0,
            split,
            tokens_out,
            completes_curve: false,
        };
    }
    // Sell-out: cap to what is left, charge only for it, refund the rest.
    tokens_out = launch.real_remaining;
    let net_needed = curve::buy_cost_for_tokens(launch.virtual_vara, launch.virtual_tokens, tokens_out);
    let net_needed = net_needed.min(net).low_u128();
    let gross_used = curve::gross_for_net(net_needed, launch.fee_bps).min(gross);
    let split = curve::split_fee(gross_used, launch.fee_bps, launch.creator_fee_bps);
    BuyPlan {
        gross_used,
        refund: gross - gross_used,
        split,
        tokens_out,
        completes_curve: true,
    }
}

/// Applies a planned buy to the curve and records it as the in-flight trade.
fn apply_buy(st: &mut State, token: ActorId, buyer: ActorId, plan: &BuyPlan) -> PendingTrade {
    let expires_at = lock_deadline(exec::block_height(), 1, &st.config.gas);
    let launch = st.launch_mut(&token);
    launch.trade_seq += 1;
    let pending = PendingTrade {
        side: Side::Buy,
        trader: buyer,
        seq: launch.trade_seq,
        vara_gross: plan.gross_used,
        vara_net: plan.split.net,
        fee_creator: plan.split.creator,
        fee_protocol: plan.split.protocol,
        tokens: plan.tokens_out,
        prev_virtual_vara: launch.virtual_vara,
        prev_virtual_tokens: launch.virtual_tokens,
        prev_real_remaining: launch.real_remaining,
        prev_escrow: launch.escrow,
        stuck: false,
        expires_at,
    };
    launch.virtual_vara += U256::from(plan.split.net);
    launch.virtual_tokens -= plan.tokens_out;
    launch.real_remaining -= plan.tokens_out;
    launch.escrow += plan.split.net;
    launch.busy = Some(pending.clone());
    st.owe(plan.split.net);
    pending
}

fn revert_trade(st: &mut State, token: ActorId, pending: &PendingTrade) {
    let launch = st.launch_mut(&token);
    launch.virtual_vara = pending.prev_virtual_vara;
    launch.virtual_tokens = pending.prev_virtual_tokens;
    launch.real_remaining = pending.prev_real_remaining;
    let escrow_delta = if pending.side == Side::Buy {
        launch.escrow - pending.prev_escrow
    } else {
        pending.prev_escrow - launch.escrow
    };
    launch.escrow = pending.prev_escrow;
    launch.busy = None;
    match pending.side {
        Side::Buy => st.settle(escrow_delta),
        Side::Sell => st.owe(escrow_delta),
    }
}

/// Validates a buy without touching state. Callers before an await turn `Err` into a panic
/// (so attached value returns); callers after an await refund explicitly.
fn check_buy(st: &State, token: &ActorId, gross: u128, min_tokens_out: U256) -> Result<BuyPlan, &'static str> {
    if st.paused_buys {
        return Err("BuysPaused");
    }
    if gross < st.config.min_trade_vara {
        return Err("BelowMinTrade");
    }
    let launch = st.launches.get(token).ok_or("LaunchNotFound")?;
    if launch.state != LaunchState::Trading {
        return Err("NotTrading");
    }
    if launch.busy.is_some() || launch.lock_held(exec::block_height()) {
        return Err("TradeInProgress");
    }
    let plan = plan_buy(launch, gross);
    if plan.tokens_out < min_tokens_out {
        return Err("Slippage");
    }
    if plan.tokens_out.is_zero() {
        return Err("ZeroOutput");
    }
    Ok(plan)
}

fn mark_stuck(st: &mut State, token: ActorId) {
    if let Some(p) = st.launch_mut(&token).busy.as_mut() {
        p.stuck = true;
    }
}

fn curve_params_for(config: &Config) -> (curve::CurveParams, u128, U256) {
    let net = curve::split_fee(config.raise_target_vara, config.fee_bps, config.creator_fee_bps).net;
    let pool_vara = net
        .checked_sub(config.graduation_fee_vara)
        .unwrap_or_else(|| panic!("RaiseBelowGraduationFee"));
    let pool_tokens = config.total_supply - config.curve_supply;
    let params = curve::derive_params(
        U256::from(net),
        U256::from(pool_vara),
        config.curve_supply,
        pool_tokens,
    )
    .unwrap_or_else(|| panic!("CurveParams"));
    (params, pool_vara, pool_tokens)
}

/// Uniqueness key of a launch name: inner whitespace collapsed, ASCII case folded.
fn name_key(name: &str) -> String {
    name.split_ascii_whitespace().collect::<Vec<_>>().join(" ").to_ascii_lowercase()
}

fn fail_reason(err: &CallError) -> String {
    String::from(err.describe())
}

/// Callee gas limits of every message a graduation step may send, worst case.
fn step_calls(step: GradStep, g: &GasConfig) -> Vec<u64> {
    let t = g.gas_for_token_ops;
    match step {
        GradStep::WrapVara => vec![t],
        GradStep::FindOrCreatePair => vec![t, g.gas_for_create_pair, t, t],
        GradStep::ApproveToken | GradStep::ApproveWvara => vec![t],
        GradStep::AlignPrice => vec![t, t, t, g.gas_for_add_liquidity],
        GradStep::AddLiquidity => vec![t, t, t, t, t, g.gas_for_add_liquidity],
        GradStep::BurnLp | GradStep::RevokeMinter | GradStep::RevokeBurner | GradStep::RevokeAdmin => vec![t, t],
        GradStep::Settle => vec![t; 7],
        GradStep::Done => vec![],
    }
}

/// Entry for a tracked value send in `gas_needed`: no callee gas, only its reply deposit.
const VALUE_SEND: u64 = 0;

/// Gas a message making `calls` needs in total: callee gas, reply deposits and our own
/// continuations. Only used to bound the config; the runtime's gas estimate covers callers.
fn gas_needed(g: &GasConfig, calls: &[u64]) -> u64 {
    calls.iter().fold(0u64, |acc, callee| {
        acc.saturating_add(*callee)
            .saturating_add(g.gas_for_reply_deposit)
            .saturating_add(wire::CONTINUATION_GAS)
    })
}

/// Launches one program will hold. Each costs about 1.4 KB of the 32 MiB a Gear program may
/// use (state, map overhead, name and order entries); past the memory limit every allocating
/// message would trap, sells and claims included. The cap keeps well clear of that; later
/// launches go to a successor launchpad.
pub const MAX_LAUNCHES: usize = 10_000;
pub const MAX_PAGE: u32 = 100;
/// Alignment actions a launch takes before it lists at the pool's own price instead. A pool
/// seeded deep and far off the curve price cannot be moved with our budget, and AlignPrice is
/// past the unwindable steps, so without a bound such a seed would freeze the escrow for good.
pub const MAX_ALIGN_ROUNDS: u8 = 8;

/// Most gas one message may carry on Vara (the per-block limit).
pub const MAX_MESSAGE_GAS: u64 = 750_000_000_000;
/// Enough for `handle_reply` to re-credit a bounced payout.
pub const MIN_REPLY_DEPOSIT: u64 = 1_000_000_000;
pub const REPLY_TIMEOUT_BLOCKS: core::ops::RangeInclusive<u32> = 10..=1_000;
/// Gives the keeper time to retry a forced failure before anyone may unwind (about 30 minutes
/// to 30 days at 3 s blocks).
pub const GRADUATION_TIMEOUT_BLOCKS: core::ops::RangeInclusive<u32> = 600..=864_000;

const ALL_STEPS: [GradStep; 12] = [
    GradStep::WrapVara,
    GradStep::FindOrCreatePair,
    GradStep::ApproveToken,
    GradStep::ApproveWvara,
    GradStep::AlignPrice,
    GradStep::AddLiquidity,
    GradStep::BurnLp,
    GradStep::RevokeMinter,
    GradStep::RevokeBurner,
    GradStep::RevokeAdmin,
    GradStep::Settle,
    GradStep::Done,
];

/// Panics unless `c` is a configuration every entrypoint can work with. Run by the constructor
/// and by every setter on the would-be result, so no admin call can leave a bad config behind.
/// Fees, supplies and the raise are frozen per launch at creation, and so is the graduation
/// timeout. Gas stays global on purpose: if runtime costs rise, live launches must be fixable,
/// so it is bounded here instead (the costliest message must still fit in a block).
pub fn validate_config(c: &Config) {
    let check = |ok: bool, reason: &str| {
        if !ok {
            panic!("BadConfig: {}", reason)
        }
    };
    check(c.creator_fee_bps <= c.fee_bps && (c.fee_bps as u128) < curve::BPS, "fees");
    check(c.graduation_fee_vara >= c.pair_creation_fee_vara, "graduation fee below pair fee");
    check(!c.curve_supply.is_zero() && c.curve_supply < c.total_supply, "supplies");
    check(c.min_trade_vara > 0, "min trade");
    check(GRADUATION_TIMEOUT_BLOCKS.contains(&c.graduation_timeout_blocks), "graduation timeout");
    let a = &c.addrs;
    check(
        ![a.rivr_factory, a.wvara, a.lp_dead, a.treasury].iter().any(|x| x.is_zero()),
        "zero address",
    );
    let g = &c.gas;
    check(REPLY_TIMEOUT_BLOCKS.contains(&g.reply_timeout), "reply timeout");
    check(g.gas_for_reply_deposit >= MIN_REPLY_DEPOSIT, "reply deposit");
    let launch = [g.gas_for_vft_init, g.gas_for_token_ops, VALUE_SEND, VALUE_SEND];
    let costliest = ALL_STEPS
        .iter()
        .map(|s| gas_needed(g, &step_calls(*s, g)))
        .chain([gas_needed(g, &launch)])
        .max()
        .unwrap_or(0);
    check(costliest <= MAX_MESSAGE_GAS, "gas exceeds the block limit");
    // The curve must derive (raise covers fees, pool opens at or above the curve's last price).
    let net = curve::split_fee(c.raise_target_vara, c.fee_bps, c.creator_fee_bps).net;
    let ok = net.checked_sub(c.graduation_fee_vara).is_some_and(|pool_vara| {
        curve::derive_params(
            U256::from(net),
            U256::from(pool_vara),
            c.curve_supply,
            c.total_supply - c.curve_supply,
        )
        .is_some()
    });
    check(ok, "curve");
}

/// First block at which a message making `calls` awaited calls can no longer be running: each
/// await resolves (reply or timeout) within `reply_timeout` blocks.
fn lock_deadline(now: u32, calls: usize, g: &GasConfig) -> u32 {
    let per_call = g.reply_timeout.saturating_add(1);
    now.saturating_add(per_call.saturating_mul(calls as u32))
        .saturating_add(wire::LOCK_MARGIN_BLOCKS)
}

pub struct LaunchpadService<'a> {
    state: &'a Rc<RefCell<State>>,
}

impl<'a> LaunchpadService<'a> {
    pub fn new(state: &'a Rc<RefCell<State>>) -> Self {
        Self { state }
    }

    /// Runs `recover` on the state if a later continuation of this message traps (runs out of
    /// gas or panics after an await), so a starved message cannot leave a lock or trade behind.
    /// gstd system-reserves gas for the signal on every async message and drops the hook when
    /// the message completes; a later call replaces it. `lock_expires_at` stays as a backstop.
    ///
    /// This replaces an up-front `gas_available` guard: that syscall is forbidden during RPC
    /// gas estimation, and any headroom check beyond actual use fails the estimator's second
    /// pass, so wallets could not send to the program at all.
    fn on_trap(&self, mut recover: impl FnMut(&mut State) + 'static) {
        let state = Rc::clone(self.state);
        gstd::critical::set_hook(move || recover(&mut state.borrow_mut()));
    }

    fn with_state<R>(&self, f: impl FnOnce(&State) -> R) -> R {
        f(&self.state.borrow())
    }

    fn with_state_mut<R>(&self, f: impl FnOnce(&mut State) -> R) -> R {
        f(&mut self.state.borrow_mut())
    }

    fn gas(&self) -> GasConfig {
        self.with_state(|st| st.config.gas.clone())
    }

    fn ensure_admin(&self) {
        if self.with_state(|st| st.admin) != msg::source() {
            panic!("Unauthorized")
        }
    }

    /// Applies `change` to a copy of the config and stores it only if it validates.
    fn update_config(&self, change: impl FnOnce(&mut Config)) {
        let mut config = self.with_state(|st| st.config.clone());
        change(&mut config);
        validate_config(&config);
        self.with_state_mut(|st| st.config = config);
    }

    /// Pays out `amount`, which must no longer be on the books. A send the runtime refuses
    /// becomes a pending payout at once, and one that later bounces becomes one in
    /// `handle_reply`; either way `to` can `ClaimPayout` it. Returns whether the value went out.
    fn pay(&self, token: ActorId, to: ActorId, amount: u128) -> bool {
        if amount == 0 {
            return true;
        }
        if let Some(id) = wire::send_value(to, amount, self.gas().gas_for_reply_deposit) {
            self.with_state_mut(|st| st.payouts_in_flight.insert(id, (token, to, amount)));
            return true;
        }
        self.with_state_mut(|st| st.credit_payout(token, to, amount));
        false
    }

    /// Pays a seller, deferring amounts below the existential deposit until they add up to it.
    /// Returns whether the payout was deferred.
    fn pay_seller(&self, token: ActorId, pending: &PendingTrade) -> bool {
        let amount = pending.vara_net;
        if amount != 0 && amount < wire::existential_deposit() {
            self.with_state_mut(|st| st.credit_payout(token, pending.trader, amount));
            return true;
        }
        !self.pay(token, pending.trader, amount)
    }
}

#[sails_rs::service(events = Event)]
impl<'a> LaunchpadService<'a> {
    // ------------------------------------------------------------------ launch

    /// Spawns a new VFT with the launchpad as its only admin, minter and burner and opens its
    /// curve. Any attached value is the creator's first buy (the voucher only covers gas).
    #[export]
    pub async fn launch(
        &mut self,
        meta: TokenMeta,
        terms_hash: [u8; 32],
        first_buy_min_tokens_out: U256,
    ) -> Result<ActorId, LaunchpadError> {
        let creator = msg::source();
        let value = msg::value();
        let (payload, gas, config, name_key) = self.with_state_mut(|st| {
            // Printable ASCII only (the create form allows Latin letters and spaces), so look-alike
            // Unicode names cannot dodge the uniqueness check; inner whitespace is collapsed.
            let printable = |s: &str| s.chars().all(|c| c.is_ascii_graphic() || c == ' ');
            if !printable(&meta.name) || !printable(&meta.symbol) {
                panic!("BadName")
            }
            let name_key = name_key(&meta.name);
            if name_key.is_empty() || meta.name.len() > 64 {
                panic!("BadName")
            }
            if meta.symbol.trim().is_empty() || meta.symbol.len() > 16 || meta.symbol.contains(' ') {
                panic!("BadSymbol")
            }
            let link_ok = |l: &Option<String>| l.as_ref().is_none_or(|s| s.len() <= 256);
            if meta.image.len() > 256
                || !link_ok(&meta.website)
                || !link_ok(&meta.telegram)
                || !link_ok(&meta.twitter)
                || !link_ok(&meta.discord)
                || !link_ok(&meta.tokenomics)
            {
                panic!("LinkTooLong")
            }
            if meta.description.chars().count() > 500 {
                panic!("BadDescription")
            }
            if st.names.contains(&name_key) {
                panic!("NameTaken")
            }
            if st.launch_order.len() >= MAX_LAUNCHES {
                panic!("LaunchCapReached")
            }
            let now = exec::block_height();
            if let Some(last) = st.last_launch_by_creator.get(&creator) {
                if now < last.saturating_add(st.config.launch_cooldown_blocks) {
                    panic!("LaunchCooldown")
                }
            }
            st.last_launch_by_creator.insert(creator, now);
            if value != 0 {
                if st.paused_buys {
                    panic!("BuysPaused")
                }
                if value < st.config.min_trade_vara {
                    panic!("BelowMinTrade")
                }
            }
            let free = exec::value_available()
                .saturating_sub(value)
                .saturating_sub(st.total_liabilities);
            if free < st.config.min_free_balance {
                panic!("LowReserve")
            }
            if value != 0 {
                // The curve of a fresh launch is fully determined by config, so the first buy can
                // be quoted before the spawn await; a later mismatch is refunded, never trapped.
                let (params, _, _) = curve_params_for(&st.config);
                let split = curve::split_fee(value, st.config.fee_bps, st.config.creator_fee_bps);
                let out = curve::buy_tokens_out(params.v0, params.t0, U256::from(split.net));
                if out < first_buy_min_tokens_out || out.is_zero() {
                    panic!("Slippage")
                }
            }
            st.names.insert(name_key.clone());
            let init = wire::VftInit {
                name: meta.name.clone(),
                symbol: meta.symbol.clone(),
                decimals: st.config.token_decimals,
                description: meta.description.clone(),
                external_links: wire::VftExternalLinks {
                    image: meta.image.clone(),
                    website: meta.website.clone(),
                    telegram: meta.telegram.clone(),
                    twitter: meta.twitter.clone(),
                    discord: meta.discord.clone(),
                    tokenomics: meta.tokenomics.clone(),
                },
                initial_supply: st.config.total_supply,
                max_supply: st.config.total_supply,
                admin_id: exec::program_id(),
            };
            (
                wire::vft_init_payload(&init),
                st.config.gas.clone(),
                st.config.clone(),
                name_key,
            )
        });

        // A trap after the spawn await (before the launch is recorded) frees the name and makes
        // the creator's VARA claimable again. The cooldown stays: the spawn may have happened
        // and cost the reserve its existential deposit, so starving it must not be repeatable.
        let (hook_name, hook_creator) = (name_key.clone(), creator);
        self.on_trap(move |st| {
            st.names.remove(&hook_name);
            if value > 0 {
                st.credit_payout(ActorId::zero(), hook_creator, value);
            }
        });
        // Same rule as `wire::call`: only a failure before the spawn is queued may refund.
        let spawned: Result<ActorId, String> = match ProgramGenerator::create_program_bytes_with_gas_for_reply(
            config.vft_code_id,
            payload,
            gas.gas_for_vft_init,
            0,
            0,
        ) {
            Err(e) => Err(format!("{e:?}")),
            Ok(future) => {
                if gas.gas_for_reply_deposit != 0 {
                    exec::reply_deposit(future.waiting_reply_to, gas.gas_for_reply_deposit)
                        .unwrap_or_else(|_| panic!("ReplyDepositFailed"));
                }
                future
                    .up_to(Some(gas.reply_timeout))
                    .unwrap_or_else(|_| panic!("ReplyWaitFailed"))
                    .await
                    .map(|(token, _)| token)
                    .map_err(|e| format!("{e:?}"))
            }
        };
        let token = match spawned {
            Ok(token) => token,
            Err(reason) => {
                self.with_state_mut(|st| {
                    st.names.remove(&name_key);
                    st.last_launch_by_creator.remove(&creator);
                });
                self.pay(ActorId::zero(), creator, value);
                return Err(LaunchpadError::SpawnFailed(reason));
            }
        };

        let (params, pool_vara_target, pool_tokens) = curve_params_for(&config);
        self.with_state_mut(|st| {
            let launch = Launch {
                token,
                creator,
                name: meta.name.clone(),
                symbol: meta.symbol.clone(),
                state: LaunchState::Trading,
                step: GradStep::WrapVara,
                v0: params.v0,
                t0: params.t0,
                virtual_vara: params.v0,
                virtual_tokens: params.t0,
                curve_supply: config.curve_supply,
                real_remaining: config.curve_supply,
                pool_tokens,
                escrow: 0,
                pool_vara: pool_vara_target,
                graduation_fee: config.graduation_fee_vara,
                pair_creation_fee: config.pair_creation_fee_vara,
                creator_fees: 0,
                protocol_fees: 0,
                trade_seq: 0,
                busy: None,
                lock: false,
                lock_expires_at: 0,
                pair: ActorId::zero(),
                pair_created_by_us: false,
                wvara_is_token0: false,
                wrapped: false,
                liquidity_added: false,
                pre_add_balances: None,
                wvara_budget: U256::from(pool_vara_target),
                token_budget: pool_tokens,
                lp_burned: U256::zero(),
                roles_renounced: false,
                created_at: exec::block_height(),
                ready_at: 0,
                fail_reason: String::new(),
                fail_retryable: false,
                failed_since: None,
                graduation_timeout_blocks: config.graduation_timeout_blocks,
                addrs: config.addrs.clone(),
                terms_hash,
                fee_bps: config.fee_bps,
                creator_fee_bps: config.creator_fee_bps,
            };
            st.launches.insert(token, launch);
            st.launch_order.push(token);
        });
        self.emit_event(Event::Launched {
            token,
            creator,
            name: meta.name,
            symbol: meta.symbol,
            decimals: config.token_decimals,
            description: meta.description,
            image: meta.image,
            v0: params.v0,
            t0: params.t0,
            curve_supply: config.curve_supply,
            pool_tokens,
            raise_target_vara: config.raise_target_vara,
            fee_bps: config.fee_bps,
            creator_fee_bps: config.creator_fee_bps,
            terms_hash,
        })
        .expect("event");

        if value > 0 {
            // The first buy runs through the same path as any other buy. Nothing may panic
            // after the spawn await, so a failed check or transfer refunds the creator and
            // leaves the launch open.
            match self.with_state(|st| check_buy(st, &token, value, first_buy_min_tokens_out)) {
                Ok(plan) => {
                    let _ = self.run_buy(token, creator, plan).await;
                }
                Err(reason) => {
                    self.pay(token, creator, value);
                    return Err(LaunchpadError::FirstBuySkipped(String::from(reason)));
                }
            }
        }
        Ok(token)
    }

    // ------------------------------------------------------------------ trading

    #[export]
    pub async fn buy(
        &mut self,
        token: ActorId,
        min_tokens_out: U256,
        deadline_block: u32,
    ) -> Result<TradeReceipt, LaunchpadError> {
        if exec::block_height() > deadline_block {
            panic!("DeadlineExpired")
        }
        let buyer = msg::source();
        let gross = msg::value();
        let plan = self
            .with_state(|st| check_buy(st, &token, gross, min_tokens_out))
            .unwrap_or_else(|reason| panic!("{reason}"));
        self.run_buy(token, buyer, plan).await
    }

    #[export]
    pub async fn sell(
        &mut self,
        token: ActorId,
        amount: U256,
        min_vara_out: u128,
        deadline_block: u32,
    ) -> Result<TradeReceipt, LaunchpadError> {
        ensure_no_value();
        if exec::block_height() > deadline_block {
            panic!("DeadlineExpired")
        }
        let seller = msg::source();
        let gas = self.gas();
        let pending = self.with_state_mut(|st| {
            let launch = st.launch(&token);
            if !matches!(launch.state, LaunchState::Trading | LaunchState::Aborted) {
                panic!("NotTrading")
            }
            if launch.busy.is_some() || launch.lock_held(exec::block_height()) {
                panic!("TradeInProgress")
            }
            if amount.is_zero() {
                panic!("ZeroInput")
            }
            let gross = curve::sell_vara_out(launch.virtual_vara, launch.virtual_tokens, amount);
            if gross > U256::from(launch.escrow) {
                panic!("EscrowExhausted")
            }
            let gross = gross.low_u128();
            let split = curve::split_fee(gross, launch.fee_bps, launch.creator_fee_bps);
            if split.net < min_vara_out {
                panic!("Slippage")
            }
            if split.net == 0 {
                panic!("ZeroOutput")
            }
            let launch = st.launch_mut(&token);
            launch.trade_seq += 1;
            let pending = PendingTrade {
                side: Side::Sell,
                trader: seller,
                seq: launch.trade_seq,
                vara_gross: gross,
                vara_net: split.net,
                fee_creator: split.creator,
                fee_protocol: split.protocol,
                tokens: amount,
                prev_virtual_vara: launch.virtual_vara,
                prev_virtual_tokens: launch.virtual_tokens,
                prev_real_remaining: launch.real_remaining,
                prev_escrow: launch.escrow,
                stuck: false,
                expires_at: lock_deadline(exec::block_height(), 1, &gas),
            };
            launch.virtual_vara -= U256::from(gross);
            launch.virtual_tokens += amount;
            launch.real_remaining += amount;
            launch.escrow -= gross;
            launch.busy = Some(pending.clone());
            st.settle(gross);
            pending
        });
        self.on_trap(move |st| mark_stuck(st, token));
        let me = exec::program_id();
        match wire::vft_transfer_from(token, seller, me, amount, &gas).await {
            Ok(true) => Ok(self.commit_trade(token, &pending)),
            Ok(false) | Err(CallError::Send) | Err(CallError::Reply) | Err(CallError::Arithmetic) => {
                self.with_state_mut(|st| revert_trade(st, token, &pending));
                Err(LaunchpadError::TransferFailed)
            }
            // An undecodable success reply may still mean the transfer happened: reconcile.
            Err(CallError::Timeout) | Err(CallError::Decode) => {
                self.with_state_mut(|st| mark_stuck(st, token));
                self.emit_event(Event::TradeStuck { token, seq: pending.seq }).expect("event");
                Err(LaunchpadError::TradeStuck)
            }
        }
    }

    /// Resolves a trade whose transfer reply timed out by reading the VFT balance the launchpad
    /// actually holds. Anyone may call it.
    #[export]
    pub async fn reconcile(&mut self, token: ActorId) -> Result<bool, LaunchpadError> {
        ensure_no_value();
        let gas = self.gas();
        let pending = self.with_state_mut(|st| {
            let now = exec::block_height();
            let launch = st.launch_mut(&token);
            if launch.lock_held(now) {
                panic!("ReconcileInProgress")
            }
            // A trade whose sending message trapped after the send is reconciled like a timeout.
            let pending = match &launch.busy {
                Some(p) if p.reconcilable(now) => p.clone(),
                _ => panic!("NotStuck"),
            };
            launch.lock = true;
            launch.lock_expires_at = lock_deadline(now, 1, &gas);
            pending
        });
        self.on_trap(move |st| st.launch_mut(&token).lock = false);
        let me = exec::program_id();
        let held = wire::vft_balance_of(token, me, &gas).await;
        self.with_state_mut(|st| st.launch_mut(&token).lock = false);
        let held = held.map_err(|_| LaunchpadError::Unreconcilable)?;
        let (committed_expected, reverted_expected) = self.with_state(|st| {
            let launch = st.launch(&token);
            (
                launch.real_remaining + launch.pool_tokens,
                pending.prev_real_remaining + launch.pool_tokens,
            )
        });
        let outcome = pending.reconcile_outcome(held, committed_expected, reverted_expected);
        if outcome == Some(true) {
            self.commit_trade(token, &pending);
            self.emit_event(Event::Reconciled { token, seq: pending.seq, committed: true })
                .expect("event");
            Ok(true)
        } else if outcome == Some(false) {
            self.with_state_mut(|st| revert_trade(st, token, &pending));
            if pending.side == Side::Buy {
                self.pay(token, pending.trader, pending.vara_gross);
            }
            self.emit_event(Event::Reconciled { token, seq: pending.seq, committed: false })
                .expect("event");
            Ok(false)
        } else {
            Err(LaunchpadError::Unreconcilable)
        }
    }

    // ------------------------------------------------------------------ graduation

    /// Runs exactly one graduation step. Permissionless; the keeper loops it until `Done`.
    #[export]
    pub async fn graduate(&mut self, token: ActorId) -> Result<GradStep, LaunchpadError> {
        ensure_no_value();
        let gas = self.gas();
        if self.with_state(|st| st.launch(&token).state == LaunchState::Graduated) {
            return Ok(GradStep::Done);
        }
        let (step, launch) = self.with_state_mut(|st| {
            let now = exec::block_height();
            let launch = st.launch_mut(&token);
            if launch.busy.is_some() {
                panic!("TradeInProgress")
            }
            if launch.lock_held(now) {
                panic!("GraduationInProgress")
            }
            let step = match launch.state {
                LaunchState::Ready => GradStep::WrapVara,
                LaunchState::Graduating => launch.step,
                LaunchState::Failed => {
                    if !launch.fail_retryable {
                        panic!("NotRetryable")
                    }
                    // The price may have moved since; re-align before depositing. Not while a
                    // deposit is unresolved: its wVARA may be gone already, and an AlignPrice
                    // swap would then spend other launches' wVARA.
                    if launch.step == GradStep::AddLiquidity
                        && !launch.liquidity_added
                        && launch.pre_add_balances.is_none()
                    {
                        GradStep::AlignPrice
                    } else {
                        launch.step
                    }
                }
                _ => panic!("NotGraduating"),
            };
            let calls = step_calls(step, &gas);
            launch.state = LaunchState::Graduating;
            launch.step = step;
            launch.lock = true;
            launch.lock_expires_at = lock_deadline(now, calls.len(), &gas);
            (step, launch.clone())
        });
        self.on_trap(move |st| st.launch_mut(&token).lock = false);
        let me = exec::program_id();
        let mut repeat = false;
        let outcome: Result<(), CallError> = match step {
            GradStep::WrapVara => self.step_wrap(&launch, &gas).await,
            GradStep::FindOrCreatePair => self.step_find_or_create_pair(&launch, &gas).await,
            GradStep::ApproveToken => wire::vft_approve(token, launch.pair, launch.pool_tokens, &gas)
                .await
                .map(|_| ()),
            GradStep::ApproveWvara => {
                wire::vft_approve(launch.addrs.wvara, launch.pair, U256::from(launch.pool_vara), &gas)
                    .await
                    .map(|_| ())
            }
            GradStep::AlignPrice => self
                .step_align_price(&launch, &gas)
                .await
                .map(|finished| repeat = !finished),
            GradStep::AddLiquidity => self.step_add_liquidity(&launch, me, &gas).await,
            GradStep::BurnLp => self.step_burn_lp(&launch, me, &gas).await,
            GradStep::RevokeMinter => self.step_revoke(&launch, me, "Minters", "RevokeMinterRole", &gas).await,
            GradStep::RevokeBurner => self.step_revoke(&launch, me, "Burners", "RevokeBurnerRole", &gas).await,
            GradStep::RevokeAdmin => self.step_revoke(&launch, me, "Admins", "RevokeAdminRole", &gas).await,
            GradStep::Settle => self.step_settle(&launch, me, &gas).await,
            GradStep::Done => Ok(()),
        };
        self.with_state_mut(|st| st.launch_mut(&token).lock = false);
        if step == GradStep::Done {
            return Ok(GradStep::Done);
        }
        match outcome {
            Ok(()) => {
                let next = if repeat { step } else { step.next() };
                self.with_state_mut(|st| {
                    let launch = st.launch_mut(&token);
                    launch.step = next;
                    launch.fail_reason = String::new();
                    launch.failed_since = None;
                    if next == GradStep::Done {
                        launch.state = LaunchState::Graduated;
                    }
                });
                self.emit_event(Event::GraduationStep { token, step }).expect("event");
                if next == GradStep::Done {
                    let launch = self.with_state(|st| st.launch(&token).clone());
                    self.emit_event(Event::Graduated {
                        token,
                        pair: launch.pair,
                        wvara_in_pool: launch.pool_vara,
                        tokens_in_pool: launch.pool_tokens,
                        lp_burned: launch.lp_burned,
                        roles_renounced: launch.roles_renounced,
                    })
                    .expect("event");
                }
                Ok(next)
            }
            Err(err) => {
                let reason = fail_reason(&err);
                let retryable = err.is_retryable();
                self.with_state_mut(|st| {
                    let launch = st.launch_mut(&token);
                    launch.state = LaunchState::Failed;
                    launch.fail_reason = reason.clone();
                    launch.fail_retryable = retryable;
                    launch.failed_since.get_or_insert(exec::block_height());
                });
                self.emit_event(Event::GraduationFailed {
                    token,
                    step,
                    reason: reason.clone(),
                    retryable,
                })
                .expect("event");
                Err(LaunchpadError::GraduationFailed { step, reason, retryable })
            }
        }
    }

    /// Pulls the pool VARA back out of wVARA after a failed or stale graduation and reopens
    /// sells at the frozen curve. Buys stay closed for good.
    #[export]
    pub async fn unwind(&mut self, token: ActorId) -> Result<(), LaunchpadError> {
        ensure_no_value();
        let gas = self.gas();
        let calls = [gas.gas_for_token_ops];
        let launch = self.with_state_mut(|st| {
            let launch = st.launch_mut(&token);
            let timeout = launch.graduation_timeout_blocks;
            let now = exec::block_height();
            let stale_ready = launch.state == LaunchState::Ready && now >= launch.ready_at.saturating_add(timeout);
            // A failure anyone can force (e.g. by starving a step of gas) must not abort the
            // listing on the spot: the keeper gets the whole timeout to retry first.
            let failed_early = launch.state == LaunchState::Failed
                && launch.step.is_unwindable()
                && launch.failed_since.is_some_and(|at| now >= at.saturating_add(timeout));
            if !(stale_ready || failed_early) {
                panic!("NotUnwindable")
            }
            if launch.lock_held(now) || launch.busy.is_some() {
                panic!("GraduationInProgress")
            }
            launch.lock = true;
            launch.lock_expires_at = lock_deadline(now, calls.len(), &gas);
            launch.clone()
        });
        self.on_trap(move |st| st.launch_mut(&token).lock = false);
        let result = self.unwind_wrapped(&launch, &gas).await;
        self.with_state_mut(|st| st.launch_mut(&token).lock = false);
        result.map_err(|err| LaunchpadError::GraduationFailed {
            step: launch.step,
            reason: fail_reason(&err),
            retryable: true,
        })?;
        let escrow = self.with_state_mut(|st| {
            let l = st.launch_mut(&token);
            l.state = LaunchState::Aborted;
            l.escrow
        });
        self.emit_event(Event::Unwound { token, escrow }).expect("event");
        Ok(())
    }

    // ------------------------------------------------------------------ claims

    /// Pays the creator in the reply itself, which reaches a program caller too.
    #[export]
    pub fn claim_creator_fees(&mut self, token: ActorId) -> CommandReply<Result<u128, LaunchpadError>> {
        ensure_no_value();
        let caller = msg::source();
        let amount = self.with_state_mut(|st| {
            let launch = st.launch_mut(&token);
            if launch.creator != caller {
                panic!("Unauthorized")
            }
            let amount = launch.creator_fees;
            if amount == 0 {
                return Err(LaunchpadError::NothingToClaim);
            }
            if amount < wire::existential_deposit() {
                return Err(LaunchpadError::BelowExistentialDeposit);
            }
            launch.creator_fees = 0;
            st.settle(amount);
            Ok(amount)
        });
        let amount = match amount {
            Ok(amount) => amount,
            Err(err) => return Err(err).into(),
        };
        self.emit_event(Event::FeesClaimed { token, to: caller, amount, creator: true })
            .expect("event");
        CommandReply::new(Ok(amount)).with_value(amount)
    }

    /// Anyone may trigger it; the fees always go to the launch's treasury. Called by the treasury
    /// itself they come in the reply (which works for a program treasury, e.g. a multisig);
    /// otherwise they are sent, and a send that bounces waits for the treasury's `ClaimPayout`.
    #[export]
    pub fn claim_protocol_fees(&mut self, token: ActorId) -> CommandReply<Result<u128, LaunchpadError>> {
        ensure_no_value();
        let caller = msg::source();
        let claimed = self.with_state_mut(|st| {
            let launch = st.launch_mut(&token);
            let amount = launch.protocol_fees;
            if amount == 0 {
                return Err(LaunchpadError::NothingToClaim);
            }
            if amount < wire::existential_deposit() {
                return Err(LaunchpadError::BelowExistentialDeposit);
            }
            launch.protocol_fees = 0;
            let treasury = launch.addrs.treasury;
            st.settle(amount);
            Ok((amount, treasury))
        });
        let (amount, treasury) = match claimed {
            Ok(claimed) => claimed,
            Err(err) => return Err(err).into(),
        };
        self.emit_event(Event::FeesClaimed { token, to: treasury, amount, creator: false })
            .expect("event");
        if caller == treasury {
            return CommandReply::new(Ok(amount)).with_value(amount);
        }
        self.pay(token, treasury, amount);
        Ok(amount).into()
    }

    /// Pays out what is pending for the caller (deferred sell proceeds, bounced sends) in the
    /// reply itself, so it reaches a program caller too. `token` zero holds refunds of launches
    /// that failed to spawn.
    #[export]
    pub fn claim_payout(&mut self, token: ActorId) -> CommandReply<Result<u128, LaunchpadError>> {
        ensure_no_value();
        let caller = msg::source();
        let amount = self.with_state_mut(|st| {
            let amount = st.pending_payouts.get(&(token, caller)).copied().unwrap_or(0);
            if amount == 0 {
                return Err(LaunchpadError::NothingToClaim);
            }
            if amount < wire::existential_deposit() {
                return Err(LaunchpadError::BelowExistentialDeposit);
            }
            st.pending_payouts.remove(&(token, caller));
            st.settle(amount);
            Ok(amount)
        });
        let amount = match amount {
            Ok(amount) => amount,
            Err(err) => return Err(err).into(),
        };
        self.emit_event(Event::PayoutClaimed { token, to: caller, amount }).expect("event");
        CommandReply::new(Ok(amount)).with_value(amount)
    }

    // ------------------------------------------------------------------ queries

    #[export]
    pub fn quote_buy(&self, token: ActorId, vara_in: u128) -> Quote {
        self.with_state(|st| {
            let launch = st.launch(&token);
            let plan = plan_buy(launch, vara_in);
            let vs = launch.virtual_vara + U256::from(plan.split.net);
            let vt = launch.virtual_tokens - plan.tokens_out;
            Quote {
                side: Side::Buy,
                amount_in: U256::from(vara_in),
                amount_out: plan.tokens_out,
                fee_vara: plan.split.fee,
                price_after_e18: curve::price_e18(vs, vt),
                completes_curve: plan.completes_curve,
                refund_vara: plan.refund,
            }
        })
    }

    #[export]
    pub fn quote_sell(&self, token: ActorId, tokens_in: U256) -> Quote {
        self.with_state(|st| {
            let launch = st.launch(&token);
            let gross = curve::sell_vara_out(launch.virtual_vara, launch.virtual_tokens, tokens_in);
            // `sell` rejects more than the escrow holds (EscrowExhausted); quote nothing for it.
            let gross = if gross > U256::from(launch.escrow) { 0 } else { gross.low_u128() };
            let split = curve::split_fee(gross, launch.fee_bps, launch.creator_fee_bps);
            let vs = launch.virtual_vara - U256::from(gross);
            let vt = launch.virtual_tokens + tokens_in;
            Quote {
                side: Side::Sell,
                amount_in: tokens_in,
                amount_out: U256::from(split.net),
                fee_vara: split.fee,
                price_after_e18: curve::price_e18(vs, vt),
                completes_curve: false,
                refund_vara: 0,
            }
        })
    }

    #[export]
    pub fn launch_info(&self, token: ActorId) -> Option<Launch> {
        self.with_state(|st| st.launches.get(&token).cloned())
    }

    /// Every launch, oldest first. Grows with the program; prefer `LaunchesPage`.
    #[export]
    pub fn launches(&self) -> Vec<ActorId> {
        self.with_state(|st| st.launch_order.clone())
    }

    /// Up to `limit` (at most `MAX_PAGE`) launches from position `offset`, oldest first.
    #[export]
    pub fn launches_page(&self, offset: u32, limit: u32) -> Vec<ActorId> {
        let limit = limit.min(MAX_PAGE) as usize;
        self.with_state(|st| st.launch_order.iter().skip(offset as usize).take(limit).copied().collect())
    }

    #[export]
    pub fn launch_count(&self) -> u32 {
        self.with_state(|st| st.launch_order.len() as u32)
    }

    #[export]
    pub fn pending_payout(&self, token: ActorId, who: ActorId) -> u128 {
        self.with_state(|st| st.pending_payouts.get(&(token, who)).copied().unwrap_or(0))
    }

    #[export]
    pub fn config(&self) -> Config {
        self.with_state(|st| st.config.clone())
    }

    #[export]
    pub fn admin(&self) -> ActorId {
        self.with_state(|st| st.admin)
    }

    #[export]
    pub fn total_liabilities(&self) -> u128 {
        self.with_state(|st| st.total_liabilities)
    }

    #[export]
    pub fn free_balance(&self) -> u128 {
        self.with_state(|st| exec::value_available().saturating_sub(st.total_liabilities))
    }

    #[export]
    pub fn name_taken(&self, name: String) -> bool {
        self.with_state(|st| st.names.contains(&name_key(&name)))
    }

    // ------------------------------------------------------------------ admin

    #[export]
    pub fn set_raise_target(&mut self, raise_target_vara: u128) {
        ensure_no_value();
        self.ensure_admin();
        self.update_config(|c| c.raise_target_vara = raise_target_vara);
    }

    #[export]
    pub fn set_addresses(&mut self, addrs: Addrs) {
        ensure_no_value();
        self.ensure_admin();
        self.update_config(|c| c.addrs = addrs);
    }

    #[export]
    pub fn set_gas(&mut self, gas: GasConfig) {
        ensure_no_value();
        self.ensure_admin();
        self.update_config(|c| c.gas = gas);
    }

    #[export]
    pub fn set_vft_code_id(&mut self, code_id: CodeId) {
        ensure_no_value();
        self.ensure_admin();
        self.update_config(|c| c.vft_code_id = code_id);
    }

    #[export]
    pub fn set_fees(&mut self, fee_bps: u16, creator_fee_bps: u16, graduation_fee_vara: u128) {
        ensure_no_value();
        self.ensure_admin();
        self.update_config(|c| {
            c.fee_bps = fee_bps;
            c.creator_fee_bps = creator_fee_bps;
            c.graduation_fee_vara = graduation_fee_vara;
        });
    }

    #[export]
    pub fn set_limits(
        &mut self,
        min_trade_vara: u128,
        min_free_balance: u128,
        graduation_timeout_blocks: u32,
        launch_cooldown_blocks: u32,
    ) {
        ensure_no_value();
        self.ensure_admin();
        self.update_config(|c| {
            c.min_trade_vara = min_trade_vara;
            c.min_free_balance = min_free_balance;
            c.graduation_timeout_blocks = graduation_timeout_blocks;
            c.launch_cooldown_blocks = launch_cooldown_blocks;
        });
    }

    #[export]
    pub fn set_admin(&mut self, admin: ActorId) {
        ensure_no_value();
        self.ensure_admin();
        self.with_state_mut(|st| st.admin = admin);
    }

    #[export]
    pub fn set_paused_buys(&mut self, paused: bool) {
        ensure_no_value();
        self.ensure_admin();
        self.with_state_mut(|st| st.paused_buys = paused);
    }

    /// Accepts value to top up the operating reserve that pays child-program deposits.
    #[export]
    pub fn top_up_reserve(&mut self) -> u128 {
        self.with_state(|st| exec::value_available().saturating_sub(st.total_liabilities))
    }

    // ---------------------------------------------------------------- internal (not exported)

    async fn run_buy(
        &mut self,
        token: ActorId,
        buyer: ActorId,
        plan: BuyPlan,
    ) -> Result<TradeReceipt, LaunchpadError> {
        let gas = self.gas();
        let refund = plan.refund;
        let pending = self.with_state_mut(|st| apply_buy(st, token, buyer, &plan));
        self.on_trap(move |st| mark_stuck(st, token));
        if refund > 0 {
            // Excess over the sell-out cost goes straight back before the await.
            self.pay(token, buyer, refund);
        }
        match wire::vft_transfer(token, buyer, pending.tokens, &gas).await {
            Ok(true) => Ok(self.commit_trade(token, &pending)),
            Ok(false) | Err(CallError::Send) | Err(CallError::Reply) | Err(CallError::Arithmetic) => {
                self.with_state_mut(|st| revert_trade(st, token, &pending));
                self.pay(token, buyer, pending.vara_gross);
                Err(LaunchpadError::TransferFailed)
            }
            // An undecodable success reply may still mean the transfer happened: reconcile.
            Err(CallError::Timeout) | Err(CallError::Decode) => {
                self.with_state_mut(|st| mark_stuck(st, token));
                self.emit_event(Event::TradeStuck { token, seq: pending.seq }).expect("event");
                Err(LaunchpadError::TradeStuck)
            }
        }
    }

    /// Books the fees of a successful trade, clears the lock, pays a seller, flips the launch
    /// to `Ready` when the curve sold out and emits the trade events.
    fn commit_trade(&mut self, token: ActorId, pending: &PendingTrade) -> TradeReceipt {
        let (receipt, ready_event) = self.with_state_mut(|st| {
            let launch = st.launch_mut(&token);
            launch.creator_fees += pending.fee_creator;
            launch.protocol_fees += pending.fee_protocol;
            launch.busy = None;
            let completed = pending.side == Side::Buy && launch.real_remaining.is_zero();
            let mut ready_event = None;
            if completed {
                launch.state = LaunchState::Ready;
                launch.ready_at = exec::block_height();
                launch.pool_vara = launch.escrow.saturating_sub(launch.graduation_fee);
                // Deposit budgets start from what will actually be wrapped and pooled.
                launch.wvara_budget = U256::from(launch.pool_vara);
                launch.token_budget = launch.pool_tokens;
                ready_event = Some(Event::Ready {
                    token,
                    escrow: launch.escrow,
                    pool_vara: launch.pool_vara,
                });
            }
            let receipt = TradeReceipt {
                seq: pending.seq,
                side: pending.side,
                vara: match pending.side {
                    Side::Buy => pending.vara_gross,
                    Side::Sell => pending.vara_net,
                },
                tokens: pending.tokens,
                fee: pending.fee_creator + pending.fee_protocol,
                price_after_e18: launch.price_e18(),
                completed_curve: completed,
            };
            st.owe(pending.fee_creator + pending.fee_protocol);
            (receipt, ready_event)
        });
        let (sold_after, escrow_after) =
            self.with_state(|st| (st.launch(&token).sold(), st.launch(&token).escrow));
        match pending.side {
            Side::Buy => {
                self.emit_event(Event::Bought {
                    token,
                    seq: pending.seq,
                    trader: pending.trader,
                    vara_in: pending.vara_gross,
                    fee: receipt.fee,
                    tokens_out: pending.tokens,
                    sold_after,
                    escrow_after,
                    price_after_e18: receipt.price_after_e18,
                })
                .expect("event");
            }
            Side::Sell => {
                let deferred = self.pay_seller(token, pending);
                self.emit_event(Event::Sold {
                    token,
                    seq: pending.seq,
                    trader: pending.trader,
                    tokens_in: pending.tokens,
                    fee: receipt.fee,
                    vara_out: pending.vara_net,
                    deferred,
                    sold_after,
                    escrow_after,
                    price_after_e18: receipt.price_after_e18,
                })
                .expect("event");
            }
        }
        if let Some(event) = ready_event {
            self.emit_event(event).expect("event");
        }
        receipt
    }

    /// The mint is booked by `handle_reply` (see `State::wvara_in_flight`), so by the time this
    /// continuation resumes it is either booked or was reverted.
    async fn step_wrap(&mut self, launch: &Launch, gas: &GasConfig) -> Result<(), CallError> {
        if launch.wrapped {
            return Ok(());
        }
        if self.with_state(|st| st.wvara_op_pending(&launch.token)) {
            return Err(CallError::Timeout);
        }
        let track = self.track_wvara(launch.token, WvaraOp::Wrap, launch.pool_vara);
        wire::wvara_mint(launch.addrs.wvara, launch.pool_vara, gas, track).await
    }

    fn track_wvara(&self, token: ActorId, op: WvaraOp, amount: u128) -> impl FnOnce(MessageId) {
        let state = Rc::clone(self.state);
        move |id| {
            state.borrow_mut().wvara_in_flight.insert(id, (token, op, amount));
        }
    }

    async fn step_find_or_create_pair(&mut self, launch: &Launch, gas: &GasConfig) -> Result<(), CallError> {
        let factory = launch.addrs.rivr_factory;
        let wvara = launch.addrs.wvara;
        let mut pair = wire::factory_get_pair(factory, wvara, launch.token, gas).await?;
        if pair.is_zero() {
            // The fee is paid from the operating reserve for now (escrow must keep covering every
            // sell-back in case graduation is unwound); Settle charges it to the graduation fee.
            // Flagged before the await, so a continuation starved after the pair exists cannot
            // drop the charge; only a send that never went out or was rejected clears it.
            self.with_state_mut(|st| st.launch_mut(&launch.token).pair_created_by_us = true);
            let created = wire::factory_create_pair(factory, wvara, launch.token, launch.pair_creation_fee, gas).await;
            if let Err(err) = created {
                if matches!(err, CallError::Send | CallError::Reply) {
                    self.with_state_mut(|st| st.launch_mut(&launch.token).pair_created_by_us = false);
                }
                return Err(err);
            }
            pair = wire::factory_get_pair(factory, wvara, launch.token, gas).await?;
            if pair.is_zero() {
                return Err(CallError::Reply);
            }
        }
        let (token0, _token1) = wire::pair_get_tokens(pair, gas).await?;
        self.with_state_mut(|st| {
            let l = st.launch_mut(&launch.token);
            l.pair = pair;
            l.wvara_is_token0 = token0 == wvara;
        });
        Ok(())
    }

    /// Moves the pair's price to the curve's final price (pool_vara / pool_tokens) when someone
    /// seeded it first, one action per message (see `curve::plan_alignment`). Returns whether the
    /// step is finished: after deepening a dust pool it must run again to swap. Correcting a dust
    /// seed costs almost nothing; correcting an over-priced seed pulls the seeder's wVARA to us.
    async fn step_align_price(&mut self, launch: &Launch, gas: &GasConfig) -> Result<bool, CallError> {
        if launch.liquidity_added || self.align_given_up(&launch.token) {
            return Ok(true);
        }
        let (r0, r1) = wire::pair_get_reserves(launch.pair, gas).await?;
        let (rw, rt) = if launch.wvara_is_token0 { (r0, r1) } else { (r1, r0) };
        let action = curve::plan_alignment(
            rw,
            rt,
            U256::from(launch.pool_vara),
            launch.pool_tokens,
            launch.wvara_budget,
            launch.token_budget,
        )
        .ok_or(CallError::Arithmetic)?;
        let deadline_ms = exec::block_timestamp().saturating_add(10 * 60 * 1000);
        let wvara_in_dir = launch.wvara_is_token0; // token0 -> token1 when wVARA is token0
        // Every action approves exactly what it spends: an earlier AddLiquidity attempt may have
        // replaced the step 3-4 allowances.
        let (wvara_budget, token_budget, finished) = match action {
            curve::Align::Aligned => return Ok(true),
            curve::Align::Deepen { wvara, tokens } => {
                wire::vft_approve(launch.addrs.wvara, launch.pair, wvara, gas).await?;
                wire::vft_approve(launch.token, launch.pair, tokens, gas).await?;
                let (amount0, amount1) = if wvara_in_dir { (wvara, tokens) } else { (tokens, wvara) };
                // Exactly the pool's ratio and worth dust, so no minimums are needed.
                wire::pair_add_liquidity(launch.pair, amount0, amount1, U256::zero(), U256::zero(), deadline_ms, gas)
                    .await?;
                (
                    launch.wvara_budget.saturating_sub(wvara),
                    launch.token_budget.saturating_sub(tokens),
                    false,
                )
            }
            curve::Align::SwapWvaraIn(amount_in) | curve::Align::SwapTokensIn(amount_in) => {
                let wvara_in = matches!(action, curve::Align::SwapWvaraIn(_));
                let dir = if wvara_in { wvara_in_dir } else { !wvara_in_dir };
                let out = wire::pair_get_amount_out(launch.pair, amount_in, dir, gas).await?;
                if amount_in.is_zero() || out.is_zero() {
                    // Budget spent: list at the pool's price.
                    self.with_state_mut(|st| st.align_rounds.insert(launch.token, MAX_ALIGN_ROUNDS));
                    return Ok(true);
                }
                let min_out = out.saturating_mul(U256::from(98u32)) / U256::from(100u32);
                let spent_token = if wvara_in { launch.addrs.wvara } else { launch.token };
                wire::vft_approve(spent_token, launch.pair, amount_in, gas).await?;
                wire::pair_swap_exact_in(launch.pair, amount_in, min_out, dir, deadline_ms, gas).await?;
                if wvara_in {
                    (launch.wvara_budget.saturating_sub(amount_in), launch.token_budget.saturating_add(min_out), true)
                } else {
                    (launch.wvara_budget.saturating_add(min_out), launch.token_budget.saturating_sub(amount_in), true)
                }
            }
        };
        self.emit_event(Event::ImbalancedListing {
            token: launch.token,
            pair: launch.pair,
            reserve0: r0,
            reserve1: r1,
        })
        .expect("event");
        self.with_state_mut(|st| {
            *st.align_rounds.entry(launch.token).or_default() += 1;
            let l = st.launch_mut(&launch.token);
            l.wvara_budget = wvara_budget;
            l.token_budget = token_budget;
        });
        Ok(finished)
    }

    fn align_given_up(&self, token: &ActorId) -> bool {
        self.with_state(|st| st.align_rounds.get(token).is_some_and(|r| *r >= MAX_ALIGN_ROUNDS))
    }

    async fn step_add_liquidity(&mut self, launch: &Launch, me: ActorId, gas: &GasConfig) -> Result<(), CallError> {
        if launch.liquidity_added {
            return Ok(());
        }
        if let Some(before) = launch.pre_add_balances {
            return self.resolve_add_liquidity(launch, me, before, gas).await;
        }
        let (r0, r1) = wire::pair_get_reserves(launch.pair, gas).await?;
        let (rw, rt) = if launch.wvara_is_token0 { (r0, r1) } else { (r1, r0) };
        let pv = U256::from(launch.pool_vara);
        let pt = launch.pool_tokens;
        if pv.is_zero() || pt.is_zero() {
            return Err(CallError::Arithmetic);
        }
        // Deposit at the curve's final price, or at the pool's own once alignment gave up,
        // limited by what this launch still holds.
        let (price_w, price_t) = if rw.is_zero() || rt.is_zero() {
            (pv, pt)
        } else {
            // The pool must still be at the target price (AlignPrice ran just before).
            let lhs = rw.checked_mul(pt).ok_or(CallError::Arithmetic)?;
            let rhs = rt.checked_mul(pv).ok_or(CallError::Arithmetic)?;
            let diff = if lhs > rhs { lhs - rhs } else { rhs - lhs };
            if diff.saturating_mul(U256::from(50u32)) <= rhs {
                (pv, pt)
            } else if self.align_given_up(&launch.token) {
                (rw, rt)
            } else {
                return Err(CallError::Reply); // >2 % off: retry re-aligns first
            }
        };
        let pct = |x: U256, p: u32| x.checked_mul(U256::from(p)).map(|v| v / U256::from(100u32));
        let mut amount_w = launch.wvara_budget.min(pv);
        let mut amount_t = amount_w.checked_mul(price_t).ok_or(CallError::Arithmetic)? / price_w;
        if amount_t > launch.token_budget {
            amount_t = launch.token_budget;
            amount_w = amount_t.checked_mul(price_w).ok_or(CallError::Arithmetic)? / price_t;
        }
        // AlignPrice's swap spends part of the step 3-4 approvals; approve the exact deposit.
        wire::vft_approve(launch.token, launch.pair, amount_t, gas).await?;
        wire::vft_approve(launch.addrs.wvara, launch.pair, amount_w, gas).await?;
        let held = wire::vft_balance_of(launch.token, me, gas).await?;
        let lp = wire::vft_balance_of(launch.pair, me, gas).await?;
        self.set_pre_add_balances(launch, Some((held, lp)));
        let (amount0, amount1) = if launch.wvara_is_token0 { (amount_w, amount_t) } else { (amount_t, amount_w) };
        let min0 = pct(amount0, 97).ok_or(CallError::Arithmetic)?;
        let min1 = pct(amount1, 97).ok_or(CallError::Arithmetic)?;
        let deadline_ms = exec::block_timestamp().saturating_add(10 * 60 * 1000);
        match wire::pair_add_liquidity(launch.pair, amount0, amount1, min0, min1, deadline_ms, gas).await {
            Ok(()) => {
                self.mark_liquidity_added(launch);
                Ok(())
            }
            // The pair rejected it and refunded anything it pulled: nothing landed.
            Err(CallError::Reply) => {
                self.set_pre_add_balances(launch, None);
                Err(CallError::Reply)
            }
            // Timeout: unknown, the snapshot stays for the resume to resolve.
            Err(err) => Err(err),
        }
    }

    /// Settles a deposit whose reply was lost. First withdraws the pair's allowances, so a
    /// deposit still queued can no longer land; then a lower token balance together with a
    /// higher LP balance than before the send means it did land. Otherwise the snapshot is
    /// dropped and the step fails retryably, so the retry re-aligns before depositing again.
    async fn resolve_add_liquidity(
        &mut self,
        launch: &Launch,
        me: ActorId,
        (held_before, lp_before): (U256, U256),
        gas: &GasConfig,
    ) -> Result<(), CallError> {
        wire::vft_approve(launch.token, launch.pair, U256::zero(), gas).await?;
        wire::vft_approve(launch.addrs.wvara, launch.pair, U256::zero(), gas).await?;
        let held = wire::vft_balance_of(launch.token, me, gas).await?;
        let lp = wire::vft_balance_of(launch.pair, me, gas).await?;
        if held < held_before && lp > lp_before {
            self.mark_liquidity_added(launch);
            return Ok(());
        }
        self.set_pre_add_balances(launch, None);
        Err(CallError::Reply)
    }

    fn set_pre_add_balances(&mut self, launch: &Launch, balances: Option<(U256, U256)>) {
        self.with_state_mut(|st| st.launch_mut(&launch.token).pre_add_balances = balances);
    }

    fn mark_liquidity_added(&mut self, launch: &Launch) {
        self.with_state_mut(|st| {
            st.wvara_expected = st.wvara_expected.saturating_sub(launch.pool_vara);
            let l = st.launch_mut(&launch.token);
            l.liquidity_added = true;
            l.pre_add_balances = None;
        });
    }

    async fn step_burn_lp(&mut self, launch: &Launch, me: ActorId, gas: &GasConfig) -> Result<(), CallError> {
        let lp = wire::vft_balance_of(launch.pair, me, gas).await?;
        if lp.is_zero() {
            // Liquidity was verified in the previous step, so no LP means it already went out.
            return Ok(());
        }
        // The pair's LP token is its own "Vft" service; LP_DEAD is RivrDEX's burn address.
        let moved = wire::vft_transfer(launch.pair, launch.addrs.lp_dead, lp, gas).await?;
        if !moved {
            return Err(CallError::Reply);
        }
        self.with_state_mut(|st| st.launch_mut(&launch.token).lp_burned += lp);
        Ok(())
    }

    /// Revokes one of our own VFT roles, skipping the call when it is already gone (so a resume
    /// after RevokeAdmin never hits "Not admin").
    async fn step_revoke(
        &mut self,
        launch: &Launch,
        me: ActorId,
        holders_query: &str,
        revoke_method: &str,
        gas: &GasConfig,
    ) -> Result<(), CallError> {
        let holders = wire::vft_role_holders(launch.token, holders_query, gas).await?;
        if !holders.contains(&me) {
            return Ok(());
        }
        wire::vft_revoke_role(launch.token, revoke_method, me, gas).await
    }

    async fn step_settle(&mut self, launch: &Launch, me: ActorId, gas: &GasConfig) -> Result<(), CallError> {
        let admins = wire::vft_role_holders(launch.token, "Admins", gas).await?;
        let minters = wire::vft_role_holders(launch.token, "Minters", gas).await?;
        let burners = wire::vft_role_holders(launch.token, "Burners", gas).await?;
        let renounced = admins.is_empty() && minters.is_empty() && burners.is_empty();
        // wVARA not taken by the pool (imbalanced listing) comes back as protocol revenue. The
        // surplus is only measurable while no mint or burn is waiting to be booked.
        if self.with_state(|st| !st.wvara_in_flight.is_empty()) {
            return Err(CallError::Timeout);
        }
        let held = wire::vft_balance_of(launch.addrs.wvara, me, gas).await?;
        let expected = U256::from(self.with_state(|st| st.wvara_expected));
        if held > expected {
            let leftover = (held - expected).low_u128();
            let track = self.track_wvara(launch.token, WvaraOp::Recover, leftover);
            wire::wvara_burn(launch.addrs.wvara, U256::from(leftover), gas, track).await?;
        }
        // Curve tokens that did not fit the pool (rounding, or a re-aligned seed) are burned to
        // RivrDEX's dead address so nothing is stranded in the launchpad.
        let tokens_left = wire::vft_balance_of(launch.token, me, gas).await?;
        if !tokens_left.is_zero() {
            let moved = wire::vft_transfer(launch.token, launch.addrs.lp_dead, tokens_left, gas).await?;
            if !moved {
                return Err(CallError::Reply);
            }
        }
        self.with_state_mut(|st| {
            let l = st.launch_mut(&launch.token);
            l.roles_renounced = renounced;
            // The pair fee (paid from the reserve at step 2) is charged to the graduation fee here.
            let pair_fee = if l.pair_created_by_us { l.pair_creation_fee.min(l.escrow) } else { 0 };
            l.escrow -= pair_fee;
            // What is left of the graduation fee becomes protocol revenue.
            l.protocol_fees += l.escrow;
            l.escrow = 0;
            st.settle(pair_fee);
        });
        Ok(())
    }

    /// Pulls the pool VARA back out of wVARA; `handle_reply` books the burn.
    async fn unwind_wrapped(&mut self, launch: &Launch, gas: &GasConfig) -> Result<(), CallError> {
        if self.with_state(|st| st.wvara_op_pending(&launch.token)) {
            return Err(CallError::Timeout);
        }
        if !self.with_state(|st| st.launch(&launch.token).wrapped) {
            return Ok(());
        }
        let track = self.track_wvara(launch.token, WvaraOp::Unwrap, launch.pool_vara);
        wire::wvara_burn(launch.addrs.wvara, U256::from(launch.pool_vara), gas, track).await
    }
}
