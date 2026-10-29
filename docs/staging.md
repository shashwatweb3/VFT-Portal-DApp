# Tokenator staging rollout (`stg.tokenator.club`)

Status: prepared on local branch `staging` (main + PR #42). Nothing here has been pushed,
deployed, or applied to production.

## 1. Current production setup (verified 2026-10-29)

| Piece | Where | Notes |
| --- | --- | --- |
| Frontend | Vercel project `tokenator` (`prj_AnReUoRNIv2UyzavUjpC9iLZht5d`, team `shashwatweb3`) | Root dir `frontend`, Next.js, Node 24. Last production deploy was manual/CLI, no Git connection observed. |
| Frontend env | **none** in the Vercel project | Production values come from the hardcoded fallbacks in `frontend/src/lib/consts.ts` and were inlined at build time. |
| Domain/DNS | `tokenator.club` on Vercel DNS (`ns1/ns2.vercel-dns.com`) | Apex → project `tokenator`; `*` wildcard ALIAS → Vercel. `stg.tokenator.club` resolves via the wildcard but currently returns `DEPLOYMENT_NOT_FOUND` (no project/domain attached). |
| Indexer + Explorer | Railway `explorer-production-ecd5.up.railway.app` → `explorer.tokenator.club` | `POST/GET /graphql` responds 200. Production Postgres lives with this service. |
| pinata-proxy | Railway `pinata-proxy-production.up.railway.app` → `pinata-proxy.tokenator.club` | Production Pinata keys. |
| Contracts | Manual deploys; classic VFT factory `0x729f…` | There is no launchpad deployed. |
| CI | `main` has **no** workflows | The old EKS/k8s workflows exist only on the stale remote `staging` branch and are not the current Vercel/Railway path. Do not use them. |

## 2. Target staging architecture

Keep production projects/branches untouched; add parallel staging resources.

| Piece | Staging resource |
| --- | --- |
| Branch | `staging` = current `main` + PR #42 (fast-forward). Production stays on `main`. |
| Frontend | **New** Vercel project `tokenator-stg`, root `frontend`, Production Branch `staging`, domain `stg.tokenator.club`. |
| DNS | `stg.tokenator.club` is attached to `tokenator-stg` only. `tokenator.club` stays attached to `tokenator`. Vercel creates the specific overriding record; the wildcard remains for everything else. |
| Indexer | New Railway service from `indexer/Dockerfile-indexer`, staging branch, pointed at a **new** Postgres. |
| Explorer | New Railway service from `indexer/Dockerfile-explorer`, same staging Postgres. Expose as `explorer-stg.tokenator.club` (CNAME → Railway) or use the Railway URL. |
| pinata-proxy | New Railway service from `pinata-proxy/Dockerfile`, staging branch. Expose as `pinata-proxy-stg.tokenator.club` or use the Railway URL. |
| voucher-server + keeper | New Railway service from `voucher-server/Dockerfile` (added on this branch), staging branch. |
| Launchpad contract | **Separate** program id with staging admin/treasury/issuer/keeper wallets. Never reuse production keys or the production factory. |
| Classic VFT factory | Reuse factory B `0x729f…` (same address already baked into production) so the classic flow is a real regression test. |

## 3. Environment variables (staging values only)

Never paste these into `main`, the `tokenator` Vercel project, or production Railway services.

### Frontend — Vercel `tokenator-stg`

All `NEXT_PUBLIC_*` values are inlined at **build** time. Changing them requires a new deployment.

| Variable | Staging value |
| --- | --- |
| `NEXT_PUBLIC_NODE_ADDRESS` | `wss://rpc.vara.network` (mainnet; there is no testnet) |
| `NEXT_PUBLIC_CONTRACT_ADDRESS` | `0x729fa6dda815fd49bb4cae215a9904edd3c4d941ed51448eeca94ef2f69fd6a3` (classic factory B) |
| `NEXT_PUBLIC_EXPLORER` | staging explorer GraphQL URL, e.g. `https://explorer-stg.tokenator.club/graphql` |
| `NEXT_PUBLIC_IPFS_UPLOAD_ADDRESS` | staging proxy, e.g. `https://pinata-proxy-stg.tokenator.club/files/upload` |
| `NEXT_PUBLIC_IPFS_GETAWAY` | same Pinata gateway as production |
| `NEXT_PUBLIC_LAUNCHPAD_ADDRESS` | **staging** launchpad program id (must be exactly 66 chars: `0x` + 64 hex). Empty disables all Curve UI. |
| `NEXT_PUBLIC_VOUCHER_API` | staging voucher server URL (optional; empty = creators pay their own gas) |
| `NEXT_PUBLIC_RIVRDEX_APP` | `https://app.rivrdex.io` (link only; there is no staging RivrDEX) |

### Indexer — Railway staging

| Variable | Staging value |
| --- | --- |
| `DB_URL` (or `DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASS`) | **staging** Postgres only |
| `STATE_SCHEMA` | `memecoin_processor_stg` (must differ from production) |
| `RPC_ENDPOINT` | same mainnet archive RPC as production |
| `FACTORY_PROGRAM` | `0x729fa6dda815fd49bb4cae215a9904edd3c4d941ed51448eeca94ef2f69fd6a3` |
| `MIN_BLOCK_NUMBER` | recent block, not genesis (fresh DB + full reindex is expensive) |
| `RATE_LIMIT` | same as production |
| `DNS_API_URL` / `DNS_PROGRAM_NAME` | same as production |
| `LAUNCHPAD_PROGRAM` | staging launchpad program id |

### Explorer — Railway staging

`DB_URL` (staging Postgres), `GQL_PORT`, and the usual squid GraphQL server settings.

### pinata-proxy — Railway staging

| Variable | Staging value |
| --- | --- |
| `PINATA_API_KEY` / `PINATA_SECRET_API_KEY` | separate keys preferred |
| `ALLOWED_ORIGINS` | `https://stg.tokenator.club,http://localhost:3000` |
| `UPLOADS_PER_IP_PER_HOUR` | `20` |
| `TRUST_PROXY_HOPS` | `1` behind Railway's proxy (verify `req.ip` first) |
| `PORT` | `3000` |

### voucher-server / keeper — Railway staging

| Variable | Staging value |
| --- | --- |
| `NODE_ADDRESS` | `wss://rpc.vara.network` |
| `LAUNCHPAD_ADDRESS` | staging launchpad program id |
| `ISSUER_SEED` | **new** staging wallet, small balance |
| `KEEPER_SEED` | **new** staging wallet, different from issuer, small balance |
| `ALLOWED_ORIGINS` | `https://stg.tokenator.club` |
| `STATE_FILE` | `/data/voucher-state.json` with a persistent Railway volume mounted at `/data` |
| `PORT` | `4010` |
| `TRUST_PROXY` | `true` behind Railway's proxy |
| `LAUNCH_GAS`, `VOUCHER_DURATION_BLOCKS`, `RATE_LIMIT_HOURS`, `KEEPER_INTERVAL_MS`, `PER_IP_PER_HOUR`, `GLOBAL_PER_HOUR`, `ISSUER_FLOOR_VARA` | copy from `voucher-server/.env.example` |

### Contracts — staging launchpad

Deploy with `contracts/launchpad` config: staging `treasury` and admin, `vft_code_id`
(uploaded `tokenator_vft.opt.wasm` or the live factory code id), mainnet `rivr_factory`,
mainnet `wvara`, `lp_dead = 0x0101…01`, plus the runbook values in
`docs/audit/runbook.md`. Record the program id; it goes into `LAUNCHPAD_PROGRAM` and
`NEXT_PUBLIC_LAUNCHPAD_ADDRESS`.

## 4. Deployment order (staging)

1. **Branch** — `staging` exists locally (main + PR #42 fast-forward). Push and protect it
   only after approval. Do not merge PR #42 into `main`.
2. **Contracts** — external audit sign-off first. Build and hash-check, upload the VFT code,
   deploy the launchpad, `TopUpReserve`, `SetAdmin` to the staging multisig. Record ids.
3. **Indexer + explorer** — create staging Postgres, deploy indexer so migration
   `1792413001821-Data.js` runs on the staging DB only, then explorer. Verify the new
   `curveLaunch`/`curveTrade`/`curveCandle` queries and `coin.kind`.
4. **voucher-server / keeper** — deploy with the staging wallets and volume. Confirm it sees
   the staging launchpad and that only `https://stg.tokenator.club` gets CORS.
5. **pinata-proxy** — deploy staging; confirm browser uploads from `stg` work.
6. **Frontend** — create Vercel `tokenator-stg`, set the env above, deploy from `staging`,
   attach `stg.tokenator.club`, verify production project/domain are unchanged.

Indexer must be live before the frontend is pointed at it; the frontend reads the new fields.

## 5. Build commands

```bash
# Contracts (68 tests; wasm hashes)
cd contracts/launchpad
cargo test
./scripts/wasm-hashes.sh --check

# Indexer
cd indexer
npm ci
npm run build
npm run migrations:apply   # staging DB only
npm start

# voucher-server
cd voucher-server
pnpm install
pnpm typecheck
pnpm test

# Frontend (no Curve, production-like)
cd frontend
pnpm install                # applies patches/@gear-js__react-hooks@0.19.1.patch
NEXT_PUBLIC_LAUNCHPAD_ADDRESS= pnpm build

# Frontend (Curve enabled — use the real staging address, 66 chars)
NEXT_PUBLIC_LAUNCHPAD_ADDRESS=0x… NEXT_PUBLIC_VOUCHER_API=https://… pnpm build

# Devnet full lifecycle (local gear --dev --tmp only)
cd devnet
pnpm install && pnpm deploy && pnpm smoke
```

## 6. Smoke tests

Classic flow (must be unchanged):
1. Load `stg.tokenator.club`; create a VFT through the classic form (factory B).
2. Confirm the token appears in the staging explorer and the image upload went through the staging proxy.
3. Confirm the same token is **not** written to the production explorer.

Curve flow:
1. Launch a token on the staging launchpad with a small raise target; confirm progress/quote.
2. Buy and sell; confirm `curveTrade`, candles and `coin.kind` in staging explorer.
3. Let the keeper graduate it; verify RivrDEX pair, LP burned, VFT roles renounced.
4. Claim creator fees; check the `curveLaunch` status transitions.
5. Repeat with `NEXT_PUBLIC_LAUNCHPAD_ADDRESS` empty in a preview build: all Curve surfaces must disappear and classic creation must still work.

Production regression:
1. `https://tokenator.club` still returns 200 and serves the previous bundle.
2. `https://explorer.tokenator.club/graphql` still 200.
3. `https://pinata-proxy.tokenator.club` upload still works.

## 7. Manual steps still requiring dashboard/approval

- **GitHub:** push the local `staging` branch (do not force-push the old divergent remote
  `staging`), protect it, keep `main` as the production branch.
- **Vercel:** create `tokenator-stg` (root `frontend`, Node 24), set staging env vars, add
  `stg.tokenator.club`; leave `tokenator` and `tokenator.club` untouched.
- **Vercel DNS:** optional CNAMEs `explorer-stg` / `pinata-proxy-stg` → Railway targets.
- **Railway:** create the staging environment, Postgres, and the four services; set vars and
  a volume for the voucher state. Ensure production services track `main` only.
- **Pinata:** create staging API keys (or consciously reuse production keys).
- **Wallets:** create and fund staging admin/treasury/issuer/keeper; store seeds only in the
  Railway secret store.
- **Contracts:** external audit sign-off, mainnet deploy, `TopUpReserve`, `SetAdmin`.

## 8. Risks

- **Real funds:** the launchpad is mainnet-only by decision. Staging trades/graduation use real
  VARA and the real RivrDEX factory. Keep staging targets and wallet balances small, use
  separate keys, and require explicit sign-off.
- **Build-time env:** `NEXT_PUBLIC_*` cannot be changed by restarting; each change needs a rebuild.
- **DNS:** the `*` wildcard already resolves to Vercel. Attach `stg` only to `tokenator-stg`;
  attaching it to `tokenator` would serve production there.
- **Accidental prod rollout:** keep PR #42 off `main`. Ensure Vercel `tokenator` has no Git
  branch that points at `staging`, and Railway production services do not watch `staging`.
- **Migrations:** `1792413001821` is additive but performs `ALTER TABLE coin`. Run it only on
  the staging database.
- **pinata-proxy:** the PR replaces permissive CORS with an allowlist and adds rate limits.
  Shipping it to production without the production origin would break uploads; test on staging.
- **Keeper:** without it, filled curves stay stuck. Run it in staging or trigger graduation
  manually.
- **Legacy k8s:** the old `staging` branch workflows deploy `tokenator-stg` to EKS and assume
  DNS points at an ingress. They conflict with the Vercel DNS setup; do not enable them.
- **Docker path:** the PR's frontend Dockerfile did not pass the three new `NEXT_PUBLIC_*`
  args; that is patched on this branch so Curve is not silently disabled in a container build.

## 9. What was changed on this branch

- Created local `staging` from `origin/main` and fast-forwarded to PR #42 (`839d414`).
- `frontend/Dockerfile`: added `NEXT_PUBLIC_LAUNCHPAD_ADDRESS`, `NEXT_PUBLIC_VOUCHER_API`,
  `NEXT_PUBLIC_RIVRDEX_APP` build args (empty defaults, production-safe).
- Added `voucher-server/Dockerfile` so the keeper/voucher service can be deployed as a
  container (it previously had none).
- Added this runbook.

Not done (requires approval/dashboard): pushed branch, Vercel project/domain/env, Railway
resources, DNS, wallet creation/funding, contract deploy, any production change.
