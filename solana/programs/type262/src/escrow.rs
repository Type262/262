//! The domain escrow: pay any domain before it publishes a wallet. Funds wait in per-domain pools
//! (SOL and any SPL Token or Token-2022 mint) until the domain's owner claims them with a DNSSEC
//! proof of the Solana wallet the domain publishes. Same rules as DomainEscrow on Robinhood Chain:
//!   - a claim pays every unit of the pool to the proven wallet at once, minus the fee
//!     (`Config::fee_bps`, never above MAX_FEE_BPS), which waits in a fee vault until
//!     `withdraw_fees` pulls it to the fee recipient;
//!   - a depositor can refund `Config::refund_delay` after their last deposit to that pool if the
//!     pool hasn't paid out since (pool epochs);
//!   - an older proof can never override a newer one (`Domain::last_proof`), and a proof signed at
//!     the same time as the last one can't change the wallet: the first registered wins a tie, a
//!     strictly later signing time always wins;
//!   - `register` records a proof without moving money;
//!   - a wallet must be an address someone can sign for: never an account of a token program (a
//!     token account or a mint) or a program;
//!   - names are canonical lowercase, so the same domain never ends up with two pools.
//!
//! Rounding and rent: the fee is rounded down once per claim, so a pool of fewer than
//! 10_000 / fee_bps base units (200 at 0.5%) pays no fee, the same as on EVM. Every debit keeps
//! the account at the rent-exempt minimum the cluster asks for at that moment; if rent ever went
//! up, SOL claims and deposits to existing accounts would wait for a plain transfer topping the
//! account up to the new minimum, and a rent cut leaves the difference in the account, uncounted.
//! Counted money never moves either way.
//!
//! Where the money is: a SOL pool holds its balance in the Pool PDA itself, on top of its rent; a
//! token pool in its vault, the Pool PDA's associated token account. Claim fees likewise sit in the
//! FeeVault PDA (SOL) or its associated token account. Every amount the books count is held there,
//! and rent-exempt minimums are never touched.
//!
//! Instructions that can move either SOL or tokens take the token accounts as optional accounts:
//! absent (the program id in their place) for SOL, all present for a token pool.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hash;
use anchor_lang::system_program;
use anchor_spl::associated_token::{
    self, get_associated_token_address_with_program_id, AssociatedToken,
};
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::constants::*;
use crate::dnssec;
use crate::errors::Type262Error;
use crate::state::{Config, Deposit, Domain, FeeVault, Pool};

#[event]
pub struct Deposited {
    pub domain_hash: [u8; 32],
    pub name: String,
    pub mint: Pubkey,
    pub from: Pubkey,
    pub amount: u64,
}

#[event]
pub struct Claimed {
    pub domain_hash: [u8; 32],
    pub mint: Pubkey,
    pub recipient: Pubkey,
    pub amount: u64,
    pub fee: u64,
}

#[event]
pub struct Registered {
    pub domain_hash: [u8; 32],
    pub wallet: Pubkey,
    pub signed_at: i64,
}

#[event]
pub struct Refunded {
    pub domain_hash: [u8; 32],
    pub mint: Pubkey,
    pub depositor: Pubkey,
    pub amount: u64,
}

#[event]
pub struct FeesWithdrawn {
    pub mint: Pubkey,
    pub amount: u64,
}

// ---------- names ----------

/// The pool key of a domain: sha256 of its canonical name. Canonical means lowercase ASCII
/// (punycode for IDNs), labels of 1 to 63 characters from a-z, 0-9, '-' and '_', at most 253
/// characters, no trailing dot. Anything else is rejected, so one domain can never have two pools.
pub fn domain_hash(name: &str) -> Result<[u8; 32]> {
    let b = name.as_bytes();
    require!(
        !b.is_empty() && b.len() <= MAX_DOMAIN_LEN,
        Type262Error::BadDomain
    );
    let mut label = 0usize;
    for &c in b {
        if c == b'.' {
            require!(label != 0, Type262Error::BadDomain);
            label = 0;
        } else if c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-' || c == b'_' {
            label += 1;
            require!(label <= MAX_LABEL_LEN, Type262Error::BadDomain);
        } else {
            return err!(Type262Error::BadDomain);
        }
    }
    require!(label != 0, Type262Error::BadDomain);
    Ok(hash(b).to_bytes())
}

/// Checks that `claimed` is the hash of `name`. Instructions take both because Anchor derives
/// PDAs from instruction data before the handler runs.
pub fn check_domain(name: &str, claimed: &[u8; 32]) -> Result<()> {
    require!(
        domain_hash(name)? == *claimed,
        Type262Error::DomainHashMismatch
    );
    Ok(())
}

// ---------- account setup, shared with the launcher ----------

/// Fills in a domain account (PDA ["domain", domain_hash]) the first time it is used, after
/// checking that `name` is canonical and hashes to `domain_hash`. Every instruction that may create
/// one calls this: a claim reads the name back to find the domain's wallet record.
pub fn open_domain(
    domain: &mut Domain,
    name: &str,
    domain_hash: &[u8; 32],
    bump: u8,
) -> Result<()> {
    check_domain(name, domain_hash)?;
    if domain.domain_hash == [0u8; 32] {
        domain.domain_hash = *domain_hash;
        domain.bump = bump;
    }
    if domain.name.is_empty() {
        domain.name = name.to_string();
    }
    Ok(())
}

/// Fills in a pool account (PDA ["pool", domain_hash, mint]) the first time it is used. Claims and
/// refunds check the PDA with the stored bump, so a pool created without this could never pay out.
pub fn open_pool(pool: &mut Pool, domain_hash: &[u8; 32], mint: &Pubkey, bump: u8) {
    if pool.domain_hash == [0u8; 32] {
        pool.domain_hash = *domain_hash;
        pool.mint = *mint;
        pool.bump = bump;
    }
}

