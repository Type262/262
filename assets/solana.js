// Solana for the browser: base58, PDAs, legacy and v0 transactions, address lookup tables, JSON-RPC and Wallet
// Standard wallets.
// No dependencies. sha256 is the browser's WebCrypto; the ed25519 on-curve check that PDAs need is a few
// lines of BigInt (the same test the runtime's curve25519-dalek decompress makes), checked against mainnet
// accounts in test/solana.test.mjs.
import * as config from './config.js'

export const SYSTEM_PROGRAM = '11111111111111111111111111111111'
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
export const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
// Circle's USDC mint, checked on-chain before use (see verifyMint): owner Token program, 6 decimals.
export const USDC = { symbol: 'USDC', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 }
export const SOL_DECIMALS = 9
export const NAME = 'Solana'
export const CHAIN = 'solana:mainnet'
export const txUrl = sig => `https://solscan.io/tx/${sig}`
export const accountUrl = a => `https://solscan.io/account/${a}`
// A new system account must hold at least this many lamports (rent exemption for 0 bytes).
export const MIN_ACCOUNT_LAMPORTS = 890_880n
// Rent for a new token account (165 bytes). Paid once by whoever opens it.
export const TOKEN_ACCOUNT_RENT = 2_039_280n

// ---------- base58 ----------
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

export function base58Encode(bytes) {
  let n = 0n
  for (const b of bytes) n = (n << 8n) | BigInt(b)
  let s = ''
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n }
  for (const b of bytes) { if (b) break; s = '1' + s }
  return s
}

export function base58Decode(s) {
  let n = 0n
  for (const c of String(s)) {
    const i = B58.indexOf(c)
    if (i < 0) throw new Error(`Invalid base58 character "${c}"`)
    n = n * 58n + BigInt(i)
  }
  const out = []
  while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n }
  for (const c of String(s)) { if (c !== '1') break; out.unshift(0) }
  return Uint8Array.from(out)
}

/** 32 bytes of a public key. Throws on anything else. */
export function pubkeyBytes(address) {
  const b = typeof address === 'string' ? base58Decode(address) : Uint8Array.from(address)
  if (b.length !== 32) throw new Error(`Not a Solana address: ${String(address).slice(0, 48)}`)
  return b
}
export const isAddress = a => { try { pubkeyBytes(a); return true } catch { return false } }

const toB64 = bytes => btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''))
const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0))
const concat = parts => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let i = 0
  for (const p of parts) { out.set(p, i); i += p.length }
  return out
}
const u64le = v => {
  let n = BigInt(v)
  if (n < 0n || n >= 1n << 64n) throw new Error('Amount out of range')
  const out = new Uint8Array(8)
  for (let i = 0; i < 8; i++) { out[i] = Number(n & 255n); n >>= 8n }
  return out
}

// ---------- program addresses ----------
const P = 2n ** 255n - 19n
const D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n // ed25519 d
const modpow = (b, e) => {
  let r = 1n
  b %= P
  for (; e > 0n; e >>= 1n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P }
  return r
}

/** True when 32 bytes decompress to an ed25519 point, i.e. the address could have a private key. */
export function isOnCurve(bytes) {
  let y = 0n
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? bytes[i] & 0x7f : bytes[i])
  y %= P
  const y2 = (y * y) % P
  const u = (y2 - 1n + P) % P // x² = (y² - 1) / (d·y² + 1): a point exists when that is a square
  const v = (D * y2 + 1n) % P
  const x2 = (u * modpow(v, P - 2n)) % P
  return x2 === 0n || modpow(x2, (P - 1n) / 2n) === 1n
}

const sha256 = async bytes => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
const PDA_MARKER = new TextEncoder().encode('ProgramDerivedAddress')
const seedBytes = s => (typeof s === 'string' ? new TextEncoder().encode(s) : Uint8Array.from(s))

export async function createProgramAddress(seeds, programId) {
  const parts = seeds.map(seedBytes)
  if (parts.length > 16 || parts.some(p => p.length > 32)) throw new Error('Seeds are at most 16 of 32 bytes each')
  const hash = await sha256(concat([...parts, pubkeyBytes(programId), PDA_MARKER]))
  if (isOnCurve(hash)) throw new Error('Seeds land on the curve')
  return base58Encode(hash)
}

/** [address, bump]: the first bump from 255 down whose address is off the curve. */
export async function findProgramAddress(seeds, programId) {
  for (let bump = 255; bump >= 0; bump--) {
    try { return [await createProgramAddress([...seeds, [bump]], programId), bump] } catch (err) { if (!/curve/.test(err.message)) throw err }
  }
  throw new Error('No viable bump seed')
}

