// Offline tests for paying on Base: the app's chain config and helpers (assets/evm-pay.js), the x402 network
// helpers of the Verify tab, and the CLI's link command, run against mock DNS. Run: node test/evm-pay.test.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as w from '../lib/wallet262.js'
import * as P from '../assets/evm-pay.js'

const EVM = '0x7a1fe1c2b0d3a4f5e6d7c8b9a0f1e2d3c4b5c0de'
const OTHER = '0x1111111111111111111111111111111111111111'
const SOL = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'
// The Robinhood Chain config the app passes in (assets/app.js CHAIN), for the unchanged-output checks.
const ROBINHOOD = { id: 4663, name: 'Robinhood Chain', native: 'ETH', stable: { symbol: 'USDG', address: USDG, decimals: 6 } }
const CLI = fileURLToPath(new URL('../bin/type262.mjs', import.meta.url))

// The CLI in a child process whose fetch answers DoH from `zone`: name -> { rdata: [generic RDATA], ad }.
// Names not listed are NXDOMAIN; a listed name's _wallet TXT lookup is empty.
function cli(zone, ...args) {
  const mock = `const Z = ${JSON.stringify(zone)}
globalThis.fetch = async url => {
  const u = new URL(url), name = u.searchParams.get('name'), host = name.replace(/^_wallet\\./, '')
  const z = Z[host], body = { Status: z ? 0 : 3, AD: !!(z && z.ad) }
  if (z && name === host && u.searchParams.get('type') === '262') body.Answer = z.rdata.map(data => ({ name: name + '.', type: 262, data }))
  return { ok: true, json: async () => body }
}`
  const r = spawnSync(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(mock), CLI, ...args], { encoding: 'utf8' })
  return { out: r.stdout.trim(), err: r.stderr.trim(), status: r.status }
}
const ZONE = {
  'shop.test': { rdata: [w.encodeWalletRdata('SOL', SOL).generic, w.encodeWalletRdata('ETH', EVM).generic], ad: true },
  'loose.test': { rdata: [w.encodeWalletRdata('ETH', EVM).generic], ad: false },
  'solonly.test': { rdata: [w.encodeWalletRdata('SOL', SOL).generic], ad: true },
  'two.test': { rdata: [w.encodeWalletRdata('USDG', OTHER).generic, w.encodeWalletRdata('ETH', EVM).generic], ad: true },
  'usdgonly.test': { rdata: [w.encodeWalletRdata('USDG', OTHER).generic], ad: true },
}

