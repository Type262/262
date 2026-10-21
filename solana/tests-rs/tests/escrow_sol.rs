//! The escrow with SOL: deposits, claims with a cached wallet record, fees, refunds, the admin's
//! pause, canonical names, and attempts to take money that isn't yours. Every lamport is counted.

mod escrow_util;

use escrow_util::*;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_system_interface::instruction as system_instruction;
use type262_tests::*;

const NAME: &str = "example.com";

#[test]
fn deposits_claim_and_fees_to_the_lamport() {
    let (mut env, fee_recipient) = setup();
    let h = domain_hash(NAME);
    let pool = env.pool_pda(&h, &SOL_MINT);
    let domain = env.domain_pda(&h);
    let alice = env.funded(100);
    let bob = env.funded(100);
    let carol = env.funded(100);

    // The first deposit opens the domain, the pool and alice's deposit record, at her cost.
    let a0 = env.lamports(&alice.pubkey());
    let meta = env.deposit_sol(&alice, NAME, 3 * SOL).unwrap();
    println!(
        "CU deposit_sol (first, creates 3 accounts): {}",
        meta.compute_units_consumed
    );
    let alice_dep = env.deposit_pda(&pool, &alice.pubkey());
    assert_eq!(
        a0 - env.lamports(&alice.pubkey()),
        3 * SOL + env.rent(&domain) + env.rent(&pool) + env.rent(&alice_dep) + TX_FEE
    );
    let meta = env.deposit_sol(&bob, NAME, 2 * SOL).unwrap();
    println!(
        "CU deposit_sol (new depositor): {}",
        meta.compute_units_consumed
    );
    let a1 = env.lamports(&alice.pubkey());
    let meta = env.deposit_sol(&alice, NAME, SOL).unwrap();
    println!("CU deposit_sol (again): {}", meta.compute_units_consumed);
    assert_eq!(a1 - env.lamports(&alice.pubkey()), SOL + TX_FEE);
    env.deposit_sol(&carol, NAME, 500_000_001).unwrap();

    let balance = 6 * SOL + 500_000_001;
    let p = env.pool(NAME, &SOL_MINT).unwrap();
    assert_eq!(
        p,
        Pool {
            domain_hash: h,
            mint: SOL_MINT,
            balance,
            epoch: 0,
            bump: Pubkey::find_program_address(&[seeds::POOL, &h, SOL_MINT.as_ref()], &env.program)
                .1,
        }
    );
    assert_eq!(env.lamports(&pool), env.rent(&pool) + balance);
    let d = env.deposit_of(NAME, &SOL_MINT, &alice.pubkey()).unwrap();
    assert_eq!(
        (d.pool, d.depositor, d.amount, d.epoch, d.last_at),
        (pool, alice.pubkey(), 4 * SOL, 0, env.now())
    );
    let dom = env.domain(NAME).unwrap();
    assert_eq!(
        (
            dom.domain_hash,
            dom.name.as_str(),
            dom.last_proof,
            dom.wallet
        ),
        (h, NAME, 0, Pubkey::default())
    );

    // Anyone relays the claim; the money goes to the wallet the record publishes.
    let wallet = Pubkey::new_unique();
    let record = record_for(&mut env, NAME, &wallet);
    let relayer = env.funded(10);
    let r0 = env.lamports(&relayer.pubkey());
    let meta = env.claim(&relayer, NAME, &wallet, &record, None).unwrap();
    println!(
        "CU claim SOL (creates the fee vault): {}",
        meta.compute_units_consumed
    );

    let fee = balance * 50 / 10_000;
    let fee_vault = env.fees_pda(&SOL_MINT);
    assert_eq!(env.lamports(&wallet), balance - fee);
    assert_eq!(env.lamports(&pool), env.rent(&pool));
    assert_eq!(env.lamports(&fee_vault), env.rent(&fee_vault) + fee);
    assert_eq!(
        r0 - env.lamports(&relayer.pubkey()),
        env.rent(&fee_vault) + TX_FEE
    );
    let p = env.pool(NAME, &SOL_MINT).unwrap();
    assert_eq!((p.balance, p.epoch), (0, 1));
    let dom = env.domain(NAME).unwrap();
    assert_eq!((dom.last_proof, dom.wallet), (env.now() - 3600, wallet));
    let fv = env.fee_vault(&SOL_MINT).unwrap();
    assert_eq!((fv.mint, fv.owed), (SOL_MINT, fee));

    // Fees are pulled, by anyone, to the configured recipient only.
    let anyone = env.funded(1);
    let meta = env.withdraw_fees(&anyone, None).unwrap();
    println!("CU withdraw_fees SOL: {}", meta.compute_units_consumed);
    assert_eq!(env.lamports(&fee_recipient), fee);
    assert_eq!(env.lamports(&fee_vault), env.rent(&fee_vault));
    assert_eq!(env.fee_vault(&SOL_MINT).unwrap().owed, 0);
    assert_err(env.withdraw_fees(&anyone, None), "ZeroAmount");

    // A second claim finds the pool empty: it pays nothing and moves nothing.
    let w0 = env.lamports(&wallet);
    let r0 = env.lamports(&relayer.pubkey());
    env.claim(&relayer, NAME, &wallet, &record, None).unwrap();
    assert_eq!(env.lamports(&wallet), w0);
    assert_eq!(env.lamports(&relayer.pubkey()), r0 - TX_FEE);
    assert_eq!(env.lamports(&pool), env.rent(&pool));
    assert_eq!(env.pool(NAME, &SOL_MINT).unwrap().epoch, 1);
    assert_eq!(env.fee_vault(&SOL_MINT).unwrap().owed, 0);

    // The next payment is claimed by the same proof.
    env.deposit_sol(&bob, NAME, SOL).unwrap();
    env.claim(&relayer, NAME, &wallet, &record, None).unwrap();
    assert_eq!(env.lamports(&wallet), w0 + SOL - SOL / 200);
    assert_eq!(env.fee_vault(&SOL_MINT).unwrap().owed, SOL / 200);
    assert_eq!(env.pool(NAME, &SOL_MINT).unwrap().epoch, 2);
}

