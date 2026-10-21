// Minimal ABI encoder/decoder for the calls the app makes: string, bytes, bytes32, address, uint, bool,
// arrays of static types, and tuples (written as nested arrays of types, e.g. ['string', ['address', 'uint16']]).
const pad = h => h.padStart(64, '0')
const padRight = h => h.padEnd(Math.ceil(h.length / 64) * 64, '0')
const utf8Hex = s => Array.from(new TextEncoder().encode(s), b => b.toString(16).padStart(2, '0')).join('')
const isDynamic = t => Array.isArray(t) ? t.some(isDynamic) : t === 'string' || t === 'bytes' || t.endsWith('[]')
const headSize = t => Array.isArray(t) && !isDynamic(t) ? t.reduce((n, x) => n + headSize(x), 0) : 32

function word(type, v) {
  if (type === 'address') return pad(v.replace(/^0x/, '').toLowerCase())
  if (type.startsWith('uint')) return pad(BigInt(v).toString(16))
  if (type === 'bool') return pad(v ? '1' : '0')
  if (type === 'bytes32') return v.replace(/^0x/, '').padEnd(64, '0')
  throw new Error(`Unsupported type ${type}`)
}

function tail(type, v) {
  if (type === 'string' || type === 'bytes') {
    const hex = type === 'string' ? utf8Hex(v) : v.replace(/^0x/, '')
    return pad((hex.length / 2).toString(16)) + (hex ? padRight(hex) : '')
  }
  if (type.endsWith('[]')) return pad(v.length.toString(16)) + v.map(x => word(type.slice(0, -2), x)).join('')
  throw new Error(`Unsupported type ${type}`)
}

function encodeTuple(types, values) {
  let offset = types.reduce((n, t) => n + headSize(t), 0)
  const heads = []
  const tails = []
  types.forEach((t, i) => {
    if (!isDynamic(t)) return heads.push(Array.isArray(t) ? encodeTuple(t, values[i]) : word(t, values[i]))
    const tl = Array.isArray(t) ? encodeTuple(t, values[i]) : tail(t, values[i])
    heads.push(pad(offset.toString(16)))
    tails.push(tl)
    offset += tl.length / 2
  })
  return heads.join('') + tails.join('')
}

export const encodeCall = (selector, types, values) => selector + encodeTuple(types, values)

// abi.encode((bytes rrset, bytes sig)[]): the DNSSEC proof format DnssecVerifier decodes.
export function encodeProof(sets) {
  const tuples = sets.map(s => {
    const r = tail('bytes', s.rrset)
    const g = tail('bytes', s.sig)
    return pad((64).toString(16)) + pad((64 + r.length / 2).toString(16)) + r + g
  })
  let offset = 32 * sets.length
  const heads = tuples.map(t => { const h = pad(offset.toString(16)); offset += t.length / 2; return h })
  return '0x' + pad('20') + pad(sets.length.toString(16)) + heads.join('') + tuples.join('')
}

export const words = hex => (hex.replace(/^0x/, '').match(/.{64}/g) || [])
export const toBig = w => BigInt('0x' + w)
export const toAddr = w => '0x' + w.slice(24)

const hexText = h => new TextDecoder().decode(Uint8Array.from(h.match(/../g) || [], b => parseInt(b, 16)))

/** A single returned string (name(), symbol(), logo()…). */
export function decodeString(hex) {
  const h = hex.replace(/^0x/, '')
  if (h.length < 128) return ''
  const at = Number(BigInt('0x' + h.slice(0, 64))) * 2
  const len = Number(BigInt('0x' + h.slice(at, at + 64)))
  return hexText(h.slice(at + 64, at + 64 + len * 2))
}

// DomainLauncher.Launch = (address token, address curve, address launcher, address pairToken, uint64 launchedAt, string domain)
function launchAt(h, e) {
  const at = byte => h.slice(byte * 2, byte * 2 + 64)
  const num = byte => Number(BigInt('0x' + at(byte)))
  const s = e + num(e + 160)
  return {
    token: toAddr(at(e)), curve: toAddr(at(e + 32)), launcher: toAddr(at(e + 64)), pairToken: toAddr(at(e + 96)),
    launchedAt: num(e + 128), domain: hexText(h.slice((s + 32) * 2, (s + 32 + num(s)) * 2)),
  }
}

/** Launch[] from recent() / launchesOf(). */
export function decodeLaunches(hex) {
  const h = hex.replace(/^0x/, '')
  const num = byte => Number(BigInt('0x' + h.slice(byte * 2, byte * 2 + 64)))
  const arr = num(0) + 32
  return Array.from({ length: num(num(0)) }, (_, i) => launchAt(h, arr + num(arr + 32 * i)))
}

/** A single Launch from launchOf(token). */
export function decodeLaunch(hex) {
  const h = hex.replace(/^0x/, '')
  return launchAt(h, Number(BigInt('0x' + h.slice(0, 64))))
}

export const SEL = {
  // DomainEscrow
  deposit: '0xa26e1186',
  depositToken: '0xf4442958',
  claim: '0xf2c33d52',
  refund: '0x71cc805a',
  balanceOf: '0x04031852',
  refundableOf: '0x856a4246',
  depositsPaused: '0x60da3e83',
  // ERC-20
  approve: '0x095ea7b3',
  allowance: '0xdd62ed3e',
  erc20Balance: '0x70a08231',
  name: '0x06fdde03',
  symbol: '0x95d89b41',
  // DomainLauncher
  launch: '0x9971a4b4',
  forwarderOf: '0xc964a052',
  collect: '0x7f24032a',
  recent: '0x8528fb56',
  launchesOf: '0x2bf58bfa', // launchesOf(string,uint256,uint256): newest-first page
  pendingFeeRecipient: '0x9beacf4a', // pons factory pendingCreatorFeeRecipient(address)
  launchOf: '0x029282d7',
  // pons v2
  launchFee: '0xcf3cf573',
  previewLaunchEconomics: '0xf718b78c',
  ponsOwed: '0x70a08231', // feeEscrow.balanceOf(recipient)
  ponsOwedToken: '0xf59e38b7', // feeEscrow.balanceOfToken(recipient, token)
  getReserves: '0x0902f1ac',
  graduated: '0xe7c2b772',
  graduationThreshold: '0x8b0bc501',
  feeBps: '0x24a9d853',
  creatorTaxBps: '0xc1bb8901',
  snipeTaxBps: '0xd7e1ef39',
  buy: '0x59a87bc1',
  sell: '0xd04c6983',
  logo: '0xfb7f21eb',
  description: '0x7284e416',
}
