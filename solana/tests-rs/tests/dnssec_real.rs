//! The six real proofs in bench/fixtures, verified from the IANA root anchors through the real
//! instructions: every step, cache sharing between domains, expiry and closing, and tampered
//! copies. RSA steps run everywhere; P-256 and Ed25519 steps need the precompiles feature (WSL,
//! see README.md) and are skipped, with everything below them, without it.
//!
//!   cargo test --test dnssec_real -- --nocapture     prints the compute units of every step

mod dnssec_util;

use dnssec_util::*;
use solana_signer::Signer;
use std::collections::HashMap;
use type262_tests::*;

const PRECOMPILES: bool = cfg!(feature = "precompiles");

fn env_at(t: i64) -> Env {
    let mut env = Env::new();
    set_time(&mut env, t);
    env
}

/// The cache entry a step writes.
fn target(env: &Env, step: &Step) -> Pubkey {
    rrset_address(env, &step.owner(), step.rrtype())
}

/// Can this step run here: its algorithm is available and its parent is cached.
fn runnable(env: &Env, step: &Step) -> bool {
    (PRECOMPILES || !step.precompiled())
        && step
            .parent()
            .is_none_or(|(o, t)| rrset(env, &o, t).is_some())
}

/// Verifies every runnable step of `chain` in order; returns the steps that ran and their CU.
fn prove_chain(
    env: &mut Env,
    payer: &solana_keypair::Keypair,
    chain: &Chain,
) -> Vec<(String, Mode, u64)> {
    let mut out = Vec::new();
    for step in &chain.steps {
        if !runnable(env, step) {
            continue;
        }
        let key = chain.signing_key(step);
        let (mode, cu) = prove(env, payer, step, &key).unwrap_or_else(|f| {
            panic!(
                "{} {}: {:?}\n{}",
                chain.name,
                step.label,
                f.err,
                f.logs.join("\n")
            )
        });
        out.push((step.label.clone(), mode, cu));
    }
    out
}

#[test]
fn six_real_chains_verify_from_the_root() {
    let mut env = env_at(FIXTURE_TIME);
    let payer = env.funded(100);
    // expires_at each entry must get: the earliest RRSIG expiration on its path to the root.
    let mut expiry: HashMap<(Vec<u8>, u16), i64> = HashMap::new();

    println!(
        "\n{:<28} {:<26} {:>3} {:>5} {:>6} {:>4} {:<14} {:>9}",
        "chain", "step", "alg", "bits", "signed", "sig", "mode", "CU"
    );
    for file in CHAINS {
        let chain = Chain::load(file);
        for step in &chain.steps {
            let parent_expiry = match step.parent() {
                None => i64::MAX,
                Some(p) => match expiry.get(&p) {
                    Some(e) => *e,
                    None => {
                        println!(
                            "{:<28} {:<26} skipped: parent not verified",
                            chain.name, step.label
                        );
                        continue;
                    }
                },
            };
            if !runnable(&env, step) {
                println!(
                    "{:<28} {:<26} skipped: needs the precompiles feature",
                    chain.name, step.label
                );
                continue;
            }
            let address = target(&env, step);
            let before = raw(&env, &address);
            let key = chain.signing_key(step);
            let (mode, cu) = prove(&mut env, &payer, step, &key).unwrap_or_else(|f| {
                panic!(
                    "{} {}: {:?}\n{}",
                    chain.name,
                    step.label,
                    f.err,
                    f.logs.join("\n")
                )
            });
            let cached: RrSet = env.account(&address).expect("cached");
            let want_expiry = (step.expiration() as i64).min(parent_expiry);
            if let Some(before) = before {
                // Shared with an earlier chain (root, nl.): the same signature again changes nothing.
                assert_eq!(
                    raw(&env, &address).unwrap(),
                    before,
                    "{} rewritten",
                    step.label
                );
            }
            assert_eq!(cached.owner, step.owner());
            assert_eq!(cached.rrtype, step.rrtype());
            assert_eq!(
                (cached.algorithm, cached.key_tag),
                (step.alg(), step.key_tag())
            );
            assert_eq!(cached.records(), step.records());
            assert_eq!(cached.signed_at, step.inception() as i64);
            assert_eq!(cached.expires_at, want_expiry);
            expiry.insert((step.owner(), step.rrtype()), want_expiry);
            println!(
                "{:<28} {:<26} {:>3} {:>5} {:>6} {:>4} {:<14} {:>9}",
                chain.name,
                step.label,
                step.alg(),
                key_bits(&key),
                step.signed.len(),
                step.sig.len(),
                format!("{mode:?}"),
                cu
            );
            if step.alg() == 8 {
                assert!(cu < 1_400_000);
            }
        }
        if PRECOMPILES {
            let leaf = chain.leaf();
            assert!(
                rrset(&env, &leaf.owner(), leaf.rrtype()).is_some(),
                "{} leaf",
                chain.name
            );
        }
    }
    // Without precompiles the all-RSA chain still verifies to its leaf, and so does every TLD
    // DS set, all signed by the one cached root key set.
    let gem = Chain::load("_wallet.gemprotocol.io.json");
    assert!(rrset(&env, &gem.leaf().owner(), TYPE_TXT).is_some());
    for tld in ["com", "nl", "org", "gov", "io"] {
        assert!(
            rrset(&env, &wire_name(tld, None), TYPE_DS).is_some(),
            "{tld}. DS"
        );
    }
}

