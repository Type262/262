// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DomainEscrow} from "../src/DomainEscrow.sol";
import {DomainFeeForwarder} from "../src/DomainFeeForwarder.sol";
import {IPonsCurve, IPonsFeeEscrow, IPonsHook} from "../src/pons/IPons.sol";
import {MockVerifier} from "./DomainEscrow.t.sol";

/// pons fee escrow holding `owed` ETH for whoever asks; claim() pays it out.
contract MockPonsEscrow {
    uint256 public owed;

    function setOwed(uint256 a) external payable { owed = a; }
    function balanceOf(address) external view returns (uint256) { return owed; }
    function balanceOfToken(address, address) external pure returns (uint256) { return 0; }
    function claim() external {
        uint256 a = owed;
        owed = 0;
        (bool ok,) = msg.sender.call{value: a}("");
        require(ok);
    }
    function claimToken(address) external {}
}

/// Records who swept which pool, like pons's v4 hook checking the fee recipient.
contract MockHook {
    address public caller;
    bytes32 public pool;

    function sweepPoolFees(bytes32 id, uint256, uint256) external {
        caller = msg.sender;
        pool = id;
    }
}

contract RevertingSweeper {
    function sweepPoolFees(bytes32, uint256, uint256) external pure { revert("not yet"); }
    function sweepFees(uint256) external pure { revert("not yet"); }
}

contract DomainFeeForwarderTest is Test {
    string constant D = "yoursite.com";
    DomainEscrow escrow;
    MockPonsEscrow pons;
    DomainFeeForwarder fwd;

    function setUp() public {
        escrow = new DomainEscrow(new MockVerifier(), 180 days, 50, makeAddr("fee"), makeAddr("admin"));
        pons = new MockPonsEscrow();
        fwd = new DomainFeeForwarder(D, escrow, IPonsFeeEscrow(address(pons)));
    }

    function test_collectPoolsSweepsAsTheFeeRecipientThenFlushes() public {
        pons.setOwed{value: 1 ether}(1 ether);
        MockHook hook = new MockHook();
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = keccak256("pool");
        fwd.collectPools(IPonsHook(address(hook)), ids, new address[](0));
        assertEq(hook.caller(), address(fwd), "the forwarder itself sweeps, so pons sees the fee recipient");
        assertEq(hook.pool(), ids[0]);
        assertEq(escrow.balanceOf(D, address(0)), 1 ether, "then everything owed lands in escrow for the domain");
        assertEq(address(fwd).balance, 0);
    }

    function test_sweepsThatFailAreSkipped() public {
        pons.setOwed{value: 0.5 ether}(0.5 ether);
        RevertingSweeper bad = new RevertingSweeper();
        bytes32[] memory ids = new bytes32[](2);
        fwd.collectPools(IPonsHook(address(bad)), ids, new address[](0));
        IPonsCurve[] memory curves = new IPonsCurve[](1);
        curves[0] = IPonsCurve(address(bad));
        fwd.collect(curves, new address[](0));
        assertEq(escrow.balanceOf(D, address(0)), 0.5 ether);
    }

    function test_rejectsNonCanonicalDomain() public {
        vm.expectRevert(DomainEscrow.BadDomain.selector);
        new DomainFeeForwarder("YourSite.com", escrow, IPonsFeeEscrow(address(pons)));
    }
}
