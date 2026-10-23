// Launch on pump.fun for a domain: the coin's creator is the domain's vault (solana-vault.js), so the creator fee of
// every trade ends up where the domain's owner can claim it with one DNS record. app.js mounts this as
// SOLANA_VIEWS.launch. The image and the metadata JSON go to IPFS through the upload service; the coin is pump.fun's
// own create_v2, sent from the user's wallet with the opening buy in the same transaction when it fits.
import { resolveWallets, normalizeDomain, parseUnits } from '../lib/wallet262.js'
import { $, $$, esc, short, copy } from './ui.js'
import * as config from './config.js'
import * as sol from './solana.js'
import * as V from './solana-vault.js'
import { fmtUnits, solRecord, friendly, stepList, sendSteps, card, logoTag, imgUrl, uploaded, tokens, coinsPanel, forgetCoins, loadImages, coinLinks } from './solana-escrow.js'
import { launchedCoins, solPrice } from './solana-board.js'
import { TOKEN } from './token.js'
import { markOfficial } from './token-records.js'

const UPLOAD_URL = config.UPLOAD_URL || 'https://type262-upload.onrender.com'
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp']
const coinUrl = mint => `https://pump.fun/coin/${mint}`
const tokenUrl = mint => `https://solscan.io/token/${mint}`
// pump.fun's curve today (docs: PUMP.md): 1,073M virtual tokens against 30 virtual SOL, 793.1M tokens for sale
// (about 85 SOL), a 1B supply with 6 decimals, and 0.95% protocol + 0.30% creator fee on every curve trade. Quotes
// use the live Global and fee config once read; these stand in until then.
const CURVE = { vTokens: 1_073_000_000_000_000n, vSol: 30_000_000_000n, forSale: 793_100_000_000_000n, supply: 1_000_000_000_000_000n, feeBps: 125n }
const SLIPPAGE_BPS = V.LAUNCH.slippageBps
const MAX_BUY = 80n * 10n ** 9n // a bigger first buy would complete the curve, and migration can't fit in the same transaction
// Rent a launch pays: pump's mint, curve and curve token account (measured on mainnet, PUMP.md), and with an opening
// buy the buyer's Token-2022 account (170 bytes) and pump's volume record for the buyer (about 106 bytes, if new).
// The last two are re-read from the cluster on mount.
const RENT = { pump: 5_450_840n, buyer: 1_513_840n, volume: 1_188_720n }
const NETWORK_FEE = 100_000n // signatures plus the priority fee, rounded up

// ---------- helpers ----------

const approx = lamports => (Number(lamports) / 1e9).toFixed(4).replace(/\.?0+$/, '')
const bytes = s => new TextEncoder().encode(s).length
const norm = s => { try { return s ? normalizeDomain(s) : '' } catch { return '' } }

let settings = null // pump.fun's Global and fee config, once read

/** Tokens an opening buy gets: it's the curve's first trade, in the same transaction as the create. */
function quote(lamports) {
  if (settings) return V.quoteOpeningBuy(settings, lamports)
  const net = (lamports * 10000n) / (10000n + CURVE.feeBps)
  return (CURVE.vTokens * net) / (CURVE.vSol + net)
}

// ---------- the screen ----------

let ctx = null
let root = null
let form = null
const fld = n => form.elements[n]
const v = n => fld(n).value.trim()
let uploading = false
let launching = false
let warmed = false
let pinned = { key: '', uri: '' } // a retried launch reuses the metadata it already pinned
const dest = { domain: '', vault: '', seq: 0 }
let launched = false // the success box is up, until "Launch another"
// Where the side column stacks under the form (style.css: #sl-new at max-width 1180px), the launched coin would show
// twice, in the success box and again in the preview card below it. There the preview and its facts step aside.
const stacked = typeof matchMedia === 'function' ? matchMedia('(max-width: 1180px)') : null
const syncSide = () => { $('.ln-side', root).hidden = launched && !!(stacked && stacked.matches) }
const coins = { domain: '', loaded: false, seq: 0 }

const hashArg = () => {
  const [view, ...rest] = location.hash.slice(1).split('/')
  let a = rest.join('/')
  try { a = decodeURIComponent(a) } catch {}
  return view === 'launch' ? a : ''
}