#[test]
fn the_wallet_record_type_also_pays() {
    let (mut env, _) = setup();
    let alice = env.funded(10);
    env.deposit_sol(&alice, NAME, SOL).unwrap();
    let wallet = Pubkey::new_unique();
    let now = env.now();
    // A WALLET (type 262) set at the domain, with an ETH line next to the SOL one.
    let text = b"ETH 0x7edB0000000000000000000000000000000E81f";
    let mut eth = vec![text.len() as u8];
    eth.extend_from_slice(text);
    let record = put_record(
        &mut env,
        NAME,
        RecordKind::Wallet,
        &[eth, sol_rdata(&wallet)],
        now - 10,
        now + 100,
    );
    let relayer = env.funded(1);
    env.claim(&relayer, NAME, &wallet, &record, None).unwrap();
    assert_eq!(env.lamports(&wallet), SOL - SOL / 200);
}

#[test]
fn an_older_proof_never_overrides_a_newer_one() {
    let (mut env, _) = setup();
    let alice = env.funded(100);
    let relayer = env.funded(10);
    let old_wallet = Pubkey::new_unique();
    let new_wallet = Pubkey::new_unique();
    let now = env.now();

    env.deposit_sol(&alice, NAME, SOL).unwrap();
    let rec = put_record(
        &mut env,
        NAME,
        RecordKind::Txt,
        &[sol_rdata(&old_wallet)],
        now - 3600,
        now + 86_400,
    );
    env.claim(&relayer, NAME, &old_wallet, &rec, None).unwrap();
    assert_eq!(env.domain(NAME).unwrap().last_proof, now - 3600);

    // An older record (same PDA, rewritten): no claim, no register.
    env.deposit_sol(&alice, NAME, SOL).unwrap();
    put_record(
        &mut env,
        NAME,
        RecordKind::Txt,
        &[sol_rdata(&new_wallet)],
        now - 7200,
        now + 86_400,
    );
    assert_err(
        env.claim(&relayer, NAME, &new_wallet, &rec, None),
        "StaleProof",
    );
    assert_err(
        env.register(&relayer, NAME, &new_wallet, &rec),
        "StaleProof",
    );
    // Nor through the other record type.
    let wal = put_record(
        &mut env,
        NAME,
        RecordKind::Wallet,
        &[sol_rdata(&new_wallet)],
        now - 3601,
        now + 86_400,
    );
    assert_err(
        env.claim(&relayer, NAME, &new_wallet, &wal, None),
        "StaleProof",
    );

    // The same signing time is the same proof: still good.
    put_record(
        &mut env,
        NAME,
        RecordKind::Txt,
        &[sol_rdata(&old_wallet)],
        now - 3600,
        now + 86_400,
    );
    env.claim(&relayer, NAME, &old_wallet, &rec, None).unwrap();
    assert_eq!(env.lamports(&old_wallet), 2 * (SOL - SOL / 200));

    // The domain moves to a new wallet and registers it without any money moving.
    env.deposit_sol(&alice, NAME, SOL).unwrap();
    put_record(
        &mut env,
        NAME,
        RecordKind::Txt,
        &[sol_rdata(&new_wallet)],
        now - 60,
        now + 86_400,
    );
    let pool_before = env.pool(NAME, &SOL_MINT).unwrap();
    let meta = env.register(&relayer, NAME, &new_wallet, &rec).unwrap();
    println!("CU register: {}", meta.compute_units_consumed);
    assert_eq!(env.pool(NAME, &SOL_MINT).unwrap(), pool_before);
    let dom = env.domain(NAME).unwrap();
    assert_eq!((dom.last_proof, dom.wallet), (now - 60, new_wallet));
    assert_eq!(env.lamports(&new_wallet), 0);

    // The old wallet's record, even re-proven at its old time, can't take the new payment.
    put_record(
        &mut env,
        NAME,
        RecordKind::Txt,
        &[sol_rdata(&old_wallet)],
        now - 3600,
        now + 86_400,
    );
    assert_err(
        env.claim(&relayer, NAME, &old_wallet, &rec, None),
        "StaleProof",
    );
    // Nor signed at the same time as the new one: a tie keeps the wallet already recorded.
    let tied = put_record(
        &mut env,
        NAME,
        RecordKind::Wallet,
        &[sol_rdata(&old_wallet)],
        now - 60,
        now + 86_400,
    );
    assert_err(
        env.claim(&relayer, NAME, &old_wallet, &tied, None),
        "TiedProof",
    );
    assert_err(
        env.register(&relayer, NAME, &old_wallet, &tied),
        "TiedProof",
    );
    put_record(
        &mut env,
        NAME,
        RecordKind::Txt,
        &[sol_rdata(&new_wallet)],
        now - 60,
        now + 86_400,
    );
    env.claim(&relayer, NAME, &new_wallet, &rec, None).unwrap();
    assert_eq!(env.lamports(&new_wallet), SOL - SOL / 200);
}

