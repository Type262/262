// TYPE/262 image upload. The Launch form's "Choose image" posts a file here; it is pinned to IPFS with
// Pinata and the token gets ipfs://<cid>, the same kind of link pons stores. The Pinata key stays on the
// server. Zero dependencies (Node 18+).
//
//   PINATA_JWT     Pinata API key (JWT) that can upload files. Required.
//   ALLOW_ORIGINS  comma-separated origins allowed to upload (default https://type262.onrender.com)
//   RATE_MAX       uploads per IP per 10 minutes (default 12)
//   PINATA_URL     upload endpoint (default Pinata v3); tests point it at a mock
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', c => {
      size += c.length
      if (size > MAX_BODY) { reject(Object.assign(new Error('Images must be 5 MB or smaller.'), { status: 413 })); req.destroy(); return }
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

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || ''
  const path = new URL(req.url, 'http://x').pathname

  if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true, ready: !!JWT }, origin)

  if (path !== '/image') return send(res, 404, { error: 'Not found' }, origin)
  if (req.method === 'OPTIONS') {
    if (!ORIGINS.has(origin)) { res.writeHead(403); return res.end() }
    res.writeHead(204, { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400', vary: 'Origin' })
    return res.end()
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' }, origin)
  if (!ORIGINS.has(origin)) return send(res, 403, { error: 'Forbidden' }, origin)
  if (!JWT) return send(res, 503, { error: 'Uploads are not set up yet. Paste an image link instead.' }, origin)

  // The edge sets cf-connecting-ip; otherwise the last x-forwarded-for hop is the one our proxy added
  // (the first can be forged by the client).
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean)
  const ip = String(req.headers['cf-connecting-ip'] || xff.at(-1) || req.socket.remoteAddress || '')
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
server.listen(PORT, () => console.log(`type262 upload on :${PORT} (${JWT ? 'ready' : 'PINATA_JWT not set'}; origins: ${[...ORIGINS].join(', ')})`))