#[test]
fn the_gemprotocol_wallet_record_is_an_evm_line() {
    // The one real _wallet record: RSA from the root down, publishing an ETH address only.
    let mut env = env_at(FIXTURE_TIME);
    let payer = env.funded(100);
    let chain = Chain::load("_wallet.gemprotocol.io.json");
    let ran = prove_chain(&mut env, &payer, &chain);
    assert_eq!(ran.len(), 6);
    let modes: Vec<Mode> = ran.iter().map(|r| r.1).collect();
    assert_eq!(
        modes,
        [
            Mode::Buffered,
            Mode::Inline,
            Mode::Buffered,
            Mode::Inline,
            Mode::Inline,
            Mode::Inline
        ]
    );
    let leaf: RrSet = rrset(
        &env,
        &wire_name("gemprotocol.io", Some("_wallet")),
        TYPE_TXT,
    )
    .unwrap();
    assert_eq!(
        leaf.records(),
        vec![txt("ETH 0x7edB9dC3a47bf0E8D59649B11Ee2Fb64b2BcE81f")]
    );
    assert_eq!(leaf.payer, payer.pubkey());
    // Valid until the earliest expiration on its path: io. DS, 12.9 days after fetching.
    let io_ds = &chain.steps[1];
    assert_eq!(leaf.expires_at, io_ds.expiration() as i64);

    // dnssec::wallet_signed_at (through escrow::register) accepts it as the domain's verified
    // record, but it names no Solana wallet, so nothing can register or claim with it.
    let record = rrset_address(
        &env,
        &wire_name("gemprotocol.io", Some("_wallet")),
        TYPE_TXT,
    );
    let r = register(&mut env, &payer, "gemprotocol.io", record, payer.pubkey());
    assert_err(r, "WalletNotPublished");
    let r = register(&mut env, &payer, "gemprotocol.com", record, payer.pubkey());
    assert_err(r, "NotAWalletRecord");
    // The buffer of each buffered step was closed by its verify.
    assert!(env
        .svm
        .get_account(&env.buffer_pda(&payer.pubkey()))
        .is_none_or(|a| a.lamports == 0));
}

#[test]
fn two_domains_under_one_tld_share_its_cache() {
    let mut env = env_at(FIXTURE_TIME);
    let payer = env.funded(100);
    let first = Chain::load("nlnetlabs.nl.json");
    let second = Chain::load("ed25519.nl.json");
    prove_chain(&mut env, &payer, &first);

    // The second domain's proof starts with the same root, nl. DS and nl. DNSKEY sets: a client
    // finds them cached with the same records and skips them.
    let shared: Vec<&Step> = second
        .steps
        .iter()
        .filter(|s| {
            rrset(&env, &s.owner(), s.rrtype())
                .is_some_and(|c| c.records() == s.records() && c.signed_at == s.inception() as i64)
        })
        .collect();
    let labels: Vec<&str> = shared.iter().map(|s| s.label.as_str()).collect();
    if PRECOMPILES {
        assert_eq!(labels, [". DNSKEY", "nl. DS", "nl. DNSKEY"]);
    } else {
        assert_eq!(labels, [". DNSKEY", "nl. DS"]);
    }
    // Verifying a shared set again (a client that didn't look) succeeds and changes nothing.
    let nl_ds = &second.steps[1];
    let before = raw(&env, &target(&env, nl_ds)).unwrap();
    let (_, cu) = prove(&mut env, &payer, nl_ds, &second.signing_key(nl_ds)).unwrap();
    assert_eq!(raw(&env, &target(&env, nl_ds)).unwrap(), before);
    println!("nl. DS again (cache already as new): {cu} CU, no write");

    if PRECOMPILES {
        // Only ed25519.nl's own sets are left: DS (P-256, under the cached nl. DNSKEY), DNSKEY
        // and A (Ed25519).
        let mut ran = Vec::new();
        for step in &second.steps[3..] {
            let (mode, cu) = prove(&mut env, &payer, step, &second.signing_key(step)).unwrap();
            ran.push((step.label.clone(), mode, cu));
        }
        println!("ed25519.nl. with nl. cached: {ran:?}");
        assert!(rrset(&env, &wire_name("ed25519.nl", None), TYPE_A).is_some());
    }
}

