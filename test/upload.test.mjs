// End-to-end test of upload/server.mjs against a mock Pinata and mock RPC upstreams: formats, limits, origins,
// CORS, rate limits, the read-only /rpc fallback, /rpc/solana and /metadata.
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const pinned = []
const mock = http.createServer((req, res) => {
  let size = 0
  const chunks = []
  req.on('data', c => { size += c.length; chunks.push(c) }).on('end', () => {
    pinned.push({ auth: req.headers.authorization, size, body: Buffer.concat(chunks).toString('utf8') })
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

// Three Solana upstreams: a keyed provider, then two public nodes; each check sets how they behave.
const solSeen = []
const solMode = { keyed: 'ok', node1: 'ok', node2: 'ok' }
let lastSend = null
const solMock = name => http.createServer((req, res) => {
  let body = ''
  req.on('data', c => (body += c)).on('end', () => {
    const msg = JSON.parse(body)
    const calls = [].concat(msg)
    solSeen.push(`${name}:${calls.map(c => c.method).join('+')}`)
    if (calls.some(c => c.method === 'sendTransaction')) lastSend = body
    const reply = (status, make) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(Array.isArray(msg) ? calls.map(make) : make(calls[0]))) }
    const mode = solMode[name]
    if (mode === 'auth') return reply(401, c => ({ jsonrpc: '2.0', id: c.id, error: { code: -32401, message: 'invalid api key provided' } }))
    if (mode === 'rate') return reply(429, c => ({ jsonrpc: '2.0', id: c.id, error: { code: 429, message: 'Too many requests' } }))
    if (mode === 'down') return reply(503, c => ({ jsonrpc: '2.0', id: c.id, error: { code: -32603, message: 'down' } }))
    if (mode === 'max10') return reply(200, c => ({ jsonrpc: '2.0', id: c.id, error: { code: -32602, message: 'A maximum of 10 accounts is allowed. No limit on a dedicated node: https://example.com' } }))
    if (mode === 'param') return reply(200, c => ({ jsonrpc: '2.0', id: c.id, error: { code: -32602, message: 'Invalid param: WrongSize' } }))
    reply(200, c => {
      // a large result for getProgramAccounts with memcmp bytes "big"
      if (c.method === 'getProgramAccounts' && c.params[1].filters.some(f => f.memcmp && f.memcmp.bytes === 'big')) {
        return { jsonrpc: '2.0', id: c.id, result: Array.from({ length: 300 }, (_, i) => ({ pubkey: `acct${i}`, account: { data: ['A'.repeat(1200), 'base64'] } })) }
      }
      return { jsonrpc: '2.0', id: c.id, result: c.method === 'getSlot' ? 123 : name }
    })
  })
}).listen(0)
const solKeyed = solMock('keyed'), node1 = solMock('node1'), node2 = solMock('node2')
await Promise.all([solKeyed, node1, node2].map(s => new Promise(r => s.once('listening', r))))
const SOL_SECRET = 'test-solana-key-4567'

// DNS-over-HTTPS for the vault worker: every name exists, DNSSEC-signed, and publishes nothing.
const doh = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/dns-json' })
  res.end(JSON.stringify({ Status: 0, AD: true }))
}).listen(0)
await new Promise(r => doh.once('listening', r))
// A throwaway vault master secret (bytes 0..31): test/vault.test.mjs has the addresses it derives.
const VAULT_MASTER = Buffer.from([...Array(32).keys()]).toString('hex')
const VAULT_SEEDS = ['49f25787286ede4d3e25d2607ce2094eddd62ff8bebe924bb43d61644fe150e2', '03cdead0442882be0d87eb7dc9d1390a18fff25eaf06be58d664d15845f0af33']
const FEE_WALLET = '9jB2PjvwWUUAZHfo3D5eLpc7Vc9z64pBxRwKvtG9F8ke'

