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
        assertEq(dca.maxSlippage(), 10);
        assertEq(dca.maxSplitN(), 10);
        assertEq(dca.minBuys(), 2);
        assertEq(dca.maxBuys(), 60);
        assertEq(dca.backupDelay(), 9 hours);
    }

    function test_setters_needAcmPermission() public {
        vm.startPrank(stranger);
        _expectUnauthorized("setFeeRate(uint16)");
        dca.setFeeRate(1);
        _expectUnauthorized("setMaxFeeRate(uint16)");
        dca.setMaxFeeRate(1_000);
        _expectUnauthorized("setMaxSlippage(uint16)");
        dca.setMaxSlippage(1);
        _expectUnauthorized("setMaxSplitN(uint8)");
        dca.setMaxSplitN(1);
        _expectUnauthorized("setBackup(address,bool)");
        dca.setBackup(stranger, true);
        _expectUnauthorized("pause()");
        dca.pause();
        _expectUnauthorized("setYieldSource(address,uint8,address)");
        dca.setYieldSource(address(usdt), ISmartDCA.SourceKind.Hub, address(hub));
        _expectUnauthorized("setKeeper(address,bool)");
        dca.setKeeper(stranger, true);
        _expectUnauthorized("setBackupDelay(uint32)");
        dca.setBackupDelay(1);
        _expectUnauthorized("setMinPerBuy(address,uint256)");
        dca.setMinPerBuy(address(usdt), 1);
        _expectUnauthorized("setBuyBounds(uint8,uint8)");
        dca.setBuyBounds(2, 3);
        _expectUnauthorized("addPair(address,address)");
        dca.addPair(address(usdt), address(btcb));
        _expectUnauthorized("setPairEnabled(uint32,bool)");
        dca.setPairEnabled(pairId, false);
        _expectUnauthorized("unpause()");
        dca.unpause();
        _expectUnauthorized("sweepToken(address,address)");
        dca.sweepToken(address(usdt), stranger);
        _expectUnauthorized("setReserve(address)");
        dca.setReserve(stranger);
        vm.stopPrank();
    }

    function test_setters_hardCaps() public {
        vm.expectRevert(ISmartDCA.AboveHardCap.selector);
        dca.setFeeRate(2_001);
        vm.expectRevert(ISmartDCA.AboveHardCap.selector);
        dca.setMaxSlippage(101);
        vm.expectRevert(ISmartDCA.AboveHardCap.selector);
        dca.setMaxSplitN(51);
        vm.expectRevert(ISmartDCA.InvalidParameter.selector);
        dca.setMaxSplitN(0);
        vm.expectRevert(ISmartDCA.AboveHardCap.selector);
        dca.setBackupDelay(24 hours + 1);
        vm.expectRevert(ISmartDCA.AboveHardCap.selector);
        dca.setBuyBounds(2, 121);
        vm.expectRevert(ISmartDCA.InvalidParameter.selector);
        dca.setBuyBounds(5, 4);
        vm.expectRevert(ISmartDCA.InvalidParameter.selector);
        dca.setMinPerBuy(address(usdt), 0);
        vm.expectRevert(ISmartDCA.ZeroAddress.selector);
        dca.setReserve(address(0));
        vm.expectRevert(ISmartDCA.ZeroAddress.selector);
        dca.setKeeper(address(0), true);
    }

    function test_addPair_rejectsBadInputsThenAdds() public {
        MockERC20 eth = new MockERC20("ETH", "ETH", 18);

        vm.expectRevert(ISmartDCA.InvalidPair.selector);
        dca.addPair(address(usdt), address(usdt));
        vm.expectRevert(abi.encodeWithSelector(ISmartDCA.NoYieldSource.selector, address(eth)));
        dca.addPair(address(usdt), address(eth));
        vm.expectRevert(ISmartDCA.PairExists.selector);
        dca.addPair(address(usdt), address(btcb));

        MockVToken vETH = new MockVToken(address(eth), VBTC_RATE);
        comptroller.list(address(vETH));
        dca.setYieldSource(address(eth), ISmartDCA.SourceKind.Core, address(vETH));

        // No oracle price for vETH yet
        vm.expectRevert(bytes("no price"));
        dca.addPair(address(usdt), address(eth));

        oracle.setPrice(address(eth), 3_000e18);
        vm.expectEmit(address(dca));
        emit ISmartDCA.PairAdded(2, address(usdt), address(eth));
        assertEq(dca.addPair(address(usdt), address(eth)), 2);
        assertEq(dca.pairIdOf(address(usdt), address(eth)), 2);
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
        dca.topUp(id, 120e18);
        // Leaving still works
        dca.cancel(id);
        vm.stopPrank();
    }

    function test_setYieldSource_rejectsWrongSources() public {
        MockHub otherHub = new MockHub(address(btcb));
        registry.set(address(otherHub), true);
        MockHub unregistered = new MockHub(address(usdt));
        MockVToken unlisted = new MockVToken(address(usdt), 1e18);

        vm.expectRevert(ISmartDCA.InvalidSource.selector);
        dca.setYieldSource(address(usdt), ISmartDCA.SourceKind.Hub, address(otherHub));
        vm.expectRevert(ISmartDCA.InvalidSource.selector);
        dca.setYieldSource(address(usdt), ISmartDCA.SourceKind.Hub, address(unregistered));
        vm.expectRevert(ISmartDCA.InvalidSource.selector);
        dca.setYieldSource(address(usdt), ISmartDCA.SourceKind.Core, address(unlisted));
        vm.expectRevert(ISmartDCA.InvalidSource.selector);
        dca.setYieldSource(address(usdt), ISmartDCA.SourceKind.Core, address(vBTC));
        vm.expectRevert(ISmartDCA.InvalidSource.selector);
        dca.setYieldSource(address(usdt), ISmartDCA.SourceKind.None, address(hub));
        vm.expectRevert(ISmartDCA.InvalidSource.selector);
        dca.setYieldSource(address(usdt), ISmartDCA.SourceKind.Hub, address(hub));
    }

    function test_setYieldSource_migratesWithoutChangingPlans() public {
        uint256 id = _create(alice, 1200e18, 12);
        MockHub hub2 = new MockHub(address(usdt));
        registry.set(address(hub2), true);

        dca.setYieldSource(address(usdt), ISmartDCA.SourceKind.Hub, address(hub2));

        assertEq(hub.balanceOf(address(dca)), 0);
        assertEq(hub2.balanceOf(address(dca)), 1200e24);
        assertEq(dca.tokenOfSource(address(hub)), address(0));
        assertEq(dca.tokenOfSource(address(hub2)), address(usdt));
        assertEq(_plan(id).stableUnits, 1200e24);

        vm.prank(alice);
        dca.cancel(id);
        assertEq(usdt.balanceOf(alice), 1200e18);
    }

    function test_setYieldSource_blockedWhilePairLocked() public {
        _create(alice, 1200e18, 12);
        MockHub hub2 = new MockHub(address(usdt));
        registry.set(address(hub2), true);
        vm.warp(NOV_LOCK);

        vm.expectRevert(abi.encodeWithSelector(ISmartDCA.TokenLocked.selector, address(usdt)));
        dca.setYieldSource(address(usdt), ISmartDCA.SourceKind.Hub, address(hub2));
    }

    function test_sweep_onlyWhatIsNotOwed() public {
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
        dca.startBuy(pairId, 1);
        usdt.mint(address(dca), 1e18);
        dca.sweepToken(address(usdt), stranger);
        assertEq(usdt.balanceOf(stranger), 1e18);
        assertEq(usdt.balanceOf(address(dca)), _round(NOV).toSwap);
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
        dca.setYieldSource(address(usdc), ISmartDCA.SourceKind.Hub, address(usdcHub));
        oracle.setPrice(address(usdc), 1e18);

        vm.expectRevert(ISmartDCA.InvalidParameter.selector);
        dca.addPair(address(usdc), address(btcb));

        dca.setMinPerBuy(address(usdc), 10e18);
        assertEq(dca.addPair(address(usdc), address(btcb)), 2);
    }

    function test_setters_storeValuesAtTheirCaps() public {
        vm.expectEmit(address(dca));
        emit ISmartDCA.FeeRateUpdated(500, 2_000);
        dca.setFeeRate(2_000);
        vm.expectEmit(address(dca));
        emit ISmartDCA.MaxSlippageUpdated(10, 100);
        dca.setMaxSlippage(100);
        vm.expectEmit(address(dca));
        emit ISmartDCA.MaxSplitNUpdated(10, 50);
        dca.setMaxSplitN(50);
        vm.expectEmit(address(dca));
        emit ISmartDCA.BackupDelayUpdated(9 hours, 24 hours);
        dca.setBackupDelay(24 hours);
        vm.expectEmit(address(dca));
        emit ISmartDCA.BuyBoundsUpdated(2, 60, 1, 120);
        dca.setBuyBounds(1, 120);
        vm.expectEmit(address(dca));
        emit ISmartDCA.MinPerBuyUpdated(address(usdt), 10e18, 1);
        dca.setMinPerBuy(address(usdt), 1);
        vm.expectEmit(address(dca));
        emit ISmartDCA.ReserveUpdated(reserve, stranger);
        dca.setReserve(stranger);

        assertEq(dca.feeRate(), 2_000);
        assertEq(dca.maxSlippage(), 100);
        assertEq(dca.maxSplitN(), 50);
        assertEq(dca.backupDelay(), 24 hours);
        assertEq(dca.minBuys(), 1);
        assertEq(dca.maxBuys(), 120);
        assertEq(dca.minPerBuy(address(usdt)), 1);
        assertEq(dca.reserve(), stranger);
    }

    function test_setters_rejectZeroInputs() public {
        vm.expectRevert(ISmartDCA.ZeroAddress.selector);
        dca.setBackup(address(0), true);
        vm.expectRevert(ISmartDCA.ZeroAddress.selector);
        dca.setYieldSource(address(0), ISmartDCA.SourceKind.Hub, address(hub));
        vm.expectRevert(ISmartDCA.ZeroAddress.selector);
        dca.setYieldSource(address(usdt), ISmartDCA.SourceKind.Hub, address(0));
        vm.expectRevert(ISmartDCA.ZeroAddress.selector);
        dca.setMinPerBuy(address(0), 1);
        vm.expectRevert(ISmartDCA.ZeroAddress.selector);
        dca.sweepToken(address(usdt), address(0));
        vm.expectRevert(ISmartDCA.InvalidParameter.selector);
        dca.setBuyBounds(0, 5);
    }

    // ----- fee cap -----

    function test_setMaxFeeRate_startsAt20PercentAndRejectsBadValues() public {
        assertEq(dca.maxFeeRate(), 2_000);
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
        assertEq(dca.maxFeeRate(), 3_000);

        // Above the old 20%, allowed under the new cap
        dca.setFeeRate(3_000);
        assertEq(dca.feeRate(), 3_000);
        vm.expectRevert(ISmartDCA.AboveHardCap.selector);
        dca.setFeeRate(3_001);

        // Down to the current rate is allowed, and 100% is the ceiling
        dca.setFeeRate(500);
        dca.setMaxFeeRate(500);
        vm.expectRevert(ISmartDCA.AboveHardCap.selector);
        dca.setFeeRate(501);
        dca.setMaxFeeRate(10_000);
        dca.setFeeRate(10_000);
        assertEq(dca.feeRate(), 10_000);
    }

    function test_setKeeperAndBackup_canBeRevoked() public {
        _create(alice, 1200e18, 12);
        vm.expectEmit(address(dca));
        emit ISmartDCA.KeeperUpdated(keeper, false);
        dca.setKeeper(keeper, false);
        vm.expectEmit(address(dca));
        emit ISmartDCA.BackupUpdated(backup, false);
        dca.setBackup(backup, false);
        assertFalse(dca.isKeeper(keeper));
        assertFalse(dca.isBackup(backup));

        vm.warp(NOV_LOCK + 9 hours);
        vm.prank(keeper);
        vm.expectRevert(ISmartDCA.NotAllowedCaller.selector);
        dca.startBuy(pairId, 1);
        vm.prank(backup);
        vm.expectRevert(ISmartDCA.NotAllowedCaller.selector);
        dca.startBuy(pairId, 1);
    }

    /// @dev Core to Hub and back: plans keep their units, and claim to Core needs a Core source
    function test_setYieldSource_movesTheAssetBetweenCoreAndHub() public {
        uint256 id = _create(alice, 100e18, 2);
        _runRound(1);
        _runRound(1);
        (, , , uint256 unitsBefore) = dca.sources(address(btcb));

        MockHub btcHub = new MockHub(address(btcb));
        registry.set(address(btcHub), true);
        vm.expectEmit(address(dca));
        emit ISmartDCA.YieldSourceUpdated(
            address(btcb),
            address(vBTC),
            ISmartDCA.SourceKind.Hub,
            address(btcHub),
            1e15
        );
        dca.setYieldSource(address(btcb), ISmartDCA.SourceKind.Hub, address(btcHub));
        (, , , uint256 unitsAfter) = dca.sources(address(btcb));
        assertEq(unitsAfter, unitsBefore);
        assertEq(vBTC.balanceOf(address(dca)), 0);

        vm.prank(alice);
        vm.expectRevert(ISmartDCA.NotCoreSource.selector);
        dca.claim(id, true);

        MockVToken vBTC2 = new MockVToken(address(btcb), 3e26);
        comptroller.list(address(vBTC2));
        dca.setYieldSource(address(btcb), ISmartDCA.SourceKind.Core, address(vBTC2));
        vm.prank(alice);
        dca.claim(id, true);
        assertApproxEqAbs(vBTC2.balanceOf(alice), uint256(1e15 * 1e18) / 3e26, 2);
    }

    function test_sweep_keepsTheRoundsBoughtAsset() public {
        _create(alice, 1200e18, 12);
        vm.warp(NOV_LOCK);
        vm.startPrank(keeper);
        dca.startBuy(pairId, 2);
        dca.executeOrder(pairId, ANY_QUOTE, _swapData(pairId));
        vm.stopPrank();

        btcb.mint(address(dca), 7);
        vm.expectEmit(address(dca));
        emit ISmartDCA.TokenSwept(address(btcb), stranger, 7);
        dca.sweepToken(address(btcb), stranger);
        assertEq(btcb.balanceOf(stranger), 7);
        assertEq(btcb.balanceOf(address(dca)), _round(NOV).amountOut);
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
