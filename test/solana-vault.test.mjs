// Tests for the vault client (assets/solana-vault.js). Run: node test/solana-vault.test.mjs
// Offline, against mock fetch answers for the worker and the RPC:
// - every pump.fun instruction byte for byte against solana/scripts/pump-ix.mjs for the same inputs (account order,
//   signer and writable flags, data), its fixed addresses and PDAs, and the Anchor discriminators;
// - a launch: create_v2 with the vault as creator, the opening buy and its quote, one legacy transaction when it fits
//   and two when it doesn't, with its size checked against pump-lib's own encoder;
// - the worker API: URLs, methods, bodies, answers and { error, reason } errors;
// - a vault's history: deposits, the last claim and refunds read from memos; its coins via getProgramAccounts;
//   the creator fees waiting at pump.fun and the collect a wallet can pay for; sendAll with a mint co-signer.
// With the pump.fun fixtures fetched (solana/scripts/fetch-fixtures.mjs), also the decoders on pump's mainnet
// accounts. Throwaway keys only; nothing leaves this process.
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign as edSign, verify as edVerify, createPublicKey } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as V from '../assets/solana-vault.js'
import * as sol from '../assets/solana.js'
import * as T from '../assets/solana-type262.js'
import * as X from '../solana/scripts/pump-ix.mjs'
import * as L from '../solana/scripts/pump-lib.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const FIXTURES = `${root}solana/tests/fixtures/pump/accounts/`
const hex = b => Buffer.from(b).toString('hex')
const norm = ix => ({ programId: ix.programId, keys: ix.keys.map(k => [k.pubkey, !!k.isSigner, !!k.isWritable]), data: hex(ix.data) })
const fresh = () => L.randomOnCurve()
const b64 = b => Buffer.from(b).toString('base64')

/** A throwaway Ed25519 keypair as { publicKey, sign, verify }. */
function throwaway() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url')
  return {
    publicKey: sol.base58Encode(raw),
    sign: async m => Uint8Array.from(edSign(null, Buffer.from(m), privateKey)),
    verify: (m, sig) => edVerify(null, Buffer.from(m), createPublicKey(publicKey.export({ format: 'pem', type: 'spki' })), Buffer.from(sig)),
  }
}

// ---------- fetch mock: the worker, the RPC (public and fallback) ----------

const realFetch = globalThis.fetch
const respond = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
function mock({ worker = () => ({ status: 404, body: { error: 'not_found', reason: 'Not found' } }), rpc = () => { throw new Error('no rpc') } } = {}) {
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    url = String(url)
    const method = init.method || 'GET'
    const body = init.body ? JSON.parse(init.body) : null
    calls.push({ url, method, body, headers: init.headers || {} })
    if (url.startsWith(`${V.WORKER_URL}/solana/`)) {
      const r = await worker(url, method, body)
      if (r === 'down') throw new TypeError('fetch failed')
      return respond(r.status || 200, r.body)
    }
    if (body && body.jsonrpc) {
      try { return respond(200, { jsonrpc: '2.0', id: 1, result: await rpc(body.method, body.params, url) }) } catch (err) {
        return respond(200, { jsonrpc: '2.0', id: 1, error: { code: err.code || -32000, message: err.message } })
      }
    }
    throw new TypeError(`unexpected fetch ${url}`)
  }
  return calls
}
const restore = () => { globalThis.fetch = realFetch }

// ---------- data builders ----------

/** A 166-byte BondingCurve as pump writes it. */
function curveData({ creator, vTok = 1_073_000_000_000_000n, vSol = 30_000_000_000n, realTok = 793_100_000_000_000n, complete = false, quoteMint = V.WSOL, creatorFee = 0n }) {
  const b = Buffer.alloc(166)
  Buffer.from(V.DISC.bondingCurve).copy(b, 0)
  b.writeBigUInt64LE(vTok, 8); b.writeBigUInt64LE(vSol, 16); b.writeBigUInt64LE(realTok, 24); b.writeBigUInt64LE(0n, 32)
  b.writeBigUInt64LE(1_000_000_000_000_000n, 40); b[48] = complete ? 1 : 0
  L.pk(creator).copy(b, 49); L.pk(quoteMint).copy(b, 83); b.writeBigUInt64LE(creatorFee, 125)
  return b
}
/** A PumpSwap Pool with the fields the client reads. */
function poolData({ baseMint, coinCreator, poolQuoteTokenAccount, creatorFees }) {
  const b = Buffer.alloc(300)
  L.pk(baseMint).copy(b, 43); L.pk(V.WSOL).copy(b, 75); L.pk(poolQuoteTokenAccount).copy(b, 171); L.pk(coinCreator).copy(b, 211)
  b.writeBigUInt64LE(creatorFees, 279)
  return b
}
/** A 165-byte SPL token account. */
function tokenAccountData({ mint, owner, amount }) {
  const b = Buffer.alloc(165)
  L.pk(mint).copy(b, 0); L.pk(owner).copy(b, 32); b.writeBigUInt64LE(amount, 64)
  return b
}
const account = (data, owner = sol.SYSTEM_PROGRAM, lamports = 1_000_000) => ({ data: [b64(data), 'base64'], owner, lamports, executable: false, rentEpoch: 0, space: data.length })

// pump.fun's curve today (PUMP.md), for runs without the fixtures.
const SETTINGS = {
  global: {
    initialVirtualTokenReserves: 1_073_000_000_000_000n, initialVirtualSolReserves: 30_000_000_000n, initialRealTokenReserves: 793_100_000_000_000n,
    tokenTotalSupply: 1_000_000_000_000_000n, createV2Enabled: true, buybackFeeRecipients: [V.PUMP.buyback],
  },
  feeConfig: { flat: { lp: 0n, protocol: 95n, creator: 30n }, tiers: [] },
}

const tests = {}
const test = (name, fn) => { tests[name] = fn }

// ---------- pump.fun encoders against pump-ix.mjs ----------

test('fixed pump.fun addresses match pump-ix.mjs', () => {
  assert.equal(V.PUMP.program, L.PUMP)
  assert.equal(V.PUMP.amm, L.PUMP_AMM)
  assert.equal(V.PUMP.mayhem, L.MAYHEM)
  assert.equal(V.PUMP.global, X.GLOBAL)
  assert.equal(V.PUMP.mintAuthority, X.MINT_AUTHORITY)
  assert.equal(V.PUMP.eventAuthority, X.PUMP_EVENT_AUTHORITY)
  assert.equal(V.PUMP.ammEventAuthority, X.AMM_EVENT_AUTHORITY)
  assert.equal(V.PUMP.ammGlobalConfig, X.AMM_GLOBAL_CONFIG)
  assert.equal(V.PUMP.feeConfig, X.PUMP_FEE_CONFIG)
  assert.equal(V.PUMP.mayhemGlobalParams, X.MAYHEM_GLOBAL_PARAMS)
  assert.equal(V.PUMP.mayhemSolVault, X.MAYHEM_SOL_VAULT)
  assert.equal(V.TOKEN_2022, L.TOKEN_2022)
  assert.equal(V.WSOL, L.WSOL)
})

