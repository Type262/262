// Read-only view of TYPE/262 on Solana for the board, the domain profiles and the landing page.
//
// Every deposit into a domain's vault and every coin launched from the app carries BOARD_REFERENCE (solana-vault.js),
// so one getSignaturesForAddress lists them all, with no indexer. A deposit's memo names its domain; a launch's domain
// is in the coin's metadata. Neither is taken on trust: a deposit counts when its transaction really moved SOL or USDC
// into that domain's vault, a launch when the coin's creator is that domain's vault, and what is waiting is read live
// from the vault. Claims and refunds are the worker's transactions, found in its gas wallet's history by their memos.
import * as sol from './solana.js'
import * as V from './solana-vault.js'
import { normalizeDomain } from '../lib/wallet262.js'

const { USDC } = sol
const TX = { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }
const MAX_DEPOSIT_TXS = 150 // the newest deposit transactions read in full (senders, amounts)
const MAX_CLAIM_TXS = 60
const MAX_LAUNCH_TXS = 60
const MAX_DOMAINS = 150 // the most recently funded domains whose vaults are asked for (the worker allows 240 reads a minute)

async function pool(items, n, fn) {
  const out = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i) }
  }))
  return out
}
// A confirmed transaction doesn't change: each is read once per page, so a 30-second pass reads only the new ones.
const txReads = new Map() // signature -> Promise<transaction or null>
const getTx = signature => {
  if (!txReads.has(signature)) txReads.set(signature, sol.rpc('getTransaction', [signature, TX]).catch(() => null).then(t => { if (!t) txReads.delete(signature); return t }))
  return txReads.get(signature)
}
const domainOf = raw => { try { return normalizeDomain(raw) } catch { return '' } }
const tokenAmount = data => (data && data.length >= 72 ? new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(64, true) : 0n)

// ---------- prices ----------
let solUsd = null
/** SOL/USD spot, for totals in dollars. USDC counts at $1. */
export async function solPrice() {
  if (solUsd) return solUsd
  const sources = [
    ['https://api.coinbase.com/v2/prices/SOL-USD/spot', j => Number(j.data.amount)],
    ['https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', j => Number(j.solana.usd)],
  ]
  for (const [url, read] of sources) {
    try { const v = read(await (await fetch(url)).json()); if (v > 0) return (solUsd = v) } catch {}
  }
  return 0
}
export const usdOf = (w, price) => Number(w.usdc) / 1e6 + (Number(w.sol) / 1e9) * price

// ---------- parsing ----------

/**
 * The SOL or USDC a confirmed transaction (jsonParsed) moved into a vault: { mint: 'SOL' | USDC mint, amount, from },
 * or null. A tagged token transfer lists the reference after its owner, so the RPC names the owner multisigAuthority.
 */
export function depositIn(tx, { vault, usdcAccount }) {
  if (!tx || !tx.meta || tx.meta.err || !tx.transaction) return null
  let out = null
  for (const ix of tx.transaction.message.instructions || []) {
    const p = ix.parsed
    if (!p || typeof p !== 'object' || !p.info) continue
    const i = p.info
    let d = null
    if (ix.program === 'system' && p.type === 'transfer' && i.destination === vault) d = { mint: 'SOL', amount: BigInt(i.lamports), from: i.source }
    else if (ix.program === 'spl-token' && (p.type === 'transferChecked' || p.type === 'transfer') && i.destination === usdcAccount) {
      d = { mint: USDC.mint, amount: BigInt(i.tokenAmount ? i.tokenAmount.amount : i.amount), from: i.authority || i.multisigAuthority || '' }
    }
    if (!d || !d.from) continue
    if (!out) out = d
    else if (out.mint === d.mint && out.from === d.from) out.amount += d.amount
  }
  return out && out.amount > 0n ? out : null
}

/** What a claim transaction paid out of a vault, SOL and USDC (amount and fee together). */
export function paidOut(tx, { vault, usdcAccount }) {
  const out = { sol: 0n, usdc: 0n }
  if (!tx || !tx.meta || tx.meta.err || !tx.transaction) return out
  for (const ix of tx.transaction.message.instructions || []) {
    const p = ix.parsed
    if (!p || typeof p !== 'object' || !p.info) continue
    const i = p.info
    if (ix.program === 'system' && p.type === 'transfer' && i.source === vault) out.sol += BigInt(i.lamports)
    if (ix.program === 'spl-token' && (p.type === 'transferChecked' || p.type === 'transfer') && i.source === usdcAccount) out.usdc += BigInt(i.tokenAmount ? i.tokenAmount.amount : i.amount)
  }
  return out
}

