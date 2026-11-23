// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

// solhint-disable func-name-mixedcase, ordering, import-path-check

import { ISmartDCA } from "../../../contracts/SmartDCA/ISmartDCA.sol";
import { SmartDCABase } from "./SmartDCABase.t.sol";

/// @dev Units, shares and fees across plans: what each plan is paid, and that no sequence of calls pays out more
///      than went in
contract SmartDCA_AccountingTest is SmartDCABase {
    function _stableSource() internal view returns (ISmartDCA.YieldSource memory s) {
        (s.kind, s.sourceAddress, s.sharesHeld, s.unitsIssued) = dca.yieldSources(pairId, ISmartDCA.Side.Stable);
    }

    /// @dev Asset units the plan owns, read from the round indexes
    function _assetUnitsOwed(uint256 planId) internal view returns (uint256) {
        ISmartDCA.Plan memory p = _plan(planId);
        (, , , , , , , , , , , , uint256 iu0, ) = dca.rounds(pairId, p.scheduleFirstRound - 1);
        (, , , , , , , , , , , , uint256 iu1, ) = dca.rounds(pairId, _pair().lastSettledRound);
        return p.assetUnitsCarried + (p.stableUnitsPerBuy * (iu1 - iu0)) / 1e36 - p.assetUnitsPaid;
    }

    // ----- units and shares -----

    /// @dev Claims drop rounding dust units but keep their shares, so the pool can reach zero units with shares
    ///      left. The next plan starts cleanly and is backed by its deposit plus that leftover.
    function test_poolEmptiesWithSharesLeftThenRefills() public {
        uint256 a = _create(alice, 100e18 + 7, 3); // 100e24 + 7e6 shares over 3 buys leaves dust
        for (uint256 i; i < 3; ++i) _runRound(1);
        vm.prank(alice);
        dca.claimPlan(a, false, alice);

        ISmartDCA.YieldSource memory s = _stableSource();
        assertEq(s.unitsIssued, 0, "no units left");
        assertGt(s.sharesHeld, 0, "dust shares left");
        uint256 leftover = s.sharesHeld;

        uint256 b = _create(bob, 300e18, 3);
        s = _stableSource();
        assertEq(s.unitsIssued, _plan(b).scheduleStableUnits);
        assertEq(s.sharesHeld, leftover + 300e24);

        vm.prank(bob);
        dca.cancelPlan(b, false, bob);
        assertGe(usdt.balanceOf(bob), 300e18 - dca.feeRateBps(), "deposit back");
    }

    /// @dev Tokens and shares sent straight to SmartDCA change no plan and are exactly what `sweepToken` takes
    function test_donationsAreIgnoredAndSweptExactly() public {
        uint256 planId = _create(alice, 1200e18, 12);
        _runRound(1);
        uint256 unitsBefore = _stableSource().unitsIssued;
        uint256 owedBefore = _assetUnitsOwed(planId);

        usdt.mint(address(this), 50e18);
        usdt.approve(address(hub), 50e18);
        hub.deposit(50e18, address(dca));
        usdt.mint(address(dca), 7e18);
        btcb.mint(address(dca), 1e15);

        assertEq(_stableSource().unitsIssued, unitsBefore);
        assertEq(_assetUnitsOwed(planId), owedBefore);

        address gov = makeAddr("gov");
        dca.sweepToken(address(hub), gov);
        dca.sweepToken(address(usdt), gov);
        dca.sweepToken(address(btcb), gov);
        assertEq(hub.balanceOf(gov), 50e24);
        assertEq(usdt.balanceOf(gov), 7e18);
        assertEq(btcb.balanceOf(gov), 1e15);
        assertEq(hub.balanceOf(address(dca)), _stableSource().sharesHeld, "plans' shares untouched");
    }

    /// @dev A Hub share price that halves: rounds still run with no fee, and a cancel returns what the shares are
    ///      worth
    function test_sharePriceHalvesRoundsRunWithoutFee() public {
        uint256 planId = _create(alice, 1200e18, 12);
        hub.setPricePerShare(0.5e18);
        _runRound(1);
        assertEq(usdt.balanceOf(reserve), 0, "no fee below principal");
        assertEq(_round(NOV).stableRedeemed, 50e18);

        vm.prank(alice);
        dca.cancelPlan(planId, false, alice);
        assertEq(usdt.balanceOf(alice), 550e18, "11 buys left at half value");
    }

    /// @dev Creating and cancelling odd amounts over and over never pays out more than went in
    function testFuzz_createCancelLoopNeverProfits(uint256 seed, uint256 price) public {
        price = bound(price, 0.9e18, 1.7e18);
        _create(bob, 5000e18, 12);
        hub.setPricePerShare(price);
        uint256 spent;
        uint256 got;
        for (uint256 i; i < 20; ++i) {
            uint256 amount = 20e18 + (uint256(keccak256(abi.encode(seed, i))) % 1e21);
            uint256 before = usdt.balanceOf(carol);
            uint256 id = _create(carol, amount, 2);
            spent += amount;
            vm.prank(carol);
            dca.cancelPlan(id, false, carol);
            got += usdt.balanceOf(carol) - before;
        }
        assertLe(got, spent);
    }

    /// @dev Fifty 1 wei withdrawals: each pays at least what was asked and takes whole units, so the total paid never
    ///      exceeds what the plan owned
    function test_tinyWithdrawalsCannotExtractMore() public {
        uint256 planId = _create(alice, 1200e18, 12);
        _create(bob, 1200e18, 12);
        _runRound(1);
        uint256 fairValue = (_assetUnitsOwed(planId) * VBTC_RATE) / 1e18;

        uint256 paid;
        for (uint256 i; i < 50; ++i) {
            uint256 before = btcb.balanceOf(alice);
            vm.prank(alice);
            dca.withdrawBought(planId, 1, alice);
            uint256 p = btcb.balanceOf(alice) - before;
            assertGe(p, 1, "paid at least the amount");
            paid += p;
        }
        paid += _withdrawAll(alice, planId);
        assertLe(paid, fairValue, "paid more than owned");
        assertEq(_assetUnitsOwed(planId), 0);
    }

    // ----- fees -----

    /// @dev With one fee rate per round, a plan whose share price fell below its entry is paid
    ///      `E * (1 - r) + B * r`, above its own E. Alice (B 100, E 108) pays 0.4; the Reserve gets the pool's 0.3
    ///      and Bob (B 110, E 108) gets the other 0.1.
    function test_fee_planUnderWaterReceivesPartOfTheOthersFee() public {
        uint256 alicePlan = _create(alice, 200e18, 2);
        hub.setPricePerShare(1.1e18);
        uint256 bobPlan = _create(bob, 220e18, 2);
        hub.setPricePerShare(1.08e18);

        _runRound(1);
        assertApproxEqAbs(usdt.balanceOf(reserve), 0.3e18, 1e6);
        assertApproxEqRel(_withdrawAll(alice, alicePlan), 1.076e15, 1e12, "107.6 USDT of BTCB");
        assertApproxEqRel(_withdrawAll(bob, bobPlan), 1.081e15, 1e12, "108.1 USDT of BTCB");
    }

    /// @dev The cancel fee is on the plan's own interest above its principal for the buys left
    function test_cancelPlan_feeOnOwnInterestOnly() public {
        uint256 a = _create(alice, 1200e18, 12);
        hub.setPricePerShare(1.1e18);
        uint256 b = _create(bob, 1100e18, 10);
        vm.prank(bob);
        dca.cancelPlan(b, false, bob);
        assertEq(usdt.balanceOf(reserve), 0, "no interest, no fee");
        vm.prank(alice);
        dca.cancelPlan(a, false, alice);
        assertApproxEqAbs(usdt.balanceOf(reserve), 6e18, 1, "5% of 120 interest");
    }

    /// @dev A cancel pays the fee rate set at the time of the cancel
    function test_cancelPlan_usesTheLiveFeeRate() public {
        uint256 planId = _create(alice, 1200e18, 12);
        hub.setPricePerShare(1.01e18);
        dca.setFeeRate(2_000);
        vm.prank(alice);
        dca.cancelPlan(planId, false, alice);
        assertApproxEqAbs(usdt.balanceOf(reserve), 2.4e18, 1e6, "20% of 12 USDT interest");
    }

    // ----- plan edges -----

    function test_claimPlan_afterWithdrawingEverything() public {
        uint256 planId = _create(alice, 200e18, 2);
        _runRound(1);
        _runRound(1);
        _withdrawAll(alice, planId);
        vm.prank(alice);
        dca.claimPlan(planId, true, alice);
        assertEq(uint8(_plan(planId).status), uint8(ISmartDCA.PlanStatus.Claimed));
    }

    function test_transferPlan_toTheOwnerKeepsOneListing() public {
        uint256 planId = _create(alice, 1200e18, 12);
        vm.prank(alice);
        dca.transferPlan(planId, alice);
        assertEq(dca.getPlanIds(alice).length, 1);
        assertEq(_plan(planId).owner, alice);
    }

    /// @dev While November runs past December's 15th, a plan created then joins December and can still cancel
    function test_cancelPlan_duringAnOverrunForTheRoundAfter() public {
        _create(alice, 1200e18, 12);
        vm.warp(NOV_LOCK);
        vm.prank(keeper);
        dca.startRound(pairId, 1);
        vm.warp(dca.roundStart(DEC) + 1 days);

        uint256 bobPlan = _create(bob, 300e18, 3);
        assertEq(_plan(bobPlan).scheduleFirstRound, DEC);
        vm.prank(bob);
        dca.cancelPlan(bobPlan, false, bob);
        assertEq(usdt.balanceOf(bob), 300e18);
    }
}
