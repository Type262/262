// pump.fun for the vault worker: program ids, PDAs, account readers and the instructions the worker (and its
// end-to-end run) sends. Copied from solana/scripts/pump-lib.mjs and pump-ix.mjs, where each one is proven
// against mainnet in simulation and in LiteSVM with the mainnet programs (solana/docs/PUMP.md), so the service
// does not depend on solana/scripts. Account order, flags and argument encoding follow the IDLs in
// pump-fun/pump-public-docs; discriminators are Anchor's sha256("global:<name>")[..8]. Node only, no dependencies.
import { createHash } from 'node:crypto'

export const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
export const PUMP_AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'
export const PUMP_FEES = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ'
export const MAYHEM = 'MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e'
export const SYSTEM = '11111111111111111111111111111111'
export const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
export const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
export const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
export const WSOL = 'So11111111111111111111111111111111111111112'
const RENT_SYSVAR = 'SysvarRent111111111111111111111111111111111'

// ---------- base58, PDAs ----------

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

export function b58encode(bytes) {
  let n = BigInt('0x' + (Buffer.from(bytes).toString('hex') || '0'))
  let out = ''
  while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n }
  for (const b of bytes) { if (b !== 0) break; out = '1' + out }
  return out
}

export function b58decode(str) {
  let n = 0n
  for (const c of String(str)) {
    const i = ALPHABET.indexOf(c)
    if (i < 0) throw new Error('bad base58')
    n = n * 58n + BigInt(i)
  }
  let hex = n === 0n ? '' : n.toString(16)
  if (hex.length % 2) hex = '0' + hex
  const lead = String(str).match(/^1*/)[0].length
  return Buffer.concat([Buffer.alloc(lead), Buffer.from(hex, 'hex')])
}

export const pk = s => { const b = b58decode(s); if (b.length !== 32) throw new Error(`not a pubkey: ${String(s).slice(0, 48)}`); return b }
export const isPubkey = s => { try { pk(s); return true } catch { return false } }

const P = 2n ** 255n - 19n
const modp = x => ((x % P) + P) % P
function powmod(b, e) { let r = 1n; b = modp(b); while (e > 0n) { if (e & 1n) r = r * b % P; b = b * b % P; e >>= 1n } return r }
const D = modp(-121665n * powmod(121666n, P - 2n))

// The runtime's rule (curve25519-dalek decompress): on the curve iff (y^2-1)/(d*y^2+1) is a square mod p.
export function isOnCurve(bytes) {
  const b = Buffer.from(bytes)
  b[31] &= 0x7f
  const y = modp(BigInt('0x' + Buffer.from(b).reverse().toString('hex')))
  const y2 = y * y % P
  const x2 = modp(y2 - 1n) * powmod(modp(D * y2 + 1n), P - 2n) % P
  return x2 === 0n || powmod(x2, (P - 1n) / 2n) === 1n
}

const sha256 = (...parts) => createHash('sha256').update(Buffer.concat(parts.map(p => Buffer.from(p)))).digest()

export function findPda(seeds, programId) {
  const prog = pk(programId)
  for (let bump = 255; bump >= 0; bump--) {
    const h = sha256(...seeds.map(s => typeof s === 'string' ? Buffer.from(s) : s), Buffer.from([bump]), prog, Buffer.from('ProgramDerivedAddress'))
    if (!isOnCurve(h)) return [b58encode(h), bump]
  }
  throw new Error('no bump')
}

export const pda = (seeds, programId) => findPda(seeds, programId)[0]
export const ata = (owner, mint, tokenProgram = TOKEN) => pda([pk(owner), pk(tokenProgram), pk(mint)], ATA_PROGRAM)

export const anchorIx = name => sha256(Buffer.from(`global:${name}`)).subarray(0, 8)
export const anchorAccount = name => sha256(Buffer.from(`account:${name}`)).subarray(0, 8)

// ---------- borsh ----------

export const u8 = v => Buffer.from([v])
export const bool = v => Buffer.from([v ? 1 : 0])
export const u16 = v => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b }
export const u32 = v => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b }
export const u64 = v => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b }
export const str = s => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([u32(b.length), b]) }

