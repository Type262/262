//! P-256 (algorithm 13) and Ed25519 (15) steps, whose signatures the native precompiles check and
//! the program finds through the instructions sysvar. Needs the precompiles feature (WSL, see
//! README.md); the real chains in dnssec_real.rs run their P-256/Ed25519 steps with it too.
#![cfg(feature = "precompiles")]

mod dnssec_util;

use dnssec_util::*;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction_error::TransactionError;
use type262_tests::*;

/// cloudflare.com's chain with the root and com. DS verified, and the payer.
fn cloudflare() -> (Env, Keypair, Chain) {
    let mut env = Env::new();
    set_time(&mut env, FIXTURE_TIME);
    let payer = env.funded(100);
    let chain = Chain::load("cloudflare.com.json");
    for step in &chain.steps[..2] {
        prove(&mut env, &payer, step, &chain.signing_key(step)).unwrap();
    }
    (env, payer, chain)
}

/// The transaction failed in the precompile instruction at `index`, not in the program.
fn precompile_failed(r: TxResult, index: u8) {
    match r {
        Err(f) => assert!(
            matches!(f.err, TransactionError::InstructionError(i, _) if i == index),
            "expected a precompile failure at {index}, got {:?}",
            f.err
        ),
        Ok(_) => panic!("expected a precompile failure"),
    }
}

/// A precompile entry whose message sits in the precompile instruction's own data.
fn self_contained(program: Pubkey, pk: &[u8], sig: &[u8], msg: &[u8]) -> Instruction {
    let mut d = vec![1u8, 0];
    let pk_off = 16u16;
    let sig_off = pk_off + pk.len() as u16;
    let msg_off = sig_off + sig.len() as u16;
    for v in [
        sig_off,
        u16::MAX,
        pk_off,
        u16::MAX,
        msg_off,
        msg.len() as u16,
        u16::MAX,
    ] {
        d.extend_from_slice(&v.to_le_bytes());
    }
    d.extend_from_slice(pk);
    d.extend_from_slice(sig);
    d.extend_from_slice(msg);
    Instruction {
        program_id: program,
        accounts: vec![],
        data: d,
    }
}

#[test]
fn high_s_signatures_are_sent_normalized() {
    let (mut env, payer, chain) = cloudflare();
    let me = payer.pubkey();
    // In the real chain 2 of the 4 P-256 signatures have s > n/2.
    let high: Vec<&Step> = chain
        .steps
        .iter()
        .filter(|s| s.alg() == 13 && low_s(&s.sig).1)
        .collect();
    assert_eq!(high.len(), 2);
    let keys = &chain.steps[2]; // com. DNSKEY
    let key = chain.signing_key(keys);
    let (program, pk) = precompile_key(&key);
    let (normal, flipped) = low_s(&keys.sig);
    if flipped {
        // As DNS serves it, the precompile refuses it.
        let ixs = [
            precompile_ix(
                program,
                &[(
                    pk.clone(),
                    keys.sig.clone(),
                    1,
                    SIGNED_OFFSET,
                    keys.signed.len() as u16,
                )],
            ),
            precompiled_ix(&env, &me, keys),
        ];
        precompile_failed(env.send(&ixs, &[&payer]), 0);
    }
    let ixs = [
        precompile_ix(
            program,
            &[(pk, normal, 1, SIGNED_OFFSET, keys.signed.len() as u16)],
        ),
        precompiled_ix(&env, &me, keys),
    ];
    let cu = env.send(&ixs, &[&payer]).unwrap().compute_units_consumed;
    println!(
        "com. DNSKEY (P-256, {} signed bytes): {cu} CU",
        keys.signed.len()
    );
}

#[test]
fn the_precompile_must_have_checked_our_exact_bytes() {
    let (mut env, payer, chain) = cloudflare();
    let me = payer.pubkey();
    let keys = &chain.steps[2];
    let key = chain.signing_key(keys);
    let (program, entry) = entry_for(keys, &key, 1);

    // Our bytes changed under the same signature: the precompile itself fails.
    let tampered = keys.flip(keys.signed.len() - 1, 1);
    let ixs = [
        precompile_ix(program, &[entry.clone()]),
        precompiled_ix(&env, &me, &tampered),
    ];
    precompile_failed(env.send(&ixs, &[&payer]), 0);

    // A valid check of the same bytes, but held in the precompile instruction instead of ours:
    // the program can't know those bytes are what it parsed, so it refuses.
    let ixs = [
        self_contained(program, &entry.0, &entry.1, &keys.signed),
        precompiled_ix(&env, &me, keys),
    ];
    assert_err(env.send(&ixs, &[&payer]), "NoKeyVerified");
    // No precompile instruction at all.
    assert_err(
        env.send(&[precompiled_ix(&env, &me, keys)], &[&payer]),
        "NoKeyVerified",
    );
    // The entry pointing at another instruction index.
    let mut other = entry.clone();
    other.2 = 0;
    let ixs = [
        precompile_ix(program, &[other]),
        precompiled_ix(&env, &me, keys),
    ];
    precompile_failed(env.send(&ixs, &[&payer]), 0);
    // A P-256 set through the RSA instruction.
    let ixs = [
        precompile_ix(program, &[entry.clone()]),
        verify_ix(&env, &me, keys),
    ];
    assert_err(env.send(&ixs, &[&payer]), "WrongInstructionForAlgorithm");

    let ixs = [
        precompile_ix(program, &[entry]),
        precompiled_ix(&env, &me, keys),
    ];
    env.send(&ixs, &[&payer]).unwrap();
    assert!(rrset(&env, &wire_name("com", None), TYPE_DNSKEY).is_some());
}

