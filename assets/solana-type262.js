// The type262 Solana program from the browser: its addresses, readers for its accounts, and every transaction
// the escrow and launch screens send. Instructions are encoded by hand from the program's IDL
// (solana/target/idl/type262.json): Anchor discriminators, borsh args, accounts in the IDL's order with its
// signer and writable flags. test/solana-type262.test.mjs checks each one byte for byte against the LiteSVM
// harness's builders and against the IDL, and solana/scripts/e2e-local.mjs runs them all on a local validator.
// The program re-checks everything, so a wrong account here only costs a failed transaction.
import * as config from './config.js'
import {
  ATA_PROGRAM, CHAIN, SYSTEM_PROGRAM, TOKEN_PROGRAM, USDC, base58Encode, base64Decode, base64Encode, compileMessage,
  createAssociatedTokenAccountIdempotent, findProgramAddress, pubkeyBytes, rpc as solanaRpc, serializeMessage, state,
  systemTransfer, compileV0,
} from './solana.js'
import {
  COMPUTE_BUDGET_PROGRAM, LEGACY_TX_LIMIT, TYPE_TXT, TYPE_WALLET, anchorEncoder, canonicalDomain, decodeRrsetAccount,
  fetchCache, fetchWalletProof, leafWallets, nameToWire, planProof, sha256, solWallet, toHex,
} from './solana-proof.js'

export const PROGRAM_ID = config.SOLANA_PROGRAM_ID || '3fhiMDY5kyCpX47HU1whuEe6vMQFHPa1hwGhc4Pp72NT'
/** True once config.js names the mainnet deployment; until then PROGRAM_ID is the local test id. */
export const DEPLOYED = !!config.SOLANA_PROGRAM_ID

export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
export const LOOKUP_TABLE_PROGRAM = 'AddressLookupTab1e1111111111111111111111111'
const UPGRADEABLE_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111'
/** Stands for SOL wherever the program takes a mint (32 zero bytes). */
export const SOL_MINT = SYSTEM_PROGRAM
export const WSOL = 'So11111111111111111111111111111111111111112'

// pump.fun (solana/docs/PUMP.md has where each comes from)
export const PUMP = {
  program: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  amm: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
  global: '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf',
  mintAuthority: 'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM',
  eventAuthority: 'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1',
  feeConfig: '8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt',
  ammGlobalConfig: 'ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw',
  ammEventAuthority: 'GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR',
  mayhem: 'MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e',
  mayhemGlobalParams: '13ec7XdrjF3h3YcqBTFDSReRcUFwbCnJaAQspM4j6DDJ',
  mayhemSolVault: 'BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s',
  // Global.buyback_fee_recipients[0]; a buy may name any of the eight, and this one sits in the lookup table.
  buyback: '5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD',
}

/**
 * The fixed accounts of a launch transaction, for its address lookup table: with them looked up, launch + ATA +
 * buy_v3 fits a v0 transaction (about 980 bytes; 1,285 as legacy, over the 1,232 limit).
 */
export const LAUNCH_LOOKUP_ADDRESSES = [
  PROGRAM_ID, PUMP.program, PUMP.global, PUMP.mintAuthority, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM,
  ATA_PROGRAM, PUMP.mayhem, PUMP.mayhemGlobalParams, PUMP.mayhemSolVault, PUMP.eventAuthority, PUMP.feeConfig,
  PUMP.buyback, WSOL, COMPUTE_BUDGET_PROGRAM,
]

/** Compute limit for launch + ATA + buy_v3 (measured up to about 216k in LiteSVM). */
export const LAUNCH_COMPUTE_UNITS = 300_000

// ---------- the IDL, as bytes (checked against target/idl/type262.json by the tests) ----------

/** Instruction discriminators: sha256("global:<name>")[..8]. */
export const IX = {
  initialize: [175, 175, 109, 31, 13, 152, 155, 237],
  set_deposits_paused: [160, 98, 241, 200, 54, 132, 77, 203],
  deposit_sol: [108, 81, 78, 117, 125, 155, 56, 200],
  deposit_token: [11, 156, 96, 218, 39, 163, 180, 19],
  claim: [62, 198, 214, 193, 213, 159, 108, 210],
  register: [211, 124, 67, 15, 211, 194, 178, 240],
  refund: [2, 96, 183, 251, 63, 208, 46, 46],
  withdraw_fees: [198, 212, 171, 109, 144, 215, 174, 89],
  launch: [153, 241, 93, 225, 22, 69, 74, 61],
  collect: [208, 47, 194, 155, 17, 98, 82, 236],
}

/** Account discriminators: sha256("account:<Name>")[..8]. */
export const ACCOUNT = {
  Config: [155, 12, 170, 224, 30, 250, 204, 130],
  Domain: [167, 191, 231, 63, 146, 41, 115, 27],
  Pool: [241, 154, 109, 4, 17, 177, 109, 188],
  Deposit: [148, 146, 121, 66, 207, 173, 21, 227],
  FeeVault: [192, 178, 69, 232, 58, 149, 157, 132],
  LaunchRecord: [146, 240, 197, 204, 6, 6, 87, 75],
  RrSet: [212, 179, 245, 215, 207, 203, 205, 177],
}

/** The program's errors (errors.rs), by code, plus the Anchor codes a wrong account most often gives. */
export const ERRORS = {
  6000: ['BadDomain', "Not a canonical domain name: lowercase a-z, 0-9, '-', '_', labels of 1 to 63, no trailing dot"],
  6001: ['DomainHashMismatch', 'The domain hash does not match the name'],
  6002: ['NotAdmin', 'Only the admin can do this'],
  6003: ['NotPendingAdmin', 'Only the pending admin can accept'],
  6004: ['BadConfig', 'Fee above the 1% cap, fee without a recipient, no admin, or zero refund delay'],
  6005: ['NotUpgradeAuthority', "Only the program's upgrade authority can initialize it"],
  6006: ['ZeroAmount', 'Amount must be greater than zero'],
  6007: ['MathOverflow', 'Arithmetic overflow'],
  6008: ['NotImplemented', 'Not implemented yet'],
  6100: ['BadBufferSize', 'Buffer write is empty or ends past the maximum buffer size'],
  6101: ['BadBuffer', 'Buffer does not hold [u32 length, signed set, u32 length, signature]'],
  6102: ['BadSignedData', 'Signed set is truncated or malformed'],
  6103: ['BadName', 'Name is compressed, has a label over 63 bytes or is longer than 255 bytes'],
  6104: ['NameNotLowercase', 'Names must be in canonical lowercase form'],
  6105: ['EmptyRRset', 'Signed set has no records'],
  6106: ['InvalidClass', 'Record class is not IN'],
  6107: ['InvalidRRSet', 'Records do not share one owner name'],
  6108: ['SignatureTypeMismatch', 'Record type differs from the type the RRSIG covers'],
  6109: ['InvalidLabelCount', "RRSIG label count differs from the owner's: wildcard expansions are not accepted"],
  6110: ['SignatureExpired', 'Signature has expired'],
  6111: ['SignatureNotValidYet', 'Signature is not valid yet'],
  6112: ['InvalidSignerName', 'Signer is neither the owner nor an ancestor of it, or signs a DS set at its own name'],
  6113: ['WrongParent', 'Parent is not the verified set this one must be checked against'],
  6114: ['ParentExpired', 'Parent set has expired'],
  6115: ['UnsupportedAlgorithm', 'Unsupported DNSSEC algorithm'],
  6116: ['WrongInstructionForAlgorithm', 'RSA sets use verify_rrset or verify_rrset_buffered, P-256 and Ed25519 sets verify_rrset_precompiled'],
  6117: ['NoKeyVerified', 'No usable key verified the signature'],
  6118: ['NoMatchingDs', 'The key that signed the DNSKEY set matches no DS record'],
  6119: ['WrongRRsetAccount', 'Not the PDA of the set being verified'],
  6120: ['RRsetNotExpired', 'The set has not expired yet'],
  6121: ['WrongPayer', 'The rent goes back to the payer recorded in the set'],
  6122: ['NotAWalletRecord', "Not this domain's cached _wallet TXT or WALLET set"],
  6123: ['WalletRecordExpired', 'The wallet record has expired: verify it again'],
  6124: ['WalletNotPublished', 'The wallet record does not publish this SOL address'],
  6200: ['Paused', 'Deposits are paused'],
  6201: ['StaleProof', "An older proof can't override a newer one"],
  6202: ['NothingToRefund', 'Nothing to refund: no deposit, or the pool paid out since'],
  6203: ['RefundLocked', 'The refund delay since the last deposit has not passed'],
  6204: ['WrongMint', 'Wrong or missing mint for this pool'],
  6205: ['UnsupportedMint', "Token-2022 mint with an extension the escrow can't hold exactly"],
  6206: ['WrongTokenAccount', 'Wrong token account or token program'],
  6207: ['BadRecipient', 'The recipient is not the wallet being paid, or is a token account, a mint or a program'],
  6208: ['PoolUnderfunded', 'The account would hold less than its rent plus what it owes'],
  6209: ['PoolNotOpen', 'The pool account was never set up'],
  6210: ['TiedProof', "Signed at the same time as the domain's last proof, which named another wallet: only a record signed later can change it"],
  6300: ['WrongPumpProgram', 'Wrong pump.fun program'],
  6301: ['MissingPumpAccounts', 'Too few pump.fun create_v2 accounts'],
  6302: ['WrongCoinMint', "create_v2's mint is not the launch's mint"],
  6303: ['WrongCoinLauncher', "create_v2's user is not the launcher"],
  6304: ['WrongBondingCurve', "Not the coin's pump.fun bonding curve"],
  6305: ['BadLaunchedCurve', "The coin's bonding curve does not pay this domain's creator in SOL"],
  6306: ['WrongPumpAccount', 'Wrong pump.fun account'],
  6307: ['WrongCreatorVault', "Not this domain's pump.fun creator vault"],
  6308: ['WrongCreatorTokenAccount', "Not the creator's WSOL account"],
  6309: ['NothingToCollect', 'No creator fees to collect'],
  2001: ['ConstraintHasOne', 'An account does not belong to this one'],
  2003: ['ConstraintRaw', 'An account check failed'],
  2006: ['ConstraintSeeds', 'An account is not the address the program derives'],
  3008: ['InvalidProgramId', 'Wrong program account'],
  3012: ['AccountNotInitialized', 'An account the instruction needs does not exist yet'],
}

