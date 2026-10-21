# TYPE/262 on Solana

> **Built and tested, not deployed.** This on-chain program is complete and covered by the LiteSVM suites and the end-to-end run below, but it is not deployed. The live Solana flow uses vaults instead: every domain has its own Solana address, and the TYPE/262 worker (`upload/server.mjs`) pays it out to the wallet the domain's DNSSEC-signed record names. See [On Solana](https://type262.onrender.com/docs.html#solana) and the [Worker API](https://type262.onrender.com/docs.html#solana-worker). Deploying this program would move the DNSSEC check on-chain, as the contracts already do on Robinhood Chain.

One Anchor program, `type262`, with three parts:

- **dnssec**: verifies DNSSEC on-chain, from the IANA root keys down to the wallet record a domain publishes (`_wallet.<domain>` TXT `"SOL <base58 pubkey>"`, or the WALLET record with coin code `SOL`). Proofs are verified one RRset per step; verified sets are cached in accounts, so later proofs reuse the root and TLD.
- **escrow**: holds SOL and SPL tokens for a domain until its owner claims them with that proof. Same rules as `DomainEscrow` on Robinhood Chain.
- **launcher**: launches pump.fun coins whose creator is a per-domain PDA of this program, so creator fees can only ever reach the domain's escrow pool.

The Robinhood Chain contracts in `../contracts` are unchanged and keep working; this directory is self-contained.

## Documentation

