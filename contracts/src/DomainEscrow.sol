// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IDomainVerifier} from "./IDomainVerifier.sol";

interface IERC20Min {
    function balanceOf(address) external view returns (uint256);
}

/// @title DomainEscrow
/// @notice Pay any domain before it publishes a wallet. Funds wait here, keyed by the domain name.
/// The domain's owner claims instantly with a DNSSEC proof of the wallet it publishes; anyone can submit
/// the proof, and the money only ever goes to the proven wallet. Depositors can refund if nobody claims.
///
/// The admin can pause new deposits. Nothing else: it can never move funds, change who gets paid,
/// or block claims and refunds.
contract DomainEscrow {
    struct Pool {
        uint256 balance;
        uint64 epoch; // bumps on every claim payout; older deposits can no longer be refunded
    }

    struct Deposit {
        uint256 amount;
        uint64 epoch;
        uint64 lastAt;
    }

    uint16 public constant MAX_FEE_BPS = 100;

    IDomainVerifier public immutable verifier;
    uint64 public immutable refundDelay;
    uint16 public immutable feeBps;
    address public immutable feeRecipient;

    address public admin;
    address public pendingAdmin;
    bool public depositsPaused;

    /// domainHash => token (address(0) = ETH) => pool
    mapping(bytes32 => mapping(address => Pool)) public pools;
    /// domainHash => token => depositor => deposit
    mapping(bytes32 => mapping(address => mapping(address => Deposit))) public deposits;
    /// domainHash => signing time of the newest proof used, so an older proof can never be replayed over it
    mapping(bytes32 => uint64) public lastProof;
    /// token => claim fees waiting for feeRecipient (pulled, so a fee address that can't receive never blocks a claim)
    mapping(address => uint256) public feesOwed;

    uint256 private _lock = 1;

    event Deposited(bytes32 indexed domainHash, string domain, address indexed token, address indexed from, uint256 amount);
    event Claimed(bytes32 indexed domainHash, address indexed token, address indexed recipient, uint256 amount, uint256 fee);
    event Refunded(bytes32 indexed domainHash, address indexed token, address indexed depositor, uint256 amount);
    event FeesWithdrawn(address indexed token, uint256 amount);
    event DepositsPaused(bool paused);
    event AdminTransferStarted(address indexed from, address indexed to);
    event AdminTransferred(address indexed from, address indexed to);

    error BadConfig();
    error BadDomain();
    error ZeroAmount();
    error StaleProof();
    error RefundLocked();
    error NothingToRefund();
    error TransferFailed();
    error Reentrancy();
    error NotAdmin();
    error Paused();
    error BadRecipient();

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(IDomainVerifier verifier_, uint64 refundDelay_, uint16 feeBps_, address feeRecipient_, address admin_) {
        if (address(verifier_) == address(0) || admin_ == address(0) || refundDelay_ == 0) revert BadConfig();
        if (feeBps_ > MAX_FEE_BPS || (feeBps_ != 0 && feeRecipient_ == address(0))) revert BadConfig();
        verifier = verifier_;
        refundDelay = refundDelay_;
        feeBps = feeBps_;
        feeRecipient = feeRecipient_;
        admin = admin_;
        emit AdminTransferred(address(0), admin_);
    }

    // ---------- names ----------

    /// @notice Canonical key: lowercase ASCII (punycode for IDNs), no trailing dot. Rejects anything
    /// else so the same domain can never end up with two pools.
    function domainHash(string calldata domain) public pure returns (bytes32) {
        bytes calldata b = bytes(domain);
        uint256 n = b.length;
        if (n == 0 || n > 253) revert BadDomain();
        uint256 label; // length of the current label: 1 to 63, so every accepted name can be proven in DNS
        for (uint256 i; i < n; ++i) {
            bytes1 c = b[i];
            if (c == ".") {
                if (label == 0) revert BadDomain();
                label = 0;
            } else if ((c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c == "-" || c == "_") {
                if (++label > 63) revert BadDomain();
            } else {
                revert BadDomain();
            }
        }
        if (label == 0) revert BadDomain();
        return keccak256(b);
    }

    // ---------- deposits ----------

    function deposit(string calldata domain) external payable nonReentrant {
        if (depositsPaused) revert Paused();
        if (msg.value == 0) revert ZeroAmount();
        _credit(domainHash(domain), domain, address(0), msg.value);
    }

    function depositToken(string calldata domain, address token, uint256 amount) external nonReentrant {
        if (depositsPaused) revert Paused();
        if (token == address(0) || amount == 0) revert ZeroAmount();
        bytes32 d = domainHash(domain);
        uint256 before = IERC20Min(token).balanceOf(address(this));
        _call(token, abi.encodeWithSelector(0x23b872dd, msg.sender, address(this), amount)); // transferFrom
        uint256 received = IERC20Min(token).balanceOf(address(this)) - before;
        if (received == 0) revert ZeroAmount();
        _credit(d, domain, token, received);
    }

    function _credit(bytes32 d, string calldata domain, address token, uint256 amount) private {
        Pool storage p = pools[d][token];
        Deposit storage dep = deposits[d][token][msg.sender];
        if (dep.epoch != p.epoch) {
            dep.amount = 0;
            dep.epoch = p.epoch;
        }
        dep.amount += amount;
        dep.lastAt = uint64(block.timestamp);
        p.balance += amount;
        emit Deposited(d, domain, token, msg.sender, amount);
    }

    // ---------- claims ----------

    /// @notice Pay every listed token's pool to the wallet the domain publishes, proven by `proof`.
    /// Anyone can submit it; the money only goes to `recipient`, which the proof must show.
    function claim(string calldata domain, address recipient, bytes calldata proof, address[] calldata tokens)
        external
        nonReentrant
    {
        bytes32 d = domainHash(domain);
        if (recipient == address(0)) revert BadRecipient();
        uint64 signedAt = verifier.verify(domain, recipient, proof);
        if (signedAt < lastProof[d]) revert StaleProof();
        lastProof[d] = signedAt;

        for (uint256 i; i < tokens.length; ++i) {
            address token = tokens[i];
            Pool storage p = pools[d][token];
            uint256 amount = p.balance;
            if (amount == 0) continue;
            p.balance = 0;
            unchecked {
                ++p.epoch;
            }
            uint256 fee = (amount * feeBps) / 10_000;
            if (fee != 0) feesOwed[token] += fee;
            _send(token, recipient, amount - fee);
            emit Claimed(d, token, recipient, amount - fee, fee);
        }
    }

    // ---------- refunds ----------

    /// @notice Take back an unclaimed deposit after `refundDelay`.
    function refund(string calldata domain, address token) external nonReentrant {
        bytes32 d = domainHash(domain);
        Pool storage p = pools[d][token];
        Deposit storage dep = deposits[d][token][msg.sender];
        uint256 amount = dep.amount;
        if (amount == 0 || dep.epoch != p.epoch) revert NothingToRefund();
        if (block.timestamp < dep.lastAt + refundDelay) revert RefundLocked();

        dep.amount = 0;
        p.balance -= amount;
        _send(token, msg.sender, amount);
        emit Refunded(d, token, msg.sender, amount);
    }

    /// @notice Send accrued claim fees for a token to feeRecipient. Anyone can call it.
    function withdrawFees(address token) external nonReentrant {
        uint256 amount = feesOwed[token];
        if (amount == 0) revert ZeroAmount();
        feesOwed[token] = 0;
        _send(token, feeRecipient, amount);
        emit FeesWithdrawn(token, amount);
    }

    // ---------- admin: pause new deposits, nothing else ----------

    function setDepositsPaused(bool paused) external onlyAdmin {
        depositsPaused = paused;
        emit DepositsPaused(paused);
    }

    function transferAdmin(address to) external onlyAdmin {
        pendingAdmin = to;
        emit AdminTransferStarted(admin, to);
    }

    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert NotAdmin();
        emit AdminTransferred(admin, msg.sender);
        admin = msg.sender;
        pendingAdmin = address(0);
    }

    // ---------- views ----------

    function balanceOf(string calldata domain, address token) external view returns (uint256) {
        return pools[domainHash(domain)][token].balance;
    }

    function refundableOf(string calldata domain, address token, address depositor)
        external
        view
        returns (uint256 amount, uint64 unlocksAt)
    {
        bytes32 d = domainHash(domain);
        Deposit memory dep = deposits[d][token][depositor];
        if (dep.epoch != pools[d][token].epoch) return (0, 0);
        return (dep.amount, dep.lastAt + refundDelay);
    }

    // ---------- transfers ----------

    function _send(address token, address to, uint256 amount) private {
        if (token == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            _call(token, abi.encodeWithSelector(0xa9059cbb, to, amount)); // transfer
        }
    }

    /// @dev Handles tokens that return nothing as well as tokens that return a bool.
    function _call(address token, bytes memory data) private {
        if (token.code.length == 0) revert TransferFailed();
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
