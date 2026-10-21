//! Finds, in the instructions sysvar, the signature check a precompile (secp256r1 for DNSSEC
//! algorithm 13, ed25519 for 15) ran in this transaction. A transaction only lands if all its
//! precompile checks pass, so finding the right entry is as good as verifying the signature here.
//! Reads the sysvar's raw bytes, without allocating.
//!
//! Sysvar layout: u16 count, u16 offset per instruction, then per instruction: u16 account count,
//! 33 bytes per account (flags + key), 32-byte program id, u16 data length, data. The last u16 of
//! the account is the index of the top-level instruction running now.
//!
//! Precompile data (SIMD-0075 and the ed25519 program share it): [count u8, 0u8], then per
//! signature seven u16 LE: signature offset, signature instruction index, public key offset,
//! public key instruction index, message offset, message size, message instruction index
//! (u16::MAX = the precompile instruction itself).

use anchor_lang::prelude::Pubkey;

fn u16_at(d: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes([*d.get(at)?, *d.get(at + 1)?]))
}

fn current_index(sysvar: &[u8]) -> Option<u16> {
    u16_at(sysvar, sysvar.len().checked_sub(2)?)
}

/// (program id, data) of the instruction at `index`.
fn instruction_at(sysvar: &[u8], index: u16) -> Option<(&[u8], &[u8])> {
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

/// True if some entry of a `precompile` instruction in this transaction checked a signature by
/// `pubkey` over exactly the `msg.len()` bytes at `msg_offset` of the current top-level
/// instruction's data, and those bytes are `msg`.
///
/// Comparing the bytes, not just the offsets, matters when the program runs through CPI: the
/// current index then names the caller's instruction, whose data is not our arguments.
pub fn precompile_checked(
    sysvar: &[u8],
    precompile: &Pubkey,
    pubkey: &[u8],
    msg_offset: usize,
    msg: &[u8],
) -> bool {
    let check = || -> Option<bool> {
        let current = current_index(sysvar)?;
        let (_, ours) = instruction_at(sysvar, current)?;
        if ours.get(msg_offset..msg_offset + msg.len())? != msg {
            return Some(false);
        }
        let count = u16_at(sysvar, 0)?;
        for ix in 0..count {
            let (program, data) = instruction_at(sysvar, ix)?;
            if program != precompile.as_ref() {
                continue;
            }
            for entry in 0..*data.first()? as usize {
                let o = 2 + 14 * entry;
                let pk_offset = u16_at(data, o + 4)? as usize;
                let pk_ix = u16_at(data, o + 6)?;
                let m_offset = u16_at(data, o + 8)? as usize;
                let m_len = u16_at(data, o + 10)? as usize;
                let m_ix = u16_at(data, o + 12)?;
                if m_ix != current || m_offset != msg_offset || m_len != msg.len() {
                    continue;
                }
                // u16::MAX means "inside the precompile instruction itself".
                let pk_data = if pk_ix == u16::MAX {
                    data
                } else {
                    instruction_at(sysvar, pk_ix)?.1
                };
                if pk_data.get(pk_offset..pk_offset + pubkey.len()) == Some(pubkey) {
                    return Some(true);
                }
            }
        }
        Some(false)
    };
    check().unwrap_or(false)
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A sysvar image with the given (program, data) instructions, `current` running.
    fn sysvar(ixs: &[(Pubkey, Vec<u8>)], current: u16) -> Vec<u8> {
        let mut d = (ixs.len() as u16).to_le_bytes().to_vec();
        let mut body = Vec::new();
        let head = 2 + 2 * ixs.len();
        for (program, data) in ixs {
            d.extend_from_slice(&((head + body.len()) as u16).to_le_bytes());
            body.extend_from_slice(&0u16.to_le_bytes()); // no accounts
            body.extend_from_slice(program.as_ref());
            body.extend_from_slice(&(data.len() as u16).to_le_bytes());
            body.extend_from_slice(data);
        }
        d.extend(body);
        d.extend_from_slice(&current.to_le_bytes());
        d
    }

    fn entry(pk: &[u8], msg_ix: u16, msg_off: u16, msg_len: u16) -> Vec<u8> {
        let mut d = vec![1u8, 0];
        let pk_off = 16u16;
        for v in [
            pk_off + pk.len() as u16,
            u16::MAX,
            pk_off,
            u16::MAX,
            msg_off,
            msg_len,
            msg_ix,
        ] {
            d.extend_from_slice(&v.to_le_bytes());
        }
        d.extend_from_slice(pk);
        d.extend_from_slice(&[0u8; 64]);
        d
    }

    #[test]
    fn finds_the_entry_for_our_bytes_only() {
        let pre = Pubkey::new_unique();
        let pk = [7u8; 33];
        let msg = b"signed set".to_vec();
        let ours = [vec![0u8; 12], msg.clone()].concat();
        let ok = sysvar(
            &[
                (pre, entry(&pk, 1, 12, 10)),
                (Pubkey::new_unique(), ours.clone()),
            ],
            1,
        );
        assert!(precompile_checked(&ok, &pre, &pk, 12, &msg));
        // Another key, another program, other bytes, other offset or length, other instruction.
        assert!(!precompile_checked(&ok, &pre, &[8u8; 33], 12, &msg));
        assert!(!precompile_checked(
            &ok,
            &Pubkey::new_unique(),
            &pk,
            12,
            &msg
        ));
        assert!(!precompile_checked(&ok, &pre, &pk, 12, b"signed sex"));
        let shifted = sysvar(
            &[
                (pre, entry(&pk, 1, 13, 9)),
                (Pubkey::new_unique(), ours.clone()),
            ],
            1,
        );
        assert!(!precompile_checked(&shifted, &pre, &pk, 12, &msg));
        let elsewhere = sysvar(
            &[
                (pre, entry(&pk, 2, 12, 10)),
                (Pubkey::new_unique(), ours.clone()),
                (Pubkey::new_unique(), ours),
            ],
            1,
        );
        assert!(!precompile_checked(&elsewhere, &pre, &pk, 12, &msg));
        assert!(!precompile_checked(&[], &pre, &pk, 12, &msg));
    }

    #[test]
    fn compresses_p256_keys() {
        let mut xy = [1u8; 64];
        xy[63] = 3;
        let c = p256_compressed(&xy).unwrap();
        assert_eq!(c[0], 3);
        assert_eq!(&c[1..], &xy[..32]);
        assert!(p256_compressed(&xy[..63]).is_none());
    }
}
