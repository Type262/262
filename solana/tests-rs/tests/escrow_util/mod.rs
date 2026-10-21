//! Shared by the escrow suites: instruction builders for the escrow, SPL Token / Token-2022 mints and
//! accounts made directly in LiteSVM, and cached wallet records written straight into their PDAs
//! (the escrow only reads them; the dnssec suites prove real ones).

#![allow(dead_code)]

use borsh::BorshSerialize;
use solana_account::Account;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_sdk_ids::system_program;
use solana_signer::Signer;
use type262_tests::*;

pub const TOKEN: Pubkey = Pubkey::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const TOKEN_2022: Pubkey =
    Pubkey::from_str_const("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
pub const ATA_PROGRAM: Pubkey =
    Pubkey::from_str_const("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/// Anchor's own error codes the suites check.
pub const ANCHOR_CONSTRAINT_SEEDS: u32 = 2006;
pub const ANCHOR_ACCOUNT_NOT_INITIALIZED: u32 = 3012;

pub const TX_FEE: u64 = 5000;

// ---------- args, as borsh mirrors of escrow.rs ----------

#[derive(BorshSerialize)]
pub struct DepositArgs {
    pub name: String,
    pub domain_hash: [u8; 32],
    pub amount: u64,
}

#[derive(BorshSerialize)]
pub struct ClaimArgs {
    pub domain_hash: [u8; 32],
    pub wallet: Pubkey,
}

#[derive(BorshSerialize)]
pub struct RegisterArgs {
    pub name: String,
    pub domain_hash: [u8; 32],
    pub wallet: Pubkey,
}

#[derive(BorshSerialize)]
pub struct RefundArgs {
    pub domain_hash: [u8; 32],
    pub mint: Pubkey,
}

#[derive(BorshSerialize)]
pub struct WithdrawFeesArgs {
    pub mint: Pubkey,
}

// ---------- results ----------

/// Asserts a failure with this exact custom code (Anchor's own or ours).
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

/// Asserts the transaction failed, whatever the reason.
#[track_caller]
pub fn assert_fails(res: TxResult) -> Failure {
    match res {
        Ok(_) => panic!("expected a failure, but the transaction succeeded"),
        Err(f) => f,
    }
}

/// A token pool: its mint and the token program that owns it.
#[derive(Clone, Copy, Debug)]
pub struct Tok {
    pub mint: Pubkey,
    pub program: Pubkey,
}

pub fn ata(owner: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[owner.as_ref(), token_program.as_ref(), mint.as_ref()],
        &ATA_PROGRAM,
    )
    .0
}

// ---------- the escrow ----------

pub trait Escrow {
    fn deposit_sol_ix(&self, depositor: &Pubkey, name: &str, amount: u64) -> Instruction;
    fn deposit_sol(&mut self, depositor: &Keypair, name: &str, amount: u64) -> TxResult;
    fn deposit_token_ix(&self, depositor: &Pubkey, name: &str, t: Tok, amount: u64) -> Instruction;
    fn deposit_token(&mut self, depositor: &Keypair, name: &str, t: Tok, amount: u64) -> TxResult;
    fn claim_ix(
        &self,
        payer: &Pubkey,
        name: &str,
        wallet: &Pubkey,
        record: &Pubkey,
        mint: &Pubkey,
        t: Option<Tok>,
    ) -> Instruction;
    fn claim(
        &mut self,
        payer: &Keypair,
        name: &str,
        wallet: &Pubkey,
        record: &Pubkey,
        t: Option<Tok>,
    ) -> TxResult;
    fn register_ix(
        &self,
        payer: &Pubkey,
        name: &str,
        wallet: &Pubkey,
        record: &Pubkey,
    ) -> Instruction;
    fn register(
        &mut self,
        payer: &Keypair,
        name: &str,
        wallet: &Pubkey,
        record: &Pubkey,
    ) -> TxResult;
    fn refund_ix(&self, depositor: &Pubkey, name: &str, t: Option<Tok>) -> Instruction;
    fn refund(&mut self, depositor: &Keypair, name: &str, t: Option<Tok>) -> TxResult;
    fn withdraw_fees_ix(&self, payer: &Pubkey, t: Option<Tok>) -> Instruction;
    fn withdraw_fees(&mut self, payer: &Keypair, t: Option<Tok>) -> TxResult;

    fn pool(&self, name: &str, mint: &Pubkey) -> Option<Pool>;
    fn domain(&self, name: &str) -> Option<Domain>;
    fn deposit_of(&self, name: &str, mint: &Pubkey, depositor: &Pubkey) -> Option<Deposit>;
    fn fee_vault(&self, mint: &Pubkey) -> Option<FeeVault>;
    fn rent(&self, account: &Pubkey) -> u64;
}

impl Escrow for Env {
    fn deposit_sol_ix(&self, depositor: &Pubkey, name: &str, amount: u64) -> Instruction {
        let h = domain_hash(name);
        let pool = self.pool_pda(&h, &SOL_MINT);
        self.ix(
            "deposit_sol",
            &DepositArgs {
                name: name.into(),
                domain_hash: h,
                amount,
            },
            vec![
                ws(*depositor),
                r(self.config_pda()),
                w(self.domain_pda(&h)),
                w(pool),
                w(self.deposit_pda(&pool, depositor)),
                r(system_program::ID),
            ],
        )
    }

    fn deposit_sol(&mut self, depositor: &Keypair, name: &str, amount: u64) -> TxResult {
        let ix = self.deposit_sol_ix(&depositor.pubkey(), name, amount);
        self.send(&[ix], &[depositor])
    }

    fn deposit_token_ix(&self, depositor: &Pubkey, name: &str, t: Tok, amount: u64) -> Instruction {
        let h = domain_hash(name);
        let pool = self.pool_pda(&h, &t.mint);
        self.ix(
            "deposit_token",
            &DepositArgs {
                name: name.into(),
                domain_hash: h,
                amount,
            },
            vec![
                ws(*depositor),
                r(self.config_pda()),
                r(t.mint),
                w(self.domain_pda(&h)),
                w(pool),
                w(self.deposit_pda(&pool, depositor)),
                w(ata(depositor, &t.mint, &t.program)),
                w(ata(&pool, &t.mint, &t.program)),
                r(t.program),
                r(ATA_PROGRAM),
                r(system_program::ID),
            ],
        )
    }

    fn deposit_token(&mut self, depositor: &Keypair, name: &str, t: Tok, amount: u64) -> TxResult {
        let ix = self.deposit_token_ix(&depositor.pubkey(), name, t, amount);
        self.send(&[ix], &[depositor])
    }

    /// `mint` picks the pool; `t` the token accounts (None: the program id in their place).
    fn claim_ix(
        &self,
        payer: &Pubkey,
        name: &str,
        wallet: &Pubkey,
        record: &Pubkey,
        mint: &Pubkey,
        t: Option<Tok>,
    ) -> Instruction {
        let h = domain_hash(name);
        let pool = self.pool_pda(&h, mint);
        let fee_vault = self.fees_pda(mint);
        let mut accounts = vec![
            ws(*payer),
            r(self.config_pda()),
            w(self.domain_pda(&h)),
            r(*record),
            w(*wallet),
            w(pool),
            w(fee_vault),
            r(system_program::ID),
        ];
        match t {
            Some(t) => accounts.extend([
                r(t.mint),
                w(ata(&pool, &t.mint, &t.program)),
                w(ata(wallet, &t.mint, &t.program)),
                w(ata(&fee_vault, &t.mint, &t.program)),
                r(t.program),
                r(ATA_PROGRAM),
            ]),
            None => accounts.extend((0..6).map(|_| r(self.program))),
        }
        self.ix(
            "claim",
            &ClaimArgs {
                domain_hash: h,
                wallet: *wallet,
            },
            accounts,
        )
    }

    fn claim(
        &mut self,
        payer: &Keypair,
        name: &str,
        wallet: &Pubkey,
        record: &Pubkey,
        t: Option<Tok>,
    ) -> TxResult {
        let mint = t.map(|t| t.mint).unwrap_or(SOL_MINT);
        let ix = self.claim_ix(&payer.pubkey(), name, wallet, record, &mint, t);
        self.send(&[ix], &[payer])
    }

    fn register_ix(
        &self,
        payer: &Pubkey,
        name: &str,
        wallet: &Pubkey,
        record: &Pubkey,
    ) -> Instruction {
        let h = domain_hash(name);
        self.ix(
            "register",
            &RegisterArgs {
                name: name.into(),
                domain_hash: h,
                wallet: *wallet,
            },
            vec![
                ws(*payer),
                w(self.domain_pda(&h)),
                r(*record),
                r(*wallet),
                r(system_program::ID),
            ],
        )
    }

    fn register(
        &mut self,
        payer: &Keypair,
        name: &str,
        wallet: &Pubkey,
        record: &Pubkey,
    ) -> TxResult {
        let ix = self.register_ix(&payer.pubkey(), name, wallet, record);
        self.send(&[ix], &[payer])
    }

    fn refund_ix(&self, depositor: &Pubkey, name: &str, t: Option<Tok>) -> Instruction {
        let h = domain_hash(name);
        let mint = t.map(|t| t.mint).unwrap_or(SOL_MINT);
        let pool = self.pool_pda(&h, &mint);
        let mut accounts = vec![
            ws(*depositor),
            r(self.config_pda()),
            w(pool),
            w(self.deposit_pda(&pool, depositor)),
            r(system_program::ID),
        ];
        match t {
            Some(t) => accounts.extend([
                r(t.mint),
                w(ata(&pool, &t.mint, &t.program)),
                w(ata(depositor, &t.mint, &t.program)),
                r(t.program),
            ]),
            None => accounts.extend((0..4).map(|_| r(self.program))),
        }
        self.ix(
            "refund",
            &RefundArgs {
                domain_hash: h,
                mint,
            },
            accounts,
        )
    }

    fn refund(&mut self, depositor: &Keypair, name: &str, t: Option<Tok>) -> TxResult {
        let ix = self.refund_ix(&depositor.pubkey(), name, t);
        self.send(&[ix], &[depositor])
    }

    fn withdraw_fees_ix(&self, payer: &Pubkey, t: Option<Tok>) -> Instruction {
        let mint = t.map(|t| t.mint).unwrap_or(SOL_MINT);
        let fee_vault = self.fees_pda(&mint);
        let recipient = self.config().fee_recipient;
        let mut accounts = vec![
            ws(*payer),
            r(self.config_pda()),
            w(fee_vault),
            w(recipient),
            r(system_program::ID),
        ];
        match t {
            Some(t) => accounts.extend([
                r(t.mint),
                w(ata(&fee_vault, &t.mint, &t.program)),
                w(ata(&recipient, &t.mint, &t.program)),
                r(t.program),
                r(ATA_PROGRAM),
            ]),
            None => accounts.extend((0..5).map(|_| r(self.program))),
        }
        self.ix("withdraw_fees", &WithdrawFeesArgs { mint }, accounts)
    }

    fn withdraw_fees(&mut self, payer: &Keypair, t: Option<Tok>) -> TxResult {
        let ix = self.withdraw_fees_ix(&payer.pubkey(), t);
        self.send(&[ix], &[payer])
    }

    fn pool(&self, name: &str, mint: &Pubkey) -> Option<Pool> {
        self.account(&self.pool_pda(&domain_hash(name), mint))
    }

    fn domain(&self, name: &str) -> Option<Domain> {
        self.account(&self.domain_pda(&domain_hash(name)))
    }

    fn deposit_of(&self, name: &str, mint: &Pubkey, depositor: &Pubkey) -> Option<Deposit> {
        let pool = self.pool_pda(&domain_hash(name), mint);
        self.account(&self.deposit_pda(&pool, depositor))
    }

    fn fee_vault(&self, mint: &Pubkey) -> Option<FeeVault> {
        self.account(&self.fees_pda(mint))
    }

    /// The rent-exempt minimum of an existing account.
    fn rent(&self, account: &Pubkey) -> u64 {
        let a = self.svm.get_account(account).expect("account exists");
        self.svm.minimum_balance_for_rent_exemption(a.data.len())
    }
}

/// Whether an account exists (a closed one is gone or holds no lamports).
pub fn account_exists(env: &Env, k: &Pubkey) -> bool {
    env.svm.get_account(k).is_some_and(|a| a.lamports > 0)
}

/// Sum of the lamports of `keys`.
pub fn total_lamports(env: &Env, keys: &[Pubkey]) -> u64 {
    keys.iter().map(|k| env.lamports(k)).sum()
}

/// A fresh environment with the config initialized as on mainnet. Returns the fee recipient.
pub fn setup() -> (Env, Pubkey) {
    let mut env = Env::new();
    let args = env.initialize();
    (env, args.fee_recipient)
}

// ---------- wallet records ----------

/// Which record a domain publishes its wallet in.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum RecordKind {
    /// `_wallet.<domain>` TXT
    Txt,
    /// `<domain>` WALLET (type 262)
    Wallet,
}

