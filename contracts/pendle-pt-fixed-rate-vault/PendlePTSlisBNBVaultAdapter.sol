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

    /// @notice Lista withdrawal request uuid → owner who may receive the unbonded BNB.
    mapping(uint256 => address) public unstakeOwner;

    /// @dev Owner → list of their outstanding unstake request uuids (compacted via swap-pop on claim).
    mapping(address => uint256[]) internal _userUuids;

    /// @dev Reserved storage gap for future upgrades of the child.
    uint256[49] private __gap;

    // ═══════════════════════════════════════════════════════════════════════
    //                            CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════

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

    /**
     * @notice Hands slisBNB to Lista, records uuid → msg.sender, and emits UnstakeRequested.
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

        // The just-created request is the last element of the adapter's request array.
        IListaStakeManager.WithdrawalRequest[] memory requests = IListaStakeManager(LISTA_STAKE_MANAGER)
            .getUserWithdrawalRequests(address(this));
        IListaStakeManager.WithdrawalRequest memory request = requests[requests.length - 1];
        uuid = request.uuid;

        unstakeOwner[uuid] = msg.sender;
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

    /// @inheritdoc IPendlePTSlisBNBVaultAdapter
    // Intentionally NOT whenNotPaused: funds must never be trapped by an emergency pause.
    function claimUnstaked(uint256 uuid) external nonReentrant {
        address user = unstakeOwner[uuid];
        if (user == address(0)) revert UnstakeRequestNotFound(uuid);

        // Resolve the live index fresh — Lista compacts its array (swap-pop) on every claim.
        IListaStakeManager.WithdrawalRequest[] memory requests = IListaStakeManager(LISTA_STAKE_MANAGER)
            .getUserWithdrawalRequests(address(this));
        uint256 idx = _findRequestIndex(requests, uuid);

        // Effects before interactions (CEI).
        delete unstakeOwner[uuid];
        _removeUserUuid(user, uuid);

        // Interaction: claim from Lista (BNB lands on the adapter), then forward to the owner.
        uint256 balanceBefore = address(this).balance;
        IListaStakeManager(LISTA_STAKE_MANAGER).claimWithdraw(idx);
        uint256 bnbOut = address(this).balance - balanceBefore;

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
    function getUnstakeRequest(
        uint256 uuid
    ) external view returns (address user, uint256 amountInSnBnb, uint256 startTime, uint256 claimableAt) {
        user = unstakeOwner[uuid];
        IListaStakeManager.WithdrawalRequest[] memory requests = IListaStakeManager(LISTA_STAKE_MANAGER)
            .getUserWithdrawalRequests(address(this));
        uint256 length = requests.length;
        for (uint256 i; i < length; ++i) {
            if (requests[i].uuid == uuid) {
                amountInSnBnb = requests[i].amountInSnBnb;
                startTime = requests[i].startTime;
                claimableAt = startTime + UNBOND_PERIOD;
                break;
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                        INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════════

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
     * @notice Finds the index of a uuid within a withdrawal-request array.
     * @param requests The adapter's live Lista withdrawal requests.
     * @param uuid The uuid to locate.
     * @return idx Index of the matching request.
     * @dev Reverts with UnstakeRequestNotFound if no entry matches (e.g. already claimed on Lista).
     */
    function _findRequestIndex(
        IListaStakeManager.WithdrawalRequest[] memory requests,
        uint256 uuid
    ) internal pure returns (uint256 idx) {
        uint256 length = requests.length;
        for (uint256 i; i < length; ++i) {
            if (requests[i].uuid == uuid) {
                return i;
            }
        }
        revert UnstakeRequestNotFound(uuid);
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
}
