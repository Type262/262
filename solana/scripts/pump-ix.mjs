// Hand-encoded pump.fun instructions: account order, writable/signer flags and argument encoding copied from
// the IDLs in pump-fun/pump-public-docs (idl/pump.json, pump_amm.json, pump_fees.json, October 2026).
// Discriminators are Anchor's sha256("global:<name>")[..8], which match the IDLs.
import {
  PUMP, PUMP_AMM, PUMP_FEES, MAYHEM, SYSTEM, TOKEN, TOKEN_2022, ATA_PROGRAM, METAPLEX, WSOL,
  pk, pda, ata, anchorIx, meta, str, bool, u8, u16, u64,
} from './pump-lib.mjs'

const ix = (programId, keys, data) => ({ programId, keys, data: Buffer.concat(data) })
const optionBool = v => bool(v) // OptionBool / OptionU64 are one-field structs, not Option<T>: no tag byte
const borshOption = enc => v => v === undefined || v === null ? u8(0) : Buffer.concat([u8(1), enc(v)])

// ---------- PDAs ----------

export const GLOBAL = pda(['global'], PUMP)
export const MINT_AUTHORITY = pda(['mint-authority'], PUMP)
export const PUMP_EVENT_AUTHORITY = pda(['__event_authority'], PUMP)
export const AMM_EVENT_AUTHORITY = pda(['__event_authority'], PUMP_AMM)
export const FEES_EVENT_AUTHORITY = pda(['__event_authority'], PUMP_FEES)
export const AMM_GLOBAL_CONFIG = pda(['global_config'], PUMP_AMM)
export const PUMP_FEE_CONFIG = pda(['fee_config', pk(PUMP)], PUMP_FEES)
export const AMM_FEE_CONFIG = pda(['fee_config', pk(PUMP_AMM)], PUMP_FEES)
export const GLOBAL_VOLUME_ACCUMULATOR = pda(['global_volume_accumulator'], PUMP)
export const AMM_GLOBAL_VOLUME_ACCUMULATOR = pda(['global_volume_accumulator'], PUMP_AMM)
export const QUOTE_CONTROL = pda(['quote-control'], PUMP)
export const MAYHEM_GLOBAL_PARAMS = pda(['global-params'], MAYHEM)
export const MAYHEM_SOL_VAULT = pda(['sol-vault'], MAYHEM)

export const bondingCurvePda = mint => pda(['bonding-curve', pk(mint)], PUMP)
export const creatorVaultPda = creator => pda(['creator-vault', pk(creator)], PUMP)
export const sharingConfigPda = mint => pda(['sharing-config', pk(mint)], PUMP_FEES)
export const holderRewardsPda = mint => pda(['holder-rewards', pk(mint)], PUMP)
export const poolAuthorityPda = mint => pda(['pool-authority', pk(mint)], PUMP)
export const userVolumeAccumulatorPda = user => pda(['user_volume_accumulator', pk(user)], PUMP)
export const mayhemStatePda = mint => pda(['mayhem-state', pk(mint)], MAYHEM)
export const metaplexMetadataPda = mint => pda(['metadata', pk(METAPLEX), pk(mint)], METAPLEX)
// The canonical PumpSwap pool a graduated coin migrates into: index 0, created by pump's pool-authority PDA.
export const canonicalPoolPda = (mint, quoteMint = WSOL) => pda(['pool', u16(0), pk(poolAuthorityPda(mint)), pk(mint), pk(quoteMint)], PUMP_AMM)
export const ammCreatorVaultPda = coinCreator => pda(['creator_vault', pk(coinCreator)], PUMP_AMM)

// ---------- Pump (bonding curve) ----------