/// Adds non-refundable income (launch fees) to a pool's balance, with no Deposit record, so only
/// the domain's claim can take it. The caller has already moved the asset into the pool: lamports
/// into a SOL Pool PDA, tokens into its vault. Not subject to the deposit pause: it is the domain's
/// own income, not a new deposit.
pub fn credit_fees(pool: &mut Pool, amount: u64) -> Result<()> {
    require!(pool.domain_hash != [0u8; 32], Type262Error::PoolNotOpen);
    pool.balance = pool
        .balance
        .checked_add(amount)
        .ok_or(Type262Error::MathOverflow)?;
    Ok(())
}

fn open_deposit(deposit: &mut Deposit, pool: &Pubkey, depositor: &Pubkey, bump: u8) {
    if deposit.pool == Pubkey::default() {
        deposit.pool = *pool;
        deposit.depositor = *depositor;
        deposit.bump = bump;
    }
}

/// The books of a deposit, as `DomainEscrow._credit`: an amount left from an epoch that was paid
/// out is gone, and the refund delay restarts with every deposit.
fn credit_deposit(pool: &mut Pool, deposit: &mut Deposit, amount: u64, now: i64) -> Result<()> {
    if deposit.epoch != pool.epoch {
        deposit.amount = 0;
        deposit.epoch = pool.epoch;
    }
    deposit.amount = deposit
        .amount
        .checked_add(amount)
        .ok_or(Type262Error::MathOverflow)?;
    deposit.last_at = now;
    pool.balance = pool
        .balance
        .checked_add(amount)
        .ok_or(Type262Error::MathOverflow)?;
    Ok(())
}

/// The claim fee on `amount`, rounded down: under one base unit per claim goes uncharged, so a
/// claim of fewer than 10_000 / fee_bps base units pays none (as on EVM).
pub fn fee_of(amount: u64, fee_bps: u16) -> u64 {
    // fee_bps <= MAX_FEE_BPS, so the result is below amount and fits u64.
    ((amount as u128) * (fee_bps as u128) / (BPS_DENOMINATOR as u128)) as u64
}

// ---------- checks ----------

/// Token-2022 mint extensions a pool can hold with exact books. A pool's balance must always be in
/// its vault, so anything that lets a third party move tokens out of it (permanent delegate), runs
/// another program on every transfer (a transfer hook program), or that this program doesn't know,
/// is refused. A transfer fee is fine only while nobody can change it (see `fixed_transfer_fee`):
/// every inflow is measured and an outflow debits exactly the amount sent, but a fee authority
/// could raise the fee to 100% after the deposits are in, and refunds wait for the refund delay.
/// The rest only change how amounts are displayed, add metadata, or can stop all transfers the way
/// a freeze authority can on any mint.
pub fn check_mint(mint: &AccountInfo) -> Result<()> {
    if *mint.owner != anchor_spl::token_2022::ID {
        return Ok(()); // SPL Token mints have no extensions
    }
    let data = mint.try_borrow_data()?;
    // 82-byte base mint, padded to 165, then the account type (1 = mint) and the extensions.
    const BASE: usize = 82;
    const TYPE_AT: usize = 165;
    if data.len() == BASE {
        return Ok(());
    }
    require!(
        data.len() > TYPE_AT && data[TYPE_AT] == 1,
        Type262Error::UnsupportedMint
    );
    let mut i = TYPE_AT + 1;
    while i + 4 <= data.len() {
        let ty = u16::from_le_bytes([data[i], data[i + 1]]);
        let len = u16::from_le_bytes([data[i + 2], data[i + 3]]) as usize;
        let value = data
            .get(i + 4..i + 4 + len)
            .ok_or(Type262Error::UnsupportedMint)?;
        match ty {
            0 => break, // uninitialized: the rest is free space
            // TransferFeeConfig: only a fee fixed for good.
            1 => require!(fixed_transfer_fee(value)?, Type262Error::UnsupportedMint),
            // MintCloseAuthority, ConfidentialTransferMint (our vaults are never configured for
            // it), DefaultAccountState, InterestBearingConfig, MetadataPointer, TokenMetadata,
            // GroupPointer, TokenGroup, GroupMemberPointer, TokenGroupMember, ScaledUiAmount,
            // Pausable.
            3 | 4 | 6 | 10 | 18..=23 | 25 | 26 => {}
            // TransferHook: only with no hook program set (authority, then program id).
            14 => require!(
                value.len() == 64 && value[32..].iter().all(|&b| b == 0),
                Type262Error::UnsupportedMint
            ),
            _ => return err!(Type262Error::UnsupportedMint),
        }
        i += 4 + len;
    }
    Ok(())
}

/// True if a TransferFeeConfig extension's fee can never change: no transfer fee config authority
/// (Token-2022 can't set one again once it is gone), and no other fee scheduled for a later epoch
/// (the newer fee is already in effect, or is the same as the older one). Its value: the fee config
/// authority and the withdraw-withheld authority (32 bytes each, zeros for none), the amount
/// withheld on the mint (8), then the older and the newer fee, each as epoch (8), maximum fee (8)
/// and basis points (2). The withdraw-withheld authority only takes the fees withheld on transfers,
/// which the books never count.
fn fixed_transfer_fee(value: &[u8]) -> Result<bool> {
    if value.len() != 108 || value[..32].iter().any(|&b| b != 0) {
        return Ok(false);
    }
    let (older, newer) = (&value[72..90], &value[90..108]);
    if older[8..] == newer[8..] {
        return Ok(true);
    }
    // Token-2022 charges the newer fee from its epoch on.
    let starts = u64::from_le_bytes(newer[..8].try_into().unwrap());
    Ok(starts <= Clock::get()?.epoch)
}

