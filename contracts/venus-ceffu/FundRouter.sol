// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.25;

import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import { PausableUpgradeable } from "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import {
    SafeERC20Upgradeable,
    IERC20Upgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import { IERC4626Upgradeable } from "@openzeppelin/contracts-upgradeable/interfaces/IERC4626Upgradeable.sol";
import { AccessControlledV8 } from "@venusprotocol/governance-contracts/contracts/Governance/AccessControlledV8.sol";
import { ensureNonzeroAddress } from "@venusprotocol/solidity-utilities/contracts/validators.sol";

import { FundRouterStorageV1 } from "./FundRouterStorage.sol";
import { IFundRouter } from "./interfaces/IFundRouter.sol";
import { IVaultFactory } from "./interfaces/IVaultFactory.sol";
import { IFixedRateVault } from "./interfaces/IFixedRateVault.sol";

/**
 * @title FundRouter
 * @author Venus Protocol
 * @notice Singleton "Main Contract" that routes funds between FixedRateVaults and Ceffu.
 *
 * Fund flow:
 *   Outbound: Vault → receiveFundsFromVault() → transferToCeffu() → confirmOrderFillForVault() → Ceffu
 *   Inbound:  Ceffu sends on-chain → recordRepayment() → distributeRepaymentToVault() → Vault
 *
 * Each vault gets an isolated VaultAllocation with boolean idempotency guards
 * preventing double execution of any step in the flow.
 *
 * The two-step repayment design (record + distribute) creates a clear audit trail
 * and prevents unauthorized calls to vault.receiveRepayment().
 *
 * @custom:security-contact security@venus.io
 */
