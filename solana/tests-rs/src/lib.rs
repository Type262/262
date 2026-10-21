//! Test harness for the type262 program.
//!
//! Runs the compiled program (`../target/deploy/type262.so`) inside LiteSVM and talks to it the
//! way a client would: Anchor discriminators, borsh-encoded args, PDAs derived from the same seeds
//! the program uses. Nothing here links against the program crate, so a test can't pass through a
//! bug shared with it; when the program's accounts or arguments change, change the mirrors here.
//!
//! `Env::new()` runs `cargo build-sbf` first (once per test binary), so `cargo test` always tests
//! the current source. Set TYPE262_SKIP_BUILD=1 to test the .so as it is.

use borsh::{BorshDeserialize, BorshSerialize};
use litesvm::types::TransactionMetadata;
use litesvm::LiteSVM;
use sha2::{Digest, Sha256};
use solana_clock::Clock;
use solana_instruction::{AccountMeta, Instruction};
use solana_instruction_error::InstructionError;
use solana_keypair::Keypair;
use solana_sdk_ids::{bpf_loader_upgradeable, system_program};
use solana_signer::Signer;
use solana_transaction::Transaction;
use solana_transaction_error::TransactionError;
use std::path::PathBuf;
use std::process::Command;
use std::str::FromStr;
use std::sync::OnceLock;

// LiteSVM 0.16 is built on the granular SDK crates, where Pubkey became Address. The harness
// keeps the on-chain name so it reads like the program.
pub use solana_address::Address as Pubkey;

pub const SOL: u64 = 1_000_000_000;

// ---------- the same numbers as programs/type262/src/constants.rs ----------

pub const FEE_BPS: u16 = 50;
pub const MAX_FEE_BPS: u16 = 100;
pub const REFUND_DELAY: i64 = 180 * 24 * 60 * 60;
pub const SOL_MINT: Pubkey = Pubkey::new_from_array([0; 32]);
pub const TYPE_TXT: u16 = 16;
pub const TYPE_DNSKEY: u16 = 48;
pub const TYPE_WALLET: u16 = 262;

pub mod seeds {
    pub const CONFIG: &[u8] = b"config";
    pub const DOMAIN: &[u8] = b"domain";
    pub const POOL: &[u8] = b"pool";
    pub const DEPOSIT: &[u8] = b"deposit";
    pub const FEES: &[u8] = b"fees";
    pub const BUFFER: &[u8] = b"buffer";
    pub const RRSET: &[u8] = b"rrset";
    pub const CREATOR: &[u8] = b"creator";
    pub const LAUNCH: &[u8] = b"launch";
}

/// Type262Error from errors.rs: (name, code).
pub const ERRORS: &[(&str, u32)] = &[
    ("BadDomain", 6000),
    ("DomainHashMismatch", 6001),
    ("NotAdmin", 6002),
    ("NotPendingAdmin", 6003),
    ("BadConfig", 6004),
    ("NotUpgradeAuthority", 6005),
    ("ZeroAmount", 6006),
    ("MathOverflow", 6007),
    ("NotImplemented", 6008),
    ("BadBufferSize", 6100),
    ("BadBuffer", 6101),
    ("BadSignedData", 6102),
    ("BadName", 6103),
    ("NameNotLowercase", 6104),
    ("EmptyRRset", 6105),
    ("InvalidClass", 6106),
    ("InvalidRRSet", 6107),
    ("SignatureTypeMismatch", 6108),
    ("InvalidLabelCount", 6109),
    ("SignatureExpired", 6110),
    ("SignatureNotValidYet", 6111),
    ("InvalidSignerName", 6112),
    ("WrongParent", 6113),
    ("ParentExpired", 6114),
    ("UnsupportedAlgorithm", 6115),
    ("WrongInstructionForAlgorithm", 6116),
    ("NoKeyVerified", 6117),
    ("NoMatchingDs", 6118),
    ("WrongRRsetAccount", 6119),
    ("RRsetNotExpired", 6120),
    ("WrongPayer", 6121),
    ("NotAWalletRecord", 6122),
    ("WalletRecordExpired", 6123),
    ("WalletNotPublished", 6124),
    ("Paused", 6200),
    ("StaleProof", 6201),
    ("NothingToRefund", 6202),
    ("RefundLocked", 6203),
    ("WrongMint", 6204),
    ("UnsupportedMint", 6205),
    ("WrongTokenAccount", 6206),
    ("BadRecipient", 6207),
    ("PoolUnderfunded", 6208),
    ("PoolNotOpen", 6209),
    ("TiedProof", 6210),
    ("WrongPumpProgram", 6300),
    ("MissingPumpAccounts", 6301),
    ("WrongCoinMint", 6302),
    ("WrongCoinLauncher", 6303),
    ("WrongBondingCurve", 6304),
    ("BadLaunchedCurve", 6305),
    ("WrongPumpAccount", 6306),
    ("WrongCreatorVault", 6307),
    ("WrongCreatorTokenAccount", 6308),
    ("NothingToCollect", 6309),
];

