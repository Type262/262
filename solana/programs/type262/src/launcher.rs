//! Launch coins on pump.fun whose creator fees go to a domain.
//!
//! The pump.fun creator of every coin launched for a domain is a PDA of this program,
//! ["creator", domain_hash]. pump.fun takes the creator as plain instruction data, so the PDA never
//! signs for pump.fun; this program signs as the PDA only to move what it received into the domain's
//! SOL pool and to unwrap its own WSOL account, so nobody can ever redirect the fees (see
//! docs/PUMP.md, "The creator" and "Safety"). `collect` is permissionless.
//!
//! What a client sends (docs/PUMP.md has the pump.fun side in full):
//!
//! `launch`: the named accounts of `Launch`, then as remaining accounts the 16 `create_v2` accounts
//! in pump's order: mint (w, s), mint_authority, bonding_curve (w), associated_bonding_curve (w),
//! global, user = the launcher (w, s), system_program, token_program (Token-2022),
//! associated_token_program, mayhem_program_id (w), global_params, sol_vault (w), mayhem_state (w),
//! mayhem_token_vault (w), event_authority, program (pump). Then, in the same transaction, the
//! buyer's Token-2022 ATA (create idempotent) and pump's `buy_v3`. That is 1,285 bytes for
//! example.com, over the 1,232 of a legacy transaction: send it as v0 with a lookup table of the
//! fixed accounts (981 bytes). docs/PUMP.md, "The launcher", has both account tables.
//!
//! `collect`: only the named accounts of `Collect`, no remaining accounts. pump's per-coin sweeps are
//! permissionless and go before it in the same transaction: pump `sweep_creator_fee` for each coin
//! with fees on its curve and, once a coin has graduated, PumpSwap `sweep_creator_fee` for its pool.
//! `collect` then claims whatever reached the domain's creator vaults (the bonding-curve vault in
//! lamports, the PumpSwap vault in WSOL) and moves it into the domain's SOL pool.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke;
use anchor_lang::solana_program::pubkey;
use anchor_lang::system_program::{self, Transfer};
use anchor_spl::associated_token::{self, get_associated_token_address, AssociatedToken};
use anchor_spl::token::{self, CloseAccount, Token};

use crate::constants::*;
use crate::errors::Type262Error;
use crate::escrow::{credit_fees, open_domain, open_pool};
use crate::state::{Domain, LaunchRecord, Pool};

// ---------- pump.fun (docs/PUMP.md, "Programs and fixed accounts") ----------

