// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

import { Ownable2StepUpgradeable } from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import { SafeERC20Upgradeable, IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";

import { IVToken, IComptroller, IFlashLoanReceiver } from "../Interfaces.sol";
import { SwapHelper } from "../SwapHelper/SwapHelper.sol";

import { ILeverageStrategiesManager } from "./ILeverageStrategiesManager.sol";

/**
 * @title LeverageStrategiesManager
 * @author Venus Protocol
 * @notice Contract for managing leveraged positions using flash loans and token swaps
 */
contract LeverageStrategiesManager is Ownable2StepUpgradeable, ReentrancyGuardUpgradeable, IFlashLoanReceiver, ILeverageStrategiesManager {
    using SafeERC20Upgradeable for IERC20Upgradeable;

    /// @dev Success return value for VToken operations (mint, borrow, repay, redeem)
    uint256 private constant SUCCESS = 0;

    /// @dev Mantissa for fixed-point arithmetic (1e18 = 100%)
    uint256 private constant MANTISSA_ONE = 1e18;

    /// @notice The Venus comptroller contract for market interactions and flash loans execution
    IComptroller public immutable COMPTROLLER;
    
    /// @notice The swap helper contract for executing token swaps during leverage operations
    SwapHelper public immutable swapHelper;

    /// @notice The vBNB market address (not supported for leverage operations)
    IVToken public immutable vBNB;

    /// @dev Transient (EIP-1153): Cleared at transaction end. Tracks operation type during flash loan callback.
    OperationType transient operationType;

    /// @dev Transient (EIP-1153): Cleared at transaction end. Stores msg.sender for flash loan callback context.
    address transient operationInitiator;
    
    /// @dev Transient (EIP-1153): Cleared at transaction end. Stores collateral market for flash loan callback.
    IVToken transient collateralMarket;
    
    /// @dev Transient (EIP-1153): Cleared at transaction end. Stores collateral seed (enter) or redeem amount (exit).
    uint256 transient collateralAmount;
    
    /// @dev Transient (EIP-1153): Cleared at transaction end. Stores borrowed amount seed for enterLeverageFromBorrow.
    uint256 transient borrowedAmountSeed;
    
    /// @dev Transient (EIP-1153): Cleared at transaction end. Stores minimum expected output after swap.
    uint256 transient minAmountOutAfterSwap;

    /**
     * @notice Contract constructor
     * @dev Sets immutable variables and disables initializers for the implementation contract
     * @param _comptroller The Venus comptroller contract address
     * @param _swapHelper The swap helper contract address
     * @param _vBNB The vBNB market address (not supported for leverage operations)
     * @custom:oz-upgrades-unsafe-allow constructor
     */
    constructor(IComptroller _comptroller, SwapHelper _swapHelper, IVToken _vBNB) {
        if(address(_comptroller) == address(0) || address(_swapHelper) == address(0) || address(_vBNB) == address(0)) {
            revert ZeroAddress();
        }

        COMPTROLLER = _comptroller;
        swapHelper = _swapHelper;
        vBNB = _vBNB;
        _disableInitializers();
    }

    /**
     * @notice Initializes the contract
     * @dev Sets up the Ownable2Step functionality. Can only be called once.
     */
    function initialize() external initializer {
        __Ownable2Step_init();
        __ReentrancyGuard_init();
    }

    /// @inheritdoc ILeverageStrategiesManager
    function enterSingleAssetLeverage(
        IVToken _collateralMarket,
        uint256 _collateralAmountSeed,
        uint256 _collateralAmountToFlashLoan
    ) external {
        if (_collateralAmountToFlashLoan == 0) revert ZeroFlashLoanAmount();
        _checkMarketSupported(_collateralMarket);

        _checkUserDelegated();

        _validateAndEnterMarket(msg.sender, _collateralMarket);
        _ensureAccountLiquidityValid(msg.sender);

        _transferSeedAmountFromUser(_collateralMarket, msg.sender, _collateralAmountSeed);

        operationInitiator = msg.sender;
        operationType = OperationType.ENTER_SINGLE_ASSET;
        collateralAmount = _collateralAmountSeed;

        IVToken[] memory borrowedMarkets = new IVToken[](1);
        borrowedMarkets[0] = _collateralMarket;
        uint256[] memory flashLoanAmounts = new uint256[](1);
        flashLoanAmounts[0] = _collateralAmountToFlashLoan;

        COMPTROLLER.executeFlashLoan(
            payable(msg.sender),
            payable(address(this)),
            borrowedMarkets,
            flashLoanAmounts,
            ""
        );

        _ensureNotLiquidatable(msg.sender);

        emit SingleAssetLeverageEntered(
            msg.sender,
            _collateralMarket,
            _collateralAmountSeed,
            _collateralAmountToFlashLoan
        );

        _transferDustToInitiator(_collateralMarket);
    }


    /// @inheritdoc ILeverageStrategiesManager
    function enterLeverage(
        IVToken _collateralMarket,
        uint256 _collateralAmountSeed,
        IVToken _borrowedMarket,
        uint256 _borrowedAmountToFlashLoan,
        uint256 _minAmountOutAfterSwap,
        bytes calldata _swapData
    ) external {
        if (_borrowedAmountToFlashLoan == 0) revert ZeroFlashLoanAmount();
        if (_collateralMarket == _borrowedMarket) revert IdenticalMarkets();
        _checkMarketSupported(_collateralMarket);
        _checkMarketSupported(_borrowedMarket);

        _checkUserDelegated();

        _validateAndEnterMarket(msg.sender, _collateralMarket);
        _ensureAccountLiquidityValid(msg.sender);

        _transferSeedAmountFromUser(_collateralMarket, msg.sender, _collateralAmountSeed);
        
        operationInitiator = msg.sender;
        collateralMarket = _collateralMarket;
        collateralAmount = _collateralAmountSeed;
        minAmountOutAfterSwap = _minAmountOutAfterSwap;
        operationType = OperationType.ENTER_COLLATERAL;

        IVToken[] memory borrowedMarkets = new IVToken[](1);
        borrowedMarkets[0] = _borrowedMarket;
        uint256[] memory flashLoanAmounts = new uint256[](1);
        flashLoanAmounts[0] = _borrowedAmountToFlashLoan;

        COMPTROLLER.executeFlashLoan(
            payable(msg.sender),
            payable(address(this)),
            borrowedMarkets,
            flashLoanAmounts,
            _swapData
        );

        _ensureNotLiquidatable(msg.sender);

        emit LeverageEntered(
            msg.sender,
            _collateralMarket,
            _collateralAmountSeed,
            _borrowedMarket,
            _borrowedAmountToFlashLoan
        );

        _transferDustToInitiator(_collateralMarket);
        _transferDustToInitiator(_borrowedMarket);
    }

    /// @inheritdoc ILeverageStrategiesManager
    function enterLeverageFromBorrow(
        IVToken _collateralMarket,
        IVToken _borrowedMarket,
        uint256 _borrowedAmountSeed,
        uint256 _borrowedAmountToFlashLoan,
        uint256 _minAmountOutAfterSwap,
        bytes calldata _swapData
    ) external {
        if (_borrowedAmountToFlashLoan == 0) revert ZeroFlashLoanAmount();
        if (_collateralMarket == _borrowedMarket) revert IdenticalMarkets();
        _checkMarketSupported(_collateralMarket);
        _checkMarketSupported(_borrowedMarket);
        
        _checkUserDelegated();
        
        _validateAndEnterMarket(msg.sender, _collateralMarket);
        _ensureAccountLiquidityValid(msg.sender);

        _transferSeedAmountFromUser(_borrowedMarket, msg.sender, _borrowedAmountSeed);

        operationInitiator = msg.sender;
        collateralMarket = _collateralMarket;
        borrowedAmountSeed = _borrowedAmountSeed;
        minAmountOutAfterSwap = _minAmountOutAfterSwap;
        operationType = OperationType.ENTER_BORROW;

        IVToken[] memory borrowedMarkets = new IVToken[](1);
        borrowedMarkets[0] = _borrowedMarket;
        uint256[] memory flashLoanAmounts = new uint256[](1);
        flashLoanAmounts[0] = _borrowedAmountToFlashLoan;

        COMPTROLLER.executeFlashLoan(
            payable(msg.sender),
            payable(address(this)),
            borrowedMarkets,
            flashLoanAmounts,
            _swapData
        );

        _ensureNotLiquidatable(msg.sender);

        emit LeverageEnteredFromBorrow(
            msg.sender,
            _collateralMarket,
            _borrowedMarket,
            _borrowedAmountSeed,
            _borrowedAmountToFlashLoan
        );

        _transferDustToInitiator(_collateralMarket);
        _transferDustToInitiator(_borrowedMarket);
    }

    /// @inheritdoc ILeverageStrategiesManager
    function exitLeverage(
        IVToken _collateralMarket,
        uint256 _collateralAmountToRedeemForSwap,
        IVToken _borrowedMarket,
        uint256 _borrowedAmountToFlashLoan,
        uint256 _minAmountOutAfterSwap,
        bytes calldata _swapData 
    ) external {
        if (_borrowedAmountToFlashLoan == 0) revert ZeroFlashLoanAmount();
        if (_collateralMarket == _borrowedMarket) revert IdenticalMarkets();
        _checkMarketSupported(_collateralMarket);
        _checkMarketSupported(_borrowedMarket);

        _checkUserDelegated();

        operationInitiator = msg.sender;
        collateralMarket = _collateralMarket;
        collateralAmount = _collateralAmountToRedeemForSwap;
        minAmountOutAfterSwap = _minAmountOutAfterSwap;
        operationType = OperationType.EXIT_COLLATERAL;

        IVToken[] memory borrowedMarkets = new IVToken[](1);
        borrowedMarkets[0] = _borrowedMarket;
        uint256[] memory flashLoanAmounts = new uint256[](1);
        flashLoanAmounts[0] = _borrowedAmountToFlashLoan;

        COMPTROLLER.executeFlashLoan(
            payable(msg.sender),
            payable(address(this)),
            borrowedMarkets,
            flashLoanAmounts,
            _swapData
        );

        _ensureNotLiquidatable(msg.sender);

        emit LeverageExited(
            msg.sender,
            _collateralMarket,
            _collateralAmountToRedeemForSwap,
            _borrowedMarket,
            _borrowedAmountToFlashLoan
        );

        _transferDustToInitiator(_collateralMarket);
        _transferDustToInitiator(_borrowedMarket);
    }

    /// @inheritdoc ILeverageStrategiesManager
    function exitSingleAssetLeverage(
        IVToken _collateralMarket,
        uint256 _collateralAmountToFlashLoan
    ) external {
        if (_collateralAmountToFlashLoan == 0) revert ZeroFlashLoanAmount();
        _checkMarketSupported(_collateralMarket);
        _checkUserDelegated();

        operationInitiator = msg.sender;
        collateralMarket = _collateralMarket;
        operationType = OperationType.EXIT_SINGLE_ASSET;

        IVToken[] memory borrowedMarkets = new IVToken[](1);
        borrowedMarkets[0] = _collateralMarket;
        uint256[] memory flashLoanAmounts = new uint256[](1);
        flashLoanAmounts[0] = _collateralAmountToFlashLoan;

        COMPTROLLER.executeFlashLoan(
            payable(msg.sender),
            payable(address(this)),
            borrowedMarkets,
            flashLoanAmounts,
            ""
        );

        _ensureNotLiquidatable(msg.sender);

        emit SingleAssetLeverageExited(
            msg.sender,
            _collateralMarket,
            _collateralAmountToFlashLoan
        );

        _transferDustToInitiator(_collateralMarket);
    }

    /**
     * @notice Flash loan callback entrypoint called by Comptroller
     * @dev Protected by nonReentrant modifier to prevent reentrancy attacks during flash loan execution
     * @param vTokens Array with the borrowed vToken market (single element)
     * @param amounts Array with the borrowed underlying amount (single element)
     * @param premiums Array with the flash loan fee amount (single element)
     * @param initiator The address that initiated the flash loan (must be this contract)
     * @param onBehalf The user for whom debt will be opened
     * @param param Encoded auxiliary data for the operation (e.g., swap multicall)
     * @return success Whether the execution succeeded
     * @return repayAmounts Amounts to approve for flash loan repayment
     * @custom:error InitiatorMismatch When initiator is not this contract
     * @custom:error OnBehalfMismatch When onBehalf is not the operation initiator
     * @custom:error UnauthorizedExecutor When caller is not the Comptroller
     * @custom:error FlashLoanAssetOrAmountMismatch When array lengths mismatch or > 1 element
     * @custom:error InvalidExecuteOperation When operation type is unknown
     */
    function executeOperation(
        IVToken[] calldata vTokens,
        uint256[] calldata amounts,
        uint256[] calldata premiums,
        address initiator,
        address onBehalf,
        bytes calldata param
    ) external override nonReentrant returns (bool success, uint256[] memory repayAmounts) {
        // Only the Comptroller can invoke this callback during flash loan execution
        if (msg.sender != address(COMPTROLLER)) {
            revert UnauthorizedExecutor();
        }

        // Flash loan must be initiated by this contract to prevent unauthorized callbacks
        if (initiator != address(this)) {
            revert InitiatorMismatch();
        }

        // The flash loan beneficiary must match the user who called the entry function
        if (onBehalf != operationInitiator) {
            revert OnBehalfMismatch();
        }

        // This contract only supports single-market flash loans
        if (vTokens.length != 1 || amounts.length != 1 || premiums.length != 1) {
            revert FlashLoanAssetOrAmountMismatch(); 
        }

        repayAmounts = new uint256[](1);
        if(operationType == OperationType.ENTER_SINGLE_ASSET) {
            repayAmounts[0] = _handleEnterSingleAsset(onBehalf, vTokens[0], amounts[0], premiums[0]);
        } else if(operationType == OperationType.ENTER_COLLATERAL) {
            repayAmounts[0] = _handleEnterCollateral(onBehalf, vTokens[0], amounts[0], premiums[0], param);
        } else if(operationType == OperationType.ENTER_BORROW) {
            repayAmounts[0] = _handleEnterBorrow(onBehalf, vTokens[0], amounts[0], premiums[0], param);
        } else if(operationType == OperationType.EXIT_COLLATERAL) {
            repayAmounts[0] = _handleExitCollateral(onBehalf,vTokens[0], amounts[0], premiums[0], param);
        } else if(operationType == OperationType.EXIT_SINGLE_ASSET) {
            repayAmounts[0] = _handleExitSingleAsset(onBehalf, vTokens[0], amounts[0], premiums[0]);
        } else {
            revert InvalidExecuteOperation();
        }

        return (true, repayAmounts);
    }

    /**
     * @notice Executes the enter leveraged position with single collateral operation during flash loan callback
     * @dev This function performs the following steps:
     *      1. Combines flash loaned collateral with user's seed collateral
     *      2. Supplies all collateral to the Venus market on behalf of the user
     *      3. Borrows the repayment amount (fees) on behalf of the user
     *      4. Approves the collateral asset for repayment to the flash loan
     * @param onBehalf Address on whose behalf the operation is performed
     * @param market The vToken market for the collateral asset
     * @param flashloanedCollateralAmount The amount of collateral assets received from flash loan
     * @param collateralAmountFees The fees to be paid on the flash loaned collateral amount
     * @return flashLoanRepayAmount The total amount of collateral assets to repay (fees only)
     * @custom:error MintBehalfFailed if mint behalf operation fails
     * @custom:error BorrowBehalfFailed if borrow behalf operation fails
     * @custom:error InsufficientFundsToRepayFlashloan if insufficient funds are available to repay the flash loan
     */
    function _handleEnterSingleAsset(address onBehalf, IVToken market, uint256 flashloanedCollateralAmount, uint256 collateralAmountFees) internal returns (uint256 flashLoanRepayAmount) {
        IERC20Upgradeable collateralAsset = IERC20Upgradeable(market.underlying());

        uint256 totalCollateralAmountToMint = flashloanedCollateralAmount + collateralAmount;
        collateralAsset.forceApprove(address(market), totalCollateralAmountToMint);

        uint256 err = market.mintBehalf(onBehalf, totalCollateralAmountToMint);
        if (err != SUCCESS) {
            revert MintBehalfFailed(err);
        }

        flashLoanRepayAmount = _borrowAndRepayFlashLoanFee(onBehalf, market, collateralAsset, collateralAmountFees);
    }

    /**
     * @notice Executes the enter leveraged position operation during flash loan callback
     * @dev This function performs the following steps:
     *      1. Swaps flash loaned borrowed assets for collateral assets
     *      2. Supplies all collateral received from swap plus seed to the Venus market on behalf of the user
     *      3. Borrows the repayment amount on behalf of the user
     *      4. Approves the borrowed asset for repayment to the flash loan
     * @param onBehalf Address on whose behalf the operation is performed
     * @param borrowMarket The vToken market from which assets were borrowed
     * @param borrowedAssetAmount The amount of borrowed assets received from flash loan
     * @param borrowedAssetFees The fees to be paid on the borrowed asset amount
     * @param swapCallData The encoded swap instructions for converting borrowed to collateral assets
     * @return flashLoanRepayAmount The total amount of borrowed assets to repay (fees only)
     * @custom:error MintBehalfFailed if mint behalf operation fails
     * @custom:error BorrowBehalfFailed if borrow behalf operation fails
     * @custom:error TokenSwapCallFailed if token swap execution fails
     * @custom:error SlippageExceeded if collateral balance after swap is below minimum
     */
    function _handleEnterCollateral(address onBehalf, IVToken borrowMarket, uint256 borrowedAssetAmount, uint256 borrowedAssetFees, bytes calldata swapCallData) internal returns (uint256 flashLoanRepayAmount) {
        IERC20Upgradeable borrowedAsset = IERC20Upgradeable(borrowMarket.underlying());

        // Cache transient storage reads for variables used more than once to save gas 
        IVToken _collateralMarket = collateralMarket;
        uint256 _minAmountOutAfterSwap = minAmountOutAfterSwap;

        IERC20Upgradeable collateralAsset = IERC20Upgradeable(_collateralMarket.underlying());
        uint256 swappedCollateralAmountOut = _performSwap(borrowedAsset, borrowedAssetAmount, collateralAsset, _minAmountOutAfterSwap, swapCallData);

        uint256 collateralAmountToMint = swappedCollateralAmountOut + collateralAmount;
        collateralAsset.forceApprove(address(_collateralMarket), collateralAmountToMint);

        uint256 err = _collateralMarket.mintBehalf(onBehalf, collateralAmountToMint);
        if (err != SUCCESS) {
            revert MintBehalfFailed(err);
        }

        flashLoanRepayAmount = _borrowAndRepayFlashLoanFee(onBehalf, borrowMarket, borrowedAsset, borrowedAssetFees);
    }

    /**
     * @notice Executes the enter leveraged position with borrowed assets operation during flash loan callback
     * @dev This function performs the following steps:
     *      1. Swaps the total borrowed assets (seed + flash loan) for collateral assets
     *      2. Supplies all collateral received from swap to the Venus market on behalf of the user
     *      3. Borrows the repayment amount on behalf of the user
     *      4. Approves the borrowed asset for repayment to the flash loan
     * @param onBehalf Address on whose behalf the operation is performed
     * @param borrowMarket The vToken market from which assets were borrowed
     * @param borrowedAssetAmount The amount of borrowed assets received from flash loan
     * @param borrowedAssetFees The fees to be paid on the borrowed asset amount
     * @param swapCallData The encoded swap instructions for converting borrowed to collateral assets
     * @return flashLoanRepayAmount The total amount of borrowed assets to repay (fees only)
     * @custom:error MintBehalfFailed if mint behalf operation fails
     * @custom:error BorrowBehalfFailed if borrow behalf operation fails
     * @custom:error TokenSwapCallFailed if token swap execution fails
     * @custom:error SlippageExceeded if collateral balance after swap is below minimum
     */
    function _handleEnterBorrow(address onBehalf, IVToken borrowMarket, uint256 borrowedAssetAmount, uint256 borrowedAssetFees, bytes calldata swapCallData) internal returns (uint256 flashLoanRepayAmount) {
        IERC20Upgradeable borrowedAsset = IERC20Upgradeable(borrowMarket.underlying());

        // Cache transient storage reads for variables used more than once to save gas 
        IVToken _collateralMarket = collateralMarket;
        uint256 _minAmountOutAfterSwap = minAmountOutAfterSwap;

        IERC20Upgradeable collateralAsset = IERC20Upgradeable(_collateralMarket.underlying());

        uint256 totalBorrowedAmountToSwap = borrowedAmountSeed + borrowedAssetAmount;

        uint256 swappedCollateralAmountOut = _performSwap(borrowedAsset, totalBorrowedAmountToSwap, collateralAsset, _minAmountOutAfterSwap, swapCallData);

        collateralAsset.forceApprove(address(_collateralMarket), swappedCollateralAmountOut);

        uint256 err = _collateralMarket.mintBehalf(onBehalf, swappedCollateralAmountOut);
        if (err != SUCCESS) {
            revert MintBehalfFailed(err);
        }

        flashLoanRepayAmount = _borrowAndRepayFlashLoanFee(onBehalf, borrowMarket, borrowedAsset, borrowedAssetFees);
    }

    /**
     * @notice Executes the exit leveraged position operation during flash loan callback
     * @dev This function performs the following steps:
     *      1. Queries actual debt and caps repayment to min(flashLoanAmount, actualDebt)
     *         to handle cases where UI flash loans slightly more than current debt
     *      2. Repays user's debt (up to actual debt amount) in the borrowed market
     *      3. Calculates redeem amount accounting for treasury fee (if any)
     *      4. Redeems specified amount of collateral from the Venus market
     *      5. Swaps actual received collateral (after treasury fee) for borrowed assets
     *      6. Uses swap output plus any leftover flash loan funds to repay flash loan
     * @param onBehalf Address on whose behalf the operation is performed
     * @param borrowMarket The vToken market from which assets were borrowed via flash loan
     * @param borrowedAssetAmountToRepayFromFlashLoan The amount borrowed via flash loan for debt repayment
     * @param borrowedAssetFees The fees to be paid on the borrowed asset amount
     * @param swapCallData The encoded swap instructions for converting collateral to borrowed assets
     * @return flashLoanRepayAmount The total amount of borrowed assets to repay
     * @custom:error RepayBehalfFailed if repayment of borrowed assets fails
     * @custom:error RedeemBehalfFailed if redeem operations fail
     * @custom:error TokenSwapCallFailed if token swap execution fails
     * @custom:error SlippageExceeded if swap output is below minimum required
     * @custom:error InsufficientFundsToRepayFlashloan if insufficient funds are available to repay the flash loan
     */
    function _handleExitCollateral(address onBehalf, IVToken borrowMarket, uint256 borrowedAssetAmountToRepayFromFlashLoan, uint256 borrowedAssetFees, bytes calldata swapCallData) internal returns (uint256 flashLoanRepayAmount) {
        IERC20Upgradeable borrowedAsset = IERC20Upgradeable(borrowMarket.underlying());

        {
            uint256 borrowedTotalDebtAmount = borrowMarket.borrowBalanceCurrent(onBehalf);
            uint256 repayAmount = borrowedAssetAmountToRepayFromFlashLoan > borrowedTotalDebtAmount ? borrowedTotalDebtAmount : borrowedAssetAmountToRepayFromFlashLoan;

            borrowedAsset.forceApprove(address(borrowMarket), repayAmount);
            uint256 err = borrowMarket.repayBorrowBehalf(onBehalf, repayAmount);

            if (err != SUCCESS) {
                revert RepayBehalfFailed(err);
            }
        }

        // Cache transient storage reads for variables used more than once to save gas 
        IVToken _collateralMarket = collateralMarket;
        uint256 collateralAmountToRedeem = collateralAmount;

        {
            uint256 treasuryPercent = COMPTROLLER.treasuryPercent();
            uint256 redeemAmount = treasuryPercent > 0 
                ? (collateralAmountToRedeem * MANTISSA_ONE + (MANTISSA_ONE - treasuryPercent) - 1) / (MANTISSA_ONE - treasuryPercent)
                : collateralAmountToRedeem;

            uint256 err = _collateralMarket.redeemUnderlyingBehalf(onBehalf, redeemAmount);
            if (err != SUCCESS) {
                revert RedeemBehalfFailed(err);
            }
        }
        
        IERC20Upgradeable collateralAsset = IERC20Upgradeable(_collateralMarket.underlying());

        uint256 swappedBorrowedAmountOut = _performSwap(collateralAsset, collateralAsset.balanceOf(address(this)), borrowedAsset, minAmountOutAfterSwap, swapCallData);

        flashLoanRepayAmount = borrowedAssetAmountToRepayFromFlashLoan + borrowedAssetFees;

        if (swappedBorrowedAmountOut < flashLoanRepayAmount) {
            revert InsufficientFundsToRepayFlashloan();
        }

       borrowedAsset.forceApprove(address(borrowMarket), flashLoanRepayAmount);
    }

    /**
     * @notice Executes the exit leveraged position with single collateral operation during flash loan callback
     * @dev This function performs the following steps:
     *      1. Queries actual debt and caps repayment to min(flashLoanAmount, actualDebt)
     *         to handle cases where UI flash loans slightly more than current debt
     *      2. Repays user's debt (up to actual debt amount) in the market
     *      3. Calculates redeem amount accounting for treasury fee (if any)
     *      4. Redeems collateral needed to repay flash loan (flashLoanAmount + fees)
     *      5. Approves the collateral asset for repayment to the flash loan
     * @param onBehalf Address on whose behalf the operation is performed
     * @param market The vToken market for both collateral and borrowed assets
     * @param flashloanedCollateralAmount The amount borrowed via flash loan for debt repayment
     * @param collateralAmountFees The fees to be paid on the flash loaned collateral amount
     * @return flashLoanRepayAmount The total amount of collateral assets to repay
     * @custom:error RepayBehalfFailed if repayment of borrowed assets fails
     * @custom:error RedeemBehalfFailed if redeem operations fail
     * @custom:error InsufficientFundsToRepayFlashloan if insufficient funds are available to repay the flash loan
     */
    function _handleExitSingleAsset(address onBehalf, IVToken market, uint256 flashloanedCollateralAmount, uint256 collateralAmountFees) internal returns (uint256 flashLoanRepayAmount) {
        IERC20Upgradeable collateralAsset = IERC20Upgradeable(market.underlying());

        uint256 marketTotalDebtAmount = market.borrowBalanceCurrent(onBehalf);
        uint256 repayAmount = flashloanedCollateralAmount > marketTotalDebtAmount ? marketTotalDebtAmount : flashloanedCollateralAmount;

        collateralAsset.forceApprove(address(market), repayAmount);
        uint256 err = market.repayBorrowBehalf(onBehalf, repayAmount);

        if (err != SUCCESS) {
            revert RepayBehalfFailed(err);
        }

        flashLoanRepayAmount = flashloanedCollateralAmount + collateralAmountFees;

        uint256 treasuryPercent = COMPTROLLER.treasuryPercent();
        uint256 redeemAmount = treasuryPercent > 0 
            ? (flashLoanRepayAmount * MANTISSA_ONE + (MANTISSA_ONE - treasuryPercent) - 1) / (MANTISSA_ONE - treasuryPercent)
            : flashLoanRepayAmount;

        err = market.redeemUnderlyingBehalf(onBehalf, redeemAmount);
        if (err != SUCCESS) {
            revert RedeemBehalfFailed(err);
        }

        if (collateralAsset.balanceOf(address(this)) < flashLoanRepayAmount) {
            revert InsufficientFundsToRepayFlashloan();
        }

        collateralAsset.forceApprove(address(market), flashLoanRepayAmount);
    }

    /**
     * @notice Performs token swap via the SwapHelper contract
     * @dev Transfers tokens to SwapHelper and executes the swap operation.
     *      The swap operation is expected to return the output tokens to this contract.
     * @param tokenIn The input token to be swapped
     * @param amountIn The amount of input tokens to swap
     * @param tokenOut The output token to receive from the swap
     * @param minAmountOut The minimum acceptable amount of output tokens
     * @param param The encoded swap instructions/calldata for the SwapHelper
     * @return amountOut The actual amount of output tokens received from the swap
     * @custom:error TokenSwapCallFailed if the swap execution fails
     * @custom:error SlippageExceeded if the swap output is below the minimum required
     */
    function _performSwap(IERC20Upgradeable tokenIn, uint256 amountIn, IERC20Upgradeable tokenOut, uint256 minAmountOut, bytes calldata param) internal returns (uint256 amountOut) {
        tokenIn.safeTransfer(address(swapHelper), amountIn);

        uint256 tokenOutBalanceBefore = tokenOut.balanceOf(address(this));

        (bool success,) = address(swapHelper).call(param);
        if(!success) {
            revert TokenSwapCallFailed();
        }

        uint256 tokenOutBalanceAfter = tokenOut.balanceOf(address(this));

        amountOut = tokenOutBalanceAfter - tokenOutBalanceBefore;
        if(amountOut < minAmountOut) {
            revert SlippageExceeded();
        }

        return amountOut;
    }

    /**
     * @notice Transfers tokens from the user to this contract if amount > 0
     * @dev If the specified amount is greater than zero, transfers tokens from the user.
     *      Reverts if the actual transferred amount does not match the expected amount.
     * @param market The vToken market whose underlying asset is to be transferred
     * @param user The address of the user to transfer tokens from
     * @param amount The amount of tokens to transfer
     * @custom:error TransferFromUserFailed if the transferred amount does not match the expected amount
     */
    function _transferSeedAmountFromUser(IVToken market, address user, uint256 amount) internal {
        if(amount > 0) {
            IERC20Upgradeable token = IERC20Upgradeable(market.underlying());
            token.safeTransferFrom(user, address(this), amount);
        }
    }

    /**
     * @notice Transfers any remaining dust amounts back to the operation initiator
     * @dev This function returns small remaining balances to the user who initiated the operation.
     *      Should be called after leverage operations to ensure no funds are left in the contract.
     * @param market The vToken market whose underlying asset dust should be transferred
     */
    function _transferDustToInitiator(IVToken market) internal {
        IERC20Upgradeable asset = IERC20Upgradeable(market.underlying());

        uint256 dustAmount = asset.balanceOf(address(this));
        if(dustAmount > 0) {
            // Cache transient storage read to save gas
            address _operationInitiator = operationInitiator;
            asset.safeTransfer(_operationInitiator, dustAmount);
            emit DustTransferred(_operationInitiator, address(asset), dustAmount);
        }
    }

    /**
     * @notice Borrows assets on behalf of the user to repay the flash loan fee
     * @dev Borrows the total amount needed to repay the flash loan fee
     *      and approves the borrowed asset for repayment to the flash loan.
     * @param onBehalf Address on whose behalf assets will be borrowed
     * @param borrowMarket The vToken market from which assets will be borrowed
     * @param borrowedAsset The underlying asset being borrowed
     * @param borrowedAssetFees The fees to be paid on the borrowed asset amount
     * @return flashLoanRepayAmount The total amount of borrowed assets to repay (only fees)
     * @custom:error BorrowBehalfFailed if borrow behalf operation fails
     * @custom:error InsufficientFundsToRepayFlashloan if insufficient funds are available to repay the flash loan
     */
    function _borrowAndRepayFlashLoanFee(address onBehalf, IVToken borrowMarket, IERC20Upgradeable borrowedAsset, uint256 borrowedAssetFees) internal returns (uint256 flashLoanRepayAmount) {
        flashLoanRepayAmount = borrowedAssetFees;

        uint256 marketBalanceBeforeBorrow = borrowedAsset.balanceOf(address(borrowMarket));
        uint256 err = borrowMarket.borrowBehalf(onBehalf, flashLoanRepayAmount);
        if (err != SUCCESS) {
            revert BorrowBehalfFailed(err);
        }
        uint256 marketBalanceAfterBorrow = borrowedAsset.balanceOf(address(borrowMarket));

        if (marketBalanceBeforeBorrow - marketBalanceAfterBorrow < flashLoanRepayAmount) {
            revert InsufficientFundsToRepayFlashloan();
        }

        borrowedAsset.forceApprove(address(borrowMarket), flashLoanRepayAmount);
    }

    /**
     * @notice Checks if the caller has delegated this contract in the Comptroller
     * @custom:error NotAnApprovedDelegate if caller has not approved this contract as delegate
     */
    function _checkUserDelegated() internal view {
        if (!COMPTROLLER.approvedDelegates(msg.sender, address(this))) {
            revert NotAnApprovedDelegate();
        }
    }

    /**
     * @notice Ensures account liquidity is valid by accruing interest and checking for shortfall
     * @dev This function performs two critical steps before leverage operations:
     *      1. Accrues interest on ALL markets the user has entered to ensure accurate borrow balances
     *      2. Verifies the account has no liquidity shortfall (safe from liquidation)
     *      The getBorrowingPower check uses getAccountSnapshot which returns stored (not current)
     *      borrow balances, so interest must be accrued first for accurate liquidity calculation.
     * @param user The address of the user to validate
     * @custom:error AccrueInterestFailed if accrueInterest fails on any market
     * @custom:error OperationCausesLiquidation if the account has a liquidity shortfall
     */
    function _ensureAccountLiquidityValid(address user) internal {
        IVToken[] memory userAssets = COMPTROLLER.getAssetsIn(user);
        uint256 length = userAssets.length;
        for (uint256 i; i < length; ) {
            uint256 accrueErr = userAssets[i].accrueInterest();
            if (accrueErr != SUCCESS) revert AccrueInterestFailed(accrueErr);
            unchecked {
                ++i;
            }
        }

        _ensureNotLiquidatable(user);
    }

    /**
     * @notice Reverts if user account has liquidity shortfall (is liquidatable) 
     * @dev Verifies that the user's account has no liquidity shortfall and the comptroller
     *      returned no errors when calculating account liquidity. This ensures the account
     *      won't be immediately liquidatable after the leverage operation.
     * @param user The address to check account safety for
     * @custom:error OperationCausesLiquidation if the account has a liquidity shortfall or comptroller error
     */
    function _ensureNotLiquidatable(address user) internal view {
        (uint256 err, , uint256 shortfall) = COMPTROLLER.getBorrowingPower(user);
        if (err != SUCCESS || shortfall > 0) revert OperationCausesLiquidation(err);
    }

    /**
     * @notice Ensures the user has entered the market before operations
     * @dev If user is not a member of market the function calls Comptroller to enter market on behalf of user
     * @param user The account for which membership is validated/updated
     * @param market The vToken market the user must enter 
     * @custom:error EnterMarketFailed when Comptroller.enterMarketBehalf returns a non-zero error code
     */
    function _validateAndEnterMarket(address user, IVToken market) internal {
        if (!COMPTROLLER.checkMembership(user, market)) {
            uint256 err = COMPTROLLER.enterMarketBehalf(user, address(market));
            if (err != SUCCESS) revert EnterMarketFailed(err);
        }
    }

    /**
     * @dev Ensures that the given market is supported for leverage operations
     * @dev A market must be listed in the Comptroller and must not be vBNB.
     *      vBNB is excluded because it uses native BNB which requires special handling
     *      that this contract does not support.
     * @param market The vToken address to validate
     * @custom:error MarketNotListed if the market is not listed in Comptroller
     * @custom:error VBNBNotSupported if the market is vBNB
     */
    function _checkMarketSupported(IVToken market) internal view {
        (bool isMarketListed, , ) = COMPTROLLER.markets(address(market));
        if (!isMarketListed) revert MarketNotListed(address(market));
        if (market == vBNB) revert VBNBNotSupported();
    }
}
