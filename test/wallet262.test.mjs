// Offline tests for the codec, parsing and payment helpers. Run: node test/wallet262.test.mjs
import assert from 'node:assert/strict'
import * as w from '../lib/wallet262.js'

const EVM = '0x7a1fe1c2b0d3a4f5e6d7c8b9a0f1e2d3c4b5c0de'
const OTHER = '0x000000000000000000000000000000000000dEaD'

// Mock DoH for both default resolvers (side a: cloudflare, side b: google). zone[name] = { all: address } (both
// answer), { a, b } (they answer differently), {} (exists, no record). Also fail: 'b' (HTTP 500), nx: 'b' (that
// side says NXDOMAIN), status: 2 (SERVFAIL on both), unsigned: 'b' or 'all' (AD false), cname: target (an alias:
// the answer holds the CNAME and the target's records). Names not in the zone are NXDOMAIN. Side a writes owner
// names as asked, side b in upper case with a trailing dot, like real resolvers may.
const zoneFetch = zone => async url => {
  const u = new URL(url)
  const name = u.searchParams.get('name')
  const txt = name.startsWith('_wallet.')
  const host = txt ? name.slice(8) : name
  const z = zone[host]
  const side = u.hostname === 'dns.google' ? 'b' : 'a'
  if (z && z.fail === side) return { ok: false, status: 500, json: async () => ({}) }
  const body = { Status: !z || z.nx === side ? 3 : z.status || 0, AD: !(z && (z.unsigned === side || z.unsigned === 'all')) }
  const t = z && !txt && body.Status === 0 && u.searchParams.get('type') === '262' && (z.cname ? zone[z.cname] : z)
  const addr = t && (side in t ? t[side] : t.all)
  const owner = n => (side === 'b' ? n.toUpperCase() + '.' : n)
  if (t) {
    body.Answer = [
      ...(z.cname ? [{ name: owner(host), type: 5, data: z.cname + '.' }] : []),
      ...(addr ? [{ name: owner(z.cname || host), type: 262, data: w.encodeWalletRdata('ETH', addr).generic }] : []),
    ]
  }
  return { ok: true, json: async () => body }
}