export function mount(el, c) {
  ctx = c
  root = el
  el.innerHTML = `
    <div class="seg ln-switch">
      <a href="#launch/new" data-sv="new">Launch a coin</a>
      <a href="#launch/explore" data-sv="explore">Explore</a>
      <a href="#launch/coins" data-sv="coins">Coins and fees</a>
    </div>

    <div class="ln-pane" id="sl-new">
      <div class="sl-main">
        <div id="sl-done"></div>
        <form class="ln-form" data-form="sl-create" autocomplete="off" novalidate>
          <fieldset>
            <legend><small>01</small> Identity <em>Give it a name and a face.</em></legend>
            <div class="ln-face" id="sl-drop">
              <button class="ln-thumb" id="sl-thumb" type="button" aria-label="Choose an image"></button>
              <div class="ln-in">
                <span class="label">Image <i>PNG, JPEG or WebP · square · up to 5 MB</i></span>
                <div class="ln-upload">
                  <input type="file" id="sl-file" accept="image/png,image/jpeg,image/webp" hidden>
                  <button class="btn sm" type="button" id="sl-choose">Choose image</button>
                  <span class="ln-upstat" id="sl-upstat">or drop it here. It's stored on IPFS, like on pump.fun.</span>
                </div>
                <details class="ln-link"><summary>Use a link instead</summary>
                  <div class="field sm"><input name="logo" placeholder="ipfs://… or https://…" spellcheck="false" aria-label="Image link"></div>
                </details>
              </div>
            </div>
            <div class="row-2">
              <label class="ln-in"><span class="label">Name <i data-sc="name">0/32</i></span>
                <div class="field sm"><input name="name" maxlength="32" placeholder="Your Site"></div></label>
              <label class="ln-in"><span class="label">Ticker <i data-sc="symbol">0/10</i></span>
                <div class="field sm"><input name="symbol" maxlength="10" placeholder="SITE" spellcheck="false"></div></label>
            </div>
            <label class="ln-in"><span class="label">Description <i data-sc="description">0/500</i></span>
              <div class="field area"><textarea name="description" maxlength="500" rows="3" placeholder="A line or two about the coin."></textarea></div></label>
            <div class="row-3">
              <label class="ln-in"><span class="label">X</span><div class="field sm"><input name="twitter" placeholder="https://x.com/…" spellcheck="false"></div></label>
              <label class="ln-in"><span class="label">Telegram</span><div class="field sm"><input name="telegram" placeholder="https://t.me/…" spellcheck="false"></div></label>
              <label class="ln-in"><span class="label">Website</span><div class="field sm"><input name="website" placeholder="https://yoursite.com" spellcheck="false"></div></label>
            </div>
          </fieldset>
          <fieldset>
            <legend><small>02</small> Economics <em>Point the fees at a domain.</em></legend>
            <label class="ln-in"><span class="label">Creator fees go to</span>
              <div class="field"><span class="pre">to</span><input name="domain" placeholder="yoursite.com" spellcheck="false" required></div></label>
            <div class="sl-feeto" id="sl-feeto" hidden></div>
            <div class="ln-hint" id="sl-dest"></div>
            <label class="ln-in" id="sl-open"><span class="label">Opening buy <i>optional · SOL · before anyone else buys</i></span>
              <div class="field sm"><input name="buy" inputmode="decimal" placeholder="0" aria-label="Opening buy in SOL"><span class="pre unit">SOL</span></div></label>
            <div class="ln-hint" id="sl-quote"></div>
          </fieldset>
          <div class="ln-go">
            <div class="ln-total" id="sl-total"></div>
            <button class="btn primary" type="submit" id="sl-submit">Launch</button>
          </div>
          <div id="sl-status"></div>
        </form>
      </div>
      <aside class="ln-side">
        <span class="label">On pump.fun</span>
        <div id="sl-preview"></div>
        <dl class="ln-facts" id="sl-facts"></dl>
      </aside>
    </div>

    <div class="ln-pane" id="sl-explore">
      <div id="sl-token"></div>
      <div class="ln-tools ln-xhead">
        <div><h4>Launched on TYPE/262</h4><span id="sl-xsub">Every coin launched here, newest first. Each one's creator fees go to its domain's vault.</span></div>
        <button class="btn sm" type="button" data-xrefresh>Refresh</button>
      </div>
      <div id="sl-xlist" aria-live="polite"></div>
    </div>

    <div class="ln-pane" id="sl-coins">
      <div class="ln-tools">
        <form class="field sm" data-form="sl-find" autocomplete="off">
          <span class="pre">fees</span>
          <input name="d" placeholder="yoursite.com" spellcheck="false" aria-label="Domain">
          <button class="btn" type="submit">Find</button>
        </form>
      </div>
      <div id="sl-panel" aria-live="polite"></div>
    </div>`

  form = $('[data-form=sl-create]', el)
  if (stacked) stacked.addEventListener('change', syncSide)
  form.addEventListener('input', e => {
    if (e.target.name === 'symbol') e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '')
    if (e.target.name === 'domain') onDomain()
    renderCreate()
  })
  form.addEventListener('submit', e => { e.preventDefault(); launch() })

  const pick = () => $('#sl-file', el).click()
  $('#sl-choose', el).addEventListener('click', pick)
  $('#sl-thumb', el).addEventListener('click', pick)
  $('#sl-file', el).addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) uploadImage(f) })
  const drop = $('#sl-drop', el)
  ;['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over') }))
  ;['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over') }))
  drop.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) uploadImage(f) })

  $('[data-xrefresh]', el).addEventListener('click', () => loadExplore(true))
  $('#sl-token', el).addEventListener('click', e => { const b = e.target.closest('[data-tkcopy]'); if (b) copy(TOKEN.mint, b) })
  $('#sl-xlist', el).addEventListener('click', e => { if (e.target.closest('[data-xretry]')) loadExplore(true) })
  $('[data-form=sl-find]', el).addEventListener('submit', e => {
    e.preventDefault()
    const raw = e.target.elements.d.value.trim()
    let d = ''
    try { d = raw ? normalizeDomain(raw) : '' } catch (err) { ctx.toast(err.message); return }
    if (d === coins.domain && hashArg() === d) loadCoins(true)
    location.hash = d ? `#launch/${d}` : '#launch/coins'
  })
  renderCreate()
  V.pumpSettings().then(s => { settings = s; renderCreate() }).catch(() => {})
  Promise.all([V.rentExempt(170), V.rentExempt(106)]).then(([buyer, volume]) => { Object.assign(RENT, { buyer, volume }); renderCreate() }).catch(() => {})
}

