// wallet262: resolve, verify and encode DNS WALLET records (RRTYPE 262).
// IANA allocated WALLET on 2024-06-21. RDATA is exactly two <character-string>s,
// the currency code and the address, with the same wire format as TXT.
// Works in browsers and Node 18+ (uses fetch + DNS-over-HTTPS JSON).

export const WALLET_TYPE = 262
export const TXT_TYPE = 16
export const FALLBACK_LABEL = '_wallet'

export const RESOLVERS = {
  cloudflare: 'https://cloudflare-dns.com/dns-query',
  google: 'https://dns.google/resolve',
}

const enc = new TextEncoder()
const dec = new TextDecoder()

// ---------- names ----------

export function normalizeDomain(input) {
  const raw = String(input || '').trim()
  if (!raw) throw new Error('Enter a domain')
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'http://' + raw
  let host
  try { host = new URL(withScheme).hostname } catch { throw new Error(`Not a valid domain: ${raw}`) }
  host = host.replace(/\.$/, '').toLowerCase()
  if (!/^(?=.{1,253}$)(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/.test(host)) {
    throw new Error(`Not a valid domain: ${raw}`)
  }
  return host
}

// ---------- RDATA codec ----------

function readCharStrings(bytes) {
  const out = []
  let i = 0
  while (i < bytes.length) {
    const len = bytes[i]
    const end = i + 1 + len
    if (end > bytes.length) throw new Error('Truncated character-string')
    out.push(dec.decode(bytes.slice(i + 1, end)))
    i = end
  }
  return out
}

function hexToBytes(hex) {
  if (hex.length % 2) throw new Error('Odd-length hex')
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16)
  return out
}

function parseQuoted(s) {
  const out = []
  const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g
  let m
  while ((m = re.exec(s))) {
    const v = m[1] !== undefined ? m[1] : m[2]
    out.push(v.replace(/\\(\d{3})/g, (_, d) => String.fromCharCode(+d)).replace(/\\(.)/g, '$1'))
  }
  return out
}

// Accepts DoH presentation forms: RFC 3597 generic ("\# 47 0345…") or quoted strings.
export function parseWalletRdata(data) {
  const s = String(data).trim()
  let strings
  if (s.startsWith('\\#')) {
    const m = s.match(/^\\#\s*(\d+)\s*([0-9a-fA-F\s]*)$/)
    if (!m) throw new Error('Malformed generic RDATA')
    const bytes = hexToBytes(m[2].replace(/\s+/g, ''))
    if (bytes.length !== Number(m[1])) throw new Error('RDATA length mismatch')
    strings = readCharStrings(bytes)
  } else {
    strings = parseQuoted(s)
  }
  if (strings.length !== 2) throw new Error('A WALLET record must hold exactly two strings')
  if (!strings[0] || !strings[1]) throw new Error('Empty coin code or address')
  return { code: strings[0].toUpperCase(), address: strings[1] }
}

// TXT fallback at _wallet.<domain>: one string "CODE ADDRESS" (or "CODE:ADDRESS"),
// two strings "CODE" "ADDRESS" also accepted.
export function parseFallbackTxt(data) {
  const parts = parseQuoted(String(data).trim())
  if (parts.length === 2) return { code: parts[0].toUpperCase(), address: parts[1] }
  const one = parts.join('')
  const m = one.match(/^([A-Za-z0-9._-]{2,16})[\s:]+(\S+)$/)
  if (!m) throw new Error('Unrecognized _wallet TXT format')
  return { code: m[1].toUpperCase(), address: m[2] }
}

export function encodeWalletRdata(code, address) {
  const parts = [enc.encode(String(code).toUpperCase()), enc.encode(String(address))]
  for (const p of parts) if (p.length > 255) throw new Error('Each string must be at most 255 bytes')
  const bytes = new Uint8Array(parts.reduce((n, p) => n + 1 + p.length, 0))
  let i = 0
  for (const p of parts) { bytes[i++] = p.length; bytes.set(p, i); i += p.length }
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('').toUpperCase()
  return { bytes, hex, generic: `\\# ${bytes.length} ${hex}` }
}

export function zoneLines(domainInput, entries, ttl = 3600) {
  const d = normalizeDomain(domainInput)
  return {
    generic: entries.map(e => `${d}. ${ttl} IN TYPE262 ${encodeWalletRdata(e.code, e.address).generic}`),
    named: entries.map(e => `${d}. ${ttl} IN WALLET "${e.code.toUpperCase()}" "${e.address}"`),
    txt: entries.map(e => `${FALLBACK_LABEL}.${d}. ${ttl} IN TXT "${e.code.toUpperCase()} ${e.address}"`),
  }
}

// ---------- addresses ----------

export function addressKind(address) {
  const a = String(address)
  if (/^0x[0-9a-fA-F]{40}$/.test(a)) return 'evm'
  if (/^(bc1|tb1)[02-9ac-hj-np-z]{8,87}$/i.test(a) || /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(a)) return 'btc'
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a) && base58Length(a) === 32) return 'solana' // a 32-byte public key
  return 'other'
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
/** Decoded byte length of a base58 string (LTC, DOGE, TRX and XRP addresses also look like base58). */
function base58Length(s) {
  let n = 0n
  for (const c of s) { const i = B58.indexOf(c); if (i < 0) return -1; n = n * 58n + BigInt(i) }
  let len = 0
  while (n > 0n) { n >>= 8n; len++ }
  return len + s.match(/^1*/)[0].length
}

