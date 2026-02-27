// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

/**
 * @title IFundRouter
 * @author Venus Protocol
 * @notice Interface for the FundRouter contract — singleton that routes funds
 *         between FixedRateVaults and Ceffu.
 *
 * Fund flow:
 *   Outbound: Vault → receiveFundsFromVault() → transferToCeffu() → confirmOrderFillForVault() → Ceffu sub-wallet
 *   Inbound:  Ceffu sends on-chain → recordRepayment() → distributeRepaymentToVault() → Vault
 *
 * @custom:security-contact security@venus.io
 */
interface IFundRouter {
    // ──────────────────────────────────────────────
    //  Structs
    // ──────────────────────────────────────────────

    /**
     * @notice Per-vault fund allocation and lifecycle tracking.
     *
     * Struct packing (4 slots):
     *   Slot 1: supplyAsset (20B) + 5 bools (5B) = 25 bytes
     *   Slot 2: ceffuSubWalletAddress (20B)
     *   Slot 3: principalAmount (32B)
     *   Slot 4: repaymentAmount (32B)
     *
     * The vault address is NOT stored here — it is the mapping key in vaultAllocations.
     */
    struct VaultAllocation {
        /// @notice The ERC-20 stablecoin used by this vault (e.g., USDC, USDT).
        ///         Set when receiveFundsFromVault() is called, read from vault.asset().
        address supplyAsset;
        /// @notice True after vault has transferred fundraised principal to this router
        bool fundsReceivedFromVault;
        /// @notice True after router has transferred funds to the Ceffu sub-wallet address
        bool fundsSentToCeffu;
        /// @notice True after Ceffu order fill has been confirmed for this vault
        bool orderFillConfirmed;
        /// @notice True after backend has recorded Ceffu's on-chain repayment arrival
        bool repaymentReceived;
        /// @notice True after router has pushed repayment to the vault
        bool repaymentDistributed;
        /// @notice The Ceffu sub-wallet deposit address assigned to this vault.
        ///         Set by backend via setCeffuAddressForVault() after slot assignment.
        address ceffuSubWalletAddress;
        /// @notice Fundraised principal amount received from the vault (asset decimals)
        uint256 principalAmount;
        /// @notice Repayment amount received from Ceffu (principal + interest, asset decimals).
        ///         May be less than expected in a default scenario.
        uint256 repaymentAmount;
    }

    // ──────────────────────────────────────────────
    //  Events
    // ──────────────────────────────────────────────

    /// @notice Emitted when a vault transfers fundraised funds to this router
    /// @param vault Address of the vault sending funds
    /// @param asset Address of the supply asset being transferred
    /// @param amount Amount of the asset transferred (asset decimals)
    event FundsReceivedFromVault(address indexed vault, address indexed asset, uint256 indexed amount);

    /// @notice Emitted when the Ceffu sub-wallet address is set for a vault
    /// @param vault Address of the vault
    /// @param ceffuAddress Address of the assigned Ceffu sub-wallet for this vault
    event CeffuAddressSet(address indexed vault, address indexed ceffuAddress);

    /// @notice Emitted when funds are transferred from this router to a Ceffu sub-wallet
    /// @param vault Address of the vault
    /// @param ceffuAddress Address of the Ceffu sub-wallet receiving funds
    /// @param amount Amount of the asset transferred (asset decimals)
    event FundsTransferredToCeffu(address indexed vault, address indexed ceffuAddress, uint256 indexed amount);

    /// @notice Emitted when the Ceffu order fill is confirmed for a vault
    /// @param vault Address of the vault
    event OrderFillConfirmedForVault(address indexed vault);

    /// @notice Emitted when a Ceffu repayment is recorded by the backend
    /// @param vault Address of the vault
    /// @param amount Amount of the repayment recorded (asset decimals)
    event RepaymentRecorded(address indexed vault, uint256 indexed amount);

    /// @notice Emitted when recorded repayment is pushed to the vault
    /// @param vault Address of the vault
    /// @param amount Amount of the repayment distributed (asset decimals)
    event RepaymentDistributed(address indexed vault, uint256 indexed amount);

    /// @notice Emitted when an asset's approval status is changed
    /// @param asset Address of the asset
    /// @param approved Whether the asset is now approved (true) or not (false)
    event AssetApprovalUpdated(address indexed asset, bool indexed approved);

    /// @notice Emitted when stuck tokens are swept out by admin
    /// @param token Address of the token swept
    /// @param to Recipient address of the swept tokens
    /// @param amount Amount of the tokens swept (token decimals)
    event TokenSwept(address indexed token, address indexed to, uint256 indexed amount);

    // ──────────────────────────────────────────────
    //  Custom errors
    // ──────────────────────────────────────────────

    /// @notice Thrown when caller is not a factory-registered vault
    /// @param caller Address of the unauthorized caller
    error CallerNotRegisteredVault(address caller);

    /// @notice Thrown when the vault's supply asset is not in the approved whitelist
    /// @param asset Address of the unapproved asset
    error AssetNotApproved(address asset);

    /// @notice Thrown when attempting an operation that has already been completed (idempotency guard)
    error OperationAlreadyCompleted();

    /// @notice Thrown when a prerequisite step has not been completed yet
    error PrerequisiteNotMet();

    /// @notice Thrown when the amount is zero
    error ZeroAmount();

