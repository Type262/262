// Robinhood Chain mainnet deployment (2026-10-21T02:04:54.323Z, commit b663228). See deployments/robinhood-4663.json.
export const ESCROW_ADDRESS = '0x9fd2f1dc0b42e8a2e86e3cf231a293654691e8d5'
export const LAUNCHER_ADDRESS = '0x022657ac8bdd969fa5149e7a86fbbda2afaf716f'

// Solana: the type262 program, and the address lookup table that fits a launch with its opening buy in one
// transaction (solana-type262.js lookupTableTx creates it). Both are set at the mainnet deploy; until then the
// client uses the local test id from solana/programs/type262/src/lib.rs.
export const SOLANA_PROGRAM_ID = ''
export const SOLANA_LOOKUP_TABLE = ''
