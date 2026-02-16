// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.25;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { Ownable2StepUpgradeable } from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import { PausableUpgradeable } from "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Address } from "@openzeppelin/contracts/utils/Address.sol";

import { IPAllActionV3 } from "@pendle/core-v2/contracts/interfaces/IPAllActionV3.sol";
import { TokenInput, TokenOutput, ApproxParams, LimitOrderData } from "@pendle/core-v2/contracts/interfaces/IPAllActionTypeV3.sol";
import { IPMarket, IStandardizedYield, IPPrincipalToken, IPYieldToken } from "@pendle/core-v2/contracts/interfaces/IPMarket.sol";
import { IVenusVToken } from "./interfaces/IVenusVToken.sol";
import { IVenusComptroller } from "./interfaces/IVenusComptroller.sol";
import { IWBNB } from "./interfaces/IWBNB.sol";
import { IPendlePTVaultAdapter } from "./interfaces/IPendlePTVaultAdapter.sol";

/**
 * @title PendlePTVaultAdapter
 * @author Venus Protocol
 * @notice Universal adapter that wraps Pendle PT swap and Venus Core deposit/redeem into single transactions.
 */
contract PendlePTVaultAdapter is
    IPendlePTVaultAdapter,
    Initializable,
    Ownable2StepUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable
{
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════════════════════════
    //                            IMMUTABLES
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Pendle RouterV4 address — same for all markets on BSC.
    address public immutable PENDLE_ROUTER;

    /// @notice Wrapped native token address (WBNB on BSC).
    address public immutable WBNB;

    // ═══════════════════════════════════════════════════════════════════════
    //                          STATE VARIABLES
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Pendle market address → full market configuration.
    mapping(address => MarketConfig) public markets;

    /// @notice Ordered list of all registered market addresses (for enumeration).
    address[] public marketList;

    /// @dev Reserved storage gap for future upgrades.
    uint256[48] private __gap;

    // ═══════════════════════════════════════════════════════════════════════
    //                             MODIFIERS
    // ═══════════════════════════════════════════════════════════════════════

    /// @dev Reverts if the market is not registered or not active.
    modifier onlyActiveMarket(address pendleMarket) {
        _requireActiveMarket(pendleMarket);
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
    constructor(address pendleRouter_, address wbnb_) {
        if (pendleRouter_ == address(0)) revert ZeroAddress();
        if (wbnb_ == address(0)) revert ZeroAddress();

        PENDLE_ROUTER = pendleRouter_;
        WBNB = wbnb_;

        _disableInitializers();
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                          RECEIVE FUNCTION
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Accept native BNB only from WBNB contract (during unwrap).
    receive() external payable {
        if (msg.sender != WBNB) revert UnauthorizedSender();
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                       EXTERNAL FUNCTIONS
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
    //                        CORE DEPOSIT/WITHDRAW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════

    /// @inheritdoc IPendlePTVaultAdapter
    function deposit(
        address pendleMarket,
        uint256 amount,
        uint256 minPtOut,
        ApproxParams calldata guessPtOut,
        TokenInput calldata input,
        LimitOrderData calldata limit
    ) external whenNotPaused nonReentrant onlyActiveMarket(pendleMarket) returns (uint256 netVTokensMinted) {
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

        // 4. Sweep any dust underlying back to user
        _sweepDust(config.underlying, msg.sender);

        emit Deposited(pendleMarket, msg.sender, amount, netPtOut, netVTokensMinted);
    }

    /// @inheritdoc IPendlePTVaultAdapter
    function withdraw(
        address pendleMarket,
        uint256 vTokenAmount,
        TokenOutput calldata output,
        LimitOrderData calldata limit
    ) external whenNotPaused nonReentrant onlyActiveMarket(pendleMarket) returns (uint256 netTokenOut) {
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

    /// @inheritdoc IPendlePTVaultAdapter
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

    /// @inheritdoc IPendlePTVaultAdapter
    function depositNative(
        address pendleMarket,
        uint256 minPtOut,
        ApproxParams calldata guessPtOut,
        TokenInput calldata input,
        LimitOrderData calldata limit
    ) external payable whenNotPaused nonReentrant onlyActiveMarket(pendleMarket) returns (uint256 netVTokensMinted) {
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

        // 4. Refund any excess WBNB as native BNB
        _refundNativeDust();

        emit Deposited(pendleMarket, msg.sender, msg.value, netPtOut, netVTokensMinted);
    }

    /// @inheritdoc IPendlePTVaultAdapter
    function withdrawNative(
        address pendleMarket,
        uint256 vTokenAmount,
        TokenOutput calldata output,
        LimitOrderData calldata limit
    ) external whenNotPaused nonReentrant onlyActiveMarket(pendleMarket) returns (uint256 netTokenOut) {
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

    /// @inheritdoc IPendlePTVaultAdapter
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

    /// @inheritdoc IPendlePTVaultAdapter
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
        // solhint-disable-next-line var-name-mixedcase
        (IStandardizedYield _SY, IPPrincipalToken _PT, IPYieldToken _YT) = IPMarket(pendleMarket).readTokens();
        uint256 maturity = IPMarket(pendleMarket).expiry();

        markets[pendleMarket] = MarketConfig({
            pt: address(_PT),
            sy: address(_SY),
            yt: address(_YT),
            underlying: underlying,
            vToken: vToken,
            comptroller: comptroller,
            isActive: true,
            maturity: maturity
        });

        marketList.push(pendleMarket);

        emit MarketAdded(pendleMarket, underlying, address(_PT), vToken, comptroller, maturity);
    }

    /// @inheritdoc IPendlePTVaultAdapter
    function deactivateMarket(address pendleMarket) external onlyOwner {
        if (markets[pendleMarket].pt == address(0)) revert MarketNotRegistered(pendleMarket);
        markets[pendleMarket].isActive = false;
        emit MarketDeactivated(pendleMarket);
    }

    /// @inheritdoc IPendlePTVaultAdapter
    function activateMarket(address pendleMarket) external onlyOwner {
        if (markets[pendleMarket].pt == address(0)) revert MarketNotRegistered(pendleMarket);
        markets[pendleMarket].isActive = true;
        emit MarketActivated(pendleMarket);
    }

    /// @inheritdoc IPendlePTVaultAdapter
    function pause() external onlyOwner {
        _pause();
    }

    /// @inheritdoc IPendlePTVaultAdapter
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @inheritdoc IPendlePTVaultAdapter
    function sweepTokens(address token, address to, uint256 amount) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                          VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════

    /// @inheritdoc IPendlePTVaultAdapter
    function getMarketConfig(address pendleMarket) external view returns (MarketConfig memory) {
        return markets[pendleMarket];
    }

    /// @inheritdoc IPendlePTVaultAdapter
    function getMarketCount() external view returns (uint256) {
        return marketList.length;
    }

    /// @inheritdoc IPendlePTVaultAdapter
    function getAllMarkets() external view returns (address[] memory) {
        return marketList;
    }

    /// @inheritdoc IPendlePTVaultAdapter
    function isMatured(address pendleMarket) external view returns (bool) {
        return !(block.timestamp < markets[pendleMarket].maturity);
    }

    /// @inheritdoc IPendlePTVaultAdapter
    function isDelegated(address pendleMarket, address user) external view returns (bool) {
        return IVenusComptroller(markets[pendleMarket].comptroller).approvedDelegates(user, address(this));
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                        INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Validates that the market is registered and active.
     * @param pendleMarket The Pendle market address to validate.
     * @dev Reverts with MarketNotRegistered if PT address is zero.
     *      Reverts with MarketNotActive if market has been deactivated.
     */
    function _requireActiveMarket(address pendleMarket) internal view {
        MarketConfig storage config = markets[pendleMarket];
        if (config.pt == address(0)) revert MarketNotRegistered(pendleMarket);
        if (!config.isActive) revert MarketNotActive(pendleMarket);
    }

    /**
     * @notice Swaps underlying tokens to PT via Pendle Router.
     * @param underlying The underlying token address to swap from.
     * @param pendleMarket The Pendle market address for the swap.
     * @param minPtOut Minimum PT to receive (slippage protection).
     * @param guessPtOut Off-chain binary search approximation parameters.
     * @param input Token input configuration from Pendle API.
     * @param limit Limit order fill data.
     * @return netPtOut Amount of PT tokens received from the swap.
     * @dev Approves router, performs swap, then resets approval to zero.
     */
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

    /**
     * @notice Deposits PT into Venus and mints vTokens on behalf of the caller.
     * @param config The market configuration containing vToken and PT addresses.
     * @param ptAmount Amount of PT tokens to deposit.
     * @return netVTokensMinted Amount of vTokens minted to msg.sender.
     * @dev Approves vToken, calls mintBehalf, then resets approval to zero.
     *      Reverts with VTokenMintFailed if the mint operation returns non-zero error.
     */
    function _mintVTokens(MarketConfig storage config, uint256 ptAmount) private returns (uint256 netVTokensMinted) {
        uint256 vTokenBalanceBefore = IVenusVToken(config.vToken).balanceOf(msg.sender);

        IERC20(config.pt).forceApprove(config.vToken, ptAmount);
        uint256 mintErr = IVenusVToken(config.vToken).mintBehalf(msg.sender, ptAmount);
        if (mintErr != 0) revert VTokenMintFailed(mintErr);

        netVTokensMinted = IVenusVToken(config.vToken).balanceOf(msg.sender) - vTokenBalanceBefore;

        IERC20(config.pt).forceApprove(config.vToken, 0);
    }

    /**
     * @notice Redeems vTokens from Venus on behalf of the caller.
     * @param vToken The Venus vToken address to redeem from.
     * @param vTokenAmount Amount of vTokens to redeem.
     * @dev Underlying PT tokens are sent to this adapter contract.
     *      Reverts with VTokenRedeemFailed if the redeem operation returns non-zero error.
     */
    function _redeemVTokens(address vToken, uint256 vTokenAmount) private {
        uint256 redeemErr = IVenusVToken(vToken).redeemBehalf(msg.sender, vTokenAmount);
        if (redeemErr != 0) revert VTokenRedeemFailed(redeemErr);
    }

    /**
     * @notice Redeems PT 1:1 to underlying via Pendle Router for ERC-20 markets.
     * @param pt The Principal Token address to redeem.
     * @param yt The Yield Token address (required for redemption).
     * @param ptBalance Amount of PT tokens to redeem.
     * @param output Token output configuration from Pendle API.
     * @return netTokenOut Amount of underlying tokens received.
     * @dev Underlying tokens are sent directly to msg.sender.
     *      Approves router, performs redemption, then resets approval to zero.
     */
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

    /**
     * @notice Redeems PT 1:1 to WBNB via Pendle Router for native token markets.
     * @param pt The Principal Token address to redeem.
     * @param yt The Yield Token address (required for redemption).
     * @param ptBalance Amount of PT tokens to redeem.
     * @param output Token output configuration from Pendle API.
     * @return netTokenOut Amount of WBNB tokens received.
     * @dev WBNB is sent to this adapter (not msg.sender) so it can be unwrapped to native BNB.
     *      Approves router, performs redemption, then resets approval to zero.
     */
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

    /**
     * @notice Transfers any remaining token balance back to the recipient.
     * @param token The ERC-20 token address to sweep.
     * @param to The recipient address.
     * @dev Used to return dust/leftover tokens after swaps. Only transfers if balance > 0.
     */
    function _sweepDust(address token, address to) private {
        uint256 dust = IERC20(token).balanceOf(address(this));
        if (dust > 0) {
            IERC20(token).safeTransfer(to, dust);
        }
    }

    /**
     * @notice Refunds any remaining WBNB balance as native BNB to the caller.
     * @dev Unwraps WBNB to BNB and sends to msg.sender. Only processes if balance > 0.
     */
    function _refundNativeDust() private {
        uint256 wbnbDust = IERC20(WBNB).balanceOf(address(this));
        if (wbnbDust > 0) {
            IWBNB(WBNB).withdraw(wbnbDust);
            Address.sendValue(payable(msg.sender), wbnbDust);
        }
    }
}
