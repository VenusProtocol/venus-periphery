// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.25;

import { IComptroller } from "../Interfaces/IComptroller.sol";

/**
 * @title IEBrake
 * @author Venus Protocol
 * @notice Interface for the EBrake (Emergency Brake) contract.
 *         EBrake is an emergency action router that can only TIGHTEN restrictions,
 *         never loosen them. It also snapshots pre-incident values (CF, caps) so that
 *         governance can read and restore them via VIP. See resetMarketState().
 *
 * @dev Design goals and integration patterns:
 *
 *   1. DIRECT ACCESS
 *      The Venus multisig is whitelisted. During an incident, the multisig can call
 *      any function here (pause, set caps, etc.) without going through governance.
 *
 *   2. ON-CHAIN MONITORING CONTRACTS
 *      Contracts like DeviationSentinel or any Venus monitoring contract are also whitelisted.
 *      They contain their own detection logic (e.g. price deviation checks) and call into EBrake
 *      when a threat is detected. Example: DeviationSentinel detects a price anomaly → calls
 *      EBrake.pauseSupply() or EBrake.setCFZero(). The detection logic stays isolated in
 *      the monitor; EBrake only handles execution.
 *
 *   3. THIRD-PARTY MONITORS VIA SAFE MODULES
 *      External monitoring services (e.g. Hypernative) don't get direct whitelist access. Instead,
 *      for each service we create a dedicated Safe Module on our multisig. The Safe Module contains
 *      its own allowlist of which EBrake functions that service can call (e.g. Hypernative can only
 *      pause supply/borrow, not set caps). This keeps permission scoping outside of EBrake — each
 *      module enforces its own restrictions.
 *
 *   SAFETY INVARIANT — "Do no harm to existing users":
 *
 *      This contract can ONLY tighten restrictions, NEVER loosen them. If a whitelisted address
 *      is compromised, the worst outcome is a temporary freeze — never fund loss or liquidation.
 *
 *      This contract intentionally CANNOT:
 *        - Unpause             → EBrake can only pause, never unpause. Recovery is via governance VIP
 *        - Pause REPAY         → users must always be able to repay to avoid liquidation
 *        - Pause SEIZE         → liquidations must always work to prevent bad debt accumulation
 *        - Pause protocol      → setProtocolPaused blocks repay + liquidation, same problem
 *        - Lower LT            → lowering liquidation threshold would instantly make healthy
 *                                 positions liquidatable, harming innocent users
 *        - Increase caps       → caps can only be decreased to reduce exposure, never increased
 *        - Enable forced       → bypasses shortfall check entirely — ANY borrower becomes
 *          liquidation            liquidatable even with healthy collateral ratio
 *        - Target individual   → prevents griefing specific addresses via per-user forced
 *          users                  liquidation
 *        - Set close factor    → increasing allows liquidators to seize larger portions of
 *                                 collateral in one tx
 *        - Change oracle       → wrong oracle = mass mispricing = mass liquidations
 *        - Change liquidation  → altering incentive changes liquidation economics for all users
 *          incentive
 *
 *      Worst-case if EBrake is compromised:
 *        - Pauses minting/borrowing/redeeming/transfers (inconvenient, no fund loss)
 *        - Zeros supply/borrow caps (blocks new positions, existing ones unaffected)
 *        - Zeros collateral factor (blocks new borrows against asset, does NOT liquidate
 *          existing positions — that requires LT change, which EBrake cannot do)
 *        - Pauses flash loans (blocks flash loan attack vector, no user impact)
 *      Recovery: Governance VIP restores all parameters. Temporary freeze, not catastrophic.
 *
 *   BSC vs NON-BSC DIFFERENCES:
 *
 *      The IS_ISOLATED_POOL immutable determines which comptroller ABI is used.
 *      It is set at deployment and cannot be changed.
 *
 *      BSC (BNB Chain) — Diamond Comptroller (IS_ISOLATED_POOL = false):
 *        - setCFZero(market) — iterates corePoolId to lastPoolId, zeros CF for all listed pools
 *        - setCFZero(market, poolId) — targets a single pool (e.g. multisig use)
 *        - Uses poolMarkets() (7-value return) to read LT,
 *          calls setCollateralFactor(poolId, market, 0, LT) which returns uint256 error code
 *        - Supports e-mode pools via poolId > 0
 *        - pauseFlashLoan() — flash loans only exist on Diamond
 *        - disablePoolBorrow(poolId, market) — per-pool granular borrow disable, only on Diamond
 *        - revokeFlashLoanAccess(account) — remove a single account from the flash loan
 *          whitelist; flash loan whitelist only exists on Diamond
 *        - ACM permission strings use underscore prefix:
 *          _setActionsPaused, _setMarketBorrowCaps, _setMarketSupplyCaps
 *
 *      Non-BSC chains — IL Comptroller (IS_ISOLATED_POOL = true):
 *        - setCFZero(market) — uses markets() (3-value return) to read LT,
 *          calls setCollateralFactor(market, 0, LT) which returns void (no error code)
 *        - No poolId concept — only the core pool exists (other pools are deprecated)
 *        - setCFZero(market, poolId) not granted ACM permission (no pool concept on IL)
 *        - pauseFlashLoan() not granted ACM permission (flash loans don't exist on IL)
 *        - ACM permission strings have no underscore:
 *          setActionsPaused, setMarketBorrowCaps, setMarketSupplyCaps
 *
 *      All other functions (pauseActions, pauseSupply, pauseBorrow, pauseRedeem,
 *      pauseTransfer, setMarketBorrowCaps, setMarketSupplyCaps) are ABI-compatible
 *      across both comptroller types and work identically on all chains.
 */
