// Fund many domains at once on Solana: a pasted list of domains (or a package.json) in, a plan out, then the fewest
// legacy transactions that carry it. A domain that publishes one DNSSEC-signed Solana wallet, the same on Cloudflare
// and Google, is paid there directly; every other domain is paid into its vault (solana-vault.js), with the board's
// reference and its own deposit memo, exactly as a single deposit is, so its owner claims it with one DNS record and
// the sender can take it back after 180 days. solana-fund.js is the screen; test/solana-batch.test.mjs checks the
// parsing, the split, the routes and the packing offline. Nothing here but solana.js, solana-vault.js and the SDK.
import { resolveWallets, normalizeDomain, addressKind, codeMatchesAddress, parseUnits, SHARED_HOSTS } from '../lib/wallet262.js'
import * as sol from './solana.js'
import * as V from './solana-vault.js'

export const MAX_DOMAINS = 25
export const MAX_PACKAGES = 100 // a package.json's dependencies looked up on npm
export const MAX_UNITS = 1_400_000 // the most compute a transaction may ask for
// A payer of the same size as any other, for counting transactions before a wallet is connected.
export const STAND_IN = '11111111111111111111111111111112'

async function pool(items, n, fn) {
  const out = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i) }
  }))
  return out
}

// ---------- the list ----------

