// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

import { IVToken } from "../Interfaces.sol";

/**
 * @title IRelativePositionManager
 * @author Venus Protocol
 * @notice Interface for the Relative Position Manager contract
 * @dev This contract manages isolated leveraged positions using 3-token logic (DSA + Long + Short)
 *      where positions are opened on behalf of PositionAccount contracts deployed per user per position pair.
 */
interface IRelativePositionManager {
    /// @notice Structure representing a user's position
    struct Position {
        address user; // User who owns this position (immutable)
        address longVToken; // Long vToken market (immutable)
        address shortVToken; // Short vToken market (immutable)
        uint8 dsaIndex; // Index of DSA in dsaVTokens array (immutable)
        address positionAccount; // Address of the PositionAccount contract (immutable)
        uint256 suppliedPrincipal; // Total DSA supplied as collateral, in vToken amount (mutable)
        uint256 effectiveLeverage; // Leverage ratio (mutable)
        uint256 cycleId; // Current cycle ID, increments on each activation (mutable)
        bool isActive; // Whether position is currently active (mutable)
    }

    /// @notice Structure for utilization calculation results
    struct UtilizationInfo {
        uint256 actualCapitalUtilized; // Capital used based on collateral LTV ratios (in USD)
        uint256 nominalCapitalUtilized; // Capital used based on leverage ratio (in USD)
        uint256 finalCapitalUtilized; // Position capital capped by supplied principal (in USD)
        uint256 availableCapitalUSD; // Remaining capital available for borrowing (in USD)
        uint256 withdrawableAmount; // Amount that can be withdrawn in DSA token terms
    }

    /// @dev USD values for long collateral, short debt, and supplied principal (and prices used for conversions)
    struct PositionValuesUSD {
        uint256 longValueUSD;
        uint256 borrowValueUSD;
        uint256 suppliedPrincipalUSD;
        uint256 dsaPrice;
        uint256 shortPrice;
    }

    /// @custom:error PositionAlreadyExists when user tries to activate an already active position
    error PositionAlreadyExists();

    /// @custom:error PositionNotActive when trying to operate on inactive position
    error PositionNotActive();

    /// @custom:error PositionNotFullyClosed when trying to deactivate a position that still has collateral or debt
    error PositionNotFullyClosed();

    /// @custom:error InvalidDSA when DSA asset is not valid
    error InvalidDSA();

    /// @custom:error WithdrawPrincipalBeforeChangingDSA when user tries to change DSA asset without first withdrawing current principal
    error WithdrawPrincipalBeforeChangingDSA();

    /// @custom:error InsufficientPrincipal when supplied principal is insufficient
    error InsufficientPrincipal();

    /// @custom:error LeverageTooHigh when leverage exceeds maximum allowed
    error LeverageTooHigh();

    /// @custom:error InvalidLeverage when leverage is invalid (0 or too low)
    error InvalidLeverage();

    /// @custom:error BorrowAmountExceedsMaximum when borrow amount exceeds the calculated maximum based on capital utilization
    error BorrowAmountExceedsMaximum();

    /// @custom:error InsufficientWithdrawableAmount when trying to withdraw more than allowed
    error InsufficientWithdrawableAmount();

    /// @custom:error UnauthorizedAccess when caller is not authorized
    error UnauthorizedAccess();

    /// @custom:error InvalidPositionAccount when position account address is invalid
    error InvalidPositionAccount();

    /// @custom:error DelegateCallFailed when generic call fails
    error DelegateCallFailed();

    /// @custom:error ZeroAddress when a zero address is provided
    error ZeroAddress();

    /// @custom:error InvalidOraclePrice when oracle returns zero or invalid price
    error InvalidOraclePrice();

    /// @custom:error AssetNotListed when asset market is not listed in comptroller
    error AssetNotListed();

    /// @custom:error VBNBNotSupported when trying to use vBNB market
    error VBNBNotSupported();

    /// @custom:error MintBehalfFailed when minting vTokens on behalf fails
    /// @param errorCode Error code returned by the vToken mintBehalf call
    error MintBehalfFailed(uint256 errorCode);

    /// @custom:error EnterMarketFailed when entering market on behalf fails
    error EnterMarketFailed(uint256 errorCode);

    /// @custom:error ZeroAmount when amount is zero
    error ZeroAmount();

    /// @custom:error ZeroBorrowAmount when borrow amount is zero
    error ZeroBorrowAmount();