/**
 * #launch and #launch/new: the form (the domain from another tool fills in when the field is empty);
 * #launch/new/<domain>: the form for that domain; #launch/explore: every coin launched through TYPE/262;
 * #launch/<domain> and #launch/coins: a domain's coins and fees.
 */
export function route(arg, c) {
  if (c) ctx = c
  const raw = hashArg()
  let sub = 'new', d = ''
  if (raw.startsWith('new/')) d = norm(raw.slice(4))
  else if (raw === 'coins' || raw === 'explore') sub = raw
  else if (raw && raw !== 'new') { sub = 'coins'; d = norm(raw) }
  $$('.ln-pane', root).forEach(p => p.classList.toggle('on', p.id === `sl-${sub}`))
  $$('.ln-switch a', root).forEach(a => a.classList.toggle('on', a.dataset.sv === sub))
  if (sub === 'explore') { if (Date.now() - explore.at > 30_000) loadExplore(); return }
  const last = norm(ctx.lastDomain ? ctx.lastDomain() : arg)
  if (sub === 'new') {
    if (!warmed) { warmed = true; fetch(`${UPLOAD_URL}/health`).catch(() => {}) } // the free upload host sleeps
    if (d && d !== norm(v('domain'))) { fld('domain').value = d; onDomain() } else if (!v('domain') && last) { fld('domain').value = last; onDomain() }
    renderCreate()
    return
  }
  const target = d || coins.domain || last
  syncSwitch(target)
  if (!coins.loaded || target !== coins.domain) { coins.domain = target; loadCoins() }
}

