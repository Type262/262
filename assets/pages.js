// The Unclaimed Board (/board) and domain profiles (/d/<domain>), across Solana and Robinhood Chain. Read-only:
// every "send" or "claim" opens the app's tested flows for that domain, on the network the money is on.
import { $, $$, esc } from './ui.js'
import { normalizeDomain, resolveWallets, addressKind, codeMatchesAddress } from '../lib/wallet262.js'
import { CHAIN, ZERO, domains, batch, blockTimes, money, units, ago, short, favicon } from './chain-data.js'
import { boardData, rhUsd } from './board-data.js'
import { solanaProfile, solPrice, usdOf } from './solana-board.js'
import { txUrl, accountUrl } from './solana.js'
import { SEL, words, toBig, decodeString } from './abi.js'
import { ambient } from './fx.js'

ambient(32)
const SITE = location.origin
const SUGGEST = ['nytimes.com', 'wikipedia.org', 'openai.com', 'x402.org', 'github.com', 'archive.org']
const U = h => (h && h.length >= 66 ? toBig(words(h)[0]) : 0n)
const shareX = (t, url) => `https://x.com/intent/tweet?text=${encodeURIComponent(t)}&url=${encodeURIComponent(url)}`
const profileUrl = d => `${SITE}/d/${d}`
const APP = 'app.html?net=solana' // Solana, the main network (named, so a saved Robinhood Chain choice doesn't win)
const APP_RH = 'app.html?net=robinhood' // Robinhood Chain escrow and pons coins
const icon = (d, big) => `<img class="pg-fav${big ? ' big' : ''}" src="${favicon(d)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`
const solAmount = (mint, amount) => (mint === 'SOL' ? `${units(amount, 9, 4)} SOL` : `${units(amount, 6, 2)} USDC`)
const rhAmount = (token, amount) => (token === ZERO ? `${units(amount, 18, 4)} ETH` : `${units(amount, 6, 2)} USDG`)

/** "0.5 SOL + 10 USDC + 0.001 ETH": what waits for a domain on both chains. */
function waitingLine(e) {
  const parts = []
  if (e.sol) {
    const w = e.sol.waiting
    if (w.sol + w.fees) parts.push(`${units(w.sol + w.fees, 9, 4)} SOL`)
    if (w.usdc) parts.push(`${units(w.usdc, 6, 2)} USDC`)
  }
  if (e.rh) {
    if (e.rh.waiting.usdg) parts.push(`${units(e.rh.waiting.usdg, 6, 2)} USDG`)
    if (e.rh.waiting.eth) parts.push(`${units(e.rh.waiting.eth, 18, 4)} ETH`)
  }
  // a no-break space keeps each amount with its token when the line wraps
  return parts.map(p => p.replace(' ', '\u00a0')).join(' + ') || 'Nothing yet'
}

