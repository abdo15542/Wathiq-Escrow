// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice ERC-20 escrow primitive for testnet integration; NOT audited.
/// @dev Use only with a trusted token contract. This contract deliberately has no admin key.
contract WathiqUSDTEscrow {
    enum Status { None, Funded, Released, Refunded }
    enum Decision { None, Release, Refund }

    struct Deal {
        address buyer;
        address seller;
        address arbiter;
        uint256 amount;
        uint64 createdAt;
        Status status;
        uint8 releaseVotes;
        uint8 refundVotes;
    }

    IERC20Minimal public immutable token;
    uint256 public nextDealId = 1;
    mapping(uint256 => Deal) private deals;
    mapping(uint256 => mapping(address => Decision)) public votes;
    mapping(address => uint256) public pendingWithdrawals;

    uint256 public constant REFUND_TIMEOUT = 30 days;

    event DealCreated(uint256 indexed dealId, address indexed buyer, address indexed seller, address arbiter, uint256 amount);
    event VoteCast(uint256 indexed dealId, address indexed voter, Decision decision, uint8 voteCount);
    event DealSettled(uint256 indexed dealId, Status status, address indexed recipient, uint256 amount);
    event ExpiredDealRefunded(uint256 indexed dealId, address indexed buyer, uint256 amount);
    event Withdrawal(address indexed account, uint256 amount);

    error InvalidAddress();
    error InvalidAmount();
    error DealNotFound();
    error DealNotActive();
    error NotParticipant();
    error AlreadyVoted();
    error TransferFailed();
    error ReentrantCall();
    error NothingToWithdraw();
    error DealNotExpired();
    error UnsupportedTokenBehavior();

    uint256 private entered = 1;
    modifier nonReentrant() {
        if (entered != 1) revert ReentrantCall();
        entered = 2;
        _;
        entered = 1;
    }

    constructor(address tokenAddress) {
        if (tokenAddress == address(0) || tokenAddress.code.length == 0) revert InvalidAddress();
        token = IERC20Minimal(tokenAddress);
    }

    function createDeal(address seller, address arbiter, uint256 amount) external nonReentrant returns (uint256 dealId) {
        if (seller == address(0) || arbiter == address(0) || seller == msg.sender || arbiter == msg.sender || arbiter == seller) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();

        uint256 beforeBalance = token.balanceOf(address(this));
        _safeTransferFrom(msg.sender, address(this), amount);
        uint256 afterBalance = token.balanceOf(address(this));
        if (afterBalance < beforeBalance || afterBalance - beforeBalance != amount) revert UnsupportedTokenBehavior();

        dealId = nextDealId++;
        deals[dealId] = Deal({
            buyer: msg.sender,
            seller: seller,
            arbiter: arbiter,
            amount: amount,
            createdAt: uint64(block.timestamp),
            status: Status.Funded,
            releaseVotes: 0,
            refundVotes: 0
        });
        emit DealCreated(dealId, msg.sender, seller, arbiter, amount);
    }

    function voteRelease(uint256 dealId) external nonReentrant { _vote(dealId, Decision.Release); }
    function voteRefund(uint256 dealId) external nonReentrant { _vote(dealId, Decision.Refund); }

    /// @notice If the parties do not reach two matching votes, anyone can trigger a refund to buyer after 30 days.
    /// @dev This timeout is a product policy choice, not proof that the buyer is entitled to a refund.
    function refundExpired(uint256 dealId) external nonReentrant {
        Deal storage d = deals[dealId];
        if (d.status == Status.None) revert DealNotFound();
        if (d.status != Status.Funded) revert DealNotActive();
        if (block.timestamp < uint256(d.createdAt) + REFUND_TIMEOUT) revert DealNotExpired();
        uint256 amount = d.amount;
        d.amount = 0;
        d.status = Status.Refunded;
        pendingWithdrawals[d.buyer] += amount;
        emit ExpiredDealRefunded(dealId, d.buyer, amount);
        emit DealSettled(dealId, Status.Refunded, d.buyer, amount);
    }

    function withdraw() external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        pendingWithdrawals[msg.sender] = 0;
        _safeTransfer(msg.sender, amount);
        emit Withdrawal(msg.sender, amount);
    }

    function getDeal(uint256 dealId) external view returns (Deal memory) {
        Deal memory d = deals[dealId];
        if (d.status == Status.None) revert DealNotFound();
        return d;
    }

    function _vote(uint256 dealId, Decision decision) private {
        Deal storage d = deals[dealId];
        if (d.status == Status.None) revert DealNotFound();
        if (d.status != Status.Funded) revert DealNotActive();
        if (msg.sender != d.buyer && msg.sender != d.seller && msg.sender != d.arbiter) revert NotParticipant();
        if (votes[dealId][msg.sender] != Decision.None) revert AlreadyVoted();

        votes[dealId][msg.sender] = decision;
        uint8 count;
        if (decision == Decision.Release) count = ++d.releaseVotes;
        else count = ++d.refundVotes;
        emit VoteCast(dealId, msg.sender, decision, count);
        if (count >= 2) _settle(dealId, d, decision);
    }

    function _settle(uint256 dealId, Deal storage d, Decision decision) private {
        uint256 amount = d.amount;
        d.amount = 0;
        address recipient;
        if (decision == Decision.Release) {
            d.status = Status.Released;
            recipient = d.seller;
        } else {
            d.status = Status.Refunded;
            recipient = d.buyer;
        }
        pendingWithdrawals[recipient] += amount;
        emit DealSettled(dealId, d.status, recipient, amount);
    }

    function _safeTransfer(address to, uint256 amount) private {
        (bool ok, bytes memory data) = address(token).call(abi.encodeWithSelector(IERC20Minimal.transfer.selector, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(address from, address to, uint256 amount) private {
        (bool ok, bytes memory data) = address(token).call(abi.encodeWithSelector(IERC20Minimal.transferFrom.selector, from, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}

interface IERC20Minimal {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}
