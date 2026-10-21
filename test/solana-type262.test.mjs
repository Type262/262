// Tests for the type262 program client (assets/solana-type262.js). Run: node test/solana-type262.test.mjs
// Offline, against a mock RPC:
// - every instruction byte-for-byte against what the LiteSVM harness builds (tests-rs: Env, escrow_util,
//   launcher_support), printed by a Rust program that includes those modules: data, account order, signer and
//   writable flags, PDAs;
// - discriminators, argument layouts, account lists and errors against the IDL (solana/target/idl/type262.json,
//   skipped if it has not been built);
// - account decoders against the Rust tests' byte layouts, pump.fun quotes against amounts the bonding curve
//   accepted on a local validator, v0 messages through an independent parser, signatures, sendAll's flow and
//   errors, the claim's rent rule, and a wallet proof for a synthetic Ed25519 zone.
// With the pump.fun fixtures fetched (solana/scripts/fetch-fixtures.mjs), also the decoders on pump's mainnet
// accounts. solana/scripts/e2e-local.mjs runs the same client against the program on a local validator.
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign as edSign, verify as edVerify } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as T from '../assets/solana-type262.js'
import * as P from '../assets/solana-proof.js'
import { SYSTEM_PROGRAM, TOKEN_PROGRAM, ATA_PROGRAM, base58Decode, base58Encode, base64Encode } from '../assets/solana.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const IDL_PATH = `${root}solana/target/idl/type262.json`
const idl = existsSync(IDL_PATH) ? JSON.parse(readFileSync(IDL_PATH, 'utf8')) : null
const FIXTURES = `${root}solana/tests/fixtures/pump/accounts/`
const hex = b => Buffer.from(b).toString('hex')
const unhex = s => Uint8Array.from(Buffer.from(s, 'hex'))
const cat = (...parts) => Uint8Array.from(Buffer.concat(parts.map(p => Buffer.from(p))))
const u16le = n => [n & 255, n >> 8]
const u32le = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
const u64le = v => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b }
const i64le = v => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); return b }
const sha = s => createHash('sha256').update(s).digest()
const key = a => base58Decode(a)

