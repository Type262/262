//! DNSSEC proofs, verified on-chain one signed RRset per instruction (a "step").
//!
//! A whole chain from the root to `_wallet.<domain>` is far more than one transaction, so each
//! step verifies one signed set against a parent set that is already verified and cached in an
//! `RrSet` PDA, then caches its own result: the root DNSKEY set against the IANA root anchors
//! compiled into constants.rs, any other DNSKEY set signed by itself against the DS set at its
//! name, every other set against the DNSKEY set at its signer. The program derives the parent
//! and the result address from the signed data, so a step can only write the set it proves and
//! only read the parent DNSSEC requires. Later proofs reuse cached root and TLD sets.
//!
//! Algorithms: 8 (RSA/SHA-256, keys of 1024 to 4096 bits) in BPF; 13 (P-256) and 15 (Ed25519)
//! through the native precompiles, found with instructions-sysvar introspection. The SHA-1
//! signature algorithms 5 and 7 are refused. docs/DNSSEC.md has the rules, the account layouts
//! and the measurements.

mod introspect;
mod rsa;
mod sha1;
pub mod wire;

use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar;
use anchor_lang::system_program::{self, Allocate, Assign, CreateAccount, Transfer};
use anchor_lang::Discriminator;

use crate::constants::*;
use crate::errors::Type262Error;
use crate::state::{Buffer, RrSet};
use wire::{RRset, Verified};

/// Where the signed set starts in the data of `verify_rrset` and `verify_rrset_precompiled`:
/// after the 8-byte discriminator and borsh's u32 length. Precompile entries point here.
pub const SIGNED_OFFSET: usize = 12;

const SECP256R1_PROGRAM: Pubkey =
    anchor_lang::solana_program::pubkey!("Secp256r1SigVerify1111111111111111111111111");
const ED25519_PROGRAM: Pubkey =
    anchor_lang::solana_program::pubkey!("Ed25519SigVerify111111111111111111111111111");

const ROOT_NAME: &[u8] = &[0];

/// The root anchors as DS RDATA: key tag, algorithm, digest type, digest.
static ROOT_DS: [[u8; 36]; 2] = [ds_rdata(&ROOT_ANCHORS[0]), ds_rdata(&ROOT_ANCHORS[1])];

const fn ds_rdata(a: &RootAnchor) -> [u8; 36] {
    let mut out = [0u8; 36];
    let tag = a.key_tag.to_be_bytes();
    out[0] = tag[0];
    out[1] = tag[1];
    out[2] = a.algorithm;
    out[3] = a.digest_type;
    let mut i = 0;
    while i < 32 {
        out[4 + i] = a.digest[i];
        i += 1;
    }
    out
}

/// The parent of the root DNSKEY set: the anchors, valid forever.
fn root_anchors() -> RRset<'static> {
    RRset {
        owner: ROOT_NAME,
        rrtype: TYPE_DS,
        records: ROOT_DS.iter().map(|r| &r[..]).collect(),
        expires_at: i64::MAX,
    }
}

/// A step wrote its set (nothing is emitted when the cache keeps what it held, see wire::replaces).
#[event]
pub struct RrsetVerified {
    pub rrset: Pubkey,
    pub rrtype: u16,
    pub signed_at: i64,
    pub expires_at: i64,
}

