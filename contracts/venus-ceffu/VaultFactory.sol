// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";
import { AccessControlledV8 } from "@venusprotocol/governance-contracts/contracts/Governance/AccessControlledV8.sol";
import { ensureNonzeroAddress } from "@venusprotocol/solidity-utilities/contracts/validators.sol";

import { VaultFactoryStorageV1 } from "./VaultFactoryStorage.sol";
import { IFixedRateVault } from "./interfaces/IFixedRateVault.sol";
import { IVaultFactory } from "./interfaces/IVaultFactory.sol";

/**
 * @title VaultFactory
 * @author Venus Protocol
 * @notice Deploys and registers FixedRateVault instances as EIP-1167 deterministic minimal proxy clones.
 *
 * Key design decisions:
 * - EIP-1167 clones: ~45k gas per deploy vs ~500k+ for transparent proxy.
 *   Each vault is single-use with fixed params — no per-vault upgrade needed.
 * - Deterministic addressing: salt = keccak256(ceffuRequestId), so vault addresses
 *   are predictable before deployment.
 * - Implementation upgradeable at factory level only — affects future vaults,
 *   existing clones are immutable.
 */
contract VaultFactory is AccessControlledV8, VaultFactoryStorageV1, IVaultFactory {
    /// @notice disabled initializer
    constructor() {
        _disableInitializers();
    }

    /// @inheritdoc IVaultFactory
    function initialize(
        address accessControlManager_,
        address vaultImplementation_,
        address fundRouter_
    ) external initializer {
        ensureNonzeroAddress(vaultImplementation_);
        ensureNonzeroAddress(fundRouter_);

        __AccessControlled_init(accessControlManager_);

        vaultImplementation = vaultImplementation_;
        fundRouter = fundRouter_;
    }

    // ──────────────────────────────────────────────
    //  Core: Vault deployment
    // ──────────────────────────────────────────────

    /// @inheritdoc IVaultFactory
    function deployVault(
        IFixedRateVault.VaultInitParams calldata params
    ) external returns (address vault) {
        _checkAccessAllowed("deployVault(VaultInitParams)");

        // Validate ceffuRequestId is non-empty and unique
        if (bytes(params.ceffuRequestId).length == 0) {
            revert EmptyCeffuRequestId();
        }
        if (vaultByCeffuRequestId[params.ceffuRequestId] != address(0)) {
            revert DuplicateCeffuRequestId(params.ceffuRequestId);
        }

        ensureNonzeroAddress(params.supplyAsset);

        // Deploy deterministic clone — salt derived from ceffuRequestId for predictable addressing
        bytes32 salt = keccak256(abi.encodePacked(params.ceffuRequestId));
        vault = Clones.cloneDeterministic(vaultImplementation, salt);

        // Initialize the clone with factory-provided addresses + caller-provided params
        IFixedRateVault(vault).initialize(
            address(_accessControlManager),
            fundRouter,
            params
        );

        // Register vault in all lookup structures
        uint256 newVaultId = ++vaultCount;
        vaultIdByAddress[vault] = newVaultId;
        vaultByIndex[newVaultId] = vault;
        vaultByCeffuRequestId[params.ceffuRequestId] = vault;

        emit VaultDeployed(vault, params.ceffuRequestId, params.supplyAsset, newVaultId);
    }

    // ──────────────────────────────────────────────
    //  Admin: Configuration
    // ──────────────────────────────────────────────

    /// @inheritdoc IVaultFactory
    function setVaultImplementation(address newImplementation) external {
        _checkAccessAllowed("setVaultImplementation(address)");
        ensureNonzeroAddress(newImplementation);

        if (newImplementation == vaultImplementation) {
            revert ImplementationUnchanged();
        }

        address oldImplementation = vaultImplementation;
        vaultImplementation = newImplementation;

        emit VaultImplementationUpdated(oldImplementation, newImplementation);
    }

    /// @inheritdoc IVaultFactory
    function setFundRouter(address newFundRouter) external {
        _checkAccessAllowed("setFundRouter(address)");
        ensureNonzeroAddress(newFundRouter);

        if (newFundRouter == fundRouter) {
            revert FundRouterUnchanged();
        }

        address oldFundRouter = fundRouter;
        fundRouter = newFundRouter;

        emit FundRouterUpdated(oldFundRouter, newFundRouter);
    }

    // ──────────────────────────────────────────────
    //  View functions
    // ──────────────────────────────────────────────

    /// @inheritdoc IVaultFactory
    function isVault(address vault) external view returns (bool) {
        return vaultIdByAddress[vault] != 0;
    }

    /// @inheritdoc IVaultFactory
    function predictVaultAddress(string calldata ceffuRequestId_) external view returns (address) {
        bytes32 salt = keccak256(abi.encodePacked(ceffuRequestId_));
        return Clones.predictDeterministicAddress(vaultImplementation, salt);
    }
}
