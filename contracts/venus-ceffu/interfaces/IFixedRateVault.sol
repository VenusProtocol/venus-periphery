// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

/**
 * @title IFixedRateVault
 * @author Venus Protocol
 * @notice Interface for the FixedRateVault contract — an ERC-4626 tokenized vault
 *         for fixed-rate lending to Ceffu institutional clients.
 *
 * Lifecycle state machine:
 *   Fundraising -> PendingFill -> Locked -> Matured
 *        |
 *    Cancelled
 */
interface IFixedRateVault {
    // ──────────────────────────────────────────────
    //  Enums
    // ──────────────────────────────────────────────

    /// @notice Lifecycle states of a fixed-rate vault
    enum VaultState {
        Fundraising, // 0 - accepting user deposits
        PendingFill, // 1 - funds sent to Ceffu, awaiting order fill confirmation
        Locked, //      2 - order filled, interest accruing, awaiting repayment
        Matured, //     3 - repayment received, users can withdraw
        Cancelled //    4 - fundraising failed or admin-cancelled, users can refund
    }

    // ──────────────────────────────────────────────
    //  Structs
    // ──────────────────────────────────────────────

    /**
     * @notice Parameters required to initialize a FixedRateVault clone.
     *         Used by VaultFactory.deployVault() and forwarded to vault.initialize().
     */
    struct VaultInitParams {
        /// @notice The ERC-20 stablecoin accepted for deposits (e.g., USDC, USDT)
        address supplyAsset;
        /// @notice ERC-20 name for the vault share token (e.g., "Venus Fixed Rate USDC #001")
        string name;
        /// @notice ERC-20 symbol for the vault share token (e.g., "vfrUSDC-001")
        string symbol;
        /// @notice Ceffu request ID for 1:1 mapping and reconciliation (e.g., "CR-0001")
        string ceffuRequestId;
        /// @notice Fixed APY in basis points (e.g., 500 = 5.00%)
        uint256 fixedAPY;
        /// @notice Minimum fundraising cap in asset decimals
        uint256 minCap;
        /// @notice Maximum fundraising cap in asset decimals
        uint256 maxCap;
        /// @notice Timestamp when the fundraising window opens
        uint256 fundraisingStartTime;
        /// @notice Timestamp when the fundraising window closes
        uint256 fundraisingEndTime;
        /// @notice Lock period duration in seconds (e.g., 2_592_000 for 30 days)
        uint256 lockPeriodDuration;
        /// @notice Protocol reserve factor in basis points (e.g., 1000 = 10%)
        uint256 reserveFactorBps;
        /// @notice Minimum deposit per user in asset decimals (0 = no minimum)
        uint256 minUserDeposit;
        /// @notice Maximum deposit per user in asset decimals (0 = no maximum)
        uint256 maxUserDeposit;
        /// @notice Grace period in seconds after lock period before emergency unlock
        uint256 gracePeriod;
    }

    // ──────────────────────────────────────────────
    //  Events
    // ──────────────────────────────────────────────

    /// @notice Emitted when fundraising closes successfully and funds are transferred to FundRouter
    /// @param totalPrincipal Total assets raised during fundraising (asset decimals)
    event FundraisingClosed(uint256 indexed totalPrincipal);

    /// @notice Emitted when the vault is cancelled (below minCap or admin force-cancel)
    event VaultCancelled();

    /// @notice Emitted when Ceffu repayment is received via FundRouter
    /// @param totalRepayment Total repayment amount (principal + interest, asset decimals)
    /// @param protocolReserve Venus protocol's share of interest (asset decimals)
    /// @param userNetReturn Net amount available for user withdrawals (asset decimals)
    event RepaymentReceived(uint256 indexed totalRepayment, uint256 indexed protocolReserve, uint256 indexed userNetReturn);

    /// @notice Emitted when protocol reserves are withdrawn to treasury
    /// @param recipient Address that received the reserves
    /// @param amount Reserve amount transferred (asset decimals)
    event ReservesWithdrawn(address indexed recipient, uint256 indexed amount);

    /// @notice Emitted when governance triggers emergency unlock after grace period
    /// @param availableBalance Actual vault token balance at time of emergency unlock
    event EmergencyUnlocked(uint256 indexed availableBalance);

