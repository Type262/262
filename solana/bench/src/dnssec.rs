//! One DNSSEC proof step: verify a signed RRset against an already verified parent set (or the
//! IANA root anchors), with the same rules as ENS's DNSSECImpl plus a few stricter ones. This is
//! the reference the production program ports; the benchmark runs it on real proofs.
//!
//! A step is the unit the Solana program caches: the result is one verified RRset (owner, type,
//! RDATA list, signing time, effective expiry) that later steps use as their parent.

extern crate alloc;
use alloc::vec::Vec;

pub const CLASS_IN: u16 = 1;
pub const TYPE_TXT: u16 = 16;
pub const TYPE_DS: u16 = 43;
pub const TYPE_DNSKEY: u16 = 48;
pub const TYPE_WALLET: u16 = 262;

const FLAG_ZONE: u16 = 0x0100; // DNSKEY flags bit 7 (RFC 4034 2.1.1)
const FLAG_REVOKE: u16 = 0x0080; // bit 8 (RFC 5011 7)

/// Root DS records from https://data.iana.org/root-anchors/root-anchors.xml, as DS RDATA:
/// key tag, algorithm 8, digest type 2, SHA-256 digest. KSK-2017 and KSK-2024.
pub const ROOT_ANCHORS: [[u8; 36]; 2] = [
    hex36("4f660802e06d44b80b8f1d39a95c0b0d7c65d08458e880409bbc683457104237c7f8ec8d"),
    hex36("97280802683d2d0acb8c9b712a1948b27f741219298d0a450d612c483af444a4c0fb2b16"),
];

const fn hex36(s: &str) -> [u8; 36] {
    let b = s.as_bytes();
    let mut out = [0u8; 36];
    let mut i = 0;
    while i < 36 {
        out[i] = (nib(b[2 * i]) << 4) | nib(b[2 * i + 1]);
        i += 1;
    }
    out
}

const fn nib(c: u8) -> u8 {
    if c <= b'9' { c - b'0' } else { c - b'a' + 10 }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepError {
    BadSignedData = 10,
    BadName,
    NotLowercase,
    EmptyRRset,
    BadClass,
    OwnerMismatch,
    TypeMismatch,
    LabelCount,
    Expired,
    NotYetValid,
    SignerNotAncestor,
    WrongParent,
    ParentExpired,
    UnsupportedAlgorithm,
    NoKeyVerified,
    NoMatchingDs,
}

/// Length of the uncompressed, canonical (lowercase) wire name at the start of `b`, and its label
/// count. Rejects compression pointers, empty or >63-byte labels, names over 255 bytes and A-Z.
pub fn name_len(b: &[u8]) -> Result<(usize, u8), StepError> {
    let mut at = 0usize;
    let mut labels = 0u8;
    loop {
        let l = *b.get(at).ok_or(StepError::BadName)? as usize;
        if l == 0 {
            at += 1;
            break;
        }
        if l > 63 {
            return Err(StepError::BadName);
        }
        let label = b.get(at + 1..at + 1 + l).ok_or(StepError::BadName)?;
        if label.iter().any(|c| c.is_ascii_uppercase()) {
            return Err(StepError::NotLowercase);
        }
        at += 1 + l;
        labels += 1;
    }
    if at > 255 {
        return Err(StepError::BadName);
    }
    Ok((at, labels))
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
    &name[at..] == ancestor
}

/// RFC 4034 appendix B. Algorithm 1 (RSAMD5) is never accepted, so its special case is unneeded.
pub fn key_tag(rdata: &[u8]) -> u16 {
    let mut ac = 0u32;
    for (i, &b) in rdata.iter().enumerate() {
        ac += if i & 1 == 0 { (b as u32) << 8 } else { b as u32 };
    }
    ac += (ac >> 16) & 0xffff;
    ac as u16
}

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

/// A verified (or trusted) RRset: what a step reads as parent and writes as result.
pub struct RRset<'a> {
    pub owner: &'a [u8],
    pub rrtype: u16,
    pub records: Vec<&'a [u8]>,
    /// Unix time; i64::MAX for the root anchors.
    pub expires_at: i64,
}

pub struct Verified<'a> {
    pub set: RRset<'a>,
    pub algorithm: u8,
    pub key_tag: u16,
    pub signed_at: i64,
}