    /// @custom:error ZeroFlashLoanAmount when flash loan amount is zero
    error ZeroFlashLoanAmount();

    /// @custom:error NoShortDebtToRepay when closeWithProfit is called but position has no short debt to repay
    error NoShortDebtToRepay();

    /// @custom:error ShortDebtNotFullyRepaid when repay step did not clear all short debt (insufficient swap output)
    error ShortDebtNotFullyRepaid();

    /// @custom:error NotProfitScenario when closeWithProfit is called but long collateral value (USD) is not greater than short debt (USD)
    error NotProfitScenario();

    /// @custom:error NotLossScenario when closeWithLoss is called but short debt (USD) is not greater than long collateral (USD)
    error NotLossScenario();

    /// @custom:error InsufficientLongForFirstSwap when longAmountToRedeemForFirstSwap exceeds available long collateral
    error InsufficientLongForFirstSwap();

    /// @custom:error MinAmountOutSecondBelowDebt when minAmountOutSecond is less than remaining short debt (second swap)
    error MinAmountOutSecondBelowDebt();

    /// @custom:error MinAmountOutRepayBelowDebt when minAmountOutRepay is less than current short debt
    error MinAmountOutRepayBelowDebt();

    /// @custom:error InsufficientExcessLongForProfitSwap when excess long collateral is less than amountToRedeemForProfitSwap (exact-in swap requires at least that much)
    error InsufficientExcessLongForProfitSwap();

    /// @custom:error ExitMarketFailed when exiting market fails
    error ExitMarketFailed();

    /// @custom:error RedeemBehalfFailed when redeeming vTokens on behalf fails
    /// @param errorCode Error code returned by the vToken redeemUnderlyingBehalf call
    error RedeemBehalfFailed(uint256 errorCode);

    /// @custom:error TokenSwapCallFailed when swap execution via SwapHelper fails
    error TokenSwapCallFailed();

    /// @custom:error SlippageExceeded when swap output is below the minimum required
    error SlippageExceeded();

    /// @custom:error PositionAccountImplementationNotSet when trying to deploy or compute position accounts before implementation is configured
    error PositionAccountImplementationNotSet();

    /// @custom:error SamePositionAccountImplementation when setter is called with the current implementation address
    error SamePositionAccountImplementation();

    /// @notice Emitted when a user activates a position account
    /// @param user Address of the user
    /// @param longAsset Address of the long asset
    /// @param shortAsset Address of the short asset
    /// @param dsaAsset Address of the DSA asset
    /// @param positionAccount Address of the deployed PositionAccount
    /// @param initialPrincipal Initial principal supplied (optional)
    /// @param effectiveLeverage Target leverage ratio for the position
    event PositionActivated(
        address indexed user,
        address indexed longAsset,
        address indexed shortAsset,
        address dsaAsset,
        address positionAccount,
        uint256 cycleId,
        uint256 initialPrincipal,
        uint256 effectiveLeverage
    );

    /// @notice Emitted when a user supplies additional principal
    /// @param user Address of the user
    /// @param positionAccount Address of the position account
    /// @param cycleId The cycle ID of the position
    /// @param dsaAsset Address of the DSA asset
    /// @param amount Amount supplied
    /// @param newTotalPrincipal New total principal amount
    event PrincipalSupplied(
        address indexed user,
        address indexed positionAccount,
        uint256 cycleId,
        address dsaAsset,
        uint256 amount,
        uint256 newTotalPrincipal
    );

    /// @notice Emitted when a position is opened or scaled (borrow + swap to long)
    /// @param user Address of the user
    /// @param positionAccount Address of the position account
    /// @param longAsset Address of the long asset
    /// @param shortAsset Address of the short asset
    /// @param dsaAsset Address of the DSA asset
    /// @param shortAmount Amount borrowed in short asset
    /// @param additionalPrincipal Additional principal supplied this call (0 if none)
    event PositionOpened(
        address indexed user,
        address indexed positionAccount,
        uint256 cycleId,
        address longAsset,
        address shortAsset,
        address dsaAsset,
        uint256 shortAmount,
        uint256 additionalPrincipal
    );

    /// @notice Emitted when a position is closed (partially or fully)
    /// @param user Address of the user
    /// @param positionAccount Address of the position account
    /// @param cycleId The cycle ID of the position
    /// @param remainingDebt Remaining short debt on the position account after the close (0 if fully closed)
    event PositionClosed(address indexed user, address indexed positionAccount, uint256 cycleId, uint256 remainingDebt);

