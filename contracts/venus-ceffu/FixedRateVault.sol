// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { ERC4626Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import { SafeERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import { PausableUpgradeable } from "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import { MathUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/MathUpgradeable.sol";
import { AccessControlledV8 } from "@venusprotocol/governance-contracts/contracts/Governance/AccessControlledV8.sol";
import { ensureNonzeroAddress } from "@venusprotocol/solidity-utilities/contracts/validators.sol";

import { IFixedRateVault } from "./interfaces/IFixedRateVault.sol";
import { IFundRouter } from "./interfaces/IFundRouter.sol";
import { FixedRateVaultStorageV1 } from "./FixedRateVaultStorage.sol";

/**
 * @title FixedRateVault
 * @author Venus Protocol
 * @notice ERC-4626 tokenized vault for fixed-rate lending to Ceffu institutional clients.
 *
 * Lifecycle state machine:
 *
 * - Fundraising: users deposit stablecoins, shares minted 1:1
 * - Locked: funds transferred to Ceffu via FundRouter, awaiting repayment
 * - Matured: repayment received, shares redeemable for principal + net interest
 * - Cancelled: fundraising failed (below minCap) or admin-cancelled, 1:1 refund
 *
 * The critical `totalAssets()` override drives all ERC-4626 share math:
 *   Fundraising/Locked -> totalPrincipal (1:1 ratio)
 *   Cancelled -> actual vault balance (tracks withdrawals for 1:1 refunds)
 *   Matured -> actual vault balance minus pending protocolReserve (shares worth more)
 *
 * Deployed as EIP-1167 deterministic clones via VaultFactory. Each vault is single-use
 * with fixed parameters — no per-vault upgrade needed.
 */
