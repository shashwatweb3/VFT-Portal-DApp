# 02 — Ship roadmap (Curve Launch / Tokenator 2.0)

Derived from `01-curve-launch.md` v3 §6 with the SHIP gate decisions of 2026-10-19: **no commits**, **local gear dev node only (no testnet)**, **vara-amm deployed locally**, scope **M0–M5 + M6 audit package**, mainnet excluded. Branch `feat/curve-launch`.

| M | Slice | Done-signal (the check that proves it) | Status |
|---|---|---|---|
| M0 | Toolchain + RivrDEX spike: vara-amm (Factory/Pair) + wVARA built; Tokenator VFT wasm built (or rebuilt on gstd 1.10); launchpad workspace compiles; a gtest drives wrap → create pair → add liquidity → LP to dead from a program | `cargo test -p launchpad --test graduation` green against real vara-amm wasm | done |
| M1 | Curve program: Launch (spawns VFT, admin = launchpad), Buy, Sell, Quote, claims, busy lock, pending payouts, reconcile | `cargo test` curve unit + gtest `launch`, `trade` green; invariants asserted | done (+ M1.5 hardening after skeptic review: 35 tests) |
| M2 | Graduation state machine (one step per message) against real vara-amm wasm in gtest; then live run on local `gear --dev` | gtest `graduation` green; `devnet/` deploy + smoke on the node | done (SMOKE OK) |
| M3a | Frontend trade panel + create-mode toggle on chain queries | `pnpm lint` + `pnpm build` green; manual flow on dev node | done |
| M4 | Indexer: launchpad events → CurveLaunch/CurveTrade/CurveCandle + Coin rows | `npm run build` + handler unit tests; local squid run against dev node | done |
| M3b | Lists, trades/holders tables, homepage/FAQ/menu copy, ToS checkbox | `pnpm lint` + `pnpm build` green; states row satisfied | done |
| M5 | voucher-server (issue + keeper), legal pages, GTM consent, pinata-proxy limits | service unit tests green; keeper graduates a Ready launch on dev node | done |
| M6 | Audit package in `docs/audit/` (threat model, invariants, test matrix, runbook) | files present, cross-referenced to tests | done (package in docs/audit/) |

Local-node adaptation: testnet steps in the plan become `gear --dev --tmp` steps; program ids are read from the local deployment script output and written to `.env.local` files (gitignored).

## Phase 4 (adversarial feedback) and fixes

Four attackers (contract, indexer, services, frontend) found 6 HIGH, 11 MEDIUM and several LOW issues; all HIGH and MEDIUM are fixed with regressions except where noted in `docs/audit/findings.md` (C7 retryability split, C9 reply-timeout test). The contract gained one graduation step (`AlignPrice`, now 11 steps) and a per-creator launch cooldown; the dev stack was redeployed on the fixed contract and `smoke.ts`, `gasless.ts` (keeper-driven) and the live indexer all pass again.
