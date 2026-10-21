#!/usr/bin/env node
// TYPE/262 MCP server: AI agents resolve, verify and pay domains by name on Robinhood Chain.
// MCP over stdio: newline-delimited JSON-RPC 2.0. stdout carries protocol messages only; logs go to stderr.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { createPublicClient, createWalletClient, encodeFunctionData, http, keccak256, parseAbi } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  resolveWalletsUp, verifyPayTo, payTosFromX402, addressKind, codeMatchesAddress, normalizeDomain, parseUnits, sameAddress,
} from '../../lib/wallet262.js'

const VERSION = '0.1.0'
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05']
const MAINNET_RPC = 'https://rpc.mainnet.chain.robinhood.com'
const EXPLORER = 'https://robinhoodchain.blockscout.com'
const ESCROW = '0x9fd2f1Dc0B42e8a2E86e3Cf231a293654691E8d5'
const ZERO = '0x0000000000000000000000000000000000000000'
const ASSETS = {
  USDG: { symbol: 'USDG', decimals: 6, token: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' },
  ETH: { symbol: 'ETH', decimals: 18, token: null },
}

// Route stray console output from dependencies to stderr so it can never corrupt the protocol stream.
console.log = console.info = console.debug = console.warn = (...a) => console.error(...a)

// ---------- config ----------

const env = process.env
const flag = (v, dflt) => (v == null || v.trim() === '' ? dflt : !/^(0|false|no|off)$/i.test(v.trim()))
const RPC = env.TYPE262_RPC || MAINNET_RPC
const REQUIRE_DNSSEC = flag(env.TYPE262_REQUIRE_DNSSEC, true)
const ALLOW_ESCROW = flag(env.TYPE262_ALLOW_ESCROW, true)
const SPEND_FILE = env.TYPE262_SPEND_FILE || join(homedir(), '.type262', 'agent-spend.json')
const LIMITS = {
  USDG: { max: env.TYPE262_MAX_USDG || '25', daily: env.TYPE262_DAILY_USDG || '100' },
  ETH: { max: env.TYPE262_MAX_ETH || '0.01', daily: env.TYPE262_DAILY_ETH || '0.05' },
}
// Optional DNS-over-HTTPS JSON endpoints (comma-separated). Default: Cloudflare + Google.
const DOH = env.TYPE262_DOH ? env.TYPE262_DOH.split(',').map(s => s.trim()).filter(Boolean) : null
for (const u of DOH || []) {
  if (!/^https:\/\//i.test(u) && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/i.test(u)) {
    process.stderr.write(`[type262] TYPE262_DOH entries must be https:// (or http:// on loopback)\n`)
    process.exit(1)
  }
}

// Read the key once and drop it from the environment. It is never logged, echoed or written anywhere.
const SECRETS = []
const KEY = (() => {
  const raw = (env.TYPE262_PRIVATE_KEY || '').trim()
  delete env.TYPE262_PRIVATE_KEY
  if (!raw) return {}
  if (raw.length >= 8) SECRETS.push(raw.replace(/^0x/i, ''))
  const hex = /^0x/i.test(raw) ? '0x' + raw.slice(2) : '0x' + raw
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) return { error: 'TYPE262_PRIVATE_KEY is set but is not a private key (expected 0x followed by 64 hex characters).' }
  try { return { account: privateKeyToAccount(hex) } } catch { return { error: 'TYPE262_PRIVATE_KEY is not a valid secp256k1 private key.' } }
})()
if (env.TYPE262_RPC) SECRETS.push(env.TYPE262_RPC) // custom RPC URLs often embed an API key
if (DOH) SECRETS.push(...DOH) // so can custom DoH URLs

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const scrub = s => SECRETS.reduce((out, x) => out.replace(new RegExp(escapeRe(x), 'gi'), '[redacted]'), String(s))
const log = (...a) => process.stderr.write(`[type262] ${scrub(a.join(' '))}\n`)

if (DOH && DOH.length < 2) log('TYPE262_DOH lists one resolver, so DNS answers are not cross-checked. List at least two.')

const HOW_TO_SET_KEY = 'Set TYPE262_PRIVATE_KEY (0x + 64 hex characters) in this MCP server\'s environment, for example the "env" block of the type262 entry in your MCP client config, then restart the client. Use a dedicated hot wallet that holds only what the agent may spend. Never paste a private key into the chat.'

class ToolError extends Error {
  constructor(message, data) { super(message); this.data = data }
}

const keyProblem = () => `${KEY.error || 'No agent wallet configured.'} ${HOW_TO_SET_KEY}`

function requireKey() {
  if (!KEY.account) throw new ToolError(keyProblem(), { configured: false, how_to_set: HOW_TO_SET_KEY })
  return KEY.account
}

// ---------- chain ----------

const chain = {
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
  blockExplorers: { default: { name: 'Blockscout', url: EXPLORER } },
}
const transport = http(RPC, { timeout: 20_000 })
const pub = createPublicClient({ chain, transport })
const wallet = KEY.account ? createWalletClient({ account: KEY.account, chain, transport }) : null

const ESCROW_ABI = parseAbi([
  'function deposit(string domain) payable',
  'function depositToken(string domain, address token, uint256 amount)',
  'function balanceOf(string domain, address token) view returns (uint256)',
  'function depositsPaused() view returns (bool)',
  'function refundDelay() view returns (uint64)',
  'function feeBps() view returns (uint16)',
])
const ERC20_ABI = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
])

const read = (address, abi, functionName, args) => pub.readContract({ address, abi, functionName, args })

// Refuse to touch a misconfigured RPC that serves another chain.
let chainChecked
function onChain() {
  chainChecked ??= pub.getChainId().then(id => {
    if (id !== chain.id) throw new ToolError(`TYPE262_RPC serves chain ${id}, not Robinhood Chain (${chain.id}).`)
  })
  return chainChecked.catch(e => { chainChecked = undefined; throw e })
}

