//! Shared by the dnssec_*.rs suites: the real proofs in ../bench/fixtures, the dnssec
//! instructions as a client sends them, and synthetic zones signed with throwaway keys.
//! Nothing here uses the program's own parsing, so a test can't pass through a bug shared with it.
#![allow(dead_code)]

use num_bigint::BigUint;
use serde_json::Value;
use sha2::{Digest, Sha256};
use solana_account::Account;
use solana_clock::Clock;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::{v1, Message, VersionedMessage};
use solana_sdk_ids::{compute_budget, system_program};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;
use type262_tests::*;

pub const TYPE_A: u16 = 1;
pub const TYPE_DS: u16 = 43;
pub const SECP256R1: Pubkey = solana_sdk_ids::secp256r1_program::ID;
pub const ED25519: Pubkey = solana_sdk_ids::ed25519_program::ID;
pub const IX_SYSVAR: Pubkey = solana_sdk_ids::sysvar::instructions::ID;
pub const LEGACY_MAX: usize = 1232;
/// Where verify_rrset(_precompiled) data holds the signed set: discriminator + u32 length.
pub const SIGNED_OFFSET: u16 = 12;
/// All six fixtures were fetched within 20 minutes; every signature in them is valid now.
pub const FIXTURE_TIME: i64 = 1_792_603_600;
pub const CHAINS: [&str; 6] = [
    "cloudflare.com.json",
    "_wallet.gemprotocol.io.json",
    "nlnetlabs.nl.json",
    "ietf.org.json",
    "nasa.gov.json",
    "ed25519.nl.json",
];

pub fn unhex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

pub fn set_time(env: &mut Env, t: i64) {
    let mut clock = env.svm.get_sysvar::<Clock>();
    clock.unix_timestamp = t;
    clock.slot += 1;
    env.svm.set_sysvar::<Clock>(&clock);
    env.svm.expire_blockhash();
}

pub fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

// ---------- wire form ----------

/// Index just past the wire name starting at `at`.
pub fn name_end(b: &[u8], mut at: usize) -> usize {
    while b[at] != 0 {
        at += 1 + b[at] as usize;
    }
    at + 1
}

pub fn label_count(name: &[u8]) -> u8 {
    let (mut at, mut n) = (0, 0);
    while name[at] != 0 {
        at += 1 + name[at] as usize;
        n += 1;
    }
    n
}

/// RFC 4034 appendix B.
pub fn key_tag(rdata: &[u8]) -> u16 {
    let mut ac = 0u32;
    for (i, &b) in rdata.iter().enumerate() {
        ac += if i % 2 == 0 {
            (b as u32) << 8
        } else {
            b as u32
        };
    }
    ac += (ac >> 16) & 0xffff;
    ac as u16
}

/// One signed set: RRSIG RDATA without signature + records, and the signature.
#[derive(Clone, Debug)]
pub struct Step {
    pub label: String,
    pub signed: Vec<u8>,
    pub sig: Vec<u8>,
}