const tests = {
  'base chain config': () => {
    assert.deepEqual([P.BASE.id, P.BASE.name, P.BASE.native, P.BASE.rpc, P.BASE.explorer], [8453, 'Base', 'ETH', 'https://mainnet.base.org', 'https://basescan.org'])
    assert.deepEqual(P.BASE.stable, { symbol: 'USDC', address: USDC_BASE, decimals: 6 })
    assert.ok(w.sameAddress(P.BASE.stable.address, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'))
    assert.equal('0x' + P.BASE.id.toString(16), '0x2105')
  },
  'eip-681 links on base: usdc and eth': () => {
    assert.equal(P.evmLink(P.BASE, EVM, 'stable', '5'), `ethereum:${USDC_BASE}@8453/transfer?address=${EVM}&uint256=5000000`)
    assert.equal(P.evmLink(P.BASE, EVM, 'stable', '0.25'), `ethereum:${USDC_BASE}@8453/transfer?address=${EVM}&uint256=250000`)
    assert.equal(P.evmLink(P.BASE, EVM, 'native', '0.01'), `ethereum:${EVM}@8453?value=10000000000000000`)
    assert.throws(() => P.evmLink(P.BASE, EVM, 'stable', '0.0000001'), /Max 6 decimals/)
  },
  'robinhood chain links and transfers are what the app built before': () => {
    for (const [asset, amount] of [['stable', '5'], ['native', '0.01']]) {
      const s = asset === 'stable' ? ROBINHOOD.stable : null
      assert.equal(P.evmLink(ROBINHOOD, EVM, asset, amount), w.paymentUri(EVM, { amount, chainId: 4663, token: s ? s.address : undefined, decimals: s ? s.decimals : 18 }))
      const before = w.transferTx({ from: '', to: EVM, amount, decimals: s ? s.decimals : 18, token: s ? s.address : undefined })
      delete before.from
      assert.deepEqual(P.evmTransfer(ROBINHOOD, EVM, asset, amount), before)
    }
    assert.equal(P.evmLink(ROBINHOOD, EVM, 'stable', '5'), `ethereum:${USDG}@4663/transfer?address=${EVM}&uint256=5000000`)
  },
  'transfers on base: usdc calls the token, eth is a plain value transfer': () => {
    const usdc = P.evmTransfer(P.BASE, EVM, 'stable', '5.5')
    assert.deepEqual(Object.keys(usdc).sort(), ['data', 'to', 'value'])
    assert.equal(usdc.to, USDC_BASE)
    assert.equal(usdc.value, '0x0')
    assert.equal(usdc.data, '0xa9059cbb' + EVM.slice(2).padStart(64, '0') + (5_500_000).toString(16).padStart(64, '0'))
    assert.deepEqual(P.evmTransfer(P.BASE, EVM, 'native', '0.01'), { to: EVM, value: '0x2386f26fc10000' })
    assert.deepEqual([P.assetSymbol(P.BASE, 'stable'), P.assetSymbol(P.BASE, 'native'), P.assetSymbol(ROBINHOOD, 'stable')], ['USDC', 'ETH', 'USDG'])
  },
  'chainRpc posts JSON-RPC to the chain\'s RPC and names the chain in errors': async () => {
    const seen = []
    const ok = async (url, init) => { seen.push([url, JSON.parse(init.body)]); return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x2105' }) } }
    assert.equal(await P.chainRpc(P.BASE, 'eth_chainId', [], ok), '0x2105')
    assert.deepEqual(seen, [['https://mainnet.base.org', { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }]])
    await assert.rejects(P.chainRpc(P.BASE, 'eth_chainId', [], async () => ({ ok: false, status: 429 })), /Base RPC answered 429/)
    await assert.rejects(P.chainRpc(P.BASE, 'eth_chainId', [], async () => { throw new Error('fetch failed') }), /Can't reach Base \(fetch failed\)/)
    await assert.rejects(P.chainRpc(P.BASE, 'eth_call', [], async () => ({ ok: true, json: async () => ({ error: { message: 'execution reverted' } }) })), /execution reverted/)
  },
  'chainRpc gives a stalled RPC up after the time given': async () => {
    // A fetch that never answers on its own, only when its signal aborts, as a hung connection behaves.
    const stalled = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)))
    const t = Date.now()
    const alive = setTimeout(() => {}, 5_000) // AbortSignal.timeout's timer alone doesn't keep Node running
    try {
      await assert.rejects(P.chainRpc(P.BASE, 'eth_getTransactionReceipt', [], stalled, 50), /^Error: Can't reach Base \(/)
    } finally { clearTimeout(alive) }
    assert.ok(Date.now() - t < 5_000, 'cut off at the time given')
  },
  'waitForReceipt: a failed read is tried again; only a receipt ends the wait': async () => {
    const hash = '0x' + 'ab'.repeat(32)
    const answers = [new Error('Base RPC answered 429'), null, { status: '0x1', transactionHash: hash }]
    let pauses = 0
    const read = async (method, params) => {
      assert.deepEqual([method, params], ['eth_getTransactionReceipt', [hash]])
      const a = answers.shift()
      if (a instanceof Error) throw a
      return a
    }
    const r = await P.waitForReceipt(P.BASE, hash, { read, pause: async () => { pauses++ } })
    assert.deepEqual([r.transactionHash, pauses], [hash, 2])
    await assert.rejects(P.waitForReceipt(P.BASE, hash, { read: async () => ({ status: '0x0' }), pause: async () => {} }), /Transaction reverted/)
  },
  'waitForReceipt: gives up after 2 minutes of elapsed time, however long each read takes': async () => {
    const hash = '0x' + 'cd'.repeat(32)
    // A fake clock: a pause moves it on by its length, a read by `took` (or by the time it was given, when it stalls).
    const run = async (took, answer) => {
      let at = 0, reads = 0, longest = 0
      const read = async (method, params, ms) => {
        reads++
        longest = Math.max(longest, ms)
        at += took ?? ms
        return answer()
      }
      const err = await P.waitForReceipt(P.BASE, hash, { read, pause: async ms => { at += ms }, now: () => at }).then(() => null, e => e)
      return { err, at, reads, longest }
    }
    const pending = await run(200, () => null)
    assert.match(pending.err.message, new RegExp(`^Still pending after 2 minutes \\(${hash}\\)\\. Check it on Basescan`))
    assert.ok(pending.at >= 120_000 && pending.at < 125_000 && pending.reads > 60, `polls until the deadline (${pending.at} ms, ${pending.reads} reads)`)
    const stalled = await run(undefined, () => { throw new Error("Can't reach Base (The operation was aborted due to timeout)") })
    assert.match(stalled.err.message, new RegExp(`^Sent, but Base could not be read to confirm it \\(Can't reach Base \\(The operation was aborted due to timeout\\)\\)\\. Check ${hash} on Basescan`))
    assert.ok(stalled.longest <= 10_000, `each read is given at most 10 seconds (${stalled.longest} ms)`)
    assert.ok(stalled.at <= 120_000 + 10_000 + 1_500 && stalled.reads <= 12, `an RPC that stalls every read still ends the wait in about 2 minutes (${stalled.at} ms, ${stalled.reads} reads)`)
    const failing = await run(100, () => { throw new Error('Base RPC answered 503') })
    assert.match(failing.err.message, new RegExp(`^Sent, but Base could not be read to confirm it \\(Base RPC answered 503\\)\\. Check ${hash} on Basescan`))
  },
  'basePick: one recipient on Base, by coin code, whatever the record order': () => {
    const A = '0x1111111111111111111111111111111111111111', B = '0x2222222222222222222222222222222222222222'
    const recs = (...pairs) => pairs.map(([code, address]) => ({ code, address }))
    assert.equal(P.basePick(recs(['USDG', A], ['ETH', B])), 1, 'ETH before USDG')
    assert.equal(P.basePick(recs(['ETH', B], ['USDG', A])), 0, '...in either order')
    assert.equal(P.basePick(recs(['USDG', A], ['ETH', B]), 'ETH'), 1)
    assert.equal(P.basePick(recs(['ETH', A], ['USDC', B])), 1, 'the line coded USDC for a USDC payment')
    assert.equal(P.basePick(recs(['ETH', A], ['USDC', B]), 'ETH'), 0, '...and the ETH line for ETH')
    assert.equal(P.basePick(recs(['ARB', A], ['EVM', B])), 1, 'EVM before a code for another chain')
    assert.equal(P.basePick(recs(['SOL', SOL], ['POL', A], ['DAI', B])), 2, 'a code that names no chain before one that does')
    assert.equal(P.basePick(recs(['USDG', A], ['HOOD', A], ['ARB', A], ['OP', A], ['POL', A])), -1, 'never a code for another chain')
    assert.equal(P.basePick(recs(['SOL', SOL], ['BTC', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'])), -1, 'no EVM address')
    assert.equal(P.basePick(recs(['BTC', A], ['ETH', B])), 1, 'an EVM address under a non-EVM code does not count')
    assert.equal(P.basePick([]), -1)
  },
  'x402 networks: v1 names, v2 CAIP-2 ids, missing networks, string bodies': () => {
    const body = {
      x402Version: 1,
      accepts: [
        { scheme: 'exact', network: 'base', payTo: EVM },
        { scheme: 'exact', network: 'eip155:8453', payTo: EVM.toUpperCase().replace('0X', '0x') },
        { scheme: 'exact', network: 'solana', payTo: SOL },
        { scheme: 'exact', payTo: '0x000000000000000000000000000000000000dEaD' },
        { scheme: 'exact', network: 'base' },
      ],
    }
    const nets = P.x402Networks(JSON.stringify(body))
    assert.deepEqual(nets.map(x => x.network), ['base', 'eip155:8453', 'solana', ''])
    assert.deepEqual(nets.map(x => x.payTo), w.payTosFromX402(body), 'the same payTos, in the same order, as payTosFromX402')
    assert.equal(P.networksFor(nets, EVM), 'Base', 'one name for both ids, matched without regard to case')
    assert.equal(P.networksFor(nets, SOL), 'Solana')
    assert.equal(P.networksFor(nets, '0x000000000000000000000000000000000000dEaD'), '')
    assert.equal(P.networksFor(nets, '0x0000000000000000000000000000000000000001'), '')
    assert.deepEqual(P.x402Networks({ paymentRequirements: [{ network: 'base-sepolia', pay_to: EVM }] }), [{ payTo: EVM, network: 'base-sepolia' }])
    assert.deepEqual(P.x402Networks({ network: 'polygon', payTo: EVM }), [{ payTo: EVM, network: 'polygon' }])
    assert.throws(() => P.x402Networks('{oops'))
  },
  'network labels': () => {
    assert.deepEqual(['base', 'BASE', 'eip155:8453', 'base-sepolia', 'eip155:84532', 'eip155:4663', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', 'polygon', ''].map(P.networkLabel),
      ['Base', 'Base', 'Base', 'Base Sepolia (testnet)', 'Base Sepolia (testnet)', 'Robinhood Chain', 'Solana', 'polygon', ''])
    assert.deepEqual(['constructor', 'toString', '__proto__'].map(P.networkLabel), ['constructor', 'toString', '__proto__'], 'names on Object.prototype are shown as written')
  },
  'cli link: usdc and eth on base': () => {
    assert.deepEqual(cli(ZONE, 'link', 'shop.test', '5', 'USDC', 'base'), { out: `ethereum:${USDC_BASE}@8453/transfer?address=${EVM}&uint256=5000000`, err: '', status: 0 })
    assert.deepEqual(cli(ZONE, 'link', 'shop.test', '0.01', 'eth', 'Base'), { out: `ethereum:${EVM}@8453?value=10000000000000000`, err: '', status: 0 })
    const loose = cli(ZONE, 'link', 'loose.test', '1', 'USDC', 'base')
    assert.deepEqual([loose.out, loose.err, loose.status], [`ethereum:${USDC_BASE}@8453/transfer?address=${EVM}&uint256=1000000`, 'warning: record is not DNSSEC-verified by every resolver', 0])
  },
  'cli link: on base, the ETH line before a USDG line; robinhood chain picks as before': () => {
    assert.deepEqual(cli(ZONE, 'link', 'two.test', '5', 'USDC', 'base'), { out: `ethereum:${USDC_BASE}@8453/transfer?address=${EVM}&uint256=5000000`, err: '', status: 0 })
    assert.deepEqual(cli(ZONE, 'link', 'two.test', '0.01', 'ETH', 'base'), { out: `ethereum:${EVM}@8453?value=10000000000000000`, err: '', status: 0 })
    assert.deepEqual(cli(ZONE, 'link', 'two.test', '5', 'USDG'), { out: `ethereum:${USDG}@4663/transfer?address=${OTHER}&uint256=5000000`, err: '', status: 0 }, 'robinhood: the first EVM record, unchanged')
    assert.deepEqual(cli(ZONE, 'link', 'usdgonly.test', '5', 'USDC', 'base'),
      { out: '', err: 'error: usdgonly.test publishes its EVM wallet only under codes for other chains (USDG), which Base does not pay', status: 1 })
  },
  'cli link: every existing default and output is unchanged': () => {
    const cases = [
      [['1'], `solana:${SOL}?amount=1`],
      [['5', 'USDC'], `solana:${SOL}?amount=5&spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`],
      [['5', 'USDG'], `ethereum:${USDG}@4663/transfer?address=${EVM}&uint256=5000000`],
      [['0.01', 'ETH'], `ethereum:${EVM}@4663?value=10000000000000000`],
      [['5', 'USDC', 'solana'], `solana:${SOL}?amount=5&spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`],
      [['0.01', 'ETH', 'robinhood'], `ethereum:${EVM}@4663?value=10000000000000000`],
    ]
    for (const [args, link] of cases) assert.deepEqual(cli(ZONE, 'link', 'shop.test', ...args), { out: link, err: '', status: 0 }, args.join(' '))
  },
  'cli link: refusals': () => {
    const refused = (args, err) => assert.deepEqual(cli(ZONE, 'link', ...args), { out: '', err, status: 1 }, args.join(' '))
    refused(['shop.test', '5', 'USDG', 'base'], 'error: USDG is not paid on base: use USDC or ETH')
    refused(['shop.test', '1', 'SOL', 'base'], 'error: SOL is not paid on base: use USDC or ETH')
    refused(['shop.test', '5', 'USDC', 'robinhood'], 'error: USDC is not paid on robinhood: use USDG or ETH')
    refused(['shop.test', '5', 'USDC', 'ethereum'], 'error: unknown chain ethereum: use solana, robinhood, base')
    refused(['shop.test', '5', 'DOGE'], 'error: unknown asset DOGE: use SOL, USDC, USDG, ETH')
    refused(['solonly.test', '5', 'USDC', 'base'], 'error: solonly.test publishes no EVM wallet')
    refused(['shop.test', '1.0000001', 'USDC', 'base'], 'error: Max 6 decimals')
  },
  'cli usage lists the chains': () => {
    const u = cli(ZONE)
    assert.equal(u.status, 0)
    assert.match(u.out, /link {4}<domain> <amount> \[SOL\|USDC\|USDG\|ETH\] \[solana\|robinhood\|base\]\n {41}wallet payment link: SOL \(default\) or USDC on Solana,\n {41}USDG or ETH on Robinhood Chain, USDC or ETH on Base$/)
  },
}

let failed = 0
for (const [name, fn] of Object.entries(tests)) {
  try { await fn(); console.log(`ok   ${name}`) } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`) }
}
console.log(failed ? `\n${failed} failed` : `\nall ${Object.keys(tests).length} passed`)
process.exitCode = failed ? 1 : 0
