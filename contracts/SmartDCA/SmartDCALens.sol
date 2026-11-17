// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { SmartDCAMath } from "./SmartDCAMath.sol";
import { IHub } from "../CollateralGateway/IHub.sol";
import { IVToken } from "../Interfaces/IVToken.sol";
import { ISmartDCA } from "./ISmartDCA.sol";
import { SmartDCA } from "./SmartDCA.sol";

/**
 * @title SmartDCALens
 * @author Venus
 * @notice Read only views of SmartDCA plans, pairs and parameters for the FE and the keeper
 * @dev Stateless and not upgradeable; every view takes the SmartDCA to read. Values use the sources' stored rates, so they can trail the
 *      live value by the interest not yet accrued. The PRD names are used for plan values:
 *      - T: buys chosen at creation. C: buys settled. n: buys still waiting.
 *      - P: stable this plan put into the running round, after its fee (0 outside a round).
 *      - W: value of the stable still waiting. E: stable the next buy will sell, `W / n`.
 *      - B: base, the stable put into each buy. e: the round's fee rate, `feeRate` when the round redeems more
 *        than its bases and 0 otherwise. For the pair's next round it is estimated from the pair's totals now.
 *      - F: fee on the next buy, `max(0, E - B) x e`. N: next buy after the fee, `E x (1 - e) + B x e`.
 *        NW: `N x n`. DW: `NW + P`, the stable that will be swapped.
 */
