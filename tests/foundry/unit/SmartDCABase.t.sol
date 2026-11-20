// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

// solhint-disable func-name-mixedcase, ordering, import-path-check, gas-custom-errors, max-states-count

import { Test } from "forge-std/Test.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import { SmartDCA } from "../../../contracts/SmartDCA/SmartDCA.sol";
import { ISmartDCA } from "../../../contracts/SmartDCA/ISmartDCA.sol";
import { SmartDCAMath } from "../../../contracts/SmartDCA/SmartDCAMath.sol";
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

/// @notice Shared setup: one USDT to BTCB pair, USDT in a Hub, BTCB in Core, fee 5%, BTCB at 100,000 USDT.
///         Time starts on Oct 19 2026, before the November lock (Nov 14 16:00 UTC).
abstract contract SmartDCABase is Test {
    // SmartDCA deploys in October 2026, so `anchorMonth` is October 2026 and October is round 0
    uint256 internal constant ANCHOR_MONTH = 2026 * 12 + 9;
    uint32 internal constant OCT = 0;
    uint32 internal constant NOV = 1;
    uint32 internal constant DEC = 2;
    uint256 internal constant NOV_LOCK = 1_794_672_000; // 2026-11-14 16:00:00 UTC
    uint256 internal constant BTC_PRICE = 100_000e18;
    // 1 vBTC (1e8) = 0.02 BTCB, so 1 BTCB = 50 vBTC
    uint256 internal constant VBTC_RATE = 2e26;
    /// @dev Quote of 1 wei: minOut rounds to 0, for tests that are not about the slippage bound
    uint256 internal constant ANY_QUOTE = 1;

    SmartDCA internal dca;
    MockACM internal acm;
    MockComptroller internal comptroller;
    MockHubRegistry internal registry;
    MockOracle internal oracle;
    MockSwapHelper internal swapHelper;
    MockERC20 internal usdt;
    MockERC20 internal btcb;
    MockHub internal hub;
    MockVToken internal vBTC;
    uint32 internal pairId;

    address internal reserve = makeAddr("reserve");
    address internal keeper = makeAddr("keeper");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    function setUp() public virtual {
        vm.warp(SmartDCAMath.roundStart(ANCHOR_MONTH, OCT) + 5 days);

        acm = new MockACM();
        comptroller = new MockComptroller();
        registry = new MockHubRegistry();
        oracle = new MockOracle();
        swapHelper = new MockSwapHelper();
        usdt = new MockERC20("USDT", "USDT", 18);
        btcb = new MockERC20("BTCB", "BTCB", 18);
        hub = new MockHub(address(usdt));
        vBTC = new MockVToken(address(btcb), VBTC_RATE);

        registry.set(address(hub), true);
        comptroller.list(address(vBTC));
        oracle.setPrice(address(usdt), 1e18);
        oracle.setPrice(address(btcb), BTC_PRICE);
        swapHelper.setRate(1e18 / 100_000); // exactly the oracle price
        // No pool fee here, so the amounts match the TD worked examples; fee tests set it back
        swapHelper.setFeeBps(0);

        SmartDCA impl = new SmartDCA(address(comptroller), address(registry), address(oracle), address(swapHelper));
        dca = SmartDCA(
            address(new ERC1967Proxy(address(impl), abi.encodeCall(SmartDCA.initialize, (address(acm), reserve))))
        );
        acm.setAllowAll(address(this), true);

        dca.setMinAmountPerBuy(address(usdt), 10e18);
        pairId = _addPair(address(usdt), address(btcb), address(hub), address(vBTC));
        dca.setFeeRate(500);
        dca.setKeeper(keeper, true);
    }

    // ----- setup -----

    /// @dev Adds a pair with a Hub for the stable and a Core vToken for the asset, the launch setup
    function _addPair(address stable, address asset, address stableHub, address assetVToken) internal returns (uint32) {
        return dca.addPair(stable, asset, ISmartDCA.SourceKind.Hub, stableHub, ISmartDCA.SourceKind.Core, assetVToken);
    }

    // ----- actions -----

    function _create(address user, uint256 amount, uint8 buys) internal returns (uint256 planId) {
        usdt.mint(user, amount);
        vm.startPrank(user);
        usdt.approve(address(dca), amount);
        planId = dca.createPlan(pairId, amount, buys, user);
        vm.stopPrank();
    }

    function _topUp(address user, uint256 planId, uint256 amount) internal {
        usdt.mint(user, amount);
        vm.startPrank(user);
        usdt.approve(address(dca), amount);
        dca.topUpPlan(planId, amount);
        vm.stopPrank();
    }

    /// @dev Warps to the pair's lock time and runs the whole round as the keeper
    function _runRound(uint8 parts) internal {
        vm.warp(dca.nextLockTime(pairId));
        vm.startPrank(keeper);
        dca.startRound(pairId, parts);
        for (uint8 i; i < parts; ++i) dca.swapRoundPart(pairId, ANY_QUOTE, _swapData(pairId));
        dca.settleRound(pairId);
        vm.stopPrank();
    }

    function _withdrawAll(address user, uint256 planId) internal returns (uint256 received) {
        uint256 before = btcb.balanceOf(user);
        vm.prank(user);
        dca.withdrawBought(planId, type(uint256).max, user);
        received = btcb.balanceOf(user) - before;
    }

    // ----- reads -----

    function _plan(uint256 planId) internal view returns (ISmartDCA.Plan memory p) {
        (
            p.owner,
            p.pairId,
            p.status,
            p.scheduleBuys,
            p.buysBeforeSchedule,
            p.scheduleFirstRound,
            p.scheduleStableUnits,
            p.stableUnitsPerBuy,
            p.principalPerBuy,
            p.assetUnitsCarried,
            p.assetUnitsPaid
        ) = dca.plans(planId);
    }

    function _pair() internal view returns (ISmartDCA.Pair memory p) {
        (
            p.stable,
            p.asset,
            p.enabled,
            p.lastSettledRound,
            p.lockEmittedRound,
            p.roundStableUnits,
            p.roundPrincipal,
            p.assetPerUnitIndex,
            p.assetPerPrincipalIndex
        ) = dca.pairs(pairId);
    }

    function _round(uint32 round) internal view returns (ISmartDCA.Round memory r) {
        (
            r.partsTotal,
            r.partsDone,
            r.resplitUsed,
            r.feeRateBps,
            r.stableRedeemed,
            r.stableNet,
            r.stableToSwap,
            r.assetBought,
            r.stableUnitsJoining,
            r.principalJoining,
            r.stableUnitsEnding,
            r.principalEnding,
            r.assetPerUnitIndexAfter,
            r.assetPerPrincipalIndexAfter
        ) = dca.rounds(pairId, round);
    }

    /// @dev The mock's quote for the pair's next part. Reads the chain, so build it before `vm.prank` or
    ///      `vm.expectRevert`.
    function _quote(uint32 pid) internal view returns (uint256) {
        (, , , uint32 settled, , , , , ) = dca.pairs(pid);
        ISmartDCA.Round memory r;
        (r.partsTotal, r.partsDone, , , , , r.stableToSwap, , , , , , , ) = dca.rounds(pid, settled + 1);
        return swapHelper.quote(r.stableToSwap / (r.partsTotal - r.partsDone));
    }

    /// @dev Swap call for the mock SwapHelper: sells what it was sent of the pair's stable for its asset. Pure, so it
    ///      can sit between `vm.expectRevert` or `vm.prank` and the call.
    function _swapData(uint32 pid) internal pure returns (bytes memory) {
        return abi.encodeCall(MockSwapHelper.swap, (pid));
    }
}
