// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.25;

/**
 * @title IListaStakeManager
 * @author Venus
 * @notice Minimal interface for the Lista DAO StakeManager used to natively unstake slisBNB into BNB.
 * @dev Unstaking is asynchronous: `requestWithdraw` transfers in slisBNB and enqueues a request. The
 *      request does NOT become claimable purely by elapsed time — Lista gates `claimWithdraw` on its
 *      bot-advanced confirmation pointer `nextConfirmedRequestUUID` (a request is claimable once its
 *      `uuid < nextConfirmedRequestUUID`), which the bot advances only after undelegating and claiming the
 *      BNB from the beacon chain. The unbond period (~7 days) is therefore an estimate, not the gate.
 *      `claimWithdraw` sends the BNB to the caller and indexes into the caller's request array, which Lista
 *      compacts on claim (swap-and-pop), so indices are NOT stable across claims.
 */
interface IListaStakeManager {
    /**
     * @notice A pending unstake request belonging to an account.
     * @param uuid Globally unique, stable identifier for the request (does not change as the array is compacted)
     * @param amountInSnBnb Amount of slisBNB burned for this request
     * @param startTime Timestamp when the request was created (unbond period is measured from here)
     */
    struct WithdrawalRequest {
        uint256 uuid;
        uint256 amountInSnBnb;
        uint256 startTime;
    }

    /**
     * @notice Burn slisBNB and enqueue a withdrawal request for the caller.
     * @param _amountInSlisBnb Amount of slisBNB to unstake (must be approved to the StakeManager first).
     */
    function requestWithdraw(uint256 _amountInSlisBnb) external;

    /**
     * @notice Claim a matured withdrawal request, sending the unbonded BNB to the caller.
     * @dev Reverts if the request at `_idx` has not completed the unbond period.
     *      `_idx` is the position in the caller's current request array, which Lista compacts on claim.
     * @param _idx Index into the caller's withdrawal request array.
     */
    function claimWithdraw(uint256 _idx) external;

    /**
     * @notice Get all pending withdrawal requests for an account.
     * @param _address The account whose requests to read.
     * @return Array of pending withdrawal requests.
     */
    function getUserWithdrawalRequests(address _address) external view returns (WithdrawalRequest[] memory);

    /**
     * @notice Convert an amount of slisBNB to its BNB value at the current exchange rate.
     * @param _amountInSlisBnb Amount of slisBNB.
     * @return Equivalent BNB amount.
     */
    function convertSnBnbToBnb(uint256 _amountInSlisBnb) external view returns (uint256);

    /**
     * @notice Confirmation pointer below which "new" withdrawal requests are claimable.
     * @dev A request is claimable once its `uuid < nextConfirmedRequestUUID`. Advanced only by Lista's bot
     *      (after beacon-chain undelegation), never by elapsed time. This is the real on-chain claim gate.
     * @return The next-confirmed request uuid pointer.
     */
    function nextConfirmedRequestUUID() external view returns (uint256);

    /**
     * @notice Status of a specific withdrawal request, including the exact BNB it will pay out.
     * @dev For a "new" (post-migration) request, `_amount` is the BNB figure Lista locked at request time
     *      (`convertSnBnbToBnb` at that block), not a claim-time recompute, so it is unaffected by later
     *      slisBNB appreciation. `_idx` is the position in the account's `getUserWithdrawalRequests` array.
     * @param _user The account whose request to read.
     * @param _idx Index into the account's withdrawal request array.
     * @return _isClaimable Whether the request can be claimed now.
     * @return _amount BNB amount the request will pay on claim (locked at request time for new requests).
     */
    function getUserRequestStatus(
        address _user,
        uint256 _idx
    ) external view returns (bool _isClaimable, uint256 _amount);
}
