//! The launcher refuses substituted accounts: nobody can point a launch or a collect at another
//! program, vault, pool or domain, and only canonical names launch.

mod launcher_support;

use borsh::BorshSerialize;
use launcher_support::*;
use solana_account::Account;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_signer::Signer;
use type262_tests::*;

const NAME: &str = "example.com";
const OTHER: &str = "other.example";

/// Anchor: an account that must exist doesn't; a Program<> account is the wrong program.
const ANCHOR_ACCOUNT_NOT_INITIALIZED: u32 = 3012;
const ANCHOR_INVALID_PROGRAM_ID: u32 = 3008;

fn launch_tx(
    env: &mut Env,
    launcher: &Keypair,
    mint: &Keypair,
    ix: Instruction,
    extra: &[&Keypair],
) -> TxResult {
    let mut signers = vec![launcher, mint];
    signers.extend_from_slice(extra);
    env.send(&[set_compute_limit(600_000), ix], &signers)
}

#[test]
fn launch_rejects_a_substituted_pump_program() {
    let mut env = pump_env();
    let launcher = env.funded(100);
    let mint = Keypair::new();
    let args = LaunchArgs::new(NAME);

    // The named pump program.
    let mut ix = launch_ix(&env, &launcher.pubkey(), &mint.pubkey(), &args);
    ix.accounts[5].pubkey = Pubkey::new_unique();
    assert_launcher_err(
        launch_tx(&mut env, &launcher, &mint, ix, &[]),
        "WrongPumpProgram",
    );

    // The token program pump would use: pump itself refuses it.
    let mut ix = launch_ix(&env, &launcher.pubkey(), &mint.pubkey(), &args);
    ix.accounts[7 + 7].pubkey = token();
    assert!(launch_tx(&mut env, &launcher, &mint, ix, &[]).is_err());

    // The `program` account at the end of create_v2's list: the CPI still goes to pump (the id is
    // compiled in), which refuses the stranger.
    let mut ix = launch_ix(&env, &launcher.pubkey(), &mint.pubkey(), &args);
    ix.accounts[7 + 15].pubkey = env.program;
    assert!(launch_tx(&mut env, &launcher, &mint, ix, &[]).is_err());

    assert!(env
        .svm
        .get_account(&bonding_curve(&mint.pubkey()))
        .is_none());
    assert!(env
        .svm
        .get_account(&env.launch_pda(&mint.pubkey()))
        .is_none());
}

#[test]
fn launch_checks_the_create_v2_accounts() {
    let mut env = pump_env();
    let launcher = env.funded(100);
    let mint = Keypair::new();
    let args = LaunchArgs::new(NAME);
    let stranger = env.funded(10);

    // create_v2's mint is another signer's.
    let other_mint = Keypair::new();
    let mut ix = launch_ix(&env, &launcher.pubkey(), &mint.pubkey(), &args);
    ix.accounts[7].pubkey = other_mint.pubkey();
    assert_launcher_err(
        launch_tx(&mut env, &launcher, &mint, ix, &[&other_mint]),
        "WrongCoinMint",
    );

    // create_v2's user (who pays and is recorded) is not the launcher.
    let mut ix = launch_ix(&env, &launcher.pubkey(), &mint.pubkey(), &args);
    ix.accounts[7 + 5].pubkey = stranger.pubkey();
    assert_launcher_err(
        launch_tx(&mut env, &launcher, &mint, ix, &[&stranger]),
        "WrongCoinLauncher",
    );

    // Another coin's bonding curve.
    let mut ix = launch_ix(&env, &launcher.pubkey(), &mint.pubkey(), &args);
    ix.accounts[7 + 2].pubkey = bonding_curve(&other_mint.pubkey());
    assert_launcher_err(
        launch_tx(&mut env, &launcher, &mint, ix, &[]),
        "WrongBondingCurve",
    );

    // Too few accounts to be a create_v2.
    let mut ix = launch_ix(&env, &launcher.pubkey(), &mint.pubkey(), &args);
    ix.accounts.truncate(7 + 5);
    assert_launcher_err(
        launch_tx(&mut env, &launcher, &mint, ix, &[]),
        "MissingPumpAccounts",
    );

    // The launch record is per mint: the same mint can't launch twice.
    let ix = launch_ix(&env, &launcher.pubkey(), &mint.pubkey(), &args);
    launch_tx(&mut env, &launcher, &mint, ix, &[]).expect("launch");
    let ix = launch_ix(&env, &launcher.pubkey(), &mint.pubkey(), &args);
    assert!(launch_tx(&mut env, &launcher, &mint, ix, &[]).is_err());
    assert_eq!(
        env.account::<Domain>(&env.domain_pda(&args.domain_hash))
            .unwrap()
            .launches,
        1
    );
}