pub fn record_pda(env: &Env, name: &str, kind: RecordKind) -> (Pubkey, u8) {
    let (wire, ty) = match kind {
        RecordKind::Txt => (wire_name(name, Some("_wallet")), TYPE_TXT),
        RecordKind::Wallet => (wire_name(name, None), TYPE_WALLET),
    };
    Pubkey::find_program_address(
        &[seeds::RRSET, &name_hash(&wire), &ty.to_be_bytes()],
        &env.program,
    )
}

/// One TXT character-string or WALLET RDATA publishing `wallet` for SOL: "SOL <base58>".
pub fn sol_rdata(wallet: &Pubkey) -> Vec<u8> {
    let text = format!("SOL {wallet}");
    let mut v = vec![text.len() as u8];
    v.extend_from_slice(text.as_bytes());
    v
}

/// Writes a verified wallet record for `name` straight into its RRset PDA, as if the dnssec
/// instructions had proven it: signed at `signed_at`, valid until `expires_at`, publishing
/// `rdatas` (see `sol_rdata`). Returns its address.
pub fn put_record(
    env: &mut Env,
    name: &str,
    kind: RecordKind,
    rdatas: &[Vec<u8>],
    signed_at: i64,
    expires_at: i64,
) -> Pubkey {
    let (address, bump) = record_pda(env, name, kind);
    let data = record_data(name, kind, bump, rdatas, signed_at, expires_at);
    let lamports = env.svm.minimum_balance_for_rent_exemption(data.len());
    env.svm
        .set_account(
            address,
            Account {
                lamports,
                data,
                owner: env.program,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    address
}

/// The account bytes of a cached RRset (discriminator included).
pub fn record_data(
    name: &str,
    kind: RecordKind,
    bump: u8,
    rdatas: &[Vec<u8>],
    signed_at: i64,
    expires_at: i64,
) -> Vec<u8> {
    let (wire, ty) = match kind {
        RecordKind::Txt => (wire_name(name, Some("_wallet")), TYPE_TXT),
        RecordKind::Wallet => (wire_name(name, None), TYPE_WALLET),
    };
    // RrSet in state.rs: bump, rrtype, algorithm, key tag, signed_at, expires_at, payer, owner
    // (Vec), rdata (Vec of [u16 LE length, RDATA]).
    let mut records = Vec::new();
    for rd in rdatas {
        records.extend_from_slice(&(rd.len() as u16).to_le_bytes());
        records.extend_from_slice(rd);
    }
    let mut d = discriminator("account", "RrSet").to_vec();
    d.push(bump);
    d.extend_from_slice(&ty.to_le_bytes());
    d.push(13);
    d.extend_from_slice(&12345u16.to_le_bytes());
    d.extend_from_slice(&signed_at.to_le_bytes());
    d.extend_from_slice(&expires_at.to_le_bytes());
    d.extend_from_slice(&[7u8; 32]);
    d.extend_from_slice(&(wire.len() as u32).to_le_bytes());
    d.extend_from_slice(&wire);
    d.extend_from_slice(&(records.len() as u32).to_le_bytes());
    d.extend_from_slice(&records);
    d
}

/// A wallet record for `name` publishing `wallet`, signed an hour ago and valid for a day.
pub fn record_for(env: &mut Env, name: &str, wallet: &Pubkey) -> Pubkey {
    let now = env.now();
    put_record(
        env,
        name,
        RecordKind::Txt,
        &[sol_rdata(wallet)],
        now - 3600,
        now + 86_400,
    )
}

// ---------- tokens ----------

/// A base mint (82 bytes): mint authority, supply 0, decimals, initialized, optional freeze authority.
fn base_mint(authority: &Pubkey, decimals: u8, freeze: Option<&Pubkey>) -> Vec<u8> {
    let mut d = Vec::with_capacity(82);
    d.extend_from_slice(&1u32.to_le_bytes());
    d.extend_from_slice(authority.as_ref());
    d.extend_from_slice(&0u64.to_le_bytes());
    d.push(decimals);
    d.push(1);
    match freeze {
        Some(f) => {
            d.extend_from_slice(&1u32.to_le_bytes());
            d.extend_from_slice(f.as_ref());
        }
        None => d.extend_from_slice(&[0u8; 36]),
    }
    d
}

/// Creates a mint owned by `program` (SPL Token or Token-2022), with Token-2022 extensions given as
/// (type, value) TLV entries. Returns the pool key and the mint authority.
pub fn create_mint(
    env: &mut Env,
    program: Pubkey,
    decimals: u8,
    extensions: &[(u16, Vec<u8>)],
) -> (Tok, Keypair) {
    let authority = Keypair::new();
    let mint = Pubkey::new_unique();
    let mut data = base_mint(&authority.pubkey(), decimals, Some(&authority.pubkey()));
    if !extensions.is_empty() {
        assert_eq!(program, TOKEN_2022);
        data.resize(165, 0);
        data.push(1); // account type: mint
        for (ty, value) in extensions {
            data.extend_from_slice(&ty.to_le_bytes());
            data.extend_from_slice(&(value.len() as u16).to_le_bytes());
            data.extend_from_slice(value);
        }
    }
    let lamports = env.svm.minimum_balance_for_rent_exemption(data.len());
    env.svm
        .set_account(
            mint,
            Account {
                lamports,
                data,
                owner: program,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    (Tok { mint, program }, authority)
}

/// The TransferFeeConfig extension value: `bps` and `max` for every epoch, no authorities.
pub fn transfer_fee_ext(bps: u16, max: u64) -> (u16, Vec<u8>) {
    let mut v = vec![0u8; 32 + 32 + 8];
    for _ in 0..2 {
        v.extend_from_slice(&0u64.to_le_bytes()); // epoch
        v.extend_from_slice(&max.to_le_bytes());
        v.extend_from_slice(&bps.to_le_bytes());
    }
    (1, v)
}

/// A MetadataPointer extension pointing at the mint itself, as on pump.fun coins.
pub fn metadata_pointer_ext(mint_authority: &Pubkey) -> (u16, Vec<u8>) {
    let mut v = mint_authority.as_ref().to_vec();
    v.extend_from_slice(&[0u8; 32]);
    (18, v)
}

/// Creates `owner`'s associated token account (idempotent), paid by `payer`.
pub fn create_ata(env: &mut Env, payer: &Keypair, owner: &Pubkey, t: Tok) -> Pubkey {
    let address = ata(owner, &t.mint, &t.program);
    let ix = Instruction {
        program_id: ATA_PROGRAM,
        accounts: vec![
            ws(payer.pubkey()),
            w(address),
            r(*owner),
            r(t.mint),
            r(system_program::ID),
            r(t.program),
        ],
        data: vec![1],
    };
    env.send(&[ix], &[payer]).expect("create ATA");
    address
}

/// Mints `amount` to `owner`'s ATA, creating it.
pub fn mint_to(env: &mut Env, t: Tok, authority: &Keypair, owner: &Pubkey, amount: u64) -> Pubkey {
    let payer = env.funded(1);
    let dest = create_ata(env, &payer, owner, t);
    let mut data = vec![7u8];
    data.extend_from_slice(&amount.to_le_bytes());
    let ix = Instruction {
        program_id: t.program,
        accounts: vec![w(t.mint), w(dest), rs(authority.pubkey())],
        data,
    };
    env.send(&[ix], &[&payer, authority]).expect("mint_to");
    dest
}

/// A token account's balance, 0 if it doesn't exist.
pub fn token_balance(env: &Env, account: &Pubkey) -> u64 {
    match env.svm.get_account(account) {
        Some(a) if a.data.len() >= 72 => u64::from_le_bytes(a.data[64..72].try_into().unwrap()),
        _ => 0,
    }
}

/// A plain SPL Token transfer (no CPI), for donations straight into a vault.
pub fn transfer_checked(
    env: &mut Env,
    t: Tok,
    from_owner: &Keypair,
    to: &Pubkey,
    amount: u64,
    decimals: u8,
) {
    let mut data = vec![12u8];
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(decimals);
    let ix = Instruction {
        program_id: t.program,
        accounts: vec![
            w(ata(&from_owner.pubkey(), &t.mint, &t.program)),
            r(t.mint),
            w(*to),
            rs(from_owner.pubkey()),
        ],
        data,
    };
    env.send(&[ix], &[from_owner]).expect("transfer_checked");
}

/// An instruction with one account swapped for another, for the adversarial cases.
pub fn swap(mut ix: Instruction, index: usize, meta: AccountMeta) -> Instruction {
    ix.accounts[index] = meta;
    ix
}
