// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

// solhint-disable func-name-mixedcase, ordering, import-path-check

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { ISmartDCA } from "../../../contracts/SmartDCA/ISmartDCA.sol";
import { SmartDCALens } from "../../../contracts/SmartDCA/SmartDCALens.sol";
import { SmartDCAMath } from "../../../contracts/SmartDCA/SmartDCAMath.sol";
import { MockVToken } from "./mocks/SmartDCAMocks.sol";
import { SmartDCABase } from "./SmartDCABase.t.sol";

/// @notice Fuzz checks that each SmartDCA call moves exactly the amounts it should. Expected values are rebuilt
///         from the source shares and the mock Hub's price, not read from the contract.
contract SmartDCA_CallAmountsTest is SmartDCABase {
    uint256 internal constant BPS = 10_000;
    /// @dev The mock Hub's shares have 24 decimals: `assets = shares * pricePerShare / 1e24`
    uint256 internal constant HUB_SCALE = 1e24;

    SmartDCALens internal lens;

    function setUp() public override {
        super.setUp();
        lens = new SmartDCALens();
    }

    /// @dev Cancel pays the plan's stable left, at the Hub price, less the fee on its own interest, and every unit
    ///      of asset it owns
    function testFuzz_cancelPlan_paysStableLeftLessFeeAndAllBoughtAsset(
        uint256 amount,
        uint8 buys,
        uint8 settled,
        uint256 priceBps,
        uint16 feeBps
    ) public {
        buys = uint8(bound(buys, 2, 24));
        settled = uint8(bound(settled, 0, buys - 1));
        amount = bound(amount, 10e18 * uint256(buys), 1e27);
        dca.setFeeRate(uint16(bound(feeBps, 0, 2_000)));
        uint256 planId = _create(alice, amount, buys);
        _create(bob, 5_000e18, 12);
        for (uint256 i; i < settled; ++i) _runRound(1);
        hub.setPricePerShare((hub.pricePerShare() * bound(priceBps, 8_000, 15_000)) / BPS);

        ISmartDCA.Plan memory p = _plan(planId);
        uint256 unitsLeft = p.scheduleStableUnits - p.stableUnitsPerBuy * settled;
        (, , uint256 sharesHeld, uint256 unitsIssued) = dca.yieldSources(pairId, ISmartDCA.Side.Stable);
        uint256 redeemed = (Math.mulDiv(unitsLeft, sharesHeld, unitsIssued) * hub.pricePerShare()) / HUB_SCALE;
        uint256 principalLeft = p.principalPerBuy * (buys - settled);
        uint256 fee = redeemed > principalLeft ? ((redeemed - principalLeft) * dca.feeRateBps()) / BPS : 0;
        uint256 owed = lens.getPlan(dca, planId).assetUnits;
        (, , uint256 assetShares, uint256 assetUnits) = dca.yieldSources(pairId, ISmartDCA.Side.Asset);
        uint256 assetPaid = owed == 0 ? 0 : (Math.mulDiv(owed, assetShares, assetUnits) * VBTC_RATE) / 1e18;

        vm.prank(alice);
        dca.cancelPlan(planId, false, alice);

        assertEq(usdt.balanceOf(alice), redeemed - fee, "stable paid");
        assertEq(usdt.balanceOf(reserve), fee, "fee");
        assertEq(btcb.balanceOf(alice), assetPaid, "asset paid");
        assertEq(uint8(_plan(planId).status), uint8(ISmartDCA.PlanStatus.Cancelled), "closed");
    }

    /// @dev Partial withdrawals never take more units than owed and pay at least what was asked, as the asset or as
    ///      vTokens worth it; the last one empties the plan. With `moveSource` the asset side first moves to a vToken
    ///      at another rate, so units and shares are no longer one to one.
    function testFuzz_withdrawBought_partialsPayTheAskAndNeverMoreThanOwed(
        uint256 amount,
        uint8 settled,
        uint256 rateBps,
        uint256[3] memory asks,
        bool toCore,
        bool moveSource
    ) public {
        settled = uint8(bound(settled, 1, 6));
        amount = bound(amount, 1_200e18, 1e27);
        uint256 planId = _create(alice, amount, 12);
        _create(bob, 3_000e18, 6);
        for (uint256 i; i < settled; ++i) _runRound(1);
        MockVToken source = vBTC;
        if (moveSource) {
            source = new MockVToken(address(btcb), 3e26 + 12_345);
            comptroller.list(address(source));
            dca.setYieldSource(pairId, ISmartDCA.Side.Asset, ISmartDCA.SourceKind.Core, address(source));
        }
        source.setExchangeRate((source.exchangeRate() * bound(rateBps, 10_000, 13_000)) / BPS);

        uint256 owedStart = lens.getPlan(dca, planId).assetUnits;
        uint256 unitsTaken;
        for (uint256 i; i < 3; ++i) {
            uint256 owed = lens.getPlan(dca, planId).assetUnits;
            uint256 value = (Math.mulDiv(owed, _assetShares(), _assetUnits()) * source.exchangeRate()) / 1e18;
            if (value < 2) break;
            uint256 ask = bound(asks[i], 1, value / 2);
            uint256 paidBefore = _plan(planId).assetUnitsPaid;
            uint256 btcBefore = btcb.balanceOf(alice);
            uint256 vBefore = source.balanceOf(alice);

            vm.prank(alice);
            dca.withdrawBought(planId, ask, toCore, alice);

            uint256 units = _plan(planId).assetUnitsPaid - paidBefore;
            assertLe(units, owed, "units over owed");
            unitsTaken += units;
            if (toCore) {
                uint256 vReceived = source.balanceOf(alice) - vBefore;
                assertGe((vReceived * source.exchangeRate()) / 1e18, ask, "vTokens worth the ask");
            } else {
                assertGe(btcb.balanceOf(alice) - btcBefore, ask, "asset at least the ask");
            }
        }
        vm.prank(alice);
        dca.withdrawBought(planId, type(uint256).max, toCore, alice);
        assertEq(lens.getPlan(dca, planId).assetUnits, 0, "emptied");
        assertEq(_plan(planId).assetUnitsPaid, owedStart, "paid exactly what was owed");
        assertGe(owedStart, unitsTaken, "partials within owed");
    }

    /// @dev A top up moves the round totals and the last round's ending sums by exactly the plan's increase per
    ///      buy, keeps what the plan bought, and restarts the schedule at the next unsettled round
    function testFuzz_topUpPlan_movesRoundTotalsByTheIncreaseOnly(
        uint256 amount,
        uint8 buys,
        uint8 settled,
        uint256 added,
        uint256 priceBps
    ) public {
        buys = uint8(bound(buys, 2, 24));
        settled = uint8(bound(settled, 0, buys - 1));
        amount = bound(amount, 10e18 * uint256(buys), 1e27);
        uint256 planId = _create(alice, amount, buys);
        _create(bob, 5_000e18, 12);
        for (uint256 i; i < settled; ++i) _runRound(1);
        hub.setPricePerShare((hub.pricePerShare() * bound(priceBps, 9_000, 13_000)) / BPS);
        uint8 left = buys - settled;
        added = bound(added, 10e18 * uint256(left), 1e27);

        ISmartDCA.Plan memory before = _plan(planId);
        ISmartDCA.Pair memory pairBefore = _pair();
        uint32 lastRound = before.scheduleFirstRound + buys - 1;
        ISmartDCA.Round memory lastBefore = _round(lastRound);
        uint256 owedBefore = lens.getPlan(dca, planId).assetUnits;

        _topUp(alice, planId, added);

        ISmartDCA.Plan memory afterTopUp = _plan(planId);
        uint256 unitIncrease = afterTopUp.stableUnitsPerBuy - before.stableUnitsPerBuy;
        uint256 principalIncrease = afterTopUp.principalPerBuy - before.principalPerBuy;
        assertEq(principalIncrease, added / left, "principal per buy");
        assertEq(_pair().roundStableUnits - pairBefore.roundStableUnits, unitIncrease, "round units");
        assertEq(_pair().roundPrincipal - pairBefore.roundPrincipal, principalIncrease, "round principal");
        ISmartDCA.Round memory lastAfter = _round(lastRound);
        assertEq(lastAfter.stableUnitsEnding - lastBefore.stableUnitsEnding, unitIncrease, "ending units");
        assertEq(lastAfter.principalEnding - lastBefore.principalEnding, principalIncrease, "ending principal");
        assertEq(afterTopUp.scheduleFirstRound, before.scheduleFirstRound + settled, "first round");
        assertEq(afterTopUp.scheduleBuys, left, "buys left");
        assertEq(lens.getPlan(dca, planId).assetUnits, owedBefore, "bought asset kept");
    }

    /// @dev `startRound` redeems the round's units at the Hub price, sends the fee on the interest to the Reserve
    ///      and keeps the rest to swap
    function testFuzz_startRound_sendsTheFeeAndKeepsTheNet(
        uint256 a,
        uint256 b,
        uint256 priceBps,
        uint16 feeBps,
        uint8 parts
    ) public {
        dca.setFeeRate(uint16(bound(feeBps, 0, 2_000)));
        _create(alice, bound(a, 120e18, 1e27), 12);
        _create(bob, bound(b, 60e18, 1e27), 6);
        hub.setPricePerShare((hub.pricePerShare() * bound(priceBps, 8_000, 15_000)) / BPS);
        parts = uint8(bound(parts, 1, 10));

        ISmartDCA.Pair memory pair = _pair();
        (, , uint256 sharesHeld, uint256 unitsIssued) = dca.yieldSources(pairId, ISmartDCA.Side.Stable);
        uint256 redeemed = (Math.mulDiv(pair.roundStableUnits, sharesHeld, unitsIssued) * hub.pricePerShare()) /
            HUB_SCALE;
        (uint256 fee, uint16 charged) = SmartDCAMath.roundFee(redeemed, pair.roundPrincipal, dca.feeRateBps());

        vm.warp(dca.nextLockTime(pairId));
        vm.prank(keeper);
        dca.startRound(pairId, parts);

        ISmartDCA.Round memory r = _round(pair.lastSettledRound + 1);
        assertEq(r.stableRedeemed, redeemed, "redeemed");
        assertEq(r.stableNet + fee, r.stableRedeemed, "net plus fee");
        assertEq(r.feeRateBps, charged, "rate charged");
        assertEq(r.stableToSwap, r.stableNet, "all net to swap");
        assertEq(r.partsTotal, parts, "parts");
        assertEq(usdt.balanceOf(reserve), fee, "fee to Reserve");
        assertEq(usdt.balanceOf(address(dca)), r.stableNet, "net held");
    }

    /// @dev Each part sells an even share of what is left, the parts sum to the round's net, settle reverts until the
    ///      last part, and no part runs after it. A resplit after `cut` parts changes only the count left.
    function testFuzz_swapRoundPart_partsSumToTheNetAndSettleWaits(
        uint8 parts,
        uint8 cut,
        uint8 resplit,
        uint256 amount
    ) public {
        parts = uint8(bound(parts, 1, 10));
        cut = uint8(bound(cut, 0, parts - 1));
        resplit = uint8(bound(resplit, 0, 10));
        _create(alice, bound(amount, 120e18, 1e27), 12);
        vm.warp(dca.nextLockTime(pairId));
        uint32 round = _pair().lastSettledRound + 1;
        vm.startPrank(keeper);
        dca.startRound(pairId, parts);
        uint256 net = _round(round).stableNet;
        uint256 sold;

        for (uint256 done; ; ++done) {
            if (done == cut && resplit != 0) dca.resplitRound(pairId, resplit);
            ISmartDCA.Round memory r = _round(round);
            if (r.partsDone == r.partsTotal) break;
            vm.expectRevert(ISmartDCA.PartsLeft.selector);
            dca.settleRound(pairId);
            uint256 expectedIn = r.stableToSwap / (r.partsTotal - r.partsDone);
            dca.swapRoundPart(pairId, ANY_QUOTE, _swapData(pairId));
            assertEq(r.stableToSwap - _round(round).stableToSwap, expectedIn, "even share of what is left");
            sold += expectedIn;
        }
        assertEq(sold, net, "parts sum to net");
        assertEq(_round(round).stableToSwap, 0, "nothing left");
        bytes memory data = _swapData(pairId);
        vm.expectRevert(ISmartDCA.NoPartsLeft.selector);
        dca.swapRoundPart(pairId, ANY_QUOTE, data);
        dca.settleRound(pairId);
        vm.stopPrank();
        assertEq(_pair().lastSettledRound, round, "settled");
    }

    function _assetShares() internal view returns (uint256 shares) {
        (, , shares, ) = dca.yieldSources(pairId, ISmartDCA.Side.Asset);
    }

    function _assetUnits() internal view returns (uint256 units) {
        (, , , units) = dca.yieldSources(pairId, ISmartDCA.Side.Asset);
    }
}
