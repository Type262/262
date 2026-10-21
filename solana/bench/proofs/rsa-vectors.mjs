// Synthetic DNSKEY/RRSIG vectors for sizes and algorithms no real chain in the fixtures uses:
// RSA 1024-4096 (algorithm 8, plus one RSASHA1 for algorithms 5/7) and Ed25519 (algorithm 15).
// Throwaway keys made here and discarded; only public keys and signatures are written.
//   node solana/bench/proofs/rsa-vectors.mjs > solana/bench/fixtures/synthetic.json
import { generateKeyPairSync, sign } from 'node:crypto'

const msg = Buffer.from('benchmark message standing in for RRSIG RDATA plus a canonical RRset '.repeat(3))
const out = []

function rsaKey(publicKey) {
  const jwk = publicKey.export({ format: 'jwk' })
  const e = Buffer.from(jwk.e, 'base64url')
  const n = Buffer.from(jwk.n, 'base64url')
  // RFC 3110: one length byte for exponents up to 255 bytes.
  return Buffer.concat([Buffer.from([1, 0, 3, 8, e.length]), e, n])
}

for (const [bits, exp, hash] of [[1024, 65537, 'sha256'], [2048, 65537, 'sha256'], [2048, 3, 'sha256'], [2048, 65537, 'sha1'], [3072, 65537, 'sha256'], [4096, 65537, 'sha256']]) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: bits, publicExponent: exp })
  const dnskey = rsaKey(publicKey)
  if (hash === 'sha1') dnskey[3] = 5
  out.push({ name: `rsa${bits}-e${exp}-${hash}`, alg: dnskey[3], dnskey: dnskey.toString('hex'), signed: msg.toString('hex'), sig: sign(hash, msg, privateKey).toString('hex') })
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url')
out.push({ name: 'ed25519', alg: 15, dnskey: Buffer.concat([Buffer.from([1, 0, 3, 15]), raw]).toString('hex'), signed: msg.toString('hex'), sig: sign(null, msg, privateKey).toString('hex') })

process.stdout.write(JSON.stringify(out, null, 1) + '\n')
