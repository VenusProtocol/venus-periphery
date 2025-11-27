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
    /// @custom:error MintBehalfFailed mintBehalf on a vToken market returned a non-zero error code
    error MintBehalfFailed(uint256 errorCode);

    /// @custom:error BorrowBehalfFailed borrowBehalf on a vToken market returned a non-zero error code
    error BorrowBehalfFailed(uint256 errorCode);

    /// @custom:error RepayBehalfFailed repayBehalf on a vToken market returned a non-zero error code
    error RepayBehalfFailed(uint256 errorCode);

    /// @custom:error RedeemBehalfFailed redeemBehalf on a vToken market returned a non-zero error code
    error RedeemBehalfFailed(uint256 errorCode);

    /// @custom:error OperationCausesLiquidation Operation would put the account at risk (undercollateralized)
    error OperationCausesLiquidation();

    /// @custom:error TokenSwapCallFailed Swap helper call reverted or returned false
    error TokenSwapCallFailed();

    /// @custom:error FlashLoanAssetOrAmountMismatch Invalid flash loan arrays length or >1 elements
    error FlashLoanAssetOrAmountMismatch();

    /// @custom:error UnauthorizedExecutor Caller is not the expected Comptroller
    error UnauthorizedExecutor();

    /// @custom:error InvalidExecuteOperation Unknown operation type in flash loan callback
    error InvalidExecuteOperation();

    /// @custom:error SlippageExceeded Swap output lower than required minimum
    error SlippageExceeded();

    /// @custom:error InsufficientFundsToRepayFlashloan Not enough proceeds to repay flash loan plus fees
    error InsufficientFundsToRepayFlashloan();

    /// @custom:error InitiatorMismatch Invalid initiator address in flash loan callback
    error InitiatorMismatch();

    /// @custom:error OnBehalfMismatch Invalid onBehalf address in flash loan callback
    error OnBehalfMismatch();

    /// @custom:error EnterMarketFailed Comptroller.enterMarketBehalf returned a non-zero error code
    error EnterMarketFailed(uint256 err);

    /// @custom:error MarketNotListed Provided vToken market is not listed in Comptroller
    error MarketNotListed(address market);

    /// @custom:error ZeroAddress One of the required addresses is zero
    error ZeroAddress();

    /// @custom:error NotAnApprovedDelegate User has not approved this contract as a delegate
    error NotAnApprovedDelegate();

    /// @custom:error ZeroFlashLoanAmount Flash loan amount cannot be zero
    error ZeroFlashLoanAmount();

    /// @notice Emitted when dust amounts are transferred after a leverage operation
    /// @param recipient The address receiving the dust (user or protocol share reserve)
    /// @param token The underlying token address
    /// @param amount The amount of dust transferred
    event DustTransferred(address indexed recipient, address indexed token, uint256 amount);

    /// @notice Emitted when a user enters a leveraged position with single collateral asset
    /// @param user The address of the user entering the position
    /// @param collateralMarket The vToken market used as collateral
    /// @param collateralAmountSeed The initial collateral amount provided by the user
    /// @param collateralAmountToFlashLoan The amount being flash loaned
    event SingleAssetLeverageEntered(
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
    event LeverageEntered(
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
    event LeverageEnteredFromBorrow(
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
    event LeverageExited(
        address indexed user,
        IVToken indexed collateralMarket,
        uint256 collateralAmountToRedeemForSwap,
        IVToken indexed borrowedMarket,
        uint256 borrowedAmountToFlashLoan
    );

    /// @notice Emitted when a user exits a leveraged position with single collateral asset
    /// @param user The address of the user exiting the position
    /// @param collateralMarket The vToken market used for both collateral and borrowed asset
    /// @param collateralAmountToFlashLoan The amount being flash loaned
    event SingleAssetLeverageExited(
        address indexed user,
        IVToken indexed collateralMarket,
        uint256 collateralAmountToFlashLoan
    );

    /**
     * @notice Enumeration of operation types for flash loan callbacks
     * @param NONE Default value indicating no operation set
     * @param ENTER_SINGLE_ASSET Operation for entering a leveraged position using single asset (no swap)
     * @param ENTER_COLLATERAL Operation for entering a leveraged position with collateral seed
     * @param ENTER_BORROW Operation for entering a leveraged position with borrowed asset seed
     * @param EXIT_COLLATERAL Operation for exiting a leveraged position with swap
     * @param EXIT_SINGLE_ASSET Operation for exiting a leveraged position using single asset (no swap)
     */
    enum OperationType {
        NONE,
        ENTER_SINGLE_ASSET,
        ENTER_COLLATERAL,
        ENTER_BORROW,
        EXIT_COLLATERAL,
        EXIT_SINGLE_ASSET
    }

    /**
     * @notice Enters a leveraged position using only collateral provided by the user
     * @dev This function flash loans additional collateral assets, amplifying the user's supplied collateral
     *      in the Venus protocol. The user must have delegated permission to this contract via the comptroller.
     *      Any remaining collateral dust after the operation is returned to the user.
     * @param collateralMarket The vToken market where collateral will be supplied
     * @param collateralAmountSeed The initial amount of collateral the user provides (can be 0)
     * @param collateralAmountToFlashLoan The amount to borrow via flash loan for leverage
     * @custom:emits SingleAssetLeverageEntered
     * @custom:error NotAnApprovedDelegate if caller has not delegated to this contract
     * @custom:error MarketNotListed if the market is not listed in Comptroller
     * @custom:error OperationCausesLiquidation if the operation would make the account unsafe
     * @custom:error TransferFromUserFailed if seed amount transfer from user fails
     * @custom:error MintBehalfFailed if mint behalf operation fails
     * @custom:error BorrowBehalfFailed if borrow behalf operation fails
     */
    function enterSingleAssetLeverage(
        IVToken collateralMarket,
        uint256 collateralAmountSeed,
        uint256 collateralAmountToFlashLoan
    ) external;

    /**
     * @notice Enters a leveraged position by borrowing assets and converting them to collateral
     * @dev This function uses flash loans to borrow assets, swaps them for collateral tokens,
     *      and supplies the collateral to the Venus protocol to amplify the user's position.
     *      The user must have delegated permission to this contract via the comptroller.
     *      Any remaining dust (both collateral and borrowed assets) after the operation is returned to the user.
     * @param collateralMarket The vToken market where collateral will be supplied
     * @param collateralAmountSeed The initial amount of collateral the user provides (can be 0)
     * @param borrowedMarket The vToken market from which assets will be borrowed via flash loan
     * @param borrowedAmountToFlashLoan The amount to borrow via flash loan for leverage
     * @param minAmountOutAfterSwap The minimum amount of collateral expected after swap (for slippage protection)
     * @param swapData Bytes containing swap instructions for converting borrowed assets to collateral
     * @custom:emits LeverageEntered
     * @custom:error NotAnApprovedDelegate if caller has not delegated to this contract
     * @custom:error MarketNotListed if any market is not listed in Comptroller
     * @custom:error OperationCausesLiquidation if the operation would make the account unsafe
     * @custom:error TransferFromUserFailed if seed amount transfer from user fails
     * @custom:error MintBehalfFailed if mint behalf operation fails
     * @custom:error BorrowBehalfFailed if borrow behalf operation fails
     * @custom:error TokenSwapCallFailed if token swap execution fails
     * @custom:error SlippageExceeded if collateral balance after swap is below minimum
     */
    function enterLeverage(
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
     *      Any remaining dust (both collateral and borrowed assets) after the operation is returned to the user.
     * @param collateralMarket The vToken market where collateral will be supplied
     * @param borrowedMarket The vToken market from which assets will be borrowed via flash loan
     * @param borrowedAmountSeed The initial amount of borrowed assets the user provides (can be 0)
     * @param borrowedAmountToFlashLoan The additional amount to borrow via flash loan for leverage
     * @param minAmountOutAfterSwap The minimum amount of collateral expected after swap (for slippage protection)
     * @param swapData Bytes containing swap instructions for converting borrowed assets to collateral
     * @custom:emits LeverageEnteredFromBorrow
     * @custom:error NotAnApprovedDelegate if caller has not delegated to this contract
     * @custom:error MarketNotListed if any market is not listed in Comptroller
     * @custom:error OperationCausesLiquidation if the operation would make the account unsafe
     * @custom:error TransferFromUserFailed if seed amount transfer from user fails
     * @custom:error MintBehalfFailed if mint behalf operation fails
     * @custom:error BorrowBehalfFailed if borrow behalf operation fails
     * @custom:error TokenSwapCallFailed if token swap execution fails
     * @custom:error SlippageExceeded if collateral balance after swap is below minimum
     */
    function enterLeverageFromBorrow(
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
     *      swaps collateral for borrowed assets, and repays the flash loan. Any remaining
     *      collateral dust is returned to the user, while borrowed asset dust is transferred
     *      to the protocol share reserve.
     *
     *      NOTE: No pre-operation safety check is performed because exiting leverage reduces
     *      debt exposure, which can only improve account health. Post-operation safety is
     *      still validated to ensure the final position is healthy.
     * @param collateralMarket The vToken market from which collateral will be redeemed
     * @param collateralAmountToRedeemForSwap The amount of collateral to redeem and swap
     * @param borrowedMarket The vToken market where debt will be repaid via flash loan
     * @param borrowedAmountToFlashLoan The amount to borrow via flash loan for debt repayment
     * @param minAmountOutAfterSwap The minimum amount of borrowed asset expected after swap (for slippage protection)
     * @param swapData Bytes containing swap instructions for converting collateral to borrowed assets
     * @custom:emits LeverageExited
     * @custom:error NotAnApprovedDelegate if caller has not delegated to this contract
     * @custom:error MarketNotListed if any market is not listed in Comptroller
     * @custom:error OperationCausesLiquidation if the operation would make the account unsafe
     * @custom:error RepayBehalfFailed if repay operation fails
     * @custom:error RedeemBehalfFailed if redeem operation fails
     * @custom:error TokenSwapCallFailed if token swap execution fails
     * @custom:error SlippageExceeded if swap output is below minimum required
     * @custom:error InsufficientFundsToRepayFlashloan if insufficient funds to repay flash loan
     */
    function exitLeverage(
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
     *      and repays the flash loan without requiring token swaps. This is more gas-efficient
     *      than exitLeverage when dealing with single-asset positions. Any remaining collateral
     *      dust after the operation is returned to the user.
     *
     *      NOTE: No pre-operation safety check is performed because exiting leverage reduces
     *      debt exposure, which can only improve account health. Post-operation safety is
     *      still validated to ensure the final position is healthy.
     * @param collateralMarket The vToken market for both collateral and borrowed asset
     * @param collateralAmountToFlashLoan The amount to borrow via flash loan for debt repayment
     * @custom:emits SingleAssetLeverageExited
     * @custom:error NotAnApprovedDelegate if caller has not delegated to this contract
     * @custom:error MarketNotListed if the market is not listed in Comptroller
     * @custom:error OperationCausesLiquidation if the operation would make the account unsafe
     * @custom:error RepayBehalfFailed if repay operation fails
     * @custom:error RedeemBehalfFailed if redeem operation fails
     * @custom:error InsufficientFundsToRepayFlashloan if insufficient funds to repay flash loan
     */
    function exitSingleAssetLeverage(
        IVToken collateralMarket,
        uint256 collateralAmountToFlashLoan
    ) external;
}
