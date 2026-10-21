// DNSSEC proofs for the type262 Solana program, built in the browser. A domain's proof becomes the ordered
// steps the program verifies one RRset at a time (root DNSKEY, then DS and DNSKEY per zone, then the
// `_wallet` TXT or WALLET leaf); P-256 and Ed25519 steps get their secp256r1 / ed25519 precompile entries;
// and a planner packs the steps that are not cached on-chain yet into legacy transactions.
// Layouts follow solana/docs/DNSSEC.md and the reference parser in solana/bench/src/dnssec.rs. Nothing
// here is trusted: the program re-checks every byte, so a bad proof only costs the failed transaction.
import {
  SYSTEM_PROGRAM, base58Encode, base64Decode, compileMessage, findProgramAddress, pubkeyBytes, rpc as solanaRpc,
  serializeMessage, unsignedTransaction,
} from './solana.js'

export const TYPE_A = 1
export const TYPE_TXT = 16
export const TYPE_DS = 43
export const TYPE_DNSKEY = 48
export const TYPE_WALLET = 262
const TYPE_NAMES = { 1: 'A', 16: 'TXT', 43: 'DS', 48: 'DNSKEY', 262: 'WALLET' }

export const LEGACY_TX_LIMIT = 1232
export const MAX_COMPUTE_UNITS = 1_400_000
/** Where `verify_rrset_precompiled` data puts the signed set: 8-byte discriminator + u32 length. */
export const PRECOMPILE_MESSAGE_OFFSET = 12
// The secp256r1 precompile refuses more than 8 signatures per instruction; ed25519 takes the same cap here.
const MAX_PRECOMPILE_ENTRIES = 8

export const SECP256R1_PROGRAM = 'Secp256r1SigVerify1111111111111111111111111'
export const ED25519_PROGRAM = 'Ed25519SigVerify111111111111111111111111111'
export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111'
export const INSTRUCTIONS_SYSVAR = 'Sysvar1nstructions1111111111111111111111111'

/** P-256 group order. The precompile only accepts s <= n/2. */
export const P256_ORDER = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n
const P256_HALF_ORDER = P256_ORDER >> 1n

export const DOH_URL = 'https://cloudflare-dns.com/dns-query'
const LIB = './vendor/dnsprovejs-1.0.1.mjs' // pinned copy of @ensdomains/dnsprovejs@1.0.1, as dnssec.js

// ---------- bytes ----------
const enc = new TextEncoder()
const utf8 = s => enc.encode(s)
const concat = parts => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let i = 0
  for (const p of parts) { out.set(p, i); i += p.length }
  return out
}
const u16le = n => Uint8Array.of(n & 255, (n >> 8) & 255)
const u16be = n => Uint8Array.of((n >> 8) & 255, n & 255)
const u32le = n => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b }
const u64le = v => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v), true); return b }
const vecU8 = bytes => concat([u32le(bytes.length), bytes]) // borsh Vec<u8>
const view = b => new DataView(b.buffer, b.byteOffset, b.byteLength)
const shortvecLength = n => (n < 0x80 ? 1 : n < 0x4000 ? 2 : 3)

export const toHex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
export function fromHex(s) {
  const h = String(s).replace(/^0x/i, '')
  if (h.length % 2 || /[^0-9a-f]/i.test(h)) throw new Error('Not hex')
  return Uint8Array.from(h.match(/../g) || [], x => parseInt(x, 16))
}
/** A plain Uint8Array copy of bytes, a Buffer or a hex string. */
const bytesOf = x => (typeof x === 'string' ? fromHex(x) : new Uint8Array(x))
export const equalBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])
/** RFC 4034 6.3 order: bytewise, a shorter prefix first. */
export function compareBytes(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i]
  return a.length - b.length
}
export const sha256 = async bytes => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
const bigOf = b => b.reduce((n, x) => (n << 8n) | BigInt(x), 0n)
const bytes32 = n => Uint8Array.from({ length: 32 }, (_, i) => Number((n >> BigInt(8 * (31 - i))) & 255n))

// ---------- names ----------

/**
 * A domain as the program stores it: lowercase ASCII labels of a-z 0-9 - _ (IDNs as punycode), 1 to 63
 * each, at most 253 characters, no trailing dot.
 */
export function canonicalDomain(input) {
  let s = String(input || '').trim().replace(/\.$/, '')
  // The URL parser does the IDN to punycode conversion browsers already ship.
  if (/[^\x00-\x7f]/.test(s)) {
    try { s = new URL(`http://${s}`).hostname } catch { throw new Error(`Not a valid domain: ${input}`) }
  }
  s = s.toLowerCase()
  if (!/^(?=.{1,253}$)[a-z0-9_-]{1,63}(\.[a-z0-9_-]{1,63})*$/.test(s)) throw new Error(`Not a valid domain: ${input}`)
  return s
}

/** Canonical (lowercase, uncompressed) wire form of a name; "." and "" are the root. */
export function nameToWire(name) {
  const n = String(name).toLowerCase().replace(/\.$/, '')
  if (!n) return Uint8Array.of(0)
  const parts = []
  for (const label of n.split('.')) {
    const b = utf8(label)
    if (!b.length || b.length > 63 || b.length !== label.length) throw new Error(`Bad DNS name: ${name}`)
    parts.push(Uint8Array.of(b.length), b)
  }
  parts.push(Uint8Array.of(0))
  const wire = concat(parts)
  if (wire.length > 255) throw new Error(`DNS name too long: ${name}`)
  return wire
}

/** "example.com." from wire form ("." for the root). */
export function wireToName(wire) {
  const labels = []
  for (let at = 0; wire[at];) { labels.push(String.fromCharCode(...wire.subarray(at + 1, at + 1 + wire[at]))); at += 1 + wire[at] }
  return labels.length ? labels.join('.') + '.' : '.'
}

// ---------- signed sets ----------
// A step's `signed` bytes are the RRSIG RDATA without the signature (type covered, algorithm, labels, original
// TTL, expiration, inception, key tag, signer) followed by the RRs in canonical wire form (RFC 4034 3.1.8.1),
// the same bytes dnsprovejs `SignedSet.toWire()` gives the EVM verifier.

/**
 * Errors carry in `code` the name the program gives the same rejection (errors.rs, 6100 range); BadSignature,
 * NeedsV1, NeedsSplitRsa and StaleProof are the client's own.
 */
const stepError = (code, detail) => Object.assign(new Error(detail ? `${code}: ${detail}` : code), { code })