impl Step {
    pub fn rrtype(&self) -> u16 {
        u16::from_be_bytes([self.signed[0], self.signed[1]])
    }
    pub fn alg(&self) -> u8 {
        self.signed[2]
    }
    pub fn expiration(&self) -> u32 {
        u32::from_be_bytes(self.signed[8..12].try_into().unwrap())
    }
    pub fn inception(&self) -> u32 {
        u32::from_be_bytes(self.signed[12..16].try_into().unwrap())
    }
    pub fn key_tag(&self) -> u16 {
        u16::from_be_bytes([self.signed[16], self.signed[17]])
    }
    pub fn signer(&self) -> Vec<u8> {
        self.signed[18..name_end(&self.signed, 18)].to_vec()
    }
    pub fn owner(&self) -> Vec<u8> {
        let at = name_end(&self.signed, 18);
        self.signed[at..name_end(&self.signed, at)].to_vec()
    }
    pub fn records(&self) -> Vec<Vec<u8>> {
        let mut at = name_end(&self.signed, 18);
        let mut out = Vec::new();
        while at < self.signed.len() {
            at = name_end(&self.signed, at);
            let len = u16::from_be_bytes([self.signed[at + 8], self.signed[at + 9]]) as usize;
            out.push(self.signed[at + 10..at + 10 + len].to_vec());
            at += 10 + len;
        }
        out
    }
    /// The cached set it is checked against; None for the root DNSKEY set (root anchors).
    pub fn parent(&self) -> Option<(Vec<u8>, u16)> {
        if self.rrtype() == TYPE_DNSKEY && self.owner() == self.signer() {
            (self.owner() != [0]).then(|| (self.owner(), TYPE_DS))
        } else {
            Some((self.signer(), TYPE_DNSKEY))
        }
    }
    pub fn precompiled(&self) -> bool {
        matches!(self.alg(), 13 | 15)
    }
    /// The same step with byte `i` of the signed data xor `x` (a tampered copy).
    pub fn flip(&self, i: usize, x: u8) -> Step {
        let mut s = self.clone();
        s.signed[i] ^= x;
        s
    }
}

pub struct Chain {
    pub name: String,
    pub fetched_at: i64,
    pub steps: Vec<Step>,
}

impl Chain {
    pub fn load(file: &str) -> Chain {
        let path = workspace().join("bench/fixtures").join(file);
        let fx: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let steps = fx["sets"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| {
                let ty = match &s["type"] {
                    Value::String(t) => t.clone(),
                    v => format!("TYPE{v}"),
                };
                Step {
                    label: format!("{} {ty}", s["owner"].as_str().unwrap()),
                    signed: unhex(s["rrset"].as_str().unwrap()),
                    sig: unhex(s["sig"].as_str().unwrap()),
                }
            })
            .collect();
        Chain {
            name: fx["query"]["name"].as_str().unwrap().to_string(),
            fetched_at: fx["fetchedAt"].as_i64().unwrap(),
            steps,
        }
    }

    /// The DNSKEY RDATA that signed `step`, from the chain's own key sets.
    pub fn signing_key(&self, step: &Step) -> Vec<u8> {
        let keys = self
            .steps
            .iter()
            .find(|s| s.rrtype() == TYPE_DNSKEY && s.owner() == step.signer())
            .expect("signer's key set in the proof");
        keys.records()
            .into_iter()
            .find(|k| key_tag(k) == step.key_tag() && k[3] == step.alg())
            .expect("key with the RRSIG's tag")
    }

    pub fn leaf(&self) -> &Step {
        self.steps.last().unwrap()
    }
}

/// Bits of an RSA DNSKEY's modulus, or 256/255 for P-256/Ed25519.
pub fn key_bits(key: &[u8]) -> usize {
    match key[3] {
        13 => 256,
        15 => 255,
        _ => {
            let pk = &key[4..];
            let off = if pk[0] == 0 {
                3 + ((pk[1] as usize) << 8 | pk[2] as usize)
            } else {
                1 + pk[0] as usize
            };
            let n = &pk[off..];
            n.len() * 8 - n[0].leading_zeros() as usize
        }
    }
}

// ---------- precompiles ----------

/// P-256 group order; the secp256r1 precompile only accepts s <= n/2.
const P256_N: &str = "ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551";
const P256_HALF_N: &str = "7fffffff800000007fffffffffffffffde737d56d38bcf4279dce5617e3192a8";

/// (r, s) with s replaced by n - s when s > n/2: DNSSEC signers don't normalize, the precompile
/// requires it, and both forms are the same valid ECDSA signature.
pub fn low_s(sig: &[u8]) -> (Vec<u8>, bool) {
    let (n, half) = (unhex(P256_N), unhex(P256_HALF_N));
    if sig[32..64] <= half[..] {
        return (sig.to_vec(), false);
    }
    let mut out = sig.to_vec();
    let mut borrow = 0i16;
    for i in (0..32).rev() {
        let d = n[i] as i16 - sig[32 + i] as i16 - borrow;
        out[32 + i] = d.rem_euclid(256) as u8;
        borrow = (d < 0) as i16;
    }
    (out, true)
}