/// Parses "RRSIG RDATA without signature || canonical RRs" (RFC 4035 5.3.2, the oracle's
/// `rrset` field) and runs every check that needs no key.
pub fn parse_signed(signed: &[u8], now: i64) -> Result<(Rrsig<'_>, RRset<'_>, u8, i64, i64), StepError> {
    let h = signed.get(..18).ok_or(StepError::BadSignedData)?;
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
            return Err(StepError::OwnerMismatch);
        }
        let f = signed.get(at + nlen..at + nlen + 10).ok_or(StepError::BadSignedData)?;
        if u16_at(f, 0) != sig.type_covered {
            return Err(StepError::TypeMismatch);
        }
        if u16_at(f, 2) != CLASS_IN {
            return Err(StepError::BadClass);
        }
        let rdlen = u16_at(f, 8) as usize;
        let start = at + nlen + 10;
        records.push(signed.get(start..start + rdlen).ok_or(StepError::BadSignedData)?);
        at = start + rdlen;
    }
    if records.is_empty() {
        return Err(StepError::EmptyRRset);
    }
    // Wildcard expansions carry fewer RRSIG labels than the owner name: rejected, as in ENS.
    if owner_labels != sig.labels {
        return Err(StepError::LabelCount);
    }
    if !is_at_or_below(owner, owner_labels, sig.signer, sig.signer_labels) {
        return Err(StepError::SignerNotAncestor);
    }
    // RFC 4034 3.1.5: serial number arithmetic (RFC 1982) against the current time.
    let now32 = now as u32;
    let left = sig.expiration.wrapping_sub(now32) as i32;
    let age = now32.wrapping_sub(sig.inception) as i32;
    if left < 0 {
        return Err(StepError::Expired);
    }
    if age < 0 {
        return Err(StepError::NotYetValid);
    }
    let expires = now + left as i64;
    let signed_at = now - age as i64;
    let set = RRset { owner, rrtype: sig.type_covered, records, expires_at: expires };
    Ok((sig, set, owner_labels, signed_at, expires))
}

/// The parent a step must be checked against: the DS set at the owner for a self-signed DNSKEY
/// set (the root anchors for the root), else the DNSKEY set at the signer. The program derives
/// the parent account from these, so a caller can never pick another one.
pub fn parent_of(sig: &Rrsig, set: &RRset) -> (Vec<u8>, u16) {
    if sig.type_covered == TYPE_DNSKEY && set.owner == sig.signer {
        (set.owner.to_vec(), TYPE_DS)
    } else {
        (sig.signer.to_vec(), TYPE_DNSKEY)
    }
}

fn key_usable(rdata: &[u8], sig: &Rrsig) -> bool {
    rdata.len() > 4
        && u16::from_be_bytes([rdata[0], rdata[1]]) & (FLAG_ZONE | FLAG_REVOKE) == FLAG_ZONE
        && rdata[2] == 3
        && rdata[3] == sig.algorithm
        && key_tag(rdata) == sig.key_tag
}

fn ds_matches(ds_set: &RRset, owner: &[u8], key: &[u8]) -> bool {
    let tag = key_tag(key).to_be_bytes();
    ds_set.records.iter().any(|ds| {
        if ds.len() < 4 || ds[..2] != tag || ds[2] != key[3] {
            return false;
        }
        match ds[3] {
            1 => ds.len() == 24 && crate::sha1::sha1(&[owner, key])[..] == ds[4..],
            2 => ds.len() == 36 && crate::sha256(&[owner, key])[..] == ds[4..],
            _ => false,
        }
    })
}

/// Verifies one signed RRset. `parent` must be the set `parent_of` names (checked here by owner and
/// type). `check_sig(algorithm, dnskey_rdata)` verifies the RRSIG signature with that key.
pub fn verify_step<'a>(
    signed: &'a [u8],
    now: i64,
    parent: &RRset,
    mut check_sig: impl FnMut(u8, &[u8]) -> bool,
) -> Result<Verified<'a>, StepError> {
    let (sig, mut set, _, signed_at, expires) = parse_signed(signed, now)?;
    if !matches!(sig.algorithm, 5 | 7 | 8 | 13 | 15) {
        return Err(StepError::UnsupportedAlgorithm);
    }
    let (want_owner, want_type) = parent_of(&sig, &set);
    if parent.owner != &want_owner[..] || parent.rrtype != want_type {
        return Err(StepError::WrongParent);
    }
    if now > parent.expires_at {
        return Err(StepError::ParentExpired);
    }
    if want_type == TYPE_DS {
        // Self-signed key set: a key in the set must verify the signature and match a DS record.
        let mut signed_ok = false;
        for key in set.records.iter() {
            if key_usable(key, &sig) && check_sig(sig.algorithm, key) {
                signed_ok = true;
                if ds_matches(parent, set.owner, key) {
                    set.expires_at = expires.min(parent.expires_at);
                    return Ok(Verified { set, algorithm: sig.algorithm, key_tag: sig.key_tag, signed_at });
                }
            }
        }
        return Err(if signed_ok { StepError::NoMatchingDs } else { StepError::NoKeyVerified });
    }
    for key in parent.records.iter() {
        if key_usable(key, &sig) && check_sig(sig.algorithm, key) {
            set.expires_at = expires.min(parent.expires_at);
            return Ok(Verified { set, algorithm: sig.algorithm, key_tag: sig.key_tag, signed_at });
        }
    }
    Err(StepError::NoKeyVerified)
}

