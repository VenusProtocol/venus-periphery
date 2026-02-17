// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.25;

import { TokenInput, TokenOutput, ApproxParams, LimitOrderData } from "@pendle/core-v2/contracts/interfaces/IPAllActionTypeV3.sol";

/**
 * @title IPendlePTVaultAdapter
 * @author Venus Protocol
 * @notice Interface for the PendlePTVaultAdapter contract.
 * @dev Universal adapter that wraps Pendle PT swap and Venus Core deposit/redeem into single
 *      transactions. Users deposit tokens (e.g. USDC, BNB) and receive Venus vTokens.
 *      A single adapter handles all PT markets via an internal market registry.
 *      The adapter does NOT hold user funds or track user positions — all user accounting is
 *      managed by Venus vTokens. The contract should hold zero token balances between transactions.
 */
interface IPendlePTVaultAdapter {
    // ═══════════════════════════════════════════════════════════════════════
    //                              STRUCTS
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Configuration for a registered Pendle PT market.
     * @param pt Principal Token address
     * @param sy Standardized Yield token address
     * @param yt Yield Token address (needed for maturity redemption)
     * @param vToken Venus VToken market address for this PT
     * @param comptroller Venus Comptroller address for the isolated pool
     * @param isActive Whether this market is currently accepting deposits/withdrawals
     * @param maturity PT expiry timestamp (Unix timestamp)
     * @dev Accepts any token from Pendle's tokensIn/tokensOut arrays
     */
    struct MarketConfig {
        address pt;
        address sy;
        address yt;
        address vToken;
        address comptroller;
        bool isActive;
        uint256 maturity;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              EVENTS
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Emitted when a new PT market is registered in the adapter.
     * @param pendleMarket Pendle market address that was registered
     * @param pt Principal Token address
     * @param vToken Venus VToken market address
     * @param comptroller Venus Comptroller address
     * @param maturity PT maturity timestamp
     */
    event MarketAdded(
        address indexed pendleMarket,
        address indexed pt,
        address vToken,
        address comptroller,
        uint256 maturity
    );

    /**
     * @notice Emitted when a market is deactivated by admin.
     * @param pendleMarket Pendle market address that was deactivated
     */
    event MarketDeactivated(address indexed pendleMarket);

    /**
     * @notice Emitted when a previously deactivated market is re-activated.
     * @param pendleMarket Pendle market address that was activated
     */
    event MarketActivated(address indexed pendleMarket);

    /**
     * @notice Emitted when a user deposits tokens and receives vTokens.
     * @param pendleMarket Pendle market address used for the deposit
     * @param user Address of the user who deposited
     * @param tokenIn The actual token address that was deposited
     * @param amountIn Amount of input tokens deposited by user
     * @param ptAmount Amount of PT tokens received from Pendle swap
     * @param vTokenAmount Amount of vTokens minted to the user
     */
    event Deposited(
        address indexed pendleMarket,
        address indexed user,
        address tokenIn,
        uint256 amountIn,
        uint256 indexed ptAmount,
        uint256 vTokenAmount
    );

    /**
     * @notice Emitted when a user withdraws (before maturity) by selling PT on Pendle AMM.
     * @param pendleMarket Pendle market address used for the withdrawal
     * @param user Address of the user who withdrew
     * @param vTokenAmount Amount of vTokens redeemed
     * @param ptAmount Amount of PT tokens sold on Pendle
     * @param tokenOut The actual token address that was received
     * @param amountOut Amount of output tokens received by user
     */
    event Withdrawn(
        address indexed pendleMarket,
        address indexed user,
        uint256 vTokenAmount,
        uint256 indexed ptAmount,
        address tokenOut,
        uint256 amountOut
    );

