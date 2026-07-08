// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.25;

/**
 * @title IILComptroller
 * @notice Interface for Isolated Lending (IL) comptrollers.
 * @dev IL comptrollers differ from the Diamond proxy: markets() returns a 3-value tuple
 *      and setCollateralFactor returns void instead of uint256.
 */
interface IILComptroller {
    /// @notice Market metadata returned by the IL comptroller.
    /// @param isListed Whether the market is listed.
    /// @param collateralFactorMantissa The collateral factor (scaled by 1e18).
    /// @param liquidationThresholdMantissa The liquidation threshold (scaled by 1e18).
    struct Market {
        bool isListed;
        uint256 collateralFactorMantissa;
        uint256 liquidationThresholdMantissa;
    }

    /// @notice Set the collateral factor and liquidation threshold for a market.
    /// @param vToken The vToken market address.
    /// @param newCollateralFactorMantissa The new collateral factor (scaled by 1e18).
    /// @param newLiquidationThresholdMantissa The new liquidation threshold (scaled by 1e18).
    function setCollateralFactor(
        address vToken,
        uint256 newCollateralFactorMantissa,
        uint256 newLiquidationThresholdMantissa
    ) external;

    /// @notice Get the market metadata for a vToken.
    /// @param vToken The vToken market address.
    /// @return market The market metadata.
    function markets(address vToken) external view returns (Market memory market);
}
