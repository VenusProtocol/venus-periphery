// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.25;

import { ICorePoolComptroller } from "../Interfaces/ICorePoolComptroller.sol";
import { IComptroller } from "../Interfaces/IComptroller.sol";
import { IILComptroller } from "../Interfaces/IILComptroller.sol";
import { IVToken } from "../Interfaces/IVToken.sol";
import { IEBrake } from "../EmergencyBrake/IEBrake.sol";
import { IExecutor } from "./IExecutor.sol";
import { AccessControlledV8 } from "@venusprotocol/governance-contracts/contracts/Governance/AccessControlledV8.sol";

/**
 * @title Executor — Signal-Driven Condition Handler for E-brake V2
 * @author Venus Protocol
 * @notice Validates signal-driven conditions on-chain, enforces bounds and cooldowns,
 *         and routes validated actions to EBrake for execution.
 *
 * @dev    Example Flow: Hypernative (off-chain signal S1-S8) → Executor (validate) → EBrake (execute) → Comptroller
 *
 *         The Executor is the validation layer. It ensures:
 *         - LTV adjustments stay within [0, originalLTV]
 *         - Cap adjustments stay within [minCap, originalCap]
 *         - Increases (loosening) require a cooldown period
 *         - Supply and borrow halts only fire when caps are actually breached on-chain
 *
 *         The Executor does NOT hold detection logic — that lives off-chain in the signal pipeline.
 *         The Executor does NOT call the comptroller directly — all mutations go through EBrake.
 */
