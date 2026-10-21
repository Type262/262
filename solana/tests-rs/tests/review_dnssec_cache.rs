//! Security review of the DNSSEC cache, through the real instructions on synthetic zones signed
//! with throwaway RSA keys (runs everywhere). The prize for an attacker is a cached _wallet set
//! for a domain they don't control, which the escrow then pays.
//!
//! The tests under "findings" cover what the review found (a tie on signing time, a zone signing
//! its own DS set) and assert the fixed behaviour. The others are attacks that the program
//! already stopped; they stay as regression tests.

mod dnssec_util;

use dnssec_util::*;
use num_bigint::BigUint;
use solana_keypair::Keypair;
use solana_signer::Signer;
use std::str::FromStr;
use type262_tests::*;

const TEST: &[u8] = b"\x04test\x00";
const EXAMPLE: &[u8] = b"\x07example\x04test\x00";
const WALLET_TXT: &[u8] = b"\x07_wallet\x07example\x04test\x00";

/// A throwaway 1048-bit RSA key (openssl, e = 65537), the "new owner" key in the DS test.
const NEW_OWNER: (&str, &str) = (
    "d18ac9e141e0e8e03d2b0d765afa2457cb69eccf0a9b0914152b64511785c73d2fe9a6f569b498d1fe447d0e0a3a9d55612bc95c08dab9cf9c0e7a1c5e7783e95fc38d4312e61bd8152e7345fdc1438a0fcc0939782ff46ac9b263ded5550d2cdf35a1fbf89ebe6e27f5726501f7d3ed90c536439302dfd7b19dd9579e3b5df5734add",
    "c7fc41f8aebb4d06d6da441af5714f464b69690da0fd9e88803bcd9e6768d262df5b8c7124d5ac149f2c167e53dce5541b4d82fc47a71937bfa5417dd9db0f16a8a77119d83a536cfd501659c0090c6c75af7982fab1bf82e8d48830ee26efab49909f182529559a9ddabc32d46864c2c02ab0e39c1b0f4b67b38cbcba5d228e385db1",
);

struct Zone {
    env: Env,
    payer: Keypair,
    now: i64,
}

/// test. (key 0) cached for 30 days; example.test. DS signed by test. and its DNSKEY set
/// self-signed by key 1, both verified through the program and valid for 7 days.
fn zone() -> Zone {
    let mut env = Env::new();
    let payer = env.funded(100);
    let now = env.now();
    let (k0, k1) = (TestKey::rsa(0, 8), TestKey::rsa(1, 8));
    put_rrset(
        &mut env,
        TEST,
        TYPE_DNSKEY,
        &[k0.dnskey(257)],
        now - 86_400,
        now + 30 * 86_400,
    );
    let ds = synthetic(
        &Sig::new(TEST, now),
        &k0,
        EXAMPLE,
        TYPE_DS,
        &[ds_rdata(EXAMPLE, &k1.dnskey(257), 2)],
    );
    prove(&mut env, &payer, &ds, &k0.dnskey(257)).unwrap();
    let keys = synthetic(
        &Sig::new(EXAMPLE, now),
        &k1,
        EXAMPLE,
        TYPE_DNSKEY,
        &[k1.dnskey(257)],
    );
    prove(&mut env, &payer, &keys, &k1.dnskey(257)).unwrap();
    Zone { env, payer, now }
}

impl Zone {
    fn prove(&mut self, step: &Step, key: &TestKey) -> Result<(Mode, u64), Failure> {
        prove(&mut self.env, &self.payer, step, &key.dnskey(257))
    }

    fn register(&mut self, wallet: Pubkey) -> TxResult {
        let record = rrset_address(&self.env, WALLET_TXT, TYPE_TXT);
        let payer = self.payer.insecure_clone();
        register(&mut self.env, &payer, "example.test", record, wallet)
    }
}

fn sol(wallet: &Pubkey) -> Vec<u8> {
    txt(&format!("SOL {wallet}"))
}

fn times(signer: &[u8], now: i64, inception: i64, expiration: i64) -> Sig {
    Sig {
        inception: inception as u32,
        expiration: expiration as u32,
        ..Sig::new(signer, now)
    }
}