pub fn root_anchors() -> RRset<'static> {
    RRset { owner: &[0], rrtype: TYPE_DS, records: ROOT_ANCHORS.iter().map(|r| &r[..]).collect(), expires_at: i64::MAX }
}

/// Cache rule: a new result replaces the stored one only if it was signed later, or signed at the
/// same time but stays valid longer, or the stored one has expired. Older data can never roll a
/// cache entry back while the newer entry is still valid.
pub fn replaces(new_signed: i64, new_expires: i64, old_signed: i64, old_expires: i64, now: i64) -> bool {
    new_signed > old_signed || (new_signed == old_signed && new_expires > old_expires) || now > old_expires
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
    // Each leading '1' stands for one leading zero byte, so the string decodes to exactly 32 bytes
    // only when the counts agree. Any other count is a different length, as bs58 would report.
    let ones = s.iter().take_while(|&&c| c == b'1').count();
    let zeros = out.iter().take_while(|&&b| b == 0).count();
    if ones != zeros {
        return None;
    }
    Some(out)
}

/// The Solana address a WALLET or _wallet TXT record publishes, if it publishes exactly one for
/// coin SOL. Same shapes as the EVM verifier: two character-strings "SOL" "<base58>", or one
/// "SOL <base58>" / "SOL:<base58>". Coin is case-insensitive; the address is case-sensitive.
pub fn sol_wallet(rdata: &[u8]) -> Option<[u8; 32]> {
    let l0 = *rdata.first()? as usize;
    if 1 + l0 > rdata.len() {
        return None;
    }
    let (coin, addr): (&[u8], &[u8]) = if 1 + l0 == rdata.len() {
        let s = &rdata[1..];
        let i = s.iter().position(|&c| c == b' ' || c == b':')?;
        let j = i + s[i..].iter().take_while(|&&c| c == b' ' || c == b':').count();
        (&s[..i], &s[j..])
    } else {
        let l1 = rdata[1 + l0] as usize;
        if 2 + l0 + l1 != rdata.len() {
            return None;
        }
        (&rdata[1..1 + l0], &rdata[2 + l0..])
    };
    if !coin.eq_ignore_ascii_case(b"SOL") {
        return None;
    }
    let key = base58_32(addr)?;
    if key == [0u8; 32] {
        return None; // the system program, never a wallet
    }
    Some(key)
}

/// True if a verified leaf set publishes `recipient` for `domain` (canonical wire name): a WALLET
/// set at the domain itself or a TXT set at _wallet.<domain>, with any record naming that SOL
/// address. As in DnssecVerifier, the caller names the recipient and the proof must show it;
/// every other record in the set (ETH, notes, a second SOL line) is ignored.
pub fn publishes(set: &RRset, domain_wire: &[u8], recipient: &[u8; 32]) -> bool {
    let ok_owner = match set.rrtype {
        TYPE_WALLET => set.owner == domain_wire,
        TYPE_TXT => {
            set.owner.len() == domain_wire.len() + 8 && set.owner.starts_with(b"\x07_wallet") && &set.owner[8..] == domain_wire
        }
        _ => false,
    };
    ok_owner && set.records.iter().any(|r| sol_wallet(r).as_ref() == Some(recipient))
}

#[cfg(target_os = "solana")]
pub use program::process_step;

#[cfg(target_os = "solana")]
mod program {
    use super::*;
    use crate::{introspect, rsa_verify, Fields};
    use solana_account_info::AccountInfo;
    use solana_program_error::{ProgramError, ProgramResult};

    /// Bench cache account layout (the production account adds Anchor's 8-byte discriminator):
    /// 0 version u8 | 1 type u16 | 3 algorithm u8 | 4 key tag u16 | 6 records u16 |
    /// 8 signed_at i64 | 16 expires_at i64 | 24 owner length u8 | 25 owner | records as [u16 len, RDATA]
    pub const HEADER: usize = 25;