// ---------- verification ----------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct VerifyRrsetArgs {
    /// RRSIG RDATA without the signature, then the records in canonical wire form: the bytes
    /// dnsprovejs `SignedSet.toWire()` produces.
    pub signed: Vec<u8>,
    /// The RRSIG signature.
    pub sig: Vec<u8>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct VerifyRrsetPrecompiledArgs {
    /// As in `VerifyRrsetArgs`. A secp256r1 or ed25519 precompile instruction in the same
    /// transaction must have checked the signature over exactly these bytes, at SIGNED_OFFSET of
    /// this instruction's data.
    pub signed: Vec<u8>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct VerifyRrsetBufferedArgs {}

/// Accounts of `verify_rrset` and `verify_rrset_precompiled`.
#[derive(Accounts)]
pub struct VerifyRrset<'info> {
    /// Pays the rent of a new entry, or of the growth of a replaced one.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the verified set this one must be checked against, derived by the handler from the
    /// signed data (the DNSKEY set at the signer, or the DS set at the owner for a self-signed
    /// DNSKEY set). None for the root DNSKEY set, which the root anchors verify.
    pub parent: Option<UncheckedAccount<'info>>,
    /// CHECK: the PDA of the set being verified; the handler checks the address, then creates
    /// the entry or replaces it if the new set is newer.
    #[account(mut)]
    pub rrset: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: the instructions sysvar, where P-256 and Ed25519 steps find their precompile check.
    #[account(address = sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct VerifyRrsetBuffered<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: as in VerifyRrset.
    pub parent: Option<UncheckedAccount<'info>>,
    /// CHECK: as in VerifyRrset.
    #[account(mut)]
    pub rrset: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: as in VerifyRrset (unused by RSA, kept so every verify takes the same accounts).
    #[account(address = sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
    /// The payer's buffer, holding [u32 length, signed, u32 length, sig]; closed to the payer.
    #[account(mut, seeds = [BUFFER_SEED, payer.key().as_ref()], bump, close = payer)]
    pub buffer: Account<'info, Buffer>,
}

/// An RSA step (algorithm 8) whose set and signature fit in the transaction.
pub fn verify_rrset<'info>(
    ctx: Context<'_, '_, 'info, 'info, VerifyRrset<'info>>,
    args: VerifyRrsetArgs,
) -> Result<()> {
    let a = &ctx.accounts;
    step(
        &a.payer,
        a.parent.as_ref().map(|p| p.as_ref()),
        &a.rrset,
        &a.system_program,
        ctx.program_id,
        &args.signed,
        Sig::Rsa(&args.sig),
    )
}

/// A P-256 (13) or Ed25519 (15) step: the precompile checked the signature, this finds that
/// check and runs every other rule.
pub fn verify_rrset_precompiled<'info>(
    ctx: Context<'_, '_, 'info, 'info, VerifyRrset<'info>>,
    args: VerifyRrsetPrecompiledArgs,
) -> Result<()> {
    let a = &ctx.accounts;
    let sysvar = a.instructions.try_borrow_data()?;
    step(
        &a.payer,
        a.parent.as_ref().map(|p| p.as_ref()),
        &a.rrset,
        &a.system_program,
        ctx.program_id,
        &args.signed,
        Sig::Precompiled(&sysvar),
    )
}

/// An RSA step too big for one transaction, uploaded first with `write_buffer`.
pub fn verify_rrset_buffered<'info>(
    ctx: Context<'_, '_, 'info, 'info, VerifyRrsetBuffered<'info>>,
    _args: VerifyRrsetBufferedArgs,
) -> Result<()> {
    let a = &ctx.accounts;
    let info = a.buffer.to_account_info();
    let data = info.try_borrow_data()?;
    let (signed, sig) = buffered(&data[Buffer::DATA_OFFSET..]).ok_or(Type262Error::BadBuffer)?;
    step(
        &a.payer,
        a.parent.as_ref().map(|p| p.as_ref()),
        &a.rrset,
        &a.system_program,
        ctx.program_id,
        signed,
        Sig::Rsa(sig),
    )
}

