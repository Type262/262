// The board and profiles decode raw escrow/launcher logs by hand; check every decoder against viem's encoding
// of the real event signatures, then read the live mainnet escrow once.
import assert from 'node:assert/strict'
import { encodeAbiParameters, encodeEventTopics, parseAbi } from 'viem'
import { decode, activity, waiting, CHAIN } from '../assets/chain-data.js'

const abi = parseAbi([
  'event Deposited(bytes32 indexed domainHash, string domain, address indexed token, address indexed from, uint256 amount)',
  'event Claimed(bytes32 indexed domainHash, address indexed token, address indexed recipient, uint256 amount, uint256 fee)',
  'event Refunded(bytes32 indexed domainHash, address indexed token, address indexed depositor, uint256 amount)',
  'event DomainTokenLaunched(bytes32 indexed domainHash, string domain, address indexed token, address indexed curve, address launcher, address pairToken)',
])
const H = '0x' + 'ab'.repeat(32)
const A = '0x1111111111111111111111111111111111111111'
const B = '0x2222222222222222222222222222222222222222'
const log = (eventName, args, data) => ({ topics: encodeEventTopics({ abi, eventName, args }), data, blockNumber: '0x10', transactionHash: '0x' + '0'.repeat(64), logIndex: '0x1' })
let checks = 0
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++ }

const domain = 'a-really-long-subdomain-name.yoursite-example.com'
const d = decode.deposit(log('Deposited', { domainHash: H, token: A, from: B }, encodeAbiParameters([{ type: 'string' }, { type: 'uint256' }], [domain, 25_000_000n])))
eq([d.domain, d.token, d.from, d.amount, d.hash, d.block], [domain, A, B, 25_000_000n, H, 16], 'Deposited')

const c = decode.claim(log('Claimed', { domainHash: H, token: A, recipient: B }, encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [995n, 5n])))
eq([c.token, c.to, c.amount, c.fee], [A, B, 995n, 5n], 'Claimed')

const r = decode.refund(log('Refunded', { domainHash: H, token: A, depositor: B }, encodeAbiParameters([{ type: 'uint256' }], [7n])))
eq([r.token, r.from, r.amount], [A, B, 7n], 'Refunded')

const l = decode.launch(log('DomainTokenLaunched', { domainHash: H, token: A, curve: B }, encodeAbiParameters([{ type: 'string' }, { type: 'address' }, { type: 'address' }], ['yoursite.com', B, A])))
eq([l.domain, l.token, l.curve, l.launcher, l.pairToken], ['yoursite.com', A, B, B, A], 'DomainTokenLaunched')

// live read of the mainnet escrow (read-only)
if (CHAIN.escrow) {
  const a = await activity()
  assert.ok(a.head > CHAIN.fromBlock, 'head block'); checks++
  const w = await waiting(['yoursite.com'])
  assert.ok(typeof w.get('yoursite.com').usdg === 'bigint', 'balanceOf read'); checks++
  console.log(`chain-data: ${checks} checks passed (mainnet: ${a.deposits.length} deposits, ${a.launches.length} launches)`)
} else console.log(`chain-data: ${checks} checks passed`)
