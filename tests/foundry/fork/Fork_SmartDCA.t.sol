// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

// solhint-disable func-name-mixedcase, ordering, import-path-check

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import { SmartDCA } from "../../../contracts/SmartDCA/SmartDCA.sol";
import { ISmartDCA } from "../../../contracts/SmartDCA/ISmartDCA.sol";
import { SmartDCAMath } from "../../../contracts/SmartDCA/SmartDCAMath.sol";
import { IVToken } from "../../../contracts/Interfaces/IVToken.sol";
import { SwapHelper } from "../../../contracts/SwapHelper/SwapHelper.sol";

interface IHubCap {
    function maxWithdrawalSize() external view returns (uint256);
}

interface IComptrollerAdmin {
    function _setVenusSpeeds(
        address[] calldata vTokens,
        uint256[] calldata supplySpeeds,
        uint256[] calldata borrowSpeeds
    ) external;
}

/// @dev PancakeSwap V3 SwapRouter, the DEX the signed multicall calls in these tests
interface IPancakeV3Router {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

/// @dev PancakeSwap V3 QuoterV2: simulates `exactInput` and returns what it would pay, fees already taken
interface IPancakeQuoterV2 {
    function quoteExactInput(
        bytes memory path,
        uint256 amountIn
    ) external returns (uint256 amountOut, uint160[] memory, uint32[] memory, uint256);
}

interface IOraclePrice {
    function getPrice(address asset) external view returns (uint256);
}

interface IAccessControlManagerLike {
    function giveCallPermission(address contractAddress, string calldata functionSig, address accountToPermit) external;
}

/**
 * @title Fork_SmartDCA
 * @notice SmartDCA against the live BNB Chain deployment: USDT, USDC and U parked in their real Hubs, BTCB, ETH and
 *         WBNB in the real Core markets, swaps through the real SwapHelper into the real PancakeSwap V3 pools, Hubs
 *         checked by the real HubRegistry, permissions from the real ACM.
 *         The test plays the keeper and the swap backend: each part is quoted on the live pools with PancakeSwap's
 *         QuoterV2, and its multicall (approve, PancakeSwap V3 `exactInput`, sweep back) is signed with a test key
 *         that SwapHelper's owner sets as the backend signer, the way
 *         tests/hardhat/Fork/LeverageStrategiesManager.ts builds it.
 * @dev Every round runs on the launch 0.1% slippage against the part's fresh quote.
 */
contract Fork_SmartDCATest is Test {
    address internal constant COMPTROLLER = 0xfD36E2c2a6789Db23113685031d7F16329158384;
    address internal constant COMPTROLLER_ADMIN = 0x939bD8d64c0A9583A7Dcea9933f7b21697ab6396;
    address internal constant ACM = 0x4788629ABc6cFCA10F9f969efdEAa1cF70c23555;
    address internal constant HUB_REGISTRY = 0x6D93Fd479f2d37445CFBe132412e316a0364acc2;
    address internal constant ORACLE = 0x6592b5DE802159F3E74B2486b091D11a8256ab8A;
    address internal constant SWAP_HELPER = 0xD79be25aEe798Aa34A9Ba1230003d7499be29A24;
    address internal constant PCS_V3_ROUTER = 0x1b81D678ffb9C0263b24A97847620C99d213eB14;
    address internal constant PCS_V3_QUOTER = 0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997;
    /// @dev Test key that SwapHelper's owner sets as the backend signer
    uint256 internal constant SIGNER_KEY = 0xA11CE;
    address internal constant XVS = 0xcF6BB5389c92Bdda8a3747Ddb454cB7a64626C63;
    address internal constant USDT = 0x55d398326f99059fF775485246999027B3197955;
    address internal constant BTCB = 0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c;
    address internal constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    address internal constant USDC = 0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d;
    address internal constant U = 0xcE24439F2D9C6a2289F741120FE202248B666666;
    address internal constant ETH = 0x2170Ed0880ac9A755fd29B2688956BD959F933F8;
    address internal constant HUB_USDT = 0x18AfDACF30F8671021dec4b78297E39d2FE87226;
    address internal constant HUB_USDC = 0x9D2D9592cF8DFbf59107fAab703d08494BE14617;
    address internal constant HUB_U = 0x0e5AA174d4F31b757a237eb1999DE151596788B0;
    address internal constant VETH = 0xf508fCD89b8bd15579dc79A6827cB4686A3592c8;
    address internal constant VUSDT = 0xfD5840Cd36d94D7229439859C0112a4185BC0255;
    address internal constant VBTC = 0x882C173bC7Ff3b7786CA16dfeD3DFFfb9Ee7847B;
    address internal constant VWBNB = 0x6bCa74586218dB34cdB402295796b79663d816e9;
    /// @dev PancakeSwap V3 fee tiers of the deepest pools: USDT/BTCB, USDT/WBNB and WBNB/BTCB are all 0.05%
    uint24 internal constant FEE_500 = 500;
    /// @dev 0.01% pools: USDT/WBNB (first hop of the two-hop route), USDT/ETH and U/USDT
    uint24 internal constant FEE_100 = 100;
    /// @dev BNB Chain makes a block every 0.45 s (20,000 blocks took 9,004 s at the fork block)
    uint256 internal constant BLOCKS_PER_20_SECONDS = 44;

    uint256 internal constant FORK_BLOCK = 133_900_000;
    uint256 internal constant DEPOSIT = 10_000e18;

    SmartDCA internal dca;
    uint32 internal pairId;
    bool internal forkLive;
    /// @dev PancakeSwap V3 path the next swap of each pair takes; the backend picks it per part
    mapping(uint32 => bytes) internal routeOf;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal keeper = makeAddr("keeper");
    address internal reserve = makeAddr("reserve");

    function setUp() public {
        string memory rpc = vm.envOr("ARCHIVE_NODE_bscmainnet", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc, FORK_BLOCK);
        forkLive = true;

        SmartDCA impl = new SmartDCA(COMPTROLLER, HUB_REGISTRY, ORACLE, SWAP_HELPER);
        dca = SmartDCA(address(new ERC1967Proxy(address(impl), abi.encodeCall(SmartDCA.initialize, (ACM, reserve)))));
        _grantAdminCalls();
        vm.prank(SwapHelper(SWAP_HELPER).owner());
        SwapHelper(SWAP_HELPER).setBackendSigner(vm.addr(SIGNER_KEY));

        dca.setMinAmountPerBuy(USDT, 10e18);
        pairId = _addPair(USDT, BTCB, HUB_USDT, VBTC);
        routeOf[pairId] = abi.encodePacked(USDT, FEE_500, BTCB);
        dca.setKeeper(keeper, true);
        dca.setAllowedRouter(PCS_V3_ROUTER, true);

        _fund(USDT, alice, DEPOSIT);
    }

    /// @dev The Normal Timelock holds the ACM admin role, so it grants this test the setters it calls
    function _grantAdminCalls() internal {
        string[9] memory sigs = [
            "setYieldSource(uint32,uint8,uint8,address)",
            "setMinAmountPerBuy(address,uint256)",
            "addPair(address,address,uint8,address,uint8,address)",
            "setKeeper(address,bool)",
            "setFeeRate(uint16)",
            "sweepToken(address,address)",
            "setFallbackRoute(uint32,address,bytes)",
            "forceBuy(uint32,uint8)",
            "setAllowedRouter(address,bool)"
        ];
        vm.startPrank(COMPTROLLER_ADMIN);
        for (uint256 i; i < sigs.length; ++i) {
            IAccessControlManagerLike(ACM).giveCallPermission(address(dca), sigs[i], address(this));
        }
        vm.stopPrank();
    }

    /// @dev Adds a pair with its stable in a Hub and its asset in Core, the launch setup
    function _addPair(address stable, address asset, address stableHub, address assetVToken) internal returns (uint32) {
        return dca.addPair(stable, asset, ISmartDCA.SourceKind.Hub, stableHub, ISmartDCA.SourceKind.Core, assetVToken);
    }

    modifier onlyFork() {
        if (!forkLive) vm.skip(true);
        _;
    }

    // ---------------------------------------------------------------- sources

    function test_setYieldSource_checksTheLiveRegistryAndComptroller() public onlyFork {
        // vUSDT holds USDT but is not a registered Hub
        vm.expectRevert(abi.encodeWithSelector(ISmartDCA.InvalidSource.selector, VUSDT));
        dca.setYieldSource(pairId, ISmartDCA.Side.Stable, ISmartDCA.SourceKind.Hub, VUSDT);

        // vBTC is a listed market, but of BTCB
        vm.expectRevert(abi.encodeWithSelector(ISmartDCA.InvalidSource.selector, VBTC));
        dca.setYieldSource(pairId, ISmartDCA.Side.Stable, ISmartDCA.SourceKind.Core, VBTC);

        dca.setYieldSource(pairId, ISmartDCA.Side.Stable, ISmartDCA.SourceKind.Core, VUSDT);
        (ISmartDCA.SourceKind kind, address source, , ) = dca.yieldSources(pairId, ISmartDCA.Side.Stable);
        assertEq(uint8(kind), uint8(ISmartDCA.SourceKind.Core));
        assertEq(source, VUSDT);
    }

    function test_setYieldSource_movesLiveFundsFromHubToCore() public onlyFork {
        uint256 planId = _create(alice, pairId, DEPOSIT, 2);
        (, , , uint256 unitsBefore) = dca.yieldSources(pairId, ISmartDCA.Side.Stable);

        dca.setYieldSource(pairId, ISmartDCA.Side.Stable, ISmartDCA.SourceKind.Core, VUSDT);

        // Every Hub share was redeemed and the USDT minted into vUSDT; units, and so every plan, are unchanged
        (, , uint256 shares, uint256 units) = dca.yieldSources(pairId, ISmartDCA.Side.Stable);
        assertEq(IERC20(HUB_USDT).balanceOf(address(dca)), 0, "no Hub shares left");
        assertEq(IERC20(VUSDT).balanceOf(address(dca)), shares, "vUSDT tracked");
        assertEq(units, unitsBefore, "units unchanged");

        // The plan still exits in full from the new source
        vm.prank(alice);
        dca.cancelPlan(planId, alice);
        assertApproxEqRel(IERC20(USDT).balanceOf(alice), DEPOSIT, 1e12, "deposit back from vUSDT");
    }

    // ---------------------------------------------------------------- forceBuy

    /// @dev Backend down (SwapHelper's signer replaced): the Guardian runs the round in 2 parts on the fixed
    ///      USDT/BTCB 0.05% route, and each part clears the live oracle price less 0.5%
    function test_forceBuy_buysBtcbOnTheFixedRouteWithoutTheBackend() public onlyFork {
        uint256 planId = _create(alice, pairId, DEPOSIT, 2);
        vm.prank(SwapHelper(SWAP_HELPER).owner());
        SwapHelper(SWAP_HELPER).setBackendSigner(makeAddr("backend down"));
        dca.setFallbackRoute(pairId, PCS_V3_ROUTER, routeOf[pairId]);
        uint32 settledBefore = _lastSettled(pairId);
        // Warping to the lock leaves the oracle's feeds stale on a fork, so its prices are kept at the fork block's.
        // Nothing trades in between, so the pool still sits at those prices.
        uint256 usdtPrice = IOraclePrice(ORACLE).getPrice(USDT);
        uint256 btcbPrice = IOraclePrice(ORACLE).getPrice(BTCB);
        _toLock(pairId);
        vm.mockCall(ORACLE, abi.encodeCall(IOraclePrice.getPrice, (USDT)), abi.encode(usdtPrice));
        vm.mockCall(ORACLE, abi.encodeCall(IOraclePrice.getPrice, (BTCB)), abi.encode(btcbPrice));

        dca.forceBuy(pairId, 2);
        assertEq(_lastSettled(pairId), settledBefore, "not settled after part 1");
        dca.forceBuy(pairId, 2);
        assertEq(_lastSettled(pairId), settledBefore + 1, "settled after part 2");

        (, , , , , uint256 stableNet, , uint256 assetBought, , , , , , ) = dca.rounds(pairId, settledBefore + 1);
        uint256 oracleValue = (stableNet * usdtPrice) / btcbPrice;
        assertGe(assetBought, (oracleValue * 9_950) / 10_000, "at least the oracle floor");
        assertEq(IERC20(USDT).allowance(address(dca), PCS_V3_ROUTER), 0, "approved only each part");

        vm.prank(alice);
        dca.withdrawBought(planId, type(uint256).max, alice);
        assertApproxEqRel(IERC20(BTCB).balanceOf(alice), assetBought, 1e12, "BTCB out");
    }

    // ---------------------------------------------------------------- rounds

    function test_round_buysBtcbThroughTheLivePool() public onlyFork {
        uint256 planId = _create(alice, pairId, DEPOSIT, 2);
        _toLock(pairId);
        vm.startPrank(keeper);
        dca.startRound(pairId, 1);
        uint256 quote = _quote(pairId);
        _execute(pairId);
        dca.settleRound(pairId);
        vm.stopPrank();
        (, , , , , uint256 stableNet, , uint256 amountOut, , , , , , ) = dca.rounds(pairId, _lastSettled(pairId));

        // Nothing traded between the quote and the swap, so the pool paid the quote, inside the 0.1% bound
        assertEq(dca.maxSlippageBps(), 10, "launch slippage");
        assertEq(amountOut, quote, "filled at the quote");
        // Half the deposit plus a month of Hub interest, fee rate 0
        assertGe(stableNet, DEPOSIT / 2 - 1, "half the deposit swapped");
        assertApproxEqRel(stableNet, DEPOSIT / 2, 0.01e18, "plus a month of interest");

        // All of it went into vBTC, and the plan can take it out as BTCB
        (, , uint256 shares, ) = dca.yieldSources(pairId, ISmartDCA.Side.Asset);
        assertEq(IERC20(VBTC).balanceOf(address(dca)), shares, "vBTC tracked");
        vm.prank(alice);
        dca.withdrawBought(planId, type(uint256).max, alice);
        assertApproxEqRel(IERC20(BTCB).balanceOf(alice), amountOut, 1e12, "BTCB out");
    }

    function test_round_feeOnARealMonthOfHubYield() public onlyFork {
        dca.setFeeRate(1_000);
        _create(alice, pairId, DEPOSIT, 2);
        (, , , , , , uint256 roundPrincipal, , ) = dca.pairs(pairId);

        _runRound(pairId, 1);

        // The Hub paid interest over the month, and 10% of it went to the Reserve
        (, , , uint16 rate, uint256 stableRedeemed, uint256 stableNet, , , , , , , , ) = dca.rounds(
            pairId,
            _lastSettled(pairId)
        );
        assertGt(stableRedeemed, roundPrincipal, "Hub paid interest");
        assertEq(rate, 1_000, "pooled rate");
        uint256 fee = IERC20(USDT).balanceOf(reserve);
        assertEq(fee, stableRedeemed - stableNet, "fee to Reserve");
        assertEq(fee, ((stableRedeemed - roundPrincipal) * 1_000) / SmartDCAMath.BPS, "10% of the interest");
    }

    /// @dev A trade between the keeper's quote and its swap moves the pool past 0.1%: the part reverts, and a fresh
    ///      quote fills it
    function test_swapRoundPart_revertsWhenThePoolMovesAfterTheQuote() public onlyFork {
        _create(alice, pairId, DEPOSIT, 2);
        _toLock(pairId);
        vm.prank(keeper);
        dca.startRound(pairId, 1);
        uint256 staleQuote = _quote(pairId);
        bytes memory swapData = _swapData(pairId);

        // Someone else buys 500k USDT of BTCB on the same pool first
        address whale = makeAddr("whale");
        deal(USDT, whale, 500_000e18);
        vm.startPrank(whale);
        IERC20(USDT).approve(PCS_V3_ROUTER, type(uint256).max);
        IPancakeV3Router(PCS_V3_ROUTER).exactInput(
            IPancakeV3Router.ExactInputParams(routeOf[pairId], whale, block.timestamp, 500_000e18, 0)
        );
        vm.stopPrank();

        vm.startPrank(keeper);
        vm.expectPartialRevert(ISmartDCA.SlippageExceeded.selector);
        dca.swapRoundPart(pairId, staleQuote, swapData);
        _execute(pairId);
        vm.stopPrank();

        (, uint8 partsDone, , , , , , , , , , , , ) = dca.rounds(pairId, _lastSettled(pairId) + 1);
        assertEq(partsDone, 1, "filled on the fresh quote");
    }

    /// @dev The route is in the swap data, so the backend can change it between parts with no governance call
    function test_swapRoundPart_routeChangesMidRoundToTwoHops() public onlyFork {
        _create(alice, pairId, DEPOSIT, 2);
        _toLock(pairId);

        vm.startPrank(keeper);
        dca.startRound(pairId, 2);
        _execute(pairId);
        vm.stopPrank();

        routeOf[pairId] = abi.encodePacked(USDT, FEE_100, WBNB, FEE_500, BTCB);
        uint256 before = IERC20(BTCB).balanceOf(address(dca));
        vm.startPrank(keeper);
        _execute(pairId);
        assertGt(IERC20(BTCB).balanceOf(address(dca)), before, "second part bought through WBNB");
        dca.settleRound(pairId);
        vm.stopPrank();

        assertEq(
            _lastSettled(pairId),
            uint32(SmartDCAMath.latestStartedMonth(block.timestamp) - dca.anchorMonth()),
            "round settled"
        );
    }

    /// @dev SwapHelper runs only a multicall signed by its backend signer for SmartDCA as the caller
    function test_swapRoundPart_rejectsSwapDataNotSignedByTheBackend() public onlyFork {
        _create(alice, pairId, DEPOSIT, 2);
        _toLock(pairId);

        vm.startPrank(keeper);
        dca.startRound(pairId, 1);
        uint256 quote = _quote(pairId);
        bytes memory swapData = _signedSwapData(pairId, 0xB0B);
        vm.expectRevert(ISmartDCA.SwapFailed.selector);
        dca.swapRoundPart(pairId, quote, swapData);
        vm.stopPrank();

        (, uint8 partsDone, , , , , , , , , , , , ) = dca.rounds(pairId, _lastSettled(pairId) + 1);
        assertEq(partsDone, 0, "nothing swapped");
    }

    function test_hubCap_roundOver10MRevertsAtStartRound() public onlyFork {
        // Each of the two rounds redeems 10.5M USDT from Hub_USDT in one call, over its 10M per-call cap
        uint256 big = 21_000_000e18;
        _fund(USDT, alice, big);
        _create(alice, pairId, big, 2);
        assertEq(IHubCap(HUB_USDT).maxWithdrawalSize(), 10_000_000e18, "cap on chain");
        _toLock(pairId);

        // The Hub's maxRedeem already includes the per-call cap, so its ERC4626 check is what reverts
        vm.expectRevert(bytes("ERC4626: redeem more than max"));
        vm.prank(keeper);
        dca.startRound(pairId, 10);
    }

    // ---------------------------------------------------------------- exits

    function test_fullPlan_claimToCore_sendsVBTC() public onlyFork {
        uint256 planId = _create(alice, pairId, DEPOSIT, 2);
        (, uint256 out1) = _runRound(pairId, 2);
        (, uint256 out2) = _runRound(pairId, 1);

        vm.prank(alice);
        dca.claimPlan(planId, true, alice);

        // Alice now supplies in Core: her vBTC is worth what the two rounds bought, plus the first round's
        // BTCB interest over a month
        uint256 vBal = IERC20(VBTC).balanceOf(alice);
        uint256 underlying = (vBal * IVToken(VBTC).exchangeRateCurrent()) / 1e18;
        assertGe(underlying + 2, out1 + out2, "vBTC worth the bought BTCB");
        assertApproxEqRel(underlying, out1 + out2, 0.001e18, "plus a little interest");
        (, , , uint256 usdtUnits) = dca.yieldSources(pairId, ISmartDCA.Side.Stable);
        assertEq(usdtUnits, 0, "no stable left for the only plan");
    }

    function test_cancelPlan_afterFirstRound_returnsStableAndBought() public onlyFork {
        uint256 planId = _create(alice, pairId, DEPOSIT, 2);
        (, uint256 amountOut) = _runRound(pairId, 2);

        vm.prank(alice);
        dca.cancelPlan(planId, alice);

        // The unswapped half comes back from the real Hub, plus a month of its yield
        assertGe(IERC20(USDT).balanceOf(alice), DEPOSIT / 2 - 1, "stable back");
        assertApproxEqRel(IERC20(USDT).balanceOf(alice), DEPOSIT / 2, 0.01e18, "about half");
        assertApproxEqRel(IERC20(BTCB).balanceOf(alice), amountOut, 1e12, "bought BTCB back");
    }

    function test_withdrawBought_partialAmountAtTheLiveExchangeRate() public onlyFork {
        uint256 planId = _create(alice, pairId, DEPOSIT, 2);
        (, uint256 amountOut) = _runRound(pairId, 2);

        uint256 amount = amountOut / 3;
        vm.prank(alice);
        dca.withdrawBought(planId, amount, alice);
        assertGe(IERC20(BTCB).balanceOf(alice), amount, "at least the amount asked");
        // vBTC has 8 decimals, so rounding the shares up can add up to one share's worth of BTCB
        uint256 oneShare = IVToken(VBTC).exchangeRateStored() / 1e18 + 1;
        assertLe(IERC20(BTCB).balanceOf(alice), amount + oneShare, "and no more than one share");

        vm.prank(alice);
        dca.withdrawBought(planId, type(uint256).max, alice);
        assertApproxEqRel(IERC20(BTCB).balanceOf(alice), amountOut, 1e12, "the rest");
    }

    function test_secondPair_sharesTheUsdtPool() public onlyFork {
        uint32 bnbPair = _addPair(USDT, WBNB, HUB_USDT, VWBNB);
        routeOf[bnbPair] = abi.encodePacked(USDT, FEE_500, WBNB);
        _fund(USDT, bob, DEPOSIT);
        uint256 alicePlan = _create(alice, pairId, DEPOSIT, 2);
        uint256 bobPlan = _create(bob, bnbPair, DEPOSIT, 2);

        (, uint256 btcOut) = _runRound(pairId, 1);
        (, uint256 bnbOut) = _runRound(bnbPair, 1);

        // Each pair redeemed only its own plans' half; both pairs keep their USDT in Hub_USDT
        (, , , uint256 btcPairUnits) = dca.yieldSources(pairId, ISmartDCA.Side.Stable);
        (, , , uint256 bnbPairUnits) = dca.yieldSources(bnbPair, ISmartDCA.Side.Stable);
        uint256 usdtUnits = btcPairUnits + bnbPairUnits;
        (, , , , , uint256 dueBtc, , , ) = dca.pairs(pairId);
        (, , , , , uint256 dueBnb, , , ) = dca.pairs(bnbPair);
        // Plus each plan's per-buy rounding (under `buys` units), left until the plan exits
        assertGe(usdtUnits, dueBtc + dueBnb, "USDT units cover what the two pairs still owe");
        assertLe(usdtUnits, dueBtc + dueBnb + 4, "and only rounding beyond it");

        vm.prank(alice);
        dca.withdrawBought(alicePlan, type(uint256).max, alice);
        vm.prank(bob);
        dca.withdrawBought(bobPlan, type(uint256).max, bob);
        assertApproxEqRel(IERC20(BTCB).balanceOf(alice), btcOut, 1e12, "BTCB to alice");
        assertApproxEqRel(IERC20(WBNB).balanceOf(bob), bnbOut, 1e12, "WBNB to bob");
    }

    /// @dev VPD-2672 scope: USDT, USDC and U into BTCB, ETH and WBNB. USDC and U route through USDT, the deep pools.
    function test_allNinePairs_buyThroughTheLivePools() public onlyFork {
        dca.setMinAmountPerBuy(USDC, 10e18);
        dca.setMinAmountPerBuy(U, 10e18);

        address[3] memory stables = [USDT, USDC, U];
        address[3] memory assets = [BTCB, ETH, WBNB];
        address[3] memory hubs = [HUB_USDT, HUB_USDC, HUB_U];
        address[3] memory vTokens = [VBTC, VETH, VWBNB];
        uint24[3] memory toUsdtFee = [uint24(0), FEE_500, FEE_100];
        uint24[3] memory fromUsdtFee = [FEE_500, FEE_100, FEE_500];
        uint32[9] memory pids;
        uint256[9] memory planIds;
        for (uint256 i; i < 9; ++i) {
            (address stable, address asset) = (stables[i / 3], assets[i % 3]);
            uint32 pid = i == 0 ? pairId : _addPair(stable, asset, hubs[i / 3], vTokens[i % 3]);
            routeOf[pid] = i / 3 == 0
                ? abi.encodePacked(USDT, fromUsdtFee[i % 3], asset)
                : abi.encodePacked(stable, toUsdtFee[i / 3], USDT, fromUsdtFee[i % 3], asset);
            address user = address(uint160(0xD0CA + i));
            _fund(stable, user, DEPOSIT);
            pids[i] = pid;
            planIds[i] = _create(user, pid, DEPOSIT, 2);
        }

        for (uint256 i; i < 9; ++i) {
            (, uint256 amountOut) = _runRound(pids[i], 1);
            assertGt(amountOut, 0, "bought");
            address user = address(uint160(0xD0CA + i));
            vm.prank(user);
            dca.withdrawBought(planIds[i], type(uint256).max, user);
            assertApproxEqRel(IERC20(assets[i % 3]).balanceOf(user), amountOut, 1e12, "asset out");
        }
    }

    // ---------------------------------------------------------------- admin

    function test_claimRewards_sendsXvsToReserve() public onlyFork {
        // vBTC has no XVS supply speed at the fork block, so the Comptroller admin sets one as a VIP would
        address[] memory markets = new address[](1);
        markets[0] = VBTC;
        uint256[] memory speeds = new uint256[](1);
        speeds[0] = 1e15;
        vm.prank(COMPTROLLER_ADMIN);
        IComptrollerAdmin(COMPTROLLER)._setVenusSpeeds(markets, speeds, new uint256[](1));

        _create(alice, pairId, DEPOSIT, 2);
        _runRound(pairId, 1);
        vm.roll(block.number + 100_000);

        dca.claimRewards(markets);
        assertGt(IERC20(XVS).balanceOf(reserve), 0, "XVS to Reserve");
        assertEq(IERC20(XVS).balanceOf(address(dca)), 0, "none kept");
    }

    function test_sweepToken_takesOnlyWhatNoPlanOwns() public onlyFork {
        _create(alice, pairId, DEPOSIT, 2);
        _runRound(pairId, 1);
        (, , uint256 vbtcShares, ) = dca.yieldSources(pairId, ISmartDCA.Side.Asset);
        (, , uint256 hubShares, ) = dca.yieldSources(pairId, ISmartDCA.Side.Stable);

        // Stray vBTC and Hub shares sent to the contract by mistake
        address to = makeAddr("to");
        deal(VBTC, address(dca), vbtcShares + 1e8);
        deal(HUB_USDT, address(dca), hubShares + 1e24);

        dca.sweepToken(VBTC, to);
        dca.sweepToken(HUB_USDT, to);

        assertEq(IERC20(VBTC).balanceOf(to), 1e8, "only stray vBTC");
        assertEq(IERC20(HUB_USDT).balanceOf(to), 1e24, "only stray Hub shares");
        assertEq(IERC20(VBTC).balanceOf(address(dca)), vbtcShares, "plan vBTC kept");
        assertEq(IERC20(HUB_USDT).balanceOf(address(dca)), hubShares, "plan Hub shares kept");
    }

    // ---------------------------------------------------------------- helpers

    function _fund(address token, address user, uint256 amount) internal {
        deal(token, user, IERC20(token).balanceOf(user) + amount);
        vm.prank(user);
        IERC20(token).approve(address(dca), type(uint256).max);
    }

    function _create(address user, uint32 pid, uint256 amount, uint8 buys) internal returns (uint256 planId) {
        vm.prank(user);
        planId = dca.createPlan(pid, amount, buys, user);
    }

    /// @dev Moves time and blocks to the pair's lock time, so Core and the Hub accrue interest on the way
    function _toLock(uint32 pid) internal {
        uint256 lock = dca.nextLockTime(pid);
        if (block.timestamp < lock) {
            vm.roll(block.number + ((lock - block.timestamp) * BLOCKS_PER_20_SECONDS) / 20);
            vm.warp(lock);
        }
    }

    /// @dev Runs the pair's next round at its lock time, in `parts` swaps, and returns what it swapped and bought
    function _runRound(uint32 pid, uint8 parts) internal returns (uint256 stableNet, uint256 amountOut) {
        _toLock(pid);
        vm.startPrank(keeper);
        dca.startRound(pid, parts);
        for (uint8 i; i < parts; ++i) _execute(pid);
        dca.settleRound(pid);
        vm.stopPrank();

        (, , , , , stableNet, , amountOut, , , , , , ) = dca.rounds(pid, _lastSettled(pid));
    }

    function _lastSettled(uint32 pid) internal view returns (uint32 settled) {
        (, , , settled, , , , , ) = dca.pairs(pid);
    }

    /// @dev Runs the pair's next part the way the keeper does: a fresh quote, then the signed swap
    function _execute(uint32 pid) internal {
        uint256 quote = _quote(pid);
        dca.swapRoundPart(pid, quote, _swapData(pid));
    }

    /// @dev QuoterV2 quote for the pair's next part on its route
    function _quote(uint32 pid) internal returns (uint256 amountOut) {
        (, , , uint32 settled, , , , , ) = dca.pairs(pid);
        (uint8 partsTotal, uint8 partsDone, , , , , uint256 stableToSwap, , , , , , , ) = dca.rounds(pid, settled + 1);
        (amountOut, , , ) = IPancakeQuoterV2(PCS_V3_QUOTER).quoteExactInput(
            routeOf[pid],
            stableToSwap / (partsTotal - partsDone)
        );
    }

    function _swapData(uint32 pid) internal view returns (bytes memory) {
        return _signedSwapData(pid, SIGNER_KEY);
    }

    /// @dev What the backend sends for the pair's next part: SwapHelper approves the router, swaps exactly the
    ///      part SmartDCA will send, and sweeps the asset (and any stable left) back to SmartDCA. Signed for
    ///      SmartDCA as the caller, with `key`.
    function _signedSwapData(uint32 pid, uint256 key) internal view returns (bytes memory) {
        (address stable, address asset, , uint32 settled, , , , , ) = dca.pairs(pid);
        (uint8 partsTotal, uint8 partsDone, , , , , uint256 stableToSwap, , , , , , , ) = dca.rounds(pid, settled + 1);
        uint256 amountIn = stableToSwap / (partsTotal - partsDone);

        bytes[] memory calls = new bytes[](4);
        calls[0] = abi.encodeCall(SwapHelper.approveMax, (IERC20Upgradeable(stable), PCS_V3_ROUTER));
        calls[1] = abi.encodeCall(
            SwapHelper.genericCall,
            (
                PCS_V3_ROUTER,
                abi.encodeCall(
                    IPancakeV3Router.exactInput,
                    (IPancakeV3Router.ExactInputParams(routeOf[pid], SWAP_HELPER, block.timestamp, amountIn, 0))
                )
            )
        );
        calls[2] = abi.encodeCall(SwapHelper.sweep, (IERC20Upgradeable(stable), address(dca)));
        calls[3] = abi.encodeCall(SwapHelper.sweep, (IERC20Upgradeable(asset), address(dca)));

        uint256 deadline = block.timestamp + 1 hours;
        bytes32 salt = keccak256(abi.encode(pid, settled, partsDone, key, block.timestamp));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, _digest(calls, deadline, salt));
        return abi.encodeCall(SwapHelper.multicall, (calls, deadline, salt, abi.encodePacked(r, s, v)));
    }

    /// @dev EIP-712 digest SwapHelper checks: `Multicall(caller, calls, deadline, salt)` with SmartDCA as caller
    function _digest(bytes[] memory calls, uint256 deadline, bytes32 salt) internal view returns (bytes32) {
        bytes32[] memory callHashes = new bytes32[](calls.length);
        for (uint256 i; i < calls.length; ++i) callHashes[i] = keccak256(calls[i]);
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Multicall(address caller,bytes[] calls,uint256 deadline,bytes32 salt)"),
                address(dca),
                keccak256(abi.encodePacked(callHashes)),
                deadline,
                salt
            )
        );
        (, string memory name, string memory version, uint256 chainId, address verifyingContract, , ) = SwapHelper(
            SWAP_HELPER
        ).eip712Domain();
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                chainId,
                verifyingContract
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }
}
