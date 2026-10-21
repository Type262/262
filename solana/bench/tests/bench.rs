//! LiteSVM benchmark: compute units and real transaction sizes for DNSSEC checks on Solana.
//!   cargo test --test bench -- --nocapture --test-threads 1
//! Loads target/deploy/{v0,v3}/dnssec_bench.so (built by run.sh with cargo-build-sbf --arch v0/v3)
//! and the fixtures in fixtures/ (real proofs from proofs/dump.mjs, synthetic keys from
//! proofs/rsa-vectors.mjs).

use dnssec_bench::dnssec::{self, parse_signed, RRset, TYPE_DNSKEY, TYPE_DS};
use dnssec_bench::introspect::p256_compressed;
use litesvm::LiteSVM;
use serde_json::Value;
use solana_account::Account;
use solana_address::Address;
use solana_compute_budget_interface::ComputeBudgetInstruction;
use solana_hash::Hash;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::{v1, Message, VersionedMessage};
use solana_signature::Signature;
use solana_signer::Signer;
use solana_transaction::{versioned::VersionedTransaction, Transaction};
use std::collections::HashMap;
use std::path::Path;

const SECP256R1: Address = solana_sdk_ids::secp256r1_program::ID;
const ED25519: Address = solana_sdk_ids::ed25519_program::ID;
const IX_SYSVAR: Address = solana_sdk_ids::sysvar::instructions::ID;
const LEGACY_MAX: usize = 1232;

// P-256 group order n and n/2: the secp256r1 precompile only accepts s <= n/2.
const P256_N: &str = "ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551";
const P256_HALF_N: &str = "7fffffff800000007fffffffffffffffde737d56d38bcf4279dce5617e3192a8";

fn unhex(s: &str) -> Vec<u8> {
    hex::decode(s).unwrap()
}

fn fields(parts: &[&[u8]]) -> Vec<u8> {
    let mut out = Vec::new();
    for p in parts {
        out.extend_from_slice(&(p.len() as u16).to_le_bytes());
        out.extend_from_slice(p);
    }
    out
}

/// (r, s) with s replaced by n - s when s > n/2. DNSSEC signers do not normalize, so about half
/// of real signatures need this before the precompile accepts them. Both forms are valid ECDSA.
fn low_s(sig: &[u8]) -> (Vec<u8>, bool) {
    let (n, half) = (unhex(P256_N), unhex(P256_HALF_N));
    let s = &sig[32..64];
    if s <= &half[..] {
        return (sig.to_vec(), false);
    }
    let mut out = sig.to_vec();
    let mut borrow = 0i16;
    for i in (0..32).rev() {
        let d = n[i] as i16 - s[i] as i16 - borrow;
        out[32 + i] = d.rem_euclid(256) as u8;
        borrow = (d < 0) as i16;
    }
    (out, true)
}

/// A precompile instruction (secp256r1 or ed25519 share the layout) with one entry whose key and
/// signature sit in its own data and whose message is `msg_len` bytes at `msg_off` of instruction `msg_ix`.
fn precompile_ix(program: Address, pubkey: &[u8], sig: &[u8], msg_ix: u16, msg_off: u16, msg_len: u16) -> Instruction {
    let mut d = vec![1u8, 0];
    let pk_off = 16u16;
    let sig_off = pk_off + pubkey.len() as u16;
    for v in [sig_off, u16::MAX, pk_off, u16::MAX, msg_off, msg_len, msg_ix] {
        d.extend_from_slice(&v.to_le_bytes());
    }
    d.extend_from_slice(pubkey);
    d.extend_from_slice(sig);
    Instruction { program_id: program, accounts: vec![], data: d }
}

/// One precompile instruction checking several signatures: entries are (pubkey, signature,
/// message instruction index, message offset, message length).
fn precompile_multi(program: Address, entries: &[(Vec<u8>, Vec<u8>, u16, u16, u16)]) -> Instruction {
    let mut d = vec![entries.len() as u8, 0];
    let mut at = 2 + 14 * entries.len() as u16;
    let mut tail = Vec::new();
    for (pk, sig, msg_ix, msg_off, msg_len) in entries {
        let (pk_off, sig_off) = (at, at + pk.len() as u16);
        at += (pk.len() + sig.len()) as u16;
        for v in [sig_off, u16::MAX, pk_off, u16::MAX, *msg_off, *msg_len, *msg_ix] {
            d.extend_from_slice(&v.to_le_bytes());
        }
        tail.extend_from_slice(pk);
        tail.extend_from_slice(sig);
    }
    d.extend_from_slice(&tail);
    Instruction { program_id: program, accounts: vec![], data: d }
}

fn legacy_size(ixs: &[Instruction], payer: &Address) -> usize {
    let tx = Transaction::new_unsigned(Message::new(ixs, Some(payer)));
    wincode::serialize(&VersionedTransaction::from(tx)).unwrap().len()
}

