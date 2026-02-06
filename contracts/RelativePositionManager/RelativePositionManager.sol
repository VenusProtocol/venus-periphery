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

    /// @dev Maximum leverage ratio (10x). Extra safety bound; the real limit is determined by 1/(1 - CF)
    uint256 private constant MAX_LEVERAGE = 10e18;

    /// @dev Minimum leverage ratio (1x)
    uint256 private constant MIN_LEVERAGE = MANTISSA_ONE;

    /// @notice The Venus comptroller contract
    IComptroller public immutable COMPTROLLER;

    /// @notice The leverage strategies manager contract
    LeverageStrategiesManager public immutable LEVERAGE_MANAGER;

    /// @notice Implementation contract for PositionAccount clones (settable via governance)
    address public POSITION_ACCOUNT_IMPLEMENTATION;

    /// @notice Array of supported DSA (Default Settlement Asset) vToken markets
    address[] public dsaVTokens;

    /// @notice Mapping from user => longAsset => shortAsset => Position data
    mapping(address => mapping(address => mapping(address => Position))) public positions;

    /// @notice Mapping from user => longAsset => shortAsset => PositionAccount address
    mapping(address => mapping(address => mapping(address => address))) public positionAccounts;

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
     * @custom:event Emits DSAVTokenAdded event.
     */
    function addDSAVToken(address dsaVToken) external {
        _checkAccessAllowed("addDSAVToken(address)");

        checkMarketListed(dsaVToken);
        dsaVTokens.push(dsaVToken);

        emit DSAVTokenAdded(dsaVToken, uint8(dsaVTokens.length - 1));
    }

    /**
     * @notice Executes an arbitrary call on behalf of a position account
     * @dev Callable by governance, Allows operations like emergency fund rescues.
     * @param positionAccount Address of the position account
     * @param target Target contract address
     * @param data Encoded call data
     * @custom:event Emits GenericCallExecuted event.
     */
    function executePositionAccountCall(address positionAccount, address target, bytes calldata data) external {
        _checkAccessAllowed("executePositionAccountCall(address,address,bytes)");
        IPositionAccount(positionAccount).executeCall(target, data);
        emit GenericCallExecuted(positionAccount, target, data);
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
     * @custom:error Throw AssetNotListed if a market is not listed.
     * @custom:error Throw InvalidDSA if dsaIndex is invalid or market not listed.
     * @custom:error Throw InvalidLeverage if effectiveLeverage is out of range.
     * @custom:error Throw PositionAlreadyExists if the position is already active.
     * @custom:error Throw WithdrawPrincipalBeforeChangingDSA when reactivating with a different DSA and principal not withdrawn.
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
    ) external nonReentrant {
        if (longVToken == shortVToken) {
            revert SameMarketNotAllowed();
        }

        checkMarketListed(longVToken);
        checkMarketListed(shortVToken);

        // Validate and resolve DSA vToken from index
        IVToken dsaVToken = _getValidatedDSAVToken(dsaIndex);

        if (effectiveLeverage < MIN_LEVERAGE || effectiveLeverage > MAX_LEVERAGE) {
            revert InvalidLeverage();
        }

        Position storage position = positions[msg.sender][longVToken][shortVToken];

        if (position.isActive) {
            revert PositionAlreadyExists();
        }

        // If reactivating and user wants to change DSA asset, they must first withdraw current DSA supplied
        if (dsaIndex != position.dsaIndex && position.suppliedPrincipal > 0) {
            revert WithdrawPrincipalBeforeChangingDSA();
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
     * @dev Can be called multiple times to increase collateral.
     * @param longVToken The vToken market address for the long asset
     * @param shortVToken The vToken market address for the short asset
     * @param dsaIndex Index of the DSA vToken in the dsaVTokens array
     * @param amount Amount of DSA underlying to supply
     * @custom:error Throw ZeroAmount if amount is zero.
     * @custom:error Throw PositionNotActive if the position is not active.
     * @custom:error Throw InvalidDSA if dsaIndex does not match the position's DSA.
     * @custom:event Emits PrincipalSupplied event.
     */
    function supplyPrincipal(
        address longVToken,
        address shortVToken,
        uint8 dsaIndex,
        uint256 amount
    ) public nonReentrant {
        if (amount == 0) revert ZeroAmount();
        Position storage position = positions[msg.sender][longVToken][shortVToken];

        if (!position.isActive) revert PositionNotActive();
        if (dsaVTokens[dsaIndex] != position.dsaVToken) revert InvalidDSA();
        _supplyPrincipalToPositionAccount(position, IVToken(position.dsaVToken), amount);
    }

    /**
     * @notice Opens a leveraged position or scales an existing one (borrow short, swap to long)
     * @dev Can be called multiple times to scale the position. Optionally supply additional principal
     *      via additionalPrincipal; otherwise uses existing principal. Requires either existing principal
     *      (from activation or prior supply) or additionalPrincipal > 0. Validates that shortAmount
     *      doesn't exceed the maximum allowed based on capital utilization. dsaIndex must match the position's DSA.
     * @param longVToken The vToken market for the asset to long
     * @param shortVToken The vToken market for the asset to short
     * @param dsaIndex Index of the DSA vToken for this position (must match position)
     * @param additionalPrincipal Additional principal to supply this call (0 if none)
     * @param shortAmount Amount to borrow in shortAsset terms (must not exceed max calculated borrow)
     * @param minLongAmount Minimum amount of long asset expected from swap (protects against slippage)
     * @param swapData Swap instructions for converting shortAsset to longAsset
     * @custom:error Throw ZeroBorrowAmount if shortAmount is zero.
     * @custom:error Throw PositionNotActive if the position is not active.
     * @custom:error Throw InsufficientPrincipal if no principal exists and additionalPrincipal is zero.
     * @custom:error Throw InvalidDSA if dsaIndex does not match the position's DSA.
     * @custom:error Throw BorrowAmountExceedsMaximum if shortAmount exceeds max allowed borrow.
     * @custom:event Emits PositionOpened event (and PrincipalSupplied if additionalPrincipal > 0).
     */
    function openPosition(
        IVToken longVToken,
        IVToken shortVToken,
        uint8 dsaIndex,
        uint256 additionalPrincipal,
        uint256 shortAmount,
        uint256 minLongAmount,
        bytes calldata swapData
    ) external nonReentrant {
        if (address(longVToken) == address(shortVToken)) {
            revert SameMarketNotAllowed();
        }

        if (shortAmount == 0) revert ZeroBorrowAmount();

        checkMarketListed(address(longVToken));
        checkMarketListed(address(shortVToken));

        Position storage position = positions[msg.sender][address(longVToken)][address(shortVToken)];

        if (!position.isActive) revert PositionNotActive();

        // Must have principal (existing or supplied this call) to collateralize the borrow
        if (position.suppliedPrincipal == 0 && additionalPrincipal == 0) revert InsufficientPrincipal();

        if (dsaVTokens[dsaIndex] != position.dsaVToken) revert InvalidDSA();
        IVToken dsaVToken = IVToken(position.dsaVToken);

        if (additionalPrincipal > 0) {
            _supplyPrincipalToPositionAccount(position, dsaVToken, additionalPrincipal);
        }

        uint256 maxBorrowAmount = _calculateMaxBorrowAllowed(msg.sender, longVToken, shortVToken);
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
     * @notice Closes a position partially or fully
     * @dev Supports partial closing. After closing, validates that remaining debt doesn't exceed
     *      the maximum allowed borrow based on supplied principal and effective leverage.
     * @param longVToken The vToken market for the long asset
     * @param shortVToken The vToken market for the short asset
     * @param collateralAmountToRedeem Amount of long collateral to redeem
     * @param borrowedAmountToRepay Amount of short debt to repay via flash loan
     * @param minAmountOutAfterSwap Minimum amount out expected after swap (slippage protection)
     * @param swapData Swap instructions for converting long asset to short asset for repayment
     * @custom:error Throw ZeroFlashLoanAmount if borrowedAmountToRepay is zero.
     * @custom:error Throw PositionNotActive if the position is not active.
     * @custom:error Throw BorrowAmountExceedsMaximum if remaining debt after partial close exceeds (principal × leverage).
     * @custom:event Emits PositionClosed event.
     */
    function closePosition(
        IVToken longVToken,
        IVToken shortVToken,
        uint256 collateralAmountToRedeem,
        uint256 borrowedAmountToRepay,
        uint256 minAmountOutAfterSwap,
        bytes calldata swapData
    ) external nonReentrant {
        if (address(longVToken) == address(shortVToken)) {
            revert SameMarketNotAllowed();
        }

        if (borrowedAmountToRepay == 0) revert ZeroFlashLoanAmount();

        checkMarketListed(address(longVToken));
        checkMarketListed(address(shortVToken));

        Position storage position = positions[msg.sender][address(longVToken)][address(shortVToken)];

        if (!position.isActive) revert PositionNotActive();

        address positionAccount = position.positionAccount;

        // Revert early if there is no short debt to close
        if (shortVToken.borrowBalanceCurrent(positionAccount) == 0) revert ZeroDebt();

        // Close position via position account wrapper (forwards to LeverageManager)
        IPositionAccount(positionAccount).exitLeverage(
            longVToken,
            collateralAmountToRedeem,
            shortVToken,
            borrowedAmountToRepay,
            minAmountOutAfterSwap,
            swapData
        );

        // If partially closed: remaining borrow must not exceed (principal × leverage)
        uint256 remainingShortDebt = shortVToken.borrowBalanceCurrent(positionAccount);
        if (remainingShortDebt > 0) {
            PositionValuesUSD memory values = _getPositionValuesUSD(position);
            uint256 maxBorrowUSD = (values.suppliedPrincipalUSD * position.effectiveLeverage) / MANTISSA_ONE;
            if (values.borrowValueUSD > maxBorrowUSD) revert BorrowAmountExceedsMaximum();
        }

        // Transfer any dust from LM (sent to position account) to user
        _transferDustFromAccountToUser(positionAccount, longVToken.underlying());
        _transferDustFromAccountToUser(positionAccount, shortVToken.underlying());

        emit PositionClosed(msg.sender, positionAccount, position.cycleId, remainingShortDebt);
    }

    /**
     * @notice Closes a position with profit (longValueUSD > shortDebtUSD)
     * @dev Repay: exitLeverage; borrow from state. Reverts if minAmountOutRepay < short debt.
     *      Profit: exact-in swap amountToRedeemForProfitSwap long→DSA (reverts if > excess long). User gets DSA + extra long. Principal not withdrawn.
     * @param longVToken The vToken market for the long asset
     * @param shortVToken The vToken market for the short asset
     * @param collateralAmountToRedeemForRepay Amount of long to redeem for repay swap (passed to exitLeverage)
     * @param minAmountOutRepay Minimum short out from repay swap (must be >= current short debt)
     * @param swapDataRepay Swap #1: long → short for debt repayment
     * @param amountToRedeemForProfitSwap Exact amount of excess long to swap long→DSA; must not exceed excess long
     * @param minAmountOutProfit Minimum DSA out from profit swap
     * @param swapDataProfit Swap #2: long → DSA for profit realization
     * @custom:error Throw PositionNotActive if the position is not active.
     * @custom:error Throw MinAmountOutRepayBelowDebt if minAmountOutRepay is less than current short debt.
     * @custom:error Throw NotProfitScenario if long value (USD) is not greater than short debt (USD).
     * @custom:error Throw ShortDebtNotFullyRepaid if debt remains after repay.
     * @custom:error Throw InsufficientExcessLongForProfitSwap if amountToRedeemForProfitSwap exceeds excess long.
     * @custom:event Emits PositionClosedWithProfit event.
     */
    function closeWithProfit(
        IVToken longVToken,
        IVToken shortVToken,
        uint256 collateralAmountToRedeemForRepay,
        uint256 minAmountOutRepay,
        bytes calldata swapDataRepay,
        uint256 amountToRedeemForProfitSwap,
        uint256 minAmountOutProfit,
        bytes calldata swapDataProfit
    ) external nonReentrant {
        if (address(longVToken) == address(shortVToken)) {
            revert SameMarketNotAllowed();
        }

        checkMarketListed(address(longVToken));
        checkMarketListed(address(shortVToken));

        Position storage position = positions[msg.sender][address(longVToken)][address(shortVToken)];
        if (!position.isActive) revert PositionNotActive();

        address positionAccount = position.positionAccount;
        uint256 currentShortDebt = shortVToken.borrowBalanceCurrent(positionAccount);

        if (minAmountOutRepay < currentShortDebt) revert MinAmountOutRepayBelowDebt();

        PositionValuesUSD memory values = _getPositionValuesUSD(position);
        if (values.longValueUSD <= values.borrowValueUSD) revert NotProfitScenario();

        // If there is no debt, skip repay and allow user to redeem collateral by swapping to DSA.
        if (currentShortDebt > 0) {
            IPositionAccount(positionAccount).exitLeverage(
                longVToken,
                collateralAmountToRedeemForRepay,
                shortVToken,
                currentShortDebt,
                minAmountOutRepay,
                swapDataRepay
            );
        }

        IVToken dsaVToken = IVToken(position.dsaVToken);

        // 2. Profit: redeem (full excess if user amount < current), swap, transfer swapped amount + extra collateral to user.
        _realizeProfitFromExcessLong(
            positionAccount,
            position,
            longVToken,
            shortVToken,
            dsaVToken,
            amountToRedeemForProfitSwap,
            minAmountOutProfit,
            swapDataProfit
        );

        // Transfer any dust from LM (sent to position account) to user
        _transferDustFromAccountToUser(positionAccount, longVToken.underlying());
        _transferDustFromAccountToUser(positionAccount, shortVToken.underlying());
        _transferDustFromAccountToUser(positionAccount, dsaVToken.underlying());

        // Deactivate position; user may withdraw principal or start a new cycle via activatePosition
        position.isActive = false;
        emit PositionClosedWithProfit(msg.sender, positionAccount, position.cycleId);
    }

    /**
     * @notice Closes a position with loss (longValueUSD < shortDebtUSD)
     * @dev First exitLeverage (long→short): redeems longAmountToRedeemForFirstSwap (exact-in; reverts if > available long).
     *      Any remaining long is redeemed and transferred to user. Second exitLeverage (DSA→short) for remaining debt.
     * @param longVToken The vToken market for the long asset
     * @param shortVToken The vToken market for the short asset
     * @param borrowedAmountToRepayFirst Short debt to repay in first exit (Exact-In)
     * @param longAmountToRedeemForFirstSwap Exact long to redeem for first swap (swapHelper pulls this); must not exceed available long
     * @param minAmountOutFirst Minimum short out from first swap
     * @param swapDataFirst Swap #1: long → short
     * @param dsaAmountToRedeemForRepay DSA to redeem for second repayment
     * @param minAmountOutSecond Minimum short out from second swap (must be >= remaining short debt)
     * @param swapDataSecond Swap #2: DSA → short
     * @custom:error Throw ZeroFlashLoanAmount if borrowedAmountToRepayFirst is zero.
     * @custom:error Throw PositionNotActive if the position is not active.
     * @custom:error Throw NotLossScenario if short debt (USD) is not greater than long value (USD).
     * @custom:error Throw MinAmountOutSecondBelowDebt if minAmountOutSecond is less than remaining short debt.
     * @custom:error Throw ShortDebtNotFullyRepaid if short debt remains after second exit.
     * @custom:event Emits PositionClosed and PositionClosedWithLoss events.
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
    ) external nonReentrant {
        if (address(longVToken) == address(shortVToken)) {
            revert SameMarketNotAllowed();
        }

        checkMarketListed(address(longVToken));
        checkMarketListed(address(shortVToken));

        Position storage position = positions[msg.sender][address(longVToken)][address(shortVToken)];
        if (!position.isActive) revert PositionNotActive();
        address positionAccount = position.positionAccount;

        // Revert early if there is no short debt to close
        if (shortVToken.borrowBalanceCurrent(positionAccount) == 0) revert ZeroDebt();

        PositionValuesUSD memory values = _getPositionValuesUSD(position);
        if (values.borrowValueUSD <= values.longValueUSD) revert NotLossScenario();

        // 1. First exitLeverage (long → short): redeem exact amount for swap; swapHelper pulls this
        if (longAmountToRedeemForFirstSwap > 0) {
            IPositionAccount(positionAccount).exitLeverage(
                longVToken,
                longAmountToRedeemForFirstSwap,
                shortVToken,
                borrowedAmountToRepayFirst,
                minAmountOutFirst,
                swapDataFirst
            );
        }

        // 2. Second exitLeverage (DSA → short): close position completely; use current short debt
        IVToken dsaVToken = IVToken(position.dsaVToken);
        uint256 currentShortDebtSecond = shortVToken.borrowBalanceCurrent(positionAccount);
        if (currentShortDebtSecond > 0) {
            if (minAmountOutSecond < currentShortDebtSecond) revert MinAmountOutSecondBelowDebt();
            IPositionAccount(positionAccount).exitLeverage(
                dsaVToken,
                dsaAmountToRedeemForRepay,
                shortVToken,
                currentShortDebtSecond,
                minAmountOutSecond,
                swapDataSecond
            );
        }

        // Redeem any remaining long and transfer to user
        uint256 remainingLong = _getLongCollateralBalance(position);
        _redeemUnderlyingToUser(longVToken, positionAccount, remainingLong);

        if (shortVToken.borrowBalanceCurrent(positionAccount) > 0) revert ShortDebtNotFullyRepaid();
        position.suppliedPrincipal = dsaVToken.balanceOf(positionAccount);

        // Transfer any dust from LM (sent to position account) to user
        _transferDustFromAccountToUser(positionAccount, longVToken.underlying());
        _transferDustFromAccountToUser(positionAccount, shortVToken.underlying());
        _transferDustFromAccountToUser(positionAccount, dsaVToken.underlying());

        position.isActive = false;
        emit PositionClosed(msg.sender, positionAccount, position.cycleId, 0);
        emit PositionClosedWithLoss(msg.sender, positionAccount, position.cycleId);
    }

    /**
     * @notice Withdraws principal from a position (partial when active, full when inactive)
     * @dev When active: calculates utilization and withdraws up to the requested amount.
     *      When inactive: redeems all DSA underlying from position account and transfers to user.
     * @param longVToken The vToken market for the long asset
     * @param shortVToken The vToken market for the short asset
     * @param amount Amount to withdraw (only used when position is active)
     * @custom:error Throw InsufficientWithdrawableAmount if amount exceeds withdrawable amount (active position).
     * @custom:error Throw RedeemBehalfFailed if redeem fails.
     * @custom:event Emits PrincipalWithdrawn event when principal is withdrawn (active or inactive).
     */
    function withdrawPrincipal(IVToken longVToken, IVToken shortVToken, uint256 amount) external nonReentrant {
        Position storage position = positions[msg.sender][address(longVToken)][address(shortVToken)];
        address positionAccount = position.positionAccount;
        if (positionAccount == address(0)) revert ZeroAddress();
        if (amount == 0 || amount > _getSuppliedPrincipalBalance(position, longVToken, IVToken(position.dsaVToken)))
            revert InsufficientWithdrawableAmount();

        if (position.isActive) {
            // Active: redeem only based on utilization
            UtilizationInfo memory utilization = _getUtilizationInfo(msg.sender, longVToken, shortVToken);
            if (amount > utilization.withdrawableAmount) revert InsufficientWithdrawableAmount();
        }

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
    function deactivatePosition(IVToken longVToken, IVToken shortVToken) external nonReentrant {
        Position storage position = positions[msg.sender][address(longVToken)][address(shortVToken)];

        if (!position.isActive) revert PositionNotActive();
        address positionAccount = position.positionAccount;

        // Check that position is fully closed: no long collateral and no short debt
        uint256 longCollateral = _getLongCollateralBalance(position);
        uint256 shortDebt = shortVToken.borrowBalanceCurrent(positionAccount);

        if (longCollateral > 0 || shortDebt > 0) revert PositionNotFullyClosed();
        IVToken dsaVToken = IVToken(position.dsaVToken);

        // Withdraw any remaining DSA principal to user
        uint256 underlyingBalance = dsaVToken.balanceOfUnderlying(positionAccount);
        _redeemUnderlyingToUser(dsaVToken, positionAccount, underlyingBalance);
        position.suppliedPrincipal = 0;

        emit PositionDeactivated(msg.sender, positionAccount, position.cycleId);

        // Reset position state
        position.isActive = false;
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
     * @notice Returns the total number of supported DSA vTokens
     * @return count The number of DSA vTokens in the array
     */
    function getDSAVTokensCount() external view returns (uint256 count) {
        return dsaVTokens.length;
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
        return _getUtilizationInfo(user, longVToken, shortVToken);
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
        return _calculateMaxBorrowAllowed(user, longVToken, shortVToken);
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
        return _getSuppliedPrincipalBalance(position, IVToken(position.longVToken), IVToken(position.dsaVToken));
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

        positionAccounts[user][longAsset][shortAsset] = positionAccount;

        Position storage position = positions[user][longAsset][shortAsset];
        position.positionAccount = positionAccount;
        position.user = user;
        position.longVToken = longAsset;
        position.shortVToken = shortAsset;

        emit PositionAccountDeployed(user, longAsset, shortAsset, positionAccount);
    }

    /**
     * @notice Redeems excess long (full amount), swaps up to user amount long→DSA, transfers swapped DSA + extra collateral to user
     * @dev Pre-requires no open short debt (caller must have repaid). Computes excess long from position; if zero, no-op.
     *      If amountToRedeemForProfitSwap < current excess long, we still redeem full excess, swap the intended amount,
     *      and transfer to user both the swapped amount (DSA) and the extra redeemed collateral (long).
     * @param positionAccount The position account from which long is redeemed
     * @param position The position (used to compute excess long collateral)
     * @param longVToken Long market vToken
     * @param shortVToken Short market vToken (used to assert no borrow remains)
     * @param dsaVToken DSA (collateral) market vToken
     * @param amountToRedeemForProfitSwap Amount of redeemed long to swap long→DSA (exact-in)
     * @param minAmountOutProfit Minimum DSA underlying out from the swap
     * @param swapDataProfit Calldata for the long→DSA swap
     */
    function _realizeProfitFromExcessLong(
        address positionAccount,
        Position memory position,
        IVToken longVToken,
        IVToken shortVToken,
        IVToken dsaVToken,
        uint256 amountToRedeemForProfitSwap,
        uint256 minAmountOutProfit,
        bytes calldata swapDataProfit
    ) internal {
        if (shortVToken.borrowBalanceCurrent(positionAccount) > 0) revert ShortDebtNotFullyRepaid();

        uint256 excessLongToRedeem = _getLongCollateralBalance(position);
        if (excessLongToRedeem == 0) return;
        if (excessLongToRedeem < amountToRedeemForProfitSwap) revert InsufficientExcessLongForProfitSwap();

        IERC20Upgradeable longUnderlying = IERC20Upgradeable(longVToken.underlying());
        IERC20Upgradeable dsaUnderlying = IERC20Upgradeable(dsaVToken.underlying());

        // Always redeem full excess (if user supplied amount < current excess, we still redeem full)
        uint256 redeemErr = longVToken.redeemUnderlyingBehalf(positionAccount, excessLongToRedeem);
        if (redeemErr != SUCCESS) revert RedeemBehalfFailed(redeemErr);

        // Special case: when long and DSA underlyings are the same (including the case where longVToken == dsaVToken),
        // there is no need to perform a swap – profit is already in the DSA asset. Transfer all redeemed long/DSA
        // directly to the user and return.
        if (address(longUnderlying) == address(dsaUnderlying)) {
            _transferContractBalanceToUser(longUnderlying);
            return;
        }

        // When nothing to swap, transfer all redeemed long to user and skip swap call
        if (amountToRedeemForProfitSwap == 0) {
            _transferContractBalanceToUser(longUnderlying);
            return;
        }

        // Swap long → DSA and transfer DSA to user
        _performSwap(longUnderlying, amountToRedeemForProfitSwap, dsaUnderlying, minAmountOutProfit, swapDataProfit);
        _transferContractBalanceToUser(dsaUnderlying);

        // Transfer extra redeemed collateral (long) that was not swapped
        _transferContractBalanceToUser(longUnderlying);
    }

    /**
     * @notice Transfers this contract's full balance of the given token to msg.sender (no-op if balance is 0)
     * @param token The ERC20 token to transfer
     */
    function _transferContractBalanceToUser(IERC20Upgradeable token) internal {
        uint256 balance = token.balanceOf(address(this));
        if (balance > 0) token.safeTransfer(msg.sender, balance);
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
        _transferContractBalanceToUser(IERC20Upgradeable(vToken.underlying()));
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
     * @notice Calculates the maximum allowed borrow amount for a position
     * @param user Address of the user
     * @param longVToken The vToken market for the long asset
     * @param shortVToken The vToken market for the short asset
     * @return maxBorrowAmount Maximum amount that can be borrowed in shortAsset terms
     */
    function _calculateMaxBorrowAllowed(
        address user,
        IVToken longVToken,
        IVToken shortVToken
    ) internal returns (uint256 maxBorrowAmount) {
        Position memory position = positions[user][address(longVToken)][address(shortVToken)];
        // Get utilization info which calculates available capital (DSA from position)
        UtilizationInfo memory utilization = _getUtilizationInfo(user, longVToken, shortVToken);

        // Calculate max additional borrow amount: availableCapital * effectiveLeverage
        uint256 maxAdditionalBorrowUSD = (utilization.availableCapitalUSD * position.effectiveLeverage) / MANTISSA_ONE;

        // Convert to shortAsset amount
        ResilientOracleInterface oracle = COMPTROLLER.oracle();
        uint256 shortPrice = oracle.getUnderlyingPrice(address(shortVToken));

        maxBorrowAmount = (maxAdditionalBorrowUSD * MANTISSA_ONE) / shortPrice;
    }

    /**
     * @notice Calculates capital utilization for a position (used for max borrow and withdrawable amount)
     * @dev Computes actualCapitalUtilized (LTV-based), nominalCapitalUtilized (leverage-based), caps by supplied principal,
     *      then availableCapitalUSD and withdrawableAmount in DSA terms.
     * @param user User address
     * @param longVToken The vToken market for the long asset
     * @param shortVToken The vToken market for the short asset
     * @return utilization Struct with actualCapitalUtilized, nominalCapitalUtilized, finalCapitalUtilized, availableCapitalUSD, withdrawableAmount
     */
    function _getUtilizationInfo(
        address user,
        IVToken longVToken,
        IVToken shortVToken
    ) internal returns (UtilizationInfo memory utilization) {
        Position memory position = positions[user][address(longVToken)][address(shortVToken)];
        PositionValuesUSD memory values = _getPositionValuesUSD(position);
        IVToken dsaVToken = IVToken(position.dsaVToken);

        (, uint256 dsaLTV, ) = COMPTROLLER.markets(address(dsaVToken));
        (, uint256 longLTV, ) = COMPTROLLER.markets(address(longVToken));

        // Calculate nominalCapitalUtilized borrowValueUSD/effectiveLeverage
        utilization.nominalCapitalUtilized = (values.borrowValueUSD * MANTISSA_ONE) / position.effectiveLeverage;

        // Calculate actualCapitalUtilized (borrowValueUSD - (longValueUSD * longLTV) / dsaLTV
        utilization.actualCapitalUtilized = values.borrowValueUSD > (values.longValueUSD * longLTV) / MANTISSA_ONE
            ? ((values.borrowValueUSD - (values.longValueUSD * longLTV) / MANTISSA_ONE) * MANTISSA_ONE) / dsaLTV
            : 0;

        utilization.finalCapitalUtilized = max(utilization.actualCapitalUtilized, utilization.nominalCapitalUtilized);
        utilization.finalCapitalUtilized = min(values.suppliedPrincipalUSD, utilization.finalCapitalUtilized);

        // Calculate available capital in USD (finalCapitalUtilized is already capped by suppliedPrincipal)
        utilization.availableCapitalUSD = values.suppliedPrincipalUSD - utilization.finalCapitalUtilized;

        // Calculate withdrawable amount in DSA token terms
        utilization.withdrawableAmount = (utilization.availableCapitalUSD * MANTISSA_ONE) / values.dsaPrice;
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
     * @notice Transfers token dust from position account to the position owner (msg.sender from the user's perspective)
     * @dev Calls PositionAccount.transferDustToOwner which is only callable by this manager; dust goes to account owner.
     * @param positionAccount Address of the position account holding the dust
     * @param tokenAddress Address of the ERC20 token to transfer
     */
    function _transferDustFromAccountToUser(address positionAccount, address tokenAddress) internal {
        IPositionAccount(positionAccount).transferDustToOwner(tokenAddress);
    }

    /**
     * @notice Converts supplied principal to underlying amount, handling DSA==long and DSA!=long cases
     * @dev When DSA != long asset, all DSA underlying on the position account is considered principal,
     *      so we can read it directly. When DSA == long asset, we must use the stored principal vTokens
     *      to avoid counting long collateral as principal.
     * @param position The position data (holds suppliedPrincipal and positionAccount)
     * @param longVToken The long asset vToken
     * @param dsaVToken The DSA vToken
     * @return balance of principal in underlying units
     */
    function _getSuppliedPrincipalBalance(
        Position memory position,
        IVToken longVToken,
        IVToken dsaVToken
    ) internal returns (uint256) {
        if (position.suppliedPrincipal == 0) return 0;

        address positionAccount = position.positionAccount;

        // When DSA == long, principal is tracked in vTokens to separate it from long collateral.
        if (address(dsaVToken) == address(longVToken)) {
            uint256 exchangeRate = dsaVToken.exchangeRateCurrent();
            return (position.suppliedPrincipal * exchangeRate) / MANTISSA_ONE;
        }

        // DSA and long are different assets: all DSA underlying on the position is principal.
        return dsaVToken.balanceOfUnderlying(positionAccount);
    }

    /**
     * @notice Gets the actual long collateral balance, excluding DSA principal if DSA == long asset
     * @param position The position data (longVToken read from position)
     * @return longBalance The actual long collateral balance in underlying (excluding DSA principal if DSA == long)
     */
    function _getLongCollateralBalance(Position memory position) internal returns (uint256 longBalance) {
        IVToken longVToken = IVToken(position.longVToken);
        IVToken dsaVToken = IVToken(position.dsaVToken);

        if (address(longVToken) == address(dsaVToken)) {
            // Same asset: vToken balance minus principal vTokens, then convert to underlying.
            // After a partial close, vToken balance may be less than suppliedPrincipal; treat long collateral as 0.
            uint256 vTokenBalance = longVToken.balanceOf(position.positionAccount);
            if (vTokenBalance <= position.suppliedPrincipal) return 0;
            uint256 netVTokens = vTokenBalance - position.suppliedPrincipal;
            uint256 exchangeRate = longVToken.exchangeRateCurrent();
            return (netVTokens * exchangeRate) / MANTISSA_ONE;
        }

        return longVToken.balanceOfUnderlying(position.positionAccount);
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
        uint256 suppliedPrincipal = _getSuppliedPrincipalBalance(position, longVToken, dsaVToken);

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
        if (dsaIndex >= dsaVTokens.length) revert InvalidDSA();
        address dsaVTokenAddr = dsaVTokens[dsaIndex];
        if (dsaVTokenAddr == address(0)) {
            revert InvalidDSA();
        }
        dsaVToken = IVToken(dsaVTokenAddr);
        checkMarketListed(dsaVTokenAddr);
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
     * @notice Validates that a market is listed in the Comptroller and is not vBNB
     * @dev Reverts with AssetNotListed if not listed, VBNBNotSupported if market is the leverage manager's vBNB.
     * @param market The vToken market address to validate
     */
    function checkMarketListed(address market) internal view {
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