function readName(b, at, strict) {
  let p = at
  let labels = 0
  for (;;) {
    if (p >= b.length) throw stepError('BadName')
    const l = b[p]
    if (l === 0) { p++; break }
    if (l > 63 || p + 1 + l > b.length) throw stepError('BadName') // also rejects compression pointers
    if (strict) for (let i = p + 1; i <= p + l; i++) if (b[i] >= 65 && b[i] <= 90) throw stepError('NameNotLowercase')
    p += 1 + l
    labels++
  }
  if (p - at > 255) throw stepError('BadName')
  return { name: b.subarray(at, p), length: p - at, labels }
}

/** True if `name` equals `ancestor` or is below it (both canonical wire names). */
function isAtOrBelow(name, nameLabels, ancestor, ancestorLabels) {
  if (ancestorLabels > nameLabels) return false
  let at = 0
  for (let i = 0; i < nameLabels - ancestorLabels; i++) at += 1 + name[at]
  return equalBytes(name.subarray(at), ancestor)
}

/**
 * Parses signed bytes with exactly the checks of `parse_signed` in solana/bench/src/dnssec.rs: uncompressed
 * lowercase names, one owner, class IN, the covered type, RRSIG labels = owner labels, signer at or above
 * the owner; and, given `now` (unix seconds), the validity window in RFC 1982 serial arithmetic.
 */
export function parseSigned(signed, now) {
  if (signed.length < 18) throw stepError('BadSignedData')
  const v = view(signed)
  const signer = readName(signed, 18, true)
  const out = {
    typeCovered: v.getUint16(0), algorithm: signed[2], labels: signed[3], originalTtl: v.getUint32(4),
    expiration: v.getUint32(8), inception: v.getUint32(12), keyTag: v.getUint16(16),
    signer: signed.slice(18, 18 + signer.length), signerLabels: signer.labels,
  }
  let at = 18 + signer.length
  let owner = null
  let ownerLabels = 0
  const records = []
  while (at < signed.length) {
    const n = readName(signed, at, true)
    if (!records.length) { owner = n.name; ownerLabels = n.labels } else if (!equalBytes(n.name, owner)) throw stepError('InvalidRRSet')
    const f = at + n.length
    if (f + 10 > signed.length) throw stepError('BadSignedData')
    if (v.getUint16(f) !== out.typeCovered) throw stepError('SignatureTypeMismatch')
    if (v.getUint16(f + 2) !== 1) throw stepError('InvalidClass')
    const start = f + 10
    const end = start + v.getUint16(f + 8)
    if (end > signed.length) throw stepError('BadSignedData')
    records.push(signed.slice(start, end))
    at = end
  }
  if (!records.length) throw stepError('EmptyRRset')
  // Wildcard expansions sign fewer labels than the owner has: rejected, as in ENS.
  if (ownerLabels !== out.labels) throw stepError('InvalidLabelCount')
  if (!isAtOrBelow(owner, ownerLabels, out.signer, out.signerLabels)) throw stepError('InvalidSignerName')
  Object.assign(out, { owner: owner.slice(), ownerLabels, rrtype: out.typeCovered, records, headerLength: 18 + signer.length })
  if (now != null) {
    const t = validity(out, now)
    if (t.expired) throw stepError('SignatureExpired', `${wireToName(out.owner)} ${typeName(out.rrtype)} expired`)
    if (t.notYetValid) throw stepError('SignatureNotValidYet', `${wireToName(out.owner)} ${typeName(out.rrtype)} is not valid yet`)
  }
  return out
}

/**
 * What the program records for a set verified at `now`: `signedAt` (the inception counted back from now) and
 * `expiresAt` (its own expiration; the program also caps it at the parent's), both in serial arithmetic.
 */
export function validity({ inception, expiration }, now) {
  const now32 = now >>> 0
  const left = (expiration - now32) | 0
  const age = (now32 - inception) | 0
  return { signedAt: now - age, expiresAt: now + left, expired: left < 0, notYetValid: age < 0 }
}

/** The signed bytes for an RRSIG and its records, in canonical form: lowercase names, original TTL, sorted, no duplicates. */
export function encodeSigned(rrsig, owner, rrtype, records) {
  const head = new Uint8Array(18)
  const v = new DataView(head.buffer)
  v.setUint16(0, rrsig.typeCovered)
  head[2] = rrsig.algorithm
  head[3] = rrsig.labels
  v.setUint32(4, rrsig.originalTtl)
  v.setUint32(8, rrsig.expiration)
  v.setUint32(12, rrsig.inception)
  v.setUint16(16, rrsig.keyTag)
  const ownerWire = lowerName(bytesOf(owner))
  const sorted = [...records].map(bytesOf).sort(compareBytes).filter((r, i, all) => !i || !equalBytes(r, all[i - 1]))
  const rrs = sorted.map(rdata => {
    const f = new Uint8Array(10)
    const fv = new DataView(f.buffer)
    fv.setUint16(0, rrtype)
    fv.setUint16(2, 1)
    fv.setUint32(4, rrsig.originalTtl)
    fv.setUint16(8, rdata.length)
    return concat([ownerWire, f, rdata])
  })
  return concat([head, lowerName(bytesOf(rrsig.signer)), ...rrs])
}
// Lowercase copy of a wire name; its length bytes are below 64, so never A-Z.
const lowerName = w => w.map(c => (c >= 65 && c <= 90 ? c + 32 : c))

/**
 * Canonical form of signed bytes as a resolver or dnsprovejs may hand them over (mixed-case names, any record
 * order, duplicates). Only names are lowercased, never RDATA. Throws on anything not a single RRset.
 */
export function canonicalSigned(bytes) {
  const b = bytesOf(bytes)
  if (b.length < 18) throw stepError('BadSignedData')
  const v = view(b)
  const signer = readName(b, 18, false)
  const rrsig = {
    typeCovered: v.getUint16(0), algorithm: b[2], labels: b[3], originalTtl: v.getUint32(4),
    expiration: v.getUint32(8), inception: v.getUint32(12), keyTag: v.getUint16(16), signer: signer.name,
  }
  let owner = null
  const records = []
  for (let at = 18 + signer.length; at < b.length;) {
    const n = readName(b, at, false)
    const f = at + n.length
    if (f + 10 > b.length) throw stepError('BadSignedData')
    const end = f + 10 + v.getUint16(f + 8)
    if (end > b.length) throw stepError('BadSignedData')
    if (owner && !equalBytes(lowerName(n.name), lowerName(owner))) throw stepError('InvalidRRSet')
    if (v.getUint16(f) !== rrsig.typeCovered) throw stepError('SignatureTypeMismatch')
    if (v.getUint16(f + 2) !== 1) throw stepError('InvalidClass')
    owner = owner || n.name
    records.push(b.subarray(f + 10, end))
    at = end
  }
  if (!owner) throw stepError('EmptyRRset')
  return encodeSigned(rrsig, owner, rrsig.typeCovered, records)
}

