// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.25;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

import { IBStockToken } from "../Interfaces/IBStockToken.sol";
import { IPauseManager } from "../Interfaces/IPauseManager.sol";

/**
 * @title MockBStockToken
 * @notice Testnet stand-in for a bStock: an ERC20 that is its own PauseManager.
 * @dev Exposes the two reads BStockPauseSentinel makes, pauseManager() and isTokenPaused(token), and blocks
 *      every transfer, mint and burn while paused, as a real bStock does. Only the owner can pause it.
 */
contract MockBStockToken is ERC20, Ownable, IBStockToken, IPauseManager {
    /// @notice Whether the token is paused
    bool public paused;

    /// @notice Emitted when the owner pauses or unpauses the token
    /// @param paused The new paused state
    event PausedSet(bool paused);

    /// @notice Thrown on any transfer, mint or burn while the token is paused
    error TokenPaused();

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    /// @notice Mints `amount` tokens to the caller
    /// @param amount The amount to mint
    function faucet(uint256 amount) external {
        _mint(msg.sender, amount);
    }

    /// @notice Pauses or unpauses the token
    /// @param paused_ True to pause, false to unpause
    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    /// @inheritdoc IBStockToken
    function pauseManager() external view returns (address) {
        return address(this);
    }

    /// @inheritdoc IPauseManager
    function isTokenPaused(address token) external view returns (bool) {
        return token == address(this) && paused;
    }

    function _beforeTokenTransfer(address, address, uint256) internal view override {
        if (paused) revert TokenPaused();
    }
}
