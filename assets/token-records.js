// Official token records in the app: a domain names its own tokens in a TXT record at _token.<domain>
// (lib/wallet262.js: resolveTokens, verifyToken). Verify checks a coin against a domain, Launch → Explore tags the coins
// their domain lists, and Publish offers the record. Nothing here touches the page until one of its functions is called.
import { resolveTokens, matchToken, verifyToken, tokenRef, addressKind, sameAddress, TOKEN_CHAINS, TOKEN_LABEL } from '../lib/wallet262.js'
import { $, $$, esc, short } from './ui.js'

// Where each chain's tokens are shown.
export const EXPLORERS = {
  SOL: ['Solscan', a => `https://solscan.io/token/${a}`],
  HOOD: ['Blockscout', a => `https://robinhoodchain.blockscout.com/token/${a}`],
  BASE: ['Basescan', a => `https://basescan.org/token/${a}`],
  ETH: ['Etherscan', a => `https://etherscan.io/token/${a}`],
}

// ---------- lookups: once per domain for the page, a few at a time ----------

const MAX_LOOKUPS = 3
const lookups = new Map() // domain -> Promise<resolveTokens result | null>
let running = 0
const waiting = []
const slot = () => new Promise(go => { if (running < MAX_LOOKUPS) { running++; go() } else waiting.push(go) })
const release = () => { const next = waiting.shift(); if (next) next(); else running-- }

/**
 * A domain's token records, read once for the page. A lookup that fails gives null, and one where a resolver failed
 * can't be verified: neither is kept, so the next call asks again.
 */
export function tokenRecords(domain, opts = {}) {
  if (!lookups.has(domain)) {
    const p = slot().then(() => resolveTokens(domain, opts)).catch(() => null).finally(release)
    lookups.set(domain, p)
    p.then(r => { if ((!r || r.resolvers.some(x => !x.ok)) && lookups.get(domain) === p) lookups.delete(domain) })
  }
  return lookups.get(domain)
}

/** True when the domain lists this mint in a record every resolver returned DNSSEC-signed, and they agree. */
export async function isOfficial(domain, mint, opts) {
  const res = domain ? await tokenRecords(domain, opts) : null
  return !!res && matchToken(res, mint).verified
}

/**
 * Tags the coin cards in el ([data-mint]) whose domain lists that coin: "Official · listed by <domain>". It runs in the
 * background, so the cards never wait for DNS. A card with its own [data-official] tag gets that tag filled in.
 */
export function markOfficial(el, items) {
  for (const t of items) {
    if (!t || !t.domain || !['solana', 'evm'].includes(addressKind(t.mint))) continue
    isOfficial(t.domain, t.mint).then(yes => {
      const card = yes && el.querySelector(`[data-mint="${t.mint}"]`)
      if (!card || $('.tk-official', card)) return
      const text = `Official · listed by ${t.domain}`
      const title = `${t.domain} lists this coin in its DNSSEC-signed ${TOKEN_LABEL} record, and the resolvers agree.`
      const own = $('[data-official]', card)
      if (own) { own.textContent = text; own.title = title; own.classList.add('tk-official'); return }
      const id = $('.ln-id', card)
      if (id) id.insertAdjacentHTML('afterend', `<span class="tag good tk-official" title="${esc(title)}">${esc(text)}</span>`)
    })
  }
}

// ---------- Verify: is this coin the domain's official token? ----------