// Sites where a page, or a subdomain, is somebody's project, profile or app: paying the site would pay the platform,
// not the project. Subdomains count (gist.github.com, m.youtube.com, apps.apple.com); the bare domain on its own can
// still be paid, to fund the platform itself.
const PLATFORMS = new Set([
  // code and packages
  'github.com', 'githubusercontent.com', 'gitlab.com', 'bitbucket.org', 'codeberg.org', 'sourceforge.net', 'gitee.com',
  'npmjs.com', 'npmjs.org', 'npm.im', 'jsr.io', 'pypi.org', 'crates.io', 'docs.rs', 'pkg.go.dev', 'rubygems.org',
  'packagist.org', 'nuget.org', 'pub.dev', 'hex.pm', 'docker.com', 'huggingface.co',
  // app stores
  'apple.com', 'google.com', 'microsoft.com', 'steampowered.com',
  // social, video, music and writing
  'medium.com', 'dev.to', 'x.com', 'twitter.com', 'youtube.com', 'youtu.be', 'reddit.com', 'linkedin.com', 'instagram.com',
  'facebook.com', 'tiktok.com', 'twitch.tv', 't.me', 'discord.gg', 'discord.com', 'bsky.app', 'threads.net',
  'warpcast.com', 'spotify.com', 'producthunt.com',
  // funding and link pages, and link shorteners
  'patreon.com', 'opencollective.com', 'ko-fi.com', 'buymeacoffee.com', 'liberapay.com', 'polar.sh', 'thanks.dev',
  'gitcoin.co', 'kickstarter.com', 'gofundme.com', 'linktr.ee', 't.co', 'bit.ly', 'tinyurl.com', 'goo.gl', 'lnkd.in',
])
// Shared hosts: their subdomains belong to different people, who can't publish a _wallet record there. The SDK's list
// (the one resolveWalletsUp never walks into), and a few more where creators' pages and generated apps live.
const SHARED = [
  ...SHARED_HOSTS, 'itch.io', 'bandcamp.com', 'gumroad.com', 'dweb.link', 'w3s.link', 'mintlify.app', 'lovable.app',
  'bubbleapps.io', 'square.site', 'myportfolio.com',
]
// Mail providers: an address there names a person, but the domain is the provider's.
const MAIL = new Set([
  'icloud.com', 'me.com', 'mac.com', 'proton.me', 'protonmail.com', 'pm.me', 'web.de', 'mail.com', 'mail.ru', 'zoho.com',
  'yandex.com', 'yandex.ru', 'fastmail.com', 'hey.com', 'tutanota.com', 'tuta.io', 'qq.com', '163.com', 'naver.com',
])
const mailProvider = host => MAIL.has(host) || /^(?:gmail|googlemail|hotmail|outlook|live|msn|yahoo|ymail|aol|gmx)\.(?:[a-z]{2,3}|com?\.[a-z]{2})$/.test(host)
const sharedSuffix = host => SHARED.find(s => host.endsWith(`.${s}`)) || ''
// the platform `host` is or is part of; a shared host on its own counts as one (substack.com/@writer)
const platformOf = host => [...PLATFORMS].find(p => host === p || host.endsWith(`.${p}`)) || (SHARED.includes(host) ? host : '')
const withScheme = s => (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`)
const hasPath = s => { try { return new URL(withScheme(s)).pathname.replace(/\/+$/, '') !== '' } catch { return false } }
const isEmail = s => /^(?:mailto:)?[^\s@/:]+@[^\s@/:]+$/i.test(s)

/** A domain as the list keeps it: normalizeDomain, then a leading "www." dropped (example.com's owner publishes there). */
export function listDomain(input) {
  const d = normalizeDomain(input)
  return /^www\.[^.]+\.[^.]/.test(d) ? d.slice(4) : d
}

/**
 * Why `host` (from `input`) can't be paid as a project's own domain, or ''. `strict` also refuses a platform's home
 * page; an email address at a mail provider is refused too.
 */
export function sharedReason(host, input = host, strict = false) {
  const suffix = sharedSuffix(host)
  if (suffix) return `${host} is on ${suffix}, a shared host where its owner can't publish a _wallet record. Use the project's own domain.`
  const platform = platformOf(host)
  if (platform && host !== platform) return `${host} is part of ${platform}, which hosts other people's projects and pages. Use the project's own domain.`
  if (platform && (strict || hasPath(input))) return `${host} hosts other people's projects and pages. Use the project's own domain.`
  if (isEmail(input) && mailProvider(host)) return `${host} is a mail provider: paying it would pay the provider, not the person. Use a domain of their own.`
  return ''
}

/**
 * The domains in pasted text: domains, URLs or email addresses, one per line or separated by commas, semicolons or
 * spaces, in a bulleted or numbered list or not. Each is kept once, in order, up to `max`. { domains, skipped: [{ input, reason }], duplicates, over }:
 * what couldn't be used and why, how many repeats were counted once, and how many domains came past `max`.
 */
export function parseList(text, { max = MAX_DOMAINS } = {}) {
  const domains = [], skipped = [], extra = new Set()
  let duplicates = 0
  for (const raw of String(text || '').split(/[\s,;]+/)) {
    const input = raw.replace(/^[<(["']+|[>)\]"']+$/g, '')
    if (!input || /^(?:\d+[.)]|[^a-z0-9]+)$/i.test(input)) continue // a list's bullets and numbers
    let d
    try { d = listDomain(input) } catch { skipped.push({ input, reason: 'Not a domain or a link.' }); continue }
    const why = sharedReason(d, input)
    if (why) { skipped.push({ input, reason: why }); continue }
    if (domains.includes(d) || extra.has(d)) { duplicates++; continue }
    if (domains.length < max) domains.push(d); else extra.add(d)
  }
  return { domains, skipped, duplicates, over: extra.size }
}

const NPM_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/

/**
 * The project domains behind a package.json: each dependency's homepage on npm (registry.npmjs.org, which serves
 * CORS), read a few at a time, minus code hosts and shared hosts, once each and in the file's order.
 * { domains, left: [{ name, reason }], names, capped }. `capped` says the file had more than `max` dependencies.
 */
export async function packageDomains(pkg, { max = MAX_PACKAGES, fetchImpl = (...a) => globalThis.fetch(...a) } = {}) {
  const j = typeof pkg === 'string' ? JSON.parse(pkg) : pkg
  if (!j || typeof j !== 'object') throw new Error('That is not a package.json.')
  const all = [...new Set(['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].flatMap(k => (j[k] && typeof j[k] === 'object' ? Object.keys(j[k]) : [])))]
  if (!all.length) throw new Error('That package.json lists no dependencies.')
  const names = all.slice(0, max)
  const left = []
  const hosts = await pool(names, 4, async name => {
    if (!NPM_NAME.test(name)) { left.push({ name, reason: 'not an npm package name' }); return '' }
    let home = ''
    try {
      const res = await fetchImpl(`https://registry.npmjs.org/${name.replace('/', '%2F')}/latest`, { signal: AbortSignal.timeout(10_000) })
      if (res.status === 404) { left.push({ name, reason: 'not on npm' }); return '' }
      if (!res.ok) throw new Error(`npm answered ${res.status}`)
      home = String((await res.json()).homepage || '').trim()
    } catch { left.push({ name, reason: "couldn't be read from npm" }); return '' }
    if (!home) { left.push({ name, reason: 'no homepage on npm' }); return '' }
    let host
    try { host = listDomain(home) } catch { left.push({ name, reason: 'its homepage is not a link' }); return '' }
    if (sharedReason(host, home, true)) { left.push({ name, reason: `homepage on ${sharedSuffix(host) || platformOf(host) || host}` }); return '' }
    return host
  })
  return { domains: [...new Set(hosts.filter(Boolean))], left, names, capped: all.length > names.length }
}

