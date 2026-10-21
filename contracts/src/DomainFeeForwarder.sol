// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DomainEscrow} from "./DomainEscrow.sol";
import {IPonsCurve, IPonsFeeEscrow, IPonsHook} from "./pons/IPons.sol";

/// @title DomainFeeForwarder
/// @notice The pons creator-fee recipient for every token launched for one domain. Anyone can call
/// flush(): it withdraws this contract's pons fee balance and deposits it into DomainEscrow under the
/// domain, where the domain's owner claims it with a DNSSEC proof.
/// It has no owner and never redirects fees: it never calls pons's transferCreatorFeeRecipient or
/// setBuybackEnabled. (pons's own owner can still propose a new fee recipient for any token, behind a public
/// 3-day timelock; the app warns when a token's live recipient isn't its domain's forwarder.)
contract DomainFeeForwarder {
    DomainEscrow public immutable escrow;
    IPonsFeeEscrow public immutable ponsEscrow;
    string public domain;

    event Flushed(address indexed token, uint256 amount);

    error TransferFailed();

    constructor(string memory domain_, DomainEscrow escrow_, IPonsFeeEscrow ponsEscrow_) {
        escrow_.domainHash(domain_); // reverts unless the name is canonical
        domain = domain_;
        escrow = escrow_;
        ponsEscrow = ponsEscrow_;
    }

    receive() external payable {}

    /// @notice Ask launches' curves to move accrued fees into the pons fee escrow, then flush.
    /// pons's own operator sweeps too; this lets anyone hurry it along. A curve with nothing to sweep
    /// (or one that has graduated) is skipped. Launches made through DomainLauncher's app have buyback
    /// off, so the zero minimum below only matters for the buyback swap of a launch that turned it on.
    function collect(IPonsCurve[] calldata curves, address[] calldata tokens) external {
        for (uint256 i; i < curves.length; ++i) {
            try curves[i].sweepFees(0) {} catch {}
        }
        flush(tokens);
    }

    /// @notice After graduation, creator fees accrue in pons's Uniswap v4 hook. As the fee recipient, this
    /// contract may sweep its own pools (pons's operator also sweeps them). Pools that can't be swept are
    /// skipped. Then flush.
    function collectPools(IPonsHook hook, bytes32[] calldata poolIds, address[] calldata tokens) external {
        for (uint256 i; i < poolIds.length; ++i) {
            try hook.sweepPoolFees(poolIds[i], 0, 0) {} catch {}
        }
        flush(tokens);
    }

    /// @notice Move everything owed to this domain into DomainEscrow: native ETH plus any listed tokens
    /// (quote assets like USDG, or any other token pons pays this domain).
    function flush(address[] calldata tokens) public {
        if (ponsEscrow.balanceOf(address(this)) != 0) ponsEscrow.claim();
        uint256 eth = address(this).balance;
        if (eth != 0) {
            escrow.deposit{value: eth}(domain);
            emit Flushed(address(0), eth);
        }
        for (uint256 i; i < tokens.length; ++i) {
            address token = tokens[i];
            if (ponsEscrow.balanceOfToken(address(this), token) != 0) ponsEscrow.claimToken(token);
            (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSelector(0x70a08231, address(this))); // balanceOf
            if (!ok || ret.length < 32) revert TransferFailed();
            uint256 bal = abi.decode(ret, (uint256));
            if (bal == 0) continue;
            _approve(token, bal);
            escrow.depositToken(domain, token, bal);
            emit Flushed(token, bal);
        }
    }

    function _approve(address token, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0x095ea7b3, address(escrow), amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
