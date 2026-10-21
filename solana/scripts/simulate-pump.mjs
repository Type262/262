// Prove the pump.fun interface our launcher calls, against live mainnet state. Every transaction here is only
// simulated (simulateTransaction with sigVerify:false and replaceRecentBlockhash:true): nothing is signed and
// nothing is sent, so any address can stand in as a signer.
//   node solana/scripts/simulate-pump.mjs                  every scenario
//   node solana/scripts/simulate-pump.mjs create probes    some of them
// Env: SOLANA_RPC (comma-separated endpoints), PAYER (a funded system account to borrow as fee payer),
//      COIN / POOL_COIN / HOLDER_COIN / HOLDER_POOL_COIN (coins to collect from; picked from recent trades
//      otherwise), WHALE (a wallet with ~200 SOL to stand in as the buyer that completes a curve),
//      TYPE262_PROGRAM_ID (our program id once deployed; the localnet id from Anchor.toml otherwise).
import { createHash } from 'node:crypto'
import * as L from './pump-lib.mjs'
import * as X from './pump-ix.mjs'

const json = o => JSON.stringify(o, (k, v) => typeof v === 'bigint' ? v.toString() : v)
const sha = s => createHash('sha256').update(s).digest()

// The creator is the launcher's PDA ["creator", domain_hash], domain_hash = sha256(canonical name). Our
// program is not on mainnet, so the localnet id from Anchor.toml stands in: what matters is that the
// creator is an off-curve address no key can sign for.
const TYPE262 = process.env.TYPE262_PROGRAM_ID || '3fhiMDY5kyCpX47HU1whuEe6vMQFHPa1hwGhc4Pp72NT'
const DOMAIN = 'example.com'
const [CREATOR, CREATOR_BUMP] = L.findPda(['creator', sha(DOMAIN)], TYPE262)

let global, rentFloor

// Recent pump and PumpSwap transactions give us live coins to collect from and a funded wallet to borrow as
// the fee payer: a payer has to exist and hold SOL even when signatures are not checked. It never signs.
async function scanRecent() {
  const payers = [], mints = new Set()
  for (const program of [L.PUMP, L.PUMP_AMM]) {
    const sigs = await L.rpc('getSignaturesForAddress', [program, { limit: 25 }])
    for (const s of sigs) {
      if (s.err) continue
      const tx = await L.rpc('getTransaction', [s.signature, { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }])
      if (!tx) continue
      payers.push(tx.transaction.message.accountKeys[0])
      for (const b of tx.meta.postTokenBalances || []) if (b.programId === L.TOKEN_2022 || b.mint.endsWith('pump')) mints.add(b.mint)
    }
  }
  return { payers: [...new Set(payers)], mints: [...mints] }
}

async function borrowPayer(candidates) {
  if (process.env.PAYER) return process.env.PAYER
  for (const [i, a] of (await L.getAccounts(candidates)).entries()) {
    if (a && a.owner === L.SYSTEM && a.data.length === 0 && a.lamports >= 0.3e9) return candidates[i]
  }
  throw new Error('no funded payer found; set PAYER')
}

