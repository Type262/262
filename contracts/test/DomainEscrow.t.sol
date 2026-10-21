// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DomainEscrow} from "../src/DomainEscrow.sol";
import {IDomainVerifier} from "../src/IDomainVerifier.sol";

contract MockUSDG {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) { balanceOf[msg.sender] -= a; balanceOf[to] += a; return true; }
    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[to] += a; return true;
    }
}

/// Stands in for the DNSSEC verifier: "domain publishes recipient, signed at t".
contract MockVerifier is IDomainVerifier {
    mapping(bytes32 => uint64) public signedAt;

    function publish(string memory domain, address recipient, uint64 t) external {
        signedAt[keccak256(abi.encode(domain, recipient))] = t;
    }

    function verify(string calldata domain, address recipient, bytes calldata) external view returns (uint64 t) {
        t = signedAt[keccak256(abi.encode(domain, recipient))];
        require(t != 0, "not published");
    }
}

contract Reverter {
    receive() external payable {
        revert();
    }
}

contract DomainEscrowTest is Test {
    DomainEscrow escrow;
    MockVerifier verifier;
    MockUSDG usdg;

    address admin = makeAddr("admin");
    address feeTo = makeAddr("fee");
    address payer = makeAddr("payer");
    address site = makeAddr("site-wallet");
    address hijacker = makeAddr("hijacker");
    string constant D = "yoursite.com";
    uint64 constant REFUND = 180 days;

    function setUp() public {
        vm.warp(1_800_000_000);
        verifier = new MockVerifier();
        usdg = new MockUSDG();
        escrow = new DomainEscrow(verifier, REFUND, 50, feeTo, admin);
        vm.deal(payer, 10 ether);
        usdg.mint(payer, 1_000e6);
        vm.prank(payer);
        usdg.approve(address(escrow), type(uint256).max);
    }

    function _tokens() internal view returns (address[] memory t) {
        t = new address[](2);
        t[0] = address(0);
        t[1] = address(usdg);
    }

    function _depositBoth() internal {
        vm.startPrank(payer);
        escrow.deposit{value: 1 ether}(D);
        escrow.depositToken(D, address(usdg), 100e6);
        vm.stopPrank();
    }

    function test_depositsPoolByDomain() public {
        _depositBoth();
        assertEq(escrow.balanceOf(D, address(0)), 1 ether);
        assertEq(escrow.balanceOf(D, address(usdg)), 100e6);
        (uint256 amt,) = escrow.refundableOf(D, address(usdg), payer);
        assertEq(amt, 100e6);
    }

    function test_rejectsNonCanonicalNames() public {
        vm.startPrank(payer);
        vm.expectRevert(DomainEscrow.BadDomain.selector);
        escrow.deposit{value: 1}("YourSite.com");
        vm.expectRevert(DomainEscrow.BadDomain.selector);
        escrow.deposit{value: 1}("yoursite.com.");
        vm.expectRevert(DomainEscrow.BadDomain.selector);
        escrow.deposit{value: 1}("your site.com");
        vm.expectRevert(DomainEscrow.BadDomain.selector);
        escrow.deposit{value: 1}("your..site.com"); // empty label: could never be proven in DNS
        vm.expectRevert(DomainEscrow.BadDomain.selector);
        escrow.deposit{value: 1}(string.concat(_label(64), ".com")); // labels are at most 63 bytes
        escrow.deposit{value: 1}(string.concat(_label(63), ".com"));
        vm.stopPrank();
    }

    function _label(uint256 n) internal pure returns (string memory) {
        bytes memory b = new bytes(n);
        for (uint256 i; i < n; ++i) b[i] = "a";
        return string(b);
    }

    function test_claimToZeroAddressRejected() public {
        _depositBoth();
        verifier.publish(D, address(0), uint64(block.timestamp));
        vm.expectRevert(DomainEscrow.BadRecipient.selector);
        escrow.claim(D, address(0), "", _tokens());
    }

    /// A fee address that can't receive (reverting contract, frozen by a token) never blocks claims.
    function test_brokenFeeRecipientNeverBlocksClaims() public {
        DomainEscrow e = new DomainEscrow(verifier, REFUND, 50, address(new Reverter()), admin);
        vm.prank(payer);
        e.deposit{value: 1 ether}(D);
        verifier.publish(D, site, uint64(block.timestamp));
        e.claim(D, site, "", new address[](1));
        assertEq(site.balance, 0.995 ether);
        assertEq(e.feesOwed(address(0)), 0.005 ether);
        vm.expectRevert(DomainEscrow.TransferFailed.selector);
        e.withdrawFees(address(0));
        assertEq(e.feesOwed(address(0)), 0.005 ether, "still owed after a failed withdrawal");
    }

    function test_instantClaimPaysProvenWallet() public {
        _depositBoth();
        verifier.publish(D, site, uint64(block.timestamp));
        vm.prank(makeAddr("relayer")); // anyone can submit; funds still go to the proven wallet
        escrow.claim(D, site, "", _tokens());
        assertEq(site.balance, 0.995 ether);
        assertEq(usdg.balanceOf(site), 99.5e6);
        assertEq(escrow.feesOwed(address(0)), 0.005 ether);
        assertEq(escrow.feesOwed(address(usdg)), 0.5e6);
        escrow.withdrawFees(address(0)); // anyone can push fees to the fee address
        escrow.withdrawFees(address(usdg));
        assertEq(feeTo.balance, 0.005 ether);
        assertEq(usdg.balanceOf(feeTo), 0.5e6);
        assertEq(escrow.feesOwed(address(0)), 0);
        vm.expectRevert(DomainEscrow.ZeroAmount.selector);
        escrow.withdrawFees(address(0));
        assertEq(escrow.balanceOf(D, address(0)), 0);
    }

    function test_cannotClaimToUnpublishedWallet() public {
        _depositBoth();
        verifier.publish(D, site, uint64(block.timestamp));
        vm.expectRevert("not published");
        escrow.claim(D, hijacker, "", _tokens());
    }

    function test_olderProofCannotOverrideNewer() public {
        _depositBoth();
        verifier.publish(D, site, 2000);
        escrow.claim(D, site, "", _tokens());
        verifier.publish(D, hijacker, 1000); // an older record, e.g. a previous owner's
        vm.prank(payer);
        escrow.deposit{value: 1 ether}(D);
        vm.expectRevert(DomainEscrow.StaleProof.selector);
        escrow.claim(D, hijacker, "", _tokens());
        escrow.claim(D, site, "", _tokens()); // same signing time is fine
        assertEq(site.balance, 1.99 ether);
    }

    function test_refundsAfterDelay() public {
        _depositBoth();
        vm.startPrank(payer);
        vm.expectRevert(DomainEscrow.RefundLocked.selector);
        escrow.refund(D, address(usdg));
        vm.warp(block.timestamp + REFUND);
        escrow.refund(D, address(usdg));
        assertEq(usdg.balanceOf(payer), 1_000e6);
        vm.expectRevert(DomainEscrow.NothingToRefund.selector);
        escrow.refund(D, address(usdg));
        vm.stopPrank();
    }

    function test_noRefundAfterClaim() public {
        _depositBoth();
        verifier.publish(D, site, uint64(block.timestamp));
        escrow.claim(D, site, "", _tokens());
        vm.warp(block.timestamp + REFUND);
        vm.prank(payer);
        vm.expectRevert(DomainEscrow.NothingToRefund.selector);
        escrow.refund(D, address(0));
    }

    function test_pauseBlocksDepositsButNeverExits() public {
        _depositBoth();
        vm.prank(admin);
        escrow.setDepositsPaused(true);
        vm.prank(payer);
        vm.expectRevert(DomainEscrow.Paused.selector);
        escrow.deposit{value: 1}(D);

        verifier.publish(D, site, uint64(block.timestamp));
        escrow.claim(D, site, "", _tokens()); // claims work while paused
        assertEq(site.balance, 0.995 ether);
    }

    function test_refundsWorkWhilePaused() public {
        _depositBoth();
        vm.prank(admin);
        escrow.setDepositsPaused(true);
        vm.warp(block.timestamp + REFUND);
        vm.prank(payer);
        escrow.refund(D, address(0));
        assertEq(payer.balance, 10 ether);
    }

    function test_onlyAdminAndTwoStepTransfer() public {
        vm.expectRevert(DomainEscrow.NotAdmin.selector);
        escrow.setDepositsPaused(true);
        address next = makeAddr("next");
        vm.prank(admin);
        escrow.transferAdmin(next);
        assertEq(escrow.admin(), admin);
        vm.prank(next);
        escrow.acceptAdmin();
        assertEq(escrow.admin(), next);
    }

    function test_badConfigRejected() public {
        vm.expectRevert(DomainEscrow.BadConfig.selector);
        new DomainEscrow(verifier, REFUND, 101, feeTo, admin);
        vm.expectRevert(DomainEscrow.BadConfig.selector);
        new DomainEscrow(verifier, REFUND, 50, feeTo, address(0));
    }

    function testFuzz_feeMathAndAccounting(uint96 a, uint96 b, uint16 feeBps) public {
        feeBps = uint16(bound(feeBps, 0, 100));
        uint256 x = bound(a, 1, 1_000 ether);
        uint256 y = bound(b, 1, 1_000 ether);
        DomainEscrow e = new DomainEscrow(verifier, REFUND, feeBps, feeTo, admin);
        address p2 = makeAddr("p2");
        vm.deal(payer, x);
        vm.deal(p2, y);
        vm.prank(payer);
        e.deposit{value: x}(D);
        vm.prank(p2);
        e.deposit{value: y}(D);
        assertEq(address(e).balance, x + y);

        verifier.publish(D, site, uint64(block.timestamp));
        uint256 siteBefore = site.balance;
        uint256 feeBefore = feeTo.balance;
        e.claim(D, site, "", new address[](1));
        uint256 fee = ((x + y) * feeBps) / 10_000;
        assertEq(site.balance - siteBefore, x + y - fee);
        assertEq(e.feesOwed(address(0)), fee);
        if (fee != 0) e.withdrawFees(address(0));
        assertEq(feeTo.balance - feeBefore, fee);
        assertEq(address(e).balance, 0);
    }
}