// ---------- bytes ----------
const enc = new TextEncoder()
const utf8 = s => enc.encode(s)
const concat = parts => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let i = 0
  for (const p of parts) { out.set(p, i); i += p.length }
  return out
}
const u8 = n => Uint8Array.of(n)
const u16le = n => Uint8Array.of(n & 255, (n >> 8) & 255)
const u16be = n => Uint8Array.of((n >> 8) & 255, n & 255)
const u32le = n => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b }
const intLe = (v, signed) => {
  const n = BigInt(v)
  if (signed ? n < -(1n << 63n) || n >= 1n << 63n : n < 0n || n >= 1n << 64n) throw new Error('Amount out of range')
  const b = new Uint8Array(8)
  new DataView(b.buffer).setBigUint64(0, BigInt.asUintN(64, n), true)
  return b
}
const u64le = v => intLe(v, false)
const i64le = v => intLe(v, true)
const str = s => { const b = utf8(s); return concat([u32le(b.length), b]) } // borsh String
const key = a => pubkeyBytes(a)
const data = (name, ...args) => concat([Uint8Array.from(IX[name]), ...args])
const meta = (pubkey, isSigner, isWritable) => ({ pubkey, isSigner, isWritable })
const ws = k => meta(k, true, true)
const w = k => meta(k, false, true)
const r = k => meta(k, false, false)
const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])
const isSol = mint => mint === 'SOL' || mint === SOL_MINT
const mintBytes = mint => (isSol(mint) ? new Uint8Array(32) : key(mint))
/** A domain hash given as 32 bytes or 64 hex digits. */
const hash32 = h => {
  const b = typeof h === 'string' ? Uint8Array.from(h.match(/../g) || [], x => parseInt(x, 16)) : Uint8Array.from(h)
  if (b.length !== 32) throw new Error('A domain hash is 32 bytes')
  return b
}
const amountOf = v => {
  const n = BigInt(v)
  if (n <= 0n) throw new Error('Amount must be greater than zero')
  return n
}

// ---------- where reads and sends go ----------

// The page uses solana.js (public RPC, our read-only fallback); scripts and tests point it elsewhere.
const conn = {
  rpc: (method, params) => solanaRpc(method, params, { write: method === 'sendTransaction' }),
  chain: CHAIN,
  commitment: 'confirmed',
  lookupTables: config.SOLANA_LOOKUP_TABLE ? [config.SOLANA_LOOKUP_TABLE] : [],
  skipPreflight: false,
}

/** A JSON-RPC function for one URL that keeps the error's data (simulation logs, the instruction error). */
export function rpcAt(url) {
  let id = 0
  return async (method, params = []) => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) })
    if (!res.ok) throw new Error(`RPC answered ${res.status}`)
    const j = await res.json()
    if (j.error) throw Object.assign(new Error(j.error.message || 'RPC error'), { code: j.error.code, data: j.error.data, rpc: true })
    return j.result
  }
}

/**
 * Points the client somewhere else: { rpc } (a function (method, params)) or { rpcUrl }, the Wallet Standard
 * { chain }, and the address lookup tables launches use ({ lookupTables: [address] }).
 */
export function configure(opts = {}) {
  if (opts.rpcUrl) conn.rpc = rpcAt(opts.rpcUrl)
  if (opts.rpc) conn.rpc = opts.rpc
  // Another cluster may have another rent rate and other mints.
  if (opts.rpcUrl || opts.rpc) { rentCache.clear(); mintInfo.clear() }
  if (opts.chain) conn.chain = opts.chain
  if (opts.commitment) conn.commitment = opts.commitment
  if (opts.lookupTables) conn.lookupTables = [...opts.lookupTables]
  // Scripts that want a failing transaction recorded on-chain (with a signature) skip the simulation.
  if ('skipPreflight' in opts) conn.skipPreflight = !!opts.skipPreflight
  return { ...conn }
}

const call = (method, params) => conn.rpc(method, params)

/** Accounts as { address, owner, lamports, data, executable } (null when missing), 100 per call. */
export async function getAccounts(addresses) {
  const out = []
  for (let i = 0; i < addresses.length; i += 100) {
    const batch = addresses.slice(i, i + 100)
    const { value } = await call('getMultipleAccounts', [batch, { encoding: 'base64', commitment: conn.commitment }])
    batch.forEach((address, j) => {
      const a = value[j]
      out.push(a ? { address, owner: a.owner, lamports: BigInt(a.lamports), data: base64Decode(a.data[0]), executable: !!a.executable } : null)
    })
  }
  return out
}

const rentCache = new Map()
/** The rent-exempt minimum for an account of `size` bytes, from the cluster (mainnet's rate has changed before). */
export function rentExempt(size) {
  if (!rentCache.has(size)) rentCache.set(size, call('getMinimumBalanceForRentExemption', [size]).then(BigInt).catch(err => { rentCache.delete(size); throw err }))
  return rentCache.get(size)
}

// ---------- addresses ----------

const pdaCache = new Map()
/** A program address, memoized: each costs a few sha256 and curve checks. */
function derive(seeds, programId = PROGRAM_ID) {
  const parts = seeds.map(s => (typeof s === 'string' ? utf8(s) : Uint8Array.from(s)))
  const k = `${programId}:${parts.map(toHex).join('/')}`
  if (!pdaCache.has(k)) pdaCache.set(k, findProgramAddress(parts, programId).then(([a]) => a).catch(err => { pdaCache.delete(k); throw err }))
  return pdaCache.get(k)
}

