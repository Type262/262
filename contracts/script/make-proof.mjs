// Build an ABI-encoded DNSSEC proof (root -> record) the way the app does, for tests and manual claims.
//   node contracts/script/make-proof.mjs TXT _wallet.yoursite.com > proof.hex
// The library logs to stdout; send that to stderr so stdout is only the proof.
console.log = console.info = console.debug = (...a) => console.error(...a)
const { DNSProver } = await import('@ensdomains/dnsprovejs')
const { encodeAbiParameters } = await import('viem')

const [type, name] = process.argv.slice(2)
const prover = DNSProver.create('https://cloudflare-dns.com/dns-query')
const result = await prover.queryWithProof(type, name)
const sets = [...result.proofs, result.answer].map(s => ({
  rrset: '0x' + Buffer.from(s.toWire()).toString('hex'),
  sig: '0x' + Buffer.from(s.signature.data.signature).toString('hex'),
}))
console.error(`${type} ${name}: ${sets.length} signed sets (algorithms ${[...result.proofs, result.answer].map(s => s.signature.data.algorithm).join(',')})`)
process.stdout.write(encodeAbiParameters([{ type: 'tuple[]', components: [{ name: 'rrset', type: 'bytes' }, { name: 'sig', type: 'bytes' }] }], [sets]))
