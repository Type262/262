// End-to-end test of the bundled MCP server (mcp/type262-mcp.mjs), spoken to over stdio.
//   node test/mcp.test.mjs          protocol, live DNS, dry runs, limits, key handling, mock DoH (no transactions)
//   FORK=1 node test/mcp.test.mjs   + real payments on a local anvil fork of Robinhood Chain (needs Foundry;
//                                    npm run test:mcp:fork passes --fork instead, which works on every shell)
import assert from 'node:assert/strict'
import http from 'node:http'
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeFunctionResult, encodeFunctionData, parseAbi } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { encodeWalletRdata } from '../lib/wallet262.js'

const BUNDLE = fileURLToPath(new URL('../mcp/type262-mcp.mjs', import.meta.url))
if (!existsSync(BUNDLE)) { console.error('mcp/type262-mcp.mjs is missing: run npm run mcp:build'); process.exit(1) }
for (const src of ['../mcp/src/server.mjs', '../lib/wallet262.js']) {
  if (statSync(new URL(src, import.meta.url)).mtimeMs > statSync(BUNDLE).mtimeMs) console.error(`warning: ${src.slice(3)} is newer than the bundle; run npm run mcp:build`)
}

const MAINNET_RPC = 'https://rpc.mainnet.chain.robinhood.com'
const ESCROW = '0x9fd2f1Dc0B42e8a2E86e3Cf231a293654691E8d5'
const LAUNCHER = '0x022657aC8bdD969Fa5149E7A86FBBda2AfAf716F' // DomainLauncher: rejects plain ETH transfers
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'
const ZERO = '0x0000000000000000000000000000000000000000'
const DEAD = '0x000000000000000000000000000000000000dEaD'
const FORK = process.env.FORK === '1' || process.argv.includes('--fork')
const tmp = mkdtempSync(join(tmpdir(), 'type262-mcp-'))
const throwaway = () => '0x' + randomBytes(32).toString('hex') // fresh keys, in memory only
// The user's own TYPE262_* settings (a real key above all) never reach the servers under test.
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^TYPE262_/i.test(k)))

let checks = 0
let oneLine = 0
const ok = (cond, msg) => { assert.ok(cond, msg); checks++ }
const servers = []
const sleep = ms => new Promise(r => setTimeout(r, ms))
const until = async (cond, ms = 3000) => { for (const t = Date.now(); !cond() && Date.now() - t < ms;) await sleep(20) }

function server(env = {}) {
  const p = spawn(process.execPath, [BUNDLE], {
    env: { ...baseEnv, TYPE262_SPEND_FILE: join(tmp, 'spend.json'), ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const pending = new Map()
  const stray = []
  let out = '', err = '', buf = '', next = 0
  p.stdout.on('data', d => {
    out += d
    buf += d
    for (let i; (i = buf.indexOf('\n')) >= 0;) {
      const msg = JSON.parse(buf.slice(0, i))
      buf = buf.slice(i + 1)
      const cb = !Array.isArray(msg) && pending.get(msg.id)
      if (cb) { pending.delete(msg.id); cb(msg) } else stray.push(msg)
    }
  })
  p.stderr.on('data', d => (err += d))
  // A server that exits (or is killed) leaves no request hanging.
  p.once('close', () => { for (const [id, cb] of pending) cb({ jsonrpc: '2.0', id, error: { code: -1, message: 'server exited' } }); pending.clear() })
  const request = (method, params, ms = 180_000) => new Promise((resolve, reject) => {
    const id = ++next
    const t = setTimeout(() => reject(new Error(`${method} timed out`)), ms)
    pending.set(id, m => { clearTimeout(t); resolve(m) })
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params && { params }) }) + '\n')
  })
  const call = async (name, args = {}) => {
    const m = await request('tools/call', { name, arguments: args })
    assert.ok(m.result, `${name}: ${JSON.stringify(m.error)}`)
    assert.deepEqual(JSON.parse(m.result.content[0].text), m.result.structuredContent, `${name}: text mirrors structuredContent`)
    const line = m.result.isError ? m.result.structuredContent.error : m.result.structuredContent.summary
    assert.ok(typeof line === 'string' && line.length && !line.includes('\n'), `${name}: a one-line ${m.result.isError ? 'error' : 'summary'}`)
    oneLine++
    return m.result
  }
  const exited = () => new Promise(r => (p.exitCode != null || p.signalCode != null ? r() : p.once('exit', r)))
  const s = {
    request, call, stray,
    lastId: () => next,
    raw: line => p.stdin.write(line + '\n'),
    stop: () => { p.stdin.end(); return exited() },
    kill: () => { p.kill(); return exited() },
    logs: () => out + err,
  }
  servers.push(s)
  return s
}

// Mock DNS-over-HTTPS: /a and /b are two resolvers. addr is what both answer (null: no record), b overrides
// /b's answer, fail makes /b return HTTP 500, nx makes /b say NXDOMAIN, status: 2 is SERVFAIL on both, adB
// overrides /b's AD flag, cname makes the name an alias (the answer carries the target's record, as real
// resolvers send it). Names not listed are NXDOMAIN.
const RECIPIENT = privateKeyToAccount(throwaway()).address
const OTHER = privateKeyToAccount(throwaway()).address
const ZONE = {
  'signed.type262.test': { addr: RECIPIENT, ad: true },
  'unsigned.type262.test': { addr: RECIPIENT, ad: false },
  'split.type262.test': { addr: RECIPIENT, ad: true, b: OTHER },
  'empty.type262.test': {},
  'fail.type262.test': { addr: RECIPIENT, ad: true, fail: true },
  'shop.signed.type262.test': {}, // exists, no record of its own: paid through signed.type262.test
  'api.signed.type262.test': {},
  'hostsplit.type262.test': { addr: RECIPIENT, ad: true },
  'api.hostsplit.type262.test': { addr: null, ad: true, b: OTHER }, // /a: no record, /b: a record
  'platform.type262.test': { addr: RECIPIENT, ad: false },
  'alice.platform.type262.test': {},
  'reject.type262.test': { addr: LAUNCHER, ad: true },
  'halfdown.type262.test': { addr: RECIPIENT, ad: true },
  'api.halfdown.type262.test': { fail: true }, // /a: no record, /b: HTTP 500
  'nxsplit.type262.test': { addr: RECIPIENT, ad: true },
  'api.nxsplit.type262.test': { nx: true }, // /a: no record, /b: NXDOMAIN
  'servfail.type262.test': { addr: RECIPIENT, ad: true },
  'api.servfail.type262.test': { status: 2 }, // SERVFAIL on both, as a DNSSEC-bogus host gets
  'adsplit.type262.test': { addr: RECIPIENT, ad: true, adB: false },
  'alias.type262.test': { cname: 'signed.type262.test' },
}
const doh = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  const name = u.searchParams.get('name')
  const b = u.pathname === '/b'
  const z = ZONE[name] || ZONE[name.replace(/^_wallet\./, '')]
  if (z && z.fail && b) { res.writeHead(500); return res.end() }
  const body = { Status: !z || (z.nx && b) ? 3 : z.status || 0, AD: true }
  const t = z && ZONE[name] && body.Status === 0 && (z.cname ? ZONE[z.cname] : z)
  const addr = t && (b && t.b ? t.b : t.addr)
  if (addr && u.searchParams.get('type') === '262') {
    body.AD = b && 'adB' in t ? t.adB : t.ad
    body.Answer = [
      ...(z.cname ? [{ name, type: 5, TTL: 300, data: z.cname + '.' }] : []),
      { name: z.cname || name, type: 262, TTL: 300, data: encodeWalletRdata('ETH', addr).generic },
    ]
  }
  res.writeHead(200, { 'content-type': 'application/dns-json' })
  res.end(JSON.stringify(body))
}).listen(0, '127.0.0.1')
await new Promise(r => doh.once('listening', r))
const DOH_BASE = `http://127.0.0.1:${doh.address().port}`
const DOH = `${DOH_BASE}/a,${DOH_BASE}/b`

