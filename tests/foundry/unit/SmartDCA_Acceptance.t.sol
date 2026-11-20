// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

// solhint-disable func-name-mixedcase, ordering, import-path-check

import { ISmartDCA } from "../../../contracts/SmartDCA/ISmartDCA.sol";
import { SmartDCALens } from "../../../contracts/SmartDCA/SmartDCALens.sol";
import { SmartDCAMath } from "../../../contracts/SmartDCA/SmartDCAMath.sol";
import { MockERC20 } from "./mocks/MockERC20.sol";
import { MockHub, MockVToken } from "./mocks/SmartDCAMocks.sol";
import { SmartDCABase } from "./SmartDCABase.t.sol";

/// @notice PRD section 9 acceptance cases and the PRD comment decisions
contract SmartDCA_AcceptanceTest is SmartDCABase {
    uint32 internal constant JAN = DEC + 1;

    // ----- cutoff during an overrun (acceptance 14, decisions 4a and 4b) -----

    /// @dev November still executing on Dec 20: a new plan joins December, which buys right after November settles
    function test_createPlan_duringOverrunJoinsTheRoundAfterTheStuckOne() public {
        _create(alice, 1200e18, 12);
        _startAndSwap(1);

        vm.warp(dca.roundStart(DEC) + 6 days);
        uint256 id = _create(carol, 300e18, 3);
        assertEq(_plan(id).scheduleFirstRound, DEC);
        assertEq(_round(NOV).stableUnitsJoining, 100e24, "parked until November settles");

        vm.startPrank(keeper);
        dca.settleRound(pairId);
        assertEq(_pair().roundStableUnits, 200e24, "alice and carol both in December");
        dca.startRound(pairId, 1);
        vm.stopPrank();
        assertEq(_round(DEC).stableRedeemed, 200e18);
    }

    /// @dev November and December both stuck: both settle back to back on the same day, then January starts
    function test_overrun_twoStuckRoundsSettleOnTheSameDay() public {
        _create(alice, 1200e18, 12);
        _startAndSwap(1);

        vm.warp(dca.roundStart(JAN) + 6 days);
        uint256 id = _create(carol, 300e18, 3);
        assertEq(_plan(id).scheduleFirstRound, DEC, "joins the round after the stuck one");

        vm.startPrank(keeper);
        dca.settleRound(pairId);
        dca.startRound(pairId, 1);
        dca.swapRoundPart(pairId, ANY_QUOTE, _swapData(pairId));
        dca.settleRound(pairId);
        assertEq(_pair().lastSettledRound, DEC);
        dca.startRound(pairId, 1);
        vm.stopPrank();
        assertEq(_round(JAN).partsTotal, 1, "January starts at once");
        assertEq(_round(DEC).stableRedeemed, 200e18, "carol bought in December");
    }

    // ----- RoundLocked on first touch (PRD 3.2) -----

    function test_createPlan_emitsRoundLockedOnFirstTouch() public {
        _create(alice, 1200e18, 12);
        vm.warp(NOV_LOCK);
        usdt.mint(carol, 300e18);
        vm.startPrank(carol);
        usdt.approve(address(dca), 300e18);
        vm.expectEmit(address(dca));
        emit ISmartDCA.RoundLocked(pairId, NOV);
        dca.createPlan(pairId, 300e18, 3, carol);
        vm.stopPrank();
        assertEq(_pair().lockEmittedRound, NOV);
    }

    function test_claimPlan_settlesEmptyRoundsAndEmitsRoundLocked() public {
        uint256 id = _create(alice, 100e18, 2);
        _create(bob, 1200e18, 12);
        _runRound(1);
        _runRound(1);

        vm.warp(dca.roundStart(JAN));
        vm.expectEmit(address(dca));
        emit ISmartDCA.RoundLocked(pairId, JAN);
        vm.prank(alice);
        dca.claimPlan(id, false, alice);
    }

    function test_claimPlan_settlesEmptyRoundsFirst() public {
        uint256 id = _create(alice, 100e18, 2);
        _runRound(1);
        _runRound(1);

        vm.warp(dca.roundStart(JAN) + 1);
        vm.prank(alice);
        dca.claimPlan(id, false, alice);
        assertEq(_pair().lastSettledRound, JAN, "empty January settled by claim");
    }

    // ----- acceptance 2: deposit minimum is minAmountPerBuy x buys -----

    function test_createPlan_minimumIsExactlyMinPerBuyTimesBuys() public {
        usdt.mint(alice, 1_000e18);
        vm.startPrank(alice);
        usdt.approve(address(dca), type(uint256).max);
        vm.expectPartialRevert(ISmartDCA.DepositTooSmall.selector);
        dca.createPlan(pairId, 20e18 - 1, 2, alice);
        dca.createPlan(pairId, 20e18, 2, alice);
        vm.expectPartialRevert(ISmartDCA.DepositTooSmall.selector);
        dca.createPlan(pairId, 600e18 - 1, 60, alice);
        dca.createPlan(pairId, 600e18, 60, alice);
        vm.stopPrank();
    }

    // ----- acceptance 4: the lock holds from lockTime with no call -----

    function test_lock_holdsWithNoStartRoundOrSyncPair() public {
        uint256 id = _create(alice, 300e18, 3);
        _runRound(1);
        vm.warp(dca.nextLockTime(pairId));

        usdt.mint(alice, 100e18);
        vm.startPrank(alice);
        usdt.approve(address(dca), 100e18);
        vm.expectRevert(ISmartDCA.PlanInRunningRound.selector);
        dca.topUpPlan(id, 100e18);
        vm.expectRevert(ISmartDCA.PlanInRunningRound.selector);
        dca.cancelPlan(id, alice);
        dca.withdrawBought(id, type(uint256).max, alice);
        vm.stopPrank();
        assertEq(btcb.balanceOf(alice), 1e15, "November only");
    }

    // ----- acceptance 5: round callers on swapRoundPart, resplit and settle -----

    function test_callers_executeResplitSettle() public {
        _create(alice, 1200e18, 12);
        vm.warp(NOV_LOCK);
        vm.prank(keeper);
        dca.startRound(pairId, 2);

        address stranger = makeAddr("stranger");
        vm.startPrank(stranger);
        vm.expectPartialRevert(ISmartDCA.NotRoundCaller.selector);
        dca.swapRoundPart(pairId, ANY_QUOTE, _swapData(pairId));
        vm.expectPartialRevert(ISmartDCA.NotRoundCaller.selector);
        dca.resplitRound(pairId, 3);
        vm.expectPartialRevert(ISmartDCA.NotRoundCaller.selector);
        dca.settleRound(pairId);
        vm.stopPrank();

        vm.startPrank(keeper);
        dca.resplitRound(pairId, 3);
        for (uint256 i; i < 3; ++i) dca.swapRoundPart(pairId, ANY_QUOTE, _swapData(pairId));
        dca.settleRound(pairId);
        vm.stopPrank();
        assertEq(_pair().lastSettledRound, NOV);
    }

    // ----- acceptance 8: resplit after two of four parts -----

    function test_resplitRound_sixEqualPartsAfterTwoOfFour() public {
        _create(alice, 1152e18, 12); // 96 USDT a round, 24 a part
        _startAndSwap(4);
        vm.startPrank(keeper);
        dca.swapRoundPart(pairId, ANY_QUOTE, _swapData(pairId));
        uint256 left = _round(NOV).stableToSwap;
        assertEq(left, 48e18);

        dca.resplitRound(pairId, 6);
        vm.expectRevert(ISmartDCA.AlreadyResplit.selector);
        dca.resplitRound(pairId, 3);
        for (uint256 i; i < 6; ++i) {
            uint256 before = _round(NOV).stableToSwap;
            dca.swapRoundPart(pairId, ANY_QUOTE, _swapData(pairId));
            assertEq(before - _round(NOV).stableToSwap, 8e18, "equal parts");
        }
        vm.stopPrank();
        assertEq(_round(NOV).stableToSwap, 0);
        assertEq(_round(NOV).partsTotal, 8);
    }

    // ----- acceptance 13: a plan made during Lock tops up while the pair executes -----

    function test_topUpPlan_ofALockPlanWhileExecutingJoinsNextRoundWithAllBuys() public {
        SmartDCALens lens = new SmartDCALens();
        _create(alice, 1200e18, 12);
        vm.warp(NOV_LOCK + 1 hours);
        uint256 id = _create(carol, 300e18, 3);
        vm.prank(keeper);
        dca.startRound(pairId, 1);

        _topUp(carol, id, 300e18);
        assertEq(_plan(id).scheduleFirstRound, DEC);
        assertEq(_plan(id).scheduleBuys, 3);

        vm.startPrank(keeper);
        dca.swapRoundPart(pairId, ANY_QUOTE, _swapData(pairId));
        dca.settleRound(pairId);
        vm.stopPrank();
        assertEq(_pair().roundStableUnits, 300e24, "alice 100 and carol 200");
        SmartDCALens.PlanView memory v = lens.getPlan(dca, id);
        assertEq(v.buysLeft, 3);
        assertEq(v.totalBuys, 3);
    }

    // ----- decision 3: a slippage stall is cleared by raising maxSlippageBps -----

    /// @dev Quote 0.001 BTCB, the pool pays 0.15% less: 0.1% reverts, 0.2% fills the same round

    function test_slippage_stallClearsAfterRaisingMaxSlippage() public {
        _create(alice, 1200e18, 12);
        swapHelper.setRate(0.9985e13);
        vm.warp(NOV_LOCK);
        vm.startPrank(keeper);
        dca.startRound(pairId, 1);
        vm.expectRevert(abi.encodeWithSelector(ISmartDCA.SlippageExceeded.selector, 0.9985e15, 0.999e15));
        dca.swapRoundPart(pairId, 1e15, _swapData(pairId));
        vm.stopPrank();

        vm.expectRevert(ISmartDCA.AboveHardCap.selector);
        dca.setMaxSlippage(101);
        dca.setMaxSlippage(20);

        vm.startPrank(keeper);
        dca.swapRoundPart(pairId, 1e15, _swapData(pairId));
        dca.settleRound(pairId);
        vm.stopPrank();
        assertEq(_pair().lastSettledRound, NOV);
    }

    // ----- decision 2: round gas does not grow with the number of plans -----

    function test_gas_roundCostIsFlatInPlanCount() public {
        uint256 snap = vm.snapshotState();
        (uint256 start1, uint256 settle1) = _roundGas(1);
        vm.revertToState(snap);
        (uint256 start100, uint256 settle100) = _roundGas(100);

        assertApproxEqAbs(start1, start100, 2_000, "startRound");
        assertApproxEqAbs(settle1, settle100, 2_000, "settle");
    }

    // ----- uncovered branches -----

    function test_withdrawBought_zeroAmountReverts() public {
        uint256 id = _create(alice, 1200e18, 12);
        _runRound(1);
        vm.prank(alice);
        vm.expectRevert(ISmartDCA.ZeroAmount.selector);
        dca.withdrawBought(id, 0, alice);
    }

    function test_withdrawBought_partialWithAHubAssetSource() public {
        MockHub btcHub = new MockHub(address(btcb));
        registry.set(address(btcHub), true);
        dca.setYieldSource(pairId, ISmartDCA.Side.Asset, ISmartDCA.SourceKind.Hub, address(btcHub));

        uint256 id = _create(alice, 1200e18, 12);
        _runRound(1);
        btcHub.setPricePerShare(1.25e18);

        vm.prank(alice);
        dca.withdrawBought(id, 0.5e15, alice);
        assertGe(btcb.balanceOf(alice), 0.5e15);
        assertLe(btcb.balanceOf(alice), 0.5e15 + 2);

        _withdrawAll(alice, id);
        assertApproxEqAbs(btcb.balanceOf(alice), 1.25e15, 2, "all of it at the new share price");
    }

    /// @dev A locked pair blocks only its own sources: the ETH pair's asset moves while the BTCB pair is locked
    function test_setYieldSource_lockCheckSkipsOtherPairs() public {
        MockERC20 eth = new MockERC20("ETH", "ETH", 18);
        MockVToken vETH = new MockVToken(address(eth), VBTC_RATE);
        MockVToken vETH2 = new MockVToken(address(eth), VBTC_RATE);
        comptroller.list(address(vETH));
        comptroller.list(address(vETH2));
        oracle.setPrice(address(eth), BTC_PRICE);
        uint32 ethPairId = _addPair(address(usdt), address(eth), address(hub), address(vETH));

        _create(alice, 1200e18, 12);
        usdt.mint(bob, 1200e18);
        vm.startPrank(bob);
        usdt.approve(address(dca), 1200e18);
        dca.createPlan(ethPairId, 1200e18, 12, bob);
        vm.stopPrank();

        // Both pairs buy in November, so both tokens hold shares; in December only the ETH pair settles
        _runRound(1);
        _runEthRound(ethPairId);
        vm.warp(dca.roundStart(DEC));
        _runEthRound(ethPairId);

        dca.setYieldSource(ethPairId, ISmartDCA.Side.Asset, ISmartDCA.SourceKind.Core, address(vETH2));
        (, address source, , ) = dca.yieldSources(ethPairId, ISmartDCA.Side.Asset);
        assertEq(source, address(vETH2));

        MockVToken vBTC2 = new MockVToken(address(btcb), VBTC_RATE);
        comptroller.list(address(vBTC2));
        vm.expectRevert(abi.encodeWithSelector(ISmartDCA.PairLocked.selector, pairId));
        dca.setYieldSource(pairId, ISmartDCA.Side.Asset, ISmartDCA.SourceKind.Core, address(vBTC2));
    }

    // ----- helpers -----

    function _startAndSwap(uint8 parts) internal {
        vm.warp(NOV_LOCK);
        vm.startPrank(keeper);
        dca.startRound(pairId, parts);
        dca.swapRoundPart(pairId, ANY_QUOTE, _swapData(pairId));
        vm.stopPrank();
    }

    function _runEthRound(uint32 ethPairId) internal {
        vm.startPrank(keeper);
        dca.startRound(ethPairId, 1);
        dca.swapRoundPart(ethPairId, ANY_QUOTE, _swapData(ethPairId));
        dca.settleRound(ethPairId);
        vm.stopPrank();
    }

    function _roundGas(uint256 plans) internal returns (uint256 startGas, uint256 settleGas) {
        for (uint256 i; i < plans; ++i) _create(address(uint160(0x1000 + i)), 120e18, 12);
        vm.warp(NOV_LOCK);
        vm.startPrank(keeper);
        uint256 g = gasleft();
        dca.startRound(pairId, 1);
        startGas = g - gasleft();
        dca.swapRoundPart(pairId, ANY_QUOTE, _swapData(pairId));
        g = gasleft();
        dca.settleRound(pairId);
        settleGas = g - gasleft();
        vm.stopPrank();
    }
}