/** RFC 4034 appendix B (algorithm 1 is never accepted, so its special case is left out). */
export function keyTag(rdata) {
  let ac = 0
  for (let i = 0; i < rdata.length; i++) ac += i & 1 ? rdata[i] : rdata[i] << 8
  ac += (ac >> 16) & 0xffff
  return ac & 0xffff
}

const typeName = t => TYPE_NAMES[t] || `TYPE${t}`
// The program verifies 8 RSASHA256, 13 ECDSAP256SHA256 and 15 Ed25519, nothing else (dnssec.rs `step`).
const kindOf = alg => (alg === 8 ? 'rsa' : alg === 13 ? 'p256' : alg === 15 ? 'ed25519' : null)
const setKey = (owner, rrtype) => `${toHex(owner)}/${rrtype}`
/** The zone whose key signed a set, for messages ("example.com", or "the root zone" / "The root zone" at the start). */
const zoneOf = (step, start) => (step.signer.length === 1 ? `${start ? 'T' : 't'}he root zone` : wireToName(step.signer).slice(0, -1))

/** RSASHA1 and RSASHA1-NSEC3-SHA1: the program refuses both (UnsupportedAlgorithm). */
const SHA1_ALGORITHMS = { 5: 'RSASHA1', 7: 'RSASHA1-NSEC3-SHA1' }
/** RSA signatures (as long as the modulus) the program takes: 1024 to 4096-bit keys. */
export const RSA_SIGNATURE_BYTES = [128, 512]
/**
 * The largest RSA key one transaction verifies: RSA-2048 uses about 1.2M of the 1.4M compute units. Larger keys
 * need the split verifier (DNSSEC.md, "RSA in BPF"), which is not built yet, so the planner refuses them.
 */
export const MAX_RSA_BITS = 2048

/**
 * Byte order of the rrtype in RRset PDA seeds. The program derives ["rrset", sha256(owner wire name), rrtype
 * u16 BE] (dnssec.rs `store` and `wallet_signed_at`, constants.rs, the Rust harness); DNSSEC.md's table says
 * LE. Addresses must match the program, so BE; anchorEncoder({ rrtypeEndian: 'le' }) gives the other.
 */
export const RRSET_TYPE_ENDIAN = 'be'

/** The cached-set PDA seeds ["rrset", sha256(owner wire name), rrtype as u16]. An encoder can override them. */
export const rrsetSeeds = ({ nameHash, rrtype }, endian = RRSET_TYPE_ENDIAN) => [utf8('rrset'), nameHash, endian === 'le' ? u16le(rrtype) : u16be(rrtype)]

/**
 * One proof step from its signed bytes and RRSIG signature (bytes or hex). The parent is fixed by the data, as
 * the program derives it: a self-signed DNSKEY set is checked against the DS set at its name (the root anchors
 * for "."), every other set against the DNSKEY set at its signer.
 */
export async function buildStep(signedInput, sigInput) {
  const signed = canonicalSigned(signedInput)
  const sig = bytesOf(sigInput)
  const p = parseSigned(signed)
  const kind = kindOf(p.algorithm)
  if (SHA1_ALGORITHMS[p.algorithm]) {
    throw stepError('UnsupportedAlgorithm', `${zoneOf(p, true)} signs with ${SHA1_ALGORITHMS[p.algorithm]} (algorithm ${p.algorithm}), which the program on Solana doesn't accept: it takes algorithms 8 (RSASHA256), 13 (ECDSAP256SHA256) and 15 (Ed25519). The proof works once ${zoneOf(p)} is signed with one of those.`)
  }
  if (!kind) throw stepError('UnsupportedAlgorithm', `algorithm ${p.algorithm} on ${wireToName(p.owner)} ${typeName(p.rrtype)}`)
  const [minRsa, maxRsa] = RSA_SIGNATURE_BYTES
  if (kind === 'rsa' ? sig.length < minRsa || sig.length > maxRsa : sig.length !== 64) {
    throw stepError('BadSignature', `${sig.length}-byte signature for algorithm ${p.algorithm}${kind === 'rsa' ? ` (RSA keys of 1024 to 4096 bits sign ${minRsa} to ${maxRsa} bytes)` : ''}`)
  }
  const selfSigned = p.rrtype === TYPE_DNSKEY && equalBytes(p.owner, p.signer)
  const isRoot = selfSigned && p.owner.length === 1
  const parent = isRoot ? null : selfSigned ? { owner: p.owner, rrtype: TYPE_DS } : { owner: p.signer, rrtype: TYPE_DNSKEY }
  if (parent) parent.nameHash = await sha256(parent.owner)
  const nameHash = await sha256(p.owner)
  const step = {
    ...p, signed, sig, kind, nameHash, parent, selfSigned,
    ownerName: wireToName(p.owner), signerName: wireToName(p.signer), typeName: typeName(p.rrtype),
    bits: kind === 'rsa' ? sig.length * 8 : kind === 'p256' ? 256 : 255,
  }
  step.label = `${step.ownerName} ${step.typeName}`
  step.seeds = rrsetSeeds(step)
  return step
}

/**
 * Steps for a whole proof, parents first. Takes dnsprovejs SignedSets (`[...proofs, answer]`) or objects with
 * `signed`/`rrset` and `sig` (bytes or hex, as in the EVM proof and the bench fixtures). The last set given is
 * the leaf and stays last.
 */
export async function stepsFromSets(sets) {
  const built = []
  for (const s of sets) {
    const signed = typeof s.toWire === 'function' ? s.toWire() : (s.signed ?? s.rrset)
    const sig = s.signature?.data?.signature ?? s.sig
    built.push(await buildStep(signed, sig))
  }
  const byKey = new Map()
  for (const s of built) if (!byKey.has(setKey(s.owner, s.rrtype))) byKey.set(setKey(s.owner, s.rrtype), s)
  const leaf = byKey.get(setKey(built.at(-1).owner, built.at(-1).rrtype))
  const out = []
  const done = new Set()
  const visiting = new Set()
  const visit = s => {
    const k = setKey(s.owner, s.rrtype)
    if (done.has(k)) return
    if (visiting.has(k)) throw stepError('WrongParent', `${s.label} depends on itself`)
    visiting.add(k)
    const p = s.parent && byKey.get(setKey(s.parent.owner, s.parent.rrtype))
    if (p) visit(p)
    visiting.delete(k)
    done.add(k)
    if (s !== leaf) out.push(s)
  }
  for (const s of byKey.values()) visit(s)
  out.push(leaf)
  out.forEach((s, i) => { s.index = i })
  return out
}

