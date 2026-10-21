//! DNSSEC rules on wire-format data, with no accounts involved: parsing one signed RRset,
//! verifying it against its parent set, the cache replacement rule and the wallet record format.
//! Ported from the benchmarked reference (bench/src/dnssec.rs); docs/DNSSEC.md lists each rule
//! and where it comes from (ENS DNSSECImpl, RFC 4034/4035, the EVM DnssecVerifier).

use crate::constants::*;
use crate::errors::Type262Error as E;

pub type Res<T> = core::result::Result<T, E>;

/// Length of the uncompressed, canonical (lowercase) wire name at the start of `b`, and its
/// label count. Rejects compression pointers, empty or >63-byte labels, names over 255 bytes and
/// A-Z.
pub fn name_len(b: &[u8]) -> Res<(usize, u8)> {
    let mut at = 0usize;
    let mut labels = 0u8;
    loop {
        let l = *b.get(at).ok_or(E::BadSignedData)? as usize;
        if l == 0 {
            return Ok((at + 1, labels));
        }
        if l > 63 {
            return Err(E::BadName);
        }
        let label = b.get(at + 1..at + 1 + l).ok_or(E::BadSignedData)?;
        if label.iter().any(|c| c.is_ascii_uppercase()) {
            return Err(E::NameNotLowercase);
        }
        at += 1 + l;
        labels += 1;
        // The root label still has to follow, so at 255 the name is already too long.
        if at >= 255 {
            return Err(E::BadName);
        }
    }
}

/// True if `name` equals `ancestor` or is below it (both canonical wire names).
pub fn is_at_or_below(name: &[u8], name_labels: u8, ancestor: &[u8], ancestor_labels: u8) -> bool {
    if ancestor_labels > name_labels {
        return false;
    }
    let mut at = 0usize;
    for _ in 0..name_labels - ancestor_labels {
        at += 1 + name[at] as usize;
    }
    name[at..] == *ancestor
}

/// RFC 4034 appendix B. Algorithm 1 (RSAMD5) is never accepted, so its special case is unneeded.
pub fn key_tag(rdata: &[u8]) -> u16 {
    let mut ac = 0u32;
    for (i, &b) in rdata.iter().enumerate() {
        ac += if i & 1 == 0 {
            (b as u32) << 8
        } else {
            b as u32
        };
    }
    ac += (ac >> 16) & 0xffff;
    ac as u16
}

/// The RRSIG fields a step uses.
pub struct Rrsig<'a> {
    pub type_covered: u16,
    pub algorithm: u8,
    pub labels: u8,
    pub expiration: u32,
    pub inception: u32,
    pub key_tag: u16,
    pub signer: &'a [u8],
    pub signer_labels: u8,
}

/// A set of records with one owner and type: a parsed proof set, a cached parent or the root
/// anchors.
pub struct RRset<'a> {
    pub owner: &'a [u8],
    pub rrtype: u16,
    pub records: Vec<&'a [u8]>,
    /// Unix time after which the set may no longer be used; i64::MAX for the root anchors.
    pub expires_at: i64,
}

/// One signed set, parsed and checked as far as possible without a key.
pub struct Parsed<'a> {
    pub sig: Rrsig<'a>,
    /// expires_at is the RRSIG's own expiration here.
    pub set: RRset<'a>,
    /// The RRSIG inception as unix time.
    pub signed_at: i64,
}

/// A verified set: what a step caches.
pub struct Verified<'a> {
    /// expires_at is min(RRSIG expiration, parent expiry).
    pub set: RRset<'a>,
    pub algorithm: u8,
    pub key_tag: u16,
    pub signed_at: i64,
}

