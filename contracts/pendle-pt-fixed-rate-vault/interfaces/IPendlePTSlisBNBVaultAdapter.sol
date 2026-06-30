// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.25;

import { IPendlePTVaultAdapter } from "./IPendlePTVaultAdapter.sol";

/**
 * @title IPendlePTSlisBNBVaultAdapter
 * @author Venus
 * @notice Interface for the PendlePTSlisBNBVaultAdapter contract.
 * @dev Extends the universal PendlePTVaultAdapter with a one-transaction
 *      withdraw → redeem → Lista unstake entrypoint (`requestWithdraw`) and a
 *      permissionless `claimUnstaked` that finalizes the async Lista unstake and
 *      forwards native BNB to the original owner. Inherits all base events/errors.
 */
interface IPendlePTSlisBNBVaultAdapter is IPendlePTVaultAdapter {
    // ═══════════════════════════════════════════════════════════════════════
    //                              EVENTS
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Emitted when a user redeems a matured PT position and the adapter enqueues a Lista unstake.
     * @param pendleMarket Pendle market address used for the redemption
     * @param user Address of the user who requested the unstake (recorded as the uuid owner)
     * @param uuid Lista withdrawal request identifier (stable across array compaction)
     * @param vTokenAmount Amount of vTokens redeemed
     * @param ptAmount Amount of PT tokens redeemed 1:1 via Pendle
     * @param slisBnbAmount Amount of slisBNB sent to the Lista StakeManager for unstaking
     * @param startTime Timestamp when the Lista unbond period started
     * @param claimableAt Estimated timestamp when the request becomes claimable (startTime + UNBOND_PERIOD)
     */
    event UnstakeRequested(
        address indexed pendleMarket,
        address indexed user,
        uint256 indexed uuid,
        uint256 vTokenAmount,
        uint256 ptAmount,
        uint256 slisBnbAmount,
        uint256 startTime,
        uint256 claimableAt
    );

    /**
     * @notice Emitted when a matured Lista unstake request is claimed and BNB is forwarded to the owner.
     * @param uuid Lista withdrawal request identifier that was claimed
     * @param user Address of the original owner who receives the native BNB
     * @param bnbAmount Amount of native BNB forwarded to the user
     */
    event UnstakeClaimed(uint256 indexed uuid, address indexed user, uint256 bnbAmount);

    // ═══════════════════════════════════════════════════════════════════════
    //                           CUSTOM ERRORS
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Error thrown when an unstake request for the given uuid is unknown or already claimed.
     * @param uuid The Lista withdrawal request identifier that was not found
     */
    error UnstakeRequestNotFound(uint256 uuid);

    // ═══════════════════════════════════════════════════════════════════════
    //                          CORE — UNSTAKE
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Redeem a matured PT position to slisBNB and enqueue a native Lista unstake in one transaction.
     * @dev Flow: redeem vTokens → redeem PT 1:1 to slisBNB via Pendle → requestWithdraw on Lista.
     *      The adapter (not the user) calls Lista, so it records uuid → msg.sender for later claim.
     *      User must have delegated to this adapter in the Comptroller beforehand.
     * @param pendleMarket Pendle market address (must redeem 1:1 to slisBNB)
     * @param vTokenAmount Amount of vTokens to redeem
     * @param minSlisBnbOut Minimum slisBNB to receive from the PT redemption (slippage protection)
     * @return uuid Lista withdrawal request identifier owned by msg.sender
     */
    function requestWithdraw(
        address pendleMarket,
        uint256 vTokenAmount,
        uint256 minSlisBnbOut
    ) external returns (uint256 uuid);

    /**
     * @notice Finalize a matured Lista unstake request and forward native BNB to its owner.
     * @dev Permissionless — anyone may call once the unbond period has elapsed; BNB always goes to the
     *      recorded owner, never the caller. Intentionally NOT pausable so funds are never trapped.
     * @param uuid Lista withdrawal request identifier to claim
     */
    function claimUnstaked(uint256 uuid) external;

    // ═══════════════════════════════════════════════════════════════════════
    //                          VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Get all outstanding Lista unstake request uuids for a user.
     * @param user The user whose unstake requests to read
     * @return Array of uuids owned by the user
     */
    function getUserUuids(address user) external view returns (uint256[] memory);

    /**
     * @notice Get details for a recorded unstake request.
     * @dev Scans the adapter's live Lista requests for the uuid; amount/startTime are zero if Lista
     *      no longer holds the request (e.g. already claimed but not yet cleared).
     * @param uuid Lista withdrawal request identifier
     * @return user Recorded owner of the request
     * @return amountInSnBnb Amount of slisBNB burned for the request
     * @return startTime Timestamp when the unbond period started
     * @return claimableAt Estimated timestamp when claimable (startTime + UNBOND_PERIOD)
     */
    function getUnstakeRequest(
        uint256 uuid
    ) external view returns (address user, uint256 amountInSnBnb, uint256 startTime, uint256 claimableAt);

    /**
     * @notice Recorded owner of a Lista unstake request uuid (zero if unknown or claimed).
     * @param uuid Lista withdrawal request identifier
     * @return Owner address recorded at request time
     */
    function unstakeOwner(uint256 uuid) external view returns (address);

    /**
     * @notice The slisBNB token (PT redeem token and unstake token).
     * @return slisBNB token address
     */
    function SLIS_BNB() external view returns (address);

    /**
     * @notice The Lista DAO StakeManager used for native unstaking.
     * @return Lista StakeManager address
     */
    function LISTA_STAKE_MANAGER() external view returns (address);

    /**
     * @notice The Lista unbond period estimate used to compute claimableAt.
     * @return Unbond period in seconds
     */
    function UNBOND_PERIOD() external view returns (uint256);
}
