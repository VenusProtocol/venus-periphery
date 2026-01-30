// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

import { Ownable2StepUpgradeable } from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import {
    SafeERC20Upgradeable,
    IERC20Upgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import { ClonesUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/ClonesUpgradeable.sol";

import { IVToken, IComptroller } from "../Interfaces.sol";
import { ResilientOracleInterface } from "@venusprotocol/oracle/contracts/interfaces/OracleInterface.sol";
import { SwapHelper } from "../SwapHelper/SwapHelper.sol";
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
contract RelativePositionManager is Ownable2StepUpgradeable, ReentrancyGuardUpgradeable, IRelativePositionManager {
    using SafeERC20Upgradeable for IERC20Upgradeable;

    /// @dev USD values for long collateral, short debt, and supplied principal (and prices used for conversions)
    struct PositionValuesUSD {
        uint256 longValueUSD;
        uint256 borrowValueUSD;
        uint256 suppliedPrincipalUSD;
        uint256 dsaPrice;
        uint256 shortPrice;
    }

    /// @dev Mantissa for fixed-point arithmetic (1e18 = 100%)
    uint256 private constant MANTISSA_ONE = 1e18;

    /// @dev Maximum leverage ratio (10x)
    uint256 private constant MAX_LEVERAGE = 10e18;

    /// @dev Minimum leverage ratio (1x)
    uint256 private constant MIN_LEVERAGE = MANTISSA_ONE;

    /// @notice The Venus comptroller contract
    IComptroller public immutable COMPTROLLER;

    /// @notice The leverage strategies manager contract
    LeverageStrategiesManager public immutable LEVERAGE_MANAGER;

    /// @notice Implementation contract for PositionAccount clones
    address public immutable POSITION_ACCOUNT_IMPLEMENTATION;

    /// @notice The swap helper contract
    SwapHelper public immutable SWAP_HELPER;

    /// @notice Array of supported DSA vToken markets
    address[] public dsaVTokens;

    /// @notice Mapping from user => longAsset => shortAsset => Position data
    mapping(address => mapping(address => mapping(address => Position))) public positions;

    /// @notice Mapping from user => longAsset => shortAsset => PositionAccount address
    mapping(address => mapping(address => mapping(address => address))) public positionAccounts;

    /**
     * @notice Contract constructor
     * @dev Sets immutable variables and disables initializers
     * @param comptroller The Venus comptroller contract address
     * @param leverageManager The leverage strategies manager contract address
     * @param swapHelper The swap helper contract address
     * @param positionAccountImpl Implementation contract for PositionAccount clones
     */
    constructor(address comptroller, address leverageManager, address swapHelper, address positionAccountImpl) {
        if (
            comptroller == address(0) ||
            leverageManager == address(0) ||
            swapHelper == address(0) ||
            positionAccountImpl == address(0)
        ) {
            revert ZeroAddress();
        }

        COMPTROLLER = IComptroller(comptroller);
        LEVERAGE_MANAGER = LeverageStrategiesManager(leverageManager);
        SWAP_HELPER = SwapHelper(swapHelper);
        POSITION_ACCOUNT_IMPLEMENTATION = positionAccountImpl;

        _disableInitializers();
    }

    /**
     * @notice Initializes the contract
     * @dev Sets up Ownable2Step and ReentrancyGuard.
     *      DSA vTokens should be added separately using addDSAVToken function.
     */
    function initialize() external initializer {
        __Ownable2Step_init();
        __ReentrancyGuard_init();
    }

    /**
     * @notice Activates a position account for the user with specified asset pair and DSA
     * @dev Deploys a new PositionAccount contract if one doesn't exist for this user/asset combination.
     *      The desired leverage must be set during activation and will be used to validate borrow amounts
     *      in openPosition operations.
     *      Validates that longAsset and shortAsset are different, listed markets, and not vBNB.
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
    ) external nonReentrant {
        if (longAsset == address(0) || shortAsset == address(0)) {
            revert ZeroAddress();
        }

        // Validate that markets are listed
        checkMarketListed(longAsset);
        checkMarketListed(shortAsset);

        // Validate DSA index
        if (dsaIndex >= dsaVTokens.length) {
            revert InvalidDSA();
        }

        address dsaVToken = dsaVTokens[dsaIndex];
        if (dsaVToken == address(0)) {
            revert InvalidDSA();
        }
        checkMarketListed(dsaVToken);

        if (desiredLeverage < MIN_LEVERAGE || desiredLeverage > MAX_LEVERAGE) {
            revert InvalidLeverage();
        }

        Position storage position = positions[msg.sender][longAsset][shortAsset];

        if (position.isActive) {
            revert PositionAlreadyExists();
        }

        // If reactivating and user wants to change DSA asset, they must first withdraw current DSA supplied (no matter if supplying new amount or not)
        if (position.positionAccount != address(0) && dsaIndex != position.dsaIndex) {
            revert WithdrawPrincipalBeforeChangingDSA();
        }

        // Deploy position account if it doesn't exist (sets positionAccount and immutable fields in _deployPositionAccount)
        if (position.positionAccount == address(0)) {
            _deployPositionAccount(msg.sender, longAsset, shortAsset);
        }

        // Increment cycle ID on each activation (completes previous cycle when reactivating)
        position.cycleId++;

        position.isActive = true;
        position.dsaIndex = dsaIndex;
        position.effectiveLeverage = desiredLeverage;

        // Enter DSA market on behalf of position account (to use as collateral)
        _enterMarket(position.positionAccount, dsaVToken);

        // Supply additional principal if provided (transfer and mint only the new amount)
        if (initialPrincipal > 0) {
            _supplyPrincipalToPositionAccount(position.positionAccount, IVToken(dsaVToken), initialPrincipal);
        }

        // Store supplied principal as vToken amount (existing + newly minted)
        position.suppliedPrincipal = IVToken(dsaVToken).balanceOf(position.positionAccount);

        emit PositionActivated(
            msg.sender,
            longAsset,
            shortAsset,
            dsaVToken,
            position.positionAccount,
            position.cycleId,
            initialPrincipal,
            desiredLeverage
        );
    }

    /**
     * @notice Supplies additional principal to an active position
     * @dev Can be called multiple times to increase collateral.
     *      Validates that the provided DSA index matches the position's configured DSA.
     * @param longAsset The vToken market address for the long asset
     * @param shortAsset The vToken market address for the short asset
     * @param dsaIndex Index of the DSA vToken in the dsaVTokens array
     * @param amount Amount of DSA underlying to supply
     */
    function supplyPrincipal(
        address longAsset,
        address shortAsset,
        uint8 dsaIndex,
        uint256 amount
    ) public nonReentrant {
        if (amount == 0) revert ZeroAmount();

        Position storage position = positions[msg.sender][longAsset][shortAsset];

        if (!position.isActive) {
            revert PositionNotActive();
        }

        // Validate that the provided DSA index matches the position's configured DSA
        if (dsaIndex != position.dsaIndex) {
            revert InvalidDSA();
        }

        address positionAccount = position.positionAccount;
        IVToken dsaVToken = IVToken(dsaVTokens[dsaIndex]);
        checkMarketListed(address(dsaVToken));

        position.suppliedPrincipal += _supplyPrincipalToPositionAccount(positionAccount, dsaVToken, amount);

        emit PrincipalSupplied(msg.sender, positionAccount, address(dsaVToken), amount, position.suppliedPrincipal);
    }

    /**
     * @notice Opens a leveraged position or scales an existing one (borrow short, swap to long)
     * @dev Can be called multiple times to scale the position. Optionally supply additional principal
     *      via additionalPrincipal; otherwise uses existing principal. Requires either existing principal
     *      (from activation or prior supply) or additionalPrincipal > 0. Validates that shortAmount
     *      doesn't exceed the maximum allowed based on capital utilization.
     * @param longVToken The vToken market for the asset to long
     * @param shortVToken The vToken market for the asset to short
     * @param additionalPrincipal Additional principal to supply this call (0 if none)
     * @param shortAmount Amount to borrow in shortAsset terms (must not exceed max calculated borrow)
     * @param minLongAmount Minimum amount of long asset expected from swap (protects against slippage)
     * @param swapData Swap instructions for converting shortAsset to longAsset
     */
    function openPosition(
        IVToken longVToken,
        IVToken shortVToken,
        uint256 additionalPrincipal,
        uint256 shortAmount,
        uint256 minLongAmount,
        bytes calldata swapData
    ) external nonReentrant {
        if (shortAmount == 0) revert ZeroBorrowAmount();

        checkMarketListed(address(longVToken));
        checkMarketListed(address(shortVToken));

        Position storage position = positions[msg.sender][address(longVToken)][address(shortVToken)];

        if (!position.isActive) revert PositionNotActive();

        // Must have principal (existing or supplied this call) to collateralize the borrow
        if (position.suppliedPrincipal == 0 && additionalPrincipal == 0) revert InsufficientPrincipal();

        address positionAccount = position.positionAccount;
        IVToken dsaVToken = IVToken(dsaVTokens[position.dsaIndex]);

        if (additionalPrincipal > 0) {
            position.suppliedPrincipal += _supplyPrincipalToPositionAccount(positionAccount, dsaVToken, additionalPrincipal);
        }

        uint256 maxBorrowAmount = _calculateMaxBorrow(msg.sender, longVToken, shortVToken, dsaVToken);
        if (shortAmount > maxBorrowAmount) revert BorrowAmountExceedsMaximum();

        IPositionAccount(positionAccount).enterLeverage(
            longVToken,
            0, // no collateral seed; collateral comes from swap
            shortVToken,
            shortAmount,
            minLongAmount,
            swapData
        );

        // Transfer any dust from LM (sent to position account) to user
        _transferDustToUser(positionAccount, longVToken.underlying());
        _transferDustToUser(positionAccount, shortVToken.underlying());

        emit PositionOpened(
            msg.sender,
            positionAccount,
            position.cycleId,
            address(longVToken),
            address(shortVToken),
            address(dsaVToken),
            shortAmount,
            position.effectiveLeverage,
            additionalPrincipal
        );
    }

    /**
     * @notice Closes a position partially or fully
     * @dev Supports partial closing. After closing, validates that remaining debt doesn't exceed
     *      the maximum allowed borrow based on supplied principal and effective leverage.
     *      If position is partially closed, ensures leverage constraint is still satisfied.
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
    ) external nonReentrant {
        if (borrowedAmountToRepay == 0) revert ZeroFlashLoanAmount();

        Position storage position = positions[msg.sender][address(longVToken)][address(shortVToken)];

        if (!position.isActive) {
            revert PositionNotActive();
        }

        address positionAccount = position.positionAccount;

        // Close position via position account wrapper (forwards to LeverageManager)
        IPositionAccount(positionAccount).exitLeverage(
            longVToken,
            collateralAmountToRedeem,
            shortVToken,
            borrowedAmountToRepay,
            minAmountOutAfterSwap,
            swapData
        );

        // Transfer any dust from LM (sent to position account) to user
        _transferDustToUser(positionAccount, longVToken.underlying());
        _transferDustToUser(positionAccount, shortVToken.underlying());

        // After closing, validate that leverage is still within acceptable range
        // If position is partially closed, validate leverage constraint is still satisfied
        uint256 remainingShortDebt = shortVToken.borrowBalanceStored(positionAccount);
        if (remainingShortDebt > 0) {
            IVToken dsaVToken = IVToken(dsaVTokens[position.dsaIndex]);
            PositionValuesUSD memory values = _getPositionValuesUSD(
                position,
                longVToken,
                shortVToken,
                dsaVToken,
                remainingShortDebt
            );
            // maxAllowedBorrowUSD = suppliedPrincipalUSD * effectiveLeverage
            uint256 maxAllowedBorrowUSD = (values.suppliedPrincipalUSD * position.effectiveLeverage) / MANTISSA_ONE;
            if (values.borrowValueUSD > maxAllowedBorrowUSD) {
                revert BorrowAmountExceedsMaximum();
            }
        }

        emit PositionClosed(msg.sender, positionAccount, position.cycleId);
    }

    /**
     * @notice Closes a position with profit (longValueUSD > shortDebtUSD)
     * @dev Repay: only params needed for exitLeverage; borrow amount read from state.
     *      Profit: user supplies redeem amount for swap, swap calldata, minOut. If supplied redeem amount is less than
     *      current excess long, we redeem full excess, run swap, and transfer to user both the swapped amount (DSA)
     *      and any extra redeemed collateral (long) that was not swapped.
     *      Principal is not withdrawn here; user withdraws separately via withdrawPrincipal or deactivatePosition.
     * @param longVToken The vToken market for the long asset
     * @param shortVToken The vToken market for the short asset
     * @param collateralAmountToRedeemForRepay Amount of long to redeem for repay swap (passed to exitLeverage)
     * @param swapDataRepay Swap #1: long → short for debt repayment
     * @param minAmountOutRepay Minimum short out from repay swap (required for debt + flash loan fee)
     * @param amountToRedeemForProfitSwap Amount of excess long to use in profit swap (if less than actual excess, we redeem full and transfer extra to user)
     * @param minAmountOutProfit Minimum DSA out from profit swap
     * @param swapDataProfit Swap #2: long → DSA for profit realization
     */
    function closeWithProfit(
        IVToken longVToken,
        IVToken shortVToken,
        uint256 collateralAmountToRedeemForRepay,
        bytes calldata swapDataRepay,
        uint256 minAmountOutRepay,
        uint256 amountToRedeemForProfitSwap,
        uint256 minAmountOutProfit,
        bytes calldata swapDataProfit
    ) external nonReentrant {
        Position storage position = positions[msg.sender][address(longVToken)][address(shortVToken)];
        if (!position.isActive) revert PositionNotActive();

        address positionAccount = position.positionAccount;
        uint256 borrowedAmountToRepay = shortVToken.borrowBalanceCurrent(positionAccount);
        if (borrowedAmountToRepay == 0) revert NoShortDebtToRepay();

        IVToken dsaVToken = IVToken(dsaVTokens[position.dsaIndex]);
        PositionValuesUSD memory values = _getPositionValuesUSD(position, longVToken, shortVToken, dsaVToken, 0);

        if (values.longValueUSD <= values.borrowValueUSD) revert NotProfitScenario();

        address longUnderlying = longVToken.underlying();
        address dsaUnderlying = dsaVToken.underlying();

        // 1. Repay: only pass through what exitLeverage needs; borrow amount from state.
        IPositionAccount(positionAccount).exitLeverage(
            longVToken,
            collateralAmountToRedeemForRepay,
            shortVToken,
            borrowedAmountToRepay,
            minAmountOutRepay,
            swapDataRepay
        );

        if (shortVToken.borrowBalanceStored(positionAccount) > 0) {
            revert ShortDebtNotFullyRepaid();
        }

        // 2. Profit: redeem (full excess if user amount < current), swap, transfer swapped amount + extra collateral to user.
        uint256 excessLong = _getLongCollateralBalance(position, longVToken);
        if (excessLong > 0) {
            _realizeProfitFromExcessLong(
                positionAccount,
                longVToken,
                longUnderlying,
                dsaUnderlying,
                excessLong,
                amountToRedeemForProfitSwap,
                minAmountOutProfit,
                swapDataProfit
            );
        }

        // Transfer any dust from LM (sent to position account) to user
        _transferDustToUser(positionAccount, longVToken.underlying());
        _transferDustToUser(positionAccount, shortVToken.underlying());
        _transferDustToUser(positionAccount, dsaVToken.underlying());

        // Deactivate position; user may withdraw principal or start a new cycle via activatePosition
        position.isActive = false;
        emit ProfitRealized(msg.sender, positionAccount, position.cycleId);
    }

    /**
     * @notice Closes a position with loss (longValueUSD < shortDebtUSD)
     * @dev First exitLeverage (long→short) redeems full long (computed: if DSA==long, principal withdrawn first then long balance; else long underlying balance).
     *      Second exitLeverage (DSA→short) for remaining debt. Any dust transferred to user.
     *      UI shows when longValueUSD < shortDebtUSD. Requires two swap calldata from backend.
     * @param longVToken The vToken market for the long asset
     * @param shortVToken The vToken market for the short asset
     * @param borrowedAmountToRepayFirst Short debt to repay in first exit (Exact-In)
     * @param minAmountOutFirst Minimum short out from first swap
     * @param swapDataFirst Swap #1: long → short
     * @param dsaAmountToRedeemForRepay DSA principal to redeem for second repayment
     * @param borrowedAmountToRepaySecond Remaining short debt to repay (Exact-In)
     * @param minAmountOutSecond Minimum short out from second swap
     * @param swapDataSecond Swap #2: DSA → short
     */
    function closeWithLoss(
        IVToken longVToken,
        IVToken shortVToken,
        uint256 borrowedAmountToRepayFirst,
        uint256 minAmountOutFirst,
        bytes calldata swapDataFirst,
        uint256 dsaAmountToRedeemForRepay,
        uint256 borrowedAmountToRepaySecond,
        uint256 minAmountOutSecond,
        bytes calldata swapDataSecond
    ) external nonReentrant {
        if (borrowedAmountToRepayFirst == 0 || borrowedAmountToRepaySecond == 0) revert ZeroFlashLoanAmount();

        Position storage position = positions[msg.sender][address(longVToken)][address(shortVToken)];
        if (!position.isActive) revert PositionNotActive();

        // Require short debt (USD) > long collateral (USD) for loss scenario
        address positionAccount = position.positionAccount;
        IVToken dsaVToken = IVToken(dsaVTokens[position.dsaIndex]);
        PositionValuesUSD memory values = _getPositionValuesUSD(position, longVToken, shortVToken, dsaVToken, 0);
        if (values.borrowValueUSD <= values.longValueUSD) revert NotLossScenario();

        // Compute long amount to redeem: if DSA==long, use only the long part (total minus principal); else use full long underlying balance
        uint256 amountToRedeemFirst = address(longVToken) == address(dsaVToken)
            ? _getLongCollateralBalance(position, longVToken)
            : longVToken.balanceOfUnderlying(positionAccount);

        // 1. First execution: exitLeverage (long → short) full long redeem; LM repays borrowedAmountToRepayFirst, sends remainder to user
        IPositionAccount(positionAccount).exitLeverage(
            longVToken,
            amountToRedeemFirst,
            shortVToken,
            borrowedAmountToRepayFirst,
            minAmountOutFirst,
            swapDataFirst
        );

        // 2. Second execution: exitLeverage (DSA → short) remaining debt via position account wrapper
        IPositionAccount(positionAccount).exitLeverage(
            dsaVToken,
            dsaAmountToRedeemForRepay,
            shortVToken,
            borrowedAmountToRepaySecond,
            minAmountOutSecond,
            swapDataSecond
        );

        // Transfer any dust from LM (sent to position account) to user
        _transferDustToUser(positionAccount, longVToken.underlying());
        _transferDustToUser(positionAccount, shortVToken.underlying());
        _transferDustToUser(positionAccount, dsaVToken.underlying());

        // Update supplied principal to actual remaining DSA vToken balance.
        // Safe when long==DSA: the long part was already spent in the first exit to repay borrow, so remainder is principal only.
        position.suppliedPrincipal = dsaVToken.balanceOf(positionAccount);
        position.isActive = false;
        emit PositionClosed(msg.sender, positionAccount, position.cycleId);
    }

    /**
     * @notice Withdraws principal from a position (partial when active, full when inactive)
     * @dev When active: calculates utilization and withdraws up to the requested amount.
     *      When inactive: withdraws complete principal via _withdrawCompletePrincipalToUser.
     * @param longVToken The vToken market for the long asset
     * @param shortVToken The vToken market for the short asset
     * @param amount Amount to withdraw (only used when position is active)
     */
    function withdrawPrincipal(IVToken longVToken, IVToken shortVToken, uint256 amount) external nonReentrant {
        Position storage position = positions[msg.sender][address(longVToken)][address(shortVToken)];

        address positionAccount = position.positionAccount;
        IVToken dsaVToken = IVToken(dsaVTokens[position.dsaIndex]);

        if (!position.isActive) {
            // Inactive: withdraw complete principal (e.g. after closeWithProfit principal left in)
            _withdrawCompletePrincipalToUser(positionAccount, dsaVToken, dsaVToken.underlying(), position);
            return;
        }

        UtilizationInfo memory utilization = _getUtilizationInfo(msg.sender, longVToken, shortVToken, dsaVToken);

        if (amount > utilization.withdrawableAmount) {
            revert InsufficientWithdrawableAmount();
        }

        uint256 exchangeRate = dsaVToken.exchangeRateCurrent();
        uint256 redeemError = dsaVToken.redeemUnderlyingBehalf(positionAccount, amount);
        if (redeemError != 0) {
            revert RedeemBehalfFailed();
        }

        address underlying = dsaVToken.underlying();
        IERC20Upgradeable(underlying).safeTransfer(msg.sender, amount);

        // suppliedPrincipal is in vTokens; subtract vTokens equivalent of amount redeemed
        position.suppliedPrincipal -= (amount * 1e18) / exchangeRate;

        emit PrincipalWithdrawn(msg.sender, positionAccount, address(dsaVToken), amount, position.suppliedPrincipal);
    }

    /**
     * @notice Deactivates a position account
     * @dev Removes DSA selection and resets leverage. Withdraws all remaining principal back to the user.
     *      User can activate with new DSA later. The DSA asset is retrieved from the position data (set during activation).
     * @param longAsset The vToken market address for the long asset
     * @param shortAsset The vToken market address for the short asset
     */
    function deactivatePosition(address longAsset, address shortAsset) external nonReentrant {
        Position storage position = positions[msg.sender][longAsset][shortAsset];

        if (!position.isActive) {
            revert PositionNotActive();
        }

        address positionAccount = position.positionAccount;
        IVToken longVToken = IVToken(longAsset);
        IVToken shortVToken = IVToken(shortAsset);
        IVToken dsaVToken = IVToken(dsaVTokens[position.dsaIndex]);

        // Check that position is fully closed: no long collateral and no short debt
        uint256 longCollateral = _getLongCollateralBalance(position, longVToken);
        uint256 shortDebt = shortVToken.borrowBalanceStored(positionAccount);

        if (longCollateral > 0 || shortDebt > 0) {
            revert PositionNotFullyClosed();
        }

        // Withdraw any remaining DSA principal to user (updates position.suppliedPrincipal to 0 inside)
        _withdrawCompletePrincipalToUser(positionAccount, dsaVToken, dsaVToken.underlying(), position);

        emit PositionDeactivated(msg.sender, positionAccount, position.cycleId);

        // Reset position state
        position.isActive = false;
        position.effectiveLeverage = 0;
    }

    /**
     * @notice Adds a new DSA vToken to the supported list
     * @dev Index will be the current length of the array. Only owner can add.
     * @param dsaVToken The vToken market address to add as a supported DSA
     */
    function addDSAVToken(address dsaVToken) external onlyOwner {
        // TODO: Add ACM-based access control here
        if (dsaVToken == address(0)) {
            revert ZeroAddress();
        }

        checkMarketListed(dsaVToken);
        dsaVTokens.push(dsaVToken);

        emit DSAVTokenAdded(dsaVToken, uint8(dsaVTokens.length - 1));
    }

    /**
     * @notice Returns the total number of supported DSA vTokens
     * @return count The number of DSA vTokens in the array
     */
    function getDSAVTokensCount() external view returns (uint256 count) {
        return dsaVTokens.length;
    }

    /**
     * @notice Executes an arbitrary call on behalf of a position account
     * @dev Allows privileged operations like emergency fund rescue or contract migrations.
     * @param positionAccount Address of the position account
     * @param target Target contract address
     * @param data Encoded call data
     */
    function executePositionAccountCall(address positionAccount, address target, bytes calldata data) external {
        // TODO: Add ACM-based access control here
        IPositionAccount(positionAccount).executeCall(target, data);

        emit GenericCallExecuted(positionAccount, target, data);
    }

    /**
     * @notice Calculates withdrawal utilization for a position
     * @param user User address
     * @param longVToken The vToken market for the long asset
     * @param shortVToken The vToken market for the short asset
     * @param dsaVToken The vToken market for the DSA asset
     * @return utilization Utilization information
     */
    function getUtilizationInfo(
        address user,
        IVToken longVToken,
        IVToken shortVToken,
        IVToken dsaVToken
    ) external returns (UtilizationInfo memory utilization) {
        return _getUtilizationInfo(user, longVToken, shortVToken, dsaVToken);
    }

    /**
     * @notice Calculates the maximum allowed borrow amount for a position
     * @param user Address of the user
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
    ) external returns (uint256 maxBorrowAmount) {
        return _calculateMaxBorrow(user, longVToken, shortVToken, dsaVToken);
    }

    /**
     * @notice Deploys a new PositionAccount contract for the user
     * @dev Uses deterministic deployment via clones and initializes the clone with user-specific data.
     *      Sets position account address and immutable position fields (user, longAsset, shortAsset) in storage.
     * @param user User address
     * @param longAsset Long asset vToken address
     * @param shortAsset Short asset vToken address
     */
    function _deployPositionAccount(
        address user,
        address longAsset,
        address shortAsset
    ) internal {
        bytes32 salt = keccak256(abi.encodePacked(user, longAsset, shortAsset));
        address positionAccount = ClonesUpgradeable.cloneDeterministic(POSITION_ACCOUNT_IMPLEMENTATION, salt);

        // Initialize the clone with user-specific data (owner, longAsset, shortAsset)
        // This will automatically approve both RPM and LeverageManager as delegates
        IPositionAccount(positionAccount).initialize(user, longAsset, shortAsset);

        positionAccounts[user][longAsset][shortAsset] = positionAccount;

        Position storage position = positions[user][longAsset][shortAsset];
        position.positionAccount = positionAccount;
        position.user = user;
        position.longAsset = longAsset;
        position.shortAsset = shortAsset;
    }

    /**
     * @notice Returns USD values of long collateral, short debt (borrow), and supplied principal
     * @param position The position data
     * @param longVToken The vToken market for the long asset
     * @param shortVToken The vToken market for the short asset
     * @param dsaVToken The vToken market for the DSA asset
     * @param shortDebtOverride If non-zero, use this as short debt amount instead of current borrow balance (e.g. remaining debt after partial close)
     * @return values Struct with longValueUSD, borrowValueUSD, suppliedPrincipalUSD, dsaPrice, shortPrice
     */
    function _getPositionValuesUSD(
        Position memory position,
        IVToken longVToken,
        IVToken shortVToken,
        IVToken dsaVToken,
        uint256 shortDebtOverride
    ) internal returns (PositionValuesUSD memory values) {
        address positionAccount = position.positionAccount;
        uint256 longCollateral = _getLongCollateralBalance(position, longVToken);
        uint256 shortDebt = shortDebtOverride != 0
            ? shortDebtOverride
            : shortVToken.borrowBalanceCurrent(positionAccount);
        uint256 suppliedPrincipalUnderlying = _getSuppliedPrincipalUnderlying(position.suppliedPrincipal, dsaVToken);

        ResilientOracleInterface oracle = COMPTROLLER.oracle();
        uint256 longPrice = oracle.getUnderlyingPrice(address(longVToken));
        values.shortPrice = oracle.getUnderlyingPrice(address(shortVToken));
        values.dsaPrice = oracle.getUnderlyingPrice(address(dsaVToken));

        if (longPrice == 0 || values.shortPrice == 0 || values.dsaPrice == 0) {
            revert InvalidOraclePrice();
        }

        values.longValueUSD = (longCollateral * longPrice) / 1e18;
        values.borrowValueUSD = (shortDebt * values.shortPrice) / 1e18;
        values.suppliedPrincipalUSD = (suppliedPrincipalUnderlying * values.dsaPrice) / 1e18;
    }

    /**
     * @notice Calculates withdrawal utilization for a position
     * @param user User address
     * @param longVToken The vToken market for the long asset
     * @param shortVToken The vToken market for the short asset
     * @param dsaVToken The vToken market for the DSA asset
     * @return utilization Utilization information
     */
    function _getUtilizationInfo(
        address user,
        IVToken longVToken,
        IVToken shortVToken,
        IVToken dsaVToken
    ) internal returns (UtilizationInfo memory utilization) {
        Position memory position = positions[user][address(longVToken)][address(shortVToken)];

        PositionValuesUSD memory values = _getPositionValuesUSD(position, longVToken, shortVToken, dsaVToken, 0);

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
        utilization.withdrawableAmount = (utilization.availableCapitalUSD * 1e18) / values.dsaPrice;
    }

    /**
     * @notice Internal: Calculates the maximum allowed borrow amount for a position
     * @param user Address of the user
     * @param longVToken The vToken market for the long asset
     * @param shortVToken The vToken market for the short asset
     * @param dsaVToken The vToken market for the DSA asset
     * @return maxBorrowAmount Maximum amount that can be borrowed in shortAsset terms
     */
    function _calculateMaxBorrow(
        address user,
        IVToken longVToken,
        IVToken shortVToken,
        IVToken dsaVToken
    ) internal returns (uint256 maxBorrowAmount) {
        Position memory position = positions[user][address(longVToken)][address(shortVToken)];

        if (!position.isActive || position.effectiveLeverage == 0) {
            return 0;
        }

        // Get utilization info which calculates available capital
        UtilizationInfo memory utilization = _getUtilizationInfo(user, longVToken, shortVToken, dsaVToken);

        // Calculate max additional borrow amount: availableCapital * effectiveLeverage
        uint256 maxAdditionalBorrowUSD = (utilization.availableCapitalUSD * position.effectiveLeverage) / MANTISSA_ONE;

        // Convert to shortAsset amount
        ResilientOracleInterface oracle = COMPTROLLER.oracle();
        uint256 shortPrice = oracle.getUnderlyingPrice(address(shortVToken));

        if (shortPrice == 0) {
            revert InvalidOraclePrice();
        }

        maxBorrowAmount = (maxAdditionalBorrowUSD * 1e18) / shortPrice;
    }

    /**
     * @notice Converts supplied principal from vToken amount to underlying amount using current exchange rate
     * @param suppliedPrincipalVTokens Supplied principal stored in vToken amount
     * @param dsaVToken The DSA vToken
     * @return underlying amount equivalent to the vToken principal
     */
    function _getSuppliedPrincipalUnderlying(
        uint256 suppliedPrincipalVTokens,
        IVToken dsaVToken
    ) internal returns (uint256) {
        if (suppliedPrincipalVTokens == 0) return 0;
        uint256 exchangeRate = dsaVToken.exchangeRateCurrent();
        return (suppliedPrincipalVTokens * exchangeRate) / 1e18;
    }

    /**
     * @notice Gets the actual long collateral balance, excluding DSA principal if DSA == long asset
     * @param position The position data
     * @param longVToken The long asset vToken
     * @return longBalance The actual long collateral balance in underlying (excluding DSA principal if DSA == long)
     */
    function _getLongCollateralBalance(
        Position memory position,
        IVToken longVToken
    ) internal returns (uint256 longBalance) {
        IVToken dsaVToken = IVToken(dsaVTokens[position.dsaIndex]);

        if (address(longVToken) == address(dsaVToken)) {
            // Same asset: vToken balance minus principal vTokens, then convert to underlying
            uint256 vTokenBalance = longVToken.balanceOf(position.positionAccount);
            uint256 netVTokens = vTokenBalance > position.suppliedPrincipal
                ? vTokenBalance - position.suppliedPrincipal
                : 0;
            uint256 exchangeRate = longVToken.exchangeRateCurrent();
            longBalance = (netVTokens * exchangeRate) / 1e18;
        } else {
            longBalance = longVToken.balanceOfUnderlying(position.positionAccount);
        }
    }

    /**
     * @notice Enters a market on behalf of the position account
     * @param positionAccount Address of the position account
     * @param vToken Address of the vToken market to enter
     */
    function _enterMarket(address positionAccount, address vToken) internal {
        uint256 enterMarketError = COMPTROLLER.enterMarketBehalf(positionAccount, vToken);
        if (enterMarketError != 0) {
            revert EnterMarketFailed();
        }
    }

    /**
     * @notice Transfers DSA underlying from msg.sender to this contract, approves and mints vTokens to the position account
     * @param positionAccount Address of the position account to receive the minted vTokens
     * @param dsaVToken The DSA vToken market
     * @param amount Amount of underlying to transfer and mint
     * @return vTokensMinted vToken balance increase of the position account (for updating suppliedPrincipal)
     */
    function _supplyPrincipalToPositionAccount(
        address positionAccount,
        IVToken dsaVToken,
        uint256 amount
    ) internal returns (uint256 vTokensMinted) {
        uint256 balanceBefore = dsaVToken.balanceOf(positionAccount);
        address underlying = dsaVToken.underlying();
        IERC20Upgradeable(underlying).safeTransferFrom(msg.sender, address(this), amount);
        IERC20Upgradeable(underlying).approve(address(dsaVToken), amount);
        uint256 mintError = dsaVToken.mintBehalf(positionAccount, amount);
        if (mintError != 0) revert MintBehalfFailed();
        vTokensMinted = dsaVToken.balanceOf(positionAccount) - balanceBefore;
    }

    /**
     * @notice Transfers token dust from position account to the position owner (msg.sender from the user's perspective)
     * @dev Calls PositionAccount.transferDustToOwner which is only callable by this manager; dust goes to account owner.
     * @param positionAccount Address of the position account holding the dust
     * @param tokenAddress Address of the ERC20 token to transfer
     */
    function _transferDustToUser(address positionAccount, address tokenAddress) internal {
        IPositionAccount(positionAccount).transferDustToOwner(tokenAddress);
    }

    /**
     * @notice Performs token swap via the SwapHelper contract (same pattern as LeverageStrategiesManager)
     * @dev Transfers tokens to SwapHelper and executes the swap. Output tokens are expected to be sent to this contract.
     * @param tokenIn The input token to be swapped
     * @param amountIn The amount of input tokens to swap
     * @param tokenOut The output token to receive from the swap
     * @param minAmountOut The minimum acceptable amount of output tokens
     * @param param The encoded swap instructions/calldata for the SwapHelper
     * @return amountOut The actual amount of output tokens received from the swap
     */
    function _performSwap(
        IERC20Upgradeable tokenIn,
        uint256 amountIn,
        IERC20Upgradeable tokenOut,
        uint256 minAmountOut,
        bytes calldata param
    ) internal returns (uint256 amountOut) {
        tokenIn.safeTransfer(address(SWAP_HELPER), amountIn);

        uint256 tokenOutBalanceBefore = tokenOut.balanceOf(address(this));

        (bool success, ) = address(SWAP_HELPER).call(param);
        if (!success) revert TokenSwapCallFailed();

        uint256 tokenOutBalanceAfter = tokenOut.balanceOf(address(this));
        amountOut = tokenOutBalanceAfter - tokenOutBalanceBefore;
        if (amountOut < minAmountOut) revert SlippageExceeded();

        return amountOut;
    }

    /**
     * @notice Redeems excess long (full amount), swaps up to user amount long→DSA, transfers swapped DSA + extra collateral to user
     * @dev If amountToRedeemForProfitSwap < current excess long, we still redeem full excess, swap the intended amount,
     *      and transfer to user both the swapped amount (DSA) and the extra redeemed collateral (long).
     */
    function _realizeProfitFromExcessLong(
        address positionAccount,
        IVToken longVToken,
        address longUnderlying,
        address dsaUnderlying,
        uint256 excessLongToRedeem,
        uint256 amountToRedeemForProfitSwap,
        uint256 minAmountOutProfit,
        bytes calldata swapDataProfit
    ) internal {
        // Always redeem full excess (if user supplied amount < current excess, we still redeem full)
        uint256 redeemErr = longVToken.redeemUnderlyingBehalf(positionAccount, excessLongToRedeem);
        if (redeemErr != 0) revert RedeemBehalfFailed();

        IERC20Upgradeable longAsset = IERC20Upgradeable(longUnderlying);
        uint256 longBalance = longAsset.balanceOf(address(this));

        // Amount to send to swap: min(user amount, actual balance). Rest is extra collateral to transfer to user.
        uint256 amountForSwap = amountToRedeemForProfitSwap > longBalance ? longBalance : amountToRedeemForProfitSwap;
        if (amountForSwap > 0) {
            _performSwap(
                longAsset,
                amountForSwap,
                IERC20Upgradeable(dsaUnderlying),
                minAmountOutProfit,
                swapDataProfit
            );
        }

        uint256 dsaBalance = IERC20Upgradeable(dsaUnderlying).balanceOf(address(this));
        if (dsaBalance > 0) {
            IERC20Upgradeable(dsaUnderlying).safeTransfer(msg.sender, dsaBalance);
        }

        // Transfer extra redeemed collateral (long) that was not swapped
        uint256 extraLong = longBalance - amountForSwap;
        if (extraLong > 0) {
            longAsset.safeTransfer(msg.sender, extraLong);
        }
    }

    /**
     * @notice Withdraws complete principal: redeems all DSA from position account, transfers underlying to user, and zeros suppliedPrincipal
     */
    function _withdrawCompletePrincipalToUser(
        address positionAccount,
        IVToken dsaVToken,
        address dsaUnderlying,
        Position storage position
    ) internal {
        if (dsaVToken.balanceOfUnderlying(positionAccount) == 0) {
            position.suppliedPrincipal = 0;
            return;
        }
        uint256 err = dsaVToken.redeemUnderlyingBehalf(positionAccount, type(uint256).max);
        if (err != 0) revert RedeemBehalfFailed();
        uint256 received = IERC20Upgradeable(dsaUnderlying).balanceOf(address(this));
        if (received > 0) {
            IERC20Upgradeable(dsaUnderlying).safeTransfer(msg.sender, received);
        }
        position.suppliedPrincipal = 0;
    }

    /**
     * @notice Validates that a market is listed and supported
     * @param asset Asset address to validate
     */
    function checkMarketListed(address asset) internal view {
        IVToken vToken = IVToken(asset);
        (bool isListed, , ) = COMPTROLLER.markets(address(vToken));
        if (!isListed) {
            revert AssetNotListed();
        }
        if (vToken == LEVERAGE_MANAGER.vBNB()) {
            revert VBNBNotSupported();
        }
    }

    /**
     * @notice Returns the maximum of two values
     */
    function max(uint256 a, uint256 b) internal pure returns (uint256) {
        return a >= b ? a : b;
    }

    /**
     * @notice Returns the minimum of two values
     */
    function min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a <= b ? a : b;
    }
}