/** sha256 of the canonical name: the key of everything the program keeps for a domain. */
export async function domainHash(name) {
  return sha256(utf8(canonicalDomain(name)))
}

/** The program's addresses (seeds in solana/programs/type262/src/constants.rs). Mints may be 'SOL'. */
export const pda = {
  config: () => derive(['config']),
  domain: hash => derive(['domain', hash32(hash)]),
  pool: (hash, mint) => derive(['pool', hash32(hash), mintBytes(mint)]),
  deposit: (pool, depositor) => derive(['deposit', key(pool), key(depositor)]),
  /** A cached RRset: ["rrset", sha256(owner wire name), rrtype u16 BE]. The owner may be a dotted name. */
  rrset: async (ownerWire, rrtype) => derive(['rrset', await sha256(typeof ownerWire === 'string' ? nameToWire(ownerWire) : Uint8Array.from(ownerWire)), u16be(rrtype)]),
  creator: hash => derive(['creator', hash32(hash)]),
  launch: mint => derive(['launch', key(mint)]),
  feeVault: mint => derive(['fees', mintBytes(mint)]),
  programData: () => derive([key(PROGRAM_ID)], UPGRADEABLE_LOADER),
}

/** pump.fun's per-coin and per-creator addresses. */
export const pumpPda = {
  bondingCurve: mint => derive(['bonding-curve', key(mint)], PUMP.program),
  creatorVault: creator => derive(['creator-vault', key(creator)], PUMP.program),
  ammCreatorVault: creator => derive(['creator_vault', key(creator)], PUMP.amm),
  mayhemState: mint => derive(['mayhem-state', key(mint)], PUMP.mayhem),
  userVolume: user => derive(['user_volume_accumulator', key(user)], PUMP.program),
  poolAuthority: mint => derive(['pool-authority', key(mint)], PUMP.program),
  canonicalPool: async mint => derive(['pool', u16le(0), key(await pumpPda.poolAuthority(mint)), key(mint), key(WSOL)], PUMP.amm),
}

/** The associated token account of owner for mint (SPL Token unless told otherwise). */
export const ata = (owner, mint, tokenProgram = TOKEN_PROGRAM) => derive([key(owner), key(tokenProgram), key(mint)], ATA_PROGRAM)

// ---------- accounts ----------

class Reader {
  constructor(bytes, at = 8) { this.b = bytes; this.v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); this.at = at }
  skip(n) { const at = this.at; this.at += n; if (this.at > this.b.length) throw new Error('Account data too short'); return at }
  u8() { return this.b[this.skip(1)] }
  bool() { return this.u8() !== 0 }
  u16() { return this.v.getUint16(this.skip(2), true) }
  u32() { return this.v.getUint32(this.skip(4), true) }
  u64() { return this.v.getBigUint64(this.skip(8), true) }
  i64() { return this.v.getBigInt64(this.skip(8), true) }
  bytes(n) { const at = this.skip(n); return this.b.slice(at, at + n) }
  key() { return base58Encode(this.bytes(32)) }
  str() { return new TextDecoder().decode(this.bytes(this.u32())) }
}

const DECODERS = {
  Config: d => ({ admin: d.key(), pendingAdmin: d.key(), feeRecipient: d.key(), feeBps: d.u16(), refundDelay: Number(d.i64()), depositsPaused: d.bool(), bump: d.u8() }),
  Domain: d => ({ domainHash: d.bytes(32), lastProof: Number(d.i64()), wallet: d.key(), launches: d.u32(), bump: d.u8(), name: d.str() }),
  Pool: d => ({ domainHash: d.bytes(32), mint: d.key(), balance: d.u64(), epoch: d.u64(), bump: d.u8() }),
  Deposit: d => ({ pool: d.key(), depositor: d.key(), amount: d.u64(), epoch: d.u64(), lastAt: Number(d.i64()), bump: d.u8() }),
  FeeVault: d => ({ mint: d.key(), owed: d.u64(), bump: d.u8() }),
  LaunchRecord: d => ({ domainHash: d.bytes(32), mint: d.key(), launcher: d.key(), launchedAt: Number(d.i64()), bump: d.u8() }),
}

/**
 * Decodes one of the program's accounts ({ owner, data } as getAccounts returns it, or raw data bytes). Null when
 * it is missing, owned by another program, or of another type.
 */
export function decode(type, account) {
  if (!account) return null
  const bytes = account instanceof Uint8Array ? account : account.data
  if (!(account instanceof Uint8Array) && account.owner !== PROGRAM_ID) return null
  if (!bytes || bytes.length < 8 || !sameBytes(bytes.subarray(0, 8), ACCOUNT[type])) return null
  try { return DECODERS[type](new Reader(bytes)) } catch { return null }
}

/** The program settings, or null before `initialize`. Fee in basis points, refund delay in seconds. */
export async function readConfig() {
  const address = await pda.config()
  const [a] = await getAccounts([address])
  const c = decode('Config', a)
  return c && { ...c, address, pendingAdmin: c.pendingAdmin === SYSTEM_PROGRAM ? null : c.pendingAdmin }
}

/** A domain's account: the newest proof it accepted (unix seconds, 0 for none), its wallet and launch count. */
export async function readDomain(name) {
  const canonical = canonicalDomain(name)
  const hash = await domainHash(canonical)
  const address = await pda.domain(hash)
  const [a] = await getAccounts([address])
  const d = decode('Domain', a)
  if (!d) return { exists: false, name: canonical, hash, address, lastProof: 0, launches: 0, wallet: null }
  return { exists: true, name: d.name, hash, address, lastProof: d.lastProof, launches: d.launches, wallet: d.wallet === SYSTEM_PROGRAM ? null : d.wallet }
}

const mintInfo = new Map()
/** { tokenProgram, decimals } of a mint, read once per page. Throws unless SPL Token or Token-2022 owns it. */
export function readMint(mint) {
  if (!mintInfo.has(mint)) {
    mintInfo.set(mint, getAccounts([mint]).then(([a]) => {
      if (!a || (a.owner !== TOKEN_PROGRAM && a.owner !== TOKEN_2022_PROGRAM) || a.data.length < 82) throw new Error(`${mint} is not a token mint`)
      return { tokenProgram: a.owner, decimals: a.data[44] }
    }).catch(err => { mintInfo.delete(mint); throw err }))
  }
  return mintInfo.get(mint)
}

/**
 * What a domain's pools hold: SOL and USDC, then any mint passed in (an address, or { mint, symbol, decimals }).
 * Each as { mint ('SOL' or the mint address), symbol, decimals, balance (bigint, base units), epoch, address, exists }.
 */
export async function readPools(name, mints = []) {
  const hash = await domainHash(name)
  const list = [{ mint: 'SOL', symbol: 'SOL', decimals: 9 }, { mint: USDC.mint, symbol: USDC.symbol, decimals: USDC.decimals }]
  for (const m of mints) {
    const t = typeof m === 'string' ? { mint: m } : { ...m }
    if (isSol(t.mint) || list.some(x => x.mint === t.mint)) continue
    list.push(t)
  }
  const addresses = await Promise.all(list.map(t => pda.pool(hash, t.mint)))
  const pools = await getAccounts(addresses)
  return Promise.all(list.map(async (t, i) => {
    const p = decode('Pool', pools[i])
    const decimals = t.decimals ?? (await readMint(t.mint)).decimals
    return { mint: t.mint, symbol: t.symbol || `${t.mint.slice(0, 4)}…${t.mint.slice(-4)}`, decimals, balance: p ? p.balance : 0n, epoch: p ? Number(p.epoch) : 0, address: addresses[i], exists: !!p }
  }))
}

/**
 * One depositor's refundable share of a pool, or null without a deposit record. `amount` is 0n once a claim paid
 * the pool out (the record's own number is `recorded`); `refundableAt` is unix seconds.
 */
