# Contributing to TYPE/262

TYPE/262 switches on the DNS `WALLET` record (RRTYPE 262), so every domain is a wallet.
Anyone, person or AI agent, can resolve a domain, verify its address and pay it in USDG or ETH on Robinhood Chain.

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
| `app.html` | The app: Resolve, Pay, Escrow, Publish, Verify, Badge and Launch |
| `docs.html` | The full documentation, with `assets/docs.js` and `assets/docs.css` |
| `lib/wallet262.js` | The zero-dependency SDK for browsers and Node 18+, and the package's main export |
| `bin/type262.mjs` | The `type262` CLI |
| `upload/server.mjs` | The image upload service for the Launch form (Pinata, zero dependencies) |
| `assets/` | Page scripts, styles and artwork. `config.js` holds the deployed addresses, `dnssec.js` builds claim proofs in the browser, `vendor/` is a pinned copy of dnsprovejs 1.0.1 |
| `contracts/src/` | `DomainEscrow`, `DnssecVerifier`, `DomainLauncher`, `DomainFeeForwarder`, `IDomainVerifier` and the pons interfaces |
| `contracts/script/` | `Deploy.s.sol`, `Oracle.sol`, `deploy-robinhood.sh`, `make-proof.mjs` and `save-deployment.mjs` |
| `contracts/test/` | Foundry unit tests, fuzz tests and Robinhood Chain fork simulations |
| `contracts/lib/` | Foundry dependencies, pinned as git submodules |
| `test/` | JavaScript tests, run by `npm test` |
| `scripts/` | `build.sh` (static build) and `post-deploy.mjs` (on-chain checks, writes `assets/config.js`) |
| `deployments/` | `robinhood-4663.json`, the record of the live mainnet deployment |
| `render.yaml` | Render Blueprint for the site and the upload service |
| `DEPLOY.md` | The deployment runbook |

## Prerequisites

