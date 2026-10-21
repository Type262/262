import {
  resolveWallets, resolveWalletsUp, verifyPayTo, payTosFromX402, zoneLines, normalizeDomain,
  addressKind, codeMatchesAddress, transferTx, paymentUri, parseUnits, sameAddress, EVM_CODES,
} from '../lib/wallet262.js'
import { $, $$, esc, short, copy, loading, renderResult, renderError } from './ui.js'
import { encodeCall, SEL, words, toBig, toAddr, decodeString, decodeLaunches, decodeLaunch } from './abi.js'
import * as config from './config.js'
import { walletProof } from './dnssec.js'
import { toast, ambient } from './fx.js'

ambient(48)
const { ESCROW_ADDRESS = '', LAUNCHER_ADDRESS = '' } = config

// The last domain you touched follows you across tools.
let lastDomain = ''
document.addEventListener('submit', e => {
  const d = e.target.d || e.target.u
  if (d && d.value) lastDomain = d.value.trim()
}, true)

// Robinhood Chain mainnet (Arbitrum Orbit L2). USDG verified on-chain: symbol USDG, 6 decimals.
const CHAIN = {
  id: 4663, name: 'Robinhood Chain', native: 'ETH',
  stable: { symbol: 'USDG', address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', decimals: 6 },
  rpc: config.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com', explorer: 'https://robinhoodchain.blockscout.com',
  // read-only fallback on our server for browsers that can't reach the public RPC (DNS trouble, outages)
  rpcFallback: config.RPC_FALLBACK || 'https://type262-upload.onrender.com/rpc',
}
const SOL_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

// ---------- routing ----------
const VIEWS = ['resolve', 'pay', 'escrow', 'publish', 'verify', 'badge', 'launch']
let lastKey = ''
function route() {
  const [v0, ...rest] = location.hash.slice(1).split('/')
  const v = VIEWS.includes(v0) ? v0 : 'resolve'
  let arg = rest.join('/')
  try { arg = decodeURIComponent(arg) } catch {}
  const key = v === 'launch' ? `launch/${arg}` : v
  if (key !== lastKey) { if (lastKey) scrollTo(0, 0); lastKey = key }
  $$('.view').forEach(el => el.classList.toggle('on', el.id === `v-${v}`))
  $$('.rail a').forEach(a => a.classList.toggle('on', a.dataset.v === v))
  const rail = $('.rail'), on = $('.rail a.on')
  if (on && rail.scrollWidth > rail.clientWidth) rail.scrollLeft = on.offsetLeft - (rail.clientWidth - on.offsetWidth) / 2
  if (v === 'launch') return showLaunch(arg)
  if (arg) prefill(v, arg, true) // a link to a domain always shows fresh results
  else if (lastDomain) prefill(v, lastDomain, false) // the last domain follows you, re-queried only if it changed
}
function prefill(v, arg, force) {
  const set = (sel, val) => { const el = $(sel); if (el && (force || el.value !== val)) { el.value = val; return true } }
  if (v === 'resolve' && set('#v-resolve input[name=d]', arg)) $('[data-form=resolve]').requestSubmit()
  if (v === 'pay' && set('#v-pay input[name=d]', arg)) $('[data-form=pay]').requestSubmit()
  if (v === 'escrow' && set('#v-escrow input[name=d]', arg)) $('[data-form=escrow]').requestSubmit()
  if (v === 'publish' && set('#pub-d', arg)) renderPublish()
  if (v === 'verify') set('#v-verify input[name=u]', arg)
  if (v === 'badge' && set('#badge-d', arg)) renderBadge()
}
addEventListener('hashchange', route)

// ---------- wallet ----------
let account = null
const eth = () => window.ethereum
const WALLET_KEY = 't262-wallet'
const remembered = () => { try { return localStorage.getItem(WALLET_KEY) } catch { return null } }

// forget: only an explicit disconnect or a revoked permission forgets the wallet; a locked wallet is remembered.
function setAccount(a, { forget = false } = {}) {
  const next = a || null
  const changed = next !== account
  account = next
  $('#connect span').textContent = account ? short(account) : 'Connect wallet'
  try { if (account) localStorage.setItem(WALLET_KEY, account); else if (forget) localStorage.removeItem(WALLET_KEY) } catch {}
  if (changed) onAccountChange()
}

// Views that show per-wallet data re-read it when the account changes (not while a transaction is in flight).
function onAccountChange() {
  if (txBusy) return
  const v = location.hash.slice(1).split('/')[0]
  if (v === 'escrow' && escDomain && ESCROW_ADDRESS) escrowState(escDomain).then(s => { if (escDomain && !txBusy) renderEscrow(escDomain, s) }).catch(() => {})
  if (v === 'launch' && tokenView && $('#ln-token').classList.contains('on')) showToken(tokenView.token)
}

let watching = false
function watch() {
  if (watching || !eth() || !eth().on) return
  watching = true
  // After a disconnect nothing is remembered, so switching accounts in the wallet doesn't reconnect.
  eth().on('accountsChanged', ([a]) => { if (account || remembered()) setAccount(a) })
}

async function connect() {
  if (!eth()) throw new Error('No browser wallet found. Install one, or copy the payment link into a phone wallet.')
  const [a] = await eth().request({ method: 'eth_requestAccounts' })
  setAccount(a)
  watch()
  return a
}

// First visit: the wallet is never touched until the user clicks Connect (or Send).
// Returning visit (connected before): restore silently with eth_accounts, which never prompts
// for a site the wallet already approved. If access was revoked, forget it.
const restored = remembered() && eth()
  ? eth().request({ method: 'eth_accounts' }).then(([a]) => { if (a) setAccount(a); watch() }).catch(() => setAccount(null, { forget: true }))
  : Promise.resolve()

// Click when connected = disconnect (forget this wallet on this device).
$('#connect').addEventListener('click', () => {
  if (account) { setAccount(null, { forget: true }); toast('Wallet disconnected'); return }
  connect().catch(e => toast(e.message || 'Connection cancelled'))
})

async function switchChain(c) {
  const chainId = '0x' + c.id.toString(16)
  try {
    await eth().request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] })
  } catch (e) {
    if (e.code !== 4902) throw e
    await eth().request({
      method: 'wallet_addEthereumChain',
      params: [{ chainId, chainName: c.name, rpcUrls: [c.rpc], blockExplorerUrls: [c.explorer], nativeCurrency: { name: c.native, symbol: c.native, decimals: 18 } }],
    })
  }
}

// ---------- resolve ----------
$('[data-form=resolve]').addEventListener('submit', async e => {
  e.preventDefault()
  const out = $('#resolve-out')
  const d = e.target.d.value || e.target.d.placeholder
  $('#resolve-raw').hidden = true
  loading(out)
  try {
    const r = await resolveWallets(d)
    renderResult(out, r, { appBase: '' })
    history.replaceState(null, '', `#resolve/${r.domain}`)
    $('#resolve-raw').hidden = false
    $('#resolve-json').textContent = JSON.stringify(r.resolvers, null, 2)
  } catch (err) { renderError(out, err.message) }
})

// ---------- pay ----------
let payCtx = null
$('[data-form=pay]').addEventListener('submit', async e => {
  e.preventDefault()
  const box = $('#pay-step')
  const d = e.target.d.value
  box.innerHTML = '<div class="result"></div>'
  loading(box.firstChild)
  try {
    const r = await resolveWalletsUp(d)
    history.replaceState(null, '', `#pay/${r.resolvedAt}`)
    payCtx = { r, pick: 0 }
    renderPay()
  } catch (err) { renderError(box.firstChild, err.message) }
})

function renderPay() {
  const box = $('#pay-step')
  const { r } = payCtx
  if (!r.records.length) {
    box.innerHTML = `<div class="result"></div>`
    renderResult(box.firstChild, r, { appBase: '' })
    return
  }
  const rec = r.records[payCtx.pick]
  const kind = addressKind(rec.address)
  const trust = !r.agree
    ? '<div class="note warn">Resolvers disagree about this domain\'s wallet. Something is tampering with DNS. Sending is disabled.</div>'
    : r.verified
      ? '<div class="note good">✓ DNSSEC-signed and confirmed by every resolver. This address is what the domain owner published.</div>'
      : '<div class="note warn">This zone is not DNSSEC-signed. The record is probably right, but a network attacker could swap it. Double-check large amounts.</div>'
  const picker = r.records.map((x, i) => `
    <label class="r-row pick ${i === payCtx.pick ? 'sel' : ''}">
      <input type="radio" name="pick" value="${i}" ${i === payCtx.pick ? 'checked' : ''} class="sr">
      <div class="r-code">${esc(x.code)}</div><div class="addr">${esc(x.address)}</div>
      <div class="tags"><span class="tag">${x.source === 'TYPE262' ? 'TYPE262' : '_wallet TXT'}</span></div>
    </label>`).join('')
  const evm = kind === 'evm'
  box.innerHTML = `
    <div class="result"><div class="r-head"><span class="label">${esc(r.resolvedAt)} publishes ${r.records.length} wallet(s)</span><span class="tag ${r.dnssec ? 'good' : ''}">${r.dnssec ? 'DNSSEC ✓' : 'Unsigned'}</span></div>${picker}</div>
    ${trust}
    <div class="row-2">
      ${evm ? `<div><span class="label lbl">Network</span><div class="field sm"><input value="${CHAIN.name} · ${CHAIN.id}" readonly aria-label="Network"></div></div>` : ''}
      <div><span class="label lbl">Asset</span><div class="field sm"><select id="p-asset">${evm ? `<option value="stable">${CHAIN.stable.symbol}</option><option value="native">${CHAIN.native}</option>` : kind === 'solana' ? '<option value="sol">SOL</option><option value="usdc">USDC</option>' : `<option value="native">${esc(rec.code)}</option>`}</select></div></div>
      <div><span class="label lbl">Amount</span><div class="field sm"><input id="p-amt" inputmode="decimal" placeholder="5.00" value="5"></div></div>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:0.75rem">
      ${evm ? `<button class="btn solid" id="p-send" ${r.agree ? '' : 'disabled'}>Send from wallet</button>` : ''}
      ${PHONE ? '<a class="btn" id="p-link" href="#">Open in wallet app</a>' : ''}
      <button class="btn" id="p-copy-link" type="button">Copy payment link</button>
      <button class="btn" id="p-copy" type="button">Copy address</button>
    </div>
    <div id="p-status"></div>`
  $$('input[name=pick]', box).forEach(el => el.addEventListener('change', () => { payCtx.pick = +el.value; renderPay() }))
  const sync = () => { if ($('#p-link')) $('#p-link').href = linkFor(rec, kind) }
  ;['#p-asset', '#p-amt'].forEach(s => $(s) && $(s).addEventListener('input', sync))
  sync()
  $('#p-copy').addEventListener('click', e => copy(rec.address, e.currentTarget))
  $('#p-copy-link').addEventListener('click', e => {
    const link = linkFor(rec, kind)
    if (link === '#') $('#p-status').innerHTML = '<div class="note warn">Enter a valid amount first.</div>'
    else { $('#p-status').innerHTML = ''; copy(link, e.currentTarget) }
  })
  if (evm) $('#p-send').addEventListener('click', () => send(rec))
}