export const EVM_CODES = new Set(['ETH', 'EVM', 'HOOD', 'USDG', 'ARB', 'OP', 'POL', 'USDC', 'USDT', 'DAI'])
export function codeMatchesAddress(code, address) {
  const kind = addressKind(address)
  const c = String(code).toUpperCase()
  if (kind === 'evm') return EVM_CODES.has(c)
  if (kind === 'btc') return c === 'BTC'
  if (kind === 'solana') return c === 'SOL'
  return true
}

export function sameAddress(a, b) {
  return addressKind(a) === 'evm' ? a.toLowerCase() === String(b).toLowerCase() : a === b
}

// ---------- DNS-over-HTTPS ----------

async function doh(resolver, name, type, fetchImpl) {
  const base = RESOLVERS[resolver] || resolver
  const res = await fetchImpl(`${base}?name=${encodeURIComponent(name)}&type=${type}`, {
    headers: { accept: 'application/dns-json' },
  })
  if (!res.ok) throw new Error(`${resolver}: HTTP ${res.status}`)
  return res.json()
}

const answersOf = (j, type) => ((j && j.Answer) || []).filter(a => a.type === type).map(a => a.data)

function collect(datas, parser, source, dnssec, records, invalid) {
  for (const data of datas) {
    try { records.push({ ...parser(data), source, dnssec }) } catch (e) { invalid.push({ source, data, error: e.message }) }
  }
}

const keyOf = r => `${r.code}|${addressKind(r.address) === 'evm' ? r.address.toLowerCase() : r.address}`

export async function resolveWallets(input, opts = {}) {
  const domain = normalizeDomain(input)
  const fetchImpl = opts.fetch || globalThis.fetch.bind(globalThis)
  const names = opts.resolvers || Object.keys(RESOLVERS)
  const withTxt = opts.txtFallback !== false

  const results = await Promise.all(names.map(async resolver => {
    const t0 = Date.now()
    try {
      const [w, t] = await Promise.all([
        doh(resolver, domain, WALLET_TYPE, fetchImpl),
        withTxt ? doh(resolver, `${FALLBACK_LABEL}.${domain}`, TXT_TYPE, fetchImpl) : null,
      ])
      const records = []
      const invalid = []
      collect(answersOf(w, WALLET_TYPE), parseWalletRdata, 'TYPE262', !!w.AD, records, invalid)
      if (t) collect(answersOf(t, TXT_TYPE), parseFallbackTxt, 'TXT', !!t.AD, records, invalid)
      return { resolver, ok: true, ms: Date.now() - t0, status: w.Status, signed: !!w.AD, records, invalid }
    } catch (e) {
      return { resolver, ok: false, ms: Date.now() - t0, error: e.message, records: [], invalid: [] }
    }
  }))

  const ok = results.filter(r => r.ok)
  if (!ok.length) throw new Error(results.map(r => r.error).join('; ') || 'All resolvers failed')
  const primary = ok[0]
  const sig = r => r.records.map(keyOf).sort().join(',')
  const agree = ok.every(r => sig(r) === sig(primary))
  const records = primary.records
  return {
    domain,
    records,
    invalid: primary.invalid,
    nxdomain: primary.status === 3,
    dnssec: ok.every(r => r.signed),
    verified: records.length > 0 && agree && records.every(r => r.dnssec),
    agree,
    resolvers: results,
  }
}

