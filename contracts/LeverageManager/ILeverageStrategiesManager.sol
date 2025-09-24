// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

import { IVToken } from "../Interfaces.sol";

interface ILeverageStrategiesManager {
    /// @custom:error EnterLeveragePositionFailed
    error EnterLeveragePositionFailed();

    /// @custom:error ExitLeveragePositionFailed
    error ExitLeveragePositionFailed();

    /// @custom:error LeverageCausesLiquidation
    error LeverageCausesLiquidation();

    /// @custom:error SwapCallFailed
    error SwapCallFailed();

    /// @custom:error Unauthorized Caller is neither the user nor an approved delegate.
    error Unauthorized();

    /// @custom:error FlashLoanAssetOrAmountMismatch
    error FlashLoanAssetOrAmountMismatch();

    function enterLeveragedPosition(
        IVToken collateralMarket,
        uint256 collateralAmountSeed,
        IVToken borrowedMarket,
        uint256 borrowedAmountToFlashLoan,
        bytes[] calldata swapData
    ) external;

    function exitLeveragedPosition(
        IVToken collateralMarket,
        uint256 collateralAmountToRedeemForSwap,
        IVToken borrowedMarket,
        uint256 borrowedAmountToFlashLoan,
        bytes[] calldata swapData
    ) external;
}
