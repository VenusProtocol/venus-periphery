// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

// solhint-disable func-name-mixedcase, ordering, import-path-check

import { AccessControlledV8 } from "@venusprotocol/governance-contracts/contracts/Governance/AccessControlledV8.sol";
import { ISmartDCA } from "../../../contracts/SmartDCA/ISmartDCA.sol";
import { MockERC20 } from "./mocks/MockERC20.sol";
import { MockPancakeV3Router, MockVToken } from "./mocks/SmartDCAMocks.sol";
import { SmartDCABase } from "./SmartDCABase.t.sol";

/// @dev Settings changed while a round runs, sweeps and rewards, and who can call what. Alice's plan puts 100 USDT in
///      each round, and the Hub has earned 1% by the November round.
contract SmartDCA_GovernanceTest is SmartDCABase {
    address internal stranger = makeAddr("stranger");
    uint256 internal planId;

    function setUp() public override {
        super.setUp();
        planId = _create(alice, 1200e18, 12);
        hub.setPricePerShare(1.01e18);
    }

    function _start(uint8 parts) internal {
        vm.warp(NOV_LOCK);
        vm.prank(keeper);
        dca.startRound(pairId, parts);
    }

    function _unauthorized(string memory signature) internal view returns (bytes memory) {
        return abi.encodeWithSelector(AccessControlledV8.Unauthorized.selector, stranger, address(dca), signature);
    }

    // ----- settings changed while a round runs -----

    /// @dev Lowering `maxParts` below a running round's parts lets the round finish, and caps a resplit
    function test_setMaxParts_loweredMidRound() public {
        _start(10);
        dca.setMaxParts(2);
        vm.startPrank(keeper);
        dca.swapRoundPart(pairId, ANY_QUOTE, _swapData(pairId));
        vm.expectRevert(ISmartDCA.InvalidParts.selector);
        dca.resplitRound(pairId, 3);
        dca.resplitRound(pairId, 2);
        dca.swapRoundPart(pairId, ANY_QUOTE, _swapData(pairId));
        dca.swapRoundPart(pairId, ANY_QUOTE, _swapData(pairId));
        dca.settleRound(pairId);
        vm.stopPrank();
        assertEq(_pair().lastSettledRound, NOV);
    }

    /// @dev A keeper removed mid round stops; another keeper finishes the same round
    function test_setKeeper_revokedMidRoundAnotherFinishes() public {
        address backup = makeAddr("backup");
        dca.setKeeper(backup, true);
        _start(2);
        vm.prank(keeper);
        dca.swapRoundPart(pairId, ANY_QUOTE, _swapData(pairId));
        dca.setKeeper(keeper, false);

        bytes memory data = _swapData(pairId);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(ISmartDCA.NotRoundCaller.selector, keeper));
        dca.swapRoundPart(pairId, ANY_QUOTE, data);

        vm.startPrank(backup);
        dca.swapRoundPart(pairId, ANY_QUOTE, data);
        dca.settleRound(pairId);
        vm.stopPrank();
        assertEq(_pair().lastSettledRound, NOV);
    }

    /// @dev A disabled pair keeps running its rounds, and its plans can still cancel
    function test_setPairEnabled_falseKeepsRoundsRunning() public {
        dca.setPairEnabled(pairId, false);
        _runRound(1);
        assertEq(_pair().lastSettledRound, NOV);
        vm.prank(alice);
        dca.cancelPlan(planId, alice);
        assertEq(uint8(_plan(planId).status), uint8(ISmartDCA.PlanStatus.Cancelled));
    }

    /// @dev Removing the fallback route mid round stops `forceBuy`; the keeper can still finish the round
    function test_setFallbackRoute_removedMidRound() public {
        MockPancakeV3Router router = new MockPancakeV3Router();
        router.setRate(1e18 / 100_000);
        dca.setFallbackRoute(pairId, address(router), abi.encodePacked(address(usdt), uint24(500), address(btcb)));
        vm.warp(NOV_LOCK + 24 hours);
        dca.forceBuy(pairId, 2);
        dca.setFallbackRoute(pairId, address(0), "");
        vm.expectRevert(abi.encodeWithSelector(ISmartDCA.NoFallbackRoute.selector, pairId));
        dca.forceBuy(pairId, 2);

        vm.startPrank(keeper);
        dca.swapRoundPart(pairId, ANY_QUOTE, _swapData(pairId));
        dca.settleRound(pairId);
        vm.stopPrank();
        assertEq(_pair().lastSettledRound, NOV);
    }

    /// @dev A raised minimum per buy applies to top ups of existing plans
    function test_setMinAmountPerBuy_raisedAppliesToTopUps() public {
        dca.setMinAmountPerBuy(address(usdt), 100e18);
        usdt.mint(alice, 1000e18);
        vm.startPrank(alice);
        usdt.approve(address(dca), 1000e18);
        vm.expectRevert(abi.encodeWithSelector(ISmartDCA.DepositTooSmall.selector, 1000e18, 1200e18));
        dca.topUpPlan(planId, 1000e18);
        vm.stopPrank();
    }

    /// @dev Buy bounds narrowed below an existing plan leave it as it is
    function test_setBuyBounds_narrowedLeavesExistingPlans() public {
        dca.setBuyBounds(2, 6);
        _runRound(1);
        assertEq(_plan(planId).scheduleBuys, 12);
    }

    /// @dev A 100% fee pays every plan its principal and the Reserve all the interest
    function test_setFeeRate_fullRatePaysPrincipalOnly() public {
        dca.setMaxFeeRate(10_000);
        dca.setFeeRate(10_000);
        _runRound(1);
        assertApproxEqAbs(usdt.balanceOf(reserve), 1e18, 1, "all 1 USDT of interest");
        assertApproxEqAbs(_withdrawAll(alice, planId), 1e15, 2e8, "100 USDT of principal bought");
    }

    /// @dev A round's fee goes to the reserve set at `startRound`; later rounds pay the new one
    function test_setReserve_changedMidRound() public {
        _start(1);
        address newReserve = makeAddr("newReserve");
        dca.setReserve(newReserve);
        vm.startPrank(keeper);
        dca.swapRoundPart(pairId, ANY_QUOTE, _swapData(pairId));
        dca.settleRound(pairId);
        vm.stopPrank();
        assertGt(usdt.balanceOf(reserve), 0);
        _runRound(1);
        assertGt(usdt.balanceOf(newReserve), 0);
    }

    // ----- sweep and rewards -----

    /// @dev With two pairs on one stable both mid round, `sweepToken` takes only stable that no round owns
    function test_sweepToken_withTwoRoundsRunningOnOneStable() public {
        MockERC20 eth = new MockERC20("ETH", "ETH", 18);
        MockVToken vETH = new MockVToken(address(eth), 3e26);
        comptroller.list(address(vETH));
        oracle.setPrice(address(eth), BTC_PRICE);
        uint32 ethPair = _addPair(address(usdt), address(eth), address(hub), address(vETH));
        usdt.mint(bob, 600e18);
        vm.startPrank(bob);
        usdt.approve(address(dca), 600e18);
        dca.createPlan(ethPair, 600e18, 6, bob);
        vm.stopPrank();

        vm.warp(NOV_LOCK);
        vm.startPrank(keeper);
        dca.startRound(pairId, 2);
        dca.startRound(ethPair, 3);
        dca.swapRoundPart(pairId, ANY_QUOTE, _swapData(pairId));
        vm.stopPrank();

        usdt.mint(address(dca), 3e18);
        dca.sweepToken(address(usdt), stranger);
        assertEq(usdt.balanceOf(stranger), 3e18, "only the stray stable");

        vm.startPrank(keeper);
        dca.swapRoundPart(pairId, ANY_QUOTE, _swapData(pairId));
        dca.settleRound(pairId);
        for (uint256 i; i < 3; ++i) dca.swapRoundPart(ethPair, ANY_QUOTE, _swapData(ethPair));
        dca.settleRound(ethPair);
        vm.stopPrank();
        assertEq(usdt.balanceOf(address(dca)), 0, "both rounds sold all their stable");
    }

    /// @dev `claimRewards` sends only the XVS it claimed, not XVS already held
    function test_claimRewards_sendsOnlyWhatItClaimed() public {
        MockERC20 xvs = MockERC20(comptroller.getXVSAddress());
        xvs.mint(address(dca), 5e18);
        comptroller.setRewardPerClaim(2e18);
        dca.claimRewards(new address[](0));
        assertEq(xvs.balanceOf(reserve), 2e18);
        assertEq(xvs.balanceOf(address(dca)), 5e18);
    }

    // ----- access and pause -----

    function test_acm_gatesAddPairAndTheFallbackSetters() public {
        vm.startPrank(stranger);
        vm.expectRevert(_unauthorized("addPair(address,address,uint8,address,uint8,address)"));
        dca.addPair(
            address(btcb),
            address(usdt),
            ISmartDCA.SourceKind.Hub,
            address(hub),
            ISmartDCA.SourceKind.Core,
            address(vBTC)
        );
        vm.expectRevert(_unauthorized("setFallbackRoute(uint32,address,bytes)"));
        dca.setFallbackRoute(pairId, address(1), "");
        vm.expectRevert(_unauthorized("setFallbackSlippage(uint16)"));
        dca.setFallbackSlippage(10);
        vm.stopPrank();
    }

    function test_everyPlanCallNeedsTheOwner() public {
        _runRound(1);
        vm.startPrank(stranger);
        vm.expectRevert(ISmartDCA.NotPlanOwner.selector);
        dca.topUpPlan(planId, 1200e18);
        vm.expectRevert(ISmartDCA.NotPlanOwner.selector);
        dca.withdrawBought(planId, type(uint256).max, stranger);
        vm.expectRevert(ISmartDCA.NotPlanOwner.selector);
        dca.cancelPlan(planId, stranger);
        vm.expectRevert(ISmartDCA.NotPlanOwner.selector);
        dca.claimPlan(planId, false, stranger);
        vm.expectRevert(ISmartDCA.NotPlanOwner.selector);
        dca.transferPlan(planId, stranger);
        vm.stopPrank();
    }

    function test_cancelledPlanRefusesEveryCall() public {
        vm.startPrank(alice);
        dca.cancelPlan(planId, alice);
        vm.expectRevert(ISmartDCA.PlanNotActive.selector);
        dca.topUpPlan(planId, 1200e18);
        vm.expectRevert(ISmartDCA.PlanNotActive.selector);
        dca.withdrawBought(planId, type(uint256).max, alice);
        vm.expectRevert(ISmartDCA.PlanNotActive.selector);
        dca.cancelPlan(planId, alice);
        vm.expectRevert(ISmartDCA.PlanNotActive.selector);
        dca.claimPlan(planId, false, alice);
        vm.expectRevert(ISmartDCA.PlanNotActive.selector);
        dca.transferPlan(planId, bob);
        vm.stopPrank();
    }

    function test_zeroReceiversAreRefused() public {
        _runRound(1);
        vm.startPrank(alice);
        vm.expectRevert(ISmartDCA.ZeroAddress.selector);
        dca.withdrawBought(planId, type(uint256).max, address(0));
        vm.expectRevert(ISmartDCA.ZeroAddress.selector);
        dca.cancelPlan(planId, address(0));
        vm.expectRevert(ISmartDCA.ZeroAddress.selector);
        dca.transferPlan(planId, address(0));
        vm.stopPrank();
    }

    /// @dev While paused, `transferPlan` stops; governance setters, `sweepToken` and `claimRewards` still run
    function test_pause_stopsTransferAndKeepsGovernanceCalls() public {
        dca.pause();
        vm.prank(alice);
        vm.expectRevert("Pausable: paused");
        dca.transferPlan(planId, bob);

        dca.setFeeRate(100);
        dca.setMaxSlippage(20);
        dca.setKeeper(stranger, true);
        dca.sweepToken(address(usdt), reserve);
        dca.claimRewards(new address[](0));
        assertTrue(dca.paused());
    }

    /// @dev Every round call before the lock reverts with the lock time
    function test_roundCallsBeforeTheLockRevertWithTheLockTime() public {
        bytes memory data = _swapData(pairId);
        bytes memory err = abi.encodeWithSelector(ISmartDCA.RoundNotStarted.selector, NOV_LOCK);
        vm.startPrank(keeper);
        vm.expectRevert(err);
        dca.startRound(pairId, 1);
        vm.expectRevert(err);
        dca.swapRoundPart(pairId, ANY_QUOTE, data);
        vm.expectRevert(err);
        dca.resplitRound(pairId, 1);
        vm.expectRevert(err);
        dca.settleRound(pairId);
        vm.stopPrank();
    }

    function test_unknownPairIdsAreRefused() public {
        vm.expectRevert(abi.encodeWithSelector(ISmartDCA.UnknownPair.selector, 0));
        dca.syncPair(0);
        vm.expectRevert(abi.encodeWithSelector(ISmartDCA.UnknownPair.selector, 9));
        dca.createPlan(9, 100e18, 2, alice);
        vm.expectRevert(abi.encodeWithSelector(ISmartDCA.UnknownPair.selector, 9));
        dca.setFallbackRoute(9, address(1), "");
    }
}
