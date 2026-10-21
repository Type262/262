// Tests for the vault rules (upload/vault.mjs): key derivation, canonical domains, the fee, what DNS must say,
// which addresses can be paid, what counts as a deposit, and memos. Offline. Run: node test/vault.test.mjs
import assert from 'node:assert/strict'
import { createHash, createPublicKey, verify } from 'node:crypto'
import { inspect } from 'node:util'
import { encodeWalletRdata, resolveWallets } from '../lib/wallet262.js'
import { SYSTEM, TOKEN, TOKEN_2022, b58decode, b58encode } from '../upload/pump.mjs'
import * as V from '../upload/vault.mjs'

// A throwaway master secret (bytes 0..31), used only here.
const MASTER = Buffer.from([...Array(32).keys()])
const addr = label => b58encode(createHash('sha256').update(label).digest())
const verifyWith = (address, message, signature) => verify(null, Buffer.from(message), createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: b58decode(address).toString('base64url') }, format: 'jwk' }), Buffer.from(signature))

const tests = {
  'RFC 8032 test 1: the seed-to-key step is standard Ed25519': () => {
    const kp = V.keypairFromSeed(Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex'))
    assert.equal(b58decode(kp.address).toString('hex'), 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a')
    // Ed25519 is deterministic: the RFC's signature of the empty message.
    assert.equal(Buffer.from(kp.sign(new Uint8Array(0))).toString('hex'), 'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b')
  },
  'derivation vectors (HMAC checked with openssl, keys with solana-keygen / ed25519-dalek)': () => {
    // seed = HMAC-SHA256(master, "type262:vault:example.com") = 49f25787...e150e2
    assert.equal(V.vaultKeypair(MASTER, 'example.com').address, '2dGV8mm5coiXgXATUaBUatv55hHctzJFtZ6V8PyFkjuH')
    assert.equal(V.vaultKeypair(MASTER, V.canonicalDomain('Bücher.Example')).address, '827MYNwnKqpMccmsK5beJF1zY6grRnL5az2Tp1mQbZRE')
    // seed = HMAC-SHA256(master, "type262:gas") = 03cdead0...f0af33
    assert.equal(V.gasKeypair(MASTER).address, 'Ft2NCKQvC744yELosSfm3uZjXYaA7snFXJT3D5wfTRmG')
    assert.equal(V.vaultMessage('example.com'), 'type262:vault:example.com')
    assert.equal(V.GAS_MESSAGE, 'type262:gas')
  },
  'derivation: deterministic, per domain, per master, and it signs': () => {
    const a = V.vaultKeypair(MASTER, 'example.com')
    assert.equal(V.vaultKeypair(MASTER, 'example.com').address, a.address)
    assert.notEqual(V.vaultKeypair(MASTER, 'example.org').address, a.address)
    assert.notEqual(V.vaultKeypair(Buffer.alloc(32, 7), 'example.com').address, a.address)
    assert.notEqual(V.gasKeypair(MASTER).address, a.address)
    const msg = Buffer.from('message')
    assert.ok(verifyWith(a.address, msg, a.sign(msg)))
  },
  'derivation: the private key never shows': () => {
    const kp = V.vaultKeypair(MASTER, 'example.com')
    const seedHex = '49f25787286ede4d3e25d2607ce2094eddd62ff8bebe924bb43d61644fe150e2'
    const seedB64 = Buffer.from(seedHex, 'hex').toString('base64')
    for (const shown of [JSON.stringify(kp), String(kp), inspect(kp, { showHidden: true, depth: 10 }), JSON.stringify({ kp })]) {
      assert.ok(!shown.includes(seedHex) && !shown.includes(seedB64) && !shown.includes(MASTER.toString('hex')), shown)
    }
    assert.deepEqual(JSON.parse(JSON.stringify(kp)), { address: kp.address })
    assert.throws(() => { kp.address = 'x' })
  },
  'master secret: 64 hex characters, and errors never echo it': () => {
    assert.equal(V.parseMasterSeed('ab'.repeat(32)).length, 32)
    assert.equal(V.parseMasterSeed(` ${'AB'.repeat(32)}\n`).toString('hex'), 'ab'.repeat(32))
    for (const bad of ['', 'ab'.repeat(31), 'ab'.repeat(33), 'zz'.repeat(32), undefined]) {
      assert.throws(() => V.parseMasterSeed(bad), err => !String(err.message).includes(String(bad)) || !bad)
    }
  },
  'canonical domains: the SDK normalizer plus the escrow label rules': () => {
    for (const [input, want] of [
      ['Example.COM', 'example.com'], ['example.com.', 'example.com'], ['https://Example.com/path?x=1', 'example.com'],
      ['  shop.example.co.uk ', 'shop.example.co.uk'], ['Bücher.example', 'xn--bcher-kva.example'], ['_wallet.example.com', '_wallet.example.com'],
      ['a-b_c.example', 'a-b_c.example'],
    ]) assert.equal(V.canonicalDomain(input), want, input)
    for (const bad of ['', '   ', 'localhost', 'not a domain', 'exa mple.com', '-', 'a'.repeat(64) + '.com', `${'a.'.repeat(130)}com`, 42, null, undefined, 'x'.repeat(301)]) {
      assert.throws(() => V.canonicalDomain(bad), err => err.refusal && err.status === 400, String(bad))
    }
  },
  'fee: basis points of each asset, rounded down, never negative': () => {
    assert.equal(V.feeOf(10_000n, 50), 50n)
    assert.equal(V.feeOf(3_750_000_000n, 50), 18_750_000n)
    assert.equal(V.feeOf(350_500000n, 50), 1_752500n)
    assert.equal(V.feeOf(199n, 50), 0n) // dust pays no fee
    assert.equal(V.feeOf(200n, 50), 1n)
    assert.equal(V.feeOf(0n, 50), 0n)
    assert.equal(V.feeOf(12345n, 0), 0n)
    assert.equal(V.feeOf(2n ** 64n - 1n, 50), (2n ** 64n - 1n) * 50n / 10_000n) // no overflow on u64 balances
    for (let i = 0; i < 1000; i++) {
      const a = BigInt(Math.floor(Math.random() * 1e12))
      const f = V.feeOf(a, 50)
      assert.ok(f >= 0n && f * 200n <= a && (f + 1n) * 200n > a, String(a))
    }
  },
}

// ---------- DNS ----------

const OWNER = '9jB2PjvwWUUAZHfo3D5eLpc7Vc9z64pBxRwKvtG9F8ke'
const OTHER = '2CKCmAySAMhPcxLXWy2FNCPEG2RYwNu7p3EtMJGegToe'
const RESOLVERS = ['https://cf.test/dns-query', 'https://g.test/resolve']

/** resolveWallets against two stub resolvers: answers[i] maps "name|type" to { data, ad } or { status } or 'down'. */
function dns(domain, answers) {
  const fetch = async url => {
    const u = new URL(url)
    const i = RESOLVERS.findIndex(r => url.startsWith(r))
    const a = answers[i]
    if (a === 'down') return new Response('', { status: 503 })
    const key = `${u.searchParams.get('name')}|${u.searchParams.get('type')}`
    const hit = a[key]
    const body = { Status: hit && hit.status !== undefined ? hit.status : 0, AD: hit ? !!hit.ad : true, Answer: hit && hit.data ? [].concat(hit.data).map(data => ({ name: u.searchParams.get('name'), type: Number(u.searchParams.get('type')), data })) : undefined }
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/dns-json' } })
  }
  return resolveWallets(domain, { fetch, resolvers: RESOLVERS })
}
const txt = (domain, data, ad = true) => ({ [`_wallet.${domain}|16`]: { data: `"${data}"`, ad } })
const wallet = (domain, code, address, ad = true) => ({ [`${domain}|262`]: { data: encodeWalletRdata(code, address).generic, ad } })

Object.assign(tests, {
  'DNS: a _wallet TXT SOL record, signed and agreed by both resolvers': async () => {
    assert.equal(V.solWalletFrom(await dns('example.com', [txt('example.com', `SOL ${OWNER}`), txt('example.com', `SOL ${OWNER}`)])), OWNER)
  },
  'DNS: a WALLET (type 262) record works the same, and both kinds may agree': async () => {
    assert.equal(V.solWalletFrom(await dns('example.com', [wallet('example.com', 'SOL', OWNER), wallet('example.com', 'sol', OWNER)])), OWNER)
    const both = { ...wallet('example.com', 'SOL', OWNER), ...txt('example.com', `SOL ${OWNER}`) }
    assert.equal(V.solWalletFrom(await dns('example.com', [both, both])), OWNER)
  },
  'DNS: other coins are ignored when a SOL address is there': async () => {
    const a = { '_wallet.example.com|16': { data: [`"ETH 0x${'ab'.repeat(20)}"`, `"SOL ${OWNER}"`], ad: true } }
    assert.equal(V.solWalletFrom(await dns('example.com', [a, a])), OWNER)
  },
  'DNS: refused without DNSSEC on either resolver': async () => {
    for (const ads of [[false, true], [true, false], [false, false]]) {
      const res = await dns('example.com', ads.map(ad => txt('example.com', `SOL ${OWNER}`, ad)))
      assert.throws(() => V.solWalletFrom(res), e => e.error === 'DNS check failed' && /DNSSEC/.test(e.reason))
    }
  },
  'DNS: refused when a resolver does not answer': async () => {
    assert.throws(() => V.solWalletFrom({ domain: 'example.com', resolvers: [{ resolver: 'cloudflare', ok: true, records: [{ code: 'SOL', address: OWNER, dnssec: true }] }] }), e => e.error === 'DNS check failed')
    const res = await dns('example.com', [txt('example.com', `SOL ${OWNER}`), 'down'])
    assert.throws(() => V.solWalletFrom(res), e => e.error === 'DNS check failed' && /did not answer/.test(e.reason))
  },
  'DNS: refused when the resolvers disagree': async () => {
    const res = await dns('example.com', [txt('example.com', `SOL ${OWNER}`), txt('example.com', `SOL ${OTHER}`)])
    assert.throws(() => V.solWalletFrom(res), e => e.error === 'DNS check failed' && /disagree/.test(e.reason))
  },
  'DNS: refused with no SOL record, two SOL addresses, or a SOL record that is not a Solana address': async () => {
    const refuses = async (answer, error, re = /./) => {
      const res = await dns('example.com', [answer, answer])
      assert.throws(() => V.solWalletFrom(res), e => e.refusal && e.error === error && re.test(e.reason))
    }
    await refuses({}, 'No SOL wallet in DNS')
    await refuses(txt('example.com', `ETH 0x${'ab'.repeat(20)}`), 'No SOL wallet in DNS')
    await refuses({ '_wallet.example.com|16': { data: [`"SOL ${OWNER}"`, `"SOL ${OTHER}"`], ad: true } }, 'Bad SOL record', /more than one/)
    await refuses(txt('example.com', `SOL 0x${'ab'.repeat(20)}`), 'Bad SOL record', /not a Solana address/)
    await refuses({ '_wallet.example.com|16': { status: 3 }, 'example.com|262': { status: 3 } }, 'No SOL wallet in DNS')
    await refuses({ '_wallet.example.com|16': { status: 2 }, 'example.com|262': { status: 2 } }, 'No SOL wallet in DNS', /could not validate/)
  },
})

// ---------- recipients ----------

Object.assign(tests, {
  'recipients: a new wallet or a system account with no data': () => {
    assert.equal(V.recipientProblem(OWNER, null), '')
    assert.equal(V.recipientProblem(OWNER, { owner: SYSTEM, executable: false, lamports: 5, data: ['', 'base64'], space: 0 }), '')
  },
  'recipients: not a token account, a mint, a program, a nonce account, another program\'s account or the vault': () => {
    const data = n => [Buffer.alloc(n).toString('base64'), 'base64']
    const cases = [
      [{ owner: TOKEN, executable: false, data: data(165) }, /token account/],
      [{ owner: TOKEN_2022, executable: false, data: data(170) }, /token account/],
      [{ owner: TOKEN, executable: false, data: data(82) }, /token mint/],
      [{ owner: 'BPFLoaderUpgradeab1e11111111111111111111111', executable: true, data: data(36) }, /program/],
      [{ owner: SYSTEM, executable: false, data: data(80) }, /nonce/],
      [{ owner: addr('some program'), executable: false, data: data(10) }, /program/],
    ]
    for (const [info, re] of cases) assert.match(V.recipientProblem(OWNER, info), re)
    assert.match(V.recipientProblem(OWNER, null, { vault: OWNER }), /own vault/)
    assert.match(V.recipientProblem('0xabc', null), /not a Solana address/)
  },
})

// ---------- deposits ----------

const VAULT = addr('vault')
const ALICE = addr('alice')
const BOB = addr('bob')
const MINT = addr('mint')
const VAULT_ATA = addr('vault ata')
const ALICE_ATA = addr('alice ata')
const SIG = b58encode(Buffer.alloc(64, 9))

function parsedTx({ signers = [ALICE], keys = [], ixs = [], inner = [], pre = [], post = [], err = null }) {
  const all = [...new Set([...signers, ...keys])]
  return {
    slot: 1234, blockTime: 1_760_000_000,
    meta: { err, innerInstructions: inner, preTokenBalances: pre, postTokenBalances: post },
    transaction: { message: { accountKeys: all.map(pubkey => ({ pubkey, signer: signers.includes(pubkey), writable: true, source: 'transaction' })), instructions: ixs } },
  }
}
const solIx = (source, destination, lamports) => ({ program: 'system', programId: SYSTEM, parsed: { type: 'transfer', info: { source, destination, lamports } } })
const tokIx = (source, destination, amount, authority, program = 'spl-token') => ({ program, programId: program === 'spl-token' ? TOKEN : TOKEN_2022, parsed: { type: 'transferChecked', info: { source, mint: MINT, destination, authority, tokenAmount: { amount: String(amount), decimals: 6 } } } })
const bal = (index, owner, amount) => ({ accountIndex: index, mint: MINT, owner, programId: TOKEN, uiTokenAmount: { amount: String(amount), decimals: 6 } })

Object.assign(tests, {
  'deposit: a SOL transfer to the vault': () => {
    const d = V.depositOf(parsedTx({ keys: [VAULT, SYSTEM], ixs: [solIx(ALICE, VAULT, 1_500_000_000)] }), VAULT)
    assert.deepEqual([d.mint, d.amount, d.from, d.account, d.program, d.slot, d.blockTime], ['SOL', 1_500_000_000n, ALICE, VAULT, SYSTEM, 1234, 1_760_000_000])
  },
  'deposit: two transfers from the same sender add up; a transfer made inside a program (inner) counts': () => {
    const d = V.depositOf(parsedTx({ keys: [VAULT], ixs: [solIx(ALICE, VAULT, 1), { programId: addr('p'), accounts: [], data: '' }], inner: [{ index: 1, instructions: [solIx(ALICE, VAULT, 2)] }] }), VAULT)
    assert.equal(d.amount, 3n)
  },
  'deposit: a token transfer into a token account the vault owns; the sender is the source\'s owner': () => {
    // keys: alice(0), alice ata(1), vault ata(2), mint(3), vault(4)
    const tx = parsedTx({ keys: [ALICE_ATA, VAULT_ATA, MINT, VAULT], ixs: [tokIx(ALICE_ATA, VAULT_ATA, 250_000000, ALICE)], pre: [bal(1, ALICE, 1000_000000)], post: [bal(1, ALICE, 750_000000), bal(2, VAULT, 250_000000)] })
    const d = V.depositOf(tx, VAULT)
    assert.deepEqual([d.mint, d.amount, d.from, d.account, d.program, d.decimals], [MINT, 250_000000n, ALICE, VAULT_ATA, TOKEN, 6])
  },
  'deposit: a token with a transfer fee refunds what the vault received': () => {
    const tx = parsedTx({ keys: [ALICE_ATA, VAULT_ATA, MINT, VAULT], ixs: [tokIx(ALICE_ATA, VAULT_ATA, 1000, ALICE, 'spl-token-2022')], pre: [bal(1, ALICE, 1000), bal(2, VAULT, 50)], post: [bal(1, ALICE, 0), bal(2, VAULT, 1040)] })
    const d = V.depositOf(tx, VAULT)
    assert.deepEqual([d.amount, d.program], [990n, TOKEN_2022])
  },
  'deposit: a board-tagged deposit (reference after the owner, so the RPC names it multisigAuthority, plus a memo) is still a deposit from its sender': () => {
    // The app's deposits carry the board reference (assets/solana-vault.js withReference) and a "TYPE/262 deposit" memo.
    const REF = addr('board reference')
    const memoIx = text => ({ program: 'spl-memo', programId: addr('memo'), parsed: text })
    const tagged = { program: 'spl-token', programId: TOKEN, parsed: { type: 'transferChecked', info: { source: ALICE_ATA, mint: MINT, destination: VAULT_ATA, multisigAuthority: ALICE, signers: [REF], tokenAmount: { amount: '250000000', decimals: 6 } } } }
    const tx = parsedTx({ keys: [ALICE_ATA, VAULT_ATA, MINT, VAULT, REF], ixs: [tagged, memoIx('TYPE/262 deposit example.com')], pre: [bal(1, ALICE, 1000_000000)], post: [bal(1, ALICE, 750_000000), bal(2, VAULT, 250_000000)] })
    const d = V.depositOf(tx, VAULT)
    assert.deepEqual([d.mint, d.amount, d.from, d.account], [MINT, 250_000000n, ALICE, VAULT_ATA])
    // without a pre-balance for the source, the sender is still the multisigAuthority the RPC reports
    const bare = parsedTx({ keys: [ALICE_ATA, VAULT_ATA, MINT, VAULT, REF], ixs: [tagged], post: [bal(2, VAULT, 250_000000)] })
    assert.equal(V.depositOf(bare, VAULT).from, ALICE)
    // a tagged SOL transfer parses as a plain transfer: the RPC ignores the extra account
    const sol = V.depositOf(parsedTx({ keys: [VAULT, SYSTEM, REF], ixs: [solIx(ALICE, VAULT, 7_000_000), memoIx('TYPE/262 deposit example.com')] }), VAULT)
    assert.deepEqual([sol.mint, sol.amount, sol.from], ['SOL', 7_000_000n, ALICE])
  },
  'deposit: refused for the vault\'s own transactions, failed ones, other destinations, several senders or assets': () => {
    const no = (tx, error) => assert.throws(() => V.depositOf(tx, VAULT), e => e.refusal && e.error === error)
    no(parsedTx({ signers: [addr('gas'), VAULT], keys: [ALICE], ixs: [solIx(addr('gas'), VAULT, 5)] }), 'Not a deposit')
    no(parsedTx({ keys: [VAULT], ixs: [solIx(ALICE, VAULT, 5)], err: { InstructionError: [0, 'Custom'] } }), 'Not a deposit')
    no(parsedTx({ keys: [BOB], ixs: [solIx(ALICE, BOB, 5)] }), 'Not a deposit')
    no(parsedTx({ signers: [ALICE, BOB], keys: [VAULT], ixs: [solIx(ALICE, VAULT, 5), solIx(BOB, VAULT, 5)] }), 'Not a single deposit')
    const mixed = parsedTx({ keys: [ALICE_ATA, VAULT_ATA, MINT, VAULT], ixs: [solIx(ALICE, VAULT, 5), tokIx(ALICE_ATA, VAULT_ATA, 9, ALICE)], pre: [bal(1, ALICE, 9)], post: [bal(1, ALICE, 0), bal(2, VAULT, 9)] })
    no(mixed, 'Not a single deposit')
    // pump.fun's collect credits the vault without a system transfer: creator fees, not a deposit.
    no(parsedTx({ signers: [addr('gas')], keys: [VAULT, addr('pump')], ixs: [{ programId: addr('pump'), accounts: [VAULT], data: '' }] }), 'Not a deposit')
    // A token transfer into an account someone else owns.
    no(parsedTx({ keys: [ALICE_ATA, VAULT_ATA, MINT], ixs: [tokIx(ALICE_ATA, VAULT_ATA, 9, ALICE)], pre: [bal(1, ALICE, 9)], post: [bal(1, ALICE, 0), bal(2, BOB, 9)] }), 'Not a deposit')
    assert.throws(() => V.depositOf(null, VAULT), e => e.status === 404)
  },
  'signatures: 64 bytes of base58 only': () => {
    assert.equal(V.parseSignature(SIG), SIG)
    for (const bad of ['', 'nope', b58encode(Buffer.alloc(32, 1)), '0'.repeat(88), 42, null]) assert.throws(() => V.parseSignature(bad), e => e.status === 400)
  },
})

// ---------- memos ----------

const memoIx = text => ({ program: 'spl-memo', programId: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', parsed: text })

Object.assign(tests, {
  'memos: the claim and refund texts': () => {
    assert.equal(V.claimMemo('example.com'), 'type262:claim:example.com')
    assert.equal(V.refundMemo(SIG), `type262:refund:${SIG}`)
  },
  'memos: only a successful transaction the vault signed, with exactly that text, counts': () => {
    const claim = V.claimMemo('example.com')
    assert.ok(V.vaultSignedWithMemo(parsedTx({ signers: [addr('gas'), VAULT], ixs: [memoIx(claim)] }), VAULT, claim))
    assert.ok(V.vaultSignedWithMemo(parsedTx({ signers: [addr('gas'), VAULT], ixs: [{ programId: addr('p'), accounts: [], data: '' }], inner: [{ index: 0, instructions: [memoIx(claim)] }] }), VAULT, claim))
    // Anyone can write the same memo into a transaction that only mentions the vault.
    assert.ok(!V.vaultSignedWithMemo(parsedTx({ signers: [ALICE], keys: [VAULT], ixs: [memoIx(claim), solIx(ALICE, VAULT, 1)] }), VAULT, claim))
    assert.ok(!V.vaultSignedWithMemo(parsedTx({ signers: [addr('gas'), VAULT], ixs: [memoIx(claim)], err: { InstructionError: [0, 'Custom'] } }), VAULT, claim))
    assert.ok(!V.vaultSignedWithMemo(parsedTx({ signers: [addr('gas'), VAULT], ixs: [memoIx(V.claimMemo('xexample.com'))] }), VAULT, claim))
    assert.ok(!V.vaultSignedWithMemo(parsedTx({ signers: [addr('gas'), VAULT], ixs: [memoIx(`${claim}.evil`)] }), VAULT, claim))
    assert.ok(!V.vaultSignedWithMemo(null, VAULT, claim))
  },
})

let passed = 0
for (const [name, fn] of Object.entries(tests)) {
  try { await fn(); passed++ } catch (err) { console.error(`FAIL ${name}\n`, err); process.exitCode = 1 }
}
console.log(`vault: ${passed}/${Object.keys(tests).length} passed`)
