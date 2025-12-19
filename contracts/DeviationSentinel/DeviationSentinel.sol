pragma solidity ^0.8.25;

import { ICorePoolComptroller } from "../Interfaces/ICorePoolComptroller.sol";
import { IILComptroller } from "../Interfaces/IILComptroller.sol";
import { IComptroller } from "../Interfaces/IComptroller.sol";
import { IVToken } from "../Interfaces/IVToken.sol";
import {
    ResilientOracleInterface,
    OracleInterface
} from "@venusprotocol/oracle/contracts/interfaces/OracleInterface.sol";
import { AccessControlledV8 } from "@venusprotocol/governance-contracts/contracts/Governance/AccessControlledV8.sol";

/**
 * @title DeviationSentinel
 * @author Venus
 * @notice Sentinel that compares ResilientOracle and SentinelOracle prices (via keeper) and pauses
 *         specific actions (borrow, mint, collateral factor) per market when
 *         large deviations are detected.
 */
contract DeviationSentinel is AccessControlledV8 {
    /// @notice Configuration for price deviation monitoring
    /// @param deviation Maximum allowed deviation percentage (e.g., 10 = 10%)
    /// @param enabled Whether deviation monitoring is enabled for this token
    struct DeviationConfig {
        uint8 deviation;
        bool enabled;
    }

    /// @notice State tracking for market modifications by this contract
    /// @param borrowPaused True if borrow is paused for this market by this contract
    /// @param cfModifiedAndSupplyPaused True if collateral factor was modified and supply is paused by this contract
    /// @param poolCFs Mapping of pool ID to original collateral factor (0 for isolated pools, 1+ for core pool emode groups)
    /// @param poolLTs Mapping of pool ID to original liquidation threshold (0 for isolated pools, 1+ for core pool emode groups)
    struct MarketState {
        bool borrowPaused;
        bool cfModifiedAndSupplyPaused;
        mapping(uint96 => uint256) poolCFs;
        mapping(uint96 => uint256) poolLTs;
    }

    /// @notice Maximum allowed price deviation in percentage (e.g., 10 = 10%)
    uint8 public constant MAX_DEVIATION = 100;

    /// @notice Address of the Core Pool Comptroller
    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    ICorePoolComptroller public immutable CORE_POOL_COMPTROLLER;

    /// @notice Resilient Oracle for getting reference prices
    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    ResilientOracleInterface public immutable RESILIENT_ORACLE;

    /// @notice Sentinel Oracle for getting DEX prices
    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    OracleInterface public immutable SENTINEL_ORACLE;

    /// @notice Mapping of token addresses to their DEX configuration
    mapping(address => DeviationConfig) public tokenConfigs;

    /// @notice Mapping of trusted keeper addresses
    mapping(address => bool) public trustedKeepers;

    /// @notice Mapping to track market state changes made by this contract
    mapping(address => MarketState) public marketStates;

    /// @notice Emitted when a token's deviation configuration is updated
    /// @param token The token address
    /// @param config The new deviation configuration
    event TokenConfigUpdated(address indexed token, DeviationConfig config);

    /// @notice Emitted when a token's monitoring status is changed
    /// @param token The token address
    /// @param enabled Whether monitoring is enabled
    event TokenMonitoringStatusChanged(address indexed token, bool enabled);

    /// @notice Emitted when a keeper's trusted status is updated
    /// @param keeper The keeper address
    /// @param isTrusted Whether the keeper is trusted
    event TrustedKeeperUpdated(address indexed keeper, bool isTrusted);

    /// @notice Emitted when a market's state is reset
    /// @param market The market address
    event MarketStateReset(address indexed market);

    /// @notice Emitted when borrow is paused for a market
    /// @param market The market address
    event BorrowPaused(address indexed market);

    /// @notice Emitted when borrow is unpaused for a market
    /// @param market The market address
    event BorrowUnpaused(address indexed market);

    /// @notice Emitted when supply is paused for a market
    /// @param market The market address
    event SupplyPaused(address indexed market);

    /// @notice Emitted when supply is unpaused for a market
    /// @param market The market address
    event SupplyUnpaused(address indexed market);

    /// @notice Emitted when collateral factor is updated for core pool
    /// @param market The market address
    /// @param poolId The pool ID (emode group)
    /// @param oldCF The old collateral factor
    /// @param newCF The new collateral factor
    event CollateralFactorUpdated(address indexed market, uint96 indexed poolId, uint256 oldCF, uint256 newCF);

    /// @notice Emitted when collateral factor is updated for isolated pool
    /// @param market The market address
    /// @param oldCF The old collateral factor
    /// @param newCF The new collateral factor
    event CollateralFactorUpdated(address indexed market, uint256 oldCF, uint256 newCF);

    /// @notice Thrown when deviation is set to zero
    error ZeroDeviation();

    /// @notice Thrown when deviation exceeds maximum allowed
    error ExceedsMaxDeviation();

    /// @notice Thrown when a zero address is provided
    error ZeroAddress();

    /// @notice Thrown when caller is not an authorized keeper
    error UnauthorizedKeeper();

    /// @notice Thrown when market is not configured for monitoring
    error MarketNotConfigured();

    /// @notice Thrown when token monitoring is disabled
    error TokenMonitoringDisabled();

    /// @notice Thrown when comptroller operation fails
    /// @param errorCode The error code returned by the comptroller
    error ComptrollerError(uint256 errorCode);

    modifier onlyKeeper() {
        if (!trustedKeepers[msg.sender]) revert UnauthorizedKeeper();
        _;
    }

    /// @notice Constructor for DeviationSentinel
    /// @param corePoolComptroller_ Address of the core pool comptroller
    /// @param resilientOracle_ Address of the resilient oracle
    /// @param sentinelOracle_ Address of the sentinel oracle
    constructor(
        ICorePoolComptroller corePoolComptroller_,
        ResilientOracleInterface resilientOracle_,
        OracleInterface sentinelOracle_
    ) {
        CORE_POOL_COMPTROLLER = corePoolComptroller_;

        if (address(resilientOracle_) == address(0)) revert ZeroAddress();
        if (address(sentinelOracle_) == address(0)) revert ZeroAddress();
        RESILIENT_ORACLE = resilientOracle_;
        SENTINEL_ORACLE = sentinelOracle_;

        // Note that the contract is upgradeable. Use initialize() or reinitializers
        // to set the state variables.
        _disableInitializers();
    }

    /// @notice Initialize the contract
    /// @param accessControlManager_ Address of the access control manager
    function initialize(address accessControlManager_) external initializer {
        __AccessControlled_init(accessControlManager_);
    }

    /// @notice Set trusted status for a keeper
    /// @param keeper Address of the keeper
    /// @param isTrusted Whether the keeper should be trusted
    /// @custom:event Emits TrustedKeeperUpdated event
    /// @custom:error ZeroAddress is thrown when keeper address is zero
    function setTrustedKeeper(address keeper, bool isTrusted) external {
        _checkAccessAllowed("setTrustedKeeper(address,bool)");

        if (keeper == address(0)) revert ZeroAddress();

        trustedKeepers[keeper] = isTrusted;
        emit TrustedKeeperUpdated(keeper, isTrusted);
    }

    /// @notice Set deviation configuration for a token
    /// @param token Address of the token
    /// @param config Deviation configuration containing threshold and enabled status
    /// @custom:event Emits TokenConfigUpdated event
    /// @custom:error ZeroAddress is thrown when token address is zero
    /// @custom:error ZeroDeviation is thrown when deviation is set to zero
    /// @custom:error ExceedsMaxDeviation is thrown when deviation exceeds MAX_DEVIATION
    function setTokenConfig(address token, DeviationConfig calldata config) external {
        _checkAccessAllowed("setTokenConfig(address,(uint8,bool))");

        if (token == address(0)) revert ZeroAddress();
        if (config.deviation == 0) revert ZeroDeviation();
        if (config.deviation > MAX_DEVIATION) revert ExceedsMaxDeviation();

        tokenConfigs[token] = config;
        emit TokenConfigUpdated(token, config);
    }

    /// @notice Enable or disable deviation monitoring for a token
    /// @param token Address of the token
    /// @param enabled Whether to enable or disable monitoring
    /// @custom:event Emits TokenMonitoringStatusChanged event
    /// @custom:error ZeroAddress is thrown when token address is zero
    /// @custom:error MarketNotConfigured is thrown when token has no deviation config
    function setTokenMonitoringEnabled(address token, bool enabled) external {
        _checkAccessAllowed("setTokenMonitoringEnabled(address,bool)");

        if (token == address(0)) revert ZeroAddress();

        DeviationConfig storage config = tokenConfigs[token];
        if (config.deviation == 0) revert MarketNotConfigured();

        config.enabled = enabled;
        emit TokenMonitoringStatusChanged(token, enabled);
    }

    /// @notice Reset the market state for a specific market
    /// @dev This should be called after manually intervening in a paused market and before re-enabling deviation monitoring.
    ///      It clears all stored state including pause flags and original collateral factors to prevent mismatches
    ///      between the protocol state and this contract's tracked state.
    /// @param market The vToken market to reset
    /// @custom:event Emits MarketStateReset event
    /// @custom:error ZeroAddress is thrown when market address is zero
    function resetMarketState(IVToken market) external {
        _checkAccessAllowed("resetMarketState(address)");

        if (address(market) == address(0)) revert ZeroAddress();

        MarketState storage state = marketStates[address(market)];
        IComptroller comptroller = market.comptroller();

        // Clear pool-specific data for core pool
        if (address(comptroller) == address(CORE_POOL_COMPTROLLER)) {
            for (uint96 i = CORE_POOL_COMPTROLLER.corePoolId(); i <= CORE_POOL_COMPTROLLER.lastPoolId(); i++) {
                delete state.poolCFs[i];
                delete state.poolLTs[i];
            }
        } else {
            // Clear isolated pool data (stored at index 0)
            delete state.poolCFs[0];
            delete state.poolLTs[0];
        }

        // Clear pause flags
        state.borrowPaused = false;
        state.cfModifiedAndSupplyPaused = false;

        emit MarketStateReset(address(market));
    }

    /// @notice Handle price deviation for a market by pausing or adjusting collateral factor
    /// @param market The vToken market to handle
    /// @custom:event Emits BorrowPaused when borrow is paused due to high sentinel price
    /// @custom:event Emits BorrowUnpaused when borrow is unpaused after deviation resolved
    /// @custom:event Emits SupplyPaused when supply is paused due to low sentinel price
    /// @custom:event Emits SupplyUnpaused when supply is unpaused after deviation resolved
    /// @custom:event Emits CollateralFactorUpdated when collateral factor is modified
    /// @custom:error UnauthorizedKeeper is thrown when caller is not a trusted keeper
    /// @custom:error MarketNotConfigured is thrown when market's underlying token has no deviation config
    /// @custom:error TokenMonitoringDisabled is thrown when monitoring is disabled for the token
    /// @custom:error ComptrollerError is thrown when comptroller operation fails
    function handleDeviation(IVToken market) external onlyKeeper {
        address underlyingToken = market.underlying();
        DeviationConfig memory config = tokenConfigs[underlyingToken];

        if (config.deviation == 0) revert MarketNotConfigured();
        if (!config.enabled) revert TokenMonitoringDisabled();

        (bool hasDeviation, uint256 oraclePrice, uint256 sentinelPrice, ) = checkPriceDeviation(market);

        MarketState storage state = marketStates[address(market)];

        if (hasDeviation) {
            if (sentinelPrice > oraclePrice) {
                // Early return if borrow is already paused
                if (state.borrowPaused) return;

                _pauseBorrow(market);
                state.borrowPaused = true;
            } else {
                // Early return if CF is already modified and supply is already paused
                if (state.cfModifiedAndSupplyPaused) return;

                _setCollateralFactorToZero(market);
                _pauseSupply(market);
                state.cfModifiedAndSupplyPaused = true;
            }
        } else {
            if (state.borrowPaused) {
                _unpauseBorrow(market);
                state.borrowPaused = false;
            }

            if (state.cfModifiedAndSupplyPaused) {
                _restoreCollateralFactor(market);
                _unpauseSupply(market);
                state.cfModifiedAndSupplyPaused = false;
            }
        }
    }

    /// @notice Check if there is a price deviation between resilient oracle and sentinel oracle for a market
    /// @param market The vToken market to check
    /// @return hasDeviation True if deviation exceeds configured threshold
    /// @return oraclePrice The price from resilient oracle
    /// @return sentinelPrice The price from sentinel oracle
    /// @return deviationPercent The percentage deviation (scaled by 100)
    function checkPriceDeviation(
        IVToken market
    ) public view returns (bool hasDeviation, uint256 oraclePrice, uint256 sentinelPrice, uint256 deviationPercent) {
        address underlyingToken = market.underlying();
        DeviationConfig memory config = tokenConfigs[underlyingToken];

        oraclePrice = RESILIENT_ORACLE.getPrice(underlyingToken);
        sentinelPrice = SENTINEL_ORACLE.getPrice(underlyingToken);

        if (oraclePrice == 0 || sentinelPrice == 0) {
            hasDeviation = true;
            deviationPercent = type(uint256).max;
            return (hasDeviation, oraclePrice, sentinelPrice, deviationPercent);
        }

        // Both prices are already in (36 - tokenDecimals) format, so we can compare directly
        uint256 priceDiff;
        if (sentinelPrice > oraclePrice) {
            priceDiff = sentinelPrice - oraclePrice;
        } else {
            priceDiff = oraclePrice - sentinelPrice;
        }

        deviationPercent = (priceDiff * 100) / oraclePrice;
        hasDeviation = deviationPercent >= config.deviation;
    }

    /// @notice Pause borrow action for a market
    /// @param market The market to pause borrow for
    function _pauseBorrow(IVToken market) internal {
        IComptroller comptroller = market.comptroller();

        address[] memory markets = new address[](1);
        markets[0] = address(market);
        IComptroller.Action[] memory actions = new IComptroller.Action[](1);
        actions[0] = IComptroller.Action.BORROW;

        comptroller.setActionsPaused(markets, actions, true);
        emit BorrowPaused(address(market));
    }

    /// @notice Unpause borrow action for a market
    /// @param market The market to unpause borrow for
    function _unpauseBorrow(IVToken market) internal {
        IComptroller comptroller = market.comptroller();

        address[] memory markets = new address[](1);
        markets[0] = address(market);
        IComptroller.Action[] memory actions = new IComptroller.Action[](1);
        actions[0] = IComptroller.Action.BORROW;

        comptroller.setActionsPaused(markets, actions, false);
        emit BorrowUnpaused(address(market));
    }

    /// @notice Pause supply action for a market
    /// @param market The market to pause supply for
    function _pauseSupply(IVToken market) internal {
        IComptroller comptroller = market.comptroller();

        address[] memory markets = new address[](1);
        markets[0] = address(market);
        IComptroller.Action[] memory actions = new IComptroller.Action[](1);
        actions[0] = IComptroller.Action.MINT;

        comptroller.setActionsPaused(markets, actions, true);
        emit SupplyPaused(address(market));
    }

    /// @notice Unpause supply action for a market
    /// @param market The market to unpause supply for
    function _unpauseSupply(IVToken market) internal {
        IComptroller comptroller = market.comptroller();

        address[] memory markets = new address[](1);
        markets[0] = address(market);
        IComptroller.Action[] memory actions = new IComptroller.Action[](1);
        actions[0] = IComptroller.Action.MINT;

        comptroller.setActionsPaused(markets, actions, false);
        emit SupplyUnpaused(address(market));
    }

    /// @notice Set collateral factor to zero and store original value
    /// @param market The market to modify
    function _setCollateralFactorToZero(IVToken market) internal {
        IComptroller comptroller = market.comptroller();
        MarketState storage state = marketStates[address(market)];

        if (address(comptroller) == address(CORE_POOL_COMPTROLLER)) {
            // Store original CF and LT for each emode group, then set to 0
            for (uint96 i = CORE_POOL_COMPTROLLER.corePoolId(); i <= CORE_POOL_COMPTROLLER.lastPoolId(); i++) {
                (
                    bool isListed,
                    uint256 collateralFactorMantissa, // isVenus
                    ,
                    uint256 liquidationThresholdMantissa, // liquidationIncentiveMantissa // marketPoolId // isBorrowAllowed
                    ,
                    ,

                ) = CORE_POOL_COMPTROLLER.poolMarkets(i, address(market));

                if (isListed) {
                    // Store original values for this pool ID
                    state.poolCFs[i] = collateralFactorMantissa;
                    state.poolLTs[i] = liquidationThresholdMantissa;

                    // Set collateral factor to 0, keep liquidation threshold unchanged
                    uint256 result = CORE_POOL_COMPTROLLER.setCollateralFactor(
                        i,
                        address(market),
                        0,
                        liquidationThresholdMantissa
                    );
                    if (result != 0) revert ComptrollerError(result);

                    // Emit event for each pool ID
                    emit CollateralFactorUpdated(address(market), i, collateralFactorMantissa, 0);
                }
            }
        } else {
            IILComptroller.Market memory marketData = IILComptroller(address(comptroller)).markets(address(market));
            if (marketData.isListed) {
                state.poolCFs[0] = marketData.collateralFactorMantissa;
                state.poolLTs[0] = marketData.liquidationThresholdMantissa;
                IILComptroller(address(comptroller)).setCollateralFactor(
                    address(market),
                    0,
                    marketData.liquidationThresholdMantissa
                );
                emit CollateralFactorUpdated(address(market), 0, marketData.collateralFactorMantissa, 0);
            }
        }
    }

    /// @notice Restore original collateral factor
    /// @param market The market to restore
    function _restoreCollateralFactor(IVToken market) internal {
        IComptroller comptroller = market.comptroller();
        MarketState storage state = marketStates[address(market)];

        // Check if this is a core pool or isolated pool
        if (address(comptroller) == address(CORE_POOL_COMPTROLLER)) {
            // Core pool - restore original CF and LT for each emode group
            for (uint96 i = CORE_POOL_COMPTROLLER.corePoolId(); i <= CORE_POOL_COMPTROLLER.lastPoolId(); i++) {
                (bool isListed, , , , , , ) = CORE_POOL_COMPTROLLER.poolMarkets(i, address(market));
                if (isListed) {
                    uint256 result = CORE_POOL_COMPTROLLER.setCollateralFactor(
                        i,
                        address(market),
                        state.poolCFs[i],
                        state.poolLTs[i]
                    );
                    if (result != 0) revert ComptrollerError(result);

                    // Emit event for each pool ID
                    emit CollateralFactorUpdated(address(market), i, 0, state.poolCFs[i]);

                    // Clear stored values
                    delete state.poolCFs[i];
                    delete state.poolLTs[i];
                }
            }
        } else {
            // Isolated pool
            uint256 originalCF = state.poolCFs[0];
            uint256 originalLT = state.poolLTs[0];
            IILComptroller(address(comptroller)).setCollateralFactor(address(market), originalCF, originalLT);
            emit CollateralFactorUpdated(address(market), 0, 0, originalCF);
            delete state.poolCFs[0];
            delete state.poolLTs[0];
        }
    }
}
