//! RSA signature check (DNSSEC algorithm 8, RSA/SHA-256) in BPF: mainnet has no modexp syscall
//! (enable_big_mod_exp_syscall is not active), so s^e mod n is computed here.
//!
//! Montgomery arithmetic on little-endian u32 limbs with u64 products (SBPF v0 has no 64x64->128
//! multiply). Squarings sum each cross product once and double it (s^2/2 multiplies) before the
//! reduction (s^2); the one multiply by the base uses CIOS (2 s^2). The base enters Montgomery
//! form through one long division (Knuth D), much cheaper than first computing R^2 mod n.
//! Measured in docs/DNSSEC.md: a 2048-bit signature with e = 65537 takes about 1.19M CU.
//!
//! The workspace builds with overflow checks, so the hot loops use wrapping operations where the
//! value provably fits (each is commented); checked arithmetic there would cost ~20% more.

use anchor_lang::solana_program::hash::hashv;

/// Smallest modulus accepted: 1024 bits. Smaller keys can be factored with rented hardware, and
/// whoever factors a zone's key can sign any record under it.
pub const MIN_BYTES: usize = 128;
/// Largest modulus accepted: 4096 bits.
pub const MAX_BYTES: usize = 512;
const MAX32: usize = MAX_BYTES / 4;

/// The SHA-256 DigestInfo prefix from RFC 8017 section 9.2, note 1.
const SHA256_PREFIX: [u8; 19] = [
    0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01, 0x05,
    0x00, 0x04, 0x20,
];

/// True if `sig` is a valid RSASHA256 signature over `signed` by the DNSKEY public key `pubkey`
/// (RFC 3110: the DNSKEY RDATA after its 4-byte header).
pub fn verify(pubkey: &[u8], signed: &[u8], sig: &[u8]) -> bool {
    let Some((e, n)) = rsa_key(pubkey) else {
        return false;
    };
    let mut em = [0u8; MAX_BYTES];
    if n.len() > MAX_BYTES {
        return false;
    }
    let em = &mut em[..n.len()];
    if !modexp(n, e, sig, em) {
        return false;
    }
    pkcs1_matches(em, &SHA256_PREFIX, &hashv(&[signed]).to_bytes())
}

/// Splits a DNSKEY's RSA public key (RFC 3110) into exponent and modulus.
pub fn rsa_key(pubkey: &[u8]) -> Option<(&[u8], &[u8])> {
    let (elen, off) = match pubkey.first()? {
        0 => (
            (*pubkey.get(1)? as usize) << 8 | *pubkey.get(2)? as usize,
            3,
        ),
        &l => (l as usize, 1),
    };
    if elen == 0 || pubkey.len() <= off + elen {
        return None;
    }
    Some((&pubkey[off..off + elen], &pubkey[off + elen..]))
}

/// The whole PKCS#1 v1.5 encoded message must match: 00 01 FF..FF 00 DigestInfo hash, with at
/// least 8 FF bytes. Building and comparing every byte leaves no room for loose parsing.
fn pkcs1_matches(em: &[u8], prefix: &[u8], hash: &[u8]) -> bool {
    let k = em.len();
    let tail = prefix.len() + hash.len();
    if k < tail + 11 {
        return false;
    }
    let pad_end = k - tail - 1;
    em[0] == 0
        && em[1] == 1
        && em[2..pad_end].iter().all(|&b| b == 0xff)
        && em[pad_end] == 0
        && em[pad_end + 1..pad_end + 1 + prefix.len()] == *prefix
        && em[k - hash.len()..] == *hash
}

