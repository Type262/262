import { resolveWallets, normalizeDomain } from '../lib/wallet262.js'
import { esc, renderError, pool, TOP } from './ui.js'
import { $, $$, reduced, intro, reveal, onProgress, flap, ambient, parallax } from './fx.js'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const whenVisible = (el, fn, margin = '0px') => {
  const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { io.disconnect(); fn() } }, { rootMargin: margin })
  io.observe(el)
}

ambient()
parallax()
reveal()

// HUD turns solid once you leave the top.
const hud = $('#hud')
const solid = () => hud.classList.toggle('solid', scrollY > 8)
addEventListener('scroll', solid, { passive: true })
solid()

// ---------- hero: "Every domain is a wallet." then the word becomes real domains ----------
const WORDS = ['stripe.com', 'chess.com', 'nytimes.com', 'slither.io', 'openai.com', 'wikipedia.org', 'x402.org', 'yourapp.com', 'domain']
const heroFlap = $('#hero-flap')
intro().then(async () => {
  if (reduced) return
  await sleep(1800)
  for (let i = 0; ; i++) {
    const word = WORDS[i % WORDS.length]
    await flap(heroFlap, word)
    await sleep(word === 'domain' ? 3200 : 1900)
  }
})

// ---------- hero: chrome 262 tilts toward the cursor, flora drifts the other way ----------
const mark = $('#mark img'), flora = $('#flora')
if (!reduced && matchMedia('(hover: hover)').matches) {
  $('.hero').addEventListener('pointermove', e => {
    const nx = e.clientX / innerWidth - 0.5, ny = e.clientY / innerHeight - 0.5
    mark.style.setProperty('--ry', `${(nx * 10).toFixed(2)}deg`)
    mark.style.setProperty('--rx', `${(-ny * 8).toFixed(2)}deg`)
    flora.style.setProperty('--fx', `${(-nx * 26).toFixed(1)}px`)
    flora.style.setProperty('--fy', `${(-ny * 18).toFixed(1)}px`)
  })
}
addEventListener('scroll', () => flora.style.setProperty('--par', `${(scrollY * 0.25).toFixed(1)}px`), { passive: true })

// ---------- hero: launch a coin for a domain ----------
const tryOut = $('#try-out')
$('#try-form').addEventListener('submit', e => {
  e.preventDefault()
  const raw = $('#try-in').value.trim()
  if (!raw) { location.href = 'app.html#launch/new'; return }
  // www.yourapp.com means yourapp.com: fees go to the name that publishes the record
  try { location.href = `app.html#launch/new/${normalizeDomain(raw).replace(/^www\./, '')}` } catch (err) { renderError(tryOut, err.message) }
})

// ---------- 01 compare tracks ----------
$$('[data-track]').forEach(card => onProgress(card, p => card.querySelector('.track').style.setProperty('--p', p)))

// ---------- 02 story: scroll-scrubbed product demo ----------
const story = $('#how')
const items = $$('.step-item', story)
const scenes = $$('.scene', story)
const stage = $('#stage')
const clamp01 = x => Math.max(0, Math.min(1, x))
const seg = (x, a, b) => clamp01((x - a) / (b - a))
const ease = x => 1 - Math.pow(1 - x, 3)

// Scene 1: the WALLET line types itself into the zone file, then gets signed.
const ZONE = [['@     ', ''], ['IN', 'k'], ['  ', ''], ['WALLET', 'w'], ['  ', ''], ['"SOL" "9xQe…Wb4h"', '']]
const ZONE_LEN = ZONE.reduce((n, [t]) => n + t.length, 0)
function zoneScene(sub) {
  let left = Math.round(ZONE_LEN * seg(sub, 0.06, 0.66))
  const typed = left
  let html = ''
  for (const [t, c] of ZONE) {
    if (left <= 0) break
    const part = t.slice(0, left)
    left -= part.length
    html += c ? `<span class="${c}">${esc(part)}</span>` : esc(part)
  }
  $('#zone-typed').innerHTML = html
  const done = typed >= ZONE_LEN
  const signed = sub > 0.8
  $('#zone-new').classList.toggle('done', done)
  $('#zone-chip').classList.toggle('ok', signed)
  $('#zone-chip').textContent = signed ? 'DNSSEC signed ✓' : 'Unsigned'
  $('#zone-state').textContent = !done ? 'Editing' : signed ? 'Published' : 'Signing…'
}

