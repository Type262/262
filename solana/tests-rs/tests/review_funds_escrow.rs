//! Security review of the escrow's money paths: attacks a motivated stranger can try with throwaway
//! keys. FIXED tests cover the weak spots the review found (a mint's transfer-fee authority, a
//! token account published as the wallet, proofs that tie on signing time) and assert the program
//! now refuses them; HELD tests show an attack failing; INFO tests document behavior worth knowing.

mod escrow_util;

use escrow_util::*;
use solana_account::Account;
use solana_clock::Clock;
use solana_instruction::Instruction;
use solana_signer::Signer;
use solana_system_interface::instruction as system_instruction;
use type262_tests::*;

const NAME: &str = "example.com";
const OTHER: &str = "other.example";

/// Anchor's own: an existing init_if_needed account holds less than its rent-exempt minimum.
const ANCHOR_CONSTRAINT_RENT_EXEMPT: u32 = 2005;

// ---------- Token-2022 transfer fees ----------

/// TransferFeeConfig with `authority` as both the fee authority and the withdraw-withheld
/// authority, charging `bps` (at most `max`) in every epoch.
fn fee_config(authority: &Pubkey, bps: u16, max: u64) -> (u16, Vec<u8>) {
    let mut v = authority.as_ref().to_vec();
    v.extend_from_slice(authority.as_ref());
    v.extend_from_slice(&0u64.to_le_bytes()); // withheld on the mint
    for _ in 0..2 {
        v.extend_from_slice(&0u64.to_le_bytes()); // epoch
        v.extend_from_slice(&max.to_le_bytes());
        v.extend_from_slice(&bps.to_le_bytes());
    }
    (1, v)
}

/// Token-2022 SetAuthority to none for the transfer fee config authority (AuthorityType 4).
fn drop_fee_authority(t: Tok, authority: &Pubkey) -> Instruction {
    Instruction {
        program_id: TOKEN_2022,
        accounts: vec![w(t.mint), rs(*authority)],
        data: vec![6, 4, 0],
    }
}

/// Token-2022 SetTransferFee: takes effect two epochs later.
fn set_transfer_fee(t: Tok, authority: &Pubkey, bps: u16, max: u64) -> Instruction {
    let mut data = vec![26u8, 5];
    data.extend_from_slice(&bps.to_le_bytes());
    data.extend_from_slice(&max.to_le_bytes());
    Instruction {
        program_id: TOKEN_2022,
        accounts: vec![w(t.mint), rs(*authority)],
        data,
    }
}

/// Token-2022 WithdrawWithheldTokensFromAccounts: the withdraw-withheld authority sweeps what was
/// withheld in `sources` into `dest`, without their owners.
fn withdraw_withheld(t: Tok, dest: &Pubkey, authority: &Pubkey, sources: &[Pubkey]) -> Instruction {
    let mut accounts = vec![r(t.mint), w(*dest), rs(*authority)];
    accounts.extend(sources.iter().map(|s| w(*s)));
    Instruction {
        program_id: TOKEN_2022,
        accounts,
        data: vec![26, 3, sources.len() as u8],
    }
}

fn warp_epochs(env: &mut Env, epochs: u64) {
    let mut clock = env.svm.get_sysvar::<Clock>();
    clock.epoch += epochs;
    clock.slot += 1;
    env.svm.set_sysvar::<Clock>(&clock);
    env.svm.expire_blockhash();
}

