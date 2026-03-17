pragma solidity ^0.8.25;

import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { IComptroller } from "./IComptroller.sol";

interface IVToken is IERC20Upgradeable {
    function accrueInterest() external returns (uint256);

    function redeem(uint256 redeemTokens) external returns (uint256);

    function redeemUnderlying(uint256 redeemAmount) external returns (uint256);

    function borrowBalanceCurrent(address borrower) external returns (uint256);

    function balanceOfUnderlying(address owner) external returns (uint256);

    function seize(address liquidator, address borrower, uint seizeTokens) external returns (uint);

    function mintBehalf(address receiver, uint mintAmount) external returns (uint);

    function borrowBehalf(address borrower, uint borrowAmount) external returns (uint256);

    function comptroller() external view returns (IComptroller);

    function borrowBalanceStored(address account) external view returns (uint256);

    function underlying() external view returns (address);

    function exchangeRateStored() external view returns (uint256);

    function repayBorrowBehalf(address borrower, uint repayAmount) external returns (uint256);

    function redeemUnderlyingBehalf(address redeemer, uint redeemAmount) external returns (uint);
}
