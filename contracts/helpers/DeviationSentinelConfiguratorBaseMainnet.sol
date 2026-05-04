// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.25;

import { DeviationSentinelConfigurator } from "./DeviationSentinelConfigurator.sol";
import {
    IAccessControlManager,
    IDeviationSentinel,
    ISentinelOracle,
    IDexPoolOracle
} from "./IDeviationSentinelConfigurator.sol";

/**
 * @title DeviationSentinelConfiguratorBaseMainnet
 * @author Venus Protocol
 * @notice Base mainnet child of DeviationSentinelConfigurator. Adds the
 *         AerodromeSlipstreamOracle bootstrap (CBBTC + WSTETH) on top of the 2 Uniswap
 *         V3 markets (WETH + USDC).
 * @dev AerodromeSlipstreamOracle shares Uniswap's `setPoolConfig(address,address)`
 *      signature, so it reuses `IDexPoolOracle` from the base.
 */
contract DeviationSentinelConfiguratorBaseMainnet is DeviationSentinelConfigurator {
    // ──────────────────────────────────────────────────────────
    // Periphery — AerodromeSlipstreamOracle (Base-only; venus-periphery PR #66)
    // ──────────────────────────────────────────────────────────
    IDexPoolOracle public constant AERODROME_ORACLE = IDexPoolOracle(0x5DE0B322A74088fD64CDD01042BE2fBc47FE82EC);

    // ──────────────────────────────────────────────────────────
    // Underlying tokens (monitored markets)
    // ──────────────────────────────────────────────────────────
    address private constant WETH = 0x4200000000000000000000000000000000000006;
    address private constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address private constant CBBTC = 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf;
    address private constant WSTETH = 0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452;

    // ──────────────────────────────────────────────────────────
    // DEX pools (monitored markets).
    // WETH and USDC share the WETH/USDC Uniswap V3 Base pool — wired for both tokens.
    // ──────────────────────────────────────────────────────────
    address private constant POOL_WETH_USDC = 0x6c561B446416E1A00E8E93E221854d6eA4171372;
    address private constant POOL_CBBTC_USDC_AERODROME = 0x4e962BB3889Bf030368F56810A9c96B83CB3E778;
    address private constant POOL_WSTETH_WETH_AERODROME = 0x861A2922bE165a5Bd41b1E482B49216b465e1B5F;

    // ══════════════════════════════════════════════════════════════════════════
    // Address overrides
    // ══════════════════════════════════════════════════════════════════════════

    /// @inheritdoc DeviationSentinelConfigurator
    function ACM() public pure override returns (IAccessControlManager) {
        return IAccessControlManager(0x9E6CeEfDC6183e4D0DF8092A9B90cDF659687daB);
    }

    /// @inheritdoc DeviationSentinelConfigurator
    function NORMAL_TIMELOCK() public pure override returns (address) {
        return 0x21c12f2946a1a66cBFf7eb997022a37167eCf517;
    }

    /// @inheritdoc DeviationSentinelConfigurator
    function FAST_TRACK_TIMELOCK() public pure override returns (address) {
        return 0x209F73Ee2Fa9A72aF3Fa6aF1933A3B58ed3De5D7;
    }

    /// @inheritdoc DeviationSentinelConfigurator
    function CRITICAL_TIMELOCK() public pure override returns (address) {
        return 0x47F65466392ff2aE825d7a170889F7b5b9D8e60D;
    }

    /// @inheritdoc DeviationSentinelConfigurator
    function GUARDIAN() public pure override returns (address) {
        return 0x1803Cf1D3495b43cC628aa1d8638A981F8CD341C;
    }

    /// @inheritdoc DeviationSentinelConfigurator
    function CORE_COMPTROLLER() public pure override returns (address) {
        return 0x0C7973F9598AA62f9e03B94E92C967fD5437426C;
    }

    /// @inheritdoc DeviationSentinelConfigurator
    function DEVIATION_SENTINEL() public pure override returns (IDeviationSentinel) {
        return IDeviationSentinel(0x12D09d5b13A673269cdB624D17A42f45a5233076);
    }

    /// @inheritdoc DeviationSentinelConfigurator
    function EBRAKE() public pure override returns (address) {
        return 0x062C68Af7B9Fb059DCB7FA4B6b92E633350fb7c2;
    }

    /// @inheritdoc DeviationSentinelConfigurator
    function SENTINEL_ORACLE() public pure override returns (ISentinelOracle) {
        return ISentinelOracle(0xCdD6D79Fd313C21967CED04C1b8bE70BDc27574D);
    }

    /// @inheritdoc DeviationSentinelConfigurator
    function UNISWAP_ORACLE() public pure override returns (IDexPoolOracle) {
        return IDexPoolOracle(0xc3b5169a7d5f6341403c74187Db3C4Fe6d447762);
    }

    /// @inheritdoc DeviationSentinelConfigurator
    function MULTISIG_PAUSER() public pure override returns (address) {
        return 0xCCa5a587eBDBe80f23c8610F2e53B03158e62948;
    }

    /// @inheritdoc DeviationSentinelConfigurator
    function KEEPER() public pure override returns (address) {
        return 0x57FA23F591203F61cef84A7BC892Df69Ca95C86e;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Chain-specific hooks — AerodromeSlipstreamOracle bootstrap
    // ══════════════════════════════════════════════════════════════════════════

    /// @inheritdoc DeviationSentinelConfigurator
    function _selfGrantChainSpecificTransientPermissions() internal override {
        ACM().giveCallPermission(address(AERODROME_ORACLE), SIG_SET_POOL_CONFIG_UNISWAP, address(this));
    }

    /// @inheritdoc DeviationSentinelConfigurator
    function _selfRevokeChainSpecificTransientPermissions() internal override {
        ACM().revokeCallPermission(address(AERODROME_ORACLE), SIG_SET_POOL_CONFIG_UNISWAP, address(this));
    }

    /// @inheritdoc DeviationSentinelConfigurator
    function _grantChainSpecificDexOracleAdmins() internal override {
        _grantToGovernance(address(AERODROME_ORACLE), SIG_SET_POOL_CONFIG_UNISWAP);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Per-market wiring — 2 Uniswap V3 markets + 2 Aerodrome Slipstream markets
    // ══════════════════════════════════════════════════════════════════════════

    /// @inheritdoc DeviationSentinelConfigurator
    function _wireMarkets() internal override {
        _wireUniswapMarket(WETH, POOL_WETH_USDC);
        _wireUniswapMarket(USDC, POOL_WETH_USDC);

        _wireAerodromeMarket(CBBTC, POOL_CBBTC_USDC_AERODROME);
        _wireAerodromeMarket(WSTETH, POOL_WSTETH_WETH_AERODROME);
    }

    /**
     * @dev Wires a single Aerodrome Slipstream market end-to-end. Same shape as
     *      `_wireUniswapMarket` but routes through AERODROME_ORACLE — Aerodrome
     *      Slipstream's `slot0()` 6-tuple is incompatible with the V3 7-tuple ABI
     *      that UniswapOracle uses.
     * @param token The underlying ERC-20 being monitored.
     * @param pool The Aerodrome Slipstream concentrated-liquidity pool.
     */
    function _wireAerodromeMarket(address token, address pool) internal {
        AERODROME_ORACLE.setPoolConfig(token, pool);
        SENTINEL_ORACLE().setTokenOracleConfig(token, address(AERODROME_ORACLE));
        DEVIATION_SENTINEL().setTokenConfig(
            token,
            IDeviationSentinel.TokenConfig({ deviation: DEVIATION_PERCENT, enabled: true })
        );
    }
}
