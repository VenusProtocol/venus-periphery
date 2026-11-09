// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.25;

import { IAerodromeSlipstreamPool } from "../../Interfaces/IAerodromeSlipstreamPool.sol";
import { ResilientOracleInterface } from "@venusprotocol/oracle/contracts/interfaces/OracleInterface.sol";
import { AccessControlledV8 } from "@venusprotocol/governance-contracts/contracts/Governance/AccessControlledV8.sol";
import { FixedPoint96 } from "../../Libraries/FixedPoint96.sol";
import { FullMath } from "../../Libraries/FullMath.sol";

/**
 * @title AerodromeSlipstreamOracle
 * @author Venus
 * @notice Oracle for fetching asset prices from Aerodrome Slipstream (CL) pools on Base.
 *
 * @dev Aerodrome Slipstream is a concentrated-liquidity AMM (Uniswap V3 fork).
 *      Its slot0() returns 6 values — no feeProtocol field — so it is incompatible
 *      with IUniswapV3Pool. The sqrtPriceX96 → price math is otherwise identical.
 *
 *      Uses the current slot0 price (not TWAP). Suitable for sentinel deviation
 *      detection where some manipulation tolerance is acceptable; for higher
 *      security, add observe()-based TWAP in a subclass.
 */
contract AerodromeSlipstreamOracle is AccessControlledV8 {
    /// @notice Resilient Oracle for getting reference token prices
    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    ResilientOracleInterface public immutable RESILIENT_ORACLE;

    /// @notice Mapping of token addresses to their pool addresses
    mapping(address => address) public tokenPools;

    /// @notice Emitted when a token's pool configuration is updated
    event PoolConfigUpdated(address indexed token, address indexed pool);

    /// @notice Thrown when a zero address is provided
    error ZeroAddress();

    /// @notice Thrown when the token is not coins[0] or coins[1] of the configured pool
    error InvalidPool();

    /// @notice Thrown when token is not configured
    error TokenNotConfigured();

    /// @notice Constructor
    /// @param resilientOracle_ Address of the resilient oracle
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(ResilientOracleInterface resilientOracle_) {
        RESILIENT_ORACLE = resilientOracle_;
        _disableInitializers();
    }

    /// @notice Initialize the contract
    /// @param accessControlManager_ Address of the access control manager
    function initialize(address accessControlManager_) external initializer {
        __AccessControlled_init(accessControlManager_);
    }

    /// @notice Set pool configuration for a token
    /// @param token Address of the token
    /// @param pool Address of the Aerodrome Slipstream pool
    /// @custom:event Emits PoolConfigUpdated
    /// @custom:error ZeroAddress if token or pool is zero
    function setPoolConfig(address token, address pool) external {
        _checkAccessAllowed("setPoolConfig(address,address)");

        if (token == address(0) || pool == address(0)) revert ZeroAddress();

        tokenPools[token] = pool;
        emit PoolConfigUpdated(token, pool);
    }

    /// @notice Get the price of an asset from its configured Aerodrome Slipstream pool
    /// @param asset Address of the asset
    /// @return price Price in (36 - asset decimals) format, same as ResilientOracle
    /// @custom:error TokenNotConfigured if asset has no pool configured
    function getPrice(address asset) external view returns (uint256 price) {
        address pool = tokenPools[asset];
        if (pool == address(0)) revert TokenNotConfigured();

        return _getSlipstreamPrice(pool, asset);
    }

    function _getSlipstreamPrice(address pool, address token) internal view returns (uint256 price) {
        IAerodromeSlipstreamPool clPool = IAerodromeSlipstreamPool(pool);
        address token0 = clPool.token0();
        address token1 = clPool.token1();
        (uint160 sqrtPriceX96, , , , , ) = clPool.slot0();

        uint256 priceX96 = FullMath.mulDiv(sqrtPriceX96, sqrtPriceX96, FixedPoint96.Q96);

        address referenceToken;
        bool targetIsToken0;

        if (token == token0) {
            targetIsToken0 = true;
            referenceToken = token1;
        } else if (token == token1) {
            targetIsToken0 = false;
            referenceToken = token0;
        } else {
            revert InvalidPool();
        }

        uint256 referencePrice = RESILIENT_ORACLE.getPrice(referenceToken);

        if (targetIsToken0) {
            price = FullMath.mulDiv(referencePrice, priceX96, FixedPoint96.Q96);
        } else {
            price = FullMath.mulDiv(referencePrice, FixedPoint96.Q96, priceX96);
        }
    }
}
