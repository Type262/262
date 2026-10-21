//! pump.fun in LiteSVM for the launcher suites: the mainnet programs and config accounts from
//! tests/fixtures/pump (node solana/scripts/fetch-fixtures.mjs), hand-encoded pump.fun instructions
//! in the same order as scripts/pump-ix.mjs and docs/PUMP.md, readers for the accounts the tests
//! check, and the `launch` / `collect` instructions the way a client builds them.

#![allow(dead_code)]

use borsh::BorshSerialize;
use litesvm::types::TransactionMetadata;
use sha2::{Digest, Sha256};
use solana_account::Account;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::{v0, AddressLookupTableAccount, VersionedMessage};
use solana_sdk_ids::system_program;
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;
use solana_transaction::Transaction;
use std::path::PathBuf;
use std::str::FromStr;
use type262_tests::*;

pub fn pk(s: &str) -> Pubkey {
    Pubkey::from_str(s).unwrap()
}

// ---------- programs and fixed accounts (docs/PUMP.md) ----------

pub fn pump() -> Pubkey {
    pk("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P")
}
pub fn pump_amm() -> Pubkey {
    pk("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA")
}
pub fn pump_fees() -> Pubkey {
    pk("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ")
}
pub fn mayhem() -> Pubkey {
    pk("MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e")
}
pub fn token() -> Pubkey {
    pk("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
}
pub fn token_2022() -> Pubkey {
    pk("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")
}
pub fn ata_program() -> Pubkey {
    pk("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
}
pub fn wsol() -> Pubkey {
    pk("So11111111111111111111111111111111111111112")
}
pub fn rent_sysvar() -> Pubkey {
    pk("SysvarRent111111111111111111111111111111111")
}
pub fn compute_budget_program() -> Pubkey {
    pk("ComputeBudget111111111111111111111111111111")
}
pub fn lookup_table_program() -> Pubkey {
    pk("AddressLookupTab1e1111111111111111111111111")
}

pub fn global() -> Pubkey {
    pk("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf")
}
pub fn mint_authority() -> Pubkey {
    pk("TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM")
}
pub fn pump_event_authority() -> Pubkey {
    pk("Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1")
}
pub fn pump_fee_config() -> Pubkey {
    pk("8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt")
}
pub fn amm_global_config() -> Pubkey {
    pk("ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw")
}
pub fn amm_fee_config() -> Pubkey {
    pk("5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx")
}
pub fn amm_event_authority() -> Pubkey {
    pk("GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR")
}
pub fn mayhem_global_params() -> Pubkey {
    pk("13ec7XdrjF3h3YcqBTFDSReRcUFwbCnJaAQspM4j6DDJ")
}
pub fn mayhem_sol_vault() -> Pubkey {
    pk("BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s")
}
/// Global.buyback_fee_recipients[0] (pump) = GlobalConfig.buyback_fee_recipients[0] (PumpSwap).
pub fn buyback() -> Pubkey {
    pk("5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD")
}

pub fn find(seeds: &[&[u8]], program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(seeds, program).0
}
pub fn ata(owner: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Pubkey {
    find(
        &[owner.as_ref(), token_program.as_ref(), mint.as_ref()],
        &ata_program(),
    )
}
pub fn bonding_curve(mint: &Pubkey) -> Pubkey {
    find(&[b"bonding-curve", mint.as_ref()], &pump())
}
pub fn creator_vault(creator: &Pubkey) -> Pubkey {
    find(&[b"creator-vault", creator.as_ref()], &pump())
}
pub fn amm_creator_vault(creator: &Pubkey) -> Pubkey {
    find(&[b"creator_vault", creator.as_ref()], &pump_amm())
}
pub fn mayhem_state(mint: &Pubkey) -> Pubkey {
    find(&[b"mayhem-state", mint.as_ref()], &mayhem())
}
pub fn pool_authority(mint: &Pubkey) -> Pubkey {
    find(&[b"pool-authority", mint.as_ref()], &pump())
}
/// The canonical PumpSwap pool a graduated SOL coin migrates into.
pub fn canonical_pool(mint: &Pubkey) -> Pubkey {
    find(
        &[
            b"pool",
            &0u16.to_le_bytes(),
            pool_authority(mint).as_ref(),
            mint.as_ref(),
            wsol().as_ref(),
        ],
        &pump_amm(),
    )
}

// ---------- fixtures ----------

pub fn fixtures() -> PathBuf {
    workspace().join("tests/fixtures/pump")
}

/// Loads the mainnet pump.fun programs and accounts into `env` (on top of the type262 program),
/// including mainnet's Rent sysvar, so rent minimums match mainnet.
pub fn load_pump(env: &mut Env) {
    let dir = fixtures();
    assert!(
        dir.join("pump.so").exists(),
        "pump.fun fixtures missing: run `node solana/scripts/fetch-fixtures.mjs` (see docs/PUMP.md)"
    );
    let upgradeable = pk("BPFLoaderUpgradeab1e11111111111111111111111");
    let loader2 = pk("BPFLoader2111111111111111111111111111111111");
    for (file, id, loader) in [
        ("pump.so", pump(), upgradeable),
        ("pump_amm.so", pump_amm(), upgradeable),
        ("pump_fees.so", pump_fees(), upgradeable),
        ("mayhem.so", mayhem(), upgradeable),
        (
            "mpl_token_metadata.so",
            pk("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"),
            upgradeable,
        ),
        ("spl_token_2022.so", token_2022(), upgradeable),
        ("spl_token.so", token(), upgradeable),
        ("spl_associated_token_account.so", ata_program(), loader2),
    ] {
        let bytes = std::fs::read(dir.join(file)).unwrap();
        env.svm
            .add_program_with_loader(id, &bytes, loader)
            .unwrap_or_else(|e| panic!("load {file}: {e:?}"));
    }
    for entry in std::fs::read_dir(dir.join("accounts")).unwrap() {
        let path = entry.unwrap().path();
        let json = std::fs::read_to_string(&path).unwrap();
        let address = pk(json_str(&json, "pubkey"));
        let account = Account {
            lamports: json_num(&json, "lamports"),
            data: base64(json_str(&json, "data")),
            owner: pk(json_str(&json, "owner")),
            executable: json_raw(&json, "executable") == "true",
            rent_epoch: u64::MAX,
        };
        env.svm
            .set_account(address, account)
            .unwrap_or_else(|e| panic!("set {}: {e:?}", path.display()));
    }
}

/// A fresh chain with type262 and pump.fun loaded.
pub fn pump_env() -> Env {
    let mut env = Env::new();
    load_pump(&mut env);
    env
}

// The fixture JSON is flat and machine-written ({ "key": value, ... }), so a field lookup is enough.
fn json_raw<'a>(json: &'a str, key: &str) -> &'a str {
    let at = json
        .find(&format!("\"{key}\":"))
        .unwrap_or_else(|| panic!("no {key}"))
        + key.len()
        + 3;
    let rest = json[at..].trim_start();
    let end = rest.find([',', '\n', '}']).unwrap();
    rest[..end].trim()
}
fn json_str<'a>(json: &'a str, key: &str) -> &'a str {
    json_raw(json, key).trim_matches('"')
}
fn json_num(json: &str, key: &str) -> u64 {
    json_raw(json, key).parse().unwrap()
}

