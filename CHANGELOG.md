# Changelog

All notable changes to TYPE/262 are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `type262 link` makes Solana Pay links: SOL by default, or USDC with `link <domain> <amount> USDC`. `USDG` and `ETH` still make EIP-681 links on Robinhood Chain.

### Changed

- The README, its diagrams and screenshots, the social preview, `DEPLOY.md` and the package metadata lead with Solana, and present Robinhood Chain as also supported. New diagrams show the Solana architecture and the domain vault flow; the Robinhood Chain contract diagram moves into its own section.

### Fixed

- `type262 link` refuses an asset it doesn't know. It used to build an ETH link for anything other than USDG, so `link yoursite.com 5 USDC` asked for 5 ETH.

## [0.2.0] - 2026-10-21

The Solana release. Solana is now TYPE/262's main network: pay a domain's published address in SOL or USDC, pay any domain's vault before it publishes a wallet, and launch pump.fun coins whose creator fees go to the domain's vault. The TYPE/262 worker pays a vault out to the wallet the domain's DNSSEC-signed record names. Robinhood Chain stays fully supported, with its contracts and deployment unchanged, and gains the Unclaimed Board, a public profile for every domain and an MCP server that lets AI agents pay domains by name.

### Added

#### Domain vaults on Solana

- **A vault for every domain.** Each canonical domain has its own Solana address, derived by the worker from a 32-byte master secret: the seed of the vault's Ed25519 key is `HMAC-SHA256(master secret, "type262:vault:" + domain)`. Names are canonicalized with the SDK's `normalizeDomain` and the escrow's label rules (lowercase `a-z`, `0-9`, `-`, `_`, punycode, at most 253 characters), so one domain never has two vaults. Anyone can send SOL, USDC or any other SPL token to a vault with a plain transfer; a token payment goes to the vault's associated token account, which the sender creates idempotently.
- **Claims.** `POST /solana/claim` pays everything in a domain's vault, SOL and every SPL token, to the one `SOL` address the domain publishes in `_wallet.<domain>` TXT or a `WALLET` record, minus a 0.5% fee (`FEE_BPS`, 50, rounded down) to the fee wallet. The worker pays only when Cloudflare and Google DNS-over-HTTPS both answer, agree and report the record DNSSEC-authenticated, and only to a regular wallet: a System Program account with no data or one that doesn't exist yet, never a token account, a mint or a program. It collects the domain's pump.fun creator fees first. Each payout carries the SPL Memo `type262:claim:<domain>`, and the worker's gas wallet pays the network fees and the owner's token-account rent.
- **Refunds.** `POST /solana/refund` returns a deposit to the address that sent it, 180 days after the deposit (`REFUND_DELAY_DAYS`), if the domain hasn't claimed since and the deposit wasn't refunded already, with the memo `type262:refund:<deposit signature>`. The worker keeps no state: it checks the deposit transaction and the vault's history on-chain each time.
- **Collect.** `POST /solana/collect` moves the creator fees of a domain's pump.fun coins into its vault without paying anything out.
- **Lookups.** `GET /solana/vault?domain=<d>` returns `{ domain, vault, usdcAccount }`, and `GET /solana/status` the gas wallet, its balance, the fee wallet, the fee and the refund delay. Amounts in answers are decimal strings in base units. Errors are JSON, `{ error, reason }`, with a plain-language reason.
- **Trust model.** Solana vaults are custodial: the worker holds the master secret. The docs state this next to the Robinhood Chain model, where contracts verify DNSSEC on-chain.

#### pump.fun launchpad on Solana

- Launch a pump.fun coin with pump.fun's own `create_v2` and the domain's vault as its creator, so every creator fee of the coin, on the bonding curve and on PumpSwap after graduation, accrues to the vault. An optional opening buy (`buy_v3`) rides in the same transaction. No TYPE/262 program takes part.
- pump.fun's sweeps and collects are permissionless with destinations fixed by pump.fun, so they can only pay the domain's vault; every claim runs them first.
- `solana/scripts/pump-lib.mjs` and `pump-ix.mjs` hand-encode pump.fun's and PumpSwap's instructions, checked against mainnet in simulation and in LiteSVM; `solana/docs/PUMP.md` documents them.

#### App and client

- Solana is the default network. A network switch in the app header picks Solana or Robinhood Chain.
- **Pay** sends SOL or USDC to a domain's `SOL` address from Phantom, Solflare, Backpack or any Wallet Standard wallet.
- The app's Solana screens send SOL or USDC to a domain's vault and ask the worker to claim it, collect its launch fees or refund a deposit.
- **Launch** on pump.fun: a create form that pins the image and the coin's metadata to IPFS, with an optional opening buy in the launch transaction.
- **Publish** offers a Solana address first.
- `assets/solana.js`, a dependency-free Solana client: base58, PDAs and associated token accounts, transactions, RPC with a fallback, and Wallet Standard wallets.

