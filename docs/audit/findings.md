# Internal adversarial pass (Phase 4) — findings and status

Four attackers ran locally on 2026-10-19: contract (gtest against real RivrDEX wasm), indexer (live squid + replays), voucher service + IPFS proxy (HTTP probes), and frontend (code + chain checks). Every finding below was reproduced. Status is after the fix pass; regression tests are named where they exist.

## Contract

| # | Severity | Finding | Status | Regression |
|---|---|---|---|---|
| C1 | HIGH | Dust pre-seed: a griefer seeds the pair at a near-zero price for ~1 VARA; graduation followed that ratio, put ~0 VARA in the pool and booked ~591 VARA as protocol fees | **Fixed**: new `AlignPrice` step swaps the pool back to the curve's final price before depositing; deposits only at the target ratio | `fb_preseed_cheap_ratio_hijacks_listing` |
| C2 | HIGH | Large pre-seed: absolute reserves ≥ our amounts made AddLiquidity look already done; 200M tokens stranded | **Fixed**: resume detection uses a reserve snapshot taken just before our own AddLiquidity | `fb_preseed_large_reserves_skips_add_liquidity` |
| C3 | HIGH | Expensive pre-seed: following the ratio stranded most pool tokens in the launchpad | **Fixed**: `AlignPrice` + Settle sends any leftover curve tokens to `LP_DEAD` | `fb_preseed_expensive_ratio_strands_pool_tokens` |
| C4 | MEDIUM | Pair-creation fee came out of escrow, so after an unwind the last seller hit `EscrowExhausted` | **Fixed**: fee paid from the operating reserve, charged to the graduation fee only at Settle | `fb_unwind_after_pair_created_strands_last_sellers` |
| C5 | HIGH (from services pass) | One voucher funds several launches, each costing the operating reserve 1 VARA (child ED) → reserve drain blocks all launches | **Fixed**: per-creator `launch_cooldown_blocks`; voucher sized to one launch's gas with a short lifetime | `launch_cooldown_limits_one_creator` |
| C6 | LOW | Look-alike Unicode names bypass case-insensitive uniqueness; image/links unbounded | **Fixed**: printable-ASCII names (matches the create form), whitespace collapsed, links ≤ 256 bytes | `fb_limits_and_name_uniqueness` |
| C7 | LOW | Every call failure is marked retryable; a permanent failure after step 5 can only be retried | **Open** — needs a permanent/retryable split and an admin escape hatch | — |
| C8 | LOW | Donated wVARA skips the wrap mint; the un-wrapped VARA stays as free balance | **Accepted** — benign (value stays in the reserve) | `fb_donations_do_not_strand_value` |
| C9 | INFO | Reply timeouts cannot be produced in gtest; `Reconcile` is untested | **Open** — needs a gclient test with a slow callee | — |

## Voucher service and IPFS proxy

| # | Severity | Finding | Status |
|---|---|---|---|
| S1 | HIGH | No per-IP or global cap: ~1,200 vouchers/hour from fresh keys | **Fixed**: per-IP and global hourly caps, issuer balance floor, 10-minute voucher lifetime |
| S2 | MEDIUM | Service never reconnects after a node drop; `/health` stays ok | **Fixed**: exits on disconnect for the supervisor to restart; `/health` reflects the connection |
| S3 | MEDIUM | Keeper retries failing sends every tick (~0.43 VARA each); a hung reply wedges the loop | **Fixed**: per-launch exponential backoff with a give-up limit; timeouts on submit and reply |
| S4 | MEDIUM | Issuer and keeper share an account; dropped/invalid issue tx hangs the issuing chain | **Fixed**: separate seeds (warning if equal); Dropped/Invalid/Usurped handled; 60 s timeout |
| S5 | LOW | Malformed bodies return 500 | **Fixed**: 400 / 413 |
| P1 | HIGH | Proxy trusted client Content-Type: HTML/SVG pinned as "image/png" (stored XSS on the gateway) | **Fixed**: magic-byte sniffing for jpeg/png/gif/webp; verified live |
| P2 | HIGH | Proxy rate limit trusted a spoofable `X-Forwarded-For` | **Fixed**: `req.ip` with an explicit `trust proxy` hop count; verified live |
| P3 | MEDIUM | Zero-byte files accepted; quota checked after buffering 5 MB | **Fixed**: empty files rejected; rate limit runs as a guard before multer |
| P4 | LOW | Pinata non-429 errors swallowed → 200 with no hash | **Fixed**: rethrown |

## Indexer

| # | Severity | Finding | Status | Regression |
|---|---|---|---|---|
| I1 | MEDIUM | `Reconciled` after a completing buy flipped READY back to TRADING | **Fixed**: status transitions guarded | `feedback.sim.test.mjs` |
| I2 | LOW-MED | Replayed trade double-counted volume/fees/tradeCount | **Fixed**: events with `seq ≤ lastSeq` skipped | `feedback.sim.test.mjs` |
| I3 | LOW | Body-less `Launched` decoded as a zero-address token | **Fixed**: null-token events rejected | `feedback.sim.test.mjs` |
| I4 | LOW | Pair counted as a holder until `Graduated` named it | **Fixed** (found in the live run) | live DB check |
| I5 | INFO | `feesVara` is trade fees only; replay from scratch needs an archive node | **Documented** | — |
| I6 | LOW | Classic self/zero transfers would mis-count (unreachable: the VFT emits no event for them) | **Open, documented** as `todo` tests | — |

## Frontend

| # | Severity | Finding | Status |
|---|---|---|---|
| F1 | HIGH | Aborted launches: the sell-back path was unreachable | **Fixed**: panel defaults to Sell, only Buy disabled |
| F2 | HIGH | A spawned token with a skipped first buy showed as an error | **Fixed**: treated as success, token found, user warned |
| F3 | HIGH | Voucher lost on a cancelled signature | **Fixed**: an unexpired voucher for the launchpad is reused before asking the service |
| F4 | HIGH | No way to claim deferred payouts or creator fees | **Fixed**: claim buttons; sell alert says when VARA is held |
| F5 | MEDIUM | Progress label mixed tokens-sold % with VARA raised | **Fixed**: "X % sold · Y VARA raised" |
| F6 | MEDIUM | Curve UI and copy leaked into builds without a launchpad configured | **Fixed**: every curve surface gated on `NEXT_PUBLIC_LAUNCHPAD_ADDRESS` |
| F7 | MEDIUM | Unknown-address token page spun forever | **Fixed**: error state |
| F8 | MEDIUM | Consent banner covered alerts and the wallet modal | **Fixed**: z-order below both |
| F9 | MEDIUM | Failed state offered retry when not retryable; no Unwind or Start-graduation actions | **Fixed**: actions mirror the contract's preconditions |
| F10 | MEDIUM | Copy overclaims ("everything raised goes into the pool", "no one has keys", "lists by itself") | **Fixed** in confirm, FAQ, terms, trade panel |
| F11–F21 | LOW | Input parsing, negative price impact, 100 % dust, balance-load flash, hard-coded fee, status labels, two-signature hint, orphan IPFS uploads, mobile overflow, design nits | **Fixed** (mobile verified by screenshot at 390 px) |