// ---------- routes ----------

/**
 * Whether a domain can be paid at the wallet it publishes, from resolveWallets' answer: { address } when it publishes
 * exactly one Solana address, every resolver answered, they agree, and each returned it DNSSEC-authenticated (the
 * same record a vault claim needs); otherwise { reason }, and the payment goes to its vault.
 */
export function directWallet(dns) {
  if (!dns) return { reason: "Its DNS couldn't be read just now." }
  const addrs = [...new Set(dns.records.filter(r => addressKind(r.address) === 'solana' && codeMatchesAddress(r.code, r.address)).map(r => r.address))]
  if (!addrs.length) return { reason: 'Publishes no Solana wallet yet.' }
  if (addrs.length > 1) return { reason: 'Publishes more than one Solana address.' }
  if (!dns.resolvers.every(r => r.ok)) return { reason: 'Only one of the two resolvers answered.' }
  if (!dns.agree) return { reason: "Cloudflare and Google don't return the same record." }
  if (!dns.resolvers.every(r => r.records.some(x => x.address === addrs[0] && x.dnssec))) return { reason: 'Its record is not DNSSEC-signed.' }
  return { address: addrs[0] }
}

const KIND_TEXT = { program: 'a program', mint: 'a token mint', 'token-account': 'a token account', other: 'an account owned by a program' }
/** What an account from getAccounts is: 'new' (none yet), 'wallet' (system-owned, no data), or what else. */
export function kindOf(a) {
  if (!a) return 'new'
  if (a.executable) return 'program'
  if (a.owner === sol.SYSTEM_PROGRAM) return a.data.length ? 'other' : 'wallet'
  if (a.owner === sol.TOKEN_PROGRAM || a.owner === V.TOKEN_2022) return a.data.length === 165 || (a.data.length > 165 && a.data[165] === 2) ? 'token-account' : 'mint'
  return 'other'
}

/**
 * The route of one domain from its DNS answer, its vault ({ vault, usdcAccount } or null) and the accounts read on
 * Solana (address -> account or null): { route: 'direct' | 'vault', to, tokenAccount, lamports, tokenOpen, why },
 * or { error } when it can't be paid. `walletToken` is the USDC account of the published wallet.
 */
export function routeOf(domain, { dns, vault, vaultError = '', walletToken = '', accounts = new Map() }) {
  if (dns && dns.nxdomain) return { domain, error: `${domain} doesn't exist in DNS. Check the spelling.` }
  const direct = directWallet(dns)
  const kind = direct.address ? kindOf(accounts.get(direct.address)) : ''
  const read = (to, tokenAccount) => {
    const a = accounts.get(to)
    return { to, tokenAccount, lamports: a ? a.lamports : 0n, tokenOpen: !!accounts.get(tokenAccount) }
  }
  if (direct.address && (kind === 'wallet' || kind === 'new') && !(vault && vault.vault === direct.address)) {
    return { domain, route: 'direct', ...read(direct.address, walletToken), why: 'Publishes a DNSSEC-signed Solana wallet.' }
  }
  if (!vault) return { domain, error: `Couldn't find its vault: ${vaultError || 'the TYPE/262 worker did not answer.'}` }
  const why = direct.address ? `Its published address is ${KIND_TEXT[kind] || 'its own vault'}, not a wallet.` : direct.reason
  return { domain, route: 'vault', ...read(vault.vault, vault.usdcAccount), why }
}

