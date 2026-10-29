//! Hand-written Sails v1 encoders for the programs the launchpad talks to.
//!
//! Wire format (sails-rs 0.10, `CallCodec::encode_params_with_prefix`):
//! `service: String ++ method: String ++ args`, and replies carry the same two-string prefix
//! before the return value. Keeping this in one place means the launchpad does not depend on
//! the vara-amm or standards client crates and their toolchain pins.

use crate::state::GasConfig;
use gstd::errors::Error as GstdError;
use sails_rs::{
    gstd::{exec, msg},
    prelude::*,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CallError {
    Send,
    Timeout,
    Reply,
    Decode,
    /// A computation on values read back from another program overflowed; returned instead of
    /// trapping, because a trap after an await would leave the launch locked.
    Arithmetic,
}

impl CallError {
    pub fn describe(&self) -> &'static str {
        match self {
            CallError::Send => "send failed",
            CallError::Timeout => "reply timed out",
            CallError::Reply => "callee replied with an error",
            CallError::Decode => "could not decode reply",
            CallError::Arithmetic => "arithmetic overflow on callee values",
        }
    }

    pub fn is_retryable(&self) -> bool {
        true
    }
}

pub fn encode_call(service: &str, method: &str, args: impl Encode) -> Vec<u8> {
    let mut payload = String::from(service).encode();
    payload.extend(String::from(method).encode());
    payload.extend(args.encode());
    payload
}

pub fn decode_reply<T: Decode>(service: &str, method: &str, bytes: &[u8]) -> Result<T, CallError> {
    let mut input = bytes;
    let got_service = String::decode(&mut input).map_err(|_| CallError::Decode)?;
    let got_method = String::decode(&mut input).map_err(|_| CallError::Decode)?;
    if got_service != service || got_method != method {
        return Err(CallError::Decode);
    }
    T::decode(&mut input).map_err(|_| CallError::Decode)
}

/// Methods returning `null` get no manual reply from a sails 0.10 program: the runtime
/// auto-replies with an empty payload (`Success(Auto)`). A prefixed empty reply is accepted too.
fn check_null_reply(service: &str, method: &str, bytes: &[u8]) -> Result<(), CallError> {
    if bytes.is_empty() {
        return Ok(());
    }
    let mut input = bytes;
    let got_service = String::decode(&mut input).map_err(|_| CallError::Decode)?;
    let got_method = String::decode(&mut input).map_err(|_| CallError::Decode)?;
    if got_service != service || got_method != method {
        return Err(CallError::Decode);
    }
    Ok(())
}

/// Gas each continuation needs once its reply arrives: decoding, state updates and events.
pub const CONTINUATION_GAS: u64 = 10_000_000_000;

/// Blocks past the last possible reply timeout before a lock or an in-flight trade counts as
/// abandoned by a message that trapped or ran out of gas.
pub const LOCK_MARGIN_BLOCKS: u32 = 10;

/// gstd's `*_for_reply` helpers queue the message first and only then charge the reply deposit,
/// so their `Err` cannot tell "not sent" from "sent, deposit failed". The message is sent with
/// no deposit here, so `CallError::Send` always means nothing was queued; any failure after
/// that traps, which discards the queued message together with this execution.
pub async fn call(
    dest: ActorId,
    payload: Vec<u8>,
    gas: u64,
    value: u128,
    reply_deposit: u64,
    timeout: u32,
) -> Result<Vec<u8>, CallError> {
    call_tracked(dest, payload, gas, value, reply_deposit, timeout, |_| ()).await
}

/// `call` that hands the queued message's id to `on_sent` before awaiting. What `on_sent`
/// records is committed with the send, so `handle_reply` can book the outcome even if the
/// continuation never runs.
pub async fn call_tracked(
    dest: ActorId,
    payload: Vec<u8>,
    gas: u64,
    value: u128,
    reply_deposit: u64,
    timeout: u32,
    on_sent: impl FnOnce(MessageId),
) -> Result<Vec<u8>, CallError> {
    let future = msg::send_bytes_with_gas_for_reply(dest, payload, gas, value, 0)
        .map_err(|_| CallError::Send)?;
    if reply_deposit != 0 {
        exec::reply_deposit(future.waiting_reply_to, reply_deposit)
            .unwrap_or_else(|_| panic!("ReplyDepositFailed"));
    }
    on_sent(future.waiting_reply_to);
    future
        .up_to(Some(timeout))
        .unwrap_or_else(|_| panic!("ReplyWaitFailed"))
        .await
        .map_err(|e| match e {
            GstdError::Timeout(..) => CallError::Timeout,
            _ => CallError::Reply,
        })
}

