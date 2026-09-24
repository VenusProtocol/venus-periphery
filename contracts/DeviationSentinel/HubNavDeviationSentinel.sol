// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.25;

import { IEBrake } from "../EmergencyBrake/IEBrake.sol";
import { IHub, IHubRegistry, IYieldGroupNav } from "../Interfaces/IHubLiquidity.sol";
import { AccessControlledV8 } from "@venusprotocol/governance-contracts/contracts/Governance/AccessControlledV8.sol";

/**
 * @title HubNavDeviationSentinel
 * @author Venus
 * @notice Sentinel a keeper drives to watch a Liquidity Hub resource's NavGuard band. When the reported
 *         value sits too far from the band's centre it pauses the whole Hub, which stops every deposit
 *         and redemption on it. It acts through EBrake.
 * @dev This contract can only TIGHTEN restrictions (pause), never loosen them.
 *      Recovery (unpausing) is handled via governance VIP.
 *      Idempotency is handled by EBrake — duplicate calls are no-ops.
 *
 *      The monitoring here stands on its own: it reads the band and judges the value against its own
 *      thresholds, whether or not the Hub is clamping that resource. Those thresholds should be set
 *      wider than the Hub's own gap, so routine clamping alone never trips a pause.
 */
contract HubNavDeviationSentinel is AccessControlledV8 {
    /// @notice Pause thresholds for one Liquidity Hub resource's NavGuard band
    /// @dev A zero threshold leaves that side unwatched, so a resource can be guarded one way only.
    /// @param hub The Hub to pause, read off the YieldGroup when configured and never from a keeper
    /// @param pauseUpBps How far above the band's centre the value must sit to trip, in bps
    /// @param pauseDownBps How far below the band's centre the value must sit to trip, in bps
    /// @param enabled Whether this band is being watched. Only `setNavMonitoringEnabled` writes it.
    struct NavGuardConfig {
        address hub;
        uint16 pauseUpBps;
        uint16 pauseDownBps;
        bool enabled;
    }

    /// @notice Why a NavGuard check did or did not call for a pause
    /// @dev Ordered so the zero value is a no-action one: an unwritten status reads as MonitoringDisabled.
    /// @param MonitoringDisabled This YieldGroup/resource pair is not armed in `navGuardConfigs`
    /// @param YieldGroupNotRegistered The Hub does not list the supplied YieldGroup
    /// @param ResourceNotRegistered The YieldGroup does not list the supplied resource
    /// @param ObservedValueZero The value source read back zero, so there is nothing to compare
    /// @param CentreZero The band is closed with the cap off (or the downside unwatched), so the
    ///        Hub isn't mis-valuing the position — see `checkNavGuardDeviation`
    /// @param WithinThreshold Inside the band, or outside it by less than the configured threshold
    /// @param Breached Outside the band by more than the threshold, or a closed band is clamping
    ///        a real value to zero — either way, a pause is due
    enum NavGuardCheckStatus {
        MonitoringDisabled,
        YieldGroupNotRegistered,
        ResourceNotRegistered,
        ObservedValueZero,
        CentreZero,
        WithinThreshold,
        Breached
    }

    /// @notice Basis-point denominator, and the ceiling on either pause threshold
    /// @dev `pauseDownBps` must stay strictly below it: at 10_000 the downside trip point is 0, and
    ///      nothing is below 0, so that side would never fire. Upward has no such point.
    uint16 public constant MAX_DEVIATION_BPS = 10_000;

    /// @notice Emergency Brake contract the Hub pause is routed through
    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    IEBrake public immutable EBRAKE;

    /// @notice Chain-level Liquidity Hub directory, used to vouch for a YieldGroup's Hub at config time
    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    IHubRegistry public immutable HUB_REGISTRY;

    /// @notice Mapping of trusted keeper addresses
    mapping(address => bool) public trustedKeepers;

    /// @notice NavGuard pause thresholds
    /// @dev Keyed on the pair because the band lives in each YieldGroup's own storage, so the same
    ///      resource under two YieldGroups has two independent bands.
    mapping(address yieldGroup => mapping(address resource => NavGuardConfig config)) public navGuardConfigs;

    /// @dev Storage gap for future upgrades.
    uint256[48] private __gap;

    /// @notice Emitted when a keeper's trusted status is updated
    /// @param keeper The keeper address
    /// @param isTrusted Whether the keeper is trusted
    event TrustedKeeperUpdated(address indexed keeper, bool isTrusted);

    /// @notice Emitted when a resource's NavGuard pause thresholds are updated
    /// @param hub The Liquidity Hub the YieldGroup belongs to
    /// @param yieldGroup The YieldGroup holding the resource
    /// @param resource The Liquidity Hub resource address
    /// @param config The stored config after the update
    event NavGuardConfigUpdated(
        address indexed hub,
        address indexed yieldGroup,
        address indexed resource,
        NavGuardConfig config
    );

    /// @notice Emitted when a resource's band starts or stops being watched
    /// @param hub The Liquidity Hub the YieldGroup belongs to
    /// @param yieldGroup The YieldGroup holding the resource
    /// @param resource The Liquidity Hub resource address
    /// @param enabled Whether the band is being watched
    event NavGuardStatusChanged(
        address indexed hub,
        address indexed yieldGroup,
        address indexed resource,
        bool enabled
    );

    /// @notice Emitted when a resource breaks through its NavGuard band and the Hub is paused
    /// @dev `centre` is what the breach was measured against, and the two bounds are the band the
    ///      Hub was applying at the time. All three raw, so an operator can recompute the ordinary
    ///      trip point from the thresholds — except when `centre` is 0, where the breach is the
    ///      band itself being closed on a real value, not a percentage miss.
    /// @param hub The Liquidity Hub that was paused
    /// @param yieldGroup The YieldGroup holding the breaching resource
    /// @param resource The resource whose value broke through its band
    /// @param observedValue Value the counterparty reported at detection time
    /// @param centre What the band says the position is worth, which the thresholds measure from
    /// @param minAllowedValue The band's floor at detection time
    /// @param maxAllowedValue The band's cap at detection time
    event NavGuardDeviationHandled(
        address indexed hub,
        address indexed yieldGroup,
        address indexed resource,
        uint256 observedValue,
        uint256 centre,
        uint256 minAllowedValue,
        uint256 maxAllowedValue
    );

    /// @notice Thrown when both thresholds are set to zero
    error ZeroDeviation();

    /// @notice Thrown when a threshold exceeds the maximum allowed
    error ExceedsMaxDeviation();

    /// @notice Thrown when a zero address is provided
    error ZeroAddress();

    /// @notice Thrown when caller is not an authorized keeper
    error UnauthorizedKeeper();

    /// @notice Thrown when a resource has no NavGuard pause thresholds set
    error ResourceNotConfigured(address yieldGroup, address resource);

    /// @notice Thrown when a resource's NavGuard band is not being watched
    error NavGuardDisabled(address yieldGroup, address resource);

    /// @notice Thrown when the YieldGroup's Hub is not one the registry lists
    error HubNotRegistered(address hub, address yieldGroup);

    /// @notice Thrown when the Hub does not list the supplied YieldGroup in its registry
    error YieldGroupNotRegistered(address hub, address yieldGroup);

    /// @notice Thrown when the YieldGroup does not list the supplied resource in its registry
    /// @dev Unregistered means zero balance, so it is outside `totalAssets()` and nothing to pause.
    error ResourceNotRegistered(address yieldGroup, address resource);

    /// @notice Thrown when the value source reports zero
    /// @dev Either a read that failed or a position the counterparty prices at nothing: the Hub
    ///      drops the readable flag in `navGuardStatus`, so the two arrive here as the same zero.
    ///      Neither is treated as a breach, which matches the Hub refusing to close a band on a
    ///      published zero. A genuine write-off is a governance action, not a sentinel pause.
    error NavGuardObservedValueZero(address resource);

    /// @notice Thrown when the band is closed but nothing here is actually mis-valued
    /// @dev The same closed band with the cap armed and the downside watched is a `Breached`
    ///      pause instead — see `checkNavGuardDeviation`.
    error NavGuardCentreZero(address resource);

    /// @notice Thrown when the band is broken by less than the configured pause threshold
    /// @dev Small enough to let the band step down on its own.
    error DeviationWithinThreshold(address resource, uint256 observedValue);

    modifier onlyKeeper() {
        if (!trustedKeepers[msg.sender]) revert UnauthorizedKeeper();
        _;
    }

    /// @notice Constructor for HubNavDeviationSentinel
    /// @param eBrake_ Address of the EBrake contract
    /// @param hubRegistry_ Address of the Liquidity Hub registry
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(IEBrake eBrake_, IHubRegistry hubRegistry_) {
        if (address(eBrake_) == address(0)) revert ZeroAddress();
        if (address(hubRegistry_) == address(0)) revert ZeroAddress();

        EBRAKE = eBrake_;
        HUB_REGISTRY = hubRegistry_;

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

    /// @notice Set the NavGuard pause thresholds for a Liquidity Hub resource
    /// @dev Thresholds only: arming is `setNavMonitoringEnabled`, so retuning one cannot arm or disarm
    ///      it. Both are measured from the band's centre, so each has to exceed the Hub's matching
    ///      gap, `upGapBps` or `downGapBps`, or clamping the Hub does routinely trips a pause.
    /// @param yieldGroup Address of the YieldGroup holding the resource
    /// @param resource Address of the resource inside that YieldGroup
    /// @param pauseUpBps How far above the centre the value must sit to trip, in bps; zero leaves it unwatched
    /// @param pauseDownBps How far below the centre the value must sit to trip, in bps; zero leaves it unwatched
    /// @custom:event Emits NavGuardConfigUpdated event
    /// @custom:error ZeroAddress is thrown when the YieldGroup or resource address is zero
    /// @custom:error ZeroDeviation is thrown when both thresholds are zero
    /// @custom:error ExceedsMaxDeviation is thrown when a threshold is out of range
    /// @custom:error HubNotRegistered is thrown when the registry does not list the YieldGroup's Hub
    /// @custom:error YieldGroupNotRegistered is thrown when that Hub does not list the YieldGroup
    /// @custom:error ResourceNotRegistered is thrown when the YieldGroup does not list the resource
    function setHubNavConfig(address yieldGroup, address resource, uint16 pauseUpBps, uint16 pauseDownBps) external {
        _checkAccessAllowed("setHubNavConfig(address,address,uint16,uint16)");

        if (yieldGroup == address(0) || resource == address(0)) revert ZeroAddress();
        if (pauseUpBps == 0 && pauseDownBps == 0) revert ZeroDeviation();
        if (pauseUpBps > MAX_DEVIATION_BPS || pauseDownBps >= MAX_DEVIATION_BPS) revert ExceedsMaxDeviation();

        address hub = _requireLiveResource(yieldGroup, resource);

        NavGuardConfig storage config = navGuardConfigs[yieldGroup][resource];
        config.pauseUpBps = pauseUpBps;
        config.pauseDownBps = pauseDownBps;
        config.hub = hub;

        emit NavGuardConfigUpdated(hub, yieldGroup, resource, config);
    }

    /// @notice Start or stop watching a resource's NavGuard band, keeping its thresholds
    /// @dev Arming re-runs the checks `setHubNavConfig` ran, since a Hub or a resource can be
    ///      de-registered in between. Disarming runs none, so a dropped pair can always be turned off.
    /// @param yieldGroup Address of the YieldGroup holding the resource
    /// @param resource Address of the resource
    /// @param enabled Whether to watch this resource's band
    /// @custom:event Emits NavGuardStatusChanged event
    /// @custom:error ZeroAddress is thrown when the YieldGroup or resource address is zero
    /// @custom:error ResourceNotConfigured is thrown when the pair has no thresholds set
    /// @custom:error HubNotRegistered is thrown when arming and the registry has dropped the Hub
    /// @custom:error YieldGroupNotRegistered is thrown when arming and the Hub has dropped the YieldGroup
    /// @custom:error ResourceNotRegistered is thrown when arming and the YieldGroup has dropped the resource
    function setNavMonitoringEnabled(address yieldGroup, address resource, bool enabled) external {
        _checkAccessAllowed("setNavMonitoringEnabled(address,address,bool)");

        if (yieldGroup == address(0) || resource == address(0)) revert ZeroAddress();

        NavGuardConfig storage config = navGuardConfigs[yieldGroup][resource];
        if (config.pauseUpBps == 0 && config.pauseDownBps == 0) revert ResourceNotConfigured(yieldGroup, resource);

        if (enabled) config.hub = _requireLiveResource(yieldGroup, resource);

        config.enabled = enabled;
        emit NavGuardStatusChanged(config.hub, yieldGroup, resource, enabled);
    }

    /// @notice Handle a NavGuard band breach on a Liquidity Hub resource by pausing the Hub
    /// @dev The whole Hub is paused, not the breaching resource: `YieldGroupBase.totalAssets()` sums
    ///      every registered resource without reading its pause flag, so pausing just that resource
    ///      would leave the same wrong number priced into deposits and redemptions.
    /// @param yieldGroup The YieldGroup holding the resource. Checked against its Hub's registry.
    /// @param resource The resource whose NavGuard band to read
    /// @custom:event Emits NavGuardDeviationHandled with the band context at detection time
    /// @custom:error UnauthorizedKeeper is thrown when caller is not a trusted keeper
    /// @custom:error NavGuardDisabled (pair not watched), YieldGroupNotRegistered (Hub dropped the
    ///        YieldGroup), ResourceNotRegistered (YieldGroup dropped the resource),
    ///        NavGuardObservedValueZero (value source reads zero), NavGuardCentreZero (band closed
    ///        but nothing mis-valued), or DeviationWithinThreshold (break below the threshold) —
    ///        each is one non-breach status `checkNavGuardDeviation` can return.
    function handleNavGuardDeviation(address yieldGroup, address resource) external onlyKeeper {
        (
            NavGuardCheckStatus status,
            address hub,
            uint256 observedValue,
            uint256 centre,
            uint256 minAllowedValue,
            uint256 maxAllowedValue
        ) = checkNavGuardDeviation(yieldGroup, resource);

        if (status == NavGuardCheckStatus.MonitoringDisabled) revert NavGuardDisabled(yieldGroup, resource);
        if (status == NavGuardCheckStatus.YieldGroupNotRegistered) revert YieldGroupNotRegistered(hub, yieldGroup);
        if (status == NavGuardCheckStatus.ResourceNotRegistered) revert ResourceNotRegistered(yieldGroup, resource);
        if (status == NavGuardCheckStatus.ObservedValueZero) revert NavGuardObservedValueZero(resource);
        if (status == NavGuardCheckStatus.CentreZero) revert NavGuardCentreZero(resource);
        if (status == NavGuardCheckStatus.WithinThreshold) revert DeviationWithinThreshold(resource, observedValue);

        // Backstop for a status the list above does not name: fall through to doing nothing rather
        // than to pausing a Hub on a verdict this function was never taught to read.
        if (status != NavGuardCheckStatus.Breached) return;

        EBRAKE.pauseHub(hub);

        emit NavGuardDeviationHandled(
            hub,
            yieldGroup,
            resource,
            observedValue,
            centre,
            minAllowedValue,
            maxAllowedValue
        );
    }

    /// @notice Check whether a Liquidity Hub resource's NAV has broken through its NavGuard band by
    ///         more than the configured threshold, and why
    /// @dev `handleNavGuardDeviation` calls this rather than repeating the comparison, so what
    ///      monitoring reads and what the keeper acts on cannot drift apart.
    ///      Can revert: `yieldGroup` is caller-supplied, so a non-contract address or a revert
    ///      inside it propagates out. The Hub is not — it comes from the stored config.
    /// @param yieldGroup The YieldGroup holding the resource
    /// @param resource The resource whose NavGuard band to read
    /// @return status Why a pause is or is not due
    /// @return hub The Hub that would be paused, as governance configured it; `0` when unwatched
    /// @return observedValue Value the counterparty reports, in asset units; `0` if unread or empty
    /// @return centre What the band says the position is worth; `0` if unread or the band is closed
    /// @return minAllowedValue The band's floor; `0` before it is read, or when the band is closed
    /// @return maxAllowedValue The band's cap; `0` before it is read, or when the band is closed
    function checkNavGuardDeviation(
        address yieldGroup,
        address resource
    )
        public
        view
        returns (
            NavGuardCheckStatus status,
            address hub,
            uint256 observedValue,
            uint256 centre,
            uint256 minAllowedValue,
            uint256 maxAllowedValue
        )
    {
        NavGuardConfig memory config = navGuardConfigs[yieldGroup][resource];
        if (!config.enabled) return (NavGuardCheckStatus.MonitoringDisabled, address(0), 0, 0, 0, 0);

        hub = config.hub;

        if (!IHub(hub).yieldGroupConfig(yieldGroup).registered) {
            return (NavGuardCheckStatus.YieldGroupNotRegistered, hub, 0, 0, 0, 0);
        }

        (bool registered, , ) = IYieldGroupNav(yieldGroup).resourceConfig(resource);
        if (!registered) return (NavGuardCheckStatus.ResourceNotRegistered, hub, 0, 0, 0, 0);

        (observedValue, minAllowedValue, maxAllowedValue, , ) = IYieldGroupNav(yieldGroup).navGuardStatus(resource);

        // Measured from the centre, not the bounds: the bounds carry the Hub's own gap, so widening
        // it on the Hub side would move this trip point even though nothing changed here.
        //
        // Read raw, not drift-grown: the centre is rewritten on every Hub flow, and flows land
        // about daily, so the drift in between is a couple of bps.
        IYieldGroupNav.NavBand memory band = IYieldGroupNav(yieldGroup).navGuard(resource);
        centre = band.centre;

        // A zero value sits under any downside trip point, and a zero centre puts both trip points at
        // zero, so either would read as a breach in the comparison below. Each gets its own status.
        if (observedValue == 0) {
            return (
                NavGuardCheckStatus.ObservedValueZero,
                hub,
                observedValue,
                centre,
                minAllowedValue,
                maxAllowedValue
            );
        }
        if (centre == 0) {
            // The position still holds real value, but this band is closed. With the cap armed,
            // the Hub's own `_guardedNav` prices this resource at the closed cap — zero — so Hub
            // NAV understates the position by its full value. With the downside watched too, that
            // undercount is the breach this sentinel exists to catch.
            //
            // With the cap off, or the downside left unwatched, the Hub reports the real value
            // unclamped, so there is nothing here to flag.
            if (band.capEnabled && config.pauseDownBps != 0) {
                return (NavGuardCheckStatus.Breached, hub, observedValue, centre, minAllowedValue, maxAllowedValue);
            }
            return (NavGuardCheckStatus.CentreZero, hub, observedValue, centre, minAllowedValue, maxAllowedValue);
        }

        uint256 downTripPoint = (centre * (MAX_DEVIATION_BPS - config.pauseDownBps)) / MAX_DEVIATION_BPS;
        uint256 upTripPoint = (centre * (MAX_DEVIATION_BPS + config.pauseUpBps)) / MAX_DEVIATION_BPS;

        // A zero threshold leaves its side unwatched, so it has to be tested for separately —
        // read as a trip point it would be the tightest one there is.
        bool breachedDown = config.pauseDownBps != 0 && observedValue < downTripPoint;
        bool breachedUp = config.pauseUpBps != 0 && observedValue > upTripPoint;

        status = breachedDown || breachedUp ? NavGuardCheckStatus.Breached : NavGuardCheckStatus.WithinThreshold;
    }

    /// @notice Resolve a YieldGroup's Hub and prove the whole chain down to the resource is live
    /// @dev Three reads, each covering what the one before cannot: the registry vouches for the
    ///      Hub, the Hub for the YieldGroup, and the YieldGroup for the resource.
    /// @param yieldGroup YieldGroup to resolve
    /// @param resource Resource that must belong to it
    /// @return hub The Hub that YieldGroup reports to
    function _requireLiveResource(address yieldGroup, address resource) private view returns (address hub) {
        hub = IYieldGroupNav(yieldGroup).hub();
        if (!HUB_REGISTRY.isHub(hub)) revert HubNotRegistered(hub, yieldGroup);
        if (!IHub(hub).yieldGroupConfig(yieldGroup).registered) revert YieldGroupNotRegistered(hub, yieldGroup);

        (bool registered, , ) = IYieldGroupNav(yieldGroup).resourceConfig(resource);
        if (!registered) revert ResourceNotRegistered(yieldGroup, resource);
    }
}
