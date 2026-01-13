pragma solidity ^0.8.25;

import { ResilientOracleInterface } from "@venusprotocol/oracle/contracts/interfaces/OracleInterface.sol";

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
}