export class Reader {
  constructor(buf, at = 0) { this.b = Buffer.from(buf); this.o = at }
  // Accounts written before a field was appended are shorter: missing trailing bytes read as zero.
  take(n) { const out = Buffer.alloc(n); if (this.o < this.b.length) this.b.copy(out, 0, this.o, Math.min(this.o + n, this.b.length)); this.o += n; return out }
  u8() { return this.take(1)[0] }
  bool() { return this.u8() !== 0 }
  u16() { return this.take(2).readUInt16LE() }
  u32() { return this.take(4).readUInt32LE() }
  u64() { return this.take(8).readBigUInt64LE() }
  i128() { const t = this.take(16); return BigInt.asIntN(128, t.readBigUInt64LE(0) | (t.readBigUInt64LE(8) << 64n)) }
  pubkey() { return b58encode(this.take(32)) }
  pubkeys(n) { return Array.from({ length: n }, () => this.pubkey()) }
}

// ---------- accounts (layouts from the IDLs) ----------

export const BONDING_CURVE_DISCRIMINATOR = anchorAccount('BondingCurve')
export const POOL_DISCRIMINATOR = anchorAccount('Pool')
// Where getProgramAccounts finds a creator: BondingCurve.creator (8 + 5 u64 + complete) and Pool.coin_creator
// (8 + bump + index + 6 pubkeys + lp_supply).
export const CURVE_CREATOR_OFFSET = 49
export const POOL_COIN_CREATOR_OFFSET = 211

export function readBondingCurve(data) {
  const r = new Reader(data, 8)
  return {
    virtualTokenReserves: r.u64(), virtualQuoteReserves: r.u64(), realTokenReserves: r.u64(), realQuoteReserves: r.u64(),
    tokenTotalSupply: r.u64(), complete: r.bool(), creator: r.pubkey(), isMayhemMode: r.bool(), isCashbackCoin: r.bool(),
    quoteMint: r.pubkey(), creatorFeeBps: r.u64(), canEditCreatorFee: r.bool(), isHolderReward: r.bool(),
    creatorFee: r.u64(), protocolFees: r.u64(),
  }
}

export function readPool(data) {
  const r = new Reader(data, 8)
  return {
    poolBump: r.u8(), index: r.u16(), creator: r.pubkey(), baseMint: r.pubkey(), quoteMint: r.pubkey(), lpMint: r.pubkey(),
    poolBaseTokenAccount: r.pubkey(), poolQuoteTokenAccount: r.pubkey(), lpSupply: r.u64(), coinCreator: r.pubkey(),
    isMayhemMode: r.bool(), isCashbackCoin: r.bool(), virtualQuoteReserves: r.i128(), creatorFeeBps: r.u64(),
    canEditCreatorFee: r.bool(), isHolderReward: r.bool(), protocolFees: r.u64(), creatorFees: r.u64(),
  }
}

// The fields of pump's Global a launch and a migration need.
export function readGlobal(data) {
  const r = new Reader(data, 8)
  const g = {}
  g.initialized = r.bool(); g.authority = r.pubkey(); g.feeRecipient = r.pubkey()
  g.initialVirtualTokenReserves = r.u64(); g.initialVirtualSolReserves = r.u64(); g.initialRealTokenReserves = r.u64()
  g.tokenTotalSupply = r.u64(); g.feeBasisPoints = r.u64(); g.withdrawAuthority = r.pubkey(); g.enableMigrate = r.bool()
  g.poolMigrationFee = r.u64(); g.creatorFeeBasisPoints = r.u64(); g.feeRecipients = r.pubkeys(7)
  g.setCreatorAuthority = r.pubkey(); g.adminSetCreatorAuthority = r.pubkey(); g.createV2Enabled = r.bool()
  g.whitelistPda = r.pubkey(); g.reservedFeeRecipient = r.pubkey(); g.mayhemModeEnabled = r.bool()
  g.reservedFeeRecipients = r.pubkeys(7); g.isCashbackEnabled = r.bool(); g.buybackFeeRecipients = r.pubkeys(8)
  return g
}

// A curve paired with SOL stores the default key or WSOL as its quote; only those pay creator fees in lamports.
export const solQuoted = quoteMint => quoteMint === SYSTEM || quoteMint === WSOL

// ---------- PDAs ----------