/// How a step's signature is checked.
enum Sig<'a> {
    /// RSA in BPF, with the signature bytes.
    Rsa(&'a [u8]),
    /// A precompile instruction in this transaction, found in the instructions sysvar's data.
    Precompiled(&'a [u8]),
}

fn step<'info>(
    payer: &AccountInfo<'info>,
    parent: Option<&AccountInfo<'info>>,
    rrset: &AccountInfo<'info>,
    system: &AccountInfo<'info>,
    program_id: &Pubkey,
    signed: &[u8],
    sig: Sig,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let parsed = wire::parse_signed(signed, now)?;
    // RSASHA1 (5) and RSASHA1-NSEC3-SHA1 (7) are refused like any other unsupported algorithm:
    // SHA-1 has practical chosen-prefix collisions. (DS digest type 1 stays: only the child zone
    // computes it.)
    match (parsed.sig.algorithm, &sig) {
        (ALGORITHM_RSASHA256, Sig::Rsa(_))
        | (ALGORITHM_ECDSAP256SHA256 | ALGORITHM_ED25519, Sig::Precompiled(_)) => {}
        (ALGORITHM_RSASHA256 | ALGORITHM_ECDSAP256SHA256 | ALGORITHM_ED25519, _) => {
            return err!(Type262Error::WrongInstructionForAlgorithm)
        }
        _ => return err!(Type262Error::UnsupportedAlgorithm),
    }
    // Keys reach here only through wire::key_usable, so they are longer than their 4-byte header
    // and their algorithm is the RRSIG's, one of the three above.
    let mut check = |alg: u8, key: &[u8]| match (&sig, alg) {
        (Sig::Rsa(s), _) => rsa::verify(&key[4..], signed, s),
        (Sig::Precompiled(sysvar), ALGORITHM_ECDSAP256SHA256) => {
            key.len() == 68
                && introspect::p256_compressed(&key[4..]).is_some_and(|pk| {
                    introspect::precompile_checked(
                        sysvar,
                        &SECP256R1_PROGRAM,
                        &pk,
                        SIGNED_OFFSET,
                        signed,
                    )
                })
        }
        (Sig::Precompiled(sysvar), _) => {
            key.len() == 36
                && introspect::precompile_checked(
                    sysvar,
                    &ED25519_PROGRAM,
                    &key[4..],
                    SIGNED_OFFSET,
                    signed,
                )
        }
    };

    let (want_owner, want_type) = wire::parent_of(&parsed);
    let verified = if want_type == TYPE_DS && want_owner == ROOT_NAME {
        wire::verify_step(parsed, &root_anchors(), now, &mut check)?
    } else {
        let info = parent.ok_or(Type262Error::WrongParent)?;
        require_keys_eq!(*info.owner, *program_id, Type262Error::WrongParent);
        let data = info.try_borrow_data()?;
        let cached = read_cached(&data).ok_or(Type262Error::WrongParent)?;
        // verify_step checks the parent's owner name and type against the signed data.
        wire::verify_step(parsed, &cached.set, now, &mut check)?
    };
    store(payer, rrset, system, program_id, &verified, now)
}

/// Writes a verified set to its PDA: creates it, or replaces the cached one when
/// wire::replaces allows; otherwise leaves it as it is and succeeds, so concurrent provers never
/// fail on each other's refreshes.
fn store<'info>(
    payer: &AccountInfo<'info>,
    rrset: &AccountInfo<'info>,
    system: &AccountInfo<'info>,
    program_id: &Pubkey,
    v: &Verified,
    now: i64,
) -> Result<()> {
    let hash = wire::sha256(&[v.set.owner]);
    let type_be = v.set.rrtype.to_be_bytes();
    let rdata_len: usize = v.set.records.iter().map(|r| 2 + r.len()).sum();
    let size = RrSet::space(v.set.owner.len(), rdata_len);

    let (bump, original_payer) = if rrset.owner == program_id {
        let data = rrset.try_borrow_data()?;
        let old = read_cached(&data).ok_or(Type262Error::WrongRRsetAccount)?;
        // Cheaper than find_program_address: the bump is stored.
        let expected =
            Pubkey::create_program_address(&[RRSET_SEED, &hash, &type_be, &[old.bump]], program_id)
                .map_err(|_| error!(Type262Error::WrongRRsetAccount))?;
        require_keys_eq!(expected, *rrset.key, Type262Error::WrongRRsetAccount);
        if !wire::replaces(&v.set, v.signed_at, &old.set, old.signed_at, now) {
            return Ok(()); // the cache already holds this set, or a newer one
        }
        let kept = (old.bump, old.payer);
        drop(data);
        // The first payer keeps the claim on the rent; a refresher only pays for growth.
        if size > rrset.data_len() {
            top_up(payer, rrset, system, size)?;
        }
        rrset.resize(size)?;
        kept
    } else {
        let (expected, bump) =
            Pubkey::find_program_address(&[RRSET_SEED, &hash, &type_be], program_id);
        require_keys_eq!(expected, *rrset.key, Type262Error::WrongRRsetAccount);
        create_pda(
            payer,
            rrset,
            system,
            size,
            &[RRSET_SEED, &hash, &type_be, &[bump]],
            program_id,
        )?;
        (bump, *payer.key)
    };
    write_cached(&mut rrset.try_borrow_mut_data()?, bump, &original_payer, v);
    emit!(RrsetVerified {
        rrset: *rrset.key,
        rrtype: v.set.rrtype,
        signed_at: v.signed_at,
        expires_at: v.set.expires_at,
    });
    Ok(())
}

