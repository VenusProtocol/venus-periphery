// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

// solhint-disable func-name-mixedcase, ordering, import-path-check, max-states-count, no-console

import { Test } from "forge-std/Test.sol";
import { console } from "forge-std/console.sol";

import { SmartDCA } from "../../../contracts/SmartDCA/SmartDCA.sol";
import { ISmartDCA } from "../../../contracts/SmartDCA/ISmartDCA.sol";
import { SmartDCALens } from "../../../contracts/SmartDCA/SmartDCALens.sol";
import { SmartDCAMath } from "../../../contracts/SmartDCA/SmartDCAMath.sol";
import { MockERC20 } from "./mocks/MockERC20.sol";
import { MockHub, MockPancakeV3Router, MockSwapHelper, MockVToken } from "./mocks/SmartDCAMocks.sol";
import { SmartDCABase } from "./SmartDCABase.t.sol";

/**
 * @title SmartDCAHandler
 * @notice Bounded actor for the stateful invariant fuzz. Each action picks a real plan, pair or caller, so the
 * fuzzer spends its calls on state changes instead of reverts. Expected rejections (a locked plan, a small top
 * up) are ignored; an arithmetic panic is recorded, because no input should cause one.
 */
contract SmartDCAHandler is Test {
    bytes4 internal constant PANIC = 0x4e487b71;
    /// @notice Caps the plan list so the invariant loops stay cheap
    uint256 internal constant MAX_PLANS = 40;

    SmartDCA internal immutable DCA;
    MockERC20 internal immutable USDT;
    MockHub internal immutable HUB;
    address internal immutable KEEPER;
    MockVToken[2] internal vTokens;
    uint32[2] internal pairIds;
    address[4] internal users;
    uint256[] internal ids;

    /// @notice Tracked here: under via-ir a `block.timestamp` read after `vm.warp` can return the old value
    uint256 public time;
    /// @notice Revert data of the first arithmetic panic, empty while there is none
    bytes public panic;

    // Ghost counters, logged by `SmartDCA_InvariantsTest.afterInvariant` to show which paths a run reached.
    uint256 public creates;
    uint256 public topUps;
    uint256 public withdraws;
    uint256 public cancels;
    uint256 public claims;
    uint256 public transfers;
    uint256 public forceBuys;
    uint256 public buysStarted;
    uint256 public orders;
    uint256 public resplits;
    uint256 public settles;

    constructor(
        SmartDCA dca_,
        MockERC20 usdt_,
        MockHub hub_,
        MockVToken[2] memory vTokens_,
        uint32[2] memory pairIds_,
        address keeper_,
        address[4] memory users_
    ) {
        DCA = dca_;
        USDT = usdt_;
        HUB = hub_;
        vTokens = vTokens_;
        pairIds = pairIds_;
        KEEPER = keeper_;
        users = users_;
        time = block.timestamp;
    }

    // ----- users -----

    function createPlan(uint256 userSeed, uint256 pairSeed, uint256 amount, uint256 buys) external {
        if (ids.length >= MAX_PLANS) return;
        address user = users[userSeed % 4];
        // Dust plans and large ones: min per buy is 1e6. Up to 6 buys, so plans mature within a run.
        amount = bound(amount, 2e6, 1e24);
        _fund(user, amount);
        (bool ok, bytes memory ret) = _call(
            user,
            abi.encodeCall(DCA.createPlan, (pairIds[pairSeed % 2], amount, uint8(bound(buys, 2, 6)), user))
        );
        if (!ok) return;
        ids.push(abi.decode(ret, (uint256)));
        ++creates;
    }

    function topUpPlan(uint256 planSeed, uint256 amount) external {
        if (ids.length == 0) return;
        uint256 id = ids[planSeed % ids.length];
        address owner = _owner(id);
        amount = bound(amount, 1, 1e22);
        _fund(owner, amount);
        (bool ok, ) = _call(owner, abi.encodeCall(DCA.topUpPlan, (id, amount)));
        if (ok) ++topUps;
    }

    function withdrawBought(uint256 planSeed, uint256 amount, bool all) external {
        if (ids.length == 0) return;
        uint256 id = ids[planSeed % ids.length];
        amount = all ? type(uint256).max : bound(amount, 1, 1e12);
        (bool ok, ) = _call(_owner(id), abi.encodeCall(DCA.withdrawBought, (id, amount, _owner(id))));
        if (ok) ++withdraws;
    }

    function cancelPlan(uint256 planSeed) external {
        if (ids.length == 0) return;
        uint256 id = ids[planSeed % ids.length];
        (bool ok, ) = _call(_owner(id), abi.encodeCall(DCA.cancelPlan, (id, _owner(id))));
        if (ok) ++cancels;
    }

    function claimPlan(uint256 planSeed, bool toCore) external {
        if (ids.length == 0) return;
        uint256 id = ids[planSeed % ids.length];
        (bool ok, ) = _call(_owner(id), abi.encodeCall(DCA.claimPlan, (id, toCore, _owner(id))));
        if (ok) ++claims;
    }

    function transferPlan(uint256 planSeed, uint256 toSeed) external {
        if (ids.length == 0) return;
        uint256 id = ids[planSeed % ids.length];
        (bool ok, ) = _call(_owner(id), abi.encodeCall(DCA.transferPlan, (id, users[toSeed % 4])));
        if (ok) ++transfers;
    }

    // ----- keeper -----

    /// @notice Up to `steps` steps of the pair's next round: start it, swap one part each, settle it. Moves time
    ///         to the round's lock time first, else most calls land before the lock and revert. Several steps
    ///         per call so enough rounds settle for plans to mature; one step leaves a round half done for the
    ///         other actions.
    function roundStep(uint256 pairSeed, uint256 parts, uint256 steps) external {
        uint32 pid = pairIds[pairSeed % 2];
        uint256 start = DCA.nextLockTime(pid);
        if (time < start) {
            time = start;
            vm.warp(time);
        }
        steps = bound(steps, 1, 5);
        for (uint256 i; i < steps; ++i) {
            ISmartDCA.Round memory r = _round(pid);
            bool ok;
            if (r.partsTotal == 0) {
                (ok, ) = _call(KEEPER, abi.encodeCall(DCA.startRound, (pid, uint8(bound(parts, 1, 3)))));
                // An empty round settles inside `startRound` and starts nothing
                if (!ok || _round(pid).partsTotal == 0) return;
                ++buysStarted;
            } else if (r.partsDone < r.partsTotal) {
                (ok, ) = _call(KEEPER, abi.encodeCall(DCA.swapRoundPart, (pid, 1, _swapData(pid))));
                if (!ok) return;
                ++orders;
            } else {
                (ok, ) = _call(KEEPER, abi.encodeCall(DCA.settleRound, (pid)));
                if (ok) ++settles;
                // The next round's lock is a month away
                return;
            }
        }
    }

    /// @notice One `forceBuy` step on the pair, as the Guardian; mixes with the keeper's `roundStep` on the same round
    function forceBuy(uint256 pairSeed, uint256 parts) external {
        uint32 pid = pairIds[pairSeed % 2];
        uint256 start = DCA.nextLockTime(pid);
        if (time < start) {
            time = start;
            vm.warp(time);
        }
        (bool ok, ) = _call(address(this), abi.encodeCall(DCA.forceBuy, (pid, uint8(bound(parts, 1, 3)))));
        if (ok) ++forceBuys;
    }

    function resplitRound(uint256 pairSeed, uint256 parts) external {
        (bool ok, ) = _call(
            KEEPER,
            abi.encodeCall(DCA.resplitRound, (pairIds[pairSeed % 2], uint8(bound(parts, 1, 3))))
        );
        if (ok) ++resplits;
    }

    // ----- market and admin -----

    /// @notice Moves the Hub share price and one vToken rate by up to 0.2% down or 0.3% up
    function moveRates(uint256 hubBps, uint256 vTokenSeed, uint256 vTokenBps) external {
        HUB.setPricePerShare((HUB.pricePerShare() * bound(hubBps, 9_980, 10_030)) / 10_000);
        MockVToken vToken = vTokens[vTokenSeed % 2];
        vToken.setExchangeRate((vToken.exchangeRate() * bound(vTokenBps, 9_980, 10_030)) / 10_000);
    }

    function setFeeRate(uint256 bps) external {
        DCA.setFeeRate(uint16(bound(bps, 0, 2_000)));
    }

    function passTime(uint256 seconds_) external {
        time += bound(seconds_, 1 hours, 20 days);
        vm.warp(time);
    }

    // ----- reads for the test -----

    function planCount() external view returns (uint256) {
        return ids.length;
    }

    function planId(uint256 i) external view returns (uint256) {
        return ids[i];
    }

    // ----- helpers -----

    function _call(address caller, bytes memory data) internal returns (bool ok, bytes memory ret) {
        vm.prank(caller);
        (ok, ret) = address(DCA).call(data);
        if (!ok && ret.length >= 4 && bytes4(ret) == PANIC && panic.length == 0) panic = ret;
    }

    function _fund(address user, uint256 amount) internal {
        USDT.mint(user, amount);
        vm.prank(user);
        USDT.approve(address(DCA), amount);
    }

    function _owner(uint256 id) internal view returns (address owner) {
        (owner, , , , , , , , , , ) = DCA.plans(id);
    }

    function _swapData(uint32 pid) internal pure returns (bytes memory) {
        return abi.encodeCall(MockSwapHelper.swap, (pid));
    }

    function _round(uint32 pid) internal view returns (ISmartDCA.Round memory r) {
        (, , , , uint32 lastSettledRound, , , , , ) = DCA.pairs(pid);
        (r.partsTotal, r.partsDone, , , , , , , , , , , , ) = DCA.rounds(pid, lastSettledRound + 1);
    }
}