    pub fn read_set(d: &[u8]) -> Option<(RRset<'_>, i64)> {
        if d.first() != Some(&1) {
            return None;
        }
        let le64 = |i: usize| i64::from_le_bytes(d[i..i + 8].try_into().unwrap());
        let n = u16::from_le_bytes([d[6], d[7]]) as usize;
        let olen = d[24] as usize;
        let owner = d.get(HEADER..HEADER + olen)?;
        let mut f = Fields(&d[HEADER + olen..]);
        let mut records = Vec::with_capacity(n);
        for _ in 0..n {
            records.push(f.next()?);
        }
        Some((RRset { owner, rrtype: u16::from_le_bytes([d[1], d[2]]), records, expires_at: le64(16) }, le64(8)))
    }

    fn write_set(d: &mut [u8], v: &Verified) -> Result<(), ProgramError> {
        let size = HEADER + v.set.owner.len() + v.set.records.iter().map(|r| 2 + r.len()).sum::<usize>();
        if d.len() < size {
            return Err(ProgramError::AccountDataTooSmall);
        }
        d[0] = 1;
        d[1..3].copy_from_slice(&v.set.rrtype.to_le_bytes());
        d[3] = v.algorithm;
        d[4..6].copy_from_slice(&v.key_tag.to_le_bytes());
        d[6..8].copy_from_slice(&(v.set.records.len() as u16).to_le_bytes());
        d[8..16].copy_from_slice(&v.signed_at.to_le_bytes());
        d[16..24].copy_from_slice(&v.set.expires_at.to_le_bytes());
        d[24] = v.set.owner.len() as u8;
        let mut at = HEADER;
        d[at..at + v.set.owner.len()].copy_from_slice(v.set.owner);
        at += v.set.owner.len();
        for r in &v.set.records {
            d[at..at + 2].copy_from_slice(&(r.len() as u16).to_le_bytes());
            d[at + 2..at + 2 + r.len()].copy_from_slice(r);
            at += 2 + r.len();
        }
        Ok(())
    }

