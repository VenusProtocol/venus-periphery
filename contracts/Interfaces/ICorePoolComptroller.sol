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

    function removePoolMarket(uint96 poolId, address vToken) external;

    function corePoolId() external view returns (uint96);

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

    function lastPoolId() external view returns (uint96);
}