const PHONE = navigator.userAgentData ? navigator.userAgentData.mobile : /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)

function linkFor(rec, kind) {
  const amount = $('#p-amt').value.trim()
  try {
    if (kind === 'evm') {
      const s = $('#p-asset').value === 'stable' ? CHAIN.stable : null
      return paymentUri(rec.address, { amount, chainId: CHAIN.id, token: s ? s.address : undefined, decimals: s ? s.decimals : 18 })
    }
    if (kind === 'solana') return paymentUri(rec.address, { amount, splToken: $('#p-asset').value === 'usdc' ? SOL_USDC : undefined })
    return paymentUri(rec.address, { amount })
  } catch { return '#' }
}

async function send(rec) {
  const status = $('#p-status')
  const c = CHAIN
  const s = $('#p-asset').value === 'stable' ? c.stable : null
  const amount = $('#p-amt').value.trim()
  const btn = $('#p-send')
  btn.disabled = true
  status.innerHTML = '<div class="note">Waiting for your wallet…</div>'
  try {
    const tx = transferTx({ from: account || '', to: rec.address, amount, decimals: s ? s.decimals : 18, token: s ? s.address : undefined })
    delete tx.from
    status.innerHTML = '<div class="note">Confirm in your wallet, then wait for Robinhood Chain…</div>'
    const r = await sendTx(tx)
    status.innerHTML = `<div class="note good">✓ Sent ${esc(amount)} ${s ? s.symbol : c.native} to ${esc(payCtx.r.resolvedAt)} on ${c.name}. <a href="${c.explorer}/tx/${r.transactionHash}" target="_blank" rel="noopener">View transaction ↗</a></div>`
  } catch (err) {
    status.innerHTML = `<div class="note warn">${esc(err.message || 'Transaction cancelled')}</div>`
  } finally { btn.disabled = false }
}

// ---------- escrow ----------
const ZERO = '0x0000000000000000000000000000000000000000'
const pause = ms => new Promise(r => setTimeout(r, ms))

// The public RPC first. If it can't be reached, the fallback serves reads for the next minute.
let publicDownAt = 0
async function rpcPost(payload) {
  const body = JSON.stringify(payload)
  const urls = Date.now() - publicDownAt < 60_000 ? [CHAIN.rpcFallback, CHAIN.rpc] : [CHAIN.rpc, CHAIN.rpcFallback]
  let last
  for (const url of urls) {
    try {
      // the fallback may need a cold start on the host
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(url === CHAIN.rpc ? 20_000 : 60_000) })
      if (!res.ok && (res.status >= 500 || res.status === 429 || url !== CHAIN.rpc)) throw new Error(`RPC answered ${res.status}`)
      const j = await res.json()
      if (url === CHAIN.rpc) publicDownAt = 0
      return j
    } catch (err) {
      last = err
      if (url === CHAIN.rpc) publicDownAt = Date.now()
    }
  }
  throw new Error(`Can't reach Robinhood Chain right now (${last.message}). Try again in a moment.`)
}

async function rpc(method, params) {
  const j = await rpcPost({ jsonrpc: '2.0', id: 1, method, params })
  if (j.error) throw new Error(j.error.message)
  return j.result
}
const view = data => rpc('eth_call', [{ to: ESCROW_ADDRESS, data }, 'latest'])

let txBusy = 0
async function sendTx(params) {
  txBusy++
  try {
    const from = account || await connect()
    await switchChain(CHAIN)
    if (parseInt(await eth().request({ method: 'eth_chainId' }), 16) !== CHAIN.id) throw new Error(`Switch your wallet to ${CHAIN.name} first.`)
    const hash = await eth().request({ method: 'eth_sendTransaction', params: [{ from, ...params }] })
    for (let i = 0; i < 80; i++) {
      const r = await rpc('eth_getTransactionReceipt', [hash])
      if (r) { if (r.status !== '0x1') throw new Error('Transaction reverted'); return r }
      await pause(1500)
    }
    throw new Error(`Still pending after 2 minutes (${hash}). Check it on Blockscout before trying again.`)
  } finally { txBusy-- }
}

function fmtUnits(v, dec) {
  const s = v.toString().padStart(dec + 1, '0')
  const frac = s.slice(-dec).replace(/0+$/, '').slice(0, 6)
  return frac ? `${s.slice(0, -dec)}.${frac}` : s.slice(0, -dec)
}

async function escrowState(domain) {
  const bal = token => view(encodeCall(SEL.balanceOf, ['string', 'address'], [domain, token])).then(h => toBig(words(h)[0]))
  const mine = token => account
    ? view(encodeCall(SEL.refundableOf, ['string', 'address', 'address'], [domain, token, account])).then(h => ({ amount: toBig(words(h)[0]), unlocksAt: Number(toBig(words(h)[1])) }))
    : null
  const [eth, usdg, myEth, myUsdg, dns, paused] = await Promise.all([
    bal(ZERO), bal(CHAIN.stable.address), mine(ZERO), mine(CHAIN.stable.address),
    resolveWallets(domain).catch(() => null), view(SEL.depositsPaused).then(h => toBig(words(h)[0]) === 1n),
  ])
  return { eth, usdg, myEth, myUsdg, dns, paused }
}

if (!ESCROW_ADDRESS) {
  $('#esc-cfg').innerHTML = '<div class="note warn" style="margin-bottom:1.5rem">The escrow contracts are not deployed yet. See DEPLOY.md, then run scripts/post-deploy.mjs.</div>'
}

$('[data-form=escrow]').addEventListener('submit', async e => {
  e.preventDefault()
  const out = $('#esc-out')
  let domain
  try { domain = normalizeDomain(e.target.d.value) } catch (err) { escDomain = ''; out.innerHTML = `<div class="note warn">${esc(err.message)}</div>`; return }
  escDomain = domain
  history.replaceState(null, '', `#escrow/${domain}`)
  if (!ESCROW_ADDRESS) { out.innerHTML = '<div class="note">Escrow is not live yet (see above).</div>'; return }
  out.innerHTML = '<div class="note">Reading Robinhood Chain…</div>'
  try {
    const s = await escrowState(domain)
    if (escDomain === domain) renderEscrow(domain, s)
  } catch (err) { if (escDomain === domain) out.innerHTML = `<div class="note warn">${esc(err.message)}</div>` }
})

