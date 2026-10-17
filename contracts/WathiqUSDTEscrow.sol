// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Wathiq {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @notice Initial ERC-20 escrow for testnet development.
/// @dev NOT audited. Do not use real funds.
contract WathiqUSDTEscrow {
    enum Status { None, Active, Disputed, Released, Refunded }

    struct Deal {
        address buyer;
        address seller;
        address arbiter;
        uint256 amount;
        uint64 deadline;
        Status status;
    }

    IERC20Wathiq public immutable token;
    uint256 public nextDealId = 1;
    mapping(uint256 => Deal) private deals;
    uint256 private entered = 1;

    event DealCreated(
        uint256 indexed dealId,
        address indexed buyer,
        address indexed seller,
        address arbiter,
        uint256 amount,
        uint64 deadline
    );
    event DisputeRaised(uint256 indexed dealId, address indexed raisedBy);
    event DealSettled(
        uint256 indexed dealId,
        Status status,
        address indexed recipient,
        uint256 amount
    );

    error InvalidAddress();
    error InvalidAmount();
    error InvalidDeadline();
    error DealNotFound();
    error DealNotActive();
    error NotAuthorized();
    error DeadlineNotPassed();
    error TokenTransferFailed();
    error FeeOnTransferUnsupported();
    error ReentrantCall();

    modifier nonReentrant() {
        if (entered != 1) revert ReentrantCall();
        entered = 2;
        _;
        entered = 1;
    }

    constructor(address tokenAddress) {
        if (tokenAddress == address(0) || tokenAddress.code.length == 0) {
            revert InvalidAddress();
        }
        token = IERC20Wathiq(tokenAddress);
    }

    function createDeal(
        address seller,
        address arbiter,
        uint256 amount,
        uint64 deadline
    ) external nonReentrant returns (uint256 dealId) {
        if (
            seller == address(0) ||
            arbiter == address(0) ||
            seller == msg.sender ||
            arbiter == msg.sender ||
            arbiter == seller
        ) revert InvalidAddress();

        if (amount == 0) revert InvalidAmount();
        if (deadline <= block.timestamp) revert InvalidDeadline();

        uint256 beforeBalance = token.balanceOf(address(this));
        _safeTransferFrom(msg.sender, address(this), amount);

        uint256 afterBalance = token.balanceOf(address(this));
        if (afterBalance - beforeBalance != amount) {
            revert FeeOnTransferUnsupported();
        }

        dealId = nextDealId++;
        deals[dealId] = Deal({
            buyer: msg.sender,
            seller: seller,
            arbiter: arbiter,
            amount: amount,
            deadline: deadline,
            status: Status.Active
        });

        emit DealCreated(
            dealId, msg.sender, seller, arbiter, amount, deadline
        );
    }

    function releaseToSeller(uint256 dealId) external nonReentrant {
        Deal storage d = _activeDeal(dealId);
        if (msg.sender != d.buyer) revert NotAuthorized();
        _settle(dealId, d, Status.Released, d.seller);
    }

    function raiseDispute(uint256 dealId) external {
        Deal storage d = deals[dealId];
        if (d.status == Status.None) revert DealNotFound();
        if (d.status != Status.Active) revert DealNotActive();
        if (msg.sender != d.buyer && msg.sender != d.seller) {
            revert NotAuthorized();
        }

        d.status = Status.Disputed;
        emit DisputeRaised(dealId, msg.sender);
    }

    function refundAfterDeadline(uint256 dealId) external nonReentrant {
        Deal storage d = _activeDeal(dealId);
        if (msg.sender != d.buyer) revert NotAuthorized();
        if (block.timestamp <= d.deadline) revert DeadlineNotPassed();

        _settle(dealId, d, Status.Refunded, d.buyer);
    }

    function resolveDispute(
        uint256 dealId,
        bool releaseToSeller
    ) external nonReentrant {
        Deal storage d = deals[dealId];
        if (d.status == Status.None) revert DealNotFound();
        if (d.status != Status.Disputed) revert DealNotActive();
        if (msg.sender != d.arbiter) revert NotAuthorized();

        if (releaseToSeller) {
            _settle(dealId, d, Status.Released, d.seller);
        } else {
            _settle(dealId, d, Status.Refunded, d.buyer);
        }
    }

    function getDeal(uint256 dealId) external view returns (Deal memory) {
        Deal memory d = deals[dealId];
        if (d.status == Status.None) revert DealNotFound();
        return d;
    }

    function _activeDeal(
        uint256 dealId
    ) private view returns (Deal storage d) {
        d = deals[dealId];
        if (d.status == Status.None) revert DealNotFound();
        if (d.status != Status.Active) revert DealNotActive();
    }

    function _settle(
        uint256 dealId,
        Deal storage d,
        Status status,
        address recipient
    ) private {
        uint256 amount = d.amount;
        d.amount = 0;
        d.status = status;
        _safeTransfer(recipient, amount);
        emit DealSettled(dealId, status, recipient, amount);
    }

    function _safeTransferFrom(
        address from,
        address to,
        uint256 amount
    ) private {
        (bool ok, bytes memory data) = address(token).call(
            abi.encodeWithSelector(
                IERC20Wathiq.transferFrom.selector, from, to, amount
            )
        );
        if (
            !ok ||
            (data.length != 0 &&
                (data.length < 32 || !abi.decode(data, (bool))))
        ) revert TokenTransferFailed();
    }

    function _safeTransfer(address to, uint256 amount) private {
        (bool ok, bytes memory data) = address(token).call(
            abi.encodeWithSelector(
                IERC20Wathiq.transfer.selector, to, amount
            )
        );
        if (
            !ok ||
            (data.length != 0 &&
                (data.length < 32 || !abi.decode(data, (bool))))
        ) revert TokenTransferFailed();
    }
}