test('discriminators are Anchor\'s sha256 prefixes', () => {
  const g = n => createHash('sha256').update(`global:${n}`).digest().subarray(0, 8).toString('hex')
  assert.equal(hex(V.DISC.createV2), g('create_v2'))
  assert.equal(hex(V.DISC.buyV3), g('buy_v3'))
  assert.equal(hex(V.DISC.sweepCreatorFee), g('sweep_creator_fee'))
  assert.equal(hex(V.DISC.collectCreatorFeeV2), g('collect_creator_fee_v2'))
  assert.equal(hex(V.DISC.collectCoinCreatorFee), g('collect_coin_creator_fee'))
  assert.equal(hex(V.DISC.bondingCurve), hex(L.anchorAccount('BondingCurve')))
})

test('per-coin and per-creator PDAs match pump-ix.mjs', async () => {
  for (let i = 0; i < 3; i++) {
    const mint = fresh(), creator = fresh(), user = fresh()
    assert.equal(await V.pumpPda.bondingCurve(mint), X.bondingCurvePda(mint))
    assert.equal(await V.pumpPda.creatorVault(creator), X.creatorVaultPda(creator))
    assert.equal(await V.pumpPda.mayhemState(mint), X.mayhemStatePda(mint))
    assert.equal(await V.pumpPda.userVolume(user), X.userVolumeAccumulatorPda(user))
    assert.equal(await V.pumpPda.poolAuthority(mint), X.poolAuthorityPda(mint))
    assert.equal(await V.pumpPda.canonicalPool(mint), X.canonicalPoolPda(mint))
    assert.equal(await V.pumpPda.ammCreatorVault(creator), X.ammCreatorVaultPda(creator))
    assert.equal(await V.ata(user, mint, V.TOKEN_2022), X.ata(user, mint, L.TOKEN_2022))
    assert.equal(await V.ata(user, V.WSOL), X.ata(user, L.WSOL, L.TOKEN))
  }
})

test('create_v2 is byte-identical to pump-ix.mjs (vault as creator, mayhem on and off)', async () => {
  for (const [name, symbol, uri] of [['Your Site', 'SITE', 'https://ipfs.io/ipfs/bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy'], ['Ünïcode ☃ coin', 'UNI', 'https://example.com/m.json'], ['x'.repeat(32), 'Y'.repeat(10), 'https://' + 'u'.repeat(192)]]) {
    const mint = fresh(), user = fresh(), creator = fresh()
    assert.deepEqual(norm(await V.createV2({ mint, user, creator, name, symbol, uri })), norm(X.createV2({ mint, user, creator, name, symbol, uri })))
    assert.deepEqual(norm(await V.createV2({ mint, user, creator, name, symbol, uri, mayhem: true })), norm(X.createV2({ mint, user, creator, name, symbol, uri, mayhem: true })))
  }
})

test('buy_v3 is byte-identical to pump-ix.mjs', async () => {
  for (const [amount, maxSolCost] of [[1n, 1n], [35_617_049_046_573n, 1_000_000_000n], [(1n << 64n) - 1n, 0n]]) {
    const mint = fresh(), user = fresh(), buyback = fresh()
    assert.deepEqual(norm(await V.buyV3({ mint, user, amount, maxSolCost, buyback })), norm(X.buyV3({ mint, user, amount, maxSolCost, buyback })))
  }
  await assert.rejects(V.buyV3({ mint: fresh(), user: fresh(), amount: -1n, maxSolCost: 0n }), /out of range/)
})

test('sweep and collect instructions are byte-identical to pump-ix.mjs', async () => {
  const payer = fresh(), mint = fresh(), creator = fresh(), pool = fresh(), poolQuoteTokenAccount = fresh(), coinCreatorTokenAccount = fresh()
  assert.deepEqual(norm(await V.sweepCreatorFee({ payer, mint, creator })), norm(X.sweepCreatorFee({ payer, mint, creator })))
  assert.deepEqual(norm(await V.collectCreatorFeeV2({ creator })), norm(X.collectCreatorFeeV2({ creator })))
  assert.deepEqual(norm(await V.ammSweepCreatorFee({ payer, pool, coinCreator: creator, poolQuoteTokenAccount })), norm(X.ammSweepCreatorFee({ payer, pool, coinCreator: creator, poolQuoteTokenAccount })))
  assert.deepEqual(norm(await V.collectCoinCreatorFee({ coinCreator: creator, coinCreatorTokenAccount })), norm(X.collectCoinCreatorFee({ coinCreator: creator, coinCreatorTokenAccount })))
  assert.deepEqual(norm(await V.ataIdempotent({ payer, owner: creator, mint: V.WSOL })), norm(X.createAtaIdempotent({ payer, owner: creator, mint: L.WSOL, tokenProgram: L.TOKEN })))
  assert.deepEqual(norm(await V.ataIdempotent({ payer, owner: payer, mint, tokenProgram: V.TOKEN_2022 })), norm(X.createAtaIdempotent({ payer, owner: payer, mint, tokenProgram: L.TOKEN_2022 })))
})

test('compute budget instructions', () => {
  assert.equal(hex(V.computeUnitLimit(250_000).data), '0290d00300')
  assert.equal(hex(V.computeUnitPrice(100_000n).data), '03a086010000000000')
  assert.equal(V.computeUnitLimit(1).programId, V.COMPUTE_BUDGET)
})

// ---------- decoders and quotes ----------

test('curve and pool decoders match pump-lib readers', () => {
  const creator = fresh(), mint = fresh(), q = fresh()
  const c = curveData({ creator, creatorFee: 8_389n, complete: true, realTok: 12_345n })
  const mine = V.decodeCurve(c), theirs = L.readBondingCurve(c)
  for (const k of ['virtualTokenReserves', 'realTokenReserves', 'tokenTotalSupply', 'complete', 'creator', 'quoteMint', 'creatorFee', 'protocolFees', 'isHolderReward', 'creatorFeeBps']) assert.deepEqual(mine[k], theirs[k], k)
  assert.equal(mine.virtualSolReserves, theirs.virtualQuoteReserves)
  // A curve from before creator_fee was added reads it as zero.
  assert.equal(V.decodeCurve(c.subarray(0, 125)).creatorFee, 0n)
  assert.equal(V.decodeCurve(c.subarray(0, 151)).creatorFee, 8_389n)
  const p = poolData({ baseMint: mint, coinCreator: creator, poolQuoteTokenAccount: q, creatorFees: 941_890_151n })
  const mp = V.decodePool(p), tp = L.readPool(p)
  assert.equal(mp.coinCreator, tp.coinCreator); assert.equal(mp.poolQuoteTokenAccount, tp.poolQuoteTokenAccount)
  assert.equal(mp.creatorFees, tp.creatorFees); assert.equal(mp.baseMint, tp.baseMint)
})

