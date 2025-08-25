// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.25;

import { Ownable2StepUpgradeable } from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import { SafeERC20Upgradeable, IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import { IVToken, IComptroller, IVBNB } from "../Interfaces.sol";
import { ISwapHelper } from "./ISwapHelper.sol";

contract PositionSwapper is Ownable2StepUpgradeable, ReentrancyGuardUpgradeable {
    using SafeERC20Upgradeable for IERC20Upgradeable;

    /// @notice The Comptroller used for permission and liquidity checks.
    IComptroller public immutable COMPTROLLER;

    /// @notice The vToken representing the native asset (e.g., vBNB).
    address public immutable NATIVE_MARKET;

    /// @notice Mapping of approved swap pairs. (marketFrom => marketTo => helper => status)
    mapping(address => mapping(address => mapping(address => bool))) public approvedPairs;

    /// @notice Emitted after a successful swap and mint.
    event CollateralSwapped(address indexed user, address marketFrom, address marketTo, uint256 amountOut);

    /// @notice Emitted when a user swaps their debt from one market to another.
    event DebtSwapped(address indexed user, address marketFrom, address marketTo, uint256 amountOut);

    /// @notice Emitted when the owner sweeps leftover ERC-20 tokens.
    event SweepToken(address indexed token, address indexed receiver, uint256 amount);

    /// @notice Emitted when an approved pair is updated.
    event ApprovedPairUpdated(address marketFrom, address marketTo, address helper, bool oldStatus, bool newStatus);

    /// @custom:error Unauthorized Caller is neither the user nor an approved delegate.
    error Unauthorized();

    /// @custom:error SeizeFailed
    error SeizeFailed();

    /// @custom:error RedeemFailed
    error RedeemFailed();

    /// @custom:error BorrowFailed
    error BorrowFailed();

    /// @custom:error MintFailed
    error MintFailed();

    /// @custom:error RepayFailed
    error RepayFailed();

    /// @custom:error NoVTokenBalance
    error NoVTokenBalance();

    /// @custom:error NoBorrowBalance
    error NoBorrowBalance();

    /// @custom:error ZeroAmount
    error ZeroAmount();

    /// @custom:error NoUnderlyingReceived
    error NoUnderlyingReceived();

    /// @custom:error SwapCausesLiquidation
    error SwapCausesLiquidation();

    /// @custom:error MarketNotListed
    error MarketNotListed();

    /// @custom:error ZeroAddress
    error ZeroAddress();

    /// @custom:error TransferFailed
    error TransferFailed();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(address _comptroller, address _nativeMarket) {
        if (_comptroller == address(0)) revert ZeroAddress();

        COMPTROLLER = IComptroller(_comptroller);
        NATIVE_MARKET = _nativeMarket;
        _disableInitializers();
    }

    function initialize() external initializer {
        __Ownable2Step_init();
        __ReentrancyGuard_init();
    }

    /**
     * @notice Accepts native tokens (e.g., BNB) sent to this contract.
     */
    receive() external payable {}

    /**
     * @notice Swaps the full vToken collateral of a user from one market to another.
     * @param user The address whose collateral is being swapped.
     * @param marketFrom The vToken market to seize from.
     * @param marketTo The vToken market to mint into.
     * @param helper The ISwapHelper contract for performing the token swap.
     */
    function swapFullCollateral(
        address user,
        IVToken marketFrom,
        IVToken marketTo,
        ISwapHelper helper
    ) external payable nonReentrant {
        uint256 userBalance = marketFrom.balanceOf(user);
        if (userBalance == 0) revert NoVTokenBalance();
        _swapCollateral(user, marketFrom, marketTo, userBalance, helper);
        emit CollateralSwapped(user, address(marketFrom), address(marketTo), userBalance);
    }

    /**
     * @notice Swaps a specific amount of collateral from one market to another.
     * @param user The address whose collateral is being swapped.
     * @param marketFrom The vToken market to seize from.
     * @param marketTo The vToken market to mint into.
     * @param amountToSwap The amount of vTokens to seize and swap.
     * @param helper The ISwapHelper contract for performing the token swap.
     */
    function swapCollateralWithAmount(
        address user,
        IVToken marketFrom,
        IVToken marketTo,
        uint256 amountToSwap,
        ISwapHelper helper
    ) external payable nonReentrant {
        if (amountToSwap == 0) revert ZeroAmount();
        if (amountToSwap > marketFrom.balanceOf(user)) revert NoVTokenBalance();
        _swapCollateral(user, marketFrom, marketTo, amountToSwap, helper);
        emit CollateralSwapped(user, address(marketFrom), address(marketTo), amountToSwap);
    }

    /**
     * @notice Swaps the full debt of a user from one market to another.
     * @param user The address whose debt is being swapped.
     * @param marketFrom The vToken market from which debt is swapped.
     * @param marketTo The vToken market into which the new debt is borrowed.
     * @param helper The ISwapHelper contract for performing the token swap.
     */
    function swapFullDebt(
        address user,
        IVToken marketFrom,
        IVToken marketTo,
        ISwapHelper helper
    ) external payable nonReentrant {
        uint256 borrowBalance = marketFrom.borrowBalanceCurrent(user);
        if (borrowBalance == 0) revert NoBorrowBalance();
        _swapDebt(user, marketFrom, marketTo, borrowBalance, helper);
        emit DebtSwapped(user, address(marketFrom), address(marketTo), borrowBalance);
    }

    /**
     * @notice Swaps a specific amount of debt from one market to another.
     * @param user The address whose debt is being swapped.
     * @param marketFrom The vToken market from which debt is swapped.
     * @param marketTo The vToken market into which the new debt is borrowed.
     * @param amountToSwap The amount of debt to swap.
     * @param helper The ISwapHelper contract for performing the token swap.
     */
    function swapDebtWithAmount(
        address user,
        IVToken marketFrom,
        IVToken marketTo,
        uint256 amountToSwap,
        ISwapHelper helper
    ) external payable nonReentrant {
        if (amountToSwap == 0) revert ZeroAmount();
        if (amountToSwap > marketFrom.borrowBalanceCurrent(user)) revert NoBorrowBalance();
        _swapDebt(user, marketFrom, marketTo, amountToSwap, helper);
        emit DebtSwapped(user, address(marketFrom), address(marketTo), amountToSwap);
    }

    /**
     * @notice Allows the owner to sweep leftover ERC-20 tokens from the contract.
     * @param token The token to sweep.
     */
    function sweepToken(IERC20Upgradeable token) external onlyOwner {
        uint256 balance = token.balanceOf(address(this));
        if (balance > 0) {
            token.safeTransfer(owner(), balance);
            emit SweepToken(address(token), owner(), balance);
        }
    }

    /**
     * @notice Allows the owner to sweep leftover native tokens (e.g., BNB) from the contract.
     */
    function sweepNative() external onlyOwner {
        uint256 balance = address(this).balance;
        (bool success, ) = payable(owner()).call{ value: balance }("");
        if (!success) revert TransferFailed();
        emit SweepToken(address(0), owner(), balance);
    }

    /**
     * @notice Sets the approval status for a specific swap pair and helper.
     * @param marketFrom The vToken market to swap from.
     * @param marketTo The vToken market to swap to.
     * @param helper The ISwapHelper contract used for the swap.
     * @param status The approval status to set (true = approved, false = not approved).
     */
    function setApprovedPair(address marketFrom, address marketTo, address helper, bool status) external onlyOwner {
        emit ApprovedPairUpdated(marketFrom, marketTo, helper, approvedPairs[marketFrom][marketTo][helper], status);
        approvedPairs[marketFrom][marketTo][helper] = status;
    }

    /**
     * @notice Internal function that performs the full collateral swap process.
     * @param user The address whose collateral is being swapped.
     * @param marketFrom The vToken market from which collateral is seized.
     * @param marketTo The vToken market into which the swapped collateral is minted.
     * @param amountToSeize The amount of vTokens to seize and convert.
     * @param swapHelper The swap helper contract used to perform the token conversion.
     */
    function _swapCollateral(
        address user,
        IVToken marketFrom,
        IVToken marketTo,
        uint256 amountToSeize,
        ISwapHelper swapHelper
    ) internal {
        (bool isMarketListed, , ) = COMPTROLLER.markets(address(marketFrom));
        if (!isMarketListed) revert MarketNotListed();

        (isMarketListed, , ) = COMPTROLLER.markets(address(marketTo));
        if (!isMarketListed) revert MarketNotListed();

        if (user != msg.sender && !COMPTROLLER.approvedDelegates(user, msg.sender)) {
            revert Unauthorized();
        }

        _checkAccountSafe(user);

        if (marketFrom.seize(address(this), user, amountToSeize) != 0) revert SeizeFailed();

        address toUnderlyingAddress = marketTo.underlying();
        IERC20Upgradeable toUnderlying = IERC20Upgradeable(toUnderlyingAddress);
        uint256 toUnderlyingBalanceBefore = toUnderlying.balanceOf(address(this));

        if (address(marketFrom) == NATIVE_MARKET) {
            uint256 nativeBalanceBefore = address(this).balance;
            if (marketFrom.redeem(amountToSeize) != 0) revert RedeemFailed();

            uint256 receivedNative = address(this).balance - nativeBalanceBefore;
            if (receivedNative == 0) revert NoUnderlyingReceived();

            swapHelper.swapInternal{ value: receivedNative }(address(0), toUnderlyingAddress, receivedNative);
        } else {
            IERC20Upgradeable fromUnderlying = IERC20Upgradeable(marketFrom.underlying());
            uint256 fromUnderlyingBalanceBefore = fromUnderlying.balanceOf(address(this));

            if (marketFrom.redeem(amountToSeize) != 0) revert RedeemFailed();

            uint256 receivedFromToken = fromUnderlying.balanceOf(address(this)) - fromUnderlyingBalanceBefore;
            if (receivedFromToken == 0) revert NoUnderlyingReceived();

            fromUnderlying.forceApprove(address(swapHelper), receivedFromToken);

            swapHelper.swapInternal(address(fromUnderlying), toUnderlyingAddress, receivedFromToken);
        }

        uint256 toUnderlyingBalanceAfter = toUnderlying.balanceOf(address(this));
        uint256 toUnderlyingReceived = toUnderlyingBalanceAfter - toUnderlyingBalanceBefore;
        if (toUnderlyingReceived == 0) revert NoUnderlyingReceived();

        toUnderlying.forceApprove(address(marketTo), toUnderlyingReceived);
        if (marketTo.mintBehalf(user, toUnderlyingReceived) != 0) revert MintFailed();

        if (COMPTROLLER.checkMembership(user, marketFrom) && !COMPTROLLER.checkMembership(user, marketTo)) {
            COMPTROLLER.enterMarket(user, address(marketTo));
        }

        _checkAccountSafe(user);
    }

    /**
     * @notice Internal function that performs the full debt swap process.
     * @param user The address whose debt is being swapped.
     * @param marketFrom The vToken market to which debt is repaid.
     * @param marketTo The vToken market into which the new debt is borrowed.
     * @param amountToBorrow The amount of new debt to borrow.
     * @param swapHelper The swap helper contract used to perform the token conversion.
     */
    function _swapDebt(
        address user,
        IVToken marketFrom,
        IVToken marketTo,
        uint256 amountToBorrow,
        ISwapHelper swapHelper
    ) internal {
        (bool isMarketListed, , ) = COMPTROLLER.markets(address(marketFrom));
        if (!isMarketListed) revert MarketNotListed();

        (isMarketListed, , ) = COMPTROLLER.markets(address(marketTo));
        if (!isMarketListed) revert MarketNotListed();

        if (user != msg.sender && !COMPTROLLER.approvedDelegates(user, msg.sender)) {
            revert Unauthorized();
        }

        if (user != msg.sender && !COMPTROLLER.approvedDelegates(user, msg.sender)) {
            revert Unauthorized();
        }
        _checkAccountSafe(user);

        address toUnderlyingAddress = marketTo.underlying();
        IERC20Upgradeable toUnderlying = IERC20Upgradeable(toUnderlyingAddress);
        uint256 toUnderlyingBalanceBefore = toUnderlying.balanceOf(address(this));

        if (marketTo.borrowBehalf(user, amountToBorrow) != 0) revert BorrowFailed();

        uint256 toUnderlyingBalanceAfter = toUnderlying.balanceOf(address(this));
        uint256 receivedToUnderlying = toUnderlyingBalanceAfter - toUnderlyingBalanceBefore;

        toUnderlying.forceApprove(address(swapHelper), receivedToUnderlying);

        if (address(marketFrom) == NATIVE_MARKET) {
            uint256 fromUnderlyingBalanceBefore = address(this).balance;
            swapHelper.swapInternal(toUnderlyingAddress, address(0), receivedToUnderlying);
            uint256 receivedFromNative = address(this).balance - fromUnderlyingBalanceBefore;
            IVBNB(address(marketFrom)).repayBorrowBehalf{ value: receivedFromNative }(user);
        } else {
            IERC20Upgradeable fromUnderlying = IERC20Upgradeable(marketFrom.underlying());
            uint256 fromUnderlyingBalanceBefore = fromUnderlying.balanceOf(address(this));
            swapHelper.swapInternal(toUnderlyingAddress, marketFrom.underlying(), receivedToUnderlying);
            uint256 receivedFromToken = fromUnderlying.balanceOf(address(this)) - fromUnderlyingBalanceBefore;

            fromUnderlying.forceApprove(address(marketFrom), receivedFromToken);

            if (marketFrom.repayBorrowBehalf(user, receivedFromToken) != 0) revert RepayFailed();
        }

        _checkAccountSafe(user);
    }

    /**
     * @dev Checks if a user's account is safe post-swap.
     * @param user The address to check.
     */
    function _checkAccountSafe(address user) internal view {
        (uint256 err, , uint256 shortfall) = COMPTROLLER.getAccountLiquidity(user);
        if (err != 0 || shortfall > 0) revert SwapCausesLiquidation();
    }
}
