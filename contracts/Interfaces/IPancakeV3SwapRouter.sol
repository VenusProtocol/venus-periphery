// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.25;

/// @title IPancakeV3SwapRouter
/// @author Venus
/// @notice PancakeSwap V3 SwapRouter, exact-input swaps only
/// @dev bscmainnet: 0x1b81D678ffb9C0263b24A97847620C99d213eB14. PancakeSwap's SmartRouter has no `deadline` in these
///      params, so its `exactInput` has another selector and does not fit this interface.
interface IPancakeV3SwapRouter {
    /**
     * @param path Tokens and pool fees, packed as `tokenIn, fee, tokenOut[, fee, tokenOut...]`
     * @param recipient Receiver of the output
     * @param deadline Unix timestamp after which the swap reverts
     * @param amountIn Input amount
     * @param amountOutMinimum Least output, else the swap reverts
     */
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    /**
     * @notice Sells exactly `params.amountIn` along `params.path`
     * @param params Path, recipient, deadline, input and least output
     * @return amountOut Output amount sent to `params.recipient`
     */
    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}