    /**
     * @notice Emitted when a user redeems at or after maturity (1:1 redemption via SY).
     * @param pendleMarket Pendle market address used for the redemption
     * @param user Address of the user who redeemed
     * @param vTokenAmount Amount of vTokens redeemed
     * @param ptAmount Amount of PT tokens redeemed
     * @param tokenOut The actual token address that was received
     * @param amountOut Amount of output tokens received by user
     */
    event RedeemedAtMaturity(
        address indexed pendleMarket,
        address indexed user,
        uint256 vTokenAmount,
        uint256 indexed ptAmount,
        address tokenOut,
        uint256 amountOut
    );

    // ═══════════════════════════════════════════════════════════════════════
    //                           CUSTOM ERRORS
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Error thrown when a zero amount is provided as input.
    error ZeroAmount();

    /// @notice Error thrown when a zero address is provided where a valid address is required.
    error ZeroAddress();

    /**
     * @notice Error thrown when the transaction deadline has been exceeded.
     * @param deadline The deadline timestamp that was set
     * @param currentTime The current block timestamp
     */
    error DeadlineExceeded(uint256 deadline, uint256 currentTime);

    /**
     * @notice Error thrown when attempting to interact with a market that has not been registered.
     * @param pendleMarket The Pendle market address that is not registered
     */
    error MarketNotRegistered(address pendleMarket);

    /**
     * @notice Error thrown when attempting to interact with a market that has been deactivated.
     * @param pendleMarket The Pendle market address that is not active
     */
    error MarketNotActive(address pendleMarket);

    /**
     * @notice Error thrown when attempting to register a market that is already registered.
     * @param pendleMarket The Pendle market address that is already registered
     */
    error MarketAlreadyRegistered(address pendleMarket);

    /**
     * @notice Error thrown when attempting an operation that requires the market to be matured but it hasn't matured yet.
     * @param maturity The maturity timestamp of the PT
     * @param currentTime The current block timestamp
     */
    error MarketNotMatured(uint256 maturity, uint256 currentTime);

    /// @notice Error thrown when the TokenInput tokenIn is the zero address.
    error InvalidTokenInput();

    /// @notice Error thrown when the TokenOutput tokenOut is the zero address.
    error InvalidTokenOutput();

    /// @notice Error thrown when native deposit/withdraw calldata has tokenIn/tokenOut != WBNB.
    error TokenMustBeWBNB();

    /**
     * @notice Error thrown when the input amount in the calldata does not match the amount parameter.
     * @param expected The expected amount
     * @param received The amount provided in the calldata
     */
    error InputAmountMismatch(uint256 expected, uint256 received);

    /**
     * @notice Error thrown when Venus VToken mint operation fails.
     * @param errorCode The error code returned by the VToken contract
     */
    error VTokenMintFailed(uint256 errorCode);

    /**
     * @notice Error thrown when Venus VToken redeem operation fails.
     * @param errorCode The error code returned by the VToken contract
     */
    error VTokenRedeemFailed(uint256 errorCode);

    // ═══════════════════════════════════════════════════════════════════════
    //                        CORE FUNCTIONS — ERC-20
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Deposit tokenIn → swap to PT via Pendle → deposit PT into Venus → user receives vTokens.
     * @dev User must approve this adapter for `amount` of tokenIn beforehand.
     *      The contract will be paused during emergency situations.
     * @param pendleMarket Pendle market address identifying the PT market
     * @param amount Amount of tokenIn to deposit
     * @param minPtOut Minimum PT to receive from Pendle swap (slippage protection)
     * @param guessPtOut Off-chain binary search hint from the Pendle API (saves ~180k gas)
     * @param input Token routing configuration from the Pendle API
     * @param limit Limit order fill data (can be empty struct for simple swaps)
     * @return netVTokensMinted Amount of vTokens credited to the user
     */
    function deposit(
        address pendleMarket,
        uint256 amount,
        uint256 minPtOut,
        ApproxParams calldata guessPtOut,
        TokenInput calldata input,
        LimitOrderData calldata limit
    ) external returns (uint256 netVTokensMinted);