/// pump.fun bonding curve program.
pub const PUMP_PROGRAM_ID: Pubkey = pubkey!("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
/// PumpSwap AMM, where coins trade after graduation.
pub const PUMP_AMM_PROGRAM_ID: Pubkey = pubkey!("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
/// pump's ["__event_authority"].
pub const PUMP_EVENT_AUTHORITY: Pubkey = pubkey!("Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1");
/// PumpSwap's ["__event_authority"].
pub const PUMP_AMM_EVENT_AUTHORITY: Pubkey =
    pubkey!("GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR");
/// Wrapped SOL: the quote mint of SOL-paired coins and the token PumpSwap pays creator fees in.
pub const WSOL_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");

/// ["bonding-curve", mint] under pump.
pub const BONDING_CURVE_SEED: &[u8] = b"bonding-curve";
/// ["creator-vault", creator] under pump: the creator's bonding-curve fees, in lamports.
pub const PUMP_CREATOR_VAULT_SEED: &[u8] = b"creator-vault";
/// ["creator_vault", creator] under PumpSwap (underscore): owner of the creator's WSOL fee account.
pub const AMM_CREATOR_VAULT_SEED: &[u8] = b"creator_vault";

/// Anchor discriminators, sha256("global:<name>")[..8], checked against the IDLs in the tests.
pub const CREATE_V2_IX: [u8; 8] = [0xd6, 0x90, 0x4c, 0xec, 0x5f, 0x8b, 0x31, 0xb4];
pub const COLLECT_CREATOR_FEE_V2_IX: [u8; 8] = [0xcf, 0x11, 0x8a, 0xf2, 0x04, 0x22, 0x13, 0x38];
pub const COLLECT_COIN_CREATOR_FEE_IX: [u8; 8] = [0xa0, 0x39, 0x59, 0x2a, 0xb5, 0x8b, 0x2b, 0x42];

/// Positions in the `create_v2` account list that `launch` checks; pump checks the others itself.
pub const CREATE_V2_MINT: usize = 0;
pub const CREATE_V2_BONDING_CURVE: usize = 2;
pub const CREATE_V2_USER: usize = 5;

/// Byte offsets in pump's BondingCurve account (8-byte discriminator first).
pub const CURVE_CREATOR: usize = 49;
pub const CURVE_IS_MAYHEM_MODE: usize = 81;
pub const CURVE_QUOTE_MINT: usize = 83;
pub const CURVE_IS_HOLDER_REWARD: usize = 124;

/// SPL Token account layout: amount, and is_native (COption<u64>: the rent reserve of a WSOL account).
const TOKEN_ACCOUNT_LEN: usize = 165;
const TOKEN_AMOUNT: usize = 64;
const TOKEN_STATE: usize = 108;
const TOKEN_IS_NATIVE: usize = 109;

#[event]
pub struct DomainCoinLaunched {
    pub domain_hash: [u8; 32],
    pub name: String,
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub launcher: Pubkey,
}

/// The creator vaults are per creator, shared by all of a domain's coins, so the amount can't be
/// attributed to one coin.
#[event]
pub struct CreatorFeesCollected {
    pub domain_hash: [u8; 32],
    pub amount: u64,
}

// ---------- launch ----------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct LaunchArgs {
    pub name: String,
    pub domain_hash: [u8; 32],
    pub token_name: String,
    pub token_symbol: String,
    pub token_uri: String,
}

#[derive(Accounts)]
#[instruction(args: LaunchArgs)]
pub struct Launch<'info> {
    /// Pays every rent (ours and pump's) and is pump's `user`.
    #[account(mut)]
    pub launcher: Signer<'info>,
    #[account(
        init_if_needed,
        payer = launcher,
        space = 8 + Domain::INIT_SPACE,
        seeds = [DOMAIN_SEED, args.domain_hash.as_ref()],
        bump
    )]
    pub domain: Account<'info, Domain>,
    /// CHECK: the domain's pump.fun creator: a system account with no data that only holds lamports.
    /// Funded here up to rent-exempt, or pump.fun's collect silently pays it nothing.
    #[account(mut, seeds = [CREATOR_SEED, args.domain_hash.as_ref()], bump)]
    pub creator: UncheckedAccount<'info>,
    /// The new coin's mint, a fresh keypair.
    #[account(mut)]
    pub mint: Signer<'info>,
    #[account(
        init,
        payer = launcher,
        space = 8 + LaunchRecord::INIT_SPACE,
        seeds = [LAUNCH_SEED, mint.key().as_ref()],
        bump
    )]
    pub launch_record: Account<'info, LaunchRecord>,
    /// CHECK: pump.fun itself.
    #[account(address = PUMP_PROGRAM_ID @ Type262Error::WrongPumpProgram)]
    pub pump_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Creates the coin with pump's `create_v2`, creator = the domain's creator PDA, then checks on the
