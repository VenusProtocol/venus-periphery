// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import { PausableUpgradeable } from "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
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
contract RelativePositionManager is
    AccessControlledV8,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    IRelativePositionManager
{
    using SafeERC20Upgradeable for IERC20Upgradeable;

    /// @dev Success return value for Comptroller operations (e.g. enterMarketBehalf)
    uint256 private constant SUCCESS = 0;

    /// @dev Mantissa for fixed-point arithmetic (MANTISSA_ONE = 100%)
    uint256 private constant MANTISSA_ONE = 1e18;

    /// @dev Minimum leverage ratio (1x)
    uint256 private constant MIN_LEVERAGE = MANTISSA_ONE;

    /// @dev Proportional close in percentage: 100 = 100%, 1 = 1% minimum
    uint256 private constant PROPORTIONAL_CLOSE_MIN = 1;
    uint256 private constant PROPORTIONAL_CLOSE_MAX = 100;

    /// @dev Tolerance for proportional close: 100 = 1% margin of error // TBD (also can make a setter for this)
    uint256 private constant PROPORTIONAL_CLOSE_TOLERANCE = 1;

    /// @notice The Venus comptroller contract
    IComptroller public immutable COMPTROLLER;

    /// @notice The leverage strategies manager contract
    LeverageStrategiesManager public immutable LEVERAGE_MANAGER;

    /// @notice Implementation contract for PositionAccount clones (settable via governance)
    address public POSITION_ACCOUNT_IMPLEMENTATION;

    /// @notice Counter / next index for newly added DSA vTokens (also equals current count)
    uint8 public dsaVTokenIndexCounter;

    /// @notice Mapping from DSA index to supported DSA (Default Settlement Asset) vToken markets
    mapping(uint8 => address) public dsaVTokens;

    /// @notice Tracks whether a given DSA vToken is currently active for new activations
    mapping(address => bool) public isDsaVTokenActive;

    /// @notice Mapping from user => longAsset => shortAsset => Position data
    mapping(address => mapping(address => mapping(address => Position))) public positions;

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
        __Pausable_init();
    }

    /**
     * @notice Pauses state-changing user operations on the manager (activation, opening/closing, principal changes)
     * @dev Callable only by governance via AccessControlManager. View and admin functions remain available.
     */
    function pause() external {
        _checkAccessAllowed("pause()");
        _pause();
    }

    /**
     * @notice Unpauses state-changing user operations on the manager
     * @dev Callable only by governance via AccessControlManager.
     */
    function unpause() external {
        _checkAccessAllowed("unpause()");
        _unpause();
    }

    /**
     * @notice Updates the implementation contract used for PositionAccount clones
     * @dev Callable only by governance via AccessControlManager. Must be set before any positions are activated.
     * @param positionAccountImpl Implementation contract for PositionAccount EIP-1167 clones
     * @custom:error Throw ZeroAddress if positionAccountImpl is zero.
     * @custom:error Throw SamePositionAccountImplementation if the implementation is unchanged.
     * @custom:event Emits PositionAccountImplementationUpdated event.
     */
    function setPositionAccountImplementation(address positionAccountImpl) external {
        _checkAccessAllowed("setPositionAccountImplementation(address)");

        if (positionAccountImpl == address(0)) {
            revert ZeroAddress();
        }

        address oldImpl = POSITION_ACCOUNT_IMPLEMENTATION;
        if (oldImpl == positionAccountImpl) {
            revert SamePositionAccountImplementation();
        }

        POSITION_ACCOUNT_IMPLEMENTATION = positionAccountImpl;
        emit PositionAccountImplementationUpdated(oldImpl, positionAccountImpl);
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
    ) external {
        _checkAccessAllowed("executePositionAccountCall(address,address[],bytes[])");
        IPositionAccount(positionAccount).genericCalls(targets, data);
    }

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
     * @custom:error Throw ZeroAddress if longVToken or shortVToken is zero.
     * @custom:error Throw SameMarketNotAllowed if long and short vTokens are identical.
     * @custom:error Throw AssetNotListed if a market is not listed.
     * @custom:error Throw InvalidDSA if dsaIndex is invalid or market not listed.
     * @custom:error Throw DSAInactive if the chosen DSA vToken is configured but not active for new activations.
     * @custom:error Throw InvalidLeverage if effectiveLeverage is out of range.
     * @custom:error Throw PositionAlreadyExists if the position is already active.
     * @custom:error Throw EnterMarketFailed if entering the DSA market on behalf fails.
     * @custom:error Throw MintBehalfFailed if minting initial principal fails.
     * @custom:event Emits PositionActivated or PositionAccountDeployed (if new account) and possibly PrincipalSupplied.
     */
    function activatePosition(
        address longVToken,
        address shortVToken,
        uint8 dsaIndex,
        uint256 initialPrincipal,
        uint256 effectiveLeverage
    ) external nonReentrant whenNotPaused {
        _checkSameMarket(longVToken, shortVToken);
        _checkMarketListed(longVToken);
        _checkMarketListed(shortVToken);

        // Validate and resolve DSA vToken from index
        IVToken dsaVToken = _getValidatedDSAVToken(dsaIndex);

        // Validate requested leverage against [MIN_LEVERAGE, maxLeverageForDSA], where
        // maxLeverageForDSA is derived from the DSA collateral factor as 1 / (1 - CF),
        uint256 maxLeverageForDsa = _getMaxLeverageForDSA(dsaVToken);
        if (effectiveLeverage < MIN_LEVERAGE || effectiveLeverage > maxLeverageForDsa) {
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

        if (initialPrincipal > 0) {
            _supplyPrincipalToPositionAccount(position, dsaVToken, initialPrincipal);
        }

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
     * @notice Supplies additional principal to an active position
     * @dev Can be called multiple times to increase collateral. DSA is taken from the position (set on activation).
     * @param longVToken The vToken market address for the long asset
     * @param shortVToken The vToken market address for the short asset
     * @param amount Amount of DSA underlying to supply
     * @custom:error Throw ZeroAmount if amount is zero.
     * @custom:error Throw PositionNotActive if the position is not active.
     * @custom:event Emits PrincipalSupplied event.
     */
    function supplyPrincipal(
        address longVToken,
        address shortVToken,
        uint256 amount
    ) public nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        Position storage position = positions[msg.sender][longVToken][shortVToken];

        if (!position.isActive) revert PositionNotActive();
        _supplyPrincipalToPositionAccount(position, IVToken(position.dsaVToken), amount);
    }

    /**
     * @notice Opens a leveraged position or scales an existing one (borrow short, swap to long)
     * @dev Can be called multiple times to scale the position. Optionally supply additional principal
     *      via additionalPrincipal; otherwise uses existing principal. Requires either existing principal
     *      (from activation or prior supply) or additionalPrincipal > 0. Validates that shortAmount
     *      doesn't exceed the maximum allowed based on capital utilization. DSA is taken from the position (set on activation).
     * @param longVToken The vToken market for the asset to long
     * @param shortVToken The vToken market for the asset to short
     * @param additionalPrincipal Additional principal to supply this call (0 if none)
     * @param shortAmount Amount to borrow in shortAsset terms (must not exceed max calculated borrow)
     * @param minLongAmount Minimum amount of long asset expected from swap (protects against slippage)
     * @param swapData Swap instructions for converting shortAsset to longAsset
     * @custom:error Throw ZeroBorrowAmount if shortAmount is zero.
     * @custom:error Throw PositionNotActive if the position is not active.
     * @custom:error Throw InsufficientPrincipal if no principal exists and additionalPrincipal is zero.
     * @custom:error Throw BorrowAmountExceedsMaximum if shortAmount exceeds max allowed borrow.
     * @custom:event Emits PositionOpened event (and PrincipalSupplied if additionalPrincipal > 0).
     */
    function openPosition(
        IVToken longVToken,
        IVToken shortVToken,
        uint256 additionalPrincipal,
        uint256 shortAmount,
        uint256 minLongAmount,
        bytes calldata swapData
    ) external nonReentrant whenNotPaused {
        _checkSameMarket(address(longVToken), address(shortVToken));
        if (shortAmount == 0) revert ZeroBorrowAmount();

        Position storage position = positions[msg.sender][address(longVToken)][address(shortVToken)];

        if (!position.isActive) revert PositionNotActive();

        // Must have principal (existing or supplied this call) to collateralize the borrow
        if (position.suppliedPrincipal == 0 && additionalPrincipal == 0) revert InsufficientPrincipal();

        IVToken dsaVToken = IVToken(position.dsaVToken);

        if (additionalPrincipal > 0) {
            _supplyPrincipalToPositionAccount(position, dsaVToken, additionalPrincipal);
        }

        uint256 maxBorrowAmount = _calculateMaxBorrowAllowed(position);
        if (shortAmount > maxBorrowAmount) revert BorrowAmountExceedsMaximum();

        address positionAccount = position.positionAccount;

        IPositionAccount(positionAccount).enterLeverage(
            longVToken,
            0, // no collateral seed; DSA is used as Seed
            shortVToken,
            shortAmount,
            minLongAmount,
            swapData
        );

        // Transfer any dust from LM (sent to position account) to user
        _transferDustFromAccountToUser(positionAccount, longVToken.underlying());
        _transferDustFromAccountToUser(positionAccount, shortVToken.underlying());

        emit PositionOpened(
            msg.sender,
            positionAccount,
            position.cycleId,
            address(longVToken),
            address(shortVToken),
            address(dsaVToken),
            shortAmount,
            additionalPrincipal
        );
    }

    /**
     * @notice Closes a position proportionally; can realize profit on the closed slice (partial or full)
     * @dev Repay amount is derived from BPS (not passed). Total long (repay + profit) is validated against BPS (1% tolerance).
     *      minAmountOutRepay must be >= calculated repay amount (slippage protection).
     *      Principal (DSA) collateral is not touched directly by this function; any unused principal remains on the
     *      position account, withdrawn later via `withdrawPrincipal`, or fully swept
     *      on `deactivatePosition`.
     * @param longVToken The vToken market for the long asset
     * @param shortVToken The vToken market for the short asset
     * @param closeFractionBps Proportion to close in percentage (100 = 100%, 1 = 1% minimum)
     * @param longAmountToRedeemForRepay Amount of long to redeem for the repay leg (validated against BPS)
     * @param minAmountOutRepay Minimum short out from the repay swap (must be >= calculated repay amount for this BPS)
     * @param swapDataRepay Swap #1: long → short for debt repayment
     * @param longAmountToRedeemForProfit Amount of long to redeem and swap long→DSA as profit (can be non-zero for partial or full close)
     * @param minAmountOutProfit Minimum DSA out from the profit swap
     * @param swapDataProfit Swap #2: long → DSA for profit realization
     * @custom:error Throw PositionNotActive if the position is not active.
     * @custom:error Throw SameMarketNotAllowed if long and short vTokens are identical.
     * @custom:error Throw InvalidCloseFractionBps if closeFractionBps is not between 1 and 100.
     * @custom:error Throw MinAmountOutRepayBelowDebt if minAmountOutRepay is below the calculated short debt for this close.
     * @custom:error Throw ProportionalCloseAmountOutOfTolerance if total long amounts are not within the tolerated BPS band.
     * @custom:error Throw RedeemBehalfFailed if profit redemption fails.
     * @custom:error Throw TokenSwapCallFailed if the swap helper call fails, or SlippageExceeded if swap output is too low.
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
    ) external nonReentrant whenNotPaused {
        _checkSameMarket(address(longVToken), address(shortVToken));

        Position storage position = positions[msg.sender][address(longVToken)][address(shortVToken)];
        if (!position.isActive) revert PositionNotActive();

        uint256 amountToRepay = _validateProfitClose(
            position,
            closeFractionBps,
            longAmountToRedeemForRepay + longAmountToRedeemForProfit,
            minAmountOutRepay
        );

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

        uint256 longDustRedeemed = 0;
        if (closeFractionBps == PROPORTIONAL_CLOSE_MAX) {
            if (shortVToken.borrowBalanceCurrent(positionAccount) > 0) revert PositionNotFullyClosed();
            longDustRedeemed = _getLongCollateralBalance(position);
            _redeemUnderlyingToUser(longVToken, positionAccount, longDustRedeemed);
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
     * @notice Closes a position with loss proportionally (BPS-based, same pattern as closeWithProfit)
     * @dev
     *      - First exit (long → short): long/short amounts are derived from BPS; the user passes shortAmountToRepayForFirstSwap,
     *        which is validated to be within [0, expectedShort] and minAmountOutFirst must be >= shortAmountToRepayForFirstSwap.
     *      - Second exit (DSA → short): the second repay amount is fully calculated in the contract as
     *        `expectedShort - shortAmountToRepayForFirstSwap`; minAmountOutSecond only bounds the swap output and must be
     *        >= this internally calculated repay amount (slippage protection).
     *      - Single-leg scenarios: this function also supports cases where only one leg (long or DSA) is available
     *        (e.g. after liquidation), by allowing either the first or second exit to be effectively skipped
     *        (amounts set to zero).
     *      - Principal handling: any remaining principal (DSA) that is not consumed in the loss scenario stays on the
     *        position account even after a full close; it can later be moved to the user by calling `withdrawPrincipal`
     *        or by calling `deactivatePosition`, which fully redeems remaining DSA collateral to the user.
     * @param longVToken The vToken market for the long asset
     * @param shortVToken The vToken market for the short asset
     * @param closeFractionBps Proportion to close in percentage (100 = 100%, 1 = 1% minimum)
     * @param longAmountToRedeemForFirstSwap Long amount to redeem for the first swap (validated against BPS within 1% tolerance)
     * @param shortAmountToRepayForFirstSwap Short amount to repay in the first exit (validated: 0 <= value <= BPS-derived expected short)
     * @param minAmountOutFirst Minimum short out from the first swap (must be >= shortAmountToRepayForFirstSwap)
     * @param swapDataFirst Swap #1 calldata: long/DSA → short for the first repay leg
     * @param dsaAmountToRedeemForSecondSwap DSA amount to redeem and use as input for the second repay swap
     * @param minAmountOutSecond Minimum short out from the second swap (must be >= internally calculated second repay)
     * @param swapDataSecond Swap #2 calldata: DSA → short for the second repay leg
     * @custom:error Throw PositionNotActive if the position is not active.
     * @custom:error Throw SameMarketNotAllowed if long and short vTokens are identical.
     * @custom:error Throw ZeroDebt if there is no short debt to close.
     * @custom:error Throw InvalidCloseFractionBps if closeFractionBps is not between 1 and 100.
     * @custom:error Throw MinAmountOutRepayBelowDebt if minAmountOutFirst is below shortAmountToRepayForFirstSwap.
     * @custom:error Throw ProportionalCloseAmountOutOfTolerance if first-exit amounts are not within the tolerated BPS band.
     * @custom:error Throw MinAmountOutSecondBelowDebt if minAmountOutSecond is below the internally calculated second repay.
     * @custom:error Throw InsufficientWithdrawableAmount if dsaAmountToRedeemForSecondSwap exceeds available DSA principal.
     * @custom:error Throw RedeemBehalfFailed if redeeming long or DSA vTokens on behalf fails.
     * @custom:error Throw TokenSwapCallFailed if a swap helper call fails, or SlippageExceeded if swap output is too low.
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
    ) external nonReentrant whenNotPaused {
        _checkSameMarket(address(longVToken), address(shortVToken));

        Position storage position = positions[msg.sender][address(longVToken)][address(shortVToken)];
        if (!position.isActive) revert PositionNotActive();
        address positionAccount = position.positionAccount;
        if (shortVToken.borrowBalanceCurrent(positionAccount) == 0) revert ZeroDebt();

        // When using DSA principal to repay in the second leg, ensure the requested amount does not exceed
        // the available principal balance (and later update principal accounting accordingly).
        IVToken dsaVToken = IVToken(position.dsaVToken);
        if (dsaAmountToRedeemForSecondSwap > 0) {
            uint256 principalUnderlying = _getSuppliedPrincipalBalance(position);
            if (dsaAmountToRedeemForSecondSwap > principalUnderlying) revert InsufficientWithdrawableAmount();
        }

        uint256 amountToRepaySecond = _validateLossClose(
            position,
            closeFractionBps,
            longAmountToRedeemForFirstSwap,
            shortAmountToRepayForFirstSwap,
            minAmountOutFirst,
            minAmountOutSecond
        );

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

        // 2. Second exitLeverage (DSA → short): amountToRepaySecond = shortDebt - borrowedAmountToRepayFirst
        if (amountToRepaySecond > 0) {
            uint256 vTokensBefore = dsaVToken.balanceOf(positionAccount);
            IPositionAccount(positionAccount).exitLeverage(
                dsaVToken,
                dsaAmountToRedeemForSecondSwap,
                shortVToken,
                amountToRepaySecond,
                minAmountOutSecond,
                swapDataSecond
            );
            uint256 vTokensAfter = dsaVToken.balanceOf(positionAccount);
            // Reduce suppliedPrincipal by the vTokens actually burned from DSA for this repay leg
            position.suppliedPrincipal -= (vTokensBefore - vTokensAfter);
            _transferDustFromAccountToUser(positionAccount, dsaVToken.underlying());
        }

        // Transfer any dust from LM (sent to position account) to user
        _transferDustFromAccountToUser(positionAccount, longVToken.underlying());
        _transferDustFromAccountToUser(positionAccount, shortVToken.underlying());

        uint256 longDustRedeemed = 0;
        if (closeFractionBps == PROPORTIONAL_CLOSE_MAX) {
            if (shortVToken.borrowBalanceCurrent(positionAccount) > 0) revert PositionNotFullyClosed();
            longDustRedeemed = _getLongCollateralBalance(position);
            _redeemUnderlyingToUser(longVToken, positionAccount, longDustRedeemed);
        }

        emit PositionClosed(
            msg.sender,
            positionAccount,
            position.cycleId,
            closeFractionBps,
            shortAmountToRepayForFirstSwap + amountToRepaySecond,
            longAmountToRedeemForFirstSwap,
            dsaAmountToRedeemForSecondSwap,
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
     * @custom:error Throw ZeroAddress if no position account exists for this user/markets pair.
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
        Position storage position = positions[msg.sender][address(longVToken)][address(shortVToken)];
        address positionAccount = position.positionAccount;
        if (positionAccount == address(0)) revert ZeroAddress();
        if (!position.isActive) revert PositionNotActive();
        if (amount == 0) revert ZeroAmount();

        // Active: redeem only based on utilization
        UtilizationInfo memory utilization = _getUtilizationInfo(position);
        if (amount > utilization.withdrawableAmount) revert InsufficientWithdrawableAmount();

        IVToken dsaVToken = IVToken(position.dsaVToken);
        uint256 vTokensBefore = dsaVToken.balanceOf(positionAccount);
        _redeemUnderlyingToUser(dsaVToken, positionAccount, amount);
        uint256 vTokensAfter = dsaVToken.balanceOf(positionAccount);

        position.suppliedPrincipal -= (vTokensBefore - vTokensAfter);

        emit PrincipalWithdrawn(msg.sender, positionAccount, address(dsaVToken), amount, position.suppliedPrincipal);
    }

    /**
     * @notice Deactivates a position account
     * @dev Reverts if position still has long collateral or short debt (PositionNotFullyClosed).
     *      Withdraws all remaining DSA principal to the user, then sets isActive False.
     *      User may activate again later (possibly with a different DSA via dsaIndex).
     * @param longVToken The vToken market for the long asset
     * @param shortVToken The vToken market for the short asset
     * @custom:error Throw PositionNotActive if the position is not active.
     * @custom:error Throw PositionNotFullyClosed if long collateral or short debt remains.
     * @custom:event Emits PositionDeactivated event.
     */
    function deactivatePosition(IVToken longVToken, IVToken shortVToken) external nonReentrant whenNotPaused {
        Position storage position = positions[msg.sender][address(longVToken)][address(shortVToken)];

        if (!position.isActive) revert PositionNotActive();
        address positionAccount = position.positionAccount;

        // Check that position is fully closed: no long collateral and no short debt
        uint256 longCollateral = _getLongCollateralBalance(position);
        uint256 shortDebt = shortVToken.borrowBalanceCurrent(positionAccount);

        if (longCollateral > 0 || shortDebt > 0) revert PositionNotFullyClosed();
        IVToken dsaVToken = IVToken(position.dsaVToken);

        // Withdraw any remaining DSA principal to user
        position.isActive = false;
        position.suppliedPrincipal = 0;
        uint256 underlyingBalance = dsaVToken.balanceOfUnderlying(positionAccount);
        _redeemUnderlyingToUser(dsaVToken, positionAccount, underlyingBalance);
        emit PositionDeactivated(msg.sender, positionAccount, position.cycleId, address(dsaVToken), underlyingBalance);
    }

    /**
     * @notice Returns the address at which the PositionAccount would be deployed for the given user and markets
     * @dev Uses the same salt as _deployPositionAccount (keccak256(user, longVToken, shortVToken)).
     *      Returns the address that cloneDeterministic would deploy to if called by this contract.
     * @param user User address
     * @param longVToken The vToken market for the long asset
     * @param shortVToken The vToken market for the short asset
     * @return predicted The predicted PositionAccount address (same as after activatePosition for that user/long/short)
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
     * @return position The Position struct (user, longVToken, shortVToken, dsaIndex, dsaVToken, positionAccount, suppliedPrincipal, effectiveLeverage, cycleId, isActive)
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
        Position memory position = positions[user][address(longVToken)][address(shortVToken)];
        return _getUtilizationInfo(position);
    }

    /**
     * @notice Calculates the maximum allowed borrow amount for a position
     * @dev Uses getUtilizationInfo internally. See IRelativePositionManager for full description.
     * @param user User address
     * @param longVToken The vToken market for the long asset
     * @param shortVToken The vToken market for the short asset
     * @return maxBorrowAmount Maximum amount that can be borrowed in shortAsset terms
     */
    function calculateMaxBorrow(
        address user,
        IVToken longVToken,
        IVToken shortVToken
    ) external returns (uint256 maxBorrowAmount) {
        Position memory position = positions[user][address(longVToken)][address(shortVToken)];
        return _calculateMaxBorrowAllowed(position);
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
     * @notice Redeems a given amount of long from the position account and swaps it to DSA,
     *         then supplies the resulting DSA as additional principal on the same position.
     * @dev Used for proportional close with profit: partial or full close can have a "profit" slice converted
     *      into DSA principal. Does not require zero short debt (unlike _realizeProfitFromExcessLong).
     *      When DSA and long share the same vToken market, no redeem/mint cycle is required; the function
     *      simply reclassifies part of the long collateral as principal in storage.
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
            uint256 err = longVToken.redeemUnderlyingBehalf(positionAccount, amountToRedeem);
            if (err != SUCCESS) revert RedeemBehalfFailed(err);

            uint256 amountOut = _performSwap(
                longUnderlying,
                amountToRedeem,
                dsaUnderlying,
                minAmountOutProfit,
                swapDataProfit
            );

            // Supply the received DSA underlying as additional principal to the same position account.
            uint256 balanceBefore = dsaVToken.balanceOf(positionAccount);
            dsaUnderlying.forceApprove(address(dsaVToken), amountOut);
            uint256 mintError = dsaVToken.mintBehalf(positionAccount, amountOut);
            if (mintError != SUCCESS) revert MintBehalfFailed(mintError);
            uint256 balanceAfter = dsaVToken.balanceOf(positionAccount) - balanceBefore;

            vTokensMinted = balanceAfter;
        }

        // Update principal state
        position.suppliedPrincipal += vTokensMinted;
        emit ProfitConverted(position.user, positionAccount, amountToRedeem, position.suppliedPrincipal);
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
        uint256 err = vToken.redeemUnderlyingBehalf(fromAccount, amount);
        if (err != SUCCESS) revert RedeemBehalfFailed(err);
        IERC20Upgradeable underlying = IERC20Upgradeable(vToken.underlying());
        uint256 balance = underlying.balanceOf(address(this));
        if (balance > 0) {
            underlying.safeTransfer(msg.sender, balance);
            emit UnderlyingTransferred(address(underlying), fromAccount, msg.sender, balance);
        }
    }

    /**
     * @notice Transfers DSA underlying from msg.sender to this contract, approves and mints vTokens to the position account
     * @param position The position whose principal should be increased
     * @param dsaVToken The DSA vToken market
     * @param amount Amount of underlying to transfer and mint
     */
    function _supplyPrincipalToPositionAccount(Position storage position, IVToken dsaVToken, uint256 amount) internal {
        address positionAccount = position.positionAccount;
        uint256 balanceBefore = dsaVToken.balanceOf(positionAccount);
        address underlying = dsaVToken.underlying();
        IERC20Upgradeable(underlying).safeTransferFrom(msg.sender, address(this), amount);
        IERC20Upgradeable(underlying).forceApprove(address(dsaVToken), amount);
        uint256 mintError = dsaVToken.mintBehalf(positionAccount, amount);
        if (mintError != SUCCESS) revert MintBehalfFailed(mintError);
        uint256 vTokensMinted = dsaVToken.balanceOf(positionAccount) - balanceBefore;
        position.suppliedPrincipal += vTokensMinted;

        emit PrincipalSupplied(
            position.user,
            positionAccount,
            position.cycleId,
            address(dsaVToken),
            amount,
            position.suppliedPrincipal
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

        (bool success, ) = swapHelperAddr.call(param);
        if (!success) revert TokenSwapCallFailed();

        uint256 tokenOutBalanceAfter = tokenOut.balanceOf(address(this));
        amountOut = tokenOutBalanceAfter - tokenOutBalanceBefore;
        if (amountOut < minAmountOut) revert SlippageExceeded();

        return amountOut;
    }

    /**
     * @notice Calculates the maximum allowed borrow amount for a position
     * @param position In-memory snapshot of the position data
     * @return maxBorrowAmount Maximum amount that can be borrowed in shortAsset terms
     */
    function _calculateMaxBorrowAllowed(Position memory position) internal returns (uint256 maxBorrowAmount) {
        // Get utilization info which calculates available capital (DSA from position)
        UtilizationInfo memory utilization = _getUtilizationInfo(position);

        // Calculate max additional borrow amount: availableCapital * effectiveLeverage
        uint256 maxAdditionalBorrowUSD = (utilization.availableCapitalUSD * position.effectiveLeverage) / MANTISSA_ONE;

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
     * @return utilization Struct with actualCapitalUtilized, nominalCapitalUtilized, finalCapitalUtilized, availableCapitalUSD, withdrawableAmount
     */
    function _getUtilizationInfo(Position memory position) internal returns (UtilizationInfo memory utilization) {
        IVToken longVToken = IVToken(position.longVToken);
        PositionValuesUSD memory values = _getPositionValuesUSD(position);
        IVToken dsaVToken = IVToken(position.dsaVToken);

        (, uint256 dsaCF, ) = COMPTROLLER.markets(address(dsaVToken));
        (, uint256 longCF, ) = COMPTROLLER.markets(address(longVToken));

        // Calculate nominalCapitalUtilized borrowValueUSD/effectiveLeverage
        utilization.nominalCapitalUtilized = (values.borrowValueUSD * MANTISSA_ONE) / position.effectiveLeverage;

        // Calculate actualCapitalUtilized (borrowValueUSD - (longValueUSD * longCF) / dsaCF
        utilization.actualCapitalUtilized = values.borrowValueUSD > (values.longValueUSD * longCF) / MANTISSA_ONE
            ? ((values.borrowValueUSD - (values.longValueUSD * longCF) / MANTISSA_ONE) * MANTISSA_ONE) / dsaCF
            : 0;

        utilization.finalCapitalUtilized = max(utilization.actualCapitalUtilized, utilization.nominalCapitalUtilized);
        utilization.finalCapitalUtilized = min(values.suppliedPrincipalUSD, utilization.finalCapitalUtilized);

        // Calculate available capital in USD (finalCapitalUtilized is already capped by suppliedPrincipal)
        utilization.availableCapitalUSD = values.suppliedPrincipalUSD - utilization.finalCapitalUtilized;

        // Calculate withdrawable amount in DSA token terms
        utilization.withdrawableAmount = (utilization.availableCapitalUSD * MANTISSA_ONE) / values.dsaPrice;
    }

    /**
     * @notice Converts supplied principal to underlying amount, handling DSA==long and DSA!=long cases
     * @dev When DSA != long asset, all DSA underlying on the position account is considered principal,
     *      so we can read it directly. When DSA == long asset, we must use the stored principal vTokens
     *      to avoid counting long collateral as principal.
     * @param position The position data (holds suppliedPrincipal and positionAccount)
     * @return balance of principal in underlying units
     */
    function _getSuppliedPrincipalBalance(Position memory position) internal returns (uint256) {
        if (position.suppliedPrincipal == 0) return 0;

        address positionAccount = position.positionAccount;
        if (positionAccount == address(0)) revert ZeroAddress();

        IVToken longVToken = IVToken(position.longVToken);
        IVToken dsaVToken = IVToken(position.dsaVToken);

        // When DSA == long, principal is tracked in vTokens to separate it from long collateral.
        if (address(dsaVToken) == address(longVToken)) {
            uint256 exchangeRate = dsaVToken.exchangeRateCurrent();
            return (position.suppliedPrincipal * exchangeRate) / MANTISSA_ONE;
        }

        // DSA and long are different assets: all DSA underlying on the position is principal.
        return dsaVToken.balanceOfUnderlying(positionAccount);
    }

    /**
     * @notice Returns expected proportional amounts and tolerance band for a close (BPS of current balance/debt)
     * @dev Reverts with InvalidCloseFractionBps if closeFractionBps is not in [1, 100].
     * @param position The position (long balance and positionAccount from position; short debt from position.shortVToken)
     * @param closeFractionBps Proportion to close in percentage (100 = 100%, 1 = 1% minimum)
     * @return expectedLongToWithdraw Amount of long to redeem (BPS of current long balance)
     * @return expectedShortToRepay Amount of short to repay (BPS of current short debt)
     * @return minLongToWithdraw Minimum long amount within PROPORTIONAL_CLOSE_TOLERANCE
     * @return maxLongToWithdraw Maximum long amount within PROPORTIONAL_CLOSE_TOLERANCE
     */
    function _getProportionalCloseAmounts(
        Position memory position,
        uint256 closeFractionBps
    )
        internal
        returns (
            uint256 expectedLongToWithdraw,
            uint256 expectedShortToRepay,
            uint256 minLongToWithdraw,
            uint256 maxLongToWithdraw
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
            (expectedLongToWithdraw * (PROPORTIONAL_CLOSE_MAX - PROPORTIONAL_CLOSE_TOLERANCE)) / PROPORTIONAL_CLOSE_MAX;
        maxLongToWithdraw =
            (expectedLongToWithdraw * (PROPORTIONAL_CLOSE_MAX + PROPORTIONAL_CLOSE_TOLERANCE)) / PROPORTIONAL_CLOSE_MAX;
    }

    /**
     * @notice Validates proportional close for profit path and returns amount to repay
     * @dev Validates totalLongAmountToRedeem (repay + profit) within 1% of BPS expected. Reverts if out of band.
     * @param totalLongAmountToRedeem Sum of long to redeem for repay and for profit swap (collateralAmountToRedeem + amountToRedeemForProfitSwap)
     * @param minAmountOutRepay User's minimum expected short from repay swap; validated against exact expected short (not bumped)
     * @return amountToRepay Short amount to use for repay call (includes 100% tolerance bump when applicable)
     */
    function _validateProfitClose(
        Position memory position,
        uint256 closeFractionBps,
        uint256 totalLongAmountToRedeem,
        uint256 minAmountOutRepay
    ) internal returns (uint256 amountToRepay) {
        (
            uint256 expectedLongToWithdraw,
            uint256 expectedShortToRepay,
            uint256 minLongToWithdraw,
            uint256 maxLongToWithdraw
        ) = _getProportionalCloseAmounts(position, closeFractionBps);
        if (expectedLongToWithdraw == 0 && totalLongAmountToRedeem != 0) revert NonZeroLongAmountWhenExpectedZero();
        if (totalLongAmountToRedeem < minLongToWithdraw || totalLongAmountToRedeem > maxLongToWithdraw)
            revert ProportionalCloseAmountOutOfTolerance();
        // Validate minAmountOut against exact expected short (not bumped)
        if (expectedShortToRepay > 0 && minAmountOutRepay < expectedShortToRepay) revert MinAmountOutRepayBelowDebt();
        amountToRepay = expectedShortToRepay;
        // For 100% close, add tolerance so we send slightly more to cover interest during flash loan; LM caps actual repay to current debt
        if (closeFractionBps == PROPORTIONAL_CLOSE_MAX && expectedShortToRepay > 0) {
            amountToRepay =
                (expectedShortToRepay * (PROPORTIONAL_CLOSE_MAX + PROPORTIONAL_CLOSE_TOLERANCE)) /
                PROPORTIONAL_CLOSE_MAX;
        }
    }

    /**
     * @notice Validates loss close first exit and returns calculated second repay amount
     * @dev Ensures the provided first-leg long/short amounts are within the proportional-close tolerance band
     *      and derives the second-leg short repay amount (with tolerance bump for 100% closes).
     * @param position snapshot of the position (used to derive expected long/short amounts)
     * @param closeFractionBps Proportion to close in percentage (100 = 100%, 1 = 1% minimum)
     * @param shortAmountToRepayForFirstSwap Short amount to repay in the first exit (must be within tolerance of expected short)
     * @param longAmountToRedeemForFirstSwap Long amount to redeem for the first swap (must be within PROPORTIONAL_CLOSE_TOLERANCE of expected long)
     * @param minAmountOutFirst Minimum short out from the first swap (must be >= shortAmountToRepayForFirstSwap)
     * @param minAmountOutSecond Minimum short out from the second swap (must be >= internally calculated second repay)
     * @return amountToRepaySecond The second-leg short repay amount (expectedShortToRepay - shortAmountToRepayForFirstSwap)
     */
    function _validateLossClose(
        Position memory position,
        uint256 closeFractionBps,
        uint256 longAmountToRedeemForFirstSwap,
        uint256 shortAmountToRepayForFirstSwap,
        uint256 minAmountOutFirst,
        uint256 minAmountOutSecond
    ) internal returns (uint256 amountToRepaySecond) {
        if (shortAmountToRepayForFirstSwap > 0 && minAmountOutFirst < shortAmountToRepayForFirstSwap)
            revert MinAmountOutRepayBelowDebt();

        (
            ,
            uint256 expectedShortToRepay,
            uint256 minLongToWithdraw,
            uint256 maxLongToWithdraw
        ) = _getProportionalCloseAmounts(position, closeFractionBps);

        if (longAmountToRedeemForFirstSwap < minLongToWithdraw || longAmountToRedeemForFirstSwap > maxLongToWithdraw)
            revert ProportionalCloseAmountOutOfTolerance();

        // (2) First-exit short repay within BPS tolerance of expected short
        if (shortAmountToRepayForFirstSwap > expectedShortToRepay) revert ProportionalCloseAmountOutOfTolerance();

        // (3) Second repay = expectedShort - first repay; validate minAmountOutSecond against exact amount, then add tolerance for 100% close
        amountToRepaySecond = expectedShortToRepay - shortAmountToRepayForFirstSwap;
        if (amountToRepaySecond > 0 && minAmountOutSecond < amountToRepaySecond) revert MinAmountOutSecondBelowDebt();
        if (closeFractionBps == PROPORTIONAL_CLOSE_MAX && amountToRepaySecond > 0) {
            amountToRepaySecond =
                (amountToRepaySecond * (PROPORTIONAL_CLOSE_MAX + PROPORTIONAL_CLOSE_TOLERANCE)) /
                PROPORTIONAL_CLOSE_MAX;
        }
    }

    /**
     * @notice Gets the actual long collateral balance, excluding DSA principal if DSA == long asset
     * @param position The position data (longVToken read from position)
     * @return longBalance The actual long collateral balance in underlying (excluding DSA principal if DSA == long)
     */
    function _getLongCollateralBalance(Position memory position) internal returns (uint256 longBalance) {
        address positionAccount = position.positionAccount;
        if (positionAccount == address(0)) revert ZeroAddress();

        IVToken longVToken = IVToken(position.longVToken);
        IVToken dsaVToken = IVToken(position.dsaVToken);

        if (address(longVToken) == address(dsaVToken)) {
            // Same asset: vToken balance minus principal vTokens, then convert to underlying.
            // After a partial close, vToken balance may be less than suppliedPrincipal; treat long collateral as 0.
            uint256 vTokenBalance = longVToken.balanceOf(positionAccount);
            if (vTokenBalance <= position.suppliedPrincipal) return 0;
            uint256 netVTokens = vTokenBalance - position.suppliedPrincipal;
            uint256 exchangeRate = longVToken.exchangeRateCurrent();
            return (netVTokens * exchangeRate) / MANTISSA_ONE;
        }

        return longVToken.balanceOfUnderlying(positionAccount);
    }

    /**
     * @notice Returns USD values of long collateral, short debt (borrow), and supplied principal
     * @param position The position data (longVToken, shortVToken, dsaVToken read from position)
     * @return values Struct with longValueUSD, borrowValueUSD, suppliedPrincipalUSD, dsaPrice, shortPrice
     */
    function _getPositionValuesUSD(Position memory position) internal returns (PositionValuesUSD memory values) {
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

        if (dsaVTokenAddr == address(0)) revert InvalidDSA();
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
     * @notice Computes the maximum allowed leverage for a given DSA market
     * @param dsaVToken The DSA vToken market
     * @return maxLeverage The maximum leverage ratio allowed for positions using this DSA
     */
    function _getMaxLeverageForDSA(IVToken dsaVToken) internal view returns (uint256 maxLeverage) {
        (, uint256 CF, ) = COMPTROLLER.markets(address(dsaVToken));
        if (CF >= MANTISSA_ONE) revert InvalidCollateralFactor();

        // Theoretical leverage L = 1 / (1 - CF), with all values in 1e18 mantissa form:
        // L = (1e18 * 1e18) / (1e18 - CF)
        uint256 denom = MANTISSA_ONE - CF;
        uint256 theoretical = (MANTISSA_ONE * MANTISSA_ONE) / denom;

        maxLeverage = theoretical < MIN_LEVERAGE ? MIN_LEVERAGE : theoretical;
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
}
