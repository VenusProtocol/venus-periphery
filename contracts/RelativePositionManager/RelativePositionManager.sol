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
     *      in openPosition and scalePosition operations.
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

        if (desiredLeverage < MIN_LEVERAGE || desiredLeverage > MAX_LEVERAGE) {
            revert InvalidLeverage();
        }

        Position storage position = positions[msg.sender][longAsset][shortAsset];

        if (position.isActive) {
            revert PositionAlreadyExists();
        }

        // Deploy position account if it doesn't exist (sets immutable fields)
        if (position.positionAccount == address(0)) {
            _deployPositionAccount(msg.sender, longAsset, shortAsset, dsaIndex);
        }

        // Increment cycle ID on each activation
        position.cycleId++;

        // Set mutable position state
        position.isActive = true;
        position.dsaIndex = dsaIndex;
        position.suppliedPrincipal = initialPrincipal;
        position.effectiveLeverage = desiredLeverage;

        // Enter DSA market on behalf of position account (to use as collateral)
        _enterMarket(position.positionAccount, dsaVToken);

        // Supply initial principal if provided
        if (initialPrincipal > 0) {
            address underlying = IVToken(dsaVToken).underlying();

            IERC20Upgradeable(underlying).safeTransferFrom(msg.sender, address(this), initialPrincipal);
            IERC20Upgradeable(underlying).approve(dsaVToken, initialPrincipal);

            uint256 mintError = IVToken(dsaVToken).mintBehalf(position.positionAccount, initialPrincipal);
            if (mintError != 0) {
                revert MintBehalfFailed();
            }
        }

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

        address dsaVToken = dsaVTokens[dsaIndex];
        address underlying = IVToken(dsaVToken).underlying();

        IERC20Upgradeable(underlying).safeTransferFrom(msg.sender, address(this), amount);
        IERC20Upgradeable(underlying).approve(dsaVToken, amount);

        uint256 mintError = IVToken(dsaVToken).mintBehalf(positionAccount, amount);
        if (mintError != 0) {
            revert MintBehalfFailed();
        }

        position.suppliedPrincipal += amount;

        emit PrincipalSupplied(msg.sender, positionAccount, address(dsaVToken), amount, position.suppliedPrincipal);
    }

    /**
     * @notice Opens a leveraged position using the supplied principal
     * @dev Validates that markets are listed and that the borrowAmount doesn't exceed the maximum allowed
     *      based on capital utilization. Uses sophisticated calculation considering:
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
    ) external nonReentrant {
        if (shortAmount == 0) revert ZeroBorrowAmount();

        // Validate that markets are listed
        checkMarketListed(address(longVToken));
        checkMarketListed(address(shortVToken));

        Position storage position = positions[msg.sender][address(longVToken)][address(shortVToken)];

        if (!position.isActive) {
            revert PositionNotActive();
        }
        if (position.suppliedPrincipal == 0) {
            revert InsufficientPrincipal();
        }

        address positionAccount = position.positionAccount;

        IVToken dsaVToken = IVToken(dsaVTokens[position.dsaIndex]);

        // Calculate maximum allowed borrow based on available capital and utilization
        uint256 maxBorrowAmount = _calculateMaxBorrow(msg.sender, longVToken, shortVToken, dsaVToken);

        // Validate that shortAmount doesn't exceed the maximum
        if (shortAmount > maxBorrowAmount) {
            revert BorrowAmountExceedsMaximum();
        }

        LEVERAGE_MANAGER.enterLeverage(
            longVToken, // collateral market (long asset from swap)
            0, // collateral amount seed (no seed, comes from Principal DSA)
            shortVToken, // borrow market (short asset)
            shortAmount, // borrow amount
            minLongAmount, // minimum long asset amount after swap
            swapData
        );

        emit PositionOpened(
            msg.sender,
            positionAccount,
            position.cycleId,
            address(longVToken),
            address(shortVToken),
            address(dsaVToken),
            shortAmount,
            position.effectiveLeverage
        );
    }

    /**
     * @notice Scales an existing position while maintaining the same leverage ratio
     * @dev Validates that markets are listed and that shortAmount doesn't exceed the maximum allowed
     *      based on capital utilization. Uses sophisticated calculation considering current position state,
     *      collateral ratios, and available capital. Maximum borrow = available capital * effective leverage.
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
    ) external nonReentrant {
        if (shortAmount == 0) revert ZeroBorrowAmount();

        // Validate that markets are listed
        checkMarketListed(address(longVToken));
        checkMarketListed(address(shortVToken));

        Position storage position = positions[msg.sender][address(longVToken)][address(shortVToken)];

        if (!position.isActive) {
            revert PositionNotActive();
        }

        address positionAccount = position.positionAccount;

        // Supply additional principal first if provided
        if (additionalPrincipal > 0) {
            supplyPrincipal(address(longVToken), address(shortVToken), position.dsaIndex, additionalPrincipal);
        }

        IVToken dsaVToken = IVToken(dsaVTokens[position.dsaIndex]);

        // Calculate maximum allowed borrow based on available capital and utilization
        uint256 maxBorrowAmount = _calculateMaxBorrow(msg.sender, longVToken, shortVToken, dsaVToken);

        // Validate that shortAmount doesn't exceed the maximum
        if (shortAmount > maxBorrowAmount) {
            revert BorrowAmountExceedsMaximum();
        }

        // Scale the position by borrowing more and swapping
        LEVERAGE_MANAGER.enterLeverage(
            longVToken, // collateral market (long asset from swap)
            0, // no additional collateral seed (comes from swap)
            shortVToken, // borrow market (short asset)
            shortAmount,
            minLongAmount, // minimum long asset amount after swap
            swapData
        );

        emit PositionScaled(
            msg.sender,
            positionAccount,
            position.cycleId,
            additionalPrincipal,
            position.suppliedPrincipal
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

        // Close position via LeverageManager (partial or full)
        LEVERAGE_MANAGER.exitLeverage(
            longVToken, // collateral market (long asset to redeem)
            collateralAmountToRedeem, // amount of long collateral to redeem
            shortVToken, // borrowed market (short asset debt to repay)
            borrowedAmountToRepay, // amount of short debt to repay
            minAmountOutAfterSwap, // minimum amount out after swap (slippage protection)
            swapData // swap instructions (long → short)
        );

        // After closing, validate that leverage is still within acceptable range
        // If position is partially closed, validate leverage constraint is still satisfied
        uint256 remainingShortDebt = shortVToken.borrowBalanceStored(positionAccount);
        if (remainingShortDebt > 0) {
            ResilientOracleInterface oracle = COMPTROLLER.oracle();
            uint256 shortPrice = oracle.getUnderlyingPrice(address(shortVToken));
            IVToken dsaVToken = IVToken(dsaVTokens[position.dsaIndex]);
            uint256 dsaPrice = oracle.getUnderlyingPrice(address(dsaVToken));

            // Calculate maximum allowed borrow based on supplied principal and leverage
            // maxAllowedBorrowUSD = suppliedPrincipalUSD * effectiveLeverage
            uint256 remainingShortDebtUSD = (remainingShortDebt * shortPrice) / 1e18;
            uint256 suppliedPrincipalUSD = (position.suppliedPrincipal * dsaPrice) / 1e18;
            uint256 maxAllowedBorrowUSD = (suppliedPrincipalUSD * position.effectiveLeverage) / MANTISSA_ONE;

            // Validate remaining debt should not exceed maximum allowed borrow
            if (remainingShortDebtUSD > maxAllowedBorrowUSD) {
                revert BorrowAmountExceedsMaximum();
            }
        }

        emit PositionClosed(msg.sender, positionAccount, position.cycleId);
    }

    /**
     * @notice Withdraws unused principal from an active position
     * @dev Calculates utilization to determine how much can be safely withdrawn.
     *      The DSA asset is retrieved from the position data (set during activation).
     * @param longVToken The vToken market for the long asset
     * @param shortVToken The vToken market for the short asset
     * @param amount Amount to withdraw
     */
    function withdrawPrincipal(IVToken longVToken, IVToken shortVToken, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();

        Position storage position = positions[msg.sender][address(longVToken)][address(shortVToken)];

        if (!position.isActive) {
            revert PositionNotActive();
        }

        // Get DSA vToken from stored position data
        IVToken dsaVToken = IVToken(dsaVTokens[position.dsaIndex]);

        UtilizationInfo memory utilization = _getUtilizationInfo(msg.sender, longVToken, shortVToken, dsaVToken);

        if (amount > utilization.withdrawableAmount) {
            revert InsufficientWithdrawableAmount();
        }

        address positionAccount = position.positionAccount;

        uint256 redeemError = dsaVToken.redeemUnderlyingBehalf(positionAccount, amount);
        if (redeemError != 0) {
            revert RedeemBehalfFailed();
        }

        address underlying = dsaVToken.underlying();
        IERC20Upgradeable(underlying).safeTransfer(msg.sender, amount);

        position.suppliedPrincipal -= amount;

        emit PrincipalWithdrawn(msg.sender, positionAccount, address(dsaVToken), amount, position.suppliedPrincipal);
    }

    /**
     * @notice Deactivates a position account
     * @dev Removes DSA selection and resets leverage. User can activate with new DSA later.
     *      The DSA asset is retrieved from the position data (set during activation).
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

        // Check if there's any DSA supply remaining and withdraw it
        uint256 dsaUnderlyingBalance = dsaVToken.balanceOfUnderlying(positionAccount);
        if (dsaUnderlyingBalance > 0) {
            address underlying = dsaVToken.underlying();

            uint256 balanceBefore = IERC20Upgradeable(underlying).balanceOf(address(this));

            uint256 redeemError = dsaVToken.redeemUnderlyingBehalf(positionAccount, type(uint256).max);
            if (redeemError != 0) {
                revert RedeemBehalfFailed();
            }

            uint256 balanceAfter = IERC20Upgradeable(underlying).balanceOf(address(this));
            uint256 amountReceived = balanceAfter - balanceBefore;

            // Transfer received amount to user
            if (amountReceived > 0) {
                IERC20Upgradeable(underlying).safeTransfer(msg.sender, amountReceived);
            }
        }

        emit PositionDeactivated(msg.sender, positionAccount, position.cycleId);

        // Reset position state
        position.isActive = false;
        position.effectiveLeverage = 0;
        position.suppliedPrincipal = 0;
    }

    /**
     * @notice Adds a new DSA vToken to the supported list
     * @dev Index will be the current length of the array.
     *      TODO: Add ACM-based access control here
     * @param dsaVToken The vToken market address to add as a supported DSA
     */
    function addDSAVToken(address dsaVToken) external {
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
     * @dev Uses deterministic deployment via clones and initializes the clone with user-specific data
     * @param user User address
     * @param longAsset Long asset vToken address
     * @param shortAsset Short asset vToken address
     * @param dsaIndex Index of the DSA vToken in the dsaVTokens array
     * @return positionAccount Address of the deployed PositionAccount
     */
    function _deployPositionAccount(
        address user,
        address longAsset,
        address shortAsset,
        uint8 dsaIndex
    ) internal returns (address positionAccount) {
        bytes32 salt = keccak256(abi.encodePacked(user, longAsset, shortAsset));
        positionAccount = ClonesUpgradeable.cloneDeterministic(POSITION_ACCOUNT_IMPLEMENTATION, salt);

        // Initialize the clone with user-specific data (owner, longAsset, shortAsset)
        // This will automatically approve both RPM and LeverageManager as delegates
        IPositionAccount(positionAccount).initialize(user, longAsset, shortAsset);

        positionAccounts[user][longAsset][shortAsset] = positionAccount;

        // Set immutable position fields (these never change)
        Position storage position = positions[user][longAsset][shortAsset];
        position.user = user;
        position.longAsset = longAsset;
        position.shortAsset = shortAsset;
        position.dsaIndex = dsaIndex;
        position.positionAccount = positionAccount;
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

        address positionAccount = position.positionAccount;

        ResilientOracleInterface oracle = COMPTROLLER.oracle();
        uint256 longPrice = oracle.getUnderlyingPrice(address(longVToken));
        uint256 shortPrice = oracle.getUnderlyingPrice(address(shortVToken));
        uint256 dsaPrice = oracle.getUnderlyingPrice(address(dsaVToken));

        if (longPrice == 0 || shortPrice == 0 || dsaPrice == 0) {
            revert InvalidOraclePrice();
        }

        uint256 longCollateral = _getLongCollateralBalance(position, longVToken);
        uint256 shortDebt = shortVToken.borrowBalanceStored(positionAccount);

        // Calculate USD values
        uint256 longValueUSD = (longCollateral * longPrice) / 1e18;
        uint256 borrowValueUSD = (shortDebt * shortPrice) / 1e18;
        uint256 suppliedPrincipalUSD = (position.suppliedPrincipal * dsaPrice) / 1e18;

        (, uint256 dsaLTV, ) = COMPTROLLER.markets(address(dsaVToken));
        (, uint256 longLTV, ) = COMPTROLLER.markets(address(longVToken));

        // Calculate nominalCapitalUtilized borrowValueUSD/effectiveLeverage
        utilization.nominalCapitalUtilized = (borrowValueUSD * MANTISSA_ONE) / position.effectiveLeverage;

        // Calculate actualCapitalUtilized (borrowValueUSD - (longValueUSD * longLTV) / dsaLTV
        utilization.actualCapitalUtilized = borrowValueUSD > (longValueUSD * longLTV) / MANTISSA_ONE
            ? ((borrowValueUSD - (longValueUSD * longLTV) / MANTISSA_ONE) * MANTISSA_ONE) / dsaLTV
            : 0;

        utilization.finalCapitalUtilized = max(utilization.actualCapitalUtilized, utilization.nominalCapitalUtilized);
        utilization.finalCapitalUtilized = min(suppliedPrincipalUSD, utilization.finalCapitalUtilized);

        // Calculate available capital in USD (finalCapitalUtilized is already capped by suppliedPrincipal)
        utilization.availableCapitalUSD = suppliedPrincipalUSD - utilization.finalCapitalUtilized;

        // Calculate withdrawable amount in DSA token terms
        utilization.withdrawableAmount = (utilization.availableCapitalUSD * 1e18) / dsaPrice;
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
     * @notice Gets the actual long collateral balance, excluding DSA principal if DSA == long asset
     * @param position The position data
     * @param longVToken The long asset vToken
     * @return longBalance The actual long collateral balance (excluding DSA principal if applicable)
     */
    function _getLongCollateralBalance(
        Position memory position,
        IVToken longVToken
    ) internal returns (uint256 longBalance) {
        address positionAccount = position.positionAccount;
        uint256 totalBalance = longVToken.balanceOfUnderlying(positionAccount);

        // Get DSA vToken from position
        IVToken dsaVToken = IVToken(dsaVTokens[position.dsaIndex]);

        // If DSA and long asset are the same, subtract the DSA principal to get only the long position from swaps
        longBalance = address(longVToken) == address(dsaVToken)
            ? totalBalance - position.suppliedPrincipal
            : totalBalance;
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
