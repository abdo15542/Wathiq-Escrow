// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Native-BNB escrow with 2-of-3 voting and pull-payment withdrawals.
/// @dev This contract is an educational MVP and has not been audited.
contract WathiqEscrow {
    enum Status { None, Funded, Released, Refunded }
    enum Decision { None, Release, Refund }

    struct Deal {
        address payable buyer;
        address payable seller;
        address arbiter;
        uint256 amount;
        uint64 createdAt;
        Status status;
        uint8 releaseVotes;
        uint8 refundVotes;
    }

    uint256 public nextDealId = 1;
    mapping(uint256 => Deal) private deals;
    mapping(uint256 => mapping(address => Decision)) public votes;
    mapping(address => uint256) public pendingWithdrawals;

    event DealCreated(uint256 indexed dealId, address indexed buyer, address indexed seller, address arbiter, uint256 amount);
    event VoteCast(uint256 indexed dealId, address indexed voter, Decision decision, uint8 voteCount);
    event DealSettled(uint256 indexed dealId, Status status, address indexed recipient, uint256 amount);
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

    uint256 private entered = 1;
    modifier nonReentrant() {
        if (entered != 1) revert ReentrantCall();
        entered = 2;
        _;
        entered = 1;
    }

    function createDeal(address payable seller, address arbiter) external payable returns (uint256 dealId) {
        if (seller == address(0) || arbiter == address(0) || seller == msg.sender || arbiter == msg.sender || arbiter == seller) revert InvalidAddress();
        if (msg.value == 0) revert InvalidAmount();
        dealId = nextDealId++;
        deals[dealId] = Deal({
            buyer: payable(msg.sender), seller: seller, arbiter: arbiter,
            amount: msg.value, createdAt: uint64(block.timestamp), status: Status.Funded,
            releaseVotes: 0, refundVotes: 0
        });
        emit DealCreated(dealId, msg.sender, seller, arbiter, msg.value);
    }

    function voteRelease(uint256 dealId) external nonReentrant { _vote(dealId, Decision.Release); }
    function voteRefund(uint256 dealId) external nonReentrant { _vote(dealId, Decision.Refund); }

    /// @notice Withdraw funds credited after a successful 2-of-3 decision.
    /// @dev Pull payments prevent a recipient contract from blocking settlement.
    function withdraw() external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        pendingWithdrawals[msg.sender] = 0;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
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
}
