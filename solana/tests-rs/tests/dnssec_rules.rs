//! Every DNSSEC rule through the real instructions, on synthetic zones signed with throwaway RSA
//! keys (runs everywhere). Only the IANA root keys can start a chain from the anchors, so these
//! zones hang below a "test." key set written straight into its cache PDA.

mod dnssec_util;

use dnssec_util::*;
use solana_keypair::Keypair;
use solana_signer::Signer;
use type262_tests::*;

const TEST: &[u8] = b"\x04test\x00";
const EXAMPLE: &[u8] = b"\x07example\x04test\x00";
const WALLET_TXT: &[u8] = b"\x07_wallet\x07example\x04test\x00";

struct Zone {
    env: Env,
    payer: Keypair,
    /// Signs for "test."; its key set is cached until `now + 30 days`.
    k0: TestKey,
    /// Signs for "example.test." (once its DS and DNSKEY sets are verified).
    k1: TestKey,
    now: i64,
}

fn zone() -> Zone {
    let mut env = Env::new();
    let payer = env.funded(100);
    let now = env.now();
    let (k0, k1) = (TestKey::rsa(0, 8), TestKey::rsa(1, 8));
    put_rrset(
        &mut env,
        TEST,
        TYPE_DNSKEY,
        &[k0.dnskey(257)],
        now - 86_400,
        now + 30 * 86_400,
    );
    Zone {
        env,
        payer,
        k0,
        k1,
        now,
    }
}

impl Zone {
    fn prove(&mut self, step: &Step, key: &TestKey) -> Result<(Mode, u64), Failure> {
        let dnskey = key.dnskey(257);
        prove(&mut self.env, &self.payer, step, &dnskey)
    }

    fn expect(&mut self, step: &Step, key: &TestKey, name: &str) {
        let r = self.prove(step, key);
        if r.is_ok() {
            panic!("{}: expected {name}, but it verified", step.label);
        }
        let f = r.err().unwrap();
        assert_eq!(
            f.code(),
            Some(err_code(name)),
            "{}: {:?}\n{}",
            step.label,
            f.err,
            f.logs.join("\n")
        );
        self.env.close_buffer(&self.payer).ok();
    }

    /// For sets the test's own parser can't derive accounts from: example.test.'s key set as
    /// parent, any result address (parsing fails before either matters).
    fn expect_raw(&mut self, step: &Step, name: &str) {
        let me = self.payer.pubkey();
        let parent = rrset_address(&self.env, EXAMPLE, TYPE_DNSKEY);
        let accounts = verify_accounts(&self.env, &me, Some(parent), Pubkey::new_unique());
        let ix = self.env.ix(
            "verify_rrset",
            &(step.signed.clone(), step.sig.clone()),
            accounts,
        );
        let payer = self.payer.insecure_clone();
        assert_err(self.env.send(&[cu_limit(1_400_000), ix], &[&payer]), name);
    }

    /// example.test. DS (signed by test.) and DNSKEY (self-signed by k1), verified.
    fn example(&mut self) {
        let ds = synthetic(
            &Sig::new(TEST, self.now),
            &self.k0,
            EXAMPLE,
            TYPE_DS,
            &[ds_rdata(EXAMPLE, &self.k1.dnskey(257), 2)],
        );
        self.prove(&ds, &TestKey::rsa(0, 8)).unwrap();
        let keys = synthetic(
            &Sig::new(EXAMPLE, self.now),
            &self.k1,
            EXAMPLE,
            TYPE_DNSKEY,
            &[self.k1.dnskey(257)],
        );
        self.prove(&keys, &TestKey::rsa(1, 8)).unwrap();
    }

    fn wallet_leaf(&self, records: &[Vec<u8>]) -> Step {
        synthetic(
            &Sig::new(EXAMPLE, self.now),
            &self.k1,
            WALLET_TXT,
            TYPE_TXT,
            records,
        )
    }
}

fn sol(wallet: &Pubkey) -> Vec<u8> {
    txt(&format!("SOL {wallet}"))
}