/** The associated token account of owner for mint. */
export async function associatedTokenAddress(owner, mint, tokenProgram = TOKEN_PROGRAM) {
  const [a] = await findProgramAddress([pubkeyBytes(owner), pubkeyBytes(tokenProgram), pubkeyBytes(mint)], ATA_PROGRAM)
  return a
}

// ---------- instructions ----------
// An instruction is { programId, keys: [{ pubkey, isSigner, isWritable }], data: Uint8Array }.
const meta = (pubkey, isSigner, isWritable) => ({ pubkey, isSigner, isWritable })

export function systemTransfer(from, to, lamports) {
  return { programId: SYSTEM_PROGRAM, keys: [meta(from, true, true), meta(to, false, true)], data: concat([Uint8Array.of(2, 0, 0, 0), u64le(lamports)]) }
}

export function transferChecked({ source, mint, destination, owner, amount, decimals, tokenProgram = TOKEN_PROGRAM }) {
  return {
    programId: tokenProgram,
    keys: [meta(source, false, true), meta(mint, false, false), meta(destination, false, true), meta(owner, true, false)],
    data: concat([Uint8Array.of(12), u64le(amount), Uint8Array.of(decimals)]),
  }
}

export function createAssociatedTokenAccountIdempotent({ payer, ata, owner, mint, tokenProgram = TOKEN_PROGRAM }) {
  return {
    programId: ATA_PROGRAM,
    keys: [meta(payer, true, true), meta(ata, false, true), meta(owner, false, false), meta(mint, false, false), meta(SYSTEM_PROGRAM, false, false), meta(tokenProgram, false, false)],
    data: Uint8Array.of(1),
  }
}

// ---------- legacy transactions ----------
function shortvec(n) {
  const out = []
  for (;;) {
    const b = n & 0x7f
    n >>= 7
    if (!n) { out.push(b); return out }
    out.push(b | 0x80)
  }
}

/**
 * Compile instructions into a legacy message. Accounts are ordered fee payer first, then writable signers,
 * read-only signers, writable and read-only accounts, each in first-seen order (a program before its accounts).
 */
export function compileMessage({ payer, recentBlockhash, instructions }) {
  const metas = new Map()
  const touch = (k, signer, writable) => {
    pubkeyBytes(k)
    const m = metas.get(k)
    if (m) { m.signer ||= signer; m.writable ||= writable } else metas.set(k, { signer, writable })
  }
  touch(payer, true, true)
  for (const ix of instructions) {
    touch(ix.programId, false, false)
    for (const k of ix.keys) touch(k.pubkey, k.isSigner, k.isWritable)
  }
  const group = (s, w) => [...metas].filter(([k, m]) => k !== payer && m.signer === s && m.writable === w).map(([k]) => k)
  const signedRo = group(true, false), unsignedRo = group(false, false)
  const keys = [payer, ...group(true, true), ...signedRo, ...group(false, true), ...unsignedRo]
  const index = new Map(keys.map((k, i) => [k, i]))
  return {
    header: [1 + group(true, true).length + signedRo.length, signedRo.length, unsignedRo.length],
    accountKeys: keys,
    recentBlockhash,
    instructions: instructions.map(ix => ({ programIdIndex: index.get(ix.programId), accounts: ix.keys.map(k => index.get(k.pubkey)), data: Uint8Array.from(ix.data) })),
  }
}

/** Wire bytes of a compiled legacy message. */
export function serializeMessage(m) {
  const out = [...m.header, ...shortvec(m.accountKeys.length)]
  for (const k of m.accountKeys) out.push(...pubkeyBytes(k))
  out.push(...pubkeyBytes(m.recentBlockhash), ...shortvec(m.instructions.length))
  for (const ix of m.instructions) out.push(ix.programIdIndex, ...shortvec(ix.accounts.length), ...ix.accounts, ...shortvec(ix.data.length), ...ix.data)
  return Uint8Array.from(out)
}

/** An unsigned transaction: empty signature slots, then the message (legacy or v0). Wallets fill the signatures in. */
export function unsignedTransaction(messageBytes) {
  const n = messageBytes[messageBytes[0] & 0x80 ? 1 : 0] // a v0 message starts with its version byte
  const tx = concat([Uint8Array.from(shortvec(n)), new Uint8Array(64 * n), messageBytes])
  if (tx.length > 1232) throw new Error('Transaction too large')
  return tx
}

// ---------- v0 transactions and address lookup tables ----------

