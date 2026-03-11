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
        address positionAccount; // Address of the PositionAccount contract (immutable)
        bool isActive; // Whether position is currently active (mutable)
        uint8 dsaIndex; // Index of DSA in dsaVTokens array sets on activation (mutable)
        address dsaVToken; // DSA vToken market address sets on activation (mutable)
        uint256 suppliedPrincipalVTokens; // Total DSA supplied as collateral, in vToken amount (mutable)
        uint256 effectiveLeverage; // Leverage ratio sets on activation (mutable)
        uint256 cycleId; // Current cycle ID, increments on each activation (mutable)
    }

    /// @notice Structure for utilization calculation results
    struct UtilizationInfo {
        uint256 actualCapitalUtilized; // Capital used based on collateral LTV ratios (in USD)
        uint256 nominalCapitalUtilized; // Capital used based on leverage ratio (in USD)
        uint256 finalCapitalUtilized; // Position capital capped by supplied principal (in USD)
        uint256 availableCapitalUSD; // Remaining capital available for borrowing (in USD)
        uint256 withdrawableAmount; // Amount that can be withdrawn in DSA token terms
        uint256 clampedLeverage; // min(storedEffectiveLeverage, currentMaxLeverage) at time of computation
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

    /// @custom:error PositionNotFullyClosed when trying to deactivate a position that still has short debt
    error PositionNotFullyClosed();

    /// @custom:error PartiallyPaused when a risk action is called while partially paused
    error PartiallyPaused();

    /// @custom:error CompletelyPaused when any state-changing function is called while completely paused
    error CompletelyPaused();

    /// @custom:error InvalidDSA when DSA index or address is not valid
    error InvalidDSA();

    /// @custom:error DSAInactive when a DSA vToken is configured but not active for new activations
    error DSAInactive();

    /// @custom:error SameDSAActiveStatus when setDSAVTokenActive is called with the current active flag
    error SameDSAActiveStatus();

    /// @custom:error DSAVTokenAlreadyAdded when trying to add an already configured DSA vToken
    error DSAVTokenAlreadyAdded();

    /// @custom:error InsufficientPrincipal when supplied principal is insufficient
    error InsufficientPrincipal();

    /// @custom:error InvalidLeverage when leverage is invalid (0 or too low or exceeds max)
    error InvalidLeverage();

    /// @custom:error BorrowAmountExceedsMaximum when borrow amount exceeds the calculated maximum based on capital utilization
    error BorrowAmountExceedsMaximum();

    /// @custom:error InsufficientWithdrawableAmount when trying to withdraw more than allowed
    error InsufficientWithdrawableAmount();

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

    /// @custom:error ZeroVTokensMinted when supplied amount rounds down to 0 vTokens due to exchange rate
    /// (e.g., supplying 1 wei when vToken exchange rate > 1e18). Ensure amount is large enough to mint at least 1 vToken.
    error ZeroVTokensMinted();

    /// @custom:error EnterMarketFailed when entering market on behalf fails
    error EnterMarketFailed(uint256 errorCode);

    /// @custom:error ZeroAmount when amount is zero
    error ZeroAmount();

    /// @custom:error ZeroShortAmount when borrow amount is zero
    error ZeroShortAmount();

    /// @custom:error ZeroDebt when there is no short debt to close
    error ZeroDebt();

    /// @custom:error SameMarketNotAllowed when long and short markets are identical
    error SameMarketNotAllowed();

    /// @custom:error MinAmountOutSecondBelowDebt when minAmountOutSecond is less than remaining short debt (second swap)
    error MinAmountOutSecondBelowDebt();

    /// @custom:error MinAmountOutRepayBelowDebt when minAmountOutRepay is less than current short debt
    error MinAmountOutRepayBelowDebt();

    /// @custom:error RedeemBehalfFailed when redeeming vTokens on behalf fails
    /// @param errorCode Error code returned by the vToken redeemUnderlyingBehalf call
    error RedeemBehalfFailed(uint256 errorCode);

    /// @custom:error TokenSwapCallFailed when swap execution via SwapHelper fails
    error TokenSwapCallFailed();

    /// @custom:error SlippageExceeded when swap output is below the minimum required
    error SlippageExceeded();

    /// @custom:error PositionAccountImplementationNotSet when trying to deploy or compute position accounts before implementation is configured
    error PositionAccountImplementationNotSet();

    /// @custom:error PositionAccountImplementationLocked when PositionAccountImplementation is already locked and cannot be changed
    error PositionAccountImplementationLocked();

    /// @custom:error SameProportionalCloseTolerance when setter is called with the current tolerance value
    error SameProportionalCloseTolerance();

    /// @custom:error InvalidProportionalCloseTolerance when tolerance is outside [1, 10000]
    error InvalidProportionalCloseTolerance();

    /// @custom:error ProportionalCloseAmountOutOfTolerance when user-provided close amounts are not within 1% of BPS-derived expected amounts
    error ProportionalCloseAmountOutOfTolerance();

    /// @custom:error InvalidCollateralFactor when a market's collateral factor is configured to be >= 100%
    error InvalidCollateralFactor();

    /// @custom:error InvalidLongAmountToRedeem when proportional close expects zero long (no long to close) but user passed non-zero total long amount
    error InvalidLongAmountToRedeem();

    /// @custom:error InvalidCloseFractionBps when closeFractionBps is not between 1 and 10000 (basis points)
    error InvalidCloseFractionBps();

    /// @custom:error ExcessiveShortDust when short token dust on position account after closeWithLoss exit legs exceeds proportional tolerance of total repaid
    error ExcessiveShortDust();

    /// @notice Emitted when a user activates a position account
    /// @param user Address of the user
    /// @param longAsset Address of the long asset
    /// @param shortAsset Address of the short asset
    /// @param dsaAsset Address of the DSA asset
    /// @param positionAccount Address of the deployed PositionAccount
    /// @param cycleId Current cycle ID of the position (increments on each activation)
    /// @param initialPrincipal Initial principal supplied during activation (required, > 0)
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

    /// @notice Emitted when a position is opened (during activateAndOpenPosition flow)
    /// @param user Address of the user
    /// @param positionAccount Address of the position account
    /// @param cycleId The cycle ID of the position
    /// @param longAsset Address of the long asset
    /// @param shortAsset Address of the short asset
    /// @param dsaAsset Address of the DSA asset
    /// @param shortAmount Amount borrowed in short asset
    /// @param initialPrincipal Initial principal supplied during activation (required, > 0)
    event PositionOpened(
        address indexed user,
        address indexed positionAccount,
        uint256 cycleId,
        address longAsset,
        address shortAsset,
        address dsaAsset,
        uint256 shortAmount,
        uint256 initialPrincipal
    );

    /// @notice Emitted when an existing position is scaled (additional borrow-long added to existing position)
    /// @param user Address of the user
    /// @param positionAccount Address of the position account
    /// @param cycleId The cycle ID of the position
    /// @param longAsset Address of the long asset
    /// @param shortAsset Address of the short asset
    /// @param dsaAsset Address of the DSA asset
    /// @param shortAmount Amount borrowed in short asset
    /// @param additionalPrincipal Additional principal supplied this call (0 if none)
    event PositionScaled(
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
    /// @param closeFractionBps Proportion closed in basis points (10000 = 100%, 1 = 0.01% minimum)
    /// @param amountRepaid Short debt repaid in this close
    /// @param amountRedeemed Long collateral redeemed in this close
    /// @param amountRedeemedDsa DSA amount redeemed in this close (loss close second leg; 0 for profit close)
    /// @param longDustRedeemed Remaining long collateral redeemed and transferred to user on 100% close (0 for partial close)
    event PositionClosed(
        address indexed user,
        address indexed positionAccount,
        uint256 cycleId,
        uint256 closeFractionBps,
        uint256 amountRepaid,
        uint256 amountRedeemed,
        uint256 amountRedeemedDsa,
        uint256 longDustRedeemed
    );

    /// @notice Emitted when long is converted to profit (DSA) during closeWithProfit
    /// @param user Address of the user
    /// @param positionAccount Address of the position account
    /// @param amountConvertedToProfit Long amount redeemed and swapped to DSA as profit (underlying terms)
    /// @param newTotalPrincipal New total principal amount in vTokens after conversion
    event ProfitConverted(
        address indexed user,
        address indexed positionAccount,
        uint256 amountConvertedToProfit,
        uint256 newTotalPrincipal
    );

    /// @notice Emitted when principal is withdrawn
    /// @param user Address of the user
    /// @param positionAccount Address of the position account
    /// @param cycleId The cycle ID of the position
    /// @param dsaAsset Address of the DSA asset
    /// @param amount Amount withdrawn
    /// @param remainingPrincipal Remaining principal after withdrawal
    event PrincipalWithdrawn(
        address indexed user,
        address indexed positionAccount,
        uint256 cycleId,
        address dsaAsset,
        uint256 amount,
        uint256 remainingPrincipal
    );

    /// @notice Emitted when a position is deactivated
    /// @param user Address of the user
    /// @param positionAccount Address of the position account
    /// @param cycleId The cycle ID of the position
    /// @param longRedeemed Amount of long underlying redeemed to user (0 when DSA == long)
    /// @param dsaRedeemed Amount of DSA underlying redeemed to user
    event PositionDeactivated(
        address indexed user,
        address indexed positionAccount,
        uint256 cycleId,
        uint256 longRedeemed,
        uint256 dsaRedeemed
    );

    /// @notice Emitted when underlying tokens are transferred from this contract to a user
    /// @param token Address of the underlying ERC20 token
    /// @param from Account on whose behalf the underlying was redeemed
    /// @param to Recipient address (typically msg.sender)
    /// @param amount Amount of underlying transferred
    event UnderlyingTransferred(address indexed token, address indexed from, address indexed to, uint256 amount);

    /// @notice Emitted when supplied principal is refreshed down to match actual vToken balance (e.g. after liquidation seized vTokens)
    /// @param user Position owner
    /// @param positionAccount Position account whose principal was refreshed
    /// @param oldSuppliedPrincipal Previous suppliedPrincipal (vToken amount)
    /// @param newSuppliedPrincipal New suppliedPrincipal (capped at actual vToken balance)
    event RefreshedSuppliedPrincipal(
        address indexed user,
        address indexed positionAccount,
        uint256 oldSuppliedPrincipal,
        uint256 newSuppliedPrincipal
    );

    /// @notice Emitted when partial pause state is toggled
    /// @param paused New partial pause state
    event PartialPauseToggled(bool paused);

    /// @notice Emitted when complete pause state is toggled
    /// @param paused New complete pause state
    event CompletePauseToggled(bool paused);

    /// @notice Emitted when a new DSA vToken is added
    /// @param dsaVToken Address of the DSA vToken added
    /// @param index Index of the DSA vToken in the array
    event DSAVTokenAdded(address indexed dsaVToken, uint8 index);

    /// @notice Emitted when the active flag for a DSA vToken is updated
    /// @param dsaVToken Address of the DSA vToken
    /// @param index Index of the DSA vToken in the internal mapping
    /// @param active New active flag (true to allow new activations, false to block them)
    event DSAVTokenActiveUpdated(address indexed dsaVToken, uint8 index, bool active);

    /// @notice Emitted when the PositionAccount implementation address is set (can only be set once)
    /// @param implementation PositionAccount implementation address
    event PositionAccountImplementationSet(address indexed implementation);

    /// @notice Emitted when the proportional close tolerance is updated
    /// @param oldTolerance Previous tolerance value (in basis points)
    /// @param newTolerance New tolerance value (in basis points)
    event ProportionalCloseToleranceUpdated(uint256 indexed oldTolerance, uint256 indexed newTolerance);

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
     * @notice Returns the number of configured DSA vTokens (also the next index to assign)
     * @return count Current value of the DSA vToken index counter
     */
    function dsaVTokenIndexCounter() external view returns (uint8 count);

    /**
     * @notice Activates a position and opens it with initial leverage (combined in one transaction)
     * @dev Deploys a new PositionAccount contract if one doesn't exist for this user/asset combination.
     *      Sets up the position with initial principal, then immediately opens/borrows with shortAmount.
     *      Emits both PositionActivated and PositionOpened events.
     * @param longVToken The vToken market address for the asset to long
     * @param shortVToken The vToken market address for the asset to short
     * @param dsaIndex Index of the DSA vToken in the dsaVTokens array
     * @param initialPrincipal Required initial principal amount to supply during activation (must be > 0)
     * @param effectiveLeverage The target leverage ratio for this position (in mantissa, e.g., 2e18 = 2x leverage)
     * @param shortAmount Amount to borrow in shortAsset terms
     * @param minLongAmount Minimum amount of long asset expected from swap
     * @param swapData Swap instructions for converting shortAsset to longAsset
     */
    function activateAndOpenPosition(
        address longVToken,
        address shortVToken,
        uint8 dsaIndex,
        uint256 initialPrincipal,
        uint256 effectiveLeverage,
        uint256 shortAmount,
        uint256 minLongAmount,
        bytes calldata swapData
    ) external;

    /**
     * @notice Supplies additional principal to an active position
     * @dev Can be called multiple times to increase collateral. DSA is taken from the position (set on activation).
     * @param longVToken The vToken market address for the long asset
     * @param shortVToken The vToken market address for the short asset
     * @param amount Amount of DSA underlying to supply
     */
    function supplyPrincipal(address longVToken, address shortVToken, uint256 amount) external;

    /**
     * @notice Scales an existing position by adding additional leverage (borrow + swap to long)
     * @dev Can only be called on an already-active position. Optionally supply additional principal
     *      via additionalPrincipal; otherwise uses existing principal. Validates that shortAmount doesn't
     *      exceed the maximum allowed based on capital utilization. DSA is taken from the position (set during activation).
     *      Emits PositionScaled event to distinguish from initial opening.
     * @param longVToken The vToken market for the asset to long
     * @param shortVToken The vToken market for the asset to short
     * @param additionalPrincipal Additional principal to supply this call (0 if none)
     * @param shortAmount Amount to borrow in shortAsset terms (must not exceed max calculated borrow)
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
     * @notice Closes a position proportionally; can realize profit on the closed slice (partial or full)
     * @dev Repay amount is derived from BPS. Total long validated against BPS (within proportionalCloseTolerance).
     * minAmountOutRepay must be >= calculated repay.
     * @param longVToken The vToken market for the long asset
     * @param shortVToken The vToken market for the short asset
     * @param closeFractionBps Proportion to close in basis points (10000 = 100%, 1 = 0.01% minimum)
     * @param longAmountToRedeemForRepay Amount of long to redeem for the repay leg (validated against BPS)
     * @param minAmountOutRepay Minimum short out from the repay swap (must be >= calculated repay amount for this BPS)
     * @param swapDataRepay Swap #1: long → short for debt repayment
     * @param longAmountToRedeemForProfit Amount of long to redeem and swap long→DSA as profit (can be non-zero for partial or full close)
     * @param minAmountOutProfit Minimum DSA out from the profit swap
     * @param swapDataProfit Swap #2: long → DSA for profit realization
     */
    function closeWithProfit(
        IVToken longVToken,
        IVToken shortVToken,
        uint256 closeFractionBps,
        uint256 longAmountToRedeemForRepay,
        uint256 minAmountOutRepay,
        bytes calldata swapDataRepay,
        uint256 longAmountToRedeemForProfit,
        uint256 minAmountOutProfit,
        bytes calldata swapDataProfit
    ) external;

    /**
     * @notice Closes a position with loss proportionally
     * @dev closeFractionBps: 10000 = 100%, 1 = 0.01% min. First-exit long is proportion-derived; short repay in [0, expectedShort].
     *      First exit long→short, second exit DSA→short for remainder. Position fully closed.
     * @param longVToken The vToken market for the long asset
     * @param shortVToken The vToken market for the short asset
     * @param closeFractionBps Proportion to close in basis points (10000 = 100%, 1 = 0.01% minimum)
     * @param longAmountToRedeemForFirstSwap Long to redeem for first swap (validated against BPS within proportionalCloseTolerance)
     * @param shortAmountToRepayForFirstSwap Short to repay in first exit (0 <= value <= BPS-derived expected short)
     * @param minAmountOutFirst Minimum amount out from first swap (must be >= borrowedAmountToRepayFirst when first repay > 0)
     * @param swapDataFirst Calldata for first swap (long → short)
     * @param dsaAmountToRedeemForSecondSwap DSA to redeem for second exit repay
     * @param minAmountOutSecond Minimum amount out from second swap
     * @param swapDataSecond Calldata for second swap (DSA → short)
     */
    function closeWithLoss(
        IVToken longVToken,
        IVToken shortVToken,
        uint256 closeFractionBps,
        uint256 longAmountToRedeemForFirstSwap,
        uint256 shortAmountToRepayForFirstSwap,
        uint256 minAmountOutFirst,
        bytes calldata swapDataFirst,
        uint256 dsaAmountToRedeemForSecondSwap,
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
     * @dev Redeems any remaining long collateral and DSA principal to the user, then deactivates.
     *      Reverts if short debt remains. User can activate with new DSA later.
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
     * @notice Returns the full list of configured DSA vToken markets
     * @dev Convenience helper for frontends; underlying storage is the public dsaVTokens array.
     * @return dsaVTokensList Array of DSA vToken addresses
     */
    function getDsaVTokens() external view returns (address[] memory dsaVTokensList);

    /**
     * @notice Updates the active flag for a configured DSA vToken, controlling whether it can be used for new activations
     * @dev Callable only by accounts with ACM permission for setDSAVTokenActive(uint8,bool).
     *      Does not affect already active positions, which may continue to close or withdraw principal.
     * @param dsaIndex Index of the DSA vToken in the internal mapping
     * @param active New active flag (true to allow new activations, false to block them)
     */
    function setDSAVTokenActive(uint8 dsaIndex, bool active) external;

    /**
     * @notice Returns the address at which the PositionAccount would be deployed for the given user and markets
     * @dev Same salt as used when deploying via activateAndOpenPosition (keccak256(user, longVToken, shortVToken)).
     *      Returns the address that cloneDeterministic would deploy to if called by this contract.
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
     * @notice Sets the proportional close tolerance (in basis points)
     * @dev Callable only by governance via AccessControlManager. 100 bps = 1%.
     * @param newTolerance New tolerance value in basis points
     */
    function setProportionalCloseTolerance(uint256 newTolerance) external;

    /**
     * @notice Returns the position data for a user and asset pair
     * @param user User address
     * @param longVToken The vToken market for the long asset
     * @param shortVToken The vToken market for the short asset
     * @return position The Position struct (user, longVToken, shortVToken, positionAccount, isActive, dsaIndex, dsaVToken, suppliedPrincipalVTokens, effectiveLeverage, cycleId)
     */
    function getPosition(
        address user,
        IVToken longVToken,
        IVToken shortVToken
    ) external view returns (Position memory position);

    /**
     * @notice Returns the actual long collateral balance in underlying for a given user/position,
     *         excluding DSA principal when the DSA and long assets share the same vToken market.
     * @param user The position owner
     * @param longVToken The vToken market for the long asset
     * @param shortVToken The vToken market for the short asset
     * @return longBalance The long collateral balance in underlying units (principal excluded when shared market)
     */
    function getLongCollateralBalance(
        address user,
        IVToken longVToken,
        IVToken shortVToken
    ) external returns (uint256 longBalance);

    /**
     * @notice Returns the supplied principal balance in underlying units for a given user/position
     * @param user The position owner
     * @param longVToken The vToken market for the long asset
     * @param shortVToken The vToken market for the short asset
     * @return balance The supplied principal in underlying units
     */
    function getSuppliedPrincipalBalance(
        address user,
        IVToken longVToken,
        IVToken shortVToken
    ) external returns (uint256 balance);

    /**
     * @notice Executes multiple generic calls on behalf of a position account
     * @dev Callable by governance, Allows operations like emergency fund rescues.
     * @param positionAccount Address of the position account
     * @param targets Array of target contract addresses
     * @param data Array of encoded function call data
     */
    function executePositionAccountCall(
        address positionAccount,
        address[] calldata targets,
        bytes[] calldata data
    ) external;

    /**
     * @notice Partially pauses the manager — blocks risk-increasing operations (open, scale, withdraw, deactivate)
     *         while allowing defensive operations (close, supply principal).
     * @dev Callable only by governance via AccessControlManager.
     */
    function partialPause() external;

    /**
     * @notice Removes partial pause, re-enabling risk operations (unless completely paused).
     * @dev Callable only by governance via AccessControlManager.
     */
    function partialUnpause() external;

    /**
     * @notice Completely pauses all state-changing user operations on the manager.
     * @dev Callable only by governance via AccessControlManager. Blocks all user operations including close and supply.
     */
    function completePause() external;

    /**
     * @notice Removes complete pause, re-enabling all operations (unless partially paused).
     * @dev Callable only by governance via AccessControlManager.
     */
    function completeUnpause() external;

    /**
     * @notice Calculates capital utilization for a position
     * @dev Computes how much capital is being used vs available:
     *      1. Calculates actual capital utilized (based on collateral LTV ratios)
     *      2. Calculates nominal capital utilized (based on leverage ratio)
     *      3. Takes max (more conservative estimate)
     *      4. Caps by supplied principal
     *      5. Calculates available capital remaining
     *      6. Calculates withdrawable amount in DSA token terms
     *      Used by getAvailableShortCapacity to determine maximum borrowing capacity. DSA is read from the position.
     * @param user User address
     * @param longVToken The vToken market for the long asset
     * @param shortVToken The vToken market for the short asset
     * @return utilization Utilization information including available capital and withdrawable amount
     */
    function getUtilizationInfo(
        address user,
        IVToken longVToken,
        IVToken shortVToken
    ) external returns (UtilizationInfo memory utilization);

    /**
     * @notice Returns the remaining short borrow capacity for a position under current market conditions
     * @dev Computes availableCapitalUSD via getUtilizationInfo (which uses live CFs), then applies:
     *      clampedLeverage = min(storedEffectiveLeverage, currentMaxLeverageAllowed)
     *      maxBorrow = (availableCapitalUSD * clampedLeverage) / shortPrice
     *      The leverage clamp ensures that any post-activation CF reduction is reflected immediately —
     *      the stored leverage is never applied beyond what current CFs permit.
     * @param user User address
     * @param longVToken The vToken market for the long asset
     * @param shortVToken The vToken market for the short asset
     * @return availableCapacity Remaining borrow capacity in short asset terms
     */
    function getAvailableShortCapacity(
        address user,
        IVToken longVToken,
        IVToken shortVToken
    ) external returns (uint256 availableCapacity);

    /**
     * @notice Returns the maximum allowed leverage for a given DSA/long market pair based on current collateral factors
     * @dev maxLeverage = CF_dsa / (1 - CF_long * (1 - proportionalCloseTolerance))
     *      Reverts with InvalidCollateralFactor if either CF >= 1 or the denominator is zero.
     * @param dsaVToken The DSA vToken market (CF_dsa used as collateral)
     * @param longVToken The long asset vToken market (CF_long used as hedge coverage)
     * @return maxLeverage The maximum leverage ratio (1e18 mantissa)
     */
    function getMaxLeverageAllowed(IVToken dsaVToken, address longVToken) external view returns (uint256 maxLeverage);
}