// create_v2: a Token-2022 coin (6 decimals, metadata in the mint) and its bonding curve. `creator` is plain
// instruction data: it never signs, and every creator fee of the coin accrues to creator-vault(creator).
export function createV2({ mint, user, creator, name, symbol, uri, mayhem = false, holderReward = false }) {
  return ix(PUMP, [
    meta(mint, { w: true, s: true }),
    meta(MINT_AUTHORITY),
    meta(bondingCurvePda(mint), { w: true }),
    meta(ata(bondingCurvePda(mint), mint, TOKEN_2022), { w: true }),
    meta(GLOBAL),
    meta(user, { w: true, s: true }),
    meta(SYSTEM),
    meta(TOKEN_2022),
    meta(ATA_PROGRAM),
    meta(MAYHEM, { w: true }),
    meta(MAYHEM_GLOBAL_PARAMS),
    meta(MAYHEM_SOL_VAULT, { w: true }),
    meta(mayhemStatePda(mint), { w: true }),
    meta(ata(MAYHEM_SOL_VAULT, mint, TOKEN_2022), { w: true }),
    meta(PUMP_EVENT_AUTHORITY),
    meta(PUMP),
  ], [anchorIx('create_v2'), str(name), str(symbol), str(uri), pk(creator), bool(mayhem),
    optionBool(false), u64(0), optionBool(holderReward)]) // is_cashback_enabled (must be false), creator_fee_bps, is_holder_reward
}

// create: the legacy SPL Token coin with Metaplex metadata. Still accepted; only used here to show why the
// launcher uses create_v2.
export function createLegacy({ mint, user, creator, name, symbol, uri }) {
  const curve = bondingCurvePda(mint)
  return ix(PUMP, [
    meta(mint, { w: true, s: true }),
    meta(MINT_AUTHORITY),
    meta(curve, { w: true }),
    meta(ata(curve, mint, TOKEN), { w: true }),
    meta(GLOBAL),
    meta(METAPLEX),
    meta(metaplexMetadataPda(mint), { w: true }),
    meta(user, { w: true, s: true }),
    meta(SYSTEM),
    meta(TOKEN),
    meta(ATA_PROGRAM),
    meta('SysvarRent111111111111111111111111111111111'),
    meta(PUMP_EVENT_AUTHORITY),
    meta(PUMP),
  ], [anchorIx('create'), str(name), str(symbol), str(uri), pk(creator)])
}

// buy_v3 (17 accounts): fees stay on the curve (BondingCurve.creator_fee / protocol_fees) until swept.
export function buyV3({ mint, user, amount, maxSolCost, buyback, quoteMint = WSOL, baseTokenProgram = TOKEN_2022, quoteTokenProgram = TOKEN }) {
  const curve = bondingCurvePda(mint)
  return ix(PUMP, [
    meta(GLOBAL),
    meta(mint),
    meta(quoteMint),
    meta(baseTokenProgram),
    meta(quoteTokenProgram),
    meta(curve, { w: true }),
    meta(ata(curve, mint, baseTokenProgram), { w: true }),
    meta(ata(curve, quoteMint, quoteTokenProgram), { w: true }),
    meta(user, { w: true, s: true }),
    meta(ata(user, mint, baseTokenProgram), { w: true }),
    meta(ata(user, quoteMint, quoteTokenProgram), { w: true }),
    meta(userVolumeAccumulatorPda(user), { w: true }),
    meta(PUMP_FEE_CONFIG),
    meta(buyback, { w: true }),
    meta(SYSTEM),
    meta(PUMP_EVENT_AUTHORITY),
    meta(PUMP),
  ], [anchorIx('buy_v3'), u64(amount), u64(maxSolCost), optionBool(false)])
}

// sweep_creator_fee: permissionless, moves BondingCurve.creator_fee into creator-vault(bonding_curve.creator).
// The destination is fixed by the program; the payer only covers rent top-ups.
export function sweepCreatorFee({ payer, mint, creator, quoteMint = WSOL, quoteTokenProgram = TOKEN }) {
  const curve = bondingCurvePda(mint)
  const vault = creatorVaultPda(creator)
  return ix(PUMP, [
    meta(payer, { w: true, s: true }),
    meta(GLOBAL),
    meta(mint),
    meta(quoteMint),
    meta(quoteTokenProgram),
    meta(ATA_PROGRAM),
    meta(SYSTEM),
    meta(curve, { w: true }),
    meta(ata(curve, quoteMint, quoteTokenProgram), { w: true }),
    meta(vault, { w: true }),
    meta(ata(vault, quoteMint, quoteTokenProgram), { w: true }),
    meta(PUMP_EVENT_AUTHORITY),
    meta(PUMP),
  ], [anchorIx('sweep_creator_fee')])
}

