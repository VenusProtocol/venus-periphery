// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

import { IVToken } from "../Interfaces.sol";

/**
 * @title ILeverageStrategiesManager
 * @author Venus Protocol
 * @notice Interface for the Leverage Strategies Manager contract
 * @dev This interface defines the functionality for entering and exiting leveraged positions
 *      using flash loans and token swaps. The contract allows users to amplify their exposure
 *      to specific assets by borrowing against their collateral and reinvesting the borrowed funds.
 */
interface ILeverageStrategiesManager {
    /// @custom:error UnauthorizedCaller Caller is neither the user nor an approved delegate.
    error UnauthorizedCaller(address account);

    /// @custom:error EnterLeveragePositionMintFailed mintBehalf on a vToken market returned a non-zero error code
    error EnterLeveragePositionMintFailed(uint256 errorCode);

    /// @custom:error EnterLeveragePositionBorrowBehalfFailed borrowBehalf on a vToken market returned a non-zero error code
    error EnterLeveragePositionBorrowBehalfFailed(uint256 errorCode);

    /// @custom:error ExitLeveragePositionRepayFailed repayBehalf on a vToken market returned a non-zero error code
    error ExitLeveragePositionRepayFailed(uint256 errorCode);

    /// @custom:error ExitLeveragePositionRedeemFailed redeemBehalf on a vToken market returned a non-zero error code
    error ExitLeveragePositionRedeemFailed(uint256 errorCode);

    /// @custom:error LeverageCausesLiquidation Operation would put the account at risk (undercollateralized)
    error LeverageCausesLiquidation();

    /// @custom:error TokenSwapCallFailed Swap helper call reverted or returned false
    error TokenSwapCallFailed();

    /// @custom:error FlashLoanAssetOrAmountMismatch Invalid flash loan arrays length or >1 elements
    error FlashLoanAssetOrAmountMismatch();

    /// @custom:error UnauthorizedExecutor Caller is not the expected Comptroller
    error UnauthorizedExecutor();

    /// @custom:error InvalidExecuteOperation Unknown operation type in flash loan callback
    error InvalidExecuteOperation();

    /// @custom:error InsufficientAmountOutAfterSwap Swap output lower than required minimum
    error InsufficientAmountOutAfterSwap();

    /// @custom:error InsufficientFundsToRepayFlashloan Not enough proceeds to repay flash loan plus fees
    error InsufficientFundsToRepayFlashloan();

    /// @custom:error InitiatorMismatch Invalid initiator address in flash loan callback
    error InitiatorMismatch();

    /// @custom:error OnBehalfMismatch Invalid onBehalf address in flash loan callback
    error OnBehalfMismatch();

    /// @custom:error TransferFromUserFailed Failed to transfer tokens from user
    error TransferFromUserFailed();

    /// @custom:error EnterMarketFailed Comptroller.enterMarketBehalf returned a non-zero error code
    error EnterMarketFailed(uint256 err);

    /// @custom:error MarketNotListed Provided vToken market is not listed in Comptroller
    error MarketNotListed(address market);

    /// @custom:error ZeroAddress One of the required addresses is zero
    error ZeroAddress();

    /// @notice Emitted when a user enters a leveraged position with single collateral asset
    /// @param user The address of the user entering the position
    /// @param collateralMarket The vToken market used as collateral
    /// @param collateralAmountSeed The initial collateral amount provided by the user
    /// @param collateralAmountToFlashLoan The amount being flash loaned
    event LeveragedPositionEnteredWithSingleCollateral(
        address indexed user,
        IVToken indexed collateralMarket,
        uint256 collateralAmountSeed,
        uint256 collateralAmountToFlashLoan
    );

    /// @notice Emitted when a user enters a leveraged position with collateral seed
    /// @param user The address of the user entering the position
    /// @param collateralMarket The vToken market used as collateral
    /// @param collateralAmountSeed The initial collateral amount provided by the user
    /// @param borrowedMarket The vToken market being borrowed from
    /// @param borrowedAmountToFlashLoan The amount being flash loaned
    event LeveragedPositionEnteredWithCollateral(
        address indexed user,
        IVToken indexed collateralMarket,
        uint256 collateralAmountSeed,
        IVToken indexed borrowedMarket,
        uint256 borrowedAmountToFlashLoan
    );