interface IEBrake {
    // ═══════════════════════════════════════════════════════════════════════
    //                              EVENTS
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Emitted when actions are paused on markets via batch pause.
    /// @param caller The address that triggered the emergency action.
    /// @param markets The vToken market addresses that were paused.
    /// @param actions The actions that were paused.
    event ActionsPaused(address indexed caller, address[] markets, IComptroller.Action[] actions);

    /// @notice Emitted when a single action is paused on a market.
    /// @param caller The address that triggered the emergency action.
    /// @param market The vToken market address that was paused.
    /// @param action The action that was paused.
    event ActionPaused(address indexed caller, address indexed market, IComptroller.Action action);

    /// @notice Emitted when flash loans are paused.
    /// @param caller The address that triggered the emergency action.
    event FlashLoanPaused(address indexed caller);

    /// @notice Emitted when borrowing is disabled for a market in a specific pool.
    /// @param caller The address that triggered the emergency action.
    /// @param poolId The pool identifier (0 = core pool, >0 = e-mode pools).
    /// @param market The vToken market address whose pool-borrow flag was disabled.
    event PoolBorrowDisabled(address indexed caller, uint96 indexed poolId, address indexed market);

    /// @notice Emitted when an account is removed from the flash loan whitelist.
    /// @param caller The address that triggered the emergency action.
    /// @param account The account whose flash loan access was revoked.
    event FlashLoanAccessRevoked(address indexed caller, address indexed account);

    /// @notice Emitted when a collateral factor is set to zero.
    ///         Used for both core/e-mode pools and IL comptrollers.
    /// @param caller The address that triggered the emergency action.
    /// @param market The vToken market address whose CF was zeroed.
    /// @param poolId The pool ID. On BNB Chain (Diamond comptroller) this identifies the core pool (0)
    ///        or an e-mode pool (>0). On other networks (IL comptroller) there is no poolId concept;
    ///        0 is used as a sentinel value to indicate that only the core pool is supported (other pools are deprecated).
    event CollateralFactorZeroed(address indexed caller, address indexed market, uint96 indexed poolId);

    /// @notice Emitted when borrow caps are decreased.
    /// @param caller The address that triggered the emergency action.
    /// @param markets The vToken market addresses whose borrow caps were decreased.
    /// @param newBorrowCaps The new borrow cap values.
    event BorrowCapsDecreased(address indexed caller, address[] markets, uint256[] newBorrowCaps);

    /// @notice Emitted when supply caps are decreased.
    /// @param caller The address that triggered the emergency action.
    /// @param markets The vToken market addresses whose supply caps were decreased.
    /// @param newSupplyCaps The new supply cap values.
    event SupplyCapsDecreased(address indexed caller, address[] markets, uint256[] newSupplyCaps);

