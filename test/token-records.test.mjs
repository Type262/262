// Offline tests for official token records: _token TXT parsing, token links, resolveTokens and verifyToken against
// mocked DoH, the CLI's token command, and the app's helpers (assets/token-records.js). Run: node test/token-records.test.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as w from '../lib/wallet262.js'

globalThis.matchMedia ??= () => ({ matches: false }) // assets/ui.js reads it on import
const app = await import('../assets/token-records.js')

const MINT = 'BjVsSDQoNbxswtPLtpAr5QXZTEXQsfEQTAz7A7iipump' // a pump.fun mint
const MINT2 = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin'
const CONTRACT = '0x7a1fe1c2b0d3a4f5e6d7c8b9a0f1e2d3c4b5c0de'
const WALLET = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'

// Mock DoH for both default resolvers (side a: cloudflare, side b: google). zone[domain] = { txt: [strings] } (both
// answer at _token.<domain>), { a, b } (they answer differently), {} (exists, no record). Also nx: 'all' or 'b' (the
// domain is NXDOMAIN there), tokenNx (_token.<domain> answers NXDOMAIN when empty, as most DNS hosts do), unsigned:
// 'all' or 'b' (AD false), fail: 'b' (HTTP 500). Names not in the zone are NXDOMAIN. Side a quotes TXT data and writes
// owner names as asked; side b leaves TXT data bare and writes owner names in upper case with a trailing dot.
// Self-contained, so the CLI test can load it into a child process.
const tokenFetch = (zone, log = []) => async url => {
  const u = new URL(url)
  const name = u.searchParams.get('name'), type = u.searchParams.get('type')
  log.push(`${u.hostname} ${name} ${type}`)
  const side = u.hostname === 'dns.google' ? 'b' : 'a'
  const txt = name.startsWith('_token.')
  const z = zone[txt ? name.slice(7) : name]
  if (z && z.fail === side) return { ok: false, status: 500, json: async () => ({}) }
  const nx = !z || z.nx === 'all' || z.nx === side
  const strings = (z && (side in z ? z[side] : z.txt)) || []
  const body = { Status: nx || (txt && !strings.length && z.tokenNx) ? 3 : 0, AD: !(z && (z.unsigned === 'all' || z.unsigned === side)) }
  if (!nx && txt && type === '16' && strings.length) {
    body.Answer = strings.map(s => ({ name: side === 'b' ? name.toUpperCase() + '.' : name, type: 16, data: side === 'a' ? `"${s}"` : s }))
  }
  return { ok: true, json: async () => body }
}

const ZONE = {
  'shop.test': { txt: [`SOL ${MINT}`, `HOOD:${CONTRACT}`] },
  'empty.test': {},
  'blackout.test': { tokenNx: true },
  'unsigned.test': { txt: [`SOL ${MINT}`], unsigned: 'all' },
  'adsplit.test': { txt: [`SOL ${MINT}`], unsigned: 'b' },
  'split.test': { a: [`SOL ${MINT}`], b: [`SOL ${MINT2}`] },
  'down.test': { txt: [`SOL ${MINT}`], fail: 'b' },
  'nxsplit.test': { txt: [`SOL ${MINT}`], nx: 'b' },
  'junk.test': { txt: [`SOL ${CONTRACT}`, `BTC ${WALLET}`, 'google-site-verification=abc', `BASE ${CONTRACT}`] },
  'base.test': { txt: [`BASE ${CONTRACT}`] },
}
const fetch = tokenFetch(ZONE)

