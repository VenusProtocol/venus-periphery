// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

// solhint-disable func-name-mixedcase, ordering, import-path-check

import { SmartDCALens } from "../../../contracts/SmartDCA/SmartDCALens.sol";
import { SmartDCAMath } from "../../../contracts/SmartDCA/SmartDCAMath.sol";
import { SmartDCABase } from "./SmartDCABase.t.sol";

/// @notice PRD worked example 2.3 through the lens: 1,200 USDT x 12, fee 5%, unit value 1.001
contract SmartDCA_LensTest is SmartDCABase {
    SmartDCALens internal lens;

    function setUp() public override {
        super.setUp();
        lens = new SmartDCALens();
    }

    function test_getPlan_waiting() public {
        uint256 id = _create(alice, 1200e18, 12);
        hub.setPricePerShare(1.001e18);

        SmartDCALens.PlanView memory v = lens.getPlan(dca, id);
        assertEq(uint8(v.state), uint8(SmartDCALens.PlanState.Active));
        assertEq(v.owner, alice);
        assertEq(v.firstRound, NOV);
        assertEq(v.lastRound, NOV + 11);
        assertFalse(v.inRunningRound);
        assertEq(v.totalBuys, 12);
        assertEq(v.buysSettled, 0);
        assertEq(v.buysLeft, 12);
        assertEq(v.stablePending, 0);
        assertEq(v.stableWaiting, 1201.2e18);
        assertEq(v.nextBuyStable, 100.1e18);
        assertEq(v.principalPerBuy, 100e18);
        assertEq(v.nextBuyFee, 0.005e18);
        assertEq(v.nextBuyNet, 100.095e18);
        assertEq(v.netWaiting, 1201.14e18);
        assertEq(v.displayedWaiting, 1201.14e18);
        assertEq(v.assetValue, 0);
    }

    function test_getPlan_duringRound() public {
        uint256 id = _create(alice, 1200e18, 12);
        hub.setPricePerShare(1.001e18);
        vm.warp(NOV_LOCK);
        vm.prank(keeper);
        dca.startRound(pairId, 2);

        SmartDCALens.PlanView memory v = lens.getPlan(dca, id);
        assertTrue(v.inRunningRound);
        assertEq(v.stablePending, 100.095e18);
        assertEq(v.buysLeft, 11);
        assertEq(v.stableWaiting, 1101.1e18);
        assertEq(v.nextBuyNet, 100.095e18);
        assertEq(v.displayedWaiting, 1201.14e18, "unchanged by the start of the round");
    }

    function test_getPlan_afterSettle() public {
        uint256 id = _create(alice, 1200e18, 12);
        hub.setPricePerShare(1.001e18);
        _runRound(2);

        SmartDCALens.PlanView memory v = lens.getPlan(dca, id);
        assertFalse(v.inRunningRound);
        assertEq(v.buysSettled, 1);
        assertEq(v.buysLeft, 11);
        assertEq(v.stablePending, 0);
        assertEq(v.displayedWaiting, 1101.045e18);
        assertApproxEqAbs(v.assetValue, 1.00095e15, 2e8);

        // The lens value is what a full withdraw pays
        assertEq(_withdrawAll(alice, id), v.assetValue);
    }

    function test_getPlan_states() public {
        uint256 matured = _create(alice, 100e18, 2);
        uint256 cancelled = _create(bob, 100e18, 2);
        vm.prank(bob);
        dca.cancelPlan(cancelled, bob);
        _runRound(1);
        _runRound(1);

        assertEq(uint8(lens.getPlan(dca, matured).state), uint8(SmartDCALens.PlanState.Matured));
        assertEq(lens.getPlan(dca, matured).buysLeft, 0);
        assertEq(uint8(lens.getPlan(dca, cancelled).state), uint8(SmartDCALens.PlanState.Cancelled));

        vm.prank(alice);
        dca.claimPlan(matured, false, alice);
        assertEq(uint8(lens.getPlan(dca, matured).state), uint8(SmartDCALens.PlanState.Claimed));
        assertEq(lens.getPlan(dca, 999).owner, address(0));
    }

    /// @dev A top up moves `scheduleFirstRound` forward; the lens still shows the plan's first round, and a claimed plan shows all buys
    function test_getPlan_firstRoundAfterTopUpAndCompletedBuysWhenDone() public {
        uint256 id = _create(alice, 300e18, 3);
        _runRound(1);
        _topUp(alice, id, 100e18);
        SmartDCALens.PlanView memory v = lens.getPlan(dca, id);
        assertEq(v.firstRound, NOV);
        assertEq(v.lastRound, NOV + 2);
        assertEq(v.buysSettled, 1);
        assertEq(v.totalBuys, 3);

        _runRound(1);
        _runRound(1);
        vm.prank(alice);
        dca.claimPlan(id, false, alice);
        v = lens.getPlan(dca, id);
        assertEq(v.firstRound, NOV);
        assertEq(v.buysSettled, 3);
    }

    function test_getPair_phases() public {
        _create(alice, 1200e18, 12);
        SmartDCALens.PairView memory v = lens.getPair(dca, pairId);
        assertEq(uint8(v.state), uint8(SmartDCALens.PairState.Open));
        assertEq(v.round, NOV);
        assertEq(v.lockTime, NOV_LOCK);
        assertEq(v.roundStableUnits, 100e24);
        assertEq(v.roundStableValue, 100e18);

        vm.warp(NOV_LOCK);
        assertEq(uint8(lens.getPair(dca, pairId).state), uint8(SmartDCALens.PairState.Locked));

        vm.startPrank(keeper);
        dca.startRound(pairId, 3);
        dca.swapRoundPart(pairId, ANY_QUOTE, _swapData(pairId));
        v = lens.getPair(dca, pairId);
        assertEq(uint8(v.state), uint8(SmartDCALens.PairState.Executing));
        assertEq(v.parts, 3);
        assertEq(v.partsDone, 1);

        dca.swapRoundPart(pairId, ANY_QUOTE, _swapData(pairId));
        dca.swapRoundPart(pairId, ANY_QUOTE, _swapData(pairId));
        dca.settleRound(pairId);
        vm.stopPrank();
        v = lens.getPair(dca, pairId);
        assertEq(uint8(v.state), uint8(SmartDCALens.PairState.Open));
        assertEq(v.round, DEC);
        assertEq(v.lockTime, dca.roundStart(DEC));
        assertEq(lens.getPair(dca, 99).stable, address(0));
    }

    function test_getConfig_returnsEveryParameter() public {
        dca.pause();
        SmartDCALens.Config memory c = lens.getConfig(dca);
        assertEq(c.feeRateBps, 500);
        assertEq(c.maxSlippageBps, 10);
        assertEq(c.maxParts, 10);
        assertEq(c.minBuys, 2);
        assertEq(c.maxBuys, 60);
        assertEq(c.pairCount, 1);
        assertEq(c.reserve, reserve);
        assertTrue(c.paused);
    }

    function test_getPlan_lockedBeforeStartRound() public {
        uint256 id = _create(alice, 1200e18, 12);
        vm.warp(NOV_LOCK);
        SmartDCALens.PlanView memory v = lens.getPlan(dca, id);
        assertTrue(v.inRunningRound);
        assertEq(uint8(v.state), uint8(SmartDCALens.PlanState.Active));
        assertEq(v.stablePending, 0);
        assertEq(v.buysLeft, 12);
        assertEq(v.nextBuyNet, 100e18);
    }

    /// @dev On the last buy E is everything still waiting, not one buy's units
    function test_getPlan_lastBuyTakesWhatIsLeft() public {
        uint256 id = _create(alice, 100e18 + 1, 2);
        _runRound(1);
        SmartDCALens.PlanView memory v = lens.getPlan(dca, id);
        assertEq(v.buysLeft, 1);
        assertEq(v.nextBuyStable, v.stableWaiting);
        assertEq(v.stableWaiting, 50e18);
    }

    /// @dev Bob joined at a higher share price, then the price fell: the round redeems less than its principalSum,
    ///      so no plan pays a fee, even Alice whose own E is above her B
    function test_getPlan_feeUsesTheRoundsRate() public {
        uint256 aliceId = _create(alice, 1200e18, 12);
        hub.setPricePerShare(1.02e18);
        _create(bob, 1200e18, 12);
        hub.setPricePerShare(1.005e18);

        SmartDCALens.PlanView memory v = lens.getPlan(dca, aliceId);
        assertEq(v.nextBuyStable, 100.5e18);
        assertEq(v.nextBuyFee, 0);
        assertEq(v.nextBuyNet, 100.5e18);

        vm.warp(NOV_LOCK);
        vm.prank(keeper);
        dca.startRound(pairId, 1);
        assertApproxEqAbs(lens.getPlan(dca, aliceId).stablePending, v.nextBuyNet, 1);
    }

    /// @dev The round holds every stable unit of the pair, so starting it leaves the stable source empty
    function test_getPair_whileTheRoundHoldsEveryUnit() public {
        uint256 id = _create(alice, 200e18, 2);
        _runRound(1);

        vm.warp(dca.nextLockTime(pairId));
        vm.prank(keeper);
        dca.startRound(pairId, 1);

        SmartDCALens.PairView memory v = lens.getPair(dca, pairId);
        assertEq(uint8(v.state), uint8(SmartDCALens.PairState.Executing));
        assertEq(v.roundStableUnits, 100e24);
        assertEq(v.roundStableValue, 0);
        assertEq(lens.getPlan(dca, id).buysLeft, 0);
    }

    function test_getPair_skipsEmptyMonths() public {
        vm.warp(dca.roundStart(DEC + 2) + 5 days);
        SmartDCALens.PairView memory v = lens.getPair(dca, pairId);
        assertEq(v.round, DEC + 3);
        assertEq(uint8(v.state), uint8(SmartDCALens.PairState.Open));

        dca.syncPair(pairId);
        assertEq(lens.getPair(dca, pairId).round, v.round, "same as after the pair catches up");
    }

    function test_getPair_showsDisabledAndResplit() public {
        _create(alice, 1200e18, 12);
        assertTrue(lens.getPair(dca, pairId).enabled);
        dca.setPairEnabled(pairId, false);
        vm.warp(NOV_LOCK);
        vm.startPrank(keeper);
        dca.startRound(pairId, 2);
        dca.resplitRound(pairId, 3);
        vm.stopPrank();

        SmartDCALens.PairView memory v = lens.getPair(dca, pairId);
        assertFalse(v.enabled);
        assertTrue(v.resplitUsed);
        assertEq(v.parts, 3);
    }
}
