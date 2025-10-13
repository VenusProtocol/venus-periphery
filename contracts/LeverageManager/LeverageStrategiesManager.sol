// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

import { Ownable2StepUpgradeable } from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import { SafeERC20Upgradeable, IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";

import { IVToken, IComptroller, IFlashLoanReceiver, IProtocolShareReserve } from "../Interfaces.sol";
import { SwapHelper } from "../SwapHelper/SwapHelper.sol";

import { ILeverageStrategiesManager } from "./ILeverageStrategiesManager.sol";

/**
 * @title LeverageStrategiesManager
 * @author Venus Protocol
 * @notice Contract for managing leveraged positions using flash loans and token swaps
 */
contract LeverageStrategiesManager is Ownable2StepUpgradeable, ReentrancyGuardUpgradeable, IFlashLoanReceiver, ILeverageStrategiesManager {
    using SafeERC20Upgradeable for IERC20Upgradeable;

    /// @notice The Venus comptroller contract for market interactions and flash loans
    IComptroller public immutable COMPTROLLER;
    
    /// @notice The protocol share reserve where dust amounts are transferred
    IProtocolShareReserve public immutable protocolShareReserve;
    
    /// @notice The swap helper contract for executing token swaps
    SwapHelper public immutable swapHelper;

    /**
     * @notice Enumeration of operation types for flash loan callbacks
     * @param ENTER_WITH_COLLATERAL Operation for entering a leveraged position with collateral seed
     * @param ENTER_WITH_BORROWED Operation for entering a leveraged position with borrowed asset seed
     * @param EXIT Operation for exiting a leveraged position
     */
    enum OperationType {
        ENTER_WITH_COLLATERAL,
        ENTER_WITH_BORROWED,
        EXIT
    }

    /// @dev Transient variable to track the current operation type during flash loan execution
    OperationType transient operationType;
    
    /// @dev Transient variable to store the collateral market during flash loan execution
    IVToken transient transientCollateralMarket;
    
    /// @dev Transient variable to store the collateral amount during flash loan execution
    uint256 transient transientCollateralAmount;
    
    /// @dev Transient variable to store the borrowed amount seed during flash loan execution
    uint256 transient transientBorrowedAmountSeed;
    
    /// @dev Transient variable to store the minimum amountOut expected after swap
    uint256 transient transientMinAmountOutAfterSwap;

    /**
     * @notice Contract constructor
     * @dev Sets immutable variables and disables initializers for the implementation contract
     * @param _comptroller The Venus comptroller contract address
     * @param _protocolShareReserve The protocol share reserve contract address
     * @param _swapHelper The swap helper contract address
     * @custom:oz-upgrades-unsafe-allow constructor
     */
    constructor(IComptroller _comptroller,  IProtocolShareReserve _protocolShareReserve, SwapHelper _swapHelper) {
        COMPTROLLER = _comptroller;
        protocolShareReserve = _protocolShareReserve;
        swapHelper = _swapHelper;
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
    function enterLeveragedPositionWithCollateral(
        IVToken collateralMarket,
        uint256 collateralAmountSeed,
        IVToken borrowedMarket,
        uint256 borrowedAmountToFlashLoan,
        uint256 minAmountOutAfterSwap,
        bytes[] calldata swapData
    ) external {
        _checkIfUserDelegated(msg.sender);
        _checkAccountSafe(msg.sender);
        
        transientCollateralMarket = collateralMarket;
        transientCollateralAmount = collateralAmountSeed;
        transientMinAmountOutAfterSwap = minAmountOutAfterSwap;
        operationType = OperationType.ENTER_WITH_COLLATERAL;

        bytes memory swapCallData = abi.encodeWithSelector(swapHelper.multicall.selector, swapData);

        IVToken[] memory borrowedMarkets = new IVToken[](1);
        borrowedMarkets[0] = borrowedMarket;
        uint256[] memory flashLoanAmounts = new uint256[](1);
        flashLoanAmounts[0] = borrowedAmountToFlashLoan;

        COMPTROLLER.executeFlashLoan(
            payable(msg.sender),
            payable(address(this)),
            borrowedMarkets,
            flashLoanAmounts,
            swapCallData
        );

        emit LeveragedPositionEnteredWithCollateral(
            msg.sender,
            collateralMarket,
            collateralAmountSeed,
            borrowedMarket,
            borrowedAmountToFlashLoan
        );

        _checkAccountSafe(msg.sender);
    }

    /// @inheritdoc ILeverageStrategiesManager
    function enterLeveragedPositionWithBorrowed(
        IVToken collateralMarket,
        IVToken borrowedMarket,
        uint256 borrowedAmountSeed,
        uint256 borrowedAmountToFlashLoan,
        uint256 minAmountOutAfterSwap,
        bytes[] calldata swapData
    ) external {
        _checkIfUserDelegated(msg.sender);
        _checkAccountSafe(msg.sender);
        
        transientCollateralMarket = collateralMarket;
        transientBorrowedAmountSeed = borrowedAmountSeed;
        transientMinAmountOutAfterSwap = minAmountOutAfterSwap;
        operationType = OperationType.ENTER_WITH_BORROWED;

        bytes memory swapCallData = abi.encodeWithSelector(swapHelper.multicall.selector, swapData);

        IVToken[] memory borrowedMarkets = new IVToken[](1);
        borrowedMarkets[0] = borrowedMarket;
        uint256[] memory flashLoanAmounts = new uint256[](1);
        flashLoanAmounts[0] = borrowedAmountToFlashLoan;

        COMPTROLLER.executeFlashLoan(
            payable(msg.sender),
            payable(address(this)),
            borrowedMarkets,
            flashLoanAmounts,
            swapCallData
        );

        emit LeveragedPositionEnteredWithBorrowed(
            msg.sender,
            collateralMarket,
            borrowedMarket,
            borrowedAmountSeed, // Use borrowed amount seed as the amount in the event
            borrowedAmountToFlashLoan
        );

        _checkAccountSafe(msg.sender);
    }

    /// @inheritdoc ILeverageStrategiesManager
    function exitLeveragedPosition(
        IVToken collateralMarket,
        uint256 collateralAmountToRedeemForSwap,
        IVToken borrowedMarket,
        uint256 borrowedAmountToFlashLoan,
        uint256 minAmountOutAfterSwap,
        bytes[] calldata swapData 
    ) external {
        _checkIfUserDelegated(msg.sender);

        transientCollateralMarket = collateralMarket;
        transientCollateralAmount = collateralAmountToRedeemForSwap;
        transientMinAmountOutAfterSwap = minAmountOutAfterSwap;
        operationType = OperationType.EXIT;

        bytes memory swapCallData = abi.encodeWithSelector(swapHelper.multicall.selector, swapData);

        IVToken[] memory borrowedMarkets = new IVToken[](1);
        borrowedMarkets[0] = borrowedMarket;
        uint256[] memory flashLoanAmounts = new uint256[](1);
        flashLoanAmounts[0] = borrowedAmountToFlashLoan;

        COMPTROLLER.executeFlashLoan(
            payable(msg.sender),
            payable(address(this)),
            borrowedMarkets,
            flashLoanAmounts,
            swapCallData
        );

        emit LeveragedPositionExited(
            msg.sender,
            collateralMarket,
            collateralAmountToRedeemForSwap,
            borrowedMarket,
            borrowedAmountToFlashLoan
        );

        _transferDustToTreasury(collateralMarket);
        _transferDustToTreasury(borrowedMarket);

        _checkAccountSafe(msg.sender);
    }

    /// @inheritdoc IFlashLoanReceiver
    function executeOperation(
        IVToken[] calldata vTokens,
        uint256[] calldata amounts,
        uint256[] calldata premiums,
        address initiator,
        address /* onBehalf */,
        bytes calldata param
    ) external override returns (bool success, uint256[] memory repayAmounts) {
        if (msg.sender != address(COMPTROLLER)) {
            revert ExecuteOperationNotCalledByAuthorizedContract();
        }

        if (vTokens.length != 1 || amounts.length != 1 || premiums.length != 1) {
            revert FlashLoanAssetOrAmountMismatch(); 
        }

        if(operationType == OperationType.ENTER_WITH_COLLATERAL) {
            uint256 amountToRepay = _executeEnterOperation(initiator, vTokens[0], amounts[0], premiums[0], param);

            repayAmounts = new uint256[](1);
            repayAmounts[0] = amountToRepay;
        } else if(operationType == OperationType.ENTER_WITH_BORROWED) {
            uint256 amountToRepay = _executeEnterWithBorrowedOperation(initiator, vTokens[0], amounts[0], premiums[0], param);

            repayAmounts = new uint256[](1);
            repayAmounts[0] = amountToRepay;
        } else if(operationType == OperationType.EXIT) {
           uint256 amountToRepay =  _executeExitOperation(initiator,vTokens[0], amounts[0], premiums[0], param);

            repayAmounts = new uint256[](1);
            repayAmounts[0] = amountToRepay;
        } else {
            return (false, new uint256[](0));
        }

        return (true, repayAmounts);
    }

    /**
     * @notice Executes the enter leveraged position operation during flash loan callback
     * @dev This function performs the following steps:
     *      1. Swaps borrowed assets for collateral assets
     *      2. Transfers user's seed collateral (if any) to this contract
     *      3. Supplies all collateral to the Venus market on behalf of the user
     *      4. Borrows the repayment amount on behalf of the user
     *      5. Approves the borrowed asset for repayment to the flash loan
     * @param initiator The user address that initiated the leveraged position
     * @param borrowMarket The vToken market from which assets were borrowed
     * @param borrowedAssetAmount The amount of borrowed assets received from flash loan
     * @param borrowedAssetFees The fees to be paid on the borrowed asset amount
     * @param swapCallData The encoded swap instructions for converting borrowed to collateral assets
     * @return borrowedAssetAmountToRepay The total amount of borrowed assets to repay (principal + fees)
     * @custom:error EnterLeveragePositionFailed if mint or borrow operations fail
     * @custom:error SwapCallFailed if token swap execution fails
     */
    function _executeEnterOperation(address initiator, IVToken borrowMarket, uint256 borrowedAssetAmount, uint256 borrowedAssetFees, bytes calldata swapCallData) internal returns (uint256 borrowedAssetAmountToRepay) {
        IERC20Upgradeable borrowedAsset = IERC20Upgradeable(borrowMarket.underlying());
        IERC20Upgradeable collateralAsset = IERC20Upgradeable(transientCollateralMarket.underlying());

        uint256 swappedCollateraAmountOut = _performSwap(borrowedAsset, borrowedAssetAmount, collateralAsset, transientMinAmountOutAfterSwap, swapCallData);

        if(transientCollateralAmount > 0) {
            collateralAsset.safeTransferFrom(initiator, address(this), transientCollateralAmount);
        }

        uint256 mintSuccess = transientCollateralMarket.mintBehalf(initiator, swappedCollateraAmountOut + transientCollateralAmount);
        if (mintSuccess != 0) {
            revert EnterLeveragePositionFailed();
        }

        borrowedAssetAmountToRepay = borrowedAssetAmount + borrowedAssetFees;

        uint256 borrowSuccess = borrowMarket.borrowBehalf(initiator, borrowedAssetAmountToRepay);
        if (borrowSuccess != 0) {
            revert EnterLeveragePositionFailed();
        }

        if (borrowedAsset.balanceOf(address(this)) < borrowedAssetAmountToRepay) {
            revert InsufficientFundsToRepayFlashloan();
        }

        borrowedAsset.safeApprove(address(borrowMarket), borrowedAssetAmountToRepay);
    }

    /**
     * @notice Executes the enter leveraged position with borrowed assets operation during flash loan callback
     * @dev This function performs the following steps:
     *      1. Transfers user's seed borrowed assets (if any) to this contract
     *      2. Swaps the total borrowed assets (seed + flash loan) for collateral assets
     *      3. Supplies all collateral to the Venus market on behalf of the user
     *      4. Borrows the repayment amount on behalf of the user
     *      5. Approves the borrowed asset for repayment to the flash loan
     * @param initiator The user address that initiated the leveraged position
     * @param borrowMarket The vToken market from which assets were borrowed
     * @param borrowedAssetAmount The amount of borrowed assets received from flash loan
     * @param borrowedAssetFees The fees to be paid on the borrowed asset amount
     * @param swapCallData The encoded swap instructions for converting borrowed to collateral assets
     * @return borrowedAssetAmountToRepay The total amount of borrowed assets to repay (principal + fees)
     * @custom:error EnterLeveragePositionFailed if mint or borrow operations fail
     * @custom:error SwapCallFailed if token swap execution fails
     * @custom:error InsufficientAmountOutAfterSwap if collateral balance after swap is below minimum
     */
    function _executeEnterWithBorrowedOperation(address initiator, IVToken borrowMarket, uint256 borrowedAssetAmount, uint256 borrowedAssetFees, bytes calldata swapCallData) internal returns (uint256 borrowedAssetAmountToRepay) {
        IERC20Upgradeable borrowedAsset = IERC20Upgradeable(borrowMarket.underlying());
        IERC20Upgradeable collateralAsset = IERC20Upgradeable(transientCollateralMarket.underlying());

        if(transientBorrowedAmountSeed > 0) {
            borrowedAsset.safeTransferFrom(initiator, address(this), transientBorrowedAmountSeed);
        }

        uint256 totalBorrowedAmountToSwap = transientBorrowedAmountSeed + borrowedAssetAmount;

        uint256 swappedCollateralAmountOut = _performSwap(borrowedAsset, totalBorrowedAmountToSwap, collateralAsset, transientMinAmountOutAfterSwap, swapCallData);

        uint256 mintSuccess = transientCollateralMarket.mintBehalf(initiator, swappedCollateralAmountOut);
        if (mintSuccess != 0) {
            revert EnterLeveragePositionFailed();
        }

        borrowedAssetAmountToRepay = borrowedAssetAmount + borrowedAssetFees;

        uint256 borrowSuccess = borrowMarket.borrowBehalf(initiator, borrowedAssetAmountToRepay);
        if (borrowSuccess != 0) {
            revert EnterLeveragePositionFailed();
        }

        if (borrowedAsset.balanceOf(address(this)) < borrowedAssetAmountToRepay) {
            revert InsufficientFundsToRepayFlashloan();
        }

        borrowedAsset.safeApprove(address(borrowMarket), borrowedAssetAmountToRepay);
    }

    /**
     * @notice Executes the exit leveraged position operation during flash loan callback
     * @dev This function performs the following steps:
     *      1. Uses borrowed assets to repay user's debt in the borrowed market
     *      2. Redeems specified amount of collateral from the Venus market
     *      3. Swaps collateral assets for borrowed assets
     *      4. Approves the borrowed asset for repayment to the flash loan
     * @param initiator The user address that initiated the position exit
     * @param borrowMarket The vToken market from which assets were borrowed via flash loan
     * @param borrowedAssetAmountToRepayFromFlashLoan The amount borrowed via flash loan for debt repayment
     * @param borrowedAssetFees The fees to be paid on the borrowed asset amount
     * @param swapCallData The encoded swap instructions for converting collateral to borrowed assets
     * @return borrowedAssetAmountToRepay The total amount of borrowed assets to repay (principal + fees)
     * @custom:error ExitLeveragePositionFailed if repay or redeem operations fail
     * @custom:error SwapCallFailed if token swap execution fails
     * @custom:error InsufficientFundsToRepayFlashloan if insufficient funds are available to repay the flash loan
     */
    function _executeExitOperation(address initiator, IVToken borrowMarket, uint256 borrowedAssetAmountToRepayFromFlashLoan, uint256 borrowedAssetFees, bytes calldata swapCallData) internal returns (uint256 borrowedAssetAmountToRepay) {
        IERC20Upgradeable borrowedAsset = IERC20Upgradeable(borrowMarket.underlying());

        borrowedAsset.safeApprove(address(borrowMarket), borrowedAssetAmountToRepayFromFlashLoan);
        uint256 repaySuccess = borrowMarket.repayBorrowBehalf(initiator, borrowedAssetAmountToRepayFromFlashLoan);

        if (repaySuccess != 0) {
            revert ExitLeveragePositionFailed();
        }

        uint256 minCollateralAmountInForSwap = transientCollateralAmount;

        uint256 redeemSuccess = transientCollateralMarket.redeemUnderlyingBehalf(initiator, minCollateralAmountInForSwap);
        if (redeemSuccess != 0) {
            revert ExitLeveragePositionFailed();
        }
        
        IERC20Upgradeable collateralAsset = IERC20Upgradeable(transientCollateralMarket.underlying());
        uint256 swappedBorrowedAmountOut = _performSwap(collateralAsset, minCollateralAmountInForSwap, borrowedAsset, transientMinAmountOutAfterSwap, swapCallData);

       borrowedAssetAmountToRepay = borrowedAssetAmountToRepayFromFlashLoan + borrowedAssetFees;

        if (swappedBorrowedAmountOut < borrowedAssetAmountToRepay) {
            revert InsufficientFundsToRepayFlashloan();
        }

       borrowedAsset.safeApprove(address(borrowMarket), borrowedAssetAmountToRepay);
    }

    /**
     * @notice Performs token swap via the SwapHelper contract
     * @dev Transfers tokens to SwapHelper and executes the swap operation.
     *      The swap operation is expected to return the output tokens to this contract.
     * @param tokenIn The input token to be swapped
     * @param amountIn The amount of input tokens to swap
     * @param param The encoded swap instructions/calldata for the SwapHelper
     * @custom:error SwapCallFailed if the swap execution fails
     */
    function _performSwap(IERC20Upgradeable tokenIn, uint256 amountIn, IERC20Upgradeable tokenOut, uint256 minAmountOut, bytes calldata param) internal nonReentrant returns (uint256 amountOut) {
        tokenIn.safeTransfer(address(swapHelper), amountIn);

        uint256 tokenOutBalanceBefore = tokenOut.balanceOf(address(this));

        (bool success,) = address(swapHelper).call(param);
        if(!success) {
            revert SwapCallFailed();
        }

        uint256 tokenOutBalanceAfter = tokenOut.balanceOf(address(this));

        amountOut = tokenOutBalanceAfter - tokenOutBalanceBefore;
        if(amountOut < minAmountOut) {
            revert InsufficientAmountOutAfterSwap();
        }

        return amountOut;
    }

    /**
     * @notice Transfers any remaining dust amounts to the protocol share reserve
     * @dev This function cleans up small remaining balances after operations and
     *      updates the protocol share reserve's asset state for proper accounting.
     * @param market The vToken market whose underlying asset dust should be transferred
     */
    function _transferDustToTreasury(IVToken market) internal {
        IERC20Upgradeable asset = IERC20Upgradeable(market.underlying());

        uint256 dustAmount = asset.balanceOf(address(this));
        if(dustAmount > 0) {
            asset.safeTransfer(address(protocolShareReserve), dustAmount);
            protocolShareReserve.updateAssetsState(address(COMPTROLLER), address(asset), IProtocolShareReserve.IncomeType.FLASHLOAN);
        }
    }
    /**
     * @notice Checks if a user has delegated permission to this contract
     * @dev Verifies that the user has approved this contract as a delegate via the comptroller.
     *      This is required for the contract to perform operations on behalf of the user.
     * @param user The address of the user to check delegation for
     * @custom:error Unauthorized if the user hasn't delegated permission to this contract
     */
    function _checkIfUserDelegated(address user) internal view {
        if (!COMPTROLLER.approvedDelegates(user, address(this))) {
            revert Unauthorized();
        }
    }

    /**
     * @notice Checks if a user's account remains safe after leverage operations
     * @dev Verifies that the user's account has no liquidity shortfall and the comptroller
     *      returned no errors when calculating account liquidity. This ensures the account
     *      won't be immediately liquidatable after the leverage operation.
     * @param user The address to check account safety for
     * @custom:error LeverageCausesLiquidation if the account has a liquidity shortfall or comptroller error
     */
    function _checkAccountSafe(address user) internal view {
        (uint256 err, , uint256 shortfall) = COMPTROLLER.getAccountLiquidity(user);
        if (err != 0 || shortfall > 0) revert LeverageCausesLiquidation();
    }
}
