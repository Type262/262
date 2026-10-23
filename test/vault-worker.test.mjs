// Tests for the vault worker (upload/worker.mjs) against a mocked Solana RPC and stub DNS resolvers: every
// transaction it sends is decoded and checked (instructions, amounts, memos, signatures by the derived keys), plus
// the lock, gas checks, refund rules, retries and priority fees. Offline. Run: node test/vault-worker.test.mjs
// (solana/scripts/vault-e2e.mjs runs the same worker against a real validator with pump.fun.)
import assert from 'node:assert/strict'
import { createHash, createPublicKey, verify } from 'node:crypto'
import { ATA_PROGRAM, SYSTEM, TOKEN, TOKEN_2022, ata, b58decode, b58encode } from '../upload/pump.mjs'
import { COMPUTE_BUDGET, MEMO_PROGRAM, execute, priorityFee, systemTransfer } from '../upload/chain.mjs'
import { createWorker } from '../upload/worker.mjs'
import { gasKeypair, vaultKeypair } from '../upload/vault.mjs'

const MASTER = Buffer.from([...Array(32).keys()]) // throwaway, used only here
const MASTER_HEX = MASTER.toString('hex')
const DOMAIN = 'example.com'
const VAULT = vaultKeypair(MASTER, DOMAIN).address
const GAS = gasKeypair(MASTER).address
const addr = label => b58encode(createHash('sha256').update(label).digest())
const OWNER = addr('owner')
const FEE = addr('fee wallet')
const ALICE = addr('alice')
const USDC = addr('usdc')
const COIN = addr('coin')
const RENT0 = 890_880n
const RENT165 = 2_039_280n
const DAY = 86_400
const RESOLVERS = ['https://cf.test/dns-query', 'https://g.test/resolve']
const SECRETS = [MASTER_HEX, '49f25787286ede4d3e25d2607ce2094eddd62ff8bebe924bb43d61644fe150e2', '03cdead0442882be0d87eb7dc9d1390a18fff25eaf06be58d664d15845f0af33']

// ---------- decoding what the worker sends ----------

function decode(b64) {
  const b = Buffer.from(b64, 'base64')
  let o = 0
  const vec = () => { let n = 0; for (let s = 0; ; s += 7) { const x = b[o++]; n |= (x & 0x7f) << s; if (!(x & 0x80)) return n } }
  const sigs = Array.from({ length: vec() }, () => { const s = b.subarray(o, o + 64); o += 64; return s })
  const message = b.subarray(o)
  const header = [...b.subarray(o, o + 3)]; o += 3
  const keys = Array.from({ length: vec() }, () => { const k = b58encode(b.subarray(o, o + 32)); o += 32; return k })
  o += 32
  const ixs = Array.from({ length: vec() }, () => {
    const program = keys[b[o++]]
    const accounts = Array.from({ length: vec() }, () => keys[b[o++]])
    const len = vec()
    const data = b.subarray(o, o + len); o += len
    return { program, accounts, data }
  })
  return { sigs, header, keys, message, ixs, signers: keys.slice(0, header[0]) }
}

/** The instructions in words, compute budget left out. */
function read(tx) {
  return tx.ixs.filter(ix => ix.program !== COMPUTE_BUDGET).map(({ program, accounts: a, data: d }) => {
    if (program === SYSTEM && d.readUInt32LE(0) === 2) return ['transfer', a[0], a[1], d.readBigUInt64LE(4)]
    if (program === MEMO_PROGRAM) return ['memo', d.toString()]
    if (program === ATA_PROGRAM) return ['create ata', a[2], a[3], a[5]]
    if ((program === TOKEN || program === TOKEN_2022) && d[0] === 12) return ['transferChecked', a[0], a[2], d.readBigUInt64LE(1), d[9], program]
    if ((program === TOKEN || program === TOKEN_2022) && d[0] === 9) return ['close', a[0], a[1]]
    return ['other', program]
  })
}
const priceOf = tx => tx.ixs.filter(ix => ix.program === COMPUTE_BUDGET && ix.data[0] === 3).map(ix => ix.data.readBigUInt64LE(1))[0]

function signedBy(tx) {
  return tx.signers.every((s, i) => verify(null, tx.message, createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: b58decode(s).toString('base64url') }, format: 'jwk' }), tx.sigs[i]))
}

// ---------- a mocked chain ----------

