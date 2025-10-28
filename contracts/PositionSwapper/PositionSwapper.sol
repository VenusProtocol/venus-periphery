// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

import { Ownable2StepUpgradeable } from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import { SafeERC20Upgradeable, IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import { IVToken, IComptroller, IWBNB, IVBNB, IFlashLoanReceiver } from "../Interfaces.sol";
import { SwapHelper } from "../SwapHelper/SwapHelper.sol";

/**
 * @title PositionSwapper
 * @author Venus
 * @notice A contract to facilitate swapping collateral and debt positions between different vToken markets.
 * @custom:security-contact https://github.com/VenusProtocol/venus-periphery
 */
contract PositionSwapper is Ownable2StepUpgradeable, ReentrancyGuardUpgradeable, IFlashLoanReceiver {
    using SafeERC20Upgradeable for IERC20Upgradeable;

    /// @notice The Comptroller used for permission and liquidity checks.
    IComptroller public immutable COMPTROLLER;

    /// @notice The vToken representing the native asset (e.g., vBNB).
    IVBNB public immutable NATIVE_MARKET;

    /// @notice The vToken representing the wrapped native asset (e.g., vWBNB).
    IVToken public immutable WRAPPED_NATIVE_MARKET;

    /// @notice The swap helper contract for executing token swaps
    SwapHelper public immutable SWAP_HELPER;

    /// @notice The wrapped native token contract (e.g., WBNB)
    IWBNB public immutable WRAPPED_NATIVE;

    /// @notice Emitted after a successful collateral swap
    event CollateralSwapped(
        address indexed user,
        address indexed marketFrom,
        address indexed marketTo,
        uint256 amountSwapped
    );

    /// @notice Emitted when a user swaps their debt from one market to another
    event DebtSwapped(
        address indexed user,
        address indexed marketFrom,
        address indexed marketTo,
        uint256 amountSwapped,
        uint256 amountReceived
    );

    /// @notice Emitted when the owner sweeps leftover ERC-20 tokens.
    event SweepToken(address indexed token, address indexed receiver, uint256 amount);

    /// @notice Emitted when the owner sweeps leftover native tokens (e.g., BNB).
    event SweepNative(address indexed receiver, uint256 amount);

    /// @notice Emitted when an approved pair is updated.
    event ApprovedPairUpdated(address marketFrom, address marketTo, address helper, bool oldStatus, bool newStatus);

    enum OperationType {
        NONE,
        SWAP_COLLATERAL,
        SWAP_DEBT,
        SWAP_COLLATERAL_NATIVE_TO_WRAPPED,
        SWAP_DEBT_NATIVE_TO_WRAPPED
    }

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

    /// @custom:error NoCollateralBalance
    error NoCollateralBalance();

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

    /// @custom:error AccrueInterestFailed
    error AccrueInterestFailed(uint256 errCode);

    /// @custom:error SwapCallFailed
    error SwapCallFailed();

    /// @custom:error InvalidFlashLoanAmountReceived
    error InvalidFlashLoanAmountReceived();

    /// @custom:error UnauthorizedCaller
    error UnauthorizedCaller();

    /// @custom:error FlashLoanAssetOrAmountMismatch
    error FlashLoanAssetOrAmountMismatch();

    /// @custom:error ExecuteOperationNotCalledCorrectly
    error ExecuteOperationNotCalledCorrectly();

    /// @custom:error InvalidFlashLoanBorrowedAsset
    error InvalidFlashLoanBorrowedAsset();

    /// @custom:error InsufficientFundsToRepayFlashloan
    error InsufficientFundsToRepayFlashloan();

    /// @custom:error InsufficientAmountOutAfterSwap
    error InsufficientAmountOutAfterSwap();

    /// @custom:error NoEnoughBalance
    error NoEnoughBalance();

    /// @dev Transient slots used during flash loan workflows
    OperationType transient operationType;
    IVToken transient transientMarketFrom;
    IVToken transient transientMarketTo;
    uint256 transient transientDebtRepaymentAmount;
    uint256 transient transientMinAmountOutAfterSwap;
    uint256 transient transientCollateralRedeemAmount;

    /**
     * @notice Constructor to set immutable variables
     * @param _comptroller The address of the Comptroller contract
     * @param _swapHelper The address of the SwapHelper contract
     * @param _wrappedNative The address of the wrapped native token (e.g., WBNB)
     * @param _nativeVToken The address of the native vToken (e.g., vBNB)
     * @param _wrappedNativeVToken The address of the wrapped-native vToken (e.g., vWBNB)
     * @custom:oz-upgrades-unsafe-allow constructor
     */
    constructor(
        IComptroller _comptroller,
        SwapHelper _swapHelper,
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
     * @param user Address of the user.
     */
    function swapCollateralNativeToWrapped(address user) external nonReentrant {
        uint256 userBalance = NATIVE_MARKET.balanceOfUnderlying(user);
        transientCollateralRedeemAmount = NATIVE_MARKET.balanceOf(user);

        if (userBalance == 0) revert NoCollateralBalance();
        _swapCollateralNativeToWrapped(user, NATIVE_MARKET, WRAPPED_NATIVE_MARKET, userBalance);
        emit CollateralSwapped(user, address(NATIVE_MARKET), address(WRAPPED_NATIVE_MARKET), userBalance);
    }

    /**
     * @notice Swap user's entire native debt (e.g., vBNB borrow) into wrapped debt (e.g., vWBNB borrow).
     * @param user Address of the user.
     */
    function swapDebtNativeToWrapped(address user) external nonReentrant {
        uint256 borrowBalance = NATIVE_MARKET.borrowBalanceCurrent(user);
        if (borrowBalance == 0) revert NoBorrowBalance();
        uint256 amountReceived = _swapDebtNativeToWrapped(user, NATIVE_MARKET, WRAPPED_NATIVE_MARKET, borrowBalance);
        emit DebtSwapped(user, address(NATIVE_MARKET), address(WRAPPED_NATIVE_MARKET), borrowBalance, amountReceived);
    }

    /**
     * @notice Swaps the full vToken collateral of a user from one market to another.
     * @param user The address whose collateral is being swapped.
     * @param marketFrom The vToken market to seize from.
     * @param marketTo The vToken market to mint into.
     * @param minAmountToSupply Minimum amount of target underlying to supply after swap.
     * @param swapData Array of bytes containing swap instructions for the SwapHelper.
     * @custom:error NoCollateralBalance The user has no underlying balance in the `marketFrom`.
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
        if (userBalance == 0) revert NoCollateralBalance();
        _swapCollateral(user, marketFrom, marketTo, userBalance, minAmountToSupply, swapData);
        emit CollateralSwapped(user, address(marketFrom), address(marketTo), userBalance);
    }

    /**
     * @notice Swaps a specific amount of collateral from one market to another.
     * @param user The address whose collateral is being swapped.
     * @param marketFrom The vToken market to seize from.
     * @param marketTo The vToken market to mint into.
     * @param maxAmountToSwap The maximum amount of underlying to swap from `marketFrom`.
     * @param minAmountToSupply Minimum amount of target underlying to supply after swap.
     * @param swapData Array of bytes containing swap instructions for the SwapHelper.
     * @custom:error NoEnoughBalance The user has insufficient underlying balance in the `marketFrom`.
     * @custom:error ZeroAmount The `maxAmountToSwap` is zero.
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
        if (maxAmountToSwap > marketFrom.balanceOfUnderlying(user)) revert NoEnoughBalance();
        _swapCollateral(user, marketFrom, marketTo, maxAmountToSwap, minAmountToSupply, swapData);
        emit CollateralSwapped(user, address(marketFrom), address(marketTo), maxAmountToSwap);
    }

    /**
     * @notice Swaps the full debt of a user from one market to another.
     * @param user The address whose debt is being swapped.
     * @param marketFrom The vToken market from which debt is swapped.
     * @param marketTo The vToken market into which the new debt is borrowed.
     * @param maxDebtAmountToOpen Maximum amount to open as new debt on `marketTo` (before fee rounding).
     * @param swapData Array of bytes containing swap instructions for the SwapHelper.
     * @custom:error NoBorrowBalance The user has no borrow balance in the `marketFrom`.
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
        if (borrowBalance == 0) revert NoBorrowBalance();
        uint256 amountReceived = _swapDebt(user, marketFrom, marketTo, borrowBalance, maxDebtAmountToOpen, swapData);
        emit DebtSwapped(user, address(marketFrom), address(marketTo), borrowBalance, amountReceived);
    }

    /**
     * @notice Swaps a specific amount of debt from one market to another.
     * @param user The address whose debt is being swapped.
     * @param marketFrom The vToken market from which debt is swapped.
     * @param marketTo The vToken market into which the new debt is borrowed.
     * @param minDebtAmountToSwap The minimum amount of debt of `marketFrom` to repay.
     * @param maxDebtAmountToOpen The maximum amount to open as new debt on `marketTo`.
     * @param swapData Array of bytes containing swap instructions for the SwapHelper.
     * @custom:error NoBorrowBalance The user has insufficient borrow balance in the `marketFrom`.
     * @custom:error ZeroAmount The `minDebtAmountToSwap` is zero.
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
        if (minDebtAmountToSwap > marketFrom.borrowBalanceCurrent(user)) revert NoBorrowBalance();
        uint256 amountReceived = _swapDebt(
            user,
            marketFrom,
            marketTo,
            minDebtAmountToSwap,
            maxDebtAmountToOpen,
            swapData
        );
        emit DebtSwapped(user, address(marketFrom), address(marketTo), minDebtAmountToSwap, amountReceived);
    }

    /**
     * @notice Internal helper to swap native collateral to wrapped-native collateral via flash loan.
     * @param user Address of the user whose collateral is being migrated
     * @param marketFrom Native vToken market (e.g., vBNB)
     * @param marketTo Wrapped-native vToken market (e.g., vWBNB)
     * @param collateralAmountToSwap Amount of native underlying to migrate
     * @custom:error Throw MarketNotListed if any market is not listed in Comptroller
     * @custom:error Throw Unauthorized if caller is neither the user nor an approved delegate
     * @custom:error Throw SwapCausesLiquidation if the operation would make the account unsafe
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

        transientMarketFrom = marketFrom;
        transientMarketTo = marketTo;

        IVToken[] memory borrowedMarkets = new IVToken[](1);
        borrowedMarkets[0] = WRAPPED_NATIVE_MARKET;
        uint256[] memory flashLoanAmounts = new uint256[](1);
        flashLoanAmounts[0] = collateralAmountToSwap;

        _validateAndEnterMarket(user, marketFrom, marketTo);

        operationType = OperationType.SWAP_COLLATERAL_NATIVE_TO_WRAPPED;
        COMPTROLLER.executeFlashLoan(payable(user), payable(address(this)), borrowedMarkets, flashLoanAmounts, "0x");

        _checkAccountSafe(user);
    }

    /**
     * @notice Internal helper to swap native debt to wrapped-native debt via flash loan.
     * @param user Address of the user whose debt is being migrated
     * @param marketFrom Native vToken market (e.g., vBNB)
     * @param marketTo Wrapped-native vToken market (e.g., vWBNB)
     * @param debtRepaymentAmount Amount of native debt to repay
     * @return amountReceived Equal to repaid amount on the native market
     * @custom:error Throw MarketNotListed if any market is not listed in Comptroller
     * @custom:error Throw Unauthorized if caller is neither the user nor an approved delegate
     * @custom:error Throw SwapCausesLiquidation if the operation would make the account unsafe
     */
    function _swapDebtNativeToWrapped(
        address user,
        IVToken marketFrom,
        IVToken marketTo,
        uint256 debtRepaymentAmount
    ) internal returns (uint256 amountReceived) {
        _checkMarketListed(marketFrom);
        _checkMarketListed(marketTo);
        _checkUserAuthorized(user);
        _checkAccountSafe(user);

        transientMarketFrom = marketFrom;
        transientMarketTo = marketTo;
        transientDebtRepaymentAmount = debtRepaymentAmount;

        IVToken[] memory borrowedMarkets = new IVToken[](1);
        borrowedMarkets[0] = WRAPPED_NATIVE_MARKET;

        uint256[] memory flashLoanAmounts = new uint256[](1);
        uint256 flashLoanFee = marketFrom.flashLoanFeeMantissa();
        if (flashLoanFee != 0) {
            flashLoanAmounts[0] = calculateFlashLoanAmount(debtRepaymentAmount, flashLoanFee);
        } else {
            flashLoanAmounts[0] = debtRepaymentAmount;
        }

        operationType = OperationType.SWAP_DEBT_NATIVE_TO_WRAPPED;
        COMPTROLLER.executeFlashLoan(payable(user), payable(address(this)), borrowedMarkets, flashLoanAmounts, "0x");

        _checkAccountSafe(user);

        // In the native->wrapped debt path, the amount received is the amount of old-debt repaid
        return debtRepaymentAmount;
    }

    /**
     * @notice Internal function that performs the full collateral swap process.
     * @param user The address whose collateral is being swapped.
     * @param marketFrom The vToken market from which collateral is seized.
     * @param marketTo The vToken market into which the swapped collateral is minted.
     * @param maxAmountToSwap The amount of underlying to seize and convert.
     * @param swapData Array of bytes containing swap instructions for the SwapHelper.
     * @custom:error Throw MarketNotListed One of the specified markets is not listed in the Comptroller.
     * @custom:error Throw Unauthorized The caller is neither the user nor an approved delegate.
     * @custom:error Throw RedeemFailed The redeem operation fails.
     * @custom:error Throw NoUnderlyingReceived No output from the token swap.
     * @custom:error Throw MintFailed The mint operation fails.
     * @custom:error Throw AccrueInterestFailed The accrueInterest operation fails.
     * @custom:error Throw SwapCallFailed The token swap execution fails.
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
        transientMinAmountOutAfterSwap = minAmountToSupply;

        IVToken[] memory borrowedMarkets = new IVToken[](1);
        borrowedMarkets[0] = marketFrom;

        uint256[] memory flashLoanAmounts = new uint256[](1);
        flashLoanAmounts[0] = maxAmountToSwap;

        _validateAndEnterMarket(user, marketFrom, marketTo);

        operationType = OperationType.SWAP_COLLATERAL;
        COMPTROLLER.executeFlashLoan(
            payable(user),
            payable(address(this)),
            borrowedMarkets,
            flashLoanAmounts,
            abi.encodeWithSelector(SWAP_HELPER.multicall.selector, swapData)
        );

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
     * @return amountReceived The amount of underlying tokens received after the swap
     * @custom:error Throw MarketNotListed One of the specified markets is not listed in the Comptroller
     * @custom:error Throw Unauthorized The caller is neither the user nor an approved delegate
     * @custom:error Throw BorrowFailed The borrow operation fails
     * @custom:error Throw NoUnderlyingReceived No output from the token swap
     * @custom:error Throw RepayFailed The repay operation fails
     * @custom:error Throw SwapCallFailed The token swap execution fails
     */
    function _swapDebt(
        address user,
        IVToken marketFrom,
        IVToken marketTo,
        uint256 minDebtAmountToSwap,
        uint256 maxDebtAmountToOpen,
        bytes[] calldata swapData
    ) internal returns (uint256 amountReceived) {
        _checkMarketListed(marketFrom);
        _checkMarketListed(marketTo);
        _checkUserAuthorized(user);
        _checkAccountSafe(user);

        transientMarketFrom = marketFrom;
        transientMarketTo = marketTo;
        transientMinAmountOutAfterSwap = minDebtAmountToSwap;

        IVToken[] memory borrowedMarkets = new IVToken[](1);
        borrowedMarkets[0] = marketTo;

        uint256[] memory flashLoanAmounts = new uint256[](1);
        uint256 flashLoanFee = marketFrom.flashLoanFeeMantissa();
        if (flashLoanFee != 0) {
            flashLoanAmounts[0] = calculateFlashLoanAmount(maxDebtAmountToOpen, flashLoanFee);
        } else {
            flashLoanAmounts[0] = maxDebtAmountToOpen;
        }

        operationType = OperationType.SWAP_DEBT;
        COMPTROLLER.executeFlashLoan(
            payable(user),
            payable(address(this)),
            borrowedMarkets,
            flashLoanAmounts,
            abi.encodeWithSelector(SWAP_HELPER.multicall.selector, swapData)
        );

        _checkAccountSafe(user);

        // Return the amount that was repaid on marketFrom
        return minDebtAmountToSwap;
    }

    /**
     * @notice Flash loan callback entrypoint called by Comptroller.
     * @param vTokens Array with the borrowed vToken market (single element)
     * @param amounts Array with the borrowed underlying amount (single element)
     * @param premiums Array with the flash loan fee amount (single element)
     * @param onBehalf The user for whom the swap is performed
     * @param param Encoded auxiliary data for the operation (e.g., swap multicall)
     * @return success Whether the execution succeeded
     * @return repayAmounts Amounts to approve for flash loan repayment
     * @custom:error Throw UnauthorizedCaller when caller is not the Comptroller
     * @custom:error Throw FlashLoanAssetOrAmountMismatch when array lengths mismatch or > 1 element
     * @custom:error Throw ExecuteOperationNotCalledCorrectly when operation type is unknown
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
            revert UnauthorizedCaller();
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
            revert ExecuteOperationNotCalledCorrectly();
        }

        return (true, repayAmounts);
    }

    /**
     * @notice Executes native → wrapped-native collateral migration during flash loan.
     * @param onBehalf User for whom the migration is executed
     * @param borrowMarket Borrowed market (must equal `WRAPPED_NATIVE_MARKET`)
     * @param borrowedAssetAmount Amount borrowed from the flash loan
     * @param borrowedAssetFees Flash loan fee amount
     * @return borrowedAssetAmountToRepay Amount to approve back to the Comptroller
     * @custom:error Throw InvalidFlashLoanBorrowedAsset if `borrowMarket` is incorrect
     * @custom:error Throw InvalidFlashLoanAmountReceived if insufficient borrowed amount is observed
     * @custom:error Throw MintFailed when minting on target market fails
     * @custom:error Throw RedeemFailed when redeeming on source market fails
     * @custom:error Throw InsufficientFundsToRepayFlashloan when repayment cannot be covered
     */
    function _executeSwapCollateralNativeToWrapped(
        address onBehalf,
        IVToken borrowMarket,
        uint256 borrowedAssetAmount,
        uint256 borrowedAssetFees
    ) internal returns (uint256 borrowedAssetAmountToRepay) {
        uint256 err;
        // For vBNB to vWBNB we take flashLoan of WBNB as vBNB does not support flashLoan
        if (borrowMarket != WRAPPED_NATIVE_MARKET) revert InvalidFlashLoanBorrowedAsset();
        if (WRAPPED_NATIVE.balanceOf(address(this)) < borrowedAssetAmount) revert InvalidFlashLoanAmountReceived();

        // supply new collateral
        IERC20Upgradeable(address(WRAPPED_NATIVE)).forceApprove(
            address(transientMarketTo),
            borrowedAssetAmount - borrowedAssetFees
        );
        err = WRAPPED_NATIVE_MARKET.mintBehalf(onBehalf, borrowedAssetAmount - borrowedAssetFees);
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
        uint256 nativeBalanceAfter = address(this).balance - nativeBalanceBefore;

        // Wrap native tokens to repay FlashLoan
        borrowedAssetAmountToRepay = borrowedAssetAmount + borrowedAssetFees;
        if (nativeBalanceAfter < borrowedAssetAmount) {
            revert InsufficientFundsToRepayFlashloan();
        }
        WRAPPED_NATIVE.deposit{ value: nativeBalanceAfter }();
        IERC20Upgradeable(address(WRAPPED_NATIVE)).approve(address(COMPTROLLER), borrowedAssetAmountToRepay);

        // Transfer dust to user
        if (nativeBalanceAfter > borrowedAssetAmount) {
            IERC20Upgradeable(address(WRAPPED_NATIVE)).safeTransfer(onBehalf, nativeBalanceAfter - borrowedAssetAmount);
        }
    }

    /**
     * @notice Executes native → wrapped-native debt migration during flash loan.
     * @param onBehalf User for whom the migration is executed
     * @param borrowMarket Borrowed market (must equal `WRAPPED_NATIVE_MARKET`)
     * @param borrowedAssetAmount Amount borrowed from the flash loan
     * @param borrowedAssetFees Flash loan fee amount
     * @return borrowedAssetAmountToRepay Amount to approve back to the Comptroller
     * @custom:error Throw InvalidFlashLoanBorrowedAsset if `borrowMarket` is incorrect
     * @custom:error Throw InvalidFlashLoanAmountReceived if insufficient borrowed amount is observed
     * @custom:error Throw InsufficientAmountOutAfterSwap if unwrap produced less than required
     */
    function _executeSwapDebtNativeToWrapped(
        address onBehalf,
        IVToken borrowMarket,
        uint256 borrowedAssetAmount,
        uint256 borrowedAssetFees
    ) internal returns (uint256 borrowedAssetAmountToRepay) {
        // Flash loaned asset is the wrapped native token
        if (borrowMarket != WRAPPED_NATIVE_MARKET) revert InvalidFlashLoanBorrowedAsset();
        if (
            IERC20Upgradeable(address(WRAPPED_NATIVE)).balanceOf(address(this)) < borrowedAssetAmount ||
            transientDebtRepaymentAmount > borrowedAssetAmount - borrowedAssetFees
        ) {
            revert InvalidFlashLoanAmountReceived();
        }

        uint256 nativeBalanceBefore = address(this).balance;
        WRAPPED_NATIVE.withdraw(transientDebtRepaymentAmount);
        uint256 nativeBalanceReceived = address(this).balance - nativeBalanceBefore;
        if (nativeBalanceReceived < transientDebtRepaymentAmount) revert InsufficientAmountOutAfterSwap();
        NATIVE_MARKET.repayBorrowBehalf{ value: transientDebtRepaymentAmount }(onBehalf);

        // Approve Fee + dust
        borrowedAssetAmountToRepay = borrowedAssetAmount - transientDebtRepaymentAmount;
        IERC20Upgradeable(address(WRAPPED_NATIVE)).approve(address(COMPTROLLER), borrowedAssetAmountToRepay);
    }

    /**
     * @notice Executes generic collateral swap during flash loan.
     * @param onBehalf User for whom the migration is executed
     * @param borrowMarket Borrowed market to be repaid
     * @param borrowedAssetAmount Amount borrowed from the flash loan
     * @param borrowedAssetFees Flash loan fee amount
     * @param swapCallData Encoded `SWAP_HELPER.multicall` instructions
     * @return borrowedAssetAmountToRepay Amount to approve back to the Comptroller
     * @custom:error Throw InvalidFlashLoanAmountReceived if borrowed tokens don't match expectations
     * @custom:error Throw SwapCallFailed when swap call fails
     * @custom:error Throw MintFailed when mint on target market fails
     * @custom:error Throw RedeemFailed when redeem on source market fails
     * @custom:error Throw InsufficientFundsToRepayFlashloan when repayment cannot be covered
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
            transientCollateralRedeemAmount != borrowedAssetAmount ||
            fromUnderlying.balanceOf(address(this)) < borrowedAssetAmount
        ) revert InvalidFlashLoanAmountReceived();

        // Perform swap using SwapHelper
        uint256 toUnderlyingReceived = _performSwap(
            fromUnderlying,
            borrowedAssetAmount - borrowedAssetFees,
            toUnderlying,
            transientMinAmountOutAfterSwap,
            swapCallData
        );

        toUnderlying.forceApprove(address(transientMarketTo), toUnderlyingReceived);
        err = transientMarketTo.mintBehalf(onBehalf, toUnderlyingReceived);
        if (err != 0) revert MintFailed(err);

        // Pull user's vTokens to this contract to redeem underlying
        uint256 fromUnderlyingBalanceBefore = fromUnderlying.balanceOf(address(this));
        err = transientMarketFrom.redeemUnderlyingBehalf(onBehalf, transientCollateralRedeemAmount);
        if (err != 0) revert RedeemFailed(err);
        uint256 fromUnderlyingReceived = fromUnderlying.balanceOf(address(this)) - fromUnderlyingBalanceBefore;

        borrowedAssetAmountToRepay = fromUnderlyingReceived + borrowedAssetFees;
        if (fromUnderlyingReceived < borrowedAssetAmount) {
            revert InsufficientFundsToRepayFlashloan();
        }

        fromUnderlying.forceApprove(address(borrowMarket), borrowedAssetAmountToRepay);
    }

    /**
     * @notice Executes generic debt swap during flash loan.
     * @param onBehalf User for whom the migration is executed
     * @param borrowMarket Borrowed market to be repaid (target market of loan)
     * @param borrowedAssetAmount Amount borrowed from the flash loan
     * @param borrowedAssetFees Flash loan fee amount
     * @param swapCallData Encoded `SWAP_HELPER.multicall` instructions
     * @return borrowedAssetAmountToRepay Amount to approve back to the Comptroller
     * @custom:error Throw SwapCallFailed when swap call fails
     * @custom:error Throw RepayFailed when repay on source market fails
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

        // Perform swap using SwapHelper
        uint256 fromUnderlyingReceived = _performSwap(
            toUnderlying,
            borrowedAssetAmount - borrowedAssetFees,
            fromUnderlying,
            transientMinAmountOutAfterSwap,
            swapCallData
        );

        fromUnderlying.forceApprove(address(transientMarketFrom), transientMinAmountOutAfterSwap);
        err = transientMarketFrom.repayBorrowBehalf(onBehalf, transientMinAmountOutAfterSwap);
        if (err != 0) revert RepayFailed(err);

        // Transfer dust to user
        if (fromUnderlyingReceived > transientMinAmountOutAfterSwap) {
            fromUnderlying.safeTransfer(onBehalf, fromUnderlyingReceived - transientMinAmountOutAfterSwap);
        }

        borrowedAssetAmountToRepay = borrowedAssetFees;
        toUnderlying.forceApprove(address(borrowMarket), borrowedAssetAmountToRepay);
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
     * @custom:error SwapCallFailed if the swap execution fails
     */
    function _performSwap(
        IERC20Upgradeable tokenIn,
        uint256 amountIn,
        IERC20Upgradeable tokenOut,
        uint256 minAmountOut,
        bytes calldata param
    ) internal nonReentrant returns (uint256 amountOut) {
        tokenIn.safeTransfer(address(SWAP_HELPER), amountIn);

        uint256 tokenOutBalanceBefore = tokenOut.balanceOf(address(this));

        (bool success, ) = address(SWAP_HELPER).call(param);
        if (!success) {
            revert SwapCallFailed();
        }

        uint256 tokenOutBalanceAfter = tokenOut.balanceOf(address(this));

        amountOut = tokenOutBalanceAfter - tokenOutBalanceBefore;
        if (amountOut < minAmountOut) {
            revert InsufficientAmountOutAfterSwap();
        }

        return amountOut;
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

    function _validateAndEnterMarket(address user, IVToken marketFrom, IVToken marketTo) internal {
        if (COMPTROLLER.checkMembership(user, marketFrom) && !COMPTROLLER.checkMembership(user, marketTo)) {
            uint256 err = COMPTROLLER.enterMarket(user, address(marketTo));
            if (err != 0) revert EnterMarketFailed(err);
        }
    }

    /**
     * @dev Ensures that the given market is listed in the Comptroller.
     * @param market The vToken address to validate.
     */
    function _checkMarketListed(IVToken market) internal view {
        (bool isMarketListed, , ) = COMPTROLLER.markets(address(market));
        if (!isMarketListed) revert MarketNotListed(address(market));
    }

    /**
     * @notice Checks that the caller is authorized to act on behalf of the specified user.
     * @param user The address of the user for whom the action is being performed.
     */
    function _checkUserAuthorized(address user) internal view {
        if (user != msg.sender && !COMPTROLLER.approvedDelegates(user, msg.sender)) {
            revert Unauthorized(msg.sender);
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
