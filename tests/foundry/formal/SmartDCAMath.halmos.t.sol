// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

// solhint-disable func-name-mixedcase

import { Test } from "forge-std/Test.sol";
import { SmartDCAMath } from "../../../contracts/SmartDCA/SmartDCAMath.sol";

/// @notice Halmos proofs for SmartDCAMath. Run with `halmos --contract SmartDCAMathHalmos --solver cvc5-int`;
///         `forge test` skips them. After a plain `forge build`, run `forge build --ast --force` on this file first,
///         or Halmos finds no tests.
/// @dev The calendar and the index split are checked in tests/foundry/unit/SmartDCA_Math.t.sol.
contract SmartDCAMathHalmos is Test {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant MAX_ROUND = 1200;

    /// @dev The fee is 0 without interest and never more than the interest; the rate is reported only with interest
    function check_roundFee_neverAboveTheInterest(uint96 redeemed, uint96 principal, uint16 rate) public pure {
        vm.assume(rate <= BPS);
        (uint256 fee, uint16 charged) = SmartDCAMath.roundFee(redeemed, principal, rate);
        if (redeemed <= principal) {
            assert(fee == 0 && charged == 0);
        } else {
            assert(fee <= redeemed - principal);
            assert(charged == rate);
        }
    }

    /// @dev Settled buys never exceed the schedule and count the settled rounds from the first
    function check_buysSettled_countsSettledRoundsUpToTheSchedule(
        uint32 lastSettled,
        uint32 firstRound,
        uint8 buys
    ) public pure {
        vm.assume(firstRound >= 1 && firstRound <= MAX_ROUND && lastSettled <= MAX_ROUND * 2);
        uint8 settled = SmartDCAMath.buysSettled(lastSettled, firstRound, buys);
        assert(settled <= buys);
        if (lastSettled < firstRound) assert(settled == 0);
        else if (uint256(lastSettled) + 1 >= uint256(firstRound) + buys) assert(settled == buys);
        else assert(settled == lastSettled - firstRound + 1);
    }

    /// @dev A plan is in the running round exactly when that round has started, is in its schedule and has not settled
    function check_inRunningRound_onlyWhileTheBuyIsLockedAndUnsettled(
        uint32 lastSettled,
        uint32 firstRound,
        uint8 buys,
        bool started
    ) public pure {
        vm.assume(firstRound >= 1 && firstRound <= MAX_ROUND && lastSettled <= MAX_ROUND * 2);
        bool running = SmartDCAMath.inRunningRound(lastSettled + 1, firstRound, buys, started);
        uint8 settled = SmartDCAMath.buysSettled(lastSettled, firstRound, buys);
        assert(running == (started && lastSettled + 1 >= firstRound && settled < buys));
    }
}
