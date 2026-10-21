#!/usr/bin/env node
// type262 CLI: resolve, verify, encode and build payment links for DNS WALLET records.
import { resolveWallets, verifyPayTo, zoneLines, paymentUri, addressKind } from '../lib/wallet262.js'

const SOLANA = { usdc: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }
const ROBINHOOD = { id: 4663, usdg: '0x5fc5360d0400a0fd4f2af552add042d716f1d168' }
const ASSETS = ['SOL', 'USDC', 'USDG', 'ETH']
const [cmd, ...args] = process.argv.slice(2)

const usage = `type262 <command>

  resolve <domain>                       wallets published by a domain
  verify  <url|domain> <address>         does this payTo belong to the domain?
  encode  <domain> <CODE> <address> [ttl] zone lines to publish
  link    <domain> <amount> [SOL|USDC|USDG|ETH]
                                         wallet payment link: SOL (default) or USDC on Solana,
                                         USDG or ETH on Robinhood Chain`

async function main() {
  if (cmd === 'resolve' && args[0]) {
    const r = await resolveWallets(args[0])
    console.log(`${r.domain}  ${r.dnssec ? 'DNSSEC ✓' : 'unsigned'}  ${r.agree ? 'resolvers agree' : 'RESOLVERS DISAGREE'}`)
    if (!r.records.length) console.log('  no WALLET record')
    for (const x of r.records) console.log(`  ${x.code.padEnd(6)} ${x.address}  (${x.source}${x.dnssec ? ', signed' : ''})`)
    return
  }
  if (cmd === 'verify' && args[1]) {
    const v = await verifyPayTo(args[0], args[1])
    console.log(`${v.strong ? 'MATCH' : v.ok ? 'MATCH (not verified)' : 'NO MATCH'}: ${v.reason} [${v.resolvedAt}]`)
    process.exitCode = v.ok ? 0 : 1
    return
  }
  if (cmd === 'encode' && args[2]) {
    const z = zoneLines(args[0], [{ code: args[1], address: args[2] }], Number(args[3]) || 3600)
    console.log([...z.generic, ...z.named, ...z.txt].join('\n'))
    return
  }
  if (cmd === 'link' && args[1]) {
    const asset = (args[2] || 'SOL').toUpperCase()
    if (!ASSETS.includes(asset)) throw new Error(`unknown asset ${args[2]}: use ${ASSETS.join(', ')}`)
    const solana = asset === 'SOL' || asset === 'USDC'
    const r = await resolveWallets(args[0])
    const rec = r.records.find(x => addressKind(x.address) === (solana ? 'solana' : 'evm'))
    if (!rec) throw new Error(`${r.domain} publishes no ${solana ? 'Solana' : 'EVM'} wallet`)
    console.log(solana
      ? paymentUri(rec.address, { amount: args[1], splToken: asset === 'USDC' ? SOLANA.usdc : undefined })
      : paymentUri(rec.address, { amount: args[1], chainId: ROBINHOOD.id, token: asset === 'USDG' ? ROBINHOOD.usdg : undefined, decimals: asset === 'USDG' ? 6 : 18 }))
    if (!r.verified) console.error('warning: record is not DNSSEC-verified by every resolver')
    return
  }
  console.log(usage)
}

main().catch(e => { console.error(`error: ${e.message}`); process.exitCode = 1 })