/// A wallet a claim can pay and a register can record: an address someone can sign for. An
/// account of either token program (a token account or a mint, published by mistake) or a program
/// is refused: tokens paid to its associated token account could never be moved again.
fn check_wallet(wallet: &AccountInfo) -> Result<()> {
    require!(
        *wallet.key != Pubkey::default()
            && *wallet.owner != anchor_spl::token::ID
            && *wallet.owner != anchor_spl::token_2022::ID
            && !wallet.executable,
        Type262Error::BadRecipient
    );
    Ok(())
}

/// A mint and the account its tokens are held in by `owner`: the mint is `expected`, owned by
/// `token_program`, and the account is `owner`'s associated token account for it.
fn check_vault(
    mint: &InterfaceAccount<Mint>,
    expected: &Pubkey,
    token_program: &Interface<TokenInterface>,
    vault: &InterfaceAccount<TokenAccount>,
    owner: &Pubkey,
) -> Result<()> {
    require_keys_eq!(mint.key(), *expected, Type262Error::WrongMint);
    require_keys_eq!(
        *mint.to_account_info().owner,
        token_program.key(),
        Type262Error::WrongTokenAccount
    );
    require_keys_eq!(
        vault.key(),
        get_associated_token_address_with_program_id(owner, expected, &token_program.key()),
        Type262Error::WrongTokenAccount
    );
    require_keys_eq!(
        *vault.to_account_info().owner,
        token_program.key(),
        Type262Error::WrongTokenAccount
    );
    require_keys_eq!(vault.owner, *owner, Type262Error::WrongTokenAccount);
    require_keys_eq!(vault.mint, *expected, Type262Error::WrongMint);
    Ok(())
}

/// Creates `owner`'s associated token account for the mint if it doesn't exist (the caller pays),
/// after checking its address. The associated token program checks an existing one belongs to
/// `owner` and the mint.
#[allow(clippy::too_many_arguments)]
fn ensure_ata<'info>(
    ata_program: &Program<'info, AssociatedToken>,
    payer: AccountInfo<'info>,
    ata: &AccountInfo<'info>,
    owner: AccountInfo<'info>,
    mint: &InterfaceAccount<'info, Mint>,
    system_program: AccountInfo<'info>,
    token_program: &Interface<'info, TokenInterface>,
) -> Result<()> {
    require_keys_eq!(
        ata.key(),
        get_associated_token_address_with_program_id(owner.key, &mint.key(), &token_program.key()),
        Type262Error::WrongTokenAccount
    );
    associated_token::create_idempotent(CpiContext::new(
        ata_program.to_account_info(),
        associated_token::Create {
            payer,
            associated_token: ata.clone(),
            authority: owner,
            mint: mint.to_account_info(),
            system_program,
            token_program: token_program.to_account_info(),
        },
    ))?;
    // The ATA program just checked (or set) all of this; read it back anyway, since the balance
    // is read from it next.
    require_keys_eq!(
        *ata.owner,
        token_program.key(),
        Type262Error::WrongTokenAccount
    );
    Ok(())
}

/// The amount field of a token account (the same offset for SPL Token and Token-2022).
fn token_amount(account: &AccountInfo) -> Result<u64> {
    let data = account.try_borrow_data()?;
    let bytes = data.get(64..72).ok_or(Type262Error::WrongTokenAccount)?;
    Ok(u64::from_le_bytes(bytes.try_into().unwrap()))
}

#[allow(clippy::too_many_arguments)]
fn send_tokens<'info>(
    token_program: &Interface<'info, TokenInterface>,
    mint: &InterfaceAccount<'info, Mint>,
    from: AccountInfo<'info>,
    to: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    signer_seeds: &[&[&[u8]]],
    amount: u64,
) -> Result<()> {
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            TransferChecked {
                from,
                mint: mint.to_account_info(),
                to,
                authority,
            },
            signer_seeds,
        ),
        amount,
        mint.decimals,
    )
}

/// After lamports leave a program-owned account: it still holds its rent-exempt minimum plus
/// `reserved`, the lamports its books still count. The minimum is read at run time, so a rent
/// increase needs a top-up of the account (a plain transfer by anyone) before it can pay out.
fn check_lamports(account: &AccountInfo, reserved: u64) -> Result<()> {
    let floor = Rent::get()?
        .minimum_balance(account.data_len())
        .checked_add(reserved)
        .ok_or(Type262Error::MathOverflow)?;
    require!(account.lamports() >= floor, Type262Error::PoolUnderfunded);
    Ok(())
}

/// The newest proof wins: `signed_at` must be at least the domain's last accepted proof. On a tie
/// the wallet already recorded stays: some signers give every signature of a period the same
/// inception, so an old and a new wallet record can carry the same `signed_at`, and only a record
/// signed strictly later can replace the wallet. A rotation is complete once such a record is
/// registered.
fn accept_proof(domain: &mut Domain, signed_at: i64, wallet: &Pubkey) -> Result<()> {
    require!(signed_at >= domain.last_proof, Type262Error::StaleProof);
    if signed_at == domain.last_proof && domain.wallet != Pubkey::default() {
        require_keys_eq!(*wallet, domain.wallet, Type262Error::TiedProof);
    }
    domain.last_proof = signed_at;
    domain.wallet = *wallet;
    Ok(())
}

// ---------- deposits ----------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct DepositSolArgs {
    pub name: String,
    pub domain_hash: [u8; 32],
    /// Lamports.
    pub amount: u64,
}

