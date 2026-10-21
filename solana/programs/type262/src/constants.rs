//! The fixed numbers of the protocol. None of them can change once the program is deployed.

use anchor_lang::prelude::Pubkey;

// ---------- escrow ----------

/// Stands for SOL wherever a mint goes (pool and fee vault seeds, `mint` fields).
pub const SOL_MINT: Pubkey = Pubkey::new_from_array([0; 32]);

/// Claim fee on each pool paid out, in basis points: 0.5%. Passed to `initialize`, which stores it.
pub const FEE_BPS: u16 = 50;
/// `initialize` rejects any fee above 1%.
pub const MAX_FEE_BPS: u16 = 100;
pub const BPS_DENOMINATOR: u64 = 10_000;
/// A depositor can take an unclaimed deposit back this long after their last deposit to that pool,
/// unless the domain claimed since. Passed to `initialize`, which stores it.
pub const REFUND_DELAY: i64 = 180 * 24 * 60 * 60;

/// Longest canonical name: 253 characters, so it always fits DNS's 255-byte wire form.
pub const MAX_DOMAIN_LEN: usize = 253;
/// Longest label, as in DNS, so every accepted name can be proven.
pub const MAX_LABEL_LEN: usize = 63;

// ---------- PDA seeds ----------
// Every address the program owns is derived from one of these, so clients can compute them offline.

/// ["config"]: the one program-wide settings account.
pub const CONFIG_SEED: &[u8] = b"config";
/// ["domain", domain_hash]: a domain's record of the newest proof it accepted.
pub const DOMAIN_SEED: &[u8] = b"domain";
/// ["pool", domain_hash, mint]: what one domain is owed in one asset; mint = Pubkey::default() for SOL.
pub const POOL_SEED: &[u8] = b"pool";
/// ["deposit", pool, depositor]: one depositor's refundable share of a pool.
pub const DEPOSIT_SEED: &[u8] = b"deposit";
/// ["fees", mint]: claim fees in one asset waiting for the fee recipient; mint = Pubkey::default() for SOL.
pub const FEES_SEED: &[u8] = b"fees";
/// ["buffer", payer]: upload space for one signed RRset, closed when it is verified.
pub const BUFFER_SEED: &[u8] = b"buffer";
/// ["rrset", sha256(owner name in canonical wire form), rrtype (u16 BE)]: a verified, cached RRset.
pub const RRSET_SEED: &[u8] = b"rrset";
/// ["creator", domain_hash]: the pump.fun creator of every coin launched for a domain.
pub const CREATOR_SEED: &[u8] = b"creator";
/// ["launch", mint]: the record of one coin launched here.
pub const LAUNCH_SEED: &[u8] = b"launch";

// ---------- DNS ----------

pub const CLASS_INET: u16 = 1;
pub const TYPE_TXT: u16 = 16;
pub const TYPE_DS: u16 = 43;
pub const TYPE_RRSIG: u16 = 46;
pub const TYPE_DNSKEY: u16 = 48;
/// The WALLET record.
pub const TYPE_WALLET: u16 = 262;

// 5 (RSASHA1) and 7 (RSASHA1-NSEC3-SHA1) are refused: SHA-1 signatures.
pub const ALGORITHM_RSASHA256: u8 = 8;
pub const ALGORITHM_ECDSAP256SHA256: u8 = 13;
pub const ALGORITHM_ED25519: u8 = 15;
pub const DIGEST_SHA1: u8 = 1;
pub const DIGEST_SHA256: u8 = 2;

/// DNSKEY flags: Zone Key (bit 7, RFC 4034 2.1.1) must be set, Revoke (bit 8, RFC 5011 7) clear.
pub const DNSKEY_FLAG_ZONE: u16 = 0x0100;
pub const DNSKEY_FLAG_REVOKE: u16 = 0x0080;
/// The only DNSKEY protocol value (RFC 4034 2.1.2).
pub const DNSKEY_PROTOCOL: u8 = 3;