/** The verdict for a verifyToken result, as HTML: every value from DNS or the user is escaped. */
export function tokenCheckHtml(v) {
  const answered = v.resolvers.filter(r => r.ok)
  const none = answered.every(r => !r.records.length)
  const chain = v.code ? TOKEN_CHAINS[v.code].name : ''
  const [explorer, url] = EXPLORERS[v.code] || []
  // the same trust wording as Pay
  const unverified = answered.length < v.resolvers.length
    ? 'Not every resolver answered, so the record could not be cross-checked. It is probably right; check again in a moment.'
    : v.records.some(r => r.dnssec)
      ? 'The record is not DNSSEC-signed on every resolver. It is probably right, but a network attacker could swap it.'
      : 'This zone is not DNSSEC-signed. The record is probably right, but a network attacker could swap it.'
  // a contract the domain lists on another chain: the same 0x address there is a different token
  const elsewhere = v.listed || !v.code ? [] : [...new Set(v.records.filter(r => r.code !== v.code && sameAddress(r.address, v.address)).map(r => TOKEN_CHAINS[r.code].name))]
  const [title, style, text] = v.verified
    ? ['Official token.', 'background:var(--acid);color:var(--on-acid)', `${v.domain} lists it as its ${chain} token in a DNSSEC-signed record, and every resolver agrees.`]
    : v.listed
      ? ['Listed, not verified.', '', `${v.domain} lists it as its ${chain} token. ${unverified}`]
      : v.nxdomain ? ["This name doesn't exist.", '', `${v.domain} is not a registered domain.`]
        : none ? ['No token records.', '', `${v.domain} publishes no ${TOKEN_LABEL} record, so its official token can't be checked in DNS.`]
          : !v.agree ? ['Resolvers disagree.', 'background:var(--hot);color:#fff', `The resolvers return different ${TOKEN_LABEL} records for ${v.domain}. That happens for a while after a record changes, or when something tampers with DNS. Check again in a moment.`]
            : elsewhere.length ? [`Not listed by ${v.domain}.`, 'background:var(--hot);color:#fff', `${v.domain} lists this address on ${elsewhere.join(' and ')}, not on ${chain}. A contract at the same address on another chain is a different token.`]
              : [`Not listed by ${v.domain}.`, 'background:var(--hot);color:#fff', `This is not a token ${v.domain} names as its own. The tokens it lists are below.`]
  const verdict = `
    <div class="result">
      <div class="r-empty" style="${style}">
        <strong>${esc(title)}</strong>
        <span class="mono">${esc(short(v.address))}${chain ? ` · ${esc(chain)}` : ''} · ${esc(v.reason)} · checked ${esc(v.domain)}</span>
      </div>
    </div>
    <div class="note${v.verified ? ' good' : ''}">${esc(text)}${url && v.listed ? ` <a href="${esc(url(v.address))}" target="_blank" rel="noopener">${esc(explorer)} ↗</a>` : ''}${none && !v.nxdomain ? ` Own it? <a href="#publish/${encodeURIComponent(v.domain)}">Publish one ↗</a>` : ''}</div>`
  if (!v.records.length && !v.invalid.length) return verdict
  // what the domain does list, so the real coin is one click away
  const rows = v.records.map(r => `
    <div class="r-row">
      <div class="r-code">${esc(r.code)}</div>
      <div class="addr">${esc(r.address)}</div>
      <div class="tags"><span class="tag">${esc(TOKEN_CHAINS[r.code].name)}</span>${r.dnssec ? '<span class="tag good">Signed</span>' : ''}<a class="tag" href="${esc(EXPLORERS[r.code][1](r.address))}" target="_blank" rel="noopener">${esc(EXPLORERS[r.code][0])} ↗</a></div>
    </div>`).join('')
  const bad = v.invalid.length
    ? `<div class="r-row"><div class="r-code">!</div><div class="addr">${v.invalid.length} malformed record(s): ${esc(v.invalid.map(x => x.error).join('; '))}</div></div>`
    : ''
  return verdict + `
    <div class="result">
      <div class="r-head"><span class="label">${esc(v.domain)} lists</span>
        <div class="tags">${v.dnssec ? '<span class="tag good">DNSSEC ✓</span>' : '<span class="tag">Unsigned zone</span>'}${v.agree ? `<span class="tag">${answered.length}/${v.resolvers.length} resolvers agree</span>` : '<span class="tag bad">Resolvers disagree</span>'}</div></div>
      ${rows}${bad}
    </div>`
}

/**
 * The link that opens Verify's token check with the domain and the coin filled in: #verify/token/<domain>/<coin>. A
 * contract goes as its explorer link, which names its chain.
 */
export function tokenCheckHref(domain, t) {
  const coin = t ? (t.code === 'SOL' ? t.address : EXPLORERS[t.code][1](t.address)) : ''
  return `#verify/token/${encodeURIComponent(domain)}${coin ? `/${encodeURIComponent(coin)}` : ''}`
}

/** Reads the argument of a #verify/token/<domain>/<coin> link (route() decodes it): { domain, coin }, or null. */
export function tokenCheckArg(arg) {
  const m = /^token(?:\/([^/]*)(?:\/(.+))?)?$/.exec(arg || '')
  return m ? { domain: m[1] || '', coin: m[2] || '' } : null
}

let checks = 0
/**
 * Verify's second mode: the payTo / token switch and the token form in view (#v-verify). Returns { open(domain, coin) },
 * which shows the token mode, fills in what it is given and runs the check once both fields are set.
 */
export function mountTokenCheck(view) {
  const form = $('[data-form=verify-token]', view)
  const out = $('#vtoken-out', view)
  const modes = { payto: [$('[data-form=verify]', view), $('#verify-out', view)], token: [form, out] }
  const show = mode => {
    $$('[data-vm]', view).forEach(x => { x.classList.toggle('on', x.dataset.vm === mode); x.setAttribute('aria-selected', String(x.dataset.vm === mode)) })
    for (const [m, els] of Object.entries(modes)) els.forEach(x => (x.hidden = m !== mode))
  }
  $$('[data-vm]', view).forEach(b => b.addEventListener('click', () => show(b.dataset.vm)))
  form.addEventListener('submit', async e => {
    e.preventDefault()
    const domain = form.elements.d.value.trim(), token = form.elements.t.value.trim()
    if (!domain || !token) { out.innerHTML = "<div class=\"note warn\">Give the project's domain and the coin: its mint or contract, or a pump.fun or explorer link.</div>"; return }
    const seq = ++checks
    out.innerHTML = '<div class="note">Checking DNS…</div>'
    try {
      const v = await verifyToken(domain, token)
      if (seq === checks) out.innerHTML = tokenCheckHtml(v)
    } catch (err) { if (seq === checks) out.innerHTML = `<div class="note warn">${esc(err.message)}</div>` }
  })
  return {
    open(domain, coin) {
      show('token')
      if (domain) form.elements.d.value = domain
      if (coin) form.elements.t.value = coin
      if (form.elements.d.value.trim() && form.elements.t.value.trim()) form.requestSubmit()
    },
  }
}

