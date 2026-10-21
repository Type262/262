// Solana vaults. Every domain has its own Solana address, its vault, which the TYPE/262 worker (the type262-upload
// service) derives from a server secret and holds the key to. Anyone can send SOL, USDC or other tokens to it. The
// worker pays everything in it to the address the domain publishes in a DNSSEC-signed _wallet record, less the claim
// fee, and pays a deposit back to its sender once it has waited 180 days unclaimed. A pump.fun coin launched for a
// domain names the vault as its creator, so the coin's creator fees end up there too.
//
// This is the browser side: the worker's HTTP API, reads of a vault on Solana (balances, history, the coins it is
// the creator of), and the pump.fun instructions sent from the user's own wallet: create_v2 and the opening buy_v3
// of a launch, and the permissionless sweep and collect instructions anyone can pay for. The builders are ported
// from solana/scripts/pump-ix.mjs (run against mainnet in simulation); test/solana-vault.test.mjs checks them byte
// for byte. Nothing here but solana.js underneath.
import * as config from './config.js'
import * as sol from './solana.js'

const { SYSTEM_PROGRAM, TOKEN_PROGRAM, ATA_PROGRAM, USDC, base58Encode, base64Decode, pubkeyBytes } = sol

export const WORKER_URL = String(config.WORKER_URL || config.UPLOAD_URL || 'https://type262-upload.onrender.com').replace(/\/+$/, '')
// The read-only RPC on the same service, the one Solana RPC here that answers getProgramAccounts on pump.fun.
const FALLBACK_RPC = config.SOLANA_RPC_FALLBACK || 'https://type262-upload.onrender.com/rpc/solana'
// What the worker charges and waits for, until GET /solana/status says otherwise.
export const FEE_BPS = 50
export const REFUND_DELAY_DAYS = 180
export const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
export const WSOL = 'So11111111111111111111111111111111111111112'
export const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111'
export const LEGACY_LIMIT = 1232

// The memos the worker writes on its payouts; the vault's history is the only record of claims and refunds.
export const claimMemo = domain => `type262:claim:${domain}`
export const refundMemo = signature => `type262:refund:${signature}`

// The board's index. Every deposit into a vault and every coin launched from the app carries BOARD_REFERENCE as a
// read-only account (the Solana Pay "reference" pattern), so one getSignaturesForAddress lists them all with no
// indexer (solana-board.js). The reference is a program address of the memo program, so nothing can sign for it.
// A deposit also carries a memo naming the domain; it doesn't start with "type262:", the prefix of the worker's own
// claim and refund memos, so a tagged deposit is still a deposit to every reader of a vault's history. A launch has
// no room for a memo (its one transaction is within bytes of the limit): its domain is in the coin's metadata.
export const BOARD_REFERENCE = '5GQzZAjkdEfEU5CNL9KakKjZeWC1bFUdYKMXtajtZX8H'
export const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
export const boardMemo = (kind, domain) => `TYPE/262 ${kind} ${domain}`
export const memoIx = text => ({ programId: MEMO_PROGRAM, keys: [], data: new TextEncoder().encode(text) })
/** The instruction with BOARD_REFERENCE appended as a read-only, non-signer account, which transfers ignore. */
export const withReference = ix => ({ ...ix, keys: [...ix.keys, { pubkey: BOARD_REFERENCE, isSigner: false, isWritable: false }] })
/** { kind: 'deposit', domain } for a board memo, null for anything else. */
export function parseBoardMemo(text) {
  const m = /^TYPE\/262 (deposit) (\S{1,253})$/.exec(String(text || ''))
  return m ? { kind: m[1], domain: m[2] } : null
}
/** A launch without an opening buy carries the reference on a zero-lamport transfer to the payer itself. */
export const launchTag = payer => withReference(sol.systemTransfer(payer, payer, 0n))

// pump.fun (solana/docs/PUMP.md has where each comes from; the tests derive the PDAs again)
export const PUMP = {
  program: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  amm: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
  mayhem: 'MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e',
  global: '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf',
  mintAuthority: 'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM',
  eventAuthority: 'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1',
  feeConfig: '8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt',
  ammGlobalConfig: 'ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw',
  ammEventAuthority: 'GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR',
  mayhemGlobalParams: '13ec7XdrjF3h3YcqBTFDSReRcUFwbCnJaAQspM4j6DDJ',
  mayhemSolVault: 'BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s',
  // Global.buyback_fee_recipients[0]: a buy may name any of the eight; this one until Global has been read.
  buyback: '5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD',
}

// ---------- bytes ----------

const enc = new TextEncoder()
const hex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
const unhex = h => Uint8Array.from(h.match(/../g), x => parseInt(x, 16))
const cat = parts => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let i = 0
  for (const p of parts) { out.set(p, i); i += p.length }
  return out
}
const u8 = n => Uint8Array.of(n)
const bool = v => Uint8Array.of(v ? 1 : 0)
const u32 = n => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b }
const u64 = v => {
  const n = BigInt(v)
  if (n < 0n || n >= 1n << 64n) throw new Error('Amount out of range')
  const b = new Uint8Array(8)
  new DataView(b.buffer).setBigUint64(0, n, true)
  return b
}
const str = s => { const b = enc.encode(String(s)); return cat([u32(b.length), b]) }
const key = a => pubkeyBytes(a)
const big = v => { try { return BigInt(String(v ?? 0)) } catch { return 0n } }
const view = b => new DataView(b.buffer, b.byteOffset, b.byteLength)
const keyAt = (b, at) => base58Encode(b.slice(at, at + 32))

/** Anchor discriminators, sha256("global:<name>")[..8] and sha256("account:<name>")[..8], checked in the tests. */
export const DISC = {
  createV2: unhex('d6904cec5f8b31b4'),
  buyV3: unhex('07051dc4f5176550'),
  sweepCreatorFee: unhex('20f6bf3408c949ba'), // the same name, and bytes, on pump and PumpSwap
  collectCreatorFeeV2: unhex('cf118af204221338'),
  collectCoinCreatorFee: unhex('a039592ab58b2b42'),
  bondingCurve: unhex('17b7f83760d8ac60'),
}

/** Runs fn over items, at most n at a time; results in input order. */
async function mapLimit(items, n, fn) {
  const out = new Array(items.length)
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k) }
  }))
  return out
}

// ---------- the worker ----------