// ---------- the wallet record ----------

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/** Exactly 32 bytes from base58 (each leading "1" one zero byte), or null; mirrors `base58_32`. */
export function base58To32(s) {
  if (!s.length || s.length > 44) return null
  let n = 0n
  for (const c of s) {
    const i = B58.indexOf(c)
    if (i < 0) return null
    n = n * 58n + BigInt(i)
  }
  if (n >> 256n) return null
  const out = bytes32(n)
  const ones = s.match(/^1*/)[0].length
  const zeros = out.findIndex(x => x !== 0)
  return ones === (zeros < 0 ? 32 : zeros) ? out : null
}

/**
 * The Solana address one WALLET / `_wallet` TXT RDATA publishes, as base58, or null. Same shapes as the
 * program (`sol_wallet`): two character-strings "SOL" "<base58>", or one "SOL <base58>" / "SOL:<base58>"
 * with any run of spaces and colons between; coin in any case; never the all-zero key.
 */
export function solWallet(rdata) {
  const r = bytesOf(rdata)
  if (!r.length || 1 + r[0] > r.length) return null
  let coin
  let addr
  if (1 + r[0] === r.length) {
    const s = r.subarray(1)
    const i = s.findIndex(c => c === 32 || c === 58)
    if (i < 0) return null
    let j = i
    while (j < s.length && (s[j] === 32 || s[j] === 58)) j++
    coin = s.subarray(0, i)
    addr = s.subarray(j)
  } else {
    const l0 = r[0]
    if (2 + l0 + r[1 + l0] !== r.length) return null
    coin = r.subarray(1, 1 + l0)
    addr = r.subarray(2 + l0)
  }
  if (String.fromCharCode(...coin).toUpperCase() !== 'SOL' || coin.length !== 3) return null
  const key = base58To32(String.fromCharCode(...addr))
  return key && key.some(x => x) ? base58Encode(key) : null
}

/** The SOL addresses a leaf publishes for `domain`: TXT only at `_wallet.<domain>`, WALLET only at the domain. */
export function leafWallets(step, domain) {
  const d = nameToWire(canonicalDomain(domain))
  const ok = step.rrtype === TYPE_WALLET ? equalBytes(step.owner, d)
    : step.rrtype === TYPE_TXT && equalBytes(step.owner, concat([Uint8Array.of(7), utf8('_wallet'), d]))
  return ok ? [...new Set(step.records.map(solWallet).filter(Boolean))] : []
}

export const publishes = (step, domain, wallet) => leafWallets(step, domain).includes(wallet)

// ---------- fetching a proof (dnsprovejs over DNS-over-HTTPS) ----------

/**
 * The algorithms dnsprovejs picks signatures by: the three the program verifies (the defaults lack Ed25519), so a
 * zone that also signs with another algorithm, as during an algorithm rollover, proves through the one it accepts.
 * dnsprovejs only routes here; the signatures are checked on-chain.
 */
const ALGORITHMS = { 8: { name: 'RSASHA256', f: () => true }, 13: { name: 'P256SHA256', f: () => true }, 15: { name: 'ED25519', f: () => true } }
const WITH_SHA1 = { ...ALGORITHMS, ...Object.fromEntries(Object.entries(SHA1_ALGORITHMS).map(([n, name]) => [n, { name, f: () => true }])) }

/**
 * The signed sets proving `type name` from the root, or null if there is no such record. A chain signed with
 * RSASHA1 only (algorithm 5 or 7) is fetched as it is, so that stepsFromSets can name the algorithm it refuses.
 */
export async function fetchProof(type, name, { doh = DOH_URL, sendQuery } = {}) {
  const { DNSProver, DEFAULT_DIGESTS, NoValidDnskeyError, NoValidDsError, dohQuery } = await import(LIB)
  const query = sendQuery || dohQuery(doh)
  // dns-packet names unknown types UNKNOWN_<n> both ways.
  const qtype = type === 'WALLET' || type === TYPE_WALLET ? 'UNKNOWN_262' : type
  const prove = algorithms => new DNSProver(query, DEFAULT_DIGESTS, algorithms).queryWithProof(qtype, name)
  let result
  try { result = await prove(ALGORITHMS) } catch (err) {
    if (!(err instanceof NoValidDnskeyError || err instanceof NoValidDsError)) throw err
    result = await prove(WITH_SHA1).catch(() => { throw err })
  }
  return result && result.answer && result.answer.records.length ? [...result.proofs, result.answer] : null
}

/**
 * The proof a claim uses: `_wallet.<domain>` TXT first, then the WALLET record at the domain. Returns the first
 * that publishes a SOL address (`wallet`, when given). Throws with the reason otherwise.
 */
export async function fetchWalletProof(domain, { wallet, ...opts } = {}) {
  const name = canonicalDomain(domain)
  const seen = []
  let failure
  for (const [type, qname] of [['TXT', `_wallet.${name}`], ['WALLET', name]]) {
    let sets
    try { sets = await fetchProof(type, qname, opts) } catch (err) { failure = failure || err; continue }
    if (!sets) continue
    const steps = await stepsFromSets(sets)
    const leaf = steps.at(-1)
    const wallets = leafWallets(leaf, name)
    if (wallets.length && (!wallet || wallets.includes(wallet))) return { domain: name, type, steps, leaf, wallets }
    seen.push(...wallets.map(w => `${w} (${type})`))
    if (!wallets.length) seen.push(`no SOL address in ${qname} ${type}`)
  }
  if (seen.length) throw new Error(wallet ? `${name} does not publish ${wallet}: ${seen.join(', ')}` : `${name} publishes no Solana address: ${seen.join(', ')}`)
  throw Object.assign(new Error(`No DNSSEC-signed _wallet TXT or WALLET record for ${name}${failure ? ` (${failure.message})` : ''}`), { cause: failure })
}

// ---------- P-256 and Ed25519 precompiles ----------

/** The 33-byte compressed point the secp256r1 precompile takes, from a DNSKEY's 64-byte x || y. */
export function p256Compress(xy) {
  if (xy.length !== 64) throw new Error('P-256 key must be 64 bytes (x || y)')
  return concat([Uint8Array.of(2 | (xy[63] & 1)), xy.subarray(0, 32)])
}

/**
 * The low-S form of a raw r || s P-256 signature: s replaced by n - s when s > n/2. Both are the same valid
 * ECDSA signature; the precompile only takes the low one and DNSSEC signers do not normalize.
 */
export function p256LowS(sig) {
  if (sig.length !== 64) throw new Error('P-256 signature must be 64 bytes (r || s)')
  const s = bigOf(sig.subarray(32))
  if (s <= P256_HALF_ORDER || s >= P256_ORDER) return { signature: sig.slice(), flipped: false }
  return { signature: concat([sig.subarray(0, 32), bytes32(P256_ORDER - s)]), flipped: true }
}