/// Checks the inputs every RSA verification needs: odd modulus of 1024 to 4096 bits with no
/// leading zero byte, exponent 1..=4 bytes and at least 3, signature exactly as long as the
/// modulus and below it.
fn check_inputs(n: &[u8], e: &[u8], sig: &[u8]) -> Option<u64> {
    if n.len() < MIN_BYTES || n.len() > MAX_BYTES || n[0] == 0 || n[n.len() - 1] & 1 == 0 {
        return None;
    }
    // Same length, so byte order is numeric order.
    if e.is_empty() || e.len() > 4 || sig.len() != n.len() || sig >= n {
        return None;
    }
    let mut ev = 0u64;
    for &b in e {
        ev = ev << 8 | b as u64;
    }
    if ev < 3 {
        return None;
    }
    Some(ev)
}

/// sig^e mod n into `out` (big-endian, n.len() bytes). Buffers live on the heap: SBPF v0 stack
/// frames are only 4 KB.
pub fn modexp(n: &[u8], e: &[u8], sig: &[u8], out: &mut [u8]) -> bool {
    let Some(ev) = check_inputs(n, e, sig) else {
        return false;
    };
    let s = n.len().div_ceil(4);
    let mut nl = vec![0u32; s];
    let mut sl = vec![0u32; s];
    let mut base = vec![0u32; s];
    be_to_le32(n, &mut nl);
    be_to_le32(sig, &mut sl);
    to_mont(&sl, &nl, &mut base);
    pow(&base, ev, &nl, neg_inv32(nl[0]), &mut sl);
    le32_to_be(&sl, out);
    true
}

/// -n0^-1 mod 2^32 (n0 odd), by Newton iteration: each step doubles the correct low bits.
fn neg_inv32(n0: u32) -> u32 {
    let mut x = n0; // correct to 3 bits for any odd n0
    for _ in 0..4 {
        x = x.wrapping_mul(2u32.wrapping_sub(n0.wrapping_mul(x)));
    }
    x.wrapping_neg()
}

fn be_to_le32(b: &[u8], out: &mut [u32]) {
    out.fill(0);
    for (i, &byte) in b.iter().rev().enumerate() {
        out[i / 4] |= (byte as u32) << (8 * (i % 4));
    }
}

fn le32_to_be(l: &[u32], out: &mut [u8]) {
    let n = out.len();
    for i in 0..n {
        out[n - 1 - i] = (l[i / 4] >> (8 * (i % 4))) as u8;
    }
}

/// u mod v (Knuth, TAOCP 4.3.1 algorithm D, as in Hacker's Delight divmnu). The remainder is
/// written to `r` (v.len() limbs). v's top limb must be non-zero.
fn rem32(u: &[u32], v: &[u32], r: &mut [u32]) {
    let n = v.len();
    let m = u.len();
    debug_assert!(n >= 2 && m >= n && v[n - 1] != 0);
    let sh = v[n - 1].leading_zeros();
    // Normalize so v's top bit is set; shifting through u64 makes sh == 0 harmless.
    let mut vn = [0u32; MAX32];
    let mut un = [0u32; 2 * MAX32 + 1];
    let hi = |x: u32| ((x as u64) >> (32 - sh)) as u32;
    for i in (1..n).rev() {
        vn[i] = (v[i] << sh) | hi(v[i - 1]);
    }
    vn[0] = v[0] << sh;
    un[m] = hi(u[m - 1]);
    for i in (1..m).rev() {
        un[i] = (u[i] << sh) | hi(u[i - 1]);
    }
    un[0] = u[0] << sh;

    let top = vn[n - 1] as u64;
    let next = vn[n - 2] as u64;
    for j in (0..=m - n).rev() {
        let num = ((un[j + n] as u64) << 32) | un[j + n - 1] as u64;
        let mut qhat = num / top;
        let mut rhat = num - qhat * top;
        // qhat * next is only evaluated once qhat < 2^32, so it fits in u64.
        while qhat >> 32 != 0 || qhat * next > ((rhat << 32) | un[j + n - 2] as u64) {
            qhat -= 1;
            rhat += top;
            if rhat >> 32 != 0 {
                break;
            }
        }
        // un[j..j+n+1] -= qhat * vn. qhat < 2^32 here, so every product fits in u64 and every
        // signed intermediate in i64; wrapping ops only skip the overflow checks.
        let mut k: i64 = 0;
        for i in 0..n {
            let p = qhat.wrapping_mul(vn[i] as u64);
            let t = (un[i + j] as i64)
                .wrapping_sub(k)
                .wrapping_sub((p & 0xffff_ffff) as i64);
            un[i + j] = t as u32;
            k = ((p >> 32) as i64).wrapping_sub(t >> 32);
        }
        let t = (un[j + n] as i64).wrapping_sub(k);
        un[j + n] = t as u32;
        if t < 0 {
            // qhat was one too big: add v back
            let mut c = 0u64;
            for i in 0..n {
                let s = (un[i + j] as u64)
                    .wrapping_add(vn[i] as u64)
                    .wrapping_add(c);
                un[i + j] = s as u32;
                c = s >> 32;
            }
            un[j + n] = un[j + n].wrapping_add(c as u32);
        }
    }
    // Undo the normalization. un[n] is zero here, so un[i + 1] is always safe to read.
    for i in 0..n {
        let lo = (un[i] as u64) >> sh;
        let hi = ((un[i + 1] as u64) << (32 - sh)) & 0xffff_ffff;
        r[i] = (lo | hi) as u32;
    }
}

