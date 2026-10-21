//! Security review of `collect` against the mainnet pump.fun programs: a griefer with throwaway
//! keys tries to block a domain's collect for good, or to skim what it moves.

mod launcher_support;

use launcher_support::*;
use solana_signer::Signer;
use type262_tests::*;

const NAME: &str = "example.com";

/// HELD. Dust in the PumpSwap creator vault before the coin ever graduated (it forces collect
/// through PumpSwap's collect), a pre-made WSOL account for the PDA holding unsynced lamports, and
/// lamports sent straight to the PDA and to pump's creator vault: collect still runs, the domain's
/// pool gets the fees plus every donation, and the PDA ends at its floor. The only thing that moves
/// to a caller is the WSOL account's rent reserve (the documented bounty), never fees.
#[test]
fn dust_and_donations_cannot_block_or_skim_collect() {
    let mut env = pump_env();
    let hash = domain_hash(NAME);
    let creator = env.creator_pda(&hash);
    let floor = rent_min(&env, 0);
    let launcher = env.funded(100);
    let mint = launch_with_buy(&mut env, &launcher, NAME, 5_000_000 * 1_000_000);
    let fees = curve(&env, &mint).creator_fee;
    assert!(fees > 0);

    let griefer = env.funded(10);
    let g = griefer.pubkey();
    let amm_vault = amm_creator_vault(&creator);
    let amm_vault_wsol = ata(&amm_vault, &wsol(), &token());
    let creator_wsol = ata(&creator, &wsol(), &token());
    let vault = creator_vault(&creator);
    assert!(env.svm.get_account(&amm_vault_wsol).is_none());
    let ixs = [
        create_ata_idempotent(&g, &amm_vault, &wsol(), &token()),
        transfer(&g, &amm_vault_wsol, 1_000),
        sync_native(&amm_vault_wsol),
        create_ata_idempotent(&g, &creator, &wsol(), &token()),
        transfer(&g, &creator_wsol, 777),
        transfer(&g, &creator, 555),
        // pump's creator vault doesn't exist before the first sweep, so it needs its rent.
        transfer(&g, &vault, floor + 333),
    ];
    env.send(&ixs, &[&griefer]).expect("griefing setup");
    assert_eq!(token_balance(&env, &amm_vault_wsol), 1_000);
    let reserve = env.lamports(&creator_wsol) - 777;

    let keeper = env.funded(1);
    let k0 = env.lamports(&keeper.pubkey());
    let ixs = [
        sweep_creator_fee(&keeper.pubkey(), &mint, &creator),
        collect_ix(&env, &keeper.pubkey(), &hash),
    ];
    env.send(&ixs, &[&keeper])
        .expect("collect despite the dust");
    let pool = env.pool_pda(&hash, &SOL_MINT);
    assert_eq!(
        env.account::<Pool>(&pool).unwrap().balance,
        fees + 1_000 + 777 + 555 + 333
    );
    assert_eq!(env.lamports(&creator), floor);
    assert_eq!(token_balance(&env, &amm_vault_wsol), 0);
    assert!(env
        .svm
        .get_account(&creator_wsol)
        .map_or(true, |a| a.lamports == 0));
    let pool_rent = rent_min(&env, env.svm.get_account(&pool).unwrap().data.len());
    assert_eq!(
        env.lamports(&keeper.pubkey()),
        k0 - 5_000 - pool_rent + reserve
    );

    // Dust again, now that the PumpSwap vault account exists: a bare collect moves it too.
    let ixs = [
        transfer(&g, &amm_vault_wsol, 2_000),
        sync_native(&amm_vault_wsol),
    ];
    env.send(&ixs, &[&griefer]).expect("more dust");
    env.send(&[collect_ix(&env, &keeper.pubkey(), &hash)], &[&keeper])
        .expect("bare collect");
    assert_eq!(
        env.account::<Pool>(&pool).unwrap().balance,
        fees + 1_000 + 777 + 555 + 333 + 2_000
    );
    assert_launcher_err(
        env.send(&[collect_ix(&env, &keeper.pubkey(), &hash)], &[&keeper]),
        "NothingToCollect",
    );
}

/// HELD. A griefer who pre-creates the PDA's WSOL account and then collects himself gets back
/// only the rent he paid for it; the PumpSwap fees and the bonding-curve fees all reach the pool.
#[test]
fn the_wsol_bounty_is_only_the_reserve() {
    let mut env = pump_env();
    let hash = domain_hash(NAME);
    let creator = env.creator_pda(&hash);
    let launcher = env.funded(100);
    let mint = launch_with_buy(&mut env, &launcher, NAME, 5_000_000 * 1_000_000);
    let keeper = env.funded(1);
    env.send(
        &[
            sweep_creator_fee(&keeper.pubkey(), &mint, &creator),
            collect_ix(&env, &keeper.pubkey(), &hash),
        ],
        &[&keeper],
    )
    .expect("first collect creates the pool");
    let pool = env.pool_pda(&hash, &SOL_MINT);
    let b0 = env.account::<Pool>(&pool).unwrap().balance;

    let griefer = env.funded(10);
    let g = griefer.pubkey();
    let creator_wsol = ata(&creator, &wsol(), &token());
    let amm_vault_wsol = ata(&amm_creator_vault(&creator), &wsol(), &token());
    env.send(
        &[
            create_ata_idempotent(&g, &creator, &wsol(), &token()),
            create_ata_idempotent(&g, &amm_creator_vault(&creator), &wsol(), &token()),
            transfer(&g, &amm_vault_wsol, 50_000),
            sync_native(&amm_vault_wsol),
        ],
        &[&griefer],
    )
    .expect("setup");
    let reserve = env.lamports(&creator_wsol);
    let g0 = env.lamports(&g);
    env.send(&[collect_ix(&env, &g, &hash)], &[&griefer])
        .expect("griefer collects");
    // He recovers the WSOL account's reserve, minus the fee; the 50,000 he put in went to the pool.
    assert_eq!(env.lamports(&g), g0 - 5_000 + reserve);
    assert_eq!(env.account::<Pool>(&pool).unwrap().balance, b0 + 50_000);
}
