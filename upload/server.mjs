// TYPE/262 worker: the Solana vault endpoints under /solana/ (worker.mjs), image and coin-metadata uploads, and the
// RPC fallbacks. The Launch form's "Choose image" posts a file to /image; it is
// pinned to IPFS with Pinata and the token gets ipfs://<cid>, the same kind of link pons stores. /metadata pins
// a pump.fun-style token metadata JSON the same way. /rpc is a read-only Robinhood Chain RPC the app falls back
// to when a browser can't reach the public one, and /rpc/solana is the same for Solana, plus sendTransaction to
// relay a transaction the wallet already signed. Keys stay on the server. Zero dependencies (Node 18+).
//
//   PINATA_JWT     Pinata API key (JWT) that can upload files. Required.
//   ALLOW_ORIGINS  comma-separated origins allowed to upload (default https://type262.com, www and the onrender.com address)
//   RATE_MAX       uploads per IP per 10 minutes, for /image and /metadata each (default 12)
//   PINATA_URL     upload endpoint (default Pinata v3); tests point it at a mock
//   IPFS_GATEWAY   gateway in the metadata URIs /metadata returns (default https://ipfs.io, as pump.fun uses)
//   ROBINHOOD_RPC_URL  keyed Robinhood Chain RPC for /rpc, tried first (optional; secret, never logged)
//   PUBLIC_RPC_URL     public RPC tried after it (default https://rpc.mainnet.chain.robinhood.com)
//   RPC_RATE_MAX       /rpc and /rpc/solana requests per IP per minute, each (default 240)
//   SOLANA_RPC_URL     keyed Solana RPC for /rpc/solana, tried first (optional; secret, never logged)
//   SOLANA_PUBLIC_RPC_URLS  comma-separated public Solana RPCs tried after it, in order
//                           (default https://solana-rpc.publicnode.com,https://api.mainnet-beta.solana.com)
//   SOL_SEND_RATE_MAX  sendTransaction calls per IP per minute (default 10)
//
// /solana/* is the Solana vault worker (worker.mjs): every domain's vault address, and claims, collects and refunds.
// The worker holds the vault keys, derived from one master secret; see worker.mjs and vault.mjs.
//   VAULT_MASTER_SEED  64 hex characters, the master secret of every vault and the gas wallet (secret, never logged)
//   SOLANA_FEE_WALLET  where the claim fee goes
//   FEE_BPS            the claim fee in basis points, on every asset (default 50 = 0.5%)
//   REFUND_DELAY_DAYS  how long a deposit waits before its sender can take it back (default 180)
//   VAULT_RATE_MAX     claims, collects and refunds per IP per 10 minutes, together (default 10)
//   SOLANA_USDC_MINT, DOH_RESOLVERS, PRIORITY_FEE_MIN/MAX, MAX_TOKENS_PER_CLAIM: see worker.mjs (tests and tuning)
import http from 'node:http'
import { createWorker } from './worker.mjs'
import { canonicalDomain } from './vault.mjs'

const PORT = Number(process.env.PORT || 8787)
const JWT = (process.env.PINATA_JWT || '').trim()
const PINATA_URL = process.env.PINATA_URL || 'https://uploads.pinata.cloud/v3/files'
const ORIGINS = new Set((process.env.ALLOW_ORIGINS || 'https://type262.com,https://www.type262.com,https://type262.onrender.com').split(',').map(s => s.trim()).filter(Boolean))
const RATE_MAX = Number(process.env.RATE_MAX || 12)
const RATE_WINDOW = 10 * 60 * 1000
const MAX_BYTES = 5 * 1024 * 1024 // same limit as pons
const MAX_BODY = MAX_BYTES + 64 * 1024 // file plus multipart overhead

