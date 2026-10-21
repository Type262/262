//! The launcher against the mainnet pump.fun programs (tests/fixtures/pump): launch with an opening
//! buy, trades on the curve, collect into the domain's SOL pool, graduation and PumpSwap.

mod launcher_support;

use launcher_support::*;
use solana_keypair::Keypair;
use solana_signer::Signer;
use type262_tests::*;

const NAME: &str = "example.com";

/// Launch + the launcher's ATA + buy_v3 in one transaction, as the app sends it.
#[test]
fn launch_with_opening_buy() {
    let mut env = pump_env();
    let launcher = env.funded(100);
    let mint = Keypair::new();
    let args = LaunchArgs::new(NAME);
    let hash = args.domain_hash;
    let creator = env.creator_pda(&hash);
    let launch = launch_ix(&env, &launcher.pubkey(), &mint.pubkey(), &args);

    // Launch alone first in a dry run, for its own compute units.
    let ixs = [set_compute_limit(1_400_000), launch.clone()];
    let alone =
        env.svm
            .simulate_transaction(solana_transaction::Transaction::new_signed_with_payer(
                &ixs,
                Some(&launcher.pubkey()),
                &[&launcher, &mint],
                env.svm.latest_blockhash(),
            ));
    let alone = alone.expect("launch alone").meta;
    println!(
        "launch alone: {} CU for type262 (create_v2 included)",
        units(&alone, &env.program)
    );

    let ixs = [
        set_compute_limit(600_000),
        launch,
        create_ata_idempotent(
            &launcher.pubkey(),
            &launcher.pubkey(),
            &mint.pubkey(),
            &token_2022(),
        ),
        buy_v3(
            &mint.pubkey(),
            &launcher.pubkey(),
            100_000 * 1_000_000,
            SOL / 10,
        ),
    ];
    let size = legacy_size(&env, &ixs, &[&launcher, &mint]);
    let meta = env.send(&ixs, &[&launcher, &mint]).expect("launch + buy");
    println!(
        "launch + ATA + buy_v3: {} CU in total, legacy size {size} bytes",
        meta.compute_units_consumed
    );

    // pump wrote our PDA as the creator of a plain SOL coin.
    let c = curve(&env, &mint.pubkey());
    assert_eq!(c.creator, creator);
    assert!(!c.is_holder_reward && !c.is_mayhem_mode && !c.complete);
    assert!(c.quote_mint == Pubkey::default() || c.quote_mint == wsol());
    // The buy's creator fee waits on the curve until swept.
    assert!(c.creator_fee > 0);

    // The creator PDA holds exactly the rent-exempt minimum for no data, owned by the system.
    let pda = env.svm.get_account(&creator).unwrap();
    assert_eq!(pda.lamports, rent_min(&env, 0));
    assert_eq!(pda.owner, solana_sdk_ids::system_program::ID);
    assert!(pda.data.is_empty());

    let record: LaunchRecord = env.account(&env.launch_pda(&mint.pubkey())).unwrap();
    assert_eq!(
        record,
        LaunchRecord {
            domain_hash: hash,
            mint: mint.pubkey(),
            launcher: launcher.pubkey(),
            launched_at: env.now(),
            bump: Pubkey::find_program_address(
                &[seeds::LAUNCH, mint.pubkey().as_ref()],
                &env.program
            )
            .1,
        }
    );
    let domain: Domain = env.account(&env.domain_pda(&hash)).unwrap();
    assert_eq!(domain.domain_hash, hash);
    assert_eq!(domain.name, NAME);
    assert_eq!(domain.launches, 1);
    assert_eq!(domain.wallet, Pubkey::default());

    // The buyer got the tokens; mint and metadata authorities are gone (pump sets them to none).
    assert_eq!(
        token_balance(
            &env,
            &ata(&launcher.pubkey(), &mint.pubkey(), &token_2022())
        ),
        100_000 * 1_000_000
    );
    let m = data(&env, &mint.pubkey());
    assert_eq!(&m[..4], &[0, 0, 0, 0], "mint authority is none");

    // A second coin for the same domain shares the creator and bumps the count; the PDA is not
    // funded twice.
    let second = launch_with_buy(&mut env, &launcher, NAME, 0);
    assert_eq!(curve(&env, &second).creator, creator);
    assert_eq!(
        env.account::<Domain>(&env.domain_pda(&hash))
            .unwrap()
            .launches,
        2
    );
    assert_eq!(env.lamports(&creator), rent_min(&env, 0));
}

