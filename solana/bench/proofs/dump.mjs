// Fetch a real DNSSEC proof (root -> record) the way the app builds it, and save every signed set
// as a fixture for the Solana benchmark, with a size breakdown per step.
//   node solana/bench/proofs/dump.mjs TXT _wallet.example.com fixtures/example.json
// Uses the pinned dnsprovejs bundle the app ships, so the sets are exactly what a claim would carry.
import { writeFileSync } from 'node:fs'

// The library logs to the console; keep stdout clean and show its trace only with VERBOSE=1.
const say = (...a) => process.stderr.write(a.join(' ') + '\n')
console.log = console.info = console.debug = console.warn = process.env.VERBOSE ? say : () => {}
const { DNSProver } = await import('../../../assets/vendor/dnsprovejs-1.0.1.mjs')

const [type, name, out] = process.argv.slice(2)
const hex = b => Buffer.from(b).toString('hex')

// Ed25519 (15) is not in dnsprovejs' default table; the Solana verifier supports it, so collect it too.
const algorithms = {
  5: { name: 'RSASHA1', f: () => true }, 7: { name: 'RSASHA1NSEC3', f: () => true },
  8: { name: 'RSASHA256', f: () => true }, 13: { name: 'P256SHA256', f: () => true },
  15: { name: 'ED25519', f: () => true },
}
const digests = { 1: { name: 'SHA1', f: () => true }, 2: { name: 'SHA256', f: () => true } }
const base = DNSProver.create('https://cloudflare-dns.com/dns-query')
const prover = new DNSProver(base.sendQuery, digests, algorithms)
const result = await prover.queryWithProof(type, name)
if (!result) throw new Error(`${type} ${name}: no answer`)
const sets = [...result.proofs, result.answer]

function readName(b, o) {
  const labels = []
  for (;;) {
    const n = b[o++]
    if (n === 0) break
    labels.push(Buffer.from(b.subarray(o, o + n)).toString('latin1'))
    o += n
  }
  return { name: labels.length ? labels.join('.') + '.' : '.', end: o, labels: labels.length }
}

const TYPES = { 16: 'TXT', 43: 'DS', 48: 'DNSKEY', 262: 'WALLET' }
function parse(wire) {
  const v = new DataView(wire.buffer, wire.byteOffset, wire.byteLength)
  const sig = {
    typeCovered: v.getUint16(0), algorithm: wire[2], labels: wire[3], ttl: v.getUint32(4),
    expiration: v.getUint32(8), inception: v.getUint32(12), keyTag: v.getUint16(16),
  }
  const signer = readName(wire, 18)
  sig.signer = signer.name
  sig.headerLen = signer.end
  const rrs = []
  for (let o = signer.end; o < wire.length;) {
    const owner = readName(wire, o)
    let p = owner.end
    const rtype = v.getUint16(p), rdlen = v.getUint16(p + 8)
    const rdata = wire.subarray(p + 10, p + 10 + rdlen)
    rrs.push({ owner: owner.name, ownerLabels: owner.labels, type: rtype, rdata, len: p + 10 + rdlen - o })
    o = p + 10 + rdlen
  }
  return { sig, rrs }
}

function keyTag(rdata) {
  let ac = 0
  for (let i = 0; i < rdata.length; i++) ac += i & 1 ? rdata[i] : rdata[i] << 8
  ac += (ac >> 16) & 0xffff
  return ac & 0xffff
}

function keyInfo(rdata) {
  const flags = (rdata[0] << 8) | rdata[1], alg = rdata[3]
  const info = { flags, alg, tag: keyTag(rdata), rdataLen: rdata.length, ksk: (flags & 1) === 1 }
  if (alg === 5 || alg === 7 || alg === 8 || alg === 10) {
    let el = rdata[4], off = 5
    if (el === 0) { el = (rdata[5] << 8) | rdata[6]; off = 7 }
    const mod = rdata.subarray(off + el)
    let bits = mod.length * 8
    for (let i = 0; i < mod.length && mod[i] === 0; i++) bits -= 8
    if (mod.length) bits -= Math.clz32(mod.find(x => x !== 0)) - 24
    info.bits = bits
    info.exponent = hex(rdata.subarray(off, off + el))
  } else if (alg === 13) info.bits = 256
  else if (alg === 15) info.bits = 255
  return info
}

