// Tests for the board's Solana side (assets/solana-board.js) and the board tag (assets/solana-vault.js).
// Run: node test/solana-board.test.mjs. Offline, against mock fetch answers for the worker, the RPC and the price feed:
// - the tag: the memo format and parser, the reference appended read-only, the launch tag;
// - parsing: a tagged deposit's sender and amount (SOL, and USDC where the RPC names the owner multisigAuthority),
//   and what a claim paid out of a vault;
// - the board: only domains with real money or coins make it, whatever a memo says; balances, supporters, claims
//   and dollars add up; copies of the worker's claim and refund memos count for nothing (board and profile); a worker
//   that is down is an error, not an empty board, even with only launches in the index; each transaction is read
//   once, a vault's coins in one read, PumpSwap's creator vault counts with the fees, and memos can't make it ask the
//   worker for more than 150 vaults; a profile whose coins couldn't be read says so;
// - both chains: a Robinhood Chain block time that couldn't be read is asked again, only the newest events are given
//   a time, a domain with money on Robinhood Chain alone shows while Solana is down, and a refresh that fails on one
//   chain keeps that chain's last good read.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as sol from '../assets/solana.js'
import * as V from '../assets/solana-vault.js'
import * as B from '../assets/solana-board.js'
import * as R from '../assets/chain-data.js'
import { boardData } from '../assets/board-data.js'

const addr = label => sol.base58Encode(createHash('sha256').update(label).digest())
const SYSTEM = sol.SYSTEM_PROGRAM
const TOKEN = sol.TOKEN_PROGRAM
const USDC = sol.USDC.mint