pub fn err_code(name: &str) -> u32 {
    ERRORS
        .iter()
        .find(|(n, _)| *n == name)
        .unwrap_or_else(|| panic!("unknown error {name}"))
        .1
}

/// Anchor's own: an account failed a `constraint` / `has_one` without a custom error.
pub const ANCHOR_CONSTRAINT_HAS_ONE: u32 = 2001;
pub const ANCHOR_CONSTRAINT_RAW: u32 = 2003;

// ---------- account mirrors (borsh layout = field order in state.rs) ----------

/// An account type the program owns, with the name its Anchor discriminator is derived from.
pub trait ProgramAccount: BorshDeserialize {
    const NAME: &'static str;
}

macro_rules! program_account {
    ($t:ident) => {
        impl ProgramAccount for $t {
            const NAME: &'static str = stringify!($t);
        }
    };
}

#[derive(BorshDeserialize, Debug, Clone, PartialEq)]
pub struct Config {
    pub admin: Pubkey,
    pub pending_admin: Pubkey,
    pub fee_recipient: Pubkey,
    pub fee_bps: u16,
    pub refund_delay: i64,
    pub deposits_paused: bool,
    pub bump: u8,
}
program_account!(Config);

/// A buffer has no fields: [u32 length, signed, u32 length, sig] follow the discriminator.
#[derive(BorshDeserialize, Debug, Clone, PartialEq)]
pub struct Buffer {}
program_account!(Buffer);
pub const BUFFER_DATA_OFFSET: usize = 8;

#[derive(BorshDeserialize, Debug, Clone, PartialEq)]
pub struct RrSet {
    pub bump: u8,
    pub rrtype: u16,
    pub algorithm: u8,
    pub key_tag: u16,
    pub signed_at: i64,
    pub expires_at: i64,
    pub payer: Pubkey,
    pub owner: Vec<u8>,
    /// Each record as [u16 LE length, RDATA].
    pub rdata: Vec<u8>,
}
program_account!(RrSet);

impl RrSet {
    /// The records' RDATA, in order.
    pub fn records(&self) -> Vec<Vec<u8>> {
        let mut out = Vec::new();
        let mut d = &self.rdata[..];
        while !d.is_empty() {
            let len = u16::from_le_bytes([d[0], d[1]]) as usize;
            out.push(d[2..2 + len].to_vec());
            d = &d[2 + len..];
        }
        out
    }
}

#[derive(BorshDeserialize, Debug, Clone, PartialEq)]
pub struct Domain {
    pub domain_hash: [u8; 32],
    pub last_proof: i64,
    pub wallet: Pubkey,
    pub launches: u32,
    pub bump: u8,
    pub name: String,
}
program_account!(Domain);

#[derive(BorshDeserialize, Debug, Clone, PartialEq)]
pub struct Pool {
    pub domain_hash: [u8; 32],
    pub mint: Pubkey,
    pub balance: u64,
    pub epoch: u64,
    pub bump: u8,
}
program_account!(Pool);

#[derive(BorshDeserialize, Debug, Clone, PartialEq)]
pub struct Deposit {
    pub pool: Pubkey,
    pub depositor: Pubkey,
    pub amount: u64,
    pub epoch: u64,
    pub last_at: i64,
    pub bump: u8,
}
program_account!(Deposit);

