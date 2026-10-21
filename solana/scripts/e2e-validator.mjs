// A local solana-test-validator for the end-to-end run (e2e-local.mjs): the type262 program as an upgradeable
// program with a throwaway upgrade authority, the mainnet pump.fun programs and accounts the LiteSVM launcher
// suites load (tests/fixtures/pump, from fetch-fixtures.mjs), and any extra accounts the run injects.
//
// solana-test-validator does not run natively on Windows (README.md, "Local validator"), so on Windows it runs in
// WSL, reading the program and fixtures from the Windows drive; RPC answers on 127.0.0.1:8899 on both sides.
// usePort(port) moves it to another RPC port, with its own ledger, log, faucet and gossip ports, so it can run
// next to a validator on 8899; stopping it then stops only that one.
//
//   node solana/scripts/e2e-validator.mjs status [--port N]    is a validator answering on 127.0.0.1:8899 (or N)
//   node solana/scripts/e2e-validator.mjs stop                 stops any solana-test-validator (WSL on Windows)
//   node solana/scripts/e2e-validator.mjs stop --port N        stops only the one started for port N
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const DEFAULT_PORT = 8899
export let RPC_URL = `http://127.0.0.1:${DEFAULT_PORT}`
export const PROGRAM_ID = '3fhiMDY5kyCpX47HU1whuEe6vMQFHPa1hwGhc4Pp72NT'
const SOLANA_DIR = fileURLToPath(new URL('..', import.meta.url))
const FIXTURES = `${SOLANA_DIR}tests/fixtures/pump/`
const PROGRAM_SO = `${SOLANA_DIR}target/deploy/type262.so`
const WINDOWS = process.platform === 'win32'
// On the Linux side, so the ledger is not written through the Windows drive mount (much slower).
let PORT = DEFAULT_PORT
let LEDGER = '/tmp/type262-e2e-ledger'
let LOG = '/tmp/type262-e2e-validator.log'

/**
 * Runs the validator on another RPC port (the websocket takes the next one, the faucet and gossip the two after),
 * with its own ledger and log. Call it before anything else here.
 */
export function usePort(port) {
  if (!Number.isInteger(port) || port < 1024 || port > 65_000) throw new Error(`Not a usable RPC port: ${port}`)
  PORT = port
  RPC_URL = `http://127.0.0.1:${port}`
  if (port !== DEFAULT_PORT) {
    LEDGER = `/tmp/type262-e2e-ledger-${port}`
    LOG = `/tmp/type262-e2e-validator-${port}.log`
  }
}
// The Solana CLI's two usual install places (README.md), without assuming either is on PATH.
const PATH_SETUP = 'export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.local/share/solana/stable/bin:$PATH"'

// The programs the launcher suites load (tests-rs/tests/launcher_support/mod.rs), over the validator's own copies.
export const PUMP_PROGRAMS = [
  ['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', 'pump.so'],
  ['pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', 'pump_amm.so'],
  ['pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ', 'pump_fees.so'],
  ['MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e', 'mayhem.so'],
  ['metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s', 'mpl_token_metadata.so'],
  ['TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', 'spl_token_2022.so'],
  ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'spl_token.so'],
  ['ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', 'spl_associated_token_account.so'],
]

