//! Security review of the precompile path (DNSSEC algorithms 13 and 15): what the program finds
//! in the instructions sysvar must be a check of exactly the bytes it parses. Ed25519 zones
//! signed with throwaway keys. Needs the precompiles feature (WSL, see README.md).
//!
//! Every test here is an attack the program already refuses; they stay as regression tests.
#![cfg(feature = "precompiles")]

mod dnssec_util;

use dnssec_util::*;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction_error::TransactionError;
use type262_tests::*;

const ZONE: &[u8] = b"\x02ed\x04test\x00";
const LEAF: &[u8] = b"\x07_wallet\x02ed\x04test\x00";

/// ed.test.'s Ed25519 key set cached for a day.
fn ed_zone() -> (Env, Keypair, TestKey, i64) {
    let mut env = Env::new();
    let payer = env.funded(100);
    let now = env.now();
    let key = TestKey::ed25519();
    put_rrset(
        &mut env,
        ZONE,
        TYPE_DNSKEY,
        &[key.dnskey(257)],
        now - 60,
        now + 86_400,
    );
    (env, payer, key, now)
}

fn sol(wallet: &Pubkey) -> Vec<u8> {
    txt(&format!("SOL {wallet}"))
}

fn leaf(key: &TestKey, inception: i64, now: i64, wallet: &Pubkey) -> Step {
    let sig = Sig {
        inception: inception as u32,
        ..Sig::new(ZONE, now)
    };
    synthetic(&sig, key, LEAF, TYPE_TXT, &[sol(wallet)])
}

/// One more record in wire form: [owner, type, IN, TTL 300, rdlength, rdata].
fn rr(owner: &[u8], rrtype: u16, rdata: &[u8]) -> Vec<u8> {
    let mut v = owner.to_vec();
    v.extend_from_slice(&rrtype.to_be_bytes());
    v.extend_from_slice(&1u16.to_be_bytes());
    v.extend_from_slice(&300u32.to_be_bytes());
    v.extend_from_slice(&(rdata.len() as u16).to_be_bytes());
    v.extend_from_slice(rdata);
    v
}

fn failed_at(r: &TxResult) -> Option<u8> {
    match r {
        Err(Failure {
            err: TransactionError::InstructionError(i, _),
            ..
        }) => Some(*i),
        _ => None,
    }
}

/// A valid entry over the signed set, while the instruction's own Vec<u8> runs on with a record
/// for the attacker's wallet: the precompile checked a prefix of what the program parses.
#[test]
fn bytes_past_the_checked_message_are_not_signed() {
    let (mut env, payer, key, now) = ed_zone();
    let me = payer.pubkey();
    let (victim, attacker) = (Pubkey::new_unique(), Pubkey::new_unique());
    let good = leaf(&key, now - 3600, now, &victim);
    let mut longer = good.clone();
    longer.signed.extend(rr(LEAF, TYPE_TXT, &sol(&attacker)));

    let (program, entry) = entry_for(&good, &key.dnskey(257), 1);
    let ixs = [
        precompile_ix(program, &[entry]),
        precompiled_ix(&env, &me, &longer),
    ];
    assert_err(env.send(&ixs, &[&payer]), "NoKeyVerified");
    // An entry over all of it, with the signature of the shorter set, fails in the precompile.
    let (_, mut whole) = entry_for(&longer, &key.dnskey(257), 1);
    whole.1 = good.sig.clone();
    let ixs = [
        precompile_ix(program, &[whole]),
        precompiled_ix(&env, &me, &longer),
    ];
    let r = env.send(&ixs, &[&payer]);
    assert_eq!(failed_at(&r), Some(0));
    assert!(rrset(&env, LEAF, TYPE_TXT).is_none());

    let (program, entry) = entry_for(&good, &key.dnskey(257), 1);
    let ixs = [
        precompile_ix(program, &[entry]),
        precompiled_ix(&env, &me, &good),
    ];
    env.send(&ixs, &[&payer]).unwrap();
    let record = rrset_address(&env, LEAF, TYPE_TXT);
    assert_err(
        register(&mut env, &payer, "ed.test", record, attacker),
        "WalletNotPublished",
    );
}

/// The precompile instruction may come after the step: the transaction is atomic, so a bad
/// signature there undoes the step that ran first.
#[test]
fn a_precompile_after_the_step_still_binds_it() {
    let (mut env, payer, key, now) = ed_zone();
    let me = payer.pubkey();
    let first = leaf(&key, now - 3600, now, &Pubkey::new_unique());
    let (program, entry) = entry_for(&first, &key.dnskey(257), 0);
    let ixs = [
        precompiled_ix(&env, &me, &first),
        precompile_ix(program, &[entry]),
    ];
    env.send(&ixs, &[&payer]).unwrap();
    let before = raw(&env, &rrset_address(&env, LEAF, TYPE_TXT)).unwrap();

    let attacker = Pubkey::new_unique();
    let mut forged = leaf(&key, now - 60, now, &attacker);
    forged.sig[5] ^= 1;
    let (program, entry) = entry_for(&forged, &key.dnskey(257), 0);
    let ixs = [
        precompiled_ix(&env, &me, &forged),
        precompile_ix(program, &[entry]),
    ];
    let r = env.send(&ixs, &[&payer]);
    println!(
        "bad signature in a precompile after the step: failed at instruction {:?}",
        failed_at(&r)
    );
    assert!(r.is_err());
    assert_eq!(
        raw(&env, &rrset_address(&env, LEAF, TYPE_TXT)).unwrap(),
        before
    );
}

/// An entry names one instruction index; a second step with identical data elsewhere in the
/// transaction finds no check of its own.
#[test]
fn one_entry_binds_one_instruction() {
    let (mut env, payer, key, now) = ed_zone();
    let me = payer.pubkey();
    let first = leaf(&key, now - 3600, now, &Pubkey::new_unique());
    let (program, entry) = entry_for(&first, &key.dnskey(257), 1);
    let ixs = [
        precompile_ix(program, &[entry]),
        precompiled_ix(&env, &me, &first),
        precompiled_ix(&env, &me, &first),
    ];
    let r = env.send(&ixs, &[&payer]);
    assert_eq!(failed_at(&r), Some(2));
    assert_err(r, "NoKeyVerified");
    assert!(rrset(&env, LEAF, TYPE_TXT).is_none());
}