export const LOOKUP_TABLE_PROGRAM = 'AddressLookupTab1e1111111111111111111111111'

/**
 * A v0 message: like a legacy one, but accounts found in `tables` ({ key, addresses }) are sent as one-byte
 * indexes into them. Signers and invoked programs always stay in the message itself.
 */
export function compileV0({ payer, recentBlockhash, instructions, tables = [] }) {
  const metas = new Map()
  const touch = (k, signer, writable, invoked) => {
    pubkeyBytes(k)
    const m = metas.get(k)
    if (m) { m.signer ||= signer; m.writable ||= writable; m.invoked ||= invoked } else metas.set(k, { signer, writable, invoked })
  }
  touch(payer, true, true, false)
  for (const ix of instructions) {
    touch(ix.programId, false, false, true)
    for (const k of ix.keys) touch(k.pubkey, k.isSigner, k.isWritable, false)
  }
  const lookups = tables.map(t => ({ key: t.key, writable: [], readonly: [] }))
  const loaded = new Set()
  for (const [k, m] of metas) {
    if (m.signer || m.invoked || k === payer) continue
    for (const [i, t] of tables.entries()) {
      const at = t.addresses.indexOf(k)
      if (at < 0 || at > 255) continue
      ;(m.writable ? lookups[i].writable : lookups[i].readonly).push([at, k])
      loaded.add(k)
      break
    }
  }
  const group = (s, wr) => [...metas].filter(([k, m]) => k !== payer && !loaded.has(k) && m.signer === s && m.writable === wr).map(([k]) => k)
  const signedRo = group(true, false)
  const unsignedRo = group(false, false)
  const statics = [payer, ...group(true, true), ...signedRo, ...group(false, true), ...unsignedRo]
  // Indexes run over the static keys, then every table's writable entries, then every table's read-only ones.
  const order = [...statics, ...lookups.flatMap(l => l.writable.map(([, k]) => k)), ...lookups.flatMap(l => l.readonly.map(([, k]) => k))]
  const index = new Map(order.map((k, i) => [k, i]))
  const used = lookups.filter(l => l.writable.length || l.readonly.length)
  const out = [0x80, 1 + group(true, true).length + signedRo.length, signedRo.length, unsignedRo.length, ...shortvec(statics.length)]
  for (const k of statics) out.push(...pubkeyBytes(k))
  out.push(...pubkeyBytes(recentBlockhash), ...shortvec(instructions.length))
  for (const ix of instructions) {
    out.push(index.get(ix.programId), ...shortvec(ix.keys.length), ...ix.keys.map(k => index.get(k.pubkey)), ...shortvec(ix.data.length), ...ix.data)
  }
  out.push(...shortvec(used.length))
  for (const l of used) {
    out.push(...pubkeyBytes(l.key), ...shortvec(l.writable.length), ...l.writable.map(([at]) => at), ...shortvec(l.readonly.length), ...l.readonly.map(([at]) => at))
  }
  return Uint8Array.from(out)
}

/** An address lookup table's addresses: { key, addresses }. Throws for a deactivated table, which stops resolving lookups. */
export async function readLookupTable(address) {
  const a = await rpc('getAccountInfo', [address, { encoding: 'base64', commitment: 'confirmed' }]).then(r => r.value)
  if (!a || a.owner !== LOOKUP_TABLE_PROGRAM) throw new Error(`No address lookup table at ${address}`)
  const data = fromB64(a.data[0])
  // bytes 4-12: the deactivation slot, u64 max while the table is active
  if (data.length < 56 || data.subarray(4, 12).some(b => b !== 0xff)) throw new Error(`The address lookup table at ${address} is deactivated`)
  const addresses = []
  for (let at = 56; at + 32 <= data.length; at += 32) addresses.push(base58Encode(data.subarray(at, at + 32)))
  return { key: address, addresses }
}

// ---------- JSON-RPC ----------
// Public endpoints first. If none answers, our read-only fallback serves reads for the next minute.
const PUBLIC_RPC = config.SOLANA_RPC_URL ? [config.SOLANA_RPC_URL] : ['https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com']
const FALLBACK_RPC = config.SOLANA_RPC_FALLBACK || 'https://type262-upload.onrender.com/rpc/solana'
let publicDownAt = 0