fn new_owner_key() -> TestKey {
    TestKey::Rsa {
        n: unhex(NEW_OWNER.0),
        d: BigUint::parse_bytes(NEW_OWNER.1.as_bytes(), 16).unwrap(),
        alg: 8,
    }
}

/// The record as the program caches it: [owner, TXT, IN, TTL 300, rdlength, rdata].
fn rr(owner: &[u8], rrtype: u16, rdata: &[u8]) -> Vec<u8> {
    let mut v = owner.to_vec();
    v.extend_from_slice(&rrtype.to_be_bytes());
    v.extend_from_slice(&1u16.to_be_bytes());
    v.extend_from_slice(&300u32.to_be_bytes());
    v.extend_from_slice(&(rdata.len() as u16).to_be_bytes());
    v.extend_from_slice(rdata);
    v
}

// ---------- findings ----------

/// Signers that fix RRSIG times per period give an old and a new version of a set the same
/// inception and expiration (PowerDNS, for one, sets every inception to the start of the
/// previous week). The cache used to keep whichever version was proved first (`replaces` wanted a
/// strictly later signing time or a strictly longer validity), so the owner couldn't even cache
/// the new set until the next re-signing. FIXED: a tie with other records replaces the cached set,
/// so the zone's current set can always be cached. The escrow settles the tie on its own: the
/// wallet registered first at that signing time keeps it, a set signed later always wins.
#[test]
fn a_tie_on_signing_time_never_locks_the_owner_out() {
    let mut z = zone();
    let now = z.now;
    let k1 = TestKey::rsa(1, 8);
    let (old, new) = (Pubkey::new_unique(), Pubkey::new_unique());
    let sig = times(EXAMPLE, now, now - 86_400, now + 14 * 86_400);
    let a = synthetic(&sig, &k1, WALLET_TXT, TYPE_TXT, &[sol(&old)]);
    let b = synthetic(&sig, &k1, WALLET_TXT, TYPE_TXT, &[sol(&new)]);

    // The old set is cached and registered while it is current.
    z.prove(&a, &k1).unwrap();
    z.register(old).unwrap();
    // The owner moves to a new wallet within the same signing period: its set replaces the old.
    z.prove(&b, &k1).unwrap();
    let cached = rrset(&z.env, WALLET_TXT, TYPE_TXT).unwrap();
    println!(
        "cache after proving the new set: {} (signed_at {}, expires_at {})",
        if cached.records() == vec![sol(&old)] {
            "old wallet"
        } else {
            "new wallet"
        },
        cached.signed_at,
        cached.expires_at
    );
    assert_eq!(cached.records(), vec![sol(&new)]);
    assert_err(z.register(old), "WalletNotPublished");
    // The old wallet was registered first at this signing time, so it keeps the domain until the
    // zone signs again; the next signature, one second later or a week, settles it for good.
    assert_err(z.register(new), "TiedProof");
    let later = times(EXAMPLE, now, now - 86_400 + 1, now + 14 * 86_400);
    z.prove(
        &synthetic(&later, &k1, WALLET_TXT, TYPE_TXT, &[sol(&new)]),
        &k1,
    )
    .unwrap();
    z.register(new).unwrap();
    // The old set can't come back now: older than the cached one, it writes nothing.
    let before = raw(&z.env, &rrset_address(&z.env, WALLET_TXT, TYPE_TXT));
    z.prove(&a, &k1).unwrap();
    assert_eq!(
        raw(&z.env, &rrset_address(&z.env, WALLET_TXT, TYPE_TXT)),
        before
    );
    assert_err(z.register(old), "WalletNotPublished");
}

