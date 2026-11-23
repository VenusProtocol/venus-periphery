// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

// solhint-disable func-name-mixedcase, ordering, import-path-check

import { Vm } from "forge-std/Vm.sol";
import { ISmartDCA } from "../../../contracts/SmartDCA/ISmartDCA.sol";
import { SmartDCALens } from "../../../contracts/SmartDCA/SmartDCALens.sol";
import { MockPancakeV3Router, MockVToken } from "./mocks/SmartDCAMocks.sol";
import { SmartDCABase } from "./SmartDCABase.t.sol";

/// @dev Event arguments on the plan, source and `forceBuy` paths
contract SmartDCA_EventsTest is SmartDCABase {
    function _count(Vm.Log[] memory logs, bytes32 topic0) internal pure returns (uint256 n) {
        for (uint256 i; i < logs.length; ++i) if (logs[i].topics[0] == topic0) ++n;
    }

    function test_planToppedUp() public {
        uint256 b = _create(bob, 600e18, 6);
        _runRound(1);
        usdt.mint(bob, 500e18);
        vm.startPrank(bob);
        usdt.approve(address(dca), 500e18);
        vm.expectEmit(address(dca));
        emit ISmartDCA.PlanToppedUp(b, 500e18, 500e24, 200e24, 200e18, 5);
        dca.topUpPlan(b, 500e18);
        vm.stopPrank();
    }

    /// @dev `BoughtWithdrawn` carries the units and amount the lens showed before the call
    function test_boughtWithdrawnMatchesTheLens() public {
        SmartDCALens lens = new SmartDCALens();
        uint256 a = _create(alice, 1200e18, 12);
        _runRound(1);
        SmartDCALens.PlanView memory v = lens.getPlan(dca, a);
        vm.expectEmit(address(dca));
        emit ISmartDCA.BoughtWithdrawn(a, carol, v.assetUnits, v.assetValue);
        vm.prank(alice);
        dca.withdrawBought(a, type(uint256).max, carol);
    }

    /// @dev 1,212 USDT redeemed for 1,200 principal: a 0.6 fee and 1,211.4 paid
    function test_planCancelledWithFee() public {
        uint256 a = _create(alice, 1200e18, 12);
        hub.setPricePerShare(1.01e18);
        vm.expectEmit(address(dca));
        emit ISmartDCA.CancelFeeCollected(pairId, a, 0.6e18);
        vm.expectEmit(address(dca));
        emit ISmartDCA.PlanCancelled(a, carol, 1211.4e18, 0.6e18, 0);
        vm.prank(alice);
        dca.cancelPlan(a, carol);
    }

    /// @dev 200 USDT at 100,000 per BTCB is 0.002 BTCB, which is 0.1 vBTC or 1e7 vBTC wei
    function test_planClaimedToCorePaysVTokens() public {
        uint256 a = _create(alice, 200e18, 2);
        _runRound(1);
        _runRound(1);
        vm.expectEmit(address(dca));
        emit ISmartDCA.PlanClaimed(a, carol, true, 1e7);
        vm.prank(alice);
        dca.claimPlan(a, true, carol);
        assertEq(vBTC.balanceOf(carol), 1e7);
    }

    function test_planTransferred() public {
        uint256 a = _create(alice, 1200e18, 12);
        vm.expectEmit(address(dca));
        emit ISmartDCA.PlanTransferred(a, alice, bob);
        vm.prank(alice);
        dca.transferPlan(a, bob);
    }

    function test_yieldSourceUpdatedCarriesTheMovedAmount() public {
        _create(alice, 1200e18, 12);
        MockVToken vUSDT = new MockVToken(address(usdt), 2e26);
        comptroller.list(address(vUSDT));
        vm.expectEmit(address(dca));
        emit ISmartDCA.YieldSourceUpdated(
            pairId,
            ISmartDCA.Side.Stable,
            address(hub),
            ISmartDCA.SourceKind.Core,
            address(vUSDT),
            1200e18
        );
        dca.setYieldSource(pairId, ISmartDCA.Side.Stable, ISmartDCA.SourceKind.Core, address(vUSDT));
    }

    /// @dev A `forceBuy` part carries the oracle value of the part as `quotedOut`, and 0.5% less as `minOut`
    function test_forceBuyPartCarriesTheOracleQuote() public {
        MockPancakeV3Router router = new MockPancakeV3Router();
        router.setRate(1e18 / 100_000);
        dca.setFallbackRoute(pairId, address(router), abi.encodePacked(address(usdt), uint24(500), address(btcb)));
        _create(alice, 1200e18, 12);
        vm.warp(NOV_LOCK + 24 hours);
        vm.expectEmit(address(dca));
        emit ISmartDCA.RoundPartSwapped(pairId, NOV, 1, 100e18, 1e15, 1e15, 0.995e15);
        dca.forceBuy(pairId, 1);
    }

    /// @dev Empty rounds settle with every amount 0 and emit no `RoundLocked`
    function test_emptyRoundsSettleWithZerosAndNoRoundLocked() public {
        vm.warp(dca.roundStart(DEC));
        vm.recordLogs();
        vm.expectEmit(address(dca));
        emit ISmartDCA.RoundSettled(pairId, NOV, 0, 0, 0, 0, 0, 0);
        vm.expectEmit(address(dca));
        emit ISmartDCA.RoundSettled(pairId, DEC, 0, 0, 0, 0, 0, 0);
        dca.syncPair(pairId);
        assertEq(_count(vm.getRecordedLogs(), ISmartDCA.RoundLocked.selector), 0);
    }

    /// @dev A round settled after the next 15th emits no `RoundLocked` for that next round; the next call that
    ///      touches the pair does
    function test_roundLockedForTheRoundAfterAnOverrun() public {
        _create(alice, 1200e18, 12);
        vm.warp(dca.roundStart(DEC) + 1 hours);
        vm.startPrank(keeper);
        dca.startRound(pairId, 1);
        dca.swapRoundPart(pairId, ANY_QUOTE, _swapData(pairId));
        vm.recordLogs();
        dca.settleRound(pairId);
        assertEq(_count(vm.getRecordedLogs(), ISmartDCA.RoundLocked.selector), 0);
        vm.expectEmit(address(dca));
        emit ISmartDCA.RoundLocked(pairId, DEC);
        dca.startRound(pairId, 1);
        vm.stopPrank();
    }
}