#[test]
fn register_opens_a_domain_nobody_paid() {
    let (mut env, _) = setup();
    let name = "fresh.org";
    let payer = env.funded(10);
    let wallet = Pubkey::new_unique();
    let rec = record_for(&mut env, name, &wallet);
    let p0 = env.lamports(&payer.pubkey());
    env.register(&payer, name, &wallet, &rec).unwrap();
    let domain = env.domain_pda(&domain_hash(name));
    assert_eq!(
        p0 - env.lamports(&payer.pubkey()),
        env.rent(&domain) + TX_FEE
    );
    let dom = env.domain(name).unwrap();
    assert_eq!(
        (
            dom.name.as_str(),
            dom.domain_hash,
            dom.last_proof,
            dom.wallet,
            dom.launches
        ),
        (name, domain_hash(name), env.now() - 3600, wallet, 0)
    );
    assert!(env.pool(name, &SOL_MINT).is_none());

    // A record for someone else's wallet proves nothing for this one.
    let other = Pubkey::new_unique();
    assert_err(
        env.register(&payer, name, &other, &rec),
        "WalletNotPublished",
    );
    // Twice is fine (same proof).
    env.register(&payer, name, &wallet, &rec).unwrap();
}

#[test]
fn refunds_follow_the_delay_and_the_epochs() {
    let (mut env, _) = setup();
    let h = domain_hash(NAME);
    let pool = env.pool_pda(&h, &SOL_MINT);
    let alice = env.funded(100);
    let bob = env.funded(100);
    let carol = env.funded(100);

    env.deposit_sol(&alice, NAME, SOL).unwrap();
    env.deposit_sol(&bob, NAME, 2 * SOL).unwrap();
    assert_err(env.refund(&alice, NAME, None), "RefundLocked");
    env.warp(REFUND_DELAY - 1);
    assert_err(env.refund(&alice, NAME, None), "RefundLocked");
    env.warp(1);

    // Back to the lamport, plus the deposit record's rent: the record is closed.
    let alice_dep = env.deposit_pda(&pool, &alice.pubkey());
    let dep_rent = env.rent(&alice_dep);
    let a0 = env.lamports(&alice.pubkey());
    let meta = env.refund(&alice, NAME, None).unwrap();
    println!("CU refund SOL: {}", meta.compute_units_consumed);
    assert_eq!(env.lamports(&alice.pubkey()), a0 + SOL + dep_rent - TX_FEE);
    assert!(!account_exists(&env, &alice_dep));
    assert_eq!(env.pool(NAME, &SOL_MINT).unwrap().balance, 2 * SOL);
    assert_eq!(env.lamports(&pool), env.rent(&pool) + 2 * SOL);
    assert_code(
        env.refund(&alice, NAME, None),
        ANCHOR_ACCOUNT_NOT_INITIALIZED,
    );

    // Every deposit restarts the depositor's delay.
    env.deposit_sol(&bob, NAME, SOL).unwrap();
    assert_err(env.refund(&bob, NAME, None), "RefundLocked");
    env.warp(REFUND_DELAY);
    let b0 = env.lamports(&bob.pubkey());
    env.refund(&bob, NAME, None).unwrap();
    let bob_rent = env
        .svm
        .minimum_balance_for_rent_exemption(8 + 32 + 32 + 8 + 8 + 8 + 1);
    assert_eq!(
        env.lamports(&bob.pubkey()),
        b0 + 3 * SOL + bob_rent - TX_FEE
    );
    assert_eq!(env.pool(NAME, &SOL_MINT).unwrap().balance, 0);
    assert_eq!(env.lamports(&pool), env.rent(&pool));

    // A claim ends the refunds of everything deposited before it.
    env.deposit_sol(&carol, NAME, SOL).unwrap();
    let wallet = Pubkey::new_unique();
    let rec = record_for(&mut env, NAME, &wallet);
    let relayer = env.funded(1);
    env.claim(&relayer, NAME, &wallet, &rec, None).unwrap();
    env.warp(REFUND_DELAY);
    assert_err(env.refund(&carol, NAME, None), "NothingToRefund");

    // A deposit after the claim starts over in the new epoch, with only the new amount.
    env.deposit_sol(&carol, NAME, SOL / 2).unwrap();
    let d = env.deposit_of(NAME, &SOL_MINT, &carol.pubkey()).unwrap();
    assert_eq!((d.amount, d.epoch), (SOL / 2, 1));
    env.warp(REFUND_DELAY);
    let c0 = env.lamports(&carol.pubkey());
    let carol_dep = env.deposit_pda(&pool, &carol.pubkey());
    let rent = env.rent(&carol_dep);
    env.refund(&carol, NAME, None).unwrap();
    assert_eq!(env.lamports(&carol.pubkey()), c0 + SOL / 2 + rent - TX_FEE);
    assert_eq!(env.lamports(&pool), env.rent(&pool));

    // Nobody refunds what they never deposited.
    let dave = env.funded(1);
    assert_code(
        env.refund(&dave, NAME, None),
        ANCHOR_ACCOUNT_NOT_INITIALIZED,
    );
    assert_code(
        env.refund(&dave, "nobody.paid", None),
        ANCHOR_ACCOUNT_NOT_INITIALIZED,
    );
}