pub fn base64(s: &str) -> Vec<u8> {
    let val = |c: u8| -> u32 {
        match c {
            b'A'..=b'Z' => (c - b'A') as u32,
            b'a'..=b'z' => (c - b'a' + 26) as u32,
            b'0'..=b'9' => (c - b'0' + 52) as u32,
            b'+' => 62,
            b'/' => 63,
            _ => panic!("bad base64 {c}"),
        }
    };
    let bytes: Vec<u8> = s.bytes().filter(|&c| c != b'=').collect();
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    for chunk in bytes.chunks(4) {
        let mut n = 0u32;
        for (i, &c) in chunk.iter().enumerate() {
            n |= val(c) << (18 - 6 * i);
        }
        out.push((n >> 16) as u8);
        if chunk.len() > 2 {
            out.push((n >> 8) as u8);
        }
        if chunk.len() > 3 {
            out.push(n as u8);
        }
    }
    out
}

// ---------- encoding ----------

pub fn sha256(b: &[u8]) -> [u8; 32] {
    Sha256::digest(b).into()
}

/// Anchor instruction data for another program: sha256("global:<name>")[..8] + borsh args.
pub fn anchor_data(name: &str, args: &[&[u8]]) -> Vec<u8> {
    let mut v = discriminator("global", name).to_vec();
    for a in args {
        v.extend_from_slice(a);
    }
    v
}