/** Exact decimal string for base units. */
function fmt(units, decimals) {
  const s = units.toString().padStart(decimals + 1, '0')
  const frac = s.slice(-decimals).replace(/0+$/, '')
  return frac ? `${s.slice(0, -decimals)}.${frac}` : s.slice(0, -decimals)
}
const show = (units, asset) => `${fmt(units, asset.decimals)} ${asset.symbol}`

function amountUnits(amount, asset) {
  let units
  try { units = parseUnits(String(amount), asset.decimals) } catch (e) {
    throw new ToolError(`amount must be a positive decimal string like "2.5" (${e.message}; ${asset.symbol} has ${asset.decimals} decimals).`)
  }
  if (units <= 0n) throw new ToolError('amount must be greater than zero.')
  return units
}

// "good.com@other.com" is the host other.com with "good.com" as URL userinfo. Refuse it rather than act on
// a name the caller may not have meant. A plain email ("bob@example.com") is fine. The ideographic,
// fullwidth and halfwidth full stops read as dots too, and so does %2e.
const DOT = /[.\u3002\uff0e\uff61]|%2e/i
function hostInput(input) {
  const raw = String(input).trim()
  const authority = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0]
  const at = authority.lastIndexOf('@')
  const user = at > 0 ? authority.slice(0, at) : ''
  let decoded = user
  try { decoded = decodeURIComponent(user) } catch {}
  if (at > 0 && (DOT.test(user) || DOT.test(decoded))) {
    let host = ''
    try { host = normalizeDomain(raw) } catch {}
    throw new ToolError(`"${raw}" is ambiguous: the part before the @ looks like a domain, but only ${host || 'the part after it'} would be used. Pass the domain you mean on its own${host ? `, e.g. "${host}"` : ''}.`)
  }
  return raw
}

// DomainEscrow keys pools by the exact string and accepts only lowercase a-z 0-9 - _ labels of 1-63 characters.
function canonical(input) {
  const d = normalizeDomain(hostInput(input))
  if (d.length > 253 || !d.split('.').every(l => /^[a-z0-9_-]{1,63}$/.test(l))) throw new ToolError(`${d} is not a name DomainEscrow accepts.`)
  return d
}

async function escrowState(domain) {
  await onChain()
  const [usdg, eth, paused] = await Promise.all([
    read(ESCROW, ESCROW_ABI, 'balanceOf', [domain, ASSETS.USDG.token]),
    read(ESCROW, ESCROW_ABI, 'balanceOf', [domain, ZERO]),
    read(ESCROW, ESCROW_ABI, 'depositsPaused'),
  ])
  return { USDG: fmt(usdg, 6), ETH: fmt(eth, 18), deposits_paused: paused }
}

// ---------- DNS ----------

const timedFetch = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(10_000) })
// Custom resolvers go to the SDK as doh1, doh2, ... so results and errors name the label, never the URL.
const DOH_NAMES = DOH && DOH.map((_, i) => `doh${i + 1}`)
const dohFetch = DOH ? (url, init) => timedFetch(url.replace(/^doh(\d+)\?/, (_, i) => `${DOH[i - 1]}?`), init) : timedFetch

/** DoH options for the SDK. memo reuses answers within one tool call (verify_payto checks several addresses). */
function dnsOpts(memo) {
  const opts = DOH ? { resolvers: DOH_NAMES } : {}
  if (!memo) return { ...opts, fetch: dohFetch }
  const cache = new Map()
  opts.fetch = (url, init) => {
    if (!cache.has(url)) {
      cache.set(url, dohFetch(url, init).then(async r => {
        const body = r.ok ? await r.json() : null
        return { ok: r.ok, status: r.status, json: async () => body }
      }))
    }
    return cache.get(url)
  }
  return opts
}

const evmRecords = r => r.records.filter(x => addressKind(x.address) === 'evm' && codeMatchesAddress(x.code, x.address))
const unpayable = a => [ZERO, ESCROW, ASSETS.USDG.token].some(x => sameAddress(a, x))

// Direct payment needs every resolver to answer and agree, and (unless TYPE262_REQUIRE_DNSSEC=false)
// every resolver to DNSSEC-authenticate the record. Anything short of that goes to escrow, which only
// pays out against an on-chain DNSSEC proof. r may be the parent's answer (api.example.com -> example.com);
// the SDK only walks up when every resolver answered the host's own lookup with NOERROR and no record.
function decide(r, asset) {
  const d = decideAt(r, asset)
  return d.why && r.requested ? { ...d, why: `${r.requested} publishes no WALLET record and ${d.why}` } : d
}

function decideAt(r, asset) {
  if (r.nxdomain) return { refuse: `${r.domain} does not exist (NXDOMAIN). Check the spelling.` }
  if (!r.agree) return { refuse: `DNS resolvers disagree about ${r.resolvedAt}'s wallets, a sign of tampering. Not paying.` }
  const evm = evmRecords(r)
  const record = evm.find(x => x.code === asset.symbol) || evm[0] || null
  if (record && unpayable(record.address)) return { refuse: `${r.resolvedAt} publishes ${record.address}, which cannot receive payments.` }
  // A resolver that failed, or answered with an error such as SERVFAIL (what a DNSSEC-bogus zone gets).
  const failed = r.resolvers.filter(x => !x.ok || (x.status !== 0 && x.status !== 3))
    .map(x => (x.ok ? `${x.resolver} returned ${x.status === 2 ? 'SERVFAIL' : `DNS status ${x.status}`}` : `${x.resolver} failed`))
  const signed = !!record && r.resolvers.every(x => x.ok && x.records.some(y => y.dnssec && y.code === record.code && sameAddress(y.address, record.address)))
  if (record && !failed.length && (signed || !REQUIRE_DNSSEC)) return { mode: 'direct', record, signed }
  const why = failed.length
    ? `not every DNS resolver answered (${failed.join(', ')}), so ${r.resolvedAt}'s record could not be cross-checked`
    : !record
      ? r.records.length
        ? `${r.resolvedAt} publishes no EVM wallet (only ${[...new Set(r.records.map(x => x.code))].join(', ')})`
        : `${r.resolvedAt} publishes no WALLET record`
      : `${r.resolvedAt}'s wallet record is not DNSSEC-signed`
  return { mode: 'escrow', record, why }
}

