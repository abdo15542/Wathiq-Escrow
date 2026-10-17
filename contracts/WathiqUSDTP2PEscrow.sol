// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20WathiqP2P {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @notice P2P USDT escrow prototype. NOT audited. Testnet only; never use real funds.
/// @dev The USDT seller deposits tokens. The buyer reports fiat payment; the seller
/// confirms receipt or either party opens a dispute for the assigned moderator.
contract WathiqUSDTP2PEscrow {
    enum Status { None, Active, PaymentReported, Disputed, Released, Refunded }

    struct Deal {
        address buyer;
        address seller;
        address moderator;
        uint256 amount;
        uint64 paymentDeadline;
        Status status;
    }

    IERC20WathiqP2P public immutable token;
    address public immutable trustedModerator;
    uint256 public nextDealId = 1;
    mapping(uint256 => Deal) private deals;
    uint256 private entered = 1;

    event DealCreated(uint256 indexed dealId, address indexed buyer, address indexed seller, address moderator, uint256 amount, uint64 paymentDeadline);
    event FiatPaymentReported(uint256 indexed dealId, address indexed buyer);
    event DisputeRaised(uint256 indexed dealId, address indexed raisedBy);
    event DealSettled(uint256 indexed dealId, Status status, address indexed recipient, uint256 amount);

    error InvalidAddress();
    error InvalidAmount();
    error InvalidDeadline();
    error DealNotFound();
    error InvalidStatus();
    error NotAuthorized();
    error DeadlineNotPassed();
    error PaymentWindowClosed();
    error TokenTransferFailed();
    error FeeOnTransferUnsupported();
    error ReentrantCall();

    modifier nonReentrant() {
        if (entered != 1) revert ReentrantCall();
        entered = 2;
        _;
        entered = 1;
    }

    constructor(address tokenAddress, address trustedModeratorAddress) {
        if (tokenAddress == address(0) || tokenAddress.code.length == 0 || trustedModeratorAddress == address(0)) revert InvalidAddress();
        token = IERC20WathiqP2P(tokenAddress);
        trustedModerator = trustedModeratorAddress;
    }

    /// @notice Seller creates a deal and locks USDT before the buyer pays fiat.
    function createDeal(address buyer, uint256 amount, uint64 paymentDeadline)
        external nonReentrant returns (uint256 dealId)
    {
        if (buyer == address(0) || buyer == msg.sender || trustedModerator == msg.sender || trustedModerator == buyer) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        if (paymentDeadline <= block.timestamp) revert InvalidDeadline();

        uint256 beforeBalance = token.balanceOf(address(this));
        _safeTransferFrom(msg.sender, address(this), amount);
        uint256 afterBalance = token.balanceOf(address(this));
        if (afterBalance < beforeBalance || afterBalance - beforeBalance != amount) revert FeeOnTransferUnsupported();

        dealId = nextDealId++;
        deals[dealId] = Deal({
            buyer: buyer,
            seller: msg.sender,
            moderator: trustedModerator,
            amount: amount,
            paymentDeadline: paymentDeadline,
            status: Status.Active
        });
        emit DealCreated(dealId, buyer, msg.sender, trustedModerator, amount, paymentDeadline);
    }

    /// @notice Buyer says they sent the agreed fiat payment. This is a claim, not proof.
    function reportFiatPayment(uint256 dealId) external {
        Deal storage d = _deal(dealId);
        if (msg.sender != d.buyer) revert NotAuthorized();
        if (d.status != Status.Active) revert InvalidStatus();
        if (block.timestamp > d.paymentDeadline) revert PaymentWindowClosed();
        d.status = Status.PaymentReported;
        emit FiatPaymentReported(dealId, msg.sender);
    }

    /// @notice Seller confirms fiat receipt; USDT is released to the buyer.
    function confirmFiatReceived(uint256 dealId) external nonReentrant {
        Deal storage d = _deal(dealId);
        if (msg.sender != d.seller) revert NotAuthorized();
        if (d.status != Status.PaymentReported) revert InvalidStatus();
        _settle(dealId, d, Status.Released, d.buyer);
    }

    /// @notice Either party can freeze settlement and request moderator review.
    function raiseDispute(uint256 dealId) external {
        Deal storage d = _deal(dealId);
        if (msg.sender != d.buyer && msg.sender != d.seller) revert NotAuthorized();
        if (d.status != Status.Active && d.status != Status.PaymentReported) revert InvalidStatus();
        d.status = Status.Disputed;
        emit DisputeRaised(dealId, msg.sender);
    }

    /// @notice Seller can reclaim USDT only after deadline, and only if buyer never reported payment.
    function refundUnpaidAfterDeadline(uint256 dealId) external nonReentrant {
        Deal storage d = _deal(dealId);
        if (msg.sender != d.seller) revert NotAuthorized();
        if (d.status != Status.Active) revert InvalidStatus();
        if (block.timestamp <= d.paymentDeadline) revert DeadlineNotPassed();
        _settle(dealId, d, Status.Refunded, d.seller);
    }

    /// @notice The assigned moderator decides a disputed deal. This does not verify bank transfers automatically.
    function resolveDispute(uint256 dealId, bool releaseToBuyer) external nonReentrant {
        Deal storage d = _deal(dealId);
        if (msg.sender != d.moderator) revert NotAuthorized();
        if (d.status != Status.Disputed) revert InvalidStatus();
        if (releaseToBuyer) {
            _settle(dealId, d, Status.Released, d.buyer);
        } else {
            _settle(dealId, d, Status.Refunded, d.seller);
        }
    }

    function getDeal(uint256 dealId) external view returns (Deal memory) {
        return _dealView(dealId);
    }

    function _deal(uint256 dealId) private view returns (Deal storage d) {
        d = deals[dealId];
        if (d.status == Status.None) revert DealNotFound();
    }

    function _dealView(uint256 dealId) private view returns (Deal memory d) {
        d = deals[dealId];
        if (d.status == Status.None) revert DealNotFound();
    }

    function _settle(uint256 dealId, Deal storage d, Status status, address recipient) private {
        uint256 amount = d.amount;
        d.amount = 0;
        d.status = status;
        _safeTransfer(recipient, amount);
        emit DealSettled(dealId, status, recipient, amount);
    }

    function _safeTransferFrom(address from, address to, uint256 amount) private {
        (bool ok, bytes memory data) = address(token).call(
            abi.encodeWithSelector(IERC20WathiqP2P.transferFrom.selector, from, to, amount)
        );
        if (!ok || (data.length != 0 && (data.length < 32 || !abi.decode(data, (bool))))) revert TokenTransferFailed();
    }

    function _safeTransfer(address to, uint256 amount) private {
        (bool ok, bytes memory data) = address(token).call(
            abi.encodeWithSelector(IERC20WathiqP2P.transfer.selector, to, amount)
        );
        if (!ok || (data.length != 0 && (data.length < 32 || !abi.decode(data, (bool))))) revert TokenTransferFailed();
    }
}