/// bonding curve pump wrote that the creator really is that PDA.
pub fn launch<'info>(
    ctx: Context<'_, '_, 'info, 'info, Launch<'info>>,
    args: LaunchArgs,
) -> Result<()> {
    // Checks that the name is canonical and hashes to domain_hash; fills in a new domain account.
    open_domain(
        &mut ctx.accounts.domain,
        &args.name,
        &args.domain_hash,
        ctx.bumps.domain,
    )?;

    // The create_v2 accounts pass through as they are, so a new pump account doesn't need a new
    // program; only the three we rely on are pinned here, and the curve is checked after the call.
    let pump = ctx.remaining_accounts;
    require!(
        pump.len() > CREATE_V2_USER,
        Type262Error::MissingPumpAccounts
    );
    let mint = ctx.accounts.mint.key();
    require_keys_eq!(
        pump[CREATE_V2_MINT].key(),
        mint,
        Type262Error::WrongCoinMint
    );
    require_keys_eq!(
        pump[CREATE_V2_USER].key(),
        ctx.accounts.launcher.key(),
        Type262Error::WrongCoinLauncher
    );
    let curve =
        Pubkey::find_program_address(&[BONDING_CURVE_SEED, mint.as_ref()], &PUMP_PROGRAM_ID).0;
    require_keys_eq!(
        pump[CREATE_V2_BONDING_CURVE].key(),
        curve,
        Type262Error::WrongBondingCurve
    );

    let creator = ctx.accounts.creator.key();
    top_up(
        &ctx.accounts.launcher.to_account_info(),
        &ctx.accounts.creator.to_account_info(),
        &ctx.accounts.system_program,
    )?;

    // `invoke`, not `invoke_signed`: the launcher and the mint sign the transaction, and the creator
    // signs nothing.
    let ix = Instruction {
        program_id: PUMP_PROGRAM_ID,
        accounts: pump
            .iter()
            .map(|a| AccountMeta {
                pubkey: a.key(),
                is_signer: a.is_signer,
                is_writable: a.is_writable,
            })
            .collect(),
        data: create_v2_data(
            &args.token_name,
            &args.token_symbol,
            &args.token_uri,
            &creator,
        ),
    };
    let mut infos = pump.to_vec();
    infos.push(ctx.accounts.pump_program.to_account_info());
    invoke(&ix, &infos)?;

    check_launched_curve(&pump[CREATE_V2_BONDING_CURVE], &creator)?;

    let record = &mut ctx.accounts.launch_record;
    record.domain_hash = args.domain_hash;
    record.mint = mint;
    record.launcher = ctx.accounts.launcher.key();
    record.launched_at = Clock::get()?.unix_timestamp;
    record.bump = ctx.bumps.launch_record;

    let domain = &mut ctx.accounts.domain;
    domain.launches = domain
        .launches
        .checked_add(1)
        .ok_or(Type262Error::MathOverflow)?;

    emit!(DomainCoinLaunched {
        domain_hash: args.domain_hash,
        name: args.name,
        mint,
        creator,
        launcher: ctx.accounts.launcher.key(),
    });
    Ok(())
}

/// create_v2's data: name, symbol, uri, creator, then is_mayhem_mode, is_cashback_enabled,
/// creator_fee_bps and is_holder_reward all off. The last three are pump's OptionBool / OptionU64,
/// plain values without an Option tag.
pub fn create_v2_data(name: &str, symbol: &str, uri: &str, creator: &Pubkey) -> Vec<u8> {
    let mut data = Vec::with_capacity(8 + 12 + name.len() + symbol.len() + uri.len() + 32 + 11);
    data.extend_from_slice(&CREATE_V2_IX);
    for s in [name, symbol, uri] {
        data.extend_from_slice(&(s.len() as u32).to_le_bytes());
        data.extend_from_slice(s.as_bytes());
    }
    data.extend_from_slice(creator.as_ref());
    data.push(0); // is_mayhem_mode
    data.push(0); // is_cashback_enabled
    data.extend_from_slice(&0u64.to_le_bytes()); // creator_fee_bps
    data.push(0); // is_holder_reward
    data
}

