//! Benchmark program for DNSSEC signature checks on Solana. Each instruction runs one check on
//! real or synthetic data so LiteSVM can report its compute units. Not the production program.
//!
//! Instruction data, first byte:
//!   0  no-op (baseline)
//!   1  RSA PKCS#1 v1.5: [1, limbs (0 = u32, 1 = u64), hash (0 = SHA-256, 1 = SHA-1)];
//!      account 0 holds [u16 len, DNSKEY RDATA, u16 len, signed data, u16 len, signature]
//!   2  P-256 via the secp256r1 precompile: [2, precompile ix index, entry, DNSKEY RDATA (68), signed data];
//!      account 0 is the instructions sysvar
//!   3  Ed25519 via the ed25519 precompile: [3, precompile ix index, entry, DNSKEY RDATA (36), signed data]
//!   4  DS digest type 1 (SHA-1 in BPF): account 0 holds [u16 len, owner name + DNSKEY RDATA, 20-byte digest]
//!   5  DS digest type 2 (SHA-256 syscall): account 0 holds [u16 len, owner name + DNSKEY RDATA, 32-byte digest]
//!   6  full DNSSEC step (see dnssec.rs): verify one signed RRset against a parent set held in an account
//!   7  RSA building blocks: [7, phase]; account 0 holds [u16 len, modulus, u16 len, signature]
//!   8  split RSA start: account 0 as for op 1, account 1 the state (bigint::split)
//!   9  split RSA advance: [9, squarings]; account 0 the state
//!  10  split RSA finish: account 0 as for op 1 (signature unused), account 1 the state

pub mod bigint;
pub mod dnssec;
pub mod introspect;
pub mod sha1;

pub fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    let mut out = [0u8; 32];
    #[cfg(target_os = "solana")]
    unsafe {
        solana_define_syscall::definitions::sol_sha256(parts as *const _ as *const u8, parts.len() as u64, out.as_mut_ptr());
    }
    #[cfg(not(target_os = "solana"))]
    {
        use sha2::Digest;
        let mut h = sha2::Sha256::new();
        for p in parts {
            h.update(p);
        }
        out.copy_from_slice(&h.finalize());
    }
    out
}

/// Reads [u16 LE length][bytes] fields one after another.
pub struct Fields<'a>(pub &'a [u8]);

impl<'a> Fields<'a> {
    pub fn next(&mut self) -> Option<&'a [u8]> {
        let len = u16::from_le_bytes([*self.0.first()?, *self.0.get(1)?]) as usize;
        let field = self.0.get(2..2 + len)?;
        self.0 = &self.0[2 + len..];
        Some(field)
    }
}

/// RSA check of one signed set, exactly as a DNSSEC step does it.
pub fn rsa_verify(dnskey: &[u8], signed: &[u8], sig: &[u8], use_u64: bool, sha1_hash: bool) -> bool {
    let Some((e, n)) = dnskey.get(4..).and_then(bigint::rsa_key) else { return false };
    let mut em = [0u8; bigint::MAX_BYTES];
    let em = &mut em[..n.len().min(bigint::MAX_BYTES)];
    let ok = if use_u64 { bigint::modexp64(n, e, sig, em) } else { bigint::modexp32(n, e, sig, em) };
    if !ok {
        return false;
    }
    if sha1_hash {
        bigint::pkcs1_matches(em, &bigint::SHA1_PREFIX, &sha1::sha1(&[signed]))
    } else {
        bigint::pkcs1_matches(em, &bigint::SHA256_PREFIX, &sha256(&[signed]))
    }
}

#[cfg(target_os = "solana")]
mod program {
    use super::*;
    use solana_account_info::AccountInfo;
    use solana_program_error::{ProgramError, ProgramResult};
    use solana_pubkey::Pubkey;

    solana_program_entrypoint::entrypoint!(process);

    fn fail(code: u32) -> ProgramResult {
        Err(ProgramError::Custom(code))
    }

    pub fn process(_program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
        match data.first() {
            Some(0) => Ok(()),
            Some(1) => {
                let input = accounts[0].try_borrow_data()?;
                let mut f = Fields(&input);
                let (Some(key), Some(signed), Some(sig)) = (f.next(), f.next(), f.next()) else { return fail(1) };
                if rsa_verify(key, signed, sig, data[1] == 1, data[2] == 1) { Ok(()) } else { fail(2) }
            }
            Some(op @ (2 | 3)) => {
                let (program, key_len) = if *op == 2 { (&introspect::SECP256R1_PROGRAM, 68) } else { (&introspect::ED25519_PROGRAM, 36) };
                let key = data.get(3..3 + key_len).ok_or(ProgramError::InvalidInstructionData)?;
                let msg_len = data.len() - 3 - key_len;
                let sysvar = accounts[0].try_borrow_data()?;
                let pubkey33;
                let pubkey: &[u8] = if *op == 2 {
                    pubkey33 = introspect::p256_compressed(&key[4..]).ok_or(ProgramError::InvalidInstructionData)?;
                    &pubkey33
                } else {
                    &key[4..]
                };
                if introspect::precompile_checked(&sysvar, program, data[1] as u16, data[2], pubkey, 3 + key_len, msg_len) {
                    Ok(())
                } else {
                    fail(3)
                }
            }
            Some(op @ (4 | 5)) => {
                let input = accounts[0].try_borrow_data()?;
                let mut f = Fields(&input);
                let Some(msg) = f.next() else { return fail(1) };
                let ok = if *op == 4 { sha1::sha1(&[msg])[..] == f.0[..20] } else { sha256(&[msg])[..] == f.0[..32] };
                if ok { Ok(()) } else { fail(4) }
            }
            Some(6) => dnssec::process_step(accounts, &data[1..]),
            Some(7) => {
                let input = accounts[0].try_borrow_data()?;
                let mut f = Fields(&input);
                let (Some(n), Some(sig)) = (f.next(), f.next()) else { return fail(1) };
                if bigint::phase32(n, sig, data[1]) { Ok(()) } else { fail(5) }
            }
            Some(8) => {
                // split RSA, first instruction: inputs as op 1, state account 1
                let input = accounts[0].try_borrow_data()?;
                let mut f = Fields(&input);
                let (Some(key), Some(_), Some(sig)) = (f.next(), f.next(), f.next()) else { return fail(1) };
                let Some((e, n)) = key.get(4..).and_then(bigint::rsa_key) else { return fail(1) };
                let mut state = accounts[1].try_borrow_mut_data()?;
                if bigint::split::start(n, e, sig, &mut state) { Ok(()) } else { fail(6) }
            }
            Some(9) => {
                let mut state = accounts[0].try_borrow_mut_data()?;
                bigint::split::advance(&mut state, data[1] as u32);
                Ok(())
            }
            Some(10) => {
                let input = accounts[0].try_borrow_data()?;
                let mut f = Fields(&input);
                let (Some(key), Some(signed)) = (f.next(), f.next()) else { return fail(1) };
                let Some((_, n)) = key.get(4..).and_then(bigint::rsa_key) else { return fail(1) };
                let state = accounts[1].try_borrow_data()?;
                let mut em = vec![0u8; n.len()];
                let ok = bigint::split::result(&state, &mut em) && bigint::pkcs1_matches(&em, &bigint::SHA256_PREFIX, &sha256(&[signed]));
                if ok { Ok(()) } else { fail(7) }
            }
            _ => Err(ProgramError::InvalidInstructionData),
        }
    }
}