/// Parses "RRSIG RDATA without signature || RRs in canonical wire form" (RFC 4035 5.3.2, what
/// dnsprovejs `SignedSet.toWire()` produces) and runs every check that needs no key.
pub fn parse_signed(signed: &[u8], now: i64) -> Res<Parsed<'_>> {
    let h = signed.get(..18).ok_or(E::BadSignedData)?;
    let u16_at = |b: &[u8], i: usize| u16::from_be_bytes([b[i], b[i + 1]]);
    let u32_at = |b: &[u8], i: usize| u32::from_be_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]);
    let (slen, slabels) = name_len(&signed[18..])?;
    let sig = Rrsig {
        type_covered: u16_at(h, 0),
        algorithm: h[2],
        labels: h[3],
        expiration: u32_at(h, 8),
        inception: u32_at(h, 12),
        key_tag: u16_at(h, 16),
        signer: &signed[18..18 + slen],
        signer_labels: slabels,
    };

    let mut at = 18 + slen;
    let mut owner: &[u8] = &[];
    let mut owner_labels = 0u8;
    let mut records = Vec::new();
    while at < signed.len() {
        let (nlen, labels) = name_len(&signed[at..])?;
        let name = &signed[at..at + nlen];
        if records.is_empty() {
            owner = name;
            owner_labels = labels;
        } else if name != owner {
            return Err(E::InvalidRRSet);
        }
        let f = signed
            .get(at + nlen..at + nlen + 10)
            .ok_or(E::BadSignedData)?;
        if u16_at(f, 0) != sig.type_covered {
            return Err(E::SignatureTypeMismatch);
        }
        if u16_at(f, 2) != CLASS_INET {
            return Err(E::InvalidClass);
        }
        let rdlen = u16_at(f, 8) as usize;
        let start = at + nlen + 10;
        records.push(signed.get(start..start + rdlen).ok_or(E::BadSignedData)?);
        at = start + rdlen;
    }
    if records.is_empty() {
        return Err(E::EmptyRRset);
    }
    // Wildcard expansions carry fewer RRSIG labels than the owner name: rejected, as in ENS.
    if owner_labels != sig.labels {
        return Err(E::InvalidLabelCount);
    }
    if !is_at_or_below(owner, owner_labels, sig.signer, sig.signer_labels) {
        return Err(E::InvalidSignerName);
    }
    // A DS set belongs to the parent zone (RFC 4035 2.4, 5.2): its signer must be a proper
    // ancestor. Signed by the zone itself, it could replace the delegation its parent publishes.
    if sig.type_covered == TYPE_DS && owner_labels == sig.signer_labels {
        return Err(E::InvalidSignerName);
    }
    // RFC 4034 3.1.5: serial number arithmetic (RFC 1982) against the current time.
    let now32 = now as u32;
    let left = sig.expiration.wrapping_sub(now32) as i32;
    let age = now32.wrapping_sub(sig.inception) as i32;
    if left < 0 {
        return Err(E::SignatureExpired);
    }
    if age < 0 {
        return Err(E::SignatureNotValidYet);
    }
    let set = RRset {
        owner,
        rrtype: sig.type_covered,
        records,
        expires_at: now + left as i64,
    };
    Ok(Parsed {
        sig,
        set,
        signed_at: now - age as i64,
    })
}

/// The parent a set must be checked against, as (owner, type): the DS set at the owner for a
/// self-signed DNSKEY set (the root anchors for the root), else the DNSKEY set at the signer.
/// The program derives the parent from this, so a caller can never pick another one.
pub fn parent_of<'a>(p: &Parsed<'a>) -> (&'a [u8], u16) {
    if p.sig.type_covered == TYPE_DNSKEY && p.set.owner == p.sig.signer {
        (p.set.owner, TYPE_DS)
    } else {
        (p.sig.signer, TYPE_DNSKEY)
    }
}

/// True if a DNSKEY record may have made this signature (RFC 4034 2.1, RFC 5011 7): zone key,
/// not revoked, protocol 3, the RRSIG's algorithm and key tag.
fn key_usable(rdata: &[u8], sig: &Rrsig) -> bool {
    rdata.len() > 4
        && u16::from_be_bytes([rdata[0], rdata[1]]) & (DNSKEY_FLAG_ZONE | DNSKEY_FLAG_REVOKE)
            == DNSKEY_FLAG_ZONE
        && rdata[2] == DNSKEY_PROTOCOL
        && rdata[3] == sig.algorithm
        && key_tag(rdata) == sig.key_tag
}

