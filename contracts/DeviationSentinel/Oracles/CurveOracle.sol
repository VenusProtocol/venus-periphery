// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.25;

import { ICurveStableSwapNG } from "../../Interfaces/ICurveStableSwapNG.sol";
import { ResilientOracleInterface } from "@venusprotocol/oracle/contracts/interfaces/OracleInterface.sol";
import { AccessControlledV8 } from "@venusprotocol/governance-contracts/contracts/Governance/AccessControlledV8.sol";

/**
 * @title CurveOracle
 * @author Venus
 * @notice Oracle contract for fetching asset prices from Curve StableSwap-NG pools.
 *         Uses the pool's built-in EMA price oracle (price_oracle) which provides
 *         manipulation-resistant prices without requiring a separate TWAP observation.
 *
 * @dev Curve StableSwap-NG stores the spot price as `dx[0]/dx[1]` — how many coins[0] you
 *      receive per unit of coins[1] added — scaled to 1e18. For a 2-coin pool this means:
 *
 *        price_oracle(0) = coins[0] per coins[1]  (e.g. WBTC per eBTC = 1.002e18 when eBTC
 *        trades at a ~0.2% premium over WBTC)
 *
 *      This is verified empirically: ratio * refPrice / 1e18 matches the ResilientOracle
 *      price of the asset to within Curve EMA lag (~0.1%) on Ethereum mainnet.
 *      See: pool 0x7704D01908afD31bf647d969c295BB45230cD2d6 (eBTC/WBTC StableSwap-NG).
 *
 *      Asset pricing:
 *        - coins[0] asset: ratio = coins[0]/coins[1], price = ratio * refPrice / 1e18
 *        - coins[k>0] asset: ratio = coins[k]/coins[0], price = refPrice * 1e18 / ratio
 *          where refToken == coins[0].
 */
contract CurveOracle is AccessControlledV8 {
    /// @notice Resilient Oracle for getting reference token prices
    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    ResilientOracleInterface public immutable RESILIENT_ORACLE;

    /// @notice Pool configuration for a token
    /// @param pool Address of the Curve StableSwap-NG pool
    /// @param coinIndex Index of the asset in the pool (coins(coinIndex) == asset)
    /// @param referenceToken The paired token used to denominate the price
    struct PoolConfig {
        address pool;
        uint8 coinIndex;
        address referenceToken;
    }

    /// @notice Mapping of token addresses to their Curve pool configuration
    mapping(address => PoolConfig) public poolConfigs;

    /// @notice Emitted when a token's pool configuration is updated
    event PoolConfigUpdated(address indexed token, address indexed pool, uint8 coinIndex, address referenceToken);

    /// @notice Thrown when a zero address is provided
    error ZeroAddress();

    /// @notice Thrown when token is not configured
    error TokenNotConfigured();

    /// @notice Thrown when the pool does not contain the token at the given coin index
    error AssetMismatch();

    /// @notice Thrown when the pool returns a zero price
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
    /// @param pool Address of the Curve StableSwap-NG pool
    /// @param coinIndex Index of the token in the pool (0-based)
    /// @param referenceToken The paired token whose USD price is fetched from ResilientOracle
    /// @custom:event Emits PoolConfigUpdated
    /// @custom:error ZeroAddress if any address is zero
    /// @custom:error AssetMismatch if pool.coins(coinIndex) != token
    function setPoolConfig(address token, address pool, uint8 coinIndex, address referenceToken) external {
        _checkAccessAllowed("setPoolConfig(address,address,uint8,address)");

        if (token == address(0) || pool == address(0) || referenceToken == address(0)) revert ZeroAddress();
        if (ICurveStableSwapNG(pool).coins(coinIndex) != token) revert AssetMismatch();

        poolConfigs[token] = PoolConfig({ pool: pool, coinIndex: coinIndex, referenceToken: referenceToken });
        emit PoolConfigUpdated(token, pool, coinIndex, referenceToken);
    }

    /// @notice Get the price of an asset from its configured Curve pool
    /// @param asset Address of the asset
    /// @return price Price in (36 - asset decimals) format, same as ResilientOracle
    /// @custom:error TokenNotConfigured if asset has no pool configured
    function getPrice(address asset) external view returns (uint256 price) {
        PoolConfig memory cfg = poolConfigs[asset];
        if (cfg.pool == address(0)) revert TokenNotConfigured();

        return _getCurvePrice(cfg, asset);
    }

    /// @dev price_oracle(0) = coins[0] / coins[1] in 1e18 (EMA of dx[0]/dx[1]).
    ///      coins[0] asset: ratio = coins[0] per coins[1]  → price = ratio * refPrice / 1e18
    ///      coins[k>0] asset: ratio = coins[k] per coins[0] → price = refPrice * 1e18 / ratio
    function _getCurvePrice(PoolConfig memory cfg, address) internal view returns (uint256 price) {
        // For a 2-coin pool price_oracle(0) is the only valid index.
        // coinIndex==0 → ratio = coins[1]/coins[0]; coinIndex>0 → ratio = coins[coinIndex]/coins[0].
        // Both cases covered by price_oracle(coinIndex == 0 ? 0 : coinIndex - 1).
        uint256 priceOracleIndex = cfg.coinIndex == 0 ? 0 : uint256(cfg.coinIndex) - 1;
        uint256 ratio = ICurveStableSwapNG(cfg.pool).price_oracle(priceOracleIndex);
        if (ratio == 0) revert ZeroPrice();

        uint256 refPriceUsd = RESILIENT_ORACLE.getPrice(cfg.referenceToken);

        if (cfg.coinIndex == 0) {
            // ratio = referenceToken / asset  →  assetUsd = ratio * refUsd / 1e18
            price = (ratio * refPriceUsd) / 1e18;
        } else {
            // ratio = asset / coins[0]  →  assetUsd = refUsd * 1e18 / ratio
            price = (refPriceUsd * 1e18) / ratio;
        }
    }
}