// Pick coins with creator fees actually waiting, so the collects move real money in the simulation:
// a wallet-creator coin on the curve, a graduated wallet-creator coin's pool, and a holder-rewards coin
// (creator = an off-curve pump PDA). COIN / POOL_COIN / HOLDER_COIN override the choice.
async function pickCoins(mints) {
  const picked = { curve: process.env.COIN, pool: process.env.POOL_COIN, holder: process.env.HOLDER_COIN, holderPool: process.env.HOLDER_POOL_COIN }
  const curves = await L.getAccounts(mints.map(m => X.bondingCurvePda(m)))
  let anyHolder
  for (const [i, a] of curves.entries()) {
    if (!a || a.owner !== L.PUMP) continue
    const mint = mints[i], bc = L.readBondingCurve(a.data)
    if (bc.quoteMint !== L.SYSTEM && bc.quoteMint !== L.WSOL) continue // SOL-paired only
    const [creator, vault] = await L.getAccounts([bc.creator, X.creatorVaultPda(bc.creator)])
    const waiting = bc.creatorFee + BigInt(Math.max(0, (vault?.lamports ?? 0) - rentFloor))
    const wallet = creator && creator.owner === L.SYSTEM && creator.lamports >= rentFloor && L.isOnCurve(L.pk(bc.creator))
    if (!picked.holder && bc.isHolderReward && waiting > 0n) picked.holder = mint
    if (bc.isHolderReward) anyHolder ||= mint
    if (!picked.curve && wallet && !bc.isHolderReward && waiting > 0n) picked.curve = mint
    if ((!picked.pool || !picked.holderPool) && bc.complete) {
      const p = await L.getAccount(X.canonicalPoolPda(mint))
      if (!p) continue
      const pool = L.readPool(p.data)
      const owner = await L.getAccount(pool.coinCreator)
      if (!picked.pool && pool.creatorFees > 0n && owner?.owner === L.SYSTEM && !pool.isHolderReward && L.isOnCurve(L.pk(pool.coinCreator))) picked.pool = mint
      if (!picked.holderPool && pool.creatorFees > 0n && pool.isHolderReward) picked.holderPool = mint
    }
    if (picked.curve && picked.pool && picked.holder && picked.holderPool) break
  }
  // A holder-rewards coin with nothing waiting still shows the collect is accepted for an off-curve creator.
  picked.holder ||= anyHolder
  return picked
}

function report(title, r, extra = () => {}) {
  console.log(`\n=== ${title}`)
  console.log(`${r.version} tx: ${r.size} bytes, ${r.accountCount} accounts, signers [${r.signers.join(', ')}]`)
  console.log(`result: ${r.err ? 'FAILED ' + json(r.err) : 'ok'}, ${r.unitsConsumed} CU`)
  const keep = r.logs.filter(l => /Instruction: |failed|error|Error|insufficient|rent|Program 6EF8|Program pAMM|Program pfee|Program MAyh/.test(l) && !/consumed|success$/.test(l))
  for (const l of keep.slice(0, 40)) console.log('  | ' + l)
  if (!r.err) extra(r)
  return r
}

const acct = (r, k) => r.accounts.find(a => a && a.pubkey === k)

// ---------- scenarios ----------

async function create(payer) {
  const mint = L.randomOnCurve()
  const curve = X.bondingCurvePda(mint)
  const userAta = L.ata(payer, mint, L.TOKEN_2022)
  const ixs = [
    X.createV2({ mint, user: payer, creator: CREATOR, name: 'Example', symbol: 'EX', uri: 'https://example.com/m.json' }),
    X.createAtaIdempotent({ payer, owner: payer, mint, tokenProgram: L.TOKEN_2022 }),
    X.buyV3({ mint, user: payer, amount: 100_000_000_000n, maxSolCost: 50_000_000n, buyback: global.buybackFeeRecipients[0] }),
  ]
  const r = await L.simulate(payer, ixs, [curve, mint, userAta, CREATOR])
  return report(`create_v2 + buy_v3, creator = off-curve PDA ${CREATOR} (bump ${CREATOR_BUMP}, program ${TYPE262})`, r, r => {
    const bc = L.readBondingCurve(acct(r, curve).data)
    const m = acct(r, mint)
    console.log(`  bonding curve: creator=${bc.creator} (matches PDA: ${bc.creator === CREATOR}), creator_fee waiting=${bc.creatorFee} lamports, protocol_fees=${bc.protocolFees}, quote_mint=${bc.quoteMint}, holder=${bc.isHolderReward}, mayhem=${bc.isMayhemMode}, ${bc.dataLen} bytes`)
    console.log(`  reserves: virtual token ${bc.virtualTokenReserves}, virtual quote ${bc.virtualQuoteReserves}, real token ${bc.realTokenReserves}, real quote ${bc.realQuoteReserves}`)
    console.log(`  mint: owner=${m.owner} ${json(L.readMint(m.data))} metadata=${json(L.readToken2022Metadata(m.data))}`)
    console.log(`  buyer token balance: ${L.readTokenAccount(acct(r, userAta).data).amount}; creator PDA account after: ${acct(r, CREATOR) ? acct(r, CREATOR).lamports + ' lamports' : 'none (never touched)'}`)
  })
}