export async function rpc(method, params = [], { write = false } = {}) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  const urls = write ? PUBLIC_RPC : Date.now() - publicDownAt < 60_000 ? [FALLBACK_RPC, ...PUBLIC_RPC] : [...PUBLIC_RPC, FALLBACK_RPC]
  let last
  for (const url of urls) {
    const fallback = url === FALLBACK_RPC
    try {
      // the fallback may need a cold start on the host
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(fallback ? 60_000 : 20_000) })
      if (!res.ok) throw new Error(`RPC answered ${res.status}`)
      const j = await res.json()
      if (!fallback) publicDownAt = 0
      if (j.error) { const e = new Error(j.error.message || 'RPC error'); e.code = j.error.code; e.rpc = true; throw e }
      return j.result
    } catch (err) {
      if (err.rpc) throw err
      last = err
      if (!fallback && url === PUBLIC_RPC.at(-1)) publicDownAt = Date.now()
    }
  }
  throw new Error(`Can't reach Solana right now (${last.message}). Try again in a moment.`)
}

export const getLatestBlockhash = () => rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]).then(r => r.value)
export const getBalance = address => rpc('getBalance', [address, { commitment: 'confirmed' }]).then(r => BigInt(r.value))
export const getAccountInfo = (address, encoding = 'base64') => rpc('getAccountInfo', [address, { encoding, commitment: 'confirmed' }]).then(r => r.value)

/** { amount, decimals } of a token account, or null if it doesn't exist yet. */
export async function getTokenAccountBalance(address) {
  try {
    const r = await rpc('getTokenAccountBalance', [address, { commitment: 'confirmed' }])
    return { amount: BigInt(r.value.amount), decimals: r.value.decimals }
  } catch (err) { if (err.rpc && err.code === -32602) return null; throw err }
}

/** Checks a mint on-chain: owned by the token program, with the decimals we expect. Cached per page. */
const mints = new Map()
export function verifyMint({ mint, decimals }) {
  if (!mints.has(mint)) {
    mints.set(mint, getAccountInfo(mint, 'jsonParsed').then(a => {
      const info = a && a.data && a.data.parsed && a.data.parsed.info
      if (!a || a.owner !== TOKEN_PROGRAM || !info || a.data.parsed.type !== 'mint' || info.decimals !== decimals) throw new Error('The token mint did not check out on-chain.')
      return true
    }).catch(err => { mints.delete(mint); throw err }))
  }
  return mints.get(mint)
}

const pause = ms => new Promise(r => setTimeout(r, ms))

/** Polls getSignatureStatuses until confirmed. Throws if the transaction failed or its blockhash expired. */
export async function confirm(signature, lastValidBlockHeight, { timeout = 120_000 } = {}) {
  const until = Date.now() + timeout
  for (let i = 0; Date.now() < until; i++) {
    const { value: [s] } = await rpc('getSignatureStatuses', [[signature]])
    if (s && s.err) throw new Error(`Transaction failed on Solana: ${JSON.stringify(s.err)}`)
    if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return s
    if (!s && lastValidBlockHeight && i % 4 === 3 && (await rpc('getBlockHeight', [{ commitment: 'confirmed' }])) > lastValidBlockHeight) {
      throw new Error('The transaction expired before it landed. Nothing was sent; try again.')
    }
    await pause(1500)
  }
  throw new Error(`Still pending after ${timeout / 60_000} minutes (${signature}). Check it on Solscan before trying again.`)
}

// ---------- wallets: Wallet Standard (Phantom, Solflare, Backpack and other Solana wallets) ----------
const KNOWN = ['Phantom', 'Solflare', 'Backpack']
const WALLET_KEY = 't262-sol-wallet'
const registered = new Map()
const subscribers = new Set()
export const state = { wallet: null, account: null }
const emit = () => subscribers.forEach(f => { try { f(state) } catch {} })

/** Called with the wallet state on every change: wallets found, connect, disconnect, account switch. */
export function subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn) }

const isSolanaWallet = w => w && w.name && Array.isArray(w.chains) && w.chains.some(c => String(c).startsWith('solana:')) &&
  w.features && w.features['standard:connect'] && (w.features['solana:signAndSendTransaction'] || w.features['solana:signTransaction'])

function register(...wallets) {
  for (const w of wallets) if (isSolanaWallet(w) && !registered.has(w.name)) registered.set(w.name, w)
  emit()
  restore()
  return () => {}
}

let started = false
/** Start listening for wallets. Safe to call more than once; does nothing outside a browser. */
export function start() {
  if (started || typeof window === 'undefined') return
  started = true
  const api = Object.freeze({ register })
  window.addEventListener('wallet-standard:register-wallet', e => { try { e.detail(api) } catch {} })
  try { window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: api })) } catch {}
  // Older wallets queued their registration callbacks on navigator.wallets.
  const queued = window.navigator.wallets
  if (Array.isArray(queued)) queued.forEach(cb => { try { typeof cb === 'function' && cb({ register }) } catch {} })
}

