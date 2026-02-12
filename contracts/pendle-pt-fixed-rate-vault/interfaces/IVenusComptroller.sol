// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.25;

/// @title Venus Comptroller Interface for PendlePTVaultAdapter
/// @notice Minimal Comptroller interface covering delegation checks and market entry.
interface IVenusComptroller {
    /// @notice Enter a market on behalf of a user (enables the vToken as collateral).
    /// @dev Requires the caller to be an approved delegate of `user`.
    ///      If the user is already in the market, this is a no-op.
    /// @param user Address on whose behalf to enter the market.
    /// @param vToken The vToken market to enter.
    /// @return 0 on success, non-zero error code on failure.
    function enterMarketBehalf(address user, address vToken) external returns (uint256);

    /// @notice Check if `delegate` is approved to act on behalf of `user`.
    /// @param user The account that granted delegation.
    /// @param delegate The account that was granted delegation.
    /// @return True if `delegate` is approved.
    function approvedDelegates(address user, address delegate) external view returns (bool);
}
