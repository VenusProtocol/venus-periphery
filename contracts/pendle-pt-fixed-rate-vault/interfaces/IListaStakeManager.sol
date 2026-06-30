// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.25;

/**
 * @title IListaStakeManager
 * @author Venus
 * @notice Minimal interface for the Lista DAO StakeManager used to natively unstake slisBNB into BNB.
 * @dev Unstaking is asynchronous: `requestWithdraw` burns slisBNB and enqueues a request that becomes
 *      claimable after the protocol unbond period (~7 days). `claimWithdraw` then sends the BNB to the caller.
 *      Withdrawal requests are stored per-account; `claimWithdraw` indexes into the caller's request array,
 *      and Lista compacts that array on claim (swap-and-pop), so indices are NOT stable across claims.
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
}