export async function readDeposit(name, mint, depositor) {
  const hash = await domainHash(name)
  const pool = await pda.pool(hash, mint)
  const address = await pda.deposit(pool, depositor)
  const [p, d, c] = await getAccounts([pool, address, await pda.config()])
  const dep = decode('Deposit', d)
  if (!dep) return null
  const poolData = decode('Pool', p)
  const cfg = decode('Config', c)
  const paidOut = !poolData || dep.epoch !== poolData.epoch
  return { address, amount: paidOut ? 0n : dep.amount, recorded: dep.amount, lastAt: dep.lastAt, refundableAt: dep.lastAt + (cfg ? cfg.refundDelay : 0), paidOut }
}

/** The coins launched for a domain, newest first: [{ mint, launcher, launchedAt, address }]. */
export async function readLaunches(name) {
  const hash = await domainHash(name)
  const res = await call('getProgramAccounts', [PROGRAM_ID, {
    encoding: 'base64', commitment: conn.commitment,
    filters: [{ dataSize: 113 }, { memcmp: { offset: 0, bytes: base58Encode(Uint8Array.from(ACCOUNT.LaunchRecord)) } }, { memcmp: { offset: 8, bytes: base58Encode(hash) } }],
  }])
  return res.map(({ pubkey, account }) => {
    const l = decode('LaunchRecord', { owner: account.owner, data: base64Decode(account.data[0]) })
    return l && sameBytes(l.domainHash, hash) ? { mint: l.mint, launcher: l.launcher, launchedAt: l.launchedAt, address: pubkey } : null
  }).filter(Boolean).sort((a, b) => b.launchedAt - a.launchedAt)
}

/** The claim fees waiting for the fee recipient in one asset (base units). */
export async function readFees(mint) {
  const [a] = await getAccounts([await pda.feeVault(mint)])
  const f = decode('FeeVault', a)
  return f ? f.owed : 0n
}

// ---------- the wallet record a claim reads ----------

/** Where a domain's wallet record is cached: `_wallet.<domain>` TXT, or the WALLET record at the domain. */
export async function recordAddresses(name) {
  const d = canonicalDomain(name)
  return { txt: await pda.rrset(`_wallet.${d}`, TYPE_TXT), wallet: await pda.rrset(d, TYPE_WALLET) }
}

/**
 * The domain's verified wallet records the program holds, newest signature first:
 * [{ address, type ('TXT' | 'WALLET'), wallets, signedAt, expiresAt, expired }].
 */
export async function readRecords(name, { now = Math.floor(Date.now() / 1000) } = {}) {
  const d = canonicalDomain(name)
  const at = await recordAddresses(d)
  const accounts = await getAccounts([at.txt, at.wallet])
  const out = []
  ;[['TXT', at.txt, `_wallet.${d}`], ['WALLET', at.wallet, d]].forEach(([type, address, owner], i) => {
    const a = accounts[i]
    const rec = a && a.owner === PROGRAM_ID ? decodeRrsetAccount(a.data) : null
    if (!rec || !sameBytes(rec.owner, nameToWire(owner))) return
    const wallets = [...new Set(rec.records.map(solWallet).filter(Boolean))]
    out.push({ address, type, wallets, signedAt: rec.signedAt, expiresAt: rec.expiresAt, expired: rec.expiresAt < now })
  })
  return out.sort((a, b) => b.signedAt - a.signedAt)
}

/** The cached record a claim or register for `wallet` should name: the newest unexpired one publishing it. */
async function recordFor(name, wallet) {
  const usable = (await readRecords(name)).filter(x => !x.expired && x.wallets.includes(wallet))
  return usable.length ? usable[0].address : (await recordAddresses(name)).txt
}

// ---------- proofs ----------

let encoderPromise
const proofEncoder = () => (encoderPromise ||= anchorEncoder({ programId: PROGRAM_ID }))

// "_wallet.yoursite.com TXT", "com DS", "root DNSKEY": a set as the step list names it, without the trailing dot.
const setName = s => `${s.ownerName === '.' ? 'root' : s.ownerName.replace(/\.$/, '')} ${s.typeName}`
const stepLabel = (t, steps) => {
  const names = t.steps.map(i => setName(steps[i]))
  if (t.kind === 'upload') return `Upload ${names[0]} (bytes ${t.bytes[0]} to ${t.bytes[1]})`
  if (t.kind === 'append') return 'Finish'
  return `Verify ${names.join(', ')}`
}

/**
 * The fewest transactions that cache `steps` (solana-proof.js steps, parents first) on-chain, skipping sets the
 * program already holds unexpired: [{ label, instructions, extraSigners }], with the plan as `.plan`.
 */
export async function proveStepsTxs({ payer, steps, minLeafSignedAt, now, computeUnitPrice } = {}) {
  const encoder = await proofEncoder()
  const cache = await fetchCache(steps, { encoder, rpc: call, commitment: conn.commitment })
  const plan = await planProof(steps, { payer, encoder, cache, now, minLeafSignedAt, computeUnitPrice })
  const txs = plan.transactions.map(t => ({ label: stepLabel(t, steps), instructions: t.instructions, extraSigners: [], kind: t.kind, size: t.size }))
  return Object.assign(txs, { plan })
}

/**
 * The transactions that cache the domain's `_wallet` proof (fetched over DNS-over-HTTPS unless `steps` are
 * given), skipping cached unexpired sets. A proof older than the one the domain last used is refused here
 * (StaleProof), as the program would, and so is one signed at the same time for another wallet (TiedProof).
 * The result also carries `.record` (the cached leaf's address, for claimIx / registerIx), `.type`
 * ('TXT' | 'WALLET'), `.wallets` and `.plan`.
 */
export async function proveWalletTxs({ payer, name, wallet, steps, now } = {}) {
  const domain = canonicalDomain(name)
  let leafSteps = steps
  if (!leafSteps) leafSteps = (await fetchWalletProof(domain, { wallet })).steps
  const leaf = leafSteps.at(-1)
  const wallets = leafWallets(leaf, domain)
  if (!wallets.length) throw new Error(`The proof's last set publishes no Solana address for ${domain}`)
  if (wallet && !wallets.includes(wallet)) throw new Error(`${domain} does not publish ${wallet}`)
  const d = await readDomain(domain)
  const txs = await proveStepsTxs({ payer, steps: leafSteps, now, minLeafSignedAt: d.lastProof || undefined })
  const record = await pda.rrset(leaf.owner, leaf.rrtype)
  // A record signed at the same time as the domain's last proof can't change its wallet (TiedProof): the wallet
  // registered first keeps it until the zone signs a newer record, which always wins.
  const step = txs.plan.steps.at(-1)
  const signedAt = step.status === 'cached' ? (await readRecords(domain)).find(x => x.address === record)?.signedAt : step.signedAt
  if (d.wallet && signedAt === d.lastProof && !(wallet ? [wallet] : wallets).includes(d.wallet)) {
    throw Object.assign(new Error(`${domain}'s record was signed at the same time as the proof it last used, which named ${d.wallet}. That wallet keeps the domain until ${domain}'s DNS host signs the record again; a newer signature always wins, so try again then.`), { code: 'TiedProof' })
  }
  return Object.assign(txs, { record, type: leaf.rrtype === TYPE_WALLET ? 'WALLET' : 'TXT', wallets })
}

// ---------- escrow ----------

/** The claim fee on `amount`, rounded down as the program does. */
export const feeOf = (amount, feeBps) => (BigInt(amount) * BigInt(feeBps)) / 10_000n

/** Sends SOL or tokens (amount in base units) to a domain's escrow; the first deposit opens its accounts. */
export async function depositIx({ payer, name, mint = 'SOL', amount }) {
  const domain = canonicalDomain(name)
  const hash = await domainHash(domain)
  const pool = await pda.pool(hash, mint)
  const args = concat([str(domain), hash, u64le(amountOf(amount))])
  const head = [ws(payer), r(await pda.config())]
  const tail = [w(await pda.domain(hash)), w(pool), w(await pda.deposit(pool, payer))]
  if (isSol(mint)) return { instructions: [{ programId: PROGRAM_ID, keys: [...head, ...tail, r(SYSTEM_PROGRAM)], data: data('deposit_sol', args) }] }
  const { tokenProgram } = await readMint(mint)
  const keys = [...head, r(mint), ...tail, w(await ata(payer, mint, tokenProgram)), w(await ata(pool, mint, tokenProgram)), r(tokenProgram), r(ATA_PROGRAM), r(SYSTEM_PROGRAM)]
  return { instructions: [{ programId: PROGRAM_ID, keys, data: data('deposit_token', args) }] }
}

