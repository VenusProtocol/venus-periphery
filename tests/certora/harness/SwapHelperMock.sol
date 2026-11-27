// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Stand-in for SwapHelper in the Certora specs. Its storage starts at any value, so one `multicall` can
///         send any two token amounts it holds to anyone and make one call back into SmartDCA, like a hostile
///         route. It reads each call's arguments the way SwapHelper does and records them, so a rule can check
///         what the route check let through. It cannot touch SmartDCA's storage or tokens directly.
contract SwapHelperMock {
    bytes4 internal constant GENERIC_CALL = bytes4(keccak256("genericCall(address,bytes)"));
    bytes4 internal constant APPROVE_MAX = bytes4(keccak256("approveMax(address,address)"));
    bytes4 internal constant SWEEP = bytes4(keccak256("sweep(address,address)"));

    // Token moves, any values
    address public tokenA;
    address public toA;
    uint256 public amountA;
    address public tokenB;
    address public toB;
    uint256 public amountB;

    // Call back into SmartDCA, any values
    bool public doCallback;
    address public callbackTarget;
    uint32 public callbackSelector;
    bytes public callbackArgs;
    bool public callbackSucceeded;

    // Arguments of each call in the last multicall, read as SwapHelper reads them
    uint256 public callsSeen;
    mapping(uint256 => uint32) public selectorAt;
    mapping(uint256 => address) public firstArgAt;
    mapping(uint256 => address) public secondArgAt;

    function multicall(bytes[] calldata calls, uint256, bytes32, bytes calldata) external {
        if (calls.length == 0) revert();
        callsSeen = calls.length;
        for (uint256 i; i < calls.length; ++i) {
            bytes calldata data = calls[i];
            bytes4 selector = bytes4(data[:4]);
            if (selector != GENERIC_CALL && selector != APPROVE_MAX && selector != SWEEP) revert();
            selectorAt[i] = uint32(selector);
            // Reverts on an address with junk in its top bytes, like SwapHelper's own decoding
            firstArgAt[i] = abi.decode(data[4:36], (address));
            if (selector != GENERIC_CALL) secondArgAt[i] = abi.decode(data[36:68], (address));
        }

        if (amountA != 0) IERC20(tokenA).transfer(toA, amountA);
        if (amountB != 0) IERC20(tokenB).transfer(toB, amountB);

        if (doCallback) {
            (callbackSucceeded, ) = callbackTarget.call(abi.encodePacked(bytes4(callbackSelector), callbackArgs));
        }
    }
}