/// The other order: the owner registers the new set first at the shared signing time. Whoever
/// holds the old one can cache it again (same time, other records), but it never registers or
/// claims: the tie keeps the wallet registered first.
#[test]
fn a_tie_after_the_owner_registered_never_brings_the_old_wallet_back() {
    let mut z = zone();
    let now = z.now;
    let k1 = TestKey::rsa(1, 8);
    let (old, new) = (Pubkey::new_unique(), Pubkey::new_unique());
    let last_week = times(EXAMPLE, now, now - 8 * 86_400, now + 14 * 86_400);
    z.prove(
        &synthetic(&last_week, &k1, WALLET_TXT, TYPE_TXT, &[sol(&old)]),
        &k1,
    )
    .unwrap();
    z.register(old).unwrap();

    let sig = times(EXAMPLE, now, now - 86_400, now + 14 * 86_400);
    let a = synthetic(&sig, &k1, WALLET_TXT, TYPE_TXT, &[sol(&old)]);
    let b = synthetic(&sig, &k1, WALLET_TXT, TYPE_TXT, &[sol(&new)]);
    z.prove(&b, &k1).unwrap();
    z.register(new).unwrap();
    z.prove(&a, &k1).unwrap();
    assert_eq!(
        rrset(&z.env, WALLET_TXT, TYPE_TXT).unwrap().records(),
        vec![sol(&old)]
    );
    assert_err(z.register(old), "TiedProof");
    let domain: Domain = z
        .env
        .account(&z.env.domain_pda(&domain_hash("example.test")))
        .unwrap();
    assert_eq!((domain.wallet, domain.last_proof), (new, now - 86_400));
    // The owner's set caches again just as well.
    z.prove(&b, &k1).unwrap();
    z.register(new).unwrap();
}

/// A DS set belongs to the parent zone (RFC 4035 2.4, 5.2), yet `parent_of` checked a DS set at
/// X signed by X itself against X's own DNSKEY set, and the newer signing time then won the
/// cache slot. A zone's own keys (a former owner's, a stolen ZSK) could so replace the delegation
/// its parent publishes, and keep re-signing it "newer" than the parent ever does, until the
/// chain they started from expired. FIXED: a DS set's signer must be a proper ancestor.
#[test]
fn only_the_parent_zone_writes_a_ds_set() {
    let mut z = zone();
    let now = z.now;
    let (k0, k1) = (TestKey::rsa(0, 8), TestKey::rsa(1, 8));
    let kn = new_owner_key();

    // example.test.'s own key 1 signs a DS set at example.test. pointing at a key it picked.
    let own = synthetic(
        &times(EXAMPLE, now, now - 60, now + 60 * 86_400),
        &k1,
        EXAMPLE,
        TYPE_DS,
        &[ds_rdata(EXAMPLE, &k0.dnskey(257), 2)],
    );
    let own_result = z.prove(&own, &k1);
    // The parent then publishes a newer DS set of its own, for a new owner's key.
    let parents = [ds_rdata(EXAMPLE, &kn.dnskey(257), 2)];
    let parent = synthetic(
        &times(TEST, now, now - 600, now + 7 * 86_400),
        &k0,
        EXAMPLE,
        TYPE_DS,
        &parents,
    );
    z.prove(&parent, &k0).unwrap();
    // The new owner's key set, self-signed, against whatever DS set is cached.
    let theirs = synthetic(
        &times(EXAMPLE, now, now - 300, now + 7 * 86_400),
        &kn,
        EXAMPLE,
        TYPE_DNSKEY,
        &[kn.dnskey(257)],
    );
    let new_owner = z.prove(&theirs, &kn);
    println!(
        "self-signed DS: {}; new owner's DNSKEY set after the parent's newer DS: {}",
        if own_result.is_ok() {
            "accepted"
        } else {
            "refused"
        },
        match &new_owner {
            Ok(_) => "verified".to_string(),
            Err(f) => format!("refused with {:?}", f.code()),
        }
    );
    let cached = rrset(&z.env, EXAMPLE, TYPE_DS).unwrap();
    assert_eq!(
        cached.records(),
        parents.to_vec(),
        "the DS slot holds the zone's own DS set, not the parent's newer one"
    );
    assert_eq!(code(own_result), Some(err_code("InvalidSignerName")));
    assert!(new_owner.is_ok());
}

// ---------- attacks that the program stops ----------

