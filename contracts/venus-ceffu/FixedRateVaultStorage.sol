// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.25;

import { IFixedRateVault } from "./interfaces/IFixedRateVault.sol";

/* solhint-disable max-states-count */

/**
 * @title FixedRateVaultStorageV1
 * @author Venus Protocol
 * @notice Storage layout for the FixedRateVault contract.
 */
abstract contract FixedRateVaultStorageV1 {
    // ──────────────────────────────────────────────
    //  Slot 1 (packed: 1 + 20 + 1 = 22 bytes)
    // ──────────────────────────────────────────────

    /// @notice Current lifecycle state of the vault
    IFixedRateVault.VaultState public state;

    /// @notice Address of the FundRouter contract that handles fund transfers to/from Ceffu
    address public fundRouter;

    /// @notice Whether the protocol reserves have been withdrawn via withdrawReserves()
    bool public reservesWithdrawn;

    // ──────────────────────────────────────────────
    //  Vault configuration (set once during initialize, immutable after)
    // ──────────────────────────────────────────────

    /// @notice Fixed APY in basis points (e.g., 500 = 5.00%, 800 = 8.00%)
    uint256 public fixedAPY;

    /// @notice Minimum fundraising cap in asset decimals. Below this, vault is cancelled.
    uint256 public minCap;

    /// @notice Maximum fundraising cap in asset decimals. Deposits are rejected above this.
    uint256 public maxCap;

    /// @notice Timestamp when the fundraising window opens
    uint256 public fundraisingStartTime;

    /// @notice Timestamp when the fundraising window closes
    uint256 public fundraisingEndTime;

    /// @notice Duration of the lock period in seconds (e.g., 30 days = 2_592_000)
    uint256 public lockPeriodDuration;

    /// @notice Timestamp when the lock period ends. Set when order fill is confirmed.
    ///         Calculated as: lockStartAt + lockPeriodDuration.
    uint256 public lockPeriodEndTime;

    /// @notice Timestamp when interest accrual starts. Set when Ceffu confirms the order fill
    ///         via confirmOrderFill(). Used to compute lockPeriodEndTime = lockStartAt + lockPeriodDuration.
    uint256 public lockStartAt;

    /// @notice Protocol reserve factor in basis points (e.g., 1000 = 10%)
    uint256 public reserveFactorBps;

    /// @notice Minimum deposit amount per user in asset decimals (0 = no minimum)
    uint256 public minUserDeposit;

    /// @notice Maximum deposit amount per user in asset decimals (0 = no maximum)
    uint256 public maxUserDeposit;

    // ──────────────────────────────────────────────
    //  Runtime state (updated during lifecycle)
    // ──────────────────────────────────────────────

    /// @notice Total principal deposited by all users during fundraising (asset decimals)
    uint256 public totalPrincipal;

    /// @notice Total repayment received from Ceffu via FundRouter (principal + interest, asset decimals).
    ///         May be less than expected in a partial repayment / default scenario.
    uint256 public totalRepayment;

    /// @notice Protocol's share of the gross interest, calculated during receiveRepayment().
    ///         Formula: grossInterest * reserveFactorBps / 10000
    ///         Set to 0 if totalRepayment <= totalPrincipal (loss scenario).
    uint256 public protocolReserve;

    /// @notice Grace period in seconds after lockPeriodEndTime before emergencyUnlock() becomes available.
    ///         Gives Ceffu time to settle before governance can force-unlock.
    uint256 public gracePeriod;

    // ──────────────────────────────────────────────
    //  Mappings and dynamic types
    // ──────────────────────────────────────────────

    /// @notice Tracks cumulative deposit amount per user address (asset decimals).
    ///         Used to enforce minUserDeposit and maxUserDeposit limits.
    mapping(address => uint256) public userDeposits;

    /// @notice Ceffu request ID for off-chain reconciliation (format: "CR-XXXX")
    string public ceffuRequestId;

    /// @dev Reserved storage gap for future upgrades.
    ///      Slots used: 18 (1 packed + 15 uint256 + 1 mapping + 1 string). Gap: 32.
    ///      Note: VaultInitParams is a calldata-only struct; it occupies no storage slots.
    uint256[32] private __gap;
}
