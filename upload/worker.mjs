// The Solana vault worker: what /solana/* does. Every domain has its own vault address (vault.mjs); anyone can send
// SOL or tokens to it, and pump.fun coins launched with the vault as creator pay their creator fees into it. The
// worker holds the vault keys (custodial: unlike the Robinhood Chain contracts, nothing on-chain checks DNSSEC
// here) and pays a vault out only to the SOL address the domain publishes in DNSSEC-signed DNS, minus FEE_BPS.
// A sender gets a deposit back after REFUND_DELAY_DAYS if the domain has not been claimed since. The chain is the
// database: claims and refunds carry memos the vault signs, and the worker keeps no state between requests.
//
//   collect(domain)          pump.fun creator fees of the vault's coins -> the vault
//   claim(domain)            DNS check, collect, then every token and all SOL -> the owner (fee -> SOLANA_FEE_WALLET)
//   refund(domain, sig)      a deposit back to its sender, once, after the delay, if no claim came after it
//   vault(domain), status()  addresses and settings, no secrets
//
// Amounts in answers are decimal strings (token amounts can pass 2^53). The gas wallet pays every transaction fee,
// the rent of token accounts the owner or the fee wallet needs, and gets back the rent of vault accounts it closes.
import { generateKeyPairSync, sign as edSign } from 'node:crypto'
import { resolveWallets } from '../lib/wallet262.js'
import { USDC } from '../assets/solana.js'
import {
  BONDING_CURVE_DISCRIMINATOR, CURVE_CREATOR_OFFSET, POOL_COIN_CREATOR_OFFSET, POOL_DISCRIMINATOR, PUMP, PUMP_AMM,
  SYSTEM, TOKEN, TOKEN_2022, WSOL, ammCreatorVaultPda, ammSweepCreatorFee, ata, b58encode, bondingCurvePda,
  collectCoinCreatorFee, collectCreatorFeeV2, createAtaIdempotent, creatorVaultPda, isPubkey, readBondingCurve, readPool,
  solQuoted, sweepCreatorFee,
} from './pump.mjs'
import {
  TxError, closeAccount, createAccount, execute, fits, initializeAccount3, makeRpc, memo, priorityFee, systemTransfer,
  transferChecked,
} from './chain.mjs'
import {
  Refusal, canonicalDomain, claimMemo, depositOf, feeOf, gasKeypair, keypairFromSolanaJson, parseMasterSeed, parseSignature, recipientProblem,
  refundMemo, solWalletFrom, vaultKeypair, vaultSignedWithMemo,
} from './vault.mjs'

const DAY = 86_400
const TOKEN_ACCOUNT_SIZE = 165
const TOKEN_2022_ACCOUNT_ESTIMATE = 300 // with extensions; only for the gas estimate
const SIGNATURE_FEE = 5_000n
const HISTORY_PAGES = 20 // getSignaturesForAddress pages of 1000 a refund may scan
const MAX_HISTORY_READS = 500 // transactions a refund may fetch to check their memos

const lamportsOf = v => BigInt(v ?? 0)
const str = v => v.toString()
const sum = (list, f) => list.reduce((n, x) => n + f(x), 0n)
const withheldFees = info => (info.extensions || []).some(e => e.extension === 'transferFeeAmount' && BigInt(e.state?.withheldAmount || 0) > 0n)

/** A throwaway signer for a token account that lives inside one transaction. */
function ephemeralKeypair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return { address: b58encode(Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url')), sign: m => new Uint8Array(edSign(null, Buffer.from(m), privateKey)) }
}

export function settings(env = process.env) {
  const num = (v, d) => (v === undefined || v === '' ? d : Number(v))
  const feeBps = num(env.FEE_BPS, 50)
  const refundDelayDays = num(env.REFUND_DELAY_DAYS, 180)
  const problems = []
  let master = null
  if (env.VAULT_MASTER_SEED) { try { master = parseMasterSeed(env.VAULT_MASTER_SEED) } catch (err) { problems.push(err.message) } } else problems.push('VAULT_MASTER_SEED is not set')
  const feeWallet = (env.SOLANA_FEE_WALLET || '').trim()
  if (!feeWallet) problems.push('SOLANA_FEE_WALLET is not set')
  else if (!isPubkey(feeWallet)) problems.push('SOLANA_FEE_WALLET is not a Solana address')
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 1000) problems.push('FEE_BPS must be a whole number from 0 to 1000')
  if (!Number.isFinite(refundDelayDays) || refundDelayDays < 0) problems.push('REFUND_DELAY_DAYS must be 0 or more')
  return {
    master, feeWallet: isPubkey(feeWallet) ? feeWallet : null, feeBps, refundDelayDays, problems,
    usdcMint: (env.SOLANA_USDC_MINT || USDC.mint).trim(),
    resolvers: (env.DOH_RESOLVERS || 'cloudflare,google').split(',').map(s => s.trim()).filter(Boolean),
    priorityMin: num(env.PRIORITY_FEE_MIN, 20_000),
    priorityMax: num(env.PRIORITY_FEE_MAX, 2_000_000),
    maxTokens: num(env.MAX_TOKENS_PER_CLAIM, 20),
  }
}

