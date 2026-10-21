// The rules of the Solana vaults, kept apart from the network so the tests can hold them to exact inputs:
// canonical domains, key derivation, the fee, what DNS must say before a claim, which addresses can be paid, what
// counts as a deposit, and the memos that make the chain the worker's only record.
//
// Every domain has its own vault keypair, derived on the server and never stored or sent anywhere:
//   seed  = HMAC-SHA256(key = the 32-byte master secret, message = "type262:vault:" + canonical domain)
//   vault = the Ed25519 keypair of that seed (RFC 8032; the same seed-to-key step as Solana's keypairs)
// The worker's gas wallet uses the message "type262:gas". The master secret lives only in VAULT_MASTER_SEED.
import { createHmac, createPrivateKey, createPublicKey, sign as edSign } from 'node:crypto'
import { addressKind, normalizeDomain } from '../lib/wallet262.js'
import { SYSTEM, TOKEN, TOKEN_2022, b58decode, b58encode, isPubkey } from './pump.mjs'

/** An error the API answers with as { error, reason } and this HTTP status. */
export class Refusal extends Error {
  constructor(status, error, reason) { super(reason); this.status = status; this.error = error; this.reason = reason; this.refusal = true }
}

// ---------- domains ----------

// The escrow's label rules (solana-proof.js canonicalDomain): lowercase a-z, 0-9, '-' and '_', labels of 1 to 63.
const LABELS = /^(?=.{1,253}$)[a-z0-9_-]{1,63}(\.[a-z0-9_-]{1,63})*$/

/** The SDK's normalizeDomain (IDN to punycode, lowercase, no trailing dot), then the escrow's label rules. */
export function canonicalDomain(input) {
  if (typeof input !== 'string' || !input.trim() || input.length > 300) throw new Refusal(400, 'Bad domain', 'Send a domain name, like example.com.')
  let d
  try { d = normalizeDomain(input) } catch { throw new Refusal(400, 'Bad domain', `${input.slice(0, 80)} is not a domain name.`) }
  if (!LABELS.test(d)) throw new Refusal(400, 'Bad domain', `${input.slice(0, 80)} is not a domain name the vaults accept (letters, digits, '-' and '_').`)
  return d
}

// ---------- keys ----------

// PKCS#8 wrapping of a raw Ed25519 seed, so node:crypto expands it the way RFC 8032 (and Solana) does.
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex')
export const GAS_MESSAGE = 'type262:gas'
export const vaultMessage = domain => `type262:vault:${domain}`

/** The 32-byte master secret from 64 hex characters. The message never repeats the value. */
export function parseMasterSeed(hex) {
  const s = String(hex || '').trim()
  if (!/^[0-9a-fA-F]{64}$/.test(s)) throw new Error('VAULT_MASTER_SEED must be 64 hex characters (32 bytes)')
  return Buffer.from(s, 'hex')
}

/** { address, sign(message) }: the private key stays inside this closure and is never exported or logged. */
export function keypairFromSeed(seed) {
  if (seed.length !== 32) throw new Error('An Ed25519 seed is 32 bytes')
  const der = Buffer.concat([PKCS8_ED25519, seed])
  const privateKey = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
  der.fill(0)
  const address = b58encode(Buffer.from(createPublicKey(privateKey).export({ format: 'jwk' }).x, 'base64url'))
  return Object.freeze({ address, sign: message => new Uint8Array(edSign(null, Buffer.from(message), privateKey)), toJSON: () => ({ address }) })
}

function derive(master, message) {
  const seed = createHmac('sha256', master).update(message, 'utf8').digest()
  try { return keypairFromSeed(seed) } finally { seed.fill(0) }
}

export const vaultKeypair = (master, domain) => derive(master, vaultMessage(domain))
export const gasKeypair = master => derive(master, GAS_MESSAGE)

/** A Solana CLI keypair file's JSON (64 numbers: seed then public key), for a gas wallet funded outside the master. */
export function keypairFromSolanaJson(text) {
  let bytes
  try { bytes = Buffer.from(JSON.parse(String(text))) } catch { throw new Error('SOLANA_GAS_KEYPAIR must be a Solana keypair JSON array') }
  if (bytes.length !== 64) throw new Error('SOLANA_GAS_KEYPAIR must hold 64 bytes')
  try {
    const kp = keypairFromSeed(bytes.subarray(0, 32))
    if (kp.address !== b58encode(bytes.subarray(32))) throw new Error('SOLANA_GAS_KEYPAIR does not match its own public key')
    return kp
  } finally { bytes.fill(0) }
}

