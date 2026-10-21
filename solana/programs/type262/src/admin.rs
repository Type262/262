//! Setup and the admin role. The admin can pause new deposits and hand the role over in two
//! steps. Nothing else: it can never move funds, change who gets paid, or block claims and refunds.

use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::Type262Error;
use crate::state::Config;

#[event]
pub struct DepositsPausedSet {
    pub paused: bool,
}

#[event]
pub struct AdminTransferStarted {
    pub from: Pubkey,
    pub to: Pubkey,
}

#[event]
pub struct AdminTransferred {
    pub from: Pubkey,
    pub to: Pubkey,
}

// ---------- initialize ----------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct InitializeArgs {
    pub admin: Pubkey,
    pub fee_recipient: Pubkey,
    /// FEE_BPS on mainnet; at most MAX_FEE_BPS.
    pub fee_bps: u16,
    /// REFUND_DELAY on mainnet.
    pub refund_delay: i64,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    /// Must be the program's upgrade authority, so nobody can initialize a fresh deployment
    /// before its deployer does.
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init, payer = authority, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()))]
    pub program: Program<'info, crate::program::Type262>,
    #[account(
        constraint = program_data.upgrade_authority_address == Some(authority.key())
            @ Type262Error::NotUpgradeAuthority
    )]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

pub fn initialize(ctx: Context<Initialize>, args: InitializeArgs) -> Result<()> {
    require!(args.admin != Pubkey::default(), Type262Error::BadConfig);
    require!(args.refund_delay > 0, Type262Error::BadConfig);
    require!(args.fee_bps <= MAX_FEE_BPS, Type262Error::BadConfig);
    require!(
        args.fee_bps == 0 || args.fee_recipient != Pubkey::default(),
        Type262Error::BadConfig
    );

    let config = &mut ctx.accounts.config;
    config.admin = args.admin;
    config.pending_admin = Pubkey::default();
    config.fee_recipient = args.fee_recipient;
    config.fee_bps = args.fee_bps;
    config.refund_delay = args.refund_delay;
    config.deposits_paused = false;
    config.bump = ctx.bumps.config;
    emit!(AdminTransferred {
        from: Pubkey::default(),
        to: args.admin
    });
    Ok(())
}

// ---------- admin ----------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct SetDepositsPausedArgs {
    pub paused: bool,
}

#[derive(Accounts)]
pub struct SetDepositsPaused<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ Type262Error::NotAdmin)]
    pub config: Account<'info, Config>,
}

pub fn set_deposits_paused(
    ctx: Context<SetDepositsPaused>,
    args: SetDepositsPausedArgs,
) -> Result<()> {
    ctx.accounts.config.deposits_paused = args.paused;
    emit!(DepositsPausedSet {
        paused: args.paused
    });
    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct TransferAdminArgs {
    /// Pubkey::default() cancels a pending handover.
    pub new_admin: Pubkey,
}

#[derive(Accounts)]
pub struct TransferAdmin<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ Type262Error::NotAdmin)]
    pub config: Account<'info, Config>,
}

pub fn transfer_admin(ctx: Context<TransferAdmin>, args: TransferAdminArgs) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.pending_admin = args.new_admin;
    emit!(AdminTransferStarted {
        from: config.admin,
        to: args.new_admin
    });
    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct AcceptAdminArgs {}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    pub new_admin: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = config.pending_admin == new_admin.key() @ Type262Error::NotPendingAdmin
    )]
    pub config: Account<'info, Config>,
}

pub fn accept_admin(ctx: Context<AcceptAdmin>, _args: AcceptAdminArgs) -> Result<()> {
    let config = &mut ctx.accounts.config;
    emit!(AdminTransferred {
        from: config.admin,
        to: ctx.accounts.new_admin.key()
    });
    config.admin = ctx.accounts.new_admin.key();
    config.pending_admin = Pubkey::default();
    Ok(())
}
