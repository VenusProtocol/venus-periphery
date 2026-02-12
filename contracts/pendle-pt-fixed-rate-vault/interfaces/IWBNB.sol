// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.25;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title Wrapped Native Token Interface
/// @notice IWBNB extends IERC20 with native token wrap/unwrap functions.
interface IWBNB is IERC20 {
    function deposit() external payable;

    function withdraw(uint256 wad) external;
}
