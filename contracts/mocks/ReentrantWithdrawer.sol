// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IWathiqEscrowWithdraw {
    function withdraw() external;
}

/// @dev Test-only receiver that attempts to re-enter withdraw during its receive callback.
contract ReentrantWithdrawer {
    IWathiqEscrowWithdraw public immutable escrow;
    bool public reentryBlocked;
    bool public reentrySucceeded;
    uint256 public receiveCount;

    constructor(address escrowAddress) {
        escrow = IWathiqEscrowWithdraw(escrowAddress);
    }

    function attack() external {
        escrow.withdraw();
    }

    receive() external payable {
        receiveCount += 1;
        try escrow.withdraw() {
            reentrySucceeded = true;
        } catch {
            reentryBlocked = true;
        }
    }
}
