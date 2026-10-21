//! Accounts the program owns. Fixed-size fields come first in every struct so clients can
//! filter getProgramAccounts with memcmp at fixed offsets; sizes are 8 (Anchor discriminator)
//! plus INIT_SPACE. The seeds are in constants.rs.

use anchor_lang::prelude::*;

/// Program-wide settings, PDA ["config"]. The admin can pause new deposits and hand over the
/// role in two steps. Nothing else here can change after `initialize`.
#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    /// Pubkey::default() when no handover is pending.
    pub pending_admin: Pubkey,
    /// Receives claim fees, which it pulls with `withdraw_fees`.
    pub fee_recipient: Pubkey,
    pub fee_bps: u16,
    /// Seconds after a depositor's last deposit before they can refund it.
    pub refund_delay: i64,
    pub deposits_paused: bool,
    pub bump: u8,
}

/// Upload space for one signed RRset too big for a transaction, PDA ["buffer", payer]. After the
/// discriminator it holds [u32 length, signed set, u32 length, signature], written in chunks by
/// `write_buffer` and read in place by `verify_rrset_buffered`, which closes it.
#[account]
pub struct Buffer {}

impl Buffer {
    pub const DATA_OFFSET: usize = 8;
    /// Content limit; accounts created through CPI can be at most 10 KiB.
    pub const MAX_SIZE: u32 = 8 * 1024;
}

/// A DNSSEC-verified RRset, cached so later proofs build on it instead of re-proving the root
/// and the TLD. PDA ["rrset", sha256(owner name in canonical wire form), rrtype (u16 BE)]: one
/// per owner name and type, replaced only by a set signed later, or at the same time with other
/// records or a longer validity, or once it expired (see dnssec::wire::replaces).
#[account]
pub struct RrSet {
    pub bump: u8,
    pub rrtype: u16,
    /// Algorithm and key tag of the RRSIG that proved it.
    pub algorithm: u8,
    pub key_tag: u16,
    /// Unix time of the RRSIG inception: when the zone signed this data.
    pub signed_at: i64,
    /// Unix time after which nothing may use it: the earliest RRSIG expiration in its chain.
    pub expires_at: i64,
    /// Paid the rent, and gets it back when the expired entry is closed.
    pub payer: Pubkey,
    /// Owner name, canonical wire form.
    pub owner: Vec<u8>,
    /// The records as signed, in canonical order, each as [u16 LE length, RDATA].
    pub rdata: Vec<u8>,
}

impl RrSet {
    /// Discriminator, fixed fields and both Vec lengths.
    pub const FIXED_SPACE: usize = 8 + 1 + 2 + 1 + 2 + 8 + 8 + 32 + 4 + 4;

    pub const fn space(owner_len: usize, rdata_len: usize) -> usize {
        Self::FIXED_SPACE + owner_len + rdata_len
    }
}

/// One per domain that has been paid, claimed, registered or launched for, PDA
/// ["domain", domain_hash] with domain_hash = sha256(canonical name).
#[account]
#[derive(InitSpace)]
pub struct Domain {
    pub domain_hash: [u8; 32],
    /// Signing time of the newest proof accepted for this domain: an older one can never claim.
    pub last_proof: i64,
    /// The wallet that proof published, Pubkey::default() before the first claim or register.
    pub wallet: Pubkey,
    /// Coins launched for this domain.
    pub launches: u32,
    pub bump: u8,
    #[max_len(253)]
    pub name: String,
}

/// What one domain is owed in one asset, PDA ["pool", domain_hash, mint] with
/// mint = Pubkey::default() for SOL. A SOL pool holds its lamports in this account on top of rent;
/// a token pool holds them in its vault, the associated token account of this PDA.
#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub domain_hash: [u8; 32],
    pub mint: Pubkey,
    pub balance: u64,
    /// Bumps on every claim payout; deposits from an older epoch were paid out and can't be refunded.
    pub epoch: u64,
    pub bump: u8,
}

/// One depositor's refundable share of a pool, PDA ["deposit", pool, depositor]. A refund closes it
/// and returns its rent.
#[account]
#[derive(InitSpace)]
pub struct Deposit {
    pub pool: Pubkey,
    pub depositor: Pubkey,
    pub amount: u64,
    /// The pool epoch this amount belongs to.
    pub epoch: u64,
    /// Time of the last deposit; the refund delay counts from here.
    pub last_at: i64,
    pub bump: u8,
}

/// Claim fees in one asset waiting for the fee recipient, PDA ["fees", mint] (Pubkey::default() for
/// SOL). Pulled, so a recipient that can't receive never blocks a claim. SOL fees sit in this account
/// on top of its rent, token fees in its associated token account.
#[account]
#[derive(InitSpace)]
pub struct FeeVault {
    pub mint: Pubkey,
    /// What the vault received in claim fees and hasn't paid out yet.
    pub owed: u64,
    pub bump: u8,
}

/// One coin launched on pump.fun for a domain, PDA ["launch", mint].
#[account]
#[derive(InitSpace)]
pub struct LaunchRecord {
    pub domain_hash: [u8; 32],
    pub mint: Pubkey,
    /// Who sent the launch transaction.
    pub launcher: Pubkey,
    pub launched_at: i64,
    pub bump: u8,
}