/// FIXED (was low). check_mint accepted TransferFeeConfig whatever its authorities, on the grounds
/// that the books stay exact. They do, but the fee authority could raise the fee to 100% after the
/// deposits were in; two epochs later every claim and refund delivered nothing and the withheld
/// tokens went to the mint's withdraw-withheld authority, while refunds were locked for
/// REFUND_DELAY. Now such a mint is refused at deposit, so there is nothing for it to take.
#[test]
fn a_transfer_fee_authority_cannot_take_payouts() {
    let (mut env, _) = setup();
    let taxman = env.funded(10);
    let tm = taxman.pubkey();
    // No fee at deposit time, so nothing looks wrong; but the authority can change it.
    let (t, auth) = create_mint(&mut env, TOKEN_2022, 6, &[fee_config(&tm, 0, 0)]);
    let alice = env.funded(10);
    mint_to(&mut env, t, &auth, &alice.pubkey(), 1_000_000);
    assert_err(
        env.deposit_token(&alice, NAME, t, 1_000_000),
        "UnsupportedMint",
    );
    assert!(env.pool(NAME, &t.mint).is_none());

    // Once the authority gives the role up, the fee is fixed for good and the mint is accepted;
    // the withdraw-withheld authority keeps only what transfers withheld, which no pool counts.
    env.send(&[drop_fee_authority(t, &tm)], &[&taxman]).unwrap();
    env.deposit_token(&alice, NAME, t, 1_000_000).unwrap();
    assert!(env
        .send(&[set_transfer_fee(t, &tm, 10_000, u64::MAX)], &[&taxman])
        .is_err());
    let wallet = Pubkey::new_unique();
    let rec = record_for(&mut env, NAME, &wallet);
    let relayer = env.funded(1);
    env.claim(&relayer, NAME, &wallet, &rec, Some(t)).unwrap();
    assert_eq!(
        token_balance(&env, &ata(&wallet, &t.mint, &TOKEN_2022)),
        995_000
    );
}

/// FIXED, the other way in: the authority schedules a new fee (it applies two epochs later) and
/// then gives the role up. The newer fee is still to come, so the mint is refused until it
/// applies; from then on it is the fee for good, and the books follow it exactly.
#[test]
fn a_scheduled_transfer_fee_is_refused_until_it_applies() {
    let (mut env, _) = setup();
    let taxman = env.funded(10);
    let tm = taxman.pubkey();
    let (t, auth) = create_mint(&mut env, TOKEN_2022, 6, &[fee_config(&tm, 0, 0)]);
    env.send(
        &[
            set_transfer_fee(t, &tm, 100, 1_000_000_000),
            drop_fee_authority(t, &tm),
        ],
        &[&taxman],
    )
    .unwrap();
    let alice = env.funded(10);
    mint_to(&mut env, t, &auth, &alice.pubkey(), 1_000_000);
    assert_err(
        env.deposit_token(&alice, NAME, t, 100_000),
        "UnsupportedMint",
    );
    warp_epochs(&mut env, 1);
    assert_err(
        env.deposit_token(&alice, NAME, t, 100_000),
        "UnsupportedMint",
    );
    // In effect now: 1% of every transfer, and the pool is credited what arrived.
    warp_epochs(&mut env, 1);
    env.deposit_token(&alice, NAME, t, 100_000).unwrap();
    assert_eq!(env.pool(NAME, &t.mint).unwrap().balance, 99_000);

    // The withdraw-withheld authority sweeps the withheld fees, from accounts it doesn't own; it
    // gets only the 1% each transfer withheld, and every counted amount stays where it was.
    let tf = |amount: u64| (amount * 100).div_ceil(10_000);
    let wallet = Pubkey::new_unique();
    let rec = record_for(&mut env, NAME, &wallet);
    let relayer = env.funded(1);
    env.claim(&relayer, NAME, &wallet, &rec, Some(t)).unwrap();
    let (fee, payout) = (99_000 * 50 / 10_000, 99_000 - 99_000 * 50 / 10_000);
    let wallet_ta = ata(&wallet, &t.mint, &TOKEN_2022);
    let fee_ta = ata(&env.fees_pda(&t.mint), &t.mint, &TOKEN_2022);
    let vault = ata(
        &env.pool_pda(&domain_hash(NAME), &t.mint),
        &t.mint,
        &TOKEN_2022,
    );
    let tax_ta = create_ata(&mut env, &taxman, &tm, t);
    env.send(
        &[withdraw_withheld(
            t,
            &tax_ta,
            &tm,
            &[vault, wallet_ta, fee_ta],
        )],
        &[&taxman],
    )
    .unwrap();
    assert_eq!(
        token_balance(&env, &tax_ta),
        tf(100_000) + tf(payout) + tf(fee)
    );
    assert_eq!(token_balance(&env, &wallet_ta), payout - tf(payout));
    assert_eq!(token_balance(&env, &fee_ta), fee - tf(fee));
    assert_eq!(env.fee_vault(&t.mint).unwrap().owed, fee - tf(fee));
    assert_eq!(token_balance(&env, &vault), 0);
}