#[derive(Accounts)]
#[instruction(args: DepositSolArgs)]
pub struct DepositSol<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        init_if_needed,
        payer = depositor,
        space = 8 + Domain::INIT_SPACE,
        seeds = [DOMAIN_SEED, args.domain_hash.as_ref()],
        bump
    )]
    pub domain: Account<'info, Domain>,
    /// Holds the pool's lamports on top of its rent.
    #[account(
        init_if_needed,
        payer = depositor,
        space = 8 + Pool::INIT_SPACE,
        seeds = [POOL_SEED, args.domain_hash.as_ref(), SOL_MINT.as_ref()],
        bump
    )]
    pub pool: Account<'info, Pool>,
    #[account(
        init_if_needed,
        payer = depositor,
        space = 8 + Deposit::INIT_SPACE,
        seeds = [DEPOSIT_SEED, pool.key().as_ref(), depositor.key().as_ref()],
        bump
    )]
    pub deposit: Account<'info, Deposit>,
    pub system_program: Program<'info, System>,
}

pub fn deposit_sol(ctx: Context<DepositSol>, args: DepositSolArgs) -> Result<()> {
    require!(!ctx.accounts.config.deposits_paused, Type262Error::Paused);
    require!(args.amount > 0, Type262Error::ZeroAmount);
    let a = ctx.accounts;
    open_domain(
        &mut a.domain,
        &args.name,
        &args.domain_hash,
        ctx.bumps.domain,
    )?;
    open_pool(&mut a.pool, &args.domain_hash, &SOL_MINT, ctx.bumps.pool);
    open_deposit(
        &mut a.deposit,
        &a.pool.key(),
        &a.depositor.key(),
        ctx.bumps.deposit,
    );

    system_program::transfer(
        CpiContext::new(
            a.system_program.to_account_info(),
            system_program::Transfer {
                from: a.depositor.to_account_info(),
                to: a.pool.to_account_info(),
            },
        ),
        args.amount,
    )?;
    credit_deposit(
        &mut a.pool,
        &mut a.deposit,
        args.amount,
        Clock::get()?.unix_timestamp,
    )?;

    emit!(Deposited {
        domain_hash: args.domain_hash,
        name: args.name,
        mint: SOL_MINT,
        from: a.depositor.key(),
        amount: args.amount,
    });
    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct DepositTokenArgs {
    pub name: String,
    pub domain_hash: [u8; 32],
    /// In the mint's base units, as sent; the pool is credited what its vault receives.
    pub amount: u64,
}

#[derive(Accounts)]
#[instruction(args: DepositTokenArgs)]
pub struct DepositToken<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// Before the accounts whose seeds use it: Anchor resolves them in order.
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        init_if_needed,
        payer = depositor,
        space = 8 + Domain::INIT_SPACE,
        seeds = [DOMAIN_SEED, args.domain_hash.as_ref()],
        bump
    )]
    pub domain: Account<'info, Domain>,
    #[account(
        init_if_needed,
        payer = depositor,
        space = 8 + Pool::INIT_SPACE,
        seeds = [POOL_SEED, args.domain_hash.as_ref(), mint.key().as_ref()],
        bump
    )]
    pub pool: Account<'info, Pool>,
    #[account(
        init_if_needed,
        payer = depositor,
        space = 8 + Deposit::INIT_SPACE,
        seeds = [DEPOSIT_SEED, pool.key().as_ref(), depositor.key().as_ref()],
        bump
    )]
    pub deposit: Account<'info, Deposit>,
    #[account(mut, token::mint = mint, token::authority = depositor, token::token_program = token_program)]
    pub depositor_token: InterfaceAccount<'info, TokenAccount>,
    /// The pool's vault: the pool PDA's associated token account for the mint.
    #[account(
        init_if_needed,
        payer = depositor,
        associated_token::mint = mint,
        associated_token::authority = pool,
        associated_token::token_program = token_program
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn deposit_token(ctx: Context<DepositToken>, args: DepositTokenArgs) -> Result<()> {
    require!(!ctx.accounts.config.deposits_paused, Type262Error::Paused);
    require!(args.amount > 0, Type262Error::ZeroAmount);
    let a = ctx.accounts;
    // SOL_MINT is never a real mint (it is the system program), but keep the two kinds apart.
    require_keys_neq!(a.mint.key(), SOL_MINT, Type262Error::WrongMint);
    check_mint(&a.mint.to_account_info())?;
    open_domain(
        &mut a.domain,
        &args.name,
        &args.domain_hash,
        ctx.bumps.domain,
    )?;
    open_pool(
        &mut a.pool,
        &args.domain_hash,
        &a.mint.key(),
        ctx.bumps.pool,
    );
    open_deposit(
        &mut a.deposit,
        &a.pool.key(),
        &a.depositor.key(),
        ctx.bumps.deposit,
    );

    // Credit what the vault actually received, as DomainEscrow does with balanceOf: a Token-2022
    // transfer fee is withheld from it.
    let before = a.vault.amount;
    send_tokens(
        &a.token_program,
        &a.mint,
        a.depositor_token.to_account_info(),
        a.vault.to_account_info(),
        a.depositor.to_account_info(),
        &[],
        args.amount,
    )?;
    a.vault.reload()?;
    let received = a
        .vault
        .amount
        .checked_sub(before)
        .ok_or(Type262Error::MathOverflow)?;
    require!(received > 0, Type262Error::ZeroAmount);
    credit_deposit(
        &mut a.pool,
        &mut a.deposit,
        received,
        Clock::get()?.unix_timestamp,
    )?;

    emit!(Deposited {
        domain_hash: args.domain_hash,
        name: args.name,
        mint: a.mint.key(),
        from: a.depositor.key(),
        amount: received,
    });
    Ok(())
}

// ---------- claims ----------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ClaimArgs {
    pub domain_hash: [u8; 32],
    /// The Solana wallet the domain publishes; the record must show it.
    pub wallet: Pubkey,
}

