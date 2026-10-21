// UI end-to-end run: the app's Solana screens (Pay, Escrow, Launch on pump.fun) driven in headless Chromium like a
// user would, against a local solana-test-validator, with throwaway keypairs only. Nothing talks to mainnet or devnet:
// the page's Solana RPC goes to the local validator (the run stops if its genesis hash is a public cluster's) and
// any other Solana RPC host is refused in the page and at the browser's network layer.
//
// Setup, as e2e-local.mjs does (same program, same pump.fun fixtures, see its header):
//   genesis accounts: the pump.fun fixtures; a 6-decimal USDC stand-in at USDC's mint address, so the app's own
//   USDC constant points at it, with a throwaway mint authority; and the cached DNSSEC sets above the synthetic
//   zone's `_wallet` record (ui-e2e-dns.mjs). Then initialize, fund the user's wallet with SOL and USDC, and create
//   the launch lookup table.
// The page gets a Wallet Standard wallet signing with the user's throwaway key, fetch overrides (local RPC, DNS
// answers, the upload service) and the lookup table (ui-e2e-browser.mjs). Then, through clicks and typing:
//   1. Pay: SOL to pay-ui.test, whose `_wallet` record (stubbed DoH, DNSSEC-validated) names the user's second wallet;
//   2. Escrow: deposit SOL and USDC to escrow-ui.test, see the pools;
//   3. Escrow: Claim, which proves the zone's signed `_wallet` TXT on-chain and claims both pools;
//   4. Launch: upload an image, fill the form, launch a coin with an opening buy (v0 over the lookup table);
//   5. a second trader buys (from this script), then Coins and fees: Collect to escrow;
//   6. Escrow: claim the collected creator fees (the proof is cached now).
// Every step is checked on-chain over RPC, and each final state is captured at 1440 and 375 px wide.
//
// Run from the repository root (on Windows the validator runs in WSL, like e2e-local.mjs):
//   node solana/scripts/ui-e2e.mjs                 fresh validator on 127.0.0.1:8999, the run, then stops it
//   node solana/scripts/ui-e2e.mjs --keep          leaves the validator running afterwards
//   node solana/scripts/ui-e2e.mjs --rpc-port N    another RPC port (8899 is e2e-local.mjs's; both can run at once)
// Writes solana/target/ui-e2e/report.json and the screenshots next to it. BROWSER= picks the Chromium to drive.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { generateKeyPairSync, sign as edSign } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'
import * as T from '../../assets/solana-type262.js'
import { TOKEN_PROGRAM, USDC, base58Encode, createAssociatedTokenAccountIdempotent, pubkeyBytes } from '../../assets/solana.js'
import { PROGRAM_ID, PUMP_PROGRAMS, prepareAccounts } from './e2e-validator.mjs'
import { dohStub, dohTable, parentChain, walletSet } from './ui-e2e-dns.mjs'
import { RPC_PATH, launchBrowser, pageScript, portFree, serve } from './ui-e2e-browser.mjs'

const args = process.argv.slice(2)
const flag = f => args.includes(f)
const option = (f, d) => (args.includes(f) ? args[args.indexOf(f) + 1] : d)
const SOLANA_DIR = fileURLToPath(new URL('..', import.meta.url))
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const WORK = `${SOLANA_DIR}target/ui-e2e/`
const DOMAIN = 'escrow-ui.test'
const PAY_DOMAIN = 'pay-ui.test'
const SOL = 1_000_000_000n
const RPC_PORT = Number(option('--rpc-port', 8999))
const RPC_URL = `http://127.0.0.1:${RPC_PORT}`
const PUBLIC_GENESIS = {
  '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d': 'mainnet-beta',
  'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG': 'devnet',
  '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY': 'testnet',
}
// What the page's fetch override answers for the upload service (solana-launch.js UPLOAD_URL).
const UPLOAD = 'https://type262-upload.onrender.com'
const IMAGE_URI = 'ipfs://QmUiE2eCoinImageTestOnlyLocalValidatorRun000000'
const METADATA_URI = 'https://ipfs.io/ipfs/QmUiE2eCoinMetadataTestOnlyLocalValidatorRun0'
assert.equal(T.PROGRAM_ID, PROGRAM_ID, 'config.js names another program; the local run uses the test id')

// ---------- the validator (its own ledger and ports, so e2e-local.mjs can run beside it) ----------