function chain({ lamports = {}, accounts = {}, tokens = {}, txs = {}, history = [], program = () => [], status = () => ({ confirmationStatus: 'confirmed', slot: 50, err: null }), blockHeight = () => 10, fees = [] } = {}) {
  const sent = []
  const calls = []
  const bal = a => BigInt(lamports[a] ?? 0)
  const rpc = async (method, params) => {
    calls.push(method)
    switch (method) {
      case 'getBalance': return { context: { slot: 1 }, value: Number(bal(params[0])) }
      case 'getAccountInfo': return { context: { slot: 1 }, value: accounts[params[0]] ?? (bal(params[0]) ? { owner: SYSTEM, executable: false, lamports: Number(bal(params[0])), data: ['', 'base64'], space: 0 } : null) }
      case 'getMultipleAccounts': return { context: { slot: 1 }, value: params[0].map(a => accounts[a] ?? null) }
      case 'getTokenAccountsByOwner': return { context: { slot: 1 }, value: (tokens[params[0]] || []).filter(t => t.program === params[1].programId).map(t => ({ pubkey: t.address, account: { lamports: Number(t.lamports ?? RENT165), owner: t.program, data: { program: 'spl-token', parsed: { type: 'account', info: t.info } } } })) }
      case 'getProgramAccounts': return program(params)
      case 'getMinimumBalanceForRentExemption': return Number(params[0] === 0 ? RENT0 : params[0] === 165 ? RENT165 : 3_000_000n)
      case 'getLatestBlockhash': return { context: { slot: 1 }, value: { blockhash: b58encode(createHash('sha256').update(`bh${sent.length}`).digest()), lastValidBlockHeight: 100 } }
      case 'getRecentPrioritizationFees': return fees
      case 'simulateTransaction': {
        // System transfers and token account closes: enough for the watched vault balance.
        const tx = decode(params[0])
        const post = new Map()
        const tokenLamports = a => BigInt(Object.values(tokens).flat().find(t => t.address === a)?.lamports ?? RENT165)
        const get = a => (post.has(a) ? post.get(a) : bal(a))
        for (const [kind, from, to, n] of read(tx)) {
          if (kind === 'transfer') { post.set(from, get(from) - n); post.set(to, get(to) + n) }
          if (kind === 'close') post.set(to, get(to) + tokenLamports(from))
        }
        const watch = params[1].accounts ? params[1].accounts.addresses : []
        return { context: { slot: 1 }, value: { err: null, logs: [], unitsConsumed: 40_000, accounts: watch.map(a => ({ lamports: Number(get(a)), owner: SYSTEM, data: ['', 'base64'] })) } }
      }
      case 'sendTransaction': { const tx = decode(params[0]); sent.push(tx); return b58encode(tx.sigs[0]) }
      case 'getSignatureStatuses': return { context: { slot: 1 }, value: params[0].map(s => status(s, sent)) }
      case 'getBlockHeight': return blockHeight(sent)
      case 'getTransaction': return txs[params[0]] ?? null
      case 'getSignaturesForAddress': return params[0] === VAULT ? history : []
      default: throw new Error(`mock: ${method}`)
    }
  }
  return { rpc, sent, calls, accounts }
}

/** Stub DNS-over-HTTPS: both resolvers publish `SOL <wallet>` at _wallet.<domain>, DNSSEC-validated, unless told otherwise. */
function dnsFetch(wallets = { [DOMAIN]: OWNER }, { ad = [true, true], delay } = {}) {
  return async url => {
    if (delay) await delay
    const u = new URL(url)
    const i = RESOLVERS.findIndex(r => url.startsWith(r))
    const name = u.searchParams.get('name')
    const type = Number(u.searchParams.get('type'))
    const w = type === 16 && name.startsWith('_wallet.') ? wallets[name.slice(8)] : null
    const body = { Status: 0, AD: ad[i], ...(w ? { Answer: [{ name, type, data: `"SOL ${w}"` }] } : {}) }
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/dns-json' } })
  }
}

const ENV = { VAULT_MASTER_SEED: MASTER_HEX, SOLANA_FEE_WALLET: FEE, FEE_BPS: '50', REFUND_DELAY_DAYS: '180', DOH_RESOLVERS: RESOLVERS.join(','), SOLANA_USDC_MINT: USDC, PRIORITY_FEE_MIN: '20000' }
const logs = []
const make = (mock, { fetch = dnsFetch(), env = {}, now } = {}) => createWorker({ env: { ...ENV, ...env }, rpc: mock.rpc, fetch, log: m => logs.push(m), pollMs: 1, ...(now ? { now } : {}) })
const fails = async (p, status, error) => {
  const err = await p.then(() => null, e => e)
  assert.ok(err && err.refusal, `expected a refusal, got ${err && err.stack}`)
  assert.deepEqual([err.status, err.error], [status, error], err.reason)
  return err
}
const clean = obj => { const s = JSON.stringify(obj); for (const x of SECRETS) assert.ok(!s.includes(x), 'a secret in an answer'); return obj }