/** Where the validator reads a file from: the WSL path of a Windows file on Windows, the file itself elsewhere. */
function hostPath(file) {
  if (!WINDOWS) return file
  const out = spawnSync('wsl.exe', ['-e', 'wslpath', '-u', file.replace(/\//g, '\\')], { encoding: 'utf8' })
  if (out.status !== 0) throw new Error(`wslpath failed: ${out.stderr || out.error}`)
  return out.stdout.trim()
}

/** Rent-exempt lamports for `size` bytes at the validator's default rent (3,480 lamports per byte-year, 2 years). */
export const rentExempt = size => (128 + size) * 3480 * 2

/**
 * Writes the accounts the validator loads at genesis into `dir` (solana account --output json format): every
 * pump.fun fixture account except the Rent sysvar (the validator keeps its own), then `extra`
 * ([{ pubkey, owner, data (bytes), lamports?, executable? }]).
 */
export function prepareAccounts(dir, extra = []) {
  if (!existsSync(`${FIXTURES}pump.so`)) throw new Error('pump.fun fixtures missing: run `node solana/scripts/fetch-fixtures.mjs` first (see docs/PUMP.md)')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const write = (pubkey, owner, b64, length, lamports, executable = false) => writeFileSync(`${dir}/${pubkey}.json`, JSON.stringify({
    pubkey, account: { lamports, data: [b64, 'base64'], owner, executable, rentEpoch: 0, space: length },
  }))
  for (const f of readdirSync(`${FIXTURES}accounts`)) {
    const a = JSON.parse(readFileSync(`${FIXTURES}accounts/${f}`, 'utf8'))
    if (a.owner === 'Sysvar1111111111111111111111111111111111111') continue
    write(a.pubkey, a.owner, a.data, Buffer.from(a.data, 'base64').length, a.lamports, a.executable)
  }
  for (const a of extra) write(a.pubkey, a.owner, Buffer.from(a.data).toString('base64'), a.data.length, a.lamports ?? rentExempt(a.data.length), a.executable)
  return dir
}

/** The shell command that starts a fresh validator in the background, for `authority` and the accounts in `dir`. */
export function validatorCommand({ authority, accountsDir }) {
  const q = s => `'${s}'`
  const args = [
    '--ledger', LEDGER, '--reset', '--quiet', '--rpc-port', String(PORT),
    ...(PORT === DEFAULT_PORT ? [] : ['--faucet-port', String(PORT + 2), '--gossip-port', String(PORT + 3)]),
    '--upgradeable-program', PROGRAM_ID, q(hostPath(PROGRAM_SO)), authority,
    ...PUMP_PROGRAMS.flatMap(([id, file]) => ['--bpf-program', id, q(hostPath(FIXTURES + file))]),
    '--account-dir', q(hostPath(accountsDir)),
  ]
  // setsid, and a moment before the shell exits, so the validator outlives the wsl.exe call that started it.
  return `${PATH_SETUP}; setsid nohup solana-test-validator ${args.join(' ')} > ${LOG} 2>&1 < /dev/null & sleep 1`
}

function shell(cmd) {
  const out = WINDOWS ? spawnSync('wsl.exe', ['-e', 'bash', '-lc', cmd], { encoding: 'utf8' }) : spawnSync('bash', ['-lc', cmd], { encoding: 'utf8' })
  return { ok: out.status === 0, out: `${out.stdout || ''}${out.stderr || ''}`.trim() }
}

/** The JSON-RPC answer of the local validator, or null when nothing listens. */
export async function localRpc(method, params = []) {
  try {
    const res = await fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(3000) })
    const j = await res.json()
    return j.error ? null : j.result
  } catch { return null }
}

export const isUp = async () => (await localRpc('getHealth')) === 'ok'

/** Starts a fresh validator and waits until it answers and produces slots. */
export async function startValidator(opts) {
  if (await isUp()) throw new Error(`A validator already answers on ${RPC_URL}. Stop it first (node solana/scripts/e2e-validator.mjs stop${PORT === DEFAULT_PORT ? '' : ` --port ${PORT}`}).`)
  if (!existsSync(PROGRAM_SO)) throw new Error('target/deploy/type262.so missing: run `anchor build` in solana/')
  const r = shell(validatorCommand(opts))
  if (!r.ok) throw new Error(`Could not start solana-test-validator: ${r.out}`)
  for (let i = 0; i < 120; i++) {
    await new Promise(res => setTimeout(res, 500))
    if (await isUp() && (await localRpc('getSlot', [{ commitment: 'confirmed' }])) > 1) return
  }
  throw new Error(`solana-test-validator did not come up; its log: ${shell(`tail -20 ${LOG}`).out}`)
}

export function stopValidator() {
  // The [s] keeps pkill from matching the shell running this very command. On another port, only the validator
  // with that port's ledger.
  const pattern = PORT === DEFAULT_PORT ? '[s]olana-test-validator' : `[s]olana-test-validator.*${LEDGER} `
  shell(`pkill -INT -f '${pattern}'; sleep 2; pkill -KILL -f '${pattern}'; true`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const cmd = process.argv[2]
  const at = process.argv.indexOf('--port')
  if (at > 0) usePort(Number(process.argv[at + 1]))
  if (cmd === 'stop') { stopValidator(); console.log('stopped') } else if (cmd === 'status') console.log((await isUp()) ? `up, slot ${await localRpc('getSlot')}` : 'down')
  else console.log('usage: node solana/scripts/e2e-validator.mjs status|stop [--port N]')
}
