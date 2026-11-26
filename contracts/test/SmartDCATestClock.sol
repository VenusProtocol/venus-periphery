// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

import { SmartDCA } from "../SmartDCA/SmartDCA.sol";

/**
 * @title SmartDCATestClock
 * @author Venus
 * @notice SmartDCA on a short fixed clock, for testnet rehearsals: round `r` starts at
 *         `ANCHOR_TIME + r * ROUND_LENGTH` instead of the 15th of a month, and `forceBuy` opens
 *         `FORCE_BUY_DELAY` after a round's start. Storage, events and the ABI are SmartDCA's.
 */
contract SmartDCATestClock is SmartDCA {
    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    uint256 public immutable ROUND_LENGTH;
    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    uint256 public immutable ANCHOR_TIME;
    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    uint256 public immutable FORCE_BUY_DELAY;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(
        address comptroller,
        address hubRegistry,
        address oracle,
        address swapHelper,
        uint256 roundLength,
        uint256 anchorTime,
        uint256 forceBuyDelay
    ) SmartDCA(comptroller, hubRegistry, oracle, swapHelper) {
        if (roundLength == 0 || anchorTime == 0) revert InvalidParameter();
        ROUND_LENGTH = roundLength;
        ANCHOR_TIME = anchorTime;
        FORCE_BUY_DELAY = forceBuyDelay;
    }

    function roundStart(uint32 round) public view override returns (uint256) {
        return ANCHOR_TIME + round * ROUND_LENGTH;
    }

    function _latestStartedRound() internal view override returns (uint32) {
        if (block.timestamp < ANCHOR_TIME) return 0;
        return uint32((block.timestamp - ANCHOR_TIME) / ROUND_LENGTH);
    }

    function _fallbackDelay() internal view override returns (uint256) {
        return FORCE_BUY_DELAY;
    }
}
