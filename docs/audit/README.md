# Curve Launch — audit package

Scope, build, and how to reproduce every claim. Prepared 2026-10-19 on branch `feat/curve-launch` (uncommitted working tree). Design: `docs/plans/01-curve-launch.md` (v3).

## In scope

| Component | Path | Holds value? |
|---|---|---|
| Launchpad program | `contracts/launchpad/launchpad/app/src/` (`service.rs`, `state.rs`, `curve.rs`, `wire.rs`, `lib.rs`) | **Yes** — escrowed VARA, fees, pending payouts, operating reserve |
| Tokenator VFT (port to sails-rs 0.10.2) | `contracts/launchpad/vft/app/src/lib.rs` | Token balances |
| Voucher issuer + graduation keeper | `voucher-server/src/` | Issuer hot wallet |
| Indexer additions | `indexer/src/processing/launchpad/`, `indexer/src/types/launchpad.events.ts`, migration `indexer/db/migrations/1792413001821-Data.js` | No |
| Frontend trade flow | `frontend/src/lib/sails/use-launchpad.ts`, `frontend/src/components/sections/tokens/curve/` | No |

Out of scope (third party, used as-is): RivrDEX Factory/Pair (`gear-foundation/vara-amm` master, awesome-sails rev `1ec7991`), wVARA (`awesome-sails` VftNativeExchange). Tests run against their real wasm, built from source.

## Toolchain

- Rust 1.91.0 (pinned in `contracts/launchpad/rust-toolchain.toml`; 1.99 links gear 1.10 wasm with undefined `gr_*` symbols).
- sails-rs `=0.10.2`, gstd/gtest `=1.10.0`. Release profile has `overflow-checks = true`.
- IDL v1 (parsed by sails-js 0.5.1 in the frontend, indexer and services).

## Reproduce

```bash
# third-party wasm used by the tests (see contracts/launchpad/tests-wasm/README.md)
cd vendor/vara-amm/contracts && cargo build --release
cd vendor/awesome-sails && RUSTUP_TOOLCHAIN=1.91.0 cargo build --release -p awesome-sails-test-app
# copy *.opt.wasm into contracts/launchpad/tests-wasm/ as rivr_factory, rivr_pair, wvara

cd contracts/launchpad && cargo test --workspace          # unit + gtest suites
cd indexer && npm test                                   # handler unit tests
cd voucher-server && pnpm test && pnpm typecheck

# live local node
gear --dev --tmp --rpc-port 9944 --rpc-cors all
cd devnet && pnpm install && pnpm run deploy && pnpm run smoke   # SMOKE OK
npx tsx src/gasless.ts   # needs voucher-server running; GASLESS OK
```

## Documents

- `threat-model.md` — actors, assets, trust boundaries, attack list with the control for each.
- `invariants.md` — what must always hold, and the test that checks it.
- `test-matrix.md` — every test, what it proves, and known gaps.
- `runbook.md` — deployment order, keys, monitoring, incident playbooks.
- `findings.md` — results of the internal adversarial pass (Phase 4) and their status.
