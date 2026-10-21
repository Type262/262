//! TYPE/262 on Solana: every domain is a wallet.
//!
//! One program, three parts:
//!   - dnssec:   verifies DNSSEC on-chain, from the root trust anchors down to the wallet record a
//!               domain publishes (`_wallet.<domain>` TXT "SOL <pubkey>", or WALLET with code SOL);
//!   - escrow:   holds SOL and SPL tokens for a domain until its owner claims them with that proof;
//!   - launcher: launches pump.fun coins whose creator fees can only ever go to the domain's escrow.
//! There is no attestor, no server and no admin over the rules (see admin.rs for the one role).
//!
//! The entry points below only delegate, so each module can change its accounts and arguments
//! (the `*Args` structs) without touching this file.

use anchor_lang::prelude::*;

pub mod admin;
pub mod constants;
pub mod dnssec;
pub mod errors;
pub mod escrow;
pub mod launcher;
pub mod state;

// #[program] needs each Accounts struct, and the client modules Anchor derives next to it, at
// the crate root. The handlers share their instruction's name, which #[program] also exports;
// nothing refers to either by crate-root path, so the overlap is harmless.
#[allow(ambiguous_glob_reexports)]
pub use admin::*;
#[allow(ambiguous_glob_reexports)]
pub use dnssec::*;
#[allow(ambiguous_glob_reexports)]
pub use escrow::*;
#[allow(ambiguous_glob_reexports)]
pub use launcher::*;

// Local test id only; the mainnet id is set at deployment. See README.md.
declare_id!("3fhiMDY5kyCpX47HU1whuEe6vMQFHPa1hwGhc4Pp72NT");

// Builds with one warning, inside Anchor 0.31's own generated code (its IDL instructions call the
// deprecated AccountInfo::realloc); it can't be silenced from here.
#[program]
pub mod type262 {
    use super::*;

    // ---------- admin ----------

    pub fn initialize<'info>(
        ctx: Context<'_, '_, 'info, 'info, Initialize<'info>>,
        args: InitializeArgs,
    ) -> Result<()> {
        admin::initialize(ctx, args)
    }

    pub fn set_deposits_paused<'info>(
        ctx: Context<'_, '_, 'info, 'info, SetDepositsPaused<'info>>,
        args: SetDepositsPausedArgs,
    ) -> Result<()> {
        admin::set_deposits_paused(ctx, args)
    }

    pub fn transfer_admin<'info>(
        ctx: Context<'_, '_, 'info, 'info, TransferAdmin<'info>>,
        args: TransferAdminArgs,
    ) -> Result<()> {
        admin::transfer_admin(ctx, args)
    }

    pub fn accept_admin<'info>(
        ctx: Context<'_, '_, 'info, 'info, AcceptAdmin<'info>>,
        args: AcceptAdminArgs,
    ) -> Result<()> {
        admin::accept_admin(ctx, args)
    }

    // ---------- dnssec ----------

    pub fn verify_rrset<'info>(
        ctx: Context<'_, '_, 'info, 'info, VerifyRrset<'info>>,
        args: VerifyRrsetArgs,
    ) -> Result<()> {
        dnssec::verify_rrset(ctx, args)
    }

    pub fn verify_rrset_precompiled<'info>(
        ctx: Context<'_, '_, 'info, 'info, VerifyRrset<'info>>,
        args: VerifyRrsetPrecompiledArgs,
    ) -> Result<()> {
        dnssec::verify_rrset_precompiled(ctx, args)
    }

    pub fn write_buffer<'info>(
        ctx: Context<'_, '_, 'info, 'info, WriteBuffer<'info>>,
        args: WriteBufferArgs,
    ) -> Result<()> {
        dnssec::write_buffer(ctx, args)
    }

    pub fn verify_rrset_buffered<'info>(
        ctx: Context<'_, '_, 'info, 'info, VerifyRrsetBuffered<'info>>,
        args: VerifyRrsetBufferedArgs,
    ) -> Result<()> {
        dnssec::verify_rrset_buffered(ctx, args)
    }

    pub fn close_buffer<'info>(
        ctx: Context<'_, '_, 'info, 'info, CloseBuffer<'info>>,
        args: CloseBufferArgs,
    ) -> Result<()> {
        dnssec::close_buffer(ctx, args)
    }

    pub fn close_rrset<'info>(
        ctx: Context<'_, '_, 'info, 'info, CloseRrset<'info>>,
        args: CloseRrsetArgs,
    ) -> Result<()> {
        dnssec::close_rrset(ctx, args)
    }

    // ---------- escrow ----------

    pub fn deposit_sol<'info>(
        ctx: Context<'_, '_, 'info, 'info, DepositSol<'info>>,
        args: DepositSolArgs,
    ) -> Result<()> {
        escrow::deposit_sol(ctx, args)
    }

    pub fn deposit_token<'info>(
        ctx: Context<'_, '_, 'info, 'info, DepositToken<'info>>,
        args: DepositTokenArgs,
    ) -> Result<()> {
        escrow::deposit_token(ctx, args)
    }

    pub fn claim<'info>(
        ctx: Context<'_, '_, 'info, 'info, Claim<'info>>,
        args: ClaimArgs,
    ) -> Result<()> {
        escrow::claim(ctx, args)
    }

    pub fn register<'info>(
        ctx: Context<'_, '_, 'info, 'info, Register<'info>>,
        args: RegisterArgs,
    ) -> Result<()> {
        escrow::register(ctx, args)
    }

    pub fn refund<'info>(
        ctx: Context<'_, '_, 'info, 'info, Refund<'info>>,
        args: RefundArgs,
    ) -> Result<()> {
        escrow::refund(ctx, args)
    }

    pub fn withdraw_fees<'info>(
        ctx: Context<'_, '_, 'info, 'info, WithdrawFees<'info>>,
        args: WithdrawFeesArgs,
    ) -> Result<()> {
        escrow::withdraw_fees(ctx, args)
    }

    // ---------- launcher ----------

    pub fn launch<'info>(
        ctx: Context<'_, '_, 'info, 'info, Launch<'info>>,
        args: LaunchArgs,
    ) -> Result<()> {
        launcher::launch(ctx, args)
    }

    pub fn collect<'info>(
        ctx: Context<'_, '_, 'info, 'info, Collect<'info>>,
        args: CollectArgs,
    ) -> Result<()> {
        launcher::collect(ctx, args)
    }
}