async function call(path, { body, timeout = 30_000, late } = {}) {
  let res
  try {
    res = await fetch(`${WORKER_URL}${path}`, {
      method: body ? 'POST' : 'GET',
      ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeout),
    })
  } catch (err) {
    const timedOut = err && err.name === 'TimeoutError'
    throw Object.assign(new Error(timedOut
      ? late || 'The TYPE/262 worker took too long to answer. Try again in a moment.'
      : "Can't reach the TYPE/262 worker right now. Try again in a moment."), { unreachable: true, timedOut })
  }
  const j = await res.json().catch(() => null)
  if (!res.ok || !j || typeof j !== 'object' || j.error) {
    // Errors are { error, reason }: the reason is written for people.
    const reason = j && (typeof j.reason === 'string' && j.reason ? j.reason : typeof j.error === 'string' ? j.error : '')
    throw Object.assign(new Error(reason || `The TYPE/262 worker answered ${res.status}. Try again in a moment.`), {
      code: j && typeof j.error === 'string' ? j.error : '', status: res.status, unreachable: !j && res.status >= 500,
    })
  }
  return j
}

const vaults = new Map()
/**
 * { domain, vault, usdcAccount } for a domain, from GET /solana/vault. The vault can only come from the worker (it
 * holds the secret it is derived from); its USDC account is derived here and must match what the worker says.
 */
export function getVault(domain) {
  const d = String(domain || '')
  if (!vaults.has(d)) {
    vaults.set(d, call(`/solana/vault?domain=${encodeURIComponent(d)}`, { timeout: 75_000 }).then(async j => {
      if (!sol.isAddress(j.vault)) throw new Error("The worker's answer had no vault address. Try again in a moment.")
      const usdcAccount = await sol.associatedTokenAddress(j.vault, USDC.mint)
      if (j.usdcAccount && j.usdcAccount !== usdcAccount) throw new Error("The worker's USDC account isn't this vault's. Nothing was sent.")
      return { domain: typeof j.domain === 'string' && j.domain ? j.domain : d, vault: j.vault, usdcAccount }
    }).catch(err => { vaults.delete(d); throw err }))
  }
  return vaults.get(d)
}

let statusAt = 0
let statusP = null
/** { gasWallet, gasLamports, feeWallet, feeBps, refundDelayDays } from GET /solana/status, kept for a minute. */
export function getStatus() {
  if (!statusP || Date.now() - statusAt > 60_000) {
    statusAt = Date.now()
    statusP = call('/solana/status', { timeout: 75_000 }).then(j => ({
      gasWallet: sol.isAddress(j.gasWallet) ? j.gasWallet : '',
      gasLamports: big(j.gasLamports),
      feeWallet: sol.isAddress(j.feeWallet) ? j.feeWallet : '',
      feeBps: Number.isFinite(Number(j.feeBps)) && j.feeBps !== null ? Number(j.feeBps) : FEE_BPS,
      refundDelayDays: Number(j.refundDelayDays) > 0 ? Number(j.refundDelayDays) : REFUND_DELAY_DAYS,
    })).catch(err => { statusP = null; throw err })
  }
  return statusP
}

// Each entry is one source of creator fees (a coin's curve or pool, or pump's creator vaults); one transaction can
// move several, so they add up to what the vault gained. A coin's entry names its mint, but the amount is lamports.
const collected = list => (Array.isArray(list) ? list : []).map(c => ({ mint: c.mint || 'SOL', lamports: big(c.lamports ?? c.amount), source: c.source || '' }))
const signatures = list => (Array.isArray(list) ? list : []).filter(s => typeof s === 'string' && s)
const decimalsOf = v => (Number.isInteger(Number(v)) && v !== null && v !== undefined && v !== '' ? Number(v) : null)

/**
 * POST /solana/claim: the worker checks the domain's _wallet record (two resolvers, DNSSEC), collects its pump.fun
 * fees and pays the vault out. { domain, wallet, collected: [{ mint, lamports, source }], payouts: [{ mint, amount,
 * fee, decimals, signature }], signatures, skipped: [{ mint, reason }] }, amounts as BigInt. `skipped` is what this
 * claim left in the vault, and why.
 */
export async function claim(domain) {
  const j = await call('/solana/claim', { body: { domain }, timeout: 240_000, late: 'The worker is still working on this claim. Give it a minute, then look the domain up again before claiming twice.' })
  return {
    domain: j.domain || domain, wallet: j.wallet || '', collected: collected(j.collected),
    payouts: (Array.isArray(j.payouts) ? j.payouts : []).map(p => ({ mint: p.mint || 'SOL', amount: big(p.amount), fee: big(p.fee), decimals: decimalsOf(p.decimals), signature: p.signature || '' })),
    signatures: signatures(j.signatures),
    skipped: (Array.isArray(j.skipped) ? j.skipped : []).filter(s => s && typeof s.reason === 'string').map(s => ({ mint: s.mint || null, reason: s.reason })),
  }
}

/**
 * POST /solana/collect: moves the domain's pump.fun creator fees into its vault. { domain, collected, signatures,
 * pending }: `pending` lamports stay at pump.fun when they are too few to open an empty vault.
 */
export async function collect(domain) {
  const j = await call('/solana/collect', { body: { domain }, timeout: 180_000, late: 'The worker is still collecting. Look the domain up again in a minute.' })
  return { domain: j.domain || domain, collected: collected(j.collected), signatures: signatures(j.signatures), pending: big(j.pending) }
}

/** POST /solana/refund: pays a deposit back to its sender. { refunded: { mint, amount, decimals, to }, signature }. */
export async function refund(domain, signature) {
  const j = await call('/solana/refund', { body: { domain, signature }, timeout: 180_000, late: 'The worker is still working on this refund. Look the domain up again in a minute.' })
  const r = j.refunded || {}
  return { refunded: { mint: r.mint || 'SOL', amount: big(r.amount), decimals: decimalsOf(r.decimals), to: r.to || '' }, signature: j.signature || '' }
}

/** True for the ways the worker may write SOL as a mint. */
export const isSolMint = mint => !mint || mint === 'SOL' || mint === SYSTEM_PROGRAM

// ---------- reads ----------

/** Accounts as { address, owner, lamports, data, executable } (null when missing), 100 per call. */
export async function getAccounts(addresses) {
  const out = []
  for (let i = 0; i < addresses.length; i += 100) {
    const batch = addresses.slice(i, i + 100)
    const { value } = await sol.rpc('getMultipleAccounts', [batch, { encoding: 'base64', commitment: 'confirmed' }])
    batch.forEach((address, j) => {
      const a = value[j]
      out.push(a ? { address, owner: a.owner, lamports: BigInt(a.lamports), data: base64Decode(a.data[0]), executable: !!a.executable } : null)
    })
  }
  return out
}