// collect_creator_fee_v2: permissionless, pays creator-vault(creator) out to `creator` (lamports on a SOL
// quote, leaving the vault rent-exempt). `creator` is writable but never a signer.
export function collectCreatorFeeV2({ creator, quoteMint = WSOL, quoteTokenProgram = TOKEN }) {
  const vault = creatorVaultPda(creator)
  return ix(PUMP, [
    meta(creator, { w: true }),
    meta(ata(creator, quoteMint, quoteTokenProgram), { w: true }),
    meta(vault, { w: true }),
    meta(ata(vault, quoteMint, quoteTokenProgram), { w: true }),
    meta(quoteMint),
    meta(quoteTokenProgram),
    meta(ATA_PROGRAM),
    meta(SYSTEM),
    meta(PUMP_EVENT_AUTHORITY),
    meta(PUMP),
  ], [anchorIx('collect_creator_fee_v2')])
}

// distribute_creator_fees_v2: permissionless payout for a coin whose creator was moved to a sharing_config.
export function distributeCreatorFeesV2({ payer, mint, shareholders, quoteMint = WSOL, quoteTokenProgram = TOKEN }) {
  const sc = sharingConfigPda(mint)
  const vault = creatorVaultPda(sc)
  return ix(PUMP, [
    meta(payer, { w: true, s: true }),
    meta(mint),
    meta(bondingCurvePda(mint)),
    meta(sc),
    meta(vault, { w: true }),
    meta(SYSTEM),
    meta(PUMP_EVENT_AUTHORITY),
    meta(PUMP),
    meta(ata(vault, quoteMint, quoteTokenProgram), { w: true }),
    meta(quoteMint),
    meta(quoteTokenProgram),
    meta(ATA_PROGRAM),
    ...shareholders.map(s => meta(s, { w: true })),
  ], [anchorIx('distribute_creator_fees_v2'), bool(false)])
}

// set_creator: signed by Global.set_creator_authority (a pump.fun key).
export function setCreator({ authority, mint, creator }) {
  return ix(PUMP, [
    meta(authority, { s: true }),
    meta(GLOBAL),
    meta(mint),
    meta(metaplexMetadataPda(mint)),
    meta(bondingCurvePda(mint), { w: true }),
    meta(PUMP_EVENT_AUTHORITY),
    meta(PUMP),
  ], [anchorIx('set_creator'), pk(creator)])
}

// set_metaplex_creator: permissionless sync of the curve creator from Metaplex metadata.
export function setMetaplexCreator({ mint }) {
  return ix(PUMP, [
    meta(mint),
    meta(metaplexMetadataPda(mint)),
    meta(bondingCurvePda(mint), { w: true }),
    meta(PUMP_EVENT_AUTHORITY),
    meta(PUMP),
  ], [anchorIx('set_metaplex_creator')])
}

// admin_cto: pump.fun's community-takeover instruction, signed by Global.admin_set_creator_authority.
export function adminCto({ authority, mint, currentCreator, newCreator, quoteMint = WSOL, quoteTokenProgram = TOKEN, currentCreatorWritable = true }) {
  const curve = bondingCurvePda(mint)
  const vault = creatorVaultPda(currentCreator)
  const holderVault = creatorVaultPda(holderRewardsPda(mint))
  const poolAuth = poolAuthorityPda(mint)
  const ammVault = ammCreatorVaultPda(currentCreator)
  return ix(PUMP, [
    meta(authority, { w: true, s: true }),
    meta(GLOBAL),
    meta(mint),
    meta(quoteMint),
    meta(quoteTokenProgram),
    meta(ATA_PROGRAM),
    meta(SYSTEM),
    meta(curve, { w: true }),
    meta(currentCreator, { w: currentCreatorWritable }),
    meta(ata(currentCreator, quoteMint, quoteTokenProgram), { w: true }),
    meta(vault, { w: true }),
    meta(ata(vault, quoteMint, quoteTokenProgram), { w: true }),
    meta(holderVault, { w: true }),
    meta(ata(holderVault, quoteMint, quoteTokenProgram), { w: true }),
    meta(PUMP_AMM),
    meta(AMM_GLOBAL_CONFIG),
    meta(poolAuth),
    meta(canonicalPoolPda(mint, quoteMint), { w: true }),
    meta(AMM_EVENT_AUTHORITY),
    meta(ammVault, { w: true }),
    meta(ata(ammVault, quoteMint, quoteTokenProgram), { w: true }),
    meta(sharingConfigPda(mint), { w: true }),
    meta(PUMP_FEES),
    meta(FEES_EVENT_AUTHORITY),
    meta(PUMP_EVENT_AUTHORITY),
    meta(PUMP),
  ], [anchorIx('admin_cto'), borshOption(bool)(null), borshOption(u64)(null), borshOption(pk)(newCreator)])
}

