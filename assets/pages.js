// The Unclaimed Board (/board) and domain profiles (/d/<domain>). Read-only: every "send" or "claim"
// opens the app's tested flows for that domain.
import { $, $$, esc } from './ui.js'
import { normalizeDomain, resolveWallets, addressKind, codeMatchesAddress } from '../lib/wallet262.js'
import { CHAIN, ZERO, domains, blockTimes, batch, money, units, ago, short, favicon } from './chain-data.js'
import { encodeCall, SEL, words, toBig, decodeString } from './abi.js'
import { ambient } from './fx.js'

ambient(32)
const SITE = location.origin
const SUGGEST = ['nytimes.com', 'wikipedia.org', 'openai.com', 'x402.org', 'robinhood.com', 'archive.org']
const U = h => (h && h.length >= 66 ? toBig(words(h)[0]) : 0n)
const shareX = (t, url) => `https://x.com/intent/tweet?text=${encodeURIComponent(t)}&url=${encodeURIComponent(url)}`
const profileUrl = d => `${SITE}/d/${d}`
const APP = 'app.html?net=robinhood' // everything here is Robinhood Chain money, so send, claim and launch open its screens
const icon = (d, big) => `<img class="pg-fav${big ? ' big' : ''}" src="${favicon(d)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`
const waitingLine = w => [w.usdg ? `${units(w.usdg, 6, 2)} USDG` : '', w.eth ? `${units(w.eth, 18, 4)} ETH` : ''].filter(Boolean).join(' + ') || 'Nothing yet'

// ---------- shared: activity feed ----------
async function feed(el, events, { limit = 14, showDomain = true } = {}) {
  const list = events.sort((a, b) => b.block - a.block || b.index - a.index).slice(0, limit)
  if (!list.length) { el.innerHTML = '<p class="pg-none">No activity yet.</p>'; return }
  const t = await blockTimes(list.map(e => e.block)).catch(() => new Map()) // no times beats no feed
  const asset = e => (e.token === ZERO ? `${units(e.amount, 18, 4)} ETH` : `${units(e.amount, 6, 2)} USDG`)
  const what = e => e.kind === 'deposit' ? `<b>${asset(e)}</b> sent by <span class="mono">${short(e.from)}</span>`
    : e.kind === 'claim' ? `<b>${asset(e)}</b> claimed by the owner`
      : e.kind === 'refund' ? `<b>${asset(e)}</b> refunded to <span class="mono">${short(e.from)}</span>`
        : `New coin launched, fees go to the domain`
  el.innerHTML = list.map(e => `
    <a class="pg-ev" href="${CHAIN.explorer}/tx/${e.tx}" target="_blank" rel="noopener">
      <span class="pg-ev-k ${e.kind}">${e.kind}</span>
      <span class="pg-ev-t">${showDomain && e.domain ? `<strong>${esc(e.domain)}</strong> · ` : ''}${what(e)}</span>
      <span class="pg-ev-a">${ago(t.get(e.block))} ↗</span>
    </a>`).join('')
}

