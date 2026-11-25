// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

// solhint-disable func-name-mixedcase, ordering, import-path-check

import { Test } from "forge-std/Test.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { SmartDCAMath } from "../../../contracts/SmartDCA/SmartDCAMath.sol";

contract SmartDCA_MathTest is Test {
    // Months counted as `year * 12 + (month - 1)`; anchor 0 makes the round number the month itself
    uint256 internal constant NOV_2026 = 2026 * 12 + 10;

    function test_roundStart_isThe14thAt1600Utc() public pure {
        assertEq(SmartDCAMath.roundStart(0, uint32(NOV_2026)), 1_794_672_000); // 2026-11-14 16:00 UTC
        assertEq(SmartDCAMath.roundStart(0, uint32(NOV_2026 + 2)), 1_799_942_400); // 2027-01-14, year rollover
        assertEq(SmartDCAMath.roundStart(0, uint32(NOV_2026 + 16)), 1_836_662_400); // 2028-03-14 16:00 UTC, leap Feb
    }

    function test_roundsDone_capsAtBuys_inRunningRound_onlyFromLockInsideTheSchedule() public pure {
        assertEq(SmartDCAMath.buysSettled(681, 682, 12), 0);
        assertEq(SmartDCAMath.buysSettled(682, 682, 12), 1);
        assertEq(SmartDCAMath.buysSettled(700, 682, 12), 12);

        assertFalse(SmartDCAMath.inRunningRound(682, 682, 12, false), "before the start");
        assertTrue(SmartDCAMath.inRunningRound(682, 682, 12, true));
        assertFalse(SmartDCAMath.inRunningRound(682, 683, 12, true), "parked for the next round");
        assertFalse(SmartDCAMath.inRunningRound(694, 682, 12, true), "after its last round");
    }

    function test_roundFee_onInterestOnly() public pure {
        (uint256 fee, uint16 rate) = SmartDCAMath.roundFee(200.2e18, 200e18, 500);
        assertEq(fee, 0.01e18);
        assertEq(rate, 500);
    }

    function test_roundFee_zeroWithoutInterest() public pure {
        (uint256 fee, uint16 rate) = SmartDCAMath.roundFee(199e18, 200e18, 500);
        assertEq(fee, 0);
        assertEq(rate, 0);
    }

    // ----- dates against a separate calendar count -----

    /// @dev Days from 1970-01-01, counted year by year and month by month
    function _refDays(uint256 y, uint256 m, uint256 d) internal pure returns (uint256 days_) {
        for (uint256 yy = 1970; yy < y; ++yy) days_ += _leap(yy) ? 366 : 365;
        uint8[12] memory len = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
        for (uint256 mm = 1; mm < m; ++mm) days_ += (mm == 2 && _leap(y)) ? 29 : len[mm - 1];
        days_ += d - 1;
    }

    function _leap(uint256 y) internal pure returns (bool) {
        return (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    }

    /// @dev Every month from Feb 1970 to Dec 2199, with none skipped: the round starts on the 15th at 00:00 UTC+8 by
    ///      the year and month count, both from anchor 0 and from a Feb 1970 anchor
    function test_roundStart_everyMonthMatchesACalendarCount() public pure {
        uint256 first = 1970 * 12 + 1;
        uint256 expected = _refDays(1970, 2, 15) * 1 days - 8 hours;
        for (uint256 month = first; month <= 2199 * 12 + 11; ++month) {
            assertEq(SmartDCAMath.roundStart(0, uint32(month)), expected, "from anchor 0");
            assertEq(SmartDCAMath.roundStart(first, uint32(month - first)), expected, "from a later anchor");
            expected += _monthDays(month / 12, (month % 12) + 1) * 1 days;
        }
    }

    /// @dev Every second from Feb 1970 to Dec 2199 maps to the month of the latest round start, with none skipped.
    ///      The result only changes at a day boundary that starts at a round start, so the first and last second of
    ///      each day stand for every second of it.
    function test_latestStartedMonth_everySecondMapsToItsRound() public pure {
        uint256 start = _refDays(1970, 2, 15) * 1 days - 8 hours;
        for (uint256 month = 1970 * 12 + 1; month <= 2199 * 12 + 11; ++month) {
            uint256 next = start + _monthDays(month / 12, (month % 12) + 1) * 1 days;
            assertEq(SmartDCAMath.latestStartedMonth(start - 1), month - 1, "second before the start");
            for (uint256 day = start; day < next; day += 1 days) {
                assertEq(SmartDCAMath.latestStartedMonth(day), month, "first second of a day");
                assertEq(SmartDCAMath.latestStartedMonth(day + 1 days - 1), month, "last second of a day");
            }
            start = next;
        }
    }

    function _monthDays(uint256 y, uint256 m) internal pure returns (uint256) {
        if (m == 2) return _leap(y) ? 29 : 28;
        return m == 4 || m == 6 || m == 9 || m == 11 ? 30 : 31;
    }

    // ----- fee -----

    function test_roundFee_boundaryRates() public pure {
        (uint256 fee, uint16 rate) = SmartDCAMath.roundFee(101e18, 100e18, 10_000);
        assertEq(fee, 1e18, "100% takes all the interest");
        assertEq(rate, 10_000);
        (fee, rate) = SmartDCAMath.roundFee(101e18, 100e18, 0);
        assertEq(fee, 0);
        assertEq(rate, 0);
        // One wei of interest: the fee floors to 0 but the rate still counts as charged
        (fee, rate) = SmartDCAMath.roundFee(100e18 + 1, 100e18, 500);
        assertEq(fee, 0);
        assertEq(rate, 500);
    }

    /// @dev The fee never touches principal and never exceeds the rate's share of the interest
    function testFuzz_roundFee_bounds(uint256 redeemed, uint256 principal, uint16 rateBps) public pure {
        redeemed = bound(redeemed, 1, 1e40);
        principal = bound(principal, 1, 1e40);
        rateBps = uint16(bound(rateBps, 0, 10_000));
        (uint256 fee, ) = SmartDCAMath.roundFee(redeemed, principal, rateBps);
        if (redeemed <= principal) {
            assertEq(fee, 0);
        } else {
            assertLe(fee, ((redeemed - principal) * rateBps) / 10_000);
            assertGe(redeemed - fee, principal, "net never below principal");
        }
    }

    // ----- index steps -----

    struct PlanIn {
        uint256 slice;
        uint256 principal;
    }

    /// @dev Three plans with different entry prices: each plan's share from the indexes is at most the exact
    ///      `bought * P / net` and less than 2 units below it, and the shares never add up to more than was bought. Covers 24 and 8 decimal
    ///      units on both sides.
    function testFuzz_indexSteps_eachPlanWithinTwoUnitsOfExact(
        uint256[3] memory slices,
        uint256[3] memory entryBps,
        uint256 unitValueBps,
        uint256 bought,
        uint16 rateBps,
        uint8 decimalsCase
    ) public pure {
        // Stable units per stable wei: 1e6 for 24 decimal Hub shares, 1 for a source at the stable's decimals.
        // Bought asset units: up to 1e14 (8 decimal vTokens) or up to 1e30 (24 decimal Hub shares).
        uint256 unitScale = decimalsCase % 2 == 0 ? 1e6 : 1;
        rateBps = uint16(bound(rateBps, 0, 2_000));
        unitValueBps = bound(unitValueBps, 9_000, 15_000);
        bought = bound(bought, 1e4, decimalsCase % 3 == 0 ? 1e30 : 1e14);

        PlanIn[3] memory p;
        uint256 units;
        uint256 principal;
        for (uint256 i; i < 3; ++i) {
            p[i].slice = bound(slices[i], 10e18, 1e27) * unitScale;
            uint256 entry = bound(entryBps[i], 9_000, 15_000);
            p[i].principal = ((p[i].slice / unitScale) * entry) / 10_000;
            units += p[i].slice;
            principal += p[i].principal;
        }
        uint256 redeemed = ((units / unitScale) * unitValueBps) / 10_000;
        (uint256 fee, uint16 rate) = SmartDCAMath.roundFee(redeemed, principal, rateBps);
        uint256 net = redeemed - fee;
        (uint256 su, uint256 sp) = SmartDCAMath.roundIndexSteps(bought, redeemed, net, units, rate);

        uint256 total;
        for (uint256 i; i < 3; ++i) {
            uint256 got = SmartDCAMath.assetUnitsBought(p[i].slice, p[i].principal, su, sp);
            // bought * P / net with P = slice * redeemed / units * (1 - r) + principal * r, as one fraction
            uint256 num = p[i].slice * redeemed * (10_000 - rate) + p[i].principal * rate * units;
            uint256 exact = Math.mulDiv(bought, num, units * 10_000 * net);
            assertLe(got, exact, "plan over its share");
            assertLt(exact - got, 2, "plan short of its share");
            total += got;
        }
        assertLe(total, bought, "over allocated");
    }

    /// @dev At a 100% fee every plan is paid by its principal alone, and the unit index does not move
    function test_indexSteps_fullFeeUsesPrincipalOnly() public pure {
        (uint256 su, uint256 sp) = SmartDCAMath.roundIndexSteps(1e8, 110e18, 100e18, 100e24, 10_000);
        assertEq(su, 0);
        assertEq(SmartDCAMath.assetUnitsBought(100e24, 100e18, su, sp), 1e8);
    }

    /// @dev The largest rounds do not overflow the index products or a plan's reading: 1e12 tokens at 24 decimal
    ///      units, a 100% fee on a round that doubled its principal, and a 1 unit plan beside a 1e30 unit one
    function test_indexSteps_noOverflowAtTheLargestRounds() public pure {
        SmartDCAMath.roundIndexSteps(1e30, 1e30, 1e30, 1e36, 2_000);

        (uint256 fee, uint16 rate) = SmartDCAMath.roundFee(2e30, 1e30, 10_000);
        (uint256 su, uint256 sp) = SmartDCAMath.roundIndexSteps(1e30, 2e30, 2e30 - fee, 2e30, rate);
        assertLe(SmartDCAMath.assetUnitsBought(2e30, 1e30, su, sp), 1e30, "100% fee");

        (su, sp) = SmartDCAMath.roundIndexSteps(1e30, 2e30, 2e30, 1e30 + 1, 0);
        uint256 small = SmartDCAMath.assetUnitsBought(1, 1, su, sp);
        uint256 large = SmartDCAMath.assetUnitsBought(1e30, 1e30, su, sp);
        assertLe(small + large, 1e30, "1 unit beside 1e30");
    }

    /// @dev Reading a plan in two pieces, as a top up carries the first piece, never pays more than one reading
    ///      over both, and loses at most 2 units, one for each of its two terms
    function testFuzz_assetUnitsBought_splitReadingNeverPaysMore(
        uint256 stableUnitsPerBuy,
        uint256 principalPerBuy,
        uint256[4] memory growth
    ) public pure {
        stableUnitsPerBuy = bound(stableUnitsPerBuy, 1, 1e30);
        principalPerBuy = bound(principalPerBuy, 1, 1e30);
        for (uint256 i; i < 4; ++i) growth[i] = bound(growth[i], 0, 1e72);
        uint256 split = SmartDCAMath.assetUnitsBought(stableUnitsPerBuy, principalPerBuy, growth[0], growth[2]) +
            SmartDCAMath.assetUnitsBought(stableUnitsPerBuy, principalPerBuy, growth[1], growth[3]);
        uint256 whole = SmartDCAMath.assetUnitsBought(
            stableUnitsPerBuy,
            principalPerBuy,
            growth[0] + growth[1],
            growth[2] + growth[3]
        );
        assertLe(split, whole, "split over whole");
        assertLe(whole - split, 2, "split loses too much");
    }

    // ----- schedule helpers -----

    function test_buysSettled_andInRunningRound_singleBuyAndMaxBuys() public pure {
        assertEq(SmartDCAMath.buysSettled(9, 10, 1), 0);
        assertEq(SmartDCAMath.buysSettled(10, 10, 1), 1);
        assertEq(SmartDCAMath.buysSettled(500, 10, 120), 120);
        assertTrue(SmartDCAMath.inRunningRound(10, 10, 1, true));
        assertFalse(SmartDCAMath.inRunningRound(11, 10, 1, true));
        assertTrue(SmartDCAMath.inRunningRound(129, 10, 120, true), "last of 120");
        assertFalse(SmartDCAMath.inRunningRound(130, 10, 120, true));
    }
}