// ---------- the cached set, read and written in place (borsh layout of state::RrSet) ----------

const OFF_BUMP: usize = 8;
const OFF_RRTYPE: usize = 9;
const OFF_ALGORITHM: usize = 11;
const OFF_KEY_TAG: usize = 12;
const OFF_SIGNED_AT: usize = 14;
const OFF_EXPIRES_AT: usize = 22;
const OFF_PAYER: usize = 30;
const OFF_OWNER: usize = 62;

struct Cached<'a> {
    bump: u8,
    signed_at: i64,
    payer: Pubkey,
    set: RRset<'a>,
}

fn read_cached(d: &[u8]) -> Option<Cached<'_>> {
    if d.len() < OFF_OWNER + 4 || d[..8] != *RrSet::DISCRIMINATOR {
        return None;
    }
    let i64_at = |i: usize| i64::from_le_bytes(d[i..i + 8].try_into().unwrap());
    let len_at = |i: usize| -> Option<usize> {
        Some(u32::from_le_bytes(d.get(i..i + 4)?.try_into().ok()?) as usize)
    };
    let olen = len_at(OFF_OWNER)?;
    let owner = d.get(OFF_OWNER + 4..OFF_OWNER + 4 + olen)?;
    let rstart = OFF_OWNER + 8 + olen;
    let mut rdata = d.get(rstart..rstart + len_at(rstart - 4)?)?;
    let mut records = Vec::new();
    while !rdata.is_empty() {
        let len = u16::from_le_bytes([rdata[0], *rdata.get(1)?]) as usize;
        records.push(rdata.get(2..2 + len)?);
        rdata = &rdata[2 + len..];
    }
    Some(Cached {
        bump: d[OFF_BUMP],
        signed_at: i64_at(OFF_SIGNED_AT),
        payer: Pubkey::new_from_array(d[OFF_PAYER..OFF_PAYER + 32].try_into().unwrap()),
        set: RRset {
            owner,
            rrtype: u16::from_le_bytes([d[OFF_RRTYPE], d[OFF_RRTYPE + 1]]),
            records,
            expires_at: i64_at(OFF_EXPIRES_AT),
        },
    })
}

/// `d` is exactly RrSet::space(owner, records) bytes.
fn write_cached(d: &mut [u8], bump: u8, payer: &Pubkey, v: &Verified) {
    d[..8].copy_from_slice(RrSet::DISCRIMINATOR);
    d[OFF_BUMP] = bump;
    d[OFF_RRTYPE..OFF_RRTYPE + 2].copy_from_slice(&v.set.rrtype.to_le_bytes());
    d[OFF_ALGORITHM] = v.algorithm;
    d[OFF_KEY_TAG..OFF_KEY_TAG + 2].copy_from_slice(&v.key_tag.to_le_bytes());
    d[OFF_SIGNED_AT..OFF_SIGNED_AT + 8].copy_from_slice(&v.signed_at.to_le_bytes());
    d[OFF_EXPIRES_AT..OFF_EXPIRES_AT + 8].copy_from_slice(&v.set.expires_at.to_le_bytes());
    d[OFF_PAYER..OFF_PAYER + 32].copy_from_slice(payer.as_ref());
    let mut at = OFF_OWNER;
    let mut put = |bytes: &[u8]| {
        d[at..at + bytes.len()].copy_from_slice(bytes);
        at += bytes.len();
    };
    put(&(v.set.owner.len() as u32).to_le_bytes());
    put(v.set.owner);
    let rdata_len: usize = v.set.records.iter().map(|r| 2 + r.len()).sum();
    put(&(rdata_len as u32).to_le_bytes());
    for r in &v.set.records {
        put(&(r.len() as u16).to_le_bytes());
        put(r);
    }
}