    /// @notice Emitted when a position is closed with profit (debt repaid, profit realized). Principal remains; user withdraws separately.
    /// @param user Address of the user
    /// @param positionAccount Address of the position account
    /// @param cycleId The cycle ID of the position
    event PositionClosedWithProfit(address indexed user, address indexed positionAccount, uint256 cycleId);

    /// @notice Emitted when a position is closed with loss (debt repaid, position fully closed).
    /// @param user Address of the user
    /// @param positionAccount Address of the position account
    /// @param cycleId The cycle ID of the position
    event PositionClosedWithLoss(address indexed user, address indexed positionAccount, uint256 cycleId);

    /// @notice Emitted when principal is withdrawn
    /// @param user Address of the user
    /// @param positionAccount Address of the position account
    /// @param dsaAsset Address of the DSA asset
    /// @param amount Amount withdrawn
    /// @param remainingPrincipal Remaining principal after withdrawal
    event PrincipalWithdrawn(
        address indexed user,
        address indexed positionAccount,
        address dsaAsset,
        uint256 amount,
        uint256 remainingPrincipal
    );

    /// @notice Emitted when a position is deactivated
    /// @param user Address of the user
    /// @param positionAccount Address of the position account
    event PositionDeactivated(address indexed user, address indexed positionAccount, uint256 cycleId);

    /// @notice Emitted when a new DSA vToken is added
    /// @param dsaVToken Address of the DSA vToken added
    /// @param index Index of the DSA vToken in the array
    event DSAVTokenAdded(address indexed dsaVToken, uint8 index);

    /// @notice Emitted when generic call is executed on position account
    /// @param positionAccount Address of the position account
    /// @param target Target contract address
    /// @param data Call data
    event GenericCallExecuted(address indexed positionAccount, address target, bytes data);

    /// @notice Emitted when the PositionAccount implementation address is updated
    /// @param oldImplementation Previous implementation address (zero if first set)
    /// @param newImplementation New implementation address
    event PositionAccountImplementationUpdated(address indexed oldImplementation, address indexed newImplementation);

    /// @notice Emitted when a new PositionAccount clone is deployed for a user and asset pair
    /// @param user Owner of the position account
    /// @param longAsset Long asset vToken address
    /// @param shortAsset Short asset vToken address
    /// @param positionAccount Address of the deployed PositionAccount clone
    event PositionAccountDeployed(
        address indexed user,
        address indexed longAsset,
        address indexed shortAsset,
        address positionAccount
    );

    /**
     * @notice Activates a position account for the user with specified asset pair and DSA
     * @dev Deploys a new PositionAccount contract if one doesn't exist for this user/asset combination.
     *      The effective leverage must be set during activation and will be used to validate borrow amounts
     *      in openPosition operations.
     * @param longVToken The vToken market address for the asset to long
     * @param shortVToken The vToken market address for the asset to short
     * @param dsaIndex Index of the DSA vToken in the dsaVTokens array
     * @param initialPrincipal Optional initial principal amount to supply
     * @param effectiveLeverage The target leverage ratio for this position (in mantissa, e.g., 2e18 = 2x leverage)
     */
    function activatePosition(
        address longVToken,
        address shortVToken,
        uint8 dsaIndex,
        uint256 initialPrincipal,
        uint256 effectiveLeverage
    ) external;

    /**
     * @notice Increases principal for an active position
     * @dev Can be called multiple times to add collateral. If position is open, this scales the position.
     *      Validates that the provided DSA index matches the position's configured DSA.
     * @param longAsset The vToken market address for the long asset
     * @param shortAsset The vToken market address for the short asset
     * @param dsaIndex Index of the DSA vToken in the dsaVTokens array
     * @param amount Amount of DSA underlying to supply
     */
    function increasePrincipal(address longAsset, address shortAsset, uint8 dsaIndex, uint256 amount) external;

    /**
     * @notice Opens a leveraged position or scales an existing one (borrow short, swap to long)
     * @dev Can be called multiple times to scale the position. Optionally supply additional principal
     *      via additionalPrincipal; otherwise uses existing principal. Validates that shortAmount doesn't
     *      exceed the maximum allowed based on capital utilization. dsaIndex must match the position's DSA (set during activation).
     * @param longVToken The vToken market for the asset to long
     * @param shortVToken The vToken market for the asset to short
     * @param dsaIndex Index of the DSA vToken for this position (must match position)
     * @param additionalPrincipal Additional principal to supply this call (0 if none)
     * @param shortAmount Amount to borrow in shortAsset terms (must not exceed max calculated borrow)
     * @param minLongAmount Minimum amount of long asset expected from swap (protects against slippage)
     * @param swapData Swap instructions for converting shortAsset to longAsset
     */
    function openPosition(
        IVToken longVToken,
        IVToken shortVToken,
        uint8 dsaIndex,
        uint256 additionalPrincipal,
        uint256 shortAmount,
        uint256 minLongAmount,
        bytes calldata swapData
    ) external;