// Scene 2: the query walks down the DNS tree and the signed answer comes back up.
const hops = $$('.hop', story)
const packet = $('#packet')
function resolveScene(sub) {
  const centers = hops.map(h => h.offsetTop + h.offsetHeight / 2 - packet.offsetHeight / 2)
  const back = sub >= 0.6
  const f = back ? (hops.length - 1) * (1 - seg(sub, 0.6, 0.85)) : (hops.length - 1) * seg(sub, 0.04, 0.6)
  const i = Math.floor(f), frac = f - i
  const y = centers[i] + ((centers[Math.min(i + 1, hops.length - 1)] - centers[i]) * frac)
  packet.style.setProperty('--py', `${y}px`)
  packet.classList.toggle('back', back)
  hops.forEach((h, k) => h.classList.toggle('on', back || k <= f + 0.001))
  const answered = sub > 0.86
  $('#answer').classList.toggle('on', answered)
  $('#ad-chip').classList.toggle('ok', answered)
  $('#ad-chip').textContent = answered ? 'AD flag ✓' : 'AD flag —'
  $('#hop-ms').textContent = `${Math.round(38 * seg(sub, 0.04, 0.85))} ms`
}

// Scene 3: amount counts up, the transfer walks through its states, receipt lands.
const payState = $$('#pay-steps span')
const PAY_AT = [0.3, 0.48, 0.66, 0.84]
const PAY_LABEL = ['Ready', 'Resolving', 'Signing', 'Broadcasting', 'Settled ✓']
function payScene(sub) {
  $('#pay-amt').textContent = (5 * ease(seg(sub, 0.02, 0.3))).toFixed(2)
  let k = 0
  payState.forEach((el, i) => { const on = sub >= PAY_AT[i]; el.classList.toggle('on', on); if (on) k = i + 1 })
  $('#pay-state').textContent = PAY_LABEL[k]
  $('#receipt').classList.toggle('on', sub > 0.9)
}

const narrow = matchMedia('(max-width: 960px)')
let active = -1
onProgress(story, p => {
  if (narrow.matches) return
  const s = Math.min(2, Math.floor(p * 3))
  const sub = clamp01(p * 3 - s)
  if (s !== active) {
    active = s
    items.forEach((el, i) => el.classList.toggle('on', i === s))
    scenes.forEach((el, i) => el.classList.toggle('on', i === s))
  }
  items.forEach((el, i) => el.style.setProperty('--sp', i < s ? 1 : i === s ? sub : 0))
  zoneScene(s > 0 ? 1 : sub)
  resolveScene(s > 1 ? 1 : s === 1 ? sub : 0)
  payScene(s === 2 ? sub : 0)
  stage.style.setProperty('--glow', s === 2 && sub > 0.9 ? 1 : 0)
}, 'pin')

// Phones: no pinning. Each scene plays once when it scrolls into view.
function play(fn, dur = 2600) {
  if (reduced) return fn(1)
  const t0 = performance.now()
  const tick = now => { const p = Math.min(1, (now - t0) / dur); fn(p); if (p < 1) requestAnimationFrame(tick) }
  requestAnimationFrame(tick)
}
if (narrow.matches) {
  zoneScene(0); resolveScene(0); payScene(0)
  whenVisible(scenes[0], () => play(zoneScene))
  whenVisible(scenes[1], () => play(resolveScene))
  whenVisible(scenes[2], () => play(payScene))
}

// ---------- 03 agent console ----------
const CONSOLE = [
  ['p', '$ ', 'agent.fetch("https://api.example.com/v1/data")'],
  ['d', '', '← 402 Payment Required'],
  ['d', '', '  payTo: "BAD1…7e11"  asset: USDC  amount: 0.01'],
  ['p', '$ ', 'verifyPayTo("api.example.com", "BAD1…7e11")'],
  ['x', '', '✗ Not published by example.com. Refusing to pay.'],
  ['', '', ''],
  ['p', '$ ', 'agent.fetch("https://api.example.com/v1/data")'],
  ['d', '', '← 402 Payment Required'],
  ['d', '', '  payTo: "9xQe…Wb4h"  asset: USDC  amount: 0.01'],
  ['p', '$ ', 'verifyPayTo("api.example.com", "9xQe…Wb4h")'],
  ['ok', '', '✓ Match. example.com, DNSSEC-signed.'],
  ['d', '', '→ Paid 0.01 USDC on Solana. 200 OK'],
]
const con = $('#console')
async function runConsole() {
  for (;;) {
    con.innerHTML = ''
    for (const [cls, prompt, text] of CONSOLE) {
      const line = document.createElement('div')
      con.append(line)
      if (prompt) {
        line.innerHTML = `<span class="p">${prompt}</span><span class="t"></span><span class="caret"></span>`
        const t = line.querySelector('.t')
        for (const ch of text) { t.textContent += ch; if (!reduced) await sleep(12 + Math.random() * 22) }
        if (!reduced) await sleep(300)
        line.querySelector('.caret').remove()
      } else {
        line.innerHTML = text ? `<span class="${cls}">${esc(text)}</span>` : '&nbsp;'
        if (!reduced) await sleep(cls === 'x' || cls === 'ok' ? 700 : 240)
      }
    }
    if (reduced) return
    await sleep(5000)
  }
}
whenVisible(con, runConsole)

