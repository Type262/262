// End-to-end run of the type262 program through the browser client (assets/solana-type262.js) on a local
// solana-test-validator, with throwaway keypairs only. It never talks to mainnet or devnet: the RPC is fixed to
// 127.0.0.1:8899 (or another local port with --port) and the run stops if that cluster's genesis hash is a public
// cluster's.
//
// In order, checking exact numbers at each step:
//   initialize as the upgrade authority (anyone else is refused); SOL and SPL-token deposits (a local 6-decimal
//   USDC stand-in) from two depositors; a real DNSSEC chain, root -> com -> cloudflare.com DNSKEY (RSA through the
//   buffer and inline, P-256 packed with the secp256r1 precompile), then the same chain again with nothing to send;
//   a synthetic zone whose DNSKEY set is injected as a cached account at genesis (as the dnssec tests do) and whose
//   Ed25519-signed `_wallet` TXT publishes a SOL wallet; claims of both pools to that wallet with the 0.5% fee; a
//   wallet change proven by a newer record and registered; an older WALLET record refused (StaleProof), one signed at
//   the same time as the last proof refused (TiedProof), a token account or a mint as the wallet refused by the
//   client and the program (BadRecipient); refunds
//   refused before the delay and after a claim; the pause; withdraw_fees; a pump.fun launch through the program with
//   the opening buy in the same v0 transaction; a second trader's buy; collect into the domain's pool; a refund
//   after the delay; and a last claim that pays the collected creator fees out.
//
// Run from the repository root (on Windows the validator runs in WSL; solana/README.md, "Local validator"):
//   node solana/scripts/e2e-local.mjs             fresh validator, the run, then stops it
//   node solana/scripts/e2e-local.mjs --keep      leaves the validator running afterwards
//   node solana/scripts/e2e-local.mjs --command   writes the genesis accounts, prints the validator command, exits
//   node solana/scripts/e2e-local.mjs --running   runs against a fresh validator started with that command
//   node solana/scripts/e2e-local.mjs --restart   stops a validator already on 127.0.0.1:8899 first (otherwise the run refuses)
//   node solana/scripts/e2e-local.mjs --port N    the same on 127.0.0.1:N, next to a validator on 8899 (its own ledger,
//                                                 log and solana/target/e2e-N/; stopping it leaves other validators be)
// Needs target/deploy/type262.so (anchor build), the pump.fun fixtures (node solana/scripts/fetch-fixtures.mjs) and
// solana-test-validator 2.x. The real chain comes over DNS-over-HTTPS (the copy in solana/bench/fixtures when
// offline or with --fixture). Writes solana/target/e2e/report.json (e2e-N/ with --port N).
import assert from 'node:assert/strict'
import { createPrivateKey, generateKeyPairSync, sign as edSign } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as T from '../../assets/solana-type262.js'
import * as P from '../../assets/solana-proof.js'
import { SYSTEM_PROGRAM, TOKEN_PROGRAM, base58Encode, base64Decode, createAssociatedTokenAccountIdempotent, findProgramAddress, pubkeyBytes } from '../../assets/solana.js'
import { DEFAULT_PORT, PROGRAM_ID, RPC_URL, isUp, localRpc, prepareAccounts, startValidator, stopValidator, usePort, validatorCommand } from './e2e-validator.mjs'

const flags = new Set(process.argv.slice(2))
const portAt = process.argv.indexOf('--port')
const PORT = portAt > 0 ? Number(process.argv[portAt + 1]) : DEFAULT_PORT
usePort(PORT)
const WORK_NAME = PORT === DEFAULT_PORT ? 'e2e' : `e2e-${PORT}`
const WORK = fileURLToPath(new URL(`../target/${WORK_NAME}/`, import.meta.url))
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const DOMAIN = 'escrow-e2e.test'
const SOL = 1_000_000_000n
const PUBLIC_GENESIS = {
  '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d': 'mainnet-beta',
  'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG': 'devnet',
  '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY': 'testnet',
}
assert.equal(T.PROGRAM_ID, PROGRAM_ID, 'config.js names another program; the local run uses the test id')

// ---------- keys ----------

/** A throwaway Ed25519 keypair from node:crypto ({ publicKey, sign }), or one saved earlier as a JWK. */
function keypairFrom(jwk) {
  const privateKey = jwk ? createPrivateKey({ key: jwk, format: 'jwk' }) : generateKeyPairSync('ed25519').privateKey
  const j = privateKey.export({ format: 'jwk' })
  const raw = Uint8Array.from(Buffer.from(j.x, 'base64url'))
  return { publicKey: base58Encode(raw), raw, jwk: j, sign: async m => Uint8Array.from(edSign(null, Buffer.from(m), privateKey)) }
}
/** The plain signer sendAll takes in place of a browser wallet. */
const walletOf = kp => ({ address: kp.publicKey, signTransaction: tx => T.addSignatures(tx, [kp]) })

// ---------- bytes ----------
const cat = (...parts) => Uint8Array.from(Buffer.concat(parts.map(p => Buffer.from(p))))
const u16le = n => [n & 255, n >> 8]
const u16be = n => [n >> 8, n & 255]
const u32le = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
const u64le = v => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b }
const i64le = v => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); return b }
const txt = s => cat([s.length], Buffer.from(s, 'latin1'))

// ---------- the synthetic zone ----------

