// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.25;

import { AccessControlledV8 } from "@venusprotocol/governance-contracts/contracts/Governance/AccessControlledV8.sol";
import { PoolRegistryInterface } from "@venusprotocol/isolated-pools/contracts/Pool/PoolRegistryInterface.sol";
import { IComptroller } from "../Interfaces/IComptroller.sol";
import { IILComptroller } from "../Interfaces/IILComptroller.sol";
import { IVToken } from "../Interfaces/IVToken.sol";
import { IEBrake } from "./IEBrake.sol";

/**
 * @title SpokePoolEBrakeHandler
 * @author Venus Protocol
 * @notice Routes emergency actions on Spoke pool markets to EBrake.
 *
 * @dev Flow: Spoke trigger → SpokePoolEBrakeHandler → EBrake → SpokeComptroller.
 *
 *      EBrake acts on market.comptroller() only for calls from its SPOKE_HANDLER, which is this
 *      contract. Before forwarding, every function checks that each market's comptroller is registered
 *      in the Spoke PoolRegistry (`getPoolByComptroller(c).comptroller == c`), that the market is listed
 *      in it, and that a batch targets a single comptroller. EBrake relies on these checks, so this
 *      contract cannot reach the home comptroller, an unregistered one or an unlisted market.
 *
 *      EBrake must grant this contract the ACM permission for each forwarded function. EBrake's
 *      own rules (tighten-only, forbidden actions, snapshots) still apply to every call. Snapshot
 *      resets are not forwarded: governance calls them on EBrake directly.
 *
 *      There is no condition-specific logic yet: the checks for the Spoke pool triggers will be
 *      added later. Until then, grant this contract's ACM permissions to governance (timelocks)
 *      and the Guardian only.
 */