#[test]
fn a_zone_from_its_ds_down_to_the_wallet_record() {
    let mut z = zone();
    let now = z.now;
    let ds = synthetic(
        &Sig::new(TEST, now),
        &z.k0,
        EXAMPLE,
        TYPE_DS,
        &[ds_rdata(EXAMPLE, &z.k1.dnskey(257), 2)],
    );
    let (mode, ds_cu) = z.prove(&ds, &TestKey::rsa(0, 8)).unwrap();
    assert_eq!(mode, Mode::Inline);
    let keys = synthetic(
        &Sig::new(EXAMPLE, now),
        &z.k1,
        EXAMPLE,
        TYPE_DNSKEY,
        &[z.k1.dnskey(257)],
    );
    let (_, keys_cu) = z.prove(&keys, &TestKey::rsa(1, 8)).unwrap();

    let wallet = Pubkey::new_unique();
    let eth = txt("ETH 0x7edB9dC3a47bf0E8D59649B11Ee2Fb64b2BcE81f");
    let leaf = z.wallet_leaf(&[eth.clone(), sol(&wallet)]);
    let (_, leaf_cu) = z.prove(&leaf, &TestKey::rsa(1, 8)).unwrap();
    let cached: RrSet = rrset(&z.env, WALLET_TXT, TYPE_TXT).unwrap();
    assert_eq!(cached.records(), vec![eth, sol(&wallet)]);
    assert_eq!(cached.signed_at, now - 3600);
    assert_eq!(cached.expires_at, now + 7 * 86_400);
    assert_eq!(cached.payer, z.payer.pubkey());
    println!("RSA-1024 inline steps: DS {ds_cu} CU, self-signed DNSKEY (+ DS digest) {keys_cu} CU, _wallet TXT {leaf_cu} CU");

    // The escrow reads it through dnssec::wallet_signed_at: the published wallet registers,
    // any other doesn't.
    let record = rrset_address(&z.env, WALLET_TXT, TYPE_TXT);
    let payer = z.payer.insecure_clone();
    assert_err(
        register(
            &mut z.env,
            &payer,
            "example.test",
            record,
            Pubkey::new_unique(),
        ),
        "WalletNotPublished",
    );
    register(&mut z.env, &payer, "example.test", record, wallet).unwrap();
    let domain: Domain = z
        .env
        .account(&z.env.domain_pda(&domain_hash("example.test")))
        .unwrap();
    assert_eq!((domain.wallet, domain.last_proof), (wallet, now - 3600));
    // Another domain's record, or the record once expired, doesn't.
    assert_err(
        register(&mut z.env, &payer, "example.org", record, wallet),
        "NotAWalletRecord",
    );
    set_time(&mut z.env, now + 7 * 86_400 + 1);
    assert_err(
        register(&mut z.env, &payer, "example.test", record, wallet),
        "WalletRecordExpired",
    );
    set_time(&mut z.env, now);

    // WALLET (type 262) at the domain itself, two character-strings.
    let mut rd = txt("SOL");
    rd.extend(txt(&wallet.to_string()));
    let apex = synthetic(&Sig::new(EXAMPLE, now), &z.k1, EXAMPLE, TYPE_WALLET, &[rd]);
    z.prove(&apex, &TestKey::rsa(1, 8)).unwrap();
    let record = rrset_address(&z.env, EXAMPLE, TYPE_WALLET);
    register(&mut z.env, &payer, "example.test", record, wallet).unwrap();
    // A TXT at the apex is not a wallet record, whatever it says.
    let apex_txt = synthetic(
        &Sig::new(EXAMPLE, now),
        &z.k1,
        EXAMPLE,
        TYPE_TXT,
        &[sol(&wallet)],
    );
    z.prove(&apex_txt, &TestKey::rsa(1, 8)).unwrap();
    let record = rrset_address(&z.env, EXAMPLE, TYPE_TXT);
    assert_err(
        register(&mut z.env, &payer, "example.test", record, wallet),
        "NotAWalletRecord",
    );
}