// Same formats pons accepts. Checked by content, not by the name or type the browser claims.
const ascii = (b, from, to) => String.fromCharCode(...b.subarray(from, to))
const FORMATS = [
  { type: 'image/png', ext: 'png', is: b => b.length > 8 && b[0] === 0x89 && ascii(b, 1, 4) === 'PNG' },
  { type: 'image/jpeg', ext: 'jpg', is: b => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'image/webp', ext: 'webp', is: b => b.length > 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP' },
]

const MAX_INFLIGHT = 8 // uploads held in memory at once (5 MB each) on a small instance
let inflight = 0
const hits = new Map() // ip -> recent upload times
const metaHits = new Map() // ip -> recent metadata upload times
function rateLimited(ip, map = hits) {
  const now = Date.now()
  const recent = (map.get(ip) || []).filter(t => now - t < RATE_WINDOW)
  if (recent.length >= RATE_MAX) { map.set(ip, recent); return true }
  recent.push(now)
  map.set(ip, recent)
  if (map.size > 50_000) for (const [k, v] of map) if (!v.some(t => now - t < RATE_WINDOW)) map.delete(k)
  return false
}

function send(res, status, body, origin) {
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', vary: 'Origin' }
  if (origin && ORIGINS.has(origin)) headers['access-control-allow-origin'] = origin
  res.writeHead(status, headers)
  res.end(JSON.stringify(body))
}

function readBody(req, max = MAX_BODY, tooBig = 'Images must be 5 MB or smaller.') {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', c => {
      size += c.length
      if (size > max) { reject(Object.assign(new Error(tooBig), { status: 413 })); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function pin(bytes, format) {
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: format.type }), `type262-${Date.now()}.${format.ext}`)
  form.append('network', 'public')
  const res = await fetch(PINATA_URL, { method: 'POST', headers: { authorization: `Bearer ${JWT}` }, body: form, signal: AbortSignal.timeout(30_000) })
  const json = await res.json().catch(() => ({}))
  const cid = json?.data?.cid
  if (!res.ok || typeof cid !== 'string' || !/^[a-zA-Z0-9]+$/.test(cid)) {
    console.error('pinata upload failed', res.status, JSON.stringify(json).slice(0, 300))
    throw Object.assign(new Error('The upload did not complete. Try again in a moment.'), { status: 502 })
  }
  return cid
}

// ---------- /metadata ----------

// pump.fun-style token metadata. Coins launched on pump.fun today point their metadata URI at
// https://ipfs.io/ipfs/<cid> and use the same gateway for the image, so /metadata does too.
const IPFS_GATEWAY = (process.env.IPFS_GATEWAY || 'https://ipfs.io').trim().replace(/\/+$/, '')
const META_MAX_BODY = 8 * 1024
const META_FIELDS = new Set(['name', 'symbol', 'description', 'image', 'twitter', 'telegram', 'website', 'showName', 'domain'])
const CONTROL = /[\u0000-\u001f\u007f]/
const invalid = message => Object.assign(new Error(message), { status: 400 })

// Name and symbol are capped in bytes, the on-chain limit; the description may have line breaks.
function text(v, field, max, { required = false, bytes = false, lines = false } = {}) {
  if (v === undefined || v === null || v === '') { if (required) throw invalid(`Add a ${field}.`); return '' }
  if (typeof v !== 'string') throw invalid(`The ${field} must be text.`)
  const s = v.trim()
  if (!s && required) throw invalid(`Add a ${field}.`)
  if (CONTROL.test(lines ? s.replace(/[\r\n\t]/g, '') : s)) throw invalid(`The ${field} has characters that are not allowed.`)
  if ((bytes ? Buffer.byteLength(s, 'utf8') : [...s].length) > max) throw invalid(`The ${field} can be at most ${max} ${bytes ? 'bytes' : 'characters'}.`)
  return s
}

function link(v, field, max = 200) {
  if (v === undefined || v === null || v === '') return ''
  const s = typeof v === 'string' ? v.trim() : ''
  let u
  try { u = new URL(s) } catch {}
  if (!u || u.protocol !== 'https:' || u.username || u.password || !u.hostname.includes('.') || s.length > max || /[\s\u0000-\u001f\u007f]/.test(s)) {
    throw invalid(`The ${field} must be an https link of at most ${max} characters.`)
  }
  return s
}