    /// @notice Emitted when a market's snapshot state is reset after governance recovery.
    /// @param market The market address whose snapshot was cleared.
    event MarketStateReset(address indexed market);

    // ═══════════════════════════════════════════════════════════════════════
    //                              ERRORS
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Thrown when a forbidden action (REPAY, SEIZE, etc.) is passed to batch pause.
    /// @param action The disallowed action that was passed.
    error ForbiddenAction(IComptroller.Action action);

    /// @notice Thrown when a zero address is passed where a valid address is required.
    error ZeroAddress();

    /// @notice Thrown when a market is not listed in the given pool.
    ///         On BNB Chain (Diamond comptroller) poolId identifies the core pool (0) or an e-mode pool (>0).
    ///         On other networks (IL comptroller) there is no poolId concept;
    ///         0 is used as a sentinel value (other pools are deprecated).
    /// @param poolId The pool ID that was queried.
    /// @param market The market address that is not listed.
    error MarketNotListed(uint96 poolId, address market);

    /// @notice Thrown when setCollateralFactor returns a non-zero error code.
    /// @param errorCode The error code returned by the comptroller.
    error SetCollateralFactorFailed(uint256 errorCode);

    /// @notice Thrown when an empty array is passed where at least one element is required.
    error EmptyArray();

    /// @notice Thrown when array lengths do not match.
    /// @param expected The expected array length.
    /// @param actual The actual array length.
    error ArrayLengthMismatch(uint256 expected, uint256 actual);

    /// @notice Thrown when the requested cap exceeds the current cap on the comptroller.
    /// @param market The market whose cap was attempted to be increased.
    /// @param currentCap The current cap value on the comptroller.
    /// @param requestedCap The new cap value that was rejected.
    error CapExceedsCurrent(address market, uint256 currentCap, uint256 requestedCap);

    // ═══════════════════════════════════════════════════════════════════════
    //                     EMERGENCY ACTIONS — BATCH OPERATIONS
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Pause multiple actions on multiple markets in one call.
     * @dev Only MINT, REDEEM, BORROW, and TRANSFER are allowed. Reverts on REPAY, SEIZE,
     *      LIQUIDATE, ENTER_MARKET, or EXIT_MARKET — see SAFETY INVARIANT.
     * @param markets The vToken market addresses to pause actions on.
     * @param actions The actions to pause.
     */
    function pauseActions(address[] calldata markets, IComptroller.Action[] calldata actions) external;

    // ═══════════════════════════════════════════════════════════════════════
    //                     EMERGENCY ACTIONS — SINGLE MARKET PAUSING
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Pause supply (mint) on a single market.
    ///         Blocks new deposits. Existing suppliers can still redeem.
    /// @param market The vToken market address.
    function pauseSupply(address market) external;

    /// @notice Pause redeem on a single market.
    ///         Blocks withdrawals. Use when draining must be stopped immediately.
    /// @param market The vToken market address.
    function pauseRedeem(address market) external;

    /// @notice Pause borrow on a single market.
    ///         Blocks new borrows. Existing borrowers can still repay.
    /// @param market The vToken market address.
    function pauseBorrow(address market) external;

    /// @notice Pause transfer of vTokens on a single market.
    ///         Blocks vToken movement, prevents attacker from moving stolen collateral.
    /// @param market The vToken market address.
    function pauseTransfer(address market) external;

    // ═══════════════════════════════════════════════════════════════════════
    //                     EMERGENCY ACTIONS — FLASH LOANS
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Pause flash loans across the core pool.
    function pauseFlashLoan() external;

    /**
     * @notice Disable borrowing for a market in a specific pool, leaving other pools unaffected.
     * @dev Only meaningful on Diamond comptroller (BSC) where the per-pool `isBorrowAllowed` flag exists.
     *      On non-BSC chains the underlying call will revert (selector mismatch on IL comptroller).
     *
     *      This is independent of `pauseBorrow(market)` which flips the global
     *      `_actionPaused[market][BORROW]` flag across every pool. Both flags must allow borrowing
     *      for borrows to actually proceed in a given pool/market — recovery from a combined
     *      tightening therefore requires governance to clear both flags.
     *
     *      The boolean argument is hardcoded to `false` inside the implementation to preserve
     *      the EBrake "tighten only, never loosen" invariant. Re-enabling borrow is governance-only.
     * @param poolId The pool identifier (0 = core pool, >0 = e-mode pools).
     * @param market The vToken market address.
     */
    function disablePoolBorrow(uint96 poolId, address market) external;