contract FixedRateVault is
    ERC4626Upgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    AccessControlledV8,
    FixedRateVaultStorageV1,
    IFixedRateVault
{
    using SafeERC20Upgradeable for IERC20Upgradeable;

    // ──────────────────────────────────────────────
    //  Constants
    // ──────────────────────────────────────────────

    /// @dev Maximum basis points (100%)
    uint256 private constant MAX_BPS = 10_000;

    /// @dev Seconds in a year for interest calculations (365 days)
    uint256 private constant SECONDS_PER_YEAR = 365 days;

    // ──────────────────────────────────────────────
    //  Constructor
    // ──────────────────────────────────────────────

    /// @notice disabled initializer
    constructor() {
        _disableInitializers();
    }

    // ──────────────────────────────────────────────
    //  External functions
    // ──────────────────────────────────────────────

    /// @inheritdoc IFixedRateVault
    function initialize(
        address accessControlManager_,
        address fundRouter_,
        VaultInitParams calldata params
    ) external initializer {
        ensureNonzeroAddress(fundRouter_);
        ensureNonzeroAddress(params.supplyAsset);

        // Initialize inherited contracts
        __ERC20_init(params.name, params.symbol);
        __ERC4626_init(IERC20Upgradeable(params.supplyAsset));
        __ReentrancyGuard_init();
        __Pausable_init();
        __AccessControlled_init(accessControlManager_);

        _validateAndSetConfig(fundRouter_, params);
    }

    /// @inheritdoc IFixedRateVault
    function closeFundraising() external nonReentrant whenNotPaused {
        _checkAccessAllowed("closeFundraising()");

        if (state != VaultState.Fundraising) {
            revert InvalidState(state, VaultState.Fundraising);
        }

        if (totalPrincipal >= minCap) {
            _closeFundraisingSuccessful();
        } else {
            state = VaultState.Cancelled;
            emit VaultCancelled();
        }
    }

    /// @inheritdoc IFixedRateVault
    function cancelVault() external {
        _checkAccessAllowed("cancelVault()");

        if (state != VaultState.Fundraising) {
            revert InvalidState(state, VaultState.Fundraising);
        }

        state = VaultState.Cancelled;
        emit VaultCancelled();
    }

    /// @inheritdoc IFixedRateVault
    function receiveRepayment(uint256 amount) external {
        if (msg.sender != fundRouter) revert OnlyFundRouter();
        if (state != VaultState.Locked) {
            revert InvalidState(state, VaultState.Locked);
        }

        totalRepayment = amount;

        // Safe partial repayment handling:
        // If Ceffu repays less than principal, grossInterest = 0 and protocolReserve = 0.
        // Loss is socialized proportionally via totalAssets() returning totalRepayment.
        if (amount > totalPrincipal) {
            uint256 grossInterest = amount - totalPrincipal;
            protocolReserve = (grossInterest * reserveFactorBps) / MAX_BPS;
        }
        // else: protocolReserve stays 0 (default value)

        state = VaultState.Matured;

        uint256 userNetReturn = totalRepayment - protocolReserve;
        emit RepaymentReceived(amount, protocolReserve, userNetReturn);
    }

    /// @inheritdoc IFixedRateVault
    function withdrawReserves(address recipient) external nonReentrant {
        _checkAccessAllowed("withdrawReserves(address)");
        ensureNonzeroAddress(recipient);

        if (state != VaultState.Matured) {
            revert InvalidState(state, VaultState.Matured);
        }
        if (reservesWithdrawn) revert ReservesAlreadyWithdrawn();
        if (protocolReserve == 0) revert NoReservesToWithdraw();

        reservesWithdrawn = true;

        IERC20Upgradeable(asset()).safeTransfer(recipient, protocolReserve);

        emit ReservesWithdrawn(recipient, protocolReserve);
    }

    /// @inheritdoc IFixedRateVault
    function emergencyUnlock() external nonReentrant {
        _checkAccessAllowed("emergencyUnlock()");

        if (state != VaultState.Locked) {
            revert InvalidState(state, VaultState.Locked);
        }
        if (block.timestamp < lockPeriodEndTime + gracePeriod) {
            revert GracePeriodNotExpired();
        }

        // Use actual vault balance as repayment (may be 0 in total default)
        uint256 balance = IERC20Upgradeable(asset()).balanceOf(address(this));
        totalRepayment = balance;
        // No protocol reserve in emergency — no interest to tax
        state = VaultState.Matured;

        emit EmergencyUnlocked(balance);
    }

    /// @inheritdoc IFixedRateVault
    function pause() external {
        _checkAccessAllowed("pause()");
        _pause();
    }

    /// @inheritdoc IFixedRateVault
    function unpause() external {
        _checkAccessAllowed("unpause()");
        _unpause();
    }

    // ──────────────────────────────────────────────
    //  External view functions
    // ──────────────────────────────────────────────

    /// @inheritdoc IFixedRateVault
    function calculateExpectedInterest(uint256 principal) external view returns (uint256) {
        return (principal * fixedAPY * lockPeriodDuration) / (SECONDS_PER_YEAR * MAX_BPS);
    }

    /// @inheritdoc IFixedRateVault
    function getVaultConfig() external view returns (VaultInitParams memory params) {
        params = VaultInitParams({
            supplyAsset: asset(),
            name: name(),
            symbol: symbol(),
            ceffuRequestId: ceffuRequestId,
            fixedAPY: fixedAPY,
            minCap: minCap,
            maxCap: maxCap,
            fundraisingStartTime: fundraisingStartTime,
            fundraisingEndTime: fundraisingEndTime,
            lockPeriodDuration: lockPeriodDuration,
            reserveFactorBps: reserveFactorBps,
            minUserDeposit: minUserDeposit,
            maxUserDeposit: maxUserDeposit,
            gracePeriod: gracePeriod
        });
    }

    // ──────────────────────────────────────────────
    //  Public functions (ERC-4626 overrides)
    // ──────────────────────────────────────────────

    /// @inheritdoc ERC4626Upgradeable
    /// @dev Adds nonReentrant and whenNotPaused guards. Only during active fundraising.
    function deposit(
        uint256 assets,
        address receiver
    ) public override nonReentrant whenNotPaused returns (uint256) {
        return super.deposit(assets, receiver);
    }

    /// @inheritdoc ERC4626Upgradeable
    /// @dev Adds nonReentrant and whenNotPaused guards. Only during active fundraising.
    function mint(
        uint256 shares,
        address receiver
    ) public override nonReentrant whenNotPaused returns (uint256) {
        return super.mint(shares, receiver);
    }

    /// @inheritdoc ERC4626Upgradeable
    /// @dev Adds nonReentrant guard. Deliberately omits whenNotPaused so withdrawals
    ///      remain accessible even when paused (user safety valve in terminal states).
    function withdraw(
        uint256 assets,
        address receiver,
        address owner
    ) public override nonReentrant returns (uint256) {
        return super.withdraw(assets, receiver, owner);
    }

    /// @inheritdoc ERC4626Upgradeable
    /// @dev Adds nonReentrant guard. Deliberately omits whenNotPaused so redemptions
    ///      remain accessible even when paused (user safety valve in terminal states).
    function redeem(
        uint256 shares,
        address receiver,
        address owner
    ) public override nonReentrant returns (uint256) {
        return super.redeem(shares, receiver, owner);
    }

    // ──────────────────────────────────────────────
    //  Public view functions (ERC-4626 overrides)
    // ──────────────────────────────────────────────

    /// @inheritdoc ERC4626Upgradeable
    function totalAssets() public view override returns (uint256) {
        if (state == VaultState.Matured) {
            uint256 balance = IERC20Upgradeable(asset()).balanceOf(address(this));
            return reservesWithdrawn ? balance : balance - protocolReserve;
        }
        if (state == VaultState.Cancelled) {
            return IERC20Upgradeable(asset()).balanceOf(address(this));
        }
        return totalPrincipal;
    }

    /// @inheritdoc ERC4626Upgradeable
    /// @dev Returns 0 outside of an active Fundraising window.
    ///      Accounts for global maxCap, per-user maxUserDeposit, and per-user minUserDeposit.
    ///      If remaining capacity can't satisfy minUserDeposit for a new user, returns 0
    ///      to maintain ERC-4626 compliance (`deposit(maxDeposit(receiver), receiver)` MUST NOT revert).
    function maxDeposit(address receiver) public view override returns (uint256) {
        if (state != VaultState.Fundraising) return 0;
        if (block.timestamp < fundraisingStartTime) return 0;
        if (block.timestamp >= fundraisingEndTime) return 0;
        if (paused()) return 0;

        uint256 globalRemaining = maxCap - totalPrincipal;

        uint256 userRemaining = type(uint256).max;
        if (maxUserDeposit > 0) {
            uint256 alreadyDeposited = userDeposits[receiver];
            userRemaining = alreadyDeposited < maxUserDeposit ? maxUserDeposit - alreadyDeposited : 0;
        }

        uint256 maxDepositAmount = globalRemaining < userRemaining ? globalRemaining : userRemaining;

        // If user hasn't met minUserDeposit yet, their deposit must be large enough to reach it.
        // Return 0 if remaining capacity can't satisfy that minimum (prevents ERC-4626 spec violation).
        if (minUserDeposit > 0 && userDeposits[receiver] < minUserDeposit) {
            uint256 minRequired = minUserDeposit - userDeposits[receiver];
            if (maxDepositAmount < minRequired) return 0;
        }

        return maxDepositAmount;
    }

    /// @inheritdoc ERC4626Upgradeable
    function maxMint(address receiver) public view override returns (uint256) {
        return _convertToShares(maxDeposit(receiver), MathUpgradeable.Rounding.Down);
    }

    /// @inheritdoc ERC4626Upgradeable
    /// @dev Returns 0 unless vault is in Matured or Cancelled state.
    function maxWithdraw(address owner) public view override returns (uint256) {
        if (state != VaultState.Matured && state != VaultState.Cancelled) return 0;
        return _convertToAssets(balanceOf(owner), MathUpgradeable.Rounding.Down);
    }

    /// @inheritdoc ERC4626Upgradeable
    /// @dev Returns 0 unless vault is in Matured or Cancelled state.
    function maxRedeem(address owner) public view override returns (uint256) {
        if (state != VaultState.Matured && state != VaultState.Cancelled) return 0;
        return balanceOf(owner);
    }

    // ──────────────────────────────────────────────
    //  Internal functions (ERC-4626 overrides)
    // ──────────────────────────────────────────────

    /**
     * @notice Overrides the ERC-4626 deposit workflow to enforce vault-specific rules:
     *      - Fundraising state and time window checks
     *      - Per-user minimum deposit validation (cumulative across multiple deposits)
     *      - Deposit tracking via userDeposits and totalPrincipal
     *      - Auto-close on maxCap hit (Scenario A: immediate lock)
     * @param caller Address initiating the deposit (msg.sender)
     * @param receiver Address that will receive the minted shares
     * @param assets Amount of underlying assets being deposited (asset decimals)
     * @param shares Amount of vault shares to mint
     */
    function _deposit(
        address caller,
        address receiver,
        uint256 assets,
        uint256 shares
    ) internal override {
        // State and time window checks
        if (state != VaultState.Fundraising) {
            revert InvalidState(state, VaultState.Fundraising);
        }
        if (block.timestamp < fundraisingStartTime) revert FundraisingNotStarted();
        if (block.timestamp >= fundraisingEndTime) revert FundraisingEnded();

        // Per-user minimum deposit enforcement:
        // user's total deposit across all calls must be >= minUserDeposit
        if (minUserDeposit > 0 && userDeposits[receiver] + assets < minUserDeposit) {
            revert BelowMinUserDeposit(userDeposits[receiver] + assets, minUserDeposit);
        }

        // Execute ERC-4626 deposit (safeTransferFrom + mint)
        super._deposit(caller, receiver, assets, shares);

        // Update tracking
        userDeposits[receiver] += assets;
        totalPrincipal += assets;

        // Scenario A: auto-close when maxCap is reached
        if (totalPrincipal >= maxCap) {
            _closeFundraisingSuccessful();
        }
    }

    /**
     * @notice Overrides the ERC-4626 withdraw workflow to enforce terminal state requirement.
     *      maxWithdraw/maxRedeem already return 0 for non-terminal states, but this
     *      provides defense-in-depth with a clear error message.
     * @param caller Address initiating the withdrawal (msg.sender)
     * @param receiver Address that will receive the withdrawn assets
     * @param owner Address whose shares will be burned
     * @param assets Amount of underlying assets to withdraw (asset decimals)
     * @param shares Amount of vault shares to burn
     */
    function _withdraw(
        address caller,
        address receiver,
        address owner,
        uint256 assets,
        uint256 shares
    ) internal override {
        if (state != VaultState.Matured && state != VaultState.Cancelled) {
            revert InvalidState(state, VaultState.Matured);
        }

        super._withdraw(caller, receiver, owner, assets, shares);
    }

    /**
     * @notice Validates initialization parameters and sets vault configuration.
     * @param fundRouter_ Address of the FundRouter contract
     * @param params Vault initialization parameters
     */
    function _validateAndSetConfig(address fundRouter_, VaultInitParams calldata params) internal {
        // Validate parameters
        if (params.fixedAPY == 0) revert InvalidInitParam("fixedAPY");
        if (params.minCap == 0) revert InvalidInitParam("minCap");
        if (params.maxCap < params.minCap) revert InvalidInitParam("maxCap < minCap");
        if (params.fundraisingEndTime <= params.fundraisingStartTime) revert InvalidInitParam("fundraisingWindow");
        if (params.lockPeriodDuration == 0) revert InvalidInitParam("lockPeriodDuration");
        if (params.reserveFactorBps > MAX_BPS) revert InvalidInitParam("reserveFactorBps > 100%");

        // Set vault config (immutable after initialization)
        fundRouter = fundRouter_;
        fixedAPY = params.fixedAPY;
        minCap = params.minCap;
        maxCap = params.maxCap;
        fundraisingStartTime = params.fundraisingStartTime;
        fundraisingEndTime = params.fundraisingEndTime;
        lockPeriodDuration = params.lockPeriodDuration;
        reserveFactorBps = params.reserveFactorBps;
        minUserDeposit = params.minUserDeposit;
        maxUserDeposit = params.maxUserDeposit;
        gracePeriod = params.gracePeriod;
        ceffuRequestId = params.ceffuRequestId;
    }

    /**
     * @notice Handles successful fundraising closure (Scenario A or B).
     * @dev Closes fundraising for both scenarios:
     *      - Scenario A: maxCap reached via deposit (auto-close)
     *      - Scenario B: admin calls closeFundraising() with totalPrincipal >= minCap
     *
     *      Transitions state to Locked, calculates lockPeriodEndTime, approves the
     *      FundRouter to pull all raised funds, and triggers the transfer.
     */
    function _closeFundraisingSuccessful() internal {
        state = VaultState.Locked;
        lockPeriodEndTime = block.timestamp + lockPeriodDuration;

        // Approve FundRouter to pull all fundraised tokens, then trigger transfer
        IERC20Upgradeable asset_ = IERC20Upgradeable(asset());
        asset_.safeIncreaseAllowance(fundRouter, totalPrincipal);
        IFundRouter(fundRouter).receiveFundsFromVault(totalPrincipal);

        emit FundraisingClosed(totalPrincipal);
    }
}
