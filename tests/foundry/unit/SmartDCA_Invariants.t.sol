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
import { MockHub, MockSwapHelper, MockVToken } from "./mocks/SmartDCAMocks.sol";
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
    address internal immutable BACKUP;
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
        address backup_,
        address[4] memory users_
    ) {
        DCA = dca_;
        USDT = usdt_;
        HUB = hub_;
        vTokens = vTokens_;
        pairIds = pairIds_;
        KEEPER = keeper_;
        BACKUP = backup_;
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
            abi.encodeCall(DCA.createPlan, (pairIds[pairSeed % 2], amount, uint8(bound(buys, 2, 6))))
        );
        if (!ok) return;
        ids.push(abi.decode(ret, (uint256)));
        ++creates;
    }

    function topUp(uint256 planSeed, uint256 amount) external {
        if (ids.length == 0) return;
        uint256 id = ids[planSeed % ids.length];
        address owner = _owner(id);
        amount = bound(amount, 1, 1e22);
        _fund(owner, amount);
        (bool ok, ) = _call(owner, abi.encodeCall(DCA.topUp, (id, amount)));
        if (ok) ++topUps;
    }

    function withdrawBought(uint256 planSeed, uint256 amount, bool all) external {
        if (ids.length == 0) return;
        uint256 id = ids[planSeed % ids.length];
        amount = all ? type(uint256).max : bound(amount, 1, 1e12);
        (bool ok, ) = _call(_owner(id), abi.encodeCall(DCA.withdrawBought, (id, amount)));
        if (ok) ++withdraws;
    }

    function cancel(uint256 planSeed) external {
        if (ids.length == 0) return;
        uint256 id = ids[planSeed % ids.length];
        (bool ok, ) = _call(_owner(id), abi.encodeCall(DCA.cancel, (id)));
        if (ok) ++cancels;
    }

    function claim(uint256 planSeed, bool toCore) external {
        if (ids.length == 0) return;
        uint256 id = ids[planSeed % ids.length];
        (bool ok, ) = _call(_owner(id), abi.encodeCall(DCA.claim, (id, toCore)));
        if (ok) ++claims;
    }

    // ----- keeper -----

    /// @notice Up to `steps` steps of the pair's next round: start it, swap one part each, settle it. Moves time
    ///         to the caller's start time first, else most calls land before the lock and revert. Several steps
    ///         per call so enough rounds settle for plans to mature; one step leaves a round half done for the
    ///         other actions.
    function roundStep(uint256 pairSeed, uint256 parts, uint256 steps, bool byBackup) external {
        uint32 pid = pairIds[pairSeed % 2];
        address caller = byBackup ? BACKUP : KEEPER;
        uint256 start = DCA.lockTime(pid) + (byBackup ? DCA.backupDelay() : 0);
        if (time < start) {
            time = start;
            vm.warp(time);
        }
        steps = bound(steps, 1, 5);
        for (uint256 i; i < steps; ++i) {
            ISmartDCA.Round memory r = _round(pid);
            bool ok;
            if (r.partsTotal == 0) {
                (ok, ) = _call(caller, abi.encodeCall(DCA.startBuy, (pid, uint8(bound(parts, 1, 3)))));
                // An empty round settles inside `startBuy` and starts nothing
                if (!ok || _round(pid).partsTotal == 0) return;
                ++buysStarted;
            } else if (r.partsDone < r.partsTotal) {
                (ok, ) = _call(caller, abi.encodeCall(DCA.executeOrder, (pid, 1, _swapData(pid))));
                if (!ok) return;
                ++orders;
            } else {
                (ok, ) = _call(caller, abi.encodeCall(DCA.settle, (pid)));
                if (ok) ++settles;
                // The next round's lock is a month away
                return;
            }
        }
    }

    function resplit(uint256 pairSeed, uint256 parts) external {
        (bool ok, ) = _call(KEEPER, abi.encodeCall(DCA.resplit, (pairIds[pairSeed % 2], uint8(bound(parts, 1, 3)))));
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
        (, , , uint32 lastSettledRound, , , , , ) = DCA.pairs(pid);
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

    // Ghosts: values at the previous invariant check, for the only-forward rule
    mapping(uint32 => uint32) internal lastSettled;
    mapping(uint32 => uint256) internal lastCumIndex;
    mapping(uint32 => uint256) internal lastCumBaseIndex;

    function setUp() public override {
        super.setUp();
        lens = new SmartDCALens();
        eth = new MockERC20("ETH", "ETH", 18);
        vETH = new MockVToken(address(eth), 3e26);
        comptroller.list(address(vETH));
        // Same price as BTCB, so the one mock swapHelper rate fills both pairs
        oracle.setPrice(address(eth), BTC_PRICE);
        dca.setYieldSource(address(eth), ISmartDCA.SourceKind.Core, address(vETH));
        ethPairId = dca.addPair(address(usdt), address(eth));
        dca.setMinPerBuy(address(usdt), 1e6);

        handler = new SmartDCAHandler(
            dca,
            usdt,
            hub,
            [vBTC, vETH],
            [pairId, ethPairId],
            keeper,
            backup,
            [alice, bob, carol, makeAddr("dave")]
        );
        // For `setFeeRate`
        acm.setAllowAll(address(handler), true);
        targetContract(address(handler));

        bytes4[] memory actions = new bytes4[](10);
        actions[0] = SmartDCAHandler.createPlan.selector;
        actions[1] = SmartDCAHandler.topUp.selector;
        actions[2] = SmartDCAHandler.withdrawBought.selector;
        actions[3] = SmartDCAHandler.cancel.selector;
        actions[4] = SmartDCAHandler.claim.selector;
        actions[5] = SmartDCAHandler.roundStep.selector;
        actions[6] = SmartDCAHandler.resplit.selector;
        actions[7] = SmartDCAHandler.moveRates.selector;
        actions[8] = SmartDCAHandler.setFeeRate.selector;
        actions[9] = SmartDCAHandler.passTime.selector;
        // Without this the fuzzer also spends calls on the handler's getters.
        targetSelector(FuzzSelector({ addr: address(handler), selectors: actions }));
    }

    /// @notice No input causes an arithmetic panic (overflow, underflow, division by zero)
    function invariant_noArithmeticPanic() public view {
        assertEq(handler.panic(), "", "arithmetic panic");
    }

    /// @notice A pair's `dueUnits` and `dueBase` are the sums over the active plans in its next round
    function invariant_dueMatchesPlans() public view {
        _checkDue(pairId);
        _checkDue(ethPairId);
    }

    /// @notice The stable units SmartDCA tracks are exactly what active plans have not spent. A started round
    ///         already redeemed its `dueUnits`, so those are no longer in the pool.
    function invariant_stableUnitsMatchPlans() public view {
        uint256 unspent;
        for (uint256 i; i < handler.planCount(); ++i) {
            ISmartDCA.Plan memory p = _plan(handler.planId(i));
            if (p.status != ISmartDCA.PlanStatus.Active) continue;
            uint256 done = SmartDCAMath.roundsDone(_pairOf(p.pairId).lastSettledRound, p.firstRound, p.buys);
            unspent += p.stableUnits - p.slice * done;
        }
        unspent -= _startedDue(pairId) + _startedDue(ethPairId);
        (, , , uint256 units) = dca.sources(address(usdt));
        assertEq(units, unspent, "stable units");
    }

    /// @notice What plans own of an asset fits in the asset units SmartDCA tracks
    function invariant_plansFitInAssetPool() public view {
        _checkAssetPool(pairId, address(btcb));
        _checkAssetPool(ethPairId, address(eth));
    }

    /// @notice The source shares counted in storage are the shares SmartDCA holds
    function invariant_sharesMatchBalances() public view {
        _checkShares(address(usdt), address(hub));
        _checkShares(address(btcb), address(vBTC));
        _checkShares(address(eth), address(vETH));
    }

    /// @notice Between `startBuy` and `settle` the round's stable and asset sit in SmartDCA as plain tokens.
    ///         Outside a round it holds none.
    function invariant_roundCashIsHeld() public view {
        ISmartDCA.Round memory btc = _openRound(pairId);
        ISmartDCA.Round memory e = _openRound(ethPairId);
        assertEq(usdt.balanceOf(address(dca)), btc.toSwap + e.toSwap, "stable held");
        assertEq(btcb.balanceOf(address(dca)), btc.amountOut, "BTCB held");
        assertEq(eth.balanceOf(address(dca)), e.amountOut, "ETH held");
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
        console.log("settles", handler.settles());
    }

    // ----- checks -----

    function _checkDue(uint32 pid) internal view {
        ISmartDCA.Pair memory pair = _pairOf(pid);
        uint32 open = pair.lastSettledRound + 1;
        uint256 slices;
        uint256 bases;
        for (uint256 i; i < handler.planCount(); ++i) {
            ISmartDCA.Plan memory p = _plan(handler.planId(i));
            if (p.pairId != pid || p.status != ISmartDCA.PlanStatus.Active) continue;
            if (p.firstRound <= open && open < p.firstRound + p.buys) {
                slices += p.slice;
                bases += p.base;
            }
        }
        assertEq(pair.dueUnits, slices, "dueUnits");
        assertEq(pair.dueBase, bases, "dueBase");
    }

    function _checkAssetPool(uint32 pid, address asset) internal view {
        uint256 owned;
        for (uint256 i; i < handler.planCount(); ++i) {
            uint256 id = handler.planId(i);
            if (_plan(id).pairId == pid) owned += lens.getPlan(dca, id).boughtUnits;
        }
        (, , , uint256 units) = dca.sources(asset);
        assertLe(owned, units, "plans own more than the pool");
    }

    function _checkShares(address token, address source) internal view {
        (, , uint256 shares, ) = dca.sources(token);
        assertEq(MockERC20(source).balanceOf(address(dca)), shares, "shares");
    }

    function _checkForward(uint32 pid) internal {
        ISmartDCA.Pair memory pair = _pairOf(pid);
        assertGe(pair.lastSettledRound, lastSettled[pid], "settled round went back");
        assertGe(pair.cumIndex, lastCumIndex[pid], "cumIndex went down");
        assertGe(pair.cumBaseIndex, lastCumBaseIndex[pid], "cumBaseIndex went down");
        lastSettled[pid] = pair.lastSettledRound;
        lastCumIndex[pid] = pair.cumIndex;
        lastCumBaseIndex[pid] = pair.cumBaseIndex;
    }

    // ----- reads -----

    /// @dev `dueUnits` of the pair when its next round is started, else 0
    function _startedDue(uint32 pid) internal view returns (uint256) {
        return _openRound(pid).partsTotal == 0 ? 0 : _pairOf(pid).dueUnits;
    }

    function _openRound(uint32 pid) internal view returns (ISmartDCA.Round memory r) {
        uint32 round = _pairOf(pid).lastSettledRound + 1;
        (r.partsTotal, r.partsDone, , , , , r.toSwap, r.amountOut, , , , , , ) = dca.rounds(pid, round);
    }

    function _pairOf(uint32 pid) internal view returns (ISmartDCA.Pair memory p) {
        (
            p.stable,
            p.asset,
            p.enabled,
            p.lastSettledRound,
            p.lockEnteredRound,
            p.dueUnits,
            p.dueBase,
            p.cumIndex,
            p.cumBaseIndex
        ) = dca.pairs(pid);
    }
}