// The whole bonding-curve life of a launch in one transaction: create, buy, sweep the creator fee into
// creator-vault(creator), collect it onto the creator. Too big for 1232 bytes, so it uses the v1 format.
// mode 'unfunded': the creator PDA does not exist yet. 'funded': it holds the rent-exempt minimum, as the
// launcher will leave it. 'program-owned': the creator is an existing account that holds data and is owned by
// another program (the mayhem program's global-params account stands in for a PDA our program owns).
async function createAndCollect(payer, mode) {
  const creator = mode === 'program-owned' ? X.MAYHEM_GLOBAL_PARAMS : CREATOR
  const before = await L.getAccount(creator)
  const mint = L.randomOnCurve()
  const curve = X.bondingCurvePda(mint)
  const vault = X.creatorVaultPda(creator)
  const ixs = [
    X.createV2({ mint, user: payer, creator, name: 'Example', symbol: 'EX', uri: 'https://example.com/m.json' }),
    X.createAtaIdempotent({ payer, owner: payer, mint, tokenProgram: L.TOKEN_2022 }),
    X.buyV3({ mint, user: payer, amount: 100_000_000_000n, maxSolCost: 50_000_000n, buyback: global.buybackFeeRecipients[0] }),
    X.sweepCreatorFee({ payer, mint, creator }),
  ]
  // Stands in for the launcher creating the creator PDA rent-exempt at launch. The minimum comes from the
  // cluster: mainnet rent is 5080 lamports/byte-year with a 1-year threshold now, not the old 3480 x 2.
  if (mode === 'funded') ixs.push(X.transferLamports({ from: payer, to: creator, lamports: rentFloor }))
  ixs.push(X.collectCreatorFeeV2({ creator }))
  const r = await L.simulate(payer, ixs, [curve, vault, creator], { version: 'v1' })
  return report(`create_v2 + buy_v3 + sweep_creator_fee + collect_creator_fee_v2, creator ${creator} (${mode}, owner before: ${before ? before.owner + ', ' + before.data.length + ' data bytes' : 'no account'})`, r, r => {
    const bc = L.readBondingCurve(acct(r, curve).data)
    const v = acct(r, vault), c = acct(r, creator)
    const start = mode === 'funded' ? rentFloor : (before?.lamports ?? 0)
    console.log(`  after: curve creator_fee waiting=${bc.creatorFee}, creator vault=${v ? v.lamports : 0} lamports, creator=${c ? c.lamports : 0} lamports (+${(c ? c.lamports : 0) - start} collected), owner ${c?.owner}`)
  })
}

