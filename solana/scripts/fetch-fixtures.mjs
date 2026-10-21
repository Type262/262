// Download what LiteSVM needs to run pump.fun offline: the mainnet executables of pump, PumpSwap, Pump Fees
// and the programs they call, the global/config accounts their instructions read, and the IDLs.
//   node solana/scripts/fetch-fixtures.mjs [outDir]     (default solana/tests/fixtures/pump)
// Output (gitignored): <name>.so, accounts/<pubkey>.json ({ pubkey, owner, lamports, data (base64),
// executable, rentEpoch }), idl/<name>.json and manifest.json (slot, labels, sizes, sha256, sources).
// Env: SOLANA_RPC (comma-separated endpoints).
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as L from './pump-lib.mjs'
import * as X from './pump-ix.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const out = resolve(process.argv[2] || join(here, '..', 'tests', 'fixtures', 'pump'))
const IDL_COMMIT = '639b87fb45c3adeffa6f7c4a1bf0cb85e392bf22' // pump-fun/pump-public-docs, 2026-10-13
const sha256 = b => createHash('sha256').update(b).digest('hex')
const UPGRADEABLE = 'BPFLoaderUpgradeab1e11111111111111111111111'

// Programs the launcher's instructions reach. LiteSVM bundles its own SPL builds, but older ones: loading
// the mainnet executables keeps Token-2022 extensions and the ATA program exactly as pump sees them.
const PROGRAMS = {
  pump: L.PUMP,
  pump_amm: L.PUMP_AMM,
  pump_fees: L.PUMP_FEES,
  mayhem: L.MAYHEM, // create_v2 always passes its accounts; mayhem-mode creates call it
  mpl_token_metadata: L.METAPLEX, // only the legacy `create` calls it
  spl_token_2022: L.TOKEN_2022,
  spl_token: L.TOKEN,
  spl_associated_token_account: L.ATA_PROGRAM,
}

async function slice(address, offset, length) {
  const r = await L.rpc('getAccountInfo', [address, { encoding: 'base64', commitment: 'confirmed', dataSlice: { offset, length } }])
  return Buffer.from(r.value.data[0], 'base64')
}

// An upgradeable program's ELF sits in its programdata account after a 45-byte header, padded with zeros
// to the space reserved for upgrades (10 MiB for pump and PumpSwap). Fetch only the ELF: read its header
// and section table to find where it ends, then check the bytes after that end are padding.
async function programElf(programId) {
  const acc = await L.getAccount(programId)
  if (acc.owner !== UPGRADEABLE) return { elf: acc.data, loader: acc.owner, programAccount: acc }
  const programData = L.b58encode(acc.data.subarray(4, 36))
  const head = await slice(programData, 0, 45 + 64)
  const lastDeploySlot = Number(head.readBigUInt64LE(4))
  const upgradeAuthority = head[12] ? L.b58encode(head.subarray(13, 45)) : null
  const eh = head.subarray(45)
  if (eh.readUInt32BE(0) !== 0x7f454c46) throw new Error(`${programId}: programdata is not an ELF`)
  const phoff = Number(eh.readBigUInt64LE(0x20)), shoff = Number(eh.readBigUInt64LE(0x28))
  const phentsize = eh.readUInt16LE(0x36), phnum = eh.readUInt16LE(0x38), shentsize = eh.readUInt16LE(0x3a), shnum = eh.readUInt16LE(0x3c)
  let end = Math.max(phoff + phentsize * phnum, shoff + shentsize * shnum)
  const sh = await slice(programData, 45 + shoff, shentsize * shnum)
  for (let i = 0; i < shnum; i++) {
    const s = sh.subarray(i * shentsize)
    if (s.readUInt32LE(4) !== 8) end = Math.max(end, Number(s.readBigUInt64LE(0x18)) + Number(s.readBigUInt64LE(0x20))) // skip SHT_NOBITS
  }
  const tail = await slice(programData, 45 + end, 4096)
  if (tail.some(b => b !== 0)) throw new Error(`${programId}: data after the computed ELF end ${end}; refusing to trim`)
  const elf = await slice(programData, 45, end)
  return { elf, loader: UPGRADEABLE, programAccount: acc, programData, lastDeploySlot, upgradeAuthority }
}

const toJson = a => ({ pubkey: a.pubkey, owner: a.owner, lamports: a.lamports, data: a.data.toString('base64'), executable: a.executable, rentEpoch: a.rentEpoch ?? 0 })

