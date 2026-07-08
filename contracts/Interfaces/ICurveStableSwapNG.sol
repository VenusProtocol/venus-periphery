// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.25;

interface ICurveStableSwapNG {
    /// @notice Calculate the current output dy given input dx
    /// @param i Index of the input coin
    /// @param j Index of the output coin
    /// @param dx Amount of input coin (in coins[i] base units)
    /// @return Amount of output coin (in coins[j] base units)
    function get_dy(int128 i, int128 j, uint256 dx) external view returns (uint256);

    /// @notice Returns the address of the k-th coin in the pool
    function coins(uint256 k) external view returns (address);
}
