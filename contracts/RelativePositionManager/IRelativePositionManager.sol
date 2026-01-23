// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

import { IVToken } from "../Interfaces.sol";
import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";

/**
 * @title IRelativePositionManager
 * @author Venus Protocol
 * @notice Interface for the Relative Position Manager contract
 * @dev This contract manages isolated leveraged positions using 3-token logic (DSA + Long + Short)
 *      where positions are opened on behalf of PositionAccount contracts deployed per user per position pair.
 */
interface IRelativePositionManager {
    /// @notice Structure representing a user's position
    /// @dev Immutable fields are set once during PositionAccount deployment
    struct Position {
        address user; // User who owns this position (immutable)
        address longAsset; // Asset being longed (immutable)
        address shortAsset; // Asset being shorted (immutable)
        uint8 dsaIndex; // Index of DSA in dsaVTokens array (immutable)
        address positionAccount; // Address of the PositionAccount contract (immutable)
        uint256 suppliedPrincipal; // Total DSA supplied as collateral (mutable)
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

    /// @custom:error PositionAlreadyExists when user tries to activate an already active position
    error PositionAlreadyExists();

    /// @custom:error PositionNotActive when trying to operate on inactive position
    error PositionNotActive();

    /// @custom:error PositionNotFullyClosed when trying to deactivate a position that still has collateral or debt
    error PositionNotFullyClosed();

    /// @custom:error InvalidDSA when DSA asset is not valid
    error InvalidDSA();

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
    error MintBehalfFailed();

    /// @custom:error EnterMarketFailed when entering market on behalf fails
    error EnterMarketFailed();

    /// @custom:error ZeroAmount when amount is zero
    error ZeroAmount();

    /// @custom:error ZeroBorrowAmount when borrow amount is zero
    error ZeroBorrowAmount();

    /// @custom:error ZeroFlashLoanAmount when flash loan amount is zero
    error ZeroFlashLoanAmount();

    /// @custom:error ExitMarketFailed when exiting market fails
    error ExitMarketFailed();

    /// @custom:error RedeemBehalfFailed when redeeming vTokens on behalf fails
    error RedeemBehalfFailed();

    /// @notice Emitted when a user activates a position account
    /// @param user Address of the user
    /// @param longAsset Address of the long asset
    /// @param shortAsset Address of the short asset
    /// @param dsaAsset Address of the DSA asset
    /// @param positionAccount Address of the deployed PositionAccount
    /// @param initialPrincipal Initial principal supplied (optional)
    /// @param desiredLeverage Target leverage ratio for the position
    event PositionActivated(
        address indexed user,
        address indexed longAsset,
        address indexed shortAsset,
        address dsaAsset,
        address positionAccount,
        uint256 cycleId,
        uint256 initialPrincipal,
        uint256 desiredLeverage
    );

    /// @notice Emitted when a user supplies additional principal
    /// @param user Address of the user
    /// @param positionAccount Address of the position account
    /// @param dsaAsset Address of the DSA asset
    /// @param amount Amount supplied
    /// @param newTotalPrincipal New total principal amount
    event PrincipalSupplied(
        address indexed user,
        address indexed positionAccount,
        address dsaAsset,
        uint256 amount,
        uint256 newTotalPrincipal
    );

    /// @notice Emitted when a position is opened
    /// @param user Address of the user
    /// @param positionAccount Address of the position account
    /// @param longAsset Address of the long asset
    /// @param shortAsset Address of the short asset
    /// @param dsaAsset Address of the DSA asset
    /// @param shortAmount Amount borrowed in short asset
    /// @param effectiveLeverage Leverage ratio set for this position
    event PositionOpened(
        address indexed user,
        address indexed positionAccount,
        uint256 cycleId,
        address longAsset,
        address shortAsset,
        address dsaAsset,
        uint256 shortAmount,
        uint256 effectiveLeverage
    );

    /// @notice Emitted when a position is scaled (additional principal supplied)
    /// @param user Address of the user
    /// @param positionAccount Address of the position account
    /// @param additionalPrincipal Additional principal supplied
    /// @param newTotalPrincipal New total principal amount
    event PositionScaled(
        address indexed user,
        address indexed positionAccount,
        uint256 cycleId,
        uint256 additionalPrincipal,
        uint256 newTotalPrincipal
    );

    /// @notice Emitted when a position is closed (partially or fully)
    /// @param user Address of the user
    /// @param positionAccount Address of the position account
    /// @param cycleId The cycle ID of the position
    event PositionClosed(address indexed user, address indexed positionAccount, uint256 cycleId);

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