/** DER (SEQUENCE of two INTEGERs) from a raw r || s signature. */
export function p256RawToDer(raw) {
  if (raw.length !== 64) throw new Error('P-256 signature must be 64 bytes (r || s)')
  const int = b => {
    let i = 0
    while (i < 31 && b[i] === 0) i++
    const v = b.subarray(i)
    return concat([Uint8Array.of(2, v.length + (v[0] >> 7)), v[0] & 0x80 ? Uint8Array.of(0) : new Uint8Array(0), v])
  }
  const body = concat([int(raw.subarray(0, 32)), int(raw.subarray(32))])
  return concat([Uint8Array.of(0x30, body.length), body])
}

/** Raw r || s from a DER signature. Strict about lengths; throws on anything else. */
export function p256DerToRaw(der) {
  const d = bytesOf(der)
  const bad = () => new Error('Not a DER P-256 signature')
  if (d[0] !== 0x30 || d[1] !== d.length - 2) throw bad()
  const out = new Uint8Array(64)
  let at = 2
  for (const slot of [0, 32]) {
    if (d[at] !== 2) throw bad()
    const len = d[at + 1]
    let v = d.subarray(at + 2, at + 2 + len)
    if (!len || v.length !== len) throw bad()
    if (v[0] === 0 && v.length > 1) v = v.subarray(1)
    if (v.length > 32) throw bad()
    out.set(v, slot + 32 - v.length)
    at += 2 + len
  }
  if (at !== d.length) throw bad()
  return out
}

/**
 * A secp256r1 or ed25519 precompile instruction (SIMD-0075 and the ed25519 program share the layout):
 * [count u8, 0], then per entry seven u16 LE (signature offset, signature instruction index, public key
 * offset, public key instruction index, message offset, message size, message instruction index), then each
 * entry's public key and signature. Keys and signatures live in this instruction (index u16::MAX); the message
 * is `messageSize` bytes at `messageOffset` of instruction `instructionIndex`.
 */
export function precompileInstruction(programId, entries) {
  if (!entries.length || entries.length > MAX_PRECOMPILE_ENTRIES) throw new Error(`A precompile instruction takes 1 to ${MAX_PRECOMPILE_ENTRIES} signatures`)
  let at = 2 + 14 * entries.length
  const fields = []
  const tail = []
  for (const e of entries) {
    const pk = at
    const sig = pk + e.publicKey.length
    at = sig + e.signature.length
    fields.push(sig, 0xffff, pk, 0xffff, e.messageOffset, e.messageSize, e.instructionIndex)
    tail.push(e.publicKey, e.signature)
  }
  if (at > 0xffff) throw new Error('Precompile instruction too large')
  return { programId, keys: [], data: concat([Uint8Array.of(entries.length, 0), ...fields.map(u16le), ...tail]) }
}
export const secp256r1Instruction = entries => precompileInstruction(SECP256R1_PROGRAM, entries)
export const ed25519Instruction = entries => precompileInstruction(ED25519_PROGRAM, entries)

/**
 * The precompile entry that proves a P-256 / Ed25519 step: the signing DNSKEY (compressed for P-256), the
 * low-S signature, and the signed bytes inside the program instruction at `instructionIndex`.
 */
export function precompileEntry(step, dnskey, instructionIndex, messageOffset = PRECOMPILE_MESSAGE_OFFSET) {
  const base = { instructionIndex, messageOffset, messageSize: step.signed.length }
  if (step.kind === 'p256') {
    if (dnskey.length !== 68) throw new Error(`${step.label}: P-256 DNSKEY must be 68 bytes`)
    return { ...base, publicKey: p256Compress(dnskey.subarray(4)), signature: p256LowS(step.sig).signature }
  }
  if (step.kind === 'ed25519') {
    if (dnskey.length !== 36) throw new Error(`${step.label}: Ed25519 DNSKEY must be 36 bytes`)
    return { ...base, publicKey: dnskey.slice(4), signature: step.sig.slice() }
  }
  throw new Error(`${step.label}: algorithm ${step.algorithm} does not use a precompile`)
}

// The program accepts a key only with protocol 3, the RRSIG's algorithm and tag, Zone set and Revoke clear.
const keyUsable = (k, step) => k.length > 4 && (((k[0] << 8) | k[1]) & 0x0180) === 0x0100 && k[2] === 3 && k[3] === step.algorithm && keyTag(k) === step.keyTag