/**
 * Refuses an address the program won't pay or record (BadRecipient): a token account or a mint of either token
 * program, or a program. `account` is the wallet's account when the caller has already read it.
 */
async function checkWallet(wallet, account) {
  const a = account === undefined ? (await getAccounts([wallet]))[0] : account
  if (!a) return
  const what = a.executable ? 'a program'
    : a.owner === TOKEN_PROGRAM || a.owner === TOKEN_2022_PROGRAM ? (a.data.length === 82 || a.data[165] === 1 ? 'a token mint' : 'a token account')
      : null
  if (what) throw Object.assign(new Error(`${wallet} is ${what}, not a wallet, so the escrow can't pay or record it. The domain should publish the address of the wallet that receives the funds.`), { code: 'BadRecipient' })
}

/**
 * Pays a domain's pool (SOL or one mint) to the wallet its cached record publishes, minus the claim fee. Anyone
 * can send it. `record` defaults to the newest cached record publishing `wallet` (see proveWalletTxs). Tokens:
 * the wallet's token account is created first if needed. SOL: a payout below the rent minimum to an empty wallet
 * would fail, so the payer funds the wallet's rent in the same transaction.
 */
export async function claimIx({ payer, name, mint = 'SOL', wallet, record }) {
  const domain = canonicalDomain(name)
  const hash = await domainHash(domain)
  const pool = await pda.pool(hash, mint)
  const feeVault = await pda.feeVault(mint)
  record ||= await recordFor(domain, wallet)
  const keys = [ws(payer), r(await pda.config()), w(await pda.domain(hash)), r(record), w(wallet), w(pool), w(feeVault), r(SYSTEM_PROGRAM)]
  const pre = []
  if (isSol(mint)) {
    keys.push(...Array.from({ length: 6 }, () => r(PROGRAM_ID))) // optional accounts: the program id stands for None
    const [p, wa, c] = await getAccounts([pool, wallet, await pda.config()])
    await checkWallet(wallet, wa)
    const balance = decode('Pool', p)?.balance || 0n
    const cfg = decode('Config', c)
    const payout = balance - feeOf(balance, cfg ? cfg.feeBps : 0)
    if (payout > 0n && !(wa && wa.lamports > 0n)) {
      const rent = await rentExempt(0)
      if (payout < rent) pre.push(systemTransfer(payer, wallet, rent))
    }
  } else {
    await checkWallet(wallet)
    const { tokenProgram } = await readMint(mint)
    const walletToken = await ata(wallet, mint, tokenProgram)
    pre.push(createAssociatedTokenAccountIdempotent({ payer, ata: walletToken, owner: wallet, mint, tokenProgram }))
    keys.push(r(mint), w(await ata(pool, mint, tokenProgram)), w(walletToken), w(await ata(feeVault, mint, tokenProgram)), r(tokenProgram), r(ATA_PROGRAM))
  }
  const ix = { programId: PROGRAM_ID, keys, data: data('claim', hash, key(wallet)) }
  return { instructions: [...pre, ix], record }
}

/** Records the domain's newest proof without moving money, so an older record can never claim later payments. */
export async function registerIx({ payer, name, wallet, record }) {
  const domain = canonicalDomain(name)
  const hash = await domainHash(domain)
  await checkWallet(wallet)
  record ||= await recordFor(domain, wallet)
  const keys = [ws(payer), w(await pda.domain(hash)), r(record), r(wallet), r(SYSTEM_PROGRAM)]
  return { instructions: [{ programId: PROGRAM_ID, keys, data: data('register', str(domain), hash, key(wallet)) }], record }
}

/** Takes back the payer's unclaimed deposit once the refund delay has passed, and the record's rent. */
export async function refundIx({ payer, name, mint = 'SOL' }) {
  const hash = await domainHash(name)
  const pool = await pda.pool(hash, mint)
  const keys = [ws(payer), r(await pda.config()), w(pool), w(await pda.deposit(pool, payer)), r(SYSTEM_PROGRAM)]
  const pre = []
  if (isSol(mint)) keys.push(...Array.from({ length: 4 }, () => r(PROGRAM_ID)))
  else {
    const { tokenProgram } = await readMint(mint)
    const own = await ata(payer, mint, tokenProgram)
    pre.push(createAssociatedTokenAccountIdempotent({ payer, ata: own, owner: payer, mint, tokenProgram }))
    keys.push(r(mint), w(await ata(pool, mint, tokenProgram)), w(own), r(tokenProgram))
  }
  return { instructions: [...pre, { programId: PROGRAM_ID, keys, data: data('refund', hash, mintBytes(mint)) }] }
}

/** Sends the claim fees owed in one asset to the configured fee recipient. Anyone can send it. */
export async function withdrawFeesIx({ payer, mint = 'SOL' }) {
  const cfg = await readConfig()
  if (!cfg) throw new Error('The program is not initialized')
  const feeVault = await pda.feeVault(mint)
  const keys = [ws(payer), r(cfg.address), w(feeVault), w(cfg.feeRecipient), r(SYSTEM_PROGRAM)]
  const pre = []
  if (isSol(mint)) {
    keys.push(...Array.from({ length: 5 }, () => r(PROGRAM_ID)))
    // Same rent rule as a claim: a small first payment to an empty recipient needs its rent alongside.
    const [fv, rec] = await getAccounts([feeVault, cfg.feeRecipient])
    const owed = decode('FeeVault', fv)?.owed || 0n
    if (owed > 0n && !(rec && rec.lamports > 0n) && owed < await rentExempt(0)) pre.push(systemTransfer(payer, cfg.feeRecipient, await rentExempt(0)))
  } else {
    const { tokenProgram } = await readMint(mint)
    keys.push(r(mint), w(await ata(feeVault, mint, tokenProgram)), w(await ata(cfg.feeRecipient, mint, tokenProgram)), r(tokenProgram), r(ATA_PROGRAM))
  }
  return { instructions: [...pre, { programId: PROGRAM_ID, keys, data: data('withdraw_fees', mintBytes(mint)) }] }
}

// ---------- admin ----------

/** One-time setup, signed by the program's upgrade authority. */
export async function initializeIx({ authority, admin = authority, feeRecipient, feeBps = 50, refundDelay = 180 * 86_400 }) {
  const keys = [ws(authority), w(await pda.config()), r(PROGRAM_ID), r(await pda.programData()), r(SYSTEM_PROGRAM)]
  const args = concat([key(admin), key(feeRecipient), u16le(feeBps), i64le(refundDelay)])
  return { instructions: [{ programId: PROGRAM_ID, keys, data: data('initialize', args) }] }
}

/** The admin pauses or resumes new deposits. Claims, refunds and fee withdrawals never pause. */
export async function setDepositsPausedIx({ admin, paused }) {
  return { instructions: [{ programId: PROGRAM_ID, keys: [meta(admin, true, false), w(await pda.config())], data: data('set_deposits_paused', u8(paused ? 1 : 0)) }] }
}

// ---------- pump.fun ----------

const computeLimit = units => ({ programId: COMPUTE_BUDGET_PROGRAM, keys: [], data: concat([u8(2), u32le(units)]) })
const pumpData = (disc, ...args) => concat([Uint8Array.from(disc), ...args])
const BUY_V3 = [7, 5, 29, 196, 245, 23, 101, 80]
const SWEEP_CREATOR_FEE = [32, 246, 191, 52, 8, 201, 73, 186]