// An ipfs://<cid> from /image becomes a gateway link, the form pump.fun stores; any other https link is kept.
function imageLink(v) {
  if (v === undefined || v === null || v === '') throw invalid('Add an image.')
  if (typeof v === 'string' && v.trim().startsWith('ipfs://')) {
    const cid = v.trim().slice(7)
    if (!/^[a-zA-Z0-9]{46,100}$/.test(cid)) throw invalid('The image must be an ipfs:// or https link.')
    return `${IPFS_GATEWAY}/ipfs/${cid}`
  }
  return link(v, 'image', 300)
}

// Field order and names follow the JSON pump.fun pins.
function tokenMetadata(input, origin) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('Send the metadata as a JSON object.')
  const extra = Object.keys(input).find(k => !META_FIELDS.has(k))
  if (extra) throw invalid(`Unknown field: ${extra.slice(0, 40)}.`)
  if (input.showName !== undefined && input.showName !== true) throw invalid('showName must be true.')
  const meta = {
    name: text(input.name, 'name', 32, { required: true, bytes: true }),
    symbol: text(input.symbol, 'symbol', 10, { required: true, bytes: true }),
    description: text(input.description, 'description', 1000, { lines: true }),
    showName: true,
    image: imageLink(input.image),
    createdOn: origin,
  }
  for (const field of ['twitter', 'telegram', 'website']) {
    const url = link(input[field], field)
    if (url) meta[field] = url
  }
  // The domain whose vault is the coin's creator: the Unclaimed Board reads it back and checks it against the creator.
  if (input.domain !== undefined && input.domain !== '') {
    try { meta.type262 = { domain: canonicalDomain(input.domain) } } catch { throw invalid('The domain must be a domain name, like example.com.') }
  }
  return meta
}

async function pinMetadata(req, res, origin, ip) {
  if (rateLimited(ip, metaHits)) return send(res, 429, { error: 'Too many uploads. Try again in a few minutes.' }, origin)
  if (Number(req.headers['content-length'] || 0) > META_MAX_BODY) return send(res, 413, { error: 'Metadata is too large.' }, origin)
  if (!/^application\/json/i.test(req.headers['content-type'] || '')) return send(res, 400, { error: 'Send the metadata as JSON.' }, origin)
  try {
    const body = await readBody(req, META_MAX_BODY, 'Metadata is too large.')
    let input
    try { input = JSON.parse(body.toString('utf8')) } catch { throw invalid('That is not valid JSON.') }
    const meta = tokenMetadata(input, origin)
    const cid = await pin(new TextEncoder().encode(JSON.stringify(meta)), { type: 'application/json', ext: 'json' })
    return send(res, 200, { uri: `${IPFS_GATEWAY}/ipfs/${cid}`, cid }, origin)
  } catch (err) {
    return send(res, err.status || 502, { error: err.status ? err.message : 'The upload did not complete. Try again in a moment.' }, origin)
  }
}

// ---------- /rpc and /rpc/solana ----------

