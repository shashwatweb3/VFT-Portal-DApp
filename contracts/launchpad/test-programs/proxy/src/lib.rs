//! `handle((destination, payload))` forwards `payload` to `destination` with all remaining gas
//! and replies with the reply payload it got back. Value the reply carried stays here.
#![no_std]

#[cfg(target_arch = "wasm32")]
mod program {
    use gstd::{msg, prelude::*, ActorId};

    #[gstd::async_main]
    async fn main() {
        let (destination, payload): (ActorId, Vec<u8>) = msg::load().expect("(ActorId, Vec<u8>)");
        let reply = msg::send_bytes_for_reply(destination, payload, 0, 10_000_000_000)
            .expect("send")
            .await
            .unwrap_or_default();
        msg::reply_bytes(reply, 0).expect("reply");
    }
}

#[cfg(feature = "wasm-binary")]
#[cfg(not(target_arch = "wasm32"))]
pub use code::WASM_BINARY_OPT as WASM_BINARY;

#[cfg(feature = "wasm-binary")]
#[cfg(not(target_arch = "wasm32"))]
mod code {
    include!(concat!(env!("OUT_DIR"), "/wasm_binary.rs"));
}
