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
        assertEq(v.T, 12);
        assertEq(v.C, 0);
        assertEq(v.n, 12);
        assertEq(v.P, 0);
        assertEq(v.W, 1201.2e18);
        assertEq(v.E, 100.1e18);
        assertEq(v.B, 100e18);
        assertEq(v.F, 0.005e18);
        assertEq(v.N, 100.095e18);
        assertEq(v.NW, 1201.14e18);
        assertEq(v.DW, 1201.14e18);
        assertEq(v.bought, 0);
    }

    function test_getPlan_duringRound() public {
        uint256 id = _create(alice, 1200e18, 12);
        hub.setPricePerShare(1.001e18);
        vm.warp(NOV_LOCK);
        vm.prank(keeper);
        dca.startBuy(pairId, 2);

        SmartDCALens.PlanView memory v = lens.getPlan(dca, id);
        assertTrue(v.inRunningRound);
        assertEq(v.P, 100.095e18);
        assertEq(v.n, 11);
        assertEq(v.W, 1101.1e18);
        assertEq(v.N, 100.095e18);
        assertEq(v.DW, 1201.14e18, "unchanged by the start of the round");
    }

    function test_getPlan_afterSettle() public {
        uint256 id = _create(alice, 1200e18, 12);
        hub.setPricePerShare(1.001e18);
        _runRound(2);

        SmartDCALens.PlanView memory v = lens.getPlan(dca, id);
        assertFalse(v.inRunningRound);
        assertEq(v.C, 1);
        assertEq(v.n, 11);
        assertEq(v.P, 0);
        assertEq(v.DW, 1101.045e18);
        assertApproxEqAbs(v.bought, 1.00095e15, 2e8);

        // The lens value is what a full withdraw pays
        assertEq(_withdrawAll(alice, id), v.bought);
    }

    function test_getPlan_states() public {
        uint256 matured = _create(alice, 100e18, 2);
        uint256 cancelled = _create(bob, 100e18, 2);
        vm.prank(bob);
        dca.cancel(cancelled);
        _runRound(1);
        _runRound(1);

        assertEq(uint8(lens.getPlan(dca, matured).state), uint8(SmartDCALens.PlanState.Matured));
        assertEq(lens.getPlan(dca, matured).n, 0);
        assertEq(uint8(lens.getPlan(dca, cancelled).state), uint8(SmartDCALens.PlanState.Cancelled));

        vm.prank(alice);
        dca.claim(matured, false);
        assertEq(uint8(lens.getPlan(dca, matured).state), uint8(SmartDCALens.PlanState.Done));
        assertEq(lens.getPlan(dca, 999).owner, address(0));
    }

    /// @dev topUp moves `firstRound` forward; the lens still shows the plan's first round, and a Done plan shows all buys
    function test_getPlan_firstRoundAfterTopUpAndCompletedBuysWhenDone() public {
        uint256 id = _create(alice, 300e18, 3);
        _runRound(1);
        _topUp(alice, id, 100e18);
        SmartDCALens.PlanView memory v = lens.getPlan(dca, id);
        assertEq(v.firstRound, NOV);
        assertEq(v.lastRound, NOV + 2);
        assertEq(v.C, 1);
        assertEq(v.T, 3);

        _runRound(1);
        _runRound(1);
        vm.prank(alice);
        dca.claim(id, false);
        v = lens.getPlan(dca, id);
        assertEq(v.firstRound, NOV);
        assertEq(v.C, 3);
    }

    function test_getPair_phases() public {
        _create(alice, 1200e18, 12);
        SmartDCALens.PairView memory v = lens.getPair(dca, pairId);
        assertEq(uint8(v.state), uint8(SmartDCALens.PairState.Open));
        assertEq(v.round, NOV);
        assertEq(v.lockTime, NOV_LOCK);
        assertEq(v.backupTime, NOV_LOCK + 9 hours);
        assertEq(v.dueUnits, 100e24);
        assertEq(v.dueValue, 100e18);

        vm.warp(NOV_LOCK);
        assertEq(uint8(lens.getPair(dca, pairId).state), uint8(SmartDCALens.PairState.Locked));

        vm.startPrank(keeper);
        dca.startBuy(pairId, 3);
        dca.executeOrder(pairId, ANY_QUOTE, _swapData(pairId));
        v = lens.getPair(dca, pairId);
        assertEq(uint8(v.state), uint8(SmartDCALens.PairState.Executing));
        assertEq(v.parts, 3);
        assertEq(v.partsDone, 1);

        dca.executeOrder(pairId, ANY_QUOTE, _swapData(pairId));
        dca.executeOrder(pairId, ANY_QUOTE, _swapData(pairId));
        dca.settle(pairId);
        vm.stopPrank();
        v = lens.getPair(dca, pairId);
        assertEq(uint8(v.state), uint8(SmartDCALens.PairState.Open));
        assertEq(v.round, DEC);
        assertEq(v.lockTime, SmartDCAMath.roundStart(DEC));
        assertEq(lens.getPair(dca, 99).stable, address(0));
    }

    function test_getConfig_returnsEveryParameter() public {
        dca.pause();
        SmartDCALens.Config memory c = lens.getConfig(dca);
        assertEq(c.feeRate, 500);
        assertEq(c.maxSlippage, 10);
        assertEq(c.maxSplitN, 10);
        assertEq(c.minBuys, 2);
        assertEq(c.maxBuys, 60);
        assertEq(c.backupDelay, 9 hours);
        assertEq(c.pairCount, 1);
        assertEq(c.reserve, reserve);
        assertTrue(c.paused);
    }

    function test_getPlan_lockedBeforeStartBuy() public {
        uint256 id = _create(alice, 1200e18, 12);
        vm.warp(NOV_LOCK);
        SmartDCALens.PlanView memory v = lens.getPlan(dca, id);
        assertTrue(v.inRunningRound);
        assertEq(uint8(v.state), uint8(SmartDCALens.PlanState.Active));
        assertEq(v.P, 0);
        assertEq(v.n, 12);
        assertEq(v.N, 100e18);
    }

    /// @dev On the last buy E is everything still waiting, not one slice
    function test_getPlan_lastBuyTakesWhatIsLeft() public {
        uint256 id = _create(alice, 100e18 + 1, 2);
        _runRound(1);
        SmartDCALens.PlanView memory v = lens.getPlan(dca, id);
        assertEq(v.n, 1);
        assertEq(v.E, v.W);
        assertEq(v.W, 50e18);
    }

    /// @dev Bob joined at a higher share price, then the price fell: the round redeems less than its bases,
    ///      so no plan pays a fee, even Alice whose own E is above her B
    function test_getPlan_feeUsesTheRoundsRate() public {
        uint256 aliceId = _create(alice, 1200e18, 12);
        hub.setPricePerShare(1.02e18);
        _create(bob, 1200e18, 12);
        hub.setPricePerShare(1.005e18);

        SmartDCALens.PlanView memory v = lens.getPlan(dca, aliceId);
        assertEq(v.E, 100.5e18);
        assertEq(v.F, 0);
        assertEq(v.N, 100.5e18);

        vm.warp(NOV_LOCK);
        vm.prank(keeper);
        dca.startBuy(pairId, 1);
        assertApproxEqAbs(lens.getPlan(dca, aliceId).P, v.N, 1);
    }

    function test_getPair_skipsEmptyMonths() public {
        vm.warp(SmartDCAMath.roundStart(DEC + 2) + 5 days);
        SmartDCALens.PairView memory v = lens.getPair(dca, pairId);
        assertEq(v.round, DEC + 3);
        assertEq(uint8(v.state), uint8(SmartDCALens.PairState.Open));

        dca.sync(pairId);
        assertEq(lens.getPair(dca, pairId).round, v.round, "same as after the pair catches up");
    }

    function test_getPair_showsDisabledAndResplit() public {
        _create(alice, 1200e18, 12);
        assertTrue(lens.getPair(dca, pairId).enabled);
        dca.setPairEnabled(pairId, false);
        vm.warp(NOV_LOCK);
        vm.startPrank(keeper);
        dca.startBuy(pairId, 2);
        dca.resplit(pairId, 3);
        vm.stopPrank();

        SmartDCALens.PairView memory v = lens.getPair(dca, pairId);
        assertFalse(v.enabled);
        assertTrue(v.resplitUsed);
        assertEq(v.parts, 3);
    }
}
