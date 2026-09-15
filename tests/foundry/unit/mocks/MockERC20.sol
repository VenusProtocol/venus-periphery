// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.25;

// solhint-disable func-name-mixedcase, ordering, import-path-check, avoid-low-level-calls, no-inline-assembly
// solhint-disable gas-strict-inequalities, immutable-vars-naming, no-empty-blocks, gas-custom-errors

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Minimal mintable/burnable ERC-20 with configurable decimals for tests.
contract MockERC20 is ERC20 {
    uint8 private immutable _DECIMALS;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _DECIMALS = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _DECIMALS;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }
}
