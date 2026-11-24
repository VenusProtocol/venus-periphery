// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

// solhint-disable func-name-mixedcase, ordering, import-path-check, gas-strict-inequalities

import { Vm } from "forge-std/Vm.sol";
import { ISmartDCA } from "../../../contracts/SmartDCA/ISmartDCA.sol";
import { SmartDCAMath } from "../../../contracts/SmartDCA/SmartDCAMath.sol";
import { MockERC20 } from "./mocks/MockERC20.sol";
import { MockSwapHelper, MockVToken, mockMulticall } from "./mocks/SmartDCAMocks.sol";
import { SmartDCABase } from "./SmartDCABase.t.sol";

contract SmartDCA_RoundsTest is SmartDCABase {
    /// @dev TD section 9: Alice and Bob in November, Carol joins during Lock, part 2 misses minOut once
    function test_workedExample_novemberRound() public {
        uint256 aliceId = _create(alice, 1200e18, 12);
        vm.warp(NOV_LOCK - 14 days);
        uint256 bobId = _create(bob, 600e18, 6);
        assertEq(_pair().roundStableUnits, 200e24);
        assertEq(_pair().roundPrincipal, 200e18);

        vm.warp(NOV_LOCK + 1 hours);
        hub.setPricePerShare(1.001e18);
        uint256 carolId = _create(carol, 300e18, 3);
        assertEq(_plan(carolId).scheduleFirstRound, DEC);

        vm.prank(keeper);
        dca.startRound(pairId, 2);
        ISmartDCA.Round memory r = _round(NOV);
        assertEq(r.stableRedeemed, 200.2e18);
        assertEq(r.stableRedeemed - r.stableNet, 0.01e18);
        assertEq(r.stableNet, 200.19e18);
        assertEq(usdt.balanceOf(reserve), 0.01e18);

        // Each part sells 100.095 USDT, quoted at 100,000: 0.00100095 BTCB
        vm.prank(keeper);
        dca.swapRoundPart(pairId, 1.00095e15, _swapData(pairId));

        // The pool moves 0.2% after the quote: part 2 reverts and is retried next block with a fresh quote
        swapHelper.setRate(0.998e13);
        vm.prank(keeper);
        vm.expectPartialRevert(ISmartDCA.SlippageExceeded.selector);
        dca.swapRoundPart(pairId, 1.00095e15, _swapData(pairId));
        swapHelper.setRate(1e13);
        vm.roll(block.number + 1);
        vm.prank(keeper);
        dca.swapRoundPart(pairId, 1.00095e15, _swapData(pairId));

        // Carol is not in this round, so she can still leave
        vm.prank(carol);
        dca.cancelPlan(carolId, false, carol);
        assertApproxEqAbs(usdt.balanceOf(carol), 300e18, 1);

        vm.prank(keeper);
        dca.settleRound(pairId);
        assertEq(_pair().lastSettledRound, NOV);
        assertEq(dca.nextLockTime(pairId), dca.roundStart(DEC));

        // Both put 100.095 into the round, so both get half of 200.19 USDT of BTCB
        uint256 aliceGot = _withdrawAll(alice, aliceId);
        uint256 bobGot = _withdrawAll(bob, bobId);
        assertApproxEqAbs(aliceGot, bobGot, 2e8);
        assertApproxEqAbs(aliceGot + bobGot, 2.0019e15, 4e8);
    }

    function test_callers_onlyKeeperFromLock() public {
        _create(alice, 1200e18, 12);

        vm.prank(makeAddr("stranger"));
        vm.expectPartialRevert(ISmartDCA.NotRoundCaller.selector);
        dca.startRound(pairId, 1);

        vm.warp(NOV_LOCK - 1);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(ISmartDCA.RoundNotStarted.selector, NOV_LOCK));
        dca.startRound(pairId, 1);

        vm.warp(NOV_LOCK);
        vm.startPrank(keeper);
        dca.startRound(pairId, 1);
        dca.swapRoundPart(pairId, ANY_QUOTE, _swapData(pairId));
        dca.settleRound(pairId);
        vm.stopPrank();
        assertEq(_pair().lastSettledRound, NOV);
    }

    function test_roundCalls_enforceOrder() public {
        _create(alice, 1200e18, 12);
        vm.warp(NOV_LOCK);
        vm.startPrank(keeper);

        vm.expectPartialRevert(ISmartDCA.StartRoundNotCalled.selector);
        dca.swapRoundPart(pairId, ANY_QUOTE, _swapData(pairId));
        vm.expectPartialRevert(ISmartDCA.StartRoundNotCalled.selector);
        dca.settleRound(pairId);
        vm.expectRevert(ISmartDCA.InvalidParts.selector);
        dca.startRound(pairId, 0);
        vm.expectRevert(ISmartDCA.InvalidParts.selector);
        dca.startRound(pairId, 11);

        dca.startRound(pairId, 2);
        vm.expectPartialRevert(ISmartDCA.RoundAlreadyStarted.selector);
        dca.startRound(pairId, 2);
        vm.expectRevert(ISmartDCA.PartsLeft.selector);
        dca.settleRound(pairId);

        dca.swapRoundPart(pairId, ANY_QUOTE, _swapData(pairId));
        dca.swapRoundPart(pairId, ANY_QUOTE, _swapData(pairId));
        vm.expectRevert(ISmartDCA.NoPartsLeft.selector);
        dca.swapRoundPart(pairId, ANY_QUOTE, _swapData(pairId));
        vm.stopPrank();
    }

    function test_emptyRound_settlesWithoutSwap() public {
        vm.warp(NOV_LOCK);
        vm.prank(keeper);
        dca.startRound(pairId, 1);

        assertEq(_pair().lastSettledRound, NOV);
        assertEq(_round(NOV).partsTotal, 0);
        assertEq(dca.nextLockTime(pairId), dca.roundStart(DEC));
    }

    function test_overrun_nextRoundCanStartAtOnce() public {
        _create(alice, 1200e18, 12);
        vm.warp(NOV_LOCK);
        vm.startPrank(keeper);
        dca.startRound(pairId, 1);
        dca.swapRoundPart(pairId, ANY_QUOTE, _swapData(pairId));

        vm.warp(dca.roundStart(DEC) + 1 days);
        dca.settleRound(pairId);
        assertEq(_pair().lastSettledRound, NOV);

        // December's lock has passed, so its round starts right away
        dca.startRound(pairId, 1);
        assertEq(_round(DEC).partsTotal, 1);
        vm.stopPrank();
    }

    function test_settleRound_retriesAfterCoreMintFails() public {
        _create(alice, 1200e18, 12);
        vm.warp(NOV_LOCK);
        vm.startPrank(keeper);
        dca.startRound(pairId, 1);
        dca.swapRoundPart(pairId, ANY_QUOTE, _swapData(pairId));

        vBTC.setErrors(9, 0);
        vm.expectRevert(abi.encodeWithSelector(ISmartDCA.SourceCallFailed.selector, address(vBTC), 9));
        dca.settleRound(pairId);
        assertEq(_round(NOV).assetBought, 1e15, "swap kept");

        vBTC.setErrors(0, 0);
        dca.settleRound(pairId);
        vm.stopPrank();
        assertEq(_pair().lastSettledRound, NOV);
    }

    function test_startRound_retriesWhenHubCannotPay() public {
        _create(alice, 1200e18, 12);
        vm.warp(NOV_LOCK);
        hub.setRedeemPaused(true);
        vm.prank(keeper);
        vm.expectRevert(bytes("hub paused"));
        dca.startRound(pairId, 1);

        hub.setRedeemPaused(false);
        vm.prank(keeper);
        dca.startRound(pairId, 1);
        assertEq(_round(NOV).partsTotal, 1);
    }

    function test_syncPair_emitsRoundLockedOncePerRound() public {
        _create(alice, 1200e18, 12);
        vm.warp(NOV_LOCK);

        vm.expectEmit(address(dca));
        emit ISmartDCA.RoundLocked(pairId, NOV);
        dca.syncPair(pairId);

        vm.recordLogs();
        dca.syncPair(pairId);
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
        uint16 feeRateBps
    ) public {
        amountA = bound(amountA, 1_000e18, 100_000e18);
        amountB = bound(amountB, 1_000e18, 100_000e18);
        buysA = uint8(bound(buysA, 2, 60));
        buysB = uint8(bound(buysB, 2, 60));
        pps = bound(pps, 0.9e18, 1.2e18);
        dca.setFeeRate(uint16(bound(feeRateBps, 0, 2_000)));

        uint256 idA = _create(alice, amountA, buysA);
        uint256 idB = _create(bob, amountB, buysB);
        hub.setPricePerShare(pps);
        _runRound(1);

        uint16 rate = _round(NOV).feeRateBps;
        uint256 pA = _pending(idA, pps, rate);
        uint256 pB = _pending(idB, pps, rate);
        uint256 total = _round(NOV).assetBought;
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
        uint256 e = (p.stableUnitsPerBuy * pps) / 1e24;
        return (e * (10_000 - rate) + p.principalPerBuy * rate) / 10_000;
    }

    /// @dev Each settle keeps its rounding leftover, so the plans' rounded-down reads never exceed the pool
    function test_settleRound_lastPlanCanClaimAfterRoundingLeftovers() public {
        uint256 aliceId = _create(alice, 100e18 + 7, 3);
        uint256 bobId = _create(bob, 50e18 + 3, 3);
        swapHelper.setRate(1e13 + 3);
        hub.setPricePerShare(1.000_000_7e18);
        _runRound(1);
        _runRound(1);
        _runRound(1);

        vm.prank(alice);
        dca.claimPlan(aliceId, false, alice);
        vm.prank(bob);
        dca.claimPlan(bobId, false, bob);

        // What is left is the rounding leftover: a few units per plan per round
        (, , uint256 shares, uint256 units) = dca.yieldSources(pairId, ISmartDCA.Side.Asset);
        assertEq(vBTC.balanceOf(address(dca)), shares);
        assertLe(units, 2 * 3 * 2);
    }

    /// @dev Alice joined at 1.00 and Bob at 1.02, so the fee rate decides how the bought asset is split.
    ///      Changing the rate mid-round must not change that split.
    function test_settleRound_usesTheFeeRateSavedAtStart() public {
        uint256 aliceId = _create(alice, 1200e18, 12);
        hub.setPricePerShare(1.02e18);
        uint256 bobId = _create(bob, 1200e18, 12);

        vm.warp(NOV_LOCK);
        vm.prank(keeper);
        dca.startRound(pairId, 1);
        // Alice redeems 102 for 100 principal, so the round fee is 5% of 2
        uint256 fee = usdt.balanceOf(reserve);
        assertApproxEqAbs(fee, 0.1e18, 1);

        dca.setFeeRate(2_000);

        vm.startPrank(keeper);
        dca.swapRoundPart(pairId, ANY_QUOTE, _swapData(pairId));
        dca.settleRound(pairId);
        vm.stopPrank();

        assertEq(_round(NOV).feeRateBps, 500);
        assertEq(usdt.balanceOf(reserve), fee);
        // At 5% Alice nets 101.9 and Bob 100; at 20% Alice would net 101.6
        assertApproxEqRel(_withdrawAll(alice, aliceId) * 100e18, _withdrawAll(bob, bobId) * 101.9e18, 1e12);
    }

    // ----- swaps and the slippage bound -----

    function test_swapRoundPart_fillsInsideTheBound() public {
        _create(alice, 1200e18, 12);
        swapHelper.setRate(0.9995e13); // pays 0.05% under the quote, bound is 0.1%
        vm.warp(NOV_LOCK);
        vm.startPrank(keeper);
        dca.startRound(pairId, 1);
        vm.expectEmit(address(dca));
        emit ISmartDCA.RoundPartSwapped(pairId, NOV, 1, 100e18, 0.9995e15, 1e15, 0.999e15);
        dca.swapRoundPart(pairId, 1e15, _swapData(pairId));
        vm.stopPrank();
        assertEq(usdt.balanceOf(address(dca)), 0, "the part was sent to SwapHelper");
        assertEq(btcb.balanceOf(address(dca)), 0.9995e15, "the asset came back");
        assertEq(_round(NOV).assetBought, 0.9995e15);
    }

    function test_swapRoundPart_revertsWhenTheSwapCallFails() public {
        _create(alice, 1200e18, 12);
        swapHelper.setFail(true);
        vm.warp(NOV_LOCK);
        vm.startPrank(keeper);
        dca.startRound(pairId, 1);
        vm.expectRevert(bytes("call failed"));
        dca.swapRoundPart(pairId, ANY_QUOTE, _swapData(pairId));
        vm.stopPrank();
        assertEq(_round(NOV).partsDone, 0);
        assertEq(usdt.balanceOf(address(dca)), 100e18, "the stable stays here");
    }

    function test_swapRoundPart_revertsSwapFailedWhenTheSwapRevertsWithNoReason() public {
        _create(alice, 1200e18, 12);
        vm.warp(NOV_LOCK);
        vm.startPrank(keeper);
        dca.startRound(pairId, 1);
        vm.mockCallRevert(address(swapHelper), bytes(""), bytes(""));
        vm.expectRevert(ISmartDCA.SwapFailed.selector);
        dca.swapRoundPart(pairId, ANY_QUOTE, _swapData(pairId));
        vm.stopPrank();
    }

    /// @dev minOut = quotedOut x 9,990 / 10,000, rounded down. The swap pays 0.001 BTCB; a quote of 1,001,001,001,001,002
    ///      wei gives minOut exactly 0.001 and fills, one wei more of quote makes minOut 1 wei above the fill and
    ///      reverts. With the oracle check off, as in setUp, the oracle price (80,000 here, not the swap's 100,000)
    ///      plays no part.
    function test_swapRoundPart_minOutIsTheQuoteLessMaxSlippage() public {
        _create(alice, 1200e18, 12);
        oracle.setPrice(address(btcb), 80_000e18);
        vm.warp(NOV_LOCK);
        vm.startPrank(keeper);
        dca.startRound(pairId, 1);

        uint256 quote = 1_001_001_001_001_002;
        vm.expectRevert(abi.encodeWithSelector(ISmartDCA.SlippageExceeded.selector, 1e15, 1e15 + 1));
        dca.swapRoundPart(pairId, quote + 1, _swapData(pairId));

        vm.expectEmit(address(dca));
        emit ISmartDCA.RoundPartSwapped(pairId, NOV, 1, 100e18, 1e15, quote, 1e15);
        dca.swapRoundPart(pairId, quote, _swapData(pairId));
        vm.stopPrank();
    }

    /// @dev Oracle value of the 100 USDT part is 0.001 BTCB, so at 3% the floor is 0.00097. A quote of 0.00097 gives
    ///      minOut 0.00096903 and reverts; 0.000971 gives 0.000970029 and fills at the pool's 0.001.
    function test_swapRoundPart_minOutMoreThanTheBandBelowTheOracleReverts() public {
        dca.setMaxOracleDeviation(300);
        _create(alice, 1200e18, 12);
        vm.warp(NOV_LOCK);
        vm.startPrank(keeper);
        dca.startRound(pairId, 1);

        vm.expectRevert(abi.encodeWithSelector(ISmartDCA.QuoteBelowOracle.selector, 0, 0.97e15));
        dca.swapRoundPart(pairId, ANY_QUOTE, _swapData(pairId));
        vm.expectRevert(abi.encodeWithSelector(ISmartDCA.QuoteBelowOracle.selector, 0.96903e15, 0.97e15));
        dca.swapRoundPart(pairId, 0.97e15, _swapData(pairId));

        dca.swapRoundPart(pairId, 0.971e15, _swapData(pairId));
        vm.stopPrank();
        assertEq(_round(NOV).assetBought, 1e15);
    }

    /// @dev At 10,000 the check is off and the oracle is not read: a token with no price still swaps
    function test_swapRoundPart_oracleCheckOffDoesNotReadTheOracle() public {
        _create(alice, 1200e18, 12);
        vm.warp(NOV_LOCK);
        vm.startPrank(keeper);
        dca.startRound(pairId, 1);
        oracle.setPrice(address(btcb), 0);
        dca.swapRoundPart(pairId, ANY_QUOTE, _swapData(pairId));
        vm.stopPrank();
        assertEq(_round(NOV).assetBought, 1e15);
    }

    /// @dev Pool fee 0.25%: each 100 USDT part pays 0.0009975 BTCB, which is the quote, so minOut is 0.0009965025.
    ///      The pool then moves 0.2% before part 2, which pays 0.000995505 against the same quote and reverts.
    function test_swapRoundPart_poolFeeFillsAtTheQuoteAndAMoveBelowTheBoundReverts() public {
        swapHelper.setFeeBps(25);
        _create(alice, 2400e18, 12);
        vm.warp(NOV_LOCK);
        vm.startPrank(keeper);
        dca.startRound(pairId, 2);

        uint256 quote = _quote(pairId);
        assertEq(quote, 0.9975e15);
        vm.expectEmit(address(dca));
        emit ISmartDCA.RoundPartSwapped(pairId, NOV, 1, 100e18, 0.9975e15, quote, 0.9965025e15);
        dca.swapRoundPart(pairId, quote, _swapData(pairId));

        swapHelper.setRate(0.998e13);
        vm.expectRevert(abi.encodeWithSelector(ISmartDCA.SlippageExceeded.selector, 0.995505e15, 0.9965025e15));
        dca.swapRoundPart(pairId, quote, _swapData(pairId));
        vm.stopPrank();
    }

    /// @dev The route swaps 50 of the 100 USDT part and sweeps 50 back. Counting the part as swapped would leave the
    ///      50 USDT untracked here, where `sweepToken` takes it.
    function test_swapRoundPart_revertsWhenTheRouteSendsStableBack() public {
        _create(alice, 1200e18, 12);
        swapHelper.setRefundBps(5_000);
        vm.warp(NOV_LOCK);
        vm.startPrank(keeper);
        dca.startRound(pairId, 1);
        vm.expectRevert(abi.encodeWithSelector(ISmartDCA.PartNotFullySwapped.selector, 100e18, 50e18));
        dca.swapRoundPart(pairId, ANY_QUOTE, _swapData(pairId));
        vm.stopPrank();
    }

    /// @dev A call that swaps nothing (here a view, which needs no backend signature) leaves the part in SwapHelper.
    ///      With a 1 wei quote, minOut is 0, so the slippage bound alone does not catch it.
    function test_swapRoundPart_runsARouteOfAllowedCalls() public {
        _create(alice, 1200e18, 12);
        _startNovRound();
        bytes[] memory calls = new bytes[](3);
        calls[0] = abi.encodeCall(MockSwapHelper.approveMax, (address(usdt), address(swapHelper)));
        calls[1] = abi.encodeCall(
            MockSwapHelper.genericCall,
            (address(swapHelper), abi.encodeCall(MockSwapHelper.swap, (pairId)))
        );
        calls[2] = abi.encodeCall(MockSwapHelper.sweep, (address(btcb), address(dca)));
        vm.prank(keeper);
        dca.swapRoundPart(pairId, ANY_QUOTE, _multicall(calls));
        assertEq(_round(NOV).partsDone, 1);
    }

    function test_swapRoundPart_revertsOnACallToARouterNotAllowed() public {
        _create(alice, 1200e18, 12);
        _startNovRound();
        address evil = makeAddr("evil");
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(ISmartDCA.RouterNotAllowed.selector, evil));
        dca.swapRoundPart(pairId, ANY_QUOTE, mockMulticall(evil, abi.encodeCall(MockSwapHelper.swap, (pairId))));
    }

    function test_swapRoundPart_revertsOnAnApprovalToARouterNotAllowed() public {
        _create(alice, 1200e18, 12);
        _startNovRound();
        address evil = makeAddr("evil");
        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeCall(MockSwapHelper.approveMax, (address(usdt), evil));
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(ISmartDCA.RouterNotAllowed.selector, evil));
        dca.swapRoundPart(pairId, ANY_QUOTE, _multicall(calls));
    }

    function test_swapRoundPart_revertsOnASweepAwayFromSmartDca() public {
        _create(alice, 1200e18, 12);
        _startNovRound();
        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeCall(MockSwapHelper.sweep, (address(usdt), alice));
        vm.prank(keeper);
        vm.expectRevert(ISmartDCA.SwapCallNotAllowed.selector);
        dca.swapRoundPart(pairId, ANY_QUOTE, _multicall(calls));
    }

    function test_swapRoundPart_revertsOnAnyOtherCall() public {
        _create(alice, 1200e18, 12);
        _startNovRound();
        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeCall(usdt.transfer, (alice, 1));
        vm.startPrank(keeper);
        vm.expectRevert(ISmartDCA.SwapCallNotAllowed.selector);
        dca.swapRoundPart(pairId, ANY_QUOTE, _multicall(calls));

        // Short calls and a top level call that is not a multicall
        calls[0] = abi.encodeCall(MockSwapHelper.setFail, (true));
        vm.expectRevert(ISmartDCA.SwapCallNotAllowed.selector);
        dca.swapRoundPart(pairId, ANY_QUOTE, _multicall(calls));
        vm.expectRevert(ISmartDCA.SwapCallNotAllowed.selector);
        dca.swapRoundPart(pairId, ANY_QUOTE, abi.encodeCall(MockSwapHelper.swap, (pairId)));
        vm.expectRevert(ISmartDCA.SwapCallNotAllowed.selector);
        dca.swapRoundPart(pairId, ANY_QUOTE, "");
        vm.stopPrank();
    }

    function test_swapRoundPart_revertsWhenThePartStaysInSwapHelper() public {
        _create(alice, 1200e18, 12);
        vm.warp(NOV_LOCK);
        vm.startPrank(keeper);
        dca.startRound(pairId, 1);
        vm.expectRevert(abi.encodeWithSelector(ISmartDCA.PartNotFullySwapped.selector, 100e18, 0));
        dca.swapRoundPart(pairId, ANY_QUOTE, mockMulticall(address(swapHelper), abi.encodeCall(swapHelper.quote, (1))));
        vm.stopPrank();
        assertEq(usdt.balanceOf(address(swapHelper)), 0, "nothing was stranded");
    }

    function test_swapRoundPart_revertsOnAZeroQuote() public {
        _create(alice, 1200e18, 12);
        vm.warp(NOV_LOCK);
        vm.startPrank(keeper);
        dca.startRound(pairId, 1);
        vm.expectRevert(ISmartDCA.ZeroAmount.selector);
        dca.swapRoundPart(pairId, 0, _swapData(pairId));
        vm.stopPrank();
    }

    // ----- resplit -----

    /// @dev Before any part and after two of three, with a round that does not divide evenly; once per round
    function test_resplitRound_atAnyPointSwapsTheExactRemainder() public {
        _create(alice, 1000e18 + 7, 10);
        vm.warp(NOV_LOCK);
        vm.startPrank(keeper);
        dca.startRound(pairId, 3);
        uint256 net = _round(NOV).stableNet;

        vm.expectRevert(ISmartDCA.InvalidParts.selector);
        dca.resplitRound(pairId, 0);
        vm.expectRevert(ISmartDCA.InvalidParts.selector);
        dca.resplitRound(pairId, 11);

        vm.expectEmit(address(dca));
        emit ISmartDCA.RoundResplit(pairId, NOV, 0, 4);
        dca.resplitRound(pairId, 4);
        for (uint256 i; i < 4; ++i) dca.swapRoundPart(pairId, ANY_QUOTE, _swapData(pairId));
        assertEq(_round(NOV).stableToSwap, 0);
        assertEq(_round(NOV).assetBought, ((net / 4) * 3) / 1e5 + (net - (net / 4) * 3) / 1e5);
        dca.settleRound(pairId);

        vm.warp(dca.roundStart(DEC));
        dca.startRound(pairId, 3);
        dca.swapRoundPart(pairId, ANY_QUOTE, _swapData(pairId));
        dca.swapRoundPart(pairId, ANY_QUOTE, _swapData(pairId));
        dca.resplitRound(pairId, 2);
        assertEq(_round(DEC).partsTotal, 4);
        vm.expectRevert(ISmartDCA.AlreadyResplit.selector);
        dca.resplitRound(pairId, 2);
        dca.swapRoundPart(pairId, ANY_QUOTE, _swapData(pairId));
        dca.swapRoundPart(pairId, ANY_QUOTE, _swapData(pairId));
        assertEq(_round(DEC).stableToSwap, 0);
        vm.stopPrank();
    }

    function test_resplitRound_revertsWhenEveryPartIsSwapped() public {
        _create(alice, 1200e18, 12);
        vm.warp(NOV_LOCK);
        vm.startPrank(keeper);
        dca.startRound(pairId, 1);
        dca.swapRoundPart(pairId, ANY_QUOTE, _swapData(pairId));
        vm.expectRevert(ISmartDCA.NoPartsLeft.selector);
        dca.resplitRound(pairId, 2);
        vm.stopPrank();
    }

    /// @dev A second pair stuck on slippage stops only its own round
    function test_pairIsolation_otherPairSettlesWhileOneIsStuck() public {
        MockERC20 eth = new MockERC20("ETH", "ETH", 18);
        MockVToken vETH = new MockVToken(address(eth), VBTC_RATE);
        comptroller.list(address(vETH));
        oracle.setPrice(address(eth), BTC_PRICE);
        uint32 ethPairId = _addPair(address(usdt), address(eth), address(hub), address(vETH));

        _create(alice, 1200e18, 12);
        usdt.mint(bob, 1200e18);
        vm.startPrank(bob);
        usdt.approve(address(dca), 1200e18);
        dca.createPlan(ethPairId, 1200e18, 12, bob);
        vm.stopPrank();

        vm.warp(NOV_LOCK);
        vm.startPrank(keeper);
        dca.startRound(ethPairId, 1);
        // Quoted 1% above what the pool pays
        vm.expectPartialRevert(ISmartDCA.SlippageExceeded.selector);
        dca.swapRoundPart(ethPairId, 1.01e15, _swapData(ethPairId));

        dca.startRound(pairId, 1);
        dca.swapRoundPart(pairId, ANY_QUOTE, _swapData(pairId));
        dca.settleRound(pairId);
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
        emit ISmartDCA.RoundLocked(pairId, NOV);
        vm.expectEmit(address(dca));
        emit ISmartDCA.RoundFeeCollected(pairId, NOV, 0.005e18);
        vm.expectEmit(address(dca));
        emit ISmartDCA.RoundStarted(pairId, NOV, 1, 100e24, 100.1e18, 100e18, 500, 100.095e18);
        dca.startRound(pairId, 1);
        dca.swapRoundPart(pairId, ANY_QUOTE, _swapData(pairId));

        // amountOut 100.095 / 100,000 BTCB; units at 1 vBTC = 0.02 BTCB, in 8 decimals
        vm.expectEmit(address(dca));
        emit ISmartDCA.RoundSettled(pairId, NOV, 100.1e18, 0.005e18, 1.00095e15, 5_004_750, 47_547_500e9, 2_500e18);
        dca.settleRound(pairId);
        vm.stopPrank();
    }

    function test_startRound_revertsWhenTheRoundRedeemsNothing() public {
        _create(alice, 1200e18, 12);
        hub.setPricePerShare(0);
        vm.warp(NOV_LOCK);
        vm.prank(keeper);
        vm.expectRevert(ISmartDCA.ZeroAmount.selector);
        dca.startRound(pairId, 1);
    }

    /// @dev Every whenNotPaused call stops, and a round paused halfway finishes after unpause
    function test_pause_stopsEveryCallAndARoundResumesAfter() public {
        uint256 id = _create(alice, 100e18, 2);
        _runRound(1);
        dca.pause();
        vm.warp(dca.nextLockTime(pairId));
        vm.prank(keeper);
        vm.expectRevert(bytes("Pausable: paused"));
        dca.startRound(pairId, 2);
        vm.expectRevert(bytes("Pausable: paused"));
        dca.syncPair(pairId);

        dca.unpause();
        vm.startPrank(keeper);
        dca.startRound(pairId, 2);
        dca.swapRoundPart(pairId, ANY_QUOTE, _swapData(pairId));
        vm.stopPrank();

        dca.pause();
        uint32 round = _pair().lastSettledRound + 1;
        ISmartDCA.Round memory before = _round(round);
        uint256 stableHeld = usdt.balanceOf(address(dca));
        uint256 assetHeld = btcb.balanceOf(address(dca));
        vm.startPrank(keeper);
        vm.expectRevert(bytes("Pausable: paused"));
        dca.swapRoundPart(pairId, ANY_QUOTE, _swapData(pairId));
        vm.expectRevert(bytes("Pausable: paused"));
        dca.resplitRound(pairId, 2);
        vm.expectRevert(bytes("Pausable: paused"));
        dca.settleRound(pairId);
        vm.stopPrank();
        vm.startPrank(alice);
        vm.expectRevert(bytes("Pausable: paused"));
        dca.createPlan(pairId, 100e18, 2, alice);
        vm.expectRevert(bytes("Pausable: paused"));
        dca.topUpPlan(id, 100e18);
        vm.expectRevert(bytes("Pausable: paused"));
        dca.withdrawBought(id, type(uint256).max, false, alice);
        vm.expectRevert(bytes("Pausable: paused"));
        dca.cancelPlan(id, false, alice);
        vm.expectRevert(bytes("Pausable: paused"));
        dca.claimPlan(id, false, alice);
        vm.stopPrank();
        assertEq(_round(round).stableToSwap, before.stableToSwap, "stableToSwap frozen");
        assertEq(_round(round).assetBought, before.assetBought, "amountOut frozen");
        assertEq(usdt.balanceOf(address(dca)), stableHeld);
        assertEq(btcb.balanceOf(address(dca)), assetHeld);

        dca.unpause();
        vm.startPrank(keeper);
        dca.swapRoundPart(pairId, ANY_QUOTE, _swapData(pairId));
        dca.settleRound(pairId);
        vm.stopPrank();
        vm.prank(alice);
        dca.claimPlan(id, false, alice);
    }

    function _startNovRound() internal {
        vm.warp(NOV_LOCK);
        vm.prank(keeper);
        dca.startRound(pairId, 1);
    }

    function _multicall(bytes[] memory calls) internal pure returns (bytes memory) {
        return abi.encodeCall(MockSwapHelper.multicall, (calls, 0, bytes32(0), ""));
    }

    /// @dev A route may sweep only the pair's stable or asset, so a route that sweeps another token reverts
    function test_swapRoundPart_revertsOnASweepOfAnotherToken() public {
        _create(alice, 1200e18, 12);
        MockERC20 eth = new MockERC20("ETH", "ETH", 18);
        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(
            MockSwapHelper.genericCall,
            (address(swapHelper), abi.encodeCall(MockSwapHelper.swap, (pairId)))
        );
        calls[1] = abi.encodeCall(MockSwapHelper.sweep, (address(eth), address(dca)));
        bytes memory data = _multicall(calls);
        vm.warp(NOV_LOCK);
        vm.startPrank(keeper);
        dca.startRound(pairId, 1);
        vm.expectRevert(ISmartDCA.SwapCallNotAllowed.selector);
        dca.swapRoundPart(pairId, ANY_QUOTE, data);
        vm.stopPrank();
    }
}