// ---------- the wallet record, for the escrow ----------

/// Checks that `rrset` is this program's cached, unexpired `_wallet.<domain>` TXT set or
/// `<domain>` WALLET (type 262) set, derived here from `domain` (canonical name), and that some
/// record in it publishes `wallet` for coin SOL. Returns the set's signing time, which the escrow
/// compares with the newest proof it accepted for the domain.
pub fn wallet_signed_at(
    rrset: &AccountInfo,
    program_id: &Pubkey,
    domain: &str,
    wallet: &Pubkey,
    now: i64,
) -> Result<i64> {
    require_keys_eq!(*rrset.owner, *program_id, Type262Error::NotAWalletRecord);
    let data = rrset.try_borrow_data()?;
    let cached = read_cached(&data).ok_or(Type262Error::NotAWalletRecord)?;
    let owner = match cached.set.rrtype {
        TYPE_TXT => wire::wire_name(domain, Some(WALLET_LABEL)),
        TYPE_WALLET => wire::wire_name(domain, None),
        _ => None,
    }
    .ok_or(Type262Error::NotAWalletRecord)?;
    let expected = Pubkey::create_program_address(
        &[
            RRSET_SEED,
            &wire::sha256(&[&owner]),
            &cached.set.rrtype.to_be_bytes(),
            &[cached.bump],
        ],
        program_id,
    )
    .map_err(|_| error!(Type262Error::NotAWalletRecord))?;
    require!(
        expected == *rrset.key && cached.set.owner == owner.as_slice(),
        Type262Error::NotAWalletRecord
    );
    require!(
        now <= cached.set.expires_at,
        Type262Error::WalletRecordExpired
    );
    let wallet = wallet.to_bytes();
    require!(
        cached
            .set
            .records
            .iter()
            .any(|r| wire::sol_wallet(r) == Some(wallet)),
        Type262Error::WalletNotPublished
    );
    Ok(cached.signed_at)
}

// ---------- expired entries ----------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CloseRrsetArgs {}

#[derive(Accounts)]
pub struct CloseRrset<'info> {
    #[account(mut, has_one = payer @ Type262Error::WrongPayer, close = payer)]
    pub rrset: Account<'info, RrSet>,
    /// CHECK: the account that paid the rent, as recorded in the set; it gets the rent back.
    #[account(mut)]
    pub payer: UncheckedAccount<'info>,
}

/// Anyone can close an expired entry; the rent goes back to whoever created it.
pub fn close_rrset(ctx: Context<CloseRrset>, _args: CloseRrsetArgs) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(
        now > ctx.accounts.rrset.expires_at,
        Type262Error::RRsetNotExpired
    );
    Ok(())
}

// ---------- buffers ----------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct WriteBufferArgs {
    pub offset: u32,
    pub bytes: Vec<u8>,
}

#[derive(Accounts)]
pub struct WriteBuffer<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the payer's buffer PDA, created or grown here to hold `offset + bytes.len()`.
    #[account(mut, seeds = [BUFFER_SEED, payer.key().as_ref()], bump)]
    pub buffer: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Writes one chunk of a step's [u32 length, signed, u32 length, sig] into the payer's buffer.