/// The precompile program and public key for a DNSKEY: the compressed point for P-256, the raw
/// key for Ed25519.
pub fn precompile_key(dnskey: &[u8]) -> (Pubkey, Vec<u8>) {
    match dnskey[3] {
        13 => {
            let mut pk = vec![2 | (dnskey[67] & 1)];
            pk.extend_from_slice(&dnskey[4..36]);
            (SECP256R1, pk)
        }
        15 => (ED25519, dnskey[4..36].to_vec()),
        a => panic!("algorithm {a} has no precompile"),
    }
}

/// One entry of a precompile instruction: (public key, signature, message instruction index,
/// message offset, message length).
pub type Entry = (Vec<u8>, Vec<u8>, u16, u16, u16);

/// A secp256r1 / ed25519 instruction (they share the layout) with keys and signatures in its
/// own data and the messages elsewhere.
pub fn precompile_ix(program: Pubkey, entries: &[Entry]) -> Instruction {
    let mut d = vec![entries.len() as u8, 0];
    let mut at = 2 + 14 * entries.len() as u16;
    let mut tail = Vec::new();
    for (pk, sig, msg_ix, msg_off, msg_len) in entries {
        let (pk_off, sig_off) = (at, at + pk.len() as u16);
        at += (pk.len() + sig.len()) as u16;
        for v in [
            sig_off,
            u16::MAX,
            pk_off,
            u16::MAX,
            *msg_off,
            *msg_len,
            *msg_ix,
        ] {
            d.extend_from_slice(&v.to_le_bytes());
        }
        tail.extend_from_slice(pk);
        tail.extend_from_slice(sig);
    }
    d.extend_from_slice(&tail);
    Instruction {
        program_id: program,
        accounts: vec![],
        data: d,
    }
}

/// The entry that proves `step`'s signature by `dnskey`, its message at instruction `msg_ix`.
pub fn entry_for(step: &Step, dnskey: &[u8], msg_ix: u16) -> (Pubkey, Entry) {
    let (program, pk) = precompile_key(dnskey);
    let sig = if dnskey[3] == 13 {
        low_s(&step.sig).0
    } else {
        step.sig.clone()
    };
    (
        program,
        (pk, sig, msg_ix, SIGNED_OFFSET, step.signed.len() as u16),
    )
}

// ---------- instructions ----------

pub fn rrset_address(env: &Env, owner: &[u8], rrtype: u16) -> Pubkey {
    env.rrset_pda(&name_hash(owner), rrtype)
}

pub fn rrset(env: &Env, owner: &[u8], rrtype: u16) -> Option<RrSet> {
    env.account(&rrset_address(env, owner, rrtype))
}

pub fn cu_limit(units: u32) -> Instruction {
    let mut data = vec![2u8];
    data.extend_from_slice(&units.to_le_bytes());
    Instruction {
        program_id: compute_budget::ID,
        accounts: vec![],
        data,
    }
}

/// payer, parent (the program id stands for None), rrset, system program, instructions sysvar.
pub fn verify_accounts(
    env: &Env,
    payer: &Pubkey,
    parent: Option<Pubkey>,
    rrset: Pubkey,
) -> Vec<AccountMeta> {
    vec![
        ws(*payer),
        r(parent.unwrap_or(env.program)),
        w(rrset),
        r(system_program::ID),
        r(IX_SYSVAR),
    ]
}

/// The accounts a client derives from the step itself.
pub fn step_accounts(env: &Env, payer: &Pubkey, step: &Step) -> Vec<AccountMeta> {
    let parent = step.parent().map(|(o, t)| rrset_address(env, &o, t));
    verify_accounts(
        env,
        payer,
        parent,
        rrset_address(env, &step.owner(), step.rrtype()),
    )
}

pub fn verify_ix(env: &Env, payer: &Pubkey, step: &Step) -> Instruction {
    env.ix(
        "verify_rrset",
        &(step.signed.clone(), step.sig.clone()),
        step_accounts(env, payer, step),
    )
}