const WINDOWS = process.platform === 'win32'
const LEDGER = '/tmp/type262-ui-e2e-ledger'
const LOG = '/tmp/type262-ui-e2e-validator.log'
const PATH_SETUP = 'export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.local/share/solana/stable/bin:$PATH"'
const shell = cmd => {
  const out = WINDOWS ? spawnSync('wsl.exe', ['-e', 'bash', '-lc', cmd], { encoding: 'utf8' }) : spawnSync('bash', ['-lc', cmd], { encoding: 'utf8' })
  return { ok: out.status === 0, out: `${out.stdout || ''}${out.stderr || ''}`.trim() }
}
const hostPath = file => {
  if (!WINDOWS) return file
  const out = spawnSync('wsl.exe', ['-e', 'wslpath', '-u', file.replace(/\//g, '\\')], { encoding: 'utf8' })
  if (out.status !== 0) throw new Error(`wslpath failed: ${out.stderr || out.error}`)
  return out.stdout.trim()
}
// The [t] keeps pkill from matching the shell that runs it; only this run's validator has this ledger path.
const stopValidator = () => shell("pkill -INT -f '[t]ype262-ui-e2e-ledger'; sleep 2; pkill -KILL -f '[t]ype262-ui-e2e-ledger'; true")

async function rpc(method, params = []) {
  const res = await fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(10_000) })
  const j = await res.json()
  if (j.error) throw Object.assign(new Error(`${method}: ${j.error.message}`), { data: j.error.data })
  return j.result
}
const up = () => rpc('getHealth').then(r => r === 'ok', () => false)

async function startValidator({ authority, accountsDir }) {
  // A validator stopped a moment ago may still hold its ports (on Windows, WSL's forwarding lets go a little later).
  for (let i = 0; i < 30 && !((await portFree(RPC_PORT)) && (await portFree(RPC_PORT + 1))); i++) await pause(500)
  if (!(await portFree(RPC_PORT)) || !(await portFree(RPC_PORT + 1))) throw new Error(`Port ${RPC_PORT} or ${RPC_PORT + 1} is busy: pass --rpc-port with a free one`)
  const q = s => `'${s}'`
  const cmd = [
    'solana-test-validator', '--ledger', LEDGER, '--reset', '--quiet', '--rpc-port', RPC_PORT, '--faucet-port', RPC_PORT + 910,
    '--gossip-port', RPC_PORT + 920, '--dynamic-port-range', `${RPC_PORT + 1100}-${RPC_PORT + 1199}`,
    '--upgradeable-program', PROGRAM_ID, q(hostPath(`${SOLANA_DIR}target/deploy/type262.so`)), authority,
    ...PUMP_PROGRAMS.flatMap(([id, file]) => ['--bpf-program', id, q(hostPath(`${SOLANA_DIR}tests/fixtures/pump/${file}`))]),
    '--account-dir', q(hostPath(accountsDir)),
  ].join(' ')
  const r = shell(`${PATH_SETUP}; setsid nohup ${cmd} > ${LOG} 2>&1 < /dev/null & sleep 1`)
  if (!r.ok) throw new Error(`Could not start solana-test-validator: ${r.out}`)
  for (let i = 0; i < 120; i++) {
    await pause(500)
    if (await up() && (await rpc('getSlot', [{ commitment: 'confirmed' }]).catch(() => 0)) > 1) return
  }
  throw new Error(`solana-test-validator did not come up; its log: ${shell(`tail -20 ${LOG}`).out}`)
}

// ---------- keys, bytes, accounts ----------

function keypairFrom() {
  const privateKey = generateKeyPairSync('ed25519').privateKey
  const raw = Uint8Array.from(Buffer.from(privateKey.export({ format: 'jwk' }).x, 'base64url'))
  return {
    publicKey: base58Encode(raw), raw, pkcs8: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    sign: async m => Uint8Array.from(edSign(null, Buffer.from(m), privateKey)),
  }
}
const walletOf = kp => ({ address: kp.publicKey, signTransaction: tx => T.addSignatures(tx, [kp]) })
const cat = (...parts) => Uint8Array.from(Buffer.concat(parts.map(p => Buffer.from(p))))
const u32le = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
const u64le = v => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b }
const pause = ms => new Promise(res => setTimeout(res, ms))

/** An SPL mint account (82 bytes): `authority` may mint, no freeze authority, nothing minted yet. */
const mintAccount = (pubkey, authority, decimals) => ({ pubkey, owner: TOKEN_PROGRAM, data: cat(u32le(1), pubkeyBytes(authority), u64le(0), [decimals, 1], u32le(0), new Uint8Array(32)) })