let escDomain = ''
function renderEscrow(domain, s) {
  const out = $('#esc-out')
  const now = Date.now() / 1000
  const waiting = s.eth > 0n || s.usdg > 0n
  const txtWallet = s.dns && s.dns.records.find(r => r.source === 'TXT' && addressKind(r.address) === 'evm' && codeMatchesAddress(r.code, r.address))
  const refundRows = [[s.myUsdg, CHAIN.stable], [s.myEth, { symbol: 'ETH', address: ZERO, decimals: 18 }]]
    .filter(([m]) => m && m.amount > 0n)
    .map(([m, t]) => {
      const unlocked = now >= m.unlocksAt
      return `<div class="r-row"><div class="r-code">${t.symbol}</div><div class="addr">Your deposit: ${fmtUnits(m.amount, t.decimals)}. ${unlocked ? 'Refundable now.' : `Refundable from ${new Date(m.unlocksAt * 1000).toLocaleDateString()}.`}</div>
        <div class="tags">${unlocked ? `<button class="tag" data-refund="${t.address}">Refund</button>` : ''}</div></div>`
    }).join('')
  const found = txtWallet
    ? `Found <span class="mono">${esc(short(txtWallet.address))}</span>${txtWallet.dnssec ? ' · DNSSEC ✓' : ' · <b>DNSSEC is off</b>'}.`
    : '<b>No _wallet TXT record found yet.</b>'

  out.innerHTML = `
    <div class="result">
      <div class="r-head"><span class="label">Waiting for ${esc(domain)}</span><span class="tag">Robinhood Chain</span></div>
      <div class="r-row"><div class="r-code">USDG</div><div class="addr" style="font-size:1.75rem">${fmtUnits(s.usdg, 6)}</div></div>
      <div class="r-row"><div class="r-code">ETH</div><div class="addr" style="font-size:1.75rem">${fmtUnits(s.eth, 18)}</div></div>
      ${refundRows}
    </div>
    ${s.paused ? '<div class="note warn">Deposits are paused for now. Claims and refunds still work.</div>' : ''}
    <div><span class="label lbl">Send to escrow</span>
      <div class="row-2">
        <div class="field sm"><select id="esc-asset"><option value="stable">USDG</option><option value="native">ETH</option></select></div>
        <div class="field sm"><input id="esc-amt" inputmode="decimal" value="5" aria-label="Amount"></div>
        <button class="btn solid" id="esc-dep" type="button" ${s.paused ? 'disabled' : ''}>Send</button>
      </div>
    </div>
    <div class="note">
      <b>Own ${esc(domain)}?</b> Claim instantly: publish a <span class="mono">_wallet.${esc(domain)}</span> TXT record with your wallet
      (<a href="#publish/${encodeURIComponent(domain)}">Publish</a> makes it for you) and turn on DNSSEC at your DNS host.
      Your browser builds a DNSSEC proof and the contract checks it on-chain. ${found}
      <div style="margin-top:.75rem"><button class="btn primary sm" id="esc-claim" type="button" ${txtWallet && txtWallet.dnssec ? '' : 'disabled'}>${waiting ? 'Claim to' : 'Register'} ${txtWallet ? esc(short(txtWallet.address)) : 'your wallet'}</button></div>
      ${!waiting && txtWallet && txtWallet.dnssec ? '<div style="margin-top:.5rem">Nothing to claim yet. Registering your current record now means an older signed record (an old wallet) can never claim later payments.</div>' : ''}
    </div>
    <div id="esc-status"></div>`

  const status$ = $('#esc-status')
  // One action at a time; buttons stay disabled until it settles. A failed refresh after a successful
  // transaction is not reported as a failure, and a result never overwrites another domain's view.
  const run = async (label, done, fn) => {
    const btns = $$('button', out)
    const prev = btns.map(b => b.disabled)
    btns.forEach(b => (b.disabled = true))
    status$.innerHTML = `<div class="note">${esc(label)}…</div>`
    try { await fn() } catch (err) {
      btns.forEach((b, i) => (b.disabled = prev[i]))
      status$.innerHTML = `<div class="note warn">${esc(err.message || 'Cancelled')}</div>`
      return
    }
    if (escDomain !== domain) { toast(`${done} (${domain})`); return }
    try { renderEscrow(domain, await escrowState(domain)) } catch {}
    $('#esc-status').innerHTML = `<div class="note good">✓ ${esc(done)}</div>`
  }

  $('#esc-dep').addEventListener('click', () => run('Sending to escrow', `Sent to ${domain}'s escrow.`, async () => {
    const amount = $('#esc-amt').value.trim()
    if ($('#esc-asset').value === 'native') {
      const value = '0x' + parseUnits(amount, 18).toString(16)
      return sendTx({ to: ESCROW_ADDRESS, value, data: encodeCall(SEL.deposit, ['string'], [domain]) })
    }
    const t = CHAIN.stable
    const units = parseUnits(amount, t.decimals)
    const from = account || await connect()
    const allowance = await rpc('eth_call', [{ to: t.address, data: encodeCall(SEL.allowance, ['address', 'address'], [from, ESCROW_ADDRESS]) }, 'latest'])
    if (toBig(words(allowance)[0]) < units) {
      await sendTx({ to: t.address, data: encodeCall(SEL.approve, ['address', 'uint256'], [ESCROW_ADDRESS, units]) })
    }
    return sendTx({ to: ESCROW_ADDRESS, data: encodeCall(SEL.depositToken, ['string', 'address', 'uint256'], [domain, t.address, units]) })
  }))

  $('#esc-claim').addEventListener('click', () => run('Building the DNSSEC proof', waiting ? `Claimed to ${short(txtWallet.address)}.` : 'Registered. Older records can no longer claim.', async () => {
    const proof = await walletProof(domain)
    status$.innerHTML = '<div class="note">Proof ready. Confirm in your wallet…</div>'
    return sendTx({ to: ESCROW_ADDRESS, data: encodeCall(SEL.claim, ['string', 'address', 'bytes', 'address[]'], [domain, txtWallet.address, proof, [ZERO, CHAIN.stable.address]]) })
  }))

  $$('[data-refund]', out).forEach(b => b.addEventListener('click', () => run('Refunding', 'Refunded.', () =>
    sendTx({ to: ESCROW_ADDRESS, data: encodeCall(SEL.refund, ['string', 'address'], [domain, b.dataset.refund]) }))))
}

// ---------- publish ----------
// One row per address. The network sets the coin code written to DNS. EVM addresses are written as "ETH":
// it's the code wallets know, and one of the EVM codes DnssecVerifier accepts for escrow claims.
const NETWORKS = {
  evm: {
    code: 'ETH', kind: 'evm', label: 'Robinhood Chain', tag: 'EVM', placeholder: '0x…',
    icon: '<img src="assets/chains/robinhood.png" alt="" width="20" height="20">',
    hint: 'Live on TYPE/262: payments, escrow claims and launch fees settle on Robinhood Chain (4663). Use a regular wallet address, not a multisig or smart-contract wallet: other apps read "ETH" and may pay it on Ethereum or other EVM chains.',
  },
  btc: {
    code: 'BTC', kind: 'btc', label: 'Bitcoin', placeholder: 'bc1…',
    icon: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="10" fill="#f7931a"/><path fill="#fff" d="M13.6 8.7c.2-1.3-.8-2-2.2-2.5l.4-1.8-1.1-.3-.4 1.7-.9-.2.4-1.7-1.1-.3-.4 1.8-.7-.2-1.5-.4-.3 1.2s.8.2.8.2c.5.1.5.4.5.6l-.5 2-.1.1h.1l-.7 2.8c-.1.1-.2.3-.5.2l-.8-.2-.5 1.3 1.4.4.8.2-.5 1.8 1.1.3.4-1.8.9.2-.4 1.8 1.1.3.5-1.8c1.9.4 3.3.2 3.9-1.5.5-1.4 0-2.2-1-2.7.7-.2 1.3-.7 1.4-1.7zm-2.5 3.5c-.3 1.4-2.7.6-3.4.4l.6-2.5c.8.2 3.2.6 2.8 2.1zm.4-3.5c-.3 1.3-2.3.6-2.9.5l.6-2.2c.6.1 2.7.4 2.3 1.7z"/></svg>',
    hint: 'Published for wallets that read DNS. TYPE/262 itself settles on Robinhood Chain, so add an EVM address too.',
  },
  sol: {
    code: 'SOL', kind: 'solana', label: 'Solana', placeholder: 'Base58 address',
    icon: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect width="20" height="20" rx="10" fill="#0b0b0b"/><defs><linearGradient id="solg" x1="0" x2="1"><stop offset="0" stop-color="#9945ff"/><stop offset="1" stop-color="#14f195"/></linearGradient></defs><path fill="url(#solg)" d="M6.6 12.6h8.3l-1.5 1.5H5.1zm0-6.7h8.3L13.4 7.4H5.1zm8.3 3.3H6.6l-1.5 1.5h8.3z"/></svg>',
    hint: 'Published for wallets that read DNS. TYPE/262 itself settles on Robinhood Chain, so add an EVM address too.',
  },
  other: {
    code: '', kind: 'other', label: 'Other', placeholder: 'Address',
    icon: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="9.25" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="6" cy="10" r="1.2" fill="currentColor"/><circle cx="10" cy="10" r="1.2" fill="currentColor"/><circle cx="14" cy="10" r="1.2" fill="currentColor"/></svg>',
    hint: 'Any coin code your wallet uses, e.g. LTC or XMR.',
  },
}
const KIND_TO_NET = { evm: 'evm', btc: 'btc', solana: 'sol' }
const KIND_NAME = { evm: 'an EVM (0x…) address', btc: 'a Bitcoin address', solana: 'a Solana address' }
const entries = $('#pub-entries')

function addEntry(net = 'evm', address = '') {
  const row = document.createElement('div')
  row.className = 'pb-row'
  row.innerHTML = `
    <div class="pb-nets" role="radiogroup" aria-label="Network">
      ${Object.entries(NETWORKS).map(([k, n]) => `<button type="button" role="radio" data-net="${k}"><span class="pb-ico">${n.icon}</span>${n.label}${n.tag ? `<em>${n.tag}</em>` : ''}</button>`).join('')}
    </div>
    <div class="pb-addr field sm">
      <input class="pb-coin" maxlength="16" placeholder="Code" aria-label="Coin code" spellcheck="false" autocomplete="off">
      <input class="pb-a" aria-label="Address" spellcheck="false" autocomplete="off">
      <button type="button" class="pb-mine">Use my wallet</button>
      <button type="button" class="pb-x" aria-label="Remove this address">×</button>
    </div>
    <p class="pb-hint"></p>`
  row.querySelector('.pb-a').value = address
  const setNet = k => { row.dataset.net = k; syncRow(row); renderPublish() }
  $$('[data-net]', row).forEach(b => b.addEventListener('click', () => setNet(b.dataset.net)))
  row.querySelector('.pb-a').addEventListener('input', e => {
    const kind = addressKind(e.target.value.trim())
    const detected = KIND_TO_NET[kind]
    if (detected && NETWORKS[row.dataset.net].kind !== kind && row.dataset.net !== 'other') row.dataset.net = detected
    syncRow(row)
    renderPublish()
  })
  row.querySelector('.pb-coin').addEventListener('input', e => {
    const el = e.target, p = el.selectionStart, v = el.value.toUpperCase().replace(/[^A-Z0-9._-]/g, '')
    if (v !== el.value) { const k = Math.max(0, p - (el.value.length - v.length)); el.value = v; el.setSelectionRange(k, k) }
    syncRow(row)
    renderPublish()
  })
  row.querySelector('.pb-mine').addEventListener('click', async () => {
    try {
      row.querySelector('.pb-a').value = account || await connect()
      syncRow(row)
      renderPublish()
    } catch (err) { toast(eth() ? (err.message || 'Connection cancelled') : 'No browser wallet found. Paste your address instead.') }
  })
  row.querySelector('.pb-x').addEventListener('click', () => { row.remove(); syncRemove(); renderPublish() })
  row.dataset.net = net
  entries.append(row)
  syncRow(row)
  syncRemove()
}