    /// @notice Emitted when a user enters a leveraged position with borrowed asset seed
    /// @param user The address of the user entering the position
    /// @param collateralMarket The vToken market used as collateral
    /// @param borrowedMarket The vToken market being borrowed from
    /// @param borrowedAmountSeed The initial borrowed asset amount provided by the user
    /// @param borrowedAmountToFlashLoan The amount being flash loaned
    event LeveragedPositionEnteredWithBorrowed(
        address indexed user,
        IVToken indexed collateralMarket,
        IVToken indexed borrowedMarket,
        uint256 borrowedAmountSeed,
        uint256 borrowedAmountToFlashLoan
    );

    /// @notice Emitted when a user exits a leveraged position
    /// @param user The address of the user exiting the position
    /// @param collateralMarket The vToken market being redeemed
    /// @param collateralAmountToRedeemForSwap The amount of collateral being redeemed for swap
    /// @param borrowedMarket The vToken market being repaid
    /// @param borrowedAmountToFlashLoan The amount being flash loaned
    event LeveragedPositionExited(
        address indexed user,
        IVToken indexed collateralMarket,
        uint256 collateralAmountToRedeemForSwap,
        IVToken indexed borrowedMarket,
        uint256 borrowedAmountToFlashLoan
    );

    /// @notice Emitted when a user exits a leveraged position with single collateral asset
    /// @param user The address of the user exiting the position
    /// @param collateralMarket The vToken market used for both collateral and borrowed asset
    /// @param collateralAmountToRedeem The amount of collateral being redeemed
    /// @param collateralAmountToFlashLoan The amount being flash loaned
    event LeveragedPositionExitedWithSingleCollateral(
        address indexed user,
        IVToken indexed collateralMarket,
        uint256 collateralAmountToRedeem,
        uint256 collateralAmountToFlashLoan
    );

    /**
     * @notice Enters a leveraged position using only collateral provided by the user
     * @dev This function flash loans additional collateral assets, amplifying the user's supplied collateral
     *     in the Venus protocol. The user must have delegated permission to this contract via the comptroller.
     * @param collateralMarket The vToken market where collateral will be supplied
     * @param collateralAmountSeed The initial amount of collateral the user provides (can be 0)
     * @param collateralAmountToFlashLoan The amount to borrow via flash loan for leverage
     * @custom:emits LeveragedPositionEntered
     * @custom:error Unauthorized if caller is not user or approved delegate
     * @custom:error LeverageCausesLiquidation if the operation would make the account unsafe
     * @custom:error EnterLeveragePositionFailed if mint or borrow operations fail
     */
    function enterLeveragedPositionWithSingleCollateral(
        IVToken collateralMarket,
        uint256 collateralAmountSeed,
        uint256 collateralAmountToFlashLoan
    ) external;

    /**
     * @notice Enters a leveraged position by borrowing assets and converting them to collateral
     * @dev This function uses flash loans to borrow assets, swaps them for collateral tokens,
     *      and supplies the collateral to the Venus protocol to amplify the user's position.
     *      The user must have delegated permission to this contract via the comptroller.
     * @param collateralMarket The vToken market where collateral will be supplied
     * @param collateralAmountSeed The initial amount of collateral the user provides (can be 0)
     * @param borrowedMarket The vToken market from which assets will be borrowed via flash loan
     * @param borrowedAmountToFlashLoan The amount to borrow via flash loan for leverage
     * @param minAmountOutAfterSwap The minimum amount of collateral expected after swap (for slippage protection)
     * @param swapData Bytes containing swap instructions for converting borrowed assets to collateral
     * @custom:emits LeveragedPositionEntered
     * @custom:error Unauthorized if caller is not user or approved delegate
     * @custom:error LeverageCausesLiquidation if the operation would make the account unsafe
     * @custom:error EnterLeveragePositionFailed if mint or borrow operations fail
     * @custom:error SwapCallFailed if token swap execution fails
     * @custom:error InsufficientCollateralAfterSwap if collateral balance after swap is below minimum
     */
    function enterLeveragedPositionWithCollateral(
        IVToken collateralMarket,
        uint256 collateralAmountSeed,
        IVToken borrowedMarket,
        uint256 borrowedAmountToFlashLoan,
        uint256 minAmountOutAfterSwap,
        bytes calldata swapData
    ) external;

