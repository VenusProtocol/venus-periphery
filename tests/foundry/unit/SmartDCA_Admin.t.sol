// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

// solhint-disable func-name-mixedcase, ordering, import-path-check

import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import { AccessControlledV8 } from "@venusprotocol/governance-contracts/contracts/Governance/AccessControlledV8.sol";
import { ISmartDCA } from "../../../contracts/SmartDCA/ISmartDCA.sol";
import { SmartDCA } from "../../../contracts/SmartDCA/SmartDCA.sol";
import { MockERC20 } from "./mocks/MockERC20.sol";
import { MockHub, MockVToken } from "./mocks/SmartDCAMocks.sol";
import { SmartDCABase } from "./SmartDCABase.t.sol";

contract SmartDCA_AdminTest is SmartDCABase {
    address internal stranger = makeAddr("stranger");

    function test_initialize_revertsOnAZeroReserve() public {
        SmartDCA impl = new SmartDCA(address(comptroller), address(registry), address(oracle), address(swapHelper));
        vm.expectRevert(ISmartDCA.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), abi.encodeCall(SmartDCA.initialize, (address(acm), address(0))));
    }

    function test_initialize_revertsOnTheImplementation() public {
        SmartDCA impl = new SmartDCA(address(comptroller), address(registry), address(oracle), address(swapHelper));
        vm.expectRevert(bytes("Initializable: contract is already initialized"));
        impl.initialize(address(acm), reserve);
    }

    function test_initialize_onlyOnce() public {
        vm.expectRevert(bytes("Initializable: contract is already initialized"));
        dca.initialize(address(acm), reserve);
        assertEq(dca.reserve(), reserve);
        assertEq(dca.maxSlippageBps(), 10);
        assertEq(dca.maxParts(), 10);
        assertEq(dca.minBuys(), 2);
        assertEq(dca.maxBuys(), 60);
    }

    function test_initialize_anchorsRoundZeroOnTheLatestPassed15th() public view {
        // Deployed on Oct 19 2026, after Oct 15, so October is round 0 and November round 1
        assertEq(dca.anchorMonth(), ANCHOR_MONTH);
        assertEq(dca.roundStart(NOV), NOV_LOCK);
        assertEq(dca.roundStart(NOV + 12), 1_826_208_000, "a year on, still the 15th: 2027-11-14 16:00 UTC");
    }

    function test_setters_needAcmPermission() public {
        vm.startPrank(stranger);
        _expectUnauthorized("setFeeRate(uint16)");
        dca.setFeeRate(1);
        _expectUnauthorized("setMaxFeeRate(uint16)");
        dca.setMaxFeeRate(1_000);
        _expectUnauthorized("setMaxSlippage(uint16)");
        dca.setMaxSlippage(1);
        _expectUnauthorized("setMaxParts(uint8)");
        dca.setMaxParts(1);
        _expectUnauthorized("pause()");
        dca.pause();
        _expectUnauthorized("setYieldSource(uint32,uint8,uint8,address)");
        dca.setYieldSource(pairId, ISmartDCA.Side.Stable, ISmartDCA.SourceKind.Hub, address(hub));
        _expectUnauthorized("setKeeper(address,bool)");
        dca.setKeeper(stranger, true);
        _expectUnauthorized("setMinAmountPerBuy(address,uint256)");
        dca.setMinAmountPerBuy(address(usdt), 1);
        _expectUnauthorized("setBuyBounds(uint8,uint8)");
        dca.setBuyBounds(2, 3);
        _expectUnauthorized("addPair(address,address,uint8,address,uint8,address)");
        _addPair(address(usdt), address(btcb), address(hub), address(vBTC));
        _expectUnauthorized("setPairEnabled(uint32,bool)");
        dca.setPairEnabled(pairId, false);
        _expectUnauthorized("unpause()");
        dca.unpause();
        _expectUnauthorized("sweepToken(address,address)");
        dca.sweepToken(address(usdt), stranger);
        _expectUnauthorized("setReserve(address)");
        dca.setReserve(stranger);
        _expectUnauthorized("setAllowedRouter(address,bool)");
        dca.setAllowedRouter(stranger, true);
        vm.stopPrank();
    }

    function test_setters_hardCaps() public {
        vm.expectRevert(ISmartDCA.AboveHardCap.selector);
        dca.setFeeRate(2_001);
        vm.expectRevert(ISmartDCA.AboveHardCap.selector);
        dca.setMaxSlippage(101);
        vm.expectRevert(ISmartDCA.AboveHardCap.selector);
        dca.setMaxParts(51);
        vm.expectRevert(ISmartDCA.InvalidParameter.selector);
        dca.setMaxParts(0);
        vm.expectRevert(ISmartDCA.AboveHardCap.selector);
        dca.setBuyBounds(2, 121);
        vm.expectRevert(ISmartDCA.InvalidParameter.selector);
        dca.setBuyBounds(5, 4);
        vm.expectRevert(ISmartDCA.InvalidParameter.selector);
        dca.setMinAmountPerBuy(address(usdt), 0);
        vm.expectRevert(ISmartDCA.ZeroAddress.selector);
        dca.setReserve(address(0));
        vm.expectRevert(ISmartDCA.ZeroAddress.selector);
        dca.setKeeper(address(0), true);
        vm.expectRevert(ISmartDCA.ZeroAddress.selector);
        dca.setAllowedRouter(address(0), true);
    }

    function test_setAllowedRouter_addsAndRemoves() public {
        address router = makeAddr("router");
        vm.expectEmit(address(dca));
        emit ISmartDCA.RouterAllowlisted(router, true);
        dca.setAllowedRouter(router, true);
        assertTrue(dca.allowedRouters(router));

        vm.expectEmit(address(dca));
        emit ISmartDCA.RouterAllowlisted(router, false);
        dca.setAllowedRouter(router, false);
        assertFalse(dca.allowedRouters(router));
    }

    function test_addPair_rejectsBadInputsThenAdds() public {
        MockERC20 eth = new MockERC20("ETH", "ETH", 18);

        MockVToken vETH = new MockVToken(address(eth), VBTC_RATE);
        comptroller.list(address(vETH));

        vm.expectRevert(ISmartDCA.SameTokens.selector);
        _addPair(address(usdt), address(usdt), address(hub), address(vETH));
        vm.expectRevert(ISmartDCA.PairExists.selector);
        _addPair(address(usdt), address(btcb), address(hub), address(vBTC));
        // The asset source must hold the asset
        // No oracle price for ETH yet
        vm.expectRevert(bytes("no price"));
        _addPair(address(usdt), address(eth), address(hub), address(vETH));

        oracle.setPrice(address(eth), 3_000e18);
        vm.expectRevert(abi.encodeWithSelector(ISmartDCA.InvalidSource.selector, address(vBTC)));
        _addPair(address(usdt), address(eth), address(hub), address(vBTC));
        vm.expectRevert(ISmartDCA.ZeroAddress.selector);
        _addPair(address(usdt), address(eth), address(0), address(vETH));

        vm.expectEmit(address(dca));
        emit ISmartDCA.PairAdded(2, address(usdt), address(eth));
        vm.expectEmit(address(dca));
        emit ISmartDCA.YieldSourceUpdated(
            2,
            ISmartDCA.Side.Stable,
            address(0),
            ISmartDCA.SourceKind.Hub,
            address(hub),
            0
        );
        vm.expectEmit(address(dca));
        emit ISmartDCA.YieldSourceUpdated(
            2,
            ISmartDCA.Side.Asset,
            address(0),
            ISmartDCA.SourceKind.Core,
            address(vETH),
            0
        );
        assertEq(_addPair(address(usdt), address(eth), address(hub), address(vETH)), 2);
        assertEq(dca.pairIdByTokens(address(usdt), address(eth)), 2);
        (ISmartDCA.SourceKind kind, address source, , ) = dca.yieldSources(2, ISmartDCA.Side.Asset);
        assertEq(uint8(kind), uint8(ISmartDCA.SourceKind.Core));
        assertEq(source, address(vETH));
    }

    function test_setPairEnabled_falseBlocksTopUps() public {
        uint256 id = _create(alice, 1200e18, 12);
        vm.expectEmit(address(dca));
        emit ISmartDCA.PairEnabledUpdated(pairId, false);
        dca.setPairEnabled(pairId, false);

        usdt.mint(alice, 120e18);
        vm.startPrank(alice);
        usdt.approve(address(dca), 120e18);
        vm.expectRevert(ISmartDCA.PairDisabled.selector);
        dca.topUpPlan(id, 120e18);
        // Leaving still works
        dca.cancelPlan(id, alice);
        vm.stopPrank();
    }

    function test_setYieldSource_rejectsWrongSources() public {
        MockHub otherHub = new MockHub(address(btcb));
        registry.set(address(otherHub), true);
        MockHub unregistered = new MockHub(address(usdt));
        MockVToken unlisted = new MockVToken(address(usdt), 1e18);

        vm.expectRevert(abi.encodeWithSelector(ISmartDCA.InvalidSource.selector, address(otherHub)));
        dca.setYieldSource(pairId, ISmartDCA.Side.Stable, ISmartDCA.SourceKind.Hub, address(otherHub));
        vm.expectRevert(abi.encodeWithSelector(ISmartDCA.InvalidSource.selector, address(unregistered)));
        dca.setYieldSource(pairId, ISmartDCA.Side.Stable, ISmartDCA.SourceKind.Hub, address(unregistered));
        vm.expectRevert(abi.encodeWithSelector(ISmartDCA.InvalidSource.selector, address(unlisted)));
        dca.setYieldSource(pairId, ISmartDCA.Side.Stable, ISmartDCA.SourceKind.Core, address(unlisted));
        vm.expectRevert(abi.encodeWithSelector(ISmartDCA.InvalidSource.selector, address(vBTC)));
        dca.setYieldSource(pairId, ISmartDCA.Side.Stable, ISmartDCA.SourceKind.Core, address(vBTC));
        vm.expectRevert(abi.encodeWithSelector(ISmartDCA.InvalidSource.selector, address(hub)));
        dca.setYieldSource(pairId, ISmartDCA.Side.Stable, ISmartDCA.SourceKind.None, address(hub));
        vm.expectRevert(ISmartDCA.SourceUnchanged.selector);
        dca.setYieldSource(pairId, ISmartDCA.Side.Stable, ISmartDCA.SourceKind.Hub, address(hub));
    }

    function test_setYieldSource_migratesWithoutChangingPlans() public {
        uint256 id = _create(alice, 1200e18, 12);
        MockHub hub2 = new MockHub(address(usdt));
        registry.set(address(hub2), true);

        dca.setYieldSource(pairId, ISmartDCA.Side.Stable, ISmartDCA.SourceKind.Hub, address(hub2));

        assertEq(hub.balanceOf(address(dca)), 0);
        assertEq(hub2.balanceOf(address(dca)), 1200e24);
        (, address source, uint256 shares, ) = dca.yieldSources(pairId, ISmartDCA.Side.Stable);
        assertEq(source, address(hub2));
        assertEq(shares, 1200e24);
        assertEq(_plan(id).scheduleStableUnits, 1200e24);

        vm.prank(alice);
        dca.cancelPlan(id, alice);
        assertEq(usdt.balanceOf(alice), 1200e18);
    }

    /// @dev Two pairs sell USDT; moving one pair's USDT leaves the other pair's USDT where it is
    function test_setYieldSource_movesOnlyThatPair() public {
        MockERC20 eth = new MockERC20("ETH", "ETH", 18);
        MockVToken vETH = new MockVToken(address(eth), VBTC_RATE);
        comptroller.list(address(vETH));
        oracle.setPrice(address(eth), 3_000e18);
        uint32 ethPairId = _addPair(address(usdt), address(eth), address(hub), address(vETH));

        uint256 btcPlan = _create(alice, 1200e18, 12);
        usdt.mint(bob, 600e18);
        vm.startPrank(bob);
        usdt.approve(address(dca), 600e18);
        dca.createPlan(ethPairId, 600e18, 6, bob);
        vm.stopPrank();

        MockHub hub2 = new MockHub(address(usdt));
        registry.set(address(hub2), true);
        dca.setYieldSource(pairId, ISmartDCA.Side.Stable, ISmartDCA.SourceKind.Hub, address(hub2));

        // Only the BTCB pair's 1,200 USDT moved; the ETH pair's 600 stayed in the first Hub
        assertEq(hub2.balanceOf(address(dca)), 1200e24);
        assertEq(hub.balanceOf(address(dca)), 600e24);
        (, address ethSource, uint256 ethShares, ) = dca.yieldSources(ethPairId, ISmartDCA.Side.Stable);
        assertEq(ethSource, address(hub));
        assertEq(ethShares, 600e24);

        // A pair locked on its round only blocks its own switch
        vm.warp(NOV_LOCK);
        vm.expectRevert(abi.encodeWithSelector(ISmartDCA.PairLocked.selector, ethPairId));
        dca.setYieldSource(ethPairId, ISmartDCA.Side.Stable, ISmartDCA.SourceKind.Hub, address(hub2));

        vm.prank(alice);
        vm.expectRevert(ISmartDCA.PlanInRunningRound.selector);
        dca.cancelPlan(btcPlan, alice);
    }

    function test_setYieldSource_blockedWhilePairLocked() public {
        _create(alice, 1200e18, 12);
        MockHub hub2 = new MockHub(address(usdt));
        registry.set(address(hub2), true);
        vm.warp(NOV_LOCK);

        vm.expectRevert(abi.encodeWithSelector(ISmartDCA.PairLocked.selector, pairId));
        dca.setYieldSource(pairId, ISmartDCA.Side.Stable, ISmartDCA.SourceKind.Hub, address(hub2));
    }

    function test_sweepToken_onlyWhatIsNotOwed() public {
        _create(alice, 1200e18, 12);

        // Donated Hub shares are sweepable, the plan's are not
        usdt.mint(address(this), 5e18);
        usdt.approve(address(hub), 5e18);
        hub.deposit(5e18, address(dca));
        dca.sweepToken(address(hub), stranger);
        assertEq(hub.balanceOf(stranger), 5e24);
        assertEq(hub.balanceOf(address(dca)), 1200e24);

        // Mid-round stable is owed to the round
        vm.warp(NOV_LOCK);
        vm.prank(keeper);
        dca.startRound(pairId, 1);
        usdt.mint(address(dca), 1e18);
        dca.sweepToken(address(usdt), stranger);
        assertEq(usdt.balanceOf(stranger), 1e18);
        assertEq(usdt.balanceOf(address(dca)), _round(NOV).stableToSwap);
    }

    function test_claimRewards_sendsXvsToReserve() public {
        comptroller.setRewardPerClaim(3e18);
        address[] memory markets = new address[](1);
        markets[0] = address(vBTC);
        vm.expectEmit(address(dca));
        emit ISmartDCA.RewardsClaimed(3e18);
        vm.prank(stranger);
        dca.claimRewards(markets);
        assertEq(comptroller.xvs().balanceOf(reserve), 3e18);
    }

    function test_addPair_needsMinPerBuyForTheStable() public {
        MockERC20 usdc = new MockERC20("USDC", "USDC", 18);
        MockHub usdcHub = new MockHub(address(usdc));
        registry.set(address(usdcHub), true);
        oracle.setPrice(address(usdc), 1e18);

        vm.expectRevert(ISmartDCA.InvalidParameter.selector);
        _addPair(address(usdc), address(btcb), address(usdcHub), address(vBTC));

        dca.setMinAmountPerBuy(address(usdc), 10e18);
        assertEq(_addPair(address(usdc), address(btcb), address(usdcHub), address(vBTC)), 2);
    }

    function test_setters_storeValuesAtTheirCaps() public {
        vm.expectEmit(address(dca));
        emit ISmartDCA.FeeRateUpdated(500, 2_000);
        dca.setFeeRate(2_000);
        vm.expectEmit(address(dca));
        emit ISmartDCA.MaxSlippageUpdated(10, 100);
        dca.setMaxSlippage(100);
        vm.expectEmit(address(dca));
        emit ISmartDCA.MaxPartsUpdated(10, 50);
        dca.setMaxParts(50);
        vm.expectEmit(address(dca));
        emit ISmartDCA.BuyBoundsUpdated(2, 60, 1, 120);
        dca.setBuyBounds(1, 120);
        vm.expectEmit(address(dca));
        emit ISmartDCA.MinAmountPerBuyUpdated(address(usdt), 10e18, 1);
        dca.setMinAmountPerBuy(address(usdt), 1);
        vm.expectEmit(address(dca));
        emit ISmartDCA.ReserveUpdated(reserve, stranger);
        dca.setReserve(stranger);

        assertEq(dca.feeRateBps(), 2_000);
        assertEq(dca.maxSlippageBps(), 100);
        assertEq(dca.maxParts(), 50);
        assertEq(dca.minBuys(), 1);
        assertEq(dca.maxBuys(), 120);
        assertEq(dca.minAmountPerBuy(address(usdt)), 1);
        assertEq(dca.reserve(), stranger);
    }

    function test_setters_rejectZeroInputs() public {
        vm.expectRevert(abi.encodeWithSelector(ISmartDCA.UnknownPair.selector, 9));
        dca.setYieldSource(9, ISmartDCA.Side.Stable, ISmartDCA.SourceKind.Hub, address(hub));
        vm.expectRevert(ISmartDCA.ZeroAddress.selector);
        dca.setYieldSource(pairId, ISmartDCA.Side.Stable, ISmartDCA.SourceKind.Hub, address(0));
        vm.expectRevert(ISmartDCA.ZeroAddress.selector);
        dca.setMinAmountPerBuy(address(0), 1);
        vm.expectRevert(ISmartDCA.ZeroAddress.selector);
        dca.sweepToken(address(usdt), address(0));
        vm.expectRevert(ISmartDCA.InvalidParameter.selector);
        dca.setBuyBounds(0, 5);
    }

    // ----- fee cap -----

    function test_setMaxFeeRate_startsAt20PercentAndRejectsBadValues() public {
        assertEq(dca.maxFeeRateBps(), 2_000);
        vm.expectRevert(ISmartDCA.AboveHardCap.selector);
        dca.setMaxFeeRate(10_001);
        // The fee rate is 5% (500 bps): a cap below it would leave the rate above its own cap
        vm.expectRevert(ISmartDCA.InvalidParameter.selector);
        dca.setMaxFeeRate(499);
    }

    function test_setMaxFeeRate_emitsAndSetFeeRateFollowsIt() public {
        vm.expectEmit(address(dca));
        emit ISmartDCA.MaxFeeRateUpdated(2_000, 3_000);
        dca.setMaxFeeRate(3_000);
        assertEq(dca.maxFeeRateBps(), 3_000);

        // Above the old 20%, allowed under the new cap
        dca.setFeeRate(3_000);
        assertEq(dca.feeRateBps(), 3_000);
        vm.expectRevert(ISmartDCA.AboveHardCap.selector);
        dca.setFeeRate(3_001);

        // Down to the current rate is allowed, and 100% is the ceiling
        dca.setFeeRate(500);
        dca.setMaxFeeRate(500);
        vm.expectRevert(ISmartDCA.AboveHardCap.selector);
        dca.setFeeRate(501);
        dca.setMaxFeeRate(10_000);
        dca.setFeeRate(10_000);
        assertEq(dca.feeRateBps(), 10_000);
    }

    function test_setKeeper_canBeRevoked() public {
        _create(alice, 1200e18, 12);
        vm.expectEmit(address(dca));
        emit ISmartDCA.KeeperUpdated(keeper, false);
        dca.setKeeper(keeper, false);
        assertFalse(dca.isKeeper(keeper));

        vm.warp(NOV_LOCK);
        vm.prank(keeper);
        vm.expectPartialRevert(ISmartDCA.NotRoundCaller.selector);
        dca.startRound(pairId, 1);
    }

    /// @dev Core to Hub and back: plans keep their units, and claim to Core needs a Core source
    function test_setYieldSource_movesTheAssetBetweenCoreAndHub() public {
        uint256 id = _create(alice, 100e18, 2);
        _runRound(1);
        _runRound(1);
        (, , , uint256 unitsBefore) = dca.yieldSources(pairId, ISmartDCA.Side.Asset);

        MockHub btcHub = new MockHub(address(btcb));
        registry.set(address(btcHub), true);
        vm.expectEmit(address(dca));
        emit ISmartDCA.YieldSourceUpdated(
            pairId,
            ISmartDCA.Side.Asset,
            address(vBTC),
            ISmartDCA.SourceKind.Hub,
            address(btcHub),
            1e15
        );
        dca.setYieldSource(pairId, ISmartDCA.Side.Asset, ISmartDCA.SourceKind.Hub, address(btcHub));
        (, , , uint256 unitsAfter) = dca.yieldSources(pairId, ISmartDCA.Side.Asset);
        assertEq(unitsAfter, unitsBefore);
        assertEq(vBTC.balanceOf(address(dca)), 0);

        vm.prank(alice);
        vm.expectRevert(ISmartDCA.NotCoreSource.selector);
        dca.claimPlan(id, true, alice);

        MockVToken vBTC2 = new MockVToken(address(btcb), 3e26);
        comptroller.list(address(vBTC2));
        dca.setYieldSource(pairId, ISmartDCA.Side.Asset, ISmartDCA.SourceKind.Core, address(vBTC2));
        vm.prank(alice);
        dca.claimPlan(id, true, alice);
        assertApproxEqAbs(vBTC2.balanceOf(alice), uint256(1e15 * 1e18) / 3e26, 2);
    }

    function test_sweepToken_keepsTheRoundsBoughtAsset() public {
        _create(alice, 1200e18, 12);
        vm.warp(NOV_LOCK);
        vm.startPrank(keeper);
        dca.startRound(pairId, 2);
        dca.swapRoundPart(pairId, ANY_QUOTE, _swapData(pairId));
        vm.stopPrank();

        btcb.mint(address(dca), 7);
        vm.expectEmit(address(dca));
        emit ISmartDCA.TokenSwept(address(btcb), stranger, 7);
        dca.sweepToken(address(btcb), stranger);
        assertEq(btcb.balanceOf(stranger), 7);
        assertEq(btcb.balanceOf(address(dca)), _round(NOV).assetBought);
    }

    function test_constructor_rejectsZeroAddresses() public {
        vm.expectRevert(ISmartDCA.ZeroAddress.selector);
        new SmartDCA(address(0), address(registry), address(oracle), address(swapHelper));
        vm.expectRevert(ISmartDCA.ZeroAddress.selector);
        new SmartDCA(address(comptroller), address(0), address(oracle), address(swapHelper));
        vm.expectRevert(ISmartDCA.ZeroAddress.selector);
        new SmartDCA(address(comptroller), address(registry), address(0), address(swapHelper));
        vm.expectRevert(ISmartDCA.ZeroAddress.selector);
        new SmartDCA(address(comptroller), address(registry), address(oracle), address(0));
    }

    function _expectUnauthorized(string memory sig) internal {
        vm.expectRevert(abi.encodeWithSelector(AccessControlledV8.Unauthorized.selector, stranger, address(dca), sig));
    }
}
