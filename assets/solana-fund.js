// Fund many domains at once: the second mode of the Solana escrow screen, at #escrow/many. Paste domains or links (or
// a package.json), pick SOL or USDC and an amount, review where each payment goes, then send them all in as few
// transactions as fit. Send reads every route again first, and each transaction is simulated before the wallet sees
// it. The plan and the transactions come from solana-batch.js; the step list, the number format and the error wording
// are the escrow screen's.
import { $, $$, esc, short } from './ui.js'
import * as sol from './solana.js'
import * as B from './solana-batch.js'
import { fmtUnits, friendly, sendSteps } from './solana-escrow.js'

const START = { usdc: '10', sol: '0.1' } // a sensible starting total per asset, until the user types their own

let ctx = null
let root = null
let mode = 'total' // or 'each'
let typed = false
let reviewed = null // { key, list, rows }: the last review, for the domains in `key`; Send reads its rows again
let shown = null // { p, txs }: the plan on screen
let pkgNote = '' // what a package.json gave, shown with the plan it made
let listKey = '' // the domains being reviewed or on screen
let reviewSeq = 0, drawSeq = 0 // the newest review and the newest redraw: an older one never lands over them
let sending = false

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
/** Base units in full, every decimal kept: for minimums and rent, which fmtUnits would cut to 6 decimals. */
const exact = (v, dec) => { const s = BigInt(v).toString().padStart(dec + 1, '0'); const f = s.slice(-dec).replace(/0+$/, ''); return `${s.slice(0, -dec)}${f ? `.${f}` : ''}` }
const names = list => (list.length > 3 ? `${list.slice(0, 3).join(', ')} and ${list.length - 3} more` : list.join(', ').replace(/, ([^,]*)$/, ' and $1'))
const keyOf = list => list.domains.join(' ')
// an offer to send the rest of a plan goes away with that plan
const dropRest = () => $$('[data-rest]', root).forEach(b => b.closest('.ln-actions').remove())