/** Solana wallets in the browser, the well-known ones first. */
export function wallets() {
  const rank = w => { const i = KNOWN.findIndex(k => w.name.startsWith(k)); return i < 0 ? KNOWN.length : i }
  return [...registered.values()].sort((a, b) => rank(a) - rank(b))
}

const remembered = () => { try { return localStorage.getItem(WALLET_KEY) } catch { return null } }

function use(wallet, accounts) {
  const account = (accounts || []).find(a => !a.chains || a.chains.some(c => String(c).startsWith('solana:'))) || null
  state.wallet = account ? wallet : null
  state.account = account
  try { if (account) localStorage.setItem(WALLET_KEY, wallet.name) } catch {}
  emit()
  return account
}

const events = new WeakSet()
function follow(wallet) {
  const ev = wallet.features['standard:events']
  if (!ev || events.has(wallet)) return
  events.add(wallet)
  // An account switch in the wallet follows through; a lock or revoke drops the connection (still remembered).
  ev.on('change', ({ accounts }) => { if (accounts && state.wallet === wallet) use(wallet, accounts) })
}

/** Connect a wallet by name (or the first one found). Returns the address. */
export async function connect(name) {
  start()
  const wallet = name ? registered.get(name) : wallets()[0]
  if (!wallet) throw new Error('No Solana wallet found. Install Phantom, Solflare or Backpack, or copy the payment link into a phone wallet.')
  const { accounts } = await wallet.features['standard:connect'].connect()
  follow(wallet)
  const account = use(wallet, accounts && accounts.length ? accounts : wallet.accounts)
  if (!account) throw new Error(`${wallet.name} didn't share a Solana account.`)
  return account.address
}

/** Returning visit: reconnect the remembered wallet silently, never with a prompt. */
let restoring = false
async function restore() {
  const name = remembered()
  if (restoring || state.account || !name || !registered.has(name)) return
  restoring = true
  const wallet = registered.get(name)
  try {
    const { accounts } = await wallet.features['standard:connect'].connect({ silent: true })
    follow(wallet)
    use(wallet, accounts && accounts.length ? accounts : wallet.accounts)
  } catch {} finally { restoring = false }
}

/** Disconnect and forget the wallet on this device. */
export async function disconnect() {
  const w = state.wallet
  state.wallet = null
  state.account = null
  try { localStorage.removeItem(WALLET_KEY) } catch {}
  emit()
  try { if (w && w.features['standard:disconnect']) await w.features['standard:disconnect'].disconnect() } catch {}
}

/** Whether the connected wallet signs v0 transactions, the ones that use address lookup tables. */
export function supportsV0(s = state) {
  const f = s.wallet && s.wallet.features
  const feature = f && (f['solana:signTransaction'] || f['solana:signAndSendTransaction'])
  const versions = feature && feature.supportedTransactionVersions
  return Array.isArray(versions) && versions.some(v => v === 0 || v === '0')
}

/** Has the connected wallet sign and send a transaction. Returns the signature (base58). */
export async function signAndSend(tx) {
  const { wallet, account } = state
  if (!wallet || !account) throw new Error('Connect a Solana wallet first.')
  const f = wallet.features
  if (f['solana:signAndSendTransaction']) {
    const [out] = await f['solana:signAndSendTransaction'].signAndSendTransaction({ account, transaction: tx, chain: CHAIN, options: { preflightCommitment: 'confirmed' } })
    return base58Encode(out.signature)
  }
  const [out] = await f['solana:signTransaction'].signTransaction({ account, transaction: tx, chain: CHAIN })
  return rpc('sendTransaction', [toB64(out.signedTransaction), { encoding: 'base64', preflightCommitment: 'confirmed' }], { write: true })
}

/** Build, sign, send and confirm one transaction from the connected wallet. Returns the signature. */
export async function send(instructions, { onSent } = {}) {
  if (!state.account) throw new Error('Connect a Solana wallet first.')
  const { blockhash, lastValidBlockHeight } = await getLatestBlockhash()
  const message = serializeMessage(compileMessage({ payer: state.account.address, recentBlockhash: blockhash, instructions }))
  const signature = await signAndSend(unsignedTransaction(message))
  if (onSent) onSent(signature)
  await confirm(signature, lastValidBlockHeight)
  return signature
}

export { toB64 as base64Encode, fromB64 as base64Decode }
