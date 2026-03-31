// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.25;

import { ResilientOracleInterface } from "@venusprotocol/oracle/contracts/interfaces/OracleInterface.sol";
import { IVToken } from "./IVToken.sol";

/// @title IComptroller
/// @author Venus Protocol
/// @notice Interface for the Venus Comptroller with market management and risk parameter functions.
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

    /// @notice Pause or unpause specific actions on given markets.
    /// @param markets_ The list of vToken market addresses.
    /// @param actions_ The list of actions to pause/unpause.
    /// @param paused_ True to pause, false to unpause.
    function setActionsPaused(address[] calldata markets_, Action[] calldata actions_, bool paused_) external;

    /// @notice Set borrow caps for the given markets.
    /// @param vTokens The list of vToken market addresses.
    /// @param newBorrowCaps The list of new borrow cap values.
    function setMarketBorrowCaps(address[] calldata vTokens, uint256[] calldata newBorrowCaps) external;

    /// @notice Set supply caps for the given markets.
    /// @param vTokens The list of vToken market addresses.
    /// @param newSupplyCaps The list of new supply cap values.
    function setMarketSupplyCaps(address[] calldata vTokens, uint256[] calldata newSupplyCaps) external;

    /// @notice Unlist a market from the comptroller.
    /// @param vToken The vToken market address to unlist.
    /// @return uint256 Error code (0 = success).
    function unlistMarket(address vToken) external returns (uint256);

    /// @notice Execute a flash loan.
    /// @param onBehalf The address on whose behalf the flash loan is executed.
    /// @param receiver The address receiving the flash loan funds.
    /// @param vTokens The list of vToken markets to borrow from.
    /// @param underlyingAmounts The list of underlying amounts to borrow.
    /// @param param Additional parameters for the flash loan callback.
    function executeFlashLoan(
        address payable onBehalf,
        address payable receiver,
        IVToken[] memory vTokens,
        uint256[] memory underlyingAmounts,
        bytes memory param
    ) external;

    /// @notice Enter multiple markets to use as collateral.
    /// @param vTokens The list of vToken market addresses to enter.
    /// @return uint256[] Error codes for each market (0 = success).
    function enterMarkets(address[] calldata vTokens) external returns (uint256[] memory);

    /// @notice Enter a market on behalf of another address.
    /// @param onBehalf The address to enter the market for.
    /// @param vToken The vToken market address.
    /// @return uint256 Error code (0 = success).
    function enterMarketBehalf(address onBehalf, address vToken) external returns (uint256);

    /// @notice Enter a market for a specific user (internal comptroller use).
    /// @param user The user address.
    /// @param vToken The vToken market address.
    /// @return uint256 Error code (0 = success).
    function enterMarket(address user, address vToken) external returns (uint256);

    /// @notice Check whether an action is paused on a given market.
    /// @param market The vToken market address.
    /// @param action The action to check.
    /// @return bool True if the action is paused.
    function actionPaused(address market, Action action) external view returns (bool);

    /// @notice Get market information for a given vToken.
    /// @param vToken The vToken market address.
    /// @return isListed Whether the market is listed.
    /// @return collateralFactorMantissa The collateral factor mantissa.
    /// @return isComped Whether the market receives COMP/XVS rewards.
    function markets(
        address vToken
    ) external view returns (bool isListed, uint256 collateralFactorMantissa, bool isComped);

    /// @notice Get the price oracle used by the comptroller.
    /// @return ResilientOracleInterface The oracle contract.
    function oracle() external view returns (ResilientOracleInterface);

    /// @notice Check if an account has entered a given market.
    /// @param account The account address.
    /// @param vToken The vToken market to check membership for.
    /// @return bool True if the account is a member of the market.
    function checkMembership(address account, IVToken vToken) external view returns (bool);

    /// @notice Get the borrowing power of an account.
    /// @param account The account address.
    /// @return error Error code (0 = success).
    /// @return liquidity The account's excess liquidity.
    /// @return shortfall The account's shortfall.
    function getBorrowingPower(
        address account
    ) external view returns (uint256 error, uint256 liquidity, uint256 shortfall);

    /// @notice Get the treasury fee percentage.
    /// @return uint256 The treasury percentage mantissa.
    function treasuryPercent() external view returns (uint256);

    /// @notice Get the borrow cap for a given market.
    /// @param vToken The vToken market address.
    /// @return uint256 The borrow cap.
    function borrowCaps(address vToken) external view returns (uint256);

    /// @notice Get the supply cap for a given market.
    /// @param vToken The vToken market address.
    /// @return uint256 The supply cap.
    function supplyCaps(address vToken) external view returns (uint256);

    /// @notice Check if a delegate is approved to borrow on behalf of a borrower.
    /// @param borrower The borrower address.
    /// @param delegate The delegate address.
    /// @return bool True if the delegate is approved.
    function approvedDelegates(address borrower, address delegate) external view returns (bool);

    /// @notice Get account liquidity information.
    /// @param account The account address.
    /// @return error Error code (0 = success).
    /// @return liquidity The account's excess liquidity.
    /// @return shortfall The account's shortfall.
    function getAccountLiquidity(
        address account
    ) external view returns (uint256 error, uint256 liquidity, uint256 shortfall);
}