test('Global and fee config decoders on pump\'s mainnet accounts', () => {
  if (!existsSync(FIXTURES)) return 'skip: run node solana/scripts/fetch-fixtures.mjs'
  const data = a => Buffer.from(JSON.parse(readFileSync(`${FIXTURES}${a}.json`, 'utf8')).data, 'base64')
  const g = data(V.PUMP.global), mine = V.decodeGlobal(Uint8Array.from(g)), theirs = L.readGlobal(g)
  for (const k of ['initialVirtualTokenReserves', 'initialVirtualSolReserves', 'initialRealTokenReserves', 'tokenTotalSupply', 'buybackFeeRecipients']) assert.deepEqual(mine[k], theirs[k], k)
  assert.equal(mine.createV2Enabled, theirs.createV2Enabled)
  assert.ok(mine.buybackFeeRecipients.includes(V.PUMP.buyback))
  const f = data(V.PUMP.feeConfig), fc = V.decodeFeeConfig(Uint8Array.from(f)), tf = L.readFeeConfig(f)
  assert.deepEqual(fc.flat, { lp: tf.flatFees.lpFeeBps, protocol: tf.flatFees.protocolFeeBps, creator: tf.flatFees.creatorFeeBps })
  assert.equal(fc.tiers.length, tf.feeTiers.length)
  fc.tiers.forEach((t, i) => {
    assert.equal(t.threshold, tf.feeTiers[i].marketCapLamportsThreshold)
    assert.deepEqual([t.lp, t.protocol, t.creator], [tf.feeTiers[i].fees.lpFeeBps, tf.feeTiers[i].fees.protocolFeeBps, tf.feeTiers[i].fees.creatorFeeBps])
  })
  SETTINGS.mainnet = { global: mine, feeConfig: fc }
})

test('quotes match the program client\'s (checked there against a validator)', () => {
  const settings = SETTINGS.mainnet || SETTINGS
  const curve = V.freshCurve(settings.global)
  const fees = V.curveFees(settings.feeConfig, V.marketCap(curve))
  for (const lamports of [1n, 10_000_000n, 1_000_000_000n, 25_000_000_000n, 80_000_000_000n]) {
    const t = { ...curve, virtualSolReserves: curve.virtualSolReserves, creatorFeeBps: 0n }
    assert.equal(V.quoteBuy(curve, fees, lamports), T.quoteBuy(t, fees, lamports), String(lamports))
    const tokens = V.quoteOpeningBuy(settings, lamports)
    if (tokens > 0n) {
      assert.ok(V.buyCost(curve, fees, tokens) <= lamports)
      assert.ok(V.buyCost(curve, fees, tokens + 1n) > lamports)
    }
  }
})

// ---------- launch ----------

test('launch: create_v2 (creator = vault), the buyer\'s token account and buy_v3 in one legacy transaction', async () => {
  const settings = SETTINGS.mainnet || SETTINGS
  // /metadata answers https://ipfs.io/ipfs/<CIDv1>: 80 characters.
  const uri = 'https://ipfs.io/ipfs/bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy'
  const sizes = []
  for (const [name, symbol, budget] of [['Your Site', 'SITE', true], ['x'.repeat(32), 'Y'.repeat(10), false]]) {
    const payer = fresh(), vault = fresh(), mintKeypair = throwaway()
    const plan = await V.launchTxs({ payer, vault, name, symbol, uri, buyLamports: 1_500_000_000n, mintKeypair, settings })
    assert.equal(plan.single, true)
    assert.equal(plan.mint, mintKeypair.publicKey)
    assert.equal(plan.txs.length, 1)
    assert.deepEqual(plan.txs[0].extraSigners, [mintKeypair])
    const ixs = plan.txs[0].instructions
    // With room, the compute budget leads; a max-length name and ticker leave none, so the buy keeps its place instead.
    assert.equal(ixs.length, budget ? 5 : 3)
    if (budget) {
      assert.equal(hex(ixs[0].data), hex(V.computeUnitLimit(V.LAUNCH.bothUnits).data))
      assert.equal(hex(ixs[1].data), hex(V.computeUnitPrice(V.LAUNCH.microLamports).data))
    }
    const [create, ataIx, buy] = ixs.slice(-3)
    assert.deepEqual(norm(create), norm(X.createV2({ mint: plan.mint, user: payer, creator: vault, name, symbol, uri })))
    assert.deepEqual(norm(ataIx), norm(X.createAtaIdempotent({ payer, owner: payer, mint: plan.mint, tokenProgram: L.TOKEN_2022 })))
    const buyback = buy.keys[13].pubkey
    assert.ok(settings.global.buybackFeeRecipients.includes(buyback))
    assert.equal(plan.tokens, V.quoteOpeningBuy(settings, 1_500_000_000n))
    assert.deepEqual(norm(buy), norm(X.buyV3({ mint: plan.mint, user: payer, amount: plan.tokens, maxSolCost: 1_500_000_000n, buyback })))
    // The size agrees with pump-lib's encoder for the same instructions, and is under the legacy limit.
    const theirs = L.compileLegacy(payer, ixs.map(ix => ({ ...ix, data: Buffer.from(ix.data) })))
    assert.equal(plan.size, theirs.size)
    assert.ok(plan.size <= V.LEGACY_LIMIT, `${plan.size} bytes`)
    sizes.push(`${name.length}/${symbol.length} chars: ${plan.size} bytes, ${theirs.accountKeys.length} accounts${budget ? ' with compute budget' : ''}`)
  }
  console.log(`     (IPFS metadata link; name/ticker ${sizes.join('; ')})`)
})

test('launch: a long metadata link splits into create, then the buy for 5% fewer tokens', async () => {
  const settings = SETTINGS.mainnet || SETTINGS
  const payer = fresh(), vault = fresh(), mintKeypair = throwaway()
  const plan = await V.launchTxs({ payer, vault, name: 'x'.repeat(32), symbol: 'Y'.repeat(10), uri: 'https://' + 'u'.repeat(192), buyLamports: 2_000_000_000n, mintKeypair, settings })
  assert.equal(plan.single, false)
  assert.ok(plan.size > V.LEGACY_LIMIT)
  assert.deepEqual(plan.txs.map(t => t.kind), ['create', 'buy'])
  assert.deepEqual(plan.txs[0].extraSigners, [mintKeypair])
  assert.deepEqual(plan.txs[1].extraSigners, [])
  const exact = V.quoteOpeningBuy(settings, 2_000_000_000n)
  assert.equal(plan.tokens, (exact * 9_500n) / 10_000n)
  const buy = plan.txs[1].instructions.at(-1)
  assert.equal(Buffer.from(buy.data).readBigUInt64LE(8), plan.tokens)
  assert.equal(Buffer.from(buy.data).readBigUInt64LE(16), 2_000_000_000n)
  for (const t of plan.txs) assert.ok(V.legacySize(payer, t.instructions) <= V.LEGACY_LIMIT)
})

test('launch: no opening buy is the create alone; bad input and a paused create_v2 refuse', async () => {
  const payer = fresh(), vault = fresh(), mintKeypair = throwaway()
  const plan = await V.launchTxs({ payer, vault, name: 'A', symbol: 'A', uri: 'https://a.example/m.json', mintKeypair, settings: SETTINGS })
  assert.equal(plan.single, true)
  assert.equal(plan.tokens, 0n)
  assert.deepEqual(plan.txs[0].instructions.slice(2).map(norm), [norm(X.createV2({ mint: plan.mint, user: payer, creator: vault, name: 'A', symbol: 'A', uri: 'https://a.example/m.json' }))])
  await assert.rejects(V.launchTxs({ payer, vault: 'nope', name: 'A', symbol: 'A', uri: 'x', settings: SETTINGS }), /No vault/)
  await assert.rejects(V.launchTxs({ payer, vault, name: '', symbol: 'A', uri: 'x', settings: SETTINGS }), /name/)
  await assert.rejects(V.launchTxs({ payer, vault, name: 'A', symbol: 'A', uri: 'x', settings: { ...SETTINGS, global: { ...SETTINGS.global, createV2Enabled: false } } }), /not creating new coins/)
  await assert.rejects(V.launchTxs({ payer, vault, name: 'A', symbol: 'A', uri: 'x', buyLamports: 1n, mintKeypair, settings: SETTINGS }), /too small/)
})