#### Worker

- The upload service, `upload/server.mjs` (`type262-upload` on Render), is now also the Solana worker, with the `/solana/` endpoints above under the same origin allowlist and per-IP rate limits. It reads `VAULT_MASTER_SEED`, `SOLANA_FEE_WALLET`, `FEE_BPS` and `REFUND_DELAY_DAYS`, and still has no dependencies.
- `POST /metadata` pins pump.fun-style coin metadata JSON to IPFS and returns its `https://ipfs.io/ipfs/<cid>` link.
- `POST /rpc/solana`, a read-only Solana RPC fallback with the same origin and per-IP limits as `/rpc`. It can also relay a transaction the wallet has already signed.
- A read-only RPC fallback, `POST /rpc`. When a browser can't reach the public Robinhood Chain RPC, for example because of a DNS failure, the app reads through it for a minute. It forwards read methods only, from the site's origin only, with a per-IP limit, and can use a keyed provider URL kept as a server secret.

#### The on-chain Solana program, built and tested, not deployed

- `solana/programs/type262`, an Anchor program that takes the server out of Solana claims: a domain escrow with one pool per domain and asset, a DNSSEC verifier and a pump.fun launcher. It verifies DNSSEC on Solana itself, one signed record set per instruction, from the IANA root anchors KSK-2017 and KSK-2024 compiled into it, and caches each verified set so later proofs reuse the root and the TLD: RSA/SHA-256 with keys of 1024 to 2048 bits in the program (about 1.25M compute units for RSA-2048), P-256 and Ed25519 through Solana's native precompiles. The escrow pays a pool only to the wallet a verified record publishes, with proofs ordered by signing time, and its admin can only pause new deposits.
- 78 LiteSVM tests on Windows and 86 in WSL with the precompiles, plus 29 unit tests in the program: the escrow's accounting to the lamport, Token-2022 mints, the DNSSEC rules, real chains from the root for six domains, attacks on the cache, the RSA check and the escrow's money paths, and launches, trades, graduation and collects against the mainnet pump.fun programs. `solana/scripts/e2e-local.mjs` runs its client on a local validator, 43 transactions and 84 checks.
- Its clients, `assets/solana-proof.js` (DNSSEC proofs in the browser, on the pinned dnsprovejs) and `assets/solana-type262.js` (every instruction and account reader), are tested byte for byte in `test/solana-proof.test.mjs` (20 tests) and `test/solana-type262.test.mjs` (24).
- Specifications in `solana/docs/DNSSEC.md` and `solana/docs/PUMP.md`, with the measurements behind them in `solana/bench`. Deploying it is future work.

#### Documentation

- The docs cover Solana in full: an overview with the settings and the trust model, domain vaults, claims and refunds, the pump.fun launchpad, the worker API, running your own worker, and the on-chain program.

#### The Unclaimed Board and domain profiles

- `/board` lists every domain that has been sent money through `DomainEscrow` or had a coin launched for it, sorted by **Most waiting**, **Newest**, **Most supporters** or **Has coins**, with a live activity feed.
- `/d/<domain>` shows a domain's wallet status in DNS, the money waiting for it, its rank, its top supporters, the coins whose fees pay it, and its recent activity, with share and copy-link buttons.
- Both read Robinhood Chain straight from the browser, with no indexer or database: escrow and launcher events from the deployment block onward (`FROM_BLOCK` in `assets/config.js`), and live `balanceOf` reads that match what a claim pays out before the 0.5% fee.
- The landing page shows the money waiting right now and the top domains, and links to the board.
- After an escrow deposit, the app offers a share on X and a link to the domain's profile. `app.html#launch/new/<domain>` opens the launch form for that domain.

#### MCP server for AI agents, on Robinhood Chain

