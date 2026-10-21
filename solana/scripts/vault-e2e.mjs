// End-to-end run of the Solana vault worker (upload/server.mjs, /solana/*) on a local solana-test-validator with
// the pump.fun fixtures, with a throwaway master secret and throwaway keys only. Nothing talks to mainnet or devnet:
// the worker's RPC (SOLANA_RPC_URL and SOLANA_PUBLIC_RPC_URLS) is the local validator, its DNS-over-HTTPS resolvers
// are two stub servers in this process, and the run stops if the cluster's genesis hash is a public cluster's.
//
// In order, with exact numbers at each step:
//   the worker's status and a domain's vault address (any spelling of the domain gives the same vault); a local
//   6-decimal USDC stand-in; SOL and USDC deposits to the vault from two senders; a pump.fun launch (create_v2 with
//   creator = the vault) with an opening buy, and a second trader; POST /solana/collect (sweep + collect in one
//   transaction); more trades, and a second coin that graduates (a buy completes its curve, migrate_v2, a PumpSwap
//   buy); POST /solana/collect again (sweeps first, then the collect; PumpSwap's WSOL unwrapped into the vault); a
//   refund refused before the delay; claims refused by DNS (no record, no DNSSEC, resolvers disagreeing, a mint
//   published as the wallet); a wrapped-SOL deposit; two claims at once (one runs, one is turned away) paying the SOL
//   wallet the stub publishes (the owner and the fee wallet get exact amounts, WSOL is unwrapped, the gas wallet pays
//   exactly the fees and rents it should, the vault ends empty, every payout carries the memo); an empty vault whose
//   pump.fun fees are below the rent minimum (left with pump.fun), then above it (a claim collects them itself, the
//   gas wallet lending the vault its rent and getting it back); then, with REFUND_DELAY_DAYS=0: a claimed deposit
//   refused, new SOL and USDC deposits refunded exactly once (a second attempt refused, also by a freshly started
//   worker that can only read the chain); and no secret in the worker's logs or answers.
//
// Run from the repository root (the validator runs in WSL on Windows, as for e2e-local.mjs):
//   node solana/scripts/vault-e2e.mjs                fresh validator on 127.0.0.1:28899, the run, then stops it
//   node solana/scripts/vault-e2e.mjs --port N       another RPC port (8899, 8999 and 18899 belong to other runs)
//   node solana/scripts/vault-e2e.mjs --keep         leaves the validator running afterwards
//   node solana/scripts/vault-e2e.mjs --restart      stops a validator already on that port first
//   node solana/scripts/vault-e2e.mjs --no-graduate  skips the second coin (faster)
// Needs the pump.fun fixtures (node solana/scripts/fetch-fixtures.mjs), solana/target/deploy/type262.so (the
// validator script loads it; the vaults don't use it) and solana-test-validator 2.x. Writes
// solana/target/vault-e2e/report.json.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as edSign } from 'node:crypto'
import http from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as X from '../../upload/pump.mjs'
import { compile, createAccount, makeRpc, setComputeUnitLimit, signTransaction, systemTransfer, transferChecked } from '../../upload/chain.mjs'
import { isUp, prepareAccounts, startValidator, stopValidator, usePort } from './e2e-validator.mjs'
import * as V from './e2e-validator.mjs'

const args = process.argv.slice(2)
const flag = f => args.includes(f)
const PORT = args.includes('--port') ? Number(args[args.indexOf('--port') + 1]) : 28899
usePort(PORT)
const RPC = V.RPC_URL
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const WORK = fileURLToPath(new URL('../target/vault-e2e/', import.meta.url))
const DOMAIN = 'vault-e2e.test'
const ORIGIN = 'https://type262.onrender.com'
const SOL = 1_000_000_000n
const PUBLIC_GENESIS = {
  '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d': 'mainnet-beta',
  'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG': 'devnet',
  '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY': 'testnet',
}
const say = s => process.stdout.write(`${s}\n`)
const pause = ms => new Promise(r => setTimeout(r, ms))
const report = { cluster: RPC, domain: DOMAIN, startedAt: new Date().toISOString(), transactions: [], checks: [] }

// ---------- keys and chain access ----------

function keypair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return { address: X.b58encode(Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url')), sign: m => new Uint8Array(edSign(null, Buffer.from(m), privateKey)) }
}

const rpc = makeRpc([RPC], { log: () => {} })
const lamports = async a => BigInt((await rpc('getBalance', [a, { commitment: 'confirmed' }])).value)
const accountOf = async a => (await rpc('getAccountInfo', [a, { encoding: 'base64', commitment: 'confirmed' }])).value
const tokenBalance = async a => { const v = await accountOf(a); return v ? Buffer.from(v.data[0], 'base64').readBigUInt64LE(64) : 0n }
const getTx = sig => rpc('getTransaction', [sig, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }])

