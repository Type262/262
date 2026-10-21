// TYPE/262 image upload and RPC fallback. The Launch form's "Choose image" posts a file to /image; it is
// pinned to IPFS with Pinata and the token gets ipfs://<cid>, the same kind of link pons stores. /rpc is a
// read-only Robinhood Chain RPC the app falls back to when a browser can't reach the public one. Keys stay on
// the server. Zero dependencies (Node 18+).
//
//   PINATA_JWT     Pinata API key (JWT) that can upload files. Required.
//   ALLOW_ORIGINS  comma-separated origins allowed to upload (default https://type262.onrender.com)
//   RATE_MAX       uploads per IP per 10 minutes (default 12)
//   PINATA_URL     upload endpoint (default Pinata v3); tests point it at a mock
//   ROBINHOOD_RPC_URL  keyed Robinhood Chain RPC for /rpc, tried first (optional; secret, never logged)
//   PUBLIC_RPC_URL     public RPC tried after it (default https://rpc.mainnet.chain.robinhood.com)
//   RPC_RATE_MAX       /rpc requests per IP per minute (default 240)
import http from 'node:http'

const PORT = Number(process.env.PORT || 8787)
const JWT = (process.env.PINATA_JWT || '').trim()
const PINATA_URL = process.env.PINATA_URL || 'https://uploads.pinata.cloud/v3/files'
const ORIGINS = new Set((process.env.ALLOW_ORIGINS || 'https://type262.onrender.com').split(',').map(s => s.trim()).filter(Boolean))
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
function rateLimited(ip) {
  const now = Date.now()
  const recent = (hits.get(ip) || []).filter(t => now - t < RATE_WINDOW)
  if (recent.length >= RATE_MAX) { hits.set(ip, recent); return true }
  recent.push(now)
  hits.set(ip, recent)
  if (hits.size > 50_000) for (const [k, v] of hits) if (!v.some(t => now - t < RATE_WINDOW)) hits.delete(k)
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

// ---------- /rpc ----------

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
// Move on to the next upstream only when this one is unavailable, never on an ordinary error such as a revert.
const DOWN = /not enabled|unauthori|api key|forbidden|rate limit|too many requests|capacity|unavailable/i
const unavailable = j => [].concat(j).every(x => x && x.error && (x.error.code === -32005 || x.error.code === 429 || DOWN.test(String(x.error.message || ''))))
const rpcError = (code, message) => ({ jsonrpc: '2.0', id: null, error: { code, message } })

const rpcHits = new Map() // ip -> request times in the last minute
function rpcLimited(ip) {
  const now = Date.now()
  const recent = (rpcHits.get(ip) || []).filter(t => now - t < 60_000)
  recent.push(now)
  rpcHits.set(ip, recent)
  if (rpcHits.size > 50_000) for (const [k, v] of rpcHits) if (!v.some(t => now - t < 60_000)) rpcHits.delete(k)
  return recent.length > RPC_RATE_MAX
}

async function proxyRpc(req, res, origin, ip) {
  if (rpcLimited(ip)) return send(res, 429, rpcError(-32005, 'Too many requests. Try again in a minute.'), origin)
  let msg
  try { msg = JSON.parse((await readBody(req, RPC_MAX_BODY, 'Request too large.')).toString('utf8')) } catch (err) {
    return send(res, err.status || 400, rpcError(-32700, err.status ? err.message : 'Parse error'), origin)
  }
  const calls = [].concat(msg)
  if (!calls.length || calls.length > RPC_MAX_BATCH || calls.some(c => !c || typeof c !== 'object' || c.jsonrpc !== '2.0' || typeof c.method !== 'string')) {
    return send(res, 400, rpcError(-32600, `Invalid request (at most ${RPC_MAX_BATCH} calls per batch).`), origin)
  }
  const refused = calls.find(c => !READ_METHODS.has(c.method))
  if (refused) return send(res, 400, rpcError(-32601, `${refused.method} is not available through this RPC.`), origin)

  const body = JSON.stringify(msg)
  let first
  for (const [i, url] of upstreamsFor(calls.map(c => c.method)).entries()) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(20_000) })
      if (r.status === 429 || r.status === 401 || r.status === 403 || r.status >= 500) { console.error(`rpc upstream ${i} unavailable (${r.status})`); continue }
      const j = await r.json()
      if (!unavailable(j)) return send(res, 200, j, origin)
      first ??= j
      console.error(`rpc upstream ${i} unavailable (${String([].concat(j)[0].error.message).slice(0, 80)})`)
    } catch (err) {
      console.error(`rpc upstream ${i} unreachable (${err.name})`)
    }
  }
  return first ? send(res, 200, first, origin) : send(res, 502, rpcError(-32603, 'Robinhood Chain RPC is unreachable right now.'), origin)
}

const clientIp = req => {
  // The edge sets cf-connecting-ip; otherwise the last x-forwarded-for hop is the one our proxy added
  // (the first can be forged by the client).
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean)
  return String(req.headers['cf-connecting-ip'] || xff.at(-1) || req.socket.remoteAddress || '')
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || ''
  const path = new URL(req.url, 'http://x').pathname

  if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true, ready: !!JWT, rpc: true }, origin)

  if (path !== '/image' && path !== '/rpc') return send(res, 404, { error: 'Not found' }, origin)
  if (req.method === 'OPTIONS') {
    if (!ORIGINS.has(origin)) { res.writeHead(403); return res.end() }
    res.writeHead(204, { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400', vary: 'Origin' })
    return res.end()
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' }, origin)
  if (!ORIGINS.has(origin)) return send(res, 403, { error: 'Forbidden' }, origin)
  if (path === '/rpc') return proxyRpc(req, res, origin, clientIp(req))
  if (!JWT) return send(res, 503, { error: 'Uploads are not set up yet. Paste an image link instead.' }, origin)

  const ip = clientIp(req)
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
server.listen(PORT, () => console.log(`type262 upload on :${PORT} (${JWT ? 'ready' : 'PINATA_JWT not set'}; rpc: ${KEYED_RPC ? 'keyed + public' : 'public'}; origins: ${[...ORIGINS].join(', ')})`))
