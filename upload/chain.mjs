// Solana plumbing for the vault worker: JSON-RPC over SOLANA_RPC_URL then the public nodes, the few instructions
// the worker builds itself (compute budget, memo, token close/initialize, account creation), and one call that
// simulates, prices, signs, sends and confirms a transaction. Messages are compiled with the browser client's
// legacy encoder (assets/solana.js, byte-exact against mainnet in test/solana.test.mjs).
import { compileMessage, serializeMessage, systemTransfer, transferChecked } from '../assets/solana.js'
import { SYSTEM, TOKEN, b58encode, meta, pk, u32, u64, u8 } from './pump.mjs'

export const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111'
export const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
export const TX_LIMIT = 1232
const MAX_UNITS = 1_400_000

export { systemTransfer, transferChecked }

// ---------- instructions ----------

export const setComputeUnitLimit = units => ({ programId: COMPUTE_BUDGET, keys: [], data: Buffer.concat([u8(2), u32(units)]) })
export const setComputeUnitPrice = microLamports => ({ programId: COMPUTE_BUDGET, keys: [], data: Buffer.concat([u8(3), u64(microLamports)]) })
// No signer keys: the memo only labels the transaction; the vault's own signature is what proves who sent it.
export const memo = text => ({ programId: MEMO_PROGRAM, keys: [], data: Buffer.from(text, 'utf8') })

export const closeAccount = ({ account, destination, owner, tokenProgram = TOKEN }) => ({
  programId: tokenProgram, keys: [meta(account, { w: true }), meta(destination, { w: true }), meta(owner, { s: true })], data: u8(9),
})

export const initializeAccount3 = ({ account, mint, owner, tokenProgram = TOKEN }) => ({
  programId: tokenProgram, keys: [meta(account, { w: true }), meta(mint)], data: Buffer.concat([u8(18), pk(owner)]),
})

export const createAccount = ({ from, account, lamports, space, owner }) => ({
  programId: SYSTEM, keys: [meta(from, { w: true, s: true }), meta(account, { w: true, s: true })],
  data: Buffer.concat([u32(0), u64(lamports), u64(space), pk(owner)]),
})

// ---------- JSON-RPC ----------

export class RpcError extends Error {
  constructor(error, method) { super(`${method}: ${error.message || 'RPC error'}`); this.code = error.code; this.data = error.data; this.rpc = true }
}

// Move on to the next upstream only when this one can't serve the call, never on an ordinary error.
const DOWN = /not enabled|unauthori|api key|forbidden|rate limit|too many requests|capacity|unavailable|dedicated node|disabled|not supported|excluded from account secondary indexes|minimum context slot/i
const unavailable = e => e.code === -32005 || e.code === 429 || e.code === -32601 || e.code === -32010 || e.code === -32016 || DOWN.test(String(e.message || ''))

/**
 * rpc(method, params) against each URL in order. Upstream URLs can carry an API key, so logs name them by index.
 * Throws RpcError for an answer the chain gave, or an Error with code 'UNREACHABLE' when no upstream answered.
 */
export function makeRpc(urls, { fetch = globalThis.fetch, timeout = 20_000, log = console.error } = {}) {
  const list = urls.filter(Boolean)
  return async function rpc(method, params = []) {
    let first = null
    for (const [i, url] of list.entries()) {
      try {
        const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(timeout) })
        if (res.status === 429 || res.status === 401 || res.status === 403 || res.status === 410 || res.status >= 500) { log(`vault rpc upstream ${i} unavailable for ${method} (${res.status})`); continue }
        const j = await res.json()
        if (j.error) {
          const err = new RpcError(j.error, method)
          if (!unavailable(j.error)) throw err
          first ??= err
          log(`vault rpc upstream ${i} unavailable for ${method} (${String(j.error.message).slice(0, 80)})`)
          continue
        }
        return j.result
      } catch (err) {
        if (err.rpc) throw err
        log(`vault rpc upstream ${i} unreachable for ${method} (${err.name})`)
      }
    }
    if (first) throw first
    throw Object.assign(new Error('Solana RPC is unreachable right now.'), { code: 'UNREACHABLE' })
  }
}

// ---------- transactions ----------

const shortvec = n => { const out = []; for (;;) { const b = n & 0x7f; n >>= 7; if (!n) { out.push(b); return out } out.push(b | 0x80) } }

/** Compiled legacy message bytes and the addresses that must sign it, in order. */
export function compile({ payer, blockhash, instructions }) {
  const m = compileMessage({ payer, recentBlockhash: blockhash, instructions })
  return { message: serializeMessage(m), signers: m.accountKeys.slice(0, m.header[0]) }
}

/** Wire bytes: the signatures in the message's signer order, then the message. Keys are { address, sign }. */
export function signTransaction({ message, signers }, keys = []) {
  const byAddress = new Map(keys.map(k => [k.address, k]))
  const sigs = signers.map(a => {
    const k = byAddress.get(a)
    if (!k) throw new Error(`missing signer ${a}`)
    return k.sign(message)
  })
  return Uint8Array.from(Buffer.concat([Buffer.from(shortvec(sigs.length)), ...sigs.map(s => Buffer.from(s)), Buffer.from(message)]))
}