#[test]
fn ds_sha1_digests_but_no_rsasha1_signatures() {
    let mut z = zone();
    let now = z.now;
    // DS digest type 1 (SHA-1 in BPF).
    let one = b"\x03one\x04test\x00";
    let ds = synthetic(
        &Sig::new(TEST, now),
        &z.k0,
        one,
        TYPE_DS,
        &[ds_rdata(one, &z.k1.dnskey(257), 1)],
    );
    z.prove(&ds, &TestKey::rsa(0, 8)).unwrap();
    let keys = synthetic(
        &Sig::new(one, now),
        &z.k1,
        one,
        TYPE_DNSKEY,
        &[z.k1.dnskey(257)],
    );
    let (_, cu) = z.prove(&keys, &TestKey::rsa(1, 8)).unwrap();
    println!("self-signed DNSKEY with a SHA-1 DS digest: {cu} CU");

    // Signature algorithms 5 (RSASHA1) and 7 (RSASHA1-NSEC3-SHA1) are refused: the parent can
    // delegate to such a key, but nothing it signs verifies, its own key set included.
    let zones: [(u8, &[u8]); 2] = [(5, b"\x04five\x04test\x00"), (7, b"\x05seven\x04test\x00")];
    for (alg, owner) in zones {
        let k = TestKey::rsa(1, alg);
        let ds = synthetic(
            &Sig::new(TEST, now),
            &z.k0,
            owner,
            TYPE_DS,
            &[ds_rdata(owner, &k.dnskey(257), 2)],
        );
        z.prove(&ds, &TestKey::rsa(0, 8)).unwrap();
        let keys = synthetic(
            &Sig::new(owner, now),
            &k,
            owner,
            TYPE_DNSKEY,
            &[k.dnskey(257)],
        );
        z.expect(&keys, &k, "UnsupportedAlgorithm");
        // Not even under a key set cached some other way.
        put_rrset(
            &mut z.env,
            owner,
            TYPE_DNSKEY,
            &[k.dnskey(257)],
            now - 60,
            now + 86_400,
        );
        let leaf = synthetic(
            &Sig::new(owner, now),
            &k,
            &[&b"\x07_wallet"[..], owner].concat(),
            TYPE_TXT,
            &[sol(&Pubkey::new_unique())],
        );
        z.expect(&leaf, &k, "UnsupportedAlgorithm");
    }
}

#[test]
fn signatures_must_come_from_the_right_key() {
    let mut z = zone();
    z.example();
    let now = z.now;
    let wallet = Pubkey::new_unique();
    let (k0, k1) = (TestKey::rsa(0, 8), TestKey::rsa(1, 8));

    // test.'s key signing for example.test.: its tag is not in example.test.'s key set.
    let s = synthetic(
        &Sig::new(EXAMPLE, now),
        &k0,
        WALLET_TXT,
        TYPE_TXT,
        &[sol(&wallet)],
    );
    z.expect(&s, &k0, "NoKeyVerified");
    // k1's tag, k0's signature.
    let sig = Sig {
        key_tag: Some(key_tag(&k1.dnskey(257))),
        ..Sig::new(EXAMPLE, now)
    };
    let s = synthetic(&sig, &k0, WALLET_TXT, TYPE_TXT, &[sol(&wallet)]);
    z.expect(&s, &k1, "NoKeyVerified");
    // A tampered record under a good signature.
    let good = z.wallet_leaf(&[sol(&wallet)]);
    z.expect(&good.flip(good.signed.len() - 1, 1), &k1, "NoKeyVerified");
    let mut bad = good.clone();
    bad.sig[10] ^= 1;
    z.expect(&bad, &k1, "NoKeyVerified");
    // A DNSKEY set that signs itself with a key no DS commits to.
    let other = b"\x05other\x04test\x00";
    let ds = synthetic(
        &Sig::new(TEST, now),
        &z.k0,
        other,
        TYPE_DS,
        &[ds_rdata(other, &k1.dnskey(257), 2)],
    );
    z.prove(&ds, &k0).unwrap();
    let keys = synthetic(
        &Sig::new(other, now),
        &k0,
        other,
        TYPE_DNSKEY,
        &[k0.dnskey(257)],
    );
    z.expect(&keys, &k0, "NoMatchingDs");
    // A DS for the right key but the wrong owner name commits to nothing here.
    let newer = Sig {
        inception: (now - 1800) as u32,
        ..Sig::new(TEST, now)
    };
    let ds = synthetic(
        &newer,
        &z.k0,
        other,
        TYPE_DS,
        &[ds_rdata(EXAMPLE, &k0.dnskey(257), 2)],
    );
    z.prove(&ds, &k0).unwrap();
    assert_eq!(
        rrset(&z.env, other, TYPE_DS).unwrap().records(),
        vec![ds_rdata(EXAMPLE, &k0.dnskey(257), 2)]
    );
    z.expect(&keys, &k0, "NoMatchingDs");
    // The root: a key set signed by any key but the IANA root keys never verifies.
    let root = synthetic(
        &Sig::new(b"\x00", now),
        &k0,
        b"\x00",
        TYPE_DNSKEY,
        &[k0.dnskey(257)],
    );
    z.expect(&root, &k0, "NoMatchingDs");

    // Revoked, non-zone or wrong-protocol keys can't sign, even with a matching tag.
    for (i, rdata) in [
        [&[0x01u8, 0x81][..], &k0.dnskey(257)[2..]].concat(),
        [&[0x00u8, 0x00][..], &k0.dnskey(257)[2..]].concat(),
        [&k0.dnskey(257)[..2], &[2u8][..], &k0.dnskey(257)[3..]].concat(),
    ]
    .iter()
    .enumerate()
    {
        let name = format!("\x04bad{i}\x04test\x00").into_bytes();
        put_rrset(
            &mut z.env,
            &name,
            TYPE_DNSKEY,
            &[rdata.clone()],
            now - 60,
            now + 86_400,
        );
        let sig = Sig {
            key_tag: Some(key_tag(rdata)),
            ..Sig::new(&name, now)
        };
        let mut owner = b"\x01x".to_vec();
        owner.extend_from_slice(&name);
        let s = synthetic(&sig, &k0, &owner, TYPE_TXT, &[sol(&wallet)]);
        let r = prove(&mut z.env, &z.payer, &s, rdata);
        assert_eq!(code(r), Some(err_code("NoKeyVerified")), "key {i}");
    }
}

