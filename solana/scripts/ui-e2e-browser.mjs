// The browser side of the UI end-to-end run (ui-e2e.mjs): a static server for the site that also forwards JSON-RPC
// to the local validator, headless Chromium over the DevTools protocol with a throwaway profile, and the script
// injected into every page before the app loads:
// - a Wallet Standard wallet that signs with a throwaway Ed25519 key through WebCrypto (legacy and v0 transactions);
// - fetch overrides: Solana JSON-RPC (the public endpoints solana.js uses and its fallback) goes to the local
//   validator through the static server, the upload service's /image and /metadata answer with fixed IPFS URIs,
//   and DNS-over-HTTPS comes from ui-e2e-dns.mjs; any other Solana RPC host is refused, so nothing reaches a public
//   cluster;
// - the client's launch lookup table (configure({ lookupTables })), the override config.js gets at deploy time.
import { spawn } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as netServer } from 'node:net'
import { extname, join, normalize } from 'node:path'
import { dohStub } from './ui-e2e-dns.mjs'

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain' }
export const RPC_PATH = '/__rpc'
const sleep = ms => new Promise(r => setTimeout(r, ms))

/** True when nothing listens on 127.0.0.1:port. */
export const portFree = port => new Promise(res => {
  const s = netServer().once('error', () => res(false)).once('listening', () => s.close(() => res(true)))
  s.listen(port, '127.0.0.1')
})

/** Serves `root` on the first free port in [from, to], with POST RPC_PATH forwarded to `rpcUrl`. */
export async function serve(root, { from, to, rpcUrl }) {
  let port = from
  while (port <= to && !(await portFree(port))) port++
  if (port > to) throw new Error(`No free port in ${from}-${to}`)
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x')
      if (url.pathname === RPC_PATH && req.method === 'POST') {
        const chunks = []
        for await (const c of req) chunks.push(c)
        const r = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: Buffer.concat(chunks) })
        res.writeHead(r.status, { 'content-type': 'application/json' })
        res.end(Buffer.from(await r.arrayBuffer()))
        return
      }
      const file = normalize(join(root, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)))
      if (!file.startsWith(normalize(root)) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end('not found'); return }
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' })
      createReadStream(file).pipe(res)
    } catch (err) { res.writeHead(502); res.end(String(err.message)) }
  })
  await new Promise(r => server.listen(port, '127.0.0.1', r))
  return { port, origin: `http://127.0.0.1:${port}`, close: () => new Promise(r => server.close(r)) }
}

// ---------- the injected page script ----------

