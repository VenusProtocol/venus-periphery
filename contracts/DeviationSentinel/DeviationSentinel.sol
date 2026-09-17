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

    /// @notice Pause thresholds for one Liquidity Hub resource's NavGuard band
    /// @dev Measured outward from the band's bounds, so the trigger is always wider than the band's
    ///      own gaps. A zero on either side means the resource was never configured.
    /// @param pauseUpBps How far above the band's cap the observed value must sit to trip, in bps
    /// @param pauseDownBps How far below the band's floor the observed value must sit to trip, in bps
    /// @param enabled Whether this resource's band is being watched. Only `setNavGuardEnabled` writes it.
    struct NavGuardConfig {
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

    /// @notice Why a NavGuard check did or did not call for a pause
    /// @dev Internal only — the view narrows it to a bool, the handler turns each non-breach into
    ///      its own error. Ordered so the zero value is a no-action one.
    /// @param MonitoringDisabled The resource is not armed in `navGuardConfigs`
    /// @param YieldGroupNotRegistered The Hub does not list the supplied YieldGroup
    /// @param ResourceNotRegistered The YieldGroup does not list the supplied resource
    /// @param NotClamped Nothing measurable: the band is not clamping, or it was never anchored
    /// @param WithinThreshold Clamped, but by less than the configured threshold
    /// @param Breached Clamped past the threshold — a pause is due
    enum NavGuardCheckStatus {
        MonitoringDisabled,
        YieldGroupNotRegistered,
        ResourceNotRegistered,
        NotClamped,
        WithinThreshold,
        Breached
    }

    /// @notice Maximum allowed price deviation in percentage (e.g., 10 = 10%)
    uint8 public constant MAX_DEVIATION = 100;

    /// @notice Basis-point denominator, and the ceiling on either NavGuard pause threshold
    /// @dev `pauseDownBps` must stay strictly below it — at 10_000 the floor is zero and unreachable.
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

    /// @notice NavGuard pause thresholds, keyed by YieldGroup then resource
    /// @dev Keyed on the pair: one resource address can appear under two YieldGroups.
    mapping(address => mapping(address => NavGuardConfig)) public navGuardConfigs;

    /// @dev Storage gap for future upgrades. Was 48 before `navGuardConfigs` was appended.
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

    /// @notice Emitted when a resource's NavGuard pause thresholds are updated
    /// @param yieldGroup The YieldGroup holding the resource
    /// @param resource The Liquidity Hub resource address
    /// @param config The stored config after the update
    event NavGuardConfigUpdated(address indexed yieldGroup, address indexed resource, NavGuardConfig config);

    /// @notice Emitted when a resource's band starts or stops being watched
    /// @param yieldGroup The YieldGroup holding the resource
    /// @param resource The Liquidity Hub resource address
    /// @param enabled Whether the band is being watched
    event NavGuardStatusChanged(address indexed yieldGroup, address indexed resource, bool enabled);

    /// @notice Emitted when a resource breaks through its NavGuard band and both it and the Hub are paused
    /// @dev Below `minAllowedValue` is a downside breach, above `maxAllowedValue` an upside one.
    /// @param hub The Liquidity Hub that was paused
    /// @param yieldGroup The YieldGroup holding the breaching resource
    /// @param resource The resource whose value broke through its band
    /// @param observedValue Value the counterparty reported at detection time
    /// @param minAllowedValue The band's floor at detection time
    /// @param maxAllowedValue The band's cap at detection time
    event NavGuardDeviationHandled(
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

    /// @notice Thrown when a resource has no NavGuard pause thresholds set
    error ResourceNotConfigured(address yieldGroup, address resource);

    /// @notice Thrown when a resource's NavGuard band is not being watched
    error NavGuardDisabled(address yieldGroup, address resource);

    /// @notice Thrown when the Hub does not list the supplied YieldGroup in its registry
    /// @dev Catches a stale YieldGroup, not a hostile one: `hub` is caller-supplied too.
    error YieldGroupNotRegistered(address hub, address yieldGroup);

    /// @notice Thrown when the YieldGroup does not list the supplied resource in its registry
    /// @dev Unregistered means zero balance, so it is outside `totalAssets()` and nothing to pause.
    error ResourceNotRegistered(address yieldGroup, address resource);

    /// @notice Thrown when the resource's NavGuard band holds nothing measurable
    /// @dev Not clamping, an unreadable source, or a never-anchored `[0, 0]` band.
    error NavGuardNotClamped(address resource);

    /// @notice Thrown when the clamp is real but smaller than the configured pause threshold
    /// @dev Small enough to let the band step down on its own.
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

    /// @notice Set the NavGuard pause thresholds for a Liquidity Hub resource
    /// @dev Thresholds only. `enabled` is owned by `setNavGuardEnabled`, so retuning a threshold
    ///      cannot silently disarm a resource, nor this role alone arm one.
    /// @param yieldGroup Address of the YieldGroup holding the resource
    /// @param resource Address of the resource inside that YieldGroup
    /// @param pauseUpBps How far above the band's cap the observed value must sit to trip, in bps
    /// @param pauseDownBps How far below the band's floor the observed value must sit to trip, in bps
    /// @custom:event Emits NavGuardConfigUpdated event
    /// @custom:error ZeroAddress is thrown when the YieldGroup or resource address is zero
    /// @custom:error ZeroDeviation is thrown when either threshold is zero
    /// @custom:error ExceedsMaxDeviation is thrown when a threshold is out of range
    function setNavGuardConfig(address yieldGroup, address resource, uint16 pauseUpBps, uint16 pauseDownBps) external {
        _checkAccessAllowed("setNavGuardConfig(address,address,uint16,uint16)");

        if (yieldGroup == address(0) || resource == address(0)) revert ZeroAddress();
        if (pauseUpBps == 0 || pauseDownBps == 0) revert ZeroDeviation();
        if (pauseUpBps > MAX_DEVIATION_BPS || pauseDownBps >= MAX_DEVIATION_BPS) revert ExceedsMaxDeviation();

        NavGuardConfig storage config = navGuardConfigs[yieldGroup][resource];
        config.pauseUpBps = pauseUpBps;
        config.pauseDownBps = pauseDownBps;

        emit NavGuardConfigUpdated(yieldGroup, resource, config);
    }

    /// @notice Start or stop watching a resource's NavGuard band, keeping its thresholds
    /// @param yieldGroup Address of the YieldGroup holding the resource
    /// @param resource Address of the resource
    /// @param enabled Whether to watch this resource's band
    /// @custom:event Emits NavGuardStatusChanged event
    /// @custom:error ZeroAddress is thrown when the YieldGroup or resource address is zero
    /// @custom:error ResourceNotConfigured is thrown when resource has no thresholds set
    function setNavGuardEnabled(address yieldGroup, address resource, bool enabled) external {
        _checkAccessAllowed("setNavGuardEnabled(address,address,bool)");

        if (yieldGroup == address(0) || resource == address(0)) revert ZeroAddress();

        NavGuardConfig storage config = navGuardConfigs[yieldGroup][resource];
        if (config.pauseUpBps == 0 || config.pauseDownBps == 0) revert ResourceNotConfigured(yieldGroup, resource);

        config.enabled = enabled;
        emit NavGuardStatusChanged(yieldGroup, resource, enabled);
    }

    /// @notice Handle a NavGuard band breach on a Liquidity Hub resource by pausing the Hub and the resource
    /// @dev Keeper-gated, and reverts when no action is due. Shares `_checkNavGuardDeviation` with
    ///      the public view, so the two cannot disagree.
    ///
    ///      Both pauses fire or neither does. Pausing only the resource is worse: it still counts
    ///      toward `totalAssets()` but can no longer be withdrawn from, so redemptions drain the
    ///      healthy positions. The registered check upstream removes the only thing the YieldGroup
    ///      rejects `pauseResource` for, so the pair is safe unguarded.
    ///
    ///      Re-deriving the breach guards against a stale keeper input, not a hostile one — the
    ///      keeper also names the contracts the verdict comes from. A fabricated `hub`/`yieldGroup`
    ///      pair reaches spoofed events and a no-arg `pauseHub()` to that address; it cannot touch
    ///      a real Hub, and EBrake holds no funds. Accepted while the keeper is a protocol EOA.
    ///
    ///      Recovery is a VIP: value the position, `setNavGuardSnapshot` to it, `unpauseResource`,
    ///      then `unpauseHub`. Unpausing without re-anchoring resumes the same step-down.
    /// @param hub The Liquidity Hub to pause. Not validated — a hub EBrake holds no role on reverts.
    /// @param yieldGroup The YieldGroup holding the resource. Checked against that Hub's registry.
    /// @param resource The resource whose NavGuard band to read
    /// @custom:event Emits NavGuardDeviationHandled with the band context at detection time
    /// @custom:error UnauthorizedKeeper is thrown when caller is not a trusted keeper
    /// @custom:error NavGuardDisabled is thrown when the resource's band is not being watched
    /// @custom:error YieldGroupNotRegistered is thrown when the Hub does not list the YieldGroup
    /// @custom:error ResourceNotRegistered is thrown when the YieldGroup does not list the resource
    /// @custom:error NavGuardNotClamped is thrown when the band holds nothing measurable
    /// @custom:error DeviationWithinThreshold is thrown when the clamp is below the pause threshold
    function handleNavGuardDeviation(address hub, address yieldGroup, address resource) external onlyKeeper {
        (
            NavGuardCheckStatus status,
            uint256 observedValue,
            uint256 minAllowedValue,
            uint256 maxAllowedValue
        ) = _checkNavGuardDeviation(hub, yieldGroup, resource);

        if (status == NavGuardCheckStatus.MonitoringDisabled) revert NavGuardDisabled(yieldGroup, resource);
        if (status == NavGuardCheckStatus.YieldGroupNotRegistered) revert YieldGroupNotRegistered(hub, yieldGroup);
        if (status == NavGuardCheckStatus.ResourceNotRegistered) revert ResourceNotRegistered(yieldGroup, resource);
        if (status == NavGuardCheckStatus.NotClamped) revert NavGuardNotClamped(resource);
        if (status == NavGuardCheckStatus.WithinThreshold) revert DeviationWithinThreshold(resource, observedValue);

        EBRAKE.pauseHub(hub);
        EBRAKE.pauseResource(yieldGroup, resource);

        emit NavGuardDeviationHandled(hub, yieldGroup, resource, observedValue, minAllowedValue, maxAllowedValue);
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

    /// @notice Check whether a Liquidity Hub resource's NAV has broken through its NavGuard band by
    ///         more than the configured threshold
    /// @dev The read-only twin of `handleNavGuardDeviation`. `hasDeviation` is false for every
    ///      reason not to pause; simulate the handler to tell those apart, it names each one.
    ///
    ///      Not revert-proof: `hub` and `yieldGroup` are caller-supplied, so a non-contract address
    ///      or a revert inside either propagates. Monitoring should tolerate a failed call.
    /// @param hub The Liquidity Hub holding the YieldGroup
    /// @param yieldGroup The YieldGroup holding the resource
    /// @param resource The resource whose NavGuard band to read
    /// @return hasDeviation True when a pause is due
    /// @return observedValue Value the counterparty reports, in asset units; `0` when the band was not read
    /// @return minAllowedValue The band's floor; `0` when the band was not read
    /// @return maxAllowedValue The band's cap; `0` when the band was not read
    function checkNavGuardDeviation(
        address hub,
        address yieldGroup,
        address resource
    )
        external
        view
        returns (bool hasDeviation, uint256 observedValue, uint256 minAllowedValue, uint256 maxAllowedValue)
    {
        NavGuardCheckStatus status;
        (status, observedValue, minAllowedValue, maxAllowedValue) = _checkNavGuardDeviation(hub, yieldGroup, resource);
        hasDeviation = status == NavGuardCheckStatus.Breached;
    }

    /// @notice Decide whether a resource's NAV warrants a pause, and why
    /// @dev The one implementation: the view narrows it to a bool, the handler turns it into an
    ///      error. Neither repeats the work, so they cannot disagree.
    /// @param hub The Liquidity Hub holding the YieldGroup
    /// @param yieldGroup The YieldGroup holding the resource
    /// @param resource The resource whose NavGuard band to read
    /// @return status Why a pause is or is not due
    /// @return observedValue Value the counterparty reports; `0` when the band was not read
    /// @return minAllowedValue The band's floor; `0` when the band was not read
    /// @return maxAllowedValue The band's cap; `0` when the band was not read
    function _checkNavGuardDeviation(
        address hub,
        address yieldGroup,
        address resource
    )
        private
        view
        returns (NavGuardCheckStatus status, uint256 observedValue, uint256 minAllowedValue, uint256 maxAllowedValue)
    {
        NavGuardConfig memory config = navGuardConfigs[yieldGroup][resource];
        if (!config.enabled) return (NavGuardCheckStatus.MonitoringDisabled, 0, 0, 0);

        if (!IHub(hub).yieldGroupConfig(yieldGroup).registered) {
            return (NavGuardCheckStatus.YieldGroupNotRegistered, 0, 0, 0);
        }

        // Unregistered means zero balance, so it is outside totalAssets() and cannot harm the Hub.
        // Also the only thing the YieldGroup rejects pauseResource for.
        (bool registered, , ) = IYieldGroupNav(yieldGroup).resourceConfig(resource);
        if (!registered) return (NavGuardCheckStatus.ResourceNotRegistered, 0, 0, 0);

        bool isClamped;
        (observedValue, minAllowedValue, maxAllowedValue, isClamped, ) = IYieldGroupNav(yieldGroup).navGuardStatus(
            resource
        );

        // Both guards exist to stop a zero reading as a breach: an unreadable adapter reports
        // observedValue == 0, and a never-anchored [0, 0] band gives a zero upside threshold.
        if (!isClamped || maxAllowedValue == 0) {
            return (NavGuardCheckStatus.NotClamped, observedValue, minAllowedValue, maxAllowedValue);
        }

        bool breached = observedValue <
            (minAllowedValue * (MAX_DEVIATION_BPS - config.pauseDownBps)) / MAX_DEVIATION_BPS ||
            observedValue > (maxAllowedValue * (MAX_DEVIATION_BPS + config.pauseUpBps)) / MAX_DEVIATION_BPS;

        status = breached ? NavGuardCheckStatus.Breached : NavGuardCheckStatus.WithinThreshold;
    }
}
