#!/usr/bin/env sh
# Build the bench program for SBPF v0 and v3, then run the LiteSVM benchmark.
#   solana/bench/run.sh                  build + test (Linux/WSL: LiteSVM's secp256r1 precompile builds OpenSSL)
#   SKIP_TEST=1 solana/bench/run.sh      build only (works on Windows too)
#   SKIP_BUILD=1 solana/bench/run.sh     test only, with .so files built elsewhere
set -e
cd "$(dirname "$0")"
if [ -z "$SKIP_BUILD" ]; then
  for arch in v0 v3; do
    cargo build-sbf --arch "$arch"
    mkdir -p "target/deploy/$arch" && cp target/deploy/dnssec_bench.so "target/deploy/$arch/"
  done
fi
if [ -z "$SKIP_TEST" ]; then
  # Separate host target dir so Windows and WSL builds never share artifacts.
  CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-target/host-$(uname -s)}" cargo test -- --nocapture --test-threads 1
fi