pub fn borsh_str(s: &str) -> Vec<u8> {
    let mut v = (s.len() as u32).to_le_bytes().to_vec();
    v.extend_from_slice(s.as_bytes());
    v
}

pub fn set_compute_limit(units: u32) -> Instruction {
    let mut data = vec![2u8];
    data.extend_from_slice(&units.to_le_bytes());
    Instruction {
        program_id: compute_budget_program(),
        accounts: vec![],
        data,
    }
}

pub fn transfer(from: &Pubkey, to: &Pubkey, lamports: u64) -> Instruction {
    let mut data = 2u32.to_le_bytes().to_vec();
    data.extend_from_slice(&lamports.to_le_bytes());
    Instruction {
        program_id: system_program::ID,
        accounts: vec![w(*from).with_signer(), w(*to)],
        data,
    }
}

trait WithSigner {
    fn with_signer(self) -> Self;
}
impl WithSigner for AccountMeta {
    fn with_signer(mut self) -> Self {
        self.is_signer = true;
        self
    }
}

pub fn create_ata_idempotent(
    payer: &Pubkey,
    owner: &Pubkey,
    mint: &Pubkey,
    token_program: &Pubkey,
) -> Instruction {
    Instruction {
        program_id: ata_program(),
        accounts: vec![
            ws(*payer),
            w(ata(owner, mint, token_program)),
            r(*owner),
            r(*mint),
            r(system_program::ID),
            r(*token_program),
        ],
        data: vec![1],
    }
}

pub fn sync_native(account: &Pubkey) -> Instruction {
    Instruction {
        program_id: token(),
        accounts: vec![w(*account)],
        data: vec![17],
    }
}

// ---------- pump (bonding curve) ----------

/// The 16 create_v2 accounts, in pump's order: what `launch` takes as remaining accounts.
pub fn create_v2_accounts(mint: &Pubkey, user: &Pubkey) -> Vec<AccountMeta> {
    let curve = bonding_curve(mint);
    vec![
        ws(*mint),
        r(mint_authority()),
        w(curve),
        w(ata(&curve, mint, &token_2022())),
        r(global()),
        ws(*user),
        r(system_program::ID),
        r(token_2022()),
        r(ata_program()),
        w(mayhem()),
        r(mayhem_global_params()),
        w(mayhem_sol_vault()),
        w(mayhem_state(mint)),
        w(ata(&mayhem_sol_vault(), mint, &token_2022())),
        r(pump_event_authority()),
        r(pump()),
    ]
}

/// pump's create_v2 called directly (not through type262), with any creator.
pub fn create_v2(mint: &Pubkey, user: &Pubkey, creator: &Pubkey) -> Instruction {
    Instruction {
        program_id: pump(),
        accounts: create_v2_accounts(mint, user),
        data: anchor_data(
            "create_v2",
            &[
                &borsh_str("Example"),
                &borsh_str("EX"),
                &borsh_str("https://example.com/m.json"),
                creator.as_ref(),
                &[0],
                &[0],
                &0u64.to_le_bytes(),
                &[0],
            ],
        ),
    }
}

fn trade_accounts(mint: &Pubkey, user: &Pubkey) -> Vec<AccountMeta> {
    let curve = bonding_curve(mint);
    vec![
        r(global()),
        r(*mint),
        r(wsol()),
        r(token_2022()),
        r(token()),
        w(curve),
        w(ata(&curve, mint, &token_2022())),
        w(ata(&curve, &wsol(), &token())),
        ws(*user),
        w(ata(user, mint, &token_2022())),
        w(ata(user, &wsol(), &token())),
        w(find(&[b"user_volume_accumulator", user.as_ref()], &pump())),
        r(pump_fee_config()),
        w(buyback()),
        r(system_program::ID),
        r(pump_event_authority()),
        r(pump()),
    ]
}