test('launch: on the board, the create\'s transaction carries the reference and an opening buy still rides along', async () => {
  const settings = SETTINGS.mainnet || SETTINGS
  const uri = 'https://ipfs.io/ipfs/bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy'
  const refIn = ix => ix.keys.at(-1).pubkey === V.BOARD_REFERENCE && !ix.keys.at(-1).isSigner && !ix.keys.at(-1).isWritable
  const tagged = ixs => ixs.filter(ix => ix.keys.some(k => k.pubkey === V.BOARD_REFERENCE))
  const sizes = []
  for (const [name, symbol, link, buy, single] of [
    ['Your Site', 'SITE', uri, 0n, true], // the create alone: the reference rides on a zero-lamport transfer
    ['Your Site', 'SITE', uri, 1_500_000_000n, true], // a typical launch stays one transaction
    ['x'.repeat(32), 'Y'.repeat(10), uri, 1_500_000_000n, true], // the longest name and ticker still fit
    ['x'.repeat(32), 'Y'.repeat(10), 'https://' + 'u'.repeat(192), 2_000_000_000n, false], // a long link splits, as before
  ]) {
    const payer = fresh(), vault = fresh(), mintKeypair = throwaway()
    const plan = await V.launchTxs({ payer, vault, name, symbol, uri: link, buyLamports: buy, mintKeypair, settings, board: true })
    assert.equal(plan.single, single, `${name.length}/${symbol.length}/${link.length}: ${plan.size} bytes`)
    const create = plan.txs[0].instructions
    assert.equal(tagged(create).length, 1, 'one tagged instruction in the create\'s transaction')
    assert.ok(refIn(tagged(create)[0]))
    if (buy && single) assert.equal(tagged(create)[0].programId, sol.ATA_PROGRAM, 'on the buyer\'s token-account instruction')
    else assert.deepEqual(norm(tagged(create)[0]), norm(V.launchTag(payer)))
    for (const t of plan.txs.slice(1)) assert.equal(tagged(t.instructions).length, 0, 'only the create\'s transaction is tagged')
    for (const t of plan.txs) assert.ok(V.legacySize(payer, t.instructions) <= V.LEGACY_LIMIT, `${t.kind}: ${V.legacySize(payer, t.instructions)} bytes`)
    sizes.push(`${plan.txs.map(t => t.kind).join('+')} ${plan.size} bytes`)
  }
  // off the board, nothing changes
  const bare = await V.launchTxs({ payer: fresh(), vault: fresh(), name: 'A', symbol: 'A', uri, mintKeypair: throwaway(), settings })
  assert.equal(tagged(bare.txs[0].instructions).length, 0)
  console.log(`     (on the board: ${sizes.join('; ')})`)
})

// ---------- the worker API ----------