/** DNSKEY RDATA of an Ed25519 zone key: flags 257 (zone, secure entry point), protocol 3, algorithm 15. */
const dnskeyOf = kp => cat(u16be(257), [3, 15], kp.raw)

/**
 * The cached RRset account of a DNSKEY set, as if the program had verified it (the RrSet layout in state.rs):
 * what the dnssec tests write with put_rrset, here loaded at genesis with --account-dir.
 */
async function cachedKeySet(owner, dnskey, signedAt, expiresAt, payer) {
  const wire = P.nameToWire(owner)
  const [pubkey, bump] = await findProgramAddress([Buffer.from('rrset'), await P.sha256(wire), u16be(48)], PROGRAM_ID)
  const rdata = cat(u16le(dnskey.length), dnskey)
  const data = cat(T.ACCOUNT.RrSet, [bump], u16le(48), [15], u16le(P.keyTag(dnskey)), i64le(signedAt), i64le(expiresAt), pubkeyBytes(payer), u32le(wire.length), wire, u32le(rdata.length), rdata)
  return { pubkey, owner: PROGRAM_ID, data }
}

/** A step for `records` at `owner` signed by the zone key, valid from `inception` for a week. */
async function zoneStep(zone, owner, rrtype, records, inception) {
  const rrsig = {
    typeCovered: rrtype, algorithm: 15, labels: owner.split('.').length, originalTtl: 300,
    expiration: inception + 7 * 86_400, inception, keyTag: P.keyTag(dnskeyOf(zone)), signer: P.nameToWire(DOMAIN),
  }
  const signed = P.encodeSigned(rrsig, P.nameToWire(owner), rrtype, records)
  return P.buildStep(signed, await zone.sign(signed))
}

// ---------- chain access ----------

T.configure({ rpcUrl: RPC_URL, chain: 'solana:localnet' })
const rpc = (method, params) => localRpc(method, params).then(r => { if (r === null) throw new Error(`${method} failed`); return r })
const lamports = async a => BigInt((await rpc('getBalance', [a, { commitment: 'confirmed' }])).value)
const tokenBalance = async a => { const [acc] = await T.getAccounts([a]); return acc ? Buffer.from(acc.data).readBigUInt64LE(64) : 0n }
/** The cluster's own clock (Clock sysvar unix_timestamp): signatures and refund delays count from it. */
const chainNow = async () => { const [c] = await T.getAccounts(['SysvarC1ock11111111111111111111111111111111']); return Number(Buffer.from(c.data).readBigInt64LE(32)) }
const pause = ms => new Promise(res => setTimeout(res, ms))
/** Runs fn with console output off: dnsprovejs logs every query it makes. */
async function quietly(fn) {
  const saved = [console.log, console.info, console.debug]
  console.log = console.info = console.debug = () => {}
  try { return await fn() } finally { [console.log, console.info, console.debug] = saved }
}

// ---------- the run, recorded ----------

const report = { cluster: RPC_URL, domain: DOMAIN, startedAt: new Date().toISOString(), transactions: [], checks: [] }
const say = s => process.stdout.write(`${s}\n`)

/** Sends transactions through the client's sendAll and records each signature with its fee and compute units. */
async function send(wallet, txs, note) {
  txs = Array.isArray(txs) ? txs : [txs]
  const signatures = await T.sendAll(walletOf(wallet), txs)
  for (const [i, signature] of signatures.entries()) {
    const t = await rpc('getTransaction', [signature, { encoding: 'base64', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }])
    const bytes = base64Decode(t.transaction[0])
    const entry = { label: txs[i].label || note, signature, ok: true, version: t.version, size: bytes.length, fee: t.meta.fee, computeUnits: t.meta.computeUnitsConsumed, logs: t.meta.logMessages }
    report.transactions.push(entry)
    say(`  ok   ${entry.label.padEnd(58)} ${signature}  ${String(t.version).padEnd(6)} ${String(entry.size).padStart(4)} B ${String(entry.computeUnits).padStart(9)} CU`)
  }
  return signatures
}

/** Sends a transaction that must fail on-chain with the program error `name`; it lands (preflight skipped) for the record. */
async function refused(wallet, tx, name) {
  T.configure({ skipPreflight: true })
  try {
    await T.sendAll(walletOf(wallet), [tx])
  } catch (err) {
    const pe = err.programError
    assert.ok(pe, `${tx.label}: failed without a program error: ${err.message}`)
    assert.equal(pe.name, name, `${tx.label}: expected ${name}, got ${pe.name} (${pe.code})`)
    const entry = { label: tx.label, signature: err.signature, ok: false, error: `${pe.code} ${pe.name}` }
    report.transactions.push(entry)
    say(`  fail ${tx.label.padEnd(58)} ${err.signature}  refused: ${pe.code} ${pe.name}`)
    return
  } finally { T.configure({ skipPreflight: false }) }
  throw new Error(`${tx.label} succeeded; it should have failed with ${name}`)
}

/** Asserts and records one number. */
function check(name, actual, expected) {
  assert.equal(actual, expected, name)
  report.checks.push({ name, value: typeof actual === 'bigint' ? actual.toString() : actual })
  say(`  =    ${name}: ${typeof actual === 'bigint' ? actual.toString() : actual}`)
}

