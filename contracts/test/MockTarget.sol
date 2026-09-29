// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

/**
 * @title MockTarget
 * @notice Mock contract for testing genericCall functionality in SwapHelper
 * @dev Provides various functions that can succeed or fail for testing error propagation
 */
contract MockTarget {
    uint256 public value;
    address public lastCaller;
    bool public shouldFail;
    string public customRevertMessage;

    event ValueSet(uint256 newValue);
    event CallerRecorded(address caller);

    error CustomError(string message);
    error ZeroValueNotAllowed();

    constructor() {
        shouldFail = false;
        customRevertMessage = "MockTarget: forced failure";
    }

    /**
     * @notice Sets a value and emits an event
     * @param newValue The new value to set
     */
    function setValue(uint256 newValue) external {
        if (shouldFail) {
            revert CustomError(customRevertMessage);
        }
        value = newValue;
        lastCaller = msg.sender;
        emit ValueSet(newValue);
        emit CallerRecorded(msg.sender);
    }

    /**
     * @notice A function that always reverts with a custom error
     */
    function alwaysReverts() external pure {
        revert CustomError("This function always reverts");
    }

    /**
     * @notice A function that reverts with a require statement
     */
    function revertWithRequire() external pure {
        require(false, "MockTarget: require failed");
    }

    /**
     * @notice A function that reverts if value is zero
     */
    function revertOnZero(uint256 _value) external pure {
        if (_value == 0) {
            revert ZeroValueNotAllowed();
        }
    }

    /**
     * @notice Configure the contract to fail on next call
     */
    function setFailMode(bool _shouldFail) external {
        shouldFail = _shouldFail;
    }

    /**
     * @notice Set custom revert message
     */
    function setCustomRevertMessage(string calldata message) external {
        customRevertMessage = message;
    }

    /**
     * @notice A function that returns data
     */
    function getValues() external view returns (uint256, address) {
        return (value, lastCaller);
    }

    /**
     * @notice A payable function for testing
     */
    function payableFunction() external payable {
        value = msg.value;
    }

    /**
     * @notice A function that performs a callback to the caller
     * @dev Used for testing reentrancy scenarios
     */
    function callbackToCaller(bytes calldata data) external {
        (bool success, ) = msg.sender.call(data);
        require(success, "Callback failed");
    }
}
