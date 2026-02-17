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
import {
    TokenInput,
    TokenOutput,
    ApproxParams,
    LimitOrderData
} from "@pendle/core-v2/contracts/interfaces/IPAllActionTypeV3.sol";
import {
    IPMarket,
    IStandardizedYield,
    IPPrincipalToken,
    IPYieldToken
} from "@pendle/core-v2/contracts/interfaces/IPMarket.sol";
import { IVenusVToken } from "./interfaces/IVenusVToken.sol";
import { IVenusComptroller } from "./interfaces/IVenusComptroller.sol";
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

    /// @dev Reverts if the market has already matured (block.timestamp >= maturity).
    modifier beforeMaturity(address pendleMarket) {
        uint256 maturity = markets[pendleMarket].maturity;
        if (!(block.timestamp < maturity)) revert MarketAlreadyMatured(maturity, block.timestamp);
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

    /// @notice Accept native BNB
    receive() external payable {}

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
        if (input.tokenIn == address(0)) revert InvalidTokenInput();

        MarketConfig storage config = markets[pendleMarket];

        // Validate calldata consistency
        if (input.netTokenIn != amount) revert InputAmountMismatch(amount, input.netTokenIn);

        // 1. Pull tokens from user → adapter (accepts any token from Pendle's tokensIn)
        IERC20(input.tokenIn).safeTransferFrom(msg.sender, address(this), amount);

        // 2. Swap tokenIn → PT via Pendle Router (Pendle handles aggregator routing if needed)
        uint256 netPtOut = _swapToPt(pendleMarket, minPtOut, guessPtOut, input, limit);

        // 3. Deposit PT into Venus — vTokens go to user
        netVTokensMinted = _mintVTokens(config, netPtOut);

        // 4. Sweep any dust tokenIn back to user
        _sweepDust(input.tokenIn, msg.sender);

        emit Deposited(pendleMarket, msg.sender, input.tokenIn, amount, netPtOut, netVTokensMinted);
    }

    /// @inheritdoc IPendlePTVaultAdapter
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
        beforeMaturity(pendleMarket)
        returns (uint256 netTokenOut)
    {
        if (vTokenAmount == 0) revert ZeroAmount();

        MarketConfig storage config = markets[pendleMarket];

        // 1. Redeem vTokens → adapter receives PT
        _redeemVTokens(config.vToken, vTokenAmount);

        uint256 ptBalance = IERC20(config.pt).balanceOf(address(this));

        // 2. Swap PT → tokenOut via Pendle (sent directly to user, Pendle handles routing)
        netTokenOut = _swapPtToToken(config.pt, pendleMarket, ptBalance, output, limit);

        emit Withdrawn(pendleMarket, msg.sender, vTokenAmount, ptBalance, output.tokenOut, netTokenOut);
    }

    /// @inheritdoc IPendlePTVaultAdapter
    function redeemAtMaturity(
        address pendleMarket,
        uint256 vTokenAmount,
        TokenOutput calldata output
    )
        external
        whenNotPaused
        nonReentrant
        onlyActiveMarket(pendleMarket)
        atOrAfterMaturity(pendleMarket)
        returns (uint256 netTokenOut)
    {
        if (vTokenAmount == 0) revert ZeroAmount();

        MarketConfig storage config = markets[pendleMarket];

        // 1. Redeem vTokens → adapter receives PT
        _redeemVTokens(config.vToken, vTokenAmount);

        uint256 ptBalance = IERC20(config.pt).balanceOf(address(this));

        // 2. Redeem PT 1:1 → tokenOut via Pendle (sent directly to user, Pendle handles routing)
        netTokenOut = _redeemPtToToken(config.pt, config.yt, ptBalance, output);

        emit RedeemedAtMaturity(pendleMarket, msg.sender, vTokenAmount, ptBalance, output.tokenOut, netTokenOut);
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

        // Validate calldata consistency
        if (input.netTokenIn != msg.value) revert InputAmountMismatch(msg.value, input.netTokenIn);

        // 1. Swap native BNB → PT via Pendle Router
        (uint256 netPtOut, , ) = IPAllActionV3(PENDLE_ROUTER).swapExactTokenForPt{ value: msg.value }(
            address(this),
            pendleMarket,
            minPtOut,
            guessPtOut,
            input,
            limit
        );

        // 2. Deposit PT into Venus — vTokens go to user
        netVTokensMinted = _mintVTokens(config, netPtOut);

        // 3. Refund any excess native BNB or WBNB
        _refundNativeDust();

        emit Deposited(pendleMarket, msg.sender, input.tokenIn, msg.value, netPtOut, netVTokensMinted);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                          ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════

    /// @inheritdoc IPendlePTVaultAdapter
    function addMarket(
        address pendleMarket,
        address vToken,
        address comptroller
    ) external onlyOwner {
        if (pendleMarket == address(0)) revert ZeroAddress();
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
            vToken: vToken,
            comptroller: comptroller,
            isActive: true,
            maturity: maturity
        });

        marketList.push(pendleMarket);

        emit MarketAdded(pendleMarket, address(_PT), vToken, comptroller, maturity);
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
     * @notice Swaps tokenIn to PT via Pendle Router.
     * @param pendleMarket The Pendle market address for the swap.
     * @param minPtOut Minimum PT to receive (slippage protection).
     * @param guessPtOut Off-chain binary search approximation parameters.
     * @param input Token input configuration from Pendle API (contains tokenIn address).
     * @param limit Limit order fill data.
     * @return netPtOut Amount of PT tokens received from the swap.
     * @dev Approves router, performs swap, then resets approval to zero.
     */
    function _swapToPt(
        address pendleMarket,
        uint256 minPtOut,
        ApproxParams calldata guessPtOut,
        TokenInput calldata input,
        LimitOrderData calldata limit
    ) internal returns (uint256 netPtOut) {
        uint256 amount = IERC20(input.tokenIn).balanceOf(address(this));
        IERC20(input.tokenIn).forceApprove(PENDLE_ROUTER, amount);

        (netPtOut, , ) = IPAllActionV3(PENDLE_ROUTER).swapExactTokenForPt(
            address(this), // PT receiver = adapter (so we can deposit into Venus)
            pendleMarket,
            minPtOut,
            guessPtOut,
            input,
            limit
        );

        IERC20(input.tokenIn).forceApprove(PENDLE_ROUTER, 0);
    }

    /**
     * @notice Deposits PT into Venus and mints vTokens on behalf of the caller.
     * @param config The market configuration containing vToken and PT addresses.
     * @param ptAmount Amount of PT tokens to deposit.
     * @return netVTokensMinted Amount of vTokens minted to msg.sender.
     * @dev Approves vToken, calls mintBehalf, then resets approval to zero.
     *      Reverts with VTokenMintFailed if the mint operation returns non-zero error.
     */
    function _mintVTokens(MarketConfig storage config, uint256 ptAmount) internal returns (uint256 netVTokensMinted) {
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
    function _redeemVTokens(address vToken, uint256 vTokenAmount) internal {
        uint256 redeemErr = IVenusVToken(vToken).redeemBehalf(msg.sender, vTokenAmount);
        if (redeemErr != 0) revert VTokenRedeemFailed(redeemErr);
    }

    /**
     * @notice Swaps PT to tokenOut via Pendle Router (before maturity).
     * @param pt The Principal Token address.
     * @param pendleMarket The Pendle market address for the swap.
     * @param ptBalance Amount of PT tokens to swap.
     * @param output Token output configuration from Pendle API.
     * @param limit Limit order fill data.
     * @return netTokenOut Amount of output tokens received.
     * @dev Output tokens are sent directly to msg.sender.
     *      Approves router, performs swap, then resets approval to zero.
     */
    function _swapPtToToken(
        address pt,
        address pendleMarket,
        uint256 ptBalance,
        TokenOutput calldata output,
        LimitOrderData calldata limit
    ) internal returns (uint256 netTokenOut) {
        IERC20(pt).forceApprove(PENDLE_ROUTER, ptBalance);

        (netTokenOut, , ) = IPAllActionV3(PENDLE_ROUTER).swapExactPtForToken(
            msg.sender, // tokens sent directly to user
            pendleMarket,
            ptBalance,
            output,
            limit
        );

        IERC20(pt).forceApprove(PENDLE_ROUTER, 0);
    }

    /**
     * @notice Redeems PT 1:1 to tokenOut via Pendle Router for ERC-20 markets.
     * @param pt The Principal Token address to redeem.
     * @param yt The Yield Token address (required for redemption).
     * @param ptBalance Amount of PT tokens to redeem.
     * @param output Token output configuration from Pendle API.
     * @return netTokenOut Amount of output tokens received.
     * @dev Output tokens are sent directly to msg.sender.
     *      Approves router, performs redemption, then resets approval to zero.
     */
    function _redeemPtToToken(
        address pt,
        address yt,
        uint256 ptBalance,
        TokenOutput calldata output
    ) internal returns (uint256 netTokenOut) {
        IERC20(pt).forceApprove(PENDLE_ROUTER, ptBalance);

        (netTokenOut, ) = IPAllActionV3(PENDLE_ROUTER).redeemPyToToken(
            msg.sender, // tokenOut sent directly to user
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
    function _sweepDust(address token, address to) internal {
        uint256 dust = IERC20(token).balanceOf(address(this));
        if (dust > 0) {
            IERC20(token).safeTransfer(to, dust);
        }
    }

    /**
     * @notice Refunds any remaining native BNB to the caller.
     */
    function _refundNativeDust() internal {
        uint256 bnbDust = address(this).balance;
        if (bnbDust > 0) {
            Address.sendValue(payable(msg.sender), bnbDust);
        }
    }
}