/// Pays one pool (SOL or one mint) to the wallet the domain publishes. Anyone can send it; the
/// money only ever goes to `wallet`, which the cached DNSSEC record must publish.
#[derive(Accounts)]
#[instruction(args: ClaimArgs)]
pub struct Claim<'info> {
    /// Anyone: pays for the fee vault and the token accounts that don't exist yet.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [DOMAIN_SEED, args.domain_hash.as_ref()], bump = domain.bump)]
    pub domain: Account<'info, Domain>,
    /// CHECK: the cached, verified wallet record (`_wallet.<domain>` TXT or `<domain>` WALLET);
    /// dnssec::wallet_signed_at checks its owner, address, expiry and that it publishes `wallet`.
    pub record: UncheckedAccount<'info>,
    /// CHECK: the wallet being paid, which must be args.wallet; receives SOL, owns the token account.
    /// check_wallet refuses token accounts, mints and programs.
    #[account(mut, address = args.wallet @ Type262Error::BadRecipient)]
    pub wallet: UncheckedAccount<'info>,
    #[account(mut, seeds = [POOL_SEED, args.domain_hash.as_ref(), pool.mint.as_ref()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + FeeVault::INIT_SPACE,
        seeds = [FEES_SEED, pool.mint.as_ref()],
        bump
    )]
    pub fee_vault: Account<'info, FeeVault>,
    pub system_program: Program<'info, System>,

    // Token pools only; all absent for SOL.
    pub mint: Option<InterfaceAccount<'info, Mint>>,
    /// The pool's vault: ATA(pool, mint).
    #[account(mut)]
    pub pool_vault: Option<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: ATA(wallet, mint), created here if needed; the handler checks the address.
    #[account(mut)]
    pub wallet_token: Option<UncheckedAccount<'info>>,
    /// CHECK: ATA(fee_vault, mint), created here if needed; the handler checks the address.
    #[account(mut)]
    pub fee_vault_token: Option<UncheckedAccount<'info>>,
    pub token_program: Option<Interface<'info, TokenInterface>>,
    pub associated_token_program: Option<Program<'info, AssociatedToken>>,
}

pub fn claim<'info>(
    ctx: Context<'_, '_, 'info, 'info, Claim<'info>>,
    args: ClaimArgs,
) -> Result<()> {
    let a = ctx.accounts;
    check_wallet(&a.wallet)?;
    // The name the domain account was opened with is what the record must be for.
    check_domain(&a.domain.name, &args.domain_hash)?;
    let now = Clock::get()?.unix_timestamp;
    let signed_at = dnssec::wallet_signed_at(
        &a.record.to_account_info(),
        ctx.program_id,
        &a.domain.name,
        &args.wallet,
        now,
    )?;
    accept_proof(&mut a.domain, signed_at, &args.wallet)?;

    let mint_key = a.pool.mint;
    // Same values every time (the PDA's canonical bump), so no need to tell a new vault apart.
    a.fee_vault.mint = mint_key;
    a.fee_vault.bump = ctx.bumps.fee_vault;

    let is_sol = mint_key == SOL_MINT;
    let tokens = match (
        &a.mint,
        &a.pool_vault,
        &a.wallet_token,
        &a.fee_vault_token,
        &a.token_program,
        &a.associated_token_program,
    ) {
        (None, None, None, None, None, None) if is_sol => None,
        (Some(m), Some(v), Some(w), Some(f), Some(tp), Some(ap)) if !is_sol => {
            check_vault(m, &mint_key, tp, v, &a.pool.key())?;
            Some((m, v, w, f, tp, ap))
        }
        _ => return err!(Type262Error::WrongMint),
    };

    // Like DomainEscrow, an empty pool still records the proof but pays nothing.
    let amount = a.pool.balance;
    if amount == 0 {
        return Ok(());
    }
    let fee = fee_of(amount, a.config.fee_bps);
    let payout = amount - fee;
    a.pool.balance = 0;
    a.pool.epoch = a
        .pool
        .epoch
        .checked_add(1)
        .ok_or(Type262Error::MathOverflow)?;

    match tokens {
        None => {
            // Lamports move straight between accounts: the pool and the fee vault are ours.
            a.pool.sub_lamports(amount)?;
            check_lamports(&a.pool.to_account_info(), 0)?;
            a.fee_vault.add_lamports(fee)?;
            a.wallet.add_lamports(payout)?;
            a.fee_vault.owed = a
                .fee_vault
                .owed
                .checked_add(fee)
                .ok_or(Type262Error::MathOverflow)?;
        }
        Some((mint, pool_vault, wallet_token, fee_vault_token, token_program, ata_program)) => {
            let bump = [a.pool.bump];
            let seeds: &[&[u8]] = &[POOL_SEED, &args.domain_hash, mint_key.as_ref(), &bump];
            if fee > 0 {
                let fee_ata = fee_vault_token.to_account_info();
                ensure_ata(
                    ata_program,
                    a.payer.to_account_info(),
                    &fee_ata,
                    a.fee_vault.to_account_info(),
                    mint,
                    a.system_program.to_account_info(),
                    token_program,
                )?;
                // Owed is what the fee vault received (a transfer fee may be withheld from it).
                let before = token_amount(&fee_ata)?;
                send_tokens(
                    token_program,
                    mint,
                    pool_vault.to_account_info(),
                    fee_ata.clone(),
                    a.pool.to_account_info(),
                    &[seeds],
                    fee,
                )?;
                let received = token_amount(&fee_ata)?
                    .checked_sub(before)
                    .ok_or(Type262Error::MathOverflow)?;
                a.fee_vault.owed = a
                    .fee_vault
                    .owed
                    .checked_add(received)
                    .ok_or(Type262Error::MathOverflow)?;
            }
            let wallet_ata = wallet_token.to_account_info();
            ensure_ata(
                ata_program,
                a.payer.to_account_info(),
                &wallet_ata,
                a.wallet.to_account_info(),
                mint,
                a.system_program.to_account_info(),
                token_program,
            )?;
            send_tokens(
                token_program,
                mint,
                pool_vault.to_account_info(),
                wallet_ata,
                a.pool.to_account_info(),
                &[seeds],
                payout,
            )?;
        }
    }

    emit!(Claimed {
        domain_hash: args.domain_hash,
        mint: mint_key,
        recipient: args.wallet,
        amount: payout,
        fee,
    });
    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct RegisterArgs {
    pub name: String,
    pub domain_hash: [u8; 32],
    /// The Solana wallet the domain publishes; the record must show it.
    pub wallet: Pubkey,
}

/// Records a proof without moving money, so older records (an old wallet) can never claim later
/// payments. Creates the domain account if nobody has paid it yet.
#[derive(Accounts)]
#[instruction(args: RegisterArgs)]
pub struct Register<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + Domain::INIT_SPACE,
        seeds = [DOMAIN_SEED, args.domain_hash.as_ref()],
        bump
    )]
    pub domain: Account<'info, Domain>,
    /// CHECK: the cached, verified wallet record (`_wallet.<domain>` TXT or `<domain>` WALLET);
    /// dnssec::wallet_signed_at checks its owner, address, expiry and that it publishes `wallet`.
    pub record: UncheckedAccount<'info>,
    /// CHECK: the wallet being recorded, which must be args.wallet; only read, by check_wallet.
    #[account(address = args.wallet @ Type262Error::BadRecipient)]
    pub wallet: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn register(ctx: Context<Register>, args: RegisterArgs) -> Result<()> {
    let a = ctx.accounts;
    check_wallet(&a.wallet)?;
    open_domain(
        &mut a.domain,
        &args.name,
        &args.domain_hash,
        ctx.bumps.domain,
    )?;
    let signed_at = dnssec::wallet_signed_at(
        &a.record.to_account_info(),
        ctx.program_id,
        &args.name,
        &args.wallet,
        Clock::get()?.unix_timestamp,
    )?;
    accept_proof(&mut a.domain, signed_at, &args.wallet)?;
    emit!(Registered {
        domain_hash: args.domain_hash,
        wallet: args.wallet,
        signed_at,
    });
    Ok(())
}