// ---------- the fee ----------

/** fee_bps of an amount, rounded down: never more than the share, and 0 for dust. */
export const feeOf = (amount, feeBps) => (BigInt(amount) * BigInt(feeBps)) / 10_000n

// ---------- what DNS must say ----------

const resolverName = r => ({ cloudflare: 'Cloudflare', google: 'Google' })[r] || (() => { try { return new URL(r).host } catch { return String(r) } })()

/**
 * The SOL wallet a domain publishes, from lib/wallet262.js resolveWallets(): every resolver must answer, publish
 * exactly one SOL address (in its WALLET record or _wallet TXT), agree with the others on it, and mark the answer
 * DNSSEC-validated (AD). Throws a Refusal with the plain reason otherwise.
 */
export function solWalletFrom(res, { resolvers = 2 } = {}) {
  const domain = res.domain
  const answers = res.resolvers || []
  if (answers.length < resolvers) throw new Refusal(422, 'DNS check failed', `Both DNS resolvers must answer for ${domain}.`)
  for (const r of answers) {
    if (!r.ok) throw new Refusal(422, 'DNS check failed', `${resolverName(r.resolver)} did not answer for ${domain} (${String(r.error || 'no answer').slice(0, 120)}). Try again in a moment.`)
  }
  const seen = answers.map(r => {
    const sol = r.records.filter(x => x.code === 'SOL')
    if (!sol.length) {
      const why = r.status === 2 ? ' (the resolver could not validate its DNSSEC)' : ''
      throw new Refusal(422, 'No SOL wallet in DNS', `${domain} does not publish a SOL address${why}. Add a WALLET (type 262) record or a _wallet TXT record such as "SOL <your address>".`)
    }
    const unsigned = sol.find(x => !x.dnssec)
    if (unsigned) throw new Refusal(422, 'DNS check failed', `${resolverName(r.resolver)} did not validate the SOL record of ${domain} with DNSSEC. Sign the zone with DNSSEC and try again.`)
    const bad = sol.find(x => addressKind(x.address) !== 'solana')
    if (bad) throw new Refusal(422, 'Bad SOL record', `The SOL record of ${domain} holds ${String(bad.address).slice(0, 60)}, which is not a Solana address.`)
    return [...new Set(sol.map(x => x.address))].sort()
  })
  if (seen.some(s => s.join() !== seen[0].join())) throw new Refusal(422, 'DNS check failed', `The DNS resolvers disagree on the SOL address of ${domain}. Wait for the change to spread and try again.`)
  if (seen[0].length !== 1) throw new Refusal(422, 'Bad SOL record', `${domain} publishes more than one SOL address. Keep exactly one.`)
  return seen[0][0]
}

/**
 * Why an address can't receive a payout, or '' when it is a normal wallet: a system account with no data, or one
 * that does not exist yet. `info` is getAccountInfo's value (null when the account doesn't exist).
 */
export function recipientProblem(address, info, { vault } = {}) {
  if (!isPubkey(address)) return `${String(address).slice(0, 60)} is not a Solana address.`
  if (address === vault) return 'The DNS record names the domain\'s own vault. Publish your wallet instead.'
  if (!info) return ''
  const size = Array.isArray(info.data) ? Buffer.from(info.data[0], info.data[1] || 'base64').length : Number(info.space || 0)
  if (info.executable) return `${address} is a program, not a wallet.`
  if (info.owner === SYSTEM) return size ? `${address} is a system account that holds data (a nonce account), not a wallet.` : ''
  if (info.owner === TOKEN || info.owner === TOKEN_2022) return size === 82 ? `${address} is a token mint, not a wallet.` : `${address} is a token account, not a wallet. Publish the wallet that owns it.`
  return `${address} is an account of program ${info.owner}, not a wallet.`
}

// ---------- memos ----------

export const claimMemo = domain => `type262:claim:${domain}`
export const refundMemo = signature => `type262:refund:${signature}`

/** The memo texts of a jsonParsed transaction (top level and inner instructions). */
export function memosOf(tx) {
  return instructionsOf(tx).filter(ix => ix.program === 'spl-memo' && typeof ix.parsed === 'string').map(ix => ix.parsed)
}

const keysOf = tx => tx.transaction.message.accountKeys.map(k => (typeof k === 'string' ? { pubkey: k } : k))
export const signersOf = tx => keysOf(tx).filter((k, i) => k.signer ?? i < tx.transaction.message.header?.numRequiredSignatures).map(k => k.pubkey)

function instructionsOf(tx) {
  const inner = (tx.meta && tx.meta.innerInstructions) || []
  return [...tx.transaction.message.instructions, ...inner.flatMap(i => i.instructions)]
}

