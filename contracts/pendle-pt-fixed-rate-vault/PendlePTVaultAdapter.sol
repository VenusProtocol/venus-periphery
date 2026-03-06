// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.25;

import { PausableUpgradeable } from "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Address } from "@openzeppelin/contracts/utils/Address.sol";
import { AccessControlledV8 } from "@venusprotocol/governance-contracts/contracts/Governance/AccessControlledV8.sol";

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
 * @author Venus
 * @notice Universal adapter that wraps Pendle PT swap and Venus Core deposit/redeem into single transactions.
 */
contract PendlePTVaultAdapter is
    IPendlePTVaultAdapter,
    AccessControlledV8,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable
{
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════════════════════════
    //                            IMMUTABLES
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Pendle Router address (IPAllActionV3).
    address public immutable PENDLE_ROUTER;

    /// @notice Venus core pool Comptroller address.
    address public immutable COMPTROLLER;

    // ═══════════════════════════════════════════════════════════════════════
    //                          STATE VARIABLES
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Pendle market address → full market configuration.
    mapping(address => MarketConfig) public markets;

    /// @notice Ordered list of all registered market addresses (for enumeration).
    /// @dev Grows unboundedly — expected to remain small.
    ///      Matured markets remain in the list to allow late redemptions.
    address[] public marketList;

    /// @dev Reserved storage gap for future upgrades.
    uint256[48] private __gap;

    // ═══════════════════════════════════════════════════════════════════════
    //                             MODIFIERS
    // ═══════════════════════════════════════════════════════════════════════

    /// @dev Reverts if the market is not registered.
    modifier onlyRegisteredMarket(address pendleMarket) {
        _requireRegisteredMarket(pendleMarket);
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

    /// @param pendleRouter_ Pendle Router (IPAllActionV3) address.
    /// @param comptroller_ Venus core pool Comptroller address.
    constructor(address pendleRouter_, address comptroller_) {
        if (pendleRouter_ == address(0)) revert ZeroAddress();
        if (comptroller_ == address(0)) revert ZeroAddress();
        PENDLE_ROUTER = pendleRouter_;
        COMPTROLLER = comptroller_;

        _disableInitializers();
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                          RECEIVE FUNCTION
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Accept native BNB (required for Pendle Router refunds during depositNative).
    receive() external payable {}

    // ═══════════════════════════════════════════════════════════════════════
    //                           INITIALIZER
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Initializes the proxy state. Called once after proxy deployment.
    /// @param accessControlManager_ Address of the Venus AccessControlManager contract.
    function initialize(address accessControlManager_) external reinitializer(1) {
        __AccessControlled_init(accessControlManager_);
        __Pausable_init();
        __ReentrancyGuard_init();
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                          CORE — DEPOSIT
    // ═══════════════════════════════════════════════════════════════════════

    // Note: deposit and depositNative have no beforeMaturity check —
    // Pendle Router naturally reverts post-maturity swaps.

    /// @inheritdoc IPendlePTVaultAdapter
    function deposit(
        address pendleMarket,
        uint256 minPtOut,
        ApproxParams calldata guessPtOut,
        TokenInput calldata input,
        LimitOrderData calldata limit
    ) external whenNotPaused nonReentrant onlyRegisteredMarket(pendleMarket) returns (uint256 netVTokensMinted) {
        if (input.netTokenIn == 0) revert ZeroAmount();
        if (input.tokenIn == address(0)) revert InvalidTokenInput();

        uint256 netPtOut;
        {
            MarketConfig storage config = markets[pendleMarket];
            address pt = config.pt;
            address vToken = config.vToken;
            uint256 ptBalanceBefore = IERC20(pt).balanceOf(address(this));

            // 1. Pull tokens from user → adapter (accepts any token from Pendle's tokensIn)
            uint256 balanceBefore = IERC20(input.tokenIn).balanceOf(address(this));
            IERC20(input.tokenIn).safeTransferFrom(msg.sender, address(this), input.netTokenIn);
            uint256 received = IERC20(input.tokenIn).balanceOf(address(this)) - balanceBefore;

            // Validate actual received amount matches Pendle's expected input
            if (input.netTokenIn != received) revert InputAmountMismatch(input.netTokenIn, received);

            // 2. Swap tokenIn → PT via Pendle Router (Pendle handles aggregator routing if needed)
            netPtOut = _swapToPt(pendleMarket, minPtOut, guessPtOut, input, limit);

            // 3. Deposit PT into Venus — vTokens go to user
            netVTokensMinted = _mintVTokens(pt, vToken, netPtOut);

            // 4. Safety sweep: not expected with exact-in swap, but guards against
            //    unexpected Router/token behavior leaving residual tokens in the adapter
            _sweepDust(pt, msg.sender, ptBalanceBefore);
            _sweepDust(input.tokenIn, msg.sender, balanceBefore);
        }

        emit Deposited(pendleMarket, msg.sender, input.tokenIn, input.netTokenIn, netPtOut, netVTokensMinted);
    }

    /// @inheritdoc IPendlePTVaultAdapter
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
        onlyRegisteredMarket(pendleMarket)
        returns (uint256 netVTokensMinted)
    {
        if (msg.value == 0) revert ZeroAmount();
        if (input.tokenIn != address(0)) revert InvalidTokenInput();

        MarketConfig storage config = markets[pendleMarket];
        address pt = config.pt;
        address vToken = config.vToken;
        uint256 ptBalanceBefore = IERC20(pt).balanceOf(address(this));
        uint256 nativeBalanceBefore = address(this).balance - msg.value;

        // Validate calldata consistency
        if (input.netTokenIn != msg.value) revert InputAmountMismatch(input.netTokenIn, msg.value);

        // 1. Swap native BNB → PT via Pendle Router
        uint256 netPtOut = _swapToPtNative(pendleMarket, minPtOut, guessPtOut, input, limit);

        // 2. Deposit PT into Venus — vTokens go to user
        netVTokensMinted = _mintVTokens(pt, vToken, netPtOut);

        // 3. Safety sweep: not expected with exact-in swap, but guards against
        //    unexpected Router behavior leaving residual PT in the adapter
        _sweepDust(pt, msg.sender, ptBalanceBefore);

        // 4. Safety refund: not expected with exact-in swap, but guards against
        //    unexpected native BNB returned to the adapter during the swap
        _refundNativeDust(nativeBalanceBefore);

        emit Deposited(pendleMarket, msg.sender, input.tokenIn, msg.value, netPtOut, netVTokensMinted);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                      CORE — WITHDRAW & REDEEM
    // ═══════════════════════════════════════════════════════════════════════

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
        onlyRegisteredMarket(pendleMarket)
        beforeMaturity(pendleMarket)
        returns (uint256 netTokenOut)
    {
        if (vTokenAmount == 0) revert ZeroAmount();

        MarketConfig storage config = markets[pendleMarket];
        address pt = config.pt;
        address vToken = config.vToken;

        // 1. Redeem vTokens → adapter receives PT
        uint256 ptBefore = IERC20(pt).balanceOf(address(this));
        _redeemVTokens(vToken, vTokenAmount);
        uint256 ptReceived = IERC20(pt).balanceOf(address(this)) - ptBefore;

        // 2. Swap PT → tokenOut via Pendle (sent directly to user, Pendle handles routing)
        netTokenOut = _swapPtToToken(pt, pendleMarket, ptReceived, output, limit);

        // 3. Safety sweep: not expected with exact-in swap, but guards against
        //    unexpected Router behavior leaving residual PT in the adapter
        _sweepDust(pt, msg.sender, ptBefore);

        emit Withdrawn(pendleMarket, msg.sender, output.tokenOut, vTokenAmount, ptReceived, netTokenOut);
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
        onlyRegisteredMarket(pendleMarket)
        atOrAfterMaturity(pendleMarket)
        returns (uint256 netTokenOut)
    {
        if (vTokenAmount == 0) revert ZeroAmount();

        MarketConfig storage config = markets[pendleMarket];
        address pt = config.pt;
        address vToken = config.vToken;
        address yt = config.yt;

        // 1. Redeem vTokens → adapter receives PT
        uint256 ptBefore = IERC20(pt).balanceOf(address(this));
        _redeemVTokens(vToken, vTokenAmount);
        uint256 ptReceived = IERC20(pt).balanceOf(address(this)) - ptBefore;

        // 2. Redeem PT 1:1 → tokenOut via Pendle (sent directly to user, Pendle handles routing)
        netTokenOut = _redeemPtToToken(pt, yt, ptReceived, output);

        // 3. Safety sweep: not expected with exact-in redemption, but guards against
        //    unexpected Router behavior leaving residual PT in the adapter
        _sweepDust(pt, msg.sender, ptBefore);

        emit RedeemedAtMaturity(pendleMarket, msg.sender, output.tokenOut, vTokenAmount, ptReceived, netTokenOut);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                          ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════

    /// @inheritdoc IPendlePTVaultAdapter
    function addMarket(address pendleMarket, address vToken) external {
        _checkAccessAllowed("addMarket(address,address)");
        if (pendleMarket == address(0)) revert ZeroAddress();
        if (vToken == address(0)) revert ZeroAddress();
        if (markets[pendleMarket].pt != address(0)) revert MarketAlreadyRegistered(pendleMarket);

        // Validate that the vToken is listed in the Comptroller
        if (!IVenusComptroller(COMPTROLLER).isMarketListed(vToken)) revert VTokenNotListed(vToken);

        // Derive token addresses and maturity from Pendle market contract
        // solhint-disable-next-line var-name-mixedcase
        (IStandardizedYield _SY, IPPrincipalToken _PT, IPYieldToken _YT) = IPMarket(pendleMarket).readTokens();

        // Validate that the vToken's underlying matches the derived PT
        if (IVenusVToken(vToken).underlying() != address(_PT)) revert UnderlyingMismatch(vToken, address(_PT));

        uint256 maturity = IPMarket(pendleMarket).expiry();

        markets[pendleMarket] = MarketConfig({
            pt: address(_PT),
            sy: address(_SY),
            yt: address(_YT),
            vToken: vToken,
            maturity: maturity
        });

        marketList.push(pendleMarket);

        emit MarketAdded(pendleMarket, address(_PT), vToken, maturity);
    }

    /// @inheritdoc IPendlePTVaultAdapter
    function pause() external {
        _checkAccessAllowed("pause()");
        _pause();
    }

    /// @inheritdoc IPendlePTVaultAdapter
    function unpause() external {
        _checkAccessAllowed("unpause()");
        _unpause();
    }

    /// @inheritdoc IPendlePTVaultAdapter
    function sweepTokens(address token, address to, uint256 amount) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
    }

    /// @inheritdoc IPendlePTVaultAdapter
    function sweepNative(address payable to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        Address.sendValue(to, amount);
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
        if (markets[pendleMarket].pt == address(0)) revert MarketNotRegistered(pendleMarket);
        return !(block.timestamp < markets[pendleMarket].maturity);
    }

    /// @inheritdoc IPendlePTVaultAdapter
    function isDelegated(address user) external view returns (bool) {
        return IVenusComptroller(COMPTROLLER).approvedDelegates(user, address(this));
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                        INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════════

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
        IERC20(input.tokenIn).forceApprove(PENDLE_ROUTER, input.netTokenIn);

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
     * @notice Swaps native BNB to PT via Pendle Router.
     * @param pendleMarket The Pendle market address for the swap.
     * @param minPtOut Minimum PT to receive (slippage protection).
     * @param guessPtOut Off-chain binary search approximation parameters.
     * @param input Token input configuration from Pendle API.
     * @param limit Limit order fill data.
     * @return netPtOut Amount of PT tokens received from the swap.
     * @dev Separated from _swapToPt to avoid stack-too-deep in depositNative.
     */
    function _swapToPtNative(
        address pendleMarket,
        uint256 minPtOut,
        ApproxParams calldata guessPtOut,
        TokenInput calldata input,
        LimitOrderData calldata limit
    ) internal returns (uint256 netPtOut) {
        (netPtOut, , ) = IPAllActionV3(PENDLE_ROUTER).swapExactTokenForPt{ value: msg.value }(
            address(this),
            pendleMarket,
            minPtOut,
            guessPtOut,
            input,
            limit
        );
    }

    /**
     * @notice Deposits PT into Venus and mints vTokens on behalf of the caller.
     * @param pt The PT token address to deposit.
     * @param vToken The Venus vToken address to mint into.
     * @param ptAmount Amount of PT tokens to deposit.
     * @return netVTokensMinted Amount of vTokens minted to msg.sender.
     * @dev Approves vToken, calls mintBehalf, then resets approval to zero.
     *      Reverts with VTokenMintFailed if the mint operation returns non-zero error.
     */
    function _mintVTokens(address pt, address vToken, uint256 ptAmount) internal returns (uint256 netVTokensMinted) {
        uint256 vTokenBalanceBefore = IVenusVToken(vToken).balanceOf(msg.sender);

        IERC20(pt).forceApprove(vToken, ptAmount);
        uint256 mintErr = IVenusVToken(vToken).mintBehalf(msg.sender, ptAmount);
        if (mintErr != 0) revert VTokenMintFailed(mintErr);

        netVTokensMinted = IVenusVToken(vToken).balanceOf(msg.sender) - vTokenBalanceBefore;
        if (netVTokensMinted == 0) revert ZeroVTokensMinted();

        IERC20(pt).forceApprove(vToken, 0);
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
     * @notice Redeems PT 1:1 to tokenOut via Pendle Router (post-maturity).
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
     * @notice Transfers only the dust accrued during the current transaction back to the recipient.
     * @param token The ERC-20 token address to sweep.
     * @param to The recipient address.
     * @param balanceBefore The adapter's token balance snapshot taken before operations began.
     * @dev Compares current balance against the pre-operation snapshot to sweep only the delta,
     *      preventing pre-existing balances from leaking to the caller.
     */
    function _sweepDust(address token, address to, uint256 balanceBefore) internal {
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance > balanceBefore) {
            IERC20(token).safeTransfer(to, balance - balanceBefore);
        }
    }

    /**
     * @notice Refunds only the native BNB dust accrued during the current transaction to the caller.
     * @param balanceBefore The adapter's native balance snapshot taken before operations began.
     */
    function _refundNativeDust(uint256 balanceBefore) internal {
        uint256 balance = address(this).balance;
        if (balance > balanceBefore) {
            Address.sendValue(payable(msg.sender), balance - balanceBefore);
        }
    }

    /**
     * @notice Validates that the market is registered.
     * @param pendleMarket The Pendle market address to validate.
     * @dev Reverts with MarketNotRegistered if PT address is zero.
     */
    function _requireRegisteredMarket(address pendleMarket) internal view {
        if (markets[pendleMarket].pt == address(0)) revert MarketNotRegistered(pendleMarket);
    }
}
