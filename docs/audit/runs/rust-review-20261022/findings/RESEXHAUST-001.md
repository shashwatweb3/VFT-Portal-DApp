---
id: RESEXHAUST-001
bug_class: resource-exhaustion
title: Unbounded growth of launches/launch_order/names/pending_payouts and full-vector `launches` query
location: contracts/launchpad/launchpad/app/src/service.rs:484
function: launch
confidence: Low
worker: worker-2
fp_verdict: LIKELY_TP
fp_rationale: "Verified append-only launches/launch_order/names/pending_payouts and unpaginated launches() query; growth is sybil-driven and costly"
severity: MEDIUM
attack_vector: Remote
exploitability: Difficult
severity_rationale: "Remote DoS requiring large allocation/sybil cost; unpaginated query degrades sooner, memory exhaustion would freeze the whole program"
---

## Description
Several collections are append-only with no global cap:
- every successful `launch` inserts a ~1 KB `Launch` (about 14 U256 fields, `Addrs`, strings, an optional `PendingTrade`) into `launches`
- it pushes to `launch_order`, inserts into `names` and `last_launch_by_creator`
- every deferred dust sell inserts a `(token, trader)` key into `pending_payouts`

The per-creator cooldown can be bypassed with sybil accounts. Gear programs have bounded linear
memory (max 512 wasm pages ≈ 32 MiB), and HashMap rehashing doubles allocation. Enough entries
make allocation fail, and then **every** message traps, including sells and claims, so all
custodied VARA becomes unreachable. Separately, the `launches()` query clones and encodes the
whole `launch_order` Vec with no pagination, so it eventually exceeds the query gas limit and
breaks the frontend and keeper.

## Code
```rust
st.launches.insert(token, launch);
st.launch_order.push(token);        // line 484, never pruned
...
pub fn launches(&self) -> Vec<ActorId> {
    self.with_state(|st| st.launch_order.clone())   // whole vector, no pagination
}
...
*st.pending_payouts.entry((token, pending.trader)).or_default() += amount;  // per sybil, dust sells
```

## Data flow
- **Source:** permissionless `launch` calls from many accounts, and dust `sell` calls (no `min_trade_vara` check on sells) from many accounts.
- **Sink:** `HashMap`/`Vec` growth in the program's persistent memory, and the `launches()` query.
- **Validation:** a per-creator cooldown (sybil-bypassable). `min_free_balance` limits launches while the reserve is low. There is no global cap or pagination.

## Reachability trace
attacker sybils → `launch` (or dust `sell`) repeated → state collections grow → memory limit reached / `launches()` too expensive.

## Impact
Program-wide availability loss, which would freeze all launches' escrow, if memory is exhausted.
More practically, the unpaginated `launches()` query degrades and stops working. Cost to the
attacker is gas per message plus, for launches, reserve-funded existential deposits, so
feasibility depends on economics.

## Mitigations checked
- Launch cooldown is per creator only.
- `min_free_balance` gates launches on reserve, not on state size.
- No pruning of finished or aborted launches.

## Recommendation
Paginate `launches(offset, limit)`. Add a minimum sell size, or require a payout key to have
accrued at least some threshold. Consider a launch fee that covers state cost, and/or pruning of
terminal-state launches.
