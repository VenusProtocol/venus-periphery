// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

// solhint-disable func-name-mixedcase, ordering, import-path-check

import { SmartDCAMath } from "../../../contracts/SmartDCA/SmartDCAMath.sol";
import { ISmartDCA } from "../../../contracts/SmartDCA/ISmartDCA.sol";
import { MockVToken } from "./mocks/SmartDCAMocks.sol";
import { SmartDCABase } from "./SmartDCABase.t.sol";

contract SmartDCA_PlansTest is SmartDCABase {
    // ----- createPlan -----

    function test_createPlan_beforeLockJoinsThisRound() public {
        uint256 id = _create(alice, 1200e18, 12);

        ISmartDCA.Plan memory p = _plan(id);
        assertEq(p.owner, alice);
        assertEq(uint8(p.status), uint8(ISmartDCA.PlanStatus.Active));
        assertEq(p.firstRound, NOV);
        assertEq(p.stableUnits, 1200e24);
        assertEq(p.slice, 100e24);
        assertEq(p.base, 100e18);

        ISmartDCA.Pair memory pair = _pair();
        assertEq(pair.dueUnits, 100e24);
        assertEq(pair.dueBase, 100e18);
        assertEq(_round(NOV + 11).sliceEnding, 100e24);
        assertEq(hub.balanceOf(address(dca)), 1200e24);
        assertEq(dca.getPlansOf(alice).length, 1);
    }

    function test_createPlan_oneSecondBeforeLockJoinsThisRound() public {
        vm.warp(NOV_LOCK - 1);
        assertEq(_plan(_create(alice, 1200e18, 12)).firstRound, NOV);
    }

    function test_createPlan_atLockJoinsNextRound() public {
        _create(alice, 1200e18, 12);
        vm.warp(NOV_LOCK);
        uint256 id = _create(carol, 300e18, 3);

        assertEq(_plan(id).firstRound, DEC);
        assertEq(_pair().dueUnits, 100e24, "carol not in November");
        assertEq(_round(NOV).sliceStarting, 100e24, "carol parked until November settles");
    }

    function test_createPlan_revertsOnBadInputsAndAcceptsTheMinimum() public {
        usdt.mint(alice, 10_000e18);
        vm.startPrank(alice);
        usdt.approve(address(dca), type(uint256).max);

        vm.expectRevert(ISmartDCA.InvalidBuys.selector);
        dca.createPlan(pairId, 100e18, 1);
        vm.expectRevert(ISmartDCA.InvalidBuys.selector);
        dca.createPlan(pairId, 1000e18, 61);
        vm.expectRevert(ISmartDCA.DepositTooSmall.selector);
        dca.createPlan(pairId, 120e18 - 1, 12);
        // Exactly the minimum, 10 USDT per buy
        dca.createPlan(pairId, 120e18, 12);
        vm.expectRevert(ISmartDCA.InvalidPair.selector);
        dca.createPlan(0, 120e18, 12);
        vm.expectRevert(ISmartDCA.InvalidPair.selector);
        dca.createPlan(2, 120e18, 12);
        vm.stopPrank();

        dca.setPairEnabled(pairId, false);
        vm.prank(alice);
        vm.expectRevert(ISmartDCA.PairDisabled.selector);
        dca.createPlan(pairId, 120e18, 12);
    }

    // ----- topUp (TD 3.3 worked example: fee 5%, unit value 1.000 then 1.001) -----

    function test_topUp_restartsTheSchedule() public {
        uint256 id = _create(alice, 1200e18, 12);
        hub.setPricePerShare(1.001e18);
        _runRound(1);
        assertEq(usdt.balanceOf(reserve), 0.005e18, "fee on 0.10 of interest");

        _topUp(alice, id, 550e18);

        ISmartDCA.Plan memory p = _plan(id);
        uint256 minted = 549_450_549_450_549_450_549_450_549; // 550 / 1.001, in 24-decimal units
        assertEq(p.firstRound, DEC);
        assertEq(p.buys, 11);
        assertEq(p.buysDone, 1);
        assertEq(p.stableUnits, 1100e24 + minted);
        assertEq(p.slice, (1100e24 + minted) / 11);
        assertEq(p.base, 150e18);
        assertEq(p.carriedBought, 5_004_750, "November: 1.00095e15 BTCB in vBTC units");
        assertEq(_pair().dueUnits, p.slice);
        assertEq(_pair().dueBase, 150e18);
        assertEq(_round(NOV + 11).sliceEnding, p.slice, "last round unchanged");
    }

    function test_cancel_afterTopUp_matchesWorkedExample() public {
        uint256 id = _create(alice, 1200e18, 12);
        hub.setPricePerShare(1.001e18);
        _runRound(1);
        _topUp(alice, id, 550e18);
        uint256 reserveBefore = usdt.balanceOf(reserve);

        vm.prank(alice);
        dca.cancel(id);

        // W = 1,651.10, fee = (1,651.10 - 150 x 11) x 5% = 0.055
        assertApproxEqAbs(usdt.balanceOf(alice), 1651.045e18, 1e12);
        assertApproxEqAbs(usdt.balanceOf(reserve) - reserveBefore, 0.055e18, 1e12);
        // Everything bought in November: 100.095 USDT at 100,000, less up to one vBTC of rounding
        assertApproxEqAbs(btcb.balanceOf(alice), 1.00095e15, 2e8);
        assertEq(uint8(_plan(id).status), uint8(ISmartDCA.PlanStatus.Cancelled));
        assertEq(_pair().dueUnits, 0);
        assertEq(_pair().dueBase, 0);
    }

    function test_cancel_beforeAnyBuy_returnsDepositWithoutFee() public {
        uint256 id = _create(alice, 1200e18, 12);
        assertEq(hub.balanceOf(address(dca)), 1200e24);
        vm.expectEmit(address(dca));
        emit ISmartDCA.PlanCancelled(id, 1200e18, 0, 0);
        vm.prank(alice);
        dca.cancel(id);
        assertEq(usdt.balanceOf(alice), 1200e18);
        assertEq(usdt.balanceOf(reserve), 0);
        assertEq(_round(NOV + 11).sliceEnding, 0);
        assertEq(_pair().dueUnits, 0);
        assertEq(_pair().dueBase, 0);
        assertEq(hub.balanceOf(address(dca)), 0, "Hub shares burned");
    }

    function test_cancel_revertsForOthersAndTwice() public {
        uint256 id = _create(alice, 1200e18, 12);
        vm.prank(bob);
        vm.expectRevert(ISmartDCA.NotPlanOwner.selector);
        dca.cancel(id);

        vm.startPrank(alice);
        dca.cancel(id);
        vm.expectRevert(ISmartDCA.PlanNotActive.selector);
        dca.cancel(id);
        vm.stopPrank();
    }

    // ----- lock gating -----

    /// @dev November settled, December swapped but not settled: top up and cancel wait, withdraw pays November only
    function test_lock_freezesPlansInTheRunningRound() public {
        uint256 id = _create(alice, 1200e18, 12);
        _runRound(1);

        vm.warp(dca.lockTime(pairId));
        vm.startPrank(keeper);
        dca.startBuy(pairId, 1);
        dca.executeOrder(pairId, ANY_QUOTE, _swapData(pairId));
        vm.stopPrank();
        assertGt(_round(DEC).amountOut, 0, "December bought, not settled");

        usdt.mint(alice, 100e18);
        vm.startPrank(alice);
        usdt.approve(address(dca), 100e18);
        vm.expectRevert(ISmartDCA.PlanInRunningRound.selector);
        dca.topUp(id, 100e18);
        vm.expectRevert(ISmartDCA.PlanInRunningRound.selector);
        dca.cancel(id);
        vm.expectEmit(address(dca));
        emit ISmartDCA.BoughtWithdrawn(id, 5e6, 1e15);
        dca.withdrawBought(id, type(uint256).max);
        vm.stopPrank();

        assertEq(btcb.balanceOf(alice), 1e15, "November's 100 USDT at 100,000 only");
    }

    function test_lock_planCreatedDuringLockCanCancel() public {
        _create(alice, 1200e18, 12);
        vm.warp(NOV_LOCK + 1 hours);
        uint256 id = _create(carol, 300e18, 3);

        vm.prank(carol);
        dca.cancel(id);

        assertEq(usdt.balanceOf(carol), 300e18);
        assertEq(_round(NOV).sliceStarting, 0);
        assertEq(_pair().dueUnits, 100e24, "alice untouched");
    }

    // ----- withdrawBought -----

    function test_withdrawBought_partThenAll() public {
        uint256 id = _create(alice, 1200e18, 12);
        _runRound(1);

        vm.prank(alice);
        dca.withdrawBought(id, 0.0005e15);
        assertGe(btcb.balanceOf(alice), 0.0005e15);

        uint256 rest = _withdrawAll(alice, id);
        assertApproxEqAbs(btcb.balanceOf(alice), 1e15, 2e8, "100 USDT at 100,000");
        assertGt(rest, 0);

        vm.prank(alice);
        vm.expectRevert(ISmartDCA.ZeroAmount.selector);
        dca.withdrawBought(id, type(uint256).max);
    }

    /// @dev Nothing bought yet, so the asset's pool is empty: a clean revert, not a division by zero
    function test_withdrawBought_revertsBeforeAnyBuy() public {
        uint256 id = _create(alice, 1200e18, 12);
        vm.prank(alice);
        vm.expectRevert(ISmartDCA.ZeroAmount.selector);
        dca.withdrawBought(id, 1);
    }

    function test_withdrawBought_revertsAboveBought() public {
        uint256 id = _create(alice, 1200e18, 12);
        _runRound(1);
        vm.prank(alice);
        vm.expectRevert(ISmartDCA.InsufficientBought.selector);
        dca.withdrawBought(id, 1e18);
    }

    // ----- claim -----

    function test_claim_toWalletAfterLastBuy() public {
        uint256 id = _create(alice, 100e18, 2);
        _runRound(1);

        vm.prank(alice);
        vm.expectRevert(ISmartDCA.PlanNotMatured.selector);
        dca.claim(id, false);

        _runRound(1);
        vm.prank(alice);
        dca.claim(id, false);

        assertApproxEqAbs(btcb.balanceOf(alice), 1e15, 4e8, "100 USDT at 100,000");
        assertEq(uint8(_plan(id).status), uint8(ISmartDCA.PlanStatus.Done));
        assertEq(_pair().dueUnits, 0, "plan left the pair after its last round");

        vm.prank(alice);
        vm.expectRevert(ISmartDCA.PlanNotActive.selector);
        dca.claim(id, false);
    }

    function test_claim_toCoreSendsVTokens() public {
        uint256 id = _create(alice, 100e18, 2);
        _runRound(1);
        _runRound(1);

        vm.prank(alice);
        dca.claim(id, true);

        assertEq(btcb.balanceOf(alice), 0);
        assertApproxEqAbs(vBTC.balanceOf(alice), 5e6, 2, "1e15 BTCB at 2e26 per vBTC");
    }

    function test_maturedPlan_cannotTopUpOrCancel() public {
        uint256 id = _create(alice, 100e18, 2);
        _runRound(1);
        _runRound(1);

        usdt.mint(alice, 100e18);
        vm.startPrank(alice);
        usdt.approve(address(dca), 100e18);
        vm.expectRevert(ISmartDCA.PlanMatured.selector);
        dca.topUp(id, 100e18);
        vm.expectRevert(ISmartDCA.PlanMatured.selector);
        dca.cancel(id);
        vm.stopPrank();
    }

    // ----- events, edge inputs and source failures -----

    function test_createPlan_emitsPlanCreated() public {
        usdt.mint(alice, 1200e18);
        vm.startPrank(alice);
        usdt.approve(address(dca), 1200e18);
        vm.expectEmit(address(dca));
        emit ISmartDCA.PlanCreated(1, alice, pairId, 1200e18, 1200e24, 100e24, 100e18, 12, NOV);
        dca.createPlan(pairId, 1200e18, 12);
        vm.stopPrank();
    }

    function test_createPlan_revertsWhenTheSliceIsZeroUnits() public {
        dca.setMinPerBuy(address(usdt), 1);
        hub.setPricePerShare(1e30); // 1 wei of USDT mints 1e-6 of a unit
        usdt.mint(alice, 2);
        vm.startPrank(alice);
        usdt.approve(address(dca), 2);
        vm.expectRevert(ISmartDCA.DepositTooSmall.selector);
        dca.createPlan(pairId, 2, 2);
        vm.stopPrank();
    }

    function test_createPlan_revertsWhenTheHubRefuses() public {
        hub.setDepositPaused(true);
        usdt.mint(alice, 1200e18);
        vm.startPrank(alice);
        usdt.approve(address(dca), 1200e18);
        vm.expectRevert(bytes("hub paused"));
        dca.createPlan(pairId, 1200e18, 12);
        vm.stopPrank();
    }

    /// @dev Months with nothing due settle on the next call, so the plan joins the month after now
    function test_createPlan_afterEmptyMonthsSkipsThem() public {
        vm.warp(SmartDCAMath.roundStart(DEC) + 1 days);
        uint256 id = _create(alice, 1200e18, 12);
        assertEq(_pair().lastSettledRound, DEC);
        assertEq(_plan(id).firstRound, DEC + 1);
        assertEq(_pair().dueUnits, 100e24, "joins the next round directly");
    }

    function test_topUp_ofAPlanParkedDuringLock() public {
        _create(alice, 1200e18, 12);
        vm.warp(NOV_LOCK + 1 hours);
        uint256 id = _create(carol, 300e18, 3);

        usdt.mint(carol, 300e18);
        vm.startPrank(carol);
        usdt.approve(address(dca), 300e18);
        vm.expectEmit(address(dca));
        emit ISmartDCA.PlanToppedUp(id, 300e18, 300e24, 200e24, 200e18, 3);
        dca.topUp(id, 300e18);
        vm.stopPrank();

        assertEq(_plan(id).firstRound, DEC);
        assertEq(_round(NOV).sliceStarting, 200e24);
        assertEq(_pair().dueUnits, 100e24, "November unchanged");
    }

    function test_topUp_revertsBelowTheMinimumForTheBuysLeft() public {
        uint256 id = _create(alice, 1200e18, 12);
        _runRound(1);
        usdt.mint(alice, 110e18);
        vm.startPrank(alice);
        usdt.approve(address(dca), 110e18);
        vm.expectRevert(ISmartDCA.DepositTooSmall.selector);
        dca.topUp(id, 110e18 - 1); // 11 buys left at 10 USDT each
        dca.topUp(id, 110e18);
        vm.stopPrank();
    }

    /// @dev After a move to a source with another rate, units and shares differ, so rounding matters
    function test_withdrawBought_paysAtLeastTheAmountAfterASourceMove() public {
        uint256 id = _create(alice, 1200e18, 12);
        _runRound(1);
        MockVToken vBTC2 = new MockVToken(address(btcb), 3e26 + 7);
        comptroller.list(address(vBTC2));
        dca.setYieldSource(address(btcb), ISmartDCA.SourceKind.Core, address(vBTC2));

        vm.prank(alice);
        dca.withdrawBought(id, 0.3e15 + 7);
        assertGe(btcb.balanceOf(alice), 0.3e15 + 7);
    }

    /// @dev W = 1,100 units x 1.001 = 1,101.10. Fee = (1,101.10 - 100 x 11) x 5% = 0.055.
    function test_cancel_afterASettledRoundChargesFeeOnTheBuysLeft() public {
        uint256 id = _create(alice, 1200e18, 12);
        hub.setPricePerShare(1.001e18);
        _runRound(1);
        uint256 reserveBefore = usdt.balanceOf(reserve);

        vm.expectEmit(address(dca));
        emit ISmartDCA.PlanCancelled(id, 1101.045e18, 0.055e18, 1.00095e15);
        vm.prank(alice);
        dca.cancel(id);

        assertEq(usdt.balanceOf(alice), 1101.045e18);
        assertEq(usdt.balanceOf(reserve) - reserveBefore, 0.055e18);
        assertApproxEqAbs(btcb.balanceOf(alice), 1.00095e15, 2e8);
    }

    function test_cancel_revertsWhenTheHubCannotPay() public {
        uint256 id = _create(alice, 1200e18, 12);
        hub.setRedeemPaused(true);
        vm.prank(alice);
        vm.expectRevert(bytes("hub paused"));
        dca.cancel(id);
    }

    /// @dev The vToken rate moved after the buy, so units and shares no longer divide evenly
    function test_withdrawBought_paysAtLeastTheAmountAfterTheRateMoves() public {
        uint256 id = _create(alice, 1200e18, 12);
        _runRound(1);
        vBTC.setExchangeRate(2.000_000_3e26);

        // 0.3e15 + 7 BTCB at the new rate rounds up to 1.5e6 vBTC, which pays 0.3e15 + 45e6
        vm.expectEmit(address(dca));
        emit ISmartDCA.BoughtWithdrawn(id, 1.5e6, 0.3e15 + 45e6);
        vm.prank(alice);
        dca.withdrawBought(id, 0.3e15 + 7);
        assertGe(btcb.balanceOf(alice), 0.3e15 + 7);
    }

    function test_withdrawBought_revertsWhenCoreCannotPay() public {
        uint256 id = _create(alice, 1200e18, 12);
        _runRound(1);
        vBTC.setErrors(0, 14);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ISmartDCA.SourceCallFailed.selector, address(vBTC), 14));
        dca.withdrawBought(id, type(uint256).max);
    }

    /// @dev The pair's next round is locked for other plans, but a matured plan is in none of it
    function test_claim_duringTheNextLock() public {
        uint256 id = _create(alice, 100e18, 2);
        _create(bob, 1200e18, 12);
        _runRound(1);
        _runRound(1);
        vm.warp(dca.lockTime(pairId));

        vm.expectEmit(address(dca));
        emit ISmartDCA.PlanClaimed(id, false, 1e15);
        vm.prank(alice);
        dca.claim(id, false);
        assertEq(uint8(_plan(id).status), uint8(ISmartDCA.PlanStatus.Done));
    }
}