/** A transaction the vault signed (only the worker holds its key) that succeeded and carries exactly `text`. */
export const vaultSignedWithMemo = (tx, vault, text) => !!tx && !(tx.meta && tx.meta.err) && signersOf(tx).includes(vault) && memosOf(tx).includes(text)

// ---------- deposits ----------

const SOL_TRANSFERS = new Set(['transfer', 'transferWithSeed'])
const TOKEN_TRANSFERS = new Set(['transfer', 'transferChecked', 'transferCheckedWithFee'])
const TOKEN_PROGRAMS = { 'spl-token': TOKEN, 'spl-token-2022': TOKEN_2022 }

/**
 * The deposit a confirmed transaction (getTransaction, jsonParsed) made to `vault`: { mint ('SOL' or the mint),
 * amount (bigint), from (the wallet to refund), account (where the vault holds it), program, decimals, slot,
 * blockTime }. One sender and one asset per transaction; a transaction the vault signed (a claim, refund or
 * collect) is never a deposit, and lamports pump.fun pays in are creator fees, not deposits.
 */
export function depositOf(tx, vault) {
  if (!tx || !tx.meta) throw new Refusal(404, 'Deposit not found', 'No confirmed transaction with that signature.')
  if (tx.meta.err) throw new Refusal(422, 'Not a deposit', 'That transaction failed, so it moved nothing.')
  if (signersOf(tx).includes(vault)) throw new Refusal(422, 'Not a deposit', 'That transaction was sent by the vault itself (a claim, refund or collect), not a deposit.')
  const keys = keysOf(tx).map(k => k.pubkey)
  const balance = (list, account) => (list || []).find(b => keys[b.accountIndex] === account)
  const groups = new Map()
  const add = (d, amount) => {
    const k = `${d.from}|${d.mint}|${d.account}`
    const g = groups.get(k)
    if (g) g.amount += amount; else groups.set(k, { ...d, amount })
  }
  for (const ix of instructionsOf(tx)) {
    const p = ix.parsed
    if (!p || typeof p !== 'object') continue
    const info = p.info || {}
    if (ix.program === 'system' && SOL_TRANSFERS.has(p.type) && info.destination === vault) {
      add({ mint: 'SOL', from: info.source, account: vault, program: SYSTEM, decimals: 9 }, BigInt(info.lamports))
    } else if (TOKEN_PROGRAMS[ix.program] && TOKEN_TRANSFERS.has(p.type)) {
      const post = balance(tx.meta.postTokenBalances, info.destination)
      if (!post || post.owner !== vault) continue
      const source = balance(tx.meta.preTokenBalances, info.source)
      const from = (source && source.owner) || info.authority || info.multisigAuthority
      const amount = BigInt(info.amount ?? info.tokenAmount?.amount ?? 0)
      add({ mint: post.mint, from, account: info.destination, program: TOKEN_PROGRAMS[ix.program], decimals: post.uiTokenAmount.decimals }, amount)
    }
  }
  const found = [...groups.values()].filter(d => d.amount > 0n)
  if (!found.length) throw new Refusal(422, 'Not a deposit', 'That transaction sent nothing to this domain\'s vault.')
  if (found.length > 1) throw new Refusal(422, 'Not a single deposit', 'That transaction holds more than one deposit (several senders or assets); it can\'t be refunded automatically.')
  const d = found[0]
  if (d.mint !== 'SOL') {
    // A token with a transfer fee credits less than was sent: refund what the vault actually received.
    const pre = balance(tx.meta.preTokenBalances, d.account)
    const post = balance(tx.meta.postTokenBalances, d.account)
    const credited = BigInt(post.uiTokenAmount.amount) - BigInt(pre ? pre.uiTokenAmount.amount : 0)
    if (credited < d.amount) d.amount = credited
    if (d.amount <= 0n) throw new Refusal(422, 'Not a deposit', 'That transaction left nothing in this domain\'s vault.')
  }
  if (!isPubkey(d.from)) throw new Refusal(422, 'Not a deposit', 'The sender of that deposit can\'t be told apart.')
  return { ...d, slot: tx.slot, blockTime: tx.blockTime }
}

/** A base58 transaction signature (64 bytes), or a Refusal. */
export function parseSignature(s) {
  let ok = false
  try { ok = typeof s === 'string' && s.length <= 90 && b58decode(s).length === 64 } catch {}
  if (!ok) throw new Refusal(400, 'Bad signature', 'Send the deposit\'s transaction signature.')
  return s
}