/** pump's Global fields a buy needs (offsets from its IDL, checked against the mainnet account in the tests). */
export function decodePumpGlobal(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const u64 = at => v.getBigUint64(at, true)
  return {
    initialVirtualTokenReserves: u64(73), initialVirtualSolReserves: u64(81), initialRealTokenReserves: u64(89),
    tokenTotalSupply: u64(97), buybackFeeRecipients: Array.from({ length: 8 }, (_, i) => base58Encode(bytes.slice(741 + 32 * i, 773 + 32 * i))),
  }
}

/** pump's BondingCurve (the fields the launcher and quotes use). */
export function decodeBondingCurve(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const u64 = at => v.getBigUint64(at, true)
  return {
    virtualTokenReserves: u64(8), virtualSolReserves: u64(16), realTokenReserves: u64(24), realSolReserves: u64(32),
    tokenTotalSupply: u64(40), complete: bytes[48] !== 0, creator: base58Encode(bytes.slice(49, 81)), quoteMint: base58Encode(bytes.slice(83, 115)),
    creatorFeeBps: u64(115), creatorFee: bytes.length >= 133 ? u64(125) : 0n,
  }
}

/** pump's fee config: the flat fees and the market-cap tiers, in basis points. */
export function decodeFeeConfig(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const u64 = at => v.getBigUint64(at, true)
  const fees = at => ({ lp: u64(at), protocol: u64(at + 8), creator: u64(at + 16) })
  const tiers = Array.from({ length: v.getUint32(65, true) }, (_, i) => {
    const at = 69 + 40 * i
    return { threshold: u64(at) | (u64(at + 8) << 64n), ...fees(at + 16) }
  })
  return { flat: fees(41), tiers }
}

/** The fees a curve trade pays at this market cap (lamports): the last tier at or below it, else the flat fees. */
export function curveFees(feeConfig, marketCap) {
  const tier = feeConfig.tiers.filter(t => t.threshold <= marketCap).at(-1)
  return tier || feeConfig.flat
}

const ceilDiv = (a, b) => (a + b - 1n) / b

/** What buying `tokens` costs on a curve, fees included, as pump computes it. */
export function buyCost(curve, fees, tokens) {
  const sol = (tokens * curve.virtualSolReserves) / (curve.virtualTokenReserves - tokens) + 1n
  return sol + ceilDiv(sol * fees.protocol, 10_000n) + ceilDiv(sol * fees.creator, 10_000n) + ceilDiv(sol * fees.lp, 10_000n)
}

/** The most tokens `lamports` buys on a curve, fees included (never more than the curve has left). */
export function quoteBuy(curve, fees, lamports) {
  const budget = BigInt(lamports)
  const total = fees.protocol + fees.creator + fees.lp
  const net = (budget * 10_000n) / (10_000n + total)
  let hi = (net * curve.virtualTokenReserves) / (curve.virtualSolReserves + net)
  if (hi > curve.realTokenReserves) hi = curve.realTokenReserves
  // Rounding in pump's favour can make that a few lamports too dear: take the largest amount that fits.
  let lo = 0n
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n
    if (buyCost(curve, fees, mid) <= budget) lo = mid; else hi = mid - 1n
  }
  return lo
}

async function pumpState(mint) {
  const [g, fc, bc] = await getAccounts([PUMP.global, PUMP.feeConfig, ...(mint ? [await pumpPda.bondingCurve(mint)] : [])])
  if (!g || !fc) throw new Error("Can't read pump.fun's settings")
  return { global: decodePumpGlobal(g.data), feeConfig: decodeFeeConfig(fc.data), curve: bc ? decodeBondingCurve(bc.data) : null }
}

const curveFeesOf = (curve, feeConfig) => {
  const fees = curveFees(feeConfig, (curve.virtualSolReserves * curve.tokenTotalSupply) / curve.virtualTokenReserves)
  return curve.creatorFeeBps > 0n ? { ...fees, creator: curve.creatorFeeBps } : fees
}

/** The 17 accounts of a pump buy_v3 / sell_v3 for a SOL-paired coin. */
async function tradeKeys(mint, user) {
  const curve = await pumpPda.bondingCurve(mint)
  return [
    r(PUMP.global), r(mint), r(WSOL), r(TOKEN_2022_PROGRAM), r(TOKEN_PROGRAM), w(curve),
    w(await ata(curve, mint, TOKEN_2022_PROGRAM)), w(await ata(curve, WSOL)), ws(user), w(await ata(user, mint, TOKEN_2022_PROGRAM)),
    w(await ata(user, WSOL)), w(await pumpPda.userVolume(user)), r(PUMP.feeConfig), w(PUMP.buyback), r(SYSTEM_PROGRAM),
    r(PUMP.eventAuthority), r(PUMP.program),
  ]
}

async function buyInstructions({ payer, mint, tokens, maxSolCost }) {
  return [
    createAssociatedTokenAccountIdempotent({ payer, ata: await ata(payer, mint, TOKEN_2022_PROGRAM), owner: payer, mint, tokenProgram: TOKEN_2022_PROGRAM }),
    { programId: PUMP.program, keys: await tradeKeys(mint, payer), data: pumpData(BUY_V3, u64le(tokens), u64le(maxSolCost), u8(0)) },
  ]
}

/**
 * A buy of a domain coin on its bonding curve for at most `buyLamports`, fees included: the payer's token account
 * (created if needed) and pump's buy_v3 for the most tokens that buys now. Throws below `minTokens`.
 */
export async function buyIxs({ payer, mint, buyLamports, minTokens = 0n }) {
  const { feeConfig, curve } = await pumpState(mint)
  if (!curve) throw new Error('No pump.fun bonding curve for this coin')
  if (curve.complete) throw new Error('This coin has left its bonding curve; it trades on PumpSwap now')
  const tokens = quoteBuy(curve, curveFeesOf(curve, feeConfig), amountOf(buyLamports))
  if (tokens <= 0n || tokens < BigInt(minTokens)) throw new Error('That buys fewer tokens than the minimum')
  return { instructions: await buyInstructions({ payer, mint, tokens, maxSolCost: BigInt(buyLamports) }), tokens }
}

/** An address lookup table's addresses, for v0 transactions. */
export async function readLookupTable(address) {
  const [a] = await getAccounts([address])
  if (!a || a.owner !== LOOKUP_TABLE_PROGRAM) throw new Error(`No address lookup table at ${address}`)
  const addresses = []
  for (let at = 56; at + 32 <= a.data.length; at += 32) addresses.push(base58Encode(a.data.slice(at, at + 32)))
  return { key: address, addresses }
}
const tablesOf = () => Promise.all(conn.lookupTables.map(readLookupTable))

/**
 * Launches a pump.fun coin for a domain through the program, whose creator fees can then only reach the domain's
 * pool. With buyLamports > 0 the payer's opening buy (at most that much SOL, fees included, at least minTokens)
 * rides in the same transaction, before anyone else can trade. Send it as is with sendAll: it is a v0 transaction
 * over the configured lookup table, and the new mint's keypair (mintKeypair) co-signs it. A mintKeypair can be
 * passed in ({ publicKey, sign }), for a vanity address.
 */