fn v1_size(ixs: &[Instruction], payer: &Address) -> usize {
    let config = v1::TransactionConfig::empty().with_compute_unit_limit(1_400_000);
    let msg = v1::Message::try_compile_with_config(payer, ixs, Hash::default(), config).unwrap();
    let tx = VersionedTransaction { signatures: vec![Signature::default()], message: VersionedMessage::V1(msg) };
    wincode::serialize(&tx).unwrap().len()
}

struct Bench {
    svm: LiteSVM,
    payer: Keypair,
    program: Address,
}

impl Bench {
    fn new(so: &Path) -> Self {
        let mut svm = LiteSVM::new();
        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), 100_000_000_000).unwrap();
        let program = Address::new_unique();
        svm.add_program_from_file(program, so).unwrap();
        Bench { svm, payer, program }
    }

    fn put(&mut self, data: Vec<u8>) -> Address {
        let a = Address::new_unique();
        let account = Account { lamports: 1_000_000_000, data, owner: self.program, executable: false, rent_epoch: 0 };
        self.svm.set_account(a, account).unwrap();
        a
    }

    fn ix(&self, data: Vec<u8>, accounts: Vec<AccountMeta>) -> Instruction {
        Instruction { program_id: self.program, accounts, data }
    }

    /// Sends compute-budget + `ixs` as a legacy transaction; returns compute units consumed.
    fn send(&mut self, ixs: &[Instruction]) -> Result<u64, String> {
        let mut all = vec![ComputeBudgetInstruction::set_compute_unit_limit(1_400_000)];
        all.extend_from_slice(ixs);
        let tx = Transaction::new(&[&self.payer], Message::new(&all, Some(&self.payer.pubkey())), self.svm.latest_blockhash());
        let res = self.svm.send_transaction(tx);
        self.svm.expire_blockhash();
        match res {
            Ok(meta) => Ok(meta.compute_units_consumed),
            Err(e) => Err(format!("{:?} | {}", e.err, e.meta.logs.join(" / "))),
        }
    }

    /// Same as `send` but as a v1 transaction (SIMD-0385, up to 4096 bytes); compute limit in its config.
    fn send_v1(&mut self, ixs: &[Instruction]) -> Result<u64, String> {
        let config = v1::TransactionConfig::empty()
            .with_compute_unit_limit(1_400_000)
            .with_loaded_accounts_data_size_limit(64 * 1024 * 1024);
        let msg = v1::Message::try_compile_with_config(&self.payer.pubkey(), ixs, self.svm.latest_blockhash(), config).unwrap();
        let tx = VersionedTransaction::try_new(VersionedMessage::V1(msg), &[&self.payer]).unwrap();
        let res = self.svm.send_transaction(tx);
        self.svm.expire_blockhash();
        match res {
            Ok(meta) => Ok(meta.compute_units_consumed),
            Err(e) => Err(format!("{:?} | {}", e.err, e.meta.logs.join(" / "))),
        }
    }
}

fn builds() -> Vec<(&'static str, std::path::PathBuf)> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    ["v0", "v3"]
        .into_iter()
        .map(|a| (a, root.join("target/deploy").join(a).join("dnssec_bench.so")))
        .filter(|(_, p)| p.exists())
        .collect()
}

fn fixture(name: &str) -> Value {
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures").join(name);
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

/// One signed set of a real proof, parsed with the program's own parser.
struct Step {
    signed: Vec<u8>,
    sig: Vec<u8>,
    alg: u8,
    key_tag: u16,
    owner: Vec<u8>,
    rrtype: u16,
    signer: Vec<u8>,
    label: String,
}

fn steps(fx: &Value) -> Vec<Step> {
    let now = fx["fetchedAt"].as_i64().unwrap();
    fx["sets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            let signed = unhex(s["rrset"].as_str().unwrap());
            let (sig, set, ..) = parse_signed(&signed, now).unwrap_or_else(|e| panic!("{e:?}"));
            let (alg, key_tag, signer) = (sig.algorithm, sig.key_tag, sig.signer.to_vec());
            let (owner, rrtype) = (set.owner.to_vec(), set.rrtype);
            let ty = match &s["type"] {
                Value::String(t) => t.clone(),
                Value::Number(n) if n.as_u64() == Some(1) => "A".to_string(),
                v => v.to_string(),
            };
            let label = format!("{} {ty}", s["owner"].as_str().unwrap());
            Step { sig: unhex(s["sig"].as_str().unwrap()), signed, alg, key_tag, owner, rrtype, signer, label }
        })
        .collect()
}

/// The DNSKEY RDATA that signed `step`, from the proof's own DNSKEY sets.
fn signing_key(all: &[Step], step: &Step, now: i64) -> Vec<u8> {
    let keys = all.iter().find(|s| s.rrtype == TYPE_DNSKEY && s.owner == step.signer).expect("signer key set in proof");
    let (_, set, ..) = parse_signed(&keys.signed, now).unwrap();
    set.records
        .iter()
        .find(|k| dnssec::key_tag(k) == step.key_tag && k[3] == step.alg)
        .expect("key with tag")
        .to_vec()
}

