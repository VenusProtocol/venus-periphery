// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.25;

import { ICorePoolComptroller } from "../Interfaces/ICorePoolComptroller.sol";
import { IComptroller } from "../Interfaces/IComptroller.sol";
import { IILComptroller } from "../Interfaces/IILComptroller.sol";
import { IVToken } from "../Interfaces/IVToken.sol";
import { IEBrake } from "../EmergencyBrake/IEBrake.sol";
import { IExecutor } from "./IExecutor.sol";
import { AccessControlledV8 } from "@venusprotocol/governance-contracts/contracts/Governance/AccessControlledV8.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";

/**
 * @title Executor — Signal-Driven Condition Handler for E-brake V2
 * @author Venus Protocol
 * @notice Validates signal-driven conditions on-chain, enforces bounds, and routes
 *         validated tightening actions to EBrake for execution.
 *
 * @dev    Example Flow: Hypernative (off-chain signal S1-S8) → Executor (validate) → EBrake (execute) → Comptroller
 *
 *         The Executor is the validation layer. It ensures:
 *         - LTV adjustments are tighten-only (decrease only), enforced by EBrake
 *         - Cap adjustments stay within [minCap, currentCap] and are tighten-only, enforced by EBrake
 *         - Supply and borrow cap-exceeding halts fire when caps are breached on-chain,
 *           OR when the cap is 0 (treated as misconfiguration rather than "unlimited")
 *
 *         The Executor does NOT hold detection logic — that lives off-chain in the signal pipeline.
 *         The Executor does NOT call the comptroller directly — all mutations go through EBrake.
 *         Recovery from any tightening action always requires a governance VIP.
 */
