// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

import { Ownable2StepUpgradeable } from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import { SafeERC20Upgradeable, IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";

import { IVToken, IComptroller, IFlashLoanReceiver, IProtocolShareReserve } from "../Interfaces.sol";
import { SwapHelper } from "../SwapHelper/SwapHelper.sol";

import { ILeverageStrategiesManager } from "./ILeverageStrategiesManager.sol";

contract LeverageStrategiesManager is Ownable2StepUpgradeable, IFlashLoanReceiver, ILeverageStrategiesManager {
    using SafeERC20Upgradeable for IERC20Upgradeable;

    IComptroller public immutable COMPTROLLER;
    IProtocolShareReserve public immutable protocolShareReserve;
    SwapHelper public immutable swapHelper;

    enum OperationType {
        ENTER,
        EXIT
    }

    OperationType transient operationType;
    IVToken transient transientCollateralMarket;
    uint256 transient transientCollateralAmount;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(IComptroller _comptroller,  IProtocolShareReserve _protocolShareReserve, SwapHelper _swapHelper) {
        COMPTROLLER = _comptroller;
        protocolShareReserve = _protocolShareReserve;
        swapHelper = _swapHelper;
        _disableInitializers();
    }

    function initialize() external initializer {
        __Ownable2Step_init();
    }

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

        _checkAccountSafe(msg.sender);
    }

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

        _transferDustToTreasury(collateralMarket);
        _transferDustToTreasury(borrowedMarket);

        _checkAccountSafe(msg.sender);
    }

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
    * @param borrowMarket The market from which the asset is borrowed.
    * @param borrowedAssetAmount The amount of the borrowed asset received from the flash loan.
    * @param borrowedAssetFees The fees to be paid on top of the borrowed asset amount.
    * @param swapCallData The data required for the swap borrowed asset to collateral asset to enter the leveraged position.
    * @return borrowedAssetAmountToRepay The total amount of the borrowed asset to repay
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
    * @param borrowMarket The market from which the asset is borrowed.
    * @param borrowedAssetAmountToRepayFromFlashLoan The amount of the borrowed asset received from the flash loan.
    * @param borrowedAssetFees The fees associated with the borrowed asset.
    * @param swapCallData The data required for the swap collateral asset to borrowed asset to repay the flash loan.
    * @return borrowedAssetAmountToRepay The total amount of the borrowed asset to repay
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
    * @param tokenIn The input token to be swapped.
    * @param amountIn The amount of the input token to be swapped.
    * @param param The calldata required for the swap operation.
    */
    function _performSwap(IERC20Upgradeable tokenIn, uint256 amountIn, bytes calldata param) internal {
        tokenIn.transfer(address(swapHelper), amountIn);
        (bool success,) = address(swapHelper).call(param);
        if(!success) {
            revert SwapCallFailed();
        }
    }

    /**
    * @dev Transfers any remaining dust of the specified market's underlying asset to the protocol share reserve.
    * @param market The market whose underlying asset dust is to be transferred.
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
    * @dev Checks if the user has delegated permission to this contract.
    * @param user The address of the user to check.
    */
    function _checkIfUserDelegated(address user) internal view {
        if (!COMPTROLLER.approvedDelegates(user, address(this))) {
            revert Unauthorized();
        }
    }

    /**
     * @dev Checks if a user's account is safe post-swap.
     * @param user The address to check.
     */
    function _checkAccountSafe(address user) internal view {
        (uint256 err, , uint256 shortfall) = COMPTROLLER.getAccountLiquidity(user);
        if (err != 0 || shortfall > 0) revert LeverageCausesLiquidation();
    }
}