/** One row's state: chosen network, code, validity and the hint under it. */
function rowState(row) {
  const net = NETWORKS[row.dataset.net]
  const address = row.querySelector('.pb-a').value.trim()
  const code = row.dataset.net === 'other' ? row.querySelector('.pb-coin').value.trim().toUpperCase() : net.code
  const kind = address ? addressKind(address) : ''
  let error = ''
  const other = row.dataset.net === 'other'
  if (address && net.kind !== 'other' && kind !== net.kind) error = `That isn't ${KIND_NAME[net.kind]}.${kind === 'other' ? ' For other coins (LTC, DOGE…), pick Other.' : ''}`
  else if (address && /[\s"\\]/.test(address)) error = "Addresses can't contain spaces, quotes or backslashes."
  else if (address && other && !code) error = 'Add a coin code.'
  else if (address && other && code.length < 2) error = 'Coin codes are 2 to 16 characters.'
  else if (address && other && EVM_CODES.has(code) && kind !== 'evm') error = `${code} needs a 0x address. Use the Robinhood Chain network.`
  else if (address && other && !codeMatchesAddress(code, address)) error = `That looks like ${KIND_NAME[kind]}; pick its network instead.`
  return { net, code, address, error, ok: !!address && !error }
}

function syncRow(row) {
  const s = rowState(row)
  $$('[data-net]', row).forEach(b => b.setAttribute('aria-checked', String(b.dataset.net === row.dataset.net)))
  const other = row.dataset.net === 'other'
  row.querySelector('.pb-coin').hidden = !other
  row.querySelector('.pb-a').placeholder = s.net.placeholder
  row.querySelector('.pb-mine').hidden = row.dataset.net !== 'evm' || !!s.address
  row.classList.toggle('bad', !!s.error)
  row.classList.toggle('good', s.ok)
  const hint = row.querySelector('.pb-hint')
  hint.textContent = s.error || s.net.hint
  hint.classList.toggle('err', !!s.error)
}
const syncRemove = () => $$('.pb-x', entries).forEach(b => (b.hidden = $$('.pb-row', entries).length < 2))

addEntry()
$('#pub-add').addEventListener('click', () => {
  const used = new Set($$('.pb-row', entries).map(r => r.dataset.net))
  addEntry(['evm', 'btc', 'sol', 'other'].find(k => !used.has(k)) || 'other')
  $$('.pb-row .pb-a', entries).at(-1).focus()
  renderPublish()
})
$('#pub-d').addEventListener('input', renderPublish)
$('#pub-ttl').addEventListener('change', renderPublish)

function renderPublish() {
  const out = $('#pub-out')
  const wasOpen = !!$('.pb-adv', out)?.open
  const rowEls = $$('.pb-row', entries)
  const seen = new Set()
  const list = []
  rowEls.forEach(row => {
    const s = rowState(row)
    if (!s.ok) return
    const k = s.code + '|' + (addressKind(s.address) === 'evm' ? s.address.toLowerCase() : s.address)
    if (seen.has(k)) { const h = $('.pb-hint', row); h.textContent = 'Already listed above.'; h.classList.add('err'); return }
    seen.add(k)
    list.push({ code: s.code, address: s.address })
  })
  const evm = list.some(e => addressKind(e.address) === 'evm')
  rowEls.forEach(r => { // Bitcoin and Solana rows only nag about an EVM address when there isn't one
    if (['btc', 'sol'].includes(r.dataset.net) && !r.classList.contains('bad') && !$('.pb-hint', r).classList.contains('err'))
      $('.pb-hint', r).textContent = evm ? 'Published for wallets that read DNS.' : NETWORKS[r.dataset.net].hint
  })
  let domain = null, domainErr = ''
  try { domain = $('#pub-d').value.trim() ? normalizeDomain($('#pub-d').value) : null } catch (err) { domainErr = err.message }
  if (domain && $('#v-publish').classList.contains('on')) history.replaceState(null, '', `#publish/${domain}`)
  const step3 = body => `<div class="pb-step"><div class="pb-head"><small>03</small><h3>Add it at your DNS host</h3>
    <p>A TXT record works on every DNS host, and it's the record escrow claims prove.</p></div>${body}</div>`
  if (!domain || !list.length) {
    out.innerHTML = step3(`<div class="pb-empty">${domainErr ? `${esc(domainErr)}. Fix it` : !domain ? 'Enter your domain' : 'Add a valid address'} and your record appears here.</div>`)
    return
  }
  const ttl = +$('#pub-ttl').value
  const ttlText = $('#pub-ttl').selectedOptions[0].textContent.replace('TTL ', '')
  let z
  try { z = zoneLines(domain, list, ttl) } catch (err) { out.innerHTML = step3(`<div class="note warn">${esc(err.message)}</div>`); return }
  // The DNS host's Name field is relative to the zone: _wallet for example.com, _wallet.shop for shop.example.com.
  const L = domain.split('.')
  const zoneLabels = /^(?:co|com|net|org|gov|edu|ac|or|ne|go)\.[a-z]{2}$/.test(L.slice(-2).join('.')) ? 3 : 2
  const sub = L.slice(0, -zoneLabels).join('.')
  const name = sub ? `_wallet.${sub}` : '_wallet'
  const cell = (value, label) => `<div class="pb-cell"><code>${esc(value)}</code><button class="pb-copy" type="button" data-copy="${esc(value)}" aria-label="Copy ${label}">Copy</button></div>`
  const rows = list.map(e => `
    <div class="pb-tr">
      <div class="pb-td" data-th="Type"><span class="pb-type">TXT</span></div>
      <div class="pb-td" data-th="Name">${cell(name, 'name')}</div>
      <div class="pb-td" data-th="Content">${cell(`${e.code} ${e.address}`, 'content')}</div>
      <div class="pb-td" data-th="TTL"><span class="pb-ttlv">${esc(ttlText)}</span></div>
    </div>`).join('')
  const block = (title, sub, lines) => `
    <div class="pb-block">
      <div class="pb-block-h"><div><b>${title}</b><span>${sub}</span></div><button class="pb-copy" type="button" data-copy="${esc(lines.join('\n'))}">Copy</button></div>
      <pre>${esc(lines.join('\n'))}</pre>
    </div>`
  out.innerHTML = step3(`
    <div class="pb-table" role="table" aria-label="DNS records to add">
      <div class="pb-tr pb-th" role="row"><div>Type</div><div>Name</div><div>Content</div><div>TTL</div></div>
      ${rows}
    </div>
    <p class="pb-fine">${list.length > 1 ? `Add ${list.length} TXT records, one per address, all named <code>${esc(name)}</code>. ` : ''}Some hosts want the full name: <code>_wallet.${esc(domain)}</code>.</p>
    ${evm ? '' : '<div class="note warn">No EVM address yet. Payments and escrow claims on TYPE/262 need one (Robinhood Chain).</div>'}
    <details class="pb-adv">
      <summary>Other formats: WALLET (type 262) and zone files</summary>
      ${block('WALLET record', 'for DNS software that knows type 262', z.named)}
      ${block('Generic TYPE262', 'RFC 3597: BIND, Knot, NSD, PowerDNS', z.generic)}
      ${block('TXT as a zone-file line', 'same record as above, for zone files', z.txt)}
    </details>`) + `
    <div class="pb-step">
      <div class="pb-head"><small>04</small><h3>Turn on DNSSEC</h3>
        <p>It signs your record, so wallets and agents can trust it and escrow can verify it on-chain. On Cloudflare: DNS, Settings, Enable DNSSEC. If your registrar is somewhere else, add the DS record Cloudflare shows you there.</p></div>
      <div class="pb-actions"><a class="btn primary" href="#resolve/${encodeURIComponent(domain)}">Check it's live</a><a class="btn" href="#escrow/${encodeURIComponent(domain)}">See what's waiting</a></div>
    </div>`
  if (wasOpen) $('.pb-adv', out).open = true
  $$('[data-copy]', out).forEach(b => b.addEventListener('click', () => copy(b.dataset.copy, b)))
}
renderPublish()

// ---------- verify ----------
$('[data-form=verify]').addEventListener('submit', async e => {
  e.preventDefault()
  const out = $('#verify-out')
  const target = e.target.u.value.trim()
  let addrs = e.target.a.value.trim() ? [e.target.a.value.trim()] : []
  if (e.target.j.value.trim()) {
    try { addrs = addrs.concat(payTosFromX402(e.target.j.value)) } catch { out.innerHTML = '<div class="note warn">That 402 body isn\'t valid JSON.</div>'; return }
  }
  if (!target || !addrs.length) { out.innerHTML = '<div class="note warn">Give a URL or domain, and a payTo address or 402 body.</div>'; return }
  out.innerHTML = '<div class="note">Checking DNS…</div>'
  try {
    const results = await Promise.all([...new Set(addrs)].map(a => verifyPayTo(target, a).then(v => ({ a, v }))))
    out.innerHTML = results.map(({ a, v }) => `
      <div class="result">
        <div class="r-empty" style="${v.strong ? 'background:var(--acid);color:var(--on-acid)' : v.ok ? '' : 'background:var(--hot);color:#fff'}">
          <strong>${v.strong ? 'Match. Safe to pay.' : v.ok ? 'Match, unsigned.' : 'No match. Don\'t pay.'}</strong>
          <span class="mono">${esc(short(a))} · ${esc(v.reason)} · checked ${esc(v.resolvedAt)}</span>
        </div>
      </div>`).join('')
  } catch (err) { out.innerHTML = `<div class="note warn">${esc(err.message)}</div>` }
})

// ---------- badge ----------
$('#badge-d').addEventListener('input', renderBadge)
function renderBadge() {
  const out = $('#badge-out')
  let d
  try { d = normalizeDomain($('#badge-d').value) } catch { out.innerHTML = ''; return }
  const url = new URL(`app.html#pay/${d}`, location.href).href
  const html = `<a href="${url}" style="display:inline-flex;align-items:center;gap:0.625rem;padding:0.75rem 1rem;background:#0b0b0b;color:#ecebe6;font:600 0.75rem/1 ui-monospace,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;text-decoration:none"><i style="width:0.625rem;height:0.625rem;background:#d4ff26"></i>Pay ${d} via DNS</a>`
  out.innerHTML = `
    <div><span class="label lbl">Preview</span><div class="note" style="padding:1.75rem">${html}</div></div>
    <div class="pb-block"><div class="pb-block-h"><div><b>HTML</b><span>Paste it anywhere on your site</span></div><button class="pb-copy" type="button" data-copy="${esc(html)}">Copy</button></div><pre>${esc(html)}</pre></div>
    <div class="pb-block"><div class="pb-block-h"><div><b>Pay link</b><span>Share it, or link a button to it</span></div><button class="pb-copy" type="button" data-copy="${esc(url)}">Copy</button></div><pre>${esc(url)}</pre></div>`
  $$('[data-copy]', out).forEach(b => b.addEventListener('click', () => copy(b.dataset.copy, b)))
}

// ---------- launch: pons v2 tokens whose creator fees go to a domain ----------
const PONS = {
  factory: '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e',
  feeEscrow: '0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e',
  page: token => `https://ponsfamily.com/launchpad/${token}`,
}
// Each curve starts with a phantom (virtual) quote reserve, from the pons factory: launch config 0 for ETH,
// pairTokenEconomics for USDG. Raised = quote reserve - phantom; the curve graduates when raised reaches its
// graduationThreshold (both checked against mainnet in contracts/test/Simulation.t.sol).
const PAIRS = {
  eth: { key: 'eth', address: ZERO, symbol: 'ETH', decimals: 18, phantom: 1680000000000000000n, graduates: '4.20 ETH' },
  usdg: { key: 'usdg', address: CHAIN.stable.address, symbol: 'USDG', decimals: 6, phantom: 3236000000n, graduates: '8,090 USDG' },
}
const pairOf = a => (sameAddress(a, ZERO) ? PAIRS.eth : sameAddress(a, CHAIN.stable.address) ? PAIRS.usdg : null)
const SUPPLY = 10n ** 27n
const SLIPPAGE_BPS = 500n
const TOKEN_PARAMS = ['string', 'string', 'string', 'string', ['string', 'string', 'string', 'string', 'string'], 'address', 'uint16', 'bool', 'bytes32', 'bytes32']
const LAUNCHED_TOPIC = '0x244b265c87c7bcb9c0ee96f2730234bdaf807cb2846c214a9334b6b71911feab' // DomainTokenLaunched
const U = h => (h && h.length >= 66 ? toBig(words(h)[0]) : 0n)
const hex = v => '0x' + BigInt(v).toString(16)

/** Many eth_calls in one JSON-RPC batch. A reverted call comes back as null. */
async function batch(calls) {
  const out = []
  for (let i = 0; i < calls.length; i += 40) {
    const chunk = calls.slice(i, i + 40)
    const arr = [].concat(await rpcPost(chunk.map((c, id) => ({ jsonrpc: '2.0', id, method: c.method || 'eth_call', params: c.params || [{ to: c.to, data: c.data }, 'latest'] }))))
    const byId = new Map(arr.map(r => [r.id, r]))
    chunk.forEach((_, id) => { const r = byId.get(id); out.push(!r || r.error ? null : r.result) })
  }
  return out
}
const launcherCall = data => rpc('eth_call', [{ to: LAUNCHER_ADDRESS, data }, 'latest'])

function money(v, pair) {
  const n = Number(v) / 10 ** pair.decimals
  const s = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: n && n < 1 ? 4 : 2 }).format(n)
  return pair.symbol === 'USDG' ? `$${s}` : `${s} ${pair.symbol}`
}
const tokensFmt = v => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 }).format(Number(v) / 1e18)
function ago(ts) {
  const s = Date.now() / 1000 - ts
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`
}
const IPFS = ['https://ipfs.filebase.io/ipfs/', 'https://gateway.pinata.cloud/ipfs/']
const cidPath = u => u.slice(7).replace(/^ipfs\//, '')
const imgUrl = (u, gateway = 0) => {
  u = String(u || '').trim()
  if (u.startsWith('ipfs://')) return /^[A-Za-z0-9/._-]+$/.test(cidPath(u)) ? IPFS[gateway] + cidPath(u) : ''
  return /^https:\/\/[^\s"'<>]+$/.test(u) ? u : ''
}
// On a failed load, try the second IPFS gateway once, then fall back to the emblem.
const logoTag = (u, big) => {
  const src = imgUrl(u), alt = String(u || '').trim().startsWith('ipfs://') ? imgUrl(u, 1) : ''
  return `<img class="ln-logo${big ? ' big' : ''}" alt=""${src ? ` src="${esc(src)}"` : ''}${alt ? ` data-alt="${esc(alt)}"` : ''} loading="${big ? 'eager' : 'lazy'}" onerror="if(this.dataset.alt){this.src=this.dataset.alt;this.removeAttribute('data-alt')}else this.removeAttribute('src')">`
}

/** Live curve numbers (+ name/symbol/logo, cached) for a list of {token, curve, pairToken}. */
const meta = new Map()
async function hydrate(list) {
  const calls = []
  for (const l of list) {
    calls.push({ to: l.curve, data: SEL.getReserves }, { to: l.curve, data: SEL.graduated }, { to: l.curve, data: SEL.graduationThreshold })
    if (!meta.has(l.token)) calls.push({ to: l.token, data: SEL.name }, { to: l.token, data: SEL.symbol }, { to: l.token, data: SEL.logo })
  }
  const r = await batch(calls)
  let k = 0
  return list.map(l => {
    const [res, grad, thr] = [r[k++], r[k++], r[k++]]
    if (!meta.has(l.token)) meta.set(l.token, { name: decodeString(r[k++] || ''), symbol: decodeString(r[k++] || ''), logo: decodeString(r[k++] || '') })
    const w = words(res || '')
    return { ...l, ...meta.get(l.token), quoteRes: w[0] ? toBig(w[0]) : 0n, tokenRes: w[1] ? toBig(w[1]) : 0n, graduated: U(grad) === 1n, threshold: U(thr) }
  })
}

function stats(t) {
  const pair = pairOf(t.pairToken) || { key: '', symbol: '?', decimals: 18, phantom: (t.threshold * 2n) / 5n }
  const raised = t.quoteRes > pair.phantom ? t.quoteRes - pair.phantom : 0n
  const progress = t.graduated ? 1 : t.threshold ? Math.min(1, Number((raised * 10000n) / t.threshold) / 10000) : 0
  const mcap = !t.graduated && t.tokenRes ? (t.quoteRes * SUPPLY) / t.tokenRes : null
  return { pair, raised, progress, mcap }
}

function card(t, i = 0) {
  const s = stats(t)
  return `<a class="ln-card" href="#launch/${t.token}" style="animation-delay:${Math.min(i, 12) * 40}ms">
    <div class="ln-id">${logoTag(t.logo)}<div><strong>${esc(t.name || 'Unnamed')}</strong><span>$${esc(t.symbol || '?')} · ${s.pair.symbol}${t.launchedAt ? ` · ${ago(t.launchedAt)}` : ''}</span></div></div>
    <div class="ln-to"><span>Fees to</span><b>${esc(t.domain || '')}</b></div>
    <div class="ln-stats"><div><span class="label">Market cap</span><div class="v">${s.mcap != null ? money(s.mcap, s.pair) : 'On Uniswap'}</div></div>
      <span class="tag${t.graduated ? ' good' : ''}">${t.graduated ? 'Graduated' : `${Math.floor(s.progress * 100)}% to graduation`}</span></div>
    <div class="bar"><i style="width:${(s.progress * 100).toFixed(1)}%"></i></div>
  </a>`
}

// ---------- launch: routing + board ----------
const lnForm = $('[data-form=ln-create]')
const fld = n => lnForm.elements[n]
const board = { sort: 'new', pair: 'any', domain: '', items: [], loaded: false, seq: 0 }

if (!LAUNCHER_ADDRESS) {
  $('#ln-cfg').innerHTML = '<div class="note warn" style="margin-bottom:1.5rem">The launcher contract is not deployed yet. See DEPLOY.md, then run scripts/post-deploy.mjs.</div>'
}

function showLaunch(arg) {
  if (arg.startsWith('new/')) {
    let d = ''
    try { d = normalizeDomain(arg.slice(4)) } catch {}
    if (d) { fld('domain').value = d; onDomain() }
    arg = 'new'
  }
  const sub = arg === 'new' ? 'new' : /^0x[0-9a-fA-F]{40}$/.test(arg) ? 'token' : 'board'
  $$('.ln-pane').forEach(p => p.classList.toggle('on', p.id === `ln-${sub}`))
  $$('.ln-switch a').forEach(a => a.classList.toggle('on', a.dataset.lv === sub))
  $('.ln-switch a[data-lv=board]').href = board.domain ? `#launch/${board.domain}` : '#launch'
  if (sub === 'token') return showToken(arg)
  if (sub === 'new') {
    warmUpload()
    if (lastDomain && !fld('domain').value) { fld('domain').value = lastDomain; onDomain() }
    return renderCreate()
  }
  let d = ''
  try { d = arg ? normalizeDomain(arg) : '' } catch {}
  if (!board.loaded || d !== board.domain) { board.domain = d; $('[data-form=ln-find]').elements.d.value = d; loadBoard() }
}