const tests = {
  'encode/parse roundtrip': () => {
    const e = w.encodeWalletRdata('eth', EVM)
    assert.equal(e.bytes.length, 47)
    assert.deepEqual(w.parseWalletRdata(e.generic), { code: 'ETH', address: EVM })
  },
  'quoted presentation form': () => assert.deepEqual(w.parseWalletRdata(`"BTC" "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh"`).code, 'BTC'),
  'rejects three strings': () => assert.throws(() => w.parseWalletRdata('"A" "B" "C"')),
  'rejects bad length': () => assert.throws(() => w.parseWalletRdata('\\# 6 0345544800'), /length/),
  'rejects empty address': () => assert.throws(() => w.parseWalletRdata('\\# 5 0345544800'), /Empty/),
  'txt fallback forms': () => {
    assert.deepEqual(w.parseFallbackTxt(`"ETH ${EVM}"`), { code: 'ETH', address: EVM })
    assert.deepEqual(w.parseFallbackTxt(`ETH:${EVM}`), { code: 'ETH', address: EVM })
    assert.deepEqual(w.parseFallbackTxt(`"ETH" "${EVM}"`), { code: 'ETH', address: EVM })
  },
  'normalizes urls, emails, idn': () => {
    assert.equal(w.normalizeDomain('https://API.Example.com/x?y'), 'api.example.com')
    assert.equal(w.normalizeDomain('bob@stripe.com'), 'stripe.com')
    assert.equal(w.normalizeDomain('münchen.de'), 'xn--mnchen-3ya.de')
    assert.throws(() => w.normalizeDomain('not a domain'))
  },
  'address kinds': () => {
    assert.equal(w.addressKind(EVM), 'evm')
    assert.equal(w.addressKind('bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'), 'btc')
    assert.equal(w.addressKind('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin'), 'solana')
    assert.equal(w.codeMatchesAddress('BTC', EVM), false)
  },
  'usdg transfer calldata': () => {
    const tx = w.transferTx({ to: EVM, amount: '5.5', decimals: 6, token: '0x5fc5360d0400a0fd4f2af552add042d716f1d168' })
    assert.ok(tx.data.startsWith('0xa9059cbb'))
    assert.ok(tx.data.endsWith((5_500_000).toString(16).padStart(64, '0')))
  },
  'eip-681 link on robinhood chain': () => assert.equal(
    w.paymentUri(EVM, { amount: '5', chainId: 4663, token: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', decimals: 6 }),
    `ethereum:0x5fc5360d0400a0fd4f2af552add042d716f1d168@4663/transfer?address=${EVM}&uint256=5000000`),
  'parseUnits precision': () => {
    assert.equal(w.parseUnits('0.000001', 6), 1n)
    assert.throws(() => w.parseUnits('0.0000001', 6))
  },
  'x402 payTo extraction': () => assert.deepEqual(w.payTosFromX402({ x402Version: 1, accepts: [{ payTo: EVM }] }), [EVM]),
  'verifyPayTo with mocked DNS': async () => {
    const hex = w.encodeWalletRdata('ETH', EVM).generic
    const fetch = async url => ({
      ok: true,
      json: async () => url.includes('name=shop.test') && url.includes('type=262')
        ? { Status: 0, AD: true, Answer: [{ name: 'shop.test.', type: 262, data: hex }] }
        : { Status: 0, AD: true },
    })
    const good = await w.verifyPayTo('https://api.shop.test/pay', EVM.toUpperCase().replace('0X', '0x'), { fetch })
    assert.equal(good.strong, true)
    assert.equal(good.resolvedAt, 'shop.test')
    const bad = await w.verifyPayTo('shop.test', '0x000000000000000000000000000000000000dEaD', { fetch })
    assert.equal(bad.ok, false)
  },
  'resolveWalletsUp walks up only from an existing host the resolvers agree is empty': async () => {
    const fetch = zoneFetch({ 'shop.test': { all: EVM }, 'api.shop.test': {}, 'split.shop.test': { b: OTHER } })
    const up = await w.resolveWalletsUp('https://api.shop.test/pay', { fetch })
    assert.equal(up.resolvedAt, 'shop.test')
    assert.equal(up.requested, 'api.shop.test')
    assert.equal(up.records[0].address, EVM)
    const nx = await w.resolveWalletsUp('typo.shop.test', { fetch }) // NXDOMAIN: never answered by the parent
    assert.deepEqual([nx.resolvedAt, nx.requested, nx.nxdomain, nx.records.length], ['typo.shop.test', undefined, true, 0])
    const split = await w.resolveWalletsUp('split.shop.test', { fetch }) // one resolver has a record: no walk
    assert.deepEqual([split.resolvedAt, split.requested, split.agree], ['split.shop.test', undefined, false])
    assert.equal((await w.resolveWalletsUp('api.shop.test', { fetch, walkUp: false })).resolvedAt, 'api.shop.test')
  },
  'resolveWalletsUp never walks into a shared suffix': async () => {
    const fetch = zoneFetch({
      'github.io': { all: EVM }, 'alice.github.io': {}, 'co.uk': { all: EVM }, 'shop.co.uk': {},
      'vercel.app': { all: EVM }, 'myapp.vercel.app': {}, 'alice.onrender.com': {}, 'onrender.com': { all: EVM },
      'alice.netlify.app': { all: EVM }, 'api.alice.netlify.app': {},
    })
    for (const host of ['alice.github.io', 'shop.co.uk', 'myapp.vercel.app', 'alice.onrender.com']) {
      const r = await w.resolveWalletsUp(host, { fetch })
      assert.deepEqual([r.resolvedAt, r.requested, r.records.length], [host, undefined, 0], host)
    }
    // A site's own subdomain still falls back to the site: the check is on the parent only.
    assert.equal((await w.resolveWalletsUp('api.alice.netlify.app', { fetch })).resolvedAt, 'alice.netlify.app')
  },
  'verifyPayTo names a resolver disagreement': async () => {
    const v = await w.verifyPayTo('split.shop.test', OTHER, { fetch: zoneFetch({ 'shop.test': { all: OTHER }, 'split.shop.test': { b: OTHER } }) })
    assert.equal(v.ok, false)
    assert.match(v.reason, /disagree/)
  },
  'resolveWalletsUp stays at the host unless every resolver answered it with NOERROR': async () => {
    const fetch = zoneFetch({
      'shop.test': { all: EVM }, 'down.shop.test': { fail: 'b' }, 'nxsplit.shop.test': { nx: 'b' }, 'nxfirst.shop.test': { nx: 'a' },
      'servfail.shop.test': { status: 2 },
    })
    for (const host of ['down.shop.test', 'nxsplit.shop.test', 'nxfirst.shop.test', 'servfail.shop.test']) {
      const r = await w.resolveWalletsUp(host, { fetch })
      assert.deepEqual([r.resolvedAt, r.requested, r.records.length], [host, undefined, 0], host)
    }
  },
  'nxdomain when any resolver says NXDOMAIN': async () => {
    const fetch = zoneFetch({ 'nxsplit.test': { all: EVM, nx: 'b' }, 'nxfirst.test': { nx: 'a' }, 'shop.test': { all: EVM } })
    assert.equal((await w.resolveWallets('nxsplit.test', { fetch })).nxdomain, true)
    assert.equal((await w.resolveWallets('nxfirst.test', { fetch })).nxdomain, true)
    assert.equal((await w.resolveWallets('shop.test', { fetch })).nxdomain, false)
  },
  'verified needs every resolver to answer and authenticate every record': async () => {
    const fetch = zoneFetch({ 'shop.test': { all: EVM }, 'down.test': { all: EVM, fail: 'b' }, 'adsplit.test': { all: EVM, unsigned: 'b' } })
    const good = await w.resolveWallets('shop.test', { fetch })
    assert.deepEqual([good.verified, good.agree], [true, true])
    const down = await w.resolveWallets('down.test', { fetch }) // the resolver that answered agrees with itself
    assert.deepEqual([down.verified, down.agree, down.records.length], [false, true, 1])
    const ad = await w.resolveWallets('adsplit.test', { fetch })
    assert.deepEqual([ad.verified, ad.agree, ad.dnssec], [false, true, false])
  },
  'verifyPayTo reasons: the first rule that applies wins': async () => {
    const fetch = zoneFetch({
      'shop.test': { all: EVM }, 'nxsplit.test': { all: EVM, nx: 'b' }, 'empty.test': {}, 'split.test': { a: EVM, b: OTHER },
      'unsigned.test': { all: EVM, unsigned: 'all' }, 'down.test': { all: EVM, fail: 'b' }, 'adsplit.test': { all: EVM, unsigned: 'b' },
      'downunsigned.test': { all: EVM, fail: 'b', unsigned: 'a' },
    })
    const cases = [
      ['gone.test', EVM, 'Domain does not exist', false, false],
      ['nxsplit.test', EVM, 'Domain does not exist', false, false],
      ['empty.test', EVM, 'Domain publishes no WALLET record', false, false],
      ['shop.test', OTHER, 'Address is not published by this domain', false, false],
      ['split.test', EVM, 'Resolvers disagree. Possible tampering', false, false],
      ['split.test', OTHER, 'Resolvers disagree. Possible tampering', false, false],
      ['unsigned.test', EVM, 'Match, but the zone is not DNSSEC-signed', true, false],
      ['downunsigned.test', EVM, 'Match, but the zone is not DNSSEC-signed', true, false],
      ['down.test', EVM, 'Match, but not every resolver answered', true, false],
      ['adsplit.test', EVM, 'Match, but not DNSSEC-signed on every resolver', true, false],
      ['shop.test', EVM, 'Match, DNSSEC-verified', true, true],
    ]
    for (const [target, payTo, reason, ok, strong] of cases) {
      const v = await w.verifyPayTo(target, payTo, { fetch })
      assert.deepEqual([v.reason, v.ok, v.strong], [reason, ok, strong], `${target} ${payTo}`)
    }
  },
  'only answers owned by the queried name count (CNAME targets are ignored)': async () => {
    const fetch = zoneFetch({ 'evil.test': { all: OTHER }, 'alias.test': { cname: 'evil.test' }, 'alias.shop.test': { cname: 'evil.test' }, 'shop.test': { all: EVM } })
    const alias = await w.resolveWallets('alias.test', { fetch })
    assert.deepEqual([alias.records.length, alias.agree, alias.nxdomain], [0, true, false])
    const v = await w.verifyPayTo('alias.test', OTHER, { fetch })
    assert.deepEqual([v.ok, v.reason], [false, 'Domain publishes no WALLET record'])
    // A CNAMEd host has no record of its own, so it follows the normal walk-up rule.
    const up = await w.resolveWalletsUp('alias.shop.test', { fetch })
    assert.deepEqual([up.resolvedAt, up.requested, up.records[0].address], ['shop.test', 'alias.shop.test', EVM])
    // Owner names match without regard to case or a trailing dot (side b writes SHOP.TEST.).
    const shop = await w.resolveWallets('shop.test', { fetch })
    assert.ok(shop.resolvers.every(x => x.records.length === 1) && shop.verified)
  },
}

let failed = 0
for (const [name, fn] of Object.entries(tests)) {
  try { await fn(); console.log(`ok   ${name}`) } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`) }
}
console.log(failed ? `\n${failed} failed` : `\nall ${Object.keys(tests).length} passed`)
process.exitCode = failed ? 1 : 0