/// buy_v3: `amount` tokens (6 decimals) for at most `max_sol_cost` lamports, fees included.
pub fn buy_v3(mint: &Pubkey, user: &Pubkey, amount: u64, max_sol_cost: u64) -> Instruction {
    Instruction {
        program_id: pump(),
        accounts: trade_accounts(mint, user),
        data: anchor_data(
            "buy_v3",
            &[&amount.to_le_bytes(), &max_sol_cost.to_le_bytes(), &[0]],
        ),
    }
}

pub fn sell_v3(mint: &Pubkey, user: &Pubkey, amount: u64, min_sol_output: u64) -> Instruction {
    Instruction {
        program_id: pump(),
        accounts: trade_accounts(mint, user),
        data: anchor_data(
            "sell_v3",
            &[&amount.to_le_bytes(), &min_sol_output.to_le_bytes()],
        ),
    }
}

/// Permissionless: BondingCurve.creator_fee -> creator-vault(curve creator).
pub fn sweep_creator_fee(payer: &Pubkey, mint: &Pubkey, creator: &Pubkey) -> Instruction {
    let curve = bonding_curve(mint);
    let vault = creator_vault(creator);
    Instruction {
        program_id: pump(),
        accounts: vec![
            ws(*payer),
            r(global()),
            r(*mint),
            r(wsol()),
            r(token()),
            r(ata_program()),
            r(system_program::ID),
            w(curve),
            w(ata(&curve, &wsol(), &token())),
            w(vault),
            w(ata(&vault, &wsol(), &token())),
            r(pump_event_authority()),
            r(pump()),
        ],
        data: anchor_data("sweep_creator_fee", &[]),
    }
}

/// Permissionless once the curve is complete. Two remaining accounts (the pool's boost vault
/// authority and its WSOL ATA) are required by today's pump.
pub fn migrate_v2(user: &Pubkey, mint: &Pubkey, withdraw_authority: &Pubkey) -> Instruction {
    let curve = bonding_curve(mint);
    let pool_auth = pool_authority(mint);
    let pool = canonical_pool(mint);
    let lp_mint = find(&[b"pool_lp_mint", pool.as_ref()], &pump_amm());
    let boost = find(&[b"boost_vault", pool.as_ref()], &pump_amm());
    Instruction {
        program_id: pump(),
        accounts: vec![
            r(global()),
            w(*withdraw_authority),
            r(*mint),
            w(wsol()),
            w(curve),
            w(ata(&curve, mint, &token_2022())),
            w(ata(&curve, &wsol(), &token())),
            ws(*user),
            r(system_program::ID),
            r(pump_amm()),
            w(pool),
            w(pool_auth),
            w(ata(&pool_auth, mint, &token_2022())),
            w(ata(&pool_auth, &wsol(), &token())),
            r(amm_global_config()),
            w(lp_mint),
            w(ata(&pool_auth, &lp_mint, &token_2022())),
            w(ata(&pool, mint, &token_2022())),
            w(ata(&pool, &wsol(), &token())),
            r(token_2022()),
            r(token()),
            r(token_2022()),
            r(ata_program()),
            r(amm_event_authority()),
            r(rent_sysvar()),
            r(pump_event_authority()),
            r(pump()),
            r(boost),
            w(ata(&boost, &wsol(), &token())),
        ],
        data: anchor_data("migrate_v2", &[]),
    }
}

// ---------- PumpSwap ----------

/// buy_v2 on the canonical pool; the user's WSOL account must exist and hold the quote.
pub fn amm_buy_v2(mint: &Pubkey, user: &Pubkey, base_out: u64, max_quote_in: u64) -> Instruction {
    let pool = canonical_pool(mint);
    Instruction {
        program_id: pump_amm(),
        accounts: vec![
            w(pool),
            ws(*user),
            r(amm_global_config()),
            r(*mint),
            r(wsol()),
            w(ata(user, mint, &token_2022())),
            w(ata(user, &wsol(), &token())),
            w(ata(&pool, mint, &token_2022())),
            w(ata(&pool, &wsol(), &token())),
            r(token_2022()),
            r(token()),
            r(system_program::ID),
            w(find(
                &[b"user_volume_accumulator", user.as_ref()],
                &pump_amm(),
            )),
            r(amm_fee_config()),
            w(ata(&buyback(), &wsol(), &token())),
            r(amm_event_authority()),
            r(pump_amm()),
        ],
        data: anchor_data(
            "buy_v2",
            &[&base_out.to_le_bytes(), &max_quote_in.to_le_bytes()],
        ),
    }
}