/// True if a DS record in `ds_set` commits to `key` at `owner`: same key tag and algorithm,
/// digest type 1 (SHA-1) or 2 (SHA-256) over owner wire name || DNSKEY RDATA.
fn ds_matches(ds_set: &RRset, owner: &[u8], key: &[u8]) -> bool {
    let tag = key_tag(key).to_be_bytes();
    ds_set.records.iter().any(|ds| {
        if ds.len() < 4 || ds[..2] != tag || ds[2] != key[3] {
            return false;
        }
        match ds[3] {
            DIGEST_SHA1 => ds.len() == 24 && super::sha1::sha1(&[owner, key])[..] == ds[4..],
            DIGEST_SHA256 => ds.len() == 36 && sha256(&[owner, key])[..] == ds[4..],
            _ => false,
        }
    })
}

pub fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    anchor_lang::solana_program::hash::hashv(parts).to_bytes()
}

/// Verifies a parsed set against `parent`, which the caller found from `parent_of` (checked
/// again here by owner and type). `check_sig(algorithm, dnskey_rdata)` checks the RRSIG
/// signature with one key.
pub fn verify_step<'a>(
    p: Parsed<'a>,
    parent: &RRset,
    now: i64,
    mut check_sig: impl FnMut(u8, &[u8]) -> bool,
) -> Res<Verified<'a>> {
    let (want_owner, want_type) = parent_of(&p);
    if parent.owner != want_owner || parent.rrtype != want_type {
        return Err(E::WrongParent);
    }
    if now > parent.expires_at {
        return Err(E::ParentExpired);
    }
    let Parsed {
        sig,
        set,
        signed_at,
    } = p;
    let ok = |mut set: RRset<'a>| {
        set.expires_at = set.expires_at.min(parent.expires_at);
        Verified {
            set,
            algorithm: sig.algorithm,
            key_tag: sig.key_tag,
            signed_at,
        }
    };
    if want_type == TYPE_DS {
        // Self-signed key set: a key in the set itself must verify the signature and match a DS
        // record (ENS verifyWithDS).
        let mut signed_ok = false;
        for i in 0..set.records.len() {
            let key = set.records[i];
            if key_usable(key, &sig) && check_sig(sig.algorithm, key) {
                signed_ok = true;
                if ds_matches(parent, set.owner, key) {
                    return Ok(ok(set));
                }
            }
        }
        return Err(if signed_ok {
            E::NoMatchingDs
        } else {
            E::NoKeyVerified
        });
    }
    // Any other set: some key of the zone's DNSKEY set verifies it (ENS verifyWithKnownKey).
    for key in parent.records.iter() {
        if key_usable(key, &sig) && check_sig(sig.algorithm, key) {
            return Ok(ok(set));
        }
    }
    Err(E::NoKeyVerified)
}

/// Cache rule: a new result replaces the stored one only if it was signed later, or signed at
/// the same time but with other records or valid longer, or the stored one has expired. Older
/// data can never roll a cache entry back while the newer entry is still valid. Some signers give
/// every signature of a period the same inception (and expiration), so a zone's new set can tie
/// with the one it replaces; letting a tie with other content through means the zone's current
/// set can always be cached (the escrow settles ties on its own, see escrow::accept_proof).
pub fn replaces(new: &RRset, new_signed: i64, old: &RRset, old_signed: i64, now: i64) -> bool {
    new_signed > old_signed
        || (new_signed == old_signed
            && (new.expires_at > old.expires_at || new.records != old.records))
        || now > old.expires_at
}

// ---------- wallet record ----------

const B58: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/// Exactly 32 bytes from base58, or None. Leading '1's are leading zero bytes, as in every
/// Solana encoder, so each key has one accepted spelling.
pub fn base58_32(s: &[u8]) -> Option<[u8; 32]> {
    if s.is_empty() || s.len() > 44 {
        return None;
    }
    let mut out = [0u8; 32];
    for &c in s {
        let mut carry = B58.iter().position(|&x| x == c)? as u32;
        for b in out.iter_mut().rev() {
            carry += (*b as u32) * 58;
            *b = carry as u8;
            carry >>= 8;
        }
        if carry != 0 {
            return None;
        }
    }
    // Each leading '1' stands for one leading zero byte, so the string decodes to exactly 32
    // bytes only when the counts agree. Any other count is a different length, as bs58 reports.
    let ones = s.iter().take_while(|&&c| c == b'1').count();
    let zeros = out.iter().take_while(|&&b| b == 0).count();
    if ones != zeros {
        return None;
    }
    Some(out)
}