/// The coin code a WALLET record or `_wallet` TXT line uses for a Solana address.
pub const COIN_SOL: &[u8] = b"SOL";
/// The label a domain publishes its wallet TXT under: `_wallet.<domain>`.
pub const WALLET_LABEL: &[u8] = b"_wallet";

/// sha256 of the root name in wire form (a single zero byte): the name hash of the root DNSKEY set.
pub const ROOT_NAME_HASH: [u8; 32] = [
    0x6e, 0x34, 0x0b, 0x9c, 0xff, 0xb3, 0x7a, 0x98, 0x9c, 0xa5, 0x44, 0xe6, 0xbb, 0x78, 0x0a, 0x2c,
    0x78, 0x90, 0x1d, 0x3f, 0xb3, 0x37, 0x38, 0x76, 0x85, 0x11, 0xa3, 0x06, 0x17, 0xaf, 0xa0, 0x1d,
];

/// A root zone DS record: the hash of one root key-signing key.
pub struct RootAnchor {
    pub key_tag: u16,
    pub algorithm: u8,
    pub digest_type: u8,
    pub digest: [u8; 32],
}

/// The root trust anchors, from IANA's https://data.iana.org/root-anchors/root-anchors.xml
/// (the same two the Robinhood Chain oracle was deployed with):
///   . IN DS 20326 8 2 E06D44B80B8F1D39A95C0B0D7C65D08458E880409BBC683457104237C7F8EC8D  (KSK-2017)
///   . IN DS 38696 8 2 683D2D0ACB8C9B712A1948B27F741219298D0A450D612C483AF444A4C0FB2B16  (KSK-2024)
/// They are compiled in: the root DNSKEY set is only ever accepted if one of these keys signed it.
pub const ROOT_ANCHORS: [RootAnchor; 2] = [
    RootAnchor {
        key_tag: 20326,
        algorithm: ALGORITHM_RSASHA256,
        digest_type: DIGEST_SHA256,
        digest: [
            0xe0, 0x6d, 0x44, 0xb8, 0x0b, 0x8f, 0x1d, 0x39, 0xa9, 0x5c, 0x0b, 0x0d, 0x7c, 0x65,
            0xd0, 0x84, 0x58, 0xe8, 0x80, 0x40, 0x9b, 0xbc, 0x68, 0x34, 0x57, 0x10, 0x42, 0x37,
            0xc7, 0xf8, 0xec, 0x8d,
        ],
    },
    RootAnchor {
        key_tag: 38696,
        algorithm: ALGORITHM_RSASHA256,
        digest_type: DIGEST_SHA256,
        digest: [
            0x68, 0x3d, 0x2d, 0x0a, 0xcb, 0x8c, 0x9b, 0x71, 0x2a, 0x19, 0x48, 0xb2, 0x7f, 0x74,
            0x12, 0x19, 0x29, 0x8d, 0x0a, 0x45, 0x0d, 0x61, 0x2c, 0x48, 0x3a, 0xf4, 0x44, 0xa4,
            0xc0, 0xfb, 0x2b, 0x16,
        ],
    },
];

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::solana_program::hash::hash;

    #[test]
    fn root_name_hash_is_sha256_of_the_root_name() {
        assert_eq!(hash(&[0u8]).to_bytes(), ROOT_NAME_HASH);
    }

    #[test]
    fn anchors_match_iana() {
        // Key tags as IANA lists them; the digests are checked against root-anchors.xml by eye
        // once, here only that nothing was swapped.
        assert_eq!(ROOT_ANCHORS[0].key_tag, 20326);
        assert_eq!(ROOT_ANCHORS[0].digest[..4], [0xe0, 0x6d, 0x44, 0xb8]);
        assert_eq!(ROOT_ANCHORS[1].key_tag, 38696);
        assert_eq!(ROOT_ANCHORS[1].digest[..4], [0x68, 0x3d, 0x2d, 0x0a]);
    }
}
