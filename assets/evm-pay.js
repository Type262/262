// Paying a domain's EVM address on the chain the payer picks: Robinhood Chain (USDG, ETH), or Base (USDC, ETH).
// Base takes direct payments to the published address only: escrow and launches stay on Solana and Robinhood Chain.
// x402 helpers for the Verify tab: which network a 402 body names for each payTo.
import { paymentUri, transferTx, sameAddress, addressKind, codeMatchesAddress } from '../lib/wallet262.js'

// Base mainnet (OP Stack L2). USDC verified on-chain: symbol USDC, 6 decimals.
export const BASE = {
  id: 8453, name: 'Base', native: 'ETH',
  stable: { symbol: 'USDC', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 },
  rpc: 'https://mainnet.base.org', explorer: 'https://basescan.org', explorerName: 'Basescan',
}

// EVM coin codes that name another chain. Base never picks an address published only under one of them: it may be
// a contract or a deposit address that exists on that chain alone.
const OTHER_CHAINS = new Set(['HOOD', 'USDG', 'ARB', 'OP', 'POL'])

/**
 * The index in `records` of the EVM address a payment on Base goes to, or -1 when there is none: the record coded
 * with the asset paid (USDC by default), then ETH, then EVM, then the first other EVM code that names no other chain.
 * The MCP server and the CLI pick the same way, so one domain gets one recipient on Base whatever the record order.
 */
export function basePick(records, symbol = 'USDC') {
  const evm = records.map((x, i) => [x, i]).filter(([x]) => addressKind(x.address) === 'evm' && codeMatchesAddress(x.code, x.address))
  for (const code of [symbol, 'ETH', 'EVM']) {
    const hit = evm.find(([x]) => x.code === code)
    if (hit) return hit[1]
  }
  const rest = evm.find(([x]) => !OTHER_CHAINS.has(x.code))
  return rest ? rest[1] : -1
}

// asset is the Pay tab's choice: 'stable' (USDG, USDC) or 'native' (ETH).
const tokenOf = (c, asset) => (asset === 'stable' ? c.stable : null)

/** The EIP-681 link that pays `amount` of `asset` to `to` on chain c. Throws on an invalid amount. */
export function evmLink(c, to, asset, amount) {
  const s = tokenOf(c, asset)
  return paymentUri(to, { amount, chainId: c.id, token: s ? s.address : undefined, decimals: s ? s.decimals : 18 })
}

/** EIP-1193 transaction params, without from, that send `amount` of `asset` to `to` on chain c. */
export function evmTransfer(c, to, asset, amount) {
  const s = tokenOf(c, asset)
  const tx = transferTx({ from: '', to, amount, decimals: s ? s.decimals : 18, token: s ? s.address : undefined })
  delete tx.from
  return tx
}

/** The symbol of `asset` on chain c. */
export const assetSymbol = (c, asset) => (asset === 'stable' ? c.stable.symbol : c.native)

/** One JSON-RPC call to chain c's public RPC, given up after `ms`. Errors name the chain. */
export async function chainRpc(c, method, params, fetchImpl = globalThis.fetch, ms = 20_000) {
  let res
  try {
    res = await fetchImpl(c.rpc, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(ms),
    })
  } catch (e) { throw new Error(`Can't reach ${c.name} (${e.message})`) }
  if (!res.ok) throw new Error(`${c.name} RPC answered ${res.status}`)
  const j = await res.json()
  if (j.error) throw new Error(j.error.message || `${c.name} RPC error`)
  return j.result
}

/**
 * Waits for the receipt of a transaction already sent on chain c, for 2 minutes of elapsed time. A read that fails is
 * tried again on the next poll, so a busy public RPC never turns a sent payment into an error by itself; each read is
 * given at most 10 seconds, or the time left, so an RPC that stalls can't stretch the wait. Returns the receipt;
 * throws if it reverted, or with the hash and where to check it if no receipt came.
 */
export async function waitForReceipt(c, hash, {
  read = (m, p, ms) => chainRpc(c, m, p, undefined, ms), pause = ms => new Promise(r => setTimeout(r, ms)),
  now = Date.now, timeout = 120_000, interval = 1500,
} = {}) {
  const end = now() + timeout
  let failed = null
  do {
    let r = null
    try { r = await read('eth_getTransactionReceipt', [hash], Math.min(10_000, Math.max(1_000, end - now()))); failed = null } catch (e) { failed = e }
    if (r) {
      if (r.status !== '0x1') throw new Error('Transaction reverted')
      return r
    }
    await pause(interval)
  } while (now() < end)
  throw new Error(failed
    ? `Sent, but ${c.name} could not be read to confirm it (${failed.message}). Check ${hash} on ${c.explorerName} before trying again.`
    : `Still pending after 2 minutes (${hash}). Check it on ${c.explorerName} before trying again.`)
}

// ---------- x402 networks ----------

// x402 v1 names networks ("base", "base-sepolia", "solana"), v2 uses CAIP-2 ids ("eip155:8453", "solana:5eykt…").
const NETWORKS = {
  base: 'Base', 'eip155:8453': 'Base',
  'base-sepolia': 'Base Sepolia (testnet)', 'eip155:84532': 'Base Sepolia (testnet)',
  ethereum: 'Ethereum', 'eip155:1': 'Ethereum',
  'eip155:4663': 'Robinhood Chain',
  solana: 'Solana', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 'Solana',
  'solana-devnet': 'Solana devnet (testnet)', 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1': 'Solana devnet (testnet)',
}

/** A readable name for an x402 network id; an id it doesn't know is returned as given. */
export function networkLabel(network) {
  const n = String(network || '').trim()
  const known = k => (Object.hasOwn(NETWORKS, k) ? NETWORKS[k] : '') // "constructor" is not a network
  return known(n) || known(n.toLowerCase()) || n
}

/**
 * Every payTo of an x402 "402 Payment Required" body with the network its requirement names:
 * [{ payTo, network }], network '' when the requirement names none. Reads the same lists as payTosFromX402.
 */
export function x402Networks(body) {
  const j = typeof body === 'string' ? JSON.parse(body) : body
  const list = (j && (j.accepts || j.paymentRequirements)) || (Array.isArray(j) ? j : [j])
  return list.filter(a => a && (a.payTo || a.pay_to)).map(a => ({ payTo: a.payTo || a.pay_to, network: typeof a.network === 'string' ? a.network.trim() : '' }))
}

/** The readable networks named for `address` in x402Networks(body) output, deduplicated, joined with commas. */
export function networksFor(entries, address) {
  const names = entries.filter(x => x.network && sameAddress(String(x.payTo), address)).map(x => networkLabel(x.network))
  return [...new Set(names)].join(', ')
}
