# rust-review run summary

- threat_model: REMOTE · severity_filter: all · finding_scope_root: contracts/launchpad · context_roots: .
- Flags: has_unsafe=false, has_ffi=false, has_concurrency=false, has_async=true, has_packed_repr=false, has_fs_io=true (build.rs only)
- Cargo: workspace at contracts/launchpad/Cargo.toml
- Workers: 15 (model opus), plus a cache primer

| worker | cluster | findings | status |
|---|---|---|---|
| 1 | unsafe-boundary | 0 | complete (coverage file lost in scratchpad wipe) |
| 2 | panic-dos-1 | 4 (ARITHOFL-001/002, ASSERTREACH-001, RESEXHAUST-001) | complete, artifacts intact |
| 3 | panic-dos-2 | 0 | complete (coverage lost) |
| 4 | recursion-dos-1 | 0 | complete (coverage lost) |
| 5 | recursion-dos-2 | 0 | complete (coverage lost) |
| 6 | recursion-dos-3 | 0 | complete (coverage lost) |
| 7 | error-handling-1 | 5 (RESDISC-001..005) | complete, artifacts intact |
| 8 | error-handling-2 | 0 | complete (coverage lost) |
| 9 | logic-correctness-1 | 1 (STRCMP-001, recreated) | complete (coverage lost) |
| 10 | logic-correctness-2 | 0 | complete (coverage lost) |
| 11 | async-runtime | 7 (CANCELSAFETY-001..007) | complete, artifacts intact |
| 12 | static-hygiene | 2 (CARGOLINT-001, MSRV-001, recreated) | complete (coverage lost) |
| 13 | resource-handling | 0 | complete (coverage lost) |
| 14 | input-os-safety | 0 | complete (coverage lost) |
| 15 | info-disclosure | 0 | complete (coverage lost) |

- findings-index.txt: 19 lines, matching the sum of worker claims (4+5+1+7+2 = 19).
- **Partial-run note:** the session scratchpad holding the original output dir was cleared between sessions. Workers 2, 7 and 11 were interrupted, resumed and rewrote their artifacts. The other 12 workers had already returned `complete:`; their coverage files and shards were lost, and the three findings they filed were recreated verbatim from their reports. The output now lives in-repo at docs/audit/runs/rust-review-20261022.