async function confirmed(sig) {
  for (let i = 0; i < 120; i++) {
    const { value: [s] } = await rpc('getSignatureStatuses', [[sig]])
    if (s && s.err) throw new Error(`${sig} failed: ${JSON.stringify(s.err)}`)
    if (s && ['confirmed', 'finalized'].includes(s.confirmationStatus)) return s
    await pause(250)
  }
  throw new Error(`${sig} did not confirm`)
}

/** Signs and sends instructions from `payer` (plus `extra` signers), waits for confirmation, records it. */
async function send(payer, instructions, label, extra = []) {
  const { value: { blockhash } } = await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])
  const built = compile({ payer: payer.address, blockhash, instructions })
  const tx = signTransaction(built, [payer, ...extra])
  let sig
  try {
    sig = await rpc('sendTransaction', [Buffer.from(tx).toString('base64'), { encoding: 'base64', preflightCommitment: 'confirmed' }])
  } catch (err) {
    if (err.data && err.data.logs) say(err.data.logs.join('\n'))
    throw new Error(`${label}: ${err.message}`)
  }
  await confirmed(sig)
  const t = await getTx(sig)
  report.transactions.push({ label, signature: sig, size: tx.length, fee: t.meta.fee, computeUnits: t.meta.computeUnitsConsumed })
  say(`  ok   ${label.padEnd(60)} ${sig.slice(0, 20)}... ${String(tx.length).padStart(4)} B ${String(t.meta.computeUnitsConsumed).padStart(7)} CU`)
  return sig
}

async function airdrop(address, sol) {
  const sig = await rpc('requestAirdrop', [address, Number(BigInt(sol) * SOL), { commitment: 'confirmed' }])
  await confirmed(sig)
}

function check(name, actual, expected) {
  assert.deepEqual(actual, expected, name)
  const show = v => (typeof v === 'bigint' ? v.toString() : typeof v === 'object' ? JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() : x)) : v)
  report.checks.push({ name, value: show(actual) })
  say(`  =    ${name}: ${show(actual)}`)
}

// ---------- DNS-over-HTTPS stubs: "cloudflare" and "google" ----------

// name|type -> per-resolver answer { data, ad }. Unknown names answer NXDOMAIN; signed zones answer NOERROR with AD.
const dns = new Map()
const signedZones = new Set()
function publish(domain, text, { ad = [true, true], texts } = {}) {
  signedZones.add(domain)
  dns.set(`_wallet.${domain}|16`, [0, 1].map(i => ({ data: (texts || [text, text])[i], ad: ad[i] })))
}
const dohServer = index => http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  const name = String(u.searchParams.get('name') || '').toLowerCase().replace(/\.$/, '')
  const type = Number(u.searchParams.get('type'))
  const hit = dns.get(`${name}|${type}`)
  const zone = [...signedZones].find(z => name === z || name.endsWith(`.${z}`))
  const answer = hit && hit[index]
  const body = {
    Status: hit || zone ? 0 : 3, TC: false, RD: true, RA: true, AD: answer ? answer.ad : !!zone, CD: false,
    Question: [{ name: `${name}.`, type }], ...(answer && answer.data ? { Answer: [{ name: `${name}.`, type, TTL: 300, data: `"${answer.data}"` }] } : {}),
  }
  res.writeHead(200, { 'content-type': 'application/dns-json' })
  res.end(JSON.stringify(body))
}).listen(0, '127.0.0.1')

// ---------- the worker ----------

let worker = null
let workerLogs = ''
let workerUrl = ''
const MASTER = randomBytes(32).toString('hex') // throwaway: this run only, never printed
const FEE_BPS = 50n