/// Permissionless: Pool.creator_fees -> ATA(creator_vault(pool.coin_creator), WSOL).
pub fn amm_sweep_creator_fee(payer: &Pubkey, mint: &Pubkey, coin_creator: &Pubkey) -> Instruction {
    let pool = canonical_pool(mint);
    let vault = amm_creator_vault(coin_creator);
    Instruction {
        program_id: pump_amm(),
        accounts: vec![
            ws(*payer),
            r(amm_global_config()),
            w(pool),
            r(wsol()),
            r(token()),
            w(ata(&pool, &wsol(), &token())),
            r(vault),
            w(ata(&vault, &wsol(), &token())),
            r(system_program::ID),
            r(ata_program()),
            r(amm_event_authority()),
            r(pump_amm()),
        ],
        data: anchor_data("sweep_creator_fee", &[]),
    }
}

// ---------- readers ----------

pub fn data(env: &Env, k: &Pubkey) -> Vec<u8> {
    env.svm
        .get_account(k)
        .unwrap_or_else(|| panic!("{k} missing"))
        .data
}

fn u64_at(d: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(d[at..at + 8].try_into().unwrap())
}
fn key_at(d: &[u8], at: usize) -> Pubkey {
    Pubkey::new_from_array(d[at..at + 32].try_into().unwrap())
}

/// The fields of pump's BondingCurve the tests look at.
#[derive(Debug)]
pub struct Curve {
    pub real_token_reserves: u64,
    pub real_quote_reserves: u64,
    pub complete: bool,
    pub creator: Pubkey,
    pub is_mayhem_mode: bool,
    pub quote_mint: Pubkey,
    pub is_holder_reward: bool,
    pub creator_fee: u64,
}

pub fn curve(env: &Env, mint: &Pubkey) -> Curve {
    let a = env
        .svm
        .get_account(&bonding_curve(mint))
        .expect("bonding curve");
    assert_eq!(a.owner, pump());
    let d = a.data;
    Curve {
        real_token_reserves: u64_at(&d, 24),
        real_quote_reserves: u64_at(&d, 32),
        complete: d[48] != 0,
        creator: key_at(&d, 49),
        is_mayhem_mode: d[81] != 0,
        quote_mint: key_at(&d, 83),
        is_holder_reward: d[124] != 0,
        creator_fee: u64_at(&d, 125),
    }
}

/// The fields of PumpSwap's Pool the tests look at.
#[derive(Debug)]
pub struct AmmPool {
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub coin_creator: Pubkey,
    pub creator_fees: u64,
}

pub fn amm_pool(env: &Env, mint: &Pubkey) -> AmmPool {
    let a = env
        .svm
        .get_account(&canonical_pool(mint))
        .expect("PumpSwap pool");
    assert_eq!(a.owner, pump_amm());
    let d = a.data;
    AmmPool {
        base_mint: key_at(&d, 43),
        quote_mint: key_at(&d, 75),
        coin_creator: key_at(&d, 211),
        creator_fees: u64_at(&d, 279),
    }
}

/// Global.withdraw_authority: receives the migration fee.
pub fn withdraw_authority(env: &Env) -> Pubkey {
    key_at(&data(env, &global()), 113)
}

/// Amount in an SPL Token / Token-2022 account, 0 if it doesn't exist.
pub fn token_balance(env: &Env, k: &Pubkey) -> u64 {
    env.svm
        .get_account(k)
        .filter(|a| a.data.len() >= 72)
        .map(|a| u64_at(&a.data, 64))
        .unwrap_or(0)
}

pub fn rent_min(env: &Env, len: usize) -> u64 {
    env.svm.minimum_balance_for_rent_exemption(len)
}

/// Compute units the top-level invocation of `program` used, from the logs (includes its CPIs).
pub fn units(meta: &TransactionMetadata, program: &Pubkey) -> u64 {
    let prefix = format!("Program {program} consumed ");
    meta.logs
        .iter()
        .filter_map(|l| l.strip_prefix(&prefix))
        .map(|rest| rest.split(' ').next().unwrap().parse::<u64>().unwrap())
        .max()
        .unwrap_or_else(|| {
            panic!(
                "no compute units for {program} in\n{}",
                meta.logs.join("\n")
            )
        })
}