    /**
     * @notice Enters a leveraged position by using existing borrowed assets and converting them to collateral
     * @dev This function uses flash loans to borrow additional assets, swaps the total borrowed amount
     *      for collateral tokens, and supplies the collateral to the Venus protocol to amplify the user's position.
     *      The user must have delegated permission to this contract via the comptroller.
     * @param collateralMarket The vToken market where collateral will be supplied
     * @param borrowedMarket The vToken market from which assets will be borrowed via flash loan
     * @param borrowedAmountSeed The initial amount of borrowed assets the user has (can be 0)
     * @param borrowedAmountToFlashLoan The additional amount to borrow via flash loan for leverage
     * @param minAmountOutAfterSwap The minimum amount of collateral expected after swap (for slippage protection)
     * @param swapData Bytes containing swap instructions for converting borrowed assets to collateral
     * @custom:emits LeveragedPositionEntered
     * @custom:error Unauthorized if caller is not user or approved delegate
     * @custom:error LeverageCausesLiquidation if the operation would make the account unsafe
     * @custom:error EnterLeveragePositionFailed if mint or borrow operations fail
     * @custom:error SwapCallFailed if token swap execution fails
     * @custom:error InsufficientCollateralAfterSwap if collateral balance after swap is below minimum
     */
    function enterLeveragedPositionWithBorrowed(
        IVToken collateralMarket,
        IVToken borrowedMarket,
        uint256 borrowedAmountSeed,
        uint256 borrowedAmountToFlashLoan,
        uint256 minAmountOutAfterSwap,
        bytes calldata swapData
    ) external;

    /**
     * @notice Exits a leveraged position by redeeming collateral and repaying borrowed assets
     * @dev This function uses flash loans to temporarily repay debt, redeems collateral,
     *      swaps collateral for borrowed assets, and repays the flash loan. Any dust amounts
     *      are transferred to the protocol share reserve.
     * @param collateralMarket The vToken market from which collateral will be redeemed
     * @param collateralAmountToRedeemForSwap The amount of collateral to redeem and swap
     * @param borrowedMarket The vToken market where debt will be repaid via flash loan
     * @param borrowedAmountToFlashLoan The amount to borrow via flash loan for debt repayment
     * @param swapData Bytes containing swap instructions for converting collateral to borrowed assets
     * @custom:emits LeveragedPositionExited
     * @custom:error Unauthorized if caller is not user or approved delegate
     * @custom:error LeverageCausesLiquidation if the operation would make the account unsafe
     * @custom:error ExitLeveragePositionFailed if repay or redeem operations fail
     * @custom:error SwapCallFailed if token swap execution fails
     */
    function exitLeveragedPosition(
        IVToken collateralMarket,
        uint256 collateralAmountToRedeemForSwap,
        IVToken borrowedMarket,
        uint256 borrowedAmountToFlashLoan,
        uint256 minAmountOutAfterSwap,
        bytes calldata swapData
    ) external;

    /**
     * @notice Exits a leveraged position when collateral and borrowed assets are the same token
     * @dev This function uses flash loans to temporarily repay debt, redeems collateral,
     *      and repays the flash loan without requiring token swaps. Any dust amounts
     *      are transferred to the protocol share reserve. This is more gas-efficient than
     *      exitLeveragedPosition when dealing with single-asset positions.
     * @param collateralMarket The vToken market for both collateral and borrowed asset
     * @param collateralAmountToRedeem The amount of collateral to redeem from the market
     * @param collateralAmountToFlashLoan The amount to borrow via flash loan for debt repayment
     * @custom:emits LeveragedPositionExitedWithSingleCollateral
     * @custom:error Unauthorized if caller is not user or approved delegate
     * @custom:error MarketNotListed if the market is not listed in Comptroller
     * @custom:error LeverageCausesLiquidation if the operation would make the account unsafe
     * @custom:error ExitLeveragePositionRepayFailed if repay operation fails
     * @custom:error ExitLeveragePositionRedeemFailed if redeem operation fails
     * @custom:error InsufficientFundsToRepayFlashloan if insufficient funds to repay flash loan
     */
    function exitLeveragedPositionWithSingleCollateral(
        IVToken collateralMarket,
        uint256 collateralAmountToRedeem,
        uint256 collateralAmountToFlashLoan
    ) external;
}