async function startWorker(extraEnv = {}) {
  if (worker) { worker.kill(); await new Promise(r => worker.once('exit', r)) }
  const port = 19000 + Math.floor(Math.random() * 900)
  const env = {
    ...process.env,
    PORT: String(port), PINATA_JWT: '', ALLOW_ORIGINS: ORIGIN,
    // Only the local validator: the keyed slot and the public list both point at it.
    SOLANA_RPC_URL: RPC, SOLANA_PUBLIC_RPC_URLS: RPC, ROBINHOOD_RPC_URL: '', PUBLIC_RPC_URL: 'http://127.0.0.1:9/',
    VAULT_MASTER_SEED: MASTER, SOLANA_FEE_WALLET: feeWallet.address, FEE_BPS: String(FEE_BPS), REFUND_DELAY_DAYS: '180',
    SOLANA_USDC_MINT: usdcMint.address, DOH_RESOLVERS: `http://127.0.0.1:${doh[0].address().port}/dns-query,http://127.0.0.1:${doh[1].address().port}/resolve`,
    VAULT_RATE_MAX: '1000', PRIORITY_FEE_MIN: '20000',
    ...extraEnv,
  }
  worker = spawn(process.execPath, [`${ROOT}upload/server.mjs`], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  worker.stdout.on('data', d => (workerLogs += d))
  worker.stderr.on('data', d => (workerLogs += d))
  for (let i = 0; i < 100 && !/type262 upload on/.test(workerLogs.split('\n').slice(-3).join('\n')); i++) await pause(100)
  workerUrl = `http://127.0.0.1:${port}`
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${workerUrl}/health`)).ok) break } catch {} await pause(100) }
}

async function api(path, body, { origin = ORIGIN } = {}) {
  const r = body === undefined
    ? await fetch(`${workerUrl}${path}`)
    : await fetch(`${workerUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body) })
  const text = await r.text()
  answers += text
  const json = JSON.parse(text)
  for (const s of [...(json.signatures || []), ...(json.signature ? [json.signature] : [])]) workerSigs.add(s)
  return { status: r.status, json }
}
let answers = '' // every API answer, checked for secrets at the end
const workerSigs = new Set()

// ---------- setup ----------

const feeWallet = keypair()
const owner = keypair()
const usdcMint = keypair()
const doh = [dohServer(0), dohServer(1)]
await Promise.all(doh.map(s => new Promise(r => s.once('listening', r))))
mkdirSync(WORK, { recursive: true })

if (await isUp()) {
  if (!flag('--restart')) throw new Error(`A validator already answers on ${RPC}. Stop it (node solana/scripts/e2e-validator.mjs stop --port ${PORT}), pass --restart, or use another --port.`)
  stopValidator()
}
say(`Starting solana-test-validator on ${RPC} (fresh ledger, pump.fun fixtures)...`)
await startValidator({ authority: keypair().address, accountsDir: prepareAccounts(`${WORK}accounts`) })
const genesis = await rpc('getGenesisHash')
if (PUBLIC_GENESIS[genesis]) throw new Error(`${RPC} is ${PUBLIC_GENESIS[genesis]}; this run only uses a local validator`)
report.genesisHash = genesis
report.validator = (await rpc('getVersion'))['solana-core']
say(`Local cluster ${genesis}, solana-core ${report.validator}`)

let failed = null
try {
  await run()
} catch (err) {
  failed = err
  say(`\nFAILED: ${err.stack || err.message}`)
  say(`\nworker log (last 40 lines):\n${workerLogs.split('\n').slice(-40).join('\n')}`)
} finally {
  if (worker) worker.kill()
  doh.forEach(s => s.close())
  report.finishedAt = new Date().toISOString()
  report.ok = !failed
  writeFileSync(`${WORK}report.json`, JSON.stringify(report, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 1))
  if (!flag('--keep')) stopValidator()
}
say(failed ? '\nVAULT E2E FAILED' : `\nVAULT E2E PASSED: ${report.transactions.length} transactions sent by the run, ${report.workerTransactions} by the worker, ${report.checks.length} checks. Report: solana/target/vault-e2e/report.json`)
process.exit(failed ? 1 : 0)

