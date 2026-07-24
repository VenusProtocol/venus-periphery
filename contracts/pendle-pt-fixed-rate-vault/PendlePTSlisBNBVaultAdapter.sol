// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.25;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Address } from "@openzeppelin/contracts/utils/Address.sol";

import { IPAllActionV3 } from "@pendle/core-v2/contracts/interfaces/IPAllActionV3.sol";
import { TokenOutput } from "@pendle/core-v2/contracts/interfaces/IPAllActionTypeV3.sol";
import { SwapData, SwapType } from "@pendle/core-v2/contracts/router/swap-aggregator/IPSwapAggregator.sol";

import { PendlePTVaultAdapter } from "./PendlePTVaultAdapter.sol";
import { IPendlePTSlisBNBVaultAdapter } from "./interfaces/IPendlePTSlisBNBVaultAdapter.sol";
import { IListaStakeManager } from "./interfaces/IListaStakeManager.sol";

/**
 * @title PendlePTSlisBNBVaultAdapter
 * @author Venus
 * @notice slisBNB-specialized adapter that extends PendlePTVaultAdapter with a one-transaction
 *         withdraw → redeem → Lista unstake entrypoint and a permissionless claim that forwards
 *         native BNB back to the original owner.
 * @dev Single-asset: slisBNB, the Lista StakeManager, and the unbond period are immutables.
 *      Works for any registered market whose PT redeems 1:1 to slisBNB (multiple maturities allowed).
 *      The base universal adapter is inherited unchanged; this child only adds its own storage
 *      (appended after the parent layout) and the unstake lifecycle.
 */
