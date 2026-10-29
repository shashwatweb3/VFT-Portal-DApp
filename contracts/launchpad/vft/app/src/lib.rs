//! Tokenator extended VFT, ported from `contracts/fungible-token` (sails-rs 0.2.0 / gstd 1.4.2)
//! to sails-rs 0.10.2 / gstd 1.10 so it can be built and tested with the launchpad.
//!
//! The IDL is kept identical to `contracts/fungible-token/wasm/vft.idl`: one service named
//! `Vft`, the same constructor `New(init: Init)`, the same method names and the same events,
//! so the indexer, the frontend client and the launchpad's hand-written encoders keep working
//! against either build.
#![no_std]

use sails_rs::{
    cell::RefCell,
    collections::{HashMap, HashSet},
    gstd::{exec, msg},
    prelude::*,
};

#[derive(Clone, Debug, Encode, Decode, TypeInfo)]
pub struct ExternalLinks {
    pub image: String,
    pub website: Option<String>,
    pub telegram: Option<String>,
    pub twitter: Option<String>,
    pub discord: Option<String>,
    pub tokenomics: Option<String>,
}

#[derive(Debug, Encode, Decode, TypeInfo)]
pub struct Init {
    pub name: String,
    pub symbol: String,
    pub decimals: u8,
    pub description: String,
    pub external_links: ExternalLinks,
    pub initial_supply: U256,
    pub max_supply: U256,
    pub admin_id: ActorId,
}

#[event]
#[derive(Clone, Debug, Encode, Decode, TypeInfo)]
pub enum Event {
    Minted { to: ActorId, value: U256 },
    Burned { from: ActorId, value: U256 },
    Killed { inheritor: ActorId },
    TransferredToUsers { from: ActorId, to: Vec<ActorId>, value: U256 },
    DescriptionChanged { new_description: String },
    ImageLinkChanged { new_image_link: String },
    ExternalLinksChanged { new_external_links: ExternalLinks },
    Approval { owner: ActorId, spender: ActorId, value: U256 },
    Transfer { from: ActorId, to: ActorId, value: U256 },
}

#[derive(Debug)]
pub struct State {
    balances: HashMap<ActorId, U256>,
    allowances: HashMap<(ActorId, ActorId), U256>,
    name: String,
    symbol: String,
    decimals: u8,
    total_supply: U256,
    description: String,
    external_links: ExternalLinks,
    max_supply: U256,
    minters: HashSet<ActorId>,
    burners: HashSet<ActorId>,
    admins: HashSet<ActorId>,
}

impl State {
    fn seed(init: Init) -> Self {
        if init.initial_supply > init.max_supply {
            panic!("SupplyError");
        }
        if init.description.chars().count() > 500 {
            panic!("DescriptionError");
        }
        let mut balances = HashMap::new();
        let mut total_supply = U256::zero();
        if !init.initial_supply.is_zero() {
            balances.insert(init.admin_id, init.initial_supply);
            total_supply = init.initial_supply;
        }
        Self {
            balances,
            allowances: HashMap::new(),
            name: init.name,
            symbol: init.symbol,
            decimals: init.decimals,
            total_supply,
            description: init.description,
            external_links: init.external_links,
            max_supply: init.max_supply,
            minters: [init.admin_id].into(),
            burners: [init.admin_id].into(),
            admins: [init.admin_id].into(),
        }
    }

    fn balance_of(&self, who: ActorId) -> U256 {
        self.balances.get(&who).copied().unwrap_or_default()
    }

    fn set_balance(&mut self, who: ActorId, value: U256) {
        if value.is_zero() {
            self.balances.remove(&who);
        } else {
            self.balances.insert(who, value);
        }
    }

    fn allowance(&self, owner: ActorId, spender: ActorId) -> U256 {
        self.allowances.get(&(owner, spender)).copied().unwrap_or_default()
    }

    fn set_allowance(&mut self, owner: ActorId, spender: ActorId, value: U256) {
        if value.is_zero() {
            self.allowances.remove(&(owner, spender));
        } else {
            self.allowances.insert((owner, spender), value);
        }
    }

