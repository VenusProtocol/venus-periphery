// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { AddressUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/AddressUpgradeable.sol";
import { IComptroller } from "../Interfaces.sol";
import { IPositionAccount } from "./IPositionAccount.sol";

/**
 * @title PositionAccount
 * @author Venus Protocol
 * @notice Minimal proxy contract that holds user funds for isolated Relative Trading positions
 * @dev This contract is deployed using the clones pattern for gas efficiency.
 *      It allows the RelativePositionManager to execute calls on behalf of the user.
 *      The constructor sets immutable values shared across all clones.
 *      The initialize function sets clone-specific data.
 */
contract PositionAccount is Initializable, IPositionAccount {
    using AddressUpgradeable for address;

    /// @notice Address of the Venus Comptroller (same for all clones)
    IComptroller public immutable COMPTROLLER;

    /// @notice Address of the authorized RelativePositionManager contract (same for all clones)
    address public immutable RELATIVE_POSITION_MANAGER;

    /// @notice Address of the LeverageStrategiesManager contract (same for all clones)
    address public immutable LEVERAGE_MANAGER;

    /// @notice Address of the position account owner (different for each clone)
    address public owner;

    /// @notice Address of the long asset vToken for this position
    address public longAsset;

    /// @notice Address of the short asset vToken for this position
    address public shortAsset;

    /**
     * @notice Emitted when a generic call is executed
     * @param caller Address that initiated the call
     * @param target Target contract address
     * @param data Call data executed
     */
    event GenericCallExecuted(address indexed caller, address target, bytes data);

    /// @notice Thrown when caller is not the authorized RelativePositionManager
    error UnauthorizedCaller();

    /// @notice Thrown when a zero address is provided as a parameter
    error ZeroAddress();

    /**
     * @notice Modifier to restrict access to only the RelativePositionManager
     */
    modifier onlyRelativePositionManager() {
        if (msg.sender != RELATIVE_POSITION_MANAGER) {
            revert UnauthorizedCaller();
        }
        _;
    }

    /**
     * @notice Constructor for the PositionAccount implementation contract
     * @dev This constructor is only called once for the implementation contract.
     *      Sets immutable values that are the same for all clones.
     * @param comptroller_ The Venus comptroller contract address
     * @param relativePositionManager_ Address of the RelativePositionManager contract
     * @param leverageManager_ Address of the LeverageStrategiesManager contract
     * @custom:error ZeroAddress if any of the addresses is zero.
     */
    constructor(IComptroller comptroller_, address relativePositionManager_, address leverageManager_) {
        if (
            address(comptroller_) == address(0) ||
            relativePositionManager_ == address(0) ||
            leverageManager_ == address(0)
        ) {
            revert ZeroAddress();
        }
        COMPTROLLER = comptroller_;
        RELATIVE_POSITION_MANAGER = relativePositionManager_;
        LEVERAGE_MANAGER = leverageManager_;

        // Prevent implementation contract from being initialized
        _disableInitializers();
    }

    /**
     * @notice Initializes a new position account clone
     * @dev Can only be called once per clone. Sets the owner, long/short assets, and delegates to both managers.
     * @param owner_ Address of the position account owner
     * @param longAsset_ Address of the long asset (vToken)
     * @param shortAsset_ Address of the short asset (vToken)
     * @custom:error ZeroAddress if any of the addresses is zero.
     */
    function initialize(address owner_, address longAsset_, address shortAsset_) external initializer {
        if (owner_ == address(0) || longAsset_ == address(0) || shortAsset_ == address(0)) {
            revert ZeroAddress();
        }

        owner = owner_;
        longAsset = longAsset_;
        shortAsset = shortAsset_;

        // Approve delegates for both managers to act on behalf of this account
        COMPTROLLER.updateDelegate(RELATIVE_POSITION_MANAGER, true);
        COMPTROLLER.updateDelegate(LEVERAGE_MANAGER, true);
    }

    /**
     * @notice Executes a generic call to any contract
     * @dev Only callable by the authorized RelativePositionManager contract.
     *      This allows the manager to perform operations on behalf of the user.
     *      Uses AddressUpgradeable.functionCall for safer execution.
     *      Automatically reverts if the call fails.
     * @param target Address of the contract to call
     * @param data Encoded function call data
     * @return returnData Return data from the call
     * @custom:error UnauthorizedCaller if caller is not the RelativePositionManager.
     * @custom:event Emits GenericCallExecuted.
     */
    function executeCall(
        address target,
        bytes calldata data
    ) external onlyRelativePositionManager returns (bytes memory returnData) {
        returnData = target.functionCall(data);

        emit GenericCallExecuted(msg.sender, target, data);
    }
}