const rents = new Map()
/** The rent-exempt minimum for `size` bytes, from the cluster (mainnet's rate has changed before). */
export function rentExempt(size) {
  if (!rents.has(size)) rents.set(size, sol.rpc('getMinimumBalanceForRentExemption', [size]).then(BigInt).catch(err => { rents.delete(size); throw err }))
  return rents.get(size)
}

/** getProgramAccounts through the read-only fallback first: public RPCs refuse it on pump.fun's program. */
export async function programAccounts(params) {
  try {
    const res = await fetch(FALLBACK_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getProgramAccounts', params }), signal: AbortSignal.timeout(75_000) })
    const j = await res.json()
    if (j.error) throw Object.assign(new Error(j.error.message || 'RPC error'), { rpc: true })
    return j.result
  } catch (err) {
    if (err.rpc) throw err
    return sol.rpc('getProgramAccounts', params)
  }
}

const TOKEN_PROGRAMS = new Set([TOKEN_PROGRAM, TOKEN_2022])
const known = mint => (mint === USDC.mint ? { symbol: 'USDC', name: 'USD Coin' } : mint === WSOL ? { symbol: 'wSOL', name: 'Wrapped SOL' } : null)

/** Name, symbol and metadata URI of Token-2022 mints that carry them, by mint. */
export async function tokenNames(mints) {
  const out = new Map()
  const list = [...new Set(mints)].filter(m => !known(m))
  for (let i = 0; i < list.length; i += 100) {
    const { value } = await sol.rpc('getMultipleAccounts', [list.slice(i, i + 100), { encoding: 'jsonParsed', commitment: 'confirmed' }])
    value.forEach((a, j) => {
      const info = a && a.data && a.data.parsed && a.data.parsed.info
      const md = info && (info.extensions || []).find(e => e.extension === 'tokenMetadata')
      if (md && md.state) out.set(list[i + j], { name: String(md.state.name || ''), symbol: String(md.state.symbol || ''), uri: String(md.state.uri || '') })
    })
  }
  return out
}

/**
 * What a vault holds: { exists, owner, lamports, tokens: [{ account, mint, program, amount, decimals, symbol, name }] },
 * USDC first, empty token accounts left out.
 */
export async function readVault(vault) {
  const byOwner = program => sol.rpc('getTokenAccountsByOwner', [vault, { programId: program }, { encoding: 'jsonParsed', commitment: 'confirmed' }]).then(r => r.value)
  const [info, spl, t22] = await Promise.all([sol.getAccountInfo(vault), byOwner(TOKEN_PROGRAM), byOwner(TOKEN_2022)])
  const tokens = [...spl.map(a => [a, TOKEN_PROGRAM]), ...t22.map(a => [a, TOKEN_2022])].map(([a, program]) => {
    const t = a.account.data.parsed.info
    return { account: a.pubkey, mint: t.mint, program, amount: big(t.tokenAmount.amount), decimals: Number(t.tokenAmount.decimals) || 0 }
  }).filter(t => t.amount > 0n)
  const names = await tokenNames(tokens.map(t => t.mint)).catch(() => new Map())
  for (const t of tokens) Object.assign(t, known(t.mint) || names.get(t.mint) || { symbol: '', name: '' })
  tokens.sort((a, b) => (b.mint === USDC.mint) - (a.mint === USDC.mint))
  return { exists: !!info, owner: info ? info.owner : '', lamports: info ? BigInt(info.lamports) : 0n, tokens }
}

/**
 * What an address is on Solana: 'new' (no account yet), 'wallet' (system-owned), 'program', 'mint', 'token-account'
 * or 'other'. The worker only pays a wallet or a new address.
 */
export async function addressType(address) {
  const a = await sol.getAccountInfo(address)
  if (!a) return 'new'
  if (a.executable) return 'program'
  if (a.owner === SYSTEM_PROGRAM) return 'wallet'
  if (TOKEN_PROGRAMS.has(a.owner)) {
    const len = a.space ?? base64Decode(a.data[0]).length
    const type = len > 165 ? base64Decode(a.data[0])[165] : 0
    return len === 165 || type === 2 ? 'token-account' : 'mint'
  }
  return 'other'
}

// ---------- the vault's history: deposits, claims, refunds ----------

/** Signatures touching any of `addresses` (failed ones included), newest first, up to `pages` of 1,000 each. */
export async function history(addresses, { pages = 3 } = {}) {
  const seen = new Map()
  await Promise.all([...new Set(addresses.filter(Boolean))].map(async address => {
    let before
    for (let i = 0; i < pages; i++) {
      const list = await sol.rpc('getSignaturesForAddress', [address, { limit: 1000, commitment: 'confirmed', ...(before ? { before } : {}) }])
      for (const s of list) {
        if (!seen.has(s.signature)) seen.set(s.signature, { signature: s.signature, slot: Number(s.slot) || 0, blockTime: s.blockTime ?? null, memo: s.memo || '', err: s.err || null })
      }
      if (list.length < 1000) break
      before = list.at(-1).signature
    }
  }))
  return [...seen.values()].sort((a, b) => b.slot - a.slot)
}

/** The memos of a signature as RPC lists them ("[27] type262:claim:example.com; [12] …"), without the length tags. */
export const memos = memo => String(memo || '').split(/;\s*(?=\[\d+\])/).map(m => m.replace(/^\[\d+\]\s*/, '').trim()).filter(Boolean)

/** The newest claim of `domain` in a vault's history, and the deposits it has refunded. */
export function vaultEvents(sigs, domain) {
  const claimText = claimMemo(domain)
  const ok = sigs.filter(s => !s.err)
  const lastClaim = ok.find(s => memos(s.memo).includes(claimText)) || null
  const refunded = new Set()
  for (const s of ok) for (const m of memos(s.memo)) if (m.startsWith('type262:refund:')) refunded.add(m.slice(15))
  return { lastClaim, refunded }
}

const TOKEN_PARSED = new Set(['spl-token', 'spl-token-2022'])

/**
 * The deposit a transaction made into a vault from `from`, or null: { mint ('SOL' or the token mint), amount,
 * decimals }. Reads plain transfers only (system transfer, token transfer or transferChecked) at the top level of a
 * jsonParsed transaction. `accounts` are the vault's token accounts.
 */
export function parseDeposit(tx, { vault, accounts = [], from }) {
  if (!tx || !tx.transaction || (tx.meta && tx.meta.err)) return null
  const msg = tx.transaction.message
  const keys = msg.accountKeys.map(k => (typeof k === 'string' ? k : k.pubkey))
  const post = (tx.meta && tx.meta.postTokenBalances) || []
  const balanceOf = account => post.find(b => b.accountIndex === keys.indexOf(account)) || null
  let out = null
  const add = (mint, amount, decimals) => {
    if (!out) out = { mint, amount: 0n, decimals }
    if (out.mint === mint) out.amount += amount
  }
  for (const ix of msg.instructions || []) {
    const p = ix.parsed
    if (!p || typeof p !== 'object' || !p.info) continue
    const info = p.info
    if (ix.program === 'system' && p.type === 'transfer' && info.destination === vault && info.source === from) add('SOL', big(info.lamports), 9)
    if (TOKEN_PARSED.has(ix.program) && (p.type === 'transfer' || p.type === 'transferChecked') && (info.authority === from || info.multisigAuthority === from)) {
      const dest = balanceOf(info.destination)
      if (!accounts.includes(info.destination) && !(dest && dest.owner === vault)) continue
      const mint = info.mint || (dest && dest.mint)
      if (!mint) continue
      const decimals = info.tokenAmount ? Number(info.tokenAmount.decimals) : dest ? Number(dest.uiTokenAmount.decimals) : 0
      add(mint, big(info.tokenAmount ? info.tokenAmount.amount : info.amount), decimals)
    }
  }
  return out && out.amount > 0n ? out : null
}

/**
 * The deposits `from` made into a vault since the domain's last claim, not refunded yet: [{ signature, blockTime,
 * mint, amount, decimals, refundableAt, refundable }], oldest first. Reads at most `max` transactions past the
 * refund delay and the 10 newest before it; `truncated` says there were more.
 */
export async function findDeposits({ domain, vault, accounts = [], from, delayDays = REFUND_DELAY_DAYS, now = Date.now() / 1000, max = 30 }) {
  const sigs = await history([vault, ...accounts])
  const { lastClaim, refunded } = vaultEvents(sigs, domain)
  const after = lastClaim ? lastClaim.slot : -1
  const delay = delayDays * 86_400
  const open = sigs.filter(s => !s.err && s.slot > after && !refunded.has(s.signature) && !memos(s.memo).some(m => m.startsWith('type262:')))
  // Those past the delay can come back now, so they come first; then the newest, which can come back later.
  const due = open.filter(s => s.blockTime && now - s.blockTime >= delay)
  const later = open.filter(s => !due.includes(s))
  const pick = [...due.slice(0, max), ...later.slice(0, 10)]
  const txs = await mapLimit(pick, 3, s => sol.rpc('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]).catch(() => null))
  const deposits = []
  pick.forEach((s, i) => {
    const d = parseDeposit(txs[i], { vault, accounts, from })
    if (!d) return
    const blockTime = Number(s.blockTime || (txs[i] && txs[i].blockTime) || 0)
    const refundableAt = blockTime + delay
    deposits.push({ signature: s.signature, blockTime, ...d, refundableAt, refundable: !!blockTime && now >= refundableAt })
  })
  deposits.sort((a, b) => a.blockTime - b.blockTime)
  return { deposits, lastClaim, truncated: open.length > pick.length }
}

// ---------- pump.fun: addresses ----------

const pdas = new Map()
/** A program address, memoized: each costs a few sha256 and curve checks. */
function derive(seeds, programId) {
  const parts = seeds.map(s => (typeof s === 'string' ? enc.encode(s) : Uint8Array.from(s)))
  const k = `${programId}:${parts.map(hex).join('/')}`
  if (!pdas.has(k)) pdas.set(k, sol.findProgramAddress(parts, programId).then(([a]) => a).catch(err => { pdas.delete(k); throw err }))
  return pdas.get(k)
}

/** The associated token account of owner for mint (SPL Token unless told otherwise). */
export const ata = (owner, mint, tokenProgram = TOKEN_PROGRAM) => derive([key(owner), key(tokenProgram), key(mint)], ATA_PROGRAM)

/** pump.fun's per-coin and per-creator addresses (seeds in PUMP.md). */
export const pumpPda = {
  bondingCurve: mint => derive(['bonding-curve', key(mint)], PUMP.program),
  creatorVault: creator => derive(['creator-vault', key(creator)], PUMP.program),
  mayhemState: mint => derive(['mayhem-state', key(mint)], PUMP.mayhem),
  userVolume: user => derive(['user_volume_accumulator', key(user)], PUMP.program),
  poolAuthority: mint => derive(['pool-authority', key(mint)], PUMP.program),
  canonicalPool: async (mint, quoteMint = WSOL) => derive(['pool', [0, 0], key(await pumpPda.poolAuthority(mint)), key(mint), key(quoteMint)], PUMP.amm),
  ammCreatorVault: creator => derive(['creator_vault', key(creator)], PUMP.amm),
}

// ---------- pump.fun: instructions ----------
// Account order, signer and writable flags as in solana/scripts/pump-ix.mjs (from pump.fun's IDLs).

const acct = (pubkey, w = false, s = false) => ({ pubkey, isSigner: s, isWritable: w })

/** create_v2: a Token-2022 coin and its bonding curve. `creator` is plain data: it never signs, and every creator fee of the coin accrues to it. */
export async function createV2({ mint, user, creator, name, symbol, uri, mayhem = false }) {
  const curve = await pumpPda.bondingCurve(mint)
  return {
    programId: PUMP.program,
    keys: [
      acct(mint, true, true), acct(PUMP.mintAuthority), acct(curve, true), acct(await ata(curve, mint, TOKEN_2022), true), acct(PUMP.global),
      acct(user, true, true), acct(SYSTEM_PROGRAM), acct(TOKEN_2022), acct(ATA_PROGRAM), acct(PUMP.mayhem, true), acct(PUMP.mayhemGlobalParams),
      acct(PUMP.mayhemSolVault, true), acct(await pumpPda.mayhemState(mint), true), acct(await ata(PUMP.mayhemSolVault, mint, TOKEN_2022), true),
      acct(PUMP.eventAuthority), acct(PUMP.program),
    ],
    // is_cashback_enabled (must be false), creator_fee_bps, is_holder_reward: one-field structs, no Option tag.
    // Holder rewards stay off: they would replace the creator with pump's own PDA.
    data: cat([DISC.createV2, str(name), str(symbol), str(uri), key(creator), bool(mayhem), bool(false), u64(0), bool(false)]),
  }
}

/** buy_v3 on a SOL-paired curve: exactly `amount` tokens for at most `maxSolCost` lamports, fees included. */
export async function buyV3({ mint, user, amount, maxSolCost, buyback = PUMP.buyback }) {
  const curve = await pumpPda.bondingCurve(mint)
  return {
    programId: PUMP.program,
    keys: [
      acct(PUMP.global), acct(mint), acct(WSOL), acct(TOKEN_2022), acct(TOKEN_PROGRAM), acct(curve, true),
      acct(await ata(curve, mint, TOKEN_2022), true), acct(await ata(curve, WSOL), true), acct(user, true, true),
      acct(await ata(user, mint, TOKEN_2022), true), acct(await ata(user, WSOL), true), acct(await pumpPda.userVolume(user), true),
      acct(PUMP.feeConfig), acct(buyback, true), acct(SYSTEM_PROGRAM), acct(PUMP.eventAuthority), acct(PUMP.program),
    ],
    data: cat([DISC.buyV3, u64(amount), u64(maxSolCost), bool(false)]),
  }
}

/** sweep_creator_fee (pump): permissionless, moves a curve's waiting creator fee into creator-vault(creator). */
export async function sweepCreatorFee({ payer, mint, creator }) {
  const curve = await pumpPda.bondingCurve(mint)
  const vault = await pumpPda.creatorVault(creator)
  return {
    programId: PUMP.program,
    keys: [
      acct(payer, true, true), acct(PUMP.global), acct(mint), acct(WSOL), acct(TOKEN_PROGRAM), acct(ATA_PROGRAM), acct(SYSTEM_PROGRAM),
      acct(curve, true), acct(await ata(curve, WSOL), true), acct(vault, true), acct(await ata(vault, WSOL), true),
      acct(PUMP.eventAuthority), acct(PUMP.program),
    ],
    data: DISC.sweepCreatorFee.slice(),
  }
}

/** collect_creator_fee_v2 (pump): permissionless, pays creator-vault(creator) out to `creator`, which never signs. */
export async function collectCreatorFeeV2({ creator }) {
  const vault = await pumpPda.creatorVault(creator)
  return {
    programId: PUMP.program,
    keys: [
      acct(creator, true), acct(await ata(creator, WSOL), true), acct(vault, true), acct(await ata(vault, WSOL), true), acct(WSOL),
      acct(TOKEN_PROGRAM), acct(ATA_PROGRAM), acct(SYSTEM_PROGRAM), acct(PUMP.eventAuthority), acct(PUMP.program),
    ],
    data: DISC.collectCreatorFeeV2.slice(),
  }
}

/** sweep_creator_fee (PumpSwap): a graduated coin's pool fees into the WSOL account of creator_vault(coin creator). */
export async function ammSweepCreatorFee({ payer, pool, coinCreator, poolQuoteTokenAccount }) {
  const auth = await pumpPda.ammCreatorVault(coinCreator)
  return {
    programId: PUMP.amm,
    keys: [
      acct(payer, true, true), acct(PUMP.ammGlobalConfig), acct(pool, true), acct(WSOL), acct(TOKEN_PROGRAM), acct(poolQuoteTokenAccount, true),
      acct(auth), acct(await ata(auth, WSOL), true), acct(SYSTEM_PROGRAM), acct(ATA_PROGRAM), acct(PUMP.ammEventAuthority), acct(PUMP.amm),
    ],
    data: DISC.sweepCreatorFee.slice(),
  }
}

/** collect_coin_creator_fee (PumpSwap): permissionless, that WSOL into a WSOL account the coin creator owns (it must exist). */
export async function collectCoinCreatorFee({ coinCreator, coinCreatorTokenAccount }) {
  const auth = await pumpPda.ammCreatorVault(coinCreator)
  return {
    programId: PUMP.amm,
    keys: [
      acct(WSOL), acct(TOKEN_PROGRAM), acct(coinCreator), acct(auth), acct(await ata(auth, WSOL), true), acct(coinCreatorTokenAccount, true),
      acct(PUMP.ammEventAuthority), acct(PUMP.amm),
    ],
    data: DISC.collectCoinCreatorFee.slice(),
  }
}

/** The owner's associated token account for mint, created if missing (by the payer), else left alone. */
export async function ataIdempotent({ payer, owner, mint, tokenProgram = TOKEN_PROGRAM }) {
  return sol.createAssociatedTokenAccountIdempotent({ payer, ata: await ata(owner, mint, tokenProgram), owner, mint, tokenProgram })
}

export const computeUnitLimit = units => ({ programId: COMPUTE_BUDGET, keys: [], data: cat([u8(2), u32(units)]) })
export const computeUnitPrice = microLamports => ({ programId: COMPUTE_BUDGET, keys: [], data: cat([u8(3), u64(microLamports)]) })

// ---------- pump.fun: accounts ----------

/** pump's Global: the fields a launch needs (offsets from its IDL; the tests check them on the mainnet account). */
export function decodeGlobal(b) {
  const v = view(b)
  return {
    initialVirtualTokenReserves: v.getBigUint64(73, true), initialVirtualSolReserves: v.getBigUint64(81, true),
    initialRealTokenReserves: v.getBigUint64(89, true), tokenTotalSupply: v.getBigUint64(97, true),
    createV2Enabled: b[450] !== 0,
    buybackFeeRecipients: Array.from({ length: 8 }, (_, i) => keyAt(b, 741 + 32 * i)),
  }
}

/** pump's fee config: the flat fees and the market-cap tiers, in basis points. */
export function decodeFeeConfig(b) {
  const v = view(b)
  const u = at => v.getBigUint64(at, true)
  const fees = at => ({ lp: u(at), protocol: u(at + 8), creator: u(at + 16) })
  const tiers = Array.from({ length: v.getUint32(65, true) }, (_, i) => {
    const at = 69 + 40 * i
    return { threshold: u(at) | (u(at + 8) << 64n), ...fees(at + 16) }
  })
  return { flat: fees(41), tiers }
}

/** pump's BondingCurve. Accounts from before a field was added are shorter: missing fields read as zero. */
export function decodeCurve(b) {
  const full = new Uint8Array(Math.max(b.length, 166))
  full.set(b)
  const v = view(full)
  const u = at => v.getBigUint64(at, true)
  return {
    virtualTokenReserves: u(8), virtualSolReserves: u(16), realTokenReserves: u(24), realSolReserves: u(32), tokenTotalSupply: u(40),
    complete: full[48] !== 0, creator: keyAt(full, 49), isMayhem: full[81] !== 0, quoteMint: keyAt(full, 83), creatorFeeBps: u(115),
    isHolderReward: full[124] !== 0, creatorFee: u(125), protocolFees: u(133),
  }
}

/** PumpSwap's Pool: where its quote sits, whose fees it keeps, and how much of them waits. */
export function decodePool(b) {
  const full = new Uint8Array(Math.max(b.length, 287))
  full.set(b)
  return {
    baseMint: keyAt(full, 43), quoteMint: keyAt(full, 75), poolQuoteTokenAccount: keyAt(full, 171), coinCreator: keyAt(full, 211),
    creatorFees: view(full).getBigUint64(279, true),
  }
}

/** The fees a curve trade pays at this market cap (lamports): the last tier at or below it, else the flat fees. */
export function curveFees(feeConfig, marketCap) {
  return feeConfig.tiers.filter(t => t.threshold <= marketCap).at(-1) || feeConfig.flat
}

const ceilDiv = (a, b) => (a + b - 1n) / b
export const marketCap = c => (c.virtualTokenReserves ? (c.virtualSolReserves * c.tokenTotalSupply) / c.virtualTokenReserves : 0n)

/** What buying `tokens` costs on a curve, fees included, as pump computes it. */
export function buyCost(curve, fees, tokens) {
  const sol = (tokens * curve.virtualSolReserves) / (curve.virtualTokenReserves - tokens) + 1n
  return sol + ceilDiv(sol * fees.protocol, 10_000n) + ceilDiv(sol * fees.creator, 10_000n) + ceilDiv(sol * fees.lp, 10_000n)
}

/** The most tokens `lamports` buys on a curve, fees included (never more than the curve has left). */
export function quoteBuy(curve, fees, lamports) {
  const budget = BigInt(lamports)
  const net = (budget * 10_000n) / (10_000n + fees.protocol + fees.creator + fees.lp)
  let hi = (net * curve.virtualTokenReserves) / (curve.virtualSolReserves + net)
  if (hi > curve.realTokenReserves) hi = curve.realTokenReserves
  // Rounding in pump's favour can make that a few lamports too dear: take the largest amount that fits.
  let lo = 0n
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n
    if (buyCost(curve, fees, mid) <= budget) lo = mid; else hi = mid - 1n
  }
  return lo
}

/** A curve as create_v2 leaves it: pump's starting reserves. */
export const freshCurve = g => ({
  virtualTokenReserves: g.initialVirtualTokenReserves, virtualSolReserves: g.initialVirtualSolReserves,
  realTokenReserves: g.initialRealTokenReserves, tokenTotalSupply: g.tokenTotalSupply,
})

let settingsP = null
/** pump.fun's Global and fee config, read once per page. */
export function pumpSettings() {
  settingsP ||= getAccounts([PUMP.global, PUMP.feeConfig]).then(([g, f]) => {
    if (!g || !f) throw new Error("Can't read pump.fun's settings from Solana right now. Try again in a moment.")
    return { global: decodeGlobal(g.data), feeConfig: decodeFeeConfig(f.data) }
  }).catch(err => { settingsP = null; throw err })
  return settingsP
}

/** Tokens an opening buy of `lamports` gets as the curve's first trade. */
export function quoteOpeningBuy(settings, lamports) {
  const fresh = freshCurve(settings.global)
  return quoteBuy(fresh, curveFees(settings.feeConfig, marketCap(fresh)), lamports)
}

// ---------- launch ----------

/** Compute and priority fee of a launch (create_v2 alone measured near 99k CU, with the first buy up to about 176k). */
export const LAUNCH = { createUnits: 150_000, buyUnits: 150_000, bothUnits: 250_000, microLamports: 100_000n, slippageBps: 500n }

/** Bytes of the legacy transaction these instructions make, signatures included. */
export function legacySize(payer, instructions) {
  const message = sol.serializeMessage(sol.compileMessage({ payer, recentBlockhash: SYSTEM_PROGRAM, instructions }))
  return message.length + 1 + 64 * message[0]
}

const pickBuyback = list => {
  const ok = (list || []).filter(a => a && a !== SYSTEM_PROGRAM)
  return ok.length ? ok[Math.floor(Math.random() * ok.length)] : PUMP.buyback
}

/**
 * A pump.fun launch for a domain: create_v2 with creator = the domain's vault and, with buyLamports > 0, the payer's
 * opening buy (its token account, then buy_v3 for the most tokens that buys). One legacy transaction when it fits
 * (it does with metadata on an IPFS gateway: 1,194 bytes at most, measured in the tests); otherwise the create,
 * then the buy right after it, which asks for 5% fewer tokens because someone may trade in between. The new mint's
 * keypair co-signs the create.
 * With `board`, the create's transaction also carries BOARD_REFERENCE, so the coin shows on the board: on the buyer's
 * token-account instruction when the opening buy rides along (33 bytes, 1,227 at most in all, which leaves no room for
 * the compute budget instructions: such a launch goes without them), on a zero-lamport transfer (launchTag) otherwise.
 * The board finds the domain in the coin's metadata.
 * Returns { mint, mintKeypair, tokens, single, size, txs: [{ kind: 'launch' | 'create' | 'buy', instructions, extraSigners }] }.
 */
export async function launchTxs({ payer, vault, name, symbol, uri, buyLamports = 0n, mintKeypair, settings, board = false }) {
  if (!sol.isAddress(vault)) throw new Error('No vault address for this domain yet.')
  if (!String(name || '').trim() || !String(symbol || '').trim() || !String(uri || '').trim()) throw new Error('A coin needs a name, a ticker and its metadata.')
  settings ||= await pumpSettings()
  if (!settings.global.createV2Enabled) throw new Error('pump.fun is not creating new coins right now. Try again later.')
  mintKeypair ||= await keypair()
  const mint = mintKeypair.publicKey
  const price = computeUnitPrice(LAUNCH.microLamports)
  const create = await createV2({ mint, user: payer, creator: vault, name, symbol, uri })
  const buy = BigInt(buyLamports)
  const createOnly = [computeUnitLimit(LAUNCH.createUnits), price, create, ...(board ? [launchTag(payer)] : [])]
  if (buy <= 0n) return { mint, mintKeypair, tokens: 0n, single: true, size: legacySize(payer, createOnly), txs: [{ kind: 'launch', instructions: createOnly, extraSigners: [mintKeypair] }] }
  const tokens = quoteOpeningBuy(settings, buy)
  if (tokens <= 0n) throw new Error('That opening buy is too small to buy any tokens.')
  const buyback = pickBuyback(settings.global.buybackFeeRecipients)
  const buyIxs = async (amount, tagged = false) => [
    (tagged ? withReference : ix => ix)(await ataIdempotent({ payer, owner: payer, mint, tokenProgram: TOKEN_2022 })),
    await buyV3({ mint, user: payer, amount, maxSolCost: buy, buyback }),
  ]
  // The opening buy is safest in the create's own transaction, before anyone else can trade: if the compute budget
  // instructions don't leave room for it (the board's reference, or a long name, ticker and link), it goes without
  // them (the runtime then allows 200k compute units per instruction, more than enough, and the wallet sets the
  // priority fee).
  const buying = await buyIxs(tokens, board)
  for (const instructions of [[computeUnitLimit(LAUNCH.bothUnits), price, create, ...buying], [create, ...buying]]) {
    const size = legacySize(payer, instructions)
    if (size <= LEGACY_LIMIT) return { mint, mintKeypair, tokens, single: true, size, txs: [{ kind: 'launch', instructions, extraSigners: [mintKeypair] }] }
  }
  const size = legacySize(payer, [create, ...buying])
  const fewer = (tokens * (10_000n - LAUNCH.slippageBps)) / 10_000n
  return {
    mint, mintKeypair, tokens: fewer, single: false, size,
    txs: [
      { kind: 'create', instructions: createOnly, extraSigners: [mintKeypair] },
      { kind: 'buy', instructions: [computeUnitLimit(LAUNCH.buyUnits), price, ...await buyIxs(fewer)], extraSigners: [] },
    ],
  }
}

// ---------- a vault's coins and their creator fees ----------

const isSolQuote = c => c.quoteMint === WSOL || c.quoteMint === SYSTEM_PROGRAM
const INITIAL_FOR_SALE = 793_100_000_000_000n

/** A curve keeps no mint; its token account does. Each candidate is checked against the curve's address. */
async function mintOfCurve(curve) {
  for (const programId of [TOKEN_2022, TOKEN_PROGRAM]) {
    const { value } = await sol.rpc('getTokenAccountsByOwner', [curve, { programId }, { encoding: 'jsonParsed', commitment: 'confirmed' }])
    for (const a of value) {
      const mint = a.account.data.parsed.info.mint
      if (sol.isAddress(mint) && (await pumpPda.bondingCurve(mint)) === curve) return mint
    }
  }
  return ''
}

/**
 * The pump.fun coins whose creator is `vault` (anyone may create one: they all pay the vault):
 * [{ curve, mint, name, symbol, uri, complete, creatorFee, mcap, progress, ...the curve }], biggest first.
 */
export async function findCoins(vault, { limit = 40 } = {}) {
  const list = await programAccounts([PUMP.program, {
    encoding: 'base64', commitment: 'confirmed', dataSlice: { offset: 0, length: 166 },
    filters: [{ memcmp: { offset: 0, bytes: base58Encode(DISC.bondingCurve) } }, { memcmp: { offset: 49, bytes: vault } }],
  }])
  const curves = (list || []).map(a => ({ curve: a.pubkey, ...decodeCurve(base64Decode(a.account.data[0])) }))
    .filter(c => c.creator === vault).slice(0, limit)
  const mints = await mapLimit(curves, 4, c => mintOfCurve(c.curve).catch(() => ''))
  const coins = curves.map((c, i) => ({ ...c, mint: mints[i] })).filter(c => c.mint)
  const names = await tokenNames(coins.map(c => c.mint)).catch(() => new Map())
  for (const c of coins) {
    Object.assign(c, names.get(c.mint) || { name: '', symbol: '', uri: '' })
    c.mcap = marketCap(c)
    c.progress = c.complete ? 1 : Math.max(0, Number(10_000n - (c.realTokenReserves * 10_000n) / INITIAL_FOR_SALE) / 10_000)
    if (!isSolQuote(c)) c.creatorFee = 0n // fees in another quote token are left to pump.fun's own tools
  }
  return coins.sort((a, b) => (b.mcap > a.mcap ? 1 : b.mcap < a.mcap ? -1 : 0))
}

const tokenAmountOf = data => (data && data.length >= 72 ? view(data).getBigUint64(64, true) : 0n)

/**
 * Creator fees of `coins` still at pump.fun, in lamports: on the curves (curve), swept into pump's creator vault
 * but not collected (swept), in graduated coins' pools (pool), and swept from pools into PumpSwap's creator vault
 * (ammWaiting). `pools` are the graduated coins' pools; `vaultLamports` is what the vault itself holds.
 */
export async function pendingFees(vault, coins) {
  const creatorVault = await pumpPda.creatorVault(vault)
  const ammAta = await ata(await pumpPda.ammCreatorVault(vault), WSOL)
  const grads = coins.filter(c => c.complete && isSolQuote(c))
  const poolAddrs = await Promise.all(grads.map(c => pumpPda.canonicalPool(c.mint)))
  const [v, cv, aa, ...pa] = await getAccounts([vault, creatorVault, ammAta, ...poolAddrs])
  const rent0 = await rentExempt(0)
  const swept = cv && cv.lamports > rent0 ? cv.lamports - rent0 : 0n
  const pools = grads.map((c, i) => (pa[i] && pa[i].owner === PUMP.amm ? { mint: c.mint, pool: poolAddrs[i], ...decodePool(pa[i].data) } : null))
    .filter(p => p && p.coinCreator === vault)
  const curve = coins.reduce((n, c) => n + c.creatorFee, 0n)
  const pool = pools.reduce((n, p) => n + p.creatorFees, 0n)
  const ammWaiting = aa ? tokenAmountOf(aa.data) : 0n
  return { total: curve + swept + pool + ammWaiting, curve, swept, pool, ammWaiting, pools, vaultLamports: v ? v.lamports : 0n, rent0 }
}

/** Splits instruction groups into as few legacy transactions as fit, in order. A group never splits. */
function pack(payer, groups) {
  const txs = []
  let cur = []
  for (const g of groups) {
    if (cur.length && legacySize(payer, [...cur, ...g]) > LEGACY_LIMIT) { txs.push(cur); cur = [] }
    cur = [...cur, ...g]
  }
  if (cur.length) txs.push(cur)
  return txs.map(instructions => ({ instructions, extraSigners: [] }))
}

/**
 * The same collect the worker runs, paid by `payer` instead: sweep each curve's fees, collect them into the vault,
 * and the same for graduated coins' pools (WSOL, into the vault's WSOL account). Everything lands in the vault and
 * nowhere else; the payer pays network fees, and tops the vault up to its rent minimum if it is below (pump pays a
 * creator nothing that would leave it below rent).
 */
export async function collectTxs({ payer, vault, coins, fees }) {
  fees ||= await pendingFees(vault, coins)
  const groups = []
  const sweeps = coins.filter(c => c.creatorFee > 0n)
  for (const c of sweeps) groups.push([await sweepCreatorFee({ payer, mint: c.mint, creator: vault })])
  if (sweeps.length || fees.swept > 0n) groups.push([await collectCreatorFeeV2({ creator: vault })])
  const pools = fees.pools.filter(p => p.creatorFees > 0n)
  for (const p of pools) groups.push([await ammSweepCreatorFee({ payer, pool: p.pool, coinCreator: vault, poolQuoteTokenAccount: p.poolQuoteTokenAccount })])
  if (pools.length || fees.ammWaiting > 0n) {
    groups.push([
      await ataIdempotent({ payer, owner: vault, mint: WSOL }),
      await collectCoinCreatorFee({ coinCreator: vault, coinCreatorTokenAccount: await ata(vault, WSOL) }),
    ])
  }
  if (!groups.length) return []
  if (fees.vaultLamports < fees.rent0) groups.unshift([sol.systemTransfer(payer, vault, fees.rent0 - fees.vaultLamports)])
  return pack(payer, groups)
}

// ---------- keys, signatures, sending ----------

/** A fresh Ed25519 keypair from WebCrypto, for a new coin's mint: { publicKey, sign(message) }. Never leaves the page. */
export async function keypair() {
  const k = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])
  const publicKey = base58Encode(new Uint8Array(await crypto.subtle.exportKey('raw', k.publicKey)))
  return { publicKey, sign: async message => new Uint8Array(await crypto.subtle.sign('Ed25519', k.privateKey, message)) }
}