    /**
     * @notice Activates a position account for the user with specified asset pair and DSA
     * @dev Deploys a new PositionAccount contract if one doesn't exist for this user/asset combination.
     *      The desired leverage must be set during activation and will be used to validate borrow amounts
     *      in openPosition and scalePosition operations.
     * @param longAsset The vToken market address for the asset to long
     * @param shortAsset The vToken market address for the asset to short
     * @param dsaIndex Index of the DSA vToken in the dsaVTokens array
     * @param initialPrincipal Optional initial principal amount to supply
     * @param desiredLeverage The target leverage ratio for this position (in mantissa, e.g., 2e18 = 2x leverage)
     */
    function activatePosition(
        address longAsset,
        address shortAsset,
        uint8 dsaIndex,
        uint256 initialPrincipal,
        uint256 desiredLeverage
    ) external;

    /**
     * @notice Supplies additional principal to an active position
     * @dev Can be called multiple times to increase collateral. If position is open, this scales the position.
     *      Validates that the provided DSA index matches the position's configured DSA.
     * @param longAsset The vToken market address for the long asset
     * @param shortAsset The vToken market address for the short asset
     * @param dsaIndex Index of the DSA vToken in the dsaVTokens array
     * @param amount Amount of DSA underlying to supply
     */
    function supplyPrincipal(address longAsset, address shortAsset, uint8 dsaIndex, uint256 amount) external;

    /**
     * @notice Opens a leveraged position using the supplied principal
     * @dev Validates that the shortAmount doesn't exceed the maximum allowed based on capital utilization.
     *      Uses sophisticated calculation considering:
     *      - Actual capital utilized (based on collateral LTV ratios)
     *      - Nominal capital utilized (based on leverage ratio)
     *      - Available capital remaining
     *      Maximum borrow = available capital * effective leverage
     *      Internally calls LeverageManager.enterLeverage with appropriate parameters.
     *      The DSA asset is retrieved from the position data (set during activation).
     * @param longVToken The vToken market for the asset to long
     * @param shortVToken The vToken market for the asset to short
     * @param shortAmount Amount to borrow in shortAsset terms (must not exceed max calculated borrow)
     * @param minLongAmount Minimum amount of long asset expected from swap (protects against slippage)
     * @param swapData Swap instructions for converting shortAsset to longAsset
     */
    function openPosition(
        IVToken longVToken,
        IVToken shortVToken,
        uint256 shortAmount,
        uint256 minLongAmount,
        bytes calldata swapData
    ) external;

    /**
     * @notice Scales an existing position while maintaining the same leverage ratio
     * @dev Validates that shortAmount doesn't exceed the maximum allowed based on capital utilization.
     *      Uses sophisticated calculation considering current position state, collateral ratios, and available capital.
     *      Maximum borrow = available capital * effective leverage
     *      This ensures safe position scaling without excessive risk.
     *      The DSA asset is retrieved from the position data (set during activation).
     * @param longVToken The vToken market for the long asset
     * @param shortVToken The vToken market for the short asset
     * @param additionalPrincipal Additional principal to supply
     * @param shortAmount Additional amount to borrow (must not exceed max calculated borrow)
     * @param minLongAmount Minimum amount of long asset expected from swap (protects against slippage)
     * @param swapData Swap instructions for converting shortAsset to longAsset
     */
    function scalePosition(
        IVToken longVToken,
        IVToken shortVToken,
        uint256 additionalPrincipal,
        uint256 shortAmount,
        uint256 minLongAmount,
        bytes calldata swapData
    ) external;

    /**
     * @notice Closes a position partially or fully
     * @dev Supports partial closing. Validates that remaining leverage doesn't exceed desired leverage.
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
     * @param longAsset The vToken market address for the long asset
     * @param shortAsset The vToken market address for the short asset
     */
    function deactivatePosition(address longAsset, address shortAsset) external;

    /**
     * @notice Adds a new DSA vToken to the supported list
     * @dev Index will be the current length of the array.
     *      TODO: Add ACM-based access control here
     * @param dsaVToken The vToken market address to add as a supported DSA
     */
    function addDSAVToken(address dsaVToken) external;

    /**
     * @notice Returns the total number of supported DSA vTokens
     * @return count The number of DSA vTokens in the array
     */
    function getDSAVTokensCount() external view returns (uint256 count);

    /**
     * @notice Executes an arbitrary call on behalf of a position account
     * @dev Allows privileged operations like emergency fund rescue or contract migrations.
     *      TODO: Integrate with Access Control Manager (ACM) for granular permission control
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