async function loadBoard() {
  board.loaded = true
  const seq = ++board.seq
  const grid = $('#ln-grid')
  $('#ln-fees').innerHTML = ''
  if (!LAUNCHER_ADDRESS) { grid.innerHTML = ''; return }
  grid.innerHTML = '<div class="ln-empty"><span class="spin"></span><span>Reading launches from Robinhood Chain…</span></div>'
  try {
    const raw = board.domain
      ? await launcherCall(encodeCall(SEL.launchesOf, ['string', 'uint256', 'uint256'], [board.domain, 0, 60]))
      : await launcherCall(encodeCall(SEL.recent, ['uint256', 'uint256'], [0, 60]))
    const items = await hydrate(decodeLaunches(raw))
    if (seq !== board.seq) return
    board.items = items
    renderBoard()
    $('.ln-switch a[data-lv=board]').href = board.domain ? `#launch/${board.domain}` : '#launch'
    if (board.domain) renderFees($('#ln-fees'), board.domain, board.items.filter(t => !t.graduated).map(t => t.curve))
  } catch (err) { if (seq === board.seq) grid.innerHTML = `<div class="ln-empty">${esc(err.message)}</div>` }
}

function renderBoard() {
  let list = board.items.filter(t => board.pair === 'any' || stats(t).pair.key === board.pair)
  if (board.sort === 'new') list.sort((a, b) => b.launchedAt - a.launchedAt)
  if (board.sort === 'near') list = list.filter(t => !t.graduated).sort((a, b) => stats(b).progress - stats(a).progress)
  if (board.sort === 'grad') list = list.filter(t => t.graduated)
  const none = board.domain
    ? `<strong>No launches for ${esc(board.domain)} yet.</strong><span>Launch one and every trade pays this domain.</span>`
    : '<strong>Nothing here yet.</strong><span>Launch the first token whose fees go to a domain.</span>'
  $('#ln-grid').innerHTML = list.length
    ? list.map(card).join('')
    : `<div class="ln-empty">${none}<a class="btn primary sm" href="#launch/new">Launch a token</a></div>`
}

