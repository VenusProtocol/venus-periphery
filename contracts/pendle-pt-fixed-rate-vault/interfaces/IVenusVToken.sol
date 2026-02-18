// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.25;

/// @title Venus VToken Interface for PendlePTVaultAdapter
/// @notice Minimal VToken interface covering mintBehalf/redeemBehalf operations.
/// @dev Both functions return 0 on success and a non-zero error code on failure (Compound pattern).
interface IVenusVToken {
    /// @notice Deposit underlying tokens and mint vTokens to `receiver`.
    /// @param receiver Address that receives the minted vTokens.
    /// @param mintAmount Amount of underlying tokens to deposit.
    /// @return 0 on success, non-zero error code on failure.
    function mintBehalf(address receiver, uint256 mintAmount) external returns (uint256);

    /// @notice Burn vTokens belonging to `owner` and send underlying tokens to caller (msg.sender).
    /// @dev Requires the caller to be an approved delegate of `owner` in the Comptroller.
    /// @param owner Address whose vTokens are redeemed.
    /// @param redeemTokens Amount of vTokens to burn.
    /// @return 0 on success, non-zero error code on failure.
    function redeemBehalf(address owner, uint256 redeemTokens) external returns (uint256);

    /// @notice Returns the underlying asset address of this vToken market.
    function underlying() external view returns (address);

    /// @notice Returns the Comptroller address associated with this vToken market.
    function comptroller() external view returns (address);

    /// @notice Returns the vToken balance of `account`.
    function balanceOf(address account) external view returns (uint256);
}
