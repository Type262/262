// Turn Foundry's broadcast log into a small, committed record of what was deployed where.
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const run = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const created = run.transactions.filter(t => t.transactionType === 'CREATE')
const contracts = Object.fromEntries(created.map(t => [t.contractName, t.contractAddress]))
const receipts = run.receipts || []
let commit = 'unknown'
try { commit = execSync('git rev-parse --short HEAD').toString().trim() } catch {}

console.log(JSON.stringify({
  network: 'Robinhood Chain',
  chainId: run.chain,
  deployedAt: new Date(run.timestamp > 1e12 ? run.timestamp : run.timestamp * 1000).toISOString(),
  commit,
  contracts,
  transactions: created.map(t => ({ contract: t.contractName, hash: t.hash })),
  blocks: receipts.map(r => parseInt(r.blockNumber, 16)),
  config: {
    admin: process.env.OWNER,
    feeRecipient: process.env.FEE_RECIPIENT,
    feeBps: Number(process.env.FEE_BPS || 50),
    refundDelaySeconds: Number(process.env.REFUND_DELAY || 15552000),
  },
}, null, 2))