/// The Solana address a WALLET or _wallet TXT record publishes, if it publishes one for coin
/// SOL. Same shapes as the EVM verifier: two character-strings "SOL" "<base58>", or one
/// "SOL <base58>" / "SOL:<base58>" where any run of spaces and colons separates the parts.
/// The coin is case-insensitive; the address is case-sensitive and nothing may follow it.
pub fn sol_wallet(rdata: &[u8]) -> Option<[u8; 32]> {
    let l0 = *rdata.first()? as usize;
    if 1 + l0 > rdata.len() {
        return None;
    }
    let (coin, addr): (&[u8], &[u8]) = if 1 + l0 == rdata.len() {
        let s = &rdata[1..];
        let i = s.iter().position(|&c| c == b' ' || c == b':')?;
        let j = i + s[i..]
            .iter()
            .take_while(|&&c| c == b' ' || c == b':')
            .count();
        (&s[..i], &s[j..])
    } else {
        let l1 = rdata[1 + l0] as usize;
        if 2 + l0 + l1 != rdata.len() {
            return None;
        }
        (&rdata[1..1 + l0], &rdata[2 + l0..])
    };
    if !coin.eq_ignore_ascii_case(COIN_SOL) {
        return None;
    }
    let key = base58_32(addr)?;
    if key == [0u8; 32] {
        return None; // the system program, never a wallet
    }
    Some(key)
}

