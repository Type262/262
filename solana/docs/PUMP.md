# pump.fun integration

How the `type262` launcher talks to pump.fun on Solana mainnet, checked against live mainnet state on
2026-10-21 (slot 459,712,516). Every claim marked proven below was run, not just read:

- `node solana/scripts/simulate-pump.mjs` builds the transactions by hand and runs them with
  `simulateTransaction` (`sigVerify: false`, `replaceRecentBlockhash: true`) against mainnet. Nothing is
  signed or sent.
- `node solana/scripts/fetch-fixtures.mjs` dumps the mainnet programs and config accounts into
  `solana/tests/fixtures/pump/` (gitignored). The full sequence below (create, buy, sweep, collect, complete
  the curve, migrate, PumpSwap buy, sweep, collect) also passes in LiteSVM 0.16 loaded with those dumps.

Sources: [pump-fun/pump-public-docs](https://github.com/pump-fun/pump-public-docs) at commit `639b87f`
(2026-10-13: IDLs, instruction docs), `@pump-fun/pump-sdk` 4.2.0 and `@pump-fun/pump-swap-sdk` 2.2.0 (both
2026-10-19: PDA helpers, builders). The IDLs in the SDK match the repo's for every instruction; only some
event layouts differ.

## In one page

- **Create with `create_v2`** (Token-2022, metadata in the mint). `creator` is plain instruction data: it never
  signs, so an off-curve PDA works. Proven: a coin created with `creator = ["creator", domain_hash]` of our
  program stores that PDA in `BondingCurve.creator`, and a CPI'd `create_v2` is already used on mainnet.
- **Every creator fee of a coin goes to `creator`**, and nothing in pump.fun needs the creator's signature to
  pay it out: `sweep_creator_fee`, `collect_creator_fee_v2`, PumpSwap `sweep_creator_fee` and
  `collect_coin_creator_fee` are all permissionless and their destinations are fixed by the program. Proven on
  live coins, including pump.fun's own holder-rewards coins, whose creator is an off-curve PDA too.
- **Our program never has to sign as the creator for pump.fun.** It signs as the creator PDA only to move what
  the PDA received into the domain's pool (a system transfer) and to unwrap the PDA's WSOL account.
- **The creator PDA must stay rent-exempt** (650,240 lamports today for a 0-byte account). Below that,
  `collect_creator_fee_v2` succeeds but pays nothing (`Creator account does not have enough rent-exemption
  lamports`). Proven.
- **Who else can change where fees go:** nobody but pump.fun's own admin key. A stranger cannot create a fee
  sharing config for the coin (`NotAuthorized`); `set_creator`, `set_metaplex_creator` and
  `set_coin_creator` cannot touch a Token-2022 coin; migration copies the creator into the pool. pump.fun's
  `admin_set_creator_authority` can reassign the creator of any non-mayhem coin with `admin_cto` (proven),
  and pump.fun can upgrade all four programs. That is the trust every pump.fun coin carries; see
  [Safety](#safety-who-can-move-the-fees).
- **Fees today:** 0.30% creator fee on the bonding curve; on the PumpSwap pool 0.30% below a 420 SOL market cap,
  then 0.95% falling stepwise to 0.05% at 98,240 SOL.

## Programs and fixed accounts

| What | Address | Notes |
| --- | --- | --- |
| pump (bonding curve) | `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` | upgradeable, last deployed slot 458,921,440 |
| pump_amm (PumpSwap) | `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` | upgradeable, slot 458,921,517 |
| pump_fees (Pump Fees) | `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ` | upgradeable, slot 456,132,171 |
| mayhem | `MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e` | upgradeable, slot 452,655,053; its accounts are passed to every `create_v2` |
| upgrade authority of all four | `7gZufwwAo17y5kg8FMyJy2phgpvv9RSdzWtdXiWHjFr8` | off-curve, so a multisig or program, not a hot key |
| Token-2022 | `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` | base token of every `create_v2` coin |
| SPL Token | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` | WSOL / USDC quote side |
| Associated Token | `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL` | |
| WSOL mint | `So11111111111111111111111111111111111111112` | pass it as `quote_mint` for SOL-paired coins |

| PDA | Seeds (program) | Address |
| --- | --- | --- |
| `global` | `["global"]` (pump) | `4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf` |
| `mint_authority` | `["mint-authority"]` (pump) | `TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM` |
| pump `event_authority` | `["__event_authority"]` (pump) | `Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1` |
| pump `fee_config` | `["fee_config", pump id]` (pump_fees) | `8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt` |
| PumpSwap `global_config` | `["global_config"]` (pump_amm) | `ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw` |
| PumpSwap `fee_config` | `["fee_config", pump_amm id]` (pump_fees) | `5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx` |
| PumpSwap `event_authority` | `["__event_authority"]` (pump_amm) | `GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR` |
| Pump Fees `event_authority` | `["__event_authority"]` (pump_fees) | `D6QxXDt6hhcCpto4HiZKkN2YQ2iZRF5R7S3caCHpUsML` |
| mayhem `global_params` | `["global-params"]` (mayhem) | `13ec7XdrjF3h3YcqBTFDSReRcUFwbCnJaAQspM4j6DDJ` |
| mayhem `sol_vault` | `["sol-vault"]` (mayhem) | `BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s` |
| `bonding_curve` | `["bonding-curve", mint]` (pump) | per coin |
| `creator_vault` | `["creator-vault", creator]` (pump) | per creator, so one per domain for all its coins |
| `mayhem_state` | `["mayhem-state", mint]` (mayhem) | per coin |
| `user_volume_accumulator` | `["user_volume_accumulator", user]` (pump; same seeds under pump_amm) | per trader |
| `pool_authority` | `["pool-authority", mint]` (pump) | creator of the canonical pool |
| canonical pool | `["pool", 0u16 LE, pool_authority, mint, quote_mint]` (pump_amm) | `quote_mint` = WSOL for SOL coins |
| `coin_creator_vault_authority` | `["creator_vault", coin_creator]` (pump_amm) | per creator; note `creator_vault` with an underscore |
| `sharing_config` | `["sharing-config", mint]` (pump_fees) | only if someone opts the coin into fee sharing |
| `holder_rewards` | `["holder-rewards", mint]` (pump) | the creator of a holder-rewards coin |
| ATA | `[owner, token_program, mint]` (Associated Token) | Token-2022 for the coin, SPL Token for WSOL |

Instruction discriminators are Anchor's `sha256("global:<name>")[..8]` and match the IDLs.

`Global` today (decoded from mainnet): `create_v2_enabled = true`, `mayhem_mode_enabled = true`,
`is_holder_reward_enabled = true`, `set_creator_authority` and `withdraw_authority` =
`39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg` (an on-curve wallet), `admin_set_creator_authority` =
`UqN2p5bAzBqYdHXcgB6WLtuVrdvmy9JSAtgqZb3CMKw` (off-curve), `authority` = `FFWtrEQ4B4PKQoVuHYzZq8FabGkVatYzDpEVHsK5rrhF`
(off-curve, also admin of both fee configs). Curve parameters: 1,073,000,000 virtual tokens and 30 virtual
SOL at start, 793,100,000 tokens for sale, 1,000,000,000 supply (6 decimals), migration fee 0.015000001 SOL,
`buyback_basis_points = 5000`.

## Fees today

Read from the two `fee_config` accounts (the `Global` / `GlobalConfig` bps fields are legacy and not used).

| Where | LP | Protocol | Creator |
| --- | --- | --- | --- |
| Bonding curve, any market cap | 0 | 0.95% | 0.30% |
| Canonical PumpSwap pool, market cap < 420 SOL | 0.02% | 0.93% | 0.30% |
| Canonical pool, 420 SOL to 98,240 SOL | 0.20% | 0.05% | 0.95%, 0.90%, ... stepping down in 24 tiers |
| Canonical pool, >= 98,240 SOL | 0.20% | 0.05% | 0.05% |
| Any non-canonical pool | 0.25% | 0.05% | 0 |

Half of the protocol fee (`buyback_basis_points = 5000` on both programs) is paid to a buyback recipient
inside every trade; the rest, and the whole creator fee, wait on the curve or pool for curve v3 and PumpSwap v2
trades (see below). Both programs use the same eight buyback recipients.
Market cap is in lamports: `virtual_quote_reserves * supply / virtual_token_reserves` on the curve,
`quote_reserves * supply / base_reserves` in the pool. A coin graduates at about 411 SOL of market cap
(115 SOL virtual over 279.9M tokens), so a fresh pool starts in the 0.30% tier and moves to 0.95% at 420 SOL.
USDC-paired coins use the `stable_fee_tiers` (same rates, thresholds in USDC: 59,000 to 20,000,000).

Proven on the curve: a 0.0028 SOL buy left `creator_fee = 8,389` lamports (0.30%) and `protocol_fees = 13,282`
on the curve, the other 13,282 paid to the buyback recipient.

## The creator

`create_v2` takes `creator: Pubkey` as an argument. It is not an account, so it never signs; per the docs the
program only rejects `Pubkey::default()`. Whatever is there becomes `BondingCurve.creator`, and at migration
`Pool.coin_creator`. All creator fees accrue to PDAs derived from it.

Our creator is `["creator", domain_hash]` of the type262 program, `domain_hash = sha256(canonical name)`, a
system-owned account with no data (it only ever holds lamports). One creator per domain means one
`creator_vault` and one PumpSwap creator vault per domain, shared by all its coins: a single collect pays out
every coin of the domain once each coin's fees are swept.

Rules for the PDA (the first two proven in simulation):

1. **Keep it at or above the rent-exempt minimum.** `collect_creator_fee_v2` pays the vault balance (minus the
   vault's own rent) to the creator with a system transfer. If the creator would end below rent-exempt it
   logs `Creator account does not have enough rent-exemption lamports` and pays nothing, without failing.
   Fund the PDA at launch (a plain system transfer creates it) and, when moving fees to the pool, leave
   `Rent::minimum_balance(0)` behind. Read rent at runtime: mainnet rent is now 5,080 lamports per byte-year
   with a 1-year threshold, so the minimum for 0 bytes is 650,240, not the old 890,880.
2. **A program-owned account works too** (proven with an account owned by another program holding 318 bytes),
   but a zero-data system account is what pump.fun's own holder-rewards PDAs are, and it is what the launcher
   uses.
3. **What our program signs as the creator:** `system_program::transfer` from the PDA to the domain's SOL
   pool, and SPL Token `close_account` of the PDA's own WSOL account (destination: the PDA). Nothing else.
   In particular it never invokes Pump Fees (`create_fee_sharing_config`, `update_fee_shares*`) and never
   passes the PDA as a signer to pump or PumpSwap.

## Launch: `create_v2`

Accounts (all 16 in the IDL; flags as pump.fun's own transactions send them):

| # | Account | W | S | Address / seeds |
| --- | --- | --- | --- | --- |
| 0 | `mint` | w | s | new keypair, generated by the client |
| 1 | `mint_authority` | | | `TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM` |
| 2 | `bonding_curve` | w | | `["bonding-curve", mint]` |
| 3 | `associated_bonding_curve` | w | | ATA(bonding_curve, mint, Token-2022) |
| 4 | `global` | | | `4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf` |
| 5 | `user` | w | s | pays all rent |
| 6 | `system_program` | | | `11111111111111111111111111111111` |
| 7 | `token_program` | | | Token-2022 |
| 8 | `associated_token_program` | | | Associated Token |
| 9 | `mayhem_program_id` | w | | `MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e` |
| 10 | `global_params` | | | `13ec7XdrjF3h3YcqBTFDSReRcUFwbCnJaAQspM4j6DDJ` |
| 11 | `sol_vault` | w | | `BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s` |
| 12 | `mayhem_state` | w | | `["mayhem-state", mint]` under mayhem |
| 13 | `mayhem_token_vault` | w | | ATA(sol_vault, mint, Token-2022) |
| 14 | `event_authority` | | | `Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1` |
| 15 | `program` | | | pump |

For a SOL-paired coin there are no remaining accounts. (USDC or a pump coin as quote adds `quote_mint`,
`associated_quote_bonding_curve`, `quote_token_program`, the `quote-control` PDA and, for pump-coin quotes,
the quote chain; not needed for the launcher.)

Data, borsh: discriminator `d6904cec5f8b31b4`, then

| Arg | Type | Value for us |
| --- | --- | --- |
| `name` | string (u32 LE length + UTF-8), at most 32 chars | coin name |
| `symbol` | string, at most 13 chars | |
| `uri` | string, at most 200 chars | metadata JSON URL |
| `creator` | 32 bytes | `["creator", domain_hash]` |
| `is_mayhem_mode` | u8 bool | `false` (see [Mayhem mode](#mayhem-mode)) |
| `is_cashback_enabled` | `OptionBool` = one bool byte, no tag | `false`; `true` fails with `CashbackDeprecated` (6082) |
| `creator_fee_bps` | `OptionU64` = 8 bytes, no tag | `0`; ignored on SOL and USDC pairs |
| `is_holder_reward` | `OptionBool` | `false`; `true` replaces our creator with pump's holder-rewards PDA |

The last three are EOF-tolerant: they may be left off, and a missing one reads as false / 0.

What it does (proven): creates the Token-2022 mint (6 decimals, metadata pointer and TokenMetadata extension
in the mint itself), mints the 1,000,000,000 supply to the curve, then sets **mint authority and freeze
authority to none and the metadata update authority to none**, so name, symbol and URI are final. Creates the
166-byte bonding curve with `creator`. Rent paid by `user`: 5,450,840 lamports (mint 2,443,480, curve
1,493,520, curve ATA 1,513,840). About 99k CU alone, 163k to 176k CU with the first buy.

Through CPI: a mainnet program already calls `create_v2` by CPI (transaction `eVCymaFC...CxiDY`,
"CreateCoinAndBuyBondingCurveV3"); the deepest call is Token-2022 at invoke depth 4. A `launch` that CPIs
`create_v2` only needs `invoke`, not `invoke_signed`: `user` and `mint` sign the outer transaction and the
creator does not sign at all.

What `launch` should check after the CPI, reading the bonding curve it just created (owner pump, address
`["bonding-curve", mint]`): `creator` (bytes 49..81) equals our PDA and `is_holder_reward` (byte 124) is 0.
That holds whatever pump.fun adds to `create_v2` later. (A holder-rewards create would already fail the first
check: pump replaces the creator with its own `holder-rewards` PDA.)

The legacy `create` (SPL Token + Metaplex metadata) still works today. Do not use it: on those coins
`set_creator` and `set_metaplex_creator` apply (they currently only fill in a missing creator, proven), and
nothing in the launcher needs it.

Note that `create_v2` is open to anyone: a coin can name our PDA as its creator without going through our
program. Its fees then go to the domain, which harms nobody; `collect` should therefore trust
`BondingCurve.creator`, not our launch records.

### Opening buy: `buy_v3`

Not needed inside our program: the client can add it after `launch` in the same transaction. 17 accounts:

| # | Account | W | S | Address / seeds |
| --- | --- | --- | --- | --- |
| 0 | `global` | | | `4wTV1Ymi...` |
| 1 | `base_mint` | | | the coin |
| 2 | `quote_mint` | | | WSOL for SOL-paired coins |
| 3 | `base_token_program` | | | Token-2022 |
| 4 | `quote_token_program` | | | SPL Token |
| 5 | `bonding_curve` | w | | `["bonding-curve", mint]` |
| 6 | `associated_base_bonding_curve` | w | | ATA(curve, mint, Token-2022) |
| 7 | `associated_quote_bonding_curve` | w | | ATA(curve, WSOL, SPL Token); unused for SOL, need not exist |
| 8 | `user` | w | s | buyer |
| 9 | `associated_base_user` | w | | ATA(user, mint, Token-2022); **must exist** (create it idempotently first) |
| 10 | `associated_quote_user` | w | | ATA(user, WSOL, SPL Token); unused for SOL |
| 11 | `user_volume_accumulator` | w | | `["user_volume_accumulator", user]`, created if missing |
| 12 | `fee_config` | | | `8Wf5TiAh...` |
| 13 | `buyback_fee_recipient` | w | | one of `Global.buyback_fee_recipients` (SOL coins: the account itself) |
| 14 | `system_program` | | | |
| 15 | `event_authority` | | | `Ce6TQqeH...` |
| 16 | `program` | | | pump |

Data: `07051dc4f5176550`, `amount: u64` (tokens, 6 decimals), `max_sol_cost: u64` (lamports, fees included),
`partial_fill: OptionBool` (only used on mayhem coins). A v3 buy that asks for more than the curve has left
completes the curve and buys the rest at the price the pool will open at (synthetic migration).

### Transaction size

`create_v2` + ATA + `buy_v3` alone is 1,106 bytes and 24 accounts as a legacy transaction; wrapped in our
`launch` (four more accounts, the domain name and hash in the data) it lands around 1,300, over 1,232
(estimate, not measured). Options: a v0 transaction with an address lookup table holding the
fixed accounts above, or a **v1 transaction**, which mainnet accepts now (SIMD-0385: up to 4,096 bytes and 64
accounts, no lookup tables, compute budget in the header; an unset compute-unit bit means a limit of 0).
`simulate-pump.mjs` builds v1 transactions and mainnet simulates them (1,210 to 1,553 bytes here). Whether
wallets sign v1 yet is not checked here. Also mind the 64-entry instruction trace: `migrate_v2` alone uses most
of it, so a create, a curve-completing buy and the migration do not fit in one transaction
(`MaxInstructionTraceLengthExceeded`, proven).

### Metadata URI

pump.fun's index takes any HTTPS URL; no IPFS gateway is required. Checked on mainnet: coins with `uri` on
`ipfs.io`, `gateway.pinata.cloud`, `pump.mypinata.cloud` and plain web hosts all show in pump.fun's
`frontend-api-v3.pump.fun/coins-v2/<mint>` with `metadata_uri` and `image_uri` taken from the JSON as-is.
The JSON pump.fun's own uploader writes:

```json
{
  "name": "Example",
  "symbol": "EX",
  "description": "",
  "image": "https://.../image.png",
  "showName": true,
  "createdOn": "https://pump.fun",
  "twitter": "",
  "telegram": "",
  "website": ""
}
```

Live coins also send `showName` as the string `"true"`, add `coin_community`, or leave fields out; pump.fun's
index copied `description`, `image` (as `image_uri`), `twitter` and `website` from whatever was there. The URI
is final once the coin exists (the metadata update authority is none), so host it somewhere that will not go
away.

## Fee flow

### On the bonding curve

1. Every v3 trade (`buy_v3`, `sell_v3`, `buy_exact_quote_in_v3`) adds the creator fee to
   `BondingCurve.creator_fee` and keeps the lamports in the curve. Older trades (`buy`, `buy_v2`, ...) pay it
   straight into `creator_vault`. Both kinds run on the same coin.
2. `sweep_creator_fee` (pump, permissionless) moves `BondingCurve.creator_fee` into
   `creator_vault = ["creator-vault", bonding_curve.creator]`. One sweep per coin.
3. `collect_creator_fee_v2` (pump, permissionless) pays `creator_vault` minus its rent to `creator`.

Proven (amounts from runs on 2026-10-21; live coins change between runs): on a live coin, an unrelated
payer's sweep + collect moved 342,718,305 lamports to the coin's creator without its signature; on a fresh
coin created with our PDA as creator, the same pair moved 8,389 lamports to the PDA once it held its rent;
pump.fun's holder-rewards PDA (off-curve) received 16,071,296 lamports the same way.

`sweep_creator_fee` (pump), data `20f6bf3408c949ba`, no args:

| # | Account | W | S | Address / seeds |
| --- | --- | --- | --- | --- |
| 0 | `payer` | w | s | anyone; pays a rent top-up if the vault is new |
| 1 | `global` | | | |
| 2 | `base_mint` | | | the coin |
| 3 | `quote_mint` | | | WSOL |
| 4 | `quote_token_program` | | | SPL Token |
| 5 | `associated_token_program` | | | |
| 6 | `system_program` | | | |
| 7 | `bonding_curve` | w | | `["bonding-curve", mint]` |
| 8 | `associated_quote_bonding_curve` | w | | ATA(curve, WSOL); unused for SOL |
| 9 | `recipient` | w | | `["creator-vault", bonding_curve.creator]` |
| 10 | `associated_quote_recipient` | w | | ATA(recipient, WSOL); unused for SOL |
| 11 | `event_authority` | | | |
| 12 | `program` | | | pump |

`collect_creator_fee_v2` (pump), data `cf118af204221338`, no args:

| # | Account | W | S | Address / seeds |
| --- | --- | --- | --- | --- |
| 0 | `creator` | w | | our PDA; must not be executable or owned by Pump Fees |
| 1 | `creator_token_account` | w | | ATA(creator, WSOL); unused for SOL |
| 2 | `creator_vault` | w | | `["creator-vault", creator]` |
| 3 | `creator_vault_token_account` | w | | ATA(creator_vault, WSOL); unused for SOL |
| 4 | `quote_mint` | | | WSOL |
| 5 | `quote_token_program` | | | SPL Token |
| 6 | `associated_token_program` | | | |
| 7 | `system_program` | | | |
| 8 | `event_authority` | | | |
| 9 | `program` | | | pump |

### Graduation

When the curve has sold its 793.1M tokens (about 85 SOL raised) it is complete and every curve trade fails
until `migrate_v2` runs (pump.fun runs it, but any signer can: proven in LiteSVM). Migration creates the
canonical pool (index 0, `pool.creator = ["pool-authority", mint]`), deposits the remaining tokens and the
SOL minus the 0.015 SOL migration fee, and **copies `BondingCurve.creator` into `Pool.coin_creator`**.
Proven: in LiteSVM with mainnet programs, `pool.coin_creator` equals our PDA after migration; on mainnet,
every graduated coin sampled (wallet, sharing-config and holder-rewards creators) has
`pool.coin_creator == bonding_curve.creator`. Creator fees still waiting on the curve stay sweepable and
collectable after migration (proven in LiteSVM: 0.528 SOL collected after migrating).

### On PumpSwap

1. Every PumpSwap v2 trade adds the creator fee to `Pool.creator_fees`, kept in the pool's WSOL vault. v1
   trades pay it straight to `coin_creator_vault_ata`.
2. `sweep_creator_fee` (PumpSwap, permissionless) moves `Pool.creator_fees` to
   `coin_creator_vault_ata = ATA(["creator_vault", pool.coin_creator], WSOL)`, creating the ATA if needed.
3. `collect_coin_creator_fee` (PumpSwap, permissionless) moves that ATA's whole balance into a WSOL token
   account owned by `coin_creator`. The account must exist; anyone may create the creator's ATA.

Proven: on live pools an unrelated payer swept and collected 341,641,090 lamports of waiting fees for a wallet
creator and 941,890,151 for an off-curve holder-rewards creator, into WSOL accounts owned by those creators,
without their signatures; in LiteSVM the same pair paid 16,018,096 lamports into our PDA's WSOL ATA after a
PumpSwap buy.

The fees arrive as WSOL. To keep the domain's money in its SOL pool, `collect` should close the PDA's WSOL
account (owner = PDA, so `invoke_signed`; SPL Token closes a native account with its balance) with the PDA as
destination, move the wrapped amount to the pool and pay the account's rent to the caller, who created it
earlier in the same transaction.

`sweep_creator_fee` (PumpSwap), data `20f6bf3408c949ba` (same name, other program), no args:

| # | Account | W | S | Address / seeds |
| --- | --- | --- | --- | --- |
| 0 | `payer` | w | s | anyone; pays the vault ATA if missing |
| 1 | `global_config` | | | `ADyA8hde...` |
| 2 | `pool` | w | | canonical pool |
| 3 | `quote_mint` | | | `pool.quote_mint` (WSOL) |
| 4 | `quote_token_program` | | | SPL Token |
| 5 | `pool_quote_token_account` | w | | `pool.pool_quote_token_account` = ATA(pool, WSOL) |
| 6 | `recipient` | | | `["creator_vault", pool.coin_creator]` under pump_amm |
| 7 | `recipient_token_account` | w | | ATA(recipient, WSOL), created idempotently |
| 8 | `system_program` | | | |
| 9 | `associated_token_program` | | | |
| 10 | `event_authority` | | | `GS4CU59F...` |
| 11 | `program` | | | pump_amm |

`collect_coin_creator_fee` (PumpSwap), data `a039592ab58b2b42`, no args:

| # | Account | W | S | Address / seeds |
| --- | --- | --- | --- | --- |
| 0 | `quote_mint` | | | WSOL |
| 1 | `quote_token_program` | | | SPL Token |
| 2 | `coin_creator` | | | our PDA (not a signer) |
| 3 | `coin_creator_vault_authority` | | | `["creator_vault", coin_creator]` under pump_amm |
| 4 | `coin_creator_vault_ata` | w | | ATA(vault authority, WSOL) |
| 5 | `coin_creator_token_account` | w | | a WSOL account owned by our PDA, must exist |
| 6 | `event_authority` | | | `GS4CU59F...` |
| 7 | `program` | | | pump_amm |

### If the coin has a sharing config

Only the coin's creator or `Global.admin_set_creator_authority` can call `create_fee_sharing_config`
(a stranger gets `NotAuthorized`, 6016, proven). Our program never does. If pump.fun's admin does it anyway,
the config it creates has **our PDA as `admin` and as the only shareholder (10,000 bps)**, proven by reading
the simulated `sharing_config`. `BondingCurve.creator` and `Pool.coin_creator` then become the
`sharing_config` PDA, `collect_creator_fee_v2` / `collect_coin_creator_fee` stop working for the coin, and
the payout path is: pump `sweep_creator_fee` (recipient `["creator-vault", sharing_config]`), PumpSwap
`sweep_creator_fee` if graduated, PumpSwap `transfer_creator_fees_to_pump_v2`, then pump
`distribute_creator_fees_v2` (permissionless) with our PDA as the remaining account. Proven: after an
admin-created config, buy + sweep + distribute paid 8,389 lamports to the PDA. `update_fee_shares_v2` (the
"one redirect": it can run once, then `admin_revoked` is set) needs `sharing_config.admin`, our PDA, to sign,
which our program never does. A client-side `collect` helper should detect `bonding_curve.creator ==
sharing_config` and use this path; the program itself still only moves what reaches the PDA.

`distribute_creator_fees_v2` (pump), data `ffcb134ff444089f`, arg `initialize_ata: bool` (ignored for SOL):
`payer` (w, s), `mint`, `bonding_curve`, `sharing_config`, `creator_vault` (w, `["creator-vault",
sharing_config]`), `system_program`, `event_authority`, `program`, `creator_vault_quote_token_account` (w,
ATA(creator_vault, WSOL)), `quote_mint`, `quote_token_program`, `associated_token_program`, then the
shareholders in `sharing_config` order (w). `transfer_creator_fees_to_pump_v2` (pump_amm, data
`01214eb921432c5c`): `payer` (w, s), `quote_mint`, `token_program`, `system_program`,
`associated_token_program`, `coin_creator` (= sharing_config), `coin_creator_vault_authority` (w),
`coin_creator_vault_ata` (w), `pump_creator_vault` (w, pump `["creator-vault", coin_creator]`),
`pump_creator_vault_ata` (w), `event_authority`, `program`.

## The launcher

As built in `programs/type262/src/launcher.rs` and tested in `tests-rs/tests/launcher_*.rs` against the
fixtures above (LiteSVM, mainnet programs).

### `launch(name, domain_hash, token_name, token_symbol, token_uri)`

| # | Account | W | S | |
| --- | --- | --- | --- | --- |
| 0 | `launcher` | w | s | pays every rent, pump's `user` |
| 1 | `domain` | w | | `["domain", domain_hash]`, created if new |
| 2 | `creator` | w | | `["creator", domain_hash]`, funded to `Rent::minimum_balance(0)` if below |
| 3 | `mint` | w | s | the new coin, a fresh keypair |
| 4 | `launch_record` | w | | `["launch", mint]` |
| 5 | `pump_program` | | | pump |
| 6 | `system_program` | | | |
| 7.. | remaining | | | the 16 `create_v2` accounts, in the order of [Launch](#launch-create_v2) |

The name must be canonical and hash to `domain_hash` (`BadDomain`, `DomainHashMismatch`). The program checks
remaining `[0]` = `mint` (`WrongCoinMint`), `[5]` = `launcher` (`WrongCoinLauncher`), `[2]` =
`["bonding-curve", mint]` (`WrongBondingCurve`), builds the `create_v2` data itself (creator = the PDA,
mayhem, cashback and holder rewards off) and `invoke`s pump with the accounts passed through as given, so a
new pump account needs no program change. After the call it reads the curve: owner pump, creator = the PDA,
not holder-rewards, not mayhem, quote SOL or WSOL, else `BadLaunchedCurve`. Then it writes the
`LaunchRecord` and increments `Domain.launches`.

The app's transaction: `launch`, then the launcher's Token-2022 ATA (create idempotent) and `buy_v3`. Measured
with `example.com`: 1,285 bytes as a legacy transaction (over 1,232), 981 bytes as v0 with one lookup table
holding the fixed accounts (type262, pump, `global`, `mint_authority`, System, Token-2022, SPL Token, ATA,
mayhem, `global_params`, `sol_vault`, pump `event_authority`, `fee_config`, the buyback recipient, WSOL, Compute
Budget). Compute: `launch` 131k to 145k CU including `create_v2` (bump searches vary with the mint); launch +
ATA + buy 198k to 216k, so set a limit of about 300k.

### `collect(domain_hash)`

| # | Account | W | |
| --- | --- | --- | --- |
| 0 | `payer` | w, s | anyone |
| 1 | `domain` | | `["domain", domain_hash]`, must exist |
| 2 | `creator` | w | `["creator", domain_hash]` |
| 3 | `creator_wsol` | w | ATA(creator, WSOL, SPL Token) |
| 4 | `pool` | w | `["pool", domain_hash, SOL_MINT]`, created if new |
| 5 | `creator_vault` | w | `["creator-vault", creator]` (pump) |
| 6 | `creator_vault_wsol` | w | ATA(creator_vault, WSOL) |
| 7 | `pump_event_authority` | | `Ce6TQqeH...` |
| 8 | `pump_program` | | pump |
| 9 | `amm_vault_authority` | | `["creator_vault", creator]` (pump_amm) |
| 10 | `amm_vault_wsol` | w | ATA(amm_vault_authority, WSOL) |
| 11 | `amm_event_authority` | | `GS4CU59F...` |
| 12 | `amm_program` | | pump_amm |
| 13 | `wsol_mint` | | WSOL |
| 14 | `token_program` | | SPL Token |
| 15 | `associated_token_program` | | |
| 16 | `system_program` | | |

No remaining accounts. Every account is fixed by the domain and checked (`WrongPumpProgram`,
`WrongPumpAccount`, `WrongCreatorVault`, `WrongCreatorTokenAccount`, Anchor seeds for domain, creator and
pool). The per-coin sweeps go before it in the same transaction: pump `sweep_creator_fee` for each coin with
`creator_fee` waiting on its curve, PumpSwap `sweep_creator_fee` for each graduated coin's pool. Then
`collect`:

1. tops the creator up to `Rent::minimum_balance(0)` from the payer if it is below (only a coin created
   outside `launch` can leave it unfunded);
2. if `creator_vault` holds more than its rent, CPIs pump `collect_creator_fee_v2`;
3. if `amm_vault_wsol` holds WSOL, creates `creator_wsol` (payer pays) and CPIs PumpSwap
   `collect_coin_creator_fee`;
4. if `creator_wsol` exists, closes it into the creator (signed as the PDA) and pays its rent reserve back to
   the payer;
5. moves everything the creator holds above its rent floor into the pool and credits it with
   `escrow::credit_fees`: non-refundable income, only a claim takes it. Nothing above the floor:
   `NothingToCollect`.

A pump collect only runs when its vault has something to pay, so if pump.fun changes one of those two
instructions, a client can still run it itself before `collect` (both are permissionless and pay only to
the creator) and `collect` moves what arrived. Compute: 86k CU with the curve collect, 89k with the PumpSwap
collect, WSOL account created and closed.

`collect` follows `BondingCurve.creator`, not the launch records: a coin someone creates straight on pump.fun
with the domain's PDA as creator pays the same vault, and one `collect` covers it with the domain's own coins (tested). The vault is per
creator, so `CreatorFeesCollected` carries the domain and the amount, not a mint.

## Safety: who can move the fees

Fees follow `BondingCurve.creator` and `Pool.coin_creator`. Every instruction that can change either, or
take fees out of the creator's vaults:

| Instruction | Who can call | On a `create_v2` coin with creator = our PDA |
| --- | --- | --- |
| `sweep_creator_fee` (both programs), `collect_creator_fee_v2`, `collect_coin_creator_fee`, `distribute_creator_fees_v2`, `transfer_creator_fees_to_pump_v2` | anyone | pay only to vaults of the current creator and then to the creator itself; destinations fixed by seeds (proven) |
| `set_metaplex_creator` (pump) | anyone | fails, `AccountOwnedByWrongProgram` (3007): needs an SPL Token mint (proven) |
| `set_creator` (pump) | `set_creator_authority` | fails, 3007 (proven); on legacy coins it only fills in a missing creator (proven) |
| `set_coin_creator` (pump_amm) | anyone | fails, `AccountNotInitialized` (3012) on the Metaplex metadata account, which Token-2022 coins do not have (proven on a live pool); none can be made since the mint authority is gone |
| `migrate_v2` | anyone, once complete | copies the creator into the pool (proven) |
| `create_fee_sharing_config` | the creator or `admin_set_creator_authority` | stranger: `NotAuthorized` (proven); admin: our PDA stays admin and sole shareholder (proven) |
| `update_fee_shares(_v2)` | `sharing_config.admin` = our PDA | our program never signs it |
| `admin_cto` (pump), `admin_cto_pool` (pump_amm), `admin_cto_sharing_config` (pump_fees, only via `admin_cto`) | `admin_set_creator_authority` | **works**: reassigns the creator (proven), can also turn the coin into a holder-rewards coin; refused on mayhem coins, `CtoNotAllowedForMayhemCoin` 6088 (proven) |
| program upgrade | upgrade authority `7gZufwwA...` | can change anything |

So with our program's signing limited as in [The creator](#the-creator), nobody can redirect the fees except
pump.fun itself, through its community-takeover admin key or a program upgrade. When an `admin_cto` replaces a
wallet-like creator, the IDL says the outgoing creator is paid from its vaults first; fees accrued before a
takeover are not lost, later ones go to the new creator.

### Mayhem mode

`is_mayhem_mode = true` makes the coin immune to `admin_cto` and `admin_cto_pool` today (proven for
`admin_cto`; `CtoNotAllowedForMayhemPool` is in the PumpSwap IDL), but it is a different coin. Proven: the
mint gets 2,000,000,000 supply, 1,000,000,000 of it in the mayhem program's vault
(ATA of `BwWK17cb...`); the creator fee is the same 0.30%. Per pump.fun's docs, mayhem coins pay protocol
fees to the reserved recipients and get no synthetic migration. It stays an option to offer per launch, not a
default.

## Risks and open points

- **pump.fun's admin and upgrade keys** (above). Same for every pump.fun coin; mayhem mode removes the first.
- **Interface churn.** `buy_v3`, PumpSwap `buy_v2`, fee sweeps and v1 transactions all arrived in October 2026.
  Keep the program's pump surface to `create_v2` (data only, accounts passed through) plus moving the PDA's
  own lamports; let clients build trades, sweeps and collects from the SDK or these scripts.
- **Rent floor.** Forgetting to fund the PDA makes collects silently pay nothing.
- **`create_v2` can be switched off** by pump.fun (`toggle_create_v2`); launches would fail, fees would not move.
- **Wallet support for v1 transactions** is not verified; plan a v0 + lookup table path.
- **The admin `create_fee_sharing_config` path** changes which instructions pay out; handled above, but the
  client helper must cover it.
- **Fee tiers** are pump.fun configuration (`update_fee_config`) and can change at any time.

## Reproduce

```sh
node solana/scripts/simulate-pump.mjs                 # all scenarios, about 35 seconds on public RPC
node solana/scripts/simulate-pump.mjs create probes   # some of them
node solana/scripts/fetch-fixtures.mjs                # refresh solana/tests/fixtures/pump
```

Scenarios: `create` (create_v2 + buy_v3, PDA creator), `create-collect` (create, buy, sweep, collect into an
unfunded PDA, a funded PDA and a program-owned account; v1), `graduate` (create + a buy that completes the
curve, then the creator check on live graduated coins), `collect-curve`, `collect-pool`,
`collect-offcurve`, `collect-pool-offcurve` (live coins with fees waiting, picked from recent trades), and
`probes` (`set_metaplex_creator`, `set_creator`, legacy create, `set_coin_creator` on a live pool, fee
sharing by a stranger / the creator / the admin, the admin-sharing payout, `admin_cto`, `admin_cto` on a
mayhem coin). Simulations borrow an existing funded wallet as fee payer (and one of pump.fun's fee wallets as
the ~180 SOL buyer in `graduate`); nothing is signed.

The fixtures directory holds `<name>.so` for pump, pump_amm, pump_fees, mayhem, mpl_token_metadata,
spl_token_2022, spl_token and spl_associated_token_account (the ELF only, cut where the programdata padding
starts; the script checks the next 4 KiB are zero, and a one-off comparison with the full programdata of all
seven upgradeable programs matched), `accounts/<pubkey>.json`
(`{ pubkey, owner, lamports, data (base64), executable, rentEpoch }`) for `Global`, both fee configs, both
global configs and volume accumulators, the fee program global, quote control, the mayhem accounts, the WSOL
and USDC mints, the Rent sysvar and the buyback recipients, `idl/*.json` pinned to commit `639b87f`, and
`manifest.json` (slot, labels, sizes, sha256, loader). In LiteSVM: load each program with
`add_program_with_loader(id, bytes, manifest loader)` (the ATA program is BPFLoader2, the rest upgradeable),
`set_account` each JSON, and keep the dumped Rent sysvar so rent matches mainnet.