// ---------- proof ordering ----------

/// FIXED (was low). accept_proof let a proof with the same signing time as the domain's last one
/// through, whatever wallet it named (signed_at >= last_proof). Signers that fix RRSIG times per
/// period (PowerDNS, for one, starts every signature of a week at the same instant) give the old
/// and the new wallet record the same signed_at after a rotation or a sale, and the old record
/// kept claiming after the owner registered the new wallet. Now a tie keeps the wallet already
/// recorded (TiedProof): the first wallet registered at a signing time keeps it, and a record
/// signed strictly later always wins. A rotation is complete once such a record is registered.
#[test]
fn a_tie_on_signing_time_keeps_the_first_registered_wallet() {
    let (mut env, _) = setup();
    let alice = env.funded(100);
    let relayer = env.funded(10);
    let thief = env.funded(1);
    let old_wallet = Pubkey::new_unique();
    let new_wallet = Pubkey::new_unique();
    let now = env.now();
    let last_week = now - 8 * 86_400;
    let inception = now - 86_400;
    let expires = now + 7 * 86_400;

    // Last week: the domain publishes its wallet in a WALLET record, and it is paid there.
    let old_rec = put_record(
        &mut env,
        NAME,
        RecordKind::Wallet,
        &[sol_rdata(&old_wallet)],
        last_week,
        expires,
    );
    env.deposit_sol(&alice, NAME, SOL).unwrap();
    env.claim(&relayer, NAME, &old_wallet, &old_rec, None)
        .unwrap();

    // The old key leaks. This week's signatures all start at `inception`: the old WALLET record
    // (signed before the owner removed it) and the new wallet's TXT. The owner registers first.
    let new_rec = put_record(
        &mut env,
        NAME,
        RecordKind::Txt,
        &[sol_rdata(&new_wallet)],
        inception,
        expires,
    );
    env.register(&relayer, NAME, &new_wallet, &new_rec).unwrap();
    put_record(
        &mut env,
        NAME,
        RecordKind::Wallet,
        &[sol_rdata(&old_wallet)],
        inception,
        expires,
    );
    env.deposit_sol(&alice, NAME, 2 * SOL).unwrap();
    assert_err(
        env.claim(&thief, NAME, &old_wallet, &old_rec, None),
        "TiedProof",
    );
    assert_err(
        env.register(&thief, NAME, &old_wallet, &old_rec),
        "TiedProof",
    );
    env.claim(&thief, NAME, &new_wallet, &new_rec, None)
        .unwrap();
    assert_eq!(env.lamports(&new_wallet), 2 * SOL - 2 * SOL / 200);
    let dom = env.domain(NAME).unwrap();
    assert_eq!((dom.last_proof, dom.wallet), (inception, new_wallet));

    // The other order, on another domain: the old record claims at this signing time before the
    // owner registers. The tie then keeps the old wallet until the zone signs again.
    let old_rec = put_record(
        &mut env,
        OTHER,
        RecordKind::Wallet,
        &[sol_rdata(&old_wallet)],
        inception,
        expires,
    );
    env.deposit_sol(&alice, OTHER, SOL).unwrap();
    env.claim(&thief, OTHER, &old_wallet, &old_rec, None)
        .unwrap();
    let new_rec = put_record(
        &mut env,
        OTHER,
        RecordKind::Txt,
        &[sol_rdata(&new_wallet)],
        inception,
        expires,
    );
    assert_err(
        env.register(&relayer, OTHER, &new_wallet, &new_rec),
        "TiedProof",
    );
    // A record signed strictly later always wins, and the old one is stale from then on.
    put_record(
        &mut env,
        OTHER,
        RecordKind::Txt,
        &[sol_rdata(&new_wallet)],
        inception + 1,
        expires,
    );
    env.register(&relayer, OTHER, &new_wallet, &new_rec)
        .unwrap();
    env.deposit_sol(&alice, OTHER, SOL).unwrap();
    assert_err(
        env.claim(&thief, OTHER, &old_wallet, &old_rec, None),
        "StaleProof",
    );
    env.claim(&thief, OTHER, &new_wallet, &new_rec, None)
        .unwrap();
    assert_eq!(
        env.lamports(&new_wallet),
        2 * SOL - 2 * SOL / 200 + SOL - SOL / 200
    );
}