contract SpokePoolEBrakeHandler is AccessControlledV8 {
    /// @notice EBrake that executes the actions.
    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    IEBrake public immutable EBRAKE;

    /// @notice Spoke PoolRegistry that lists the comptrollers this handler may act on.
    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    PoolRegistryInterface public immutable SPOKE_POOL_REGISTRY;

    /// @dev Storage gap for future upgrades.
    uint256[50] private __gap;

    /// @notice Thrown when a zero address is passed where a valid address is required.
    error ZeroAddress();

    /// @notice Thrown when a market's comptroller is not registered in the Spoke PoolRegistry.
    /// @param comptroller The rejected comptroller.
    error NotSpokeComptroller(address comptroller);

    /// @notice Thrown when a batch mixes markets of different comptrollers.
    /// @param expected The comptroller of the first market in the batch.
    /// @param actual The comptroller of the first market that differs from it.
    error MarketsOnDifferentComptrollers(address expected, address actual);

    /// @notice Thrown when a market is not listed in its Spoke comptroller.
    /// @param market The rejected market.
    error MarketNotListed(address market);

    /// @notice Set the EBrake and Spoke PoolRegistry immutables and lock the implementation.
    /// @param eBrake_ The EBrake proxy.
    /// @param spokePoolRegistry_ The Spoke PoolRegistry.
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(IEBrake eBrake_, PoolRegistryInterface spokePoolRegistry_) {
        if (address(eBrake_) == address(0) || address(spokePoolRegistry_) == address(0)) revert ZeroAddress();

        EBRAKE = eBrake_;
        SPOKE_POOL_REGISTRY = spokePoolRegistry_;
        _disableInitializers();
    }

    /// @notice Initialize the proxy with the Access Control Manager.
    /// @param accessControlManager_ Address of the Venus Access Control Manager.
    /// @custom:error ZeroAddress if accessControlManager_ is address(0)
    function initialize(address accessControlManager_) external initializer {
        if (accessControlManager_ == address(0)) revert ZeroAddress();
        __AccessControlled_init(accessControlManager_);
    }

    /// @notice Pause actions on Spoke markets of one comptroller. See IEBrake.pauseActions.
    /// @param markets The vToken market addresses, all of the same Spoke comptroller.
    /// @param actions The actions to pause (MINT, REDEEM, BORROW or TRANSFER).
    /// @custom:access Controlled by AccessControlManager
    function pauseActions(address[] calldata markets, IComptroller.Action[] calldata actions) external {
        _checkAccessAllowed("pauseActions(address[],uint8[])");
        _checkSpokeMarkets(markets);
        EBRAKE.pauseActions(markets, actions);
    }

    /// @notice Pause supply (mint) on a Spoke market. See IEBrake.pauseSupply.
    /// @param market The vToken market address.
    /// @custom:access Controlled by AccessControlManager
    function pauseSupply(address market) external {
        _checkAccessAllowed("pauseSupply(address)");
        _checkSpokeMarket(market);
        EBRAKE.pauseSupply(market);
    }

    /// @notice Pause redeem on a Spoke market. See IEBrake.pauseRedeem.
    /// @param market The vToken market address.
    /// @custom:access Controlled by AccessControlManager
    function pauseRedeem(address market) external {
        _checkAccessAllowed("pauseRedeem(address)");
        _checkSpokeMarket(market);
        EBRAKE.pauseRedeem(market);
    }

    /// @notice Pause borrow on a Spoke market. See IEBrake.pauseBorrow.
    /// @param market The vToken market address.
    /// @custom:access Controlled by AccessControlManager
    function pauseBorrow(address market) external {
        _checkAccessAllowed("pauseBorrow(address)");
        _checkSpokeMarket(market);
        EBRAKE.pauseBorrow(market);
    }

    /// @notice Pause vToken transfers on a Spoke market. See IEBrake.pauseTransfer.
    /// @param market The vToken market address.
    /// @custom:access Controlled by AccessControlManager
    function pauseTransfer(address market) external {
        _checkAccessAllowed("pauseTransfer(address)");
        _checkSpokeMarket(market);
        EBRAKE.pauseTransfer(market);
    }

    /// @notice Decrease the collateral factor of a Spoke market. See IEBrake.decreaseCF(address,uint256).
    /// @param market The vToken market address.
    /// @param newCF The new collateral factor, must be <= the current one.
    /// @custom:access Controlled by AccessControlManager
    function decreaseCF(address market, uint256 newCF) external {
        _checkAccessAllowed("decreaseCF(address,uint256)");
        _checkSpokeMarket(market);
        EBRAKE.decreaseCF(market, newCF);
    }

    /// @notice Decrease borrow caps on Spoke markets of one comptroller. See IEBrake.setMarketBorrowCaps.
    /// @param markets The vToken market addresses, all of the same Spoke comptroller.
    /// @param newBorrowCaps The new borrow caps, each <= the current one.
    /// @custom:access Controlled by AccessControlManager
    function setMarketBorrowCaps(address[] calldata markets, uint256[] calldata newBorrowCaps) external {
        _checkAccessAllowed("setMarketBorrowCaps(address[],uint256[])");
        _checkSpokeMarkets(markets);
        EBRAKE.setMarketBorrowCaps(markets, newBorrowCaps);
    }

    /// @notice Decrease supply caps on Spoke markets of one comptroller. See IEBrake.setMarketSupplyCaps.
    /// @param markets The vToken market addresses, all of the same Spoke comptroller.
    /// @param newSupplyCaps The new supply caps, each <= the current one.
    /// @custom:access Controlled by AccessControlManager
    function setMarketSupplyCaps(address[] calldata markets, uint256[] calldata newSupplyCaps) external {
        _checkAccessAllowed("setMarketSupplyCaps(address[],uint256[])");
        _checkSpokeMarkets(markets);
        EBRAKE.setMarketSupplyCaps(markets, newSupplyCaps);
    }

    /**
     * @notice Reverts unless all markets are listed in the same registered Spoke comptroller.
     * @dev An empty batch passes here and EBrake rejects it with EmptyArray.
     * @param markets The vToken market addresses.
     * @custom:error NotSpokeComptroller if the first market's comptroller is not a registered Spoke comptroller
     * @custom:error MarketsOnDifferentComptrollers if the markets do not share one comptroller
     * @custom:error MarketNotListed if a market is not listed in that comptroller
     */
    function _checkSpokeMarkets(address[] calldata markets) internal view {
        uint256 marketsLen = markets.length;
        if (marketsLen == 0) return;

        address comptroller = _checkSpokeMarket(markets[0]);
        for (uint256 i = 1; i < marketsLen; ++i) {
            address other = address(IVToken(markets[i]).comptroller());
            if (other != comptroller) revert MarketsOnDifferentComptrollers(comptroller, other);
            _checkListed(comptroller, markets[i]);
        }
    }

    /**
     * @notice Reverts unless `market` is listed in a comptroller registered in the Spoke PoolRegistry.
     * @param market The vToken market address.
     * @return comptroller The Spoke comptroller of `market`.
     * @custom:error NotSpokeComptroller if the comptroller is address(0) or not registered in the Spoke PoolRegistry
     * @custom:error MarketNotListed if `market` is not listed in that comptroller
     */
    function _checkSpokeMarket(address market) internal view returns (address comptroller) {
        comptroller = address(IVToken(market).comptroller());
        if (
            comptroller == address(0) ||
            SPOKE_POOL_REGISTRY.getPoolByComptroller(comptroller).comptroller != comptroller
        ) {
            revert NotSpokeComptroller(comptroller);
        }
        _checkListed(comptroller, market);
    }

    /**
     * @notice Reverts unless `market` is listed in `comptroller`.
     * @dev A listed market is a vetted vToken, so its comptroller() is the one checked here when EBrake reads it.
     * @param comptroller The Spoke comptroller.
     * @param market The vToken market address.
     * @custom:error MarketNotListed if `market` is not listed in `comptroller`
     */
    function _checkListed(address comptroller, address market) internal view {
        if (!IILComptroller(comptroller).markets(market).isListed) revert MarketNotListed(market);
    }
}