#[test]
fn entries_expire_with_their_chain_and_close_to_the_payer() {
    let mut env = env_at(FIXTURE_TIME);
    let payer = env.funded(100);
    let chain = Chain::load("_wallet.gemprotocol.io.json");
    prove_chain(&mut env, &payer, &chain);
    let (root, io_ds, io_keys, gem_ds) = (
        &chain.steps[0],
        &chain.steps[1],
        &chain.steps[2],
        &chain.steps[3],
    );
    let leaf_address = target(&env, chain.leaf());
    let leaf: RrSet = env.account(&leaf_address).unwrap();
    let end = io_ds.expiration() as i64;
    assert_eq!(leaf.expires_at, end);

    // Not before it expires, by anyone; at the last valid second still not.
    let stranger = env.funded(1);
    let ix = close_rrset_ix(&env, leaf_address, payer.pubkey());
    assert_err(env.send(&[ix.clone()], &[&stranger]), "RRsetNotExpired");
    set_time(&mut env, end);
    assert_err(env.send(&[ix.clone()], &[&stranger]), "RRsetNotExpired");

    set_time(&mut env, end + 3600);
    // io. DS's own signature has expired: it can't be verified again.
    let r = prove(&mut env, &payer, io_ds, &chain.signing_key(io_ds));
    assert_eq!(code(r), Some(err_code("SignatureExpired")));
    // io. DNSKEY's signature is still valid, but the cached io. DS it needs is not.
    assert!((io_keys.expiration() as i64) > end + 3600);
    env.close_buffer(&payer).ok();
    let r = prove(&mut env, &payer, io_keys, &chain.signing_key(io_keys));
    assert_eq!(code(r), Some(err_code("ParentExpired")));
    env.close_buffer(&payer).unwrap();
    // gemprotocol.io. DS checks against io. DNSKEY, whose entry expired with io. DS.
    let r = prove(&mut env, &payer, gem_ds, &chain.signing_key(gem_ds));
    assert_eq!(code(r), Some(err_code("ParentExpired")));

    // Now anyone can close the leaf; the rent goes to the payer recorded in it, never elsewhere.
    let other = env.funded(1);
    let wrong = close_rrset_ix(&env, leaf_address, other.pubkey());
    assert_err(env.send(&[wrong], &[&stranger]), "WrongPayer");
    let rent = env.lamports(&leaf_address);
    let before = env.lamports(&payer.pubkey());
    env.send(&[ix], &[&stranger]).unwrap();
    assert!(env
        .svm
        .get_account(&leaf_address)
        .is_none_or(|a| a.lamports == 0));
    assert_eq!(env.lamports(&payer.pubkey()), before + rent);

    // The root key set is still valid (20 days) and stays.
    let root_entry: RrSet = env.account(&target(&env, root)).unwrap();
    assert!(root_entry.expires_at > env.now());
    let ix = close_rrset_ix(&env, target(&env, root), payer.pubkey());
    assert_err(env.send(&[ix], &[&stranger]), "RRsetNotExpired");
}

#[test]
fn the_root_key_set_takes_two_legacy_transactions() {
    // 1,108 bytes to upload: one write_buffer transaction, then the last chunk rides in the
    // verifying transaction itself, as docs/DNSSEC.md lays it out.
    let mut env = env_at(FIXTURE_TIME);
    let payer = env.funded(100);
    let me = payer.pubkey();
    let chain = Chain::load("cloudflare.com.json");
    let root = &chain.steps[0];
    let payload = buffer_payload(root);
    assert_eq!(payload.len(), 1108);
    let split = payload.len() - 800;
    env.write_buffer(&payer, 0, &payload[..split]).unwrap();
    let ixs = [
        cu_limit(1_400_000),
        env.write_buffer_ix(&me, split as u32, &payload[split..]),
        buffered_ix(&env, &me, root),
    ];
    let size = legacy_size(&ixs, &me);
    assert!(size <= LEGACY_MAX, "{size} bytes");
    let cu = env.send(&ixs, &[&payer]).unwrap().compute_units_consumed;
    println!(
        "root DNSKEY: write_buffer + verify_rrset_buffered in one {size}-byte transaction, {cu} CU"
    );
    assert!(rrset(&env, &[0], TYPE_DNSKEY).is_some());
}