// ---------- refunds and fees ----------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct RefundArgs {
    pub domain_hash: [u8; 32],
    /// SOL_MINT for SOL.
    pub mint: Pubkey,
}

/// Takes back a depositor's unclaimed deposit once the refund delay has passed since their last
/// deposit to the pool. Closes the deposit record and returns its rent.
#[derive(Accounts)]
#[instruction(args: RefundArgs)]
pub struct Refund<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [POOL_SEED, args.domain_hash.as_ref(), args.mint.as_ref()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
    #[account(
        mut,
        close = depositor,
        seeds = [DEPOSIT_SEED, pool.key().as_ref(), depositor.key().as_ref()],
        bump = deposit.bump
    )]
    pub deposit: Account<'info, Deposit>,
    pub system_program: Program<'info, System>,

    // Token pools only; all absent for SOL.
    pub mint: Option<InterfaceAccount<'info, Mint>>,
    /// The pool's vault: ATA(pool, mint).
    #[account(mut)]
    pub pool_vault: Option<InterfaceAccount<'info, TokenAccount>>,
    /// Any token account of the depositor for the mint.
    #[account(mut)]
    pub depositor_token: Option<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Option<Interface<'info, TokenInterface>>,
}

pub fn refund<'info>(
    ctx: Context<'_, '_, 'info, 'info, Refund<'info>>,
    args: RefundArgs,
) -> Result<()> {
    let a = ctx.accounts;
    let amount = a.deposit.amount;
    require!(
        amount > 0 && a.deposit.epoch == a.pool.epoch,
        Type262Error::NothingToRefund
    );
    let unlocks_at = a
        .deposit
        .last_at
        .checked_add(a.config.refund_delay)
        .ok_or(Type262Error::MathOverflow)?;
    require!(
        Clock::get()?.unix_timestamp >= unlocks_at,
        Type262Error::RefundLocked
    );

    let is_sol = args.mint == SOL_MINT;
    let tokens = match (&a.mint, &a.pool_vault, &a.depositor_token, &a.token_program) {
        (None, None, None, None) if is_sol => None,
        (Some(m), Some(v), Some(d), Some(tp)) if !is_sol => {
            check_vault(m, &args.mint, tp, v, &a.pool.key())?;
            require_keys_eq!(
                *d.to_account_info().owner,
                tp.key(),
                Type262Error::WrongTokenAccount
            );
            require_keys_eq!(d.mint, args.mint, Type262Error::WrongMint);
            require_keys_eq!(d.owner, a.depositor.key(), Type262Error::WrongTokenAccount);
            Some((m, v, d, tp))
        }
        _ => return err!(Type262Error::WrongMint),
    };

    a.deposit.amount = 0;
    a.pool.balance = a
        .pool
        .balance
        .checked_sub(amount)
        .ok_or(Type262Error::MathOverflow)?;

    match tokens {
        None => {
            a.pool.sub_lamports(amount)?;
            let remaining = a.pool.balance;
            check_lamports(&a.pool.to_account_info(), remaining)?;
            a.depositor.add_lamports(amount)?;
        }
        Some((mint, pool_vault, depositor_token, token_program)) => {
            let bump = [a.pool.bump];
            let seeds: &[&[u8]] = &[POOL_SEED, &args.domain_hash, args.mint.as_ref(), &bump];
            send_tokens(
                token_program,
                mint,
                pool_vault.to_account_info(),
                depositor_token.to_account_info(),
                a.pool.to_account_info(),
                &[seeds],
                amount,
            )?;
        }
    }

    emit!(Refunded {
        domain_hash: args.domain_hash,
        mint: args.mint,
        depositor: a.depositor.key(),
        amount,
    });
    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct WithdrawFeesArgs {
    /// SOL_MINT for SOL.
    pub mint: Pubkey,
}

/// Sends the claim fees owed in one asset to the configured fee recipient. Anyone can call it;
/// fees only ever go to the recipient (its associated token account for tokens, created here if
/// needed at the caller's cost).
#[derive(Accounts)]
#[instruction(args: WithdrawFeesArgs)]
pub struct WithdrawFees<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [FEES_SEED, args.mint.as_ref()], bump = fee_vault.bump)]
    pub fee_vault: Account<'info, FeeVault>,
    /// CHECK: the configured fee recipient.
    #[account(mut, address = config.fee_recipient @ Type262Error::BadRecipient)]
    pub fee_recipient: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,

    // Token fees only; all absent for SOL.
    pub mint: Option<InterfaceAccount<'info, Mint>>,
    /// The fee vault's token account: ATA(fee_vault, mint).
    #[account(mut)]
    pub fee_vault_token: Option<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: ATA(fee_recipient, mint), created here if needed; the handler checks the address.
    #[account(mut)]
    pub recipient_token: Option<UncheckedAccount<'info>>,
    pub token_program: Option<Interface<'info, TokenInterface>>,
    pub associated_token_program: Option<Program<'info, AssociatedToken>>,
}

