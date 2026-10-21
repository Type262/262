# Changelog

All notable changes to TYPE/262 are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A read-only RPC fallback, `POST /rpc` on the upload service. When a browser can't reach the public Robinhood Chain RPC, for example because of a DNS failure, the app reads through it for a minute. It forwards read methods only, from the site's origin only, with a per-IP limit, and can use a keyed provider URL kept as a server secret.

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

[Unreleased]: https://github.com/Type262/262/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Type262/262/releases/tag/v0.1.0
