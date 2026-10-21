// The DNS the browser sees in the UI end-to-end run (ui-e2e.mjs), served by a DNS-over-HTTPS stub inside the page
// in both shapes the app asks for: JSON (lib/wallet262.js: what a domain publishes) and wire format with RRSIGs
// (dnsprovejs: the proof a claim builds).
//
// The signed chain is synthetic: . -> test. -> <domain>, then `_wallet.<domain>` TXT. The root DNSKEY set is the real
// one (solana/bench/fixtures/cloudflare.com.json), so dnsprovejs's root trust anchors accept it; test. and the domain
// have throwaway Ed25519 keys. Nobody can sign test.'s DS with the root key, so every set above the leaf is loaded
// into the validator at genesis as a cached RrSet account, the way e2e-local.mjs loads its zone's DNSKEY set. The
// leaf is then the only set the program verifies, with its real Ed25519 signature through the precompile.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as P from '../../assets/solana-proof.js'
import * as T from '../../assets/solana-type262.js'
import { findProgramAddress, pubkeyBytes } from '../../assets/solana.js'

const ROOT_FIXTURE = fileURLToPath(new URL('../bench/fixtures/cloudflare.com.json', import.meta.url))

const cat = (...parts) => Uint8Array.from(Buffer.concat(parts.map(p => Buffer.from(p))))
const u16be = n => [(n >> 8) & 255, n & 255]
const u16le = n => [n & 255, (n >> 8) & 255]
const u32be = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b }
const u32le = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b }
const i64le = v => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); return b }
const sha256 = b => Uint8Array.from(createHash('sha256').update(b).digest())
export const txt = s => cat([s.length], Buffer.from(s, 'latin1'))
const b64 = b => Buffer.from(b).toString('base64')
const labelsOf = name => (name === '.' ? 0 : name.split('.').length)

/** DNSKEY RDATA of an Ed25519 zone key: flags 257, protocol 3, algorithm 15. */
export const dnskeyOf = kp => cat(u16be(257), [3, 15], kp.raw)
/** DS RDATA (SHA-256 digest) for a zone's DNSKEY. */
const dsOf = (owner, dnskey) => cat(u16be(P.keyTag(dnskey)), [15, 2], sha256(cat(P.nameToWire(owner), dnskey)))

/** One signed set: the RRSIG fields, the bytes the signature covers, and the signature (by `key`, or `sig` as given). */
async function signedSet({ owner, rrtype, records, signer, algorithm = 15, keyTag, inception, expiration, ttl = 300, key, sig }) {
  const rrsig = { typeCovered: rrtype, algorithm, labels: labelsOf(owner), originalTtl: ttl, expiration, inception, keyTag, signer: P.nameToWire(signer) }
  const signed = P.encodeSigned(rrsig, P.nameToWire(owner), rrtype, records)
  return { owner, rrtype, records: P.parseSigned(signed).records, rrsig, signed, sig: sig || (await key.sign(signed)) }
}

/** The answer section a DNS server gives for a signed set: its records, then the RRSIG. */
function answerOf(set) {
  const owner = P.nameToWire(set.owner)
  const r = set.rrsig
  const rr = (type, rdata) => cat(owner, u16be(type), u16be(1), u32be(r.originalTtl), u16be(rdata.length), rdata)
  const rrsig = cat(u16be(r.typeCovered), [r.algorithm, r.labels], u32be(r.originalTtl), u32be(r.expiration), u32be(r.inception), u16be(r.keyTag), r.signer, set.sig)
  const rrs = [...set.records.map(d => rr(set.rrtype, d)), rr(46, rrsig)]
  return { count: rrs.length, b64: b64(cat(...rrs)) }
}

/** The RrSet account the program would hold after verifying `set` (state.rs layout), valid until `expiresAt`. */
async function cachedAccount(set, { now, expiresAt, payer }) {
  const owner = P.nameToWire(set.owner)
  const [pubkey, bump] = await findProgramAddress([Buffer.from('rrset'), sha256(owner), u16be(set.rrtype)], T.PROGRAM_ID)
  const records = cat(...set.records.map(d => cat(u16le(d.length), d)))
  const signedAt = P.validity(set.rrsig, now).signedAt
  const data = cat(T.ACCOUNT.RrSet, [bump], u16le(set.rrtype), [set.rrsig.algorithm], u16le(set.rrsig.keyTag), i64le(signedAt), i64le(expiresAt), pubkeyBytes(payer), u32le(owner.length), owner, u32le(records.length), records)
  return { pubkey, owner: T.PROGRAM_ID, data, label: `${set.owner} ${P.TYPE_DS === set.rrtype ? 'DS' : 'DNSKEY'}` }
}

/**
 * The chain above `_wallet.<domain>`: root DNSKEY (real), test. DS and DNSKEY, <domain> DS and DNSKEY. Returns the
 * sets and the genesis accounts that cache them, each valid until the earliest expiration on its path.
 */