/// Chunks can land in any order.
pub fn write_buffer(ctx: Context<WriteBuffer>, args: WriteBufferArgs) -> Result<()> {
    let end = (args.offset as usize)
        .checked_add(args.bytes.len())
        .ok_or(Type262Error::MathOverflow)?;
    require!(
        !args.bytes.is_empty() && end <= Buffer::MAX_SIZE as usize,
        Type262Error::BadBufferSize
    );
    let a = &ctx.accounts;
    let buffer = a.buffer.to_account_info();
    let size = Buffer::DATA_OFFSET + end;
    if buffer.owner == ctx.program_id {
        if size > buffer.data_len() {
            top_up(&a.payer, &buffer, &a.system_program, size)?;
            buffer.resize(size)?;
        }
    } else {
        let payer_key = a.payer.key();
        create_pda(
            &a.payer,
            &buffer,
            &a.system_program,
            size,
            &[BUFFER_SEED, payer_key.as_ref(), &[ctx.bumps.buffer]],
            ctx.program_id,
        )?;
        buffer.try_borrow_mut_data()?[..8].copy_from_slice(Buffer::DISCRIMINATOR);
    }
    let mut data = buffer.try_borrow_mut_data()?;
    let start = Buffer::DATA_OFFSET + args.offset as usize;
    data[start..Buffer::DATA_OFFSET + end].copy_from_slice(&args.bytes);
    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CloseBufferArgs {}

#[derive(Accounts)]
pub struct CloseBuffer<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [BUFFER_SEED, payer.key().as_ref()], bump, close = payer)]
    pub buffer: Account<'info, Buffer>,
}

/// Gives back the rent of a buffer that was never verified (verify_rrset_buffered closes it
/// otherwise).
pub fn close_buffer(_ctx: Context<CloseBuffer>, _args: CloseBufferArgs) -> Result<()> {
    Ok(())
}

/// The signed set and signature at the start of a buffer's content; anything after them (left
/// over from a longer earlier upload) is ignored.
fn buffered(content: &[u8]) -> Option<(&[u8], &[u8])> {
    let len_at = |i: usize| -> Option<usize> {
        Some(u32::from_le_bytes(content.get(i..i + 4)?.try_into().ok()?) as usize)
    };
    let s = len_at(0)?;
    let signed = content.get(4..4 + s)?;
    let g = len_at(4 + s)?;
    let sig = content.get(8 + s..8 + s + g)?;
    Some((signed, sig))
}

// ---------- account creation ----------

/// Creates a program-owned PDA of `space` bytes paid by `payer`. Also works when someone sent
/// the address lamports first, which would make create_account fail.
fn create_pda<'info>(
    payer: &AccountInfo<'info>,
    target: &AccountInfo<'info>,
    system: &AccountInfo<'info>,
    space: usize,
    seeds: &[&[u8]],
    program_id: &Pubkey,
) -> Result<()> {
    let signer = &[seeds];
    let have = target.lamports();
    if have == 0 {
        let rent = Rent::get()?.minimum_balance(space);
        return system_program::create_account(
            CpiContext::new_with_signer(
                system.clone(),
                CreateAccount {
                    from: payer.clone(),
                    to: target.clone(),
                },
                signer,
            ),
            rent,
            space as u64,
            program_id,
        );
    }
    top_up(payer, target, system, space)?;
    system_program::allocate(
        CpiContext::new_with_signer(
            system.clone(),
            Allocate {
                account_to_allocate: target.clone(),
            },
            signer,
        ),
        space as u64,
    )?;
    system_program::assign(
        CpiContext::new_with_signer(
            system.clone(),
            Assign {
                account_to_assign: target.clone(),
            },
            signer,
        ),
        program_id,
    )
}