    /// @notice Emitted when Ceffu confirms the order fill, transitioning PendingFill -> Locked
    /// @param lockStartAt Timestamp when interest accrual begins (set at fill confirmation)
    /// @param lockPeriodEndTime Timestamp when the lock period ends
    event OrderFillConfirmed(uint256 lockStartAt, uint256 lockPeriodEndTime);

    // ──────────────────────────────────────────────
    //  Custom errors
    // ──────────────────────────────────────────────

    /// @notice Thrown when an operation is called in the wrong vault state
    /// @param current The vault's current state
    /// @param required The state required for the operation
    error InvalidState(VaultState current, VaultState required);

    /// @notice Thrown when fundraising window has not opened yet
    error FundraisingNotStarted();

    /// @notice Thrown when fundraising window has expired (for deposits)
    error FundraisingEnded();

    /// @notice Thrown when deposit would put user below minimum deposit threshold
    /// @param deposited User's cumulative deposit amount after this deposit
    /// @param minimum Required minimum deposit amount
    error BelowMinUserDeposit(uint256 deposited, uint256 minimum);

    /// @notice Thrown when caller is not the FundRouter
    error OnlyFundRouter();

    /// @notice Thrown when reserves have already been withdrawn
    error ReservesAlreadyWithdrawn();

    /// @notice Thrown when there are no reserves to withdraw
    error NoReservesToWithdraw();

    /// @notice Thrown when the grace period has not expired yet for emergency unlock
    error GracePeriodNotExpired();

    /// @notice Thrown when an initialization parameter is invalid
    /// @param param Name of the invalid parameter
    error InvalidInitParam(string param);

    // ──────────────────────────────────────────────
    //  Initialization
    // ──────────────────────────────────────────────

    /**
     * @notice Initializes a vault clone. Called once by VaultFactory during deployment.
     * @param accessControlManager_ Venus AccessControlManager address
     * @param fundRouter_ FundRouter singleton address
     * @param params Vault configuration parameters
     */
    function initialize(
        address accessControlManager_,
        address fundRouter_,
        VaultInitParams calldata params
    ) external;

    // ──────────────────────────────────────────────
    //  Lifecycle functions
    // ──────────────────────────────────────────────

    /**
     * @notice Closes the fundraising period.
     *         If totalPrincipal >= minCap, transitions to PendingFill and sends funds to FundRouter.
     *         If totalPrincipal < minCap, transitions to Cancelled for user refunds.
     */
    function closeFundraising() external;

    /**
     * @notice Admin force-cancel during Fundraising or PendingFill.
     *         Users can withdraw full refunds once funds are returned to the vault.
     */
    function cancelVault() external;

    /**
     * @notice Called by FundRouter after Ceffu confirms the order fill.
     *         Transitions vault from PendingFill to Locked, sets lockStartAt and lockPeriodEndTime.
     *         Interest accrual starts from this point.
     */
    function confirmOrderFill() external;

    /**
     * @notice Called by FundRouter after transferring Ceffu's repayment to this vault.
     *         Calculates protocol reserve and transitions to Matured state.
     * @param amount Total repayment received (principal + interest, in asset decimals)
     */
    function receiveRepayment(uint256 amount) external;

    /**
     * @notice Withdraws protocol reserves (Venus's share of interest) to a recipient.
     *         Can only be called once.
     * @param recipient Address to receive the reserve (typically Venus treasury)
     */
    function withdrawReserves(address recipient) external;

    /**
     * @notice Emergency unlock for Ceffu default scenario.
     *         Available only after lockPeriodEndTime + gracePeriod has passed.
     *         Transitions to Matured with whatever balance the vault currently holds.
     */
    function emergencyUnlock() external;

    // ──────────────────────────────────────────────
    //  Admin functions
    // ──────────────────────────────────────────────

    /// @notice Pauses deposits and closeFundraising. Withdrawals in terminal states are NOT affected.
    function pause() external;

    /// @notice Unpauses the vault.
    function unpause() external;

    // ──────────────────────────────────────────────
    //  View functions
    // ──────────────────────────────────────────────

    /**
     * @notice Calculates the expected gross interest for a given principal amount.
     * @param principal Amount of principal to calculate interest for (asset decimals)
     * @return grossInterest Expected gross interest before protocol reserve (asset decimals)
     */
    function calculateExpectedInterest(uint256 principal) external view returns (uint256);

    /**
     * @notice Returns all vault initialization parameters in a single call.
     * @return params The vault's full configuration as a VaultInitParams struct
     */
    function getVaultConfig() external view returns (VaultInitParams memory params);
}