// ---------- the board ----------
async function board() {
  const listEl = $('#board-list')
  const state = { sort: 'waiting', q: '', data: null }
  $('[data-form=fund]').addEventListener('submit', e => {
    e.preventDefault()
    let d
    try { d = normalizeDomain(e.target.d.value || e.target.d.placeholder) } catch (err) { $('#fund-err').textContent = err.message; return }
    location.href = `${APP}#escrow/${d}`
  })
  $$('[data-sort] button').forEach(b => b.addEventListener('click', () => {
    $$('[data-sort] button').forEach(x => x.classList.toggle('on', x === b))
    state.sort = b.dataset.val
    render()
  }))
  $('#board-q').addEventListener('input', e => { state.q = e.target.value.trim().toLowerCase(); render() })

  function render() {
    if (!state.data) return // a sort or search before the first read
    const all = state.data.list
    let list = all.filter(s => !state.q || s.domain.includes(state.q))
    if (state.sort === 'new') list = [...list].sort((a, b) => b.first - a.first)
    if (state.sort === 'supporters') list = [...list].sort((a, b) => b.supporters - a.supporters || b.usd - a.usd)
    if (state.sort === 'coins') list = [...list].filter(s => s.launches).sort((a, b) => b.launches - a.launches || b.usd - a.usd)
    if (!all.length) {
      listEl.innerHTML = `
        <div class="pg-empty">
          <strong>The board is waiting for its first pile.</strong>
          <span>Send any website a few dollars. It sits here, in public, until the owner claims it. Start with one of these:</span>
          <div class="pg-chips">${SUGGEST.map(d => `<a class="pg-chip" href="d/${d}">${icon(d)}${d}</a>`).join('')}</div>
        </div>`
      return
    }
    listEl.innerHTML = list.length ? list.map((s, i) => `
      <div class="pg-row" style="animation-delay:${Math.min(i, 14) * 35}ms">
        <span class="pg-rank">${String(all.indexOf(s) + 1).padStart(2, '0')}</span>
        <a class="pg-dom" href="d/${esc(s.domain)}">${icon(s.domain)}<span><strong>${esc(s.domain)}</strong><em>${s.claims ? 'Claimed before · ' : ''}${s.launches ? `${s.launches} coin${s.launches > 1 ? 's' : ''} · ` : ''}${s.supporters} supporter${s.supporters === 1 ? '' : 's'}</em></span></a>
        <span class="pg-amt"><b>${money(s.usd)}</b><em>${waitingLine(s.waiting)}</em></span>
        <span class="pg-act"><a class="btn sm" href="d/${esc(s.domain)}">Profile</a><a class="btn primary sm" href="${APP}#escrow/${esc(s.domain)}">Add to it</a></span>
      </div>`).join('') : '<p class="pg-none">No domain matches that search.</p>'
  }

  // Balances only move with an event, so the list and stats redraw only when the event counts change.
  let seen = ''
  async function load() {
    const data = await domains()
    const { list, activity: a, price } = data
    const key = [a.deposits, a.claims, a.refunds, a.launches].map(x => x.length).join('/')
    if (key !== seen) {
      seen = key
      state.data = data
      const total = list.reduce((n, s) => n + s.usd, 0)
      const supporters = new Set(a.deposits.map(e => e.from.toLowerCase())).size
      const claimed = a.claims.reduce((n, e) => n + (e.token === ZERO ? (Number(e.amount + e.fee) / 1e18) * price : Number(e.amount + e.fee) / 1e6), 0)
      $('#st-total').textContent = money(total)
      $('#st-sites').textContent = list.filter(s => s.usd > 0).length.toLocaleString('en')
      $('#st-supporters').textContent = supporters.toLocaleString('en')
      $('#st-claimed').textContent = money(claimed)
      render()
    }
    // the feed redraws every pass so its "2m ago" times stay current
    if (a.deposits.length || a.launches.length) await feed($('#board-feed'), [...a.deposits, ...a.claims, ...a.refunds, ...a.launches])
    else $('#board-feed').innerHTML = '<p class="pg-none">Deposits, claims and launches show up here as soon as they land on Robinhood Chain.</p>'
  }
  function fail(err) {
    $$('.pg-stats b').forEach(b => (b.textContent = '—'))
    listEl.innerHTML = `<p class="pg-none">Couldn't read Robinhood Chain right now (${esc(err.message)}). The board tries again every 30 seconds.</p>`
    $('#board-feed').innerHTML = '<p class="pg-none">Activity is unavailable right now.</p>'
  }
  // Read now, then every 30 s while the tab is visible (activity() caches for 30 s, so each pass is
  // a fresh read). A failed refresh keeps the last good view.
  const tick = async () => {
    if (!state.data || !document.hidden) { try { await load() } catch (err) { if (!state.data) fail(err) } }
    setTimeout(tick, 30_000)
  }
  tick()
}