const recordOut = x => ({ code: x.code, address: x.address, source: x.source, dnssec: x.dnssec })

// ---------- spend limits ----------

const today = () => new Date().toISOString().slice(0, 10) // UTC day
const isDay = k => /^\d{4}-\d{2}-\d{2}$/.test(k)
const REPEAT_MS = 10 * 60_000

/**
 * { "2026-10-21": { "USDG": "2", "ETH": "0.001" },
 *   "recent": [{ "at": "2026-10-21T09:30:00.000Z", "domain": "example.com", "asset": "USDG", "amount": "2", "to": "escrow:example.com" }] }
 * Daily totals, plus the payments of the last 10 minutes for the repeat check. "to" is the recipient: the
 * wallet address paid directly, or "escrow:<name>". No keys, no hashes.
 */
function loadSpend() {
  if (!existsSync(SPEND_FILE)) return {}
  try {
    const j = JSON.parse(readFileSync(SPEND_FILE, 'utf8'))
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('not an object')
    return j
  } catch {
    throw new ToolError(`Cannot read the spend log at ${SPEND_FILE}. Fix or remove it; payments stay blocked until then.`)
  }
}

function spentOn(logData, day, asset) {
  const v = logData[day] && logData[day][asset.symbol]
  if (!v) return 0n
  try { return parseUnits(v, asset.decimals) } catch { throw new ToolError(`The spend log at ${SPEND_FILE} is corrupt. Fix or remove it.`) }
}

function addSpend(data, asset, units, day) {
  const next = spentOn(data, day, asset) + units
  data[day] = { ...data[day], [asset.symbol]: fmt(next > 0n ? next : 0n, asset.decimals) }
}

const recentOf = data => (Array.isArray(data.recent) ? data.recent : [])
  .filter(x => x && typeof x.at === 'string' && Date.now() - Date.parse(x.at) < REPEAT_MS)
// The same asset and amount to the same name, or to the same recipient under another name or URL
// (api.example.com and example.com can both pay example.com's wallet).
const sameAttempt = (a, b) => a.asset === b.asset && a.amount === b.amount && (a.domain === b.domain || (!!a.to && a.to === b.to))
const recipientOf = (d, domain) => (d.mode === 'direct' ? d.record.address.toLowerCase() : `escrow:${domain}`)

function saveSpend(data) {
  for (const d of Object.keys(data).filter(isDay).sort().slice(0, -30)) delete data[d] // keep 30 days
  data.recent = recentOf(data)
  if (!data.recent.length) delete data.recent
  mkdirSync(dirname(SPEND_FILE), { recursive: true })
  const tmp = `${SPEND_FILE}.${process.pid}.tmp` // per process: several servers may share one log
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
  // On Windows the rename fails while another process has the log open, even only to read it: retry briefly.
  for (let i = 0; ; i++) {
    try { renameSync(tmp, SPEND_FILE); break } catch (e) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(e.code) || i >= 80) throw e
      pause(25)
    }
  }
}

// Every server process sharing the spend log (one per MCP client) holds this lock file around its
// read-check-write, so two processes can't both spend the same daily allowance. fn must be synchronous.
// A lock older than 30 s was left by a crashed process and is cleared.
const LOCK_FILE = SPEND_FILE + '.lock'
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

