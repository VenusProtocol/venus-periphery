// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.25;

/**
 * @title IHubLiquidity
 * @author Venus
 * @notice Minimal views and emergency levers HubNavDeviationSentinel and EBrake need from the
 *         Liquidity Hub.
 * @dev Hand-copied so this repo takes no dependency on liquidity-hub. Nothing cross-checks the
 *      selectors at build time, so a signature that drifts from the Hub's reverts on chain.
 */
interface IHub {
    /// @notice Per-YieldGroup configuration held by the Hub's registry.
    /// @param absoluteCap Hard cap on the YieldGroup's holdings, in asset units.
    /// @param percentageCapBps Cap as a fraction of `totalAssets()`, in basis points.
    /// @param paused When true, routing skips this YieldGroup; existing balance still counts.
    /// @param registered True iff present in the Hub's YieldGroup registry.
    struct YieldGroupConfig {
        uint256 absoluteCap;
        uint16 percentageCapBps;
        bool paused;
        bool registered;
    }

    /// @notice Pause the Hub, halting deposits and redemptions.
    /// @dev ACM role `"pauseHub()"`. Idempotent — pausing an already-paused Hub is a silent no-op.
    function pauseHub() external;

    /// @notice Stop the Hub routing new deposits to a YieldGroup; its balance still counts toward NAV.
    /// @dev ACM role `"pauseYieldGroup(address)"`. Idempotent, and reverts `YieldGroupNotRegistered`
    ///      for an address the Hub never registered.
    /// @param yieldGroup YieldGroup to pause.
    function pauseYieldGroup(address yieldGroup) external;

    /// @notice Read a YieldGroup's registry entry.
    /// @param yieldGroup YieldGroup to read.
    /// @return config Stored configuration; all-zero when never registered.
    function yieldGroupConfig(address yieldGroup) external view returns (YieldGroupConfig memory config);

    /// @notice Total assets the Hub reports, with every NavGuard band applied.
    /// @return total Hub NAV, in asset units.
    function totalAssets() external view returns (uint256 total);

    /// @notice Whether the Hub is currently paused.
    /// @return paused True while the Hub is paused.
    function hubPaused() external view returns (bool paused);
}

/**
 * @title IHubRegistry
 * @author Venus
 * @notice The chain-level Hub directory, as far as HubNavDeviationSentinel needs it.
 * @dev One per chain, and only on chains that run a Liquidity Hub. Governance writes it, so it
 *      answers whether an address is a Hub Venus onboarded rather than one that claims to be.
 */
interface IHubRegistry {
    /// @notice Whether an address is a registered Hub.
    /// @param hub Address to check.
    /// @return registered True iff the registry lists `hub`.
    function isHub(address hub) external view returns (bool registered);
}

/**
 * @title IYieldGroupNav
 * @author Venus
 * @notice The registry and NavGuard reads HubNavDeviationSentinel needs from a YieldGroup, and the
 *         resource pause EBrake forwards to it.
 */
interface IYieldGroupNav {
    /// @notice A resource's NavGuard band, as stored by the YieldGroup.
    /// @param anchor Value the two gaps are sized off.
    /// @param centre Where the band sits: the anchor plus Venus's own deposits since.
    /// @param anchoredAt When the band last re-anchored.
    /// @param driftFrom When the drift clock last restarted.
    /// @param interval Seconds between re-anchors; `0` means no band is configured.
    /// @param driftBps Annual drift allowance, in basis points.
    /// @param upGapBps How far above the centre the band reaches, in basis points of the anchor.
    /// @param downGapBps How far below the centre the band reaches, in basis points of the anchor.
    /// @param capEnabled Whether the Hub holds its valuation to the cap.
    /// @param floorEnabled Whether the Hub holds its valuation to the floor.
    struct NavBand {
        uint128 anchor;
        uint128 centre;
        uint64 anchoredAt;
        uint64 driftFrom;
        uint32 interval;
        uint16 driftBps;
        uint16 upGapBps;
        uint16 downGapBps;
        bool capEnabled;
        bool floorEnabled;
    }

    /// @notice The Hub this YieldGroup reports assets to.
    /// @dev Written once in the YieldGroup's initializer, so HubNavDeviationSentinel can derive the Hub
    ///      from the YieldGroup instead of having a keeper name it.
    /// @return hubAddress Hub that owns this YieldGroup.
    function hub() external view returns (address hubAddress);

    /// @notice Per-resource registration / pause state plus the adapter handling it.
    /// @param resource Address to look up.
    /// @return registered True iff present in the YieldGroup's resource registry.
    /// @return paused True iff this resource is paused.
    /// @return adapter `IResourceAdapter` implementation bound to this resource.
    function resourceConfig(address resource) external view returns (bool registered, bool paused, address adapter);

    /// @notice Stop the YieldGroup routing new deposits to a resource; its balance still counts
    ///         toward NAV, but user withdrawals skip it.
    /// @dev ACM role `"pauseResource(address)"`, checked against this YieldGroup's address. Idempotent,
    ///      and reverts `ResourceNotRegistered` for an address the YieldGroup never registered.
    /// @param resource Resource to pause.
    function pauseResource(address resource) external;

    /// @notice The band's own stored numbers for a resource.
    /// @dev Field order must match the Hub's `NavBand` exactly. `anchor` and `centre` are both
    ///      `uint128` and adjacent, so a reordering there would decode silently wrong rather than
    ///      revert — pin this against `INavGuard.NavBand` when upgrading either side.
    ///
    ///      `centre` is the value as last saved, on a deposit, redeem or re-anchor. The Hub grows it
    ///      by `driftBps` a year since `driftFrom`, so a caller wanting the live centre must too.
    /// @param resource Resource to look up.
    /// @return band The stored band.
    function navGuard(address resource) external view returns (NavBand memory band);

    /// @notice Where a resource's value stands against its NavGuard band right now.
    /// @dev Never reverts. A zero `observedValue` is ambiguous on purpose: the Hub reads the value
    ///      source as `(value, readable)` and drops the flag here, so a read that failed and a
    ///      position the counterparty prices at nothing arrive identically. Neither can be told from
    ///      the other through this interface, which is why HubNavDeviationSentinel treats a zero as no
    ///      verdict rather than as a total loss.
    /// @param resource Resource to read.
    /// @return observedValue Value the counterparty reports, in asset units; `0` if unreadable or genuinely zero.
    /// @return minAllowedValue Lowest value the band allows right now.
    /// @return maxAllowedValue Highest value the band allows right now.
    /// @return isClamped Whether valuation is currently reporting a bound instead of `observedValue`.
    /// @return clampedValue What valuation reports instead; `0` when `isClamped` is false.
    function navGuardStatus(
        address resource
    )
        external
        view
        returns (
            uint256 observedValue,
            uint256 minAllowedValue,
            uint256 maxAllowedValue,
            bool isClamped,
            uint256 clampedValue
        );
}
