#!/usr/bin/env node
// type262 CLI: resolve, verify, encode and build payment links for DNS WALLET records, and check official token records.
import { resolveWallets, verifyPayTo, zoneLines, paymentUri, addressKind, codeMatchesAddress, resolveTokens, verifyToken, TOKEN_CHAINS, TOKEN_LABEL } from '../lib/wallet262.js'

const SOLANA = { usdc: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }
const ROBINHOOD = { id: 4663, usdg: '0x5fc5360d0400a0fd4f2af552add042d716f1d168' }
const BASE = { id: 8453, usdc: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' } // USDC on Base, 6 decimals
const ASSETS = ['SOL', 'USDC', 'USDG', 'ETH']
// link's chains and their assets. Without a chain, SOL and USDC are paid on Solana, USDG and ETH on Robinhood Chain.
const CHAINS = { solana: ['SOL', 'USDC'], robinhood: ['USDG', 'ETH'], base: ['USDC', 'ETH'] }
// EVM codes that name another chain: Base never pays an address published only under one of them.
const OTHER_CHAINS = ['HOOD', 'USDG', 'ARB', 'OP', 'POL']
const [cmd, ...args] = process.argv.slice(2)

// The EVM record Base pays, picked as the app and the MCP server pick it: the one coded with the asset, then ETH,
// then EVM, then the first other EVM code that names no other chain.
function baseRecord(r, asset) {
  const evm = r.records.filter(x => addressKind(x.address) === 'evm' && codeMatchesAddress(x.code, x.address))
  const rec = [asset, 'ETH', 'EVM'].map(c => evm.find(x => x.code === c)).find(Boolean) || evm.find(x => !OTHER_CHAINS.includes(x.code))
  if (!rec && evm.length) throw new Error(`${r.domain} publishes its EVM wallet only under codes for other chains (${[...new Set(evm.map(x => x.code))].join(', ')}), which Base does not pay`)
  return rec
}

const usage = `type262 <command>

  resolve <domain>                       wallets published by a domain
  verify  <url|domain> <address>         does this payTo belong to the domain?
  encode  <domain> <CODE> <address> [ttl] zone lines to publish
  token   <domain> [token]               official tokens a domain lists, or check one token:
                                         a mint, a contract, or a pump.fun or explorer link
  link    <domain> <amount> [SOL|USDC|USDG|ETH] [solana|robinhood|base]
                                         wallet payment link: SOL (default) or USDC on Solana,
                                         USDG or ETH on Robinhood Chain, USDC or ETH on Base`

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
  if (cmd === 'token' && args[0]) {
    const line = x => `  ${x.code.padEnd(6)} ${x.address}  (${TOKEN_CHAINS[x.code].name}${x.dnssec ? ', signed' : ''})`
    if (args[1]) {
      const v = await verifyToken(args[0], args[1])
      console.log(`${v.verified ? 'OFFICIAL' : v.listed ? 'LISTED (not verified)' : 'NOT LISTED'}: ${v.reason} [${v.domain}${v.code ? ` ${v.code}` : ''}]`)
      if (!v.listed) v.records.forEach(x => console.log(line(x))) // what the domain lists instead
      process.exitCode = v.listed ? 0 : 1
      return
    }
    const r = await resolveTokens(args[0])
    console.log(`${r.domain}  ${r.dnssec ? 'DNSSEC ✓' : 'unsigned'}  ${r.agree ? 'resolvers agree' : 'RESOLVERS DISAGREE'}`)
    if (!r.records.length) console.log(`  no ${TOKEN_LABEL} record`)
    r.records.forEach(x => console.log(line(x)))
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
    const chain = args[3] ? args[3].toLowerCase() : asset === 'SOL' || asset === 'USDC' ? 'solana' : 'robinhood'
    if (!CHAINS[chain]) throw new Error(`unknown chain ${args[3]}: use ${Object.keys(CHAINS).join(', ')}`)
    if (!CHAINS[chain].includes(asset)) throw new Error(`${asset} is not paid on ${chain}: use ${CHAINS[chain].join(' or ')}`)
    const solana = chain === 'solana'
    const r = await resolveWallets(args[0])
    const rec = chain === 'base' ? baseRecord(r, asset) : r.records.find(x => addressKind(x.address) === (solana ? 'solana' : 'evm'))
    if (!rec) throw new Error(`${r.domain} publishes no ${solana ? 'Solana' : 'EVM'} wallet`)
    console.log(solana
      ? paymentUri(rec.address, { amount: args[1], splToken: asset === 'USDC' ? SOLANA.usdc : undefined })
      : chain === 'base'
        ? paymentUri(rec.address, { amount: args[1], chainId: BASE.id, token: asset === 'USDC' ? BASE.usdc : undefined, decimals: asset === 'USDC' ? 6 : 18 })
        : paymentUri(rec.address, { amount: args[1], chainId: ROBINHOOD.id, token: asset === 'USDG' ? ROBINHOOD.usdg : undefined, decimals: asset === 'USDG' ? 6 : 18 }))
    if (!r.verified) console.error('warning: record is not DNSSEC-verified by every resolver')
    return
  }
  console.log(usage)
}

main().catch(e => { console.error(`error: ${e.message}`); process.exitCode = 1 })