/** The pump.fun create_v2 in a confirmed transaction (jsonParsed): { mint, creator, uri, name, symbol }, or null. */
export function createOf(tx) {
  if (!tx || !tx.meta || tx.meta.err || !tx.transaction) return null
  for (const ix of tx.transaction.message.instructions || []) {
    if (ix.programId !== V.PUMP.program || typeof ix.data !== 'string' || !Array.isArray(ix.accounts)) continue
    let b
    try { b = sol.base58Decode(ix.data) } catch { continue }
    if (b.length < 8 + 12 + 32 || V.DISC.createV2.some((x, i) => b[i] !== x)) continue
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
    let o = 8
    const str = () => {
      const n = view.getUint32(o, true)
      if (o + 4 + n > b.length) throw new Error('short')
      const t = new TextDecoder().decode(b.subarray(o + 4, o + 4 + n))
      o += 4 + n
      return t
    }
    try {
      const name = str(), symbol = str(), uri = str()
      if (o + 32 > b.length) return null
      return { mint: ix.accounts[0], creator: sol.base58Encode(b.subarray(o, o + 32)), uri, name, symbol }
    } catch { return null }
  }
  return null
}

const metaDomains = new Map() // metadata link -> Promise<domain or ''>
/** The domain a coin's metadata names (type262.domain, written by the launch form), or ''. */
export function metadataDomain(uri) {
  if (!/^https:\/\/\S+$/.test(String(uri || ''))) return Promise.resolve('')
  if (!metaDomains.has(uri)) {
    metaDomains.set(uri, V.fetchJson(uri, 15_000)
      // a link that can't be read now is tried again in 5 minutes, not on every pass
      .then(j => domainOf(j && j.type262 && j.type262.domain)).catch(() => { setTimeout(() => metaDomains.delete(uri), 300_000); return '' }))
  }
  return metaDomains.get(uri)
}

// ---------- the index ----------

/**
 * Everything tagged, newest first: deposits by their memos [{ kind: 'deposit', domain, signature, time }], and the
 * other tagged transactions, the launches to check [{ signature, time }]. A transaction that funds several vaults
 * (Escrow, Many domains) has a memo per domain and gives an entry per domain, each checked against its own vault.
 */
export async function index({ pages = 3 } = {}) {
  const sigs = await V.history([V.BOARD_REFERENCE], { pages })
  const deposits = [], others = []
  for (const s of sigs) {
    if (s.err) continue
    const domains = [...new Set(V.memos(s.memo).map(V.parseBoardMemo).filter(Boolean).map(t => domainOf(t.domain)).filter(Boolean))]
    for (const domain of domains) deposits.push({ kind: 'deposit', domain, signature: s.signature, time: s.blockTime || 0 })
    if (!domains.length) others.push({ signature: s.signature, time: s.blockTime || 0 })
  }
  return { deposits, others }
}

/** The tagged launches whose coin's creator is the vault of the domain its metadata names. `lost` hears failed lookups. */
async function verifiedLaunches(others, lost = () => {}) {
  const list = others.slice(0, MAX_LAUNCH_TXS)
  const txs = await pool(list, 4, s => getTx(s.signature))
  const creates = list.map((s, i) => ({ ...s, c: createOf(txs[i]) })).filter(x => x.c)
  const domains = await pool(creates, 4, x => metadataDomain(x.c.uri))
  const checked = await pool(creates, 4, async (x, i) => {
    const domain = domains[i]
    if (!domain) return null
    const v = await V.getVault(domain).catch(err => { lost(err); return null })
    return v && v.vault === x.c.creator ? { chain: 'solana', kind: 'launch', domain, signature: x.signature, time: x.time, mint: x.c.mint, name: x.c.name, symbol: x.c.symbol, uri: x.c.uri } : null
  })
  return checked.filter(Boolean)
}

/** The worker's claims and refunds, from its gas wallet's history: [{ kind, domain | deposit, signature, time }]. */
async function workerEvents() {
  const status = await V.getStatus().catch(() => null)
  if (!status || !status.gasWallet) return []
  const sigs = await V.history([status.gasWallet], { pages: 1 })
  const out = []
  for (const s of sigs) {
    if (s.err) continue
    for (const m of V.memos(s.memo)) {
      if (m.startsWith('type262:claim:')) { const domain = domainOf(m.slice(14)); if (domain) out.push({ kind: 'claim', domain, signature: s.signature, time: s.blockTime || 0 }) }
      if (m.startsWith('type262:refund:')) out.push({ kind: 'refund', deposit: m.slice(15), signature: s.signature, time: s.blockTime || 0 })
    }
  }
  return out
}