#[test]
fn names_labels_and_times() {
    let mut z = zone();
    z.example();
    let now = z.now;
    let k1 = TestKey::rsa(1, 8);
    let wallet = Pubkey::new_unique();
    let recs = [sol(&wallet)];

    // A wildcard expansion: *.example.test. answering for _wallet.example.test. carries 2 labels.
    let s = synthetic(
        &Sig {
            labels: Some(2),
            ..Sig::new(EXAMPLE, now)
        },
        &k1,
        WALLET_TXT,
        TYPE_TXT,
        &recs,
    );
    z.expect(&s, &k1, "InvalidLabelCount");
    // The same at the wildcard owner itself, labels counted without the "*" as RFC 4034 does.
    let star = b"\x01*\x07example\x04test\x00";
    let s = synthetic(
        &Sig {
            labels: Some(2),
            ..Sig::new(EXAMPLE, now)
        },
        &k1,
        star,
        TYPE_TXT,
        &recs,
    );
    z.expect(&s, &k1, "InvalidLabelCount");
    // example.test. can't sign for a name outside it, even with a good signature.
    let s = synthetic(
        &Sig::new(EXAMPLE, now),
        &k1,
        b"\x07_wallet\x07example\x03org\x00",
        TYPE_TXT,
        &recs,
    );
    z.expect(&s, &k1, "InvalidSignerName");
    let s = synthetic(&Sig::new(EXAMPLE, now), &k1, TEST, TYPE_TXT, &recs);
    z.expect(&s, &k1, "InvalidSignerName");
    // Canonical names only.
    let s = synthetic(
        &Sig::new(EXAMPLE, now),
        &k1,
        b"\x07_Wallet\x07example\x04test\x00",
        TYPE_TXT,
        &recs,
    );
    z.expect(&s, &k1, "NameNotLowercase");
    let s = synthetic(
        &Sig {
            labels: Some(3),
            ..Sig::new(EXAMPLE, now)
        },
        &k1,
        b"\xc0\x0c",
        TYPE_TXT,
        &recs,
    );
    z.expect_raw(&s, "BadName");
    // Record fields: class, type, one owner, at least one record, nothing truncated.
    let at = 18 + EXAMPLE.len() + WALLET_TXT.len();
    let mut signed = signed_data(
        &Sig::new(EXAMPLE, now),
        &k1,
        257,
        WALLET_TXT,
        TYPE_TXT,
        &recs,
    );
    signed[at + 3] = 3; // class CH
    z.expect(&signed_step(signed, &k1), &k1, "InvalidClass");
    let mut signed = signed_data(
        &Sig::new(EXAMPLE, now),
        &k1,
        257,
        WALLET_TXT,
        TYPE_TXT,
        &recs,
    );
    signed[at + 1] = 1; // type A under an RRSIG covering TXT
    z.expect(&signed_step(signed, &k1), &k1, "SignatureTypeMismatch");
    let mut signed = signed_data(
        &Sig::new(EXAMPLE, now),
        &k1,
        257,
        WALLET_TXT,
        TYPE_TXT,
        &recs,
    );
    let other = signed_data(
        &Sig::new(EXAMPLE, now),
        &k1,
        257,
        b"\x01a\x07example\x04test\x00",
        TYPE_TXT,
        &recs,
    );
    signed.extend_from_slice(&other[18 + EXAMPLE.len()..]);
    z.expect(&signed_step(signed, &k1), &k1, "InvalidRRSet");
    let s = synthetic(&Sig::new(EXAMPLE, now), &k1, WALLET_TXT, TYPE_TXT, &[]);
    z.expect_raw(&s, "EmptyRRset");
    let mut signed = signed_data(
        &Sig::new(EXAMPLE, now),
        &k1,
        257,
        WALLET_TXT,
        TYPE_TXT,
        &recs,
    );
    signed.pop();
    z.expect(&signed_step(signed, &k1), &k1, "BadSignedData");
    // Algorithms: unsupported ones, and P-256/Ed25519 sets through the RSA instruction.
    let s = synthetic(
        &Sig {
            alg: Some(10),
            ..Sig::new(EXAMPLE, now)
        },
        &k1,
        WALLET_TXT,
        TYPE_TXT,
        &recs,
    );
    z.expect(&s, &k1, "UnsupportedAlgorithm");
    for alg in [13, 15] {
        let s = synthetic(
            &Sig {
                alg: Some(alg),
                ..Sig::new(EXAMPLE, now)
            },
            &k1,
            WALLET_TXT,
            TYPE_TXT,
            &recs,
        );
        let ix = verify_ix(&z.env, &z.payer.pubkey(), &s);
        let payer = z.payer.insecure_clone();
        assert_err(z.env.send(&[ix], &[&payer]), "WrongInstructionForAlgorithm");
    }

    // Validity window: RFC 1982 serial arithmetic against the cluster clock.
    let s = synthetic(
        &Sig {
            expiration: (now - 1) as u32,
            ..Sig::new(EXAMPLE, now)
        },
        &k1,
        WALLET_TXT,
        TYPE_TXT,
        &recs,
    );
    z.expect(&s, &k1, "SignatureExpired");
    let s = synthetic(
        &Sig {
            inception: (now + 60) as u32,
            ..Sig::new(EXAMPLE, now)
        },
        &k1,
        WALLET_TXT,
        TYPE_TXT,
        &recs,
    );
    z.expect(&s, &k1, "SignatureNotValidYet");
    let s = synthetic(
        &Sig {
            inception: now as u32,
            expiration: now as u32,
            ..Sig::new(EXAMPLE, now)
        },
        &k1,
        WALLET_TXT,
        TYPE_TXT,
        &recs,
    );
    z.prove(&s, &k1).unwrap(); // both ends inclusive

    // A parent that expired, and a child that may never outlive its parent.
    let k0 = TestKey::rsa(0, 8);
    let old = b"\x03old\x04test\x00";
    put_rrset(
        &mut z.env,
        old,
        TYPE_DNSKEY,
        &[k0.dnskey(257)],
        now - 86_400,
        now - 1,
    );
    let s = synthetic(
        &Sig::new(old, now),
        &k0,
        b"\x01x\x03old\x04test\x00",
        TYPE_TXT,
        &recs,
    );
    z.expect(&s, &k0, "ParentExpired");
    let short = b"\x05short\x04test\x00";
    put_rrset(
        &mut z.env,
        short,
        TYPE_DNSKEY,
        &[k0.dnskey(257)],
        now - 86_400,
        now + 600,
    );
    let owner = b"\x01x\x05short\x04test\x00";
    let s = synthetic(&Sig::new(short, now), &k0, owner, TYPE_TXT, &recs);
    z.prove(&s, &k0).unwrap();
    assert_eq!(
        rrset(&z.env, owner, TYPE_TXT).unwrap().expires_at,
        now + 600
    );
}