/// The curve pump just created must pay its creator fees to our PDA: owned by pump, creator = PDA,
/// not a holder-rewards or mayhem coin, and paired with SOL (the only quote `collect` handles).
/// This holds whatever pump.fun adds to `create_v2` later.
pub fn check_launched_curve(curve: &AccountInfo, creator: &Pubkey) -> Result<()> {
    require_keys_eq!(
        *curve.owner,
        PUMP_PROGRAM_ID,
        Type262Error::BadLaunchedCurve
    );
    let data = curve.try_borrow_data()?;
    require!(
        data.len() > CURVE_IS_HOLDER_REWARD,
        Type262Error::BadLaunchedCurve
    );
    let quote = &data[CURVE_QUOTE_MINT..CURVE_QUOTE_MINT + 32];
    require!(
        &data[CURVE_CREATOR..CURVE_CREATOR + 32] == creator.as_ref()
            && data[CURVE_IS_HOLDER_REWARD] == 0
            && data[CURVE_IS_MAYHEM_MODE] == 0
            && (quote == [0u8; 32] || quote == WSOL_MINT.as_ref()),
        Type262Error::BadLaunchedCurve
    );
    Ok(())
}

/// Brings the creator PDA up to the rent-exempt minimum for no data. Read at runtime: mainnet rent
/// changed (650,240 lamports now, not the old 890,880).
fn top_up<'info>(
    payer: &AccountInfo<'info>,
    creator: &AccountInfo<'info>,
    system: &Program<'info, System>,
) -> Result<()> {
    let floor = Rent::get()?.minimum_balance(0);
    let have = creator.lamports();
    if have < floor {
        system_program::transfer(
            CpiContext::new(
                system.to_account_info(),
                Transfer {
                    from: payer.clone(),
                    to: creator.clone(),
                },
            ),
            floor - have,
        )?;
    }
    Ok(())
}

// ---------- collect ----------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CollectArgs {
    pub domain_hash: [u8; 32],
}

/// Every account is fixed by the domain: the PDAs are checked in the handler, the rest by address.
#[derive(Accounts)]
#[instruction(args: CollectArgs)]
pub struct Collect<'info> {
    /// Anyone. Pays for the pool account if this is the domain's first SOL and tops the creator up to
    /// rent-exempt if it ever fell below; the creator's WSOL account, if this creates it, is refunded
    /// when it closes at the end.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [DOMAIN_SEED, args.domain_hash.as_ref()], bump = domain.bump)]
    pub domain: Account<'info, Domain>,
    /// CHECK: the domain's pump.fun creator, which receives the fees before they move to the pool.
    #[account(mut, seeds = [CREATOR_SEED, args.domain_hash.as_ref()], bump)]
    pub creator: UncheckedAccount<'info>,
    /// CHECK: ATA(creator, WSOL): PumpSwap pays creator fees into it; created if needed, closed here.
    #[account(mut)]
    pub creator_wsol: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + Pool::INIT_SPACE,
        seeds = [POOL_SEED, args.domain_hash.as_ref(), SOL_MINT.as_ref()],
        bump
    )]
    pub pool: Account<'info, Pool>,
    /// CHECK: ["creator-vault", creator] under pump: the bonding-curve fees, in lamports.
    #[account(mut)]
    pub creator_vault: UncheckedAccount<'info>,
    /// CHECK: ATA(creator_vault, WSOL). Unused for SOL coins; pump's collect takes it anyway.
    #[account(mut)]
    pub creator_vault_wsol: UncheckedAccount<'info>,
    /// CHECK: pump's event authority.
    #[account(address = PUMP_EVENT_AUTHORITY @ Type262Error::WrongPumpAccount)]
    pub pump_event_authority: UncheckedAccount<'info>,
    /// CHECK: pump.fun itself.
    #[account(address = PUMP_PROGRAM_ID @ Type262Error::WrongPumpProgram)]
    pub pump_program: UncheckedAccount<'info>,
    /// CHECK: ["creator_vault", creator] under PumpSwap.
    pub amm_vault_authority: UncheckedAccount<'info>,
    /// CHECK: ATA(amm_vault_authority, WSOL): the PumpSwap fees swept so far.
    #[account(mut)]
    pub amm_vault_wsol: UncheckedAccount<'info>,
    /// CHECK: PumpSwap's event authority.
    #[account(address = PUMP_AMM_EVENT_AUTHORITY @ Type262Error::WrongPumpAccount)]
    pub amm_event_authority: UncheckedAccount<'info>,
    /// CHECK: PumpSwap itself.
    #[account(address = PUMP_AMM_PROGRAM_ID @ Type262Error::WrongPumpProgram)]
    pub amm_program: UncheckedAccount<'info>,
    /// CHECK: the WSOL mint.
    #[account(address = WSOL_MINT @ Type262Error::WrongPumpAccount)]
    pub wsol_mint: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Claims the domain's creator fees from pump (bonding curve) and PumpSwap, whichever holds any,