fn over_budget(e: &str) -> bool {
    e.contains("exceeded CUs meter") || e.contains("ComputationalBudgetExceeded") || e.contains("Computational budget exceeded")
}

fn rsa_bits(dnskey: &[u8]) -> usize {
    let (_, n) = dnssec_bench::bigint::rsa_key(&dnskey[4..]).unwrap();
    n.len() * 8 - n[0].leading_zeros() as usize
}

#[test]
fn bench() {
    let builds = builds();
    assert!(!builds.is_empty(), "build first: run.sh");
    let synthetic = fixture("synthetic.json");
    let chains = ["cloudflare.com.json", "_wallet.gemprotocol.io.json", "nlnetlabs.nl.json", "ietf.org.json", "nasa.gov.json", "ed25519.nl.json"];

    for (arch, so) in &builds {
        println!("\n==================== SBPF {arch} ({}) ====================", so.display());
        let mut b = Bench::new(so);
        let noop = b.ix(vec![0], vec![]);
        let base = b.send(&[noop]).unwrap();
        println!("baseline: compute budget + no-op instruction = {base} CU");

        // ---------- RSA ----------
        println!("\nRSA PKCS#1 v1.5 verify (modexp + full padding check + hash), CU per limb width:");
        println!("{:<44} {:>6} {:>12} {:>12}", "vector", "bits", "u32 limbs", "u64 limbs");
        let mut rsa_cases: Vec<(String, Vec<u8>, Vec<u8>, Vec<u8>, bool)> = Vec::new();
        for v in synthetic.as_array().unwrap().iter().filter(|v| v["alg"] != 15) {
            let key = unhex(v["dnskey"].as_str().unwrap());
            let sha1 = v["alg"] == 5;
            rsa_cases.push((format!("synthetic {}", v["name"].as_str().unwrap()), key, unhex(v["signed"].as_str().unwrap()), unhex(v["sig"].as_str().unwrap()), sha1));
        }
        for name in ["cloudflare.com.json", "_wallet.gemprotocol.io.json", "ietf.org.json"] {
            let fx = fixture(name);
            let now = fx["fetchedAt"].as_i64().unwrap();
            let all = steps(&fx);
            for st in all.iter().filter(|s| s.alg == 8) {
                let key = signing_key(&all, st, now);
                let label = format!("real {} by {} ({}B signed)", st.label, dnssec::key_tag(&key), st.signed.len());
                if rsa_cases.iter().any(|c| c.1 == key && c.2 == st.signed) {
                    continue;
                }
                rsa_cases.push((label, key, st.signed.clone(), st.sig.clone(), false));
            }
        }
        for (label, key, signed, sig, sha1) in &rsa_cases {
            let input = b.put(fields(&[key, signed, sig]));
            let mut cu = [String::new(), String::new()];
            for limbs in 0..2u8 {
                let ix = b.ix(vec![1, limbs, *sha1 as u8], vec![AccountMeta::new_readonly(input, false)]);
                cu[limbs as usize] = match b.send(&[ix]) {
                    Ok(c) => c.to_string(),
                    Err(e) if over_budget(&e) => "> 1.4M".to_string(),
                    Err(e) => panic!("{label}: {e}"),
                };
            }
            println!("{:<44} {:>6} {:>12} {:>12}", label, rsa_bits(key), cu[0], cu[1]);
            // A flipped signature bit must fail.
            let mut bad = sig.clone();
            bad[sig.len() / 2] ^= 1;
            let input = b.put(fields(&[key, signed, &bad]));
            let ix = b.ix(vec![1, 1, *sha1 as u8], vec![AccountMeta::new_readonly(input, false)]);
            assert!(b.send(&[ix]).is_err(), "{label}: tampered signature accepted");
        }

        // ---------- RSA cost by phase, and the split form for keys too big for one instruction ----------
        println!("
RSA building blocks (u32 limbs), CU each (long division = s*R mod n, run once per signature):");
        println!("{:>6} {:>14} {:>10} {:>10} {:>10}", "bits", "long division", "square", "multiply", "reduce");
        let mut sqr_cost = HashMap::new();
        for v in synthetic.as_array().unwrap().iter().filter(|v| v["alg"] == 8 && v["name"].as_str().unwrap().contains("e65537")) {
            let key = unhex(v["dnskey"].as_str().unwrap());
            let (_, n) = dnssec_bench::bigint::rsa_key(&key[4..]).unwrap();
            let input = b.put(fields(&[n, &unhex(v["sig"].as_str().unwrap())]));
            let mut c = [0i64; 5];
            for phase in 0..5u8 {
                let ix = b.ix(vec![7, phase], vec![AccountMeta::new_readonly(input, false)]);
                c[phase as usize] = b.send(&[ix]).unwrap() as i64;
            }
            println!("{:>6} {:>14} {:>10} {:>10} {:>10}", n.len() * 8, c[1] - c[0], c[2] - c[1], c[3] - c[1], c[4] - c[1]);
            sqr_cost.insert(n.len() * 8, (c[2] - c[1]) as u64);
        }
        println!("
Split RSA (state in an account; start = checks + long division, then squarings per tx, finish = reduce + PKCS#1 check):");
        for v in synthetic.as_array().unwrap().iter().filter(|v| v["alg"] == 8 && v["name"].as_str().unwrap().contains("e65537")) {
            let key = unhex(v["dnskey"].as_str().unwrap());
            let (_, n) = dnssec_bench::bigint::rsa_key(&key[4..]).unwrap();
            let bits = n.len() * 8;
            let input = b.put(fields(&[&key, &unhex(v["signed"].as_str().unwrap()), &unhex(v["sig"].as_str().unwrap())]));
            let state = b.put(vec![0u8; dnssec_bench::bigint::split::size(n.len())]);
            let start = b.send(&[b.ix(vec![8], vec![AccountMeta::new_readonly(input, false), AccountMeta::new(state, false)])]).unwrap();
            // As many squarings per transaction as fit under 1.4M with a margin for the final multiply.
            let per_tx = ((1_300_000 / sqr_cost[&bits]) as u8).max(1);
            let mut txs = vec![start];
            let mut left = 16u32;
            while left > 0 {
                let k = (per_tx as u32).min(left);
                txs.push(b.send(&[b.ix(vec![9, k as u8], vec![AccountMeta::new(state, false)])]).unwrap());
                left -= k;
            }
            let fin = b.send(&[b.ix(vec![10], vec![AccountMeta::new_readonly(input, false), AccountMeta::new_readonly(state, false)])]);
            let fin = fin.unwrap_or_else(|e| panic!("split {bits}: {e}"));
            txs.push(fin);
            println!("  {bits:>4}-bit: {} instructions, CU each {:?}, total {}", txs.len(), txs, txs.iter().sum::<u64>());
            // The same state with a wrong signature must not verify.
            let mut bad = unhex(v["sig"].as_str().unwrap());
            bad[5] ^= 1;
            let input2 = b.put(fields(&[&key, &unhex(v["signed"].as_str().unwrap()), &bad]));
            let state2 = b.put(vec![0u8; dnssec_bench::bigint::split::size(n.len())]);
            b.send(&[b.ix(vec![8], vec![AccountMeta::new_readonly(input2, false), AccountMeta::new(state2, false)])]).unwrap();
            for _ in 0..16u32.div_ceil(per_tx as u32) {
                b.send(&[b.ix(vec![9, per_tx], vec![AccountMeta::new(state2, false)])]).unwrap();
            }
            assert!(b.send(&[b.ix(vec![10], vec![AccountMeta::new_readonly(input2, false), AccountMeta::new_readonly(state2, false)])]).is_err());
        }

        // ---------- P-256 through the secp256r1 precompile ----------
        println!("\nP-256 (algorithm 13) via secp256r1 precompile + instructions-sysvar introspection:");
        let fx = fixture("cloudflare.com.json");
        let now = fx["fetchedAt"].as_i64().unwrap();
        let all = steps(&fx);
        let mut high = 0;
        for st in all.iter().filter(|s| s.alg == 13) {
            high += low_s(&st.sig).1 as usize;
        }
        println!("  real cloudflare.com chain: {high} of {} P-256 signatures have high S and must be normalized", all.iter().filter(|s| s.alg == 13).count());
        for st in all.iter().filter(|s| s.alg == 13 && s.signed.len() < 900) {
            let key = signing_key(&all, st, now);
            let pk = p256_compressed(&key[4..]).unwrap();
            let (sig, flipped) = low_s(&st.sig);
            let mut data = vec![2u8, 1, 0];
            data.extend_from_slice(&key);
            data.extend_from_slice(&st.signed);
            let msg_off = (3 + key.len()) as u16;
            let ours = b.ix(data.clone(), vec![AccountMeta::new_readonly(IX_SYSVAR, false)]);
            let pre = precompile_ix(SECP256R1, &pk, &sig, 2, msg_off, st.signed.len() as u16);
            let cu = b.send(&[pre, ours.clone()]).unwrap_or_else(|e| panic!("{}: {e}", st.label));
            println!("  {:<40} {:>4}B signed  {:>6} CU total  (S normalized: {flipped})", st.label, st.signed.len(), cu);
            if flipped {
                let pre = precompile_ix(SECP256R1, &pk, &st.sig, 2, msg_off, st.signed.len() as u16);
                let e = b.send(&[pre, ours.clone()]).unwrap_err();
                println!("    raw high-S signature rejected by the precompile: {}", e.split(" | ").next().unwrap());
            }
            let mut tampered = data.clone();
            *tampered.last_mut().unwrap() ^= 1;
            let pre = precompile_ix(SECP256R1, &pk, &sig, 2, msg_off, st.signed.len() as u16);
            assert!(b.send(&[pre, b.ix(tampered, vec![AccountMeta::new_readonly(IX_SYSVAR, false)])]).is_err());
            // The precompile checked a different message than the one the program parses.
            let pre = precompile_ix(SECP256R1, &pk, &sig, 2, msg_off + 1, st.signed.len() as u16 - 1);
            assert!(b.send(&[pre, ours.clone()]).is_err());
        }

        // ---------- Ed25519 ----------
        let v = synthetic.as_array().unwrap().iter().find(|v| v["alg"] == 15).unwrap();
        let (key, signed, sig) = (unhex(v["dnskey"].as_str().unwrap()), unhex(v["signed"].as_str().unwrap()), unhex(v["sig"].as_str().unwrap()));
        let mut data = vec![3u8, 1, 0];
        data.extend_from_slice(&key);
        data.extend_from_slice(&signed);
        let pre = precompile_ix(ED25519, &key[4..], &sig, 2, (3 + key.len()) as u16, signed.len() as u16);
        let cu = b.send(&[pre, b.ix(data, vec![AccountMeta::new_readonly(IX_SYSVAR, false)])]).unwrap();
        println!("\nEd25519 (algorithm 15) via ed25519 precompile, synthetic {}B message: {cu} CU total", signed.len());

        // ---------- DS digests ----------
        println!("\nDS digest over owner name + DNSKEY RDATA:");
        let root = &all[0];
        let (_, root_set, ..) = parse_signed(&root.signed, now).unwrap();
        for key in root_set.records.iter() {
            let msg = [&[0u8][..], key].concat();
            let s1 = dnssec_bench::sha1::sha1(&[&msg]);
            let s2 = dnssec_bench::sha256(&[&msg]);
            let i1 = b.put([fields(&[&msg]), s1.to_vec()].concat());
            let i2 = b.put([fields(&[&msg]), s2.to_vec()].concat());
            let c1 = b.send(&[b.ix(vec![4], vec![AccountMeta::new_readonly(i1, false)])]).unwrap();
            let c2 = b.send(&[b.ix(vec![5], vec![AccountMeta::new_readonly(i2, false)])]).unwrap();
            let anchor = dnssec::ROOT_ANCHORS.iter().any(|a| a[4..] == s2[..]);
            println!("  root key {:>5} ({:>3}B input): SHA-1 in BPF {:>6} CU, SHA-256 syscall {:>5} CU{}", dnssec::key_tag(key), msg.len(), c1, c2, if anchor { "  (matches an IANA anchor)" } else { "" });
        }

        // ---------- full steps on real chains ----------
        println!("\nFull proof steps (verify_step + cache write), real chains, legacy tx limit {LEGACY_MAX} B:");
        println!("{:<34} {:>3} {:>5} {:>5} {:>5} {:>9} {:>9} {:>8}  {}", "step", "alg", "key", "sgnd", "sig", "legacy B", "v1 B", "CU", "mode");
        for name in chains {
            let fx = fixture(name);
            let now = fx["fetchedAt"].as_i64().unwrap();
            let all = steps(&fx);
            println!("-- {} {} (fetched {now})", fx["query"]["type"].as_str().unwrap(), fx["query"]["name"].as_str().unwrap());
            let mut cache: HashMap<(Vec<u8>, u16), Address> = HashMap::new();
            for st in &all {
                let is_root_keys = st.rrtype == TYPE_DNSKEY && st.owner == [0];
                let parent_key = if st.rrtype == TYPE_DNSKEY && st.owner == st.signer { (st.owner.clone(), TYPE_DS) } else { (st.signer.clone(), TYPE_DNSKEY) };
                let parent = match cache.get(&parent_key) {
                    _ if is_root_keys => IX_SYSVAR,
                    Some(p) => *p,
                    None => {
                        println!("{:<34} skipped: its parent did not verify", st.label);
                        continue;
                    }
                };
                let (_, set, ..) = parse_signed(&st.signed, now).unwrap();
                let size = 25 + set.owner.len() + set.records.iter().map(|r| 2 + r.len()).sum::<usize>();
                let target = b.put(vec![0u8; size]);
                let key = signing_key(&all, st, now);
                let key_bits = if st.alg == 8 || st.alg == 5 || st.alg == 7 { rsa_bits(&key) } else { 256 };
                let precompile = st.alg == 13 || st.alg == 15;
                let sig_for_ix: Vec<u8> = if precompile { vec![] } else { st.sig.clone() };

                let (legacy, v1b) = prod_sizes(st, precompile);
                let mode = if legacy <= LEGACY_MAX { "inline" } else if !precompile { "buffer" } else { "v1 only" };
                // Legacy transactions start with the compute-limit instruction; v1 ones carry it in the header.
                let pre_ix: u8 = if mode == "v1 only" { 0 } else { 1 };
                // Precompile steps find their entry by scanning, as the production instruction does.
                let mut data = vec![6u8, if precompile { 2 } else { 0 }, pre_ix, 0];
                data.extend_from_slice(&now.to_le_bytes());
                data.extend_from_slice(&fields(&[&st.signed, &sig_for_ix]));
                let metas = |extra: Option<Address>| {
                    let mut m = vec![AccountMeta::new_readonly(parent, false), AccountMeta::new(target, false), AccountMeta::new_readonly(IX_SYSVAR, false)];
                    if let Some(x) = extra {
                        m.push(AccountMeta::new_readonly(x, false));
                    }
                    m
                };
                let mut ixs = Vec::new();
                if precompile {
                    let pk = if st.alg == 13 { p256_compressed(&key[4..]).unwrap().to_vec() } else { key[4..].to_vec() };
                    let sig = if st.alg == 13 { low_s(&st.sig).0 } else { st.sig.clone() };
                    ixs.push(precompile_ix(if st.alg == 13 { SECP256R1 } else { ED25519 }, &pk, &sig, pre_ix as u16 + 1, 14, st.signed.len() as u16));
                }
                ixs.push(b.ix(data, metas(None)));
                let res = match mode {
                    "inline" => b.send(&ixs),
                    "buffer" => {
                        // Too big for one legacy tx: the signed set + signature go to a buffer account first.
                        let buf = b.put(fields(&[&st.signed, &st.sig]));
                        let mut data = vec![6u8, 1, 0, 0];
                        data.extend_from_slice(&now.to_le_bytes());
                        b.send(&[b.ix(data, metas(Some(buf)))])
                    }
                    // The precompile needs the message inside the transaction: only a v1 transaction fits it.
                    _ => b.send_v1(&ixs),
                };
                let ok = res.is_ok();
                let cu = match res {
                    Ok(c) => c.to_string(),
                    Err(e) if over_budget(&e) => "> 1.4M".to_string(),
                    Err(e) => panic!("{} {}: {e}", name, st.label),
                };
                println!("{:<34} {:>3} {:>5} {:>5} {:>5} {:>9} {:>9} {:>8}  {}", st.label, st.alg, key_bits, st.signed.len(), st.sig.len(), legacy, v1b, cu, mode);
                if ok {
                    cache.insert((st.owner.clone(), st.rrtype), target);
                }
            }
            // The leaf is cached only if every step before it verified.
            let leaf = all.last().unwrap();
            let cached = cache.get(&(leaf.owner.clone(), leaf.rrtype)).and_then(|a| b.svm.get_account(a)).is_some_and(|a| a.data[0] == 1);
            println!("   leaf verified and cached: {cached}");
        }

        // Buffered steps: how many upload transactions each needs, and the verify transaction's size.
        if *arch == "v0" {
            let (chunk, write_size) = prod_write_chunk();
            let last = prod_last_chunk();
            println!("
Buffer upload: write_buffer carries at most {chunk} bytes per legacy tx ({write_size} B tx at that size);");
            println!("the final {last} bytes can ride in the verify transaction itself");
            for name in chains {
                let fx = fixture(name);
                for st in steps(&fx) {
                    let precompile = st.alg == 13 || st.alg == 15;
                    let (legacy, _) = prod_sizes(&st, precompile);
                    if legacy <= LEGACY_MAX || precompile {
                        continue;
                    }
                    let payload = 8 + st.signed.len() + st.sig.len();
                    println!(
                        "  {:<30} payload {:>5} B -> {} write tx(s) + verify tx ({} B), or {} tx(s) in all with the last chunk in the verify tx",
                        st.label,
                        payload,
                        payload.div_ceil(chunk),
                        prod_verify_from_buffer_size(),
                        1 + payload.saturating_sub(last).div_ceil(chunk)
                    );
                }
            }

            // Several P-256 steps in one transaction: one precompile instruction with an entry per step.
            println!("
Packing P-256 steps into one legacy transaction (production shape):");
            let fx = fixture("cloudflare.com.json");
            let all = steps(&fx);
            let (ds, keys) = (&all[3], &all[4]);
            // A realistic leaf: _wallet.cloudflare.com TXT "SOL <44-char base58>", signed by the zone.
            let mut leaf_signed = vec![0u8; 18];
            leaf_signed.extend_from_slice(b"\x0acloudflare\x03com\x00");
            leaf_signed.extend_from_slice(b"\x07_wallet\x0acloudflare\x03com\x00");
            leaf_signed.extend_from_slice(&[0, 16, 0, 1, 0, 0, 1, 44, 0, 49, 48]);
            leaf_signed.extend_from_slice(b"SOL 9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
            let leaf = Step { signed: leaf_signed, sig: vec![0; 64], alg: 13, key_tag: 0, owner: vec![], rrtype: 16, signer: vec![], label: "_wallet TXT (SOL)".into() };
            println!("  _wallet.cloudflare.com TXT \"SOL <base58>\" would be {} signed bytes", leaf.signed.len());
            for (label, group) in [("domain DS + DNSKEY", vec![ds, keys]), ("DNSKEY + _wallet TXT", vec![keys, &leaf]), ("DS + DNSKEY + _wallet TXT", vec![ds, keys, &leaf])] {
                let size = prod_packed_size(&group);
                println!("  {label:<28} {size:>5} B  {}", if size <= LEGACY_MAX { "fits" } else { "too big" });
            }
            // And run the first pair for real: both steps verify in one transaction.
            let now = fx["fetchedAt"].as_i64().unwrap();
            let parent_key = signing_key(&all, ds, now);
            let parent_set = b.put({
                let (_, set, ..) = parse_signed(&all[2].signed, now).unwrap();
                let mut d = vec![1u8, 48, 0, 13, 0, 0, set.records.len() as u8, 0];
                d.extend_from_slice(&0i64.to_le_bytes());
                d.extend_from_slice(&i64::MAX.to_le_bytes());
                d.push(set.owner.len() as u8);
                d.extend_from_slice(set.owner);
                for r in &set.records {
                    d.extend_from_slice(&fields(&[r]));
                }
                d
            });
            let t1 = b.put(vec![0u8; 256]);
            let t2 = b.put(vec![0u8; 512]);
            let key2 = signing_key(&all, keys, now);
            let mk = |_entry: u8, st: &Step, parent: Address, target: Address| {
                let mut data = vec![6u8, 2, 0, 0];
                data.extend_from_slice(&now.to_le_bytes());
                data.extend_from_slice(&fields(&[&st.signed, &[]]));
                b.ix(data, vec![AccountMeta::new_readonly(parent, false), AccountMeta::new(target, false), AccountMeta::new_readonly(IX_SYSVAR, false)])
            };
            let pre = precompile_multi(
                SECP256R1,
                &[
                    (p256_compressed(&parent_key[4..]).unwrap().to_vec(), low_s(&ds.sig).0, 2, 14, ds.signed.len() as u16),
                    (p256_compressed(&key2[4..]).unwrap().to_vec(), low_s(&keys.sig).0, 3, 14, keys.signed.len() as u16),
                ],
            );
            let cu = b.send(&[pre, mk(0, ds, parent_set, t1), mk(1, keys, t1, t2)]).unwrap();
            println!("  ran cloudflare.com DS + DNSKEY in one transaction: {cu} CU total");
        }

        // Cache rules: an older set cannot replace a newer one; replaying the same set is a no-op.
        let r = |a, b, c, d, e| dnssec::replaces(a, b, c, d, e);
        assert!(r(200, 900, 100, 900, 150) && !r(100, 900, 200, 900, 150) && !r(200, 900, 200, 900, 150) && r(200, 950, 200, 900, 150) && r(50, 900, 200, 120, 150));
    }
}

/// Exact sizes of the production transaction for a step, inline. Anchor-style instructions:
/// RSA `verify_rrset(signed: Vec<u8>, sig: Vec<u8>)` with a compute-limit instruction in front
/// (v1 carries the limit in its header); P-256/Ed25519 `verify_rrset_precompiled(signed: Vec<u8>)`
/// after the precompile instruction, its message at byte 12 of our data. Accounts: payer, parent
/// PDA, result PDA, system program, instructions sysvar.
fn prod_sizes(st: &Step, precompile: bool) -> (usize, usize) {
    let payer = Address::new_unique();
    let program = Address::new_unique();
    let mut data = vec![0u8; 8];
    data.extend_from_slice(&(st.signed.len() as u32).to_le_bytes());
    data.extend_from_slice(&st.signed);
    if !precompile {
        data.extend_from_slice(&(st.sig.len() as u32).to_le_bytes());
        data.extend_from_slice(&st.sig);
    }
    let ours = Instruction {
        program_id: program,
        accounts: vec![
            AccountMeta::new(payer, true),
            AccountMeta::new_readonly(Address::new_unique(), false),
            AccountMeta::new(Address::new_unique(), false),
            AccountMeta::new_readonly(solana_sdk_ids::system_program::ID, false),
            AccountMeta::new_readonly(IX_SYSVAR, false),
        ],
        data,
    };
    let mut legacy_ixs = Vec::new();
    let mut v1_ixs = Vec::new();
    if precompile {
        let pk_len = if st.alg == 13 { 33 } else { 32 };
        let pre = precompile_ix(if st.alg == 13 { SECP256R1 } else { ED25519 }, &vec![2u8; pk_len], &[0u8; 64], 1, 12, st.signed.len() as u16);
        legacy_ixs.push(pre.clone());
        v1_ixs.push(pre);
    } else {
        legacy_ixs.push(ComputeBudgetInstruction::set_compute_unit_limit(1_400_000));
    }
    legacy_ixs.push(ours.clone());
    v1_ixs.push(ours);
    (legacy_size(&legacy_ixs, &payer), v1_size(&v1_ixs, &payer))
}

/// Exact size of one legacy transaction carrying several P-256 steps (production shape, each step
/// with its own parent and result PDA, the next step's parent being the previous one's result).
fn prod_packed_size(group: &[&Step]) -> usize {
    let payer = Address::new_unique();
    let program = Address::new_unique();
    let mut pdas: Vec<Address> = (0..=group.len()).map(|_| Address::new_unique()).collect();
    let mut ixs = vec![precompile_multi(
        SECP256R1,
        &group.iter().map(|st| (vec![2u8; 33], vec![0u8; 64], 1, 12, st.signed.len() as u16)).collect::<Vec<_>>(),
    )];
    for (i, st) in group.iter().enumerate() {
        let mut data = vec![0u8; 8];
        data.extend_from_slice(&(st.signed.len() as u32).to_le_bytes());
        data.extend_from_slice(&st.signed);
        ixs.push(Instruction {
            program_id: program,
            accounts: vec![
                AccountMeta::new(payer, true),
                AccountMeta::new_readonly(pdas[i], false),
                AccountMeta::new(pdas[i + 1], false),
                AccountMeta::new_readonly(solana_sdk_ids::system_program::ID, false),
                AccountMeta::new_readonly(IX_SYSVAR, false),
            ],
            data,
        });
    }
    pdas.clear();
    legacy_size(&ixs, &payer)
}

/// Largest chunk a production `write_buffer(offset: u32, bytes: Vec<u8>)` instruction (accounts:
/// payer, buffer PDA, system program) can carry in one legacy transaction, and that tx's size.
fn prod_write_chunk() -> (usize, usize) {
    let payer = Address::new_unique();
    let program = Address::new_unique();
    let size = |chunk: usize| {
        let mut data = vec![0u8; 8 + 4 + 4];
        data.extend(std::iter::repeat_n(0u8, chunk));
        let ix = Instruction {
            program_id: program,
            accounts: vec![
                AccountMeta::new(payer, true),
                AccountMeta::new(Address::new_unique(), false),
                AccountMeta::new_readonly(solana_sdk_ids::system_program::ID, false),
            ],
            data,
        };
        legacy_size(&[ix], &payer)
    };
    let mut chunk = 0;
    while size(chunk + 1) <= LEGACY_MAX {
        chunk += 1;
    }
    (chunk, size(chunk))
}

/// Largest last chunk that fits in the same legacy transaction as the buffered verify.
fn prod_last_chunk() -> usize {
    let payer = Address::new_unique();
    let program = Address::new_unique();
    let buffer = Address::new_unique();
    let size = |chunk: usize| {
        let mut data = vec![0u8; 8 + 4 + 4];
        data.extend(std::iter::repeat_n(0u8, chunk));
        let write = Instruction {
            program_id: program,
            accounts: vec![
                AccountMeta::new(payer, true),
                AccountMeta::new(buffer, false),
                AccountMeta::new_readonly(solana_sdk_ids::system_program::ID, false),
            ],
            data,
        };
        let verify = Instruction {
            program_id: program,
            accounts: vec![
                AccountMeta::new(payer, true),
                AccountMeta::new_readonly(Address::new_unique(), false),
                AccountMeta::new(Address::new_unique(), false),
                AccountMeta::new_readonly(solana_sdk_ids::system_program::ID, false),
                AccountMeta::new_readonly(IX_SYSVAR, false),
                AccountMeta::new(buffer, false),
            ],
            data: vec![0u8; 8],
        };
        legacy_size(&[ComputeBudgetInstruction::set_compute_unit_limit(1_400_000), write, verify], &payer)
    };
    let mut chunk = 0;
    while size(chunk + 1) <= LEGACY_MAX {
        chunk += 1;
    }
    chunk
}

/// The verify transaction once the signed set and signature sit in the buffer.
fn prod_verify_from_buffer_size() -> usize {
    let payer = Address::new_unique();
    let ix = Instruction {
        program_id: Address::new_unique(),
        accounts: vec![
            AccountMeta::new(payer, true),
            AccountMeta::new_readonly(Address::new_unique(), false),
            AccountMeta::new(Address::new_unique(), false),
            AccountMeta::new_readonly(solana_sdk_ids::system_program::ID, false),
            AccountMeta::new_readonly(IX_SYSVAR, false),
            AccountMeta::new(Address::new_unique(), false),
        ],
        data: vec![0u8; 8],
    };
    legacy_size(&[ComputeBudgetInstruction::set_compute_unit_limit(1_400_000), ix], &payer)
}

#[allow(dead_code)]
fn _uses(_: RRset) {}