// Graduation with our PDA as creator. A buy past the curve's real reserves completes it in one go
// (synthetic migration) and fits in one v1 transaction with the create. migrate_v2 does not: its CPIs take
// the 64-entry instruction trace over the limit, and simulations cannot chain, so what migration does with
// the creator is read off live graduated coins instead: pool.coin_creator must equal bonding_curve.creator,
// including the off-curve holder-rewards PDAs. The buyer needs ~90 SOL, so one of pump.fun's fee wallets
// stands in as the buyer (WHALE overrides): this is a simulation, nothing is signed.
async function graduate(mints) {
  const whale = process.env.WHALE || global.feeRecipients[0]
  const mint = L.randomOnCurve()
  const curve = X.bondingCurvePda(mint)
  const ixs = [
    X.createV2({ mint, user: whale, creator: CREATOR, name: 'Example', symbol: 'EX', uri: 'https://example.com/m.json' }),
    X.createAtaIdempotent({ payer: whale, owner: whale, mint, tokenProgram: L.TOKEN_2022 }),
    // More than the curve's 793.1M real tokens: completes the curve and buys on into the would-be pool.
    X.buyV3({ mint, user: whale, amount: 900_000_000_000_000n, maxSolCost: 300_000_000_000n, buyback: global.buybackFeeRecipients[0] }),
    X.sweepCreatorFee({ payer: whale, mint, creator: CREATOR }),
  ]
  const r = await L.simulate(whale, ixs, [curve, X.creatorVaultPda(CREATOR)], { version: 'v1' })
  report(`completion: create_v2 -> buy_v3 past the curve -> sweep_creator_fee (buyer ${whale})`, r, r => {
    const bc = L.readBondingCurve(acct(r, curve).data)
    console.log(`  curve: complete=${bc.complete}, creator=${bc.creator}, real quote raised=${L.sol(bc.realQuoteReserves)} SOL, post-complete leg ${bc.postCompleteBaseOut} tokens for ${bc.postCompleteQuoteIn} lamports`)
    console.log(`  creator vault after the sweep: ${acct(r, X.creatorVaultPda(CREATOR)).lamports} lamports (curve creator_fee now ${bc.creatorFee})`)
  })
  console.log('\n=== migration keeps the creator: live graduated coins, bonding_curve.creator vs canonical pool.coin_creator')
  const curves = await L.getAccounts(mints.map(m => X.bondingCurvePda(m)))
  let n = 0
  for (const [i, a] of curves.entries()) {
    if (!a || a.owner !== L.PUMP) continue
    const bc = L.readBondingCurve(a.data)
    if (!bc.complete) continue
    const p = await L.getAccount(X.canonicalPoolPda(mints[i], bc.quoteMint === L.SYSTEM ? L.WSOL : bc.quoteMint))
    if (!p) continue
    const pool = L.readPool(p.data)
    const kind = bc.creator === X.sharingConfigPda(mints[i]) ? 'sharing_config' : bc.isHolderReward ? 'holder-rewards PDA' : L.isOnCurve(L.pk(bc.creator)) ? 'wallet' : 'off-curve'
    console.log(`  ${mints[i]}: curve creator ${bc.creator} (${kind}) -> pool coin_creator ${pool.coinCreator}: ${pool.coinCreator === bc.creator ? 'same' : 'DIFFERENT'}`)
    if (++n >= 8) break
  }
}

async function collectCurve(payer, coin) {
  const bc = L.readBondingCurve((await L.getAccount(X.bondingCurvePda(coin))).data)
  const creator = bc.creator
  const vault = X.creatorVaultPda(creator)
  const [cBefore, vBefore] = await L.getAccounts([creator, vault])
  const ixs = [X.sweepCreatorFee({ payer, mint: coin, creator }), X.collectCreatorFeeV2({ creator })]
  const r = await L.simulate(payer, ixs, [creator, vault, X.bondingCurvePda(coin)])
  return report(`sweep_creator_fee + collect_creator_fee_v2 on ${coin} (${bc.complete ? 'graduated' : 'on the curve'}, creator ${creator}, payer ${payer}: the creator does not sign)`, r, r => {
    const bcAfter = L.readBondingCurve(acct(r, X.bondingCurvePda(coin)).data)
    console.log(`  before: curve creator_fee=${bc.creatorFee}, vault=${vBefore?.lamports ?? 0}, creator=${cBefore?.lamports ?? 0}`)
    console.log(`  after:  curve creator_fee=${bcAfter.creatorFee}, vault=${acct(r, vault).lamports}, creator=${acct(r, creator).lamports} (+${acct(r, creator).lamports - (cBefore?.lamports ?? 0)} lamports)`)
  })
}

