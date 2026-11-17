// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

// solhint-disable func-name-mixedcase, ordering, import-path-check, gas-strict-inequalities

import { Vm } from "forge-std/Vm.sol";
import { ISmartDCA } from "../../../contracts/SmartDCA/ISmartDCA.sol";
import { SmartDCAMath } from "../../../contracts/SmartDCA/SmartDCAMath.sol";
import { MockERC20 } from "./mocks/MockERC20.sol";
import { MockVToken } from "./mocks/SmartDCAMocks.sol";
import { SmartDCABase } from "./SmartDCABase.t.sol";

contract SmartDCA_RoundsTest is SmartDCABase {
    /// @dev TD section 9: Alice and Bob in November, Carol joins during Lock, part 2 misses minOut once
    function test_workedExample_novemberRound() public {
        uint256 aliceId = _create(alice, 1200e18, 12);
        vm.warp(NOV_LOCK - 14 days);
        uint256 bobId = _create(bob, 600e18, 6);
        assertEq(_pair().dueUnits, 200e24);
        assertEq(_pair().dueBase, 200e18);

        vm.warp(NOV_LOCK + 1 hours);
        hub.setPricePerShare(1.001e18);
        uint256 carolId = _create(carol, 300e18, 3);
        assertEq(_plan(carolId).firstRound, DEC);

        vm.prank(keeper);
        dca.startBuy(pairId, 2);
        ISmartDCA.Round memory r = _round(NOV);
        assertEq(r.stableOut, 200.2e18);
        assertEq(r.stableOut - r.net, 0.01e18);
        assertEq(r.net, 200.19e18);
        assertEq(usdt.balanceOf(reserve), 0.01e18);

        // Each part sells 100.095 USDT, quoted at 100,000: 0.00100095 BTCB
        vm.prank(keeper);
        dca.executeOrder(pairId, 1.00095e15, _swapData(pairId));

        // The pool moves 0.2% after the quote: part 2 reverts and is retried next block with a fresh quote
        swapHelper.setRate(0.998e13);
        vm.prank(keeper);
        vm.expectPartialRevert(ISmartDCA.SlippageExceeded.selector);
        dca.executeOrder(pairId, 1.00095e15, _swapData(pairId));
        swapHelper.setRate(1e13);
        vm.roll(block.number + 1);
        vm.prank(keeper);
        dca.executeOrder(pairId, 1.00095e15, _swapData(pairId));

        // Carol is not in this round, so she can still leave
        vm.prank(carol);
        dca.cancel(carolId);
        assertApproxEqAbs(usdt.balanceOf(carol), 300e18, 1);

        vm.prank(keeper);
        dca.settle(pairId);
        assertEq(_pair().lastSettledRound, NOV);
        assertEq(dca.lockTime(pairId), SmartDCAMath.roundStart(DEC));

        // Both put 100.095 into the round, so both get half of 200.19 USDT of BTCB
        uint256 aliceGot = _withdrawAll(alice, aliceId);
        uint256 bobGot = _withdrawAll(bob, bobId);
        assertApproxEqAbs(aliceGot, bobGot, 2e8);
        assertApproxEqAbs(aliceGot + bobGot, 2.0019e15, 4e8);
    }

    function test_callers_keeperFromLockBackupFromNineHours() public {
        _create(alice, 1200e18, 12);

        vm.prank(makeAddr("stranger"));
        vm.expectRevert(ISmartDCA.NotAllowedCaller.selector);
        dca.startBuy(pairId, 1);

        vm.warp(NOV_LOCK - 1);
        vm.prank(keeper);
        vm.expectRevert(ISmartDCA.PairNotLocked.selector);
        dca.startBuy(pairId, 1);

        vm.warp(NOV_LOCK + 9 hours - 1);
        vm.prank(backup);
        vm.expectRevert(ISmartDCA.BackupTooEarly.selector);
        dca.startBuy(pairId, 1);

        vm.warp(NOV_LOCK + 9 hours);
        vm.startPrank(backup);
        dca.startBuy(pairId, 1);
        dca.executeOrder(pairId, ANY_QUOTE, _swapData(pairId));
        dca.settle(pairId);
        vm.stopPrank();
        assertEq(_pair().lastSettledRound, NOV);
    }

    function test_roundCalls_enforceOrder() public {
        _create(alice, 1200e18, 12);
        vm.warp(NOV_LOCK);
        vm.startPrank(keeper);

        vm.expectRevert(ISmartDCA.PairNotExecuting.selector);
        dca.executeOrder(pairId, ANY_QUOTE, _swapData(pairId));
        vm.expectRevert(ISmartDCA.PairNotExecuting.selector);
        dca.settle(pairId);
        vm.expectRevert(ISmartDCA.InvalidParts.selector);
        dca.startBuy(pairId, 0);
        vm.expectRevert(ISmartDCA.InvalidParts.selector);
        dca.startBuy(pairId, 11);

        dca.startBuy(pairId, 2);
        vm.expectRevert(ISmartDCA.BuyAlreadyStarted.selector);
        dca.startBuy(pairId, 2);
        vm.expectRevert(ISmartDCA.PartsLeft.selector);
        dca.settle(pairId);

        dca.executeOrder(pairId, ANY_QUOTE, _swapData(pairId));
        dca.executeOrder(pairId, ANY_QUOTE, _swapData(pairId));
        vm.expectRevert(ISmartDCA.NoPartsLeft.selector);
        dca.executeOrder(pairId, ANY_QUOTE, _swapData(pairId));
        vm.stopPrank();
    }

    function test_emptyRound_settlesWithoutSwap() public {
        vm.warp(NOV_LOCK);
        vm.prank(keeper);
        dca.startBuy(pairId, 1);

        assertEq(_pair().lastSettledRound, NOV);
        assertEq(_round(NOV).partsTotal, 0);
        assertEq(dca.lockTime(pairId), SmartDCAMath.roundStart(DEC));
    }

    function test_overrun_nextRoundCanStartAtOnce() public {
        _create(alice, 1200e18, 12);
        vm.warp(NOV_LOCK);
        vm.startPrank(keeper);
        dca.startBuy(pairId, 1);
        dca.executeOrder(pairId, ANY_QUOTE, _swapData(pairId));

        vm.warp(SmartDCAMath.roundStart(DEC) + 1 days);
        dca.settle(pairId);
        assertEq(_pair().lastSettledRound, NOV);

        // December's lock has passed, so its round starts right away
        dca.startBuy(pairId, 1);
        assertEq(_round(DEC).partsTotal, 1);
        vm.stopPrank();
    }

    function test_settle_retriesAfterCoreMintFails() public {
        _create(alice, 1200e18, 12);
        vm.warp(NOV_LOCK);
        vm.startPrank(keeper);
        dca.startBuy(pairId, 1);
        dca.executeOrder(pairId, ANY_QUOTE, _swapData(pairId));

        vBTC.setErrors(9, 0);
        vm.expectRevert(abi.encodeWithSelector(ISmartDCA.SourceCallFailed.selector, address(vBTC), 9));
        dca.settle(pairId);
        assertEq(_round(NOV).amountOut, 1e15, "swap kept");

        vBTC.setErrors(0, 0);
        dca.settle(pairId);
        vm.stopPrank();
        assertEq(_pair().lastSettledRound, NOV);
    }

    function test_startBuy_retriesWhenHubCannotPay() public {
        _create(alice, 1200e18, 12);
        vm.warp(NOV_LOCK);
        hub.setRedeemPaused(true);
        vm.prank(keeper);
        vm.expectRevert(bytes("hub paused"));
        dca.startBuy(pairId, 1);

        hub.setRedeemPaused(false);
        vm.prank(keeper);
        dca.startBuy(pairId, 1);
        assertEq(_round(NOV).partsTotal, 1);
    }

    function test_sync_emitsLockEnteredOncePerRound() public {
        _create(alice, 1200e18, 12);
        vm.warp(NOV_LOCK);

        vm.expectEmit(address(dca));
        emit ISmartDCA.LockEntered(pairId, NOV);
        dca.sync(pairId);

        vm.recordLogs();
        dca.sync(pairId);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 0);
    }

    /// @dev Pooled result equals the per-plan PRD formula: P = E - max(0, E - B) x fee
    function testFuzz_pooledMatchesPerPlan(
        uint256 amountA,
        uint256 amountB,
        uint8 buysA,
        uint8 buysB,
        uint256 pps,
        uint16 feeRate
    ) public {
        amountA = bound(amountA, 1_000e18, 100_000e18);
        amountB = bound(amountB, 1_000e18, 100_000e18);
        buysA = uint8(bound(buysA, 2, 60));
        buysB = uint8(bound(buysB, 2, 60));
        pps = bound(pps, 0.9e18, 1.2e18);
        dca.setFeeRate(uint16(bound(feeRate, 0, 2_000)));

        uint256 idA = _create(alice, amountA, buysA);
        uint256 idB = _create(bob, amountB, buysB);
        hub.setPricePerShare(pps);
        _runRound(1);

        uint16 rate = _round(NOV).feeRate;
        uint256 pA = _pending(idA, pps, rate);
        uint256 pB = _pending(idB, pps, rate);
        uint256 total = _round(NOV).amountOut;
        uint256 gotA = _withdrawAll(alice, idA);
        uint256 gotB = _withdrawAll(bob, idB);

        // Rounding: one vBTC is 2e8 wei of BTCB, plus a little from the per-plan formula
        assertApproxEqAbs(gotA, (total * pA) / (pA + pB), 1e9);
        assertApproxEqAbs(gotB, (total * pB) / (pA + pB), 1e9);
        assertLe(gotA + gotB, total);
    }

    /// @dev PRD per-plan amount put into the round, `E x (1 - e) + B x e`, with `e` the round's one fee rate
    function _pending(uint256 planId, uint256 pps, uint16 rate) internal view returns (uint256) {
        ISmartDCA.Plan memory p = _plan(planId);
        uint256 e = (p.slice * pps) / 1e24;
        return (e * (10_000 - rate) + p.base * rate) / 10_000;
    }

    /// @dev Each settle keeps its rounding leftover, so the plans' rounded-down reads never exceed the pool
    function test_settle_lastPlanCanClaimAfterRoundingLeftovers() public {
        uint256 aliceId = _create(alice, 100e18 + 7, 3);
        uint256 bobId = _create(bob, 50e18 + 3, 3);
        swapHelper.setRate(1e13 + 3);
        hub.setPricePerShare(1.000_000_7e18);
        _runRound(1);
        _runRound(1);
        _runRound(1);

        vm.prank(alice);
        dca.claim(aliceId, false);
        vm.prank(bob);
        dca.claim(bobId, false);

        // What is left is the rounding leftover: a few units per plan per round
        (, , uint256 shares, uint256 units) = dca.sources(address(btcb));
        assertEq(vBTC.balanceOf(address(dca)), shares);
        assertLe(units, 2 * 3 * 2);
    }

    // ----- swaps and the slippage bound -----

    function test_executeOrder_fillsInsideTheBound() public {
        _create(alice, 1200e18, 12);
        swapHelper.setRate(0.9995e13); // pays 0.05% under the quote, bound is 0.1%
        vm.warp(NOV_LOCK);
        vm.startPrank(keeper);
        dca.startBuy(pairId, 1);
        vm.expectEmit(address(dca));
        emit ISmartDCA.OrderExecuted(pairId, NOV, 1, 100e18, 0.9995e15, 1e15, 0.999e15);
        dca.executeOrder(pairId, 1e15, _swapData(pairId));
        vm.stopPrank();
        assertEq(usdt.balanceOf(address(dca)), 0, "the part was sent to SwapHelper");
        assertEq(btcb.balanceOf(address(dca)), 0.9995e15, "the asset came back");
        assertEq(_round(NOV).amountOut, 0.9995e15);
    }

    function test_executeOrder_revertsWhenTheSwapCallFails() public {
        _create(alice, 1200e18, 12);
        swapHelper.setFail(true);
        vm.warp(NOV_LOCK);
        vm.startPrank(keeper);
        dca.startBuy(pairId, 1);
        vm.expectRevert(ISmartDCA.TokenSwapCallFailed.selector);
        dca.executeOrder(pairId, ANY_QUOTE, _swapData(pairId));
        vm.stopPrank();
        assertEq(_round(NOV).partsDone, 0);
        assertEq(usdt.balanceOf(address(dca)), 100e18, "the stable stays here");
    }

    /// @dev minOut = quotedOut x 9,990 / 10,000, rounded down. The swap pays 0.001 BTCB; a quote of 1,001,001,001,001,002
    ///      wei gives minOut exactly 0.001 and fills, one wei more of quote makes minOut 1 wei above the fill and
    ///      reverts. The oracle price (80,000 here, not the swap's 100,000) plays no part.
    function test_executeOrder_minOutIsTheQuoteLessMaxSlippage() public {
        _create(alice, 1200e18, 12);
        oracle.setPrice(address(btcb), 80_000e18);
        vm.warp(NOV_LOCK);
        vm.startPrank(keeper);
        dca.startBuy(pairId, 1);

        uint256 quote = 1_001_001_001_001_002;
        vm.expectRevert(abi.encodeWithSelector(ISmartDCA.SlippageExceeded.selector, 1e15, 1e15 + 1));
        dca.executeOrder(pairId, quote + 1, _swapData(pairId));

        vm.expectEmit(address(dca));
        emit ISmartDCA.OrderExecuted(pairId, NOV, 1, 100e18, 1e15, quote, 1e15);
        dca.executeOrder(pairId, quote, _swapData(pairId));
        vm.stopPrank();
    }

    /// @dev Pool fee 0.25%: each 100 USDT part pays 0.0009975 BTCB, which is the quote, so minOut is 0.0009965025.
    ///      The pool then moves 0.2% before part 2, which pays 0.000995505 against the same quote and reverts.
    function test_executeOrder_poolFeeFillsAtTheQuoteAndAMoveBelowTheBoundReverts() public {
        swapHelper.setFeeBps(25);
        _create(alice, 2400e18, 12);
        vm.warp(NOV_LOCK);
        vm.startPrank(keeper);
        dca.startBuy(pairId, 2);

        uint256 quote = _quote(pairId);
        assertEq(quote, 0.9975e15);
        vm.expectEmit(address(dca));
        emit ISmartDCA.OrderExecuted(pairId, NOV, 1, 100e18, 0.9975e15, quote, 0.9965025e15);
        dca.executeOrder(pairId, quote, _swapData(pairId));

        swapHelper.setRate(0.998e13);
        vm.expectRevert(abi.encodeWithSelector(ISmartDCA.SlippageExceeded.selector, 0.995505e15, 0.9965025e15));
        dca.executeOrder(pairId, quote, _swapData(pairId));
        vm.stopPrank();
    }

    function test_executeOrder_revertsOnAZeroQuote() public {
        _create(alice, 1200e18, 12);
        vm.warp(NOV_LOCK);
        vm.startPrank(keeper);
        dca.startBuy(pairId, 1);
        vm.expectRevert(ISmartDCA.ZeroAmount.selector);
        dca.executeOrder(pairId, 0, _swapData(pairId));
        vm.stopPrank();
    }

    // ----- resplit -----

    /// @dev Before any part and after two of three, with a round that does not divide evenly; once per round
    function test_resplit_atAnyPointSwapsTheExactRemainder() public {
        _create(alice, 1000e18 + 7, 10);
        vm.warp(NOV_LOCK);
        vm.startPrank(keeper);
        dca.startBuy(pairId, 3);
        uint256 net = _round(NOV).net;

        vm.expectRevert(ISmartDCA.InvalidParts.selector);
        dca.resplit(pairId, 0);
        vm.expectRevert(ISmartDCA.InvalidParts.selector);
        dca.resplit(pairId, 11);

        vm.expectEmit(address(dca));
        emit ISmartDCA.OrderResplit(pairId, NOV, 0, 4);
        dca.resplit(pairId, 4);
        for (uint256 i; i < 4; ++i) dca.executeOrder(pairId, ANY_QUOTE, _swapData(pairId));
        assertEq(_round(NOV).toSwap, 0);
        assertEq(_round(NOV).amountOut, ((net / 4) * 3) / 1e5 + (net - (net / 4) * 3) / 1e5);
        dca.settle(pairId);

        vm.warp(SmartDCAMath.roundStart(DEC));
        dca.startBuy(pairId, 3);
        dca.executeOrder(pairId, ANY_QUOTE, _swapData(pairId));
        dca.executeOrder(pairId, ANY_QUOTE, _swapData(pairId));
        dca.resplit(pairId, 2);
        assertEq(_round(DEC).partsTotal, 4);
        vm.expectRevert(ISmartDCA.AlreadyResplit.selector);
        dca.resplit(pairId, 2);
        dca.executeOrder(pairId, ANY_QUOTE, _swapData(pairId));
        dca.executeOrder(pairId, ANY_QUOTE, _swapData(pairId));
        assertEq(_round(DEC).toSwap, 0);
        vm.stopPrank();
    }

    function test_resplit_revertsWhenEveryPartIsSwapped() public {
        _create(alice, 1200e18, 12);
        vm.warp(NOV_LOCK);
        vm.startPrank(keeper);
        dca.startBuy(pairId, 1);
        dca.executeOrder(pairId, ANY_QUOTE, _swapData(pairId));
        vm.expectRevert(ISmartDCA.NoPartsLeft.selector);
        dca.resplit(pairId, 2);
        vm.stopPrank();
    }

    /// @dev A second pair stuck on slippage stops only its own round
    function test_pairIsolation_otherPairSettlesWhileOneIsStuck() public {
        MockERC20 eth = new MockERC20("ETH", "ETH", 18);
        MockVToken vETH = new MockVToken(address(eth), VBTC_RATE);
        comptroller.list(address(vETH));
        oracle.setPrice(address(eth), BTC_PRICE);
        dca.setYieldSource(address(eth), ISmartDCA.SourceKind.Core, address(vETH));
        uint32 ethPairId = dca.addPair(address(usdt), address(eth));

        _create(alice, 1200e18, 12);
        usdt.mint(bob, 1200e18);
        vm.startPrank(bob);
        usdt.approve(address(dca), 1200e18);
        dca.createPlan(ethPairId, 1200e18, 12);
        vm.stopPrank();

        vm.warp(NOV_LOCK);
        vm.startPrank(keeper);
        dca.startBuy(ethPairId, 1);
        // Quoted 1% above what the pool pays
        vm.expectPartialRevert(ISmartDCA.SlippageExceeded.selector);
        dca.executeOrder(ethPairId, 1.01e15, _swapData(ethPairId));

        dca.startBuy(pairId, 1);
        dca.executeOrder(pairId, ANY_QUOTE, _swapData(pairId));
        dca.settle(pairId);
        vm.stopPrank();
        assertEq(_pair().lastSettledRound, NOV);
    }

    // ----- round events -----

    function test_round_emitsEachStep() public {
        _create(alice, 1200e18, 12);
        hub.setPricePerShare(1.001e18);
        vm.warp(NOV_LOCK);
        vm.startPrank(keeper);

        vm.expectEmit(address(dca));
        emit ISmartDCA.LockEntered(pairId, NOV);
        vm.expectEmit(address(dca));
        emit ISmartDCA.FeeCollected(pairId, 0, 0.005e18);
        vm.expectEmit(address(dca));
        emit ISmartDCA.BuyStarted(pairId, NOV, 1, 100e24, 100.1e18, 100.095e18);
        dca.startBuy(pairId, 1);
        dca.executeOrder(pairId, ANY_QUOTE, _swapData(pairId));

        // amountOut 100.095 / 100,000 BTCB; units at 1 vBTC = 0.02 BTCB, in 8 decimals
        vm.expectEmit(address(dca));
        emit ISmartDCA.PairSettled(pairId, NOV, 100.1e18, 0.005e18, 1.00095e15, 5_004_750, 47_547_500e9, 2_500e18);
        dca.settle(pairId);
        vm.stopPrank();
    }

    function test_startBuy_revertsWhenTheRoundRedeemsNothing() public {
        _create(alice, 1200e18, 12);
        hub.setPricePerShare(0);
        vm.warp(NOV_LOCK);
        vm.prank(keeper);
        vm.expectRevert(ISmartDCA.ZeroAmount.selector);
        dca.startBuy(pairId, 1);
    }

    /// @dev Every whenNotPaused call stops, and a round paused halfway finishes after unpause
    function test_pause_stopsEveryCallAndARoundResumesAfter() public {
        uint256 id = _create(alice, 100e18, 2);
        _runRound(1);
        dca.pause();
        vm.warp(dca.lockTime(pairId));
        vm.prank(keeper);
        vm.expectRevert(bytes("Pausable: paused"));
        dca.startBuy(pairId, 2);
        vm.expectRevert(bytes("Pausable: paused"));
        dca.sync(pairId);

        dca.unpause();
        vm.startPrank(keeper);
        dca.startBuy(pairId, 2);
        dca.executeOrder(pairId, ANY_QUOTE, _swapData(pairId));
        vm.stopPrank();

        dca.pause();
        uint32 round = _pair().lastSettledRound + 1;
        ISmartDCA.Round memory before = _round(round);
        uint256 stableHeld = usdt.balanceOf(address(dca));
        uint256 assetHeld = btcb.balanceOf(address(dca));
        vm.startPrank(keeper);
        vm.expectRevert(bytes("Pausable: paused"));
        dca.executeOrder(pairId, ANY_QUOTE, _swapData(pairId));
        vm.expectRevert(bytes("Pausable: paused"));
        dca.resplit(pairId, 2);
        vm.expectRevert(bytes("Pausable: paused"));
        dca.settle(pairId);
        vm.stopPrank();
        vm.startPrank(alice);
        vm.expectRevert(bytes("Pausable: paused"));
        dca.createPlan(pairId, 100e18, 2);
        vm.expectRevert(bytes("Pausable: paused"));
        dca.topUp(id, 100e18);
        vm.expectRevert(bytes("Pausable: paused"));
        dca.withdrawBought(id, type(uint256).max);
        vm.expectRevert(bytes("Pausable: paused"));
        dca.cancel(id);
        vm.expectRevert(bytes("Pausable: paused"));
        dca.claim(id, false);
        vm.stopPrank();
        assertEq(_round(round).toSwap, before.toSwap, "toSwap frozen");
        assertEq(_round(round).amountOut, before.amountOut, "amountOut frozen");
        assertEq(usdt.balanceOf(address(dca)), stableHeld);
        assertEq(btcb.balanceOf(address(dca)), assetHeld);

        dca.unpause();
        vm.startPrank(keeper);
        dca.executeOrder(pairId, ANY_QUOTE, _swapData(pairId));
        dca.settle(pairId);
        vm.stopPrank();
        vm.prank(alice);
        dca.claim(id, false);
    }
}