async fn call_typed<T: Decode>(
    dest: ActorId,
    service: &str,
    method: &str,
    args: impl Encode,
    gas: u64,
    value: u128,
    g: &GasConfig,
) -> Result<T, CallError> {
    let bytes = call(
        dest,
        encode_call(service, method, args),
        gas,
        value,
        g.gas_for_reply_deposit,
        g.reply_timeout,
    )
    .await?;
    decode_reply(service, method, &bytes)
}

async fn call_null(
    dest: ActorId,
    service: &str,
    method: &str,
    args: impl Encode,
    gas: u64,
    value: u128,
    g: &GasConfig,
) -> Result<(), CallError> {
    let bytes = call(
        dest,
        encode_call(service, method, args),
        gas,
        value,
        g.gas_for_reply_deposit,
        g.reply_timeout,
    )
    .await?;
    check_null_reply(service, method, &bytes)
}

// ---------------------------------------------------------------- Tokenator VFT ("Vft")

#[derive(Clone, Debug, Encode, Decode, TypeInfo)]
pub struct VftExternalLinks {
    pub image: String,
    pub website: Option<String>,
    pub telegram: Option<String>,
    pub twitter: Option<String>,
    pub discord: Option<String>,
    pub tokenomics: Option<String>,
}

/// Mirrors `contracts/fungible-token` `Init` field for field; the field order is the wire format.
#[derive(Clone, Debug, Encode, Decode, TypeInfo)]
pub struct VftInit {
    pub name: String,
    pub symbol: String,
    pub decimals: u8,
    pub description: String,
    pub external_links: VftExternalLinks,
    pub initial_supply: U256,
    pub max_supply: U256,
    pub admin_id: ActorId,
}

pub fn vft_init_payload(init: &VftInit) -> Vec<u8> {
    let mut payload = String::from("New").encode();
    payload.extend(init.encode());
    payload
}

pub async fn vft_transfer(token: ActorId, to: ActorId, value: U256, g: &GasConfig) -> Result<bool, CallError> {
    call_typed(token, "Vft", "Transfer", (to, value), g.gas_for_token_ops, 0, g).await
}

pub async fn vft_transfer_from(
    token: ActorId,
    from: ActorId,
    to: ActorId,
    value: U256,
    g: &GasConfig,
) -> Result<bool, CallError> {
    call_typed(token, "Vft", "TransferFrom", (from, to, value), g.gas_for_token_ops, 0, g).await
}

pub async fn vft_approve(token: ActorId, spender: ActorId, value: U256, g: &GasConfig) -> Result<bool, CallError> {
    call_typed(token, "Vft", "Approve", (spender, value), g.gas_for_token_ops, 0, g).await
}

pub async fn vft_balance_of(token: ActorId, account: ActorId, g: &GasConfig) -> Result<U256, CallError> {
    call_typed(token, "Vft", "BalanceOf", (account,), g.gas_for_token_ops, 0, g).await
}

/// `method` is one of `RevokeMinterRole`, `RevokeBurnerRole`, `RevokeAdminRole`.
pub async fn vft_revoke_role(token: ActorId, method: &str, from: ActorId, g: &GasConfig) -> Result<(), CallError> {
    call_null(token, "Vft", method, (from,), g.gas_for_token_ops, 0, g).await
}

/// `method` is one of `Admins`, `Minters`, `Burners`.
pub async fn vft_role_holders(token: ActorId, method: &str, g: &GasConfig) -> Result<Vec<ActorId>, CallError> {
    call_typed(token, "Vft", method, (), g.gas_for_token_ops, 0, g).await
}

// ---------------------------------------------------------------- RivrDEX Factory ("Factory")

pub async fn factory_get_pair(factory: ActorId, a: ActorId, b: ActorId, g: &GasConfig) -> Result<ActorId, CallError> {
    call_typed(factory, "Factory", "GetPair", (a, b), g.gas_for_token_ops, 0, g).await
}

pub async fn factory_create_pair(
    factory: ActorId,
    a: ActorId,
    b: ActorId,
    value: u128,
    g: &GasConfig,
) -> Result<(), CallError> {
    call_null(factory, "Factory", "CreatePair", (a, b), g.gas_for_create_pair, value, g).await
}

// ---------------------------------------------------------------- RivrDEX Pair ("Pair" + its LP "Vft")

pub async fn pair_get_tokens(pair: ActorId, g: &GasConfig) -> Result<(ActorId, ActorId), CallError> {
    call_typed(pair, "Pair", "GetTokens", (), g.gas_for_token_ops, 0, g).await
}

pub async fn pair_get_reserves(pair: ActorId, g: &GasConfig) -> Result<(U256, U256), CallError> {
    call_typed(pair, "Pair", "GetReserves", (), g.gas_for_token_ops, 0, g).await
}

