// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title SmartDCAMath
 * @author Venus
 * @notice Pure math for SmartDCA: round dates, the round fee and index steps.
 * @dev A round is a month, numbered as months since January 1970: `(year - 1970) * 12 + (month - 1)`.
 *      Round `r` locks on the 15th of its month at 00:00 UTC+8, which is the 14th at 16:00 UTC.
 *      Fees, index steps and bought amounts round down, in favour of the contract.
 */
library SmartDCAMath {
    /// @notice Time from the 1st of a month at 00:00 UTC to its lock, the 14th at 16:00 UTC
    uint256 internal constant LOCK_OFFSET = 13 days + 16 hours;

    /// @notice Scale of the bought-token indexes
    uint256 internal constant INDEX_SCALE = 1e36;

    /// @notice Basis points in 100%
    uint256 internal constant BPS = 10_000;

    /**
     * @notice Lock time of a round: the 15th of its month at 00:00 UTC+8
     * @param round Round number
     * @return Unix timestamp
     */
    function roundStart(uint32 round) internal pure returns (uint256) {
        uint256 year = 1970 + round / 12;
        uint256 month = (round % 12) + 1;
        return _daysFromCivil(year, month, 1) * 1 days + LOCK_OFFSET;
    }

    /**
     * @notice Latest round whose lock time is at or before `timestamp`
     * @dev A new pair starts with this round as its last settled one
     * @param timestamp Unix timestamp, at least `LOCK_OFFSET`
     * @return Round number
     */
    function currentRound(uint256 timestamp) internal pure returns (uint32) {
        (uint256 year, uint256 month) = _civilFromDays((timestamp - LOCK_OFFSET) / 1 days);
        return uint32((year - 1970) * 12 + month - 1);
    }

    /**
     * @notice Round fee on the interest part of what was redeemed
     * @param stableOut Stable received for the round's units
     * @param dueBase Sum of the bases (B) of the plans in the round
     * @param feeRate Fee rate in basis points
     * @return fee Fee to the Reserve
     * @return rate Rate actually charged: `feeRate`, or 0 when there is no interest
     */
    function roundFee(
        uint256 stableOut,
        uint256 dueBase,
        uint16 feeRate
    ) internal pure returns (uint256 fee, uint16 rate) {
        if (stableOut <= dueBase) return (0, 0);
        return (((stableOut - dueBase) * feeRate) / BPS, feeRate);
    }

    /**
     * @notice Index steps that split a round's bought units over its plans
     * @dev A plan's share of the round is `P = slice * stableOut / dueUnits * (1 - e) + base * e`, with
     *      `e = rate / BPS`. Summed over the plans that is `net`. So a plan gets
     *      `slice * indexStep / INDEX_SCALE + base * baseIndexStep / INDEX_SCALE` bought units.
     * @param boughtUnits Asset units minted for the round
     * @param stableOut Stable received for the round's units
     * @param net `stableOut` minus the fee
     * @param dueUnits Sum of the slices in the round
     * @param rate Fee rate charged, in basis points
     * @return indexStep Bought units per stable unit of slice, scaled by `INDEX_SCALE`
     * @return baseIndexStep Bought units per unit of base, scaled by `INDEX_SCALE`
     */
    function indexSteps(
        uint256 boughtUnits,
        uint256 stableOut,
        uint256 net,
        uint256 dueUnits,
        uint16 rate
    ) internal pure returns (uint256 indexStep, uint256 baseIndexStep) {
        uint256 scaled = boughtUnits * INDEX_SCALE;
        indexStep = Math.mulDiv(scaled, stableOut * (BPS - rate), dueUnits * net * BPS);
        baseIndexStep = Math.mulDiv(scaled, rate, net * BPS);
    }

    /**
     * @notice Rounds of a plan's schedule that have settled
     * @param lastSettledRound Pair's last settled round
     * @param firstRound First round of the schedule
     * @param buys Buys in the schedule
     * @return Settled rounds, at most `buys`
     */
    function roundsDone(uint32 lastSettledRound, uint32 firstRound, uint8 buys) internal pure returns (uint8) {
        if (lastSettledRound < firstRound) return 0;
        uint256 done = lastSettledRound - firstRound + 1;
        return done > buys ? buys : uint8(done);
    }

    /**
     * @notice Whether a plan is in the pair's next round and that round's lock time has passed
     * @param openRound Pair's next round, `lastSettledRound + 1`
     * @param firstRound First round of the plan's schedule
     * @param buys Buys in the schedule
     * @param timestamp Time to check at
     * @return True while the plan's slice is in a locked, unsettled round
     */
    function inRunningRound(
        uint32 openRound,
        uint32 firstRound,
        uint8 buys,
        uint256 timestamp
    ) internal pure returns (bool) {
        return openRound >= firstRound && openRound < firstRound + buys && timestamp >= roundStart(openRound);
    }

    /**
     * @notice Asset units a plan earned between two index readings
     * @param slice Plan's stable units per buy
     * @param base Plan's base per buy
     * @param indexDelta Growth of `cumIndex` over the plan's settled rounds
     * @param baseIndexDelta Growth of `cumBaseIndex` over the same rounds
     * @return Asset units, rounded down
     */
    function planBought(
        uint256 slice,
        uint256 base,
        uint256 indexDelta,
        uint256 baseIndexDelta
    ) internal pure returns (uint256) {
        return Math.mulDiv(slice, indexDelta, INDEX_SCALE) + Math.mulDiv(base, baseIndexDelta, INDEX_SCALE);
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