    /**
     * @notice Withdraw before maturity: redeem vTokens → sell PT on Pendle AMM → user receives tokenOut.
     * @dev User must have delegated to this adapter in the Comptroller beforehand.
     *      PT is sold on the Pendle AMM at current market price (subject to slippage).
     * @param pendleMarket Pendle market address
     * @param vTokenAmount Amount of vTokens to redeem
     * @param output Token routing configuration from the Pendle API
     * @param limit Limit order fill data (can be empty struct)
     * @return netTokenOut Amount of output tokens received by the user
     */
    function withdraw(
        address pendleMarket,
        uint256 vTokenAmount,
        TokenOutput calldata output,
        LimitOrderData calldata limit
    ) external returns (uint256 netTokenOut);

    /**
     * @notice Redeem at or after maturity: redeem vTokens → redeem PT 1:1 via SY → user receives tokenOut.
     * @dev No AMM swap — PT is redeemed directly through SY at 1:1 ratio (no price impact).
     *      User must have delegated to this adapter in the Comptroller beforehand.
     * @param pendleMarket Pendle market address
     * @param vTokenAmount Amount of vTokens to redeem
     * @param deadline Transaction deadline timestamp (reverts if exceeded)
     * @param output Token routing configuration from the Pendle API
     * @return netTokenOut Amount of output tokens received by the user
     */
    function redeemAtMaturity(
        address pendleMarket,
        uint256 vTokenAmount,
        uint256 deadline,
        TokenOutput calldata output
    ) external returns (uint256 netTokenOut);

    // ═══════════════════════════════════════════════════════════════════════
    //                    CORE FUNCTIONS — NATIVE TOKEN
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Deposit native BNB → swap to PT via Pendle Router → deposit PT into Venus → user receives vTokens.
     * @dev Passes native BNB directly to Pendle Router (payable) without wrapping to WBNB.
     *      Any excess native BNB or WBNB is refunded to the user.
     * @param pendleMarket Pendle market address identifying the PT market
     * @param minPtOut Minimum PT to receive from Pendle swap (slippage protection)
     * @param guessPtOut Off-chain binary search hint from the Pendle API
     * @param input Token routing configuration from the Pendle API
     * @param limit Limit order fill data (can be empty struct)
     * @return netVTokensMinted Amount of vTokens credited to the user
     */
    function depositNative(
        address pendleMarket,
        uint256 minPtOut,
        ApproxParams calldata guessPtOut,
        TokenInput calldata input,
        LimitOrderData calldata limit
    ) external payable returns (uint256 netVTokensMinted);

    /**
     * @notice Withdraw before maturity with native BNB: redeem vTokens → sell PT → unwrap WBNB → user receives BNB.
     * @dev Unwraps WBNB to native BNB after withdrawal from Pendle.
     *      The output.tokenOut must be WBNB for this function.
     *      User must have delegated to this adapter in the Comptroller beforehand.
     * @param pendleMarket Pendle market address
     * @param vTokenAmount Amount of vTokens to redeem
     * @param output Token routing configuration from the Pendle API (tokenOut must be WBNB)
     * @param limit Limit order fill data (can be empty struct)
     * @return netTokenOut Amount of native BNB received by the user
     */
    function withdrawNative(
        address pendleMarket,
        uint256 vTokenAmount,
        TokenOutput calldata output,
        LimitOrderData calldata limit
    ) external returns (uint256 netTokenOut);

    /**
     * @notice Redeem at maturity with native BNB: redeem vTokens → redeem PT 1:1 → unwrap WBNB → user receives BNB.
     * @dev Unwraps WBNB to native BNB after redemption from Pendle.
     *      The output.tokenOut must be WBNB for this function.
     *      No AMM swap — PT is redeemed directly through SY at 1:1 ratio.
     *      User must have delegated to this adapter in the Comptroller beforehand.
     * @param pendleMarket Pendle market address
     * @param vTokenAmount Amount of vTokens to redeem
     * @param deadline Transaction deadline timestamp
     * @param output Token routing configuration from the Pendle API (tokenOut must be WBNB)
     * @return netTokenOut Amount of native BNB received by the user
     */
    function redeemAtMaturityNative(
        address pendleMarket,
        uint256 vTokenAmount,
        uint256 deadline,
        TokenOutput calldata output
    ) external returns (uint256 netTokenOut);

