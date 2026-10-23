// Tests for funding many domains at once (assets/solana-batch.js). Run: node test/solana-batch.test.mjs
// Offline, against mock fetch answers for DNS-over-HTTPS, the worker, the RPC and npm:
// - the list: domains, links and emails in any separator, normalized, repeats counted once, at most 25, and what
//   can't be used (not a domain, a shared host, a platform's page or subdomain, an address at a mail provider) kept
//   with its reason;
// - amounts: the total split evenly in exact base units (the remainder to the first rows) or the same for each, the
//   rent minimum of a new account, new USDC accounts, the payer's own wallet;
// - routes: paid directly only at one Solana wallet DNSSEC-signed on both resolvers that agree, and only a wallet;
//   otherwise into the vault, with the reason; a domain that doesn't exist or has no vault is skipped; a DNS answer
//   is read again after two minutes, and a route that changed since the review is named;
// - transactions: every one under 1,232 bytes, the expected count for N domains in SOL and in USDC, the compute limit
//   scaled to the payments, a reference and a memo per vault deposit, and a one-domain vault deposit built exactly as
//   the escrow screen's single deposit; sent through sendAll, simulated first, one approval each;
// - a package.json: homepages from npm, code and shared hosts left out with the reason.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as sol from '../assets/solana.js'
import * as V from '../assets/solana-vault.js'
import * as B from '../assets/solana-batch.js'
import { SHARED_HOSTS } from '../lib/wallet262.js'

const addr = label => sol.base58Encode(createHash('sha256').update(label).digest())
const USDC = sol.USDC.mint
const tests = {}
const test = (name, fn) => { tests[name] = fn }

// ---------- the list ----------

test('list: domains, links and emails, in lines, commas or spaces; normalized, once each, in order', () => {
  const r = B.parseList('lodash.com\nhttps://Vitejs.dev/guide/, bob@YourSite.com  https://www.example.org/pay\n\nlodash.com; LODASH.COM.\n"react.dev"')
  assert.deepEqual(r.domains, ['lodash.com', 'vitejs.dev', 'yoursite.com', 'example.org', 'react.dev'])
  assert.equal(r.duplicates, 2)
  assert.deepEqual(r.skipped, [])
  assert.equal(r.over, 0)
  // a list's bullets and numbers are not entries
  assert.deepEqual(B.parseList('- lodash.com\n* react.dev\n• viem.sh\n1. a.com\n2) b.com\n|').domains, ['lodash.com', 'react.dev', 'viem.sh', 'a.com', 'b.com'])
  assert.deepEqual(B.parseList('1. a.com 2. b.com').skipped, [])
  // www. goes only in front of a registrable name
  assert.equal(B.listDomain('www.example.co.uk'), 'example.co.uk')
  assert.equal(B.listDomain('www.com'), 'www.com')
  assert.equal(B.listDomain('shop.www.example.com'), 'shop.www.example.com')
})

