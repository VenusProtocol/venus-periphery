// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import { IVToken } from "../Interfaces.sol";

interface IPositionSwapper {
    enum OperationType {
        NONE,
        SWAP_COLLATERAL,
        SWAP_DEBT,
        SWAP_COLLATERAL_NATIVE_TO_WRAPPED,
        SWAP_DEBT_NATIVE_TO_WRAPPED
    }

    /// @notice Emitted after a successful collateral swap
    /// @param user The account whose collateral was migrated
    /// @param marketFrom The vToken market from which collateral was removed
    /// @param marketTo The vToken market to which collateral was supplied
    /// @param collateralRemoved Amount of underlying removed from `marketFrom`
    /// @param collateralSupplied Amount of underlying supplied to `marketTo`
    event CollateralSwapped(
        address indexed user,
        address indexed marketFrom,
        address indexed marketTo,
        uint256 collateralRemoved,
        uint256 collateralSupplied
    );

    /// @notice Emitted when a user swaps their debt from one market to another
    /// @param user The account whose debt was migrated
    /// @param marketFrom The vToken market where debt was repaid (removed)
    /// @param marketTo The vToken market where new debt was opened
    /// @param debtRemoved Amount of underlying debt repaid on `marketFrom`
    /// @param debtOpened Amount of underlying debt opened on `marketTo`
    event DebtSwapped(
        address indexed user,
        address indexed marketFrom,
        address indexed marketTo,
        uint256 debtRemoved,
        uint256 debtOpened
    );

    /// @notice Emitted when the owner sweeps leftover ERC-20 tokens.
    /// @param token The ERC-20 token that was swept
    /// @param receiver The address that received the swept tokens
    /// @param amount The amount of tokens transferred to `receiver`
    event SweepToken(address indexed token, address indexed receiver, uint256 amount);

    /// @notice Emitted when the owner sweeps leftover native tokens (e.g., BNB).
    /// @param receiver The address that received the native tokens
    /// @param amount The amount of native tokens transferred to `receiver`
    event SweepNative(address indexed receiver, uint256 amount);

    /// @custom:error UnauthorizedCaller Caller is neither the user nor an approved delegate.
    error UnauthorizedCaller(address account);

    /// @custom:error RedeemFailed Redeem on a vToken market returned a non-zero error code
    error RedeemFailed(uint256 err);

    /// @custom:error MintFailed Mint on a vToken market returned a non-zero error code
    error MintFailed(uint256 err);

    /// @custom:error RepayFailed Repay on a vToken market returned a non-zero error code
    error RepayFailed(uint256 err);

    /// @custom:error InsufficientCollateralBalance User has no collateral balance to swap
    error InsufficientCollateralBalance();

    /// @custom:error InsufficientBorrowBalance User has no borrow balance to swap
    error InsufficientBorrowBalance();

    /// @custom:error ZeroAmount Provided amount parameter is zero
    error ZeroAmount();

    /// @custom:error SwapCausesLiquidation Operation would put the account at risk (undercollateralized)
    error SwapCausesLiquidation(uint256 err);

    /// @custom:error MarketNotListed Provided vToken market is not listed in Comptroller
    error MarketNotListed(address market);

    /// @custom:error ZeroAddress One of the required addresses is zero
    error ZeroAddress();

    /// @custom:error TransferFailed Native or ERC-20 transfer failed
    error TransferFailed();

    /// @custom:error EnterMarketFailed Comptroller.enterMarket returned a non-zero error code
    error EnterMarketFailed(uint256 err);

    /// @custom:error TokenSwapCallFailed Swap helper call reverted or returned false
    error TokenSwapCallFailed();

    /// @custom:error InvalidFlashLoanAmountReceived Unexpected or insufficient tokens received for flash loan workflow
    error InvalidFlashLoanAmountReceived();

    /// @custom:error UnauthorizedExecutor Caller is not the expected Comptroller
    error UnauthorizedExecutor();

    /// @custom:error FlashLoanAssetOrAmountMismatch Invalid flash loan arrays length or >1 elements
    error FlashLoanAssetOrAmountMismatch();

    /// @custom:error InvalidExecuteOperation Unknown operation type in flash loan callback
    error InvalidExecuteOperation();

    /// @custom:error InsufficientFundsToRepayFlashloan Not enough proceeds to repay flash loan plus fees
    error InsufficientFundsToRepayFlashloan();

    /// @custom:error InsufficientAmountOutAfterSwap Swap output lower than required minimum
    error InsufficientAmountOutAfterSwap();