// ---------- 04 escrow flow ----------
const flowCells = $$('#flow > div')
const flowBar = $('#flow-bar')
let amtDone = false
onProgress($('#flow'), p => {
  flowBar.style.setProperty('--p', p)
  flowCells.forEach((c, i) => c.classList.toggle('on', p >= 0.1 + i * 0.18))
  if (!amtDone && flowCells[0].classList.contains('on')) { amtDone = true; countUp($('#flow-amt'), 4210, v => '$' + v.toLocaleString('en-US')) }
})
function countUp(el, to, fmt, dur = 1400) {
  if (reduced) { el.textContent = fmt(to); return }
  const t0 = performance.now()
  const tick = now => {
    const p = Math.min(1, (now - t0) / dur)
    el.textContent = fmt(Math.round(to * (1 - Math.pow(1 - p, 3))))
    if (p < 1) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

// ---------- live: the unclaimed board, top five ----------
let waitingLoaded = false
const loadWaiting = async () => {
  if (waitingLoaded) return
  waitingLoaded = true
  const list = $('#wt-list')
  try {
    const { domains, money, favicon } = await import('./chain-data.js')
    const fav = d => `<img src="${favicon(d)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`
    const { list: all } = await domains()
    const live = all.filter(s => s.usd > 0)
    $('#wt-total').textContent = money(live.reduce((n, s) => n + s.usd, 0))
    $('#wt-sub').textContent = live.length ? `across ${live.length} website${live.length > 1 ? 's' : ''}` : 'The first pile is up for grabs'
    list.innerHTML = live.length
      ? live.slice(0, 5).map((s, i) => `<a class="wt-row" href="d/${esc(s.domain)}"><span class="wt-rank">${String(i + 1).padStart(2, '0')}</span>${fav(s.domain)}<strong>${esc(s.domain)}</strong><span class="wt-sup">${s.supporters} supporter${s.supporters === 1 ? '' : 's'}</span><b>${money(s.usd)}</b></a>`).join('')
      : ['nytimes.com', 'wikipedia.org', 'openai.com', 'x402.org', 'robinhood.com'].map((d, i) => `<a class="wt-row" href="d/${d}"><span class="wt-rank">${String(i + 1).padStart(2, '0')}</span>${fav(d)}<strong>${d}</strong><span class="wt-sup">Be the first to send it money</span><b>$0</b></a>`).join('')
  } catch {
    $('#wt-total').textContent = '—'
    $('#wt-sub').textContent = 'Live data is unavailable right now'
  }
}
// load when it comes into view, or shortly after the page settles (one light chain read)
whenVisible($('#waiting'), loadWaiting, '300px')
setTimeout(loadWaiting, 2500)

// ---------- 05 adoption board ----------
const board = $('#board')
board.innerHTML = TOP.map(d => `<div class="row" data-d="${d}"><span>${d}</span><i class="flap"></i></div>`).join('')
$$('.flap', board).forEach(f => flap(f, 'QUEUED', 0))
$('#count-of').textContent = `/${TOP.length}`
whenVisible($('#adoption'), async () => {
  let found = 0, scanned = 0
  const state = $('#scan-state')
  state.textContent = 'Scanning over DNS…'
  await pool(TOP, 6, async d => {
    const row = board.querySelector(`[data-d="${d}"]`)
    let label = 'NONE  '
    try {
      const r = await resolveWallets(d, { resolvers: ['cloudflare'] })
      if (r.records.length) { label = `${r.records[0].code} ✓`.padEnd(6).slice(0, 6); row.classList.add('yes'); $('#count').textContent = ++found }
    } catch { label = 'ERROR ' }
    state.textContent = `Scanned ${++scanned} of ${TOP.length}`
    await flap(row.querySelector('.flap'), label, 26)
  })
  state.textContent = `Scanned ${scanned} names · ${new Date().toLocaleTimeString()}`
}, '200px')
