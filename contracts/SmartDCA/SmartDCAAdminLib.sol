// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ResilientOracleInterface } from "@venusprotocol/oracle/contracts/interfaces/OracleInterface.sol";

import { IHub } from "../CollateralGateway/IHub.sol";
import { IComptroller } from "../Interfaces/IComptroller.sol";
import { IHubRegistry } from "../Interfaces/IHubLiquidity.sol";
import { IPancakeV3SwapRouter } from "../Interfaces/IPancakeV3SwapRouter.sol";
import { IVToken } from "../Interfaces/IVToken.sol";
import { SwapHelper } from "../SwapHelper/SwapHelper.sol";
import { SmartDCAMath } from "./SmartDCAMath.sol";
import { ISmartDCA } from "./ISmartDCA.sol";

/**
 * @title SmartDCAAdminLib
 * @author Venus
 * @notice Bodies of SmartDCA's larger governance and `forceBuy` calls, kept out of SmartDCA to fit the 24,576 byte
 *         size limit
 * @dev The external functions run through DELEGATECALL, so they read and write SmartDCA's storage and their events
 *      come from SmartDCA. SmartDCA checks access before calling them. `sourceDeposit` and `sourceRedeem` are
 *      internal, so they are copied into each caller, SmartDCA included.
 */
library SmartDCAAdminLib {
    using SafeERC20 for IERC20;

    /**
     * @notice Records a new pair with its two yield sources
     * @dev Reverts when the oracle cannot price either token
     * @param pair Storage of the new pair
     * @param sources Yield sources of the new pair, by side
     * @param pairId Id of the new pair
     * @param stable Token the pair sells
     * @param asset Token the pair buys
     * @param oracle Oracle that must price both tokens
     * @param hubRegistry Registry Hub sources must be in
     * @param comptroller Comptroller Core sources must be listed in
     * @param stableKind Kind of the stable's source
     * @param stableSource Hub or vToken holding the stable
     * @param assetKind Kind of the asset's source
     * @param assetSource Hub or vToken holding the asset
     */
    function addPair(
        ISmartDCA.Pair storage pair,
        mapping(ISmartDCA.Side => ISmartDCA.YieldSource) storage sources,
        uint32 pairId,
        address stable,
        address asset,
        ResilientOracleInterface oracle,
        IHubRegistry hubRegistry,
        IComptroller comptroller,
        ISmartDCA.SourceKind stableKind,
        address stableSource,
        ISmartDCA.SourceKind assetKind,
        address assetSource
    ) external {
        oracle.getPrice(stable);
        oracle.getPrice(asset);

        pair.stable = stable;
        pair.asset = asset;
        pair.enabled = true;
        emit ISmartDCA.PairAdded(pairId, stable, asset);

        // The pair holds nothing yet, so these only check and record the sources
        setYieldSource(
            pair,
            sources[ISmartDCA.Side.Stable],
            pairId,
            ISmartDCA.Side.Stable,
            stableKind,
            stableSource,
            hubRegistry,
            comptroller,
            false
        );
        setYieldSource(
            pair,
            sources[ISmartDCA.Side.Asset],
            pairId,
            ISmartDCA.Side.Asset,
            assetKind,
            assetSource,
            hubRegistry,
            comptroller,
            false
        );
    }

    /**
     * @notice Sets a pair's `forceBuy` route
     * @param route The pair's route record
     * @param pairId The pair
     * @param router PancakeSwap V3 SwapRouter, zero to remove the route
     * @param path Packed pool path from the stable to the asset
     */
    function setFallbackRoute(
        ISmartDCA.FallbackRoute storage route,
        uint32 pairId,
        address router,
        bytes calldata path
    ) external {
        route.router = router;
        route.path = path;
        emit ISmartDCA.FallbackRouteUpdated(pairId, router, path);
    }

    /**
     * @notice Swaps `stableIn` of the pair's stable for its asset on the pair's route, for `forceBuy`
     * @dev Approves only `stableIn`. Reverts if the asset that arrived, counted as a balance change, is below `minOut`.
     *      The router is the PancakeSwap V3 SwapRouter (`exactInput` with a deadline).
     * @param route The pair's route
     * @param pair The pair
     * @param oracle Oracle for both tokens' prices
     * @param stableIn Stable amount to sell
     * @param slippageBps Most the swap can return below the oracle value, in basis points
     * @return assetOut Asset amount received
     * @return quotedOut Oracle value of `stableIn` in the asset
     * @return minOut `quotedOut` less `slippageBps`
     */
    function fallbackSwap(
        ISmartDCA.FallbackRoute storage route,
        ISmartDCA.Pair storage pair,
        ResilientOracleInterface oracle,
        uint256 stableIn,
        uint256 slippageBps
    ) external returns (uint256 assetOut, uint256 quotedOut, uint256 minOut) {
        address stable = pair.stable;
        address asset = pair.asset;
        // Oracle prices are scaled by 1e36 / decimals, so this converts across decimals
        quotedOut = Math.mulDiv(stableIn, oracle.getPrice(stable), oracle.getPrice(asset));
        minOut = Math.mulDiv(quotedOut, SmartDCAMath.BPS - slippageBps, SmartDCAMath.BPS);

        uint256 assetBefore = IERC20(asset).balanceOf(address(this));
        IERC20(stable).forceApprove(route.router, stableIn);
        IPancakeV3SwapRouter(route.router).exactInput(
            IPancakeV3SwapRouter.ExactInputParams({
                path: route.path,
                recipient: address(this),
                deadline: block.timestamp,
                amountIn: stableIn,
                amountOutMinimum: minOut
            })
        );
        assetOut = IERC20(asset).balanceOf(address(this)) - assetBefore;
        if (assetOut < minOut) revert ISmartDCA.SlippageExceeded(assetOut, minOut);
    }

    /**
     * @notice Runs a keeper's signed swap of `stableIn` of the pair's stable through SwapHelper, for `swapRoundPart`
     * @dev Same flow as `LeverageStrategiesManager._performSwap`: the signed multicall swaps what SwapHelper holds and
     *      sends the asset back. Reverts if the route touches a router not on `allowedRouters`, if any of the part is
     *      left unsold, or if the asset that arrived, counted as a balance change, is below `minOut`.
     * @param allowedRouters Routers a keeper swap may call or approve
     * @param pair The pair
     * @param swapHelper SwapHelper that runs the multicall
     * @param stableIn Stable amount to sell
     * @param minOut Least asset the swap must return
     * @param swapData The keeper's `SwapHelper.multicall` calldata
     * @return assetOut Asset amount received
     */
    function keeperSwap(
        mapping(address => bool) storage allowedRouters,
        ISmartDCA.Pair storage pair,
        address swapHelper,
        uint256 stableIn,
        uint256 minOut,
        bytes calldata swapData
    ) external returns (uint256 assetOut) {
        _checkSwapRoute(allowedRouters, swapData);
        IERC20 stable = IERC20(pair.stable);
        IERC20 asset = IERC20(pair.asset);
        // Stable held here and in SwapHelper together only falls by what the swap sold, so a refund to SmartDCA,
        // a part left in SwapHelper and dust moved between the two all show as unspent
        uint256 stableHeldBefore = stable.balanceOf(address(this)) + stable.balanceOf(swapHelper);
        uint256 assetBefore = asset.balanceOf(address(this));
        stable.safeTransfer(swapHelper, stableIn);
        (bool success, ) = swapHelper.call(swapData);
        if (!success) revert ISmartDCA.SwapFailed();
        uint256 stableHeldAfter = stable.balanceOf(address(this)) + stable.balanceOf(swapHelper);
        uint256 stableSpent = stableHeldBefore > stableHeldAfter ? stableHeldBefore - stableHeldAfter : 0;
        if (stableSpent < stableIn) revert ISmartDCA.PartNotFullySwapped(stableIn, stableSpent);
        assetOut = asset.balanceOf(address(this)) - assetBefore;
        if (assetOut < minOut) revert ISmartDCA.SlippageExceeded(assetOut, minOut);
    }

    /**
     * @notice What SmartDCA owes in `token`: source shares of every pair, plus the stable left to swap and the
     *         asset bought in each running round
     * @dev Several pairs can share one source, so their shares add up
     * @param pairs Pairs by id
     * @param rounds Rounds by pair and round number
     * @param yieldSources Yield sources by pair and side
     * @param pairCount Number of pairs
     * @param token Token to count
     * @return owed Amount of `token` that belongs to plans
     */
    function owedInToken(
        mapping(uint32 => ISmartDCA.Pair) storage pairs,
        mapping(uint32 => mapping(uint32 => ISmartDCA.Round)) storage rounds,
        mapping(uint32 => mapping(ISmartDCA.Side => ISmartDCA.YieldSource)) storage yieldSources,
        uint32 pairCount,
        address token
    ) external view returns (uint256 owed) {
        for (uint32 id = 1; id <= pairCount; ++id) {
            ISmartDCA.YieldSource storage stableSource = yieldSources[id][ISmartDCA.Side.Stable];
            ISmartDCA.YieldSource storage assetSource = yieldSources[id][ISmartDCA.Side.Asset];
            if (stableSource.sourceAddress == token) owed += stableSource.sharesHeld;
            if (assetSource.sourceAddress == token) owed += assetSource.sharesHeld;

            ISmartDCA.Pair storage pair = pairs[id];
            ISmartDCA.Round storage r = rounds[id][pair.lastSettledRound + 1];
            if (r.partsTotal == 0) continue;
            if (pair.stable == token) owed += r.stableToSwap;
            if (pair.asset == token) owed += r.assetBought;
        }
    }

    /**
     * @notice Checks and records the source of one side of a pair, and moves that side's holdings to it
     * @param pair The pair
     * @param current The side's yield source record
     * @param pairId Id of the pair
     * @param side Stable or asset side
     * @param kind Kind of the new source
     * @param source Hub or vToken to hold the side's token
     * @param hubRegistry Registry Hub sources must be in
     * @param comptroller Comptroller Core sources must be listed in
     * @param nextRoundStarted Whether the pair's next round has started; holdings cannot move then
     */
    function setYieldSource(
        ISmartDCA.Pair storage pair,
        ISmartDCA.YieldSource storage current,
        uint32 pairId,
        ISmartDCA.Side side,
        ISmartDCA.SourceKind kind,
        address source,
        IHubRegistry hubRegistry,
        IComptroller comptroller,
        bool nextRoundStarted
    ) public {
        if (source == address(0)) revert ISmartDCA.ZeroAddress();
        address token = side == ISmartDCA.Side.Stable ? pair.stable : pair.asset;
        if (kind == ISmartDCA.SourceKind.Hub) {
            if (!hubRegistry.isHub(source) || IHub(source).asset() != token) revert ISmartDCA.InvalidSource(source);
        } else if (kind == ISmartDCA.SourceKind.Core) {
            (bool isListed, , ) = comptroller.markets(source);
            if (!isListed || IVToken(source).underlying() != token) revert ISmartDCA.InvalidSource(source);
        } else {
            revert ISmartDCA.InvalidSource(source);
        }
        if (current.sourceAddress == source) revert ISmartDCA.SourceUnchanged();

        // Holdings move in the same call; the number of units does not change, so no plan record changes
        uint256 migrated;
        uint256 oldShares = current.sharesHeld;
        if (oldShares != 0) {
            if (nextRoundStarted) {
                revert ISmartDCA.PairLocked(pairId);
            }
            current.sharesHeld = 0;
            migrated = sourceRedeem(current, token, oldShares);
        }
        address oldSource = current.sourceAddress;
        current.kind = kind;
        current.sourceAddress = source;
        if (migrated != 0) current.sharesHeld = sourceDeposit(current, token, migrated);

        emit ISmartDCA.YieldSourceUpdated(pairId, side, oldSource, kind, source, migrated);
    }

    /**
     * @notice Deposits into the source and returns the shares received, measured as a balance change
     * @param s The yield source
     * @param token Token deposited
     * @param amount Amount of `token`
     * @return Shares received
     */
    function sourceDeposit(ISmartDCA.YieldSource storage s, address token, uint256 amount) internal returns (uint256) {
        address source = s.sourceAddress;
        uint256 sharesBefore = IERC20(source).balanceOf(address(this));
        IERC20(token).forceApprove(source, amount);
        if (s.kind == ISmartDCA.SourceKind.Hub) {
            IHub(source).deposit(amount, address(this));
        } else {
            uint256 err = IVToken(source).mint(amount);
            if (err != 0) revert ISmartDCA.SourceCallFailed(source, err);
        }
        return IERC20(source).balanceOf(address(this)) - sharesBefore;
    }

    /**
     * @notice Redeems shares from the source and returns the token amount received, measured as a balance change
     * @param s The yield source
     * @param token Token received
     * @param shares Source shares to redeem
     * @return Amount of `token` received
     */
    function sourceRedeem(ISmartDCA.YieldSource storage s, address token, uint256 shares) internal returns (uint256) {
        address source = s.sourceAddress;
        uint256 balanceBefore = IERC20(token).balanceOf(address(this));
        if (s.kind == ISmartDCA.SourceKind.Hub) {
            IHub(source).redeem(shares, address(this), address(this));
        } else {
            uint256 err = IVToken(source).redeem(shares);
            if (err != 0) revert ISmartDCA.SourceCallFailed(source, err);
        }
        return IERC20(token).balanceOf(address(this)) - balanceBefore;
    }

    /**
     * @notice Checks a keeper's swap before it runs: it must be a `SwapHelper.multicall` whose `genericCall` targets
     *         and `approveMax` spenders are all on `allowedRouters`, and whose `sweep` calls all send to SmartDCA
     * @dev Any other inner call reverts. The library runs through DELEGATECALL, so `address(this)` is SmartDCA.
     * @param allowedRouters Routers a keeper swap may call or approve
     * @param swapData The keeper's `SwapHelper.multicall` calldata
     */
    function _checkSwapRoute(mapping(address => bool) storage allowedRouters, bytes calldata swapData) private view {
        if (swapData.length < 4 || bytes4(swapData[:4]) != SwapHelper.multicall.selector) {
            revert ISmartDCA.SwapCallNotAllowed();
        }
        (bytes[] memory calls, , , ) = abi.decode(swapData[4:], (bytes[], uint256, bytes32, bytes));
        for (uint256 i; i < calls.length; ++i) {
            bytes memory data = calls[i];
            // All three allowed calls take two arguments: (target, data), (token, spender) and (token, to)
            if (data.length < 68) revert ISmartDCA.SwapCallNotAllowed();
            bytes4 selector = bytes4(data);
            if (selector == SwapHelper.genericCall.selector) {
                address target = _argument(data, 0);
                if (!allowedRouters[target]) revert ISmartDCA.RouterNotAllowed(target);
            } else if (selector == SwapHelper.approveMax.selector) {
                address spender = _argument(data, 1);
                if (!allowedRouters[spender]) revert ISmartDCA.RouterNotAllowed(spender);
            } else if (selector != SwapHelper.sweep.selector || _argument(data, 1) != address(this)) {
                revert ISmartDCA.SwapCallNotAllowed();
            }
        }
    }

    /**
     * @notice Reads argument `index` of an ABI encoded call as an address
     * @dev Takes the low 20 bytes of the word. A word with dirty high bytes fails ABI decoding in SwapHelper, so the
     *      call reverts there anyway.
     * @param data Selector followed by the encoded arguments; at least `4 + 32 * (index + 1)` bytes long
     * @param index Position of the argument
     * @return The argument
     */
    function _argument(bytes memory data, uint256 index) private pure returns (address) {
        uint256 word;
        // Skips the 32 byte length and the 4 byte selector
        assembly ("memory-safe") {
            word := mload(add(data, add(36, mul(index, 32))))
        }
        return address(uint160(word));
    }
}
