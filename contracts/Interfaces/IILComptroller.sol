pragma solidity ^0.8.25;

import { IComptroller } from "./IComptroller.sol";

interface IILComptroller {
    function setCollateralFactor(
        address vToken,
        uint256 newCollateralFactorMantissa,
        uint256 newLiquidationThresholdMantissa
    ) external;
}
