#!/usr/bin/env bash
# Builds the deployable wasm from clean with the pinned toolchain (rust-toolchain.toml) and
# records its SHA-256 in wasm-hashes.txt. `--check` rebuilds and fails if the hashes differ, so
# anyone can confirm that an uploaded code id comes from this source.
set -euo pipefail
cd "$(dirname "$0")/.."
programs=(launchpad tokenator_vft)
rm -rf target/wasm32-gear
cargo clean --release -p launchpad -p tokenator-vft >/dev/null 2>&1
cargo build --release -p launchpad -p tokenator-vft >/dev/null
out=$(for p in "${programs[@]}"; do
    (cd target/wasm32-gear/release && shasum -a 256 "$p.opt.wasm")
done)
echo "rustc $(rustc --version | cut -d' ' -f2)"
echo "$out"
if [[ "${1:-}" == "--check" ]]; then
    diff <(echo "$out") <(grep -v '^#' wasm-hashes.txt) && echo "hashes match wasm-hashes.txt"
else
    { echo "# sha256 of target/wasm32-gear/release/*.opt.wasm, rustc $(rustc --version | cut -d' ' -f2); regenerate with scripts/wasm-hashes.sh"; echo "$out"; } > wasm-hashes.txt
fi