/** The same with empty signature slots, for simulation and size checks. */
export const unsignedTransaction = ({ message, signers }) => Uint8Array.from(Buffer.concat([Buffer.from(shortvec(signers.length)), Buffer.alloc(64 * signers.length), Buffer.from(message)]))

const ZERO_HASH = '11111111111111111111111111111111'
const budget = (units, price) => [setComputeUnitLimit(units), setComputeUnitPrice(price)]

/** True when the instructions, with the compute budget in front, fit one legacy transaction. */
export function fits(payer, instructions) {
  try { return unsignedTransaction(compile({ payer, blockhash: ZERO_HASH, instructions: [...budget(MAX_UNITS, 1), ...instructions] })).length <= TX_LIMIT } catch { return false }
}

export class TxError extends Error {
  constructor(message, { logs = [], err = null, signature = null } = {}) { super(message); this.logs = logs; this.err = err; this.signature = signature; this.tx = true }
}

const pause = ms => new Promise(r => setTimeout(r, ms))
const b64 = bytes => Buffer.from(bytes).toString('base64')

/**
 * Prices a transaction: the 75th percentile of recent non-zero priority fees on the accounts it writes, within
 * [min, max] micro-lamports per compute unit, doubled for every earlier attempt that expired.
 */
export async function priorityFee(rpc, writable, { min = 20_000, max = 2_000_000, attempt = 0 } = {}) {
  let fee = min
  try {
    const recent = await rpc('getRecentPrioritizationFees', [writable.slice(0, 128)])
    const paid = (recent || []).map(r => Number(r.prioritizationFee)).filter(f => f > 0).sort((a, b) => a - b)
    if (paid.length) fee = paid[Math.floor(paid.length * 0.75)]
  } catch {}
  return Math.min(max, Math.max(min, fee) * 2 ** attempt)
}

/**
 * Simulates, sets the compute limit from the simulation, signs, sends and confirms. `check(accounts)` sees the
 * simulated post-state of `watch` ({ pubkey, lamports }) before anything is signed and can refuse by throwing.
 * Resends while waiting and gives up once the blockhash has expired (then the transaction can never land, so the
 * caller may rebuild it from fresh state). Returns { signature, slot, units }. Throws TxError when the simulation
 * or the transaction fails, with expired: true when it did not land in time.
 */
export async function execute(rpc, { payer, keys, instructions, price, watch = [], check, label = 'transaction', log = () => {}, resendMs = 2000, pollMs = 1000 }) {
  const { value: { blockhash, lastValidBlockHeight } } = await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])
  const draft = compile({ payer, blockhash, instructions: [...budget(MAX_UNITS, price), ...instructions] })
  const sim = await rpc('simulateTransaction', [b64(unsignedTransaction(draft)), {
    encoding: 'base64', sigVerify: false, commitment: 'confirmed', replaceRecentBlockhash: false,
    ...(watch.length ? { accounts: { encoding: 'base64', addresses: watch } } : {}),
  }])
  const v = sim.value
  if (v.err) throw new TxError(`${label} would fail: ${JSON.stringify(v.err)}`, { logs: v.logs || [], err: v.err })
  if (check) check(watch.map((pubkey, j) => ({ pubkey, lamports: v.accounts && v.accounts[j] ? BigInt(v.accounts[j].lamports) : 0n })))
  const units = Math.min(MAX_UNITS, Math.ceil(Number(v.unitsConsumed || 200_000) * 1.2) + 5_000)
  const built = compile({ payer, blockhash, instructions: [...budget(units, price), ...instructions] })
  const tx = signTransaction(built, keys)
  if (tx.length > TX_LIMIT) throw new TxError(`${label} is ${tx.length} bytes, over the ${TX_LIMIT}-byte limit`)
  const signature = b58encode(tx.subarray(1, 65))
  const wire = b64(tx)
  const sendOnce = () => rpc('sendTransaction', [wire, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }]).catch(err => log(`${label}: send failed (${err.message})`))
  await sendOnce()
  log(`${label}: sent ${signature} (${units} CU at ${price} micro-lamports)`)
  let lastSend = Date.now()
  let rpcErrors = 0
  for (let i = 0; ; i++) {
    await pause(pollMs)
    try {
      const { value: [s] } = await rpc('getSignatureStatuses', [[signature]])
      if (s && s.err) throw new TxError(`${label} failed on-chain: ${JSON.stringify(s.err)}`, { err: s.err, signature })
      if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return { signature, slot: s.slot, units }
      if (i % 5 === 4 && (await rpc('getBlockHeight', [{ commitment: 'confirmed' }])) > lastValidBlockHeight) {
        const { value: [late] } = await rpc('getSignatureStatuses', [[signature], { searchTransactionHistory: true }])
        if (late && !late.err) return { signature, slot: late.slot, units }
        if (late && late.err) throw new TxError(`${label} failed on-chain: ${JSON.stringify(late.err)}`, { err: late.err, signature })
        throw Object.assign(new TxError(`${label} expired before it landed`, { signature }), { expired: true })
      }
    } catch (err) {
      // A hiccup while waiting is not a failure: the transaction may still land. Only a long outage gives up,
      // without claiming the transaction failed (the caller must not treat it as safe to resend).
      if (err.tx || ++rpcErrors > 30) throw err
      log(`${label}: status check failed (${err.message}), still waiting`)
    }
    if (Date.now() - lastSend >= resendMs) { lastSend = Date.now(); await sendOnce() }
  }
}