#[test]
fn pause_stops_deposits_only_and_admin_hands_over_in_two_steps() {
    let (mut env, fee_recipient) = setup();
    let admin = env.authority.insecure_clone();
    let alice = env.funded(100);
    let stranger = env.funded(1);
    env.deposit_sol(&alice, NAME, SOL).unwrap();
    let wallet = Pubkey::new_unique();
    let rec = record_for(&mut env, NAME, &wallet);
    let relayer = env.funded(1);
    env.claim(&relayer, NAME, &wallet, &rec, None).unwrap();
    env.deposit_sol(&alice, NAME, SOL).unwrap();

    assert_err(env.set_deposits_paused(&stranger, true), "NotAdmin");
    env.set_deposits_paused(&admin, true).unwrap();
    assert_err(env.deposit_sol(&alice, NAME, SOL), "Paused");
    assert_err(env.deposit_sol(&stranger, "other.net", 1), "Paused");

    // Claims, refunds and fee withdrawals still work.
    env.withdraw_fees(&stranger, None).unwrap();
    assert_eq!(env.lamports(&fee_recipient), SOL / 200);
    env.warp(REFUND_DELAY);
    env.refund(&alice, NAME, None).unwrap();
    env.deposit_sol(&alice, "x.io", 1).unwrap_err();

    // Handover: the new admin must accept; then only they can unpause.
    let next = env.funded(1);
    env.transfer_admin(&admin, next.pubkey()).unwrap();
    assert_err(env.accept_admin(&stranger), "NotPendingAdmin");
    env.set_deposits_paused(&admin, false).unwrap(); // still admin until accepted
    env.set_deposits_paused(&admin, true).unwrap();
    env.accept_admin(&next).unwrap();
    assert_err(env.set_deposits_paused(&admin, false), "NotAdmin");
    env.set_deposits_paused(&next, false).unwrap();
    env.deposit_sol(&alice, NAME, SOL).unwrap();
    // A cancelled handover leaves no one pending.
    env.transfer_admin(&next, stranger.pubkey()).unwrap();
    env.transfer_admin(&next, Pubkey::default()).unwrap();
    assert_err(env.accept_admin(&stranger), "NotPendingAdmin");
}