const curveReads = new Map() // vault -> { at, p }
/**
 * How many pump.fun coins a vault is the creator of, and the creator fees still on their curves (SOL-quoted coins):
 * { n, fees }. One getProgramAccounts with a 166-byte slice per curve, kept for 5 minutes; the profile reads the rest.
 */
function curvesOf(vault) {
  const hit = curveReads.get(vault)
  if (hit && Date.now() - hit.at < 300_000) return hit.p
  const p = V.programAccounts([V.PUMP.program, {
    encoding: 'base64', commitment: 'confirmed', dataSlice: { offset: 0, length: 166 },
    filters: [{ memcmp: { offset: 0, bytes: sol.base58Encode(V.DISC.bondingCurve) } }, { memcmp: { offset: 49, bytes: vault } }],
  }]).then(list => {
    const curves = (list || []).map(a => V.decodeCurve(sol.base64Decode(a.account.data[0]))).filter(c => c.creator === vault)
    const solQuoted = curves.filter(c => c.quoteMint === V.WSOL || c.quoteMint === sol.SYSTEM_PROGRAM)
    return { n: curves.length, fees: solQuoted.reduce((n, c) => n + c.creatorFee, 0n) }
  }).catch(err => { curveReads.delete(vault); throw err })
  curveReads.set(vault, { at: Date.now(), p })
  return p
}

// ---------- the explorer ----------

let launchRead = null // { at, p }
/**
 * The coins launched through TYPE/262 that check out (each one's creator is the vault of the domain its metadata
 * names), newest first, with their curves read live: { coins: [{ domain, mint, name, symbol, uri, time, signature,
 * mcap, progress, complete, ...the curve }], capped }. `capped` says older launches were left out. Kept for 30 s.
 */
export function launchedCoins({ force = false } = {}) {
  if (!force && launchRead && Date.now() - launchRead.at < 30_000) return launchRead.p
  const p = (async () => {
    const idx = await index()
    let lost = null
    const launches = await verifiedLaunches(idx.others, err => { lost = err })
    // no launch checks out because the worker can't be reached: an error, not an empty list
    if (lost && !launches.length) throw lost
    const unique = launches.filter((l, i) => launches.findIndex(x => x.mint === l.mint) === i)
    const curves = new Map((await V.coinsByMint(unique.map(l => l.mint))).map(c => [c.mint, c]))
    const coins = unique.map(l => {
      const c = curves.get(l.mint) || {}
      return { ...c, ...l, name: c.name || l.name, symbol: c.symbol || l.symbol, uri: c.uri || l.uri }
    })
    return { coins, capped: idx.others.length > MAX_LAUNCH_TXS }
  })()
  launchRead = { at: Date.now(), p }
  p.catch(() => { if (launchRead && launchRead.p === p) launchRead = null })
  return p
}

// ---------- the board ----------

let cache = null
/**
 * Every domain with money or coins on Solana, and the activity behind it (cached for 30 s):
 * { list: [{ chain: 'solana', domain, vault, waiting: { sol, usdc, fees }, usd, supporters (Set), deposits, launches,
 *   claims, first, last }], activity: [{ chain, kind, domain, signature, time, mint, amount, from }], price }.
 */
