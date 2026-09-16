// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.25;

import { IVToken } from "../Interfaces/IVToken.sol";
import { IEBrake } from "../EmergencyBrake/IEBrake.sol";
import { IHub, IYieldGroupNav } from "../Interfaces/IHubLiquidity.sol";
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
 *         large deviations are detected. All emergency actions are routed through the EBrake contract.
 * @dev This contract can only TIGHTEN restrictions (pause, zero CF), never loosen them.
 *      Recovery (unpausing, restoring CF) is handled via governance VIP.
 *      CF tightening is performed by calling EBrake.decreaseCF(market, 0) — the most aggressive
 *      sentinel response — which zeros the collateral factor.
 *      Idempotency is handled by EBrake — duplicate calls are no-ops.
 */
contract DeviationSentinel is AccessControlledV8 {
    /// @notice Configuration for price deviation monitoring
    /// @param deviation Maximum allowed deviation percentage (e.g., 10 = 10%)
    /// @param enabled Whether deviation monitoring is enabled for this token
    struct DeviationConfig {
        uint8 deviation;
        bool enabled;
    }

    /// @notice Configuration for NAV deviation monitoring on one Liquidity Hub resource
    /// @dev Thresholds are measured outward from the resource's NavGuard band bounds, not from the
    ///      band centre. That makes the trigger always, by construction, wider than the band's own
    ///      `downGapBps`/`upGapBps`, so the two numbers cannot be configured into contradiction.
    ///      Neither may be zero: a zero would pause the moment that side clamps at all — the most
    ///      aggressive setting there is, and the opposite of what a zero usually means to whoever
    ///      writes it. A non-zero `pauseDownBps` doubles as the "configured" marker.
    /// @param pauseUpBps How far above the band's cap the observed value must sit to trip, in bps
    /// @param pauseDownBps How far below the band's floor the observed value must sit to trip, in bps
    /// @param enabled Whether NAV monitoring is enabled for this resource
    struct NavDeviationConfig {
        uint16 pauseUpBps;
        uint16 pauseDownBps;
        bool enabled;
    }

    /// @notice Action taken by the sentinel when handling a deviation
    /// @param BorrowPaused Borrow was paused (sentinel price > oracle price)
    /// @param SupplyPausedAndCFZeroed CF was zeroed and supply was paused (sentinel price <= oracle price)
    enum DeviationAction {
        BorrowPaused,
        SupplyPausedAndCFZeroed
    }

    /// @notice Maximum allowed price deviation in percentage (e.g., 10 = 10%)
    uint8 public constant MAX_DEVIATION = 100;

    /// @notice Basis-point denominator, and the ceiling on either NAV pause threshold
    uint16 public constant MAX_DEVIATION_BPS = 10_000;

    /// @notice Emergency Brake contract for executing pause and CF-zero actions
    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    IEBrake public immutable EBRAKE;

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

    /// @notice Mapping of Liquidity Hub resource addresses to their NAV deviation configuration
    /// @dev Appended after the pre-existing slots and paid for out of `__gap`, so the layout of
    ///      everything above is unchanged on the live proxies.
    mapping(address => NavDeviationConfig) public navConfigs;

    /// @dev Storage gap for future upgrades. Was 48 before `navConfigs` was appended.
    uint256[47] private __gap;

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

    /// @notice Emitted when a price deviation is detected and handled for a market
    /// @param market The market address
    /// @param oraclePrice The price from the resilient oracle at the time of detection
    /// @param sentinelPrice The price from the sentinel oracle at the time of detection
    /// @param action The action taken in response to the deviation
    event DeviationHandled(address indexed market, uint256 oraclePrice, uint256 sentinelPrice, DeviationAction action);

    /// @notice Emitted when a resource's NAV deviation configuration is updated
    /// @param resource The Liquidity Hub resource address
    /// @param config The new NAV deviation configuration
    event NavConfigUpdated(address indexed resource, NavDeviationConfig config);

    /// @notice Emitted when a resource's NAV monitoring status is changed
    /// @param resource The Liquidity Hub resource address
    /// @param enabled Whether NAV monitoring is enabled
    event NavMonitoringStatusChanged(address indexed resource, bool enabled);

    /// @notice Emitted when a NAV deviation is detected and the Hub and resource are both paused
    /// @dev Which side broke is derivable from the three values: below `minAllowedValue` is a
    ///      downside breach, above `maxAllowedValue` an upside one.
    /// @param hub The Liquidity Hub that was paused
    /// @param yieldGroup The YieldGroup holding the breaching resource
    /// @param resource The resource whose NAV broke through its band
    /// @param observedValue Value the counterparty reported at detection time
    /// @param minAllowedValue The band's floor at detection time
    /// @param maxAllowedValue The band's cap at detection time
    event NavDeviationHandled(
        address indexed hub,
        address indexed yieldGroup,
        address indexed resource,
        uint256 observedValue,
        uint256 minAllowedValue,
        uint256 maxAllowedValue
    );

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

    /// @notice Thrown when a resource has no NAV deviation thresholds set
    error ResourceNotConfigured(address resource);

    /// @notice Thrown when NAV monitoring is disabled for a resource
    error NavMonitoringDisabled(address resource);

    /// @notice Thrown when the Hub does not list the supplied YieldGroup in its registry
    /// @dev The check that stops a fabricated YieldGroup — one reporting an invented clamp —
    ///      from being paired with the real Hub address to pause the live Hub.
    error YieldGroupNotRegistered(address hub, address yieldGroup);

    /// @notice Thrown when the resource's NavGuard band is not currently clamping
    /// @dev Also the guard against an unreadable value source: `navGuardStatus` reports a
    ///      reverting adapter as `observedValue == 0`, and passes that through unclamped, so
    ///      `isClamped` is false on such a read and the brake does not fire on a transient failure.
    error NavNotClamped(address resource);

    /// @notice Thrown when the clamp is real but smaller than the configured pause threshold
    /// @dev The deliberate quiet band: NAV is clamped, but the move is small enough to let the
    ///      NavGuard band step down on its own without freezing the Hub.
    error DeviationWithinThreshold(address resource, uint256 observedValue);

    modifier onlyKeeper() {
        if (!trustedKeepers[msg.sender]) revert UnauthorizedKeeper();
        _;
    }

    /// @notice Constructor for DeviationSentinel
    /// @param eBrake_ Address of the EBrake contract
    /// @param resilientOracle_ Address of the resilient oracle
    /// @param sentinelOracle_ Address of the sentinel oracle
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(IEBrake eBrake_, ResilientOracleInterface resilientOracle_, OracleInterface sentinelOracle_) {
        if (address(eBrake_) == address(0)) revert ZeroAddress();
        if (address(resilientOracle_) == address(0)) revert ZeroAddress();
        if (address(sentinelOracle_) == address(0)) revert ZeroAddress();

        EBRAKE = eBrake_;
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

    /// @notice Handle price deviation for a market by pausing borrow or zeroing CF and pausing supply
    /// @dev This contract can only tighten restrictions. Recovery (unpausing, restoring CF) is via governance VIP.
    /// @param market The vToken market to handle
    /// @custom:event Emits DeviationHandled with price context and the action taken
    /// @custom:error UnauthorizedKeeper is thrown when caller is not a trusted keeper
    /// @custom:error MarketNotConfigured is thrown when market's underlying token has no deviation config
    /// @custom:error TokenMonitoringDisabled is thrown when monitoring is disabled for the token
    function handleDeviation(IVToken market) external onlyKeeper {
        address underlyingToken = market.underlying();
        DeviationConfig memory config = tokenConfigs[underlyingToken];

        if (config.deviation == 0) revert MarketNotConfigured();
        if (!config.enabled) revert TokenMonitoringDisabled();

        (bool hasDeviation, uint256 oraclePrice, uint256 sentinelPrice, ) = checkPriceDeviation(market);

        if (!hasDeviation) return;

        DeviationAction action;
        if (sentinelPrice > oraclePrice) {
            EBRAKE.pauseBorrow(address(market));
            action = DeviationAction.BorrowPaused;
        } else {
            EBRAKE.decreaseCF(address(market), 0);
            EBRAKE.pauseSupply(address(market));
            action = DeviationAction.SupplyPausedAndCFZeroed;
        }
        emit DeviationHandled(address(market), oraclePrice, sentinelPrice, action);
    }

    /// @notice Set the NAV deviation thresholds for a Liquidity Hub resource
    /// @param resource Address of the resource inside its YieldGroup
    /// @param config Thresholds and enabled flag
    /// @custom:event Emits NavConfigUpdated event
    /// @custom:error ZeroAddress is thrown when resource address is zero
    /// @custom:error ZeroDeviation is thrown when either threshold is zero
    /// @custom:error ExceedsMaxDeviation is thrown when either threshold exceeds MAX_DEVIATION_BPS
    function setNavConfig(address resource, NavDeviationConfig calldata config) external {
        _checkAccessAllowed("setNavConfig(address,(uint16,uint16,bool))");

        if (resource == address(0)) revert ZeroAddress();
        if (config.pauseUpBps == 0 || config.pauseDownBps == 0) revert ZeroDeviation();
        if (config.pauseUpBps > MAX_DEVIATION_BPS || config.pauseDownBps > MAX_DEVIATION_BPS) {
            revert ExceedsMaxDeviation();
        }

        navConfigs[resource] = config;
        emit NavConfigUpdated(resource, config);
    }

    /// @notice Enable or disable NAV monitoring for a resource, keeping its thresholds
    /// @param resource Address of the resource
    /// @param enabled Whether to enable or disable NAV monitoring
    /// @custom:event Emits NavMonitoringStatusChanged event
    /// @custom:error ZeroAddress is thrown when resource address is zero
    /// @custom:error ResourceNotConfigured is thrown when resource has no NAV config
    function setNavMonitoringEnabled(address resource, bool enabled) external {
        _checkAccessAllowed("setNavMonitoringEnabled(address,bool)");

        if (resource == address(0)) revert ZeroAddress();

        NavDeviationConfig storage config = navConfigs[resource];
        // Without this, enabling a never-configured resource would arm it at 0/0 — exactly the
        // hair-trigger setting setNavConfig refuses.
        if (config.pauseDownBps == 0) revert ResourceNotConfigured(resource);

        config.enabled = enabled;
        emit NavMonitoringStatusChanged(resource, enabled);
    }

    /// @notice Handle a NAV deviation on a Liquidity Hub resource by pausing the Hub and the resource
    /// @dev Keeper-gated like every other trigger here, but the keeper asserts nothing: the breach is
    ///      re-derived from Hub and YieldGroup state, so a leaked key can only pause when a real
    ///      breach already exists.
    ///
    ///      Reverts rather than returning quietly when no action is due, so monitoring can simulate
    ///      with `eth_call` and broadcast only when the transaction will do something.
    ///
    ///      Both pauses happen, not just one. Pausing the resource alone would make things worse: a
    ///      paused resource stays counted in `totalAssets()` but becomes unreachable for
    ///      withdrawals, so the share price stays propped up while redemptions are served entirely
    ///      from the healthy positions — leaving remaining holders a larger share of the bad one.
    ///      The Hub pause is what stops the harm; the resource pause is pre-staging, so governance's
    ///      later `unpauseHub` cannot route back into the impaired position before someone has
    ///      decided what it is worth. Both are idempotent at the Hub, so a repeat call changes
    ///      nothing.
    ///
    ///      Recovery is a governance VIP, and the order matters: decide the real value,
    ///      `setNavGuardSnapshot` to it, then `unpauseHub`. Unpausing without re-anchoring just
    ///      resumes the same slow step-down.
    /// @param hub The Liquidity Hub to pause. Needs no validation of its own — EBrake's `pauseHub`
    ///        runs an ACM check on the Hub, so an address we hold no role on is a no-op.
    /// @param yieldGroup The YieldGroup holding the resource. Checked against the Hub's registry.
    /// @param resource The resource whose NavGuard band to read
    /// @custom:event Emits NavDeviationHandled with the band context at detection time
    /// @custom:error UnauthorizedKeeper is thrown when caller is not a trusted keeper
    /// @custom:error NavMonitoringDisabled is thrown when the resource is not enabled
    /// @custom:error YieldGroupNotRegistered is thrown when the Hub does not list the YieldGroup
    /// @custom:error NavNotClamped is thrown when the band is not currently clamping
    /// @custom:error DeviationWithinThreshold is thrown when the clamp is below the pause threshold
    function handleNavDeviation(address hub, address yieldGroup, address resource) external onlyKeeper {
        NavDeviationConfig memory config = navConfigs[resource];
        if (!config.enabled) revert NavMonitoringDisabled(resource);

        if (!IHub(hub).yieldGroupConfig(yieldGroup).registered) revert YieldGroupNotRegistered(hub, yieldGroup);

        (uint256 observedValue, uint256 minAllowedValue, uint256 maxAllowedValue, bool isClamped, ) = IYieldGroupNav(
            yieldGroup
        ).navGuardStatus(resource);

        // Gate on isClamped before comparing magnitude. An unreadable adapter reports
        // observedValue == 0, which a bare `observedValue < minAllowedValue` would read as a total
        // loss and act on.
        if (!isClamped) revert NavNotClamped(resource);

        bool breached = observedValue <
            (minAllowedValue * (MAX_DEVIATION_BPS - config.pauseDownBps)) / MAX_DEVIATION_BPS ||
            observedValue > (maxAllowedValue * (MAX_DEVIATION_BPS + config.pauseUpBps)) / MAX_DEVIATION_BPS;
        if (!breached) revert DeviationWithinThreshold(resource, observedValue);

        EBRAKE.pauseHub(hub);
        EBRAKE.pauseResource(yieldGroup, resource);

        emit NavDeviationHandled(hub, yieldGroup, resource, observedValue, minAllowedValue, maxAllowedValue);
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

        if (config.deviation == 0 || !config.enabled) return (false, 0, 0, 0);

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
}
