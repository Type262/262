//! RSA public-key operation (s^e mod n) for DNSSEC, in plain integer arithmetic: mainnet has no
//! modexp syscall (enable_big_mod_exp_syscall is not active), so it runs in BPF.
//!
//! Montgomery arithmetic on little-endian limbs: squarings sum each cross product once and double
//! it (s^2/2 multiplies) before the reduction (s^2), and the one multiply by the base uses CIOS
//! (2 s^2). The one value that needs a division, s*R mod n (s in Montgomery form), comes from a
//! single long division (Knuth D), which is much cheaper than first computing R^2 mod n.
//!
//! Two limb widths: u32 limbs with u64 products (SBPF v0 has no 64x64->128 multiply, so u128
//! products are slow there) and u64 limbs with u128 products (SBPF v2+ multiplies high halves).

extern crate alloc;
use alloc::{vec, vec::Vec};

/// Largest modulus handled: 4096 bits.
pub const MAX_BYTES: usize = 512;
const MAX32: usize = MAX_BYTES / 4;

/// -n0^-1 mod 2^32 (n0 odd), by Newton iteration: each step doubles the correct low bits.
fn neg_inv32(n0: u32) -> u32 {
    let mut x = n0; // correct to 3 bits for any odd n0
    for _ in 0..4 {
        x = x.wrapping_mul(2u32.wrapping_sub(n0.wrapping_mul(x)));
    }
    x.wrapping_neg()
}

