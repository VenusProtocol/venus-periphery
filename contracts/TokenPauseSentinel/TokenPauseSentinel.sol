// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.25;

import { AccessControlledV8 } from "@venusprotocol/governance-contracts/contracts/Governance/AccessControlledV8.sol";
import { PoolRegistryInterface } from "@venusprotocol/isolated-pools/contracts/Pool/PoolRegistryInterface.sol";
import { IEBrake } from "../EmergencyBrake/IEBrake.sol";
import { IBStockToken } from "../Interfaces/IBStockToken.sol";
import { IComptroller } from "../Interfaces/IComptroller.sol";
import { ICorePoolComptroller } from "../Interfaces/ICorePoolComptroller.sol";
import { IPauseManager } from "../Interfaces/IPauseManager.sol";
import { IVToken } from "../Interfaces/IVToken.sol";

/**
 * @title TokenPauseSentinel
 * @author Venus
 * @notice Keeper-driven sentinel that tightens monitored markets through EBrake when their underlying token
 *         reports a condition that blocks its transfers. bStocks (tokenized equity) are handled by
 *         handleBStockPause, which zeroes the collateral factor (CF) while the issuer's PauseManager reports the
 *         token as paused.
 * @dev A paused bStock cannot be transferred. Liquidations still seize its vTokens, but no one can redeem them
 *      for the bStock until the pause ends, so liquidators cannot exit. Zeroing CF stops new debt against the
 *      collateral, while the liquidation threshold (LT) is left unchanged so existing positions are not pushed
 *      into liquidation.
 *      - Markets of COMPTROLLER (the Core pool) or of a Spoke pool registered in SPOKE_POOL_REGISTRY.
 *      - The pause is read from the PauseManager the token itself points to (pauseManager()), which is the
 *        one the token checks before every transfer.
 *      - Tighten-only: CF is restored by a governance VIP that reads EBrake.getMarketCFSnapshot() and then
 *        calls EBrake.resetCFSnapshot().
 *      - handleBStockPause is called by trusted keepers; EBrake makes repeat calls no-ops.
 */