/// x * 2^(32*s) mod n, i.e. x in Montgomery form for R = 2^(32*s). n has s limbs (its top limb
/// may be zero when n's byte length is not a multiple of 4).
fn to_mont(x: &[u32], n: &[u32], out: &mut [u32]) {
    let s = n.len();
    let mut nl = s;
    while nl > 1 && n[nl - 1] == 0 {
        nl -= 1;
    }
    let mut u = [0u32; 2 * MAX32];
    u[s..2 * s].copy_from_slice(x);
    out.fill(0);
    rem32(&u[..2 * s], &n[..nl], &mut out[..nl]);
}

/// t += a * b (t.len() == a.len()); returns the carry limb. Works in chunks of 8 with a constant
/// inner trip count, which LLVM unrolls into straight-line loads, multiplies and stores.
#[inline(always)]
fn mac(t: &mut [u32], a: &[u32], b: u32) -> u32 {
    let b = b as u64;
    let mut c = 0u64;
    let mut tc = t.chunks_exact_mut(8);
    let mut ac = a.chunks_exact(8);
    // t + a*b + c <= (2^32-1) + (2^32-1)^2 + (2^32-1) = 2^64-1: the wrapping ops never wrap.
    for (tt, aa) in (&mut tc).zip(&mut ac) {
        for k in 0..8 {
            let x = (tt[k] as u64)
                .wrapping_add((aa[k] as u64).wrapping_mul(b))
                .wrapping_add(c);
            tt[k] = x as u32;
            c = x >> 32;
        }
    }
    for (tj, aj) in tc.into_remainder().iter_mut().zip(ac.remainder()) {
        let x = (*tj as u64)
            .wrapping_add((*aj as u64).wrapping_mul(b))
            .wrapping_add(c);
        *tj = x as u32;
        c = x >> 32;
    }
    c as u32
}

/// r (s + 1 limbs, value < 2n) minus n if needed, into out.
fn finish(r: &[u32], n: &[u32], out: &mut [u32]) {
    let s = n.len();
    let mut ge = r[s] != 0;
    if !ge {
        ge = true; // equal counts as >=
        for i in (0..s).rev() {
            if r[i] != n[i] {
                ge = r[i] > n[i];
                break;
            }
        }
    }
    if ge {
        let mut borrow = 0u32;
        for i in 0..s {
            let (d1, b1) = r[i].overflowing_sub(n[i]);
            let (d2, b2) = d1.overflowing_sub(borrow);
            out[i] = d2;
            borrow = (b1 | b2) as u32;
        }
    } else {
        out.copy_from_slice(&r[..s]);
    }
}

