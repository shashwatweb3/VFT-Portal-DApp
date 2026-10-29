# Tokenator devnet scripts

Local `gear --dev --tmp` only (no testnet by decision). Deploys the RivrDEX Factory/Pair code, a wVARA stand-in (awesome-sails test app), the ported Tokenator VFT code and the launchpad, then runs the Curve Launch flow end to end.

```
gear --dev --tmp --rpc-port 9944 --rpc-cors all   # in another terminal
pnpm install
pnpm deploy          # writes deployed.json and ../frontend/.env.local
pnpm smoke           # launch -> buys -> graduate -> asserts pool/LP/roles
pnpm keeper          # loops Graduate on Ready/Failed launches (M5)
```
`wasm/` is populated from `contracts/launchpad/target/wasm32-gear/release` and `contracts/launchpad/tests-wasm`.