const PORT = 18000 + Math.floor(Math.random() * 1000)
const server = spawn(process.execPath, [fileURLToPath(new URL('../upload/server.mjs', import.meta.url))], {
  env: {
    ...process.env, PORT: String(PORT), PINATA_JWT: 'test-jwt', PINATA_URL: `http://127.0.0.1:${mock.address().port}/`, ALLOW_ORIGINS: 'https://type262.onrender.com', RATE_MAX: '5',
    ROBINHOOD_RPC_URL: `http://127.0.0.1:${keyed.address().port}/v2/${SECRET}`, PUBLIC_RPC_URL: `http://127.0.0.1:${pub.address().port}/`, RPC_RATE_MAX: '40',
    SOLANA_RPC_URL: `http://127.0.0.1:${solKeyed.address().port}/?api-key=${SOL_SECRET}`, SOL_SEND_RATE_MAX: '3',
    SOLANA_PUBLIC_RPC_URLS: `http://127.0.0.1:${node1.address().port}/,http://127.0.0.1:${node2.address().port}/`,
    VAULT_MASTER_SEED: VAULT_MASTER, SOLANA_FEE_WALLET: FEE_WALLET, FEE_BPS: '50', REFUND_DELAY_DAYS: '180', VAULT_RATE_MAX: '6',
    DOH_RESOLVERS: `http://127.0.0.1:${doh.address().port}/dns-query,http://127.0.0.1:${doh.address().port}/resolve`, SOLANA_USDC_MINT: '',
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

  // ---------- /rpc/solana ----------
  // Each group uses its own client address (the last x-forwarded-for hop), so the per-IP limits stay apart.
  const sol = async (body, { origin = ORIGIN, ip = '10.1.0.1' } = {}) => {
    const r = await fetch(`${url}/rpc/solana`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...(origin && { origin }) }, body: typeof body === 'string' ? body : JSON.stringify(body) })
    return { status: r.status, cors: r.headers.get('access-control-allow-origin'), json: await r.json().catch(() => null) }
  }
  const scall = (method, params = [], id = 1) => ({ jsonrpc: '2.0', id, method, params })
  const sorder = () => solSeen.splice(0).join(' > ')

  r = await sol(scall('getSlot'))
  ok(r.status === 200 && r.json.result === 123 && r.cors === ORIGIN && sorder() === 'keyed:getSlot', 'solana: uses the keyed upstream when it works')
  solMode.keyed = 'auth'
  r = await sol(scall('getBalance', ['11111111111111111111111111111111']))
  ok(r.json.result === 'node1' && sorder() === 'keyed:getBalance > node1:getBalance', 'solana: an auth failure on the keyed upstream falls through to the first public node')
  solMode.keyed = 'rate'
  solMode.node1 = 'down'
  r = await sol(scall('getLatestBlockhash'))
  ok(r.json.result === 'node2' && sorder() === 'keyed:getLatestBlockhash > node1:getLatestBlockhash > node2:getLatestBlockhash', 'solana: rate limits and 5xx fall through to the second public node')
  solMode.keyed = 'down'
  solMode.node1 = 'max10'
  r = await sol(scall('getMultipleAccounts', [Array.from({ length: 20 }, () => '11111111111111111111111111111111')]))
  ok(r.json.result === 'node2' && sorder() === 'keyed:getMultipleAccounts > node1:getMultipleAccounts > node2:getMultipleAccounts', 'solana: a provider limit that a dedicated node lifts falls through')
  solMode.keyed = 'param'
  solMode.node1 = 'ok'
  r = await sol(scall('getAccountInfo', ['x']))
  ok(r.status === 200 && r.json.error.code === -32602 && sorder() === 'keyed:getAccountInfo', 'solana: an ordinary JSON-RPC error is returned, not retried')
  solMode.keyed = 'ok'
  r = await sol([scall('getSlot', [], 1), scall('getBlockTime', [5], 2)])
  ok(Array.isArray(r.json) && r.json[0].result === 123 && sorder() === 'keyed:getSlot+getBlockTime', 'solana: batches of read methods are relayed')
  Object.assign(solMode, { keyed: 'down', node1: 'down', node2: 'down' })
  r = await sol(scall('getSlot'))
  ok(r.status === 502 && r.json.error.code === -32603 && /Solana/.test(r.json.error.message), 'solana: 502 when every upstream is down')
  Object.assign(solMode, { keyed: 'ok', node1: 'ok', node2: 'ok' })
  sorder()

  for (const method of ['requestAirdrop', 'accountSubscribe', 'programSubscribe', 'getBlock', 'getLargestAccounts', 'getInflationReward']) {
    r = await sol(scall(method, []), { ip: '10.1.0.2' })
    ok(r.status === 400 && r.json.error.code === -32601 && sorder() === '', `solana: ${method} is refused before any upstream`)
  }
  r = await sol([scall('getSlot'), scall('requestAirdrop', ['x', 1], 2)], { ip: '10.1.0.2' })
  ok(r.status === 400 && sorder() === '', 'solana: a batch with one refused method is refused')
  const program = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
  r = await sol(scall('getProgramAccounts', [program]), { ip: '10.1.0.2' })
  ok(r.status === 400 && r.json.error.code === -32602 && sorder() === '', 'solana: getProgramAccounts without filters is refused')
  r = await sol(scall('getProgramAccounts', [program, { filters: [{ dataSize: 165 }] }]), { ip: '10.1.0.2' })
  ok(r.status === 400 && sorder() === '', 'solana: getProgramAccounts with only a dataSize filter is refused')
  r = await sol(scall('getProgramAccounts', [program, { filters: [{ memcmp: { offset: 0, bytes: 'abc' } }], dataSlice: { offset: 0, length: 5000 } }]), { ip: '10.1.0.2' })
  ok(r.status === 400 && sorder() === '', 'solana: getProgramAccounts with a dataSlice over 1024 bytes is refused')
  r = await sol(scall('getProgramAccounts', [program, { filters: [{ dataSize: 165 }, { memcmp: { offset: 32, bytes: 'abc' } }] }]), { ip: '10.1.0.2' })
  ok(r.status === 200 && r.json.result === 'keyed' && sorder() === 'keyed:getProgramAccounts', 'solana: getProgramAccounts with a memcmp filter and a small result is relayed')
  r = await sol(scall('getProgramAccounts', [program, { filters: [{ memcmp: { offset: 32, bytes: 'big' } }] }]), { ip: '10.1.0.2' })
  ok(r.status === 200 && r.json.error && /dataSlice/.test(r.json.error.message) && sorder() === 'keyed:getProgramAccounts', 'solana: a large getProgramAccounts result without a dataSlice is refused')
  r = await sol(scall('getProgramAccounts', [program, { filters: [{ memcmp: { offset: 32, bytes: 'big' } }], dataSlice: { offset: 0, length: 64 } }]), { ip: '10.1.0.2' })
  ok(r.status === 200 && Array.isArray(r.json.result) && r.json.result.length === 300, 'solana: a large getProgramAccounts result with a dataSlice is relayed')
  sorder()

  const signed = 'AQ' + 'A'.repeat(200)
  r = await sol(scall('sendTransaction', [signed, { encoding: 'base64', skipPreflight: false }]), { ip: '10.1.0.3' })
  ok(r.status === 200 && r.json.result === 'keyed' && JSON.parse(lastSend).params[0] === signed && sorder() === 'keyed:sendTransaction', 'solana: sendTransaction relays the signed transaction unchanged')
  r = await sol(scall('sendTransaction', [{ not: 'a transaction' }]), { ip: '10.1.0.3' })
  ok(r.status === 400 && r.json.error.code === -32602 && sorder() === '', 'solana: sendTransaction without an encoded transaction is refused')
  r = await sol(scall('sendTransaction', ['A'.repeat(3000)]), { ip: '10.1.0.3' })
  ok(r.status === 400 && sorder() === '', 'solana: an oversized transaction is refused')
  const sends = []
  for (let i = 0; i < 3; i++) sends.push((await sol(scall('sendTransaction', [signed]), { ip: '10.1.0.3' })).status)
  ok(sends.join(',') === '200,200,429', `solana: sendTransaction has a tighter per-IP limit (statuses ${sends.join(',')})`)
  r = await sol(scall('getSlot'), { ip: '10.1.0.3' })
  ok(r.status === 200 && r.json.result === 123, 'solana: reads still work after the send limit is reached')
  r = await sol([scall('sendTransaction', [signed], 1), scall('sendTransaction', [signed], 2), scall('sendTransaction', [signed], 3), scall('sendTransaction', [signed], 4)], { ip: '10.1.0.4' })
  ok(r.status === 429, 'solana: every sendTransaction in a batch counts toward the limit')
  sorder()

  r = await sol(scall('getSlot'), { origin: 'https://evil.example' })
  ok(r.status === 403 && !r.cors && sorder() === '', 'solana: other origins are refused')
  r = await sol(scall('getSlot'), { origin: '' })
  ok(r.status === 403, 'solana: requests without an origin are refused')
  r = await sol('{not json')
  ok(r.status === 400 && r.json.error.code === -32700, 'solana: invalid JSON is refused')
  r = await sol(JSON.stringify(scall('getAccountInfo', ['x'.repeat(70 * 1024)])))
  ok(r.status === 413, 'solana: bodies over 64 KB are refused')
  const preSol = await fetch(`${url}/rpc/solana`, { method: 'OPTIONS', headers: { origin: ORIGIN, 'access-control-request-method': 'POST' } })
  ok(preSol.status === 204 && preSol.headers.get('access-control-allow-origin') === ORIGIN, 'solana: preflight answered for the app origin')
  sorder()

  // RPC_RATE_MAX=40 per minute for /rpc/solana too, counted apart from /rpc
  limited = 0
  for (let i = 0; i < 45 && !limited; i++) if ((await sol(scall('getSlot'), { ip: '10.1.0.5' })).status === 429) limited = i
  ok(limited === 40, `solana: the per-IP rate limit applies after 40 requests (limited at ${limited})`)
  ok(!logs.includes(SOL_SECRET), 'solana: the keyed upstream URL never appears in the logs')
  ok(/solana rpc upstream 0 unavailable/.test(logs), 'solana: fall-through is logged by upstream index')

  // ---------- /metadata ----------
  const meta = async (body, { origin = ORIGIN, ip = '10.2.0.1', type = 'application/json' } = {}) => {
    const r = await fetch(`${url}/metadata`, { method: 'POST', headers: { 'content-type': type, 'x-forwarded-for': ip, ...(origin && { origin }) }, body: typeof body === 'string' ? body : JSON.stringify(body) })
    return { status: r.status, cors: r.headers.get('access-control-allow-origin'), json: await r.json().catch(() => null) }
  }
  const imageCid = 'bafkreigdgpdcjfwilym43gsfvqnu2rssbhbuwwhwm7nqf3fn6iprhj2lla'
  const good = { name: 'Example Coin', symbol: 'EXMPL', description: 'Line one\nline two', image: `ipfs://${imageCid}`, twitter: 'https://x.com/example', telegram: 'https://t.me/example', website: 'https://example.com', showName: true }
  let pins = pinned.length
  r = await meta(good)
  ok(r.status === 200 && r.json.uri === `https://ipfs.io/ipfs/bafkreimockcid${pins + 1}` && r.json.cid === `bafkreimockcid${pins + 1}` && r.cors === ORIGIN, 'metadata: pins and returns an https://ipfs.io/ipfs/<cid> URI, as pump.fun coins use')
  const sent = pinned.at(-1)
  const pinnedJson = JSON.parse(sent.body.match(/\{"name".*\}/)[0])
  ok(sent.auth === 'Bearer test-jwt' && /content-type: application\/json/i.test(sent.body), 'metadata: Pinata gets the server-side key and a JSON file')
  ok(JSON.stringify(Object.keys(pinnedJson)) === JSON.stringify(['name', 'symbol', 'description', 'showName', 'image', 'createdOn', 'twitter', 'telegram', 'website']), 'metadata: the pinned JSON has pump.fun\'s fields in pump.fun\'s order')
  ok(pinnedJson.showName === true && pinnedJson.image === `https://ipfs.io/ipfs/${imageCid}` && pinnedJson.createdOn === ORIGIN && pinnedJson.description === 'Line one\nline two', 'metadata: showName is true, an ipfs:// image becomes a gateway link, createdOn is the app')
  r = await meta({ name: 'Plain', symbol: 'PLN', image: 'https://example.com/coin.png' }, { ip: '10.2.0.2' })
  const plain = JSON.parse(pinned.at(-1).body.match(/\{"name".*\}/)[0])
  ok(r.status === 200 && plain.image === 'https://example.com/coin.png' && plain.description === '' && !('twitter' in plain), 'metadata: a plain https image is kept and empty socials are left out')
  r = await meta({ name: 'Gate', symbol: 'GT', image: `https://ipfs.io/ipfs/${imageCid}` }, { ip: '10.2.0.2' })
  ok(r.status === 200, 'metadata: an https gateway image link is accepted')

  pins = pinned.length
  const refusals = [
    [{ ...good, name: 'x'.repeat(33) }, 'a name over 32 bytes'],
    [{ ...good, name: 'é'.repeat(17) }, 'a name over 32 bytes in UTF-8'],
    [{ ...good, name: '' }, 'an empty name'],
    [{ ...good, name: 'bad\u0000name' }, 'a name with control characters'],
    [{ ...good, symbol: 'ABCDEFGHIJK' }, 'a symbol over 10 bytes'],
    [{ ...good, symbol: undefined }, 'a missing symbol'],
    [{ ...good, description: 'd'.repeat(1001) }, 'a description over 1000 characters'],
    [{ ...good, image: undefined }, 'a missing image'],
    [{ ...good, image: 'http://example.com/a.png' }, 'an http image'],
    [{ ...good, image: 'javascript:alert(1)' }, 'a javascript: image'],
    [{ ...good, image: 'ipfs://not a cid' }, 'a malformed ipfs:// image'],
    [{ ...good, image: 'https://user:pass@example.com/a.png' }, 'an image link with credentials'],
    [{ ...good, twitter: 'http://x.com/example' }, 'an http twitter link'],
    [{ ...good, telegram: 'tg://resolve?domain=x' }, 'a non-https telegram link'],
    [{ ...good, website: 'https://' + 'a'.repeat(200) + '.com' }, 'a website over 200 characters'],
    [{ ...good, showName: false }, 'showName false'],
    [{ ...good, creator: 'someone' }, 'an unknown field'],
    [{ ...good, name: 42 }, 'a non-text name'],
    [[good], 'an array'],
  ]
  for (const [i, [body, what]] of refusals.entries()) {
    r = await meta(body, { ip: `10.3.0.${i}` })
    ok(r.status === 400 && typeof r.json.error === 'string', `metadata: refuses ${what}`)
  }
  r = await meta('{not json', { ip: '10.3.1.1' })
  ok(r.status === 400, 'metadata: invalid JSON is refused')
  r = await meta(good, { ip: '10.3.1.2', type: 'text/plain' })
  ok(r.status === 400, 'metadata: a body that is not application/json is refused')
  r = await meta({ ...good, description: 'd'.repeat(9000) }, { ip: '10.3.1.3' })
  ok(r.status === 413, 'metadata: bodies over 8 KB are refused')
  ok(pinned.length === pins, 'metadata: nothing invalid reaches Pinata')

  r = await meta(good, { origin: 'https://evil.example', ip: '10.3.2.1' })
  ok(r.status === 403 && !r.cors, 'metadata: other origins are refused')
  r = await meta(good, { origin: '', ip: '10.3.2.1' })
  ok(r.status === 403, 'metadata: requests without an origin are refused')
  const preMeta = await fetch(`${url}/metadata`, { method: 'OPTIONS', headers: { origin: ORIGIN, 'access-control-request-method': 'POST' } })
  ok(preMeta.status === 204, 'metadata: preflight answered for the app origin')

  // RATE_MAX=5 per 10 minutes, counted apart from /image
  const metaStatuses = []
  for (let i = 0; i < 6; i++) metaStatuses.push((await meta(good, { ip: '10.4.0.1' })).status)
  ok(metaStatuses.join(',') === '200,200,200,200,200,429', `metadata: the per-IP rate limit applies (statuses ${metaStatuses.join(',')})`)

  const health2 = await (await fetch(`${url}/health`)).json()
  ok(health2.solana === true, 'health reports the Solana RPC')

  // ---------- /solana/*: the vault worker ----------
  let answers = ''
  const vreq = async (path, { method = 'GET', body, origin = ORIGIN, ip = '10.6.0.1', type = 'application/json' } = {}) => {
    const r = await fetch(`${url}${path}`, { method, headers: { 'x-forwarded-for': ip, ...(origin && { origin }), ...(body !== undefined && { 'content-type': type }) }, ...(body !== undefined && { body: typeof body === 'string' ? body : JSON.stringify(body) }) })
    const text = await r.text()
    answers += text
    let json = null
    try { json = JSON.parse(text) } catch {}
    return { status: r.status, cors: r.headers.get('access-control-allow-origin'), cache: r.headers.get('cache-control'), json }
  }
  ok(health2.vaults === true, 'vaults: health reports them ready')
  ok(/vaults: ready/.test(logs), 'vaults: the start line says ready')

  r = await vreq('/solana/vault?domain=Example.COM')
  ok(r.status === 200 && r.json.domain === 'example.com' && r.json.vault === '2dGV8mm5coiXgXATUaBUatv55hHctzJFtZ6V8PyFkjuH' && r.cors === ORIGIN, 'vaults: GET /solana/vault derives the domain\'s vault')
  ok(r.json.usdcAccount === 'FeZUhukDU63qgGHrRZEFjuQiH1oMwDmF2PQipyekHifD' && Object.keys(r.json).join() === 'domain,vault,usdcAccount', 'vaults: with its USDC account (ATA of the vault for Circle\'s USDC), nothing else')
  ok(/max-age=86400/.test(r.cache), 'vaults: a vault address is cacheable')
  r = await vreq('/solana/vault?domain=https://example.com/path', { origin: '' })
  ok(r.status === 200 && r.json.vault === '2dGV8mm5coiXgXATUaBUatv55hHctzJFtZ6V8PyFkjuH' && !r.cors, 'vaults: GET works without an origin (no CORS header), any spelling of the domain')
  for (const q of ['', '?domain=', '?domain=not%20a%20domain', '?domain=localhost']) {
    r = await vreq(`/solana/vault${q}`)
    ok(r.status === 400 && r.json.error === 'Bad domain' && typeof r.json.reason === 'string', `vaults: GET /solana/vault${q} is refused`)
  }
  r = await vreq('/solana/status')
  ok(r.status === 200 && r.json.gasWallet === 'Ft2NCKQvC744yELosSfm3uZjXYaA7snFXJT3D5wfTRmG' && r.json.feeWallet === FEE_WALLET && r.json.feeBps === 50 && r.json.refundDelayDays === 180 && typeof r.json.gasLamports === 'string', 'vaults: GET /solana/status')

  r = await vreq('/solana/claim', { method: 'OPTIONS', origin: ORIGIN })
  ok(r.status === 204 && r.cors === ORIGIN, 'vaults: preflight answered for the app origin')
  r = await vreq('/solana/claim', { method: 'OPTIONS', origin: 'https://evil.example' })
  ok(r.status === 403, 'vaults: preflight refused for other origins')
  for (const path of ['/solana/claim', '/solana/collect', '/solana/refund']) {
    r = await vreq(path, { method: 'POST', body: { domain: 'example.com' }, origin: 'https://evil.example', ip: '10.6.1.1' })
    ok(r.status === 403 && !r.cors && r.json.error === 'Forbidden' && r.json.reason, `vaults: ${path} refuses other origins`)
    r = await vreq(path, { method: 'POST', body: { domain: 'example.com' }, origin: '', ip: '10.6.1.1' })
    ok(r.status === 403, `vaults: ${path} refuses requests without an origin`)
  }
  ok((await vreq('/solana/claim')).status === 405, 'vaults: GET /solana/claim is refused')
  ok((await vreq('/solana/vault', { method: 'POST', body: {} })).status === 405, 'vaults: POST /solana/vault is refused')
  ok((await vreq('/solana/nope')).status === 404, 'vaults: unknown paths are 404')

  r = await vreq('/solana/claim', { method: 'POST', body: 'domain=example.com', type: 'text/plain', ip: '10.6.2.1' })
  ok(r.status === 400 && r.json.reason, 'vaults: a body that is not JSON is refused')
  r = await vreq('/solana/claim', { method: 'POST', body: '{nope', ip: '10.6.2.2' })
  ok(r.status === 400 && r.json.reason === 'That is not valid JSON.', 'vaults: invalid JSON is refused')
  r = await vreq('/solana/claim', { method: 'POST', body: ['example.com'], ip: '10.6.2.3' })
  ok(r.status === 400, 'vaults: a JSON array is refused')
  r = await vreq('/solana/claim', { method: 'POST', body: { domain: 'x'.repeat(3000) }, ip: '10.6.2.4' })
  ok(r.status === 413, 'vaults: bodies over 2 KB are refused')
  r = await vreq('/solana/claim', { method: 'POST', body: { domain: 'not a domain' }, ip: '10.6.2.5' })
  ok(r.status === 400 && r.json.error === 'Bad domain', 'vaults: a claim of a bad domain is refused')
  r = await vreq('/solana/claim', { method: 'POST', body: { domain: 'example.com' }, ip: '10.6.2.6' })
  ok(r.status === 422 && r.json.error === 'No SOL wallet in DNS' && /SOL/.test(r.json.reason) && r.cors === ORIGIN, 'vaults: a claim of a domain publishing no SOL wallet is refused with the reason')
  r = await vreq('/solana/refund', { method: 'POST', body: { domain: 'example.com', signature: 'nope' }, ip: '10.6.2.7' })
  ok(r.status === 400 && r.json.error === 'Bad signature', 'vaults: a refund without a transaction signature is refused')

  // VAULT_RATE_MAX=6 per 10 minutes for claims, collects and refunds together
  const vstatuses = []
  for (const [i, path] of ['/solana/claim', '/solana/collect', '/solana/refund', '/solana/claim', '/solana/claim', '/solana/claim', '/solana/claim'].entries()) {
    vstatuses.push((await vreq(path, { method: 'POST', body: { domain: `bad domain ${i}` }, ip: '10.6.3.1' })).status)
  }
  ok(vstatuses.join(',') === '400,400,400,400,400,400,429', `vaults: the per-IP limit covers all three (statuses ${vstatuses.join(',')})`)
  r = await vreq('/solana/vault?domain=example.com', { ip: '10.6.3.1' })
  ok(r.status === 200, 'vaults: reads are limited apart from claims')

  const leaked = [VAULT_MASTER, ...VAULT_SEEDS].filter(s => logs.includes(s) || answers.includes(s))
  ok(!leaked.length, 'vaults: no master secret or derived seed in the logs or any answer')

  // Without the master secret and the fee wallet, the vault routes say so and the rest keeps working.
  const PORT2 = PORT + 1500
  const bare = spawn(process.execPath, [fileURLToPath(new URL('../upload/server.mjs', import.meta.url))], { env: { ...process.env, PORT: String(PORT2), PINATA_JWT: '', VAULT_MASTER_SEED: '', SOLANA_FEE_WALLET: '' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let bareLogs = ''
  bare.stdout.on('data', d => (bareLogs += d))
  await new Promise(res => bare.stdout.once('data', res))
  try {
    const h = await (await fetch(`http://127.0.0.1:${PORT2}/health`)).json()
    const v = await fetch(`http://127.0.0.1:${PORT2}/solana/vault?domain=example.com`)
    const vj = await v.json()
    ok(h.vaults === false && v.status === 503 && vj.error === 'Not set up', 'vaults: without VAULT_MASTER_SEED the routes answer 503 Not set up')
    ok(/vaults: off, VAULT_MASTER_SEED is not set, SOLANA_FEE_WALLET is not set/.test(bareLogs), 'vaults: the start line names what is missing')
  } finally { bare.kill() }

  console.log(`upload: ${checks} checks passed`)
} finally {
  server.kill()
  doh.close()
  mock.close()
  keyed.close()
  pub.close()
  solKeyed.close()
  node1.close()
  node2.close()
}
