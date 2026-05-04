// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.25;

interface IAccessControlManager {
    function giveCallPermission(address contractAddress, string calldata functionSig, address accountToPermit) external;

    function revokeCallPermission(
        address contractAddress,
        string calldata functionSig,
        address accountToRevoke
    ) external;

    /// @dev OZ AccessControl. The configurator only needs `renounceRole` (to burn its own
    ///      DEFAULT_ADMIN_ROLE at the end of execute()).
    function renounceRole(bytes32 role, address account) external;

    function hasRole(bytes32 role, address account) external view returns (bool);
}

interface IDeviationSentinel {
    struct TokenConfig {
        uint8 deviation;
        bool enabled;
    }

    function setTrustedKeeper(address keeper, bool trusted) external;

    function setTokenConfig(address token, TokenConfig calldata config) external;
}

interface ISentinelOracle {
    function setTokenOracleConfig(address token, address oracle) external;
}

/// @dev UniswapOracle and AerodromeSlipstreamOracle share this signature; reused for both.
interface IDexPoolOracle {
    function setPoolConfig(address token, address pool) external;
}

/// @dev CurveOracle's StableSwap-NG pricing scheme needs extra fields beyond (token, pool).
interface ICurveOracle {
    function setPoolConfig(
        address token,
        address pool,
        uint8 coinIndex,
        uint8 refCoinIndex,
        address referenceToken,
        uint8 assetDecimals
    ) external;
}