const reads = new Map() // domain -> { at, p }: its DNS answer and its vault, kept for two minutes
function readDomain(domain) {
  const hit = reads.get(domain)
  if (hit && Date.now() - hit.at < 120_000) return hit.p
  const p = Promise.all([
    resolveWallets(domain).catch(() => null),
    V.getVault(domain).then(v => ({ vault: v }), err => ({ vault: null, vaultError: String((err && err.message) || err) })),
  ]).then(([dns, v]) => ({ dns, ...v }))
  reads.set(domain, { at: Date.now(), p })
  // what couldn't be read is asked again next time
  p.then(r => { if (!r.dns || !r.vault) reads.delete(domain) })
  return p
}

/**
 * Where each of `domains` would be paid: resolveWallets and the worker's vault lookup (the same one a single deposit
 * uses) per domain, four at a time, then one read on Solana of every address a payment could go to and its USDC
 * account. [routeOf(...)] in order; `onProgress(done, total)` hears each domain read.
 */
export async function lookup(domains, { onProgress = () => {} } = {}) {
  let done = 0
  const found = await pool(domains, 4, async d => { const r = await readDomain(d); onProgress(++done, domains.length); return r })
  const wallets = found.map(r => directWallet(r.dns).address || '')
  const walletTokens = await Promise.all(wallets.map(w => (w ? sol.associatedTokenAddress(w, sol.USDC.mint) : '')))
  const addresses = [...new Set(found.flatMap((r, i) => [wallets[i], walletTokens[i], r.vault && r.vault.vault, r.vault && r.vault.usdcAccount]).filter(Boolean))]
  const list = addresses.length ? await V.getAccounts(addresses) : []
  const accounts = new Map(addresses.map((a, i) => [a, list[i]]))
  return domains.map((d, i) => routeOf(d, { ...found[i], walletToken: walletTokens[i], accounts }))
}

/**
 * The domains of `rows` whose route, address or reason to skip is different in `fresh`, a later lookup: what the
 * screen asks about before sending a plan that was reviewed a while ago.
 */
export function changedRoutes(rows, fresh) {
  const now = new Map(fresh.map(r => [r.domain, r]))
  return rows.filter(r => { const f = now.get(r.domain); return !f || f.route !== r.route || f.to !== r.to || f.error !== r.error }).map(r => r.domain)
}

// ---------- amounts ----------

/** `total` base units over `n` rows, exactly: each gets total / n, and the remainder one unit each to the first rows. */
export function splitEvenly(total, n) {
  const t = BigInt(total), k = BigInt(n)
  if (n < 1) return []
  const base = t / k, rest = t % k
  return Array.from({ length: n }, (_, i) => base + (BigInt(i) < rest ? 1n : 0n))
}

export const ASSETS = { sol: { symbol: 'SOL', decimals: 9 }, usdc: sol.USDC }

/**
 * The payments for routed rows: `amount` (a decimal string) in SOL or USDC, as the total split evenly or for each
 * domain. { rows (with `amount`, or `error`), pay (the rows paid), total, low (SOL rows under the rent minimum of a
 * new account), opens (new USDC accounts this pays rent for) }, or { error, rows } when nothing can be sent.
 * `payer` leaves out a published wallet that is the payer's own.
 */
