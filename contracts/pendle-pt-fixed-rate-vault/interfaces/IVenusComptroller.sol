// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.25;

/// @title Venus Comptroller Interface for PendlePTVaultAdapter
/// @author Venus
/// @notice Minimal Comptroller interface covering delegation checks.
interface IVenusComptroller {
    /// @notice Check if `delegate` is approved to act on behalf of `user`.
    /// @param user The account that granted delegation.
    /// @param delegate The account that was granted delegation.
    /// @return True if `delegate` is approved.
    function approvedDelegates(address user, address delegate) external view returns (bool);

    /// @notice Checks whether the given vToken market is listed in the Comptroller.
    /// @param vToken The vToken address to check.
    /// @return True if the market is listed.
    function isMarketListed(address vToken) external view returns (bool);
}
