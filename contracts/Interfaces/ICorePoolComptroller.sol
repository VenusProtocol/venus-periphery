// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.25;

import { IComptroller } from "./IComptroller.sol";

/// @title ICorePoolComptroller
/// @author Venus Protocol
/// @notice Interface for the Venus Core Pool Comptroller (Diamond proxy) with e-mode pool support.
interface ICorePoolComptroller is IComptroller {
    /// @notice Set collateral factor and liquidation threshold for a market in the core pool.
    /// @param vToken The vToken market address.
    /// @param newCollateralFactorMantissa The new collateral factor mantissa (scaled by 1e18).
    /// @param newLiquidationThresholdMantissa The new liquidation threshold mantissa (scaled by 1e18).
    /// @return uint256 Error code (0 = success).
    function setCollateralFactor(
        address vToken,
        uint256 newCollateralFactorMantissa,
        uint256 newLiquidationThresholdMantissa
    ) external returns (uint256);

    /// @notice Set collateral factor and liquidation threshold for a market in a specific pool.
    /// @param poolId The pool identifier (0 = core pool, >0 = e-mode pools).
    /// @param vToken The vToken market address.
    /// @param newCollateralFactorMantissa The new collateral factor mantissa (scaled by 1e18).
    /// @param newLiquidationThresholdMantissa The new liquidation threshold mantissa (scaled by 1e18).
    /// @return uint256 Error code (0 = success).
    function setCollateralFactor(
        uint96 poolId,
        address vToken,
        uint256 newCollateralFactorMantissa,
        uint256 newLiquidationThresholdMantissa
    ) external returns (uint256);

    /// @notice Remove a market from a specific pool.
    /// @param poolId The pool identifier.
    /// @param vToken The vToken market address to remove.
    function removePoolMarket(uint96 poolId, address vToken) external;

    /// @notice Pause or unpause flash loans globally.
    /// @param paused True to pause, false to unpause.
    function setFlashLoanPaused(bool paused) external;

    /// @notice Enable or disable borrowing for a specific market in a specific pool.
    /// @dev Independent from the global `_actionPaused[market][BORROW]` flag — both must
    ///      allow borrowing for borrows to actually proceed in a given pool/market.
    /// @param poolId The pool identifier (0 = core pool, >0 = e-mode pools).
    /// @param vToken The vToken market address.
    /// @param borrowAllowed True to allow borrowing, false to disable it.
    function setIsBorrowAllowed(uint96 poolId, address vToken, bool borrowAllowed) external;

    /// @notice Add or remove an account from the flash loan whitelist.
    /// @param account The account address.
    /// @param isWhiteListed True to whitelist, false to revoke.
    function setWhiteListFlashLoanAccount(address account, bool isWhiteListed) external;

    /// @notice Get the core pool identifier.
    /// @return uint96 The core pool ID.
    function corePoolId() external view returns (uint96);

    /// @notice Get market data for a specific pool and vToken.
    /// @param poolId The pool identifier.
    /// @param vToken The vToken market address.
    /// @return isListed Whether the market is listed in the pool.
    /// @return collateralFactorMantissa The collateral factor mantissa.
    /// @return isVenus Whether the market is a Venus market.
    /// @return liquidationThresholdMantissa The liquidation threshold mantissa.
    /// @return liquidationIncentiveMantissa The liquidation incentive mantissa.
    /// @return marketPoolId The pool ID the market belongs to.
    /// @return isBorrowAllowed Whether borrowing is allowed.
    function poolMarkets(
        uint96 poolId,
        address vToken
    )
        external
        view
        returns (
            bool isListed,
            uint256 collateralFactorMantissa,
            bool isVenus,
            uint256 liquidationThresholdMantissa,
            uint256 liquidationIncentiveMantissa,
            uint96 marketPoolId,
            bool isBorrowAllowed
        );

    /// @notice Get the last pool ID created.
    /// @return uint96 The last pool ID.
    function lastPoolId() external view returns (uint96);
}