function withSpendLock(fn) {
  mkdirSync(dirname(SPEND_FILE), { recursive: true })
  for (let i = 0; ; i++) {
    let code
    try { closeSync(openSync(LOCK_FILE, 'wx')); break } catch (e) { code = e.code }
    if (!['EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(code)) throw new ToolError(`Cannot lock the spend log (${LOCK_FILE}): ${code}.`)
    try { if (Date.now() - statSync(LOCK_FILE).mtimeMs > 30_000) { unlinkSync(LOCK_FILE); continue } } catch {}
    if (i >= 400) throw new ToolError(`The spend log is locked by another process (${LOCK_FILE}, ${code}). Try again in a moment.`)
    pause(25)
  }
  try { return fn() } finally { try { unlinkSync(LOCK_FILE) } catch {} }
}

// A retry after a lost or timed-out result must not pay twice: the same asset and amount to the same name,
// or to the same recipient, within 10 minutes needs repeat: true. The entry lives in the spend log, so it
// survives a restart.
function checkRepeat(attempt, data) {
  const prev = recentOf(data).find(x => sameAttempt(x, attempt))
  if (!prev) return
  const s = Math.max(0, Math.round((Date.now() - Date.parse(prev.at)) / 1000))
  const ago = s < 90 ? `${s} seconds` : `${Math.round(s / 60)} minutes`
  const where = KEY.account ? `${EXPLORER}/address/${KEY.account.address}` : 'the agent wallet on the explorer'
  const to = prev.domain === attempt.domain ? attempt.domain
    : `the same ${String(prev.to).startsWith('escrow:') ? 'escrow name' : `wallet ${prev.to}`}, requested as ${prev.domain}`
  throw new ToolError(`Refused: an identical payment (${attempt.amount} ${attempt.asset} to ${to}) was submitted ${ago} ago. If its result was lost or timed out, check ${where} before paying again. To make the same payment again on purpose, call pay_domain with repeat: true.`, { previous: prev })
}

function limitsOf(asset) {
  const parse = (v, name) => {
    try { return parseUnits(v, asset.decimals) } catch { throw new ToolError(`${name} must be a decimal amount, got "${v}".`) }
  }
  const s = asset.symbol
  return { max: parse(LIMITS[s].max, `TYPE262_MAX_${s}`), daily: parse(LIMITS[s].daily, `TYPE262_DAILY_${s}`) }
}

function limitView(asset, data = loadSpend()) {
  const { max, daily } = limitsOf(asset)
  const spent = spentOn(data, today(), asset)
  return {
    per_payment: show(max, asset), daily: show(daily, asset),
    spent_today: show(spent, asset), remaining_today: show(daily > spent ? daily - spent : 0n, asset),
  }
}

function checkLimits(asset, units, data = loadSpend()) {
  const { max, daily } = limitsOf(asset)
  const spent = spentOn(data, today(), asset)
  const s = asset.symbol
  const view = limitView(asset, data)
  if (units > max) {
    throw new ToolError(`Refused: ${show(units, asset)} is above the per-payment limit of ${show(max, asset)} (TYPE262_MAX_${s}, set in the server's environment).`, { limits: view })
  }
  if (spent + units > daily) {
    throw new ToolError(`Refused: ${show(units, asset)} would bring today's spend (UTC) to ${show(spent + units, asset)}, above the daily limit of ${show(daily, asset)} (TYPE262_DAILY_${s}). Spent today: ${show(spent, asset)}.`, { limits: view })
  }
  return view
}

// One payment at a time in this process. Other processes sharing the spend log run their own payments;
// the lock file keeps the daily limit and the repeat guard across them.
let queue = Promise.resolve()
const serial = fn => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run }

// ---------- tools ----------

async function resolveDomain({ domain }) {
  const requested = canonical(domain)
  const r = await resolveWalletsUp(requested, dnsOpts())
  const d = decide(r, ASSETS.USDG)
  // Escrow is keyed by the name asked for, even when its parent publishes the record.
  const escrow = { domain: requested, ...await escrowState(requested).catch(e => ({ error: clean(e) })) }
  const wouldPay = d.refuse ? { mode: 'refuse', reason: d.refuse }
    : d.mode === 'direct' ? { mode: 'direct', domain: r.resolvedAt, to: d.record.address, code: d.record.code, dnssec: d.signed }
    : !ALLOW_ESCROW ? { mode: 'refuse', reason: `${d.why}, and escrow is off on this server (TYPE262_ALLOW_ESCROW=false)` }
    : { mode: 'escrow', domain: requested, reason: d.why }
  const recs = r.records.length
    ? r.records.map(x => `${x.code} ${x.address}${x.dnssec ? '' : ' (unsigned)'}`).join(', ')
    : 'no WALLET record'
  const waiting = escrow.error ? 'Escrow balance unavailable.' : `Escrow holds ${escrow.USDG} USDG and ${escrow.ETH} ETH for ${requested}.`
  return {
    domain: r.resolvedAt,
    ...(r.requested && { requested: r.requested }),
    records: r.records.map(x => ({ ...recordOut(x), kind: addressKind(x.address) })),
    ...(r.invalid.length && { invalid: r.invalid }),
    nxdomain: r.nxdomain,
    dnssec: r.dnssec,
    agree: r.agree,
    verified: r.verified,
    resolvers: r.resolvers.map(x => ({ resolver: x.resolver, ok: x.ok, signed: !!x.signed, records: x.records.length, ...(x.error && { error: x.error }) })),
    pay_domain_would: wouldPay,
    escrow,
    summary: `${r.resolvedAt}: ${recs}. ${r.agree ? 'Resolvers agree' : 'RESOLVERS DISAGREE'}, ${r.dnssec ? 'DNSSEC-signed' : 'not DNSSEC-signed'}. pay_domain would ${wouldPay.mode === 'refuse' ? 'refuse' : wouldPay.mode === 'direct' ? `pay ${wouldPay.to} directly` : 'deposit into escrow'}. ${waiting}`,
  }
}

async function verifyPayto({ target, pay_to, x402_body }) {
  const list = pay_to ? [pay_to] : []
  if (x402_body != null && x402_body !== '') {
    let found
    try { found = payTosFromX402(x402_body) } catch { throw new ToolError('x402_body is not valid JSON.') }
    if (!found.length) throw new ToolError('x402_body holds no payTo (expected accepts[].payTo).')
    list.push(...found)
  }
  if (!list.length) throw new ToolError('Pass pay_to (one address) or x402_body (a 402 response body).')
  const unique = list.filter((a, i) => list.findIndex(b => sameAddress(a, b)) === i)
  const opts = dnsOpts(true)
  const host = hostInput(target)
  const checks = await Promise.all(unique.map(a => verifyPayTo(host, a, opts)))
  const results = checks.map((v, i) => ({
    pay_to: unique[i],
    verdict: v.strong ? 'safe' : v.ok ? 'unsigned' : 'no_match',
    reason: v.reason,
    ...(v.match && { record: recordOut(v.match) }),
  }))
  const safe = results.filter(x => x.verdict === 'safe').length
  return {
    target,
    domain: checks[0].resolvedAt,
    dnssec: checks[0].dnssec,
    agree: checks[0].agree,
    all_safe: safe === results.length,
    results,
    summary: `${safe} of ${results.length} address${results.length === 1 ? '' : 'es'} safe to pay for ${checks[0].resolvedAt}. ` +
      results.map(x => `${x.pay_to}: ${x.verdict} (${x.reason})`).join('; '),
  }
}

// The transactions a payment sends, in order. moves marks the one that moves the money.
function paymentTxs(d, asset, units, domain, allowance) {
  if (d.mode === 'direct') {
    return [asset.token
      ? { step: 'transfer', moves: true, request: { to: asset.token, data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [d.record.address, units] }) } }
      : { step: 'send', moves: true, request: { to: d.record.address, value: units } }]
  }
  if (!asset.token) return [{ step: 'deposit', moves: true, request: { to: ESCROW, value: units, data: encodeFunctionData({ abi: ESCROW_ABI, functionName: 'deposit', args: [domain] }) } }]
  return [
    ...(allowance < units ? [{ step: 'approve', moves: false, request: { to: asset.token, data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [ESCROW, units] }) } }] : []),
    { step: 'depositToken', moves: true, request: { to: ESCROW, data: encodeFunctionData({ abi: ESCROW_ABI, functionName: 'depositToken', args: [domain, asset.token, units] }) } },
  ]
}

// Gas for those transactions at the current price, plus 20%. depositToken can't be estimated before its
// approve lands, so it counts as twice the approve. null when the node can't estimate; sending re-estimates.
async function gasCost(from, txs) {
  try {
    const price = await pub.getGasPrice()
    let total = 0n, last = 0n
    for (const t of txs) {
      last = await pub.estimateGas({ account: from, ...t.request }).catch(e => { if (t.step === 'depositToken' && last) return last * 2n; throw e })
      total += last
    }
    return total * price * 6n / 5n
  } catch { return null }
}

