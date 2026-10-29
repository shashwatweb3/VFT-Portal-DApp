# Coverage gate — worker-11 (cluster async-runtime)

| Pass prefix  | Bug class     | Outcome |
|--------------|---------------|---------|
| ASYNCBLOCK   | async-blocking | cleared (no_std wasm crate; rg found no `std::sync`/`std::fs`/`thread::sleep`/`std::net`/blocking `recv()`/`.lock().unwrap()` in launchpad/app or vft/app; only awaits are gstd reply futures) |
| CANCELSAFETY | cancel-safety | filed: CANCELSAFETY-001, CANCELSAFETY-002, CANCELSAFETY-003, CANCELSAFETY-004, CANCELSAFETY-005, CANCELSAFETY-006, CANCELSAFETY-007 |
| SELECTBIAS   | select-bias   | cleared (no `tokio::select!`/`futures::select!`/`select_biased!`/`join!` in scope) |
