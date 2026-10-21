// Shared UI helpers for the landing page and the app.
export const $ = (s, r = document) => r.querySelector(s)
export const $$ = (s, r = document) => [...r.querySelectorAll(s)]
export const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
export const short = a => (a.length > 24 ? `${a.slice(0, 10)}…${a.slice(-8)}` : a)
export const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches

export async function copy(text, btn) {
  try { await navigator.clipboard.writeText(text) } catch { return }
  if (!btn) return
  const old = btn.textContent
  btn.textContent = 'COPIED'
  setTimeout(() => (btn.textContent = old), 1200)
}

export function loading(el, msg = 'Querying DNS · Cloudflare + Google') {
  el.innerHTML = `<div class="r-head"><span class="label">${esc(msg)}</span><span class="spin"></span></div><div class="skeleton"></div>`
}

export function renderError(el, msg) {
  el.innerHTML = `<div class="r-empty"><strong>Error.</strong><span class="mono">${esc(msg)}</span></div>`
}

export function renderResult(el, r, { appBase = 'app.html' } = {}) {
  const okRes = r.resolvers.filter(x => x.ok)
  const head = `
    <div class="r-head">
      <span class="label">${esc(r.resolvedAt && r.resolvedAt !== r.domain ? `${r.requested || r.domain} → ${r.resolvedAt}` : r.domain)}</span>
      <div class="tags">
        ${r.dnssec ? '<span class="tag good">DNSSEC ✓</span>' : '<span class="tag">Unsigned zone</span>'}
        ${r.agree ? `<span class="tag">${okRes.length}/${r.resolvers.length} resolvers agree</span>` : '<span class="tag bad">Resolvers disagree</span>'}
        <span class="tag">${okRes.map(x => `${x.resolver} ${x.ms}ms`).join(' · ')}</span>
      </div>
    </div>`
  const name = r.resolvedAt || r.domain
  const rows = r.records.map((rec, i) => `
    <div class="r-row" style="animation-delay:${i * 80}ms">
      <div class="r-code">${esc(rec.code)}</div>
      <div class="addr">${esc(rec.address)}</div>
      <div class="tags">
        <span class="tag">${rec.source === 'TYPE262' ? 'TYPE262' : '_wallet TXT'}</span>
        ${rec.dnssec ? '<span class="tag good">Signed</span>' : ''}
        <a class="tag" href="${appBase}#pay/${encodeURIComponent(name)}">Pay ↗</a>
      </div>
    </div>`).join('')
  const empty = r.nxdomain
    ? `<div class="r-empty"><strong>This name doesn't exist.</strong><span class="dim">NXDOMAIN. Want it? Register it, then publish a wallet.</span></div>`
    : `<div class="r-empty"><strong>No wallet here. Yet.</strong><span class="dim">${esc(r.domain)} publishes no TYPE262 record. Want to pay it anyway? <a href="${appBase}#escrow/${encodeURIComponent(r.domain)}">Send to escrow ↗</a> Own it? <a href="${appBase}#publish/${encodeURIComponent(r.domain)}">Publish one in 60 seconds ↗</a></span></div>`
  const bad = r.invalid.length
    ? `<div class="r-row"><div class="r-code">!</div><div class="addr">${r.invalid.length} malformed record(s): ${esc(r.invalid.map(x => x.error).join('; '))}</div></div>`
    : ''
  el.innerHTML = head + (rows || empty) + bad
}

// Bounded-concurrency map, results in input order.
export async function pool(items, n, fn) {
  const out = new Array(items.length)
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k) }
  }))
  return out
}

export const TOP = [
  'google.com', 'youtube.com', 'wikipedia.org', 'x.com', 'reddit.com', 'amazon.com', 'openai.com', 'anthropic.com',
  'github.com', 'stripe.com', 'coinbase.com', 'cloudflare.com', 'vercel.com', 'shopify.com', 'apple.com', 'microsoft.com',
  'netflix.com', 'linkedin.com', 'ens.domains', 'ethereum.org', 'uniswap.org', 'paxos.com', 'arbitrum.io', 'circle.com',
  'binance.com', 'kraken.com', 'robinhood.com', 'x402.org', 'rabby.io', 'metamask.io', 'opensea.io', 'paypal.com',
  'nytimes.com', 'bbc.co.uk', 'spotify.com', 'notion.so', 'figma.com', 'tiktok.com', 'discord.com', 'telegram.org',
  'godaddy.com', 'namecheap.com', 'iana.org', 'icann.org', 'bortzmeyer.org', 'afnic.fr', 'vitalik.ca', 'brave.com',
]