const tokenAccount = (address, mint, amount, { program = TOKEN, decimals = 6, state = 'initialized', isNative = false, extensions } = {}) => ({
  address, program, info: { mint, owner: VAULT, state, isNative, tokenAmount: { amount: String(amount), decimals }, ...(extensions ? { extensions } : {}) },
})

const tests = {
  'claim: all of the vault\'s SOL to the published wallet, 0.5% to the fee wallet, one memo, signed by gas + vault': async () => {
    const m = chain({ lamports: { [VAULT]: 2_000_000_000n, [GAS]: SOL(1), [FEE]: SOL(5) } })
    const r = clean(await make(m).claim('Example.COM'))
    assert.deepEqual([r.domain, r.wallet, r.vault, r.collected], [DOMAIN, OWNER, VAULT, []])
    assert.deepEqual(r.payouts, [{ mint: 'SOL', amount: '1990000000', fee: '10000000', decimals: 9, program: SYSTEM, signature: r.signatures[0] }])
    assert.equal(m.sent.length, 1)
    const tx = m.sent[0]
    assert.deepEqual(tx.signers, [GAS, VAULT])
    assert.ok(signedBy(tx), 'signatures verify against the derived gas and vault keys')
    assert.deepEqual(read(tx), [['memo', `type262:claim:${DOMAIN}`], ['transfer', VAULT, OWNER, 1_990_000_000n], ['transfer', VAULT, FEE, 10_000_000n]])
    assert.ok(!('skipped' in r))
  },
  'claim: a payout below the rent minimum to new accounts: the gas wallet adds what they lack': async () => {
    const m = chain({ lamports: { [VAULT]: RENT0, [GAS]: SOL(1) } })
    const r = await make(m).claim(DOMAIN)
    const fee = RENT0 * 50n / 10_000n
    assert.deepEqual(read(m.sent[0]), [
      ['transfer', GAS, OWNER, fee], ['transfer', GAS, FEE, RENT0 - fee],
      ['memo', `type262:claim:${DOMAIN}`], ['transfer', VAULT, OWNER, RENT0 - fee], ['transfer', VAULT, FEE, fee],
    ])
    assert.equal(r.payouts[0].amount, String(RENT0 - fee))
  },
  'claim: every token, USDC first; fee per asset; owner and fee accounts created; vault accounts closed to the gas wallet': async () => {
    const usdcAcc = addr('vault usdc'), coinAcc = addr('vault coin'), emptyAcc = addr('vault empty'), frozenAcc = addr('vault frozen')
    const m = chain({
      lamports: { [GAS]: SOL(1), [FEE]: SOL(1) },
      tokens: { [VAULT]: [
        tokenAccount(coinAcc, COIN, 5_000_000_000_000, { program: TOKEN_2022 }), tokenAccount(usdcAcc, USDC, 1000_000000),
        tokenAccount(emptyAcc, addr('old'), 0), tokenAccount(frozenAcc, addr('frozen'), 7, { state: 'frozen' }),
        tokenAccount(addr('dust acc'), addr('dust'), 150, { program: TOKEN_2022 }),
      ] },
    })
    const r = await make(m).claim(DOMAIN)
    assert.deepEqual(r.payouts.map(p => [p.mint, p.amount, p.fee, p.program]), [
      [USDC, '995000000', '5000000', TOKEN], [COIN, '4975000000000', '25000000000', TOKEN_2022], [addr('dust'), '150', '0', TOKEN_2022],
    ])
    assert.deepEqual(r.skipped, [{ mint: addr('frozen'), reason: 'The token\'s issuer has frozen it in the vault.' }])
    const [usdcTx, coinTx, dustTx, closeTx] = m.sent
    assert.deepEqual(read(usdcTx), [
      ['create ata', OWNER, USDC, TOKEN], ['create ata', FEE, USDC, TOKEN], ['memo', `type262:claim:${DOMAIN}`],
      ['transferChecked', usdcAcc, ata(OWNER, USDC, TOKEN), 995_000000n, 6, TOKEN], ['transferChecked', usdcAcc, ata(FEE, USDC, TOKEN), 5_000000n, 6, TOKEN],
      ['close', usdcAcc, GAS],
    ])
    assert.deepEqual(read(coinTx).map(x => x.slice(0, 4)), [
      ['create ata', OWNER, COIN, TOKEN_2022], ['create ata', FEE, COIN, TOKEN_2022], ['memo', `type262:claim:${DOMAIN}`],
      ['transferChecked', coinAcc, ata(OWNER, COIN, TOKEN_2022), 4_975_000_000_000n], ['transferChecked', coinAcc, ata(FEE, COIN, TOKEN_2022), 25_000_000_000n], ['close', coinAcc, GAS],
    ])
    // A fee that rounds to 0 opens no account for the fee wallet.
    assert.deepEqual(read(dustTx).map(x => x[0]), ['create ata', 'memo', 'transferChecked', 'close'])
    assert.deepEqual(read(closeTx), [['memo', `type262:claim:${DOMAIN}`], ['close', emptyAcc, GAS]])
    assert.ok(m.sent.every(signedBy) && m.sent.every(t => t.signers.join() === `${GAS},${VAULT}`))
  },
  'claim: WSOL in the vault is unwrapped into the SOL payout; its rent goes to the gas wallet': async () => {
    const wsol = addr('vault wsol')
    const native = tokenAccount(wsol, 'So11111111111111111111111111111111111111112', 500_000_000, { isNative: true, decimals: 9 })
    native.lamports = 500_000_000n + RENT165
    native.info.rentExemptReserve = { amount: String(RENT165) }
    const m = chain({ lamports: { [VAULT]: SOL(1), [GAS]: SOL(1), [FEE]: SOL(1), [OWNER]: SOL(1) }, tokens: { [VAULT]: [native] } })
    const r = await make(m).claim(DOMAIN)
    const base = SOL(1) + 500_000_000n
    const fee = base * 50n / 10_000n
    assert.deepEqual(r.payouts.map(p => [p.mint, p.amount, p.fee]), [['SOL', String(base - fee), String(fee)]])
    assert.deepEqual(read(m.sent[0]), [['close', wsol, VAULT], ['transfer', VAULT, GAS, RENT165], ['memo', `type262:claim:${DOMAIN}`], ['transfer', VAULT, OWNER, base - fee], ['transfer', VAULT, FEE, fee]])
  },
  'claim: refused before anything is sent when DNS or the wallet does not check out': async () => {
    const m = chain({ lamports: { [VAULT]: SOL(1), [GAS]: SOL(1) }, accounts: { [OWNER]: { owner: TOKEN, executable: false, lamports: 1, data: [Buffer.alloc(165).toString('base64'), 'base64'] } } })
    await fails(make(m, { fetch: dnsFetch({}) }).claim(DOMAIN), 422, 'No SOL wallet in DNS')
    await fails(make(m, { fetch: dnsFetch(undefined, { ad: [true, false] }) }).claim(DOMAIN), 422, 'DNS check failed')
    await fails(make(m).claim(DOMAIN), 422, 'Bad SOL record')
    await fails(make(m, { fetch: dnsFetch({ [DOMAIN]: VAULT }) }).claim(DOMAIN), 422, 'Bad SOL record')
    await fails(make(m, { fetch: async () => { throw new Error('offline') } }).claim(DOMAIN), 502, 'DNS check failed')
    await fails(make(m).claim('not a domain'), 400, 'Bad domain')
    assert.equal(m.sent.length, 0)
  },
  'claim: nothing in the vault is a plain refusal': async () => {
    const m = chain({ lamports: { [GAS]: SOL(1) } })
    await fails(make(m).claim(DOMAIN), 409, 'Nothing to claim')
    assert.equal(m.sent.length, 0)
  },
  'claim: a gas wallet too low to pay is refused with its address and nothing sent': async () => {
    const m = chain({ lamports: { [VAULT]: SOL(1), [GAS]: 10_000n } })
    const err = await fails(make(m).claim(DOMAIN), 503, 'Out of gas')
    assert.match(err.reason, new RegExp(GAS))
    assert.equal(m.sent.length, 0)
  },
  'claim: one at a time per domain': async () => {
    let release
    const gate = new Promise(r => (release = r))
    const m = chain({ lamports: { [VAULT]: SOL(1), [GAS]: SOL(1), [FEE]: SOL(1) } })
    const w = make(m, { fetch: dnsFetch(undefined, { delay: gate }) })
    const first = w.claim(DOMAIN)
    await fails(w.claim('EXAMPLE.com'), 409, 'Busy')
    await fails(w.refund(DOMAIN, b58encode(Buffer.alloc(64, 1))), 409, 'Busy')
    release()
    assert.equal((await first).payouts.length, 1)
    // other domains are not held up
    assert.equal(make(chain()).vault('example.org').domain, 'example.org')
  },
  'claim: the per-domain lock is released after a refusal': async () => {
    const m = chain({ lamports: { [GAS]: SOL(1) } })
    const w = make(m)
    await fails(w.claim(DOMAIN), 409, 'Nothing to claim')
    await fails(w.claim(DOMAIN), 409, 'Nothing to claim')
  },
  'claim: an expired transaction is rebuilt from fresh state at a higher priority fee': async () => {
    const m = chain({
      lamports: { [VAULT]: SOL(1), [GAS]: SOL(1), [FEE]: SOL(1) },
      status: (sig, sent) => (sent.length > 1 && sig === b58encode(sent[1].sigs[0]) ? { confirmationStatus: 'confirmed', slot: 60, err: null } : null),
      blockHeight: sent => (sent.length === 1 ? 500 : 10),
    })
    const r = await make(m).claim(DOMAIN)
    assert.equal(m.sent.length, 2)
    assert.notEqual(b58encode(m.sent[0].sigs[0]), b58encode(m.sent[1].sigs[0]))
    assert.equal(priceOf(m.sent[1]), priceOf(m.sent[0]) * 2n)
    assert.deepEqual(r.signatures, [b58encode(m.sent[1].sigs[0])])
  },
  'collect: an RPC that can\'t list pump.fun coins gets a clear reason': async () => {
    const m = chain({ program: () => { throw Object.assign(new Error('getProgramAccounts: excluded from account secondary indexes'), { rpc: true }) } })
    const err = await fails(make(m).collect(DOMAIN), 502, 'Collect failed')
    assert.match(err.reason, /SOLANA_RPC_URL/)
  },
  'status and vault: no secrets, settings as configured; vault() needs only the master secret': async () => {
    const m = chain({ lamports: { [GAS]: 123_456_789n } })
    const s = clean(await make(m).status())
    assert.deepEqual(s, { ready: true, gasWallet: GAS, gasLamports: '123456789', feeWallet: FEE, feeBps: 50, refundDelayDays: 180 })
    const v = clean(make(m).vault('https://Example.com/x'))
    assert.deepEqual(v, { domain: DOMAIN, vault: VAULT, usdcAccount: ata(VAULT, USDC, TOKEN) })
    const half = make(m, { env: { SOLANA_FEE_WALLET: '' } })
    assert.equal(half.ready, false)
    assert.deepEqual(half.problems, ['SOLANA_FEE_WALLET is not set'])
    assert.equal(half.vault(DOMAIN).vault, VAULT)
    await fails(half.claim(DOMAIN), 503, 'Not set up')
    const none = make(m, { env: { VAULT_MASTER_SEED: 'zz' } })
    assert.ok(none.problems.every(p => !p.includes('zz')))
    assert.throws(() => none.vault(DOMAIN), e => e.status === 503)
    assert.deepEqual(make(m, { env: { FEE_BPS: '5000' } }).problems, ['FEE_BPS must be a whole number from 0 to 1000'])
  },
}