pub async fn pair_get_amount_out(
    pair: ActorId,
    amount_in: U256,
    is_token0_to_token1: bool,
    g: &GasConfig,
) -> Result<U256, CallError> {
    call_typed(pair, "Pair", "GetAmountOut", (amount_in, is_token0_to_token1), g.gas_for_token_ops, 0, g).await
}

pub async fn pair_swap_exact_in(
    pair: ActorId,
    amount_in: U256,
    amount_out_min: U256,
    is_token0_to_token1: bool,
    deadline_ms: u64,
    g: &GasConfig,
) -> Result<(), CallError> {
    call_null(
        pair,
        "Pair",
        "SwapExactTokensForTokens",
        (amount_in, amount_out_min, is_token0_to_token1, deadline_ms),
        g.gas_for_add_liquidity,
        0,
        g,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn pair_add_liquidity(
    pair: ActorId,
    amount0_desired: U256,
    amount1_desired: U256,
    amount0_min: U256,
    amount1_min: U256,
    deadline_ms: u64,
    g: &GasConfig,
) -> Result<(), CallError> {
    call_null(
        pair,
        "Pair",
        "AddLiquidity",
        (amount0_desired, amount1_desired, amount0_min, amount1_min, deadline_ms),
        g.gas_for_add_liquidity,
        0,
        g,
    )
    .await
}

// ---------------------------------------------------------------- wVARA ("VftNativeExchange")

pub async fn wvara_mint(
    wvara: ActorId,
    value: u128,
    g: &GasConfig,
    on_sent: impl FnOnce(MessageId),
) -> Result<(), CallError> {
    wvara_exchange(wvara, "Mint", encode_call("VftNativeExchange", "Mint", ()), value, g, on_sent).await
}

pub async fn wvara_burn(
    wvara: ActorId,
    amount: U256,
    g: &GasConfig,
    on_sent: impl FnOnce(MessageId),
) -> Result<(), CallError> {
    wvara_exchange(wvara, "Burn", encode_call("VftNativeExchange", "Burn", (amount,)), 0, g, on_sent).await
}

async fn wvara_exchange(
    wvara: ActorId,
    method: &str,
    payload: Vec<u8>,
    value: u128,
    g: &GasConfig,
    on_sent: impl FnOnce(MessageId),
) -> Result<(), CallError> {
    let bytes = call_tracked(
        wvara,
        payload,
        g.gas_for_token_ops,
        value,
        g.gas_for_reply_deposit,
        g.reply_timeout,
        on_sent,
    )
    .await?;
    check_null_reply("VftNativeExchange", method, &bytes)
}

// ---------------------------------------------------------------- value out

/// Sends native value with no gas, so a user gets it at once (below the mailbox threshold) and
/// the runtime auto-replies with success. A program cannot run a gasless message, so the send
/// bounces: the value comes back with an error reply, which `reply_deposit` pays to handle.
/// `None` means the runtime refused the send and nothing left.
#[must_use]
pub fn send_value(to: ActorId, value: u128, reply_deposit: u64) -> Option<MessageId> {
    let id = msg::send_bytes_with_gas(to, [], 0, value).ok()?;
    if reply_deposit != 0 {
        // The send is already queued: failing here must trap so it is reverted with it.
        exec::reply_deposit(id, reply_deposit).unwrap_or_else(|_| panic!("ReplyDepositFailed"));
    }
    Some(id)
}

pub fn existential_deposit() -> u128 {
    exec::env_vars().existential_deposit
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn call_payload_is_service_method_args() {
        let to = ActorId::from(7u64);
        let payload = encode_call("Vft", "Transfer", (to, U256::from(5u32)));
        let mut expected = String::from("Vft").encode();
        expected.extend(String::from("Transfer").encode());
        expected.extend((to, U256::from(5u32)).encode());
        assert_eq!(payload, expected);
    }

    #[test]
    fn reply_prefix_is_checked() {
        let mut reply = String::from("Vft").encode();
        reply.extend(String::from("Transfer").encode());
        reply.extend(true.encode());
        assert_eq!(decode_reply::<bool>("Vft", "Transfer", &reply), Ok(true));
        assert_eq!(
            decode_reply::<bool>("Vft", "TransferFrom", &reply),
            Err(CallError::Decode)
        );
    }

    #[test]
    fn vft_init_payload_starts_with_constructor_name() {
        let init = VftInit {
            name: "A".into(),
            symbol: "A".into(),
            decimals: 18,
            description: String::new(),
            external_links: VftExternalLinks {
                image: String::new(),
                website: None,
                telegram: None,
                twitter: None,
                discord: None,
                tokenomics: None,
            },
            initial_supply: U256::one(),
            max_supply: U256::one(),
            admin_id: ActorId::zero(),
        };
        let payload = vft_init_payload(&init);
        assert!(payload.starts_with(&String::from("New").encode()));
    }
}
