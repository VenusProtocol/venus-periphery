// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.25;

/**
 * @title IPoolRegistry
 * @notice Interface for the Isolated Pools registry, which records the market each pool lists for
 *         a given asset.
 */
interface IPoolRegistry {
    /// @notice The market a pool lists for an asset, or the zero address when the pool never
    ///         registered one.
    /// @param comptroller The pool's Comptroller.
    /// @param asset The market's underlying.
    /// @return vToken The registered market.
    function getVTokenForAsset(address comptroller, address asset) external view returns (address vToken);
}