// ---------- recipients ----------

/// FIXED (was low). claim paid whatever address the record named, and anyone can send the claim.
/// A domain that published a token account (the classic mistake: its USDC deposit address)
/// instead of a wallet got its tokens paid to ATA(that token account, mint), which no key can ever
/// sign for, and a stranger could lock them in before the owner fixed DNS. Now claim and register
/// refuse a wallet owned by either token program (a token account or a mint) or a program.
#[test]
fn claims_refuse_a_token_account_as_the_wallet() {
    let (mut env, _) = setup();
    let (t, auth) = create_mint(&mut env, TOKEN, 6, &[]);
    let (t22, _) = create_mint(&mut env, TOKEN_2022, 6, &[]);
    let owner = env.funded(1);
    // The owner's deposit address for this mint, published by mistake as the domain's wallet.
    let deposit_address = mint_to(&mut env, t, &auth, &owner.pubkey(), 1);
    let bob = env.funded(10);
    mint_to(&mut env, t, &auth, &bob.pubkey(), 1_000_000);
    env.deposit_token(&bob, NAME, t, 1_000_000).unwrap();
    env.deposit_sol(&bob, NAME, SOL).unwrap();

    let stranger = env.funded(1);
    for wallet in [deposit_address, t.mint, t22.mint] {
        let rec = record_for(&mut env, NAME, &wallet);
        assert_err(
            env.claim(&stranger, NAME, &wallet, &rec, Some(t)),
            "BadRecipient",
        );
        assert_err(
            env.claim(&stranger, NAME, &wallet, &rec, None),
            "BadRecipient",
        );
        assert_err(env.register(&stranger, NAME, &wallet, &rec), "BadRecipient");
    }
    // A program (here this one): never registered, never paid.
    let program = env.program;
    let rec = record_for(&mut env, NAME, &program);
    assert_err(
        env.register(&stranger, NAME, &program, &rec),
        "BadRecipient",
    );
    assert!(env.claim(&stranger, NAME, &program, &rec, None).is_err());
    let dom = env.domain(NAME).unwrap();
    assert_eq!((dom.last_proof, dom.wallet), (0, Pubkey::default()));

    // Once the domain publishes the owner's wallet, both pools go there.
    let wallet = owner.pubkey();
    let rec = record_for(&mut env, NAME, &wallet);
    env.claim(&stranger, NAME, &wallet, &rec, Some(t)).unwrap();
    assert_eq!(token_balance(&env, &deposit_address), 1 + 995_000);
    let w0 = env.lamports(&wallet);
    env.claim(&stranger, NAME, &wallet, &rec, None).unwrap();
    assert_eq!(env.lamports(&wallet), w0 + SOL - SOL / 200);
}

// ---------- fees ----------

/// INFO. fee_of rounds down once per claim, so a pool claimed while it holds under
/// 10_000 / fee_bps base units (200 at 0.5%) pays no fee. The loss to the fee recipient is under
/// one base unit per claim; it only matters for a mint with very few decimals.
#[test]
fn small_claims_round_the_fee_to_zero() {
    let (mut env, _) = setup();
    let (t, auth) = create_mint(&mut env, TOKEN, 0, &[]);
    let alice = env.funded(10);
    mint_to(&mut env, t, &auth, &alice.pubkey(), 10_000);
    let wallet = Pubkey::new_unique();
    let rec = record_for(&mut env, NAME, &wallet);
    let relayer = env.funded(1);
    for _ in 0..5 {
        env.deposit_token(&alice, NAME, t, 199).unwrap();
        env.claim(&relayer, NAME, &wallet, &rec, Some(t)).unwrap();
    }
    assert_eq!(token_balance(&env, &ata(&wallet, &t.mint, &TOKEN)), 995);
    assert_eq!(env.fee_vault(&t.mint).unwrap().owed, 0);
    // The same 995 units in one claim pay 4.
    env.deposit_token(&alice, NAME, t, 995).unwrap();
    env.claim(&relayer, NAME, &wallet, &rec, Some(t)).unwrap();
    assert_eq!(env.fee_vault(&t.mint).unwrap().owed, 4);
}

