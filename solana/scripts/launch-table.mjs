// Creates the launch lookup table on Solana mainnet: the accounts every pump.fun launch names (solana-vault.js
// LAUNCH_TABLE_ADDRESSES), so a v0 launch carries each in one byte and keeps its compute budget and the board's
// reference next to the opening buy. One transaction creates and fills it; the keypair is its authority and pays its
// rent (about 0.0042 SOL for 20 addresses, returned if the table is ever closed). The table is not frozen: entries
// can only be appended, never changed, so more pump.fun accounts can be added later.
//
// usage: KEYPAIR=<solana-keypair.json> SOLANA_RPC=<url> node solana/scripts/launch-table.mjs [--dry-run]
//   --dry-run simulates the transaction and prints the table address it would create; nothing is sent.
// Then set SOLANA_LAUNCH_TABLE (assets/config.js) or LAUNCH_TABLE in assets/solana-vault.js to the address it prints.
import { readFileSync } from 'node:fs'
import { createPrivateKey, sign as edSign } from 'node:crypto'
import * as sol from '../../assets/solana.js'
import * as V from '../../assets/solana-vault.js'
import * as T from '../../assets/solana-type262.js'

const dry = process.argv.includes('--dry-run')
const RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com'
if (!process.env.KEYPAIR) throw new Error('Set KEYPAIR to a Solana CLI keypair file.')

const raw = Uint8Array.from(JSON.parse(readFileSync(process.env.KEYPAIR, 'utf8')))
if (raw.length !== 64) throw new Error('The keypair file must hold 64 bytes.')
const payer = sol.base58Encode(raw.subarray(32))
const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), raw.subarray(0, 32)]), format: 'der', type: 'pkcs8' })
raw.fill(0)

const rpc = async (method, params) => {
  const j = await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()
  if (j.error) throw new Error(`${method}: ${j.error.message}`)
  return j.result
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

const balance = BigInt((await rpc('getBalance', [payer, { commitment: 'confirmed' }])).value)
const rent = BigInt(await rpc('getMinimumBalanceForRentExemption', [56 + 32 * V.LAUNCH_TABLE_ADDRESSES.length]))
console.log(`authority and payer ${payer}: ${Number(balance) / 1e9} SOL; table rent ${Number(rent) / 1e9} SOL for ${V.LAUNCH_TABLE_ADDRESSES.length} addresses`)
if (balance < rent + 10_000n) throw new Error('Not enough SOL for the rent and the fee.')

const recentSlot = await rpc('getSlot', [{ commitment: 'finalized' }])
const plan = await T.lookupTableTx({ payer, recentSlot, addresses: V.LAUNCH_TABLE_ADDRESSES })
const { blockhash, lastValidBlockHeight } = (await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])).value
const message = sol.serializeMessage(sol.compileMessage({ payer, recentBlockhash: blockhash, instructions: plan.instructions }))
const tx = sol.unsignedTransaction(message)
tx.set(edSign(null, Buffer.from(message), key), 1)
const wire = Buffer.from(tx).toString('base64')
console.log(`table ${plan.address}, transaction ${tx.length} bytes`)

if (dry) {
  const sim = await rpc('simulateTransaction', [wire, { encoding: 'base64', commitment: 'confirmed', sigVerify: true }])
  console.log(sim.value.err ? `SIMULATION FAILED ${JSON.stringify(sim.value.err)}\n${(sim.value.logs || []).join('\n')}` : `simulation ok, ${sim.value.unitsConsumed} units; nothing was sent`)
  process.exit(sim.value.err ? 1 : 0)
}

const signature = await rpc('sendTransaction', [wire, { encoding: 'base64', preflightCommitment: 'confirmed' }])
console.log(`sent ${signature}`)
for (;;) {
  const st = (await rpc('getSignatureStatuses', [[signature]])).value[0]
  if (st && st.err) throw new Error(`The transaction failed: ${JSON.stringify(st.err)}`)
  if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) break
  if ((await rpc('getBlockHeight', [{ commitment: 'confirmed' }])) > lastValidBlockHeight) throw new Error('The transaction expired; run again.')
  await sleep(1500)
}
await sleep(1500)
const a = (await rpc('getAccountInfo', [plan.address, { encoding: 'base64', commitment: 'confirmed' }])).value
const data = Buffer.from(a.data[0], 'base64')
const entries = []
for (let at = 56; at + 32 <= data.length; at += 32) entries.push(sol.base58Encode(data.subarray(at, at + 32)))
const same = entries.length === V.LAUNCH_TABLE_ADDRESSES.length && entries.every((e, i) => e === V.LAUNCH_TABLE_ADDRESSES[i])
console.log(`${same ? 'OK' : 'MISMATCH'}: table ${plan.address} holds ${entries.length} addresses, owner ${a.owner}`)
console.log(`set LAUNCH_TABLE to '${plan.address}'`)
process.exit(same ? 0 : 1)