async function collectPool(payer, coin) {
  const poolKey = X.canonicalPoolPda(coin)
  const pool = L.readPool((await L.getAccount(poolKey)).data)
  const dest = L.ata(pool.coinCreator, L.WSOL, L.TOKEN)
  const ixs = [
    X.ammSweepCreatorFee({ payer, pool: poolKey, coinCreator: pool.coinCreator, poolQuoteTokenAccount: pool.poolQuoteTokenAccount }),
    // collect_coin_creator_fee needs an existing WSOL account owned by the coin creator; anyone can create the ATA.
    X.createAtaIdempotent({ payer, owner: pool.coinCreator, mint: L.WSOL, tokenProgram: L.TOKEN }),
    X.collectCoinCreatorFee({ coinCreator: pool.coinCreator, coinCreatorTokenAccount: dest }),
  ]
  const vaultAta = L.ata(X.ammCreatorVaultPda(pool.coinCreator), L.WSOL, L.TOKEN)
  const r = await L.simulate(payer, ixs, [poolKey, dest, vaultAta])
  return report(`PumpSwap sweep_creator_fee + collect_coin_creator_fee on pool ${poolKey} of ${coin} (coin_creator ${pool.coinCreator}, on curve: ${L.isOnCurve(L.pk(pool.coinCreator))}, not signing)`, r, r => {
    const after = L.readPool(acct(r, poolKey).data)
    console.log(`  pool creator_fees waiting: ${pool.creatorFees} -> ${after.creatorFees}; creator WSOL account now holds ${L.readTokenAccount(acct(r, dest).data).amount} (wrapped SOL, owner ${L.readTokenAccount(acct(r, dest).data).owner})`)
  })
}

// pump.fun's own holder-rewards coins have an off-curve PDA as creator, and the same permissionless collect
// pays it: the closest live precedent for a coin whose creator is our PDA.
async function collectOffCurve(payer, coin) {
  const bc = L.readBondingCurve((await L.getAccount(X.bondingCurvePda(coin))).data)
  const creator = bc.creator
  const before = await L.getAccount(creator)
  const ixs = [X.sweepCreatorFee({ payer, mint: coin, creator }), X.collectCreatorFeeV2({ creator })]
  const r = await L.simulate(payer, ixs, [creator, X.creatorVaultPda(creator)])
  return report(`collect into an off-curve creator: ${coin}, creator ${creator} (on curve: ${L.isOnCurve(L.pk(creator))}, holder-rewards PDA: ${creator === X.holderRewardsPda(coin)})`, r, r => {
    console.log(`  creator PDA: ${before?.lamports ?? 0} -> ${acct(r, creator).lamports} lamports, owner ${acct(r, creator).owner}`)
  })
}