contract FundRouter is
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    AccessControlledV8,
    FundRouterStorageV1,
    IFundRouter
{
    using SafeERC20Upgradeable for IERC20Upgradeable;

    // ──────────────────────────────────────────────
    //  Initialization
    // ──────────────────────────────────────────────

    /// @notice disabled initializer
    constructor() {
        _disableInitializers();
    }

    /// @inheritdoc IFundRouter
    function initialize(address accessControlManager_, address vaultFactory_) external initializer {
        ensureNonzeroAddress(vaultFactory_);

        __ReentrancyGuard_init();
        __Pausable_init();
        __AccessControlled_init(accessControlManager_);

        vaultFactory = vaultFactory_;
    }

    // ──────────────────────────────────────────────
    //  Step 1: Receive funds from vault after fundraising closes
    // ──────────────────────────────────────────────

    /// @inheritdoc IFundRouter
    function receiveFundsFromVault(uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) {
            revert ZeroAmount();
        }

        address vault = msg.sender;

        // Verify caller is a factory-deployed vault
        if (!IVaultFactory(vaultFactory).isVault(vault)) {
            revert CallerNotRegisteredVault(vault);
        }

        // Read supply asset from vault (ERC-4626 standard function)
        address supplyAsset = IERC4626Upgradeable(vault).asset();
        if (!approvedAssets[supplyAsset]) {
            revert AssetNotApproved(supplyAsset);
        }

        VaultAllocation storage allocation = vaultAllocations[vault];
        if (allocation.fundsReceivedFromVault) {
            revert OperationAlreadyCompleted();
        }

        // Record allocation
        allocation.supplyAsset = supplyAsset;
        allocation.principalAmount = amount;
        allocation.fundsReceivedFromVault = true;

        // Pull tokens from vault (vault must have called safeIncreaseAllowance before this)
        IERC20Upgradeable(supplyAsset).safeTransferFrom(vault, address(this), amount);

        emit FundsReceivedFromVault(vault, supplyAsset, amount);
    }

    // ──────────────────────────────────────────────
    //  Step 2: Set Ceffu sub-wallet address for a vault
    // ──────────────────────────────────────────────

    /// @inheritdoc IFundRouter
    function setCeffuAddressForVault(address vault, address ceffuAddress) external {
        // solhint-disable-next-line gas-small-strings
        _checkAccessAllowed("setCeffuAddressForVault(address,address)");
        ensureNonzeroAddress(vault);
        ensureNonzeroAddress(ceffuAddress);

        VaultAllocation storage allocation = vaultAllocations[vault];
        if (!allocation.fundsReceivedFromVault) {
            revert AllocationNotFound(vault);
        }

        allocation.ceffuSubWalletAddress = ceffuAddress;

        emit CeffuAddressSet(vault, ceffuAddress);
    }

    // ──────────────────────────────────────────────
    //  Step 3: Transfer funds to Ceffu
    // ──────────────────────────────────────────────

    /// @inheritdoc IFundRouter
    function transferToCeffu(address vault) external nonReentrant whenNotPaused {
        _checkAccessAllowed("transferToCeffu(address)");

        VaultAllocation storage allocation = vaultAllocations[vault];

        if (!allocation.fundsReceivedFromVault) {
            revert PrerequisiteNotMet();
        }
        if (allocation.fundsSentToCeffu) {
            revert OperationAlreadyCompleted();
        }
        ensureNonzeroAddress(allocation.ceffuSubWalletAddress);

        allocation.fundsSentToCeffu = true;

        IERC20Upgradeable(allocation.supplyAsset).safeTransfer(
            allocation.ceffuSubWalletAddress,
            allocation.principalAmount
        );

        emit FundsTransferredToCeffu(vault, allocation.ceffuSubWalletAddress, allocation.principalAmount);
    }

    // ──────────────────────────────────────────────
    //  Step 3.5: Confirm order fill for vault
    // ──────────────────────────────────────────────

    /// @inheritdoc IFundRouter
    function confirmOrderFillForVault(address vault) external {
        // solhint-disable-next-line gas-small-strings
        _checkAccessAllowed("confirmOrderFillForVault(address)");

        VaultAllocation storage allocation = vaultAllocations[vault];

        if (!allocation.fundsSentToCeffu) {
            revert PrerequisiteNotMet();
        }
        if (allocation.orderFillConfirmed) {
            revert OperationAlreadyCompleted();
        }

        allocation.orderFillConfirmed = true;

        IFixedRateVault(vault).confirmOrderFill();

        emit OrderFillConfirmedForVault(vault);
    }

    // ──────────────────────────────────────────────
    //  Step 4: Record Ceffu repayment arrival
    // ──────────────────────────────────────────────

    /// @inheritdoc IFundRouter
    function recordRepayment(address vault, uint256 amount) external {
        _checkAccessAllowed("recordRepayment(address,uint256)");

        if (amount == 0) {
            revert ZeroAmount();
        }

        VaultAllocation storage allocation = vaultAllocations[vault];

        if (!allocation.orderFillConfirmed) {
            revert PrerequisiteNotMet();
        }
        if (allocation.repaymentReceived) {
            revert OperationAlreadyCompleted();
        }

        allocation.repaymentAmount = amount;
        allocation.repaymentReceived = true;

        emit RepaymentRecorded(vault, amount);
    }

    // ──────────────────────────────────────────────
    //  Step 5: Distribute repayment to vault
    // ──────────────────────────────────────────────

    /// @inheritdoc IFundRouter
    function distributeRepaymentToVault(address vault) external nonReentrant whenNotPaused {
        // solhint-disable-next-line gas-small-strings
        _checkAccessAllowed("distributeRepaymentToVault(address)");

        VaultAllocation storage allocation = vaultAllocations[vault];

        if (!allocation.repaymentReceived) {
            revert PrerequisiteNotMet();
        }
        if (allocation.repaymentDistributed) {
            revert OperationAlreadyCompleted();
        }

        allocation.repaymentDistributed = true;

        uint256 amount = allocation.repaymentAmount;

        // Transfer tokens to vault, then notify vault to transition to Matured state
        IERC20Upgradeable(allocation.supplyAsset).safeTransfer(vault, amount);
        IFixedRateVault(vault).receiveRepayment(amount);

        emit RepaymentDistributed(vault, amount);
    }

    // ──────────────────────────────────────────────
    //  Cancellation: Return funds and cancel vault
    // ──────────────────────────────────────────────

    /// @inheritdoc IFundRouter
    function returnFundsAndCancelVault(address vault) external nonReentrant {
        // solhint-disable-next-line gas-small-strings
        _checkAccessAllowed("returnFundsAndCancelVault(address)");

        VaultAllocation storage allocation = vaultAllocations[vault];

        if (!allocation.fundsReceivedFromVault) {
            revert AllocationNotFound(vault);
        }
        if (allocation.fundsSentToCeffu) {
            revert FundsAlreadySentToCeffu();
        }

        uint256 amount = allocation.principalAmount;

        // Clean up allocation to prevent stale operations (e.g., transferToCeffu after cancel)
        allocation.fundsReceivedFromVault = false;
        allocation.principalAmount = 0;

        // Transfer funds back to vault, then cancel atomically.
        // Funds arrive before state change, so users always redeem for actual assets.
        IERC20Upgradeable(allocation.supplyAsset).safeTransfer(vault, amount);
        IFixedRateVault(vault).cancelVault();

        emit FundsReturnedAndVaultCancelled(vault, amount);
    }

    // ──────────────────────────────────────────────
    //  Admin: Asset management
    // ──────────────────────────────────────────────

    /// @inheritdoc IFundRouter
    function setAssetApproval(address asset, bool approved) external {
        _checkAccessAllowed("setAssetApproval(address,bool)");
        ensureNonzeroAddress(asset);

        approvedAssets[asset] = approved;

        emit AssetApprovalUpdated(asset, approved);
    }

    /// @inheritdoc IFundRouter
    function sweepToken(address token, address to, uint256 amount) external nonReentrant {
        // solhint-disable-next-line gas-small-strings
        _checkAccessAllowed("sweepToken(address,address,uint256)");
        ensureNonzeroAddress(to);

        if (amount == 0) {
            revert ZeroAmount();
        }

        IERC20Upgradeable(token).safeTransfer(to, amount);

        emit TokenSwept(token, to, amount);
    }

    // ──────────────────────────────────────────────
    //  Admin: Pause
    // ──────────────────────────────────────────────

    /// @inheritdoc IFundRouter
    function pause() external {
        _checkAccessAllowed("pause()");
        _pause();
    }

    /// @inheritdoc IFundRouter
    function unpause() external {
        _checkAccessAllowed("unpause()");
        _unpause();
    }

    // ──────────────────────────────────────────────
    //  View functions
    // ──────────────────────────────────────────────

    /// @inheritdoc IFundRouter
    function getVaultAllocation(address vault) external view returns (VaultAllocation memory) {
        return vaultAllocations[vault];
    }
}
