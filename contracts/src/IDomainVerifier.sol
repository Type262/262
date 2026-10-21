// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Proves that `domain` publishes `recipient` in its DNS wallet record.
interface IDomainVerifier {
    /// @dev Reverts unless `proof` is valid. Returns when the proven DNS data was signed,
    /// so an older proof can never override a newer one.
    function verify(string calldata domain, address recipient, bytes calldata proof) external view returns (uint64 observedAt);
}
