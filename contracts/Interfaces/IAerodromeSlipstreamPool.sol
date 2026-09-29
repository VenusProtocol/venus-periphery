// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.25;

/// @notice Minimal interface for Aerodrome Slipstream (CL) pools.
/// @dev slot0() returns 6 values — no feeProtocol field, unlike Uniswap V3's 7-value tuple.
interface IAerodromeSlipstreamPool {
    /// @notice Returns current pool state
    /// @return sqrtPriceX96 Current sqrt price as Q64.96
    /// @return tick Current tick
    /// @return observationIndex Index of last oracle observation
    /// @return observationCardinality Number of populated observations
    /// @return observationCardinalityNext Target number of observations
    /// @return unlocked Whether the pool is locked
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            bool unlocked
        );

    function token0() external view returns (address);

    function token1() external view returns (address);
}