let failed = 0
const tests = {}
const run = async () => {
  for (const [name, fn] of Object.entries(tests)) {
    try { await fn(); console.log(`ok   ${name}`) } catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.stack.split('\n').slice(0, 3).join('\n     ')}`) }
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed')
  process.exit(failed ? 1 : 0)
}

// ---------- the tag ----------

Object.assign(tests, {
  'tag: memo format and parser; worker memos and other text are not board memos': () => {
    assert.equal(V.boardMemo('deposit', 'example.com'), 'TYPE/262 deposit example.com')
    assert.deepEqual(V.parseBoardMemo('TYPE/262 deposit shop.example.com'), { kind: 'deposit', domain: 'shop.example.com' })
    // launches carry no memo: their domain is in the coin's metadata
    for (const t of ['type262:claim:example.com', 'type262:refund:abc', 'TYPE/262 deposit', 'TYPE/262 deposit a b', 'TYPE/262 launch example.com', 'hello', '', null]) assert.equal(V.parseBoardMemo(t), null, t)
    // The worker skips memos starting with "type262:" when it reads a vault's deposits: a board memo must not.
    assert.ok(!V.boardMemo('deposit', 'x.com').startsWith('type262:'))
  },
  'tag: the reference is appended read-only and unsigned; everything else is untouched': () => {
    const ix = sol.systemTransfer(addr('a'), addr('b'), 5n)
    const t = V.withReference(ix)
    assert.deepEqual(t.keys.slice(0, 2), ix.keys)
    assert.deepEqual(t.keys[2], { pubkey: V.BOARD_REFERENCE, isSigner: false, isWritable: false })
    assert.equal(t.data, ix.data)
    assert.equal(ix.keys.length, 2, 'the original instruction is not mutated')
  },
  'tag: the board reference is the memo program address of "type262:board", off the curve': async () => {
    const [a] = await sol.findProgramAddress([new TextEncoder().encode('type262:board')], V.MEMO_PROGRAM)
    assert.equal(a, V.BOARD_REFERENCE)
    assert.equal(sol.isOnCurve(sol.pubkeyBytes(a)), false)
  },
  'tag: a launch without an opening buy carries the reference on a zero-lamport transfer to the payer': () => {
    const payer = addr('payer')
    const t = V.launchTag(payer)
    assert.equal(t.programId, SYSTEM)
    assert.deepEqual(t.keys.map(k => [k.pubkey, k.isSigner, k.isWritable]), [[payer, true, true], [payer, false, true], [V.BOARD_REFERENCE, false, false]])
    assert.deepEqual([...t.data], [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
  },
})

// ---------- parsing ----------

const VAULT = addr('vault')
const VAULT_USDC = addr('vault usdc')
const ALICE = addr('alice')
const info = { vault: VAULT, usdcAccount: VAULT_USDC }
const tx = (ixs, err = null) => ({ slot: 1, blockTime: 1_760_000_000, meta: { err }, transaction: { message: { accountKeys: [], instructions: ixs } } })
const solIx = (source, destination, lamports) => ({ program: 'system', programId: SYSTEM, parsed: { type: 'transfer', info: { source, destination, lamports } } })
const usdcIx = (source, destination, amount, who) => ({ program: 'spl-token', programId: TOKEN, parsed: { type: 'transferChecked', info: { source, destination, mint: USDC, ...who, tokenAmount: { amount: String(amount), decimals: 6 } } } })
const memoIx = text => ({ program: 'spl-memo', programId: V.MEMO_PROGRAM, parsed: text })

Object.assign(tests, {
  'parse: a pump.fun create_v2 in a transaction gives the mint, the creator and the metadata link': async () => {
    const mint = addr('mint'), creator = addr('creator vault'), user = addr('user')
    const ix = await V.createV2({ mint, user, creator, name: 'Your Site', symbol: 'SITE', uri: 'https://ipfs.io/ipfs/bafy' })
    const raw = { programId: ix.programId, accounts: ix.keys.map(k => k.pubkey), data: sol.base58Encode(ix.data) }
    assert.deepEqual(B.createOf(tx([raw])), { mint, creator, uri: 'https://ipfs.io/ipfs/bafy', name: 'Your Site', symbol: 'SITE' })
    assert.equal(B.createOf(tx([raw], { InstructionError: [0, 'Custom'] })), null)
    assert.equal(B.createOf(tx([{ ...raw, programId: addr('other') }])), null)
    assert.equal(B.createOf(tx([{ ...raw, data: sol.base58Encode(ix.data.slice(0, 20)) }])), null)
  },
  'parse: a tagged SOL deposit, and a tagged USDC deposit whose owner the RPC calls multisigAuthority': () => {
    assert.deepEqual(B.depositIn(tx([solIx(ALICE, VAULT, 1_000_000_000), memoIx('TYPE/262 deposit x.com')]), info), { mint: 'SOL', amount: 1_000_000_000n, from: ALICE })
    const tagged = usdcIx(addr('alice usdc'), VAULT_USDC, 25_000000, { multisigAuthority: ALICE, signers: [V.BOARD_REFERENCE] })
    assert.deepEqual(B.depositIn(tx([tagged]), info), { mint: USDC, amount: 25_000000n, from: ALICE })
    assert.deepEqual(B.depositIn(tx([usdcIx(addr('alice usdc'), VAULT_USDC, 3, { authority: ALICE })]), info), { mint: USDC, amount: 3n, from: ALICE })
  },
  'parse: no deposit for another destination, a failed transaction or nothing at all': () => {
    assert.equal(B.depositIn(tx([solIx(ALICE, addr('someone'), 5)]), info), null)
    assert.equal(B.depositIn(tx([solIx(ALICE, VAULT, 5)], { InstructionError: [0, 'Custom'] }), info), null)
    assert.equal(B.depositIn(tx([memoIx('TYPE/262 deposit x.com')]), info), null)
    assert.equal(B.depositIn(null, info), null)
  },
  'parse: what a claim paid out of the vault, SOL and USDC': () => {
    const t = tx([memoIx('type262:claim:x.com'), solIx(VAULT, addr('owner'), 990), solIx(VAULT, addr('fee'), 10), usdcIx(VAULT_USDC, addr('owner usdc'), 99, { authority: VAULT })])
    assert.deepEqual(B.paidOut(t, info), { sol: 1000n, usdc: 99n })
  },
})

Object.assign(tests, {
  'ipfs: links to public gateways and ipfs:// are read through our gateways, in order': async () => {
    assert.equal(V.ipfsPath('ipfs://bafyabc/meta.json'), 'bafyabc/meta.json')
    assert.equal(V.ipfsPath('https://ipfs.io/ipfs/bafyabc'), 'bafyabc')
    assert.equal(V.ipfsPath('https://dweb.link/ipfs/bafyabc'), 'bafyabc')
    assert.equal(V.ipfsPath('https://example.com/ipfs/bafyabc'), '')
    assert.equal(V.ipfsPath('ipfs://not a cid'), '')
    const real = globalThis.fetch, seen = []
    globalThis.fetch = async url => {
      seen.push(String(url))
      return String(url).startsWith(V.IPFS_GATEWAYS[0]) ? { ok: false, status: 429, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({ type262: { domain: 'x.com' } }) }
    }
    try {
      assert.deepEqual(await V.fetchJson('https://ipfs.io/ipfs/bafyabc'), { type262: { domain: 'x.com' } })
      assert.deepEqual(seen, [`${V.IPFS_GATEWAYS[0]}bafyabc`, `${V.IPFS_GATEWAYS[1]}bafyabc`], 'ipfs.io itself is never asked')
      seen.length = 0
      await V.fetchJson('https://example.com/meta.json')
      assert.deepEqual(seen, ['https://example.com/meta.json'], 'other links are read as they are')
    } finally { globalThis.fetch = real }
  },
})

// ---------- the board, against a mocked chain ----------

const realFetch = globalThis.fetch
const respond = body => ({ ok: true, status: 200, json: async () => body })
const tokenAccount = amount => { const b = Buffer.alloc(165); b.writeBigUInt64LE(BigInt(amount), 64); return b.toString('base64') }

Object.assign(tests, {
  'board: a memo alone puts nothing on the board; real deposits, balances and claims do': async () => {
    const GOOD_VAULT = addr('good vault'), FAKE_VAULT = addr('fake vault'), GAS = addr('gas')
    const goodUsdc = await sol.associatedTokenAddress(GOOD_VAULT, USDC)
    const vaults = { 'good.com': GOOD_VAULT, 'fake.com': FAKE_VAULT }
    const sigs = {
      [V.BOARD_REFERENCE]: [
        { signature: 'S_DEP', slot: 30, blockTime: 300, memo: '[28] TYPE/262 deposit good.com', err: null },
        { signature: 'S_FAKE', slot: 29, blockTime: 290, memo: '[28] TYPE/262 deposit fake.com', err: null },
        { signature: 'S_LAUNCH', slot: 28, blockTime: 280, memo: null, err: null },
        { signature: 'S_SPOOF', slot: 26, blockTime: 260, memo: null, err: null },
        { signature: 'S_FAILED', slot: 27, blockTime: 270, memo: '[28] TYPE/262 deposit good.com', err: { InstructionError: [0, 'Custom'] } },
      ],
      [GAS]: [{ signature: 'S_CLAIM', slot: 40, blockTime: 400, memo: '[22] type262:claim:good.com', err: null }],
    }
    const createTx = async (creator, uri) => {
      const ix = await V.createV2({ mint: addr(`mint ${uri}`), user: ALICE, creator, name: 'Good', symbol: 'GOOD', uri })
      return tx([{ programId: ix.programId, accounts: ix.keys.map(k => k.pubkey), data: sol.base58Encode(ix.data) }])
    }
    const txs = {
      S_LAUNCH: await createTx(GOOD_VAULT, 'https://ipfs.example/good.json'),
      S_SPOOF: await createTx(addr('someone else'), 'https://ipfs.example/spoof.json'), // claims good.com, creator isn't its vault
      S_DEP: tx([solIx(ALICE, GOOD_VAULT, 1_000_000_000), memoIx('TYPE/262 deposit good.com')]),
      S_FAKE: tx([solIx(ALICE, addr('elsewhere'), 1_000_000_000), memoIx('TYPE/262 deposit fake.com')]), // money went elsewhere
      S_CLAIM: tx([memoIx('type262:claim:good.com'), solIx(GOOD_VAULT, addr('owner'), 495_000_000), solIx(GOOD_VAULT, addr('fee'), 5_000_000)]),
    }
    const balances = { [GOOD_VAULT]: { lamports: 2_000_000_000, data: '' }, [goodUsdc]: { lamports: 2_039_280, data: tokenAccount(5_000000) } }
    globalThis.fetch = async (url, init = {}) => {
      url = String(url)
      if (url.includes('coinbase.com')) return respond({ data: { amount: '100' } })
      if (url.startsWith('https://ipfs.example/')) return respond({ name: 'Good', symbol: 'GOOD', type262: { domain: 'good.com' } })
      if (url.startsWith(`${V.WORKER_URL}/solana/vault`)) {
        const d = new URL(url).searchParams.get('domain')
        return respond({ domain: d, vault: vaults[d] })
      }
      if (url.startsWith(`${V.WORKER_URL}/solana/status`)) return respond({ ready: true, gasWallet: GAS, gasLamports: '1', feeWallet: GAS, feeBps: 50, refundDelayDays: 180 })
      const body = JSON.parse(init.body)
      const result = (() => {
        switch (body.method) {
          case 'getSignaturesForAddress': return sigs[body.params[0]] || []
          case 'getTransaction': return txs[body.params[0]] || null
          case 'getMultipleAccounts': return { value: body.params[0].map(a => (balances[a] ? { owner: SYSTEM, lamports: balances[a].lamports, data: [balances[a].data, 'base64'], executable: false } : null)) }
          case 'getMinimumBalanceForRentExemption': return 890_880
          case 'getProgramAccounts': return [] // pump.fun's coin list can't confirm it here: the verified launch counts
          default: throw new Error(`unexpected ${body.method}`)
        }
      })()
      return respond({ jsonrpc: '2.0', id: 1, result })
    }
    try {
      const { list, activity, price } = await B.solanaDomains()
      assert.equal(price, 100)
      assert.deepEqual(list.map(e => e.domain), ['good.com'], 'fake.com only had a memo, no money')
      const g = list[0]
      assert.equal(g.vault, GOOD_VAULT)
      assert.deepEqual(g.waiting, { sol: 2_000_000_000n, usdc: 5_000000n, fees: 0n })
      assert.equal(g.usd, 2 * 100 + 5)
      assert.equal(g.supporters.size, 1)
      assert.equal(g.deposits, 1)
      assert.equal(g.launches, 1, 'the real launch counts, the spoof does not')
      assert.equal(g.claims, 1)
      assert.deepEqual([g.first, g.last], [280, 400])
      assert.deepEqual(activity.map(e => `${e.kind}:${e.domain}`).sort(), ['claim:good.com', 'deposit:good.com', 'launch:good.com'])
      assert.equal(activity.find(e => e.kind === 'launch').signature, 'S_LAUNCH')
      assert.deepEqual(activity.find(e => e.kind === 'claim').paid, { sol: 500_000_000n, usdc: 0n })
    } finally {
      globalThis.fetch = realFetch
    }
  },
})

// ---------- the board: spoofing, a worker that is down, cost ----------

// Each test below starts after the caches of the one before have expired (board 30 s, status 60 s, coins 5 min).
const realNow = Date.now
let skew = 0
const later = () => { skew += 3_600_000; Date.now = () => realNow() + skew }
const launchTx = async (creator, uri) => {
  const ix = await V.createV2({ mint: addr(`mint ${uri}`), user: ALICE, creator, name: 'Coin', symbol: 'COIN', uri })
  return tx([{ programId: ix.programId, accounts: ix.keys.map(k => k.pubkey), data: sol.base58Encode(ix.data) }])
}
const curveAccount = (creator, quoteMint, creatorFee) => {
  const b = Buffer.alloc(166)
  b.set(V.DISC.bondingCurve, 0)
  b.set(sol.pubkeyBytes(creator), 49)
  b.set(sol.pubkeyBytes(quoteMint), 83)
  b.writeBigUInt64LE(BigInt(creatorFee), 125)
  return { pubkey: addr(`curve ${quoteMint} ${creatorFee}`), account: { data: [b.toString('base64'), 'base64'], owner: V.PUMP.program, lamports: 1, executable: false } }
}
const sig = (signature, slot, memo = null) => ({ signature, slot, blockTime: slot * 10, memo, err: null })

/**
 * Mocks the worker (vaults, status), Solana RPC, the price feed and metadata links; returns what was asked for.
 * `refuse` lists RPC methods that answer with an error.
 */
function mockChain({ vaultFor = () => undefined, gas = '', sigs = {}, txs = {}, balances = {}, accounts = {}, curves = {}, meta = {}, worker = true, refuse = [] }) {
  const calls = { vaults: 0, methods: {}, txs: {} }
  globalThis.fetch = async (url, init = {}) => {
    url = String(url)
    if (url.includes('coinbase.com')) return respond({ data: { amount: '100' } })
    if (meta[url]) return respond(meta[url])
    if (url.startsWith(`${V.WORKER_URL}/solana/`)) {
      if (!worker) throw new TypeError('fetch failed')
      if (url.includes('/solana/status')) return respond({ ready: true, gasWallet: gas, gasLamports: '1', feeWallet: gas, feeBps: 50, refundDelayDays: 180 })
      calls.vaults++
      const d = new URL(url).searchParams.get('domain')
      return respond({ domain: d, vault: vaultFor(d) })
    }
    const body = JSON.parse(init.body)
    const [first] = body.params
    calls.methods[body.method] = (calls.methods[body.method] || 0) + 1
    if (refuse.includes(body.method)) return respond({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: `${body.method} is not available` } })
    const account = a => accounts[a] || (balances[a] ? { owner: SYSTEM, lamports: balances[a].lamports, data: [balances[a].data || '', 'base64'], executable: false } : null)
    const result = (() => {
      switch (body.method) {
        case 'getSignaturesForAddress': return sigs[first] || []
        case 'getTransaction': calls.txs[first] = (calls.txs[first] || 0) + 1; return txs[first] || null
        case 'getMultipleAccounts': return { value: first.map(account) }
        case 'getAccountInfo': return { value: account(first) }
        case 'getTokenAccountsByOwner': return { value: [] }
        case 'getMinimumBalanceForRentExemption': return 890_880
        case 'getProgramAccounts': return curves[body.params[1].filters[1].memcmp.bytes] || []
        default: throw new Error(`unexpected ${body.method}`)
      }
    })()
    return respond({ jsonrpc: '2.0', id: 1, result })
  }
  return calls
}

Object.assign(tests, {
  'board: a claim or refund counts only if money left the vault; copies of the worker\'s memos do not': async () => {
    later()
    const VAULT_A = addr('refund vault'), GAS = addr('gas a'), BOB = addr('bob')
    mockChain({
      vaultFor: d => (d === 'refund.com' ? VAULT_A : undefined), gas: GAS,
      sigs: {
        [V.BOARD_REFERENCE]: [sig('A_DEP2', 11, '[27] TYPE/262 deposit refund.com'), sig('A_DEP1', 10, '[27] TYPE/262 deposit refund.com')],
        [GAS]: [
          sig('A_FAKE_CLAIM', 23, '[25] type262:claim:refund.com'),
          sig('A_FAKE_REFUND', 22, '[22] type262:refund:A_DEP2'),
          sig('A_REFUND', 21, '[22] type262:refund:A_DEP1'),
        ],
      },
      txs: {
        A_DEP1: tx([solIx(ALICE, VAULT_A, 1_000_000_000), memoIx('TYPE/262 deposit refund.com')]),
        A_DEP2: tx([solIx(BOB, VAULT_A, 2_000_000_000), memoIx('TYPE/262 deposit refund.com')]),
        A_REFUND: tx([memoIx('type262:refund:A_DEP1'), solIx(VAULT_A, ALICE, 1_000_000_000)]),
        A_FAKE_REFUND: tx([memoIx('type262:refund:A_DEP2'), solIx(BOB, GAS, 1)]), // anyone can write the memo
        A_FAKE_CLAIM: tx([memoIx('type262:claim:refund.com'), solIx(BOB, GAS, 1)]),
      },
      balances: { [VAULT_A]: { lamports: 2_000_000_000 } },
    })
    try {
      const { list, activity } = await B.solanaDomains()
      assert.deepEqual(activity.filter(e => e.kind === 'refund').map(e => [e.signature, e.amount, e.from]), [['A_REFUND', 1_000_000_000n, ALICE]])
      assert.deepEqual(activity.filter(e => e.kind === 'claim'), [], 'a claim memo that moved nothing out of the vault')
      assert.equal(list[0].claims, 0)
      assert.equal(list[0].supporters.size, 2)
    } finally {
      globalThis.fetch = realFetch
    }
  },
  'board: when the worker can\'t be reached the Solana side fails, instead of showing an empty board': async () => {
    later()
    mockChain({ worker: false, sigs: { [V.BOARD_REFERENCE]: [sig('B_DEP', 10, '[25] TYPE/262 deposit down.com')] } })
    try {
      await assert.rejects(B.solanaDomains(), /worker/)
      // an empty index is an empty board, not an error, even with the worker down
      later()
      mockChain({ worker: false })
      assert.deepEqual((await B.solanaDomains()).list, [])
    } finally {
      globalThis.fetch = realFetch
    }
  },
  'board: with only launches in the index, a worker that can\'t be reached is still an error': async () => {
    later()
    mockChain({
      worker: false,
      sigs: { [V.BOARD_REFERENCE]: [sig('G_LAUNCH', 10)] },
      txs: { G_LAUNCH: await launchTx(addr('launch-only vault'), 'https://ipfs.example/launch-only.json') },
      meta: { 'https://ipfs.example/launch-only.json': { type262: { domain: 'launch-only.com' } } },
    })
    try {
      await assert.rejects(B.solanaDomains(), /worker/)
    } finally {
      globalThis.fetch = realFetch
    }
  },
  'board: a transaction is read once; the next pass reads only the new ones': async () => {
    later()
    const VAULT_C = addr('once vault')
    const sigs = { [V.BOARD_REFERENCE]: [sig('C_DEP1', 10, '[25] TYPE/262 deposit once.com')] }
    const calls = mockChain({
      vaultFor: () => VAULT_C, sigs,
      txs: { C_DEP1: tx([solIx(ALICE, VAULT_C, 5)]), C_DEP2: tx([solIx(ALICE, VAULT_C, 7)]) },
      balances: { [VAULT_C]: { lamports: 12 } },
    })
    try {
      assert.equal((await B.solanaDomains()).list[0].deposits, 1)
      sigs[V.BOARD_REFERENCE].unshift(sig('C_DEP2', 11, '[25] TYPE/262 deposit once.com'))
      later()
      assert.equal((await B.solanaDomains()).list[0].deposits, 2)
      assert.deepEqual(calls.txs, { C_DEP1: 1, C_DEP2: 1 })
      assert.equal(calls.vaults, 1, 'the vault is asked for once')
    } finally {
      globalThis.fetch = realFetch
    }
  },
  'board: coins are counted with one getProgramAccounts per vault; fees on their curves and in PumpSwap\'s creator vault wait for the domain': async () => {
    later()
    const VAULT_D = addr('coins vault'), OTHER = addr('other creator')
    const creatorVault = await V.pumpPda.creatorVault(VAULT_D)
    const ammWsol = await V.ata(await V.pumpPda.ammCreatorVault(VAULT_D), V.WSOL) // graduated coins' fees, in wSOL
    const calls = mockChain({
      vaultFor: () => VAULT_D,
      sigs: { [V.BOARD_REFERENCE]: [sig('D_LAUNCH', 10)] },
      txs: { D_LAUNCH: await launchTx(VAULT_D, 'https://ipfs.example/coins.json') },
      meta: { 'https://ipfs.example/coins.json': { type262: { domain: 'coins.com' } } },
      balances: {
        [VAULT_D]: { lamports: 1_000_000_000 }, [creatorVault]: { lamports: 890_880 + 20_000_000 },
        [ammWsol]: { lamports: 2_039_280 + 3_000_000, data: tokenAccount(3_000_000) },
      },
      curves: {
        [VAULT_D]: [
          curveAccount(VAULT_D, V.WSOL, 10_000_000), curveAccount(VAULT_D, SYSTEM, 5_000_000),
          curveAccount(VAULT_D, USDC, 7), // fees in another quote token are not lamports: left out
          curveAccount(OTHER, V.WSOL, 99), // not this vault's coin
        ],
      },
    })
    try {
      const [d] = (await B.solanaDomains()).list
      assert.equal(d.domain, 'coins.com')
      assert.equal(d.launches, 3)
      assert.deepEqual(d.waiting, { sol: 1_000_000_000n, usdc: 0n, fees: 38_000_000n })
      assert.equal(d.usd, 1.038 * 100)
      assert.equal(calls.methods.getProgramAccounts, 1)
      assert.equal(calls.methods.getTokenAccountsByOwner, undefined, 'no reads per coin')
    } finally {
      globalThis.fetch = realFetch
    }
  },
  'board: memos naming hundreds of domains ask the worker for at most 150 vaults': async () => {
    later()
    const spam = Array.from({ length: 400 }, (_, i) => sig(`E_SPAM${i}`, 1000 - i, `[30] TYPE/262 deposit spam${i}.example.com`))
    const calls = mockChain({ vaultFor: d => addr(`vault ${d}`), sigs: { [V.BOARD_REFERENCE]: spam } })
    try {
      assert.deepEqual((await B.solanaDomains()).list, [], 'no money moved')
      assert.equal(calls.vaults, 150)
    } finally {
      globalThis.fetch = realFetch
    }
  },
  'profile: copies of the worker\'s claim and refund memos on a vault\'s history are not claims or refunds': async () => {
    later()
    const VAULT_F = addr('profile vault'), BOB = addr('bob')
    mockChain({
      vaultFor: () => VAULT_F,
      sigs: {
        [VAULT_F]: [
          sig('F_FAKE_CLAIM', 15, '[25] type262:claim:profile.com'),
          sig('F_FAKE_REFUND', 14, '[22] type262:refund:F_DEP'),
          sig('F_CLAIM', 13, '[25] type262:claim:profile.com'),
          sig('F_REFUND', 12, '[22] type262:refund:F_DEP'),
          sig('F_DEP', 11),
        ],
      },
      txs: {
        F_FAKE_CLAIM: tx([memoIx('type262:claim:profile.com'), solIx(BOB, VAULT_F, 1)]),
        F_FAKE_REFUND: tx([memoIx('type262:refund:F_DEP'), solIx(BOB, VAULT_F, 1)]),
        F_CLAIM: tx([memoIx('type262:claim:profile.com'), solIx(VAULT_F, addr('owner'), 990), solIx(VAULT_F, addr('fee'), 10)]),
        F_REFUND: tx([memoIx('type262:refund:F_DEP'), solIx(VAULT_F, ALICE, 500)]),
        F_DEP: tx([solIx(ALICE, VAULT_F, 500)]),
      },
      balances: { [VAULT_F]: { lamports: 3_000 } },
    })
    try {
      const p = await B.solanaProfile('profile.com')
      assert.deepEqual(p.activity.map(e => `${e.kind}:${e.signature}`), ['claim:F_CLAIM', 'refund:F_REFUND', 'deposit:F_DEP'])
      assert.deepEqual(p.claimed, { sol: 1000n, usdc: 0n })
      assert.deepEqual(p.waiting, { sol: 3_000n, usdc: 0n, fees: 0n })
      assert.deepEqual([p.coins, p.coinsRead], [[], true], 'no coins, and that is known')
    } finally {
      globalThis.fetch = realFetch
    }
  },
  'profile: coins that couldn\'t be read are not "no coins"': async () => {
    later()
    const VAULT_H = addr('unread coins vault')
    mockChain({ vaultFor: () => VAULT_H, balances: { [VAULT_H]: { lamports: 5 } }, refuse: ['getProgramAccounts'] })
    try {
      const p = await B.solanaProfile('unread-coins.com')
      assert.deepEqual([p.coins, p.coinsRead], [[], false])
      assert.equal(p.waiting.sol, 5n, 'the rest of the profile still reads')
    } finally {
      globalThis.fetch = realFetch
    }
  },
})

// ---------- across both chains ----------

const DEPOSITED = '0x3b9785af609e7e94f3a27a1805ad1eb3019ef356c7ab459724d5b8892788df3e'
const hex32 = v => BigInt(v).toString(16).padStart(64, '0')
const depositLog = (domain, block, from, amount) => {
  const bytes = Buffer.from(domain).toString('hex')
  return {
    topics: [DEPOSITED, `0x${'ab'.repeat(32)}`, `0x${hex32(BigInt(R.CHAIN.usdg))}`, `0x${hex32(BigInt(from))}`],
    data: `0x${hex32(64)}${hex32(amount)}${hex32(bytes.length / 2)}${bytes.padEnd(Math.ceil(bytes.length / 64) * 64, '0')}`,
    blockNumber: `0x${block.toString(16)}`, transactionHash: `0x${hex32(block)}`, logIndex: '0x0',
  }
}
/** Mocks Robinhood Chain's RPC (blocks have time 2 × number) and fails every Solana read; returns the blocks asked for. */
function mockRobinhood({ logs = [], dropBlocks = new Set() }) {
  const asked = []
  globalThis.fetch = async (url, init = {}) => {
    url = String(url)
    if (url.includes('coinbase.com')) return respond({ data: { amount: '100' } })
    const body = JSON.parse(init.body)
    if (!Array.isArray(body)) {
      if (body.method === 'eth_blockNumber') return respond({ jsonrpc: '2.0', id: 1, result: '0x1000' })
      if (body.method === 'eth_getLogs') return respond({ jsonrpc: '2.0', id: 1, result: body.params[0].topics[0] === DEPOSITED ? logs : [] })
      return respond({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'Solana is down in this test' } })
    }
    return respond(body.map(c => {
      if (c.method === 'eth_call') return { jsonrpc: '2.0', id: c.id, result: c.id % 2 ? '0x0' : `0x${hex32(5_000_000)}` } // 5 USDG, no ETH
      const block = parseInt(c.params[0], 16)
      asked.push(block)
      return { jsonrpc: '2.0', id: c.id, result: dropBlocks.has(block) ? null : { timestamp: `0x${(block * 2).toString(16)}` } }
    }))
  }
  return asked
}

Object.assign(tests, {
  'robinhood: a block whose time couldn\'t be read is asked again, not kept as 0': async () => {
    later()
    const asked = mockRobinhood({ dropBlocks: new Set([16]) })
    try {
      assert.equal((await R.blockTimes([16, 17])).get(16), undefined)
      mockRobinhood({})
      const times = await R.blockTimes([16, 17])
      assert.deepEqual([times.get(16), times.get(17)], [32, 34])
      assert.deepEqual(asked, [16, 17])
    } finally {
      globalThis.fetch = realFetch
    }
  },
  'both chains: money only on Robinhood Chain shows with Solana down; only the newest events are given a time': async () => {
    later()
    const FROM = '0x2222222222222222222222222222222222222222'
    const asked = mockRobinhood({ logs: Array.from({ length: 60 }, (_, i) => depositLog('rh-only.com', 1000 + i, FROM, 1_000_000)) })
    try {
      const { list, activity, totals, errors } = await boardData()
      assert.ok(errors.solana && !errors.robinhood)
      assert.equal(list.length, 1)
      const [e] = list
      assert.deepEqual([e.domain, e.sol, e.usd, e.supporters, e.first, e.last], ['rh-only.com', null, 5, 1, 2000, 2118])
      assert.deepEqual(e.rh.waiting, { usdg: 5_000_000n, eth: 0n })
      assert.deepEqual(totals, { usd: 5, sites: 1, supporters: 1, claimed: 0 })
      // the 50 newest deposits and the domain's first block, not all 60
      assert.equal(new Set(asked).size, 51)
      assert.equal(activity[0].time, 2118)
      assert.equal(activity.filter(x => !x.time).length, 9)
    } finally {
      globalThis.fetch = realFetch
    }
  },
  // after the test above: the board keeps each chain's last good read for the rest of the page
  'both chains: a refresh that fails on one chain keeps that chain\'s last good read': async () => {
    later()
    const VAULT_K = addr('kept vault')
    mockChain({
      vaultFor: () => VAULT_K,
      sigs: { [V.BOARD_REFERENCE]: [sig('K_DEP', 10, '[25] TYPE/262 deposit kept.com')] },
      txs: { K_DEP: tx([solIx(ALICE, VAULT_K, 1_000_000_000)]) },
      balances: { [VAULT_K]: { lamports: 1_000_000_000 } },
    })
    try {
      const first = await boardData()
      assert.equal(first.errors.solana, null)
      assert.ok(first.list.some(e => e.domain === 'kept.com'))
      later()
      mockRobinhood({}) // Solana fails on this pass, Robinhood Chain answers
      const { list, errors } = await boardData()
      assert.equal(errors.solana, null, 'Solana was read on this page')
      const kept = list.find(e => e.domain === 'kept.com')
      assert.ok(kept, 'its domains stay on the board')
      assert.equal(kept.sol.waiting.sol, 1_000_000_000n)
    } finally {
      globalThis.fetch = realFetch
    }
  },
})

// ---------- the explorer ----------

/** A bonding curve's account: reserves for a 30 SOL market cap, half sold, or graduated. */
const curveState = (creator, complete = false) => {
  const b = Buffer.alloc(166)
  b.set(V.DISC.bondingCurve, 0)
  b.writeBigUInt64LE(1_000_000_000_000_000n, 8) // virtual token reserves
  b.writeBigUInt64LE(30_000_000_000n, 16) // virtual SOL reserves
  b.writeBigUInt64LE(complete ? 0n : 396_550_000_000_000n, 24) // real token reserves: half of the 793.1M for sale
  b.writeBigUInt64LE(1_000_000_000_000_000n, 40) // supply
  b[48] = complete ? 1 : 0
  b.set(sol.pubkeyBytes(creator), 49)
  b.set(sol.pubkeyBytes(V.WSOL), 83)
  return { owner: V.PUMP.program, lamports: 1, data: [b.toString('base64'), 'base64'], executable: false }
}

Object.assign(tests, {
  "explore: the coins launched here, newest first, with market cap and progress; a coin whose creator is not the named domain's vault is left out": async () => {
    later()
    const VAULT_E = addr('explore vault')
    const uri = n => `https://ipfs.example/explore-${n}.json`
    const mint = n => addr(`mint ${uri(n)}`)
    mockChain({
      vaultFor: d => (d === 'explore.com' ? VAULT_E : undefined),
      sigs: { [V.BOARD_REFERENCE]: [sig('E_NEW', 30), sig('E_SPOOF', 20), sig('E_DEP', 15, '[27] TYPE/262 deposit explore.com'), sig('E_OLD', 10)] },
      txs: {
        E_NEW: await launchTx(VAULT_E, uri('new')),
        E_SPOOF: await launchTx(addr('someone else'), uri('spoof')), // its metadata names explore.com, but the fees go elsewhere
        E_OLD: await launchTx(VAULT_E, uri('old')),
      },
      meta: Object.fromEntries(['new', 'spoof', 'old'].map(n => [uri(n), { type262: { domain: 'explore.com' } }])),
      accounts: {
        [await V.pumpPda.bondingCurve(mint('new'))]: curveState(VAULT_E),
        [await V.pumpPda.bondingCurve(mint('old'))]: curveState(VAULT_E, true),
      },
    })
    try {
      const { coins, capped } = await B.launchedCoins()
      assert.deepEqual(coins.map(c => c.mint), [mint('new'), mint('old')], 'newest first, the spoof and the deposit left out')
      const [n, o] = coins
      assert.equal(n.domain, 'explore.com')
      assert.equal(n.time, 300)
      assert.equal(n.signature, 'E_NEW')
      assert.equal(n.name, 'Coin', 'the name from the launch when the mint carries none')
      assert.equal(n.uri, uri('new'), 'and the metadata link, for the image')
      assert.equal(n.mcap, 30_000_000_000n)
      assert.equal(n.progress, 0.5)
      assert.equal(n.complete, false)
      assert.equal(o.complete, true)
      assert.equal(o.progress, 1)
      assert.equal(capped, false)
      assert.equal(await B.launchedCoins(), await B.launchedCoins(), 'kept for 30 s')
    } finally {
      globalThis.fetch = realFetch
    }
  },
  "explore: when the worker can't be reached, the launches are an error, not an empty list": async () => {
    later()
    mockChain({
      worker: false,
      sigs: { [V.BOARD_REFERENCE]: [sig('F_LAUNCH', 10)] },
      txs: { F_LAUNCH: await launchTx(addr('down vault'), 'https://ipfs.example/explore-down.json') },
      meta: { 'https://ipfs.example/explore-down.json': { type262: { domain: 'explore-down.com' } } },
    })
    try {
      await assert.rejects(B.launchedCoins(), /worker/)
    } finally {
      globalThis.fetch = realFetch
    }
  },
})

run()