// Who else can move a coin's fees? Each probe runs on a coin created in the same simulated transaction,
// with creator = our PDA, so no live coin is involved.
async function probes(payer, coins) {
  const fresh = (mayhem = false) => {
    const mint = L.randomOnCurve()
    return { mint, create: X.createV2({ mint, user: payer, creator: CREATOR, name: 'Example', symbol: 'EX', uri: 'https://example.com/m.json', mayhem }) }
  }
  const out = {}
  let c = fresh()
  out.metaplex = report('probe: set_metaplex_creator (permissionless) on a create_v2 coin', await L.simulate(payer, [c.create, X.setMetaplexCreator({ mint: c.mint })]))

  c = fresh()
  out.setCreator = report(`probe: set_creator signed by Global.set_creator_authority ${global.setCreatorAuthority}`,
    await L.simulate(payer, [c.create, X.setCreator({ authority: global.setCreatorAuthority, mint: c.mint, creator: payer })], [X.bondingCurvePda(c.mint)]),
    r => console.log(`  curve creator after: ${L.readBondingCurve(acct(r, X.bondingCurvePda(c.mint)).data).creator}`))

  // The legacy SPL Token create still works, and on such a coin set_creator / set_metaplex_creator run, but
  // they only fill in a missing creator: an existing one is left as it is.
  const legacyMint = L.randomOnCurve()
  const legacy = X.createLegacy({ mint: legacyMint, user: payer, creator: CREATOR, name: 'Example', symbol: 'EX', uri: 'https://example.com/m.json' })
  out.legacySetCreator = report('probe: legacy create + set_creator (set_creator_authority) + set_metaplex_creator',
    await L.simulate(payer, [legacy, X.setCreator({ authority: global.setCreatorAuthority, mint: legacyMint, creator: payer }), X.setMetaplexCreator({ mint: legacyMint })], [X.bondingCurvePda(legacyMint)]),
    r => console.log(`  curve creator after both: ${L.readBondingCurve(acct(r, X.bondingCurvePda(legacyMint)).data).creator} (unchanged: ${L.readBondingCurve(acct(r, X.bondingCurvePda(legacyMint)).data).creator === CREATOR})`))

  // set_coin_creator is permissionless: on a live graduated Token-2022 coin it must leave coin_creator alone.
  if (coins.pool) {
    const poolKey = X.canonicalPoolPda(coins.pool)
    const before = L.readPool((await L.getAccount(poolKey)).data).coinCreator
    const mintOwner = (await L.getAccount(coins.pool)).owner
    out.setCoinCreator = report(`probe: set_coin_creator (permissionless) on the live pool of ${coins.pool} (mint owner ${mintOwner})`,
      await L.simulate(payer, [X.setCoinCreator({ pool: poolKey, mint: coins.pool })], [poolKey]),
      r => console.log(`  coin_creator ${before} -> ${L.readPool(acct(r, poolKey).data).coinCreator}`))
  }

  c = fresh()
  out.sharingStranger = report('probe: create_fee_sharing_config paid by someone who is not the creator',
    await L.simulate(payer, [c.create, X.createFeeSharingConfig({ payer, mint: c.mint })]))

  c = fresh()
  const sc = X.sharingConfigPda(c.mint)
  out.sharingCreator = report('probe: create_fee_sharing_config signed by the creator PDA (what an invoke_signed from our program could do)',
    await L.simulate(payer, [c.create, X.transferLamports({ from: payer, to: CREATOR, lamports: 20_000_000 }), X.createFeeSharingConfig({ payer: CREATOR, mint: c.mint })], [sc, X.bondingCurvePda(c.mint)]),
    r => console.log(`  sharing_config ${json(L.readSharingConfig(acct(r, sc).data))}; curve creator now ${L.readBondingCurve(acct(r, X.bondingCurvePda(c.mint)).data).creator}`))

  c = fresh()
  out.sharingAdmin = report(`probe: create_fee_sharing_config signed by Global.admin_set_creator_authority ${global.adminSetCreatorAuthority}`,
    await L.simulate(payer, [c.create, X.createFeeSharingConfig({ payer: global.adminSetCreatorAuthority, mint: c.mint })], [X.sharingConfigPda(c.mint)]),
    r => console.log(`  sharing_config ${json(L.readSharingConfig(acct(r, X.sharingConfigPda(c.mint)).data))}`))

  // If pump.fun's admin moves our coin to a sharing config anyway, the fees still reach only our PDA: it is
  // the config's admin and sole shareholder, and the permissionless distribute pays it.
  c = fresh()
  out.sharingPayout = report('probe: admin-created sharing config, then buy_v3 + sweep_creator_fee + distribute_creator_fees_v2',
    await L.simulate(payer, [
      c.create,
      X.createFeeSharingConfig({ payer: global.adminSetCreatorAuthority, mint: c.mint }),
      X.createAtaIdempotent({ payer, owner: payer, mint: c.mint, tokenProgram: L.TOKEN_2022 }),
      X.buyV3({ mint: c.mint, user: payer, amount: 100_000_000_000n, maxSolCost: 50_000_000n, buyback: global.buybackFeeRecipients[0] }),
      X.sweepCreatorFee({ payer, mint: c.mint, creator: X.sharingConfigPda(c.mint) }),
      X.transferLamports({ from: payer, to: CREATOR, lamports: rentFloor }),
      X.distributeCreatorFeesV2({ payer, mint: c.mint, shareholders: [CREATOR] }),
    ], [CREATOR], { version: 'v1' }),
    r => console.log(`  creator PDA after distribute: ${acct(r, CREATOR).lamports} lamports (${acct(r, CREATOR).lamports - rentFloor} above the rent floor)`))

  c = fresh()
  out.cto = report(`probe: admin_cto (new_creator = payer) signed by Global.admin_set_creator_authority`,
    await L.simulate(payer, [c.create, X.adminCto({ authority: global.adminSetCreatorAuthority, mint: c.mint, currentCreator: CREATOR, newCreator: payer })], [X.bondingCurvePda(c.mint)], { version: 'v1' }),
    r => console.log(`  curve creator after: ${L.readBondingCurve(acct(r, X.bondingCurvePda(c.mint)).data).creator}`))

  c = fresh(true)
  out.ctoMayhem = report('probe: admin_cto on a mayhem-mode coin',
    await L.simulate(payer, [c.create, X.adminCto({ authority: global.adminSetCreatorAuthority, mint: c.mint, currentCreator: CREATOR, newCreator: payer })], [], { version: 'v1' }))
  return out
}

