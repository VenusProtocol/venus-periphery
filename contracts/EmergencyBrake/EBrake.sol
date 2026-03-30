// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.25;

import { ICorePoolComptroller } from "../Interfaces/ICorePoolComptroller.sol";
import { IComptroller } from "../Interfaces/IComptroller.sol";
import { IEBrake } from "./IEBrake.sol";
import { AccessControlledV8 } from "@venusprotocol/governance-contracts/contracts/Governance/AccessControlledV8.sol";

/**
 * @title EBrake — Emergency Brake Contract (BNB Chain)
 * @author Venus Protocol
 * @notice A standalone emergency action router for Venus Protocol's BNB Chain Core Pool.
 *         This contract holds NO detection logic — it only exposes Comptroller emergency
 *         functions behind a whitelist. See IEBrake for full design documentation.
 */
contract EBrake is IEBrake, AccessControlledV8 {
    /**
     * @notice Venus Core Pool Comptroller
     * @dev All emergency functions operate directly on this comptroller.
     *      Supports both core pool (poolId=0) and e-mode pools (poolId>0)
     *      for setCFZero via the poolId-aware setCollateralFactor overload.
     */
    ICorePoolComptroller public immutable COMPTROLLER;

    /// @notice Addresses authorized to call emergency functions.
    mapping(address => bool) public whitelist;

    modifier onlyWhitelisted() {
        if (!whitelist[msg.sender]) revert NotWhitelisted(msg.sender);
        _;
    }

    /// @notice Deploy EBrake with the core pool comptroller and ACM.
    /// @param corePoolComptroller_ Address of the Venus Core Pool Comptroller (Diamond proxy).
    /// @param accessControlManager_ Address of the Venus Access Control Manager.
    constructor(ICorePoolComptroller corePoolComptroller_, address accessControlManager_) initializer {
        if (address(corePoolComptroller_) == address(0)) revert ZeroAddress();
        if (accessControlManager_ == address(0)) revert ZeroAddress();

        COMPTROLLER = corePoolComptroller_;
        __AccessControlled_init(accessControlManager_);
    }

    /// @inheritdoc IEBrake
    function setWhitelist(address addr, bool isActive) external {
        _checkAccessAllowed("setWhitelist(address,bool)");
        if (addr == address(0)) revert ZeroAddress();
        whitelist[addr] = isActive;
        emit WhitelistUpdated(addr, isActive);
    }

    /// @inheritdoc IEBrake
    function setActionsPaused(
        address[] calldata markets,
        IComptroller.Action[] calldata actions,
        bool paused
    ) external onlyWhitelisted {
        if (markets.length == 0 || actions.length == 0) revert EmptyArray();

        uint256 actionsLen = actions.length;
        for (uint256 i; i < actionsLen; ++i) {
            _validateAction(actions[i]);
        }
        IComptroller(address(COMPTROLLER)).setActionsPaused(markets, actions, paused);
    }

    /// @inheritdoc IEBrake
    function setSupplyPaused(address market, bool paused) external onlyWhitelisted {
        _pauseSingleAction(market, IComptroller.Action.MINT, paused);
    }

    /// @inheritdoc IEBrake
    function setRedeemPaused(address market, bool paused) external onlyWhitelisted {
        _pauseSingleAction(market, IComptroller.Action.REDEEM, paused);
    }

    /// @inheritdoc IEBrake
    function setBorrowPaused(address market, bool paused) external onlyWhitelisted {
        _pauseSingleAction(market, IComptroller.Action.BORROW, paused);
    }

    /// @inheritdoc IEBrake
    function setTransferPaused(address market, bool paused) external onlyWhitelisted {
        _pauseSingleAction(market, IComptroller.Action.TRANSFER, paused);
    }

    /// @inheritdoc IEBrake
    function setFlashLoanPaused(bool paused) external onlyWhitelisted {
        COMPTROLLER.setFlashLoanPaused(paused);
    }

    /// @inheritdoc IEBrake
    function setCFZero(address market, uint96 poolId) external onlyWhitelisted {
        (bool isListed, , , uint256 currentLT, , , ) = COMPTROLLER.poolMarkets(poolId, market);
        if (!isListed) revert MarketNotListed(poolId, market);

        uint256 err = COMPTROLLER.setCollateralFactor(poolId, market, 0, currentLT);
        if (err != 0) revert SetCollateralFactorFailed(err);
    }

    /// @inheritdoc IEBrake
    function setMarketBorrowCaps(
        address[] calldata markets,
        uint256[] calldata newBorrowCaps
    ) external onlyWhitelisted {
        uint256 marketsLen = markets.length;
        if (marketsLen == 0) revert EmptyArray();
        if (marketsLen != newBorrowCaps.length) revert ArrayLengthMismatch(marketsLen, newBorrowCaps.length);

        IComptroller comptroller = IComptroller(address(COMPTROLLER));

        for (uint256 i; i < marketsLen; ++i) {
            uint256 currentCap = comptroller.borrowCaps(markets[i]);
            if (currentCap == 0 && newBorrowCaps[i] == 0) continue;
            if (!(newBorrowCaps[i] < currentCap)) {
                revert CapCanOnlyDecrease(markets[i], currentCap, newBorrowCaps[i]);
            }
        }

        comptroller.setMarketBorrowCaps(markets, newBorrowCaps);
    }

    /// @inheritdoc IEBrake
    function setMarketSupplyCaps(
        address[] calldata markets,
        uint256[] calldata newSupplyCaps
    ) external onlyWhitelisted {
        uint256 marketsLen = markets.length;
        if (marketsLen == 0) revert EmptyArray();
        if (marketsLen != newSupplyCaps.length) revert ArrayLengthMismatch(marketsLen, newSupplyCaps.length);

        IComptroller comptroller = IComptroller(address(COMPTROLLER));

        for (uint256 i; i < marketsLen; ++i) {
            uint256 currentCap = comptroller.supplyCaps(markets[i]);
            if (currentCap == 0 && newSupplyCaps[i] == 0) continue;
            if (!(newSupplyCaps[i] < currentCap)) {
                revert CapCanOnlyDecrease(markets[i], currentCap, newSupplyCaps[i]);
            }
        }

        comptroller.setMarketSupplyCaps(markets, newSupplyCaps);
    }

    /**
     * @dev Wraps a single market and action into arrays for the comptroller's setActionsPaused.
     * @param market The vToken market address.
     * @param action The action to pause/unpause.
     * @param paused True to pause, false to unpause.
     */
    function _pauseSingleAction(address market, IComptroller.Action action, bool paused) internal {
        address[] memory markets = new address[](1);
        markets[0] = market;

        IComptroller.Action[] memory actions = new IComptroller.Action[](1);
        actions[0] = action;

        IComptroller(address(COMPTROLLER)).setActionsPaused(markets, actions, paused);
    }

    /**
     * @dev Validates that an action is one of the allowed emergency actions.
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
