// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {DNSSEC} from "@ens/dnssec-oracle/DNSSEC.sol";
import {DNSSECImpl} from "@ens/dnssec-oracle/DNSSECImpl.sol";
import {RRUtils} from "@ens/dnssec-oracle/RRUtils.sol";
import {DummyAlgorithm} from "@ens/dnssec-oracle/algorithms/DummyAlgorithm.sol";
import {DummyDigest} from "@ens/dnssec-oracle/digests/DummyDigest.sol";
import {DnssecVerifier} from "../src/DnssecVerifier.sol";
import {DomainEscrow} from "../src/DomainEscrow.sol";
import {DomainFeeForwarder} from "../src/DomainFeeForwarder.sol";
import {DomainLauncher} from "../src/DomainLauncher.sol";
import {IPonsCurve, IPonsFactory, IPonsFeeEscrow, IPonsHook} from "../src/pons/IPons.sol";

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

/// End-to-end simulations on a Robinhood Chain fork: real USDG, the real pons v2 factory and curves, and
/// ENS's DNSSEC oracle code with a synthetic root key (algorithm 253 always verifies), so a domain's
/// owner can be shown claiming. The IANA-anchored path is DnssecVerifier.t.sol:test_fork_realProofVerifies.
/// FORK_RPC=https://rpc.mainnet.chain.robinhood.com forge test --mc Simulation --evm-version osaka -vv
contract SimulationTest is Test {
    using RRUtils for bytes;

    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    IPonsFactory constant PONS = IPonsFactory(0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e);
    IPonsFeeEscrow constant PONS_ESCROW = IPonsFeeEscrow(0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e);
    address constant PONS_HOOK = 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044;
    string constant D = "yoursite.com";
    uint8 constant ALG = 253;
    bytes constant ROOT_KEY = hex"010103fd0102030405060708"; // flags 257, protocol 3, algorithm 253, key

    DomainEscrow escrow;
    DomainLauncher launcher;
    address admin = makeAddr("admin");
    address treasury = makeAddr("treasury");
    address owner = makeAddr("owner"); // the wallet yoursite.com publishes
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    uint16 keytag;
    bool forked;
    uint256 nonce;

    modifier fork() {
        vm.skip(!forked);
        _;
    }

    function setUp() public {
        string memory rpc = vm.envOr("FORK_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        forked = true;

        keytag = ROOT_KEY.computeKeytag();
        DNSSECImpl oracle = new DNSSECImpl(rr(hex"00", 43, abi.encodePacked(keytag, ALG, ALG, bytes1(0x00))));
        oracle.setAlgorithm(ALG, new DummyAlgorithm());
        oracle.setDigest(ALG, new DummyDigest());
        escrow = new DomainEscrow(new DnssecVerifier(oracle), 180 days, 50, treasury, admin);
        launcher = new DomainLauncher(PONS, escrow);

        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
        deal(USDG, alice, 1_000e6);
        deal(USDG, bob, 1_000e6);
    }

    // ---------- escrow ----------

    function test_sim_escrowLifecycle() public fork {
        uint32 t0 = uint32(block.timestamp - 1 hours);

        // senders fund yoursite.com before it publishes anything
        vm.startPrank(alice);
        IERC20(USDG).approve(address(escrow), 100e6);
        escrow.depositToken(D, USDG, 100e6);
        vm.stopPrank();
        vm.prank(bob);
        escrow.deposit{value: 1 ether}(D);
        assertEq(escrow.balanceOf(D, USDG), 100e6);
        assertEq(escrow.balanceOf(D, address(0)), 1 ether);

        // a proof for the published wallet can't pay anyone else; another domain's proof can't pay this one
        bytes memory good = txtProof(D, owner, t0);
        bytes memory otherDomain = txtProof("evil.com", owner, t0);
        vm.expectRevert(DnssecVerifier.NotPublished.selector);
        escrow.claim(D, bob, good, tokens());
        vm.expectRevert(DnssecVerifier.NotPublished.selector);
        escrow.claim(D, owner, otherDomain, tokens());

        // anyone submits; the published wallet is paid instantly, minus 0.5%
        uint256 g = gasleft();
        vm.prank(bob);
        escrow.claim(D, owner, good, tokens());
        console.log("claim gas, 2 assets:", g - gasleft());
        assertEq(IERC20(USDG).balanceOf(owner), 99.5e6);
        assertEq(owner.balance, 0.995 ether);
        escrow.withdrawFees(USDG);
        escrow.withdrawFees(address(0));
        assertEq(IERC20(USDG).balanceOf(treasury), 0.5e6);
        assertEq(treasury.balance, 0.005 ether);
        assertEq(escrow.balanceOf(D, USDG), 0);

        // an older signature than the last accepted one is refused
        vm.prank(alice);
        escrow.deposit{value: 0.1 ether}(D);
        bytes memory stale = txtProof(D, alice, t0 - 1);
        vm.expectRevert(DomainEscrow.StaleProof.selector);
        escrow.claim(D, alice, stale, tokens());

        // paused: no new deposits, but claims still pay
        vm.prank(alice);
        vm.expectRevert(DomainEscrow.NotAdmin.selector);
        escrow.setDepositsPaused(true);
        vm.prank(admin);
        escrow.setDepositsPaused(true);
        vm.prank(bob);
        vm.expectRevert(DomainEscrow.Paused.selector);
        escrow.deposit{value: 1}(D);
        escrow.claim(D, owner, txtProof(D, owner, t0 + 1), tokens());
        assertEq(owner.balance, 0.995 ether + 0.0995 ether);
        vm.prank(admin);
        escrow.setDepositsPaused(false);

        // claimed money can't be refunded, even after the delay
        vm.warp(block.timestamp + 181 days);
        vm.prank(alice);
        vm.expectRevert(DomainEscrow.NothingToRefund.selector);
        escrow.refund(D, USDG);
    }

    function test_sim_refundUnclaimed() public fork {
        vm.startPrank(alice);
        IERC20(USDG).approve(address(escrow), 5e6);
        escrow.depositToken("nobody-home.com", USDG, 5e6);
        vm.expectRevert(DomainEscrow.RefundLocked.selector);
        escrow.refund("nobody-home.com", USDG);
        vm.warp(block.timestamp + 180 days);
        uint256 before = IERC20(USDG).balanceOf(alice);
        escrow.refund("nobody-home.com", USDG);
        vm.stopPrank();
        assertEq(IERC20(USDG).balanceOf(alice) - before, 5e6);
        assertEq(escrow.balanceOf("nobody-home.com", USDG), 0);
    }

    function test_sim_walletRecordAtApex() public fork {
        vm.prank(bob);
        escrow.deposit{value: 1 ether}(D);
        bytes memory rdata = abi.encodePacked(uint8(3), "ETH", uint8(42), vm.toString(owner)); // WALLET (262) RDATA
        bytes memory name = wire(D);
        escrow.claim(D, owner, proof(name, uint8(name.labelCount(0)), 262, rdata, uint32(block.timestamp - 60)), tokens());
        assertEq(owner.balance, 0.995 ether);
    }

    // ---------- pons launches with fees to a domain ----------

    function test_sim_ponsEthLaunchFeesReachDomain() public fork {
        address fwd = launcher.forwarderOf(D);
        uint256 fee = PONS.launchFee();
        IPonsFactory.TokenParams memory p = params("Your Site", "SITE", address(0));

        vm.prank(alice);
        (address token, address curve) = launcher.launch{value: fee + 0.05 ether}(D, p, 0, address(0), 0.05 ether, 0);
        assertGt(IERC20(token).balanceOf(alice), 0, "opening buy reached the creator");
        assertEq(feeRecipientOf(token), fwd, "pons pays the domain's forwarder");
        assertEq(address(launcher).balance, 0, "launcher keeps nothing");

        trade(curve, token, address(0), 1 ether);
        console.log("ETH owed before any sweep:", PONS_ESCROW.balanceOf(fwd));

        // one call: deploy forwarder, sweep the curve, pull from pons, deposit to escrow
        launcher.collect(D, one(curve), new address[](0));
        uint256 got = escrow.balanceOf(D, address(0));
        console.log("ETH creator fees in escrow for the domain:", got);
        assertGt(got, 0);
        assertEq(PONS_ESCROW.balanceOf(fwd), 0, "nothing left at pons");
        assertEq(fwd.balance, 0, "nothing left in the forwarder");

        escrow.claim(D, owner, txtProof(D, owner, uint32(block.timestamp - 60)), tokens());
        assertEq(owner.balance, got - (got * 50) / 10_000, "domain owner paid");
    }

    function test_sim_ponsUsdgLaunchFeesReachDomain() public fork {
        address fwd = launcher.forwarderOf(D);
        uint256 fee = PONS.launchFee();
        vm.prank(alice);
        (address token, address curve) = launcher.launch{value: fee}(D, params("Site Dollar", "SITED", USDG), 0, USDG, 0, 0);
        assertEq(feeRecipientOf(token), fwd);
        (uint256 q0, uint256 t0) = IPonsCurve(curve).getReserves();
        assertEq(q0, 3236e6, "USDG phantom reserve the app assumes");
        assertEq(t0, 1e27);

        trade(curve, token, USDG, 500e6);
        console.log("USDG owed before any sweep:", PONS_ESCROW.balanceOfToken(fwd, USDG));

        address[] memory list = new address[](1);
        list[0] = USDG;
        launcher.collect(D, one(curve), list);
        uint256 got = escrow.balanceOf(D, USDG);
        console.log("USDG creator fees in escrow for the domain:", got);
        assertGt(got, 0);
        assertEq(PONS_ESCROW.balanceOfToken(fwd, USDG), 0);
        assertEq(IERC20(USDG).balanceOf(fwd), 0);

        escrow.claim(D, owner, txtProof(D, owner, uint32(block.timestamp - 60)), tokens());
        assertEq(IERC20(USDG).balanceOf(owner), got - (got * 50) / 10_000);
    }

    /// The app estimates trades with constant-product math on the curve's reserves, after the curve fee,
    /// the creator tax and any snipe tax. Check that estimate against the real curve.
    function test_sim_appQuoteMatchesCurve() public fork {
        uint256 fee = PONS.launchFee();
        vm.prank(alice);
        (address token, address curve) = launcher.launch{value: fee}(D, params("Quote", "QTE", address(0)), 0, address(0), 0, 0);
        vm.roll(block.number + 30);
        vm.warp(block.timestamp + 10 minutes);
        IPonsCurve c = IPonsCurve(curve);
        uint256 cut = curveUint(curve, "feeBps()") + curveUint(curve, "creatorTaxBps()");

        (uint256 q, uint256 t) = c.getReserves();
        uint256 inAfter = 0.3 ether * (10_000 - cut - snipe(curve, bob)) / 10_000;
        uint256 expectBuy = t * inAfter / (q + inAfter);
        vm.prank(bob);
        c.buy{value: 0.3 ether}(0.3 ether, 0, bob);
        uint256 gotTokens = IERC20(token).balanceOf(bob);
        console.log("buy: estimate / actual", expectBuy, gotTokens);
        assertApproxEqRel(gotTokens, expectBuy, 0.01e18);

        (q, t) = c.getReserves();
        uint256 sellIn = gotTokens / 3;
        uint256 expectSell = (q * sellIn / (t + sellIn)) * (10_000 - cut) / 10_000;
        uint256 before = bob.balance;
        vm.startPrank(bob);
        IERC20(token).approve(curve, sellIn);
        c.sell(sellIn, 0, bob);
        vm.stopPrank();
        console.log("sell: estimate / actual", expectSell, bob.balance - before);
        assertApproxEqRel(bob.balance - before, expectSell, 0.01e18);
    }

    /// Buy a launch through graduation: the app's progress bar (raised = quote reserve - phantom, out of the
    /// curve's graduationThreshold) must match when pons graduates it, and collect() must keep working after.
    function test_sim_graduationAndCollectAfter() public fork {
        uint256 fee = PONS.launchFee();
        vm.prank(alice);
        (address token, address curve) = launcher.launch{value: fee}(D, params("Grad", "GRAD", address(0)), 0, address(0), 0, 0);
        vm.roll(block.number + 30);
        vm.warp(block.timestamp + 10 minutes);
        uint256 threshold = curveUint(curve, "graduationThreshold()");
        vm.deal(bob, 100 ether);
        uint256 lastRaised;
        for (uint256 i; i < 40 && curveUint(curve, "graduated()") == 0; ++i) {
            (uint256 q,) = IPonsCurve(curve).getReserves();
            lastRaised = q - 1.68 ether;
            vm.prank(bob);
            IPonsCurve(curve).buy{value: 0.25 ether}(0.25 ether, 0, bob);
        }
        assertEq(curveUint(curve, "graduated()"), 1, "graduated");
        console.log("raised before the graduating buy / threshold:", lastRaised, threshold);
        assertLt(lastRaised, threshold);
        assertGt(lastRaised + 0.25 ether, threshold * 99 / 100, "graduates when raised reaches the threshold");

        // pons's executor migrates a graduated curve to its Uniswap v4 pool later; a pool sweep that can't
        // happen (yet) is skipped, never reverts
        bytes32[] memory pools = new bytes32[](1);
        pools[0] = keccak256("not migrated yet");
        launcher.collectPools(D, IPonsHook(PONS_HOOK), pools, new address[](0));

        launcher.collect(D, one(curve), new address[](0)); // sweep reverts after graduation; it's skipped
        uint256 got = escrow.balanceOf(D, address(0));
        console.log("bonding-phase creator fees collected:", got);
        assertGt(got, 0);
        assertGt(IERC20(token).balanceOf(bob), 0);
    }

    /// buybackEnabled is forced off (only the fee recipient could ever turn it off again), and an opening buy
    /// bigger than the curve can take fills it and refunds the rest instead of reverting.
    function test_sim_buybackForcedOffAndOversizedOpeningBuyRefunds() public fork {
        uint256 fee = PONS.launchFee();
        IPonsFactory.TokenParams memory p = params("Big", "BIG", address(0));
        p.buybackEnabled = true;
        uint256 before = alice.balance;
        vm.prank(alice);
        (address token, address curve) = launcher.launch{value: fee + 6 ether}(D, p, 0, address(0), 6 ether, 0);
        assertEq(curveUint(curve, "buybackEnabled()"), 0, "buyback off");
        assertEq(curveUint(curve, "graduated()"), 1, "the opening buy filled the curve");
        uint256 spent = before - alice.balance;
        console.log("6 ETH opening buy, actually spent incl. launch fee:", spent);
        assertLt(spent, 5 ether, "the part the curve couldn't take came back");
        assertEq(address(launcher).balance, 0);
        assertGt(IERC20(token).balanceOf(alice), 0);
        (bool ok,) = address(launcher).call{value: 1}("");
        assertFalse(ok, "the launcher takes no direct payments");
    }

    function test_sim_launcherGuardsAndRegistry() public fork {
        uint256 fee = PONS.launchFee();
        IPonsFactory.TokenParams memory p = params("Guard", "GRD", address(0));
        IPonsFactory.TokenParams memory pu = params("Guard USD", "GRDU", USDG);

        vm.startPrank(alice);
        vm.expectRevert(DomainEscrow.BadDomain.selector);
        launcher.launch{value: fee}("YourSite.com", p, 0, address(0), 0, 0);
        vm.expectRevert(DomainLauncher.WrongValue.selector);
        launcher.launch{value: fee - 1}(D, p, 0, address(0), 0, 0);
        vm.expectRevert(DomainLauncher.OpeningBuyNeedsEth.selector);
        launcher.launch{value: fee + 1}(D, pu, 0, USDG, 1, 0);

        // a fee recipient passed in is ignored: fees always go to the domain
        p.creatorFeeRecipient = alice;
        (address a,) = launcher.launch{value: fee}(D, p, 0, address(0), 0, 0);
        (address b,) = launcher.launch{value: fee}(D, params("Second", "TWO", address(0)), 0, address(0), 0, 0);
        vm.stopPrank();
        assertEq(feeRecipientOf(a), launcher.forwarderOf(D));
        assertEq(feeRecipientOf(b), launcher.forwarderOf(D));

        assertEq(launcher.launchCount(), 2);
        assertEq(launcher.launchesOf(D, 0, 10).length, 2);
        assertEq(launcher.launchCountOf(D), 2);
        assertEq(launcher.launchesOf(D, 0, 1)[0].token, b, "domain page is newest first");
        assertEq(launcher.launchesOf(D, 2, 10).length, 0);
        assertEq(launcher.recent(0, 10)[0].token, b, "newest first");
        assertEq(launcher.recent(1, 10)[0].token, a);
        assertEq(launcher.recent(5, 10).length, 0);
        assertEq(launcher.launchOf(b).domain, D);
        assertEq(launcher.launchOf(b).launcher, alice);
        assertEq(launcher.launchOf(address(0xBEEF)).token, address(0));

        // the forwarder deploys at the predicted address, once
        DomainFeeForwarder f = launcher.deployForwarder(D);
        assertEq(address(f), launcher.forwarderOf(D));
        assertEq(address(launcher.deployForwarder(D)), address(f));
        assertEq(f.domain(), D);
    }

    // ---------- helpers ----------

    function params(string memory name, string memory symbol, address pair) internal returns (IPonsFactory.TokenParams memory p) {
        p.name = name;
        p.symbol = symbol;
        p.logo = "https://type262.com/assets/art/emblem.webp";
        p.description = "Fees go to yoursite.com";
        p.socials.website = "https://yoursite.com";
        p.creatorTaxBps = 300;
        p.expectedEconomics = PONS.previewLaunchEconomics(0, pair);
        p.salt = keccak256(abi.encode(name, ++nonce));
    }

    /// bob buys with `quoteIn`, then sells half of what he got.
    function trade(address curve, address token, address quote, uint256 quoteIn) internal {
        vm.roll(block.number + 30);
        vm.warp(block.timestamp + 10 minutes); // past any launch snipe window
        vm.startPrank(bob);
        if (quote == address(0)) {
            IPonsCurve(curve).buy{value: quoteIn}(quoteIn, 0, bob);
        } else {
            IERC20(quote).approve(curve, quoteIn);
            IPonsCurve(curve).buy(quoteIn, 0, bob);
        }
        uint256 half = IERC20(token).balanceOf(bob) / 2;
        IERC20(token).approve(curve, half);
        IPonsCurve(curve).sell(half, 0, bob);
        vm.stopPrank();
    }

    function one(address curve) internal pure returns (IPonsCurve[] memory list) {
        list = new IPonsCurve[](1);
        list[0] = IPonsCurve(curve);
    }

    function curveUint(address curve, string memory sig) internal view returns (uint256) {
        (bool ok, bytes memory ret) = curve.staticcall(abi.encodeWithSignature(sig));
        require(ok, sig);
        return abi.decode(ret, (uint256));
    }

    function snipe(address curve, address who) internal view returns (uint256) {
        (bool ok, bytes memory ret) = curve.staticcall(abi.encodeWithSignature("currentSnipeTaxBps(address)", who));
        require(ok, "snipe");
        return abi.decode(ret, (uint256));
    }

    function feeRecipientOf(address token) internal view returns (address r) {
        (bool ok, bytes memory ret) = address(PONS).staticcall(abi.encodeWithSignature("getLaunchedToken(address)", token));
        require(ok && ret.length >= 128, "getLaunchedToken");
        assembly {
            r := mload(add(ret, 128)) // LaunchedToken.creatorFeeRecipient (4th word)
        }
    }

    function tokens() internal pure returns (address[] memory t) {
        t = new address[](2);
        t[1] = USDG;
    }

    function txtProof(string memory domain, address wallet, uint32 inception) internal view returns (bytes memory) {
        bytes memory txt = abi.encodePacked("ETH ", vm.toString(wallet));
        bytes memory name = wire(string.concat("_wallet.", domain));
        return proof(name, uint8(name.labelCount(0)), 16, abi.encodePacked(uint8(txt.length), txt), inception);
    }

    /// Root DNSKEY (self-signed, matches the anchor), then the record signed by that key.
    function proof(bytes memory name, uint8 labels, uint16 rtype, bytes memory rdata, uint32 inception)
        internal
        view
        returns (bytes memory)
    {
        DNSSEC.RRSetWithSignature[] memory sets = new DNSSEC.RRSetWithSignature[](2);
        sets[0] = signed(48, 0, inception, rr(hex"00", 48, ROOT_KEY));
        sets[1] = signed(rtype, labels, inception, rr(name, rtype, rdata));
        return abi.encode(sets);
    }

    function signed(uint16 rtype, uint8 labels, uint32 inception, bytes memory rrs)
        internal
        view
        returns (DNSSEC.RRSetWithSignature memory)
    {
        bytes memory header =
            abi.encodePacked(rtype, ALG, labels, uint32(3600), uint32(block.timestamp + 30 days), inception, keytag, bytes1(0x00));
        return DNSSEC.RRSetWithSignature(abi.encodePacked(header, rrs), hex"00");
    }

    function rr(bytes memory name, uint16 rtype, bytes memory rdata) internal pure returns (bytes memory) {
        return abi.encodePacked(name, rtype, uint16(1), uint32(3600), uint16(rdata.length), rdata);
    }

    function wire(string memory dotted) internal pure returns (bytes memory out) {
        bytes memory s = bytes(dotted);
        uint256 start;
        for (uint256 i; i <= s.length; ++i) {
            if (i < s.length && s[i] != ".") continue;
            bytes memory label = new bytes(i - start);
            for (uint256 j; j < label.length; ++j) label[j] = s[start + j];
            out = abi.encodePacked(out, uint8(label.length), label);
            start = i + 1;
        }
        out = abi.encodePacked(out, bytes1(0x00));
    }
}
