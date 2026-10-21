//! Every error the program returns, in one enum because Anchor's IDL keeps only one.
//! Each module has its own range of codes (6000 + the discriminant), so a module can add errors
//! without renumbering another's: append inside your range, never reorder, clients match on numbers.

use anchor_lang::prelude::*;

#[error_code]
pub enum Type262Error {
    // ---------- 6000+: shared ----------
    #[msg("Not a canonical domain name: lowercase a-z, 0-9, '-', '_', labels of 1 to 63, no trailing dot")]
    BadDomain = 0,
    #[msg("The domain hash does not match the name")]
    DomainHashMismatch,
    #[msg("Only the admin can do this")]
    NotAdmin,
    #[msg("Only the pending admin can accept")]
    NotPendingAdmin,
    #[msg("Fee above the 1% cap, fee without a recipient, no admin, or zero refund delay")]
    BadConfig,
    #[msg("Only the program's upgrade authority can initialize it")]
    NotUpgradeAuthority,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Not implemented yet")]
    NotImplemented,

    // ---------- 6100+: dnssec ----------
    #[msg("Buffer write is empty or ends past the maximum buffer size")]
    BadBufferSize = 100,
    #[msg("Buffer does not hold [u32 length, signed set, u32 length, signature]")]
    BadBuffer,
    #[msg("Signed set is truncated or malformed")]
    BadSignedData,
    #[msg("Name is compressed, has a label over 63 bytes or is longer than 255 bytes")]
    BadName,
    #[msg("Names must be in canonical lowercase form")]
    NameNotLowercase,
    #[msg("Signed set has no records")]
    EmptyRRset,
    #[msg("Record class is not IN")]
    InvalidClass,
    #[msg("Records do not share one owner name")]
    InvalidRRSet,
    #[msg("Record type differs from the type the RRSIG covers")]
    SignatureTypeMismatch,
    #[msg("RRSIG label count differs from the owner's: wildcard expansions are not accepted")]
    InvalidLabelCount,
    #[msg("Signature has expired")]
    SignatureExpired,
    #[msg("Signature is not valid yet")]
    SignatureNotValidYet,
    #[msg("Signer is neither the owner nor an ancestor of it, or signs a DS set at its own name")]
    InvalidSignerName,
    #[msg("Parent is not the verified set this one must be checked against")]
    WrongParent,
    #[msg("Parent set has expired")]
    ParentExpired,
    #[msg("Unsupported DNSSEC algorithm")]
    UnsupportedAlgorithm,
    #[msg("RSA sets use verify_rrset or verify_rrset_buffered, P-256 and Ed25519 sets verify_rrset_precompiled")]
    WrongInstructionForAlgorithm,
    #[msg("No usable key verified the signature")]
    NoKeyVerified,
    #[msg("The key that signed the DNSKEY set matches no DS record")]
    NoMatchingDs,
    #[msg("Not the PDA of the set being verified")]
    WrongRRsetAccount,
    #[msg("The set has not expired yet")]
    RRsetNotExpired,
    #[msg("The rent goes back to the payer recorded in the set")]
    WrongPayer,
    #[msg("Not this domain's cached _wallet TXT or WALLET set")]
    NotAWalletRecord,
    #[msg("The wallet record has expired: verify it again")]
    WalletRecordExpired,
    #[msg("The wallet record does not publish this SOL address")]
    WalletNotPublished,

    // ---------- 6200+: escrow ----------
    #[msg("Deposits are paused")]
    Paused = 200,
    #[msg("An older proof can't override a newer one")]
    StaleProof,
    #[msg("Nothing to refund: no deposit, or the pool paid out since")]
    NothingToRefund,
    #[msg("The refund delay since the last deposit has not passed")]
    RefundLocked,
    #[msg("Wrong or missing mint for this pool")]
    WrongMint,
    #[msg("Token-2022 mint with an extension the escrow can't hold exactly")]
    UnsupportedMint,
    #[msg("Wrong token account or token program")]
    WrongTokenAccount,
    #[msg(
        "The recipient is not the wallet being paid, or is a token account, a mint or a program"
    )]
    BadRecipient,
    #[msg("The account would hold less than its rent plus what it owes")]
    PoolUnderfunded,
    #[msg("The pool account was never set up")]
    PoolNotOpen,
    #[msg("Signed at the same time as the domain's last proof, which named another wallet: only a record signed later can change it")]
    TiedProof,

    // ---------- 6300+: launcher ----------
    #[msg("Wrong pump.fun program")]
    WrongPumpProgram = 300,
    #[msg("Too few pump.fun create_v2 accounts")]
    MissingPumpAccounts,
    #[msg("create_v2's mint is not the launch's mint")]
    WrongCoinMint,
    #[msg("create_v2's user is not the launcher")]
    WrongCoinLauncher,
    #[msg("Not the coin's pump.fun bonding curve")]
    WrongBondingCurve,
    #[msg("The coin's bonding curve does not pay this domain's creator in SOL")]
    BadLaunchedCurve,
    #[msg("Wrong pump.fun account")]
    WrongPumpAccount,
    #[msg("Not this domain's pump.fun creator vault")]
    WrongCreatorVault,
    #[msg("Not the creator's WSOL account")]
    WrongCreatorTokenAccount,
    #[msg("No creator fees to collect")]
    NothingToCollect,
}
