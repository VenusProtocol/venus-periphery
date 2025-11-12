// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.28;

import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { IWBNB } from "../Interfaces.sol";

interface ISwapHelper {
    /// @notice Wrapped native asset
    function WRAPPED_NATIVE() external view returns (IWBNB);

    /// @notice Address authorized to sign multicall operations
    function backendSigner() external view returns (address);

    /// @notice Mapping to track used salts for replay protection
    function usedSalts(bytes32 salt) external view returns (bool);

    /// @notice Multicall function to execute multiple calls in a single transaction
    /// @param calls Array of encoded function calls to execute on this contract
    /// @param deadline Unix timestamp after which the transaction will revert
    /// @param salt Unique value to ensure this exact multicall can only be executed once
    /// @param signature Optional EIP-712 signature from backend signer (empty bytes to skip verification)
    function multicall(
        bytes[] calldata calls,
        uint256 deadline,
        bytes32 salt,
        bytes calldata signature
    ) external payable;

    /// @notice Generic call function to execute a call to an arbitrary address
    /// @param target Address of the contract to call
    /// @param data Encoded function call data
    function genericCall(address target, bytes calldata data) external payable;

    /// @notice Wraps native asset into an ERC-20 wrapped token
    /// @param amount Amount of native asset to wrap (must match msg.value)
    function wrap(uint256 amount) external payable;

    /// @notice Sweeps entire balance of an ERC-20 token to a specified address
    /// @param token ERC-20 token contract to sweep
    /// @param to Recipient address for the swept tokens
    function sweep(IERC20Upgradeable token, address to) external;

    /// @notice Approves maximum amount of an ERC-20 token to a specified spender
    /// @param token ERC-20 token contract to approve
    /// @param spender Address to grant approval to
    function approveMax(IERC20Upgradeable token, address spender) external;

    /// @notice Updates the backend signer address
    /// @param newSigner New backend signer address
    function setBackendSigner(address newSigner) external;
}