// ---------- main ----------

const all = ['create', 'create-collect', 'graduate', 'collect-curve', 'collect-pool', 'collect-offcurve', 'collect-pool-offcurve', 'probes']
const pick = process.argv.slice(2).length ? process.argv.slice(2) : all
for (const s of pick) if (!all.includes(s)) throw new Error(`unknown scenario ${s}; one of ${all.join(', ')}`)
global = L.readGlobal((await L.getAccount(X.GLOBAL)).data)
rentFloor = await L.rpc('getMinimumBalanceForRentExemption', [0])
const recent = await scanRecent()
const payer = await borrowPayer(recent.payers)
const coins = pick.some(s => s.startsWith('collect-') || s === 'probes') ? await pickCoins(recent.mints) : {}
console.log(`payer (borrowed, never signs): ${payer}`)
console.log(`Global: create_v2 enabled=${global.createV2Enabled}, holder rewards enabled=${global.isHolderRewardEnabled}, mayhem enabled=${global.mayhemModeEnabled}, set_creator_authority=${global.setCreatorAuthority}, admin_set_creator_authority=${global.adminSetCreatorAuthority}; rent-exempt floor for 0 bytes ${rentFloor}`)
if (Object.keys(coins).length) console.log(`coins: ${json(coins)}`)
const skip = what => console.log(`
=== ${what}: no live coin with fees waiting in the recent transactions; set it by env and rerun`)
for (const s of pick) {
  if (s === 'create') await create(payer)
  else if (s === 'create-collect') for (const m of ['unfunded', 'funded', 'program-owned']) await createAndCollect(payer, m)
  else if (s === 'graduate') await graduate(recent.mints)
  else if (s === 'collect-curve') coins.curve ? await collectCurve(payer, coins.curve) : skip(s)
  else if (s === 'collect-pool') coins.pool ? await collectPool(payer, coins.pool) : skip(s)
  else if (s === 'collect-offcurve') coins.holder ? await collectOffCurve(payer, coins.holder) : skip(s)
  else if (s === 'collect-pool-offcurve') coins.holderPool ? await collectPool(payer, coins.holderPool) : skip(s)
  else if (s === 'probes') await probes(payer, coins)
}