#[test]
fn launch_takes_only_canonical_names() {
    let mut env = pump_env();
    let launcher = env.funded(100);
    let long_label = format!("{}.com", "a".repeat(64));
    let too_long = format!("{}.com", vec!["a".repeat(63); 4].join("."));
    for bad in [
        "Example.com",
        "example.com.",
        ".example.com",
        "exa mple.com",
        "example..com",
        "bücher.example",
        long_label.as_str(),
        too_long.as_str(),
    ] {
        let mint = Keypair::new();
        let mut args = LaunchArgs::new(NAME);
        args.name = bad.to_string();
        args.domain_hash = sha256(bad.as_bytes());
        let ix = launch_ix(&env, &launcher.pubkey(), &mint.pubkey(), &args);
        assert_err(launch_tx(&mut env, &launcher, &mint, ix, &[]), "BadDomain");
    }

    // A canonical name with someone else's hash.
    let mint = Keypair::new();
    let mut args = LaunchArgs::new(NAME);
    args.domain_hash = domain_hash(OTHER);
    let ix = launch_ix(&env, &launcher.pubkey(), &mint.pubkey(), &args);
    assert_err(
        launch_tx(&mut env, &launcher, &mint, ix, &[]),
        "DomainHashMismatch",
    );

    // Punycode IDNs and '_' are canonical.
    for good in ["xn--bcher-kva.example", "my_site.example"] {
        let mint = launch_with_buy(&mut env, &launcher, good, 0);
        assert_eq!(
            curve(&env, &mint).creator,
            env.creator_pda(&domain_hash(good))
        );
    }
}

/// A domain whose coins have fees waiting: launched, traded, swept. Returns the mint and the fees.
fn traded(env: &mut Env, name: &str) -> (Pubkey, u64) {
    let launcher = env.funded(100);
    let mint = launch_with_buy(env, &launcher, name, 5_000_000 * 1_000_000);
    let keeper = env.funded(1);
    let creator = env.creator_pda(&domain_hash(name));
    let fees = curve(env, &mint).creator_fee;
    env.send(
        &[sweep_creator_fee(&keeper.pubkey(), &mint, &creator)],
        &[&keeper],
    )
    .expect("sweep");
    (mint, fees)
}