    /// Moves `value` from `from` to `to`. Returns `false` when nothing changed (self-transfer or
    /// zero value), panics on insufficient balance, exactly like the original contract.
    fn transfer(&mut self, from: ActorId, to: ActorId, value: U256) -> bool {
        if from == to || value.is_zero() {
            return false;
        }
        let new_from = self
            .balance_of(from)
            .checked_sub(value)
            .unwrap_or_else(|| panic!("InsufficientBalance"));
        let new_to = self
            .balance_of(to)
            .checked_add(value)
            .unwrap_or_else(|| panic!("NumericOverflow"));
        self.set_balance(from, new_from);
        self.set_balance(to, new_to);
        true
    }
}

pub struct VftService<'a> {
    state: &'a RefCell<State>,
}

impl<'a> VftService<'a> {
    pub fn new(state: &'a RefCell<State>) -> Self {
        Self { state }
    }

    fn ensure_is_admin(&self) {
        if !self.state.borrow().admins.contains(&msg::source()) {
            panic!("Not admin")
        }
    }
}

#[sails_rs::service(events = Event)]
impl<'a> VftService<'a> {
    #[export]
    pub fn mint(&mut self, to: ActorId, value: U256) -> bool {
        let minter = msg::source();
        let mutated = {
            let mut st = self.state.borrow_mut();
            if !st.minters.contains(&minter) {
                panic!("Not allowed to mint")
            }
            if value.is_zero() {
                false
            } else {
                let new_total = st
                    .total_supply
                    .checked_add(value)
                    .unwrap_or_else(|| panic!("NumericOverflow"));
                if new_total > st.max_supply {
                    panic!("MaxSupplyReached")
                }
                let new_to = st
                    .balance_of(to)
                    .checked_add(value)
                    .unwrap_or_else(|| panic!("NumericOverflow"));
                st.set_balance(to, new_to);
                st.total_supply = new_total;
                true
            }
        };
        if mutated {
            self.emit_event(Event::Minted { to, value }).expect("event");
        }
        mutated
    }

    #[export]
    pub fn burn(&mut self, from: ActorId, value: U256) -> bool {
        let burner = msg::source();
        let mutated = {
            let mut st = self.state.borrow_mut();
            if !st.burners.contains(&burner) {
                panic!("Not allowed to burn")
            }
            if value.is_zero() {
                false
            } else {
                let new_total = st
                    .total_supply
                    .checked_sub(value)
                    .unwrap_or_else(|| panic!("Underflow"));
                let new_from = st
                    .balance_of(from)
                    .checked_sub(value)
                    .unwrap_or_else(|| panic!("InsufficientBalance"));
                st.set_balance(from, new_from);
                st.total_supply = new_total;
                true
            }
        };
        if mutated {
            self.emit_event(Event::Burned { from, value }).expect("event");
        }
        mutated
    }

    #[export]
    pub fn transfer_to_users(&mut self, to: Vec<ActorId>, value: U256) -> bool {
        let from = msg::source();
        let mutated = {
            let mut st = self.state.borrow_mut();
            if value.is_zero() {
                false
            } else {
                let total = value
                    .checked_mul(U256::from(to.len()))
                    .unwrap_or_else(|| panic!("NumericOverflow"));
                let new_from = st
                    .balance_of(from)
                    .checked_sub(total)
                    .unwrap_or_else(|| panic!("InsufficientBalance"));
                for user in &to {
                    let new_to = st
                        .balance_of(*user)
                        .checked_add(value)
                        .unwrap_or_else(|| panic!("NumericOverflow"));
                    st.set_balance(*user, new_to);
                }
                st.set_balance(from, new_from);
                true
            }
        };
        if mutated {
            self.emit_event(Event::TransferredToUsers { from, to, value })
                .expect("event");
        }
        mutated
    }

    #[export]
    pub fn change_description(&mut self, new_description: String) {
        self.ensure_is_admin();
        self.state.borrow_mut().description = new_description.clone();
        self.emit_event(Event::DescriptionChanged { new_description })
            .expect("event");
    }

    #[export]
    pub fn change_image_link(&mut self, new_image_link: String) {
        self.ensure_is_admin();
        self.state.borrow_mut().external_links.image = new_image_link.clone();
        self.emit_event(Event::ImageLinkChanged { new_image_link })
            .expect("event");
    }

    #[export]
    pub fn change_external_links(&mut self, new_external_links: ExternalLinks) {
        self.ensure_is_admin();
        self.state.borrow_mut().external_links = new_external_links.clone();
        self.emit_event(Event::ExternalLinksChanged { new_external_links })
            .expect("event");
    }

    #[export]
    pub fn kill(&mut self, inheritor: ActorId) {
        self.ensure_is_admin();
        self.emit_event(Event::Killed { inheritor }).expect("event");
        exec::exit(inheritor)
    }

