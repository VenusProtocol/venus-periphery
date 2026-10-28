// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.25;

/**
 * @title ICompliance
 * @author Venus
 * @notice Minimal interface of the bStock issuer's compliance module (BSC: 0x53dBa7AaBDe774787A1F57236B235567dA8e14F4).
 *         A bStock runs checkIsCompliant on every party to a transfer, so a sanctioned or blocklisted address can
 *         neither send nor receive the token.
 */
interface ICompliance {
    /// @notice Reverts if an account may not be a party to a transfer of a token
    /// @dev Reverts with UserSanctioned() for a sanctioned account and UserBlocked() for one blocklisted for the token
    /// @param token The token being transferred
    /// @param account The account to check
    function checkIsCompliant(address token, address account) external view;
}
