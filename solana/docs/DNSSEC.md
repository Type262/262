# DNSSEC verification on Solana

How the `type262` program proves, on-chain and from the IANA root keys down, which Solana wallet a domain
publishes, and the measurements that show it fits Solana's limits. It ports the rules of the Robinhood Chain
deployment (`DnssecVerifier` + ENS `DNSSECImpl`) and adds caching, because a whole proof does not fit in one
Solana transaction.

Everything below was measured on real proofs fetched from DNS with the same library the app uses, in LiteSVM
with the real secp256r1 and ed25519 precompiles. The benchmark crate is `solana/bench` (see
[Reproducing](#reproducing)).

## Summary

- A proof is verified one signed RRset per **step**. Each step checks one RRSIG against a parent set that is
  already verified (or, for the root DNSKEY set, against the IANA root DS anchors compiled into the program)
  and caches the result in a PDA. Later proofs reuse cached root, TLD and domain sets until they expire.
- **RSA (algorithm 8) runs in BPF.** Mainnet has no modexp syscall (`enable_big_mod_exp_syscall` is not
  active). A tuned Montgomery implementation verifies a real 2048-bit signature in **1.19M CU** and a full
  2048-bit step (root DNSKEY set, 844 signed bytes) in **1.20M CU** in the bench, and in **1.22M-1.25M CU**
  in the Anchor program, under the 1.4M per-transaction limit. A 1024-bit step costs **0.36M CU**.
  3072/4096-bit keys need the split form (2.5M / 4.3M CU over 4 / 5 instructions); no surveyed chain uses
  them. Keys under 1024 bits and the SHA-1 signature algorithms 5 and 7 are refused.
- **P-256 (algorithm 13) and Ed25519 (algorithm 15) cost almost nothing**: the native precompile checks the
  signature and the program finds that check through the instructions sysvar. A full step is
  **3.4k-5.5k CU**. The precompile only accepts low-S signatures and DNSSEC signers do not normalize (2 of
  the 4 P-256 signatures in the cloudflare.com chain are high-S), so the client normalizes S (both forms are
  valid ECDSA).
- **Transaction size**, not compute, decides the layout. Every real DS, DNSKEY and `_wallet` step fits a
  legacy 1232-byte transaction except RSA-signed sets over 617 signed bytes (root DNSKEY 844 B, `.org`/`.io`
  DNSKEY ~1030 B, `nasa.gov` DNSKEY 624 B), which go through a buffer account: 2 transactions each. Big apex
  TXT sets, which claims do not use, need the buffer (RSA) or a v1 transaction (P-256). Up to three P-256
  steps (domain DS + DNSKEY + `_wallet` TXT) fit one legacy transaction (1215 B). With v1 transactions
  (4096 B, active on mainnet) no real step needs a buffer.
- Every step of all six real chains (cloudflare.com, `_wallet.gemprotocol.io`, nlnetlabs.nl, ietf.org,
  nasa.gov, ed25519.nl) verified end to end in LiteSVM on SBPF v0 and v3, and tampered signatures, tampered
  messages, high-S signatures and mismatched precompile offsets were rejected.

Mainnet facts used here, read with read-only RPC calls on 2026-10-21 (slot ~459.7M):

| Feature / value | State |
| --- | --- |
| `enable_secp256r1_precompile` | active since slot 345,600,000 |
| `enable_big_mod_exp_syscall` | not activated (no feature account) |
| SBPF v1 / v2 / v3 deployment | active since slots 349,488,000 / 356,400,000 / 428,976,000 |
| `enable_tx_v1` (SIMD-0385, 4096-byte transactions) | active since slot 447,120,000 |
| Rent exemption | `(128 + bytes) × 5,080` lamports (650,240 for 0 bytes, 5,730,240 for 1,000) |
| Signature fee | 5,000 lamports per transaction signature **and** per precompile signature |

## Rules ported from the EVM verifier

The Robinhood Chain claim path is `DomainEscrow.claim` → `DnssecVerifier.verify` → ENS
`DNSSECImpl.verifyRRSet` (anchored to root DS 20326 and 38696, algorithms 5/7/8/13, digests 1/2, owner
renounced). The Solana program enforces the same rules per step. Stricter rules are marked *(stricter)*; none
rejects a real proof.

Signed data. Each proof set is `rrset` = RRSIG RDATA without the signature (type covered, algorithm, labels,
original TTL, expiration, inception, key tag, signer name) followed by the RRs in canonical wire form, and `sig`
= the RRSIG signature. These are exactly the bytes `dnsprovejs` `SignedSet.toWire()` produces and the EVM proof
carries, so the browser builds the same sets for both chains.

For every step:

1. Parse the RRSIG prefix (18 fixed bytes + signer name). Names must be uncompressed wire names with labels
   of 1-63 bytes and at most 255 bytes in total *(stricter: ENS does not bound them)*, and lowercase *(stricter:
   ENS leaves canonical case to the frontend; the signature covers the canonical form anyway, and lowercase
   keeps one PDA per name)*.
2. Every RR: class IN (`InvalidClass`), the same owner name as the first RR (`InvalidRRSet`), type equal to
   the RRSIG's type covered (`SignatureTypeMismatch`). At least one RR.
3. The owner's label count must equal the RRSIG labels field (`InvalidLabelCount`). This rejects wildcard
   expansions, as ENS does. NSEC/NSEC3 are not needed: only positive proofs exist.
4. Validity with RFC 1982 serial arithmetic against the cluster clock: `(expiration − now) as i32 ≥ 0`
   (`SignatureExpired`), `(now − inception) as i32 ≥ 0` (`SignatureNotValidYet`).
5. The owner must equal the signer name or be below it (`InvalidSignerName`). A DS set's signer must be a
   proper ancestor of its owner *(stricter: ENS accepts a DS set the zone signs at its own name)*: the DS
   RRset is authoritative only in the parent zone (RFC 4035 2.4, 5.2). Signed by the zone itself, a newer
   DS set would replace the delegation the parent publishes in the cache, so whoever holds one of the
   zone's keys (a former owner, a stolen ZSK) could keep the domain's chain on their keys.
6. The parent set is fixed by the data *(stricter: the program derives it, the caller cannot choose)*:
   a DNSKEY set whose owner equals its signer is checked against the **DS set at that name** (the root
   anchors for `.`); every other set against the **DNSKEY set at the signer name**. ENS likewise requires the
   proof's owner to equal the signer (`ProofNameMismatch`).
7. A key is usable only if protocol = 3, its algorithm equals the RRSIG algorithm, its key tag
   (RFC 4034 appendix B) equals the RRSIG key tag, the Zone flag (bit 7) is set and the Revoke flag (bit 8,
   RFC 5011) is clear (`verifySignatureWithKey`).
8. DS parent (`verifyWithDS`): some key in the set itself must verify the signature **and** match a DS
   record: same key tag, same algorithm, digest type 1 (SHA-1, 20 bytes) or 2 (SHA-256, 32 bytes) over
   `owner wire name ‖ DNSKEY RDATA` (`verifyKeyWithDS`). DNSKEY parent (`verifyWithKnownKey`): some key of the
   parent set verifies the signature.
9. Signature algorithms:
   - 8 RSASHA256: RFC 3110 key (1-byte exponent length, or 0 then 2 bytes), PKCS#1 v1.5. The whole encoded
     message must equal `00 01 FF…FF 00 DigestInfo H(rrset)` with at least 8 `FF` bytes, the same check as
     `RSAPKCS1Verify`. *(stricter)* modulus 1024-4096 bits, odd, no leading zero byte; exponent 1-4 bytes and
     ≥ 3; signature exactly as long as the modulus and smaller than it. A 512-bit modulus can be factored in
     hours on rented hardware, and whoever factors a zone's key can sign any record under it. Every RSA key
     in the fixtures uses exponent 65537, and the survey below found only 1024-2048-bit keys.
   - 13 ECDSAP256SHA256: key RDATA exactly 68 bytes (4 header + x ‖ y), through the secp256r1 precompile.
   - 15 Ed25519 *(new: ENS has no verifier for it)*: key RDATA exactly 36 bytes, through the ed25519
     precompile.
   - 5 RSASHA1 and 7 RSASHA1-NSEC3-SHA1 are rejected (`UnsupportedAlgorithm`) *(stricter: ENS accepts
     them)*. SHA-1 has practical chosen-prefix collisions: a shared zone that signs TXT content its users
     shape, with predictable RRSIG headers, could be made to sign one message whose signature also fits a
     `_wallet` set for another name in the zone. None of the six real chains uses them (only 8, 13 and 15),
     and operators are moving off them. DS digest type 1 (SHA-1) stays accepted: only the child zone
     computes that digest.
   - Anything else (10 RSASHA512, 14 ECDSAP384SHA384, 16 Ed448, DSA, GOST) is rejected, as on EVM.
10. The parent must still be valid: `now ≤ parent.expires_at` *(new, see [cache rules](#cache-rules))*.

The wallet record (claim side, mirrors `DnssecVerifier.verify` and `walletAddress`):

- Accepted sets: `WALLET` (RRTYPE 262) at the domain itself, or `TXT` at `_wallet.<domain>`. Nothing else: a
  TXT at the apex, other names and other types are ignored.
- The claim names a `recipient` and succeeds if **any** record in the set publishes it, like
  `verify(domain, recipient, proof)`. Other lines (`ETH 0x…`, notes, a second `SOL` line) are ignored, so one
  `_wallet` RRset can carry both an EVM and a Solana line.
- RDATA shapes, same as EVM: two character-strings `"SOL" "<base58>"`, or one `"SOL <base58>"` /
  `"SOL:<base58>"` where any run of spaces and colons separates the parts. Coin `SOL`, any letter case.
  Nothing after the address. Three or more strings are rejected.
- Address: base58 that decodes to exactly 32 bytes (each leading `1` is one leading zero byte, as `bs58`
  decodes into `[u8; 32]`); the all-zero key (the System Program) is rejected, like `address(0)` on EVM.
  Off-curve addresses (PDAs, multisig vaults) are allowed.
- Signing time for "an older proof can never override a newer one": the leaf's `signed_at`, the RRSIG
  inception counted back from now exactly like `DnssecVerifier.signedAt`. The escrow keeps the newest
  `signed_at` used per domain and rejects older ones (`StaleProof`), including for a claim that moves nothing
  (register).
- Ties on signing time *(stricter)*: a record whose `signed_at` equals the domain's last proof can only name
  the wallet that proof recorded (`TiedProof`). See [Changing the wallet](#changing-the-wallet).
- The wallet must be an address someone can sign for *(new)*: claim and register refuse an account owned by
  the SPL Token or Token-2022 program (a token account or a mint) or an executable one (`BadRecipient`).
  Tokens claimed to a token account would land in that account's own associated token account, which no
  key can ever move, and anyone can send a claim.

### Changing the wallet

A rotation (a leaked key, a domain sale) is complete once a record with a **strictly later** signing time
(RRSIG inception) is registered or claimed with. From then on every older record is refused (`StaleProof`).

Some signers give every signature of a period the same inception (PowerDNS Authoritative, for one, starts a
whole week's signatures at the same instant), so the old and the new wallet record can carry the same
`signed_at`. No rule on `signed_at` alone settles that tie both ways, so the escrow keeps the wallet
registered first:

- If the new wallet is registered (or claimed to) first at that signing time, the old record can never claim
  again, even at the same signing time (`TiedProof`).
- If the old wallet was registered or claimed at that signing time first, it keeps the domain until the zone
  signs the new record with a later inception; registering that record then completes the rotation.
- The cache takes the zone's current set either way: a set signed at the same time as the cached one replaces
  it when its records differ (see [cache rules](#cache-rules)).

So after changing the wallet record, register the new wallet as soon as the zone serves the new record, and
check that the domain's last proof names it; if it still names the old wallet, register again once the zone
has re-signed. The app checks this before proving (`proveWalletTxs` refuses a tie for another wallet).

`solana/bench/src/dnssec.rs` is the reference the program was ported from (`parse_signed`, `verify_step`,
`replaces`, `publishes`); unit tests cover names, anchors and the wallet parser. The program is stricter than
the bench where this section says so: DS signers, RSA key sizes, algorithms 5/7, ties and wallet accounts.

## Step design

```
IANA root DS 20326, 38696 (in the program)
└─ step  . DNSKEY            parent: anchors           RSA-2048, 844 B  → PDA rrset(., DNSKEY)
   └─ step  com. DS          parent: rrset(., DNSKEY)  RSA-2048         → PDA rrset(com., DS)
      └─ step  com. DNSKEY   parent: rrset(com., DS)   P-256            → PDA rrset(com., DNSKEY)
         └─ … domain DS, domain DNSKEY …
            └─ step  _wallet.<domain> TXT              → PDA rrset(_wallet.<domain>., TXT)
                                                         ← read by escrow claim / register
```

One step = one instruction. Several steps may share a transaction (they run in order, so a step can use the
PDA written by the step before it in the same transaction). The program derives every PDA from the signed data,
so a step can only ever write the set it proves and read the parent DNSSEC requires.

### Instructions

Anchor-style; sizes below are computed for exactly these layouts.

| Instruction | Data (borsh) | Accounts | Use |
| --- | --- | --- | --- |
| `verify_rrset` | `signed: Vec<u8>, sig: Vec<u8>` | payer (signer, w), parent `RRset` (none for the root DNSKEY set), result `RRset` PDA (w), system program, instructions sysvar | RSA steps that fit inline |
| `verify_rrset_precompiled` | `signed: Vec<u8>` (starts at byte 12 of the data) | same | P-256 / Ed25519 steps |
| `write_buffer` | `offset: u32, bytes: Vec<u8>` | payer (signer, w), buffer PDA `["buffer", payer]` (w, created or grown to `offset + len`), system program | upload of a large RSA step |
| `verify_rrset_buffered` | none | as `verify_rrset` + buffer PDA (w, closed to payer afterwards) | RSA step whose `signed`/`sig` are in the buffer as `[u32 len, signed, u32 len, sig]` |
| `close_rrset` | none | rrset PDA (w), its recorded payer (w) | anyone, once `now > expires_at`: returns the rent |
| `rsa_begin`, `rsa_advance(squarings: u8)` | key source + buffer | state PDA `["rsa", payer]` | only for RSA keys > 2048 bits ([split RSA](#rsa-in-bpf)) |

`verify_rrset_precompiled` needs a secp256r1 (algorithm 13) or ed25519 (algorithm 15) precompile instruction
in the same transaction with an entry whose

- message is `message_instruction_index` = this instruction's index, `message_data_offset` = 12,
  `message_data_size` = `signed.len()`, so the precompile hashes and checks the very bytes the program parses,
  without a second copy in the transaction;
- public key is the signing DNSKEY: for P-256 the 33-byte compressed point `[0x02 | (y[31] & 1)] ‖ x` with
  `x ‖ y` = RDATA[4..68]; for Ed25519 RDATA[4..36].

The program scans every precompile instruction and entry (`introspect::precompile_find`), so the client does
not pass indexes. A transaction fails as a whole if any precompile entry fails, so finding the entry proves the
signature. The signature bytes themselves never reach the program. Precompile data layout (SIMD-0075 and the
ed25519 program share it): `[count u8, 0u8]`, then per signature seven `u16` LE: signature offset, signature
instruction index, public key offset, public key instruction index, message offset, message size, message
instruction index (`u16::MAX` = the precompile instruction itself), then the keys and signatures.

### Account layouts

`RRset` PDA, seeds `["rrset", sha256(owner wire name), rrtype as u16 BE]`:

| Field | Bytes | Notes |
| --- | --- | --- |
| discriminator | 8 | Anchor |
| bump | 1 | |
| rrtype | 2 | u16 |
| algorithm | 1 | RRSIG algorithm |
| key_tag | 2 | RRSIG key tag |
| signed_at | 8 | i64 unix: RRSIG inception counted back from now |
| expires_at | 8 | i64 unix: min(RRSIG expiration, parent.expires_at) |
| payer | 32 | gets the rent back when an expired entry is closed |
| owner | 4 + L | owner name, canonical wire form |
| rdata | 4 + Σ(2 + len) | each record as `[u16 LE length, RDATA]`, canonical order |

Size = `70 + L + Σ(2 + rdlen)`. Real sets:

| Set | Records | Account | Rent (SOL) | Shared by |
| --- | --- | --- | --- | --- |
| `. DNSKEY` | 3 (RSA-2048 ×3) | 869 B | 0.00506 | every proof |
| `com. DS` / `nl. DS` / `org. DS` | 1 | 112-113 B | 0.00122 | every domain in the TLD |
| `com. DNSKEY` | 2 (P-256) | 215 B | 0.00174 | every `.com` domain |
| `org. DNSKEY` / `io. DNSKEY` | 5 (RSA 1024/2048) | 1021 / 1020 B | 0.00584 | every `.org` / `.io` domain |
| `cloudflare.com. DS` | 1 | 124 B | 0.00128 | that domain |
| `cloudflare.com. DNSKEY` | 2 (P-256) | 226 B | 0.00180 | that domain |
| `gemprotocol.io. DNSKEY` | 2 (RSA) | 490 B | 0.00314 | that domain |
| `_wallet.<domain> TXT` with one `SOL` line | 1 | ~145 B (for `cloudflare.com`) | ~0.00139 | that domain |

So a domain's own cache costs about 0.0045 SOL of rent (P-256 zone) or 0.0058 SOL (RSA zone), refundable by
`close_rrset` after expiry. Root and TLD entries are created once by the first claimant; refreshing an entry
later costs only transaction fees (plus rent for any growth).

Buffer PDA `["buffer", payer]`: discriminator + content; lives for two transactions and is closed to the payer
by `verify_rrset_buffered`. For the root DNSKEY step it holds 1,108 bytes (~0.0063 SOL, returned).

RSA state PDA `["rsa", payer]` (split RSA only): limbs count, bits left, exponent, `n0`, then modulus, base and
accumulator as u32 limbs (`12 + 12·⌈bytes/4⌉`, 1,548 B for 4096-bit) plus the sha256 of the key RDATA and of
the signature it belongs to.

### Cache rules

- `signed_at = now − ((now as u32) − inception)` and `expires_at = min(now + (expiration − (now as u32)) as i32,
  parent.expires_at)`. The root anchors never expire.
- A step needs `now ≤ parent.expires_at`, and a claim needs `now ≤ leaf.expires_at`. Because `expires_at` is
  the minimum over the whole chain and every inception was ≤ the verification time, a claim at time T is
  accepted exactly when every signature in the chain it relies on is valid at T: the same condition as
  verifying the whole chain at T on EVM.
- A new result replaces a cached one only if it was signed later, or signed at the same time but with other
  records (the zone's current set, see below) or valid longer (same RRSIG re-checked against a refreshed
  parent), or the cached one has expired. Otherwise the step succeeds without writing. So nobody can roll a
  cache entry back to older data while the newer entry is valid, and concurrent claimants never fail on each
  other's refreshes (`dnssec::wire::replaces`, tested).
- Ties *(new)*: signers that give every signature of a period the same inception and expiration (PowerDNS
  Authoritative uses the start of the week) make an old and a new version of a set tie exactly, after a wallet
  change or a key or DS rollover within one period. A tie with other records replaces the cached set, so the
  zone's current set can always be cached and records signed by a new key verify. Both versions are validly
  signed, so either can be proved again while both are unexpired; the escrow does not depend on which one
  the cache holds ([Changing the wallet](#changing-the-wallet)).
- On replacement the account is reallocated to the new size; the refresher pays any increase.
- Validity windows in the fixtures: root DNSKEY 21 days, TLD DS sets 13 days, TLD DNSKEY sets 15-61 days,
  domain DS/DNSKEY sets 2-61 days, and ~2 days for some leaves (cloudflare.com and ietf.org TXT, which
  Cloudflare signs on the fly; `nasa.gov` DS from `.gov` is also ~2 days). So root and TLD steps are refreshed
  by about one claim per TLD every week or two, and a leaf from such a host must be claimed within a day or two
  of being verified, the same window EVM proofs have.

## RSA in BPF

`solana/bench/src/bigint.rs`. Montgomery multiplication on u32 limbs with u64 products (SBPF v0 has a 64-bit
multiply but no 64×64→128):

- `mac` (row multiply-accumulate) works on chunks of 8 limbs with a constant trip count, which LLVM turns into
  straight-line `ldxw / mul64 / add64 / stxw / rsh64` with fixed offsets: ~7.6 instructions per limb product.
- Squarings sum each cross product once and double it, then reduce (1.5 s² products instead of 2 s²). The one
  multiply by the base uses CIOS with the work window sliding through a 2s+2 limb buffer instead of shifting.
- The base enters Montgomery form with one long division (`s·R mod n`, Knuth algorithm D) instead of computing
  `R² mod n`.
- Exponent 65537 = 16 squarings + 1 multiply + 1 final reduction. Buffers are on the heap (SBPF v0 stack
  frames are 4 KB); no stack warnings in the build.
- The full encoded message is rebuilt and compared byte for byte, including every padding byte.

Measured (SBPF v0, LiteSVM, whole-transaction CU; a compute-budget + no-op transaction costs 253):

| RSA verify (modexp + PKCS#1 + hash) | Bits | u32 limbs | u64 limbs |
| --- | --- | --- | --- |
| synthetic, e = 65537, SHA-256 | 1024 | 358,996 | 553,338 |
| synthetic, e = 65537, SHA-256 | 2048 | 1,186,301 | > 1.4M |
| synthetic, e = 3, SHA-256 | 2048 | 293,469 | 437,894 |
| synthetic, e = 65537, SHA-1 (alg 5, bench only: the program refuses 5 and 7) | 2048 | 1,206,282 | > 1.4M |
| synthetic | 3072, 4096 | > 1.4M (use split) | > 1.4M |
| real: root KSK 38696 over `. DNSKEY` (844 B) | 2048 | 1,188,376 | > 1.4M |
| real: root ZSK 8763 over `com. DS` | 2048 | 1,184,973 | > 1.4M |
| real: `.io` KSK 57355 over `io. DNSKEY` (1028 B) | 2048 | 1,189,105 | > 1.4M |
| real: `.org` KSK 26974 over `org. DNSKEY` (1034 B) | 2048 | 1,189,141 | > 1.4M |
| real: `.io` ZSK 43371 over `gemprotocol.io. DS` | 1024 | 358,645 | 552,854 |
| real: ZSK 22479 over `_wallet.gemprotocol.io TXT` | 1024 | 355,608 | 551,873 |
| real: `.org` ZSK 25488 over `ietf.org. DS` | 1024 | 357,750 | 553,400 |

A first, plain CIOS version (no unrolling, no squaring shortcut) took 546,467 CU for 1024 bits and did not fit
2048 bits; the optimizations above brought 2048 bits to 1.19M. SBPF v3 gives the same RSA numbers within 0.2%
(1,184,604 for the 2048-bit vector; every step within 1%) and u128 products stay slower on v3 with
platform-tools v1.54, so the program can keep the default `--arch v0`.

Building blocks (v0, CU each):

| Bits | Long division | Square | Multiply | Reduce |
| --- | --- | --- | --- | --- |
| 1024 | 30,910 | 18,685 | 19,603 | 9,511 |
| 2048 | 112,951 | 59,046 | 68,770 | 34,503 |
| 3072 | 245,370 | 124,138 | 150,308 | 75,111 |
| 4096 | 429,493 | 216,100 | 266,910 | 131,335 |

**Split RSA** (`bigint::split`, run in LiteSVM): `start` (checks + long division) → `advance(k)` (k exponent
bits per instruction) → `finish` (reduce + PKCS#1 compare), state in an account. Measured with as many
squarings per instruction as fit 1.3M CU:

| Bits | Instructions | CU per instruction | Total |
| --- | --- | --- | --- |
| 1024 | 3 | 38,240 / 312,088 / 13,936 | 364,264 |
| 2048 | 3 | 126,521 / 1,026,280 / 42,256 | 1,195,057 |
| 3072 | 4 | 265,180 / 1,249,322 / 908,750 / 86,192 | 2,509,444 |
| 4096 | 5 | 455,543 / 1,289,719 / 1,286,131 / 1,127,959 / 145,744 | 4,305,096 |

A wrong signature run through the same split is rejected at `finish`. In the program, the state also records
the hashes of the key RDATA and signature, and `verify_rrset_buffered` accepts a finished state only for the
key and signature of the step it verifies. Packing `start` with the first squarings and `finish` with the last
ones brings 4096 bits to 4 transactions. Real chains have not needed it: the survey found RSA keys of 1024,
1280, 1536 and 2048 bits only.

Headroom: a full RSA-2048 step in the bench uses 1.20M CU. In the Anchor program (LiteSVM, `dnssec_real`,
whole transaction) the real RSA-2048 steps take 1,221,637-1,230,965 CU inline (`. DS` sets, 69-70 signed
bytes; `gemprotocol.io. DNSKEY`, 486 bytes) and 1,240,165-1,249,018 CU through the buffer (root, `.io` and
`.org` DNSKEY sets); the root DNSKEY step with its last chunk written in the same transaction takes 1,254,839
CU. That leaves at least ~145k CU under the 1.4M limit. If a step ever goes above it, use the split path for
2048-bit keys too (3 instructions, 1.2M CU in all).

## Precompiles, digests

| Check | CU (whole tx) |
| --- | --- |
| P-256 precompile + introspection (real `com. DNSKEY`, 189 B) | 798 |
| Ed25519 precompile + introspection (synthetic, 207 B) | 785 |
| SHA-1 in BPF over owner + 2048-bit DNSKEY (265 B, DS digest type 1) | 27,509 |
| SHA-256 syscall over the same (DS digest type 2) | 774 |

- Low S: in the real cloudflare.com chain 2 of the 4 P-256 signatures have `s > n/2`. Sent as is, the
  precompile rejects them (`InstructionError(1, Custom(2))`, invalid signature, observed). The client replaces
  `s` with `n − s`, `n = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551`; the result is
  the same valid ECDSA signature in its other form.
- Rejected in the tests: a flipped message byte (precompile fails) and an entry whose message offset or length
  differs from the bytes the program parses (program fails).
- The secp256r1 precompile hashes the message with SHA-256 itself, so the message must be inside the
  transaction. That is why P-256 steps cannot use the buffer.

## Real proofs

Fetched on 2026-10-21 through Cloudflare DNS-over-HTTPS with the pinned `dnsprovejs` 1.0.1 bundle the app
ships (`solana/bench/proofs/dump.mjs`; `contracts/script/make-proof.mjs` gives the same 6 sets, algorithms
8,8,8,8,8,8 for `_wallet.gemprotocol.io`). Fixtures in `solana/bench/fixtures/`. The bench replays them at the
time they were fetched, so they keep verifying after the signatures expire.

Columns: algorithm, key bits, signed bytes (RRSIG prefix + RRs), signature bytes, exact size of the production
transaction with the step inline (legacy and v1), CU measured for the full step (rules + signature + cache
write), and how it is sent. `buffer` = too big for a legacy transaction, uploaded first. `v1 only` = a P-256
message too big for a legacy transaction.

**cloudflare.com TXT** (apex TXT, 29 records; the EVM test fixture's domain)

| Step | Alg | Key | Signed | Sig | Legacy B | v1 B | CU | Mode |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `. DNSKEY` (self-signed, root anchors) | 8 | 2048 | 844 | 256 | 1459 | 1427 | 1,202,037 | buffer |
| `com. DS` | 8 | 2048 | 70 | 256 | 685 | 653 | 1,189,326 | inline |
| `com. DNSKEY` | 13 | 256 | 189 | 64 | 652 | 661 | 5,233 | inline |
| `cloudflare.com. DS` | 13 | 256 | 85 | 64 | 547 | 557 | 3,396 | inline |
| `cloudflare.com. DNSKEY` | 13 | 256 | 222 | 64 | 685 | 694 | 5,500 | inline |
| `cloudflare.com. TXT` | 13 | 256 | 2936 | 64 | 3399 | 3408 | 11,403 | v1 only |

**_wallet.gemprotocol.io TXT** (a real `_wallet` record, RSA all the way: `"ETH 0x7edB…E81f"`)

| Step | Alg | Key | Signed | Sig | Legacy B | v1 B | CU | Mode |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `. DNSKEY` | 8 | 2048 | 844 | 256 | 1459 | 1427 | 1,202,037 | buffer |
| `io. DS` | 8 | 2048 | 69 | 256 | 684 | 652 | 1,190,742 | inline |
| `io. DNSKEY` (5 keys) | 8 | 2048 | 1028 | 256 | 1643 | 1611 | 1,202,305 | buffer |
| `gemprotocol.io. DS` | 8 | 1024 | 84 | 128 | 571 | 539 | 361,755 | inline |
| `gemprotocol.io. DNSKEY` | 8 | 2048 | 486 | 256 | 1101 | 1069 | 1,192,135 | inline |
| `_wallet.gemprotocol.io. TXT` | 8 | 1024 | 115 | 128 | 602 | 570 | 358,817 | inline |

**nlnetlabs.nl TXT** (P-256 TLD, RSA below it)

| Step | Alg | Key | Signed | Sig | Legacy B | v1 B | CU | Mode |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `. DNSKEY` | 8 | 2048 | 844 | 256 | 1459 | 1427 | 1,202,037 | buffer |
| `nl. DS` | 8 | 2048 | 69 | 256 | 684 | 652 | 1,189,219 | inline |
| `nl. DNSKEY` | 13 | 256 | 186 | 64 | 649 | 658 | 5,210 | inline |
| `nlnetlabs.nl. DS` | 13 | 256 | 82 | 64 | 544 | 554 | 3,373 | inline |
| `nlnetlabs.nl. DNSKEY` | 8 | 2048 | 480 | 256 | 1095 | 1063 | 1,198,009 | inline |
| `nlnetlabs.nl. TXT` | 8 | 1024 | 283 | 128 | 770 | 738 | 360,739 | inline |

**ietf.org TXT** (RSA TLD with 5 keys, P-256 below)

| Step | Alg | Key | Signed | Sig | Legacy B | v1 B | CU | Mode |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `. DNSKEY` | 8 | 2048 | 844 | 256 | 1459 | 1427 | 1,202,037 | buffer |
| `org. DS` | 8 | 2048 | 70 | 256 | 685 | 653 | 1,189,144 | inline |
| `org. DNSKEY` (5 keys) | 8 | 2048 | 1034 | 256 | 1649 | 1617 | 1,205,317 | buffer |
| `ietf.org. DS` | 8 | 1024 | 79 | 128 | 566 | 534 | 360,825 | inline |
| `ietf.org. DNSKEY` | 13 | 256 | 204 | 64 | 667 | 676 | 5,374 | inline |
| `ietf.org. TXT` | 13 | 256 | 507 | 64 | 970 | 979 | 4,439 | inline |

**nasa.gov TXT** (large RSA-signed leaf)

| Step | Alg | Key | Signed | Sig | Legacy B | v1 B | CU | Mode |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `. DNSKEY` | 8 | 2048 | 844 | 256 | 1459 | 1427 | 1,202,037 | buffer |
| `gov. DS` | 8 | 2048 | 70 | 256 | 685 | 653 | 1,189,257 | inline |
| `gov. DNSKEY` | 13 | 256 | 189 | 64 | 652 | 661 | 5,231 | inline |
| `nasa.gov. DS` | 13 | 256 | 79 | 64 | 541 | 551 | 3,354 | inline |
| `nasa.gov. DNSKEY` | 8 | 2048 | 624 | 256 | 1239 | 1207 | 1,192,236 | buffer |
| `nasa.gov. TXT` (22 records) | 8 | 1024 | 1841 | 128 | 2328 | 2296 | 367,341 | buffer |

**ed25519.nl A** (Ed25519 zone)

| Step | Alg | Key | Signed | Sig | Legacy B | v1 B | CU | Mode |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `. DNSKEY` | 8 | 2048 | 844 | 256 | 1459 | 1427 | 1,202,037 | buffer |
| `nl. DS` | 8 | 2048 | 69 | 256 | 684 | 652 | 1,189,219 | inline |
| `nl. DNSKEY` | 13 | 256 | 186 | 64 | 649 | 658 | 5,210 | inline |
| `ed25519.nl. DS` | 13 | 256 | 80 | 64 | 542 | 552 | 3,359 | inline |
| `ed25519.nl. DNSKEY` | 15 | 255 | 146 | 64 | 608 | 617 | 4,341 | inline |
| `ed25519.nl. A` | 15 | 255 | 56 | 64 | 517 | 527 | 3,058 | inline |

All six leaves ended up verified and cached. The same tables on SBPF v3 differ by under 1%.

TLD survey (DNSKEY set signed bytes, keys as tag/algorithm/bits): `.de` 450 B (1024 ZSK, 2048 KSK), `.uk` 578 B,
`.jp` 450 B, `.ru` 450 B, `.app` 453 B, `.xyz` 453 B, `.us` 482 B (1280 ZSK), `.eu` 600 B, `.au` 578 B,
`.co` 910 B (1280 + 1024 ZSKs), `.me` 1028 B, `.ai` 878 B, `.org` 1034 B, `.io` 1028 B: all RSA-2048 KSKs.
`.com`, `.net`, `.gov`, `.nl`, `.fr`, `.ch`, `.ca`, `.br`, `.cz` are P-256 (DS signed by the root's RSA ZSK).
RSA-signed sets up to 617 signed bytes go inline; larger ones (`.co`, `.me`, `.ai`, `.org`, `.io`, the root)
use the buffer.

### What fits where (legacy transactions)

- **P-256 / Ed25519 step**: inline whenever the transaction stays ≤ 1232 B, i.e. up to ~770 signed bytes for a
  single step. The precompile entry points into our own instruction data, so the signed set is in the
  transaction once. Every real DS, DNSKEY and `_wallet` set qualifies; only large apex TXT sets (cloudflare.com,
  2936 B) do not, and those are not what a claim proves. With a v1 transaction even that fits (3408 B).
- **Several P-256 steps per transaction**, one precompile instruction with an entry per step, exact sizes:
  domain DS + DNSKEY 934 B, DNSKEY + `_wallet` TXT 967 B, **DS + DNSKEY + `_wallet` TXT 1215 B** (cloudflare.com
  with a 117-byte `"SOL <base58>"` leaf). Running cloudflare.com DS + DNSKEY together in one transaction cost
  8,920 CU. Long domain names add their length to every set, so the client checks the size and splits when
  needed.
- **RSA step**: inline up to 617 signed bytes with a 2048-bit signature (745 with 1024-bit): the transaction is
  615 B + signed bytes (2048-bit) or 487 B + signed bytes (1024-bit). One RSA-2048 step per transaction (CU);
  a 1024-bit step (0.36M CU) can share a transaction with P-256 steps.
- **Buffered RSA step**: `write_buffer` carries up to 979 bytes per transaction, and the last 826 bytes can ride
  in the verify transaction itself (`[compute limit, write_buffer, verify_rrset_buffered]`; the verify alone is
  383 B). Root DNSKEY (1,108-byte payload), `.io`/`.org` DNSKEY (~1,295) and `nasa.gov. DNSKEY` (888) take
  **2 transactions**; `nasa.gov` TXT (1,977) takes 3.
- A priority fee (`SetComputeUnitPrice`) adds 12 bytes to a transaction that already has a compute-limit
  instruction (RSA steps) and 44 bytes (program key + instruction) to one that does not (P-256 steps). The
  1215-byte three-step packing then no longer fits and splits into two transactions.

Transactions per claim, legacy, before the claim itself:

| Domain type | Cold cache | Root + TLD cached | Domain cached too |
| --- | --- | --- | --- |
| P-256 zone under `.com` (cloudflare-style) | 5: root 2, com DS 1, com DNSKEY + domain DS 1, domain DNSKEY + `_wallet` 1 | 1 (DS + DNSKEY + `_wallet`, 1215 B) | 1 (`_wallet` only) |
| RSA zone under `.io` (gemprotocol-style) | 8: root 2, io DS 1, io DNSKEY 2, DS 1, DNSKEY 1, `_wallet` 1 | 3 | 1 |

With v1 transactions the buffer disappears and P-256 steps pack further; RSA-2048 steps stay one per
transaction because of compute.

## Client sequence (browser)

1. **Build the proof** as today: `DNSProver.create('https://cloudflare-dns.com/dns-query')
   .queryWithProof('TXT', '_wallet.' + domain)` with the pinned dnsprovejs. Pass an algorithm table that also
   lists 15 (`{ name: 'ED25519', f: () => true }`), since the default table lacks it
   (`solana/bench/proofs/dump.mjs` shows how). Each set gives `signed = set.toWire()` and
   `sig = set.signature.data.signature`.
2. **Check the record first**: the leaf must contain `SOL <base58>` for the wallet the user expects; stop
   otherwise.
3. **Find what is cached**: for each set compute its PDA `["rrset", sha256(owner wire), type u16 BE]`, then
   read them all with one `getMultipleAccounts`. Skip a step when its cached entry holds the same records as
   the proof's set and `cached.expires_at` is comfortably in the future (e.g. ≥ now + 10 minutes). Re-verify
   otherwise: a changed set (key rollover, new DS) has a newer signature and replaces the entry. Always
   re-verify the leaf if its cached `signed_at` is older than the escrow's last proof for the domain. Hosts
   that sign on the fly (Cloudflare) return a fresh RRSIG on every query; an equal cached set is still reused.
4. **Prepare each remaining step**:
   - P-256: find the signing key in the parent DNSKEY set (or the set itself when self-signed) by key tag and
     algorithm, compress it, normalize S, and add a precompile entry pointing at offset 12 of the step's
     instruction data. Ed25519: raw key, signature as is.
   - RSA: inline if the transaction fits, else `write_buffer` chunks followed by
     `[SetComputeUnitLimit(1.4M), write_buffer(last chunk), verify_rrset_buffered]`.
   - RSA steps get `SetComputeUnitLimit(1_400_000)`; P-256-only transactions need no limit change.
5. **Pack** consecutive P-256/Ed25519 steps into one transaction while it stays ≤ 1232 B (serialize and
   measure). Keep RSA-2048 steps alone.
6. **Sign everything at once** (`signAllTransactions`), then send in chain order, waiting for each to confirm
   before the next (each step reads the PDA the previous one wrote). Buffer chunks of one step can be sent in
   parallel. A step that finds a fresher entry already cached succeeds without writing, so two people claiming
   at once do not break each other.
7. **Claim or register** with the escrow, which reads the leaf PDA, checks owner name and type, `now ≤
   expires_at`, `signed_at ≥ last proof` (and on a tie the wallet the last proof named), that the set publishes
   the recipient, and that the recipient is not a token account, a mint or a program. If it fits, put the leaf
   step and the claim in the same transaction.

Fees: 5,000 lamports per transaction plus 5,000 per precompile signature (so the 3-step P-256 transaction costs
20,000 lamports), plus priority fees and the rent above.

## Reproducing

```sh
# proofs (Node >= 20.19); dump.mjs uses the pinned bundle in assets/vendor
node solana/bench/proofs/dump.mjs TXT _wallet.gemprotocol.io solana/bench/fixtures/_wallet.gemprotocol.io.json
node solana/bench/proofs/rsa-vectors.mjs > solana/bench/fixtures/synthetic.json   # fresh throwaway keys

# build the program for SBPF v0 and v3 (works on Windows: cargo-build-sbf 4.1.0, platform-tools v1.54)
SKIP_TEST=1 solana/bench/run.sh

# unit tests + LiteSVM benchmark (Linux or WSL; see below)
SKIP_BUILD=1 solana/bench/run.sh
```

LiteSVM 0.16.0 needs its `precompiles` feature for secp256r1, which builds OpenSSL from source through
`agave-precompiles`. That build fails on Windows with Git's Perl (missing `Locale::Maketext::Simple`), so the
tests run in WSL Ubuntu (cargo 1.96); the program itself builds on Windows. The first WSL build takes about 9
minutes, later runs a few seconds. `run.sh` keeps host builds under `target/host-<OS>` so the two systems never
share artifacts.

## Limits and open points

- The Anchor program's RSA-2048 steps cost ~30k-50k CU more than the bench's (see [RSA in BPF](#rsa-in-bpf)):
  at least ~145k CU of headroom remains. Fall back to split RSA if needed.
- A P-256 or Ed25519 set larger than ~770 signed bytes needs a v1 transaction. `_wallet` and `WALLET` sets are
  ~120 bytes, so this only matters for unusual leaves.
- Wallet support for v1 transactions is not verified; the design works with legacy transactions alone.
- RSA keys under 1024 or above 4096 bits, or exponents above 32 bits, are rejected (EVM accepts them); none
  were seen.
- SHA-1 in BPF costs ~5.5k CU per 64-byte block, used only for DS digest type 1 (the SHA-1 signature
  algorithms 5 and 7 are refused).
- Algorithms 10, 14 and 16 are unsupported on both chains (no syscall or precompile for them on Solana).
