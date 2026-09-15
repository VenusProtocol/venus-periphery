// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.25;

/// @title IHub
/// @author Venus Protocol
/// @notice ERC4626 functions of a Venus Liquidity Hub used by the CollateralGateway.
interface IHub {
    /// @notice Get the underlying asset the hub accepts.
    /// @return address The underlying asset.
    function asset() external view returns (address);

    /// @notice Deposit underlying and mint hub shares to `receiver`.
    /// @param assets The amount of underlying to deposit.
    /// @param receiver The address credited with the shares.
    /// @return uint256 The amount of shares minted.
    function deposit(uint256 assets, address receiver) external returns (uint256);

    /// @notice Burn `shares` of `owner` and send the underlying to `receiver`.
    /// @param shares The amount of shares to burn.
    /// @param receiver The address that receives the underlying.
    /// @param owner The address whose shares are burned.
    /// @return uint256 The amount of underlying sent.
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256);
}