    // ═══════════════════════════════════════════════════════════════════════
    //                          ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Register a new PT market. Derives PT, SY, YT, and maturity from the Pendle market on-chain.
     * @dev Only callable by the contract owner.
     *      Reads token addresses and maturity directly from the Pendle market contract.
     *      Accepts any token from Pendle's tokensIn array for deposits.
     * @param pendleMarket Pendle AMM market address to register
     * @param vToken Venus VToken market address for this PT
     * @param comptroller Venus Comptroller address for the isolated pool
     */
    function addMarket(address pendleMarket, address vToken, address comptroller) external;

    /**
     * @notice Deactivate a market (blocks new deposits and withdrawals).
     * @dev Only callable by the contract owner.
     *      Deactivation prevents new operations but does not affect existing user positions.
     * @param pendleMarket Pendle market address to deactivate
     */
    function deactivateMarket(address pendleMarket) external;

    /**
     * @notice Re-activate a previously deactivated market.
     * @dev Only callable by the contract owner.
     * @param pendleMarket Pendle market address to activate
     */
    function activateMarket(address pendleMarket) external;

    /**
     * @notice Pause all deposit/withdraw operations (emergency).
     * @dev Only callable by the contract owner.
     *      When paused, all user-facing functions revert.
     */
    function pause() external;

    /**
     * @notice Unpause operations.
     * @dev Only callable by the contract owner.
     */
    function unpause() external;

    /**
     * @notice Recover tokens accidentally sent to the contract.
     * @dev Only callable by the contract owner.
     *      Should only be used for recovering mistakenly sent tokens.
     *      The contract should hold zero balances during normal operations.
     * @param token ERC-20 token address to sweep
     * @param to Recipient address
     * @param amount Amount to transfer
     */
    function sweepTokens(address token, address to, uint256 amount) external;

    // ═══════════════════════════════════════════════════════════════════════
    //                          VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Get full configuration for a registered market.
     * @param pendleMarket Pendle market address
     * @return Full MarketConfig struct containing all market parameters
     */
    function getMarketConfig(address pendleMarket) external view returns (MarketConfig memory);

    /**
     * @notice Get the number of registered markets.
     * @return Total count of markets registered in the adapter
     */
    function getMarketCount() external view returns (uint256);

    /**
     * @notice Get all registered market addresses.
     * @return Array of all registered Pendle market addresses
     */
    function getAllMarkets() external view returns (address[] memory);

    /**
     * @notice Check if a specific PT market has matured.
     * @param pendleMarket Pendle market address
     * @return True if the current timestamp is at or past the market's maturity
     */
    function isMatured(address pendleMarket) external view returns (bool);

    /**
     * @notice Check if a user has delegated to this adapter for a specific market's Comptroller.
     * @dev Delegation is required for both deposit (enterMarketBehalf) and withdraw (redeemBehalf).
     *      Users must call Comptroller.updateDelegate(adapter, true) before using the adapter.
     * @param pendleMarket Pendle market address
     * @param user User address to check
     * @return True if the user has approved this adapter as a delegate
     */
    function isDelegated(address pendleMarket, address user) external view returns (bool);

    /**
     * @notice Get the immutable Pendle Router address.
     * @return Pendle RouterV4 address used for all PT swaps and redemptions
     */
    function PENDLE_ROUTER() external view returns (address);

    /**
     * @notice Get the immutable WBNB address.
     * @return Wrapped native token (WBNB) address
     */
    function WBNB() external view returns (address);
}