const KEYED_RPC = (process.env.ROBINHOOD_RPC_URL || '').trim()
const PUBLIC_RPC = (process.env.PUBLIC_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com').trim()
const RPC_RATE_MAX = Number(process.env.RPC_RATE_MAX || 240)
const RPC_MAX_BODY = 64 * 1024
const RPC_MAX_BATCH = 50
// Reads only: nothing that signs, sends or subscribes.
const READ_METHODS = new Set(['eth_chainId', 'net_version', 'eth_blockNumber', 'eth_call', 'eth_estimateGas', 'eth_gasPrice',
  'eth_getBalance', 'eth_getCode', 'eth_getLogs', 'eth_getBlockByNumber', 'eth_getTransactionCount', 'eth_getTransactionByHash',
  'eth_getTransactionReceipt'])
// Keyed providers cap eth_getLogs ranges far below the public node, so log queries try the public node first.
const upstreamsFor = methods => (methods.includes('eth_getLogs') ? [PUBLIC_RPC, KEYED_RPC] : [KEYED_RPC, PUBLIC_RPC]).filter(Boolean)

// Solana: the keyed provider first, then the public nodes in order. The reads a dapp needs, plus sendTransaction,
// which only relays a transaction the wallet already signed. Nothing that airdrops or subscribes.
const SOL_KEYED = (process.env.SOLANA_RPC_URL || '').trim()
const SOL_PUBLIC = (process.env.SOLANA_PUBLIC_RPC_URLS || 'https://solana-rpc.publicnode.com,https://api.mainnet-beta.solana.com').split(',').map(s => s.trim()).filter(Boolean)
const SOL_SEND_RATE_MAX = Number(process.env.SOL_SEND_RATE_MAX || 10)
const SOL_MAX_RESPONSE = 4 * 1024 * 1024
const SOL_SMALL_RESPONSE = 256 * 1024 // getProgramAccounts without a dataSlice
const SOL_METHODS = new Set(['getAccountInfo', 'getMultipleAccounts', 'getBalance', 'getTokenAccountBalance', 'getTokenAccountsByOwner',
  'getLatestBlockhash', 'getSignatureStatuses', 'getTransaction', 'getSlot', 'getBlockTime', 'getMinimumBalanceForRentExemption',
  'getFeeForMessage', 'simulateTransaction', 'getProgramAccounts', 'getRecentPrioritizationFees', 'isBlockhashValid', 'getHealth',
  'getVersion', 'getSignaturesForAddress', 'sendTransaction'])

// Checks on the methods that carry a transaction or could return a whole program's accounts.
function solanaCheck(c) {
  const p = Array.isArray(c.params) ? c.params : []
  if ((c.method === 'sendTransaction' || c.method === 'simulateTransaction') && (typeof p[0] !== 'string' || !p[0] || p[0].length > 2048)) {
    return `${c.method} takes one encoded transaction.`
  }
  if (c.method === 'getProgramAccounts') {
    const cfg = p[1] && typeof p[1] === 'object' ? p[1] : {}
    const filters = Array.isArray(cfg.filters) ? cfg.filters : []
    if (!filters.length || filters.length > 4 || !filters.some(f => f && f.memcmp)) return 'getProgramAccounts needs filters, with at least one memcmp.'
    const ds = cfg.dataSlice
    if (ds !== undefined && !(ds && Number.isInteger(ds.offset) && ds.offset >= 0 && Number.isInteger(ds.length) && ds.length >= 0 && ds.length <= 1024)) {
      return 'dataSlice must be { offset, length } with a length of at most 1024 bytes.'
    }
  }
  return ''
}
// Without a dataSlice, getProgramAccounts has to come back small.
const solanaCap = calls => (calls.some(c => c.method === 'getProgramAccounts' && !c.params[1].dataSlice) ? SOL_SMALL_RESPONSE : SOL_MAX_RESPONSE)

// Move on to the next upstream only when this one is unavailable, never on an ordinary error such as a revert.
const DOWN = /not enabled|unauthori|api key|forbidden|rate limit|too many requests|capacity|unavailable|dedicated node/i
const unavailable = j => [].concat(j).every(x => x && x.error && (x.error.code === -32005 || x.error.code === 429 || DOWN.test(String(x.error.message || ''))))
const rpcError = (code, message) => ({ jsonrpc: '2.0', id: null, error: { code, message } })

const rpcHits = new Map() // ip -> /rpc request times in the last minute
const solanaHits = new Map() // ip -> /rpc/solana request times in the last minute
const sendHits = new Map() // ip -> sendTransaction times in the last minute
function rpcLimited(ip, map = rpcHits, max = RPC_RATE_MAX, n = 1) {
  const now = Date.now()
  const recent = (map.get(ip) || []).filter(t => now - t < 60_000)
  for (let i = 0; i < n; i++) recent.push(now)
  map.set(ip, recent)
  if (map.size > 50_000) for (const [k, v] of map) if (!v.some(t => now - t < 60_000)) map.delete(k)
  return recent.length > max
}

const CHAINS = {
  '/rpc': { name: 'Robinhood Chain', log: 'rpc', methods: READ_METHODS, hits: rpcHits, upstreams: upstreamsFor },
  '/rpc/solana': { name: 'Solana', log: 'solana rpc', methods: SOL_METHODS, hits: solanaHits, upstreams: () => [SOL_KEYED, ...SOL_PUBLIC].filter(Boolean), check: solanaCheck, cap: solanaCap },
}

// Reads an upstream answer up to max bytes; null when it is larger.
async function readCapped(r, max) {
  const chunks = []
  let size = 0
  for await (const c of r.body) {
    size += c.length
    if (size > max) return null
    chunks.push(c)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function proxyRpc(req, res, origin, ip, chain) {
  if (rpcLimited(ip, chain.hits)) return send(res, 429, rpcError(-32005, 'Too many requests. Try again in a minute.'), origin)
  if (Number(req.headers['content-length'] || 0) > RPC_MAX_BODY) return send(res, 413, rpcError(-32700, 'Request too large.'), origin)
  let msg
  try { msg = JSON.parse((await readBody(req, RPC_MAX_BODY, 'Request too large.')).toString('utf8')) } catch (err) {
    return send(res, err.status || 400, rpcError(-32700, err.status ? err.message : 'Parse error'), origin)
  }
  const calls = [].concat(msg)
  if (!calls.length || calls.length > RPC_MAX_BATCH || calls.some(c => !c || typeof c !== 'object' || c.jsonrpc !== '2.0' || typeof c.method !== 'string')) {
    return send(res, 400, rpcError(-32600, `Invalid request (at most ${RPC_MAX_BATCH} calls per batch).`), origin)
  }
  const refused = calls.find(c => !chain.methods.has(c.method))
  if (refused) return send(res, 400, rpcError(-32601, `${refused.method} is not available through this RPC.`), origin)
  const problem = chain.check ? calls.map(chain.check).find(Boolean) : ''
  if (problem) return send(res, 400, rpcError(-32602, problem), origin)
  const sends = calls.filter(c => c.method === 'sendTransaction').length
  if (sends && rpcLimited(ip, sendHits, SOL_SEND_RATE_MAX, sends)) return send(res, 429, rpcError(-32005, 'Too many transactions sent. Try again in a minute.'), origin)

  const body = JSON.stringify(msg)
  const cap = chain.cap ? chain.cap(calls) : Infinity
  let first
  for (const [i, url] of chain.upstreams(calls.map(c => c.method)).entries()) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(20_000) })
      if (r.status === 429 || r.status === 401 || r.status === 403 || r.status === 410 || r.status >= 500) { console.error(`${chain.log} upstream ${i} unavailable (${r.status})`); continue }
      const text = await readCapped(r, cap)
      if (text === null) return send(res, 200, rpcError(-32600, 'The result is too large. Add a dataSlice or narrower filters.'), origin)
      const j = JSON.parse(text)
      if (!unavailable(j)) return send(res, 200, j, origin)
      first ??= j
      console.error(`${chain.log} upstream ${i} unavailable (${String([].concat(j)[0].error.message).slice(0, 80)})`)
    } catch (err) {
      console.error(`${chain.log} upstream ${i} unreachable (${err.name})`)
    }
  }
  return first ? send(res, 200, first, origin) : send(res, 502, rpcError(-32603, `${chain.name} RPC is unreachable right now.`), origin)
}