function readShortvec(b, at) {
  let n = 0
  for (let i = 0; ; i++) {
    const x = b[at + i]
    n |= (x & 0x7f) << (7 * i)
    if (!(x & 0x80)) return [n, at + i + 1]
  }
}

/** The signer keys of a wire transaction, in signature-slot order, and where its message starts. */
export function signersOf(tx) {
  const [count, sigsAt] = readShortvec(tx, 0)
  const msgAt = sigsAt + 64 * count
  const head = msgAt + (tx[msgAt] & 0x80 ? 1 : 0)
  const [, keysAt] = readShortvec(tx, head + 3)
  const signers = Array.from({ length: tx[head] }, (_, i) => base58Encode(tx.subarray(keysAt + 32 * i, keysAt + 32 * i + 32)))
  return { count, sigsAt, msgAt, signers }
}

/** Adds the signatures of `signers` ({ publicKey, sign }) over the transaction's message, in their slots. */
export async function addSignatures(tx, signers = []) {
  const out = Uint8Array.from(tx)
  const { sigsAt, msgAt, signers: slots } = signersOf(out)
  const message = out.subarray(msgAt)
  for (const s of signers) {
    const i = slots.indexOf(s.publicKey)
    if (i < 0) throw new Error(`${s.publicKey} does not sign this transaction`)
    out.set(await s.sign(message), sigsAt + 64 * i)
  }
  return out
}

