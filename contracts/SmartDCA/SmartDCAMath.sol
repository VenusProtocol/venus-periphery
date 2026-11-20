// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title SmartDCAMath
 * @author Venus
 * @notice Pure math for SmartDCA: round dates, the round fee and the index steps that credit plans.
 * @dev A month is counted as `year * 12 + (month - 1)`, so November 2026 is month 24322. Round `r` is month
 *      `anchorMonth + r`, where `anchorMonth` is set once at deploy. It starts (locks) on the 15th of that month at
 *      00:00 UTC+8, which is the 14th at 16:00 UTC. Fees, index steps and bought amounts round down, in favour of the
 *      contract.
 */
library SmartDCAMath {
    /// @notice Day of the month a round starts on
    uint256 internal constant ROUND_DAY = 15;

    /// @notice Rounds start at 00:00 UTC+8, this long before 00:00 UTC
    uint256 internal constant UTC8_OFFSET = 8 hours;

    /// @notice Scale of the asset indexes, 1e36 like the Venus reward indexes
    uint256 internal constant INDEX_SCALE = 1e36;

    /// @notice Basis points in 100%
    uint256 internal constant BPS = 10_000;

    /**
     * @notice Start (lock) time of a round: the `ROUND_DAY` of its month at 00:00 UTC+8
     * @param anchorMonth Month of round 0
     * @param round Round number
     * @return Unix timestamp
     */
    function roundStart(uint256 anchorMonth, uint32 round) internal pure returns (uint256) {
        uint256 m = anchorMonth + round;
        return _daysFromCivil(m / 12, (m % 12) + 1, ROUND_DAY) * 1 days - UTC8_OFFSET;
    }

    /**
     * @notice Month of the latest round start at or before `timestamp`
     * @dev Moving `timestamp` back by `ROUND_DAY - 1` days less `UTC8_OFFSET` lands in that month. Sets `anchorMonth`
     *      at deploy, and a new pair's last settled round, so its first round is the next to start.
     * @param timestamp Unix timestamp, at least `(ROUND_DAY - 1) days - UTC8_OFFSET`
     * @return Month, counted as `year * 12 + (month - 1)`
     */
    function latestStartedMonth(uint256 timestamp) internal pure returns (uint256) {
        uint256 shift = (ROUND_DAY - 1) * 1 days - UTC8_OFFSET;
        (uint256 year, uint256 month) = _civilFromDays((timestamp - shift) / 1 days);
        return year * 12 + month - 1;
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
     * @param nextRoundStarted Whether the next round's start time has passed
     * @return True while the plan's buy is in a locked round that has not settled
     */
    function inRunningRound(
        uint32 nextRound,
        uint32 firstRound,
        uint8 buys,
        bool nextRoundStarted
    ) internal pure returns (bool) {
        return nextRoundStarted && nextRound >= firstRound && nextRound < firstRound + buys;
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
