// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.25;

import { TokenInput, TokenOutput, ApproxParams, LimitOrderData } from "./IPAllActionV3.sol";

/**
 * @title IPendlePTVaultAdapter
 * @author Venus Protocol
 * @notice Interface for the PendlePTVaultAdapter contract.
 * @dev Universal adapter that wraps Pendle PT swap and Venus Core deposit/redeem into single
 *      transactions. Users deposit underlying tokens (e.g. USDC, BNB) and receive Venus vTokens.
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
     * @param underlying User-facing token address (USDC, WBNB)
     * @param vToken Venus VToken market address for this PT
     * @param comptroller Venus Comptroller address for the isolated pool
     * @param isActive Whether this market is currently accepting deposits/withdrawals
     * @param maturity PT expiry timestamp (Unix timestamp)
     */
    struct MarketConfig {
        address pt;
        address sy;
        address yt;
        address underlying;
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
     * @param underlying User-facing underlying token address
     * @param pt Principal Token address
     * @param vToken Venus VToken market address
     * @param comptroller Venus Comptroller address
     * @param maturity PT maturity timestamp
     */
    event MarketAdded(
        address indexed pendleMarket,
        address indexed underlying,
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
     * @notice Emitted when a user deposits underlying tokens and receives vTokens.
     * @param pendleMarket Pendle market address used for the deposit
     * @param user Address of the user who deposited
     * @param underlyingAmount Amount of underlying tokens deposited by user
     * @param ptAmount Amount of PT tokens received from Pendle swap
     * @param vTokenAmount Amount of vTokens minted to the user
     */
    event Deposited(
        address indexed pendleMarket,
        address user,
        uint256 indexed underlyingAmount,
        uint256 indexed ptAmount,
        uint256 vTokenAmount
    );

    /**
     * @notice Emitted when a user withdraws (before maturity) by selling PT on Pendle AMM.
     * @param pendleMarket Pendle market address used for the withdrawal
     * @param user Address of the user who withdrew
     * @param vTokenAmount Amount of vTokens redeemed
     * @param ptAmount Amount of PT tokens sold on Pendle
     * @param underlyingAmount Amount of underlying tokens received by user
     */
    event Withdrawn(
        address indexed pendleMarket,
        address user,
        uint256 vTokenAmount,
        uint256 indexed ptAmount,
        uint256 indexed underlyingAmount
    );

    /**
     * @notice Emitted when a user redeems at or after maturity (1:1 redemption via SY).
     * @param pendleMarket Pendle market address used for the redemption
     * @param user Address of the user who redeemed
     * @param vTokenAmount Amount of vTokens redeemed
     * @param ptAmount Amount of PT tokens redeemed
     * @param underlyingAmount Amount of underlying tokens received by user
     */
    event RedeemedAtMaturity(
        address indexed pendleMarket,
        address user,
        uint256 vTokenAmount,
        uint256 indexed ptAmount,
        uint256 indexed underlyingAmount
    );

    // ═══════════════════════════════════════════════════════════════════════
    //                           CUSTOM ERRORS
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Error thrown when a zero amount is provided as input.
    error ZeroAmount();

    /// @notice Error thrown when a zero address is provided where a valid address is required.
    error ZeroAddress();

    /// @notice Error thrown when an unauthorized sender attempts a restricted operation.
    error UnauthorizedSender();

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

    /**
     * @notice Error thrown when attempting to deposit into a market that has already matured.
     * @param maturity The maturity timestamp of the PT
     * @param currentTime The current block timestamp
     */
    error MarketAlreadyMatured(uint256 maturity, uint256 currentTime);

    /**
     * @notice Error thrown when the input token in the TokenInput calldata does not match the expected underlying token.
     * @param expected The expected underlying token address
     * @param received The token address provided in the calldata
     */
    error InvalidTokenInput(address expected, address received);

    /**
     * @notice Error thrown when the output token in the TokenOutput calldata does not match the expected underlying token.
     * @param expected The expected underlying token address
     * @param received The token address provided in the calldata
     */
    error InvalidTokenOutput(address expected, address received);

    /**
     * @notice Error thrown when the input amount in the calldata does not match the amount parameter.
     * @param expected The expected amount
     * @param received The amount provided in the calldata
     */
    error InputAmountMismatch(uint256 expected, uint256 received);

    /**
     * @notice Error thrown when attempting to use native token functions on a non-native (non-WBNB) market.
     * @param pendleMarket The Pendle market address that does not support native token operations
     */
    error NotNativeMarket(address pendleMarket);

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
     * @notice Deposit underlying tokens → swap to PT via Pendle → deposit PT into Venus → user receives vTokens.
     * @dev User must approve this adapter for `amount` of the underlying token beforehand.
     *      The contract will be paused during emergency situations.
     *      Only active markets (before maturity) can accept deposits.
     * @param pendleMarket Pendle market address identifying the PT market
     * @param amount Amount of underlying tokens to deposit
     * @param minPtOut Minimum PT to receive from Pendle swap (slippage protection)
     * @param guessPtOut Off-chain binary search hint from the Pendle API (saves ~180k gas)
     * @param input Token routing configuration from the Pendle API
     * @param limit Limit order fill data (can be empty struct for simple swaps)
     * @return netVTokensMinted Amount of vTokens credited to the user
     * @custom:error ZeroAmount if amount is 0
     * @custom:error MarketNotRegistered if pendleMarket is not registered
     * @custom:error MarketNotActive if market has been deactivated
     * @custom:error MarketAlreadyMatured if attempting to deposit after maturity
     * @custom:error InvalidTokenInput if input.tokenIn does not match market's underlying
     * @custom:error InputAmountMismatch if input.netTokenIn does not match amount
     * @custom:error VTokenMintFailed if Venus mint operation returns non-zero error
     * @custom:access whenNotPaused, nonReentrant
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
     * @notice Withdraw before maturity: redeem vTokens → sell PT on Pendle AMM → user receives underlying.
     * @dev User must have delegated to this adapter in the Comptroller beforehand.
     *      PT is sold on the Pendle AMM at current market price (subject to slippage).
     * @param pendleMarket Pendle market address
     * @param vTokenAmount Amount of vTokens to redeem
     * @param output Token routing configuration from the Pendle API
     * @param limit Limit order fill data (can be empty struct)
     * @return netTokenOut Amount of underlying tokens received by the user
     * @custom:error ZeroAmount if vTokenAmount is 0
     * @custom:error MarketNotRegistered if pendleMarket is not registered
     * @custom:error MarketNotActive if market has been deactivated
     * @custom:error InvalidTokenOutput if output.tokenOut does not match market's underlying
     * @custom:error VTokenRedeemFailed if Venus redeem operation returns non-zero error
     * @custom:access whenNotPaused, nonReentrant
     */
    function withdraw(
        address pendleMarket,
        uint256 vTokenAmount,
        TokenOutput calldata output,
        LimitOrderData calldata limit
    ) external returns (uint256 netTokenOut);

    /**
     * @notice Redeem at or after maturity: redeem vTokens → redeem PT 1:1 via SY → user receives underlying.
     * @dev No AMM swap — PT is redeemed directly through SY at 1:1 ratio (no price impact).
     *      User must have delegated to this adapter in the Comptroller beforehand.
     * @param pendleMarket Pendle market address
     * @param vTokenAmount Amount of vTokens to redeem
     * @param deadline Transaction deadline timestamp (reverts if exceeded)
     * @param output Token routing configuration from the Pendle API
     * @return netTokenOut Amount of underlying tokens received by the user
     * @custom:error ZeroAmount if vTokenAmount is 0
     * @custom:error MarketNotRegistered if pendleMarket is not registered
     * @custom:error MarketNotActive if market has been deactivated
     * @custom:error MarketNotMatured if called before maturity
     * @custom:error DeadlineExceeded if block.timestamp > deadline
     * @custom:error InvalidTokenOutput if output.tokenOut does not match market's underlying
     * @custom:error VTokenRedeemFailed if Venus redeem operation returns non-zero error
     * @custom:access whenNotPaused, nonReentrant
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
     * @notice Deposit native BNB → wrap to WBNB → swap to PT → deposit into Venus → user receives vTokens.
     * @dev Only works for markets where underlying = WBNB.
     *      Any excess WBNB is unwrapped and refunded as BNB to the user.
     * @param pendleMarket Pendle market address identifying the PT market
     * @param minPtOut Minimum PT to receive from Pendle swap (slippage protection)
     * @param guessPtOut Off-chain binary search hint from the Pendle API
     * @param input Token routing configuration from the Pendle API (tokenIn must be WBNB)
     * @param limit Limit order fill data (can be empty struct)
     * @return netVTokensMinted Amount of vTokens credited to the user
     * @custom:error ZeroAmount if msg.value is 0
     * @custom:error MarketNotRegistered if pendleMarket is not registered
     * @custom:error MarketNotActive if market has been deactivated
     * @custom:error MarketAlreadyMatured if attempting to deposit after maturity
     * @custom:error NotNativeMarket if market's underlying is not WBNB
     * @custom:error InvalidTokenInput if input.tokenIn is not WBNB
     * @custom:error InputAmountMismatch if input.netTokenIn does not match msg.value
     * @custom:error VTokenMintFailed if Venus mint operation returns non-zero error
     * @custom:access whenNotPaused, nonReentrant, payable
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
     * @dev Only works for markets where underlying = WBNB.
     *      User must have delegated to this adapter in the Comptroller beforehand.
     * @param pendleMarket Pendle market address
     * @param vTokenAmount Amount of vTokens to redeem
     * @param output Token routing configuration from the Pendle API (tokenOut must be WBNB)
     * @param limit Limit order fill data (can be empty struct)
     * @return netTokenOut Amount of native BNB received by the user
     * @custom:error ZeroAmount if vTokenAmount is 0
     * @custom:error MarketNotRegistered if pendleMarket is not registered
     * @custom:error MarketNotActive if market has been deactivated
     * @custom:error NotNativeMarket if market's underlying is not WBNB
     * @custom:error InvalidTokenOutput if output.tokenOut is not WBNB
     * @custom:error VTokenRedeemFailed if Venus redeem operation returns non-zero error
     * @custom:access whenNotPaused, nonReentrant
     */
    function withdrawNative(
        address pendleMarket,
        uint256 vTokenAmount,
        TokenOutput calldata output,
        LimitOrderData calldata limit
    ) external returns (uint256 netTokenOut);

    /**
     * @notice Redeem at maturity with native BNB: redeem vTokens → redeem PT 1:1 → unwrap WBNB → user receives BNB.
     * @dev Only works for markets where underlying = WBNB.
     *      No AMM swap — PT is redeemed directly through SY at 1:1 ratio.
     *      User must have delegated to this adapter in the Comptroller beforehand.
     * @param pendleMarket Pendle market address
     * @param vTokenAmount Amount of vTokens to redeem
     * @param deadline Transaction deadline timestamp
     * @param output Token routing configuration from the Pendle API (tokenOut must be WBNB)
     * @return netTokenOut Amount of native BNB received by the user
     * @custom:error ZeroAmount if vTokenAmount is 0
     * @custom:error MarketNotRegistered if pendleMarket is not registered
     * @custom:error MarketNotActive if market has been deactivated
     * @custom:error MarketNotMatured if called before maturity
     * @custom:error NotNativeMarket if market's underlying is not WBNB
     * @custom:error DeadlineExceeded if block.timestamp > deadline
     * @custom:error InvalidTokenOutput if output.tokenOut is not WBNB
     * @custom:error VTokenRedeemFailed if Venus redeem operation returns non-zero error
     * @custom:access whenNotPaused, nonReentrant
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
     * @param pendleMarket Pendle AMM market address to register
     * @param underlying User-facing token address (may differ from SY's underlying)
     * @param vToken Venus VToken market address for this PT
     * @param comptroller Venus Comptroller address for the isolated pool
     * @custom:error ZeroAddress if any address parameter is zero
     * @custom:error MarketAlreadyRegistered if the market is already registered
     * @custom:access onlyOwner
     */
    function addMarket(address pendleMarket, address underlying, address vToken, address comptroller) external;

    /**
     * @notice Deactivate a market (blocks new deposits and withdrawals).
     * @dev Only callable by the contract owner.
     *      Deactivation prevents new operations but does not affect existing user positions.
     * @param pendleMarket Pendle market address to deactivate
     * @custom:error MarketNotRegistered if the market is not registered
     * @custom:access onlyOwner
     */
    function deactivateMarket(address pendleMarket) external;

    /**
     * @notice Re-activate a previously deactivated market.
     * @dev Only callable by the contract owner.
     * @param pendleMarket Pendle market address to activate
     * @custom:error MarketNotRegistered if the market is not registered
     * @custom:access onlyOwner
     */
    function activateMarket(address pendleMarket) external;

    /**
     * @notice Pause all deposit/withdraw operations (emergency).
     * @dev Only callable by the contract owner.
     *      When paused, all user-facing functions revert.
     * @custom:access onlyOwner
     */
    function pause() external;

    /**
     * @notice Unpause operations.
     * @dev Only callable by the contract owner.
     * @custom:access onlyOwner
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
     * @custom:error ZeroAddress if token or to address is zero
     * @custom:access onlyOwner
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
