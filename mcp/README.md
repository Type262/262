# TYPE/262 MCP server

Lets AI agents (Claude Desktop, Claude Code, Cursor, any MCP client) resolve, verify and pay domains by name on Robinhood Chain (4663), in USDG or ETH, or directly on Base (8453), in USDC or ETH.

The MCP server pays on EVM chains: Robinhood Chain, with escrow, and Base, for direct payments. TYPE/262's main network is Solana: there, domains are paid in SOL or USDC from the [app](https://type262.com/app.html) or any Solana wallet, and domain vaults are claimed through the TYPE/262 worker (see [On Solana](https://type262.com/docs.html#solana)). `resolve_domain` and `verify_payto` read every record a domain publishes, Solana addresses included; `pay_domain` pays on Robinhood Chain and Base only.

`type262-mcp.mjs` is one self-contained file: a hand-written MCP server over stdio (newline-delimited JSON-RPC 2.0), with viem and the wallet262 SDK bundled in. It needs Node 18+ and nothing else.

## Tools

| Tool | What it does |
|---|---|
| `resolve_domain` | Wallets a domain publishes (code, address, source, DNSSEC), resolver agreement, whether it is verified, what `pay_domain` would do on this server (pay directly, escrow or refuse on Robinhood Chain; pay directly or refuse on Base), USDG/ETH waiting in escrow for that name |
| `verify_payto` | Checks one address, or every `payTo` in an x402 402 body, against the domain's DNS: `safe`, `unsigned` or `no_match`, with a reason |
| `pay_domain` | Pays a domain in USDG or ETH on Robinhood Chain, or with `chain: "base"` in USDC or ETH on Base (USDC without `chain: "base"` is refused). Direct only to a DNSSEC-signed EVM record that every resolver returns and agrees on; otherwise, on Robinhood Chain, deposits into DomainEscrow under the name given, which only that name's DNSSEC-proven owner can claim, and on Base, where there is no escrow, refuses. `dry_run` returns the plan; `repeat` allows an identical payment within 10 minutes |
| `escrow_status` | USDG and ETH waiting for a domain, deposits paused flag |
| `wallet_status` | Agent address, balances on both chains, today's spend and limits |

Never pays when resolvers disagree or the domain does not exist (any resolver answering NXDOMAIN counts).

### How DNS answers are checked

- Only records owned by the name asked for count. If the name is a CNAME, the alias target's records are ignored, so the name has no record of its own.
- A result is **verified** when records were found, every resolver answered (none failed), they all agree, and every record is DNSSEC-authenticated on every resolver.
- `verify_payto` gives each address the first reason that applies:

| Reason | Verdict |
|---|---|
| Domain does not exist | `no_match` |
| Domain publishes no WALLET record | `no_match` |
| Address is not published by this domain | `no_match` |
| Resolvers disagree. Possible tampering | `no_match` |
| Match, but the zone is not DNSSEC-signed | `unsigned` |
| Match, but not every resolver answered | `unsigned` |
| Match, but not DNSSEC-signed on every resolver | `unsigned` |
| Match, DNSSEC-verified | `safe` |

`safe` needs every resolver to answer and to return the address DNSSEC-signed.

### How names are matched

- A host with no record of its own can be paid directly through its parent's record (`api.example.com` -> `example.com`). This only happens when every resolver answered for the host with NOERROR (no failed request, no SERVFAIL, no NXDOMAIN) and they agree it has no record, when the host has at least three labels, and never into a `co.uk`-style suffix or a domain on the built-in list of about 70 shared hosting domains (`github.io`, `vercel.app`, `netlify.app`, `pages.dev`, ...). The list is built in; it is not the full Public Suffix List.
- Escrow deposits are always keyed by the exact name given, so only that name's owner can claim them.
- Input with a dot before an `@` (`good.com@other.com`) is refused as ambiguous: only the part after the `@` would be used. The ideographic, fullwidth and halfwidth full stops (`。`, `．`, `｡`) and `%2e` count as dots. A plain email such as `bob@example.com` works.

### Base

Base takes direct payments only. `pay_domain` with `chain: "base"` pays a domain whose DNSSEC-signed EVM record every resolver returns and agrees on, and refuses everything else with the reason, because there is no escrow on Base. `TYPE262_REQUIRE_DNSSEC=false` does not apply there. Of a domain's EVM records, Base pays the one coded with the asset, then `ETH`, then `EVM`, then any other code that names no chain, so a domain with `USDG` and `ETH` lines is paid at its `ETH` address in USDC and ETH alike; a domain whose EVM addresses are all published under codes for other chains (`HOOD`, `USDG`, `ARB`, `OP`, `POL`) is refused on Base. USDC is paid only with `chain: "base"`: a call with `asset: "USDC"` and no chain is refused, since it may mean Solana USDC. Base has its own spend limits and its own entries in the spend log (`BASE_USDC`, `BASE_ETH`), and the repeat guard compares payments on the same chain only. The gas check adds Base's L1 data fee, at the upper bound the chain's GasPriceOracle gives for a 300-byte transaction.