$$('#v-launch [data-group]').forEach(g => g.addEventListener('click', e => {
  const b = e.target.closest('button[data-val]')
  if (!b) return
  $$('button', g).forEach(x => x.classList.toggle('on', x === b))
  const key = g.dataset.group
  if (key === 'sort' || key === 'pair') { board[key] = b.dataset.val; renderBoard() }
  if (key === 'newpair') renderCreate()
}))

$('[data-form=ln-find]').addEventListener('submit', e => {
  e.preventDefault()
  const v = e.target.elements.d.value.trim()
  let d = ''
  try { d = v ? normalizeDomain(v) : '' } catch (err) { toast(err.message); return }
  location.hash = d ? `#launch/${d}` : '#launch'
  if (d === board.domain) loadBoard()
})

/** "Fees for <domain>": what pons holds for it, what's in escrow, and a button that moves it all along. */
async function renderFees(el, domain, curves) {
  if (!ESCROW_ADDRESS) { el.innerHTML = ''; return }
  try {
    const fwd = toAddr(words(await launcherCall(encodeCall(SEL.forwarderOf, ['string'], [domain])))[0])
    const usdg = CHAIN.stable.address
    const [atPonsEth, atPonsUsdg, escEth, escUsdg, paused] = (await batch([
      { to: PONS.feeEscrow, data: encodeCall(SEL.ponsOwed, ['address'], [fwd]) },
      { to: PONS.feeEscrow, data: encodeCall(SEL.ponsOwedToken, ['address', 'address'], [fwd, usdg]) },
      { to: ESCROW_ADDRESS, data: encodeCall(SEL.balanceOf, ['string', 'address'], [domain, ZERO]) },
      { to: ESCROW_ADDRESS, data: encodeCall(SEL.balanceOf, ['string', 'address'], [domain, usdg]) },
      { to: ESCROW_ADDRESS, data: SEL.depositsPaused },
    ])).map(U)
    el.innerHTML = `
      <div class="ln-box ln-feebox">
        <div class="ln-feehead"><h4>Fees for <span class="accent">${esc(domain)}</span></h4>
          <a class="mono dim" href="${CHAIN.explorer}/address/${fwd}" target="_blank" rel="noopener">Fee address ${esc(short(fwd))} ↗</a></div>
        <div class="ln-feegrid">
          <div><span class="label">Waiting at pons</span><div class="v">${fmtUnits(atPonsEth, 18)} <small>ETH</small></div><div class="v">${fmtUnits(atPonsUsdg, 6)} <small>USDG</small></div></div>
          <div><span class="label">In escrow, ready to claim</span><div class="v">${fmtUnits(escEth, 18)} <small>ETH</small></div><div class="v">${fmtUnits(escUsdg, 6)} <small>USDG</small></div></div>
        </div>
        <p class="ln-est">Collect also sweeps fees still sitting on the bonding curves. Anyone can run it; Collect only ever sends to ${esc(domain)}'s escrow.</p>
        <div class="ln-actions">
          <button class="btn primary sm" type="button" data-collect ${paused !== 1n && (curves.length || atPonsEth || atPonsUsdg) ? '' : 'disabled'}>Collect to escrow</button>
          <a class="btn sm" href="#escrow/${encodeURIComponent(domain)}">Claim in Escrow</a>
        </div>
        ${paused === 1n ? '<div class="note warn">Escrow deposits are paused, so fees can\'t be collected right now. They stay safe at pons.</div>' : ''}
        <div data-status></div>
      </div>`
    $('[data-collect]', el).addEventListener('click', async e => {
      const st = $('[data-status]', el)
      e.currentTarget.disabled = true
      st.innerHTML = '<div class="note">Collecting…</div>'
      try {
        await sendTx({ to: LAUNCHER_ADDRESS, data: encodeCall(SEL.collect, ['string', 'address[]', 'address[]'], [domain, curves, [usdg]]) })
      } catch (err) { st.innerHTML = `<div class="note warn">${esc(err.message || 'Cancelled')}</div>`; e.currentTarget.disabled = false; return }
      toast(`Fees moved to escrow for ${domain}`)
      renderFees(el, domain, curves)
    })
  } catch (err) { el.innerHTML = `<div class="note warn">${esc(err.message)}</div>` }
}

// ---------- launch: token page ----------
let tokenView = null
async function showToken(addr) {
  const el = $('#ln-token')
  if (!tokenView || !sameAddress(tokenView.token, addr)) el.innerHTML = '<div class="ln-empty"><span class="spin"></span><span>Reading the curve…</span></div>'
  try {
    const lt = words(await rpc('eth_call', [{ to: PONS.factory, data: encodeCall('0x3cf28b5a', ['address'], [addr]) }, 'latest']))
    const curve = toAddr(lt[1]), feeTo = toAddr(lt[3]), pairToken = toAddr(lt[4])
    if (sameAddress(curve, ZERO)) throw new Error('Not a pons v2 token.')
    const [rec, [fee, tax, desc]] = await Promise.all([
      LAUNCHER_ADDRESS ? launcherCall(encodeCall(SEL.launchOf, ['address'], [addr])).then(decodeLaunch) : null,
      batch([{ to: curve, data: SEL.feeBps }, { to: curve, data: SEL.creatorTaxBps }, { to: addr, data: SEL.description }]),
    ])
    // Launched through DomainLauncher: pons pays that domain's forwarder, whatever else the token says.
    const domain = rec && sameAddress(rec.token, addr) ? rec.domain : ''
    const [t] = await hydrate([{ token: addr, curve, pairToken, domain, launchedAt: domain ? rec.launchedAt : 0 }])
    Object.assign(t, { feeTo, feeBps: Number(U(fee)), taxBps: Number(U(tax)), description: decodeString(desc || '') })
    if (domain) {
      // pons's owner can move any token's fee recipient behind a 3-day timelock: say so if it has, or will
      const [fwd, pending] = await batch([
        { to: LAUNCHER_ADDRESS, data: encodeCall(SEL.forwarderOf, ['string'], [domain]) },
        { to: PONS.factory, data: encodeCall(SEL.pendingFeeRecipient, ['address'], [addr]) },
      ])
      const pendingTo = pending ? toAddr(words(pending)[0] || '0'.repeat(64)) : ZERO
      t.feeWarning = fwd && !sameAddress(toAddr(words(fwd)[0]), feeTo)
        ? `pons has moved this token's creator fees to ${short(feeTo)}. They no longer reach ${domain}.`
        : !sameAddress(pendingTo, ZERO) ? `pons has proposed moving this token's creator fees to ${short(pendingTo)}.` : ''
    }
    if (!location.hash.toLowerCase().endsWith(addr.toLowerCase())) return // the user moved on
    tokenView = t
    renderToken(t)
  } catch (err) { if (!location.hash.toLowerCase().endsWith(addr.toLowerCase())) return; el.innerHTML = `<div class="ln-empty"><strong>Couldn't load this token.</strong><span class="mono">${esc(err.message)}</span><a class="btn sm" href="#launch">Back to the board</a></div>` }
}

