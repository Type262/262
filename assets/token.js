// The TYPE/262 token: a pump.fun coin on Solana, shown in the app's header and at the top of Launch → Explore.
export const TOKEN = {
  mint: 'BjVsSDQoNbxswtPLtpAr5QXZTEXQsfEQTAz7A7iipump',
  name: 'TYPE262',
  symbol: '262',
  logo: new URL('./art/token-262.webp', import.meta.url).href, // served with the app, next to this module
  dev: '9QKi39EkFTM1x64TPG3H4mcMDkG85oWUttPdvzNjtvJP',
  domain: 'type262.com', // lists the mint in _token.type262.com (token-records.js)
}
