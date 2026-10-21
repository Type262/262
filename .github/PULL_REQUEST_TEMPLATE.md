## What this changes

<!-- One or two sentences. Link the issue it closes, e.g. "Closes #12". -->

## Why

<!-- The problem it solves or the behaviour it adds. -->

## How it was tested

<!-- Commands you ran and what they showed. For Solana worker or screen changes, say whether you ran the local-validator runs; for Robinhood Chain contract changes, the fork tests. -->

## Checklist

- [ ] `npm test` passes
- [ ] Solana worker or screen changes: the [Solana screens](https://github.com/Type262/262/blob/main/CONTRIBUTING.md#the-apps-solana-screens) run passes on a local validator
- [ ] On-chain Solana program changes: the [LiteSVM suites](https://github.com/Type262/262/blob/main/CONTRIBUTING.md#on-chain-solana-program) pass
- [ ] Robinhood Chain contract changes: `forge test` and the fork tests pass (see [CONTRIBUTING.md](https://github.com/Type262/262/blob/main/CONTRIBUTING.md#tests))
- [ ] `npm run mcp:build` re-run and the bundle committed, if `mcp/src/` or `lib/wallet262.js` changed
- [ ] Docs updated: `docs.html` where behaviour, commands or addresses changed, and `CHANGELOG.md` under Unreleased
- [ ] No secrets: no private keys, seed phrases, API keys or `.env` files
