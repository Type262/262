// Bundle the MCP server (hand-written MCP over stdio, viem and the wallet262 SDK included) into one
// self-contained file: node mcp/build.mjs
import { execSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const dir = fileURLToPath(new URL('.', import.meta.url))
const out = fileURLToPath(new URL('./type262-mcp.mjs', import.meta.url))

// Identifiers are kept (no --minify-identifiers) so the bundle stays auditable.
execSync([
  'npx --yes esbuild@0.24.0 src/server.mjs',
  '--bundle --platform=node --target=node18 --format=esm',
  '--minify-syntax --minify-whitespace --legal-comments=none --log-level=warning',
  '--outfile=type262-mcp.mjs',
].join(' '), { cwd: dir, stdio: 'inherit' })

// esbuild keeps the entry's #!/usr/bin/env node line. Check the bundle is self-contained.
const code = readFileSync(out, 'utf8')
if (!code.startsWith('#!/usr/bin/env node\n')) throw new Error('bundle lost its #! line')
const imports = [...code.matchAll(/(?:^|[;\s])import\s*(?:[^'"]*?from\s*)?["']([^"']+)["']/g)].map(m => m[1])
const external = [...new Set(imports.filter(m => !m.startsWith('node:')))]
if (external.length) throw new Error(`bundle still imports: ${external.join(', ')}`)
if (/Dynamic require of|\brequire\(/.test(code)) throw new Error('bundle contains a require()')
console.log(`mcp/type262-mcp.mjs ${(statSync(out).size / 1024).toFixed(1)} KB`)
