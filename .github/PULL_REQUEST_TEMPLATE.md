## What this changes

<!-- One or two sentences. Link the issue it closes, e.g. "Closes #12". -->

## Why

<!-- The problem it solves or the behaviour it adds. -->

## How it was tested

<!-- Commands you ran and what they showed. For contract changes, say whether you ran the fork tests. -->

## Checklist

- [ ] `npm test` passes
- [ ] Contract changes: `forge test` and the fork tests pass (see [CONTRIBUTING.md](https://github.com/Type262/262/blob/main/CONTRIBUTING.md#tests))
- [ ] `npm run mcp:build` re-run and the bundle committed, if `mcp/src/` or `lib/wallet262.js` changed
- [ ] Docs updated: `docs.html` where behaviour, commands or addresses changed, and `CHANGELOG.md` under Unreleased
- [ ] No secrets: no private keys, seed phrases, API keys or `.env` files