pub fn legacy_size(env: &Env, ixs: &[Instruction], signers: &[&Keypair]) -> usize {
    let tx = Transaction::new_signed_with_payer(
        ixs,
        Some(&signers[0].pubkey()),
        signers,
        env.svm.latest_blockhash(),
    );
    1 + 64 * tx.signatures.len() + tx.message.serialize().len()
}

// ---------- type262 ----------

/// Anchor: a `seeds` constraint failed.
pub const ANCHOR_CONSTRAINT_SEEDS: u32 = 2006;

#[track_caller]
pub fn assert_code(res: TxResult, code: u32) {
    match res {
        Ok(_) => panic!("expected error {code}, but the transaction succeeded"),
        Err(f) => assert_eq!(
            f.code(),
            Some(code),
            "expected {code}, got {:?}\n{}",
            f.err,
            f.logs.join("\n")
        ),
    }
}

#[track_caller]
pub fn assert_launcher_err(res: TxResult, name: &str) {
    assert_code(res, err_code(name))
}

/// launcher::LaunchArgs.
#[derive(BorshSerialize, Debug, Clone)]
pub struct LaunchArgs {
    pub name: String,
    pub domain_hash: [u8; 32],
    pub token_name: String,
    pub token_symbol: String,
    pub token_uri: String,
}

impl LaunchArgs {
    pub fn new(name: &str) -> LaunchArgs {
        LaunchArgs {
            name: name.to_string(),
            domain_hash: domain_hash(name),
            token_name: "Example".to_string(),
            token_symbol: "EX".to_string(),
            token_uri: "https://example.com/m.json".to_string(),
        }
    }
}

/// `launch` with its named accounts and the create_v2 accounts as remaining accounts.
pub fn launch_ix(env: &Env, launcher: &Pubkey, mint: &Pubkey, args: &LaunchArgs) -> Instruction {
    let mut accounts = vec![
        ws(*launcher),
        w(env.domain_pda(&args.domain_hash)),
        w(env.creator_pda(&args.domain_hash)),
        ws(*mint),
        w(env.launch_pda(mint)),
        r(pump()),
        r(system_program::ID),
    ];
    accounts.extend(create_v2_accounts(mint, launcher));
    env.ix("launch", args, accounts)
}

/// Every account of `collect` for a domain, in the order of launcher::Collect.
pub struct CollectAccounts {
    pub payer: Pubkey,
    pub domain: Pubkey,
    pub creator: Pubkey,
    pub creator_wsol: Pubkey,
    pub pool: Pubkey,
    pub creator_vault: Pubkey,
    pub creator_vault_wsol: Pubkey,
    pub pump_event_authority: Pubkey,
    pub pump_program: Pubkey,
    pub amm_vault_authority: Pubkey,
    pub amm_vault_wsol: Pubkey,
    pub amm_event_authority: Pubkey,
    pub amm_program: Pubkey,
    pub wsol_mint: Pubkey,
    pub token_program: Pubkey,
    pub associated_token_program: Pubkey,
    pub system_program: Pubkey,
}

impl CollectAccounts {
    pub fn new(env: &Env, payer: &Pubkey, hash: &[u8; 32]) -> CollectAccounts {
        let creator = env.creator_pda(hash);
        let vault = creator_vault(&creator);
        let amm_vault = amm_creator_vault(&creator);
        CollectAccounts {
            payer: *payer,
            domain: env.domain_pda(hash),
            creator,
            creator_wsol: ata(&creator, &wsol(), &token()),
            pool: env.pool_pda(hash, &SOL_MINT),
            creator_vault: vault,
            creator_vault_wsol: ata(&vault, &wsol(), &token()),
            pump_event_authority: pump_event_authority(),
            pump_program: pump(),
            amm_vault_authority: amm_vault,
            amm_vault_wsol: ata(&amm_vault, &wsol(), &token()),
            amm_event_authority: amm_event_authority(),
            amm_program: pump_amm(),
            wsol_mint: wsol(),
            token_program: token(),
            associated_token_program: ata_program(),
            system_program: system_program::ID,
        }
    }

