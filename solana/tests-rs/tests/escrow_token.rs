//! The escrow with SPL Token and Token-2022 mints: deposits, claims to the wallet's associated
//! token account, fees, refunds, transfer-fee mints counted exactly, refused extensions, and
//! token accounts swapped for someone else's.

mod escrow_util;

use escrow_util::*;
use solana_keypair::Keypair;
use solana_signer::Signer;
use type262_tests::*;

const NAME: &str = "example.com";

/// Deposits by several senders, a relayed claim, the fee withdrawal and refunds, counted to the
/// base unit and the lamport, for a mint owned by `program` with `extensions`.
fn full_flow(program: Pubkey, extensions: &[(u16, Vec<u8>)], label: &str) {
    let (mut env, fee_recipient) = setup();
    let (t, auth) = create_mint(&mut env, program, 6, extensions);
    let h = domain_hash(NAME);
    let pool = env.pool_pda(&h, &t.mint);
    let vault = ata(&pool, &t.mint, &t.program);
    let alice = env.funded(10);
    let bob = env.funded(10);
    let carol = env.funded(10);
    let alice_ta = mint_to(&mut env, t, &auth, &alice.pubkey(), 10_000_000);
    let bob_ta = mint_to(&mut env, t, &auth, &bob.pubkey(), 10_000_000);
    mint_to(&mut env, t, &auth, &carol.pubkey(), 10_000_000);

    // The first deposit opens the domain, the pool, the deposit record and the vault.
    let a0 = env.lamports(&alice.pubkey());
    let meta = env.deposit_token(&alice, NAME, t, 1_000_000).unwrap();
    println!(
        "CU deposit_token {label} (first, creates 4 accounts): {}",
        meta.compute_units_consumed
    );
    let alice_dep = env.deposit_pda(&pool, &alice.pubkey());
    assert_eq!(
        a0 - env.lamports(&alice.pubkey()),
        env.rent(&env.domain_pda(&h))
            + env.rent(&pool)
            + env.rent(&alice_dep)
            + env.rent(&vault)
            + TX_FEE
    );
    let meta = env.deposit_token(&alice, NAME, t, 1_000_000).unwrap();
    println!(
        "CU deposit_token {label} (again): {}",
        meta.compute_units_consumed
    );
    env.deposit_token(&bob, NAME, t, 2_500_000).unwrap();
    env.deposit_token(&carol, NAME, t, 333).unwrap();
    let balance = 4_500_333;
    assert_eq!(token_balance(&env, &vault), balance);
    assert_eq!(token_balance(&env, &alice_ta), 8_000_000);
    assert_eq!(token_balance(&env, &bob_ta), 7_500_000);
    let p = env.pool(NAME, &t.mint).unwrap();
    assert_eq!(
        (p.domain_hash, p.mint, p.balance, p.epoch),
        (h, t.mint, balance, 0)
    );
    // A token pool holds no lamports beyond its rent.
    assert_eq!(env.lamports(&pool), env.rent(&pool));
    let d = env.deposit_of(NAME, &t.mint, &alice.pubkey()).unwrap();
    assert_eq!((d.amount, d.epoch), (2_000_000, 0));

    // Refund before and after the delay; a SOL pool of the same domain is a different pool.
    assert_err(env.refund(&carol, NAME, Some(t)), "RefundLocked");
    assert_code(
        env.refund(&carol, NAME, None),
        ANCHOR_ACCOUNT_NOT_INITIALIZED,
    );
    env.warp(REFUND_DELAY);
    let c0 = env.lamports(&carol.pubkey());
    let carol_dep = env.deposit_pda(&pool, &carol.pubkey());
    let dep_rent = env.rent(&carol_dep);
    let meta = env.refund(&carol, NAME, Some(t)).unwrap();
    println!("CU refund {label}: {}", meta.compute_units_consumed);
    assert_eq!(
        token_balance(&env, &ata(&carol.pubkey(), &t.mint, &t.program)),
        10_000_000
    );
    assert_eq!(env.lamports(&carol.pubkey()), c0 + dep_rent - TX_FEE);
    assert!(!account_exists(&env, &carol_dep));
    let balance = balance - 333;
    assert_eq!(token_balance(&env, &vault), balance);
    assert_eq!(env.pool(NAME, &t.mint).unwrap().balance, balance);

    // A relayed claim pays the wallet's associated token account, created at the relayer's cost.
    let wallet = Pubkey::new_unique();
    let rec = record_for(&mut env, NAME, &wallet);
    let relayer = env.funded(10);
    let r0 = env.lamports(&relayer.pubkey());
    let meta = env.claim(&relayer, NAME, &wallet, &rec, Some(t)).unwrap();
    println!(
        "CU claim {label} (creates the fee vault and two token accounts): {}",
        meta.compute_units_consumed
    );
    let fee = balance * 50 / 10_000;
    let fee_vault = env.fees_pda(&t.mint);
    let fee_ta = ata(&fee_vault, &t.mint, &t.program);
    let wallet_ta = ata(&wallet, &t.mint, &t.program);
    assert_eq!(token_balance(&env, &wallet_ta), balance - fee);
    assert_eq!(token_balance(&env, &fee_ta), fee);
    assert_eq!(token_balance(&env, &vault), 0);
    assert_eq!(
        r0 - env.lamports(&relayer.pubkey()),
        env.rent(&fee_vault) + env.rent(&fee_ta) + env.rent(&wallet_ta) + TX_FEE
    );
    let fv = env.fee_vault(&t.mint).unwrap();
    assert_eq!((fv.mint, fv.owed), (t.mint, fee));
    let p = env.pool(NAME, &t.mint).unwrap();
    assert_eq!((p.balance, p.epoch), (0, 1));
    assert_eq!(env.domain(NAME).unwrap().wallet, wallet);
    // Bob's deposit went out with the claim.
    assert_err(env.refund(&bob, NAME, Some(t)), "NothingToRefund");

    // Again, with every account already there; then an empty pool pays nothing.
    env.deposit_token(&bob, NAME, t, 1_000_000).unwrap();
    let r0 = env.lamports(&relayer.pubkey());
    let meta = env.claim(&relayer, NAME, &wallet, &rec, Some(t)).unwrap();
    println!(
        "CU claim {label} (accounts exist): {}",
        meta.compute_units_consumed
    );
    assert_eq!(env.lamports(&relayer.pubkey()), r0 - TX_FEE);
    assert_eq!(token_balance(&env, &wallet_ta), balance - fee + 995_000);
    let owed = fee + 5_000;
    assert_eq!(env.fee_vault(&t.mint).unwrap().owed, owed);
    env.claim(&relayer, NAME, &wallet, &rec, Some(t)).unwrap();
    assert_eq!(token_balance(&env, &wallet_ta), balance - fee + 995_000);

    // Fees to the recipient's associated token account, created by whoever withdraws.
    let anyone = env.funded(1);
    let meta = env.withdraw_fees(&anyone, Some(t)).unwrap();
    println!(
        "CU withdraw_fees {label} (creates the recipient's account): {}",
        meta.compute_units_consumed
    );
    let recipient_ta = ata(&fee_recipient, &t.mint, &t.program);
    assert_eq!(token_balance(&env, &recipient_ta), owed);
    assert_eq!(token_balance(&env, &fee_ta), 0);
    assert_eq!(env.fee_vault(&t.mint).unwrap().owed, 0);
    assert_err(env.withdraw_fees(&anyone, Some(t)), "ZeroAmount");
}