// ---------- refunds ----------

const DEPOSIT = b58encode(Buffer.alloc(64, 7))
const T0 = 1_760_000_000
const depositTx = ({ from = ALICE, amount = 300_000_000, slot = 40, blockTime = T0 } = {}) => ({
  slot, blockTime, meta: { err: null, innerInstructions: [], preTokenBalances: [], postTokenBalances: [] },
  transaction: { message: { accountKeys: [{ pubkey: from, signer: true }, { pubkey: VAULT, signer: false }, { pubkey: SYSTEM, signer: false }], instructions: [{ program: 'system', programId: SYSTEM, parsed: { type: 'transfer', info: { source: from, destination: VAULT, lamports: amount } } }] } },
})
const memoTx = (text, signers) => ({
  slot: 45, blockTime: T0 + 10, meta: { err: null, innerInstructions: [] },
  transaction: { message: { accountKeys: signers.map(pubkey => ({ pubkey, signer: true })), instructions: [{ program: 'spl-memo', programId: MEMO_PROGRAM, parsed: text }] } },
})
const entry = (signature, slot, memo) => ({ signature, slot, err: null, memo, blockTime: T0 })
const after = days => () => (T0 + days * DAY) * 1000

Object.assign(tests, {
  'refund: too early, with the date it opens': async () => {
    const m = chain({ txs: { [DEPOSIT]: depositTx() }, lamports: { [VAULT]: 300_000_000n, [GAS]: SOL(1) } })
    const err = await fails(make(m, { now: after(179) }).refund(DOMAIN, DEPOSIT), 422, 'Too early')
    assert.match(err.reason, /180 days/)
    assert.match(err.reason, new RegExp(new Date((T0 + 180 * DAY) * 1000).toISOString().slice(0, 10)))
    assert.equal(m.sent.length, 0)
  },
  'refund: after the delay, the deposit back to its sender with the refund memo; the gas wallet pays': async () => {
    const m = chain({ txs: { [DEPOSIT]: depositTx() }, history: [entry(DEPOSIT, 40, null)], lamports: { [VAULT]: 300_000_000n, [GAS]: SOL(1), [ALICE]: SOL(1) } })
    const r = clean(await make(m, { now: after(181) }).refund(DOMAIN, DEPOSIT))
    assert.deepEqual(r, { domain: DOMAIN, refunded: { mint: 'SOL', amount: '300000000', decimals: 9, to: ALICE }, signature: b58encode(m.sent[0].sigs[0]) })
    assert.deepEqual(read(m.sent[0]), [['memo', `type262:refund:${DEPOSIT}`], ['transfer', VAULT, ALICE, 300_000_000n]])
    assert.ok(signedBy(m.sent[0]) && m.sent[0].signers.join() === `${GAS},${VAULT}`)
  },
  'refund: refused once the domain was claimed since the deposit (the vault signed the claim)': async () => {
    const claim = b58encode(Buffer.alloc(64, 8))
    const m = chain({
      txs: { [DEPOSIT]: depositTx(), [claim]: memoTx(`type262:claim:${DOMAIN}`, [GAS, VAULT]) },
      history: [entry(claim, 45, `[25] type262:claim:${DOMAIN}`), entry(DEPOSIT, 40, null)], lamports: { [VAULT]: 300_000_000n, [GAS]: SOL(1) },
    })
    await fails(make(m, { now: after(181) }).refund(DOMAIN, DEPOSIT), 422, 'Already claimed')
    // a claim in the deposit's own slot counts as after it
    const same = chain({ txs: { [DEPOSIT]: depositTx(), [claim]: memoTx(`type262:claim:${DOMAIN}`, [GAS, VAULT]) }, history: [entry(DEPOSIT, 40, null), entry(claim, 40, `type262:claim:${DOMAIN}`)], lamports: { [VAULT]: 300_000_000n, [GAS]: SOL(1) } })
    await fails(make(same, { now: after(181) }).refund(DOMAIN, DEPOSIT), 422, 'Already claimed')
    assert.equal(m.sent.length + same.sent.length, 0)
  },
  'refund: a claim memo the vault did not sign changes nothing': async () => {
    const forged = b58encode(Buffer.alloc(64, 5))
    const m = chain({
      txs: { [DEPOSIT]: depositTx(), [forged]: memoTx(`type262:claim:${DOMAIN}`, [addr('someone')]) },
      history: [entry(forged, 45, `type262:claim:${DOMAIN}`), entry(DEPOSIT, 40, null)], lamports: { [VAULT]: 300_000_000n, [GAS]: SOL(1), [ALICE]: SOL(1) },
    })
    assert.equal((await make(m, { now: after(181) }).refund(DOMAIN, DEPOSIT)).refunded.amount, '300000000')
  },
  'refund: refused when already refunded (on-chain memo, or in this process before history shows it)': async () => {
    const done = b58encode(Buffer.alloc(64, 4))
    const m = chain({ txs: { [DEPOSIT]: depositTx(), [done]: memoTx(`type262:refund:${DEPOSIT}`, [GAS, VAULT]) }, history: [entry(done, 45, `type262:refund:${DEPOSIT}`)], lamports: { [VAULT]: SOL(1), [GAS]: SOL(1) } })
    await fails(make(m, { now: after(181) }).refund(DOMAIN, DEPOSIT), 422, 'Already refunded')
    const fresh = chain({ txs: { [DEPOSIT]: depositTx() }, history: [], lamports: { [VAULT]: SOL(1), [GAS]: SOL(1), [ALICE]: SOL(1) } })
    const w = make(fresh, { now: after(181) })
    await w.refund(DOMAIN, DEPOSIT)
    await fails(w.refund(DOMAIN, DEPOSIT), 422, 'Already refunded')
    assert.equal(fresh.sent.length, 1)
  },
  'refund: one transaction that funded two vaults is refunded once for each, one right after the other': async () => {
    const OTHER = 'example.org', OTHER_VAULT = vaultKeypair(MASTER, OTHER).address
    const both = depositTx()
    both.transaction.message.accountKeys.push({ pubkey: OTHER_VAULT, signer: false })
    both.transaction.message.instructions.push({ program: 'system', programId: SYSTEM, parsed: { type: 'transfer', info: { source: ALICE, destination: OTHER_VAULT, lamports: 200_000_000 } } })
    const m = chain({ txs: { [DEPOSIT]: both }, history: [entry(DEPOSIT, 40, null)], lamports: { [VAULT]: 300_000_000n, [OTHER_VAULT]: 200_000_000n, [GAS]: SOL(1), [ALICE]: SOL(1) } })
    const w = make(m, { now: after(181) })
    assert.equal((await w.refund(DOMAIN, DEPOSIT)).refunded.amount, '300000000')
    assert.equal((await w.refund(OTHER, DEPOSIT)).refunded.amount, '200000000', 'not "already refunded"')
    assert.deepEqual(m.sent.map(read), [
      [['memo', `type262:refund:${DEPOSIT}`], ['transfer', VAULT, ALICE, 300_000_000n]],
      [['memo', `type262:refund:${DEPOSIT}`], ['transfer', OTHER_VAULT, ALICE, 200_000_000n]],
    ])
    await fails(w.refund(OTHER, DEPOSIT), 422, 'Already refunded')
  },
  'refund: an RPC without the memo field gets each later transaction read': async () => {
    const claim = b58encode(Buffer.alloc(64, 8))
    const m = chain({ txs: { [DEPOSIT]: depositTx(), [claim]: memoTx(`type262:claim:${DOMAIN}`, [GAS, VAULT]) }, history: [{ signature: claim, slot: 45, err: null }], lamports: { [VAULT]: SOL(1), [GAS]: SOL(1) } })
    await fails(make(m, { now: after(181) }).refund(DOMAIN, DEPOSIT), 422, 'Already claimed')
    assert.equal(m.calls.filter(c => c === 'getTransaction').length, 2)
  },
  'refund: unknown signatures, transactions that are not deposits, and SOL the vault no longer holds': async () => {
    const m = chain({ txs: { [DEPOSIT]: depositTx(), [b58encode(Buffer.alloc(64, 2))]: memoTx('x', [GAS, VAULT]) }, lamports: { [VAULT]: 100n, [GAS]: SOL(1) } })
    const w = make(m, { now: after(181) })
    await fails(w.refund(DOMAIN, b58encode(Buffer.alloc(64, 3))), 404, 'Deposit not found')
    await fails(w.refund(DOMAIN, b58encode(Buffer.alloc(64, 2))), 422, 'Not a deposit')
    await fails(w.refund(DOMAIN, 'nope'), 400, 'Bad signature')
    await fails(w.refund(DOMAIN, DEPOSIT), 422, 'Not in the vault')
    // A deposit to another domain's vault is not this vault's.
    await fails(make(m, { now: after(181) }).refund('example.org', DEPOSIT), 422, 'Not a deposit')
    assert.equal(m.sent.length, 0)
  },
  'refund: a token deposit goes back to the sender\'s token account; the emptied vault account closes to the gas wallet': async () => {
    const vaultAcc = ata(VAULT, USDC, TOKEN), aliceAcc = ata(ALICE, USDC, TOKEN)
    const bal = (i, owner, amount) => ({ accountIndex: i, mint: USDC, owner, programId: TOKEN, uiTokenAmount: { amount: String(amount), decimals: 6 } })
    const tx = {
      slot: 40, blockTime: T0, meta: { err: null, innerInstructions: [], preTokenBalances: [bal(1, ALICE, 50_000000)], postTokenBalances: [bal(1, ALICE, 40_000000), bal(2, VAULT, 10_000000)] },
      transaction: { message: { accountKeys: [ALICE, aliceAcc, vaultAcc, USDC].map((pubkey, i) => ({ pubkey, signer: i === 0 })), instructions: [{ program: 'spl-token', programId: TOKEN, parsed: { type: 'transferChecked', info: { source: aliceAcc, destination: vaultAcc, mint: USDC, authority: ALICE, tokenAmount: { amount: '10000000', decimals: 6 } } } }] } },
    }
    const m = chain({
      txs: { [DEPOSIT]: tx }, lamports: { [GAS]: SOL(1) },
      accounts: { [vaultAcc]: { owner: TOKEN, lamports: Number(RENT165), data: { program: 'spl-token', parsed: { type: 'account', info: { mint: USDC, owner: VAULT, state: 'initialized', tokenAmount: { amount: '10000000', decimals: 6 } } } } } },
    })
    const r = await make(m, { now: after(181) }).refund(DOMAIN, DEPOSIT)
    assert.deepEqual(r.refunded, { mint: USDC, amount: '10000000', decimals: 6, to: ALICE })
    assert.deepEqual(read(m.sent[0]), [['create ata', ALICE, USDC, TOKEN], ['memo', `type262:refund:${DEPOSIT}`], ['transferChecked', vaultAcc, aliceAcc, 10_000000n, 6, TOKEN], ['close', vaultAcc, GAS]])
    // When the vault keeps other deposits of the token, its account stays open: the gas wallet will not pay for
    // the sender's token account then (dust deposits could farm that rent), so the sender must open it.
    m.accounts[vaultAcc].data.parsed.info.tokenAmount.amount = '15000000'
    await fails(make(m, { now: after(181) }).refund(DOMAIN, DEPOSIT), 422, 'Open a token account')
    m.accounts[aliceAcc] = { owner: TOKEN, lamports: Number(RENT165), data: [Buffer.alloc(165).toString('base64'), 'base64'] }
    const again = await make(m, { now: after(181) }).refund(DOMAIN, DEPOSIT)
    assert.equal(again.refunded.amount, '10000000')
    assert.deepEqual(read(m.sent.at(-1)).map(x => x[0]), ['create ata', 'memo', 'transferChecked'])
  },
})