// ---------- rent ----------

/// Scales the Rent sysvar's lamports per byte-year (its first field) by `num / den`.
fn scale_rent(env: &mut Env, num: u64, den: u64) {
    let id = Pubkey::from_str_const("SysvarRent111111111111111111111111111111111");
    let mut a = env.svm.get_account(&id).expect("rent sysvar");
    let per_byte = u64::from_le_bytes(a.data[..8].try_into().unwrap());
    a.data[..8].copy_from_slice(&(per_byte * num / den).to_le_bytes());
    env.svm.set_account(id, a).unwrap();
}

/// INFO. Every lamport move keeps the account at the current rent-exempt minimum
/// (check_lamports reads Rent at run time). A rent cut, as mainnet had, leaves the difference in
/// the pool as an uncounted remainder and changes nothing else. A rent rise would make SOL claims
/// fail with PoolUnderfunded and deposits to existing accounts fail Anchor's rent check, until
/// anyone tops the accounts up with a plain transfer; nothing is lost.
#[test]
fn rent_changes_never_move_counted_money() {
    let (mut env, _) = setup();
    let h = domain_hash(NAME);
    let pool = env.pool_pda(&h, &SOL_MINT);
    let domain = env.domain_pda(&h);
    let alice = env.funded(100);
    let wallet = env.funded(1).pubkey();
    let rec = record_for(&mut env, NAME, &wallet);
    let relayer = env.funded(10);
    env.deposit_sol(&alice, NAME, 3 * SOL).unwrap();
    let old_rent = env.rent(&pool);

    // Rent doubles.
    scale_rent(&mut env, 2, 1);
    assert_err(
        env.claim(&relayer, NAME, &wallet, &rec, None),
        "PoolUnderfunded",
    );
    assert_code(
        env.deposit_sol(&alice, NAME, SOL),
        ANCHOR_CONSTRAINT_RENT_EXEMPT,
    );
    // A top-up by anyone unblocks both; the claim pays the counted balance only.
    let top_pool = env.rent(&pool) - old_rent;
    let top_domain = env.rent(&domain) - env.lamports(&domain);
    env.send(
        &[
            system_instruction::transfer(&relayer.pubkey(), &pool, top_pool),
            system_instruction::transfer(&relayer.pubkey(), &domain, top_domain),
        ],
        &[&relayer],
    )
    .unwrap();
    let w0 = env.lamports(&wallet);
    env.claim(&relayer, NAME, &wallet, &rec, None).unwrap();
    assert_eq!(env.lamports(&wallet), w0 + 3 * SOL - 3 * SOL / 200);
    assert_eq!(env.lamports(&pool), env.rent(&pool));

    // Rent drops below where it started: the surplus stays put, payouts are still exact.
    scale_rent(&mut env, 1, 4);
    env.deposit_sol(&alice, NAME, SOL).unwrap();
    let surplus = env.lamports(&pool) - env.rent(&pool) - SOL;
    assert!(surplus > 0);
    let w0 = env.lamports(&wallet);
    env.claim(&relayer, NAME, &wallet, &rec, None).unwrap();
    assert_eq!(env.lamports(&wallet), w0 + SOL - SOL / 200);
    assert_eq!(env.lamports(&pool), env.rent(&pool) + surplus);
    assert_eq!(env.pool(NAME, &SOL_MINT).unwrap().balance, 0);
}

// ---------- held: attacks that fail ----------

