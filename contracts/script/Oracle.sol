// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DNSSECImpl} from "@ens/dnssec-oracle/DNSSECImpl.sol";
import {RSASHA1Algorithm} from "@ens/dnssec-oracle/algorithms/RSASHA1Algorithm.sol";
import {RSASHA256Algorithm} from "@ens/dnssec-oracle/algorithms/RSASHA256Algorithm.sol";
import {P256SHA256Algorithm} from "@ens/dnssec-oracle/algorithms/P256SHA256Algorithm.sol";
import {SHA1Digest} from "@ens/dnssec-oracle/digests/SHA1Digest.sol";
import {SHA256Digest} from "@ens/dnssec-oracle/digests/SHA256Digest.sol";

/// Deploys ENS's DNSSEC oracle with the IANA root trust anchors, wires up the algorithms,
/// then renounces ownership so nobody (us included) can ever change how proofs are checked.
library Oracle {
    /// Root DS records from https://data.iana.org/root-anchors/root-anchors.xml
    ///   . 3600 IN DS 20326 8 2 E06D44B8…C7F8EC8D   (KSK-2017)
    ///   . 3600 IN DS 38696 8 2 683D2D0A…C0FB2B16   (KSK-2024, signing the root since 2026-10-11)
    bytes internal constant ROOT_ANCHORS =
        hex"00002b000100000e1000244f660802e06d44b80b8f1d39a95c0b0d7c65d08458e880409bbc683457104237c7f8ec8d"
        hex"00002b000100000e10002497280802683d2d0acb8c9b712a1948b27f741219298d0a450d612c483af444a4c0fb2b16";

    function deploy() internal returns (DNSSECImpl oracle) {
        oracle = new DNSSECImpl(ROOT_ANCHORS);
        RSASHA1Algorithm rsasha1 = new RSASHA1Algorithm();
        oracle.setAlgorithm(5, rsasha1); // RSASHA1
        oracle.setAlgorithm(7, rsasha1); // RSASHA1-NSEC3-SHA1
        oracle.setAlgorithm(8, new RSASHA256Algorithm()); // RSASHA256 (the root, many TLDs)
        oracle.setAlgorithm(13, new P256SHA256Algorithm()); // ECDSAP256SHA256 (.com, Cloudflare, most zones)
        oracle.setDigest(1, new SHA1Digest());
        oracle.setDigest(2, new SHA256Digest());
        oracle.renounceOwnership();
    }
}