// ---------- chain plumbing ----------

Object.assign(tests, {
  'priority fee: 75th percentile of recent non-zero fees, within bounds, doubled per expired attempt': async () => {
    const fees = [0, 0, 100, 30_000, 50_000, 70_000, 90_000].map(f => ({ slot: 1, prioritizationFee: f }))
    const rpc = async () => fees
    // non-zero, sorted: 100, 30k, 50k, 70k, 90k; the 75th percentile is index floor(5 * 0.75) = 3
    assert.equal(await priorityFee(rpc, [], { min: 20_000, max: 2_000_000 }), 70_000)
    assert.equal(await priorityFee(rpc, [], { min: 20_000, max: 2_000_000, attempt: 2 }), 280_000)
    assert.equal(await priorityFee(rpc, [], { min: 20_000, max: 100_000, attempt: 2 }), 100_000)
    assert.equal(await priorityFee(async () => [], [], { min: 20_000 }), 20_000)
    assert.equal(await priorityFee(async () => { throw new Error('down') }, [], { min: 20_000 }), 20_000)
  },
  'execute: resends while waiting for confirmation, and refuses before sending when the check fails': async () => {
    let polls = 0
    const m = chain({ lamports: { [GAS]: SOL(1) }, status: () => (++polls < 4 ? null : { confirmationStatus: 'confirmed', slot: 9, err: null }) })
    const gas = gasKeypair(MASTER)
    const r = await execute(m.rpc, { payer: GAS, keys: [gas], instructions: [systemTransfer(GAS, OWNER, 5n)], price: 1000, pollMs: 1, resendMs: 0 })
    assert.ok(m.calls.filter(c => c === 'sendTransaction').length >= 3, 'resent')
    assert.equal(r.slot, 9)
    const before = m.sent.length
    await assert.rejects(execute(m.rpc, { payer: GAS, keys: [gas], instructions: [systemTransfer(GAS, OWNER, 5n)], price: 1000, watch: [OWNER], check: ([o]) => { if (o.lamports !== 6n) throw Object.assign(new Error('no'), { tx: true }) } }), /no/)
    assert.equal(m.sent.length, before)
  },
  'execute: an RPC hiccup while waiting is not a failure': async () => {
    let polls = 0
    const m = chain({ lamports: { [GAS]: SOL(1) }, status: () => { polls++; if (polls < 3) throw new Error('socket hang up'); return { confirmationStatus: 'confirmed', slot: 9, err: null } } })
    const r = await execute(m.rpc, { payer: GAS, keys: [gasKeypair(MASTER)], instructions: [systemTransfer(GAS, OWNER, 5n)], price: 1000, pollMs: 1 })
    assert.equal(r.slot, 9)
  },
  'no secret reached the logs': () => {
    const all = logs.join('\n')
    for (const s of SECRETS) assert.ok(!all.includes(s))
  },
})

function SOL(n) { return BigInt(n) * 1_000_000_000n }

let passed = 0
for (const [name, fn] of Object.entries(tests)) {
  try { await fn(); passed++ } catch (err) { console.error(`FAIL ${name}\n`, err); process.exitCode = 1 }
}
console.log(`vault worker: ${passed}/${Object.keys(tests).length} passed`)
