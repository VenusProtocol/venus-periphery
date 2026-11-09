// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.25;

import { EnumerableSetUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/structs/EnumerableSetUpgradeable.sol";
import { AccessControlledV8 } from "@venusprotocol/governance-contracts/contracts/Governance/AccessControlledV8.sol";
import { IEBrake } from "../EmergencyBrake/IEBrake.sol";
import { IBStockToken } from "../Interfaces/IBStockToken.sol";
import { ICompliance } from "../Interfaces/ICompliance.sol";
import { IPauseManager } from "../Interfaces/IPauseManager.sol";
import { IVToken } from "../Interfaces/IVToken.sol";

/**
 * @title BStockPauseSentinel
 * @author Venus
 * @notice Keeper-driven sentinel that zeroes the collateral factor (CF) of monitored bStock (tokenized equity)
 *         markets through EBrake while the issuer's PauseManager reports the token as paused, or the token's
 *         compliance module sanctions or blocklists the market.
 * @dev A paused bStock cannot be transferred. Liquidations still seize its vTokens, but no one can redeem them
 *      for the bStock until the pause ends, so liquidators cannot exit. Zeroing CF stops new debt against the
 *      collateral, while the liquidation threshold (LT) is left unchanged so existing positions are not pushed
 *      into liquidation.
 *      - Any market EBrake can act on: EBrake acts on the market's own comptroller and checks the listing there.
 *      - The pause is read from the PauseManager the token itself points to (pauseManager()), which is the
 *        one the token checks before every transfer.
 *      - A sanctioned or blocklisted vToken can neither send nor receive the token, which blocks redeems and
 *        mints just like a pause, so it is treated as one. The block is read by running the same
 *        checkIsCompliant call the token makes, on the compliance module it points to (compliance()); any
 *        revert there counts as blocked.
 *      - Tighten-only: CF is restored by a governance VIP that reads EBrake.getMarketCFSnapshot() and then
 *        calls EBrake.resetCFSnapshot().
 *      - handleBStockPause is called by trusted keepers; EBrake makes repeat calls no-ops.
 */
contract BStockPauseSentinel is AccessControlledV8 {
    using EnumerableSetUpgradeable for EnumerableSetUpgradeable.AddressSet;

    /// @notice Emergency Brake contract used to zero the collateral factor
    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    IEBrake public immutable EBRAKE;

    /// @notice Whether a keeper is trusted to call handleBStockPause
    mapping(address => bool) public trustedKeepers;

    /// @dev The monitored vToken markets, i.e. the markets handleBStockPause may zero the CF of
    EnumerableSetUpgradeable.AddressSet private monitoredMarkets;

    /// @dev Storage gap for future upgrades
    uint256[47] private __gap;

    /// @notice Emitted when a keeper's trusted status is updated
    /// @param keeper The keeper address
    /// @param isTrusted Whether the keeper is trusted
    event TrustedKeeperUpdated(address indexed keeper, bool isTrusted);

    /// @notice Emitted when a market is added to or removed from the monitored markets
    /// @param market The vToken market address
    /// @param monitored True if the market was added, false if it was removed
    event MarketMonitoringUpdated(address indexed market, bool monitored);

    /// @notice Emitted when handleBStockPause asks EBrake to zero the CF of a market whose underlying token is paused
    ///         or blocked for the market by the token's compliance module
    /// @dev Emitted on every handleBStockPause call that finds the token paused or the market blocked, including
    ///      repeat calls on a market whose CF is already zero (EBrake then makes no change and emits no
    ///      CollateralFactorDecreased event)
    /// @param market The vToken market address
    /// @param underlying The market's underlying token
    /// @param pauseManager The PauseManager the underlying token points to
    event BStockPauseHandled(address indexed market, address indexed underlying, address pauseManager);

    /// @notice Thrown when a zero address is provided
    error ZeroAddress();

    /// @notice Thrown when handleBStockPause is called by an address that is not a trusted keeper
    error UnauthorizedKeeper();

    /// @notice Thrown when braking a market whose underlying token has no PauseManager
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
     * @notice Sets EBrake and disables initializers on the implementation
     * @param eBrake_ Address of the EBrake contract
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
     * @dev The market is not checked here: EBrake checks its listing when it zeroes CF, and handleBStockPause
     *      checks its token.
     * @param market The vToken market address
     * @param monitored True to add the market, false to remove it
     * @custom:access Controlled by AccessControlManager
     * @custom:event Emits MarketMonitoringUpdated
     * @custom:error ZeroAddress if market is the zero address
     */
    function setMarketMonitored(address market, bool monitored) external {
        _checkAccessAllowed("setMarketMonitored(address,bool)");

        if (market == address(0)) revert ZeroAddress();

        if (monitored) {
            monitoredMarkets.add(market);
        } else {
            monitoredMarkets.remove(market);
        }
        emit MarketMonitoringUpdated(market, monitored);
    }

    /**
     * @notice Zero the collateral factor of a monitored market while its underlying token is paused, or blocked
     *         for the market by the token's compliance module
     * @dev Calls EBrake.decreaseCF(market, 0), which zeroes CF in the market's pool (on the BSC Core pool, also
     *      in every e-mode pool the market is listed in), keeps LT and snapshots the previous CF/LT. Repeat calls
     *      are no-ops in EBrake. The pause and the compliance block are read through checkBStockPause; while
     *      neither holds the call does nothing.
     *      Reverts if the underlying token does not expose pauseManager() or compliance().
     * @param market The vToken market address
     * @custom:access Only trusted keepers
     * @custom:event Emits BStockPauseHandled when the token is paused or the market blocked
     * @custom:error UnauthorizedKeeper if the caller is not a trusted keeper
     * @custom:error MarketNotMonitored if the market is not monitored
     * @custom:error MarketNotSupported if the underlying token has no PauseManager
     */
    function handleBStockPause(address market) external onlyKeeper {
        if (!isMarketMonitored(market)) revert MarketNotMonitored(market);

        (bool isPaused, address underlying, address pauseManager) = checkBStockPause(market);
        if (pauseManager == address(0)) revert MarketNotSupported(market);
        if (!isPaused) return;

        EBRAKE.decreaseCF(market, 0);

        emit BStockPauseHandled(market, underlying, pauseManager);
    }

    /**
     * @notice The monitored vToken markets
     * @return The monitored market addresses, in no particular order
     */
    function getMonitoredMarkets() external view returns (address[] memory) {
        return monitoredMarkets.values();
    }

    /**
     * @notice Check whether a monitored market's underlying bStock is paused, i.e. whether handleBStockPause would
     *         act on it
     * @dev Returns zeros for a market that is not monitored, and isPaused = false for an underlying token with
     *      no PauseManager. Reads the PauseManager the token itself points to. While the token is not paused, also
     *      runs the token's compliance check for the market; a revert there counts as blocked.
     *      Reverts if the underlying token does not expose pauseManager() or compliance().
     * @param market The vToken market address
     * @return isPaused True if the market is monitored and its underlying token is paused, or the token's
     *         compliance module rejects the market (sanctioned, or blocklisted for the token)
     * @return underlying The market's underlying token, or address(0) if the market is not monitored
     * @return pauseManager The PauseManager the token points to, or address(0) if the market is not monitored or
     *         the token has none
     */
    function checkBStockPause(
        address market
    ) public view returns (bool isPaused, address underlying, address pauseManager) {
        if (!isMarketMonitored(market)) return (false, address(0), address(0));

        underlying = IVToken(market).underlying();
        if (underlying == address(0)) return (false, address(0), address(0));

        pauseManager = IBStockToken(underlying).pauseManager();
        if (pauseManager == address(0)) return (false, underlying, address(0));

        isPaused = IPauseManager(pauseManager).isTokenPaused(underlying) || _isBlockedByCompliance(underlying, market);
    }

    /**
     * @notice Whether a vToken market is monitored, i.e. handleBStockPause may zero its CF
     * @param market The vToken market address
     * @return True if the market is monitored
     */
    function isMarketMonitored(address market) public view returns (bool) {
        return monitoredMarkets.contains(market);
    }

    /**
     * @notice Whether the token's compliance module rejects a market as a party to a transfer of the token
     * @dev Runs the check the token runs on every transfer; any revert from the compliance module counts as rejected
     * @param underlying The market's underlying token
     * @param market The vToken market address
     * @return True if the compliance module rejects the market
     */
    function _isBlockedByCompliance(address underlying, address market) private view returns (bool) {
        address compliance = IBStockToken(underlying).compliance();
        try ICompliance(compliance).checkIsCompliant(underlying, market) {
            return false;
        } catch {
            return true;
        }
    }
}
