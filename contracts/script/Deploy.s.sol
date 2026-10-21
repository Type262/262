// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {DNSSECImpl} from "@ens/dnssec-oracle/DNSSECImpl.sol";
import {DnssecVerifier} from "../src/DnssecVerifier.sol";
import {DomainEscrow} from "../src/DomainEscrow.sol";
import {DomainLauncher} from "../src/DomainLauncher.sol";
import {IPonsFactory} from "../src/pons/IPons.sol";
import {Oracle} from "./Oracle.sol";

/// Deploys the DNSSEC oracle (ENS, root-anchored, ownership renounced), the DnssecVerifier, the DomainEscrow
/// and the DomainLauncher (pons v2 launches whose creator fees go to a domain).
/// Use script/deploy-robinhood.sh, which runs the checks first.
/// Required: OWNER (escrow admin: can pause new deposits, nothing else).
/// Optional: FEE_RECIPIENT (default OWNER), FEE_BPS (50 = 0.5%, max 100), REFUND_DELAY (180 days),
/// PONS_FACTORY (pons v2 on Robinhood Chain).
contract Deploy is Script {
    address constant PONS_V2 = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;

    function run() external returns (DNSSECImpl oracle, DnssecVerifier verifier, DomainEscrow escrow, DomainLauncher launcher) {
        address admin = vm.envAddress("OWNER");

        vm.startBroadcast();
        oracle = Oracle.deploy();
        verifier = new DnssecVerifier(oracle);
        escrow = new DomainEscrow(
            verifier,
            uint64(vm.envOr("REFUND_DELAY", uint256(180 days))),
            uint16(vm.envOr("FEE_BPS", uint256(50))),
            vm.envOr("FEE_RECIPIENT", admin),
            admin
        );
        launcher = new DomainLauncher(IPonsFactory(vm.envOr("PONS_FACTORY", PONS_V2)), escrow);
        vm.stopBroadcast();

        console2.log("DNSSECImpl     ", address(oracle));
        console2.log("DnssecVerifier ", address(verifier));
        console2.log("DomainEscrow   ", address(escrow));
        console2.log("DomainLauncher ", address(launcher));
    }
}
