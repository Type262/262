// Tests for the browser side of Solana DNSSEC proofs (assets/solana-proof.js). Run: node test/solana-proof.test.mjs
// Offline: the six real chains in solana/bench/fixtures (the proofs the Rust reference verified in LiteSVM):
// signed bytes byte-identical after dnsprovejs round trips, every signature checked from the IANA anchors with
// a port of verify_step and real crypto, precompile layouts and low-S, transaction sizes against DNSSEC.md,
// the planner's packing and cache rules. Online (OFFLINE=1 skips): live proofs over DNS-over-HTTPS.
// DUMP_DIR=<dir> also writes the live chains as bench-style fixtures, for a cross-check with the Rust parser.
import assert from 'node:assert/strict'
import { createHash, createPublicKey, verify as nodeVerify } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as P from '../assets/solana-proof.js'
import * as sol from '../assets/solana.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const { SignedSet, DEFAULT_TRUST_ANCHORS } = await import('../assets/vendor/dnsprovejs-1.0.1.mjs')
const say = s => process.stdout.write(s + '\n')
const hex = b => Buffer.from(b).toString('hex')
const unhex = s => Uint8Array.from(Buffer.from(s, 'hex'))
const cat = (...parts) => Uint8Array.from(Buffer.concat(parts.map(p => Buffer.from(p))))
const u16le = n => [n & 255, n >> 8]
const sha = (alg, ...parts) => { const h = createHash(alg); for (const p of parts) h.update(p); return Uint8Array.from(h.digest()) }
const txt = s => cat([s.length], Buffer.from(s, 'latin1'))

const PROGRAM = '3fhiMDY5kyCpX47HU1whuEe6vMQFHPa1hwGhc4Pp72NT' // the local test id in programs/type262/src/lib.rs
const PAYER = 'Cc5M6mecyBKjdrjnvreuANqhMBdLeU7RZNzoSEh2Rnfc'
const CHAINS = ['cloudflare.com', '_wallet.gemprotocol.io', 'nlnetlabs.nl', 'ietf.org', 'nasa.gov', 'ed25519.nl']
const fixture = name => JSON.parse(readFileSync(`${root}solana/bench/fixtures/${name}.json`, 'utf8'))
const fixtures = Object.fromEntries(CHAINS.map(c => [c, fixture(c)]))
const encoder = await P.anchorEncoder({ programId: PROGRAM })
const stepsOf = async name => P.stepsFromSets(fixtures[name].sets)

// "Legacy B" column of the tables in solana/docs/DNSSEC.md: the production transaction with the step inline,
// measured by the Rust bench (solana-transaction + wincode).
const DOC_LEGACY = {
  'cloudflare.com': [1459, 685, 652, 547, 685, 3399],
  '_wallet.gemprotocol.io': [1459, 684, 1643, 571, 1101, 602],
  'nlnetlabs.nl': [1459, 684, 649, 544, 1095, 770],
  'ietf.org': [1459, 685, 1649, 566, 667, 970],
  'nasa.gov': [1459, 685, 652, 541, 1239, 2328],
  'ed25519.nl': [1459, 684, 649, 542, 608, 517],
}
const DOC_MODE = {
  'cloudflare.com': ['buffer', 'inline', 'inline', 'inline', 'inline', 'v1 only'],
  '_wallet.gemprotocol.io': ['buffer', 'inline', 'buffer', 'inline', 'inline', 'inline'],
  'nlnetlabs.nl': ['buffer', 'inline', 'inline', 'inline', 'inline', 'inline'],
  'ietf.org': ['buffer', 'inline', 'buffer', 'inline', 'inline', 'inline'],
  'nasa.gov': ['buffer', 'inline', 'inline', 'inline', 'buffer', 'buffer'],
  'ed25519.nl': ['buffer', 'inline', 'inline', 'inline', 'inline', 'inline'],
}

// ---------- a port of verify_step (solana/bench/src/dnssec.rs) with real crypto ----------
const ROOT_DS = DEFAULT_TRUST_ANCHORS.map(a => cat([a.data.keyTag >> 8, a.data.keyTag & 255, a.data.algorithm, a.data.digestType], a.data.digest))
const big = b => BigInt('0x' + (hex(b) || '0'))
const modpow = (b, e, m) => { let r = 1n; for (b %= m; e > 0n; e >>= 1n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m } return r }
const toBytes = (n, len) => unhex(n.toString(16).padStart(len * 2, '0'))

function rsaVerify(key, signed, sig) {
  const k = key.subarray(4)
  let el = k[0]
  let off = 1
  if (el === 0) { el = (k[1] << 8) | k[2]; off = 3 }
  const e = big(k.subarray(off, off + el))
  const nb = k.subarray(off + el)
  const n = big(nb)
  if (sig.length !== nb.length || big(sig) >= n) return false
  // The whole encoded message, every padding byte included, as RSAPKCS1Verify and the program compare it.
  const t = cat(unhex('3031300d060960864801650304020105000420'), sha('sha256', signed))
  const want = cat([0, 1], new Uint8Array(nb.length - 3 - t.length).fill(255), [0], t)
  return hex(toBytes(modpow(big(sig), e, n), nb.length)) === hex(want)
}

