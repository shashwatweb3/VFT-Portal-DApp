use sails_rs::{
    collections::{HashMap, HashSet},
    prelude::*,
};

/// Gas budgets for every cross-program message the launchpad sends.
#[derive(Debug, Clone, Encode, Decode, TypeInfo)]
pub struct GasConfig {
    /// Gas handed to the VFT constructor when a token is spawned.
    pub gas_for_vft_init: u64,
    /// Gas for a VFT transfer / approve / query and for wVARA mint / burn.
    pub gas_for_token_ops: u64,
    /// Gas reserved for processing the reply of each awaited message.
    pub gas_for_reply_deposit: u64,
    /// Blocks to wait for a reply before the await resolves with a timeout.
    pub reply_timeout: u32,
    /// Gas attached to `Factory.CreatePair` (the factory spawns a Pair program from it).
    pub gas_for_create_pair: u64,
    /// Gas attached to `Pair.AddLiquidity`; must exceed the pair's `gas_for_full_tx`.
    pub gas_for_add_liquidity: u64,
}

#[derive(Debug, Clone, Encode, Decode, TypeInfo)]
pub struct Addrs {
    pub rivr_factory: ActorId,
    pub wvara: ActorId,
    pub lp_dead: ActorId,
    pub treasury: ActorId,
}

#[derive(Debug, Clone, Encode, Decode, TypeInfo)]
pub struct Config {
    pub vft_code_id: CodeId,
    pub addrs: Addrs,
    /// Gross VARA (planck) a curve must take in before it graduates. Set by the operator from
    /// the USD target and the VARA price; frozen per launch.
    pub raise_target_vara: u128,
    /// VARA kept out of the pool at graduation to pay pair creation, LP account ED and gas.
    pub graduation_fee_vara: u128,
    /// VARA the RivrDEX factory requires with `CreatePair` (exactly 1 VARA on mainnet).
    pub pair_creation_fee_vara: u128,
    pub total_supply: U256,
    pub curve_supply: U256,
    pub token_decimals: u8,
    /// Total trade fee in basis points of the VARA leg.
    pub fee_bps: u16,
    /// Creator's share, in basis points of the VARA leg (must be <= fee_bps).
    pub creator_fee_bps: u16,
    pub min_trade_vara: u128,
    /// Free balance (above all liabilities) the program must keep to spawn a token.
    pub min_free_balance: u128,
    /// Blocks a launch may sit in `Ready` or `Failed` before anyone may `Unwind` it.
    pub graduation_timeout_blocks: u32,
    /// Blocks a creator must wait between launches. Each launch costs the operating reserve the
    /// new token's existential deposit, so this bounds how fast one wallet can drain it.
    pub launch_cooldown_blocks: u32,
    pub gas: GasConfig,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Encode, Decode, TypeInfo)]
pub enum LaunchState {
    Trading,
    Ready,
    Graduating,
    Graduated,
    Failed,
    Aborted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Encode, Decode, TypeInfo)]
pub enum GradStep {
    WrapVara,
    FindOrCreatePair,
    ApproveToken,
    ApproveWvara,
    AlignPrice,
    AddLiquidity,
    BurnLp,
    RevokeMinter,
    RevokeBurner,
    RevokeAdmin,
    Settle,
    Done,
}

impl GradStep {
    pub fn next(self) -> Self {
        use GradStep::*;
        match self {
            WrapVara => FindOrCreatePair,
            FindOrCreatePair => ApproveToken,
            ApproveToken => ApproveWvara,
            ApproveWvara => AlignPrice,
            AlignPrice => AddLiquidity,
            AddLiquidity => BurnLp,
            BurnLp => RevokeMinter,
            RevokeMinter => RevokeBurner,
            RevokeBurner => RevokeAdmin,
            RevokeAdmin => Settle,
            Settle | Done => Done,
        }
    }