/// Bounds the DS finding above, had a self-signed DS set got through: a zone that signs its own
/// DS and keys never extends its chain past the parent-signed DS it started from (expires_at is
/// a minimum along the chain). The program now refuses the first step.
#[test]
fn a_zone_signing_its_own_ds_never_outlives_its_parent() {
    let mut env = Env::new();
    let payer = env.funded(100);
    let now = env.now();
    let (k0, k1) = (TestKey::rsa(0, 8), TestKey::rsa(1, 8));
    put_rrset(
        &mut env,
        TEST,
        TYPE_DNSKEY,
        &[k0.dnskey(257)],
        now - 86_400,
        now + 30 * 86_400,
    );
    let day = now + 86_400;
    let ds = synthetic(
        &times(TEST, now, now - 3600, day),
        &k0,
        EXAMPLE,
        TYPE_DS,
        &[ds_rdata(EXAMPLE, &k1.dnskey(257), 2)],
    );
    prove(&mut env, &payer, &ds, &k0.dnskey(257)).unwrap();
    let keys = synthetic(
        &times(EXAMPLE, now, now - 3600, now + 60 * 86_400),
        &k1,
        EXAMPLE,
        TYPE_DNSKEY,
        &[k1.dnskey(257)],
    );
    prove(&mut env, &payer, &keys, &k1.dnskey(257)).unwrap();

    // The zone re-roots itself: its own DS for key 0, key 0's self-signed set, a _wallet leaf,
    // each signed for 60 days.
    let own = synthetic(
        &times(EXAMPLE, now, now - 60, now + 60 * 86_400),
        &k1,
        EXAMPLE,
        TYPE_DS,
        &[ds_rdata(EXAMPLE, &k0.dnskey(257), 2)],
    );
    let refused = prove(&mut env, &payer, &own, &k1.dnskey(257));
    if refused.is_err() {
        assert_eq!(code(refused), Some(err_code("InvalidSignerName")));
        return; // self-signed DS sets refused: nothing left to bound
    }
    let rekeyed = synthetic(
        &times(EXAMPLE, now, now - 30, now + 60 * 86_400),
        &k0,
        EXAMPLE,
        TYPE_DNSKEY,
        &[k0.dnskey(257)],
    );
    prove(&mut env, &payer, &rekeyed, &k0.dnskey(257)).unwrap();
    let wallet = Pubkey::new_unique();
    let leaf = synthetic(
        &times(EXAMPLE, now, now - 10, now + 60 * 86_400),
        &k0,
        WALLET_TXT,
        TYPE_TXT,
        &[sol(&wallet)],
    );
    prove(&mut env, &payer, &leaf, &k0.dnskey(257)).unwrap();
    for (owner, rrtype) in [
        (EXAMPLE, TYPE_DS),
        (EXAMPLE, TYPE_DNSKEY),
        (WALLET_TXT, TYPE_TXT),
    ] {
        let c = rrset(&env, owner, rrtype).unwrap();
        assert!(c.expires_at <= day, "type {rrtype} outlives its parent");
    }
    let record = rrset_address(&env, WALLET_TXT, TYPE_TXT);
    register(&mut env, &payer, "example.test", record, wallet).unwrap();
    set_time(&mut env, day + 1);
    assert_err(
        register(&mut env, &payer, "example.test", record, wallet),
        "WalletRecordExpired",
    );
    let again = synthetic(
        &times(EXAMPLE, day, day - 5, day + 60 * 86_400),
        &k1,
        EXAMPLE,
        TYPE_DS,
        &[ds_rdata(EXAMPLE, &k0.dnskey(257), 2)],
    );
    assert_eq!(
        code(prove(&mut env, &payer, &again, &k1.dnskey(257))),
        Some(err_code("ParentExpired"))
    );
}