#[test]
fn spl_token_full_flow() {
    full_flow(TOKEN, &[], "SPL Token");
}

#[test]
fn token_2022_full_flow() {
    full_flow(TOKEN_2022, &[], "Token-2022");
}

#[test]
fn token_2022_with_metadata_full_flow() {
    // pump.fun coins: Token-2022 with a metadata pointer (and the metadata itself) in the mint.
    let authority = Pubkey::new_unique();
    full_flow(
        TOKEN_2022,
        &[metadata_pointer_ext(&authority)],
        "Token-2022 + metadata",
    );
}

#[test]
fn a_transfer_fee_is_counted_exactly() {
    let (mut env, fee_recipient) = setup();
    // 1% on every transfer, up to a large maximum.
    let (t, auth) = create_mint(
        &mut env,
        TOKEN_2022,
        6,
        &[transfer_fee_ext(100, 1_000_000_000)],
    );
    let tf = |amount: u64| (amount * 100).div_ceil(10_000);
    let h = domain_hash(NAME);
    let pool = env.pool_pda(&h, &t.mint);
    let vault = ata(&pool, &t.mint, &t.program);
    let alice = env.funded(10);
    let bob = env.funded(10);
    mint_to(&mut env, t, &auth, &alice.pubkey(), 1_000_000);
    let bob_ta = mint_to(&mut env, t, &auth, &bob.pubkey(), 1_000_000);

    // The pool is credited what the vault received, as DomainEscrow does with balanceOf.
    let meta = env.deposit_token(&alice, NAME, t, 100_000).unwrap();
    println!(
        "CU deposit_token transfer-fee mint (first): {}",
        meta.compute_units_consumed
    );
    env.deposit_token(&bob, NAME, t, 10_000).unwrap();
    let credited = 100_000 - tf(100_000) + 10_000 - tf(10_000);
    assert_eq!(credited, 108_900);
    assert_eq!(token_balance(&env, &vault), credited);
    assert_eq!(env.pool(NAME, &t.mint).unwrap().balance, credited);
    assert_eq!(
        env.deposit_of(NAME, &t.mint, &bob.pubkey()).unwrap().amount,
        9_900
    );

    // A refund sends back exactly what was credited (the token takes its fee on the way).
    env.warp(REFUND_DELAY);
    env.refund(&bob, NAME, Some(t)).unwrap();
    assert_eq!(token_balance(&env, &bob_ta), 990_000 + 9_900 - tf(9_900));
    let balance = credited - 9_900;
    assert_eq!(token_balance(&env, &vault), balance);
    assert_eq!(env.pool(NAME, &t.mint).unwrap().balance, balance);

    // The claim: the pool's books and its vault both go to zero; owed is what the fee vault got.
    let wallet = Pubkey::new_unique();
    let rec = record_for(&mut env, NAME, &wallet);
    let relayer = env.funded(10);
    let meta = env.claim(&relayer, NAME, &wallet, &rec, Some(t)).unwrap();
    println!(
        "CU claim transfer-fee mint (creates accounts): {}",
        meta.compute_units_consumed
    );
    let fee = balance * 50 / 10_000;
    let payout = balance - fee;
    assert_eq!(token_balance(&env, &vault), 0);
    assert_eq!(env.pool(NAME, &t.mint).unwrap().balance, 0);
    assert_eq!(
        token_balance(&env, &ata(&wallet, &t.mint, &t.program)),
        payout - tf(payout)
    );
    let fee_ta = ata(&env.fees_pda(&t.mint), &t.mint, &t.program);
    let owed = fee - tf(fee);
    assert_eq!(token_balance(&env, &fee_ta), owed);
    assert_eq!(env.fee_vault(&t.mint).unwrap().owed, owed);

    env.svm.airdrop(&fee_recipient, SOL).unwrap();
    let anyone = env.funded(1);
    env.withdraw_fees(&anyone, Some(t)).unwrap();
    assert_eq!(token_balance(&env, &fee_ta), 0);
    assert_eq!(
        token_balance(&env, &ata(&fee_recipient, &t.mint, &t.program)),
        owed - tf(owed)
    );
}

