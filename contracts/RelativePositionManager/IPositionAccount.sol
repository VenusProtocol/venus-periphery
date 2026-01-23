// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;
import { IComptroller } from "../Interfaces.sol";

/**
 * @title IPositionAccount
 * @author Venus Protocol
 * @notice Interface for Position Account contracts
 * @dev Minimal proxy contracts that hold user funds and execute operations on behalf of users
 *      in the Venus protocol. These contracts are deployed deterministically using clones.
 */
interface IPositionAccount {
    /**
     * @notice Initializes a new position account clone
     * @dev Can only be called once per clone. Sets the owner, long/short assets, and delegates to manager.
     * @param owner_ Address of the position account owner
     * @param longAsset_ Address of the long asset (vToken)
     * @param shortAsset_ Address of the short asset (vToken)
     */
    function initialize(address owner_, address longAsset_, address shortAsset_) external;

    /**
     * @notice Executes a generic call to any contract
     * @dev Only callable by the authorized RelativePositionManager contract
     * @param target Address of the contract to call
     * @param data Encoded function call data
     * @return returnData Return data from the call
     */
    function executeCall(address target, bytes calldata data) external returns (bytes memory returnData);

    /**
     * @notice Gets the Comptroller contract
     * @return Address of the Venus Comptroller
     */
    function COMPTROLLER() external view returns (IComptroller);

    /**
     * @notice Gets the authorized RelativePositionManager contract
     * @return Address of the RelativePositionManager contract
     */
    function RELATIVE_POSITION_MANAGER() external view returns (address);

    /**
     * @notice Gets the LeverageStrategiesManager contract
     * @return Address of the LeverageStrategiesManager contract
     */
    function LEVERAGE_MANAGER() external view returns (address);

    /**
     * @notice Gets the owner of this position account
     * @return owner Address of the position account owner
     */
    function owner() external view returns (address owner);

    /**
     * @notice Gets the long asset (vToken) for this position
     * @return longAsset Address of the long asset vToken
     */
    function longAsset() external view returns (address longAsset);

    /**
     * @notice Gets the short asset (vToken) for this position
     * @return shortAsset Address of the short asset vToken
     */
    function shortAsset() external view returns (address shortAsset);
}