const clientIp = req => {
  // The edge sets cf-connecting-ip; otherwise the last x-forwarded-for hop is the one our proxy added
  // (the first can be forged by the client).
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean)
  return String(req.headers['cf-connecting-ip'] || xff.at(-1) || req.socket.remoteAddress || '')
}

// ---------- /solana/*: the vault worker ----------

const worker = createWorker()
const VAULT_RATE_MAX = Number(process.env.VAULT_RATE_MAX || 10)
const VAULT_MAX_BODY = 2048
const VAULT_MAX_INFLIGHT = 4 // claims, collects and refunds running at once
let vaultInflight = 0
const vaultHits = new Map() // ip -> claim/collect/refund times in the last 10 minutes
const vaultReadHits = new Map() // ip -> /solana/vault and /solana/status times in the last minute
const VAULT_POSTS = {
  '/solana/claim': b => worker.claim(b.domain),
  '/solana/collect': b => worker.collect(b.domain),
  '/solana/refund': b => worker.refund(b.domain, b.signature),
}

function windowLimited(map, ip, max, window) {
  const now = Date.now()
  const recent = (map.get(ip) || []).filter(t => now - t < window)
  if (recent.length >= max) { map.set(ip, recent); return true }
  recent.push(now)
  map.set(ip, recent)
  if (map.size > 50_000) for (const [k, v] of map) if (!v.some(t => now - t < window)) map.delete(k)
  return false
}