#[test]
fn names_must_be_canonical_and_match_their_hash() {
    let (mut env, _) = setup();
    let alice = env.funded(100);
    for bad in [
        "Example.com",
        "example.com.",
        ".example.com",
        "a..b",
        "ex ample.com",
        "bücher.de",
        &"a".repeat(64),
        &format!(
            "{}.{}.{}.{}",
            "a".repeat(63),
            "b".repeat(63),
            "c".repeat(63),
            "d".repeat(62)
        ),
    ] {
        assert_err(env.deposit_sol(&alice, bad, SOL), "BadDomain");
    }
    let longest = format!("{0}.{0}.{0}.{1}", "a".repeat(63), "b".repeat(61));
    for ok in [
        "xn--bcher-kva.de",
        "_wallet-1.a_b.io",
        &"a".repeat(63),
        &longest,
    ] {
        env.deposit_sol(&alice, ok, 1).unwrap();
        assert_eq!(env.domain(ok).unwrap().name, ok);
    }
    assert_err(env.deposit_sol(&alice, NAME, 0), "ZeroAmount");

    // The hash must be sha256 of the name: the PDAs are derived from the hash.
    let h = domain_hash("example.org");
    let pool = env.pool_pda(&h, &SOL_MINT);
    let ix = env.ix(
        "deposit_sol",
        &DepositArgs {
            name: NAME.into(),
            domain_hash: h,
            amount: SOL,
        },
        vec![
            ws(alice.pubkey()),
            r(env.config_pda()),
            w(env.domain_pda(&h)),
            w(pool),
            w(env.deposit_pda(&pool, &alice.pubkey())),
            r(solana_sdk_ids::system_program::ID),
        ],
    );
    assert_err(env.send(&[ix], &[&alice]), "DomainHashMismatch");
    // Same for register.
    let wallet = Pubkey::new_unique();
    let rec = record_for(&mut env, NAME, &wallet);
    let ix = env.ix(
        "register",
        &RegisterArgs {
            name: NAME.into(),
            domain_hash: h,
            wallet,
        },
        vec![
            ws(alice.pubkey()),
            w(env.domain_pda(&h)),
            r(rec),
            r(wallet),
            r(solana_sdk_ids::system_program::ID),
        ],
    );
    assert_err(env.send(&[ix], &[&alice]), "DomainHashMismatch");
}

