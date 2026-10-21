// Read-only view of TYPE/262 on Robinhood Chain for the board, domain profiles and the landing page:
// every escrow deposit, claim and refund, every launch, live balances, and when it all happened.
// Straight from the public RPC (a log query returns up to 10,000 matches, so no indexer is needed), with a
// read-only fallback on our server for browsers that can't reach it.
import * as config from './config.js'
import { encodeCall, SEL } from './abi.js'

export const CHAIN = {
  rpc: config.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com',
  rpcFallback: config.RPC_FALLBACK || 'https://type262-upload.onrender.com/rpc',
  explorer: 'https://robinhoodchain.blockscout.com',
  escrow: (config.ESCROW_ADDRESS || '').toLowerCase(),
  launcher: (config.LAUNCHER_ADDRESS || '').toLowerCase(),
  usdg: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
  fromBlock: config.FROM_BLOCK || 93920186, // first block of the mainnet deployment
}
export const ZERO = '0x0000000000000000000000000000000000000000'
const TOPIC = {
  deposited: '0x3b9785af609e7e94f3a27a1805ad1eb3019ef356c7ab459724d5b8892788df3e',
  claimed: '0x636cc28d1dc3c5f8610bbd1cabdf6585ab2ef79f4b9ae78e840c1b8fd5ac887a',
  refunded: '0x2e0668a62a5f556368dca9c7113e20f2852c05155548243804bf714ce72b25a6',
  launched: '0x244b265c87c7bcb9c0ee96f2730234bdaf807cb2846c214a9334b6b71911feab',
}

// ---------- JSON-RPC ----------
// The public RPC first. If it can't be reached (DNS trouble, an outage), the fallback serves reads for the next minute.
let publicDownAt = 0
async function rpcPost(payload) {
  const body = JSON.stringify(payload)
  const urls = Date.now() - publicDownAt < 60_000 ? [CHAIN.rpcFallback, CHAIN.rpc] : [CHAIN.rpc, CHAIN.rpcFallback]
  let last
  for (const url of urls) {
    try {
      // the fallback may need a cold start on the host
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(url === CHAIN.rpc ? 20_000 : 60_000) })
      if (!res.ok && (res.status >= 500 || res.status === 429 || url !== CHAIN.rpc)) throw new Error(`RPC answered ${res.status}`)
      const j = await res.json()
      if (url === CHAIN.rpc) publicDownAt = 0
      return j
    } catch (err) {
      last = err
      if (url === CHAIN.rpc) publicDownAt = Date.now()
    }
  }
  throw new Error(`Can't reach Robinhood Chain right now (${last.message}). Try again in a moment.`)
}

export async function rpc(method, params) {
  const j = await rpcPost({ jsonrpc: '2.0', id: 1, method, params })
  if (j.error) throw new Error(j.error.message)
  return j.result
}
export async function batch(calls) {
  const out = []
  for (let i = 0; i < calls.length; i += 40) {
    const chunk = calls.slice(i, i + 40)
    const reply = await rpcPost(chunk.map((c, id) => ({ jsonrpc: '2.0', id, method: c.method || 'eth_call', params: c.params || [{ to: c.to, data: c.data }, 'latest'] })))
    const byId = new Map([].concat(reply).map(r => [r.id, r]))
    chunk.forEach((_, id) => { const r = byId.get(id); out.push(!r || r.error ? null : r.result) })
  }
  return out
}
const hex = n => '0x' + n.toString(16)
/** eth_getLogs over [from, to]; halves the range whenever the node says it matched too many logs. */
async function getLogs(address, topic, from, to) {
  try {
    return await rpc('eth_getLogs', [{ address, topics: [topic], fromBlock: hex(from), toBlock: hex(to) }])
  } catch (err) {
    if (!/exceed|limit|too many/i.test(err.message) || to - from < 2) throw err
    const mid = Math.floor((from + to) / 2)
    return [...await getLogs(address, topic, from, mid), ...await getLogs(address, topic, mid + 1, to)]
  }
}

// ---------- decoding ----------
const word = (h, i) => h.slice(2 + i * 64, 2 + (i + 1) * 64)
const big = w => BigInt('0x' + (w || '0'))
const addr = w => '0x' + w.replace(/^0x/, '').slice(24) // topics carry 0x, data words don't
const text = (h, offsetWord) => {
  const at = Number(big(word(h, offsetWord))) / 32
  const len = Number(big(word(h, at)))
  const bytes = h.slice(2 + (at + 1) * 64, 2 + (at + 1) * 64 + len * 2)
  return new TextDecoder().decode(Uint8Array.from(bytes.match(/../g) || [], b => parseInt(b, 16)))
}
export const decode = {
  deposit: l => ({ ...base(l), kind: 'deposit', domain: text(l.data, 0), token: addr(l.topics[2]), from: addr(l.topics[3]), amount: big(word(l.data, 1)) }),
  claim: l => ({ ...base(l), kind: 'claim', token: addr(l.topics[2]), to: addr(l.topics[3]), amount: big(word(l.data, 0)), fee: big(word(l.data, 1)) }),
  refund: l => ({ ...base(l), kind: 'refund', token: addr(l.topics[2]), from: addr(l.topics[3]), amount: big(word(l.data, 0)) }),
  launch: l => ({ ...base(l), kind: 'launch', domain: text(l.data, 0), token: addr(l.topics[2]), curve: addr(l.topics[3]), launcher: addr(word(l.data, 1)), pairToken: addr(word(l.data, 2)) }),
}
function base(l) { return { block: parseInt(l.blockNumber, 16), tx: l.transactionHash, index: parseInt(l.logIndex, 16), hash: l.topics[1] } }