export function mount(el, c) {
  ctx = c
  root = el
  el.innerHTML = `
    <div class="stack sf">
      <p class="ln-est">Fund the apps, sites and open-source projects you use, up to ${B.MAX_DOMAINS} at once. A domain that publishes a
        DNSSEC-signed Solana wallet is paid there directly; every other domain gets its share in its vault, where its owner claims it
        with one DNS record.</p>
      <div><span class="label lbl">Domains or links</span>
        <div class="field area"><textarea id="sf-list" rows="6" spellcheck="false" autocomplete="off" aria-label="Domains or links" placeholder="lodash.com&#10;https://vitejs.dev/guide&#10;yoursite.com"></textarea></div>
        <p class="ln-est sf-count" id="sf-count">One per line, or separated by commas or spaces. A package.json works too: its dependencies' homepages are looked up on npm.</p>
      </div>
      <div class="sf-amt">
        <div class="field sm"><select id="sf-asset" aria-label="Asset"><option value="usdc">USDC</option><option value="sol">SOL</option></select></div>
        <div class="field sm"><input id="sf-amt" inputmode="decimal" value="${START.usdc}" aria-label="Amount"></div>
        <div class="seg" id="sf-mode" role="radiogroup" aria-label="The amount is">
          <button type="button" role="radio" data-mode="total" class="on" aria-checked="true">Total, split evenly</button>
          <button type="button" role="radio" data-mode="each" aria-checked="false">Each</button>
        </div>
      </div>
      <div><button class="btn primary" id="sf-review" type="button">Review</button></div>
      <div id="sf-plan" class="stack"></div>
      <div id="sf-stat"></div>
    </div>`

  const area = $('#sf-list', el), asset = $('#sf-asset', el), amt = $('#sf-amt', el)
  area.addEventListener('input', () => {
    pkgNote = ''
    count()
    // a different list needs a new review, and stops one under way; the same list keeps its plan
    if (!sending && keyOf(B.parseList(area.value)) !== listKey) {
      listKey = ''
      reviewed = shown = null
      reviewSeq++; drawSeq++
      $('#sf-plan', el).innerHTML = ''
      dropRest()
    }
  })
  amt.addEventListener('input', () => { typed = true; redraw() })
  asset.addEventListener('change', () => { if (!typed) amt.value = START[asset.value]; redraw() })
  $$('#sf-mode button', el).forEach(b => b.addEventListener('click', () => {
    mode = b.dataset.mode
    $$('#sf-mode button', el).forEach(x => { const on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-checked', String(on)) })
    redraw()
  }))
  $('#sf-review', el).addEventListener('click', review)
  $('#sf-plan', el).addEventListener('click', e => { if (e.target.closest('#sf-send')) send() })
  // the payer's own wallet can't be one of the payees: a change of account redraws the plan
  let seen = ctx.account()
  sol.subscribe(() => { const a = ctx.account(); if (a !== seen) { seen = a; redraw() } })
}

/** #escrow/many: nothing to read until the user reviews a list. */
export function route(c) {
  if (c) ctx = c
}

/** "12 domains" under the list as it is typed, with what will be left out. */
function count() {
  const el = $('#sf-count', root)
  const text = $('#sf-list', root).value
  if (/^\s*\{/.test(text)) { el.textContent = 'A package.json: Review looks up its dependencies on npm.'; return }
  const list = B.parseList(text)
  if (!list.domains.length && !list.skipped.length) { el.textContent = 'One per line, or separated by commas or spaces. A package.json works too: its dependencies\' homepages are looked up on npm.'; return }
  el.textContent = [
    plural(list.domains.length, 'domain'),
    list.over ? `${list.over} past the limit of ${B.MAX_DOMAINS} left out` : '',
    list.duplicates ? `${plural(list.duplicates, 'repeat')} counted once` : '',
    list.skipped.length ? `${list.skipped.length} that can't be used` : '',
  ].filter(Boolean).join(' · ')
}

async function review() {
  if (sending) return
  const n = ++reviewSeq
  listKey = ''
  const out = $('#sf-plan', root), btn = $('#sf-review', root)
  const area = $('#sf-list', root)
  $('#sf-stat', root).innerHTML = ''
  btn.disabled = true
  try {
    if (/^\s*\{/.test(area.value)) {
      let j
      try { j = JSON.parse(area.value) } catch { throw new Error('That looks like JSON, but it isn\'t a valid package.json.') }
      out.innerHTML = '<div class="note">Looking up the dependencies\' homepages on npm…</div>'
      const r = await B.packageDomains(j)
      if (n !== reviewSeq) return
      area.value = r.domains.join('\n')
      pkgNote = packageNote(r)
      count()
    }
    const list = B.parseList(area.value)
    listKey = keyOf(list)
    if (!list.domains.length) {
      out.innerHTML = `${pkgNote}<div class="note warn">${list.skipped.length ? 'None of these can be paid.' : 'Paste at least one domain or link.'}</div>${list.skipped.length ? table(list, { rows: [] }) : ''}`
      return
    }
    out.innerHTML = `${pkgNote}<div class="note" id="sf-wait"><span class="spin"></span> Reading ${plural(list.domains.length, 'domain')} on Cloudflare, Google and Solana…</div>`
    const rows = await B.lookup(list.domains, {
      onProgress: (done, total) => { const w = $('#sf-wait', root); if (w && n === reviewSeq) w.lastChild.textContent = ` Read ${done} of ${total} domains on Cloudflare and Google…` },
    })
    if (n !== reviewSeq) return
    reviewed = { key: listKey, list, rows }
    await draw(++drawSeq)
  } catch (err) {
    if (n === reviewSeq) out.innerHTML = `${pkgNote}<div class="note warn">${esc(friendly(err))}</div>`
  } finally { btn.disabled = false }
}

function packageNote(r) {
  const why = new Map()
  for (const l of r.left) why.set(l.reason, [...(why.get(l.reason) || []), l.name])
  const left = [...why].map(([reason, list]) => `<li><b>${esc(reason)}</b>: ${esc(list.join(', '))}</li>`).join('')
  return `<div class="note sf-pkg"><p>Read ${plural(r.names.length, 'dependency', 'dependencies')} from the package.json${r.capped ? ` (the first ${B.MAX_PACKAGES})` : ''}:
    ${plural(r.domains.length, 'project')} with a domain of ${r.domains.length === 1 ? 'its' : 'their'} own, now in the list above.</p>
    ${r.left.length ? `<details><summary>${r.left.length} left out</summary><ul>${left}</ul></details>` : ''}</div>`
}

/** Redraws the plan for the current asset, amount and split, from the last review (no new reads). */
function redraw() {
  if (!reviewed || sending) return
  draw(++drawSeq).catch(() => {})
}

async function draw(n) {
  const out = $('#sf-plan', root)
  const asset = $('#sf-asset', root).value
  const amount = $('#sf-amt', root).value.trim()
  const payer = ctx.account() || ''
  const p = B.plan(reviewed.rows, { asset, amount, mode, payer })
  const txs = p.error ? [] : await B.transactions(payer || B.STAND_IN, p)
  if (n !== drawSeq) return
  dropRest()
  shown = p.error ? null : { p, txs }
  out.innerHTML = `${pkgNote}${table(reviewed.list, p)}${p.error ? `<div class="note warn">${esc(p.error)}</div>` : summary(p, txs)}`
  if (!p.error) balanceLine()
}

/** The plan as a table: domain and why, route, where the money goes, and how much; then what was left out. */
function table(list, p) {
  const t = p.token || B.ASSETS.usdc
  const rows = p.rows.map(r => (r.error ? skippedRow(r.domain, r.error) : `
    <div class="r-row sf-row" data-d="${esc(r.domain)}">
      <div class="sf-d"><b>${esc(r.domain)}</b><span>${esc(r.why)}</span></div>
      <div class="tags">${r.route === 'direct' ? '<span class="tag good">Direct</span>' : '<span class="tag">Vault</span>'}</div>
      <a class="sf-to mono" href="${sol.accountUrl(r.to)}" target="_blank" rel="noopener" title="${esc(r.to)}">${esc(short(r.to))}</a>
      <div class="sf-v">${r.amount != null ? `${fmtUnits(r.amount, t.decimals)} <small>${t.symbol}</small>` : ''}</div>
    </div>`)).join('') + list.skipped.map(s => skippedRow(s.input, s.reason)).join('')
  const direct = p.rows.filter(r => !r.error && r.route === 'direct').length
  const vault = p.rows.filter(r => !r.error && r.route === 'vault').length
  const extra = [
    list.duplicates ? `${plural(list.duplicates, 'repeated domain')} counted once.` : '',
    list.over ? `Only the first ${B.MAX_DOMAINS} domains are paid at once; ${list.over} more ${list.over === 1 ? 'was' : 'were'} left out.` : '',
  ].filter(Boolean).join(' ')
  return `
    <div class="result sf-plan">
      <div class="r-head"><span class="label">Where the money goes</span>
        <div class="tags"><span class="tag">${direct} direct</span><span class="tag">${vault} into vaults</span></div></div>
      ${rows}
    </div>${extra ? `<p class="ln-est">${esc(extra)}</p>` : ''}`
}

const skippedRow = (name, reason) => `
    <div class="r-row sf-row skip">
      <div class="sf-d"><b>${esc(name)}</b><span>${esc(reason)}</span></div>
      <div class="tags"><span class="tag">Skipped</span></div><span></span><span></span>
    </div>`

/** Totals, transactions and approvals, fees and rent, and the send button. */
function summary(p, txs) {
  const t = p.token
  const fees = B.feesOf(txs, p.asset)
  const rent = BigInt(p.opens) * sol.TOKEN_ACCOUNT_RENT
  const direct = p.pay.filter(r => r.route === 'direct').length, vault = p.pay.length - direct
  const total = `${fmtUnits(p.total, t.decimals)} ${t.symbol}`
  const how = [direct ? `${direct} paid directly at the wallet ${direct === 1 ? 'it publishes' : 'they publish'}` : '', vault ? `${vault} into ${vault === 1 ? 'its vault' : 'their vaults'}` : ''].filter(Boolean).join(', ')
  const low = p.low.map(r => r.domain)
  return `
    <div class="note sf-sum">
      <p><b>${esc(total)}</b> to ${plural(p.pay.length, 'domain')}${mode === 'each' ? `, ${fmtUnits(p.pay[0].amount, t.decimals)} ${t.symbol} each` : ', split evenly'}: ${how}.</p>
      <p><b>${plural(txs.length, 'transaction')}</b>, so ${plural(txs.length, 'approval')} in your wallet. Network fees about ${fmtUnits(fees, 9)} SOL${p.opens ? `, and ${exact(rent, 9)} SOL of rent to open ${plural(p.opens, 'USDC account')}, paid once` : ''}.</p>
      ${vault ? '<p>A vault deposit waits for the domain\'s owner, who claims it with a DNSSEC-signed record. If nobody claims it within 180 days, you can take it back from that domain\'s page in Escrow.</p>' : ''}
    </div>
    ${low.length ? `<div class="note warn">Raise the amount: ${esc(names(low))} ${low.length === 1 ? 'is' : 'are'} new on Solana, so ${low.length === 1 ? 'its' : "each one's"} first SOL must be at least ${exact(sol.MIN_ACCOUNT_LAMPORTS, 9)} SOL.</div>` : ''}
    <div class="ln-actions"><button class="btn solid" id="sf-send" type="button" ${low.length ? 'disabled' : ''}>Send ${esc(total)} to ${plural(p.pay.length, 'domain')}</button></div>
    <p class="ln-est" id="sf-bal">${ctx.account() ? '&nbsp;' : 'Connect a Solana wallet to send.'}</p>`
}

let balRead = null // { who, at, p }: the payer's SOL and USDC, kept for half a minute
/** "Your wallet: 1.2 SOL · 40 USDC" under the send button. */
async function balanceLine() {
  const el = $('#sf-bal', root)
  const me = ctx.account()
  if (!el || !me) return
  if (!balRead || balRead.who !== me || Date.now() - balRead.at > 30_000) {
    const p = Promise.all([sol.getBalance(me), sol.associatedTokenAddress(me, sol.USDC.mint).then(sol.getTokenAccountBalance)])
    balRead = { who: me, at: Date.now(), p }
    p.catch(() => { if (balRead && balRead.p === p) balRead = null })
  }
  try {
    const [lamports, usdc] = await balRead.p
    if (el.isConnected) el.textContent = `Your wallet: ${fmtUnits(lamports, 9)} SOL · ${fmtUnits(usdc ? usdc.amount : 0n, 6)} USDC`
  } catch { if (el.isConnected) el.textContent = '' }
}

const label = (t, i, n) => `Pay ${names(t.rows.map(r => r.domain))}${n > 1 ? ` (${i + 1} of ${n})` : ''}`

/** Marks the rows of the transactions that landed as sent, each with its transaction. */
function markSent(txs, sigs) {
  const rows = $$('.sf-row', root)
  sigs.forEach((sig, k) => {
    for (const r of txs[k].rows) {
      const el = rows.find(x => x.dataset.d === r.domain)
      if (el && !$('.sf-sent', el)) $('.tags', el).insertAdjacentHTML('beforeend', `<a class="tag good sf-sent" href="${sol.txUrl(sig)}" target="_blank" rel="noopener">Sent ↗</a>`)
    }
  })
}

/**
 * The domains of `rows` whose route, address or reason to skip differ now, read again just before sending: DNS
 * answers and vaults older than two minutes (solana-batch.js keeps them that long), and every account on Solana.
 * The review takes the new reads.
 */
async function changedSince(rows) {
  const fresh = await B.lookup(reviewed.list.domains)
  reviewed = { ...reviewed, rows: fresh }
  return B.changedRoutes(rows, fresh)
}

/** Locks the inputs while transactions are out, so the plan on screen is the one being sent. */
function lock(on) {
  $$('#sf-list, #sf-asset, #sf-amt, #sf-mode button, #sf-review, #sf-send', root).forEach(x => (x.disabled = on))
}

async function send() {
  if (!shown || sending) return
  const st = $('#sf-stat', root)
  const asset = $('#sf-asset', root).value
  const amount = $('#sf-amt', root).value.trim()
  sending = true
  lock(true)
  st.innerHTML = ''
  let txs = null
  try {
    const payer = await ctx.connect()
    // a domain may have changed or removed its record since the review: a route that changed stops here, redrawn
    st.innerHTML = '<div class="note">Checking each domain\'s route again…</div>'
    const changed = await changedSince(reviewed.rows)
    if (changed.length) {
      await draw(++drawSeq)
      st.innerHTML = `<div class="note warn">Some routes changed since your review: ${esc(names(changed))}. Check the plan and press Send again.</div>`
      return
    }
    const p = B.plan(reviewed.rows, { asset, amount, mode, payer })
    if (p.error) throw new Error(p.error)
    if (p.low.length) throw new Error('Raise the amount first: some domains are new on Solana.')
    st.innerHTML = '<div class="note">Checking balances on Solana…</div>'
    txs = await B.transactions(payer, p)
    const fees = B.feesOf(txs, p.asset)
    const lamports = await sol.getBalance(payer)
    if (p.asset === 'sol') {
      if (lamports < p.total + fees) throw new Error(`Not enough SOL: this wallet has ${fmtUnits(lamports, 9)}, and this needs ${exact(p.total + fees, 9)} with the network fees.`)
    } else {
      await sol.verifyMint(sol.USDC)
      const have = await sol.getTokenAccountBalance(await sol.associatedTokenAddress(payer, sol.USDC.mint))
      if (!have || have.amount < p.total) throw new Error(`Not enough USDC: this wallet has ${fmtUnits(have ? have.amount : 0n, 6)}.`)
      const rent = BigInt(p.opens) * sol.TOKEN_ACCOUNT_RENT
      if (lamports < fees + rent) throw new Error(`You need about ${exact(fees + rent, 9)} SOL: the network fees${rent ? ', and rent for the USDC accounts this opens' : ''}.`)
    }
    // what goes out is what the screen shows: the plan for this payer
    drawSeq++
    shown = { p, txs }
    $('#sf-plan', root).innerHTML = `${pkgNote}${table(reviewed.list, p)}${summary(p, txs)}`
    balanceLine()
    lock(true)
    st.innerHTML = ''
    await sendAll(st, txs, 0, p)
  } catch (err) {
    $$('.note', st).forEach(x => x.remove())
    st.insertAdjacentHTML('beforeend', `<div class="note warn">${esc(friendly(err))}</div>`)
  } finally {
    sending = false
    lock(false)
    if (shown && shown.done) $('#sf-send', root).disabled = true
  }
}

/** Sends txs[from…] with the step list; on a stop, says what landed and offers the rest when it was never sent. */
async function sendAll(st, txs, from, p) {
  const n = txs.length
  try {
    const sigs = await sendSteps(st, txs.slice(from).map((t, i) => ({ ...t, label: label(t, from + i, n) })), from)
    markSent(txs.slice(from), sigs)
    if (shown) shown.done = true
    const t = p.token
    st.insertAdjacentHTML('beforeend', `<div class="note good">✓ Sent ${fmtUnits(p.total, t.decimals)} ${t.symbol} to ${plural(p.pay.length, 'domain')}.${p.pay.some(r => r.route === 'vault') ? ' Vault deposits show on the board, and each owner claims theirs with one DNS record.' : ''}</div>`)
  } catch (err) {
    const landed = err.signatures || []
    markSent(txs.slice(from), landed)
    const at = from + (err.index ?? 0)
    const paid = txs.slice(0, at).reduce((k, t) => k + t.rows.length, 0)
    $$('.note', st).forEach(x => x.remove())
    st.insertAdjacentHTML('beforeend', `<div class="note warn">${esc(friendly(err))}${at ? ` ${plural(paid, 'domain')} ${paid === 1 ? 'was' : 'were'} paid before it stopped: the ${paid === 1 ? 'one' : 'ones'} marked Sent.` : ''}</div>`)
    // a transaction the wallet never sent can go again; one it sent may still land, so it is checked on Solscan first
    if (!err.signature) {
      st.insertAdjacentHTML('beforeend', `<div class="ln-actions"><button class="btn sm" type="button" data-rest>Send the rest (${plural(n - at, 'transaction')})</button></div>`)
      $('[data-rest]', st).addEventListener('click', async e => {
        if (sending) return
        e.currentTarget.closest('.ln-actions').remove()
        // the steps that never started go: the rest gets a list of its own
        $$('.note, .sx-steps li[data-s="wait"]', st).forEach(x => x.remove())
        sending = true
        lock(true)
        try {
          // the routes are read again first, as Send does
          st.insertAdjacentHTML('beforeend', '<div class="note">Checking each domain\'s route again…</div>')
          const changed = await changedSince(txs.slice(at).flatMap(t => t.rows))
          $$('.note', st).forEach(x => x.remove())
          if (changed.length) throw new Error(`Some routes changed since your review: ${names(changed)}.`)
          await sendAll(st, txs, at, p)
        } catch (err) {
          $$('.note', st).forEach(x => x.remove())
          st.insertAdjacentHTML('beforeend', `<div class="note warn">${esc(friendly(err))}</div><p class="ln-est">To pay the rest, take the domains marked Sent out of the list and review it again.</p>`)
        } finally { sending = false; lock(false); if (shown && shown.done) $('#sf-send', root).disabled = true }
      })
    } else {
      st.insertAdjacentHTML('beforeend', '<p class="ln-est">Check the stopped transaction on Solscan before sending again. To pay the rest later, take the domains marked Sent out of the list and review it again.</p>')
    }
    if (shown) shown.done = true // the plan on screen is spent: a new review or a change makes the next one
  }
  balRead = null
  balanceLine()
}
