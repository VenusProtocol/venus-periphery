// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title SmartDCAMath
 * @author Venus
 * @notice Pure math for SmartDCA: round dates, the round fee and the index steps that credit plans.
 * @dev The calendar functions give a pair's first round: month `r` counted from January 1970,
 *      `(year - 1970) * 12 + (month - 1)`, locks on the 15th at 00:00 UTC+8, which is the 14th at 16:00 UTC. For
 *      example November 2026 is month 682. Later rounds count on from it, one per `buyInterval`. Fees, index steps
 *      and bought amounts round down, in favour of the contract.
 */
library SmartDCAMath {
    /// @notice Time from the 1st of a month at 00:00 UTC to its lock time, the 14th at 16:00 UTC
    uint256 internal constant LOCK_OFFSET = 13 days + 16 hours;

    /// @notice Scale of the asset indexes, 1e36 like the Venus reward indexes
    uint256 internal constant INDEX_SCALE = 1e36;

    /// @notice Basis points in 100%
    uint256 internal constant BPS = 10_000;

    /**
     * @notice Lock time of a round: the 15th of its month at 00:00 UTC+8
     * @param round Round number
     * @return Unix timestamp
     */
    function lockTimeOf(uint32 round) internal pure returns (uint256) {
        uint256 year = 1970 + round / 12;
        uint256 month = (round % 12) + 1;
        return _daysFromCivil(year, month, 1) * 1 days + LOCK_OFFSET;
    }

    /**
     * @notice Latest round whose lock time is at or before `timestamp`
     * @dev A new pair starts with this round as its last settled one, so its first round is the next to lock
     * @param timestamp Unix timestamp, at least `LOCK_OFFSET`
     * @return Round number
     */
    function latestLockedRound(uint256 timestamp) internal pure returns (uint32) {
        (uint256 year, uint256 month) = _civilFromDays((timestamp - LOCK_OFFSET) / 1 days);
        return uint32((year - 1970) * 12 + month - 1);
    }

    /**
     * @notice Fee a round takes on the interest part of what it redeemed
     * @param stableRedeemed Stable amount the round redeemed
     * @param roundPrincipal Principal of the round's plans
     * @param feeRateBps Fee rate, in basis points
     * @return fee Stable amount for the Reserve
     * @return rateCharged `feeRateBps`, or 0 when the round redeemed no more than its principal
     */
    function roundFee(
        uint256 stableRedeemed,
        uint256 roundPrincipal,
        uint16 feeRateBps
    ) internal pure returns (uint256 fee, uint16 rateCharged) {
        if (stableRedeemed <= roundPrincipal) return (0, 0);
        return (((stableRedeemed - roundPrincipal) * feeRateBps) / BPS, feeRateBps);
    }

    /**
     * @notice Index steps that split a round's asset units over its plans
     * @dev With `e = rateBps / BPS`, a plan's share of the round's net stable is
     *      `stableUnitsPerBuy * stableRedeemed / roundStableUnits * (1 - e) + principalPerBuy * e`, so it pays the fee
     *      on its own interest only. Summed over the round's plans that is `stableNet`. Splitting `assetUnits` in the
     *      same ratio gives a plan
     *      `stableUnitsPerBuy * perUnitStep / INDEX_SCALE + principalPerBuy * perPrincipalStep / INDEX_SCALE`.
     * @param assetUnits Asset units minted for what the round bought
     * @param stableRedeemed Stable amount the round redeemed
     * @param stableNet `stableRedeemed` less the fee
     * @param roundStableUnits Stable units the round sold
     * @param rateBps Fee rate the round charged, in basis points
     * @return perUnitStep Asset units per stable unit sold, scaled by `INDEX_SCALE`
     * @return perPrincipalStep Asset units per wei of principal, scaled by `INDEX_SCALE`
     */
    function roundIndexSteps(
        uint256 assetUnits,
        uint256 stableRedeemed,
        uint256 stableNet,
        uint256 roundStableUnits,
        uint16 rateBps
    ) internal pure returns (uint256 perUnitStep, uint256 perPrincipalStep) {
        uint256 scaled = assetUnits * INDEX_SCALE;
        perUnitStep = Math.mulDiv(scaled, stableRedeemed * (BPS - rateBps), roundStableUnits * stableNet * BPS);
        perPrincipalStep = Math.mulDiv(scaled, rateBps, stableNet * BPS);
    }

    /**
     * @notice Buys of a plan's schedule that have settled
     * @param lastSettledRound Pair's last settled round
     * @param firstRound First round of the schedule
     * @param buys Buys in the schedule
     * @return Settled buys, at most `buys`
     */
    function buysSettled(uint32 lastSettledRound, uint32 firstRound, uint8 buys) internal pure returns (uint8) {
        if (lastSettledRound < firstRound) return 0;
        uint256 settled = lastSettledRound - firstRound + 1;
        return settled > buys ? buys : uint8(settled);
    }

    /**
     * @notice Whether a plan is in the pair's next round and that round's lock time has passed
     * @param nextRound Pair's next round, `lastSettledRound + 1`
     * @param firstRound First round of the plan's schedule
     * @param buys Buys in the schedule
     * @param nextRoundLocked Whether the next round's lock time has passed
     * @return True while the plan's buy is in a locked round that has not settled
     */
    function inRunningRound(
        uint32 nextRound,
        uint32 firstRound,
        uint8 buys,
        bool nextRoundLocked
    ) internal pure returns (bool) {
        return nextRoundLocked && nextRound >= firstRound && nextRound < firstRound + buys;
    }

    /**
     * @notice Asset units a plan bought between two index readings
     * @param stableUnitsPerBuy Plan's stable units per buy
     * @param principalPerBuy Plan's principal per buy
     * @param perUnitIndexGrowth Growth of `assetPerUnitIndex` over the plan's settled rounds
     * @param perPrincipalIndexGrowth Growth of `assetPerPrincipalIndex` over the same rounds
     * @return Asset units, rounded down
     */
    function assetUnitsBought(
        uint256 stableUnitsPerBuy,
        uint256 principalPerBuy,
        uint256 perUnitIndexGrowth,
        uint256 perPrincipalIndexGrowth
    ) internal pure returns (uint256) {
        return
            Math.mulDiv(stableUnitsPerBuy, perUnitIndexGrowth, INDEX_SCALE) +
            Math.mulDiv(principalPerBuy, perPrincipalIndexGrowth, INDEX_SCALE);
    }

    /// @dev Days from 1970-01-01 to a date. Howard Hinnant's algorithm, for years from 1970.
    function _daysFromCivil(uint256 year, uint256 month, uint256 day) private pure returns (uint256) {
        if (month <= 2) year -= 1;
        uint256 era = year / 400;
        uint256 yoe = year - era * 400;
        uint256 doy = (153 * (month > 2 ? month - 3 : month + 9) + 2) / 5 + day - 1;
        uint256 doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        return era * 146_097 + doe - 719_468;
    }

    /// @dev Year and month of a day count from 1970-01-01. Inverse of `_daysFromCivil`.
    function _civilFromDays(uint256 z) private pure returns (uint256 year, uint256 month) {
        z += 719_468;
        uint256 era = z / 146_097;
        uint256 doe = z - era * 146_097;
        uint256 yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        uint256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        uint256 mp = (5 * doy + 2) / 153;
        month = mp < 10 ? mp + 3 : mp - 9;
        year = yoe + era * 400 + (month <= 2 ? 1 : 0);
    }
}