#[test]
fn nobody_takes_money_that_is_not_theirs() {
    let (mut env, fee_recipient) = setup();
    let a = "alice.com";
    let b = "bob.com";
    let payer = env.funded(100);
    env.deposit_sol(&payer, a, 5 * SOL).unwrap();
    env.deposit_sol(&payer, b, 7 * SOL).unwrap();
    let a_wallet = Pubkey::new_unique();
    let b_wallet = Pubkey::new_unique();
    let a_rec = record_for(&mut env, a, &a_wallet);
    let b_rec = record_for(&mut env, b, &b_wallet);
    let thief = env.funded(10);
    let t = thief.pubkey();

    // b's pool under a's claim: the pool PDA doesn't match a's hash.
    let ix = env.claim_ix(&t, a, &a_wallet, &a_rec, &SOL_MINT, None);
    let b_pool = env.pool_pda(&domain_hash(b), &SOL_MINT);
    assert_code(
        env.send(&[swap(ix, 5, w(b_pool))], &[&thief]),
        ANCHOR_CONSTRAINT_SEEDS,
    );

    // b's record for a: the record is not a's PDA.
    assert_err(
        env.claim(&thief, a, &b_wallet, &b_rec, None),
        "NotAWalletRecord",
    );
    // a's record for a wallet it doesn't publish.
    assert_err(env.claim(&thief, a, &t, &a_rec, None), "WalletNotPublished");
    // The right wallet in the args, another account paid.
    let ix = env.claim_ix(&t, a, &a_wallet, &a_rec, &SOL_MINT, None);
    assert_err(env.send(&[swap(ix, 4, w(t))], &[&thief]), "BadRecipient");
    // The default key is never a wallet.
    let ix = env.claim_ix(&t, a, &Pubkey::default(), &a_rec, &SOL_MINT, None);
    assert!(env.send(&[ix], &[&thief]).is_err());

    // A copy of a's record in an account the program doesn't own, at the right address or not.
    let real = env.svm.get_account(&a_rec).unwrap();
    let fake = Pubkey::new_unique();
    let mut copy = real.clone();
    copy.owner = solana_sdk_ids::system_program::ID;
    env.svm.set_account(fake, copy.clone()).unwrap();
    assert_err(
        env.claim(&thief, a, &a_wallet, &fake, None),
        "NotAWalletRecord",
    );
    let thief_rec = record_for(&mut env, "thief.com", &t);
    let ix = env.claim_ix(&t, a, &t, &thief_rec, &SOL_MINT, None);
    assert_err(env.send(&[ix], &[&thief]), "NotAWalletRecord");
    let other_program = Pubkey::new_unique();
    let mut moved = real.clone();
    moved.owner = other_program;
    env.svm.set_account(a_rec, moved).unwrap();
    assert_err(
        env.claim(&thief, a, &a_wallet, &a_rec, None),
        "NotAWalletRecord",
    );
    // A program-owned account at another address (the pool itself) is not a record either.
    env.svm.set_account(a_rec, real).unwrap();
    let a_pool = env.pool_pda(&domain_hash(a), &SOL_MINT);
    assert_err(
        env.claim(&thief, a, &a_wallet, &a_pool, None),
        "NotAWalletRecord",
    );

    // An expired record.
    let now = env.now();
    put_record(
        &mut env,
        b,
        RecordKind::Txt,
        &[sol_rdata(&b_wallet)],
        now - 100,
        now - 1,
    );
    assert_err(
        env.claim(&thief, b, &b_wallet, &b_rec, None),
        "WalletRecordExpired",
    );

    // Token accounts on a SOL claim (here only the token program).
    let mut ix = env.claim_ix(&t, a, &a_wallet, &a_rec, &SOL_MINT, None);
    ix.accounts[12] = r(TOKEN);
    assert_err(env.send(&[ix], &[&thief]), "WrongMint");

    // Fees only to the configured recipient, and only from the vault of the named asset.
    env.claim(&thief, a, &a_wallet, &a_rec, None).unwrap();
    let ix = env.withdraw_fees_ix(&t, None);
    assert_err(env.send(&[swap(ix, 3, w(t))], &[&thief]), "BadRecipient");
    let ix = env.withdraw_fees_ix(&t, None);
    let other = env.fees_pda(&Pubkey::new_unique());
    assert!(env.send(&[swap(ix, 2, w(other))], &[&thief]).is_err());
    env.withdraw_fees(&thief, None).unwrap();
    assert_eq!(env.lamports(&fee_recipient), 5 * SOL / 200);

    // Nobody but the depositor refunds (the deposit PDA is keyed by the signer).
    env.warp(REFUND_DELAY);
    let ix = env.refund_ix(&t, b, None);
    let real_dep = env.deposit_pda(&b_pool, &payer.pubkey());
    assert_code(
        env.send(&[swap(ix, 3, w(real_dep))], &[&thief]),
        ANCHOR_CONSTRAINT_SEEDS,
    );

    // b's money is all still there, and the thief only paid fees.
    assert_eq!(env.pool(b, &SOL_MINT).unwrap().balance, 7 * SOL);
    assert_eq!(env.lamports(&b_pool), env.rent(&b_pool) + 7 * SOL);
}