/// The same launch as a v0 transaction with a lookup table of the fixed accounts fits in 1,232
/// bytes; the legacy one does not.
#[test]
fn launch_fits_a_v0_transaction() {
    let mut env = pump_env();
    let launcher = env.funded(100);
    let mint = Keypair::new();
    let args = LaunchArgs::new("a-much-longer-domain-name-for-size.example");
    let ixs = [
        set_compute_limit(600_000),
        launch_ix(&env, &launcher.pubkey(), &mint.pubkey(), &args),
        create_ata_idempotent(
            &launcher.pubkey(),
            &launcher.pubkey(),
            &mint.pubkey(),
            &token_2022(),
        ),
        buy_v3(&mint.pubkey(), &launcher.pubkey(), 1_000_000_000, SOL / 10),
    ];
    let legacy = legacy_size(&env, &ixs, &[&launcher, &mint]);
    let program = env.program;
    let table = lookup_table(
        &mut env,
        vec![
            program,
            pump(),
            global(),
            mint_authority(),
            solana_sdk_ids::system_program::ID,
            token_2022(),
            token(),
            ata_program(),
            mayhem(),
            mayhem_global_params(),
            mayhem_sol_vault(),
            pump_event_authority(),
            pump_fee_config(),
            buyback(),
            wsol(),
            compute_budget_program(),
        ],
    );
    let (res, size) = send_v0(&mut env, &ixs, &[&launcher, &mint], &[table]);
    res.expect("v0 launch + buy");
    println!("launch + ATA + buy_v3: legacy {legacy} bytes, v0 with lookup table {size} bytes");
    assert!(legacy > 1232, "legacy {legacy}");
    assert!(size <= 1232, "v0 {size}");
    assert_eq!(
        curve(&env, &mint.pubkey()).creator,
        env.creator_pda(&args.domain_hash)
    );
}

/// Traders buy and sell on the curve; a sweep + collect moves exactly the creator fees into the
/// domain's SOL pool, as non-refundable income.
#[test]
fn trades_then_collect_into_the_pool() {
    let mut env = pump_env();
    env.initialize();
    let launcher = env.funded(100);
    let hash = domain_hash(NAME);
    let creator = env.creator_pda(&hash);
    let mint = launch_with_buy(&mut env, &launcher, NAME, 50_000 * 1_000_000);

    let trader = env.funded(50);
    buy(&mut env, &trader, &mint, 20_000_000 * 1_000_000, 5 * SOL).expect("buy");
    let held = token_balance(&env, &ata(&trader.pubkey(), &mint, &token_2022()));
    assert_eq!(held, 20_000_000 * 1_000_000);
    let ix = sell_v3(&mint, &trader.pubkey(), held / 2, 0);
    env.send(&[ix], &[&trader]).expect("sell");

    let fees = curve(&env, &mint).creator_fee;
    let volume_check = curve(&env, &mint);
    println!("creator fee waiting on the curve: {fees} lamports ({volume_check:?})");
    assert!(fees > 0);

    let pool = env.pool_pda(&hash, &SOL_MINT);
    let floor = rent_min(&env, 0);
    assert_eq!(env.lamports(&creator), floor);
    assert!(env.svm.get_account(&pool).is_none());

    // Anyone collects: a sweep for the coin, then collect, in one transaction.
    let keeper = env.funded(1);
    let ixs = [
        sweep_creator_fee(&keeper.pubkey(), &mint, &creator),
        collect_ix(&env, &keeper.pubkey(), &hash),
    ];
    let meta = env.send(&ixs, &[&keeper]).expect("sweep + collect");
    println!(
        "collect (bonding curve): {} CU for type262",
        units(&meta, &env.program)
    );

    let p: Pool = env.account(&pool).unwrap();
    assert_eq!(p.balance, fees);
    assert_eq!(p.domain_hash, hash);
    assert_eq!(p.mint, SOL_MINT);
    assert_eq!(p.epoch, 0);
    let pool_size = env.svm.get_account(&pool).unwrap().data.len();
    assert_eq!(env.lamports(&pool), rent_min(&env, pool_size) + fees);
    assert_eq!(env.lamports(&creator), floor);
    assert_eq!(curve(&env, &mint).creator_fee, 0);
    // pump keeps its vault rent-exempt; everything above went out.
    assert_eq!(env.lamports(&creator_vault(&creator)), rent_min(&env, 0));
    // No refundable deposit was recorded for the keeper.
    assert!(env
        .svm
        .get_account(&env.deposit_pda(&pool, &keeper.pubkey()))
        .is_none());

    // Nothing new: collect has nothing to move.
    let ixs = [collect_ix(&env, &keeper.pubkey(), &hash)];
    assert_launcher_err(env.send(&ixs, &[&keeper]), "NothingToCollect");

    // More trades, a second collect adds to the same pool.
    buy(&mut env, &trader, &mint, 1_000_000 * 1_000_000, SOL).expect("buy");
    let more = curve(&env, &mint).creator_fee;
    let ixs = [
        sweep_creator_fee(&keeper.pubkey(), &mint, &creator),
        collect_ix(&env, &keeper.pubkey(), &hash),
    ];
    env.send(&ixs, &[&keeper]).expect("second collect");
    assert_eq!(env.account::<Pool>(&pool).unwrap().balance, fees + more);
    assert_eq!(env.lamports(&pool), rent_min(&env, pool_size) + fees + more);
}