/** A 256x256 PNG for the coin's image: a diagonal two-colour field with a ring. */
function coinImage() {
  const w = 256, h = 256
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.hypot(x - 128, y - 128)
      const ring = d > 70 && d < 92
      const t = (x + y) / (w + h)
      const px = ring ? [250, 250, 245] : [Math.round(20 + 200 * t), Math.round(241 - 120 * t), Math.round(149 + 80 * t)]
      raw.set(px, y * (w * 3 + 1) + 1 + x * 3)
    }
  }
  const chunk = (type, data) => {
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const out = Buffer.alloc(12 + data.length)
    out.writeUInt32BE(data.length, 0)
    td.copy(out, 4)
    out.writeUInt32BE(crc32(td), 8 + data.length)
    return out
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

// ---------- chain reads ----------

T.configure({ rpcUrl: RPC_URL, chain: 'solana:localnet' })
const lamports = async a => BigInt((await rpc('getBalance', [a, { commitment: 'confirmed' }])).value)
const tokenBalance = async a => { const [acc] = await T.getAccounts([a]); return acc ? Buffer.from(acc.data).readBigUInt64LE(64) : 0n }
const chainNow = async () => { const [c] = await T.getAccounts(['SysvarC1ock11111111111111111111111111111111']); return Number(Buffer.from(c.data).readBigInt64LE(32)) }
const readCurve = async mint => T.decodeBondingCurve((await T.getAccounts([await T.pumpPda.bondingCurve(mint)]))[0].data)
const solPool = async () => (await T.readPools(DOMAIN)).find(p => p.mint === 'SOL').balance
const usdcPool = async () => (await T.readPools(DOMAIN)).find(p => p.mint === USDC.mint).balance
const txOf = sig => rpc('getTransaction', [sig, { encoding: 'base64', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }])
async function quietly(fn) {
  const saved = [console.log, console.info, console.debug, console.warn]
  console.log = console.info = console.debug = console.warn = () => {}
  try { return await fn() } finally { [console.log, console.info, console.debug, console.warn] = saved }
}

// ---------- the record ----------

const report = { cluster: RPC_URL, domain: DOMAIN, payDomain: PAY_DOMAIN, startedAt: new Date().toISOString(), steps: [], checks: [], screenshots: [], setup: [] }
const say = s => process.stdout.write(`${s}\n`)
let current = null
function check(name, actual, expected) {
  assert.deepEqual(actual, expected, name)
  const value = JSON.parse(JSON.stringify(actual, (k, v) => (typeof v === 'bigint' ? v.toString() : v)) ?? 'null')
  report.checks.push({ step: current && current.name, name, value })
  say(`  =    ${name}: ${typeof value === 'object' ? JSON.stringify(value) : value}`)
}
const ok = (name, cond, detail) => { assert.ok(cond, `${name}${detail ? `: ${detail}` : ''}`); check(name, true, true) }
async function send(kp, txs, note) {
  const sigs = await T.sendAll(walletOf(kp), Array.isArray(txs) ? txs : [txs])
  for (const s of sigs) report.setup.push({ label: note, signature: s })
  say(`  ok   ${note.padEnd(52)} ${sigs.join(' ')}`)
  return sigs
}

// ---------- setup ----------

mkdirSync(WORK, { recursive: true })
rmSync(`${WORK}failure.png`, { force: true })
const [authority, zone, tld, user, user2, claimWallet, trader, feeRecipient] = Array.from({ length: 8 }, keypairFrom)
report.keys = Object.fromEntries(Object.entries({ authority, zone, tld, user, user2, claimWallet, trader, feeRecipient }).map(([k, v]) => [k, v.publicKey]))
const now = Math.floor(Date.now() / 1000)
const chain = await parentChain({ domain: DOMAIN, tld, zone, now, payer: authority.publicKey })
const accountsDir = prepareAccounts(`${WORK}accounts`, [...chain.accounts, mintAccount(USDC.mint, authority.publicKey, USDC.decimals)])
say(`Genesis: pump.fun fixtures, USDC stand-in ${USDC.mint} (6 decimals), cached sets ${chain.accounts.map(a => a.label).join(', ')}`)

if (await up()) {
  if (!flag('--restart')) throw new Error(`A validator already answers on ${RPC_URL}. Pass --restart to replace it (only this run's ledger is stopped), or --rpc-port.`)
  stopValidator()
}
say(`Starting solana-test-validator on ${RPC_URL} (fresh ledger ${LEDGER})...`)
await startValidator({ authority: authority.publicKey, accountsDir })
const genesis = await rpc('getGenesisHash')
if (PUBLIC_GENESIS[genesis]) throw new Error(`${RPC_URL} is ${PUBLIC_GENESIS[genesis]}; this run only uses a local validator`)
report.genesisHash = genesis
report.validator = (await rpc('getVersion'))['solana-core']
say(`Local cluster ${genesis}, solana-core ${report.validator}, program ${PROGRAM_ID}`)

let site = null
let page = null
let failed = null
try {
  await setup()
  await browse()
} catch (err) {
  failed = err
  say(`\nFAILED${current ? ` in "${current.name}"` : ''}: ${err.message}`)
  if (err.logs) say(err.logs.join('\n'))
  if (page) {
    try { report.failureShot = await page.shot(`${WORK}failure.png`, { sel: 'body' }) } catch {}
    try { report.page = await page.evaluate('JSON.stringify(window.__uiE2E)') } catch {}
  }
} finally {
  if (current && !current.done) current.ok = false
  report.finishedAt = new Date().toISOString()
  report.ok = !failed
  report.browserProblems = page ? page.problems : []
  writeFileSync(`${WORK}report.json`, JSON.stringify(report, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 1))
  if (page) await page.close()
  if (site) await site.close()
  if (!flag('--keep')) stopValidator()
}
say(failed ? '\nUI E2E FAILED' : `\nUI E2E PASSED: ${report.steps.length} steps, ${report.steps.reduce((n, s) => n + s.signatures.length, 0)} transactions from the browser, ${report.checks.length} checks, ${report.screenshots.length} screenshots. Report: solana/target/ui-e2e/report.json`)
process.exit(failed ? 1 : 0)

async function setup() {
  say('\nSetup')
  for (const [kp, n] of [[authority, 50n], [user, 20n], [trader, 10n]]) {
    const sig = await rpc('requestAirdrop', [kp.publicKey, Number(n * SOL), { commitment: 'confirmed' }])
    for (let i = 0; i < 80 && !['confirmed', 'finalized'].includes((await rpc('getSignatureStatuses', [[sig]])).value[0]?.confirmationStatus); i++) await pause(250)
  }
  await send(authority, await T.initializeIx({ authority: authority.publicKey, feeRecipient: feeRecipient.publicKey, feeBps: 50, refundDelay: 3600 }), 'initialize (upgrade authority)')
  const userUsdc = await T.ata(user.publicKey, USDC.mint)
  await send(authority, {
    instructions: [
      createAssociatedTokenAccountIdempotent({ payer: authority.publicKey, ata: userUsdc, owner: user.publicKey, mint: USDC.mint }),
      { programId: TOKEN_PROGRAM, keys: [{ pubkey: USDC.mint, isSigner: false, isWritable: true }, { pubkey: userUsdc, isSigner: false, isWritable: true }, { pubkey: authority.publicKey, isSigner: true, isWritable: false }], data: cat([7], u64le(500_000000n)) },
    ],
  }, 'mint 500 USDC (stand-in) to the user')
  const table = await T.lookupTableTx({ payer: authority.publicKey, recentSlot: await rpc('getSlot', [{ commitment: 'finalized' }]) })
  const [tableSig] = await send(authority, table, 'create the launch lookup table')
  const tableSlot = (await txOf(tableSig)).slot
  while ((await rpc('getSlot', [{ commitment: 'confirmed' }])) <= tableSlot) await pause(200)
  report.lookupTable = table.address
  check('config.admin', (await T.readConfig()).admin, authority.publicKey)
  check('user SOL', await lamports(user.publicKey), 20n * SOL)
  check('user USDC', await tokenBalance(userUsdc), 500_000000n)
  check('lookup table entries', (await T.readLookupTable(table.address)).addresses.length, T.LAUNCH_LOOKUP_ADDRESSES.length)

  // The zone's `_wallet` TXT, signed now (by the cluster's clock) by the zone key, and what the page's DoH answers.
  const leaf = await walletSet({ domain: DOMAIN, zone, text: `SOL ${claimWallet.publicKey}`, inception: (await chainNow()) - 300 })
  report.leafSignedAt = leaf.rrsig.inception
  report.doh = dohTable([...chain.sets, leaf], [{ name: DOMAIN, text: `SOL ${claimWallet.publicKey}` }, { name: PAY_DOMAIN, text: `SOL ${user2.publicKey}` }])
  // The same proof the page will build, here in Node through the same stub: only the leaf is left to verify.
  const realFetch = globalThis.fetch
  globalThis.fetch = async (u, init) => (/^https:\/\/(cloudflare-dns\.com|dns\.google)\//.test(String(u)) ? dohStub(String(u), report.doh) : realFetch(u, init))
  let proof
  try { proof = await quietly(() => T.proveWalletTxs({ payer: user.publicKey, name: DOMAIN, wallet: claimWallet.publicKey })) } finally { globalThis.fetch = realFetch }
  report.proofPlan = proof.plan.steps.map(s => `${s.label}: ${s.status}`)
  say(`  plan: ${report.proofPlan.join('; ')}`)
  check('proof from the stubbed DNS: transactions to send', proof.length, 1)
  check('proof publishes the claim wallet', proof.wallets.join(), claimWallet.publicKey)
}

async function browse() {
  site = await serve(ROOT, { from: 5290, to: 5299, rpcUrl: RPC_URL })
  say(`\nSite ${site.origin}/app.html (RPC forwarded to ${RPC_URL})`)
  page = await launchBrowser({ profileDir: `${WORK}profile`, log: say })
  say(`Browser ${page.exe}, throwaway profile ${WORK}profile`)
  const image = coinImage()
  const imagePath = `${WORK}coin.png`
  writeFileSync(imagePath, image)
  const refusedAtNetwork = (report.refusedAtNetwork = [])
  await page.send('Page.enable')
  await page.send('Runtime.enable')
  await page.send('DOM.enable')
  // IPFS gateways serve the coin's image; public Solana RPC and the upload host never answer (the page must not reach them).
  await page.send('Fetch.enable', { patterns: ['https://ipfs.io/*', 'https://gateway.pinata.cloud/*', 'https://solana-rpc.publicnode.com/*', 'https://api.mainnet-beta.solana.com/*', `${UPLOAD}/*`].map(urlPattern => ({ urlPattern })) })
  page.on('Fetch.requestPaused', ({ requestId, request }) => {
    if (/^https:\/\/(ipfs\.io|gateway\.pinata\.cloud)\//.test(request.url)) {
      page.send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'image/png' }, { name: 'access-control-allow-origin', value: '*' }], body: image.toString('base64') }).catch(() => {})
    } else {
      refusedAtNetwork.push(request.url)
      page.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => {})
    }
  })
  const cfg = {
    rpcUrls: ['https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com', `${UPLOAD}/rpc/solana`],
    rpcProxy: `${site.origin}${RPC_PATH}`, upload: UPLOAD, imageUri: IMAGE_URI, metadataUri: METADATA_URI, doh: report.doh,
    wallet: { name: 'Test Wallet', address: user.publicKey, publicKey: Buffer.from(user.raw).toString('base64'), pkcs8: user.pkcs8 },
    clientUrl: `${site.origin}/assets/solana-type262.js`, lookupTables: [report.lookupTable],
  }
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: pageScript(cfg) })
  await page.viewport(1440, 900)
  await page.send('Page.navigate', { url: `${site.origin}/app.html#pay` })
  await page.waitFor('window.__uiE2E && window.__uiE2E.configured && document.querySelector("#connect") && document.querySelector("#v-pay.on")', { what: 'the app and the configured client' })
  check('the page uses the local test program', await page.evaluate('window.__uiE2E.programId'), PROGRAM_ID)

  const E = 'window.__uiE2E'
  const text = sel => page.evaluate(`(document.querySelector(${JSON.stringify(sel)}) || {}).textContent || ''`)
  const hrefs = sel => page.evaluate(`[...document.querySelectorAll(${JSON.stringify(sel)})].filter(a => !a.hidden).map(a => a.href)`)
  const sigsIn = async sel => (await hrefs(`${sel} a[href*="/tx/"]`)).map(h => h.split('/tx/')[1])
  // Lamports as the screens show SOL: at most 6 decimals, cut, trailing zeros dropped.
  const sol9 = n => { const x = n.toString().padStart(10, '0'); const f = x.slice(-9, -3).replace(/0+$/, ''); return `${x.slice(0, -9)}${f ? `.${f}` : ''} SOL` }
  const warn = sel => `(document.querySelector('${sel} .note.warn') || {}).textContent`
  const states = async (name, sel) => {
    // The toast that confirms a step fades after 3.2 s; the captures show the screen under it.
    await page.waitFor(`!document.querySelector('.toast.show')`, { timeout: 10_000, what: 'the toast to fade' })
    await pause(400)
    for (const width of [1440, 375]) {
      const file = await page.shot(`${WORK}${name}-${width}.png`, { width, sel })
      report.screenshots.push(file)
    }
  }
  const step = async (name, fn) => {
    current = { name, signatures: [], done: false }
    report.steps.push(current)
    say(`\n${report.steps.length}. ${name}`)
    await fn(current)
    current.ok = current.done = true
    for (const s of current.signatures) {
      const t = await txOf(s)
      assert.ok(t && !t.meta.err, `${s} failed on-chain: ${JSON.stringify(t && t.meta.err)}`)
      say(`  tx   ${s}  v${t.version} fee ${t.meta.fee} CU ${t.meta.computeUnitsConsumed}`)
    }
  }

  await step('Pay: SOL to a domain that publishes a wallet', async s => {
    await page.click('#connect')
    await page.waitFor(`${E}.connected && document.querySelector('#connect span').textContent.startsWith(${JSON.stringify(user.publicKey.slice(0, 10))})`, { what: 'the wallet connected in the header' })
    await page.type('#v-pay input[name=d]', PAY_DOMAIN)
    await page.press('Enter')
    await page.waitFor(`document.querySelector('#p-send')`, { what: 'the payment card' })
    ok('the card shows the published address', (await text('#pay-step .r-row .addr')) === user2.publicKey)
    ok('DNSSEC note', (await text('#pay-step .note')).includes('DNSSEC-signed and confirmed by every resolver'))
    await page.select('#p-asset', 'sol')
    await page.type('#p-amt', '0.25')
    const before = await lamports(user.publicKey)
    await page.click('#p-send')
    await page.waitFor(`document.querySelector('#p-status .note.good')`, { fail: warn('#p-status'), what: 'Pay: the success note' })
    s.signatures = await sigsIn('#p-status')
    check('pay transactions', s.signatures.length, 1)
    check('the second wallet received 0.25 SOL', await lamports(user2.publicKey), 250_000_000n)
    const t = await txOf(s.signatures[0])
    check('the user paid 0.25 SOL + the network fee', before - await lamports(user.publicKey), 250_000_000n + BigInt(t.meta.fee))
    check('success note', (await text('#p-status .note.good')).startsWith(`✓ Sent 0.25 SOL to ${PAY_DOMAIN} on Solana.`), true)
    await states('1-pay-sent', '#v-pay')
  })

  await step('Escrow: deposit SOL and USDC to a domain', async s => {
    await page.click('.rail a[data-v=escrow]')
    // The last domain used (the Pay form's) follows to the escrow screen and is looked up there.
    await page.waitFor(`document.querySelector('#esc-sol:not([hidden]) #se-out .r-head .label')?.textContent === 'Waiting for ${PAY_DOMAIN}'`, { fail: warn('#se-out'), what: 'the escrow screen for the last domain' })
    check('the domain field followed from Pay', await page.evaluate(`document.querySelector('#esc-sol input[name=d]').value`), PAY_DOMAIN)
    await page.type('#esc-sol input[name=d]', DOMAIN)
    await page.press('Enter')
    await page.waitFor(`document.querySelector('#se-out .r-head .label')?.textContent === 'Waiting for ${DOMAIN}' && document.querySelector('#se-out #se-dep')`, { fail: warn('#se-out'), what: 'the escrow screen' })
    check('address bar', await page.evaluate('location.hash'), `#escrow/${DOMAIN}`)
    const rows = () => page.evaluate(`[...document.querySelectorAll('#se-out .result .r-row')].map(r => r.querySelector('.r-code').textContent + ' ' + r.querySelector('.addr').textContent)`)
    check('pools before', await rows(), ['SOL 0', 'USDC 0'])
    ok('the record is found and signed', (await text('#se-out .note:not(.warn)')).includes('· DNSSEC ✓'))
    await page.select('#se-asset', '0')
    await page.type('#se-amt', '1.5')
    await page.click('#se-dep')
    await page.waitFor(`document.querySelector('#se-dstat .note.good')`, { fail: warn('#se-dstat'), what: 'the SOL deposit' })
    s.signatures.push(...await sigsIn('#se-dstat'))
    check('SOL pool on-chain', await solPool(), 1_500_000_000n)
    check('SOL row on screen', (await rows())[0], 'SOL 1.5')
    await page.select('#se-asset', '1')
    await page.type('#se-amt', '120.5')
    await page.click('#se-dep')
    await page.waitFor(`document.querySelector('#se-dstat .note.good') && document.querySelector('#se-dstat .note.good').textContent.includes('USDC')`, { fail: warn('#se-dstat'), what: 'the USDC deposit' })
    s.signatures.push(...await sigsIn('#se-dstat'))
    check('deposit transactions', s.signatures.length, 2)
    check('USDC pool on-chain', await usdcPool(), 120_500000n)
    check('USDC vault holds it', await tokenBalance(await T.ata(await T.pda.pool(await T.domainHash(DOMAIN), USDC.mint), USDC.mint)), 120_500000n)
    check('the user USDC after', await tokenBalance(await T.ata(user.publicKey, USDC.mint)), 379_500000n)
    check('pools and deposits on screen', (await rows()).map(r => r.replace(/Refundable from .*/, 'Refundable from <date>')), ['SOL 1.5', 'USDC 120.5', 'SOL Your deposit: 1.5. Refundable from <date>', 'USDC Your deposit: 120.5. Refundable from <date>'])
    check('deposit records', [(await T.readDeposit(DOMAIN, 'SOL', user.publicKey)).amount, (await T.readDeposit(DOMAIN, USDC.mint, user.publicKey)).amount], [1_500_000_000n, 120_500000n])
    await states('2-escrow-deposits', '#v-escrow')
  })

  await step("Escrow: prove the zone's _wallet record and claim", async s => {
    check('claim button', await text('#se-claim'), `Claim to ${claimWallet.publicKey.slice(0, 10)}…${claimWallet.publicKey.slice(-8)}`)
    await page.click('#se-claim')
    await page.waitFor(`document.querySelector('#se-status .note.good')`, { fail: warn('#se-status'), what: 'the claim', timeout: 120_000 })
    s.signatures = await sigsIn('#se-status')
    check('transactions: proof, claim SOL, claim USDC', s.signatures.length, 3)
    const shown = await page.evaluate(`[...document.querySelectorAll('#se-status .sx-steps li')].map(li => li.dataset.s + ' ' + li.querySelector('span').textContent)`)
    say(`  steps on screen: ${shown.join(' | ')}`)
    check('claim steps on screen', shown.slice(1), [`done Claim 1.5 SOL to ${claimWallet.publicKey.slice(0, 10)}…${claimWallet.publicKey.slice(-8)}`, `done Claim 120.5 USDC to ${claimWallet.publicKey.slice(0, 10)}…${claimWallet.publicKey.slice(-8)}`])
    ok('the proof step is done', shown[0].startsWith('done '), shown[0])
    const solFee = T.feeOf(1_500_000_000n, 50)
    const usdcFee = T.feeOf(120_500000n, 50)
    check('claim wallet SOL = 1.5 - 0.5%', await lamports(claimWallet.publicKey), 1_500_000_000n - solFee)
    check('claim wallet USDC = 120.5 - 0.5%', await tokenBalance(await T.ata(claimWallet.publicKey, USDC.mint)), 120_500000n - usdcFee)
    check('pools emptied', [await solPool(), await usdcPool()], [0n, 0n])
    check('fees owed', [await T.readFees('SOL'), await T.readFees(USDC.mint)], [solFee, usdcFee])
    const dom = await T.readDomain(DOMAIN)
    check('domain.wallet', dom.wallet, claimWallet.publicKey)
    check('domain.lastProof = the record signing time', dom.lastProof, report.leafSignedAt)
    const records = await T.readRecords(DOMAIN)
    check('cached record', records.map(r => `${r.type}:${r.wallets.join()}`), [`TXT:${claimWallet.publicKey}`])
    // The screen re-reads: emptied pools, the registered wallet, the claimed deposits, and the wallet's balances.
    await page.waitFor(`document.querySelector('#se-bal').textContent.startsWith('Your wallet:')`, { what: 'the wallet line' })
    const line = await text('#se-bal')
    const [uiSol, uiUsdc] = line.replace('Your wallet: ', '').split(' · ').map(x => Number(x.split(' ')[0].replace(/,/g, '')))
    check('wallet line SOL = on-chain (6 decimals)', uiSol, Math.floor(Number(await lamports(user.publicKey)) / 1e3) / 1e6)
    check('wallet line USDC', uiUsdc, 379.5)
    ok('registered wallet shown', (await text('#se-out')).includes(`Registered wallet: ${claimWallet.publicKey.slice(0, 10)}…${claimWallet.publicKey.slice(-8)}`))
    ok('deposits shown as claimed', (await text('#se-out .result')).includes(`Your deposit: 1.5. Claimed by ${DOMAIN}.`))
    check('claim button after', [await text('#se-claim'), await page.evaluate(`document.querySelector('#se-claim').disabled`)], ['Registered', true])
    await states('3-escrow-claimed', '#v-escrow')
  })

  let mint = ''
  await step('Launch: a coin with an opening buy', async s => {
    await page.click('.rail a[data-v=launch]')
    await page.waitFor(`document.querySelector('#ln-sol:not([hidden]) #sl-new.on [data-form=sl-create]')`, { what: 'the launch form' })
    check('opening buy offered (lookup table configured)', await page.evaluate(`document.querySelector('#sl-open').hidden`), false)
    check('domain field', await page.evaluate(`document.querySelector('[data-form=sl-create] [name=domain]').value`), DOMAIN)
    await page.waitFor(`document.querySelector('#sl-dest').textContent.includes('publishes a signed') && !document.querySelector('#sl-feeto').hidden`, { what: 'the fee destination check' })
    const creator = await T.pda.creator(await T.domainHash(DOMAIN))
    ok('fee address shown', (await text('#sl-feeto')).includes(`${creator.slice(0, 10)}…${creator.slice(-8)}`))
    await page.setFiles('#sl-file', [imagePath])
    await page.waitFor(`document.querySelector('#sl-upstat.ok')`, { fail: `document.querySelector('#sl-upstat.err') && document.querySelector('#sl-upstat').textContent`, what: 'the image upload' })
    check('image link', await page.evaluate(`document.querySelector('[data-form=sl-create] [name=logo]').value`), IMAGE_URI)
    await page.type('[data-form=sl-create] [name=name]', 'UI E2E Coin')
    await page.type('[data-form=sl-create] [name=symbol]', 'UIE2E')
    await page.type('[data-form=sl-create] [name=description]', 'Launched by the UI end-to-end run on a local validator.')
    await page.type('[data-form=sl-create] [name=buy]', '0.5')
    ok('quote shown', (await text('#sl-quote')).includes('$UIE2E'), await text('#sl-quote'))
    check('submit label', await text('#sl-submit'), 'Launch $UIE2E')
    const before = await lamports(user.publicKey)
    await page.click('#sl-submit')
    await page.waitFor(`document.querySelector('#sl-done .sl-live')`, { fail: warn('#sl-status'), what: 'the launched coin', timeout: 120_000 })
    mint = (await text('#sl-done .ln-est.mono')).match(/Mint (\w+)/)[1]
    check('toast', await text('.toast.show'), `$UIE2E is live on pump.fun. Its creator fees go to ${DOMAIN}.`)
    s.signatures = await sigsIn('#sl-done')
    check('launch transactions', s.signatures.length, 1)
    const t = await txOf(s.signatures[0])
    check('a v0 transaction (over the lookup table)', t.version, 0)
    check('the wallet signed a v0 transaction', await page.evaluate(`${E}.signed.at(-1).version`), 0)
    const launches = await T.readLaunches(DOMAIN)
    check('readLaunches', launches.map(l => `${l.mint}/${l.launcher}`), [`${mint}/${user.publicKey}`])
    const curve = await readCurve(mint)
    check('curve creator = the domain creator PDA', curve.creator, creator)
    const tokens = await tokenBalance(await T.ata(user.publicKey, mint, T.TOKEN_2022_PROGRAM))
    ok('the opening buy got tokens', tokens > 0n, String(tokens))
    ok('the opening buy cost at most 0.5 SOL plus rent and fees', before - await lamports(user.publicKey) < 500_000_000n + 20_000_000n)
    const parsed = (await rpc('getAccountInfo', [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }])).value.data.parsed.info
    const md = parsed.extensions.find(e => e.extension === 'tokenMetadata').state
    check('on-chain metadata', [md.name, md.symbol, md.uri], ['UI E2E Coin', 'UIE2E', METADATA_URI])
    const pinned = await page.evaluate(`${E}.metadata.at(-1)`)
    check('pinned metadata', [pinned.name, pinned.symbol, pinned.image, pinned.website], ['UI E2E Coin', 'UIE2E', IMAGE_URI, `https://${DOMAIN}`])
    report.launch = { mint, tokens: tokens.toString(), creatorFee: curve.creatorFee.toString() }
    await states('4-launch-live', '#v-launch')
  })

  await step('Launch: a trade, then Collect to escrow', async s => {
    const buy = await T.buyIxs({ payer: trader.publicKey, mint, buyLamports: 300_000_000n })
    const [tradeSig] = await send(trader, { ...buy, label: 'trader buys for 0.3 SOL' }, 'a second trader buys for 0.3 SOL (this script)')
    report.trade = tradeSig
    const pending = (await readCurve(mint)).creatorFee
    await page.click(`#sl-done a[href="#launch/${DOMAIN}"]`)
    await page.waitFor(`document.querySelector('#sl-grid .ln-card[data-mint="${mint}"]') && document.querySelector('#sl-fees [data-collect]') && !document.querySelector('#sl-fees [data-collect]').disabled`, { fail: `document.querySelector('#sl-fees .note.warn') && document.querySelector('#sl-fees').textContent`, what: 'the coin card and Collect' })
    ok('card shows the coin', (await text(`#sl-grid .ln-card[data-mint="${mint}"]`)).includes('UI E2E Coin'))
    await page.waitFor(`(() => { const i = document.querySelector('#sl-grid .ln-card[data-mint="${mint}"] img'); return !!i && i.complete && i.naturalWidth > 0 })()`, { what: "the coin's image from its metadata" })
    const v = () => page.evaluate(`[...document.querySelectorAll('#sl-fees .ln-feegrid .v')].map(x => x.textContent.replace(/\\s+/g, ' ').trim())`)
    check('fees on screen before (waiting at pump.fun, in escrow)', await v(), [sol9(pending), '0 SOL'])
    const pool0 = await solPool()
    await page.click('#sl-fees [data-collect]')
    await page.waitFor(`document.querySelector('#sl-cstat .note.good')`, { fail: warn('#sl-cstat'), what: 'the collect' })
    s.signatures = await sigsIn('#sl-cstat')
    check('toast', await text('.toast.show'), `Fees moved to escrow for ${DOMAIN}`)
    check('collect transactions', s.signatures.length, 1)
    check('pool rises by the creator fees', (await solPool()) - pool0, pending)
    check('curve creator fee swept', (await readCurve(mint)).creatorFee, 0n)
    await page.waitFor(`[...document.querySelectorAll('#sl-fees .ln-feegrid .v')].map(x => x.textContent).join('|').startsWith('0 ')`, { what: 'the fees box re-read' })
    check('fees on screen after', await v(), ['0 SOL', sol9(pending)])
    report.collected = pending.toString()
    await states('5-launch-collected', '#v-launch')
  })

  await step('Escrow: claim the collected creator fees', async s => {
    const fees = await solPool()
    await page.click(`#sl-fees a[href="#escrow/${DOMAIN}"]`)
    await page.waitFor(`document.querySelector('#se-claim') && document.querySelector('#se-claim').textContent.startsWith('Claim to')`, { fail: warn('#se-out'), what: 'the escrow screen with fees waiting' })
    const wallet0 = await lamports(claimWallet.publicKey)
    await page.click('#se-claim')
    await page.waitFor(`document.querySelector('#se-status .note.good')`, { fail: warn('#se-status'), what: 'the second claim', timeout: 120_000 })
    s.signatures = await sigsIn('#se-status')
    check('transactions: the claim only (the proof is cached)', s.signatures.length, 1)
    check('steps on screen', await page.evaluate(`[...document.querySelectorAll('#se-status .sx-steps li')].map(li => li.dataset.s + ' ' + li.querySelector('span').textContent)`), [`done Claim ${sol9(fees).replace(' SOL', '')} SOL to ${claimWallet.publicKey.slice(0, 10)}…${claimWallet.publicKey.slice(-8)}`])
    check('claim wallet received the fees less 0.5%', (await lamports(claimWallet.publicKey)) - wallet0, fees - T.feeOf(fees, 50))
    check('SOL pool emptied', await solPool(), 0n)
    await states('6-escrow-fees-claimed', '#v-escrow')
  })

  check('the page sent no request to a public Solana RPC', [await page.evaluate(`${E}.refused`), refusedAtNetwork], [[], []])
  check('page errors', await page.evaluate(`${E}.errors`), [])
  report.rpcCalls = await page.evaluate(`${E}.rpc`)
  report.walletSignatures = await page.evaluate(`${E}.signed`)
}
