---
id: CANCELSAFETY-007
bug_class: cancel-safety
title: Launch reserves name and cooldown before spawn await; trap after await strands creator value and leaves name reserved with no launch
location: contracts/launchpad/launchpad/app/src/service.rs:385
function: launch
confidence: Low
worker: worker-11
fp_verdict: LIKELY_TP
fp_rationale: "Verified name/cooldown reserved before spawn await with rollback only in continuation; gas-starved Launch mainly harms the caller (own value/name), orphans a VFT and spends reserve ED"
severity: LOW
attack_vector: Remote
exploitability: Reliable
severity_rationale: "Self-inflicted value loss plus name squatting and orphaned VFT; negligible third-party impact"
---

## Description
`launch` adds `name_key` to `st.names` and records `last_launch_by_creator` before awaiting the VFT program-creation reply. The rollback (remove name, remove cooldown, refund `value`) and the insertion of the `Launch` record are both in the continuation. The continuation may not complete, either because too little gas is left after `gas_for_vft_init` and the reply deposit are deducted, or because the message is evicted from the waitlist. In that case:
- the name stays reserved forever with no launch record;
- the spawned VFT (launchpad as admin, full supply minted) is orphaned;
- the attached first-buy VARA is no longer refunded (Gear refunds value only on a trap before the first await) and is not tracked in `total_liabilities`.

## Code
```rust
// service.rs:360, 385
st.last_launch_by_creator.insert(creator, now);
...
st.names.insert(name_key.clone());
...
Ok(future) => future.await.map(|(token, _)| token) ...   // continuation may never run
// rollback / Launch insertion only in continuation (service.rs:427-485)
```

## Data flow
- **Source:** caller-chosen gas limit on `Launch`
- **Sink:** `st.names` / `last_launch_by_creator` persisted; the attached value is stranded
- **Validation:** no check on remaining gas

## Reachability trace
`Launch(meta, ..)` → `with_state_mut` (name and cooldown reserved) → `create_program_bytes_with_gas_for_reply` → `.await` → continuation runs out of gas.

## Impact
The harm mostly falls on the creator, who loses the attached value and the name. It also lets a caller reserve names permanently without a tradable launch, and it orphans a VFT. The operating reserve still pays the child program's existential deposit. Low severity; filed because it is another case of state split across an await.

## Mitigations checked
- `launch_cooldown_blocks` limits repeats per creator but not across accounts.
- No minimum-gas check runs before the spawn.

## Recommendation
Check `exec::gas_available()` against the continuation's worst-case cost before reserving the name, or record a pending-launch entry that an expiry path can clean up.
