// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.25;

import { IHub, IYieldGroupNav } from "../Interfaces/IHubLiquidity.sol";

/**
 * @title IHubFork
 * @author Venus
 * @notice The rest of the Liquidity Hub's surface, for fork tests that have to drive the Hub the way
 *         users and governance do rather than only read what HubNavDeviationSentinel reads.
 * @dev Hand-copied from venus-liquidity-hub for the same reason {IHub} is — this repo takes no
 *      dependency on it. Nothing cross-checks the selectors at build time, so a signature that drifts
 *      from the Hub reverts on chain, which is exactly where a fork test catches it.
 */
interface IHubFork is IHub {
    /// @notice One leg of a rebalance: how much to move, out of or into which YieldGroup.
    /// @param yieldGroup YieldGroup the leg acts on.
    /// @param resource Resource inside it, or zero to let the group pick through its own queues.
    /// @param amount Assets to move.
    struct ReallocateLeg {
        address yieldGroup;
        address resource;
        uint256 amount;
    }

    /// @notice Thrown by every user-facing flow while the Hub is paused.
    error HubPaused();

    /// @notice Thrown by a deposit or rebalance leg that targets a paused YieldGroup.
    error YieldGroupPaused(address yieldGroup);

    /// @notice Thrown by the YieldGroup pause levers for an address the Hub never registered.
    error YieldGroupNotRegistered(address yieldGroup);

    /// @notice Thrown by {AccessControlledV8} when the caller holds no role for the function.
    error Unauthorized(address sender, address calledContract, string methodSignature);

    function deposit(uint256 assets, address receiver) external returns (uint256 shares);

    function mint(uint256 shares, address receiver) external returns (uint256 assets);

    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares);

    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);

    /// @notice Settles fees, which is also what pokes every YieldGroup's NAV band.
    function accrueFees() external;

    function unpauseHub() external;

    function removeYieldGroup(address yieldGroup) external;

    function reallocate(ReallocateLeg[] calldata withdraws, ReallocateLeg[] calldata deposits) external;

    /// @notice The wind-down lever that stays callable while the Hub is paused.
    function emergencyReallocate(ReallocateLeg[] calldata withdraws, ReallocateLeg[] calldata deposits) external;

    function totalAssets() external view returns (uint256 total);

    function convertToAssets(uint256 shares) external view returns (uint256 assets);

    function maxDeposit(address receiver) external view returns (uint256 capacity);

    function balanceOf(address account) external view returns (uint256 shares);
}

/**
 * @title IYieldGroupCentrifugeFork
 * @author Venus
 * @notice The Centrifuge YieldGroup's governance and keeper surface, on top of the NAV reads
 *         HubNavDeviationSentinel already declares in {IYieldGroupNav}.
 * @dev Same hand-copy caveat as {IHubFork}.
 */
interface IYieldGroupCentrifugeFork is IYieldGroupNav {
    /// @notice Thrown by the adapter when a share-holding position has no published price, which
    ///         propagates out of `totalAssets()` and halts every Hub flow.
    error ZeroSharePrice(address resource);

    /// @notice Thrown by a deposit routed straight at a paused resource.
    error ResourceIsPaused(address resource);

    /// @notice Thrown by the resource pause levers for an address the YieldGroup never registered.
    error ResourceNotRegistered(address resource);

    function setNavGuardRate(
        address resource,
        uint16 driftBps,
        uint16 upGapBps,
        uint16 downGapBps,
        uint32 interval,
        bool capEnabled,
        bool floorEnabled
    ) external;

    function setNavGuardSnapshot(address resource, uint128 snapshot, uint64 timestamp) external;

    function setNavGuardEnabled(address resource, bool capEnabled, bool floorEnabled) external;

    function requestRedeem(address resource, uint256 shares) external;

    function claimDeposit(address resource) external returns (uint256 shares);

    function claimRedeem(address resource) external returns (uint256 assets);

    /// @notice Writes off a position governance can no longer claim. Only reachable while the Hub is paused.
    function forceRemoveResource(address resource) external;

    /// @notice What this group contributes to Hub NAV: every resource held inside its band, plus idle.
    function totalAssets() external view returns (uint256 total);
}
