// Escrow on Solana: pay a domain before it publishes a wallet. Every domain has its own vault, a Solana address the
// TYPE/262 worker derives and holds the key to (solana-vault.js). Anyone can send SOL or USDC to it. Its owner claims
// with one DNSSEC-signed _wallet record, which the worker checks with two resolvers before it pays out, and a deposit
// nobody claims comes back to its sender after 180 days. The vault is also the creator of the domain's pump.fun
// coins, so their fees collect there too. app.js mounts this as SOLANA_VIEWS.escrow. The number formatting, the step
// list, the error wording, the coin cards and the coins and fees panel are shared with the launch screen.
import { resolveWallets, normalizeDomain, addressKind, codeMatchesAddress, parseUnits } from '../lib/wallet262.js'
import { $, $$, esc, short, copy } from './ui.js'
import * as sol from './solana.js'
import * as V from './solana-vault.js'

// ---------- shared with solana-launch.js ----------

/** Base units to a readable number: thousands grouped, at most 6 decimals (cut, then trailing zeros dropped). */
export function fmtUnits(v, dec) {
  const s = BigInt(v).toString().padStart(dec + 1, '0')
  const whole = s.slice(0, s.length - dec).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const frac = s.slice(s.length - dec).slice(0, 6).replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole
}

/** The Solana address a domain publishes in DNS, signed first: the one a claim can pay. */
export function solRecord(dns) {
  const recs = dns ? dns.records.filter(r => addressKind(r.address) === 'solana' && codeMatchesAddress(r.code, r.address)) : []
  return recs.find(r => r.dnssec) || recs[0] || null
}

/** A failed action in the user's words. The worker's reasons are already written for people. */
export function friendly(err) {
  const m = String((err && err.message) || err || '')
  if (err && (err.status || err.unreachable)) return m
  if (/reject|denied|declined|cancel/i.test(m)) return 'Cancelled in your wallet.'
  const pe = V.programError(err)
  if (pe && pe.text) return pe.text
  if (/Transaction too large/i.test(m)) return 'That transaction is too large for Solana. Shorten the name, ticker or links and try again.'
  return m || 'Something went wrong. Try again.'
}

const STATE_TEXT = { wait: '', sign: 'Confirm in your wallet', send: 'Waiting for Solana', done: 'Confirmed', fail: 'Stopped here' }
const STATUS = { signing: 'sign', sending: 'send', confirming: 'send', confirmed: 'done' } // sendAll's onStep statuses

/**
 * A numbered list of steps appended to el (numbers start after `from`, so two lists read as one). Returns
 * set(index, state, signature, text) to move a row along: wait, sign, send, done or fail.
 */
export function stepList(el, labels, from = 0) {
  el.insertAdjacentHTML('beforeend', `<ol class="sx-steps">${labels.map((l, i) => `
    <li data-s="wait"><i aria-hidden="true">${from + i + 1}</i><span>${esc(l)}</span><em></em><a hidden target="_blank" rel="noopener">Solscan ↗</a></li>`).join('')}</ol>`)
  const rows = $$('li', el.lastElementChild)
  return (i, s, sig, text) => {
    const li = rows[i]
    if (!li) return
    li.dataset.s = s
    $('em', li).textContent = text ?? STATE_TEXT[s] ?? ''
    if (sig) { const a = $('a', li); a.href = sol.txUrl(sig); a.hidden = false }
  }
}

/** Sends [{ label, instructions, extraSigners }] in order from the connected wallet, shown as a step list in el. */
export async function sendSteps(el, txs, from = 0) {
  const set = stepList(el, txs.map(t => t.label), from)
  let at = 0
  try {
    set(0, 'sign')
    return await V.sendAll(txs, ({ index, status, signature }) => { at = index; set(index, STATUS[status] || 'sign', signature) })
  } catch (err) { set(err.index ?? at, 'fail', err.signature); throw err }
}

/** One step for one call to the worker: it signs and sends on its own, so there's nothing to confirm here. */
function workerStep(el, label, from = 0) {
  const set = stepList(el, [label], from)
  set(0, 'send', null, 'Working')
  // The free host sleeps; a payout also waits for Solana to confirm each transaction.
  const slow = setTimeout(() => set(0, 'send', null, 'Still working'), 15_000)
  return {
    done: (sig, text) => { clearTimeout(slow); set(0, 'done', sig, text ?? 'Done') },
    fail: () => { clearTimeout(slow); set(0, 'fail') },
  }
}

