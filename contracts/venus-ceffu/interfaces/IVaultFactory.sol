// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.25;

import { IFixedRateVault } from "./IFixedRateVault.sol";

/**
 * @title IVaultFactory
 * @author Venus Protocol
 * @notice Interface for the VaultFactory contract that deploys and registers FixedRateVault
 *         instances as EIP-1167 deterministic minimal proxy clones.
 *
 * @custom:security-contact security@venus.io
 */
interface IVaultFactory {
    // ──────────────────────────────────────────────
    //  Events
    // ──────────────────────────────────────────────

    /// @notice Emitted when a new vault is deployed
    /// @param vault Address of the newly deployed vault clone
    /// @param ceffuRequestId Ceffu request ID used as the deterministic salt source
    /// @param supplyAsset Address of the vault's underlying ERC-20 asset
    /// @param vaultId Sequential vault ID assigned by the factory (starts at 1)
    event VaultDeployed(
        address indexed vault,
        string indexed ceffuRequestId,
        address indexed supplyAsset,
        uint256 vaultId
    );

    /// @notice Emitted when the vault implementation address is updated
    /// @param oldImplementation Previous implementation address
    /// @param newImplementation New implementation address
    event VaultImplementationUpdated(address indexed oldImplementation, address indexed newImplementation);

    /// @notice Emitted when the fund router address is updated
    /// @param oldFundRouter Previous FundRouter address
    /// @param newFundRouter New FundRouter address
    event FundRouterUpdated(address indexed oldFundRouter, address indexed newFundRouter);

    // ──────────────────────────────────────────────
    //  Custom errors
    // ──────────────────────────────────────────────

    /// @notice Thrown when a ceffuRequestId has already been used for a vault deployment
    /// @param ceffuRequestId The duplicate Ceffu request ID
    error DuplicateCeffuRequestId(string ceffuRequestId);

    /// @notice Thrown when the ceffuRequestId string is empty
    error EmptyCeffuRequestId();

    /// @notice Thrown when the new implementation address is the same as the current one
    error ImplementationUnchanged();

    /// @notice Thrown when the new fund router address is the same as the current one
    error FundRouterUnchanged();

    /// @notice Thrown when the vault's supply asset is not approved on FundRouter
    /// @param asset Address of the unapproved asset
    error AssetNotApproved(address asset);

    // ──────────────────────────────────────────────
    //  Initialization
    // ──────────────────────────────────────────────

    /**
     * @notice Initializes the VaultFactory proxy.
     * @param accessControlManager_ Address of the Venus AccessControlManager
     * @param vaultImplementation_ Address of the FixedRateVault logic contract for cloning
     * @param fundRouter_ Address of the FundRouter singleton
     */
    function initialize(address accessControlManager_, address vaultImplementation_, address fundRouter_) external;

    // ──────────────────────────────────────────────
    //  Core: Vault deployment
    // ──────────────────────────────────────────────

    /**
     * @notice Deploys a new FixedRateVault as a deterministic EIP-1167 clone.
     * @param params Vault initialization parameters (see VaultInitParams struct)
     * @return vault Address of the newly deployed vault
     */
    function deployVault(IFixedRateVault.VaultInitParams calldata params) external returns (address vault);

    // ──────────────────────────────────────────────
    //  Admin: Configuration
    // ──────────────────────────────────────────────

    /**
     * @notice Updates the vault implementation used for future clone deployments.
     *         Existing vaults are unaffected.
     * @param newImplementation Address of the new FixedRateVault logic contract
     */
    function setVaultImplementation(address newImplementation) external;

    /**
     * @notice Updates the FundRouter address used for future vault deployments.
     *         Existing vaults retain their original fundRouter reference.
     * @param newFundRouter Address of the new FundRouter contract
     */
    function setFundRouter(address newFundRouter) external;

    // ──────────────────────────────────────────────
    //  View functions
    // ──────────────────────────────────────────────

    /**
     * @notice Returns whether an address is a factory-deployed vault.
     * @param vault Address to check
     * @return True if the address is a registered vault
     */
    function isVault(address vault) external view returns (bool);

    /**
     * @notice Predicts the address of a vault before deployment using the deterministic clone formula.
     * @dev The predicted address depends on the current vaultImplementation.
     *      If setVaultImplementation() is called between prediction and deployment,
     *      the actual deployed address will differ.
     * @param ceffuRequestId_ The Ceffu request ID that will be used as the salt source
     * @return The address the vault will be deployed to
     */
    function predictVaultAddress(string calldata ceffuRequestId_) external view returns (address);
}