/// forge-config: default.invariant.runs = 64
/// forge-config: default.invariant.depth = 200
/**
 * @title SmartDCA_InvariantsTest
 * @notice Stateful invariant fuzz over two pairs that share USDT (a Hub source) and buy BTCB and ETH (Core
 * sources). The fuzzer drives only `SmartDCAHandler`, and every `invariant_` below must hold after each call.
 */
contract SmartDCA_InvariantsTest is SmartDCABase {
    SmartDCAHandler internal handler;
    SmartDCALens internal lens;
    MockERC20 internal eth;
    MockVToken internal vETH;
    uint32 internal ethPairId;
    address internal dave = makeAddr("dave");

    // Ghosts: values at the previous invariant check, for the only-forward rule
    mapping(uint32 => uint32) internal lastSettled;
    mapping(uint32 => uint256) internal lastAssetPerUnitIndex;
    mapping(uint32 => uint256) internal lastCumBaseIndex;

    function setUp() public override {
        super.setUp();
        lens = new SmartDCALens();
        eth = new MockERC20("ETH", "ETH", 18);
        vETH = new MockVToken(address(eth), 3e26);
        comptroller.list(address(vETH));
        // Same price as BTCB, so the one mock swapHelper rate fills both pairs
        oracle.setPrice(address(eth), BTC_PRICE);
        ethPairId = _addPair(address(usdt), address(eth), address(hub), address(vETH));
        dca.setMinAmountPerBuy(address(usdt), 1e6);

        handler = new SmartDCAHandler(
            dca,
            usdt,
            hub,
            [vBTC, vETH],
            [pairId, ethPairId],
            keeper,
            [alice, bob, carol, dave]
        );
        // For `setFeeRate` and `forceBuy`
        acm.setAllowAll(address(handler), true);
        targetContract(address(handler));

        // `forceBuy` swaps on a mock V3 router at the same rate as the mock SwapHelper
        MockPancakeV3Router router = new MockPancakeV3Router();
        router.setRate(1e18 / 100_000);
        dca.setFallbackRoute(pairId, address(router), abi.encodePacked(address(usdt), uint24(500), address(btcb)));
        dca.setFallbackRoute(ethPairId, address(router), abi.encodePacked(address(usdt), uint24(500), address(eth)));

        bytes4[] memory actions = new bytes4[](12);
        actions[0] = SmartDCAHandler.createPlan.selector;
        actions[1] = SmartDCAHandler.topUpPlan.selector;
        actions[2] = SmartDCAHandler.withdrawBought.selector;
        actions[3] = SmartDCAHandler.cancelPlan.selector;
        actions[4] = SmartDCAHandler.claimPlan.selector;
        actions[5] = SmartDCAHandler.roundStep.selector;
        actions[6] = SmartDCAHandler.resplitRound.selector;
        actions[7] = SmartDCAHandler.moveRates.selector;
        actions[8] = SmartDCAHandler.setFeeRate.selector;
        actions[9] = SmartDCAHandler.passTime.selector;
        actions[10] = SmartDCAHandler.transferPlan.selector;
        actions[11] = SmartDCAHandler.forceBuy.selector;
        // Without this the fuzzer also spends calls on the handler's getters.
        targetSelector(FuzzSelector({ addr: address(handler), selectors: actions }));
    }

    /// @notice No input causes an arithmetic panic (overflow, underflow, division by zero)
    function invariant_noArithmeticPanic() public view {
        assertEq(handler.panic(), "", "arithmetic panic");
    }

    /// @notice A pair's `roundStableUnits` and `roundPrincipal` are the sums over the active plans in its next round
    function invariant_dueMatchesPlans() public view {
        _checkDue(pairId);
        _checkDue(ethPairId);
    }

    /// @notice The stable units SmartDCA tracks are exactly what active plans have not spent. A started round
    ///         already redeemed its `roundStableUnits`, so those are no longer in the pool.
    function invariant_stableUnitsMatchPlans() public view {
        uint256 unspent;
        for (uint256 i; i < handler.planCount(); ++i) {
            ISmartDCA.Plan memory p = _plan(handler.planId(i));
            if (p.status != ISmartDCA.PlanStatus.Active) continue;
            uint256 done = SmartDCAMath.buysSettled(
                _pairOf(p.pairId).lastSettledRound,
                p.scheduleFirstRound,
                p.scheduleBuys
            );
            unspent += p.scheduleStableUnits - p.stableUnitsPerBuy * done;
        }
        unspent -= _startedDue(pairId) + _startedDue(ethPairId);
        (, , , uint256 btcPairUnits) = dca.yieldSources(pairId, ISmartDCA.Side.Stable);
        (, , , uint256 ethPairUnits) = dca.yieldSources(ethPairId, ISmartDCA.Side.Stable);
        assertEq(btcPairUnits + ethPairUnits, unspent, "stable units");
    }

    /// @notice What plans own of an asset fits in the asset units SmartDCA tracks
    function invariant_plansFitInAssetPool() public view {
        _checkAssetPool(pairId);
        _checkAssetPool(ethPairId);
    }

    /// @notice The source shares counted in storage are the shares SmartDCA holds
    function invariant_sharesMatchBalances() public view {
        // Both pairs keep their USDT in the same Hub, so its balance is the sum of their shares
        (, , uint256 btcPairShares, ) = dca.yieldSources(pairId, ISmartDCA.Side.Stable);
        (, , uint256 ethPairShares, ) = dca.yieldSources(ethPairId, ISmartDCA.Side.Stable);
        assertEq(hub.balanceOf(address(dca)), btcPairShares + ethPairShares, "hub shares");
        _checkShares(pairId, address(vBTC));
        _checkShares(ethPairId, address(vETH));
    }

    /// @notice Between `startRound` and `settle` the round's stable and asset sit in SmartDCA as plain tokens.
    ///         Outside a round it holds none.
    function invariant_roundCashIsHeld() public view {
        ISmartDCA.Round memory btc = _openRound(pairId);
        ISmartDCA.Round memory e = _openRound(ethPairId);
        assertEq(usdt.balanceOf(address(dca)), btc.stableToSwap + e.stableToSwap, "stable held");
        assertEq(btcb.balanceOf(address(dca)), btc.assetBought, "BTCB held");
        assertEq(eth.balanceOf(address(dca)), e.assetBought, "ETH held");
    }

    /// @notice Every plan is in exactly one owner list, the list of its current owner
    function invariant_planIdsMatchOwners() public view {
        address[4] memory owners = [alice, bob, carol, dave];
        uint256 listed;
        for (uint256 u; u < 4; ++u) {
            uint256[] memory list = dca.getPlanIds(owners[u]);
            listed += list.length;
            for (uint256 i; i < list.length; ++i) assertEq(_plan(list[i]).owner, owners[u], "listed under its owner");
        }
        assertEq(listed, handler.planCount(), "each plan listed once");
    }

    /// @notice A settled round stays settled, and the buy indexes never go down
    function invariant_roundsOnlyMoveForward() public {
        _checkForward(pairId);
        _checkForward(ethPairId);
    }

    /// @notice Logs how often each path was reached. Shown with `-vv`
    function afterInvariant() public view {
        console.log("plans", handler.creates(), "top ups", handler.topUps());
        console.log("withdraws", handler.withdraws(), "cancels", handler.cancels());
        console.log("claims", handler.claims(), "buys started", handler.buysStarted());
        console.log("orders", handler.orders(), "resplits", handler.resplits());
        console.log("settles", handler.settles(), "transfers", handler.transfers());
        console.log("force buys", handler.forceBuys());
    }

    // ----- checks -----

    function _checkDue(uint32 pid) internal view {
        ISmartDCA.Pair memory pair = _pairOf(pid);
        uint32 open = pair.lastSettledRound + 1;
        uint256 stableUnitsSum;
        uint256 principalSum;
        for (uint256 i; i < handler.planCount(); ++i) {
            ISmartDCA.Plan memory p = _plan(handler.planId(i));
            if (p.pairId != pid || p.status != ISmartDCA.PlanStatus.Active) continue;
            if (p.scheduleFirstRound <= open && open < p.scheduleFirstRound + p.scheduleBuys) {
                stableUnitsSum += p.stableUnitsPerBuy;
                principalSum += p.principalPerBuy;
            }
        }
        assertEq(pair.roundStableUnits, stableUnitsSum, "roundStableUnits");
        assertEq(pair.roundPrincipal, principalSum, "roundPrincipal");
    }

    function _checkAssetPool(uint32 pid) internal view {
        uint256 owned;
        for (uint256 i; i < handler.planCount(); ++i) {
            uint256 id = handler.planId(i);
            if (_plan(id).pairId == pid) owned += lens.getPlan(dca, id).assetUnits;
        }
        (, , , uint256 units) = dca.yieldSources(pid, ISmartDCA.Side.Asset);
        assertLe(owned, units, "plans own more than the pool");
    }

    function _checkShares(uint32 pid, address source) internal view {
        (, , uint256 shares, ) = dca.yieldSources(pid, ISmartDCA.Side.Asset);
        assertEq(MockERC20(source).balanceOf(address(dca)), shares, "shares");
    }

    function _checkForward(uint32 pid) internal {
        ISmartDCA.Pair memory pair = _pairOf(pid);
        assertGe(pair.lastSettledRound, lastSettled[pid], "settled round went back");
        assertGe(pair.assetPerUnitIndex, lastAssetPerUnitIndex[pid], "assetPerUnitIndex went down");
        assertGe(pair.assetPerPrincipalIndex, lastCumBaseIndex[pid], "cumBaseIndex went down");
        lastSettled[pid] = pair.lastSettledRound;
        lastAssetPerUnitIndex[pid] = pair.assetPerUnitIndex;
        lastCumBaseIndex[pid] = pair.assetPerPrincipalIndex;
    }

    // ----- reads -----

    /// @dev `roundStableUnits` of the pair when its next round is started, else 0
    function _startedDue(uint32 pid) internal view returns (uint256) {
        return _openRound(pid).partsTotal == 0 ? 0 : _pairOf(pid).roundStableUnits;
    }

    function _openRound(uint32 pid) internal view returns (ISmartDCA.Round memory r) {
        uint32 round = _pairOf(pid).lastSettledRound + 1;
        (r.partsTotal, r.partsDone, , , , , r.stableToSwap, r.assetBought, , , , , , ) = dca.rounds(pid, round);
    }

    function _pairOf(uint32 pid) internal view returns (ISmartDCA.Pair memory p) {
        (
            p.stable,
            p.nextLockTime,
            p.asset,
            p.enabled,
            p.lastSettledRound,
            p.lockEmittedRound,
            p.roundStableUnits,
            p.roundPrincipal,
            p.assetPerUnitIndex,
            p.assetPerPrincipalIndex
        ) = dca.pairs(pid);
    }
}