async function payDomain(args, id) {
  const asset = ASSETS[String(args.asset || 'USDG').toUpperCase()]
  if (!asset) throw new ToolError('asset must be "USDG" or "ETH".')
  const units = amountUnits(args.amount, asset)
  const requested = canonical(args.domain)
  const dryRun = args.dry_run === true
  const repeat = args.repeat === true
  // TYPE262_ALLOW_ESCROW=false is a ceiling: a call can turn escrow off, never back on.
  const allowEscrow = ALLOW_ESCROW && args.allow_escrow !== false
  const attempt = { domain: requested, asset: asset.symbol, amount: fmt(units, asset.decimals) }
  const spend = loadSpend()
  const limits = checkLimits(asset, units, spend) // before any network call
  if (!repeat) checkRepeat(attempt, spend)
  const account = dryRun ? KEY.account || null : requireKey()

  let r
  try { r = await resolveWalletsUp(requested, dnsOpts()) } catch (e) { throw new ToolError(`DNS lookup failed, not paying: ${e.message}`) }
  const d = decide(r, asset)
  const dns = { resolved_at: r.resolvedAt, agree: r.agree, dnssec: r.dnssec, records: r.records.map(recordOut) }
  if (d.refuse) throw new ToolError(d.refuse, { dns })
  if (d.mode === 'escrow' && !allowEscrow) {
    const off = ALLOW_ESCROW ? 'escrow is off for this call (allow_escrow=false)' : 'escrow is off on this server (TYPE262_ALLOW_ESCROW=false)'
    throw new ToolError(`Not paying: ${d.why}, and ${off}. Direct payment needs a DNSSEC-signed EVM wallet record that every resolver agrees on.`, { dns })
  }
  await onChain()

  // A direct payment goes to the wallet of the name that publishes it, which may be the parent
  // (api.example.com -> example.com). Escrow is always keyed by the name asked for, so only its owner can claim.
  const domain = d.mode === 'direct' ? canonical(r.resolvedAt) : requested
  attempt.to = recipientOf(d, domain)
  if (!repeat) checkRepeat(attempt, spend) // again, now that the recipient is known
  const plan = {
    mode: d.mode,
    domain,
    ...(domain !== requested && { requested }),
    asset: asset.symbol,
    amount: attempt.amount,
    from: account ? account.address : null,
    to: d.mode === 'direct' ? d.record.address : ESCROW,
    chain: { id: chain.id, name: chain.name },
    steps: [],
    checks: { dns, require_dnssec: REQUIRE_DNSSEC, limits },
  }

  let refundDays, feeBps
  if (d.mode === 'direct') {
    plan.checks.record = { ...recordOut(d.record), dnssec_all_resolvers: d.signed }
    plan.steps.push(asset.token ? `transfer ${plan.amount} USDG to ${d.record.address}` : `send ${plan.amount} ETH to ${d.record.address}`)
  } else {
    const [paused, delay, fee] = await Promise.all(['depositsPaused', 'refundDelay', 'feeBps'].map(f => read(ESCROW, ESCROW_ABI, f)))
    if (paused) throw new ToolError('DomainEscrow deposits are paused right now (claims and refunds still work). Not paying.', { dns })
    refundDays = Math.round(Number(delay) / 86400)
    feeBps = BigInt(fee)
    plan.checks.escrow_reason = d.why
    plan.checks.deposits_paused = false
  }

  if (account) {
    const [eth, tok, allowance] = await Promise.all([
      pub.getBalance({ address: account.address }),
      asset.token ? read(asset.token, ERC20_ABI, 'balanceOf', [account.address]) : null,
      d.mode === 'escrow' && asset.token ? read(asset.token, ERC20_ABI, 'allowance', [account.address, ESCROW]) : 0n,
    ])
    const have = asset.token ? tok : eth
    plan.checks.balance = { [asset.symbol]: fmt(have, asset.decimals), ...(asset.token && { ETH: fmt(eth, 18) }) }
    if (have < units) throw new ToolError(`Insufficient ${asset.symbol}: the agent wallet holds ${show(have, asset)} and this payment needs ${show(units, asset)}.`, { plan })
    const gas = await gasCost(account.address, paymentTxs(d, asset, units, domain, allowance))
    if (gas != null) plan.checks.gas = `about ${show(gas, ASSETS.ETH)}`
    if (eth < (asset.token ? 0n : units) + (gas ?? 1n)) {
      throw new ToolError(`Not enough ETH for gas: the agent wallet holds ${show(eth, ASSETS.ETH)}, and this payment needs ${asset.token ? '' : `${plan.amount} ETH plus `}${gas == null ? 'some ETH' : `about ${show(gas, ASSETS.ETH)}`} for gas.`, { plan })
    }
    if (d.mode === 'escrow' && asset.token && allowance < units) plan.steps.push(`approve ${plan.amount} USDG to DomainEscrow`)
  } else if (d.mode === 'escrow' && asset.token) {
    plan.steps.push(`approve ${plan.amount} USDG to DomainEscrow (if the allowance is short)`)
  }
  if (d.mode === 'escrow') plan.steps.push(asset.token ? `depositToken("${domain}", USDG, ${plan.amount})` : `deposit("${domain}") with ${plan.amount} ETH`)

  const escrowNote = d.mode === 'escrow'
    ? `Only ${domain}'s DNSSEC-proven owner can claim it: they publish a DNSSEC-signed WALLET record (or _wallet TXT record) with an EVM address and claim on-chain${feeBps ? `, which pays out the deposit minus the ${fmt(feeBps, 2)}% claim fee` : ''}. If nobody claims, this wallet can refund it in full after ${refundDays} days.`
    : null
  if (escrowNote) plan.note = escrowNote

  if (dryRun) {
    const what = d.mode === 'direct'
      ? `Would pay ${show(units, asset)} directly to ${domain}'s wallet ${d.record.address}${d.signed ? ' (DNSSEC-verified, resolvers agree).' : ' (unsigned; TYPE262_REQUIRE_DNSSEC is off).'}`
      : `Would deposit ${show(units, asset)} into DomainEscrow for ${domain}, because ${d.why}. ${escrowNote}`
    const keyNote = account ? '' : 'No agent wallet is configured (TYPE262_PRIVATE_KEY), so a real payment would be refused; wallet_status explains how to set one.'
    return { dry_run: true, ...plan, summary: ['Dry run, nothing sent.', what, keyNote].filter(Boolean).join(' ') }
  }

  return serial(async () => {
    // A request the client cancelled, or that was still queued when the client went away, is never sent.
    if (stopped(id)) throw new ToolError(NOT_SENT)
    const day = today()
    const entry = { at: new Date().toISOString(), ...attempt }
    // Check and reserve under the lock every server process shares. The reservation is released below
    // only if nothing that moves money can have been broadcast, or it reverted.
    withSpendLock(() => {
      const data = loadSpend()
      checkLimits(asset, units, data)
      if (!repeat) checkRepeat(attempt, data)
      addSpend(data, asset, units, day)
      data.recent = [...recentOf(data), entry]
      saveSpend(data)
    })
    const release = () => withSpendLock(() => {
      const data = loadSpend()
      addSpend(data, asset, -units, day)
      data.recent = recentOf(data).filter(x => !(x.at === entry.at && sameAttempt(x, entry)))
      saveSpend(data)
    })
    const txs = []
    let keep = false
    // Sign locally and take the hash before broadcasting, so an RPC error or a lost response can't hide
    // a transaction that was in fact sent.
    const send = async ({ step, request, moves }) => {
      if (!txs.length && stopped(id)) throw new ToolError(NOT_SENT) // nothing broadcast yet, so it is released
      const prepared = await wallet.prepareTransactionRequest(request) // fails here: nothing was broadcast
      const serializedTransaction = await wallet.signTransaction(prepared)
      const hash = keccak256(serializedTransaction)
      const tx = { step, hash, explorer: `${EXPLORER}/tx/${hash}`, status: 'pending' }
      txs.push(tx)
      if (moves) keep = true // the outcome is unknown from here until a receipt says otherwise
      try {
        await pub.sendRawTransaction({ serializedTransaction })
        log(`${step} sent: ${hash}`)
      } catch (e) {
        tx.broadcast_error = e && e.details ? scrub(e.details) : clean(e) // details: the RPC's own message
        log(`${step} ${hash}: the RPC returned an error on broadcast; it may still be mined: ${tx.broadcast_error}`)
      }
      // Only a receipt for this exact hash counts. checkReplacement: false, so a transaction that replaced
      // this one (same key and nonce) is never reported as this payment.
      const counted = moves ? ' The amount stays counted in today\'s spend, and repeating this exact payment needs repeat: true.' : ''
      let receipt
      try {
        receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000, pollingInterval: 1_500, checkReplacement: false })
      } catch {
        throw new ToolError(`${step} transaction ${hash} is not confirmed after 2 minutes${tx.broadcast_error ? ' (the RPC returned an error when it was broadcast)' : ''}. It may still be mined: check ${tx.explorer} before trying again.${counted}`, { transactions: txs })
      }
      if (String(receipt.transactionHash).toLowerCase() !== hash.toLowerCase()) {
        throw new ToolError(`${step} transaction ${hash}: the RPC returned a receipt for another transaction (${receipt.transactionHash}), so the outcome is unknown. Check ${tx.explorer} before trying again.${counted}`, { transactions: txs })
      }
      tx.status = receipt.status === 'success' ? 'success' : 'reverted'
      tx.block = Number(receipt.blockNumber)
      if (tx.status !== 'success') {
        if (moves) keep = false // confirmed on-chain that nothing moved
        throw new ToolError(`${step} transaction reverted: ${tx.explorer}`, { transactions: txs })
      }
      return receipt
    }
    try {
      const allowance = d.mode === 'escrow' && asset.token ? await read(asset.token, ERC20_ABI, 'allowance', [account.address, ESCROW]) : 0n
      for (const t of paymentTxs(d, asset, units, domain, allowance)) await send(t)
    } catch (e) {
      if (!keep) try { release() } catch (x) { log('could not release reserved spend:', x.message) }
      if (e instanceof ToolError) throw e
      const data = txs.length ? { transactions: txs } : undefined
      if (keep) throw new ToolError(`Payment result unknown: ${clean(e)}. Check the transactions before trying again.`, data)
      throw new ToolError(`Payment failed: ${clean(e)}`, data)
    }
    const last = txs[txs.length - 1]
    const { checks, steps, ...rest } = plan
    return {
      sent: true,
      ...rest,
      transactions: txs,
      explorer: last.explorer,
      spent_today: limitView(asset).spent_today,
      summary: d.mode === 'direct'
        ? `Paid ${show(units, asset)} to ${domain}'s wallet ${d.record.address} on Robinhood Chain. ${last.explorer}`
        : `Deposited ${show(units, asset)} into DomainEscrow for ${domain} (${d.why}). ${escrowNote} ${last.explorer}`,
    }
  })
}

