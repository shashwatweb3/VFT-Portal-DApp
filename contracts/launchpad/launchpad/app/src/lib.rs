//! Curve Launch launchpad for Tokenator 2.0.
//!
//! One program holds every bonding curve. It spawns Tokenator VFTs with itself as the sole
//! admin / minter / burner, custodies the VARA buyers put in, and once a curve sells out lists
//! the token on RivrDEX in a resumable, one-step-per-message graduation that ends with the LP
//! tokens sent to RivrDEX's dead address and every VFT role renounced. Design:
//! `docs/plans/01-curve-launch.md`.
#![no_std]

pub mod curve;
pub mod service;
pub mod state;
pub mod wire;

extern crate alloc;

use alloc::rc::Rc;
use sails_rs::{cell::RefCell, gstd::msg, prelude::*};
use service::LaunchpadService;
use state::{Config, State};

pub struct LaunchpadProgram {
    /// Shared so a critical hook (see `LaunchpadService::on_trap`) can reach it from
    /// `handle_signal`.
    state: Rc<RefCell<State>>,
}

#[sails_rs::program]
impl LaunchpadProgram {
    pub fn new(config: Config) -> Self {
        service::validate_config(&config);
        let admin = msg::source();
        Self {
            state: Rc::new(RefCell::new(State::new(config, admin))),
        }
    }

    pub fn launchpad(&self) -> LaunchpadService<'_> {
        LaunchpadService::new(&self.state)
    }

    /// Replies to our own awaited calls are routed by gstd before this runs; here only the
    /// replies to value sends matter, and a bounced one is re-credited as a pending payout.
    #[handle_reply]
    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    fn on_reply(&self) {
        let (Ok(reply_to), Ok(code)) = (msg::reply_to(), msg::reply_code()) else {
            return;
        };
        self.state.borrow_mut().on_reply(reply_to, code.is_error());
    }
}