async function run() {
  const [alice, bob, minter, launcher, trader, whale, swapper] = Array.from({ length: 7 }, keypair)
  for (const [kp, n] of [[alice, 10], [bob, 10], [minter, 5], [launcher, 10], [trader, 10], [whale, 600], [swapper, 30]]) await airdrop(kp.address, n)
  report.keys = { alice: alice.address, bob: bob.address, owner: owner.address, feeWallet: feeWallet.address, usdcMint: usdcMint.address }

  // ---------- worker ----------
  say('\n1. The worker')
  await startWorker()
  check('worker starts with the vaults ready', /vaults: ready/.test(workerLogs), true)
  const status = (await api('/solana/status')).json
  check('status: fee wallet, fee, refund delay', [status.feeWallet, status.feeBps, status.refundDelayDays], [feeWallet.address, 50, 180])
  const gasWallet = status.gasWallet
  const gasExpected = X.b58encode(Buffer.from(gasPublicKey(MASTER)))
  check('status: gas wallet = Ed25519(HMAC(master, "type262:gas"))', gasWallet, gasExpected)
  await airdrop(gasWallet, 20)
  const v = (await api(`/solana/vault?domain=${DOMAIN}`)).json
  const vault = v.vault
  check('vault = Ed25519(HMAC(master, "type262:vault:" + domain))', vault, X.b58encode(Buffer.from(vaultPublicKey(MASTER, DOMAIN))))
  check('usdcAccount = ATA(vault, USDC)', v.usdcAccount, X.ata(vault, usdcMint.address, X.TOKEN))
  check('any spelling of the domain gives the same vault', (await api(`/solana/vault?domain=${encodeURIComponent('https://VAULT-E2E.test./x')}`)).json.vault, vault)
  check('a bad domain is refused (400)', (await api('/solana/vault?domain=not%20a%20domain')).status, 400)

  // ---------- USDC stand-in and deposits ----------
  say('\n2. A 6-decimal USDC stand-in, then deposits from alice and bob')
  const mintRent = BigInt(await rpc('getMinimumBalanceForRentExemption', [82]))
  const USDC = usdcMint.address
  const mintTo = (to, amount) => [
    X.createAtaIdempotent({ payer: minter.address, owner: to, mint: USDC }),
    { programId: X.TOKEN, keys: [X.meta(USDC, { w: true }), X.meta(X.ata(to, USDC), { w: true }), X.meta(minter.address, { s: true })], data: Buffer.concat([X.u8(7), X.u64(amount)]) },
  ]
  await send(minter, [
    createAccount({ from: minter.address, account: USDC, lamports: mintRent, space: 82, owner: X.TOKEN }),
    { programId: X.TOKEN, keys: [X.meta(USDC, { w: true })], data: Buffer.concat([X.u8(20), X.u8(6), X.pk(minter.address), X.u8(0)]) },
    ...mintTo(alice.address, 1000_000000n), ...mintTo(bob.address, 1000_000000n),
  ], 'create the USDC stand-in, mint to alice and bob', [usdcMint])
  const depositUsdc = (from, amount, label) => send(from, [
    X.createAtaIdempotent({ payer: from.address, owner: vault, mint: USDC }),
    transferChecked({ source: X.ata(from.address, USDC), mint: USDC, destination: X.ata(vault, USDC), owner: from.address, amount, decimals: 6 }),
  ], label)
  const aliceSol1 = await send(alice, [systemTransfer(alice.address, vault, 1_500_000_000n)], 'alice sends 1.5 SOL to the vault')
  await send(bob, [systemTransfer(bob.address, vault, 2n * SOL)], 'bob sends 2 SOL to the vault')
  await depositUsdc(bob, 250_000000n, 'bob sends 250 USDC (creates the vault\'s USDC account)')
  await depositUsdc(alice, 100_000000n, 'alice sends 100 USDC')
  check('vault lamports', await lamports(vault), 3_500_000_000n)
  check('vault USDC', await tokenBalance(v.usdcAccount), 350_000000n)

  // ---------- pump.fun ----------
  say('\n3. pump.fun: a coin with the vault as creator, an opening buy, a second trader')
  const global = X.readGlobal(Buffer.from((await accountOf(X.GLOBAL)).data[0], 'base64'))
  const buyback = global.buybackFeeRecipients[0]
  const coin1 = keypair()
  await send(launcher, [
    setComputeUnitLimit(400_000),
    X.createV2({ mint: coin1.address, user: launcher.address, creator: vault, name: 'Vault E2E', symbol: 'VLT', uri: 'https://example.com/vault-e2e.json' }),
    X.createAtaIdempotent({ payer: launcher.address, owner: launcher.address, mint: coin1.address, tokenProgram: X.TOKEN_2022 }),
    X.buyV3({ mint: coin1.address, user: launcher.address, amount: 10_000_000_000000n, maxSolCost: SOL, buyback }),
  ], 'launch: create_v2 (creator = vault) + opening buy of 10M', [coin1])
  const curve = async m => X.readBondingCurve(Buffer.from((await accountOf(X.bondingCurvePda(m))).data[0], 'base64'))
  const c1 = await curve(coin1.address)
  check('curve creator = the vault', c1.creator, vault)
  const buy = (who, mint, millions, label) => send(who, [
    setComputeUnitLimit(300_000),
    X.createAtaIdempotent({ payer: who.address, owner: who.address, mint, tokenProgram: X.TOKEN_2022 }),
    X.buyV3({ mint, user: who.address, amount: BigInt(millions) * 1_000_000_000000n, maxSolCost: 5n * SOL, buyback }),
  ], label)
  await buy(trader, coin1.address, 20, 'second trader buys 20M')
  const fee1 = (await curve(coin1.address)).creatorFee
  check("creator fees waiting on coin 1's curve > 0", fee1 > 0n, true)
  report.coin1 = { mint: coin1.address, creatorFee: fee1 }
  const byKey = list => [...list].sort((a, b) => `${a.source}${a.mint}`.localeCompare(`${b.source}${b.mint}`))

  say('\n4. POST /solana/collect with one coin: sweep and collect in one transaction')
  let vaultBefore = await lamports(vault)
  let col = await api('/solana/collect', { domain: DOMAIN })
  check("collect: coin 1's curve fees, in one transaction", [col.status, col.json.collected, col.json.signatures.length], [200, [{ mint: coin1.address, lamports: String(fee1), source: 'curve' }], 1])
  check('vault lamports rise by exactly the collected fees', await lamports(vault) - vaultBefore, fee1)
  check('coin 1 curve creator_fee after collect', (await curve(coin1.address)).creatorFee, 0n)
  check('collect again: nothing waiting', (await api('/solana/collect', { domain: DOMAIN })).json.collected, [])

  await buy(trader, coin1.address, 15, 'trader buys 15M more of coin 1')
  const fee1b = (await curve(coin1.address)).creatorFee
  let fee2 = 0n
  let poolFees = 0n
  let coin2 = null
  if (!flag('--no-graduate')) {
    say('\n5. A second coin graduates: a buy completes its curve, migrate_v2, then a PumpSwap buy')
    coin2 = keypair()
    await send(launcher, [
      setComputeUnitLimit(400_000),
      X.createV2({ mint: coin2.address, user: launcher.address, creator: vault, name: 'Vault Grad', symbol: 'VGR', uri: 'https://example.com/vault-grad.json' }),
    ], 'launch coin 2 (creator = vault)', [coin2])
    await send(whale, [
      setComputeUnitLimit(1_400_000),
      X.createAtaIdempotent({ payer: whale.address, owner: whale.address, mint: coin2.address, tokenProgram: X.TOKEN_2022 }),
      X.buyV3({ mint: coin2.address, user: whale.address, amount: 900_000_000_000000n, maxSolCost: 400n * SOL, buyback }),
    ], 'a whale buy completes the curve')
    const c2 = await curve(coin2.address)
    check('coin 2 curve complete', c2.complete, true)
    fee2 = c2.creatorFee
    await send(whale, [setComputeUnitLimit(1_400_000), X.migrateV2({ user: whale.address, mint: coin2.address, withdrawAuthority: global.withdrawAuthority })], 'migrate_v2 (anyone)')
    const poolAddr = X.canonicalPoolPda(coin2.address)
    const readPoolNow = async () => X.readPool(Buffer.from((await accountOf(poolAddr)).data[0], 'base64'))
    check('pool coin_creator = the vault', (await readPoolNow()).coinCreator, vault)
    const wsolAta = X.ata(swapper.address, X.WSOL)
    await send(swapper, [
      setComputeUnitLimit(400_000),
      X.createAtaIdempotent({ payer: swapper.address, owner: swapper.address, mint: X.WSOL }),
      systemTransfer(swapper.address, wsolAta, 10n * SOL),
      X.syncNative({ account: wsolAta }),
      X.createAtaIdempotent({ payer: swapper.address, owner: swapper.address, mint: coin2.address, tokenProgram: X.TOKEN_2022 }),
      X.ammBuyV2({ pool: poolAddr, user: swapper.address, mint: coin2.address, baseAmountOut: 1_000_000_000000n, maxQuoteIn: 10n * SOL, buybackWallet: buyback }),
    ], 'a PumpSwap buy on the graduated pool')
    poolFees = (await readPoolNow()).creatorFees
    check('PumpSwap creator fees waiting in the pool > 0', poolFees > 0n, true)
    report.coin2 = { mint: coin2.address, curveCreatorFee: fee2, poolCreatorFees: poolFees }
  }

  say('\n6. POST /solana/collect with every kind of fee: the sweeps first, then the collect (PumpSwap pays WSOL, unwrapped)')
  vaultBefore = await lamports(vault)
  col = await api('/solana/collect', { domain: DOMAIN })
  const want = [{ mint: coin1.address, lamports: String(fee1b), source: 'curve' }]
  if (coin2) want.push({ mint: coin2.address, lamports: String(fee2), source: 'curve' }, { mint: coin2.address, lamports: String(poolFees), source: 'pool' })
  check("collected: every coin's creator fees (getProgramAccounts order varies)", [col.status, byKey(col.json.collected)], [200, byKey(want)])
  check('vault lamports rise by exactly the collected fees', await lamports(vault) - vaultBefore, fee1b + fee2 + poolFees)
  check('coin 1 curve creator_fee after collect', (await curve(coin1.address)).creatorFee, 0n)
  if (coin2) {
    check('coin 2 pool creator_fees after collect', X.readPool(Buffer.from((await accountOf(X.canonicalPoolPda(coin2.address))).data[0], 'base64')).creatorFees, 0n)
    check('the vault owns no WSOL account afterwards (unwrapped in the same transaction)', (await rpc('getTokenAccountsByOwner', [vault, { mint: X.WSOL }, { encoding: 'jsonParsed', commitment: 'confirmed' }])).value.length, 0)
  }

  // ---------- refund before the delay ----------
  say('\n7. A refund before the delay')
  const early = await api('/solana/refund', { domain: DOMAIN, signature: aliceSol1 })
  check('refund of alice\'s deposit right away', [early.status, early.json.error], [422, 'Too early'])

  // ---------- DNS refusals ----------
  say('\n8. Claims DNS must refuse')
  const refused = async (domain, error) => { const r = await api('/solana/claim', { domain }); check(`claim ${domain}: ${r.json.reason}`, [r.status, r.json.error], [422, error]) }
  await refused('nodns-e2e.test', 'No SOL wallet in DNS')
  publish('unsigned-e2e.test', `SOL ${owner.address}`, { ad: [true, false] })
  await refused('unsigned-e2e.test', 'DNS check failed')
  publish('split-e2e.test', null, { texts: [`SOL ${owner.address}`, `SOL ${feeWallet.address}`] })
  await refused('split-e2e.test', 'DNS check failed')
  publish('mint-e2e.test', `SOL ${USDC}`)
  await refused('mint-e2e.test', 'Bad SOL record')
  const noOrigin = await api('/solana/claim', { domain: DOMAIN }, { origin: '' })
  check('a claim without an allowed origin is refused', noOrigin.status, 403)

  // ---------- claim ----------
  say(`\n9. POST /solana/claim: ${DOMAIN} publishes "SOL ${owner.address}" (DNSSEC-validated by both resolvers)`)
  publish(DOMAIN, `SOL ${owner.address}`)
  // Wrapped SOL in the vault is paid out as SOL: the claim unwraps it.
  const bobWsol = X.ata(bob.address, X.WSOL)
  await send(bob, [
    X.createAtaIdempotent({ payer: bob.address, owner: bob.address, mint: X.WSOL }),
    systemTransfer(bob.address, bobWsol, SOL), X.syncNative({ account: bobWsol }),
    X.createAtaIdempotent({ payer: bob.address, owner: vault, mint: X.WSOL }),
    transferChecked({ source: bobWsol, mint: X.WSOL, destination: X.ata(vault, X.WSOL), owner: bob.address, amount: SOL, decimals: 9 }),
  ], 'bob sends 1 wrapped SOL to the vault')
  const L = await lamports(vault) + await tokenBalance(X.ata(vault, X.WSOL))
  const usdcIn = await tokenBalance(v.usdcAccount)
  const gas0 = await lamports(gasWallet)
  const rent165 = BigInt(await rpc('getMinimumBalanceForRentExemption', [165]))
  // Two claims at once: the per-domain lock lets one run and turns the other away.
  const both = await Promise.all([api('/solana/claim', { domain: DOMAIN }), api('/solana/claim', { domain: DOMAIN })])
  const cl = both.find(r => r.status === 200) || both[0]
  if (cl.status !== 200) say(JSON.stringify(cl.json))
  check('two claims at once: one runs, the other is turned away', both.map(r => [r.status, r.status === 200 ? 'ok' : r.json.error]).sort(), [[200, 'ok'], [409, 'Busy']])
  const solFee = L * FEE_BPS / 10_000n
  const usdcFee = usdcIn * FEE_BPS / 10_000n
  check('claim pays the published wallet', cl.json.wallet, owner.address)
  check('payouts', cl.json.payouts.map(p => [p.mint, p.amount, p.fee]), [[USDC, String(usdcIn - usdcFee), String(usdcFee)], ['SOL', String(L - solFee), String(solFee)]])
  check(`SOL: payout + fee = all ${L} lamports the vault held, fee = floor(0.5%)`, [BigInt(cl.json.payouts[1].amount) + BigInt(cl.json.payouts[1].fee), BigInt(cl.json.payouts[1].fee)], [L, (L * 50n) / 10_000n])
  check('owner received vault SOL - fee', await lamports(owner.address), L - solFee)
  check('fee wallet received the SOL fee', await lamports(feeWallet.address), solFee)
  check('owner received USDC - fee', await tokenBalance(X.ata(owner.address, USDC)), usdcIn - usdcFee)
  check('fee wallet received the USDC fee (350 * 0.5% = 1.75)', await tokenBalance(X.ata(feeWallet.address, USDC)), 1_750000n)
  check('vault lamports after the claim', await lamports(vault), 0n)
  check('vault token accounts after the claim (closed)', (await rpc('getTokenAccountsByOwner', [vault, { programId: X.TOKEN }, { encoding: 'jsonParsed' }])).value.length, 0)
  let txFees = 0n
  for (const sig of cl.json.signatures) {
    const t = await getTx(sig)
    txFees += BigInt(t.meta.fee)
    const memos = t.transaction.message.instructions.filter(ix => ix.program === 'spl-memo').map(ix => ix.parsed)
    const signers = t.transaction.message.accountKeys.filter(k => k.signer).map(k => k.pubkey)
    check(`payout ${sig.slice(0, 12)}...: memo, signed by the gas wallet and the vault`, [memos, signers.sort()], [[`type262:claim:${DOMAIN}`], [gasWallet, vault].sort()])
  }
  check('the vault\'s WSOL account is gone (unwrapped into the payout)', await accountOf(X.ata(vault, X.WSOL)), null)
  check('gas wallet paid exactly: tx fees + 2 token accounts (owner, fee wallet) - the closed USDC and WSOL accounts', gas0 - await lamports(gasWallet), txFees + 2n * rent165 - 2n * rent165)
  // What a refund reads: the memo field of the vault's history, without fetching each transaction.
  const history = await rpc('getSignaturesForAddress', [vault, { limit: 20, commitment: 'confirmed' }])
  const memoOf = s => (history.find(h => h.signature === s) || {}).memo
  if (!cl.json.signatures.every(s => memoOf(s))) say(JSON.stringify(history.slice(0, 6)))
  check('vault history (getSignaturesForAddress) shows the claim memo on every payout', cl.json.signatures.map(s => String(memoOf(s)).replace(/^\[\d+\] /, '')), cl.json.signatures.map(() => `type262:claim:${DOMAIN}`))
  report.claim = { vaultLamports: L, solFee, usdc: usdcIn, usdcFee, transactions: cl.json.signatures.length, txFees }
  const again = await api('/solana/claim', { domain: DOMAIN })
  check('claim again: nothing to claim', [again.status, again.json.error], [409, 'Nothing to claim'])

  // ---------- an empty vault and small fees ----------
  say('\n10. An empty vault: fees below the rent minimum wait with pump.fun; once above it, a claim collects them itself')
  const rent0 = BigInt(await rpc('getMinimumBalanceForRentExemption', [0]))
  await buy(trader, coin1.address, 4, 'trader buys 4M of coin 1 (a small fee)')
  const small = (await curve(coin1.address)).creatorFee
  check('the fee is below the rent minimum of an empty vault', small < rent0, true)
  const dust = await api('/solana/collect', { domain: DOMAIN })
  check('collect leaves it with pump.fun and says how much waits', [dust.status, dust.json.collected, dust.json.pending, dust.json.signatures.length], [200, [], String(small), 0])
  check('the curve still holds it', (await curve(coin1.address)).creatorFee, small)
  await buy(trader, coin1.address, 12, 'trader buys 12M more of coin 1')
  const enough = (await curve(coin1.address)).creatorFee
  check('now above the rent minimum', enough >= rent0, true)
  const owner0 = await lamports(owner.address)
  const gas1 = await lamports(gasWallet)
  const cl2 = await api('/solana/claim', { domain: DOMAIN })
  check('the claim collected them first', [cl2.status, cl2.json.collected], [200, [{ mint: coin1.address, lamports: String(enough), source: 'curve' }]])
  const fee3 = enough * FEE_BPS / 10_000n
  check('and paid them out', cl2.json.payouts.map(p => [p.mint, p.amount, p.fee]), [['SOL', String(enough - fee3), String(fee3)]])
  check('owner received fees - 0.5%', await lamports(owner.address) - owner0, enough - fee3)
  check('vault empty again', await lamports(vault), 0n)
  let fees2 = 0n
  for (const sig of cl2.json.signatures) fees2 += BigInt((await getTx(sig)).meta.fee)
  check('the gas wallet lent the empty vault its rent for the collect and got it back: it paid only tx fees', gas1 - await lamports(gasWallet), fees2)

  // ---------- refunds with REFUND_DELAY_DAYS=0 ----------
  say('\n11. Refunds (worker restarted with REFUND_DELAY_DAYS=0)')
  await startWorker({ REFUND_DELAY_DAYS: '0' })
  const claimedDeposit = await api('/solana/refund', { domain: DOMAIN, signature: aliceSol1 })
  check('refund of a deposit made before the claim', [claimedDeposit.status, claimedDeposit.json.error], [422, 'Already claimed'])
  const notDeposit = await api('/solana/refund', { domain: DOMAIN, signature: cl.json.signatures[0] })
  check('refund of the claim transaction itself', [notDeposit.status, notDeposit.json.error], [422, 'Not a deposit'])
  check('refund with a malformed signature', (await api('/solana/refund', { domain: DOMAIN, signature: 'nope' })).status, 400)

  const alice3 = await send(alice, [systemTransfer(alice.address, vault, 300_000_000n)], 'alice sends 0.3 SOL after the claim')
  const aliceBefore = await lamports(alice.address)
  const r1 = await api('/solana/refund', { domain: DOMAIN, signature: alice3 })
  check('refund of alice\'s 0.3 SOL', [r1.status, r1.json.refunded], [200, { mint: 'SOL', amount: '300000000', decimals: 9, to: alice.address }])
  check('alice got exactly 0.3 SOL back (the gas wallet pays the fee)', await lamports(alice.address) - aliceBefore, 300_000_000n)
  check('vault lamports after the refund', await lamports(vault), 0n)
  const rt = await getTx(r1.json.signature)
  check('refund memo', rt.transaction.message.instructions.filter(ix => ix.program === 'spl-memo').map(ix => ix.parsed), [`type262:refund:${alice3}`])
  const r2 = await api('/solana/refund', { domain: DOMAIN, signature: alice3 })
  check('the same refund again', [r2.status, r2.json.error], [422, 'Already refunded'])

  const bob3 = await depositUsdc(bob, 10_000000n, 'bob sends 10 USDC after the claim')
  const bobBefore = await tokenBalance(X.ata(bob.address, USDC))
  const gasBefore = await lamports(gasWallet)
  const r3 = await api('/solana/refund', { domain: DOMAIN, signature: bob3 })
  check('refund of bob\'s 10 USDC', [r3.status, r3.json.refunded], [200, { mint: USDC, amount: '10000000', decimals: 6, to: bob.address }])
  check('bob got exactly 10 USDC back', await tokenBalance(X.ata(bob.address, USDC)) - bobBefore, 10_000000n)
  check('the emptied vault USDC account is closed', await accountOf(v.usdcAccount), null)
  const r3fee = BigInt((await getTx(r3.json.signature)).meta.fee)
  check('gas wallet: pays the tx fee, gets the closed account\'s rent (bob paid it)', await lamports(gasWallet) - gasBefore, rent165 - r3fee)

  // A fresh worker has no memory: only the chain says these were refunded.
  await startWorker({ REFUND_DELAY_DAYS: '0' })
  for (const [sig, who] of [[alice3, 'alice'], [bob3, 'bob']]) {
    const r = await api('/solana/refund', { domain: DOMAIN, signature: sig })
    check(`${who}'s refund again, asked of a freshly started worker`, [r.status, r.json.error], [422, 'Already refunded'])
  }

  // ---------- nothing secret came out ----------
  say('\n12. Secrets')
  const seedHex = createHmac('sha256', Buffer.from(MASTER, 'hex')).update(`type262:vault:${DOMAIN}`).digest('hex')
  const gasSeedHex = createHmac('sha256', Buffer.from(MASTER, 'hex')).update('type262:gas').digest('hex')
  const leaks = [MASTER, seedHex, gasSeedHex, Buffer.from(seedHex, 'hex').toString('base64'), Buffer.from(seedHex, 'hex').toString('base64url')]
  check('worker logs hold no master secret or derived seed', leaks.some(s => workerLogs.toLowerCase().includes(s.toLowerCase())), false)
  check('no answer held one either', leaks.some(s => answers.toLowerCase().includes(s.toLowerCase())), false)
  report.workerTransactions = workerSigs.size
}

// Expected addresses, computed here apart from upload/vault.mjs (raw seed -> public key via node:crypto).
function edPublicKey(seed) {
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' })
  return Buffer.from(createPublicKey(key).export({ format: 'jwk' }).x, 'base64url')
}
function vaultPublicKey(master, domain) { return edPublicKey(createHmac('sha256', Buffer.from(master, 'hex')).update(`type262:vault:${domain}`).digest()) }
function gasPublicKey(master) { return edPublicKey(createHmac('sha256', Buffer.from(master, 'hex')).update('type262:gas').digest()) }
