// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.25;

interface ICurveStableSwapNG {
    /// @notice EMA price of coins[k+1] in terms of coins[0], scaled to 1e18
    /// @param k index into the prices array (0-based, length = N_COINS - 1)
    function price_oracle(uint256 k) external view returns (uint256);

    /// @notice Returns the address of the k-th coin in the pool
    function coins(uint256 k) external view returns (address);
}