// migrate_v2: permissionless once the curve is complete (pump.fun runs it too). Creates the canonical pool and
// copies bonding_curve.creator into pool.coin_creator. withdraw_authority is Global.withdraw_authority and
// receives the migration fee; it does not sign. Two remaining accounts (the pool's boost vault authority and
// its quote ATA) are required (6027 NotEnoughRemainingAccounts without them), and pump-sdk 4.2 marks the
// quote mint writable for Token-2022 quotes with a transfer fee; harmless for SOL.
export function migrateV2({ user, mint, withdrawAuthority, quoteMint = WSOL, baseTokenProgram = TOKEN_2022, quoteTokenProgram = TOKEN }) {
  const curve = bondingCurvePda(mint)
  const poolAuth = poolAuthorityPda(mint)
  const pool = canonicalPoolPda(mint, quoteMint)
  const lpMint = pda(['pool_lp_mint', pk(pool)], PUMP_AMM)
  const boostAuth = pda(['boost_vault', pk(pool)], PUMP_AMM)
  return ix(PUMP, [
    meta(GLOBAL),
    meta(withdrawAuthority, { w: true }),
    meta(mint),
    meta(quoteMint, { w: true }),
    meta(curve, { w: true }),
    meta(ata(curve, mint, baseTokenProgram), { w: true }),
    meta(ata(curve, quoteMint, quoteTokenProgram), { w: true }),
    meta(user, { w: true, s: true }),
    meta(SYSTEM),
    meta(PUMP_AMM),
    meta(pool, { w: true }),
    meta(poolAuth, { w: true }),
    meta(ata(poolAuth, mint, baseTokenProgram), { w: true }),
    meta(ata(poolAuth, quoteMint, quoteTokenProgram), { w: true }),
    meta(AMM_GLOBAL_CONFIG),
    meta(lpMint, { w: true }),
    meta(ata(poolAuth, lpMint, TOKEN_2022), { w: true }),
    meta(ata(pool, mint, baseTokenProgram), { w: true }),
    meta(ata(pool, quoteMint, quoteTokenProgram), { w: true }),
    meta(baseTokenProgram),
    meta(quoteTokenProgram),
    meta(TOKEN_2022),
    meta(ATA_PROGRAM),
    meta(AMM_EVENT_AUTHORITY),
    meta('SysvarRent111111111111111111111111111111111'),
    meta(PUMP_EVENT_AUTHORITY),
    meta(PUMP),
    meta(boostAuth),
    meta(ata(boostAuth, quoteMint, quoteTokenProgram), { w: true }),
  ], [anchorIx('migrate_v2')])
}

// ---------- PumpSwap (pump_amm) ----------

// buy_v2 on a pool (17 accounts): like the curve's v3 trades, the protocol and creator fees stay in the pool
// (Pool.protocol_fees / creator_fees) until swept. The user's quote account must exist and hold the quote.
export function ammBuyV2({ pool, user, mint, baseAmountOut, maxQuoteIn, buybackWallet, quoteMint = WSOL, baseTokenProgram = TOKEN_2022, quoteTokenProgram = TOKEN }) {
  return ix(PUMP_AMM, [
    meta(pool, { w: true }),
    meta(user, { w: true, s: true }),
    meta(AMM_GLOBAL_CONFIG),
    meta(mint),
    meta(quoteMint),
    meta(ata(user, mint, baseTokenProgram), { w: true }),
    meta(ata(user, quoteMint, quoteTokenProgram), { w: true }),
    meta(ata(pool, mint, baseTokenProgram), { w: true }),
    meta(ata(pool, quoteMint, quoteTokenProgram), { w: true }),
    meta(baseTokenProgram),
    meta(quoteTokenProgram),
    meta(SYSTEM),
    meta(pda(['user_volume_accumulator', pk(user)], PUMP_AMM), { w: true }),
    meta(AMM_FEE_CONFIG),
    meta(ata(buybackWallet, quoteMint, quoteTokenProgram), { w: true }),
    meta(AMM_EVENT_AUTHORITY),
    meta(PUMP_AMM),
  ], [anchorIx('buy_v2'), u64(baseAmountOut), u64(maxQuoteIn)])
}

