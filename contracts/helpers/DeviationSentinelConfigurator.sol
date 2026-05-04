// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.25;

import {
    IAccessControlManager,
    IDeviationSentinel,
    ISentinelOracle,
    IDexPoolOracle
} from "./IDeviationSentinelConfigurator.sol";

/**
 * @title DeviationSentinelConfigurator
 * @author Venus Protocol
 * @notice Abstract base shared by the per-chain DeviationSentinel + EBrake configurators
 *         (Ethereum, Arbitrum One, Base Mainnet). Holds every grant + revoke pattern that
 *         is identical across chains; chain-specific addresses, DEX oracle bootstraps, and
 *         per-market wiring are supplied by the child contracts.
 *
 * @dev Why a single helper per chain.
 *      The combined VIP-616 + VIP-617 cross-chain payload would exceed LayerZero V1's
 *      RelayerV2 hardcoded ~10000-byte payload ceiling on each destination chain. By
 *      encoding all grants + market wiring inside Solidity, each chain's VIP needs
 *      only ~6 cross-chain Commands (acceptOwnerships + helper.execute()) instead of
 *      100+ ACM grants. Tiny LZ payload, well under the limit.
 *
 * @dev Trust model.
 *      - `execute()` is gated by `msg.sender == NORMAL_TIMELOCK()`.
 *      - The setup VIP grants this helper `DEFAULT_ADMIN_ROLE` on the local ACM (the
 *        OZ AccessControl admin role required to call `giveCallPermission` and
 *        `revokeCallPermission`, since both wrap `grantRole`/`revokeRole`).
 *      - During `execute()` the helper temporarily grants itself the periphery-side
 *        admin permissions it needs and revokes them after wiring.
 *      - At the very end the helper renounces its own `DEFAULT_ADMIN_ROLE` on the
 *        ACM, retiring itself permanently. No follow-up cleanup VIP is required.
 *
 * @dev Strict one-shot. After the first successful `execute()` the helper has no
 *      remaining authority on ACM, so any future call reverts on the very first
 *      self-grant. No tokens, no upgrade path, no `receive`/`fallback`.
 */
