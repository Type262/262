//! Reads the instructions sysvar directly (no allocation) to prove that a signature precompile
//! (secp256r1 for DNSSEC algorithm 13, ed25519 for algorithm 15) checked a given key over a given
//! message in this same transaction. A transaction only lands if all its precompile checks pass,
//! so finding the right entry is as good as verifying the signature ourselves.
//!
//! Sysvar layout: u16 count, u16 offset per instruction, then per instruction: u16 account count,
//! 33 bytes per account (flags + key), 32-byte program id, u16 data length, data. The index of the
//! instruction being executed is the last u16 of the account.

/// Secp256r1SigVerify1111111111111111111111111
pub const SECP256R1_PROGRAM: [u8; 32] = [
    6, 146, 13, 236, 47, 234, 113, 181, 183, 35, 129, 77, 116, 45, 169, 3, 28, 131, 231, 95, 219, 121, 93, 86, 142, 117,
    71, 128, 32, 0, 0, 0,
];
/// Ed25519SigVerify111111111111111111111111111
pub const ED25519_PROGRAM: [u8; 32] = [
    3, 125, 70, 214, 124, 147, 251, 190, 18, 249, 66, 143, 131, 141, 64, 255, 5, 112, 116, 73, 39, 244, 138, 100, 252,
    202, 112, 68, 128, 0, 0, 0,
];

fn u16_at(d: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes([*d.get(at)?, *d.get(at + 1)?]))
}

pub fn current_index(sysvar: &[u8]) -> Option<u16> {
    u16_at(sysvar, sysvar.len().checked_sub(2)?)
}

/// (program id, data) of the instruction at `index`.
pub fn instruction_at(sysvar: &[u8], index: u16) -> Option<(&[u8], &[u8])> {
    if index >= u16_at(sysvar, 0)? {
        return None;
    }
    let mut at = u16_at(sysvar, 2 + 2 * index as usize)? as usize;
    let accounts = u16_at(sysvar, at)? as usize;
    at += 2 + 33 * accounts;
    let program = sysvar.get(at..at + 32)?;
    let len = u16_at(sysvar, at + 32)? as usize;
    let data = sysvar.get(at + 34..at + 34 + len)?;
    Some((program, data))
}

/// True if entry `entry` of the precompile instruction at `sig_ix` checked a signature by `pubkey`
/// over exactly the `msg_len` bytes at `msg_offset` in the data of the instruction running now.
/// Both precompiles use the same 14-byte offsets record after a 2-byte header.
pub fn precompile_checked(
    sysvar: &[u8],
    precompile: &[u8; 32],
    sig_ix: u16,
    entry: u8,
    pubkey: &[u8],
    msg_offset: usize,
    msg_len: usize,
) -> bool {
    let check = || -> Option<bool> {
        let current = current_index(sysvar)?;
        let (program, data) = instruction_at(sysvar, sig_ix)?;
        if program != precompile || entry >= *data.first()? {
            return Some(false);
        }
        let o = 2 + 14 * entry as usize;
        let pk_offset = u16_at(data, o + 4)? as usize;
        let pk_ix = u16_at(data, o + 6)?;
        let m_offset = u16_at(data, o + 8)? as usize;
        let m_len = u16_at(data, o + 10)? as usize;
        let m_ix = u16_at(data, o + 12)?;
        if m_ix != current || m_offset != msg_offset || m_len != msg_len {
            return Some(false);
        }
        // u16::MAX means "inside the precompile instruction itself".
        let pk_data = if pk_ix == u16::MAX { data } else { instruction_at(sysvar, pk_ix)?.1 };
        Some(pk_data.get(pk_offset..pk_offset + pubkey.len())? == pubkey)
    };
    check().unwrap_or(false)
}

/// Same check without being told where to look: scans every instruction of `precompile` in the
/// transaction and every entry in each. Saves the client two bytes per step and costs a few
/// hundred compute units.
pub fn precompile_find(sysvar: &[u8], precompile: &[u8; 32], pubkey: &[u8], msg_offset: usize, msg_len: usize) -> bool {
    let Some(count) = u16_at(sysvar, 0) else { return false };
    (0..count).any(|ix| {
        let Some((program, data)) = instruction_at(sysvar, ix) else { return false };
        program == precompile
            && data.first().is_some_and(|&n| {
                (0..n).any(|entry| precompile_checked(sysvar, precompile, ix, entry, pubkey, msg_offset, msg_len))
            })
    })
}

/// The 33-byte compressed point the secp256r1 precompile takes, from a DNSKEY's 64-byte x || y.
pub fn p256_compressed(xy: &[u8]) -> Option<[u8; 33]> {
    if xy.len() != 64 {
        return None;
    }
    let mut out = [0u8; 33];
    out[0] = 2 | (xy[63] & 1);
    out[1..].copy_from_slice(&xy[..32]);
    Some(out)
}
