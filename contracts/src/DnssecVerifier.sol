// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IDomainVerifier} from "./IDomainVerifier.sol";
import {DNSSEC} from "@ens/dnssec-oracle/DNSSEC.sol";
import {RRUtils} from "@ens/dnssec-oracle/RRUtils.sol";

/// @title DnssecVerifier
/// @notice Trustless claims: checks a DNSSEC proof on-chain, from the DNS root keys down to the domain's
/// wallet record, using ENS's audited DNSSEC oracle. No attestor, no server, no admin.
///
/// Accepted records (DNSSEC-signed):
///   <domain>          WALLET (RRTYPE 262)   "ETH" "0x…"
///   _wallet.<domain>  TXT                   "ETH 0x…"   (works on every DNS host)
/// The coin must be an EVM one (ETH, EVM, HOOD, USDG, ARB, OP, POL, USDC, USDT, DAI) and the address exactly
/// 0x + 40 hex digits. Anything else in the signed RRset (BTC, SOL, notes…) is ignored and can never be claimed to.
contract DnssecVerifier is IDomainVerifier {
    using RRUtils for *;

    uint16 private constant CLASS_INET = 1;
    uint16 private constant TYPE_TXT = 16;
    uint16 private constant TYPE_WALLET = 262;

    DNSSEC public immutable oracle;

    error NotPublished();
    error BadName();

    constructor(DNSSEC oracle_) {
        oracle = oracle_;
    }

    function verify(string calldata domain, address recipient, bytes calldata proof) external view returns (uint64) {
        if (recipient == address(0)) revert NotPublished();
        DNSSEC.RRSetWithSignature[] memory input = abi.decode(proof, (DNSSEC.RRSetWithSignature[]));
        (bytes memory rrs, uint32 inception) = oracle.verifyRRSet(input);

        bytes32 apex = keccak256(toWire(bytes(domain), ""));
        bytes32 fallbackName = keccak256(toWire(bytes(domain), "_wallet"));
        for (RRUtils.RRIterator memory it = rrs.iterateRRs(0); !it.done(); it.next()) {
            if (it.class != CLASS_INET) continue;
            bytes32 owner = keccak256(it.name());
            bool wallet = it.dnstype == TYPE_WALLET && owner == apex;
            bool txt = it.dnstype == TYPE_TXT && owner == fallbackName;
            if ((wallet || txt) && walletAddress(it.rdata()) == recipient) return signedAt(inception);
        }
        revert NotPublished();
    }

    /// @notice When the record was signed, as a unix time. The oracle accepts an inception up to 2^31 seconds
    /// in the past by RFC 1982 serial arithmetic, so the raw uint32 can be numerically larger than now; counting
    /// back from now keeps "newer" meaning newer.
    function signedAt(uint32 inception) public view returns (uint64) {
        uint32 age;
        unchecked {
            age = uint32(block.timestamp) - inception;
        }
        return age > block.timestamp ? 0 : uint64(block.timestamp - age);
    }

    /// @notice "example.com" (+ optional first label) to DNS wire format: 7example3com0.
    function toWire(bytes memory dotted, bytes memory firstLabel) public pure returns (bytes memory out) {
        if (firstLabel.length > 0) out = abi.encodePacked(uint8(firstLabel.length), firstLabel);
        uint256 start;
        for (uint256 i; i <= dotted.length; ++i) {
            if (i == dotted.length || dotted[i] == ".") {
                uint256 len = i - start;
                if (len == 0 || len > 63) revert BadName();
                bytes memory label = new bytes(len);
                for (uint256 j; j < len; ++j) label[j] = dotted[start + j];
                out = abi.encodePacked(out, uint8(len), label);
                start = i + 1;
            }
        }
        out = abi.encodePacked(out, uint8(0));
    }

    /// @notice The EVM address a WALLET or _wallet TXT record publishes, or address(0) if it doesn't publish
    /// exactly one for an EVM coin. RDATA is either two character-strings, "ETH" "0x…", or (TXT) one
    /// character-string "ETH 0x…" or "ETH:0x…".
    function walletAddress(bytes memory rdata) public pure returns (address) {
        uint256 n = rdata.length;
        if (n == 0) return address(0);
        uint256 l0 = uint8(rdata[0]);
        if (1 + l0 > n) return address(0);
        bytes memory coin;
        bytes memory addr;
        if (1 + l0 == n) {
            // one string: COIN, then spaces and/or colons, then the address, nothing after it
            uint256 i = 1;
            while (i < n && rdata[i] != " " && rdata[i] != ":") ++i;
            coin = _slice(rdata, 1, i - 1);
            while (i < n && (rdata[i] == " " || rdata[i] == ":")) ++i;
            addr = _slice(rdata, i, n - i);
        } else {
            uint256 l1 = uint8(rdata[1 + l0]);
            if (2 + l0 + l1 != n) return address(0); // exactly two strings
            coin = _slice(rdata, 1, l0);
            addr = _slice(rdata, 2 + l0, l1);
        }
        if (!isEvmCoin(coin)) return address(0);
        return _hexAddress(addr);
    }

    /// @notice Coins whose wallet is a plain EVM address (same key on Robinhood Chain). Case-insensitive.
    function isEvmCoin(bytes memory coin) public pure returns (bool) {
        if (coin.length < 2 || coin.length > 4) return false;
        bytes memory up = new bytes(coin.length);
        for (uint256 i; i < coin.length; ++i) {
            bytes1 c = coin[i];
            up[i] = c >= "a" && c <= "z" ? bytes1(uint8(c) - 32) : c;
        }
        bytes32 h = keccak256(up);
        return h == keccak256("ETH") || h == keccak256("EVM") || h == keccak256("HOOD") || h == keccak256("USDG")
            || h == keccak256("ARB") || h == keccak256("OP") || h == keccak256("POL") || h == keccak256("USDC")
            || h == keccak256("USDT") || h == keccak256("DAI");
    }

    /// @dev Exactly "0x" + 40 hex digits, else address(0).
    function _hexAddress(bytes memory a) private pure returns (address) {
        if (a.length != 42 || a[0] != "0" || (a[1] != "x" && a[1] != "X")) return address(0);
        uint160 value;
        for (uint256 j = 2; j < 42; ++j) {
            uint8 c = uint8(a[j]);
            uint8 v;
            if (c >= 48 && c <= 57) v = c - 48;
            else if (c >= 97 && c <= 102) v = c - 87;
            else if (c >= 65 && c <= 70) v = c - 55;
            else return address(0);
            value = (value << 4) | v;
        }
        return address(value);
    }

    function _slice(bytes memory b, uint256 start, uint256 len) private pure returns (bytes memory out) {
        out = new bytes(len);
        for (uint256 i; i < len; ++i) out[i] = b[start + i];
    }
}
