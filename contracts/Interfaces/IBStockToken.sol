// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.25;

/**
 * @title IBStockToken
 * @author Venus
 * @notice Minimal interface of a bStock token (tokenized equity) used by Venus.
 * @dev Each bStock checks its PauseManager before every transfer, and the issuer can repoint it
 *      (setPauseManager), so different bStocks may use different PauseManagers.
 *      It also checks every party to a transfer against its compliance module, which the issuer can repoint
 *      (setCompliance) too.
 */
interface IBStockToken {
    /// @notice Returns the PauseManager the token checks before every transfer
    /// @return The PauseManager address
    function pauseManager() external view returns (address);

    /// @notice Returns the compliance module the token checks every party to a transfer against
    /// @return The compliance module address
    function compliance() external view returns (address);
}
