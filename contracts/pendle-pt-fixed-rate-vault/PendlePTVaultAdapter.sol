// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.25;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { Ownable2StepUpgradeable } from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import { PausableUpgradeable } from "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Address } from "@openzeppelin/contracts/utils/Address.sol";

import { IPAllActionV3, TokenInput, TokenOutput, ApproxParams, LimitOrderData } from "./interfaces/IPAllActionV3.sol";
import { IPMarket } from "./interfaces/IPMarket.sol";
import { IVenusVToken } from "./interfaces/IVenusVToken.sol";
import { IVenusComptroller } from "./interfaces/IVenusComptroller.sol";
import { IWBNB } from "./interfaces/IWBNB.sol";

/// @title PendlePTVaultAdapter
/// @author Venus Protocol
/// @notice Universal adapter that wraps Pendle PT swap and Venus Core deposit/redeem into single
///         transactions. Users deposit underlying tokens (e.g. USDC, BNB) and receive Venus vTokens.
///         A single adapter handles all PT markets via an internal market registry.
/// @dev The adapter does NOT hold user funds or track user positions — all user accounting is managed
///      by Venus vTokens. The contract should hold zero token balances between transactions.
contract PendlePTVaultAdapter is
    Initializable,
    Ownable2StepUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable
{
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════════════════════════
    //                              STRUCTS
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Configuration for a registered Pendle PT market.
    struct MarketConfig {
        address pt; // Principal Token address
        address sy; // Standardized Yield token
        address yt; // Yield Token (needed for maturity redeem)
        address underlying; // User-facing token (USDC, WBNB)
        address vToken; // Venus VToken market for this PT
        address comptroller; // Venus Comptroller for the isolated pool
        uint256 maturity; // PT expiry timestamp
        bool isActive; // Admin can deactivate without removing config
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                            IMMUTABLES
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Pendle RouterV4 address — same for all markets on BSC.
    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    address public immutable PENDLE_ROUTER;

    /// @notice Wrapped native token address (WBNB on BSC).
    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    address public immutable WBNB;

    // ═══════════════════════════════════════════════════════════════════════
    //                          STATE VARIABLES
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Pendle market address → full market configuration.
    mapping(address => MarketConfig) public markets;

    /// @notice Ordered list of all registered market addresses (for enumeration).
    address[] public marketList;

    // ═══════════════════════════════════════════════════════════════════════
    //                              EVENTS
    // ═══════════════════════════════════════════════════════════════════════

    event MarketAdded(
        address indexed pendleMarket,
        address indexed underlying,
        address pt,
        address vToken,
        address comptroller,
        uint256 maturity
    );

    event MarketDeactivated(address indexed pendleMarket);

    event MarketActivated(address indexed pendleMarket);

    event Deposited(
        address indexed pendleMarket,
        address indexed user,
        uint256 underlyingAmount,
        uint256 ptAmount,
        uint256 vTokenAmount
    );

    event Withdrawn(
        address indexed pendleMarket,
        address indexed user,
        uint256 vTokenAmount,
        uint256 ptAmount,
        uint256 underlyingAmount
    );

    event RedeemedAtMaturity(
        address indexed pendleMarket,
        address indexed user,
        uint256 vTokenAmount,
        uint256 ptAmount,
        uint256 underlyingAmount
    );

    // ═══════════════════════════════════════════════════════════════════════
    //                           CUSTOM ERRORS
    // ═══════════════════════════════════════════════════════════════════════

    error ZeroAmount();
    error ZeroAddress();
    error DeadlineExceeded(uint256 deadline, uint256 currentTime);
    error MarketNotRegistered(address pendleMarket);
    error MarketNotActive(address pendleMarket);
    error MarketAlreadyRegistered(address pendleMarket);
    error MarketNotMatured(uint256 maturity, uint256 currentTime);
    error MarketAlreadyMatured(uint256 maturity, uint256 currentTime);
    error InvalidTokenInput(address expected, address received);
    error InvalidTokenOutput(address expected, address received);
    error InputAmountMismatch(uint256 expected, uint256 received);
    error NotNativeMarket(address pendleMarket);
    error VTokenMintFailed(uint256 errorCode);
    error VTokenRedeemFailed(uint256 errorCode);

    // ═══════════════════════════════════════════════════════════════════════
    //                             MODIFIERS
    // ═══════════════════════════════════════════════════════════════════════

    /// @dev Reverts if the market is not registered or not active.
    modifier onlyActiveMarket(address pendleMarket) {
        _requireActiveMarket(pendleMarket);
        _;
    }

    /// @dev Reverts if the market has already matured (block.timestamp >= maturity).
    modifier beforeMaturity(address pendleMarket) {
        uint256 mat = markets[pendleMarket].maturity;
        if (block.timestamp >= mat) revert MarketAlreadyMatured(mat, block.timestamp);
        _;
    }

    /// @dev Reverts if the market has not yet matured (block.timestamp < maturity).
    modifier atOrAfterMaturity(address pendleMarket) {
        uint256 mat = markets[pendleMarket].maturity;
        if (block.timestamp < mat) revert MarketNotMatured(mat, block.timestamp);
        _;
    }

    /// @dev Reverts if the current block timestamp exceeds the deadline.
    modifier checkDeadline(uint256 deadline) {
        if (block.timestamp > deadline) revert DeadlineExceeded(deadline, block.timestamp);
        _;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                            CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Sets immutable router and WBNB addresses. Implementation contract only.
    /// @param pendleRouter_ Pendle RouterV4 address.
    /// @param wbnb_ Wrapped native token (WBNB) address.
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(address pendleRouter_, address wbnb_) {
        if (pendleRouter_ == address(0)) revert ZeroAddress();
        if (wbnb_ == address(0)) revert ZeroAddress();

        PENDLE_ROUTER = pendleRouter_;
        WBNB = wbnb_;

        _disableInitializers();
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                            INITIALIZER
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Initializes the proxy state. Called once after proxy deployment.
    /// @param owner_ Address that will own the contract (multisig / timelock).
    function initialize(address owner_) external initializer {
        if (owner_ == address(0)) revert ZeroAddress();

        __Ownable2Step_init();
        __Pausable_init();
        __ReentrancyGuard_init();

        _transferOwnership(owner_);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                        CORE FUNCTIONS — ERC-20
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Deposit underlying tokens → swap to PT via Pendle → deposit PT into Venus → user receives vTokens.
    /// @dev User must approve this adapter for `amount` of the underlying token beforehand.
    /// @param pendleMarket Pendle market address identifying the PT market.
    /// @param amount Amount of underlying tokens to deposit.
    /// @param minPtOut Minimum PT to receive from Pendle swap (slippage protection).
    /// @param guessPtOut Off-chain binary search hint from the Pendle API.
    /// @param input Token routing configuration from the Pendle API.
    /// @param limit Limit order fill data (can be empty struct for simple swaps).
    /// @return netVTokensMinted Amount of vTokens credited to the user.
    function deposit(
        address pendleMarket,
        uint256 amount,
        uint256 minPtOut,
        ApproxParams calldata guessPtOut,
        TokenInput calldata input,
        LimitOrderData calldata limit
    )
        external
        whenNotPaused
        nonReentrant
        onlyActiveMarket(pendleMarket)
        beforeMaturity(pendleMarket)
        returns (uint256 netVTokensMinted)
    {
        if (amount == 0) revert ZeroAmount();

        MarketConfig storage config = markets[pendleMarket];

        // Validate calldata matches expected market config
        if (input.tokenIn != config.underlying) revert InvalidTokenInput(config.underlying, input.tokenIn);
        if (input.netTokenIn != amount) revert InputAmountMismatch(amount, input.netTokenIn);

        // 1. Pull underlying tokens from user → adapter
        IERC20(config.underlying).safeTransferFrom(msg.sender, address(this), amount);

        // 2. Swap underlying → PT via Pendle Router
        uint256 netPtOut = _swapToPt(config.underlying, pendleMarket, minPtOut, guessPtOut, input, limit);

        // 3. Deposit PT into Venus — vTokens go to user
        netVTokensMinted = _mintVTokens(config, netPtOut);

        // 4. Auto-enable collateral (best-effort — requires user delegation to adapter)
        try IVenusComptroller(config.comptroller).enterMarketBehalf(msg.sender, config.vToken) {} catch {}

        // 5. Sweep any dust underlying back to user
        _sweepDust(config.underlying, msg.sender);

        emit Deposited(pendleMarket, msg.sender, amount, netPtOut, netVTokensMinted);
    }

    /// @notice Withdraw before maturity: redeem vTokens → sell PT on Pendle AMM → user receives underlying.
    /// @dev User must have delegated to this adapter in the Comptroller beforehand.
    /// @param pendleMarket Pendle market address.
    /// @param vTokenAmount Amount of vTokens to redeem.
    /// @param output Token routing configuration from the Pendle API.
    /// @param limit Limit order fill data (can be empty struct).
    /// @return netTokenOut Amount of underlying tokens received by the user.
    function withdraw(
        address pendleMarket,
        uint256 vTokenAmount,
        TokenOutput calldata output,
        LimitOrderData calldata limit
    )
        external
        whenNotPaused
        nonReentrant
        onlyActiveMarket(pendleMarket)
        returns (uint256 netTokenOut)
    {
        if (vTokenAmount == 0) revert ZeroAmount();

        MarketConfig storage config = markets[pendleMarket];

        if (output.tokenOut != config.underlying) revert InvalidTokenOutput(config.underlying, output.tokenOut);

        // 1. Redeem vTokens → adapter receives PT
        _redeemVTokens(config.vToken, vTokenAmount);

        uint256 ptBalance = IERC20(config.pt).balanceOf(address(this));

        // 2. Swap PT → underlying via Pendle AMM (sent directly to user)
        IERC20(config.pt).forceApprove(PENDLE_ROUTER, ptBalance);

        (netTokenOut, , ) = IPAllActionV3(PENDLE_ROUTER).swapExactPtForToken(
            msg.sender, // underlying sent directly to user
            pendleMarket,
            ptBalance,
            output,
            limit
        );

        // 3. Reset approvals
        IERC20(config.pt).forceApprove(PENDLE_ROUTER, 0);

        emit Withdrawn(pendleMarket, msg.sender, vTokenAmount, ptBalance, netTokenOut);
    }

    /// @notice Redeem at or after maturity: redeem vTokens → redeem PT 1:1 via SY → user receives underlying.
    /// @dev No AMM swap — PT is redeemed directly through SY at 1:1 ratio.
    /// @param pendleMarket Pendle market address.
    /// @param vTokenAmount Amount of vTokens to redeem.
    /// @param deadline Transaction deadline timestamp (reverts if exceeded).
    /// @param output Token routing configuration from the Pendle API.
    /// @return netTokenOut Amount of underlying tokens received by the user.
    function redeemAtMaturity(
        address pendleMarket,
        uint256 vTokenAmount,
        uint256 deadline,
        TokenOutput calldata output
    )
        external
        whenNotPaused
        nonReentrant
        onlyActiveMarket(pendleMarket)
        atOrAfterMaturity(pendleMarket)
        checkDeadline(deadline)
        returns (uint256 netTokenOut)
    {
        if (vTokenAmount == 0) revert ZeroAmount();

        MarketConfig storage config = markets[pendleMarket];

        if (output.tokenOut != config.underlying) revert InvalidTokenOutput(config.underlying, output.tokenOut);

        // 1. Redeem vTokens → adapter receives PT
        _redeemVTokens(config.vToken, vTokenAmount);

        uint256 ptBalance = IERC20(config.pt).balanceOf(address(this));

        // 2. Redeem PT 1:1 → underlying via Pendle (sent directly to user)
        netTokenOut = _redeemPtToToken(config.pt, config.yt, ptBalance, output);

        emit RedeemedAtMaturity(pendleMarket, msg.sender, vTokenAmount, ptBalance, netTokenOut);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                    CORE FUNCTIONS — NATIVE TOKEN
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Deposit native BNB → wrap to WBNB → swap to PT → deposit into Venus → user receives vTokens.
    /// @param pendleMarket Pendle market address identifying the PT market.
    /// @param minPtOut Minimum PT to receive from Pendle swap (slippage protection).
    /// @param guessPtOut Off-chain binary search hint from the Pendle API.
    /// @param input Token routing configuration from the Pendle API (tokenIn must be WBNB).
    /// @param limit Limit order fill data (can be empty struct).
    /// @return netVTokensMinted Amount of vTokens credited to the user.
    function depositNative(
        address pendleMarket,
        uint256 minPtOut,
        ApproxParams calldata guessPtOut,
        TokenInput calldata input,
        LimitOrderData calldata limit
    )
        external
        payable
        whenNotPaused
        nonReentrant
        onlyActiveMarket(pendleMarket)
        beforeMaturity(pendleMarket)
        returns (uint256 netVTokensMinted)
    {
        if (msg.value == 0) revert ZeroAmount();

        MarketConfig storage config = markets[pendleMarket];

        if (config.underlying != WBNB) revert NotNativeMarket(pendleMarket);
        if (input.tokenIn != WBNB) revert InvalidTokenInput(WBNB, input.tokenIn);
        if (input.netTokenIn != msg.value) revert InputAmountMismatch(msg.value, input.netTokenIn);

        // 1. Wrap BNB → WBNB
        IWBNB(WBNB).deposit{ value: msg.value }();

        // 2. Swap WBNB → PT via Pendle Router
        uint256 netPtOut = _swapToPt(WBNB, pendleMarket, minPtOut, guessPtOut, input, limit);

        // 3. Deposit PT into Venus — vTokens go to user
        netVTokensMinted = _mintVTokens(config, netPtOut);

        // 4. Auto-enable collateral (best-effort)
        try IVenusComptroller(config.comptroller).enterMarketBehalf(msg.sender, config.vToken) {} catch {}

        // 5. Refund any excess WBNB as native BNB
        _refundNativeDust();

        emit Deposited(pendleMarket, msg.sender, msg.value, netPtOut, netVTokensMinted);
    }

    /// @notice Withdraw before maturity with native BNB: redeem vTokens → sell PT → unwrap WBNB → user receives BNB.
    /// @param pendleMarket Pendle market address.
    /// @param vTokenAmount Amount of vTokens to redeem.
    /// @param output Token routing configuration from the Pendle API (tokenOut must be WBNB).
    /// @param limit Limit order fill data (can be empty struct).
    /// @return netTokenOut Amount of native BNB received by the user.
    function withdrawNative(
        address pendleMarket,
        uint256 vTokenAmount,
        TokenOutput calldata output,
        LimitOrderData calldata limit
    )
        external
        whenNotPaused
        nonReentrant
        onlyActiveMarket(pendleMarket)
        returns (uint256 netTokenOut)
    {
        if (vTokenAmount == 0) revert ZeroAmount();

        MarketConfig storage config = markets[pendleMarket];

        if (config.underlying != WBNB) revert NotNativeMarket(pendleMarket);
        if (output.tokenOut != WBNB) revert InvalidTokenOutput(WBNB, output.tokenOut);

        // 1. Redeem vTokens → adapter receives PT
        _redeemVTokens(config.vToken, vTokenAmount);

        uint256 ptBalance = IERC20(config.pt).balanceOf(address(this));

        // 2. Swap PT → WBNB via Pendle (sent to adapter so we can unwrap)
        IERC20(config.pt).forceApprove(PENDLE_ROUTER, ptBalance);

        (netTokenOut, , ) = IPAllActionV3(PENDLE_ROUTER).swapExactPtForToken(
            address(this), // receiver = adapter (not user — we unwrap first)
            pendleMarket,
            ptBalance,
            output,
            limit
        );

        // 3. Reset approvals
        IERC20(config.pt).forceApprove(PENDLE_ROUTER, 0);

        // 4. Unwrap WBNB → BNB and send to user
        IWBNB(WBNB).withdraw(netTokenOut);
        Address.sendValue(payable(msg.sender), netTokenOut);

        emit Withdrawn(pendleMarket, msg.sender, vTokenAmount, ptBalance, netTokenOut);
    }

    /// @notice Redeem at maturity with native BNB: redeem vTokens → redeem PT 1:1 → unwrap WBNB → user receives BNB.
    /// @param pendleMarket Pendle market address.
    /// @param vTokenAmount Amount of vTokens to redeem.
    /// @param deadline Transaction deadline timestamp.
    /// @param output Token routing configuration from the Pendle API (tokenOut must be WBNB).
    /// @return netTokenOut Amount of native BNB received by the user.
    function redeemAtMaturityNative(
        address pendleMarket,
        uint256 vTokenAmount,
        uint256 deadline,
        TokenOutput calldata output
    )
        external
        whenNotPaused
        nonReentrant
        onlyActiveMarket(pendleMarket)
        atOrAfterMaturity(pendleMarket)
        checkDeadline(deadline)
        returns (uint256 netTokenOut)
    {
        if (vTokenAmount == 0) revert ZeroAmount();

        MarketConfig storage config = markets[pendleMarket];

        if (config.underlying != WBNB) revert NotNativeMarket(pendleMarket);
        if (output.tokenOut != WBNB) revert InvalidTokenOutput(WBNB, output.tokenOut);

        // 1. Redeem vTokens → adapter receives PT
        _redeemVTokens(config.vToken, vTokenAmount);

        uint256 ptBalance = IERC20(config.pt).balanceOf(address(this));

        // 2. Redeem PT 1:1 → WBNB via Pendle (sent to adapter so we can unwrap)
        netTokenOut = _redeemPtToTokenNative(config.pt, config.yt, ptBalance, output);

        // 3. Unwrap WBNB → BNB and send to user
        IWBNB(WBNB).withdraw(netTokenOut);
        Address.sendValue(payable(msg.sender), netTokenOut);

        emit RedeemedAtMaturity(pendleMarket, msg.sender, vTokenAmount, ptBalance, netTokenOut);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                          ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Register a new PT market. Derives PT, SY, YT, and maturity from the Pendle market on-chain.
    /// @param pendleMarket Pendle AMM market address.
    /// @param underlying User-facing token address (may differ from SY's underlying).
    /// @param vToken Venus VToken market address for this PT.
    /// @param comptroller Venus Comptroller address for the isolated pool.
    function addMarket(
        address pendleMarket,
        address underlying,
        address vToken,
        address comptroller
    ) external onlyOwner {
        if (pendleMarket == address(0)) revert ZeroAddress();
        if (underlying == address(0)) revert ZeroAddress();
        if (vToken == address(0)) revert ZeroAddress();
        if (comptroller == address(0)) revert ZeroAddress();
        if (markets[pendleMarket].pt != address(0)) revert MarketAlreadyRegistered(pendleMarket);

        // Derive token addresses and maturity from Pendle market contract
        (address sy, address pt, address yt) = IPMarket(pendleMarket).readTokens();
        uint256 maturity = IPMarket(pendleMarket).expiry();

        markets[pendleMarket] = MarketConfig({
            pt: pt,
            sy: sy,
            yt: yt,
            underlying: underlying,
            vToken: vToken,
            comptroller: comptroller,
            maturity: maturity,
            isActive: true
        });

        marketList.push(pendleMarket);

        emit MarketAdded(pendleMarket, underlying, pt, vToken, comptroller, maturity);
    }

    /// @notice Deactivate a market (blocks new deposits and withdrawals).
    /// @param pendleMarket Pendle market address to deactivate.
    function deactivateMarket(address pendleMarket) external onlyOwner {
        if (markets[pendleMarket].pt == address(0)) revert MarketNotRegistered(pendleMarket);
        markets[pendleMarket].isActive = false;
        emit MarketDeactivated(pendleMarket);
    }

    /// @notice Re-activate a previously deactivated market.
    /// @param pendleMarket Pendle market address to activate.
    function activateMarket(address pendleMarket) external onlyOwner {
        if (markets[pendleMarket].pt == address(0)) revert MarketNotRegistered(pendleMarket);
        markets[pendleMarket].isActive = true;
        emit MarketActivated(pendleMarket);
    }

    /// @notice Pause all deposit/withdraw operations (emergency).
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Unpause operations.
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Recover tokens accidentally sent to the contract.
    /// @param token ERC-20 token address to sweep.
    /// @param to Recipient address.
    /// @param amount Amount to transfer.
    function sweepTokens(address token, address to, uint256 amount) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                          VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Get full configuration for a registered market.
    /// @param pendleMarket Pendle market address.
    /// @return Full MarketConfig struct.
    function getMarketConfig(address pendleMarket) external view returns (MarketConfig memory) {
        return markets[pendleMarket];
    }

    /// @notice Get the number of registered markets.
    function getMarketCount() external view returns (uint256) {
        return marketList.length;
    }

    /// @notice Get all registered market addresses.
    function getAllMarkets() external view returns (address[] memory) {
        return marketList;
    }

    /// @notice Check if a specific PT market has matured.
    /// @param pendleMarket Pendle market address.
    /// @return True if the current timestamp is at or past the market's maturity.
    function isMatured(address pendleMarket) external view returns (bool) {
        return block.timestamp >= markets[pendleMarket].maturity;
    }

    /// @notice Check if a user has delegated to this adapter for a specific market's Comptroller.
    /// @dev Delegation is required for both deposit (enterMarketBehalf) and withdraw (redeemBehalf).
    /// @param pendleMarket Pendle market address.
    /// @param user User address to check.
    /// @return True if the user has approved this adapter as a delegate.
    function isDelegated(address pendleMarket, address user) external view returns (bool) {
        return IVenusComptroller(markets[pendleMarket].comptroller).approvedDelegates(user, address(this));
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                        INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════════

    /// @dev Validates that the market is registered and active.
    function _requireActiveMarket(address pendleMarket) internal view {
        MarketConfig storage config = markets[pendleMarket];
        if (config.pt == address(0)) revert MarketNotRegistered(pendleMarket);
        if (!config.isActive) revert MarketNotActive(pendleMarket);
    }

    /// @dev Swaps underlying → PT via Pendle Router. Approves, swaps, and resets approval.
    function _swapToPt(
        address underlying,
        address pendleMarket,
        uint256 minPtOut,
        ApproxParams calldata guessPtOut,
        TokenInput calldata input,
        LimitOrderData calldata limit
    ) private returns (uint256 netPtOut) {
        uint256 amount = IERC20(underlying).balanceOf(address(this));
        IERC20(underlying).forceApprove(PENDLE_ROUTER, amount);

        (netPtOut, , ) = IPAllActionV3(PENDLE_ROUTER).swapExactTokenForPt(
            address(this), // PT receiver = adapter (so we can deposit into Venus)
            pendleMarket,
            minPtOut,
            guessPtOut,
            input,
            limit
        );

        IERC20(underlying).forceApprove(PENDLE_ROUTER, 0);
    }

    /// @dev Deposits PT into Venus via mintBehalf. Approves, mints, and resets approval.
    /// @return netVTokensMinted The amount of vTokens minted to msg.sender.
    function _mintVTokens(MarketConfig storage config, uint256 ptAmount) private returns (uint256 netVTokensMinted) {
        uint256 vTokenBalanceBefore = IVenusVToken(config.vToken).balanceOf(msg.sender);

        IERC20(config.pt).forceApprove(config.vToken, ptAmount);
        uint256 mintErr = IVenusVToken(config.vToken).mintBehalf(msg.sender, ptAmount);
        if (mintErr != 0) revert VTokenMintFailed(mintErr);

        netVTokensMinted = IVenusVToken(config.vToken).balanceOf(msg.sender) - vTokenBalanceBefore;

        IERC20(config.pt).forceApprove(config.vToken, 0);
    }

    /// @dev Redeems vTokens from Venus on behalf of msg.sender. Underlying (PT) is sent to this adapter.
    function _redeemVTokens(address vToken, uint256 vTokenAmount) private {
        uint256 redeemErr = IVenusVToken(vToken).redeemBehalf(msg.sender, vTokenAmount);
        if (redeemErr != 0) revert VTokenRedeemFailed(redeemErr);
    }

    /// @dev Redeems PT 1:1 to underlying via Pendle Router (for ERC-20 markets — sends to msg.sender).
    function _redeemPtToToken(
        address pt,
        address yt,
        uint256 ptBalance,
        TokenOutput calldata output
    ) private returns (uint256 netTokenOut) {
        IERC20(pt).forceApprove(PENDLE_ROUTER, ptBalance);

        (netTokenOut, ) = IPAllActionV3(PENDLE_ROUTER).redeemPyToToken(
            msg.sender, // underlying sent directly to user
            yt,
            ptBalance,
            output
        );

        IERC20(pt).forceApprove(PENDLE_ROUTER, 0);
    }

    /// @dev Redeems PT 1:1 to WBNB via Pendle Router (for native markets — sends to adapter for unwrap).
    function _redeemPtToTokenNative(
        address pt,
        address yt,
        uint256 ptBalance,
        TokenOutput calldata output
    ) private returns (uint256 netTokenOut) {
        IERC20(pt).forceApprove(PENDLE_ROUTER, ptBalance);

        (netTokenOut, ) = IPAllActionV3(PENDLE_ROUTER).redeemPyToToken(
            address(this), // receive WBNB here so we can unwrap
            yt,
            ptBalance,
            output
        );

        IERC20(pt).forceApprove(PENDLE_ROUTER, 0);
    }

    /// @dev Transfers any remaining ERC-20 token balance in this contract back to the recipient.
    function _sweepDust(address token, address to) private {
        uint256 dust = IERC20(token).balanceOf(address(this));
        if (dust > 0) {
            IERC20(token).safeTransfer(to, dust);
        }
    }

    /// @dev Refunds any remaining WBNB balance as native BNB to msg.sender.
    function _refundNativeDust() private {
        uint256 wbnbDust = IERC20(WBNB).balanceOf(address(this));
        if (wbnbDust > 0) {
            IWBNB(WBNB).withdraw(wbnbDust);
            Address.sendValue(payable(msg.sender), wbnbDust);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                          RECEIVE / FALLBACK
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Accept native BNB only from WBNB contract (during unwrap).
    receive() external payable {
        if (msg.sender != WBNB) revert ZeroAddress();
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                          STORAGE GAP
    // ═══════════════════════════════════════════════════════════════════════

    /// @dev Reserved storage gap for future upgrades.
    uint256[48] private __gap;
}