#[test]
fn not_valid_before_the_inception() {
    let chain = Chain::load("_wallet.gemprotocol.io.json");
    let root = &chain.steps[0];
    let mut env = env_at(root.inception() as i64 - 1);
    let payer = env.funded(100);
    let r = prove(&mut env, &payer, root, &chain.signing_key(root));
    assert_eq!(code(r), Some(err_code("SignatureNotValidYet")));
    set_time(&mut env, root.inception() as i64);
    prove(&mut env, &payer, root, &chain.signing_key(root)).unwrap();
}

#[test]
fn tampered_real_proofs_are_rejected() {
    let mut env = env_at(FIXTURE_TIME);
    let payer = env.funded(100);
    let me = payer.pubkey();
    let chain = Chain::load("_wallet.gemprotocol.io.json");
    let (root, io_ds) = (&chain.steps[0], &chain.steps[1]);
    // Tampered copies are signed by the original's key (looked up before tampering).
    let fail = |env: &mut Env, step: &Step, name: &str| {
        let key = chain.signing_key(if step.signed[..18] == root.signed[..18] {
            root
        } else {
            io_ds
        });
        let r = prove(env, &payer, step, &key);
        let got = r.as_ref().err().and_then(|f| f.code());
        assert_eq!(
            got,
            Some(err_code(name)),
            "{}: {:?}",
            step.label,
            r.err().map(|f| f.logs)
        );
        env.close_buffer(&payer).ok();
    };

    // The root key set with one signature bit flipped (buffered RSA-2048), or one key byte.
    let mut bad = root.clone();
    bad.sig[100] ^= 1;
    fail(&mut env, &bad, "NoKeyVerified");
    fail(&mut env, &root.flip(400, 1), "NoKeyVerified");
    prove(&mut env, &payer, root, &chain.signing_key(root)).unwrap();

    // io. DS with a changed digest byte, a changed signature, or one byte of the RRSIG header.
    let last = io_ds.signed.len() - 1;
    fail(&mut env, &io_ds.flip(last, 1), "NoKeyVerified");
    let mut bad = io_ds.clone();
    bad.sig[0] ^= 0x40;
    fail(&mut env, &bad, "NoKeyVerified");
    fail(&mut env, &io_ds.flip(4, 1), "NoKeyVerified"); // original TTL: signed too
                                                        // Labels field lowered: what a wildcard expansion looks like.
    fail(&mut env, &io_ds.flip(3, 1), "InvalidLabelCount");
    // Covered type changed: the records no longer match it.
    fail(&mut env, &io_ds.flip(1, 1), "SignatureTypeMismatch");
    // Algorithm changed to an unsupported one.
    fail(&mut env, &io_ds.flip(2, 2), "UnsupportedAlgorithm");
    prove(&mut env, &payer, io_ds, &chain.signing_key(io_ds)).unwrap();

    // The caller can't choose the parent or the result: io. DS against anything but the root
    // key set, or written anywhere but its own PDA.
    let io_ds_addr = target(&env, io_ds);
    let root_addr = target(&env, root);
    let send = |env: &mut Env, parent: Option<Pubkey>, result: Pubkey| {
        let ix = env.ix(
            "verify_rrset",
            &(io_ds.signed.clone(), io_ds.sig.clone()),
            verify_accounts(env, &me, parent, result),
        );
        env.send(&[cu_limit(1_400_000), ix], &[&payer])
    };
    assert_err(send(&mut env, Some(io_ds_addr), io_ds_addr), "WrongParent");
    assert_err(send(&mut env, None, io_ds_addr), "WrongParent");
    assert_err(send(&mut env, Some(me), io_ds_addr), "WrongParent");
    assert_err(
        send(&mut env, Some(root_addr), root_addr),
        "WrongRRsetAccount",
    );
    let elsewhere = rrset_address(&env, &wire_name("com", None), TYPE_DS);
    assert_err(
        send(&mut env, Some(root_addr), elsewhere),
        "WrongRRsetAccount",
    );
    send(&mut env, Some(root_addr), io_ds_addr).unwrap();

    // An RSA set sent to the precompile instruction.
    let ix = precompiled_ix(&env, &me, io_ds);
    assert_err(env.send(&[ix], &[&payer]), "WrongInstructionForAlgorithm");
}
