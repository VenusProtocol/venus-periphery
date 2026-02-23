// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.25;

import { Ownable2StepUpgradeable } from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {
    SafeERC20Upgradeable,
    IERC20Upgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import { IComptroller } from "../Interfaces/IComptroller.sol";
import { IVBNB } from "../Interfaces/IVBNB.sol";
import { IVToken } from "../Interfaces/IVToken.sol";
import { ISwapHelper } from "./ISwapHelper.sol";

/**
 * @title PositionSwapper
 * @author Venus
 * @notice A contract to facilitate swapping collateral and debt positions between different vToken markets.
 * @custom:security-contact https://github.com/VenusProtocol/venus-periphery
 */
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

    /// @notice Emitted when the owner sweeps leftover native tokens (e.g., BNB).
    event SweepNative(address indexed receiver, uint256 amount);

    /// @notice Emitted when an approved pair is updated.
    event ApprovedPairUpdated(address marketFrom, address marketTo, address helper, bool oldStatus, bool newStatus);

    /// @custom:error Unauthorized Caller is neither the user nor an approved delegate.
    error Unauthorized(address account);

    /// @custom:error SeizeFailed
    error SeizeFailed(uint256 err);

    /// @custom:error RedeemFailed
    error RedeemFailed(uint256 err);

    /// @custom:error BorrowFailed
    error BorrowFailed(uint256 err);

    /// @custom:error MintFailed
    error MintFailed(uint256 err);

    /// @custom:error RepayFailed
    error RepayFailed(uint256 err);

    /// @custom:error NoVTokenBalance
    error NoVTokenBalance();

    /// @custom:error NoBorrowBalance
    error NoBorrowBalance();

    /// @custom:error ZeroAmount
    error ZeroAmount();

    /// @custom:error NoUnderlyingReceived
    error NoUnderlyingReceived();

    /// @custom:error SwapCausesLiquidation
    error SwapCausesLiquidation(uint256 err);

    /// @custom:error MarketNotListed
    error MarketNotListed(address market);

    /// @custom:error ZeroAddress
    error ZeroAddress();

    /// @custom:error TransferFailed
    error TransferFailed();

    /// @custom:error EnterMarketFailed
    error EnterMarketFailed(uint256 err);

    /// @custom:error NotApprovedHelper
    error NotApprovedHelper();

    /// @custom:error InvalidMarkets
    error InvalidMarkets();

    /// @custom:error AccrueInterestFailed
    error AccrueInterestFailed(uint256 errCode);

    /**
     * @notice Constructor to set immutable variables.
     * @param _comptroller The address of the Comptroller contract.
     * @param _nativeMarket The address of the native market (e.g., vBNB).
     * @custom:error Throw ZeroAddress if comptroller address is zero.
     */
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(address _comptroller, address _nativeMarket) {
        if (_comptroller == address(0)) revert ZeroAddress();
        if (_nativeMarket == address(0)) revert ZeroAddress();

        COMPTROLLER = IComptroller(_comptroller);
        NATIVE_MARKET = _nativeMarket;
        _disableInitializers();
    }

    /**
     * @notice Initializes the contract, setting the deployer as the initial owner.
     */
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
     * @custom:error Throw NoVTokenBalance The user has no vToken balance in the marketFrom.
     * @custom:event Emits CollateralSwapped event.
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
     * @custom:error Throw NoVTokenBalance The user has insufficient vToken balance in the marketFrom.
     * @custom:error Throw ZeroAmount The amountToSwap is zero.
     * @custom:event Emits CollateralSwapped event.
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
     * @custom:error Throw NoBorrowBalance The user has no borrow balance in the marketFrom.
     * @custom:event Emits DebtSwapped event.
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
     * @custom:error Throw NoBorrowBalance The user has insufficient borrow balance in the marketFrom.
     * @custom:error Throw ZeroAmount The amountToSwap is zero.
     * @custom:event Emits DebtSwapped event.
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
     * @custom:event Emits SweepToken event.
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
     * @custom:event Emits SweepNative event.
     */
    function sweepNative() external onlyOwner {
        uint256 balance = address(this).balance;
        if (balance > 0) {
            (bool success, ) = payable(owner()).call{ value: balance }("");
            if (!success) revert TransferFailed();
            emit SweepNative(owner(), balance);
        }
    }

    /**
     * @notice Sets the approval status for a specific swap pair and helper.
     * @param marketFrom The vToken market to swap from.
     * @param marketTo The vToken market to swap to.
     * @param helper The ISwapHelper contract used for the swap.
     * @param status The approval status to set (true = approved, false = not approved).
     * @custom:error Throw ZeroAddress if any address parameter is zero.
     * @custom:error Throw InvalidMarkets if marketFrom and marketTo are the same.
     * @custom:event Emits ApprovedPairUpdated event.
     */
    function setApprovedPair(address marketFrom, address marketTo, address helper, bool status) external onlyOwner {
        if (marketFrom == address(0) || marketTo == address(0) || helper == address(0)) {
            revert ZeroAddress();
        }

        if (marketFrom == marketTo) {
            revert InvalidMarkets();
        }

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
     * @custom:error Throw NotApprovedHelper if the specified swap pair and helper are not approved.
     * @custom:error Throw MarketNotListed if one of the specified markets is not listed in the Comptroller.
     * @custom:error Throw Unauthorized if the caller is neither the user nor an approved delegate.
     * @custom:error Throw SeizeFailed if the seize operation fails.
     * @custom:error Throw RedeemFailed if the redeem operation fails.
     * @custom:error Throw NoUnderlyingReceived if no underlying tokens are received from the swap.
     * @custom:error Throw MintFailed if the mint operation fails.
     * @custom:error Throw AccrueInterestFailed if the accrueInterest operation fails.
     */
    function _swapCollateral(
        address user,
        IVToken marketFrom,
        IVToken marketTo,
        uint256 amountToSeize,
        ISwapHelper swapHelper
    ) internal {
        if (!approvedPairs[address(marketFrom)][address(marketTo)][address(swapHelper)]) {
            revert NotApprovedHelper();
        }

        (bool isMarketListed, , ) = COMPTROLLER.markets(address(marketFrom));
        if (!isMarketListed) revert MarketNotListed(address(marketFrom));

        (isMarketListed, , ) = COMPTROLLER.markets(address(marketTo));
        if (!isMarketListed) revert MarketNotListed(address(marketTo));

        if (user != msg.sender && !COMPTROLLER.approvedDelegates(user, msg.sender)) {
            revert Unauthorized(msg.sender);
        }

        _accrueInterest(marketFrom);
        _checkAccountSafe(user);

        uint256 err = marketFrom.seize(address(this), user, amountToSeize);
        if (err != 0) revert SeizeFailed(err);

        address toUnderlyingAddress = marketTo.underlying();
        IERC20Upgradeable toUnderlying = IERC20Upgradeable(toUnderlyingAddress);
        uint256 toUnderlyingBalanceBefore = toUnderlying.balanceOf(address(this));

        if (address(marketFrom) == NATIVE_MARKET) {
            uint256 nativeBalanceBefore = address(this).balance;
            err = marketFrom.redeem(amountToSeize);
            if (err != 0) revert RedeemFailed(err);

            uint256 receivedNative = address(this).balance - nativeBalanceBefore;
            if (receivedNative == 0) revert NoUnderlyingReceived();

            swapHelper.swapInternal{ value: receivedNative }(address(0), toUnderlyingAddress, receivedNative);
        } else {
            IERC20Upgradeable fromUnderlying = IERC20Upgradeable(marketFrom.underlying());
            uint256 fromUnderlyingBalanceBefore = fromUnderlying.balanceOf(address(this));

            err = marketFrom.redeem(amountToSeize);
            if (err != 0) revert RedeemFailed(err);

            uint256 receivedFromToken = fromUnderlying.balanceOf(address(this)) - fromUnderlyingBalanceBefore;
            if (receivedFromToken == 0) revert NoUnderlyingReceived();

            fromUnderlying.forceApprove(address(swapHelper), receivedFromToken);

            swapHelper.swapInternal(address(fromUnderlying), toUnderlyingAddress, receivedFromToken);
        }

        uint256 toUnderlyingReceived = toUnderlying.balanceOf(address(this)) - toUnderlyingBalanceBefore;
        if (toUnderlyingReceived == 0) revert NoUnderlyingReceived();

        toUnderlying.forceApprove(address(marketTo), toUnderlyingReceived);

        err = marketTo.mintBehalf(user, toUnderlyingReceived);
        if (err != 0) revert MintFailed(err);

        if (COMPTROLLER.checkMembership(user, marketFrom) && !COMPTROLLER.checkMembership(user, marketTo)) {
            err = COMPTROLLER.enterMarket(user, address(marketTo));
            if (err != 0) revert EnterMarketFailed(err);
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
     * @custom:error Throw NotApprovedHelper if the swap helper is not approved for the given markets.
     * @custom:error Throw MarketNotListed if one of the specified markets is not listed in the Comptroller.
     * @custom:error Throw Unauthorized if the caller is neither the user nor an approved delegate.
     * @custom:error Throw BorrowFailed if the borrow operation fails.
     * @custom:error Throw NoUnderlyingReceived if no underlying tokens are received from the swap.
     * @custom:error Throw RepayFailed if the repay operation fails.
     */
    function _swapDebt(
        address user,
        IVToken marketFrom,
        IVToken marketTo,
        uint256 amountToBorrow,
        ISwapHelper swapHelper
    ) internal {
        if (!approvedPairs[address(marketFrom)][address(marketTo)][address(swapHelper)]) {
            revert NotApprovedHelper();
        }

        (bool isMarketListed, , ) = COMPTROLLER.markets(address(marketFrom));
        if (!isMarketListed) revert MarketNotListed(address(marketFrom));

        (isMarketListed, , ) = COMPTROLLER.markets(address(marketTo));
        if (!isMarketListed) revert MarketNotListed(address(marketTo));

        if (user != msg.sender && !COMPTROLLER.approvedDelegates(user, msg.sender)) {
            revert Unauthorized(msg.sender);
        }

        _checkAccountSafe(user);

        address toUnderlyingAddress = marketTo.underlying();
        IERC20Upgradeable toUnderlying = IERC20Upgradeable(toUnderlyingAddress);
        uint256 toUnderlyingBalanceBefore = toUnderlying.balanceOf(address(this));

        uint256 err = marketTo.borrowBehalf(user, amountToBorrow);
        if (err != 0) revert BorrowFailed(err);

        uint256 receivedToUnderlying = toUnderlying.balanceOf(address(this)) - toUnderlyingBalanceBefore;

        toUnderlying.forceApprove(address(swapHelper), receivedToUnderlying);

        if (address(marketFrom) == NATIVE_MARKET) {
            uint256 fromUnderlyingBalanceBefore = address(this).balance;
            swapHelper.swapInternal(toUnderlyingAddress, address(0), receivedToUnderlying);
            uint256 receivedFromNative = address(this).balance - fromUnderlyingBalanceBefore;
            IVBNB(NATIVE_MARKET).repayBorrowBehalf{ value: receivedFromNative }(user);
        } else {
            IERC20Upgradeable fromUnderlying = IERC20Upgradeable(marketFrom.underlying());
            uint256 fromUnderlyingBalanceBefore = fromUnderlying.balanceOf(address(this));
            swapHelper.swapInternal(toUnderlyingAddress, address(fromUnderlying), receivedToUnderlying);
            uint256 receivedFromToken = fromUnderlying.balanceOf(address(this)) - fromUnderlyingBalanceBefore;

            fromUnderlying.forceApprove(address(marketFrom), receivedFromToken);

            err = marketFrom.repayBorrowBehalf(user, receivedFromToken);
            if (err != 0) revert RepayFailed(err);
        }

        _checkAccountSafe(user);
    }

    /**
     * @dev Accrue interests on the vToken, reverting the transaction on failure
     * @param vToken The VToken whose interests we want to accrue
     * @custom:error Thrwo AccrueInterestFailed if accrueInterest action fails on the VToken
     */
    function _accrueInterest(IVToken vToken) internal {
        uint256 err = vToken.accrueInterest();
        if (err != 0) {
            revert AccrueInterestFailed(err);
        }
    }

    /**
     * @dev Checks if a user's account is safe post-swap.
     * @param user The address to check.
     * @custom:error Throw SwapCausesLiquidation if the user's account is undercollateralized.
     */
    function _checkAccountSafe(address user) internal view {
        (uint256 err, , uint256 shortfall) = COMPTROLLER.getAccountLiquidity(user);
        if (err != 0 || shortfall > 0) revert SwapCausesLiquidation(err);
    }
}