#[test]
fn ordering_inside_one_transaction() {
    let (mut env, _) = setup();
    let h = domain_hash(NAME);
    let pool = env.pool_pda(&h, &SOL_MINT);
    let alice = env.funded(100);
    let bob = env.funded(100);
    let wallet = Pubkey::new_unique();
    let rec = record_for(&mut env, NAME, &wallet);
    env.deposit_sol(&alice, NAME, SOL).unwrap();

    // Claim, deposit, claim: each claim pays exactly what is in the pool at that point.
    let ixs = [
        env.claim_ix(&bob.pubkey(), NAME, &wallet, &rec, &SOL_MINT, None),
        env.deposit_sol_ix(&bob.pubkey(), NAME, 2 * SOL),
        env.claim_ix(&bob.pubkey(), NAME, &wallet, &rec, &SOL_MINT, None),
    ];
    env.send(&ixs, &[&bob]).unwrap();
    assert_eq!(env.lamports(&wallet), 3 * SOL - 3 * SOL / 200);
    let p = env.pool(NAME, &SOL_MINT).unwrap();
    assert_eq!((p.balance, p.epoch), (0, 2));
    assert_eq!(env.lamports(&pool), env.rent(&pool));

    // Deposit and refund at once: locked, and the whole transaction is undone.
    let b0 = env.lamports(&bob.pubkey());
    let ixs = [
        env.deposit_sol_ix(&bob.pubkey(), NAME, SOL),
        env.refund_ix(&bob.pubkey(), NAME, None),
    ];
    assert_err(env.send(&ixs, &[&bob]), "RefundLocked");
    assert_eq!(env.lamports(&bob.pubkey()), b0 - TX_FEE);
    assert_eq!(env.pool(NAME, &SOL_MINT).unwrap().balance, 0);

    // After the delay: a claim first makes the refund fail, and undoes the claim with it.
    env.deposit_sol(&alice, NAME, SOL).unwrap();
    env.warp(REFUND_DELAY);
    let rec = record_for(&mut env, NAME, &wallet); // the old one expired over the delay
    let w0 = env.lamports(&wallet);
    let ixs = [
        env.claim_ix(&bob.pubkey(), NAME, &wallet, &rec, &SOL_MINT, None),
        env.refund_ix(&alice.pubkey(), NAME, None),
    ];
    assert_err(env.send(&ixs, &[&bob, &alice]), "NothingToRefund");
    assert_eq!(env.lamports(&wallet), w0);
    assert_eq!(env.pool(NAME, &SOL_MINT).unwrap().balance, SOL);

    // A refund first, then the claim takes what is left: bob's deposit.
    env.deposit_sol(&bob, NAME, SOL).unwrap();
    let a0 = env.lamports(&alice.pubkey());
    let ixs = [
        env.refund_ix(&alice.pubkey(), NAME, None),
        env.claim_ix(&alice.pubkey(), NAME, &wallet, &rec, &SOL_MINT, None),
    ];
    env.send(&ixs, &[&alice]).unwrap();
    let alice_dep_rent = env
        .svm
        .minimum_balance_for_rent_exemption(8 + 32 + 32 + 8 + 8 + 8 + 1);
    assert_eq!(
        env.lamports(&alice.pubkey()),
        a0 + SOL + alice_dep_rent - TX_FEE
    );
    assert_eq!(env.lamports(&wallet), w0 + SOL - SOL / 200);
    assert_eq!(env.lamports(&pool), env.rent(&pool));
}