test('GET /solana/vault: the vault, its USDC account derived and checked, cached per domain', async () => {
  const vault = fresh()
  const usdcAccount = await sol.associatedTokenAddress(vault, sol.USDC.mint)
  const calls = mock({ worker: url => (url.endsWith('domain=example.com') ? { body: { domain: 'example.com', vault, usdcAccount } } : { status: 400, body: { error: 'bad_domain', reason: 'That is not a valid domain.' } }) })
  try {
    assert.deepEqual(await V.getVault('example.com'), { domain: 'example.com', vault, usdcAccount })
    assert.deepEqual(await V.getVault('example.com'), { domain: 'example.com', vault, usdcAccount })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, `${V.WORKER_URL}/solana/vault?domain=example.com`)
    assert.equal(calls[0].method, 'GET')
    await assert.rejects(V.getVault('-bad-'), err => err.message === 'That is not a valid domain.' && err.code === 'bad_domain' && err.status === 400)
  } finally { restore() }
  const other = fresh()
  mock({ worker: url => (url.includes('mismatch') ? { body: { domain: 'mismatch.com', vault, usdcAccount: other } } : { body: { domain: 'x.com', vault: 'not-an-address' } }) })
  try {
    await assert.rejects(V.getVault('mismatch.com'), /USDC account isn't this vault's/)
    await assert.rejects(V.getVault('x.com'), /no vault address/)
  } finally { restore() }
  mock({ worker: () => 'down' })
  try { await assert.rejects(V.getVault('down.com'), err => /Can't reach the TYPE\/262 worker/.test(err.message) && err.unreachable) } finally { restore() }
})

test('POST /solana/claim, /collect and /refund: JSON bodies, amounts as BigInt, { error, reason } as errors', async () => {
  const wallet = fresh(), sig = 'x'.repeat(88)
  const calls = mock({
    worker: (url, method, body) => {
      if (url.endsWith('/solana/claim') && body.domain === 'ok.com') {
        return {
          body: {
            domain: 'ok.com', wallet, collected: [{ mint: null, lamports: '8389', source: 'creator-vault' }],
            payouts: [{ mint: 'SOL', amount: '1990000000', fee: 10000000, decimals: 9, signature: sig }, { mint: sol.USDC.mint, amount: '24875000', fee: '125000', decimals: 6, signature: sig }],
            signatures: [sig, sig, 5], skipped: [{ mint: 'Mint111111111111111111111111111111111111111', reason: 'More tokens than one claim pays; claim again for the rest.' }, { mint: null }],
          },
        }
      }
      if (url.endsWith('/solana/claim')) return { status: 409, body: { error: 'dnssec', reason: 'Google did not return the record DNSSEC-authenticated.' } }
      if (url.endsWith('/solana/collect')) return { body: body.domain === 'dust.com' ? { domain: 'dust.com', collected: [], signatures: [], pending: '4000' } : { domain: body.domain, collected: [{ mint: 'Coin1111111111111111111111111111111111111111', lamports: 16018096, source: 'curve' }], signatures: [sig] } }
      if (url.endsWith('/solana/refund')) return { body: { domain: body.domain, refunded: { mint: sol.USDC.mint, amount: '25000000', decimals: 6, to: wallet }, signature: sig } }
      if (url.endsWith('/solana/status')) return { body: { gasWallet: '7ko5ykhPaGE4Tb6XoCqTj5hQNGwBRRRvqnHPnxeTSJGB', gasLamports: '50000000', feeWallet: '3sde4YJpX2oYMSWaozHareWrXn6MASLxhQgfuCKJNPoK', feeBps: 50, refundDelayDays: 180 } }
    },
  })
  try {
    const c = await V.claim('ok.com')
    assert.equal(c.wallet, wallet)
    assert.deepEqual(c.collected, [{ mint: 'SOL', lamports: 8389n, source: 'creator-vault' }])
    assert.deepEqual(c.payouts.map(p => [p.mint, p.amount, p.fee, p.decimals]), [['SOL', 1_990_000_000n, 10_000_000n, 9], [sol.USDC.mint, 24_875_000n, 125_000n, 6]])
    assert.deepEqual(c.signatures, [sig, sig])
    assert.deepEqual(c.skipped, [{ mint: 'Mint111111111111111111111111111111111111111', reason: 'More tokens than one claim pays; claim again for the rest.' }])
    assert.equal(calls[0].method, 'POST')
    assert.equal(calls[0].headers['content-type'], 'application/json')
    assert.deepEqual(calls[0].body, { domain: 'ok.com' })
    await assert.rejects(V.claim('no.com'), err => err.message === 'Google did not return the record DNSSEC-authenticated.' && err.code === 'dnssec' && err.status === 409)
    assert.deepEqual(await V.collect('ok.com'), { domain: 'ok.com', collected: [{ mint: 'Coin1111111111111111111111111111111111111111', lamports: 16_018_096n, source: 'curve' }], signatures: [sig], pending: 0n })
    assert.deepEqual(calls.at(-1).body, { domain: 'ok.com' })
    assert.deepEqual(await V.collect('dust.com'), { domain: 'dust.com', collected: [], signatures: [], pending: 4_000n })
    assert.deepEqual(await V.refund('ok.com', sig), { refunded: { mint: sol.USDC.mint, amount: 25_000_000n, decimals: 6, to: wallet }, signature: sig })
    assert.deepEqual(calls.at(-1).body, { domain: 'ok.com', signature: sig })
    const s = await V.getStatus()
    assert.deepEqual([s.feeBps, s.refundDelayDays, s.gasLamports, s.feeWallet], [50, 180, 50_000_000n, '3sde4YJpX2oYMSWaozHareWrXn6MASLxhQgfuCKJNPoK'])
    assert.equal(calls.at(-1).method, 'GET')
  } finally { restore() }
})

// ---------- reads ----------

test('memos and vault events: the last claim and the refunded deposits', () => {
  assert.deepEqual(V.memos('[26] type262:claim:example.com; [7] hello;x'), ['type262:claim:example.com', 'hello;x'])
  assert.deepEqual(V.memos(''), [])
  const sigs = [
    { signature: 'r1', slot: 50, memo: `[100] ${V.refundMemo('d1')}`, err: null },
    { signature: 'c2', slot: 40, memo: '[27] type262:claim:example.com', err: null },
    { signature: 'c0', slot: 30, memo: '[27] type262:claim:example.com', err: { InstructionError: [0, 'x'] } },
    { signature: 'x', slot: 20, memo: '[31] type262:claim:example.com.evil', err: null },
  ]
  const e = V.vaultEvents(sigs, 'example.com')
  assert.equal(e.lastClaim.signature, 'c2')
  assert.deepEqual([...e.refunded], ['d1'])
  assert.equal(V.vaultEvents(sigs, 'evil.com').lastClaim, null)
})

test('parseDeposit: SOL and token transfers into the vault from the sender, nothing else', () => {
  const vault = fresh(), me = fresh(), other = fresh(), usdc = fresh(), mine = fresh()
  const tx = (instructions, post = [], keys = [me, vault, usdc, mine]) => ({ transaction: { message: { accountKeys: keys.map(pubkey => ({ pubkey })), instructions } }, meta: { err: null, postTokenBalances: post } })
  const solIx = (source, destination, lamports) => ({ program: 'system', parsed: { type: 'transfer', info: { source, destination, lamports } } })
  assert.deepEqual(V.parseDeposit(tx([solIx(me, vault, 500_000_000)]), { vault, from: me }), { mint: 'SOL', amount: 500_000_000n, decimals: 9 })
  assert.equal(V.parseDeposit(tx([solIx(other, vault, 5)]), { vault, from: me }), null)
  assert.equal(V.parseDeposit(tx([solIx(me, other, 5)]), { vault, from: me }), null)
  const checked = { program: 'spl-token', parsed: { type: 'transferChecked', info: { source: mine, mint: sol.USDC.mint, destination: usdc, authority: me, tokenAmount: { amount: '25000000', decimals: 6 } } } }
  assert.deepEqual(V.parseDeposit(tx([{ program: 'spl-associated-token-account', parsed: { type: 'createIdempotent', info: {} } }, checked]), { vault, accounts: [usdc], from: me }), { mint: sol.USDC.mint, amount: 25_000_000n, decimals: 6 })
  // A plain transfer names no mint: it comes from the destination's balance, which must belong to the vault.
  const plain = { program: 'spl-token', parsed: { type: 'transfer', info: { source: mine, destination: usdc, authority: me, amount: '7' } } }
  const post = [{ accountIndex: 2, mint: 'Mint111111111111111111111111111111111111111', owner: vault, uiTokenAmount: { decimals: 2 } }]
  assert.deepEqual(V.parseDeposit(tx([plain], post), { vault, from: me }), { mint: 'Mint111111111111111111111111111111111111111', amount: 7n, decimals: 2 })
  assert.equal(V.parseDeposit(tx([plain], [{ ...post[0], owner: other }]), { vault, from: me }), null)
  assert.equal(V.parseDeposit({ ...tx([solIx(me, vault, 5)]), meta: { err: { InstructionError: [0, 'x'] } } }, { vault, from: me }), null)
})

test('findDeposits: since the last claim, not refunded, refundable after the delay', async () => {
  const vault = fresh(), me = fresh(), usdc = fresh(), now = 2_000_000_000, day = 86_400
  const sigs = {
    [vault]: [
      { signature: 'refund-of-d3', slot: 90, blockTime: now - day, memo: `[50] ${V.refundMemo('d3')}`, err: null },
      { signature: 'd5', slot: 80, blockTime: now - 10 * day, memo: null, err: null },
      { signature: 'd4', slot: 70, blockTime: now - 200 * day, memo: null, err: null },
      { signature: 'd3', slot: 60, blockTime: now - 300 * day, memo: null, err: null },
      { signature: 'claim', slot: 50, blockTime: now - 400 * day, memo: '[27] type262:claim:example.com', err: null },
      { signature: 'd1', slot: 40, blockTime: now - 500 * day, memo: null, err: null },
    ],
    [usdc]: [{ signature: 'd6', slot: 75, blockTime: now - 190 * day, memo: null, err: null }, { signature: 'd5', slot: 80, blockTime: now - 10 * day, memo: null, err: null }],
  }
  const solTx = lamports => ({ blockTime: 0, transaction: { message: { accountKeys: [{ pubkey: me }, { pubkey: vault }], instructions: [{ program: 'system', parsed: { type: 'transfer', info: { source: me, destination: vault, lamports } } }] } }, meta: { err: null, postTokenBalances: [] } })
  const usdcTx = { transaction: { message: { accountKeys: [{ pubkey: me }, { pubkey: usdc }], instructions: [{ program: 'spl-token', parsed: { type: 'transferChecked', info: { destination: usdc, mint: sol.USDC.mint, authority: me, tokenAmount: { amount: '25000000', decimals: 6 } } } }] } }, meta: { err: null, postTokenBalances: [] } }
  const txs = { d5: solTx(100_000_000), d4: solTx(500_000_000), d6: usdcTx, d3: solTx(1), d1: solTx(1) }
  const fetched = []
  mock({
    rpc: (method, params) => {
      if (method === 'getSignaturesForAddress') return sigs[params[0]] || []
      if (method === 'getTransaction') { fetched.push(params[0]); assert.equal(params[1].maxSupportedTransactionVersion, 0); return txs[params[0]] || null }
      throw new Error(`unexpected ${method}`)
    },
  })
  try {
    const r = await V.findDeposits({ domain: 'example.com', vault, accounts: [usdc], from: me, now })
    assert.equal(r.lastClaim.signature, 'claim')
    assert.deepEqual(fetched.sort(), ['d4', 'd5', 'd6'])
    assert.deepEqual(r.deposits.map(d => [d.signature, d.mint, d.amount, d.refundable]), [['d4', 'SOL', 500_000_000n, true], ['d6', sol.USDC.mint, 25_000_000n, true], ['d5', 'SOL', 100_000_000n, false]])
    assert.equal(r.deposits[2].refundableAt, now - 10 * day + 180 * day)
    assert.equal(r.truncated, false)
  } finally { restore() }
})

test('findCoins: getProgramAccounts through the fallback with the creator filter; spoofed curves dropped', async () => {
  const vault = fresh(), mint = fresh(), other = fresh(), spoofCurve = await V.pumpPda.bondingCurve(fresh())
  const curve = await V.pumpPda.bondingCurve(mint)
  const seen = []
  mock({
    rpc: (method, params, url) => {
      seen.push([method, url])
      if (method === 'getProgramAccounts') {
        assert.equal(url, 'https://type262-upload.onrender.com/rpc/solana')
        assert.equal(params[0], V.PUMP.program)
        assert.deepEqual(params[1].filters, [{ memcmp: { offset: 0, bytes: sol.base58Encode(V.DISC.bondingCurve) } }, { memcmp: { offset: 49, bytes: vault } }])
        assert.deepEqual(params[1].dataSlice, { offset: 0, length: 166 })
        return [
          { pubkey: curve, account: account(curveData({ creator: vault, creatorFee: 8_389n, realTok: 396_550_000_000_000n }), V.PUMP.program) },
          { pubkey: spoofCurve, account: account(curveData({ creator: vault, creatorFee: 99n }), V.PUMP.program) },
          { pubkey: fresh(), account: account(curveData({ creator: other }), V.PUMP.program) },
        ]
      }
      if (method === 'getTokenAccountsByOwner') {
        const m = params[0] === curve ? mint : fresh() // the spoof's token account names a mint whose curve is elsewhere
        return { context: { slot: 1 }, value: params[1].programId === V.TOKEN_2022 ? [{ pubkey: fresh(), account: { data: { parsed: { info: { mint: m } } } } }] : [] }
      }
      if (method === 'getMultipleAccounts') return { context: { slot: 1 }, value: params[0].map(() => ({ data: { parsed: { info: { extensions: [{ extension: 'tokenMetadata', state: { name: 'Your Site', symbol: 'SITE', uri: 'https://ipfs.io/ipfs/x' } }] } } } })) }
      throw new Error(`unexpected ${method}`)
    },
  })
  try {
    const coins = await V.findCoins(vault)
    assert.deepEqual(coins.map(c => [c.mint, c.curve, c.symbol, c.creatorFee]), [[mint, curve, 'SITE', 8_389n]])
    assert.equal(coins[0].progress, 0.5)
  } finally { restore() }
})

test('pendingFees and the collect a wallet can pay for', async () => {
  const vault = fresh(), payer = fresh(), a = fresh(), b = fresh(), q = fresh()
  const coins = [
    { mint: a, curve: await V.pumpPda.bondingCurve(a), complete: false, creatorFee: 8_389n, quoteMint: V.WSOL },
    { mint: b, curve: await V.pumpPda.bondingCurve(b), complete: true, creatorFee: 1_000n, quoteMint: V.WSOL },
  ]
  const creatorVault = await V.pumpPda.creatorVault(vault)
  const ammAta = await V.ata(await V.pumpPda.ammCreatorVault(vault), V.WSOL)
  const pool = await V.pumpPda.canonicalPool(b)
  mock({
    rpc: (method, params) => {
      if (method === 'getMinimumBalanceForRentExemption') return 890_880
      if (method === 'getMultipleAccounts') {
        assert.deepEqual(params[0], [vault, creatorVault, ammAta, pool])
        return { context: { slot: 1 }, value: [null, account(Buffer.alloc(0), sol.SYSTEM_PROGRAM, 890_880 + 5_000), account(tokenAccountData({ mint: V.WSOL, owner: vault, amount: 77n }), sol.TOKEN_PROGRAM), account(poolData({ baseMint: b, coinCreator: vault, poolQuoteTokenAccount: q, creatorFees: 600n }), V.PUMP.amm)] }
      }
      throw new Error(`unexpected ${method}`)
    },
  })
  try {
    const fees = await V.pendingFees(vault, coins)
    assert.deepEqual([fees.curve, fees.swept, fees.pool, fees.ammWaiting, fees.total, fees.vaultLamports], [9_389n, 5_000n, 600n, 77n, 15_066n, 0n])
    const txs = await V.collectTxs({ payer, vault, coins, fees })
    const ixs = txs.flatMap(t => t.instructions).map(norm)
    assert.deepEqual(ixs, [
      norm(sol.systemTransfer(payer, vault, 890_880n)), // the empty vault gets its rent first, or pump would pay it nothing
      norm(X.sweepCreatorFee({ payer, mint: a, creator: vault })),
      norm(X.sweepCreatorFee({ payer, mint: b, creator: vault })),
      norm(X.collectCreatorFeeV2({ creator: vault })),
      norm(X.ammSweepCreatorFee({ payer, pool, coinCreator: vault, poolQuoteTokenAccount: q })),
      norm(X.createAtaIdempotent({ payer, owner: vault, mint: L.WSOL, tokenProgram: L.TOKEN })),
      norm(X.collectCoinCreatorFee({ coinCreator: vault, coinCreatorTokenAccount: X.ata(vault, L.WSOL, L.TOKEN) })),
    ])
    for (const t of txs) assert.ok(V.legacySize(payer, t.instructions) <= V.LEGACY_LIMIT)
    assert.deepEqual(await V.collectTxs({ payer, vault, coins: [], fees: { ...fees, swept: 0n, pools: [], ammWaiting: 0n } }), [])
  } finally { restore() }
})

test('addressType: wallet, new, token account, mint, program', async () => {
  const kinds = { w: [Buffer.alloc(0), sol.SYSTEM_PROGRAM], t: [Buffer.alloc(165), sol.TOKEN_PROGRAM], m: [Buffer.alloc(82), sol.TOKEN_PROGRAM], x: [Buffer.alloc(36), 'BPFLoaderUpgradeab1e11111111111111111111111', true] }
  const addr = Object.fromEntries(Object.keys(kinds).map(k => [k, fresh()]))
  mock({ rpc: (method, params) => { const k = Object.keys(addr).find(x => addr[x] === params[0]); return { context: { slot: 1 }, value: k ? { ...account(kinds[k][0], kinds[k][1]), executable: !!kinds[k][2] } : null } } })
  try {
    assert.equal(await V.addressType(addr.w), 'wallet')
    assert.equal(await V.addressType(fresh()), 'new')
    assert.equal(await V.addressType(addr.t), 'token-account')
    assert.equal(await V.addressType(addr.m), 'mint')
    assert.equal(await V.addressType(addr.x), 'program')
  } finally { restore() }
})

// ---------- sending ----------

test('sendAll: the wallet signs first, the mint co-signs, both signatures verify', async () => {
  const user = throwaway(), mint = throwaway()
  const sent = []
  const account = { address: user.publicKey, chains: ['solana:mainnet'] }
  let used = ''
  const wallet = {
    features: {
      'solana:signTransaction': { signTransaction: async ({ transaction }) => { used = 'sign'; return [{ signedTransaction: await V.addSignatures(transaction, [user]) }] } },
      'solana:signAndSendTransaction': { signAndSendTransaction: async ({ transaction }) => { used = 'send'; const s = await V.addSignatures(transaction, [user]); sent.push(s); return [{ signature: sol.base58Decode(V.transactionId(s)) }] } },
    },
  }
  mock({
    rpc: (method, params) => {
      if (method === 'getLatestBlockhash') return { context: { slot: 1 }, value: { blockhash: fresh(), lastValidBlockHeight: 100 } }
      if (method === 'sendTransaction') { sent.push(Uint8Array.from(Buffer.from(params[0], 'base64'))); return 'sig' }
      if (method === 'getSignatureStatuses') return { context: { slot: 1 }, value: [{ confirmationStatus: 'confirmed', err: null }] }
      throw new Error(`unexpected ${method}`)
    },
  })
  try {
    const steps = []
    const plan = await V.launchTxs({ payer: user.publicKey, vault: fresh(), name: 'A', symbol: 'A', uri: 'https://a.example/m.json', buyLamports: 100_000_000n, mintKeypair: mint, settings: SETTINGS })
    const [signature] = await V.sendAll(plan.txs, s => steps.push(s.status), { wallet, account })
    assert.equal(used, 'sign')
    assert.deepEqual(steps, ['signing', 'sending', 'confirming', 'confirmed'])
    const tx = sent[0]
    const { signers, sigsAt, msgAt } = V.signersOf(tx)
    assert.deepEqual(signers, [user.publicKey, mint.publicKey])
    const message = tx.subarray(msgAt)
    assert.ok(user.verify(message, tx.subarray(sigsAt, sigsAt + 64)))
    assert.ok(mint.verify(message, tx.subarray(sigsAt + 64, sigsAt + 128)))
    assert.equal(signature, V.transactionId(tx))
    // Without extra signers the wallet sends it itself.
    sent.length = 0
    await V.sendAll([{ instructions: [sol.systemTransfer(user.publicKey, fresh(), 1n)] }], () => {}, { wallet, account })
    assert.equal(used, 'send')
    await assert.rejects(V.sendAll([], () => {}, { wallet: null, account: null }), /Connect a Solana wallet/)
  } finally { restore() }
})

test('launch: with the lookup table, one v0 transaction keeps the opening buy, the compute budget and the reference', async () => {
  const settings = SETTINGS.mainnet || SETTINGS
  const uri = 'https://ipfs.io/ipfs/bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy'
  assert.equal(V.LAUNCH_TABLE_ADDRESSES.length, 20)
  assert.equal(new Set(V.LAUNCH_TABLE_ADDRESSES).size, 20, 'no duplicates')
  assert.ok(V.LAUNCH_TABLE_ADDRESSES.includes(V.BOARD_REFERENCE))
  for (const b of settings.global.buybackFeeRecipients || []) assert.ok(V.BUYBACK_RECIPIENTS.includes(b), `buyback recipient ${b} is in the table`)
  const table = { key: fresh(), addresses: V.LAUNCH_TABLE_ADDRESSES }
  const sizes = []
  for (const [name, symbol] of [['Your Site', 'SITE'], ['x'.repeat(32), 'Y'.repeat(10)]]) {
    const payer = fresh(), vault = fresh(), mintKeypair = throwaway()
    const plan = await V.launchTxs({ payer, vault, name, symbol, uri, buyLamports: 1_500_000_000n, mintKeypair, settings, board: true, tables: [table] })
    assert.deepEqual([plan.version, plan.single, plan.txs.length], [0, true, 1])
    const [tx] = plan.txs
    assert.deepEqual(tx.lookupTables, [table])
    const ixs = tx.instructions
    assert.equal(hex(ixs[0].data), hex(V.computeUnitLimit(V.LAUNCH.bothUnits).data), 'the compute limit is back')
    assert.equal(hex(ixs[1].data), hex(V.computeUnitPrice(V.LAUNCH.microLamports).data), 'and the priority fee')
    assert.equal(hex(ixs[2].data), hex(V.loadedDataLimit(V.LAUNCH.loadedData).data), 'and an explicit loaded-data limit')
    const ataIx = ixs.find(ix => ix.programId === sol.ATA_PROGRAM)
    assert.equal(ataIx.keys.at(-1).pubkey, V.BOARD_REFERENCE, 'the reference rides on the buyer\'s token account')
    // the message: v0, the table named once, every looked-up account out of the static keys
    const message = sol.compileV0({ payer, recentBlockhash: fresh(), instructions: ixs, tables: [table] })
    assert.equal(message[0], 0x80)
    const statics = message[4]
    const keys = Array.from({ length: statics }, (_, i) => sol.base58Encode(message.subarray(5 + 32 * i, 5 + 32 * i + 32)))
    for (const k of keys) assert.ok(!V.LAUNCH_TABLE_ADDRESSES.includes(k) || k === sol.SYSTEM_PROGRAM && ixs.some(ix => ix.programId === k), `${k} is looked up, not inline`)
    assert.ok(Buffer.from(message).includes(Buffer.from(sol.pubkeyBytes(table.key))), 'the table is named')
    assert.equal(plan.size, V.v0Size(payer, ixs, [table]))
    assert.ok(plan.size <= V.LEGACY_LIMIT)
    sizes.push(`${name.length}/${symbol.length}: ${plan.size} bytes`)
  }
  // a table that doesn't help (wrong addresses) leaves the legacy layouts
  const legacy = await V.launchTxs({ payer: fresh(), vault: fresh(), name: 'Your Site', symbol: 'SITE', uri, buyLamports: 1_500_000_000n, mintKeypair: throwaway(), settings, board: true, tables: [{ key: fresh(), addresses: [fresh()] }] })
  assert.equal(legacy.version, undefined)
  assert.ok(!legacy.txs[0].lookupTables)
  console.log(`     (v0 over the launch table: ${sizes.join('; ')})`)
})

test('sendAll: a v0 launch, the wallet signs first, the mint co-signs, both verify over the v0 message', async () => {
  const settings = SETTINGS.mainnet || SETTINGS
  const user = throwaway(), mint = throwaway()
  const sent = []
  const account = { address: user.publicKey, chains: ['solana:mainnet'] }
  const wallet = { features: { 'solana:signTransaction': { supportedTransactionVersions: ['legacy', 0], signTransaction: async ({ transaction }) => [{ signedTransaction: await V.addSignatures(transaction, [user]) }] } } }
  assert.equal(sol.supportsV0({ wallet, account }), true)
  assert.equal(sol.supportsV0({ wallet: { features: { 'solana:signTransaction': { supportedTransactionVersions: ['legacy'] } } }, account }), false)
  assert.equal(sol.supportsV0({ wallet: null, account: null }), false)
  mock({
    rpc: (method, params) => {
      if (method === 'getLatestBlockhash') return { context: { slot: 1 }, value: { blockhash: fresh(), lastValidBlockHeight: 100 } }
      if (method === 'sendTransaction') { sent.push(Uint8Array.from(Buffer.from(params[0], 'base64'))); return 'sig' }
      if (method === 'getSignatureStatuses') return { context: { slot: 1 }, value: [{ confirmationStatus: 'confirmed', err: null }] }
      throw new Error(`unexpected ${method}`)
    },
  })
  try {
    const table = { key: fresh(), addresses: V.LAUNCH_TABLE_ADDRESSES }
    const plan = await V.launchTxs({ payer: user.publicKey, vault: fresh(), name: 'Your Site', symbol: 'SITE', uri: 'https://a.example/m.json', buyLamports: 100_000_000n, mintKeypair: mint, settings, board: true, tables: [table] })
    assert.equal(plan.version, 0)
    const [signature] = await V.sendAll(plan.txs, () => {}, { wallet, account })
    const tx = sent[0]
    const { signers, sigsAt, msgAt } = V.signersOf(tx)
    assert.equal(tx[msgAt], 0x80, 'sent as v0')
    assert.deepEqual(signers, [user.publicKey, mint.publicKey])
    const message = tx.subarray(msgAt)
    assert.ok(user.verify(message, tx.subarray(sigsAt, sigsAt + 64)))
    assert.ok(mint.verify(message, tx.subarray(sigsAt + 64, sigsAt + 128)))
    assert.equal(signature, V.transactionId(tx))
    assert.ok(tx.length <= V.LEGACY_LIMIT)
    // a wallet that only signs legacy never gets it
    const legacyOnly = { features: { 'solana:signTransaction': { supportedTransactionVersions: ['legacy'], signTransaction: async () => { throw new Error('asked to sign') } } } }
    await assert.rejects(V.sendAll(plan.txs, () => {}, { wallet: legacyOnly, account }), /version 0/)
    assert.equal(sent.length, 1)
  } finally { restore() }
})

test('launchTable: the table\'s addresses from Solana; a deactivated or missing table is no table', async () => {
  const table = (deactivation, addresses) => {
    const b = Buffer.alloc(56 + 32 * addresses.length)
    b.writeUInt32LE(1, 0); b.writeBigUInt64LE(deactivation, 4); b[21] = 1
    addresses.forEach((a, i) => Buffer.from(sol.pubkeyBytes(a)).copy(b, 56 + 32 * i))
    return b
  }
  let answer = null
  mock({ rpc: method => { if (method === 'getAccountInfo') return { context: { slot: 1 }, value: answer }; throw new Error(`unexpected ${method}`) } })
  try {
    answer = account(table(123n, V.LAUNCH_TABLE_ADDRESSES), sol.LOOKUP_TABLE_PROGRAM)
    await assert.rejects(sol.readLookupTable(V.LAUNCH_TABLE), /deactivated/)
    assert.equal(await V.launchTable(), null)
    answer = null
    assert.equal(await V.launchTable(), null)
    answer = account(table(2n ** 64n - 1n, V.LAUNCH_TABLE_ADDRESSES), sol.SYSTEM_PROGRAM)
    await assert.rejects(sol.readLookupTable(V.LAUNCH_TABLE), /No address lookup table/)
    answer = account(table(2n ** 64n - 1n, V.LAUNCH_TABLE_ADDRESSES), sol.LOOKUP_TABLE_PROGRAM)
    assert.deepEqual(await sol.readLookupTable(V.LAUNCH_TABLE), { key: V.LAUNCH_TABLE, addresses: V.LAUNCH_TABLE_ADDRESSES })
  } finally { restore() }
})

test('budget: SetLoadedAccountsDataSizeLimit is instruction 4 with a u32; a deposit sets limit, price and data limit', () => {
  const ix = V.loadedDataLimit(32 * 1024 * 1024)
  assert.equal(ix.programId, V.COMPUTE_BUDGET)
  assert.deepEqual([...ix.data], [4, 0, 0, 0, 2])
  const b = V.depositBudget(V.DEPOSIT.usdcUnits)
  assert.deepEqual(b.map(x => x.data[0]), [2, 3, 4])
  assert.equal(Buffer.from(b[0].data).readUInt32LE(1), V.DEPOSIT.usdcUnits)
})

test('sendAll: a transaction that would fail in simulation stops before the wallet is asked', async () => {
  const user = throwaway()
  const account = { address: user.publicKey, chains: ['solana:mainnet'] }
  let asked = 0
  const wallet = { features: { 'solana:signAndSendTransaction': { signAndSendTransaction: async () => { asked++; return [{ signature: new Uint8Array(64) }] } } } }
  let simulateErr = { InstructionError: [2, { Custom: 1 }] }
  mock({
    rpc: (method, params) => {
      if (method === 'getLatestBlockhash') return { context: { slot: 1 }, value: { blockhash: fresh(), lastValidBlockHeight: 100 } }
      if (method === 'simulateTransaction') {
        assert.equal(params[1].sigVerify, false)
        return { context: { slot: 1 }, value: { err: simulateErr, logs: ['Program log: Error: insufficient lamports'] } }
      }
      if (method === 'getSignatureStatuses') return { context: { slot: 1 }, value: [{ confirmationStatus: 'confirmed', err: null }] }
      throw new Error(`unexpected ${method}`)
    },
  })
  try {
    await assert.rejects(V.sendAll([{ instructions: [sol.systemTransfer(user.publicKey, fresh(), 1n)] }], () => {}, { wallet, account }), /would fail on Solana.*insufficient lamports/)
    assert.equal(asked, 0, 'the wallet never saw it')
    simulateErr = null
    await V.sendAll([{ instructions: [sol.systemTransfer(user.publicKey, fresh(), 1n)] }], () => {}, { wallet, account })
    assert.equal(asked, 1, 'a clean simulation goes on to the wallet')
  } finally { restore() }
})

test('coins: when the fallback refuses getProgramAccounts as too large, getProgramAccountsV2 pages answer it', async () => {
  const calls = []
  const accounts = [{ pubkey: fresh(), account: { data: ['', 'base64'] } }, { pubkey: fresh(), account: { data: ['', 'base64'] } }]
  mock({
    rpc: (method, params) => {
      calls.push([method, params[1].paginationKey || null, params[1].limit])
      if (method === 'getProgramAccounts') throw new Error('Too many accounts requested (5000001 rows), Please use getProgramAccountsV2 with pagination to handle large datasets.')
      if (method === 'getProgramAccountsV2') return params[1].paginationKey ? { accounts: [accounts[1]], paginationKey: null } : { accounts: [accounts[0]], paginationKey: 'next' }
      throw new Error(`unexpected ${method}`)
    },
  })
  try {
    const out = await V.programAccounts([V.PUMP.program, { encoding: 'base64', filters: [{ memcmp: { offset: 0, bytes: 'x' } }] }])
    assert.deepEqual(out, accounts)
    assert.deepEqual(calls, [['getProgramAccounts', null, undefined], ['getProgramAccountsV2', null, 10000], ['getProgramAccountsV2', 'next', 10000]])
  } finally { restore() }
})

test('programError reads pump errors from simulation messages and statuses', () => {
  assert.deepEqual(V.programError({ message: 'Transaction simulation failed: Error processing Instruction 4: custom program error: 0x1772' }).code, 6002)
  assert.equal(V.programError({ message: 'Transaction failed on Solana: {"InstructionError":[4,{"Custom":6002}]}' }).instruction, 4)
  assert.match(V.programError({ message: 'custom program error: 0x1772' }).text, /price moved/)
  assert.equal(V.programError(new Error('User rejected the request')), null)
})

// ---------- run ----------

let failed = 0
for (const [name, fn] of Object.entries(tests)) {
  try {
    const r = await fn()
    console.log(typeof r === 'string' && r.startsWith('skip') ? `skip ${name} (${r.slice(6)})` : `ok   ${name}`)
  } catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.stack || err.message}`) }
}
console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