| Tool | Version | Used for |
|---|---|---|
| [Node.js](https://nodejs.org) | 18 or later (CI uses 22) | Tests, the CLI, the upload service, proof building |
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
Tests and the proof script use them. The site, the SDK and the upload service need nothing installed.

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

Pages load native ES modules and must be served over HTTP. Opening the files directly won't work.

The app reads the live mainnet contracts by default. `assets/config.js` is its only configuration; see [Self-hosting](https://type262.onrender.com/docs.html#self-hosting).

### Upload service (optional)

The Launch form's **Choose image** button posts to `upload/server.mjs`, which pins images to IPFS through Pinata.

```bash
PINATA_JWT=your-pinata-jwt ALLOW_ORIGINS=http://127.0.0.1:5262 npm run upload:dev
```

Then add `export const UPLOAD_URL = 'http://127.0.0.1:8787'` to `assets/config.js` for your session, and leave it out of commits.
Without the service, the form takes an image link instead.

## Tests

### JavaScript

```bash
npm test
```

| File | What it checks |
|---|---|
| `test/wallet262.test.mjs` | SDK: WALLET RDATA encoding and parsing, `_wallet` TXT forms, domain normalization for URLs, emails and IDNs, address kinds, USDG calldata, EIP-681 links, `parseUnits` precision, x402 `payTo` extraction, `verifyPayTo` against mocked DNS |
| `test/abi.test.mjs` | The app's hand-written ABI coder in `assets/abi.js` matches viem byte for byte |
| `test/upload.test.mjs` | The upload service against a mock Pinata: health, pinning, CORS and the origin allowlist, content checks, the 5 MB limit, the rate limit |

All three run offline.

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
| Site and SDK | `npm ci`, `node --check` on every source file, `npm test`, `sh scripts/build.sh` and a check of the build output |
| Contracts | A fresh DNSSEC proof fixture, `forge build --sizes`, `forge test`, then the fork tests against Robinhood Chain mainnet |

## Builds

### Static site

```bash
sh scripts/build.sh
cd dist && python -m http.server 5262 --bind 127.0.0.1
```

`scripts/build.sh` copies the site into `dist/` and gives every deploy its own asset folder, `v/<commit>` (`v/dev` locally), so a browser or CDN never mixes files from two deploys.
It also publishes stable download paths for `/lib/wallet262.js` and `/bin/type262.mjs`.
The site itself needs no build: `dist/` only exists to version asset paths for the host.

## Code style

`.editorconfig` sets encoding, line endings and indentation for you.

- **Plain ES modules.** No frameworks, no TypeScript, no bundler for the site. Pages load native modules straight from `assets/` and `lib/`.
- **Match the surrounding code.** Two-space indentation, no semicolons, single-quoted strings, and short comments that explain why rather than what.
- **A dependency-free SDK.** `lib/wallet262.js` imports nothing and runs in browsers and Node 18+ with `fetch` and DNS-over-HTTPS JSON. The upload service has no dependencies either.
- **No runtime packages in the app.** The app encodes contract calls with its own small ABI coder, checked against viem in `test/abi.test.mjs`, and loads a pinned, vendored copy of dnsprovejs. `viem` and `@ensdomains/dnsprovejs` stay dev dependencies.
- **No new npm dependencies** without agreeing on them in an issue first.
- **Solidity.** `pragma solidity ^0.8.24`, built with solc 0.8.28, the optimizer at 10,000 runs and EVM version `shanghai`. Four-space indentation, custom errors, NatSpec comments and an MIT SPDX header on every file. No proxies, and no admin power over funds.

## Commits and pull requests

1. **Agree on the approach.** For anything larger than a small fix, open an issue first so the design is settled before the code.
2. **Keep it focused.** One logical change per pull request. Leave unrelated code and formatting alone.
3. **Add a test.** SDK changes go in `test/wallet262.test.mjs`, new app contract calls in `test/abi.test.mjs`, the upload service in `test/upload.test.mjs`, and contract changes in `contracts/test/`.
4. **Run the suites.** `npm test` always. `forge test` and the [fork tests](#fork-tests) for contract changes.
5. **Update the docs.** Change `docs.html` when behaviour, commands or addresses change, and add a line to `CHANGELOG.md` under **Unreleased**.
6. **Write clear commits.** A short summary line in the imperative mood, under about 72 characters, optionally prefixed with the area: `Escrow: reject proofs signed before the last claim`. Use the body to explain why when it isn't obvious.
7. **Open the pull request.** Say what changed, why, and how you tested it. The template has a short checklist, and CI must pass.

Never commit a private key, a seed phrase, an API key such as `PINATA_JWT`, or an `.env` file.

The deployed contracts are immutable. A contract change ships as a new deployment through [`DEPLOY.md`](DEPLOY.md), and `scripts/post-deploy.mjs` points the app at it.

## Documentation

| Where | What |
|---|---|
| [`docs.html`](https://type262.onrender.com/docs.html) | The full reference: quickstart, the WALLET record, resolution, SDK, CLI, agents and x402, payments, escrow, DNSSEC proofs, launchpad, contracts, deployments, self-hosting, testing, security |
| [`DEPLOY.md`](DEPLOY.md) | Deploying the contracts and pointing the app at them |
| [`CHANGELOG.md`](CHANGELOG.md) | Release history |

`docs.html` is the source of truth. When code and docs disagree, fix whichever is wrong in the same pull request.

## Security

Report vulnerabilities privately through [GitHub private vulnerability reporting](https://github.com/Type262/262/security/advisories/new), never in an issue or pull request.
See [`SECURITY.md`](SECURITY.md).

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

TYPE/262 is released under the [MIT License](LICENSE). By contributing, you agree that your contributions are licensed under it.
Third-party code that the project installs or vendors, such as the ENS contracts, forge-std, OpenZeppelin and dnsprovejs, keeps its own license.
