// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.25;

import { IPancakeStableSwap } from "../../Interfaces/IPancakeStableSwap.sol";
import { ResilientOracleInterface } from "@venusprotocol/oracle/contracts/interfaces/OracleInterface.sol";
import { AccessControlledV8 } from "@venusprotocol/governance-contracts/contracts/Governance/AccessControlledV8.sol";

/**
 * @title PCSStableOracle
 * @author Venus
 * @notice Oracle contract for fetching asset prices from PancakeSwap StableSwap pools.
 *         Uses get_dy() to read the instantaneous swap output, reflecting the current
 *         pool state including any active manipulation.
 *
 * @dev Functionally identical to CurveOracle, but targets pools that expose the
 *      PancakeSwap StableSwap interface — get_dy(uint256,uint256,uint256) and
 *      coins(uint256) with uint256 coin indices (Curve StableSwap-NG uses int128).
 *      The ListaDAO pools are compatible with this interface, so the same adapter
 *      can be reused for both ListaDAO and PancakeSwap StableSwap pools.
 *
 *      Uses get_dy(coinIndex, refCoinIndex, 10**assetDecimals) to get how many
 *      reference tokens one unit of the asset fetches, then multiplies by the
 *      reference token's USD price from ResilientOracle.
 *
 *      Price formula (uniform for any coinIndex):
 *        price = get_dy(i, j, 10**assetDecimals) * refPriceUsd / 10**assetDecimals
 *
 *      Derivation: dy is in ref base units; refPriceUsd is in (36-refDecimals) format.
 *        dy / 10**refDecimals × refPriceUsd  →  (36-refDecimals) units
 *        ×  10**(36-assetDecimals) / 10**(36-refDecimals)  →  (36-assetDecimals) units
 *        =  dy × refPriceUsd / 10**assetDecimals
 *      refDecimals cancel out entirely.
 *
 *      assetDecimals is stored in config at setup time to avoid a per-call STATICCALL.
 */
contract PCSStableOracle is AccessControlledV8 {
    /// @notice Resilient Oracle for getting reference token prices
    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    ResilientOracleInterface public immutable RESILIENT_ORACLE;

    /// @notice Pool configuration for a token
    /// @param pool Address of the PancakeSwap StableSwap pool
    /// @param coinIndex Index of the asset in the pool
    /// @param refCoinIndex Index of the reference token in the pool
    /// @param referenceToken The paired token whose USD price is fetched from ResilientOracle
    /// @param assetDecimals Decimals of the asset token (refDecimals not needed — cancels in formula)
    struct PoolConfig {
        address pool;
        uint8 coinIndex;
        uint8 refCoinIndex;
        address referenceToken;
        uint8 assetDecimals;
    }

    /// @notice Mapping of token addresses to their PancakeSwap StableSwap pool configuration
    mapping(address => PoolConfig) public poolConfigs;

    /// @notice Emitted when a token's pool configuration is updated
    event PoolConfigUpdated(
        address indexed token,
        address indexed pool,
        uint8 coinIndex,
        uint8 refCoinIndex,
        address referenceToken,
        uint8 assetDecimals
    );

    /// @notice Thrown when a zero address is provided
    error ZeroAddress();

    /// @notice Thrown when token is not configured
    error TokenNotConfigured();

    /// @notice Thrown when pool.coins(coinIndex) != token
    error AssetMismatch();

    /// @notice Thrown when pool.coins(refCoinIndex) != referenceToken
    error ReferenceMismatch();

    /// @notice Thrown when get_dy returns zero
    error ZeroPrice();

    /// @notice Constructor
    /// @param resilientOracle_ Address of the resilient oracle
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(ResilientOracleInterface resilientOracle_) {
        if (address(resilientOracle_) == address(0)) revert ZeroAddress();
        RESILIENT_ORACLE = resilientOracle_;
        _disableInitializers();
    }

    /// @notice Initialize the contract
    /// @param accessControlManager_ Address of the access control manager
    function initialize(address accessControlManager_) external initializer {
        __AccessControlled_init(accessControlManager_);
    }

    /// @notice Set pool configuration for a token
    /// @param token Address of the token to price
    /// @param pool Address of the PancakeSwap StableSwap pool
    /// @param coinIndex Index of the token in the pool
    /// @param refCoinIndex Index of the reference token in the pool
    /// @param referenceToken The reference token whose USD price is fetched from ResilientOracle
    /// @param assetDecimals Decimals of the asset token
    /// @custom:event Emits PoolConfigUpdated
    /// @custom:error ZeroAddress if any address is zero
    /// @custom:error AssetMismatch if pool.coins(coinIndex) != token
    /// @custom:error ReferenceMismatch if pool.coins(refCoinIndex) != referenceToken
    function setPoolConfig(
        address token,
        address pool,
        uint8 coinIndex,
        uint8 refCoinIndex,
        address referenceToken,
        uint8 assetDecimals
    ) external {
        _checkAccessAllowed("setPoolConfig(address,address,uint8,uint8,address,uint8)");

        if (token == address(0) || pool == address(0) || referenceToken == address(0)) revert ZeroAddress();
        if (IPancakeStableSwap(pool).coins(coinIndex) != token) revert AssetMismatch();
        if (IPancakeStableSwap(pool).coins(refCoinIndex) != referenceToken) revert ReferenceMismatch();

        poolConfigs[token] = PoolConfig({
            pool: pool,
            coinIndex: coinIndex,
            refCoinIndex: refCoinIndex,
            referenceToken: referenceToken,
            assetDecimals: assetDecimals
        });
        emit PoolConfigUpdated(token, pool, coinIndex, refCoinIndex, referenceToken, assetDecimals);
    }

    /// @notice Get the price of an asset from its configured PancakeSwap StableSwap pool
    /// @param asset Address of the asset
    /// @return price Price in (36 - asset decimals) format, same as ResilientOracle
    /// @custom:error TokenNotConfigured if asset has no pool configured
    function getPrice(address asset) external view returns (uint256 price) {
        PoolConfig memory cfg = poolConfigs[asset];
        if (cfg.pool == address(0)) revert TokenNotConfigured();

        return _getStableSwapPrice(cfg);
    }

    /// @dev Queries get_dy(i, j, 10**assetDecimals) for instantaneous price, then converts to USD.
    ///      price = dy * refPriceUsd / 10**assetDecimals
    function _getStableSwapPrice(PoolConfig memory cfg) internal view returns (uint256 price) {
        uint256 dy = IPancakeStableSwap(cfg.pool).get_dy(cfg.coinIndex, cfg.refCoinIndex, 10 ** cfg.assetDecimals);
        if (dy == 0) revert ZeroPrice();

        uint256 refPriceUsd = RESILIENT_ORACLE.getPrice(cfg.referenceToken);
        price = (dy * refPriceUsd) / (10 ** cfg.assetDecimals);
    }
}