// Refusals carry their own status and a plain reason; anything else is logged and answered without detail.
function sendFailure(res, err, origin) {
  if (err && err.refusal) return send(res, err.status, { error: err.error, reason: err.reason }, origin)
  console.error('solana vault error', err && err.stack ? err.stack : err)
  return send(res, 500, { error: 'Server error', reason: 'Something went wrong. Try again in a moment.' }, origin)
}

async function solanaRoute(req, res, origin, url) {
  const path = url.pathname
  const ip = clientIp(req)
  const isPost = !!VAULT_POSTS[path]
  if (!isPost && path !== '/solana/vault' && path !== '/solana/status') return send(res, 404, { error: 'Not found' }, origin)
  if (req.method === 'OPTIONS') {
    if (!ORIGINS.has(origin)) { res.writeHead(403); return res.end() }
    res.writeHead(204, { 'access-control-allow-origin': origin, 'access-control-allow-methods': isPost ? 'POST' : 'GET', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400', vary: 'Origin' })
    return res.end()
  }

  if (!isPost) {
    if (req.method !== 'GET') return send(res, 405, { error: 'Use GET' }, origin)
    if (rpcLimited(ip, vaultReadHits)) return send(res, 429, { error: 'Too many requests', reason: 'Try again in a minute.' }, origin)
    try {
      if (path === '/solana/status') return send(res, 200, await worker.status(), origin)
      const body = worker.vault(url.searchParams.get('domain') || '')
      // The vault of a domain never changes: cacheable for a day.
      const headers = { 'content-type': 'application/json', 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff', vary: 'Origin' }
      if (ORIGINS.has(origin)) headers['access-control-allow-origin'] = origin
      res.writeHead(200, headers)
      return res.end(JSON.stringify(body))
    } catch (err) { return sendFailure(res, err, origin) }
  }

  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST', reason: 'Send a POST with a JSON body.' }, origin)
  if (!ORIGINS.has(origin)) return send(res, 403, { error: 'Forbidden', reason: 'This site may not use the vault API.' }, origin)
  if (windowLimited(vaultHits, ip, VAULT_RATE_MAX, RATE_WINDOW)) return send(res, 429, { error: 'Too many requests', reason: 'Too many claims, collects or refunds from here. Try again in a few minutes.' }, origin)
  if (Number(req.headers['content-length'] || 0) > VAULT_MAX_BODY) return send(res, 413, { error: 'Too large', reason: 'The request is too large.' }, origin)
  if (!/^application\/json/i.test(req.headers['content-type'] || '')) return send(res, 400, { error: 'Bad request', reason: 'Send JSON.' }, origin)
  let input
  try {
    input = JSON.parse((await readBody(req, VAULT_MAX_BODY, 'The request is too large.')).toString('utf8'))
  } catch (err) {
    return send(res, err.status || 400, { error: 'Bad request', reason: err.status ? err.message : 'That is not valid JSON.' }, origin)
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return send(res, 400, { error: 'Bad request', reason: 'Send a JSON object.' }, origin)
  if (vaultInflight >= VAULT_MAX_INFLIGHT) return send(res, 503, { error: 'Busy', reason: 'The worker is busy. Try again in a moment.' }, origin)
  vaultInflight++
  try {
    return send(res, 200, await VAULT_POSTS[path](input), origin)
  } catch (err) {
    return sendFailure(res, err, origin)
  } finally {
    vaultInflight--
  }
}

const ROUTES = new Set(['/image', '/metadata', '/rpc', '/rpc/solana'])

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || ''
  const url = new URL(req.url, 'http://x')
  const path = url.pathname

  if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true, ready: !!JWT, rpc: true, solana: true, vaults: worker.ready }, origin)
  if (path.startsWith('/solana/')) return solanaRoute(req, res, origin, url)

  if (!ROUTES.has(path)) return send(res, 404, { error: 'Not found' }, origin)
  if (req.method === 'OPTIONS') {
    if (!ORIGINS.has(origin)) { res.writeHead(403); return res.end() }
    res.writeHead(204, { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400', vary: 'Origin' })
    return res.end()
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' }, origin)
  if (!ORIGINS.has(origin)) return send(res, 403, { error: 'Forbidden' }, origin)
  if (CHAINS[path]) return proxyRpc(req, res, origin, clientIp(req), CHAINS[path])
  if (!JWT) return send(res, 503, { error: path === '/metadata' ? 'Uploads are not set up yet.' : 'Uploads are not set up yet. Paste an image link instead.' }, origin)

  const ip = clientIp(req)
  if (path === '/metadata') return pinMetadata(req, res, origin, ip)
  if (rateLimited(ip)) return send(res, 429, { error: 'Too many uploads. Try again in a few minutes.' }, origin)
  if (Number(req.headers['content-length'] || 0) > MAX_BODY) return send(res, 413, { error: 'Images must be 5 MB or smaller.' }, origin)
  if (!/^multipart\/form-data/i.test(req.headers['content-type'] || '')) return send(res, 400, { error: 'Send the image as multipart/form-data.' }, origin)

  if (inflight >= MAX_INFLIGHT) return send(res, 503, { error: 'Busy right now. Try again in a moment.' }, origin)
  inflight++
  try {
    const body = await readBody(req)
    const form = await new Request('http://x/', { method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body }).formData()
    const file = form.get('image')
    if (!file || typeof file === 'string') return send(res, 400, { error: 'Choose an image.' }, origin)
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (!bytes.length || bytes.length > MAX_BYTES) return send(res, 413, { error: 'Images must be 5 MB or smaller.' }, origin)
    const format = FORMATS.find(f => f.is(bytes))
    if (!format) return send(res, 415, { error: 'Use a PNG, JPEG or WebP image.' }, origin)
    const cid = await pin(bytes, format)
    return send(res, 200, { uri: `ipfs://${cid}` }, origin)
  } catch (err) {
    return send(res, err.status || 400, { error: err.status ? err.message : 'That file could not be read.' }, origin)
  } finally {
    inflight--
  }
})
server.requestTimeout = 60_000
server.headersTimeout = 20_000
server.listen(PORT, () => console.log(`type262 upload on :${PORT} (${JWT ? 'ready' : 'PINATA_JWT not set'}; rpc: ${KEYED_RPC ? 'keyed + public' : 'public'}; solana rpc: ${SOL_KEYED ? 'keyed + public' : 'public'}; vaults: ${worker.ready ? 'ready' : `off, ${worker.problems.join(', ')}`}; origins: ${[...ORIGINS].join(', ')})`))