async function escrowStatus({ domain }) {
  const name = canonical(domain)
  const s = await escrowState(name)
  return {
    domain: name,
    escrow: ESCROW,
    waiting: { USDG: s.USDG, ETH: s.ETH },
    deposits_paused: s.deposits_paused,
    summary: `${s.USDG} USDG and ${s.ETH} ETH wait in escrow for ${name}. Deposits are ${s.deposits_paused ? 'paused (claims and refunds still work)' : 'open'}.`,
  }
}

async function walletStatus() {
  const limits = { USDG: limitView(ASSETS.USDG), ETH: limitView(ASSETS.ETH) }
  if (!KEY.account) throw new ToolError(keyProblem(), { configured: false, how_to_set: HOW_TO_SET_KEY, limits })
  await onChain()
  const address = KEY.account.address
  const [eth, usdg] = await Promise.all([pub.getBalance({ address }), read(ASSETS.USDG.token, ERC20_ABI, 'balanceOf', [address])])
  return {
    configured: true,
    address,
    explorer: `${EXPLORER}/address/${address}`,
    chain: { id: chain.id, name: chain.name },
    rpc: env.TYPE262_RPC ? 'custom (TYPE262_RPC)' : MAINNET_RPC,
    balances: { USDG: fmt(usdg, 6), ETH: fmt(eth, 18) },
    limits,
    require_dnssec: REQUIRE_DNSSEC,
    escrow_enabled: ALLOW_ESCROW,
    spend_log: SPEND_FILE,
    summary: `Agent wallet ${address} holds ${fmt(usdg, 6)} USDG and ${fmt(eth, 18)} ETH on Robinhood Chain. Spent today (UTC): ${limits.USDG.spent_today} of ${limits.USDG.daily}, ${limits.ETH.spent_today} of ${limits.ETH.daily}.`,
  }
}

