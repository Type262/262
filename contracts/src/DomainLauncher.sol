// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DomainEscrow} from "./DomainEscrow.sol";
import {DomainFeeForwarder} from "./DomainFeeForwarder.sol";
import {IPonsCurve, IPonsFactory, IPonsFeeEscrow, IPonsHook} from "./pons/IPons.sol";

/// @title DomainLauncher
/// @notice Launch a token on pons whose creator fees go to a domain. The fee recipient is the domain's
/// DomainFeeForwarder (a CREATE2 address known before it exists), so fees pile up for the domain from
/// the first trade and its owner claims them from DomainEscrow with a DNSSEC proof.
/// Holds no funds: the launch fee and the optional opening buy pass straight through to pons, and any part of
/// an opening buy the curve can't take (it graduates) goes straight back to the caller.
contract DomainLauncher {
    IPonsFactory public immutable pons;
    IPonsFeeEscrow public immutable ponsEscrow;
    DomainEscrow public immutable escrow;

    struct Launch {
        address token;
        address curve;
        address launcher;
        address pairToken;
        uint64 launchedAt;
        string domain;
    }

    Launch[] private _launches;
    mapping(bytes32 => uint256[]) private _byDomain;
    mapping(address => uint256) private _indexOf; // token => index + 1
    bool private _buying; // the only time this contract accepts ETH: a curve refunding part of an opening buy

    event DomainTokenLaunched(
        bytes32 indexed domainHash, string domain, address indexed token, address indexed curve, address launcher, address pairToken
    );
    event ForwarderDeployed(bytes32 indexed domainHash, string domain, address forwarder);

    error WrongValue();
    error OpeningBuyNeedsEth();
    error NoDirectPayments();
    error RefundFailed();

    constructor(IPonsFactory pons_, DomainEscrow escrow_) {
        pons = pons_;
        ponsEscrow = IPonsFeeEscrow(pons_.feeEscrow());
        escrow = escrow_;
    }

    receive() external payable {
        if (!_buying) revert NoDirectPayments();
    }

    // ---------- forwarders ----------

    function forwarderOf(string calldata domain) public view returns (address) {
        bytes32 initHash = keccak256(abi.encodePacked(type(DomainFeeForwarder).creationCode, abi.encode(domain, escrow, ponsEscrow)));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), keccak256(bytes(domain)), initHash)))));
    }

    /// @notice Deploy the domain's forwarder if it isn't there yet (anyone can). Returns its address.
    function deployForwarder(string calldata domain) public returns (DomainFeeForwarder f) {
        f = DomainFeeForwarder(payable(forwarderOf(domain)));
        if (address(f).code.length == 0) {
            f = new DomainFeeForwarder{salt: keccak256(bytes(domain))}(domain, escrow, ponsEscrow);
            emit ForwarderDeployed(keccak256(bytes(domain)), domain, address(f));
        }
    }

    /// @notice One call for the app: deploy the forwarder if needed, sweep the domain's curves and move
    /// everything pons owes the domain into DomainEscrow, where its owner claims it.
    function collect(string calldata domain, IPonsCurve[] calldata curves, address[] calldata tokens) external {
        deployForwarder(domain).collect(curves, tokens);
    }

    /// @notice Same for graduated launches: sweep the domain's pools in pons's v4 hook, then move it all to escrow.
    function collectPools(string calldata domain, IPonsHook hook, bytes32[] calldata poolIds, address[] calldata tokens)
        external
    {
        deployForwarder(domain).collectPools(hook, poolIds, tokens);
    }

    // ---------- launching ----------

    /// @notice Launch on pons with creator fees routed to `domain`. msg.value = pons launch fee + openingBuy.
    /// An opening buy (ETH pairs only) is executed in the same transaction and sent to the caller.
    function launch(
        string calldata domain,
        IPonsFactory.TokenParams calldata params,
        uint256 launchConfigId,
        address pairToken,
        uint256 openingBuy,
        uint256 minTokensOut
    ) external payable returns (address token, address curve) {
        bytes32 d = escrow.domainHash(domain); // canonical names only
        if (openingBuy != 0 && pairToken != address(0)) revert OpeningBuyNeedsEth();
        if (msg.value < openingBuy) revert WrongValue();
        (token, curve) = _launch(params, forwarderOf(domain), launchConfigId, pairToken, msg.value - openingBuy);
        _record(d, domain, token, curve, pairToken);
        if (openingBuy != 0) _openingBuy(IPonsCurve(curve), openingBuy, minTokensOut);
    }

    function _openingBuy(IPonsCurve curve, uint256 amount, uint256 minTokensOut) private {
        _buying = true;
        curve.buy{value: amount}(amount, minTokensOut, msg.sender);
        _buying = false;
        uint256 left = address(this).balance; // what the curve couldn't take
        if (left != 0) {
            (bool ok,) = msg.sender.call{value: left}("");
            if (!ok) revert RefundFailed();
        }
    }

    function _launch(
        IPonsFactory.TokenParams calldata params,
        address feeRecipient,
        uint256 launchConfigId,
        address pairToken,
        uint256 fee
    ) private returns (address, address) {
        if (fee != pons.launchFee()) revert WrongValue();
        IPonsFactory.TokenParams memory p = params;
        p.creatorFeeRecipient = feeRecipient;
        p.buybackEnabled = false; // only the fee recipient could ever turn it off, and the forwarder never does
        address[] memory exempt = new address[](1);
        exempt[0] = msg.sender; // the creator's own opening buy skips the snipe tax
        return pons.launchToken{value: fee}(p, launchConfigId, pairToken, exempt);
    }

    function _record(bytes32 d, string calldata domain, address token, address curve, address pairToken) private {
        _byDomain[d].push(_launches.length);
        _indexOf[token] = _launches.length + 1;
        _launches.push(Launch(token, curve, msg.sender, pairToken, uint64(block.timestamp), domain));
        emit DomainTokenLaunched(d, domain, token, curve, msg.sender, pairToken);
    }

    // ---------- views for the app ----------

    function launchCount() external view returns (uint256) {
        return _launches.length;
    }

    /// @notice Newest-first page of launches.
    function recent(uint256 offset, uint256 limit) external view returns (Launch[] memory page) {
        uint256 n = _launches.length;
        if (offset >= n) return page;
        uint256 count = n - offset < limit ? n - offset : limit;
        page = new Launch[](count);
        for (uint256 i; i < count; ++i) page[i] = _launches[n - 1 - offset - i];
    }

    /// @notice The launch record for a token (all zero if it wasn't launched here).
    function launchOf(address token) external view returns (Launch memory l) {
        uint256 i = _indexOf[token];
        if (i != 0) l = _launches[i - 1];
    }

    function launchCountOf(string calldata domain) external view returns (uint256) {
        return _byDomain[keccak256(bytes(domain))].length;
    }

    /// @notice Newest-first page of a domain's launches.
    function launchesOf(string calldata domain, uint256 offset, uint256 limit) external view returns (Launch[] memory page) {
        uint256[] storage ids = _byDomain[keccak256(bytes(domain))];
        uint256 n = ids.length;
        if (offset >= n) return page;
        uint256 count = n - offset < limit ? n - offset : limit;
        page = new Launch[](count);
        for (uint256 i; i < count; ++i) page[i] = _launches[ids[n - 1 - offset - i]];
    }
}