abstract contract DeviationSentinelConfigurator {
    // ═══════════════════════════════════════════════════════════════════════════
    // Constants — function signatures, identical across chains
    // ═══════════════════════════════════════════════════════════════════════════

    string internal constant SIG_SET_TRUSTED_KEEPER = "setTrustedKeeper(address,bool)";
    string internal constant SIG_SET_TOKEN_CONFIG = "setTokenConfig(address,(uint8,bool))";
    string internal constant SIG_SET_TOKEN_MONITORING_ENABLED = "setTokenMonitoringEnabled(address,bool)";
    string internal constant SIG_SET_TOKEN_ORACLE_CONFIG = "setTokenOracleConfig(address,address)";
    string internal constant SIG_SET_DIRECT_PRICE = "setDirectPrice(address,uint256)";
    string internal constant SIG_SET_POOL_CONFIG_UNISWAP = "setPoolConfig(address,address)";
    string internal constant SIG_SET_POOL_CONFIG_CURVE = "setPoolConfig(address,address,uint8,uint8,address,uint8)";

    string internal constant SIG_SET_ACTIONS_PAUSED_IL = "setActionsPaused(address[],uint256[],bool)";
    string internal constant SIG_SET_COLLATERAL_FACTOR_IL = "setCollateralFactor(address,uint256,uint256)";
    string internal constant SIG_SET_MARKET_BORROW_CAPS = "setMarketBorrowCaps(address[],uint256[])";
    string internal constant SIG_SET_MARKET_SUPPLY_CAPS = "setMarketSupplyCaps(address[],uint256[])";

    string internal constant SIG_RESET_CF_SNAPSHOT = "resetCFSnapshot(address)";
    string internal constant SIG_RESET_BORROW_CAP_SNAPSHOT = "resetBorrowCapSnapshot(address)";
    string internal constant SIG_RESET_SUPPLY_CAP_SNAPSHOT = "resetSupplyCapSnapshot(address)";

    string internal constant SIG_PAUSE_BORROW = "pauseBorrow(address)";
    string internal constant SIG_PAUSE_SUPPLY = "pauseSupply(address)";
    string internal constant SIG_PAUSE_REDEEM = "pauseRedeem(address)";
    string internal constant SIG_PAUSE_TRANSFER = "pauseTransfer(address)";
    string internal constant SIG_PAUSE_ACTIONS = "pauseActions(address[],uint8[])";
    string internal constant SIG_DECREASE_CF_IL = "decreaseCF(address,uint256)";

    /**
     * @dev OZ AccessControl. Granting any per-(target, sig) role on the ACM internally
     *      calls `grantRole`, which checks `onlyRole(getRoleAdmin(role))`. All roles
     *      default to admin = `DEFAULT_ADMIN_ROLE`, so the helper needs that role to
     *      call `giveCallPermission` / `revokeCallPermission` on the ACM.
     */
    bytes32 internal constant DEFAULT_ADMIN_ROLE = bytes32(0);

    /// @dev Unified deviation threshold across all monitored markets on every chain.
    uint8 internal constant DEVIATION_PERCENT = 10;

    /// @notice Reverts when `execute()` is called by anyone other than NORMAL_TIMELOCK.
    error OnlyTimelock();

    // ═══════════════════════════════════════════════════════════════════════════
    //                              EXTERNAL ENTRY POINT
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Applies the entire VIP-616 + VIP-617 bootstrap atomically.
     * @dev Preconditions (handled by the wrapping VIP, not this contract):
     *      - This helper has been granted `DEFAULT_ADMIN_ROLE` on the local ACM
     *        (one-time setup VIP — `acm.grantRole(0x00, helper)`).
     *      - The Normal Timelock has accepted ownership of every contract whose admin
     *        functions this helper calls (DeviationSentinel, SentinelOracle, EBrake,
     *        UniswapOracle, plus CurveOracle on Ethereum / AerodromeOracle on Base).
     */
    function execute() external {
        if (msg.sender != NORMAL_TIMELOCK()) revert OnlyTimelock();

        _selfGrantBaseTransientPermissions();
        _selfGrantChainSpecificTransientPermissions();

        _grantSentinelAdminToGovernance();
        _grantSentinelOracleAdminToGovernance();
        _grantUniswapOracleAdminToGovernance();
        _grantChainSpecificDexOracleAdmins();
        _grantEBrakePermissionsOnComptroller();
        _grantResetPermissionsToGovernance();
        _grantSentinelPermissionsOnEBrake();
        _grantMultisigPauserEBrakeActions();
        _grantGovernanceEBrakeActions();

        _whitelistTrustedKeepers();
        _wireMarkets();

        _selfRevokeChainSpecificTransientPermissions();
        _selfRevokeBaseTransientPermissions();
        _selfRevokeACMPermissions();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //                  ABSTRACT SURFACE — children MUST implement
    // ═══════════════════════════════════════════════════════════════════════════
    //
    // Note on naming: the address getters below use SCREAMING_SNAKE_CASE deliberately
    // so call sites read like immutables (e.g. `NORMAL_TIMELOCK()` mirrors how a
    // genuine `address public immutable NORMAL_TIMELOCK` would appear). This departs
    // from the Solidity style guide's camelCase-functions convention but keeps the
    // call sites of `execute()` and the internal helpers visually identical to a
    // hypothetical concrete-address version of this contract.

    /// @notice Local AccessControlManager — gates every grant/revoke this helper performs.
    function ACM() public view virtual returns (IAccessControlManager);

    /// @notice Normal Timelock — the only authorized caller of `execute()`.
    function NORMAL_TIMELOCK() public view virtual returns (address);

    /// @notice Fast-Track Timelock (governance account, granted same admin perms as Normal).
    function FAST_TRACK_TIMELOCK() public view virtual returns (address);

    /// @notice Critical Timelock (governance account, granted same admin perms as Normal).
    function CRITICAL_TIMELOCK() public view virtual returns (address);

    /// @notice Guardian multisig (granted admin perms alongside the three Timelocks).
    function GUARDIAN() public view virtual returns (address);

    /// @notice Core Pool Comptroller — host of the EBrake action permissions.
    function CORE_COMPTROLLER() public view virtual returns (address);

    /// @notice DeviationSentinel — token-config + trusted-keeper admin host.
    function DEVIATION_SENTINEL() public view virtual returns (IDeviationSentinel);

    /// @notice EBrakeV2 — recipient of Comptroller emergency-action perms.
    function EBRAKE() public view virtual returns (address);

    /// @notice SentinelOracle — token → DEX oracle indirection layer.
    function SENTINEL_ORACLE() public view virtual returns (ISentinelOracle);

    /// @notice UniswapOracle — DEX oracle for every Uniswap V3 monitored market.
    function UNISWAP_ORACLE() public view virtual returns (IDexPoolOracle);

    /// @notice 1-of-1 Venus team multisig — granted EBrake action perms (Phase 0 manual ops).
    function MULTISIG_PAUSER() public view virtual returns (address);

    /// @notice Off-chain keeper EOA — the primary `handleDeviation` caller on DeviationSentinel.
    function KEEPER() public view virtual returns (address);

    /**
     * @dev Self-grant transient perms on chain-specific DEX oracles (Curve on Ethereum,
     *      Aerodrome on Base). Default no-op for chains with only UniswapOracle.
     */
    function _selfGrantChainSpecificTransientPermissions() internal virtual {}

    /// @dev Counterpart of `_selfGrantChainSpecificTransientPermissions()`.
    function _selfRevokeChainSpecificTransientPermissions() internal virtual {}

    /**
     * @dev Grant Guardian + Timelocks admin perms on chain-specific DEX oracles.
     *      Default no-op for chains without extra DEX oracles beyond Uniswap.
     */
    function _grantChainSpecificDexOracleAdmins() internal virtual {}

    /**
     * @dev Per-market wiring (DEX oracle → SentinelOracle → DeviationSentinel).
     *      Each chain implements its own market set.
     */
    function _wireMarkets() internal virtual;

    // ═══════════════════════════════════════════════════════════════════════════
    //                           SELF-PERMISSION MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @dev Transient self-grants every chain needs (DeviationSentinel, SentinelOracle,
     *      UniswapOracle). Curve / Aerodrome added via the chain-specific hook.
     */
    function _selfGrantBaseTransientPermissions() internal {
        IAccessControlManager acm = ACM();
        acm.giveCallPermission(address(DEVIATION_SENTINEL()), SIG_SET_TRUSTED_KEEPER, address(this));
        acm.giveCallPermission(address(DEVIATION_SENTINEL()), SIG_SET_TOKEN_CONFIG, address(this));
        acm.giveCallPermission(address(SENTINEL_ORACLE()), SIG_SET_TOKEN_ORACLE_CONFIG, address(this));
        acm.giveCallPermission(address(UNISWAP_ORACLE()), SIG_SET_POOL_CONFIG_UNISWAP, address(this));
    }

    /// @dev Counterpart of `_selfGrantBaseTransientPermissions`.
    function _selfRevokeBaseTransientPermissions() internal {
        IAccessControlManager acm = ACM();
        acm.revokeCallPermission(address(DEVIATION_SENTINEL()), SIG_SET_TRUSTED_KEEPER, address(this));
        acm.revokeCallPermission(address(DEVIATION_SENTINEL()), SIG_SET_TOKEN_CONFIG, address(this));
        acm.revokeCallPermission(address(SENTINEL_ORACLE()), SIG_SET_TOKEN_ORACLE_CONFIG, address(this));
        acm.revokeCallPermission(address(UNISWAP_ORACLE()), SIG_SET_POOL_CONFIG_UNISWAP, address(this));
    }

    /**
     * @dev Final step of `execute()`. Renounces the helper's own DEFAULT_ADMIN_ROLE
     *      on the ACM so it can no longer grant/revoke any role. After this runs the
     *      helper is permanently inert: the next `execute()` reverts inside the very
     *      first self-grant.
     */
    function _selfRevokeACMPermissions() internal {
        IAccessControlManager acm = ACM();
        acm.renounceRole(DEFAULT_ADMIN_ROLE, address(this));
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //         PERMISSION GROUPS — explicit per (host, sig, account) for audit
    // ═══════════════════════════════════════════════════════════════════════════

    /// @dev Grants `sig` on `host` to all four governance accounts in the canonical order.
    function _grantToGovernance(address host, string memory sig) internal {
        IAccessControlManager acm = ACM();
        acm.giveCallPermission(host, sig, GUARDIAN());
        acm.giveCallPermission(host, sig, NORMAL_TIMELOCK());
        acm.giveCallPermission(host, sig, FAST_TRACK_TIMELOCK());
        acm.giveCallPermission(host, sig, CRITICAL_TIMELOCK());
    }

    /// @dev DeviationSentinel admin permissions for Guardian + 3 Timelocks (3 × 4 = 12 grants).
    function _grantSentinelAdminToGovernance() internal {
        address ds = address(DEVIATION_SENTINEL());
        _grantToGovernance(ds, SIG_SET_TRUSTED_KEEPER);
        _grantToGovernance(ds, SIG_SET_TOKEN_CONFIG);
        _grantToGovernance(ds, SIG_SET_TOKEN_MONITORING_ENABLED);
    }

    /// @dev SentinelOracle admin permissions for Guardian + 3 Timelocks (2 × 4 = 8 grants).
    function _grantSentinelOracleAdminToGovernance() internal {
        address so = address(SENTINEL_ORACLE());
        _grantToGovernance(so, SIG_SET_TOKEN_ORACLE_CONFIG);
        _grantToGovernance(so, SIG_SET_DIRECT_PRICE);
    }

    /// @dev UniswapOracle admin permission for Guardian + 3 Timelocks (1 × 4 = 4 grants).
    function _grantUniswapOracleAdminToGovernance() internal {
        _grantToGovernance(address(UNISWAP_ORACLE()), SIG_SET_POOL_CONFIG_UNISWAP);
    }

    /// @dev EBrake's IL-supported emergency-action perms on the Core Pool Comptroller (4 grants).
    function _grantEBrakePermissionsOnComptroller() internal {
        IAccessControlManager acm = ACM();
        address comptroller = CORE_COMPTROLLER();
        address ebrake = EBRAKE();
        acm.giveCallPermission(comptroller, SIG_SET_ACTIONS_PAUSED_IL, ebrake);
        acm.giveCallPermission(comptroller, SIG_SET_COLLATERAL_FACTOR_IL, ebrake);
        acm.giveCallPermission(comptroller, SIG_SET_MARKET_BORROW_CAPS, ebrake);
        acm.giveCallPermission(comptroller, SIG_SET_MARKET_SUPPLY_CAPS, ebrake);
    }

    /// @dev Granular snapshot-reset perms on EBrake for Guardian + 3 Timelocks (3 × 4 = 12 grants).
    function _grantResetPermissionsToGovernance() internal {
        address ebrake = EBRAKE();
        _grantToGovernance(ebrake, SIG_RESET_CF_SNAPSHOT);
        _grantToGovernance(ebrake, SIG_RESET_BORROW_CAP_SNAPSHOT);
        _grantToGovernance(ebrake, SIG_RESET_SUPPLY_CAP_SNAPSHOT);
    }

    /// @dev EBrake actions DeviationSentinel.handleDeviation invokes on EBrake (3 grants).
    function _grantSentinelPermissionsOnEBrake() internal {
        IAccessControlManager acm = ACM();
        address ebrake = EBRAKE();
        address ds = address(DEVIATION_SENTINEL());
        acm.giveCallPermission(ebrake, SIG_PAUSE_BORROW, ds);
        acm.giveCallPermission(ebrake, SIG_PAUSE_SUPPLY, ds);
        acm.giveCallPermission(ebrake, SIG_DECREASE_CF_IL, ds);
    }

    /// @dev IL-supported EBrake action perms for the Venus team multisig pauser (8 grants).
    function _grantMultisigPauserEBrakeActions() internal {
        IAccessControlManager acm = ACM();
        address ebrake = EBRAKE();
        address pauser = MULTISIG_PAUSER();
        acm.giveCallPermission(ebrake, SIG_PAUSE_SUPPLY, pauser);
        acm.giveCallPermission(ebrake, SIG_PAUSE_REDEEM, pauser);
        acm.giveCallPermission(ebrake, SIG_PAUSE_BORROW, pauser);
        acm.giveCallPermission(ebrake, SIG_PAUSE_TRANSFER, pauser);
        acm.giveCallPermission(ebrake, SIG_PAUSE_ACTIONS, pauser);
        acm.giveCallPermission(ebrake, SIG_SET_MARKET_BORROW_CAPS, pauser);
        acm.giveCallPermission(ebrake, SIG_SET_MARKET_SUPPLY_CAPS, pauser);
        acm.giveCallPermission(ebrake, SIG_DECREASE_CF_IL, pauser);
    }

    /// @dev IL-supported EBrake action perms for Guardian + 3 Timelocks (8 × 4 = 32 grants).
    function _grantGovernanceEBrakeActions() internal {
        address ebrake = EBRAKE();
        _grantToGovernance(ebrake, SIG_PAUSE_SUPPLY);
        _grantToGovernance(ebrake, SIG_PAUSE_REDEEM);
        _grantToGovernance(ebrake, SIG_PAUSE_BORROW);
        _grantToGovernance(ebrake, SIG_PAUSE_TRANSFER);
        _grantToGovernance(ebrake, SIG_PAUSE_ACTIONS);
        _grantToGovernance(ebrake, SIG_SET_MARKET_BORROW_CAPS);
        _grantToGovernance(ebrake, SIG_SET_MARKET_SUPPLY_CAPS);
        _grantToGovernance(ebrake, SIG_DECREASE_CF_IL);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //              TRUSTED KEEPER WHITELIST — same recipients on every chain
    // ═══════════════════════════════════════════════════════════════════════════

    /// @dev Whitelists Keeper + Guardian + 3 Timelocks on DeviationSentinel (5 calls).
    function _whitelistTrustedKeepers() internal {
        IDeviationSentinel ds = DEVIATION_SENTINEL();
        ds.setTrustedKeeper(KEEPER(), true);
        ds.setTrustedKeeper(GUARDIAN(), true);
        ds.setTrustedKeeper(NORMAL_TIMELOCK(), true);
        ds.setTrustedKeeper(FAST_TRACK_TIMELOCK(), true);
        ds.setTrustedKeeper(CRITICAL_TIMELOCK(), true);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //         SHARED MARKET-WIRING PRIMITIVE — every chain has Uniswap V3 markets
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @dev Wires a single Uniswap V3 market end-to-end. Emits 3 state-changing calls:
     *      UniswapOracle.setPoolConfig → SentinelOracle.setTokenOracleConfig →
     *      DeviationSentinel.setTokenConfig.
     * @param token The underlying ERC-20 being monitored.
     * @param pool The Uniswap V3 pool whose tick will be sampled.
     */
    function _wireUniswapMarket(address token, address pool) internal {
        IDexPoolOracle uniswap = UNISWAP_ORACLE();
        uniswap.setPoolConfig(token, pool);
        SENTINEL_ORACLE().setTokenOracleConfig(token, address(uniswap));
        DEVIATION_SENTINEL().setTokenConfig(
            token,
            IDeviationSentinel.TokenConfig({ deviation: DEVIATION_PERCENT, enabled: true })
        );
    }
}