- `mcp/type262-mcp.mjs`, one self-contained file for Claude Desktop, Claude Code, Cursor and any MCP client: a hand-written MCP server over stdio with viem and the SDK bundled. It needs Node 18+ and nothing else.
- Five tools: `resolve_domain`, `verify_payto`, `pay_domain`, `escrow_status` and `wallet_status`. Every successful result carries a one-line summary; refusals and errors carry a one-line error instead.
- `pay_domain` pays directly only to a DNSSEC-signed EVM record that every resolver returns, and otherwise deposits into `DomainEscrow`, always under the requested name. It never pays when resolvers disagree or any resolver says the domain does not exist, and `dry_run: true` returns the full plan.
- `resolve_domain` shows what `pay_domain` would do: pay directly, deposit into escrow, or refuse, including when `TYPE262_ALLOW_ESCROW=false` blocks the escrow path.
- Per-payment and daily limits for USDG and ETH, enforced by the server. Payments run one at a time within a server process, and a lock file shared by every process keeps the daily limit across them.
- An identical payment within 10 minutes needs `repeat: true`: the same asset and amount to the same name, or to the same recipient wallet (or the same escrow name) under a different name or URL.
- Transactions are signed locally, so their hash is known before broadcast, and a lost RPC response can never release spend that may have gone out. Only a receipt for that exact hash counts, so a replacement transaction is never reported as the payment.
- A `pay_domain` call that the client cancels (`notifications/cancelled`), or that is still queued when the client disconnects, is never sent. Payments already broadcast still finish.
- The agent key is read once, never logged or echoed, and custom RPC and DNS-over-HTTPS URLs are scrubbed from every result.
- `TYPE262_ALLOW_ESCROW=false` is a ceiling the agent cannot override.

### Changed

- The landing page, the README and the docs lead with Solana and pump.fun. Robinhood Chain's escrow, DNSSEC proofs, launchpad, contract reference and deployment have their own section in the docs.
- `resolveWallets` counts an answer only when its owner name is the queried name, so a name that is a CNAME no longer takes on its target's records.
- `resolveWallets` sets `nxdomain` when any answering resolver reports NXDOMAIN, not only the first one.
- `verified` now also requires every resolver to answer, and every record to be DNSSEC-authenticated on every resolver.
- `resolveWalletsUp` walks up to the parent only when every resolver answered the host with NOERROR and no record, and they agree. It no longer walks up when a resolver fails or returns SERVFAIL for the host, when the resolvers disagree, or when any resolver says the host does not exist. It never walks into a two-letter-country second level such as `co.uk`, or into a shared hosting domain on its built-in list (`github.io`, `vercel.app`, `pages.dev` and about 70 more).
- `verifyPayTo` reports resolver disagreement at the host instead of falling back to the parent's record.
- `verifyPayTo` gives `strong` only when every resolver answered and returned the address DNSSEC-signed, with two new reasons: `Match, but not every resolver answered` and `Match, but not DNSSEC-signed on every resolver`. The app's Verify tab shows these as **Match, not verified.**

### Fixed

- The Pay tab copies the payment link on desktop, where browsers can't open `ethereum:`, `bitcoin:` or `solana:` links, and opens it in a wallet app on phones.

## [0.1.0] - 2026-10-21

The first public release. TYPE/262 switches on the DNS `WALLET` record (RRTYPE 262, allocated by IANA on 2024-06-21), so any domain can be resolved, verified and paid in USDG or ETH on Robinhood Chain (chain id 4663).

### Added

#### WALLET record resolution and SDK

- `lib/wallet262.js`, a zero-dependency ES module for browsers and Node 18+, and the package's main export.
- `resolveWallets` reads the native `WALLET` record and the `_wallet` TXT fallback over DNS-over-HTTPS from Cloudflare and Google in parallel. It flags any disagreement between them and reports DNSSEC status per record.
- `verified` is true only when records exist, every resolver that answered agrees, and every record is DNSSEC-authenticated. Each resolver's status is reported.
- `resolveWalletsUp` walks from a host such as `api.yoursite.com` up to `yoursite.com`, never up to a public suffix such as `co.uk`.
- `verifyPayTo` and `payTosFromX402` check an x402 `payTo` against the payee domain's DNS before an agent pays, with `ok` and `strong` verdicts.
- `normalizeDomain` accepts domains, URLs, email addresses and IDNs.
- Record tooling: `encodeWalletRdata`, `parseWalletRdata`, `parseFallbackTxt` and `zoneLines`, which writes the native `WALLET`, RFC 3597 generic and `_wallet` TXT forms.
- Payment helpers: `transferTx` for EIP-1193 native and ERC-20 transfers, `paymentUri` for EIP-681, BIP-21 and Solana Pay links, exact `parseUnits`, and `addressKind`.

#### CLI

- `type262 resolve <domain>` lists the wallets a domain publishes, with DNSSEC and resolver agreement.
- `type262 verify <url|domain> <address>` checks a `payTo` and exits non-zero on no match.
- `type262 encode <domain> <CODE> <address> [ttl]` prints the zone lines to publish.
- `type262 link <domain> <amount> [USDG|ETH]` prints an EIP-681 payment link on Robinhood Chain.

#### Web app

