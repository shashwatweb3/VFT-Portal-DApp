# 01 — Curve Launch on RivrDEX (Tokenator 2.0) — end-to-end build plan

Status: v3 FINAL (v2 + Aditya's decisions 2026-10-19: PDF raise numbers, we build everything incl. audit prep, creator buy and graduation accounting copied from pump.fun and peers; launchpad comparison researched with citations). Prism PLAN run 2026-10-19, looped, one-way-door stakes: 8 lenses + web research, 3 cross-tier skeptics on 4 load-bearing claims, 3 critics, 1 round-2 skeptic on new runtime claims.
Source brief: `RivrDEX [Curve Launch].pdf` (Vara / RivrDEX proposal). Repo: `VFT-Portal-DApp` at `git ls-files -s` fingerprint `5ab60c7835cc`. Branch: `docs/curve-launch-plan`.

> Cross-tier verification reduces instance- and tier-level error correlation but not shared-lineage blind spots. Treat cross-tier survival as weaker evidence than grounding.

---

## 1. Recommendation

Build **one new Sails program, `launchpad`** (own workspace `contracts/launchpad/`, pinned to sails-rs `=0.10.2` / gstd `=1.10.0`, the toolchain RivrDEX's AMM uses), that (a) spawns a Tokenator VFT with **itself as the only admin, minter and burner and `initial_supply == max_supply == 1,000,000,000 × 10¹⁸`** so the whole supply sits in the launchpad and the cap cannot move, (b) runs a **constant-product bonding curve with virtual reserves**, denominated in VARA, with parameters and RivrDEX/wVARA/treasury addresses frozen per launch, state derived from `sold` alone and a per-launch busy lock around each trade's cross-program transfer, (c) when the 800M curve allocation sells out flips to `Ready` and lets a **permissionless, one-step-per-message, resumable `Graduate()`** wrap VARA to wVARA, create (or find) the RivrDEX pair, add **all net raised VARA (minus a 3 VARA operations fee) plus the 200M reserved tokens** to the pool exactly as pump.fun migrates everything it raised, send the LP tokens to RivrDEX's dead address, and **renounce minter, burner, then admin** on the VFT, and (d) accrues the 1% trade fee in-program for pull-claim by creator and a treasury address. The creator may buy in the same `Launch` message with no on-chain cap (pump.fun, Four.meme and Clanker behaviour), labelled "Creator holds X %" in the UI. Creation is gas-sponsored through a Gear voucher issued by a small voucher/keeper service (one launch per wallet per day; the voucher call carries zero value). The frontend adds a "Launch on curve" mode to the existing 3-step create wizard, a trade panel + progress bar on the token page, and curve status in the token list, all composed from the current design tokens (navy `#0F1B34`, card `#1D2C4B`, lime `#B4FF69`, Press Start 2P / Silkscreen / Poppins) with six small new components. The indexer gets `CurveLaunch` / `CurveTrade` / `CurveCandle` fed by post-state events so it never recomputes curve math. Ship **testnet-first**: M0 spike → M1 curve program → M2 graduation + testnet deploy → M3a trade panel → M4 indexer → M3b lists/history → M5 voucher/keeper + compliance → M6 audit + mainnet.

## 2. Why (load-bearing reasons)

1. **The creator's VFT powers are the rug.** Today `ExtendedVft::seed` makes `init.admin_id` the sole admin, minter and burner (`contracts/fungible-token/app/src/services/extended_vft/mod.rs:71-73`) and mints `initial_supply` to it (`services/vft/mod.rs:70-72`); `burn(from, …)` does not require `from == msg::source()` (`extended_vft/mod.rs:130-136`); `kill(inheritor)` is `exec::exit` (`extended_vft/mod.rs:183-187`); `mint` reverts with `MaxSupplyReached` once `total_supply == max_supply` (`extended_vft/funcs.rs:21`) and there is no setter for `max_supply`, but `burn` lowers `total_supply` (`funcs.rs:49-60`), so a burner + minter pair can re-mint whatever was burned; minters and burners survive an admin renounce (`mod.rs:203-214`). Making the launchpad the admin, setting `initial_supply == max_supply`, and renouncing **minter and burner before admin** closes all of this with zero changes to the VFT code. [C2 — verified]
2. **RivrDEX is a Uniswap-v2-style Sails AMM with no router and no on-chain $1,000 rule.** Factory `CreatePair(token0, token1)` panics unless exactly 1 VARA is attached (vara-amm `contracts/factory/app/src/lib.rs:6,92`); Pair `AddLiquidity(...)` pulls both tokens with `Vft.TransferFrom(msg::source(), pair, …)` and mints LP to `msg::source()` with no caller-type check (`contracts/pair/app/src/services/pair/funcs.rs:46-161`); the Pair program itself exposes the LP `Vft` service (`pair/app/src/lib.rs`), so "burn LP" is a `Vft.Transfer` to `LP_DEAD = 0x0101…01`; pools hold VFTs only, so native VARA is wrapped via `VftNativeExchange.Mint`; the $1,000 minimum is `MIN_FIRST_LIQUIDITY_USD = 1000` in RivrDEX's frontend `consts.ts` and nowhere in the programs (docs: "the Add Liquidity button stays disabled"). A program can therefore seed a pool directly, and the "$1K rule" survives as **our policy**. [C1 — verified]
3. **Gear is async; graduation is eight cross-program messages.** The existing factory shows the failure shape: state is written only after the `await` (`contracts/meme-factory/app/src/service.rs:173-194`), so a reply failure is a silent no-op with the user's value stranded. A persisted per-launch state machine, one step per message, idempotent steps with per-launch expected balances, and a permissionless resume/unwind path is the only auditable shape.
4. **A single launchpad program matches how the frontend and indexer already address things.** The frontend has one `CONTRACT_ADDRESS` (`frontend/src/lib/consts.ts:21-26`); the indexer routes by one factory address else a known coin address (`indexer/src/main.ts:83-91`). One launchpad address drops in as a second "factory" branch; per-token curve programs would need N addresses, N existential deposits and a new discovery mechanism.
5. **Toolchain.** The repo's contracts pin sails-rs 0.2.0 / gstd 1.4.2 (`contracts/meme-factory/Cargo.toml:14-16`, `contracts/fungible-token/Cargo.toml:38-45`); frontend and indexer parse IDL v1 with sails-js / sails-js-parser 0.5.1. sails-rs 1.0.0 (crates.io, 2026-05-21; GitHub release "rs/v1.0.0 — IDL V2 Introduction") introduced IDL v2 plus a Sails message header that changes routing; sails-js 1.0.0 peer-requires `@gear-js/api ^0.45.0` while the frontend pins 0.44.2. A skeptic installed sails-js-parser 0.5.1 and parsed RivrDEX's 0.10.2-generated IDLs successfully and confirmed a `!@sails: 2.0.0` IDL fails with "Invalid token". So the new crate stays on 0.10.2 and the frontend/indexer bump is a separate, later milestone. sails-rs 2.x / gstd 2.x exist; Vara mainnet is still `specVersion 11000` (RPC `state_getRuntimeVersion`, 2026-10-19). [C3 — verified]

## 3. Steelman of the rejected options

**Per-token curve program spawned by the factory (like VFTs today).** Strongest case: each curve's state and VARA are isolated, a bug in one launch cannot touch another's reserves, upgrade is per-launch, and the gas per message is bounded by one curve's state. Why we still pass: every launch costs an extra existential deposit and program-creation gas, the indexer must learn N new addresses, graduation needs the per-token program to hold the RivrDEX-facing logic anyway, and isolation can be had in a single program with per-launch ledgers plus a program-wide solvency check after every value-out. Revisit if launches exceed tens of thousands or if the auditor asks for blast-radius isolation.

**Extend the existing meme-factory.** Strongest case: one program, one address, the frontend client already exists, the indexer already tracks it. Why we pass: the deployed factory ("factory B", commit bdedd51) is not the repo's source (`frontend/src/lib/sails/meme-factory.idl` has `gas_for_reply_deposit` in its config, an `UpdateGasForReplyDeposit` method, and `CreateFungibleProgram` returning `actor_id` with no `MemeError` type; `contracts/meme-factory/wasm/meme-factory.idl` has none of that), so extending means reverse-engineering live bytecode; keeping classic VFT creation on factory B lets Tokenator 2.0 ship without touching tokens already live.

**Internal ledger during the curve (tokens delivered at graduation).** Strongest case: every trade is a single message, no cross-program await, trivially atomic. Why we pass: holders don't see tokens in their wallet, the holders list and `balanceOf` lie until graduation, and distributing to N holders at graduation is N messages. We use real VFT transfers per trade behind a per-launch busy lock; the ledger approach is the fallback if the auditor rejects the lock pattern.

**Concurrent trades with an in-flight counter instead of a busy lock.** Strongest case: no `TradeInProgress` rejections on a hot launch. Why we pass for v1: a reverted trade changes the price other in-flight trades were quoted at, and the sell-out cap needs an extra "flip Ready only when in_flight == 0" rule; the busy lock keeps `k` exact, is the same pattern RivrDEX's Pair uses (`AnotherTxInProgress`), and the lock window is one reply round-trip. Because state is derived from `sold`, moving to an in-flight counter later is a contained change.

**Mint-on-buy.** Rejected: every buy becomes an async `Mint` whose failure mode is a panic (`extended_vft/mod.rs:110-113`), and it requires keeping a minter role alive.

**A fixed $500 pool with a ~$94 leftover (the PDF's literal numbers).** Strongest case: matches the deck and leaves a creator bonus. Why we pass: pump.fun, Four.meme and LaunchLab all migrate the entire raise; a pool below the full raise opens above the curve's final price (18.8 % gap for $500), and the leftover needs a split policy nobody else has. Rejected by decision on 2026-10-19 in favour of the full-raise pool. A **$750 / $850 "margin" set** was also considered for VARA-drawdown headroom; the full-raise pool already gives 18 % headroom at the PDF's $600, so it was not needed.

**Linear or exponential curve.** Linear: final price is twice the average, so matching the pool's opening price forces far more than 20% of supply into the pool (≈337M tokens for the $500 case), breaking the 80/20 split. Exponential needs fixed-point `exp` (audit surface). Constant-product is also the DEX's own curve, so the slope is continuous at listing. [C4 — verified]

## 4. What the dapp does today (grounded)

- **Create**: 3-step wizard (`frontend/src/components/sections/tokens/create-token/{form,confirm,created}.tsx`) → `CreateFungibleProgram(init)` with a fixed 1 VARA attached (`frontend/src/lib/sails/use-send-message-factory.ts:23`) and gas = estimate +10% with panics allowed (`:24`). Factory checks `msg::value() ≥ ED` (`service.rs:152-155`), rejects duplicate names with an O(n) scan (`:156-162`), spawns the VFT with `value = 0` (`:164-170`), records it after the await (`:177-194`), emits `MemeCreated`. The 1 VARA the user attaches covers the child's existential deposit, which the runtime takes from the spawning program.
- **Token ops**: mint/burn/send pages call the VFT directly (`use-send-message-ft.ts`); the creator is admin+minter+burner.
- **Read side**: Subsquid squid decodes factory and coin events via IDL (`indexer/src/types/{factory,coin}.events.ts`), writes `Factory/Coin/AccountBalance/Transfer` (`indexer/schema.graphql`), served at `explorer.tokenator.club/graphql`; frontend hooks `use-fetch-*.ts` + `lib/requests.ts` (zod).
- **Design**: tokens in `frontend/src/styles/globals.css:18-29` and `tailwind.config.ts:134-141`; fonts in `app/layout.tsx:11-30`; `.btn--primary` etc. in `globals.css:49-63`.
- **RivrDEX today**: links only (`header-menu.tsx:69-78`, `footer.tsx:80-97`, `faq.tsx:132`).

## 5. Target architecture

### 5.1 Program topology

```
contracts/
  meme-factory/      unchanged; "Classic VFT" path keeps using live factory B
  fungible-token/    unchanged source; its wasm is built once (gstd 1.4.2 workspace) and its CodeId reused
  launchpad/         NEW — own workspace + Cargo.lock; sails-rs =0.10.2, gstd =1.10.0; wasm crate via sails-rs `wasm-builder` feature
    app/src/lib.rs           Program { new(cfg) }, service Launchpad
    app/src/service.rs       launch / buy / sell / graduate / unwind / reconcile / claims / admin
    app/src/curve.rs         pure CP math, U256 checked ops, unit + property tests
    app/src/graduation.rs    step machine
    app/src/rivr.rs          hand-encoded calls: "Factory"/"Pair"/"Vft"/"VftNativeExchange" (same encode_params_with_prefix style vara-amm uses)
    app/tests/{curve.rs, launch.rs, trade.rs, graduation.rs}   gtest 1.10 + VFT wasm via System::submit_code_file + mock Factory/Pair/wVARA programs
    wasm/                    build.rs + launchpad.idl
```

Config (`new`): `vft_code_id`, `gas_for_vft_init`, `reply_deposit`, `rivr_factory`, `wvara`, `lp_dead`, `treasury`, `admins` (multisig), `vara_usd_e6` snapshot, `curve_params_usd` (R, P), `fee_bps = 100`, `creator_fee_bps = 50`, `min_trade_vara`, `wait_up_to_blocks`, `graduation_timeout_blocks`, `ops_reserve_target`.

Per-launch state: `Launch { token, creator, state, k, t0, v0, curve_supply, sold, escrow, pool_vara, pool_tokens, creator_fees, protocol_fees, pending_payouts: HashMap<ActorId,u128>, trade_seq, busy: Option<PendingTrade>, grad_step, expected_wvara, expected_lp, pair, addrs: {rivr_factory, wvara, lp_dead, treasury} (snapshot), ready_at, terms_hash }`. `V` and `T` are never stored: `T = t0 − sold`, `V = k / T`.

### 5.2 Curve mathematics [C4 — verified]

Constant product with virtual reserves: `k = v0 · t0`. State `(V, T)` starts at `(v0, t0)`.
- **Buy** Δv VARA: fee `f = Δv · 100 / 10_000` (half creator, half protocol, accrued only on success); `Δv_net = Δv − f`; `tokens_out = T − ceil(k / (V + Δv_net))`; `sold += tokens_out; escrow += Δv_net`. Reject (panic, so value returns) if `Δv < min_trade_vara`, `tokens_out < min_tokens_out`, or `block > deadline`.
- **Sell** Δt tokens: `vara_gross = V − ceil(k / (T + Δt))`; fee on `vara_gross`; `vara_out = vara_gross − fee`; `sold −= Δt; escrow −= vara_gross`. Reject if `vara_out < min_vara_out`. If `vara_out < ED`, credit `pending_payouts[seller]` (claimable once ≥ ED) instead of sending.
- **Rounding** is always in the contract's favour (ceil on the divisions).
- **Sell-out**: the buy that would push `sold` past `curve_supply` is capped to the remainder; the excess value is returned with an explicit value transfer before the reply; the launch enters `Ready` in that buy's success branch.

Parameter derivation (USD; VARA quantities scale linearly by the snapshot price): choose gross raise `R`, fee 1% → net `G = 0.99R`, pool VARA `P`, pool tokens `Tp = 200M`, curve supply `Tc = 800M`. No-arb at listing requires final curve spot `= P / Tp`. With `a = t0 − Tc` (virtual leftover): `v0 = G·a / Tc` and `(v0 + G)/a = P/Tp` ⇒ `G/a = P/Tp − G/Tc`.

**Decision (Aditya, 2026-10-19): keep the PDF's $600 raise and follow pump.fun's accounting**, where `migrate` moves *all* raised SOL (minus a 0.015 SOL fee) and *all* remaining tokens into the pool (pump-public-docs `PUMP_PROGRAM_README.md`). Four.meme and Moonit do the same (all raised + 20% supply). So `P = G − graduation_fee`, with `graduation_fee = 3 VARA` (pair creation 1 VARA, LP account ED, gas), and there is no leftover.

| Parameter (final) | Value |
|---|---|
| R gross raise | $600 (≈ 1.03M VARA) |
| G net of 1 % curve fee | $594 |
| P into pool | G − 3 VARA ≈ $592 (≈ 1.02M VARA) |
| Pool tokens | 200,000,000 |
| Pool value at listing (snapshot price) | ≈ $1,184 → **18 % headroom over the $1,000 rule** |
| a (virtual leftover) | 267.9M |
| t0 virtual token reserve | 1,067.9M (pump.fun: 1,073M) |
| v0 virtual VARA reserve | $198.9 (≈ 342,000 VARA) |
| Start price / FDV | 1.86e-7 / $186 |
| Graduation price / FDV | 2.96e-6 / $2,960 |

Checks: pump.fun's own constants (1,073M virtual tokens, 30 SOL, 793.1M sold) give 85.0 SOL raised and an exactly continuous price into a 206.9M-token pool (re-derived 2026-10-19); the PDF's "$500 + 20 %" variant was re-derived by three skeptics (a = 338M, t0 = 1,138M, v0 = $251) and is kept in §3 as the rejected alternative. If the pool received less than the full net raise, the pool would open above the curve's final price and the graduating buyer would arb it (18.8 % gap for the $500 case), which is why `P` must be derived from the curve, never chosen independently.

At VARA = $0.000582 (CoinGecko API, 2026-10-19) the contract stores `v0 ≈ 342,000 VARA`, `G ≈ 1.02M VARA`, `P = G − 3 VARA`, as 12-decimal VARA and 18-decimal token integers, frozen at launch from the operator's `vara_usd_e6` snapshot. RivrDEX's UI values a new token at the price you set, so the pool is worth `2·P` at the VARA price on graduation day; the 18 % headroom covers a VARA dip of up to ~15 % between launch and graduation, after which the pool still lists (nothing on-chain blocks it) but below the policy line, and the UI shows the live value.

### 5.3 Launch and trade messages

| Message | Value | Effect |
|---|---|---|
| `Launch(meta {name, symbol, description, external_links}, terms_hash, first_buy_min_tokens_out)` | 0, or the creator's optional first buy (the voucher pays **gas only**; attached value is always drawn from the user — N3 refuted) | Precondition `ops_reserve ≥ 2·ED` (child ED is transferred from the launchpad at creation — N5) else `LowReserve` (pre-await, so a panic returns value). Insert lower-cased name into `names: HashSet` **before** the await (remove on failure). Spawn VFT via `create_program_bytes_with_gas_for_reply(vft_code_id, "New"+Init{admin_id = program_id, initial_supply = max_supply = 1e9·1e18, decimals = 18, …}, gas_for_vft_init, 0, reply_deposit)`. On success write `Launch{state: Trading}` keyed by token, snapshot addresses/params, emit `Launched` (with full metadata — the VFT emits nothing at init), then run the attached value through the Buy path (same 1 % fee, `first_buy_min_tokens_out`, **no on-chain cap**: pump.fun's `create_v2_and_buy_instruction`, Four.meme's pre-buy and Clanker's dev buy are all uncapped; the UI labels the creator's holding instead). On spawn failure **refund the value explicitly** and reply `Err` — never panic after an await (value would stay in the program — N2). A separate batched `Buy` cannot be used for the first buy: it would execute while `Launch` is still waiting for the spawn reply. |
| `Buy(token, min_tokens_out, deadline)` | VARA in | Requires `state == Trading && busy.is_none()`, else panic `TradeInProgress` (pre-await, value returns; frontend retries once). Compute → apply `sold/escrow` → set `busy = Pending{Buy, …}` → `Vft.Transfer(buyer, tokens_out)` with `wait_up_to` → success: accrue fees, emit `Bought`, clear busy, flip `Ready` if `sold == curve_supply`; decoded error / `false`: revert `sold/escrow`, **refund value explicitly** (`send_with_gas(buyer, [], 0, value)`), clear busy; **timeout**: leave `busy = Stuck`, emit `TradeStuck` (N4 — a timed-out message may still execute later). Post-await code paths must not panic. |
| `Sell(token, amount, min_vara_out, deadline)` | 0 | Needs prior `Vft.Approve(launchpad, amount)`; the frontend submits `Approve` + `Sell` as one `utility.batchAll` extrinsic (pallet-utility is in the Vara runtime with `BaseCallFilter = Everything`; both built as `api.message.send` extrinsics since sails-js `TransactionBuilder` cannot be batched; `Sell` gets a fixed gas cushion). `batchAll` is atomic only for **enqueuing**; execution is FIFO in the queue, so Approve runs first and a failed Approve simply makes `Sell`'s `TransferFrom` fail and revert cleanly. On success `send_with_gas(seller, [], 0, vara_out)` — gas below the 3000 `MailboxThreshold` transfers value immediately with no mailbox entry (N1) — or credit `pending_payouts` if below ED. A failed `Sell` leaves the allowance in place (harmless). |
| `Reconcile(token)` | 0 | Permissionless. Only when `busy == Stuck`: query `Vft.BalanceOf(launchpad)`; expected = `curve_supply − sold + pool_tokens` under "trade committed" vs "trade reverted"; whichever matches decides; emits `Reconciled`. |
| `Graduate(token)` | 0 | Permissionless, keeper-driven. Executes **one step** (§5.4) per message; allowed in `Ready`, `Graduating`, `Failed{retryable}`. |
| `Unwind(token)` | 0 | Permissionless. `Failed` at steps 1–4 or `Ready` older than `graduation_timeout_blocks`: burn wVARA back (`VftNativeExchange.Burn`), state `Aborted` (terminal): sells reopen at the frozen curve, buys stay closed. |
| `ClaimCreatorFees(token)` / `ClaimProtocolFees(token)` / `ClaimPayout(token)` | 0 | Pull; min claim ≥ ED; value sent with `gas_limit 0`. Emit `FeesClaimed` / `PayoutClaimed`. |
| `Quote(token, side, amount)` (query) | — | Returns tokens_out / vara_out, price_after_e18, fee. Frontend calls it with `ZERO_ADDRESS` as origin when no wallet is connected. |
| Admin (multisig): `SetVaraUsd`, `SetCurveParams`, `SetAddresses` (timelocked), `TopUpReserve` (payable), `PauseBuys` | 0 except TopUp | Any other admin call with value → panic before any await (value returns on a first-run trap — N2). Address/param changes apply to **future launches only** (each launch snapshots them). `PauseBuys` never blocks Sell, Reconcile, Unwind or Claims. No value-out for admins; no `kill`. |

Solvency invariant asserted after every value-out: `Σ_launches(escrow + creator_fees + protocol_fees + Σ pending_payouts) + ops_reserve + ED ≤ exec::value_available()`. Per-launch: `escrow == k/(t0 − sold) − v0` exactly (ceil rounding only ever leaves escrow ≥ the formula).

### 5.4 Graduation state machine [C1 — verified; one step per `Graduate()` message]

```
Trading ──(sold == curve_supply, success branch of the crossing Buy)──▶ Ready (ready_at = block)
Ready ──Graduate()──▶ Graduating{step}       (optional self-kick: reserve gas at Ready and send_delayed Graduate(self) +1 block; keeper is the backup)
  1 WrapVara     wVARA.VftNativeExchange.Mint  value = pool_vara; expected_wvara += pool_vara
  2 FindOrCreate Factory.GetPair(wvara, token) → if none: Factory.CreatePair(wvara, token) with value == exactly 1 VARA (factory keeps it); store pair; query Pair.GetTokens for token0/token1 order
  3 ApproveToken token.Vft.Approve(pair, pool_tokens)
  4 ApproveWvara wvara.Vft.Approve(pair, pool_vara)
  5 AddLiquidity Pair.GetReserves → if reserves > 0 (someone pre-seeded the pair) compute v2 optimal amounts from the pool ratio, cap at pool_vara/pool_tokens, emit ImbalancedListing; Pair.AddLiquidity(amount0, amount1, min0 = 99 %, min1 = 99 %, deadline_ms) in token0/token1 order; attach gas ≥ pair config gas_for_full_tx; AnotherTxInProgress → retry, not Failed; after reply: expected_lp = Pair.Vft.BalanceOf(self) − Σ other launches' expected_lp on this pair
  6 BurnLp       Pair.Vft.Transfer(lp_dead, expected_lp) — LP VFT is Pausable during any add/remove/swap, so a transfer error is retryable
  7 Renounce     token.Vft.RevokeMinterRole(self) → RevokeBurnerRole(self) → RevokeAdminRole(self), IN THIS ORDER; then query Admins/Minters/Burners and require all empty. Metadata edits and Kill are impossible afterwards — intended, say so in UI/FAQ.
  8 Settle       leftover split (§5.5); release unused wVARA (unwrap); state = Graduated; emit Graduated{pair, lp_burned, …}
reply Err/timeout at any step → Failed{step, reason, retryable}; emit GraduationFailed. Graduate() resumes from `step`. Steps 1–4 unwindable (§5.3 Unwind); step 5 timeout → reconcile by Pair.Vft.BalanceOf before resuming or unwinding; 6–8 resume only.
```

Rules: every step first re-queries (`GetPair`, `GetTokens`, `Allowance`, `BalanceOf`, `Admins`) and compares against the launch's own `expected_*` counters (program-wide wVARA/LP balances are shared across launches); RivrDEX methods panic on error (`export(unwrap_result)`), so each send uses explicit gas + `reply_deposit`, bounds the wait with `wait_up_to`, decodes an error reply as a recorded step, and never panics in our program. VARA leaves the launchpad only at steps 1, 2 and 8. The wVARA mainnet id `0x29c42c66…9d17` is from rivrdex.io docs; M0 re-reads it from the live Factory (the vara-amm frontend IDLs are stale against master).

### 5.5 Fees, leftover and incentives

- 1% on the VARA leg of every curve trade, split 50/50 creator/protocol (the PDF's split; pump.fun charges 1.25 % = 0.95 % protocol + 0.30 % creator on its curve, pump.fun/docs/fees 2026-10-17), accrued as two counters per launch **in the success branch only**; pull-claim with `min_claim ≥ ED`. Protocol fees go to the `treasury` snapshotted at launch (DAO/multisig, not a company hot wallet — §5.9).
- **No leftover.** `P = G − graduation_fee (3 VARA)`; the 3 VARA cover pair creation (1 VARA to the Factory), the LP account's ED and gas. Nothing is paid to the creator at graduation (pump.fun, Four.meme, LaunchLab all pay nothing at migration; Moonit's 2 SOL bonus is the outlier). The creator's economics are the 0.5 % curve fee and their own first buy at floor price.
- **Post-graduation creator share: not available on RivrDEX today.** pump.fun pays creators 0.05–0.95 % of PumpSwap volume by market-cap tier; RivrDEX's swap fee is 0.35 % (0.30 % LP, 0.05 % treasury) with the LP burned, so there is no hook. Raise with RivrDEX as a product ask (route part of the treasury share to creators of graduated tokens); until then the UI says so plainly.

### 5.6 Gas-sponsored creation (vouchers)

- `voucher-server/` (NestJS, sibling of `pinata-proxy/`; wiki "gasless voucher server" pattern): `api.voucher.issue(spender, balance ≈ 3 VARA, durationBlocks ≈ 28,800 (~1 day), programs = [launchpad], codeUploading = false)`; one voucher per wallet per 24 h; `revoke` only after expiry (funds return to issuer). Same service hosts the **keeper** (polls indexer for `READY | GRADUATING | FAILED(retryable)` and sends `Graduate`, and `Unwind` after timeout). Env: `ISSUER_SEED`, `KEEPER_SEED`, funded hot wallets; runbook for custody and top-ups.
- Frontend: `transaction.withVoucher(voucherId)` on `Launch` only; the voucher covers gas, and any first-buy value attached to `Launch` is paid by the creator. Buys/sells are user-paid.
- Abuse controls: per-wallet rate limit, require the wallet to hold ED, `Launch` names case-insensitively unique + reserved-name list. The creator's first buy is optional and uncapped (it is their own VARA); the voucher only ever covers gas, so sybil spam costs the operator ~0.3 VARA of gas plus the child ED per launch.

### 5.7 Events (contract) and indexer model

Events carry **post-state**, never deltas, with a per-launch `trade_seq`:
- `Launched{launch_id, token, creator, name, symbol, decimals, description, external_links, k, t0, v0, curve_supply, pool_tokens, pool_vara, initial_price_e18, fee_bps, terms_hash}`
- `Bought{launch_id, seq, trader, vara_in, fee, tokens_out, sold_after, escrow_after, price_after_e18}` (`sold_after == curve_supply` means Ready; no separate event)
- `Sold{launch_id, seq, trader, tokens_in, fee, vara_out, pending (bool), sold_after, escrow_after, price_after_e18}`
- `TradeStuck{launch_id, seq}`, `Reconciled{launch_id, seq, committed}`
- `GraduationStep{launch_id, step}`, `GraduationFailed{launch_id, step, reason, retryable}`, `ImbalancedListing{launch_id, pair, reserves}`, `Unwound{launch_id}`
- `Graduated{launch_id, pair, wvara_in_pool, tokens_in_pool, lp_burned, creator_bonus, protocol_share}`
- `FeesClaimed{launch_id, who, amount}`, `PayoutClaimed{launch_id, who, amount}`

Indexer (`indexer/`): `assets/launchpad.idl`; `src/types/launchpad.events.ts` (clone of `factory.events.ts:78-100`, guarding `services[name]` before use); third branch in `main.ts:83-91` keyed on `config.launchpadProgram` (`LAUNCHPAD_PROGRAM` in `config.ts`, `.env.example`, `squid.yaml`); handlers in `src/processing/launchpad/*.handler.ts`, registered in `events.processing.ts:25-41`; `batch.service.ts:21-49` saves `curveLaunches` after `coins` and before `trades/candles` (FKs) and `clearAll` extended. The `Launched` handler **creates the `Coin` row** (otherwise `main.ts:88-90` drops every curve-token Transfer): a second `Factory` row for the launchpad, `memeId = "curve-<id>"`, `admins = [launchpad]`, `kind: CURVE`, `excludedHolders = [launchpad]` (pair appended on `Graduated`); `transferred/minted/burned` handlers skip holder ± for excluded addresses; `circulatingSupply = totalSupply − launchpad balance` for curve coins. Candles: `bought/sold` handlers upsert `{60, 300, 3600, 86400}s` buckets cached in `LocalStorage` (re-read per batch since `setStore` clears caches). Status flips to `GRADUATED` only on `Graduated`; `FAILED`/`ABORTED` on their events; never from progress.

```graphql
enum CoinKind { CLASSIC CURVE }
enum CurveStatus { TRADING STUCK READY GRADUATING GRADUATED FAILED ABORTED }
type CurveLaunch @entity { id: ID!  token: Coin! @unique  creator: String! @index  status: CurveStatus! @index
  k: BigInt! t0: BigInt! v0: BigInt!  curveSupply: BigInt!  sold: BigInt!  escrow: BigInt!  poolVara: BigInt!  poolTokens: BigInt!
  priceE18: BigInt!  progressBps: Int!  creatorFees: BigInt!  protocolFees: BigInt!
  pair: String  lpBurned: BigInt  gradStep: Int  lastSeq: Int!  lastBlock: Int!  createdAt: DateTime! @index
  trades: [CurveTrade!]! @derivedFrom(field: "launch")  candles: [CurveCandle!]! @derivedFrom(field: "launch") }
type CurveTrade @entity { id: ID!  launch: CurveLaunch! @index  seq: Int!  side: String!  trader: String! @index
  vara: BigInt!  tokens: BigInt!  fee: BigInt!  priceAfterE18: BigInt!  blockNumber: Int! @index  timestamp: DateTime! @index }
type CurveCandle @entity { id: ID!  launch: CurveLaunch! @index  interval: Int!  bucketStart: DateTime! @index
  o: BigInt! h: BigInt! l: BigInt! c: BigInt!  volumeVara: BigInt!  trades: Int! }
# Coin: + kind: CoinKind!  curveLaunch: CurveLaunch  excludedHolders: [String!]!
```
Deterministic ids (`${launch}-${seq}`, `${launch}-${interval}-${bucket}`); replay-idempotency acceptance is scoped to curve entities (existing `Transfer`/`AccountBalance` rows use `randomUUID()`). One new migration. While in there: register the existing-but-unregistered `MemeRemoved` handler and add `Killed`.

### 5.8 Frontend spec (verbatim design system; no redesign)

**Tokens to use** (from `globals.css:18-29`, `tailwind.config.ts:134-141`, `layout.tsx:11-30`): page `#0F1B34` (`bg-blue-dark`), card `#1D2C4B` (`bg-blue-light`), input `#172542` with 2px `#2E3A55` border (`Input.module.scss`), card/stat border `#2E3B55` (`single-token.tsx:158`), lime `#B4FF69` (`bg-primary`, hover `#98FF37`, active `#86E031`), disabled `#D0D3D9`, text `#FDFDFD` / muted `/80`, label `#A4AAB6`, form error `#FF4F4F` (use `text-[#FF4F4F]`; the Tailwind `error` token is `#FF0101` and is not what forms use), dark-on-lime `#242424`. Fonts: `font-ps2p` headings/buttons/badges, `font-silkscreen` units/sub-heads, `font-poppins` forms/tables/numbers. Buttons `.btn .btn--primary` (`text-[12px] md:text-[16px] px-10 py-4 md:py-6`), secondary-dark `btn border-2 !border-[#2E3B55] bg-[#0F1B34] text-[#FDFDFD] py-3` (`single-token.tsx:273`), pending = text "Pending" + `after:animate-dots` (`mint-modal.tsx:122-129`). Cards: wizard `bg-blue-light rounded-[40px] p-3|p-10 max-sm:rounded-[20px]` (`form.tsx:87`); stat list `rounded-lg border-2 border-[#2E3B55]` with zebra `bg-[#FDFDFD]/[2%]` (`single-token.tsx:158-238`); table card `rounded-2xl bg-[#1D2C4B] p-8 font-poppins` (`data-table.tsx:57`). Badge `font-ps2p rounded-sm bg-white p-1 text-[8px] text-black uppercase` (`my-coins/table.columns.tsx:52`). Progress idiom: `#D0D3D9` track → `border-primary` done (`form.tsx:90`). Container 680/1232 (`globals.css:44`); page shell `container my-10 flex flex-col gap-8` + `<BackButton/>`. Motion: existing `motion.header`, modal variants, `animate-pulse` skeletons (`table-row-skeleton.tsx`), `AnimationCoins` on success. Alerts: only `alert.success` / `alert.error` are used in the repo; for informational banners use an inline zebra row, not `alert.info`. Sprites: `coins fire arrow-right-up question copy link` exist; no chart icon needed.

**New components (6)**: `SegmentedControl`, `CurveProgress`, `TradePanel`, `GraduatedCard`, `TradesTable` + `HoldersTable` (built on `TableLayout` + `TableLayoutWrapper` with a `renderMobile` prop using the `mobile-list-coins.tsx:131-186` accordion idiom — `DataTable` hard-renders `MobileList<Token>` below `md` (`data-table.tsx:51-52`) and cannot be reused), `StatusBadge`. Reuse `Input` (add optional `suffix` prop at `Input.tsx:51-63`), `Select`, `TooltipContainer`, `Accordion`, `Sprite`, `BackButton`, `WalletModal`, `useAlert`, `useBalanceFormat`.

**States row (applies to every new component)**: loading = `animate-pulse` skeleton rows; empty = poppins `text-[#FDFDFD]/80` "No trades yet" / "No holders yet"; indexer error = keep stale data + `alert.error("Explorer unavailable")` (fix `use-fetch-single-coin.ts:71`, which swallows the error then crashes on `data.data`); RPC quote error = button disabled, label "Quote unavailable"; wallet disconnected = everything renders from indexer + `Quote(origin = ZERO_ADDRESS)`, submit reads "Connect Wallet" and opens `WalletModal` (`create-button.tsx:56-65`).

**Screens**
1. **Create** (`create-token/index.tsx`, `form.tsx`, `confirm.tsx`, `created.tsx`, `schema.ts`): `launchModeAtom: 'curve' | 'classic'` (default `curve`); a 2-segment `SegmentedControl` between the stepper and "Token Details" (`form.tsx:106-107`): "Launch on curve · gas-sponsored" / "Classic VFT". Curve mode hides Decimals (`form.tsx:142-165`) and Initial/Max supply (`form.tsx:187-236`), shows one poppins `text-sm text-[#A4AAB6]` line "Supply 1,000,000,000 · 18 decimals · fixed by the curve" with a `question` tooltip, plus optional "First buy (VARA)". `createCurveTokenSchema = createTokenSchema.omit({decimals, initial_supply, max_supply})`. Confirm (`confirm.tsx:158-170`): replace the supply row with "Supply / Curve target (VARA)", add a zebra info list ("Gas sponsored by Tokenator — one launch per wallet per day", "1 % fee: 0.5 % you / 0.5 % protocol", "Lists on RivrDEX when the curve sells out · everything raised goes into the pool · LP tokens are burned", and, when a first buy is entered, "You will hold X % of the curve supply at launch — this is shown publicly"), a required ToS checkbox (its hash is `terms_hash`), button "Launch". Created (`created.tsx:20,45-51`): h3 "Token launched", primary "Open token page".
2. **Token page** (`single-token.tsx`): change `h-[250px]` → `min-h-[250px]` on l.105 (the only permitted edit to the header: children use `row-start-4/5`, so implicit rows overflow the fixed height and would paint over anything appended); append a sibling `mt-10 grid gap-10 lg:grid-cols-[1fr_400px]` (`max-sm:grid-cols-none` already stacks at 390 px). Left: `CurveProgress` (label row + `text-primary` "{formatUnits(escrow,12)} / {formatUnits(G,12)} VARA · {progressBps/100} %" via `useBalanceFormat`; bar `h-3 rounded-full bg-[#2E3B55]`, fill `bg-primary transition-[width]`), stats zebra list (Price, Market cap, Raised, Holders, Supply; drop Minted/Burned/Initial/Max for curve coins), `TradesTable` (Type badge Buy lime / Sell `#FF4F4F`, Account `prettyWord`+copy, VARA, Tokens, Time), `HoldersTable` (Address, Balance, %, "Creator" badge; launchpad/pair rows labelled "Curve" / "Pool"); a `StatusBadge`-style chip "Creator holds X %" next to the progress bar whenever the creator's balance is > 0 (pump.fun-style disclosure). Right, sticky: `TradePanel` card `rounded-2xl bg-[#1D2C4B] p-6 font-poppins lg:sticky lg:top-[calc(var(--header-height)+1rem)]` with Buy/Sell `SegmentedControl`, `<Input label="Amount" suffix="VARA">`, quick chips (1/5/10/25 VARA · 25/50/100 %), "Balance:" line (mint-modal style), quote zebra rows (You receive ≈, Price impact, Fee 1 %, Min received), slippage `Select` (0.5/1/3 %), submit `btn btn--primary w-full disabled:bg-[#D0D3D9]` with Pending dots. States: `TRADING` normal; "This buy completes the curve" lime row when the quote hits the cap; `TradeInProgress` reply → auto-retry once, then "Busy, try again"; `STUCK` → "Reconciling…" (button calls `Reconcile`); `READY/GRADUATING` → inputs disabled, inline row "Graduating · step 3/8"; `GRADUATED` → `GraduatedCard` (h3 "Graduated", poppins "Trading moved to RivrDEX · pool seeded · LP tokens burned", `btn btn--primary` "Trade on RivrDEX" with `arrow-right-up`, `link-primary` "View pool"); `FAILED` → `alert.error` + "Retry graduation"; `ABORTED` → sell-only panel with "Sell back" copy.
3. **All Tokens** (`all-coins/table.columns.tsx:56-66`, `common/data-table/mobile-list-coins.tsx:135-186`, `all-coins.tsx:77`): `Status` column (badge "On curve" + 80 px mini bar / "Graduated" / "Classic"); filter `SegmentedControl` All / On curve / Graduated / Classic wired to `useFetchCoins`. Homepage list line (`homepage/all-coins.tsx:67-74`): "Curve · 63 % → RivrDEX".
4. **Homepage**: h1 unchanged; `hero.tsx:19` → "Launch with sponsored gas, trade on the curve, graduate to RivrDEX."; ticker (`hero-ticker.tsx:24-25`) append "· Bonding curve · Lists on RivrDEX"; `about-create.tsx:10-15` h2 "How Tokenator 2.0 works"; slider → 5 steps (two new 563×400 jpeg+webp @1x/@2x assets); FAQ +4 (curve, graduation, fees, classic) and rewrite `faq.tsx:72` "zero admin access", `:167` "holds no admin keys", `:192` "Launching a token is free" per §5.9 (the launchpad *is* the VFT admin until graduation); metadata title "Tokenator 2.0".
5. **Menus**: `header-menu.tsx:69-78` and `footer.tsx:80-97` add "Curve Launches" → `/tokens?filter=curve`. Footer renders only on the marketing layout (`(marketing)/layout.tsx:8`); leave that.

**Data wiring**: `frontend/src/lib/sails/launchpad.idl` + generated `launchpad.ts` (pin `sails-js-cli` 0.5.x in devDependencies; generation from a 0.10.2 IDL is an M0 acceptance item); `use-send-message-launchpad.ts` cloned from `use-send-message-factory.ts:17-35` but with value per message (Launch 0, Buy quoted, Sell 0), `calculateGas(true, 10)`, and `withVoucher` only when the voucher server returned an id; `use-fetch-curve.ts` (GraphQL, mirrors `use-fetch-single-coin.ts:26-48`) for history/progress; **chain `Quote` for the live quote and chain `state` for enabling the button** (never the indexer); `consts.ts` + `.env.example` gain `NEXT_PUBLIC_LAUNCHPAD_ADDRESS`, `NEXT_PUBLIC_VOUCHER_API`, `NEXT_PUBLIC_RIVRDEX_APP`; `requests.ts:8` image zod must tolerate `null`.

**Flows**: creator `/` → `CreateButton` (wallet gate `create-button.tsx:49-59`) → `/tokens/create` (`WithAuthLayout`) → mode toggle → details → confirm (ToS) → Launch (Pending) → Created → token page. Buyer `/tokens` filter On curve → row → panel → quote (react-query, 3 s poll) → Buy → `alert.success` + refresh. Edge surfaces: insufficient VARA ("keep ≥ 2 VARA for ED and gas"), slippage, cap-completing buy, busy retry, stuck/reconcile, graduating lock, failed/retry, graduated CTA, aborted sell-back.

### 5.9 Compliance and copy controls

- Never say "non-custodial", "free" (unqualified), "guaranteed", "$1,000", "liquidity nobody can pull", "can never be inflated". Use: "Trades settle in an open-source smart contract. No company or individual holds your VARA or has keys to the curve; funds move only by contract rules."; "Max supply is fixed at init and every mint/burn/admin role is renounced at graduation."; "LP tokens are burned."; "Gas-sponsored launch (one per wallet per day)."
- Protocol fees to a treasury address in contract config; fee params immutable per launch; the contract is callable without the frontend; publish addresses.
- ToS + privacy policy pages, cookie consent gating GTM (`layout.tsx:55-71`), creator wallet-signature acceptance (`terms_hash` on-chain), reserved-name list + case-insensitive uniqueness + "unverified" badge, report/delist path ("delisting from the Tokenator interface", never "removal"), server-side limits on `pinata-proxy` (`file.controller.ts:28-53`: mime/size/rate/origin allowlist/unpin), geo-block list. Items needing counsel: MSB/CASP exposure of the 0.5% protocol fee, GDPR for GTM + wallet data, DMCA/DSA notice agent, sanctions scope.

## 6. Roadmap (thin vertical slices; testnet-first; one branch per milestone)

| M | Goal | Files / components | Acceptance | Risk |
|---|---|---|---|---|
| **M0 Spike (2–3 d)** | Prove the RivrDEX call path from a program and the toolchain | `contracts/launchpad/` workspace skeleton; `rivr.rs` encoders; deploy vara-amm (Factory, Pair code, wVARA) on Vara **testnet** ourselves (no testnet ids are published) and record ids; build `fungible-token` wasm (gstd 1.4.2 workspace) and load it in a gtest 1.10 test via `System::submit_code_file` (`meme-factory/app/tests/test.rs:17-24` pattern); generate `launchpad.ts` from a 0.10.2 IDL with sails-js-cli 0.5.x | On a local node: wrap 2 VARA → create pair → add liquidity → LP `BalanceOf(lp_dead) > 0`, with gas per hop logged; gtest accepts the 1.4.2-built VFT wasm (else rebuild VFT on gstd 1.10); client gen succeeds | Mainnet Factory/Pair bytecode ≠ master; wVARA id; if a program cannot be the LP recipient → fall back to an EOA keeper doing AddLiquidity with escrowed funds |
| **M1 Curve program (1 wk)** | Launch + buy + sell + reconcile + claims | `curve.rs` (pure + proptest), `service.rs`, gtest `launch.rs`, `trade.rs` | gtest: `escrow == k/(t0−sold) − v0`; `Σ sold ≤ curve_supply`; roles == {launchpad}; slippage/deadline/min-trade rejects return value; sell-out cap + explicit refund; interleaved trade rejected with `TradeInProgress`; forced transfer failure reverts and refunds; fee claim during pending trade impossible; dust sell credits `pending_payouts`; ex-burner cannot burn curve; name reserved pre-await; `LowReserve` on empty ops reserve | apply-then-await-then-revert under lock must be audited; U256 checked ops |
| **M2 Graduation + testnet deploy (1.5 wk)** | Ready → Graduated against mock Factory/Pair/wVARA in gtest, then real vara-amm on local node and testnet | `graduation.rs`, mocks, `node_test.rs`-style gclient run; `api.code.upload(vft_wasm)` → CodeId; deploy `launchpad.new(cfg)` with testnet ids; prefund ops reserve; generated client committed | double-graduate impossible; timeout mid-chain → `Failed{step}` → resume succeeds; pre-seeded pair → `ImbalancedListing` path; `Unwind` from steps 1–4 and from stale `Ready`; renounce verified via `Admins/Minters/Burners == []`; one launch graduates on testnet | gas per step; `gas_for_full_tx`; keeper not yet built → manual `Graduate` calls |
| **M3a Trade panel (4–5 d)** | Create toggle + TradePanel + CurveProgress on chain queries only | `launchpad.idl/.ts`, `use-send-message-launchpad.ts`, `SegmentedControl`, `TradePanel`, `CurveProgress`, `GraduatedCard`, create-mode toggle, consts/env, `min-h` header fix | Creator and buyer flows end-to-end on testnet with no indexer; approve+sell via `utility.batchAll`; mobile at 390 px; lint clean | `Input` suffix prop; batch gas cushion |
| **M4 Indexer (4–5 d)** | Curve entities + candles | `launchpad.idl`, events parser, handlers (incl. Coin creation), schema, migration, `main.ts` branch, `config.ts`/`.env.example`/`squid.yaml` | GraphQL returns launch/trades/candles; `Coin` rows exist for curve tokens; holders exclude launchpad/pair; status only via events; curve-entity replay idempotent | ordering in `saveAll`; `LocalStorage` cache clears |
| **M3b Lists + history (3–4 d)** | Status column/filter, TradesTable/HoldersTable, homepage/FAQ/menu copy, ToS checkbox | `table.columns.tsx`, `mobile-list-coins.tsx`, `all-coins.tsx`, `TradesTable`, `HoldersTable`, `StatusBadge`, homepage sections, FAQ, slider assets | All states row satisfied per component; copy passes §5.9 | slider assets |
| **M5 Voucher/keeper + compliance (4–5 d)** | `voucher-server/` (issue + keeper), ToS/privacy, consent, proxy hardening | NestJS service, `withVoucher`, legal pages, GTM consent, `pinata-proxy` limits, reserved names, runbook | New wallet launches with 0 VARA spent; second launch in 24 h refused; keeper graduates a Ready launch unattended; GTM loads only after consent | issuer/keeper key custody; voucher sizing |
| **M6 Audit prep + audit + mainnet (3–4 wk calendar)** | We assemble the audit package (threat model from §5.3–5.4, invariant list, gtest suite incl. the N1–N6 runtime tests, `x-ray`/entry-point reports, deployment runbook); external audit (Gear team per the PDF, or a third party); fixes; mainnet | `docs/audit/` package; deploy launchpad with `vft_code_id` read from factory B's `MemeCodeId` query (live VFT ≠ repo source); multisig admins; fund ops reserve, issuer, keeper, treasury; `consts.ts`/env; keep factory B for classic | Audit sign-off with all highs/mediums closed; one real launch graduates on mainnet with pool value ≥ $1,000 at listing; runbook | VARA price drift between snapshot and graduation; keeper liveness; gear v2 runtime enactment |

Smallest shippable v1 = M0–M3a on testnet (create toggle, trade panel, progress, graduation) with no indexer dependency; M4/M3b/M5 layer on without schema breaks because events already carry post-state.

## 7. Assumptions and falsifiers

| Assumption | Falsifier → what changes |
|---|---|
| RivrDEX mainnet Factory/Pair match vara-amm master (CreatePair 1 VARA, AddLiquidity pulls via TransferFrom, Pair is LP VFT, no caller-type check) [C1] | M0 spike fails → rewrite `rivr.rs`; if a program cannot be LP recipient, fall back to an EOA keeper doing AddLiquidity with funds escrowed by the launchpad (weaker trust, documented) |
| sails-rs 0.10.2 IDL parses in sails-js / sails-js-parser 0.5.1 and sails-js-cli 0.5.x generates a client [C3] | Client gen fails → bump frontend+indexer to sails-js 1.x (+ @gear-js/api 0.45) as its own milestone before M3a |
| gtest 1.10 accepts the VFT wasm built on gstd 1.4.2 | Rejects → rebuild `fungible-token` on gstd 1.10 (then it is no longer "unchanged" and needs its own review) |
| Vara runtime stays on spec 11000 through M6; the gear v2 runtime ("Programs: Required" update) is not enacted mid-build | Enacted → rebuild all programs on gstd 2.x before mainnet; re-run M1/M2 |
| Runtime semantics N1, N2, N4, N5, N6 as recorded in §9.1 (mailbox threshold 3000 gas; value returns only on a first-run trap; timeouts don't cancel; child ED from the creator program; `batchAll` enqueues atomically) | Any change in a runtime upgrade → re-run the M1/M2 gtest suite, which encodes each of these as a test |
| Operator runs a keeper + voucher issuer with funded hot wallets | No ops capacity → optional self-kick delayed message at `Ready` becomes mandatory; `Unwind` after timeout protects users either way |
| VARA ≈ $0.0006 so $-targets are ~10⁶ VARA and ED/gas are negligible | Price ×10 → min trade and ED checks matter more; nothing structural |

## 8. Decisions and open questions

Decided by Aditya on 2026-10-19:
1. **Raise $600 (PDF numbers)**; pool receives everything net of fees minus 3 VARA (pump.fun accounting) ⇒ ≈ $592 + 200M tokens, ≈ $1,184 at listing.
2. **We build everything, including audit preparation**; external audit still gates mainnet (M6).
3. **Creator first buy: same as pump.fun** — same transaction, uncapped, no vesting, publicly labelled.
4. **No leftover / no creator payout at graduation: same as pump.fun, Four.meme, LaunchLab.**

Still open (only you / RivrDEX can decide):
5. **Treasury address and admin multisig** signers; timelock length for address changes.
6. **Legal wrapper** for the 0.5 % protocol fee and ToS entity (needs counsel).
7. **Candles in v1** (M4) or later?
8. **Busy-lock v1**: accept `TradeInProgress` retries on hot launches for v1? (Default: yes.)
9. **Ask to RivrDEX**: a creator revenue share on graduated pools (pump.fun pays creators 0.05–0.95 % of post-graduation volume; RivrDEX has no hook today). Also: publish testnet Factory/Pair/wVARA ids.
10. **Curve fee 1 % (0.5/0.5) vs pump.fun's 1.25 % (0.95 protocol / 0.30 creator)**: the PDF's split stands unless you want to match pump.fun.

## 9. Grounding and verification record

Skeptic pool: 2× Opus + 1× Sonnet (cross-tier; version axis unavailable). ≥2 of 3 refute ⇒ struck.

| Claim | Verdict | Tier | Notes |
|---|---|---|---|
| C1 RivrDEX interface (a–f) | SURVIVES 3/3 | **verified** (sources re-opened: vara-amm `factory/app/src/lib.rs:6,92`, `pair/app/src/services/pair/funcs.rs:46-161`, `pair/app/src/lib.rs`, `amm_math.rs:4`, `contracts/Cargo.toml`, rivrdex.io/docs/features/creating-pairs, RivrDEX frontend `consts.ts` `MIN_FIRST_LIQUIDITY_USD`) | Caveats folded: `gas_for_full_tx`, lock, sorted order, pausable LP, errors panic, deadline in ms; wVARA id is **supported** (docs only) |
| C2 VFT roles (a, c, d, e, f) | SURVIVES 3/3 | **verified** (`extended_vft/mod.rs:71-73,130-136,183-187,203-214`, `funcs.rs:21,49-60`, `vft/mod.rs:70-72`, `meme-factory/service.rs:163-170`) | (b) "mint becomes a no-op forever" **struck** 3/3: it panics `MaxSupplyReached`; burn lowers total supply; renounce order fixed |
| C3 toolchain (a, b, d) | SURVIVES 3/3 | **verified** (sails-js-parser 0.5.1 run on 0.10.2 IDLs and on a `!@sails: 2.0.0` IDL; crates.io; npm peer deps; both Cargo.toml) | "IDL v2 at 2.0.0" corrected to 1.0.0; (c) "gstd 1.4.2 builds run on spec 11000" is **supported** (inferred from live deployments) |
| C4 curve arithmetic | SURVIVES 3/3 | **verified** (three independent re-derivations, <1 % error) | FDV figures assume 1B supply |
| Deployed factory ≠ repo source | confirmed by 2 skeptics | **verified** (IDL diff) | |
| `utility.batchAll` on Vara mainnet | confirmed by critic from live metadata | **verified** | |
| VARA price $0.000582 | CoinGecko API + page, 2026-10-19 | **verified** | volatile |
| N1–N5 runtime semantics | round-2 skeptic | see §9.1 | |

### 9.1 Round-2 (new claims introduced by the critique; 1× Opus skeptic against gear-tech/gear master f176a80 and the v1.10.0 tag)

| Claim | Verdict | Source | Design consequence |
|---|---|---|---|
| N1 gas 0 ⇒ immediate value transfer, no mailbox | PARTIAL: the rule is `gas_limit ≥ MailboxThreshold (3000)` ⇒ mailbox; below that (incl. 0) ⇒ immediate transfer; `send_bytes` without explicit gas usually mailboxes; expired mailbox value goes to the **user** | `vara/pallets/gear/src/internal.rs:910-1125,589`; `vara/runtime/vara/src/lib.rs:1184` | All value-outs use `send_with_gas(.., gas 0, value)` — **verified** |
| N2 trap returns attached value | PARTIAL: true only on a first-run trap (`dispatch.context().is_none()`); a panic **after an await** keeps the value in the program and the error reply carries 0; normal completion keeps value | `protocol/processor/src/processing.rs:290-352,575` | Reject-with-panic only before any await; every post-await failure refunds explicitly — **verified** |
| N3 voucher pays attached value | **REFUTED**: "reservation is always made against the user's account … voucher can only be used to pay for gas or transaction fee"; `deposit_value(&who)` vs `deposit_gas(&gas_sponsor)` | `vara/pallets/gear/src/lib.rs:1830-1840` | `Launch` may carry the creator's first buy — **verified** |
| N4 `wait_up_to` timeout; message not cancelled | CONFIRMED; default lock 100 blocks; no cancel API; timeout surfaces only when the waiting message is woken | gstd v1.10.0 `msg/async.rs:46`, `config.rs:78`, `locks.rs:124-135` | `Stuck` + `Reconcile` by balance — **verified** |
| N5 child ED charged to creating program | CONFIRMED (`CurrencyOf::transfer(&program_id, &candidate, ed, KeepAlive)`) | `vara/pallets/gear/src/manager/journal.rs:416-453` | `ops_reserve` precondition — **verified** |
| N6 `utility.batchAll` | CONFIRMED present (`Utility = pallet_utility`, `BaseCallFilter = Everything`) but atomic for enqueueing only | `vara/runtime/vara/src/lib.rs:225,1527` | Approve+Sell ordering is FIFO; failure isolates cleanly — **verified** |

Evidence summary: 13 verified, 2 supported (wVARA id; gstd 1.4.2 on spec 11000), 0 unverified, 2 contradicted-and-struck ("mint no-op forever"; "voucher pays value").

### 9.2 Launchpad comparison (research 2026-10-19; one web agent, URLs per fact)

| Platform | Creator buy | Creation fee | Migration fee | Pool share | Creator share | Source |
|---|---|---|---|---|---|---|
| pump.fun | same tx (`create_v2` + `buy_v2`), no cap, no vesting | 0 (app adds 0.45 % on first buy) | 0.015 SOL from the raise (was 6 SOL, then 0) | all raised SOL + ~206.9M tokens (20.7 %), LP burned | 0.30 % on curve; 0.05–0.95 % on PumpSwap by mcap tier | pump-public-docs `COIN_CREATION.md`, `PUMP_PROGRAM_README.md`, `SYNTHETIC_MIGRATION.md`; pump.fun/docs/fees (2026-10-17) |
| Raydium LaunchLab / Bonk.fun | optional initial buy, no cap stated; optional vesting | ~0.1–1 SOL rent | not stated | all SOL + remaining supply (51–80 % on curve); LP burn/lock split | ≤ 0.50 % curve | docs.raydium.io (launchlab, bonding-curve, platform-config, creator-fees) |
| Four.meme | pre-buy in launch tx, no limit stated | ~0.005 BNB gas | not stated | all raised BNB + 20 % supply, LP burned | not documented | four-meme.gitbook.io how-it-works; chaincatcher 2025-04-01 |
| Moonit (ex-Moonshot) | 40 % vault option, vested | not stated | 2 SOL (legacy) | 88 SOL + 200M, LP locked/burned; 2 SOL creator bonus (Raydium route) | 80 % of Meteora LP fees | docs.moon.it, docs.moonshot.cc/faq |
| Clanker v4 | dev buy, no cap | not stated | n/a (no curve) | full supply single-sided v4 LP, locked | 80–100 % of 1–3 % fee | paragraph.com/@dish/introducing-clanker-v4; clanker.gitbook.io |
| **Tokenator 2.0** | same tx, no cap, labelled | 0 (gas sponsored) | 3 VARA ops | all net raise + 200M, LP burned | 0.5 % curve; none post-graduation (RivrDEX ask) | this doc |

Could not verify: pump.fun UI "dev holds X %" labelling; LaunchLab migration fee; Four.meme creator share; Moonit current dev-buy rules.

Sources: rivrdex.io/docs (protocol/smart-contracts, protocol/fee-structure, features/creating-pairs); github.com/gear-foundation/vara-amm (master, fetched 2026-10-19); wiki.vara.network/docs/vara-network/api/vouchers and examples/Patterns/backend/gasless-voucher-server; crates.io/crates/sails-rs, /gstd; npmjs.com/package/sails-js; github.com/gear-tech/sails releases rs/v1.0.0; github.com/gear-tech/gear releases v2.0.0; github.com/pump-fun/pump-public-docs (PUMP_PROGRAM_README.md); api.coingecko.com simple/price.

## 10. Telemetry

- divergence: 0.72 (evidence 0.86, conclusion 0.50) | threshold 0.30 UNCALIBRATED
- grounding: n/a (no eval fixtures this run)
- models: draft=fable · lenses=default · skeptics=2x-opus+1x-sonnet (cross-tier; version axis unavailable) · round-2 skeptic=1x-opus
- claims: C1 grounded · C2 grounded (b struck) · C3 grounded (c supported) · C4 grounded · N1/N2/N4/N5/N6 grounded · N3 struck · batchAll grounded · wVARA-id supported
- fleet: 9 fan-out + 3 skeptics + 3 critics + 1 round-2 skeptic = 16 agents · token-multiple vs single-pass ≈ 12–15×
- convergence: stopped after critique round 1 + round-2 verification (round 2 added no new design claims beyond N1–N6)

## 11. Changelog

- v3 → as-built (2026-10-19 ship run): graduation gained `AlignPrice` between ApproveWvara and AddLiquidity (a pre-seeded pair is swapped back to the curve's final price before our deposit; leftover tokens go to `LP_DEAD`), AddLiquidity resumes from a reserve snapshot, the pair-creation fee is paid from the operating reserve until Settle, a per-creator `launch_cooldown_blocks` bounds reserve drain from sponsored launches, names are printable ASCII. The VFT used for curve tokens is a sails-rs 0.10.2 port of `contracts/fungible-token` (the 1.4.2 build no longer compiles). Details: `docs/audit/findings.md`.

- v2 → v3: decisions applied (PDF $600 raise; we build + audit prep; creator buy and graduation accounting copied from pump.fun/peers). Curve re-parameterised so the pool receives the full net raise minus 3 VARA (a = 267.9M, t0 = 1,067.9M, v0 = $198.9; pool ≈ $1,184 at listing, 18 % headroom); leftover/creator-bonus removed; creator-buy cap removed and replaced by UI disclosure; post-graduation creator share recorded as a RivrDEX ask; M6 expanded to include our audit package; §8 split into decided vs open; §9.2 launchpad comparison added with sources.

- v1 → v2: folded 4 skeptic caveat sets (renounce order, AddLiquidity gas/lock/order, LP pausable, IDL v2 attribution) and 43 critique items: per-launch busy lock + `sold`-derived state (replaces free interleaving), fees accrued post-reply, timeout → `Stuck` + `Reconcile`, `pending_payouts` for dust sells, value-reject-by-panic pre-await only, explicit refunds on every post-await failure, name reserved pre-await, creator first buy carried on `Launch` (voucher pays gas only), ops reserve for child ED, per-launch address snapshot, one step per `Graduate()`, pre-seeded-pair handling, per-step `Unwind`/`Aborted`, `Ready` timeout, program-wide solvency invariant, `Launched` carries metadata and the indexer creates `Coin`, `excludedHolders`, candles in handlers, save ordering, milestone reorder (M2 includes testnet deploy; M4 before M3b), `min-h` header fix, tables on `TableLayout`, states row, citation nits, copy softening. Struck: "mint no-op forever", "voucher pays attached value". Open risk: RivrDEX mainnet bytecode vs master unverified until M0; a program as LP recipient untested on-chain until M0.
