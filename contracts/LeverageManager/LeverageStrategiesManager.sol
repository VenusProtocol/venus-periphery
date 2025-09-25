// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

import { Ownable2StepUpgradeable } from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import { SafeERC20Upgradeable, IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";

import { IVToken, IComptroller, IFlashLoanReceiver, IProtocolShareReserve } from "../Interfaces.sol";
import { SwapHelper } from "../SwapHelper/SwapHelper.sol";

import { ILeverageStrategiesManager } from "./ILeverageStrategiesManager.sol";

/**
 * @title LeverageStrategiesManager
 * @author Venus Protocol
 * @notice Contract for managing leveraged positions using flash loans and token swaps
 * @custom:security-contact security@venusprotocol.io
 */
contract LeverageStrategiesManager is Ownable2StepUpgradeable, IFlashLoanReceiver, ILeverageStrategiesManager {
    using SafeERC20Upgradeable for IERC20Upgradeable;

    /// @notice The Venus comptroller contract for market interactions and flash loans
    IComptroller public immutable COMPTROLLER;
    
    /// @notice The protocol share reserve where dust amounts are transferred
    IProtocolShareReserve public immutable protocolShareReserve;
    
    /// @notice The swap helper contract for executing token swaps
    SwapHelper public immutable swapHelper;

    /**
     * @notice Enumeration of operation types for flash loan callbacks
     * @param ENTER Operation for entering a leveraged position
     * @param EXIT Operation for exiting a leveraged position
     */
    enum OperationType {
        ENTER,
        EXIT
    }

    /// @dev Transient variable to track the current operation type during flash loan execution
    OperationType transient operationType;
    
    /// @dev Transient variable to store the collateral market during flash loan execution
    IVToken transient transientCollateralMarket;
    
    /// @dev Transient variable to store the collateral amount during flash loan execution
    uint256 transient transientCollateralAmount;

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
    }

    /// @inheritdoc ILeverageStrategiesManager
    function enterLeveragedPosition(
        IVToken collateralMarket,
        uint256 collateralAmountSeed,
        IVToken borrowedMarket,
        uint256 borrowedAmountToFlashLoan,
        bytes[] calldata swapData
    ) external {
        _checkIfUserDelegated(msg.sender);
        _checkAccountSafe(msg.sender);
        
        transientCollateralMarket = collateralMarket;
        transientCollateralAmount = collateralAmountSeed;
        operationType = OperationType.ENTER;

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

        emit LeveragedPositionEntered(
            msg.sender,
            collateralMarket,
            collateralAmountSeed,
            borrowedMarket,
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
        bytes[] calldata swapData 
    ) external {
        _checkIfUserDelegated(msg.sender);

        transientCollateralMarket = collateralMarket;
        transientCollateralAmount = collateralAmountToRedeemForSwap;
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

    /**
     * @notice Flash loan callback function called by the comptroller
     * @dev This function is called by the Venus Comptroller during flash loan execution.
     *      It routes to appropriate operation handlers based on the current operation type.
     * @param assets Array of vToken addresses for the flash loan
     * @param amounts Array of amounts for each asset in the flash loan
     * @param premiums Array of premium amounts (fees) for each asset
     * @param initiator Address that initiated the flash loan (the user)
     * @param param Additional data passed from the flash loan call (swap instructions)
     * @return success Whether the operation completed successfully
     * @return amountsToReturn Array of amounts to repay for each asset
     * @custom:error FlashLoanAssetOrAmountMismatch if array lengths don't match or aren't length 1
     */
    function executeOperation(
        IVToken[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata premiums,
        address initiator,
        bytes calldata param
    ) external override returns (bool success, uint256[] memory amountsToReturn) {
        if (assets.length != 1 || amounts.length != 1 || premiums.length != 1) {
            revert FlashLoanAssetOrAmountMismatch(); 
        }

        if(operationType == OperationType.ENTER) {
            uint256 amountToRepay = _executeEnterOperation(initiator, assets[0], amounts[0], premiums[0], param);

            amountsToReturn = new uint256[](1);
            amountsToReturn[0] = amountToRepay;

            return (true, amountsToReturn);
        } else if(operationType == OperationType.EXIT) {
           uint256 amountToRepay =  _executeExitOperation(initiator,assets[0], amounts[0], premiums[0], param);

            amountsToReturn = new uint256[](1);
            amountsToReturn[0] = amountToRepay;

        } else {
            return (false, new uint256[](0));
        }
        
        return (true, amountsToReturn);
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
        _performSwap(borrowedAsset, borrowedAssetAmount, swapCallData);

        IERC20Upgradeable collateralAsset = IERC20Upgradeable(transientCollateralMarket.underlying());

        if(transientCollateralAmount > 0) {
            collateralAsset.safeTransferFrom(initiator, address(this), transientCollateralAmount);
        }

        uint256 collateralBalance = collateralAsset.balanceOf(address(this));

        uint256 mintSuccess = transientCollateralMarket.mintBehalf(initiator, collateralBalance);
        if (mintSuccess != 0) {
            revert EnterLeveragePositionFailed();
        }

        borrowedAssetAmountToRepay = borrowedAssetAmount + borrowedAssetFees;

        uint256 borrowSuccess = borrowMarket.borrowBehalf(initiator, borrowedAssetAmountToRepay);
        if (borrowSuccess != 0) {
            revert EnterLeveragePositionFailed();
        }

        borrowedAsset.safeApprove(address(borrowMarket), borrowedAssetAmountToRepay);
    }

    /**
     * @notice Executes the exit leveraged position operation during flash loan callback
     * @dev This function performs the following steps:
     *      1. Uses borrowed assets to repay user's debt in the collateral market
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
     */
    function _executeExitOperation(address initiator, IVToken borrowMarket, uint256 borrowedAssetAmountToRepayFromFlashLoan, uint256 borrowedAssetFees, bytes calldata swapCallData) internal returns (uint256 borrowedAssetAmountToRepay) {
        IERC20Upgradeable borrowedAsset = IERC20Upgradeable(borrowMarket.underlying());
        borrowedAsset.safeApprove(address(transientCollateralMarket), borrowedAssetAmountToRepayFromFlashLoan);

        uint256 repaySuccess = transientCollateralMarket.repayBorrowBehalf(initiator, borrowedAssetAmountToRepayFromFlashLoan);
        if (repaySuccess != 0) {
            revert ExitLeveragePositionFailed();
        }

        uint256 minCollateralAmountInForSwap = transientCollateralAmount;

        uint256 redeemSuccess = transientCollateralMarket.redeemUnderlyingBehalf(msg.sender, minCollateralAmountInForSwap);
        if (redeemSuccess != 0) {
            revert ExitLeveragePositionFailed();
        }
        
        IERC20Upgradeable collateralAsset = IERC20Upgradeable(transientCollateralMarket.underlying());
        _performSwap(collateralAsset, minCollateralAmountInForSwap, swapCallData);

       borrowedAssetAmountToRepay = borrowedAssetAmountToRepayFromFlashLoan + borrowedAssetFees;
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
    function _performSwap(IERC20Upgradeable tokenIn, uint256 amountIn, bytes calldata param) internal {
        tokenIn.transfer(address(swapHelper), amountIn);
        (bool success,) = address(swapHelper).call(param);
        if(!success) {
            revert SwapCallFailed();
        }
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
