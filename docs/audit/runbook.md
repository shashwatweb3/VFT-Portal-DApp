# Runbook

## Deployment order (any network)

1. Build: `contracts/launchpad` (`cargo build --release`) → `launchpad.opt.wasm`, `tokenator_vft.opt.wasm`, `idl/launchpad.idl`.
2. VFT code: on mainnet, decide between the live Tokenator VFT code (read `MemeCodeId` from factory B, IDL-compatible) and the ported build (`tokenator_vft.opt.wasm`, audited with this package). Upload the chosen code; record the CodeId.
3. Deploy the launchpad with `Config`: `vft_code_id`, `addrs` (RivrDEX factory, wVARA, `lp_dead = 0x0101…01`, treasury multisig), `raise_target_vara` from the USD target and the VARA price, `graduation_fee_vara = 3 VARA`, `pair_creation_fee_vara = 1 VARA`, supply 1e27 / curve 8e26, `fee_bps = 100`, `creator_fee_bps = 50`, `min_trade_vara = 1 VARA`, `min_free_balance`, `graduation_timeout_blocks`, `launch_cooldown_blocks`, `gas` (devnet values in `devnet/src/deploy.ts`).
4. `TopUpReserve` with enough VARA for expected launches (≈ 1 VARA child ED each, plus pair fees).
5. `SetAdmin` to the multisig.
6. Start `voucher-server` (issuer + keeper) with `LAUNCHPAD_ADDRESS`, funded issuer/keeper wallets, `ALLOWED_ORIGINS`.
7. Indexer: apply migration `1792413001821`, set `LAUNCHPAD_PROGRAM`, restart the processor.
8. Frontend: set `NEXT_PUBLIC_LAUNCHPAD_ADDRESS`, `NEXT_PUBLIC_VOUCHER_API`, `NEXT_PUBLIC_RIVRDEX_APP`. Without them the site behaves exactly as Tokenator 1.

Mainnet steps 2–8 are one-way doors and need explicit sign-off.

## Keys

| Key | Holds | Risk if leaked | Mitigation |
|---|---|---|---|
| Launchpad admin | Parameter changes for future launches, pause buys | Bad parameters for new launches; cannot touch escrow | Multisig; publish changes |
| Issuer | Voucher budget | Budget drained in vouchers | Small balance, top up daily, alert on spend rate |
| Keeper | Gas for Graduate/Unwind | Gas only | Small balance; graduation is permissionless anyway |
| Treasury | Protocol fees | Fees | Multisig |

## Monitoring

- `free_balance()` query (program balance minus liabilities) — alert below `min_free_balance × 5`.
- Launches in `Failed` or `Ready` for more than a few minutes — keeper log, indexer `curveLaunches(status_in: [FAILED, READY])`.
- `TradeStuck` events — call `Reconcile(token)`.
- Indexer `seq gap` warnings — a missed event; reindex the range.
- Voucher server 5xx rate and issuer balance.

## Incidents

- **Graduation stuck at a step**: read `launch_info(token).fail_reason`; fix the cause (gas budgets via `SetGas`, RivrDEX lock busy → just retry); call `Graduate`. If it failed at steps 1–4 and cannot proceed, `Unwind` returns the pool VARA to escrow and reopens sells.
- **Trade stuck after a timeout**: `Reconcile(token)` resolves it from the real VFT balance.
- **Buys must stop**: `SetPausedBuys(true)`. Sells, claims, graduation and unwinds keep working by design.
- **Bad token content**: hide it in the frontend/indexer; the chain state cannot be removed. Unpin the image via Pinata if it violates the terms.