export async function parentChain({ domain, tld, zone, now, payer }) {
  const f = JSON.parse(readFileSync(ROOT_FIXTURE, 'utf8'))
  const rootSet = f.sets.find(s => s.owner === '.' && s.type === 'DNSKEY')
  const rootStep = await P.buildStep(rootSet.rrset, rootSet.sig)
  const root = { owner: '.', rrtype: P.TYPE_DNSKEY, records: rootStep.records, rrsig: { ...rootStep, signer: rootStep.signer }, signed: rootStep.signed, sig: rootStep.sig }
  const zsk = rootStep.records.find(r => r[0] === 1 && r[1] === 0) // flags 256: the root's zone-signing key
  const t = { inception: now - 3600, expiration: now + 30 * 86_400 }
  const tldKey = dnskeyOf(tld)
  const zoneKey = dnskeyOf(zone)
  const sets = [
    root,
    // Signed by "the root" with a placeholder signature: dnsprovejs checks DS digests and key tags, not signatures
    // (solana-proof.js ALGORITHMS), and the program never sees this set, which is cached at genesis.
    await signedSet({ owner: 'test', rrtype: P.TYPE_DS, records: [dsOf('test', tldKey)], signer: '.', algorithm: 8, keyTag: P.keyTag(zsk), ...t, ttl: 86_400, sig: new Uint8Array(256).fill(0x5a) }),
    await signedSet({ owner: 'test', rrtype: P.TYPE_DNSKEY, records: [tldKey], signer: 'test', keyTag: P.keyTag(tldKey), ...t, ttl: 3600, key: tld }),
    await signedSet({ owner: domain, rrtype: P.TYPE_DS, records: [dsOf(domain, zoneKey)], signer: 'test', keyTag: P.keyTag(tldKey), ...t, ttl: 3600, key: tld }),
    await signedSet({ owner: domain, rrtype: P.TYPE_DNSKEY, records: [zoneKey], signer: domain, keyTag: P.keyTag(zoneKey), ...t, ttl: 3600, key: zone }),
  ]
  const accounts = []
  let expiresAt = Infinity
  for (const s of sets) {
    expiresAt = Math.min(expiresAt, P.validity(s.rrsig, now).expiresAt)
    accounts.push(await cachedAccount(s, { now, expiresAt, payer }))
  }
  return { sets, accounts }
}

/** The `_wallet.<domain>` TXT set publishing `text`, signed by the zone key from `inception` for a week. */
export const walletSet = ({ domain, zone, text, inception }) => signedSet({
  owner: `_wallet.${domain}`, rrtype: P.TYPE_TXT, records: [txt(text)], signer: domain, keyTag: P.keyTag(dnskeyOf(zone)),
  inception, expiration: inception + 7 * 86_400, key: zone,
})

/**
 * What the page's DoH stub answers: `wire` for dnsprovejs ("name|type" -> answer section) and `json` for
 * wallet262 ("name|type" -> Answer list). Each `published` entry is { name, text } for a `_wallet.<name>` TXT that
 * resolvers report as DNSSEC-validated (AD).
 */
export function dohTable(sets, published) {
  const wire = {}
  for (const s of sets) wire[`${s.owner}|${s.rrtype}`] = answerOf(s)
  const json = {}
  for (const { name, text } of published) json[`_wallet.${name}|16`] = [{ name: `_wallet.${name}.`, type: 16, TTL: 300, data: `"${text}"` }]
  return { wire, json, signed: published.map(p => p.name) }
}

/**
 * The DoH stub itself: a Response for a DNS-over-HTTPS URL (Cloudflare JSON or wire, Google JSON). The page runs this
 * function's source, so it uses nothing from this module. Unknown names answer NXDOMAIN.
 */
export function dohStub(url, table) {
  const u = new URL(url)
  const dns = u.searchParams.get('dns')
  if (dns) {
    const q = Uint8Array.from(atob(dns.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (dns.length % 4)) % 4)), c => c.charCodeAt(0))
    const labels = []
    let at = 12
    while (q[at]) { labels.push(String.fromCharCode(...q.subarray(at + 1, at + 1 + q[at])).toLowerCase()); at += 1 + q[at] }
    const qtype = (q[at + 1] << 8) | q[at + 2]
    const hit = table.wire[`${labels.length ? labels.join('.') : '.'}|${qtype}`]
    const answers = hit ? Uint8Array.from(atob(hit.b64), c => c.charCodeAt(0)) : new Uint8Array(0)
    const question = q.subarray(12, at + 5)
    const out = new Uint8Array(12 + question.length + answers.length)
    out.set([q[0], q[1], 0x81, hit ? 0xa0 : 0xa3, 0, 1, 0, hit ? hit.count : 0, 0, 0, 0, 0])
    out.set(question, 12)
    out.set(answers, 12 + question.length)
    return new Response(out, { headers: { 'content-type': 'application/dns-message' } })
  }
  const name = String(u.searchParams.get('name') || '').toLowerCase().replace(/\.$/, '')
  const type = u.searchParams.get('type')
  const answer = table.json[`${name}|${type}`]
  const signed = table.signed.some(d => name === d || name.endsWith(`.${d}`))
  const body = { Status: answer || signed ? 0 : 3, TC: false, RD: true, RA: true, AD: signed, CD: false, Question: [{ name: `${name}.`, type: Number(type) || 0 }], ...(answer ? { Answer: answer } : {}) }
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/dns-json' } })
}