    /// Steps after which the pool VARA may still be pulled back out of wVARA.
    pub fn is_unwindable(self) -> bool {
        matches!(
            self,
            GradStep::WrapVara
                | GradStep::FindOrCreatePair
                | GradStep::ApproveToken
                | GradStep::ApproveWvara
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Encode, Decode, TypeInfo)]
pub enum Side {
    Buy,
    Sell,
}

/// A trade whose VFT transfer is in flight. The curve state has already been moved; the
/// snapshot lets a failed transfer revert it exactly.
#[derive(Debug, Clone, Encode, Decode, TypeInfo)]
pub struct PendingTrade {
    pub side: Side,
    pub trader: ActorId,
    pub seq: u64,
    pub vara_gross: u128,
    pub vara_net: u128,
    pub fee_creator: u128,
    pub fee_protocol: u128,
    pub tokens: U256,
    pub prev_virtual_vara: U256,
    pub prev_virtual_tokens: U256,
    pub prev_real_remaining: U256,
    pub prev_escrow: u128,
    pub stuck: bool,
    /// Block after which the sending message can no longer be waiting on the transfer reply, so
    /// a trade still in flight was abandoned (its continuation trapped) and may be reconciled.
    pub expires_at: u32,
}

impl PendingTrade {
    pub fn reconcilable(&self, now: u32) -> bool {
        self.stuck || now >= self.expires_at
    }

    /// Decides a stuck trade from the curve tokens the launchpad holds: `Some(true)` commits it,
    /// `Some(false)` reverts it, `None` means the balance fits neither outcome.
    ///
    /// Anyone can send tokens to the launchpad, so `held` is only a lower bound and the surplus
    /// is a donation (burned at Settle). When a donation makes both outcomes fit, the one that
    /// cannot cost the trader wins: a buy is refunded, a sell is paid. Either way the launchpad
    /// holds at least what its books then say it owns.
    pub fn reconcile_outcome(&self, held: U256, committed: U256, reverted: U256) -> Option<bool> {
        let (first, second) = match self.side {
            Side::Buy => ((reverted, false), (committed, true)),
            Side::Sell => ((committed, true), (reverted, false)),
        };
        [first, second].into_iter().find(|(expected, _)| held >= *expected).map(|(_, commit)| commit)
    }
}

#[derive(Debug, Clone, Encode, Decode, TypeInfo)]
pub struct Launch {
    pub token: ActorId,
    pub creator: ActorId,
    pub name: String,
    pub symbol: String,
    pub state: LaunchState,
    pub step: GradStep,
    pub v0: U256,
    pub t0: U256,
    pub virtual_vara: U256,
    pub virtual_tokens: U256,
    pub curve_supply: U256,
    pub real_remaining: U256,
    pub pool_tokens: U256,
    /// VARA held for sell-backs (and, once Ready, for the pool).
    pub escrow: u128,
    pub pool_vara: u128,
    pub graduation_fee: u128,
    pub pair_creation_fee: u128,
    pub creator_fees: u128,
    pub protocol_fees: u128,
    pub trade_seq: u64,
    pub busy: Option<PendingTrade>,
    /// Set while a graduation step, an unwind or a reconcile has a message in flight.
    pub lock: bool,
    /// Block after which `lock` is ignored: its holder can no longer be waiting on any reply, so
    /// it trapped or ran out of gas after an await and anyone may resume.
    pub lock_expires_at: u32,
    pub pair: ActorId,
    pub pair_created_by_us: bool,
    pub wvara_is_token0: bool,
    pub wrapped: bool,
    pub liquidity_added: bool,
    /// Our own (token, LP) balances read just before our AddLiquidity was sent. Only our
    /// deposit can lower the first and raise the second at once, so a resume after a lost reply
    /// tells from them whether it landed; reserves are moved by anyone and are not trusted.
    pub pre_add_balances: Option<(U256, U256)>,
    /// wVARA / tokens this launch may deposit after AlignPrice (its swap moves value between them).
    pub wvara_budget: U256,
    pub token_budget: U256,
    pub lp_burned: U256,
    pub roles_renounced: bool,
    pub created_at: u32,
    pub ready_at: u32,
    pub fail_reason: String,
    pub fail_retryable: bool,
    /// Block of the first failure since the last completed step. Failed retries keep it, so an
    /// early unwind waits `graduation_timeout_blocks` from here whatever the retry traffic.
    pub failed_since: Option<u32>,
    /// Frozen at creation, like the fees: an admin change cannot shorten a live launch's wait.
    pub graduation_timeout_blocks: u32,
    pub addrs: Addrs,
    pub terms_hash: [u8; 32],
    pub fee_bps: u16,
    pub creator_fee_bps: u16,
}

impl Launch {
    pub fn lock_held(&self, now: u32) -> bool {
        self.lock && now < self.lock_expires_at
    }