export async function launchTx({ payer, name, tokenName, symbol, uri, buyLamports = 0n, minTokens = 0n, mintKeypair }) {
  const domain = canonicalDomain(name)
  if (!String(tokenName || '').trim() || !String(symbol || '').trim() || !String(uri || '').trim()) throw new Error('A coin needs a name, a symbol and a metadata URI')
  const hash = await domainHash(domain)
  mintKeypair ||= await keypair()
  const mint = mintKeypair.publicKey
  const curve = await pumpPda.bondingCurve(mint)
  const keys = [
    ws(payer), w(await pda.domain(hash)), w(await pda.creator(hash)), ws(mint), w(await pda.launch(mint)), r(PUMP.program), r(SYSTEM_PROGRAM),
    // pump's create_v2 accounts, in pump's order (remaining accounts)
    ws(mint), r(PUMP.mintAuthority), w(curve), w(await ata(curve, mint, TOKEN_2022_PROGRAM)), r(PUMP.global), ws(payer),
    r(SYSTEM_PROGRAM), r(TOKEN_2022_PROGRAM), r(ATA_PROGRAM), w(PUMP.mayhem), r(PUMP.mayhemGlobalParams), w(PUMP.mayhemSolVault),
    w(await pumpPda.mayhemState(mint)), w(await ata(PUMP.mayhemSolVault, mint, TOKEN_2022_PROGRAM)), r(PUMP.eventAuthority), r(PUMP.program),
  ]
  const instructions = [computeLimit(LAUNCH_COMPUTE_UNITS), { programId: PROGRAM_ID, keys, data: data('launch', str(domain), hash, str(tokenName), str(symbol), str(uri)) }]
  let tokens = 0n
  if (BigInt(buyLamports) > 0n) {
    // The curve is created in this same transaction, so the quote is exact: pump's starting reserves.
    const { global, feeConfig } = await pumpState()
    const fresh = {
      virtualTokenReserves: global.initialVirtualTokenReserves, virtualSolReserves: global.initialVirtualSolReserves,
      realTokenReserves: global.initialRealTokenReserves, tokenTotalSupply: global.tokenTotalSupply, creatorFeeBps: 0n,
    }
    tokens = quoteBuy(fresh, curveFeesOf(fresh, feeConfig), buyLamports)
    if (tokens <= 0n || tokens < BigInt(minTokens)) throw new Error('That buys fewer tokens than the minimum')
    instructions.push(...await buyInstructions({ payer, mint, tokens, maxSolCost: BigInt(buyLamports) }))
  }
  const lookupTables = await tablesOf()
  return { instructions, mintKeypair, extraSigners: [mintKeypair], lookupTables, mint, tokens, label: `Launch ${symbol} for ${domain}` }
}

/**
 * Moves a domain's pump.fun creator fees into its SOL pool: pump's sweep for each coin with fees waiting on its
 * curve (and PumpSwap's for a graduated coin's pool), then the program's collect. `mint` limits it to one coin;
 * without it every coin the domain launched here is swept. `pending` is what the sweeps should move (lamports).
 */
export async function collectIx({ payer, name, mint }) {
  const hash = await domainHash(name)
  const creator = await pda.creator(hash)
  const mints = mint ? [mint] : (await readLaunches(name)).map(l => l.mint)
  const vault = await pumpPda.creatorVault(creator)
  const ammVault = await pumpPda.ammCreatorVault(creator)
  const curves = await getAccounts(await Promise.all(mints.map(m => pumpPda.bondingCurve(m))))
  const sweeps = []
  let pending = 0n
  for (const [i, m] of mints.entries()) {
    const c = curves[i] && decodeBondingCurve(curves[i].data)
    if (!c || c.creator !== creator) continue
    if (c.creatorFee > 0n) {
      pending += c.creatorFee
      const curve = await pumpPda.bondingCurve(m)
      sweeps.push({
        programId: PUMP.program,
        keys: [ws(payer), r(PUMP.global), r(m), r(WSOL), r(TOKEN_PROGRAM), r(ATA_PROGRAM), r(SYSTEM_PROGRAM), w(curve), w(await ata(curve, WSOL)), w(vault), w(await ata(vault, WSOL)), r(PUMP.eventAuthority), r(PUMP.program)],
        data: Uint8Array.from(SWEEP_CREATOR_FEE),
      })
    }
    if (c.complete) {
      // A graduated coin also earns on its canonical PumpSwap pool; its sweep pays the pool's creator vault.
      const pool = await pumpPda.canonicalPool(m)
      const [pa] = await getAccounts([pool])
      const fees = pa && pa.data.length >= 287 ? new DataView(pa.data.buffer, pa.data.byteOffset).getBigUint64(279, true) : 0n
      if (fees > 0n) {
        pending += fees
        sweeps.push({
          programId: PUMP.amm,
          keys: [ws(payer), r(PUMP.ammGlobalConfig), w(pool), r(WSOL), r(TOKEN_PROGRAM), w(await ata(pool, WSOL)), r(ammVault), w(await ata(ammVault, WSOL)), r(SYSTEM_PROGRAM), r(ATA_PROGRAM), r(PUMP.ammEventAuthority), r(PUMP.amm)],
          data: Uint8Array.from(SWEEP_CREATOR_FEE),
        })
      }
    }
  }
  // Fees swept earlier but not collected yet wait in the creator vault above its rent.
  const [v, dom] = await getAccounts([vault, await pda.domain(hash)])
  if (!dom) throw new Error(`${canonicalDomain(name)} has no account in the program yet: a launch, deposit or register opens it`)
  if (v) { const above = v.lamports - await rentExempt(v.data.length); if (above > 0n) pending += above }
  const keys = [
    ws(payer), r(await pda.domain(hash)), w(creator), w(await ata(creator, WSOL)), w(await pda.pool(hash, 'SOL')), w(vault), w(await ata(vault, WSOL)),
    r(PUMP.eventAuthority), r(PUMP.program), r(ammVault), w(await ata(ammVault, WSOL)), r(PUMP.ammEventAuthority), r(PUMP.amm), r(WSOL),
    r(TOKEN_PROGRAM), r(ATA_PROGRAM), r(SYSTEM_PROGRAM),
  ]
  return { instructions: [...sweeps, { programId: PROGRAM_ID, keys, data: data('collect', hash) }], pending }
}

/**
 * The transaction that creates an address lookup table holding `addresses` (by default the launch accounts),
 * with the payer as its authority. A table is usable from the slot after it was extended. `recentSlot` must be
 * a recent slot (getSlot).
 */
export async function lookupTableTx({ payer, recentSlot, addresses = LAUNCH_LOOKUP_ADDRESSES }) {
  const slot = BigInt(recentSlot)
  const [table, bump] = await findProgramAddress([key(payer), u64le(slot)], LOOKUP_TABLE_PROGRAM)
  const create = { programId: LOOKUP_TABLE_PROGRAM, keys: [w(table), meta(payer, true, false), ws(payer), r(SYSTEM_PROGRAM)], data: concat([u32le(0), u64le(slot), u8(bump)]) }
  const extend = { programId: LOOKUP_TABLE_PROGRAM, keys: [w(table), meta(payer, true, false), ws(payer), r(SYSTEM_PROGRAM)], data: concat([u32le(2), u64le(addresses.length), ...addresses.map(key)]) }
  return { address: table, instructions: [create, extend], extraSigners: [], label: 'Create the launch lookup table' }
}

// ---------- keys and transactions ----------

export { compileV0 } // in solana.js, shared with the vault client's launches

/** A fresh Ed25519 keypair from WebCrypto, for a new coin's mint: { publicKey, sign(message) }. Never leaves the page. */
export async function keypair() {
  const k = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])
  const publicKey = base58Encode(new Uint8Array(await crypto.subtle.exportKey('raw', k.publicKey)))
  return { publicKey, sign: async message => new Uint8Array(await crypto.subtle.sign('Ed25519', k.privateKey, message)) }
}

function shortvec(n) {
  const out = []
  for (;;) {
    const b = n & 0x7f
    n >>= 7
    if (!n) { out.push(b); return out }
    out.push(b | 0x80)
  }
}
function readShortvec(b, at) {
  let n = 0
  for (let i = 0; ; i++) {
    const x = b[at + i]
    n |= (x & 0x7f) << (7 * i)
    if (!(x & 0x80)) return [n, at + i + 1]
  }
}

/**
 * The wire bytes of one unsigned transaction: legacy when it fits, else v0 over `tx.lookupTables`. Signature
 * slots are zero until the wallet and the extra signers fill them in.
 */
