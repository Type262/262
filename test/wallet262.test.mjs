// Offline tests for the codec, parsing and payment helpers. Run: node test/wallet262.test.mjs
import assert from 'node:assert/strict'
import * as w from '../lib/wallet262.js'

const EVM = '0x7a1fe1c2b0d3a4f5e6d7c8b9a0f1e2d3c4b5c0de'
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
        ? { Status: 0, AD: true, Answer: [{ type: 262, data: hex }] }
        : { Status: 0, AD: true },
    })
    const good = await w.verifyPayTo('https://api.shop.test/pay', EVM.toUpperCase().replace('0X', '0x'), { fetch })
    assert.equal(good.strong, true)
    assert.equal(good.resolvedAt, 'shop.test')
    const bad = await w.verifyPayTo('shop.test', '0x000000000000000000000000000000000000dEaD', { fetch })
    assert.equal(bad.ok, false)
  },
}

let failed = 0
for (const [name, fn] of Object.entries(tests)) {
  try { await fn(); console.log(`ok   ${name}`) } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`) }
}
console.log(failed ? `\n${failed} failed` : `\nall ${Object.keys(tests).length} passed`)
process.exitCode = failed ? 1 : 0