    // External functions
    /// @notice Allows the owner to sweep leftover ERC-20 tokens from the contract.
    /// @param token The token to sweep.
    /// @custom:event Emits SweepToken event.
    function sweepToken(IERC20Upgradeable token) external;

    /// @notice Allows the owner to sweep leftover native tokens (e.g., BNB) from the contract.
    /// @custom:event Emits SweepNative event.
    /// @custom:error TransferFailed Native transfer failed
    function sweepNative() external;

    /// @notice Swap user's entire native collateral (e.g., vBNB) into wrapped collateral (e.g., vWBNB).
    /// @param user Address of the user.
    /// @custom:error InsufficientCollateralBalance User has no native collateral
    /// @custom:event Emits CollateralSwapped on success
    function swapCollateralNativeToWrapped(address user) external;

    /// @notice Swap user's entire native debt (e.g., vBNB borrow) into wrapped debt (e.g., vWBNB borrow).
    /// @param user Address of the user.
    /// @custom:error InsufficientBorrowBalance User has no native debt
    /// @custom:event Emits DebtSwapped on success
    function swapDebtNativeToWrapped(address user) external;

    /// @notice Swaps the full vToken collateral of a user from one market to another.
    /// @param user The address whose collateral is being swapped.
    /// @param marketFrom The vToken market to seize from.
    /// @param marketTo The vToken market to mint into.
    /// @param minAmountToSupply Minimum amount of target underlying to supply after swap.
    /// @param swapData Bytes containing swap instructions for the SwapHelper.
    /// @custom:error InsufficientCollateralBalance The user has no underlying balance in the `marketFrom`.
    /// @custom:event Emits CollateralSwapped event.
    function swapFullCollateral(
        address user,
        IVToken marketFrom,
        IVToken marketTo,
        uint256 minAmountToSupply,
        bytes calldata swapData
    ) external;

    /// @notice Swaps a specific amount of collateral from one market to another.
    /// @param user The address whose collateral is being swapped.
    /// @param marketFrom The vToken market to seize from.
    /// @param marketTo The vToken market to mint into.
    /// @param maxAmountToSwap The maximum amount of underlying to swap from `marketFrom`.
    /// @param minAmountToSupply Minimum amount of target underlying to supply after swap.
    /// @param swapData Bytes containing swap instructions for the SwapHelper.
    /// @custom:error ZeroAmount The `maxAmountToSwap` is zero.
    /// @custom:error InsufficientCollateralBalance The user has insufficient underlying balance in the `marketFrom`.
    /// @custom:event Emits CollateralSwapped event.
    function swapCollateralWithAmount(
        address user,
        IVToken marketFrom,
        IVToken marketTo,
        uint256 maxAmountToSwap,
        uint256 minAmountToSupply,
        bytes calldata swapData
    ) external;

    /// @notice Swaps the full debt of a user from one market to another.
    /// @param user The address whose debt is being swapped.
    /// @param marketFrom The vToken market from which debt is swapped.
    /// @param marketTo The vToken market into which the new debt is borrowed.
    /// @param maxDebtAmountToOpen Maximum amount to open as new debt on `marketTo` (before fee rounding).
    /// @param swapData Bytes containing swap instructions for the SwapHelper.
    /// @custom:error InsufficientBorrowBalance The user has no borrow balance in the `marketFrom`.
    /// @custom:event Emits DebtSwapped event.
    function swapFullDebt(
        address user,
        IVToken marketFrom,
        IVToken marketTo,
        uint256 maxDebtAmountToOpen,
        bytes calldata swapData
    ) external;

    /// @notice Swaps a specific amount of debt from one market to another.
    /// @param user The address whose debt is being swapped.
    /// @param marketFrom The vToken market from which debt is swapped.
    /// @param marketTo The vToken market into which the new debt is borrowed.
    /// @param minDebtAmountToSwap The minimum amount of debt of `marketFrom` to repay.
    /// @param maxDebtAmountToOpen The maximum amount to open as new debt on `marketTo`.
    /// @param swapData Bytes containing swap instructions for the SwapHelper.
    /// @custom:error ZeroAmount The `minDebtAmountToSwap` is zero.
    /// @custom:error InsufficientBorrowBalance The user has insufficient borrow balance in the `marketFrom`.
    /// @custom:event Emits DebtSwapped event.
    function swapDebtWithAmount(
        address user,
        IVToken marketFrom,
        IVToken marketTo,
        uint256 minDebtAmountToSwap,
        uint256 maxDebtAmountToOpen,
        bytes calldata swapData
    ) external;
}