pub fn withdraw_fees<'info>(
    ctx: Context<'_, '_, 'info, 'info, WithdrawFees<'info>>,
    args: WithdrawFeesArgs,
) -> Result<()> {
    let a = ctx.accounts;
    let amount = a.fee_vault.owed;
    require!(amount > 0, Type262Error::ZeroAmount);

    let is_sol = args.mint == SOL_MINT;
    let tokens = match (
        &a.mint,
        &a.fee_vault_token,
        &a.recipient_token,
        &a.token_program,
        &a.associated_token_program,
    ) {
        (None, None, None, None, None) if is_sol => None,
        (Some(m), Some(v), Some(r), Some(tp), Some(ap)) if !is_sol => {
            check_vault(m, &args.mint, tp, v, &a.fee_vault.key())?;
            Some((m, v, r, tp, ap))
        }
        _ => return err!(Type262Error::WrongMint),
    };

    a.fee_vault.owed = 0;
    match tokens {
        None => {
            a.fee_vault.sub_lamports(amount)?;
            check_lamports(&a.fee_vault.to_account_info(), 0)?;
            a.fee_recipient.add_lamports(amount)?;
        }
        Some((mint, fee_vault_token, recipient_token, token_program, ata_program)) => {
            let recipient_ata = recipient_token.to_account_info();
            ensure_ata(
                ata_program,
                a.payer.to_account_info(),
                &recipient_ata,
                a.fee_recipient.to_account_info(),
                mint,
                a.system_program.to_account_info(),
                token_program,
            )?;
            let bump = [a.fee_vault.bump];
            let seeds: &[&[u8]] = &[FEES_SEED, args.mint.as_ref(), &bump];
            send_tokens(
                token_program,
                mint,
                fee_vault_token.to_account_info(),
                recipient_ata,
                a.fee_vault.to_account_info(),
                &[seeds],
                amount,
            )?;
        }
    }

    emit!(FeesWithdrawn {
        mint: args.mint,
        amount,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_names_only() {
        let label63 = "a".repeat(63);
        let long = format!("{0}.{0}.{0}.{1}", label63, "a".repeat(61)); // 253 characters
        assert_eq!(long.len(), 253);
        for ok in [
            "example.com",
            "_wallet.example.com",
            "xn--bcher-kva.de",
            "a-b_c.d9",
            "com",
            &long,
            &format!("{label63}.com"),
        ] {
            assert!(domain_hash(ok).is_ok(), "{ok}");
        }
        let too_long = format!("{long}a");
        for bad in [
            "",
            "Example.com",
            "example.com.",
            ".example.com",
            "a..b",
            "exa mple.com",
            "ex@mple.com",
            "bücher.de",
            &too_long,
            &format!("{label63}a.com"),
        ] {
            assert!(domain_hash(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn hash_is_sha256_of_the_name() {
        let expected = "a379a6f6eeafb9a55e378c118034e2751e682fab9f2d30ab13d2125586ce1947";
        let got: String = domain_hash("example.com")
            .unwrap()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        assert_eq!(got, expected);
        assert!(check_domain("example.com", &domain_hash("example.com").unwrap()).is_ok());
        assert!(check_domain("example.org", &domain_hash("example.com").unwrap()).is_err());
    }

    #[test]
    fn fee_rounds_down_and_never_exceeds_the_cap() {
        assert_eq!(fee_of(1_000_000_000, 50), 5_000_000);
        assert_eq!(fee_of(199, 50), 0);
        assert_eq!(fee_of(200, 50), 1);
        assert_eq!(fee_of(u64::MAX, 100), u64::MAX / 100);
        assert_eq!(fee_of(12345, 0), 0);
    }

    #[test]
    fn credits_restart_after_a_payout() {
        let mut pool = Pool {
            domain_hash: [1; 32],
            mint: SOL_MINT,
            balance: 0,
            epoch: 0,
            bump: 255,
        };
        let mut dep = Deposit {
            pool: Pubkey::new_unique(),
            depositor: Pubkey::new_unique(),
            amount: 0,
            epoch: 0,
            last_at: 0,
            bump: 255,
        };
        credit_deposit(&mut pool, &mut dep, 7, 100).unwrap();
        credit_deposit(&mut pool, &mut dep, 3, 200).unwrap();
        assert_eq!((dep.amount, dep.last_at, pool.balance), (10, 200, 10));
        // A claim empties the pool and bumps its epoch: the old amount can't come back.
        pool.balance = 0;
        pool.epoch = 1;
        credit_deposit(&mut pool, &mut dep, 5, 300).unwrap();
        assert_eq!((dep.amount, dep.epoch, pool.balance), (5, 1, 5));
        credit_fees(&mut pool, 2).unwrap();
        assert_eq!((dep.amount, pool.balance), (5, 7));
        let mut fresh = Pool {
            domain_hash: [0; 32],
            ..pool
        };
        assert!(credit_fees(&mut fresh, 1).is_err());
    }

    /// A Token-2022 mint account with the given (type, value) extensions.
    fn mint_with(extensions: &[(u16, Vec<u8>)]) -> Vec<u8> {
        let mut d = vec![0u8; 165];
        d[45] = 6; // decimals
        d[46] = 1; // initialized
        d.push(1); // account type: mint
        for (ty, value) in extensions {
            d.extend_from_slice(&ty.to_le_bytes());
            d.extend_from_slice(&(value.len() as u16).to_le_bytes());
            d.extend_from_slice(value);
        }
        d
    }

    fn check(data: &mut [u8], owner: &Pubkey) -> bool {
        let key = Pubkey::new_unique();
        let mut lamports = 1;
        let info = AccountInfo::new(&key, false, false, &mut lamports, data, owner, false, 0);
        check_mint(&info).is_ok()
    }

    #[test]
    fn mint_extension_policy() {
        let t22 = anchor_spl::token_2022::ID;
        let classic = anchor_spl::token::ID;
        assert!(check(&mut vec![0u8; 82], &classic));
        assert!(check(&mut vec![0u8; 82], &t22));
        // Metadata, as on pump.fun coins, and a transfer fee (inflows are measured).
        assert!(check(
            &mut mint_with(&[(18, vec![0; 64]), (19, vec![1; 90])]),
            &t22
        ));
        assert!(check(&mut mint_with(&[(1, vec![0; 108])]), &t22));
        // A transfer fee someone can still change is not: a fee config authority, or a malformed
        // value. (A newer fee scheduled for a later epoch is tested in LiteSVM, which has a clock.)
        let mut authority = vec![0u8; 108];
        authority[31] = 1;
        assert!(!check(&mut mint_with(&[(1, authority)]), &t22));
        let mut withdraw_only = vec![0u8; 108];
        withdraw_only[32..64].fill(7);
        withdraw_only[88] = 100; // 1% in both epochs
        withdraw_only[106] = 100;
        assert!(check(&mut mint_with(&[(1, withdraw_only)]), &t22));
        assert!(!check(&mut mint_with(&[(1, vec![0; 107])]), &t22));
        // A transfer hook extension with no program is fine; with one it isn't.
        assert!(check(&mut mint_with(&[(14, vec![0; 64])]), &t22));
        let mut hook = vec![0u8; 64];
        hook[40] = 9;
        assert!(!check(&mut mint_with(&[(14, hook)]), &t22));
        // Permanent delegate, non-transferable, unknown types, bad lengths.
        assert!(!check(&mut mint_with(&[(12, vec![5; 32])]), &t22));
        assert!(!check(
            &mut mint_with(&[(18, vec![0; 64]), (9, vec![])]),
            &t22
        ));
        assert!(!check(&mut mint_with(&[(99, vec![])]), &t22));
        let mut truncated = mint_with(&[(18, vec![0; 64])]);
        truncated.truncate(200);
        assert!(!check(&mut truncated, &t22));
        let mut not_a_mint = mint_with(&[]);
        not_a_mint[165] = 2;
        assert!(!check(&mut not_a_mint, &t22));
    }

    #[test]
    fn wallets_someone_can_sign_for() {
        let run = |key: Pubkey, owner: Pubkey, executable: bool| {
            let (mut lamports, mut data) = (1u64, vec![0u8; 165]);
            let info = AccountInfo::new(
                &key,
                false,
                false,
                &mut lamports,
                &mut data,
                &owner,
                executable,
                0,
            );
            check_wallet(&info).is_ok()
        };
        let system = anchor_lang::system_program::ID;
        assert!(run(Pubkey::new_unique(), system, false));
        // Off-curve addresses of other programs (a multisig vault, say) are wallets too.
        assert!(run(Pubkey::new_unique(), Pubkey::new_unique(), false));
        assert!(!run(Pubkey::new_unique(), anchor_spl::token::ID, false));
        assert!(!run(
            Pubkey::new_unique(),
            anchor_spl::token_2022::ID,
            false
        ));
        assert!(!run(Pubkey::new_unique(), Pubkey::new_unique(), true));
        assert!(!run(Pubkey::default(), system, false));
    }

    #[test]
    fn a_tie_keeps_the_wallet_already_recorded() {
        let (old, new) = (Pubkey::new_unique(), Pubkey::new_unique());
        let mut d = Domain {
            domain_hash: [1; 32],
            last_proof: 0,
            wallet: Pubkey::default(),
            launches: 0,
            bump: 255,
            name: "example.com".into(),
        };
        let code = |r: Result<()>| match r {
            Err(Error::AnchorError(e)) => e.error_code_number,
            _ => 0,
        };
        // The first proof records its wallet; the same one again is fine.
        accept_proof(&mut d, 100, &old).unwrap();
        accept_proof(&mut d, 100, &old).unwrap();
        // Another wallet signed at the same time can't take over; an older one never.
        assert_eq!(
            code(accept_proof(&mut d, 100, &new)),
            6000 + Type262Error::TiedProof as u32
        );
        assert_eq!(
            code(accept_proof(&mut d, 99, &old)),
            6000 + Type262Error::StaleProof as u32
        );
        assert_eq!((d.last_proof, d.wallet), (100, old));
        // A strictly later one does, and then the old wallet is the stale one.
        accept_proof(&mut d, 101, &new).unwrap();
        assert_eq!((d.last_proof, d.wallet), (101, new));
        assert_eq!(
            code(accept_proof(&mut d, 101, &old)),
            6000 + Type262Error::TiedProof as u32
        );
    }
}
