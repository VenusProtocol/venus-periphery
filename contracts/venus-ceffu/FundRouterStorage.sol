// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.25;

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
    mapping(address => bool) internal _approvedAssets;

    /// @notice Per-vault allocation tracking. Key: vault contract address.
    mapping(address => IFundRouter.VaultAllocation) public vaultAllocations;

    /// @notice Total tokens committed (reserved) per asset across all active vault allocations.
    ///         Tracks principal held for vaults + recorded-but-undistributed repayments.
    ///         Prevents cross-vault contamination by ensuring recordRepayment() cannot
    ///         over-commit tokens that belong to other vaults.
    mapping(address => uint256) public totalCommittedPerAsset;

    /// @dev Reserved storage gap for future upgrades.
    ///      Slots used: 4 (1 address + 3 mappings). Gap: 46.
    uint256[46] private __gap;
}
