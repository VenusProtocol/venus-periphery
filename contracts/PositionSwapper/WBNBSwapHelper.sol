// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.25;

import { IWBNB } from "../Interfaces.sol";
import { ISwapHelper } from "./ISwapHelper.sol";

/**
 * @title WBNBSwapHelper
 * @notice Swap helper that wraps or unwraps native BNB into WBNB for PositionSwapper.
 * @dev Only supports native token (BNB) wrapping into WBNB and unwrapping WBNB into BNB. Meant to be used only by the PositionSwapper.
 */
contract WBNBSwapHelper is ISwapHelper {
    /// @notice Address of the authorized PositionSwapper contract
    address public immutable POSITION_SWAPPER;

    /// @notice IWBNB contract instance used to wrap native BNB
    IWBNB public immutable WBNB;

    /**
     * @notice Emitted after native BNB is wrapped into WBNB and sent back to the swapper
     * @param amount Amount of BNB wrapped and transferred
     */
    event SwappedToWBNB(uint256 amount);

    /// @notice Error thrown when caller is not the authorized PositionSwapper
    error Unauthorized();

    /// @notice Error thrown when a non-native token address is passed to `swapInternal`
    error OnlyNativeSupported();

    /// @notice Error thrown when the `msg.value` does not match the specified amount
    error ValueMismatch();

    /// @notice Restricts function access to only the authorized PositionSwapper
    modifier onlySwapper() {
        if (msg.sender != POSITION_SWAPPER) revert Unauthorized();
        _;
    }

    constructor(address _wbnb, address _swapper) {
        WBNB = IWBNB(_wbnb);
        POSITION_SWAPPER = _swapper;
    }

    /// @notice Allows this contract to receive native BNB
    receive() external payable {}

    /**
     * @notice Swaps native BNB into WBNB and transfers it back to the swapper.
     * @dev Reverts if non-native input is passed. Only callable by PositionSwapper.
     * @param tokenFrom Address of the input token (must be zero for native BNB)
     * @param amount Amount of native BNB to wrap into WBNB
     */
    function swapInternal(address tokenFrom, address, uint256 amount) external payable override onlySwapper {
        if (tokenFrom != address(0)) revert OnlyNativeSupported();
        if (msg.value != amount) revert ValueMismatch();

        WBNB.deposit{ value: amount }();
        WBNB.transfer(msg.sender, amount);
        emit SwappedToWBNB(amount);
    }
}