    #[export]
    pub fn grant_admin_role(&mut self, to: ActorId) {
        self.ensure_is_admin();
        self.state.borrow_mut().admins.insert(to);
    }

    #[export]
    pub fn grant_minter_role(&mut self, to: ActorId) {
        self.ensure_is_admin();
        self.state.borrow_mut().minters.insert(to);
    }

    #[export]
    pub fn grant_burner_role(&mut self, to: ActorId) {
        self.ensure_is_admin();
        self.state.borrow_mut().burners.insert(to);
    }

    #[export]
    pub fn revoke_minter_role(&mut self, from: ActorId) {
        self.ensure_is_admin();
        self.state.borrow_mut().minters.remove(&from);
    }

    #[export]
    pub fn revoke_burner_role(&mut self, from: ActorId) {
        self.ensure_is_admin();
        self.state.borrow_mut().burners.remove(&from);
    }

    #[export]
    pub fn revoke_admin_role(&mut self, from: ActorId) {
        self.ensure_is_admin();
        self.state.borrow_mut().admins.remove(&from);
    }

    #[export]
    pub fn approve(&mut self, spender: ActorId, value: U256) -> bool {
        let owner = msg::source();
        let mutated = {
            let mut st = self.state.borrow_mut();
            if owner == spender {
                false
            } else {
                let prev = st.allowance(owner, spender);
                st.set_allowance(owner, spender, value);
                prev != value
            }
        };
        if mutated {
            self.emit_event(Event::Approval { owner, spender, value })
                .expect("event");
        }
        mutated
    }

    #[export]
    pub fn transfer(&mut self, to: ActorId, value: U256) -> bool {
        let from = msg::source();
        let mutated = self.state.borrow_mut().transfer(from, to, value);
        if mutated {
            self.emit_event(Event::Transfer { from, to, value }).expect("event");
        }
        mutated
    }

    #[export]
    pub fn transfer_from(&mut self, from: ActorId, to: ActorId, value: U256) -> bool {
        let spender = msg::source();
        let mutated = {
            let mut st = self.state.borrow_mut();
            if spender == from {
                st.transfer(from, to, value)
            } else if from == to || value.is_zero() {
                false
            } else {
                let new_allowance = st
                    .allowance(from, spender)
                    .checked_sub(value)
                    .unwrap_or_else(|| panic!("InsufficientAllowance"));
                st.transfer(from, to, value);
                st.set_allowance(from, spender, new_allowance);
                true
            }
        };
        if mutated {
            self.emit_event(Event::Transfer { from, to, value }).expect("event");
        }
        mutated
    }

    #[export]
    pub fn admins(&self) -> Vec<ActorId> {
        self.state.borrow().admins.iter().copied().collect()
    }

    #[export]
    pub fn burners(&self) -> Vec<ActorId> {
        self.state.borrow().burners.iter().copied().collect()
    }

    #[export]
    pub fn description(&self) -> String {
        self.state.borrow().description.clone()
    }

    #[export]
    pub fn external_links(&self) -> ExternalLinks {
        self.state.borrow().external_links.clone()
    }

    #[export]
    pub fn max_supply(&self) -> U256 {
        self.state.borrow().max_supply
    }

    #[export]
    pub fn minters(&self) -> Vec<ActorId> {
        self.state.borrow().minters.iter().copied().collect()
    }

    #[export]
    pub fn allowance(&self, owner: ActorId, spender: ActorId) -> U256 {
        self.state.borrow().allowance(owner, spender)
    }

    #[export]
    pub fn balance_of(&self, account: ActorId) -> U256 {
        self.state.borrow().balance_of(account)
    }

    #[export]
    pub fn decimals(&self) -> u8 {
        self.state.borrow().decimals
    }

    #[export]
    pub fn name(&self) -> String {
        self.state.borrow().name.clone()
    }

    #[export]
    pub fn symbol(&self) -> String {
        self.state.borrow().symbol.clone()
    }

    #[export]
    pub fn total_supply(&self) -> U256 {
        self.state.borrow().total_supply
    }
}

pub struct VftProgram {
    state: RefCell<State>,
}

#[sails_rs::program]
impl VftProgram {
    pub fn new(init: Init) -> Self {
        Self {
            state: RefCell::new(State::seed(init)),
        }
    }

    pub fn vft(&self) -> VftService<'_> {
        VftService::new(&self.state)
    }
}
