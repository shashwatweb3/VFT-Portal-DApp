# Coverage gate — worker-2 (cluster panic-dos-1)

| Pass prefix | Bug class            | Outcome                                      |
|-------------|----------------------|----------------------------------------------|
| RESEXHAUST  | resource-exhaustion  | filed: RESEXHAUST-001                        |
| UNWRAP      | unwrap-on-untrusted  | cleared (unwrap/expect/unwrap_or_else(panic) sites: LaunchNotFound lookups pre-await or in queries, checked_* liability/VFT ops, `.expect("event")` only; no attacker-controlled Option/Result unwrapped post-await) |
| ARITHOFL    | arithmetic-overflow  | filed: ARITHOFL-001, ARITHOFL-002            |
| ASSERTREACH | assertion-reachable  | filed: ASSERTREACH-001                       |