export async function solanaDomains() {
  if (cache && Date.now() - cache.at < 30_000) return cache.data
  const [idx, work, price] = await Promise.all([index(), workerEvents(), solPrice()])
  let lost = null
  const launched = await verifiedLaunches(idx.others, err => { lost = err })
  // a memo costs next to nothing and the worker's reads are limited: only the most recently funded domains are asked for
  const funded = [...new Set(idx.deposits.map(e => e.domain))].slice(0, MAX_DOMAINS)
  const names = [...new Set([...funded, ...launched.map(e => e.domain)])]
  const infos = await pool(names, 6, d => V.getVault(d).catch(err => { lost = err; return null }))
  const vaultOf = new Map(names.map((d, i) => [d, infos[i]]).filter(([, v]) => v))
  // no vault at all means the worker can't be reached, which is not the same as an empty board
  if (lost && !vaultOf.size) throw lost
  const known = [...vaultOf.keys()]

  // balances: the vault (SOL), its USDC account, pump.fun's creator vault for it (fees swept, not collected yet) and
  // PumpSwap's (graduated coins' fees, in wSOL); fees still on the coins' curves are added below
  const pumpVaults = await Promise.all(known.map(async d => {
    const v = vaultOf.get(d).vault
    return [await V.pumpPda.creatorVault(v), await V.ata(await V.pumpPda.ammCreatorVault(v), V.WSOL)]
  }))
  const accounts = await V.getAccounts(known.flatMap((d, i) => [vaultOf.get(d).vault, vaultOf.get(d).usdcAccount, ...pumpVaults[i]]))
  const rent0 = await V.rentExempt(0).catch(() => 890_880n)
  const waiting = new Map(known.map((d, i) => {
    const [v, u, c, a] = accounts.slice(i * 4, i * 4 + 4)
    const swept = c && c.lamports > rent0 ? c.lamports - rent0 : 0n
    return [d, { sol: v ? v.lamports : 0n, usdc: u ? tokenAmount(u.data) : 0n, fees: swept + (a ? tokenAmount(a.data) : 0n) }]
  }))

  // deposits: only those that really moved SOL or USDC into the named domain's vault
  // the newest MAX_DEPOSIT_TXS transactions, each with every vault it funded: a batch takes one, however many domains
  const recent = new Set()
  const tagged = idx.deposits.filter(e => {
    if (!vaultOf.has(e.domain)) return false
    if (!recent.has(e.signature)) { if (recent.size >= MAX_DEPOSIT_TXS) return false; recent.add(e.signature) }
    return true
  })
  const txs = await pool(tagged, 4, e => getTx(e.signature))
  const deposits = []
  tagged.forEach((e, i) => {
    const d = depositIn(txs[i], vaultOf.get(e.domain))
    if (d) deposits.push({ chain: 'solana', kind: 'deposit', domain: e.domain, signature: e.signature, time: e.time, ...d })
  })

  // launches: checked above against the coin's creator; a domain's coin count is every pump.fun coin its vault created,
  // and the creator fees still on those coins' curves wait for it too
  const launches = launched.filter(e => vaultOf.has(e.domain))
  const launchDomains = [...new Set(launches.map(e => e.domain))]
  const coinReads = await pool(launchDomains, 3, d => curvesOf(vaultOf.get(d).vault).catch(() => null))
  const coins = new Map(launchDomains.map((d, i) => [d, coinReads[i]]))
  for (const [d, c] of coins) if (c) waiting.get(d).fees += c.fees

  // claims and refunds: anyone can write the worker's memos, so each counts only if money really left the vault
  const claimEvents = work.filter(e => e.kind === 'claim' && vaultOf.has(e.domain)).slice(0, MAX_CLAIM_TXS)
  const bySig = new Map() // deposit signature -> its deposits, one per vault it funded
  for (const d of deposits) bySig.set(d.signature, [...(bySig.get(d.signature) || []), d])
  const refundEvents = work.filter(e => e.kind === 'refund' && bySig.has(e.deposit)).slice(0, MAX_CLAIM_TXS)
  const outTxs = await pool([...claimEvents, ...refundEvents], 4, e => getTx(e.signature))
  const moved = p => p.sol > 0n || p.usdc > 0n
  const claims = claimEvents.map((e, i) => ({ chain: 'solana', ...e, paid: paidOut(outTxs[i], vaultOf.get(e.domain)) })).filter(e => moved(e.paid))
  // a refund is of the deposit whose vault it paid out of
  const refunds = refundEvents.flatMap((e, i) => {
    const d = bySig.get(e.deposit).find(x => moved(paidOut(outTxs[claimEvents.length + i], vaultOf.get(x.domain))))
    return d ? [{ chain: 'solana', kind: 'refund', domain: d.domain, signature: e.signature, time: e.time, mint: d.mint, amount: d.amount, from: d.from }] : []
  })

  const by = new Map()
  const get = d => by.get(d) || by.set(d, { chain: 'solana', domain: d, vault: vaultOf.get(d).vault, supporters: new Set(), deposits: 0, launches: 0, claims: 0, first: Infinity, last: 0 }).get(d)
  const seen = (s, t) => { if (t) { s.first = Math.min(s.first, t); s.last = Math.max(s.last, t) } }
  for (const e of deposits) { const s = get(e.domain); s.deposits++; s.supporters.add(e.from); seen(s, e.time) }
  // pump.fun's own count (it includes coins launched elsewhere), or the launches seen here when it can't be read
  for (const d of launchDomains) {
    const seen = launches.filter(e => e.domain === d).length
    get(d).launches = coins.get(d) ? Math.max(coins.get(d).n, seen) : seen
  }
  for (const e of launches) seen(get(e.domain), e.time)
  for (const e of claims) { const s = get(e.domain); s.claims++; seen(s, e.time) }
  // a vault with a balance is on the board even if its deposits are older than the index's window
  for (const [d, w] of waiting) if (w.sol > 0n || w.usdc > 0n || w.fees > 0n) get(d)
  const list = [...by.values()].map(s => {
    const w = waiting.get(s.domain) || { sol: 0n, usdc: 0n, fees: 0n }
    const total = { sol: w.sol + w.fees, usdc: w.usdc }
    return { ...s, waiting: w, usd: usdOf(total, price), first: Number.isFinite(s.first) ? s.first : s.last }
  })
  const data = { list, activity: [...deposits, ...launches, ...claims, ...refunds], price }
  cache = { at: Date.now(), data }
  return data
}