/// "example.com" in wire form (7example3com0), optionally under a first label such as
/// "_wallet". None unless every label is 1-63 bytes and the whole name at most 255.
pub fn wire_name(domain: &str, first_label: Option<&[u8]>) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(domain.len() + 10);
    for label in first_label
        .into_iter()
        .chain(domain.as_bytes().split(|&c| c == b'.'))
    {
        if label.is_empty() || label.len() > 63 {
            return None;
        }
        out.push(label.len() as u8);
        out.extend_from_slice(label);
    }
    out.push(0);
    (out.len() <= 255).then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn code(e: E) -> u32 {
        e as u32
    }

    #[test]
    fn names() {
        assert_eq!(name_len(b"\x03com\x00").unwrap(), (5, 1));
        assert_eq!(name_len(b"\x00").unwrap(), (1, 0));
        assert_eq!(
            name_len(b"\x03Com\x00").map_err(code),
            Err(code(E::NameNotLowercase))
        );
        assert_eq!(name_len(b"\xc0\x0c").map_err(code), Err(code(E::BadName)));
        assert_eq!(
            name_len(b"\x03com").map_err(code),
            Err(code(E::BadSignedData))
        );
        // 4 labels of 63 = 256 bytes before the root label: too long. 3 of 63 + one of 61 fits.
        let label = |n: usize| [&[n as u8][..], &vec![b'a'; n]].concat();
        let long = [label(63), label(63), label(63), label(63), vec![0]].concat();
        assert_eq!(name_len(&long).map_err(code), Err(code(E::BadName)));
        let max = [label(63), label(63), label(63), label(61), vec![0]].concat();
        assert_eq!(name_len(&max).unwrap(), (255, 4));
        assert!(is_at_or_below(b"\x01a\x03com\x00", 2, b"\x03com\x00", 1));
        assert!(is_at_or_below(b"\x03com\x00", 1, b"\x00", 0));
        assert!(!is_at_or_below(b"\x03com\x00", 1, b"\x03org\x00", 1));
        assert!(!is_at_or_below(b"\x03com\x00", 1, b"\x01a\x03com\x00", 2));
        assert_eq!(
            wire_name("example.com", None).unwrap(),
            b"\x07example\x03com\x00"
        );
        assert_eq!(
            wire_name("a.io", Some(b"_wallet")).unwrap(),
            b"\x07_wallet\x01a\x02io\x00"
        );
        assert!(wire_name("a..io", None).is_none());
        assert!(wire_name("", None).is_none());
        assert!(wire_name(&"a".repeat(64), None).is_none());
    }

    #[test]
    fn replacement_rule() {
        let set = |records: &[&'static [u8]], expires_at: i64| RRset {
            owner: b"\x01a\x00",
            rrtype: TYPE_TXT,
            records: records.to_vec(),
            expires_at,
        };
        let r = |new: &RRset, ns: i64, old: &RRset, os: i64| replaces(new, ns, old, os, 150);
        const A: &[&[u8]] = &[b"\x01a"];
        const B: &[&[u8]] = &[b"\x01b"];
        const AB: &[&[u8]] = &[b"\x01a", b"\x01b"];
        assert!(r(&set(A, 900), 200, &set(A, 900), 100)); // newer signature
        assert!(!r(&set(B, 900), 100, &set(A, 900), 200)); // older one, while the newer is valid
        assert!(!r(&set(A, 900), 200, &set(A, 900), 200)); // the same again: no write
        assert!(r(&set(A, 950), 200, &set(A, 900), 200)); // same signature, longer validity
                                                          // Same records, shorter validity: no write either.
        assert!(!r(&set(A, 850), 200, &set(A, 900), 200));
        // Same signing time, other records: the zone's current set, even if it expires sooner.
        assert!(r(&set(B, 850), 200, &set(A, 900), 200));
        assert!(r(&set(AB, 900), 200, &set(A, 900), 200));
        assert!(r(&set(B, 900), 50, &set(A, 120), 200)); // the stored one expired
    }

    #[test]
    fn wallet_records() {
        let key = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
        let want = base58_32(key.as_bytes()).unwrap();
        let txt = |s: &str| [&[s.len() as u8][..], s.as_bytes()].concat();
        assert_eq!(sol_wallet(&txt(&format!("SOL {key}"))), Some(want));
        assert_eq!(sol_wallet(&txt(&format!("sol:{key}"))), Some(want));
        assert_eq!(sol_wallet(&txt(&format!("SOL  {key}"))), Some(want));
        assert_eq!(sol_wallet(&txt(&format!("Sol : {key}"))), Some(want));
        assert_eq!(sol_wallet(&[txt("SOL"), txt(key)].concat()), Some(want));
        assert_eq!(sol_wallet(&txt(&format!("ETH {key}"))), None);
        assert_eq!(sol_wallet(&txt(&format!("SOL {key} x"))), None);
        assert_eq!(sol_wallet(&txt(&format!("SOL {key}1"))), None);
        assert_eq!(sol_wallet(&txt(&format!("SOLANA {key}"))), None);
        assert_eq!(sol_wallet(&txt(key)), None);
        assert_eq!(
            sol_wallet(&txt("SOL 11111111111111111111111111111111")),
            None
        );
        assert_eq!(sol_wallet(&[txt("SOL"), txt(key), txt("x")].concat()), None);
        assert_eq!(sol_wallet(&[]), None);
        assert_eq!(sol_wallet(&[5, b'S']), None);
        // The Token program is TokenkegQ..., the System Program 32 zero bytes.
        let token = base58_32(b"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").unwrap();
        assert_eq!(&token[..4], &[6, 221, 246, 225]);
        assert_eq!(
            base58_32(b"11111111111111111111111111111111"),
            Some([0; 32])
        );
        assert_eq!(base58_32(b"0OIl"), None);
        // One leading zero byte has one spelling.
        let mut z = [9u8; 32];
        z[0] = 0;
        let s = anchor_lang::prelude::Pubkey::new_from_array(z).to_string();
        assert!(s.starts_with('1'));
        assert_eq!(base58_32(s.as_bytes()), Some(z));
        assert_eq!(base58_32(format!("1{s}").as_bytes()), None);
    }

    #[test]
    fn key_tags() {
        // The root KSK-2024 key tag (38696) from its RDATA in the real proof fixtures is checked
        // in the LiteSVM suite; here the algorithm on a hand-made record.
        assert_eq!(key_tag(&[1, 1, 3, 8]), (0x0101 + 0x0308) as u16);
        assert_eq!(key_tag(&[0xff, 0xff, 0xff, 0xff]), 0xffff);
    }
}