    /**
     * @notice Closes a position partially or fully
     * @dev Supports partial closing. Validates that remaining leverage doesn't exceed effective leverage.
     * @param longVToken The vToken market for the long asset
     * @param shortVToken The vToken market for the short asset
     * @param collateralAmountToRedeem Amount of long collateral to redeem
     * @param borrowedAmountToRepay Amount of short debt to repay via flash loan
     * @param minAmountOutAfterSwap Minimum amount out expected after swap (slippage protection)
     * @param swapData Swap instructions for converting long asset to short asset for repayment
     */
    function closePosition(
        IVToken longVToken,
        IVToken shortVToken,
        uint256 collateralAmountToRedeem,
        uint256 borrowedAmountToRepay,
        uint256 minAmountOutAfterSwap,
        bytes calldata swapData
    ) external;

    /**
     * @notice Closes a position with profit (longValueUSD > shortDebtUSD)
     * @dev Repay: exitLeverage; borrow from state. Reverts if minAmountOutRepay < short debt.
     *      Profit: exact-in swap amountToRedeemForProfitSwap long→DSA (reverts if > excess long). User gets DSA + extra long. Principal not withdrawn.
     * @param longVToken The vToken market for the long asset
     * @param shortVToken The vToken market for the short asset
     * @param collateralAmountToRedeemForRepay Amount of long to redeem for repay swap (passed to exitLeverage)
     * @param swapDataRepay Swap #1: long → short for debt repayment
     * @param minAmountOutRepay Minimum short out from repay swap (must be >= current short debt)
     * @param amountToRedeemForProfitSwap Exact amount of excess long to swap long→DSA; must not exceed excess long
     * @param swapDataProfit Swap #2: long → DSA for profit realization
     * @param minAmountOutProfit Minimum DSA out from profit swap
     */
    function closeWithProfit(
        IVToken longVToken,
        IVToken shortVToken,
        uint256 collateralAmountToRedeemForRepay,
        bytes calldata swapDataRepay,
        uint256 minAmountOutRepay,
        uint256 amountToRedeemForProfitSwap,
        bytes calldata swapDataProfit,
        uint256 minAmountOutProfit
    ) external;

    /**
     * @notice Closes a position with loss (longValueUSD < shortDebtUSD)
     * @dev First exitLeverage (long→short): redeems longAmountToRedeemForFirstSwap (exact-in; reverts if > available long).
     *      Any remaining long is redeemed and transferred to user. Second exitLeverage (DSA→short): remaining short debt
     *      is read from state; reverts if minAmountOutSecond < that debt. suppliedPrincipal set to remaining DSA vToken balance.
     * @param longVToken The vToken market for the long asset
     * @param shortVToken The vToken market for the short asset
     * @param borrowedAmountToRepayFirst Short debt to repay in first exit (Exact-In)
     * @param longAmountToRedeemForFirstSwap Exact long to redeem for first swap (swapHelper pulls this); must not exceed available long
     * @param minAmountOutFirst Minimum short out from first swap
     * @param swapDataFirst Swap #1: long → short
     * @param dsaAmountToRedeemForRepay DSA to redeem for second repayment
     * @param minAmountOutSecond Minimum short out from second swap (must be >= remaining short debt; remaining debt read in-function)
     * @param swapDataSecond Swap #2: DSA → short
     */
    function closeWithLoss(
        IVToken longVToken,
        IVToken shortVToken,
        uint256 borrowedAmountToRepayFirst,
        uint256 longAmountToRedeemForFirstSwap,
        uint256 minAmountOutFirst,
        bytes calldata swapDataFirst,
        uint256 dsaAmountToRedeemForRepay,
        uint256 minAmountOutSecond,
        bytes calldata swapDataSecond
    ) external;

    /**
     * @notice Withdraws unused principal from an active position
     * @dev Calculates utilization to determine how much can be safely withdrawn.
     *      The DSA asset is retrieved from the position data (set during activation).
     * @param longVToken The vToken market for the long asset
     * @param shortVToken The vToken market for the short asset
     * @param amount Amount to withdraw
     */
    function withdrawPrincipal(IVToken longVToken, IVToken shortVToken, uint256 amount) external;

