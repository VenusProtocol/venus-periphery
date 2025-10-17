// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.25;

/**
 * @title ISwapRouter
 * @author Venus Protocol
 * @notice Interface for the SwapRouter contract implementing swap features
 */
interface ISwapRouter {
    /**
     * @notice Swaps tokens and supplies the result to a Venus market
     * @param vToken The vToken market to supply to
     * @param tokenIn The input token to swap from
     * @param amountIn The amount of input tokens to swap
     * @param minAmountOut The minimum amount of output tokens expected
     * @param swapData Array of bytes containing swap instructions
     * @custom:event Emits SwapAndSupply event
     */
    function swapAndSupply(
        address vToken,
        address tokenIn,
        uint256 amountIn,
        uint256 minAmountOut,
        bytes[] calldata swapData
    ) external payable;

    /**
     * @notice Swaps native tokens (BNB) and supplies to a Venus market
     * @param vToken The vToken market to supply to
     * @param minAmountOut The minimum amount of output tokens expected
     * @param swapData Array of bytes containing swap instructions
     * @custom:event Emits SwapAndSupply event
     */
    function swapNativeAndSupply(address vToken, uint256 minAmountOut, bytes[] calldata swapData) external payable;

    /**
     * @notice Swaps tokens and repays debt to a Venus market
     * @param vToken The vToken market to repay debt to
     * @param tokenIn The input token to swap from
     * @param amountIn The amount of input tokens to swap
     * @param minAmountOut The minimum amount of output tokens expected
     * @param swapData Array of bytes containing swap instructions
     * @custom:event Emits SwapAndRepay event
     */
    function swapAndRepay(
        address vToken,
        address tokenIn,
        uint256 amountIn,
        uint256 minAmountOut,
        bytes[] calldata swapData
    ) external payable;

    /**
     * @notice Swaps native tokens and repays debt to a Venus market
     * @param vToken The vToken market to repay debt to
     * @param minAmountOut The minimum amount of output tokens expected
     * @param swapData Array of bytes containing swap instructions
     * @custom:event Emits SwapAndRepay event
     */
    function swapNativeAndRepay(address vToken, uint256 minAmountOut, bytes[] calldata swapData) external payable;

    /**
     * @notice Swaps tokens and repays the full debt for a user
     * @param vToken The vToken market to repay full debt to
     * @param tokenIn The input token to swap from
     * @param maxAmountIn The maximum amount of input tokens to use
     * @param swapData Array of bytes containing swap instructions
     * @custom:event Emits SwapAndRepay event
     */
    function swapAndRepayFull(
        address vToken,
        address tokenIn,
        uint256 maxAmountIn,
        bytes[] calldata swapData
    ) external payable;

    /**
     * @notice Sweeps leftover ERC-20 tokens from the contract
     * @param token The token to sweep
     * @custom:event Emits SweepToken event
     */
    function sweepToken(address token) external;

    /**
     * @notice Sweeps leftover native tokens from the contract
     * @custom:event Emits SweepNative event
     */
    function sweepNative() external;
}