contract TokenPauseSentinel is AccessControlledV8 {
    /// @notice Emergency Brake contract used to zero the collateral factor
    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    IEBrake public immutable EBRAKE;

    /// @notice Core pool comptroller whose markets may be monitored (Diamond on BSC, isolated-pools elsewhere)
    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    ICorePoolComptroller public immutable COMPTROLLER;

    /// @notice Spoke PoolRegistry whose markets may be monitored, or address(0) on chains without Spoke pools
    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    PoolRegistryInterface public immutable SPOKE_POOL_REGISTRY;

    /// @notice Whether a keeper is trusted to call handleBStockPause
    mapping(address => bool) public trustedKeepers;

    /// @notice Whether a vToken market is monitored, i.e. handleBStockPause may zero its CF
    mapping(address => bool) public isMarketMonitored;

    /// @dev Storage gap for future upgrades
    uint256[48] private __gap;

    /// @notice Emitted when a keeper's trusted status is updated
    /// @param keeper The keeper address
    /// @param isTrusted Whether the keeper is trusted
    event TrustedKeeperUpdated(address indexed keeper, bool isTrusted);

    /// @notice Emitted when a market is added to or removed from the monitored markets
    /// @param market The vToken market address
    /// @param monitored True if the market was added, false if it was removed
    event MarketMonitoringUpdated(address indexed market, bool monitored);

    /// @notice Emitted when handleBStockPause asks EBrake to zero the CF of a market whose underlying token is paused
    /// @dev Emitted on every handleBStockPause call that finds the token paused, including repeat calls on a
    ///      market whose CF is already zero (EBrake then makes no change and emits no CollateralFactorDecreased event)
    /// @param market The vToken market address
    /// @param underlying The paused underlying token
    /// @param pauseManager The PauseManager that reported the underlying token as paused
    event BStockPauseHandled(address indexed market, address indexed underlying, address pauseManager);

    /// @notice Thrown when a zero address is provided
    error ZeroAddress();

    /// @notice Thrown when handleBStockPause is called by an address that is not a trusted keeper
    error UnauthorizedKeeper();

    /// @notice Thrown when adding a market outside the Core pool and the registered Spoke pools, or when braking a
    ///         market whose underlying token has no PauseManager
    /// @param market The vToken market address
    error MarketNotSupported(address market);

    /// @notice Thrown when handleBStockPause is called for a market that is not monitored
    /// @param market The vToken market address
    error MarketNotMonitored(address market);

    /// @notice Restricts a function to trusted keepers
    modifier onlyKeeper() {
        if (!trustedKeepers[msg.sender]) revert UnauthorizedKeeper();
        _;
    }

    /**
     * @notice Sets EBrake, the Core pool comptroller and the Spoke PoolRegistry and disables initializers on the
     *         implementation
     * @param eBrake_ Address of the EBrake contract
     * @param comptroller_ Address of the Core pool comptroller
     * @param spokePoolRegistry_ Address of the Spoke PoolRegistry, or address(0) on chains without Spoke pools
     * @custom:error ZeroAddress if eBrake_ or comptroller_ is the zero address
     * @custom:oz-upgrades-unsafe-allow constructor
     */
    constructor(IEBrake eBrake_, ICorePoolComptroller comptroller_, PoolRegistryInterface spokePoolRegistry_) {
        if (address(eBrake_) == address(0) || address(comptroller_) == address(0)) revert ZeroAddress();
        EBRAKE = eBrake_;
        COMPTROLLER = comptroller_;
        SPOKE_POOL_REGISTRY = spokePoolRegistry_;
        _disableInitializers();
    }

    /**
     * @notice Initializes the proxy with the AccessControlManager
     * @param accessControlManager_ Address of the AccessControlManager
     */
    function initialize(address accessControlManager_) external initializer {
        __AccessControlled_init(accessControlManager_);
    }

    /**
     * @notice Set the trusted status of a keeper allowed to call handleBStockPause
     * @param keeper The keeper address
     * @param isTrusted Whether the keeper should be trusted
     * @custom:access Controlled by AccessControlManager
     * @custom:event Emits TrustedKeeperUpdated
     * @custom:error ZeroAddress if keeper is the zero address
     */
    function setTrustedKeeper(address keeper, bool isTrusted) external {
        _checkAccessAllowed("setTrustedKeeper(address,bool)");

        if (keeper == address(0)) revert ZeroAddress();

        trustedKeepers[keeper] = isTrusted;
        emit TrustedKeeperUpdated(keeper, isTrusted);
    }

    /**
     * @notice Add a market to, or remove it from, the monitored markets
     * @dev Adding checks the market's pool: a Spoke market must be listed in a comptroller registered in
     *      SPOKE_POOL_REGISTRY, any other market must be listed in COMPTROLLER (the Core pool).
     *      The market's underlying token is not checked here; each handler checks the token it needs.
     * @param market The vToken market address
     * @param monitored True to add the market, false to remove it
     * @param isSpokePool True if the market is in a Spoke pool, false if it is in the Core pool; ignored when removing
     * @custom:access Controlled by AccessControlManager
     * @custom:event Emits MarketMonitoringUpdated
     * @custom:error ZeroAddress if market is the zero address
     * @custom:error MarketNotSupported if, when adding, the market is not listed in the pool isSpokePool names
     */
    function setMarketMonitored(address market, bool monitored, bool isSpokePool) external {
        _checkAccessAllowed("setMarketMonitored(address,bool,bool)");

        if (market == address(0)) revert ZeroAddress();

        if (monitored) {
            bool supported = isSpokePool ? _isSpokeMarket(market) : COMPTROLLER.isMarketListed(market);
            if (!supported) revert MarketNotSupported(market);
        }

        isMarketMonitored[market] = monitored;
        emit MarketMonitoringUpdated(market, monitored);
    }

    /**
     * @notice Zero the collateral factor of a monitored market while its underlying token is paused
     * @dev Calls EBrake.decreaseCF(market, 0), which zeroes CF in the market's pool (on the BSC Core pool, also
     *      in every e-mode pool the market is listed in), keeps LT and snapshots the previous CF/LT. Repeat calls
     *      are no-ops in EBrake. The pause is read through checkBStockPause; while the token is not paused the
     *      call does nothing.
     *      Reverts if the underlying token does not expose pauseManager().
     * @param market The vToken market address
     * @custom:access Only trusted keepers
     * @custom:event Emits BStockPauseHandled when the token is paused
     * @custom:error UnauthorizedKeeper if the caller is not a trusted keeper
     * @custom:error MarketNotMonitored if the market is not monitored
     * @custom:error MarketNotSupported if the underlying token has no PauseManager
     */
    function handleBStockPause(address market) external onlyKeeper {
        if (!isMarketMonitored[market]) revert MarketNotMonitored(market);

        (bool isPaused, address underlying, address pauseManager) = checkBStockPause(market);
        if (pauseManager == address(0)) revert MarketNotSupported(market);
        if (!isPaused) return;

        EBRAKE.decreaseCF(market, 0);

        emit BStockPauseHandled(market, underlying, pauseManager);
    }

    /**
     * @notice Check whether a monitored market's underlying bStock is paused, i.e. whether handleBStockPause would
     *         act on it
     * @dev Returns zeros for a market that is not monitored, and isPaused = false for an underlying token with
     *      no PauseManager. Reads the PauseManager the token itself points to.
     *      Reverts if the underlying token does not expose pauseManager().
     * @param market The vToken market address
     * @return isPaused True if the market is monitored and its underlying token is paused
     * @return underlying The market's underlying token, or address(0) if the market is not monitored
     * @return pauseManager The PauseManager the token points to, or address(0) if the market is not monitored or
     *         the token has none
     */
    function checkBStockPause(
        address market
    ) public view returns (bool isPaused, address underlying, address pauseManager) {
        if (!isMarketMonitored[market]) return (false, address(0), address(0));

        underlying = IVToken(market).underlying();
        if (underlying == address(0)) return (false, address(0), address(0));

        pauseManager = IBStockToken(underlying).pauseManager();
        if (pauseManager == address(0)) return (false, underlying, address(0));

        isPaused = IPauseManager(pauseManager).isTokenPaused(underlying);
    }

    /**
     * @notice Whether `market` is listed in a comptroller registered in SPOKE_POOL_REGISTRY
     * @param market The vToken market address
     * @return True if `market` is a listed market of a registered Spoke pool
     */
    function _isSpokeMarket(address market) internal view returns (bool) {
        address comptroller = address(IVToken(market).comptroller());
        return
            address(SPOKE_POOL_REGISTRY) != address(0) &&
            comptroller != address(0) &&
            SPOKE_POOL_REGISTRY.getPoolByComptroller(comptroller).comptroller == comptroller &&
            IComptroller(comptroller).isMarketListed(market);
    }
}