fn neg_inv64(n0: u64) -> u64 {
    let mut x = n0;
    for _ in 0..5 {
        x = x.wrapping_mul(2u64.wrapping_sub(n0.wrapping_mul(x)));
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
        while qhat >> 32 != 0 || qhat * next > ((rhat << 32) | un[j + n - 2] as u64) {
            qhat -= 1;
            rhat += top;
            if rhat >> 32 != 0 {
                break;
            }
        }
        // un[j..j+n+1] -= qhat * vn
        let mut k: i64 = 0;
        for i in 0..n {
            let p = qhat * vn[i] as u64;
            let t = un[i + j] as i64 - k - (p & 0xffff_ffff) as i64;
            un[i + j] = t as u32;
            k = (p >> 32) as i64 - (t >> 32);
        }
        let t = un[j + n] as i64 - k;
        un[j + n] = t as u32;
        if t < 0 {
            // qhat was one too big: add v back
            let mut c = 0u64;
            for i in 0..n {
                let s = un[i + j] as u64 + vn[i] as u64 + c;
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

/// x * 2^(32*s) mod n, i.e. x in Montgomery form for R = 2^(32*s). n has s limbs (top limb may
/// be zero when n's byte length is not a multiple of the limb size).
fn to_mont32(x: &[u32], n: &[u32], out: &mut [u32]) {
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

// Montgomery arithmetic, generated for both limb widths. Loops run over equal-length slices in
// chunks of 8 with a constant inner trip count, so LLVM unrolls them into straight-line loads,
// multiplies and stores with fixed offsets and no bounds checks.
macro_rules! montgomery {
    ($m:ident, $L:ty, $W:ty) => {
        pub mod $m {
            use super::vec;
            type L = $L;
            type W = $W;
            const B: u32 = L::BITS;

            /// t += a * b (t.len() == a.len()); returns the carry limb.
            #[inline(always)]
            pub fn mac(t: &mut [L], a: &[L], b: L) -> L {
                let b = b as W;
                let mut c: W = 0;
                let mut tc = t.chunks_exact_mut(8);
                let mut ac = a.chunks_exact(8);
                for (tt, aa) in (&mut tc).zip(&mut ac) {
                    for k in 0..8 {
                        let x = tt[k] as W + aa[k] as W * b + c;
                        tt[k] = x as L;
                        c = x >> B;
                    }
                }
                for (tj, aj) in tc.into_remainder().iter_mut().zip(ac.remainder()) {
                    let x = *tj as W + *aj as W * b + c;
                    *tj = x as L;
                    c = x >> B;
                }
                c as L
            }

            /// r (s + 1 limbs, value < 2n) minus n if needed, into out.
            fn finish(r: &[L], n: &[L], out: &mut [L]) {
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
                    let mut borrow: L = 0;
                    for i in 0..s {
                        let (d1, b1) = r[i].overflowing_sub(n[i]);
                        let (d2, b2) = d1.overflowing_sub(borrow);
                        out[i] = d2;
                        borrow = (b1 | b2) as L;
                    }
                } else {
                    out.copy_from_slice(&r[..s]);
                }
            }

            /// out = a * b / R mod n (CIOS, with the window sliding up `t` instead of shifting it).
            /// `t` is scratch of 2s + 2 limbs.
            #[inline(never)]
            pub fn mul(a: &[L], b: &[L], n: &[L], n0: L, t: &mut [L], out: &mut [L]) {
                let s = n.len();
                t.fill(0);
                for i in 0..s {
                    let w = &mut t[i..i + s + 2];
                    let c = mac(&mut w[..s], a, b[i]);
                    let x = w[s] as W + c as W;
                    w[s] = x as L;
                    w[s + 1] = (x >> B) as L;
                    let m = w[0].wrapping_mul(n0);
                    let c = mac(&mut w[..s], n, m); // w[0] becomes 0: the window moves past it
                    let x = w[s] as W + c as W;
                    w[s] = x as L;
                    w[s + 1] = w[s + 1].wrapping_add((x >> B) as L);
                }
                finish(&t[s..2 * s + 1], n, out);
            }

            /// out = t / R mod n for t < n * R held in t[..2s] (t[2s..] zero). Clobbers t.
            #[inline(never)]
            pub fn reduce(t: &mut [L], n: &[L], n0: L, out: &mut [L]) {
                let s = n.len();
                for i in 0..s {
                    let m = t[i].wrapping_mul(n0);
                    let mut c = mac(&mut t[i..i + s], n, m) as W;
                    let mut k = i + s;
                    while c != 0 {
                        let x = t[k] as W + c;
                        t[k] = x as L;
                        c = x >> B;
                        k += 1;
                    }
                }
                finish(&t[s..2 * s + 1], n, out);
            }

            /// out = a * a / R mod n. Products a_i a_j with i < j are summed once and doubled,
            /// so a square costs s^2 / 2 multiplies before the s^2 of the reduction.
            #[inline(never)]
            pub fn sqr(a: &[L], n: &[L], n0: L, t: &mut [L], out: &mut [L]) {
                let s = n.len();
                t.fill(0);
                for i in 0..s - 1 {
                    let c = mac(&mut t[2 * i + 1..i + s], &a[i + 1..], a[i]);
                    t[i + s] = c;
                }
                let mut hi: L = 0;
                for k in 0..2 * s {
                    let v = t[k];
                    t[k] = (v << 1) | hi;
                    hi = v >> (B - 1);
                }
                let mut c: W = 0;
                for i in 0..s {
                    let sq = a[i] as W * a[i] as W;
                    let x = t[2 * i] as W + (sq as L) as W + c;
                    t[2 * i] = x as L;
                    c = x >> B;
                    let x = t[2 * i + 1] as W + (sq >> B) + c;
                    t[2 * i + 1] = x as L;
                    c = x >> B;
                }
                reduce(t, n, n0, out);
            }

            /// base^e mod n, base given in Montgomery form; result in normal form.
            pub fn pow(base: &[L], e: u64, n: &[L], n0: L, out: &mut [L]) {
                let s = n.len();
                let mut t = vec![0 as L; 2 * s + 2];
                let mut acc = base.to_vec();
                let mut tmp = vec![0 as L; s];
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
        }
    };
}

montgomery!(m32, u32, u64);
montgomery!(m64, u64, u128);

/// Checks the inputs every RSA verification needs: odd modulus of 512 to 4096 bits with no
/// leading zero byte, exponent 1..=4 bytes and at least 3, signature exactly as long as the
/// modulus and below it.
fn check_inputs(n: &[u8], e: &[u8], sig: &[u8]) -> Option<u64> {
    if n.len() < 64 || n.len() > MAX_BYTES || n[0] == 0 || n[n.len() - 1] & 1 == 0 {
        return None;
    }
    if e.is_empty() || e.len() > 4 || sig.len() != n.len() || sig >= n {
        return None; // same length, so byte order is numeric order
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

/// sig^e mod n into `out` (big-endian, n.len() bytes), with u32 limbs.
/// Buffers live on the heap: SBPF v0 stack frames are only 4 KB.
pub fn modexp32(n: &[u8], e: &[u8], sig: &[u8], out: &mut [u8]) -> bool {
    let Some(ev) = check_inputs(n, e, sig) else { return false };
    let s = n.len().div_ceil(4);
    let mut nl = vec![0u32; s];
    let mut sl = vec![0u32; s];
    let mut base = vec![0u32; s];
    be_to_le32(n, &mut nl);
    be_to_le32(sig, &mut sl);
    to_mont32(&sl, &nl, &mut base);
    m32::pow(&base, ev, &nl, neg_inv32(nl[0]), &mut sl);
    le32_to_be(&sl, out);
    true
}

/// sig^e mod n into `out` (big-endian, n.len() bytes), with u64 limbs.
pub fn modexp64(n: &[u8], e: &[u8], sig: &[u8], out: &mut [u8]) -> bool {
    let Some(ev) = check_inputs(n, e, sig) else { return false };
    let s = n.len().div_ceil(8);
    let mut n32 = vec![0u32; 2 * s];
    let mut s32 = vec![0u32; 2 * s];
    let mut b32 = vec![0u32; 2 * s];
    be_to_le32(n, &mut n32);
    be_to_le32(sig, &mut s32);
    // R = 2^(64*s) = 2^(32*2s), so the u32 long division gives the u64 Montgomery form too.
    to_mont32(&s32, &n32, &mut b32);
    let pack = |l: &[u32]| (0..s).map(|i| l[2 * i] as u64 | (l[2 * i + 1] as u64) << 32).collect::<Vec<u64>>();
    let nl = pack(&n32);
    let base = pack(&b32);
    let mut r = vec![0u64; s];
    m64::pow(&base, ev, &nl, neg_inv64(nl[0]), &mut r);
    for i in 0..s {
        n32[2 * i] = r[i] as u32;
        n32[2 * i + 1] = (r[i] >> 32) as u32;
    }
    le32_to_be(&n32, out);
    true
}

/// Benchmark helper: runs the long division and then one Montgomery operation (1 square,
/// 2 multiply, 3 reduce; 0 nothing), so each one's cost can be measured on its own.
pub fn phase32(n: &[u8], sig: &[u8], phase: u8) -> bool {
    let s = n.len().div_ceil(4);
    let (mut nl, mut sl, mut base) = (vec![0u32; s], vec![0u32; s], vec![0u32; s]);
    be_to_le32(n, &mut nl);
    be_to_le32(sig, &mut sl);
    if phase == 0 {
        return nl[0] & 1 == 1;
    }
    to_mont32(&sl, &nl, &mut base);
    let n0 = neg_inv32(nl[0]);
    let mut t = vec![0u32; 2 * s + 2];
    match phase {
        2 => m32::sqr(&base, &nl, n0, &mut t, &mut sl),
        3 => m32::mul(&base, &base, &nl, n0, &mut t, &mut sl),
        4 => {
            t[..s].copy_from_slice(&base);
            m32::reduce(&mut t, &nl, n0, &mut sl)
        }
        _ => {}
    }
    sl[0] != 7 // keep the work observable
}

/// Resumable sig^e mod n (u32 limbs) for keys too large for one instruction: the state lives in
/// an account and each instruction advances it by a few squarings.
/// Layout: u16 limbs s | u8 bits left | u8 unused | u32 e | u32 n0 | n | base | acc (s u32 each).
pub mod split {
    use super::*;

    pub const HEADER: usize = 12;

    pub fn size(n_len: usize) -> usize {
        HEADER + 12 * n_len.div_ceil(4)
    }

    fn get(d: &[u8], at: usize, s: usize) -> Vec<u32> {
        (0..s).map(|i| u32::from_le_bytes(d[at + 4 * i..at + 4 * i + 4].try_into().unwrap())).collect()
    }

    fn put(d: &mut [u8], at: usize, v: &[u32]) {
        for (i, x) in v.iter().enumerate() {
            d[at + 4 * i..at + 4 * i + 4].copy_from_slice(&x.to_le_bytes());
        }
    }

    /// Checks the inputs and does the long division (s*R mod n) and nothing else.
    pub fn start(n: &[u8], e: &[u8], sig: &[u8], state: &mut [u8]) -> bool {
        let Some(ev) = check_inputs(n, e, sig) else { return false };
        let s = n.len().div_ceil(4);
        let (mut nl, mut sl, mut base) = (vec![0u32; s], vec![0u32; s], vec![0u32; s]);
        be_to_le32(n, &mut nl);
        be_to_le32(sig, &mut sl);
        to_mont32(&sl, &nl, &mut base);
        state[0..2].copy_from_slice(&(s as u16).to_le_bytes());
        state[2] = (64 - ev.leading_zeros() - 1) as u8;
        state[4..8].copy_from_slice(&(ev as u32).to_le_bytes());
        state[8..12].copy_from_slice(&neg_inv32(nl[0]).to_le_bytes());
        put(state, HEADER, &nl);
        put(state, HEADER + 4 * s, &base);
        put(state, HEADER + 8 * s, &base);
        true
    }

    /// Up to `steps` exponent bits (a squaring, plus a multiply when the bit is set).
    /// Returns true once every bit is done.
    pub fn advance(state: &mut [u8], steps: u32) -> bool {
        let s = u16::from_le_bytes([state[0], state[1]]) as usize;
        let e = u32::from_le_bytes(state[4..8].try_into().unwrap());
        let n0 = u32::from_le_bytes(state[8..12].try_into().unwrap());
        let (nl, base, mut acc) = (get(state, HEADER, s), get(state, HEADER + 4 * s, s), get(state, HEADER + 8 * s, s));
        let (mut t, mut tmp) = (vec![0u32; 2 * s + 2], vec![0u32; s]);
        let mut left = state[2] as u32;
        for _ in 0..steps.min(left) {
            left -= 1;
            m32::sqr(&acc, &nl, n0, &mut t, &mut tmp);
            if e >> left & 1 == 1 {
                m32::mul(&tmp, &base, &nl, n0, &mut t, &mut acc);
            } else {
                core::mem::swap(&mut acc, &mut tmp);
            }
        }
        state[2] = left as u8;
        put(state, HEADER + 8 * s, &acc);
        left == 0
    }

    /// The finished result in normal form (big-endian, `out.len()` = modulus bytes).
    pub fn result(state: &[u8], out: &mut [u8]) -> bool {
        let s = u16::from_le_bytes([state[0], state[1]]) as usize;
        if state[2] != 0 {
            return false;
        }
        let n0 = u32::from_le_bytes(state[8..12].try_into().unwrap());
        let nl = get(state, HEADER, s);
        let mut t = vec![0u32; 2 * s + 2];
        t[..s].copy_from_slice(&get(state, HEADER + 8 * s, s));
        let mut r = vec![0u32; s];
        m32::reduce(&mut t, &nl, n0, &mut r);
        le32_to_be(&r, out);
        true
    }
}

/// DigestInfo prefixes from RFC 8017 section 9.2, note 1.
pub const SHA1_PREFIX: [u8; 15] = [0x30, 0x21, 0x30, 0x09, 0x06, 0x05, 0x2b, 0x0e, 0x03, 0x02, 0x1a, 0x05, 0x00, 0x04, 0x14];
pub const SHA256_PREFIX: [u8; 19] =
    [0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01, 0x05, 0x00, 0x04, 0x20];

/// The whole PKCS#1 v1.5 encoded message must match: 00 01 FF..FF 00 DigestInfo hash, with at
/// least 8 FF bytes. Building and comparing every byte leaves no room for loose parsing.
pub fn pkcs1_matches(em: &[u8], prefix: &[u8], hash: &[u8]) -> bool {
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
        && &em[pad_end + 1..pad_end + 1 + prefix.len()] == prefix
        && &em[k - hash.len()..] == hash
}

/// Splits a DNSKEY's RSA public key (RFC 3110) into exponent and modulus.
pub fn rsa_key(pubkey: &[u8]) -> Option<(&[u8], &[u8])> {
    let (elen, off) = match pubkey.first()? {
        0 => ((*pubkey.get(1)? as usize) << 8 | *pubkey.get(2)? as usize, 3),
        &l => (l as usize, 1),
    };
    if elen == 0 || pubkey.len() <= off + elen {
        return None;
    }
    Some((&pubkey[off..off + elen], &pubkey[off + elen..]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inverses() {
        for n0 in [1u32, 3, 0xffff_ffff, 0x1234_5679] {
            assert_eq!(n0.wrapping_mul(neg_inv32(n0)), u32::MAX);
        }
        for n0 in [1u64, 3, u64::MAX, 0x1234_5678_9abc_def1] {
            assert_eq!(n0.wrapping_mul(neg_inv64(n0)), u64::MAX);
        }
    }

    /// Both widths agree with a plain square-and-multiply on small odd moduli (64 bytes).
    #[test]
    fn modexp_matches_reference() {
        let mut seed = 0x9e37_79b9_7f4a_7c15u64;
        let mut rnd = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        for round in 0..50 {
            let len = [64usize, 67, 101, 128][round % 4]; // 67 and 101 leave the top limb partly empty
            let mut n: Vec<u8> = (0..len).map(|_| rnd() as u8).collect();
            n[0] |= 0x80;
            n[len - 1] |= 1;
            let mut sig: Vec<u8> = (0..len).map(|_| rnd() as u8).collect();
            sig[0] &= 0x7f;
            for e in [&[3u8][..], &[1, 0, 1]] {
                let (mut a, mut b) = (vec![0u8; len], vec![0u8; len]);
                assert!(modexp32(&n, e, &sig, &mut a));
                assert!(modexp64(&n, e, &sig, &mut b));
                assert_eq!(a, b);
                assert_eq!(a, reference(&n, e, &sig));
            }
        }
    }

    /// Schoolbook reference over big-endian bytes with u128 arithmetic on 32-bit digits.
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
