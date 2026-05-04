// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.25;

import { DeviationSentinelConfigurator } from "./DeviationSentinelConfigurator.sol";
import {
    IAccessControlManager,
    IDeviationSentinel,
    ISentinelOracle,
    IDexPoolOracle,
    ICurveOracle
} from "./IDeviationSentinelConfigurator.sol";

/**
 * @title DeviationSentinelConfiguratorEthereum
 * @author Venus Protocol
 * @notice Ethereum mainnet child of DeviationSentinelConfigurator. Adds the CurveOracle
 *         bootstrap (EBTC/WBTC StableSwap-NG pool) on top of the 9 Uniswap V3 markets.
 * @dev See base contract for the full design rationale (LZ payload-size bypass,
 *      trust model, strict one-shot semantics).
 */
contract DeviationSentinelConfiguratorEthereum is DeviationSentinelConfigurator {
    // ──────────────────────────────────────────────────────────
    // Periphery — CurveOracle (Ethereum-only; venus-periphery PR #66)
    // ──────────────────────────────────────────────────────────
    ICurveOracle public constant CURVE_ORACLE = ICurveOracle(0x9F508F3146cb03276282f9237c6eE64f76E3261D);

    // ──────────────────────────────────────────────────────────
    // Underlying tokens (monitored markets)
    // ──────────────────────────────────────────────────────────
    address private constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address private constant WBTC = 0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599;
    address private constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address private constant USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7;
    address private constant LBTC = 0x8236a87084f8B84306f72007F36F2618A5634494;
    address private constant USDE = 0x4c9EDD5852cd905f086C759E8383e09bff1E68B3;
    address private constant EBTC = 0x657e8C867D8B37dCC18fA4Caead9C45EB088C642;
    address private constant DAI = 0x6B175474E89094C44Da98b954EedeAC495271d0F;
    address private constant TBTC = 0x18084fbA666a33d37592fA2633fD49a74DD93a88;
    address private constant USDS = 0xdC035D45d973E3EC169d2276DDab16f1e407384F;

    // ──────────────────────────────────────────────────────────
    // DEX pools (monitored markets)
    // ──────────────────────────────────────────────────────────
    address private constant POOL_WETH_USDC = 0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640;
    address private constant POOL_WBTC_USDC = 0x99ac8cA7087fA4A2A1FB6357269965A2014ABc35;
    address private constant POOL_USDC_USDT = 0x3416cF6C708Da44DB2624D63ea0AAef7113527C6;
    address private constant POOL_LBTC_WBTC = 0x87428a53e14d24Ab19c6Ca4939B4df93B8996cA9;
    address private constant POOL_USDE_USDC = 0xE6D7EbB9f1a9519dc06D557e03C522d53520e76A;
    address private constant POOL_EBTC_WBTC_CURVE = 0x7704D01908afD31bf647d969c295BB45230cD2d6;
    address private constant POOL_DAI_USDC = 0x5777d92f208679DB4b9778590Fa3CAB3aC9e2168;
    address private constant POOL_TBTC_WETH = 0x97944213D2caeeA773DA1c9B11B0525F25b749CC;
    address private constant POOL_USDS_DAI = 0xe9F1E2EF814f5686C30ce6fb7103d0F780836C67;

    // ══════════════════════════════════════════════════════════════════════════
    // Address overrides
    // ══════════════════════════════════════════════════════════════════════════

    /// @inheritdoc DeviationSentinelConfigurator
    function ACM() public pure override returns (IAccessControlManager) {
        return IAccessControlManager(0x230058da2D23eb8836EC5DB7037ef7250c56E25E);
    }

    /// @inheritdoc DeviationSentinelConfigurator
    function NORMAL_TIMELOCK() public pure override returns (address) {
        return 0xd969E79406c35E80750aAae061D402Aab9325714;
    }

    /// @inheritdoc DeviationSentinelConfigurator
    function FAST_TRACK_TIMELOCK() public pure override returns (address) {
        return 0x8764F50616B62a99A997876C2DEAaa04554C5B2E;
    }

    /// @inheritdoc DeviationSentinelConfigurator
    function CRITICAL_TIMELOCK() public pure override returns (address) {
        return 0xeB9b85342c34F65af734C7bd4a149c86c472bC00;
    }

    /// @inheritdoc DeviationSentinelConfigurator
    function GUARDIAN() public pure override returns (address) {
        return 0x285960C5B22fD66A736C7136967A3eB15e93CC67;
    }

    /// @inheritdoc DeviationSentinelConfigurator
    function CORE_COMPTROLLER() public pure override returns (address) {
        return 0x687a01ecF6d3907658f7A7c714749fAC32336D1B;
    }

    /// @inheritdoc DeviationSentinelConfigurator
    function DEVIATION_SENTINEL() public pure override returns (IDeviationSentinel) {
        return IDeviationSentinel(0x7D0EFA41eBF1aF242A37174E1E047bD6ea1b1B9c);
    }

    /// @inheritdoc DeviationSentinelConfigurator
    function EBRAKE() public pure override returns (address) {
        return 0xCD09042c5DFFed762998Df9a058ec5944e39949B;
    }

    /// @inheritdoc DeviationSentinelConfigurator
    function SENTINEL_ORACLE() public pure override returns (ISentinelOracle) {
        return ISentinelOracle(0x444C53E194B40c272fAd683210e2cB1c16Ab132e);
    }

    /// @inheritdoc DeviationSentinelConfigurator
    function UNISWAP_ORACLE() public pure override returns (IDexPoolOracle) {
        return IDexPoolOracle(0x873993F8f5f5Ddbae0952e939ab3005Af363Af00);
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
    // Chain-specific hooks — CurveOracle bootstrap
    // ══════════════════════════════════════════════════════════════════════════

    /// @inheritdoc DeviationSentinelConfigurator
    function _selfGrantChainSpecificTransientPermissions() internal override {
        ACM().giveCallPermission(address(CURVE_ORACLE), SIG_SET_POOL_CONFIG_CURVE, address(this));
    }

    /// @inheritdoc DeviationSentinelConfigurator
    function _selfRevokeChainSpecificTransientPermissions() internal override {
        ACM().revokeCallPermission(address(CURVE_ORACLE), SIG_SET_POOL_CONFIG_CURVE, address(this));
    }

    /// @inheritdoc DeviationSentinelConfigurator
    function _grantChainSpecificDexOracleAdmins() internal override {
        _grantToGovernance(address(CURVE_ORACLE), SIG_SET_POOL_CONFIG_CURVE);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Per-market wiring — 9 Uniswap V3 markets + 1 Curve StableSwap-NG (EBTC)
    // ══════════════════════════════════════════════════════════════════════════

    /// @inheritdoc DeviationSentinelConfigurator
    function _wireMarkets() internal override {
        _wireUniswapMarket(WETH, POOL_WETH_USDC);
        _wireUniswapMarket(WBTC, POOL_WBTC_USDC);
        _wireUniswapMarket(USDC, POOL_USDC_USDT);
        _wireUniswapMarket(USDT, POOL_USDC_USDT);
        _wireUniswapMarket(LBTC, POOL_LBTC_WBTC);
        _wireUniswapMarket(USDE, POOL_USDE_USDC);
        _wireUniswapMarket(DAI, POOL_DAI_USDC);
        _wireUniswapMarket(TBTC, POOL_TBTC_WETH);
        _wireUniswapMarket(USDS, POOL_USDS_DAI);

        // EBTC priced via the EBTC/WBTC StableSwap-NG pool (coinIndex=0, refCoinIndex=1).
        // assetDecimals=8 matches EBTC's ERC-20 decimals; get_dy probes 10^8 units.
        _wireCurveMarket({
            token: EBTC,
            pool: POOL_EBTC_WBTC_CURVE,
            coinIndex: 0,
            refCoinIndex: 1,
            referenceToken: WBTC,
            assetDecimals: 8
        });
    }

    /**
     * @dev Wires a single Curve StableSwap-NG market end-to-end. Same downstream wiring
     *      as `_wireUniswapMarket` but routes through CURVE_ORACLE, which needs
     *      coinIndex / refCoinIndex / referenceToken / assetDecimals to compute price
     *      via `get_dy` against a reference asset.
     * @param token The underlying ERC-20 being monitored.
     * @param pool The Curve StableSwap-NG pool that holds `token` and `referenceToken`.
     * @param coinIndex Index of `token` in `pool.coins()`.
     * @param refCoinIndex Index of `referenceToken` in `pool.coins()`.
     * @param referenceToken Asset whose USD price is supplied by ResilientOracle.
     * @param assetDecimals ERC-20 decimals of `token` (used to scale `get_dy` output).
     */
    function _wireCurveMarket(
        address token,
        address pool,
        uint8 coinIndex,
        uint8 refCoinIndex,
        address referenceToken,
        uint8 assetDecimals
    ) internal {
        CURVE_ORACLE.setPoolConfig(token, pool, coinIndex, refCoinIndex, referenceToken, assetDecimals);
        SENTINEL_ORACLE().setTokenOracleConfig(token, address(CURVE_ORACLE));
        DEVIATION_SENTINEL().setTokenConfig(
            token,
            IDeviationSentinel.TokenConfig({ deviation: DEVIATION_PERCENT, enabled: true })
        );
    }
}