const sc = r => r.structuredContent
const day = new Date().toISOString().slice(0, 10)

try {
  // ---------- protocol ----------
  const s = server()
  const init = await s.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
  ok(init.result.protocolVersion === '2025-03-26' && init.result.serverInfo.name === 'type262' && init.result.capabilities.tools, 'initialize echoes a supported version')
  const init2 = await s.request('initialize', { protocolVersion: '1999-01-01', capabilities: {} })
  ok(init2.result.protocolVersion === '2025-06-18', 'initialize falls back to 2025-06-18')
  s.raw(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))
  s.raw('{not json')
  const ping = await s.request('ping')
  ok(ping.result && Object.keys(ping.result).length === 0, 'ping')
  ok(s.stray.length === 1 && s.stray[0].error.code === -32700, 'notifications get no reply; bad JSON gets -32700')
  s.raw('[]')
  await until(() => s.stray.length >= 2)
  ok(s.stray.length === 2 && !Array.isArray(s.stray[1]) && s.stray[1].error.code === -32600 && s.stray[1].id === null, 'an empty batch gets one -32600 error')
  s.raw(JSON.stringify({ jsonrpc: '2.0', id: null, method: 'ping' }))
  await until(() => s.stray.length >= 3)
  ok(s.stray.length === 3 && s.stray[2].error.code === -32600 && !s.stray[2].result, 'a request with id null is rejected (-32600)')
  ok((await s.request('resources/list')).error.code === -32601, 'unknown method -> -32601')
  ok((await s.request('tools/call', { name: 'nope', arguments: {} })).error.code === -32602, 'unknown tool -> -32602')

  const { tools } = (await s.request('tools/list')).result
  ok(tools.length === 5 && ['resolve_domain', 'verify_payto', 'pay_domain', 'escrow_status', 'wallet_status'].every(n => tools.some(t => t.name === n)), 'tools/list has the 5 tools')
  ok(tools.every(t => t.description.length > 80 && t.inputSchema.type === 'object' && t.inputSchema.additionalProperties === false), 'every tool has a description and a strict object schema')
  const pay = tools.find(t => t.name === 'pay_domain')
  ok(pay.inputSchema.required.join() === 'domain,amount' && pay.inputSchema.properties.asset.enum.join() === 'USDG,ETH' && pay.annotations.destructiveHint, 'pay_domain schema')
  ok(pay.inputSchema.properties.repeat.type === 'boolean' && /10 minutes/.test(pay.inputSchema.properties.repeat.description) && /repeat: true/.test(pay.description), 'pay_domain takes repeat and documents the 10-minute guard')
  ok(/cannot turn it back on/.test(pay.inputSchema.properties.allow_escrow.description), 'allow_escrow is documented as unable to override TYPE262_ALLOW_ESCROW=false')

  // ---------- argument validation ----------
  const ctor = await s.call('pay_domain', { domain: 'example.com', amount: '1', dry_run: true, constructor: null })
  ok(ctor.isError && /Unknown argument constructor/.test(sc(ctor).error), 'an inherited name (constructor) is an unknown argument')
  const ts = await s.call('pay_domain', { domain: 'example.com', amount: '1', dry_run: true, toString: 1 })
  ok(ts.isError && /Unknown argument toString/.test(sc(ts).error), 'toString is an unknown argument, not an internal error')
  const proto = await s.call('resolve_domain', JSON.parse('{"domain":"example.com","__proto__":1}'))
  ok(proto.isError && /Unknown argument __proto__/.test(sc(proto).error), '__proto__ is an unknown argument')
  const nul = await s.call('pay_domain', { domain: 'example.com', amount: '1', dry_run: null })
  ok(nul.isError && /dry_run must be a boolean/.test(sc(nul).error), 'null is a wrong type, so dry_run: null never takes the real-payment path')

  // ---------- live DNS + mainnet reads ----------
  const cf = sc(await s.call('resolve_domain', { domain: 'cloudflare.com' }))
  ok(cf.domain === 'cloudflare.com' && Array.isArray(cf.records) && cf.resolvers.length === 2 && typeof cf.agree === 'boolean' && typeof cf.verified === 'boolean', 'resolve_domain cloudflare.com (live DNS)')
  ok(cf.escrow && cf.escrow.domain === 'cloudflare.com' && cf.escrow.USDG != null && typeof cf.escrow.deposits_paused === 'boolean', 'resolve_domain reports escrow balances')
  ok(cf.resolvers.map(x => x.resolver).join() === 'cloudflare,google', 'default resolvers are named')

  const v1 = sc(await s.call('verify_payto', { target: 'https://api.cloudflare.com/pay', pay_to: DEAD }))
  ok(v1.results.length === 1 && v1.results[0].verdict === 'no_match' && v1.all_safe === false, 'verify_payto: unpublished address -> no_match')
  const body = JSON.stringify({ x402Version: 1, accepts: [{ payTo: DEAD }, { payTo: OTHER }, { payTo: DEAD.toLowerCase() }] })
  const v2 = sc(await s.call('verify_payto', { target: 'cloudflare.com', x402_body: body }))
  ok(v2.results.length === 2 && v2.results.every(x => x.verdict === 'no_match'), 'verify_payto: every payTo in a 402 body, deduplicated')
  ok((await s.call('verify_payto', { target: 'cloudflare.com' })).isError, 'verify_payto needs pay_to or x402_body')

  const es = sc(await s.call('escrow_status', { domain: 'Example.COM' }))
  ok(es.domain === 'example.com' && es.waiting.USDG != null && es.waiting.ETH != null && typeof es.deposits_paused === 'boolean', 'escrow_status normalizes the name')

  const dry = await s.call('pay_domain', { domain: 'example.com', amount: '2', dry_run: true })
  ok(!dry.isError && sc(dry).dry_run && sc(dry).mode === 'escrow' && sc(dry).to === ESCROW && sc(dry).domain === 'example.com', 'pay_domain dry run on a domain with no record -> escrow')
  ok(/DNSSEC-proven owner/.test(sc(dry).note) && sc(dry).steps.some(x => x.startsWith('depositToken')), 'escrow plan explains who can claim')
  ok(/WALLET record \(or _wallet TXT record\)/.test(sc(dry).note) && /minus the 0\.5% claim fee/.test(sc(dry).note) && /refund it in full after 180 days/.test(sc(dry).note), 'escrow note: either record type claims, the 0.5% fee is read from DomainEscrow, refunds are in full')

  // ---------- refusals before anything is sent ----------
  const over = await s.call('pay_domain', { domain: 'example.com', amount: '30', dry_run: true })
  ok(over.isError && /TYPE262_MAX_USDG/.test(sc(over).error), 'over TYPE262_MAX_USDG is refused')
  const overEth = await s.call('pay_domain', { domain: 'example.com', amount: '0.02', asset: 'ETH' })
  ok(overEth.isError && /TYPE262_MAX_ETH/.test(sc(overEth).error), 'over TYPE262_MAX_ETH is refused')
  for (const amount of ['0', '-1', 'abc', '1.0000001', '1e3']) {
    ok((await s.call('pay_domain', { domain: 'example.com', amount, dry_run: true })).isError, `amount "${amount}" is rejected`)
  }
  const typo = await s.call('pay_domain', { domain: 'example.com', amount: '1', dryrun: true })
  ok(typo.isError && /Unknown argument dryrun/.test(sc(typo).error), 'a misspelled flag is rejected, not ignored')
  const nokey = await s.call('pay_domain', { domain: 'example.com', amount: '1' })
  ok(nokey.isError && /TYPE262_PRIVATE_KEY/.test(sc(nokey).error), 'pay_domain without a key is refused')
  const ws0 = await s.call('wallet_status')
  ok(ws0.isError && sc(ws0).configured === false && /TYPE262_PRIVATE_KEY/.test(sc(ws0).how_to_set) && sc(ws0).limits.USDG.daily === '100 USDG', 'wallet_status without a key says how to set it')
  await s.stop()

  writeFileSync(join(tmp, 'spent.json'), JSON.stringify({ [day]: { USDG: '99' } }))
  const sd = server({ TYPE262_SPEND_FILE: join(tmp, 'spent.json') })
  const daily = await sd.call('pay_domain', { domain: 'example.com', amount: '2', dry_run: true })
  ok(daily.isError && /TYPE262_DAILY_USDG/.test(sc(daily).error) && sc(daily).limits.spent_today === '99 USDG', 'daily limit counts what was spent today')
  writeFileSync(join(tmp, 'spent.json'), '{oops')
  ok(/spend log/.test(sc(await sd.call('pay_domain', { domain: 'example.com', amount: '1', dry_run: true })).error), 'a corrupt spend log blocks payments')

  // ---------- the repeat guard reads the spend log, so it survives a restart ----------
  const recent = (ago, extra) => writeFileSync(join(tmp, 'spent.json'), JSON.stringify({
    [day]: { USDG: '2' }, recent: [{ at: new Date(Date.now() - ago).toISOString(), domain: 'example.com', asset: 'USDG', amount: '2', ...extra }],
  }))
  recent(60_000)
  const again = await sd.call('pay_domain', { domain: 'https://Example.com/x', amount: '2.0', dry_run: true })
  ok(again.isError && /identical payment \(2 USDG to example\.com\)/.test(sc(again).error) && /repeat: true/.test(sc(again).error) && sc(again).previous.amount === '2', 'the same domain, asset and amount within 10 minutes is refused')
  ok(!(await sd.call('pay_domain', { domain: 'example.com', amount: '2', dry_run: true, repeat: true })).isError, 'repeat: true lets it through')
  ok(!(await sd.call('pay_domain', { domain: 'example.com', amount: '3', dry_run: true })).isError, 'a different amount is not a repeat')
  ok(!(await sd.call('pay_domain', { domain: 'example.com', amount: '0.002', asset: 'ETH', dry_run: true })).isError, 'a different asset is not a repeat')
  recent(11 * 60_000)
  ok(!(await sd.call('pay_domain', { domain: 'example.com', amount: '2', dry_run: true })).isError, 'after 10 minutes it is not a repeat')
  await sd.stop()

  // ---------- the repeat guard also matches the recipient, under another name or URL ----------
  const sr = server({ TYPE262_DOH: DOH, TYPE262_SPEND_FILE: join(tmp, 'spent.json') })
  writeFileSync(join(tmp, 'spent.json'), JSON.stringify({
    [day]: { USDG: '1' }, recent: [{ at: new Date(Date.now() - 30_000).toISOString(), domain: 'signed.type262.test', asset: 'USDG', amount: '1', to: RECIPIENT.toLowerCase() }],
  }))
  for (const domain of ['api.signed.type262.test', 'https://shop.signed.type262.test/checkout']) {
    const viaName = await sr.call('pay_domain', { domain, amount: '1', dry_run: true })
    ok(viaName.isError && /identical payment \(1 USDG to the same wallet 0x[0-9a-f]{40}, requested as signed\.type262\.test\)/.test(sc(viaName).error) && /repeat: true/.test(sc(viaName).error), `the same amount to the same wallet under another name is a repeat: ${domain}`)
  }
  ok(sc(await sr.call('pay_domain', { domain: 'api.signed.type262.test', amount: '1', dry_run: true, repeat: true })).mode === 'direct', 'repeat: true lets the same recipient through')
  ok(!(await sr.call('pay_domain', { domain: 'api.signed.type262.test', amount: '1.5', dry_run: true })).isError, 'a different amount to the same recipient is not a repeat')
  ok(sc(await sr.call('pay_domain', { domain: 'empty.type262.test', amount: '1', dry_run: true })).mode === 'escrow', 'the same amount to another recipient (escrow) is not a repeat')
  await sr.stop()

  // ---------- decisions, against mock DNS ----------
  const sm = server({ TYPE262_DOH: DOH })
  const direct = sc(await sm.call('pay_domain', { domain: 'signed.type262.test', amount: '1', dry_run: true }))
  ok(direct.mode === 'direct' && direct.to === RECIPIENT && direct.checks.record.dnssec_all_resolvers === true, 'signed record + resolvers agree -> direct')
  const unsigned = sc(await sm.call('pay_domain', { domain: 'unsigned.type262.test', amount: '1', dry_run: true }))
  ok(unsigned.mode === 'escrow' && /not DNSSEC-signed/.test(unsigned.checks.escrow_reason), 'unsigned record -> escrow')
  const split = await sm.call('pay_domain', { domain: 'split.type262.test', amount: '1', dry_run: true })
  ok(split.isError && /disagree/.test(sc(split).error), 'resolvers disagree -> refused, even to escrow')
  const gone = await sm.call('pay_domain', { domain: 'gone.type262.test', amount: '1', dry_run: true })
  ok(gone.isError && /NXDOMAIN/.test(sc(gone).error), 'nonexistent domain -> refused')
  const noEscrow = await sm.call('pay_domain', { domain: 'empty.type262.test', amount: '1', dry_run: true, allow_escrow: false })
  ok(noEscrow.isError && /allow_escrow=false/.test(sc(noEscrow).error), 'allow_escrow=false refuses instead of escrowing')
  const failed = sc(await sm.call('pay_domain', { domain: 'fail.type262.test', amount: '1', dry_run: true }))
  ok(failed.mode === 'escrow' && /doh2 failed/.test(failed.checks.escrow_reason), 'a failed resolver sends even a signed record to escrow')
  const rs = sc(await sm.call('resolve_domain', { domain: 'split.type262.test' }))
  ok(rs.agree === false && rs.pay_domain_would.mode === 'refuse', 'resolve_domain flags disagreement')
  ok(sc(await sm.call('resolve_domain', { domain: 'signed.type262.test' })).verified === true, 'resolve_domain: a signed record every resolver returns is verified')
  const rFail = sc(await sm.call('resolve_domain', { domain: 'fail.type262.test' }))
  ok(rFail.verified === false && rFail.pay_domain_would.mode === 'escrow', 'resolve_domain: not verified when a resolver failed')
  const rAd = sc(await sm.call('resolve_domain', { domain: 'adsplit.type262.test' }))
  ok(rAd.verified === false && rAd.agree === true && rAd.pay_domain_would.mode === 'escrow', 'resolve_domain: not verified when one resolver did not authenticate the record')
  const vFail = sc(await sm.call('verify_payto', { target: 'fail.type262.test', pay_to: RECIPIENT })).results[0]
  ok(vFail.verdict === 'unsigned' && vFail.reason === 'Match, but not every resolver answered', 'verify_payto: no "safe" when a resolver failed')
  const vAd = sc(await sm.call('verify_payto', { target: 'adsplit.type262.test', pay_to: RECIPIENT })).results[0]
  ok(vAd.verdict === 'unsigned' && vAd.reason === 'Match, but not DNSSEC-signed on every resolver', 'verify_payto: no "safe" when one resolver did not authenticate it')
  const adPay = sc(await sm.call('pay_domain', { domain: 'adsplit.type262.test', amount: '1', dry_run: true }))
  ok(adPay.mode === 'escrow' && /not DNSSEC-signed/.test(adPay.checks.escrow_reason), 'pay_domain agrees: escrow when one resolver did not authenticate it')
  const vs = sc(await sm.call('verify_payto', { target: 'https://shop.signed.type262.test/buy', x402_body: { accepts: [{ payTo: RECIPIENT.toLowerCase() }, { payTo: OTHER }] } }))
  ok(vs.results[0].verdict === 'safe' && vs.results[1].verdict === 'no_match' && vs.domain === 'signed.type262.test', 'verify_payto: safe vs no_match')
  ok(sc(await sm.call('verify_payto', { target: 'unsigned.type262.test', pay_to: RECIPIENT })).results[0].verdict === 'unsigned', 'verify_payto: unsigned')

  // ---------- walking up to the parent ----------
  const viaParent = sc(await sm.call('pay_domain', { domain: 'api.signed.type262.test', amount: '1', dry_run: true }))
  ok(viaParent.mode === 'direct' && viaParent.domain === 'signed.type262.test' && viaParent.requested === 'api.signed.type262.test' && viaParent.to === RECIPIENT, 'a host with no record is paid directly through its signed parent')
  const hostSplit = await sm.call('pay_domain', { domain: 'api.hostsplit.type262.test', amount: '1', dry_run: true })
  ok(hostSplit.isError && /disagree/.test(sc(hostSplit).error) && sc(hostSplit).dns.resolved_at === 'api.hostsplit.type262.test', 'resolvers disagreeing about the host -> refused, not paid through the parent')
  const rsHost = sc(await sm.call('resolve_domain', { domain: 'api.hostsplit.type262.test' }))
  ok(rsHost.domain === 'api.hostsplit.type262.test' && rsHost.agree === false && rsHost.pay_domain_would.mode === 'refuse', 'resolve_domain reports the host disagreement')
  ok(sc(await sm.call('verify_payto', { target: 'api.hostsplit.type262.test', pay_to: RECIPIENT })).results[0].verdict === 'no_match', 'verify_payto: no "safe" through the parent when the host lookup disagrees')
  const half = sc(await sm.call('pay_domain', { domain: 'api.halfdown.type262.test', amount: '1', dry_run: true }))
  ok(half.mode === 'escrow' && half.domain === 'api.halfdown.type262.test' && !half.requested && /doh2 failed/.test(half.checks.escrow_reason), 'a resolver failing on the host -> escrow under the host, not paid through the parent')
  const rsHalf = sc(await sm.call('resolve_domain', { domain: 'api.halfdown.type262.test' }))
  ok(rsHalf.domain === 'api.halfdown.type262.test' && rsHalf.resolvers[1].ok === false && rsHalf.pay_domain_would.mode === 'escrow', 'resolve_domain shows the host lookup that failed')
  ok(sc(await sm.call('verify_payto', { target: 'api.halfdown.type262.test', pay_to: RECIPIENT })).results[0].verdict === 'no_match', 'verify_payto: no "safe" through the parent when a resolver failed on the host')
  const nxSplit = await sm.call('pay_domain', { domain: 'api.nxsplit.type262.test', amount: '1', dry_run: true })
  ok(nxSplit.isError && /api\.nxsplit\.type262\.test does not exist \(NXDOMAIN\)/.test(sc(nxSplit).error), 'NXDOMAIN from one resolver -> refused, not paid through the parent')
  const vNx = sc(await sm.call('verify_payto', { target: 'api.nxsplit.type262.test', pay_to: RECIPIENT })).results[0]
  ok(vNx.verdict === 'no_match' && vNx.reason === 'Domain does not exist', 'verify_payto: NXDOMAIN from one resolver -> does not exist')
  const servfail = sc(await sm.call('pay_domain', { domain: 'api.servfail.type262.test', amount: '1', dry_run: true }))
  ok(servfail.mode === 'escrow' && servfail.domain === 'api.servfail.type262.test' && /SERVFAIL/.test(servfail.checks.escrow_reason), 'SERVFAIL on the host -> escrow under the host, not paid through the parent')
  const alias = sc(await sm.call('pay_domain', { domain: 'alias.type262.test', amount: '1', dry_run: true }))
  ok(alias.mode === 'escrow' && alias.domain === 'alias.type262.test' && alias.to === ESCROW, 'a CNAME to a signed name is not paid directly: the target\'s record is not the alias\'s')
  ok(sc(await sm.call('resolve_domain', { domain: 'alias.type262.test' })).records.length === 0, 'resolve_domain: the CNAME target\'s record is not reported as the alias\'s')
  const typoHost = await sm.call('pay_domain', { domain: 'typo.signed.type262.test', amount: '1', dry_run: true })
  ok(typoHost.isError && /typo\.signed\.type262\.test does not exist \(NXDOMAIN\)/.test(sc(typoHost).error), 'an NXDOMAIN host is refused, not paid through its parent')
  const alice = sc(await sm.call('pay_domain', { domain: 'alice.platform.type262.test', amount: '1', dry_run: true }))
  ok(alice.mode === 'escrow' && alice.domain === 'alice.platform.type262.test' && !alice.requested && alice.steps.some(x => x.includes('depositToken("alice.platform.type262.test"')), 'escrow is keyed by the requested name, never the parent')
  ok(/^alice\.platform\.type262\.test publishes no WALLET record and platform\.type262\.test's wallet record is not DNSSEC-signed/.test(alice.checks.escrow_reason) && /Only alice\.platform\.type262\.test's/.test(alice.note), 'the escrow reason names both the host and the parent')
  const rsAlice = sc(await sm.call('resolve_domain', { domain: 'alice.platform.type262.test' }))
  ok(rsAlice.pay_domain_would.mode === 'escrow' && rsAlice.pay_domain_would.domain === 'alice.platform.type262.test' && rsAlice.escrow.domain === 'alice.platform.type262.test', 'resolve_domain shows escrow under the requested name')

  // ---------- ambiguous userinfo ----------
  const amb = await sm.call('pay_domain', { domain: 'good.com@signed.type262.test', amount: '1', dry_run: true })
  ok(amb.isError && /ambiguous/.test(sc(amb).error) && /"signed\.type262\.test"/.test(sc(amb).error), 'good.com@other.com is refused as ambiguous')
  const ambUrl = await sm.call('verify_payto', { target: 'https://good.com@signed.type262.test/pay', pay_to: RECIPIENT })
  ok(ambUrl.isError && /ambiguous/.test(sc(ambUrl).error), 'verify_payto refuses userinfo with a dot too')
  for (const user of ['good\u3002com', 'good\uff0ecom', 'good\uff61com', 'good%2ecom', 'good%2Ecom', 'good%E3%80%82com']) {
    const r = await sm.call('pay_domain', { domain: `https://${user}@signed.type262.test/pay`, amount: '1', dry_run: true })
    ok(r.isError && /ambiguous/.test(sc(r).error), `userinfo with a full stop or an encoded dot is refused: ${user}`)
  }
  ok(sc(await sm.call('pay_domain', { domain: 'bob@signed.type262.test', amount: '1', dry_run: true })).mode === 'direct', 'a plain email still works')

  // ---------- custom resolvers are labelled, never echoed ----------
  const rf = sc(await sm.call('resolve_domain', { domain: 'fail.type262.test' }))
  ok(rf.resolvers.map(x => x.resolver).join() === 'doh1,doh2' && rf.resolvers[1].error === 'doh2: HTTP 500', 'custom resolvers show as doh1, doh2')
  await sm.stop()
  ok(!sm.logs().includes(DOH_BASE), 'DoH URLs appear in no result and no log')

  const lax = server({ TYPE262_DOH: DOH, TYPE262_REQUIRE_DNSSEC: 'false' })
  ok(sc(await lax.call('pay_domain', { domain: 'unsigned.type262.test', amount: '1', dry_run: true })).mode === 'direct', 'TYPE262_REQUIRE_DNSSEC=false pays an unsigned record directly')
  await lax.stop()
  const ceiling = server({ TYPE262_DOH: DOH, TYPE262_ALLOW_ESCROW: 'false' })
  const ce = await ceiling.call('pay_domain', { domain: 'unsigned.type262.test', amount: '1', dry_run: true, allow_escrow: true })
  ok(ce.isError && /TYPE262_ALLOW_ESCROW=false/.test(sc(ce).error), 'allow_escrow: true cannot override TYPE262_ALLOW_ESCROW=false')
  ok(sc(await ceiling.call('pay_domain', { domain: 'signed.type262.test', amount: '1', dry_run: true, allow_escrow: true })).mode === 'direct', 'direct payments still work with escrow off')
  const rce = sc(await ceiling.call('resolve_domain', { domain: 'unsigned.type262.test' }))
  ok(rce.pay_domain_would.mode === 'refuse' && /TYPE262_ALLOW_ESCROW=false/.test(rce.pay_domain_would.reason) && /pay_domain would refuse/.test(rce.summary), 'resolve_domain says pay_domain would refuse when escrow is off on the server')
  ok(sc(await ceiling.call('resolve_domain', { domain: 'signed.type262.test' })).pay_domain_would.mode === 'direct', 'resolve_domain: direct is unaffected by escrow being off')
  await ceiling.stop()
  const one = server({ TYPE262_DOH: `${DOH_BASE}/a` })
  await one.request('ping')
  await one.stop()
  ok(/TYPE262_DOH lists one resolver/.test(one.logs()) && !one.logs().includes(DOH_BASE), 'a single DoH resolver is warned about on stderr')

  // ---------- the key is never echoed ----------
  const key = throwaway()
  const sk = server({ TYPE262_PRIVATE_KEY: key })
  const ws = sc(await sk.call('wallet_status'))
  ok(ws.configured && ws.address === privateKeyToAccount(key).address && ws.balances.USDG === '0' && ws.escrow_enabled === true, 'wallet_status with a key (mainnet read)')
  await sk.stop()
  ok(!sk.logs().toLowerCase().includes(key.slice(2)), 'the key never appears in stdout or stderr')
  const bad = '0x' + 'ab'.repeat(20)
  const sb = server({ TYPE262_PRIVATE_KEY: bad })
  const wb = await sb.call('wallet_status')
  ok(wb.isError && /not a private key/.test(sc(wb).error), 'a malformed key is reported')
  await sb.stop()
  ok(!sb.logs().includes(bad.slice(2)), 'a malformed key is not echoed either')

  ok(oneLine >= 50, `every result carried a one-line summary, or a one-line error (${oneLine} results)`)
  if (FORK) await forkTest()
} finally {
  await Promise.all(servers.map(s => s.stop()))
  doh.close()
  rmSync(tmp, { recursive: true, force: true })
}
console.log(`mcp: ${checks} checks passed${FORK ? ' (with anvil fork)' : ''}`)