// sweep_creator_fee on a pool: Pool.creator_fees -> the WSOL ATA of creator_vault(pool.coin_creator).
export function ammSweepCreatorFee({ payer, pool, coinCreator, poolQuoteTokenAccount, quoteMint = WSOL, quoteTokenProgram = TOKEN }) {
  const vaultAuth = ammCreatorVaultPda(coinCreator)
  return ix(PUMP_AMM, [
    meta(payer, { w: true, s: true }),
    meta(AMM_GLOBAL_CONFIG),
    meta(pool, { w: true }),
    meta(quoteMint),
    meta(quoteTokenProgram),
    meta(poolQuoteTokenAccount, { w: true }),
    meta(vaultAuth),
    meta(ata(vaultAuth, quoteMint, quoteTokenProgram), { w: true }),
    meta(SYSTEM),
    meta(ATA_PROGRAM),
    meta(AMM_EVENT_AUTHORITY),
    meta(PUMP_AMM),
  ], [anchorIx('sweep_creator_fee')])
}

// collect_coin_creator_fee: permissionless; the creator vault ATA -> a quote token account owned by
// coin_creator (it must exist; WSOL stays wrapped, the owner unwraps it later).
export function collectCoinCreatorFee({ coinCreator, coinCreatorTokenAccount, quoteMint = WSOL, quoteTokenProgram = TOKEN }) {
  const vaultAuth = ammCreatorVaultPda(coinCreator)
  return ix(PUMP_AMM, [
    meta(quoteMint),
    meta(quoteTokenProgram),
    meta(coinCreator),
    meta(vaultAuth),
    meta(ata(vaultAuth, quoteMint, quoteTokenProgram), { w: true }),
    meta(coinCreatorTokenAccount, { w: true }),
    meta(AMM_EVENT_AUTHORITY),
    meta(PUMP_AMM),
  ], [anchorIx('collect_coin_creator_fee')])
}

// set_coin_creator: permissionless; sets Pool.coin_creator from the coin's Metaplex metadata creator or its
// BondingCurve.creator.
export function setCoinCreator({ pool, mint }) {
  return ix(PUMP_AMM, [
    meta(pool, { w: true }),
    meta(metaplexMetadataPda(mint)),
    meta(bondingCurvePda(mint)),
    meta(AMM_EVENT_AUTHORITY),
    meta(PUMP_AMM),
  ], [anchorIx('set_coin_creator')])
}

// ---------- Pump Fees ----------

// create_fee_sharing_config: payer must be the coin's current creator or Global.admin_set_creator_authority.
export function createFeeSharingConfig({ payer, mint, pool = null }) {
  return ix(PUMP_FEES, [
    meta(FEES_EVENT_AUTHORITY),
    meta(PUMP_FEES),
    meta(payer, { w: true, s: true }),
    meta(GLOBAL),
    meta(mint),
    meta(sharingConfigPda(mint), { w: true }),
    meta(SYSTEM),
    meta(bondingCurvePda(mint), { w: true }),
    meta(PUMP),
    meta(PUMP_EVENT_AUTHORITY),
    // Optional accounts: Anchor reads the program id in their place to mean "none".
    meta(pool || PUMP_FEES, { w: !!pool }),
    meta(pool ? PUMP_AMM : PUMP_FEES),
    meta(pool ? AMM_EVENT_AUTHORITY : PUMP_FEES),
  ], [anchorIx('create_fee_sharing_config')])
}

// ---------- system / token helpers ----------

export function createAtaIdempotent({ payer, owner, mint, tokenProgram }) {
  return ix(ATA_PROGRAM, [
    meta(payer, { w: true, s: true }),
    meta(ata(owner, mint, tokenProgram), { w: true }),
    meta(owner),
    meta(mint),
    meta(SYSTEM),
    meta(tokenProgram),
  ], [u8(1)])
}

export function syncNative({ account }) {
  return ix(TOKEN, [meta(account, { w: true })], [u8(17)])
}

export function transferLamports({ from, to, lamports }) {
  return ix(SYSTEM, [meta(from, { w: true, s: true }), meta(to, { w: true })], [Buffer.from([2, 0, 0, 0]), u64(lamports)])
}

export { ata }
