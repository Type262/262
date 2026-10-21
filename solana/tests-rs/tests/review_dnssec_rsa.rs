//! Security review of the RSA check in BPF (DNSSEC algorithm 8; 5 and 7 are refused), through
//! verify_rrset on keys cached under a synthetic zone (runs everywhere).
//!
//! The tests under "findings" cover what the review found (short keys, SHA-1 signatures) and
//! assert the fixed behaviour. The others are forgeries the program already refused; they stay
//! as regression tests.

mod dnssec_util;

use dnssec_util::*;
use num_bigint::BigUint;
use solana_keypair::Keypair;
use type262_tests::*;

const ZONE: &[u8] = b"\x04zone\x04test\x00";
const LEAF: &[u8] = b"\x07_wallet\x04zone\x04test\x00";
const SHA256_PREFIX: &str = "3031300d060960864801650304020105000420";

// Throwaway RSA keys generated with openssl for this review only (e = 65537): modulus and
// private exponent.
/// 512 bits.
const RSA_512: (&str, &str) = (
    "da4c1940a39ac8800bb37526d6a8518a61827613b50b45c286a7347029f2076643c0214b0439a6901e64a9d572add64eddc33d9a2e5ec4615b84f3984a0a9a57",
    "1080542058bda88e55541974f820fd18f2ca03d6f586869d6fc44fe872a342ffca2e6480ca5c77a36858fb5e78124520724ca6e885d8d992ec2be48f27ff0711",
);
/// 1025 bits: 129 bytes whose first is 0x01, so the top u32 limb holds a single bit.
const RSA_1025: (&str, &str) = (
    "01d7687f5b1f4ee286a389bca10783cd4728b2700ccc38e80ffe33a118dc02e70a62c75d55f37be4cf0bc3d6d20db9bf4c9aa87bf3f45f0b75a5857feb7ebb1130b2defd0acfbd00ecf34e2b50658c95a0baeca5708c5238d09bb5bd7f26c0e6aa5355cbfc12189f8ac95fff9d97bc54acdbe309a76caa8ec2e5f5821c6e47509b",
    "a63eabeb2eb75b1bb040baccef21841b3c36f15d12085f8e844f20d8eb7dfa8ca71937c93ffcc94c5b11cd88765eb32008cab22bee5a36685edf1da5a723c18331f30a432f5ae89e60af582c143f0b385b9dc50da7c57f0c947adbdc96b13604546f01322de8fb5436b912ce2492b982955b8620958031a754568b07318a0501",
);
/// 1048 bits: 131 bytes, three of them in the top limb.
const RSA_1048: (&str, &str) = (
    "d18ac9e141e0e8e03d2b0d765afa2457cb69eccf0a9b0914152b64511785c73d2fe9a6f569b498d1fe447d0e0a3a9d55612bc95c08dab9cf9c0e7a1c5e7783e95fc38d4312e61bd8152e7345fdc1438a0fcc0939782ff46ac9b263ded5550d2cdf35a1fbf89ebe6e27f5726501f7d3ed90c536439302dfd7b19dd9579e3b5df5734add",
    "c7fc41f8aebb4d06d6da441af5714f464b69690da0fd9e88803bcd9e6768d262df5b8c7124d5ac149f2c167e53dce5541b4d82fc47a71937bfa5417dd9db0f16a8a77119d83a536cfd501659c0090c6c75af7982fab1bf82e8d48830ee26efab49909f182529559a9ddabc32d46864c2c02ab0e39c1b0f4b67b38cbcba5d228e385db1",
);

fn rsa(k: (&str, &str), alg: u8) -> TestKey {
    TestKey::Rsa {
        n: unhex(k.0),
        d: BigUint::parse_bytes(k.1.as_bytes(), 16).unwrap(),
        alg,
    }
}

fn modulus(key: &TestKey) -> Vec<u8> {
    match key {
        TestKey::Rsa { n, .. } => n.clone(),
        _ => unreachable!(),
    }
}

/// A chain with `dnskeys` cached as zone.test.'s key set, valid for a day.
fn zone_with(dnskeys: &[Vec<u8>]) -> (Env, Keypair, i64) {
    let mut env = Env::new();
    let payer = env.funded(100);
    let now = env.now();
    put_rrset(&mut env, ZONE, TYPE_DNSKEY, dnskeys, now - 60, now + 86_400);
    (env, payer, now)
}

fn wallet_line() -> Vec<u8> {
    txt(&format!("SOL {}", Pubkey::new_unique()))
}

/// The _wallet leaf signed by `key`.
fn leaf(now: i64, key: &TestKey) -> Step {
    synthetic(&Sig::new(ZONE, now), key, LEAF, TYPE_TXT, &[wallet_line()])
}