// ---------- real payments on a local fork (FORK=1) ----------
async function forkTest() {
  const bin = name => join(homedir(), '.foundry', 'bin', process.platform === 'win32' ? `${name}.exe` : name)
  const LOCAL = 'http://127.0.0.1:8546'
  const FEE_ESCROW = '0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e' // pons fee escrow: holds USDG on mainnet
  const rpc = async (method, params = []) => {
    const j = await (await fetch(LOCAL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()
    if (j.error) throw new Error(`${method}: ${j.error.message}`)
    return j.result
  }
  const abi = parseAbi(['function balanceOf(address) view returns (uint256)', 'function balanceOf(string, address) view returns (uint256)'])
  const view = async (to, args) => {
    const data = encodeFunctionData({ abi, functionName: 'balanceOf', args })
    return decodeFunctionResult({ abi, functionName: 'balanceOf', args, data: await rpc('eth_call', [{ to, data }, 'latest']) })
  }
  const usdgOf = a => view(USDG, [a])
  const ethOf = async a => BigInt(await rpc('eth_getBalance', [a, 'latest']))
  const escrowOf = (d, t) => view(ESCROW, [d, t])
  const fundUsdg = (to, units) => execFileSync(bin('cast'), ['send', USDG, 'transfer(address,uint256)', to, String(units), '--from', FEE_ESCROW, '--unlocked', '--rpc-url', LOCAL], { stdio: 'ignore' })
  const hex = n => '0x' + n.toString(16)

  // An RPC proxy that misbehaves on purpose. lose: forwards eth_sendRawTransaction, then answers with an
  // error (a lost response). gas: answers eth_estimateGas itself (and, like most RPCs, lacks
  // eth_fillTransaction), so a transaction that reverts still gets signed and sent. swap: see below.
  let mode = 'pass', swapHash
  const proxy = http.createServer(async (req, res) => {
    let b = ''
    for await (const c of req) b += c
    const j = JSON.parse(b)
    const one = !Array.isArray(j) && j
    // swap: every receipt lookup is answered with the receipt of swapHash, another transaction.
    if (one && mode === 'swap' && one.method === 'eth_getTransactionReceipt') b = JSON.stringify({ ...one, params: [swapHash] })
    res.writeHead(200, { 'content-type': 'application/json' })
    if (one && mode === 'gas' && one.method === 'eth_estimateGas') return res.end(JSON.stringify({ jsonrpc: '2.0', id: one.id, result: '0x30d40' }))
    if (one && mode === 'gas' && one.method === 'eth_fillTransaction') return res.end(JSON.stringify({ jsonrpc: '2.0', id: one.id, error: { code: -32601, message: 'the method eth_fillTransaction does not exist' } }))
    const t = await (await fetch(LOCAL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: b })).text()
    if (one && mode === 'lose' && one.method === 'eth_sendRawTransaction') return res.end(JSON.stringify({ jsonrpc: '2.0', id: one.id, error: { code: -32000, message: 'request timed out' } }))
    res.end(t)
  }).listen(0, '127.0.0.1')
  await new Promise(r => proxy.once('listening', r))
  const PROXY = `http://127.0.0.1:${proxy.address().port}`

  const anvil = spawn(bin('anvil'), ['--fork-url', MAINNET_RPC, '--hardfork', 'osaka', '--port', '8546', '--silent'], { stdio: 'ignore' })
  try {
    for (let i = 0; ; i++) {
      try { if ((await rpc('eth_chainId')) === '0x1237') break } catch {}
      if (i > 120) throw new Error('anvil did not start')
      await sleep(500)
    }
    // Fresh accounts: anvil's default dev keys are swept by an EIP-7702 delegate on Robinhood mainnet.
    const key = throwaway()
    const agent = privateKeyToAccount(key).address
    const lowKey = throwaway() // 0.001 ETH + 1000 wei: enough for the amount, not for gas
    const low = privateKeyToAccount(lowKey).address
    const dryKey = throwaway() // 1 USDG, no ETH
    const dry = privateKeyToAccount(dryKey).address
    await rpc('anvil_setBalance', [agent, '0xde0b6b3a7640000']) // 1 ETH
    await rpc('anvil_setBalance', [low, hex(10n ** 15n + 1000n)])
    await rpc('anvil_setBalance', [FEE_ESCROW, '0xde0b6b3a7640000'])
    await rpc('anvil_impersonateAccount', [FEE_ESCROW])
    fundUsdg(agent, 10_000_000)
    fundUsdg(dry, 1_000_000)
    await rpc('anvil_stopImpersonatingAccount', [FEE_ESCROW])
    ok((await usdgOf(agent)) === 10_000_000n && (await usdgOf(dry)) === 1_000_000n, 'fork: agents funded with USDG')

    const spend = join(tmp, 'fork-spend.json')
    const env = { TYPE262_RPC: LOCAL, TYPE262_PRIVATE_KEY: key, TYPE262_SPEND_FILE: spend }
    const sa = server(env)
    const ws = sc(await sa.call('wallet_status'))
    ok(ws.address === agent && ws.balances.USDG === '10' && ws.balances.ETH === '1', 'fork: wallet_status')

    const domain = 'example.com' // live DNS: publishes no WALLET record
    const [u0, e0] = await Promise.all([escrowOf(domain, USDG), escrowOf(domain, ZERO)])
    const plan = sc(await sa.call('pay_domain', { domain, amount: '2', dry_run: true }))
    ok(/^about \d/.test(plan.checks.gas) && plan.steps.join() === 'approve 2 USDG to DomainEscrow,depositToken("example.com", USDG, 2)', 'fork: the plan estimates gas for approve + depositToken')
    const p1 = await sa.call('pay_domain', { domain, amount: '2' })
    ok(!p1.isError && sc(p1).sent && sc(p1).mode === 'escrow' && sc(p1).transactions.map(t => t.step).join() === 'approve,depositToken' &&
      sc(p1).transactions.every(t => t.status === 'success' && t.explorer.endsWith(t.hash)), `fork: 2 USDG -> escrow ${JSON.stringify(sc(p1).error || '')}`)
    const p2 = await sa.call('pay_domain', { domain, amount: '0.001', asset: 'ETH' })
    ok(!p2.isError && sc(p2).mode === 'escrow' && sc(p2).transactions.map(t => t.step).join() === 'deposit', `fork: 0.001 ETH -> escrow ${JSON.stringify(sc(p2).error || '')}`)
    ok((await escrowOf(domain, USDG)) - u0 === 2_000_000n && (await escrowOf(domain, ZERO)) - e0 === 10n ** 15n, 'fork: escrow balanceOf rose by exactly 2 USDG and 0.001 ETH')
    const receipt = await rpc('eth_getTransactionReceipt', [sc(p2).transactions[0].hash])
    ok(receipt && receipt.status === '0x1', 'fork: the locally computed hash is the mined transaction')
    const short = await sa.call('pay_domain', { domain, amount: '9' })
    ok(short.isError && /Insufficient USDG/.test(sc(short).error), 'fork: insufficient balance is refused before sending')
    const twice = await sa.call('pay_domain', { domain, amount: '2' })
    ok(twice.isError && /identical payment/.test(sc(twice).error) && sc(twice).error.includes(`/address/${agent}`), 'fork: paying the same again right away is refused, with a link to check the wallet')
    await sa.stop()

    const sb = server({ ...env, TYPE262_DOH: DOH })
    const r0 = await usdgOf(RECIPIENT)
    const p3 = await sb.call('pay_domain', { domain: 'signed.type262.test', amount: '1' })
    ok(!p3.isError && sc(p3).mode === 'direct' && sc(p3).to === RECIPIENT && (await usdgOf(RECIPIENT)) - r0 === 1_000_000n, 'fork: 1 USDG direct to a DNSSEC-signed wallet')
    const p4 = await sb.call('pay_domain', { domain: 'signed.type262.test', amount: '0.0005', asset: 'ETH' })
    ok(!p4.isError && sc(p4).mode === 'direct' && (await ethOf(RECIPIENT)) === 5n * 10n ** 14n, 'fork: 0.0005 ETH direct')
    const r0b = await usdgOf(RECIPIENT)
    const p5 = await sb.call('pay_domain', { domain: 'https://api.signed.type262.test/pay', amount: '1' })
    ok(p5.isError && /to the same wallet/.test(sc(p5).error) && (await usdgOf(RECIPIENT)) === r0b, 'fork: the same payment to the same wallet under another name is refused, nothing sent')
    const ws2 = sc(await sb.call('wallet_status'))
    ok(ws2.limits.USDG.spent_today === '3 USDG' && ws2.limits.ETH.spent_today === '0.0015 ETH', 'fork: today\'s spend is tracked per asset')
    await sb.stop()
    const log = readFileSync(spend, 'utf8')
    const logged = JSON.parse(log)
    ok(logged[day].USDG === '3' && !log.toLowerCase().includes(key.slice(2)) && logged.recent.length === 4 && logged.recent.every(x => Object.keys(x).join() === 'at,domain,asset,amount,to') &&
      logged.recent.map(x => x.to).join() === `escrow:example.com,escrow:example.com,${RECIPIENT.toLowerCase()},${RECIPIENT.toLowerCase()}`, 'fork: spend log holds amounts and the recent payments (with their recipient) only')
    ok(![sa, sb].some(x => x.logs().toLowerCase().includes(key.slice(2))), 'fork: the key never appears in server output')
    ok(!existsSync(spend + '.lock') && !readdirSync(tmp).some(f => f.endsWith('.tmp')), 'fork: the lock file is released and no temp file is left')

    // H1: the RPC loses the eth_sendRawTransaction response, but the transaction went out.
    mode = 'lose'
    const sh = server({ ...env, TYPE262_RPC: PROXY, TYPE262_DOH: DOH, TYPE262_SPEND_FILE: join(tmp, 'lose.json') })
    const r1 = await usdgOf(RECIPIENT)
    const h1 = await sh.call('pay_domain', { domain: 'signed.type262.test', amount: '1' })
    ok(!h1.isError && sc(h1).sent && /request timed out/.test(sc(h1).transactions[0].broadcast_error) && sc(h1).spent_today === '1 USDG', `fork: a lost broadcast response still finds the receipt and counts the spend ${JSON.stringify(sc(h1).error || '')}`)
    ok((await rpc('eth_getTransactionReceipt', [sc(h1).transactions[0].hash])).status === '0x1' && (await usdgOf(RECIPIENT)) - r1 === 1_000_000n, 'fork: the reported hash is the transaction that paid')
    const h2 = await sh.call('pay_domain', { domain: 'signed.type262.test', amount: '1' })
    ok(h2.isError && /repeat: true/.test(sc(h2).error) && (await usdgOf(RECIPIENT)) - r1 === 1_000_000n, 'fork: the retry is refused by the repeat guard, nothing sent')
    const h3 = await sh.call('pay_domain', { domain: 'signed.type262.test', amount: '1', repeat: true })
    ok(!h3.isError && sc(h3).spent_today === '2 USDG' && (await usdgOf(RECIPIENT)) - r1 === 2_000_000n, 'fork: repeat: true pays again on purpose, counted')
    await sh.stop()
    ok(/may still be mined/.test(sh.logs()) && !sh.logs().includes(PROXY), 'fork: the broadcast error is logged, the RPC URL is not')
    mode = 'pass'

    // Nothing moved: a payment that fails before broadcast, or reverts on-chain, is released.
    const rejectSpend = join(tmp, 'reject.json')
    const sr = server({ ...env, TYPE262_DOH: DOH, TYPE262_SPEND_FILE: rejectSpend })
    const nonce0 = await rpc('eth_getTransactionCount', [agent, 'latest'])
    const rj1 = await sr.call('pay_domain', { domain: 'reject.type262.test', amount: '0.0001', asset: 'ETH' })
    ok(rj1.isError && /Payment failed/.test(sc(rj1).error) && (await rpc('eth_getTransactionCount', [agent, 'latest'])) === nonce0, 'fork: a payment that fails before broadcast sends nothing')
    ok(sc(await sr.call('wallet_status')).limits.ETH.spent_today === '0 ETH' && !('recent' in JSON.parse(readFileSync(rejectSpend, 'utf8'))), 'fork: ...and is released from the spend log and the repeat guard')
    await sr.stop()
    mode = 'gas'
    const sg = server({ ...env, TYPE262_RPC: PROXY, TYPE262_DOH: DOH, TYPE262_SPEND_FILE: rejectSpend })
    const rj2 = await sg.call('pay_domain', { domain: 'reject.type262.test', amount: '0.0001', asset: 'ETH' })
    ok(rj2.isError && /send transaction reverted/.test(sc(rj2).error) && sc(rj2).transactions[0].status === 'reverted', `fork: a transaction that reverts on-chain is reported ${JSON.stringify(sc(rj2).error)}`)
    ok((await rpc('eth_getTransactionReceipt', [sc(rj2).transactions[0].hash])).status === '0x0' && sc(await sg.call('wallet_status')).limits.ETH.spent_today === '0 ETH', 'fork: a confirmed revert releases the reserved spend')
    await sg.stop()
    mode = 'pass'

    // Low 2: gas is checked before anything is signed.
    const sl = server({ ...env, TYPE262_PRIVATE_KEY: lowKey, TYPE262_DOH: DOH, TYPE262_SPEND_FILE: join(tmp, 'low.json') })
    const lo = await sl.call('pay_domain', { domain: 'signed.type262.test', amount: '0.001', asset: 'ETH' })
    ok(lo.isError && /Not enough ETH for gas/.test(sc(lo).error) && (await rpc('eth_getTransactionCount', [low, 'latest'])) === '0x0', 'fork: ETH that covers the amount but not the gas is refused up front')
    await sl.stop()
    const sn = server({ ...env, TYPE262_PRIVATE_KEY: dryKey, TYPE262_DOH: DOH, TYPE262_SPEND_FILE: join(tmp, 'noeth.json') })
    const ne = await sn.call('pay_domain', { domain: 'signed.type262.test', amount: '1' })
    ok(ne.isError && /Not enough ETH for gas/.test(sc(ne).error), 'fork: a USDG payment from a wallet with no ETH is refused up front')
    await sn.stop()

    // M3: two server processes share one spend log; the daily limit holds across them.
    const caps = { TYPE262_MAX_ETH: '0.002', TYPE262_DAILY_ETH: '0.003', TYPE262_DOH: DOH }
    for (let round = 0; round < 3; round++) {
      const f = join(tmp, `shared-${round}.json`)
      const a = server({ ...env, ...caps, TYPE262_SPEND_FILE: f })
      const b = server({ ...env, ...caps, TYPE262_SPEND_FILE: f })
      await Promise.all([a.request('ping'), b.request('ping')])
      const before = await ethOf(RECIPIENT)
      const [x, y] = await Promise.all([
        a.call('pay_domain', { domain: 'signed.type262.test', amount: '0.002', asset: 'ETH' }),
        b.call('pay_domain', { domain: 'signed.type262.test', amount: '0.0019', asset: 'ETH' }),
      ])
      const sent = [x, y].filter(z => !z.isError)
      const refused = [x, y].filter(z => z.isError)
      const paid = (await ethOf(RECIPIENT)) - before
      ok(sent.length === 1 && refused.length === 1 && /TYPE262_DAILY_ETH/.test(sc(refused[0]).error) &&
        paid === (sent[0] === x ? 20n : 19n) * 10n ** 14n && JSON.parse(readFileSync(f, 'utf8'))[day].ETH === sc(sent[0]).amount,
      `fork: round ${round}: one of two concurrent processes pays, the other hits the daily limit ${JSON.stringify([x, y].map(z => sc(z).error || sc(z).amount))} paid ${paid}`)
      await Promise.all([a.stop(), b.stop()])
    }

    // A lock left by a crashed process is cleared after 30 s; a live one is waited for.
    const lockSpend = join(tmp, 'locked.json')
    const sx = server({ ...env, TYPE262_DOH: DOH, TYPE262_SPEND_FILE: lockSpend })
    writeFileSync(lockSpend + '.lock', '')
    const old = new Date(Date.now() - 60_000)
    utimesSync(lockSpend + '.lock', old, old)
    const st = await sx.call('pay_domain', { domain: 'signed.type262.test', amount: '0.0001', asset: 'ETH' })
    ok(!st.isError && !existsSync(lockSpend + '.lock'), 'fork: a stale lock file is cleared')
    writeFileSync(lockSpend + '.lock', '') // held by "another process" for 4 s, longer than a payment takes
    let freed = 0
    setTimeout(() => { rmSync(lockSpend + '.lock', { force: true }); freed = Date.now() }, 4000)
    const lw = await sx.call('pay_domain', { domain: 'signed.type262.test', amount: '0.0002', asset: 'ETH' })
    ok(!lw.isError && freed && sc(lw).spent_today === '0.0003 ETH', 'fork: a held lock is waited for, then the payment goes through')
    await sx.stop()

    // Windows refuses to rename over a file another process has open, even only to read it. saveSpend retries:
    // this process holds the log open until the server's temp file shows it is waiting, then lets go.
    const readSpend = join(tmp, 'readers.json')
    writeFileSync(readSpend, '{}\n')
    const sw = server({ ...env, TYPE262_DOH: DOH, TYPE262_SPEND_FILE: readSpend })
    const fd = openSync(readSpend, 'r')
    let answered = false
    const pw = sw.call('pay_domain', { domain: 'signed.type262.test', amount: '0.0007', asset: 'ETH' }).finally(() => { answered = true })
    const renaming = () => readdirSync(tmp).some(f => f.startsWith('readers.json.') && f.endsWith('.tmp'))
    await until(() => answered || renaming(), 30_000)
    const blocked = renaming()
    await sleep(300)
    closeSync(fd)
    const pr = await pw
    await sw.stop()
    ok(!pr.isError && (blocked || process.platform !== 'win32') && JSON.parse(readFileSync(readSpend, 'utf8'))[day].ETH === '0.0007',
      `fork: the spend log is saved after a reader that held it open lets go ${JSON.stringify(sc(pr).error || '')}`)

    // Only a receipt for the exact hash sent counts: the RPC answers with another transaction's receipt.
    mode = 'swap'
    swapHash = sc(p2).transactions[0].hash
    const swapSpend = join(tmp, 'swap.json')
    const sv = server({ ...env, TYPE262_RPC: PROXY, TYPE262_DOH: DOH, TYPE262_SPEND_FILE: swapSpend })
    const sw1 = await sv.call('pay_domain', { domain: 'signed.type262.test', amount: '0.0001', asset: 'ETH' })
    mode = 'pass'
    ok(sw1.isError && /receipt for another transaction/.test(sc(sw1).error) && sc(sw1).transactions[0].hash !== swapHash, `fork: a receipt for another hash is not taken as this payment ${JSON.stringify(sc(sw1).error || sc(sw1).summary)}`)
    const sw2 = await sv.call('pay_domain', { domain: 'signed.type262.test', amount: '0.0001', asset: 'ETH' })
    ok(sw2.isError && /identical payment/.test(sc(sw2).error) && sc(await sv.call('wallet_status')).limits.ETH.spent_today === '0.0001 ETH', 'fork: ...the spend stays counted and the repeat guard holds')
    await sv.stop()

    // With automine off, a payment waits for its receipt, so the next one waits in this process's queue.
    const agentAccount = privateKeyToAccount(key)
    await rpc('evm_setAutomine', [false])
    try {
      // A transaction that replaces this one (same key and nonce) is never reported as this payment.
      const replSpend = join(tmp, 'replace.json')
      const sp = server({ ...env, TYPE262_DOH: DOH, TYPE262_SPEND_FILE: replSpend })
      const u0r = await usdgOf(RECIPIENT)
      const pending = sp.call('pay_domain', { domain: 'signed.type262.test', amount: '0.5' }).catch(e => ({ thrown: e.message }))
      await until(() => /transfer sent: 0x[0-9a-f]{64}/.test(sp.logs()), 60_000)
      const orig = await rpc('eth_getTransactionByHash', [sp.logs().match(/transfer sent: (0x[0-9a-f]{64})/)[1]])
      await sleep(2500) // the receipt wait has seen the pending transaction
      const fees = orig.maxFeePerGas
        ? { type: 'eip1559', maxFeePerGas: BigInt(orig.maxFeePerGas) * 3n, maxPriorityFeePerGas: BigInt(orig.maxPriorityFeePerGas) * 3n + 1n }
        : { type: 'legacy', gasPrice: BigInt(orig.gasPrice) * 3n }
      await rpc('eth_sendRawTransaction', [await agentAccount.signTransaction({ chainId: 4663, nonce: Number(orig.nonce), to: agent, value: 0n, gas: 21000n, ...fees })])
      await rpc('evm_mine')
      const raced = await Promise.race([pending.then(() => 'answered'), sleep(8000).then(() => 'waiting')])
      ok(raced === 'waiting' && (await usdgOf(RECIPIENT)) === u0r && JSON.parse(readFileSync(replSpend, 'utf8'))[day].USDG === '0.5',
        'fork: a replaced transaction is not reported as paid; it keeps waiting for its own receipt, and the spend stays counted')
      await sp.kill()

      // A queued payment the client cancels is never sent.
      const cancelSpend = join(tmp, 'cancel.json')
      const sq = server({ ...env, TYPE262_DOH: DOH, TYPE262_SPEND_FILE: cancelSpend })
      const e0q = await ethOf(RECIPIENT)
      const q1 = sq.call('pay_domain', { domain: 'signed.type262.test', amount: '0.0003', asset: 'ETH' })
      await until(() => /send sent: 0x/.test(sq.logs()), 60_000)
      const q2 = sq.call('pay_domain', { domain: 'signed.type262.test', amount: '0.0004', asset: 'ETH' })
      const q2id = sq.lastId()
      await sleep(1500)
      sq.raw(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: q2id, reason: 'user stopped it' } }))
      await sleep(300)
      await rpc('evm_mine')
      const [c1, c2] = await Promise.all([q1, q2])
      await rpc('evm_mine')
      ok(!c1.isError && c2.isError && sc(c2).error === 'Not sent: the request was cancelled or the client disconnected before the payment started.' &&
        (await ethOf(RECIPIENT)) - e0q === 3n * 10n ** 14n && JSON.parse(readFileSync(cancelSpend, 'utf8'))[day].ETH === '0.0003', 'fork: a queued payment that the client cancelled is not sent')
      await sq.stop()

      // A queued payment is not sent once the client disconnects; the one already broadcast still finishes.
      const closeSpend = join(tmp, 'close.json')
      const sz = server({ ...env, TYPE262_DOH: DOH, TYPE262_SPEND_FILE: closeSpend })
      const e0z = await ethOf(RECIPIENT)
      const z1 = sz.call('pay_domain', { domain: 'signed.type262.test', amount: '0.0005', asset: 'ETH' })
      await until(() => /send sent: 0x/.test(sz.logs()), 60_000)
      const z2 = sz.call('pay_domain', { domain: 'signed.type262.test', amount: '0.0006', asset: 'ETH' })
      await sleep(1500)
      const gone = sz.stop() // stdin closes
      await sleep(300)
      await rpc('evm_mine')
      const [d1, d2] = await Promise.all([z1, z2])
      await gone
      await rpc('evm_mine')
      ok(!d1.isError && d1.structuredContent.sent && d2.isError && /^Not sent: /.test(sc(d2).error) &&
        (await ethOf(RECIPIENT)) - e0z === 5n * 10n ** 14n && JSON.parse(readFileSync(closeSpend, 'utf8'))[day].ETH === '0.0005', 'fork: on disconnect the broadcast payment finishes and the queued one is not sent')
    } finally {
      await rpc('evm_setAutomine', [true])
    }
  } finally {
    anvil.kill()
    proxy.close()
  }
}
