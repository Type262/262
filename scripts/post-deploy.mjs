// After deploying: check the contracts on-chain and point the app at the escrow.
//   node scripts/post-deploy.mjs
import { readFileSync, writeFileSync } from 'node:fs'

const RPC = 'https://rpc.mainnet.chain.robinhood.com'
const dep = JSON.parse(readFileSync(new URL('../deployments/robinhood-4663.json', import.meta.url), 'utf8'))
const { DNSSECImpl: oracle, DnssecVerifier: verifier, DomainEscrow: escrow, DomainLauncher: launcher } = dep.contracts
const PONS_V2 = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e"

async function rpc(method, params) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  const j = await r.json()
  if (j.error) throw new Error(j.error.message)
  return j.result
}
const addrAt = async (to, selector) => '0x' + (await rpc('eth_call', [{ to, data: selector }, 'latest'])).slice(-40)
const same = (a, b) => a.toLowerCase() === b.toLowerCase()
const fail = msg => { console.error(`x ${msg}`); process.exit(1) }

if (dep.chainId !== 4663) fail(`deployment is for chain ${dep.chainId}, expected 4663`)
if (await rpc('eth_chainId', []) !== '0x1237') fail('RPC is not Robinhood Chain')
for (const [name, addr] of Object.entries(dep.contracts)) {
  if ((await rpc('eth_getCode', [addr, 'latest'])).length <= 2) fail(`${name} has no code at ${addr}`)
}
if (!same(await addrAt(escrow, '0x2b7ac3f3'), verifier)) fail('escrow.verifier() is not the DnssecVerifier')
if (!same(await addrAt(verifier, '0x7dc0d1d0'), oracle)) fail('verifier.oracle() is not the DNSSEC oracle')
if (!same(await addrAt(oracle, '0x8da5cb5b'), '0x0000000000000000000000000000000000000000')) fail('the DNSSEC oracle still has an owner')
if (!launcher) fail("no DomainLauncher in the deployment")
if (!same(await addrAt(launcher, "0xe2fdcc17"), escrow)) fail("launcher.escrow() is not the DomainEscrow")
if (!same(await addrAt(launcher, "0x35d795ae"), PONS_V2)) fail("launcher.pons() is not the pons v2 factory")
if (!same(await addrAt(launcher, "0x9291e541"), await addrAt(PONS_V2, "0xc4b7de97"))) fail("launcher.ponsEscrow() is not pons's fee escrow")
// the oracle can check every algorithm and digest the root, .com and Cloudflare zones use
const ZERO = "0x0000000000000000000000000000000000000000"
const byte = n => n.toString(16).padStart(64, "0")
for (const id of [5, 7, 8, 13]) if (same(await addrAt(oracle, "0xc327deef" + byte(id)), ZERO)) fail(`oracle has no DNSSEC algorithm ${id}`)
for (const id of [1, 2]) if (same(await addrAt(oracle, "0x73cc48a6" + byte(id)), ZERO)) fail(`oracle has no DNSSEC digest ${id}`)
// escrow parameters are what the deploy asked for (all but admin are immutable)
const num = async sel => BigInt(await rpc("eth_call", [{ to: escrow, data: sel }, "latest"]))
const cfg = dep.config || {}
if (cfg.admin && !same(await addrAt(escrow, "0xf851a440"), cfg.admin)) fail("escrow.admin() is not the configured admin")
if (cfg.feeRecipient && !same(await addrAt(escrow, "0x46904840"), cfg.feeRecipient)) fail("escrow.feeRecipient() is not the configured fee recipient")
if (cfg.feeBps != null && (await num("0x24a9d853")) !== BigInt(cfg.feeBps)) fail("escrow.feeBps() is not the configured fee")
if (cfg.refundDelaySeconds != null && (await num("0x3e602b4c")) !== BigInt(cfg.refundDelaySeconds)) fail("escrow.refundDelay() is not the configured delay")
if ((await num("0x60da3e83")) !== 0n) fail("deposits are paused")
console.log(`ok  ${Object.keys(dep.contracts).length} contracts live`)
console.log('ok  escrow -> DnssecVerifier -> DNSSEC oracle, oracle ownership renounced')
console.log('ok  launcher -> pons v2 factory and its fee escrow, fees -> DomainEscrow')
console.log('ok  oracle has algorithms 5, 7, 8, 13 and digests 1, 2; escrow parameters match the deploy')
console.log(`ok  admin ${await addrAt(escrow, '0xf851a440')}, fee ${BigInt(await rpc('eth_call', [{ to: escrow, data: '0x24a9d853' }, 'latest']))} bps`)

writeFileSync(new URL('../assets/config.js', import.meta.url), `// Robinhood Chain mainnet deployment (${dep.deployedAt}, commit ${dep.commit}). See deployments/robinhood-4663.json.
export const ESCROW_ADDRESS = '${escrow}'
export const LAUNCHER_ADDRESS = '${launcher}'
`)
console.log('ok  assets/config.js updated')
console.log(`
Next:
  1. git add assets/config.js deployments && git commit -m "Point the app at the mainnet contracts" && git push
  2. Smoke test (see DEPLOY.md): DNSSEC on, _wallet TXT record, small deposit, Claim.`)