// ---------- shared: activity feed ----------
function eventLine(e) {
  if (e.chain === 'solana') {
    if (e.kind === 'deposit') return `<b>${solAmount(e.mint, e.amount)}</b> sent by <span class="mono">${short(e.from)}</span>`
    if (e.kind === 'claim') return `<b>${[e.paid.sol ? `${units(e.paid.sol, 9, 4)} SOL` : '', e.paid.usdc ? `${units(e.paid.usdc, 6, 2)} USDC` : ''].filter(Boolean).join(' + ')}</b> claimed by the owner`
    if (e.kind === 'refund') return e.amount ? `<b>${solAmount(e.mint, e.amount)}</b> refunded${e.from ? ` to <span class="mono">${short(e.from)}</span>` : ''}` : 'A deposit refunded to its sender'
    return 'New pump.fun coin, its creator fees go to the domain'
  }
  if (e.kind === 'deposit') return `<b>${rhAmount(e.token, e.amount)}</b> sent by <span class="mono">${short(e.from)}</span>`
  if (e.kind === 'claim') return `<b>${rhAmount(e.token, e.amount)}</b> claimed by the owner`
  if (e.kind === 'refund') return `<b>${rhAmount(e.token, e.amount)}</b> refunded to <span class="mono">${short(e.from)}</span>`
  return 'New pons coin, its creator fees go to the domain'
}
function feed(el, events, { limit = 14, showDomain = true } = {}) {
  const list = events.slice(0, limit)
  if (!list.length) { el.innerHTML = '<p class="pg-none">No activity yet.</p>'; return }
  el.innerHTML = list.map(e => `
    <a class="pg-ev" href="${e.chain === 'solana' ? txUrl(e.signature) : `${CHAIN.explorer}/tx/${e.tx}`}" target="_blank" rel="noopener">
      <span class="pg-ev-k ${e.kind}">${e.kind}</span>
      <span class="pg-ev-t">${showDomain && e.domain ? `<strong>${esc(e.domain)}</strong> · ` : ''}${eventLine(e)}</span>
      <span class="pg-ev-a">${[ago(e.time), e.chain === 'solana' ? 'Solana' : 'Robinhood Chain'].filter(Boolean).join(' · ')} ↗</span>
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
          <span>Send any website some SOL or USDC. It sits in the domain's vault, in public, until the owner claims it. Start with one of these:</span>
          <div class="pg-chips">${SUGGEST.map(d => `<a class="pg-chip" href="d/${d}">${icon(d)}${d}</a>`).join('')}</div>
        </div>`
      return
    }
    listEl.innerHTML = list.length ? list.map((s, i) => `
      <div class="pg-row" style="animation-delay:${Math.min(i, 14) * 35}ms">
        <span class="pg-rank">${String(all.indexOf(s) + 1).padStart(2, '0')}</span>
        <a class="pg-dom" href="d/${esc(s.domain)}">${icon(s.domain)}<span><strong>${esc(s.domain)}</strong><em>${s.claims ? 'Claimed before · ' : ''}${s.launches ? `${s.launches} coin${s.launches > 1 ? 's' : ''} · ` : ''}${s.supporters} supporter${s.supporters === 1 ? '' : 's'}</em></span></a>
        <span class="pg-amt"><b>${money(s.usd)}</b><em>${waitingLine(s)}</em></span>
        <span class="pg-act"><a class="btn sm" href="d/${esc(s.domain)}">Profile</a><a class="btn primary sm" href="${APP}#escrow/${esc(s.domain)}">Add to it</a></span>
      </div>`).join('') : '<p class="pg-none">No domain matches that search.</p>'
  }

  // The list and stats redraw only when something changed: a new event, or a balance that moved.
  let seen = ''
  async function load() {
    const data = await boardData()
    if (data.errors.solana && !data.list.length) throw data.errors.solana // an unread Solana is not an empty board
    const key = `${data.activity.length}|${data.list.map(e => `${e.domain}:${e.usd.toFixed(2)}`).join(',')}`
    if (key !== seen) {
      seen = key
      state.data = data
      $('#st-total').textContent = money(data.totals.usd)
      $('#st-sites').textContent = data.totals.sites.toLocaleString('en')
      $('#st-supporters').textContent = data.totals.supporters.toLocaleString('en')
      $('#st-claimed').textContent = money(data.totals.claimed)
      render()
    }
    // the feed redraws every pass so its "2m ago" times stay current
    if (data.activity.length) feed($('#board-feed'), data.activity)
    else $('#board-feed').innerHTML = '<p class="pg-none">Deposits, claims and launches show up here as soon as they land.</p>'
    const off = [data.errors.solana && 'Solana', data.errors.robinhood && 'Robinhood Chain'].filter(Boolean)
    $('#board-note').textContent = off.length ? `${off.join(' and ')} couldn't be read right now; the board shows the rest and tries again every 30 seconds.` : ''
  }
  function fail(err) {
    $$('.pg-stats b').forEach(b => (b.textContent = '—'))
    listEl.innerHTML = `<p class="pg-none">Couldn't read the board right now (${esc(err.message)}). It tries again every 30 seconds.</p>`
    $('#board-feed').innerHTML = '<p class="pg-none">Activity is unavailable right now.</p>'
  }
  // Read now, then every 30 s while the tab is visible (both readers cache for 30 s, so each pass is a fresh read).
  // A failed refresh keeps the last good view.
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
  $('#pf-claim-rh').href = `${APP_RH}#escrow/${d}`
  $('#pf-copy').addEventListener('click', async e => { try { await navigator.clipboard.writeText(profileUrl(d)); e.target.textContent = 'Copied' } catch {} })
  // set before any chain read, so Share on X works even if nothing can be read
  $('#pf-share').href = shareX(`You can send ${d} money right now, before it even knows. It waits in its own vault until the owner claims it.`, profileUrl(d))

  // DNS: which wallets does it publish?
  resolveWallets(d).then(r => {
    const solRec = r.records.find(x => addressKind(x.address) === 'solana' && codeMatchesAddress(x.code, x.address))
    const evm = r.records.find(x => addressKind(x.address) === 'evm' && codeMatchesAddress(x.code, x.address))
    const tags = []
    if (solRec) tags.push(`<span class="tag good">Publishes a Solana wallet${solRec.dnssec ? ' · DNSSEC ✓' : ''}</span>`)
    if (evm) tags.push(`<span class="tag good">Publishes a Robinhood Chain wallet${evm.dnssec ? ' · DNSSEC ✓' : ''}</span>`)
    $('#pf-status').innerHTML = tags.join('') || '<span class="tag">No wallet published yet</span>'
    if (r.agree && (solRec || evm)) { $('#pf-pay').hidden = false; $('#pf-pay').href = solRec ? `${APP}#pay/${d}` : `${APP_RH}#pay/${d}` }
  }).catch(() => { $('#pf-status').innerHTML = '<span class="tag">No wallet published yet</span>' })

  const [solR, rhR, priceR] = await Promise.allSettled([solanaProfile(d), domains(), solPrice()])
  const s = solR.status === 'fulfilled' ? solR.value : null
  const rhAll = rhR.status === 'fulfilled' ? rhR.value : null
  const solUsd = priceR.status === 'fulfilled' ? priceR.value : 0
  if (!s && !rhAll) {
    // nothing can be read: nothing stays on "…" or "Loading…"
    $$('.pf-stats b').forEach(b => (b.textContent = '—'))
    $('#pf-coin-list').innerHTML = '<p class="pg-none">Coins are unavailable right now.</p>'
    $('#pf-supp').innerHTML = '<p class="pg-none">Supporters are unavailable right now.</p>'
    $('#pf-feed').innerHTML = `<p class="pg-none">Couldn't read Solana or Robinhood Chain right now (${esc((solR.reason || rhR.reason).message)}). Refresh to try again.</p>`
    return
  }
  const ethUsd = rhAll ? rhAll.price : 0
  const rh = rhAll ? (rhAll.list.find(x => x.domain === d) || null) : null
  const mine = e => e.domain === d
  const rhA = rhAll ? rhAll.activity : { deposits: [], claims: [], refunds: [], launches: [] }
  const rhDeposits = rhA.deposits.filter(mine), rhClaims = rhA.claims.filter(mine), rhLaunches = rhA.launches.filter(mine)

  // what is waiting, on both chains
  const solWaiting = s ? s.waiting : null
  const entry = { sol: s ? { waiting: solWaiting } : null, rh }
  const usd = (solWaiting ? usdOf({ sol: solWaiting.sol + solWaiting.fees, usdc: solWaiting.usdc }, solUsd) : 0) + (rh ? rh.usd : 0)
  const claimed = (s ? usdOf(s.claimed, solUsd) : 0) + rhClaims.reduce((n, e) => n + rhUsd(e.token, e.amount + e.fee, ethUsd), 0)
  $('#pf-waiting').textContent = money(usd)
  $('#pf-waiting-sub').textContent = waitingLine(entry)
  $('#pf-supporters').textContent = ((s ? s.supporters.size : 0) + (rh ? rh.supporters : 0)).toLocaleString('en')
  $('#pf-coins').textContent = s && !s.coinsRead ? '—' : ((s ? s.coins.length : 0) + rhLaunches.length).toLocaleString('en')
  $('#pf-claimed').textContent = money(claimed)
  // the rank needs the whole board: it is read after the profile shows, and reuses the reads the profile just made
  boardData().then(b => {
    if (b.errors.solana || b.errors.robinhood) return // a rank from one chain alone could be wrong
    const rank = b.list.filter(x => x.usd > 0).findIndex(x => x.domain === d)
    $('#pf-rank').textContent = rank >= 0 ? `#${rank + 1} on the board` : 'Not on the board yet'
  }).catch(() => {})
  if (usd > 0) $('#pf-share').href = shareX(`${d} has ${money(usd)} waiting on TYPE/262. Publish one DNS record to claim it.`, profileUrl(d))
  $('#pf-vault').innerHTML = s ? `Its vault on Solana: <a class="mono" href="${accountUrl(s.vault)}" target="_blank" rel="noopener">${esc(short(s.vault))} ↗</a>`
    : "Its Solana vault couldn't be read right now. Refresh to try again."
  // with Solana unread and nothing on Robinhood Chain, nothing here is known: no $0 or "be the first"
  if (!s && !rh) { $$('.pf-stats b').forEach(b => (b.textContent = '—')); $('#pf-waiting-sub').textContent = '' }
  $('#pf-rh-claim').hidden = !(rh && (rh.waiting.usdg > 0n || rh.waiting.eth > 0n)) // amounts, not dollars: the ETH price may be missing

  // top supporters, both chains, in dollars
  const sups = []
  if (s) for (const [who, v] of s.supporters) sups.push({ who, chain: 'solana', usd: usdOf(v, solUsd) })
  const rhBy = new Map()
  for (const e of rhDeposits) { const k = e.from.toLowerCase(); rhBy.set(k, (rhBy.get(k) || 0) + rhUsd(e.token, e.amount, ethUsd)) }
  for (const [who, v] of rhBy) sups.push({ who, chain: 'robinhood', usd: v })
  const top = sups.sort((x, y) => y.usd - x.usd).slice(0, 8)
  $('#pf-supp').innerHTML = top.length
    ? top.map((v, i) => `<a class="pg-sup" href="${v.chain === 'solana' ? accountUrl(v.who) : `${CHAIN.explorer}/address/${v.who}`}" target="_blank" rel="noopener"><span class="pg-rank">${i + 1}</span><span class="mono">${short(v.who)}</span><b>${money(v.usd)}</b></a>`).join('')
    : !s ? '<p class="pg-none">Supporters are unavailable right now.</p>'
      : `<p class="pg-none">No supporters yet. Be the first to send ${esc(d)} something.</p>`

  // coins: pump.fun coins whose creator is the vault, then pons coins on Robinhood Chain
  const coins = $('#pf-coin-list')
  const solCoins = s ? s.coins.map(c => `<a class="pg-coin" href="https://pump.fun/coin/${esc(c.mint)}" target="_blank" rel="noopener">
      <span><strong>${esc(c.name || 'Unnamed')}</strong><em>$${esc(c.symbol || '?')} · pump.fun</em></span>
      <span class="pg-amt"><b>${c.complete ? 'Graduated' : `${units(c.mcap || 0n, 9, 2)} SOL`}</b><em>${c.complete ? 'On PumpSwap' : 'market cap'}</em></span>
    </a>`) : []
  let rhCoins = []
  if (rhLaunches.length) {
    const res = await batch(rhLaunches.flatMap(l => [
      { to: l.token, data: SEL.name }, { to: l.token, data: SEL.symbol },
      { to: l.curve, data: SEL.getReserves }, { to: l.curve, data: SEL.graduated },
    ])).catch(() => null)
    if (res) rhCoins = rhLaunches.map((l, i) => {
      const [n, sym, rsv, grad] = res.slice(i * 4, i * 4 + 4)
      const w = words(rsv || '')
      const q = w[0] ? toBig(w[0]) : 0n, t = w[1] ? toBig(w[1]) : 0n
      const eth = l.pairToken === ZERO
      const mcap = !U(grad) && t ? Number((q * 10n ** 27n) / t) / (eth ? 1e18 : 1e6) : 0
      return `<a class="pg-coin" href="${APP_RH}#launch/${l.token}">
        <span><strong>${esc(decodeString(n || '') || 'Unnamed')}</strong><em>$${esc(decodeString(sym || '') || '?')} · pons, ${eth ? 'ETH' : 'USDG'} pair</em></span>
        <span class="pg-amt"><b>${U(grad) ? 'Graduated' : eth ? `${mcap.toFixed(2)} ETH` : money(mcap)}</b><em>${U(grad) ? 'On Uniswap' : 'market cap'}</em></span>
      </a>`
    })
  }
  const allCoins = [...solCoins, ...rhCoins]
  coins.innerHTML = allCoins.length ? allCoins.join('')
    : !s || !s.coinsRead || rhLaunches.length ? '<p class="pg-none">Coins are unavailable right now.</p>' // a chain's coins couldn't be read
      : `<p class="pg-none">No coins yet. Launch the first one on pump.fun: every trade's creator fee goes to ${esc(d)}.</p>`

  // activity, newest first, both chains
  const rhMine = [...rhDeposits, ...rhClaims, ...rhA.refunds.filter(mine), ...rhLaunches]
  const times = rhMine.length ? await blockTimes(rhMine.map(e => e.block)).catch(() => new Map()) : new Map()
  const rhEvents = rhMine.map(e => ({ ...e, chain: 'robinhood', time: times.get(e.block) || 0 }))
  const events = [...(s ? s.activity : []), ...rhEvents].sort((x, y) => (y.time || 0) - (x.time || 0))
  if (!s && !events.length) $('#pf-feed').innerHTML = '<p class="pg-none">Activity is unavailable right now.</p>'
  else feed($('#pf-feed'), events, { showDomain: false })
}

if (document.body.dataset.page === 'board') board()
if (document.body.dataset.page === 'domain') profile()
