// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.25;

/**
 * @title IBStockToken
 * @author Venus
 * @notice Minimal interface of a bStock token (tokenized equity) used by Venus.
 * @dev Each bStock checks its PauseManager before every transfer, and the issuer can repoint it
 *      (setPauseManager), so different bStocks may use different PauseManagers.
 */
interface IBStockToken {
    /// @notice Returns the PauseManager the token checks before every transfer
    /// @return The PauseManager address
    function pauseManager() external view returns (address);
}