const parsed = sets.map(s => {
  const wire = s.toWire()
  return { set: s, wire, ...parse(wire), sigBytes: s.signature.data.signature }
})

// The DNSKEY that signed each set: the matching tag in the signer's DNSKEY set within this proof.
const keysets = parsed.filter(p => p.sig.typeCovered === 48)
const rows = parsed.map((p, i) => {
  const ks = keysets.find(k => k.rrs[0].owner === p.sig.signer)
  const keyRdata = ks?.rrs.map(r => r.rdata).find(r => keyTag(r) === p.sig.keyTag && r[3] === p.sig.algorithm)
  const key = keyRdata ? keyInfo(keyRdata) : null
  const first = p.rrs[0]
  return {
    step: i,
    owner: first.owner,
    ownerLabels: first.ownerLabels,
    type: TYPES[p.sig.typeCovered] ?? p.sig.typeCovered,
    records: p.rrs.length,
    signer: p.sig.signer,
    algorithm: p.sig.algorithm,
    rrsigLabels: p.sig.labels,
    keyTag: p.sig.keyTag,
    keyBits: key?.bits ?? null,
    keyIsKsk: key?.ksk ?? null,
    keyRdataLen: key?.rdataLen ?? null,
    inception: p.sig.inception,
    expiration: p.sig.expiration,
    rrsigHeaderBytes: p.sig.headerLen,
    rrsetBytes: p.wire.length - p.sig.headerLen,
    signedBytes: p.wire.length,
    sigBytes: p.sigBytes.length,
    dnskeys: p.sig.typeCovered === 48 ? p.rrs.map(r => keyInfo(r.rdata)) : undefined,
    ds: p.sig.typeCovered === 43
      ? p.rrs.map(r => ({ tag: (r.rdata[0] << 8) | r.rdata[1], alg: r.rdata[2], digestType: r.rdata[3] }))
      : undefined,
    txt: p.sig.typeCovered === 16 || p.sig.typeCovered === 262
      ? p.rrs.map(r => {
          const parts = []
          for (let o = 0; o < r.rdata.length;) { const n = r.rdata[o]; parts.push(Buffer.from(r.rdata.subarray(o + 1, o + 1 + n)).toString('latin1')); o += 1 + n }
          return parts
        })
      : undefined,
    rrset: hex(p.wire),
    sig: hex(p.sigBytes),
  }
})

const fetchedAt = Math.floor(Date.now() / 1000)
if (out) writeFileSync(out, JSON.stringify({ query: { type, name }, fetchedAt, sets: rows }, null, 1) + '\n')
say(`${type} ${name}: ${rows.length} signed sets, fetched at ${fetchedAt}`)
for (const r of rows) {
  const keys = r.dnskeys ? ` keys=[${r.dnskeys.map(k => `${k.tag}/${k.alg}/${k.bits}${k.ksk ? 'K' : 'Z'}`).join(' ')}]` : ''
  const ds = r.ds ? ` ds=[${r.ds.map(d => `${d.tag}/${d.alg}/${d.digestType}`).join(' ')}]` : ''
  const txt = r.txt ? ` data=${JSON.stringify(r.txt).slice(0, 120)}` : ''
  say(`  ${r.step} ${r.owner} ${r.type} x${r.records} signer=${r.signer} alg=${r.algorithm} tag=${r.keyTag} key=${r.keyBits}b signed=${r.signedBytes}B (hdr ${r.rrsigHeaderBytes} + rrs ${r.rrsetBytes}) sig=${r.sigBytes}B${keys}${ds}${txt}`)
}