- Landing page with a live resolver and a live adoption scan of well-known domains.
- The app, with seven tools: **Resolve**, **Pay**, **Escrow**, **Publish**, **Verify**, **Badge** and **Launch**. Tools take a domain in the URL hash, as in `app.html#resolve/yoursite.com`.
- **Publish** builds the `_wallet` TXT record, the native `WALLET` record and its RFC 3597 form, for one or more addresses on Robinhood Chain, Bitcoin, Solana or any other coin code.
- **Pay** adds and switches to Robinhood Chain, refuses to send when resolvers disagree, flags unsigned zones, and waits for the receipt.
- **Verify** checks a `payTo` address or a whole HTTP 402 body against the payee's DNS.
- **Badge** generates a "Pay via DNS" button that resolves the domain live on every click.
- Claims build DNSSEC proofs in the browser (`assets/dnssec.js`, on a pinned, vendored dnsprovejs 1.0.1). The app encodes contract calls with its own small ABI coder and loads no runtime packages.
- Full documentation in `docs.html`.

#### DomainEscrow with on-chain DNSSEC claims

- `DomainEscrow` holds ETH and ERC-20 deposits, USDG included, keyed by canonical domain name, so a domain can be paid before its owner has published anything.
- `DnssecVerifier` has ENS's DNSSEC oracle (`DNSSECImpl`) check the full signature chain from the IANA root keys, KSK-2017 and KSK-2024, down to the domain's record. The oracle supports algorithms 5, 7, 8 and 13 and digests 1 and 2, and its ownership is renounced.
- Accepts `_wallet.<domain>` TXT and `WALLET` (type 262) at the domain itself. Only EVM coin codes with exactly `0x` plus 40 hex digits count.
- Claims are instant and permissionless to submit: funds go only to the wallet the proof shows, minus a 0.5% fee that is capped at 1% in code and sent with `withdrawFees`.
- Proofs are ordered by signing time. An older proof can never override a newer one (`StaleProof`), and **Register** anchors the current record without moving money.
- Senders can take back an unclaimed deposit 180 days after their last deposit to that domain and asset, as long as no claim has paid that pool out since.
- The admin can pause new deposits and hand the role over in two steps. Claims and refunds always keep working. The contracts are not upgradeable, and the fee, fee recipient and refund delay are fixed at deploy.

#### DomainLauncher on pons v2

- `DomainLauncher` launches tokens on pons v2, a token launchpad on Robinhood Chain, with creator fees routed to a domain instead of a wallet.
- Each domain gets one ownerless `DomainFeeForwarder` at a CREATE2 address known in advance, so fees accrue from the first trade.
- Permissionless `collect` sweeps the curves and deposits ETH and USDG fees into `DomainEscrow`, where the owner claims them with the same DNSSEC proof. `collectPools` sweeps the forwarder's Uniswap v4 pools after graduation.
- Buyback is always off, and any part of an opening buy the curve can't take is refunded in the same transaction.
- In the app: a launch board (new, near graduation, graduated, by pair or by domain), a create form with a live preview, and a token page with buy and sell estimates that match the curve.

#### Image upload service

- `upload/server.mjs`, a zero-dependency Node service that pins Launch-form images to IPFS through Pinata and returns `ipfs://<cid>`. The Pinata key stays on the server.
- Accepts PNG, JPEG and WebP up to 5 MB, checked by content, and refuses SVG. Includes an origin allowlist, a per-IP rate limit and `GET /health`.

#### Contracts, deployment and tooling

- Live on Robinhood Chain mainnet from block 93,920,186: `DomainEscrow` at `0x9fd2f1Dc0B42e8a2E86e3Cf231a293654691E8d5`, `DomainLauncher` at `0x022657aC8bdD969Fa5149E7A86FBBda2AfAf716F`, `DnssecVerifier` at `0x2dfB277A25ea096b182F86665D130B9b53B15758`, and ENS's `DNSSECImpl` at `0xB6bDbff51a51Fb8743dAaa115317d9a72fEbDaE1`. All nine contracts are verified on Sourcify.
- `contracts/script/deploy-robinhood.sh` checks the network, balance and tests, dry-runs with the real cost, waits for a typed confirmation, then deploys and verifies on Sourcify. `scripts/post-deploy.mjs` checks the live wiring on-chain and writes `assets/config.js`.
- 34 Foundry tests, including fuzzing, nine simulations on a Robinhood Chain fork against real USDG and the live pons v2 contracts, and a real DNSSEC proof from the root through `.com` to `cloudflare.com`, verified for about 628k gas.
- `contracts/script/make-proof.mjs` builds a DNSSEC proof the same way the app does, for tests and for claims outside the app.
- `scripts/build.sh` builds the static site with a versioned asset folder per deploy, and `render.yaml` defines the site and the upload service.

[Unreleased]: https://github.com/Type262/262/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Type262/262/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Type262/262/releases/tag/v0.1.0