/**
 * The worker. `rpc` defaults to SOLANA_RPC_URL then SOLANA_PUBLIC_RPC_URLS; tests pass a mock rpc, a fetch for
 * DNS-over-HTTPS and a clock.
 */
export function createWorker({ env = process.env, rpc, fetch = globalThis.fetch, log = console.log, now = () => Date.now(), pollMs = 1000 } = {}) {
  const cfg = settings(env)
  rpc ||= makeRpc([(env.SOLANA_RPC_URL || '').trim(), ...(env.SOLANA_PUBLIC_RPC_URLS || 'https://solana-rpc.publicnode.com,https://api.mainnet-beta.solana.com').split(',').map(s => s.trim())], { fetch, log: m => log(m) })
  const ready = !cfg.problems.length
  // SOLANA_GAS_KEYPAIR, when set, is a wallet funded directly; otherwise the gas wallet is derived from the master.
  const gas = env.SOLANA_GAS_KEYPAIR ? keypairFromSolanaJson(env.SOLANA_GAS_KEYPAIR) : cfg.master ? gasKeypair(cfg.master) : null
  const locks = new Set()
  const curveMints = new Map() // bonding curve -> mint: fixed forever once found
  const refunding = new Map() // "domain signature" -> time, while its refund may not show in history yet
  const rentCache = new Map()

  const needReady = () => { if (!ready) throw new Refusal(503, 'Not set up', 'Solana vaults are not set up on this server yet.') }
  const needMaster = () => { if (!cfg.master) throw new Refusal(503, 'Not set up', 'Solana vaults are not set up on this server yet.') }

  async function rent(size) {
    const hit = rentCache.get(size)
    if (hit && now() - hit.at < 10 * 60_000) return hit.lamports
    const lamports = BigInt(await rpc('getMinimumBalanceForRentExemption', [size]))
    rentCache.set(size, { lamports, at: now() })
    return lamports
  }

  async function withLock(domain, fn) {
    if (locks.has(domain)) throw new Refusal(409, 'Busy', `Another request for ${domain} is running. Try again in a minute.`)
    locks.add(domain)
    try { return await fn() } finally { locks.delete(domain) }
  }

  // ---------- per-request context: reads never go behind what this request already confirmed ----------

  function context(domain) {
    const ctx = { domain, vault: vaultKeypair(cfg.master, domain), minSlot: 0, signatures: [] }
    const at = () => ({ commitment: 'confirmed', ...(ctx.minSlot ? { minContextSlot: ctx.minSlot } : {}) })
    ctx.balance = async a => lamportsOf((await rpc('getBalance', [a, at()])).value)
    ctx.account = async (a, encoding = 'base64') => (await rpc('getAccountInfo', [a, { encoding, ...at() }])).value
    ctx.accounts = async (list, encoding = 'base64') => (await rpc('getMultipleAccounts', [list, { encoding, ...at() }])).value
    ctx.tokenAccounts = async owner => {
      const lists = await Promise.all([TOKEN, TOKEN_2022].map(programId => rpc('getTokenAccountsByOwner', [owner, { programId }, { encoding: 'jsonParsed', ...at() }])))
      return lists.flatMap((l, i) => l.value.map(a => ({ address: a.pubkey, program: [TOKEN, TOKEN_2022][i], lamports: lamportsOf(a.account.lamports), info: a.account.data.parsed.info })))
    }
    ctx.programAccounts = (program, filters) => rpc('getProgramAccounts', [program, { encoding: 'base64', filters, ...at() }])
    ctx.landed = r => { ctx.minSlot = Math.max(ctx.minSlot, r.slot || 0); ctx.signatures.push(r.signature) }
    return ctx
  }

  /** Refuses when the gas wallet can't cover `need` lamports and still keep its own rent. */
  async function checkGas(ctx, need) {
    const have = await ctx.balance(gas.address)
    const floor = await rent(0)
    if (have < need + floor) {
      const sol = l => (Number(l) / 1e9).toFixed(6)
      throw new Refusal(503, 'Out of gas', `The worker's gas wallet ${gas.address} holds ${sol(have)} SOL; this needs about ${sol(need + floor)} SOL. Send SOL to it and try again.`)
    }
  }

  /**
   * Runs one transaction built from fresh state by plan(attempt) (null: nothing to do). Rebuilds and resends when
   * it expired, up to three times, at a higher priority fee each time. Returns { signature, slot, plan } or null.
   */
  async function step(ctx, label, plan) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const p = await plan(attempt)
      if (!p) return null
      const keys = [gas, ...(p.signers || [])]
      const writable = [...new Set(p.instructions.flatMap(ix => ix.keys.filter(k => k.isWritable).map(k => k.pubkey)))]
      const price = await priorityFee(rpc, writable, { min: cfg.priorityMin, max: cfg.priorityMax, attempt })
      const nSig = BigInt(new Set(keys.map(s => s.address)).size)
      await checkGas(ctx, nSig * SIGNATURE_FEE + BigInt(Math.ceil(1_400_000 * price / 1e6)) + (p.rent || 0n))
      try {
        const r = await execute(rpc, { payer: gas.address, keys, instructions: p.instructions, price, watch: p.watch || [], check: p.check, label: `${label} (${ctx.domain})`, log, pollMs })
        ctx.landed(r)
        return { ...r, plan: p }
      } catch (err) {
        if (err.expired && attempt < 2) { log(`${label} (${ctx.domain}): expired, rebuilding`); continue }
        throw err
      }
    }
  }

  // ---------- collect: pump.fun creator fees -> the vault ----------

  /** The vault's pump.fun coins with fees waiting: curves by BondingCurve.creator, pools by Pool.coin_creator. */
  async function coinsOf(ctx) {
    const vault = ctx.vault.address
    const [curves, pools] = await Promise.all([
      ctx.programAccounts(PUMP, [{ memcmp: { offset: 0, bytes: b58encode(BONDING_CURVE_DISCRIMINATOR) } }, { memcmp: { offset: CURVE_CREATOR_OFFSET, bytes: vault } }]),
      ctx.programAccounts(PUMP_AMM, [{ memcmp: { offset: 0, bytes: b58encode(POOL_DISCRIMINATOR) } }, { memcmp: { offset: POOL_COIN_CREATOR_OFFSET, bytes: vault } }]),
    ])
    const poolList = pools.map(p => ({ address: p.pubkey, ...readPool(Buffer.from(p.account.data[0], 'base64')) })).filter(p => p.coinCreator === vault)
    for (const p of poolList) curveMints.set(bondingCurvePda(p.baseMint), p.baseMint)
    const curveList = []
    for (const c of curves) {
      const curve = readBondingCurve(Buffer.from(c.account.data[0], 'base64'))
      if (curve.creator !== vault || curve.creatorFee === 0n || !solQuoted(curve.quoteMint)) continue
      const mint = await mintOfCurve(ctx, c.pubkey)
      if (mint) curveList.push({ address: c.pubkey, mint, fee: curve.creatorFee })
      else log(`collect (${ctx.domain}): no mint found for curve ${c.pubkey}, skipped`)
    }
    return { curves: curveList, pools: poolList.filter(p => p.quoteMint === WSOL && p.creatorFees > 0n) }
  }

  // A curve doesn't store its mint; its token account does (checked: the curve address must derive from it).
  async function mintOfCurve(ctx, curve) {
    if (curveMints.has(curve)) return curveMints.get(curve)
    for (const a of await ctx.tokenAccounts(curve)) {
      if (bondingCurvePda(a.info.mint) === curve) { curveMints.set(curve, a.info.mint); return a.info.mint }
    }
    return null
  }

  /**
   * Everything a collect would move, read fresh: the per-coin sweeps, what already waits in pump's two creator vaults
   * for this vault, and the vault's balance. gain = what the vault receives.
   */
  async function collectPlan(ctx) {
    const vault = ctx.vault.address
    const { curves, pools } = await coinsOf(ctx)
    const sweeps = [
      ...curves.map(c => ({ ix: sweepCreatorFee({ payer: gas.address, mint: c.mint, creator: vault }), entry: { mint: c.mint, lamports: c.fee, source: 'curve' } })),
      ...pools.map(p => ({ ix: ammSweepCreatorFee({ payer: gas.address, pool: p.address, coinCreator: vault, poolQuoteTokenAccount: p.poolQuoteTokenAccount }), entry: { mint: p.baseMint, lamports: p.creatorFees, source: 'pool' } })),
    ]
    const [cvInfo, ammInfo] = await ctx.accounts([creatorVaultPda(vault), ata(ammCreatorVaultPda(vault), WSOL, TOKEN)], 'jsonParsed')
    const cvRent = cvInfo ? await rent(cvInfo.space ?? 0) : 0n
    const cvWaiting = cvInfo && lamportsOf(cvInfo.lamports) > cvRent ? lamportsOf(cvInfo.lamports) - cvRent : 0n
    const ammWaiting = ammInfo && ammInfo.data && ammInfo.data.parsed ? BigInt(ammInfo.data.parsed.info.tokenAmount.amount) : 0n
    const pump = cvWaiting + sum(sweeps.filter(s => s.entry.source === 'curve'), s => s.entry.lamports)
    const amm = ammWaiting + sum(sweeps.filter(s => s.entry.source === 'pool'), s => s.entry.lamports)
    return { sweeps, cvWaiting, ammWaiting, pump, amm, gain: pump + amm, vaultLamports: await ctx.balance(vault) }
  }

  /**
   * The collect instructions for a plan: pump pays the curve fees to the vault in lamports; PumpSwap pays WSOL into
   * a token account the vault owns for the length of the transaction, closed into the vault (unwrapped) at once.
   */
  async function collectTail(ctx, plan) {
    const vault = ctx.vault.address
    const ixs = []
    const signers = []
    const floor = await rent(0)
    // pump pays nothing to a creator below its rent minimum, so an empty vault is lent the minimum and repays it.
    const lend = plan.vaultLamports < floor ? floor - plan.vaultLamports : 0n
    if (lend) { ixs.push(systemTransfer(gas.address, vault, lend)); signers.push(ctx.vault) }
    if (plan.pump > 0n) ixs.push(collectCreatorFeeV2({ creator: vault }))
    let tokenRent = 0n
    if (plan.amm > 0n) {
      const tmp = ephemeralKeypair()
      tokenRent = await rent(TOKEN_ACCOUNT_SIZE)
      ixs.push(
        createAccount({ from: gas.address, account: tmp.address, lamports: tokenRent, space: TOKEN_ACCOUNT_SIZE, owner: TOKEN }),
        initializeAccount3({ account: tmp.address, mint: WSOL, owner: vault }),
        collectCoinCreatorFee({ coinCreator: vault, coinCreatorTokenAccount: tmp.address }),
        closeAccount({ account: tmp.address, destination: vault, owner: vault }),
        systemTransfer(vault, gas.address, tokenRent),
      )
      signers.push(tmp)
      if (!lend) signers.push(ctx.vault)
    }
    if (lend) ixs.push(systemTransfer(vault, gas.address, lend))
    return { ixs, signers, rent: lend + tokenRent }
  }

  // The vault must end up exactly `gain` richer, or the collect is not sent (fees stay safe with pump.fun).
  const expectGain = plan => ([v]) => {
    if (v.lamports !== plan.vaultLamports + plan.gain) throw new TxError(`pump.fun would pay ${v.lamports - plan.vaultLamports} lamports, not the ${plan.gain} expected; nothing was collected`)
  }

  async function collectInto(ctx) {
    const vault = ctx.vault.address
    const first = await collectPlan(ctx)
    if (!first.gain) return { collected: [], pending: 0n }
    const floor = await rent(0)
    // Fees below the rent minimum can't enter an empty vault; they wait with pump.fun until they grow.
    const dust = p => p.vaultLamports < floor && p.vaultLamports + p.gain < floor
    if (dust(first)) {
      log(`collect (${ctx.domain}): ${first.gain} lamports waiting, below the rent minimum of an empty vault`)
      return { collected: [], pending: first.gain }
    }
    const together = async p => [...p.sweeps.map(s => s.ix), ...(await collectTail(ctx, p)).ixs]
    let collected
    if (fits(gas.address, await together(first))) {
      // One transaction: the sweeps, then the collect, checked against the simulated vault balance.
      const r = await step(ctx, 'collect', async attempt => {
        const p = attempt ? await collectPlan(ctx) : first
        if (!p.gain || dust(p)) return null
        const t = await collectTail(ctx, p)
        return { instructions: [...p.sweeps.map(s => s.ix), ...t.ixs], signers: t.signers, rent: t.rent, watch: [vault], check: expectGain(p), p }
      })
      if (!r) return { collected: [], pending: 0n }
      const p = r.plan.p
      collected = [...p.sweeps.map(s => s.entry)]
      if (p.cvWaiting) collected.push({ mint: null, lamports: p.cvWaiting, source: 'creator-vault' })
      if (p.ammWaiting) collected.push({ mint: null, lamports: p.ammWaiting, source: 'pool-creator-vault' })
    } else {
      // Many coins: sweep in batches first, then collect what reached pump's creator vaults.
      const batches = []
      let cur = []
      for (const s of first.sweeps) { if (fits(gas.address, [...cur, s].map(x => x.ix))) cur.push(s); else { batches.push(cur); cur = [s] } }
      if (cur.length) batches.push(cur)
      const swept = []
      for (const batch of batches) {
        const r = await step(ctx, 'sweep creator fees', async attempt => {
          if (attempt) {
            const p = await collectPlan(ctx)
            const left = new Set(p.sweeps.map(s => s.entry.mint))
            batch.splice(0, batch.length, ...batch.filter(s => left.has(s.entry.mint)))
            if (!batch.length) return null
          }
          return { instructions: batch.map(s => s.ix) }
        })
        if (r) swept.push(...batch.map(s => s.entry))
      }
      const r = await step(ctx, 'collect', async () => {
        const p = await collectPlan(ctx)
        if (!p.gain || dust(p)) return null
        const t = await collectTail(ctx, { ...p, sweeps: [] })
        return { instructions: [...p.sweeps.map(s => s.ix), ...t.ixs], signers: t.signers, rent: t.rent, watch: [vault], check: expectGain(p), p }
      })
      collected = swept
      if (r) {
        const rest = r.plan.p.gain - sum(swept, s => s.lamports)
        if (rest > 0n) collected.push({ mint: null, lamports: rest, source: 'creator-vault' })
      }
    }
    log(`collect (${ctx.domain}): ${sum(collected, c => c.lamports)} lamports from ${collected.length} source(s) into ${vault}`)
    return { collected, pending: 0n }
  }

  const collectedJson = list => list.map(c => ({ mint: c.mint, lamports: str(c.lamports), source: c.source }))

  // ---------- claim ----------

  async function dnsWallet(domain) {
    let res
    try {
      res = await resolveWallets(domain, { fetch, resolvers: cfg.resolvers })
    } catch (err) {
      throw new Refusal(502, 'DNS check failed', `The DNS resolvers could not be reached for ${domain} (${String(err.message).slice(0, 120)}). Try again in a moment.`)
    }
    return solWalletFrom(res, { resolvers: cfg.resolvers.length })
  }

  async function payToken(ctx, a, owner) {
    const vault = ctx.vault.address
    const amount = BigInt(a.info.tokenAmount.amount)
    const decimals = a.info.tokenAmount.decimals
    const fee = feeOf(amount, cfg.feeBps)
    const ownerAta = ata(owner, a.info.mint, a.program)
    const feeAta = ata(cfg.feeWallet, a.info.mint, a.program)
    // A Token-2022 account holding withheld transfer fees can't be closed; it stays open, empty.
    const close = !withheldFees(a.info)
    const r = await step(ctx, `pay ${a.info.mint}`, async attempt => {
      if (attempt) {
        const [again] = await ctx.accounts([a.address], 'jsonParsed')
        if (!again || BigInt(again.data.parsed.info.tokenAmount.amount) !== amount) return null
      }
      const [ownerInfo, feeInfo] = await ctx.accounts([ownerAta, feeAta])
      const size = a.program === TOKEN ? TOKEN_ACCOUNT_SIZE : TOKEN_2022_ACCOUNT_ESTIMATE
      const rentNeed = (ownerInfo ? 0n : await rent(size)) + (fee && !feeInfo && feeAta !== ownerAta ? await rent(size) : 0n)
      const ixs = [createAtaIdempotent({ payer: gas.address, owner, mint: a.info.mint, tokenProgram: a.program })]
      if (fee) ixs.push(createAtaIdempotent({ payer: gas.address, owner: cfg.feeWallet, mint: a.info.mint, tokenProgram: a.program }))
      // The memo goes right before the owner's transfer, where a token account that requires memos looks for it.
      ixs.push(memo(claimMemo(ctx.domain)), transferChecked({ source: a.address, mint: a.info.mint, destination: ownerAta, owner: vault, amount: amount - fee, decimals, tokenProgram: a.program }))
      if (fee) ixs.push(transferChecked({ source: a.address, mint: a.info.mint, destination: feeAta, owner: vault, amount: fee, decimals, tokenProgram: a.program }))
      if (close) ixs.push(closeAccount({ account: a.address, destination: gas.address, owner: vault, tokenProgram: a.program }))
      return { instructions: ixs, signers: [ctx.vault], rent: rentNeed }
    })
    return r && { mint: a.info.mint, amount: str(amount - fee), fee: str(fee), decimals, program: a.program, signature: r.signature }
  }

  async function closeEmpty(ctx, empties) {
    for (let i = 0; i < empties.length; i += 6) {
      const batch = empties.slice(i, i + 6)
      await step(ctx, 'close empty token accounts', async () => ({
        instructions: [memo(claimMemo(ctx.domain)), ...batch.map(a => closeAccount({ account: a.address, destination: gas.address, owner: ctx.vault.address, tokenProgram: a.program }))],
        signers: [ctx.vault],
      }))
    }
  }

  async function paySol(ctx, owner) {
    const vault = ctx.vault.address
    const r = await step(ctx, 'pay SOL', async () => {
      const natives = (await ctx.tokenAccounts(vault)).filter(a => a.info.isNative && a.program === TOKEN)
      let base = await ctx.balance(vault)
      let reserves = 0n
      for (const n of natives) {
        const reserve = BigInt(n.info.rentExemptReserve?.amount ?? await rent(TOKEN_ACCOUNT_SIZE))
        base += n.lamports - reserve
        reserves += reserve
      }
      if (!base && !natives.length) return null
      const fee = feeOf(base, cfg.feeBps)
      const amount = base - fee
      const floor = await rent(0)
      const ixs = []
      // WSOL the vault holds is unwrapped into the payout; the account's rent reserve goes to the gas wallet.
      for (const n of natives) ixs.push(closeAccount({ account: n.address, destination: vault, owner: vault }))
      if (reserves) ixs.push(systemTransfer(vault, gas.address, reserves))
      // A new account must start at the rent minimum: the gas wallet adds what a small payout or fee lacks.
      const [ownerLamports, feeLamports] = await Promise.all([ctx.balance(owner), ctx.balance(cfg.feeWallet)])
      let lent = 0n
      if (amount > 0n && ownerLamports === 0n && amount < floor) { ixs.push(systemTransfer(gas.address, owner, floor - amount)); lent += floor - amount }
      if (fee > 0n && feeLamports === 0n && fee < floor && cfg.feeWallet !== owner) { ixs.push(systemTransfer(gas.address, cfg.feeWallet, floor - fee)); lent += floor - fee }
      ixs.push(memo(claimMemo(ctx.domain)))
      if (amount > 0n) ixs.push(systemTransfer(vault, owner, amount))
      if (fee > 0n) ixs.push(systemTransfer(vault, cfg.feeWallet, fee))
      return {
        instructions: ixs, signers: [ctx.vault], rent: lent, watch: [vault], amount, fee,
        check: ([v]) => { if (v.lamports !== 0n) throw new TxError(`the vault would keep ${v.lamports} lamports`) },
      }
    })
    return r && (r.plan.amount || r.plan.fee) ? { mint: 'SOL', amount: str(r.plan.amount), fee: str(r.plan.fee), decimals: 9, program: SYSTEM, signature: r.signature } : null
  }

  const reasonOf = err => (err.refusal ? err.reason : err.tx ? `The transaction did not go through (${err.message}).` : err.code === 'UNREACHABLE' ? 'Solana RPC is unreachable right now.' : err.rpc ? `Solana RPC refused it (${err.message}).` : 'Something went wrong.')
  const unexpected = err => { if (!err.refusal && !err.tx && !err.rpc && err.code !== 'UNREACHABLE') log(`vault worker error: ${err.stack || err.message}`) }

  async function claim(input) {
    needReady()
    const domain = canonicalDomain(input)
    return withLock(domain, async () => {
      const ctx = context(domain)
      const vault = ctx.vault.address
      const owner = await dnsWallet(domain)
      const problem = recipientProblem(owner, await ctx.account(owner), { vault })
      if (problem) throw new Refusal(422, 'Bad SOL record', problem)

      const result = { domain, wallet: owner, vault, collected: [], payouts: [], signatures: ctx.signatures }
      const notes = [] // what this claim left for later, and why
      const failures = [] // payouts that failed
      let gasErr = null
      const attempt = async (mint, fn) => {
        try { const p = await fn(); if (p) result.payouts.push(p) } catch (err) {
          if (err.refusal && err.status === 503) { gasErr = err; return }
          unexpected(err)
          log(`claim (${domain}): ${mint || 'collect'} failed: ${err.message}`)
          failures.push({ mint, reason: reasonOf(err) })
        }
      }

      try {
        const c = await collectInto(ctx)
        result.collected = collectedJson(c.collected)
        if (c.pending) notes.push({ mint: 'SOL', reason: `${c.pending} lamports of pump.fun creator fees wait until they reach the rent minimum.` })
      } catch (err) {
        if (err.refusal && err.status === 503) throw err
        unexpected(err)
        log(`claim (${domain}): collect skipped: ${err.message}`)
        notes.push({ mint: null, reason: `pump.fun creator fees were not collected: ${reasonOf(err)}` })
      }

      // SPL Token's wrapped SOL is unwrapped into the SOL payout (paySol); everything else is paid as a token.
      const tokens = (await ctx.tokenAccounts(vault)).filter(a => !(a.info.isNative && a.program === TOKEN))
      const full = tokens.filter(a => BigInt(a.info.tokenAmount.amount) > 0n)
      const empty = tokens.filter(a => BigInt(a.info.tokenAmount.amount) === 0n && !withheldFees(a.info))
      // USDC first, then the largest balances, at most MAX_TOKENS_PER_CLAIM per claim (the rest wait for the next).
      full.sort((x, y) => (y.info.mint === cfg.usdcMint) - (x.info.mint === cfg.usdcMint) || (BigInt(y.info.tokenAmount.amount) > BigInt(x.info.tokenAmount.amount) ? 1 : -1))
      for (const [i, a] of full.entries()) {
        if (gasErr) break
        if (i >= cfg.maxTokens) { notes.push({ mint: a.info.mint, reason: 'More tokens than one claim pays; claim again for the rest.' }); continue }
        if (a.info.state === 'frozen') { failures.push({ mint: a.info.mint, reason: 'The token\'s issuer has frozen it in the vault.' }); continue }
        await attempt(a.info.mint, () => payToken(ctx, a, owner))
      }
      if (!gasErr) await attempt('SOL', () => paySol(ctx, owner))
      if (!gasErr && result.payouts.length && empty.length) await attempt(null, () => closeEmpty(ctx, empty))

      if (!result.payouts.length) {
        if (gasErr) throw gasErr
        if (failures.length) throw new Refusal(502, 'Claim failed', failures[0].reason)
        const why = notes.find(n => n.mint === null || n.mint === 'SOL')
        throw new Refusal(409, 'Nothing to claim', `The vault of ${domain} holds nothing to pay out right now.${why ? ` ${why.reason}` : ''}`)
      }
      const skipped = [...failures, ...notes, ...(gasErr ? [{ mint: null, reason: gasErr.reason }] : [])]
      if (skipped.length) result.skipped = skipped
      log(`claim (${domain}): ${result.payouts.length} payout(s) to ${owner}, ${ctx.signatures.length} transaction(s)`)
      return result
    })
  }

  async function collect(input) {
    needReady()
    const domain = canonicalDomain(input)
    return withLock(domain, async () => {
      const ctx = context(domain)
      try {
        const c = await collectInto(ctx)
        return { domain, vault: ctx.vault.address, collected: collectedJson(c.collected), signatures: ctx.signatures, ...(c.pending ? { pending: str(c.pending) } : {}) }
      } catch (err) {
        if (err.refusal) throw err
        unexpected(err)
        if (err.rpc && /getProgramAccounts/.test(err.message)) throw new Refusal(502, 'Collect failed', 'The Solana RPC this server uses can\'t list pump.fun coins (getProgramAccounts). Set SOLANA_RPC_URL to a provider that allows it.')
        throw new Refusal(502, 'Collect failed', reasonOf(err))
      }
    })
  }

  // ---------- refund ----------

  /** Whether the vault has signed a claim of this domain, or a refund of this deposit, since the deposit. */
  async function laterMemos(ctx, deposit, depositSig) {
    const vault = ctx.vault.address
    const texts = { claim: claimMemo(ctx.domain), refund: refundMemo(depositSig) }
    const candidates = []
    let before
    scan: for (let page = 0; ; page++) {
      if (page === HISTORY_PAGES) throw new Refusal(503, 'History too long', 'This vault has too much history since that deposit to check automatically.')
      const list = await rpc('getSignaturesForAddress', [vault, { limit: 1000, commitment: 'confirmed', ...(before ? { before } : {}) }])
      for (const e of list) {
        // Newest first. A transaction in the deposit's own slot counts as later: a claim there may have paid it out.
        if (e.slot < deposit.slot) break scan
        if (e.err || e.signature === depositSig) continue
        // An RPC without the memo field gets every transaction checked.
        if (e.memo === undefined || (e.memo && (e.memo.includes(texts.claim) || e.memo.includes(texts.refund)))) candidates.push(e.signature)
      }
      if (list.length < 1000) break
      before = list.at(-1).signature
    }
    if (candidates.length > MAX_HISTORY_READS) throw new Refusal(503, 'History too long', 'This vault has too much history since that deposit to check automatically.')
    // Anyone can write a memo; only a transaction the vault signed counts.
    const found = { claim: false, refund: false }
    for (const sig of candidates) {
      const tx = await rpc('getTransaction', [sig, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }])
      if (vaultSignedWithMemo(tx, vault, texts.claim)) found.claim = true
      if (vaultSignedWithMemo(tx, vault, texts.refund)) found.refund = true
    }
    return found
  }

  async function refund(input, signatureInput) {
    needReady()
    const domain = canonicalDomain(input)
    const depositSig = parseSignature(signatureInput)
    return withLock(domain, async () => {
      const ctx = context(domain)
      const vault = ctx.vault.address
      // per domain: one transaction can fund several vaults (the app's Many domains), each refunded on its own
      const key = `${domain} ${depositSig}`
      for (const [k, at] of refunding) if (now() - at > 3_600_000) refunding.delete(k)
      if (refunding.has(key)) throw new Refusal(422, 'Already refunded', 'That deposit was already refunded.')
      const tx = await rpc('getTransaction', [depositSig, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }])
      if (!tx) throw new Refusal(404, 'Deposit not found', 'No confirmed transaction with that signature. If you just sent it, wait a moment.')
      const dep = depositOf(tx, vault)
      if (!dep.blockTime) throw new Refusal(503, 'Try again', 'The time of that deposit is not known yet. Try again in a minute.')
      const refundableAt = dep.blockTime + Math.round(cfg.refundDelayDays * DAY)
      if (Math.floor(now() / 1000) < refundableAt) {
        throw new Refusal(422, 'Too early', `Deposits can be refunded ${cfg.refundDelayDays} days after they were sent, if the domain has not claimed them. This one can be refunded from ${new Date(refundableAt * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC.`)
      }
      ctx.minSlot = dep.slot
      const later = await laterMemos(ctx, dep, depositSig)
      if (later.refund) throw new Refusal(422, 'Already refunded', 'That deposit was already refunded.')
      if (later.claim) throw new Refusal(422, 'Already claimed', `${domain} has been claimed since that deposit, so it went to the domain's owner.`)

      let instructions
      let rentNeed = 0n
      if (dep.mint === 'SOL') {
        const have = await ctx.balance(vault)
        const floor = await rent(0)
        if (have < dep.amount) throw new Refusal(422, 'Not in the vault', 'The vault holds less SOL than that deposit.')
        if (have - dep.amount > 0n && have - dep.amount < floor) throw new Refusal(422, 'Can\'t refund', 'Refunding that deposit would leave the vault below the rent minimum.')
        if (dep.amount < floor && (await ctx.balance(dep.from)) === 0n) throw new Refusal(422, 'Can\'t refund', 'The sender\'s account no longer exists and the deposit is below the minimum a new account needs.')
        instructions = [memo(refundMemo(depositSig)), systemTransfer(vault, dep.from, dep.amount)]
      } else {
        const acc = await ctx.account(dep.account, 'jsonParsed')
        const info = acc && acc.data && acc.data.parsed && acc.data.parsed.info
        if (!info || info.owner !== vault || info.mint !== dep.mint) throw new Refusal(422, 'Not in the vault', 'The vault no longer holds that token.')
        if (info.state === 'frozen') throw new Refusal(422, 'Can\'t refund', 'The token\'s issuer has frozen it in the vault.')
        const have = BigInt(info.tokenAmount.amount)
        if (have < dep.amount) throw new Refusal(422, 'Not in the vault', 'The vault holds less of that token than the deposit.')
        const to = ata(dep.from, dep.mint, dep.program)
        const closes = have === dep.amount && !withheldFees(info)
        if (!(await ctx.account(to))) {
          // The gas wallet opens the sender's token account only when the refund closes the vault's (its rent comes
          // back); otherwise dust deposits could be farmed for that rent.
          if (!closes) throw new Refusal(422, 'Open a token account', `Your wallet has no account for this token any more. Add the token in your wallet (or receive any amount of it), then ask again.`)
          rentNeed = await rent(dep.program === TOKEN ? TOKEN_ACCOUNT_SIZE : TOKEN_2022_ACCOUNT_ESTIMATE)
        }
        instructions = [
          createAtaIdempotent({ payer: gas.address, owner: dep.from, mint: dep.mint, tokenProgram: dep.program }),
          memo(refundMemo(depositSig)),
          transferChecked({ source: dep.account, mint: dep.mint, destination: to, owner: vault, amount: dep.amount, decimals: dep.decimals, tokenProgram: dep.program }),
          ...(closes ? [closeAccount({ account: dep.account, destination: gas.address, owner: vault, tokenProgram: dep.program })] : []),
        ]
      }
      refunding.set(key, now())
      let r
      try {
        r = await step(ctx, 'refund', async attempt => (attempt && (await laterMemos(ctx, dep, depositSig)).refund ? null : { instructions, signers: [ctx.vault], rent: rentNeed }))
      } catch (err) {
        // Only a refused, failed or expired transaction frees the deposit for another try: it can no longer land.
        if (err.tx || err.refusal) refunding.delete(key)
        unexpected(err)
        throw err.refusal ? err : new Refusal(502, 'Refund failed', reasonOf(err))
      }
      if (!r) throw new Refusal(422, 'Already refunded', 'That deposit was already refunded.')
      log(`refund (${domain}): ${dep.amount} ${dep.mint} to ${dep.from} for ${depositSig}`)
      return { domain, refunded: { mint: dep.mint, amount: str(dep.amount), decimals: dep.decimals, to: dep.from }, signature: r.signature }
    })
  }

  // ---------- reads ----------

  function vault(input) {
    needMaster()
    const domain = canonicalDomain(input)
    const v = vaultKeypair(cfg.master, domain).address
    return { domain, vault: v, usdcAccount: ata(v, cfg.usdcMint, TOKEN) }
  }

  let statusCache = null
  async function status() {
    const base = { ready, gasWallet: gas ? gas.address : null, gasLamports: null, feeWallet: cfg.feeWallet, feeBps: cfg.feeBps, refundDelayDays: cfg.refundDelayDays }
    if (!gas) return base
    if (statusCache && now() - statusCache.at < 15_000) return { ...base, gasLamports: statusCache.lamports }
    try {
      const lamports = str(lamportsOf((await rpc('getBalance', [gas.address, { commitment: 'confirmed' }])).value))
      statusCache = { lamports, at: now() }
      return { ...base, gasLamports: lamports }
    } catch { return base }
  }

  // problems names what is missing or malformed, never a value.
  return { ready, problems: cfg.problems, vault, status, claim, collect, refund }
}