/// One collect covers every coin of a domain (one creator vault per creator), including a coin
/// someone created straight on pump.fun with the domain's PDA as creator.
#[test]
fn one_collect_covers_every_coin_of_the_domain() {
    let mut env = pump_env();
    let launcher = env.funded(100);
    let hash = domain_hash(NAME);
    let creator = env.creator_pda(&hash);
    let a = launch_with_buy(&mut env, &launcher, NAME, 1_000_000 * 1_000_000);
    let b = launch_with_buy(&mut env, &launcher, NAME, 2_000_000 * 1_000_000);

    // A coin made without type262, naming the PDA as creator: its fees are the domain's too.
    let outsider = env.funded(10);
    let c = Keypair::new();
    let ixs = [
        set_compute_limit(400_000),
        create_v2(&c.pubkey(), &outsider.pubkey(), &creator),
        create_ata_idempotent(
            &outsider.pubkey(),
            &outsider.pubkey(),
            &c.pubkey(),
            &token_2022(),
        ),
        buy_v3(&c.pubkey(), &outsider.pubkey(), 3_000_000 * 1_000_000, SOL),
    ];
    env.send(&ixs, &[&outsider, &c]).expect("direct create_v2");
    assert!(env.svm.get_account(&env.launch_pda(&c.pubkey())).is_none());

    let total: u64 = [a, b, c.pubkey()]
        .iter()
        .map(|m| curve(&env, m).creator_fee)
        .sum();
    let keeper = env.funded(1);
    let ixs = [
        sweep_creator_fee(&keeper.pubkey(), &a, &creator),
        sweep_creator_fee(&keeper.pubkey(), &b, &creator),
        sweep_creator_fee(&keeper.pubkey(), &c.pubkey(), &creator),
        collect_ix(&env, &keeper.pubkey(), &hash),
    ];
    env.send(&ixs, &[&keeper]).expect("collect three coins");
    let pool = env.pool_pda(&hash, &SOL_MINT);
    assert_eq!(env.account::<Pool>(&pool).unwrap().balance, total);
    assert_eq!(env.lamports(&creator), rent_min(&env, 0));
}