async function signatureVerifies(step, key) {
  try {
    const s = crypto.subtle
    if (step.kind === 'p256') {
      const k = await s.importKey('raw', concat([Uint8Array.of(4), key.subarray(4)]), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
      return await s.verify({ name: 'ECDSA', hash: 'SHA-256' }, k, step.sig, step.signed)
    }
    const k = await s.importKey('raw', key.subarray(4), { name: 'Ed25519' }, false, ['verify'])
    return await s.verify({ name: 'Ed25519' }, k, step.sig, step.signed)
  } catch { return false }
}

/** The DNSKEY RDATA that signed a P-256 / Ed25519 step, among `keys` (its own set when self-signed). */
export async function signingKey(step, keys) {
  const usable = keys.filter(k => keyUsable(k, step))
  // A key tag collision is possible; the precompile fails the whole transaction on a wrong key, so check.
  if (usable.length > 1) for (const k of usable) if (await signatureVerifies(step, k)) return k
  if (!usable.length) throw stepError('NoKeyVerified', `no DNSKEY ${step.keyTag}/${step.algorithm} for ${step.label}`)
  return usable[0]
}

// ---------- program instructions (pluggable) ----------

const meta = (pubkey, isSigner, isWritable) => ({ pubkey, isSigner, isWritable })

/** Instruction names DNSSEC.md uses; the program may name them differently (pass `names`). */
export const DNSSEC_INSTRUCTIONS = {
  inline: 'verify_rrset',
  precompiled: 'verify_rrset_precompiled',
  write: 'write_buffer',
  buffered: 'verify_rrset_buffered',
}

/** Anchor's instruction discriminator: sha256("global:<name>")[..8]. */
export const anchorDiscriminator = async name => (await sha256(utf8(`global:${name}`))).slice(0, 8)

/**
 * The encoder the planner calls to turn steps into program instructions. This one follows DNSSEC.md:
 *   verify_rrset(signed: Vec<u8>, sig: Vec<u8>)        payer (s, w), parent RRset, result RRset (w),
 *   verify_rrset_precompiled(signed: Vec<u8>)            system program, instructions sysvar
 *   write_buffer(offset: u32, bytes: Vec<u8>)           payer (s, w), buffer ["buffer", payer] (w), system program
 *   verify_rrset_buffered()                              verify_rrset accounts + buffer (w)
 * The root DNSKEY set has no parent account: Anchor reads the program id in its place as None.
 * Cached sets are read only from accounts with the `RrSet` account discriminator.
 * Another program layout plugs in by replacing any of these members (or `names`, `rrtypeEndian`, `accountName`).
 */
export async function anchorEncoder({ programId, names = DNSSEC_INSTRUCTIONS, rrtypeEndian = RRSET_TYPE_ENDIAN, accountName = 'RrSet' } = {}) {
  pubkeyBytes(programId)
  const d = {}
  for (const [k, n] of Object.entries({ ...DNSSEC_INSTRUCTIONS, ...names })) d[k] = await anchorDiscriminator(n)
  const accountDisc = (await sha256(utf8(`account:${accountName}`))).slice(0, 8)
  const accounts = ({ payer, parent, rrset }) => [
    meta(payer, true, true), meta(parent || programId, false, false), meta(rrset, false, true),
    meta(SYSTEM_PROGRAM, false, false), meta(INSTRUCTIONS_SYSVAR, false, false),
  ]
  const ix = (keys, data) => ({ programId, keys, data })
  return {
    programId,
    rrsetSeeds: ref => rrsetSeeds(ref, rrtypeEndian),
    bufferSeeds: payer => [utf8('buffer'), pubkeyBytes(payer)],
    /** What a buffered step uploads: [u32 len, signed, u32 len, sig]. */
    bufferPayload: step => concat([u32le(step.signed.length), step.signed, u32le(step.sig.length), step.sig]),
    verifyInline: a => ix(accounts(a), concat([d.inline, vecU8(a.step.signed), vecU8(a.step.sig)])),
    verifyPrecompiled: a => ({ instruction: ix(accounts(a), concat([d.precompiled, vecU8(a.step.signed)])), messageOffset: PRECOMPILE_MESSAGE_OFFSET }),
    writeBuffer: ({ payer, buffer, offset, bytes }) => ix([meta(payer, true, true), meta(buffer, false, true), meta(SYSTEM_PROGRAM, false, false)], concat([d.write, u32le(offset), vecU8(bytes)])),
    verifyBuffered: a => ix([...accounts(a), meta(a.buffer, false, true)], d.buffered),
    decodeRrset: data => (data.length >= 8 && equalBytes(data.subarray(0, 8), accountDisc) ? decodeRrsetAccount(data) : null),
    computeUnits: estimateComputeUnits,
  }
}

/**
 * Compute units a step may use, for packing. Measured in the bench: RSA-2048 ~1.20M (one per transaction),
 * RSA-1024 ~0.36M, P-256 / Ed25519 ~5k; the margins leave room for Anchor's own work.
 */
export function estimateComputeUnits(step) {
  if (step.kind !== 'rsa') return 20_000
  if (step.bits <= 1024) return 450_000
  if (step.bits <= 1536) return 900_000
  return MAX_COMPUTE_UNITS
}

const computeUnitLimit = units => ({ programId: COMPUTE_BUDGET_PROGRAM, keys: [], data: concat([Uint8Array.of(2), u32le(units)]) })
const computeUnitPrice = microLamports => ({ programId: COMPUTE_BUDGET_PROGRAM, keys: [], data: concat([Uint8Array.of(3), u64le(microLamports)]) })

// ---------- the on-chain cache ----------

/**
 * A cached RRset account in the DNSSEC.md layout, or null: discriminator 8 | bump u8 | rrtype u16 |
 * algorithm u8 | key_tag u16 | signed_at i64 | expires_at i64 | payer 32 | owner Vec<u8> |
 * rdata Vec<u8> of [u16 LE length, RDATA] records (all integers LE).
 */
export function decodeRrsetAccount(data) {
  try {
    const b = bytesOf(data)
    const v = view(b)
    let at = 8
    const out = { bump: b[at], rrtype: v.getUint16(at + 1, true), algorithm: b[at + 3], keyTag: v.getUint16(at + 4, true) }
    at += 6
    out.signedAt = Number(v.getBigInt64(at, true))
    out.expiresAt = Number(v.getBigInt64(at + 8, true))
    out.payer = base58Encode(b.subarray(at + 16, at + 48))
    at += 48
    const ol = v.getUint32(at, true)
    out.owner = b.slice(at + 4, at + 4 + ol)
    at += 4 + ol
    const end = at + 4 + v.getUint32(at, true)
    if (out.owner.length !== ol || end > b.length) return null
    out.records = []
    for (at += 4; at < end;) {
      const n = v.getUint16(at, true)
      if (at + 2 + n > end) return null
      out.records.push(b.slice(at + 2, at + 2 + n))
      at += 2 + n
    }
    return out
  } catch { return null }
}

/** The account size of a step's cached set in that layout: 70 + owner + Σ(2 + rdlen). */
export const rrsetAccountSize = step => 70 + step.owner.length + step.records.reduce((n, r) => n + 2 + r.length, 0)

/** Memoized PDA lookup for steps and parent references. */
function addressBook(encoder) {
  const memo = new Map()
  return ref => {
    const k = `${toHex(ref.nameHash)}/${ref.rrtype}`
    if (!memo.has(k)) memo.set(k, findProgramAddress(encoder.rrsetSeeds(ref), encoder.programId).then(([a]) => a))
    return memo.get(k)
  }
}

/** The PDA of a step's cached set (or of a parent reference { nameHash, rrtype }), for an encoder or { programId }. */
export async function rrsetAddress(ref, { programId, rrsetSeeds: seeds = rrsetSeeds }) {
  const [a] = await findProgramAddress(seeds(ref), programId)
  return a
}

/**
 * Reads the cached sets of every step and parent with getMultipleAccounts (100 per call). Returns a Map
 * address -> decoded account, or null when missing, owned by another program or not decodable.
 */
export async function fetchCache(steps, { encoder, rpc = solanaRpc, commitment = 'confirmed' } = {}) {
  const addressOf = addressBook(encoder)
  const refs = steps.flatMap(s => (s.parent ? [s, s.parent] : [s]))
  const addresses = [...new Set(await Promise.all(refs.map(addressOf)))]
  const out = new Map()
  for (let i = 0; i < addresses.length; i += 100) {
    const batch = addresses.slice(i, i + 100)
    const { value } = await rpc('getMultipleAccounts', [batch, { encoding: 'base64', commitment }])
    batch.forEach((a, j) => {
      const acc = value[j]
      out.set(a, acc && acc.owner === encoder.programId ? encoder.decodeRrset(base64Decode(acc.data[0])) : null)
    })
  }
  return out
}

/**
 * Which steps the cache already covers. A step is skipped when its entry holds the same records and stays
 * valid past now + margin; the leaf also needs a signing time no older than `minLeafSignedAt` (the escrow's
 * last proof for the domain). Anything else is re-verified: a changed set has a newer signature and replaces
 * the entry, and the program ignores a result older than what it holds.
 */
export function cacheStatus(steps, cache, addresses, { now, margin = 600, minLeafSignedAt } = {}) {
  return steps.map((s, i) => {
    const entry = cache.get(addresses[i]) || null
    const reason = !entry ? 'missing'
      : entry.rrtype !== s.rrtype || !equalBytes(entry.owner, s.owner) ? 'mismatch'
        : entry.records.length !== s.records.length || entry.records.some((r, j) => !equalBytes(r, s.records[j])) ? 'changed'
          : entry.expiresAt < now + margin ? 'expiring'
            : i === steps.length - 1 && minLeafSignedAt != null && entry.signedAt < minLeafSignedAt ? 'stale'
              : null
    return { address: addresses[i], entry, reusable: !reason, reason: reason || 'cached' }
  })
}

// ---------- the planner ----------

/** Serialized size of a legacy transaction with these instructions (the blockhash does not change it). */
export function transactionSize(instructions, payer) {
  const m = compileMessage({ payer, recentBlockhash: SYSTEM_PROGRAM, instructions })
  return shortvecLength(m.header[0]) + 64 * m.header[0] + serializeMessage(m).length
}

/** Largest x in [0, max] with fits(x), for sizes that grow with x. -1 if even 0 does not fit. */
function largest(fits, max) {
  if (!fits(0)) return -1
  let lo = 0
  let hi = max
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (fits(mid)) lo = mid; else hi = mid - 1
  }
  return lo
}