    /// @notice Thrown when no allocation exists for the given vault
    /// @param vault Address of the vault with missing allocation
    error AllocationNotFound(address vault);

    // ──────────────────────────────────────────────
    //  Initialization
    // ──────────────────────────────────────────────

    /**
     * @notice Initializes the FundRouter proxy.
     * @param accessControlManager_ Address of the Venus AccessControlManager
     * @param vaultFactory_ Address of the VaultFactory contract
     */
    function initialize(address accessControlManager_, address vaultFactory_) external;

    // ──────────────────────────────────────────────
    //  Step 1: Receive funds from vault
    // ──────────────────────────────────────────────

    /**
     * @notice Called by a vault to transfer fundraised principal to this router.
     *         The vault must have approved this router for `amount` tokens before calling.
     *
     *         Reads the supply asset from vault.asset() (standard ERC-4626 function) and
     *         verifies it is in the approved assets whitelist.
     *
     * @param amount Amount of supply asset to pull from the vault (asset decimals)
     */
    function receiveFundsFromVault(uint256 amount) external;

    // ──────────────────────────────────────────────
    //  Step 2: Set Ceffu sub-wallet address
    // ──────────────────────────────────────────────

    /**
     * @notice Sets the Ceffu sub-wallet deposit address for a specific vault.
     *         Called by the backend after Ceffu slot assignment.
     *
     * @param vault Address of the vault
     * @param ceffuAddress Address of the Ceffu sub-wallet for this vault
     */
    function setCeffuAddressForVault(address vault, address ceffuAddress) external;

    // ──────────────────────────────────────────────
    //  Step 3: Transfer funds to Ceffu
    // ──────────────────────────────────────────────

    /**
     * @notice Transfers the vault's fundraised funds to the assigned Ceffu sub-wallet address.
     *
     * Prerequisites:
     * - fundsReceivedFromVault must be true
     * - ceffuSubWalletAddress must be set
     * - fundsSentToCeffu must be false (idempotency)
     *
     * @param vault Address of the vault whose funds to transfer
     */
    function transferToCeffu(address vault) external;

    // ──────────────────────────────────────────────
    //  Step 3.5: Confirm order fill
    // ──────────────────────────────────────────────

    /**
     * @notice Confirms the Ceffu order fill for a vault, transitioning it from PendingFill to Locked.
     *         Called by backend after Ceffu confirms the order has been filled.
     *
     * Prerequisites:
     * - fundsSentToCeffu must be true
     * - orderFillConfirmed must be false (idempotency)
     *
     * @param vault Address of the vault whose order fill to confirm
     */
    function confirmOrderFillForVault(address vault) external;

    // ──────────────────────────────────────────────
    //  Step 4: Record Ceffu repayment
    // ──────────────────────────────────────────────

    /**
     * @notice Records that Ceffu has sent repayment on-chain to this router.
     *         Called by the backend after detecting the token arrival (off-chain monitoring).
     *
     *         The two-step pattern (record + distribute) creates an audit trail and allows
     *         the backend to validate the repayment amount before pushing to the vault.
     *
     * Prerequisites:
     * - orderFillConfirmed must be true
     * - repaymentReceived must be false (idempotency)
     *
     * @param vault Address of the vault this repayment belongs to
     * @param amount Repayment amount received (principal + interest, asset decimals).
     *               May be less than expected in a Ceffu default scenario.
     */
    function recordRepayment(address vault, uint256 amount) external;

    // ──────────────────────────────────────────────
    //  Step 5: Distribute repayment to vault
    // ──────────────────────────────────────────────

    /**
     * @notice Pushes the recorded repayment to the vault.
     *         Transfers tokens to the vault and calls vault.receiveRepayment() to transition
     *         the vault to Matured state.
     *
     * Prerequisites:
     * - repaymentReceived must be true
     * - repaymentDistributed must be false (idempotency)
     *
     * @param vault Address of the vault to distribute repayment to
     */
    function distributeRepaymentToVault(address vault) external;

    // ──────────────────────────────────────────────
    //  Admin: Asset management
    // ──────────────────────────────────────────────

    /**
     * @notice Adds or removes an asset from the approved whitelist.
     *         Only vaults with approved supply assets can use this router.
     *
     * @param asset Address of the ERC-20 token (e.g., USDC, USDT)
     * @param approved Whether the asset should be approved (true) or removed (false)
     */
    function setAssetApproval(address asset, bool approved) external;

    /**
     * @notice Emergency recovery of tokens accidentally sent to this contract.
     *         Governance-controlled to prevent misuse.
     *
     * @param token Address of the ERC-20 token to sweep
     * @param to Recipient address
     * @param amount Amount to sweep (asset decimals)
     */
    function sweepToken(address token, address to, uint256 amount) external;

    // ──────────────────────────────────────────────
    //  Admin: Pause
    // ──────────────────────────────────────────────

    /// @notice Pauses all non-emergency operations on this router.
    function pause() external;

    /// @notice Unpauses the router, re-enabling all operations.
    function unpause() external;

    // ──────────────────────────────────────────────
    //  View functions
    // ──────────────────────────────────────────────

    /**
     * @notice Returns the full allocation details for a vault.
     * @param vault Address of the vault
     * @return The VaultAllocation struct with all lifecycle tracking data
     */
    function getVaultAllocation(address vault) external view returns (VaultAllocation memory);
}
