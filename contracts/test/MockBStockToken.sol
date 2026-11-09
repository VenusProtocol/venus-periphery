// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.25;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

import { IBStockToken } from "../Interfaces/IBStockToken.sol";
import { ICompliance } from "../Interfaces/ICompliance.sol";
import { IPauseManager } from "../Interfaces/IPauseManager.sol";

/**
 * @title MockBStockToken
 * @notice Testnet stand-in for a bStock: an ERC20 that is its own PauseManager and its own compliance module.
 * @dev Exposes the reads BStockPauseSentinel makes: pauseManager(), isTokenPaused(token), compliance() and
 *      checkIsCompliant(token, account). As a real bStock does, it blocks every transfer, mint and burn while paused,
 *      and any transfer whose sender, recipient or caller is blocked. Only the owner can pause it or block accounts.
 */
contract MockBStockToken is ERC20, Ownable, IBStockToken, IPauseManager, ICompliance {
    /// @notice Whether the token is paused
    bool public paused;

    /// @notice Whether the compliance module rejects an account as a party to a transfer
    mapping(address => bool) public blocked;

    /// @notice Emitted when the owner pauses or unpauses the token
    /// @param paused The new paused state
    event PausedSet(bool paused);

    /// @notice Emitted when the owner blocks or unblocks an account
    /// @param account The account
    /// @param blocked The new blocked state
    event BlockedSet(address indexed account, bool blocked);

    /// @notice Thrown on any transfer, mint or burn while the token is paused
    error TokenPaused();

    /// @notice Thrown when a blocked account is a party to a transfer, as the issuer's compliance module does
    error UserBlocked();

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

    /// @notice Blocks or unblocks an account, e.g. a vToken market to simulate a compliance block
    /// @param account The account
    /// @param blocked_ True to block, false to unblock
    function setBlocked(address account, bool blocked_) external onlyOwner {
        blocked[account] = blocked_;
        emit BlockedSet(account, blocked_);
    }

    /// @inheritdoc IBStockToken
    function pauseManager() external view returns (address) {
        return address(this);
    }

    /// @inheritdoc IBStockToken
    function compliance() external view returns (address) {
        return address(this);
    }

    /// @inheritdoc IPauseManager
    function isTokenPaused(address token) external view returns (bool) {
        return token == address(this) && paused;
    }

    /// @inheritdoc ICompliance
    function checkIsCompliant(address token, address account) public view {
        if (token == address(this) && blocked[account]) revert UserBlocked();
    }

    function _beforeTokenTransfer(address from, address to, uint256) internal view override {
        if (paused) revert TokenPaused();
        checkIsCompliant(address(this), from);
        checkIsCompliant(address(this), to);
        checkIsCompliant(address(this), msg.sender);
    }
}