// ---------- Publish: the optional _token record ----------

/**
 * One token entry from the chain picker and the pasted text: { code, address, error }; address is set when the record
 * can be written. A mint is on Solana, and a link to a known explorer names its chain, whatever the picker shows
 * (tokenRef). A bare 0x contract takes the picker's chain, and waits for one while the picker is on Solana.
 */
export function tokenEntry(code, raw) {
  const s = String(raw || '').trim()
  if (!TOKEN_CHAINS[code]) code = 'SOL'
  if (!s) return { code, address: '', error: '' }
  let ref
  try { ref = tokenRef(s) } catch { return { code, address: '', error: "That isn't a token address, or a pump.fun or explorer link to one." } }
  if (ref.code) return { code: ref.code, address: ref.address, error: '' }
  if (TOKEN_CHAINS[code].kind === 'evm') return { code, address: ref.address, error: '' }
  const evm = Object.entries(TOKEN_CHAINS).filter(([, x]) => x.kind === 'evm').map(([, x]) => x.name)
  return { code, address: '', error: `Pick the chain this contract lives on: ${evm.slice(0, -1).join(', ')} or ${evm.at(-1)}.` }
}

const TOKEN_HINT = `For projects with their own coin. A ${TOKEN_LABEL} record names it in DNS, so wallets, agents and the TYPE/262 app can tell it from copies. For a 0x contract, pick the chain it lives on, or paste its Basescan, Etherscan or Blockscout link.`

/** The token picker in Publish's step 02, inside el. onChange re-renders the records. */
export function mountPublishToken(el, onChange) {
  el.innerHTML = `
    <details class="pb-adv pb-tk">
      <summary>Have a token? List it as your official token (optional)</summary>
      <div class="pb-row">
        <div class="pb-addr field sm">
          <select class="pb-tkc" aria-label="Chain the token lives on">${Object.entries(TOKEN_CHAINS).map(([c, x]) => `<option value="${c}">${esc(x.name)}</option>`).join('')}</select>
          <input class="pb-a" placeholder="Mint or contract, or a pump.fun or explorer link" aria-label="Token address" spellcheck="false" autocomplete="off">
        </div>
        <p class="pb-hint">${esc(TOKEN_HINT)}</p>
      </div>
    </details>`
  const sync = () => {
    const s = tokenEntry($('select', el).value, $('input', el).value)
    $('select', el).value = s.code
    const row = $('.pb-row', el), hint = $('.pb-hint', el)
    row.classList.toggle('bad', !!s.error)
    row.classList.toggle('good', !!s.address)
    hint.textContent = s.error || (s.address ? `${TOKEN_CHAINS[s.code].name} token ${short(s.address)}. Its record is in step 03.` : TOKEN_HINT)
    hint.classList.toggle('err', !!s.error)
    onChange()
  }
  $('input', el).addEventListener('input', sync)
  $('select', el).addEventListener('change', sync)
}

/** The token entry to publish, or null when there is none (or it isn't valid). */
export function publishToken(el) {
  const sel = el && $('select', el), input = el && $('input', el)
  if (!sel || !input) return null
  const s = tokenEntry(sel.value, input.value)
  return s.address ? { code: s.code, address: s.address } : null
}

/** Publish's step 03 block for the token record: Name and Content with copy buttons, like the wallet records. */
export function tokenRecordHtml(t, { domain, sub = '', ttlText }) {
  const name = sub ? `${TOKEN_LABEL}.${sub}` : TOKEN_LABEL
  const cell = (value, label) => `<div class="pb-cell"><code>${esc(value)}</code><button class="pb-copy" type="button" data-copy="${esc(value)}" aria-label="Copy ${label}">Copy</button></div>`
  return `
    <div class="pb-tkrec">
      <p class="pb-fine"><b>Official token, optional.</b> One more TXT record names the ${esc(TOKEN_CHAINS[t.code].name)} token <code>${esc(short(t.address))}</code> as ${esc(domain)}'s own.</p>
      <div class="pb-table" role="table" aria-label="Token record to add">
        <div class="pb-tr pb-th" role="row"><div>Type</div><div>Name</div><div>Content</div><div>TTL</div></div>
        <div class="pb-tr">
          <div class="pb-td" data-th="Type"><span class="pb-type">TXT</span></div>
          <div class="pb-td" data-th="Name">${cell(name, 'token record name')}</div>
          <div class="pb-td" data-th="Content">${cell(`${t.code} ${t.address}`, 'token record content')}</div>
          <div class="pb-td" data-th="TTL"><span class="pb-ttlv">${esc(ttlText)}</span></div>
        </div>
      </div>
      <p class="pb-fine">Some hosts want the full name: <code>${esc(TOKEN_LABEL)}.${esc(domain)}</code>. Once DNSSEC is on, Verify shows the coin as official, and so does Launch → Explore for a coin launched here for this domain.</p>
    </div>`
}