    pub fn sold(&self) -> U256 {
        self.curve_supply - self.real_remaining
    }

    pub fn price_e18(&self) -> U256 {
        crate::curve::price_e18(self.virtual_vara, self.virtual_tokens)
    }

    pub fn progress_bps(&self) -> u32 {
        if self.curve_supply.is_zero() {
            return 0;
        }
        (self.sold() * U256::from(10_000u32) / self.curve_supply).as_u32()
    }
}

#[derive(Debug)]
pub struct State {
    pub config: Config,
    pub admin: ActorId,
    pub paused_buys: bool,
    pub launches: HashMap<ActorId, Launch>,
    pub launch_order: Vec<ActorId>,
    pub names: HashSet<String>,
    pub last_launch_by_creator: HashMap<ActorId, u32>,
    /// Sell proceeds below the existential deposit, claimable once they add up to it.
    pub pending_payouts: HashMap<(ActorId, ActorId), u128>,
    /// Everything the program owes: escrows + accrued fees + pending payouts.
    pub total_liabilities: u128,
    /// wVARA the program holds for launches that wrapped but have not added liquidity yet.
    pub wvara_expected: u128,
    /// Value sends awaiting their reply: (launch, recipient, amount). A bounce (error reply,
    /// value returned) re-credits the amount as a pending payout.
    pub payouts_in_flight: HashMap<MessageId, (ActorId, ActorId, u128)>,
    /// wVARA mints and burns awaiting their reply: (launch, operation, amount). They are booked
    /// in `handle_reply`, which runs even when the sending continuation is starved of gas, so a
    /// mint can never sit unbooked in the shared wVARA balance.
    pub wvara_in_flight: HashMap<MessageId, (ActorId, WvaraOp, u128)>,
    /// Alignment actions taken per graduating launch; see `MAX_ALIGN_ROUNDS`.
    pub align_rounds: HashMap<ActorId, u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WvaraOp {
    /// Pool VARA wrapped at `WrapVara`.
    Wrap,
    /// Pool VARA unwrapped back into escrow by `Unwind`.
    Unwrap,
    /// Leftover wVARA burned at `Settle` as protocol revenue.
    Recover,
}

impl State {
    pub fn new(config: Config, admin: ActorId) -> Self {
        Self {
            config,
            admin,
            paused_buys: false,
            launches: HashMap::new(),
            launch_order: Vec::new(),
            names: HashSet::new(),
            last_launch_by_creator: HashMap::new(),
            pending_payouts: HashMap::new(),
            total_liabilities: 0,
            wvara_expected: 0,
            payouts_in_flight: HashMap::new(),
            wvara_in_flight: HashMap::new(),
            align_rounds: HashMap::new(),
        }
    }

    /// Books `amount` (held by the program, no longer owed elsewhere) as claimable by `to`.
    /// `token` is the launch it came from, or zero for a refund before any launch existed.
    pub fn credit_payout(&mut self, token: ActorId, to: ActorId, amount: u128) {
        let pending = self.pending_payouts.entry((token, to)).or_default();
        *pending = pending.checked_add(amount).unwrap_or_else(|| panic!("LiabilityOverflow"));
        self.owe(amount);
    }