#[derive(BorshDeserialize, Debug, Clone, PartialEq)]
pub struct FeeVault {
    pub mint: Pubkey,
    pub owed: u64,
    pub bump: u8,
}
program_account!(FeeVault);

#[derive(BorshDeserialize, Debug, Clone, PartialEq)]
pub struct LaunchRecord {
    pub domain_hash: [u8; 32],
    pub mint: Pubkey,
    pub launcher: Pubkey,
    pub launched_at: i64,
    pub bump: u8,
}
program_account!(LaunchRecord);

// ---------- encoding ----------

fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

/// Anchor discriminator: the first 8 bytes of sha256("<namespace>:<name>").
pub fn discriminator(namespace: &str, name: &str) -> [u8; 8] {
    let h = sha256(&[format!("{namespace}:{name}").as_bytes()]);
    h[..8].try_into().unwrap()
}

/// Instruction data: discriminator of `global:<name>`, then the borsh-encoded args struct.
pub fn ix_data<T: BorshSerialize>(name: &str, args: &T) -> Vec<u8> {
    let mut v = discriminator("global", name).to_vec();
    v.extend(borsh::to_vec(args).unwrap());
    v
}

/// Account metas: writable / read-only, signer or not.
pub fn w(k: Pubkey) -> AccountMeta {
    AccountMeta::new(k, false)
}
pub fn r(k: Pubkey) -> AccountMeta {
    AccountMeta::new_readonly(k, false)
}
pub fn ws(k: Pubkey) -> AccountMeta {
    AccountMeta::new(k, true)
}
pub fn rs(k: Pubkey) -> AccountMeta {
    AccountMeta::new_readonly(k, true)
}

/// sha256 of a canonical name: the domain_hash the escrow keys pools by.
pub fn domain_hash(name: &str) -> [u8; 32] {
    sha256(&[name.as_bytes()])
}

/// "example.com" (+ an optional first label such as "_wallet") in DNS wire form: 7example3com0.
pub fn wire_name(dotted: &str, first_label: Option<&str>) -> Vec<u8> {
    let mut out = Vec::new();
    for label in first_label
        .into_iter()
        .chain(dotted.split('.').filter(|l| !l.is_empty()))
    {
        out.push(label.len() as u8);
        out.extend_from_slice(label.as_bytes());
    }
    out.push(0);
    out
}

/// sha256 of a wire-form owner name: the name_hash RRset PDAs are keyed by.
pub fn name_hash(wire: &[u8]) -> [u8; 32] {
    sha256(&[wire])
}

// ---------- the program ----------

/// The solana/ workspace root.
pub fn workspace() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

/// The id in `declare_id!` in programs/type262/src/lib.rs. The program refuses to run under any
/// other address, and reading it from the source means there is one place to change it.
pub fn program_id() -> Pubkey {
    static ID: OnceLock<Pubkey> = OnceLock::new();
    *ID.get_or_init(|| {
        let src = std::fs::read_to_string(workspace().join("programs/type262/src/lib.rs")).unwrap();
        let start =
            src.find("declare_id!(\"").expect("declare_id! in lib.rs") + "declare_id!(\"".len();
        let end = start + src[start..].find('"').unwrap();
        Pubkey::from_str(&src[start..end]).expect("declare_id! holds a base58 address")
    })
}