    /**
     * @notice Remove a single account from the flash loan whitelist.
     * @dev Only meaningful on Diamond comptroller (BSC) where the flash loan whitelist exists.
     *      On non-BSC chains the underlying call will revert (selector mismatch on IL comptroller).
     *
     *      This is the surgical alternative to `pauseFlashLoan()`, which kills flash loans for
     *      every whitelisted account. Use it when a single whitelisted integrator is compromised.
     *
     *      The boolean argument is hardcoded to `false` inside the implementation to preserve
     *      the EBrake "tighten only, never loosen" invariant. Re-granting access is governance-only.
     * @param account The account whose flash loan access should be revoked.
     */
    function revokeFlashLoanAccess(address account) external;

    // ═══════════════════════════════════════════════════════════════════════
    //                     EMERGENCY ACTIONS — RISK PARAMETER ADJUSTMENTS
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Set collateral factor to zero for a market across all relevant pools.
     *         Liquidation threshold is left unchanged.
     *         Blocks new borrows against the asset. Does NOT make existing positions liquidatable —
     *         that would require lowering LT, which this contract cannot do.
     * @dev On Diamond comptroller (IS_ISOLATED_POOL=false): iterates corePoolId to lastPoolId,
     *      zeros CF for every pool where the market is listed, skips unlisted pools.
     *      On IL comptroller (IS_ISOLATED_POOL=true): zeros CF for the single market entry.
     * @param market The vToken market address whose CF should be zeroed.
     */
    function setCFZero(address market) external;

    /**
     * @notice Set collateral factor to zero for a market in a specific pool.
     *         Same safety guarantees as setCFZero(address) — LT is left unchanged.
     * @dev Only meaningful on Diamond comptroller (BSC) where multiple pools exist.
     *      On non-BSC chains, ACM should not grant permission for this function.
     * @param market The vToken market address whose CF should be zeroed.
     * @param poolId The pool ID (0 for core pool, >0 for e-mode pools).
     */
    function setCFZero(address market, uint96 poolId) external;

    /**
     * @notice Decrease borrow caps on markets. Can only set caps LOWER than or equal to current values.
     *         Setting to 0 blocks all new borrows. Existing borrows are never affected by caps.
     * @param markets The vToken market addresses to adjust borrow caps on.
     * @param newBorrowCaps The new borrow cap values. Each must be <= current cap.
     */
    function setMarketBorrowCaps(address[] calldata markets, uint256[] calldata newBorrowCaps) external;

    /**
     * @notice Decrease supply caps on markets. Can only set caps LOWER than or equal to current values.
     *         Setting to 0 blocks all new deposits. Existing deposits are never affected by caps.
     * @param markets The vToken market addresses to adjust supply caps on.
     * @param newSupplyCaps The new supply cap values. Each must be <= current cap.
     */
    function setMarketSupplyCaps(address[] calldata markets, uint256[] calldata newSupplyCaps) external;

    // ═══════════════════════════════════════════════════════════════════════
    //                     MARKET STATE SNAPSHOT — RESET & VIEW
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Reset the stored market state snapshot for a market.
     * @dev Called by governance as part of a recovery VIP after restoring market parameters.
     *      Clears stored CF/LT per pool and borrow/supply cap snapshots so that
     *      future EBrake actions can capture fresh pre-incident values.
     * @param market The vToken market address whose snapshot should be cleared.
     */
    function resetMarketState(address market) external;

    /**
     * @notice Read the stored collateral factor and liquidation threshold snapshot for a market in a specific pool.
     * @param market The vToken market address.
     * @param poolId The pool ID (0 for IL chains or core pool on Diamond).
     * @return cf The collateral factor that was stored before EBrake zeroed it. 0 if no snapshot exists.
     * @return lt The liquidation threshold at the time of the snapshot. 0 if no snapshot exists.
     */
    function getMarketCFSnapshot(address market, uint96 poolId) external view returns (uint256 cf, uint256 lt);
}
