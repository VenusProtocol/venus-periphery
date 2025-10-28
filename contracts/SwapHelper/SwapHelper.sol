// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

import { SafeERC20Upgradeable, IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import { AddressUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/AddressUpgradeable.sol";

import { IWBNB } from "../Interfaces.sol";

contract SwapHelper {
    using SafeERC20Upgradeable for IERC20Upgradeable;
    using AddressUpgradeable for address;

    uint256 internal constant REENTRANCY_LOCK_UNLOCKED = 1;
    uint256 internal constant REENTRANCY_LOCK_LOCKED = 2;

    /// @notice Wrapped native asset
    IWBNB public immutable WRAPPED_NATIVE;

    /// @dev Reentrancy lock to prevent reentrancy attacks
    uint256 private reentrancyLock;

    /// @notice Error thrown when reentrancy is detected
    error Reentrancy();

    /// @notice In the locked state, allow contract to call itself, but block all external calls
    modifier externalLock() {
        bool isExternal = msg.sender != address(this);

        if (isExternal) {
            if (reentrancyLock == REENTRANCY_LOCK_LOCKED) revert Reentrancy();
            reentrancyLock = REENTRANCY_LOCK_LOCKED;
        }

        _;

        if (isExternal) reentrancyLock = REENTRANCY_LOCK_UNLOCKED;
    }

    constructor(address wrappedNative_) {
        WRAPPED_NATIVE = IWBNB(wrappedNative_);
    }

    /// @notice Multicall function to execute multiple calls in a single transaction
    /// @param data Array of calldata to execute
    function multicall(bytes[] calldata data) external payable {
        for (uint256 i = 0; i < data.length; i++) {
            address(this).functionCall(data[i]);
        }
    }

    /// @notice Generic call function to execute a call to an arbitrary address
    /// @param target Address to call
    /// @param data Calldata to execute
    function genericCall(address target, bytes calldata data) external externalLock {
        target.functionCall(data);
    }

    /// @notice Wraps native asset into an ERC-20 token
    /// @param amount Amount of native asset to wrap
    function wrap(uint256 amount) external externalLock {
        WRAPPED_NATIVE.deposit{ value: amount }();
    }

    /// @notice Sweeps an ERC-20 token to a specified address
    /// @param token ERC-20 token to sweep
    /// @param to Address to send the token to
    function sweep(IERC20Upgradeable token, address to) external externalLock {
        token.safeTransfer(to, token.balanceOf(address(this)));
    }

    /// @notice Approves the maximum amount of an ERC-20 token to a specified address
    /// @param token ERC-20 token to approve
    /// @param spender Address to approve the token to
    function approveMax(IERC20Upgradeable token, address spender) external externalLock {
        token.forceApprove(spender, 0);
        token.forceApprove(spender, type(uint256).max);
    }
}
