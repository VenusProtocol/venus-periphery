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
 * @notice Read only views of SmartDCA plans, pairs and parameters, for the FE and the keeper.
 * @dev Stateless and not upgradeable; every view takes the SmartDCA to read. Token values use each yield source's
 *      stored rate, so they can trail the live value by the interest not accrued yet. Plan values follow the PRD,
 *      and each field's doc gives its PRD letter.
 */
contract SmartDCALens {
    /// @notice Plan status as shown to users. Matured is Active with every buy settled.
    enum PlanState {
        None,
        Active,
        Matured,
        Cancelled,
        Claimed
    }

    /// @notice Phase of a pair's next round: Open until its lock time, Locked until `startRound`, Executing until
    ///         `settleRound`
    enum PairState {
        Open,
        Locked,
        Executing
    }

    /**
     * @notice A plan and the values the FE shows for it. Stable values are in the stable's decimals.
     * @param owner Plan owner
     * @param pairId Pair the plan buys on
     * @param state Plan status
     * @param firstRound First round the plan bought in, before any top up
     * @param lastRound Round of the plan's last buy
     * @param inRunningRound True while the plan's buy is in a locked round that has not settled
     * @param totalBuys Buys in total, including those before a top up (PRD T)
     * @param buysSettled Buys that have settled (PRD C)
     * @param buysLeft Buys still to come, not counting a buy already running (PRD n)
     * @param stablePending Stable this plan has in the running round, after its fee; 0 outside a running round
     *        (PRD P)
     * @param stableWaiting Value of the plan's stable still waiting in the yield source (PRD W)
     * @param nextBuyStable Stable the next buy will sell, `stableWaiting / buysLeft` (PRD E). On the last buy it is
     *        all of `stableWaiting`, which includes under 60 wei of rounding left that the contract drops at claim.
     * @param principalPerBuy Principal in each buy (PRD B)
     * @param nextBuyFee Fee on the next buy, `max(0, nextBuyStable - principalPerBuy) * e` (PRD F). `e` is the fee
     *        rate when the round redeems more than its principal and 0 otherwise; for the pair's next round it is
     *        estimated from the pair's totals now.
     * @param nextBuyNet Next buy after its fee, `nextBuyStable * (1 - e) + principalPerBuy * e` (PRD N)
     * @param netWaiting `nextBuyNet * buysLeft` (PRD NW)
     * @param displayedWaiting Stable that will still be swapped, `netWaiting + stablePending` (PRD DW)
     * @param assetUnits Asset units bought and not yet paid out
     * @param assetValue `assetUnits` as an asset amount. A claim to Core pays vTokens instead, so the FE converts at
     *        the vToken's exchange rate to show that amount.
     */
    struct PlanView {
        address owner;
        uint32 pairId;
        PlanState state;
        uint32 firstRound;
        uint32 lastRound;
        bool inRunningRound;
        uint256 totalBuys;
        uint256 buysSettled;
        uint256 buysLeft;
        uint256 stablePending;
        uint256 stableWaiting;
        uint256 nextBuyStable;
        uint256 principalPerBuy;
        uint256 nextBuyFee;
        uint256 nextBuyNet;
        uint256 netWaiting;
        uint256 displayedWaiting;
        uint256 assetUnits;
        uint256 assetValue;
    }

    /**
     * @notice A pair and its next round
     * @param stable Token sold
     * @param asset Token bought
     * @param enabled Whether new plans and top ups are allowed
     * @param state Phase of the next round
     * @param round Next round, after skipping the empty rounds the next call would settle
     * @param lockTime Lock time of `round`
     * @param parts Parts the round is split into; 0 before `startRound`
     * @param partsDone Parts swapped
     * @param resplitUsed Whether the round was resplit
     * @param roundStableUnits Stable units the round sells
     * @param roundStableValue Value of `roundStableUnits` in the stable
     */
    struct PairView {
        address stable;
        address asset;
        bool enabled;
        PairState state;
        uint32 round;
        uint256 lockTime;
        uint8 parts;
        uint8 partsDone;
        bool resplitUsed;
        uint256 roundStableUnits;
        uint256 roundStableValue;
    }

    /// @notice SmartDCA's global parameters; see SmartDCA for each one
    struct Config {
        uint16 feeRateBps;
        uint16 maxSlippageBps;
        uint8 maxParts;
        uint8 minBuys;
        uint8 maxBuys;
        uint32 pairCount;
        address reserve;
        bool paused;
    }

    /// @dev Plan and pair fields `getPlan` needs, read once
    struct PlanContext {
        SmartDCA dca;
        ISmartDCA.Plan plan;
        ISmartDCA.Pair pair;
        uint32 nextRound;
        uint256 buysSettled;
    }

    /**
     * @notice A plan and the values the FE shows for it
     * @param dca SmartDCA to read
     * @param planId Plan id
     * @return v The plan; all zero for an unknown id
     */
    function getPlan(SmartDCA dca, uint256 planId) external view returns (PlanView memory v) {
        PlanContext memory c;
        c.dca = dca;
        c.plan = _plan(dca, planId);
        if (c.plan.status == ISmartDCA.PlanStatus.None) return v;
        c.pair = _pair(dca, c.plan.pairId);
        c.nextRound = c.pair.lastSettledRound + 1;
        c.buysSettled = SmartDCAMath.buysSettled(
            c.pair.lastSettledRound,
            c.plan.scheduleFirstRound,
            c.plan.scheduleBuys
        );

        ISmartDCA.Plan memory p = c.plan;
        v.owner = p.owner;
        v.pairId = p.pairId;
        // A top up moves `scheduleFirstRound` and `buysBeforeSchedule` forward by the same count
        v.firstRound = p.scheduleFirstRound - p.buysBeforeSchedule;
        v.lastRound = p.scheduleFirstRound + p.scheduleBuys - 1;
        v.totalBuys = p.buysBeforeSchedule + p.scheduleBuys;
        v.principalPerBuy = p.principalPerBuy;
        v.state = _planState(p.status, c.buysSettled == p.scheduleBuys);
        if (p.status == ISmartDCA.PlanStatus.Claimed) v.buysSettled = v.totalBuys;
        if (p.status == ISmartDCA.PlanStatus.Cancelled) v.buysSettled = p.buysBeforeSchedule;
        if (p.status != ISmartDCA.PlanStatus.Active) return v;

        v.buysSettled = p.buysBeforeSchedule + c.buysSettled;
        v.inRunningRound = SmartDCAMath.inRunningRound(
            c.nextRound,
            p.scheduleFirstRound,
            p.scheduleBuys,
            block.timestamp >= dca.roundStart(c.nextRound)
        );
        v.assetUnits = p.assetUnitsCarried + _assetUnitsFromIndex(dca, p, c.buysSettled) - p.assetUnitsPaid;
        v.assetValue = _value(dca, p.pairId, ISmartDCA.Side.Asset, v.assetUnits);

        // Stable units still waiting; a plan in a started round has already sold that round's units
        uint256 stableUnitsWaiting = p.scheduleStableUnits - p.stableUnitsPerBuy * c.buysSettled;
        uint256 buysLeft = p.scheduleBuys - c.buysSettled;
        if (v.inRunningRound) {
            ISmartDCA.Round memory r = _round(dca, p.pairId, c.nextRound);
            if (r.partsTotal != 0) {
                v.stablePending = _pending(p, r, c.pair.roundStableUnits);
                stableUnitsWaiting -= p.stableUnitsPerBuy;
                buysLeft -= 1;
            }
        }

        v.buysLeft = buysLeft;
        v.stableWaiting = _value(dca, p.pairId, ISmartDCA.Side.Stable, stableUnitsWaiting);
        if (buysLeft != 0) {
            v.nextBuyStable = buysLeft == 1
                ? v.stableWaiting
                : _value(dca, p.pairId, ISmartDCA.Side.Stable, p.stableUnitsPerBuy);
            uint32 nextBuyRound = p.scheduleFirstRound + uint32(p.scheduleBuys - buysLeft);
            uint256 e = _nextFeeRate(c, nextBuyRound, v.nextBuyStable, v.principalPerBuy);
            v.nextBuyFee = v.nextBuyStable > v.principalPerBuy
                ? ((v.nextBuyStable - v.principalPerBuy) * e) / SmartDCAMath.BPS
                : 0;
            v.nextBuyNet = (v.nextBuyStable * (SmartDCAMath.BPS - e) + v.principalPerBuy * e) / SmartDCAMath.BPS;
            v.netWaiting = v.nextBuyNet * buysLeft;
        }
        v.displayedWaiting = v.netWaiting + v.stablePending;
    }

    /**
     * @notice A pair and its next round
     * @param dca SmartDCA to read
     * @param pairId Pair id
     * @return v The pair; all zero for an unknown id
     */
    function getPair(SmartDCA dca, uint32 pairId) external view returns (PairView memory v) {
        ISmartDCA.Pair memory pair = _pair(dca, pairId);
        if (pair.stable == address(0)) return v;
        uint32 round = pair.lastSettledRound + 1;
        uint256 roundStableUnits = pair.roundStableUnits;
        // Rounds with nothing to buy settle on the next call to the pair; skip them as that call would
        while (roundStableUnits == 0 && block.timestamp >= dca.roundStart(round)) {
            roundStableUnits = _round(dca, pairId, round).stableUnitsJoining;
            ++round;
        }
        ISmartDCA.Round memory r = _round(dca, pairId, round);

        v.stable = pair.stable;
        v.asset = pair.asset;
        v.enabled = pair.enabled;
        v.round = round;
        v.lockTime = dca.roundStart(round);
        v.parts = r.partsTotal;
        v.partsDone = r.partsDone;
        v.resplitUsed = r.resplitUsed;
        v.roundStableUnits = roundStableUnits;
        v.roundStableValue = _value(dca, pairId, ISmartDCA.Side.Stable, roundStableUnits);
        if (r.partsTotal != 0) v.state = PairState.Executing;
        else if (block.timestamp >= v.lockTime) v.state = PairState.Locked;
    }

    /**
     * @notice SmartDCA's global parameters
     * @param dca SmartDCA to read
     * @return c Current values
     */
    function getConfig(SmartDCA dca) external view returns (Config memory c) {
        c.feeRateBps = dca.feeRateBps();
        c.maxSlippageBps = dca.maxSlippageBps();
        c.maxParts = dca.maxParts();
        c.minBuys = dca.minBuys();
        c.maxBuys = dca.maxBuys();
        c.pairCount = dca.pairCount();
        c.reserve = dca.reserve();
        c.paused = dca.paused();
    }

    /// @dev Asset units bought in the first `buysSettled` rounds of the plan's current schedule
    function _assetUnitsFromIndex(
        SmartDCA dca,
        ISmartDCA.Plan memory p,
        uint256 buysSettled
    ) internal view returns (uint256) {
        if (buysSettled == 0) return 0;
        ISmartDCA.Round memory before = _round(dca, p.pairId, p.scheduleFirstRound - 1);
        ISmartDCA.Round memory last = _round(dca, p.pairId, uint32(p.scheduleFirstRound + buysSettled - 1));
        return
            SmartDCAMath.assetUnitsBought(
                p.stableUnitsPerBuy,
                p.principalPerBuy,
                last.assetPerUnitIndexAfter - before.assetPerUnitIndexAfter,
                last.assetPerPrincipalIndexAfter - before.assetPerPrincipalIndexAfter
            );
    }

    /// @dev Token amount `units` of one side of a pair are worth, at the source's stored rate. Returns 0 while a
    ///      started round has redeemed every unit of the source, as the units it counts are no longer in it.
    function _value(SmartDCA dca, uint32 pairId, ISmartDCA.Side side, uint256 units) internal view returns (uint256) {
        if (units == 0) return 0;
        (ISmartDCA.SourceKind kind, address source, uint256 sharesHeld, uint256 unitsIssued) = dca.yieldSources(
            pairId,
            side
        );
        if (unitsIssued == 0) return 0;
        uint256 shares = Math.mulDiv(units, sharesHeld, unitsIssued);
        if (kind == ISmartDCA.SourceKind.Hub) return IHub(source).previewRedeem(shares);
        return Math.mulDiv(shares, IVToken(source).exchangeRateStored(), 1e18);
    }

    /// @dev Fee rate of the plan's next buy. Every plan in a round pays that round's one rate, so for the pair's
    ///      next round it is estimated from the pair's totals; a later round falls back to the plan's own values.
    function _nextFeeRate(
        PlanContext memory c,
        uint32 nextBuyRound,
        uint256 nextBuyStable,
        uint256 principalPerBuy
    ) internal view returns (uint256) {
        bool hasInterest = nextBuyRound == c.nextRound
            ? _value(c.dca, c.plan.pairId, ISmartDCA.Side.Stable, c.pair.roundStableUnits) > c.pair.roundPrincipal
            : nextBuyStable > principalPerBuy;
        return hasInterest ? c.dca.feeRateBps() : 0;
    }

    function _plan(SmartDCA dca, uint256 planId) internal view returns (ISmartDCA.Plan memory p) {
        (
            p.owner,
            p.pairId,
            p.status,
            p.scheduleBuys,
            p.buysBeforeSchedule,
            p.scheduleFirstRound,
            p.scheduleStableUnits,
            p.stableUnitsPerBuy,
            p.principalPerBuy,
            p.assetUnitsCarried,
            p.assetUnitsPaid
        ) = dca.plans(planId);
    }

    function _pair(SmartDCA dca, uint32 pairId) internal view returns (ISmartDCA.Pair memory p) {
        (
            p.stable,
            p.asset,
            p.enabled,
            p.lastSettledRound,
            p.lockEmittedRound,
            p.roundStableUnits,
            p.roundPrincipal,
            p.assetPerUnitIndex,
            p.assetPerPrincipalIndex
        ) = dca.pairs(pairId);
    }

    function _round(SmartDCA dca, uint32 pairId, uint32 round) internal view returns (ISmartDCA.Round memory r) {
        (
            r.partsTotal,
            r.partsDone,
            r.resplitUsed,
            r.feeRateBps,
            r.stableRedeemed,
            r.stableNet,
            r.stableToSwap,
            r.assetBought,
            r.stableUnitsJoining,
            r.principalJoining,
            r.stableUnitsEnding,
            r.principalEnding,
            r.assetPerUnitIndexAfter,
            r.assetPerPrincipalIndexAfter
        ) = dca.rounds(pairId, round);
    }

    /// @dev PRD P: `stableUnitsPerBuy * stableRedeemed / roundStableUnits * (1 - e) + principalPerBuy * e`, with `e`
    ///      the round's fee rate
    function _pending(
        ISmartDCA.Plan memory p,
        ISmartDCA.Round memory r,
        uint256 roundStableUnits
    ) internal pure returns (uint256) {
        uint256 fromUnits = Math.mulDiv(
            p.stableUnitsPerBuy * r.stableRedeemed,
            SmartDCAMath.BPS - r.feeRateBps,
            roundStableUnits * SmartDCAMath.BPS
        );
        return fromUnits + (p.principalPerBuy * r.feeRateBps) / SmartDCAMath.BPS;
    }

    function _planState(ISmartDCA.PlanStatus status, bool allSettled) internal pure returns (PlanState) {
        if (status == ISmartDCA.PlanStatus.Active) return allSettled ? PlanState.Matured : PlanState.Active;
        if (status == ISmartDCA.PlanStatus.Cancelled) return PlanState.Cancelled;
        if (status == ISmartDCA.PlanStatus.Claimed) return PlanState.Claimed;
        return PlanState.None;
    }
}
