# Deploying TYPE/262

TYPE/262 runs on two networks. **Solana is the main network**: the TYPE/262 worker, a Node service on Render, gives every domain a vault and pays it out to the wallet the domain's DNSSEC-signed record names. **Robinhood Chain is also supported**: its contracts check DNSSEC proofs on-chain, with no server in the claim path.

This runbook covers both, Solana first:

- [Solana: the worker](#solana-the-worker)
- [Robinhood Chain: the contracts](#robinhood-chain-the-contracts)

## Solana: the worker

### Live deployment (Solana mainnet)

| | |
|---|---|
| Worker | `https://type262-upload.onrender.com` (`type262-upload` in `render.yaml`) |
| Gas wallet | [`3sde4YJpX2oYMSWaozHareWrXn6MASLxhQgfuCKJNPoK`](https://solscan.io/account/3sde4YJpX2oYMSWaozHareWrXn6MASLxhQgfuCKJNPoK) |
| Fee wallet | [`3sde4YJpX2oYMSWaozHareWrXn6MASLxhQgfuCKJNPoK`](https://solscan.io/account/3sde4YJpX2oYMSWaozHareWrXn6MASLxhQgfuCKJNPoK) |
| USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` (6 decimals) |
| pump.fun programs | pump `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`, PumpSwap `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` |
| Launch lookup table | [`4wM2VSmovRHZtEQ9oenQZn2v7rSE9XRUJjFbCfEfkyMr`](https://solscan.io/account/4wM2VSmovRHZtEQ9oenQZn2v7rSE9XRUJjFbCfEfkyMr) (20 addresses, authority the gas wallet) |

Fee 0.5%, refunds after 180 days. Solana runs no TYPE/262 program: vaults are ordinary addresses held by the worker, and launches use pump.fun's own programs. The worker keeps no database; it reads every deposit, claim and refund from the chain.

What the worker does:

| Endpoint | Job |
|---|---|
| `GET /solana/vault?domain=<d>` | The domain's vault: `{ domain, vault, usdcAccount }`. Every domain has its own Solana address; the seed of its Ed25519 key is `HMAC-SHA256(VAULT_MASTER_SEED, "type262:vault:" + canonical domain)`. |
| `POST /solana/claim { domain }` | Checks the domain's DNS, collects its pump.fun creator fees into the vault, then pays everything in the vault (SOL and every SPL token, up to `MAX_TOKENS_PER_CLAIM` tokens per claim) to the wallet the domain publishes, minus `FEE_BPS` of each to the fee wallet. Anyone can trigger it; the money only goes to that wallet. Each payout carries the memo `type262:claim:<domain>`. |
| `POST /solana/collect { domain }` | Collects the domain's pump.fun creator fees into its vault, without paying out. |
| `POST /solana/refund { domain, signature }` | `REFUND_DELAY_DAYS` after a deposit, if the domain hasn't claimed since and it wasn't refunded already, sends it back to its sender with the memo `type262:refund:<deposit signature>`. |
| `GET /solana/status` | `ready`, the gas wallet and its balance in lamports, the fee wallet, the fee and the refund delay. No secrets. |
| `POST /image`, `POST /metadata` | Pin launch images and coin metadata to IPFS through Pinata. |
| `POST /rpc/solana`, `POST /rpc` | Read-only RPC fallbacks for Solana (which also relays transactions a wallet already signed) and for Robinhood Chain. |
| `GET /health` | Whether uploads and vaults are set up. |

A claim pays only when the record publishes exactly one SOL address, Cloudflare and Google both answer, return the same address and report it DNSSEC-authenticated, and the address is a regular wallet: a System Program account with no data, or one that doesn't exist yet. Never a token account, a mint or a program.

### 1. Create the service

`render.yaml` is a Render Blueprint with two services: `type262`, the static site, and `type262-upload`, the worker. The worker runs `node upload/server.mjs` with no build step and no dependencies, and Render checks it at `/health`.

In the Render dashboard, create a Blueprint from the repository. Render reads `render.yaml` and asks for every variable marked `sync: false`. Those values, the secrets among them, are set only in the dashboard, never in the repository.

### 2. Make the master secret (once)

`VAULT_MASTER_SEED` is 32 bytes as 64 hex characters. Every vault key derives from it, and so does the gas wallet unless you set `SOLANA_GAS_KEYPAIR`. Generate it on the machine that will keep it:

```bash
openssl rand -hex 32
```

Paste it into the Render dashboard as `VAULT_MASTER_SEED` and back it up offline. Never commit it, never paste it into a chat or an issue, and never reuse the secret of another deployment.

Set it once. A different secret gives every domain a different vault, and the vaults of the old secret can only be paid out with the old secret.

### 3. Set the rest

| Variable | Default | Meaning |
|---|---|---|
| `VAULT_MASTER_SEED` | required for `/solana/` | The master secret above |
| `SOLANA_FEE_WALLET` | required for `/solana/` | The Solana address that receives the claim fee |
| `FEE_BPS` | `50` (0.5%) | The claim fee in basis points, taken from every asset a claim pays out. 0 to 1000 |
| `REFUND_DELAY_DAYS` | `180` | Days after a deposit before its sender can take it back, if the domain hasn't claimed it |
| `SOLANA_RPC_URL` | none | A keyed Solana RPC for the worker and `/rpc/solana`, tried before the public nodes. It must allow `getProgramAccounts`, which finds a vault's pump.fun coins |
| `SOLANA_PUBLIC_RPC_URLS` | `https://solana-rpc.publicnode.com,https://api.mainnet-beta.solana.com` | Public RPCs tried after it, in order |
| `SOLANA_GAS_KEYPAIR` | none | Optional: a Solana CLI keypair JSON (64 numbers) for a gas wallet you fund directly. Without it, the gas wallet derives from `VAULT_MASTER_SEED` |
| `PINATA_JWT` | required for uploads | A Pinata API key (JWT) that can upload files |
| `ALLOW_ORIGINS` | `https://type262.com`, its `www` and the onrender.com address | Origins allowed to send claims, collects, refunds, uploads and RPC requests |
| `VAULT_RATE_MAX` | `10` | Claims, collects and refunds per IP per 10 minutes, together |
| `ROBINHOOD_RPC_URL` | none | Optional keyed Robinhood Chain RPC for `/rpc` |

`render.yaml` already sets `FEE_BPS` to `50` and `REFUND_DELAY_DAYS` to `180`. `MAX_TOKENS_PER_CLAIM`, `PRIORITY_FEE_MIN`, `PRIORITY_FEE_MAX` and the other tuning settings are listed in the header of `upload/server.mjs`.

On start, the log line reads `vaults: ready`. Otherwise it names what is missing, never a value.

### 4. Fund the gas wallet

```bash
curl https://type262-upload.onrender.com/solana/status
```

`gasWallet` is the gas wallet's address and `gasLamports` its balance. Send it SOL. It pays the network and priority fees of every claim, collect and refund, the rent of token accounts the owner or the fee wallet needs, and it lends an empty vault the rent minimum during a collect. It gets back the rent of the vault token accounts a claim closes.

Before each transaction the worker checks the gas wallet's balance. When it runs low, it sends nothing more and reports `Out of gas` with the amount it needs. Top it up and try again; a claim that stopped part-way pays the rest on the next claim.

### 5. Point the app at it

The app uses `https://type262-upload.onrender.com` by default. For your own worker, set `UPLOAD_URL` in `assets/config.js`, or `WORKER_URL` when the vault endpoints run apart from the uploads. `scripts/post-deploy.mjs` rewrites `assets/config.js` with only the Robinhood Chain exports, so add these back after running it.

### 6. The launch lookup table (once)

Launches with an opening buy are v0 transactions over a lookup table of the accounts launches name, so they keep a priority fee and the board's reference. The live one is in the table above. For your own, run this with a funded keypair; it pays about 0.0042 SOL of rent, which comes back if the table is ever closed:

```bash
KEYPAIR=path/to/keypair.json SOLANA_RPC=https://your-rpc node solana/scripts/launch-table.mjs --dry-run   # simulate first
KEYPAIR=path/to/keypair.json SOLANA_RPC=https://your-rpc node solana/scripts/launch-table.mjs
```

Then set `SOLANA_LAUNCH_TABLE` in `assets/config.js` to the address it prints. Without a table, launches still work as legacy transactions.

### 7. Smoke test with real money (small)

1. On a domain you own, turn on **DNSSEC** at your DNS host. On Cloudflare it's one click, then add the DS record at your registrar if Cloudflare isn't the registrar.
2. Add the `_wallet` TXT record from the app's **Publish** tab, on Solana: `_wallet.yourdomain.com TXT "SOL <your Solana address>"`.
3. **Escrow** tab on Solana: open your domain's vault and send it a little SOL or USDC from your wallet.
4. Click **Claim**. You receive the amount minus 0.5%, in a transaction with the memo `type262:claim:yourdomain.com`.
5. **Launch** tab on Solana: launch a test coin on pump.fun for your domain, with a small opening buy. Its creator fees accrue to the vault; the next claim collects them and pays them out.

### Updating the worker

A change ships as a redeploy of `type262-upload`. Run `npm test` and the end-to-end runs on a local validator first (see `CONTRIBUTING.md`). Keep `VAULT_MASTER_SEED` unchanged across deploys: the vault addresses derive from it.

The on-chain program in `solana/programs/type262`, which verifies DNSSEC on Solana itself, is built and tested but not deployed. `solana/README.md` covers building it and how its mainnet program id is set at deployment.

## Robinhood Chain: the contracts

### Live deployment (Robinhood Chain mainnet, 4663)

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

### 1. A deployer key (once)

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

### 2. Deploy

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

### 3. Point the app at the escrow

```bash
node scripts/post-deploy.mjs
git add assets/config.js deployments && git commit -m "Point the app at the mainnet escrow" && git push
```

`post-deploy.mjs` checks on-chain that every contract exists, that the escrow points to the verifier and the verifier to the oracle, that the oracle has no owner, and that the launcher points to the escrow and to the pons v2 factory. It then writes `ESCROW_ADDRESS` and `LAUNCHER_ADDRESS` into `assets/config.js`. The push redeploys the site.

### 4. Smoke test with real money (small)

The app opens on Solana: switch its network to **Robinhood Chain** first.

1. On a domain you own, turn on **DNSSEC** at your DNS host. On Cloudflare it's one click, then add the DS record at your registrar if Cloudflare isn't the registrar.
2. Add the `_wallet` TXT record from the app's **Publish** tab: `_wallet.yourdomain.com TXT "ETH 0xYourWallet"`.
3. **Escrow** tab: send 1 USDG to that domain.
4. Click **Claim**. Your browser builds the DNSSEC proof and the contract verifies it. You receive 0.995 USDG immediately.

5. **Launch** tab: launch a test token with fees to your domain, buy a little, then click **Collect to escrow** on its page. The fees show up in the Escrow tab under your domain, ready to claim.

### Admin

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

### If Blockscout verification fails

1. On https://robinhoodchain.blockscout.com open the contract, go to **Verify & Publish** and choose **Solidity (Standard JSON input)**.
2. Generate the input file with `cd contracts && forge verify-contract <address> src/DomainEscrow.sol:DomainEscrow --show-standard-json-input > escrow.json`.
3. Use compiler 0.8.28, optimizer on (10,000 runs) and EVM version shanghai.

### Known limits

- **pons fees need a sweep.** Curve fees reach the pons fee escrow when someone sweeps them. pons's operator does this, and **Collect** does it too. After graduation, pool fees sit in pons's Uniswap v4 hook; pons's operator sweeps them, and `collectPools` lets the forwarder sweep its own pools (the app doesn't call it yet).
- **pons's owner can redirect fees.** It can move any pons token's fee recipient behind a public 3-day timelock. The forwarder can't stop that; the app's token page warns when it happens.
- **Claims are instant.** Whoever controls a domain's DNS (with DNSSEC on) can claim its money, so protect your registrar and DNS accounts.
- **Supported DNSSEC algorithms** are 5, 7, 8 and 13, which covers the root, .com and Cloudflare-signed zones. Zones signed with Ed25519 (algorithm 15) can't claim yet.