#[test]
fn the_caller_picks_neither_parent_nor_result() {
    let mut z = zone();
    z.example();
    let s = z.wallet_leaf(&[sol(&Pubkey::new_unique())]);
    let me = z.payer.pubkey();
    let payer = z.payer.insecure_clone();
    let result = rrset_address(&z.env, WALLET_TXT, TYPE_TXT);
    let send = |env: &mut Env, parent: Option<Pubkey>, result: Pubkey| {
        let ix = env.ix(
            "verify_rrset",
            &(s.signed.clone(), s.sig.clone()),
            verify_accounts(env, &me, parent, result),
        );
        env.send(&[cu_limit(1_400_000), ix], &[&payer])
    };
    let test_keys = rrset_address(&z.env, TEST, TYPE_DNSKEY);
    let example_ds = rrset_address(&z.env, EXAMPLE, TYPE_DS);
    let example_keys = rrset_address(&z.env, EXAMPLE, TYPE_DNSKEY);
    // test.'s key set holds no key for example.test.'s signature anyway, but the owner check
    // already refuses it; so does the DS set at the right name, an account of another program
    // and no account at all.
    assert_err(send(&mut z.env, Some(test_keys), result), "WrongParent");
    assert_err(send(&mut z.env, Some(example_ds), result), "WrongParent");
    assert_err(send(&mut z.env, Some(me), result), "WrongParent");
    assert_err(send(&mut z.env, None, result), "WrongParent");
    // The result must be the set's own PDA: not another entry, not a new address.
    assert_err(
        send(&mut z.env, Some(example_keys), example_keys),
        "WrongRRsetAccount",
    );
    assert_err(
        send(&mut z.env, Some(example_keys), Pubkey::new_unique()),
        "WrongRRsetAccount",
    );
    let other = rrset_address(&z.env, WALLET_TXT, TYPE_WALLET);
    assert_err(
        send(&mut z.env, Some(example_keys), other),
        "WrongRRsetAccount",
    );
    send(&mut z.env, Some(example_keys), result).unwrap();
}