const syncSwitch = d => { $('[data-sv=coins]', root).href = d ? `#launch/${d}` : '#launch/coins' }

// ---------- create ----------

function renderCreate() {
  for (const n of ['name', 'symbol', 'description']) $(`[data-sc=${n}]`, root).textContent = `${v(n).length}/${fld(n).maxLength}`
  const domain = norm(v('domain'))
  fld('website').placeholder = `https://${domain || 'yoursite.com'}`
  const u = imgUrl(v('logo'))
  if (!uploading) $('#sl-thumb', root).style.backgroundImage = u ? `url("${u.replace(/"/g, '%22')}")` : ''
  let buy = 0n, buyErr = ''
  try { buy = v('buy') ? parseUnits(v('buy'), 9) : 0n } catch { buyErr = 'Enter the opening buy in SOL, like 0.5.' }
  if (buy > MAX_BUY) buyErr = 'The opening buy can be at most 80 SOL: the curve completes at about 85 SOL.'
  const got = buy && !buyErr ? quote(buy) : 0n
  // After the opening buy the card shows the curve as it will be: reserves moved by the buy.
  const net = got ? (buy * 10000n) / (10000n + CURVE.feeBps) : 0n
  const vSol = CURVE.vSol + net, vTok = CURVE.vTokens - got
  const symbol = (v('symbol') || 'TICKER').toUpperCase()
  $('#sl-quote', root).innerHTML = buyErr ? `<span class="err">${esc(buyErr)}</span>`
    : got ? `≈ ${tokens(got)} $${esc(symbol)} (${(Number((got * 10000n) / CURVE.supply) / 100).toFixed(2)}% of the supply), bought as the curve's first trade.` : ''
  $('#sl-preview', root).innerHTML = card({
    name: v('name') || 'Your coin', symbol, logo: v('logo'), domain: domain || 'yoursite.com',
    mcap: (vSol * CURVE.supply) / vTok, progress: Number((got * 10000n) / CURVE.forSale) / 10000,
  }) + `<p class="ln-est">${esc(v('description') || 'A line or two about the coin goes here.')}</p>`
  const rent = RENT.pump + (got ? RENT.buyer + RENT.volume : 0n)
  const vault = dest.domain === domain ? dest.vault : ''
  $('#sl-facts', root).innerHTML = [
    ['Supply', '1,000,000,000'], ['Graduates at', '≈ 85 SOL raised'],
    ['Creator fee', `0.30% → ${esc(domain || 'domain')}`],
    ['Creator', vault ? `<a href="${sol.accountUrl(vault)}" target="_blank" rel="noopener">${esc(short(vault))} ↗</a>` : '<span class="dim">the domain\'s vault</span>'],
    ['Rent', `≈ ${approx(rent)} SOL`],
  ].map(([a, b]) => `<div><dt>${a}</dt><dd>${b}</dd></div>`).join('')
  $('#sl-total', root).innerHTML = got
    ? `You pay <b>≈ ${approx(buy + rent)} SOL</b> (${fmtUnits(buy, 9)} SOL opening buy + rent)`
    : `You pay <b>≈ ${approx(rent)} SOL</b> in rent for the coin's accounts`
  $('#sl-submit', root).innerHTML = `Launch $${esc(symbol)}`
  $('#sl-submit', root).disabled = launching || uploading
}

