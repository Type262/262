# Security policy

TYPE/262 pays domains by name, so security reports get our full attention.
This page covers what is in scope, how to report privately, what happens next, and how the system is verified.

## Scope

| Component | Where |
|---|---|
| Solana worker | `upload/server.mjs`, `upload/worker.mjs`, `upload/vault.mjs`, `upload/chain.mjs`, `upload/pump.mjs`: vault derivation, the DNS checks before a claim, claims, collects and refunds, and the live service below |
| Solana program | `solana/programs/type262/`: the escrow, the on-chain DNSSEC verifier and the pump.fun launcher, built and tested, not deployed |
| Robinhood Chain contracts | `contracts/src/`: `DomainEscrow`, `DnssecVerifier`, `DomainLauncher`, `DomainFeeForwarder`, and the live deployment below |
| SDK and CLI | `lib/wallet262.js`, `bin/type262.mjs` |
| MCP server | `mcp/src/server.mjs` and the bundle `mcp/type262-mcp.mjs` |
| Web app and pages | `index.html`, `app.html`, `board.html`, `domain.html`, `docs.html` and `assets/`, including in-browser proof building in `assets/dnssec.js` and `assets/solana-proof.js`, and the Solana clients in `assets/solana.js` and `assets/solana-type262.js` |
| Upload endpoints | `upload/server.mjs`: image and metadata pinning, and the RPC fallbacks |
| Deploy and build scripts | `contracts/script/`, `scripts/` |

Upstream code and services belong with their own project: pump.fun and PumpSwap, the Cloudflare and Google DNS-over-HTTPS resolvers, Anchor, the Solana runtime and its precompiles, ENS's DNSSEC oracle, pons v2, OpenZeppelin, forge-std and dnsprovejs.
How TYPE/262 deploys, configures or calls that code is in scope.