/// HELD. A griefer funds every address the escrow will create before it exists (domain, pool,
/// deposit record, fee vault, the token vault and the wallet's and fee vault's token accounts).
/// Anchor and the associated token program adopt the funded addresses; deposits, claims and
/// refunds come out exact, and the griefer gets nothing back.
#[test]
fn prefunded_addresses_change_nothing() {
    let (mut env, fee_recipient) = setup();
    let (t, auth) = create_mint(&mut env, TOKEN_2022, 6, &[]);
    let h = domain_hash(NAME);
    let alice = env.funded(100);
    let griefer = env.funded(100);
    let wallet = env.funded(1).pubkey();
    let sol_pool = env.pool_pda(&h, &SOL_MINT);
    let tok_pool = env.pool_pda(&h, &t.mint);
    let fee_sol = env.fees_pda(&SOL_MINT);
    let fee_tok = env.fees_pda(&t.mint);
    let stash = 5 * SOL;
    let targets = [
        env.domain_pda(&h),
        sol_pool,
        tok_pool,
        env.deposit_pda(&sol_pool, &alice.pubkey()),
        env.deposit_pda(&tok_pool, &alice.pubkey()),
        fee_sol,
        fee_tok,
        ata(&tok_pool, &t.mint, &TOKEN_2022),
        ata(&wallet, &t.mint, &TOKEN_2022),
        ata(&fee_tok, &t.mint, &TOKEN_2022),
    ];
    let ixs: Vec<Instruction> = targets
        .iter()
        .map(|k| system_instruction::transfer(&griefer.pubkey(), k, stash))
        .collect();
    env.send(&ixs, &[&griefer]).unwrap();
    let g0 = env.lamports(&griefer.pubkey());

    mint_to(&mut env, t, &auth, &alice.pubkey(), 1_000_000);
    env.deposit_sol(&alice, NAME, 2 * SOL).unwrap();
    env.deposit_token(&alice, NAME, t, 1_000_000).unwrap();
    assert_eq!(env.pool(NAME, &SOL_MINT).unwrap().balance, 2 * SOL);
    assert_eq!(env.pool(NAME, &t.mint).unwrap().balance, 1_000_000);
    // The pool keeps the griefer's lamports on top of its own; the books ignore them.
    assert_eq!(env.lamports(&sol_pool), stash + 2 * SOL);

    let rec = record_for(&mut env, NAME, &wallet);
    let relayer = env.funded(10);
    let w0 = env.lamports(&wallet);
    env.claim(&relayer, NAME, &wallet, &rec, None).unwrap();
    env.claim(&relayer, NAME, &wallet, &rec, Some(t)).unwrap();
    assert_eq!(env.lamports(&wallet), w0 + 2 * SOL - 2 * SOL / 200);
    assert_eq!(
        token_balance(&env, &ata(&wallet, &t.mint, &TOKEN_2022)),
        1_000_000 - 5_000
    );
    assert_eq!(env.lamports(&sol_pool), stash);
    assert_eq!(env.fee_vault(&SOL_MINT).unwrap().owed, 2 * SOL / 200);
    assert_eq!(env.fee_vault(&t.mint).unwrap().owed, 5_000);

    // Fee withdrawals pay what is owed, not what the vault holds.
    env.svm.airdrop(&fee_recipient, SOL).unwrap();
    env.withdraw_fees(&relayer, None).unwrap();
    assert_eq!(env.lamports(&fee_recipient), SOL + 2 * SOL / 200);
    assert_eq!(env.lamports(&fee_sol), stash);

    // A deposit in the new epoch refunds exactly; the record's stashed lamports go to its owner.
    env.deposit_sol(&alice, NAME, SOL).unwrap();
    env.warp(REFUND_DELAY);
    let a0 = env.lamports(&alice.pubkey());
    env.refund(&alice, NAME, None).unwrap();
    assert_eq!(env.lamports(&alice.pubkey()), a0 + SOL + stash - TX_FEE);

    // The griefer has no record to refund and no way to the rest.
    assert_code(
        env.refund(&griefer, NAME, None),
        ANCHOR_ACCOUNT_NOT_INITIALIZED,
    );
    assert_eq!(env.lamports(&griefer.pubkey()), g0 - TX_FEE);
}