#[test]
fn every_lamport_is_accounted_for() {
    let (mut env, fee_recipient) = setup();
    let names = ["one.com", "two.org"];
    let people: Vec<Keypair> = (0..4).map(|_| env.funded(50)).collect();
    let wallets: Vec<Pubkey> = (0..2).map(|_| Pubkey::new_unique()).collect();
    let mut keys: Vec<Pubkey> = people.iter().map(|k| k.pubkey()).collect();
    keys.extend(wallets.iter());
    keys.push(fee_recipient);
    keys.push(env.fees_pda(&SOL_MINT));
    for n in names {
        let h = domain_hash(n);
        let pool = env.pool_pda(&h, &SOL_MINT);
        keys.push(env.domain_pda(&h));
        keys.push(pool);
        for p in &people {
            keys.push(env.deposit_pda(&pool, &p.pubkey()));
        }
    }
    // A fresh account can't take less than its rent-exempt minimum, so the recipient has some SOL.
    env.svm.airdrop(&fee_recipient, SOL).unwrap();
    let total = |env: &Env| total_lamports(env, &keys);
    let start = total(&env);
    let mut fees = 0;

    let mut amounts = 0u64;
    for (i, p) in people.iter().enumerate() {
        for (j, n) in names.iter().enumerate() {
            let amount = 1_234_567 * (i as u64 + 1) + 7 * j as u64;
            amounts += amount;
            fees += env.deposit_sol(p, n, amount).unwrap().fee;
        }
    }
    // A donation straight into a pool is not counted by its books, so it stays there.
    let donor = env.funded(1);
    let one_pool = env.pool_pda(&domain_hash(names[0]), &SOL_MINT);
    env.send(
        &[system_instruction::transfer(
            &donor.pubkey(),
            &one_pool,
            777,
        )],
        &[&donor],
    )
    .unwrap();
    assert_eq!(total(&env), start - fees + 777);
    let start = start + 777;

    let mut claimed = 0;
    for (n, wallet) in names.iter().zip(&wallets) {
        let rec = record_for(&mut env, n, wallet);
        let balance = env.pool(n, &SOL_MINT).unwrap().balance;
        fees += env.claim(&people[0], n, wallet, &rec, None).unwrap().fee;
        claimed += balance;
        assert_eq!(env.lamports(wallet), balance - balance * 50 / 10_000);
    }
    assert_eq!(claimed, amounts);
    fees += env.withdraw_fees(&people[1], None).unwrap().fee;
    assert_eq!(total(&env), start - fees);
    assert_eq!(env.lamports(&one_pool), env.rent(&one_pool) + 777);
    // The fee recipient got exactly the fee on each pool, rounded down per pool.
    let expected: u64 = names
        .iter()
        .map(|n| {
            let paid: u64 = (0..4u64).map(|i| 1_234_567 * (i + 1)).sum::<u64>()
                + if *n == names[1] { 28 } else { 0 };
            paid * 50 / 10_000
        })
        .sum();
    assert_eq!(env.lamports(&fee_recipient), SOL + expected);
}

#[test]
fn a_tiny_payout_to_an_empty_wallet_needs_rent() {
    // The runtime refuses to leave a new account below its rent-exempt minimum, so a payout
    // smaller than that to a wallet with no SOL fails until the wallet holds some.
    let (mut env, _) = setup();
    let alice = env.funded(10);
    env.deposit_sol(&alice, NAME, 100_000).unwrap();
    let wallet = Pubkey::new_unique();
    let rec = record_for(&mut env, NAME, &wallet);
    let relayer = env.funded(1);
    let f = assert_fails(env.claim(&relayer, NAME, &wallet, &rec, None));
    assert!(
        format!("{:?}", f.err).contains("InsufficientFundsForRent"),
        "{:?}",
        f.err
    );
    // Funding the wallet in the same transaction is enough.
    let rent = env.svm.minimum_balance_for_rent_exemption(0);
    let ixs = [
        system_instruction::transfer(&relayer.pubkey(), &wallet, rent),
        env.claim_ix(&relayer.pubkey(), NAME, &wallet, &rec, &SOL_MINT, None),
    ];
    env.send(&ixs, &[&relayer]).unwrap();
    assert_eq!(env.lamports(&wallet), rent + 100_000 - 500);
}
