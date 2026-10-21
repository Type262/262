// End-to-end test of upload/server.mjs against a mock Pinata and mock RPC upstreams: formats, limits, origins,
// CORS, rate limits, and the read-only /rpc fallback.
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

// Two RPC upstreams: a keyed provider whose behaviour each check sets, and the public node.
const seen = []
let keyedMode = 'not-enabled'
const rpcMock = name => http.createServer((req, res) => {
  let body = ''
  req.on('data', c => (body += c)).on('end', () => {
    const msg = JSON.parse(body)
    const calls = [].concat(msg)
    seen.push(`${name}:${calls.map(c => c.method).join('+')}`)
    const reply = (status, make) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(Array.isArray(msg) ? calls.map(make) : make(calls[0]))) }
    if (name === 'keyed') {
      if (keyedMode === 'down') return reply(500, c => ({ jsonrpc: '2.0', id: c.id, error: { code: -32603, message: 'internal' } }))
      if (keyedMode === 'not-enabled') return reply(200, c => ({ jsonrpc: '2.0', id: c.id, error: { code: -32600, message: 'ROBINHOOD_MAINNET is not enabled for this app.' } }))
      if (keyedMode === 'revert') return reply(200, c => ({ jsonrpc: '2.0', id: c.id, error: { code: 3, message: 'execution reverted' } }))
      return reply(200, c => ({ jsonrpc: '2.0', id: c.id, result: 'keyed' }))
    }
    if (publicDown) return reply(503, c => ({ jsonrpc: '2.0', id: c.id, error: { code: -32603, message: 'down' } }))
    reply(200, c => ({ jsonrpc: '2.0', id: c.id, result: c.method === 'eth_chainId' ? '0x1237' : 'public' }))
  })
}).listen(0)
let publicDown = false
const keyed = rpcMock('keyed'), pub = rpcMock('public')
await Promise.all([keyed, pub].map(s => new Promise(r => s.once('listening', r))))
const SECRET = 'test-rpc-key-0123'

const PORT = 18000 + Math.floor(Math.random() * 1000)
const server = spawn(process.execPath, [fileURLToPath(new URL('../upload/server.mjs', import.meta.url))], {
  env: {
    ...process.env, PORT: String(PORT), PINATA_JWT: 'test-jwt', PINATA_URL: `http://127.0.0.1:${mock.address().port}/`, ALLOW_ORIGINS: 'https://type262.onrender.com', RATE_MAX: '5',
    ROBINHOOD_RPC_URL: `http://127.0.0.1:${keyed.address().port}/v2/${SECRET}`, PUBLIC_RPC_URL: `http://127.0.0.1:${pub.address().port}/`, RPC_RATE_MAX: '40',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let logs = ''
server.stdout.on('data', d => (logs += d))
server.stderr.on('data', d => (logs += d))
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

  // ---------- /rpc ----------
  const rpc = async (body, origin = ORIGIN) => {
    const r = await fetch(`${url}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json', ...(origin && { origin }) }, body: typeof body === 'string' ? body : JSON.stringify(body) })
    return { status: r.status, cors: r.headers.get('access-control-allow-origin'), json: await r.json().catch(() => null) }
  }
  const call = (method, id = 1) => ({ jsonrpc: '2.0', id, method, params: [] })
  const order = () => seen.splice(0).join(' > ')

  let r = await rpc(call('eth_chainId'))
  ok(r.status === 200 && r.json.result === '0x1237' && r.cors === ORIGIN, 'rpc: answers through the public node when the keyed one is not enabled')
  ok(order() === 'keyed:eth_chainId > public:eth_chainId', 'rpc: tries the keyed upstream first, then the public one')
  keyedMode = 'ok'
  r = await rpc(call('eth_blockNumber'))
  ok(r.json.result === 'keyed' && order() === 'keyed:eth_blockNumber', 'rpc: uses the keyed upstream when it works')
  r = await rpc(call('eth_getLogs'))
  ok(r.json.result === 'public' && order() === 'public:eth_getLogs', 'rpc: log queries go to the public node first')
  keyedMode = 'revert'
  r = await rpc(call('eth_call'))
  ok(r.json.error && r.json.error.code === 3 && order() === 'keyed:eth_call', 'rpc: an ordinary error such as a revert is returned, not retried')
  keyedMode = 'down'
  r = await rpc([call('eth_call', 1), call('eth_chainId', 2)])
  ok(Array.isArray(r.json) && r.json[1].result === '0x1237' && order() === 'keyed:eth_call+eth_chainId > public:eth_call+eth_chainId', 'rpc: a batch falls through a failing upstream')
  publicDown = true
  r = await rpc(call('eth_chainId'))
  ok(r.status === 502 && r.json.error.code === -32603, 'rpc: 502 when every upstream is down')
  publicDown = false
  order()

  r = await rpc({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: ['0x00'] })
  ok(r.status === 400 && r.json.error.code === -32601 && order() === '', 'rpc: write methods are refused before any upstream')
  r = await rpc([call('eth_chainId'), { jsonrpc: '2.0', id: 2, method: 'eth_sign', params: [] }])
  ok(r.status === 400 && order() === '', 'rpc: a batch with one write method is refused')
  r = await rpc(Array.from({ length: 51 }, (_, i) => call('eth_chainId', i)))
  ok(r.status === 400 && r.json.error.code === -32600, 'rpc: batches over 50 calls are refused')
  r = await rpc('{not json')
  ok(r.status === 400 && r.json.error.code === -32700, 'rpc: invalid JSON is refused')
  r = await rpc(call('eth_chainId'), 'https://evil.example')
  ok(r.status === 403 && !r.cors, 'rpc: other origins are refused')
  r = await rpc(call('eth_chainId'), '')
  ok(r.status === 403, 'rpc: requests without an origin are refused')
  const preRpc = await fetch(`${url}/rpc`, { method: 'OPTIONS', headers: { origin: ORIGIN, 'access-control-request-method': 'POST' } })
  ok(preRpc.status === 204, 'rpc: preflight answered for the app origin')
  order()

  // RPC_RATE_MAX=40 per minute; the checks above used 9 of them
  let limited = 0
  for (let i = 0; i < 40 && !limited; i++) if ((await rpc(call('eth_chainId'))).status === 429) limited = i
  ok(limited > 0, 'rpc: the per-IP rate limit applies')
  ok(!logs.includes(SECRET), 'rpc: the keyed upstream URL never appears in the logs')

  console.log(`upload: ${checks} checks passed`)
} finally {
  server.kill()
  mock.close()
  keyed.close()
  pub.close()
}