// Images this page just pinned, by their ipfs:// link, shown from the file itself: a fresh pin takes a while to reach
// the public gateways, and until then the gateway link shows nothing.
export const uploaded = new Map()
export const imgUrl = (u, gateway = 0) => {
  u = String(u || '').trim()
  if (gateway === 0 && uploaded.has(u)) return uploaded.get(u)
  const path = V.ipfsPath(u) // ipfs:// or a public gateway's link: through our gateways
  if (path) return V.IPFS_GATEWAYS[gateway] + path
  if (u.startsWith('ipfs://')) return ''
  return /^https:\/\/[^\s"'<>]+$/.test(u) ? u : ''
}
// On a failed load, try the second IPFS gateway once, then fall back to the emblem.
export const logoTag = (u, cls = '') => {
  const src = imgUrl(u), alt = V.ipfsPath(u) ? imgUrl(u, 1) : ''
  return `<img class="ln-logo${cls}" alt=""${src ? ` src="${esc(src)}"` : ''}${alt ? ` data-alt="${esc(alt)}"` : ''} loading="lazy" onerror="if(this.dataset.alt){this.src=this.dataset.alt;this.removeAttribute('data-alt')}else this.removeAttribute('src')">`
}
export const sol2 = lamports => {
  const n = Number(lamports) / 1e9
  return `${new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: n && n < 1 ? 3 : 2 }).format(n)} SOL`
}
export const tokens = v => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 }).format(Number(v) / 1e6)
function ago(ts) {
  const s = Date.now() / 1000 - Number(ts)
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`
}

/** One coin as a board card: identity, where its fees go, market cap and the way to graduation. */
export function card(t, i = 0, actions = '') {
  const progress = Math.max(0, Math.min(1, t.progress || 0))
  return `<div class="ln-card${actions ? '' : ' preview'}"${t.mint ? ` data-mint="${esc(t.mint)}"` : ''} style="animation-delay:${Math.min(i, 12) * 40}ms">
    <div class="ln-id">${logoTag(t.logo)}<div><strong>${esc(t.name || 'Unnamed')}</strong><span>$${esc(t.symbol || '?')} · SOL${t.launchedAt ? ` · ${ago(t.launchedAt)}` : ''}</span></div></div>
    <div class="ln-to"><span>Fees to</span><b>${esc(t.domain || '')}</b></div>
    <div class="ln-stats"><div><span class="label">Market cap</span><div class="v">${t.complete ? 'On PumpSwap' : t.mcap ? sol2(t.mcap) : '…'}</div></div>
      <span class="tag${t.complete ? ' good' : ''}">${t.complete ? 'Graduated' : `${Math.floor(progress * 100)}% to graduation`}</span></div>
    <div class="bar"><i style="width:${(progress * 100).toFixed(1)}%"></i></div>
    ${actions}
  </div>`
}

// The image lives in the metadata JSON; read it after the cards are up so a slow gateway never holds them back.
const images = new Map()
export function loadImages(el, items) {
  for (const t of items) {
    if (!/^https:\/\//.test(t.uri || '')) continue
    if (!images.has(t.uri)) images.set(t.uri, V.fetchJson(t.uri).then(j => imgUrl(j && j.image)).catch(() => ''))
    images.get(t.uri).then(src => {
      const img = $(`[data-mint="${t.mint}"] .ln-logo`, el)
      // the card is on screen by now: a lazy image given its src this late may never start loading
      if (src && img && !img.getAttribute('src')) { img.loading = 'eager'; img.src = src }
    })
  }
}

const coinCache = new Map() // vault -> { at, p }: a getProgramAccounts read, kept for half a minute
const readCoins = (vault, force) => {
  const c = coinCache.get(vault)
  if (c && !force && Date.now() - c.at < 30_000) return c.p
  const p = V.findCoins(vault).then(async coins => ({ coins, fees: coins.length ? await V.pendingFees(vault, coins) : null }))
  coinCache.set(vault, { at: Date.now(), p })
  p.catch(() => coinCache.delete(vault))
  return p
}
export const forgetCoins = vault => coinCache.delete(vault)

export const coinLinks = mint => `<div class="ln-actions">
  <a class="btn sm" href="https://pump.fun/coin/${esc(mint)}" target="_blank" rel="noopener">pump.fun ↗</a>
  <a class="btn sm" href="https://solscan.io/token/${esc(mint)}" target="_blank" rel="noopener">Solscan ↗</a></div>`

/**
 * A domain's pump.fun coins (those whose creator is its vault) in el: the creator fees waiting at pump.fun, a Collect
 * button that has the worker move them into the vault, and a card per coin. `onFees(total)` hears what is waiting,
 * `onCollected()` that a collect landed. `escrowLink` adds a way to the escrow screen.
 */
export async function coinsPanel(el, opts) {
  const { domain, vault, onFees = () => {}, escrowLink = false, force = false } = opts
  const seq = (el.dataset.seq = String(Number(el.dataset.seq || 0) + 1))
  const live = () => el.dataset.seq === seq && el.isConnected
  el.innerHTML = `<div class="ln-empty"><span class="spin"></span><span>Reading ${esc(domain)}'s pump.fun coins…</span></div>`
  let coins, fees
  try { ({ coins, fees } = await readCoins(vault, force)) } catch (err) {
    if (live()) el.innerHTML = `<div class="ln-empty"><strong>Couldn't read pump.fun coins right now.</strong><span class="mono">${esc(friendly(err))}</span></div>`
    return
  }
  if (!live()) return
  onFees(fees ? fees.total : 0n)
  if (!coins.length) {
    el.innerHTML = `<div class="ln-empty"><strong>No pump.fun coins for ${esc(domain)} yet.</strong><span>A coin launched for ${esc(domain)} names its vault as the creator, so the creator fee of every trade comes here.</span><a class="btn primary sm" href="#launch/new/${encodeURIComponent(domain)}">Launch a coin</a></div>`
    return
  }
  el.innerHTML = `
    <div class="ln-box ln-feebox">
      <div class="ln-feehead"><h4>Creator fees for <span class="accent">${esc(domain)}</span></h4>
        <a class="mono dim" href="${sol.accountUrl(vault)}" target="_blank" rel="noopener">Creator ${esc(short(vault))} ↗</a></div>
      <div class="ln-feegrid">
        <div><span class="label">Waiting at pump.fun</span><div class="v">${fmtUnits(fees.total, 9)} <small>SOL</small></div></div>
        <div><span class="label">Coins</span><div class="v">${coins.length}</div></div>
      </div>
      <p class="ln-est">Each coin's creator is ${esc(domain)}'s vault, so every trade pays it 0.30%. The fees wait at pump.fun until someone collects them: Collect has the TYPE/262 worker move them into the vault and pay the network fee. A claim collects them too.</p>
      <div class="ln-actions">
        <button class="btn primary sm" type="button" data-collect ${fees.total > 0n ? '' : 'disabled'}>${fees.total > 0n ? 'Collect fees' : 'Nothing to collect yet'}</button>
        ${escrowLink ? `<a class="btn sm" href="#escrow/${encodeURIComponent(domain)}">Vault and claim</a>` : ''}
      </div>
      <div class="sv-cstat" data-cstat></div>
    </div>
    <div class="ln-grid">${coins.map((t, i) => card({ ...t, domain }, i, coinLinks(t.mint))).join('')}</div>`
  loadImages(el, coins)
  $('[data-collect]', el).addEventListener('click', e => collectFees(el, opts, { coins, fees, btn: e.currentTarget }))
}