/**
 * The fewest legacy transactions that verify the steps the cache does not cover, in chain order:
 * - P-256 / Ed25519 steps: `verify_rrset_precompiled` with one precompile entry each, packed several per
 *   transaction (one secp256r1 and/or one ed25519 instruction per transaction);
 * - RSA steps inline when they fit (RSA-1024 can share a transaction; RSA-2048 is alone for compute);
 * - larger RSA steps through the buffer: `write_buffer` chunks, then compute limit + last chunk + verify.
 * RSA keys above MAX_RSA_BITS are refused up front (NeedsSplitRsa), as SHA-1 algorithms are in buildStep.
 * Options: payer, encoder (anchorEncoder or another), cache (fetchCache result), now, margin, minLeafSignedAt,
 * computeUnitPrice (micro-lamports, adds a price instruction), limit (bytes), append (instructions to run after
 * the leaf, e.g. the claim: added to the last transaction when it fits) and appendComputeUnits.
 * Returns { steps (status per step), transactions [{ instructions, size, computeUnits, steps, kind }],
 * signatures, fee } with fee in lamports before priority fees (5,000 per transaction and precompile signature).
 */
export async function planProof(steps, opts = {}) {
  const { payer, encoder } = opts
  if (!encoder) throw new Error('planProof needs an encoder, e.g. await anchorEncoder({ programId })')
  pubkeyBytes(payer)
  const now = opts.now ?? Math.floor(Date.now() / 1000)
  const limit = opts.limit ?? LEGACY_TX_LIMIT
  const price = BigInt(opts.computeUnitPrice ?? 0)
  const cuOf = opts.computeUnits || encoder.computeUnits || estimateComputeUnits
  const cache = opts.cache || new Map()
  const addressOf = addressBook(encoder)
  const addresses = await Promise.all(steps.map(addressOf))
  const parents = await Promise.all(steps.map(s => (s.parent ? addressOf(s.parent) : null)))
  const status = cacheStatus(steps, cache, addresses, { now, margin: opts.margin ?? 600, minLeafSignedAt: opts.minLeafSignedAt })
  const inProof = new Map(steps.map(s => [setKey(s.owner, s.rrtype), s]))
  const at = new Map(steps.map((s, i) => [s, i])) // positions in this list; `steps` may be part of a chain
  const needed = steps.filter((_, i) => !status[i].reusable)

  // An RSA key above 2048 bits needs the split verifier: refused here, before anything is built or paid for.
  const tooBig = needed.find(s => s.kind === 'rsa' && s.bits > MAX_RSA_BITS)
  if (tooBig) {
    throw stepError('NeedsSplitRsa', `${zoneOf(tooBig, true)} signs with a ${tooBig.bits}-bit RSA key. ${tooBig.bits}-bit RSA keys are not supported on Solana yet: proofs take RSA keys of up to ${MAX_RSA_BITS} bits for now.`)
  }
  // A cached leaf that is recent enough serves the claim; a leaf proven now must be too.
  const leaf = steps.at(-1)
  if (opts.minLeafSignedAt != null && !status.at(-1).reusable && validity(leaf, now).signedAt < opts.minLeafSignedAt) {
    throw stepError('StaleProof', `${leaf.label} was signed before the last proof this domain used; fetch a fresh one`)
  }
  const keys = new Map()
  for (const s of needed) {
    const t = validity(s, now)
    if (t.expired) throw stepError('SignatureExpired', `${s.label}: the signature has expired; fetch a fresh proof`)
    if (t.notYetValid) throw stepError('SignatureNotValidYet', `${s.label}: the signature is not valid yet`)
    const p = s.parent && (inProof.get(setKey(s.parent.owner, s.parent.rrtype)) || cache.get(parents[at.get(s)]))
    if (s.parent && !(p && (p.signed || p.expiresAt >= now))) throw stepError('WrongParent', `${s.label}: its parent ${wireToName(s.parent.owner)} ${typeName(s.parent.rrtype)} is neither in the proof nor cached`)
    if (s.kind !== 'rsa') keys.set(s, await signingKey(s, s.selfSigned ? s.records : p.records))
  }

  const ctx = s => ({ step: s, payer, parent: parents[at.get(s)], rrset: addresses[at.get(s)] })
  const budget = (units, always) => [
    ...(always || price ? [computeUnitLimit(Math.min(MAX_COMPUTE_UNITS, units))] : []),
    ...(price ? [computeUnitPrice(price)] : []),
  ]

  // One transaction verifying `group` inline: [compute budget], [secp256r1], [ed25519], then one verify each.
  const build = group => {
    const units = group.reduce((n, s) => n + cuOf(s), 0)
    const rsa = group.some(s => s.kind === 'rsa')
    const head = budget(rsa ? MAX_COMPUTE_UNITS : units + 10_000, rsa)
    const p256 = []
    const ed = []
    let index = head.length + (group.some(s => s.kind === 'p256') ? 1 : 0) + (group.some(s => s.kind === 'ed25519') ? 1 : 0)
    const verifies = group.map(s => {
      if (s.kind === 'rsa') { index++; return encoder.verifyInline(ctx(s)) }
      const { instruction, messageOffset } = encoder.verifyPrecompiled(ctx(s))
      // The precompile hashes the bytes at this offset; they must be the bytes the program parses.
      if (!equalBytes(instruction.data.subarray(messageOffset, messageOffset + s.signed.length), s.signed)) throw new Error(`Encoder put ${s.label} elsewhere than offset ${messageOffset}`)
      ;(s.kind === 'p256' ? p256 : ed).push(precompileEntry(s, keys.get(s), index++, messageOffset))
      return instruction
    })
    if (p256.length > MAX_PRECOMPILE_ENTRIES || ed.length > MAX_PRECOMPILE_ENTRIES) return null
    const instructions = [...head, ...(p256.length ? [secp256r1Instruction(p256)] : []), ...(ed.length ? [ed25519Instruction(ed)] : []), ...verifies]
    return { instructions, size: transactionSize(instructions, payer), computeUnits: units, steps: group.map(s => at.get(s)), kind: 'verify', precompileSignatures: p256.length + ed.length }
  }
  const fits = tx => tx && tx.size <= limit && tx.computeUnits <= MAX_COMPUTE_UNITS

  // A step too big to send inline: upload [u32 len, signed, u32 len, sig] to the buffer, verify from there.
  const buffered = async s => {
    const payload = encoder.bufferPayload(s)
    const buffer = (await findProgramAddress(encoder.bufferSeeds(payer), encoder.programId))[0]
    const write = (offset, n) => encoder.writeBuffer({ step: s, payer, buffer, offset, bytes: payload.subarray(offset, offset + n), total: payload.length })
    const verify = encoder.verifyBuffered({ ...ctx(s), buffer })
    const head = budget(MAX_COMPUTE_UNITS, true)
    const uploadHead = budget(100_000, false)
    const init = encoder.bufferInit ? [encoder.bufferInit({ step: s, payer, buffer, size: payload.length })] : []
    const finalTx = (n, first) => [...head, ...(first ? init : []), ...(n ? [write(payload.length - n, n)] : []), verify]
    const alone = largest(n => transactionSize(finalTx(n, true), payer) <= limit, payload.length)
    const last = alone === payload.length ? alone : largest(n => transactionSize(finalTx(n, false), payer) <= limit, payload.length)
    if (last < 0) throw new Error(`${s.label}: the buffered verify does not fit a transaction`)
    const txs = []
    let offset = 0
    // Chunks from the start; the last one rides in the verify transaction.
    while (offset < payload.length - last) {
      const first = !offset
      const chunk = n => [...uploadHead, ...(first ? init : []), write(offset, n)]
      const n = largest(k => transactionSize(chunk(k), payer) <= limit, payload.length - last - offset)
      if (n <= 0) throw new Error(`${s.label}: a buffer chunk does not fit a transaction`)
      const instructions = chunk(n)
      txs.push({ instructions, size: transactionSize(instructions, payer), computeUnits: 100_000, steps: [at.get(s)], kind: 'upload', bytes: [offset, offset + n], precompileSignatures: 0 })
      offset += n
    }
    const instructions = finalTx(payload.length - offset, !txs.length)
    txs.push({ instructions, size: transactionSize(instructions, payer), computeUnits: cuOf(s), steps: [at.get(s)], kind: 'verify', bytes: [offset, payload.length], precompileSignatures: 0 })
    return txs
  }

  const transactions = []
  const mode = new Map()
  let group = []
  const flush = () => { if (group.length) transactions.push(build(group)); group = [] }
  for (const s of needed) {
    const alone = build([s])
    if (!fits(alone)) {
      if (s.kind !== 'rsa') throw stepError('NeedsV1', `${s.label}: ${s.signed.length} signed bytes do not fit a legacy transaction (${alone.size} B); a v1 transaction would`)
      flush()
      transactions.push(...await buffered(s))
      mode.set(s, 'buffered')
      continue
    }
    mode.set(s, s.kind === 'rsa' ? 'inline' : 'precompiled')
    if (group.length && fits(build([...group, s]))) group.push(s)
    else { flush(); group = [s] }
  }
  flush()

  if (opts.append && opts.append.length) {
    const extra = opts.appendComputeUnits ?? 100_000
    const lastTx = transactions.at(-1)
    const isLimit = ix => ix.programId === COMPUTE_BUDGET_PROGRAM && ix.data[0] === 2
    // A compute limit already there has to grow by what the appended instructions use.
    const joined = lastTx && lastTx.kind === 'verify' && lastTx.computeUnits + extra <= MAX_COMPUTE_UNITS
      ? [...lastTx.instructions, ...opts.append].map(ix => (isLimit(ix) ? computeUnitLimit(Math.min(MAX_COMPUTE_UNITS, view(ix.data).getUint32(1, true) + extra)) : ix))
      : null
    if (joined && transactionSize(joined, payer) <= limit) {
      Object.assign(lastTx, { instructions: joined, size: transactionSize(joined, payer), computeUnits: lastTx.computeUnits + extra, appended: true })
    } else {
      const instructions = [...budget(extra, false), ...opts.append]
      transactions.push({ instructions, size: transactionSize(instructions, payer), computeUnits: extra, steps: [], kind: 'append', precompileSignatures: 0 })
    }
  }

  const signatures = transactions.reduce((n, t) => n + 1 + t.precompileSignatures, 0)
  return {
    steps: steps.map((s, i) => ({
      index: i, label: s.label, address: addresses[i], parent: parents[i],
      status: status[i].reusable ? 'cached' : mode.get(s), reason: status[i].reason,
      ...validity(s, now), accountSize: rrsetAccountSize(s),
    })),
    transactions,
    signatures,
    fee: 5000 * signatures,
  }
}

/** Unsigned wire transactions for a plan, ready for a wallet's signAllTransactions. Send them in order. */
export function compileTransactions(plan, { payer, recentBlockhash }) {
  return plan.transactions.map(t => unsignedTransaction(serializeMessage(compileMessage({ payer, recentBlockhash, instructions: t.instructions }))))
}

/**
 * Everything a claim or register needs before its own instruction: the domain's proof (checked to publish
 * `wallet` when given), what the cache already holds, and the transactions for the rest.
 */
export async function prepareWalletProof(domain, { wallet, payer, encoder, rpc, doh, sendQuery, ...planOpts } = {}) {
  const proof = await fetchWalletProof(domain, { wallet, doh, sendQuery })
  const cache = await fetchCache(proof.steps, { encoder, rpc })
  return { ...proof, plan: await planProof(proof.steps, { payer, encoder, cache, ...planOpts }) }
}