// ---------- one domain's profile ----------

/**
 * One domain on Solana, whether or not it is on the board: its vault, what it holds, its pump.fun coins and the fees
 * waiting for them, and its recent history. { vault, usdcAccount, holdings, coins, coinsRead, fees, waiting: { sol, usdc, fees },
 * activity, supporters: Map(address -> { sol, usdc, n }), claimed: { sol, usdc } }.
 */
export async function solanaProfile(domain) {
  const info = await V.getVault(domain)
  // readVault lists every token; if that read fails, SOL and USDC alone still show
  const basic = async () => {
    const [v, u] = await V.getAccounts([info.vault, info.usdcAccount])
    const usdc = u ? tokenAmount(u.data) : 0n
    return { exists: !!v, owner: v ? v.owner : '', lamports: v ? v.lamports : 0n, tokens: usdc ? [{ account: info.usdcAccount, mint: USDC.mint, amount: usdc, decimals: 6, symbol: 'USDC', name: 'USD Coin' }] : [] }
  }
  // coins that couldn't be read are not "no coins": coinsRead says which
  const [holdings, found] = await Promise.all([V.readVault(info.vault).catch(basic), V.findCoins(info.vault).catch(() => null)])
  const coins = found || []
  const fees = coins.length ? await V.pendingFees(info.vault, coins).catch(() => null) : null
  const usdc = (holdings.tokens.find(t => t.mint === USDC.mint) || { amount: 0n }).amount
  const sigs = (await V.history([info.vault, info.usdcAccount], { pages: 1 })).filter(s => !s.err).slice(0, 40)
  const txs = await pool(sigs, 4, s => getTx(s.signature))
  const activity = [], supporters = new Map(), claimed = { sol: 0n, usdc: 0n }
  sigs.forEach((s, i) => {
    const ms = V.memos(s.memo)
    const base = { chain: 'solana', domain, signature: s.signature, time: s.blockTime || 0 }
    // anyone can write the worker's memos: a claim or a refund is money that left the vault
    if (ms.includes(V.claimMemo(domain))) {
      const paid = paidOut(txs[i], info)
      if (paid.sol || paid.usdc) {
        claimed.sol += paid.sol; claimed.usdc += paid.usdc
        activity.push({ ...base, kind: 'claim', paid })
      }
      return
    }
    if (ms.some(m => m.startsWith('type262:refund:'))) { const r = paidOutRefund(txs[i], info); if (r.amount) activity.push({ ...base, kind: 'refund', ...r }); return }
    if (ms.some(m => m.startsWith('type262:'))) return // the worker's collects and other bookkeeping
    const d = depositIn(txs[i], info)
    if (!d) return
    activity.push({ ...base, kind: 'deposit', ...d })
    const v = supporters.get(d.from) || { sol: 0n, usdc: 0n, n: 0 }
    if (d.mint === 'SOL') v.sol += d.amount; else v.usdc += d.amount
    v.n++
    supporters.set(d.from, v)
  })
  return {
    vault: info.vault, usdcAccount: info.usdcAccount, holdings, coins, coinsRead: !!found, fees,
    waiting: { sol: holdings.lamports, usdc, fees: fees ? fees.total : 0n }, activity, supporters, claimed,
  }
}

/** A refund's amount and recipient: the transfer out of the vault. */
function paidOutRefund(tx, info) {
  const paid = paidOut(tx, info)
  if (!tx || !tx.transaction) return {}
  for (const ix of tx.transaction.message.instructions || []) {
    const p = ix.parsed, i = p && p.info
    if (!i) continue
    if (ix.program === 'system' && p.type === 'transfer' && i.source === info.vault) return { mint: 'SOL', amount: paid.sol, from: i.destination }
    if (ix.program === 'spl-token' && i.source === info.usdcAccount) return { mint: USDC.mint, amount: paid.usdc, from: i.destination || '' }
  }
  return {}
}