export const GLOBAL = pda(['global'], PUMP)
export const MINT_AUTHORITY = pda(['mint-authority'], PUMP)
export const PUMP_EVENT_AUTHORITY = pda(['__event_authority'], PUMP)
export const AMM_EVENT_AUTHORITY = pda(['__event_authority'], PUMP_AMM)
export const AMM_GLOBAL_CONFIG = pda(['global_config'], PUMP_AMM)
export const PUMP_FEE_CONFIG = pda(['fee_config', pk(PUMP)], PUMP_FEES)
export const AMM_FEE_CONFIG = pda(['fee_config', pk(PUMP_AMM)], PUMP_FEES)
export const MAYHEM_GLOBAL_PARAMS = pda(['global-params'], MAYHEM)
export const MAYHEM_SOL_VAULT = pda(['sol-vault'], MAYHEM)

export const bondingCurvePda = mint => pda(['bonding-curve', pk(mint)], PUMP)
export const creatorVaultPda = creator => pda(['creator-vault', pk(creator)], PUMP)
export const poolAuthorityPda = mint => pda(['pool-authority', pk(mint)], PUMP)
export const userVolumeAccumulatorPda = user => pda(['user_volume_accumulator', pk(user)], PUMP)
export const mayhemStatePda = mint => pda(['mayhem-state', pk(mint)], MAYHEM)
export const canonicalPoolPda = (mint, quoteMint = WSOL) => pda(['pool', u16(0), pk(poolAuthorityPda(mint)), pk(mint), pk(quoteMint)], PUMP_AMM)
export const ammCreatorVaultPda = coinCreator => pda(['creator_vault', pk(coinCreator)], PUMP_AMM)

const ix = (programId, keys, data) => ({ programId, keys, data: Buffer.concat(data) })
export const meta = (pubkey, { w = false, s = false } = {}) => ({ pubkey, isWritable: w, isSigner: s })
const optionBool = v => bool(v) // OptionBool is a one-field struct, not Option<T>: no tag byte

// ---------- pump (bonding curve) ----------

// create_v2: a Token-2022 coin and its curve. `creator` is plain data: it never signs, and every creator fee of
// the coin accrues to creator-vault(creator). The vault worker's launches name the domain's vault here.
export function createV2({ mint, user, creator, name, symbol, uri, mayhem = false }) {
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
  ], [anchorIx('create_v2'), str(name), str(symbol), str(uri), pk(creator), bool(mayhem), optionBool(false), u64(0), optionBool(false)])
}

// buy_v3: the creator fee stays on the curve (BondingCurve.creator_fee) until swept.
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

// sweep_creator_fee: permissionless, BondingCurve.creator_fee -> creator-vault(bonding_curve.creator). The payer
// only covers a rent top-up when the creator vault is new.
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

// collect_creator_fee_v2: permissionless, creator-vault(creator) minus its rent -> `creator` (never a signer).
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

// migrate_v2: permissionless once the curve is complete; copies bonding_curve.creator into pool.coin_creator.
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
    meta(RENT_SYSVAR),
    meta(PUMP_EVENT_AUTHORITY),
    meta(PUMP),
    meta(boostAuth),
    meta(ata(boostAuth, quoteMint, quoteTokenProgram), { w: true }),
  ], [anchorIx('migrate_v2')])
}

// ---------- PumpSwap (pump_amm) ----------

// buy_v2 on a pool: the creator fee stays in the pool (Pool.creator_fees) until swept. The user's WSOL account
// must exist and hold the quote.
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

// collect_coin_creator_fee: permissionless, the creator vault's WSOL ATA -> a WSOL account owned by coin_creator.
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

// ---------- system / token ----------

export function createAtaIdempotent({ payer, owner, mint, tokenProgram = TOKEN }) {
  return ix(ATA_PROGRAM, [
    meta(payer, { w: true, s: true }),
    meta(ata(owner, mint, tokenProgram), { w: true }),
    meta(owner),
    meta(mint),
    meta(SYSTEM),
    meta(tokenProgram),
  ], [u8(1)])
}

export const syncNative = ({ account }) => ix(TOKEN, [meta(account, { w: true })], [u8(17)])
export const transferLamports = ({ from, to, lamports }) => ix(SYSTEM, [meta(from, { w: true, s: true }), meta(to, { w: true })], [u32(2), u64(lamports)])
