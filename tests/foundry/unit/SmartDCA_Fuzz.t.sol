// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

// solhint-disable func-name-mixedcase, ordering, import-path-check

import { ISmartDCA } from "../../../contracts/SmartDCA/ISmartDCA.sol";
import { SmartDCALens } from "../../../contracts/SmartDCA/SmartDCALens.sol";
import { SmartDCAMath } from "../../../contracts/SmartDCA/SmartDCAMath.sol";
import { MockERC20 } from "./mocks/MockERC20.sol";
import { MockHub, MockPancakeV3Router, MockVToken } from "./mocks/SmartDCAMocks.sol";
import { SmartDCABase } from "./SmartDCABase.t.sol";

/// @notice Random walks over two pairs that share USDT: plans of any size come and go, rounds run late or on
///         time, and the Hub and vToken rates move both ways. After every step the pooled totals must match the
///         plans, and what plans own must fit in what the contract holds. At the end every plan exits.
contract SmartDCA_FuzzTest is SmartDCABase {
    uint256 internal constant STEPS = 60;
    bytes4 internal constant PANIC = 0x4e487b71;

    SmartDCALens internal lens;
    MockERC20 internal eth;
    MockVToken internal vETH;
    uint32 internal ethPairId;
    uint256[] internal ids;
    address[4] internal users;
    uint256 internal seed;
    uint256 internal panics;
    /// @dev Tracked here: under via-ir a `block.timestamp` read after `vm.warp` can return the old value
    uint256 internal time;

    function setUp() public override {
        super.setUp();
        lens = new SmartDCALens();
        eth = new MockERC20("ETH", "ETH", 18);
        vETH = new MockVToken(address(eth), 3e26);
        comptroller.list(address(vETH));
        // Same price as BTCB, so the one mock swapHelper rate fills both pairs
        oracle.setPrice(address(eth), BTC_PRICE);
        ethPairId = _addPair(address(usdt), address(eth), address(hub), address(vETH));
        // Dust-sized plans too
        dca.setMinAmountPerBuy(address(usdt), 1e6);
        users = [alice, bob, carol, makeAddr("dave")];
    }

    /// @notice However many plans Alice holds, a transfer moves exactly that one id from her list to Bob's
    function testFuzz_transferPlan_movesOneId(uint8 count, uint256 pick) public {
        count = uint8(bound(count, 1, 8));
        for (uint256 i; i < count; ++i) _create(alice, 120e18, 12);
        uint256 id = dca.getPlanIds(alice)[pick % count];
        vm.prank(alice);
        dca.transferPlan(id, bob);

        uint256[] memory left = dca.getPlanIds(alice);
        assertEq(left.length, count - 1);
        for (uint256 i; i < left.length; ++i) assertTrue(left[i] != id, "id left Alice's list");
        assertEq(dca.getPlanIds(bob).length, 1);
        assertEq(dca.getPlanIds(bob)[0], id);
    }

    /// @notice For any split and round size, forceBuy settles on its last part and not before, and sells the
    ///         whole round at the route's price
    function testFuzz_forceBuy_settlesOnTheLastPart(uint8 parts, uint256 amount) public {
        parts = uint8(bound(parts, 1, 10));
        amount = bound(amount, 120e18, 1e24);
        MockPancakeV3Router router = new MockPancakeV3Router();
        router.setRate(1e18 / 100_000);
        dca.setFallbackRoute(pairId, address(router), abi.encodePacked(address(usdt), uint24(500), address(btcb)));
        _create(alice, amount, 12);
        vm.warp(dca.nextLockTime(pairId) + dca.FALLBACK_DELAY());
        uint32 round = _pair().lastSettledRound + 1;

        for (uint256 i = 1; i < parts; ++i) {
            dca.forceBuy(pairId, parts);
            assertEq(_pair().lastSettledRound, round - 1, "not settled before the last part");
        }
        dca.forceBuy(pairId, parts);
        assertEq(_pair().lastSettledRound, round, "settled on the last part");
        ISmartDCA.Round memory r = _round(round);
        assertEq(r.stableToSwap, 0, "whole round sold");
        assertApproxEqAbs(r.assetBought, r.stableNet / 100_000, parts, "at the route's price");
    }

    function testFuzz_poolMatchesPlansAndEveryoneExits(uint256 seed_) public {
        seed = seed_;
        time = block.timestamp;
        for (uint256 k; k < STEPS; ++k) {
            _randomStep();
            _checkPair(pairId);
            _checkPair(ethPairId);
        }
        _drain();
        assertEq(panics, 0, "arithmetic panic");
    }

    // ----- steps -----

    function _randomStep() internal {
        uint256 action = _rnd(10);
        uint32 pid = _rnd(2) == 0 ? pairId : ethPairId;
        if (action <= 1) _createRandom(pid);
        else if (action <= 5 && ids.length != 0) _planAction(action, ids[_rnd(ids.length)]);
        else if (action <= 7) _roundStep(pid);
        else if (action == 8) _moveRates();
        else _warp(_rnd(20 days));
    }

    function _createRandom(uint32 pid) internal {
        address user = users[_rnd(4)];
        uint256 amount = _rnd(3) == 0 ? 2e6 + _rnd(1e8) : 20e18 + _rnd(1e24);
        usdt.mint(user, amount);
        vm.prank(user);
        usdt.approve(address(dca), amount);
        vm.prank(user);
        (bool ok, bytes memory ret) = address(dca).call(
            abi.encodeCall(dca.createPlan, (pid, amount, uint8(2 + _rnd(11)), user))
        );
        if (ok) ids.push(abi.decode(ret, (uint256)));
        else _countPanic(ret);
    }

    function _planAction(uint256 action, uint256 id) internal {
        address owner = _plan(id).owner;
        if (action == 2) {
            uint256 amount = 1 + _rnd(1e22);
            usdt.mint(owner, amount);
            vm.prank(owner);
            usdt.approve(address(dca), amount);
            _call(owner, abi.encodeCall(dca.topUpPlan, (id, amount)));
        } else if (action == 3) {
            _call(owner, abi.encodeCall(dca.cancelPlan, (id, owner)));
        } else if (action == 4) {
            uint256 amount = _rnd(2) == 0 ? type(uint256).max : 1 + _rnd(1e12);
            _call(owner, abi.encodeCall(dca.withdrawBought, (id, amount, owner)));
        } else {
            _call(owner, abi.encodeCall(dca.claimPlan, (id, _rnd(2) == 0, owner)));
        }
    }

    /// @dev One keeper step of the pair's next round: start, swap a part, or settle
    function _roundStep(uint32 pid) internal {
        uint32 round = _pairOf(pid).lastSettledRound + 1;
        (uint8 total, uint8 done, , , , , , , , , , , , ) = dca.rounds(pid, round);
        if (total == 0) _call(keeper, abi.encodeCall(dca.startRound, (pid, uint8(1 + _rnd(3)))));
        else if (done < total) _call(keeper, abi.encodeCall(dca.swapRoundPart, (pid, ANY_QUOTE, _swapData(pid))));
        else _call(keeper, abi.encodeCall(dca.settleRound, (pid)));
    }

    function _moveRates() internal {
        hub.setPricePerShare((hub.pricePerShare() * (9_980 + _rnd(50))) / 10_000);
        vBTC.setExchangeRate((vBTC.exchangeRate() * (9_980 + _rnd(50))) / 10_000);
    }

    /// @dev Runs every round until all plans matured, then claims each one
    function _drain() internal {
        for (uint256 k; k < 400 && _anyLive(); ++k) {
            _warp(3 days);
            for (uint256 i; i < 3; ++i) {
                _roundStep(pairId);
                _roundStep(ethPairId);
            }
        }
        for (uint256 i; i < ids.length; ++i) {
            ISmartDCA.Plan memory p = _plan(ids[i]);
            if (p.status == ISmartDCA.PlanStatus.Active) {
                assertTrue(_call(p.owner, abi.encodeCall(dca.claimPlan, (ids[i], false, p.owner))), "claim failed");
            }
        }
        (, , , uint256 btcPairUsdtUnits) = dca.yieldSources(pairId, ISmartDCA.Side.Stable);
        (, , , uint256 ethPairUsdtUnits) = dca.yieldSources(ethPairId, ISmartDCA.Side.Stable);
        assertEq(btcPairUsdtUnits + ethPairUsdtUnits, 0, "stable units left after every exit");
        _checkHoldings(pairId, address(vBTC));
        _checkHoldings(ethPairId, address(vETH));
    }

    // ----- invariants -----

    /// @dev `roundStableUnits` and `roundPrincipal` are the sums over the plans in the pair's next round, and what the pair's
    ///      plans own of the asset fits in the asset's units
    function _checkPair(uint32 pid) internal view {
        ISmartDCA.Pair memory pair = _pairOf(pid);
        uint32 open = pair.lastSettledRound + 1;
        uint256 stableUnitsSum;
        uint256 principalSum;
        for (uint256 i; i < ids.length; ++i) {
            ISmartDCA.Plan memory p = _plan(ids[i]);
            if (p.pairId != pid || p.status != ISmartDCA.PlanStatus.Active) continue;
            if (p.scheduleFirstRound <= open && open < p.scheduleFirstRound + p.scheduleBuys) {
                stableUnitsSum += p.stableUnitsPerBuy;
                principalSum += p.principalPerBuy;
            }
        }
        assertEq(pair.roundStableUnits, stableUnitsSum, "roundStableUnits");
        assertEq(pair.roundPrincipal, principalSum, "roundPrincipal");
        _checkHoldings(pid, pid == pairId ? address(vBTC) : address(vETH));
    }

    /// @dev The source balance covers the tracked shares, and the plans' bought units fit in the tracked units
    function _checkHoldings(uint32 pid, address vToken) internal view {
        (, , uint256 shares, uint256 units) = dca.yieldSources(pid, ISmartDCA.Side.Asset);
        assertEq(MockVToken(vToken).balanceOf(address(dca)), shares, "shares");
        uint256 owned;
        for (uint256 i; i < ids.length; ++i) {
            if (_plan(ids[i]).pairId == pid) owned += lens.getPlan(dca, ids[i]).assetUnits;
        }
        assertLe(owned, units, "plans own more than the pool");
    }

    // ----- helpers -----

    function _warp(uint256 delta) internal {
        time += delta;
        vm.warp(time);
    }

    function _anyLive() internal view returns (bool) {
        for (uint256 i; i < ids.length; ++i) {
            ISmartDCA.Plan memory p = _plan(ids[i]);
            if (
                p.status == ISmartDCA.PlanStatus.Active &&
                _pairOf(p.pairId).lastSettledRound < p.scheduleFirstRound + p.scheduleBuys - 1
            ) {
                return true;
            }
        }
        return false;
    }

    function _call(address caller, bytes memory data) internal returns (bool ok) {
        bytes memory ret;
        vm.prank(caller);
        (ok, ret) = address(dca).call(data);
        if (!ok) _countPanic(ret);
    }

    /// @dev Reverts are expected (locked plans, small top ups); arithmetic panics are not
    function _countPanic(bytes memory ret) internal {
        if (ret.length >= 4 && bytes4(ret) == PANIC) ++panics;
    }

    function _rnd(uint256 m) internal returns (uint256) {
        seed = uint256(keccak256(abi.encode(seed)));
        return seed % m;
    }

    function _pairOf(uint32 pid) internal view returns (ISmartDCA.Pair memory p) {
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
        ) = dca.pairs(pid);
    }

    // ----- the walk with every action -----

    MockHub internal hub2;
    /// @dev Successful governance calls by selector
    mapping(bytes4 => uint256) internal govOk;

    function _routesAndSecondHub() internal {
        hub2 = new MockHub(address(usdt));
        registry.set(address(hub2), true);
        MockPancakeV3Router router = new MockPancakeV3Router();
        router.setRate(1e18 / 100_000);
        dca.setFallbackRoute(pairId, address(router), abi.encodePacked(address(usdt), uint24(500), address(btcb)));
        dca.setFallbackRoute(ethPairId, address(router), abi.encodePacked(address(usdt), uint24(500), address(eth)));
        dca.setMaxSlippage(100);
    }

    /// @notice The random walk with `forceBuy`, resplit, transfer, pause, stable moves between two Hubs, sweeps of
    ///         every token, and jumps long enough to overrun. After every step the pair checks hold, both Hubs hold
    ///         exactly the shares the pairs track, and the plans' pending stable in a started round adds up to the
    ///         round's net. At the end every plan still exits.
    function testFuzz_walkWithEveryAction(uint256 seed_) public {
        _routesAndSecondHub();
        seed = seed_;
        time = block.timestamp;
        address sweepTo = makeAddr("sweepTo");
        for (uint256 k; k < 80; ++k) {
            uint256 pick = _rnd(14);
            uint32 pid = _rnd(2) == 0 ? pairId : ethPairId;
            if (pick < 8) _randomStep();
            else if (pick == 8) _govCall(abi.encodeCall(dca.forceBuy, (pid, uint8(1 + _rnd(3)))));
            else if (pick == 9) _call(keeper, abi.encodeCall(dca.resplitRound, (pid, uint8(1 + _rnd(4)))));
            else if (pick == 10 && ids.length != 0) {
                uint256 id = ids[_rnd(ids.length)];
                _call(_plan(id).owner, abi.encodeCall(dca.transferPlan, (id, users[_rnd(4)])));
            } else if (pick == 11) {
                (, address current, , ) = dca.yieldSources(pairId, ISmartDCA.Side.Stable);
                address next = current == address(hub) ? address(hub2) : address(hub);
                _govCall(
                    abi.encodeCall(dca.setYieldSource, (pairId, ISmartDCA.Side.Stable, ISmartDCA.SourceKind.Hub, next))
                );
            } else if (pick == 12) {
                address[5] memory tokens = [address(usdt), address(btcb), address(hub), address(hub2), address(vBTC)];
                _govCall(abi.encodeCall(dca.sweepToken, (tokens[_rnd(5)], sweepTo)));
            } else {
                dca.pause();
                _randomStep();
                dca.unpause();
                _warp(20 days + _rnd(50 days));
            }
            _checkPair(pairId);
            _checkPair(ethPairId);
            _checkPending(pairId);
            _checkPending(ethPairId);
            _checkStableShares();
        }
        _drain();
        assertEq(panics, 0, "arithmetic panic");
    }

    /// @notice One fixed seed reaches `forceBuy` and a source move, so the walk above is known to exercise them
    function test_walkWithEveryAction_reachesForceBuyAndSourceMoves() public {
        testFuzz_walkWithEveryAction(42);
        assertGt(govOk[dca.forceBuy.selector], 0, "forceBuy never ran");
        assertGt(govOk[dca.setYieldSource.selector], 0, "no source move ran");
    }

    function _govCall(bytes memory data) internal {
        (bool ok, bytes memory ret) = address(dca).call(data);
        if (ok) ++govOk[bytes4(data)];
        else _countPanic(ret);
    }

    /// @dev In a started round, the plans' pending stable adds up to the round's net, less each plan's rounding
    function _checkPending(uint32 pid) internal view {
        uint32 round = _pairOf(pid).lastSettledRound + 1;
        (uint8 total, , , , , uint256 net, , , , , , , , ) = dca.rounds(pid, round);
        if (total == 0) return;
        uint256 sum;
        uint256 n;
        for (uint256 i; i < ids.length; ++i) {
            ISmartDCA.Plan memory p = _plan(ids[i]);
            if (p.pairId != pid || p.status != ISmartDCA.PlanStatus.Active) continue;
            if (!SmartDCAMath.inRunningRound(round, p.scheduleFirstRound, p.scheduleBuys, true)) continue;
            sum += lens.getPlan(dca, ids[i]).stablePending;
            ++n;
        }
        assertLe(sum, net, "pending above the round's net");
        assertGe(sum + 2 * n + 2, net, "pending below the round's net");
    }

    /// @dev Both USDT Hubs hold exactly the shares the two pairs track
    function _checkStableShares() internal view {
        uint256 inHub;
        uint256 inHub2;
        uint32[2] memory pids = [pairId, ethPairId];
        for (uint256 i; i < 2; ++i) {
            (, address src, uint256 shares, ) = dca.yieldSources(pids[i], ISmartDCA.Side.Stable);
            if (src == address(hub)) inHub += shares;
            else inHub2 += shares;
        }
        assertEq(hub.balanceOf(address(dca)), inHub, "hub shares");
        assertEq(hub2.balanceOf(address(dca)), inHub2, "hub2 shares");
    }
}