// "Fees go to": the domain's vault (the coin's creator), and whether its owner can claim yet.
let domainTimer
function onDomain() {
  clearTimeout(domainTimer)
  const hint = $('#sl-dest', root), to = $('#sl-feeto', root)
  const d = norm(v('domain'))
  const seq = ++dest.seq
  if (!d) { hint.textContent = ''; to.hidden = true; return }
  hint.textContent = `Checking ${d}…`
  domainTimer = setTimeout(async () => {
    const live = () => seq === dest.seq
    V.getVault(d).then(info => {
      if (!live()) return
      Object.assign(dest, { domain: d, vault: info.vault })
      to.innerHTML = `<span class="label">Fee address</span><a class="mono" href="${sol.accountUrl(info.vault)}" target="_blank" rel="noopener">${esc(short(info.vault))} ↗</a><span>${esc(d)}'s vault on Solana: the coin's creator on pump.fun.</span>`
      to.hidden = false
      renderCreate()
    }).catch(err => {
      if (!live()) return
      to.innerHTML = `<span class="label">Fee address</span><span>${esc(friendly(err))}</span>`
      to.hidden = false
    })
    try {
      const rec = solRecord(await resolveWallets(d))
      if (!live()) return
      hint.innerHTML = rec && rec.dnssec
        ? `✓ ${esc(d)} publishes a signed <span class="mono">_wallet</span> record with a Solana address. Its owner can claim the fees any time.`
        : `${esc(d)} can claim once it publishes a DNSSEC-signed <span class="mono">_wallet</span> TXT record with a Solana address (<a class="ul" href="#publish/${encodeURIComponent(d)}">Publish</a>). Until then the fees wait in its vault.`
    } catch { if (live()) hint.textContent = `Fees wait in ${d}'s vault until its owner claims them.` }
  }, 450)
}

async function uploadImage(file) {
  const stat = $('#sl-upstat', root), thumb = $('#sl-thumb', root)
  const fail = msg => { stat.textContent = msg; stat.classList.add('err') }
  stat.classList.remove('err', 'ok')
  if (!IMAGE_TYPES.includes(file.type)) return fail('Use a PNG, JPEG or WebP image.')
  if (!file.size || file.size > 5 * 1024 * 1024) return fail('Images must be 5 MB or smaller.')
  const local = URL.createObjectURL(file)
  let kept = false
  thumb.style.backgroundImage = `url("${local}")`
  uploading = true
  renderCreate()
  stat.textContent = 'Uploading to IPFS…'
  const slow = setTimeout(() => { if (uploading) stat.textContent = 'Uploading… the upload server is waking up, this takes a few seconds.' }, 4000)
  try {
    const body = new FormData()
    body.append('image', file)
    const res = await fetch(`${UPLOAD_URL}/image`, { method: 'POST', body, signal: AbortSignal.timeout(90_000) })
    const j = await res.json().catch(() => ({}))
    if (!res.ok || typeof j.uri !== 'string' || !/^ipfs:\/\/[A-Za-z0-9]+$/.test(j.uri)) throw new Error(j.error || 'The upload did not complete.')
    uploaded.set(j.uri, local) // shown from the file until IPFS gateways serve it
    kept = true
    fld('logo').value = j.uri
    stat.textContent = '✓ Uploaded to IPFS.'
    stat.classList.add('ok')
  } catch (err) {
    fld('logo').value = ''
    thumb.style.backgroundImage = ''
    fail(err.name === 'TimeoutError' ? 'The upload timed out. Try again.' : err.message || 'The upload did not complete.')
  } finally {
    clearTimeout(slow)
    uploading = false
    if (!kept) URL.revokeObjectURL(local)
    renderCreate()
  }
}

/** Pins pump.fun-style metadata JSON through the upload service and returns its https URI. */
async function pinMetadata(meta) {
  const key = JSON.stringify(meta)
  if (pinned.key === key) return pinned.uri
  let res
  try {
    res = await fetch(`${UPLOAD_URL}/metadata`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: key, signal: AbortSignal.timeout(90_000) })
  } catch (err) { throw new Error(err.name === 'TimeoutError' ? 'The metadata upload timed out. Try again.' : 'The upload server could not be reached. Try again in a moment.') }
  const j = await res.json().catch(() => ({}))
  if (!res.ok || typeof j.uri !== 'string' || !/^https:\/\/\S+$/.test(j.uri)) throw new Error(j.error || 'The metadata upload did not complete.')
  pinned = { key, uri: j.uri }
  return j.uri
}

const LINKS = { twitter: 'X', telegram: 'Telegram', website: 'website' }