/** Runs in the page before any of its scripts. `cfg` is plain JSON (see pageScript). */
function pageMain(cfg, dohStub) {
  const E = (window.__uiE2E = { rpc: 0, dns: [], uploads: 0, metadata: [], signed: [], refused: [], errors: [], configured: false })
  const realFetch = window.fetch.bind(window)
  const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
  window.fetch = async (input, init) => {
    const url = String(input && input.url ? input.url : input)
    if (cfg.rpcUrls.includes(url)) { E.rpc++; return realFetch(cfg.rpcProxy, init) }
    if (url.startsWith(cfg.upload)) {
      const path = new URL(url).pathname
      if (path === '/health') return json({ ok: true })
      if (path === '/image') { E.uploads++; return json({ uri: cfg.imageUri }) }
      if (path === '/metadata') { E.metadata.push(JSON.parse(init.body)); return json({ uri: cfg.metadataUri }) }
    }
    if (/^https:\/\/(cloudflare-dns\.com|dns\.google)\//.test(url)) { E.dns.push(url.replace(/&ts=\d+/, '')); return dohStub(url, cfg.doh) }
    if (url === cfg.metadataUri) return json({ ...E.metadata.at(-1), image: cfg.imageUri })
    // Solana RPC anywhere else (a public cluster) never leaves the page.
    if (/solana|helius|quiknode|alchemy|triton|onrender\.com\/rpc/i.test(url)) { E.refused.push(url); throw new TypeError('Failed to fetch') }
    return realFetch(input, init)
  }

  // ---------- the wallet ----------
  const bytes = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0))
  const publicKey = bytes(cfg.wallet.publicKey)
  const key = crypto.subtle.importKey('pkcs8', bytes(cfg.wallet.pkcs8), { name: 'Ed25519' }, false, ['sign'])
  const shortvec = (b, at) => { let n = 0, s = 0, i = at; for (;;) { const x = b[i++]; n |= (x & 0x7f) << s; if (!(x & 0x80)) return [n, i]; s += 7 } }
  async function signOne({ transaction, chain }) {
    const tx = Uint8Array.from(transaction)
    const [sigs, at] = shortvec(tx, 0)
    const message = tx.subarray(at + 64 * sigs)
    const v0 = !!(message[0] & 0x80)
    const head = v0 ? 1 : 0
    const required = message[head]
    const [, keysAt] = shortvec(message, head + 3)
    let slot = -1
    for (let i = 0; i < required; i++) if (message.subarray(keysAt + 32 * i, keysAt + 32 * i + 32).every((x, j) => x === publicKey[j])) slot = i
    if (slot < 0) throw new Error('This transaction is not for this wallet')
    const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', await key, message))
    const out = tx.slice()
    out.set(sig, at + 64 * slot)
    E.signed.push({ chain, version: v0 ? 0 : 'legacy', size: tx.length, signers: required })
    return { signedTransaction: out }
  }
  const listeners = new Set()
  const account = Object.freeze({ address: cfg.wallet.address, publicKey, chains: ['solana:mainnet', 'solana:devnet', 'solana:localnet'], features: ['solana:signTransaction'] })
  const wallet = {
    version: '1.0.0',
    name: cfg.wallet.name,
    icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyMCAyMCI+PGNpcmNsZSBjeD0iMTAiIGN5PSIxMCIgcj0iMTAiIGZpbGw9IiM2NjYiLz48L3N2Zz4=',
    chains: account.chains,
    accounts: [],
    features: {
      'standard:connect': { version: '1.0.0', connect: async () => { wallet.accounts = [account]; E.connected = true; listeners.forEach(f => f({ accounts: wallet.accounts })); return { accounts: wallet.accounts } } },
      'standard:disconnect': { version: '1.0.0', disconnect: async () => { wallet.accounts = []; E.connected = false } },
      'standard:events': { version: '1.0.0', on: (event, fn) => { if (event === 'change') listeners.add(fn); return () => listeners.delete(fn) } },
      'solana:signTransaction': { version: '1.0.0', supportedTransactionVersions: ['legacy', 0], signTransaction: (...inputs) => Promise.all(inputs.map(signOne)) },
    },
  }
  window.addEventListener('wallet-standard:app-ready', e => e.detail.register(wallet))
  window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: api => api.register(wallet) }))

  // ---------- the client's lookup table ----------
  import(cfg.clientUrl).then(t => {
    t.configure({ lookupTables: cfg.lookupTables })
    E.programId = t.PROGRAM_ID
    E.configured = true
  }).catch(err => E.errors.push(String(err && err.message)))
  addEventListener('error', e => E.errors.push(String(e.message)))
  addEventListener('unhandledrejection', e => E.errors.push(String(e.reason && e.reason.message)))
}

/** The injected script's source for `cfg` ({ rpcUrls, rpcProxy, upload, imageUri, metadataUri, doh, wallet, clientUrl, lookupTables }). */
export const pageScript = cfg => `;(${pageMain})(${JSON.stringify(cfg)}, ${dohStub});`

// ---------- Chromium over the DevTools protocol ----------

