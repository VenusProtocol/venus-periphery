// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

import { Ownable2StepUpgradeable } from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import { SafeERC20Upgradeable, IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import { IVToken, IComptroller, IWBNB, IVBNB, IFlashLoanReceiver } from "../Interfaces.sol";
import { ISwapHelper } from "../SwapHelper/ISwapHelper.sol";
import { IPositionSwapper } from "./IPositionSwapper.sol";

/**
 * @title PositionSwapper
 * @author Venus
 * @notice A contract to facilitate swapping collateral and debt positions between different vToken markets.
 * @custom:security-contact https://github.com/VenusProtocol/venus-periphery
 */
contract PositionSwapper is Ownable2StepUpgradeable, ReentrancyGuardUpgradeable, IFlashLoanReceiver, IPositionSwapper {
    using SafeERC20Upgradeable for IERC20Upgradeable;

    /// @notice The Comptroller used for permission and liquidity checks.
    IComptroller public immutable COMPTROLLER;

    /// @notice The swap helper contract for executing token swaps
    ISwapHelper public immutable SWAP_HELPER;

    /// @notice The wrapped native token contract (e.g., WBNB)
    IWBNB public immutable WRAPPED_NATIVE;

    /// @notice The vToken representing the native asset (e.g., vBNB).
    IVBNB public immutable NATIVE_MARKET;

    /// @notice The vToken representing the wrapped native asset (e.g., vWBNB).
    IVToken public immutable WRAPPED_NATIVE_MARKET;

    /// @dev Transient slots used during flash loan workflows
    OperationType transient operationType;
    IVToken transient transientMarketFrom;
    IVToken transient transientMarketTo;
    uint256 transient transientDebtRepaymentAmount;
    uint256 transient transientCollateralRedeemAmount;
    uint256 transient transientMinAmountToSupply;

    /**
     * @notice Constructor to set immutable variables
     * @param _comptroller The address of the Comptroller contract
     * @param _swapHelper The address of the SwapHelper contract
     * @param _wrappedNative The address of the wrapped native token (e.g., WBNB)
     * @param _nativeVToken The address of the native vToken (e.g., vBNB)
     * @param _wrappedNativeVToken The address of the wrapped-native vToken (e.g., vWBNB)
     * @custom:error ZeroAddress If any of the provided addresses is zero
     * @custom:oz-upgrades-unsafe-allow constructor
     */
    constructor(
        IComptroller _comptroller,
        ISwapHelper _swapHelper,
        IWBNB _wrappedNative,
        IVBNB _nativeVToken,
        IVToken _wrappedNativeVToken
    ) {
        if (address(_comptroller) == address(0)) revert ZeroAddress();
        if (address(_swapHelper) == address(0)) revert ZeroAddress();
        if (address(_wrappedNative) == address(0)) revert ZeroAddress();
        if (address(_nativeVToken) == address(0)) revert ZeroAddress();
        if (address(_wrappedNativeVToken) == address(0)) revert ZeroAddress();

        COMPTROLLER = _comptroller;
        SWAP_HELPER = _swapHelper;
        WRAPPED_NATIVE = _wrappedNative;
        NATIVE_MARKET = _nativeVToken;
        WRAPPED_NATIVE_MARKET = _wrappedNativeVToken;
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
     * @custom:error TransferFailed Native transfer failed
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
     * @notice Swap user's entire native collateral (e.g., vBNB) into wrapped collateral (e.g., vWBNB).
     * @dev FlashLoan fee: will be adjusted in the `marketTo` (destination) collateral amount.
     * @dev User needs to add this PositionSwapper contract to their approved delegates to use this function.
     *      Additionally, user needs to approve vTokens to this PositionSwapper contract to allow redemption on behalf of user.
     *      Since vBNB does not support redeemBehalf, an explicit transfer approval for vTokens is needed for this function.
     * @param user The address whose collateral is being swapped.
     * @custom:error InsufficientCollateralBalance User has no native collateral
     * @custom:event Emits CollateralSwapped on success
     */
    function swapCollateralNativeToWrapped(address user) external nonReentrant {
        uint256 userBalance = NATIVE_MARKET.balanceOfUnderlying(user);
        if (userBalance == 0) revert InsufficientCollateralBalance();

        transientCollateralRedeemAmount = NATIVE_MARKET.balanceOf(user);
        _swapCollateralNativeToWrapped(user, NATIVE_MARKET, WRAPPED_NATIVE_MARKET, userBalance);
    }

    /**
     * @notice Swap user's entire native debt (e.g., vBNB borrow) into wrapped debt (e.g., vWBNB borrow).
     * @dev FlashLoan fee: extra debt will be opened (on `marketTo`) to cover the flash loan fee.
     * @dev User needs to add this PositionSwapper contract to their approved delegates to use this function.
     * @param user The address whose debt is being swapped.
     * @custom:error InsufficientBorrowBalance User has no native debt
     * @custom:event Emits DebtSwapped on success
     */
    function swapDebtNativeToWrapped(address user) external nonReentrant {
        uint256 borrowBalance = NATIVE_MARKET.borrowBalanceCurrent(user);
        if (borrowBalance == 0) revert InsufficientBorrowBalance();
        _swapDebtNativeToWrapped(user, NATIVE_MARKET, WRAPPED_NATIVE_MARKET, borrowBalance);
    }

    /**
     * @notice Swaps the full vToken collateral of a user from one market to another.
     * @dev FlashLoan fee: will be adjusted in the `marketTo` (destination) collateral amount.
     * @dev User needs to add this PositionSwapper contract to their approved delegates to use this function.
     * @param user The address whose collateral is being swapped.
     * @param marketFrom The vToken market to seize from.
     * @param marketTo The vToken market to mint into.
     * @param minAmountToSupply Minimum amount of target underlying to supply after swap.
     * @param swapData Array of bytes containing swap instructions for the SwapHelper.
     * @custom:error InsufficientCollateralBalance The user has no underlying balance in the `marketFrom`.
     * @custom:event Emits CollateralSwapped event.
     */
    function swapFullCollateral(
        address user,
        IVToken marketFrom,
        IVToken marketTo,
        uint256 minAmountToSupply,
        bytes[] calldata swapData
    ) external payable nonReentrant {
        uint256 userBalance = marketFrom.balanceOfUnderlying(user);
        if (userBalance == 0) revert InsufficientCollateralBalance();
        _swapCollateral(user, marketFrom, marketTo, userBalance, minAmountToSupply, swapData);
    }

    /**
     * @notice Swaps a specific amount of collateral from one market to another.
     * @dev FlashLoan fee: fee will be adjusted in the `marketTo` (destination) collateral amount.
     * @dev User needs to add this PositionSwapper contract to their approved delegates to use this function.
     * @param user The address whose collateral is being swapped.
     * @param marketFrom The vToken market to seize from.
     * @param marketTo The vToken market to mint into.
     * @param maxAmountToSwap The maximum amount of underlying to swap from `marketFrom`.
     * @param minAmountToSupply Minimum amount of target underlying to supply after swap.
     * @param swapData Array of bytes containing swap instructions for the SwapHelper.
     * @custom:error ZeroAmount The `maxAmountToSwap` is zero.
     * @custom:error InsufficientCollateralBalance The user has insufficient underlying balance in the `marketFrom`.
     * @custom:event Emits CollateralSwapped event.
     */
    function swapCollateralWithAmount(
        address user,
        IVToken marketFrom,
        IVToken marketTo,
        uint256 maxAmountToSwap,
        uint256 minAmountToSupply,
        bytes[] calldata swapData
    ) external payable nonReentrant {
        if (maxAmountToSwap == 0) revert ZeroAmount();
        if (maxAmountToSwap > marketFrom.balanceOfUnderlying(user)) revert InsufficientCollateralBalance();
        _swapCollateral(user, marketFrom, marketTo, maxAmountToSwap, minAmountToSupply, swapData);
    }

    /**
     * @notice Swaps the full debt of a user from one market to another.
     * @dev - FlashLoan fee: `maxDebtAmountToOpen` must include headroom to cover the flash-loan fee.
     *      - Slippage: `maxDebtAmountToOpen` also caps the amount borrowed/consumed by `swapData`; any refund of
     *        unused funds depends on the underlying swap API behavior.
     * @dev User needs to add this PositionSwapper contract to their approved delegates to use this function.
     * @param user The address whose debt is being swapped.
     * @param marketFrom The vToken market from which debt is swapped.
     * @param marketTo The vToken market into which the new debt is borrowed.
     * @param maxDebtAmountToOpen Maximum amount to open as new debt on `marketTo` (before fee rounding).
     * @param swapData Array of bytes containing swap instructions for the SwapHelper.
     * @custom:error InsufficientBorrowBalance The user has no borrow balance in the `marketFrom`.
     * @custom:event Emits DebtSwapped event.
     */
    function swapFullDebt(
        address user,
        IVToken marketFrom,
        IVToken marketTo,
        uint256 maxDebtAmountToOpen,
        bytes[] calldata swapData
    ) external payable nonReentrant {
        uint256 borrowBalance = marketFrom.borrowBalanceCurrent(user);
        if (borrowBalance == 0) revert InsufficientBorrowBalance();
        _swapDebt(user, marketFrom, marketTo, borrowBalance, maxDebtAmountToOpen, swapData);
    }

    /**
      * @notice Swaps a specific amount of debt from one market to another.
      * @dev - FlashLoan fee: `maxDebtAmountToOpen` must include headroom to cover the flash-loan fee.
      *      - Slippage: `maxDebtAmountToOpen` caps how much can be borrowed; if set high, the swap may consume up
      *        to this amount and any leftover/refund depends on the swap API invoked via `swapData`.
     * @dev User needs to add this PositionSwapper contract to their approved delegates to use this function.
     * @param user The address whose debt is being swapped.
     * @param marketFrom The vToken market from which debt is swapped.
     * @param marketTo The vToken market into which the new debt is borrowed.
     * @param minDebtAmountToSwap The minimum amount of debt of `marketFrom` to repay.
     * @param maxDebtAmountToOpen The maximum amount to open as new debt on `marketTo`.
     * @param swapData Array of bytes containing swap instructions for the SwapHelper.
     * @custom:error ZeroAmount The `minDebtAmountToSwap` is zero.
     * @custom:error InsufficientBorrowBalance The user has insufficient borrow balance in the `marketFrom`.
     * @custom:event Emits DebtSwapped event.
     */
    function swapDebtWithAmount(
        address user,
        IVToken marketFrom,
        IVToken marketTo,
        uint256 minDebtAmountToSwap,
        uint256 maxDebtAmountToOpen,
        bytes[] calldata swapData
    ) external payable nonReentrant {
        if (minDebtAmountToSwap == 0) revert ZeroAmount();
        if (minDebtAmountToSwap > marketFrom.borrowBalanceCurrent(user)) revert InsufficientBorrowBalance();
        _swapDebt(user, marketFrom, marketTo, minDebtAmountToSwap, maxDebtAmountToOpen, swapData);
    }

    /**
     * @notice Quotes how much needs to be borrowed in a flash loan to obtain `requiredAmount` after paying `feeRate`.
     * @dev Convenience helper that exposes the internal `calculateFlashLoanAmount` for external callers and tests.
     *      Flash loan fee impact: callers can subtract `flashLoanAmount * feeRate / 1e18` from the quote to
     *      validate the expected net amount, or use it to pre-compute the new debt to be opened on the target market.
     * @param requiredAmount The amount needed after paying the flash loan fee.
     * @param feeRate The flash loan fee rate, scaled by 1e18 (e.g. 1e15 = 0.1%).
     * @return flashLoanAmount The total amount to borrow in the flash loan.
     */
    function quoteFlashLoanAmount(
        uint256 requiredAmount,
        uint256 feeRate
    ) external pure returns (uint256 flashLoanAmount) {
        return calculateFlashLoanAmount(requiredAmount, feeRate);
    }

    /**
     * @notice Internal helper to swap native collateral to wrapped-native collateral via flash loan.
     * @param user Address of the user whose collateral is being migrated
     * @param marketFrom Native vToken market (e.g., vBNB)
     * @param marketTo Wrapped-native vToken market (e.g., vWBNB)
     * @param collateralAmountToSwap Amount of native underlying to migrate
     * @custom:error MarketNotListed If any market is not listed in Comptroller
     * @custom:error UnauthorizedCaller If caller is neither the user nor an approved delegate
     * @custom:error SwapCausesLiquidation If the operation would make the account unsafe
     * @custom:error EnterMarketFailed If entering destination market fails
     */
    function _swapCollateralNativeToWrapped(
        address user,
        IVToken marketFrom,
        IVToken marketTo,
        uint256 collateralAmountToSwap
    ) internal {
        _checkMarketListed(marketFrom);
        _checkMarketListed(marketTo);
        _checkUserAuthorized(user);
        _checkAccountSafe(user);

        IVToken[] memory borrowedMarkets = new IVToken[](1);
        borrowedMarkets[0] = WRAPPED_NATIVE_MARKET;
        uint256[] memory flashLoanAmounts = new uint256[](1);
        flashLoanAmounts[0] = collateralAmountToSwap;

        _validateAndEnterMarket(user, marketFrom, marketTo);
        operationType = OperationType.SWAP_COLLATERAL_NATIVE_TO_WRAPPED;
        uint256 wrappedNativeBalance = WRAPPED_NATIVE.balanceOf(address(this));

        // Executing flash loan here will trigger the Comptroller contract to call the executeOperation callback to this contract
        COMPTROLLER.executeFlashLoan(payable(user), payable(address(this)), borrowedMarkets, flashLoanAmounts, "0x");

        _refundDustToUser(user, WRAPPED_NATIVE_MARKET, wrappedNativeBalance);
        _checkAccountSafe(user);
    }

    /**
     * @notice Internal helper to swap native debt to wrapped-native debt via flash loan.
     * @param user Address of the user whose debt is being migrated
     * @param marketFrom Native vToken market (e.g., vBNB)
     * @param marketTo Wrapped-native vToken market (e.g., vWBNB)
     * @param debtRepaymentAmount Amount of native debt to repay
     * @custom:error MarketNotListed If any market is not listed in Comptroller
     * @custom:error UnauthorizedCaller If caller is neither the user nor an approved delegate
     * @custom:error SwapCausesLiquidation If the operation would make the account unsafe
     */
    function _swapDebtNativeToWrapped(
        address user,
        IVToken marketFrom,
        IVToken marketTo,
        uint256 debtRepaymentAmount
    ) internal {
        _checkMarketListed(marketFrom);
        _checkMarketListed(marketTo);
        _checkUserAuthorized(user);
        _checkAccountSafe(user);

        transientDebtRepaymentAmount = debtRepaymentAmount;
        IVToken[] memory borrowedMarkets = new IVToken[](1);
        borrowedMarkets[0] = WRAPPED_NATIVE_MARKET;

        uint256[] memory flashLoanAmounts = new uint256[](1);
        uint256 flashLoanFee = WRAPPED_NATIVE_MARKET.flashLoanFeeMantissa();
        flashLoanAmounts[0] = flashLoanFee == 0
            ? debtRepaymentAmount
            : calculateFlashLoanAmount(debtRepaymentAmount, flashLoanFee);

        operationType = OperationType.SWAP_DEBT_NATIVE_TO_WRAPPED;
        uint256 wrappedNativeBalance = WRAPPED_NATIVE.balanceOf(address(this));

        // Executing flash loan here will trigger the Comptroller contract to call the executeOperation callback to this contract
        COMPTROLLER.executeFlashLoan(payable(user), payable(address(this)), borrowedMarkets, flashLoanAmounts, "0x");

        _refundDustToUser(user, WRAPPED_NATIVE_MARKET, wrappedNativeBalance);
        _checkAccountSafe(user);
    }

    /**
     * @notice Internal function that performs the full collateral swap process.
     * @param user The address whose collateral is being swapped.
     * @param marketFrom The vToken market from which collateral is seized.
     * @param marketTo The vToken market into which the swapped collateral is minted.
     * @param maxAmountToSwap The amount of underlying to seize and convert.
     * @param minAmountToSupply Minimum amount of target underlying to supply after swap.
     * @param swapData Array of bytes containing swap instructions for the SwapHelper.
     * @custom:error MarketNotListed One of the specified markets is not listed in the Comptroller
     * @custom:error UnauthorizedCaller The caller is neither the user nor an approved delegate
     * @custom:error SwapCausesLiquidation If the operation would make the account unsafe
     * @custom:error EnterMarketFailed If entering destination market fails
     */
    function _swapCollateral(
        address user,
        IVToken marketFrom,
        IVToken marketTo,
        uint256 maxAmountToSwap,
        uint256 minAmountToSupply,
        bytes[] calldata swapData
    ) internal {
        _checkMarketListed(marketFrom);
        _checkMarketListed(marketTo);
        _checkUserAuthorized(user);
        _checkAccountSafe(user);

        transientMarketFrom = marketFrom;
        transientMarketTo = marketTo;
        transientCollateralRedeemAmount = maxAmountToSwap;
        transientMinAmountToSupply = minAmountToSupply;

        IVToken[] memory borrowedMarkets = new IVToken[](1);
        borrowedMarkets[0] = marketFrom;
        uint256[] memory flashLoanAmounts = new uint256[](1);
        flashLoanAmounts[0] = maxAmountToSwap;

        _validateAndEnterMarket(user, marketFrom, marketTo);

        uint256 fromBalanceBefore = IERC20Upgradeable(marketFrom.underlying()).balanceOf(address(this));
        uint256 toBalanceBefore = IERC20Upgradeable(marketTo.underlying()).balanceOf(address(this));

        operationType = OperationType.SWAP_COLLATERAL;
        // Executing flash loan here will trigger the Comptroller contract to call the executeOperation callback to this contract
        COMPTROLLER.executeFlashLoan(
            payable(user),
            payable(address(this)),
            borrowedMarkets,
            flashLoanAmounts,
            abi.encodeWithSelector(ISwapHelper.multicall.selector, swapData)
        );

        _refundDustToUser(user, marketFrom, fromBalanceBefore);
        _refundDustToUser(user, marketTo, toBalanceBefore);

        _checkAccountSafe(user);
    }

    /**
     * @notice Internal function that performs the debt swap process
     * @param user The address whose debt is being swapped
     * @param marketFrom The vToken market to which debt is repaid
     * @param marketTo The vToken market into which the new debt is borrowed (cannot be the native vToken)
     * @param minDebtAmountToSwap The minimum amount of `marketFrom` debt to repay
     * @param maxDebtAmountToOpen The maximum amount to open on `marketTo`
     * @param swapData Array of bytes containing swap instructions for the SwapHelper
     * @custom:error MarketNotListed One of the specified markets is not listed in the Comptroller
     * @custom:error UnauthorizedCaller The caller is neither the user nor an approved delegate
     * @custom:error SwapCausesLiquidation If the operation would make the account unsafe
     */
    function _swapDebt(
        address user,
        IVToken marketFrom,
        IVToken marketTo,
        uint256 minDebtAmountToSwap,
        uint256 maxDebtAmountToOpen,
        bytes[] calldata swapData
    ) internal {
        _checkMarketListed(marketFrom);
        _checkMarketListed(marketTo);
        _checkUserAuthorized(user);
        _checkAccountSafe(user);

        transientMarketFrom = marketFrom;
        transientMarketTo = marketTo;
        transientDebtRepaymentAmount = minDebtAmountToSwap;

        IVToken[] memory borrowedMarkets = new IVToken[](1);
        borrowedMarkets[0] = marketTo;
        uint256[] memory flashLoanAmounts = new uint256[](1);
        uint256 flashLoanFee = marketTo.flashLoanFeeMantissa();
        flashLoanAmounts[0] = flashLoanFee == 0
            ? maxDebtAmountToOpen
            : calculateFlashLoanAmount(maxDebtAmountToOpen, flashLoanFee);

        uint256 fromBalanceBeforeDebt = IERC20Upgradeable(marketFrom.underlying()).balanceOf(address(this));
        uint256 toBalanceBeforeDebt = IERC20Upgradeable(marketTo.underlying()).balanceOf(address(this));

        operationType = OperationType.SWAP_DEBT;
        // Executing flash loan here will trigger the Comptroller contract to call the executeOperation callback to this contract
        COMPTROLLER.executeFlashLoan(
            payable(user),
            payable(address(this)),
            borrowedMarkets,
            flashLoanAmounts,
            abi.encodeWithSelector(ISwapHelper.multicall.selector, swapData)
        );

        _refundDustToUser(user, marketFrom, fromBalanceBeforeDebt);
        _refundDustToUser(user, marketTo, toBalanceBeforeDebt);

        _checkAccountSafe(user);
    }

    /**
     * @notice Flash loan callback entrypoint called by Comptroller.
     * @param vTokens Array with the borrowed vToken market (single element)
     * @param amounts Array with the borrowed underlying amount (single element)
     * @param premiums Array with the flash loan fee amount (single element)
     * @param /initiator The address that initiated the flash loan (unused)
     * @param onBehalf The user for whome debt will be opened
     * @param param Encoded auxiliary data for the operation (e.g., swap multicall)
     * @return success Whether the execution succeeded
     * @return repayAmounts Amounts to approve for flash loan repayment
     * @custom:error UnauthorizedExecutor When caller is not the Comptroller
     * @custom:error FlashLoanAssetOrAmountMismatch When array lengths mismatch or > 1 element
     * @custom:error InvalidExecuteOperation When operation type is unknown
     */
    function executeOperation(
        IVToken[] calldata vTokens,
        uint256[] calldata amounts,
        uint256[] calldata premiums,
        address /* initiator */,
        address onBehalf,
        bytes calldata param
    ) external override returns (bool success, uint256[] memory repayAmounts) {
        if (msg.sender != address(COMPTROLLER)) {
            revert UnauthorizedExecutor();
        }
        if (vTokens.length != 1 || amounts.length != 1 || premiums.length != 1) {
            revert FlashLoanAssetOrAmountMismatch();
        }

        repayAmounts = new uint256[](1);
        if (operationType == OperationType.SWAP_COLLATERAL) {
            uint256 amountToRepay = _executeSwapCollateral(onBehalf, vTokens[0], amounts[0], premiums[0], param);
            repayAmounts[0] = amountToRepay;
        } else if (operationType == OperationType.SWAP_DEBT) {
            uint256 amountToRepay = _executeSwapDebt(onBehalf, vTokens[0], amounts[0], premiums[0], param);
            repayAmounts[0] = amountToRepay;
        } else if (operationType == OperationType.SWAP_COLLATERAL_NATIVE_TO_WRAPPED) {
            uint256 amountToRepay = _executeSwapCollateralNativeToWrapped(
                onBehalf,
                vTokens[0],
                amounts[0],
                premiums[0]
            );
            repayAmounts[0] = amountToRepay;
        } else if (operationType == OperationType.SWAP_DEBT_NATIVE_TO_WRAPPED) {
            uint256 amountToRepay = _executeSwapDebtNativeToWrapped(onBehalf, vTokens[0], amounts[0], premiums[0]);
            repayAmounts[0] = amountToRepay;
        } else {
            revert InvalidExecuteOperation();
        }

        return (true, repayAmounts);
    }

    /**
     * @notice Executes native → wrapped-native collateral migration during flash loan.
     * @param onBehalf User for whom the migration is executed
     * @param /borrowMarket Borrowed market (must equal `WRAPPED_NATIVE_MARKET`)
     * @param borrowedAssetAmount Amount borrowed from the flash loan
     * @param borrowedAssetFees Flash loan fee amount
     * @return borrowedAssetAmountToRepay Amount to approve back to the Comptroller
     * @custom:error InvalidFlashLoanAmountReceived If insufficient borrowed amount is observed
     * @custom:error MintFailed When minting on target market fails
     * @custom:error RedeemFailed When redeeming on source market fails
     * @custom:error InsufficientFundsToRepayFlashloan When repayment cannot be covered
     * @custom:event Emits CollateralSwapped on success
     */
    function _executeSwapCollateralNativeToWrapped(
        address onBehalf,
        IVToken /* borrowMarket */,
        uint256 borrowedAssetAmount,
        uint256 borrowedAssetFees
    ) internal returns (uint256 borrowedAssetAmountToRepay) {
        uint256 err;
        // For vBNB to vWBNB we take flashLoan of WBNB as vBNB does not support flashLoan
        if (WRAPPED_NATIVE.balanceOf(address(this)) < borrowedAssetAmount) revert InvalidFlashLoanAmountReceived();

        // supply new collateral
        uint256 newCollateralAmount = borrowedAssetAmount - borrowedAssetFees;
        IERC20Upgradeable(address(WRAPPED_NATIVE)).forceApprove(address(WRAPPED_NATIVE_MARKET), newCollateralAmount);
        err = WRAPPED_NATIVE_MARKET.mintBehalf(onBehalf, newCollateralAmount);
        if (err != 0) revert MintFailed(err);

        // redeem existing collateral (native)
        uint256 nativeBalanceBefore = address(this).balance;
        IERC20Upgradeable(address(NATIVE_MARKET)).safeTransferFrom(
            onBehalf,
            address(this),
            transientCollateralRedeemAmount
        );
        err = NATIVE_MARKET.redeem(transientCollateralRedeemAmount);
        if (err != 0) revert RedeemFailed(err);
        uint256 redeemedNativeAmount = address(this).balance - nativeBalanceBefore;

        // Wrap native tokens to repay FlashLoan
        if (redeemedNativeAmount < borrowedAssetAmount) {
            revert InsufficientFundsToRepayFlashloan();
        }
        WRAPPED_NATIVE.deposit{ value: redeemedNativeAmount }();
        borrowedAssetAmountToRepay = borrowedAssetAmount + borrowedAssetFees;
        IERC20Upgradeable(address(WRAPPED_NATIVE)).approve(address(WRAPPED_NATIVE_MARKET), borrowedAssetAmountToRepay);

        emit CollateralSwapped(
            onBehalf,
            address(NATIVE_MARKET),
            address(WRAPPED_NATIVE_MARKET),
            redeemedNativeAmount,
            newCollateralAmount
        );
    }

    /**
     * @notice Executes native → wrapped-native debt migration during flash loan.
     * @param onBehalf User for whom the migration is executed
     * @param /borrowMarket Borrowed market (must equal `WRAPPED_NATIVE_MARKET`)
     * @param borrowedAssetAmount Amount borrowed from the flash loan
     * @param borrowedAssetFees Flash loan fee amount
     * @return borrowedAssetAmountToRepay Amount to approve back to the Comptroller
     * @custom:error InvalidFlashLoanAmountReceived If insufficient borrowed amount is observed
     * @custom:error InsufficientFundsToRepayFlashloan If unwrap produced less than required
     * @custom:event Emits DebtSwapped on success
     */
    function _executeSwapDebtNativeToWrapped(
        address onBehalf,
        IVToken /* borrowMarket */,
        uint256 borrowedAssetAmount,
        uint256 borrowedAssetFees
    ) internal returns (uint256 borrowedAssetAmountToRepay) {
        // Flash loaned asset is the wrapped native token
        if (
            WRAPPED_NATIVE.balanceOf(address(this)) < borrowedAssetAmount ||
            transientDebtRepaymentAmount > borrowedAssetAmount - borrowedAssetFees
        ) revert InvalidFlashLoanAmountReceived();

        // Withdraw FlashLoaned WBNB to native BNB and repay existing borrow
        uint256 nativeBalanceBefore = address(this).balance;
        WRAPPED_NATIVE.withdraw(transientDebtRepaymentAmount);
        uint256 nativeBalanceReceived = address(this).balance - nativeBalanceBefore;
        if (nativeBalanceReceived < transientDebtRepaymentAmount) revert InsufficientFundsToRepayFlashloan();
        NATIVE_MARKET.repayBorrowBehalf{ value: transientDebtRepaymentAmount }(onBehalf);

        // Approve Fee + dust
        borrowedAssetAmountToRepay = borrowedAssetAmount - transientDebtRepaymentAmount;
        IERC20Upgradeable(address(WRAPPED_NATIVE)).approve(address(WRAPPED_NATIVE_MARKET), borrowedAssetAmountToRepay);

        // Emit event with precise amounts
        emit DebtSwapped(
            onBehalf,
            address(NATIVE_MARKET),
            address(WRAPPED_NATIVE_MARKET),
            transientDebtRepaymentAmount,
            borrowedAssetAmount
        );
    }

    /**
     * @notice Executes generic collateral swap during flash loan.
     * @param onBehalf User for whom the migration is executed
     * @param borrowMarket Borrowed market to be repaid
     * @param borrowedAssetAmount Amount borrowed from the flash loan
     * @param borrowedAssetFees Flash loan fee amount
     * @param swapCallData Encoded `SWAP_HELPER.multicall` instructions
     * @return borrowedAssetAmountToRepay Amount to approve back to the Comptroller
     * @custom:error InvalidFlashLoanAmountReceived If borrowed tokens don't match expectations
     * @custom:error MintFailed When mint on target market fails
     * @custom:error RedeemFailed When redeem on source market fails
     * @custom:error InsufficientFundsToRepayFlashloan When repayment cannot be covered
     * @custom:event Emits CollateralSwapped on success
     */
    function _executeSwapCollateral(
        address onBehalf,
        IVToken borrowMarket,
        uint256 borrowedAssetAmount,
        uint256 borrowedAssetFees,
        bytes calldata swapCallData
    ) internal returns (uint256 borrowedAssetAmountToRepay) {
        uint256 err;
        IERC20Upgradeable fromUnderlying = IERC20Upgradeable(transientMarketFrom.underlying());
        IERC20Upgradeable toUnderlying = IERC20Upgradeable(transientMarketTo.underlying());
        if (
            fromUnderlying.balanceOf(address(this)) < borrowedAssetAmount ||
            transientCollateralRedeemAmount != borrowedAssetAmount
        ) revert InvalidFlashLoanAmountReceived();

        // Perform swap using SwapHelper
        uint256 toUnderlyingReceived = _performSwap(
            fromUnderlying,
            borrowedAssetAmount - borrowedAssetFees,
            toUnderlying,
            transientMinAmountToSupply,
            swapCallData
        );

        toUnderlying.forceApprove(address(transientMarketTo), toUnderlyingReceived);
        err = transientMarketTo.mintBehalf(onBehalf, toUnderlyingReceived);
        if (err != 0) revert MintFailed(err);

        uint256 fromUnderlyingBalanceBefore = fromUnderlying.balanceOf(address(this));
        err = transientMarketFrom.redeemUnderlyingBehalf(onBehalf, transientCollateralRedeemAmount);
        if (err != 0) revert RedeemFailed(err);
        uint256 fromUnderlyingReceived = fromUnderlying.balanceOf(address(this)) - fromUnderlyingBalanceBefore;

        if (fromUnderlyingReceived < borrowedAssetAmount) {
            revert InsufficientFundsToRepayFlashloan();
        }

        borrowedAssetAmountToRepay = borrowedAssetAmount + borrowedAssetFees;
        fromUnderlying.forceApprove(address(borrowMarket), borrowedAssetAmountToRepay);

        emit CollateralSwapped(
            onBehalf,
            address(transientMarketFrom),
            address(transientMarketTo),
            transientCollateralRedeemAmount,
            toUnderlyingReceived
        );
    }

    /**
     * @notice Executes generic debt swap during flash loan.
     * @param onBehalf User for whom the migration is executed
     * @param borrowMarket Borrowed market to be repaid (target market of loan)
     * @param borrowedAssetAmount Amount borrowed from the flash loan
     * @param borrowedAssetFees Flash loan fee amount
     * @param swapCallData Encoded `SWAP_HELPER.multicall` instructions
     * @return borrowedAssetAmountToRepay Amount to approve back to the Comptroller
     * @custom:error InvalidFlashLoanAmountReceived If insufficient tokens received
     * @custom:error RepayFailed When repay on source market fails
     * @custom:event Emits DebtSwapped on success
     */
    function _executeSwapDebt(
        address onBehalf,
        IVToken borrowMarket,
        uint256 borrowedAssetAmount,
        uint256 borrowedAssetFees,
        bytes calldata swapCallData
    ) internal returns (uint256 borrowedAssetAmountToRepay) {
        uint256 err;
        IERC20Upgradeable fromUnderlying = IERC20Upgradeable(transientMarketFrom.underlying());
        IERC20Upgradeable toUnderlying = IERC20Upgradeable(transientMarketTo.underlying());
        if (toUnderlying.balanceOf(address(this)) < borrowedAssetAmount) revert InvalidFlashLoanAmountReceived();

        // Perform swap using SwapHelper
        _performSwap(
            toUnderlying,
            borrowedAssetAmount - borrowedAssetFees,
            fromUnderlying,
            transientDebtRepaymentAmount,
            swapCallData
        );

        fromUnderlying.forceApprove(address(transientMarketFrom), transientDebtRepaymentAmount);
        err = transientMarketFrom.repayBorrowBehalf(onBehalf, transientDebtRepaymentAmount);
        if (err != 0) revert RepayFailed(err);

        borrowedAssetAmountToRepay = borrowedAssetFees;
        toUnderlying.forceApprove(address(borrowMarket), borrowedAssetAmountToRepay);

        emit DebtSwapped(
            onBehalf,
            address(transientMarketFrom),
            address(transientMarketTo),
            transientDebtRepaymentAmount,
            borrowedAssetAmount
        );
    }

    /**
     * @notice Performs token swap via the SwapHelper contract
     * @dev Transfers tokens to SwapHelper and executes the swap operation.
     *      The swap operation is expected to return the output tokens to this contract.
     * @param tokenIn The input token to be swapped
     * @param amountIn The amount of input tokens to swap
     * @param tokenOut The output token to be received from the swap
     * @param minAmountOut The minimum acceptable `tokenOut` amount, else revert
     * @param param The encoded swap instructions/calldata for the SwapHelper
     * @return amountOut The amount of output tokens received
     * @custom:error TokenSwapCallFailed If the swap execution fails
     * @custom:error InsufficientAmountOutAfterSwap If swap output is below minimum
     */
    function _performSwap(
        IERC20Upgradeable tokenIn,
        uint256 amountIn,
        IERC20Upgradeable tokenOut,
        uint256 minAmountOut,
        bytes calldata param
    ) internal returns (uint256 amountOut) {
        tokenIn.safeTransfer(address(SWAP_HELPER), amountIn);
        uint256 tokenOutBalanceBefore = tokenOut.balanceOf(address(this));

        (bool success, ) = address(SWAP_HELPER).call(param);
        if (!success) {
            revert TokenSwapCallFailed();
        }

        amountOut = tokenOut.balanceOf(address(this)) - tokenOutBalanceBefore;
        if (amountOut < minAmountOut) {
            revert InsufficientAmountOutAfterSwap();
        }
    }

    /**
     * @dev Refunds any residual underlying tokens accrued during the operation back to the user.
     * @param user The address to receive the residual tokens.
     * @param market The vToken whose underlying is being refunded.
     * @param balanceBefore The contract's underlying balance before the operation.
     */
    function _refundDustToUser(address user, IVToken market, uint256 balanceBefore) internal {
        IERC20Upgradeable asset = IERC20Upgradeable(market.underlying());
        uint256 balanceAfter = asset.balanceOf(address(this));
        if (balanceAfter > balanceBefore) {
            uint256 dustAmount = balanceAfter - balanceBefore;
            asset.safeTransfer(user, dustAmount);
        }
    }

    /**
     * @notice Calculates how much needs to be borrowed in a flash loan to get the required amount after paying the fee.
     * @param requiredAmount The amount needed after the flash loan fee is paid.
     * @param feeRate The flash loan fee rate, scaled by 1e18 (e.g. 9e14 = 0.09%).
     * @return flashLoanAmount The total amount to borrow in the flash loan.
     */
    function calculateFlashLoanAmount(
        uint256 requiredAmount,
        uint256 feeRate
    ) internal pure returns (uint256 flashLoanAmount) {
        // feeRate should be expressed as a scaled number, e.g. 9e14 for 0.09% (since 1e18 = 100%)
        //  FA = x / (1 - r)
        uint256 denominator = 1e18 - feeRate;
        flashLoanAmount = (requiredAmount * 1e18) / denominator;
    }

    /**
     * @notice Ensures the `user` has entered the destination market before operations.
     * @dev If `user` is already a member of `marketFrom` and not of `marketTo`,
     *      this function calls Comptroller to enter `marketTo` on behalf of `user`.
     * @param user The account for which membership is validated/updated.
     * @param marketFrom The current vToken market the user participates in.
     * @param marketTo The target vToken market the user must enter.
     * @custom:error EnterMarketFailed When Comptroller.enterMarket returns a non-zero error code
     */
    function _validateAndEnterMarket(address user, IVToken marketFrom, IVToken marketTo) internal {
        if (COMPTROLLER.checkMembership(user, marketFrom) && !COMPTROLLER.checkMembership(user, marketTo)) {
            uint256 err = COMPTROLLER.enterMarket(user, address(marketTo));
            if (err != 0) revert EnterMarketFailed(err);
        }
    }

    /**
     * @dev Ensures that the given market is listed in the Comptroller.
     * @param market The vToken address to validate.
     * @custom:error MarketNotListed If the market is not listed in Comptroller
     */
    function _checkMarketListed(IVToken market) internal view {
        (bool isMarketListed, , ) = COMPTROLLER.markets(address(market));
        if (!isMarketListed) revert MarketNotListed(address(market));
    }

    /**
     * @notice Checks that the caller is authorized to act on behalf of the specified user.
     * @param user The address of the user for whom the action is being performed.
     * @custom:error UnauthorizedCaller If caller is neither the user nor an approved delegate
     */
    function _checkUserAuthorized(address user) internal view {
        if (user != msg.sender && !COMPTROLLER.approvedDelegates(user, msg.sender)) {
            revert UnauthorizedCaller(msg.sender);
        }
    }

    /**
     * @dev Checks if a user's account is safe post-swap.
     * @param user The address to check.
     * @custom:error SwapCausesLiquidation If the user's account is undercollateralized
     */
    function _checkAccountSafe(address user) internal view {
        (uint256 err, , uint256 shortfall) = COMPTROLLER.getAccountLiquidity(user);
        if (err != 0 || shortfall > 0) revert SwapCausesLiquidation(err);
    }
}
