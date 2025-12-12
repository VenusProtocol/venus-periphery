// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.25;

import { IWBNB } from "../Interfaces.sol";
import { ISwapHelper } from "./ISwapHelper.sol";
import {
    SafeERC20Upgradeable,
    IERC20Upgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";

/**
 * @title WBNBSwapHelper
 * @notice Swap helper that wraps or unwraps native BNB into WBNB for PositionSwapper.
 * @dev Only supports native token (BNB) wrapping into WBNB and unwrapping WBNB into BNB. Meant to be used only by the PositionSwapper.
 */
contract WBNBSwapHelper is Ownable2Step, ISwapHelper {
    using SafeERC20Upgradeable for IERC20Upgradeable;

    /// @notice Address of the authorized PositionSwapper contract
    address public immutable POSITION_SWAPPER;

    /// @notice IWBNB contract instance used to wrap native BNB
    IWBNB public immutable WBNB;

    /**
     * @notice Emitted after native BNB is wrapped into WBNB and sent back to the swapper
     * @param amount Amount of BNB wrapped and transferred
     */
    event SwappedToWBNB(uint256 amount);

    /**
     * @notice Emitted after WBNB is unwrapped into native BNB and sent back to the swapper
     * @param amount Amount of WBNB unwrapped and transferred
     */
    event SwappedToBNB(uint256 amount);

    /**
     * @notice Emitted after the owner sweeps leftover ERC-20 tokens from the contract
     * @param token The token that was swept.
     * @param receiver The address that received the swept tokens.
     * @param amount The amount of tokens that were swept.
     */
    event SweepToken(address indexed token, address indexed receiver, uint256 amount);

    /**
     * @notice Emitted after the owner sweeps leftover native tokens (e.g., BNB) from the contract
     * @param receiver The address that received the swept native tokens.
     * @param amount The amount of native tokens that were swept.
     */
    event SweepNative(address indexed receiver, uint256 amount);

    /// @notice Error thrown when caller is not the authorized PositionSwapper
    error Unauthorized();

    /// @notice Error thrown when token other than native BNB or WBNB is used
    error TokenNotSupported();

    /// @notice Error thrown when the `msg.value` does not match the specified amount
    error ValueMismatch();

    /// @notice Error thrown when a transfer of BNB fails
    error TransferFailed();

    /// @notice Error thrown when a zero address is provided where it is not allowed
    error ZeroAddress();

    /// @notice Restricts function access to only the authorized PositionSwapper
    modifier onlySwapper() {
        if (msg.sender != POSITION_SWAPPER) revert Unauthorized();
        _;
    }

    constructor(address _wbnb, address _swapper) Ownable2Step() {
        if (_wbnb == address(0) || _swapper == address(0)) revert ZeroAddress();

        WBNB = IWBNB(_wbnb);
        POSITION_SWAPPER = _swapper;
    }

    /**
     * @notice Allows the owner to sweep leftover ERC-20 tokens from the contract.
     * @param token The token to sweep.
     * @custom:event Emits SweepToken event.
     */
    function sweepToken(IERC20Upgradeable token) external onlyOwner {
        uint256 balance = token.balanceOf(address(this));
        if (balance > 0) {
            token.safeTransfer(owner(), balance);
            emit SweepToken(address(token), owner(), balance);
        }
    }

    /**
     * @notice Allows the owner to sweep leftover native tokens (e.g., BNB) from the contract.
     * @custom:event Emits SweepNative event.
     */
    function sweepNative() external onlyOwner {
        uint256 balance = address(this).balance;
        if (balance > 0) {
            (bool success, ) = payable(owner()).call{ value: balance }("");
            if (!success) revert TransferFailed();
            emit SweepNative(owner(), balance);
        }
    }

    /// @notice Allows this contract to receive native BNB
    receive() external payable {}

    /**
     * @notice Swaps native BNB into WBNB or WBNB into BNB and transfers it back to the swapper.
     * @dev Only callable by PositionSwapper.
     * @param tokenFrom Address of the input token (must be zero for native BNB)
     * @param amount Amount to swap (must match `msg.value` for native BNB)
     * @custom:error TokenNotSupported if `tokenFrom` is neither zero (native BNB) nor WBNB address.
     * @custom:error ValueMismatch if `msg.value` does not match `amount` when `tokenFrom` is zero,
     *  or if `msg.value` is non-zero when `tokenFrom` is WBNB address.
     * @custom:error TransferFailed if the transfer of unwrapped BNB to the swapper fails.
     */
    function swapInternal(address tokenFrom, address, uint256 amount) external payable override onlySwapper {
        if (tokenFrom != address(0) && tokenFrom != address(WBNB)) revert TokenNotSupported();
        if (tokenFrom == address(0) && msg.value != amount) revert ValueMismatch();
        if (tokenFrom != address(0) && msg.value != 0) revert ValueMismatch();

        if (tokenFrom == address(0)) {
            WBNB.deposit{ value: amount }();
            WBNB.transfer(msg.sender, amount);
            emit SwappedToWBNB(amount);
        } else {
            WBNB.transferFrom(msg.sender, address(this), amount);
            WBNB.withdraw(amount);

            (bool success, ) = payable(msg.sender).call{ value: amount }("");
            if (!success) revert TransferFailed();

            emit SwappedToBNB(amount);
        }
    }
}