// ---------- a domain's profile ----------
async function profile() {
  // /d/<domain> (rewritten to domain.html on the host) or domain.html?d=<domain>
  const path = location.pathname.startsWith('/d/') ? location.pathname.slice(3).replace(/\/$/, '') : ''
  let raw = new URLSearchParams(location.search).get('d') || ''
  try { raw = decodeURIComponent(path) || raw } catch {}
  let d
  try { d = normalizeDomain(raw) } catch {
    $('#pf').innerHTML = `<a class="pg-back" href="board">← The Unclaimed Board</a><div class="pg-empty"><strong>That isn't a domain.</strong><span>Try something like <a class="ul" href="d/nytimes.com">nytimes.com</a>.</span></div>`
    return
  }
  document.title = `${d} · TYPE/262`
  $$('[data-d]').forEach(el => (el.textContent = d))
  $('#pf-fav').innerHTML = icon(d, true)
  $('#pf-send').href = `${APP}#escrow/${d}`
  const sendD = Object.assign(document.createElement('span'), { className: 'pf-send-d', textContent: d })
  $('#pf-send').replaceChildren('Send ', sendD, ' money')
  $('#pf-launch').href = `${APP}#launch/new/${d}`
  $('#pf-publish').href = `${APP}#publish/${d}`
  $('#pf-claim').href = `${APP}#escrow/${d}`
  $('#pf-copy').addEventListener('click', async e => { try { await navigator.clipboard.writeText(profileUrl(d)); e.target.textContent = 'Copied' } catch {} })
  // set before any chain read, so Share on X works even if the chain can't be read
  $('#pf-share').href = shareX(`You can send ${d} money right now, before it even knows. It waits on-chain until the owner claims it.`, profileUrl(d))

  // DNS: does it publish a wallet yet?
  resolveWallets(d).then(r => {
    const evm = r.records.find(x => addressKind(x.address) === 'evm' && codeMatchesAddress(x.code, x.address))
    $('#pf-status').innerHTML = evm
      ? `<span class="tag good">Publishes a Robinhood Chain wallet${evm.dnssec ? ' · DNSSEC ✓' : ''}</span>`
      : '<span class="tag">No Robinhood Chain wallet published yet</span>'
    if (evm && r.agree) { $('#pf-pay').hidden = false; $('#pf-pay').href = `${APP}#pay/${d}` }
  }).catch(() => { $('#pf-status').innerHTML = '<span class="tag">No Robinhood Chain wallet published yet</span>' })

  try {
    const { list, activity: a, price } = await domains()
    const s = list.find(x => x.domain === d) || { waiting: { usdg: 0n, eth: 0n }, usd: 0, supporters: 0, launches: 0, claims: 0 }
    const mine = e => e.domain === d
    const deposits = a.deposits.filter(mine), claims = a.claims.filter(mine), launches = a.launches.filter(mine)
    const claimed = claims.reduce((n, e) => n + (e.token === ZERO ? (Number(e.amount + e.fee) / 1e18) * price : Number(e.amount + e.fee) / 1e6), 0)
    $('#pf-waiting').textContent = money(s.usd)
    $('#pf-waiting-sub').textContent = waitingLine(s.waiting)
    $('#pf-supporters').textContent = s.supporters.toLocaleString('en')
    $('#pf-coins').textContent = launches.length.toLocaleString('en')
    $('#pf-claimed').textContent = money(claimed)
    const rank = list.filter(x => x.usd > 0).findIndex(x => x.domain === d)
    $('#pf-rank').textContent = rank >= 0 ? `#${rank + 1} on the board` : 'Not on the board yet'
    if (s.usd > 0) $('#pf-share').href = shareX(`${d} has ${money(s.usd)} waiting on TYPE/262. Publish one DNS record to claim it.`, profileUrl(d))

    // top supporters
    const by = new Map()
    for (const e of deposits) {
      const k = e.from.toLowerCase(), v = by.get(k) || { usd: 0, n: 0 }
      v.usd += e.token === ZERO ? (Number(e.amount) / 1e18) * price : Number(e.amount) / 1e6
      v.n++
      by.set(k, v)
    }
    const top = [...by].sort((x, y) => y[1].usd - x[1].usd).slice(0, 8)
    $('#pf-supp').innerHTML = top.length
      ? top.map(([who, v], i) => `<a class="pg-sup" href="${CHAIN.explorer}/address/${who}" target="_blank" rel="noopener"><span class="pg-rank">${i + 1}</span><span class="mono">${short(who)}</span><b>${money(v.usd)}</b></a>`).join('')
      : `<p class="pg-none">No supporters yet. Be the first to send ${esc(d)} something.</p>`

    // coins launched for the domain (a failed read here leaves the rest of the profile as it is)
    const coins = $('#pf-coin-list')
    if (!launches.length) coins.innerHTML = `<p class="pg-none">No coins yet. Launch the first one: every trade's creator fee goes to ${esc(d)}.</p>`
    else {
      const res = await batch(launches.flatMap(l => [
        { to: l.token, data: SEL.name }, { to: l.token, data: SEL.symbol },
        { to: l.curve, data: SEL.getReserves }, { to: l.curve, data: SEL.graduated },
      ])).catch(() => null)
      coins.innerHTML = !res ? '<p class="pg-none">Coins are unavailable right now.</p>' : launches.map((l, i) => {
        const [n, sym, rsv, grad] = res.slice(i * 4, i * 4 + 4)
        const w = words(rsv || '')
        const q = w[0] ? toBig(w[0]) : 0n, t = w[1] ? toBig(w[1]) : 0n
        const eth = l.pairToken === ZERO
        const mcap = !U(grad) && t ? Number((q * 10n ** 27n) / t) / (eth ? 1e18 : 1e6) : 0
        return `<a class="pg-coin" href="${APP}#launch/${l.token}">
          <span><strong>${esc(decodeString(n || '') || 'Unnamed')}</strong><em>$${esc(decodeString(sym || '') || '?')} · ${eth ? 'ETH' : 'USDG'} pair</em></span>
          <span class="pg-amt"><b>${U(grad) ? 'Graduated' : eth ? `${mcap.toFixed(2)} ETH` : money(mcap)}</b><em>${U(grad) ? 'On Uniswap' : 'market cap'}</em></span>
        </a>`
      }).join('')
    }
    feed($('#pf-feed'), [...deposits, ...claims, ...a.refunds.filter(mine), ...launches], { showDomain: false })
  } catch (err) {
    // the chain can't be read: nothing stays on "…" or "Loading…"
    $$('.pf-stats b').forEach(b => (b.textContent = '—'))
    $('#pf-coin-list').innerHTML = '<p class="pg-none">Coins are unavailable right now.</p>'
    $('#pf-supp').innerHTML = '<p class="pg-none">Supporters are unavailable right now.</p>'
    $('#pf-feed').innerHTML = `<p class="pg-none">Couldn't read Robinhood Chain right now (${esc(err.message)}). Refresh to try again.</p>`
  }
}

if (document.body.dataset.page === 'board') board()
if (document.body.dataset.page === 'domain') profile()