#[test]
fn newer_signatures_replace_older_ones_never_the_reverse() {
    // Leaves signed by test. directly, whose cached key set outlives every one of them.
    let mut z = zone();
    let now = z.now;
    let k1 = TestKey::rsa(0, 8);
    let (a, b) = (Pubkey::new_unique(), Pubkey::new_unique());
    let address = rrset_address(&z.env, WALLET_TXT, TYPE_TXT);
    let leaf = |inception: i64, expiration: i64, records: &[Vec<u8>]| {
        let sig = Sig {
            inception: inception as u32,
            expiration: expiration as u32,
            ..Sig::new(TEST, now)
        };
        synthetic(&sig, &TestKey::rsa(0, 8), WALLET_TXT, TYPE_TXT, records)
    };
    let old = leaf(now - 200, now + 20 * 86_400, &[sol(&a)]);
    let new = leaf(now - 100, now + 7 * 86_400, &[sol(&b)]);

    z.prove(&new, &k1).unwrap();
    let first = raw(&z.env, &address).unwrap();
    // The older signature, though still valid, can't roll it back; the step succeeds anyway, so
    // two people proving at once never fail on each other.
    let (_, noop_cu) = z.prove(&old, &k1).unwrap();
    assert_eq!(raw(&z.env, &address).unwrap(), first);
    let (_, again_cu) = z.prove(&new, &k1).unwrap();
    assert_eq!(raw(&z.env, &address).unwrap(), first);
    println!("RSA-1024 step that finds the cache as new: {noop_cu} / {again_cu} CU");

    // Same signing time, valid longer (re-checked against a refreshed parent): replaces.
    let longer = leaf(now - 100, now + 8 * 86_400, &[sol(&b)]);
    z.prove(&longer, &k1).unwrap();
    assert_eq!(
        rrset(&z.env, WALLET_TXT, TYPE_TXT).unwrap().expires_at,
        now + 8 * 86_400
    );

    // A newer set from someone else, with more records: it grows, the refresher pays the growth,
    // the first payer keeps the rent claim.
    let other = z.env.funded(10);
    let more = leaf(
        now - 50,
        now + 7 * 86_400,
        &[
            sol(&b),
            txt("ETH 0x7edB9dC3a47bf0E8D59649B11Ee2Fb64b2BcE81f"),
            txt("note"),
        ],
    );
    let (len0, lamports0) = (first.len(), z.env.lamports(&address));
    let before = z.env.lamports(&other.pubkey());
    prove(&mut z.env, &other, &more, &k1.dnskey(257)).unwrap();
    let grown = z.env.svm.get_account(&address).unwrap();
    assert!(grown.data.len() > len0);
    assert_eq!(
        grown.lamports,
        z.env
            .svm
            .minimum_balance_for_rent_exemption(grown.data.len())
    );
    assert_eq!(
        z.env.lamports(&other.pubkey()),
        before - (grown.lamports - lamports0) - 5000
    );
    let cached: RrSet = z.env.account(&address).unwrap();
    assert_eq!(cached.payer, z.payer.pubkey());
    assert_eq!(cached.records().len(), 3);

    // A newer, smaller one shrinks the account; its rent stays for the first payer.
    let small = leaf(now - 10, now + 7 * 86_400, &[sol(&a)]);
    z.prove(&small, &k1).unwrap();
    let cached: RrSet = z.env.account(&address).unwrap();
    assert_eq!(cached.records(), vec![sol(&a)]);
    assert_eq!(
        z.env.svm.get_account(&address).unwrap().data.len(),
        70 + WALLET_TXT.len() + 2 + sol(&a).len()
    );

    // Once the cached set expires, any set valid now may replace it, even an older one.
    set_time(&mut z.env, now + 7 * 86_400 + 1);
    let old2 = leaf(now - 200, now + 20 * 86_400, &[sol(&b)]);
    z.prove(&old2, &k1).unwrap();
    let cached: RrSet = z.env.account(&address).unwrap();
    assert_eq!(cached.records(), vec![sol(&b)]);
    assert_eq!(cached.signed_at, now - 200);
}

