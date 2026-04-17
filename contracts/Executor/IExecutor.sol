// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.25;

/**
 * @title IExecutor
 * @author Venus Protocol
 * @notice Interface for the Executor contract — the signal-driven condition handler for E-brake.
 *
 * @dev The Executor sits between external signal monitors (e.g. Hypernative) and the EBrake contract.
 *      It validates conditions on-chain, enforces bounds, and routes validated tightening actions
 *      to EBrake for execution. The Executor is tighten-only: LTV and caps can only be decreased,
 *      never increased. Recovery is always via governance VIP.
 *
 *      Example Flow: Hypernative/off-chain → Executor (validate) → EBrake (execute) → Comptroller
 *
 *      The Executor uses ACM (AccessControlManager) for all function access control. Hypernative or Keepers
 *      are granted ACM access to the handler functions (handleLTVAdjust, handleCapAdjust, handleSupplyHalt, handleBorrowHalt).
 *      Governance is granted ACM access to admin functions (setMarketConfig).
 *
 *      Safety model:
 *        - LTV adjustments are tighten-only (decrease only), enforced by EBrake
 *        - Cap adjustments are bounded below by [minCap], tighten-only enforced by EBrake
 *        - All adjustments are tighten-only (decreases only) — recovery via governance VIP
 *        - Supply and borrow halts are one-way (pause only) — recovery via governance VIP
 *        - Worst case if compromised: temporary freeze — parameters restored by governance
 */
interface IExecutor {
    // ═══════════════════════════════════════════════════════════════════════
    //                              ENUMS
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Identifies which cap is being adjusted in handleCapAdjust.
    /// @dev Wire values are load-bearing: off-chain callers encode BORROW=0, SUPPLY=1
    ///      in the uint8 ABI slot. Do not reorder.
    enum CapType {
        BORROW, // = 0
        SUPPLY // = 1
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              STRUCTS
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Per-market configuration for automated risk parameter adjustments.
    /// @param minBorrowCap Floor for borrow cap adjustments. Cap cannot be set below this value.
    /// @param minSupplyCap Floor for supply cap adjustments. Cap cannot be set below this value.
    /// @param enabled Whether automated adjustment is active for this market.
    struct MarketConfig {
        uint256 minBorrowCap;
        uint256 minSupplyCap;
        bool enabled;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              EVENTS
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Emitted when a market's configuration is set or updated.
    /// @param market The vToken market address.
    /// @param config The new market configuration.
    event MarketConfigSet(address indexed market, MarketConfig config);

    /// @notice Emitted when the collateral factor (LTV) is adjusted via handleLTVAdjust.
    /// @param caller The address that triggered the adjustment.
    /// @param market The vToken market address.
    /// @param newLTV The new collateral factor mantissa.
    event LTVAdjusted(address indexed caller, address indexed market, uint256 newLTV);

    /// @notice Emitted when a borrow or supply cap is adjusted.
    /// @param caller The address that triggered the adjustment.
    /// @param market The vToken market address.
    /// @param capType Whether the borrow cap or supply cap was adjusted.
    /// @param oldCap The previous cap value.
    /// @param newCap The new cap value.
    event CapAdjusted(address indexed caller, address indexed market, CapType capType, uint256 oldCap, uint256 newCap);

    /// @notice Emitted when supply is halted via handleSupplyHalt (supply paused + CF zeroed).
    /// @param caller The address that triggered the halt.
    /// @param market The vToken market address.
    event SupplyHalted(address indexed caller, address indexed market);

    /// @notice Emitted when borrow is halted via handleBorrowHalt.
    /// @param caller The address that triggered the halt.
    /// @param market The vToken market address.
    event BorrowHalted(address indexed caller, address indexed market);

    // ═══════════════════════════════════════════════════════════════════════
    //                              ERRORS
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Thrown when the market has never been registered via setMarketConfig.
    /// @param market The market address.
    error MarketNotConfigured(address market);

    /// @notice Thrown when the market configuration is disabled.
    /// @param market The market address.
    error MarketDisabled(address market);

    /// @notice Thrown when the adjusted cap is below the configured minimum.
    /// @param adjustedCap The requested cap value.
    /// @param minCap The minimum allowed cap.
    error CapBelowMinimum(uint256 adjustedCap, uint256 minCap);

    /// @notice Thrown when on-chain cap validation fails in handleSupplyHalt or handleBorrowHalt (cap not breached).
    error CapNotBreached();

    /// @notice Thrown when a zero address is passed where a valid address is required.
    error ZeroAddress();

    /// @notice Thrown when a market is not listed in the comptroller.
    /// @param market The market address.
    error MarketNotListed(address market);

    // ═══════════════════════════════════════════════════════════════════════
    //                     CONDITION HANDLERS (ACM-gated)
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Decrease the collateral factor (LTV) for a market.
     *         Triggered by S2 price spike signal: price increase > 1/LTV - 1 in 10 min.
     *         Tighten-only: adjustedLTV must be <= current CF, enforced by EBrake. Recovery via governance VIP.
     *
     * @dev    On BSC (Diamond comptroller), EBrake loops all e-mode pools internally.
     *         On non-BSC (IL comptroller), EBrake makes a single call.
     *
     * @param market The vToken market address.
     * @param adjustedLTV The new collateral factor mantissa (1e18 scale). Must be <= current CF.
     */
    function handleLTVAdjust(address market, uint256 adjustedLTV) external;

    /**
     * @notice Decrease a borrow or supply cap for a market, bounded within [minCap, currentCap].
     *         Triggered by S2 price drop signal: price decrease > k*(1-LTV) in 10 min.
     *         Tighten-only: adjustedCap must be <= current cap. Recovery via governance VIP.
     *
     * @param market The vToken market address.
     * @param capType Whether to adjust the borrow cap or supply cap.
     * @param adjustedCap The new cap value. Must be >= minCap and <= current cap (enforced by EBrake).
     */
    function handleCapAdjust(address market, CapType capType, uint256 adjustedCap) external;

    /**
     * @notice Halt supply for a market when supply cap is breached.
     *         Triggered by S4 supply cap breach signal: totalSupply >= supplyCap
     *         AND supply delta >= 5% in N blocks.
     *         Validates on-chain that totalSupply >= supplyCap, then pauses supply and zeros CF.
     *         One-way action — recovery requires governance VIP.
     *
     * @param market The vToken market address.
     */
    function handleSupplyHalt(address market) external;

    /**
     * @notice Halt borrowing for a market when borrow cap is breached.
     *         Triggered by S4 borrow cap breach signal: totalBorrows >= borrowCap
     *         AND borrow utilisation +10% in N blocks.
     *         Validates on-chain that totalBorrows >= borrowCap, then pauses borrow.
     *         One-way action — recovery requires governance VIP.
     *
     * @param market The vToken market address.
     */
    function handleBorrowHalt(address market) external;

    // ═══════════════════════════════════════════════════════════════════════
    //                     ADMIN FUNCTIONS (ACM-gated)
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Set or update the market configuration for automated risk parameter adjustments.
     * @param market The vToken market address.
     * @param config The market configuration containing bounds and coefficients.
     * @dev Reverts with ZeroAddress if market is the zero address.
     *      Reverts with MarketNotListed if market is not listed in the comptroller.
     */
    function setMarketConfig(address market, MarketConfig calldata config) external;
}