#[test]
fn mints_the_books_cannot_follow_are_refused() {
    let (mut env, _) = setup();
    let alice = env.funded(10);
    let mut hook = vec![0u8; 64];
    hook[32..].copy_from_slice(Pubkey::new_unique().as_ref());
    for (label, ext) in [
        (
            "permanent delegate",
            (12u16, Pubkey::new_unique().as_ref().to_vec()),
        ),
        ("transfer hook program", (14, hook)),
        ("non-transferable", (9, vec![])),
    ] {
        let (t, auth) = create_mint(&mut env, TOKEN_2022, 6, &[ext]);
        mint_to(&mut env, t, &auth, &alice.pubkey(), 1_000);
        let res = env.deposit_token(&alice, NAME, t, 1_000);
        match res {
            Err(f) if f.code() == Some(err_code("UnsupportedMint")) => {}
            other => panic!("{label}: expected UnsupportedMint, got {other:?}"),
        }
    }
    // A transfer hook extension with no program set changes nothing.
    let (t, auth) = create_mint(&mut env, TOKEN_2022, 6, &[(14, vec![0u8; 64])]);
    mint_to(&mut env, t, &auth, &alice.pubkey(), 1_000);
    env.deposit_token(&alice, NAME, t, 1_000).unwrap();
}