contract PendlePTSlisBNBVaultAdapter is PendlePTVaultAdapter, IPendlePTSlisBNBVaultAdapter {
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════════════════════════
    //                            IMMUTABLES
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice slisBNB token — the PT redeem token and the token unstaked via Lista.
    address public immutable SLIS_BNB;

    /// @notice Lista DAO StakeManager used for native (async) unstaking of slisBNB.
    address public immutable LISTA_STAKE_MANAGER;

    /// @notice Unbond period estimate (seconds) used only to compute the off-chain `claimableAt` hint.
    uint256 public immutable UNBOND_PERIOD;

    // ═══════════════════════════════════════════════════════════════════════
    //                          STATE VARIABLES
    // ═══════════════════════════════════════════════════════════════════════

    /// @dev Lista withdrawal request uuid → recorded request data (owner/amount/startTime).
    ///      Stored at request time so reads never depend on scanning Lista's live request array.
    mapping(uint256 => UnstakeRequest) internal _unstakeRequests;

    /// @dev Owner → list of their outstanding unstake request uuids (compacted via swap-pop on claim).
    mapping(address => uint256[]) internal _userUuids;

    /// @dev Reserved storage gap for future upgrades of the child (2 used slots + 48 = 50, matching the base).
    uint256[48] private __gap;

    // ═══════════════════════════════════════════════════════════════════════
    //                            CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Sets the immutable slisBNB token, Lista StakeManager, and unbond period estimate
    /// @param pendleRouter_ Pendle Router (IPAllActionV3) address.
    /// @param comptroller_ Venus core pool Comptroller address.
    /// @param slisBnb_ slisBNB token address.
    /// @param listaStakeManager_ Lista DAO StakeManager address.
    /// @param unbondPeriod_ Unbond period estimate in seconds (e.g. 7 days).
    constructor(
        address pendleRouter_,
        address comptroller_,
        address slisBnb_,
        address listaStakeManager_,
        uint256 unbondPeriod_
    ) PendlePTVaultAdapter(pendleRouter_, comptroller_) {
        if (slisBnb_ == address(0)) revert ZeroAddress();
        if (listaStakeManager_ == address(0)) revert ZeroAddress();
        if (unbondPeriod_ == 0) revert ZeroAmount();

        SLIS_BNB = slisBnb_;
        LISTA_STAKE_MANAGER = listaStakeManager_;
        UNBOND_PERIOD = unbondPeriod_;
        // Parent constructor already ran _disableInitializers().
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                          CORE — UNSTAKE
    // ═══════════════════════════════════════════════════════════════════════

    /// @inheritdoc IPendlePTSlisBNBVaultAdapter
    function requestWithdraw(
        address pendleMarket,
        uint256 vTokenAmount,
        uint256 minSlisBnbOut
    )
        external
        whenNotPaused
        nonReentrant
        onlyRegisteredMarket(pendleMarket)
        atOrAfterMaturity(pendleMarket)
        returns (uint256 uuid)
    {
        if (vTokenAmount == 0) revert ZeroAmount();

        MarketConfig memory config = markets[pendleMarket];
        address pt = config.pt;

        // 1. Redeem vTokens → adapter receives PT.
        uint256 ptBefore = IERC20(pt).balanceOf(address(this));
        _redeemVTokens(config.vToken, vTokenAmount);
        uint256 ptReceived = IERC20(pt).balanceOf(address(this)) - ptBefore;

        // 2. Redeem PT 1:1 → slisBNB to the adapter (so the adapter can drive the Lista unstake).
        uint256 slisBnbAmount = _redeemPtToAdapter(pt, config.yt, ptReceived, minSlisBnbOut);

        // 3. Safety sweep of residual PT (not expected with exact-in redemption).
        _sweepDust(pt, msg.sender, ptBefore);

        // 4. Enqueue the Lista unstake, record ownership, and emit (scoped to relieve the stack).
        uuid = _enqueueUnstake(pendleMarket, vTokenAmount, ptReceived, slisBnbAmount);
    }

    /// @inheritdoc IPendlePTSlisBNBVaultAdapter
    function claimUnstaked(uint256 uuid) external nonReentrant {
        // Intentionally NOT whenNotPaused so an adapter-level pause can never block a claim. Note this is not
        // an unconditional guarantee: Lista's claimWithdraw is itself whenNotPaused and gated on bot
        // confirmation, so a Lista-side pause or confirmation delay can still postpone the claim.
        UnstakeRequest memory request = _unstakeRequests[uuid];
        address user = request.owner;
        if (user == address(0)) revert UnstakeRequestNotFound(uuid);

        // Resolve the live index fresh — Lista compacts its array (swap-pop) on every claim, so the index
        // is not stable across claims and must be looked up against Lista's current array each time.
        IListaStakeManager.WithdrawalRequest[] memory requests = IListaStakeManager(LISTA_STAKE_MANAGER)
            .getUserWithdrawalRequests(address(this));
        (bool found, uint256 idx) = _findRequestIndex(requests, uuid);

        // Effects before interactions (CEI).
        delete _unstakeRequests[uuid];
        _removeUserUuid(user, uuid);

        uint256 bnbOut;
        if (found) {
            // Request still pending on the adapter: claim it now (BNB lands on the adapter via Lista).
            uint256 balanceBefore = address(this).balance;
            IListaStakeManager(LISTA_STAKE_MANAGER).claimWithdraw(idx);
            bnbOut = address(this).balance - balanceBefore;
        } else {
            // The uuid left the adapter's Lista array, which is only possible if Lista's bot already claimed
            // it via claimWithdrawFor (BOT-gated). Lista forwarded the BNB it locked at request time to this
            // adapter, so forward that snapshot. Never recompute at claim — slisBNB appreciates, which would
            // overpay from other requests' pooled BNB.
            bnbOut = request.amountInBnb;
        }

        Address.sendValue(payable(user), bnbOut);

        emit UnstakeClaimed(uuid, user, bnbOut);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                          VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════

    /// @inheritdoc IPendlePTSlisBNBVaultAdapter
    function getUserUuids(address user) external view returns (uint256[] memory) {
        return _userUuids[user];
    }

    /// @inheritdoc IPendlePTSlisBNBVaultAdapter
    function unstakeOwner(uint256 uuid) external view returns (address) {
        return _unstakeRequests[uuid].owner;
    }

    /// @inheritdoc IPendlePTSlisBNBVaultAdapter
    function getUnstakeRequest(
        uint256 uuid
    ) external view returns (address user, uint256 amountInSnBnb, uint256 startTime, uint256 claimableAt) {
        UnstakeRequest memory request = _unstakeRequests[uuid];
        user = request.owner;
        amountInSnBnb = request.amountInSnBnb;
        startTime = request.startTime;
        // Off-chain estimate only; real claimability is reported by isClaimable().
        claimableAt = startTime == 0 ? 0 : startTime + UNBOND_PERIOD;
    }

    /// @inheritdoc IPendlePTSlisBNBVaultAdapter
    function isClaimable(uint256 uuid) external view returns (bool) {
        if (_unstakeRequests[uuid].owner == address(0)) return false;
        // Lista gates claims on its bot-advanced confirmation pointer, not on elapsed time. Every request
        // the adapter creates is a post-upgrade ("new") request, claimable once uuid < nextConfirmedRequestUUID.
        return uuid < IListaStakeManager(LISTA_STAKE_MANAGER).nextConfirmedRequestUUID();
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                        INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Hands slisBNB to Lista, records the request (owner/amount/startTime), and emits UnstakeRequested.
     * @param pendleMarket Pendle market address (event context).
     * @param vTokenAmount Amount of vTokens redeemed (event context).
     * @param ptReceived Amount of PT redeemed (event context).
     * @param slisBnbAmount Amount of slisBNB to unstake via Lista.
     * @return uuid Lista withdrawal request identifier owned by msg.sender.
     * @dev Split out of requestWithdraw to avoid stack-too-deep.
     */
    function _enqueueUnstake(
        address pendleMarket,
        uint256 vTokenAmount,
        uint256 ptReceived,
        uint256 slisBnbAmount
    ) internal returns (uint256 uuid) {
        IERC20(SLIS_BNB).forceApprove(LISTA_STAKE_MANAGER, slisBnbAmount);
        IListaStakeManager(LISTA_STAKE_MANAGER).requestWithdraw(slisBnbAmount);
        IERC20(SLIS_BNB).forceApprove(LISTA_STAKE_MANAGER, 0);

        // The just-created request is the last element of the adapter's request array. Read it back and
        // record its actual Lista-recorded fields, so later reads never have to re-scan Lista's array.
        IListaStakeManager.WithdrawalRequest[] memory requests = IListaStakeManager(LISTA_STAKE_MANAGER)
            .getUserWithdrawalRequests(address(this));
        uint256 idx = requests.length - 1;
        IListaStakeManager.WithdrawalRequest memory request = requests[idx];
        uuid = request.uuid;

        // Snapshot the BNB Lista locked for this request now. Lista pays this fixed figure on claim (no
        // claim-time recompute), so it is the exact amount to forward even if the bot later claims the
        // request on the adapter's behalf via claimWithdrawFor (see claimUnstaked).
        (, uint256 amountInBnb) = IListaStakeManager(LISTA_STAKE_MANAGER).getUserRequestStatus(address(this), idx);

        _unstakeRequests[uuid] = UnstakeRequest({
            owner: msg.sender,
            amountInSnBnb: request.amountInSnBnb,
            amountInBnb: amountInBnb,
            startTime: request.startTime
        });
        _userUuids[msg.sender].push(uuid);

        emit UnstakeRequested(
            pendleMarket,
            msg.sender,
            uuid,
            vTokenAmount,
            ptReceived,
            slisBnbAmount,
            request.startTime,
            request.startTime + UNBOND_PERIOD
        );
    }

    /**
     * @notice Redeems PT 1:1 to slisBNB held by this adapter (post-maturity).
     * @param pt The Principal Token address to redeem.
     * @param yt The Yield Token address required for redemption.
     * @param ptBalance Amount of PT tokens to redeem.
     * @param minSlisBnbOut Minimum slisBNB to receive (slippage protection).
     * @return slisBnbAmount slisBNB delta received by the adapter.
     * @dev Receiver is the adapter (not the user). Uses a balance delta rather than the router
     *      return value to be robust against unexpected router behavior.
     *      Approves the router for PT, redeems, then resets approval to zero.
     */
    function _redeemPtToAdapter(
        address pt,
        address yt,
        uint256 ptBalance,
        uint256 minSlisBnbOut
    ) internal returns (uint256 slisBnbAmount) {
        TokenOutput memory output = TokenOutput({
            tokenOut: SLIS_BNB,
            minTokenOut: minSlisBnbOut,
            tokenRedeemSy: SLIS_BNB,
            pendleSwap: address(0),
            swapData: SwapData({ swapType: SwapType.NONE, extRouter: address(0), extCalldata: "", needScale: false })
        });

        uint256 balanceBefore = IERC20(SLIS_BNB).balanceOf(address(this));

        IERC20(pt).forceApprove(PENDLE_ROUTER, ptBalance);
        IPAllActionV3(PENDLE_ROUTER).redeemPyToToken(address(this), yt, ptBalance, output);
        IERC20(pt).forceApprove(PENDLE_ROUTER, 0);

        slisBnbAmount = IERC20(SLIS_BNB).balanceOf(address(this)) - balanceBefore;
    }

    /**
     * @notice Removes a uuid from a user's outstanding list via swap-pop.
     * @param user The owner whose list to mutate.
     * @param uuid The uuid to remove.
     */
    function _removeUserUuid(address user, uint256 uuid) internal {
        uint256[] storage uuids = _userUuids[user];
        uint256 length = uuids.length;
        for (uint256 i; i < length; ++i) {
            if (uuids[i] == uuid) {
                uuids[i] = uuids[length - 1];
                uuids.pop();
                return;
            }
        }
    }

    /**
     * @notice Finds the index of a uuid within a withdrawal-request array.
     * @param requests The adapter's live Lista withdrawal requests.
     * @param uuid The uuid to locate.
     * @return found True if a matching request is present (false once Lista has claimed/removed it).
     * @return idx Index of the matching request (zero when not found).
     * @dev Returns a flag instead of reverting so claimUnstaked can handle the bot-already-claimed case.
     */
    function _findRequestIndex(
        IListaStakeManager.WithdrawalRequest[] memory requests,
        uint256 uuid
    ) internal pure returns (bool found, uint256 idx) {
        uint256 length = requests.length;
        for (uint256 i; i < length; ++i) {
            if (requests[i].uuid == uuid) {
                return (true, i);
            }
        }
        return (false, 0);
    }
}