#[test]
fn a_prefunded_address_is_still_created() {
    // Someone sends lamports to the PDA first; create_account would refuse it, the program
    // tops it up, allocates and assigns instead.
    let mut z = zone();
    let now = z.now;
    let address = rrset_address(&z.env, EXAMPLE, TYPE_DS);
    let dust = z.env.svm.minimum_balance_for_rent_exemption(0);
    z.env.svm.airdrop(&address, dust).unwrap();
    let ds = synthetic(
        &Sig::new(TEST, now),
        &z.k0,
        EXAMPLE,
        TYPE_DS,
        &[ds_rdata(EXAMPLE, &z.k1.dnskey(257), 2)],
    );
    z.prove(&ds, &TestKey::rsa(0, 8)).unwrap();
    let a = z.env.svm.get_account(&address).unwrap();
    assert_eq!(a.owner, z.env.program);
    assert_eq!(
        a.lamports,
        z.env.svm.minimum_balance_for_rent_exemption(a.data.len())
    );
    let _: RrSet = z.env.account(&address).unwrap();
}

#[test]
fn buffers_upload_in_any_order_and_close() {
    let mut z = zone();
    let payer = z.payer.insecure_clone();
    let me = payer.pubkey();
    let buffer = z.env.buffer_pda(&me);
    let bytes: Vec<u8> = (0..3000u32).map(|i| (i * 7 % 251) as u8).collect();
    // Chunks land in any order; the account grows to the furthest end written.
    for i in [2usize, 0, 3, 1] {
        let end = ((i + 1) * 900).min(bytes.len());
        let (cu, _) = (
            z.env
                .write_buffer(&payer, (i * 900) as u32, &bytes[i * 900..end])
                .unwrap()
                .compute_units_consumed,
            i,
        );
        if i == 2 {
            println!("write_buffer creating the buffer: {cu} CU");
        }
    }
    assert_eq!(z.env.buffer_bytes(&buffer), bytes);
    let a = z.env.svm.get_account(&buffer).unwrap();
    assert_eq!(
        a.lamports,
        z.env.svm.minimum_balance_for_rent_exemption(a.data.len())
    );

    // Empty, or past the 8 KiB limit.
    assert_err(z.env.write_buffer(&payer, 0, &[]), "BadBufferSize");
    assert_err(
        z.env.write_buffer(&payer, 8 * 1024 - 1, &[1, 2]),
        "BadBufferSize",
    );
    z.env.write_buffer(&payer, 8 * 1024 - 2, &[1, 2]).unwrap();
    // Nobody writes another payer's buffer: its address comes from the signer.
    let stranger = z.env.funded(1);
    let mut ix = z.env.write_buffer_ix(&stranger.pubkey(), 0, &[9]);
    ix.accounts[1] = w(buffer);
    assert!(z.env.send(&[ix], &[&stranger]).is_err());
    assert_eq!(z.env.buffer_bytes(&buffer)[0], bytes[0]);

    // Not a step: verify_rrset_buffered refuses it and leaves it.
    z.env.write_buffer(&payer, 0, &[0xff; 8]).unwrap();
    let s = synthetic(
        &Sig::new(TEST, z.now),
        &z.k0,
        EXAMPLE,
        TYPE_DS,
        &[vec![1, 2, 3, 4]],
    );
    let ix = buffered_ix(&z.env, &me, &s);
    assert_err(z.env.send(&[ix], &[&payer]), "BadBuffer");

    // close_buffer gives the rent back.
    let rent = z.env.lamports(&buffer);
    let before = z.env.lamports(&me);
    z.env.close_buffer(&payer).unwrap();
    assert!(z
        .env
        .svm
        .get_account(&buffer)
        .is_none_or(|a| a.lamports == 0));
    assert_eq!(z.env.lamports(&me), before + rent - 5000);

    // A buffered step closes its buffer whether it writes the cache or finds it as new already.
    let ds = synthetic(
        &Sig::new(TEST, z.now),
        &z.k0,
        EXAMPLE,
        TYPE_DS,
        &[ds_rdata(EXAMPLE, &z.k1.dnskey(257), 2)],
    );
    for round in 0..2 {
        z.env.upload(&payer, &buffer_payload(&ds));
        let ix = buffered_ix(&z.env, &me, &ds);
        let cu = z
            .env
            .send(&[cu_limit(1_400_000), ix], &[&payer])
            .unwrap()
            .compute_units_consumed;
        println!("verify_rrset_buffered, RSA-1024 DS (round {round}): {cu} CU");
        assert!(z
            .env
            .svm
            .get_account(&buffer)
            .is_none_or(|a| a.lamports == 0));
    }
    assert!(rrset(&z.env, EXAMPLE, TYPE_DS).is_some());
}

