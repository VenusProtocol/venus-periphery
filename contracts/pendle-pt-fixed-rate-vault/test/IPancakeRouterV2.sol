// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/**
 * @title IPancakeRouterV2
 * @author PancakeSwap
 * @notice Minimal interface for PancakeSwap V2 Router swap functions.
 *         Only includes methods used by AggregatorMock.
 */
interface IPancakeRouterV2 {
    /**
     * @notice Swap an exact amount of input tokens for as many output tokens as possible.
     * @param amountIn The amount of input tokens to send.
     * @param amountOutMin The minimum amount of output tokens that must be received.
     * @param path An array of token addresses representing the swap route.
     * @param to The recipient address for the output tokens.
     * @param deadline Unix timestamp after which the transaction will revert.
     * @return amounts The input and output token amounts for each step in the path.
     */
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);

    /**
     * @notice Swap an exact amount of input tokens for as much native BNB as possible.
     * @param amountIn The amount of input tokens to send.
     * @param amountOutMin The minimum amount of BNB that must be received.
     * @param path An array of token addresses representing the swap route (last must be WBNB).
     * @param to The recipient address for the native BNB.
     * @param deadline Unix timestamp after which the transaction will revert.
     * @return amounts The input and output token amounts for each step in the path.
     */
    function swapExactTokensForETH(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}
