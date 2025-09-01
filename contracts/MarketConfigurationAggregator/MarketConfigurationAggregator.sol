// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.25;

import { IComptroller, IVToken } from "../Interfaces.sol";

/**
 * @title MarketConfigurationAggregator
 * @author Venus
 * @notice Executes batches of market configuration updates.
 */
contract MarketConfigurationAggregator {
    /// @notice Struct representing parameters to update a market's collateral factor and liquidation threshold
    struct CollateralFactorParams {
        IVToken vToken;
        uint256 newCollateralFactorMantissa;
        uint256 newLiquidationThresholdMantissa;
    }

    /// @notice Struct representing parameters to update a market's liquidation incentive
    struct LiquidationIncentiveParams {
        address vToken;
        uint256 newLiquidationIncentiveMantissa;
    }

    /// @notice Struct representing parameters to enable or disable borrowing on a market
    struct BorrowAllowedParams {
        uint96 poolId;
        address vToken;
        bool borrowAllowed;
    }

    /// @notice The Comptroller contract 
    IComptroller public immutable COMPTROLLER;

    /**
     * @notice Emitted after a batch of collateral factor updates is executed
     * @param count The number of updates executed in this batch
     */
    event CollateralFactorBatchExecuted(uint256 count);

    /**
     * @notice Emitted after a batch of liquidation incentive updates is executed
     * @param count The number of updates executed in this batch
     */
    event LiquidationIncentiveBatchExecuted(uint256 count);

    /**
     * @notice Emitted after a batch of borrow allowed updates is executed
     * @param count The number of updates executed in this batch
     */
    event BorrowAllowedBatchExecuted(uint256 count);

    /// @notice Error thrown when an zero address is provided
    error ZeroAddress();

    /// @notice Error thrown when attempting to execute a batch with zero updates
    error EmptyBatch();

    /**
     * @notice Constructor to initialize the MarketConfigurationAggregator with the comptroller
     * @param _comptroller Address of the comptroller
     * @custom:error Reverts with ZeroAddress if the provided `_comptroller` is the zero address
     */
    constructor(address _comptroller) {
        if (_comptroller == address(0)) revert ZeroAddress();
        COMPTROLLER = IComptroller(_comptroller);
    }

    /**
     * @notice Execute a batch of collateral factor updates
     * @param updates Array of collateral factor parameters
     * @custom:error Reverts with EmptyBatch if the updates array is empty
     * @custom:event Emits CollateralFactorBatchExecuted
     */
    function executeCollateralFactorBatch(CollateralFactorParams[] memory updates) external {
        uint256 length = updates.length;
        if (length == 0) revert EmptyBatch();

        for (uint256 i; i < length; ++i) {
            CollateralFactorParams memory u = updates[i];
            COMPTROLLER.setCollateralFactor(u.vToken, u.newCollateralFactorMantissa, u.newLiquidationThresholdMantissa);
        }

        emit CollateralFactorBatchExecuted(length);
    }

    /**
     * @notice Execute a batch of liquidation incentive updates
     * @param updates Array of liquidation incentive parameters
     * @custom:error Reverts with EmptyBatch if the updates array is empty
     * @custom:event Emits LiquidationIncentiveBatchExecuted
     */
    function executeLiquidationIncentiveBatch(LiquidationIncentiveParams[] memory updates) external {
        uint256 length = updates.length;
        if (length == 0) revert EmptyBatch();

        for (uint256 i; i < length; ++i) {
            LiquidationIncentiveParams memory u = updates[i];
            COMPTROLLER.setLiquidationIncentive(u.vToken, u.newLiquidationIncentiveMantissa);
        }

        emit LiquidationIncentiveBatchExecuted(length);
    }

    /**
     * @notice Execute a batch of borrow allowed updates
     * @param updates Array of borrow allowed parameters
     * @custom:error Reverts with EmptyBatch if the updates array is empty
     * @custom:event Emits BorrowAllowedBatchExecuted
     */
    function executeBorrowAllowedBatch(BorrowAllowedParams[] memory updates) external {
        uint256 length = updates.length;
        if (length == 0) revert EmptyBatch();

        for (uint256 i; i < length; ++i) {
            BorrowAllowedParams memory u = updates[i];
            COMPTROLLER.setIsBorrowAllowed(u.poolId, u.vToken, u.borrowAllowed);
        }

        emit BorrowAllowedBatchExecuted(length);
    }
}