#[test]
fn deposits_pause_for_tokens_too() {
    let (mut env, _) = setup();
    let admin = env.authority.insecure_clone();
    let (t, auth) = create_mint(&mut env, TOKEN, 6, &[]);
    let alice = env.funded(10);
    mint_to(&mut env, t, &auth, &alice.pubkey(), 1_000);
    env.deposit_token(&alice, NAME, t, 400).unwrap();
    env.set_deposits_paused(&admin, true).unwrap();
    assert_err(env.deposit_token(&alice, NAME, t, 100), "Paused");
    // Money already in can still leave.
    env.warp(REFUND_DELAY);
    env.refund(&alice, NAME, Some(t)).unwrap();
    assert_eq!(
        token_balance(&env, &ata(&alice.pubkey(), &t.mint, &t.program)),
        1_000
    );
    env.set_deposits_paused(&admin, false).unwrap();
    env.deposit_token(&alice, NAME, t, 100).unwrap();
    assert_err(env.deposit_token(&alice, NAME, t, 0), "ZeroAmount");
}

#[test]
fn token_accounts_cannot_be_swapped() {
    let (mut env, _) = setup();
    let (t, auth) = create_mint(&mut env, TOKEN, 6, &[]);
    let (t2, auth2) = create_mint(&mut env, TOKEN, 6, &[]);
    let (t22, auth22) = create_mint(&mut env, TOKEN_2022, 6, &[]);
    let a = "alice.com";
    let b = "bob.com";
    let payer = env.funded(10);
    let thief = env.funded(10);
    let th = thief.pubkey();
    mint_to(&mut env, t, &auth, &payer.pubkey(), 1_000_000);
    mint_to(&mut env, t2, &auth2, &payer.pubkey(), 1_000_000);
    mint_to(&mut env, t22, &auth22, &payer.pubkey(), 1_000_000);
    let thief_ta = mint_to(&mut env, t, &auth, &th, 1);
    env.deposit_token(&payer, a, t, 100_000).unwrap();
    env.deposit_token(&payer, a, t2, 200_000).unwrap();
    env.deposit_token(&payer, b, t, 300_000).unwrap();
    env.deposit_token(&payer, a, t22, 50_000).unwrap();
    let wallet = Pubkey::new_unique();
    let rec = record_for(&mut env, a, &wallet);
    let b_pool = env.pool_pda(&domain_hash(b), &t.mint);
    let claim = |env: &Env| env.claim_ix(&th, a, &wallet, &rec, &t.mint, Some(t));

    // Account order in claim: 8 mint, 9 pool vault, 10 wallet token, 11 fee vault token,
    // 12 token program, 13 associated token program.
    let a_vault_t2 = ata(&env.pool_pda(&domain_hash(a), &t2.mint), &t2.mint, &TOKEN);
    let b_vault = ata(&b_pool, &t.mint, &TOKEN);
    let cases: Vec<(&str, usize, Pubkey, &str)> = vec![
        ("another mint", 8, t2.mint, "WrongMint"),
        ("another domain's vault", 9, b_vault, "WrongTokenAccount"),
        ("another mint's vault", 9, a_vault_t2, "WrongTokenAccount"),
        (
            "the thief's account as the wallet's",
            10,
            thief_ta,
            "WrongTokenAccount",
        ),
        (
            "the thief's account as the fee vault's",
            11,
            thief_ta,
            "WrongTokenAccount",
        ),
        (
            "the other token program",
            12,
            TOKEN_2022,
            "WrongTokenAccount",
        ),
    ];
    for (label, index, key, error) in cases {
        let ix = swap(claim(&env), index, w(key));
        match env.send(&[ix], &[&thief]) {
            Err(f) if f.code() == Some(err_code(error)) => {}
            other => panic!("{label}: expected {error}, got {other:?}"),
        }
    }
    // A token pool claimed without its token accounts, or the SOL pool with them.
    let ix = env.claim_ix(&th, a, &wallet, &rec, &t.mint, None);
    assert_err(env.send(&[ix], &[&thief]), "WrongMint");
    env.deposit_sol(&payer, a, SOL).unwrap();
    let mut ix = env.claim_ix(&th, a, &wallet, &rec, &SOL_MINT, None);
    let real = claim(&env);
    ix.accounts[8..14].clone_from_slice(&real.accounts[8..14]);
    assert_err(env.send(&[ix], &[&thief]), "WrongMint");

    // Refunds only to the depositor's own token account, only from the pool's vault.
    env.warp(REFUND_DELAY);
    let rec = record_for(&mut env, a, &wallet);
    let ix = env.refund_ix(&payer.pubkey(), a, Some(t));
    assert_err(
        env.send(&[swap(ix, 7, w(thief_ta))], &[&payer]),
        "WrongTokenAccount",
    );
    let ix = env.refund_ix(&payer.pubkey(), a, Some(t));
    assert_err(
        env.send(&[swap(ix, 6, w(b_vault))], &[&payer]),
        "WrongTokenAccount",
    );
    let ix = env.refund_ix(&payer.pubkey(), a, Some(t));
    assert_err(env.send(&[swap(ix, 5, r(t2.mint))], &[&payer]), "WrongMint");

    // Deposits only into the pool's own vault, only from the signer's account.
    let ix = env.deposit_token_ix(&payer.pubkey(), a, t, 10);
    assert!(env.send(&[swap(ix, 7, w(b_vault))], &[&payer]).is_err());
    let ix = env.deposit_token_ix(&payer.pubkey(), a, t, 10);
    assert!(env.send(&[swap(ix, 6, w(thief_ta))], &[&payer]).is_err());
    let ix = env.deposit_token_ix(&payer.pubkey(), a, t, 10);
    assert!(env.send(&[swap(ix, 8, r(TOKEN_2022))], &[&payer]).is_err());

    // Fees only to the recipient's associated token account.
    env.claim(&payer, a, &wallet, &rec, Some(t)).unwrap();
    let ix = env.withdraw_fees_ix(&th, Some(t));
    assert_err(
        env.send(&[swap(ix, 7, w(thief_ta))], &[&thief]),
        "WrongTokenAccount",
    );
    let ix = env.withdraw_fees_ix(&th, Some(t));
    assert_err(env.send(&[swap(ix, 5, r(t2.mint))], &[&thief]), "WrongMint");

    // Nothing moved but what was claimed.
    assert_eq!(token_balance(&env, &thief_ta), 1);
    assert_eq!(token_balance(&env, &b_vault), 300_000);
    assert_eq!(token_balance(&env, &a_vault_t2), 200_000);
    assert_eq!(
        token_balance(&env, &ata(&wallet, &t.mint, &TOKEN)),
        100_000 - 500
    );
    // Each mint pays to the wallet's account for that mint, under its own token program.
    env.claim(&payer, a, &wallet, &rec, Some(t2)).unwrap();
    env.claim(&payer, a, &wallet, &rec, Some(t22)).unwrap();
    assert_eq!(
        token_balance(&env, &ata(&wallet, &t2.mint, &TOKEN)),
        200_000 - 1_000
    );
    assert_eq!(
        token_balance(&env, &ata(&wallet, &t22.mint, &TOKEN_2022)),
        50_000 - 250
    );
}