- [On-chain program](https://type262.onrender.com/docs.html#solana-program), in the site's docs: what the program does and how it is tested, next to the live vault flow it would replace. The source is `../docs.html`.
- The program's source, `programs/type262/src`, and its IDL: every instruction with its arguments and accounts, the PDAs and seeds, the events and the errors.
- [`docs/DNSSEC.md`](docs/DNSSEC.md): the DNSSEC rules the program enforces, the account layouts, and the measurements on real proofs.
- [`docs/PUMP.md`](docs/PUMP.md): how the launcher uses pump.fun and PumpSwap, checked against mainnet. The live vault flow uses the same pump.fun instructions, with the domain's vault as the creator, through `scripts/pump-lib.mjs` and `scripts/pump-ix.mjs`.
- `target/idl/type262.json`: the IDL, written by `anchor build`.
- [Testing](https://type262.onrender.com/docs.html#testing-solana): the LiteSVM suites, the precompile tests in WSL and the end-to-end run on a local validator, with the commands below.

## Layout

```
Anchor.toml, Cargo.toml, Cargo.lock    Anchor workspace (the on-chain build)
programs/type262/src/
  lib.rs          entry points; each one only delegates to its module
  admin.rs        initialize, set_deposits_paused, transfer_admin, accept_admin
  dnssec.rs       verify_rrset, verify_rrset_precompiled, write_buffer, verify_rrset_buffered, close_buffer, close_rrset
  escrow.rs       deposit_sol, deposit_token, claim, register, refund, withdraw_fees
  launcher.rs     launch, collect
  state.rs        accounts, with sizes
  constants.rs    fees, refund delay, seeds, DNS numbers, root trust anchors
  errors.rs       one error enum, a code range per module
tests-rs/         LiteSVM tests (their own Cargo workspace)
docs/  scripts/  tests/fixtures/  bench/    pump.fun research, fixture fetching, DNSSEC benchmarks
```

## Prerequisites

These exact versions build and test on Windows 11:

| Tool | Version | Used for |
| --- | --- | --- |
| Rust (rustup), default toolchain | stable 1.90.0 | host builds: Anchor's IDL step, program unit tests |
| Rust toolchain 1.98.1 | pinned by `tests-rs/rust-toolchain.toml` (`rustup toolchain install 1.98.1` if rustup doesn't fetch it itself) | LiteSVM tests |
| Solana CLI (Agave) | 4.1.1, with `cargo-build-sbf` 4.1.0 | SBF build |
| Solana platform tools | v1.54 (rustc 1.89.0-sbpf), installed by `cargo-build-sbf` on first use | SBF build |
| anchor-cli | 0.31.1 (through avm) | `anchor build` |
| anchor-lang / anchor-spl | 0.31.2 (exact pins in `programs/type262/Cargo.toml`) | the program |
| LiteSVM | 0.16.0 (Agave 4.2 runtime) | tests |
| WSL Ubuntu 24.04 with Agave 2.3.0 and Node 22 | | local validator; LiteSVM with precompiles |

The Solana CLI installs to `~/.local/share/solana/stable/bin`. `cargo-build-sbf` is also in `~/.cargo/bin`, so `cargo build-sbf` and `anchor build` work without it on `PATH`; the `solana` and `solana-keygen` commands need it:

```bash
export PATH="$HOME/.local/share/solana/stable/bin:$PATH"
```

## Build

From this directory:

```bash
anchor build                                                   # program, IDL and TS types
cargo build-sbf --manifest-path programs/type262/Cargo.toml    # program only
```

Outputs: `target/deploy/type262.so`, `target/idl/type262.json`, `target/types/type262.ts`. A first build takes about a minute; later ones a few seconds. The build prints one warning, from inside Anchor 0.31's generated code (it calls the deprecated `AccountInfo::realloc`); it can't be silenced from this crate.

## Test

```bash
cd tests-rs && cargo test          # builds the program, then runs every suite in tests-rs/tests
anchor run test                    # the same, through Anchor.toml
cargo test --manifest-path programs/type262/Cargo.toml   # host unit tests inside the program
```

`cargo test` in `tests-rs` runs `cargo build-sbf` first (once per test binary, a few seconds when nothing changed), so the tests always run against the current source. To test the `.so` as it is, set `TYPE262_SKIP_BUILD=1`.

The harness, `tests-rs/src/lib.rs`, does not link against the program crate: it builds instructions the way a client does (Anchor discriminators, borsh-encoded `*Args` structs, PDAs from the same seeds) and keeps borsh mirrors of the accounts and the error codes. When an account or argument changes in the program, change its mirror there. `Env::new()` loads the program as an upgradeable program whose upgrade authority is `env.authority`, as after a real deploy, and sets the clock to a fixed time; `env.warp(secs)` moves it.

Don't use `anchor test` on Windows: it can't start a local validator there (see below), and even with `--skip-local-validator` it exits with `program not found` after the suite passes.

### Precompiles (DNSSEC algorithms 13 and 15)

LiteSVM only loads the secp256r1 and ed25519 precompiles with the `precompiles` feature. That pulls in OpenSSL, built from source by a `perl Configure` that fails under Git for Windows' perl. Run those tests in WSL against the `.so` built on Windows, with a separate target directory:

```bash
# in WSL Ubuntu, from solana/tests-rs in your checkout (under /mnt/<drive>/...)
CARGO_TARGET_DIR=$PWD/target/wsl TYPE262_SKIP_BUILD=1 RUSTUP_TOOLCHAIN=stable cargo test --features precompiles
```

The first run compiles for about 9 minutes (the target directory is on the Windows drive); later runs are incremental. On Windows itself it works once a native OpenSSL is available: install one (for example through vcpkg) and set `OPENSSL_NO_VENDOR=1` and `OPENSSL_DIR`.

## Local validator

`solana-test-validator` doesn't run natively on this Windows setup: it panics creating its log symlink (`os error 1314`, a privilege Windows only grants to administrators or in Developer Mode), and with `--log` it then fails unpacking the genesis archive (`Access is denied`). Run it in WSL, loading the program straight from the Windows build, as an upgradeable program with an upgrade authority of your choice:

```bash
# in WSL Ubuntu, from solana/ in your checkout
solana-keygen new --no-bip39-passphrase --silent --force --outfile /tmp/type262-authority.json
solana-test-validator --ledger target/test-ledger --reset --quiet \
  --upgradeable-program 3fhiMDY5kyCpX47HU1whuEe6vMQFHPa1hwGhc4Pp72NT target/deploy/type262.so \
  "$(solana-keygen pubkey /tmp/type262-authority.json)"
```

Then, from WSL (or from Windows, through WSL's localhost forwarding):

```bash
solana -u http://127.0.0.1:8899 cluster-version
solana -u http://127.0.0.1:8899 program show 3fhiMDY5kyCpX47HU1whuEe6vMQFHPa1hwGhc4Pp72NT
```

Stop it with Ctrl+C (or `pkill -f solana-test-validator`). It is ready about 12 seconds after starting. `initialize` sent to it by that upgrade authority succeeds and uses about 25,000 compute units.

## Program ids

- `declare_id!` in `programs/type262/src/lib.rs` and `[programs.localnet]` in `Anchor.toml` hold a local test id, `3fhiMDY5kyCpX47HU1whuEe6vMQFHPa1hwGhc4Pp72NT`. Its keypair is `target/deploy/type262-keypair.json`, which is gitignored and exists only on the machine that generated it. Nothing needs it: the LiteSVM tests and the local validator load the `.so` at any address without a keypair.
- The program refuses to run at any address but its `declare_id!` (Anchor checks it on every call), so the harness reads the id from `lib.rs` instead of keeping a copy.
- On a fresh clone, `anchor build` creates a new `target/deploy/type262-keypair.json` with a different address. Leave it, or run `anchor keys sync` to adopt it locally; don't commit the resulting id change.
- The mainnet id comes at deployment: generate the program keypair offline, put its address in `declare_id!` and in a `[programs.mainnet]` section, build, deploy, and call `initialize` right away. Only the program's upgrade authority can call `initialize` (it checks the ProgramData account), so nobody can initialize a fresh deployment first. A deployment made immutable before `initialize` can never be initialized.

## Notes for the module authors

- **Entry points.** Every instruction takes `(ctx, args: <Name>Args)`, with the args struct defined in its module, so a module changes its arguments and accounts without touching `lib.rs`. Contexts carry `'info` lifetimes, so `ctx.remaining_accounts` can be passed to CPIs. Handlers share their instruction's name (`escrow::claim`); the glob re-exports in `lib.rs` exist because `#[program]` needs every Accounts struct at the crate root.
- **Errors.** One `Type262Error` enum, because Anchor's IDL keeps only one. Codes are 6000 + the discriminant: shared 6000+, dnssec 6100+, escrow 6200+, launcher 6300+. Append inside your range; mirror new ones in `ERRORS` in the harness.
- **Stubs.** Every instruction is built and tested. `NotImplemented` (6008) stays in the error enum so codes never shift; nothing returns it.
- **Names.** `domain_hash = sha256(canonical name)`; canonical is lowercase a-z, 0-9, `-`, `_`, labels of 1 to 63, at most 253 characters, no trailing dot (the same rule as `DomainEscrow.domainHash`, with sha256 instead of keccak). Instructions take the name and its hash, because Anchor derives PDAs before the handler runs; `escrow::check_domain` ties them together.
- **Seeds** (`constants.rs`): `["config"]`, `["domain", domain_hash]`, `["pool", domain_hash, mint]` (mint = `SOL_MINT`, all zeros, for SOL), `["deposit", pool, depositor]`, `["fees", mint]`, `["buffer", payer]`, `["rrset", sha256(owner name wire), rrtype u16 BE]`, `["creator", domain_hash]`, `["launch", mint]`.
- **Buffers.** The raw bytes start at `Buffer::DATA_OFFSET`, after the 8-byte discriminator, as `[u32 LE length, signed, u32 LE length, sig]`; `write_buffer` writes chunks in any order and `verify_rrset_buffered` reads them in place and closes the buffer. At most `Buffer::MAX_SIZE` (8 KiB) each; accounts created through CPI can't exceed 10 KiB.
- **Formatting.** rustfmt defaults: `cargo fmt --all` here, `cargo +stable fmt` in `tests-rs` (its pinned 1.98.1 toolchain has no rustfmt component).
- **Heap and compute.** The program uses Anchor's default 32 KiB heap. The `custom-heap` feature is declared for a module that needs a larger one (with a `RequestHeapFrame` instruction in the transaction).
