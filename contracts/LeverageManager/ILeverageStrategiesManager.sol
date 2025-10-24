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
    /// @custom:error EnterLeveragePositionMintFailed
    error EnterLeveragePositionMintFailed();

    /// @custom:error EnterLeveragePositionBorrowBehalfFailed
    error EnterLeveragePositionBorrowBehalfFailed();

    /// @custom:error ExitLeveragePositionRepayFailed
    error ExitLeveragePositionRepayFailed();

    /// @custom:error ExitLeveragePositionRedeemFailed
    error ExitLeveragePositionRedeemFailed();

    /// @custom:error LeverageCausesLiquidation
    error LeverageCausesLiquidation();

    /// @custom:error SwapCallFailed
    error SwapCallFailed();

    /// @custom:error Unauthorized Caller is neither the user nor an approved delegate.
    error Unauthorized();

    /// @custom:error FlashLoanAssetOrAmountMismatch
    error FlashLoanAssetOrAmountMismatch();

    /// @custom:error ExecuteOperationNotCalledByAuthorizedContract
    error ExecuteOperationNotCalledByAuthorizedContract();

    /// @custom:error ExecuteOperationNotCalledCorrectly
    error ExecuteOperationNotCalledCorrectly();

    /// @custom:error InsufficientAmountOutAfterSwap
    error InsufficientAmountOutAfterSwap();

    /// @custom:error InsufficientFundsToRepayFlashloan
    error InsufficientFundsToRepayFlashloan();

    /// @custom:error TransferFromUserFailed
    error TransferFromUserFailed();

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
     * @param swapData Array of bytes containing swap instructions for converting borrowed assets to collateral
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
        bytes[] calldata swapData
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
     * @param swapData Array of bytes containing swap instructions for converting borrowed assets to collateral
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
        bytes[] calldata swapData
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
     * @param swapData Array of bytes containing swap instructions for converting collateral to borrowed assets
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
        bytes[] calldata swapData
    ) external;
}