/// The _wallet leaf's signed data naming `dnskey` (its tag and algorithm), to be paired with a
/// signature of the test's own making.
fn signed_for(now: i64, dnskey: &[u8]) -> Vec<u8> {
    let sig = Sig {
        key_tag: Some(key_tag(dnskey)),
        alg: Some(dnskey[3]),
        ..Sig::new(ZONE, now)
    };
    signed_data(
        &sig,
        &TestKey::rsa(0, 8),
        257,
        LEAF,
        TYPE_TXT,
        &[wallet_line()],
    )
}

/// DNSKEY RDATA (flags 257, algorithm 8) for an RSA key given as RFC 3110 bytes.
fn rsa_dnskey(rfc3110: &[u8]) -> Vec<u8> {
    [&[1u8, 1, 3, 8][..], rfc3110].concat()
}

/// The PKCS#1 v1.5 encoded message for SHA-256: 00 01 FF..FF 00 DigestInfo hash, k bytes.
fn em_sha256(k: usize, data: &[u8]) -> Vec<u8> {
    let prefix = unhex(SHA256_PREFIX);
    let mut em = vec![0u8, 1];
    em.resize(k - prefix.len() - 32 - 1, 0xff);
    em.push(0);
    em.extend_from_slice(&prefix);
    em.extend_from_slice(&sha256(&[data]));
    em
}

fn be(x: &BigUint, len: usize) -> Vec<u8> {
    let b = x.to_bytes_be();
    [vec![0u8; len - b.len()], b].concat()
}

/// Compute units the program used in a failed transaction, from its logs.
fn consumed(f: &Failure) -> u64 {
    f.logs
        .iter()
        .filter_map(|l| l.split(" consumed ").nth(1))
        .filter_map(|r| r.split(' ').next()?.parse().ok())
        .max()
        .unwrap_or(0)
}

fn step(signed: Vec<u8>, sig: Vec<u8>) -> Step {
    Step {
        label: "forged".into(),
        signed,
        sig,
    }
}

// ---------- findings ----------

/// 512-bit RSA moduli are factored in hours on rented hardware, and anyone who factors a zone's
/// key signs any _wallet record under it. check_inputs accepted them (n.len() >= 64). FIXED: the
/// modulus must be at least 1024 bits (128 bytes); the 1025-bit key below still verifies.
#[test]
fn rsa_keys_under_1024_bits_are_refused() {
    let key = rsa(RSA_512, 8);
    let (mut env, payer, now) = zone_with(&[key.dnskey(257)]);
    let r = prove(&mut env, &payer, &leaf(now, &key), &key.dnskey(257));
    if let Ok((_, cu)) = r {
        panic!("a 512-bit RSA key verified a _wallet set ({cu} CU)");
    }
    assert_eq!(code(r), Some(err_code("NoKeyVerified")));
    // 1024 bits exactly (the synthetic zones' keys) is the smallest accepted.
    let key = TestKey::rsa(0, 8);
    assert_eq!(modulus(&key).len(), 128);
    let (mut env, payer, now) = zone_with(&[key.dnskey(257)]);
    prove(&mut env, &payer, &leaf(now, &key), &key.dnskey(257)).unwrap();
}

/// RSASHA1 (5) and RSASHA1-NSEC3-SHA1 (7): SHA-1 has practical chosen-prefix collisions, so a
/// zone that signs content an attacker shapes (a shared zone signing users' TXT records) can be
/// made to sign one message whose signature also fits a _wallet set for another name in it.
/// FIXED: both are refused as unsupported algorithms.
#[test]
fn sha1_signature_algorithms_are_refused() {
    let accepted: Vec<u8> = [5u8, 7]
        .into_iter()
        .filter(|&alg| {
            let key = TestKey::rsa(0, alg);
            let (mut env, payer, now) = zone_with(&[key.dnskey(257)]);
            let r = prove(&mut env, &payer, &leaf(now, &key), &key.dnskey(257));
            r.is_ok() || code(r) != Some(err_code("UnsupportedAlgorithm"))
        })
        .collect();
    assert!(
        accepted.is_empty(),
        "algorithms {accepted:?} verified a _wallet set, or failed for another reason"
    );
}

// ---------- forgeries the program refuses ----------

/// With e = 1 the encoded message is its own signature. Exponents below 3 are refused.
#[test]
fn exponent_one_keys_cannot_sign() {
    let n = unhex(RSA_1048.0);
    for e in [1u8, 2] {
        let dnskey = rsa_dnskey(&[&[1u8, e][..], &n].concat());
        let (mut env, payer, now) = zone_with(&[dnskey.clone()]);
        let signed = signed_for(now, &dnskey);
        let sig = em_sha256(n.len(), &signed);
        let r = prove(&mut env, &payer, &step(signed, sig), &dnskey);
        assert_eq!(code(r), Some(err_code("NoKeyVerified")), "e = {e}");
    }
}

