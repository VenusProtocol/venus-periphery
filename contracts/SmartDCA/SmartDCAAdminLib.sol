// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ResilientOracleInterface } from "@venusprotocol/oracle/contracts/interfaces/OracleInterface.sol";

import { IHub } from "../CollateralGateway/IHub.sol";
import { IComptroller } from "../Interfaces/IComptroller.sol";
import { IHubRegistry } from "../Interfaces/IHubLiquidity.sol";
import { IVToken } from "../Interfaces/IVToken.sol";
import { SmartDCAMath } from "./SmartDCAMath.sol";
import { ISmartDCA } from "./ISmartDCA.sol";

/**
 * @title SmartDCAAdminLib
 * @author Venus
 * @notice Bodies of SmartDCA's larger governance calls, kept out of SmartDCA to fit the 24,576 byte size limit
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
        pair.lastSettledRound = SmartDCAMath.latestLockedRound(block.timestamp);
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
            comptroller
        );
        setYieldSource(
            pair,
            sources[ISmartDCA.Side.Asset],
            pairId,
            ISmartDCA.Side.Asset,
            assetKind,
            assetSource,
            hubRegistry,
            comptroller
        );
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
     */
    function setYieldSource(
        ISmartDCA.Pair storage pair,
        ISmartDCA.YieldSource storage current,
        uint32 pairId,
        ISmartDCA.Side side,
        ISmartDCA.SourceKind kind,
        address source,
        IHubRegistry hubRegistry,
        IComptroller comptroller
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
            if (block.timestamp >= SmartDCAMath.lockTimeOf(pair.lastSettledRound + 1)) {
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
}