pub fn precompiled_ix(env: &Env, payer: &Pubkey, step: &Step) -> Instruction {
    env.ix(
        "verify_rrset_precompiled",
        &step.signed,
        step_accounts(env, payer, step),
    )
}

pub fn buffered_ix(env: &Env, payer: &Pubkey, step: &Step) -> Instruction {
    let mut accounts = step_accounts(env, payer, step);
    accounts.push(w(env.buffer_pda(payer)));
    env.ix("verify_rrset_buffered", &(), accounts)
}

pub fn close_rrset_ix(env: &Env, rrset: Pubkey, payer: Pubkey) -> Instruction {
    env.ix("close_rrset", &(), vec![w(rrset), w(payer)])
}

/// What verify_rrset_buffered reads: [u32 length, signed, u32 length, sig].
pub fn buffer_payload(step: &Step) -> Vec<u8> {
    let mut v = (step.signed.len() as u32).to_le_bytes().to_vec();
    v.extend_from_slice(&step.signed);
    v.extend_from_slice(&(step.sig.len() as u32).to_le_bytes());
    v.extend_from_slice(&step.sig);
    v
}

fn shortvec_len(n: usize) -> usize {
    match n {
        0..=0x7f => 1,
        0x80..=0x3fff => 2,
        _ => 3,
    }
}

/// Exact wire size of a legacy transaction with these instructions, signed by its signers.
pub fn legacy_size(ixs: &[Instruction], payer: &Pubkey) -> usize {
    let m = Message::new(ixs, Some(payer));
    let sigs = m.header.num_required_signatures as usize;
    let mut n = shortvec_len(sigs) + 64 * sigs + 3;
    n += shortvec_len(m.account_keys.len()) + 32 * m.account_keys.len() + 32;
    n += shortvec_len(m.instructions.len());
    for ix in &m.instructions {
        n += 1 + shortvec_len(ix.accounts.len()) + ix.accounts.len();
        n += shortvec_len(ix.data.len()) + ix.data.len();
    }
    n
}

/// Sends a v1 transaction (up to 4096 bytes); the compute limit goes in its header.
pub fn send_v1(env: &mut Env, ixs: &[Instruction], payer: &Keypair) -> TxResult {
    let config = v1::TransactionConfig::empty()
        .with_compute_unit_limit(1_400_000)
        .with_loaded_accounts_data_size_limit(64 * 1024 * 1024);
    let msg = v1::Message::try_compile_with_config(
        &payer.pubkey(),
        ixs,
        env.svm.latest_blockhash(),
        config,
    )
    .unwrap();
    let tx = VersionedTransaction::try_new(VersionedMessage::V1(msg), &[payer]).unwrap();
    let res = env.svm.send_transaction(tx);
    env.svm.expire_blockhash();
    res.map_err(|e| Failure {
        err: e.err,
        logs: e.meta.logs,
    })
}

/// The custom error code a failed send or prove ended with.
pub fn code<T>(r: Result<T, Failure>) -> Option<u32> {
    r.err().and_then(|f| f.code())
}

