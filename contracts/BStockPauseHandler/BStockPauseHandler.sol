// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.25;

import { AccessControlledV8 } from "@venusprotocol/governance-contracts/contracts/Governance/AccessControlledV8.sol";
import { IEBrake } from "../EmergencyBrake/IEBrake.sol";
import { IBStockToken } from "../Interfaces/IBStockToken.sol";
import { IPauseManager } from "../Interfaces/IPauseManager.sol";
import { IVToken } from "../Interfaces/IVToken.sol";

/**
 * @title BStockPauseHandler
 * @author Venus
 * @notice Zeroes the collateral factor (CF) of a Core bStock market (tokenized equity) through the Core EBrake
 *         while the issuer's PauseManager reports the market's underlying token as paused.
 * @dev A paused bStock cannot be transferred, so liquidations against it fail or cannot be exited. Zeroing CF
 *      stops new debt against the collateral, while the liquidation threshold (LT) is left unchanged so existing
 *      positions are not pushed into liquidation.
 *      - Core markets only: EBRAKE is the Core pool EBrake, whose decreaseCF covers the Core pool and every
 *        e-mode pool the market is listed in. Spoke markets are out of scope.
 *      - The pause is read from the PauseManager the token itself points to (pauseManager()), which is the
 *        one the token checks before every transfer.
 *      - Tighten-only: CF is restored by a governance VIP that reads EBrake.getMarketCFSnapshot() and then
 *        calls EBrake.resetCFSnapshot().
 *      - handlePause is called by trusted keepers; EBrake makes repeat calls no-ops.
 */
contract BStockPauseHandler is AccessControlledV8 {
    /// @notice Core pool Emergency Brake contract used to zero the collateral factor
    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    IEBrake public immutable EBRAKE;

    /// @notice Whether a keeper is trusted to call handlePause
    mapping(address => bool) public trustedKeepers;

    /// @notice Whether a vToken market is monitored, i.e. handlePause may zero its CF
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

    /// @notice Emitted when handlePause asks EBrake to zero the CF of a market whose underlying token is paused
    /// @dev Emitted on every successful handlePause call, including repeat calls on a market whose CF
    ///      is already zero (EBrake then makes no change and emits no CollateralFactorDecreased event)
    /// @param market The vToken market address
    /// @param underlying The paused underlying token
    /// @param caller The keeper that called handlePause
    /// @param pauseManager The PauseManager that reported the underlying token as paused
    event PauseBrakeApplied(
        address indexed market,
        address indexed underlying,
        address indexed caller,
        address pauseManager
    );

    /// @notice Thrown when a zero address is provided
    error ZeroAddress();

    /// @notice Thrown when handlePause is called by an address that is not a trusted keeper
    error UnauthorizedKeeper();

    /// @notice Thrown when adding a market whose underlying token is not a bStock with a PauseManager
    /// @param market The vToken market address
    error MarketNotSupported(address market);

    /// @notice Thrown when setMarketMonitored would not change the market's monitored status
    /// @param market The vToken market address
    /// @param monitored The monitored status that is already set
    error MarketMonitoringUnchanged(address market, bool monitored);

    /// @notice Thrown when handlePause is called for a market that is not monitored
    /// @param market The vToken market address
    error MarketNotMonitored(address market);

    /// @notice Thrown when handlePause is called while the market's underlying token is not paused
    /// @param market The vToken market address
    /// @param underlying The underlying token of the market
    error TokenNotPaused(address market, address underlying);

    /// @notice Restricts a function to trusted keepers
    modifier onlyKeeper() {
        if (!trustedKeepers[msg.sender]) revert UnauthorizedKeeper();
        _;
    }

    /**
     * @notice Sets the Core pool EBrake and disables initializers on the implementation
     * @param eBrake_ Address of the Core pool EBrake contract
     * @custom:error ZeroAddress if eBrake_ is the zero address
     * @custom:oz-upgrades-unsafe-allow constructor
     */
    constructor(IEBrake eBrake_) {
        if (address(eBrake_) == address(0)) revert ZeroAddress();
        EBRAKE = eBrake_;
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
     * @notice Set the trusted status of a keeper allowed to call handlePause
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
     * @dev Adding validates that the market's underlying token and the PauseManager it points to are non-zero,
     *      since a market without a PauseManager can never be braked.
     * @param market The vToken market address
     * @param monitored True to add the market, false to remove it
     * @custom:access Controlled by AccessControlManager
     * @custom:event Emits MarketMonitoringUpdated
     * @custom:error ZeroAddress if market is the zero address
     * @custom:error MarketMonitoringUnchanged if the market already has the requested status
     * @custom:error MarketNotSupported if, when adding, the underlying token or its PauseManager is the zero address
     */
    function setMarketMonitored(address market, bool monitored) external {
        _checkAccessAllowed("setMarketMonitored(address,bool)");

        if (market == address(0)) revert ZeroAddress();
        if (isMarketMonitored[market] == monitored) revert MarketMonitoringUnchanged(market, monitored);

        if (monitored) {
            address underlying = IVToken(market).underlying();
            if (underlying == address(0) || IBStockToken(underlying).pauseManager() == address(0)) {
                revert MarketNotSupported(market);
            }
        }

        isMarketMonitored[market] = monitored;
        emit MarketMonitoringUpdated(market, monitored);
    }

    /**
     * @notice Zero the collateral factor of a monitored market while its underlying token is paused
     * @dev Calls EBrake.decreaseCF(market, 0), which zeroes CF in the Core pool and in every e-mode pool the
     *      market is listed in, keeps LT and snapshots the previous CF/LT. Repeat calls are no-ops in EBrake.
     *      Reverts if the underlying token does not expose pauseManager().
     * @param market The vToken market address
     * @custom:access Only trusted keepers
     * @custom:event Emits PauseBrakeApplied
     * @custom:error UnauthorizedKeeper if the caller is not a trusted keeper
     * @custom:error MarketNotMonitored if the market is not monitored
     * @custom:error TokenNotPaused if the token's PauseManager does not report the underlying token as paused
     */
    function handlePause(address market) external onlyKeeper {
        if (!isMarketMonitored[market]) revert MarketNotMonitored(market);

        address underlying = IVToken(market).underlying();
        address pauseManager = IBStockToken(underlying).pauseManager();
        if (!IPauseManager(pauseManager).isTokenPaused(underlying)) revert TokenNotPaused(market, underlying);

        EBRAKE.decreaseCF(market, 0);

        emit PauseBrakeApplied(market, underlying, msg.sender, pauseManager);
    }
}