async function launch() {
  if (launching) return
  const st = $('#sl-status', root)
  st.innerHTML = ''
  launching = true
  renderCreate()
  let plan = null, coin = null
  try {
    const domain = normalizeDomain(v('domain'))
    const name = v('name'), symbol = v('symbol').toUpperCase(), logo = v('logo')
    if (!name) throw new Error('Give the coin a name.')
    if (bytes(name) > 32) throw new Error('The name is at most 32 bytes.')
    if (!/^[A-Z0-9]{1,10}$/.test(symbol)) throw new Error('The ticker is 1–10 letters or digits.')
    if (!logo) throw new Error('Add an image: every coin on pump.fun has one.')
    if (!imgUrl(logo)) throw new Error('The image must be an https:// or ipfs:// link.')
    for (const k of Object.keys(LINKS)) if (v(k) && !/^https:\/\/[^\s/]+\.[^\s]+$/.test(v(k))) throw new Error(`The ${LINKS[k]} link must start with https://.`)
    let buy = 0n
    try { buy = v('buy') ? parseUnits(v('buy'), 9) : 0n } catch { throw new Error('Enter the opening buy in SOL, like 0.5.') }
    if (buy > MAX_BUY) throw new Error('The opening buy can be at most 80 SOL: the curve completes at about 85 SOL.')
    const payer = await ctx.connect()
    const [info, pump, have] = await Promise.all([V.getVault(domain), V.pumpSettings(), sol.getBalance(payer)])
    settings = pump
    const need = buy + RENT.pump + (buy ? RENT.buyer + RENT.volume : 0n) + NETWORK_FEE
    if (have < need) throw new Error(`Not enough SOL: this launch needs about ${fmtUnits(need, 9)} SOL and this wallet has ${fmtUnits(have, 9)}.`)

    const pin = stepList(st, ['Pin the metadata to IPFS'])
    pin(0, 'send', null, 'Uploading')
    let uri
    try {
      uri = await pinMetadata({
        name, symbol, description: v('description'), image: logo, showName: true,
        twitter: v('twitter'), telegram: v('telegram'), website: v('website') || `https://${domain}`,
        domain, // the board reads it back, and checks the coin's creator is this domain's vault
      })
    } catch (err) { pin(0, 'fail'); throw err }
    pin(0, 'done', null, 'Pinned')
    // The new mint's keypair is in the create's extraSigners: it co-signs after the wallet, then stays in this page.
    // A wallet that signs v0 gets the launch lookup table, so the opening buy, the priority fee and the board's reference
    // fit in one transaction.
    const tables = sol.supportsV0() ? [await V.launchTable()].filter(Boolean) : []
    plan = await V.launchTxs({ payer, vault: info.vault, name, symbol, uri, buyLamports: buy, settings, board: true, tables })
    coin = { mint: plan.mint, domain, vault: info.vault, name, symbol, logo }
    const buyLine = `Opening buy: ${fmtUnits(buy, 9)} SOL of $${symbol}`
    const LABEL = { launch: `Launch $${symbol} on pump.fun${buy ? `, with a ${fmtUnits(buy, 9)} SOL opening buy` : ''}`, create: `Launch $${symbol} on pump.fun`, buy: buyLine }
    if (!plan.single) {
      st.insertAdjacentHTML('beforeend', `<p class="ln-est">The coin's details leave no room for the opening buy in the launch transaction, so it follows right after. Someone could trade in between: the buy asks for ${Number(SLIPPAGE_BPS) / 100}% fewer tokens and stops if the price moves more than that.</p>`)
    }
    const [sig = ''] = await sendSteps(st, plan.txs.map(t => ({ ...t, label: LABEL[t.kind] })), 1)
    ctx.toast(`$${symbol} is live on pump.fun. Its creator fees go to ${domain}.`)
    done({ ...coin, sig })
  } catch (err) {
    // The coin is live once the create landed; only the opening buy after it failed.
    if (plan && !plan.single && err.index === 1 && err.signatures && err.signatures[0]) {
      done({ ...coin, sig: err.signatures[0], buyFailed: friendly(err) })
      return
    }
    $$('.note', st).forEach(n => n.remove())
    st.insertAdjacentHTML('beforeend', `<div class="note warn">${esc(friendly(err))}</div>`)
  } finally {
    launching = false
    renderCreate()
  }
}