#[test]
fn tokens_sent_straight_to_a_vault_are_not_in_the_books() {
    let (mut env, _) = setup();
    let (t, auth) = create_mint(&mut env, TOKEN, 6, &[]);
    let alice = env.funded(10);
    mint_to(&mut env, t, &auth, &alice.pubkey(), 1_000_000);
    env.deposit_token(&alice, NAME, t, 10_000).unwrap();
    let pool = env.pool_pda(&domain_hash(NAME), &t.mint);
    let vault = ata(&pool, &t.mint, &TOKEN);
    transfer_checked(&mut env, t, &alice, &vault, 77, 6);
    let wallet = Pubkey::new_unique();
    let rec = record_for(&mut env, NAME, &wallet);
    let relayer = env.funded(1);
    env.claim(&relayer, NAME, &wallet, &rec, Some(t)).unwrap();
    // Like DomainEscrow: a claim pays the deposits, a stray transfer stays where it was sent.
    assert_eq!(
        token_balance(&env, &ata(&wallet, &t.mint, &TOKEN)),
        10_000 - 50
    );
    assert_eq!(token_balance(&env, &vault), 77);
}

/// A Token-2022 mint initialized by the real program with one extension: `init` is the extension's
/// initialize instruction data, `ext_len` its value length.
fn real_mint_with(env: &mut Env, init: Vec<u8>, ext_len: usize) -> (Tok, Keypair) {
    let payer = env.funded(1);
    let mint = Keypair::new();
    let authority = Keypair::new();
    let space = 166 + 4 + ext_len;
    let lamports = env.svm.minimum_balance_for_rent_exemption(space);
    let mut init_mint = vec![20u8, 6];
    init_mint.extend_from_slice(authority.pubkey().as_ref());
    init_mint.push(0);
    let ixs = [
        solana_system_interface::instruction::create_account(
            &payer.pubkey(),
            &mint.pubkey(),
            lamports,
            space as u64,
            &TOKEN_2022,
        ),
        solana_instruction::Instruction {
            program_id: TOKEN_2022,
            accounts: vec![w(mint.pubkey())],
            data: init,
        },
        solana_instruction::Instruction {
            program_id: TOKEN_2022,
            accounts: vec![w(mint.pubkey())],
            data: init_mint,
        },
    ];
    env.send(&ixs, &[&payer, &mint]).expect("create the mint");
    (
        Tok {
            mint: mint.pubkey(),
            program: TOKEN_2022,
        },
        authority,
    )
}