// ---------- what the Rust harness builds ----------
// Printed by a Rust program that includes tests-rs/tests/escrow_util and launcher_support (the builders the LiteSVM
// suites use) with these inputs: payer Cc5M..., wallet EBk7..., record 6ieq..., mint EPjF... (SPL Token), coin EE5r...,
// domain example.com, deposit 1.5 SOL / 250 tokens, buy_v3 of 1,763,352,468,753 tokens for at most 0.05 SOL,
// Env::initialize() (fee recipient 11157t..., refund delay 180 days), record_data signed at 1.8e9 - 3600 for a day.
// To print them again: a binary crate that depends on solana/tests-rs, pulls both modules in with #[path], and prints
// each builder's Instruction (program, [pubkey, is_signer, is_writable] per account, data as hex); build it with
// TYPE262_SKIP_BUILD=1 and RUSTUP_TOOLCHAIN=1.98.1, the toolchain tests-rs pins. Env::new() makes a random upgrade
// authority, so `initialize` takes its authority from the vector.
const PAYER = 'Cc5M6mecyBKjdrjnvreuANqhMBdLeU7RZNzoSEh2Rnfc'
const WALLET = 'EBk7pSomiBbHe21WFEWGN6UvkXPrAyymNm95gjiEAKwq'
const RECORD = '6ieqmTCTCD2c4h9pjkrCpc5dfgWvensEsiQvWBuVCuCf'
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const COIN = 'EE5rmnGHun3CwN9FxzfzXK5j42WmAY7wxQusMbWBwb72'
const FEE_RECIPIENT = '11157t3sqMV725NVRLrVQbAu98Jjfk1uCKehJnXXQs'
const NAME = 'example.com'
const RUST = {
  initialize: { program: '3fhiMDY5kyCpX47HU1whuEe6vMQFHPa1hwGhc4Pp72NT', accounts: [["C9ErEuPRvUY9CCruAqpW8L1yzgfNHz4GEigHfwm1ppMW",true,true],["8gu5TgdfLnxjasZqbijvrE5KBdxrPA8VsHF7un1MnEfK",false,true],["3fhiMDY5kyCpX47HU1whuEe6vMQFHPa1hwGhc4Pp72NT",false,false],["4jCuYuCb7gUEgMkJxVubeYEXnJEddakz18tQ9659T6yB",false,false],["11111111111111111111111111111111",false,false]], data: 'afaf6d1f0d989beda58cdc9a790be23c9faf3ceffad346aef0ea549ef01dfd6c09245dc17bd3f5990000000190707bc3ef25bdc98ed75cb70d61c8b106dc248d8ef61e1d1db1ca403200004eed0000000000' },
  set_deposits_paused: { program: '3fhiMDY5kyCpX47HU1whuEe6vMQFHPa1hwGhc4Pp72NT', accounts: [["Cc5M6mecyBKjdrjnvreuANqhMBdLeU7RZNzoSEh2Rnfc",true,false],["8gu5TgdfLnxjasZqbijvrE5KBdxrPA8VsHF7un1MnEfK",false,true]], data: 'a062f1c836844dcb01' },
  deposit_sol: { program: '3fhiMDY5kyCpX47HU1whuEe6vMQFHPa1hwGhc4Pp72NT', accounts: [["Cc5M6mecyBKjdrjnvreuANqhMBdLeU7RZNzoSEh2Rnfc",true,true],["8gu5TgdfLnxjasZqbijvrE5KBdxrPA8VsHF7un1MnEfK",false,false],["G67527MB8BaX72SFbcau6AUJ4SRdgJvP3s3RKamikebQ",false,true],["H99DoBGtWtbLXwAQ59B83a6ZRhVRX2vs41qLh4Wxw4Js",false,true],["HQDJfMREYfwdeEKAZahBpnKUjrspjRAi1Hkz9VZAQndR",false,true],["11111111111111111111111111111111",false,false]], data: '6c514e757d9b38c80b0000006578616d706c652e636f6da379a6f6eeafb9a55e378c118034e2751e682fab9f2d30ab13d2125586ce1947002f685900000000' },
  deposit_token: { program: '3fhiMDY5kyCpX47HU1whuEe6vMQFHPa1hwGhc4Pp72NT', accounts: [["Cc5M6mecyBKjdrjnvreuANqhMBdLeU7RZNzoSEh2Rnfc",true,true],["8gu5TgdfLnxjasZqbijvrE5KBdxrPA8VsHF7un1MnEfK",false,false],["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",false,false],["G67527MB8BaX72SFbcau6AUJ4SRdgJvP3s3RKamikebQ",false,true],["cpgnyoSMdzco3vvApxWCLGgNaCztRLzhJwy1kLviajm",false,true],["SD66T687iQL2oC493WMW4Q9YLvYLi8FYDv4v8Qa3h9t",false,true],["FH2SpUv3YTUguw8DkrpxDvPnYM88pRFvH3mhjfmRtK5T",false,true],["4cFJePQSoS9jEjfqNsGrkashfUfdrLYqA1LBik181cXs",false,true],["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",false,false],["ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",false,false],["11111111111111111111111111111111",false,false]], data: '0b9c60da27a3b4130b0000006578616d706c652e636f6da379a6f6eeafb9a55e378c118034e2751e682fab9f2d30ab13d2125586ce194780b2e60e00000000' },
  claim_sol: { program: '3fhiMDY5kyCpX47HU1whuEe6vMQFHPa1hwGhc4Pp72NT', accounts: [["Cc5M6mecyBKjdrjnvreuANqhMBdLeU7RZNzoSEh2Rnfc",true,true],["8gu5TgdfLnxjasZqbijvrE5KBdxrPA8VsHF7un1MnEfK",false,false],["G67527MB8BaX72SFbcau6AUJ4SRdgJvP3s3RKamikebQ",false,true],["6ieqmTCTCD2c4h9pjkrCpc5dfgWvensEsiQvWBuVCuCf",false,false],["EBk7pSomiBbHe21WFEWGN6UvkXPrAyymNm95gjiEAKwq",false,true],["H99DoBGtWtbLXwAQ59B83a6ZRhVRX2vs41qLh4Wxw4Js",false,true],["32pij9CWEypF5QBTktrrzeis2MeiudfLkXTdAHt3z42L",false,true],["11111111111111111111111111111111",false,false],["3fhiMDY5kyCpX47HU1whuEe6vMQFHPa1hwGhc4Pp72NT",false,false],["3fhiMDY5kyCpX47HU1whuEe6vMQFHPa1hwGhc4Pp72NT",false,false],["3fhiMDY5kyCpX47HU1whuEe6vMQFHPa1hwGhc4Pp72NT",false,false],["3fhiMDY5kyCpX47HU1whuEe6vMQFHPa1hwGhc4Pp72NT",false,false],["3fhiMDY5kyCpX47HU1whuEe6vMQFHPa1hwGhc4Pp72NT",false,false],["3fhiMDY5kyCpX47HU1whuEe6vMQFHPa1hwGhc4Pp72NT",false,false]], data: '3ec6d6c1d59f6cd2a379a6f6eeafb9a55e378c118034e2751e682fab9f2d30ab13d2125586ce1947c3e87dc626e58af06a33fad2fefdd5e41f3bec759ccd681e2342f02700c470cc' },
  claim_token: { program: '3fhiMDY5kyCpX47HU1whuEe6vMQFHPa1hwGhc4Pp72NT', accounts: [["Cc5M6mecyBKjdrjnvreuANqhMBdLeU7RZNzoSEh2Rnfc",true,true],["8gu5TgdfLnxjasZqbijvrE5KBdxrPA8VsHF7un1MnEfK",false,false],["G67527MB8BaX72SFbcau6AUJ4SRdgJvP3s3RKamikebQ",false,true],["6ieqmTCTCD2c4h9pjkrCpc5dfgWvensEsiQvWBuVCuCf",false,false],["EBk7pSomiBbHe21WFEWGN6UvkXPrAyymNm95gjiEAKwq",false,true],["cpgnyoSMdzco3vvApxWCLGgNaCztRLzhJwy1kLviajm",false,true],["5PUXAvXhjq5FH9bhcLsvN9oczEgC4GaR3QddDa3HrJmc",false,true],["11111111111111111111111111111111",false,false],["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",false,false],["4cFJePQSoS9jEjfqNsGrkashfUfdrLYqA1LBik181cXs",false,true],["A9cjW2ttReS2mHDr2CpTBb4MyokrknhfGKmFNcMPWVj1",false,true],["7NTbyTTGyCqcv2w5zhHy6NdJs5ohaL3j96Fpf7NhacJq",false,true],["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",false,false],["ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",false,false]], data: '3ec6d6c1d59f6cd2a379a6f6eeafb9a55e378c118034e2751e682fab9f2d30ab13d2125586ce1947c3e87dc626e58af06a33fad2fefdd5e41f3bec759ccd681e2342f02700c470cc' },
  register: { program: '3fhiMDY5kyCpX47HU1whuEe6vMQFHPa1hwGhc4Pp72NT', accounts: [["Cc5M6mecyBKjdrjnvreuANqhMBdLeU7RZNzoSEh2Rnfc",true,true],["G67527MB8BaX72SFbcau6AUJ4SRdgJvP3s3RKamikebQ",false,true],["6ieqmTCTCD2c4h9pjkrCpc5dfgWvensEsiQvWBuVCuCf",false,false],["EBk7pSomiBbHe21WFEWGN6UvkXPrAyymNm95gjiEAKwq",false,false],["11111111111111111111111111111111",false,false]], data: 'd37c430fd3c2b2f00b0000006578616d706c652e636f6da379a6f6eeafb9a55e378c118034e2751e682fab9f2d30ab13d2125586ce1947c3e87dc626e58af06a33fad2fefdd5e41f3bec759ccd681e2342f02700c470cc' },
  refund_sol: { program: '3fhiMDY5kyCpX47HU1whuEe6vMQFHPa1hwGhc4Pp72NT', accounts: [["Cc5M6mecyBKjdrjnvreuANqhMBdLeU7RZNzoSEh2Rnfc",true,true],["8gu5TgdfLnxjasZqbijvrE5KBdxrPA8VsHF7un1MnEfK",false,false],["H99DoBGtWtbLXwAQ59B83a6ZRhVRX2vs41qLh4Wxw4Js",false,true],["HQDJfMREYfwdeEKAZahBpnKUjrspjRAi1Hkz9VZAQndR",false,true],["11111111111111111111111111111111",false,false],["3fhiMDY5kyCpX47HU1whuEe6vMQFHPa1hwGhc4Pp72NT",false,false],["3fhiMDY5kyCpX47HU1whuEe6vMQFHPa1hwGhc4Pp72NT",false,false],["3fhiMDY5kyCpX47HU1whuEe6vMQFHPa1hwGhc4Pp72NT",false,false],["3fhiMDY5kyCpX47HU1whuEe6vMQFHPa1hwGhc4Pp72NT",false,false]], data: '0260b7fb3fd02e2ea379a6f6eeafb9a55e378c118034e2751e682fab9f2d30ab13d2125586ce19470000000000000000000000000000000000000000000000000000000000000000' },
  refund_token: { program: '3fhiMDY5kyCpX47HU1whuEe6vMQFHPa1hwGhc4Pp72NT', accounts: [["Cc5M6mecyBKjdrjnvreuANqhMBdLeU7RZNzoSEh2Rnfc",true,true],["8gu5TgdfLnxjasZqbijvrE5KBdxrPA8VsHF7un1MnEfK",false,false],["cpgnyoSMdzco3vvApxWCLGgNaCztRLzhJwy1kLviajm",false,true],["SD66T687iQL2oC493WMW4Q9YLvYLi8FYDv4v8Qa3h9t",false,true],["11111111111111111111111111111111",false,false],["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",false,false],["4cFJePQSoS9jEjfqNsGrkashfUfdrLYqA1LBik181cXs",false,true],["FH2SpUv3YTUguw8DkrpxDvPnYM88pRFvH3mhjfmRtK5T",false,true],["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",false,false]], data: '0260b7fb3fd02e2ea379a6f6eeafb9a55e378c118034e2751e682fab9f2d30ab13d2125586ce1947c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d61' },
  withdraw_fees_sol: { program: '3fhiMDY5kyCpX47HU1whuEe6vMQFHPa1hwGhc4Pp72NT', accounts: [["Cc5M6mecyBKjdrjnvreuANqhMBdLeU7RZNzoSEh2Rnfc",true,true],["8gu5TgdfLnxjasZqbijvrE5KBdxrPA8VsHF7un1MnEfK",false,false],["32pij9CWEypF5QBTktrrzeis2MeiudfLkXTdAHt3z42L",false,true],["11157t3sqMV725NVRLrVQbAu98Jjfk1uCKehJnXXQs",false,true],["11111111111111111111111111111111",false,false],["3fhiMDY5kyCpX47HU1whuEe6vMQFHPa1hwGhc4Pp72NT",false,false],["3fhiMDY5kyCpX47HU1whuEe6vMQFHPa1hwGhc4Pp72NT",false,false],["3fhiMDY5kyCpX47HU1whuEe6vMQFHPa1hwGhc4Pp72NT",false,false],["3fhiMDY5kyCpX47HU1whuEe6vMQFHPa1hwGhc4Pp72NT",false,false],["3fhiMDY5kyCpX47HU1whuEe6vMQFHPa1hwGhc4Pp72NT",false,false]], data: 'c6d4ab6d90d7ae590000000000000000000000000000000000000000000000000000000000000000' },
  withdraw_fees_token: { program: '3fhiMDY5kyCpX47HU1whuEe6vMQFHPa1hwGhc4Pp72NT', accounts: [["Cc5M6mecyBKjdrjnvreuANqhMBdLeU7RZNzoSEh2Rnfc",true,true],["8gu5TgdfLnxjasZqbijvrE5KBdxrPA8VsHF7un1MnEfK",false,false],["5PUXAvXhjq5FH9bhcLsvN9oczEgC4GaR3QddDa3HrJmc",false,true],["11157t3sqMV725NVRLrVQbAu98Jjfk1uCKehJnXXQs",false,true],["11111111111111111111111111111111",false,false],["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",false,false],["7NTbyTTGyCqcv2w5zhHy6NdJs5ohaL3j96Fpf7NhacJq",false,true],["H2BZqbCFjUG8M8dFaYLrJ1m6vqQpVK9LaeD3drGbB45y",false,true],["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",false,false],["ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",false,false]], data: 'c6d4ab6d90d7ae59c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d61' },
  launch: { program: '3fhiMDY5kyCpX47HU1whuEe6vMQFHPa1hwGhc4Pp72NT', accounts: [["Cc5M6mecyBKjdrjnvreuANqhMBdLeU7RZNzoSEh2Rnfc",true,true],["G67527MB8BaX72SFbcau6AUJ4SRdgJvP3s3RKamikebQ",false,true],["EzUJ1LYUU9UMsQPSPK7Vy5G3kZmfhx5HizkvSJJVp91w",false,true],["EE5rmnGHun3CwN9FxzfzXK5j42WmAY7wxQusMbWBwb72",true,true],["JiVstae5eRyuTqfWPhbahxJk6UmGxeuL3gtx1yDua2A",false,true],["6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",false,false],["11111111111111111111111111111111",false,false],["EE5rmnGHun3CwN9FxzfzXK5j42WmAY7wxQusMbWBwb72",true,true],["TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM",false,false],["Gnmnu6x1hXQG5TPGc1mAsM4Zf4aSKEaq9ALA5rvogCYt",false,true],["WYkWjH22xEC2oaYBkEzzfQZ5U2gKy7bYPZcNaKNbjeH",false,true],["4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf",false,false],["Cc5M6mecyBKjdrjnvreuANqhMBdLeU7RZNzoSEh2Rnfc",true,true],["11111111111111111111111111111111",false,false],["TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",false,false],["ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",false,false],["MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e",false,true],["13ec7XdrjF3h3YcqBTFDSReRcUFwbCnJaAQspM4j6DDJ",false,false],["BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s",false,true],["JD569L68qBa1s4FpJtxCrhNfFuGByYqEHVrh2yGq8dAH",false,true],["DiZNGsbM66PzrFFJ9vRhoT6sSrZVX1ayJ3knounv9AMz",false,true],["Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1",false,false],["6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",false,false]], data: '99f15de116454a3d0b0000006578616d706c652e636f6da379a6f6eeafb9a55e378c118034e2751e682fab9f2d30ab13d2125586ce1947070000004578616d706c650200000045581a00000068747470733a2f2f6578616d706c652e636f6d2f6d2e6a736f6e' },
  collect: { program: '3fhiMDY5kyCpX47HU1whuEe6vMQFHPa1hwGhc4Pp72NT', accounts: [["Cc5M6mecyBKjdrjnvreuANqhMBdLeU7RZNzoSEh2Rnfc",true,true],["G67527MB8BaX72SFbcau6AUJ4SRdgJvP3s3RKamikebQ",false,false],["EzUJ1LYUU9UMsQPSPK7Vy5G3kZmfhx5HizkvSJJVp91w",false,true],["CmezuTaJuxnQoJqD8iogNKcUw6SdjBs5jm13mJCZ8iLR",false,true],["H99DoBGtWtbLXwAQ59B83a6ZRhVRX2vs41qLh4Wxw4Js",false,true],["9ErpM17SGQP94QrCh1id7j2wKmYFR38QuzKdSXNA9U7e",false,true],["AeSBNZ2fmDkk8YMHydiZJTPKPGBmqxZW5EULTYGc1ZNc",false,true],["Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1",false,false],["6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",false,false],["Ezjzqwo2nKbaAnGchxmdv71pYMfVw1uiehhm3EHs4jC2",false,false],["AWghrPcH3A46kKbGtPDDXuAaLmJy9fXYEkoFUWHrDvRx",false,true],["GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR",false,false],["pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",false,false],["So11111111111111111111111111111111111111112",false,false],["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",false,false],["ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",false,false],["11111111111111111111111111111111",false,false]], data: 'd02fc29b116252eca379a6f6eeafb9a55e378c118034e2751e682fab9f2d30ab13d2125586ce1947' },
  buy_v3: { program: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', accounts: [["4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf",false,false],["EE5rmnGHun3CwN9FxzfzXK5j42WmAY7wxQusMbWBwb72",false,false],["So11111111111111111111111111111111111111112",false,false],["TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",false,false],["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",false,false],["Gnmnu6x1hXQG5TPGc1mAsM4Zf4aSKEaq9ALA5rvogCYt",false,true],["WYkWjH22xEC2oaYBkEzzfQZ5U2gKy7bYPZcNaKNbjeH",false,true],["5U5Lnn1UMER8svSwuw31iYrBiKeBFPExRRoqToRX3yxy",false,true],["Cc5M6mecyBKjdrjnvreuANqhMBdLeU7RZNzoSEh2Rnfc",true,true],["2SQ7gicrN1bS26dT8fHKMGEfFR5DUprUzZp6xdKc29J7",false,true],["21nDS4uRUpeHGAF2hjJsfWBk559ozotwieAgv7HThUH6",false,true],["F2vMAWJAVeq8CFVt2uTFbBFvtJRy7Br2Qwd6pVjoCf53",false,true],["8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt",false,false],["5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD",false,true],["11111111111111111111111111111111",false,false],["Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1",false,false],["6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",false,false]], data: '07051dc4f5176550115dff8f9a01000080f0fa020000000000' },
  create_ata_2022: { program: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', accounts: [["Cc5M6mecyBKjdrjnvreuANqhMBdLeU7RZNzoSEh2Rnfc",true,true],["2SQ7gicrN1bS26dT8fHKMGEfFR5DUprUzZp6xdKc29J7",false,true],["Cc5M6mecyBKjdrjnvreuANqhMBdLeU7RZNzoSEh2Rnfc",false,false],["EE5rmnGHun3CwN9FxzfzXK5j42WmAY7wxQusMbWBwb72",false,false],["11111111111111111111111111111111",false,false],["TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",false,false]], data: '01' },
  sweep_creator_fee: { program: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', accounts: [["Cc5M6mecyBKjdrjnvreuANqhMBdLeU7RZNzoSEh2Rnfc",true,true],["4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf",false,false],["EE5rmnGHun3CwN9FxzfzXK5j42WmAY7wxQusMbWBwb72",false,false],["So11111111111111111111111111111111111111112",false,false],["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",false,false],["ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",false,false],["11111111111111111111111111111111",false,false],["Gnmnu6x1hXQG5TPGc1mAsM4Zf4aSKEaq9ALA5rvogCYt",false,true],["5U5Lnn1UMER8svSwuw31iYrBiKeBFPExRRoqToRX3yxy",false,true],["9ErpM17SGQP94QrCh1id7j2wKmYFR38QuzKdSXNA9U7e",false,true],["AeSBNZ2fmDkk8YMHydiZJTPKPGBmqxZW5EULTYGc1ZNc",false,true],["Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1",false,false],["6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",false,false]], data: '20f6bf3408c949ba' },
  record_data: 'd4b3f5d7cfcbcdb1f610000d3930f0c3496b0000000080234b6b00000000070707070707070707070707070707070707070707070707070707070707070715000000075f77616c6c6574076578616d706c6503636f6d0033000000310030534f4c2045426b3770536f6d6942624865323157464557474e3655766b5850724179796d4e6d3935676a6945414b7771',
}
const RUST_RECORD_PDA = 'AcDJNiSwaBvySFXStx4MPRWX7XebiC5vqo4bUNbnFxHZ' // record_pda(example.com, Txt), bump 246

/** An instruction in the golden form. */
const shape = ix => ({ program: ix.programId, accounts: ix.keys.map(k => [k.pubkey, k.isSigner, k.isWritable]), data: hex(ix.data) })
const same = (ix, name) => assert.deepEqual(shape(ix), RUST[name], name)

// ---------- a mock RPC ----------
const accounts = new Map() // address -> { owner, lamports, data }
const handlers = {}
async function mock(method, params) {
  if (method === 'getMultipleAccounts') {
    return { value: params[0].map(a => { const x = accounts.get(a); return x ? { owner: x.owner, lamports: Number(x.lamports ?? 1_000_000), data: [base64Encode(x.data), 'base64'], executable: !!x.executable } : null }) }
  }
  if (method === 'getMinimumBalanceForRentExemption') return (128 + params[0]) * 6960
  if (handlers[method]) return handlers[method](params)
  throw new Error(`mock RPC: unexpected ${method}`)
}
T.configure({ rpc: mock, chain: 'solana:localnet' })
const put = (address, owner, data, lamports) => accounts.set(address, { owner, data: Uint8Array.from(data), lamports })

// Mint accounts: 82 bytes, decimals at 44.
const mintData = decimals => { const d = new Uint8Array(82); d[44] = decimals; d[45] = 1; return d }
put(MINT, TOKEN_PROGRAM, mintData(6))

// The program's accounts, laid out as state.rs (and the Rust mirrors in tests-rs/src/lib.rs) has them.
const disc = name => Uint8Array.from(sha(`account:${name}`).subarray(0, 8))
const configData = ({ admin, feeRecipient, feeBps = 50, refundDelay = 180 * 86_400, paused = false }) => cat(disc('Config'), key(admin), new Uint8Array(32), key(feeRecipient), u16le(feeBps), i64le(refundDelay), [paused ? 1 : 0, 254])
const borshStr = s => cat(u32le(Buffer.byteLength(s)), Buffer.from(s))
// The Domain account is allocated for the longest name (342 bytes), as collect_funds_a_creator_that_was_never_funded writes it.
const domainData = ({ hash, lastProof = 0, wallet = SYSTEM_PROGRAM, launches = 0, name }) => { const d = new Uint8Array(342); d.set(cat(disc('Domain'), hash, i64le(lastProof), key(wallet), u32le(launches), [255], borshStr(name))); return d }
const poolData = ({ hash, mint = SYSTEM_PROGRAM, balance, epoch = 0 }) => cat(disc('Pool'), hash, key(mint), u64le(balance), u64le(epoch), [255])
const depositData = ({ pool, depositor, amount, epoch = 0, lastAt }) => cat(disc('Deposit'), key(pool), key(depositor), u64le(amount), u64le(epoch), i64le(lastAt), [255])

const tests = {}
const test = (name, fn) => { tests[name] = fn }

// ---------- the IDL ----------

test('discriminators are sha256 of their names', () => {
  for (const [n, d] of Object.entries(T.IX)) assert.deepEqual(d, [...sha(`global:${n}`).subarray(0, 8)], n)
  for (const [n, d] of Object.entries(T.ACCOUNT)) assert.deepEqual(d, [...sha(`account:${n}`).subarray(0, 8)], n)
})

test('IDL: discriminators, accounts and errors', () => {
  if (!idl) return 'skip: run anchor build in solana/ for the IDL'
  assert.equal(idl.address, T.PROGRAM_ID)
  for (const [n, d] of Object.entries(T.IX)) assert.deepEqual(idl.instructions.find(i => i.name === n).discriminator, d, n)
  for (const [n, d] of Object.entries(T.ACCOUNT)) assert.deepEqual(idl.accounts.find(a => a.name === n).discriminator, d, n)
  const programErrors = Object.entries(T.ERRORS).filter(([c]) => c >= 6000)
  assert.equal(programErrors.length, idl.errors.length)
  for (const e of idl.errors) assert.deepEqual(T.ERRORS[e.code], [e.name, e.msg], String(e.code))
})

// A borsh reader driven by the IDL's types, to check each instruction's data independently of the client.
function idlArgs(ixName, data) {
  const ix = idl.instructions.find(i => i.name === ixName)
  assert.deepEqual([...data.subarray(0, 8)], ix.discriminator, `${ixName} discriminator`)
  let at = 8
  const take = n => { const b = data.subarray(at, at + n); assert.equal(b.length, n, `${ixName}: data too short`); at += n; return b }
  const read = type => {
    if (type === 'string') return Buffer.from(take(Buffer.from(take(4)).readUInt32LE())).toString()
    if (type === 'bytes') return take(Buffer.from(take(4)).readUInt32LE())
    if (type === 'pubkey') return base58Encode(take(32))
    if (type === 'bool') return take(1)[0] !== 0
    if (type === 'u8') return take(1)[0]
    if (type === 'u16') return Buffer.from(take(2)).readUInt16LE()
    if (type === 'u32') return Buffer.from(take(4)).readUInt32LE()
    if (type === 'u64') return Buffer.from(take(8)).readBigUInt64LE()
    if (type === 'i64') return Buffer.from(take(8)).readBigInt64LE()
    if (type.array) return Array.from({ length: type.array[1] }, () => read(type.array[0]))
    if (type.defined) {
      const t = idl.types.find(x => x.name === type.defined.name)
      return Object.fromEntries(t.type.fields.map(f => [f.name, read(f.type)]))
    }
    throw new Error(`type ${JSON.stringify(type)}`)
  }
  const out = Object.fromEntries(ix.args.map(a => [a.name, read(a.type)]))
  assert.equal(at, data.length, `${ixName}: ${data.length - at} bytes left over`)
  return out.args
}

test('IDL: every golden instruction decodes exactly and has the IDL accounts', () => {
  if (!idl) return 'skip: run anchor build in solana/ for the IDL'
  const map = { deposit_sol: 'deposit_sol', deposit_token: 'deposit_token', claim_sol: 'claim', claim_token: 'claim', register: 'register', refund_sol: 'refund', refund_token: 'refund', withdraw_fees_sol: 'withdraw_fees', withdraw_fees_token: 'withdraw_fees', launch: 'launch', collect: 'collect', initialize: 'initialize', set_deposits_paused: 'set_deposits_paused' }
  for (const [golden, ixName] of Object.entries(map)) {
    const g = RUST[golden]
    idlArgs(ixName, unhex(g.data))
    const accs = idl.instructions.find(i => i.name === ixName).accounts
    const named = ixName === 'launch' ? g.accounts.slice(0, accs.length) : g.accounts
    assert.equal(named.length, accs.length, `${golden}: account count`)
    accs.forEach((a, i) => {
      const none = a.optional && named[i][0] === T.PROGRAM_ID
      assert.equal(named[i][1], !!a.signer, `${golden} ${a.name} signer`)
      if (!none) assert.equal(named[i][2], !!a.writable, `${golden} ${a.name} writable`)
      if (a.address && !none) assert.equal(named[i][0], a.address, `${golden} ${a.name} address`)
    })
  }
  assert.equal(RUST.launch.accounts.length, 7 + 16, 'launch takes the 16 create_v2 accounts as remaining accounts')
})

test("IDL: PDAs derived from the IDL's seeds match the client", async () => {
  if (!idl) return 'skip: run anchor build in solana/ for the IDL'
  // Resolve each account's seeds from the IDL (const, arg and account kinds) and compare with the golden instruction.
  const { findProgramAddress } = await import('../assets/solana.js')
  for (const [golden, ixName] of [['deposit_sol', 'deposit_sol'], ['deposit_token', 'deposit_token'], ['claim_sol', 'claim'], ['register', 'register'], ['refund_token', 'refund'], ['withdraw_fees_sol', 'withdraw_fees'], ['launch', 'launch'], ['collect', 'collect']]) {
    const g = RUST[golden]
    const ix = idl.instructions.find(i => i.name === ixName)
    const args = idlArgs(ixName, unhex(g.data))
    const accountsByName = Object.fromEntries(ix.accounts.map((a, i) => [a.name, g.accounts[i] && g.accounts[i][0]]))
    for (const [i, a] of ix.accounts.entries()) {
      if (!a.pda || a.pda.program) continue
      const seeds = a.pda.seeds.map(s => {
        if (s.kind === 'const') return Uint8Array.from(s.value)
        if (s.kind === 'arg') { const v = args[s.path.replace('args.', '')]; return typeof v === 'string' ? key(v) : Uint8Array.from(v) }
        const [acc, field] = s.path.split('.')
        if (field === 'mint') return key(acc === 'pool' ? (golden.endsWith('token') ? MINT : SYSTEM_PROGRAM) : MINT)
        return key(accountsByName[acc])
      })
      const [address] = await findProgramAddress(seeds, T.PROGRAM_ID)
      assert.equal(g.accounts[i][0], address, `${golden} ${a.name}`)
    }
  }
})

// ---------- byte-for-byte with the Rust harness ----------

test('addresses match the harness', async () => {
  const hash = await T.domainHash(NAME)
  assert.equal(hex(hash), hex(sha(NAME)))
  assert.equal(hex(await T.domainHash('Example.COM.')), hex(hash), 'canonical before hashing')
  await assert.rejects(T.domainHash('exa mple.com'), /Not a valid domain/)
  assert.equal(await T.pda.config(), RUST.deposit_sol.accounts[1][0])
  assert.equal(await T.pda.domain(hash), RUST.deposit_sol.accounts[2][0])
  assert.equal(await T.pda.pool(hash, 'SOL'), RUST.deposit_sol.accounts[3][0])
  assert.equal(await T.pda.pool(hex(hash), SYSTEM_PROGRAM), RUST.deposit_sol.accounts[3][0], 'hash as hex, SOL as the zero key')
  assert.equal(await T.pda.deposit(RUST.deposit_sol.accounts[3][0], PAYER), RUST.deposit_sol.accounts[4][0])
  assert.equal(await T.pda.feeVault('SOL'), RUST.claim_sol.accounts[6][0])
  assert.equal(await T.pda.feeVault(MINT), RUST.claim_token.accounts[6][0])
  assert.equal(await T.pda.creator(hash), RUST.launch.accounts[2][0])
  assert.equal(await T.pda.launch(COIN), RUST.launch.accounts[4][0])
  assert.equal(await T.pda.programData(), RUST.initialize.accounts[3][0])
  // rrset seeds take the rrtype big-endian, as the program and record_pda do
  assert.equal(await T.pda.rrset(`_wallet.${NAME}`, P.TYPE_TXT), RUST_RECORD_PDA)
  assert.equal((await T.recordAddresses(NAME)).txt, RUST_RECORD_PDA)
  assert.equal(await T.pumpPda.bondingCurve(COIN), RUST.launch.accounts[9][0])
  assert.equal(await T.pumpPda.mayhemState(COIN), RUST.launch.accounts[19][0])
  assert.equal(await T.pumpPda.creatorVault(RUST.launch.accounts[2][0]), RUST.collect.accounts[5][0])
  assert.equal(await T.pumpPda.ammCreatorVault(RUST.launch.accounts[2][0]), RUST.collect.accounts[9][0])
  assert.equal(await T.pumpPda.userVolume(PAYER), RUST.buy_v3.accounts[11][0])
})

test('deposits', async () => {
  same((await T.depositIx({ payer: PAYER, name: NAME, amount: 1_500_000_000n })).instructions[0], 'deposit_sol')
  same((await T.depositIx({ payer: PAYER, name: 'Example.com', mint: MINT, amount: 250_000_000n })).instructions[0], 'deposit_token')
  await assert.rejects(T.depositIx({ payer: PAYER, name: NAME, amount: 0n }), /greater than zero/)
})

test('claims and register', async () => {
  same((await T.claimIx({ payer: PAYER, name: NAME, wallet: WALLET, record: RECORD })).instructions[0], 'claim_sol')
  const token = await T.claimIx({ payer: PAYER, name: NAME, mint: MINT, wallet: WALLET, record: RECORD })
  assert.equal(token.instructions.length, 2, "the wallet's token account first")
  assert.equal(token.instructions[0].programId, ATA_PROGRAM)
  assert.equal(token.instructions[0].keys[1].pubkey, RUST.claim_token.accounts[10][0])
  same(token.instructions[1], 'claim_token')
  same((await T.registerIx({ payer: PAYER, name: NAME, wallet: WALLET, record: RECORD })).instructions[0], 'register')
})

test('refunds and fee withdrawals', async () => {
  same((await T.refundIx({ payer: PAYER, name: NAME })).instructions[0], 'refund_sol')
  const token = await T.refundIx({ payer: PAYER, name: NAME, mint: MINT })
  assert.equal(token.instructions[0].keys[1].pubkey, RUST.refund_token.accounts[7][0], "the depositor's token account, created idempotently")
  same(token.instructions[1], 'refund_token')
  put(await T.pda.config(), T.PROGRAM_ID, configData({ admin: PAYER, feeRecipient: FEE_RECIPIENT }))
  same((await T.withdrawFeesIx({ payer: PAYER })).instructions[0], 'withdraw_fees_sol')
  same((await T.withdrawFeesIx({ payer: PAYER, mint: MINT })).instructions[0], 'withdraw_fees_token')
})

test('initialize and pause', async () => {
  const g = RUST.initialize
  const authority = g.accounts[0][0]
  same((await T.initializeIx({ authority, admin: authority, feeRecipient: FEE_RECIPIENT, feeBps: 50, refundDelay: 180 * 86_400 })).instructions[0], 'initialize')
  same((await T.setDepositsPausedIx({ admin: PAYER, paused: true })).instructions[0], 'set_deposits_paused')
})

// pump's Global and fee config, as the mainnet accounts have them (values from tests/fixtures/pump/manifest.json's fetch).
const BUYBACK = ['5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD', '9M4giFFMxmFGXtc3feFzRai56WbBqehoSeRE5GK7gf7']
function globalData() {
  const d = new Uint8Array(1088)
  const v = new DataView(d.buffer)
  v.setBigUint64(73, 1_073_000_000_000_000n, true)
  v.setBigUint64(81, 30_000_000_000n, true)
  v.setBigUint64(89, 793_100_000_000_000n, true)
  v.setBigUint64(97, 1_000_000_000_000_000n, true)
  BUYBACK.forEach((b, i) => d.set(key(b), 741 + 32 * i))
  return d
}
const feeConfigData = () => cat(new Uint8Array(41), u64le(0), u64le(95), u64le(30), u32le(1), new Uint8Array(16), u64le(0), u64le(95), u64le(30))
put(T.PUMP.global, T.PUMP.program, globalData())
put(T.PUMP.feeConfig, 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ', feeConfigData())
const coinSigner = { publicKey: COIN, sign: async () => new Uint8Array(64) }

test('launch: our instruction, the ATA and buy_v3 as the harness builds them', async () => {
  const bare = await T.launchTx({ payer: PAYER, name: NAME, tokenName: 'Example', symbol: 'EX', uri: 'https://example.com/m.json', mintKeypair: coinSigner })
  assert.equal(bare.instructions.length, 2)
  assert.deepEqual(hex(bare.instructions[0].data), '02e0930400', 'SetComputeUnitLimit(300,000)')
  same(bare.instructions[1], 'launch')
  const withBuy = await T.launchTx({ payer: PAYER, name: NAME, tokenName: 'Example', symbol: 'EX', uri: 'https://example.com/m.json', mintKeypair: coinSigner, buyLamports: 50_000_000n, minTokens: 1n })
  assert.equal(withBuy.tokens, 1_763_352_468_753n)
  same(withBuy.instructions[2], 'create_ata_2022')
  same(withBuy.instructions[3], 'buy_v3')
  assert.deepEqual(withBuy.extraSigners, [coinSigner])
  await assert.rejects(T.launchTx({ payer: PAYER, name: NAME, tokenName: 'Example', symbol: 'EX', uri: 'https://example.com/m.json', mintKeypair: coinSigner, buyLamports: 50_000_000n, minTokens: 1_763_352_468_754n }), /fewer tokens/)
  await assert.rejects(T.launchTx({ payer: PAYER, name: NAME, tokenName: '', symbol: 'EX', uri: 'x' }), /needs a name/)
})

test('collect: the sweep and collect as the harness builds them', async () => {
  const creator = await T.pda.creator(await T.domainHash(NAME))
  const curve = new Uint8Array(151)
  const v = new DataView(curve.buffer)
  curve.set(key(creator), 49)
  v.setBigUint64(125, 740_742n, true)
  put(await T.pumpPda.bondingCurve(COIN), T.PUMP.program, curve)
  const hash = await T.domainHash(NAME)
  await assert.rejects(T.collectIx({ payer: PAYER, name: NAME, mint: COIN }), /no account in the program yet/)
  put(await T.pda.domain(hash), T.PROGRAM_ID, domainData({ hash, name: NAME, launches: 1 }))
  const c = await T.collectIx({ payer: PAYER, name: NAME, mint: COIN })
  assert.equal(c.pending, 740_742n)
  same(c.instructions[0], 'sweep_creator_fee')
  same(c.instructions[1], 'collect')
  accounts.delete(await T.pumpPda.bondingCurve(COIN))
  const none = await T.collectIx({ payer: PAYER, name: NAME, mint: COIN })
  assert.equal(none.instructions.length, 1, 'no sweep when the curve holds nothing')
})

test('lookup table: the accounts the LiteSVM v0 test puts in it, in order', () => {
  assert.deepEqual(T.LAUNCH_LOOKUP_ADDRESSES, [
    T.PROGRAM_ID, '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf', 'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM',
    SYSTEM_PROGRAM, 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', TOKEN_PROGRAM, ATA_PROGRAM, 'MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e',
    '13ec7XdrjF3h3YcqBTFDSReRcUFwbCnJaAQspM4j6DDJ', 'BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s', 'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1',
    '8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt', '5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD', 'So11111111111111111111111111111111111111112',
    'ComputeBudget111111111111111111111111111111',
  ])
})

// ---------- accounts ----------

test('decoders read the layouts the Rust tests write', async () => {
  const hash = await T.domainHash(NAME)
  put(await T.pda.domain(hash), T.PROGRAM_ID, domainData({ hash, lastProof: 1_799_996_400, wallet: WALLET, launches: 2, name: NAME }))
  const d = await T.readDomain('EXAMPLE.com')
  assert.deepEqual([d.exists, d.name, d.lastProof, d.wallet, d.launches], [true, NAME, 1_799_996_400, WALLET, 2])
  const fresh = await T.readDomain('nobody.example')
  assert.deepEqual([fresh.exists, fresh.lastProof, fresh.wallet], [false, 0, null])

  const pool = await T.pda.pool(hash, 'SOL')
  put(pool, T.PROGRAM_ID, poolData({ hash, balance: 3_750_000_000n, epoch: 1 }))
  put(await T.pda.pool(hash, MINT), T.PROGRAM_ID, poolData({ hash, mint: MINT, balance: 350_500_000n }))
  const pools = await T.readPools(NAME)
  assert.deepEqual(pools.map(p => [p.mint, p.symbol, p.decimals, p.balance, p.epoch, p.exists]), [['SOL', 'SOL', 9, 3_750_000_000n, 1, true], [MINT, 'USDC', 6, 350_500_000n, 0, true]])
  const other = 'Fake1111111111111111111111111111111111111111'.slice(0, 43) + 'A'
  put(other, 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', mintData(9))
  const extra = await T.readPools(NAME, [other])
  assert.deepEqual(extra.map(p => [p.decimals, p.balance, p.exists]).at(-1), [9, 0n, false], 'a mint passed in: decimals read from the chain')

  put(await T.pda.config(), T.PROGRAM_ID, configData({ admin: PAYER, feeRecipient: FEE_RECIPIENT, refundDelay: 20, paused: true }))
  const cfg = await T.readConfig()
  assert.deepEqual([cfg.admin, cfg.pendingAdmin, cfg.feeRecipient, cfg.feeBps, cfg.refundDelay, cfg.depositsPaused], [PAYER, null, FEE_RECIPIENT, 50, 20, true])
  put(await T.pda.deposit(pool, PAYER), T.PROGRAM_ID, depositData({ pool, depositor: PAYER, amount: 1_750_000_000n, epoch: 0, lastAt: 1_800_000_000 }))
  const dep = await T.readDeposit(NAME, 'SOL', PAYER)
  assert.deepEqual([dep.amount, dep.recorded, dep.paidOut, dep.refundableAt], [0n, 1_750_000_000n, true, 1_800_000_020], 'paid out by a claim (epoch 0 < pool epoch 1)')
  put(await T.pda.deposit(pool, PAYER), T.PROGRAM_ID, depositData({ pool, depositor: PAYER, amount: 100_000_000n, epoch: 1, lastAt: 1_800_000_000 }))
  assert.equal((await T.readDeposit(NAME, 'SOL', PAYER)).amount, 100_000_000n)
  assert.equal(await T.readDeposit(NAME, 'SOL', WALLET), null)
  // Anything not ours, or of another type, decodes to null.
  assert.equal(T.decode('Pool', { owner: TOKEN_PROGRAM, data: poolData({ hash, balance: 1n }) }), null)
  assert.equal(T.decode('Domain', { owner: T.PROGRAM_ID, data: poolData({ hash, balance: 1n }) }), null)
})

test("the cached wallet record: Rust's record_data bytes", async () => {
  const data = unhex(RUST.record_data)
  put(RUST_RECORD_PDA, T.PROGRAM_ID, data)
  const recs = await T.readRecords(NAME, { now: 1_800_000_000 })
  assert.deepEqual(recs.map(r => [r.address, r.type, r.wallets, r.signedAt, r.expiresAt, r.expired]), [[RUST_RECORD_PDA, 'TXT', [WALLET], 1_799_996_400, 1_800_086_400, false]])
  // claimIx and registerIx find it on their own
  assert.equal((await T.claimIx({ payer: PAYER, name: NAME, wallet: WALLET })).record, RUST_RECORD_PDA)
  assert.equal((await T.registerIx({ payer: PAYER, name: NAME, wallet: WALLET })).record, RUST_RECORD_PDA)
  accounts.delete(RUST_RECORD_PDA)
})

test('launch records by domain, through getProgramAccounts', async () => {
  const hash = await T.domainHash(NAME)
  const rec = (mint, at) => ({ pubkey: base58Encode(sha(mint).subarray(0, 32)), account: { owner: T.PROGRAM_ID, data: [base64Encode(cat(disc('LaunchRecord'), hash, key(mint), key(PAYER), i64le(at), [255])), 'base64'] } })
  handlers.getProgramAccounts = ([program, opts]) => {
    assert.equal(program, T.PROGRAM_ID)
    assert.deepEqual(opts.filters, [{ dataSize: 113 }, { memcmp: { offset: 0, bytes: base58Encode(disc('LaunchRecord')) } }, { memcmp: { offset: 8, bytes: base58Encode(hash) } }])
    return [rec(COIN, 100), rec(MINT, 200)]
  }
  assert.deepEqual((await T.readLaunches(NAME)).map(l => [l.mint, l.launcher, l.launchedAt]), [[MINT, PAYER, 200], [COIN, PAYER, 100]])
})

test('a tiny SOL payout to an empty wallet: the payer funds its rent in the same transaction', async () => {
  const hash = await T.domainHash(NAME)
  put(await T.pda.config(), T.PROGRAM_ID, configData({ admin: PAYER, feeRecipient: FEE_RECIPIENT }))
  put(await T.pda.pool(hash, 'SOL'), T.PROGRAM_ID, poolData({ hash, balance: 740_742n, epoch: 2 }))
  const empty = 'Bob1111111111111111111111111111111111111111'.slice(0, 43) + 'B'
  const c = await T.claimIx({ payer: PAYER, name: NAME, wallet: empty, record: RECORD })
  assert.equal(c.instructions.length, 2)
  assert.equal(c.instructions[0].programId, SYSTEM_PROGRAM)
  assert.equal(hex(c.instructions[0].data), hex(cat(u32le(2), u64le(128 * 6960))), 'transfer of the rent minimum for 0 bytes')
  put(empty, SYSTEM_PROGRAM, [], 5000)
  assert.equal((await T.claimIx({ payer: PAYER, name: NAME, wallet: empty, record: RECORD })).instructions.length, 1, 'a funded wallet needs nothing')
  put(await T.pda.pool(hash, 'SOL'), T.PROGRAM_ID, poolData({ hash, balance: 3_750_000_000n, epoch: 1 }))
  accounts.delete(empty)
  assert.equal((await T.claimIx({ payer: PAYER, name: NAME, wallet: empty, record: RECORD })).instructions.length, 1, 'a payout above the rent minimum needs nothing')
  assert.equal(T.feeOf(3_750_000_000n, 50), 18_750_000n)
  assert.equal(T.feeOf(199n, 50), 0n)
  assert.equal(T.feeOf(200n, 50), 1n)
})

test('claims and registers refuse a token account, a mint or a program as the wallet (BadRecipient)', async () => {
  const tokenAccount = await T.ata(PAYER, MINT)
  const mint2022 = base58Encode(sha('a Token-2022 mint').subarray(0, 32))
  const program = base58Encode(sha('a program').subarray(0, 32))
  put(tokenAccount, TOKEN_PROGRAM, new Uint8Array(165))
  put(mint2022, T.TOKEN_2022_PROGRAM, cat(mintData(6), new Uint8Array(83), [1], u16le(18), u16le(64), new Uint8Array(64)))
  accounts.set(program, { owner: 'BPFLoaderUpgradeab1e11111111111111111111111', data: new Uint8Array(36), executable: true })
  for (const [wallet, what] of [[tokenAccount, 'a token account'], [MINT, 'a token mint'], [mint2022, 'a token mint'], [program, 'a program']]) {
    for (const build of [
      () => T.claimIx({ payer: PAYER, name: NAME, wallet, record: RECORD }),
      () => T.claimIx({ payer: PAYER, name: NAME, mint: MINT, wallet, record: RECORD }),
      () => T.registerIx({ payer: PAYER, name: NAME, wallet, record: RECORD }),
    ]) await assert.rejects(build(), e => e.code === 'BadRecipient' && e.message.startsWith(`${wallet} is ${what}, not a wallet`))
  }
  for (const a of [tokenAccount, mint2022, program]) accounts.delete(a)
  // A wallet that exists, or doesn't yet, is fine.
  put(WALLET, SYSTEM_PROGRAM, [], 5000)
  assert.equal((await T.registerIx({ payer: PAYER, name: NAME, wallet: WALLET, record: RECORD })).instructions.length, 1)
  accounts.delete(WALLET)
})

// ---------- pump.fun quotes ----------

test('quotes: the amounts the bonding curve accepted on a local validator', () => {
  const fees = T.curveFees(T.decodeFeeConfig(feeConfigData()), 27_000_000_000n)
  assert.deepEqual(fees, { lp: 0n, protocol: 95n, creator: 30n, threshold: 0n })
  const fresh = { virtualTokenReserves: 1_073_000_000_000_000n, virtualSolReserves: 30_000_000_000n, realTokenReserves: 793_100_000_000_000n }
  // e2e-local.mjs: the launch's buy of 0.05 SOL got 1,763,352,468,753 tokens and put 49,382,715 lamports on the curve.
  const t1 = T.quoteBuy(fresh, fees, 50_000_000n)
  assert.equal(t1, 1_763_352_468_753n)
  assert.ok(T.buyCost(fresh, fees, t1) <= 50_000_000n && T.buyCost(fresh, fees, t1 + 1n) > 50_000_000n, 'the most that fits')
  assert.equal((t1 * fresh.virtualSolReserves) / (fresh.virtualTokenReserves - t1) + 1n, 49_382_715n)
  // then a trader's 0.2 SOL got 6,995,831,125,658
  const after = { virtualTokenReserves: fresh.virtualTokenReserves - t1, virtualSolReserves: fresh.virtualSolReserves + 49_382_715n, realTokenReserves: fresh.realTokenReserves - t1 }
  assert.equal(T.quoteBuy(after, fees, 200_000_000n), 6_995_831_125_658n)
  // never more than the curve has left
  assert.equal(T.quoteBuy({ ...after, realTokenReserves: 5n }, fees, 200_000_000n), 5n)
})

test("pump.fun's mainnet accounts decode (fixtures)", () => {
  if (!existsSync(FIXTURES)) return 'skip: run node solana/scripts/fetch-fixtures.mjs'
  const read = a => Uint8Array.from(Buffer.from(JSON.parse(readFileSync(`${FIXTURES}${a}.json`, 'utf8')).data, 'base64'))
  const g = T.decodePumpGlobal(read(T.PUMP.global))
  assert.deepEqual([g.initialVirtualTokenReserves, g.initialVirtualSolReserves, g.initialRealTokenReserves, g.tokenTotalSupply], [1_073_000_000_000_000n, 30_000_000_000n, 793_100_000_000_000n, 1_000_000_000_000_000n])
  assert.equal(g.buybackFeeRecipients[0], T.PUMP.buyback)
  for (const b of g.buybackFeeRecipients) assert.ok(existsSync(`${FIXTURES}${b}.json`), `buyback recipient ${b} is a fixture account`)
  const fc = T.decodeFeeConfig(read(T.PUMP.feeConfig))
  assert.deepEqual(fc.flat, { lp: 0n, protocol: 95n, creator: 30n })
  assert.deepEqual(fc.tiers.map(t => [t.threshold, t.protocol, t.creator]), [[0n, 95n, 30n]])
  assert.ok(readdirSync(FIXTURES).length > 20)
})

// ---------- transactions ----------

/** An independent v0 parser: each instruction's accounts as [pubkey, signer, writable]. */
function parseV0(msg, tables) {
  assert.equal(msg[0], 0x80, 'version 0 prefix')
  const [nsig, nsro, nuro] = msg.subarray(1, 4)
  let at = 4
  const sv = () => { let n = 0; for (let s = 0; ; s += 7) { const b = msg[at++]; n |= (b & 0x7f) << s; if (!(b & 0x80)) return n } }
  const nkeys = sv()
  const statics = Array.from({ length: nkeys }, (_, i) => base58Encode(msg.subarray(at + 32 * i, at + 32 * i + 32)))
  at += 32 * nkeys + 32
  const ixs = Array.from({ length: sv() }, () => {
    const program = msg[at++]
    const accts = Array.from({ length: sv() }, () => msg[at++])
    const len = sv()
    const data = msg.slice(at, at + len)
    at += len
    return { program, accts, data }
  })
  const lookups = Array.from({ length: sv() }, () => {
    const k = base58Encode(msg.subarray(at, at + 32))
    at += 32
    const w = Array.from({ length: sv() }, () => msg[at++])
    const r = Array.from({ length: sv() }, () => msg[at++])
    return { k, w, r }
  })
  assert.equal(at, msg.length, 'no trailing bytes')
  const table = k => tables.find(t => t.key === k).addresses
  const loadedW = lookups.flatMap(l => l.w.map(i => table(l.k)[i]))
  const loadedR = lookups.flatMap(l => l.r.map(i => table(l.k)[i]))
  const all = [...statics, ...loadedW, ...loadedR]
  const writable = i => (i < nkeys ? (i < nsig ? i < nsig - nsro : i < nkeys - nuro) : i < nkeys + loadedW.length)
  return { statics, nsig, ixs: ixs.map(x => ({ programId: all[x.program], keys: x.accts.map(i => [all[i], i < nsig, writable(i)]), data: x.data })) }
}

test('v0: the launch fits with the lookup table, and every account resolves to what was asked', async () => {
  const table = { key: '7vLEZP2LHtgpuX5W2FjGqmJt9ygwM5UqCxD6NqG1o3BA', addresses: T.LAUNCH_LOOKUP_ADDRESSES }
  const mint = generateKeyPairSync('ed25519')
  const raw = Uint8Array.from(Buffer.from(mint.privateKey.export({ format: 'jwk' }).x, 'base64url'))
  const signer = { publicKey: base58Encode(raw), sign: async m => Uint8Array.from(edSign(null, Buffer.from(m), mint.privateKey)) }
  const launch = await T.launchTx({ payer: PAYER, name: 'escrow-e2e.test', tokenName: 'Escrow E2E', symbol: 'E2E', uri: 'https://example.com/e2e.json', buyLamports: 50_000_000n, mintKeypair: signer })
  // 1,295 bytes as a legacy transaction (launcher.rs measured 1,285 with example.com's shorter name)
  assert.throws(() => T.buildTransaction(launch, PAYER, SYSTEM_PROGRAM), /too large \(1295 bytes\).*lookup table/)
  const tx = T.buildTransaction({ ...launch, lookupTables: [table] }, PAYER, SYSTEM_PROGRAM)
  assert.equal(tx.length, 959, 'the size the validator reported for the same launch')
  const { msgAt, signers } = T.signersOf(tx)
  assert.deepEqual(signers, [PAYER, signer.publicKey])
  const parsed = parseV0(tx.subarray(msgAt), [table])
  assert.equal(parsed.ixs.length, launch.instructions.length)
  parsed.ixs.forEach((ix, i) => {
    const want = launch.instructions[i]
    assert.equal(ix.programId, want.programId)
    assert.equal(hex(ix.data), hex(want.data))
    const merged = new Map()
    for (const ins of launch.instructions) for (const k of ins.keys) { const m = merged.get(k.pubkey) || [false, false]; merged.set(k.pubkey, [m[0] || k.isSigner, m[1] || k.isWritable]) }
    ix.keys.forEach(([k, s, w], j) => {
      assert.equal(k, want.keys[j].pubkey, `ix ${i} account ${j}`)
      // the message carries each account's strongest flags across all instructions; the payer signs and pays
      const [ms, mw] = merged.get(k)
      assert.deepEqual([s, w], [ms || k === PAYER, mw || k === PAYER], `ix ${i} ${k} flags`)
    })
  })
  // invoked programs and signers never come from the table
  for (const p of [T.PROGRAM_ID, T.PUMP.program, ATA_PROGRAM, 'ComputeBudget111111111111111111111111111111', PAYER, signer.publicKey]) assert.ok(parsed.statics.includes(p), p)
  // the extra signer signs the exact message
  const signed = await T.addSignatures(tx, [signer])
  const sig = signed.subarray(1 + 64, 1 + 128)
  assert.ok(edVerify(null, Buffer.from(tx.subarray(msgAt)), mint.publicKey, Buffer.from(sig)))
  assert.equal(hex(signed.subarray(1, 65)), hex(new Uint8Array(64)), "the payer's slot stays for the wallet")
})

test('legacy when it fits; signatures in their slots; the transaction id', async () => {
  const kp = generateKeyPairSync('ed25519')
  const me = base58Encode(Buffer.from(kp.privateKey.export({ format: 'jwk' }).x, 'base64url'))
  const signer = { publicKey: me, sign: async m => Uint8Array.from(edSign(null, Buffer.from(m), kp.privateKey)) }
  const dep = await T.depositIx({ payer: me, name: NAME, amount: 5n })
  const tx = T.buildTransaction(dep, me, SYSTEM_PROGRAM)
  assert.equal(tx[0], 1)
  assert.ok(tx[65] < 0x80, 'legacy message')
  const signed = await T.addSignatures(tx, [signer])
  assert.equal(T.transactionId(signed), base58Encode(signed.subarray(1, 65)))
  assert.ok(edVerify(null, Buffer.from(signed.subarray(65)), kp.publicKey, Buffer.from(signed.subarray(1, 65))))
  await assert.rejects(T.addSignatures(tx, [{ publicKey: PAYER, sign: async () => new Uint8Array(64) }]), /does not sign/)
})

test('program errors from simulation data, from a message, and from a failed status', () => {
  assert.deepEqual(T.programError({ data: { err: { InstructionError: [1, { Custom: 6201 }] } } }), { code: 6201, name: 'StaleProof', message: "An older proof can't override a newer one", instruction: 1 })
  assert.equal(T.programError({ message: 'Transaction simulation failed: Error processing Instruction 0: custom program error: 0x183b' }).name, 'RefundLocked')
  assert.equal(T.programError({ transactionError: { InstructionError: [0, { Custom: 2006 }] } }).name, 'ConstraintSeeds')
  assert.equal(T.programError({ message: 'blockhash not found' }), null)
})

test('sendAll: the wallet signs, the extra signers sign after it, each transaction is confirmed in order', async () => {
  const kp = generateKeyPairSync('ed25519')
  const me = base58Encode(Buffer.from(kp.privateKey.export({ format: 'jwk' }).x, 'base64url'))
  const mintKp = generateKeyPairSync('ed25519')
  const extra = { publicKey: base58Encode(Buffer.from(mintKp.privateKey.export({ format: 'jwk' }).x, 'base64url')), sign: async m => Uint8Array.from(edSign(null, Buffer.from(m), mintKp.privateKey)) }
  const sent = []
  let statusCalls = 0
  handlers.getLatestBlockhash = () => ({ value: { blockhash: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', lastValidBlockHeight: 100 } })
  handlers.sendTransaction = ([b64]) => { sent.push(Uint8Array.from(Buffer.from(b64, 'base64'))); return 'x' }
  handlers.getSignatureStatuses = () => ({ value: [statusCalls++ % 2 ? { confirmationStatus: 'confirmed', err: null } : null] })
  handlers.getBlockHeight = () => 1
  // A Wallet Standard wallet that signs its slot.
  const wallet = {
    accounts: [{ address: me }],
    features: {
      'solana:signTransaction': {
        supportedTransactionVersions: ['legacy', 0],
        signTransaction: async ({ account, transaction, chain }) => {
          assert.equal(account.address, me)
          assert.equal(chain, 'solana:localnet')
          const { msgAt } = T.signersOf(transaction)
          const out = Uint8Array.from(transaction)
          out.set(edSign(null, Buffer.from(transaction.subarray(msgAt)), kp.privateKey), 1)
          return [{ signedTransaction: out }]
        },
      },
    },
  }
  const ix = { programId: SYSTEM_PROGRAM, keys: [{ pubkey: me, isSigner: true, isWritable: true }, { pubkey: extra.publicKey, isSigner: true, isWritable: true }], data: new Uint8Array(4) }
  const steps = []
  const sigs = await T.sendAll(wallet, [{ label: 'one', instructions: [ix], extraSigners: [extra] }, { label: 'two', instructions: [{ ...ix, keys: ix.keys.slice(0, 1) }] }], s => steps.push(`${s.index}:${s.status}`))
  assert.deepEqual(steps, ['0:signing', '0:sending', '0:confirming', '0:confirmed', '1:signing', '1:sending', '1:confirming', '1:confirmed'])
  assert.equal(sent.length, 2)
  assert.deepEqual(sigs, sent.map(T.transactionId))
  const { msgAt } = T.signersOf(sent[0])
  assert.ok(edVerify(null, Buffer.from(sent[0].subarray(msgAt)), kp.publicKey, Buffer.from(sent[0].subarray(1, 65))), 'wallet signature')
  assert.ok(edVerify(null, Buffer.from(sent[0].subarray(msgAt)), mintKp.publicKey, Buffer.from(sent[0].subarray(65, 129))), 'extra signature')

  // A failed transaction stops the run, with the program's reason and what landed before it.
  handlers.getSignatureStatuses = () => ({ value: [{ confirmationStatus: 'confirmed', err: { InstructionError: [0, { Custom: 6201 }] } }] })
  const err = await T.sendAll(wallet, [{ label: 'claim', instructions: [ix], extraSigners: [extra] }]).catch(e => e)
  assert.equal(err.programError.name, 'StaleProof')
  assert.equal(err.label, 'claim')
  assert.match(err.message, /older proof/)
  assert.equal(typeof err.signature, 'string')
  assert.deepEqual(err.signatures, [])
  // A launch handed over as bare instructions still goes out as v0 over the configured table.
  const table = { key: '7vLEZP2LHtgpuX5W2FjGqmJt9ygwM5UqCxD6NqG1o3BA', addresses: T.LAUNCH_LOOKUP_ADDRESSES }
  put(table.key, T.LOOKUP_TABLE_PROGRAM, cat(new Uint8Array(56), ...table.addresses.map(key)))
  handlers.getSignatureStatuses = () => ({ value: [{ confirmationStatus: 'confirmed', err: null }] })
  const launch = await T.launchTx({ payer: me, name: NAME, tokenName: 'Example', symbol: 'EX', uri: 'https://example.com/m.json', buyLamports: 50_000_000n })
  assert.deepEqual(launch.lookupTables, [], 'no table configured yet')
  T.configure({ lookupTables: [table.key] })
  sent.length = 0
  await T.sendAll(wallet, [{ instructions: launch.instructions, extraSigners: [launch.mintKeypair] }])
  assert.equal(sent[0][1 + 64 * sent[0][0]], 0x80, 'a v0 message')
  assert.deepEqual(T.signersOf(sent[0]).signers, [me, launch.mint])
  T.configure({ lookupTables: [] })
  // A wallet without version 0 can't take the launch.
  wallet.features['solana:signTransaction'].supportedTransactionVersions = ['legacy']
  await assert.rejects(T.sendAll(wallet, [{ ...launch, lookupTables: [table] }]), /version 0/)
  await assert.rejects(T.sendAll({ wallet: null, account: null }, []), /Connect a Solana wallet/)
})

test('proof steps are named without the trailing dot: root DNSKEY, com DS, cloudflare.com DNSKEY', async () => {
  const f = JSON.parse(readFileSync(`${root}solana/bench/fixtures/cloudflare.com.json`, 'utf8'))
  const steps = await P.stepsFromSets(f.sets.slice(0, 5))
  const txs = await T.proveStepsTxs({ payer: PAYER, steps, now: f.fetchedAt })
  assert.deepEqual(txs.map(t => t.label), ['Upload root DNSKEY (bytes 0 to 250)', 'Verify root DNSKEY', 'Verify com DS', 'Verify com DNSKEY, cloudflare.com DS', 'Verify cloudflare.com DNSKEY'])
})

test('a wallet proof for a synthetic Ed25519 zone: one precompiled transaction; an older one or a tie for another wallet refused', async () => {
  const domain = 'proof-test.example'
  const zone = generateKeyPairSync('ed25519')
  const pub = Uint8Array.from(Buffer.from(zone.privateKey.export({ format: 'jwk' }).x, 'base64url'))
  const dnskey = cat([1, 1, 3, 15], pub)
  // The zone's DNSKEY set, cached as the program would hold it (RrSet layout, as put_rrset writes it).
  const wire = P.nameToWire(domain)
  const parent = await T.pda.rrset(wire, P.TYPE_DNSKEY)
  const rdata = cat(u16le(dnskey.length), dnskey)
  put(parent, T.PROGRAM_ID, cat(disc('RrSet'), [255], u16le(48), [15], u16le(P.keyTag(dnskey)), i64le(1_799_000_000), i64le(1_900_000_000), new Uint8Array(32), u32le(wire.length), wire, u32le(rdata.length), rdata))
  const now = 1_800_000_000
  const leaf = async inception => {
    const rrsig = { typeCovered: 16, algorithm: 15, labels: 3, originalTtl: 300, expiration: inception + 86_400, inception, keyTag: P.keyTag(dnskey), signer: wire }
    const signed = P.encodeSigned(rrsig, P.nameToWire(`_wallet.${domain}`), 16, [cat([48], Buffer.from(`SOL ${WALLET}`))])
    return P.buildStep(signed, edSign(null, Buffer.from(signed), zone.privateKey))
  }
  const txs = await T.proveWalletTxs({ payer: PAYER, name: domain, steps: [await leaf(now - 300)], now })
  assert.equal(txs.length, 1)
  assert.deepEqual(txs.wallets, [WALLET])
  assert.equal(txs.type, 'TXT')
  assert.equal(txs.record, await T.pda.rrset(`_wallet.${domain}`, 16))
  const [ed, verify] = txs[0].instructions
  assert.equal(ed.programId, P.ED25519_PROGRAM)
  assert.equal(verify.programId, T.PROGRAM_ID)
  assert.deepEqual([...verify.data.subarray(0, 8)], [...sha('global:verify_rrset_precompiled').subarray(0, 8)])
  assert.deepEqual(verify.keys.map(k => k.pubkey), [PAYER, parent, txs.record, SYSTEM_PROGRAM, P.INSTRUCTIONS_SYSVAR])
  assert.equal(txs[0].label, `Verify _wallet.${domain} TXT`)
  await assert.rejects(T.proveWalletTxs({ payer: PAYER, name: domain, steps: [await leaf(now - 300)], now, wallet: PAYER }), /does not publish/)
  // The domain already used a newer proof: the client refuses before anything is signed.
  const hash = await T.domainHash(domain)
  put(await T.pda.domain(hash), T.PROGRAM_ID, domainData({ hash, lastProof: now - 100, name: domain }))
  await assert.rejects(T.proveWalletTxs({ payer: PAYER, name: domain, steps: [await leaf(now - 300)], now }), e => e.code === 'StaleProof')
  assert.equal((await T.proveWalletTxs({ payer: PAYER, name: domain, steps: [await leaf(now - 50)], now })).length, 1)
  // Signed at the same time as the last proof, which named another wallet: refused (TiedProof); a later
  // signature, or the wallet the domain already uses, is fine.
  put(await T.pda.domain(hash), T.PROGRAM_ID, domainData({ hash, lastProof: now - 300, wallet: PAYER, name: domain }))
  await assert.rejects(T.proveWalletTxs({ payer: PAYER, name: domain, steps: [await leaf(now - 300)], now }), e => e.code === 'TiedProof' && e.message.includes(PAYER))
  await assert.rejects(T.proveWalletTxs({ payer: PAYER, name: domain, steps: [await leaf(now - 300)], now, wallet: WALLET }), e => e.code === 'TiedProof')
  assert.equal((await T.proveWalletTxs({ payer: PAYER, name: domain, steps: [await leaf(now - 299)], now })).length, 1)
  put(await T.pda.domain(hash), T.PROGRAM_ID, domainData({ hash, lastProof: now - 300, wallet: WALLET, name: domain }))
  assert.equal((await T.proveWalletTxs({ payer: PAYER, name: domain, steps: [await leaf(now - 300)], now })).length, 1)
})

// ---------- run ----------

let failed = 0
for (const [name, fn] of Object.entries(tests)) {
  try {
    const r = await fn()
    console.log(typeof r === 'string' && r.startsWith('skip') ? `skip ${name} (${r.slice(6)})` : `ok   ${name}`)
  } catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.message}`) }
}
console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
