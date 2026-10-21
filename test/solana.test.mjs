// Tests for the browser Solana client (assets/solana.js). Run: node test/solana.test.mjs
// Offline: base58, the on-curve check, ATA derivation and byte-exact messages against two mainnet transactions.
// Online (skipped with OFFLINE=1 or when mainnet can't be reached): the USDC mint and a wallet's USDC account.
import assert from 'node:assert/strict'
import * as sol from '../assets/solana.js'

const USDC = sol.USDC.mint
// Mainnet 9KNTbZyrqyJASXX7xLy2BKGvhPH6z2ZNVt1WNJjE7oFuGGgVUHNFiZLqBPsGdaZug4D5gUwQuAVdLXsbaKShusU:
// createAssociatedTokenAccountIdempotent + transferChecked of 0.308977 USDC.
const USDC_TX = {
  b64: 'AgcsCfNP1Zi8POU1b0PDnj9cdrPMwTE6sxXbrrVbbanU7B7D+/fPKWoDo8nR9A0NpwfvwY6BolxAm75GaGB5dg/10oyJQ4VH15GAcqJxc0Y3CxnB8dnZcIAsqAZN7ilkP3s6lp3I3+8aSWTYs+ySfC7gUeVx0hovTkHFzTn8dlsKAgEFCaxszJWwGMZC66h9OLPct3rYdZVXdlajg7JYo8i74H2jQY3evkqvUCmFMWsF7PqQcKO2abbdR+rgox0RhBetgheH7jtjBg3miCCYdUNL2ftE8B+9fE4s+/3IxylzFR/dHFGJ5s+vXm2n4d2qSAG4y+SBrDH7yhC5NWEO4z37++7XjJclj04kifG7PRApFI4NgwtaE5na/xCEBI572Nvp+FnD6H3GJuWK8Goz+tL+/dXkHzvsdZzNaB4jQvAnAMRwzMb6evO+2606PWXzaqvJdDGxu+TC0vbg5HymAgNFL11hAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAG3fbh12Whk9nL4UbO63msHLSF7V9bN5E6jPWFfv8Aqfz05R6r3un0hVQvCNgCRg4LlJcHc1yzGtgoFMaeS6k3AgQGAAIFBgcIAQEIBAMGAgEKDPG2BAAAAAAABg==',
  payer: 'Cc5M6mecyBKjdrjnvreuANqhMBdLeU7RZNzoSEh2Rnfc',
  authority: '5QtyKPHtWUf45bNb5buQ6UxpL2ekSJxBCK9g8xMCsc9U',
  source: '6VHz6WyCN1GuAQBvPn8AVorzRqwsHh91DDovQ5SUHhT4',
  wallet: 'EBk7pSomiBbHe21WFEWGN6UvkXPrAyymNm95gjiEAKwq',
  ata: 'A9cjW2ttReS2mHDr2CpTBb4MyokrknhfGKmFNcMPWVj1',
  blockhash: 'J2SKvPPiTuuGLYor8aW5NyFfFL89LWh4dwbayz9dM4UE',
  amount: 308977n,
}
// Mainnet 3fob6UiczXTrkxAEmuT2g34yk9X97hjRLFzZLWZ1QMQ9K7MrxUVSjDnwyPAuv87UZkxY35SHKaTM6i2U7Y2C9hTn: 5 SOL system transfer.
const SOL_TX = {
  b64: 'AYV/Fnqs8R5S2NZe1OlHEAlvcxJ9Njby8bM3Z1vtZYoQGSv0BDMGA+WePY3wwXjNaIdo8N9v2JCERrgJqmAwbAEBAAEDOD7YTAuEh3qOTIkH0D/V+JG4UFH638LnODpQHVxgawkrpF1LAoGsI2slaZHQtJTQDq4u5NcOap0p6yvoYrMdxwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC83GLz07/igvakOR68QIyKEtwRYzAYkhwiPsWtJDwUIBAgIAAQwCAAAAAPIFKgEAAAA=',
  from: '4nZQs4JpDpR1oDzB49bXZcgPYMv4iiyh1CjyJvadEZyr',
  to: '3wMtxFgBReZRovpQ8WUozBtGaVpgjHoRE8PbcgJbmwdg',
  blockhash: 'o5UQ6p9qVPE8hX4x9PqMeY356aVxcVxP4Z1ngKkFYxH',
  lamports: 5_000_000_000n,
}
/** The message bytes of a signed wire transaction (skips the signature list). */
const messageOf = b64 => { const tx = sol.base64Decode(b64); return tx.slice(1 + 64 * tx[0]) }
const hex = b => Buffer.from(b).toString('hex')

