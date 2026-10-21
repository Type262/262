//! SHA-1 (FIPS 180-4) in BPF: Solana has syscalls for SHA-256 and Keccak but not SHA-1, which
//! DNSSEC still needs for DS digest type 1 and algorithms 5/7 (RSASHA1).

pub fn sha1(parts: &[&[u8]]) -> [u8; 20] {
    let mut h: [u32; 5] = [0x6745_2301, 0xefcd_ab89, 0x98ba_dcfe, 0x1032_5476, 0xc3d2_e1f0];
    let mut block = [0u8; 64];
    let mut fill = 0usize;
    let mut total = 0u64;
    for part in parts {
        total += part.len() as u64;
        let mut p = *part;
        while !p.is_empty() {
            let take = (64 - fill).min(p.len());
            block[fill..fill + take].copy_from_slice(&p[..take]);
            fill += take;
            p = &p[take..];
            if fill == 64 {
                compress(&mut h, &block);
                fill = 0;
            }
        }
    }
    // Padding: 0x80, zeros, then the bit length as a big-endian u64.
    block[fill] = 0x80;
    block[fill + 1..].fill(0);
    if fill >= 56 {
        compress(&mut h, &block);
        block.fill(0);
    }
    block[56..].copy_from_slice(&(total * 8).to_be_bytes());
    compress(&mut h, &block);
    let mut out = [0u8; 20];
    for (i, w) in h.iter().enumerate() {
        out[4 * i..4 * i + 4].copy_from_slice(&w.to_be_bytes());
    }
    out
}

fn compress(h: &mut [u32; 5], block: &[u8; 64]) {
    // A 16-word rolling schedule keeps the stack small.
    let mut w = [0u32; 16];
    for i in 0..16 {
        w[i] = u32::from_be_bytes([block[4 * i], block[4 * i + 1], block[4 * i + 2], block[4 * i + 3]]);
    }
    let [mut a, mut b, mut c, mut d, mut e] = *h;
    // One loop per round function, so no round has to pick its function at run time.
    macro_rules! rounds {
        ($range:expr, $k:expr, |$b:ident, $c:ident, $d:ident| $f:expr) => {
            for i in $range {
                if i >= 16 {
                    w[i & 15] = (w[(i + 13) & 15] ^ w[(i + 8) & 15] ^ w[(i + 2) & 15] ^ w[i & 15]).rotate_left(1);
                }
                let ($b, $c, $d) = (b, c, d);
                let tmp = a.rotate_left(5).wrapping_add($f).wrapping_add(e).wrapping_add($k).wrapping_add(w[i & 15]);
                e = d;
                d = c;
                c = b.rotate_left(30);
                b = a;
                a = tmp;
            }
        };
    }
    rounds!(0..20, 0x5a82_7999u32, |b, c, d| d ^ (b & (c ^ d)));
    rounds!(20..40, 0x6ed9_eba1u32, |b, c, d| b ^ c ^ d);
    rounds!(40..60, 0x8f1b_bcdcu32, |b, c, d| (b & c) | (d & (b | c)));
    rounds!(60..80, 0xca62_c1d6u32, |b, c, d| b ^ c ^ d);
    h[0] = h[0].wrapping_add(a);
    h[1] = h[1].wrapping_add(b);
    h[2] = h[2].wrapping_add(c);
    h[3] = h[3].wrapping_add(d);
    h[4] = h[4].wrapping_add(e);
}

#[cfg(test)]
mod tests {
    use super::sha1;

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    #[test]
    fn vectors() {
        assert_eq!(hex(&sha1(&[b""])), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
        assert_eq!(hex(&sha1(&[b"abc"])), "a9993e364706816aba3e25717850c26c9cd0d89d");
        assert_eq!(
            hex(&sha1(&[b"abcdbcdecdefdefgefghfghighij", b"hijkijkljklmklmnlmnomnopnopq"])),
            "84983e441c3bd26ebaae4aa1f95129e5e54670f1"
        );
        let million = vec![b'a'; 1_000_000];
        assert_eq!(hex(&sha1(&[&million])), "34aa973cd4c4daa4f61eeb2bdbad27316534016f");
    }
}
