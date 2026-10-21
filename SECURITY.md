# Security policy

TYPE/262 pays domains by name, so security reports get our full attention.
This page covers what is in scope, how to report privately, what happens next, and how the system is verified.

## Scope

| Component | Where |
|---|---|
| Smart contracts | `contracts/src/`: `DomainEscrow`, `DnssecVerifier`, `DomainLauncher`, `DomainFeeForwarder`, and the live deployment below |
| SDK and CLI | `lib/wallet262.js`, `bin/type262.mjs` |
| Web app and pages | `index.html`, `app.html`, `docs.html` and `assets/`, including in-browser proof building in `assets/dnssec.js` |
| Upload service | `upload/server.mjs` |
| Deploy and build scripts | `contracts/script/`, `scripts/` |

Upstream code belongs with its own project: ENS's DNSSEC oracle, pons v2, OpenZeppelin, forge-std and dnsprovejs.
How TYPE/262 deploys, configures or calls that code is in scope.

The [trust model](https://type262.onrender.com/docs.html#security) documents the intended behaviour, such as instant claims by whoever controls a DNSSEC-signed zone, or pons's timelocked fee-recipient changes.
Reports that the documented model itself is weaker than stated are welcome.

## Deployed contracts

Robinhood Chain mainnet, chain id 4663, deployed from block 93,920,186.

| Contract | Address |
|---|---|
| `DomainEscrow` | [`0x9fd2f1Dc0B42e8a2E86e3Cf231a293654691E8d5`](https://robinhoodchain.blockscout.com/address/0x9fd2f1Dc0B42e8a2E86e3Cf231a293654691E8d5) |
| `DomainLauncher` | [`0x022657aC8bdD969Fa5149E7A86FBBda2AfAf716F`](https://robinhoodchain.blockscout.com/address/0x022657aC8bdD969Fa5149E7A86FBBda2AfAf716F) |
| `DnssecVerifier` | [`0x2dfB277A25ea096b182F86665D130B9b53B15758`](https://robinhoodchain.blockscout.com/address/0x2dfB277A25ea096b182F86665D130B9b53B15758) |
| `DNSSECImpl` (ENS DNSSEC oracle, no owner) | [`0xB6bDbff51a51Fb8743dAaa115317d9a72fEbDaE1`](https://robinhoodchain.blockscout.com/address/0xB6bDbff51a51Fb8743dAaa115317d9a72fEbDaE1) |

The oracle's algorithm and digest contracts, every creation transaction and the escrow settings are recorded in [`deployments/robinhood-4663.json`](deployments/robinhood-4663.json) and listed in [Deployments](https://type262.onrender.com/docs.html#deployments).

## Report a vulnerability

Report privately through GitHub's private vulnerability reporting:

**[github.com/Type262/262/security/advisories/new](https://github.com/Type262/262/security/advisories/new)**

You can also open the repository's **Security** tab and click **Report a vulnerability**.
Only the maintainers see the report.
Please don't open a public issue, pull request or discussion about a vulnerability.

## What to include

- **Component and version.** The commit hash, or the contract address on Robinhood Chain.
- **Impact.** What an attacker gains, and whose funds or data are affected.
- **Steps to reproduce.** For a contract issue, a Foundry test against a Robinhood Chain fork is the clearest reproduction. `contracts/test/Simulation.t.sol` shows the setup.
- **Proof of concept.** Code, transaction hashes from a local fork, logs or screenshots.
- **A suggested fix**, if you have one.
- **How you'd like to be credited**, or whether you prefer to stay anonymous.

Test against a local fork (`anvil --fork-url` or Foundry's `createSelectFork`), never against funds on mainnet that aren't yours.

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

The contracts are immutable and not upgradeable.
A contract fix ships as a new deployment, and `scripts/post-deploy.mjs` points the app at it.
The escrow admin can pause new deposits in the meantime; claims and refunds keep working throughout.

## How it's verified

- **On-chain DNSSEC proofs.** Claims trust no server and no resolver. `DnssecVerifier` has ENS's `DNSSECImpl` check the full signature chain, from the IANA root keys (KSK-2017 and KSK-2024) down to the domain's record. The oracle's ownership is renounced, so nobody can change its anchors or algorithms.
- **Verified source.** All nine deployed contracts are verified on Sourcify with an exact match, and Blockscout shows the verified source.
- **Foundry tests.** 34 tests: unit tests, fuzzed fee math and accounting, nine end-to-end simulations on a Robinhood Chain mainnet fork against real USDG and the live pons v2 contracts, and a real proof from the root through `.com` to `cloudflare.com`, verified on a fork. Changing one byte of a signature makes verification revert.
- **Checked wiring.** `scripts/post-deploy.mjs` checks on-chain that every contract points at the right verifier, oracle, escrow and pons factory, and that the oracle has no owner.
- **Continuous integration.** Every push to `main` and every pull request runs the JavaScript suites and the full Foundry suite, including the fork tests with a freshly generated DNSSEC proof.
- **A narrow admin.** The escrow admin can pause new deposits and hand the role over in two steps. It cannot move funds, change who gets paid, change the fee or the refund delay, or block claims and refunds.
