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
 * @title DeviationSentinelConfiguratorArbitrumOne
 * @author Venus Protocol
 * @notice Arbitrum One child of DeviationSentinelConfigurator. No CurveOracle, no
 *         AerodromeOracle — all 5 monitored markets price through UniswapOracle, so
 *         no chain-specific hooks need overriding (defaults are no-op).
 * @dev See base contract for the full design rationale.
 */
contract DeviationSentinelConfiguratorArbitrumOne is DeviationSentinelConfigurator {
    // ──────────────────────────────────────────────────────────
    // Underlying tokens (monitored markets)
    // ──────────────────────────────────────────────────────────
    address private constant WETH = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1;
    address private constant WBTC = 0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f;
    address private constant USDC = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831;
    // USD₮0 — Tether's bridged USDT on Arbitrum One.
    address private constant USDT0 = 0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9;
    address private constant ARB = 0x912CE59144191C1204E64559FE8253a0e49E6548;

    // ──────────────────────────────────────────────────────────
    // DEX pools (monitored markets) — all Uniswap V3 on Arbitrum One.
    // USDC and USD₮0 share the USDC/USD₮0 pool — wired for both tokens.
    // ──────────────────────────────────────────────────────────
    address private constant POOL_WETH_USDC = 0xC6962004f452bE9203591991D15f6b388e09E8D0;
    address private constant POOL_WBTC_USDC = 0x0E4831319A50228B9e450861297aB92dee15B44F;
    address private constant POOL_USDC_USDT0 = 0xbE3aD6a5669Dc0B8b12FeBC03608860C31E2eef6;
    address private constant POOL_ARB_USDC = 0xaEBDcA1Bc8d89177EbE2308d62af5e74885DcCc3;

    // ══════════════════════════════════════════════════════════════════════════
    // Address overrides
    // ══════════════════════════════════════════════════════════════════════════

    /// @inheritdoc DeviationSentinelConfigurator
    function ACM() public pure override returns (IAccessControlManager) {
        return IAccessControlManager(0xD9dD18EB0cf10CbA837677f28A8F9Bda4bc2b157);
    }

    /// @inheritdoc DeviationSentinelConfigurator
    function NORMAL_TIMELOCK() public pure override returns (address) {
        return 0x4b94589Cc23F618687790036726f744D602c4017;
    }

    /// @inheritdoc DeviationSentinelConfigurator
    function FAST_TRACK_TIMELOCK() public pure override returns (address) {
        return 0x2286a9B2a5246218f2fC1F380383f45BDfCE3E04;
    }

    /// @inheritdoc DeviationSentinelConfigurator
    function CRITICAL_TIMELOCK() public pure override returns (address) {
        return 0x181E4f8F21D087bF02Ea2F64D5e550849FBca674;
    }

    /// @inheritdoc DeviationSentinelConfigurator
    function GUARDIAN() public pure override returns (address) {
        return 0x14e0E151b33f9802b3e75b621c1457afc44DcAA0;
    }

    /// @inheritdoc DeviationSentinelConfigurator
    function CORE_COMPTROLLER() public pure override returns (address) {
        return 0x317c1A5739F39046E20b08ac9BeEa3f10fD43326;
    }

    /// @inheritdoc DeviationSentinelConfigurator
    function DEVIATION_SENTINEL() public pure override returns (IDeviationSentinel) {
        return IDeviationSentinel(0xb4CC54B33d34fD809E8fBD83A066158591ED7Fba);
    }

    /// @inheritdoc DeviationSentinelConfigurator
    function EBRAKE() public pure override returns (address) {
        return 0xFc4CE7Ca9BB5119705Cfb84d6e4476e8a4032b26;
    }

    /// @inheritdoc DeviationSentinelConfigurator
    function SENTINEL_ORACLE() public pure override returns (ISentinelOracle) {
        return ISentinelOracle(0x3563CAbc541a0432C66A64942ffB4070a9726226);
    }

    /// @inheritdoc DeviationSentinelConfigurator
    function UNISWAP_ORACLE() public pure override returns (IDexPoolOracle) {
        return IDexPoolOracle(0xB6CFbfe6834EF519f002DBc1a8B81Ea437Ca647D);
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
    // Per-market wiring — 5 Uniswap V3 markets
    // ══════════════════════════════════════════════════════════════════════════

    /// @inheritdoc DeviationSentinelConfigurator
    function _wireMarkets() internal override {
        _wireUniswapMarket(WETH, POOL_WETH_USDC);
        _wireUniswapMarket(WBTC, POOL_WBTC_USDC);
        _wireUniswapMarket(USDC, POOL_USDC_USDT0);
        _wireUniswapMarket(USDT0, POOL_USDC_USDT0);
        _wireUniswapMarket(ARB, POOL_ARB_USDC);
    }
}