#[test]
fn collect_rejects_substituted_accounts() {
    let mut env = pump_env();
    let hash = domain_hash(NAME);
    let other = domain_hash(OTHER);
    let (_, fees) = traded(&mut env, NAME);
    let launcher = env.funded(10);
    launch_with_buy(&mut env, &launcher, OTHER, 0);
    let keeper = env.funded(10);
    let k = keeper.pubkey();
    let good = || CollectAccounts::new(&env, &k, &hash);
    let theirs = CollectAccounts::new(&env, &k, &other);
    let fake = Pubkey::new_unique();
    let usdc = pk("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

    let cases: Vec<(&str, CollectAccounts, u32)> = vec![
        (
            "pump program",
            CollectAccounts {
                pump_program: fake,
                ..good()
            },
            6300,
        ),
        (
            "PumpSwap program",
            CollectAccounts {
                amm_program: pump(),
                ..good()
            },
            6300,
        ),
        (
            "pump event authority",
            CollectAccounts {
                pump_event_authority: fake,
                ..good()
            },
            6306,
        ),
        (
            "PumpSwap event authority",
            CollectAccounts {
                amm_event_authority: pump_event_authority(),
                ..good()
            },
            6306,
        ),
        (
            "quote mint",
            CollectAccounts {
                wsol_mint: usdc,
                ..good()
            },
            6306,
        ),
        (
            "another domain's creator vault",
            CollectAccounts {
                creator_vault: theirs.creator_vault,
                ..good()
            },
            6307,
        ),
        (
            "creator vault's WSOL account",
            CollectAccounts {
                creator_vault_wsol: fake,
                ..good()
            },
            6307,
        ),
        (
            "another domain's PumpSwap vault",
            CollectAccounts {
                amm_vault_authority: theirs.amm_vault_authority,
                ..good()
            },
            6307,
        ),
        (
            "PumpSwap vault's WSOL account",
            CollectAccounts {
                amm_vault_wsol: theirs.amm_vault_wsol,
                ..good()
            },
            6307,
        ),
        (
            "the caller's own WSOL account",
            CollectAccounts {
                creator_wsol: ata(&k, &wsol(), &token()),
                ..good()
            },
            6308,
        ),
        (
            "token program",
            CollectAccounts {
                token_program: token_2022(),
                ..good()
            },
            ANCHOR_INVALID_PROGRAM_ID,
        ),
        (
            "another domain's pool",
            CollectAccounts {
                pool: theirs.pool,
                ..good()
            },
            ANCHOR_CONSTRAINT_SEEDS,
        ),
        (
            "a token pool of the domain",
            CollectAccounts {
                pool: env.pool_pda(&hash, &usdc),
                ..good()
            },
            ANCHOR_CONSTRAINT_SEEDS,
        ),
        (
            "another domain's creator",
            CollectAccounts {
                creator: theirs.creator,
                ..good()
            },
            ANCHOR_CONSTRAINT_SEEDS,
        ),
        (
            "another domain's account",
            CollectAccounts {
                domain: theirs.domain,
                ..good()
            },
            ANCHOR_CONSTRAINT_SEEDS,
        ),
    ];
    for (what, accounts, code) in cases {
        let ix = accounts.ix(&env, &hash);
        match env.send(&[ix], &[&keeper]) {
            Ok(_) => panic!("{what}: accepted"),
            Err(f) => assert_eq!(
                f.code(),
                Some(code),
                "{what}: {:?}\n{}",
                f.err,
                f.logs.join("\n")
            ),
        }
    }

    // Untouched by all that, the honest collect moves the fees.
    let pool = env.pool_pda(&hash, &SOL_MINT);
    env.send(&[collect_ix(&env, &k, &hash)], &[&keeper])
        .expect("collect");
    assert_eq!(env.account::<Pool>(&pool).unwrap().balance, fees);
    assert!(env.svm.get_account(&theirs.pool).is_none());
}

/// Collecting under another domain's hash never reaches this domain's fees.
#[test]
fn collect_for_another_domain_gets_nothing() {
    let mut env = pump_env();
    let hash = domain_hash(NAME);
    let other = domain_hash(OTHER);
    let (_, fees) = traded(&mut env, NAME);
    let launcher = env.funded(10);
    launch_with_buy(&mut env, &launcher, OTHER, 0);
    let attacker = env.funded(10);
    let a = attacker.pubkey();

    // Their own accounts: nothing to collect there.
    assert_launcher_err(
        env.send(&[collect_ix(&env, &a, &other)], &[&attacker]),
        "NothingToCollect",
    );
    // Their hash with our creator vault, or our creator: refused.
    let ours = CollectAccounts::new(&env, &a, &hash);
    let ix = CollectAccounts {
        creator_vault: ours.creator_vault,
        ..CollectAccounts::new(&env, &a, &other)
    }
    .ix(&env, &other);
    assert_launcher_err(env.send(&[ix], &[&attacker]), "WrongCreatorVault");
    let ix = CollectAccounts {
        creator: ours.creator,
        ..CollectAccounts::new(&env, &a, &other)
    }
    .ix(&env, &other);
    assert_code(env.send(&[ix], &[&attacker]), ANCHOR_CONSTRAINT_SEEDS);
    // Our accounts under their hash: refused.
    let ix = CollectAccounts::new(&env, &a, &hash).ix(&env, &other);
    assert_code(env.send(&[ix], &[&attacker]), ANCHOR_CONSTRAINT_SEEDS);
    // A hash with no domain behind it.
    let nobody = domain_hash("nobody.example");
    assert_code(
        env.send(&[collect_ix(&env, &a, &nobody)], &[&attacker]),
        ANCHOR_ACCOUNT_NOT_INITIALIZED,
    );

    assert!(env
        .svm
        .get_account(&env.pool_pda(&other, &SOL_MINT))
        .is_none());
    // Whoever collects, the fees land in this domain's pool.
    env.send(&[collect_ix(&env, &a, &hash)], &[&attacker])
        .expect("collect");
    assert_eq!(
        env.account::<Pool>(&env.pool_pda(&hash, &SOL_MINT))
            .unwrap()
            .balance,
        fees
    );
}

/// The domain account as the escrow leaves it after a deposit or a register, written directly.
#[derive(BorshSerialize)]
struct DomainData {
    domain_hash: [u8; 32],
    last_proof: i64,
    wallet: Pubkey,
    launches: u32,
    bump: u8,
    name: String,
}

/// A coin made straight on pump.fun for a domain that never launched through type262: its creator
/// PDA was never funded. collect tops it up to rent-exempt first, or pump would pay it nothing.
#[test]
fn collect_funds_a_creator_that_was_never_funded() {
    let mut env = pump_env();
    let hash = domain_hash(NAME);
    let creator = env.creator_pda(&hash);
    let floor = rent_min(&env, 0);

    let (domain, bump) =
        Pubkey::find_program_address(&[seeds::DOMAIN, hash.as_ref()], &env.program);
    let mut data = discriminator("account", "Domain").to_vec();
    DomainData {
        domain_hash: hash,
        last_proof: 0,
        wallet: Pubkey::default(),
        launches: 0,
        bump,
        name: NAME.to_string(),
    }
    .serialize(&mut data)
    .unwrap();
    data.resize(8 + 32 + 8 + 32 + 4 + 1 + 4 + 253, 0);
    let lamports = rent_min(&env, data.len());
    env.svm
        .set_account(
            domain,
            Account {
                lamports,
                data,
                owner: env.program,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();

    let outsider = env.funded(10);
    let mint = Keypair::new();
    let ixs = [
        set_compute_limit(400_000),
        create_v2(&mint.pubkey(), &outsider.pubkey(), &creator),
        create_ata_idempotent(
            &outsider.pubkey(),
            &outsider.pubkey(),
            &mint.pubkey(),
            &token_2022(),
        ),
        buy_v3(
            &mint.pubkey(),
            &outsider.pubkey(),
            10_000_000 * 1_000_000,
            2 * SOL,
        ),
    ];
    env.send(&ixs, &[&outsider, &mint])
        .expect("direct create_v2");
    assert_eq!(env.lamports(&creator), 0);
    let fees = curve(&env, &mint.pubkey()).creator_fee;

    let keeper = env.funded(1);
    let before = env.lamports(&keeper.pubkey());
    let ixs = [
        sweep_creator_fee(&keeper.pubkey(), &mint.pubkey(), &creator),
        collect_ix(&env, &keeper.pubkey(), &hash),
    ];
    env.send(&ixs, &[&keeper]).expect("collect");
    let pool = env.pool_pda(&hash, &SOL_MINT);
    assert_eq!(env.account::<Pool>(&pool).unwrap().balance, fees);
    assert_eq!(env.lamports(&creator), floor);
    let pool_rent = rent_min(&env, env.svm.get_account(&pool).unwrap().data.len());
    let vault_rent = rent_min(&env, 0);
    // The keeper paid: the fee, the pool's rent, the PDA's floor, and the creator vault's rent
    // (the sweep created it).
    assert_eq!(
        before - env.lamports(&keeper.pubkey()),
        5_000 + pool_rent + floor + vault_rent
    );
}