/** The launched coin: links out, the way to its fees, and a fresh form behind "Launch another". */
function done(c) {
  const box = $('#sl-done', root)
  box.innerHTML = `
    <div class="ln-box ln-feebox sl-live">
      <div class="ln-id">${logoTag(c.logo, ' big')}<div><span class="label">Live on pump.fun</span><strong>${esc(c.name)} <em>$${esc(c.symbol)}</em></strong></div></div>
      <p class="ln-est">Every trade's 0.30% creator fee goes to <b>${esc(c.domain)}</b>'s vault, <a class="mono" href="${sol.accountUrl(c.vault)}" target="_blank" rel="noopener">${esc(short(c.vault))} ↗</a>. Its owner claims with one DNS record.</p>
      ${c.buyFailed ? `<div class="note warn">The coin is live, but the opening buy didn't go through: ${esc(c.buyFailed)}</div>` : ''}
      <div class="ln-actions">
        <a class="btn primary sm" href="${coinUrl(c.mint)}" target="_blank" rel="noopener">Open on pump.fun ↗</a>
        <a class="btn sm" href="${c.sig ? sol.txUrl(c.sig) : tokenUrl(c.mint)}" target="_blank" rel="noopener">Solscan ↗</a>
        <a class="btn sm" href="#launch/${encodeURIComponent(c.domain)}">Coins for ${esc(c.domain)}</a>
        <button class="btn sm" type="button" data-again>Launch another</button>
      </div>
      <p class="ln-est mono">Mint ${esc(c.mint)} · <button class="linkish" type="button" data-copy>Copy</button></p>
    </div>`
  form.hidden = true
  launched = true
  syncSide()
  $('[data-copy]', box).addEventListener('click', e => copy(c.mint, e.target))
  $('[data-again]', box).addEventListener('click', () => {
    box.innerHTML = ''
    form.reset()
    fld('domain').value = c.domain
    $('#sl-status', root).innerHTML = ''
    $('#sl-upstat', root).textContent = 'or drop it here. It\'s stored on IPFS, like on pump.fun.'
    $('#sl-upstat', root).classList.remove('ok', 'err')
    form.hidden = false
    launched = false
    syncSide()
    onDomain()
    renderCreate()
  })
  forgetCoins(c.vault)
  if (coins.domain === c.domain) coins.loaded = false
  scrollTo({ top: 0, behavior: 'smooth' })
}

// ---------- explore: every coin launched through TYPE/262 ----------

const explore = { at: 0, seq: 0 }
const usd = n => new Intl.NumberFormat('en', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 }).format(n)
const solAmount = lamports => (Number(lamports) / 1e9).toLocaleString('en', { maximumFractionDigits: 1 })

/** The TYPE/262 token at the top of Explore: who it is at once, its market and curve once they are read. */
function tokenCard(c, price) {
  const progress = c ? Math.max(0, Math.min(1, c.progress || 0)) : 0
  // a graduated coin trades on PumpSwap: its curve no longer prices it
  const mcap = !c ? '…' : c.complete ? 'On PumpSwap' : price ? `${usd((Number(c.mcap) / 1e9) * price)} <small>${solAmount(c.mcap)} SOL</small>` : `${solAmount(c.mcap)} <small>SOL</small>`
  return `<div class="ln-box tk-feature" data-mint="${esc(TOKEN.mint)}">
    <div class="tk-top"><img class="ln-logo tk-logo" src="${esc(TOKEN.logo)}" alt="">
      <div class="tk-name"><span class="label">The TYPE/262 token</span><strong>${esc(TOKEN.name)} <span class="accent">$${esc(TOKEN.symbol)}</span></strong></div>
      <span class="tag good" data-official>Official</span></div>
    <div class="ln-feegrid">
      <div><span class="label">Market cap</span><div class="v">${mcap}</div></div>
      <div><span class="label">Bonding curve</span><div class="v">${!c ? '…' : c.complete ? 'Graduated' : `${Math.floor(progress * 100)}%`}</div></div>
      <div><span class="label">Contract</span><div class="v tk-addr"><a class="mono" href="https://solscan.io/token/${esc(TOKEN.mint)}" target="_blank" rel="noopener">${esc(short(TOKEN.mint))}</a><button class="btn sm" type="button" data-tkcopy>Copy</button></div></div>
      <div><span class="label">Dev wallet</span><div class="v tk-addr"><a class="mono" href="https://solscan.io/account/${esc(TOKEN.dev)}" target="_blank" rel="noopener">${esc(short(TOKEN.dev))} ↗</a></div></div>
    </div>
    <div class="bar"><i style="width:${(progress * 100).toFixed(1)}%"></i></div>
    <div class="ln-actions">
      <a class="btn primary sm" href="https://pump.fun/coin/${esc(TOKEN.mint)}" target="_blank" rel="noopener">Trade on pump.fun ↗</a>
      <a class="btn sm" href="https://solscan.io/token/${esc(TOKEN.mint)}" target="_blank" rel="noopener">Solscan ↗</a>
    </div>
  </div>`
}
let tokenSeq = 0
async function loadToken() {
  const el = $('#sl-token', root)
  const seq = ++tokenSeq
  // the card's tag also says when type262.com lists the mint in a DNSSEC-verified _token record
  const official = () => markOfficial(el, [{ mint: TOKEN.mint, domain: TOKEN.domain }])
  if (!el.children.length) el.innerHTML = tokenCard(null, 0)
  official()
  const [coins, price] = await Promise.all([V.coinsByMint([TOKEN.mint]).catch(() => null), solPrice().catch(() => 0)])
  // a read that fails keeps what the card already shows
  if (seq === tokenSeq && coins && coins[0]) el.innerHTML = tokenCard(coins[0], price)
  official()
}

async function loadExplore(force = false) {
  explore.at = Date.now()
  const seq = ++explore.seq
  loadToken()
  const el = $('#sl-xlist', root)
  // a refresh keeps the cards up until the new read is in
  if (force || !$('.ln-grid', el)) el.innerHTML = '<div class="ln-empty"><span class="spin"></span><span>Reading the coins launched through TYPE/262…</span></div>'
  let coins, capped
  try { ({ coins, capped } = await launchedCoins({ force })) } catch (err) {
    if (seq !== explore.seq) return
    explore.at = 0
    el.innerHTML = `<div class="ln-empty"><strong>Couldn't read the launches right now.</strong><span class="mono">${esc(friendly(err))}</span><button class="btn sm" type="button" data-xretry>Try again</button></div>`
    return
  }
  if (seq !== explore.seq) return
  $('#sl-xsub', root).textContent = coins.length
    ? `${coins.length}${capped ? ' most recent' : ''} coin${coins.length === 1 ? '' : 's'} launched here, newest first. Each one's creator fees go to its domain's vault.`
    : "Every coin launched here, newest first. Each one's creator fees go to its domain's vault."
  if (!coins.length) {
    el.innerHTML = `<div class="ln-empty"><strong>No coins launched yet.</strong><span>Launch a coin for any domain, and the creator fee of every trade goes to that domain's vault.</span><a class="btn primary sm" href="#launch/new">Launch a coin</a></div>`
    return
  }
  el.innerHTML = `<div class="ln-grid">${coins.map((t, i) => card({ ...t, launchedAt: t.time }, i, coinLinks(t.mint))).join('')}</div>`
  loadImages(el, coins)
  markOfficial(el, coins) // "Official · listed by <domain>" on the coins their domain lists in DNS
}

// ---------- a domain's coins and fees ----------

async function loadCoins(force = false) {
  coins.loaded = true
  const seq = ++coins.seq
  const d = coins.domain
  const el = $('#sl-panel', root)
  $('[data-form=sl-find]', root).elements.d.value = d
  if (!d) {
    el.innerHTML = '<div class="ln-empty"><strong>Find a domain\'s coins.</strong><span>Enter a domain to see the pump.fun coins whose creator is its vault, and collect their creator fees into it.</span></div>'
    return
  }
  el.innerHTML = '<div class="ln-empty"><span class="spin"></span><span>Finding the vault…</span></div>'
  try {
    const info = await V.getVault(d)
    if (seq !== coins.seq) return
    await coinsPanel(el, { domain: d, vault: info.vault, ctx, escrowLink: true, force })
  } catch (err) { if (seq === coins.seq) el.innerHTML = `<div class="ln-empty"><strong>Couldn't find ${esc(d)}'s vault.</strong><span class="mono">${esc(friendly(err))}</span></div>` }
}