contract SmartDCALens {
    /// @notice Plan status as shown to users; Matured is Active with every buy settled
    enum PlanState {
        None,
        Active,
        Matured,
        Cancelled,
        Done
    }

    /// @notice Pair phase: Open until its lock time, Locked until `startBuy`, Executing until `settle`
    enum PairState {
        Open,
        Locked,
        Executing
    }

    /// @notice A plan with its PRD values
    struct PlanView {
        address owner;
        uint32 pairId;
        PlanState state;
        uint32 firstRound;
        uint32 lastRound;
        bool inRunningRound;
        uint256 T;
        uint256 C;
        uint256 n;
        uint256 P;
        uint256 W;
        uint256 E;
        uint256 B;
        uint256 F;
        uint256 N;
        uint256 NW;
        uint256 DW;
        uint256 boughtUnits;
        uint256 bought;
    }

    /// @notice A pair and its running round
    struct PairView {
        address stable;
        address asset;
        bool enabled;
        PairState state;
        uint32 round;
        uint256 lockTime;
        uint256 backupTime;
        uint8 parts;
        uint8 partsDone;
        bool resplitUsed;
        uint256 dueUnits;
        uint256 dueValue;
    }

    /// @notice Global parameters
    struct Config {
        uint16 feeRate;
        uint16 maxSlippage;
        uint8 maxSplitN;
        uint8 minBuys;
        uint8 maxBuys;
        uint32 backupDelay;
        uint32 pairCount;
        address reserve;
        bool paused;
    }

    /// @dev Plan and round fields the views need, read once
    struct PlanCtx {
        SmartDCA dca;
        ISmartDCA.Plan plan;
        ISmartDCA.Pair pair;
        uint32 openRound;
        uint256 roundsDone;
    }

    /**
     * @notice A plan with its PRD values
     * @param dca SmartDCA to read
     * @param planId Plan id
     * @return v The plan; all zero for an unknown id
     */
    function getPlan(SmartDCA dca, uint256 planId) external view returns (PlanView memory v) {
        PlanCtx memory c;
        c.dca = dca;
        c.plan = _plan(dca, planId);
        if (c.plan.status == ISmartDCA.PlanStatus.None) return v;
        c.pair = _pair(dca, c.plan.pairId);
        c.openRound = c.pair.lastSettledRound + 1;
        c.roundsDone = SmartDCAMath.roundsDone(c.pair.lastSettledRound, c.plan.firstRound, c.plan.buys);

        ISmartDCA.Plan memory p = c.plan;
        v.owner = p.owner;
        v.pairId = p.pairId;
        // topUp moves `firstRound` and `buysDone` forward by the same count
        v.firstRound = p.firstRound - p.buysDone;
        v.lastRound = p.firstRound + p.buys - 1;
        v.T = p.buysDone + p.buys;
        v.B = p.base;
        v.state = _planState(p.status, c.roundsDone == p.buys);
        if (p.status == ISmartDCA.PlanStatus.Done) v.C = v.T;
        if (p.status == ISmartDCA.PlanStatus.Cancelled) v.C = p.buysDone;
        if (p.status != ISmartDCA.PlanStatus.Active) return v;

        v.C = p.buysDone + c.roundsDone;
        v.inRunningRound = SmartDCAMath.inRunningRound(c.openRound, p.firstRound, p.buys, block.timestamp);
        v.boughtUnits = p.carriedBought + _indexBought(dca, p, c.roundsDone) - p.withdrawnBought;
        v.bought = _value(dca, c.pair.asset, v.boughtUnits);

        // Stable units still waiting; a plan in an executing round has already sold that round's slice
        uint256 waiting = p.stableUnits - p.slice * c.roundsDone;
        uint256 left = p.buys - c.roundsDone;
        if (v.inRunningRound) {
            ISmartDCA.Round memory r = _round(dca, p.pairId, c.openRound);
            if (r.partsTotal != 0) {
                v.P = _pending(p, r, c.pair.dueUnits);
                waiting -= p.slice;
                left -= 1;
            }
        }

        v.n = left;
        v.W = _value(dca, c.pair.stable, waiting);
        if (left != 0) {
            v.E = left == 1 ? v.W : _value(dca, c.pair.stable, p.slice);
            uint256 e = _nextFeeRate(c, p.firstRound + uint32(p.buys - left), v.E, v.B);
            v.F = v.E > v.B ? ((v.E - v.B) * e) / SmartDCAMath.BPS : 0;
            v.N = (v.E * (SmartDCAMath.BPS - e) + v.B * e) / SmartDCAMath.BPS;
            v.NW = v.N * left;
        }
        v.DW = v.NW + v.P;
    }

    /**
     * @notice A pair and its running round
     * @param dca SmartDCA to read
     * @param pairId Pair id
     * @return v The pair; all zero for an unknown id
     */
    function getPair(SmartDCA dca, uint32 pairId) external view returns (PairView memory v) {
        ISmartDCA.Pair memory pair = _pair(dca, pairId);
        if (pair.stable == address(0)) return v;
        uint32 round = pair.lastSettledRound + 1;
        uint256 dueUnits = pair.dueUnits;
        // Rounds with nothing due settle on the next call to the pair; skip them as that call would
        while (dueUnits == 0 && block.timestamp >= SmartDCAMath.roundStart(round)) {
            dueUnits = _round(dca, pairId, round).sliceStarting;
            ++round;
        }
        ISmartDCA.Round memory r = _round(dca, pairId, round);

        v.stable = pair.stable;
        v.asset = pair.asset;
        v.enabled = pair.enabled;
        v.round = round;
        v.lockTime = SmartDCAMath.roundStart(round);
        v.backupTime = v.lockTime + dca.backupDelay();
        v.parts = r.partsTotal;
        v.partsDone = r.partsDone;
        v.resplitUsed = r.resplitUsed;
        v.dueUnits = dueUnits;
        v.dueValue = _value(dca, pair.stable, dueUnits);
        if (r.partsTotal != 0) v.state = PairState.Executing;
        else if (block.timestamp >= v.lockTime) v.state = PairState.Locked;
    }

    /// @notice Global parameters
    /// @param dca SmartDCA to read
    /// @return c Current values
    function getConfig(SmartDCA dca) external view returns (Config memory c) {
        c.feeRate = dca.feeRate();
        c.maxSlippage = dca.maxSlippage();
        c.maxSplitN = dca.maxSplitN();
        c.minBuys = dca.minBuys();
        c.maxBuys = dca.maxBuys();
        c.backupDelay = dca.backupDelay();
        c.pairCount = dca.pairCount();
        c.reserve = dca.reserve();
        c.paused = dca.paused();
    }

    /// @dev P = slice x stableOut / dueUnits x (1 - e) + base x e, with e the round's fee rate
    function _pending(
        ISmartDCA.Plan memory p,
        ISmartDCA.Round memory r,
        uint256 dueUnits
    ) internal pure returns (uint256) {
        uint256 bySlice = Math.mulDiv(p.slice * r.stableOut, SmartDCAMath.BPS - r.feeRate, dueUnits * SmartDCAMath.BPS);
        return bySlice + (p.base * r.feeRate) / SmartDCAMath.BPS;
    }

    function _indexBought(SmartDCA dca, ISmartDCA.Plan memory p, uint256 roundsDone) internal view returns (uint256) {
        if (roundsDone == 0) return 0;
        ISmartDCA.Round memory before = _round(dca, p.pairId, p.firstRound - 1);
        ISmartDCA.Round memory last = _round(dca, p.pairId, uint32(p.firstRound + roundsDone - 1));
        return
            SmartDCAMath.planBought(
                p.slice,
                p.base,
                last.cumIndexAfter - before.cumIndexAfter,
                last.cumBaseIndexAfter - before.cumBaseIndexAfter
            );
    }

    /// @dev Token value of `units` of `token`, at the source's stored rate
    function _value(SmartDCA dca, address token, uint256 units) internal view returns (uint256) {
        if (units == 0) return 0;
        (ISmartDCA.SourceKind kind, address source, uint256 shares, uint256 totalUnits) = dca.sources(token);
        uint256 sourceShares = Math.mulDiv(units, shares, totalUnits);
        if (kind == ISmartDCA.SourceKind.Hub) return IHub(source).previewRedeem(sourceShares);
        return Math.mulDiv(sourceShares, IVToken(source).exchangeRateStored(), 1e18);
    }

    /// @dev Fee rate of the plan's next buy. Every plan in a round pays that round's one rate, so for the pair's
    ///      next round it is estimated from the pair's totals; a later round falls back to the plan's own values.
    function _nextFeeRate(PlanCtx memory c, uint32 nextRound, uint256 E, uint256 B) internal view returns (uint256) {
        bool hasInterest = nextRound == c.openRound
            ? _value(c.dca, c.pair.stable, c.pair.dueUnits) > c.pair.dueBase
            : E > B;
        return hasInterest ? c.dca.feeRate() : 0;
    }

    function _planState(ISmartDCA.PlanStatus status, bool allSettled) internal pure returns (PlanState) {
        if (status == ISmartDCA.PlanStatus.Active) return allSettled ? PlanState.Matured : PlanState.Active;
        if (status == ISmartDCA.PlanStatus.Cancelled) return PlanState.Cancelled;
        if (status == ISmartDCA.PlanStatus.Done) return PlanState.Done;
        return PlanState.None;
    }

    function _plan(SmartDCA dca, uint256 planId) internal view returns (ISmartDCA.Plan memory p) {
        (
            p.owner,
            p.pairId,
            p.status,
            p.buys,
            p.buysDone,
            p.firstRound,
            p.stableUnits,
            p.slice,
            p.base,
            p.carriedBought,
            p.withdrawnBought
        ) = dca.plans(planId);
    }

    function _pair(SmartDCA dca, uint32 pairId) internal view returns (ISmartDCA.Pair memory p) {
        (
            p.stable,
            p.asset,
            p.enabled,
            p.lastSettledRound,
            p.lockEnteredRound,
            p.dueUnits,
            p.dueBase,
            p.cumIndex,
            p.cumBaseIndex
        ) = dca.pairs(pairId);
    }

    function _round(SmartDCA dca, uint32 pairId, uint32 round) internal view returns (ISmartDCA.Round memory r) {
        (
            r.partsTotal,
            r.partsDone,
            r.resplitUsed,
            r.feeRate,
            r.stableOut,
            r.net,
            r.toSwap,
            r.amountOut,
            r.sliceStarting,
            r.baseStarting,
            r.sliceEnding,
            r.baseEnding,
            r.cumIndexAfter,
            r.cumBaseIndexAfter
        ) = dca.rounds(pairId, round);
    }
}
