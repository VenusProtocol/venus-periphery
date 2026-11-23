// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

// solhint-disable func-name-mixedcase, ordering, import-path-check

import { ISmartDCA } from "../../../contracts/SmartDCA/ISmartDCA.sol";
import { MockHub, MockVToken } from "./mocks/SmartDCAMocks.sol";
import { SmartDCABase } from "./SmartDCABase.t.sol";

/// @dev Yield source moves: plans keep their value and records, and a move is all or nothing
contract SmartDCA_SourcesTest is SmartDCABase {
    MockHub internal btcHub;
    MockVToken internal vUSDT;

    function setUp() public override {
        super.setUp();
        btcHub = new MockHub(address(btcb));
        registry.set(address(btcHub), true);
        vUSDT = new MockVToken(address(usdt), 2e26);
        comptroller.list(address(vUSDT));
    }

    function _shares(ISmartDCA.Side side) internal view returns (uint256 sharesHeld, uint256 unitsIssued) {
        (, , sharesHeld, unitsIssued) = dca.yieldSources(pairId, side);
    }

    /// @dev Stable in Core and asset in a Hub runs a whole plan: fee on interest, buys, claim to the wallet, and a
    ///      claim to Core refused
    function test_stableInCoreAssetInHub_fullPlan() public {
        dca.setYieldSource(pairId, ISmartDCA.Side.Stable, ISmartDCA.SourceKind.Core, address(vUSDT));
        dca.setYieldSource(pairId, ISmartDCA.Side.Asset, ISmartDCA.SourceKind.Hub, address(btcHub));
        uint256 planId = _create(alice, 300e18, 3);

        vUSDT.setExchangeRate(2.02e26); // 1% interest
        _runRound(1);
        assertApproxEqAbs(usdt.balanceOf(reserve), 0.05e18, 1e9, "5% of 1 USDT interest on 100");
        _runRound(1);
        _runRound(1);

        vm.prank(alice);
        vm.expectRevert(ISmartDCA.NotCoreSource.selector);
        dca.claimPlan(planId, true, alice);
        vm.prank(alice);
        dca.claimPlan(planId, false, alice);
        assertApproxEqRel(btcb.balanceOf(alice), 3.0285e15, 1e14, "3 buys of about 100.95 USDT");
        (uint256 shares, uint256 units) = _shares(ISmartDCA.Side.Stable);
        assertEq(units, 0);
        assertLe(shares, 2, "at most vToken dust left");
    }

    function test_setYieldSource_rejectsNoneKindAndZeroAddress() public {
        vm.expectRevert(abi.encodeWithSelector(ISmartDCA.InvalidSource.selector, address(hub)));
        dca.setYieldSource(pairId, ISmartDCA.Side.Stable, ISmartDCA.SourceKind.None, address(hub));
        vm.expectRevert(ISmartDCA.ZeroAddress.selector);
        dca.setYieldSource(pairId, ISmartDCA.Side.Stable, ISmartDCA.SourceKind.Hub, address(0));
    }

    /// @dev An asset side that holds nothing can move while its first round runs; settle deposits into the new one
    function test_setYieldSource_assetWithNoSharesMovesDuringTheFirstRound() public {
        uint256 planId = _create(alice, 1200e18, 12);
        vm.warp(NOV_LOCK);
        vm.startPrank(keeper);
        dca.startRound(pairId, 1);
        dca.swapRoundPart(pairId, ANY_QUOTE, _swapData(pairId));
        vm.stopPrank();

        dca.setYieldSource(pairId, ISmartDCA.Side.Asset, ISmartDCA.SourceKind.Hub, address(btcHub));
        vm.prank(keeper);
        dca.settleRound(pairId);

        (uint256 shares, ) = _shares(ISmartDCA.Side.Asset);
        assertEq(btcHub.balanceOf(address(dca)), shares);
        assertApproxEqAbs(_withdrawAll(alice, planId), 1e15, 1, "100 USDT at 100,000");
    }

    /// @dev A move whose new source refuses the deposit reverts whole, leaving the old holdings in place
    function test_setYieldSource_isAtomicWhenTheNewSourceRefuses() public {
        _create(alice, 1200e18, 12);
        MockHub hub2 = new MockHub(address(usdt));
        registry.set(address(hub2), true);
        hub2.setDepositPaused(true);
        (uint256 sharesBefore, uint256 unitsBefore) = _shares(ISmartDCA.Side.Stable);

        vm.expectRevert("hub paused");
        dca.setYieldSource(pairId, ISmartDCA.Side.Stable, ISmartDCA.SourceKind.Hub, address(hub2));

        (uint256 sharesAfter, uint256 unitsAfter) = _shares(ISmartDCA.Side.Stable);
        assertEq(sharesAfter, sharesBefore);
        assertEq(unitsAfter, unitsBefore);
        assertEq(hub.balanceOf(address(dca)), sharesBefore);
    }

    /// @dev Stable moved Hub to Core and back changes no plan record, and a cancel then returns the deposit less at
    ///      most two vToken wei of rounding
    function test_setYieldSource_stableRoundTripKeepsPlansAndValue() public {
        uint256 a = _create(alice, 1000e18, 10);
        ISmartDCA.Plan memory before = _plan(a);
        dca.setYieldSource(pairId, ISmartDCA.Side.Stable, ISmartDCA.SourceKind.Core, address(vUSDT));
        dca.setYieldSource(pairId, ISmartDCA.Side.Stable, ISmartDCA.SourceKind.Hub, address(hub));
        assertEq(_plan(a).scheduleStableUnits, before.scheduleStableUnits);
        assertEq(_plan(a).stableUnitsPerBuy, before.stableUnitsPerBuy);

        dca.setFeeRate(0);
        vm.prank(alice);
        dca.cancelPlan(a, alice);
        assertApproxEqAbs(usdt.balanceOf(alice), 1000e18, 2 * 2e8);
        assertLe(usdt.balanceOf(alice), 1000e18, "never more than deposited");
    }

    /// @dev Asset moved Core to a Hub at a non unit price: both plans still withdraw their share
    function test_setYieldSource_assetToHubKeepsEachPlansShare() public {
        btcHub.setPricePerShare(1.37e18);
        uint256 a = _create(alice, 1200e18, 12);
        uint256 b = _create(bob, 600e18, 3);
        _runRound(1);
        dca.setYieldSource(pairId, ISmartDCA.Side.Asset, ISmartDCA.SourceKind.Hub, address(btcHub));
        _runRound(1);

        uint256 ga = _withdrawAll(alice, a);
        uint256 gb = _withdrawAll(bob, b);
        assertApproxEqRel(ga, 2e15, 1e12, "2 buys of 100 USDT");
        assertApproxEqRel(gb, 4e15, 1e12, "2 buys of 200 USDT");
        assertLe(ga + gb, 6e15);
    }

    function test_setYieldSource_worksWhilePaused() public {
        _create(alice, 1200e18, 12);
        dca.pause();
        dca.setYieldSource(pairId, ISmartDCA.Side.Stable, ISmartDCA.SourceKind.Core, address(vUSDT));
        (uint256 shares, ) = _shares(ISmartDCA.Side.Stable);
        assertEq(vUSDT.balanceOf(address(dca)), shares);
    }
}
