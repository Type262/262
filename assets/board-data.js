// The Unclaimed Board across both networks: Solana first (solana-board.js), and Robinhood Chain escrow and pons
// launches too (chain-data.js). One entry per domain, with dollars waiting on each chain, and one activity feed.
// Either chain can fail to read on its own; the other still shows, and `errors` says which one is missing. A refresh
// that fails on one chain keeps that chain's last good read, so its domains don't drop off the board for a pass.
import * as S from './solana-board.js'
import * as R from './chain-data.js'

const ZERO = R.ZERO
const MAX_RH_TIMES = 50 // Robinhood Chain events given a time, newest first; the feed shows 14
const rhUsd = (token, amount, ethPrice) => (token === ZERO ? (Number(amount) / 1e18) * ethPrice : Number(amount) / 1e6)
const last = { solana: null, robinhood: null } // each chain's last good read on this page
// Test domains from building the board: their deposits stay on chain, and the board and landing page leave them out.
const HIDDEN = new Set(['gemprotocol.io', 'gempprotocol.io'])
const shown = e => !HIDDEN.has(e.domain)
const hide = c => ({
  ...c,
  list: c.list.filter(shown),
  activity: Array.isArray(c.activity) ? c.activity.filter(shown) : Object.fromEntries(Object.entries(c.activity).map(([k, v]) => [k, Array.isArray(v) ? v.filter(shown) : v])),
})

/**
 * { list: [{ domain, usd, sol, rh, supporters, launches, claims, first, last }] sorted by dollars waiting,
 *   activity: [{ chain, kind, domain, time, … }] newest first, totals: { usd, sites, supporters, claimed },
 *   prices: { sol, eth }, errors: { solana, robinhood } }. `sol` and `rh` are each chain's own entry, or null.
 *   A chain is in `errors` only while it has never been read on this page.
 */
export async function boardData() {
  const [s, r] = await Promise.allSettled([S.solanaDomains(), R.domains()])
  if (s.status === 'fulfilled') last.solana = s.value
  if (r.status === 'fulfilled') last.robinhood = r.value
  if (!last.solana && !last.robinhood) throw s.reason
  const sol = hide(last.solana || { list: [], activity: [], price: 0 })
  const rh = hide(last.robinhood || { list: [], activity: { deposits: [], claims: [], refunds: [], launches: [] }, price: 0 })
  const errors = { solana: last.solana ? null : s.reason, robinhood: last.robinhood ? null : r.reason }

  // Robinhood Chain counts in blocks: turn the ones shown into times. Only the newest events need one (older ones can't
  // make the feed), and each domain's first and last for sorting; every block since the deployment would grow forever.
  const a = rh.activity
  const rhEvents = [...a.deposits, ...a.claims, ...a.refunds, ...a.launches]
  const newest = [...rhEvents].sort((x, y) => y.block - x.block).slice(0, MAX_RH_TIMES)
  const blocks = [...newest.map(e => e.block), ...rh.list.flatMap(x => [x.first, x.last])].filter(b => Number.isFinite(b) && b > 0)
  const times = blocks.length ? await R.blockTimes(blocks).catch(() => new Map()) : new Map()
  const at = b => times.get(b) || 0

  const by = new Map()
  const get = d => by.get(d) || by.set(d, { domain: d, usd: 0, sol: null, rh: null, supporters: 0, launches: 0, claims: 0, first: Infinity, last: 0 }).get(d)
  for (const x of sol.list) {
    const e = get(x.domain)
    e.sol = x; e.usd += x.usd; e.supporters += x.supporters.size; e.launches += x.launches; e.claims += x.claims
    e.first = Math.min(e.first, x.first || Infinity); e.last = Math.max(e.last, x.last || 0)
  }
  for (const x of rh.list) {
    const e = get(x.domain)
    e.rh = x; e.usd += x.usd; e.supporters += x.supporters; e.launches += x.launches; e.claims += x.claims
    e.first = Math.min(e.first, at(x.first) || Infinity); e.last = Math.max(e.last, at(x.last))
  }
  const list = [...by.values()].map(e => ({ ...e, first: Number.isFinite(e.first) ? e.first : e.last }))
  list.sort((x, y) => y.usd - x.usd || y.last - x.last)

  const activity = [
    ...sol.activity,
    ...rhEvents.map(e => ({ ...e, chain: 'robinhood', time: at(e.block) })),
  ].sort((x, y) => (y.time || 0) - (x.time || 0))

  const supporters = new Set([
    ...sol.activity.filter(e => e.kind === 'deposit').map(e => e.from),
    ...a.deposits.map(e => e.from.toLowerCase()),
  ]).size
  const claimed = sol.activity.filter(e => e.kind === 'claim').reduce((n, e) => n + S.usdOf(e.paid, sol.price), 0)
    + a.claims.reduce((n, e) => n + rhUsd(e.token, e.amount + e.fee, rh.price), 0)
  const totals = { usd: list.reduce((n, e) => n + e.usd, 0), sites: list.filter(e => e.usd > 0).length, supporters, claimed }
  return { list, activity, totals, prices: { sol: sol.price, eth: rh.price }, errors }
}

export { rhUsd }