#[test]
fn close_needs_expiry_and_pays_the_first_payer() {
    let mut z = zone();
    z.example();
    let now = z.now;
    let s = z.wallet_leaf(&[sol(&Pubkey::new_unique())]);
    z.prove(&s, &TestKey::rsa(1, 8)).unwrap();
    let address = rrset_address(&z.env, WALLET_TXT, TYPE_TXT);
    let anyone = z.env.funded(1);
    let me = z.payer.pubkey();
    assert_err(
        z.env
            .send(&[close_rrset_ix(&z.env, address, me)], &[&anyone]),
        "RRsetNotExpired",
    );
    set_time(&mut z.env, now + 7 * 86_400 + 1);
    assert_err(
        z.env.send(
            &[close_rrset_ix(&z.env, address, anyone.pubkey())],
            &[&anyone],
        ),
        "WrongPayer",
    );
    let rent = z.env.lamports(&address);
    let before = z.env.lamports(&me);
    let cu = z
        .env
        .send(&[close_rrset_ix(&z.env, address, me)], &[&anyone])
        .unwrap()
        .compute_units_consumed;
    println!("close_rrset: {cu} CU");
    assert_eq!(z.env.lamports(&me), before + rent);
    assert!(z
        .env
        .svm
        .get_account(&address)
        .is_none_or(|a| a.lamports == 0));
    // Not an RRset: refused.
    let config = z.env.config_pda();
    assert!(z
        .env
        .send(&[close_rrset_ix(&z.env, config, me)], &[&anyone])
        .is_err());
}