/// Serial arithmetic (RFC 1982) can't make a signature look newer than now or outlive its
/// parent: an inception "in the future" by more than half the u32 range counts as long past,
/// an expiration exactly half the range ahead counts as expired.
#[test]
fn wrapped_rrsig_times_never_help() {
    let mut z = zone();
    let now = z.now;
    let k1 = TestKey::rsa(1, 8);
    let wallet = Pubkey::new_unique();
    let now32 = now as u32;
    let half = 1u32 << 31;

    let wrapped = Sig {
        inception: now32.wrapping_add(half).wrapping_add(1),
        ..Sig::new(EXAMPLE, now)
    };
    let s = synthetic(&wrapped, &k1, WALLET_TXT, TYPE_TXT, &[sol(&wallet)]);
    z.prove(&s, &k1).unwrap();
    let c = rrset(&z.env, WALLET_TXT, TYPE_TXT).unwrap();
    assert_eq!(c.signed_at, now - (half as i64 - 1));
    // Older than any real signature, so it can never beat a newer record in the escrow.
    assert_err(z.register(wallet), "StaleProof");

    let at_half = Sig {
        expiration: now32.wrapping_add(half),
        ..Sig::new(EXAMPLE, now)
    };
    let s = synthetic(&at_half, &k1, WALLET_TXT, TYPE_TXT, &[sol(&wallet)]);
    assert_eq!(code(z.prove(&s, &k1)), Some(err_code("SignatureExpired")));
    let longest = Sig {
        expiration: now32.wrapping_add(half - 1),
        ..Sig::new(EXAMPLE, now)
    };
    let s = synthetic(&longest, &k1, WALLET_TXT, TYPE_TXT, &[sol(&wallet)]);
    z.prove(&s, &k1).unwrap();
    let c = rrset(&z.env, WALLET_TXT, TYPE_TXT).unwrap();
    assert_eq!(
        c.expires_at,
        now + 7 * 86_400,
        "capped by example.test.'s keys"
    );
    z.register(wallet).unwrap();
}

/// The signer check works on labels, not bytes: "zz\x07example" is one label under test., so
/// its wire name ends with example.test.'s bytes without being below it (ENS compares bytes).
#[test]
fn a_byte_suffix_is_not_a_subdomain() {
    let mut z = zone();
    let now = z.now;
    let (k0, k1) = (TestKey::rsa(0, 8), TestKey::rsa(1, 8));
    let recs = [sol(&Pubkey::new_unique())];
    let sibling = b"\x0azz\x07example\x04test\x00";
    let s = synthetic(&Sig::new(EXAMPLE, now), &k1, sibling, TYPE_TXT, &recs);
    assert_eq!(code(z.prove(&s, &k1)), Some(err_code("InvalidSignerName")));
    let tld = b"\x07zz\x04test\x00";
    let s = synthetic(&Sig::new(TEST, now), &k0, tld, TYPE_TXT, &recs);
    assert_eq!(code(z.prove(&s, &k0)), Some(err_code("InvalidSignerName")));
}

/// Records appended to, or dropped from, a validly signed _wallet set: the RSA hash covers the
/// whole signed data, so neither verifies.
#[test]
fn records_added_to_a_signed_set_do_not_verify() {
    let mut z = zone();
    let k1 = TestKey::rsa(1, 8);
    let (victim, attacker) = (Pubkey::new_unique(), Pubkey::new_unique());
    let good = synthetic(
        &Sig::new(EXAMPLE, z.now),
        &k1,
        WALLET_TXT,
        TYPE_TXT,
        &[txt("note"), sol(&victim)],
    );
    let mut added = good.clone();
    added
        .signed
        .extend(rr(WALLET_TXT, TYPE_TXT, &sol(&attacker)));
    assert_eq!(code(z.prove(&added, &k1)), Some(err_code("NoKeyVerified")));
    let mut dropped = good.clone();
    let last = rr(WALLET_TXT, TYPE_TXT, &sol(&victim)).len();
    dropped.signed.truncate(dropped.signed.len() - last);
    assert_eq!(
        code(z.prove(&dropped, &k1)),
        Some(err_code("NoKeyVerified"))
    );
    assert!(rrset(&z.env, WALLET_TXT, TYPE_TXT).is_none());
    z.prove(&good, &k1).unwrap();
    assert_err(z.register(attacker), "WalletNotPublished");
    z.register(victim).unwrap();
}