const labelled = (label, built) => ({ ...built, label })
/** Anchor events in a confirmed transaction's logs: "Program data: <base64>" whose first 8 bytes name the event. */
function events(signature, name) {
  const disc = { Claimed: [217, 192, 123, 72, 108, 150, 248, 33], CreatorFeesCollected: [117, 190, 177, 156, 222, 94, 28, 227] }[name]
  const entry = report.transactions.find(t => t.signature === signature)
  return entry.logs.filter(l => l.startsWith('Program data: ')).map(l => Buffer.from(l.slice(14), 'base64')).filter(b => disc.every((x, i) => b[i] === x))
}

// ---------- setup: keys, genesis accounts, the validator ----------

mkdirSync(WORK, { recursive: true })
let saved = existsSync(`${WORK}state.json`) ? JSON.parse(readFileSync(`${WORK}state.json`, 'utf8')) : null
if (!flags.has('--running') || !saved) {
  if (flags.has('--running')) throw new Error('No saved state: run with --command first, then start the validator with the command it prints.')
  const now = Math.floor(Date.now() / 1000)
  saved = { authority: keypairFrom().jwk, zone: keypairFrom().jwk, zonePayer: keypairFrom().publicKey, keySetSignedAt: now - 3600, keySetExpiresAt: now + 30 * 86_400 }
  // Throwaway keys of a local cluster, kept only so --running can find them again (target/ is not committed).
  writeFileSync(`${WORK}state.json`, JSON.stringify(saved, null, 1))
}
const authority = keypairFrom(saved.authority)
const zone = keypairFrom(saved.zone)
const keySet = await cachedKeySet(DOMAIN, dnskeyOf(zone), saved.keySetSignedAt, saved.keySetExpiresAt, saved.zonePayer)

if (!flags.has('--running')) {
  const accountsDir = prepareAccounts(`${WORK}accounts`, [keySet])
  const command = validatorCommand({ authority: authority.publicKey, accountsDir })
  if (flags.has('--command')) {
    say(`Genesis accounts in ${accountsDir}. Start the validator${process.platform === 'win32' ? ' in WSL' : ''} with:\n\n${command}\n\nthen: node solana/scripts/e2e-local.mjs --running${PORT === DEFAULT_PORT ? '' : ` --port ${PORT}`}`)
    process.exit(0)
  }
  if (await isUp()) {
    if (!flags.has('--restart')) throw new Error(`A validator already answers on ${RPC_URL}. Stop it (node solana/scripts/e2e-validator.mjs stop${PORT === DEFAULT_PORT ? '' : ` --port ${PORT}`}), pass --restart, or use --running.`)
    stopValidator()
  }
  say('Starting solana-test-validator (fresh ledger)...')
  await startValidator({ authority: authority.publicKey, accountsDir })
}

const genesis = await rpc('getGenesisHash')
if (PUBLIC_GENESIS[genesis]) throw new Error(`${RPC_URL} is ${PUBLIC_GENESIS[genesis]}; this run only uses a local validator`)
report.genesisHash = genesis
report.validator = (await rpc('getVersion'))['solana-core']
say(`Local cluster ${genesis}, solana-core ${report.validator}, program ${PROGRAM_ID}`)

let failed = null
try {
  await run()
} catch (err) {
  failed = err
  say(`\nFAILED: ${err.message}`)
  if (err.logs) say(err.logs.join('\n'))
  if (err.cause && err.cause.data && err.cause.data.logs) say(err.cause.data.logs.join('\n'))
} finally {
  report.finishedAt = new Date().toISOString()
  report.ok = !failed
  writeFileSync(`${WORK}report.json`, JSON.stringify(report, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 1))
  if (!flags.has('--keep') && !flags.has('--running')) stopValidator()
}
say(failed ? '\nE2E FAILED' : `\nE2E PASSED: ${report.transactions.length} transactions, ${report.checks.length} checks. Report: solana/target/${WORK_NAME}/report.json`)
process.exit(failed ? 1 : 0)