    /// Called from `handle_reply`: settles a tracked value send or wVARA operation. An error
    /// reply means the operation was reverted (and any value returned), so nothing is booked.
    pub fn on_reply(&mut self, reply_to: MessageId, is_error: bool) {
        if let Some((token, to, amount)) = self.payouts_in_flight.remove(&reply_to) {
            if is_error {
                self.credit_payout(token, to, amount);
            }
        }
        if let Some((token, op, amount)) = self.wvara_in_flight.remove(&reply_to) {
            if !is_error {
                self.book_wvara_op(token, op, amount);
            }
        }
    }

    fn book_wvara_op(&mut self, token: ActorId, op: WvaraOp, amount: u128) {
        match op {
            WvaraOp::Wrap => {
                self.wvara_expected += amount;
                self.settle(amount);
                let l = self.launch_mut(&token);
                l.wrapped = true;
                l.escrow -= amount;
            }
            WvaraOp::Unwrap => {
                self.wvara_expected = self.wvara_expected.saturating_sub(amount);
                let l = self.launch_mut(&token);
                l.wrapped = false;
                l.escrow += amount;
                self.owe(amount);
            }
            WvaraOp::Recover => {
                self.launch_mut(&token).protocol_fees += amount;
                self.owe(amount);
            }
        }
    }

    pub fn wvara_op_pending(&self, token: &ActorId) -> bool {
        self.wvara_in_flight.values().any(|(t, _, _)| t == token)
    }

    pub fn launch_mut(&mut self, token: &ActorId) -> &mut Launch {
        self.launches
            .get_mut(token)
            .unwrap_or_else(|| panic!("LaunchNotFound"))
    }

    pub fn launch(&self, token: &ActorId) -> &Launch {
        self.launches
            .get(token)
            .unwrap_or_else(|| panic!("LaunchNotFound"))
    }

    pub fn owe(&mut self, amount: u128) {
        self.total_liabilities = self
            .total_liabilities
            .checked_add(amount)
            .unwrap_or_else(|| panic!("LiabilityOverflow"));
    }

    pub fn settle(&mut self, amount: u128) {
        self.total_liabilities = self
            .total_liabilities
            .checked_sub(amount)
            .unwrap_or_else(|| panic!("LiabilityUnderflow"));
    }
}

#[derive(Debug, Clone, Encode, Decode, TypeInfo)]
pub struct TokenMeta {
    pub name: String,
    pub symbol: String,
    pub description: String,
    pub image: String,
    pub website: Option<String>,
    pub telegram: Option<String>,
    pub twitter: Option<String>,
    pub discord: Option<String>,
    pub tokenomics: Option<String>,
}

#[derive(Debug, Clone, Encode, Decode, TypeInfo)]
pub struct Quote {
    pub side: Side,
    pub amount_in: U256,
    pub amount_out: U256,
    pub fee_vara: u128,
    pub price_after_e18: U256,
    pub completes_curve: bool,
    pub refund_vara: u128,
}

#[derive(Debug, Clone, Encode, Decode, TypeInfo)]
pub struct TradeReceipt {
    pub seq: u64,
    pub side: Side,
    pub vara: u128,
    pub tokens: U256,
    pub fee: u128,
    pub price_after_e18: U256,
    pub completed_curve: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Encode, Decode, TypeInfo)]
pub enum LaunchpadError {
    SpawnFailed(String),
    TransferFailed,
    TradeStuck,
    NotStuck,
    Unreconcilable,
    GraduationFailed { step: GradStep, reason: String, retryable: bool },
    NotGraduating,
    FirstBuySkipped(String),
    NotUnwindable,
    NothingToClaim,
    BelowExistentialDeposit,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn trade(side: Side) -> PendingTrade {
        PendingTrade {
            side,
            trader: ActorId::zero(),
            seq: 1,
            vara_gross: 0,
            vara_net: 0,
            fee_creator: 0,
            fee_protocol: 0,
            tokens: U256::from(100u32),
            prev_virtual_vara: U256::zero(),
            prev_virtual_tokens: U256::zero(),
            prev_real_remaining: U256::zero(),
            prev_escrow: 0,
            stuck: true,
            expires_at: 0,
        }
    }