/// and moves everything the creator PDA holds above its rent into the domain's SOL pool, as income
/// nobody can refund. A pump collect only runs when its vault has something to pay, so if pump.fun
/// changes one of these instructions, clients can still run it themselves before this one and it
/// moves what arrived.
pub fn collect<'info>(
    ctx: Context<'_, '_, 'info, 'info, Collect<'info>>,
    args: CollectArgs,
) -> Result<()> {
    let a = &ctx.accounts;
    let creator = a.creator.key();
    let creator_vault = Pubkey::find_program_address(
        &[PUMP_CREATOR_VAULT_SEED, creator.as_ref()],
        &PUMP_PROGRAM_ID,
    )
    .0;
    require_keys_eq!(
        a.creator_vault.key(),
        creator_vault,
        Type262Error::WrongCreatorVault
    );
    require_keys_eq!(
        a.creator_vault_wsol.key(),
        get_associated_token_address(&creator_vault, &WSOL_MINT),
        Type262Error::WrongCreatorVault
    );
    let amm_vault = Pubkey::find_program_address(
        &[AMM_CREATOR_VAULT_SEED, creator.as_ref()],
        &PUMP_AMM_PROGRAM_ID,
    )
    .0;
    require_keys_eq!(
        a.amm_vault_authority.key(),
        amm_vault,
        Type262Error::WrongCreatorVault
    );
    require_keys_eq!(
        a.amm_vault_wsol.key(),
        get_associated_token_address(&amm_vault, &WSOL_MINT),
        Type262Error::WrongCreatorVault
    );
    require_keys_eq!(
        a.creator_wsol.key(),
        get_associated_token_address(&creator, &WSOL_MINT),
        Type262Error::WrongCreatorTokenAccount
    );

    let rent = Rent::get()?;
    let floor = rent.minimum_balance(0);
    let seeds: &[&[u8]] = &[
        CREATOR_SEED,
        args.domain_hash.as_ref(),
        &[ctx.bumps.creator],
    ];
    let signer = &[seeds];

    // Below rent-exempt, pump's collect succeeds but pays nothing; this also keeps every transfer
    // out of the PDA below leaving it exactly at the floor.
    top_up(
        &a.payer.to_account_info(),
        &a.creator.to_account_info(),
        &a.system_program,
    )?;

    // Bonding curve: creator_vault -> creator, in lamports.
    let vault = a.creator_vault.to_account_info();
    if vault.lamports() > rent.minimum_balance(vault.data_len()) {
        let metas = vec![
            AccountMeta::new(creator, false),
            AccountMeta::new(a.creator_wsol.key(), false),
            AccountMeta::new(creator_vault, false),
            AccountMeta::new(a.creator_vault_wsol.key(), false),
            AccountMeta::new_readonly(WSOL_MINT, false),
            AccountMeta::new_readonly(token::ID, false),
            AccountMeta::new_readonly(associated_token::ID, false),
            AccountMeta::new_readonly(system_program::ID, false),
            AccountMeta::new_readonly(PUMP_EVENT_AUTHORITY, false),
            AccountMeta::new_readonly(PUMP_PROGRAM_ID, false),
        ];
        invoke(
            &Instruction {
                program_id: PUMP_PROGRAM_ID,
                accounts: metas,
                data: COLLECT_CREATOR_FEE_V2_IX.to_vec(),
            },
            &[
                a.creator.to_account_info(),
                a.creator_wsol.to_account_info(),
                vault,
                a.creator_vault_wsol.to_account_info(),
                a.wsol_mint.to_account_info(),
                a.token_program.to_account_info(),
                a.associated_token_program.to_account_info(),
                a.system_program.to_account_info(),
                a.pump_event_authority.to_account_info(),
                a.pump_program.to_account_info(),
            ],
        )?;
    }

    // PumpSwap: its vault's WSOL -> the creator's WSOL account, which must exist first.
    if token_amount(&a.amm_vault_wsol)?.unwrap_or(0) > 0 {
        associated_token::create_idempotent(CpiContext::new(
            a.associated_token_program.to_account_info(),
            associated_token::Create {
                payer: a.payer.to_account_info(),
                associated_token: a.creator_wsol.to_account_info(),
                authority: a.creator.to_account_info(),
                mint: a.wsol_mint.to_account_info(),
                system_program: a.system_program.to_account_info(),
                token_program: a.token_program.to_account_info(),
            },
        ))?;
        let metas = vec![
            AccountMeta::new_readonly(WSOL_MINT, false),
            AccountMeta::new_readonly(token::ID, false),
            AccountMeta::new_readonly(creator, false),
            AccountMeta::new_readonly(amm_vault, false),
            AccountMeta::new(a.amm_vault_wsol.key(), false),
            AccountMeta::new(a.creator_wsol.key(), false),
            AccountMeta::new_readonly(PUMP_AMM_EVENT_AUTHORITY, false),
            AccountMeta::new_readonly(PUMP_AMM_PROGRAM_ID, false),
        ];
        invoke(
            &Instruction {
                program_id: PUMP_AMM_PROGRAM_ID,
                accounts: metas,
                data: COLLECT_COIN_CREATOR_FEE_IX.to_vec(),
            },
            &[
                a.wsol_mint.to_account_info(),
                a.token_program.to_account_info(),
                a.creator.to_account_info(),
                a.amm_vault_authority.to_account_info(),
                a.amm_vault_wsol.to_account_info(),
                a.creator_wsol.to_account_info(),
                a.amm_event_authority.to_account_info(),
                a.amm_program.to_account_info(),
            ],
        )?;
    }

    // Unwrap: closing the WSOL account pays all its lamports to the PDA; its rent reserve goes back
    // to the caller (who created it, here or earlier in the transaction), the wrapped SOL stays.
    if let Some(amount) = token_amount(&a.creator_wsol)? {
        let lamports = a.creator_wsol.lamports();
        let reserve = {
            let data = a.creator_wsol.try_borrow_data()?;
            if data[TOKEN_IS_NATIVE..TOKEN_IS_NATIVE + 4] == [1, 0, 0, 0] {
                u64::from_le_bytes(
                    data[TOKEN_IS_NATIVE + 4..TOKEN_IS_NATIVE + 12]
                        .try_into()
                        .unwrap(),
                )
            } else {
                lamports.saturating_sub(amount)
            }
        };
        token::close_account(CpiContext::new_with_signer(
            a.token_program.to_account_info(),
            CloseAccount {
                account: a.creator_wsol.to_account_info(),
                destination: a.creator.to_account_info(),
                authority: a.creator.to_account_info(),
            },
            signer,
        ))?;
        let refund = reserve.min(lamports);
        if refund > 0 {
            system_program::transfer(
                CpiContext::new_with_signer(
                    a.system_program.to_account_info(),
                    Transfer {
                        from: a.creator.to_account_info(),
                        to: a.payer.to_account_info(),
                    },
                    signer,
                ),
                refund,
            )?;
        }
    }

    let amount = a.creator.lamports().saturating_sub(floor);
    require!(amount > 0, Type262Error::NothingToCollect);
    system_program::transfer(
        CpiContext::new_with_signer(
            a.system_program.to_account_info(),
            Transfer {
                from: a.creator.to_account_info(),
                to: a.pool.to_account_info(),
            },
            signer,
        ),
        amount,
    )?;

    let pool = &mut ctx.accounts.pool;
    open_pool(pool, &args.domain_hash, &SOL_MINT, ctx.bumps.pool);
    credit_fees(pool, amount)?;

    emit!(CreatorFeesCollected {
        domain_hash: args.domain_hash,
        amount,
    });
    Ok(())
}