contract Executor is IExecutor, AccessControlledV8, ReentrancyGuardUpgradeable {
    /// @notice The EBrake contract that executes emergency actions on the comptroller.
    IEBrake public immutable EBRAKE;

    /// @notice The comptroller that EBrake operates on.
    ICorePoolComptroller public immutable COMPTROLLER;

    /// @notice Whether this Executor targets a BSC Diamond comptroller (true) or IL comptroller (false).
    /// @dev    EBrake handles both paths internally via its own IS_ISOLATED_POOL flag.
    bool public immutable IS_CORE_POOL;

    /// @notice Per-market configuration for automated risk parameter adjustments.
    mapping(address => MarketConfig) public marketConfigs;

    /// @dev Tracks whether a market has ever been registered via setMarketConfig.
    ///      Separate from MarketConfig.enabled so we can distinguish "never set" from "set but disabled".
    mapping(address => bool) private _isConfigured;

    /// @dev Storage gap for future upgrades.
    uint256[48] private __gap;

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

    /// @notice Initialize the Executor with ACM.
    /// @param accessControlManager_ Address of the Venus Access Control Manager.
    function initialize(address accessControlManager_) external initializer {
        __AccessControlled_init(accessControlManager_);
        __ReentrancyGuard_init();
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                     CONDITION HANDLERS
    // ═══════════════════════════════════════════════════════════════════════

    /// @inheritdoc IExecutor
    function handleLTVAdjust(address market, uint256 adjustedLTV) external nonReentrant {
        _checkAccessAllowed("handleLTVAdjust(address,uint256)");

        _checkAndGetConfig(market);

        // EBrake.decreaseCF iterates all pools (including e-mode) and no-ops per-pool
        // when already at or below adjustedLTV — idempotency is guaranteed on EBrake's side.
        EBRAKE.decreaseCF(market, adjustedLTV);
        emit LTVAdjusted(msg.sender, market, adjustedLTV);
    }

    /// @inheritdoc IExecutor
    function handleCapAdjust(address market, IExecutor.CapType capType, uint256 adjustedCap) external nonReentrant {
        _checkAccessAllowed("handleCapAdjust(address,uint8,uint256)");

        MarketConfig storage config = _checkAndGetConfig(market);

        IComptroller comptroller = IComptroller(address(COMPTROLLER));

        address[] memory markets = new address[](1);
        markets[0] = market;
        uint256[] memory caps = new uint256[](1);
        caps[0] = adjustedCap;

        if (capType == IExecutor.CapType.BORROW) {
            if (adjustedCap < config.minBorrowCap) revert CapBelowMinimum(adjustedCap, config.minBorrowCap);

            uint256 currentCap = comptroller.borrowCaps(market);
            if (adjustedCap == currentCap) return;

            EBRAKE.setMarketBorrowCaps(markets, caps);
            emit CapAdjusted(msg.sender, market, capType, currentCap, adjustedCap);
        } else {
            if (adjustedCap < config.minSupplyCap) revert CapBelowMinimum(adjustedCap, config.minSupplyCap);

            uint256 currentCap = comptroller.supplyCaps(market);
            if (adjustedCap == currentCap) return;

            EBRAKE.setMarketSupplyCaps(markets, caps);
            emit CapAdjusted(msg.sender, market, capType, currentCap, adjustedCap);
        }
    }

    /// @inheritdoc IExecutor
    function handleSupplyCapExceeding(address market) external nonReentrant {
        _checkAccessAllowed("handleSupplyCapExceeding(address)");

        _checkAndGetConfig(market);

        IComptroller comptroller = IComptroller(address(COMPTROLLER));
        uint256 supplyCap = comptroller.supplyCaps(market);

        // supplyCap == 0 is treated as a misconfiguration (no Venus market is intentionally
        // uncapped in production); halt is permitted so the market can always be frozen.
        // Accidental halt of a genuinely-uncapped market is recoverable via governance VIP,
        // whereas leaving a draining market un-haltable is not.
        if (supplyCap != 0) {
            // The rate can only reject a halt, never gate one: if accrual reverts, fail closed.
            try IVToken(market).exchangeRateCurrent() returns (uint256 exchangeRate) {
                uint256 supplyUnderlying = (IVToken(market).totalSupply() * exchangeRate) / 1e18;
                if (supplyUnderlying < supplyCap) revert CapNotBreached();
            } catch {
                emit HaltedWithoutCapCheck(msg.sender, market);
            }
        }

        EBRAKE.pauseSupply(market);
        EBRAKE.decreaseCF(market, 0);
        emit SupplyCapExceeding(msg.sender, market);
    }

    /// @inheritdoc IExecutor
    function handleBorrowCapExceeding(address market) external nonReentrant {
        _checkAccessAllowed("handleBorrowCapExceeding(address)");

        _checkAndGetConfig(market);

        IComptroller comptroller = IComptroller(address(COMPTROLLER));
        uint256 borrowCap = comptroller.borrowCaps(market);

        // borrowCap == 0 means misconfiguration
        if (borrowCap != 0) {
            // The borrow total can only reject a halt, never gate one: if accrual reverts, fail closed.
            try IVToken(market).totalBorrowsCurrent() returns (uint256 totalBorrows) {
                if (totalBorrows < borrowCap) revert CapNotBreached();
            } catch {
                emit HaltedWithoutCapCheck(msg.sender, market);
            }
        }

        EBRAKE.pauseBorrow(market);

        emit BorrowCapExceeding(msg.sender, market);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                     ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════

    /// @inheritdoc IExecutor
    function setMarketConfig(address market, MarketConfig calldata config) external {
        _checkAccessAllowed("setMarketConfig(address,(uint256,uint256,bool))");
        if (market == address(0)) revert ZeroAddress();

        if (IS_CORE_POOL) {
            (bool isListed, , , , , , ) = COMPTROLLER.poolMarkets(COMPTROLLER.corePoolId(), market);
            if (!isListed) revert MarketNotListed(market);
        } else {
            IILComptroller.Market memory m = IILComptroller(address(COMPTROLLER)).markets(market);
            if (!m.isListed) revert MarketNotListed(market);
        }

        _isConfigured[market] = true;
        marketConfigs[market] = config;
        emit MarketConfigSet(market, config);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                     INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Load and validate market configuration. Reverts if not configured or disabled.
     * @param market The vToken market address.
     * @return config Storage pointer to the validated market configuration.
     */
    function _checkAndGetConfig(address market) internal view returns (MarketConfig storage config) {
        if (!_isConfigured[market]) revert MarketNotConfigured(market);
        config = marketConfigs[market];
        if (!config.enabled) revert MarketDisabled(market);
    }
}