/// Bleichenbacher's e = 3 forgery: a cube root whose cube starts 00 01 FF*8 00 DigestInfo hash
/// and ends in garbage. A verifier that stops after the hash accepts it; the program rebuilds
/// the whole encoded message, so it doesn't.
#[test]
fn a_cube_root_forgery_on_an_e3_key_is_refused() {
    // Any odd 2048-bit modulus will do: the forgery never uses its factors.
    let mut seed = 0x2545_f491_4f6c_dd1du64;
    let mut n: Vec<u8> = (0..256)
        .map(|_| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed as u8
        })
        .collect();
    n[0] |= 0x80;
    n[255] |= 1;
    let dnskey = rsa_dnskey(&[&[1u8, 3][..], &n].concat());
    let (mut env, payer, now) = zone_with(&[dnskey.clone()]);
    let signed = signed_for(now, &dnskey);

    let hash = sha256(&[&signed]);
    let mut head = vec![0u8, 1];
    head.extend_from_slice(&[0xff; 8]);
    head.push(0);
    head.extend_from_slice(&unhex(SHA256_PREFIX));
    head.extend_from_slice(&hash);
    let garbage = 256 - head.len();
    let target = BigUint::from_bytes_be(&head) << (8 * garbage);
    let s = target.cbrt() + 1u32;
    let cube = &s * &s * &s;
    assert!(cube < BigUint::from_bytes_be(&n));
    let em = be(&cube, 256);
    assert_eq!(
        &em[..head.len()],
        &head[..],
        "a loose verifier accepts this"
    );
    assert_ne!(em, em_sha256(256, &signed));

    let f = prove(&mut env, &payer, &step(signed, be(&s, 256)), &dnskey).unwrap_err();
    assert_eq!(f.code(), Some(err_code("NoKeyVerified")));
    // It got as far as the modular exponentiation, not refused on the way in.
    assert!(consumed(&f) > 100_000, "{} CU", consumed(&f));
}

/// Signatures 0, 1, n - 1, n and n + 1, and a valid one with an extra leading zero byte.
#[test]
fn degenerate_signatures_are_refused() {
    let key = TestKey::rsa(0, 8);
    let n = BigUint::from_bytes_be(&modulus(&key));
    let k = modulus(&key).len();
    let (mut env, payer, now) = zone_with(&[key.dnskey(257)]);
    let good = leaf(now, &key);
    let mut sigs = vec![
        vec![0u8; k],
        be(&BigUint::from(1u32), k),
        be(&(&n - 1u32), k),
        be(&n, k),
        be(&(&n + 1u32), k),
    ];
    sigs.push([&[0u8][..], &good.sig].concat());
    for (i, sig) in sigs.into_iter().enumerate() {
        let s = step(good.signed.clone(), sig);
        let r = prove(&mut env, &payer, &s, &key.dnskey(257));
        assert_eq!(code(r), Some(err_code("NoKeyVerified")), "signature {i}");
    }
    prove(&mut env, &payer, &good, &key.dnskey(257)).unwrap();
}

/// Moduli whose length is not a multiple of 4 leave the top Montgomery limb partly empty (129
/// bytes starting 0x01, 131 bytes): valid signatures verify, a one-bit change doesn't. A
/// modulus written with a leading zero byte (RFC 3110 forbids it) is refused.
#[test]
fn odd_length_moduli_verify_exactly() {
    for k in [RSA_1025, RSA_1048] {
        let key = rsa(k, 8);
        let (mut env, payer, now) = zone_with(&[key.dnskey(257)]);
        let good = leaf(now, &key);
        let mut bad = good.clone();
        bad.sig[good.sig.len() / 2] ^= 0x10;
        let r = prove(&mut env, &payer, &bad, &key.dnskey(257));
        assert_eq!(code(r), Some(err_code("NoKeyVerified")));
        let (_, cu) = prove(&mut env, &payer, &good, &key.dnskey(257)).unwrap();
        println!("{}-byte modulus: {cu} CU", modulus(&key).len());
    }

    let key = rsa(RSA_1025, 8);
    let padded = rsa_dnskey(&[&[3u8, 1, 0, 1, 0][..], &modulus(&key)].concat());
    let (mut env, payer, now) = zone_with(&[padded.clone()]);
    let signed = signed_for(now, &padded);
    let sig = key.sign(&signed);
    let r = prove(&mut env, &payer, &step(signed, sig), &padded);
    assert_eq!(code(r), Some(err_code("NoKeyVerified")));
}
