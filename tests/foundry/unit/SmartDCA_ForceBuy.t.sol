// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

// solhint-disable func-name-mixedcase, ordering, import-path-check

import { AccessControlledV8 } from "@venusprotocol/governance-contracts/contracts/Governance/AccessControlledV8.sol";
import { ISmartDCA } from "../../../contracts/SmartDCA/ISmartDCA.sol";
import { MockPancakeV3Router } from "./mocks/SmartDCAMocks.sol";
import { SmartDCABase } from "./SmartDCABase.t.sol";

/// @dev Alice's plan puts 100 USDT in each round; the router pays exactly the oracle price, 100,000 USDT per BTCB
contract SmartDCA_ForceBuyTest is SmartDCABase {
    MockPancakeV3Router internal router;
    address internal stranger = makeAddr("stranger");
    uint256 internal planId;

    function setUp() public override {
        super.setUp();
        router = new MockPancakeV3Router();
        router.setRate(1e18 / 100_000);
        dca.setFallbackRoute(pairId, address(router), abi.encodePacked(address(usdt), uint24(500), address(btcb)));
        planId = _create(alice, 1200e18, 12);
    }

    function test_forceBuy_oneCallRunsTheWholeRound() public {
        vm.warp(NOV_LOCK);
        dca.forceBuy(pairId, 1);

        assertEq(_pair().lastSettledRound, NOV);
        assertEq(usdt.allowance(address(dca), address(router)), 0, "approved only the part");
        assertApproxEqAbs(_withdrawAll(alice, planId), 1e15, 2e8, "100 USDT at 100,000");
    }

    function test_forceBuy_revertsBeforeTheLock() public {
        vm.warp(NOV_LOCK - 1);
        vm.expectRevert(abi.encodeWithSelector(ISmartDCA.RoundNotStarted.selector, pairId));
        dca.forceBuy(pairId, 1);
    }

    function test_forceBuy_onePartPerCall() public {
        vm.warp(NOV_LOCK);
        dca.forceBuy(pairId, 3);
        dca.forceBuy(pairId, 3);
        assertEq(_round(NOV).partsDone, 2);
        assertEq(_pair().lastSettledRound, NOV - 1, "not settled before the last part");

        dca.forceBuy(pairId, 3);
        assertEq(_pair().lastSettledRound, NOV);
    }

    /// @dev Floor is the oracle value less 0.5%: 0.4% under passes, 0.6% under reverts
    function test_forceBuy_revertsBelowTheOracleFloor() public {
        vm.warp(NOV_LOCK);
        router.setRate(((1e18 / 100_000) * 994) / 1000);
        vm.expectPartialRevert(ISmartDCA.SlippageExceeded.selector);
        dca.forceBuy(pairId, 1);

        router.setRate(((1e18 / 100_000) * 996) / 1000);
        dca.forceBuy(pairId, 1);
        assertEq(_pair().lastSettledRound, NOV);
    }

    /// @dev Keeper split the round in 2 and swapped one part; forceBuy finishes it and ignores its own `parts`
    function test_forceBuy_finishesARoundTheKeeperStarted() public {
        vm.warp(NOV_LOCK);
        vm.startPrank(keeper);
        dca.startRound(pairId, 2);
        dca.swapRoundPart(pairId, ANY_QUOTE, _swapData(pairId));
        vm.stopPrank();

        dca.forceBuy(pairId, 7);
        assertEq(_round(NOV).partsTotal, 2);
        assertEq(_pair().lastSettledRound, NOV);
    }

    function test_forceBuy_onlySettlesWhenEveryPartIsSwapped() public {
        vm.warp(NOV_LOCK);
        vm.startPrank(keeper);
        dca.startRound(pairId, 1);
        dca.swapRoundPart(pairId, ANY_QUOTE, _swapData(pairId));
        vm.stopPrank();

        router.setRate(0); // a swap here would miss the floor and revert
        dca.forceBuy(pairId, 1);
        assertEq(_pair().lastSettledRound, NOV);
    }

    function test_forceBuy_revertsWithoutARouteOrPermission() public {
        vm.warp(NOV_LOCK);
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                AccessControlledV8.Unauthorized.selector,
                stranger,
                address(dca),
                "forceBuy(uint32,uint8)"
            )
        );
        dca.forceBuy(pairId, 1);

        dca.setFallbackRoute(pairId, address(0), "");
        vm.expectRevert(abi.encodeWithSelector(ISmartDCA.NoFallbackRoute.selector, pairId));
        dca.forceBuy(pairId, 1);
    }

    function test_forceBuy_revertsWhilePaused() public {
        vm.warp(NOV_LOCK);
        dca.pause();
        vm.expectRevert("Pausable: paused");
        dca.forceBuy(pairId, 1);
    }

    function test_setFallbackSlippage() public {
        assertEq(dca.fallbackSlippageBps(), 50);

        vm.expectEmit(address(dca));
        emit ISmartDCA.FallbackSlippageUpdated(50, 100);
        dca.setFallbackSlippage(100);
        assertEq(dca.fallbackSlippageBps(), 100);

        vm.expectRevert(ISmartDCA.AboveHardCap.selector);
        dca.setFallbackSlippage(101);

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                AccessControlledV8.Unauthorized.selector,
                stranger,
                address(dca),
                "setFallbackSlippage(uint16)"
            )
        );
        dca.setFallbackSlippage(1);
    }

    function test_setFallbackRoute() public {
        bytes memory path = abi.encodePacked(address(usdt), uint24(100), address(btcb));
        vm.expectEmit(address(dca));
        emit ISmartDCA.FallbackRouteUpdated(pairId, address(router), path);
        dca.setFallbackRoute(pairId, address(router), path);
        (address storedRouter, bytes memory storedPath) = dca.fallbackRoutes(pairId);
        assertEq(storedRouter, address(router));
        assertEq(storedPath, path);

        vm.expectPartialRevert(ISmartDCA.UnknownPair.selector);
        dca.setFallbackRoute(99, address(router), path);

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                AccessControlledV8.Unauthorized.selector,
                stranger,
                address(dca),
                "setFallbackRoute(uint32,address,bytes)"
            )
        );
        dca.setFallbackRoute(pairId, address(router), path);
    }
}