/// Runs `cargo build-sbf` once per test binary, unless TYPE262_SKIP_BUILD is set.
pub fn build_program() {
    static BUILT: OnceLock<()> = OnceLock::new();
    BUILT.get_or_init(|| {
        if std::env::var_os("TYPE262_SKIP_BUILD").is_some() {
            return;
        }
        let mut cmd = Command::new("cargo");
        cmd.arg("build-sbf")
            .arg("--manifest-path")
            .arg(workspace().join("programs/type262/Cargo.toml"));
        // `cargo test` hands this process the variables of the crate under test, including the
        // newer Rust pinned in rust-toolchain.toml; the SBF build must not inherit them.
        for (key, _) in std::env::vars_os() {
            let key = key.to_string_lossy().into_owned();
            let leak = key == "CARGO"
                || key.starts_with("CARGO_PKG_")
                || key.starts_with("CARGO_MANIFEST_")
                || key.starts_with("CARGO_TARGET_")
                || key.starts_with("CARGO_BUILD_")
                || key.starts_with("CARGO_ENCODED_")
                || key.starts_with("RUSTC")
                || key.starts_with("RUSTFLAGS")
                || matches!(
                    key.as_str(),
                    "CARGO_CRATE_NAME"
                        | "CARGO_PRIMARY_PACKAGE"
                        | "CARGO_MAKEFLAGS"
                        | "RUSTUP_TOOLCHAIN"
                );
            if leak {
                cmd.env_remove(&key);
            }
        }
        let out = cmd
            .output()
            .expect("could not run `cargo build-sbf`: install the Solana CLI (see README.md)");
        if !out.status.success() {
            panic!(
                "cargo build-sbf failed:\n{}{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            );
        }
    });
}

pub fn program_so() -> PathBuf {
    workspace().join("target/deploy/type262.so")
}

/// A transaction that failed: the error, its custom code if it has one, and the logs.
#[derive(Debug)]
pub struct Failure {
    pub err: TransactionError,
    pub logs: Vec<String>,
}

impl Failure {
    pub fn code(&self) -> Option<u32> {
        match self.err {
            TransactionError::InstructionError(_, InstructionError::Custom(c)) => Some(c),
            _ => None,
        }
    }
}

pub type TxResult = Result<TransactionMetadata, Failure>;

/// Asserts that `res` failed with the named Type262Error.
#[track_caller]
pub fn assert_err(res: TxResult, name: &str) {
    match res {
        Ok(_) => panic!("expected {name}, but the transaction succeeded"),
        Err(f) => assert_eq!(
            f.code(),
            Some(err_code(name)),
            "expected {name}, got {:?}\n{}",
            f.err,
            f.logs.join("\n")
        ),
    }
}

/// A fresh chain with the program loaded as an upgradeable program whose upgrade authority is
/// `authority` (as after `solana program deploy`), and the clock at a round number.
pub struct Env {
    pub svm: LiteSVM,
    pub program: Pubkey,
    pub authority: Keypair,
}

impl Env {
    pub fn new() -> Env {
        build_program();
        let so = std::fs::read(program_so())
            .expect("target/deploy/type262.so missing: run cargo build-sbf");
        let program = program_id();
        let svm = LiteSVM::new();
        #[cfg(feature = "precompiles")]
        let svm = svm.with_precompiles();
        let mut env = Env {
            svm,
            program,
            authority: Keypair::new(),
        };
        env.svm.add_program(program, &so).expect("load type262.so");
        env.set_upgrade_authority(Some(env.authority.pubkey()));

        let mut clock = env.svm.get_sysvar::<Clock>();
        clock.unix_timestamp = 1_800_000_000;
        clock.slot = 1_000;
        env.svm.set_sysvar::<Clock>(&clock);

        env.svm
            .airdrop(&env.authority.pubkey(), 1_000 * SOL)
            .unwrap();
        env
    }

    /// A new keypair holding `sol` SOL.
    pub fn funded(&mut self, sol: u64) -> Keypair {
        let k = Keypair::new();
        self.svm.airdrop(&k.pubkey(), sol * SOL).unwrap();
        k
    }

    // ---------- program data ----------

    pub fn program_data(&self) -> Pubkey {
        Pubkey::find_program_address(&[self.program.as_ref()], &bpf_loader_upgradeable::ID).0
    }

    /// LiteSVM loads programs with no upgrade authority; rewrite the ProgramData header
    /// (u32 tag 3, u64 slot, Option<Pubkey>) to set one.
    pub fn set_upgrade_authority(&mut self, authority: Option<Pubkey>) {
        let address = self.program_data();
        let mut account = self
            .svm
            .get_account(&address)
            .expect("program data account");
        assert_eq!(
            &account.data[..4],
            &3u32.to_le_bytes(),
            "not a ProgramData account"
        );
        match authority {
            Some(a) => {
                account.data[12] = 1;
                account.data[13..45].copy_from_slice(a.as_ref());
            }
            None => {
                account.data[12] = 0;
                account.data[13..45].fill(0);
            }
        }
        self.svm.set_account(address, account).unwrap();
    }

    // ---------- PDAs ----------

    pub fn pda(&self, seeds: &[&[u8]]) -> Pubkey {
        Pubkey::find_program_address(seeds, &self.program).0
    }
    pub fn config_pda(&self) -> Pubkey {
        self.pda(&[seeds::CONFIG])
    }
    pub fn domain_pda(&self, domain_hash: &[u8; 32]) -> Pubkey {
        self.pda(&[seeds::DOMAIN, domain_hash])
    }
    pub fn pool_pda(&self, domain_hash: &[u8; 32], mint: &Pubkey) -> Pubkey {
        self.pda(&[seeds::POOL, domain_hash, mint.as_ref()])
    }
    pub fn deposit_pda(&self, pool: &Pubkey, depositor: &Pubkey) -> Pubkey {
        self.pda(&[seeds::DEPOSIT, pool.as_ref(), depositor.as_ref()])
    }
    pub fn fees_pda(&self, mint: &Pubkey) -> Pubkey {
        self.pda(&[seeds::FEES, mint.as_ref()])
    }
    pub fn buffer_pda(&self, payer: &Pubkey) -> Pubkey {
        self.pda(&[seeds::BUFFER, payer.as_ref()])
    }
    pub fn rrset_pda(&self, name_hash: &[u8; 32], rrtype: u16) -> Pubkey {
        self.pda(&[seeds::RRSET, name_hash, &rrtype.to_be_bytes()])
    }
    pub fn creator_pda(&self, domain_hash: &[u8; 32]) -> Pubkey {
        self.pda(&[seeds::CREATOR, domain_hash])
    }
    pub fn launch_pda(&self, mint: &Pubkey) -> Pubkey {
        self.pda(&[seeds::LAUNCH, mint.as_ref()])
    }

    // ---------- clock ----------

    pub fn now(&self) -> i64 {
        self.svm.get_sysvar::<Clock>().unix_timestamp
    }

    /// Moves the clock forward (the EVM suite's vm.warp).
    pub fn warp(&mut self, secs: i64) {
        let mut clock = self.svm.get_sysvar::<Clock>();
        clock.unix_timestamp += secs;
        clock.slot += 1;
        self.svm.set_sysvar::<Clock>(&clock);
        self.svm.expire_blockhash();
    }

    // ---------- accounts ----------

    pub fn lamports(&self, k: &Pubkey) -> u64 {
        self.svm.get_account(k).map(|a| a.lamports).unwrap_or(0)
    }

    /// Reads a program account, checking its owner and discriminator; None if it doesn't exist.
    pub fn account<T: ProgramAccount>(&self, k: &Pubkey) -> Option<T> {
        let a = self.svm.get_account(k)?;
        assert_eq!(
            a.owner,
            self.program,
            "{} {k} is not owned by the program",
            T::NAME
        );
        assert_eq!(
            &a.data[..8],
            &discriminator("account", T::NAME),
            "{k} is not a {}",
            T::NAME
        );
        Some(
            T::deserialize(&mut &a.data[8..]).unwrap_or_else(|e| panic!("decode {}: {e}", T::NAME)),
        )
    }

    pub fn config(&self) -> Config {
        self.account(&self.config_pda())
            .expect("config not initialized")
    }

    // ---------- sending ----------

    /// Signs with `signers` (the first pays) and sends. Expires the blockhash afterwards so an
    /// identical transaction can be sent again.
    pub fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> TxResult {
        let payer = signers[0].pubkey();
        let tx = Transaction::new_signed_with_payer(
            ixs,
            Some(&payer),
            signers,
            self.svm.latest_blockhash(),
        );
        let res = self.svm.send_transaction(tx);
        self.svm.expire_blockhash();
        res.map_err(|e| Failure {
            err: e.err,
            logs: e.meta.logs,
        })
    }

    pub fn ix<T: BorshSerialize>(
        &self,
        name: &str,
        args: &T,
        accounts: Vec<AccountMeta>,
    ) -> Instruction {
        Instruction {
            program_id: self.program,
            accounts,
            data: ix_data(name, args),
        }
    }

    // ---------- admin ----------

    pub fn initialize_ix(&self, authority: &Pubkey, args: &InitializeArgs) -> Instruction {
        self.ix(
            "initialize",
            args,
            vec![
                ws(*authority),
                w(self.config_pda()),
                r(self.program),
                r(self.program_data()),
                r(system_program::ID),
            ],
        )
    }

    /// Initializes with the mainnet numbers, the upgrade authority as admin and a fresh fee recipient.
    pub fn initialize(&mut self) -> InitializeArgs {
        let args = InitializeArgs {
            admin: self.authority.pubkey(),
            fee_recipient: Pubkey::new_unique(),
            fee_bps: FEE_BPS,
            refund_delay: REFUND_DELAY,
        };
        let ix = self.initialize_ix(&self.authority.pubkey(), &args);
        let authority = self.authority.insecure_clone();
        self.send(&[ix], &[&authority]).expect("initialize");
        args
    }

    pub fn set_deposits_paused(&mut self, admin: &Keypair, paused: bool) -> TxResult {
        let ix = self.ix(
            "set_deposits_paused",
            &paused,
            vec![rs(admin.pubkey()), w(self.config_pda())],
        );
        self.send(&[ix], &[admin])
    }

    pub fn transfer_admin(&mut self, admin: &Keypair, new_admin: Pubkey) -> TxResult {
        let ix = self.ix(
            "transfer_admin",
            &new_admin,
            vec![rs(admin.pubkey()), w(self.config_pda())],
        );
        self.send(&[ix], &[admin])
    }

    pub fn accept_admin(&mut self, new_admin: &Keypair) -> TxResult {
        let ix = self.ix(
            "accept_admin",
            &(),
            vec![rs(new_admin.pubkey()), w(self.config_pda())],
        );
        self.send(&[ix], &[new_admin])
    }

    // ---------- buffers ----------

    /// dnssec::write_buffer: one chunk into the payer's buffer, created or grown as needed.
    pub fn write_buffer_ix(&self, payer: &Pubkey, offset: u32, bytes: &[u8]) -> Instruction {
        self.ix(
            "write_buffer",
            &(offset, bytes.to_vec()),
            vec![ws(*payer), w(self.buffer_pda(payer)), r(system_program::ID)],
        )
    }

    pub fn write_buffer(&mut self, payer: &Keypair, offset: u32, bytes: &[u8]) -> TxResult {
        let ix = self.write_buffer_ix(&payer.pubkey(), offset, bytes);
        self.send(&[ix], &[payer])
    }

    /// Uploads `bytes` into the payer's buffer in chunks small enough for one transaction each.
    pub fn upload(&mut self, payer: &Keypair, bytes: &[u8]) -> Pubkey {
        for (i, chunk) in bytes.chunks(900).enumerate() {
            self.write_buffer(payer, (i * 900) as u32, chunk)
                .expect("write_buffer");
        }
        self.buffer_pda(&payer.pubkey())
    }

    pub fn close_buffer(&mut self, payer: &Keypair) -> TxResult {
        let buffer = self.buffer_pda(&payer.pubkey());
        let ix = self.ix("close_buffer", &(), vec![ws(payer.pubkey()), w(buffer)]);
        self.send(&[ix], &[payer])
    }

    /// The bytes after a buffer's discriminator.
    pub fn buffer_bytes(&self, buffer: &Pubkey) -> Vec<u8> {
        let _: Buffer = self.account(buffer).expect("buffer");
        self.svm.get_account(buffer).unwrap().data[BUFFER_DATA_OFFSET..].to_vec()
    }
}

impl Default for Env {
    fn default() -> Self {
        Env::new()
    }
}

/// admin::InitializeArgs.
#[derive(BorshSerialize, Debug, Clone)]
pub struct InitializeArgs {
    pub admin: Pubkey,
    pub fee_recipient: Pubkey,
    pub fee_bps: u16,
    pub refund_delay: i64,
}