export function buildTransaction(tx, payer, recentBlockhash) {
  const legacy = serializeMessage(compileMessage({ payer, recentBlockhash, instructions: tx.instructions }))
  const wire = message => concat([Uint8Array.from(shortvec(message[message[0] & 0x80 ? 1 : 0])), new Uint8Array(64 * message[message[0] & 0x80 ? 1 : 0]), message])
  let out = wire(legacy)
  if (out.length > LEGACY_TX_LIMIT && tx.lookupTables && tx.lookupTables.length) out = wire(compileV0({ payer, recentBlockhash, instructions: tx.instructions, tables: tx.lookupTables }))
  if (out.length > LEGACY_TX_LIMIT) throw Object.assign(new Error(`Transaction too large (${out.length} bytes)${tx.lookupTables && tx.lookupTables.length ? '' : '; it needs the launch lookup table (config.SOLANA_LOOKUP_TABLE)'}`), { tooLarge: true })
  return out
}

/** The signer keys of a wire transaction, in signature-slot order, and where its message starts. */
export function signersOf(txBytes) {
  const [count, sigsAt] = readShortvec(txBytes, 0)
  const msgAt = sigsAt + 64 * count
  const head = msgAt + (txBytes[msgAt] & 0x80 ? 1 : 0)
  const [, keysAt] = readShortvec(txBytes, head + 3)
  const signers = Array.from({ length: txBytes[head] }, (_, i) => base58Encode(txBytes.subarray(keysAt + 32 * i, keysAt + 32 * i + 32)))
  return { count, sigsAt, msgAt, signers }
}

/** Adds the signatures of `signers` ({ publicKey, sign }) over the transaction's message, in their slots. */
export async function addSignatures(txBytes, signers = []) {
  const out = Uint8Array.from(txBytes)
  const { sigsAt, msgAt, signers: slots } = signersOf(out)
  const message = out.subarray(msgAt)
  for (const s of signers) {
    const i = slots.indexOf(s.publicKey)
    if (i < 0) throw new Error(`${s.publicKey} does not sign this transaction`)
    out.set(await s.sign(message), sigsAt + 64 * i)
  }
  return out
}

/** The fee payer's signature (the transaction id) of a signed wire transaction. */
export const transactionId = txBytes => { const { sigsAt } = signersOf(txBytes); return base58Encode(txBytes.subarray(sigsAt, sigsAt + 64)) }

/** The program error a failed send or confirmation carries: { code, name, message } or null. */
export function programError(err) {
  const raw = err && (err.data?.err || err.transactionError)
  const ie = raw && raw.InstructionError
  let code = ie && ie[1] && typeof ie[1] === 'object' && 'Custom' in ie[1] ? ie[1].Custom : null
  if (code == null) {
    const m = /custom program error: 0x([0-9a-f]+)/i.exec(String(err && err.message))
    if (m) code = parseInt(m[1], 16)
  }
  if (code == null) return null
  const [name, message] = ERRORS[code] || [`Error${code}`, `Program error ${code}`]
  return { code, name, message, instruction: ie ? ie[0] : null }
}

/** One error for a failed transaction: the program's reason when there is one, with the logs and context kept. */
function failure(err, ctx) {
  const pe = programError(err)
  const e = new Error(pe ? `${ctx.label}: ${pe.message} (${pe.name})` : `${ctx.label}: ${err.message}`, { cause: err })
  return Object.assign(e, ctx, { programError: pe, logs: err.data?.logs || err.logs || null })
}

/** Polls the signature until it is confirmed; throws with the program error if the transaction failed. */
async function confirmTx(signature, lastValidBlockHeight, { timeout = 120_000 } = {}) {
  const until = Date.now() + timeout
  for (let i = 0; Date.now() < until; i++) {
    const { value: [s] } = await call('getSignatureStatuses', [[signature]])
    if (s && s.err) throw Object.assign(new Error(`Transaction failed: ${JSON.stringify(s.err)}`), { transactionError: s.err, signature })
    if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return s
    if (!s && lastValidBlockHeight && i % 4 === 3 && (await call('getBlockHeight', [{ commitment: 'confirmed' }])) > lastValidBlockHeight) {
      throw new Error('The transaction expired before it landed. Nothing was sent; try again.')
    }
    await new Promise(res => setTimeout(res, i < 10 ? 400 : 1500))
  }
  throw new Error(`Still pending after ${timeout / 60_000} minutes (${signature}).`)
}

/**
 * The connected wallet as { address, signTransaction?, signAndSend? }. Takes solana.js's state ({ wallet,
 * account }), a Wallet Standard wallet, or a plain signer { address, signTransaction(bytes) -> bytes }.
 */
function walletSigner(input) {
  const wl = input || state
  if (wl.address && (wl.signTransaction || wl.signAndSendTransaction)) {
    return { address: wl.address, versions: wl.supportedTransactionVersions, signTransaction: wl.signTransaction && (tx => wl.signTransaction(tx)), signAndSend: wl.signAndSendTransaction && (tx => wl.signAndSendTransaction(tx)) }
  }
  const wallet = wl.features ? wl : wl.wallet
  const account = wl.features ? (wl.accounts || [])[0] : wl.account
  if (!wallet || !account) throw new Error('Connect a Solana wallet first.')
  const sign = wallet.features['solana:signTransaction']
  const send = wallet.features['solana:signAndSendTransaction']
  return {
    address: account.address,
    versions: (sign || send || {}).supportedTransactionVersions,
    signTransaction: sign && (async tx => (await sign.signTransaction({ account, transaction: tx, chain: conn.chain }))[0].signedTransaction),
    signAndSend: send && (async tx => base58Encode((await send.signAndSendTransaction({ account, transaction: tx, chain: conn.chain, options: { preflightCommitment: conn.commitment } }))[0].signature)),
  }
}

/**
 * Sends transactions ({ label, instructions, extraSigners, lookupTables }) in order from the connected wallet,
 * each confirmed before the next is signed, so a proof's later steps find the earlier ones cached. The wallet
 * signs first (it may add its own instructions), then the extra signers sign what it returned. `onStep` hears
 * { index, total, label, status: 'signing' | 'sending' | 'confirming' | 'confirmed', signature }. Returns the
 * signatures; a failure throws with `programError` ({ code, name, message }), `logs`, `index` and the
 * `signatures` that landed before it.
 */
export async function sendAll(wallet, txs, onStep = () => {}) {
  const signer = walletSigner(wallet)
  const signatures = []
  for (const [index, tx] of txs.entries()) {
    const ctx = { index, total: txs.length, label: tx.label || `Transaction ${index + 1} of ${txs.length}` }
    let signature
    try {
      onStep({ ...ctx, status: 'signing' })
      const { value: { blockhash, lastValidBlockHeight } } = await call('getLatestBlockhash', [{ commitment: conn.commitment }])
      let unsigned
      try {
        unsigned = buildTransaction(tx, signer.address, blockhash)
      } catch (err) {
        // A transaction built without its tables (only the instructions passed on) still gets the configured ones.
        if (!err.tooLarge || (tx.lookupTables && tx.lookupTables.length) || !conn.lookupTables.length) throw err
        unsigned = buildTransaction({ ...tx, lookupTables: await tablesOf() }, signer.address, blockhash)
      }
      if ((unsigned[1 + 64 * unsigned[0]] & 0x80) && signer.versions && !signer.versions.includes(0)) throw new Error('This wallet cannot sign version 0 transactions')
      const extra = tx.extraSigners || []
      if (signer.signTransaction) {
        const signed = await addSignatures(await signer.signTransaction(unsigned), extra)
        signature = transactionId(signed)
        onStep({ ...ctx, status: 'sending', signature })
        await call('sendTransaction', [base64Encode(signed), { encoding: 'base64', preflightCommitment: conn.commitment, skipPreflight: !!conn.skipPreflight }])
      } else {
        signature = await signer.signAndSend(await addSignatures(unsigned, extra))
      }
      onStep({ ...ctx, status: 'confirming', signature })
      await confirmTx(signature, lastValidBlockHeight)
    } catch (err) {
      throw failure(err, { ...ctx, signature, signatures: [...signatures] })
    }
    signatures.push(signature)
    onStep({ ...ctx, status: 'confirmed', signature })
  }
  return signatures
}