const MULTI_SUFFIX = /^(?:co|com|net|org|gov|edu|ac|or|ne|go)\.[a-z]{2}$/

// The host, then (if it holds no record) its parent: api.example.com -> example.com.
// Stops before public suffixes like co.uk.
export async function resolveWalletsUp(target, opts = {}) {
  const host = normalizeDomain(target)
  const first = await resolveWallets(host, opts)
  const labels = host.split('.')
  const parent = labels.slice(1).join('.')
  if (first.records.length || opts.walkUp === false || labels.length < 3 || MULTI_SUFFIX.test(parent)) {
    return { ...first, resolvedAt: host }
  }
  const up = await resolveWallets(parent, opts)
  return up.records.length ? { ...up, resolvedAt: parent, requested: host } : { ...first, resolvedAt: host }
}

// Does `payTo` belong to the domain behind `target` (a URL, email or domain)?
// Use it before paying an x402 / HTTP 402 requirement.
export async function verifyPayTo(target, payTo, opts = {}) {
  const res = await resolveWalletsUp(target, opts)
  const match = res.records.find(r => sameAddress(r.address, payTo))
  let reason
  if (!res.records.length) reason = res.nxdomain ? 'Domain does not exist' : 'Domain publishes no WALLET record'
  else if (!match) reason = 'Address is not published by this domain'
  else if (!res.agree) reason = 'Resolvers disagree. Possible tampering'
  else if (!match.dnssec) reason = 'Match, but the zone is not DNSSEC-signed'
  else reason = 'Match, DNSSEC-verified'
  return { ok: !!match && res.agree, strong: !!match && res.agree && match.dnssec, reason, match: match || null, ...res }
}

// Pull every payTo out of an x402 "402 Payment Required" JSON body.
export function payTosFromX402(body) {
  const j = typeof body === 'string' ? JSON.parse(body) : body
  const list = (j && (j.accepts || j.paymentRequirements)) || (Array.isArray(j) ? j : [j])
  return list.map(a => a && (a.payTo || a.pay_to)).filter(Boolean)
}

// ---------- payments ----------

export function parseUnits(amount, decimals) {
  const s = String(amount).trim()
  if (!/^\d*\.?\d+$/.test(s)) throw new Error('Invalid amount')
  const [whole, frac = ''] = s.split('.')
  if (frac.length > decimals) throw new Error(`Max ${decimals} decimals`)
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0')
}

const pad32 = hex => hex.replace(/^0x/, '').padStart(64, '0')

// EIP-1193 transaction params for a native or ERC-20 transfer.
export function transferTx({ from, to, amount, decimals = 18, token }) {
  const units = parseUnits(amount, decimals)
  if (!token) return { from, to, value: '0x' + units.toString(16) }
  return { from, to: token, value: '0x0', data: '0xa9059cbb' + pad32(to.toLowerCase()) + pad32(units.toString(16)) }
}

// Wallet deep links: EIP-681, BIP-21, Solana Pay.
export function paymentUri(address, { amount, chainId = 1, token, decimals = 18, splToken } = {}) {
  const kind = addressKind(address)
  if (kind === 'btc') return `bitcoin:${address}${amount ? `?amount=${amount}` : ''}`
  if (kind === 'solana') {
    const q = [amount && `amount=${amount}`, splToken && `spl-token=${splToken}`].filter(Boolean).join('&')
    return `solana:${address}${q ? '?' + q : ''}`
  }
  if (kind === 'evm') {
    if (token) return `ethereum:${token}@${chainId}/transfer?address=${address}${amount ? `&uint256=${parseUnits(amount, decimals)}` : ''}`
    return `ethereum:${address}@${chainId}${amount ? `?value=${parseUnits(amount, decimals)}` : ''}`
  }
  return address
}
