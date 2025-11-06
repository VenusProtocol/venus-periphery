// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

import { SafeERC20Upgradeable, IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import { AddressUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/AddressUpgradeable.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

import { IWBNB } from "../Interfaces.sol";

/**
 * @title SwapHelper
 * @author Venus Protocol
 * @notice Helper contract for executing multiple token operations atomically
 * @dev This contract provides utilities for wrapping native tokens, managing approvals,
 *      and executing arbitrary calls in a single transaction. It supports optional
 *      signature verification using EIP-712 for backend-authorized operations.
 *      All functions except multicall are designed to be called internally via multicall.
 * @custom:security-contact security@venus.io
 */
contract SwapHelper is EIP712, Ownable, ReentrancyGuard {
    using SafeERC20Upgradeable for IERC20Upgradeable;
    using AddressUpgradeable for address;

    /// @notice EIP-712 typehash for Multicall struct used in signature verification
    /// @dev keccak256("Multicall(bytes[] calls,uint256 deadline,bytes32 salt)")
    bytes32 internal constant MULTICALL_TYPEHASH = keccak256("Multicall(bytes[] calls,uint256 deadline,bytes32 salt)");

    /// @notice Wrapped native asset contract (e.g., WBNB, WETH)
    IWBNB public immutable WRAPPED_NATIVE;

    /// @notice Address authorized to sign multicall operations
    /// @dev Can be updated by contract owner via setBackendSigner
    address public backendSigner;

    /// @notice Mapping to track used salts for replay protection
    /// @dev Maps salt => bool to prevent reuse of same salt
    mapping(bytes32 => bool) public usedSalts;

    /// @notice Error thrown when transaction deadline has passed
    /// @dev Emitted when block.timestamp > deadline in multicall
    error DeadlineReached();

    /// @notice Error thrown when signature verification fails
    /// @dev Emitted when recovered signer doesn't match backendSigner
    error Unauthorized();

    /// @notice Error thrown when zero address is provided as parameter
    /// @dev Used in constructor and setBackendSigner validation
    error ZeroAddress();

    /// @notice Error thrown when salt has already been used
    /// @dev Prevents replay attacks by ensuring each salt is used only once
    error SaltAlreadyUsed();

    /// @notice Error thrown when caller is not authorized
    /// @dev Only owner or contract itself can call protected functions
    error CallerNotAuthorized();

    /// @notice Error thrown when no calls are provided to multicall
    /// @dev Emitted when calls array is empty in multicall
    error NoCallsProvided();

    /// @notice Error thrown when signature is missing but required
    /// @dev Emitted when signature length is zero but verification is expected
    error MissingSignature();

    /// @notice Event emitted when backend signer is updated
    /// @param oldSigner Previous backend signer address
    /// @param newSigner New backend signer address
    event BackendSignerUpdated(address indexed oldSigner, address indexed newSigner);

    /// @notice Event emitted when multicall is successfully executed
    /// @param caller Address that initiated the multicall
    /// @param callsCount Number of calls executed in the batch
    /// @param deadline Deadline timestamp used for the operation
    /// @param salt Salt used for replay protection
    event MulticallExecuted(address indexed caller, uint256 callsCount, uint256 deadline, bytes32 salt);

    /// @notice Constructor
    /// @param wrappedNative_ Address of the wrapped native asset contract
    /// @param backendSigner_ Address authorized to sign multicall operations
    /// @dev Initializes EIP-712 domain with name "VenusSwap" and version "1"
    /// @dev Transfers ownership to msg.sender
    /// @dev Reverts with ZeroAddress if either parameter is address(0)
    /// @custom:error ZeroAddress if wrappedNative_ is address(0)
    /// @custom:error ZeroAddress if backendSigner_ is address(0)
    constructor(address wrappedNative_, address backendSigner_) EIP712("VenusSwap", "1") {
        if (wrappedNative_ == address(0) || backendSigner_ == address(0)) {
            revert ZeroAddress();
        }

        WRAPPED_NATIVE = IWBNB(wrappedNative_);
        backendSigner = backendSigner_;
    }

    /// @notice Modifier to restrict access to owner or contract itself
    /// @dev Reverts with CallerNotAuthorized if caller is neither owner nor this contract
    modifier onlyOwnerOrSelf() {
        if (msg.sender != owner() && msg.sender != address(this)) {
            revert CallerNotAuthorized();
        }
        _;
    }

    /// @notice Multicall function to execute multiple calls in a single transaction
    /// @param calls Array of encoded function calls to execute on this contract
    /// @param deadline Unix timestamp after which the transaction will revert
    /// @param salt Unique value to ensure this exact multicall can only be executed once
    /// @param signature Optional EIP-712 signature from backend signer (empty bytes to skip verification)
    /// @dev All calls are executed atomically - if any call fails, entire transaction reverts
    /// @dev Calls must be to functions on this contract (address(this))
    /// @dev Signature verification is only performed if signature.length != 0
    /// @dev Protected by nonReentrant modifier to prevent reentrancy attacks
    /// @dev Emits MulticallExecuted event upon successful execution
    /// @custom:security Only the contract itself can call wrap, sweep, approveMax, and genericCall
    /// @custom:error NoCallsProvided if calls array is empty
    /// @custom:error DeadlineReached if block.timestamp > deadline
    /// @custom:error SaltAlreadyUsed if salt has been used before
    /// @custom:error Unauthorized if signature verification fails
    function multicall(
        bytes[] calldata calls,
        uint256 deadline,
        bytes32 salt,
        bytes calldata signature
    ) external payable nonReentrant {
        if (calls.length == 0) {
            revert NoCallsProvided();
        }

        if (block.timestamp > deadline) {
            revert DeadlineReached();
        }

        if (signature.length == 0) {
            revert MissingSignature();
        }
        if (usedSalts[salt]) {
            revert SaltAlreadyUsed();
        }
        usedSalts[salt] = true;

        bytes32 digest = _hashMulticall(calls, deadline, salt);
        address signer = ECDSA.recover(digest, signature);
        if (signer != backendSigner) {
            revert Unauthorized();
        }

        for (uint256 i = 0; i < calls.length; i++) {
            (bool success, bytes memory returnData) = address(this).call(calls[i]);
            if (!success) {
                assembly {
                    revert(add(returnData, 0x20), mload(returnData))
                }
            }
        }

        emit MulticallExecuted(msg.sender, calls.length, deadline, salt);
    }

    /// @notice Generic call function to execute a call to an arbitrary address
    /// @param target Address of the contract to call
    /// @param data Encoded function call data
    /// @dev This function can interact with any external contract
    /// @dev Should only be called via multicall for safety
    /// @custom:security Use with extreme caution - can call any contract with any data
    /// @custom:security Ensure proper validation of target and data in off-chain systems
    /// @custom:error CallerNotAuthorized if caller is not owner or contract itself
    function genericCall(address target, bytes calldata data) external payable onlyOwnerOrSelf {
        target.functionCall(data);
    }

    /// @notice Wraps native asset into an ERC-20 wrapped token
    /// @param amount Amount of native asset to wrap (must match msg.value)
    /// @dev Calls deposit() on WRAPPED_NATIVE contract with msg.value
    /// @dev Wrapped tokens remain in this contract until swept
    /// @dev Should only be called via multicall
    /// @custom:security Ensure msg.value matches amount parameter
    /// @custom:error CallerNotAuthorized if caller is not owner or contract itself
    function wrap(uint256 amount) external payable onlyOwnerOrSelf {
        WRAPPED_NATIVE.deposit{ value: amount }();
    }

    /// @notice Sweeps entire balance of an ERC-20 token to a specified address
    /// @param token ERC-20 token contract to sweep
    /// @param to Recipient address for the swept tokens
    /// @dev Transfers the entire balance of token held by this contract
    /// @dev Uses SafeERC20 for safe transfer operations
    /// @dev Should only be called via multicall
    /// @custom:error CallerNotAuthorized if caller is not owner or contract itself
    function sweep(IERC20Upgradeable token, address to) external onlyOwnerOrSelf {
        token.safeTransfer(to, token.balanceOf(address(this)));
    }

    /// @notice Approves maximum amount of an ERC-20 token to a specified spender
    /// @param token ERC-20 token contract to approve
    /// @param spender Address to grant approval to
    /// @dev Sets approval to type(uint256).max for unlimited spending
    /// @dev Uses forceApprove to handle tokens that require 0 approval first
    /// @dev Should only be called via multicall
    /// @custom:security Grants unlimited approval - ensure spender is trusted
    /// @custom:error CallerNotAuthorized if caller is not owner or contract itself
    function approveMax(IERC20Upgradeable token, address spender) external onlyOwnerOrSelf {
        token.forceApprove(spender, type(uint256).max);
    }

    /// @notice Updates the backend signer address
    /// @param newSigner New backend signer address
    /// @dev Only callable by contract owner
    /// @dev Reverts with ZeroAddress if newSigner is address(0)
    /// @dev Emits BackendSignerUpdated event
    /// @custom:error ZeroAddress if newSigner is address(0)
    /// @custom:error Ownable: caller is not the owner (from OpenZeppelin Ownable)
    function setBackendSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0)) {
            revert ZeroAddress();
        }
        address oldSigner = backendSigner;
        backendSigner = newSigner;

        emit BackendSignerUpdated(oldSigner, newSigner);
    }

    /// @notice Produces an EIP-712 digest of the multicall data
    /// @param calls Array of encoded function calls
    /// @param deadline Unix timestamp deadline
    /// @param salt Unique value to ensure replay protection
    /// @return EIP-712 typed data hash for signature verification
    /// @dev Hashes each call individually, then encodes with MULTICALL_TYPEHASH, deadline, and salt
    /// @dev Uses EIP-712 _hashTypedDataV4 for domain-separated hashing
    function _hashMulticall(bytes[] calldata calls, uint256 deadline, bytes32 salt) internal view returns (bytes32) {
        bytes32[] memory callHashes = new bytes32[](calls.length);
        for (uint256 i = 0; i < calls.length; i++) {
            callHashes[i] = keccak256(calls[i]);
        }
        return
            _hashTypedDataV4(
                keccak256(abi.encode(MULTICALL_TYPEHASH, keccak256(abi.encodePacked(callHashes)), deadline, salt))
            );
    }
}
