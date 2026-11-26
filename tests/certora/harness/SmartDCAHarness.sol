// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

import { SmartDCA } from "../../../contracts/SmartDCA/SmartDCA.sol";
import { SmartDCAAdminLib } from "../../../contracts/SmartDCA/SmartDCAAdminLib.sol";
import { SmartDCAMath } from "../../../contracts/SmartDCA/SmartDCAMath.sol";

/// @notice SmartDCA with one-field getters for the Certora specs. Sides and statuses are passed and returned as
///         uint8 (Stable 0, Asset 1; None 0, Active 1, Cancelled 2, Claimed 3).
contract SmartDCAHarness is SmartDCA {
    constructor(
        address comptroller,
        address hubRegistry,
        address oracle,
        address swapHelper
    ) SmartDCA(comptroller, hubRegistry, oracle, swapHelper) {}

    // Calls that change state, only for the units rules; the other rules filter them out

    function depositH(uint32 pairId, uint8 side, uint256 amount) external returns (uint256) {
        Pair storage pair = pairs[pairId];
        address token = side == 0 ? pair.stable : pair.asset;
        return _deposit(yieldSources[pairId][Side(side)], token, amount);
    }

    function burnUnitsH(uint32 pairId, uint8 side, uint256 units) external returns (uint256) {
        return _burnUnits(yieldSources[pairId][Side(side)], units);
    }

    // Yield sources

    function sourceShares(uint32 pairId, uint8 side) external view returns (uint256) {
        return yieldSources[pairId][Side(side)].sharesHeld;
    }

    function sourceUnits(uint32 pairId, uint8 side) external view returns (uint256) {
        return yieldSources[pairId][Side(side)].unitsIssued;
    }

    function sourceAddr(uint32 pairId, uint8 side) external view returns (address) {
        return yieldSources[pairId][Side(side)].sourceAddress;
    }

    function sourceKind(uint32 pairId, uint8 side) external view returns (uint8) {
        return uint8(yieldSources[pairId][Side(side)].kind);
    }

    // Pairs

    function pairStable(uint32 pairId) external view returns (address) {
        return pairs[pairId].stable;
    }

    function pairAsset(uint32 pairId) external view returns (address) {
        return pairs[pairId].asset;
    }

    function lastSettled(uint32 pairId) external view returns (uint32) {
        return pairs[pairId].lastSettledRound;
    }

    function roundStableUnits(uint32 pairId) external view returns (uint256) {
        return pairs[pairId].roundStableUnits;
    }

    function roundPrincipal(uint32 pairId) external view returns (uint256) {
        return pairs[pairId].roundPrincipal;
    }

    function pairEnabled(uint32 pairId) external view returns (bool) {
        return pairs[pairId].enabled;
    }

    function pairUnitIndex(uint32 pairId) external view returns (uint256) {
        return pairs[pairId].assetPerUnitIndex;
    }

    function pairPrincipalIndex(uint32 pairId) external view returns (uint256) {
        return pairs[pairId].assetPerPrincipalIndex;
    }

    // Rounds

    function roundPartsTotal(uint32 pairId, uint32 round) external view returns (uint8) {
        return rounds[pairId][round].partsTotal;
    }

    function roundStableRedeemed(uint32 pairId, uint32 round) external view returns (uint256) {
        return rounds[pairId][round].stableRedeemed;
    }

    function roundStableNet(uint32 pairId, uint32 round) external view returns (uint256) {
        return rounds[pairId][round].stableNet;
    }

    function roundUnitsJoining(uint32 pairId, uint32 round) external view returns (uint256) {
        return rounds[pairId][round].stableUnitsJoining;
    }

    function roundUnitsEnding(uint32 pairId, uint32 round) external view returns (uint256) {
        return rounds[pairId][round].stableUnitsEnding;
    }

    function roundPrincipalJoining(uint32 pairId, uint32 round) external view returns (uint256) {
        return rounds[pairId][round].principalJoining;
    }

    function roundPrincipalEnding(uint32 pairId, uint32 round) external view returns (uint256) {
        return rounds[pairId][round].principalEnding;
    }

    function roundPartsDone(uint32 pairId, uint32 round) external view returns (uint8) {
        return rounds[pairId][round].partsDone;
    }

    function roundStableToSwap(uint32 pairId, uint32 round) external view returns (uint256) {
        return rounds[pairId][round].stableToSwap;
    }

    function roundAssetBought(uint32 pairId, uint32 round) external view returns (uint256) {
        return rounds[pairId][round].assetBought;
    }

    function roundUnitIndexAfter(uint32 pairId, uint32 round) external view returns (uint256) {
        return rounds[pairId][round].assetPerUnitIndexAfter;
    }

    function roundPrincipalIndexAfter(uint32 pairId, uint32 round) external view returns (uint256) {
        return rounds[pairId][round].assetPerPrincipalIndexAfter;
    }

    // Plans

    function planOwner(uint256 planId) external view returns (address) {
        return plans[planId].owner;
    }

    function planPair(uint256 planId) external view returns (uint32) {
        return plans[planId].pairId;
    }

    function planStatus(uint256 planId) external view returns (uint8) {
        return uint8(plans[planId].status);
    }

    function planBuys(uint256 planId) external view returns (uint8) {
        return plans[planId].scheduleBuys;
    }

    function planFirstRound(uint256 planId) external view returns (uint32) {
        return plans[planId].scheduleFirstRound;
    }

    function planScheduleUnits(uint256 planId) external view returns (uint256) {
        return plans[planId].scheduleStableUnits;
    }

    function planUnitsPerBuy(uint256 planId) external view returns (uint256) {
        return plans[planId].stableUnitsPerBuy;
    }

    function planPrincipalPerBuy(uint256 planId) external view returns (uint256) {
        return plans[planId].principalPerBuy;
    }

    function planPaid(uint256 planId) external view returns (uint256) {
        return plans[planId].assetUnitsPaid;
    }

    function planCarried(uint256 planId) external view returns (uint256) {
        return plans[planId].assetUnitsCarried;
    }

    // Computed values

    function assetUnitsOwed(uint256 planId) external view returns (uint256) {
        Plan storage plan = plans[planId];
        return _assetUnitsOwed(plan, pairs[plan.pairId]);
    }

    function buysSettledOf(uint256 planId) external view returns (uint8) {
        Plan storage plan = plans[planId];
        return _buysSettled(plan, pairs[plan.pairId]);
    }

    /// @dev Whether the plan is in its pair's running round at this block's time
    function inRunningRoundOf(uint256 planId) external view returns (bool) {
        Plan storage plan = plans[planId];
        return _inRunningRound(plan, pairs[plan.pairId]);
    }

    /// @dev What `sweepToken` treats as owed for `token`
    function owedIn(address token) external view returns (uint256) {
        return SmartDCAAdminLib.owedInToken(pairs, rounds, yieldSources, pairCount, token);
    }

    /// @dev Asset units two plans are credited from one round, read through the same index math the contract uses
    function twoPlansCredit(
        uint256 assetUnits,
        uint256 stableRedeemed,
        uint256 stableNet,
        uint16 rateBps,
        uint256 unitsA,
        uint256 principalA,
        uint256 unitsB,
        uint256 principalB
    ) external pure returns (uint256) {
        (uint256 perUnitStep, uint256 perPrincipalStep) = SmartDCAMath.roundIndexSteps(
            assetUnits,
            stableRedeemed,
            stableNet,
            unitsA + unitsB,
            rateBps
        );
        return
            SmartDCAMath.assetUnitsBought(unitsA, principalA, perUnitStep, perPrincipalStep) +
            SmartDCAMath.assetUnitsBought(unitsB, principalB, perUnitStep, perPrincipalStep);
    }

    /// @dev Asset units one plan is credited from a round with the given totals
    function planCredit(
        uint256 assetUnits,
        uint256 stableRedeemed,
        uint256 stableNet,
        uint256 roundUnits,
        uint16 rateBps,
        uint256 units,
        uint256 principal
    ) external pure returns (uint256) {
        (uint256 perUnitStep, uint256 perPrincipalStep) = SmartDCAMath.roundIndexSteps(
            assetUnits,
            stableRedeemed,
            stableNet,
            roundUnits,
            rateBps
        );
        return SmartDCAMath.assetUnitsBought(units, principal, perUnitStep, perPrincipalStep);
    }

    function roundFeeOf(uint256 stableRedeemed, uint256 roundPrincipal_, uint16 rateBps) external pure returns (uint256) {
        (uint256 fee, ) = SmartDCAMath.roundFee(stableRedeemed, roundPrincipal_, rateBps);
        return fee;
    }
}