/// The amount in an initialized SPL Token account, None if `account` isn't one (not created yet).
fn token_amount(account: &AccountInfo) -> Result<Option<u64>> {
    if *account.owner != token::ID {
        return Ok(None);
    }
    let data = account.try_borrow_data()?;
    if data.len() < TOKEN_ACCOUNT_LEN || data[TOKEN_STATE] == 0 {
        return Ok(None);
    }
    Ok(Some(u64::from_le_bytes(
        data[TOKEN_AMOUNT..TOKEN_AMOUNT + 8].try_into().unwrap(),
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::solana_program::hash::hash;

    fn disc(name: &str) -> [u8; 8] {
        hash(format!("global:{name}").as_bytes()).to_bytes()[..8]
            .try_into()
            .unwrap()
    }

    #[test]
    fn discriminators_match_their_names() {
        assert_eq!(CREATE_V2_IX, disc("create_v2"));
        assert_eq!(COLLECT_CREATOR_FEE_V2_IX, disc("collect_creator_fee_v2"));
        assert_eq!(
            COLLECT_COIN_CREATOR_FEE_IX,
            disc("collect_coin_creator_fee")
        );
    }

    #[test]
    fn event_authorities_are_the_pdas() {
        let pda = |p: &Pubkey| Pubkey::find_program_address(&[b"__event_authority"], p).0;
        assert_eq!(PUMP_EVENT_AUTHORITY, pda(&PUMP_PROGRAM_ID));
        assert_eq!(PUMP_AMM_EVENT_AUTHORITY, pda(&PUMP_AMM_PROGRAM_ID));
    }

    #[test]
    fn launched_curve_must_pay_our_creator_in_sol() {
        let creator = Pubkey::new_unique();
        let curve = |owner: Pubkey, edit: &dyn Fn(&mut Vec<u8>)| -> Result<()> {
            let key = Pubkey::new_unique();
            let mut lamports = 1u64;
            let mut data = vec![0u8; 150];
            data[CURVE_CREATOR..CURVE_CREATOR + 32].copy_from_slice(creator.as_ref());
            edit(&mut data);
            let info = AccountInfo::new(
                &key,
                false,
                false,
                &mut lamports,
                &mut data,
                &owner,
                false,
                0,
            );
            check_launched_curve(&info, &creator)
        };
        assert!(curve(PUMP_PROGRAM_ID, &|_| {}).is_ok());
        assert!(curve(PUMP_PROGRAM_ID, &|d| {
            d[CURVE_QUOTE_MINT..CURVE_QUOTE_MINT + 32].copy_from_slice(WSOL_MINT.as_ref())
        })
        .is_ok());
        for bad in [
            curve(Pubkey::new_unique(), &|_| {}),
            curve(PUMP_PROGRAM_ID, &|d| d[CURVE_CREATOR] ^= 1),
            curve(PUMP_PROGRAM_ID, &|d| d[CURVE_IS_HOLDER_REWARD] = 1),
            curve(PUMP_PROGRAM_ID, &|d| d[CURVE_IS_MAYHEM_MODE] = 1),
            curve(PUMP_PROGRAM_ID, &|d| d[CURVE_QUOTE_MINT] = 1),
            curve(PUMP_PROGRAM_ID, &|d| d.truncate(CURVE_IS_HOLDER_REWARD)),
        ] {
            assert_eq!(bad.unwrap_err(), Type262Error::BadLaunchedCurve.into());
        }
    }

    #[test]
    fn create_v2_data_layout() {
        let creator = Pubkey::new_unique();
        let d = create_v2_data("Example", "EX", "https://example.com/m.json", &creator);
        assert_eq!(d[..8], CREATE_V2_IX);
        assert_eq!(d[8..12], 7u32.to_le_bytes());
        assert_eq!(&d[12..19], b"Example");
        let tail = &d[d.len() - 43..];
        assert_eq!(&tail[..32], creator.as_ref());
        assert_eq!(tail[32..], [0u8; 11]);
    }
}
