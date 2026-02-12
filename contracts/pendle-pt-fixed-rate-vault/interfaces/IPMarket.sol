// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.25;

/// @title Pendle Market Interface
/// @notice Minimal interface for reading market configuration on-chain.
interface IPMarket {
    /// @notice Returns the SY, PT, and YT token addresses for this market.
    function readTokens() external view returns (address SY, address PT, address YT);

    /// @notice Returns the maturity timestamp (seconds since epoch) of this market.
    function expiry() external view returns (uint256);
}