/// Tops `target` up to the rent exemption of `size` bytes from `payer`.
fn top_up<'info>(
    payer: &AccountInfo<'info>,
    target: &AccountInfo<'info>,
    system: &AccountInfo<'info>,
    size: usize,
) -> Result<()> {
    let rent = Rent::get()?.minimum_balance(size);
    let have = target.lamports();
    if rent > have {
        system_program::transfer(
            CpiContext::new(
                system.clone(),
                Transfer {
                    from: payer.clone(),
                    to: target.clone(),
                },
            ),
            rent - have,
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_anchors_are_the_iana_ds_records() {
        // The same bytes as the benchmarked reference's hex: tag, algorithm 8, digest type 2.
        assert_eq!(
            &ROOT_DS[0][..8],
            &[0x4f, 0x66, 8, 2, 0xe0, 0x6d, 0x44, 0xb8]
        );
        assert_eq!(
            &ROOT_DS[1][..8],
            &[0x97, 0x28, 8, 2, 0x68, 0x3d, 0x2d, 0x0a]
        );
        assert_eq!(&ROOT_DS[1][32..], &[0xc0, 0xfb, 0x2b, 0x16]);
    }

    #[test]
    fn precompile_ids() {
        assert_eq!(SECP256R1_PROGRAM.to_bytes()[..4], [6, 146, 13, 236]);
        assert_eq!(ED25519_PROGRAM.to_bytes()[..4], [3, 125, 70, 214]);
    }

    fn txt(s: &str) -> Vec<u8> {
        [&[s.len() as u8][..], s.as_bytes()].concat()
    }

    /// An RrSet account image for `owner`/`rrtype`, as `store` writes it.
    fn image(owner: &[u8], rrtype: u16, records: &[&[u8]], expires_at: i64, bump: u8) -> Vec<u8> {
        let v = Verified {
            set: RRset {
                owner,
                rrtype,
                records: records.to_vec(),
                expires_at,
            },
            algorithm: 13,
            key_tag: 7,
            signed_at: 1_000,
        };
        let rdata_len: usize = records.iter().map(|r| 2 + r.len()).sum();
        let mut d = vec![0u8; RrSet::space(owner.len(), rdata_len)];
        write_cached(&mut d, bump, &Pubkey::new_from_array([5; 32]), &v);
        d
    }

    #[test]
    fn cached_sets_round_trip_through_borsh() {
        let a = txt("SOL 9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
        let b = txt("ETH 0x7edB9dC3a47bf0E8D59649B11Ee2Fb64b2BcE81f");
        let d = image(
            b"\x07_wallet\x01a\x02io\x00",
            TYPE_TXT,
            &[&a, &b],
            9_000,
            254,
        );
        let c = read_cached(&d).unwrap();
        assert_eq!(
            (c.bump, c.signed_at, c.set.expires_at, c.set.rrtype),
            (254, 1_000, 9_000, TYPE_TXT)
        );
        assert_eq!(c.set.records, vec![&a[..], &b[..]]);
        // Anchor's own deserialization (close_rrset, clients) reads the same fields.
        let s = RrSet::try_deserialize(&mut &d[..]).unwrap();
        assert_eq!(
            (
                s.bump,
                s.rrtype,
                s.algorithm,
                s.key_tag,
                s.signed_at,
                s.expires_at
            ),
            (254, TYPE_TXT, 13, 7, 1_000, 9_000)
        );
        assert_eq!(s.payer, Pubkey::new_from_array([5; 32]));
        assert_eq!(s.owner, b"\x07_wallet\x01a\x02io\x00");
        assert_eq!(s.rdata.len(), 4 + a.len() + b.len());
        assert!(read_cached(&d[..d.len() - 1]).is_none());
        assert!(read_cached(&[0u8; 70]).is_none());
    }

    #[test]
    fn wallet_signed_at_checks_the_record() {
        let program_id = Pubkey::new_unique();
        let key = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
        let wallet = Pubkey::new_from_array(wire::base58_32(key.as_bytes()).unwrap());
        let other = Pubkey::new_unique();
        let sol = txt(&format!("SOL {key}"));
        let eth = txt("ETH 0x7edB9dC3a47bf0E8D59649B11Ee2Fb64b2BcE81f");

        // Runs wallet_signed_at on an account image at `address` owned by `owner`.
        let run = |d: &mut Vec<u8>,
                   address: Pubkey,
                   owner: Pubkey,
                   domain: &str,
                   wallet: &Pubkey,
                   now: i64| {
            let mut lamports = 1_000_000u64;
            let info = AccountInfo::new(&address, false, false, &mut lamports, d, &owner, false, 0);
            wallet_signed_at(&info, &program_id, domain, wallet, now).map_err(|e| match e {
                Error::AnchorError(a) => a.error_code_number,
                _ => 0,
            })
        };
        let pda = |owner: &[u8], rrtype: u16| {
            Pubkey::find_program_address(
                &[RRSET_SEED, &wire::sha256(&[owner]), &rrtype.to_be_bytes()],
                &program_id,
            )
        };
        let err = |e: Type262Error| Err(6000 + e as u32);

        let txt_owner = b"\x07_wallet\x07example\x03com\x00";
        let (address, bump) = pda(txt_owner, TYPE_TXT);
        let mut d = image(txt_owner, TYPE_TXT, &[&eth, &sol], 9_000, bump);
        assert_eq!(
            run(&mut d, address, program_id, "example.com", &wallet, 9_000),
            Ok(1_000)
        );
        assert_eq!(
            run(&mut d, address, program_id, "example.com", &other, 9_000),
            err(Type262Error::WalletNotPublished)
        );
        assert_eq!(
            run(&mut d, address, program_id, "example.com", &wallet, 9_001),
            err(Type262Error::WalletRecordExpired)
        );
        assert_eq!(
            run(&mut d, address, program_id, "example.org", &wallet, 9_000),
            err(Type262Error::NotAWalletRecord)
        );
        assert_eq!(
            run(&mut d, address, program_id, "Example.com", &wallet, 9_000),
            err(Type262Error::NotAWalletRecord)
        );
        assert_eq!(
            run(
                &mut d,
                address,
                Pubkey::new_unique(),
                "example.com",
                &wallet,
                9_000
            ),
            err(Type262Error::NotAWalletRecord)
        );
        assert_eq!(
            run(
                &mut d,
                Pubkey::new_unique(),
                program_id,
                "example.com",
                &wallet,
                9_000
            ),
            err(Type262Error::NotAWalletRecord)
        );
        // An ETH-only record (like the real _wallet.gemprotocol.io) publishes no SOL wallet.
        let mut eth_only = image(txt_owner, TYPE_TXT, &[&eth], 9_000, bump);
        assert_eq!(
            run(
                &mut eth_only,
                address,
                program_id,
                "example.com",
                &wallet,
                9_000
            ),
            err(Type262Error::WalletNotPublished)
        );

        // WALLET at the domain itself, as two character-strings.
        let apex = b"\x07example\x03com\x00";
        let (address, bump) = pda(apex, TYPE_WALLET);
        let two = [txt("SOL"), txt(key)].concat();
        let mut d = image(apex, TYPE_WALLET, &[&two], 9_000, bump);
        assert_eq!(
            run(&mut d, address, program_id, "example.com", &wallet, 5_000),
            Ok(1_000)
        );
        // TXT at the apex, or any other type, is not a wallet record.
        let (address, bump) = pda(apex, TYPE_TXT);
        let mut d = image(apex, TYPE_TXT, &[&sol], 9_000, bump);
        assert_eq!(
            run(&mut d, address, program_id, "example.com", &wallet, 5_000),
            err(Type262Error::NotAWalletRecord)
        );
        let (address, bump) = pda(txt_owner, TYPE_DNSKEY);
        let mut d = image(txt_owner, TYPE_DNSKEY, &[&sol], 9_000, bump);
        assert_eq!(
            run(&mut d, address, program_id, "example.com", &wallet, 5_000),
            err(Type262Error::NotAWalletRecord)
        );
    }

    #[test]
    fn buffer_content() {
        let mut c = 3u32.to_le_bytes().to_vec();
        c.extend_from_slice(b"abc");
        c.extend_from_slice(&2u32.to_le_bytes());
        c.extend_from_slice(b"xy");
        assert_eq!(buffered(&c), Some((&b"abc"[..], &b"xy"[..])));
        c.extend_from_slice(b"left over");
        assert_eq!(buffered(&c), Some((&b"abc"[..], &b"xy"[..])));
        assert_eq!(buffered(&c[..8]), None);
        assert_eq!(buffered(&[]), None);
    }
}