contract Executor is IExecutor, AccessControlledV8 {
    /// @notice The EBrake contract that executes emergency actions on the comptroller.
    IEBrake public immutable EBRAKE;

    /// @notice The comptroller that EBrake operates on.
    ICorePoolComptroller public immutable COMPTROLLER;

    /// @notice Whether this Executor targets a BSC Diamond comptroller (true) or IL comptroller (false).
    /// @dev    Used by _getCurrentCF to read from the correct comptroller ABI:
    ///         - BSC (Diamond): poolMarkets(corePoolId, market) — 7-value return
    ///         - Non-BSC (IL): markets(market) — 3-value return
    ///         EBrake functions (adjustCollateralFactor, setCFZero) handle both paths internally
    ///         via their own IS_ISOLATED_POOL flag — no routing needed here.
    bool public immutable IS_CORE_POOL;

    /// @notice Per-market configuration for automated risk parameter adjustments.
    mapping(address => MarketConfig) public marketConfigs;

    /// @notice Cooldown period in seconds for increase (loosening) operations.
    uint256 public cooldownPeriod;

    /// @notice Timestamp of the last LTV increase per market.
    mapping(address => uint256) public lastLTVIncreaseTime;

    /// @notice Timestamp of the last borrow cap increase per market.
    mapping(address => uint256) public lastBorrowCapIncreaseTime;

    /// @notice Timestamp of the last supply cap increase per market.
    mapping(address => uint256) public lastSupplyCapIncreaseTime;

    /// @notice Deploy Executor with the EBrake contract and comptroller type.
    /// @param eBrake_ The EBrake contract address.
    /// @param comptroller_ The comptroller that EBrake operates on.
    /// @param isCorePool_ True if targeting BSC Diamond comptroller, false for IL comptroller.
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(IEBrake eBrake_, ICorePoolComptroller comptroller_, bool isCorePool_) {
        if (address(eBrake_) == address(0)) revert ZeroAddress();
        if (address(comptroller_) == address(0)) revert ZeroAddress();

        EBRAKE = eBrake_;
        COMPTROLLER = comptroller_;
        IS_CORE_POOL = isCorePool_;

        _disableInitializers();
    }

    /// @notice Initialize the Executor with ACM and cooldown period.
    /// @param accessControlManager_ Address of the Venus Access Control Manager.
    /// @param cooldownPeriod_ Initial cooldown period in seconds (e.g. 1800 for 30 minutes).
    function initialize(address accessControlManager_, uint256 cooldownPeriod_) external initializer {
        if (cooldownPeriod_ == 0) revert ZeroValue();

        __AccessControlled_init(accessControlManager_);
        cooldownPeriod = cooldownPeriod_;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                     CONDITION HANDLERS
    // ═══════════════════════════════════════════════════════════════════════

    /// @inheritdoc IExecutor
    function handleLTVAdjust(address market, uint256 adjustedLTV) external {
        _checkAccessAllowed("handleLTVAdjust(address,uint256)");

        MarketConfig memory config = _getEnabledConfig(market);

        if (adjustedLTV > config.originalLTV) {
            revert AdjustedLTVExceedsOriginal(adjustedLTV, config.originalLTV);
        }

        uint256 currentCF = _getCurrentCF(market);

        if (adjustedLTV > currentCF) {
            // Increase relative to core pool CF — apply cooldown.
            // On BSC, e-mode pools have CF >= core pool CF, so if core pool CF is increasing,
            // at least one pool is being loosened. On non-BSC there is only one pool.
            _enforceCooldown(lastLTVIncreaseTime[market]);
            lastLTVIncreaseTime[market] = block.timestamp;
        } else if (adjustedLTV == currentCF && !IS_CORE_POOL) {
            // IL path: single pool, truly a no-op.
            return;
        }
        // Note: for IS_CORE_POOL, we do NOT early-exit when adjustedLTV == corePoolCF because
        // e-mode pools may have a higher CF that still needs to be brought down to adjustedLTV.

        EBRAKE.adjustCollateralFactor(market, adjustedLTV);
        emit LTVAdjusted(msg.sender, market, currentCF, adjustedLTV);
    }

    /// @inheritdoc IExecutor
    function handleCapAdjust(address market, IEBrake.CapType capType, uint256 adjustedCap) external {
        _checkAccessAllowed("handleCapAdjust(address,uint8,uint256)");

        MarketConfig memory config = _getEnabledConfig(market);

        IComptroller comptroller = IComptroller(address(COMPTROLLER));

        if (capType == IEBrake.CapType.BORROW) {
            if (adjustedCap < config.minBorrowCap) revert CapBelowMinimum(adjustedCap, config.minBorrowCap);
            if (adjustedCap > config.originalBorrowCap)
                revert CapExceedsOriginal(adjustedCap, config.originalBorrowCap);

            uint256 currentCap = comptroller.borrowCaps(market);
            if (adjustedCap == currentCap) return;

            if (adjustedCap > currentCap) {
                _enforceCooldown(lastBorrowCapIncreaseTime[market]);
                lastBorrowCapIncreaseTime[market] = block.timestamp;
            }

            EBRAKE.adjustCap(market, capType, adjustedCap);
            emit CapAdjusted(msg.sender, market, capType, currentCap, adjustedCap);
        } else {
            if (adjustedCap < config.minSupplyCap) revert CapBelowMinimum(adjustedCap, config.minSupplyCap);
            if (adjustedCap > config.originalSupplyCap)
                revert CapExceedsOriginal(adjustedCap, config.originalSupplyCap);

            uint256 currentCap = comptroller.supplyCaps(market);
            if (adjustedCap == currentCap) return;

            if (adjustedCap > currentCap) {
                _enforceCooldown(lastSupplyCapIncreaseTime[market]);
                lastSupplyCapIncreaseTime[market] = block.timestamp;
            }

            EBRAKE.adjustCap(market, capType, adjustedCap);
            emit CapAdjusted(msg.sender, market, capType, currentCap, adjustedCap);
        }
    }

    /// @inheritdoc IExecutor
    function handleSupplyHalt(address market) external {
        _checkAccessAllowed("handleSupplyHalt(address)");

        IComptroller comptroller = IComptroller(address(COMPTROLLER));
        uint256 supplyUnderlying = (IVToken(market).totalSupply() * IVToken(market).exchangeRateCurrent()) / 1e18;
        uint256 supplyCap = comptroller.supplyCaps(market);

        if (supplyUnderlying < supplyCap) revert CapNotBreached();

        EBRAKE.pauseSupply(market);
        EBRAKE.setCFZero(market);
        emit SupplyHalted(msg.sender, market);
    }

    /// @inheritdoc IExecutor
    function handleBorrowHalt(address market) external {
        _checkAccessAllowed("handleBorrowHalt(address)");

        IComptroller comptroller = IComptroller(address(COMPTROLLER));
        uint256 totalBorrows = IVToken(market).totalBorrows();
        uint256 borrowCap = comptroller.borrowCaps(market);

        if (totalBorrows < borrowCap) revert CapNotBreached();

        EBRAKE.pauseBorrow(market);

        emit BorrowHalted(msg.sender, market);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                     ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════

    /// @inheritdoc IExecutor
    function setMarketConfig(address market, MarketConfig calldata config) external {
        _checkAccessAllowed("setMarketConfig(address,(uint256,uint256,uint256,uint256,uint256,bool))");
        if (market == address(0)) revert ZeroAddress();
        if (config.originalLTV > 1e18) revert InvalidConfig();
        if (config.minBorrowCap > config.originalBorrowCap) revert InvalidConfig();
        if (config.minSupplyCap > config.originalSupplyCap) revert InvalidConfig();

        marketConfigs[market] = config;
        emit MarketConfigSet(market, config);
    }

    /// @inheritdoc IExecutor
    function setCooldownPeriod(uint256 newPeriod) external {
        _checkAccessAllowed("setCooldownPeriod(uint256)");
        if (newPeriod == 0) revert ZeroValue();
        if (newPeriod == cooldownPeriod) revert NoChange();

        emit CooldownPeriodUpdated(cooldownPeriod, newPeriod);
        cooldownPeriod = newPeriod;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                     INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Load and validate market configuration. Reverts if not configured or disabled.
     * @param market The vToken market address.
     * @return config The validated market configuration.
     */
    function _getEnabledConfig(address market) internal view returns (MarketConfig memory config) {
        config = marketConfigs[market];
        if (config.originalLTV == 0) revert MarketNotConfigured(market);
        if (!config.enabled) revert MarketDisabled(market);
    }

    /**
     * @notice Read current collateral factor for a market from the comptroller.
     * @dev    On BSC, reads from corePoolId. On non-BSC, reads from IL markets().
     * @param market The vToken market address.
     * @return currentCF The current collateral factor mantissa.
     */
    function _getCurrentCF(address market) internal view returns (uint256 currentCF) {
        if (IS_CORE_POOL) {
            (, currentCF, , , , , ) = COMPTROLLER.poolMarkets(0, market);
        } else {
            IILComptroller.Market memory m = IILComptroller(address(COMPTROLLER)).markets(market);
            currentCF = m.collateralFactorMantissa;
        }
    }

    /**
     * @notice Enforce cooldown period for increase (loosening) operations.
     * @dev    Reverts with CooldownNotExpired if the cooldown has not elapsed since the last increase.
     * @param lastIncreaseTime The timestamp of the last increase for this market/parameter.
     */
    function _enforceCooldown(uint256 lastIncreaseTime) internal view {
        if (lastIncreaseTime != 0) {
            uint256 cooldownEnd = lastIncreaseTime + cooldownPeriod;
            if (block.timestamp < cooldownEnd) {
                revert CooldownNotExpired(cooldownEnd - block.timestamp);
            }
        }
    }
}