/// HELD. Records and pools of one domain can't be dressed up as another's: an account the program
/// owns, with the right discriminator and the other domain's data, at an address that isn't the
/// PDA, is refused by the seeds, and a Pool written at a domain's address naming another mint
/// can't pay from that mint's pool.
#[test]
fn forged_program_accounts_are_refused() {
    let (mut env, _) = setup();
    let (t, auth) = create_mint(&mut env, TOKEN, 6, &[]);
    let alice = env.funded(100);
    mint_to(&mut env, t, &auth, &alice.pubkey(), 1_000_001);
    env.deposit_sol(&alice, NAME, SOL).unwrap();
    env.deposit_token(&alice, NAME, t, 1).unwrap();
    env.deposit_token(&alice, OTHER, t, 1_000_000).unwrap();
    let thief = env.funded(10);
    let th = thief.pubkey();
    let rec = record_for(&mut env, NAME, &th);

    // A copy of OTHER's token pool, owned by the program, at a fresh address.
    let other_pool = env.pool_pda(&domain_hash(OTHER), &t.mint);
    let copy: Account = env.svm.get_account(&other_pool).unwrap();
    let fake = Pubkey::new_unique();
    env.svm.set_account(fake, copy).unwrap();
    let ix = env.claim_ix(&th, NAME, &th, &rec, &t.mint, Some(t));
    assert_code(
        env.send(&[swap(ix, 5, w(fake))], &[&thief]),
        ANCHOR_CONSTRAINT_SEEDS,
    );
    // OTHER's real pool under NAME's claim.
    let ix = env.claim_ix(&th, NAME, &th, &rec, &t.mint, Some(t));
    assert_code(
        env.send(&[swap(ix, 5, w(other_pool))], &[&thief]),
        ANCHOR_CONSTRAINT_SEEDS,
    );
    // NAME's SOL pool with OTHER's vault: the vault must belong to the pool being paid.
    let mut ix = env.claim_ix(&th, NAME, &th, &rec, &SOL_MINT, None);
    let tok = env.claim_ix(&th, OTHER, &th, &rec, &t.mint, Some(t));
    ix.accounts[8..14].clone_from_slice(&tok.accounts[8..14]);
    assert_err(env.send(&[ix], &[&thief]), "WrongMint");

    // NAME's legit claim (the record publishes the thief's key) pays NAME's pool and nothing else.
    env.claim(&thief, NAME, &th, &rec, None).unwrap();
    assert_eq!(env.pool(OTHER, &t.mint).unwrap().balance, 1_000_000);
    assert_eq!(
        token_balance(&env, &ata(&other_pool, &t.mint, &TOKEN)),
        1_000_000
    );
}

/// HELD. Closing a deposit record with a refund and opening it again never refunds twice, in one
/// transaction or across them, and a claim in between ends the refund of everything before it.
#[test]
fn reopened_deposit_records_never_refund_twice() {
    let (mut env, _) = setup();
    let h = domain_hash(NAME);
    let pool = env.pool_pda(&h, &SOL_MINT);
    let alice = env.funded(100);
    let bob = env.funded(100);
    env.deposit_sol(&alice, NAME, SOL).unwrap();
    env.deposit_sol(&bob, NAME, 2 * SOL).unwrap();
    env.warp(REFUND_DELAY);

    // Refund, deposit, refund in one transaction: the second refund is locked, all of it undone.
    let ixs = [
        env.refund_ix(&alice.pubkey(), NAME, None),
        env.deposit_sol_ix(&alice.pubkey(), NAME, 1),
        env.refund_ix(&alice.pubkey(), NAME, None),
    ];
    assert_err(env.send(&ixs, &[&alice]), "RefundLocked");
    // Refund twice in one transaction: the record is gone after the first.
    let ixs = [
        env.refund_ix(&alice.pubkey(), NAME, None),
        env.refund_ix(&alice.pubkey(), NAME, None),
    ];
    assert_code(env.send(&ixs, &[&alice]), ANCHOR_ACCOUNT_NOT_INITIALIZED);
    assert_eq!(env.pool(NAME, &SOL_MINT).unwrap().balance, 3 * SOL);

    env.refund(&alice, NAME, None).unwrap();
    env.deposit_sol(&alice, NAME, SOL / 2).unwrap();
    let wallet = env.funded(1).pubkey();
    let rec = record_for(&mut env, NAME, &wallet);
    let relayer = env.funded(1);
    env.claim(&relayer, NAME, &wallet, &rec, None).unwrap();
    env.warp(REFUND_DELAY);
    assert_err(env.refund(&alice, NAME, None), "NothingToRefund");
    assert_err(env.refund(&bob, NAME, None), "NothingToRefund");
    assert_eq!(env.lamports(&pool), env.rent(&pool));
}