async function webVerify(alg, key, signed, sig) {
  const s = globalThis.crypto.subtle
  if (alg === 13) {
    if (key.length !== 68) return false
    const k = await s.importKey('raw', cat([4], key.subarray(4)), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    return s.verify({ name: 'ECDSA', hash: 'SHA-256' }, k, sig, signed)
  }
  if (key.length !== 36) return false
  const k = await s.importKey('raw', key.subarray(4), { name: 'Ed25519' }, false, ['verify'])
  return s.verify({ name: 'Ed25519' }, k, sig, signed)
}

const checkSig = (alg, key, signed, sig) => (alg === 8 ? rsaVerify(key, signed, sig) : webVerify(alg, key, signed, sig))
const usable = (k, p) => k.length > 4 && (((k[0] << 8) | k[1]) & 0x0180) === 0x0100 && k[2] === 3 && k[3] === p.algorithm && P.keyTag(k) === p.keyTag
const dsMatches = (dsSet, owner, key) => dsSet.some(ds => {
  if (ds.length < 4 || (ds[0] << 8 | ds[1]) !== P.keyTag(key) || ds[2] !== key[3]) return false
  return ds[3] === 1 ? ds.length === 24 && hex(sha('sha1', owner, key)) === hex(ds.subarray(4))
    : ds[3] === 2 && ds.length === 36 && hex(sha('sha256', owner, key)) === hex(ds.subarray(4))
})

/** Verifies a chain from the root anchors at `now`; returns the verified sets, like the program's cache. */
async function verifyChain(steps, now) {
  const verified = new Map([['00/43', { owner: Uint8Array.of(0), rrtype: 43, records: ROOT_DS, expiresAt: Infinity }]])
  for (const st of steps) {
    const p = P.parseSigned(st.signed, now)
    assert.ok([8, 13, 15].includes(p.algorithm), `${st.label}: algorithm`)
    const self = p.rrtype === 48 && hex(p.owner) === hex(p.signer)
    const parent = verified.get(self ? `${hex(p.owner)}/43` : `${hex(p.signer)}/48`)
    assert.ok(parent, `${st.label}: parent not verified`)
    assert.ok(now <= parent.expiresAt, `${st.label}: parent expired`)
    let ok = false
    for (const key of self ? p.records : parent.records) {
      if (!usable(key, p) || !(await checkSig(p.algorithm, key, st.signed, st.sig))) continue
      if (!self || dsMatches(parent.records, p.owner, key)) { ok = true; break }
    }
    assert.ok(ok, `${st.label}: no key verified${self ? ' and matched a DS' : ''}`)
    const t = P.validity(p, now)
    verified.set(`${hex(p.owner)}/${p.rrtype}`, { owner: p.owner, rrtype: p.rrtype, records: p.records, expiresAt: Math.min(t.expiresAt, parent.expiresAt), signedAt: t.signedAt })
  }
  return verified
}

// ---------- the runtime's side of a precompile step ----------
const P256 = { p: 2n ** 256n - 2n ** 224n + 2n ** 192n + 2n ** 96n - 1n, b: 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn }
function p256Decompress(c) {
  const x = big(c.subarray(1))
  const y2 = (((x * x * x - 3n * x + P256.b) % P256.p) + P256.p) % P256.p
  let y = modpow(y2, (P256.p + 1n) / 4n, P256.p)
  assert.equal((y * y) % P256.p, y2, 'compressed key is not on the curve')
  if (Number(y & 1n) !== (c[0] & 1)) y = P256.p - y
  return cat([4], c.subarray(1), toBytes(y, 32))
}

/** The instructions sysvar as the runtime lays it out for instruction `current` of a compiled message. */
function instructionsSysvar(m, current) {
  const signer = i => i < m.header[0]
  const writable = i => (signer(i) ? i < m.header[0] - m.header[1] : i < m.accountKeys.length - m.header[2])
  const bodies = m.instructions.map(ix => cat(u16le(ix.accounts.length), ...ix.accounts.map(a => cat([(signer(a) ? 1 : 0) | (writable(a) ? 2 : 0)], sol.pubkeyBytes(m.accountKeys[a]))),
    sol.pubkeyBytes(m.accountKeys[ix.programIdIndex]), u16le(ix.data.length), ix.data))
  let at = 2 + 2 * bodies.length
  const offsets = bodies.map(b => { const o = at; at += b.length; return o })
  return cat(u16le(bodies.length), ...offsets.map(u16le), ...bodies, u16le(current))
}

// Port of introspect::precompile_checked / precompile_find over that sysvar.
const rd16 = (d, at) => d[at] | (d[at + 1] << 8)
function instructionAt(sysvar, index) {
  if (index >= rd16(sysvar, 0)) return null
  let at = rd16(sysvar, 2 + 2 * index)
  at += 2 + 33 * rd16(sysvar, at)
  return { program: sysvar.subarray(at, at + 32), data: sysvar.subarray(at + 34, at + 34 + rd16(sysvar, at + 32)) }
}
// The program's version (programs/type262/src/dnssec/introspect.rs) also compares the bytes at the offset.
function precompileFind(sysvar, program, pubkey, msgOffset, msg) {
  const current = rd16(sysvar, sysvar.length - 2)
  if (hex(instructionAt(sysvar, current).data.subarray(msgOffset, msgOffset + msg.length)) !== hex(msg)) return false
  for (let ix = 0; ix < rd16(sysvar, 0); ix++) {
    const { program: pid, data } = instructionAt(sysvar, ix)
    if (hex(pid) !== hex(program)) continue
    for (let e = 0; e < data[0]; e++) {
      const o = 2 + 14 * e
      if (rd16(data, o + 12) !== current || rd16(data, o + 8) !== msgOffset || rd16(data, o + 10) !== msg.length) continue
      const pkIx = rd16(data, o + 6)
      const pkData = pkIx === 0xffff ? data : instructionAt(sysvar, pkIx).data
      if (hex(pkData.subarray(rd16(data, o + 4), rd16(data, o + 4) + pubkey.length)) === hex(pubkey)) return true
    }
  }
  return false
}

/** What the secp256r1 / ed25519 programs check for every entry of a precompile instruction. */
async function runPrecompile(m, index, skip = new Set()) {
  const data = m.instructions[index].data
  const program = m.accountKeys[m.instructions[index].programIdIndex]
  const dataOf = i => (i === 0xffff ? data : m.instructions[i].data)
  for (let e = 0; e < data[0]; e++) {
    const f = [0, 1, 2, 3, 4, 5, 6].map(k => rd16(data, 2 + 14 * e + 2 * k))
    const pkLen = program === P.SECP256R1_PROGRAM ? 33 : 32
    const sig = dataOf(f[1]).subarray(f[0], f[0] + 64)
    const pk = dataOf(f[3]).subarray(f[2], f[2] + pkLen)
    const msg = dataOf(f[6]).subarray(f[4], f[4] + f[5])
    assert.equal(msg.length, f[5])
    if (skip.has(hex(msg))) continue
    if (program === P.SECP256R1_PROGRAM) {
      const r = big(sig.subarray(0, 32))
      const s = big(sig.subarray(32))
      assert.ok(r > 0n && r < P.P256_ORDER && s > 0n && s <= P.P256_ORDER >> 1n, 'secp256r1: r or s out of range (high S?)')
      const k = await globalThis.crypto.subtle.importKey('raw', p256Decompress(pk), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
      assert.ok(await globalThis.crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, k, sig, msg), 'secp256r1 entry does not verify')
    } else {
      const k = await globalThis.crypto.subtle.importKey('raw', pk, { name: 'Ed25519' }, false, ['verify'])
      assert.ok(await globalThis.crypto.subtle.verify({ name: 'Ed25519' }, k, sig, msg), 'ed25519 entry does not verify')
    }
  }
}

/**
 * Checks every transaction of a plan the way the cluster would see it: size, precompile entries valid, and every
 * precompiled step finding its entry over exactly its signed bytes at offset 12.
 */
async function checkPlan(plan, steps, { fakeSigned = [] } = {}) {
  const skip = new Set(fakeSigned.map(hex))
  let entries = 0
  for (const tx of plan.transactions) {
    assert.ok(tx.size <= P.LEGACY_TX_LIMIT, `transaction of ${tx.size} B`)
    assert.ok(tx.computeUnits <= P.MAX_COMPUTE_UNITS)
    const m = sol.compileMessage({ payer: PAYER, recentBlockhash: sol.SYSTEM_PROGRAM, instructions: tx.instructions })
    assert.equal(1 + 64 + sol.serializeMessage(m).length, tx.size)
    const pre = m.instructions.map((ix, i) => [m.accountKeys[ix.programIdIndex], i]).filter(([p]) => p === P.SECP256R1_PROGRAM || p === P.ED25519_PROGRAM)
    for (const [, i] of pre) { await runPrecompile(m, i, skip); entries += m.instructions[i].data[0] }
    if (tx.kind !== 'verify') continue
    // The verify instructions, told apart from write_buffer and an appended claim by their discriminators.
    const ours = m.instructions.map((ix, i) => [ix, i]).filter(([ix]) => m.accountKeys[ix.programIdIndex] === PROGRAM && VERIFY_DISC.includes(hex(ix.data.subarray(0, 8))))
    assert.equal(ours.length, tx.steps.length)
    for (const [k, index] of tx.steps.entries()) {
      const st = steps[index]
      const [ix, at] = ours[k]
      if (st.kind === 'rsa') continue
      assert.equal(hex(ix.data.subarray(12, 12 + st.signed.length)), hex(st.signed), 'signed bytes at offset 12')
      const keys = st.selfSigned ? st.records : steps.find(s => s.rrtype === 48 && hex(s.owner) === hex(st.signer)).records
      const key = await P.signingKey(st, keys)
      const pk = st.kind === 'p256' ? P.p256Compress(key.subarray(4)) : key.subarray(4, 36)
      const program = sol.pubkeyBytes(st.kind === 'p256' ? P.SECP256R1_PROGRAM : P.ED25519_PROGRAM)
      const sysvar = instructionsSysvar(m, at)
      assert.ok(precompileFind(sysvar, program, pk, 12, st.signed), `${st.label}: the program would not find its precompile entry`)
      finds.push({ label: st.label, sysvar: hex(sysvar), program: hex(program), pubkey: hex(pk), len: st.signed.length })
      assert.ok(!precompileFind(sysvar, program, pk, 13, st.signed.subarray(1)), 'found an entry over other bytes')
      assert.ok(!precompileFind(sysvar, program, pk, 12, Uint8Array.from(st.signed, (b, i) => (i === 20 ? b ^ 1 : b))), 'found an entry for other bytes')
    }
  }
  return entries
}

// Sysvar cases checked above, written to DUMP_DIR for introspect::precompile_find itself.
const finds = []

// ---------- helpers for cache states ----------
const DISC = sha('sha256', 'account:RrSet').subarray(0, 8) // state::RrSet
const i64 = n => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b }
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
/** An RRset account in the DNSSEC.md layout, as the program writes it. */
const rrsetAccount = e => cat(DISC, [255], u16le(e.rrtype), [e.algorithm ?? 13], u16le(e.keyTag ?? 0), i64(e.signedAt), i64(e.expiresAt),
  sol.pubkeyBytes(e.payer ?? PAYER), u32(e.owner.length), e.owner, u32(e.records.reduce((n, r) => n + 2 + r.length, 0)), ...e.records.map(r => cat(u16le(r.length), r)))

/** A cache Map in which the given steps are verified and valid for a day. */
async function cacheWith(steps, now, edit = () => {}) {
  const cache = new Map()
  for (const s of steps) {
    const entry = { rrtype: s.rrtype, owner: s.owner, records: s.records, signedAt: P.validity(s, now).signedAt, expiresAt: now + 86400 }
    edit(s, entry)
    cache.set(await P.rrsetAddress(s, encoder), P.decodeRrsetAccount(rrsetAccount(entry)))
  }
  return cache
}

/**
 * A realistic claim leaf: `_wallet.cloudflare.com TXT "SOL <base58>"` signed by the zone's key (117 signed
 * bytes, the leaf DNSSEC.md sizes its packing with). The signature is a stand-in, so precompile checks skip it.
 */
async function walletLeaf(zoneKeys, now) {
  const tag = P.keyTag(zoneKeys.records.find(k => k[3] === 13 && !(k[1] & 1)))
  const h = Buffer.alloc(18)
  h.writeUInt16BE(16, 0); h[2] = 13; h[3] = 3; h.writeUInt32BE(300, 4); h.writeUInt32BE(now + 86400, 8); h.writeUInt32BE(now - 3600, 12); h.writeUInt16BE(tag, 16)
  const owner = P.nameToWire('_wallet.cloudflare.com')
  const rr = Buffer.alloc(10)
  rr.writeUInt16BE(16, 0); rr.writeUInt16BE(1, 2); rr.writeUInt32BE(300, 4); rr.writeUInt16BE(49, 8)
  const signed = cat(h, zoneKeys.owner, owner, rr, txt('SOL 9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'))
  return P.buildStep(signed, cat(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)))
}

