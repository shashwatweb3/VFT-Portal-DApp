---
id: ASSERTREACH-001
bug_class: assertion-reachable
title: curve_params_for panics after the spawn await in launch (zero-value path never pre-validates config)
location: contracts/launchpad/launchpad/app/src/service.rs:439
function: launch
confidence: Low
worker: worker-2
fp_verdict: LIKELY_TP
fp_rationale: "Verified: curve_params_for (panic! / unchecked sub) runs after the spawn await at service.rs:439 and is pre-validated only when value != 0; triggers only under inconsistent admin config"
severity: LOW
attack_vector: Remote
exploitability: Theoretical
severity_rationale: "Requires admin misconfiguration (raise target net below graduation fee); impact is burned names, orphaned VFTs and reserve ED drain"
---

## Description
`launch` says "Nothing may panic after the spawn await". However, it calls
`curve_params_for(&config)` after `create_program_bytes_with_gas_for_reply(...).await`.
`curve_params_for` contains `panic!("RaiseBelowGraduationFee")` (line 243),
`panic!("CurveParams")` (line 251), an unchecked `config.total_supply - config.curve_supply`
(line 244), and `split_fee` multiplications. The only pre-await validation is the call at line
378, which runs only when `value != 0`. For a zero-value launch, nothing checks the config before
the await.

`set_raise_target`, `set_fees` and `set_limits` do not cross-validate raise target, graduation
fee and supply. Example: `set_raise_target` to a value whose net is below `graduation_fee_vara`.
With such a config, every zero-value `launch` panics after the spawn. The pre-await state stays
committed:
- `names` keeps the name, which is then permanently reserved
- `last_launch_by_creator` is set
- the VFT child is spawned and its existential deposit is spent from the reserve

No `Launch` record is created.

## Code
```rust
let spawned = match ProgramGenerator::create_program_bytes_with_gas_for_reply(...) {
    Ok(future) => match future.up_to(Some(gas.reply_timeout)) {
        Ok(future) => future.await ...                 // await
...
let (params, pool_vara_target, pool_tokens) = curve_params_for(&config);   // line 439: may panic
```
```rust
fn curve_params_for(config: &Config) -> (curve::CurveParams, u128, U256) {
    let net = curve::split_fee(config.raise_target_vara, ...).net;
    let pool_vara = net.checked_sub(config.graduation_fee_vara)
        .unwrap_or_else(|| panic!("RaiseBelowGraduationFee"));
    let pool_tokens = config.total_supply - config.curve_supply;
    let params = curve::derive_params(...).unwrap_or_else(|| panic!("CurveParams"));
```

## Data flow
- **Source:** admin config (raise target, fees, supplies), and any zero-value `launch` call from any user.
- **Sink:** `panic!` in `curve_params_for`, reached after the spawn await.
- **Validation:** only when `value != 0` (line 378).

## Reachability trace
admin sets an inconsistent raise target → any user calls `launch(meta, ..)` with no value → spawn await → `curve_params_for` panics.

## Impact
Each call permanently burns the requested name and orphans a spawned VFT, leaving an initial supply
minted to the launchpad with no curve. It also drains the operating reserve by the child's
existential deposit. This depends on admin misconfiguration.

## Mitigations checked
- The line 378 pre-check covers only the value-carrying path.
- The admin setters do not validate config consistency.

## Recommendation
Call `curve_params_for` (or a non-panicking `try_curve_params`) before the await on every path, and
validate config consistency in the admin setters. After the await, handle failure by rolling back
the name and cooldown and returning an error.
