// End-to-end test of upload/server.mjs against a mock Pinata: formats, limits, origins, CORS, rate limit.
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const pinned = []
const mock = http.createServer((req, res) => {
  let size = 0
  req.on('data', c => (size += c.length)).on('end', () => {
    pinned.push({ auth: req.headers.authorization, size })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: { cid: 'bafkreimockcid' + pinned.length } }))
  })
}).listen(0)
await new Promise(r => mock.once('listening', r))

const PORT = 18000 + Math.floor(Math.random() * 1000)
const server = spawn(process.execPath, [fileURLToPath(new URL('../upload/server.mjs', import.meta.url))], {
  env: { ...process.env, PORT: String(PORT), PINATA_JWT: 'test-jwt', PINATA_URL: `http://127.0.0.1:${mock.address().port}/`, ALLOW_ORIGINS: 'https://type262.onrender.com', RATE_MAX: '5' },
  stdio: ['ignore', 'pipe', 'inherit'],
})
await new Promise(r => server.stdout.once('data', r))
const url = `http://127.0.0.1:${PORT}`
const ORIGIN = 'https://type262.onrender.com'

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
const upload = (bytes, { origin = ORIGIN, type = 'image/png', field = 'image' } = {}) => {
  const form = new FormData()
  form.append(field, new Blob([bytes], { type }), 'x.png')
  return fetch(`${url}/image`, { method: 'POST', headers: origin ? { origin } : {}, body: form })
}
let checks = 0
const ok = (cond, msg) => { assert.ok(cond, msg); checks++ }

try {
  const health = await (await fetch(`${url}/health`)).json()
  ok(health.ok && health.ready, 'health reports ready')

  const r1 = await upload(png)
  const j1 = await r1.json()
  ok(r1.status === 200 && j1.uri === 'ipfs://bafkreimockcid1', 'PNG pins and returns ipfs://<cid>')
  ok(r1.headers.get('access-control-allow-origin') === ORIGIN, 'CORS allows the app origin')
  ok(pinned[0].auth === 'Bearer test-jwt', 'Pinata gets the server-side key')

  const pre = await fetch(`${url}/image`, { method: 'OPTIONS', headers: { origin: ORIGIN, 'access-control-request-method': 'POST' } })
  ok(pre.status === 204 && pre.headers.get('access-control-allow-methods') === 'POST', 'preflight answered for the app origin')
  const preBad = await fetch(`${url}/image`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } })
  ok(preBad.status === 403, 'preflight refused for other origins')

  const evil = await upload(png, { origin: 'https://evil.example' })
  ok(evil.status === 403 && !evil.headers.get('access-control-allow-origin'), 'other origins are refused')
  const none = await upload(png, { origin: '' })
  ok(none.status === 403, 'requests without an origin are refused')

  const html = await upload(new TextEncoder().encode('<html><script>alert(1)</script></html>'), { type: 'image/png' })
  ok(html.status === 415, 'non-images are refused even when labelled image/png')
  const svg = await upload(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), { type: 'image/svg+xml' })
  ok(svg.status === 415, 'SVG is refused')
  const big = await upload(new Uint8Array(5 * 1024 * 1024 + 10).fill(1))
  ok(big.status === 413, 'files over 5 MB are refused')
  const nofile = await upload(png, { field: 'other' })
  ok(nofile.status === 400, 'a missing image field is refused')

  // RATE_MAX=5: one PNG pinned and the rest refused before the limit check except valid-origin attempts
  const statuses = []
  for (let i = 0; i < 6; i++) statuses.push((await upload(png)).status)
  ok(statuses.includes(429), `rate limit kicks in (statuses ${statuses.join(',')})`)

  console.log(`upload: ${checks} checks passed`)
} finally {
  server.kill()
  mock.close()
}
