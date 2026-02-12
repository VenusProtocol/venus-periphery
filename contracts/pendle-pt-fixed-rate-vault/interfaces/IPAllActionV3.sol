// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.25;

/// @title Pendle Structs & Router Interface
/// @notice Minimal types and interface for Pendle RouterV4 (IPAllActionV3) used by PendlePTVaultAdapter.
/// @dev Struct definitions match pendle-core-v2-public exactly for ABI compatibility.

// ═══════════════════════════════════════════════════════════════════════════
//                          SWAP AGGREGATOR TYPES
// ═══════════════════════════════════════════════════════════════════════════

enum SwapType {
    NONE,
    KYBERSWAP,
    ONE_INCH,
    ETH_WETH
}

struct SwapData {
    SwapType swapType;
    address extRouter;
    bytes extCalldata;
    bool needScale;
}

// ═══════════════════════════════════════════════════════════════════════════
//                          TOKEN INPUT / OUTPUT
// ═══════════════════════════════════════════════════════════════════════════

struct TokenInput {
    address tokenIn;
    uint256 netTokenIn;
    address tokenMintSy;
    address pendleSwap;
    SwapData swapData;
}

struct TokenOutput {
    address tokenOut;
    uint256 minTokenOut;
    address tokenRedeemSy;
    address pendleSwap;
    SwapData swapData;
}

// ═══════════════════════════════════════════════════════════════════════════
//                          APPROXIMATION PARAMS
// ═══════════════════════════════════════════════════════════════════════════

struct ApproxParams {
    uint256 guessMin;
    uint256 guessMax;
    uint256 guessOffchain;
    uint256 maxIteration;
    uint256 eps;
}

// ═══════════════════════════════════════════════════════════════════════════
//                          LIMIT ORDER TYPES
// ═══════════════════════════════════════════════════════════════════════════

enum OrderType {
    SY_FOR_PT,
    PT_FOR_SY,
    SY_FOR_YT,
    YT_FOR_SY
}

struct Order {
    uint256 salt;
    uint256 expiry;
    uint256 nonce;
    OrderType orderType;
    address token;
    address YT;
    address maker;
    address receiver;
    uint256 makingAmount;
    uint256 lnImpliedRate;
    uint256 failSafeRate;
    bytes permit;
}

struct FillOrderParams {
    Order order;
    bytes signature;
    uint256 makingAmount;
}

struct LimitOrderData {
    address limitRouter;
    uint256 epsSkipMarket;
    FillOrderParams[] normalFills;
    FillOrderParams[] flashFills;
    bytes optData;
}

// ═══════════════════════════════════════════════════════════════════════════
//                          ROUTER INTERFACE
// ═══════════════════════════════════════════════════════════════════════════

/// @notice Minimal Pendle RouterV4 interface (IPAllActionV3).
/// @dev Only includes functions used by the adapter.
interface IPAllActionV3 {
    /// @notice Swap exact underlying token amount for PT via Pendle AMM.
    function swapExactTokenForPt(
        address receiver,
        address market,
        uint256 minPtOut,
        ApproxParams calldata guessPtOut,
        TokenInput calldata input,
        LimitOrderData calldata limit
    ) external payable returns (uint256 netPtOut, uint256 netSyFee, uint256 netSyInterm);

    /// @notice Swap exact PT amount for underlying token via Pendle AMM (before maturity).
    function swapExactPtForToken(
        address receiver,
        address market,
        uint256 exactPtIn,
        TokenOutput calldata output,
        LimitOrderData calldata limit
    ) external returns (uint256 netTokenOut, uint256 netSyFee, uint256 netSyInterm);

    /// @notice Redeem PT 1:1 for underlying via SY (at or after maturity).
    function redeemPyToToken(
        address receiver,
        address YT,
        uint256 netPyIn,
        TokenOutput calldata output
    ) external returns (uint256 netTokenOut, uint256 netSyInterm);
}