// ---------- activity ----------
let cache = null
/** Every deposit, claim, refund and launch since the deployment (cached for 30 s). */
export async function activity() {
  if (cache && Date.now() - cache.at < 30_000) return cache.data
  if (!CHAIN.escrow) return { deposits: [], claims: [], refunds: [], launches: [], head: 0 }
  const head = parseInt(await rpc('eth_blockNumber', []), 16)
  const [dep, clm, ref, lau] = await Promise.all([
    getLogs(CHAIN.escrow, TOPIC.deposited, CHAIN.fromBlock, head),
    getLogs(CHAIN.escrow, TOPIC.claimed, CHAIN.fromBlock, head),
    getLogs(CHAIN.escrow, TOPIC.refunded, CHAIN.fromBlock, head),
    CHAIN.launcher ? getLogs(CHAIN.launcher, TOPIC.launched, CHAIN.fromBlock, head) : [],
  ])
  const data = {
    head,
    deposits: dep.map(decode.deposit),
    claims: clm.map(decode.claim),
    refunds: ref.map(decode.refund),
    launches: lau.map(decode.launch),
  }
  // claims and refunds carry only the domain hash: name them from the deposits
  const names = new Map([...data.deposits, ...data.launches].map(d => [d.hash, d.domain]))
  for (const e of [...data.claims, ...data.refunds]) e.domain = names.get(e.hash) || ''
  cache = { at: Date.now(), data }
  return data
}

/** Block timestamps (seconds) for a set of block numbers, batched and cached. A block that couldn't be read is asked again. */
const times = new Map()
export async function blockTimes(blocks) {
  const need = [...new Set(blocks)].filter(b => !times.has(b))
  const res = await batch(need.map(b => ({ method: 'eth_getBlockByNumber', params: [hex(b), false] })))
  need.forEach((b, i) => { if (res[i] && res[i].timestamp) times.set(b, parseInt(res[i].timestamp, 16)) })
  return times
}

// ---------- balances ----------
const encodeBalanceOf = (domain, token) => encodeCall(SEL.balanceOf, ['string', 'address'], [domain, token])
/** Live USDG and ETH waiting in escrow for each domain. */
export async function waiting(domains) {
  const list = [...new Set(domains)]
  if (!CHAIN.escrow || !list.length) return new Map()
  const res = await batch(list.flatMap(d => [{ to: CHAIN.escrow, data: encodeBalanceOf(d, CHAIN.usdg) }, { to: CHAIN.escrow, data: encodeBalanceOf(d, ZERO) }]))
  return new Map(list.map((d, i) => [d, { usdg: res[2 * i] ? BigInt(res[2 * i]) : 0n, eth: res[2 * i + 1] ? BigInt(res[2 * i + 1]) : 0n }]))
}

// ---------- prices ----------
let ethUsd = null
/** ETH/USD spot, for showing totals in dollars. USDG is a dollar stablecoin. */
export async function ethPrice() {
  if (ethUsd) return ethUsd
  const sources = [
    ['https://api.coinbase.com/v2/prices/ETH-USD/spot', j => Number(j.data.amount)],
    ['https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd', j => Number(j.ethereum.usd)],
  ]
  for (const [url, read] of sources) {
    try { const v = read(await (await fetch(url)).json()); if (v > 0) return (ethUsd = v) } catch {}
  }
  return 0
}
export const usd = (w, price) => Number(w.usdg) / 1e6 + (Number(w.eth) / 1e18) * price

// ---------- per-domain summary ----------
/** Everything the board and profiles show, per domain, sorted by dollars waiting. */
export async function domains() {
  const a = await activity()
  const by = new Map()
  const get = d => by.get(d) || by.set(d, { domain: d, deposited: { usdg: 0n, eth: 0n }, senders: new Set(), deposits: 0, claims: 0, launches: 0, last: 0, first: Infinity }).get(d)
  for (const e of a.deposits) {
    const s = get(e.domain)
    s.deposits++
    s.senders.add(e.from.toLowerCase())
    if (e.token === ZERO) s.deposited.eth += e.amount; else s.deposited.usdg += e.amount
    s.last = Math.max(s.last, e.block); s.first = Math.min(s.first, e.block)
  }
  for (const e of a.claims) if (e.domain) { const s = get(e.domain); s.claims++; s.last = Math.max(s.last, e.block) }
  for (const e of a.launches) { const s = get(e.domain); s.launches++; s.last = Math.max(s.last, e.block); s.first = Math.min(s.first, e.block) }
  const [w, price] = await Promise.all([waiting([...by.keys()]), ethPrice()])
  const list = [...by.values()].map(s => ({ ...s, supporters: s.senders.size, waiting: w.get(s.domain) || { usdg: 0n, eth: 0n } }))
  for (const s of list) s.usd = usd(s.waiting, price)
  list.sort((x, y) => y.usd - x.usd || y.last - x.last)
  return { list, price, activity: a }
}

// ---------- formatting ----------
export const money = n => (n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e4 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toLocaleString('en', { maximumFractionDigits: 2 })}`)
export const units = (v, dec, max = 4) => {
  const s = v.toString().padStart(dec + 1, '0')
  const frac = s.slice(-dec).replace(/0+$/, '').slice(0, max)
  return Number(s.slice(0, -dec)).toLocaleString('en') + (frac ? `.${frac}` : '')
}
export function ago(ts) {
  const s = Date.now() / 1000 - ts
  return !ts ? '' : s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`
}
export const short = a => `${a.slice(0, 6)}…${a.slice(-4)}`
export const favicon = d => `https://icons.duckduckgo.com/ip3/${encodeURIComponent(d)}.ico`