/// The full life of a coin: complete the curve, migrate to PumpSwap (anyone can), collect what
/// was left on the curve, trade on the pool, collect the PumpSwap creator fees (paid in WSOL,
/// unwrapped into the SOL pool).
#[test]
fn graduation_and_pumpswap_collect() {
    let mut env = pump_env();
    let launcher = env.funded(100);
    let hash = domain_hash(NAME);
    let creator = env.creator_pda(&hash);
    let floor = rent_min(&env, 0);
    let pool = env.pool_pda(&hash, &SOL_MINT);
    let mint = launch_with_buy(&mut env, &launcher, NAME, 0);

    // A whale buys more than the curve has left: the curve completes.
    let whale = env.funded(1_000);
    buy(&mut env, &whale, &mint, 900_000_000 * 1_000_000, 400 * SOL).expect("completing buy");
    let c = curve(&env, &mint);
    println!("completed curve: {c:?}");
    assert!(c.complete);
    assert_eq!(c.real_token_reserves, 0);
    let curve_fees = c.creator_fee;
    assert!(curve_fees > 0);

    // Curve trades now fail until migration.
    let trader = env.funded(50);
    assert!(buy(&mut env, &trader, &mint, 1_000_000, SOL).is_err());

    // Anyone migrates; the pool keeps our PDA as coin creator.
    let migrator = env.funded(50);
    let withdraw = withdraw_authority(&env);
    let ixs = [
        set_compute_limit(1_400_000),
        migrate_v2(&migrator.pubkey(), &mint, &withdraw),
    ];
    let meta = env.send(&ixs, &[&migrator]).expect("migrate_v2");
    println!("migrate_v2: {} CU", meta.compute_units_consumed);
    let p = amm_pool(&env, &mint);
    assert_eq!(p.coin_creator, creator);
    assert_eq!(p.base_mint, mint);
    assert_eq!(p.quote_mint, wsol());

    // What waited on the curve is still collectable after migration.
    let keeper = env.funded(1);
    let ixs = [
        sweep_creator_fee(&keeper.pubkey(), &mint, &creator),
        collect_ix(&env, &keeper.pubkey(), &hash),
    ];
    env.send(&ixs, &[&keeper])
        .expect("collect curve fees after migration");
    assert_eq!(env.account::<Pool>(&pool).unwrap().balance, curve_fees);

    // A PumpSwap buy, paid from the trader's WSOL account.
    let trader_wsol = ata(&trader.pubkey(), &wsol(), &token());
    let ixs = [
        create_ata_idempotent(&trader.pubkey(), &trader.pubkey(), &wsol(), &token()),
        transfer(&trader.pubkey(), &trader_wsol, 10 * SOL),
        sync_native(&trader_wsol),
        create_ata_idempotent(&trader.pubkey(), &trader.pubkey(), &mint, &token_2022()),
        amm_buy_v2(&mint, &trader.pubkey(), 1_000_000 * 1_000_000, 10 * SOL),
    ];
    env.send(&ixs, &[&trader]).expect("PumpSwap buy");
    assert_eq!(
        token_balance(&env, &ata(&trader.pubkey(), &mint, &token_2022())),
        1_000_000 * 1_000_000
    );
    let amm_fees = amm_pool(&env, &mint).creator_fees;
    println!("PumpSwap creator fees waiting in the pool: {amm_fees} lamports");
    assert!(amm_fees > 0);

    // Sweep the pool, then collect: PumpSwap pays WSOL into the PDA's WSOL account, which collect
    // creates, closes (rent back to the keeper) and moves into the domain's pool.
    let keeper_before = env.lamports(&keeper.pubkey());
    let amm_vault_wsol = ata(&amm_creator_vault(&creator), &wsol(), &token());
    let vault_ata_new = env.svm.get_account(&amm_vault_wsol).is_none();
    let ixs = [
        amm_sweep_creator_fee(&keeper.pubkey(), &mint, &creator),
        collect_ix(&env, &keeper.pubkey(), &hash),
    ];
    let meta = env
        .send(&ixs, &[&keeper])
        .expect("PumpSwap sweep + collect");
    println!(
        "collect (PumpSwap, creating and closing the WSOL account): {} CU for type262",
        units(&meta, &env.program)
    );
    assert_eq!(
        env.account::<Pool>(&pool).unwrap().balance,
        curve_fees + amm_fees
    );
    let pool_size = env.svm.get_account(&pool).unwrap().data.len();
    assert_eq!(
        env.lamports(&pool),
        rent_min(&env, pool_size) + curve_fees + amm_fees
    );
    assert_eq!(env.lamports(&creator), floor);
    assert!(
        env.svm
            .get_account(&ata(&creator, &wsol(), &token()))
            .map_or(true, |a| a.lamports == 0),
        "the PDA's WSOL account is closed"
    );
    assert_eq!(amm_pool(&env, &mint).creator_fees, 0);
    // The keeper paid the transaction fee and, if the sweep created it, the PumpSwap vault
    // account's rent; nothing for the PDA's WSOL account, whose rent came back when it closed.
    let vault_ata_rent = if vault_ata_new {
        rent_min(&env, 165)
    } else {
        0
    };
    assert_eq!(
        keeper_before - env.lamports(&keeper.pubkey()),
        5_000 + vault_ata_rent
    );

    // A second round on PumpSwap: the vault account exists now, the PDA's WSOL account is
    // created and closed again.
    let ixs = [
        create_ata_idempotent(&trader.pubkey(), &trader.pubkey(), &wsol(), &token()),
        transfer(&trader.pubkey(), &trader_wsol, 10 * SOL),
        sync_native(&trader_wsol),
        amm_buy_v2(&mint, &trader.pubkey(), 1_000_000 * 1_000_000, 10 * SOL),
    ];
    env.send(&ixs, &[&trader]).expect("second PumpSwap buy");
    let more = amm_pool(&env, &mint).creator_fees;
    let ixs = [
        amm_sweep_creator_fee(&keeper.pubkey(), &mint, &creator),
        collect_ix(&env, &keeper.pubkey(), &hash),
    ];
    env.send(&ixs, &[&keeper]).expect("second PumpSwap collect");
    assert_eq!(
        env.account::<Pool>(&pool).unwrap().balance,
        curve_fees + amm_fees + more
    );
    assert_eq!(env.lamports(&creator), floor);
}