export function plan(routed, { asset = 'usdc', amount, mode = 'total', payer = '' }) {
  const t = ASSETS[asset]
  const rows = routed.map(r => (!r.error && payer && r.route === 'direct' && r.to === payer ? { ...r, error: "That's the wallet you're paying from." } : { ...r }))
  let units
  try { units = parseUnits(amount, t.decimals) } catch (err) { return { error: /decimals/.test(err.message) ? `${t.symbol} has at most ${t.decimals} decimals.` : 'Enter a valid amount.', rows } }
  if (units <= 0n) return { error: 'Enter an amount above zero.', rows }
  const pay = rows.filter(r => !r.error)
  if (!pay.length) return { error: 'None of these domains can be paid.', rows }
  const amounts = mode === 'each' ? pay.map(() => units) : splitEvenly(units, pay.length)
  if (amounts.some(a => a <= 0n)) return { error: `That total is too small to split across ${pay.length} domains.`, rows }
  pay.forEach((r, i) => { r.amount = amounts[i] })
  const low = asset === 'sol' ? pay.filter(r => r.lamports === 0n && r.amount < sol.MIN_ACCOUNT_LAMPORTS) : []
  const opens = asset === 'sol' ? 0 : pay.filter(r => !r.tokenOpen).length
  return { asset, token: t, rows, pay, total: amounts.reduce((a, b) => a + b, 0n), low, opens }
}

// ---------- transactions ----------

/**
 * One row's instructions, built as a single deposit or a Pay screen payment builds them. Into a vault: the transfer
 * carries the board reference and the row has its own memo, so the board counts each domain; USDC opens the vault's
 * token account if needed (idempotent). Direct: a plain transfer, USDC with the wallet's token account opened likewise.
 */
export function rowInstructions(payer, row, asset, source = '') {
  const vault = row.route === 'vault'
  const tag = vault ? V.withReference : ix => ix
  const memo = vault ? [V.memoIx(V.boardMemo('deposit', row.domain))] : []
  if (asset === 'sol') return [tag(sol.systemTransfer(payer, row.to, row.amount)), ...memo]
  const mint = sol.USDC.mint
  return [
    sol.createAssociatedTokenAccountIdempotent({ payer, ata: row.tokenAccount, owner: row.to, mint }),
    tag(sol.transferChecked({ source, mint, destination: row.tokenAccount, owner: payer, amount: row.amount, decimals: sol.USDC.decimals })),
    ...memo,
  ]
}

/** Compute units for `n` payments: a single deposit's budget each (V.DEPOSIT), at most MAX_UNITS. */
export const unitsFor = (asset, n) => Math.min(MAX_UNITS, n * (asset === 'sol' ? V.DEPOSIT.solUnits : V.DEPOSIT.usdcUnits))

/**
 * Packs [{ row, instructions }] into as few legacy transactions as fit under 1,232 bytes, in order, each with the
 * deposit's compute budget (limit scaled to its payments, priority fee, loaded-data limit). A row never splits.
 * [{ rows, instructions, extraSigners }].
 */
export function pack(payer, items, asset) {
  const build = list => [...V.depositBudget(unitsFor(asset, list.length)), ...list.flatMap(x => x.instructions)]
  const fits = list => V.legacySize(payer, build(list)) <= V.LEGACY_LIMIT
  const txs = []
  let cur = []
  for (const item of items) {
    if (!fits([item])) throw new Error(`The payment to ${item.row.domain} doesn't fit in a Solana transaction.`)
    if (cur.length && !fits([...cur, item])) { txs.push(cur); cur = [] }
    cur.push(item)
  }
  if (cur.length) txs.push(cur)
  return txs.map(list => ({ rows: list.map(x => x.row), instructions: build(list), extraSigners: [] }))
}

/** The transactions of a plan, from `payer` (STAND_IN to count them before a wallet is connected). */
export async function transactions(payer, p) {
  const source = p.asset === 'sol' ? '' : await sol.associatedTokenAddress(payer, sol.USDC.mint)
  return pack(payer, p.pay.map(row => ({ row, instructions: rowInstructions(payer, row, p.asset, source) })), p.asset)
}

/** Network fees of these transactions in lamports: one signature each, and the priority fee on its compute limit. */
export function feesOf(txs, asset) {
  return txs.reduce((n, t) => n + 5_000n + (BigInt(unitsFor(asset, t.rows.length)) * V.DEPOSIT.microLamports + 999_999n) / 1_000_000n, 0n)
}