const DOMAIN_PROP = { type: 'string', description: 'Domain name, URL or email, e.g. "example.com", "https://api.example.com/pay" or "bob@example.com". Only the host is used. Input with a dot before the @ ("good.com@other.com") is refused as ambiguous.' }

const TOOLS = [
  {
    name: 'resolve_domain',
    title: 'Resolve a domain\'s wallets',
    description: 'Look up the crypto wallets a domain publishes in DNS (the WALLET record, RRTYPE 262, or its _wallet TXT fallback), cross-checked across two DNS-over-HTTPS resolvers. Returns each record (coin code, address, source, whether DNSSEC authenticated it), whether the resolvers agree, whether the result is verified (records found, every resolver answered and agrees, every record DNSSEC-authenticated on every resolver), what pay_domain would do on this server (pay directly, deposit into escrow, or refuse), and how much USDG and ETH already waits for the domain in DomainEscrow on Robinhood Chain. If every resolver answers that the host exists and has no record, its parent is checked (api.example.com -> example.com), unless the parent is a co.uk-style suffix or on the built-in list of shared hosting domains (github.io, vercel.app, netlify.app, pages.dev, ...). Read-only.',
    inputSchema: { type: 'object', properties: { domain: DOMAIN_PROP }, required: ['domain'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: resolveDomain,
  },
  {
    name: 'verify_payto',
    title: 'Verify a payTo address',
    description: 'Check that a payment address really belongs to the website asking for it before paying, e.g. the payTo of an x402 / HTTP 402 Payment Required response. Pass the URL, email or domain you are dealing with as target, plus one address (pay_to) or the whole 402 response body (x402_body), whose every payTo is checked. Each address gets a verdict: "safe" (published by the domain, every resolver answered and agrees, and every resolver returned it DNSSEC-signed), "unsigned" (published and the resolvers that answered agree, but not DNSSEC-verified on every resolver: the zone is unsigned, a resolver failed, or a resolver did not authenticate it, so the answer could be spoofed), or "no_match" (the domain does not exist, publishes no record or not this address, or resolvers disagree), with a reason. Only pay "safe" addresses without asking the user first. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'The site you are paying: URL, email or domain, e.g. "https://api.example.com/data".' },
        pay_to: { type: 'string', description: 'One address to check, e.g. "0x7a1f...c0de".' },
        x402_body: { type: 'string', description: 'The JSON body of an HTTP 402 response (x402). Every accepts[].payTo in it is checked.' },
      },
      required: ['target'],
      additionalProperties: false,
    },
    loose: { x402_body: 'object' },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: verifyPayto,
  },
  {
    name: 'pay_domain',
    title: 'Pay a domain by name',
    description: 'Pay a domain by name in USDG or ETH on Robinhood Chain (chain 4663) from the agent wallet. The domain\'s wallet is looked up in DNS. If it publishes an EVM wallet record that is DNSSEC-signed and every resolver agrees, the money goes straight to that address. A host with no record of its own may be paid through its parent\'s record (api.example.com -> example.com). Otherwise (no record, or an unsigned one) it is deposited into DomainEscrow under the exact name given, where only the owner who proves that name with DNSSEC can claim it (a claim pays out the deposit minus a 0.5% fee); this wallet can refund it in full if nobody claims within the refund delay (180 days). Never pays when resolvers disagree or the domain does not exist. Per-payment and daily spend limits set by the server operator apply. An identical payment (same asset and amount to the same domain, or to the same recipient wallet or escrow name under another name or URL) within 10 minutes is refused unless repeat: true, so retrying after a lost or timed-out result cannot pay twice. Call with dry_run: true first to see the plan (mode direct or escrow, recipient, checks) without sending anything. Real payments are irreversible: only pay when the user asked for this payment.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: DOMAIN_PROP,
        amount: { type: 'string', pattern: '^[0-9]*\\.?[0-9]+$', description: 'Decimal amount in whole units of the asset, e.g. "2.5" USDG or "0.001" ETH. Not base units.' },
        asset: { type: 'string', enum: ['USDG', 'ETH'], default: 'USDG', description: 'USDG (stablecoin, 6 decimals) or ETH. Default USDG.' },
        allow_escrow: { type: 'boolean', description: `Deposit into escrow when the domain has no DNSSEC-verified wallet (default true). false refuses such payments instead. The operator's TYPE262_ALLOW_ESCROW=false turns escrow off for every call, and this argument cannot turn it back on.${ALLOW_ESCROW ? '' : ' Escrow is off on this server.'}` },
        dry_run: { type: 'boolean', default: false, description: 'true: return the plan and checks without sending anything.' },
        repeat: { type: 'boolean', default: false, description: 'true: pay even though an identical payment (same asset and amount to the same domain or the same recipient) was submitted in the last 10 minutes. Without it that payment is refused. Check the earlier payment first.' },
      },
      required: ['domain', 'amount'],
      additionalProperties: false,
    },
    loose: { amount: 'number' },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    run: payDomain,
  },
  {
    name: 'escrow_status',
    title: 'Escrow balance for a domain',
    description: 'How much USDG and ETH waits in DomainEscrow on Robinhood Chain for a domain, and whether new deposits are paused. Funds wait there until the domain\'s owner claims them with a DNSSEC proof of the wallet it publishes. Read-only.',
    inputSchema: { type: 'object', properties: { domain: DOMAIN_PROP }, required: ['domain'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: escrowStatus,
  },
  {
    name: 'wallet_status',
    title: 'Agent wallet status',
    description: 'The agent wallet\'s address, its ETH and USDG balances on Robinhood Chain, what it has spent today (UTC) and the spend limits. Needs TYPE262_PRIVATE_KEY in the server\'s environment; without it, the result explains how to set it. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: walletStatus,
  },
]

const TYPES = { string: v => typeof v === 'string', boolean: v => typeof v === 'boolean', number: v => typeof v === 'number' && Number.isFinite(v), object: v => !!v && typeof v === 'object' }

// Strict on purpose: a misspelled flag such as "dryrun" must fail rather than be ignored.
function validate(tool, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new ToolError('arguments must be an object.')
  const props = tool.inputSchema.properties
  const unknown = Object.keys(args).filter(k => !Object.hasOwn(props, k))
  if (unknown.length) throw new ToolError(`Unknown argument${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')}. ${tool.name} takes: ${Object.keys(props).join(', ') || 'no arguments'}.`)
  for (const k of tool.inputSchema.required || []) {
    if (args[k] == null || args[k] === '') throw new ToolError(`Missing required argument: ${k}.`)
  }
  for (const [k, v] of Object.entries(args)) {
    const ok = v !== null && (TYPES[props[k].type](v) || (tool.loose && tool.loose[k] && TYPES[tool.loose[k]](v))) // null is a wrong type, not "unset"
    if (!ok) throw new ToolError(`${k} must be a ${props[k].type}.`)
  }
}

const clean = e => scrub((e && (e.shortMessage || e.message)) || String(e))

async function callTool(tool, args, id) {
  try {
    validate(tool, args)
    const out = JSON.parse(scrub(JSON.stringify(await tool.run(args, id))))
    return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: out }
  } catch (e) {
    const error = (e instanceof ToolError ? scrub(e.message) : clean(e)).replace(/\s*\n\s*/g, ' ') // always one line
    const out = { error, ...(e.data && JSON.parse(scrub(JSON.stringify(e.data)))) }
    log(`${tool.name}: ${error}`)
    return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: out, isError: true }
  }
}