    /**
     * @notice Deactivates a position account
     * @dev Removes DSA selection and resets leverage. User can activate with new DSA later.
     *      The DSA asset is retrieved from the position data (set during activation).
     * @param longVToken The vToken market for the long asset
     * @param shortVToken The vToken market for the short asset
     */
    function deactivatePosition(IVToken longVToken, IVToken shortVToken) external;

    /**
     * @notice Adds a new DSA vToken to the supported list
     * @dev Index will be the current length of the array. Callable only by accounts with ACM permission for addDSAVToken(address).
     * @param dsaVToken The vToken market address to add as a supported DSA
     */
    function addDSAVToken(address dsaVToken) external;

    /**
     * @notice Returns the total number of supported DSA vTokens
     * @return count The number of DSA vTokens in the array
     */
    function getDSAVTokensCount() external view returns (uint256 count);

    /**
     * @notice Returns the address at which the PositionAccount would be deployed for the given user and markets
     * @dev Same salt as used when deploying via activatePosition. Returns the address that would be used if the position account were deployed.
     * @param user User address
     * @param longVToken The vToken market for the long asset
     * @param shortVToken The vToken market for the short asset
     * @return predicted The predicted PositionAccount address
     */
    function getPositionAccountAddress(
        address user,
        IVToken longVToken,
        IVToken shortVToken
    ) external view returns (address predicted);

    /**
     * @notice Updates the implementation contract used for PositionAccount clones
     * @dev Callable only by accounts with ACM permission for setPositionAccountImplementation(address).
     *      Must be configured before any position accounts can be deployed or predicted.
     * @param positionAccountImpl Implementation contract for PositionAccount EIP-1167 clones
     */
    function setPositionAccountImplementation(address positionAccountImpl) external;

    /**
     * @notice Returns the position data for a user and asset pair
     * @param user User address
     * @param longVToken The vToken market for the long asset
     * @param shortVToken The vToken market for the short asset
     * @return position The Position struct (user, longVToken, shortVToken, dsaIndex, positionAccount, suppliedPrincipal, effectiveLeverage, cycleId, isActive)
     */
    function getPosition(
        address user,
        IVToken longVToken,
        IVToken shortVToken
    ) external view returns (Position memory position);

    /**
     * @notice Executes an arbitrary call on behalf of a position account
     * @dev Callable by governance, Allows operations like emergency fund rescues.
     * @param positionAccount Address of the position account
     * @param target Target contract address
     * @param data Encoded call data
     */
    function executePositionAccountCall(address positionAccount, address target, bytes calldata data) external;

    /**
     * @notice Calculates capital utilization for a position
     * @dev Computes how much capital is being used vs available:
     *      1. Calculates actual capital utilized (based on collateral LTV ratios)
     *      2. Calculates nominal capital utilized (based on leverage ratio)
     *      3. Takes max (more conservative estimate)
     *      4. Caps by supplied principal
     *      5. Calculates available capital remaining
     *      6. Calculates withdrawable amount in DSA token terms
     *      Used by calculateMaxBorrow to determine maximum borrowing capacity.
     * @param user User address
     * @param longVToken The vToken market for the long asset
     * @param shortVToken The vToken market for the short asset
     * @param dsaVToken The vToken market for the DSA asset
     * @return utilization Utilization information including available capital and withdrawable amount
     */
    function getUtilizationInfo(
        address user,
        IVToken longVToken,
        IVToken shortVToken,
        IVToken dsaVToken
    ) external returns (UtilizationInfo memory utilization);

    /**
     * @notice Calculates the maximum allowed borrow amount for a position
     * @dev Uses getUtilizationInfo internally to get available capital, then calculates:
     *      maxBorrow = availableCapital * effectiveLeverage
     *      This leverages the sophisticated capital utilization calculation in getUtilizationInfo.
     * @param user User address
     * @param longVToken The vToken market for the long asset
     * @param shortVToken The vToken market for the short asset
     * @param dsaVToken The vToken market for the DSA asset
     * @return maxBorrowAmount Maximum amount that can be borrowed in shortAsset terms
     */
    function calculateMaxBorrow(
        address user,
        IVToken longVToken,
        IVToken shortVToken,
        IVToken dsaVToken
    ) external returns (uint256 maxBorrowAmount);
}