/// out = a * b / R mod n (CIOS, with the window sliding up `t` instead of shifting it).
/// `t` is scratch of 2s + 2 limbs.
#[inline(never)]
fn mul(a: &[u32], b: &[u32], n: &[u32], n0: u32, t: &mut [u32], out: &mut [u32]) {
    let s = n.len();
    t.fill(0);
    for i in 0..s {
        let w = &mut t[i..i + s + 2];
        let c = mac(&mut w[..s], a, b[i]);
        // Two u32 values: the sum fits in u64.
        let x = (w[s] as u64).wrapping_add(c as u64);
        w[s] = x as u32;
        w[s + 1] = (x >> 32) as u32;
        let m = w[0].wrapping_mul(n0);
        let c = mac(&mut w[..s], n, m); // w[0] becomes 0: the window moves past it
        let x = (w[s] as u64).wrapping_add(c as u64);
        w[s] = x as u32;
        w[s + 1] = w[s + 1].wrapping_add((x >> 32) as u32);
    }
    finish(&t[s..2 * s + 1], n, out);
}

/// out = t / R mod n for t < n * R held in t[..2s] (t[2s..] zero). Clobbers t.
#[inline(never)]
fn reduce(t: &mut [u32], n: &[u32], n0: u32, out: &mut [u32]) {
    let s = n.len();
    for i in 0..s {
        let m = t[i].wrapping_mul(n0);
        let mut c = mac(&mut t[i..i + s], n, m) as u64;
        let mut k = i + s;
        while c != 0 {
            let x = (t[k] as u64).wrapping_add(c);
            t[k] = x as u32;
            c = x >> 32;
            k += 1;
        }
    }
    finish(&t[s..2 * s + 1], n, out);
}

/// out = a * a / R mod n. Products a_i a_j with i < j are summed once and doubled, so a square
/// costs s^2 / 2 multiplies before the s^2 of the reduction.
#[inline(never)]
fn sqr(a: &[u32], n: &[u32], n0: u32, t: &mut [u32], out: &mut [u32]) {
    let s = n.len();
    t.fill(0);
    for i in 0..s - 1 {
        let c = mac(&mut t[2 * i + 1..i + s], &a[i + 1..], a[i]);
        t[i + s] = c;
    }
    let mut hi = 0u32;
    for k in 0..2 * s {
        let v = t[k];
        t[k] = (v << 1) | hi;
        hi = v >> 31;
    }
    let mut c = 0u64;
    for i in 0..s {
        // Two u32 values plus a carry of at most 1: both sums stay below 2^33.
        let sq = (a[i] as u64).wrapping_mul(a[i] as u64);
        let x = (t[2 * i] as u64)
            .wrapping_add(sq as u32 as u64)
            .wrapping_add(c);
        t[2 * i] = x as u32;
        c = x >> 32;
        let x = (t[2 * i + 1] as u64).wrapping_add(sq >> 32).wrapping_add(c);
        t[2 * i + 1] = x as u32;
        c = x >> 32;
    }
    reduce(t, n, n0, out);
}

