// Shared helpers for the pump.fun scripts: base58, PDAs, a gentle mainnet JSON-RPC client, a legacy
// transaction encoder and readers for the pump accounts we touch. No npm dependencies, so the scripts
// run from a bare checkout with Node 18+.
import { createHash, randomBytes } from 'node:crypto'

// ---------- program ids (pump-fun/pump-public-docs, @pump-fun/pump-sdk 4.x) ----------

export const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
export const PUMP_AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'
export const PUMP_FEES = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ'
export const MAYHEM = 'MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e'
export const SYSTEM = '11111111111111111111111111111111'
export const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
export const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
export const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
export const METAPLEX = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'
export const WSOL = 'So11111111111111111111111111111111111111112'

// ---------- base58 ----------

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
  for (const c of str) {
    const i = ALPHABET.indexOf(c)
    if (i < 0) throw new Error(`bad base58: ${str}`)
    n = n * 58n + BigInt(i)
  }
  let hex = n === 0n ? '' : n.toString(16)
  if (hex.length % 2) hex = '0' + hex
  const lead = str.match(/^1*/)[0].length
  return Buffer.concat([Buffer.alloc(lead), Buffer.from(hex, 'hex')])
}

export const pk = s => { const b = b58decode(s); if (b.length !== 32) throw new Error(`not a pubkey: ${s}`); return b }

// ---------- ed25519 curve check and PDAs ----------

const P = 2n ** 255n - 19n
const modp = x => ((x % P) + P) % P
function powmod(b, e) { let r = 1n; b = modp(b); while (e > 0n) { if (e & 1n) r = r * b % P; b = b * b % P; e >>= 1n } return r }
const D = modp(-121665n * powmod(121666n, P - 2n))

// Same rule as the runtime (curve25519-dalek decompress): the point is on the curve iff (y^2-1)/(d*y^2+1)
// is a square mod p. PDAs are the addresses where this fails, so no private key can ever sign for them.
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
export const ata = (owner, mint, tokenProgram) => pda([pk(owner), pk(tokenProgram), pk(mint)], ATA_PROGRAM)

// A random on-curve address (a throwaway keypair's public half). Simulations run with sigVerify:false,
// so nothing ever needs the private half and it is never kept.
export function randomOnCurve() {
  for (;;) { const b = randomBytes(32); if (isOnCurve(b)) return b58encode(b) }
}

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
  u128() { const t = this.take(16); return t.readBigUInt64LE(0) | (t.readBigUInt64LE(8) << 64n) }
  pubkey() { return b58encode(this.take(32)) }
  pubkeys(n) { return Array.from({ length: n }, () => this.pubkey()) }
  string() { return this.take(this.u32()).toString('utf8') }
}

// ---------- account readers (layouts from the IDLs in pump-fun/pump-public-docs) ----------

export function readBondingCurve(data) {
  const r = new Reader(data, 8)
  return {
    virtualTokenReserves: r.u64(), virtualQuoteReserves: r.u64(), realTokenReserves: r.u64(), realQuoteReserves: r.u64(),
    tokenTotalSupply: r.u64(), complete: r.bool(), creator: r.pubkey(), isMayhemMode: r.bool(), isCashbackCoin: r.bool(),
    quoteMint: r.pubkey(), creatorFeeBps: r.u64(), canEditCreatorFee: r.bool(), isHolderReward: r.bool(),
    creatorFee: r.u64(), protocolFees: r.u64(), depth: r.u8(), initialVirtualQuoteReserves: r.u64(),
    postCompleteBaseOut: r.u64(), postCompleteQuoteIn: r.u64(), dataLen: data.length,
  }
}

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
  g.buybackBasisPoints = r.u64(); g.initialVirtualQuoteReserves = r.u64(); g.whitelistedQuoteMints = r.pubkeys(1)
  g.creatorFeeConfigurable = r.bool(); g.maxConfigurableCreatorFeeBps = r.u64(); g.holderRewardClaimAuthority = r.pubkey()
  g.isHolderRewardEnabled = r.bool(); g.maxCurveDepth = r.u8(); g.dataLen = data.length
  return g
}

export function readPool(data) {
  const r = new Reader(data, 8)
  return {
    poolBump: r.u8(), index: r.u16(), creator: r.pubkey(), baseMint: r.pubkey(), quoteMint: r.pubkey(), lpMint: r.pubkey(),
    poolBaseTokenAccount: r.pubkey(), poolQuoteTokenAccount: r.pubkey(), lpSupply: r.u64(), coinCreator: r.pubkey(),
    isMayhemMode: r.bool(), isCashbackCoin: r.bool(), virtualQuoteReserves: r.i128(), creatorFeeBps: r.u64(),
    canEditCreatorFee: r.bool(), isHolderReward: r.bool(), protocolFees: r.u64(), creatorFees: r.u64(), dataLen: data.length,
  }
}

