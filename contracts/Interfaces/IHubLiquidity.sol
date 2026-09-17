// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.25;

/**
 * @title IHubLiquidity
 * @author Venus
 * @notice Minimal views and emergency levers DeviationSentinel and EBrake need from the Liquidity Hub.
 * @dev Only the functions those two call, so venus-periphery takes no dependency on the
 *      liquidity-hub repo. Signatures must stay byte-identical — the selectors are what matter.
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

    /// @notice Read a YieldGroup's registry entry.
    /// @param yieldGroup YieldGroup to read.
    /// @return config Stored configuration; all-zero when never registered.
    function yieldGroupConfig(address yieldGroup) external view returns (YieldGroupConfig memory config);

    /// @notice Whether the Hub is currently paused.
    /// @return paused True while the Hub is paused.
    function hubPaused() external view returns (bool paused);
}

/**
 * @title IYieldGroupNav
 * @author Venus
 * @notice The NavGuard read and the resource pause DeviationSentinel and EBrake need from a YieldGroup.
 */
interface IYieldGroupNav {
    /// @notice Pause routing to a specific resource. Existing balance stays counted.
    /// @dev ACM role `"pauseResource(address)"`. Idempotent. Reverts if `resource` is not registered.
    /// @param resource Resource to pause.
    function pauseResource(address resource) external;

    /// @notice Per-resource registration / pause state plus the adapter handling it.
    /// @param resource Address to look up.
    /// @return registered True iff present in the YieldGroup's resource registry.
    /// @return paused True iff this resource is paused.
    /// @return adapter `IResourceAdapter` implementation bound to this resource.
    function resourceConfig(address resource) external view returns (bool registered, bool paused, address adapter);

    /// @notice Where a resource's value stands against its NavGuard band right now.
    /// @dev Never reverts. An unreadable value source reports `observedValue` as zero with
    ///      `isClamped` false, which is why DeviationSentinel checks `isClamped` first.
    /// @param resource Resource to read.
    /// @return observedValue Value the counterparty reports, in asset units; `0` if unreadable.
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
