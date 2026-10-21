//! The build-and-test loop works: the program loads, initializes, and its admin role behaves.
//! The DNSSEC, escrow and launcher suites live in their own files next to this one.

use solana_signer::Signer;
use type262_tests::*;

#[test]
fn initialize_and_read_back() {
    let mut env = Env::new();
    let args = env.initialize();

    let config = env.config();
    assert_eq!(
        config,
        Config {
            admin: env.authority.pubkey(),
            pending_admin: Pubkey::default(),
            fee_recipient: args.fee_recipient,
            fee_bps: 50,
            refund_delay: 180 * 24 * 60 * 60,
            deposits_paused: false,
            bump: Pubkey::find_program_address(&[seeds::CONFIG], &env.program).1,
        }
    );
    // 8 discriminator + 3 pubkeys + u16 + i64 + bool + u8
    let account = env.svm.get_account(&env.config_pda()).unwrap();
    assert_eq!(account.data.len(), 8 + 32 * 3 + 2 + 8 + 1 + 1);
    assert_eq!(account.owner, env.program);

    // Once only.
    let ix = env.initialize_ix(&env.authority.pubkey(), &args);
    let authority = env.authority.insecure_clone();
    assert!(env.send(&[ix], &[&authority]).is_err());
}

#[test]
fn only_the_upgrade_authority_initializes() {
    let mut env = Env::new();
    let stranger = env.funded(10);
    let args = InitializeArgs {
        admin: stranger.pubkey(),
        fee_recipient: stranger.pubkey(),
        fee_bps: FEE_BPS,
        refund_delay: REFUND_DELAY,
    };
    let ix = env.initialize_ix(&stranger.pubkey(), &args);
    assert_err(env.send(&[ix], &[&stranger]), "NotUpgradeAuthority");

    // A program made immutable before initializing can never be initialized.
    env.set_upgrade_authority(None);
    let ix = env.initialize_ix(&env.authority.pubkey(), &args);
    let authority = env.authority.insecure_clone();
    assert_err(env.send(&[ix], &[&authority]), "NotUpgradeAuthority");
}

#[test]
fn initialize_rejects_bad_config() {
    let mut env = Env::new();
    let authority = env.authority.insecure_clone();
    let good = InitializeArgs {
        admin: authority.pubkey(),
        fee_recipient: Pubkey::new_unique(),
        fee_bps: FEE_BPS,
        refund_delay: REFUND_DELAY,
    };
    let bad = [
        InitializeArgs {
            fee_bps: MAX_FEE_BPS + 1,
            ..good.clone()
        },
        InitializeArgs {
            fee_recipient: Pubkey::default(),
            ..good.clone()
        },
        InitializeArgs {
            admin: Pubkey::default(),
            ..good.clone()
        },
        InitializeArgs {
            refund_delay: 0,
            ..good.clone()
        },
    ];
    for args in &bad {
        let ix = env.initialize_ix(&authority.pubkey(), args);
        assert_err(env.send(&[ix], &[&authority]), "BadConfig");
    }
    // The cap itself is allowed, and so is no fee without a recipient.
    let ix = env.initialize_ix(
        &authority.pubkey(),
        &InitializeArgs {
            fee_bps: 0,
            fee_recipient: Pubkey::default(),
            ..good.clone()
        },
    );
    env.send(&[ix], &[&authority])
        .expect("zero fee, no recipient");
}

#[test]
fn admin_pauses_and_hands_over_in_two_steps() {
    let mut env = Env::new();
    env.initialize();
    let admin = env.authority.insecure_clone();
    let stranger = env.funded(10);

    assert_err(env.set_deposits_paused(&stranger, true), "NotAdmin");
    env.set_deposits_paused(&admin, true).unwrap();
    assert!(env.config().deposits_paused);
    env.set_deposits_paused(&admin, false).unwrap();
    assert!(!env.config().deposits_paused);

    let next = env.funded(10);
    assert_err(env.transfer_admin(&stranger, next.pubkey()), "NotAdmin");
    env.transfer_admin(&admin, next.pubkey()).unwrap();
    assert_eq!(env.config().pending_admin, next.pubkey());
    // Still the old admin until the new one accepts.
    assert_eq!(env.config().admin, admin.pubkey());
    assert_err(env.accept_admin(&stranger), "NotPendingAdmin");
    env.accept_admin(&next).unwrap();

    let config = env.config();
    assert_eq!(config.admin, next.pubkey());
    assert_eq!(config.pending_admin, Pubkey::default());
    assert_err(env.set_deposits_paused(&admin, true), "NotAdmin");
    env.set_deposits_paused(&next, true).unwrap();
}

// Buffers and every DNSSEC instruction are tested in dnssec_*.rs.

#[cfg(feature = "precompiles")]
#[test]
fn precompiles_are_loaded() {
    // DNSSEC algorithms 13 and 15 are checked by these, so the feature must actually load them.
    let env = Env::new();
    for id in [
        solana_sdk_ids::secp256r1_program::ID,
        solana_sdk_ids::ed25519_program::ID,
    ] {
        let account = env
            .svm
            .get_account(&id)
            .unwrap_or_else(|| panic!("{id} missing"));
        assert!(account.executable);
    }
}
