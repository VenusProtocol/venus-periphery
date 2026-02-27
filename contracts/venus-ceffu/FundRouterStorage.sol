// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

import { IFundRouter } from "./interfaces/IFundRouter.sol";

/**
 * @title FundRouterStorageV1
 * @author Venus Protocol
 * @notice Storage layout for the FundRouter contract.
 */
abstract contract FundRouterStorageV1 {
    /// @notice Address of the VaultFactory contract. Used to verify that a caller is a
    ///         factory-deployed vault via IVaultFactory(vaultFactory).isVault().
    address public vaultFactory;

    /// @notice Whitelist of approved supply assets (e.g., USDC, USDT).
    ///         Only vaults with an approved asset can use this router.
    mapping(address => bool) public approvedAssets;

    /// @notice Per-vault allocation tracking. Key: vault contract address.
    mapping(address => IFundRouter.VaultAllocation) public vaultAllocations;

    /// @dev Reserved storage gap for future upgrades.
    ///      Slots used: 3 (1 address + 2 mappings). Gap: 47.
    uint256[47] private __gap;
}