/** The fee payer's signature (the transaction id) of a signed wire transaction. */
export const transactionId = tx => { const { sigsAt } = signersOf(tx); return base58Encode(tx.subarray(sigsAt, sigsAt + 64)) }

/**
 * Sends [{ instructions, extraSigners }] in order from the connected wallet (solana.js state), each confirmed
 * before the next. With extra signers the wallet signs first (it may add instructions of its own) and they sign
 * what it returns. `onStep` hears { index, status: 'signing' | 'sending' | 'confirming' | 'confirmed', signature }.
 * Returns the signatures; a failure throws with `index`, `signature` and the `signatures` that landed before it.
 */
export async function sendAll(txs, onStep = () => {}, state = sol.state) {
  const { wallet, account } = state
  if (!wallet || !account) throw new Error('Connect a Solana wallet first.')
  const sign = wallet.features['solana:signTransaction']
  const signSend = wallet.features['solana:signAndSendTransaction']
  const done = []
  for (const [index, tx] of txs.entries()) {
    let signature
    try {
      onStep({ index, status: 'signing' })
      const { blockhash, lastValidBlockHeight } = await sol.getLatestBlockhash()
      const message = sol.serializeMessage(sol.compileMessage({ payer: account.address, recentBlockhash: blockhash, instructions: tx.instructions }))
      const unsigned = sol.unsignedTransaction(message)
      const extra = tx.extraSigners || []
      if (sign && (extra.length || !signSend)) {
        const [out] = await sign.signTransaction({ account, transaction: unsigned, chain: sol.CHAIN })
        const signed = await addSignatures(Uint8Array.from(out.signedTransaction), extra)
        signature = transactionId(signed)
        onStep({ index, status: 'sending', signature })
        await sol.rpc('sendTransaction', [sol.base64Encode(signed), { encoding: 'base64', preflightCommitment: 'confirmed' }], { write: true })
      } else {
        const [out] = await signSend.signAndSendTransaction({ account, transaction: await addSignatures(unsigned, extra), chain: sol.CHAIN, options: { preflightCommitment: 'confirmed' } })
        signature = base58Encode(out.signature)
      }
      onStep({ index, status: 'confirming', signature })
      await sol.confirm(signature, lastValidBlockHeight)
    } catch (err) {
      throw Object.assign(err instanceof Error ? err : new Error(String(err)), { index, signature, signatures: [...done] })
    }
    done.push(signature)
    onStep({ index, status: 'confirmed', signature })
  }
  return done
}

// pump.fun errors a launch or a collect can meet, in plain words (codes from its IDL).
const PUMP_ERRORS = {
  6002: 'The price moved before the opening buy landed, so the buy stopped and nothing was spent on it. The coin is live: buy on pump.fun if you still want to.',
  6005: 'This coin has left its bonding curve; it trades on PumpSwap now.',
  6020: 'That opening buy is too small to buy any tokens.',
  6021: 'The curve has fewer tokens left than that buy asks for.',
}

/** The custom program error in a failed send or confirmation: { code, instruction, text } or null. */
export function programError(err) {
  const m = String((err && err.message) || '')
  const custom = /custom program error: 0x([0-9a-f]+)/i.exec(m)
  const status = /"Custom":(\d+)/.exec(m)
  const code = custom ? parseInt(custom[1], 16) : status ? Number(status[1]) : null
  if (code == null) return null
  const at = /Instruction (\d+)/i.exec(m) || /InstructionError":\[(\d+)/.exec(m)
  return { code, instruction: at ? Number(at[1]) : null, text: PUMP_ERRORS[code] || '' }
}
