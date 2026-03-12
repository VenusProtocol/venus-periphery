// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import {
    SafeERC20Upgradeable,
    IERC20Upgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import { ClonesUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/ClonesUpgradeable.sol";
import { AccessControlledV8 } from "@venusprotocol/governance-contracts/contracts/Governance/AccessControlledV8.sol";
import { IVToken, IComptroller } from "../Interfaces.sol";
import { ResilientOracleInterface } from "@venusprotocol/oracle/contracts/interfaces/OracleInterface.sol";
import { LeverageStrategiesManager } from "../LeverageManager/LeverageStrategiesManager.sol";
import { IRelativePositionManager } from "./IRelativePositionManager.sol";
import { IPositionAccount } from "./IPositionAccount.sol";

/**
 * @title RelativePositionManager
 * @author Venus Protocol
 * @notice Contract for managing isolated leveraged positions with relative price trading interface
 * @dev This contract provides a simplified interface for users to open positions that feel like
 *      trading relative prices rather than traditional leverage. Uses 3-token logic (DSA + Long + Short)
 *      and deploys isolated PositionAccount contracts for each position.
 */
contract RelativePositionManager is AccessControlledV8, ReentrancyGuardUpgradeable, IRelativePositionManager {
    using SafeERC20Upgradeable for IERC20Upgradeable;

    /// @dev Success return value for Comptroller operations (e.g. enterMarketBehalf)
    uint256 private constant SUCCESS = 0;

    /// @dev Mantissa for fixed-point arithmetic (MANTISSA_ONE = 100%)
    uint256 private constant MANTISSA_ONE = 1e18;

    /// @dev Minimum leverage ratio (1x)
    uint256 private constant MIN_LEVERAGE = MANTISSA_ONE;

    /// @dev Proportional close in basis points: 10000 = 100%, 1 = 0.01% minimum
    uint256 private constant PROPORTIONAL_CLOSE_MIN = 1; // 0.01%
    uint256 private constant PROPORTIONAL_CLOSE_MAX = 10000; // 100%

    /// @notice The Venus comptroller contract
    IComptroller public immutable COMPTROLLER;

    /// @notice The leverage strategies manager contract
    LeverageStrategiesManager public immutable LEVERAGE_MANAGER;

    /// @notice Tolerance for proportional close (in basis points): 100 = 1% margin of error (governance-controlled)
    uint256 public proportionalCloseTolerance;

    /// @notice Implementation contract for PositionAccount clones (settable via governance, can only be set once)
    address public POSITION_ACCOUNT_IMPLEMENTATION;

    /// @notice Lock flag to prevent changing POSITION_ACCOUNT_IMPLEMENTATION after it's set
    bool public isPositionAccountImplementationLocked;

    /// @notice Counter / next index for newly added DSA vTokens (also equals current count)
    uint8 public dsaVTokenIndexCounter;

    /// @notice Whether the contract is partially paused (blocks open, scale, withdraw, deactivate but allows close and supply)
    bool public isPartiallyPaused;

    /// @notice Whether the contract is completely paused (blocks all state-changing user operations)
    bool public isCompletelyPaused;

    /// @notice Mapping from DSA index to supported DSA (Default Settlement Asset) vToken markets
    mapping(uint8 => address) public dsaVTokens;

    /// @notice Tracks whether a given DSA vToken is currently active for new activations
    mapping(address => bool) public isDsaVTokenActive;

    /// @notice Mapping from user => longAsset => shortAsset => Position data
    mapping(address => mapping(address => mapping(address => Position))) public positions;

    /**
     * @dev This empty reserved space is put in place to allow future versions to add new
     * variables without shifting down storage in the inheritance chain.
     * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
     */
    uint256[44] private __gap;

    /**
     * @notice Contract constructor
     * @param comptroller The Venus Comptroller contract address
     * @param leverageManager The LeverageStrategiesManager contract address (provides swap helper for enter/exit leverage)
     * @custom:oz-upgrades-unsafe-allow constructor
     */
    constructor(address comptroller, address leverageManager) {
        if (comptroller == address(0) || leverageManager == address(0)) {
            revert ZeroAddress();
        }

        COMPTROLLER = IComptroller(comptroller);
        LEVERAGE_MANAGER = LeverageStrategiesManager(leverageManager);

        _disableInitializers();
    }

    /**
     * @notice Initializes the upgradeable contract
     * @param accessControlManager_ Address of the Access Control Manager contract
     */
    function initialize(address accessControlManager_) external initializer {
        __AccessControlled_init(accessControlManager_);
        __ReentrancyGuard_init();
        proportionalCloseTolerance = 100; // 1% default tolerance
    }

    /// @dev Reverts if partially or completely paused
    modifier whenNotPaused() {
        if (isPartiallyPaused) revert PartiallyPaused();
        if (isCompletelyPaused) revert CompletelyPaused();
        _;
    }

    /// @dev Reverts if completely paused
    modifier whenNotCompletelyPaused() {
        if (isCompletelyPaused) revert CompletelyPaused();
        _;
    }

    /**
     * @notice Partially pauses the manager — blocks risk-increasing operations (open, scale, withdraw, deactivate)
     *         while allowing defensive operations (close, supply principal).
     * @dev Callable only by governance via AccessControlManager.
     */
    function partialPause() external {
        _checkAccessAllowed("partialPause()");
        isPartiallyPaused = true;
        emit PartialPauseToggled(true);
    }

    /**
     * @notice Removes partial pause, re-enabling risk operations (unless completely paused).
     * @dev Callable only by governance via AccessControlManager.
     */
    function partialUnpause() external {
        _checkAccessAllowed("partialUnpause()");
        isPartiallyPaused = false;
        emit PartialPauseToggled(false);
    }

    /**
     * @notice Completely pauses all state-changing user operations on the manager
     * @dev Callable only by governance via AccessControlManager. View and admin functions remain available.
     */
    function completePause() external {
        _checkAccessAllowed("completePause()");
        isCompletelyPaused = true;
        emit CompletePauseToggled(true);
    }

    /**
     * @notice Removes complete pause, re-enabling all operations (unless partially paused).
     * @dev Callable only by governance via AccessControlManager.
     */
    function completeUnpause() external {
        _checkAccessAllowed("completeUnpause()");
        isCompletelyPaused = false;
        emit CompletePauseToggled(false);
    }

    /**
     * @notice Sets the implementation contract used for PositionAccount clones (can be set only once)
     * @dev Callable only by governance via AccessControlManager. Must be set before any positions are activated.
     *      Due to circular RPM-PA dependency, cannot make POSITION_ACCOUNT_IMPLEMENTATION immutable.
     *      Instead, a lock flag prevents changes after initial setup, achieving the same effect.
     * @param positionAccountImpl Implementation contract for PositionAccount EIP-1167 clones
     * @custom:error Throw ZeroAddress if positionAccountImpl is zero.
     * @custom:error Throw PositionAccountImplementationLocked if already set.
     * @custom:event Emits PositionAccountImplementationSet event.
     */
    function setPositionAccountImplementation(address positionAccountImpl) external {
        _checkAccessAllowed("setPositionAccountImplementation(address)");

        if (isPositionAccountImplementationLocked) revert PositionAccountImplementationLocked();
        if (positionAccountImpl == address(0)) revert ZeroAddress();

        isPositionAccountImplementationLocked = true;
        POSITION_ACCOUNT_IMPLEMENTATION = positionAccountImpl;
        emit PositionAccountImplementationSet(positionAccountImpl);
    }

    /**
     * @notice Sets the proportional close tolerance (in basis points)
     * @dev Callable only by governance via AccessControlManager. 100 bps = 1%.
     * @param newTolerance New tolerance value in basis points
     * @custom:error Throw InvalidProportionalCloseTolerance if tolerance is outside [1, 10000].
     * @custom:error Throw SameProportionalCloseTolerance if tolerance is unchanged.
     * @custom:event Emits ProportionalCloseToleranceUpdated event.
     */
    function setProportionalCloseTolerance(uint256 newTolerance) external {
        _checkAccessAllowed("setProportionalCloseTolerance(uint256)");
        if (newTolerance < PROPORTIONAL_CLOSE_MIN || newTolerance > PROPORTIONAL_CLOSE_MAX)
            revert InvalidProportionalCloseTolerance();

        uint256 oldTolerance = proportionalCloseTolerance;
        if (oldTolerance == newTolerance) revert SameProportionalCloseTolerance();

        proportionalCloseTolerance = newTolerance;
        emit ProportionalCloseToleranceUpdated(oldTolerance, newTolerance);
    }

    /**
     * @notice Adds a new DSA vToken to the supported list
     * @dev Index will be the current length of the array. Callable only by Governance.
     * @param dsaVToken The vToken market address to add as a supported DSA
     * @custom:error Throw ZeroAddress if dsaVToken is zero.
     * @custom:error Throw AssetNotListed if the market is not listed in the Comptroller.
     * @custom:error Throw DSAVTokenAlreadyAdded if the DSA vToken is already configured.
     * @custom:event Emits DSAVTokenAdded event.
     */
    function addDSAVToken(address dsaVToken) external {
        _checkAccessAllowed("addDSAVToken(address)");
        _checkMarketListed(dsaVToken);

        // Revert if this DSA vToken is already configured
        uint8 currentCount = dsaVTokenIndexCounter;
        for (uint8 i = 0; i < currentCount; ++i) {
            if (dsaVTokens[i] == dsaVToken) {
                revert DSAVTokenAlreadyAdded();
            }
        }

        dsaVTokens[currentCount] = dsaVToken;
        isDsaVTokenActive[dsaVToken] = true;
        dsaVTokenIndexCounter = currentCount + 1;

        emit DSAVTokenAdded(dsaVToken, currentCount);
    }

    /**
     * @notice Updates the active flag for a configured DSA vToken, controlling whether it can be used for new activations
     * @dev Callable only by governance via AccessControlManager. Does not affect already active positions,
     *      which may continue to close or withdraw principal using the previously selected DSA.
     * @param dsaIndex Index of the DSA vToken in the internal mapping
     * @param active New active flag (true to allow new activations, false to block them)
     * @custom:error Throw InvalidDSA if the index or stored address is invalid.
     * @custom:error Throw SameDSAActiveStatus when called with the current active flag.
     * @custom:event Emits DSAVTokenActiveUpdated when the active flag is changed.
     */
    function setDSAVTokenActive(uint8 dsaIndex, bool active) external {
        _checkAccessAllowed("setDSAVTokenActive(uint8,bool)");
        if (dsaIndex >= dsaVTokenIndexCounter) revert InvalidDSA();
        address dsaVToken = dsaVTokens[dsaIndex];
        if (dsaVToken == address(0)) revert InvalidDSA();
        if (isDsaVTokenActive[dsaVToken] == active) revert SameDSAActiveStatus();
        isDsaVTokenActive[dsaVToken] = active;
        emit DSAVTokenActiveUpdated(dsaVToken, dsaIndex, active);
    }

    /**
     * @notice Executes multiple generic calls on behalf of a position account
     * @dev Callable by governance via AccessControlManager. Intended for emergency or administrative actions.
     * @param positionAccount Address of the position account
     * @param targets Array of target contract addresses
     * @param data Array of encoded function call data
     */
    function executePositionAccountCall(
        address positionAccount,
        address[] calldata targets,
        bytes[] calldata data
    ) external nonReentrant {
        _checkAccessAllowed("executePositionAccountCall(address,address[],bytes[])");
        IPositionAccount(positionAccount).genericCalls(targets, data);
    }

    /**
     * @notice Opens a leveraged position for the first time (combines activation + opening in one call)
     * @dev Runs _activatePosition flow first, then _openPosition flow. Deploys a new PositionAccount contract
     *      if one doesn't exist for this user/asset combination. Supplies required initial principal during activation,
     *      then immediately opens/borrows with shortAmount. Emits both PositionActivated and PositionOpened events.
     * @param longVToken The vToken market address for the asset to long
     * @param shortVToken The vToken market address for the asset to short
     * @param dsaIndex Index of the DSA vToken in the dsaVTokens array
     * @param initialPrincipal Required initial principal amount to supply during activation (must be > 0)
     * @param effectiveLeverage The target leverage ratio for this position (in mantissa, e.g., 2e18 = 2x leverage)
     * @param shortAmount Amount to borrow in shortAsset terms
     * @param minLongAmount Minimum amount of long asset expected from swap
     * @param swapData Swap instructions for converting shortAsset to longAsset
     * @custom:error Throw InsufficientPrincipal if initialPrincipal is zero.
     * @custom:error Throw ZeroAddress if longVToken or shortVToken is zero.
     * @custom:error Throw SameMarketNotAllowed if long and short vTokens are identical.
     * @custom:error Throw AssetNotListed if a market is not listed.
     * @custom:error Throw InvalidDSA if dsaIndex is not Valid, or DSAInactive if the DSA is inactive.
     * @custom:error Throw InvalidLeverage if effectiveLeverage is out of range.
     * @custom:error Throw PositionAlreadyExists if the position is already active.
     * @custom:error Throw EnterMarketFailed if entering the DSA market on behalf fails.
     * @custom:error Throw MintBehalfFailed if minting initialPrincipal fails.
     * @custom:error Throw ZeroVTokensMinted if initialPrincipal rounds down to 0 vTokens due to exchange rate.
     * @custom:error Throw ZeroShortAmount if shortAmount is zero.
     * @custom:error Throw InvalidOraclePrice if pricing data is unavailable while computing borrow limits.
     * @custom:error Throw BorrowAmountExceedsMaximum if shortAmount exceeds max allowed borrow.
     * @custom:event Emits PositionAccountDeployed (if new account), PositionActivated, PrincipalSupplied, and PositionOpened.
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
    ) external nonReentrant whenNotPaused {
        _activatePosition(longVToken, shortVToken, dsaIndex, initialPrincipal, effectiveLeverage);
        _openPosition(IVToken(longVToken), IVToken(shortVToken), 0, shortAmount, minLongAmount, swapData);

        Position storage position = positions[msg.sender][longVToken][shortVToken];
        emit PositionOpened(
            msg.sender,
            position.positionAccount,
            position.cycleId,
            longVToken,
            shortVToken,
            position.dsaVToken,
            shortAmount,
            initialPrincipal
        );
    }

    /**
     * @notice Scales an existing position by adding additional leverage (borrow + swap to long)
     * @dev Can only be called on an already-active position. Optionally supply additional principal
     *      via additionalPrincipal; otherwise uses existing principal. Validates that shortAmount doesn't
     *      exceed the maximum allowed based on capital utilization.
     * @param longVToken The vToken market for the asset to long
     * @param shortVToken The vToken market for the asset to short
     * @param additionalPrincipal Additional principal to supply this call (0 if none)
     * @param shortAmount Amount to borrow in shortAsset terms (must not exceed max calculated borrow)
     * @param minLongAmount Minimum amount of long asset expected from swap (protects against slippage)
     * @param swapData Swap instructions for converting shortAsset to longAsset
     * @custom:error Throw ZeroShortAmount if shortAmount is zero.
     * @custom:error Throw PositionNotActive if the position is not active.
     * @custom:error Throw MintBehalfFailed if additionalPrincipal minting on behalf fails.
     * @custom:error Throw ZeroVTokensMinted if additionalPrincipal rounds down to 0 vTokens if Minted.
     * @custom:error Throw InvalidOraclePrice if pricing data is unavailable while computing borrow limits.
     * @custom:error Throw BorrowAmountExceedsMaximum if shortAmount exceeds max allowed borrow.
     * @custom:event Emits PositionScaled event (and PrincipalSupplied if additionalPrincipal > 0).
     */
    function scalePosition(
        IVToken longVToken,
        IVToken shortVToken,
        uint256 additionalPrincipal,
        uint256 shortAmount,
        uint256 minLongAmount,
        bytes calldata swapData
    ) external nonReentrant whenNotPaused {
        _openPosition(longVToken, shortVToken, additionalPrincipal, shortAmount, minLongAmount, swapData);

        Position storage position = positions[msg.sender][address(longVToken)][address(shortVToken)];
        emit PositionScaled(
            msg.sender,
            position.positionAccount,
            position.cycleId,
            address(longVToken),
            address(shortVToken),
            position.dsaVToken,
            shortAmount,
            additionalPrincipal
        );
    }

    /**
     * @notice Supplies additional principal to an active position
     * @dev Can be called multiple times to increase collateral. DSA is taken from the position (set on activation).
     *      External transfers to PositionAccount are not included in the design.
     *      All transfers to PositionAccount must be routed through this RPM contract only.
     * @param longVToken The vToken market address for the long asset
     * @param shortVToken The vToken market address for the short asset
     * @param amount Amount of DSA underlying to supply (must be large enough to mint at least 1 vToken)
     * @custom:error Throw ZeroAmount if amount is zero.
     * @custom:error Throw PositionNotActive if the position is not active.
     * @custom:error Throw MintBehalfFailed if minting supplied principal on behalf fails.
     * @custom:error Throw ZeroVTokensMinted if supplied amount rounds down to 0 vTokens Minted.
     * @custom:event Emits PrincipalSupplied event.
     */
    function supplyPrincipal(
        address longVToken,
        address shortVToken,
        uint256 amount
    ) external nonReentrant whenNotCompletelyPaused {
        if (amount == 0) revert ZeroAmount();
        Position storage position = _getActivePosition(msg.sender, longVToken, shortVToken);
        _supplyPrincipalToPositionAccount(position, IVToken(position.dsaVToken), amount);
    }

    /**
     * @notice Closes a position proportionally; can realize profit on the closed slice (partial or full).
     *         If treasuryPercent is enabled, the LM redeems more than the requested long amount on behalf
     *         of the position account to cover the fee; callers should reduce redeem amounts accordingly
     *         to avoid exceeding the available collateral bucket and causing a revert.
     * @dev 1) Repay is derived from closeFractionBps (not passed directly), and total long
     *         used (repay + profit) must stay within proportionalCloseTolerance to absorb
     *         execution variance such as swap slippage and flash-loan fees.
     *      2) minAmountOutRepay must fully cover the repay debt required at execution time; for a
     *         100% close, a small extra buffer is sufficient (it does not need to match the internal
     *         tolerance bump exactly.
     *      3) This function does not directly move DSA principal; unused principal remains on
     *         the position account and can be withdrawn later or swept on deactivation.
     * @param longVToken The vToken market for the long asset
     * @param shortVToken The vToken market for the short asset
     * @param closeFractionBps Proportion to close in basis points (10000 = 100%, 1 = 0.01% minimum)
     * @param longAmountToRedeemForRepay Amount of long to redeem for the repay leg (validated against BPS)
     * @param minAmountOutRepay Minimum short Amount expected from repay swap; must be >= required repay amount for the given BPS.
     *        Should Include flash-loan fees and (for 100% close) include internal tolerance buffer.
     * @param swapDataRepay Swap #1: long → short for debt repayment
     * @param longAmountToRedeemForProfit Amount of long to redeem and swap long→DSA as profit (can be non-zero for partial or full close)
     * @param minAmountOutProfit Minimum DSA out from the profit swap used for slippage protection
     * @param swapDataProfit Swap #2: long → DSA for profit realization
     * @custom:error Throw PositionNotActive if the position is not active.
     * @custom:error Throw InvalidCloseFractionBps if closeFractionBps is not between 1 and 10000.
     * @custom:error Throw InvalidLongAmountToRedeem if total long to redeem is invalid for the chosen BPS.
     * @custom:error Throw MinAmountOutRepayBelowDebt if minAmountOutRepay is below the calculated short debt for this close.
     * @custom:error Throw ProportionalCloseAmountOutOfTolerance if total long amounts are not within the tolerated BPS band.
     * @custom:error Throw RedeemBehalfFailed if redeem on behalf (profit leg or full-close dust) fails.
     * @custom:error Throw TokenSwapCallFailed if the profit swap helper call fails.
     * @custom:error Throw SlippageExceeded if profit swap output is below minAmountOutProfit.
     * @custom:error Throw MintBehalfFailed if minting converted profit as principal fails.
     * @custom:error Throw ZeroVTokensMinted if profit swap output rounds down to 0 vTokens if Minted.
     * @custom:error Throw PositionNotFullyClosed if 100% close is used but short debt remains (e.g. exitLeverage did not repay fully).
     * @custom:event Emits ProfitConverted and PositionClosed events.
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
    ) external nonReentrant whenNotCompletelyPaused {
        Position storage position = _getActivePosition(msg.sender, address(longVToken), address(shortVToken));

        uint256 amountToRepay = _validateProfitClose(
            position,
            closeFractionBps,
            longAmountToRedeemForRepay + longAmountToRedeemForProfit,
            minAmountOutRepay
        );

        // Validate repay leg against long collateral bucket in the shared pool (DSA==long only).
        _validateSharedPoolRedeemAmounts(position, longAmountToRedeemForRepay, 0);

        address positionAccount = position.positionAccount;

        // Proportional repay via exitLeverage (amountToRepay already includes 100% tolerance bump when applicable)
        if (amountToRepay > 0) {
            IPositionAccount(positionAccount).exitLeverage(
                longVToken,
                longAmountToRedeemForRepay,
                shortVToken,
                amountToRepay,
                minAmountOutRepay,
                swapDataRepay
            );
        }

        // Realize profit: redeem longAmountToRedeemForProfit and swap to DSA (converted to principal)
        if (longAmountToRedeemForProfit > 0) {
            _redeemLongAndSwapToDSA(
                position,
                positionAccount,
                longVToken,
                IVToken(position.dsaVToken),
                longAmountToRedeemForProfit,
                minAmountOutProfit,
                swapDataProfit
            );
        }

        _transferDustFromAccountToUser(positionAccount, longVToken.underlying());
        _transferDustFromAccountToUser(positionAccount, shortVToken.underlying());

        uint256 longDustRedeemed;
        if (closeFractionBps == PROPORTIONAL_CLOSE_MAX) {
            longDustRedeemed = _verifyFullClose(position, longVToken, shortVToken);
        }

        emit PositionClosed(
            msg.sender,
            positionAccount,
            position.cycleId,
            closeFractionBps,
            amountToRepay,
            longAmountToRedeemForRepay + longAmountToRedeemForProfit,
            0,
            longDustRedeemed
        );
    }

    /**
     * @notice Closes a position with loss proportionally (BPS-based, same pattern as closeWithProfit).
     *         If treasuryPercent is enabled, the LM redeems more than the requested DSA amount on behalf
     *         of the position account to cover the fee.
     * @dev
     *      - First exit (long → short): long/short amounts are derived from BPS; the user passes shortAmountToRepayForFirstSwap,
     *        which is validated to be within [0, expectedShort] and minAmountOutFirst must be >= shortAmountToRepayForFirstSwap.
     *        For 100% close with one leg, shortAmountToRepayForFirstSwap should be slightly higher to cover the internal tolerance bump.
     *      - Second exit (DSA → short): the second repay amount is calculated as expectedShort - shortAmountToRepayForFirstSwap
     *        (and bumped for 100% close when > 0). minAmountOutSecond must be >= the calculated second repay (slippage protection;
     *        and should cover the bump but exact match not required).
     *      - Single-leg scenarios: this function also supports cases where only one leg (long or DSA) is available
     *        (e.g. after liquidation), by allowing either the first or second exit to be effectively skipped
     *      - Principal handling: Unused DSA principal stays on the position account. withdrawPrincipal withdraws up to
     *        the withdrawable amount; deactivatePosition redeems all remaining DSA and sends it to the user.
     * @param longVToken The vToken market for the long asset
     * @param shortVToken The vToken market for the short asset
     * @param closeFractionBps Proportion to close in basis points (10000 = 100%, 1 = 0.01% minimum)
     * @param longAmountToRedeemForFirstSwap Long amount to redeem for the first swap (validated against BPS within 1% tolerance)
     * @param shortAmountToRepayForFirstSwap Short amount to repay in the first exit (validated: 0 <= value <= BPS-derived expected short)
     * @param minAmountOutFirst Min short Amount expected from first swap; must be >= shortAmountToRepayForFirstSwap.
     *        Should Include flash-loan fees and for 100% close with one leg, include internal tolerance buffer.
     * @param swapDataFirst Swap #1 calldata: long/DSA → short for the first repay leg
     * @param dsaAmountToRedeemForSecondSwap DSA amount to redeem and use as input for the second repay swap
     * @param minAmountOutSecond Minimum short Amount expected from second swap; must be >= internally calculated second repay amount.
     *        Should Include flash-loan fees and (for 100% close) internal tolerance buffer.
     * @param swapDataSecond Swap #2 calldata: DSA → short for the second repay leg
     * @custom:error Throw PositionNotActive if the position is not active.
     * @custom:error Throw ZeroDebt if there is no short debt to close.
     * @custom:error Throw InvalidCloseFractionBps if closeFractionBps is not between 1 and 10000.
     * @custom:error Throw MinAmountOutRepayBelowDebt if minAmountOutFirst is below shortAmountToRepayForFirstSwap.
     * @custom:error Throw ProportionalCloseAmountOutOfTolerance if first-exit amounts are not within the tolerated BPS band.
     * @custom:error Throw MinAmountOutSecondBelowDebt if minAmountOutSecond is below the internally calculated second repay.
     * @custom:error Throw InsufficientWithdrawableAmount if either leg's effective amount (after treasury grossup) exceeds its bucket in the shared pool (DSA==long only).
     * @custom:error Throw RedeemBehalfFailed if redeeming long or DSA vTokens on behalf fails.
     * @custom:error Throw TokenSwapCallFailed if a swap helper call fails, or SlippageExceeded if swap output is too low.
     * @custom:error Throw ExcessiveShortDust if short token dust after both exit legs exceeds proportional tolerance.
     * @custom:event Emits PositionClosed event.
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
    ) external nonReentrant whenNotCompletelyPaused {
        Position storage position = _getActivePosition(msg.sender, address(longVToken), address(shortVToken));

        address positionAccount = position.positionAccount;
        if (shortVToken.borrowBalanceCurrent(positionAccount) == 0) revert ZeroDebt();

        // Validate both close legs against their respective buckets in the shared pool (DSA==long only).
        _validateSharedPoolRedeemAmounts(position, longAmountToRedeemForFirstSwap, dsaAmountToRedeemForSecondSwap);

        uint256 amountToRepaySecond = _validateLossClose(
            position,
            closeFractionBps,
            longAmountToRedeemForFirstSwap,
            shortAmountToRepayForFirstSwap,
            minAmountOutFirst,
            minAmountOutSecond
        );

        // Snapshot short balance before close legs to measure only operation-produced dust.
        address shortUnderlying = shortVToken.underlying();
        uint256 accountShortBalanceBefore = IERC20Upgradeable(shortUnderlying).balanceOf(positionAccount);

        // 1. First exitLeverage (long → short): repay first leg of short debt from long collateral.
        if (longAmountToRedeemForFirstSwap > 0) {
            IPositionAccount(positionAccount).exitLeverage(
                longVToken,
                longAmountToRedeemForFirstSwap,
                shortVToken,
                shortAmountToRepayForFirstSwap,
                minAmountOutFirst,
                swapDataFirst
            );
        }

        // 2. Second leg: repay remaining short debt with DSA.
        uint256 dsaAmountRedeemed = _closePositionWithDSA(
            position,
            positionAccount,
            IVToken(position.dsaVToken),
            shortVToken,
            dsaAmountToRedeemForSecondSwap,
            amountToRepaySecond,
            minAmountOutSecond,
            swapDataSecond
        );

        // Verify short dust produced by this operation does not exceed proportional tolerance.
        // Prevents disproportionate DSA collateral extraction via oversized dsaAmountToRedeemForSecondSwap.
        _validateShortDust(
            positionAccount,
            shortUnderlying,
            accountShortBalanceBefore,
            shortAmountToRepayForFirstSwap + amountToRepaySecond
        );

        // Transfer any dust from LM (sent to position account) to user
        _transferDustFromAccountToUser(positionAccount, longVToken.underlying());
        _transferDustFromAccountToUser(positionAccount, shortUnderlying);

        uint256 longDustRedeemed;
        if (closeFractionBps == PROPORTIONAL_CLOSE_MAX) {
            longDustRedeemed = _verifyFullClose(position, longVToken, shortVToken);
        }

        emit PositionClosed(
            msg.sender,
            positionAccount,
            position.cycleId,
            closeFractionBps,
            shortAmountToRepayForFirstSwap + amountToRepaySecond,
            longAmountToRedeemForFirstSwap,
            dsaAmountRedeemed,
            longDustRedeemed
        );
    }

    /**
     * @notice Withdraws principal from an active position, subject to utilization constraints
     * @dev Only callable when the position is active. Calculates utilization and withdraws up to the
     *      requested amount, bounded by the withdrawable principal derived from utilization.
     * @param longVToken The vToken market for the long asset
     * @param shortVToken The vToken market for the short asset
     * @param amount Amount to withdraw
     * @custom:error Throw PositionNotActive if the position is not active.
     * @custom:error Throw ZeroAmount if amount is zero.
     * @custom:error Throw InsufficientWithdrawableAmount if amount exceeds withdrawable principal.
     * @custom:error Throw RedeemBehalfFailed if redeem fails.
     * @custom:event Emits PrincipalWithdrawn event when principal is withdrawn.
     */
    function withdrawPrincipal(
        IVToken longVToken,
        IVToken shortVToken,
        uint256 amount
    ) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();

        Position storage position = _getActivePosition(msg.sender, address(longVToken), address(shortVToken));
        address positionAccount = position.positionAccount;

        UtilizationInfo memory utilization = _getUtilizationInfo(position);
        if (amount > utilization.withdrawableAmount) revert InsufficientWithdrawableAmount();

        IVToken dsaVToken = IVToken(position.dsaVToken);
        uint256 vTokensBefore = dsaVToken.balanceOf(positionAccount);
        _redeemUnderlyingToUser(dsaVToken, positionAccount, amount);
        uint256 vTokensAfter = dsaVToken.balanceOf(positionAccount);

        // Reduce suppliedPrincipalVTokens by DSA vTokens burned for this withdraw, clamped to tracked principal.
        uint256 burned = vTokensBefore - vTokensAfter;
        if (burned > position.suppliedPrincipalVTokens) {
            position.suppliedPrincipalVTokens = 0;
        } else {
            position.suppliedPrincipalVTokens -= burned;
        }

        emit PrincipalWithdrawn(
            msg.sender,
            positionAccount,
            position.cycleId,
            address(dsaVToken),
            amount,
            position.suppliedPrincipalVTokens
        );
    }

    /**
     * @notice Deactivates a position account
     * @dev Reverts if position still has short debt (PositionNotFullyClosed).
     *      Sets isActive to false, then redeems any remaining long collateral and DSA principal to the user.
     *      User may activate again later (possibly with a different DSA via dsaIndex).
     * @param longVToken The vToken market for the long asset
     * @param shortVToken The vToken market for the short asset
     * @custom:error Throw PositionNotActive if the position is not active.
     * @custom:error Throw PositionNotFullyClosed if short debt remains.
     * @custom:event Emits PositionDeactivated event.
     */
    function deactivatePosition(IVToken longVToken, IVToken shortVToken) external nonReentrant whenNotPaused {
        Position storage position = _getActivePosition(msg.sender, address(longVToken), address(shortVToken));
        address positionAccount = position.positionAccount;

        // Check that position has no short debt remaining
        uint256 shortDebt = shortVToken.borrowBalanceCurrent(positionAccount);
        if (shortDebt > 0) revert PositionNotFullyClosed();

        IVToken dsaVToken = IVToken(position.dsaVToken);
        bool dsaIsLong = address(dsaVToken) == address(longVToken);

        // Capture long collateral before clearing state (needed for accurate event when dsaIsLong)
        uint256 longCollateral = _getLongCollateralBalance(position);

        position.isActive = false;
        position.suppliedPrincipalVTokens = 0;

        uint256 longRedeemed;
        uint256 dsaRedeemed;

        if (dsaIsLong) {
            // DSA and long share the same market — single redeem covers both principal and long collateral
            uint256 totalRedeemed = _redeemAllVTokensToUser(dsaVToken, positionAccount);
            longRedeemed = longCollateral > totalRedeemed ? totalRedeemed : longCollateral;
            dsaRedeemed = totalRedeemed - longRedeemed;
        } else {
            // Redeem long collateral back to user
            longRedeemed = _redeemAllVTokensToUser(longVToken, positionAccount);

            // Exit DSA market and redeem remaining DSA principal to user
            IPositionAccount(positionAccount).exitMarket(address(dsaVToken));
            dsaRedeemed = _redeemAllVTokensToUser(dsaVToken, positionAccount);
        }

        emit PositionDeactivated(msg.sender, positionAccount, position.cycleId, longRedeemed, dsaRedeemed);
    }

    /**
     * @notice Returns the address at which the PositionAccount would be deployed for the given user and markets
     * @dev Uses the same salt as _deployPositionAccount (keccak256(user, longVToken, shortVToken)).
     *      Returns the address that cloneDeterministic would deploy to if called by this contract.
     * @param user User address
     * @param longVToken The vToken market for the long asset
     * @param shortVToken The vToken market for the short asset
     * @return predicted The predicted PositionAccount address (same as deployed by activateAndOpenPosition for that user/long/short)
     * @custom:error Throw PositionAccountImplementationNotSet if implementation is not configured.
     */
    function getPositionAccountAddress(
        address user,
        IVToken longVToken,
        IVToken shortVToken
    ) external view returns (address predicted) {
        if (POSITION_ACCOUNT_IMPLEMENTATION == address(0)) {
            revert PositionAccountImplementationNotSet();
        }

        bytes32 salt = keccak256(abi.encodePacked(user, address(longVToken), address(shortVToken)));
        return ClonesUpgradeable.predictDeterministicAddress(POSITION_ACCOUNT_IMPLEMENTATION, salt, address(this));
    }

    /**
     * @notice Returns the full list of configured DSA vToken markets
     * @return dsaVTokensList Array of DSA vToken addresses
     */
    function getDsaVTokens() external view returns (address[] memory dsaVTokensList) {
        dsaVTokensList = new address[](dsaVTokenIndexCounter);
        for (uint8 i = 0; i < dsaVTokenIndexCounter; i++) {
            dsaVTokensList[i] = dsaVTokens[i];
        }
    }

    /**
     * @notice Returns the position data for a user and asset pair
     * @param user User address
     * @param longVToken The vToken market for the long asset
     * @param shortVToken The vToken market for the short asset
     * @return position The Position struct
     */
    function getPosition(
        address user,
        IVToken longVToken,
        IVToken shortVToken
    ) external view returns (Position memory position) {
        return positions[user][address(longVToken)][address(shortVToken)];
    }

    /**
     * @notice Calculates capital utilization for a position
     * @dev Computes how much capital is being used vs available. DSA is read from the position. See IRelativePositionManager for full description.
     * @param user User address
     * @param longVToken The vToken market for the long asset
     * @param shortVToken The vToken market for the short asset
     * @return utilization Utilization information including available capital and withdrawable amount
     */
    function getUtilizationInfo(
        address user,
        IVToken longVToken,
        IVToken shortVToken
    ) external returns (UtilizationInfo memory utilization) {
        Position storage position = positions[user][address(longVToken)][address(shortVToken)];
        return _getUtilizationInfo(position);
    }

    /**
     * @notice Returns the remaining short borrow capacity for a position under current market conditions
     * @dev Computes availableCapitalUSD from live utilization, then clamps the stored effectiveLeverage
     *      against the current maxLeverageAllowed (derived from live CFs)
     * @param user User address
     * @param longVToken The vToken market for the long asset
     * @param shortVToken The vToken market for the short asset
     * @return availableCapacity Remaining borrow capacity in short asset terms
     */
    function getAvailableShortCapacity(
        address user,
        IVToken longVToken,
        IVToken shortVToken
    ) external returns (uint256 availableCapacity) {
        Position storage position = positions[user][address(longVToken)][address(shortVToken)];
        return _calculateMaxBorrowAllowed(position);
    }

    /**
     * @notice Returns the maximum allowed leverage for a given DSA/long market pair based on current collateral factors
     * @dev maxLeverage = CF_dsa / (1 - CF_long * (1 - proportionalCloseTolerance))
     *      Reverts with InvalidCollateralFactor if either CF >= 1 or the denominator is zero.
     * @param dsaVToken The DSA vToken market (CF_dsa used as collateral)
     * @param longVToken The long asset vToken market (CF_long used as hedge coverage)
     * @return maxLeverage The maximum leverage ratio (1e18 mantissa)
     */
    function getMaxLeverageAllowed(IVToken dsaVToken, address longVToken) external view returns (uint256 maxLeverage) {
        return _getMaxLeverage(dsaVToken, longVToken);
    }

    /**
     * @notice Returns the actual long collateral balance in underlying for a given user/position,
     *         excluding DSA principal when the DSA and long assets share the same vToken market.
     * @dev This is a public wrapper around `_getLongCollateralBalance` intended primarily for tests
     *      and off-chain monitoring. It is not marked view because it may call `exchangeRateCurrent`
     *      on the vToken, which can update state.
     * @param user The position owner
     * @param longVToken The vToken market for the long asset
     * @param shortVToken The vToken market for the short asset
     * @return longBalance The long collateral balance in underlying units (principal excluded when shared market)
     */
    function getLongCollateralBalance(
        address user,
        IVToken longVToken,
        IVToken shortVToken
    ) external returns (uint256 longBalance) {
        Position storage position = positions[user][address(longVToken)][address(shortVToken)];
        return _getLongCollateralBalance(position);
    }

    /**
     * @notice Returns the supplied principal balance in underlying units for a given user/position
     * @dev When DSA != long, reads DSA underlying from position account. When DSA == long, uses stored vToken principal.
     *      Not view because it may call exchangeRateCurrent on the vToken.
     * @param user The position owner
     * @param longVToken The vToken market for the long asset
     * @param shortVToken The vToken market for the short asset
     * @return balance The supplied principal in underlying units
     */
    function getSuppliedPrincipalBalance(
        address user,
        IVToken longVToken,
        IVToken shortVToken
    ) external returns (uint256 balance) {
        Position storage position = positions[user][address(longVToken)][address(shortVToken)];
        return _getSuppliedPrincipalBalance(position);
    }

    /**
     * @notice Activates a position account and supplies required principal
     * @dev Deploys a new PositionAccount contract if one doesn't exist. Sets up position structure,
     *      enters DSA market, and supplies initialPrincipal. Called by activateAndOpenPosition().
     * @param longVToken The vToken market address for the asset to long
     * @param shortVToken The vToken market address for the asset to short
     * @param dsaIndex Index of the DSA vToken in the dsaVTokens array
     * @param initialPrincipal Required initial principal amount (must be > 0)
     * @param effectiveLeverage The target leverage ratio for this position
     */
    function _activatePosition(
        address longVToken,
        address shortVToken,
        uint8 dsaIndex,
        uint256 initialPrincipal,
        uint256 effectiveLeverage
    ) internal {
        _checkMarketListed(longVToken);
        _checkMarketListed(shortVToken);
        IVToken dsaVToken = _getValidatedDSAVToken(dsaIndex);
        _checkSameMarket(longVToken, shortVToken);

        if (initialPrincipal == 0) revert InsufficientPrincipal();

        // Validate requested leverage against [MIN_LEVERAGE, maxLeverage]; λ_max = CF_c / (1 - CF_l * (1 - f))
        uint256 maxLeverage = _getMaxLeverage(dsaVToken, longVToken);
        if (effectiveLeverage < MIN_LEVERAGE || effectiveLeverage > maxLeverage) {
            revert InvalidLeverage();
        }

        Position storage position = positions[msg.sender][longVToken][shortVToken];
        if (position.isActive) {
            revert PositionAlreadyExists();
        }

        // Deploy position account if it doesn't exist (sets immutable fields in _deployPositionAccount)
        if (position.positionAccount == address(0)) {
            _deployPositionAccount(msg.sender, longVToken, shortVToken);
        }

        // Increment cycle ID on each activation and set mutable fields
        position.cycleId++;
        position.isActive = true;
        position.dsaIndex = dsaIndex;
        position.dsaVToken = address(dsaVToken);
        position.effectiveLeverage = effectiveLeverage;

        // Enter DSA market on behalf of position account (to use as collateral)
        _validateAndEnterMarket(position.positionAccount, dsaVToken);

        // Supply required principal
        _supplyPrincipalToPositionAccount(position, dsaVToken, initialPrincipal);

        emit PositionActivated(
            msg.sender,
            longVToken,
            shortVToken,
            address(dsaVToken),
            position.positionAccount,
            position.cycleId,
            initialPrincipal,
            effectiveLeverage
        );
    }

    /**
     * @notice Opens or scales a leveraged position (borrow short, swap to long). The flash loan fee
     *         is borrowed on behalf of the position account and repaid immediately, so the position's
     *         actual short debt after this call is shortAmount + flashLoanFee. Users should account
     *         for this overhead when calculating close parameters.
     * @dev Supplies optional additionalPrincipal, calculates max borrow, and executes leverage via
     *      the position account. Event emission (PositionOpened or PositionScaled) is the
     *      responsibility of the caller.
     * @param longVToken The vToken market for the asset to long
     * @param shortVToken The vToken market for the asset to short
     * @param additionalPrincipal Additional principal to supply (0 if none)
     * @param shortAmount Amount to borrow in shortAsset terms
     * @param minLongAmount Minimum amount of long asset expected from swap
     * @param swapData Swap instructions for converting shortAsset to longAsset
     */
    function _openPosition(
        IVToken longVToken,
        IVToken shortVToken,
        uint256 additionalPrincipal,
        uint256 shortAmount,
        uint256 minLongAmount,
        bytes calldata swapData
    ) internal {
        if (shortAmount == 0) revert ZeroShortAmount();
        Position storage position = _getActivePosition(msg.sender, address(longVToken), address(shortVToken));
        IVToken dsaVToken = IVToken(position.dsaVToken);

        // Supply additional principal if provided
        if (additionalPrincipal > 0) {
            _supplyPrincipalToPositionAccount(position, dsaVToken, additionalPrincipal);
        }

        uint256 maxBorrowAmount = _calculateMaxBorrowAllowed(position);
        if (shortAmount > maxBorrowAmount) revert BorrowAmountExceedsMaximum();

        address positionAccount = position.positionAccount;
        IPositionAccount(positionAccount).enterLeverage(
            longVToken,
            0, // DSA is used as Seed
            shortVToken,
            shortAmount,
            minLongAmount,
            swapData
        );

        // Transfer any dust from LM (sent to position account) to user
        _transferDustFromAccountToUser(positionAccount, longVToken.underlying());
        _transferDustFromAccountToUser(positionAccount, shortVToken.underlying());
    }

    /**
     * @notice Deploys a new PositionAccount contract for the user
     * @dev Uses deterministic deployment via clones and initializes the clone with user-specific data.
     *      Sets position account address and immutable position fields (user, longAsset, shortAsset) in storage.
     * @param user User address
     * @param longAsset Long asset vToken address
     * @param shortAsset Short asset vToken address
     */
    function _deployPositionAccount(address user, address longAsset, address shortAsset) internal {
        if (POSITION_ACCOUNT_IMPLEMENTATION == address(0)) {
            revert PositionAccountImplementationNotSet();
        }

        bytes32 salt = keccak256(abi.encodePacked(user, longAsset, shortAsset));
        address positionAccount = ClonesUpgradeable.cloneDeterministic(POSITION_ACCOUNT_IMPLEMENTATION, salt);

        // Initialize the clone with user-specific data (owner, longAsset, shortAsset)
        // This will automatically approve both RPM and LeverageManager as delegates
        IPositionAccount(positionAccount).initialize(user, longAsset, shortAsset);

        Position storage position = positions[user][longAsset][shortAsset];
        position.positionAccount = positionAccount;
        position.user = user;
        position.longVToken = longAsset;
        position.shortVToken = shortAsset;

        emit PositionAccountDeployed(user, longAsset, shortAsset, positionAccount);
    }

    /**
     * @notice Converts long collateral into DSA principal on the same position.
     * @dev When long and DSA share the same underlying, no on-chain redeem/swap/mint occurs — the function
     *      reclassifies existing vTokens in storage using the current exchange rate. When assets differ,
     *      redeems long underlying, swaps to DSA via the swap helper, and mints the result as principal.
     * @param position The Position storage reference whose principal should be increased
     * @param positionAccount The position account from which long is conceptually redeemed
     * @param longVToken Long market vToken
     * @param dsaVToken DSA market vToken
     * @param amountToRedeem Amount of long underlying to convert into DSA principal
     * @param minAmountOutProfit Minimum DSA out from the swap
     * @param swapDataProfit Calldata for the long→DSA swap
     */
    function _redeemLongAndSwapToDSA(
        Position storage position,
        address positionAccount,
        IVToken longVToken,
        IVToken dsaVToken,
        uint256 amountToRedeem,
        uint256 minAmountOutProfit,
        bytes calldata swapDataProfit
    ) internal {
        IERC20Upgradeable longUnderlying = IERC20Upgradeable(longVToken.underlying());
        IERC20Upgradeable dsaUnderlying = IERC20Upgradeable(dsaVToken.underlying());
        uint256 vTokensMinted;

        if (address(longUnderlying) == address(dsaUnderlying)) {
            // no on-chain redeem/swap/mint required. Reclassify long vTokens as principal.
            uint256 exchangeRate = dsaVToken.exchangeRateCurrent();
            vTokensMinted = (amountToRedeem * MANTISSA_ONE) / exchangeRate;
        } else {
            // Redeem long underlying from the position account to this contract
            uint256 balanceBefore = longUnderlying.balanceOf(address(this));
            uint256 err = longVToken.redeemUnderlyingBehalf(positionAccount, amountToRedeem);
            if (err != SUCCESS) revert RedeemBehalfFailed(err);
            uint256 amountReceived = longUnderlying.balanceOf(address(this)) - balanceBefore;

            uint256 amountOut = _performSwap(
                longUnderlying,
                amountReceived,
                dsaUnderlying,
                minAmountOutProfit,
                swapDataProfit
            );

            // Supply the received DSA underlying as additional principal to the same position account.
            balanceBefore = dsaVToken.balanceOf(positionAccount);
            dsaUnderlying.forceApprove(address(dsaVToken), amountOut);
            uint256 mintError = dsaVToken.mintBehalf(positionAccount, amountOut);
            if (mintError != SUCCESS) revert MintBehalfFailed(mintError);
            vTokensMinted = dsaVToken.balanceOf(positionAccount) - balanceBefore;
            // Ensure mint actually produced vTokens
            if (vTokensMinted == 0) revert ZeroVTokensMinted();
        }

        // Update principal state
        position.suppliedPrincipalVTokens += vTokensMinted;
        emit ProfitConverted(position.user, positionAccount, amountToRedeem, position.suppliedPrincipalVTokens);
    }

    /**
     * @notice Closes a position leg by repaying debt with DSA
     * @dev Handles both single-asset (DSA == short) and different-asset (DSA != short) cases
     *      Executes exit, updates principal, and transfers dust
     * @param position The position storage reference
     * @param positionAccount The position account address
     * @param dsaVToken The DSA vToken market
     * @param shortVToken The short vToken market
     * @param dsaAmountToRedeem User-supplied DSA amount to redeem (for two-asset case)
     * @param amountToRepaySecond Amount of short debt to repay
     * @param minAmountOutSecond Minimum output for swap (two-asset case)
     * @param swapDataSecond Swap calldata (two-asset case)
     * @return dsaAmountRedeemed Actual DSA amount redeemed
     */
    function _closePositionWithDSA(
        Position storage position,
        address positionAccount,
        IVToken dsaVToken,
        IVToken shortVToken,
        uint256 dsaAmountToRedeem,
        uint256 amountToRepaySecond,
        uint256 minAmountOutSecond,
        bytes calldata swapDataSecond
    ) internal returns (uint256 dsaAmountRedeemed) {
        if (amountToRepaySecond == 0) return 0;

        // Check if DSA and short assets are the same (same-asset case vs different-asset case)
        bool isSameAsset = address(dsaVToken) == address(shortVToken);
        uint256 vTokensBefore = dsaVToken.balanceOf(positionAccount);

        // Execute exit operation based on whether DSA == short (same-asset case)
        if (isSameAsset) {
            IPositionAccount(positionAccount).exitSingleAssetLeverage(dsaVToken, amountToRepaySecond);
        } else {
            IPositionAccount(positionAccount).exitLeverage(
                dsaVToken,
                dsaAmountToRedeem,
                shortVToken,
                amountToRepaySecond,
                minAmountOutSecond,
                swapDataSecond
            );
        }

        // Calculate amount redeemed and update principal
        uint256 vTokensBurned = vTokensBefore - dsaVToken.balanceOf(positionAccount);
        dsaAmountRedeemed = isSameAsset
            ? (vTokensBurned * dsaVToken.exchangeRateCurrent()) / MANTISSA_ONE
            : dsaAmountToRedeem;

        // Reduce suppliedPrincipalVTokens by DSA vTokens burned, clamped to tracked principal
        if (vTokensBurned > position.suppliedPrincipalVTokens) {
            position.suppliedPrincipalVTokens = 0;
        } else {
            position.suppliedPrincipalVTokens -= vTokensBurned;
        }

        // When DSA != short, transfer DSA dust now. When DSA == short, defer to after
        // _validateShortDust so the delta-based dust check sees the correct balance.
        if (!isSameAsset) {
            _transferDustFromAccountToUser(positionAccount, dsaVToken.underlying());
        }
    }

    /**
     * @notice Transfers token dust from position account to the position owner (msg.sender from the user's perspective)
     * @dev Calls PositionAccount.transferDustToOwner which is only callable by this manager; dust goes to account owner.
     * @param positionAccount Address of the position account holding the dust
     * @param tokenAddress Address of the ERC20 token to transfer
     */
    function _transferDustFromAccountToUser(address positionAccount, address tokenAddress) internal {
        IPositionAccount(positionAccount).transferDustToOwner(tokenAddress);
    }

    /**
     * @notice Redeems underlying from a vToken on behalf of an account and transfers the received underlying to msg.sender
     * @param vToken The vToken market to redeem from
     * @param fromAccount The account on whose behalf to redeem (e.g. position account)
     * @param amount Amount of underlying to redeem
     */
    function _redeemUnderlyingToUser(IVToken vToken, address fromAccount, uint256 amount) internal {
        if (amount == 0) return;
        IERC20Upgradeable underlying = IERC20Upgradeable(vToken.underlying());
        uint256 balanceBefore = underlying.balanceOf(address(this));
        uint256 err = vToken.redeemUnderlyingBehalf(fromAccount, amount);
        if (err != SUCCESS) revert RedeemBehalfFailed(err);
        uint256 received = underlying.balanceOf(address(this)) - balanceBefore;
        if (received > 0) {
            underlying.safeTransfer(msg.sender, received);
            emit UnderlyingTransferred(address(underlying), fromAccount, msg.sender, received);
        }
    }

    /**
     * @notice Verifies full close conditions and handles remaining long dust after a 100% close
     * @dev Only acts when closeFractionBps == 100. Verifies all short debt is repaid, then handles
     *      remaining long vTokens:
     *      - If long == DSA: reclassifies remaining long vTokens as principal (redeemed during deactivation)
     *      - If long != DSA: redeems remaining long vTokens directly to the user
     *      Uses redeemBehalf (vToken amount) instead of redeemUnderlyingBehalf (underlying amount)
     *      to avoid precision loss: when a small underlying dust amount is divided by the exchange rate,
     *      the result can truncate to 0 vTokens, causing the redeem to revert.
     * @param position The position storage reference
     * @param longVToken The long market vToken
     * @param shortVToken The short market vToken
     * @return longDustRedeemed The underlying amount redeemed (or reclassified) as dust
     */
    function _verifyFullClose(
        Position storage position,
        IVToken longVToken,
        IVToken shortVToken
    ) internal returns (uint256 longDustRedeemed) {
        address positionAccount = position.positionAccount;
        if (shortVToken.borrowBalanceCurrent(positionAccount) > 0) revert PositionNotFullyClosed();
        IVToken dsaVToken = IVToken(position.dsaVToken);

        if (address(longVToken) == address(dsaVToken)) {
            // Read long collateral (excludes current principal) before reclassifying.
            longDustRedeemed = _getLongCollateralBalance(position);
            // Set suppliedPrincipalVTokens to the full vToken balance.
            position.suppliedPrincipalVTokens = longVToken.balanceOf(positionAccount);
        } else {
            longDustRedeemed = _redeemAllVTokensToUser(longVToken, positionAccount);
        }
    }

    /**
     * @notice Redeems the full vToken balance from a position account and transfers all resulting underlying to the caller
     * @param vToken The vToken market to redeem from
     * @param positionAccount The position account on whose behalf to redeem
     * @return underlyingRedeemed Amount of underlying transferred to the caller
     */
    function _redeemAllVTokensToUser(
        IVToken vToken,
        address positionAccount
    ) internal returns (uint256 underlyingRedeemed) {
        uint256 vTokenBalance = vToken.balanceOf(positionAccount);
        if (vTokenBalance == 0) return 0;

        IERC20Upgradeable underlying = IERC20Upgradeable(vToken.underlying());
        uint256 balanceBefore = underlying.balanceOf(address(this));
        uint256 err = vToken.redeemBehalf(positionAccount, vTokenBalance);
        if (err != SUCCESS) revert RedeemBehalfFailed(err);
        underlyingRedeemed = underlying.balanceOf(address(this)) - balanceBefore;
        if (underlyingRedeemed > 0) {
            underlying.safeTransfer(msg.sender, underlyingRedeemed);
            emit UnderlyingTransferred(address(underlying), positionAccount, msg.sender, underlyingRedeemed);
        }
    }

    /**
     * @notice Transfers DSA underlying from msg.sender to this contract, approves and mints vTokens to the position account
     * @param position The position whose principal should be increased
     * @param dsaVToken The DSA vToken market
     * @param amount Amount of underlying to transfer and mint
     */
    function _supplyPrincipalToPositionAccount(Position storage position, IVToken dsaVToken, uint256 amount) internal {
        if (position.longVToken == address(dsaVToken)) _syncSuppliedPrincipal(position);
        address positionAccount = position.positionAccount;

        uint256 balanceBefore = dsaVToken.balanceOf(positionAccount);
        address underlying = dsaVToken.underlying();
        IERC20Upgradeable(underlying).safeTransferFrom(msg.sender, address(this), amount);
        IERC20Upgradeable(underlying).forceApprove(address(dsaVToken), amount);
        uint256 mintError = dsaVToken.mintBehalf(positionAccount, amount);
        if (mintError != SUCCESS) revert MintBehalfFailed(mintError);
        uint256 vTokensMinted = dsaVToken.balanceOf(positionAccount) - balanceBefore;
        // Ensure mint actually produced vTokens
        if (vTokensMinted == 0) revert ZeroVTokensMinted();
        position.suppliedPrincipalVTokens += vTokensMinted;

        emit PrincipalSupplied(
            position.user,
            positionAccount,
            position.cycleId,
            address(dsaVToken),
            amount,
            position.suppliedPrincipalVTokens
        );
    }

    /**
     * @notice Performs token swap via the LeverageManager's SwapHelper
     * @dev Transfers tokenIn to SwapHelper, executes param (calldata), then verifies tokenOut received >= minAmountOut.
     *      Reverts with TokenSwapCallFailed if the call fails, SlippageExceeded if output < minAmountOut.
     * @param tokenIn The input token (transferred to SwapHelper)
     * @param amountIn The amount of input tokens to swap
     * @param tokenOut The output token (received by this contract)
     * @param minAmountOut The minimum acceptable amount of output tokens (slippage protection)
     * @param param The encoded swap calldata for the SwapHelper
     * @return amountOut The actual amount of output tokens received
     */
    function _performSwap(
        IERC20Upgradeable tokenIn,
        uint256 amountIn,
        IERC20Upgradeable tokenOut,
        uint256 minAmountOut,
        bytes calldata param
    ) internal returns (uint256 amountOut) {
        address swapHelperAddr = address(LEVERAGE_MANAGER.swapHelper());
        tokenIn.safeTransfer(swapHelperAddr, amountIn);

        uint256 tokenOutBalanceBefore = tokenOut.balanceOf(address(this));

        (bool success, bytes memory returnData) = swapHelperAddr.call(param);
        if (!success) {
            if (returnData.length > 0) {
                assembly {
                    revert(add(returnData, 32), mload(returnData))
                }
            }
            revert TokenSwapCallFailed();
        }

        uint256 tokenOutBalanceAfter = tokenOut.balanceOf(address(this));
        amountOut = tokenOutBalanceAfter - tokenOutBalanceBefore;
        if (amountOut < minAmountOut) revert SlippageExceeded();
    }

    /**
     * @notice Calculates the maximum allowed borrow amount for a position
     * @param position In-memory snapshot of the position data
     * @return maxBorrowAmount Maximum amount that can be borrowed in shortAsset terms
     */
    function _calculateMaxBorrowAllowed(Position storage position) internal returns (uint256 maxBorrowAmount) {
        // Get utilization info which calculates available capital (DSA from position)
        UtilizationInfo memory utilization = _getUtilizationInfo(position);

        // Calculate max additional borrow amount: availableCapital * clampedLeverage (precomputed in utilization)
        uint256 maxAdditionalBorrowUSD = (utilization.availableCapitalUSD * utilization.clampedLeverage) / MANTISSA_ONE;

        // Convert to shortAsset amount
        ResilientOracleInterface oracle = COMPTROLLER.oracle();
        uint256 shortPrice = oracle.getUnderlyingPrice(position.shortVToken);

        maxBorrowAmount = (maxAdditionalBorrowUSD * MANTISSA_ONE) / shortPrice;
    }

    /**
     * @notice Calculates capital utilization for a position (used for max borrow and withdrawable amount)
     * @dev Computes actualCapitalUtilized (LTV-based), nominalCapitalUtilized (leverage-based), caps by supplied principal,
     *      then availableCapitalUSD and withdrawableAmount in DSA terms.
     * @param position In-memory snapshot of the position data
     * @return utilization Struct with actualCapitalUtilized, nominalCapitalUtilized, finalCapitalUtilized, availableCapitalUSD, withdrawableAmount, clampedLeverage
     */
    function _getUtilizationInfo(Position storage position) internal returns (UtilizationInfo memory utilization) {
        IVToken longVToken = IVToken(position.longVToken);
        PositionValuesUSD memory values = _getPositionValuesUSD(position);
        IVToken dsaVToken = IVToken(position.dsaVToken);

        (, uint256 dsaCF, ) = COMPTROLLER.markets(address(dsaVToken));
        (, uint256 longCF, ) = COMPTROLLER.markets(address(longVToken));

        // Clamp stored leverage against current max (CFs may have been reduced since activation)
        uint256 currentMaxLeverage = _getMaxLeverage(dsaVToken, position.longVToken);
        utilization.clampedLeverage = position.effectiveLeverage < currentMaxLeverage
            ? position.effectiveLeverage
            : currentMaxLeverage;

        // Calculate nominalCapitalUtilized using clampedLeverage (rounded up for conservative estimate)
        utilization.nominalCapitalUtilized = ceilDiv(values.borrowValueUSD * MANTISSA_ONE, utilization.clampedLeverage);

        // Calculate actualCapitalUtilized: DSA principal required to back the borrow not covered by long collateral.
        // excessBorrowUSD = borrowValueUSD - (longValueUSD * longCF); actualCapitalUtilized = excessBorrowUSD / dsaCF.
        // If dsaCF == 0 the DSA asset provides no borrowing power, so all supplied principal is consumed if any excessBorrow exists.
        uint256 longCollateralValueUSD = (values.longValueUSD * longCF) / MANTISSA_ONE;
        uint256 excessBorrowUSD = values.borrowValueUSD > longCollateralValueUSD
            ? values.borrowValueUSD - longCollateralValueUSD
            : 0;

        // if long collateral fully covers the borrow (excessBorrowUSD == 0); actualCapitalUtilized remains 0 (default)
        if (excessBorrowUSD > 0) {
            utilization.actualCapitalUtilized = dsaCF == 0
                ? values.suppliedPrincipalUSD
                : ceilDiv(excessBorrowUSD * MANTISSA_ONE, dsaCF);
        }

        utilization.finalCapitalUtilized = max(utilization.actualCapitalUtilized, utilization.nominalCapitalUtilized);
        utilization.finalCapitalUtilized = min(values.suppliedPrincipalUSD, utilization.finalCapitalUtilized);

        // Calculate available capital in USD (finalCapitalUtilized is already capped by suppliedPrincipalVTokens)
        utilization.availableCapitalUSD = values.suppliedPrincipalUSD - utilization.finalCapitalUtilized;

        // Calculate withdrawable amount in DSA token terms (rounded down for conservative estimate)
        utilization.withdrawableAmount = (utilization.availableCapitalUSD * MANTISSA_ONE) / values.dsaPrice;
    }

    /**
     * @notice Returns expected proportional amounts and tolerance band for a close (BPS of current balance/debt)
     * @dev Reverts with InvalidCloseFractionBps if closeFractionBps is not in [1, 10000].
     * @param position The position (long balance and positionAccount from position; short debt from position.shortVToken)
     * @param closeFractionBps Proportion to close in basis points (10000 = 100%, 1 = 0.01% minimum)
     * @return expectedLongToWithdraw Amount of long to redeem (BPS of current long balance)
     * @return expectedShortToRepay Amount of short to repay (BPS of current short debt)
     * @return minLongToWithdraw Minimum long amount within proportionalCloseTolerance
     * @return maxLongToWithdraw Maximum long amount within proportionalCloseTolerance
     * @return maxExpectedShortToRepay Expected short + tolerance (for 100% close / first-leg cap in loss close)
     */
    function _getProportionalCloseAmounts(
        Position storage position,
        uint256 closeFractionBps
    )
        internal
        returns (
            uint256 expectedLongToWithdraw,
            uint256 expectedShortToRepay,
            uint256 minLongToWithdraw,
            uint256 maxLongToWithdraw,
            uint256 maxExpectedShortToRepay
        )
    {
        if (closeFractionBps < PROPORTIONAL_CLOSE_MIN || closeFractionBps > PROPORTIONAL_CLOSE_MAX)
            revert InvalidCloseFractionBps();

        uint256 longBalance = _getLongCollateralBalance(position);
        IVToken shortVToken = IVToken(position.shortVToken);
        uint256 shortDebt = shortVToken.borrowBalanceCurrent(position.positionAccount);
        expectedLongToWithdraw = (longBalance * closeFractionBps) / PROPORTIONAL_CLOSE_MAX;
        expectedShortToRepay = (shortDebt * closeFractionBps) / PROPORTIONAL_CLOSE_MAX;

        minLongToWithdraw =
            (expectedLongToWithdraw * (PROPORTIONAL_CLOSE_MAX - proportionalCloseTolerance)) / PROPORTIONAL_CLOSE_MAX;
        maxLongToWithdraw =
            (expectedLongToWithdraw * (PROPORTIONAL_CLOSE_MAX + proportionalCloseTolerance)) / PROPORTIONAL_CLOSE_MAX;

        // Cap at actual long collateral balance to prevent out-of-band values
        maxLongToWithdraw = min(maxLongToWithdraw, longBalance);

        maxExpectedShortToRepay =
            (expectedShortToRepay * (PROPORTIONAL_CLOSE_MAX + proportionalCloseTolerance)) / PROPORTIONAL_CLOSE_MAX;
    }

    /**
     * @notice Validates proportional close for profit path and returns amount to repay
     * @dev Validates totalLongAmountToRedeem (repay + profit) within proportionalCloseTolerance of BPS expected. Reverts if out of band.
     * @param position Position storage (used to derive expected long/short amounts)
     * @param closeFractionBps Proportion to close in basis points (10000 = 100%, 1 = 0.01% minimum)
     * @param totalLongAmountToRedeem Sum of long to redeem for repay and for profit swap
     * @param minAmountOutRepay User's minimum expected short from repay swap; must be >= expected short for this BPS
     * @return amountToRepay Short amount to use for repay call (includes PROPORTIONAL_CLOSE_MIN bump when 100% close)
     */
    function _validateProfitClose(
        Position storage position,
        uint256 closeFractionBps,
        uint256 totalLongAmountToRedeem,
        uint256 minAmountOutRepay
    ) internal returns (uint256 amountToRepay) {
        (
            uint256 expectedLongToWithdraw,
            uint256 expectedShortToRepay,
            uint256 minLongToWithdraw,
            uint256 maxLongToWithdraw,
            uint256 maxExpectedShortToRepay
        ) = _getProportionalCloseAmounts(position, closeFractionBps);

        // Revert when user tries to withdraw more than available long (BPS implies zero long to redeem).
        if (expectedLongToWithdraw == 0 && totalLongAmountToRedeem != 0) revert InvalidLongAmountToRedeem();

        // Revert if total long to redeem is outside the proportional close tolerance band.
        if (totalLongAmountToRedeem < minLongToWithdraw || totalLongAmountToRedeem > maxLongToWithdraw)
            revert ProportionalCloseAmountOutOfTolerance();

        // Validate minAmountOut against exact expected short (not bumped) to give user certainty on the repay amount
        if (expectedShortToRepay > 0 && minAmountOutRepay < expectedShortToRepay) revert MinAmountOutRepayBelowDebt();

        // For 100% close, add tolerance so we send slightly more to cover interest during flash loan
        amountToRepay = (closeFractionBps == PROPORTIONAL_CLOSE_MAX && expectedShortToRepay > 0)
            ? maxExpectedShortToRepay
            : expectedShortToRepay;
    }

    /**
     * @notice Validates redeem amounts against their respective buckets in the shared DSA/long pool,
     *         accounting for any treasury fee grossup applied by the LM when redeeming underlying on
     *         behalf of the position account.
     * @dev Only applies when DSA == long; skipped otherwise as pools are separate and Venus enforces limits.
     *      Treasury grossup is applied to each leg before comparing against its bucket.
     *      Used by both closeWithProfit (longAmount only, dsaAmount=0) and closeWithLoss (both legs).
     * @param position The active position
     * @param longAmountToRedeem Long underlying amount to redeem (validated against long collateral bucket)
     * @param dsaAmountToRedeem DSA underlying amount to redeem (validated against principal bucket, 0 to skip)
     */
    function _validateSharedPoolRedeemAmounts(
        Position storage position,
        uint256 longAmountToRedeem,
        uint256 dsaAmountToRedeem
    ) internal {
        // When DSA != long, pools are separate — Venus's own balance checks prevent over-redemption.
        if (position.dsaVToken != position.longVToken) return;

        uint256 treasuryPercent = COMPTROLLER.treasuryPercent();

        if (
            longAmountToRedeem > 0 &&
            _applyTreasuryGrossup(longAmountToRedeem, treasuryPercent) > _getLongCollateralBalance(position)
        ) revert InsufficientWithdrawableAmount();

        if (
            dsaAmountToRedeem > 0 &&
            _applyTreasuryGrossup(dsaAmountToRedeem, treasuryPercent) > _getSuppliedPrincipalBalance(position)
        ) revert InsufficientWithdrawableAmount();
    }

    /**
     * @notice Applies ceiling-division treasury grossup to an amount, mirroring the LM's internal fee logic.
     * @dev The LM redeems `ceil(amount / (1 - treasuryPercent))` underlying so the position account bears
     *      the treasury fee. Returns the raw amount unchanged when treasury is zero or amount is zero.
     * @param amount The raw underlying amount
     * @param treasuryPercent The treasury fee mantissa (0 = disabled)
     * @return The effective grossed-up amount the LM will actually burn from the position account
     */
    function _applyTreasuryGrossup(uint256 amount, uint256 treasuryPercent) internal pure returns (uint256) {
        if (amount == 0 || treasuryPercent == 0) return amount;
        return (amount * MANTISSA_ONE + (MANTISSA_ONE - treasuryPercent) - 1) / (MANTISSA_ONE - treasuryPercent);
    }

    /**
     * @notice Validates that short token dust on the position account does not exceed proportional tolerance.
     * @dev After both exit legs of closeWithLoss, any short underlying remaining on the position account
     *      is swap surplus. If dsaAmountToRedeemForSecondSwap is disproportionately large relative to the
     *      BPS-derived debt repayment, the surplus would be excessive — allowing collateral extraction
     *      beyond what the close fraction implies. This check bounds that surplus.
     * @param positionAccount The position account to check
     * @param shortUnderlying The short underlying token address
     * @param accountShortBalanceBefore Short token balance of the position account before the close operation
     * @param totalShortRepaid Total short amount repaid across both legs
     */
    function _validateShortDust(
        address positionAccount,
        address shortUnderlying,
        uint256 accountShortBalanceBefore,
        uint256 totalShortRepaid
    ) internal view {
        uint256 shortBalanceAfter = IERC20Upgradeable(shortUnderlying).balanceOf(positionAccount);
        // Only measure dust produced by this operation (delta), not pre-existing balance.
        uint256 shortDust = shortBalanceAfter > accountShortBalanceBefore
            ? shortBalanceAfter - accountShortBalanceBefore
            : 0;
        if (shortDust > (totalShortRepaid * proportionalCloseTolerance) / PROPORTIONAL_CLOSE_MAX)
            revert ExcessiveShortDust();
    }

    /**
     * @notice Validates loss close and returns calculated second repay amount
     * @dev Ensures the provided first-leg long/short amounts are within the proportional-close tolerance band
     *      and derives the second-leg short repay amount (with tolerance bump for 100% closes).
     *      If first-leg short > expected, full close in first leg is allowed provided it is <= maxExpectedShortToRepay;
     *      then the second leg becomes 0 (second repay amount is 0).
     * @param position Snapshot of the position (used to derive expected long/short amounts)
     * @param closeFractionBps Proportion to close in basis points (10000 = 100%, 1 = 0.01% minimum)
     * @param longAmountToRedeemForFirstSwap Long amount to redeem for the first swap (must be within proportionalCloseTolerance of expected long)
     * @param shortAmountToRepayForFirstSwap Short amount to repay in the first exit; for 100% close with one leg, should cover the extra bumped amount
     * @param minAmountOutFirst Minimum short out from the first swap (must be >= shortAmountToRepayForFirstSwap)
     * @param minAmountOutSecond Minimum short out from the second swap (must be >= internally calculated second repay; for 100% close should cover the bumped amount)
     * @return amountToRepaySecond The second-leg short repay amount (expectedShortToRepay - first leg, or 0 when first leg covers full).
     */
    function _validateLossClose(
        Position storage position,
        uint256 closeFractionBps,
        uint256 longAmountToRedeemForFirstSwap,
        uint256 shortAmountToRepayForFirstSwap,
        uint256 minAmountOutFirst,
        uint256 minAmountOutSecond
    ) internal returns (uint256 amountToRepaySecond) {
        // MinimumOut should never be smaller than expected to repay; for 100% close with one asset, user should account for the extra bumped amount (similar to profit case).
        if (minAmountOutFirst < shortAmountToRepayForFirstSwap) revert MinAmountOutRepayBelowDebt();

        // First leg is skipped when longAmountToRedeemForFirstSwap == 0; a non-zero shortAmountToRepayForFirstSwap would illegitimately reduce the second-leg repay.
        if (longAmountToRedeemForFirstSwap == 0 && shortAmountToRepayForFirstSwap != 0)
            revert InvalidLongAmountToRedeem();

        (
            uint256 expectedLongToWithdraw,
            uint256 expectedShortToRepay,
            uint256 minLongToWithdraw,
            uint256 maxLongToWithdraw,
            uint256 maxExpectedShortToRepay
        ) = _getProportionalCloseAmounts(position, closeFractionBps);

        // Revert when expected long for this close fraction is zero but user passed non-zero long to redeem or repay.
        if (expectedLongToWithdraw == 0 && (longAmountToRedeemForFirstSwap != 0 || shortAmountToRepayForFirstSwap != 0))
            revert InvalidLongAmountToRedeem();

        // Revert if first-leg long to redeem is outside the proportional close tolerance band.
        if (longAmountToRedeemForFirstSwap < minLongToWithdraw || longAmountToRedeemForFirstSwap > maxLongToWithdraw)
            revert ProportionalCloseAmountOutOfTolerance();

        // First leg exceeds expected: cap at maxExpectedShortToRepay and set second leg to zero.
        if (shortAmountToRepayForFirstSwap > expectedShortToRepay) {
            if (shortAmountToRepayForFirstSwap > maxExpectedShortToRepay)
                revert ProportionalCloseAmountOutOfTolerance();
            amountToRepaySecond = 0;
        } else {
            amountToRepaySecond = expectedShortToRepay - shortAmountToRepayForFirstSwap;

            // Validate and optionally bump second leg.
            if (minAmountOutSecond < amountToRepaySecond) revert MinAmountOutSecondBelowDebt();
            // For 100% close, add tolerance so we send slightly more to cover interest during flash loan
            if (closeFractionBps == PROPORTIONAL_CLOSE_MAX) {
                amountToRepaySecond =
                    (amountToRepaySecond * (PROPORTIONAL_CLOSE_MAX + proportionalCloseTolerance)) /
                    PROPORTIONAL_CLOSE_MAX;
            }
        }
        return amountToRepaySecond;
    }

    /**
     * @notice Caps stored suppliedPrincipalVTokens to the position account's DSA vToken balance and emits if updated.
     * @dev Only meaningful when DSA == long: external liquidations can seize vTokens without updating this contract,
     *      so stored suppliedPrincipalVTokens may exceed the actual balance. This sync keeps state consistent.
     * @param position Position to sync (suppliedPrincipalVTokens and positionAccount must be set)
     */
    function _syncSuppliedPrincipal(Position storage position) internal {
        uint256 vTokenBalance = IVToken(position.dsaVToken).balanceOf(position.positionAccount);
        if (position.suppliedPrincipalVTokens > vTokenBalance) {
            uint256 oldSuppliedPrincipal = position.suppliedPrincipalVTokens;
            position.suppliedPrincipalVTokens = vTokenBalance;
            emit RefreshedSuppliedPrincipal(
                position.user,
                position.positionAccount,
                oldSuppliedPrincipal,
                vTokenBalance
            );
        }
    }

    /**
     * @notice Converts supplied principal to underlying amount, handling DSA==long and DSA!=long cases
     * @dev When DSA != long asset, all DSA underlying on the position account is considered principal,
     *      so we can read it directly. When DSA == long asset, we must use the stored principal vTokens
     *      to avoid counting long collateral as principal.
     *
     *      DESIGN INVARIANT: External transfers to PositionAccount are not included in the design.
     *      All transfers to PositionAccount must be routed through this contract only.
     *
     * @param position The position data (holds suppliedPrincipalVTokens and positionAccount)
     * @return balance of principal in underlying units
     */
    function _getSuppliedPrincipalBalance(Position storage position) internal returns (uint256) {
        address positionAccount = position.positionAccount;
        if (positionAccount == address(0)) revert ZeroAddress();

        IVToken longVToken = IVToken(position.longVToken);
        IVToken dsaVToken = IVToken(position.dsaVToken);

        // When DSA == long, principal is tracked in vTokens to separate it from long collateral.
        if (address(dsaVToken) == address(longVToken)) {
            _syncSuppliedPrincipal(position);
            uint256 exchangeRate = dsaVToken.exchangeRateCurrent();
            return (position.suppliedPrincipalVTokens * exchangeRate) / MANTISSA_ONE;
        }

        // DSA and long are different assets: all DSA underlying on the position is principal.
        return dsaVToken.balanceOfUnderlying(positionAccount);
    }

    /**
     * @notice Gets the actual long collateral balance, excluding DSA principal if DSA == long asset
     * @param position The position data
     * @return longBalance The actual long collateral balance in underlying (excluding DSA principal if DSA == long)
     */
    function _getLongCollateralBalance(Position storage position) internal returns (uint256 longBalance) {
        address positionAccount = position.positionAccount;
        if (positionAccount == address(0)) revert ZeroAddress();

        IVToken longVToken = IVToken(position.longVToken);
        IVToken dsaVToken = IVToken(position.dsaVToken);

        if (address(longVToken) == address(dsaVToken)) {
            // Same asset: sync supplied principal, then long collateral = vToken balance minus supplied principal.
            _syncSuppliedPrincipal(position);
            uint256 vTokenBalance = longVToken.balanceOf(positionAccount);
            uint256 longVTokensNet = vTokenBalance - position.suppliedPrincipalVTokens;
            if (longVTokensNet == 0) return 0;
            uint256 exchangeRate = longVToken.exchangeRateCurrent();
            return (longVTokensNet * exchangeRate) / MANTISSA_ONE;
        }

        return longVToken.balanceOfUnderlying(positionAccount);
    }

    /**
     * @notice Returns USD values of long collateral, short debt (borrow), and supplied principal
     * @param position The position data (longVToken, shortVToken, dsaVToken read from position)
     * @return values Struct with longValueUSD, borrowValueUSD, suppliedPrincipalUSD, dsaPrice, shortPrice
     */
    function _getPositionValuesUSD(Position storage position) internal returns (PositionValuesUSD memory values) {
        IVToken longVToken = IVToken(position.longVToken);
        IVToken shortVToken = IVToken(position.shortVToken);
        IVToken dsaVToken = IVToken(position.dsaVToken);
        address positionAccount = position.positionAccount;
        uint256 longCollateral = _getLongCollateralBalance(position);
        uint256 shortDebt = shortVToken.borrowBalanceCurrent(positionAccount);
        uint256 suppliedPrincipal = _getSuppliedPrincipalBalance(position);

        ResilientOracleInterface oracle = COMPTROLLER.oracle();
        uint256 longPrice = oracle.getUnderlyingPrice(address(longVToken));
        values.shortPrice = oracle.getUnderlyingPrice(address(shortVToken));
        values.dsaPrice = oracle.getUnderlyingPrice(address(dsaVToken));

        if (longPrice == 0 || values.shortPrice == 0 || values.dsaPrice == 0) {
            revert InvalidOraclePrice();
        }

        values.longValueUSD = (longCollateral * longPrice) / MANTISSA_ONE;
        values.borrowValueUSD = (shortDebt * values.shortPrice) / MANTISSA_ONE;
        values.suppliedPrincipalUSD = (suppliedPrincipal * values.dsaPrice) / MANTISSA_ONE;
    }

    /**
     * @notice Returns the DSA vToken for a given index; validates address and market listed. Only used at activation.
     * @param dsaIndex Index of the DSA vToken in the dsaVTokens array
     * @return dsaVToken The validated DSA vToken market
     */
    function _getValidatedDSAVToken(uint8 dsaIndex) internal view returns (IVToken dsaVToken) {
        if (dsaIndex >= dsaVTokenIndexCounter) revert InvalidDSA();
        address dsaVTokenAddr = dsaVTokens[dsaIndex];
        if (!isDsaVTokenActive[dsaVTokenAddr]) revert DSAInactive();

        dsaVToken = IVToken(dsaVTokenAddr);
        _checkMarketListed(dsaVTokenAddr);
    }

    /**
     * @notice Enters a market on behalf of the user if not already a member
     * @dev Skips enter if COMPTROLLER.checkMembership(user, market) is true; otherwise calls enterMarketBehalf and reverts on failure.
     * @param user Address to enter the market on behalf of (e.g. position account)
     * @param market The vToken market to enter
     */
    function _validateAndEnterMarket(address user, IVToken market) internal {
        if (!COMPTROLLER.checkMembership(user, market)) {
            uint256 err = COMPTROLLER.enterMarketBehalf(user, address(market));
            if (err != SUCCESS) revert EnterMarketFailed(err);
        }
    }

    /**
     * @notice Computes the maximum allowed leverage: λ_max = CF_c / (1 - CF_l * (1 - f))
     * @dev c = Collateral (DSA), L = Long asset. CF_c = collateral CF, CF_l = Long asset CF, f = friction (proportionalCloseTolerance).
     * @param dsaVToken Collateral (DSA) vToken market
     * @param longVToken Long asset vToken market (CF_l)
     * @return maxLeverage The maximum leverage ratio allowed (1e18 mantissa)
     */
    function _getMaxLeverage(IVToken dsaVToken, address longVToken) internal view returns (uint256 maxLeverage) {
        (, uint256 cfC, ) = COMPTROLLER.markets(address(dsaVToken));
        if (cfC >= MANTISSA_ONE) revert InvalidCollateralFactor();

        (, uint256 cfL, ) = COMPTROLLER.markets(longVToken);
        if (cfL >= MANTISSA_ONE) revert InvalidCollateralFactor();

        // (1 - f) in mantissa: f = tolerance (slippage)
        uint256 friction = (proportionalCloseTolerance * MANTISSA_ONE) / PROPORTIONAL_CLOSE_MAX;
        uint256 oneMinusF = MANTISSA_ONE - friction;
        uint256 denom = MANTISSA_ONE - (cfL * oneMinusF) / MANTISSA_ONE; // 1 - CF_l * (1 - f)
        if (denom == 0) revert InvalidCollateralFactor();
        maxLeverage = (cfC * MANTISSA_ONE) / denom;
        if (maxLeverage < MIN_LEVERAGE) maxLeverage = MIN_LEVERAGE;
    }

    /**
     * @notice Reverts if long and short market are the same
     * @param longVToken Long market address
     * @param shortVToken Short market address
     */
    function _checkSameMarket(address longVToken, address shortVToken) internal pure {
        if (longVToken == shortVToken) revert SameMarketNotAllowed();
    }

    /**
     * @notice Validates that a market is listed in the Comptroller and is not vBNB
     * @dev Reverts with AssetNotListed if not listed, VBNBNotSupported if market is the leverage manager's vBNB.
     * @param market The vToken market address to validate
     */
    function _checkMarketListed(address market) internal view {
        if (market == address(0)) revert ZeroAddress();

        (bool isListed, , ) = COMPTROLLER.markets(market);
        if (!isListed) revert AssetNotListed();
        if (market == address(LEVERAGE_MANAGER.vBNB())) revert VBNBNotSupported();
    }

    /**
     * @notice Loads a position for a user/market pair and ensures it is active
     * @param user The position owner
     * @param longVToken Long market address
     * @param shortVToken Short market address
     * @return position The active Position storage reference
     */
    function _getActivePosition(
        address user,
        address longVToken,
        address shortVToken
    ) internal view returns (Position storage position) {
        position = positions[user][longVToken][shortVToken];
        if (!position.isActive) revert PositionNotActive();
    }

    /**
     * @notice Returns the maximum of two values
     * @param a First value
     * @param b Second value
     * @return The greater of a and b
     */
    function max(uint256 a, uint256 b) internal pure returns (uint256) {
        return a >= b ? a : b;
    }

    /**
     * @notice Returns the minimum of two values
     * @param a First value
     * @param b Second value
     * @return The lesser of a and b
     */
    function min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a <= b ? a : b;
    }

    /**
     * @notice Performs ceiling division (rounding up) for two unsigned integers
     * @param a Numerator
     * @param b Denominator
     * @return result Ceiling of a / b
     */
    function ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return (a + b - 1) / b;
    }
}
