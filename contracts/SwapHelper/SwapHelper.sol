// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.25;

import { SafeERC20Upgradeable, IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import { AddressUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/AddressUpgradeable.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import { IWBNB } from "../Interfaces.sol";

contract SwapHelper is EIP712 {
    using SafeERC20Upgradeable for IERC20Upgradeable;
    using AddressUpgradeable for address;

    uint256 internal constant REENTRANCY_LOCK_UNLOCKED = 1;
    uint256 internal constant REENTRANCY_LOCK_LOCKED = 2;
    bytes32 internal constant MULTICALL_TYPEHASH = keccak256("Multicall(bytes[] calls,uint256 deadline)");

    /// @notice Wrapped native asset
    IWBNB public immutable WRAPPED_NATIVE;

    /// @notice Venus backend signer
    address public immutable BACKEND_SIGNER;

    /// @dev Reentrancy lock to prevent reentrancy attacks
    uint256 private reentrancyLock;

    /// @notice Error thrown when reentrancy is detected
    error Reentrancy();

    /// @notice Error thrown when deadline is reached
    error DeadlineReached();

    /// @notice Error thrown when caller is not the authorized backend signer
    error Unauthorized();

    /// @notice In the locked state, allow contract to call itself, but block all external calls
    modifier externalLock() {
        bool isExternal = msg.sender != address(this);

        if (isExternal) {
            if (reentrancyLock == REENTRANCY_LOCK_LOCKED) revert Reentrancy();
            reentrancyLock = REENTRANCY_LOCK_LOCKED;
        }

        _;

        if (isExternal) reentrancyLock = REENTRANCY_LOCK_UNLOCKED;
    }

    /// @notice Constructor
    /// @param wrappedNative_ Address of the wrapped native asset
    /// @param backendSigner_ Address of the backend signer
    constructor(address wrappedNative_, address backendSigner_) EIP712("VenusSwap", "1") {
        WRAPPED_NATIVE = IWBNB(wrappedNative_);
        BACKEND_SIGNER = backendSigner_;
    }

    /// @notice Multicall function to execute multiple calls in a single transaction
    /// @param calls Array of calldata to execute
    /// @param deadline Deadline for the transaction
    /// @param signature Backend signature
    function multicall(
        bytes[] calldata calls,
        uint256 deadline,
        bytes calldata signature
    ) external payable externalLock {
        if (block.timestamp > deadline) {
            revert DeadlineReached();
        }

        if (signature.length != 0) {
            bytes32 digest = _hashMulticall(calls, deadline);
            address signer = ECDSA.recover(digest, signature);
            if (signer != BACKEND_SIGNER) {
                revert Unauthorized();
            }
        }

        for (uint256 i = 0; i < calls.length; i++) {
            address(this).functionCall(calls[i]);
        }
    }

    /// @notice Generic call function to execute a call to an arbitrary address
    /// @param target Address to call
    /// @param data Calldata to execute
    function genericCall(address target, bytes calldata data) external externalLock {
        target.functionCall(data);
    }

    /// @notice Wraps native asset into an ERC-20 token
    /// @param amount Amount of native asset to wrap
    function wrap(uint256 amount) external externalLock {
        WRAPPED_NATIVE.deposit{ value: amount }();
    }

    /// @notice Sweeps an ERC-20 token to a specified address
    /// @param token ERC-20 token to sweep
    /// @param to Address to send the token to
    function sweep(IERC20Upgradeable token, address to) external externalLock {
        token.safeTransfer(to, token.balanceOf(address(this)));
    }

    /// @notice Approves the maximum amount of an ERC-20 token to a specified address
    /// @param token ERC-20 token to approve
    /// @param spender Address to approve the token to
    function approveMax(IERC20Upgradeable token, address spender) external externalLock {
        token.forceApprove(spender, 0);
        token.forceApprove(spender, type(uint256).max);
    }

    /// @notice Produces an EIP-712 digest of the multicall data
    /// @param calls Array of calldata to execute
    /// @param deadline Deadline for the transaction
    /// @return Digest of the multicall data
    function _hashMulticall(bytes[] calldata calls, uint256 deadline) internal view returns (bytes32) {
        bytes32[] memory callHashes = new bytes32[](calls.length);
        for (uint256 i = 0; i < calls.length; i++) {
            callHashes[i] = keccak256(calls[i]);
        }
        return
            _hashTypedDataV4(
                keccak256(abi.encode(MULTICALL_TYPEHASH, keccak256(abi.encodePacked(callHashes)), deadline))
            );
    }
}
