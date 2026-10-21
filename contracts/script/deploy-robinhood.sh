#!/usr/bin/env bash
# Deploy TYPE/262 to Robinhood Chain mainnet: ENS's DNSSEC oracle (root-anchored, ownership renounced),
# the DnssecVerifier, the DomainEscrow and the DomainLauncher. Checks: network -> wallet + balance -> tests -> dry run with
# real cost -> typed confirmation -> broadcast -> save addresses -> verify source on Blockscout.
# Signs with a deployer env file if there is one (DEPLOYER_ENV, default ~/.type262/deployer.env, holding DEPLOYER and
# DEPLOYER_PRIVATE_KEY), otherwise with Foundry's encrypted keystore (ACCOUNT, default "deployer"). The key is never printed.
# Optional: CONFIRM=DEPLOY skips the prompt; SWEEP_TO=0x... sends the deployer's leftover ETH there at the end.
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
cd "$(dirname "$0")/.."

RPC=${RPC:-https://rpc.mainnet.chain.robinhood.com}
# Sourcify verifies Robinhood Chain and Blockscout shows its results (Blockscout's own API sits behind a bot check).
VERIFIER=${VERIFIER:-sourcify}
VERIFY_URL=${VERIFY_URL:-https://robinhoodchain.blockscout.com/api/}
ACCOUNT=${ACCOUNT:-deployer}
DEPLOYER_ENV=${DEPLOYER_ENV:-$HOME/.type262/deployer.env}
step() { printf '\n\033[1;32m> %s\033[0m\n' "$1"; }
die() { printf '\033[1;31mx %s\033[0m\n' "$1"; exit 1; }

if [ -f "$DEPLOYER_ENV" ]; then
  # Read the two values without executing the file or exporting the key to child processes.
  envval() { sed -n "s/^$1=//p" "$DEPLOYER_ENV" | tail -n 1 | tr -d '\r" '; }
  DEPLOYER=$(envval DEPLOYER)
  DEPLOYER_PRIVATE_KEY=$(envval DEPLOYER_PRIVATE_KEY)
  [ "$(cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY")" = "$(cast to-check-sum-address "$DEPLOYER")" ] \
    || die "$DEPLOYER_ENV: the key doesn't match DEPLOYER"
  SIGNER=(--private-key "$DEPLOYER_PRIVATE_KEY")
  echo "Signing with the key in $DEPLOYER_ENV"
else
  [ -f "$HOME/.foundry/keystores/$ACCOUNT" ] || die "No deployer env file and no keystore named '$ACCOUNT'. Create a keystore once (the key is stored encrypted on this machine):
    cast wallet import $ACCOUNT --interactive"
  SIGNER=(--account "$ACCOUNT")
fi
# Your address: set DEPLOYER=0x... to skip this, otherwise Foundry asks for the keystore password once here.
DEPLOYER=$(cast to-check-sum-address "${DEPLOYER:-$(cast wallet address --account "$ACCOUNT")}")
export OWNER=${OWNER:-$DEPLOYER}
export FEE_RECIPIENT=${FEE_RECIPIENT:-$OWNER}

step "1/6 Network"
CHAIN=$(cast chain-id --rpc-url "$RPC")
[ "$CHAIN" = "4663" ] || die "RPC answered chain $CHAIN, expected Robinhood Chain (4663)"
echo "Robinhood Chain mainnet (4663) via $RPC"

step "2/6 Wallet and settings"
BAL=$(cast balance "$DEPLOYER" --rpc-url "$RPC" --ether)
MIN_ETH=${MIN_ETH:-0.001}
node -e "process.exit(Number(process.argv[1]) >= Number(process.argv[2]) ? 0 : 1)" "$BAL" "$MIN_ETH" \
  || die "Deployer has $BAL ETH. Send at least $MIN_ETH ETH to $DEPLOYER on Robinhood Chain (4663)."
cat <<INFO
deployer     $DEPLOYER   ($BAL ETH)
admin        $OWNER   (can pause new deposits; nothing else)
fees to      $FEE_RECIPIENT   (${FEE_BPS:-50} bps of each claim)
refunds      after ${REFUND_DELAY:-15552000}s if nobody claims
claims       instant, with a DNSSEC proof checked on-chain (no attestor)
launches     pons v2 factory ${PONS_FACTORY:-0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e}
INFO

step "3/6 Tests"
forge test --fuzz-runs 1000 | tail -n 2

step "4/6 Dry run against mainnet (nothing is sent)"
forge script script/Deploy.s.sol --rpc-url "$RPC" --sender "$DEPLOYER" | grep -E "Estimated|DNSSECImpl|DnssecVerifier|DomainEscrow|DomainLauncher" || true

step "5/6 Deploy"
[ ! -f ../deployments/robinhood-4663.json ] || die "deployments/robinhood-4663.json exists: this was already deployed. Move that file away only if you really want a second, separate deployment."
ANSWER=${CONFIRM:-}
[ -n "$ANSWER" ] || read -r -p "Type DEPLOY to send these transactions to Robinhood Chain mainnet: " ANSWER
[ "$ANSWER" = "DEPLOY" ] || die "Aborted. Nothing was sent."
forge script script/Deploy.s.sol --rpc-url "$RPC" "${SIGNER[@]}" --sender "$DEPLOYER" --broadcast --slow

mkdir -p ../deployments
node script/save-deployment.mjs "broadcast/Deploy.s.sol/4663/run-latest.json" > ../deployments/robinhood-4663.json
node -e "const d=require('../deployments/robinhood-4663.json');for(const [k,v] of Object.entries(d.contracts))console.log(k.padEnd(20),v)"
echo "Saved to deployments/robinhood-4663.json"

step "6/6 Verify source ($VERIFIER)"
ok=1
c() { node -e "process.stdout.write(require('../deployments/robinhood-4663.json').contracts[process.argv[1]])" "$1"; }
verify() {
  if [ "$VERIFIER" = blockscout ]; then
    forge verify-contract "$(c "$1")" "$2" --chain-id 4663 --verifier blockscout --verifier-url "$VERIFY_URL" ${3:+--constructor-args "$3"} --watch || ok=0
  else
    forge verify-contract "$(c "$1")" "$2" --chain-id 4663 --verifier sourcify ${3:+--constructor-args "$3"} || ok=0
  fi
}
O=lib/ens-contracts/contracts/dnssec-oracle
ANCHORS=$(env -u ETH_PASSWORD cast call "$(c DNSSECImpl)" "anchors()(bytes)" --rpc-url "$RPC")
verify DNSSECImpl "$O/DNSSECImpl.sol:DNSSECImpl" "$(cast abi-encode "constructor(bytes)" "$ANCHORS")"
verify RSASHA1Algorithm "$O/algorithms/RSASHA1Algorithm.sol:RSASHA1Algorithm"
verify RSASHA256Algorithm "$O/algorithms/RSASHA256Algorithm.sol:RSASHA256Algorithm"
verify P256SHA256Algorithm "$O/algorithms/P256SHA256Algorithm.sol:P256SHA256Algorithm"
verify SHA1Digest "$O/digests/SHA1Digest.sol:SHA1Digest"
verify SHA256Digest "$O/digests/SHA256Digest.sol:SHA256Digest"
verify DnssecVerifier src/DnssecVerifier.sol:DnssecVerifier "$(cast abi-encode "constructor(address)" "$(c DNSSECImpl)")"
verify DomainEscrow src/DomainEscrow.sol:DomainEscrow "$(cast abi-encode "constructor(address,uint64,uint16,address,address)" "$(c DnssecVerifier)" "${REFUND_DELAY:-15552000}" "${FEE_BPS:-50}" "$FEE_RECIPIENT" "$OWNER")"
verify DomainLauncher src/DomainLauncher.sol:DomainLauncher "$(cast abi-encode "constructor(address,address)" "${PONS_FACTORY:-0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e}" "$(c DomainEscrow)")"
[ $ok = 1 ] || echo "Some verifications didn't finish. The contracts are deployed; verify by hand later (see DEPLOY.md)."

if [ -n "${SWEEP_TO:-}" ]; then
  step "Return leftover ETH to $SWEEP_TO"
  LEFT=$(cast balance "$DEPLOYER" --rpc-url "$RPC")
  PRICE=$(cast gas-price --rpc-url "$RPC")
  GAS=$(cast estimate "$SWEEP_TO" --value 1 --from "$DEPLOYER" --rpc-url "$RPC")
  # Keep 3x the transfer's estimated cost for gas; send the rest.
  SEND=$(node -e "const v=BigInt(process.argv[1])-BigInt(process.argv[2])*BigInt(process.argv[3])*3n;console.log(v>0n?v.toString():'0')" "$LEFT" "$GAS" "$PRICE")
  if [ "$SEND" != "0" ]; then
    cast send "$SWEEP_TO" --value "$SEND" "${SIGNER[@]}" --rpc-url "$RPC" >/dev/null && echo "Sent $(cast from-wei "$SEND") ETH back to $SWEEP_TO"
  else
    echo "Nothing worth sending back."
  fi
fi

printf '\n\033[1;32mDone.\033[0m Next: from the repo root run  node scripts/post-deploy.mjs\n'