// ---------- JSON-RPC over stdio ----------

const INSTRUCTIONS = 'TYPE/262 turns domains into wallets on Robinhood Chain. resolve_domain shows what a domain publishes; verify_payto checks an x402 payTo before you pay it; pay_domain pays a domain by name in USDG or ETH (call it with dry_run: true first). Payments are real and irreversible: only pay when the user asked for it. If a payment result is lost or times out, check the transaction before paying again; an identical payment within 10 minutes needs repeat: true.'

const ok = (id, result) => ({ jsonrpc: '2.0', id, result })
const err = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } })

// tools/call requests in flight, the ones among them the client cancelled, and whether stdin has closed.
const active = new Set()
const cancelled = new Set()
let closing = false
const stopped = id => closing || cancelled.has(id)
const NOT_SENT = 'Not sent: the request was cancelled or the client disconnected before the payment started.'

async function handle(msg) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return err(msg && msg.id != null ? msg.id : null, -32600, 'Invalid Request')
  if (typeof msg.method !== 'string') return // a response; this server never sends requests
  if (!('id' in msg)) { // notification (initialized, cancelled, ...): never answered
    const rid = msg.params && msg.params.requestId
    if (msg.method === 'notifications/cancelled' && active.has(rid)) cancelled.add(rid)
    return
  }
  const { id, method } = msg
  if (typeof id !== 'string' && typeof id !== 'number') return err(null, -32600, 'Invalid Request: id must be a string or a number')
  const params = msg.params || {}
  switch (method) {
    case 'initialize':
      return ok(id, {
        protocolVersion: PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'type262', title: 'TYPE/262', version: VERSION },
        instructions: INSTRUCTIONS,
      })
    case 'ping':
      return ok(id, {})
    case 'tools/list':
      return ok(id, { tools: TOOLS.map(({ run, loose, ...t }) => t) })
    case 'tools/call': {
      const tool = TOOLS.find(t => t.name === params.name)
      if (!tool) return err(id, -32602, `Unknown tool: ${params.name}`)
      active.add(id)
      try { return ok(id, await callTool(tool, params.arguments == null ? {} : params.arguments, id)) } finally { active.delete(id); cancelled.delete(id) }
    }
    default:
      return err(id, -32601, `Method not found: ${method}`)
  }
}

const write = msg => { if (msg) process.stdout.write(JSON.stringify(msg) + '\n') }
process.stdout.on('error', () => process.exit(0)) // client went away

async function dispatch(line) {
  let msg
  try { msg = JSON.parse(line) } catch { return write(err(null, -32700, 'Parse error')) }
  const safe = m => handle(m).catch(e => { log('internal error:', clean(e)); return m && m.id != null ? err(m.id, -32603, 'Internal error') : undefined })
  if (!Array.isArray(msg)) return write(await safe(msg))
  if (!msg.length) return write(err(null, -32600, 'Invalid Request'))
  const out = (await Promise.all(msg.map(safe))).filter(Boolean)
  if (out.length) write(out)
}

const inflight = new Set()
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', line => {
  if (!line.trim()) return
  const p = dispatch(line).finally(() => inflight.delete(p))
  inflight.add(p)
})
// stdin closed: payments not started yet are refused; finish what is in flight (a payment may be waiting
// for its receipt), flush, exit.
rl.on('close', async () => {
  closing = true
  await Promise.allSettled([...inflight])
  process.stdout.write('', () => process.exit(0))
})
process.on('unhandledRejection', e => log('unhandled:', clean(e)))

log(`MCP server ${VERSION} on Robinhood Chain (${chain.id}); wallet ${KEY.account ? KEY.account.address : KEY.error ? 'misconfigured' : 'not configured'}; RPC ${env.TYPE262_RPC ? 'custom' : 'default'}`)