    /// Every field zero, empty or the first variant.
    fn zeroed<T: Decode>() -> T {
        T::decode(&mut &[0u8; 4096][..]).unwrap()
    }

    #[test]
    fn wvara_ops_are_booked_by_their_reply() {
        let token = ActorId::from(7u64);
        let mut st = State::new(zeroed(), ActorId::zero());
        let mut launch: Launch = zeroed();
        launch.escrow = 1_000;
        st.launches.insert(token, launch);
        st.owe(1_000);
        let (mint, failed, burn, recover) =
            (MessageId::from(1u64), MessageId::from(2u64), MessageId::from(3u64), MessageId::from(4u64));

        st.wvara_in_flight.insert(failed, (token, WvaraOp::Wrap, 600));
        assert!(st.wvara_op_pending(&token));
        st.on_reply(failed, true);
        assert!(!st.wvara_op_pending(&token) && !st.launch(&token).wrapped, "a reverted mint books nothing");

        st.wvara_in_flight.insert(mint, (token, WvaraOp::Wrap, 600));
        st.on_reply(mint, false);
        let l = st.launch(&token);
        assert!(l.wrapped);
        assert_eq!((l.escrow, st.wvara_expected, st.total_liabilities), (400, 600, 400));

        st.wvara_in_flight.insert(burn, (token, WvaraOp::Unwrap, 600));
        st.on_reply(burn, false);
        let l = st.launch(&token);
        assert!(!l.wrapped);
        assert_eq!((l.escrow, st.wvara_expected, st.total_liabilities), (1_000, 0, 1_000));

        st.wvara_in_flight.insert(recover, (token, WvaraOp::Recover, 50));
        st.on_reply(recover, false);
        assert_eq!((st.launch(&token).protocol_fees, st.total_liabilities), (50, 1_050));
        st.on_reply(recover, false);
        assert_eq!(st.total_liabilities, 1_050, "a reply is booked once");
    }

    #[test]
    fn in_flight_trades_expire_at_their_deadline() {
        let mut t = trade(Side::Buy);
        t.stuck = false;
        t.expires_at = 100;
        assert!(!t.reconcilable(99));
        assert!(t.reconcilable(100));
        t.stuck = true;
        assert!(t.reconcilable(0), "a timed-out trade is reconcilable at once");
    }

    #[test]
    fn reconcile_tolerates_donations_and_favours_the_trader() {
        let u = |v: u32| U256::from(v);
        // Buy: the transfer out leaves 900, no transfer leaves 1000.
        let buy = trade(Side::Buy);
        assert_eq!(buy.reconcile_outcome(u(900), u(900), u(1_000)), Some(true));
        assert_eq!(buy.reconcile_outcome(u(1_000), u(900), u(1_000)), Some(false));
        assert_eq!(buy.reconcile_outcome(u(950), u(900), u(1_000)), Some(true), "donation of 50");
        assert_eq!(buy.reconcile_outcome(u(1_200), u(900), u(1_000)), Some(false), "refund when ambiguous");
        assert_eq!(buy.reconcile_outcome(u(899), u(900), u(1_000)), None);
        // Sell: the transfer in leaves 1100, no transfer leaves 1000.
        let sell = trade(Side::Sell);
        assert_eq!(sell.reconcile_outcome(u(1_100), u(1_100), u(1_000)), Some(true));
        assert_eq!(sell.reconcile_outcome(u(1_000), u(1_100), u(1_000)), Some(false));
        assert_eq!(sell.reconcile_outcome(u(1_050), u(1_100), u(1_000)), Some(false), "donation of 50");
        assert_eq!(sell.reconcile_outcome(u(1_300), u(1_100), u(1_000)), Some(true), "pay when ambiguous");
        assert_eq!(sell.reconcile_outcome(u(999), u(1_100), u(1_000)), None);
    }
}