const tests = {
  'parseTokenTxt: one record per chain code, in every _wallet layout': () => {
    assert.deepEqual(w.parseTokenTxt(`"SOL ${MINT}"`), { code: 'SOL', address: MINT })
    assert.deepEqual(w.parseTokenTxt(`sol:${MINT}`), { code: 'SOL', address: MINT })
    assert.deepEqual(w.parseTokenTxt(`"HOOD" "${CONTRACT}"`), { code: 'HOOD', address: CONTRACT })
    assert.deepEqual(w.parseTokenTxt(`BASE ${CONTRACT}`), { code: 'BASE', address: CONTRACT })
    assert.deepEqual(w.parseTokenTxt(`"ETH ${CONTRACT}"`), { code: 'ETH', address: CONTRACT })
    assert.equal(w.TOKEN_LABEL, '_token')
    assert.deepEqual(Object.keys(w.TOKEN_CHAINS), ['SOL', 'HOOD', 'BASE', 'ETH'])
  },
  'parseTokenTxt: a code whose address kind differs, an unknown code or junk is rejected': () => {
    assert.throws(() => w.parseTokenTxt(`SOL ${CONTRACT}`), /SOL needs a Solana mint/)
    for (const c of ['HOOD', 'BASE', 'ETH']) assert.throws(() => w.parseTokenTxt(`${c} ${MINT}`), /needs a 0x contract/, c)
    assert.throws(() => w.parseTokenTxt(`BTC ${WALLET}`), /Unknown token chain BTC/)
    assert.throws(() => w.parseTokenTxt(`USDC ${CONTRACT}`), /Unknown token chain USDC/)
    assert.throws(() => w.parseTokenTxt('"google-site-verification=abc"'), /Unrecognized _token TXT format/)
    assert.throws(() => w.parseTokenTxt(`SOL ${MINT}x`), /Solana mint/) // 33 bytes: not a public key
  },
  'tokenAddress: bare mints and contracts, pump.fun and explorer links': () => {
    for (const s of [MINT, ` ${MINT} `, `pump.fun/coin/${MINT}`, `https://pump.fun/coin/${MINT}?include-nsfw=true`, `https://www.pump.fun/coin/${MINT}`,
      `https://pump.fun/${MINT}`, `solscan.io/token/${MINT}`, `https://solscan.io/token/${MINT}?cluster=mainnet#holders`]) {
      assert.equal(w.tokenAddress(s), MINT, s)
    }
    assert.equal(w.tokenAddress(CONTRACT), CONTRACT)
    assert.equal(w.tokenAddress(`https://basescan.org/token/${CONTRACT}`), CONTRACT)
    assert.equal(w.tokenAddress(`https://robinhoodchain.blockscout.com/token/${CONTRACT}?tab=holders`), CONTRACT)
    for (const s of ['', 'nonsense', 'https://pump.fun/', `https://solscan.io/account/${MINT}`, `https://pump.fun/profile/${MINT}x`, 'https://example.com/token/abc']) {
      assert.throws(() => w.tokenAddress(s), /Enter a token address|Not a token address/, s)
    }
  },
  'tokenRef: a mint is on Solana, a known explorer\'s link names its chain, a bare 0x names none': () => {
    const ref = s => { const r = w.tokenRef(s); return `${r.code} ${r.address}` }
    assert.equal(ref(MINT), `SOL ${MINT}`)
    assert.equal(ref(`https://pump.fun/coin/${MINT}`), `SOL ${MINT}`)
    assert.equal(ref(`solscan.io/token/${MINT}`), `SOL ${MINT}`)
    assert.equal(ref(`https://basescan.org/token/${CONTRACT}`), `BASE ${CONTRACT}`)
    assert.equal(ref(`https://www.etherscan.io/token/${CONTRACT}#balances`), `ETH ${CONTRACT}`)
    assert.equal(ref(`https://robinhoodchain.blockscout.com/token/${CONTRACT}?tab=holders`), `HOOD ${CONTRACT}`)
    assert.equal(ref(CONTRACT), `null ${CONTRACT}`)
    assert.equal(ref(`https://sepolia.etherscan.io/token/${CONTRACT}`), `null ${CONTRACT}`, 'another network of the explorer names no chain')
    assert.equal(ref(`https://explorer.example/token/${CONTRACT}`), `null ${CONTRACT}`)
    // a link whose site is on another chain than its address
    for (const s of [`https://solscan.io/token/${CONTRACT}`, `https://basescan.org/token/${MINT}`, `https://pump.fun/coin/${CONTRACT}`]) {
      assert.throws(() => w.tokenRef(s), /Not a token address or token link/, s)
    }
  },
  'resolveTokens: signed on both resolvers is verified; one query each at the domain and at _token': async () => {
    const log = []
    const r = await w.resolveTokens('https://Shop.test/coin', { fetch: tokenFetch(ZONE, log) })
    assert.equal(r.domain, 'shop.test')
    assert.deepEqual(r.records, [{ code: 'SOL', address: MINT, source: 'TXT', dnssec: true }, { code: 'HOOD', address: CONTRACT, source: 'TXT', dnssec: true }])
    assert.deepEqual([r.verified, r.agree, r.dnssec, r.nxdomain, r.invalid.length], [true, true, true, false, 0])
    assert.ok(r.resolvers.every(x => x.ok && x.status === 0 && x.signed && x.records.length === 2), 'side b: bare TXT data, upper-case owner')
    assert.deepEqual(log.sort(), ['cloudflare-dns.com _token.shop.test 16', 'cloudflare-dns.com shop.test 262', 'dns.google _token.shop.test 16', 'dns.google shop.test 262'])
  },
  'resolveTokens: unsigned, resolvers disagree, a resolver down, no records, NXDOMAIN': async () => {
    const unsigned = await w.resolveTokens('unsigned.test', { fetch })
    assert.deepEqual([unsigned.verified, unsigned.agree, unsigned.dnssec, unsigned.records.length, unsigned.records[0].dnssec], [false, true, false, 1, false])
    const ad = await w.resolveTokens('adsplit.test', { fetch })
    assert.deepEqual([ad.verified, ad.agree, ad.dnssec], [false, true, false])
    const split = await w.resolveTokens('split.test', { fetch })
    assert.deepEqual([split.verified, split.agree, split.records[0].address], [false, false, MINT])
    const down = await w.resolveTokens('down.test', { fetch })
    assert.deepEqual([down.verified, down.agree, down.records.length, down.resolvers[1].ok], [false, true, 1, false])
    for (const d of ['empty.test', 'blackout.test']) { // _token answers NOERROR (empty.test) or NXDOMAIN (blackout.test): the domain still exists
      const none = await w.resolveTokens(d, { fetch })
      assert.deepEqual([none.records.length, none.verified, none.nxdomain, none.agree, none.dnssec], [0, false, false, true, true], d)
    }
    const gone = await w.resolveTokens('gone.test', { fetch })
    assert.deepEqual([gone.records.length, gone.nxdomain, gone.verified], [0, true, false])
    assert.equal((await w.resolveTokens('nxsplit.test', { fetch })).nxdomain, true)
    await assert.rejects(w.resolveTokens('shop.test', { fetch: async () => ({ ok: false, status: 503 }) }), /cloudflare: HTTP 503; google: HTTP 503/)
  },
  'resolveTokens: records that fail the code and address rules go to invalid': async () => {
    const r = await w.resolveTokens('junk.test', { fetch })
    assert.deepEqual(r.records, [{ code: 'BASE', address: CONTRACT, source: 'TXT', dnssec: true }])
    assert.deepEqual(r.invalid.map(x => x.error), ['SOL needs a Solana mint address', 'Unknown token chain BTC: use SOL, HOOD, BASE, ETH', 'Unrecognized _token TXT format'])
  },
  'resolveWallets keeps its queries and result through the shared lookup': async () => {
    const log = []
    const r = await w.resolveWallets('shop.test', { fetch: tokenFetch(ZONE, log) })
    assert.deepEqual(log.sort(), ['cloudflare-dns.com _wallet.shop.test 16', 'cloudflare-dns.com shop.test 262', 'dns.google _wallet.shop.test 16', 'dns.google shop.test 262'])
    assert.deepEqual([r.records.length, r.verified, r.agree, r.dnssec, r.nxdomain], [0, false, true, true, false])
    const only = []
    await w.resolveWallets('shop.test', { fetch: tokenFetch(ZONE, only), txtFallback: false })
    assert.deepEqual(only.sort(), ['cloudflare-dns.com shop.test 262', 'dns.google shop.test 262'])
  },
  'verifyToken: the first reason that applies wins': async () => {
    // code: the matching record's chain, else the one the token names (SOL for a mint), else null (a bare 0x)
    const cases = [
      ['gone.test', MINT, 'Domain does not exist', false, false, 'SOL'],
      ['nxsplit.test', MINT, 'Domain does not exist', false, false, 'SOL'], // one resolver has the record: the match, not listed
      ['empty.test', MINT, 'Domain publishes no token record', false, false, 'SOL'],
      ['blackout.test', MINT, 'Domain publishes no token record', false, false, 'SOL'],
      ['empty.test', CONTRACT, 'Domain publishes no token record', false, false, null],
      ['shop.test', MINT2, 'Token is not listed by this domain', false, false, 'SOL'],
      ['split.test', MINT, 'Resolvers disagree. Possible tampering', false, false, 'SOL'],
      ['split.test', MINT2, 'Resolvers disagree. Possible tampering', false, false, 'SOL'],
      ['unsigned.test', MINT, 'Listed, but the zone is not DNSSEC-signed', true, false, 'SOL'],
      ['down.test', MINT, 'Listed, but not every resolver answered', true, false, 'SOL'],
      ['adsplit.test', MINT, 'Listed, but not DNSSEC-signed on every resolver', true, false, 'SOL'],
      ['shop.test', `https://pump.fun/coin/${MINT}`, 'Listed, DNSSEC-verified', true, true, 'SOL'],
      ['shop.test', CONTRACT.toUpperCase().replace('0X', '0x'), 'Listed, DNSSEC-verified', true, true, 'HOOD'],
    ]
    for (const [domain, token, reason, listed, verified, code] of cases) {
      const v = await w.verifyToken(domain, token, { fetch })
      assert.deepEqual([v.reason, v.listed, v.verified, v.code], [reason, listed, verified, code], `${domain} ${token}`)
    }
    const v = await w.verifyToken('shop.test', `solscan.io/token/${MINT}`, { fetch })
    assert.deepEqual([v.address, v.domain, v.match.code, v.records.length, v.agree], [MINT, 'shop.test', 'SOL', 2, true])
    await assert.rejects(w.verifyToken('shop.test', 'not a token', { fetch }), /Not a token address/)
  },
  'verifyToken: a link\'s chain must match the record\'s; a bare 0x matches any chain, or opts.code': async () => {
    const check = async (domain, token, opts = {}) => {
      const v = await w.verifyToken(domain, token, { fetch, ...opts })
      return [v.reason, v.verified, v.code]
    }
    // base.test lists BASE <contract>: the same address on Ethereum or Robinhood Chain is another token
    assert.deepEqual(await check('base.test', `https://etherscan.io/token/${CONTRACT}`), ['Token is not listed by this domain', false, 'ETH'])
    assert.deepEqual(await check('base.test', `https://robinhoodchain.blockscout.com/token/${CONTRACT}`), ['Token is not listed by this domain', false, 'HOOD'])
    assert.deepEqual(await check('base.test', `https://basescan.org/token/${CONTRACT}`), ['Listed, DNSSEC-verified', true, 'BASE'])
    assert.deepEqual(await check('base.test', CONTRACT), ['Listed, DNSSEC-verified', true, 'BASE'], 'a bare 0x: the verdict names the listed chain')
    assert.deepEqual(await check('base.test', CONTRACT, { code: 'eth' }), ['Token is not listed by this domain', false, 'ETH'])
    assert.deepEqual(await check('base.test', CONTRACT, { code: 'BASE' }), ['Listed, DNSSEC-verified', true, 'BASE'])
    assert.deepEqual(await check('base.test', `https://basescan.org/token/${CONTRACT}`, { code: 'ETH' }), ['Listed, DNSSEC-verified', true, 'BASE'], 'the link names the chain')
    // shop.test lists HOOD <contract>: a Base link to it is not listed
    assert.deepEqual(await check('shop.test', `https://basescan.org/token/${CONTRACT}`), ['Token is not listed by this domain', false, 'BASE'])
    await assert.rejects(w.verifyToken('base.test', CONTRACT, { fetch, code: 'BTC' }), /Unknown token chain BTC/)
    await assert.rejects(w.verifyToken('base.test', CONTRACT, { fetch, code: 'SOL' }), /SOL needs a Solana mint address/)
    // matchToken on one result: with a code only that chain's record counts
    const r = await w.resolveTokens('junk.test', { fetch })
    assert.deepEqual([w.matchToken(r, CONTRACT).code, w.matchToken(r, CONTRACT, 'BASE').verified, w.matchToken(r, CONTRACT, 'ETH').listed], ['BASE', true, false])
  },
  'CLI: token lists records, or checks one token with an exit status': () => {
    const mock = `data:text/javascript,${encodeURIComponent(`globalThis.fetch = (${tokenFetch.toString()})(JSON.parse(process.env.T262_TEST_ZONE))`)}`
    const cli = (...args) => {
      const p = spawnSync(process.execPath, ['--import', mock, fileURLToPath(new URL('../bin/type262.mjs', import.meta.url)), 'token', ...args], { env: { ...process.env, T262_TEST_ZONE: JSON.stringify(ZONE) }, encoding: 'utf8' })
      return [p.stdout.trimEnd(), p.status, p.stderr.trim()]
    }
    assert.deepEqual(cli('shop.test'), [[
      'shop.test  DNSSEC ✓  resolvers agree',
      `  SOL    ${MINT}  (Solana, signed)`,
      `  HOOD   ${CONTRACT}  (Robinhood Chain, signed)`,
    ].join('\n'), 0, ''])
    assert.deepEqual(cli('empty.test'), ['empty.test  DNSSEC ✓  resolvers agree\n  no _token record', 0, ''])
    assert.deepEqual(cli('unsigned.test'), [`unsigned.test  unsigned  resolvers agree\n  SOL    ${MINT}  (Solana)`, 0, ''])
    assert.deepEqual(cli('shop.test', `https://pump.fun/coin/${MINT}`), ['OFFICIAL: Listed, DNSSEC-verified [shop.test SOL]', 0, ''])
    assert.deepEqual(cli('unsigned.test', MINT), ['LISTED (not verified): Listed, but the zone is not DNSSEC-signed [unsigned.test SOL]', 0, ''])
    assert.deepEqual(cli('base.test', `https://etherscan.io/token/${CONTRACT}`), [
      `NOT LISTED: Token is not listed by this domain [base.test ETH]\n  BASE   ${CONTRACT}  (Base, signed)`, 1, ''])
    assert.deepEqual(cli('base.test', CONTRACT), ['OFFICIAL: Listed, DNSSEC-verified [base.test BASE]', 0, ''])
    assert.deepEqual(cli('shop.test', MINT2), [[
      'NOT LISTED: Token is not listed by this domain [shop.test SOL]',
      `  SOL    ${MINT}  (Solana, signed)`,
      `  HOOD   ${CONTRACT}  (Robinhood Chain, signed)`,
    ].join('\n'), 1, ''])
    assert.deepEqual(cli('shop.test', 'nonsense'), ['', 1, 'error: Not a token address or token link: nonsense'])
  },

  // ---------- the app (assets/token-records.js) ----------

  'app: lookups run once per domain for the page, at most three at a time, and a failed or partial one is retried': async () => {
    let inFlight = 0, peak = 0, calls = 0
    const slow = async url => {
      calls++
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise(r => setTimeout(r, 5))
      inFlight--
      return fetch(url)
    }
    const domains = ['a1.test', 'a2.test', 'a3.test', 'a4.test', 'a5.test', 'a6.test']
    const zone = Object.fromEntries(domains.map(d => [d, { txt: [`SOL ${MINT}`] }]))
    Object.assign(ZONE, zone)
    const results = await Promise.all([...domains, ...domains].map(d => app.tokenRecords(d, { fetch: slow })))
    assert.equal(calls, domains.length * 4, 'one lookup (two queries on two resolvers) per domain')
    assert.ok(peak <= 3 * 4, `at most three lookups at a time (${peak} requests in flight)`)
    assert.ok(results.every(r => r && r.verified))
    let up = false
    const flaky = async url => { if (!up) throw new Error('offline'); return fetch(url) }
    assert.equal(await app.tokenRecords('flaky.test', { fetch: flaky }), null)
    ZONE['flaky.test'] = { txt: [`SOL ${MINT}`] }
    up = true
    assert.equal((await app.tokenRecords('flaky.test', { fetch: flaky })).verified, true)
    // one resolver down: the result can't be verified, so it isn't kept either
    ZONE['onedown.test'] = { txt: [`SOL ${MINT}`], fail: 'b' }
    let asked = 0
    const counted = async url => { asked++; return fetch(url) }
    const partial = await app.tokenRecords('onedown.test', { fetch: counted })
    assert.deepEqual([partial.resolvers[1].ok, partial.verified, asked], [false, false, 4])
    delete ZONE['onedown.test'].fail
    assert.equal((await app.tokenRecords('onedown.test', { fetch: counted })).verified, true)
    assert.equal(asked, 8, 'asked again')
    await app.tokenRecords('onedown.test', { fetch: counted })
    assert.equal(asked, 8, 'a full answer is kept')
  },
  'app: isOfficial only for a mint in a DNSSEC-verified record': async () => {
    assert.equal(await app.isOfficial('shop.test', MINT, { fetch }), true)
    assert.equal(await app.isOfficial('shop.test', MINT2, { fetch }), false)
    assert.equal(await app.isOfficial('unsigned.test', MINT, { fetch }), false)
    assert.equal(await app.isOfficial('split.test', MINT, { fetch }), false)
    assert.equal(await app.isOfficial('', MINT, { fetch }), false)
  },
  'app: markOfficial tags only the cards their domain lists, once, and fills a card\'s own tag': async () => {
    const node = (sel = {}) => ({ html: '', title: '', text: '', classes: new Set(), sel, querySelector(s) { return this.sel[s] || null },
      insertAdjacentHTML(pos, html) { this.html += `${pos}:${html}` }, classList: { add(c) { this.owner.classes.add(c) } } })
    const mk = () => { const id = node(), card = node({ '.ln-id': id }); card.id = id; return card }
    const [listed, other, unsigned] = [mk(), mk(), mk()]
    const own = node(); own.classList.owner = own
    Object.defineProperty(own, 'textContent', { set(v) { this.text = v } })
    const feature = node({ '[data-official]': own })
    const cards = { [MINT]: listed, [MINT2]: other, [CONTRACT]: unsigned }
    const el = { querySelector: s => cards[s.match(/data-mint="([^"]+)"/)[1]] }
    app.markOfficial(el, [{ mint: MINT, domain: 'shop.test' }, { mint: MINT2, domain: 'shop.test' }, { mint: CONTRACT, domain: 'unsigned.test' }, { mint: 'x"]', domain: 'shop.test' }, null])
    await new Promise(r => setTimeout(r, 20))
    assert.match(listed.id.html, /^afterend:<span class="tag good tk-official" title="shop\.test lists this coin in its DNSSEC-signed _token record, and the resolvers agree\.">Official · listed by shop\.test<\/span>$/)
    assert.equal(other.id.html + unsigned.id.html, '')
    app.markOfficial({ querySelector: () => feature }, [{ mint: MINT, domain: 'shop.test' }])
    await new Promise(r => setTimeout(r, 20))
    assert.deepEqual([own.text, own.classes.has('tk-official')], ['Official · listed by shop.test', true])
  },
  'app: the Verify verdicts, with every value escaped': async () => {
    const html = async (d, t) => app.tokenCheckHtml(await w.verifyToken(d, t, { fetch }))
    const ok = await html('shop.test', MINT)
    assert.match(ok, /<strong>Official token\.<\/strong>/)
    assert.match(ok, new RegExp(`href="https://solscan.io/token/${MINT}"`))
    assert.match(ok, /shop\.test lists<\/span>/)
    assert.match(await html('unsigned.test', MINT), /<strong>Listed, not verified\.<\/strong>[\s\S]*This zone is not DNSSEC-signed/)
    assert.match(await html('down.test', MINT), /Not every resolver answered/)
    const not = await html('shop.test', MINT2)
    assert.match(not, /<strong>Not listed by shop\.test\.<\/strong>/)
    assert.ok(not.includes(MINT) && not.includes(CONTRACT), 'shows what the domain lists')
    assert.match(await html('split.test', MINT), /<strong>Resolvers disagree\.<\/strong>/)
    const none = await html('empty.test', MINT)
    assert.match(none, /<strong>No token records\.<\/strong>[\s\S]*href="#publish\/empty\.test"/)
    assert.doesNotMatch(none, /shop\.test lists|r-row/)
    assert.match(await html('gone.test', MINT), /This name doesn&#39;t exist\./)
    assert.match(await html('junk.test', CONTRACT), /3 malformed record\(s\)/)
    // the verdict names the chain, and a contract listed on another chain says so
    assert.match(await html('base.test', CONTRACT), /· Base · Listed, DNSSEC-verified · checked base\.test[\s\S]*base\.test lists it as its Base token in a DNSSEC-signed record/)
    const cross = await html('base.test', `https://etherscan.io/token/${CONTRACT}`)
    assert.match(cross, /<strong>Not listed by base\.test\.<\/strong>[\s\S]*· Ethereum · Token is not listed by this domain/)
    assert.match(cross, /base\.test lists this address on Base, not on Ethereum\. A contract at the same address on another chain is a different token\./)
    assert.ok(cross.includes(`href="https://basescan.org/token/${CONTRACT}"`) && !cross.includes('etherscan.io'), 'links the listed Base token, not the Ethereum one')
    assert.match(await html('shop.test', MINT2), /This is not a token shop\.test names as its own/)
    // A value from DNS is escaped (a resolver can return anything in an invalid record's error and in the domain).
    const evil = app.tokenCheckHtml({ domain: '<b>x</b>', address: '<img>', code: null, reason: '"r"', listed: false, verified: false, nxdomain: false, agree: true, dnssec: false,
      records: [], invalid: [{ error: '<script>' }], resolvers: [{ ok: true, records: [] }] })
    assert.ok(!/<b>x|<img>|<script>/.test(evil), evil)
  },
  'app: Publish picks the chain from the pasted token and writes the _token record': () => {
    assert.deepEqual(app.tokenEntry('SOL', `https://pump.fun/coin/${MINT}`), { code: 'SOL', address: MINT, error: '' })
    assert.deepEqual(app.tokenEntry('BASE', MINT), { code: 'SOL', address: MINT, error: '' })
    assert.deepEqual(app.tokenEntry('BASE', CONTRACT), { code: 'BASE', address: CONTRACT, error: '' })
    assert.deepEqual(app.tokenEntry('ETH', CONTRACT), { code: 'ETH', address: CONTRACT, error: '' })
    // a link names its chain, whatever the picker shows
    assert.deepEqual(app.tokenEntry('SOL', `https://basescan.org/token/${CONTRACT}`), { code: 'BASE', address: CONTRACT, error: '' })
    assert.deepEqual(app.tokenEntry('SOL', `https://etherscan.io/token/${CONTRACT}`), { code: 'ETH', address: CONTRACT, error: '' })
    assert.deepEqual(app.tokenEntry('ETH', `https://robinhoodchain.blockscout.com/token/${CONTRACT}`), { code: 'HOOD', address: CONTRACT, error: '' })
    // a bare 0x with the picker on Solana: no record until a chain is picked
    assert.deepEqual(app.tokenEntry('SOL', CONTRACT), { code: 'SOL', address: '', error: 'Pick the chain this contract lives on: Robinhood Chain, Base or Ethereum.' })
    assert.deepEqual(app.tokenEntry('SOL', ''), { code: 'SOL', address: '', error: '' })
    assert.match(app.tokenEntry('SOL', 'nope').error, /isn't a token address/)
    assert.match(app.tokenEntry('BASE', `https://solscan.io/token/${CONTRACT}`).error, /isn't a token address/)
    const html = app.tokenRecordHtml({ code: 'SOL', address: MINT }, { domain: 'yoursite.com', ttlText: '1 hour' })
    assert.match(html, /data-copy="_token"/)
    assert.match(html, new RegExp(`data-copy="SOL ${MINT}"`))
    assert.match(html, /<code>_token\.yoursite\.com<\/code>/)
    assert.match(app.tokenRecordHtml({ code: 'HOOD', address: CONTRACT }, { domain: 'shop.yoursite.com', sub: 'shop', ttlText: '5 min' }), /data-copy="_token\.shop"[\s\S]*data-copy="HOOD 0x7a1f/)
    assert.match(html, /Verify shows the coin as official, and so does Launch → Explore for a coin launched here for this domain\./)
    // publishToken reads the picker: a bare 0x on Solana gives no record
    const picker = (code, value) => ({ querySelector: s => ({ select: { value: code }, input: { value } })[s] })
    assert.deepEqual(app.publishToken(picker('SOL', `basescan.org/token/${CONTRACT}`)), { code: 'BASE', address: CONTRACT })
    assert.equal(app.publishToken(picker('SOL', CONTRACT)), null)
    assert.deepEqual(app.publishToken(picker('HOOD', CONTRACT)), { code: 'HOOD', address: CONTRACT })
  },
  'app: the token check link opens Verify in token mode, filled in, and runs it': async () => {
    for (const [t, coin] of [[{ code: 'SOL', address: MINT }, MINT], [{ code: 'BASE', address: CONTRACT }, `https://basescan.org/token/${CONTRACT}`],
      [{ code: 'HOOD', address: CONTRACT }, `https://robinhoodchain.blockscout.com/token/${CONTRACT}`]]) {
      const href = app.tokenCheckHref('shop.test', t)
      // as route() reads it: the hash after "verify/", decoded
      const arg = decodeURIComponent(href.slice('#verify/'.length))
      assert.deepEqual(app.tokenCheckArg(arg), { domain: 'shop.test', coin }, href)
      assert.equal(w.tokenRef(coin).code, t.code, 'the coin in the link names its chain')
    }
    assert.equal(app.tokenCheckHref('shop.test'), '#verify/token/shop.test')
    assert.deepEqual(app.tokenCheckArg('token/shop.test'), { domain: 'shop.test', coin: '' })
    assert.deepEqual(app.tokenCheckArg('token'), { domain: '', coin: '' })
    for (const arg of ['', 'shop.test', 'https://api.shop.test/token/x', 'tokens/shop.test']) assert.equal(app.tokenCheckArg(arg), null, arg)
    // mountTokenCheck on a fake Verify view
    const node = (extra = {}) => ({ hidden: false, listeners: {}, addEventListener(t, f) { this.listeners[t] = f }, setAttribute() {}, ...extra })
    const buttons = ['payto', 'token'].map(vm => node({ dataset: { vm }, on: false }))
    buttons.forEach(b => { b.classList = { toggle: (c, v) => { b.on = v } } })
    let submitted = 0
    const form = node({ hidden: true, elements: { d: { value: '' }, t: { value: '' } }, requestSubmit() { submitted++ } })
    const els = { '[data-form=verify-token]': form, '#vtoken-out': node({ hidden: true }), '[data-form=verify]': node(), '#verify-out': node() }
    const view = { querySelector: s => els[s], querySelectorAll: s => (s === '[data-vm]' ? buttons : []) }
    const check = app.mountTokenCheck(view)
    check.open('shop.test', '')
    assert.deepEqual([form.hidden, els['[data-form=verify]'].hidden, buttons[1].on, buttons[0].on, form.elements.d.value, submitted], [false, true, true, false, 'shop.test', 0], 'no coin: filled in, not run')
    check.open('shop.test', MINT)
    assert.deepEqual([form.elements.t.value, submitted], [MINT, 1])
    buttons[0].listeners.click()
    assert.deepEqual([form.hidden, els['[data-form=verify]'].hidden, buttons[0].on], [true, false, true])
  },
}

let failed = 0
for (const [name, fn] of Object.entries(tests)) {
  try { await fn(); console.log(`ok   ${name}`) } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`) }
}
console.log(failed ? `\n${failed} failed` : `\nall ${Object.keys(tests).length} passed`)
process.exitCode = failed ? 1 : 0