/// base^e mod n, base given in Montgomery form; result in normal form.
fn pow(base: &[u32], e: u64, n: &[u32], n0: u32, out: &mut [u32]) {
    let s = n.len();
    let mut t = vec![0u32; 2 * s + 2];
    let mut acc = base.to_vec();
    let mut tmp = vec![0u32; s];
    let bits = 64 - e.leading_zeros();
    for i in (0..bits - 1).rev() {
        sqr(&acc, n, n0, &mut t, &mut tmp);
        if e >> i & 1 == 1 {
            mul(&tmp, base, n, n0, &mut t, &mut acc);
        } else {
            core::mem::swap(&mut acc, &mut tmp);
        }
    }
    t.fill(0);
    t[..s].copy_from_slice(&acc);
    reduce(&mut t, n, n0, out);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inverses() {
        for n0 in [1u32, 3, 0xffff_ffff, 0x1234_5679] {
            assert_eq!(n0.wrapping_mul(neg_inv32(n0)), u32::MAX);
        }
    }

    /// Agrees with a plain square-and-multiply on random odd moduli, including lengths that
    /// leave the top limb partly empty.
    #[test]
    fn modexp_matches_reference() {
        let mut seed = 0x9e37_79b9_7f4a_7c15u64;
        let mut rnd = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        for round in 0..40 {
            let len = [128usize, 129, 131, 256][round % 4];
            let mut n: Vec<u8> = (0..len).map(|_| rnd() as u8).collect();
            n[0] |= 0x80;
            n[len - 1] |= 1;
            let mut sig: Vec<u8> = (0..len).map(|_| rnd() as u8).collect();
            sig[0] &= 0x7f;
            for e in [&[3u8][..], &[1, 0, 1]] {
                let mut a = vec![0u8; len];
                assert!(modexp(&n, e, &sig, &mut a));
                assert_eq!(a, reference(&n, e, &sig));
            }
        }
    }

    #[test]
    fn rejects_bad_inputs() {
        let mut n = vec![0xffu8; 128];
        let sig = vec![1u8; 128];
        let mut out = vec![0u8; 128];
        assert!(modexp(&n, &[1, 0, 1], &sig, &mut out));
        assert!(!modexp(&n, &[2], &sig, &mut out)); // exponent < 3
        assert!(!modexp(&n, &[1, 0, 0, 0, 1], &sig, &mut out)); // exponent > 4 bytes
        assert!(!modexp(&n, &[1, 0, 1], &sig[1..], &mut out)); // short signature
        assert!(!modexp(&n, &[1, 0, 1], &n.clone(), &mut out)); // signature >= modulus
        assert!(!modexp(&n[..127], &[1, 0, 1], &sig[..127], &mut out)); // under 1024 bits
        n[127] = 0xfe;
        assert!(!modexp(&n, &[1, 0, 1], &sig, &mut out)); // even modulus
        assert_eq!(
            rsa_key(&[3, 1, 0, 1, 9]),
            Some((&[1u8, 0, 1][..], &[9u8][..]))
        );
        assert_eq!(
            rsa_key(&[0, 0, 2, 1, 1, 7]),
            Some((&[1u8, 1][..], &[7u8][..]))
        );
        assert_eq!(rsa_key(&[3, 1, 0, 1]), None); // no modulus
        assert_eq!(rsa_key(&[0, 0, 0, 1]), None); // empty exponent
    }

    /// Schoolbook reference over u32 digits.
    fn reference(n: &[u8], e: &[u8], s: &[u8]) -> Vec<u8> {
        let to = |b: &[u8]| {
            let mut v = vec![0u32; b.len().div_ceil(4)];
            be_to_le32(b, &mut v);
            v
        };
        let (nl, sl) = (to(n), to(s));
        let mulmod = |a: &[u32], b: &[u32]| {
            let mut p = vec![0u32; a.len() + b.len()];
            for i in 0..a.len() {
                let mut c = 0u64;
                for j in 0..b.len() {
                    let x = p[i + j] as u64 + a[i] as u64 * b[j] as u64 + c;
                    p[i + j] = x as u32;
                    c = x >> 32;
                }
                p[i + b.len()] = c as u32;
            }
            let mut nt = nl.len();
            while nl[nt - 1] == 0 {
                nt -= 1;
            }
            let mut r = vec![0u32; nl.len()];
            rem32(&p, &nl[..nt], &mut r[..nt]);
            r
        };
        let mut ev = 0u64;
        for &b in e {
            ev = ev << 8 | b as u64;
        }
        let mut acc = sl.clone();
        for i in (0..63 - ev.leading_zeros()).rev() {
            acc = mulmod(&acc, &acc);
            if ev >> i & 1 == 1 {
                acc = mulmod(&acc, &sl);
            }
        }
        let mut out = vec![0u8; n.len()];
        le32_to_be(&acc, &mut out);
        out
    }
}
