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

    function test_roundStart_countsFromTheAnchor() public pure {
        assertEq(SmartDCAMath.roundStart(NOV_2026, 0), 1_794_672_000);
        assertEq(SmartDCAMath.roundStart(NOV_2026, 2), 1_799_942_400);
        assertEq(SmartDCAMath.roundStart(NOV_2026 - 1, 1), 1_794_672_000);
    }

    function test_latestStartedMonth_cutoffSecond() public pure {
        uint256 start = SmartDCAMath.roundStart(0, uint32(NOV_2026));
        assertEq(SmartDCAMath.latestStartedMonth(start - 1), NOV_2026 - 1);
        assertEq(SmartDCAMath.latestStartedMonth(start), NOV_2026);
    }

    /// @dev Every month from Feb 1970 to Dec 2199. Starts are 28 to 31 days apart, always at 16:00 UTC.
    function testFuzz_roundDates(uint32 month) public pure {
        month = uint32(bound(month, 1970 * 12 + 1, 2199 * 12 + 11));
        uint256 start = SmartDCAMath.roundStart(0, month);
        assertEq(SmartDCAMath.latestStartedMonth(start), month);
        assertEq(SmartDCAMath.latestStartedMonth(start - 1), month - 1);
        assertEq(SmartDCAMath.latestStartedMonth(SmartDCAMath.roundStart(0, month + 1) - 1), month);
        assertEq((start - 16 hours) % 1 days, 0);
        uint256 gap = SmartDCAMath.roundStart(0, month + 1) - start;
        assertGe(gap, 28 days);
        assertLe(gap, 31 days);
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

    /// @dev The two index steps never hand out more than was bought, and lose only rounding
    function testFuzz_indexSteps_neverOverAllocate(
        uint256 boughtUnits,
        uint256 roundStableUnits,
        uint256 roundPrincipal,
        uint256 interestBps,
        uint16 feeRateBps
    ) public pure {
        boughtUnits = bound(boughtUnits, 1, 1e24);
        roundStableUnits = bound(roundStableUnits, 1e24, 1e36);
        roundPrincipal = bound(roundPrincipal, 1e12, 1e30);
        interestBps = bound(interestBps, 0, 5_000);
        feeRateBps = uint16(bound(feeRateBps, 0, 2_000));

        uint256 stableRedeemed = roundPrincipal + (roundPrincipal * interestBps) / 10_000;
        (uint256 fee, uint16 rate) = SmartDCAMath.roundFee(stableRedeemed, roundPrincipal, feeRateBps);
        uint256 stableNet = stableRedeemed - fee;
        (uint256 step, uint256 baseStep) = SmartDCAMath.roundIndexSteps(
            boughtUnits,
            stableRedeemed,
            stableNet,
            roundStableUnits,
            rate
        );

        uint256 allocated = (roundStableUnits * step) / 1e36 + (roundPrincipal * baseStep) / 1e36;
        assertLe(allocated, boughtUnits);
        // Lower bound: three floors lose at most 3 units, and the floored fee makes `stableNet` at most 1 too big,
        // which shrinks the split by at most `boughtUnits / stableNet`
        assertGe(allocated + boughtUnits / stableNet + 3, boughtUnits);
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

    /// @dev Every round start from 1970 to 2199 is the 15th at 00:00 UTC+8 by the year and month count
    function testFuzz_roundStart_matchesACalendarCount(uint32 month) public pure {
        month = uint32(bound(month, 1970 * 12 + 1, 2199 * 12 + 11));
        uint256 expected = _refDays(month / 12, (month % 12) + 1, 15) * 1 days - 8 hours;
        assertEq(SmartDCAMath.roundStart(0, month), expected);
    }

    /// @dev 2100 is not a leap year, 2000 is
    function test_roundStart_centuryLeapRules() public pure {
        uint32 mar2100 = 2100 * 12 + 2;
        uint32 mar2000 = 2000 * 12 + 2;
        assertEq(SmartDCAMath.roundStart(0, mar2100) - SmartDCAMath.roundStart(0, mar2100 - 1), 28 days);
        assertEq(SmartDCAMath.roundStart(0, mar2000) - SmartDCAMath.roundStart(0, mar2000 - 1), 29 days);
    }

    /// @dev Any second between two starts maps to the earlier start's month
    function testFuzz_latestStartedMonth_everySecondOfAMonth(uint32 month, uint256 offset) public pure {
        month = uint32(bound(month, 1970 * 12 + 1, 2199 * 12 + 10));
        uint256 start = SmartDCAMath.roundStart(0, month);
        uint256 next = SmartDCAMath.roundStart(0, month + 1);
        offset = bound(offset, 0, next - start - 1);
        assertEq(SmartDCAMath.latestStartedMonth(start + offset), month);
    }

    function test_latestStartedMonth_aroundNewYear() public pure {
        uint32 dec2026 = 2026 * 12 + 11;
        uint256 newYear = _refDays(2027, 1, 1) * 1 days;
        assertEq(SmartDCAMath.latestStartedMonth(newYear - 1), dec2026, "Dec 31 23:59:59 UTC");
        assertEq(SmartDCAMath.latestStartedMonth(newYear), dec2026, "Jan 1 is before the Jan 15 start");
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

    /// @dev Three plans with different entry prices: each plan's share from the indexes is within 2 units of the
    ///      exact `bought * P / net`, and the shares never add up to more than was bought. Covers 24 and 8 decimal
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
            assertApproxEqAbs(got, exact, 2, "plan share");
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

    /// @dev A round of 1e12 tokens at 24 decimal units does not overflow the index products
    function test_indexSteps_noOverflowAtATrillionTokens() public pure {
        SmartDCAMath.roundIndexSteps(1e30, 1e30, 1e30, 1e36, 2_000);
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