const VERIFY_DISC = ['verify_rrset', 'verify_rrset_precompiled', 'verify_rrset_buffered'].map(n => hex(sha('sha256', `global:${n}`).subarray(0, 8)))
const plan = (steps, opts) => P.planProof(steps, { payer: PAYER, encoder, ...opts })
const shape = p => p.transactions.map(t => `${t.kind}:${t.steps.join('+')}`).join(' ')

// ---------- tests ----------
const stats = {}
const tests = {
  'names: wire form, canonical domains, punycode': () => {
    assert.equal(hex(P.nameToWire('Example.COM.')), hex(cat([7], Buffer.from('example'), [3], Buffer.from('com'), [0])))
    assert.equal(hex(P.nameToWire('.')), '00')
    assert.equal(P.wireToName(P.nameToWire('_wallet.example.com')), '_wallet.example.com.')
    assert.equal(P.wireToName(Uint8Array.of(0)), '.')
    assert.throws(() => P.nameToWire('a'.repeat(64) + '.com'), /Bad DNS name/)
    assert.throws(() => P.nameToWire('a..com'), /Bad DNS name/)
    assert.equal(P.canonicalDomain(' Example.COM. '), 'example.com')
    assert.equal(P.canonicalDomain('bücher.de'), 'xn--bcher-kva.de')
    assert.equal(P.canonicalDomain('_dmarc.my-site.io'), '_dmarc.my-site.io')
    for (const bad of ['', 'a..b', 'a b.com', 'a/b.com', 'x.' + 'a'.repeat(64), `${'a'.repeat(60)}.`.repeat(4) + 'abcdefghij', 'ex!.com']) assert.throws(() => P.canonicalDomain(bad), /Not a valid domain/, bad)
    const longest = `${'a'.repeat(63)}.`.repeat(3) + 'a'.repeat(61)
    assert.equal(P.canonicalDomain(longest), longest)
    assert.equal(longest.length, 253)
    assert.throws(() => P.canonicalDomain(longest + 'a'), /Not a valid domain/)
  },

  'fixtures: dnsprovejs sets, scrambled, come out byte-identical to the bench proofs': async () => {
    let n = 0
    for (const name of CHAINS) {
      const fx = fixtures[name]
      // Rebuild SignedSets the way dnsprovejs holds a resolver's answer, then scramble what canonical form
      // must undo: record order, letter case of every name, a duplicated record.
      const sets = fx.sets.map(s => {
        const set = SignedSet.fromWire(unhex(s.rrset), unhex(s.sig))
        set.records.reverse()
        for (const r of set.records) r.name = r.name.toUpperCase()
        set.records.push({ ...set.records[0] })
        set.signature.data.signersName = set.signature.data.signersName.toUpperCase()
        return set
      })
      assert.ok(sets.some(s => /[A-Z]/.test(Buffer.from(s.toWire()).toString('latin1'))), 'scrambling reached the wire')
      const steps = await P.stepsFromSets(sets)
      assert.equal(steps.length, fx.sets.length)
      for (const [i, st] of steps.entries()) {
        const f = fx.sets[i]
        assert.equal(hex(st.signed), f.rrset, `${name} ${f.owner} ${f.type}: signed bytes`)
        assert.equal(hex(st.sig), f.sig)
        assert.equal(st.ownerName, f.owner)
        assert.equal(st.typeName, typeof f.type === 'number' ? 'A' : f.type)
        assert.equal(st.signerName, f.signer)
        assert.deepEqual([st.algorithm, st.keyTag, st.labels, st.inception, st.expiration, st.records.length, st.signed.length, st.headerLength],
          [f.algorithm, f.keyTag, f.rrsigLabels, f.inception, f.expiration, f.records, f.signedBytes, f.rrsigHeaderBytes])
        n++
      }
      // The fixture's own bytes are already canonical: a no-op.
      for (const f of fx.sets) assert.equal(hex(P.canonicalSigned(f.rrset)), f.rrset)
    }
    stats.fixtureSteps = n
    say(`     ${n} signed sets byte-identical across ${CHAINS.length} chains`)
  },

  'fixtures: every step verifies from the IANA anchors at fetch time (port of verify_step, real crypto)': async () => {
    // The anchors come from dnsprovejs here; the Rust reference compiles in the same two.
    assert.deepEqual(ROOT_DS.map(hex), ['4f660802e06d44b80b8f1d39a95c0b0d7c65d08458e880409bbc683457104237c7f8ec8d', '97280802683d2d0acb8c9b712a1948b27f741219298d0a450d612c483af444a4c0fb2b16'])
    let n = 0
    for (const name of CHAINS) {
      const steps = await stepsOf(name)
      const verified = await verifyChain(steps, fixtures[name].fetchedAt)
      const leaf = steps.at(-1)
      assert.ok(verified.has(`${hex(leaf.owner)}/${leaf.rrtype}`), `${name}: leaf`)
      n += steps.length
      // A flipped signature byte must fail.
      const bad = { ...leaf, sig: Uint8Array.from(leaf.sig, (b, i) => (i === 10 ? b ^ 1 : b)) }
      await assert.rejects(verifyChain([...steps.slice(0, -1), bad], fixtures[name].fetchedAt), /no key verified/)
    }
    say(`     ${n} steps verified (RSA-1024/2048, P-256, Ed25519, DS digest types 1 and 2)`)
  },

  'parser: rejects what the Rust reference rejects': async () => {
    const cf = fixtures['cloudflare.com']
    const ds = unhex(cf.sets[1].rrset) // com. DS, signed by the root
    const keys = unhex(cf.sets[4].rrset) // cloudflare.com. DNSKEY, 2 records
    const edit = (b, f) => { const c = Uint8Array.from(b); f(c); return c }
    const code = (f, c) => assert.throws(f, e => e.code === c, c)
    const ownerAt = 18 + 1 // signer "." is one byte
    code(() => P.parseSigned(edit(ds, b => { b[ownerAt + 1] = 0x43 })), 'NameNotLowercase')
    code(() => P.parseSigned(edit(ds, b => { b[3] = 2 })), 'InvalidLabelCount')
    code(() => P.parseSigned(edit(ds, b => { b[0] = 0; b[1] = 48 })), 'SignatureTypeMismatch')
    code(() => P.parseSigned(edit(ds, b => { b[ownerAt + 5 + 3] = 3 })), 'InvalidClass')
    code(() => P.parseSigned(cat(ds.subarray(0, 18), [0xc0, 0x0c])), 'BadName')
    code(() => P.parseSigned(ds.subarray(0, 19)), 'EmptyRRset')
    code(() => P.parseSigned(ds.subarray(0, ds.length - 1)), 'BadSignedData')
    code(() => P.parseSigned(edit(keys, b => { b.set(Buffer.from('org'), 18 + 1 + 10 + 1) })), 'InvalidSignerName')
    const second = 18 + 16 + 16 + 10 + ((keys[18 + 16 + 16 + 8] << 8) | keys[18 + 16 + 16 + 9])
    code(() => P.parseSigned(edit(keys, b => { b[second + 1] = 0x64 })), 'InvalidRRSet') // "cloudflare" -> "dloudflare"
    const p = P.parseSigned(ds)
    code(() => P.parseSigned(ds, p.expiration + 1), 'SignatureExpired')
    code(() => P.parseSigned(ds, p.inception - 1), 'SignatureNotValidYet')
    P.parseSigned(ds, p.expiration)
    P.parseSigned(ds, p.inception)
    // RFC 1982 arithmetic across the 2106 wrap, as the program computes signed_at / expires_at.
    assert.deepEqual(P.validity({ inception: 50, expiration: 200 }, 2 ** 32 + 100), { signedAt: 2 ** 32 + 50, expiresAt: 2 ** 32 + 200, expired: false, notYetValid: false })
    assert.deepEqual(P.validity({ inception: 2 ** 32 - 50, expiration: 100 }, 2 ** 32 + 10), { signedAt: 2 ** 32 - 50, expiresAt: 2 ** 32 + 100, expired: false, notYetValid: false })
    await assert.rejects(P.buildStep(edit(ds, b => { b[2] = 14 }), new Uint8Array(96)), e => e.code === 'UnsupportedAlgorithm')
    await assert.rejects(P.buildStep(unhex(cf.sets[2].rrset), new Uint8Array(65)), e => e.code === 'BadSignature')
    // RSASHA1 (5) and RSASHA1-NSEC3-SHA1 (7) are refused like the program refuses them, naming the zone that signs.
    await assert.rejects(P.buildStep(edit(ds, b => { b[2] = 5 }), new Uint8Array(256)),
      e => e.code === 'UnsupportedAlgorithm' && e.message.includes('The root zone signs with RSASHA1 (algorithm 5)') && e.message.includes('8 (RSASHA256), 13 (ECDSAP256SHA256) and 15 (Ed25519)'))
    await assert.rejects(P.buildStep(edit(keys, b => { b[2] = 7 }), new Uint8Array(128)),
      e => e.code === 'UnsupportedAlgorithm' && e.message.includes('cloudflare.com signs with RSASHA1-NSEC3-SHA1 (algorithm 7)') && e.message.includes('once cloudflare.com is signed'))
    // RSA signatures are as long as the modulus: 1024 to 4096-bit keys, 128 to 512 bytes.
    assert.deepEqual(P.RSA_SIGNATURE_BYTES, [128, 512])
    for (const n of [64, 127, 513]) await assert.rejects(P.buildStep(ds, new Uint8Array(n)), e => e.code === 'BadSignature' && e.message.includes('128 to 512 bytes'), `${n} bytes`)
    for (const n of [128, 256, 384, 512]) assert.equal((await P.buildStep(ds, new Uint8Array(n))).bits, 8 * n)
  },

  'PDA seeds: ["rrset", sha256(owner wire), rrtype u16 BE] as the program derives them': async () => {
    const steps = await stepsOf('cloudflare.com')
    for (const s of steps) {
      assert.equal(Buffer.from(s.seeds[0]).toString(), 'rrset')
      assert.equal(hex(s.seeds[1]), hex(sha('sha256', s.owner)))
      assert.deepEqual([...s.seeds[2]], [s.rrtype >> 8, s.rrtype & 255])
      const [a] = await sol.findProgramAddress(s.seeds, PROGRAM)
      assert.equal(await P.rrsetAddress(s, encoder), a)
      assert.equal(await P.rrsetAddress(s, { programId: PROGRAM }), a)
    }
    // ROOT_NAME_HASH in programs/type262/src/constants.rs.
    assert.equal(hex(steps[0].nameHash), '6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d')
    assert.equal(steps[0].parent, null)
    assert.equal(hex(steps[1].parent.owner), '00')
    assert.equal(steps[1].parent.rrtype, 48)
    assert.equal(steps[2].parent.rrtype, 43) // com. DNSKEY is checked against com. DS
    // The program's own derivation (dnssec.rs store / wallet_signed_at, tests-rs rrset_pda): rrtype.to_be_bytes().
    const leafSeeds = [Buffer.from('rrset'), sha('sha256', P.nameToWire('_wallet.example.com')), Uint8Array.of(0, 16)]
    assert.equal(await P.rrsetAddress({ nameHash: leafSeeds[1], rrtype: 16 }, encoder), (await sol.findProgramAddress(leafSeeds, PROGRAM))[0])
    // DNSSEC.md's table says little-endian; that layout plugs in through the encoder.
    const le = await P.anchorEncoder({ programId: PROGRAM, rrtypeEndian: 'le' })
    assert.deepEqual([...le.rrsetSeeds(steps[1])[2]], [43, 0])
    assert.notEqual(await P.rrsetAddress(steps[1], le), await P.rrsetAddress(steps[1], encoder))
  },

  'low-S: normalized P-256 signatures verify (WebCrypto, node:crypto DER, noble strict)': async () => {
    let noble = null
    try { ({ p256: noble } = await import('@noble/curves/p256')) } catch {}
    let total = 0
    let flipped = 0
    for (const name of CHAINS) {
      const steps = await stepsOf(name)
      for (const st of steps.filter(s => s.kind === 'p256')) {
        const keys = st.selfSigned ? st.records : steps.find(s => s.rrtype === 48 && hex(s.owner) === hex(st.signer)).records
        const key = await P.signingKey(st, keys)
        const { signature: low, flipped: f } = P.p256LowS(st.sig)
        total++
        if (f) flipped++
        assert.ok(big(low.subarray(32)) <= P.P256_ORDER >> 1n)
        assert.equal(hex(low.subarray(0, 32)), hex(st.sig.subarray(0, 32)), 'r unchanged')
        assert.equal(f, hex(low) !== hex(st.sig))
        assert.ok(await webVerify(13, key, st.signed, st.sig), 'original verifies')
        assert.ok(await webVerify(13, key, st.signed, low), 'low-S verifies')
        // DER both ways, and OpenSSL through node:crypto on the DER form.
        assert.equal(hex(P.p256DerToRaw(P.p256RawToDer(low))), hex(low))
        assert.equal(hex(P.p256DerToRaw(P.p256RawToDer(st.sig))), hex(st.sig))
        const spki = Buffer.concat([Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex'), Buffer.from(cat([4], key.subarray(4)))])
        const pub = createPublicKey({ key: spki, format: 'der', type: 'spki' })
        assert.ok(nodeVerify('sha256', st.signed, { key: pub, dsaEncoding: 'der' }, P.p256RawToDer(low)))
        assert.ok(nodeVerify('sha256', st.signed, { key: pub, dsaEncoding: 'ieee-p1363' }, low))
        // The precompile's key: compressed point, as introspect::p256_compressed builds it.
        assert.equal(hex(P.p256Compress(key.subarray(4))), hex(cat([2 | (key[67] & 1)], key.subarray(4, 36))))
        if (noble) {
          assert.ok(noble.verify(low, st.signed, P.p256Compress(key.subarray(4)), { lowS: true, prehash: true }))
          if (f) assert.equal(noble.verify(st.sig, st.signed, P.p256Compress(key.subarray(4)), { lowS: true, prehash: true }), false, 'strict verify refuses high S')
        }
      }
    }
    // DNSSEC.md: in the cloudflare.com chain 2 of the 4 P-256 signatures are high-S.
    const cf = (await stepsOf('cloudflare.com')).filter(s => s.kind === 'p256').map(s => P.p256LowS(s.sig).flipped)
    assert.deepEqual([cf.length, cf.filter(Boolean).length], [4, 2])
    // DER edge cases: short integers, a leading 0x00 for a high bit, garbage.
    const raw = cat(new Uint8Array(31), [5], [0x80], new Uint8Array(31).fill(7))
    const der = P.p256RawToDer(raw)
    assert.equal(hex(der), '3026020105022100' + '80' + '07'.repeat(31))
    assert.equal(hex(P.p256DerToRaw(der)), hex(raw))
    assert.throws(() => P.p256DerToRaw(cat(der, [0])), /DER/)
    assert.throws(() => P.p256DerToRaw(unhex('3006020101020101ff')), /DER/)
    stats.p256 = `${total} P-256 signatures, ${flipped} high-S normalized${noble ? ', noble strict low-S check on' : ''}`
    say(`     ${stats.p256}`)
  },

  'precompile instructions: the layout DNSSEC.md fixes': async () => {
    // Program ids, as introspect.rs has them in bytes.
    assert.deepEqual([...sol.pubkeyBytes(P.SECP256R1_PROGRAM)], [6, 146, 13, 236, 47, 234, 113, 181, 183, 35, 129, 77, 116, 45, 169, 3, 28, 131, 231, 95, 219, 121, 93, 86, 142, 117, 71, 128, 32, 0, 0, 0])
    assert.deepEqual([...sol.pubkeyBytes(P.ED25519_PROGRAM)], [3, 125, 70, 214, 124, 147, 251, 190, 18, 249, 66, 143, 131, 141, 64, 255, 5, 112, 116, 73, 39, 244, 138, 100, 252, 202, 112, 68, 128, 0, 0, 0])
    const pk = new Uint8Array(33).fill(2)
    const sig = new Uint8Array(64).fill(9)
    // One entry: [1, 0], sig at 16 + 33, sig ix u16::MAX, key at 16, key ix u16::MAX, message 12 / len / ix 1.
    const one = P.secp256r1Instruction([{ publicKey: pk, signature: sig, instructionIndex: 1, messageOffset: 12, messageSize: 189 }])
    assert.equal(one.programId, P.SECP256R1_PROGRAM)
    assert.deepEqual(one.keys, [])
    assert.equal(hex(one.data), '0100' + '3100' + 'ffff' + '1000' + 'ffff' + '0c00' + 'bd00' + '0100' + hex(pk) + hex(sig))
    // Several entries: the bench's precompile_multi layout (keys and signatures after all offsets, in order).
    const bench = es => {
      const d = [es.length, 0]
      const tail = []
      let at = 2 + 14 * es.length
      for (const [k, s, ix, off, len] of es) { const po = at; const so = at + k.length; at += k.length + s.length; for (const v of [so, 0xffff, po, 0xffff, off, len, ix]) d.push(...u16le(v)); tail.push(...k, ...s) }
      return Uint8Array.from([...d, ...tail])
    }
    const es = [[pk, sig, 2, 12, 85], [new Uint8Array(33).fill(3), new Uint8Array(64).fill(4), 3, 12, 222], [new Uint8Array(33).fill(5), new Uint8Array(64).fill(6), 4, 12, 117]]
    const multi = P.secp256r1Instruction(es.map(([k, s, ix, off, len]) => ({ publicKey: k, signature: s, instructionIndex: ix, messageOffset: off, messageSize: len })))
    assert.equal(hex(multi.data), hex(bench(es)))
    const ed = P.ed25519Instruction([{ publicKey: new Uint8Array(32).fill(1), signature: sig, instructionIndex: 1, messageOffset: 12, messageSize: 56 }])
    assert.equal(hex(ed.data.subarray(0, 16)), '0100' + '3000' + 'ffff' + '1000' + 'ffff' + '0c00' + '3800' + '0100')
    assert.equal(ed.data.length, 16 + 32 + 64)
    assert.throws(() => P.secp256r1Instruction([]), /1 to 8/)
    assert.throws(() => P.secp256r1Instruction(Array(9).fill({ publicKey: pk, signature: sig, instructionIndex: 1, messageOffset: 12, messageSize: 1 })), /1 to 8/)
    // An entry for a real step: compressed DNSKEY, low-S signature, message = the signed bytes at offset 12.
    const steps = await stepsOf('cloudflare.com')
    const st = steps[2]
    const key = await P.signingKey(st, st.records)
    const e = P.precompileEntry(st, key, 1)
    assert.deepEqual([e.instructionIndex, e.messageOffset, e.messageSize], [1, 12, 189])
    assert.equal(hex(e.publicKey), hex(P.p256Compress(key.subarray(4))))
    assert.equal(hex(e.signature), hex(P.p256LowS(st.sig).signature))
    const edSteps = await stepsOf('ed25519.nl')
    const ee = P.precompileEntry(edSteps[5], await P.signingKey(edSteps[5], edSteps[4].records), 3)
    assert.deepEqual([ee.publicKey.length, ee.signature.length, ee.messageSize], [32, 64, 56])
    assert.throws(() => P.precompileEntry(steps[1], key, 1), /does not use a precompile/)
  },

  'anchor encoder: discriminators, data and accounts': async () => {
    const steps = await stepsOf('cloudflare.com')
    const disc = n => hex(sha('sha256', `global:${n}`).subarray(0, 8))
    const [rootStep, comDs, comKeys] = steps
    const a = { payer: PAYER, parent: 'So11111111111111111111111111111111111111112', rrset: 'SysvarRent111111111111111111111111111111111' }
    const inline = encoder.verifyInline({ ...a, step: comDs })
    assert.equal(hex(inline.data), disc('verify_rrset') + hex(u32(comDs.signed.length)) + hex(comDs.signed) + hex(u32(256)) + hex(comDs.sig))
    assert.deepEqual(inline.keys.map(k => [k.pubkey, k.isSigner, k.isWritable]), [[PAYER, true, true], [a.parent, false, false], [a.rrset, false, true], [sol.SYSTEM_PROGRAM, false, false], [P.INSTRUCTIONS_SYSVAR, false, false]])
    const { instruction, messageOffset } = encoder.verifyPrecompiled({ ...a, step: comKeys })
    assert.equal(messageOffset, 12)
    assert.equal(hex(instruction.data.subarray(0, 8)), disc('verify_rrset_precompiled'))
    assert.equal(hex(instruction.data.subarray(8, 12)), hex(u32(189)))
    assert.equal(hex(instruction.data.subarray(12)), hex(comKeys.signed))
    const rootIx = encoder.verifyInline({ ...a, parent: null, step: rootStep })
    assert.equal(rootIx.keys[1].pubkey, PROGRAM, 'no parent: Anchor None')
    const w = encoder.writeBuffer({ payer: PAYER, buffer: a.rrset, offset: 979, bytes: Uint8Array.of(1, 2, 3) })
    assert.equal(hex(w.data), disc('write_buffer') + 'd3030000' + '03000000' + '010203')
    assert.deepEqual(w.keys.map(k => [k.isSigner, k.isWritable]), [[true, true], [false, true], [false, false]])
    const b = encoder.verifyBuffered({ ...a, step: comDs, buffer: 'SysvarC1ock11111111111111111111111111111111' })
    assert.equal(hex(b.data), disc('verify_rrset_buffered'))
    assert.deepEqual([b.keys.length, b.keys[5].pubkey, b.keys[5].isWritable], [6, 'SysvarC1ock11111111111111111111111111111111', true])
    assert.equal(hex(encoder.bufferPayload(comDs)), hex(u32(70)) + hex(comDs.signed) + hex(u32(256)) + hex(comDs.sig))
    // Other instruction names plug in.
    const renamed = await P.anchorEncoder({ programId: PROGRAM, names: { inline: 'prove_rrset' } })
    assert.equal(hex(renamed.verifyInline({ ...a, step: comDs }).data.subarray(0, 8)), disc('prove_rrset'))
  },

  'sizes: one step inline matches DNSSEC.md for all 36 steps, and the planner picks the same mode': async () => {
    // The bench passes a distinct parent account even for the root set; Anchor's None is the program id.
    const benchShape = { ...encoder, verifyInline: x => encoder.verifyInline({ ...x, parent: x.parent || 'So11111111111111111111111111111111111111112' }) }
    let n = 0
    for (const name of CHAINS) {
      const steps = await stepsOf(name)
      const now = fixtures[name].fetchedAt
      for (const [i, st] of steps.entries()) {
        const cache = await cacheWith(steps.filter(s => s !== st), now)
        const wide = await P.planProof(steps, { payer: PAYER, encoder: i ? encoder : benchShape, cache, now, limit: 4096 })
        assert.equal(wide.transactions.length, 1)
        assert.equal(wide.transactions[0].size, DOC_LEGACY[name][i], `${name} ${st.label}`)
        let mode
        try {
          const real = await plan(steps, { cache, now })
          mode = real.steps[i].status === 'buffered' ? 'buffer' : 'inline'
          await checkPlan(real, steps)
        } catch (err) { if (err.code !== 'NeedsV1') throw err; mode = 'v1 only' }
        assert.equal(mode, DOC_MODE[name][i], `${name} ${st.label} mode`)
        n++
      }
    }
    say(`     ${n} single-step sizes equal the Rust bench's`)
  },

  'buffer: write_buffer chunks of 979 B, last 826 B in the verify transaction': async () => {
    const nasa = await stepsOf('nasa.gov')
    const now = fixtures['nasa.gov'].fetchedAt
    const leaf = nasa[5] // 1,977-byte payload
    const p = await plan(nasa, { cache: await cacheWith(nasa.slice(0, 5), now), now })
    assert.equal(shape(p), 'upload:5 upload:5 verify:5')
    assert.deepEqual(p.transactions.map(t => t.bytes), [[0, 979], [979, 1151], [1151, 1977]])
    assert.equal(8 + leaf.signed.length + leaf.sig.length, 1977)
    assert.equal(p.transactions[0].size, 1232)
    assert.ok(p.transactions[2].size <= 1232)
    const keyStep = nasa[4]
    const k = await plan(nasa, { cache: await cacheWith(nasa.filter(s => s !== keyStep), now), now })
    assert.deepEqual(k.transactions.map(t => t.bytes), [[0, 62], [62, 888]]) // DNSSEC.md: nasa.gov DNSKEY, 888 B, 2 transactions
    // The root step has no parent account, so 32 more bytes ride in its verify transaction.
    const cf = await stepsOf('cloudflare.com')
    const r = await plan(cf, { cache: await cacheWith(cf.slice(1), fixtures['cloudflare.com'].fetchedAt), now: fixtures['cloudflare.com'].fetchedAt })
    assert.deepEqual(r.transactions.map(t => t.bytes), [[0, 250], [250, 1108]])
    // The buffer is the payer's ["buffer", payer] PDA.
    const [buffer] = await sol.findProgramAddress([Buffer.from('buffer'), sol.pubkeyBytes(PAYER)], PROGRAM)
    for (const t of [...p.transactions, ...r.transactions]) assert.ok(t.instructions.some(ix => ix.keys.some(m => m.pubkey === buffer && m.isWritable)))
    const verifyIx = r.transactions[1].instructions
    assert.equal(verifyIx[0].programId, P.COMPUTE_BUDGET_PROGRAM)
    assert.equal(hex(verifyIx[0].data), '02' + hex(u32(1_400_000)))
  },

  'planner: transaction counts per DNSSEC.md (P-256 .com zone, RSA .io zone)': async () => {
    const cfAll = await stepsOf('cloudflare.com')
    const now = fixtures['cloudflare.com'].fetchedAt
    const leaf = await walletLeaf(cfAll[4], now)
    assert.equal(leaf.signed.length, 117)
    const cf = await P.stepsFromSets([...cfAll.slice(0, 5), leaf].map(s => ({ signed: s.signed, sig: s.sig })))
    const fake = [leaf.signed]
    const cold = await plan(cf, { now })
    assert.equal(shape(cold), 'upload:0 verify:0 verify:1 verify:2+3 verify:4+5')
    const warm = await plan(cf, { now, cache: await cacheWith(cf.slice(0, 3), now) })
    assert.equal(shape(warm), 'verify:3+4+5')
    assert.equal(warm.transactions[0].size, 1215)
    assert.equal(warm.signatures, 4)
    assert.equal(warm.fee, 20_000) // DNSSEC.md: the 3-step P-256 transaction costs 20,000 lamports
    const hot = await plan(cf, { now, cache: await cacheWith(cf.slice(0, 5), now) })
    assert.equal(shape(hot), 'verify:5')
    const none = await plan(cf, { now, cache: await cacheWith(cf, now) })
    assert.equal(none.transactions.length, 0)
    assert.deepEqual(none.steps.map(s => s.status), Array(6).fill('cached'))
    // Exact packed sizes from DNSSEC.md: domain DS + DNSKEY 934 B, DNSKEY + _wallet TXT 967 B.
    const pair = await plan(cf.slice(0, 5), { now, cache: await cacheWith(cf.slice(0, 3), now) })
    assert.deepEqual(pair.transactions.map(t => t.size), [934])
    const tail = await plan(cf, { now, cache: await cacheWith(cf.slice(0, 4), now) })
    assert.deepEqual(tail.transactions.map(t => t.size), [967])
    // A priority fee no longer lets the three steps share one transaction.
    const priced = await plan(cf, { now, cache: await cacheWith(cf.slice(0, 3), now), computeUnitPrice: 1000 })
    assert.equal(shape(priced), 'verify:3+4 verify:5')
    assert.ok(priced.transactions.every(t => t.instructions[1].programId === P.COMPUTE_BUDGET_PROGRAM && t.instructions[1].data[0] === 3))
    let entries = 0
    for (const p of [cold, warm, hot, pair, tail, priced]) entries += await checkPlan(p, cf, { fakeSigned: fake })

    const io = await stepsOf('_wallet.gemprotocol.io')
    const ioNow = fixtures['_wallet.gemprotocol.io'].fetchedAt
    const ioCold = await plan(io, { now: ioNow })
    assert.equal(shape(ioCold), 'upload:0 verify:0 verify:1 upload:2 verify:2 verify:3 verify:4 verify:5')
    const ioWarm = await plan(io, { now: ioNow, cache: await cacheWith(io.slice(0, 3), ioNow) })
    assert.equal(ioWarm.transactions.length, 3)
    const ioHot = await plan(io, { now: ioNow, cache: await cacheWith(io.slice(0, 5), ioNow) })
    assert.equal(shape(ioHot), 'verify:5')
    for (const p of [ioCold, ioWarm, ioHot]) await checkPlan(p, io)
    stats.counts = `cloudflare-style ${cold.transactions.length}/${warm.transactions.length}/${hot.transactions.length}, gemprotocol-style ${ioCold.transactions.length}/${ioWarm.transactions.length}/${ioHot.transactions.length} (cold / root+TLD cached / domain cached)`
    say(`     ${stats.counts}; ${entries} precompile entries checked`)
  },

  'planner: every fixture chain, cold, fits legacy transactions and passes the runtime checks': async () => {
    let txs = 0
    let entries = 0
    for (const name of CHAINS) {
      let steps = await stepsOf(name)
      const now = fixtures[name].fetchedAt
      // cloudflare.com's apex TXT (2,936 B) is not a claim leaf and needs a v1 transaction: plan up to its zone keys.
      if (name === 'cloudflare.com') {
        await assert.rejects(plan(steps, { now }), e => e.code === 'NeedsV1')
        steps = steps.slice(0, 5)
      }
      const p = await plan(steps, { now })
      entries += await checkPlan(p, steps)
      txs += p.transactions.length
      // RSA-2048 steps run alone; RSA-1024 may share with P-256 (ietf.org DS + DNSKEY).
      for (const t of p.transactions) {
        const big2048 = t.steps.filter(i => steps[i].kind === 'rsa' && steps[i].bits > 1024)
        if (big2048.length) assert.equal(t.steps.length, 1)
      }
      if (name === 'ietf.org') assert.ok(p.transactions.some(t => t.steps.join() === '3,4'))
      // A flipped byte in a signed set breaks its precompile entry.
      const pre = p.transactions.find(t => t.kind === 'verify' && t.steps.some(i => steps[i].kind !== 'rsa'))
      if (pre) {
        const ixs = pre.instructions.map(ix => ({ ...ix, data: Uint8Array.from(ix.data) }))
        const last = ixs.at(-1)
        last.data[last.data.length - 1] ^= 1
        await assert.rejects(checkPlan({ transactions: [{ ...pre, instructions: ixs }] }, steps), /does not verify|signed bytes at offset 12/)
      }
    }
    say(`     ${txs} transactions, ${entries} precompile entries`)
  },

  'planner: cache rules (changed, expiring, expired, stale leaf, missing parent, expired proof)': async () => {
    const steps = await stepsOf('_wallet.gemprotocol.io')
    const now = fixtures['_wallet.gemprotocol.io'].fetchedAt
    const statuses = p => p.steps.map(s => s.reason).join(' ')
    // A key rollover: the cached io. DNSKEY holds other records, so it is proven again.
    let p = await plan(steps, { now, cache: await cacheWith(steps.slice(0, 5), now, (s, e) => { if (s.index === 2) e.records = e.records.slice(1) }) })
    assert.equal(statuses(p), 'cached cached changed cached cached missing')
    assert.equal(shape(p), 'upload:2 verify:2 verify:5')
    p = await plan(steps, { now, cache: await cacheWith(steps.slice(0, 5), now, (s, e) => { if (s.index === 1) e.expiresAt = now + 300 }) })
    assert.equal(statuses(p), 'cached expiring cached cached cached missing')
    p = await plan(steps, { now, margin: 60, cache: await cacheWith(steps.slice(0, 5), now, (s, e) => { if (s.index === 1) e.expiresAt = now + 300 }) })
    assert.equal(p.steps[1].status, 'cached')
    p = await plan(steps, { now, cache: await cacheWith(steps.slice(0, 5), now, (s, e) => { if (s.index === 0) e.expiresAt = now - 1 }) })
    assert.equal(p.steps[0].reason, 'expiring')
    // The leaf cached with an older signing time than the escrow's last proof is proven again.
    const leaf = steps[5]
    const signedAt = P.validity(leaf, now).signedAt
    const cached = await cacheWith(steps, now, (s, e) => { if (s === leaf) e.signedAt = signedAt - 10 })
    assert.equal(shape(await plan(steps, { now, cache: cached })), '')
    assert.equal(shape(await plan(steps, { now, cache: cached, minLeafSignedAt: signedAt })), 'verify:5')
    await assert.rejects(plan(steps, { now, cache: cached, minLeafSignedAt: signedAt + 1 }), e => e.code === 'StaleProof')
    // A cached leaf newer than the fetched one still serves the claim.
    const newer = await cacheWith(steps, now, (s, e) => { if (s === leaf) e.signedAt = signedAt + 100 })
    assert.equal(shape(await plan(steps, { now, cache: newer, minLeafSignedAt: signedAt + 50 })), '')
    // A step whose parent is neither in the proof nor cached cannot be planned.
    await assert.rejects(plan(steps.slice(3), { now }), e => e.code === 'WrongParent')
    assert.equal(shape(await plan(steps.slice(3), { now, cache: await cacheWith(steps.slice(0, 3), now) })), 'verify:0 verify:1 verify:2')
    await assert.rejects(plan(steps.slice(3), { now, cache: await cacheWith(steps.slice(0, 3), now, (s, e) => { e.expiresAt = now - 5 }) }), e => e.code === 'WrongParent')
    // Signatures past their expiration are refused before anything is sent.
    await assert.rejects(plan(steps, { now: leaf.expiration + 1 }), e => e.code === 'SignatureExpired')
    // Appending the claim: into the last transaction when it fits, else its own.
    const claim = { programId: PROGRAM, keys: [{ pubkey: PAYER, isSigner: true, isWritable: true }], data: new Uint8Array(40) }
    const withClaim = await plan(steps, { now, cache: await cacheWith(steps.slice(0, 5), now), append: [claim] })
    assert.deepEqual(withClaim.transactions.map(t => [t.kind, t.instructions.length, !!t.appended]), [['verify', 3, true]])
    const ownTx = await plan(steps, { now, cache: await cacheWith(steps.slice(0, 4), now), append: [claim] })
    assert.equal(shape(ownTx), 'verify:4 verify:5') // RSA-2048 DNSKEY uses the budget, the RSA-1024 leaf takes the claim
    assert.ok(ownTx.transactions[1].appended)
  },

  'planner: RSA keys above 2048 bits are refused before anything is built': async () => {
    const cf = await stepsOf('cloudflare.com')
    const now = fixtures['cloudflare.com'].fetchedAt
    assert.equal(P.MAX_RSA_BITS, 2048)
    assert.ok((await Promise.all(CHAINS.map(stepsOf))).flat().every(s => s.kind !== 'rsa' || s.bits <= 2048), 'every real chain uses 1024 to 2048-bit keys')
    // com. DS as if the root signed it with a 3072 or 4096-bit key. Inline it would fit a legacy transaction, and
    // the verify would then run out of compute on-chain; the planner stops first.
    for (const bits of [3072, 4096]) {
      const big = await P.buildStep(cf[1].signed, new Uint8Array(bits / 8))
      assert.equal(big.bits, bits)
      await assert.rejects(plan([cf[0], big], { now }), e => e.code === 'NeedsSplitRsa'
        && e.message.includes(`The root zone signs with a ${bits}-bit RSA key. ${bits}-bit RSA keys are not supported on Solana yet`))
      // Already cached (verified some other way), it is reused like any other set.
      assert.equal(shape(await plan([cf[0], big], { now, cache: await cacheWith([big], now) })), 'upload:0 verify:0')
    }
    const ok = await P.buildStep(cf[1].signed, new Uint8Array(256))
    assert.equal(shape(await plan([cf[0], ok], { now, cache: await cacheWith([cf[0]], now) })), 'verify:1')
  },

  'fetchProof: zones signed with RSASHA1 are refused by name; a rollover proves through the supported signature': async () => {
    // A DNS-over-HTTPS server for dnsprovejs: . (the real root DNSKEY set) -> test. -> three domains. dnsprovejs checks
    // DS digests and key tags, not signatures (ALGORITHMS in solana-proof.js), so the signatures are stand-ins.
    const u16be = n => [(n >> 8) & 255, n & 255]
    const u32be = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b }
    const zone = {}
    const serve = (owner, rrtype, records, sigs) => {
      const rr = (type, rdata) => cat(P.nameToWire(owner), u16be(type), u16be(1), u32be(300), u16be(rdata.length), rdata)
      const rrsig = s => cat(u16be(rrtype), [s.algorithm, owner === '.' ? 0 : owner.split('.').length], u32be(s.originalTtl ?? 300),
        u32be(s.expiration ?? 1_900_000_000), u32be(s.inception ?? 1_700_000_000), u16be(s.keyTag), P.nameToWire(s.signer), s.sig ?? new Uint8Array(s.algorithm === 15 ? 64 : 128))
      zone[`${owner}|${rrtype}`] = [...records.map(d => rr(rrtype, d)), ...sigs.map(s => rr(46, rrsig(s)))]
    }
    const doh = async url => {
      const q = Buffer.from(new URL(url).searchParams.get('dns'), 'base64url')
      const labels = []
      let at = 12
      while (q[at]) { labels.push(q.subarray(at + 1, at + 1 + q[at]).toString('latin1').toLowerCase()); at += 1 + q[at] }
      const rrs = zone[`${labels.join('.') || '.'}|${q.readUInt16BE(at + 1)}`] || []
      return new Response(cat([q[0], q[1], 0x81, 0xa0, 0, 1, 0, rrs.length, 0, 0, 0, 0], q.subarray(12, at + 5), ...rrs), { headers: { 'content-type': 'application/dns-message' } })
    }
    const key = (flags, algorithm, fill) => cat(u16be(flags), [3, algorithm], algorithm === 15 ? new Uint8Array(32).fill(fill) : cat([3, 1, 0, 1], [0xc0], new Uint8Array(126).fill(fill), [1]))
    const ds = (owner, k) => cat(u16be(P.keyTag(k)), [k[3], 2], sha('sha256', P.nameToWire(owner), k))
    const by = (k, signer) => ({ algorithm: k[3], keyTag: P.keyTag(k), signer })

    const root = (await stepsOf('cloudflare.com'))[0]
    serve('.', 48, root.records, [{ ...root, signer: '.', sig: root.sig }])
    const zsk = root.records.find(r => r[0] === 1 && r[1] === 0)
    const tld = key(257, 15, 1)
    serve('test', 43, [ds('test', tld)], [{ ...by(zsk, '.'), sig: new Uint8Array(256) }])
    serve('test', 48, [tld], [by(tld, 'test')])
    const domain = (name, keys, keySigners, txtSigners) => {
      serve(name, 43, [ds(name, keys[0])], [by(tld, 'test')])
      serve(name, 48, keys, keySigners.map(k => by(k, name)))
      serve(`_wallet.${name}`, 16, [txt(`SOL ${PAYER}`)], txtSigners.map(k => by(k, name)))
    }
    const ed = key(257, 15, 2)
    const rsa7 = key(256, 7, 3)
    const rsa5 = key(257, 5, 4)
    const edZsk = key(256, 15, 5)
    domain('sha1.test', [ed, rsa7], [ed], [rsa7]) // the TXT is signed with algorithm 7 only
    domain('rollover.test', [ed, rsa7], [ed], [rsa7, ed]) // signed with 7 and 15, 7 listed first
    domain('ksk.test', [rsa5, edZsk], [rsa5], [edZsk]) // the zone's key set is signed with algorithm 5 only

    const saved = globalThis.fetch
    globalThis.fetch = doh
    try {
      const refused = (name, text) => assert.rejects(quiet(() => P.fetchWalletProof(name)), e => e.code === 'UnsupportedAlgorithm' && e.message.includes(text), name)
      await refused('sha1.test', 'sha1.test signs with RSASHA1-NSEC3-SHA1 (algorithm 7)') // dnsprovejs: no DNSKEY for the TXT
      await refused('ksk.test', 'ksk.test signs with RSASHA1 (algorithm 5)') // dnsprovejs: no DS for the key set
      const p = await quiet(() => P.fetchWalletProof('rollover.test'))
      assert.deepEqual([p.type, p.wallets, p.leaf.algorithm, p.leaf.keyTag], ['TXT', [PAYER], 15, P.keyTag(ed)])
      assert.deepEqual(p.steps.map(s => `${s.label}/${s.algorithm}`), ['. DNSKEY/8', 'test. DS/8', 'test. DNSKEY/15', 'rollover.test. DS/15', 'rollover.test. DNSKEY/15', '_wallet.rollover.test. TXT/15'])
      // A failure other than a missing supported signature is not retried with SHA-1.
      let calls = 0
      globalThis.fetch = async () => { calls++; throw new Error('offline') }
      await assert.rejects(quiet(() => P.fetchProof('TXT', '_wallet.sha1.test')), /offline/)
      assert.equal(calls, 1)
    } finally { globalThis.fetch = saved }
  },

  'fetchCache: getMultipleAccounts, owner check, decoding': async () => {
    const steps = await stepsOf('cloudflare.com')
    const now = fixtures['cloudflare.com'].fetchedAt
    const addr = await Promise.all(steps.map(s => P.rrsetAddress(s, encoder)))
    const store = new Map()
    store.set(addr[0], { owner: PROGRAM, data: [Buffer.from(rrsetAccount({ rrtype: 48, owner: steps[0].owner, records: steps[0].records, signedAt: 7, expiresAt: now + 9999, algorithm: 8, keyTag: 38696 })).toString('base64'), 'base64'] })
    store.set(addr[1], { owner: sol.SYSTEM_PROGRAM, data: [Buffer.from(rrsetAccount({ rrtype: 43, owner: steps[1].owner, records: steps[1].records, signedAt: 7, expiresAt: now + 99 })).toString('base64'), 'base64'] })
    store.set(addr[2], { owner: PROGRAM, data: [Buffer.from(new Uint8Array(40)).toString('base64'), 'base64'] })
    const otherAccount = rrsetAccount({ rrtype: 48, owner: steps[4].owner, records: steps[4].records, signedAt: 7, expiresAt: now + 9999 })
    otherAccount.set(sha('sha256', 'account:Buffer').subarray(0, 8))
    store.set(addr[4], { owner: PROGRAM, data: [Buffer.from(otherAccount).toString('base64'), 'base64'] })
    const calls = []
    const rpc = async (method, [list, cfg]) => { calls.push([method, list.length, cfg.encoding]); return { context: { slot: 1 }, value: list.map(a => store.get(a) || null) } }
    const cache = await P.fetchCache(steps, { encoder, rpc })
    assert.deepEqual(calls, [['getMultipleAccounts', 6, 'base64']])
    const root = cache.get(addr[0])
    assert.deepEqual([root.rrtype, root.algorithm, root.keyTag, root.signedAt, root.expiresAt, root.payer, root.records.length], [48, 8, 38696, 7, now + 9999, PAYER, 3])
    assert.equal(hex(root.owner), '00')
    assert.equal(cache.get(addr[1]), null, 'owned by another program')
    assert.equal(cache.get(addr[2]), null, 'not decodable')
    assert.equal(cache.get(addr[3]), null, 'missing')
    assert.equal(cache.get(addr[4]), null, 'another account type')
    assert.ok(P.decodeRrsetAccount(otherAccount), 'the layout alone would decode')
    const p = await plan(steps.slice(0, 5), { now, cache })
    assert.equal(p.steps[0].status, 'cached')
    assert.equal(p.steps[0].accountSize, rrsetAccount({ rrtype: 48, owner: steps[0].owner, records: steps[0].records, signedAt: 0, expiresAt: 0 }).length)
    assert.equal(p.steps[0].accountSize, 869) // DNSSEC.md: ". DNSKEY" account 869 B
    // More than 100 addresses go out in batches.
    const many = await Promise.all(Array.from({ length: 150 }, async (_, i) => ({ nameHash: sha('sha256', `n${i}`), rrtype: 16, parent: null })))
    calls.length = 0
    assert.equal((await P.fetchCache(many, { encoder, rpc })).size, 150)
    assert.deepEqual(calls.map(c => c[1]), [100, 50])
  },

  'wallet records: the shapes the program accepts': async () => {
    const key = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'
    assert.equal(P.solWallet(txt(`SOL ${key}`)), key)
    assert.equal(P.solWallet(txt(`sol:${key}`)), key)
    assert.equal(P.solWallet(txt(`SOL  ${key}`)), key)
    assert.equal(P.solWallet(txt(`Sol : ${key}`)), key)
    assert.equal(P.solWallet(cat(txt('SOL'), txt(key))), key)
    for (const bad of [txt(`ETH ${key}`), txt(`SOL ${key} x`), txt(`SOL ${key}1`), txt('SOL 11111111111111111111111111111111'), cat(txt('SOL'), txt(key), txt('x')), txt(`SOLANA ${key}`), txt(key), new Uint8Array(0), Uint8Array.of(5, 1)]) assert.equal(P.solWallet(bad), null)
    assert.deepEqual([...P.base58To32('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA').subarray(0, 4)], [6, 221, 246, 225])
    assert.deepEqual([...P.base58To32('11111111111111111111111111111111')], Array(32).fill(0))
    assert.equal(P.base58To32('0OIl'), null)
    assert.equal(P.base58To32('1' + key), null)
    // Agrees with solana.js on every address that decodes to 32 bytes.
    for (const a of [key, sol.TOKEN_PROGRAM, sol.ATA_PROGRAM, PAYER, '1nc1nerator11111111111111111111111111111111']) assert.equal(sol.base58Encode(P.base58To32(a)), a)

    const leafOf = async (owner, type, records) => {
      const h = Buffer.alloc(18)
      h.writeUInt16BE(type, 0); h[2] = 13; h[3] = owner.split('.').length; h.writeUInt32BE(1, 8)
      const o = P.nameToWire(owner)
      const rrs = records.map(r => { const f = Buffer.alloc(10); f.writeUInt16BE(type, 0); f.writeUInt16BE(1, 2); f.writeUInt16BE(r.length, 8); return cat(o, f, r) })
      return P.buildStep(cat(h, P.nameToWire(owner.split('.').slice(-2).join('.')), ...rrs), new Uint8Array(64))
    }
    const eth = txt('ETH 0x7edB9dC3a47bf0E8D59649B11Ee2Fb64b2BcE81f')
    const solLine = txt(`SOL ${key}`)
    const wl = await leafOf('_wallet.example.com', 16, [eth, solLine])
    assert.deepEqual(P.leafWallets(wl, 'example.com'), [key])
    assert.ok(P.publishes(wl, 'Example.COM', key))
    assert.ok(!P.publishes(wl, 'example.com', sol.TOKEN_PROGRAM))
    assert.deepEqual(P.leafWallets(wl, 'example.org'), [])
    assert.deepEqual(P.leafWallets(await leafOf('example.com', 16, [solLine]), 'example.com'), [], 'TXT only counts at _wallet')
    assert.deepEqual(P.leafWallets(await leafOf('example.com', 262, [cat(txt('SOL'), txt(key))]), 'example.com'), [key])
    assert.deepEqual(P.leafWallets(await leafOf('_wallet.example.com', 262, [cat(txt('SOL'), txt(key))]), 'example.com'), [], 'WALLET only counts at the domain')
    // The real _wallet record in the fixtures publishes an ETH address only.
    const io = (await stepsOf('_wallet.gemprotocol.io')).at(-1)
    assert.deepEqual(P.leafWallets(io, 'gemprotocol.io'), [])
  },

  'compileTransactions: unsigned wire transactions in plan order': async () => {
    const steps = await stepsOf('ed25519.nl')
    const now = fixtures['ed25519.nl'].fetchedAt
    const p = await plan(steps, { now })
    const blockhash = 'J2SKvPPiTuuGLYor8aW5NyFfFL89LWh4dwbayz9dM4UE'
    const wire = P.compileTransactions(p, { payer: PAYER, recentBlockhash: blockhash })
    assert.equal(wire.length, p.transactions.length)
    for (const [i, tx] of wire.entries()) {
      assert.equal(tx.length, p.transactions[i].size)
      assert.equal(tx[0], 1)
      assert.deepEqual(tx.subarray(1, 65), new Uint8Array(64))
      const keys = tx[65 + 3]
      assert.equal(sol.base58Encode(tx.subarray(65 + 4 + 32 * keys, 65 + 4 + 32 * keys + 32)), blockhash)
    }
    assert.ok(wire.every(t => t.length <= 1232))
  },
}

// ---------- live DNS ----------
const quiet = async f => {
  const saved = [console.log, console.info, console.debug, console.warn]
  console.log = console.info = console.debug = console.warn = () => {}
  try { return await f() } finally { [console.log, console.info, console.debug, console.warn] = saved }
}
const dump = (name, type, steps, now) => {
  if (!process.env.DUMP_DIR) return
  mkdirSync(process.env.DUMP_DIR, { recursive: true })
  const sets = steps.map(s => ({ owner: s.ownerName, type: s.typeName, algorithm: s.algorithm, keyTag: s.keyTag, rrset: hex(s.signed), sig: hex(s.sig) }))
  writeFileSync(`${process.env.DUMP_DIR}/${name}.json`, JSON.stringify({ query: { type, name }, fetchedAt: now, sets }, null, 1) + '\n')
}

const online = {
  'live cloudflare.com: DoH proof, same bytes as dnsprovejs, verifies now, plans into legacy transactions': async () => {
    const sets = await quiet(() => P.fetchProof('TXT', 'cloudflare.com'))
    const now = Math.floor(Date.now() / 1000)
    const steps = await P.stepsFromSets(sets)
    assert.deepEqual(steps.map(s => s.label), ['. DNSKEY', 'com. DS', 'com. DNSKEY', 'cloudflare.com. DS', 'cloudflare.com. DNSKEY', 'cloudflare.com. TXT'])
    for (const [i, s] of steps.entries()) assert.equal(hex(s.signed), hex(sets[i].toWire()), `${s.label}: same bytes as SignedSet.toWire()`)
    await verifyChain(steps, now)
    dump('cloudflare.com', 'TXT', steps, now)
    await assert.rejects(plan(steps, { now }), e => e.code === 'NeedsV1')
    const chain = steps.slice(0, 5)
    const p = await plan(chain, { now })
    const entries = await checkPlan(p, chain)
    const high = steps.filter(s => s.kind === 'p256').filter(s => P.p256LowS(s.sig).flipped).length
    // With a synthetic _wallet leaf: the claim-time shape.
    const leaf = await walletLeaf(steps[4], now)
    const withLeaf = await P.stepsFromSets([...chain, leaf].map(s => ({ signed: s.signed, sig: s.sig })))
    const warm = await plan(withLeaf, { now, cache: await cacheWith(withLeaf.slice(0, 3), now) })
    await checkPlan(warm, withLeaf, { fakeSigned: [leaf.signed] })
    say(`     ${shape(p)} (${p.transactions.map(t => t.size).join(', ')} B), ${entries} precompile entries, ${high} high-S normalized; root+TLD cached with a _wallet leaf: ${warm.transactions.map(t => `${t.size} B`).join(', ')}`)
  },
  'live _wallet.gemprotocol.io: a real _wallet TXT (RSA zone), verified and planned': async () => {
    const sets = await quiet(() => P.fetchProof('TXT', '_wallet.gemprotocol.io'))
    const now = Math.floor(Date.now() / 1000)
    const steps = await P.stepsFromSets(sets)
    await verifyChain(steps, now)
    dump('_wallet.gemprotocol.io', 'TXT', steps, now)
    const p = await plan(steps, { now })
    await checkPlan(p, steps)
    assert.deepEqual(P.leafWallets(steps.at(-1), 'gemprotocol.io'), [])
    await assert.rejects(quiet(() => P.fetchWalletProof('gemprotocol.io')), /publishes no Solana address/)
    say(`     ${steps.length} steps, cold plan ${p.transactions.length} transactions (${p.transactions.map(t => t.size).join(', ')} B)`)
  },
  'live ed25519.nl: Ed25519 zone through the ed25519 precompile': async () => {
    const sets = await quiet(() => P.fetchProof('A', 'ed25519.nl'))
    const now = Math.floor(Date.now() / 1000)
    const steps = await P.stepsFromSets(sets)
    await verifyChain(steps, now)
    dump('ed25519.nl', 'A', steps, now)
    const p = await plan(steps, { now })
    await checkPlan(p, steps)
    say(`     ${steps.map(s => s.algorithm).join(',')} algorithms, ${p.transactions.length} transactions`)
  },
  'live: a domain with no _wallet record is refused with a reason': async () => {
    await assert.rejects(quiet(() => P.fetchWalletProof('example.com')), /No DNSSEC-signed _wallet TXT or WALLET record|publishes no Solana address/)
  },
}

let failed = 0
let passed = 0
for (const [name, fn] of Object.entries(tests)) {
  try { await fn(); passed++; say(`ok   ${name}`) } catch (err) { failed++; say(`FAIL ${name}\n     ${err.stack}`) }
}
let reachable = !process.env.OFFLINE
if (reachable) {
  try { await fetch('https://cloudflare-dns.com/dns-query?name=com&type=NS', { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(10_000) }) } catch { reachable = false }
}
let skipped = 0
for (const [name, fn] of Object.entries(online)) {
  if (!reachable) { skipped++; say(`skip ${name} (offline)`); continue }
  try { await fn(); passed++; say(`ok   ${name}`) } catch (err) { failed++; say(`FAIL ${name}\n     ${err.stack}`) }
}
if (process.env.DUMP_DIR) writeFileSync(`${process.env.DUMP_DIR}/finds.json`, JSON.stringify(finds) + '\n')
say(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}`)
process.exit(failed ? 1 : 0)
