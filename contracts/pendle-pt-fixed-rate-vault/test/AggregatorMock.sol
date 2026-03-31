// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { IPancakeRouterV2 } from "./IPancakeRouterV2.sol";

/**
 * @title AggregatorMock
 * @author Mock
 * @notice Drop-in replacement for KyberSwap MetaAggregationRouterV2 used in
 *         fork tests via hardhat_setCode.
 *
 *         The real KyberSwap executor enforces a signature over its swap data,
 *         which becomes invalid after any calldata patching (e.g. deadline fix).
 *         This mock bypasses the executor entirely and performs a direct swap
 *         through PancakeSwap V2, which we can control the deadline for.
 *
 *         Supports both ERC-20 and native BNB output:
 *           - ERC-20 dstToken: swapExactTokensForTokens
 *           - Native BNB dstToken (0xEeee…EE): swapExactTokensForETH via WBNB
 *
 *         Deployed at the KyberSwap router address — PendleSwap calls us with
 *         the same `swap(SwapExecutionParams)` selector.
 */
contract AggregatorMock {
    using SafeERC20 for IERC20;

    struct SwapDescriptionV2 {
        IERC20 srcToken;
        IERC20 dstToken;
        address[] srcReceivers;
        uint256[] srcAmounts;
        address[] feeReceivers;
        uint256[] feeAmounts;
        address dstReceiver;
        uint256 amount;
        uint256 minReturnAmount;
        uint256 flags;
        bytes permit;
    }

    struct SwapExecutionParams {
        address callTarget;
        address approveTarget;
        bytes targetData;
        SwapDescriptionV2 desc;
        bytes clientData;
    }

    // BSC PancakeSwap V2 Router
    address private constant PANCAKE_ROUTER = 0x10ED43C718714eb63d5aA57B78B54704E256024E;

    // BSC WBNB (used as intermediate for native BNB output path)
    address private constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;

    // KyberSwap / aggregator sentinel for native BNB on BSC
    address private constant NATIVE_BNB_SENTINEL = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    /**
     * @notice Accept native BNB (required for Pendle Router refunds during depositNative).
     */
    receive() external payable {}

    /**
     * @notice Matches KyberSwap MetaAggregationRouterV2.swap() signature.
     *         Ignores callTarget/targetData (executor + signed data) and
     *         performs a direct PancakeSwap V2 swap: srcToken → dstToken.
     * @param execution The swap execution parameters, including the swap description.
     * @return returnAmount The amount of dstToken received from the swap.
     * @return gasUsed The amount of gas used for the swap (always 0 in this mock).
     */
    function swap(
        SwapExecutionParams calldata execution
    ) external payable returns (uint256 returnAmount, uint256 gasUsed) {
        SwapDescriptionV2 memory desc = execution.desc;
        address dstReceiver = desc.dstReceiver == address(0) ? msg.sender : desc.dstReceiver;

        bool isNativeBnbOut = address(desc.dstToken) == NATIVE_BNB_SENTINEL;

        // Pull srcToken from msg.sender (PendleSwap has approved us)
        desc.srcToken.safeTransferFrom(msg.sender, address(this), desc.amount);

        uint256 initialDstBalance = isNativeBnbOut ? dstReceiver.balance : IERC20(desc.dstToken).balanceOf(dstReceiver);

        // Approve PancakeSwap V2 router
        desc.srcToken.safeApprove(PANCAKE_ROUTER, 0);
        desc.srcToken.safeApprove(PANCAKE_ROUTER, desc.amount);

        // Route through PancakeSwap V2 (amountOutMin=0 — Pendle router enforces minTokenOut)
        _executePancakeSwap(desc, dstReceiver, isNativeBnbOut);

        uint256 finalDstBalance = isNativeBnbOut ? dstReceiver.balance : IERC20(desc.dstToken).balanceOf(dstReceiver);

        returnAmount = finalDstBalance - initialDstBalance;
        return (returnAmount, 0);
    }

    /**
     * @notice Routes the swap through PancakeSwap V2.
     * @param desc The swap description containing srcToken, dstToken, and amount.
     * @param dstReceiver The address to receive the output tokens.
     * @param isNativeBnbOut Whether the output is native BNB (vs ERC-20).
     */
    function _executePancakeSwap(SwapDescriptionV2 memory desc, address dstReceiver, bool isNativeBnbOut) private {
        if (isNativeBnbOut) {
            // Native BNB output: srcToken → WBNB → unwrap → native BNB
            address[] memory path = new address[](2);
            path[0] = address(desc.srcToken);
            path[1] = WBNB;

            IPancakeRouterV2(PANCAKE_ROUTER).swapExactTokensForETH(
                desc.amount,
                0,
                path,
                dstReceiver,
                type(uint256).max
            );
        } else {
            // ERC-20 output: srcToken → dstToken
            address[] memory path = new address[](2);
            path[0] = address(desc.srcToken);
            path[1] = address(desc.dstToken);

            IPancakeRouterV2(PANCAKE_ROUTER).swapExactTokensForTokens(
                desc.amount,
                0,
                path,
                dstReceiver,
                type(uint256).max
            );
        }
    }
}