test('list: what can\'t be used is kept with its reason, never dropped', () => {
  const r = B.parseList('not-a-domain example.com https://github.com/lodash/lodash someone.github.io my-app.vercel.app github.com')
  assert.deepEqual(r.domains, ['example.com', 'github.com'], 'a platform\'s own domain alone can still be paid')
  assert.deepEqual(r.skipped.map(s => s.input), ['not-a-domain', 'https://github.com/lodash/lodash', 'someone.github.io', 'my-app.vercel.app'])
  assert.match(r.skipped[0].reason, /Not a domain/)
  assert.match(r.skipped[1].reason, /github\.com hosts other people's projects/)
  assert.match(r.skipped[2].reason, /on github\.io, a shared host/)
  assert.match(r.skipped[3].reason, /on vercel\.app/)
})

test('list: subdomains of shared hosts and platforms, pages on app stores, creator and link sites, and addresses at mail providers are left out', () => {
  const left = [
    'writer.medium.com', 'blog.ghost.io', 'art.tumblr.com', 'me.wixsite.com/site', 'shop.myshopify.com', 'd111.cloudfront.net',
    'app.amplifyapp.com', 'x.r2.dev', 'main.supabase.co', 'game.itch.io', 'https://gist.github.com/user/id',
    'https://raw.githubusercontent.com/a/b', 'https://m.youtube.com/@chan', 'https://www.youtube.com/@chan', 'https://mobile.twitter.com/x',
    'https://apps.apple.com/app/x', 'https://play.google.com/store/apps/details?id=x', 'https://patreon.com/foo', 'https://opencollective.com/foo',
    'https://ko-fi.com/foo', 'https://linktr.ee/foo', 'https://bit.ly/abc', 'substack.com/@writer', 'someone@gmail.com', 'dev@proton.me',
    'mailto:x@hotmail.co.uk',
  ]
  const r = B.parseList([...left, 'bob@yoursite.com', 'youtube.com', 'patreon.com', 'gmail.com'].join('\n'), { max: 100 })
  assert.deepEqual(r.skipped.map(s => s.input), left)
  assert.deepEqual(r.domains, ['yoursite.com', 'youtube.com', 'patreon.com', 'gmail.com'], 'an address at its own domain, and a platform on its own, can be paid')
  const why = Object.fromEntries(r.skipped.map(s => [s.input, s.reason]))
  assert.match(why['writer.medium.com'], /on medium\.com, a shared host/)
  assert.match(why['https://gist.github.com/user/id'], /^gist\.github\.com is part of github\.com, which hosts other people's projects/)
  assert.match(why['https://apps.apple.com/app/x'], /part of apple\.com/)
  assert.match(why['https://www.youtube.com/@chan'], /^youtube\.com hosts other people's projects/)
  assert.match(why['substack.com/@writer'], /^substack\.com hosts other people's projects/)
  assert.match(why['someone@gmail.com'], /^gmail\.com is a mail provider/)
  // the shared hosts include the SDK's own list, the one resolveWalletsUp never walks into
  for (const h of SHARED_HOSTS) assert.match(B.sharedReason(`someone.${h}`), /a shared host/, h)
})

test('list: at most 25 domains; the ones past it are counted, repeats among them once', () => {
  const many = Array.from({ length: 30 }, (_, i) => `site${i}.com`)
  const r = B.parseList([...many, 'site29.com', 'site0.com'].join('\n'))
  assert.equal(r.domains.length, 25)
  assert.deepEqual(r.domains.slice(0, 2), ['site0.com', 'site1.com'])
  assert.equal(r.over, 5)
  assert.equal(r.duplicates, 2)
  assert.equal(B.parseList(many.join(' '), { max: 3 }).over, 27)
})

// ---------- amounts ----------

test('split: exact in base units, the remainder one unit each to the first rows', () => {
  assert.deepEqual(B.splitEvenly(10n, 3), [4n, 3n, 3n])
  assert.deepEqual(B.splitEvenly(10_000_000n, 4), [2_500_000n, 2_500_000n, 2_500_000n, 2_500_000n])
  assert.deepEqual(B.splitEvenly(5n, 1), [5n])
  assert.deepEqual(B.splitEvenly(2n, 3), [1n, 1n, 0n])
  assert.deepEqual(B.splitEvenly(5n, 0), [])
  for (const [t, n] of [[1_000_000_007n, 25], [123_456_789n, 7], [99n, 25]]) {
    const parts = B.splitEvenly(t, n)
    assert.equal(parts.reduce((a, b) => a + b, 0n), t, 'nothing lost or added')
    assert.ok(parts.every(p => p === parts[0] || p === parts[0] - 1n), 'at most one unit apart')
  }
})

const routedRow = (domain, over = {}) => ({ domain, route: 'vault', to: addr(`vault ${domain}`), tokenAccount: addr(`usdc ${domain}`), lamports: 1n, tokenOpen: true, why: '', ...over })

test('plan: the total split evenly or the same for each; skipped rows keep their reason and get nothing', () => {
  const rows = [routedRow('a.com'), { domain: 'gone.com', error: 'gone.com doesn\'t exist in DNS.' }, routedRow('b.com'), routedRow('c.com')]
  const p = B.plan(rows, { asset: 'usdc', amount: '10', mode: 'total' })
  assert.deepEqual(p.pay.map(r => [r.domain, r.amount]), [['a.com', 3_333_334n], ['b.com', 3_333_333n], ['c.com', 3_333_333n]])
  assert.equal(p.total, 10_000_000n)
  assert.equal(p.rows[1].amount, undefined)
  assert.equal(rows[0].amount, undefined, 'the routed rows are not changed')
  const each = B.plan(rows, { asset: 'sol', amount: '0.5', mode: 'each' })
  assert.deepEqual(each.pay.map(r => r.amount), [500_000_000n, 500_000_000n, 500_000_000n])
  assert.equal(each.total, 1_500_000_000n)
  assert.equal(each.token.symbol, 'SOL')
})

test('plan: amounts that can\'t be sent are refused in words', () => {
  const rows = [routedRow('a.com'), routedRow('b.com'), routedRow('c.com')]
  assert.match(B.plan(rows, { asset: 'usdc', amount: 'ten' }).error, /valid amount/)
  assert.match(B.plan(rows, { asset: 'usdc', amount: '0' }).error, /above zero/)
  assert.match(B.plan(rows, { asset: 'usdc', amount: '1.0000001' }).error, /USDC has at most 6 decimals/)
  assert.match(B.plan(rows, { asset: 'usdc', amount: '0.000002' }).error, /too small to split across 3 domains/)
  assert.match(B.plan([{ domain: 'x.com', error: 'nope' }], { asset: 'usdc', amount: '1' }).error, /None of these/)
})

test('plan: SOL to a new account needs the rent minimum; USDC counts the token accounts it opens; never the payer\'s own wallet', () => {
  const payer = addr('payer')
  const rows = [
    routedRow('new.com', { lamports: 0n, tokenOpen: false }),
    routedRow('funded.com', { lamports: 5n }),
    routedRow('me.com', { route: 'direct', to: payer }),
  ]
  const small = B.plan(rows, { asset: 'sol', amount: '0.001', mode: 'total', payer })
  assert.match(small.rows[2].error, /wallet you're paying from/)
  assert.deepEqual(small.pay.map(r => r.domain), ['new.com', 'funded.com'])
  assert.deepEqual(small.low.map(r => r.domain), ['new.com'], '0.0005 SOL can\'t open an account')
  assert.deepEqual(B.plan(rows, { asset: 'sol', amount: '0.002', payer }).low, [])
  const usdc = B.plan(rows, { asset: 'usdc', amount: '2', payer })
  assert.equal(usdc.opens, 1)
  assert.deepEqual(usdc.low, [])
  assert.equal(B.plan(rows, { asset: 'usdc', amount: '2' }).pay.length, 3, 'with no payer known, the row stays')
})

// ---------- routes ----------

const WALLET = addr('published wallet')
const rec = (address, dnssec = true, code = 'SOL') => ({ code, address, source: 'TXT', dnssec })
/** resolveWallets' answer: each resolver's records (null for one that failed); agree as resolveWallets computes it. */
function dnsAnswer(perResolver, { nxdomain = false } = {}) {
  const resolvers = perResolver.map((records, i) => (records ? { resolver: `r${i}`, ok: true, status: nxdomain ? 3 : 0, records } : { resolver: `r${i}`, ok: false, records: [] }))
  const ok = resolvers.filter(r => r.ok)
  const sig = r => r.records.map(x => `${x.code}|${x.address}`).sort().join(',')
  return { domain: 'x.com', records: ok[0].records, resolvers, agree: ok.every(r => sig(r) === sig(ok[0])), nxdomain }
}

test('routes: direct only at one Solana wallet that both resolvers return, agree on and sign', () => {
  assert.deepEqual(B.directWallet(dnsAnswer([[rec(WALLET)], [rec(WALLET)]])), { address: WALLET })
  const why = answer => B.directWallet(answer).reason
  assert.match(why(dnsAnswer([[rec(WALLET)], [rec(WALLET, false)]])), /not DNSSEC-signed/)
  assert.match(why(dnsAnswer([[rec(WALLET, false)], [rec(WALLET, false)]])), /not DNSSEC-signed/)
  assert.match(why(dnsAnswer([[rec(WALLET)], [rec(addr('other'))]])), /don't return the same record/)
  assert.match(why(dnsAnswer([[rec(WALLET)], null])), /Only one of the two resolvers/)
  assert.match(why(dnsAnswer([[rec(WALLET), rec(addr('second'))], [rec(WALLET), rec(addr('second'))]])), /more than one Solana address/)
  assert.match(why(dnsAnswer([[rec('0x1111111111111111111111111111111111111111', true, 'ETH')], [rec('0x1111111111111111111111111111111111111111', true, 'ETH')]])), /no Solana wallet/)
  assert.match(why(dnsAnswer([[rec(WALLET, true, 'ETH')], [rec(WALLET, true, 'ETH')]])), /no Solana wallet/, 'a Solana address under another code')
  assert.match(why(null), /couldn't be read/)
  // the same SOL address twice (WALLET and TXT) is still one wallet
  assert.deepEqual(B.directWallet(dnsAnswer([[rec(WALLET), { ...rec(WALLET), source: 'TYPE262' }], [rec(WALLET), { ...rec(WALLET), source: 'TYPE262' }]])), { address: WALLET })
})

test('routes: a published token account, mint or program goes to the vault; a missing domain or vault is skipped', () => {
  const vault = { vault: addr('vault'), usdcAccount: addr('vault usdc') }
  const signed = dnsAnswer([[rec(WALLET)], [rec(WALLET)]])
  const acc = (owner, size = 0, executable = false) => ({ address: WALLET, owner, lamports: 7n, data: new Uint8Array(size), executable })
  const walletToken = addr('wallet usdc')
  const direct = B.routeOf('x.com', { dns: signed, vault, walletToken, accounts: new Map([[WALLET, acc(sol.SYSTEM_PROGRAM)], [walletToken, acc(sol.TOKEN_PROGRAM, 165)]]) })
  assert.deepEqual(direct, { domain: 'x.com', route: 'direct', to: WALLET, tokenAccount: walletToken, lamports: 7n, tokenOpen: true, why: 'Publishes a DNSSEC-signed Solana wallet.' })
  assert.equal(B.routeOf('x.com', { dns: signed, vault, accounts: new Map() }).route, 'direct', 'a wallet with no account yet is a new wallet')
  for (const [a, text] of [[acc(sol.TOKEN_PROGRAM, 165), 'a token account'], [acc(sol.TOKEN_PROGRAM, 82), 'a token mint'], [acc('BPFLoaderUpgradeab1e11111111111111111111111', 36, true), 'a program'], [acc(sol.SYSTEM_PROGRAM, 80), 'an account owned by a program']]) {
    const r = B.routeOf('x.com', { dns: signed, vault, accounts: new Map([[WALLET, a], [vault.vault, { lamports: 3n }]]) })
    assert.deepEqual([r.route, r.to, r.tokenAccount, r.lamports, r.tokenOpen], ['vault', vault.vault, vault.usdcAccount, 3n, false])
    assert.equal(r.why, `Its published address is ${text}, not a wallet.`)
  }
  const unsigned = B.routeOf('x.com', { dns: dnsAnswer([[rec(WALLET, false)], [rec(WALLET, false)]]), vault, accounts: new Map() })
  assert.deepEqual([unsigned.route, unsigned.why], ['vault', 'Its record is not DNSSEC-signed.'])
  assert.match(B.routeOf('x.com', { dns: dnsAnswer([[], []], { nxdomain: true }), vault }).error, /doesn't exist in DNS/)
  assert.match(B.routeOf('x.com', { dns: null, vault: null, vaultError: 'The worker is asleep.' }).error, /Couldn't find its vault: The worker is asleep/)
  assert.equal(B.routeOf('x.com', { dns: signed, vault: null, accounts: new Map() }).route, 'direct', 'a direct payment needs no vault')
})

// ---------- lookup, against mocked DNS, worker and RPC ----------

const realFetch = globalThis.fetch
const respond = (body, status = 200) => ({ ok: status < 300, status, json: async () => body })

test('lookup: each domain\'s DNS and vault, then one read on Solana of every address a payment could go to', async () => {
  const published = { 'direct.com': [WALLET, true], 'unsigned.com': [addr('unsigned wallet'), false] }
  const vaults = { 'direct.com': addr('v direct'), 'unsigned.com': addr('v unsigned'), 'none.com': addr('v none') }
  const methods = []
  globalThis.fetch = async (url, init = {}) => {
    url = String(url)
    if (url.startsWith('https://cloudflare-dns.com/') || url.startsWith('https://dns.google/')) {
      const u = new URL(url)
      const name = u.searchParams.get('name'), type = Number(u.searchParams.get('type'))
      if (name === 'missing.com') return respond({ Status: 3, AD: false })
      const p = type === 16 && published[name.replace(/^_wallet\./, '')]
      return respond({ Status: 0, AD: p ? p[1] : true, ...(p ? { Answer: [{ name, type, data: `"SOL ${p[0]}"` }] } : {}) })
    }
    if (url.startsWith(`${V.WORKER_URL}/solana/vault`)) {
      const d = new URL(url).searchParams.get('domain')
      return vaults[d] ? respond({ domain: d, vault: vaults[d] }) : respond({ error: 'unavailable', reason: 'The worker is busy.' }, 503)
    }
    const body = JSON.parse(init.body)
    methods.push(body.method)
    if (body.method === 'getMultipleAccounts') return respond({ jsonrpc: '2.0', id: 1, result: { value: body.params[0].map(a => (a === vaults['unsigned.com'] ? { owner: sol.SYSTEM_PROGRAM, lamports: 1_000_000, data: ['', 'base64'], executable: false } : null)) } })
    throw new Error(`unexpected ${body.method}`)
  }
  try {
    const seen = []
    const rows = await B.lookup(['direct.com', 'unsigned.com', 'none.com', 'missing.com', 'noworker.com'], { onProgress: (n, total) => seen.push(`${n}/${total}`) })
    assert.deepEqual(rows.map(r => r.route || 'skipped'), ['direct', 'vault', 'vault', 'skipped', 'skipped'])
    assert.equal(rows[0].to, WALLET)
    assert.equal(rows[0].tokenAccount, await sol.associatedTokenAddress(WALLET, USDC))
    assert.deepEqual([rows[1].to, rows[1].lamports, rows[1].why], [vaults['unsigned.com'], 1_000_000n, 'Its record is not DNSSEC-signed.'])
    assert.equal(rows[1].tokenAccount, await sol.associatedTokenAddress(vaults['unsigned.com'], USDC), 'the vault\'s USDC account, derived here')
    assert.equal(rows[2].why, 'Publishes no Solana wallet yet.')
    assert.match(rows[3].error, /doesn't exist/)
    assert.match(rows[4].error, /Couldn't find its vault: The worker is busy/)
    assert.deepEqual(methods, ['getMultipleAccounts'], 'one read for all of them')
    assert.deepEqual(seen.at(-1), '5/5')
  } finally { globalThis.fetch = realFetch }
})

test('lookup: a DNS answer is kept for two minutes, then read again; changedRoutes names the domains whose route changed', async () => {
  const ROTATED = addr('rotated wallet'), V_ROTATE = addr('v rotate'), V_STEADY = addr('v steady')
  let published = WALLET // what rotate.com publishes, '' for nothing
  const asked = []
  globalThis.fetch = async (url, init = {}) => {
    url = String(url)
    if (url.startsWith('https://cloudflare-dns.com/') || url.startsWith('https://dns.google/')) {
      const u = new URL(url)
      const name = u.searchParams.get('name'), type = Number(u.searchParams.get('type'))
      asked.push(name)
      const p = type === 16 && name === '_wallet.rotate.com' && published
      return respond({ Status: 0, AD: true, ...(p ? { Answer: [{ name, type, data: `"SOL ${p}"` }] } : {}) })
    }
    if (url.startsWith(`${V.WORKER_URL}/solana/vault`)) {
      const d = new URL(url).searchParams.get('domain')
      return respond({ domain: d, vault: d === 'rotate.com' ? V_ROTATE : V_STEADY })
    }
    const body = JSON.parse(init.body)
    if (body.method === 'getMultipleAccounts') return respond({ jsonrpc: '2.0', id: 1, result: { value: body.params[0].map(() => null) } })
    throw new Error(`unexpected ${body.method}`)
  }
  const realNow = Date.now
  const at = ms => { Date.now = () => realNow() + ms }
  try {
    const domains = ['rotate.com', 'steady.com']
    const reviewed = await B.lookup(domains)
    assert.deepEqual(reviewed.map(r => [r.route, r.to]), [['direct', WALLET], ['vault', V_STEADY]])
    published = ROTATED // the owner rotates the wallet after the review
    const n = asked.length
    const soon = await B.lookup(domains)
    assert.equal(asked.length, n, 'within two minutes nothing is asked again')
    assert.deepEqual(B.changedRoutes(reviewed, soon), [])
    at(121_000)
    const later = await B.lookup(domains)
    assert.ok(asked.length > n, 'after two minutes DNS is read again')
    assert.deepEqual([later[0].route, later[0].to], ['direct', ROTATED])
    assert.deepEqual(B.changedRoutes(reviewed, later), ['rotate.com'])
    published = '' // then removes the record: its payment would go to its vault
    at(242_000)
    const removed = await B.lookup(domains)
    assert.deepEqual([removed[0].route, removed[0].to], ['vault', V_ROTATE])
    assert.deepEqual(B.changedRoutes(reviewed, removed), ['rotate.com'])
    assert.deepEqual(B.changedRoutes(removed, removed), [])
    // a domain that can't be paid any more, or now can, is a change too
    assert.deepEqual(B.changedRoutes([{ domain: 'a.com', error: 'No vault.' }, { domain: 'b.com', route: 'vault', to: V_STEADY }], [{ domain: 'a.com', route: 'vault', to: V_ROTATE }, { domain: 'b.com', error: 'No vault.' }]), ['a.com', 'b.com'])
  } finally { globalThis.fetch = realFetch; Date.now = realNow }
})

// ---------- transactions ----------

const PAYER = addr('payer')
const rowsOf = (n, route, len = 10) => Array.from({ length: n }, (_, i) => ({
  domain: `${String(i).padStart(len - 4, 'd')}.com`, route, to: addr(`to ${route} ${i}`), tokenAccount: addr(`token ${route} ${i}`), amount: 1_000_000n,
}))
const budgetOf = ixs => ixs.filter(ix => ix.programId === V.COMPUTE_BUDGET).map(ix => [ix.data[0], ix.data[0] === 3 ? Buffer.from(ix.data).readBigUInt64LE(1) : Buffer.from(ix.data).readUInt32LE(1)])

test('pack: every transaction under 1,232 bytes; N domains make the expected number in SOL and USDC', async () => {
  const cases = [
    ['sol', 'vault', 1, 1], ['sol', 'vault', 11, 1], ['sol', 'vault', 12, 2], ['sol', 'vault', 25, 3],
    ['sol', 'direct', 20, 1], ['sol', 'direct', 25, 2],
    ['usdc', 'vault', 6, 1], ['usdc', 'vault', 7, 2], ['usdc', 'vault', 25, 5],
    ['usdc', 'direct', 9, 1], ['usdc', 'direct', 25, 3],
  ]
  for (const [asset, route, n, want] of cases) {
    const txs = await B.transactions(PAYER, { asset, pay: rowsOf(n, route) })
    assert.equal(txs.length, want, `${n} ${asset} ${route}: ${txs.map(t => t.rows.length)}`)
    assert.deepEqual(txs.flatMap(t => t.rows.map(r => r.domain)), rowsOf(n, route).map(r => r.domain), 'every row once, in order')
    for (const t of txs) {
      assert.ok(V.legacySize(PAYER, t.instructions) <= V.LEGACY_LIMIT, `${V.legacySize(PAYER, t.instructions)} bytes`)
      sol.unsignedTransaction(sol.serializeMessage(sol.compileMessage({ payer: PAYER, recentBlockhash: sol.SYSTEM_PROGRAM, instructions: t.instructions })))
    }
  }
  // longer names fit fewer per transaction; the longest a name can be still fits on its own
  assert.equal((await B.transactions(PAYER, { asset: 'sol', pay: rowsOf(25, 'vault', 40) })).length, 4)
  const longest = [{ ...rowsOf(1, 'vault')[0], domain: `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}` }]
  assert.equal(longest[0].domain.length, 253)
  for (const asset of ['sol', 'usdc']) assert.equal((await B.transactions(PAYER, { asset, pay: longest })).length, 1)
})

test('pack: the compute limit scales with the payments; priority fee and loaded-data limit as a deposit sets them', async () => {
  const [a, b, c] = await B.transactions(PAYER, { asset: 'sol', pay: rowsOf(25, 'vault') })
  assert.deepEqual(budgetOf(a.instructions), [[2, 11 * V.DEPOSIT.solUnits], [3, V.DEPOSIT.microLamports], [4, V.DEPOSIT.loadedData]])
  assert.deepEqual(budgetOf(c.instructions)[0], [2, 3 * V.DEPOSIT.solUnits])
  const [u] = await B.transactions(PAYER, { asset: 'usdc', pay: rowsOf(6, 'vault') })
  assert.deepEqual(budgetOf(u.instructions)[0], [2, 6 * V.DEPOSIT.usdcUnits])
  assert.equal(B.unitsFor('usdc', 100), B.MAX_UNITS)
  // fees: a signature each, and the priority fee on each limit (11 x 30,000 CU at 0.1 lamport)
  assert.equal(B.feesOf([a], 'sol'), 5_000n + 33_000n)
  assert.equal(B.feesOf([a, b, c], 'sol'), 15_000n + (25n * 30_000n) / 10n)
})

test('pack: a vault deposit carries the board reference and its own memo; a direct payment neither', async () => {
  const pay = [...rowsOf(2, 'vault'), ...rowsOf(1, 'direct')]
  const [sTx] = await B.transactions(PAYER, { asset: 'sol', pay })
  const body = sTx.instructions.filter(ix => ix.programId !== V.COMPUTE_BUDGET)
  assert.deepEqual(body.map(ix => ix.programId), [sol.SYSTEM_PROGRAM, V.MEMO_PROGRAM, sol.SYSTEM_PROGRAM, V.MEMO_PROGRAM, sol.SYSTEM_PROGRAM])
  assert.deepEqual(body.map(ix => (ix.programId === V.MEMO_PROGRAM ? new TextDecoder().decode(ix.data) : ix.keys.map(k => k.pubkey))), [
    [PAYER, pay[0].to, V.BOARD_REFERENCE], `TYPE/262 deposit ${pay[0].domain}`,
    [PAYER, pay[1].to, V.BOARD_REFERENCE], `TYPE/262 deposit ${pay[1].domain}`,
    [PAYER, pay[2].to],
  ])
  // what the board reads: a memo per domain, as the RPC lists them
  const listed = body.filter(ix => ix.programId === V.MEMO_PROGRAM).map(ix => `[${ix.data.length}] ${new TextDecoder().decode(ix.data)}`).join('; ')
  assert.deepEqual(V.memos(listed).map(V.parseBoardMemo).map(t => t.domain), [pay[0].domain, pay[1].domain])

  const source = await sol.associatedTokenAddress(PAYER, USDC)
  const [uTx] = await B.transactions(PAYER, { asset: 'usdc', pay })
  const u = uTx.instructions.filter(ix => ix.programId !== V.COMPUTE_BUDGET)
  assert.deepEqual(u.map(ix => ix.programId), [sol.ATA_PROGRAM, sol.TOKEN_PROGRAM, V.MEMO_PROGRAM, sol.ATA_PROGRAM, sol.TOKEN_PROGRAM, V.MEMO_PROGRAM, sol.ATA_PROGRAM, sol.TOKEN_PROGRAM])
  assert.deepEqual(u[0], sol.createAssociatedTokenAccountIdempotent({ payer: PAYER, ata: pay[0].tokenAccount, owner: pay[0].to, mint: USDC }))
  assert.deepEqual(u[1], V.withReference(sol.transferChecked({ source, mint: USDC, destination: pay[0].tokenAccount, owner: PAYER, amount: 1_000_000n, decimals: 6 })))
  assert.deepEqual(u[7], sol.transferChecked({ source, mint: USDC, destination: pay[2].tokenAccount, owner: PAYER, amount: 1_000_000n, decimals: 6 }))
})

test('pack: one domain into its vault is built exactly as the escrow screen\'s single deposit', async () => {
  const vault = addr('single vault'), usdcAccount = addr('single usdc')
  const row = { domain: 'single.com', route: 'vault', to: vault, tokenAccount: usdcAccount, amount: 250_000_000n }
  // the instructions solana-escrow.js sends for one deposit (its #se-dep handler)
  const single = [...V.depositBudget(V.DEPOSIT.solUnits), V.withReference(sol.systemTransfer(PAYER, vault, 250_000_000n)), V.memoIx(V.boardMemo('deposit', 'single.com'))]
  const [s] = await B.transactions(PAYER, { asset: 'sol', pay: [row] })
  assert.deepEqual(s.instructions, single)
  const src = await sol.associatedTokenAddress(PAYER, USDC)
  const singleUsdc = [
    ...V.depositBudget(V.DEPOSIT.usdcUnits),
    sol.createAssociatedTokenAccountIdempotent({ payer: PAYER, ata: usdcAccount, owner: vault, mint: USDC }),
    V.withReference(sol.transferChecked({ source: src, mint: USDC, destination: usdcAccount, owner: PAYER, amount: 250_000_000n, decimals: 6 })),
    V.memoIx(V.boardMemo('deposit', 'single.com')),
  ]
  const [u] = await B.transactions(PAYER, { asset: 'usdc', pay: [row] })
  assert.deepEqual(u.instructions, singleUsdc)
})

test('send: a batch goes through sendAll, simulated before each approval, one approval per transaction', async () => {
  const account = { address: PAYER, chains: ['solana:mainnet'] }
  let approvals = 0
  const order = []
  const wallet = { features: { 'solana:signAndSendTransaction': { signAndSendTransaction: async ({ transaction }) => { approvals++; order.push('approve'); assert.ok(transaction.length <= V.LEGACY_LIMIT); return [{ signature: new Uint8Array(64).fill(approvals) }] } } } }
  globalThis.fetch = async (url, init = {}) => {
    const body = JSON.parse(init.body)
    const result = (() => {
      switch (body.method) {
        case 'getLatestBlockhash': return { context: { slot: 1 }, value: { blockhash: addr('blockhash'), lastValidBlockHeight: 100 } }
        case 'simulateTransaction': order.push('simulate'); assert.equal(body.params[1].sigVerify, false); return { context: { slot: 1 }, value: { err: null, logs: [] } }
        case 'getSignatureStatuses': return { context: { slot: 1 }, value: [{ confirmationStatus: 'confirmed', err: null }] }
        default: throw new Error(`unexpected ${body.method}`)
      }
    })()
    return respond({ jsonrpc: '2.0', id: 1, result })
  }
  try {
    const txs = await B.transactions(PAYER, { asset: 'sol', pay: rowsOf(14, 'vault') })
    assert.equal(txs.length, 2)
    const sigs = await V.sendAll(txs, () => {}, { wallet, account })
    assert.equal(sigs.length, 2)
    assert.equal(approvals, 2)
    assert.deepEqual(order, ['simulate', 'approve', 'simulate', 'approve'])
  } finally { globalThis.fetch = realFetch }
})

// ---------- a package.json ----------

test('package.json: each dependency\'s homepage on npm; code hosts, shared hosts and the rest left out with the reason', async () => {
  const homes = {
    lodash: 'https://lodash.com/', viem: 'https://viem.sh', 'lodash.merge': 'https://lodash.com/', react: 'https://react.dev/',
    '@scope/tool': 'https://www.tool.example/docs', gh: 'https://github.com/someone/gh#readme', pages: 'https://someone.github.io/pages',
    app: 'https://my-app.vercel.app', nohome: '', gitlab: 'https://gitlab.com', gist: 'https://gist.github.com/someone/abc',
  }
  const asked = []
  const fetchImpl = async url => {
    asked.push(url)
    const name = decodeURIComponent(url.slice('https://registry.npmjs.org/'.length).replace(/\/latest$/, ''))
    if (name === 'down') return respond({}, 500)
    if (!(name in homes)) return respond({ error: 'Not found' }, 404)
    return respond({ name, version: '1.0.0', ...(homes[name] ? { homepage: homes[name] } : {}) })
  }
  const pkg = { name: 'mine', dependencies: { lodash: '^4', viem: '^2', 'lodash.merge': '^4', '@scope/tool': '1', gh: '1', pages: '1' }, devDependencies: { react: '19', app: '1', nohome: '1', missing: '1', down: '1', gitlab: '1', gist: '1', 'Not Valid': '1', lodash: '^4' } }
  const r = await B.packageDomains(JSON.stringify(pkg), { fetchImpl })
  assert.deepEqual(r.domains, ['lodash.com', 'viem.sh', 'tool.example', 'react.dev'])
  assert.equal(r.names.length, 14, 'a dependency listed twice is read once')
  assert.equal(r.capped, false)
  assert.deepEqual(Object.fromEntries(r.left.map(l => [l.name, l.reason])), {
    gh: 'homepage on github.com', pages: 'homepage on github.io', app: 'homepage on vercel.app', nohome: 'no homepage on npm',
    missing: 'not on npm', down: "couldn't be read from npm", gitlab: 'homepage on gitlab.com', gist: 'homepage on github.com', 'Not Valid': 'not an npm package name',
  })
  assert.ok(asked.includes('https://registry.npmjs.org/@scope%2Ftool/latest'))
  assert.equal(asked.length, 13, 'the invalid name is never asked for')
  const capped = await B.packageDomains({ dependencies: Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`p${i}`, '1'])) }, { fetchImpl, max: 3 })
  assert.deepEqual([capped.names.length, capped.capped], [3, true])
  await assert.rejects(B.packageDomains({ name: 'empty' }, { fetchImpl }), /no dependencies/)
})

// ---------- run ----------

let failed = 0
for (const [name, fn] of Object.entries(tests)) {
  try { await fn(); console.log(`ok   ${name}`) } catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.stack || err.message}`) }
}
console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
