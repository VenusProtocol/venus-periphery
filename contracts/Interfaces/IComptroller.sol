pragma solidity ^0.8.25;

import { ResilientOracleInterface } from "@venusprotocol/oracle/contracts/interfaces/OracleInterface.sol";
import { IVToken } from "./IVToken.sol";

interface IComptroller {
    enum Action {
        MINT,
        REDEEM,
        BORROW,
        REPAY,
        SEIZE,
        LIQUIDATE,
        TRANSFER,
        ENTER_MARKET,
        EXIT_MARKET
    }

    function setActionsPaused(address[] calldata markets_, Action[] calldata actions_, bool paused_) external;

    function setMarketBorrowCaps(address[] calldata vTokens, uint256[] calldata newBorrowCaps) external;

    function setMarketSupplyCaps(address[] calldata vTokens, uint256[] calldata newSupplyCaps) external;

    function unlistMarket(address vToken) external returns (uint256);

    function actionPaused(address market, Action action) external view returns (bool);

    function markets(address) external view returns (bool, uint256, bool);

    function oracle() external view returns (ResilientOracleInterface);

    function checkMembership(address account, IVToken vToken) external view returns (bool);

    function getBorrowingPower(
        address account
    ) external view returns (uint256 error, uint256 liquidity, uint256 shortfall);

    function treasuryPercent() external view returns (uint256);

    function executeFlashLoan(
        address payable onBehalf,
        address payable receiver,
        IVToken[] memory vTokens,
        uint256[] memory underlyingAmounts,
        bytes memory param
    ) external;

    function approvedDelegates(address borrower, address delegate) external view returns (bool);

    function enterMarkets(address[] calldata vTokens) external returns (uint256[] memory);

    function enterMarketBehalf(address onBehalf, address vToken) external returns (uint256);

    function enterMarket(address user, address vToken) external returns (uint256);

    function getAccountLiquidity(address account) external view returns (uint256, uint256, uint256);
}