async function run() {
  // ---------- accounts ----------
  const [alice, bob, relayer, launcher, trader, walletA, walletB, feeRecipient, usdcMint] = Array.from({ length: 9 }, () => keypairFrom())
  for (const [kp, n] of [[authority, 20n], [alice, 10n], [bob, 10n], [relayer, 10n], [launcher, 5n], [trader, 5n]]) {
    const sig = await rpc('requestAirdrop', [kp.publicKey, Number(n * SOL), { commitment: 'confirmed' }])
    for (let i = 0; i < 80 && !['confirmed', 'finalized'].includes((await rpc('getSignatureStatuses', [[sig]])).value[0]?.confirmationStatus); i++) await pause(250)
  }
  say(`\nKeys (throwaway): authority ${authority.publicKey}, depositors ${alice.publicKey} ${bob.publicKey}, relayer ${relayer.publicKey}`)
  say(`  domain wallet A ${walletA.publicKey}, wallet B ${walletB.publicKey}, fee recipient ${feeRecipient.publicKey}`)
  report.keys = Object.fromEntries(Object.entries({ authority, alice, bob, relayer, launcher, trader, walletA, walletB, feeRecipient, usdcMint }).map(([k, v]) => [k, v.publicKey]))

  // ---------- initialize ----------
  say('\n1. initialize')
  const REFUND_DELAY = 20
  const init = { admin: authority.publicKey, feeRecipient: feeRecipient.publicKey, feeBps: 50, refundDelay: REFUND_DELAY }
  await refused(alice, labelled('initialize by someone else', await T.initializeIx({ authority: alice.publicKey, ...init })), 'NotUpgradeAuthority')
  await send(authority, labelled('initialize (upgrade authority)', await T.initializeIx({ authority: authority.publicKey, ...init })))
  const cfg = await T.readConfig()
  check('config.admin', cfg.admin, authority.publicKey)
  check('config.feeRecipient', cfg.feeRecipient, feeRecipient.publicKey)
  check('config.feeBps', cfg.feeBps, 50)
  check('config.refundDelay', cfg.refundDelay, REFUND_DELAY)
  check('config.depositsPaused', cfg.depositsPaused, false)

  // ---------- a local USDC stand-in ----------
  say('\n2. USDC stand-in mint (6 decimals) and deposits')
  const USDC = usdcMint.publicKey
  const mintRent = BigInt(await rpc('getMinimumBalanceForRentExemption', [82]))
  const createMint = {
    programId: SYSTEM_PROGRAM, keys: [{ pubkey: authority.publicKey, isSigner: true, isWritable: true }, { pubkey: USDC, isSigner: true, isWritable: true }],
    data: cat(u32le(0), u64le(mintRent), u64le(82), pubkeyBytes(TOKEN_PROGRAM)),
  }
  const initMint = { programId: TOKEN_PROGRAM, keys: [{ pubkey: USDC, isSigner: false, isWritable: true }], data: cat([20, 6], pubkeyBytes(authority.publicKey), [0]) }
  const mintTo = async (owner, amount) => {
    const dest = await T.ata(owner, USDC)
    return [
      createAssociatedTokenAccountIdempotent({ payer: authority.publicKey, ata: dest, owner, mint: USDC }),
      { programId: TOKEN_PROGRAM, keys: [{ pubkey: USDC, isSigner: false, isWritable: true }, { pubkey: dest, isSigner: false, isWritable: true }, { pubkey: authority.publicKey, isSigner: true, isWritable: false }], data: cat([7], u64le(amount)) },
    ]
  }
  await send(authority, { label: 'create the USDC stand-in mint, fund two depositors', instructions: [createMint, initMint, ...await mintTo(alice.publicKey, 1000_000000n), ...await mintTo(bob.publicKey, 1000_000000n)], extraSigners: [usdcMint] })

  const hash = await T.domainHash(DOMAIN)
  const solPool = await T.pda.pool(hash, 'SOL')
  const usdcPool = await T.pda.pool(hash, USDC)
  const aliceSol0 = await lamports(alice.publicKey)
  await send(alice, labelled('deposit 1.5 SOL (alice, opens the domain)', await T.depositIx({ payer: alice.publicKey, name: DOMAIN, amount: 1_500_000_000n })))
  await send(bob, labelled('deposit 2 SOL (bob)', await T.depositIx({ payer: bob.publicKey, name: DOMAIN, amount: 2n * SOL })))
  await send(alice, labelled('deposit 0.25 SOL (alice again)', await T.depositIx({ payer: alice.publicKey, name: DOMAIN, amount: 250_000_000n })))
  await send(alice, labelled('deposit 250 USDC (alice)', await T.depositIx({ payer: alice.publicKey, name: DOMAIN, mint: USDC, amount: 250_000000n })))
  await send(bob, labelled('deposit 100.5 USDC (bob)', await T.depositIx({ payer: bob.publicKey, name: DOMAIN, mint: USDC, amount: 100_500000n })))
  const rentOf = async a => BigInt(await rpc('getMinimumBalanceForRentExemption', [(await T.getAccounts([a]))[0].data.length]))
  const domainAddr = await T.pda.domain(hash)
  const aliceDep = await T.pda.deposit(solPool, alice.publicKey)
  const txFee = 5000n
  // Alice opened the domain, both pools, her two deposit records and the USDC* vault, in three transactions.
  const opened = [domainAddr, solPool, aliceDep, usdcPool, await T.pda.deposit(usdcPool, alice.publicKey), await T.ata(usdcPool, USDC)]
  let openedRent = 0n
  for (const a of opened) openedRent += await rentOf(a)
  check('alice paid 1.75 SOL + the rent of 6 accounts + 3 tx fees', aliceSol0 - await lamports(alice.publicKey), 1_750_000_000n + openedRent + 3n * txFee)
  let pools = await T.readPools(DOMAIN, [{ mint: USDC, symbol: 'USDC*', decimals: 6 }])
  const solBalance = pools.find(p => p.mint === 'SOL').balance
  const usdcBalance = pools.find(p => p.mint === USDC).balance
  check('SOL pool balance', solBalance, 3_750_000_000n)
  check('USDC* pool balance', usdcBalance, 350_500000n)
  check('SOL pool lamports = rent + balance', await lamports(solPool), await rentOf(solPool) + solBalance)
  check('USDC* vault holds the pool balance', await tokenBalance(await T.ata(usdcPool, USDC)), usdcBalance)
  check('alice SOL deposit record', (await T.readDeposit(DOMAIN, 'SOL', alice.publicKey)).amount, 1_750_000_000n)
  check('bob USDC* deposit record', (await T.readDeposit(DOMAIN, USDC, bob.publicKey)).amount, 100_500000n)

  // ---------- a real chain ----------
  say('\n3. Real DNSSEC chain: . DNSKEY -> com. DS -> com. DNSKEY -> cloudflare.com. DS -> cloudflare.com. DNSKEY')
  let steps
  if (!flags.has('--fixture')) {
    try { steps = await P.stepsFromSets(await quietly(() => P.fetchProof('DNSKEY', 'cloudflare.com'))); report.realChain = 'DNS-over-HTTPS, live' } catch (err) { say(`  DNS-over-HTTPS failed (${err.message}); using the bench fixture`) }
  }
  if (!steps) {
    const f = JSON.parse(readFileSync(`${ROOT}solana/bench/fixtures/cloudflare.com.json`, 'utf8'))
    steps = await P.stepsFromSets(f.sets.filter(s => !(s.owner === 'cloudflare.com.' && s.type === 'TXT')))
    report.realChain = `solana/bench/fixtures/cloudflare.com.json (fetched ${new Date(f.fetchedAt * 1000).toISOString()})`
  }
  say(`  source: ${report.realChain}; steps: ${steps.map(s => `${s.label} (alg ${s.algorithm}, ${s.signed.length} B)`).join(', ')}`)
  let now = await chainNow()
  const chainTxs = await T.proveStepsTxs({ payer: relayer.publicKey, steps, now })
  report.realChainPlan = chainTxs.plan.steps.map(s => `${s.label}: ${s.status}`)
  say(`  plan: ${report.realChainPlan.join('; ')}`)
  await send(relayer, chainTxs)
  const expiry = new Map()
  for (const s of steps) {
    const [acc] = await T.getAccounts([await T.pda.rrset(s.owner, s.rrtype)])
    const cached = P.decodeRrsetAccount(acc.data)
    const parentExpiry = s.parent ? expiry.get(`${P.toHex(s.parent.owner)}/${s.parent.rrtype}`) : Infinity
    const want = Math.min(P.validity(s, now).expiresAt, parentExpiry)
    assert.ok(cached.records.length === s.records.length && cached.records.every((x, i) => Buffer.from(x).equals(Buffer.from(s.records[i]))), `${s.label} records`)
    check(`${s.label} cached: signed_at = RRSIG inception`, cached.signedAt, P.validity(s, now).signedAt)
    check(`${s.label} cached: expires_at = earliest expiration on its path`, cached.expiresAt, want)
    expiry.set(`${P.toHex(s.owner)}/${s.rrtype}`, cached.expiresAt)
  }
  check('the same chain again: transactions needed', (await T.proveStepsTxs({ payer: relayer.publicKey, steps, now: await chainNow() })).length, 0)

  // ---------- the synthetic zone's wallet record ----------
  say(`\n4. Synthetic zone ${DOMAIN}: injected DNSKEY set (Ed25519), _wallet TXT publishing wallet A`)
  const injected = (await T.getAccounts([keySet.pubkey]))[0]
  check('injected DNSKEY set is owned by the program', injected.owner, PROGRAM_ID)
  now = await chainNow()
  const txtA = await zoneStep(zone, `_wallet.${DOMAIN}`, P.TYPE_TXT, [txt(`SOL ${walletA.publicKey}`)], now - 300)
  const proveA = await T.proveWalletTxs({ payer: relayer.publicKey, name: DOMAIN, steps: [txtA], now })
  check('wallet proof plan (parent cached): transactions', proveA.length, 1)
  check('wallet proof publishes', proveA.wallets.join(), walletA.publicKey)
  await send(relayer, proveA)
  const records = await T.readRecords(DOMAIN)
  check('cached record type', records[0].type, 'TXT')
  check('cached record signed_at', records[0].signedAt, now - 300)
  check('cached record address = proveWalletTxs().record', records[0].address, proveA.record)

  // ---------- claims ----------
  say('\n5. Claims to wallet A')
  const feeVaultSol = await T.pda.feeVault('SOL')
  const relayer0 = await lamports(relayer.publicKey)
  const solFee = T.feeOf(solBalance, 50)
  const [claimSig] = await send(relayer, labelled('claim SOL to wallet A (relayer pays)', await T.claimIx({ payer: relayer.publicKey, name: DOMAIN, wallet: walletA.publicKey })))
  check('fee = floor(3.75 SOL * 50 / 10000)', solFee, 18_750_000n)
  check('wallet A received balance - fee', await lamports(walletA.publicKey), solBalance - solFee)
  check('fee vault lamports = rent + fee', await lamports(feeVaultSol), await rentOf(feeVaultSol) + solFee)
  check('fee vault owed', await T.readFees('SOL'), solFee)
  check('SOL pool lamports back to its rent', await lamports(solPool), await rentOf(solPool))
  check('relayer paid the fee vault rent + tx fee', relayer0 - await lamports(relayer.publicKey), await rentOf(feeVaultSol) + txFee)
  const claimed = events(claimSig, 'Claimed')[0]
  check('Claimed event amount', claimed.readBigUInt64LE(8 + 96), solBalance - solFee)
  check('Claimed event fee', claimed.readBigUInt64LE(8 + 104), solFee)
  pools = await T.readPools(DOMAIN, [USDC])
  check('SOL pool after claim: balance', pools[0].balance, 0n)
  check('SOL pool after claim: epoch', pools[0].epoch, 1)
  let dom = await T.readDomain(DOMAIN)
  check('domain.lastProof = record signed_at', dom.lastProof, now - 300)
  check('domain.wallet', dom.wallet, walletA.publicKey)

  const usdcFee = T.feeOf(usdcBalance, 50)
  await send(relayer, labelled('claim USDC* to wallet A (creates its token account)', await T.claimIx({ payer: relayer.publicKey, name: DOMAIN, mint: USDC, wallet: walletA.publicKey })))
  check('USDC* fee = floor(350.5 * 50 / 10000)', usdcFee, 1_752500n)
  check('wallet A USDC* received', await tokenBalance(await T.ata(walletA.publicKey, USDC)), usdcBalance - usdcFee)
  check('fee vault USDC* account', await tokenBalance(await T.ata(await T.pda.feeVault(USDC), USDC)), usdcFee)
  check('USDC* vault empty', await tokenBalance(await T.ata(usdcPool, USDC)), 0n)

  // ---------- register a new wallet with a newer record ----------
  say('\n6. Wallet change: a newer _wallet TXT publishes wallet B; register it')
  now = await chainNow()
  const txtB = await zoneStep(zone, `_wallet.${DOMAIN}`, P.TYPE_TXT, [txt(`SOL ${walletB.publicKey}`)], now - 30)
  await send(relayer, await T.proveWalletTxs({ payer: relayer.publicKey, name: DOMAIN, steps: [txtB], now }))
  await send(relayer, labelled('register wallet B', await T.registerIx({ payer: relayer.publicKey, name: DOMAIN, wallet: walletB.publicKey })))
  dom = await T.readDomain(DOMAIN)
  check('domain.wallet after register', dom.wallet, walletB.publicKey)
  check('domain.lastProof after register', dom.lastProof, now - 30)
  const lastProof = dom.lastProof

  // ---------- an older proof ----------
  say('\n7. An older WALLET record publishing wallet A')
  const walletRec = await zoneStep(zone, DOMAIN, P.TYPE_WALLET, [cat(txt('SOL'), txt(walletA.publicKey))], lastProof - 3600)
  await assert.rejects(T.proveWalletTxs({ payer: relayer.publicKey, name: DOMAIN, steps: [walletRec], now: await chainNow() }), err => err.code === 'StaleProof')
  say('  ok   the client refuses to prove it (StaleProof before anything is sent)')
  await send(relayer, await T.proveStepsTxs({ payer: relayer.publicKey, steps: [walletRec], now: await chainNow() }))
  const recs = await T.readRecords(DOMAIN)
  check('cached records (newest first)', recs.map(x => `${x.type}:${x.wallets.join()}`).join(' '), `TXT:${walletB.publicKey} WALLET:${walletA.publicKey}`)
  const walletRecord = recs.find(x => x.type === 'WALLET')
  await refused(relayer, labelled('claim SOL to wallet A with the older WALLET record', await T.claimIx({ payer: relayer.publicKey, name: DOMAIN, wallet: walletA.publicKey, record: walletRecord.address })), 'StaleProof')
  await refused(relayer, labelled('register wallet A with the older WALLET record', await T.registerIx({ payer: relayer.publicKey, name: DOMAIN, wallet: walletA.publicKey, record: walletRecord.address })), 'StaleProof')
  check('domain.lastProof unchanged', (await T.readDomain(DOMAIN)).lastProof, lastProof)

  // ---------- a tie on signing time ----------
  say('\n7b. A WALLET record publishing wallet A, signed at the same time as the last proof (wallet B)')
  const tied = await zoneStep(zone, DOMAIN, P.TYPE_WALLET, [cat(txt('SOL'), txt(walletA.publicKey))], lastProof)
  await assert.rejects(T.proveWalletTxs({ payer: relayer.publicKey, name: DOMAIN, steps: [tied], now: await chainNow() }), err => err.code === 'TiedProof')
  say('  ok   the client refuses to prove it (TiedProof before anything is sent)')
  await send(relayer, await T.proveStepsTxs({ payer: relayer.publicKey, steps: [tied], now: await chainNow(), minLeafSignedAt: lastProof }))
  check('cached WALLET record signed_at = the last proof', (await T.readRecords(DOMAIN)).find(x => x.type === 'WALLET').signedAt, lastProof)
  await refused(relayer, labelled('claim SOL to wallet A with the tied WALLET record', await T.claimIx({ payer: relayer.publicKey, name: DOMAIN, wallet: walletA.publicKey, record: walletRecord.address })), 'TiedProof')
  await refused(relayer, labelled('register wallet A with the tied WALLET record', await T.registerIx({ payer: relayer.publicKey, name: DOMAIN, wallet: walletA.publicKey, record: walletRecord.address })), 'TiedProof')
  check('domain.wallet still wallet B', (await T.readDomain(DOMAIN)).wallet, walletB.publicKey)

  // ---------- wallets no key signs for ----------
  say('\n7c. The USDC* mint and a USDC* token account as the wallet')
  const aliceUsdc = await T.ata(alice.publicKey, USDC)
  for (const bad of [USDC, aliceUsdc]) {
    await assert.rejects(T.claimIx({ payer: relayer.publicKey, name: DOMAIN, mint: USDC, wallet: bad, record: walletRecord.address }), err => err.code === 'BadRecipient')
    await assert.rejects(T.registerIx({ payer: relayer.publicKey, name: DOMAIN, wallet: bad, record: walletRecord.address }), err => err.code === 'BadRecipient')
  }
  say('  ok   the client refuses to build a claim or register to either (BadRecipient)')
  // The program refuses it too: a newer WALLET record publishing the mint, and a register built by hand.
  const mintRecord = await zoneStep(zone, DOMAIN, P.TYPE_WALLET, [cat(txt('SOL'), txt(USDC))], lastProof + 1)
  await send(relayer, await T.proveStepsTxs({ payer: relayer.publicKey, steps: [mintRecord], now: await chainNow() }))
  const registerMint = {
    programId: PROGRAM_ID,
    keys: [
      { pubkey: relayer.publicKey, isSigner: true, isWritable: true }, { pubkey: domainAddr, isSigner: false, isWritable: true },
      { pubkey: walletRecord.address, isSigner: false, isWritable: false }, { pubkey: USDC, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: cat(T.IX.register, u32le(DOMAIN.length), Buffer.from(DOMAIN), hash, pubkeyBytes(USDC)),
  }
  await refused(relayer, { label: 'register the USDC* mint as the wallet (built by hand)', instructions: [registerMint] }, 'BadRecipient')
  dom = await T.readDomain(DOMAIN)
  check('domain after the refusals: wallet B, last proof unchanged', `${dom.wallet} ${dom.lastProof}`, `${walletB.publicKey} ${lastProof}`)

  // ---------- refunds before the delay ----------
  say('\n8. Refunds')
  await send(alice, labelled('deposit 0.1 SOL (alice, after the claim)', await T.depositIx({ payer: alice.publicKey, name: DOMAIN, amount: 100_000_000n })))
  await refused(alice, labelled('refund alice right away', await T.refundIx({ payer: alice.publicKey, name: DOMAIN })), 'RefundLocked')
  await refused(bob, labelled('refund bob (his deposit was claimed)', await T.refundIx({ payer: bob.publicKey, name: DOMAIN })), 'NothingToRefund')
  const aliceRefund = await T.readDeposit(DOMAIN, 'SOL', alice.publicKey)
  check('alice refundable amount', aliceRefund.amount, 100_000_000n)
  check('bob refundable amount after the claim', (await T.readDeposit(DOMAIN, 'SOL', bob.publicKey)).amount, 0n)

  // ---------- pause ----------
  say('\n9. Pause')
  await refused(alice, labelled('pause by a non-admin', await T.setDepositsPausedIx({ admin: alice.publicKey, paused: true })), 'NotAdmin')
  await send(authority, labelled('pause deposits (admin)', await T.setDepositsPausedIx({ admin: authority.publicKey, paused: true })))
  check('config.depositsPaused', (await T.readConfig()).depositsPaused, true)
  await refused(bob, labelled('deposit while paused', await T.depositIx({ payer: bob.publicKey, name: DOMAIN, amount: 100_000_000n })), 'Paused')
  await send(authority, labelled('resume deposits (admin)', await T.setDepositsPausedIx({ admin: authority.publicKey, paused: false })))
  check('config.depositsPaused', (await T.readConfig()).depositsPaused, false)

  // ---------- fees ----------
  say('\n10. withdraw_fees')
  await send(relayer, labelled('withdraw SOL fees (anyone)', await T.withdrawFeesIx({ payer: relayer.publicKey })))
  check('fee recipient SOL', await lamports(feeRecipient.publicKey), solFee)
  check('fee vault back to its rent', await lamports(feeVaultSol), await rentOf(feeVaultSol))
  check('SOL fees owed', await T.readFees('SOL'), 0n)
  await send(relayer, labelled('withdraw USDC* fees', await T.withdrawFeesIx({ payer: relayer.publicKey, mint: USDC })))
  check('fee recipient USDC*', await tokenBalance(await T.ata(feeRecipient.publicKey, USDC)), usdcFee)
  check('USDC* fees owed', await T.readFees(USDC), 0n)
  await refused(relayer, labelled('withdraw again with nothing owed', await T.withdrawFeesIx({ payer: relayer.publicKey })), 'ZeroAmount')

  // ---------- launch ----------
  say('\n11. pump.fun launch through the program')
  const slot = await rpc('getSlot', [{ commitment: 'finalized' }])
  const table = await T.lookupTableTx({ payer: launcher.publicKey, recentSlot: slot })
  const [tableSig] = await send(launcher, table)
  const tableSlot = (await rpc('getTransaction', [tableSig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }])).slot
  while ((await rpc('getSlot', [{ commitment: 'confirmed' }])) <= tableSlot) await pause(200) // entries are usable from the next slot
  T.configure({ lookupTables: [table.address] })
  check('lookup table entries', (await T.readLookupTable(table.address)).addresses.length, T.LAUNCH_LOOKUP_ADDRESSES.length)

  const BUY = 50_000_000n
  const launch = await T.launchTx({ payer: launcher.publicKey, name: DOMAIN, tokenName: 'Escrow E2E', symbol: 'E2E', uri: 'https://example.com/e2e.json', buyLamports: BUY, minTokens: 1n })
  const mint = launch.mint
  const fresh = await freshCurve()
  const launchCost = T.buyCost(fresh.curve, fresh.fees, launch.tokens)
  const launcher0 = await lamports(launcher.publicKey)
  const [launchSig] = await send(launcher, launch)
  const launchEntry = report.transactions.find(t => t.signature === launchSig)
  check('launch transaction version', launchEntry.version, 0)
  check('launch + buy fits a v0 transaction (bytes <= 1232)', launchEntry.size <= 1232, true)
  const creator = await T.pda.creator(hash)
  const curve1 = await readCurve(mint)
  check('curve creator = the domain creator PDA', curve1.creator, creator)
  check('launcher tokens = quoted', await tokenBalance(await T.ata(launcher.publicKey, mint, T.TOKEN_2022_PROGRAM)), launch.tokens)
  check('quoted cost fits the budget', launchCost <= BUY, true)
  const sol1 = (launch.tokens * fresh.curve.virtualSolReserves) / (fresh.curve.virtualTokenReserves - launch.tokens) + 1n
  check('curve real SOL = the buy before fees', curve1.realSolReserves, sol1)
  check('curve creator_fee = ceil(0.30% of the buy)', curve1.creatorFee, (sol1 * 30n + 9999n) / 10_000n)
  const launches = await T.readLaunches(DOMAIN)
  check('readLaunches', launches.map(l => `${l.mint}/${l.launcher}`).join(), `${mint}/${launcher.publicKey}`)
  check('domain.launches', (await T.readDomain(DOMAIN)).launches, 1)
  report.launch = { mint, tokens: launch.tokens, cost: launchCost, launcherSpent: launcher0 - await lamports(launcher.publicKey) }

  // ---------- a second trader ----------
  say('\n12. A second trader buys')
  const before2 = await readCurve(mint)
  const buy2 = await T.buyIxs({ payer: trader.publicKey, mint, buyLamports: 200_000_000n })
  await send(trader, labelled('trader buys for 0.2 SOL', buy2))
  const curve2 = await readCurve(mint)
  const sol2 = (buy2.tokens * before2.virtualSolReserves) / (before2.virtualTokenReserves - buy2.tokens) + 1n
  check('trader tokens = quoted', await tokenBalance(await T.ata(trader.publicKey, mint, T.TOKEN_2022_PROGRAM)), buy2.tokens)
  check('curve creator_fee after both buys', curve2.creatorFee, curve1.creatorFee + (sol2 * 30n + 9999n) / 10_000n)

  // ---------- collect ----------
  say('\n13. collect the creator fees into the domain pool')
  const poolBefore = (await T.readPools(DOMAIN))[0].balance
  const poolLamports0 = await lamports(solPool)
  const collect = await T.collectIx({ payer: relayer.publicKey, name: DOMAIN, mint })
  check('pending creator fees = curve creator_fee', collect.pending, curve2.creatorFee)
  const [collectSig] = await send(relayer, labelled('sweep + collect', collect))
  const poolAfter = (await T.readPools(DOMAIN))[0].balance
  check('pool balance rises by exactly the collected lamports', poolAfter - poolBefore, curve2.creatorFee)
  check('pool lamports rise by the same', await lamports(solPool) - poolLamports0, curve2.creatorFee)
  check('CreatorFeesCollected event amount', events(collectSig, 'CreatorFeesCollected')[0].readBigUInt64LE(40), curve2.creatorFee)
  check('curve creator_fee after the sweep', (await readCurve(mint)).creatorFee, 0n)
  check('creator PDA keeps its rent', await lamports(creator), BigInt(await rpc('getMinimumBalanceForRentExemption', [0])))
  await refused(relayer, labelled('collect again with nothing waiting', await T.collectIx({ payer: relayer.publicKey, name: DOMAIN, mint })), 'NothingToCollect')

  // ---------- refund after the delay ----------
  say('\n14. Refund after the delay')
  while ((await chainNow()) < aliceRefund.refundableAt) await pause(1000)
  const alice1 = await lamports(alice.publicKey)
  const depRent = await rentOf(aliceDep)
  await send(alice, labelled('refund alice 0.1 SOL', await T.refundIx({ payer: alice.publicKey, name: DOMAIN })))
  check('alice got 0.1 SOL + the deposit record rent - tx fee', await lamports(alice.publicKey) - alice1, 100_000_000n + depRent - txFee)
  check('pool keeps the creator fees (not refundable)', (await T.readPools(DOMAIN))[0].balance, curve2.creatorFee)

  // ---------- the creator fees reach the domain's wallet ----------
  say('\n15. Last claim: the creator fees to wallet B')
  const fees = curve2.creatorFee
  const fee3 = T.feeOf(fees, 50)
  const rent0 = BigInt(await rpc('getMinimumBalanceForRentExemption', [0]))
  const last = await T.claimIx({ payer: relayer.publicKey, name: DOMAIN, wallet: walletB.publicKey })
  check('payout under the rent minimum to an empty wallet: the claim funds its rent first', last.instructions.length, fees - fee3 < rent0 ? 2 : 1)
  await send(relayer, labelled('claim the collected fees to wallet B', last))
  check('wallet B', await lamports(walletB.publicKey), (fees - fee3 < rent0 ? rent0 : 0n) + fees - fee3)
  check('fees owed again', await T.readFees('SOL'), fee3)
}

/** pump's starting curve and the fees a fresh coin's first buy pays (what launchTx quoted against). */
async function freshCurve() {
  const [g, fc] = await T.getAccounts([T.PUMP.global, T.PUMP.feeConfig])
  const global = T.decodePumpGlobal(g.data)
  const curve = { virtualTokenReserves: global.initialVirtualTokenReserves, virtualSolReserves: global.initialVirtualSolReserves, realTokenReserves: global.initialRealTokenReserves, tokenTotalSupply: global.tokenTotalSupply }
  return { curve, fees: T.curveFees(T.decodeFeeConfig(fc.data), (curve.virtualSolReserves * curve.tokenTotalSupply) / curve.virtualTokenReserves) }
}

async function readCurve(mint) {
  const [a] = await T.getAccounts([await T.pumpPda.bondingCurve(mint)])
  return T.decodeBondingCurve(a.data)
}
