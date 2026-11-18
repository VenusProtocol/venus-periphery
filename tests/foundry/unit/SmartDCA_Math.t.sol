// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

// solhint-disable func-name-mixedcase, ordering, import-path-check

import { Test } from "forge-std/Test.sol";
import { SmartDCAMath } from "../../../contracts/SmartDCA/SmartDCAMath.sol";

contract SmartDCA_MathTest is Test {
    function test_roundStart_isThe14thAt1600Utc() public pure {
        assertEq(SmartDCAMath.lockTimeOf(682), 1_794_672_000); // 2026-11-14 16:00 UTC = Nov 15 00:00 UTC+8
        assertEq(SmartDCAMath.lockTimeOf(684), 1_799_942_400); // 2027-01-14 16:00 UTC, year rollover
        assertEq(SmartDCAMath.lockTimeOf(698), 1_836_662_400); // 2028-03-14 16:00 UTC, after a 29-day February
    }

    function test_currentRound_cutoffSecond() public pure {
        uint256 lock = SmartDCAMath.lockTimeOf(682);
        assertEq(SmartDCAMath.latestLockedRound(lock - 1), 681);
        assertEq(SmartDCAMath.latestLockedRound(lock), 682);
    }

    /// @dev Every month from Feb 1970 to Dec 2199. Months are 28 to 31 days apart.
    function testFuzz_roundDates(uint32 round) public pure {
        round = uint32(bound(round, 1, 2759));
        uint256 lock = SmartDCAMath.lockTimeOf(round);
        assertEq(SmartDCAMath.latestLockedRound(lock), round);
        assertEq(SmartDCAMath.latestLockedRound(lock - 1), round - 1);
        assertEq(SmartDCAMath.latestLockedRound(SmartDCAMath.lockTimeOf(round + 1) - 1), round);
        assertEq((lock - 16 hours) % 1 days, 0);
        uint256 gap = SmartDCAMath.lockTimeOf(round + 1) - lock;
        assertGe(gap, 28 days);
        assertLe(gap, 31 days);
    }

    function test_roundsDone_capsAtBuys_inRunningRound_onlyFromLockInsideTheSchedule() public pure {
        assertEq(SmartDCAMath.buysSettled(681, 682, 12), 0);
        assertEq(SmartDCAMath.buysSettled(682, 682, 12), 1);
        assertEq(SmartDCAMath.buysSettled(700, 682, 12), 12);

        uint256 lock = SmartDCAMath.lockTimeOf(682);
        assertFalse(SmartDCAMath.inRunningRound(682, 682, 12, lock - 1));
        assertTrue(SmartDCAMath.inRunningRound(682, 682, 12, lock));
        assertFalse(SmartDCAMath.inRunningRound(682, 683, 12, lock), "parked for the next round");
        assertFalse(SmartDCAMath.inRunningRound(694, 682, 12, SmartDCAMath.lockTimeOf(694)), "after its last round");
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
}
