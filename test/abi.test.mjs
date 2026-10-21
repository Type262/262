import { encodeFunctionData, parseAbi, encodeAbiParameters } from 'viem'
// The app's hand-rolled ABI encoder/decoder (assets/abi.js) must agree with viem byte for byte.
import assert from 'node:assert/strict'
import { encodeCall, SEL, decodeLaunches, decodeLaunch, decodeString } from '../assets/abi.js'
const TP = ['string', 'string', 'string', 'string', ['string', 'string', 'string', 'string', 'string'], 'address', 'uint16', 'bool', 'bytes32', 'bytes32']
const abi = parseAbi([
  'struct Socials { string twitter; string telegram; string discord; string website; string farcaster; }',
  'struct TokenParams { string name; string symbol; string logo; string description; Socials socials; address creatorFeeRecipient; uint16 creatorTaxBps; bool buybackEnabled; bytes32 expectedEconomics; bytes32 salt; }',
  'function launch(string domain, TokenParams params, uint256 launchConfigId, address pairToken, uint256 openingBuy, uint256 minTokensOut)',
  'function collect(string domain, address[] curves, address[] tokens)',
  'function launchesOf(string domain, uint256 offset, uint256 limit) view returns (Launch[])',
  'struct Launch { address token; address curve; address launcher; address pairToken; uint64 launchedAt; string domain; }',
  'function recent(uint256,uint256) view returns (Launch[])',
])
const econ = '0xa9fc75d4203a33fe660e8fa32c74c3aa41c1fda4bf23d3a39b6bc22a1f8b1ca7', salt = '0x' + 'ab'.repeat(32)
const p = ['Your Site ✦', 'SITE', 'ipfs://bafy', 'émoji 🚀 desc', ['https://x.com/a', '', '', 'https://yoursite.com', ''], '0x0000000000000000000000000000000000000000', 250, false, econ, salt]
const mine = encodeCall(SEL.launch, ['string', TP, 'uint256', 'address', 'uint256', 'uint256'], ['yoursite.com', p, 0, '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', 10n ** 16n, 123n])
const ref = encodeFunctionData({ abi, functionName: 'launch', args: ['yoursite.com', { name: p[0], symbol: p[1], logo: p[2], description: p[3], socials: { twitter: p[4][0], telegram: '', discord: '', website: p[4][3], farcaster: '' }, creatorFeeRecipient: p[5], creatorTaxBps: 250, buybackEnabled: false, expectedEconomics: econ, salt }, 0n, '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', 10n ** 16n, 123n] })
assert.equal(mine, ref, 'launch() calldata')
const c1 = encodeCall(SEL.collect, ['string', 'address[]', 'address[]'], ['a.com', ['0x1111111111111111111111111111111111111111'], ['0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168']])
const c2 = encodeFunctionData({ abi, functionName: 'collect', args: ['a.com', ['0x1111111111111111111111111111111111111111'], ['0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168']] })
assert.equal(c1, c2, 'collect() calldata')
assert.equal(encodeCall(SEL.launchesOf, ['string', 'uint256', 'uint256'], ['a.com', 0, 60]), encodeFunctionData({ abi, functionName: 'launchesOf', args: ['a.com', 0n, 60n] }), 'launchesOf() paged calldata')
const launches = [
  { token: '0x1111111111111111111111111111111111111111', curve: '0x2222222222222222222222222222222222222222', launcher: '0x3333333333333333333333333333333333333333', pairToken: '0x0000000000000000000000000000000000000000', launchedAt: 1792540000n, domain: 'yoursite.com' },
  { token: '0x4444444444444444444444444444444444444444', curve: '0x5555555555555555555555555555555555555555', launcher: '0x3333333333333333333333333333333333333333', pairToken: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', launchedAt: 1792540001n, domain: 'a-much-longer-domain-name-for-testing-padding.example.org' },
]
const ret = encodeAbiParameters([{ type: 'tuple[]', components: abi.find(x => x.name === 'recent').outputs[0].components }], [launches])
const dec = decodeLaunches(ret)
assert.deepEqual(dec, launches.map(l => ({ ...l, pairToken: l.pairToken.toLowerCase(), launchedAt: Number(l.launchedAt) })), 'recent() decode')
assert.equal(decodeString(encodeAbiParameters([{ type: 'string' }], ['Robinhood ✦'])), 'Robinhood ✦')
assert.deepEqual(decodeLaunches(encodeAbiParameters([{ type: 'tuple[]', components: abi.find(x => x.name === 'recent').outputs[0].components }], [[]])), [])
assert.deepEqual(decodeLaunch(encodeAbiParameters([{ type: 'tuple', components: abi.find(x => x.name === 'recent').outputs[0].components }], [launches[1]])), dec[1], 'launchOf() decode')
console.log('abi: 5 checks passed (launch, collect, recent, launchOf, string)')