const tests = {
  'base58 roundtrip and leading zeros': () => {
    assert.deepEqual(sol.base58Decode(sol.SYSTEM_PROGRAM), new Uint8Array(32))
    assert.equal(sol.base58Encode(new Uint8Array(32)), sol.SYSTEM_PROGRAM)
    assert.equal(sol.base58Encode(Uint8Array.of(0, 0, 1)), '112')
    for (const a of [USDC, sol.TOKEN_PROGRAM, sol.ATA_PROGRAM, USDC_TX.wallet]) assert.equal(sol.base58Encode(sol.base58Decode(a)), a)
    assert.throws(() => sol.base58Decode('0OIl'), /base58/)
    assert.throws(() => sol.pubkeyBytes('abc'), /Not a Solana address/)
    assert.equal(sol.isAddress(USDC), true)
    assert.equal(sol.isAddress('0x7a1fe1c2b0d3a4f5e6d7c8b9a0f1e2d3c4b5c0de'), false)
  },
  'on-curve: signers yes, token accounts no': () => {
    for (const a of [USDC_TX.payer, USDC_TX.authority, SOL_TX.from]) assert.equal(sol.isOnCurve(sol.pubkeyBytes(a)), true, a)
    for (const a of [USDC_TX.ata, USDC_TX.source]) assert.equal(sol.isOnCurve(sol.pubkeyBytes(a)), false, a)
  },
  'associated token account matches mainnet': async () => {
    assert.equal(await sol.associatedTokenAddress(USDC_TX.wallet, USDC), USDC_TX.ata)
    assert.equal(await sol.associatedTokenAddress(USDC_TX.authority, USDC), USDC_TX.source)
  },
  'findProgramAddress returns an off-curve address and its bump': async () => {
    const [a, bump] = await sol.findProgramAddress([sol.pubkeyBytes(USDC_TX.wallet), sol.pubkeyBytes(sol.TOKEN_PROGRAM), sol.pubkeyBytes(USDC)], sol.ATA_PROGRAM)
    assert.equal(a, USDC_TX.ata)
    assert.ok(bump >= 0 && bump <= 255)
    assert.equal(await sol.createProgramAddress([sol.pubkeyBytes(USDC_TX.wallet), sol.pubkeyBytes(sol.TOKEN_PROGRAM), sol.pubkeyBytes(USDC), [bump]], sol.ATA_PROGRAM), a)
    await assert.rejects(sol.createProgramAddress(['x'.repeat(33)], sol.ATA_PROGRAM), /32 bytes/)
  },
  'SOL transfer message is byte-exact with mainnet': () => {
    const m = sol.compileMessage({ payer: SOL_TX.from, recentBlockhash: SOL_TX.blockhash, instructions: [sol.systemTransfer(SOL_TX.from, SOL_TX.to, SOL_TX.lamports)] })
    assert.deepEqual(m.header, [1, 0, 1])
    assert.equal(hex(sol.serializeMessage(m)), hex(messageOf(SOL_TX.b64)))
  },
  'USDC transfer message is byte-exact with mainnet': () => {
    const T = USDC_TX
    const m = sol.compileMessage({
      payer: T.payer, recentBlockhash: T.blockhash,
      instructions: [
        sol.createAssociatedTokenAccountIdempotent({ payer: T.payer, ata: T.ata, owner: T.wallet, mint: USDC }),
        sol.transferChecked({ source: T.source, mint: USDC, destination: T.ata, owner: T.authority, amount: T.amount, decimals: 6 }),
      ],
    })
    assert.deepEqual(m.header, [2, 1, 5])
    assert.equal(hex(sol.serializeMessage(m)), hex(messageOf(T.b64)))
  },
  'unsigned transaction has one empty slot per signer': () => {
    const msg = messageOf(USDC_TX.b64)
    const tx = sol.unsignedTransaction(msg)
    assert.equal(tx[0], 2)
    assert.deepEqual(tx.slice(1, 129), new Uint8Array(128))
    assert.deepEqual(tx.slice(129), msg)
  },
  'amounts out of range are refused': () => {
    assert.throws(() => sol.systemTransfer(SOL_TX.from, SOL_TX.to, -1n), /range/)
    assert.throws(() => sol.systemTransfer(SOL_TX.from, SOL_TX.to, 1n << 64n), /range/)
  },
  'wallet standard: register, connect, sign and send, confirm': async () => {
    // A minimal browser: a window that dispatches events, and a stub RPC.
    const win = new EventTarget()
    win.navigator = {}
    globalThis.window = win
    const realFetch = globalThis.fetch
    const calls = []
    globalThis.fetch = async (url, init) => {
      const { method, params } = JSON.parse(init.body)
      calls.push({ url, method, params })
      const result = method === 'getLatestBlockhash' ? { value: { blockhash: SOL_TX.blockhash, lastValidBlockHeight: 100 } }
        : method === 'getSignatureStatuses' ? { value: [{ confirmationStatus: 'confirmed', err: null }] } : null
      return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result }) }
    }
    let signed
    const account = { address: SOL_TX.from, publicKey: sol.pubkeyBytes(SOL_TX.from), chains: ['solana:mainnet'], features: [] }
    const wallet = {
      name: 'Phantom', icon: 'data:image/svg+xml,', version: '1.0.0', chains: ['solana:mainnet'], accounts: [],
      features: {
        'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [account] }) },
        'standard:events': { version: '1.0.0', on: () => () => {} },
        'solana:signAndSendTransaction': { version: '1.0.0', signAndSendTransaction: async input => { signed = input; return [{ signature: new Uint8Array(64).fill(7) }] } },
      },
    }
    try {
      sol.start()
      win.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: api => api.register(wallet) }))
      assert.deepEqual(sol.wallets().map(w => w.name), ['Phantom'])
      assert.equal(await sol.connect('Phantom'), SOL_TX.from)
      const sig = await sol.send([sol.systemTransfer(SOL_TX.from, SOL_TX.to, SOL_TX.lamports)])
      assert.equal(sig, sol.base58Encode(new Uint8Array(64).fill(7)))
      assert.equal(signed.chain, 'solana:mainnet')
      assert.equal(signed.account, account)
      assert.equal(hex(signed.transaction), hex(sol.unsignedTransaction(messageOf(SOL_TX.b64))))
      assert.deepEqual(calls.map(c => c.method), ['getLatestBlockhash', 'getSignatureStatuses'])
      assert.equal(calls[0].url, 'https://solana-rpc.publicnode.com')
      await sol.disconnect()
      assert.equal(sol.state.account, null)
    } finally { globalThis.fetch = realFetch; delete globalThis.window }
  },
  'rpc: public endpoints first, then the fallback': async () => {
    const realFetch = globalThis.fetch
    const urls = []
    globalThis.fetch = async url => {
      urls.push(url)
      if (!url.includes('onrender')) throw new TypeError('fetch failed')
      return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: { value: 42 } }) }
    }
    try {
      assert.equal(await sol.getBalance(SOL_TX.from), 42n)
      assert.deepEqual(urls, ['https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com', 'https://type262-upload.onrender.com/rpc/solana'])
      urls.length = 0
      await sol.getBalance(SOL_TX.from) // public just failed: the fallback goes first for a minute
      assert.deepEqual(urls, ['https://type262-upload.onrender.com/rpc/solana'])
      urls.length = 0
      await assert.rejects(sol.rpc('sendTransaction', [], { write: true }), /Can't reach Solana/) // writes never use the fallback
      assert.deepEqual(urls, ['https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com'])
    } finally { globalThis.fetch = realFetch }
  },
}

const online = {
  'mainnet: USDC mint checks out': () => sol.verifyMint(sol.USDC),
  'mainnet: derived USDC account is the one getTokenAccountsByOwner lists': async () => {
    const r = await sol.rpc('getTokenAccountsByOwner', [USDC_TX.wallet, { mint: USDC }, { encoding: 'jsonParsed' }])
    const listed = r.value.map(a => a.pubkey)
    assert.ok(listed.includes(await sol.associatedTokenAddress(USDC_TX.wallet, USDC)), `listed: ${listed.join(', ')}`)
  },
}

let failed = 0
for (const [name, fn] of Object.entries(tests)) {
  try { await fn(); console.log(`ok   ${name}`) } catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.message}`) }
}
let reachable = !process.env.OFFLINE
if (reachable) {
  try { await sol.getLatestBlockhash() } catch { reachable = false }
}
for (const [name, fn] of Object.entries(online)) {
  if (!reachable) { console.log(`skip ${name} (offline)`); continue }
  try { await fn(); console.log(`ok   ${name}`) } catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.message}`) }
}
console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
