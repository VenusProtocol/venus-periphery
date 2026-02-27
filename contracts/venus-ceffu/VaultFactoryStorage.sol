// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

/**
 * @title VaultFactoryStorageV1
 * @author Venus Protocol
 * @notice Storage layout for the VaultFactory contract.
 */
abstract contract VaultFactoryStorageV1 {

    /// @notice Address of the FixedRateVault logic contract used as the  implementation
    address public vaultImplementation;

    /// @notice Address of the FundRouter singleton. Passed to each vault during initialization.
    address public fundRouter;

    /// @notice Total number of vaults deployed. Also serves as the ID counter.
    ///         Vault IDs start at 1. ID 0 means "not found" in lookups.
    uint256 public vaultCount;

    /// @notice vault address → vault ID mapping.
    mapping(address => uint256) public vaultIdByAddress;

    /// @notice Sequential vault ID → vault address mapping. Used for enumeration and indexing.
    mapping(uint256 => address) public vaultByIndex;

    /// @notice ceffuRequestId → vault address mapping
    mapping(string => address) public vaultByCeffuRequestId;

    /// @dev Reserved storage gap for future upgrades.
    ///      Slots used: 6 (2 addresses + 3 mappings + 1 uint256). Gap: 44.
    uint256[44] private __gap;
}
