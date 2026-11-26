// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

// solhint-disable func-name-mixedcase, ordering, import-path-check

import { Test } from "forge-std/Test.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import { SmartDCA } from "../../../contracts/SmartDCA/SmartDCA.sol";
import { ISmartDCA } from "../../../contracts/SmartDCA/ISmartDCA.sol";
import { SmartDCATestClock } from "../../../contracts/test/SmartDCATestClock.sol";
import { MockERC20 } from "./mocks/MockERC20.sol";
import {
    MockACM,
    MockComptroller,
    MockOracle,
    MockHub,
    MockHubRegistry,
    MockSwapHelper,
    MockVToken
} from "./mocks/SmartDCAMocks.sol";

/// @notice The test clock only changes when rounds start: 10 minute rounds from the anchor, forceBuy an hour later.
contract SmartDCA_TestClockTest is Test {
    uint256 internal constant ANCHOR = 1_800_000_000;
    uint256 internal constant ROUND = 10 minutes;
    uint256 internal constant DELAY = 1 hours;

    SmartDCATestClock internal dca;
    MockACM internal acm;
    MockHubRegistry internal registry;
    MockOracle internal oracle;
    MockHub internal hub;
    MockERC20 internal usdt;
    MockERC20 internal btcb;
    MockVToken internal vBTC;
    address internal keeper = makeAddr("keeper");
    address internal alice = makeAddr("alice");
    uint32 internal pairId;

    function setUp() public {
        vm.warp(ANCHOR + 1 minutes);
        acm = new MockACM();
        MockComptroller comptroller = new MockComptroller();
        registry = new MockHubRegistry();
        oracle = new MockOracle();
        MockSwapHelper swapHelper = new MockSwapHelper();
        usdt = new MockERC20("USDT", "USDT", 18);
        btcb = new MockERC20("BTCB", "BTCB", 18);
        hub = new MockHub(address(usdt));
        vBTC = new MockVToken(address(btcb), 2e26);
        registry.set(address(hub), true);
        comptroller.list(address(vBTC));
        oracle.setPrice(address(usdt), 1e18);
        oracle.setPrice(address(btcb), 100_000e18);

        SmartDCATestClock impl = new SmartDCATestClock(
            address(comptroller),
            address(registry),
            address(oracle),
            address(swapHelper),
            ROUND,
            ANCHOR,
            DELAY
        );
        dca = SmartDCATestClock(
            address(
                new ERC1967Proxy(
                    address(impl),
                    abi.encodeCall(SmartDCA.initialize, (address(acm), makeAddr("reserve")))
                )
            )
        );
        acm.setAllowAll(address(this), true);
        dca.setMinAmountPerBuy(address(usdt), 1e18);
        pairId = dca.addPair(
            address(usdt),
            address(btcb),
            ISmartDCA.SourceKind.Hub,
            address(hub),
            ISmartDCA.SourceKind.Core,
            address(vBTC)
        );
        dca.setKeeper(keeper, true);
    }

    function test_roundsStartEveryTenMinutesFromTheAnchor() public view {
        assertEq(dca.roundStart(0), ANCHOR);
        assertEq(dca.roundStart(1), ANCHOR + ROUND);
        assertEq(dca.roundStart(7), ANCHOR + 7 * ROUND);
        // Added one minute into round 0, so the pair's next round is round 1
        assertEq(dca.nextLockTime(pairId), ANCHOR + ROUND);
    }

    function test_aPairAddedLaterStartsAtTheRoundAfterTheCurrentOne() public {
        vm.warp(ANCHOR + 3 * ROUND + 30);
        MockERC20 usdc = new MockERC20("USDC", "USDC", 18);
        MockHub usdcHub = new MockHub(address(usdc));
        registry.set(address(usdcHub), true);
        oracle.setPrice(address(usdc), 1e18);
        dca.setMinAmountPerBuy(address(usdc), 1e18);
        uint32 id = dca.addPair(
            address(usdc),
            address(btcb),
            ISmartDCA.SourceKind.Hub,
            address(usdcHub),
            ISmartDCA.SourceKind.Core,
            address(vBTC)
        );
        assertEq(dca.nextLockTime(id), ANCHOR + 4 * ROUND);
    }

    function test_keeperCanStartTheRoundTenMinutesIn_andForceBuyOpensAnHourAfter() public {
        usdt.mint(alice, 100e18);
        vm.startPrank(alice);
        usdt.approve(address(dca), 100e18);
        dca.createPlan(pairId, 100e18, 2, alice);
        vm.stopPrank();

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(ISmartDCA.RoundNotStarted.selector, ANCHOR + ROUND));
        dca.startRound(pairId, 1);

        vm.warp(ANCHOR + ROUND);
        vm.prank(keeper);
        dca.startRound(pairId, 1);
        (uint8 partsTotal, , , , , , , , , , , , , ) = dca.rounds(pairId, 1);
        assertEq(partsTotal, 1);

        vm.expectRevert(abi.encodeWithSelector(ISmartDCA.NoFallbackRoute.selector, pairId));
        dca.forceBuy(pairId, 1);
        dca.setFallbackRoute(pairId, makeAddr("router"), hex"00");
        vm.expectRevert(abi.encodeWithSelector(ISmartDCA.RoundNotStarted.selector, ANCHOR + ROUND + DELAY));
        dca.forceBuy(pairId, 1);
    }
}
