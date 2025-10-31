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

    /// @notice Emitted when an approved pair is updated.
    /// @param marketFrom The vToken market from which collateral/debt can be migrated
    /// @param marketTo The vToken market to which collateral/debt can be migrated
    /// @param helper The swap helper or adapter associated with this pair
    /// @param oldStatus The previous approval status for this pair/helper
    /// @param newStatus The new approval status for this pair/helper
    event ApprovedPairUpdated(address marketFrom, address marketTo, address helper, bool oldStatus, bool newStatus);

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

    // External functions
    function sweepToken(IERC20Upgradeable token) external;
    function sweepNative() external;

    function swapCollateralNativeToWrapped(address user) external;
    function swapDebtNativeToWrapped(address user) external;

    function swapFullCollateral(
        address user,
        IVToken marketFrom,
        IVToken marketTo,
        uint256 minAmountToSupply,
        bytes[] calldata swapData
    ) external payable;

    function swapCollateralWithAmount(
        address user,
        IVToken marketFrom,
        IVToken marketTo,
        uint256 maxAmountToSwap,
        uint256 minAmountToSupply,
        bytes[] calldata swapData
    ) external payable;

    function swapFullDebt(
        address user,
        IVToken marketFrom,
        IVToken marketTo,
        uint256 maxDebtAmountToOpen,
        bytes[] calldata swapData
    ) external payable;

    function swapDebtWithAmount(
        address user,
        IVToken marketFrom,
        IVToken marketTo,
        uint256 minDebtAmountToSwap,
        uint256 maxDebtAmountToOpen,
        bytes[] calldata swapData
    ) external payable;

}


