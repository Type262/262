# Deploying TYPE/262 to Robinhood Chain

## Live deployment (Robinhood Chain mainnet, 4663)

| Contract | Address |
|---|---|
| `DomainEscrow` | [`0x9fd2f1Dc0B42e8a2E86e3Cf231a293654691E8d5`](https://robinhoodchain.blockscout.com/address/0x9fd2f1Dc0B42e8a2E86e3Cf231a293654691E8d5) |
| `DomainLauncher` | [`0x022657aC8bdD969Fa5149E7A86FBBda2AfAf716F`](https://robinhoodchain.blockscout.com/address/0x022657aC8bdD969Fa5149E7A86FBBda2AfAf716F) |
| `DnssecVerifier` | [`0x2dfB277A25ea096b182F86665D130B9b53B15758`](https://robinhoodchain.blockscout.com/address/0x2dfB277A25ea096b182F86665D130B9b53B15758) |
| `DNSSECImpl` (ENS oracle, no owner) | [`0xB6bDbff51a51Fb8743dAaa115317d9a72fEbDaE1`](https://robinhoodchain.blockscout.com/address/0xB6bDbff51a51Fb8743dAaa115317d9a72fEbDaE1) |

Admin and fee recipient: `0x37c6099d58Bb65D85c9CcF6D97de418BD26dD7f0`. Fee 0.5%, refunds after 180 days. All 9 contracts are verified on Sourcify (exact match). Full record: `deployments/robinhood-4663.json`.

What goes on-chain:

| Contract | Job |
|---|---|
| `DNSSECImpl` + algorithms + digests | ENS's DNSSEC oracle, anchored to the IANA root keys (KSK-2017 and KSK-2024). Its ownership is renounced during the deploy, so nobody can ever change how proofs are checked. |
| `DnssecVerifier` | Reads a domain's DNSSEC-proven `_wallet` TXT (or WALLET type 262) record |
| `DomainEscrow` | Holds money sent to domains. Pays the proven wallet instantly. Refunds after 180 days. |
| `DomainLauncher` | Launches tokens on pons v2 with creator fees routed to a domain. It creates one `DomainFeeForwarder` per domain on first use, and that forwarder moves fees into `DomainEscrow`. |

Total cost is about **0.0003 ETH** at current gas prices (around 10.8M gas; the L1 data part is negligible). Fund the deployer with **0.001 ETH on Robinhood Chain (4663)**, not on Ethereum. With `SWEEP_TO` set, whatever is left goes back to you at the end.

Run everything in a bash shell (Git Bash on Windows) from the repo root. First, once per terminal:

```bash
export PATH="$HOME/.foundry/bin:$PATH"
```

## 1. A deployer key (once)

**Option A: a dedicated deployer wallet in an env file.** A fresh hot wallet that only ever holds the deploy gas. Put it outside any synced folder (OneDrive, Dropbox, iCloud) at `~/.type262/deployer.env`:

```
DEPLOYER=0x…
DEPLOYER_PRIVATE_KEY=0x…
```

The deploy script uses this file automatically when it exists (`DEPLOYER_ENV` points elsewhere). Set `OWNER` and `FEE_RECIPIENT` to your main wallet so the hot key controls nothing after the deploy, and `SWEEP_TO` to get the leftover gas back.

**Option B: Foundry's encrypted keystore.**

```bash
cast wallet import deployer --interactive
```

Paste the private key **into your own terminal** and choose a password. Never paste a private key into a chat, and never commit one to the repo.

If `contracts/lib` is missing, run:
```bash
git submodule update --init --recursive
```

## 2. Deploy

This repository ships the record of the live deployment. To deploy your own instance, move it aside first so the script writes yours: `git mv deployments/robinhood-4663.json deployments/robinhood-4663.live.json`.

```bash
bash contracts/script/deploy-robinhood.sh
```

The script:
1. Checks the RPC is Robinhood Chain.
2. Checks your balance and prints the settings.
3. Runs every test (1,000 fuzz runs).
4. Dry-runs against mainnet and shows the real cost.
5. Waits for you to type `DEPLOY`, then sends the transactions.
6. Saves the addresses to `deployments/robinhood-4663.json`.
7. Verifies all the source code on Sourcify (9 contracts); Blockscout shows Sourcify-verified source.

With a keystore, Foundry asks for its password twice: once to read your address, once to sign. Setting `DEPLOYER=0x…` skips the first.

Example with a deployer env file, admin and fees to your main wallet, leftover gas returned:

```bash
OWNER=0xYourMainWallet SWEEP_TO=0xYourMainWallet bash contracts/script/deploy-robinhood.sh
```

| Variable | Default | Meaning |
|---|---|---|
| `OWNER` | your address | Admin: can pause new deposits. Nothing else. |
| `FEE_RECIPIENT` | `OWNER` | Receives the claim fee |
| `FEE_BPS` | `50` (0.5%) | Claim fee, hard-capped at 100 (1%) in the contract |
| `REFUND_DELAY` | `15552000` (180 days) | When senders can take back unclaimed money |
| `PONS_FACTORY` | pons v2 `0x7eD5…EC7e` | The pons factory the launcher uses |
| `SWEEP_TO` | unset | Send the deployer's leftover ETH here after the deploy |
| `MIN_ETH` | `0.001` | Minimum deployer balance before anything is sent |
| `CONFIRM` | unset | `DEPLOY` skips the typed confirmation |

## 3. Point the app at the escrow

```bash
node scripts/post-deploy.mjs
git add assets/config.js deployments && git commit -m "Point the app at the mainnet escrow" && git push
```

`post-deploy.mjs` checks on-chain that every contract exists, that the escrow points to the verifier and the verifier to the oracle, that the oracle has no owner, and that the launcher points to the escrow and to the pons v2 factory. It then writes `ESCROW_ADDRESS` and `LAUNCHER_ADDRESS` into `assets/config.js`. The push redeploys the site.

## 4. Smoke test with real money (small)

1. On a domain you own, turn on **DNSSEC** at your DNS host. On Cloudflare it's one click, then add the DS record at your registrar if Cloudflare isn't the registrar.
2. Add the `_wallet` TXT record from the app's **Publish** tab: `_wallet.yourdomain.com TXT "ETH 0xYourWallet"`.
3. **Escrow** tab: send 1 USDG to that domain.
4. Click **Claim**. Your browser builds the DNSSEC proof and the contract verifies it. You receive 0.995 USDG immediately.

5. **Launch** tab: launch a test token with fees to your domain, buy a little, then click **Collect to escrow** on its page. The fees show up in the Escrow tab under your domain, ready to claim.

## Admin

```bash
cast send <DomainEscrow> "setDepositsPaused(bool)" true --account <admin-keystore> --rpc-url https://rpc.mainnet.chain.robinhood.com
```

Send it from the admin (`OWNER`) wallet; any other sender reverts with `NotAdmin`.

That's the only switch. It stops new deposits; claims and refunds always keep working.

Claim fees build up in the escrow and are sent to the fee recipient with (anyone can call it):

```bash
cast send <DomainEscrow> "withdrawFees(address)" 0x0000000000000000000000000000000000000000 --private-key … --rpc-url https://rpc.mainnet.chain.robinhood.com
cast send <DomainEscrow> "withdrawFees(address)" 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 --private-key … --rpc-url https://rpc.mainnet.chain.robinhood.com
```

## If Blockscout verification fails

1. On https://robinhoodchain.blockscout.com open the contract, go to **Verify & Publish** and choose **Solidity (Standard JSON input)**.
2. Generate the input file with `cd contracts && forge verify-contract <address> src/DomainEscrow.sol:DomainEscrow --show-standard-json-input > escrow.json`.
3. Use compiler 0.8.28, optimizer on (10,000 runs) and EVM version shanghai.

## Known limits

- **pons fees need a sweep.** Curve fees reach the pons fee escrow when someone sweeps them. pons's operator does this, and **Collect** does it too. After graduation, pool fees sit in pons's Uniswap v4 hook; pons's operator sweeps them, and `collectPools` lets the forwarder sweep its own pools (the app doesn't call it yet).
- **pons's owner can redirect fees.** It can move any pons token's fee recipient behind a public 3-day timelock. The forwarder can't stop that; the app's token page warns when it happens.
- **Claims are instant.** Whoever controls a domain's DNS (with DNSSEC on) can claim its money, so protect your registrar and DNS accounts.
- **Supported DNSSEC algorithms** are 5, 7, 8 and 13, which covers the root, .com and Cloudflare-signed zones. Zones signed with Ed25519 (algorithm 15) can't claim yet.