/** After a collect: the panel reads the fees again and keeps what just happened under its button. */
async function collected(el, opts, st, line) {
  st.insertAdjacentHTML('beforeend', `<div class="note good">✓ ${esc(line)}</div>`)
  const trail = st.innerHTML
  forgetCoins(opts.vault)
  if (opts.onCollected) opts.onCollected()
  await coinsPanel(el, { ...opts, force: true })
  const again = $('[data-cstat]', el)
  if (again) again.innerHTML = trail
}

async function collectFees(el, opts, { coins, fees, btn }) {
  const { domain, vault } = opts
  const st = $('[data-cstat]', el)
  btn.disabled = true
  st.innerHTML = ''
  const step = workerStep(st, `Collect ${fmtUnits(fees.total, 9)} SOL of creator fees into ${domain}'s vault`)
  let r
  try { r = await V.collect(domain) } catch (err) {
    step.fail()
    st.insertAdjacentHTML('beforeend', `<div class="note warn">${esc(friendly(err))}</div>`)
    btn.disabled = false
    // Collecting is permissionless: if the worker can't, a wallet can pay for the same instructions.
    if (err.unreachable || err.status >= 500) {
      st.insertAdjacentHTML('beforeend', '<div class="ln-actions"><button class="btn sm" type="button" data-self>Collect with my wallet instead</button></div>')
      $('[data-self]', st).addEventListener('click', e => collectSelf(el, opts, { coins, fees, btn: e.currentTarget }))
    }
    return
  }
  const got = r.collected.reduce((n, c) => n + c.lamports, 0n)
  step.done(r.signatures[0], r.signatures.length > 1 ? `${r.signatures.length} transactions` : 'Done')
  await collected(el, opts, st, got > 0n ? `Moved ${fmtUnits(got, 9)} SOL of creator fees into ${domain}'s vault.`
    : r.pending > 0n ? `${fmtUnits(r.pending, 9)} SOL is waiting, too little to open an empty vault on Solana yet. It stays with pump.fun until more trades add to it.`
      : 'Nothing was waiting after all.')
}

