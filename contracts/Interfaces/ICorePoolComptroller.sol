pragma solidity ^0.8.25;

import { IComptroller } from "./IComptroller.sol";

interface ICorePoolComptroller is IComptroller {
    function setCollateralFactor(
        address vToken,
        uint256 newCollateralFactorMantissa,
        uint256 newLiquidationThresholdMantissa
    ) external returns (uint256);

    function setCollateralFactor(
        uint96 poolId,
        address vToken,
        uint256 newCollateralFactorMantissa,
        uint256 newLiquidationThresholdMantissa
    ) external returns (uint256);
}
