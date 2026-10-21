// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DnssecVerifier} from "../src/DnssecVerifier.sol";
import {DNSSEC} from "@ens/dnssec-oracle/DNSSEC.sol";
import {DNSSECImpl} from "@ens/dnssec-oracle/DNSSECImpl.sol";
import {RRUtils} from "@ens/dnssec-oracle/RRUtils.sol";
import {Oracle} from "../script/Oracle.sol";

/// Returns whatever RRset we hand it, as if it had been DNSSEC-verified.
contract MockDNSSEC is DNSSEC {
    bytes public data;
    uint32 public inception;

    function set(bytes memory d, uint32 t) external { data = d; inception = t; }

    function verifyRRSetAt(RRSetWithSignature[] memory, uint256) public view override returns (RRUtils.SignedSet[] memory sets) {
        sets = new RRUtils.SignedSet[](1);
        sets[0].data = data;
        sets[0].inception = inception;
    }
}

contract DnssecVerifierTest is Test {
    MockDNSSEC oracle;
    DnssecVerifier v;
    address constant WALLET = 0x7a1fe1C2B0d3a4f5e6D7c8B9a0F1e2D3c4b5C0dE;
    bytes NO_PROOF; // one (fake) signed set, so the mock oracle is actually consulted

    function setUp() public {
        oracle = new MockDNSSEC();
        v = new DnssecVerifier(oracle);
        NO_PROOF = abi.encode(new DNSSEC.RRSetWithSignature[](1));
        vm.warp(1_790_000_000);
    }

    function _rr(bytes memory wireName, uint16 rtype, bytes memory rdata) internal pure returns (bytes memory) {
        return abi.encodePacked(wireName, rtype, uint16(1), uint32(300), uint16(rdata.length), rdata);
    }

    function _str(bytes memory s) internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(s.length), s);
    }

    function test_toWire() public view {
        assertEq(v.toWire("yoursite.com", ""), hex"08796f75727369746503636f6d00");
        assertEq(v.toWire("yoursite.com", "_wallet"), hex"075f77616c6c657408796f75727369746503636f6d00");
    }

    function test_walletRecordAtApex() public {
        bytes memory rdata = abi.encodePacked(_str("ETH"), _str("0x7a1fe1c2b0d3a4f5e6d7c8b9a0f1e2d3c4b5c0de"));
        oracle.set(_rr(v.toWire("yoursite.com", ""), 262, rdata), uint32(block.timestamp - 1234));
        assertEq(v.verify("yoursite.com", WALLET, NO_PROOF), block.timestamp - 1234);
    }

    function test_txtFallbackAtUnderscoreWallet() public {
        bytes memory rdata = _str("ETH 0x7A1FE1C2B0D3A4F5E6D7C8B9A0F1E2D3C4B5C0DE");
        oracle.set(_rr(v.toWire("yoursite.com", "_wallet"), 16, rdata), uint32(block.timestamp - 99));
        assertEq(v.verify("yoursite.com", WALLET, NO_PROOF), block.timestamp - 99);
    }

    function test_rejectsWrongPlaceOrWallet() public {
        bytes memory rdata = _str("ETH 0x7a1fe1c2b0d3a4f5e6d7c8b9a0f1e2d3c4b5c0de");
        // TXT at the apex (not _wallet) does not count
        oracle.set(_rr(v.toWire("yoursite.com", ""), 16, rdata), 1);
        vm.expectRevert(DnssecVerifier.NotPublished.selector);
        v.verify("yoursite.com", WALLET, NO_PROOF);
        // a record for another domain does not count
        oracle.set(_rr(v.toWire("evil.com", "_wallet"), 16, rdata), 1);
        vm.expectRevert(DnssecVerifier.NotPublished.selector);
        v.verify("yoursite.com", WALLET, NO_PROOF);
        // the right record, the wrong wallet
        oracle.set(_rr(v.toWire("yoursite.com", "_wallet"), 16, rdata), 1);
        vm.expectRevert(DnssecVerifier.NotPublished.selector);
        v.verify("yoursite.com", address(0xBEEF), NO_PROOF);
    }

    function test_walletAddressParsing() public view {
        string memory A = "0x7a1fe1c2b0d3a4f5e6d7c8b9a0f1e2d3c4b5c0de";
        assertEq(v.walletAddress(_str(abi.encodePacked("ETH ", A))), WALLET);
        assertEq(v.walletAddress(_str(abi.encodePacked("eth:", A))), WALLET, "case-insensitive coin, colon");
        assertEq(v.walletAddress(_str(abi.encodePacked("USDG  ", A))), WALLET, "several spaces");
        assertEq(v.walletAddress(abi.encodePacked(_str("HOOD"), _str(bytes(A)))), WALLET, "two strings");
        // not an EVM coin, not exactly 40 hex digits, extra text, no address: nothing
        assertEq(v.walletAddress(_str(abi.encodePacked("SOL ", A))), address(0));
        assertEq(v.walletAddress(_str(abi.encodePacked("BTC ", A))), address(0));
        assertEq(v.walletAddress(_str(abi.encodePacked("ETH ", A, "ff"))), address(0), "longer hex is not truncated");
        assertEq(v.walletAddress(_str(abi.encodePacked("ETH ", A, " note"))), address(0));
        assertEq(v.walletAddress(_str("ETH 0xZZ1fe1c2b0d3a4f5e6d7c8b9a0f1e2d3c4b5c0de")), address(0));
        assertEq(v.walletAddress(_str("BTC bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh")), address(0));
        assertEq(v.walletAddress(_str(bytes(A))), address(0), "no coin");
        assertEq(v.walletAddress(abi.encodePacked(_str("ETH"), _str(bytes(A)), _str("x"))), address(0), "three strings");
        assertEq(v.walletAddress(hex"05455448"), address(0), "truncated RDATA");
        assertEq(v.walletAddress(""), address(0));
    }

    /// A non-EVM line in the same signed RRset parses to address(0); claiming "to" it must be impossible.
    function test_cannotClaimToZeroViaNonEvmRecord() public {
        bytes memory rrs = abi.encodePacked(
            _rr(v.toWire("yoursite.com", "_wallet"), 16, _str("BTC bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh")),
            _rr(v.toWire("yoursite.com", "_wallet"), 16, _str("ETH 0x7a1fe1c2b0d3a4f5e6d7c8b9a0f1e2d3c4b5c0de"))
        );
        oracle.set(rrs, uint32(block.timestamp));
        vm.expectRevert(DnssecVerifier.NotPublished.selector);
        v.verify("yoursite.com", address(0), NO_PROOF);
        assertEq(v.verify("yoursite.com", WALLET, NO_PROOF), block.timestamp); // the ETH line still works
    }

    /// The oracle accepts any inception up to 2^31 s in the past (RFC 1982), so a raw uint32 can be huge.
    /// signedAt must turn it into a real past time, or one old signature could block every future claim.
    function test_inceptionWrapCannotLookNewer() public {
        vm.warp(1_790_000_000);
        bytes memory rdata = _str("ETH 0x7a1fe1c2b0d3a4f5e6d7c8b9a0f1e2d3c4b5c0de");
        uint32 wrapped;
        unchecked {
            wrapped = uint32(block.timestamp) - uint32(2 ** 31 - 1000); // serially 2^31-1000 s ago, numerically huge
        }
        assertGt(wrapped, block.timestamp);
        oracle.set(_rr(v.toWire("yoursite.com", "_wallet"), 16, rdata), wrapped);
        assertEq(v.verify("yoursite.com", WALLET, NO_PROOF), 0, "older than the epoch counts as 0");
        oracle.set(_rr(v.toWire("yoursite.com", "_wallet"), 16, rdata), uint32(block.timestamp - 3600));
        assertEq(v.verify("yoursite.com", WALLET, NO_PROOF), block.timestamp - 3600);
    }

    /// Real DNSSEC on a Robinhood Chain fork. Run with:
    ///   node script/make-proof.mjs TXT cloudflare.com > test/fixtures/proof.hex
    ///   FORK_RPC=https://rpc.mainnet.chain.robinhood.com forge test --evm-version osaka --mt test_fork
    function test_fork_realProofVerifies() public {
        string memory rpc = vm.envOr("FORK_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        DNSSECImpl real = Oracle.deploy();
        assertEq(real.owner(), address(0)); // nobody can change how proofs are checked
        bytes memory proof = vm.parseBytes(vm.readFile("test/fixtures/proof.hex"));
        DNSSEC.RRSetWithSignature[] memory input = abi.decode(proof, (DNSSEC.RRSetWithSignature[]));
        uint256 gasBefore = gasleft();
        (bytes memory rrs, uint32 inception) = real.verifyRRSet(input);
        emit log_named_uint("gas to verify the chain", gasBefore - gasleft());
        assertGt(rrs.length, 0);
        assertGt(inception, 0);

        DnssecVerifier rv = new DnssecVerifier(real);
        vm.expectRevert(DnssecVerifier.NotPublished.selector); // real chain, but no _wallet record there
        rv.verify("cloudflare.com", WALLET, proof);

        input[input.length - 1].sig[10] ^= 0x01; // tamper with one byte of the final signature
        vm.expectRevert();
        real.verifyRRSet(input);
    }
}