const BROWSERS = [process.env.BROWSER, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'].filter(Boolean)

/**
 * Starts headless Chromium with a fresh profile in `profileDir` and returns a page driver: send (CDP), evaluate,
 * waitFor, click / type / select (real input events at the element), setFiles, shot, and close.
 */
export async function launchBrowser({ profileDir, log = () => {} }) {
  const exe = BROWSERS.find(b => existsSync(b))
  if (!exe) throw new Error('No Chromium found: set BROWSER to a Chrome, Brave or Chromium executable')
  rmSync(profileDir, { recursive: true, force: true })
  mkdirSync(profileDir, { recursive: true })
  let port = 9400 + Math.floor(Math.random() * 400)
  while (!(await portFree(port))) port++
  const proc = spawn(exe, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, '--hide-scrollbars', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--disable-sync', '--disable-component-update',
    '--disable-features=BraveRewards,BraveWallet,Translate', '--window-size=1440,900', '--disable-breakpad', 'about:blank',
  ], { stdio: 'ignore' })
  let list = []
  for (let i = 0; i < 80 && !list.length; i++) {
    try { list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter(t => t.type === 'page') } catch {}
    if (!list.length) await sleep(250)
  }
  if (!list.length) { proc.kill(); throw new Error(`${exe} did not open a DevTools port`) }
  const ws = new WebSocket(list[0].webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
  let id = 0
  const pending = new Map()
  const handlers = new Map()
  const problems = []
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      const { res, rej, method } = pending.get(m.id)
      pending.delete(m.id)
      m.error ? rej(new Error(`${method}: ${JSON.stringify(m.error)}`)) : res(m.result)
    } else if (m.method) {
      if (m.method === 'Runtime.exceptionThrown') problems.push(`exception: ${m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text}`)
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') problems.push(`console.error: ${m.params.args.map(a => a.value ?? a.description).join(' ')}`)
      for (const fn of handlers.get(m.method) || []) fn(m.params)
    }
  })
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej, method }); ws.send(JSON.stringify({ id: i, method, params })) })
  const on = (method, fn) => { if (!handlers.has(method)) handlers.set(method, []); handlers.get(method).push(fn) }

  const evaluate = async (expression, { await: wait = true } = {}) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: wait, returnByValue: true })
    if (r.exceptionDetails) throw new Error(`evaluate failed: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}\n  in: ${expression.slice(0, 200)}`)
    return r.result.value
  }
  /** Polls `expression` until it is truthy; returns its value. `fail`, when truthy first, throws with its value. */
  const waitFor = async (expression, { timeout = 60_000, fail, what } = {}) => {
    const until = Date.now() + timeout
    for (;;) {
      const v = await evaluate(`(() => { try { return ${expression} } catch { return null } })()`)
      if (v) return v
      if (fail) { const f = await evaluate(`(() => { try { return ${fail} } catch { return null } })()`); if (f) throw new Error(`${what || expression}: ${typeof f === 'string' ? f : JSON.stringify(f)}`) }
      if (Date.now() > until) throw new Error(`Timed out waiting for ${what || expression}`)
      await sleep(250)
    }
  }
  const q = sel => JSON.stringify(sel)
  /** The centre of the first element matching `sel`, scrolled into view. */
  const centre = async sel => {
    const r = await evaluate(`(() => { const el = document.querySelector(${q(sel)}); if (!el) return null; el.scrollIntoView({ block: 'center' }); const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height, disabled: !!el.disabled } })()`)
    if (!r) throw new Error(`No element ${sel}`)
    if (!r.w || !r.h) throw new Error(`${sel} is not visible`)
    return r
  }
  const click = async sel => {
    const { x, y, disabled } = await centre(sel)
    if (disabled) throw new Error(`${sel} is disabled`)
    // The element under the pointer must be the target (or inside it): nothing may cover it.
    const hit = await evaluate(`(() => { const t = document.querySelector(${q(sel)}), h = document.elementFromPoint(${x}, ${y}); return !!h && (t === h || t.contains(h)) })()`)
    if (!hit) throw new Error(`${sel} is covered by another element`)
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
  }
  /** Clicks into a field, selects what it holds and types `text` over it (input events as from a keyboard). */
  const type = async (sel, text) => {
    await click(sel)
    await evaluate(`document.querySelector(${q(sel)}).select()`)
    await send('Input.insertText', { text })
    const now = await evaluate(`document.querySelector(${q(sel)}).value`)
    if (now !== text) throw new Error(`${sel} holds ${JSON.stringify(now)} after typing ${JSON.stringify(text)}`)
  }
  const press = async key => {
    const code = { Enter: 13 }[key]
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: code, text: key === 'Enter' ? '\r' : undefined })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code })
  }
  /** Picks an option of a <select> the way the keyboard does: focus, set, then the input and change events. */
  const select = async (sel, value) => {
    await centre(sel)
    const ok = await evaluate(`(() => { const el = document.querySelector(${q(sel)}); el.focus(); if (![...el.options].some(o => o.value === ${q(value)})) return false; el.value = ${q(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)
    if (!ok) throw new Error(`${sel} has no option ${value}`)
  }
  const setFiles = async (sel, files) => {
    const { root } = await send('DOM.getDocument', { depth: 0 })
    const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: sel })
    if (!nodeId) throw new Error(`No element ${sel}`)
    await send('DOM.setFileInputFiles', { nodeId, files })
  }
  const viewport = (width, height = 900, scale = 1) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false })
  /**
   * A PNG of the page from the top down to the bottom of `sel` (the whole page when it is missing), at `width`.
   * The layout is left at 1440 afterwards.
   */
  const shot = async (file, { width = 1440, sel = '.view.on', scale = width < 800 ? 2 : 1 } = {}) => {
    await viewport(width, 900, scale)
    await sleep(600)
    const h = await evaluate(`(() => { const el = document.querySelector(${q(sel)}); const b = el ? el.getBoundingClientRect().bottom + scrollY : 0; return Math.ceil(Math.max(b + 24, 600, el ? 0 : document.documentElement.scrollHeight)) })()`)
    const height = Math.min(h, 8000)
    await viewport(width, height, scale)
    await evaluate('scrollTo(0, 0)')
    await sleep(500)
    const { data } = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width, height, scale: 1 }, captureBeyondViewport: true })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(file, Buffer.from(data, 'base64'))
    await viewport(1440, 900, 1)
    await sleep(300)
    log(`  shot ${file} (${width}x${height})`)
    return file
  }
  const close = async () => {
    try { ws.close() } catch {}
    try { proc.kill() } catch {}
    await sleep(1200)
    try { rmSync(profileDir, { recursive: true, force: true }) } catch {}
  }
  return { send, on, evaluate, waitFor, click, type, press, select, setFiles, viewport, shot, close, problems, exe }
}