async function collectSelf(el, opts, { coins, fees, btn }) {
  const { domain, vault, ctx } = opts
  const st = $('[data-cstat]', el)
  const offer = btn.closest('.ln-actions')
  btn.disabled = true
  try {
    const payer = await ctx.connect()
    const txs = await V.collectTxs({ payer, vault, coins, fees })
    if (!txs.length) throw new Error('Nothing to collect yet. Creator fees build up as people trade.')
    // The worker's failed attempt gives way to the wallet's; the offer comes back if this one stops too.
    $$('.sx-steps, .note', st).forEach(n => n.remove())
    offer.hidden = true
    await sendSteps(st, txs.map((t, i) => ({ ...t, label: `Collect creator fees into ${domain}'s vault${txs.length > 1 ? ` (${i + 1} of ${txs.length})` : ''}` })))
    offer.remove()
  } catch (err) {
    $$('.note', st).forEach(n => n.remove())
    st.insertAdjacentHTML('beforeend', `<div class="note warn">${esc(friendly(err))}</div>`)
    offer.hidden = false
    btn.disabled = false
    return
  }
  await collected(el, opts, st, `Creator fees moved into ${domain}'s vault. Only network fees came from your wallet.`)
}

// ---------- the escrow screen ----------

const SOL_FEE = 10_000n // two signatures' worth of lamports: room for the network fee
const KIND_TEXT = { program: 'a program', mint: 'a token mint', 'token-account': 'a token account', other: 'an account owned by a program' }
const date = ts => new Date(Number(ts) * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

let ctx = null
let root = null
let current = '' // the domain on screen
let busy = 0 // actions in flight: a re-read never replaces their step list
let stale = false // the wallet changed while the screen was hidden

const hashArg = () => {
  const [v, ...rest] = location.hash.slice(1).split('/')
  let a = rest.join('/')
  try { a = decodeURIComponent(a) } catch {}
  return v === 'escrow' ? a : ''
}
const onScreen = () => !root.hidden && location.hash.slice(1).split('/')[0] === 'escrow'

export function mount(el, c) {
  ctx = c
  root = el
  el.innerHTML = `
    <form class="field" data-form="sol-escrow" autocomplete="off">
      <span class="pre">to</span>
      <input name="d" placeholder="yoursite.com" aria-label="Domain" spellcheck="false">
      <button class="btn primary" type="submit">Look up</button>
    </form>
    <div id="se-out" class="stack" style="margin-top:1rem"></div>`
  $('form', el).addEventListener('submit', e => { e.preventDefault(); lookup(e.target.d.value) })
  // Deposits and refunds belong to a wallet: connecting, disconnecting or switching accounts re-reads them.
  let seen = ctx.account()
  sol.subscribe(() => {
    const a = ctx.account()
    if (a === seen) return
    seen = a
    if (!current || busy) return
    if (onScreen()) refresh(current)
    else stale = true
  })
}

/** #escrow/<domain> always shows fresh numbers; the last domain from another tool only when it changed. */
export function route(arg, c) {
  if (c) ctx = c
  const explicit = hashArg()
  const d = explicit || arg
  const input = $('input[name=d]', root)
  if (!d) return
  if (busy && d === current) return
  if (explicit || stale || input.value.trim() !== d) { input.value = d; lookup(d) }
}

async function lookup(input) {
  const out = $('#se-out', root)
  let domain
  try { domain = normalizeDomain(input) } catch (err) { current = ''; out.innerHTML = `<div class="note warn">${esc(err.message)}</div>`; return }
  current = domain
  stale = false
  history.replaceState(null, '', `#escrow/${domain}`)
  out.innerHTML = '<div class="note">Finding the vault and reading Solana…</div>'
  try {
    const s = await load(domain)
    if (current === domain) render(domain, s)
  } catch (err) { if (current === domain) out.innerHTML = `<div class="note warn">${esc(friendly(err))}</div>` }
}

async function refresh(domain) {
  try { const s = await load(domain); if (current === domain && !busy) render(domain, s) } catch {}
}

async function load(domain) {
  const [info, dns, status] = await Promise.all([V.getVault(domain), resolveWallets(domain).catch(() => null), V.getStatus().catch(() => null)])
  const rec = solRecord(dns)
  const [bal, recType] = await Promise.all([V.readVault(info.vault), rec ? V.addressType(rec.address).catch(() => '') : ''])
  return {
    ...info, dns, rec, recType, bal, me: ctx.account(),
    feeBps: status ? status.feeBps : V.FEE_BPS, delayDays: status ? status.refundDelayDays : V.REFUND_DELAY_DAYS,
  }
}

/** Whether the worker would pay this domain's published address, as far as this browser can tell. */
function claimCheck(domain, s) {
  const { dns, rec } = s
  if (!dns) return "Couldn't read DNS just now. Try again in a moment."
  if (!rec) return `No Solana address in ${domain}'s _wallet record yet.`
  if (!dns.resolvers.every(r => r.ok)) return 'Only one of the two resolvers answered. Try again in a moment.'
  if (!dns.agree) return "Cloudflare and Google don't return the same record yet. DNS changes can take a few minutes to spread."
  // The worker needs the record DNSSEC-authenticated by both resolvers.
  if (!dns.resolvers.every(r => r.records.some(x => x.address === rec.address && x.dnssec))) return `DNSSEC is off for ${domain}. Turn it on at your DNS host: a claim needs the signed record.`
  if (KIND_TEXT[s.recType]) return `That address is ${KIND_TEXT[s.recType]} on Solana, not a wallet. Publish your wallet's address in the _wallet record instead.`
  return ''
}

/** Symbol and decimals of a mint the worker names, from what the vault holds (the worker's decimals win when given). */
function asset(mint, s, decimals = null) {
  if (V.isSolMint(mint) || mint === V.WSOL) return { symbol: 'SOL', decimals: 9 }
  if (mint === sol.USDC.mint) return { symbol: 'USDC', decimals: 6 }
  const t = s.bal.tokens.find(x => x.mint === mint)
  return { symbol: t ? t.symbol || short(t.mint) : short(String(mint)), decimals: decimals ?? (t ? t.decimals : 0) }
}

/** The vault: its address, and what it holds on Solana right now. */
function vaultCard(domain, s) {
  const usdc = s.bal.tokens.find(t => t.mint === sol.USDC.mint)
  const others = s.bal.tokens.filter(t => t !== usdc)
  const row = (code, amount, href) => `
    <div class="r-row">
      <div class="r-code">${esc(code)}</div>
      <div class="addr se-amt">${amount}</div>
      <div class="tags">${href ? `<a class="tag" href="${href}" target="_blank" rel="noopener">Solscan ↗</a>` : ''}</div>
    </div>`
  return `
    <div class="result sv-vault">
      <div class="r-head"><span class="label">${esc(domain)}'s vault</span><div class="tags"><span class="tag">Solana</span></div></div>
      <div class="r-row sv-addr">
        <div class="r-code">Vault</div>
        <div class="addr">${esc(s.vault)}</div>
        <div class="tags"><button class="tag" type="button" data-copy>Copy</button><a class="tag" href="${sol.accountUrl(s.vault)}" target="_blank" rel="noopener">Solscan ↗</a></div>
      </div>
      ${row('SOL', fmtUnits(s.bal.lamports, 9))}
      ${row('USDC', fmtUnits(usdc ? usdc.amount : 0n, 6), sol.accountUrl(s.usdcAccount))}
      ${others.map(t => row(t.symbol || short(t.mint), fmtUnits(t.amount, t.decimals), sol.accountUrl(t.account))).join('')}
    </div>`
}

function render(domain, s) {
  const out = $('#se-out', root)
  const why = claimCheck(domain, s)
  const fee = s.feeBps / 100
  const held = () => s.bal.lamports > 0n || s.bal.tokens.length > 0
  const link = (a, text) => `<a class="se-addr" href="${sol.accountUrl(a)}" target="_blank" rel="noopener">${text}</a>`
  const found = s.rec
    ? `${why ? 'Found' : '✓ Found'} ${link(s.rec.address, `<span class="mono">${esc(short(s.rec.address))}</span>`)}${!why ? ' · DNSSEC-signed on Cloudflare and Google.' : '.'}`
    : ''

  out.innerHTML = `
    ${vaultCard(domain, s)}
    <div><span class="label lbl">Send to ${esc(domain)}'s vault</span>
      <div class="row-2">
        <div class="field sm"><select id="se-asset" aria-label="Asset"><option value="usdc">USDC</option><option value="sol">SOL</option></select></div>
        <div class="field sm"><input id="se-amt" inputmode="decimal" value="5" aria-label="Amount"></div>
        <button class="btn solid" id="se-dep" type="button">Send</button>
      </div>
      <p class="ln-est se-bal" id="se-bal">&nbsp;</p>
      <div id="se-dstat"></div>
    </div>
    <div class="note se-owner">
      <p><b>Own ${esc(domain)}?</b> Publish your Solana address in a <span class="mono">_wallet.${esc(domain)}</span> TXT record
      (<a href="#publish/${encodeURIComponent(domain)}">Publish</a> makes it for you) and turn on DNSSEC at your DNS host, then claim.</p>
      <p class="se-check">${found}${why ? ` <b>${esc(why)}</b>` : ''}</p>
      <p class="se-how">A claim asks the TYPE/262 worker to pay out. It reads the record through Cloudflare and Google, needs both to return
        it DNSSEC-signed, collects the creator fees of ${esc(domain)}'s pump.fun coins, then sends everything in the vault, SOL and every
        token, to the published address, less ${fee}%. Anyone can press Claim: the money only goes to the address ${esc(domain)} publishes.</p>
      <div><button class="btn primary sm" id="se-claim" type="button" disabled>${s.rec ? `Claim to ${esc(short(s.rec.address))}` : 'Claim'}</button></div>
    </div>
    <div id="se-status"></div>
    ${s.me ? `
    <div class="result se-mine">
      <div class="r-head"><span class="label">Your deposits</span><div class="tags"><span class="tag">Back after ${s.delayDays} days unclaimed</span></div></div>
      <div id="se-mine"><div class="r-row se-wait"><span class="spin"></span><span class="dim">Reading the vault's history…</span></div></div>
    </div>
    <div id="se-rstat"></div>` : `
    <div class="note">A deposit nobody claims within ${s.delayDays} days comes back to the wallet that sent it.
      <button class="linkish" type="button" data-connect>Connect a wallet</button> to see yours.</div>`}
    <div class="se-coins"><span class="label lbl">pump.fun coins for ${esc(domain)}</span><div id="se-coins"></div></div>
    <div class="note se-trust"><b>How the vault works.</b> On Solana each domain's vault is an address the TYPE/262 worker derives from a
      server secret and holds the key to. It pays a claim only to the address the domain publishes in its DNSSEC-signed _wallet record, as
      both resolvers return it, and pays a deposit back after ${s.delayDays} days if the domain hasn't claimed since. Every payout is a
      Solana transaction marked with a type262 memo. On Robinhood Chain, escrow is a contract that verifies the DNSSEC proof itself.</div>`

  const asset$ = $('#se-asset', out), amt = $('#se-amt', out)
  // A sensible starting amount per asset, until the user types their own.
  let typed = false
  amt.addEventListener('input', () => (typed = true))
  asset$.addEventListener('change', () => { if (!typed) amt.value = asset$.value === 'sol' ? '0.1' : '5' })
  const bindCopy = () => $('[data-copy]', out).addEventListener('click', e => copy(s.vault, e.currentTarget))
  bindCopy()
  const conn = $('[data-connect]', out)
  if (conn) conn.addEventListener('click', () => ctx.connect().catch(err => ctx.toast(err.message || 'Connection cancelled')))
  walletLine()

  // The claim button waits for the coins: fees still at pump.fun are worth a claim even when the vault is empty.
  const claimBtn = $('#se-claim', out)
  let pending = 0n
  const syncClaim = waiting => {
    pending = waiting ?? pending
    if (busy) return
    const something = held() || pending > 0n
    claimBtn.disabled = !!why || !something
    if (!why && !something) claimBtn.textContent = 'Nothing to claim yet'
    else if (s.rec) claimBtn.textContent = `Claim to ${short(s.rec.address)}`
  }
  syncClaim(0n)
  // A collect moved fees into the vault: show its new balances without redrawing the rest.
  const vaultChanged = async () => {
    try {
      const bal = await V.readVault(s.vault)
      if (current !== domain || !out.isConnected) return
      s.bal = bal
      const el = $('.sv-vault', out)
      if (el) { el.outerHTML = vaultCard(domain, s); bindCopy() }
      syncClaim()
    } catch {}
  }

  // One action at a time; buttons stay disabled until it settles. The finished steps stay on screen after the re-read,
  // a failed re-read isn't reported as a failure, and a result never lands on another domain. fn returns the result line.
  const run = async (slot, fn) => {
    const btns = $$('button', out)
    const prev = btns.map(b => b.disabled)
    btns.forEach(b => (b.disabled = true))
    const st = $(slot, out)
    st.innerHTML = ''
    busy++
    let done
    try { done = await fn(st) } catch (err) {
      busy--
      btns.forEach((b, i) => (b.disabled = prev[i]))
      $$('.note', st).forEach(n => n.remove())
      st.insertAdjacentHTML('beforeend', `<div class="note warn">${esc(friendly(err))}</div>`)
      return
    }
    busy--
    const trail = $$('.ln-est, .sx-steps', st).map(n => n.outerHTML).join('')
    if (current !== domain) { ctx.toast(`${done} (${domain})`); return }
    forgetCoins(s.vault)
    try { render(domain, await load(domain)) } catch {}
    const again = $(slot, root)
    if (again) again.innerHTML = `${trail}<div class="note good">✓ ${esc(done)}</div>`
  }

  $('#se-dep', out).addEventListener('click', () => {
    const isSol = asset$.value === 'sol'
    const t = isSol ? { symbol: 'SOL', decimals: 9 } : sol.USDC
    const amount = amt.value.trim()
    run('#se-dstat', async st => {
      let units
      try { units = parseUnits(amount, t.decimals) } catch { throw new Error('Enter a valid amount.') }
      if (units <= 0n) throw new Error('Enter an amount above zero.')
      const payer = await ctx.connect()
      st.innerHTML = '<div class="note">Checking balances on Solana…</div>'
      const lamports = await sol.getBalance(payer)
      let instructions
      if (isSol) {
        if (lamports < units + SOL_FEE) throw new Error(`Not enough SOL: this wallet has ${fmtUnits(lamports, 9)}.`)
        if (units < sol.MIN_ACCOUNT_LAMPORTS && s.bal.lamports === 0n) throw new Error(`The vault is new on Solana, so its first SOL deposit must be at least ${fmtUnits(sol.MIN_ACCOUNT_LAMPORTS, 9)} SOL.`)
        // The reference and the memo put the deposit on the board (solana-vault.js BOARD_REFERENCE).
        instructions = [...V.depositBudget(V.DEPOSIT.solUnits), V.withReference(sol.systemTransfer(payer, s.vault, units)), V.memoIx(V.boardMemo('deposit', domain))]
      } else {
        await sol.verifyMint(sol.USDC)
        const src = await sol.associatedTokenAddress(payer, sol.USDC.mint)
        const [have, opened] = await Promise.all([sol.getTokenAccountBalance(src), sol.getAccountInfo(s.usdcAccount)])
        if (!have || have.amount < units) throw new Error(`Not enough USDC: this wallet has ${fmtUnits(have ? have.amount : 0n, 6)}.`)
        const rent = opened ? 0n : sol.TOKEN_ACCOUNT_RENT
        if (lamports < SOL_FEE + rent) throw new Error(opened ? 'You need a little SOL for the network fee.' : `You need about ${fmtUnits(SOL_FEE + rent, 9)} SOL: the network fee, and rent for the vault's USDC account, which this first USDC deposit opens.`)
        instructions = [
          ...V.depositBudget(V.DEPOSIT.usdcUnits),
          // Idempotent: opens the vault's USDC account if this is its first USDC, does nothing otherwise.
          sol.createAssociatedTokenAccountIdempotent({ payer, ata: s.usdcAccount, owner: s.vault, mint: sol.USDC.mint }),
          V.withReference(sol.transferChecked({ source: src, mint: sol.USDC.mint, destination: s.usdcAccount, owner: payer, amount: units, decimals: 6 })),
          V.memoIx(V.boardMemo('deposit', domain)),
        ]
      }
      st.innerHTML = ''
      await sendSteps(st, [{ label: `Send ${amount} ${t.symbol} to ${domain}'s vault`, instructions }])
      return `Sent ${amount} ${t.symbol} to ${domain}'s vault.`
    })
  })

  claimBtn.addEventListener('click', () => {
    const wallet = s.rec.address
    run('#se-status', async st => {
      const step = workerStep(st, `The worker checks ${domain}'s _wallet record, collects pump.fun fees and pays out to ${short(wallet)}`)
      let r
      try { r = await V.claim(s.domain) } catch (err) { step.fail(); throw err }
      step.done(null)
      // The collect's entries are its sources; together they are one move into the vault, made before the payouts.
      const paid = new Set(r.payouts.map(p => p.signature))
      const fees = r.collected.reduce((n, c) => n + c.lamports, 0n)
      const rows = [
        ...(fees > 0n ? [[`Collected ${fmtUnits(fees, 9)} SOL of creator fees into the vault`, r.signatures.find(x => !paid.has(x))]] : []),
        ...r.payouts.map(p => {
          const a = asset(p.mint, s, p.decimals)
          return [`Paid ${fmtUnits(p.amount, a.decimals)} ${a.symbol} to ${short(r.wallet || wallet)}${p.fee > 0n ? ` (fee ${fmtUnits(p.fee, a.decimals)})` : ''}`, p.signature]
        }),
      ]
      if (rows.length) {
        const set = stepList(st, rows.map(x => x[0]), 1)
        rows.forEach(([, sig], i) => set(i, 'done', sig))
      }
      // What the claim left in the vault, in the worker's words: a later claim takes it.
      for (const k of r.skipped) st.insertAdjacentHTML('beforeend', `<p class="ln-est">${k.mint && !V.isSolMint(k.mint) ? `${esc(asset(k.mint, s).symbol)}: ` : ''}${esc(k.reason)}</p>`)
      return r.payouts.length ? `Claimed to ${short(r.wallet || wallet)}.` : 'The vault had nothing to pay out.'
    })
  })

  coinsPanel($('#se-coins', out), { domain, vault: s.vault, ctx, onFees: syncClaim, onCollected: vaultChanged })
  if (s.me) deposits()

  async function deposits() {
    const el = $('#se-mine', out)
    let r
    try {
      r = await V.findDeposits({ domain: s.domain, vault: s.vault, accounts: [s.usdcAccount, ...s.bal.tokens.map(t => t.account)], from: s.me, delayDays: s.delayDays })
    } catch (err) {
      if (el.isConnected) el.innerHTML = `<div class="r-row se-wait"><span class="dim">Couldn't read the vault's history: ${esc(friendly(err))}</span></div>`
      return
    }
    if (!el.isConnected) return
    const since = r.lastClaim ? ` since ${esc(domain)}'s last claim (${date(r.lastClaim.blockTime)})` : ''
    if (!r.deposits.length) {
      el.innerHTML = `<div class="r-row se-wait"><span class="dim">No deposits from ${esc(short(s.me))} waiting in this vault${since}.</span></div>`
      return
    }
    el.innerHTML = r.deposits.map(d => {
      const a = asset(d.mint, s)
      const when = d.refundable ? 'Refundable now.' : `Refundable from ${date(d.refundableAt)} if ${esc(domain)} hasn't claimed by then.`
      return `<div class="r-row"><div class="r-code">${esc(a.symbol)}</div><div class="addr se-dep">${fmtUnits(d.amount, a.decimals)}, sent ${date(d.blockTime)}. ${when}</div>
        <div class="tags"><a class="tag" href="${sol.txUrl(d.signature)}" target="_blank" rel="noopener">Solscan ↗</a>${d.refundable ? `<button class="tag" type="button" data-refund="${esc(d.signature)}">Refund</button>` : ''}</div></div>`
    }).join('') + (r.truncated ? '<div class="r-row se-wait"><span class="dim">This vault has many transfers; only the most recent and the oldest refundable ones are listed.</span></div>' : '')
    $$('[data-refund]', el).forEach(b => b.addEventListener('click', () => {
      const d = r.deposits.find(x => x.signature === b.dataset.refund)
      const a = asset(d.mint, s)
      run('#se-rstat', async st => {
        const step = workerStep(st, `The worker checks the deposit and pays ${fmtUnits(d.amount, a.decimals)} ${a.symbol} back to ${short(s.me)}`)
        let res
        try { res = await V.refund(s.domain, d.signature) } catch (err) { step.fail(); throw err }
        step.done(res.signature)
        const got = asset(res.refunded.mint, s, res.refunded.decimals ?? d.decimals)
        return `Refunded ${fmtUnits(res.refunded.amount || d.amount, got.decimals)} ${got.symbol} to ${short(res.refunded.to || s.me)}.`
      })
    }))
  }
}

/** "Your wallet: 1.2 SOL · 40 USDC" under the deposit form. */
async function walletLine() {
  const el = $('#se-bal', root)
  const me = ctx.account()
  if (!me) { el.textContent = 'Connect a Solana wallet to send.'; return }
  try {
    const [lamports, usdc] = await Promise.all([sol.getBalance(me), sol.associatedTokenAddress(me, sol.USDC.mint).then(sol.getTokenAccountBalance)])
    if (el.isConnected) el.textContent = `Your wallet: ${fmtUnits(lamports, 9)} SOL · ${fmtUnits(usdc ? usdc.amount : 0n, 6)} USDC`
  } catch { if (el.isConnected) el.textContent = '' }
}