    /// data: [flags, precompile ix, entry, now i64, then either [u16 len, signed, u16 len, sig]
    /// inline (flags bit 0 clear) or nothing, with the same fields in account 3 (flags bit 0 set)].
    /// flags bit 1: find the precompile entry by scanning instead of using (precompile ix, entry).
    /// Accounts: 0 parent cache (ignored for the root key set), 1 result cache (writable),
    /// 2 instructions sysvar, 3 buffer (optional). `now` comes from the instruction so the bench
    /// can replay old proofs; the program reads the Clock sysvar instead.
    pub fn process_step(accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
        let err = |e: StepError| ProgramError::Custom(e as u32);
        let (flags, sig_ix, entry) = (data[0], data[1] as u16, data[2]);
        let now = i64::from_le_bytes(data[3..11].try_into().unwrap());
        let buffer;
        let (signed, sig, msg_offset) = if flags & 1 == 0 {
            let mut f = Fields(&data[11..]);
            let signed = f.next().ok_or(ProgramError::InvalidInstructionData)?;
            // +1 for the op byte in front of `data`, +11 for the fixed fields, +2 for the length.
            (signed, f.next().ok_or(ProgramError::InvalidInstructionData)?, 1 + 11 + 2)
        } else {
            buffer = accounts[3].try_borrow_data()?;
            let mut f = Fields(&buffer);
            let signed = f.next().ok_or(ProgramError::InvalidInstructionData)?;
            (signed, f.next().ok_or(ProgramError::InvalidInstructionData)?, usize::MAX)
        };

        let parent_data = accounts[0].try_borrow_data()?;
        let anchors = root_anchors();
        let is_root_keys = signed.len() > 20 && signed[..2] == TYPE_DNSKEY.to_be_bytes() && signed[18] == 0 && signed[19] == 0;
        let parent = if is_root_keys { anchors } else { read_set(&parent_data).ok_or(err(StepError::WrongParent))?.0 };

        let sysvar = accounts[2].try_borrow_data()?;
        let verified = verify_step(signed, now, &parent, |alg, key| match alg {
            8 => rsa_verify(key, signed, sig, false, false),
            5 | 7 => rsa_verify(key, signed, sig, false, true),
            13 | 15 => {
                let (program, pk) = if alg == 13 {
                    match introspect::p256_compressed(&key[4..]) {
                        Some(pk) => (&introspect::SECP256R1_PROGRAM, pk.to_vec()),
                        None => return false,
                    }
                } else if key.len() == 36 {
                    (&introspect::ED25519_PROGRAM, key[4..].to_vec())
                } else {
                    return false;
                };
                if flags & 2 != 0 {
                    introspect::precompile_find(&sysvar, program, &pk, msg_offset, signed.len())
                } else {
                    introspect::precompile_checked(&sysvar, program, sig_ix, entry, &pk, msg_offset, signed.len())
                }
            }
            _ => false,
        })
        .map_err(err)?;

        let mut out = accounts[1].try_borrow_mut_data()?;
        if let Some((old, old_signed)) = read_set(&out) {
            if old.owner != verified.set.owner || old.rrtype != verified.set.rrtype {
                return Err(err(StepError::WrongParent));
            }
            if !replaces(verified.signed_at, verified.set.expires_at, old_signed, old.expires_at, now) {
                return Ok(()); // the cache already holds something at least as good
            }
        }
        write_set(&mut out, &verified)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anchors_decode() {
        assert_eq!(&ROOT_ANCHORS[0][..4], &[0x4f, 0x66, 8, 2]); // tag 20326
        assert_eq!(&ROOT_ANCHORS[1][..4], &[0x97, 0x28, 8, 2]); // tag 38696
    }

    #[test]
    fn names() {
        assert_eq!(name_len(b"\x03com\x00").unwrap(), (5, 1));
        assert_eq!(name_len(b"\x00").unwrap(), (1, 0));
        assert_eq!(name_len(b"\x03Com\x00"), Err(StepError::NotLowercase));
        assert_eq!(name_len(b"\xc0\x0c"), Err(StepError::BadName));
        assert!(is_at_or_below(b"\x01a\x03com\x00", 2, b"\x03com\x00", 1));
        assert!(is_at_or_below(b"\x03com\x00", 1, b"\x00", 0));
        assert!(!is_at_or_below(b"\x03com\x00", 1, b"\x03org\x00", 1));
        assert!(!is_at_or_below(b"\x03com\x00", 1, b"\x01a\x03com\x00", 2));
    }

    #[test]
    fn wallet_records() {
        let key = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
        let want = base58_32(key.as_bytes()).unwrap();
        let txt = |s: &str| [&[s.len() as u8][..], s.as_bytes()].concat();
        assert_eq!(sol_wallet(&txt(&format!("SOL {key}"))), Some(want));
        assert_eq!(sol_wallet(&txt(&format!("sol:{key}"))), Some(want));
        assert_eq!(sol_wallet(&txt(&format!("SOL  {key}"))), Some(want));
        assert_eq!(sol_wallet(&[txt("SOL"), txt(key)].concat()), Some(want));
        assert_eq!(sol_wallet(&txt(&format!("ETH {key}"))), None);
        assert_eq!(sol_wallet(&txt(&format!("SOL {key} x"))), None);
        assert_eq!(sol_wallet(&txt(&format!("SOL {key}1"))), None);
        assert_eq!(sol_wallet(&txt("SOL 11111111111111111111111111111111")), None);
        assert_eq!(sol_wallet(&[txt("SOL"), txt(key), txt("x")].concat()), None);
        // Known vector: the System Program is 32 zero bytes, the Token program is TokenkegQ...
        let token = base58_32(b"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").unwrap();
        assert_eq!(&token[..4], &[6, 221, 246, 225]);
        assert_eq!(base58_32(b"11111111111111111111111111111111"), Some([0; 32]));
        assert_eq!(base58_32(b"0OIl"), None);

        let domain = b"\x07example\x03com\x00";
        let other = base58_32(b"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").unwrap();
        let eth = txt("ETH 0x7edB9dC3a47bf0E8D59649B11Ee2Fb64b2BcE81f");
        let sol = txt(&format!("SOL {key}"));
        let leaf = RRset { owner: b"\x07_wallet\x07example\x03com\x00", rrtype: TYPE_TXT, records: vec![&eth, &sol], expires_at: 0 };
        assert!(publishes(&leaf, domain, &want));
        assert!(!publishes(&leaf, domain, &other));
        assert!(!publishes(&leaf, b"\x07example\x03org\x00", &want));
        let apex_txt = RRset { owner: domain, rrtype: TYPE_TXT, records: vec![&sol], expires_at: 0 };
        assert!(!publishes(&apex_txt, domain, &want)); // TXT counts only at _wallet.<domain>
        let wallet = [txt("SOL"), txt(key)].concat();
        let apex_wallet = RRset { owner: domain, rrtype: TYPE_WALLET, records: vec![&wallet], expires_at: 0 };
        assert!(publishes(&apex_wallet, domain, &want));
    }
}