/// A buffer is its payer's: another signer can't verify from it, and a partly overwritten
/// buffer (a new upload over an older, longer one) verifies nothing until it is complete.
#[test]
fn buffers_are_private_and_fail_closed() {
    let mut z = zone();
    let k1 = TestKey::rsa(1, 8);
    let payer = z.payer.insecure_clone();
    let me = payer.pubkey();

    let long = synthetic(
        &Sig::new(EXAMPLE, z.now),
        &k1,
        WALLET_TXT,
        TYPE_TXT,
        &(0..12)
            .map(|i| txt(&format!("filler record number {i}")))
            .collect::<Vec<_>>(),
    );
    z.env.upload(&payer, &buffer_payload(&long));

    // A stranger names this buffer in their own verify: Anchor's seeds check refuses it.
    let stranger = z.env.funded(1);
    let mut ix = buffered_ix(&z.env, &stranger.pubkey(), &long);
    let last = ix.accounts.len() - 1;
    ix.accounts[last] = w(z.env.buffer_pda(&me));
    let r = z.env.send(&[cu_limit(1_400_000), ix], &[&stranger]);
    assert_eq!(code(r), Some(2006), "ConstraintSeeds");

    // A shorter step written over it, all but its last 10 bytes: the stale tail of the long
    // one fills the gap, and the step fails.
    let wallet = Pubkey::new_unique();
    let short = synthetic(
        &Sig::new(EXAMPLE, z.now),
        &k1,
        WALLET_TXT,
        TYPE_TXT,
        &[sol(&wallet)],
    );
    let payload = buffer_payload(&short);
    let cut = payload.len() - 10;
    z.env.write_buffer(&payer, 0, &payload[..cut]).unwrap();
    let ix = buffered_ix(&z.env, &me, &short);
    assert!(z.env.send(&[cu_limit(1_400_000), ix], &[&payer]).is_err());
    assert!(rrset(&z.env, WALLET_TXT, TYPE_TXT).is_none());
    // Completed, it verifies; the rest of the long upload is ignored.
    z.env
        .write_buffer(&payer, cut as u32, &payload[cut..])
        .unwrap();
    let ix = buffered_ix(&z.env, &me, &short);
    z.env.send(&[cu_limit(1_400_000), ix], &[&payer]).unwrap();
    assert_eq!(
        rrset(&z.env, WALLET_TXT, TYPE_TXT).unwrap().records(),
        vec![sol(&wallet)]
    );
}

/// TXT lines that look like a SOL wallet but aren't one of the accepted shapes publish nothing.
#[test]
fn lookalike_wallet_lines_publish_nothing() {
    let mut z = zone();
    let k1 = TestKey::rsa(1, 8);
    let key = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
    let wallet = Pubkey::from_str(key).unwrap();
    let lookalikes = vec![
        txt(&format!("SOL\t{key}")),
        txt(&format!("SOL {key}\0")),
        txt(&format!("SOL 1{key}")),
        txt(&format!("SOL {}", &key[..43])),
        txt(&format!("SOLL {key}")),
        txt(&format!("S0L {key}")),
        [txt("SOL "), txt(key)].concat(),
        [txt("SOL"), txt(&format!(" {key}"))].concat(),
        [txt("SOL"), txt(key), txt("")].concat(),
        [txt(""), txt("SOL"), txt(key)].concat(),
        [txt("ETH"), txt(&format!("SOL {key}"))].concat(),
    ];
    let s = synthetic(
        &times(EXAMPLE, z.now, z.now - 100, z.now + 86_400),
        &k1,
        WALLET_TXT,
        TYPE_TXT,
        &lookalikes,
    );
    z.prove(&s, &k1).unwrap();
    assert_err(z.register(wallet), "WalletNotPublished");
    // The same set with one accepted line does publish it.
    let mut ok = lookalikes.clone();
    ok.push(txt(&format!("sol::{key}")));
    let s = synthetic(
        &times(EXAMPLE, z.now, z.now - 50, z.now + 86_400),
        &k1,
        WALLET_TXT,
        TYPE_TXT,
        &ok,
    );
    z.prove(&s, &k1).unwrap();
    z.register(wallet).unwrap();
}