#[test]
fn several_p256_steps_share_one_transaction() {
    let (mut env, payer, chain) = cloudflare();
    let me = payer.pubkey();
    let com_keys = &chain.steps[2];
    prove(&mut env, &payer, com_keys, &chain.signing_key(com_keys)).unwrap();
    // cloudflare.com. DS (under com. DNSKEY) and DNSKEY (under that DS): one precompile
    // instruction with an entry per step, then the two steps in order.
    let (ds, keys) = (&chain.steps[3], &chain.steps[4]);
    let (program, e1) = entry_for(ds, &chain.signing_key(ds), 1);
    let (_, e2) = entry_for(keys, &chain.signing_key(keys), 2);
    let ixs = [
        precompile_ix(program, &[e1, e2]),
        precompiled_ix(&env, &me, ds),
        precompiled_ix(&env, &me, keys),
    ];
    let size = legacy_size(&ixs, &me);
    assert!(size <= LEGACY_MAX);
    let cu = env.send(&ixs, &[&payer]).unwrap().compute_units_consumed;
    println!("cloudflare.com. DS + DNSKEY in one {size}-byte transaction: {cu} CU");
    assert!(rrset(&env, &wire_name("cloudflare.com", None), TYPE_DNSKEY).is_some());
    // The 2936-byte apex TXT needs a v1 transaction.
    let txt_step = chain.leaf();
    let (mode, cu) = prove(&mut env, &payer, txt_step, &chain.signing_key(txt_step)).unwrap();
    assert_eq!(mode, Mode::PrecompiledV1);
    println!(
        "cloudflare.com. TXT ({} signed bytes, v1 transaction): {cu} CU",
        txt_step.signed.len()
    );
}

#[test]
fn an_ed25519_zone() {
    let mut env = Env::new();
    let payer = env.funded(100);
    let me = payer.pubkey();
    let now = env.now();
    let key = TestKey::ed25519();
    let test = b"\x04test\x00";
    put_rrset(
        &mut env,
        test,
        TYPE_DNSKEY,
        &[key.dnskey(257)],
        now - 60,
        now + 86_400,
    );
    let owner = b"\x07_wallet\x02ed\x04test\x00";
    let wallet = Pubkey::new_unique();
    let records = [txt(&format!("SOL {wallet}"))];

    let leaf = synthetic(&Sig::new(test, now), &key, owner, TYPE_TXT, &records);
    let (mode, cu) = prove(&mut env, &payer, &leaf, &key.dnskey(257)).unwrap();
    assert_eq!(mode, Mode::Precompiled);
    println!(
        "Ed25519 _wallet TXT ({} signed bytes): {cu} CU",
        leaf.signed.len()
    );
    assert_eq!(
        rrset(&env, owner, TYPE_TXT).unwrap().records(),
        records.to_vec()
    );

    // Validly signed, but by a key the zone doesn't have (same key tag claimed).
    let stranger = TestKey::ed25519();
    let sig = Sig {
        key_tag: Some(key_tag(&key.dnskey(257))),
        inception: (now - 30) as u32,
        ..Sig::new(test, now)
    };
    let forged = synthetic(&sig, &stranger, owner, TYPE_TXT, &records);
    let (program, entry) = entry_for(&forged, &stranger.dnskey(257), 1);
    let ixs = [
        precompile_ix(program, &[entry]),
        precompiled_ix(&env, &me, &forged),
    ];
    assert_err(env.send(&ixs, &[&payer]), "NoKeyVerified");

    // A wildcard expansion signed by the right key.
    let wild = synthetic(
        &Sig {
            labels: Some(2),
            ..Sig::new(test, now)
        },
        &key,
        owner,
        TYPE_TXT,
        &records,
    );
    let r = prove(&mut env, &payer, &wild, &key.dnskey(257));
    assert_eq!(code(r), Some(err_code("InvalidLabelCount")));
    // An Ed25519 set through the RSA instruction.
    let ix = verify_ix(&env, &me, &leaf);
    assert_err(env.send(&[ix], &[&payer]), "WrongInstructionForAlgorithm");
}