function renderToken(t) {
  const s = stats(t)
  const el = $('#ln-token')
  el.innerHTML = `
    <a class="ln-back" href="#launch${board.domain ? `/${esc(board.domain)}` : ''}">← Board</a>
    <div class="ln-head">${logoTag(t.logo, true)}
      <div><h3>${esc(t.name || 'Unnamed')}</h3>
        <div class="tags"><span class="tag">$${esc(t.symbol)}</span><span class="tag">${s.pair.symbol} pair</span>
          ${t.graduated ? '<span class="tag good">Graduated</span>' : '<span class="tag">Bonding curve</span>'}
          ${t.domain ? `<a class="tag good" href="#launch/${esc(t.domain)}">Fees → ${esc(t.domain)}</a>` : `<span class="tag bad">Fees → ${esc(short(t.feeTo))}, not a domain</span>`}</div></div>
      <div class="tags links"><a class="btn sm" href="${PONS.page(t.token)}" target="_blank" rel="noopener">pons ↗</a><a class="btn sm" href="${CHAIN.explorer}/token/${t.token}" target="_blank" rel="noopener">Blockscout ↗</a></div>
    </div>
    ${t.feeWarning ? `<div class="note warn" style="margin-bottom:1rem">${esc(t.feeWarning)}</div>` : ''}
    ${t.description ? `<p class="body ln-desc">${esc(t.description)}</p>` : ''}
    <div class="ln-kpis">
      <div><span class="label">Market cap</span><span class="v">${s.mcap != null ? money(s.mcap, s.pair) : 'On Uniswap'}</span></div>
      <div><span class="label">Raised</span><span class="v">${t.graduated ? '—' : money(s.raised, s.pair)}</span></div>
      <div><span class="label">Graduates at</span><span class="v">${money(t.threshold, s.pair)}</span></div>
      <div><span class="label">Creator fee</span><span class="v">${t.taxBps / 100}%</span></div>
    </div>
    <div class="bar lg"><i style="width:${(s.progress * 100).toFixed(1)}%"></i></div>
    <div class="ln-two">
      <div class="ln-box" id="ln-trade"></div>
      <div id="ln-tfees"></div>
    </div>
    <p class="ln-est mono">Token ${esc(t.token)} · <button class="linkish" type="button" data-copy="${t.token}">Copy</button></p>`
  $('[data-copy]', el).addEventListener('click', e => copy(t.token, e.target))
  renderTrade(t, s)
  if (t.domain) renderFees($('#ln-tfees'), t.domain, t.graduated ? [] : [t.curve])
}

function renderTrade(t, s) {
  const box = $('#ln-trade')
  if (t.graduated) {
    box.innerHTML = `<h4>Graduated</h4><p class="ln-est">This curve filled and its liquidity moved to Uniswap v4. Trade it on pons. Creator fees keep flowing to ${esc(t.domain || 'the fee address')}.</p>
      <a class="btn primary sm" href="${PONS.page(t.token)}" target="_blank" rel="noopener">Trade on pons ↗</a>`
    return
  }
  let side = 'buy'
  box.innerHTML = `
    <div class="seg block" data-side><button type="button" data-val="buy" class="on">Buy</button><button type="button" data-val="sell">Sell</button></div>
    <div class="field sm"><input id="ln-amt" inputmode="decimal" placeholder="0.0" aria-label="Amount"><span class="pre unit" id="ln-unit"></span></div>
    <div class="ln-est" id="ln-quote">&nbsp;</div>
    <button class="btn primary" type="button" id="ln-go"></button>
    <div class="ln-est" id="ln-bal"></div>
    <div id="ln-tstat"></div>`
  const unit = () => (side === 'buy' ? s.pair.symbol : t.symbol)
  const dec = () => (side === 'buy' ? s.pair.decimals : 18)
  let snipe = 0n
  const refresh = () => {
    $('#ln-unit').textContent = unit()
    $('#ln-go').innerHTML = `${side === 'buy' ? 'Buy' : 'Sell'} $${esc(t.symbol)}`
    let amt = 0n
    try { amt = parseUnits($('#ln-amt').value.trim() || '0', dec()) } catch {}
    const out = amt ? quote(t, side, amt, snipe) : 0n
    $('#ln-quote').innerHTML = amt
      ? `≈ ${side === 'buy' ? `${tokensFmt(out)} $${esc(t.symbol)}` : `${fmtUnits(out, s.pair.decimals)} ${s.pair.symbol}`} · ${Number(SLIPPAGE_BPS) / 100}% max slippage${snipe ? ` · ${Number(snipe) / 100}% launch snipe tax` : ''}`
      : '&nbsp;'
    $('#ln-go').disabled = !amt
  }
  const balances = async () => {
    if (!account) { $('#ln-bal').textContent = 'Connect a wallet to trade.'; return }
    const [qb, tb, sn] = await batch([
      s.pair.key === 'eth' ? { method: 'eth_getBalance', params: [account, 'latest'] } : { to: s.pair.address, data: encodeCall(SEL.erc20Balance, ['address'], [account]) },
      { to: t.token, data: encodeCall(SEL.erc20Balance, ['address'], [account]) },
      { to: t.curve, data: encodeCall(SEL.snipeTaxBps, ['address'], [account]) },
    ])
    snipe = U(sn)
    const qBal = s.pair.key === 'eth' ? BigInt(qb || '0x0') : U(qb)
    $('#ln-bal').textContent = `You have ${fmtUnits(qBal, s.pair.decimals)} ${s.pair.symbol} · ${tokensFmt(U(tb))} $${t.symbol}`
    refresh()
  }
  $('[data-side]', box).addEventListener('click', e => {
    const b = e.target.closest('button[data-val]')
    if (!b) return
    side = b.dataset.val
    $$('[data-side] button', box).forEach(x => x.classList.toggle('on', x === b))
    $('#ln-amt').value = ''
    refresh()
  })
  $('#ln-amt').addEventListener('input', refresh)
  $('#ln-go').addEventListener('click', async () => {
    const st = $('#ln-tstat')
    if ($('#ln-go').dataset.busy) return
    $('#ln-go').dataset.busy = '1'
    $('#ln-go').disabled = true
    try {
      const amt = parseUnits($('#ln-amt').value.trim(), dec())
      const from = account || await connect()
      // Re-read the curve right before sending, so slippage protection is measured from the current price.
      const [res, sn] = await batch([{ to: t.curve, data: SEL.getReserves }, { to: t.curve, data: encodeCall(SEL.snipeTaxBps, ['address'], [from]) }])
      const w = words(res || '')
      if (!w[1] || toBig(w[1]) === 0n) throw new Error('Could not read the curve. Try again.')
      const out = quote({ ...t, quoteRes: toBig(w[0]), tokenRes: toBig(w[1]) }, side, amt, U(sn))
      if (out === 0n) throw new Error('Amount too small.')
      const minOut = (out * (10000n - SLIPPAGE_BPS)) / 10000n
      st.innerHTML = `<div class="note">${side === 'buy' ? 'Buying' : 'Selling'}…</div>`
      if (side === 'buy') {
        if (s.pair.key === 'eth') await sendTx({ to: t.curve, value: hex(amt), data: encodeCall(SEL.buy, ['uint256', 'uint256', 'address'], [amt, minOut, from]) })
        else {
          await ensureAllowance(s.pair.address, t.curve, amt, from)
          await sendTx({ to: t.curve, data: encodeCall(SEL.buy, ['uint256', 'uint256', 'address'], [amt, minOut, from]) })
        }
      } else {
        await ensureAllowance(t.token, t.curve, amt, from)
        await sendTx({ to: t.curve, data: encodeCall(SEL.sell, ['uint256', 'uint256', 'address'], [amt, minOut, from]) })
      }
      toast(`${side === 'buy' ? 'Bought' : 'Sold'} $${t.symbol}`)
      await showToken(t.token)
    } catch (err) {
      st.innerHTML = `<div class="note warn">${esc(err.message || 'Cancelled')}</div>`
      delete $('#ln-go').dataset.busy
      refresh()
    }
  })
  refresh()
  balances().catch(() => {})
}

/** Constant product on the curve's reserves after the curve fee, creator tax and any snipe tax (same as the curve). */
function quote(t, side, amount, snipe = 0n) {
  const keep = 10000n - BigInt(t.feeBps + t.taxBps)
  if (side === 'buy') {
    const inAfter = (amount * (keep - snipe)) / 10000n
    return (t.tokenRes * inAfter) / (t.quoteRes + inAfter)
  }
  return (((t.quoteRes * amount) / (t.tokenRes + amount)) * keep) / 10000n
}

async function ensureAllowance(token, spender, amount, from) {
  const have = U(await rpc('eth_call', [{ to: token, data: encodeCall(SEL.allowance, ['address', 'address'], [from, spender]) }, 'latest']))
  if (have < amount) await sendTx({ to: token, data: encodeCall(SEL.approve, ['address', 'uint256'], [spender, amount]) })
}