export function readGlobalConfig(data) {
  const r = new Reader(data, 8)
  return {
    admin: r.pubkey(), lpFeeBasisPoints: r.u64(), protocolFeeBasisPoints: r.u64(), disableFlags: r.u8(),
    protocolFeeRecipients: r.pubkeys(8), coinCreatorFeeBasisPoints: r.u64(), adminSetCoinCreatorAuthority: r.pubkey(),
    whitelistPda: r.pubkey(), reservedFeeRecipient: r.pubkey(), mayhemModeEnabled: r.bool(), reservedFeeRecipients: r.pubkeys(7),
    isCashbackEnabled: r.bool(), buybackFeeRecipients: r.pubkeys(8), buybackBasisPoints: r.u64(), boostAuthority: r.pubkey(),
    boostEnabled: r.bool(), creatorFeeConfigurable: r.bool(), maxConfigurableCreatorFeeBps: r.u64(),
  }
}

export function readSharingConfig(data) {
  const r = new Reader(data, 8)
  const c = { bump: r.u8(), version: r.u8(), status: ['Paused', 'Active'][r.u8()], mint: r.pubkey(), admin: r.pubkey(), adminRevoked: r.bool() }
  c.shareholders = Array.from({ length: r.u32() }, () => ({ address: r.pubkey(), shareBps: r.u16() }))
  return c
}

const readFees = r => ({ lpFeeBps: r.u64(), protocolFeeBps: r.u64(), creatorFeeBps: r.u64() })
const readTiers = r => Array.from({ length: r.u32() }, () => ({ marketCapLamportsThreshold: r.u128(), fees: readFees(r) }))

export function readFeeConfig(data) {
  const r = new Reader(data, 8)
  return { bump: r.u8(), admin: r.pubkey(), flatFees: readFees(r), feeTiers: readTiers(r), stableFeeTiers: readTiers(r), exoticFlatFees: readFees(r) }
}

// SPL token / Token-2022 account: mint, owner, amount are at the same offsets in both programs.
export function readTokenAccount(data) {
  const r = new Reader(data)
  return { mint: r.pubkey(), owner: r.pubkey(), amount: r.u64() }
}

// Token-2022 mint with the TokenMetadata extension (type 19): name, symbol and uri live in the mint itself.
export function readToken2022Metadata(data) {
  const b = Buffer.from(data)
  if (b.length <= 166) return null
  let o = 166 // 82 mint bytes, padded to the 165-byte account size, then the account type byte
  while (o + 4 <= b.length) {
    const type = b.readUInt16LE(o), len = b.readUInt16LE(o + 2)
    if (type === 19) {
      const r = new Reader(b.subarray(o + 4, o + 4 + len))
      return { updateAuthority: r.pubkey(), mint: r.pubkey(), name: r.string(), symbol: r.string(), uri: r.string() }
    }
    o += 4 + len
  }
  return null
}

export function readMint(data) {
  const r = new Reader(data)
  const hasAuth = r.u32(); const mintAuthority = r.pubkey()
  const supply = r.u64(); const decimals = r.u8(); r.bool()
  const hasFreeze = r.u32(); const freezeAuthority = r.pubkey()
  return { mintAuthority: hasAuth ? mintAuthority : null, supply, decimals, freezeAuthority: hasFreeze ? freezeAuthority : null }
}

// ---------- JSON-RPC ----------

