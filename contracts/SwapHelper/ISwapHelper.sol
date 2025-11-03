// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.28;

import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { IWBNB } from "../Interfaces.sol";

interface ISwapHelper {
    /// @notice Wrapped native asset
    function WRAPPED_NATIVE() external view returns (IWBNB);

    /// @notice Multicall function to execute multiple calls in a single transaction
    /// @param data Array of calldata to execute
    function multicall(bytes[] calldata data) external payable;

    /// @notice Generic call function to execute a call to an arbitrary address
    /// @param target Address to call
    /// @param data Calldata to execute
    function genericCall(address target, bytes calldata data) external;

    /// @notice Wraps native asset into an ERC-20 token
    /// @param amount Amount of native asset to wrap
    function wrap(uint256 amount) external;

    /// @notice Sweeps an ERC-20 token to a specified address
    /// @param token ERC-20 token to sweep
    /// @param to Address to send the token to
    function sweep(IERC20Upgradeable token, address to) external;

    /// @notice Approves the maximum amount of an ERC-20 token to a specified address
    /// @param token ERC-20 token to approve
    /// @param spender Address to approve the token to
    function approveMax(IERC20Upgradeable token, address spender) external;
}
