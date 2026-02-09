pragma solidity ^0.8.25;

interface IILComptroller {
    struct Market {
        bool isListed;
        uint256 collateralFactorMantissa;
        uint256 liquidationThresholdMantissa;
    }

    function setCollateralFactor(
        address vToken,
        uint256 newCollateralFactorMantissa,
        uint256 newLiquidationThresholdMantissa
    ) external;

    function markets(address) external view returns (Market memory);
}