const ENDPOINTS = (process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com,https://solana-rpc.publicnode.com').split(',')
const sleep = ms => new Promise(r => setTimeout(r, ms))
let lastCall = 0

// Public endpoints are rate-limited: space calls out, back off on 429 and fall over to the next endpoint.
export async function rpc(method, params = []) {
  let wait = 600
  for (let attempt = 0; attempt < 8; attempt++) {
    const url = ENDPOINTS[attempt % ENDPOINTS.length]
    const gap = 250 - (Date.now() - lastCall)
    if (gap > 0) await sleep(gap)
    lastCall = Date.now()
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`)
      const j = await res.json()
      if (j.error) {
        if (j.error.code === 429 || /rate|too many/i.test(j.error.message)) throw new Error(j.error.message)
        const e = new Error(`${method}: ${j.error.message}`); e.rpc = j.error; throw e
      }
      return j.result
    } catch (e) {
      if (e.rpc) throw e
      await sleep(wait); wait = Math.min(wait * 2, 8000)
    }
  }
  throw new Error(`${method}: gave up after retries`)
}

export async function getAccount(address) {
  const r = await rpc('getAccountInfo', [address, { encoding: 'base64', commitment: 'confirmed' }])
  if (!r.value) return null
  const v = r.value
  return { pubkey: address, owner: v.owner, lamports: v.lamports, executable: v.executable, rentEpoch: v.rentEpoch, data: Buffer.from(v.data[0], 'base64'), space: v.space }
}

export async function getAccounts(addresses) {
  const out = []
  for (let i = 0; i < addresses.length; i += 100) {
    const r = await rpc('getMultipleAccounts', [addresses.slice(i, i + 100), { encoding: 'base64', commitment: 'confirmed' }])
    r.value.forEach((v, j) => out.push(v ? { pubkey: addresses[i + j], owner: v.owner, lamports: v.lamports, executable: v.executable, rentEpoch: v.rentEpoch, data: Buffer.from(v.data[0], 'base64') } : null))
  }
  return out
}

// ---------- transactions ----------

const compact = n => { const out = []; for (;;) { let b = n & 0x7f; n >>= 7; if (n) b |= 0x80; out.push(b); if (!n) return Buffer.from(out) } }

export const meta = (pubkey, { w = false, s = false } = {}) => ({ pubkey, isWritable: w, isSigner: s })

// Account table shared by both formats: payer first, then writable signers, readonly signers, writable
// non-signers, readonly non-signers, each in order of first use.
function accountTable(payer, ixs) {
  const keys = new Map()
  const add = (k, s, w) => { const e = keys.get(k) || { s: false, w: false, order: keys.size }; e.s ||= s; e.w ||= w; keys.set(k, e) }
  add(payer, true, true)
  for (const ix of ixs) { for (const a of ix.keys) add(a.pubkey, a.isSigner, a.isWritable); add(ix.programId, false, false) }
  const all = [...keys.entries()].map(([k, e]) => ({ k, ...e }))
  const rank = e => e.k === payer ? -1 : (e.s ? (e.w ? 0 : 1) : (e.w ? 2 : 3))
  all.sort((a, b) => rank(a) - rank(b) || a.order - b.order)
  const index = new Map(all.map((e, i) => [e.k, i]))
  const nSig = all.filter(e => e.s).length
  const header = Buffer.from([nSig, all.filter(e => e.s && !e.w).length, all.filter(e => !e.s && !e.w).length])
  return { all, index, nSig, header }
}

// Legacy message, every signature left as zeros: simulateTransaction with sigVerify:false and
// replaceRecentBlockhash:true runs it against current mainnet state without anything being signed or sent.
export function compileLegacy(payer, ixs) {
  const { all, index, nSig, header } = accountTable(payer, ixs)
  const body = [header, compact(all.length), ...all.map(e => pk(e.k)), Buffer.alloc(32), compact(ixs.length)]
  for (const ix of ixs) {
    body.push(u8(index.get(ix.programId)), compact(ix.keys.length), Buffer.from(ix.keys.map(a => index.get(a.pubkey))), compact(ix.data.length), Buffer.from(ix.data))
  }
  const message = Buffer.concat(body)
  const tx = Buffer.concat([compact(nSig), Buffer.alloc(64 * nSig), message])
  return { tx, size: tx.length, limit: 1232, accountKeys: all.map(e => e.k), signers: all.filter(e => e.s).map(e => e.k) }
}

// v1 transaction (SIMD-0385, accepted on mainnet in 2026): up to 4096 bytes and 64 accounts, no lookup
// tables, and the compute budget sits in a header bitmask instead of ComputeBudget instructions. An unset
// compute-unit-limit bit means a limit of 0, so bits 2 (CU limit) and 3 (loaded data size) are always set.
export function compileV1(payer, ixs, { cuLimit = 1_400_000, loadedDataLimit = 64 * 1024 * 1024 } = {}) {
  const { all, index, nSig, header } = accountTable(payer, ixs)
  const parts = [u8(0x81), header, u32((1 << 2) | (1 << 3)), Buffer.alloc(32), u8(ixs.length), u8(all.length), ...all.map(e => pk(e.k)), u32(cuLimit), u32(loadedDataLimit)]
  for (const ix of ixs) parts.push(u8(index.get(ix.programId)), u8(ix.keys.length), u16(ix.data.length))
  for (const ix of ixs) parts.push(Buffer.from(ix.keys.map(a => index.get(a.pubkey))), Buffer.from(ix.data))
  parts.push(Buffer.alloc(64 * nSig))
  const tx = Buffer.concat(parts)
  return { tx, size: tx.length, limit: 4096, accountKeys: all.map(e => e.k), signers: all.filter(e => e.s).map(e => e.k) }
}

export async function simulate(payer, ixs, watch = [], { version = 'legacy' } = {}) {
  const { tx, size, limit, signers, accountKeys } = version === 'v1' ? compileV1(payer, ixs) : compileLegacy(payer, ixs)
  if (size > limit) throw new Error(`${version} transaction is ${size} bytes (${accountKeys.length} accounts), over the ${limit}-byte limit`)
  const r = await rpc('simulateTransaction', [tx.toString('base64'), {
    encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed', innerInstructions: true,
    accounts: { encoding: 'base64', addresses: watch },
  }])
  const v = r.value
  return {
    version, size, accountCount: accountKeys.length, signers, err: v.err, logs: v.logs || [], unitsConsumed: v.unitsConsumed, innerInstructions: v.innerInstructions,
    accounts: (v.accounts || []).map((a, i) => a && { pubkey: watch[i], owner: a.owner, lamports: a.lamports, data: Buffer.from(a.data[0], 'base64') }),
  }
}

// ---------- misc ----------

export const sol = l => (Number(l) / 1e9).toFixed(9)