#[test]
fn extension_numbers_are_token_2022s() {
    // The allowlist in escrow::check_mint names extensions by number; mints made by Token-2022
    // itself show those numbers are the ones it writes.
    let (mut env, _) = setup();
    let alice = env.funded(10);
    let ext_type = |env: &Env, t: Tok| {
        let d = env.svm.get_account(&t.mint).unwrap().data;
        u16::from_le_bytes([d[166], d[167]])
    };

    // Pausable (instruction 44, initialize: authority).
    let mut init = vec![44u8, 0];
    init.extend_from_slice(Pubkey::new_unique().as_ref());
    let (t, auth) = real_mint_with(&mut env, init, 33);
    assert_eq!(ext_type(&env, t), 26);
    mint_to(&mut env, t, &auth, &alice.pubkey(), 1_000);
    env.deposit_token(&alice, NAME, t, 1_000).unwrap();

    // ScaledUiAmount (instruction 43, initialize: authority, multiplier f64).
    let mut init = vec![43u8, 0];
    init.extend_from_slice(Pubkey::new_unique().as_ref());
    init.extend_from_slice(&2.0f64.to_le_bytes());
    let (t, auth) = real_mint_with(&mut env, init, 56);
    assert_eq!(ext_type(&env, t), 25);
    mint_to(&mut env, t, &auth, &alice.pubkey(), 1_000);
    env.deposit_token(&alice, NAME, t, 1_000).unwrap();

    // PermanentDelegate (instruction 35, delegate): refused.
    let mut init = vec![35u8];
    init.extend_from_slice(Pubkey::new_unique().as_ref());
    let (t, auth) = real_mint_with(&mut env, init, 32);
    assert_eq!(ext_type(&env, t), 12);
    mint_to(&mut env, t, &auth, &alice.pubkey(), 1_000);
    assert_err(env.deposit_token(&alice, NAME, t, 1_000), "UnsupportedMint");
}

#[test]
fn with_no_fee_the_wallet_gets_everything() {
    let mut env = Env::new();
    let authority = env.authority.insecure_clone();
    let ix = env.initialize_ix(
        &authority.pubkey(),
        &InitializeArgs {
            admin: authority.pubkey(),
            fee_recipient: Pubkey::default(),
            fee_bps: 0,
            refund_delay: REFUND_DELAY,
        },
    );
    env.send(&[ix], &[&authority]).unwrap();
    let (t, auth) = create_mint(&mut env, TOKEN_2022, 9, &[]);
    let alice = env.funded(10);
    mint_to(&mut env, t, &auth, &alice.pubkey(), 1_000_000);
    env.deposit_token(&alice, NAME, t, 999_999).unwrap();
    env.deposit_sol(&alice, NAME, SOL).unwrap();
    let wallet = Pubkey::new_unique();
    let rec = record_for(&mut env, NAME, &wallet);
    let relayer = env.funded(1);
    env.claim(&relayer, NAME, &wallet, &rec, Some(t)).unwrap();
    env.claim(&relayer, NAME, &wallet, &rec, None).unwrap();
    assert_eq!(
        token_balance(&env, &ata(&wallet, &t.mint, &t.program)),
        999_999
    );
    assert_eq!(env.lamports(&wallet), SOL);
    // No fee: the fee vault's token account is never made, and nothing is owed.
    let fee_vault = env.fees_pda(&t.mint);
    assert!(!account_exists(&env, &ata(&fee_vault, &t.mint, &t.program)));
    assert_eq!(env.fee_vault(&t.mint).unwrap().owed, 0);
    // With no recipient (the system program's address) there is nothing to withdraw to either.
    assert!(env.withdraw_fees(&relayer, None).is_err());
}