    pub fn ix(&self, env: &Env, hash: &[u8; 32]) -> Instruction {
        env.ix(
            "collect",
            hash,
            vec![
                ws(self.payer),
                r(self.domain),
                w(self.creator),
                w(self.creator_wsol),
                w(self.pool),
                w(self.creator_vault),
                w(self.creator_vault_wsol),
                r(self.pump_event_authority),
                r(self.pump_program),
                r(self.amm_vault_authority),
                w(self.amm_vault_wsol),
                r(self.amm_event_authority),
                r(self.amm_program),
                r(self.wsol_mint),
                r(self.token_program),
                r(self.associated_token_program),
                r(self.system_program),
            ],
        )
    }
}

pub fn collect_ix(env: &Env, payer: &Pubkey, hash: &[u8; 32]) -> Instruction {
    CollectAccounts::new(env, payer, hash).ix(env, hash)
}

/// Launches a coin for `name` through type262, with the launcher's opening buy in the same
/// transaction, as the app does. Returns the mint.
pub fn launch_with_buy(env: &mut Env, launcher: &Keypair, name: &str, buy: u64) -> Pubkey {
    let mint = Keypair::new();
    let args = LaunchArgs::new(name);
    let mut ixs = vec![
        set_compute_limit(600_000),
        launch_ix(env, &launcher.pubkey(), &mint.pubkey(), &args),
    ];
    if buy > 0 {
        ixs.push(create_ata_idempotent(
            &launcher.pubkey(),
            &launcher.pubkey(),
            &mint.pubkey(),
            &token_2022(),
        ));
        ixs.push(buy_v3(&mint.pubkey(), &launcher.pubkey(), buy, 10 * SOL));
    }
    env.send(&ixs, &[launcher, &mint]).expect("launch");
    mint.pubkey()
}

/// A trader buys `amount` tokens on the curve (creating their token account first).
pub fn buy(env: &mut Env, trader: &Keypair, mint: &Pubkey, amount: u64, max_sol: u64) -> TxResult {
    let ixs = [
        create_ata_idempotent(&trader.pubkey(), &trader.pubkey(), mint, &token_2022()),
        buy_v3(mint, &trader.pubkey(), amount, max_sol),
    ];
    env.send(&ixs, &[trader])
}

// ---------- v0 transactions with a lookup table ----------

/// Writes an active address lookup table holding `addresses` (extended in an earlier slot, so every
/// entry is usable now) and returns it for v0 compilation.
pub fn lookup_table(env: &mut Env, addresses: Vec<Pubkey>) -> AddressLookupTableAccount {
    let key = Pubkey::new_unique();
    // LookupTableMeta, bincode: u32 state tag (1 = LookupTable), deactivation_slot (u64::MAX: active),
    // last_extended_slot, last_extended_slot_start_index, authority (Option<Pubkey>), padding; the
    // addresses start at byte 56.
    let mut data = vec![0u8; 56];
    data[..4].copy_from_slice(&1u32.to_le_bytes());
    data[4..12].copy_from_slice(&u64::MAX.to_le_bytes());
    for a in &addresses {
        data.extend_from_slice(a.as_ref());
    }
    let lamports = rent_min(env, data.len());
    env.svm
        .set_account(
            key,
            Account {
                lamports,
                data,
                owner: lookup_table_program(),
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    AddressLookupTableAccount { key, addresses }
}

/// Compiles, signs and sends a v0 transaction; returns its result and its size on the wire.
pub fn send_v0(
    env: &mut Env,
    ixs: &[Instruction],
    signers: &[&Keypair],
    tables: &[AddressLookupTableAccount],
) -> (TxResult, usize) {
    let message = v0::Message::try_compile(
        &signers[0].pubkey(),
        ixs,
        tables,
        env.svm.latest_blockhash(),
    )
    .unwrap();
    let message = VersionedMessage::V0(message);
    let size = message.serialize().len();
    let tx = VersionedTransaction::try_new(message, signers).unwrap();
    let size = size + 1 + 64 * tx.signatures.len();
    let res = env.svm.send_transaction(tx);
    env.svm.expire_blockhash();
    (
        res.map_err(|e| Failure {
            err: e.err,
            logs: e.meta.logs,
        }),
        size,
    )
}