// ---------- launch: image upload ----------
// "Choose image" pins the file to IPFS through our small upload service (upload/server.mjs on Render) and
// puts the ipfs:// link in the form's logo field. The free instance sleeps, so the form wakes it on open.
const UPLOAD_URL = config.UPLOAD_URL || 'https://type262-upload.onrender.com'
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp']
let uploading = false
let warmed = false
const warmUpload = () => { if (!warmed) { warmed = true; fetch(`${UPLOAD_URL}/health`).catch(() => {}) } }

async function uploadImage(file) {
  const stat = $('#ln-upstat')
  const fail = msg => { stat.textContent = msg; stat.classList.add('err') }
  stat.classList.remove('err', 'ok')
  if (!IMAGE_TYPES.includes(file.type)) return fail('Use a PNG, JPEG or WebP image.')
  if (!file.size || file.size > 5 * 1024 * 1024) return fail('Images must be 5 MB or smaller.')
  const local = URL.createObjectURL(file)
  $('#ln-thumb').style.backgroundImage = `url("${local}")`
  uploading = true
  renderCreate()
  stat.textContent = 'Uploading to IPFS…'
  const slow = setTimeout(() => { if (uploading) stat.textContent = 'Uploading… the upload server is waking up, this takes a few seconds.' }, 4000)
  try {
    const form = new FormData()
    form.append('image', file)
    const res = await fetch(`${UPLOAD_URL}/image`, { method: 'POST', body: form, signal: AbortSignal.timeout(90_000) })
    const j = await res.json().catch(() => ({}))
    if (!res.ok || typeof j.uri !== 'string' || !/^ipfs:\/\/[A-Za-z0-9]+$/.test(j.uri)) throw new Error(j.error || 'The upload did not complete.')
    fld('logo').value = j.uri
    stat.textContent = '✓ Uploaded to IPFS.'
    stat.classList.add('ok')
  } catch (err) {
    fld('logo').value = ''
    $('#ln-thumb').style.backgroundImage = ''
    fail(err.name === 'TimeoutError' ? 'The upload timed out. Try again.' : err.message || 'The upload did not complete.')
  } finally {
    clearTimeout(slow)
    uploading = false
    URL.revokeObjectURL(local)
    renderCreate()
  }
}
const pickFile = () => $('#ln-file').click()
$('#ln-choose').addEventListener('click', pickFile)
$('#ln-thumb').addEventListener('click', pickFile)
$('#ln-file').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) uploadImage(f) })
const drop = $('#ln-drop')
;['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over') }))
;['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over') }))
drop.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) uploadImage(f) })

// ---------- launch: create ----------
const newPair = () => PAIRS[$('[data-group=newpair] .on').dataset.val]
let launchFee = null
const getLaunchFee = async () => (launchFee ??= U(await rpc('eth_call', [{ to: PONS.factory, data: SEL.launchFee }, 'latest'])))

function renderCreate() {
  const pair = newPair()
  const v = n => fld(n).value.trim()
  for (const n of ['name', 'symbol', 'description']) $(`[data-count=${n}]`).textContent = `${v(n).length}/${fld(n).maxLength}`
  const tax = Number(fld('tax').value)
  $('#ln-tax-v').textContent = `${tax / 100}%`
  $('#ln-open').hidden = pair.key !== 'eth'
  const u = imgUrl(v('logo'))
  if (!uploading) $('#ln-thumb').style.backgroundImage = u ? `url("${u.replace(/"/g, '%22')}")` : ''
  let domain = ''
  try { domain = v('domain') ? normalizeDomain(v('domain')) : '' } catch {}
  fld('website').placeholder = `https://${domain || 'yoursite.com'}`
  const preview = { token: ZERO, name: v('name') || 'Your token', symbol: (v('symbol') || 'TICKER').toUpperCase(), logo: v('logo'), domain: domain || 'yoursite.com', pairToken: pair.address, quoteRes: pair.phantom, tokenRes: SUPPLY, threshold: pair.phantom * 5n / 2n, graduated: false, launchedAt: 0 }
  $('#ln-preview').innerHTML = card(preview).replace('<a class="ln-card"', '<div class="ln-card preview"').replace(/<\/a>\s*$/, '</div>') +
    `<p class="ln-est">${esc(v('description') || 'A line or two about the token goes here.')}</p>`
  $('#ln-facts').innerHTML = [
    ['Supply', '1,000,000,000'], ['Graduates at', pair.graduates],
    ['Creator fee', `${tax / 100}% → ${esc(domain || 'domain')}`], ['Launch fee', launchFee != null ? `${fmtUnits(launchFee, 18)} ETH` : '…'],
  ].map(([a, b]) => `<div><dt>${a}</dt><dd>${b}</dd></div>`).join('')
  let buy = 0n
  try { buy = pair.key === 'eth' && v('buy') ? parseUnits(v('buy'), 18) : 0n } catch {}
  $('#ln-total').innerHTML = launchFee != null ? `You pay <b>${fmtUnits(launchFee + buy, 18)} ETH</b>${buy ? ` (launch fee + ${fmtUnits(buy, 18)} ETH opening buy)` : ' (launch fee)'}` : ''
  $('#ln-submit').innerHTML = `Launch $${esc((v('symbol') || 'TICKER').toUpperCase())}`
  $('#ln-submit').disabled = !LAUNCHER_ADDRESS || launching || uploading
}
let launching = false
getLaunchFee().then(renderCreate).catch(() => {})
lnForm.addEventListener('input', e => {
  if (e.target.name === 'symbol') e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (e.target.name === 'domain') onDomain()
  renderCreate()
})

let domainTimer
function onDomain() {
  clearTimeout(domainTimer)
  const hint = $('#ln-dest')
  let d
  try { d = normalizeDomain(fld('domain').value) } catch { hint.textContent = ''; return }
  hint.textContent = `Checking ${d}…`
  domainTimer = setTimeout(async () => {
    const current = () => { try { return normalizeDomain(fld('domain').value) } catch { return '' } }
    try {
      const r = await resolveWallets(d)
      if (current() !== d) return
      const txt = r.records.find(x => x.source === 'TXT' && addressKind(x.address) === 'evm' && codeMatchesAddress(x.code, x.address))
      hint.innerHTML = txt && txt.dnssec
        ? `✓ ${esc(d)} publishes a signed <span class="mono">_wallet</span> record. Its owner can claim fees right away.`
        : `${esc(d)} can't claim yet: it needs a DNSSEC-signed <span class="mono">_wallet</span> TXT record (<a class="ul" href="#publish/${encodeURIComponent(d)}">Publish</a>). Fees wait safely in escrow until then.`
    } catch { if (current() === d) hint.textContent = `Fees wait in escrow until ${d} claims them.` }
  }, 450)
}

lnForm.addEventListener('submit', async e => {
  e.preventDefault()
  if (launching) return
  const st = $('#ln-status')
  const v = n => fld(n).value.trim()
  launching = true
  $('#ln-submit').disabled = true
  try {
    const domain = normalizeDomain(v('domain'))
    const name = v('name'), symbol = v('symbol').toUpperCase(), logo = v('logo')
    if (!name) throw new Error('Give the token a name.')
    if (!/^[A-Z0-9]{1,10}$/.test(symbol)) throw new Error('The ticker is 1–10 letters or digits.')
    if (logo && !imgUrl(logo)) throw new Error('The image must be an https:// or ipfs:// URL.')
    const pair = newPair()
    const tax = Number(v('tax'))
    const buy = pair.key === 'eth' && v('buy') ? parseUnits(v('buy'), 18) : 0n
    if (buy > 4n * 10n ** 18n) throw new Error('The opening buy can be at most 4 ETH: the curve graduates at 4.2 ETH.')
    const fee = await getLaunchFee()
    const econ = await rpc('eth_call', [{ to: PONS.factory, data: encodeCall(SEL.previewLaunchEconomics, ['uint256', 'address'], [0, pair.address]) }, 'latest'])
    const salt = '0x' + Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('')
    // Opening buy lands on a fresh curve: reserves are (phantom, supply); the creator is exempt from the snipe tax.
    const fresh = { quoteRes: pair.phantom, tokenRes: SUPPLY, feeBps: 100, taxBps: tax }
    const minOut = buy ? (quote(fresh, 'buy', buy) * (10000n - SLIPPAGE_BPS)) / 10000n : 0n
    const params = [name, symbol, logo, v('description'), [v('twitter'), v('telegram'), '', v('website') || `https://${domain}`, ''], ZERO, tax, false, econ, salt]
    st.innerHTML = `<div class="note">Launching $${esc(symbol)} on pons…</div>`
    const receipt = await sendTx({
      to: LAUNCHER_ADDRESS, value: hex(fee + buy),
      data: encodeCall(SEL.launch, ['string', TOKEN_PARAMS, 'uint256', 'address', 'uint256', 'uint256'], [domain, params, 0, pair.address, buy, minOut]),
    })
    const log = (receipt.logs || []).find(l => sameAddress(l.address, LAUNCHER_ADDRESS) && l.topics[0] === LAUNCHED_TOPIC)
    toast(`$${symbol} is live. Its creator fees go to ${domain}.`)
    lnForm.reset()
    st.innerHTML = ''
    $('#ln-upstat').textContent = 'or drop it here. It\'s stored on IPFS, like on pons.'
    $('#ln-upstat').classList.remove('ok', 'err')
    $('#ln-dest').textContent = ''
    board.loaded = false
    location.hash = log ? `#launch/${toAddr(log.topics[2].slice(2))}` : `#launch/${domain}`
  } catch (err) { st.innerHTML = `<div class="note warn">${esc(err.message || 'Cancelled')}</div>` } finally {
    launching = false
    renderCreate()
  }
})

Promise.race([restored, pause(1500)]).finally(route)
