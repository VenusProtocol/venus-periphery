// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.25;

import { ICorePoolComptroller } from "../Interfaces/ICorePoolComptroller.sol";
import { IComptroller } from "../Interfaces/IComptroller.sol";
import { IILComptroller } from "../Interfaces/IILComptroller.sol";
import { IEBrake } from "./IEBrake.sol";
import { AccessControlledV8 } from "@venusprotocol/governance-contracts/contracts/Governance/AccessControlledV8.sol";

/**
 * @title EBrake — Emergency Brake Contract
 * @author Venus Protocol
 * @notice Emergency action router for Venus Protocol (deployed behind a TransparentUpgradeableProxy).
 *         This contract holds NO detection logic — it only exposes Comptroller emergency
 *         functions behind ACM permissions. See IEBrake for full design documentation.
 */
contract EBrake is IEBrake, AccessControlledV8 {
    /// @notice Snapshot of a market's pre-incident state, captured by EBrake before tightening.
    /// @dev Structs with nested mappings cannot be returned from external functions;
    ///      use getMarketCFSnapshot() to read per-pool CF/LT values.
    ///      Cap fields (borrowCap, supplyCap, etc.) are accessible via the auto-generated marketStates() getter.
    /// @param borrowCap The borrow cap value before EBrake decreased it.
    /// @param supplyCap The supply cap value before EBrake decreased it.
    /// @param borrowCapSnapshotted True if a borrow cap snapshot has been recorded.
    /// @param supplyCapSnapshotted True if a supply cap snapshot has been recorded.
    /// @param poolCFs Mapping of poolId to the collateral factor before EBrake zeroed it.
    /// @param poolLTs Mapping of poolId to the liquidation threshold at snapshot time.
    struct MarketState {
        uint256 borrowCap;
        uint256 supplyCap;
        bool borrowCapSnapshotted;
        bool supplyCapSnapshotted;
        mapping(uint96 => uint256) poolCFs;
        mapping(uint96 => uint256) poolLTs;
    }

    /**
     * @notice Venus Core Pool Comptroller
     * @dev All emergency functions operate directly on this comptroller.
     *      On BSC this is a Diamond proxy; on non-BSC chains it is an IL comptroller
     */
    ICorePoolComptroller public immutable COMPTROLLER;

    /**
     * @notice True for IL comptroller (isolated-pools repo), false for Diamond comptroller (venus-protocol repo).
     * @dev Determines which ABI path setCFZero(address) uses internally.
     */
    bool public immutable IS_ISOLATED_POOL;

    /// @notice Stored pre-incident market state snapshots, keyed by vToken market address.
    /// @dev Values are captured at tightening time (first-write-wins) and cleared via resetMarketState().
    mapping(address => MarketState) public marketStates;

    /// @dev Storage gap for future upgrades.
    uint256[49] private __gap;

    /// @custom:oz-upgrades-unsafe-allow constructor
    /// @param corePoolComptroller_ Address of the Venus Comptroller.
    /// @param isIsolatedPool_ True for IL comptroller (isolated-pools), false for Diamond comptroller (venus-protocol).
    constructor(ICorePoolComptroller corePoolComptroller_, bool isIsolatedPool_) {
        if (address(corePoolComptroller_) == address(0)) revert ZeroAddress();

        COMPTROLLER = corePoolComptroller_;
        IS_ISOLATED_POOL = isIsolatedPool_;
        _disableInitializers();
    }

    /// @notice Initialize the EBrake proxy with the Access Control Manager.
    /// @param accessControlManager_ Address of the Venus Access Control Manager.
    function initialize(address accessControlManager_) external initializer {
        if (accessControlManager_ == address(0)) revert ZeroAddress();
        __AccessControlled_init(accessControlManager_);
    }

    /// @inheritdoc IEBrake
    function pauseActions(address[] calldata markets, IComptroller.Action[] calldata actions) external {
        _checkAccessAllowed("pauseActions(address[],uint8[])");
        if (markets.length == 0 || actions.length == 0) revert EmptyArray();

        uint256 actionsLen = actions.length;
        for (uint256 i; i < actionsLen; ++i) {
            _validateAction(actions[i]);
        }
        IComptroller(address(COMPTROLLER)).setActionsPaused(markets, actions, true);
        emit ActionsPaused(msg.sender, markets, actions);
    }

    /// @inheritdoc IEBrake
    function pauseSupply(address market) external {
        _checkAccessAllowed("pauseSupply(address)");
        _pauseSingleAction(market, IComptroller.Action.MINT);
        emit ActionPaused(msg.sender, market, IComptroller.Action.MINT);
    }

    /// @inheritdoc IEBrake
    function pauseRedeem(address market) external {
        _checkAccessAllowed("pauseRedeem(address)");
        _pauseSingleAction(market, IComptroller.Action.REDEEM);
        emit ActionPaused(msg.sender, market, IComptroller.Action.REDEEM);
    }

    /// @inheritdoc IEBrake
    function pauseBorrow(address market) external {
        _checkAccessAllowed("pauseBorrow(address)");
        _pauseSingleAction(market, IComptroller.Action.BORROW);
        emit ActionPaused(msg.sender, market, IComptroller.Action.BORROW);
    }

    /// @inheritdoc IEBrake
    function pauseTransfer(address market) external {
        _checkAccessAllowed("pauseTransfer(address)");
        _pauseSingleAction(market, IComptroller.Action.TRANSFER);
        emit ActionPaused(msg.sender, market, IComptroller.Action.TRANSFER);
    }

    /// @inheritdoc IEBrake
    function pauseFlashLoan() external {
        _checkAccessAllowed("pauseFlashLoan()");
        COMPTROLLER.setFlashLoanPaused(true);
        emit FlashLoanPaused(msg.sender);
    }

    /// @inheritdoc IEBrake
    function setCFZero(address market) external {
        _checkAccessAllowed("setCFZero(address)");
        MarketState storage state = marketStates[market];
        if (IS_ISOLATED_POOL) {
            IILComptroller.Market memory m = IILComptroller(address(COMPTROLLER)).markets(market);
            if (!m.isListed) revert MarketNotListed(0, market);
            _snapshotCF(state, 0, m.collateralFactorMantissa, m.liquidationThresholdMantissa);
            IILComptroller(address(COMPTROLLER)).setCollateralFactor(market, 0, m.liquidationThresholdMantissa);
            emit CollateralFactorZeroed(msg.sender, market, 0);
        } else {
            uint96 corePoolId = COMPTROLLER.corePoolId();
            uint96 lastPoolId = COMPTROLLER.lastPoolId();
            for (uint96 i = corePoolId; i <= lastPoolId; i++) {
                (bool isListed, uint256 currentCF, , uint256 currentLT, , , ) = COMPTROLLER.poolMarkets(i, market);
                if (!isListed) continue;
                _snapshotCF(state, i, currentCF, currentLT);
                uint256 err = COMPTROLLER.setCollateralFactor(i, market, 0, currentLT);
                if (err != 0) revert SetCollateralFactorFailed(err);
                emit CollateralFactorZeroed(msg.sender, market, i);
            }
        }
    }

    /// @inheritdoc IEBrake
    function setCFZero(address market, uint96 poolId) external {
        _checkAccessAllowed("setCFZero(address,uint96)");
        (bool isListed, uint256 currentCF, , uint256 currentLT, , , ) = COMPTROLLER.poolMarkets(poolId, market);
        if (!isListed) revert MarketNotListed(poolId, market);

        _snapshotCF(marketStates[market], poolId, currentCF, currentLT);
        uint256 err = COMPTROLLER.setCollateralFactor(poolId, market, 0, currentLT);
        if (err != 0) revert SetCollateralFactorFailed(err);
        emit CollateralFactorZeroed(msg.sender, market, poolId);
    }

    /// @inheritdoc IEBrake
    function setMarketBorrowCaps(address[] calldata markets, uint256[] calldata newBorrowCaps) external {
        _checkAccessAllowed("setMarketBorrowCaps(address[],uint256[])");
        uint256 marketsLen = markets.length;
        if (marketsLen == 0) revert EmptyArray();
        if (marketsLen != newBorrowCaps.length) revert ArrayLengthMismatch(marketsLen, newBorrowCaps.length);

        IComptroller comptroller = IComptroller(address(COMPTROLLER));

        for (uint256 i; i < marketsLen; ++i) {
            uint256 currentCap = comptroller.borrowCaps(markets[i]);
            if (newBorrowCaps[i] > currentCap) {
                revert CapExceedsCurrent(markets[i], currentCap, newBorrowCaps[i]);
            }
            MarketState storage state = marketStates[markets[i]];
            if (!state.borrowCapSnapshotted) {
                state.borrowCap = currentCap;
                state.borrowCapSnapshotted = true;
            }
        }

        comptroller.setMarketBorrowCaps(markets, newBorrowCaps);
        emit BorrowCapsDecreased(msg.sender, markets, newBorrowCaps);
    }

    /// @inheritdoc IEBrake
    function setMarketSupplyCaps(address[] calldata markets, uint256[] calldata newSupplyCaps) external {
        _checkAccessAllowed("setMarketSupplyCaps(address[],uint256[])");
        uint256 marketsLen = markets.length;
        if (marketsLen == 0) revert EmptyArray();
        if (marketsLen != newSupplyCaps.length) revert ArrayLengthMismatch(marketsLen, newSupplyCaps.length);

        IComptroller comptroller = IComptroller(address(COMPTROLLER));

        for (uint256 i; i < marketsLen; ++i) {
            uint256 currentCap = comptroller.supplyCaps(markets[i]);
            if (newSupplyCaps[i] > currentCap) {
                revert CapExceedsCurrent(markets[i], currentCap, newSupplyCaps[i]);
            }
            MarketState storage state = marketStates[markets[i]];
            if (!state.supplyCapSnapshotted) {
                state.supplyCap = currentCap;
                state.supplyCapSnapshotted = true;
            }
        }

        comptroller.setMarketSupplyCaps(markets, newSupplyCaps);
        emit SupplyCapsDecreased(msg.sender, markets, newSupplyCaps);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                     MARKET STATE SNAPSHOT — RESET & VIEW
    // ═══════════════════════════════════════════════════════════════════════

    /// @inheritdoc IEBrake
    function resetMarketState(address market) external {
        _checkAccessAllowed("resetMarketState(address)");

        MarketState storage state = marketStates[market];
        state.borrowCap = 0;
        state.supplyCap = 0;
        state.borrowCapSnapshotted = false;
        state.supplyCapSnapshotted = false;

        if (IS_ISOLATED_POOL) {
            delete state.poolCFs[0];
            delete state.poolLTs[0];
        } else {
            uint96 corePoolId = COMPTROLLER.corePoolId();
            uint96 lastPoolId = COMPTROLLER.lastPoolId();
            for (uint96 i = corePoolId; i <= lastPoolId; i++) {
                delete state.poolCFs[i];
                delete state.poolLTs[i];
            }
        }

        emit MarketStateReset(market);
    }

    /// @inheritdoc IEBrake
    function getMarketCFSnapshot(address market, uint96 poolId) external view returns (uint256 cf, uint256 lt) {
        MarketState storage state = marketStates[market];
        cf = state.poolCFs[poolId];
        lt = state.poolLTs[poolId];
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              INTERNALS
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Snapshot collateral factor and liquidation threshold for a market in a specific pool.
     * @dev First-write-wins: only records if poolCFs[poolId] == 0 (no prior snapshot).
     *      If CF was already 0 before EBrake acted, there is nothing to restore.
     * @param state The MarketState storage reference for this market.
     * @param poolId The pool ID.
     * @param currentCF The current collateral factor before zeroing.
     * @param currentLT The current liquidation threshold.
     */
    function _snapshotCF(MarketState storage state, uint96 poolId, uint256 currentCF, uint256 currentLT) internal {
        if (state.poolCFs[poolId] == 0 && currentCF > 0) {
            state.poolCFs[poolId] = currentCF;
            state.poolLTs[poolId] = currentLT;
        }
    }

    /**
     * @notice Wraps a single market and action into arrays for the comptroller's setActionsPaused.
     * @param market The vToken market address.
     * @param action The action to pause.
     */
    function _pauseSingleAction(address market, IComptroller.Action action) internal {
        address[] memory markets = new address[](1);
        markets[0] = market;

        IComptroller.Action[] memory actions = new IComptroller.Action[](1);
        actions[0] = action;

        IComptroller(address(COMPTROLLER)).setActionsPaused(markets, actions, true);
    }

    /**
     * @notice Validates that an action is one of the allowed emergency actions.
     *      Only MINT (0), REDEEM (1), BORROW (2), and TRANSFER (6) are permitted.
     * @param action The action to validate.
     */
    function _validateAction(IComptroller.Action action) internal pure {
        if (
            action != IComptroller.Action.MINT &&
            action != IComptroller.Action.REDEEM &&
            action != IComptroller.Action.BORROW &&
            action != IComptroller.Action.TRANSFER
        ) {
            revert ForbiddenAction(action);
        }
    }
}