/// escrow::register, which reads the record through dnssec::wallet_signed_at: records the
/// proof for `name` and the wallet the record must show.
pub fn register(
    env: &mut Env,
    payer: &Keypair,
    name: &str,
    record: Pubkey,
    wallet: Pubkey,
) -> TxResult {
    let hash = domain_hash(name);
    let ix = env.ix(
        "register",
        &(name.to_string(), hash, wallet),
        vec![
            ws(payer.pubkey()),
            w(env.domain_pda(&hash)),
            r(record),
            r(wallet),
            r(system_program::ID),
        ],
    );
    env.send(&[ix], &[payer])
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Mode {
    /// verify_rrset in one legacy transaction.
    Inline,
    /// write_buffer chunks, then verify_rrset_buffered.
    Buffered,
    /// precompile + verify_rrset_precompiled in one legacy transaction.
    Precompiled,
    /// The same in a v1 transaction (message too big for a legacy one).
    PrecompiledV1,
}

/// Verifies one step the way a client does: RSA inline when the legacy transaction fits, else
/// through the buffer; P-256/Ed25519 with a precompile entry (`dnskey` is the signing key).
/// Returns the mode and the compute units of the verifying transaction.
pub fn prove(
    env: &mut Env,
    payer: &Keypair,
    step: &Step,
    dnskey: &[u8],
) -> Result<(Mode, u64), Failure> {
    let me = payer.pubkey();
    if step.precompiled() {
        let (program, entry) = entry_for(step, dnskey, 1);
        let ixs = [
            precompile_ix(program, &[entry]),
            precompiled_ix(env, &me, step),
        ];
        if legacy_size(&ixs, &me) <= LEGACY_MAX {
            return env
                .send(&ixs, &[payer])
                .map(|m| (Mode::Precompiled, m.compute_units_consumed));
        }
        // A v1 transaction carries the compute limit in its header: same instruction indexes.
        return send_v1(env, &ixs, payer).map(|m| (Mode::PrecompiledV1, m.compute_units_consumed));
    }
    let ixs = [cu_limit(1_400_000), verify_ix(env, &me, step)];
    if legacy_size(&ixs, &me) <= LEGACY_MAX {
        return env
            .send(&ixs, &[payer])
            .map(|m| (Mode::Inline, m.compute_units_consumed));
    }
    env.upload(payer, &buffer_payload(step));
    let ixs = [cu_limit(1_400_000), buffered_ix(env, &me, step)];
    assert!(legacy_size(&ixs, &me) <= LEGACY_MAX);
    env.send(&ixs, &[payer])
        .map(|m| (Mode::Buffered, m.compute_units_consumed))
}

// ---------- synthetic zones ----------

/// Throwaway RSA-1024 test keys (generated with openssl for these tests only): modulus and
/// private exponent; e = 65537.
const TEST_KEYS: [(&str, &str); 2] = [
    (
        "cfc84102dda2ed4db6b3b798901171ba836f83addbf7cd2f12749c6265465cb10a9eab4880f4bbb5ebed003aea72af746f98cfe0562ae4eb48c4a3ed039c67f6490797e29c2ce08961a6b98b77abeb91cbbac729c35cbb2b2f380bd6b52f6cc78ca8cdf6da3fdcbfc82bf1d75c8107e500a54f5d049d1094f6b1098c27f50a8f",
        "01ed79aced2175d222bfc8144241e72c33cbf50cc7dda4a9ab2229d13fdf473cdd3c5b9a7097d4a5fb6a577634769bea189ef24ec27de361cb6b079a4b4e48289c7a321d89d67cdaa0838d044f8be1ac0c30124c735ae3e1b4044c91d3ccb20e38841a953b952bc211c5f02d141dd890f22681b5d691fdab701f77109a424401",
    ),
    (
        "b2e2ff4842864b13fa4f0613f94a4d8c5bc77733a4148aaeaab103f776a7334bbd28fa138be8ef78bd345f07b9f74a58387aeb344c2d8156b6bd29e14449b6e267e18292719b9235ad28b274de5ef8d54748db54a571a8a0bcd90d58bb6831a2d5a543d5089b4ba1c440e4b7ca0897ec15dac34b4775bb9535118d9834756e7f",
        "a4d5c08ff024d8e7a6bdcc86f92e3b78fb553884d04bd162938c9b701ad884cee495eea1b64944e8c7c78b4d8e51cd22afa0ac3cbb792ef61d5aff4d40e47fec6394b405928bcc04a1d00f1bfae89e15c72a262be4d7a63ecb2315f6825c3b1e762230e7436f49b6d3f66338d68bab4dfc88ddf50d09af237898d844c580dec1",
    ),
];

/// A zone signing key the tests control.
pub enum TestKey {
    Rsa { n: Vec<u8>, d: BigUint, alg: u8 },
    Ed25519(Keypair),
}

impl TestKey {
    /// RSA test key `i` (0 or 1) for algorithm 8 (SHA-256) or 5 (SHA-1).
    pub fn rsa(i: usize, alg: u8) -> TestKey {
        let (n, d) = TEST_KEYS[i];
        TestKey::Rsa {
            n: unhex(n),
            d: BigUint::parse_bytes(d.as_bytes(), 16).unwrap(),
            alg,
        }
    }

    pub fn ed25519() -> TestKey {
        TestKey::Ed25519(Keypair::new())
    }

    pub fn alg(&self) -> u8 {
        match self {
            TestKey::Rsa { alg, .. } => *alg,
            TestKey::Ed25519(_) => 15,
        }
    }

    /// DNSKEY RDATA with these flags (257 = zone + secure entry point).
    pub fn dnskey(&self, flags: u16) -> Vec<u8> {
        let mut v = flags.to_be_bytes().to_vec();
        v.push(3);
        v.push(self.alg());
        match self {
            TestKey::Rsa { n, .. } => {
                v.extend_from_slice(&[3, 1, 0, 1]); // RFC 3110: exponent length 3, 65537
                v.extend_from_slice(n);
            }
            TestKey::Ed25519(k) => v.extend_from_slice(k.pubkey().as_ref()),
        }
        v
    }

    pub fn sign(&self, data: &[u8]) -> Vec<u8> {
        match self {
            TestKey::Rsa { n, d, alg } => {
                // PKCS#1 v1.5: 00 01 FF..FF 00 DigestInfo hash.
                let (prefix, hash): (Vec<u8>, Vec<u8>) = if *alg == 8 {
                    (
                        unhex("3031300d060960864801650304020105000420"),
                        sha256(&[data]).to_vec(),
                    )
                } else {
                    use sha1::Digest as _;
                    (
                        unhex("3021300906052b0e03021a05000414"),
                        sha1::Sha1::digest(data).to_vec(),
                    )
                };
                let mut em = vec![0u8, 1];
                em.resize(n.len() - prefix.len() - hash.len() - 1, 0xff);
                em.push(0);
                em.extend_from_slice(&prefix);
                em.extend_from_slice(&hash);
                let s = BigUint::from_bytes_be(&em).modpow(d, &BigUint::from_bytes_be(n));
                let s = s.to_bytes_be();
                let mut out = vec![0u8; n.len() - s.len()];
                out.extend_from_slice(&s);
                out
            }
            TestKey::Ed25519(k) => k.sign_message(data).as_ref().to_vec(),
        }
    }
}

/// The RRSIG fields of a synthetic signature. `labels: None` means the owner's label count.
#[derive(Clone)]
pub struct Sig {
    pub signer: Vec<u8>,
    pub inception: u32,
    pub expiration: u32,
    pub labels: Option<u8>,
    pub alg: Option<u8>,
    pub key_tag: Option<u16>,
}

impl Sig {
    /// Signed by `signer`, valid from an hour before `now` to a week after it.
    pub fn new(signer: &[u8], now: i64) -> Sig {
        Sig {
            signer: signer.to_vec(),
            inception: (now - 3600) as u32,
            expiration: (now + 7 * 86_400) as u32,
            labels: None,
            alg: None,
            key_tag: None,
        }
    }
}

/// RRSIG RDATA without signature, then the records with class IN and TTL 300.
pub fn signed_data(
    sig: &Sig,
    key: &TestKey,
    flags: u16,
    owner: &[u8],
    rrtype: u16,
    records: &[Vec<u8>],
) -> Vec<u8> {
    let mut v = rrtype.to_be_bytes().to_vec();
    v.push(sig.alg.unwrap_or(key.alg()));
    v.push(sig.labels.unwrap_or_else(|| label_count(owner)));
    v.extend_from_slice(&300u32.to_be_bytes());
    v.extend_from_slice(&sig.expiration.to_be_bytes());
    v.extend_from_slice(&sig.inception.to_be_bytes());
    v.extend_from_slice(
        &sig.key_tag
            .unwrap_or_else(|| key_tag(&key.dnskey(flags)))
            .to_be_bytes(),
    );
    v.extend_from_slice(&sig.signer);
    for rd in records {
        v.extend_from_slice(owner);
        v.extend_from_slice(&rrtype.to_be_bytes());
        v.extend_from_slice(&1u16.to_be_bytes());
        v.extend_from_slice(&300u32.to_be_bytes());
        v.extend_from_slice(&(rd.len() as u16).to_be_bytes());
        v.extend_from_slice(rd);
    }
    v
}

/// A synthetic step: `records` at `owner`, signed by `key` (DNSKEY flags 257).
pub fn synthetic(sig: &Sig, key: &TestKey, owner: &[u8], rrtype: u16, records: &[Vec<u8>]) -> Step {
    let signed = signed_data(sig, key, 257, owner, rrtype, records);
    Step {
        label: format!("synthetic type {rrtype}"),
        sig: key.sign(&signed),
        signed,
    }
}

/// Signs already-built signed data (to tamper with it before signing).
pub fn signed_step(signed: Vec<u8>, key: &TestKey) -> Step {
    Step {
        label: "synthetic".into(),
        sig: key.sign(&signed),
        signed,
    }
}

/// DS RDATA for `dnskey` at `owner`, digest type 1 (SHA-1) or 2 (SHA-256).
pub fn ds_rdata(owner: &[u8], dnskey: &[u8], digest_type: u8) -> Vec<u8> {
    let mut v = key_tag(dnskey).to_be_bytes().to_vec();
    v.push(dnskey[3]);
    v.push(digest_type);
    if digest_type == 1 {
        use sha1::Digest as _;
        let mut h = sha1::Sha1::new();
        h.update(owner);
        h.update(dnskey);
        v.extend_from_slice(&h.finalize());
    } else {
        v.extend_from_slice(&sha256(&[owner, dnskey]));
    }
    v
}

/// One TXT character-string.
pub fn txt(s: &str) -> Vec<u8> {
    let mut v = vec![s.len() as u8];
    v.extend_from_slice(s.as_bytes());
    v
}

/// Writes a cached set straight into its PDA, as if it had been verified (RrSet layout in
/// state.rs). Synthetic zones hang below such a set, since only the real root keys can start a
/// chain from the anchors.
pub fn put_rrset(
    env: &mut Env,
    owner: &[u8],
    rrtype: u16,
    records: &[Vec<u8>],
    signed_at: i64,
    expires_at: i64,
) -> Pubkey {
    let (address, bump) = Pubkey::find_program_address(
        &[seeds::RRSET, &name_hash(owner), &rrtype.to_be_bytes()],
        &env.program,
    );
    let mut rdata = Vec::new();
    for rd in records {
        rdata.extend_from_slice(&(rd.len() as u16).to_le_bytes());
        rdata.extend_from_slice(rd);
    }
    let mut d = discriminator("account", "RrSet").to_vec();
    d.push(bump);
    d.extend_from_slice(&rrtype.to_le_bytes());
    d.push(8);
    d.extend_from_slice(&0u16.to_le_bytes());
    d.extend_from_slice(&signed_at.to_le_bytes());
    d.extend_from_slice(&expires_at.to_le_bytes());
    d.extend_from_slice(Pubkey::new_unique().as_ref());
    d.extend_from_slice(&(owner.len() as u32).to_le_bytes());
    d.extend_from_slice(owner);
    d.extend_from_slice(&(rdata.len() as u32).to_le_bytes());
    d.extend_from_slice(&rdata);
    let lamports = env.svm.minimum_balance_for_rent_exemption(d.len());
    env.svm
        .set_account(
            address,
            Account {
                lamports,
                data: d,
                owner: env.program,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    address
}

/// The raw account bytes, for "nothing changed" checks.
pub fn raw(env: &Env, address: &Pubkey) -> Option<Vec<u8>> {
    env.svm.get_account(address).map(|a| a.data)
}