The [trust model](https://type262.com/docs.html#security) documents the intended behaviour, such as the worker's custody of Solana vaults, instant claims by whoever controls a DNSSEC-signed zone, the keys pump.fun keeps over its own coins, or pons's timelocked fee-recipient changes.
Reports that the documented model itself is weaker than stated are welcome.

## Deployments

### Solana

Solana runs no TYPE/262 program: vaults are ordinary addresses, held by the worker, and launches use pump.fun's own programs.

| | |
|---|---|
| Worker | `https://type262-upload.onrender.com` (`type262-upload` in `render.yaml`) |
| Gas wallet | [`3sde4YJpX2oYMSWaozHareWrXn6MASLxhQgfuCKJNPoK`](https://solscan.io/account/3sde4YJpX2oYMSWaozHareWrXn6MASLxhQgfuCKJNPoK) |
| Fee wallet | [`3sde4YJpX2oYMSWaozHareWrXn6MASLxhQgfuCKJNPoK`](https://solscan.io/account/3sde4YJpX2oYMSWaozHareWrXn6MASLxhQgfuCKJNPoK) |

The settings, endpoints and checks are listed in [Worker API](https://type262.com/docs.html#solana-worker).

### Robinhood Chain

Robinhood Chain mainnet, chain id 4663, deployed from block 93,920,186.

| Contract | Address |
|---|---|
| `DomainEscrow` | [`0x9fd2f1Dc0B42e8a2E86e3Cf231a293654691E8d5`](https://robinhoodchain.blockscout.com/address/0x9fd2f1Dc0B42e8a2E86e3Cf231a293654691E8d5) |
| `DomainLauncher` | [`0x022657aC8bdD969Fa5149E7A86FBBda2AfAf716F`](https://robinhoodchain.blockscout.com/address/0x022657aC8bdD969Fa5149E7A86FBBda2AfAf716F) |
| `DnssecVerifier` | [`0x2dfB277A25ea096b182F86665D130B9b53B15758`](https://robinhoodchain.blockscout.com/address/0x2dfB277A25ea096b182F86665D130B9b53B15758) |
| `DNSSECImpl` (ENS DNSSEC oracle, no owner) | [`0xB6bDbff51a51Fb8743dAaa115317d9a72fEbDaE1`](https://robinhoodchain.blockscout.com/address/0xB6bDbff51a51Fb8743dAaa115317d9a72fEbDaE1) |

The oracle's algorithm and digest contracts, every creation transaction and the escrow settings are recorded in [`deployments/robinhood-4663.json`](deployments/robinhood-4663.json) and listed in [Deployments](https://type262.com/docs.html#deployments).

## Report a vulnerability

Report privately through GitHub's private vulnerability reporting:

**[github.com/Type262/262/security/advisories/new](https://github.com/Type262/262/security/advisories/new)**

You can also open the repository's **Security** tab and click **Report a vulnerability**.
Only the maintainers see the report.
Please don't open a public issue, pull request or discussion about a vulnerability.

## What to include

- **Component and version.** The commit hash, the vault or transaction on Solana, or the contract address on Robinhood Chain.
- **Impact.** What an attacker gains, and whose funds or data are affected.
- **Steps to reproduce.** For the worker, a run against a local `solana-test-validator` with a throwaway master secret (`VAULT_MASTER_SEED`) and stubbed DNS answers is the clearest reproduction; `solana/scripts/e2e-validator.mjs` starts one with the pump.fun fixtures. For the on-chain program, a LiteSVM test in `solana/tests-rs`; `tests-rs/src/lib.rs` builds every instruction the way a client does. For a contract issue, a Foundry test against a Robinhood Chain fork; `contracts/test/Simulation.t.sol` shows the setup.
- **Proof of concept.** Code, transaction signatures or hashes from LiteSVM, a local validator or a local fork, logs or screenshots.
- **A suggested fix**, if you have one.
- **How you'd like to be credited**, or whether you prefer to stay anonymous.

Test on a local `solana-test-validator` or in LiteSVM for Solana, with throwaway keys and a throwaway master secret, and on a local fork (`anvil --fork-url` or Foundry's `createSelectFork`) for the contracts, never against funds on mainnet that aren't yours.

## Response targets

| Step | Target |
|---|---|
| Acknowledge your report | Within 72 hours |
| Status update: triage, severity and plan | Within 7 days |
| Further updates | As the fix progresses, until it is resolved |

## Coordinated disclosure

1. We confirm the issue and agree on its severity with you.
2. We prepare and test a fix, and deploy it.
3. We publish a GitHub security advisory that credits you, unless you prefer otherwise, and agree the disclosure date with you.

Please keep the details private until the advisory is published.
We will not pursue action against research done in good faith under this policy.

A fix to the worker ships as a redeploy of the `type262-upload` service. While a fix is prepared, the worker can stop paying out; vaults keep everything they hold, and claims and refunds resume with the fix.
The Robinhood Chain contracts are immutable and not upgradeable: a contract fix ships as a new deployment, and `scripts/post-deploy.mjs` points the app at it.
On Robinhood Chain the escrow admin can pause new deposits in the meantime; claims and refunds keep working throughout.

## How it's verified

- **Solana claims checked by two resolvers.** The worker pays a vault out only when Cloudflare and Google DNS-over-HTTPS both answer, return the same record and report it DNSSEC-authenticated, and only to a regular wallet: a System Program account with no data, or one that doesn't exist yet, never a token account, a mint or a program.
- **Custody stated plainly.** Solana vaults are custodial. Every vault key derives from one master secret, kept only in the worker's environment (`VAULT_MASTER_SEED`) and never in the repository.
- **An on-chain record.** Every claim payout carries the memo `type262:claim:<domain>` and every refund `type262:refund:<deposit signature>`. The worker keeps no database: it checks deposits and earlier payouts on-chain, and anyone can audit a vault from its transaction history.
- **Fees nobody can redirect.** Coins launched on pump.fun have the domain's vault as their creator. pump.fun's sweeps and collects are permissionless and can only pay that vault.
- **End to end on a local validator.** The app's Solana screens run in headless Chromium against a local validator with the mainnet pump.fun programs, a mock wallet holding a throwaway key and stubbed DNS answers.
- **The on-chain program, built and tested.** `solana/programs/type262`, not deployed, verifies DNSSEC on Solana itself from the IANA root keys and pays escrow pools only to the wallet a verified record names. It is covered by 78 LiteSVM tests on Windows and 86 with the precompiles, with six real DNSSEC chains, tampered proofs, attacks on the cache and the escrow's money paths, and the mainnet pump.fun programs, plus an end-to-end run of its client on a local validator (43 transactions, 84 checks).
- **On-chain DNSSEC on Robinhood Chain.** `DnssecVerifier` has ENS's `DNSSECImpl` check the full signature chain, from the IANA root keys down to the domain's record. The oracle's ownership is renounced, so nobody can change its anchors or algorithms.
- **Verified source.** All nine deployed Robinhood Chain contracts are verified on Sourcify with an exact match, and Blockscout shows the verified source.
- **Foundry tests.** 34 tests: unit tests, fuzzed fee math and accounting, nine end-to-end simulations on a Robinhood Chain mainnet fork against real USDG and the live pons v2 contracts, and a real proof from the root through `.com` to `cloudflare.com`, verified on a fork. Changing one byte of a signature makes verification revert.
- **Checked wiring.** `scripts/post-deploy.mjs` checks on-chain that every contract points at the right verifier, oracle, escrow and pons factory, and that the oracle has no owner.
- **Continuous integration.** Every push to `main` and every pull request runs the JavaScript suites and the full Foundry suite, including the fork tests with a freshly generated DNSSEC proof.
- **A narrow admin.** On Robinhood Chain, the escrow admin can pause new deposits and hand the role over in two steps. It cannot move funds, change who gets paid, change the fee or the refund delay, or block claims and refunds.
