// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.25;

/**
 * @title IPauseManager
 * @author Venus
 * @notice Minimal interface of the bStock issuer's PauseManager (BSC: 0x9fc74Be63f3589485B2423984a7a0557e0CF700a).
 *         While a token is paused there, every transfer of that token reverts.
 */
interface IPauseManager {
    /// @notice Returns whether a token is currently paused
    /// @dev True if the token is paused individually or if all tokens are paused
    /// @param token The token address to check
    /// @return True if the token is paused, false otherwise
    function isTokenPaused(address token) external view returns (bool);
}
