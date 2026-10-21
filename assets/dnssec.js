// Builds a DNSSEC proof in the browser, from the DNS root down to the domain's _wallet TXT record,
// ABI-encoded for DnssecVerifier. The contract checks every signature on-chain; nothing here is trusted.
import { encodeProof } from './abi.js'

const LIB = './vendor/dnsprovejs-1.0.1.mjs' // pinned copy of @ensdomains/dnsprovejs@1.0.1
const DOH = 'https://cloudflare-dns.com/dns-query'
const hex = bytes => '0x' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')

export async function walletProof(domain) {
  const { DNSProver } = await import(LIB)
  const result = await DNSProver.create(DOH).queryWithProof('TXT', `_wallet.${domain}`)
  if (!result.answer || !result.answer.records.length) throw new Error(`_wallet.${domain} has no TXT record`)
  const sets = [...result.proofs, result.answer].map(s => ({ rrset: hex(s.toWire()), sig: hex(s.signature.data.signature) }))
  return encodeProof(sets)
}
