# Contributing to TYPE/262

TYPE/262 switches on the DNS `WALLET` record (RRTYPE 262), so every domain is a wallet.
Anyone, person or AI agent, can resolve a domain, verify its address and pay it in SOL or USDC on Solana, or in USDG or ETH on Robinhood Chain.
Solana is the main network; Robinhood Chain is also supported.
Domains that haven't published yet can be paid through their own vault on Solana or an escrow on Robinhood Chain, and pump.fun coins can send their creator fees to a domain.

Thanks for helping build it. This guide covers the layout, setup, tests, builds, conventions and how to send a change.
The full documentation lives in [`docs.html`](https://type262.onrender.com/docs.html).

## Contents

- [Repository layout](#repository-layout)
- [Prerequisites](#prerequisites)
- [Set up](#set-up)
- [Run the site locally](#run-the-site-locally)
- [Tests](#tests)
- [Builds](#builds)
- [Code style](#code-style)
- [Commits and pull requests](#commits-and-pull-requests)
- [Documentation](#documentation)
- [Security](#security)
- [License](#license)

## Repository layout

| Path | What it is |
|---|---|
| `index.html` | Landing page with a live resolver and a live adoption scan |
| `app.html` | The app: Resolve, Pay, Escrow, Publish, Verify, Badge and Launch, on Solana or Robinhood Chain |
| `board.html`, `domain.html` | The Unclaimed Board (`/board`) and domain profiles (`/d/<domain>`), read from Robinhood Chain |
| `docs.html` | The full documentation, with `assets/docs.js` and `assets/docs.css` |
| `lib/wallet262.js` | The zero-dependency SDK for browsers and Node 18+, and the package's main export |
| `bin/type262.mjs` | The `type262` CLI |
| `mcp/src/server.mjs` | The MCP server for AI agents, which pays on Robinhood Chain (source) |
| `mcp/type262-mcp.mjs` | The MCP server as one self-contained file, built by `npm run mcp:build` |
| `upload/server.mjs` | The worker: Solana vault addresses, claims, collects and refunds under `/solana/` (`worker.mjs`, with the rules in `vault.mjs` and the transactions in `chain.mjs` and `pump.mjs`); image and coin-metadata uploads for the Launch form (IPFS through Pinata); and the read-only RPC fallbacks for both chains. Zero dependencies |
| `assets/` | Page scripts, styles and artwork. `config.js` holds the deployed addresses and the board's first block, `dnssec.js` builds Robinhood Chain claim proofs, `vendor/` is a pinned copy of dnsprovejs 1.0.1 |
| `assets/solana.js` | The Solana client: base58, token accounts, transactions, RPC and Wallet Standard wallets |
| `assets/solana-vault.js` | The vault client: the worker's API, reads of a vault and its history, and pump.fun launches and collects sent from the user's wallet |
| `assets/solana-proof.js`, `assets/solana-type262.js` | Clients for the on-chain program: DNSSEC proofs for it, and its instructions and account readers |
| `assets/solana-escrow.js`, `assets/solana-launch.js` | The Escrow and Launch screens on Solana |
| `solana/programs/type262/` | The on-chain Solana program, built and tested, not deployed: escrow, on-chain DNSSEC verifier and pump.fun launcher (Anchor) |
| `solana/tests-rs/` | The program's LiteSVM tests, in their own Cargo workspace |
| `solana/docs/` | `DNSSEC.md` and `PUMP.md`, the specifications the program implements |
| `solana/bench/`, `solana/scripts/` | DNSSEC benchmarks and real-proof fixtures; pump.fun fixtures, encoders (`pump-lib.mjs`, `pump-ix.mjs`) and simulations; the local validator and the end-to-end runs |
| `contracts/src/` | The Robinhood Chain contracts: `DomainEscrow`, `DnssecVerifier`, `DomainLauncher`, `DomainFeeForwarder`, `IDomainVerifier` and the pons interfaces |
| `contracts/script/` | `Deploy.s.sol`, `Oracle.sol`, `deploy-robinhood.sh`, `make-proof.mjs` and `save-deployment.mjs` |
| `contracts/test/` | Foundry unit tests, fuzz tests and Robinhood Chain fork simulations |
| `contracts/lib/` | Foundry dependencies, pinned as git submodules |
| `test/` | JavaScript tests, run by `npm test` |
| `scripts/` | `build.sh` (static build) and `post-deploy.mjs` (on-chain checks, writes `assets/config.js`) |
| `deployments/` | `robinhood-4663.json`, the record of the live Robinhood Chain deployment |
| `render.yaml` | Render Blueprint for the site and the worker (`type262-upload`) |
| `DEPLOY.md` | The deployment runbook: the Solana worker first, then the Robinhood Chain contracts |

## Prerequisites

| Tool | Version | Used for |
|---|---|---|
| [Node.js](https://nodejs.org) | 18 or later (CI uses 22); 20.19 or later for proof building | Tests, the CLI, the worker, the MCP server, proof building |
| Rust, the Solana CLI and Anchor | the exact versions in [`solana/README.md`](solana/README.md) | The on-chain program and its LiteSVM tests, and `solana-test-validator` for the end-to-end runs |
| WSL Ubuntu (Windows only) | 24.04 | The local validator and the precompile tests, which don't run natively on Windows |
| [Foundry](https://getfoundry.sh) | stable (`forge`, `cast`, `anvil`) | Contract builds, contract tests, fork tests |
| [Python](https://www.python.org) | 3.x | `npm run dev` serves the site with Python's `http.server` |
| [Git](https://git-scm.com) | any recent | Cloning with submodules |

## Set up

```bash
git clone --recurse-submodules https://github.com/Type262/262.git
cd 262
npm ci
```

`npm ci` installs the two dev dependencies, `viem` and `@ensdomains/dnsprovejs`.
Tests, the proof script and the MCP build use them. The site, the SDK and the worker need nothing installed.

Cloned without `--recurse-submodules`? Fetch the contract libraries with:

```bash
git submodule update --init --recursive
```

## Run the site locally

```bash
npm run dev
```

Open [http://127.0.0.1:5262](http://127.0.0.1:5262).

| Page | Local URL |
|---|---|
| Landing page | `/` |
| App | `/app.html` (tools take a domain in the hash, e.g. `/app.html#resolve/yoursite.com`) |
| Docs | `/docs.html` |
| The Unclaimed Board | `/board.html` |
| A domain profile | `/domain.html?d=yoursite.com` |

The clean URLs `/board` and `/d/<domain>` are rewrites on the host (see `render.yaml`), so use the `.html` paths locally.
Pages load native ES modules and must be served over HTTP. Opening the files directly won't work.

The app reads the live worker and contracts by default. `assets/config.js` is its only configuration; see [Self-hosting](https://type262.onrender.com/docs.html#self-hosting).

### The worker (optional)

`upload/server.mjs` is the worker: the Solana vault endpoints, the Launch form's image and metadata uploads to IPFS through Pinata, and the RPC fallbacks.

```bash
PINATA_JWT=your-pinata-jwt ALLOW_ORIGINS=http://127.0.0.1:5262 npm run upload:dev
```

Then add `export const UPLOAD_URL = 'http://127.0.0.1:8787'` to `assets/config.js` for your session, and leave it out of commits.
A pump.fun launch needs the service to pin the coin's metadata; without it, the Robinhood Chain form takes an image link instead.

The `/solana/` endpoints also need `VAULT_MASTER_SEED`, 32 bytes as 64 hex characters. For local work, generate a throwaway one in your own shell (for example `VAULT_MASTER_SEED=$(openssl rand -hex 32)`), point the worker at a local validator, and never use it, or the vaults it derives, on mainnet.
Never commit a master secret, never paste one into an issue or chat, and never log one or anything derived from it.

## Tests

### JavaScript

```bash
npm test
```

| File | What it checks |
|---|---|
| `test/wallet262.test.mjs` | SDK: WALLET RDATA encoding and parsing, `_wallet` TXT forms, domain normalization for URLs, emails and IDNs, address kinds, USDG calldata, EIP-681 links, `parseUnits` precision, x402 `payTo` extraction, and, against mocked DNS, the `resolveWalletsUp` walk-up rules, `nxdomain` and `verified` across resolvers, CNAME answers, and every `verifyPayTo` reason |
| `test/abi.test.mjs` | The app's hand-written ABI coder in `assets/abi.js` matches viem byte for byte |
| `test/vault.test.mjs` | The vault rules in `upload/vault.mjs`: key derivation, canonical domains, the fee, what DNS must say, which addresses can be paid, what counts as a deposit, and memos |
| `test/vault-worker.test.mjs` | The vault worker in `upload/worker.mjs` against a mocked Solana RPC and stub DNS: every transaction it sends, the lock, gas checks, refund rules, retries and priority fees |
| `test/chain-data.test.mjs` | The board and profile event decoders in `assets/chain-data.js` match viem, then one read-only call to the live escrow |
| `test/upload.test.mjs` | The upload endpoints against a mock Pinata: health, pinning, CORS and the origin allowlist, content checks, the 5 MB limit, the rate limit |
| `test/mcp.test.mjs` | The bundled MCP server over stdio: protocol, live DNS, dry runs, spending limits, key handling, mock DNS |

`chain-data` and `mcp` make read-only network calls (DNS-over-HTTPS and the Robinhood Chain RPC). The rest run offline.

To also send real payments through the MCP server on a local anvil fork of Robinhood Chain:

```bash
npm run test:mcp:fork
```

It funds fresh throwaway keys on the fork and never sends anything to mainnet. It needs Foundry's `anvil`.

The Solana clients have their own tests, run directly:

```bash
node test/solana.test.mjs          # base58, PDAs, token accounts, byte-exact transactions
node test/solana-vault.test.mjs    # the vault client: pump.fun instructions, launches, the worker API, vault history
node test/solana-proof.test.mjs    # the on-chain program's proofs: six real DNSSEC chains, precompile layouts, the planner
node test/solana-type262.test.mjs  # every on-chain program instruction byte for byte against the IDL and the LiteSVM harness
```

The first two skip their live checks (read-only mainnet RPC and DNS-over-HTTPS) with `OFFLINE=1`.

### The app's Solana screens

`node solana/scripts/ui-e2e.mjs` drives the app's Solana screens in headless Chromium against a local validator in WSL, loaded with the mainnet pump.fun fixtures (`node solana/scripts/fetch-fixtures.mjs` once). The page signs with a mock Wallet Standard wallet holding a throwaway key, its DNS answers come from a stub, and its Solana RPC is routed to the local validator only.
Run it whenever you touch the Solana screens, `assets/solana.js` or the worker's `/solana/` endpoints.

### On-chain Solana program

The `type262` program in `solana/` is built and tested but not deployed; the live Solana flow uses vaults and the worker.

```bash
cd solana
anchor build                                              # the program, its IDL and types
node scripts/fetch-fixtures.mjs                           # once: pump.fun programs and accounts, read from mainnet
cd tests-rs && cargo test                                 # LiteSVM suites, after rebuilding the program
cd .. && cargo test --manifest-path programs/type262/Cargo.toml   # unit tests inside the program
```

| Suite | What it checks |
|---|---|
| `smoke.rs` | Initialization by the upgrade authority only, setting limits, the admin's pause and two-step handover |
| `escrow_sol.rs`, `escrow_token.rs` | Deposits, claims, register, refunds and fees for SOL, SPL Token and Token-2022, to the last unit; stale proofs; canonical names; refused mints and swapped accounts |
| `dnssec_rules.rs`, `dnssec_real.rs` | Every DNSSEC rule on synthetic zones, and real chains from the root for six domains, including tampered proofs and cache expiry |
| `dnssec_precompile.rs` | P-256 and Ed25519 steps through the precompiles (with `--features precompiles`) |
| `launcher_pump.rs`, `launcher_adversarial.rs` | Launches, trades, graduation and collects against the mainnet pump.fun programs, and substituted accounts |
| `review_*.rs` | Attacks on the DNSSEC cache, the RSA check, the precompile binding, the escrow's money paths and collect |

On Windows, `cargo test` runs 78 tests in thirteen suites, and 86 with the precompile tests. The precompile tests need the `precompiles` feature, which builds OpenSSL with a Linux Perl, so on Windows they run in WSL against the program built on Windows:

```bash
# in WSL Ubuntu, from solana/tests-rs in your checkout
CARGO_TARGET_DIR=$PWD/target/wsl TYPE262_SKIP_BUILD=1 RUSTUP_TOOLCHAIN=stable cargo test --features precompiles
```

End to end, `node solana/scripts/e2e-local.mjs` runs the program's client, `assets/solana-type262.js`, against a local `solana-test-validator` loaded with the program and the pump.fun fixtures (in WSL on Windows): deposits, real and synthetic DNSSEC proofs, claims, register, refunds, the pause, fee withdrawal, a pump.fun launch, trades and collect, with exact numbers at every step. It uses throwaway keypairs and stops if it reaches a public cluster. `--keep` leaves the validator running, and `node solana/scripts/e2e-validator.mjs status` or `stop` checks on it.
Run these whenever you touch the program, `assets/solana-type262.js` or `assets/solana-proof.js`.
Never point a test or script at Solana mainnet or devnet with a funded key; every key and master secret the tests use is generated for the run.

### Contracts

```bash
cd contracts
forge build --sizes
forge test
```

`npm run test:contracts` runs the same `forge test` from the repository root.
Without `FORK_RPC`, nothing touches the network: the unit and fuzz tests run against mocks, the simulations are skipped and the real-proof test returns early.

### Fork tests

The fork tests run against Robinhood Chain mainnet state: nine end-to-end simulations against real USDG and the live pons v2 contracts, and a real DNSSEC proof from the root through `.com` to `cloudflare.com`, checked by ENS's oracle with the IANA root keys.
The proof fixture is generated, not committed:

```bash
cd contracts
mkdir -p test/fixtures
node script/make-proof.mjs TXT cloudflare.com > test/fixtures/proof.hex
FORK_RPC=https://rpc.mainnet.chain.robinhood.com forge test --evm-version osaka --match-test "test_(fork|sim)_" -vv
```

Fork tests run with `--evm-version osaka`, because the live pons v2 contracts and the P-256 precompile (EIP-7951) behind DNSSEC algorithm 13 need it.
The deployable contracts compile for `shanghai`, as set in `contracts/foundry.toml`.
Run the fork tests whenever you touch escrow, launch or proof flows.

`make-proof.mjs` builds proofs exactly the way the app does, so it also works for a claim outside the app:
`node contracts/script/make-proof.mjs TXT _wallet.yoursite.com > proof.hex`.

### Continuous integration

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push to `main` and every pull request.

| Job | Steps |
|---|---|
| Site, SDK and MCP | `npm ci`, `node --check` on every source file, `npm test`, `sh scripts/build.sh` and a check of the build output |
| Contracts | A fresh DNSSEC proof fixture, `forge build --sizes`, `forge test`, then the fork tests against Robinhood Chain mainnet |

## Builds

### MCP server bundle

```bash
npm run mcp:build
```

This bundles `mcp/src/server.mjs` with the SDK and viem into one file, `mcp/type262-mcp.mjs`, using esbuild 0.24.0 through `npx`.
It then checks that the bundle keeps its `#!` line and imports nothing outside `node:`.
The bundle is committed. Rebuild and commit it whenever you change `mcp/src/server.mjs` or `lib/wallet262.js`; `test/mcp.test.mjs` warns when a source is newer than the bundle.

### Static site

```bash
sh scripts/build.sh
cd dist && python -m http.server 5262 --bind 127.0.0.1
```

`scripts/build.sh` copies the site into `dist/` and gives every deploy its own asset folder, `v/<commit>` (`v/dev` locally), so a browser or CDN never mixes files from two deploys.
It also publishes stable download paths for `/lib/wallet262.js`, `/bin/type262.mjs` and `/mcp/type262-mcp.mjs`.
The site itself needs no build: `dist/` only exists to version asset paths for the host.

## Code style

`.editorconfig` sets encoding, line endings and indentation for you.

- **Plain ES modules.** No frameworks, no TypeScript, no bundler for the site. Pages load native modules straight from `assets/` and `lib/`.
- **Match the surrounding code.** Two-space indentation, no semicolons, single-quoted strings, and short comments that explain why rather than what.
- **A dependency-free SDK.** `lib/wallet262.js` imports nothing and runs in browsers and Node 18+ with `fetch` and DNS-over-HTTPS JSON. The worker has no dependencies either.
- **No runtime packages in the app.** The app encodes contract calls with its own small ABI coder, checked against viem in `test/abi.test.mjs`, and loads a pinned, vendored copy of dnsprovejs. `viem` and `@ensdomains/dnsprovejs` stay dev dependencies.
- **No new npm dependencies** without agreeing on them in an issue first.
- **Rust.** Anchor 0.31 at the versions pinned in `solana/README.md`, formatted with `cargo fmt --all` (`cargo +stable fmt` in `tests-rs`). Every instruction takes one `<Name>Args` struct defined in its module, and `lib.rs` only delegates. Errors live in one enum with a range per module (shared 6000+, DNSSEC 6100+, escrow 6200+, launcher 6300+): append inside your range and never renumber, because clients match on the numbers. Mirror account and argument changes in the `tests-rs` harness. No admin power over funds.
- **Solidity.** `pragma solidity ^0.8.24`, built with solc 0.8.28, the optimizer at 10,000 runs and EVM version `shanghai`. Four-space indentation, custom errors, NatSpec comments and an MIT SPDX header on every file. No proxies, and no admin power over funds.

## Commits and pull requests

1. **Agree on the approach.** For anything larger than a small fix, open an issue first so the design is settled before the code.
2. **Keep it focused.** One logical change per pull request. Leave unrelated code and formatting alone.
3. **Add a test.** SDK changes go in `test/wallet262.test.mjs`, new app contract calls in `test/abi.test.mjs`, board decoders in `test/chain-data.test.mjs`, MCP tools in `test/mcp.test.mjs`, the worker next to `test/upload.test.mjs`, the Solana client in `test/solana*.test.mjs`, on-chain program changes in `solana/tests-rs/tests/`, and contract changes in `contracts/test/`.
4. **Run the suites.** `npm test` always. The [Solana screens](#the-apps-solana-screens) run for Solana screen or worker changes, the [on-chain program](#on-chain-solana-program) suites for program changes, and `forge test` and the [fork tests](#fork-tests) for contract changes.
5. **Update the docs.** Change `docs.html` when behaviour, commands or addresses change, and add a line to `CHANGELOG.md` under **Unreleased**.
6. **Write clear commits.** A short summary line in the imperative mood, under about 72 characters, optionally prefixed with the area: `Escrow: reject proofs signed before the last claim`. Use the body to explain why when it isn't obvious.
7. **Open the pull request.** Say what changed, why, and how you tested it. The template has a short checklist, and CI must pass.

Never commit a private key, a seed phrase, a master secret such as `VAULT_MASTER_SEED`, an API key such as `PINATA_JWT`, or an `.env` file.

A change to the Solana worker ships as a redeploy of the `type262-upload` service (see [`DEPLOY.md`](DEPLOY.md)); run `npm test` and the end-to-end runs on a local validator first. The on-chain Solana program is not deployed; before any deployment, run the LiteSVM suites, the precompile tests and the end-to-end run on the exact build.
The Robinhood Chain contracts are immutable. A contract change ships as a new deployment through [`DEPLOY.md`](DEPLOY.md), and `scripts/post-deploy.mjs` points the app at it.

## Documentation

| Where | What |
|---|---|
| [`docs.html`](https://type262.onrender.com/docs.html) | The full reference: quickstart, the WALLET record, resolution, SDK, CLI, agents and x402, MCP server, payments, board and profiles, Solana (vaults, claims and refunds, the pump.fun launchpad, the worker API, the on-chain program), the Robinhood Chain contracts, self-hosting, testing, security |
| [`mcp/README.md`](mcp/README.md) | MCP server tools, configuration and limits |
| [`solana/README.md`](solana/README.md) | Building and testing the on-chain Solana program: toolchain, LiteSVM, WSL, the local validator |
| [`solana/docs/`](solana/docs) | `DNSSEC.md` and `PUMP.md`, the specifications and measurements behind the program |
| [`DEPLOY.md`](DEPLOY.md) | Deploying the Solana worker, then the Robinhood Chain contracts, and pointing the app at them |
| [`CHANGELOG.md`](CHANGELOG.md) | Release history |

`docs.html` is the source of truth. When code and docs disagree, fix whichever is wrong in the same pull request.

## Security

Report vulnerabilities privately through [GitHub private vulnerability reporting](https://github.com/Type262/262/security/advisories/new), never in an issue or pull request.
See [`SECURITY.md`](SECURITY.md).

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

TYPE/262 is released under the [MIT License](LICENSE). By contributing, you agree that your contributions are licensed under it.
Third-party code that the project installs or vendors, such as the ENS contracts, forge-std, OpenZeppelin and dnsprovejs, keeps its own license.