### Escrow

Only the owner who proves the domain on-chain can claim a deposit: they publish a DNSSEC-signed `WALLET` record or `_wallet` TXT record with an EVM address. A claim pays out the deposit minus the 0.5% claim fee. If nobody claims, the agent wallet can refund it in full after 180 days.

### Payments, retries and limits

- Each transaction is signed locally and its hash is known before it is broadcast. If the RPC returns an error on broadcast, the server still waits for a receipt, because the transaction may have gone out.
- Only a receipt for the exact transaction hash sent counts. A transaction that replaced it (same key and nonce) is never reported as the payment.
- A payment counts against the daily limit as soon as it may have been broadcast. Only a payment that never left the server, or that reverted on-chain, is taken back off.
- An identical payment within 10 minutes is refused unless the call passes `repeat: true`: the same asset and amount to the same name, or to the same recipient wallet (or the same escrow name) under a different name or URL. A retry after a lost or timed-out result therefore never pays twice by accident. The window is stored in the spend log, so it survives a restart.
- A `pay_domain` request that the client cancels (`notifications/cancelled`), or that is still queued when the client disconnects, is never sent: "Not sent: the request was cancelled or the client disconnected before the payment started." A payment already broadcast still finishes.
- Payments run one at a time within a server process. A lock file shared by every process using the same spend log (`<spend file>.lock`) keeps the daily limit across them, so it holds across several MCP clients on one machine. Give each MCP client its own key: two processes sending from one key at the same moment can pick the same nonce.
- Before sending, the wallet's ETH is checked against the payment plus its estimated gas.
- Every successful result carries a one-line `summary` the agent can repeat to you; a refusal or error carries a one-line `error` instead.

## Configure

```json
{
  "mcpServers": {
    "type262": {
      "command": "node",
      "args": ["/absolute/path/to/type262/mcp/type262-mcp.mjs"],
      "env": { "TYPE262_PRIVATE_KEY": "0x..." }
    }
  }
}
```

Claude Desktop: `claude_desktop_config.json`. Claude Code: `.mcp.json` in the project. Cursor: `.cursor/mcp.json`.
Without a key, everything except paying works; `wallet_status` then explains how to set one. Use a dedicated hot wallet that holds only what the agent may spend, and one key per MCP client.

| Variable | Default | |
|---|---|---|
| `TYPE262_PRIVATE_KEY` | none | Agent wallet, 0x + 64 hex. Needed only to pay. Never logged or echoed |
| `TYPE262_RPC` | `https://rpc.mainnet.chain.robinhood.com` | Must serve chain 4663. Never echoed |
| `TYPE262_MAX_USDG` / `TYPE262_MAX_ETH` | `25` / `0.01` | Per payment |
| `TYPE262_DAILY_USDG` / `TYPE262_DAILY_ETH` | `100` / `0.05` | Per UTC day |
| `TYPE262_BASE_RPC` | `https://mainnet.base.org` | Base RPC. Must serve chain 8453. Never echoed |
| `TYPE262_MAX_BASE_USDC` / `TYPE262_MAX_BASE_ETH` | `25` / `0.01` | Per payment on Base |
| `TYPE262_DAILY_BASE_USDC` / `TYPE262_DAILY_BASE_ETH` | `100` / `0.05` | Per UTC day on Base |
| `TYPE262_REQUIRE_DNSSEC` | `true` | `false` also pays unsigned records directly on Robinhood Chain (resolvers must still agree). Base always needs a signed record |
| `TYPE262_ALLOW_ESCROW` | `true` | `false` turns escrow off for every call (and `resolve_domain` then says `pay_domain` would refuse). The agent's `allow_escrow` can only turn it off, never back on |
| `TYPE262_SPEND_FILE` | `~/.type262/agent-spend.json` | Daily totals and the last 10 minutes of payments (domain, recipient, asset, amount, time). No keys or hashes |
| `TYPE262_DOH` | Cloudflare + Google | Comma-separated DNS-over-HTTPS JSON endpoints (https, or http on loopback). List at least two so answers are cross-checked. Results name them `doh1`, `doh2`, ...; the URLs are never echoed |

## Build and test

```bash
npm run mcp:build          # mcp/src/server.mjs -> mcp/type262-mcp.mjs (esbuild 0.24.0 via npx)
node test/mcp.test.mjs     # stdio protocol, live DNS, dry runs, limits, key handling, mock DNS
npm run test:mcp:fork      # + real payments on local anvil forks of Robinhood Chain and Base (Foundry), never on mainnet
```