mkdirSync(join(out, 'accounts'), { recursive: true })
mkdirSync(join(out, 'idl'), { recursive: true })
writeFileSync(join(out, '.gitignore'), '# Mainnet dumps: refetch with solana/scripts/fetch-fixtures.mjs\n*\n!.gitignore\n')

const slot = await L.rpc('getSlot', [{ commitment: 'confirmed' }])
const manifest = { fetchedAt: new Date().toISOString(), slot, rpc: (process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com').split(',')[0], programs: {}, accounts: {}, idl: {} }

for (const [name, id] of Object.entries(PROGRAMS)) {
  const p = await programElf(id)
  writeFileSync(join(out, `${name}.so`), p.elf)
  manifest.programs[name] = { programId: id, file: `${name}.so`, bytes: p.elf.length, sha256: sha256(p.elf), loader: p.loader, programData: p.programData, lastDeploySlot: p.lastDeploySlot, upgradeAuthority: p.upgradeAuthority }
  console.log(`${name.padEnd(30)} ${id}  ${p.elf.length} bytes  deployed at slot ${p.lastDeploySlot ?? '-'}`)
}

// Global and config accounts the create / trade / sweep / collect / migrate / fee-sharing instructions read.
const global = L.readGlobal((await L.getAccount(X.GLOBAL)).data)
const ammGlobal = L.readGlobalConfig((await L.getAccount(X.AMM_GLOBAL_CONFIG)).data)
const ACCOUNTS = {
  pump_global: X.GLOBAL,
  pump_fee_config: X.PUMP_FEE_CONFIG,
  pump_global_volume_accumulator: X.GLOBAL_VOLUME_ACCUMULATOR,
  pump_quote_control: X.QUOTE_CONTROL,
  amm_global_config: X.AMM_GLOBAL_CONFIG,
  amm_fee_config: X.AMM_FEE_CONFIG,
  amm_global_volume_accumulator: X.AMM_GLOBAL_VOLUME_ACCUMULATOR,
  fees_program_global: L.pda(['fee-program-global'], L.PUMP_FEES),
  mayhem_global_params: X.MAYHEM_GLOBAL_PARAMS,
  mayhem_sol_vault: X.MAYHEM_SOL_VAULT,
  wsol_mint: L.WSOL,
  usdc_mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  rent_sysvar: 'SysvarRent111111111111111111111111111111111',
}
// Buyback recipients take part of the protocol fee in every trade and must exist: pump's are Pump Fees
// vault accounts, PumpSwap's are paid through their WSOL token accounts.
global.buybackFeeRecipients.forEach((k, i) => { ACCOUNTS[`pump_buyback_fee_recipient_${i}`] = k })
ammGlobal.buybackFeeRecipients.forEach((k, i) => {
  ACCOUNTS[`amm_buyback_fee_recipient_${i}`] = k
  ACCOUNTS[`amm_buyback_fee_recipient_${i}_wsol`] = L.ata(k, L.WSOL, L.TOKEN)
})

const labels = Object.keys(ACCOUNTS)
const fetched = await L.getAccounts(labels.map(l => ACCOUNTS[l]))
const seen = new Set()
for (const [i, a] of fetched.entries()) {
  const label = labels[i], pubkey = ACCOUNTS[label]
  if (!a) { manifest.accounts[label] = { pubkey, missing: true }; console.log(`${label.padEnd(36)} ${pubkey}  (does not exist)`); continue }
  manifest.accounts[label] = { pubkey, owner: a.owner, bytes: a.data.length, file: `accounts/${pubkey}.json` }
  if (seen.has(pubkey)) continue
  seen.add(pubkey)
  writeFileSync(join(out, 'accounts', `${pubkey}.json`), JSON.stringify(toJson(a), null, 1) + '\n')
  console.log(`${label.padEnd(36)} ${pubkey}  ${a.data.length} bytes, owner ${a.owner}`)
}

// IDLs pinned to a commit of pump-fun/pump-public-docs, for declare_program! and for decoding in tests.
for (const name of ['pump', 'pump_amm', 'pump_fees']) {
  const url = `https://raw.githubusercontent.com/pump-fun/pump-public-docs/${IDL_COMMIT}/idl/${name}.json`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  const body = Buffer.from(await res.arrayBuffer())
  const idl = JSON.parse(body)
  if (idl.address !== PROGRAMS[name]) throw new Error(`${name}.json has address ${idl.address}`)
  writeFileSync(join(out, 'idl', `${name}.json`), body)
  manifest.idl[name] = { file: `idl/${name}.json`, source: url, sha256: sha256(body) }
  console.log(`idl/${name}.json  ${body.length} bytes`)
}

writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n')
console.log(`wrote ${out} at slot ${slot}`)
