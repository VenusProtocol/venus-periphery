// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.25;

import { ResilientOracleInterface } from "@venusprotocol/oracle/contracts/interfaces/OracleInterface.sol";
import { IVToken, IComptroller } from "../Interfaces.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";

/**
 * @title Undertaker
 * @author Venus
 * @notice Undertaker contract.
 *
 * @dev
 * The Undertaker contract is responsible for pausing and unlisting markets
 * in a permissionless manner, without requiring additional VIP approvals.
 */
contract Undertaker is Ownable2Step {
    struct Expiry {
        uint256 toBePausedAfterTimestamp;
        bool canUnlist;
        uint256 toBeUnlistedMinTotalSupplyUSD;
        uint256 pauseTimestamp;
        uint256 unlistTimestamp;
    }

    /**
     * @notice The global deposit threshold (in USD).
     * @dev If a market’s deposits fall below this threshold, it can be paused.
     */
    uint256 public globalDepositThreshold;

    /**
     * @notice Mapping to store expiry configurations for markets.
     * @dev vToken address => expiry configuration.
     */
    mapping(address => Expiry) public expiries;

    /**
     * @notice Emitted when a market is paused.
     * @param market The address of the market that was paused.
     */
    event MarketPaused(address indexed market);

    /**
     * @notice Emitted when a market is unlisted.
     * @param market The address of the market that was unlisted.
     */
    event MarketUnlisted(address indexed market);

    /**
     * @notice Emitted when the global deposit threshold is updated.
     * @param oldThreshold The previous global deposit threshold.
     * @param newThreshold The new global deposit threshold.
     */
    event GlobalDepositThresholdUpdated(uint256 oldThreshold, uint256 newThreshold);

    /**
     * @notice Emitted when the expiry configuration for a market is updated.
     * @param market The address of the market.
     * @param toBePausedAfterTimestamp The timestamp after which the market can be paused.
     * @param canUnlist If the market can be unlisted after being paused.
     * @param toBeUnlistedMinTotalSupplyUSD The minimum total supply (in USD) required for the market to be unlisted.
     */
    event MarketExpiryUpdated(
        address indexed market,
        uint256 toBePausedAfterTimestamp,
        bool canUnlist,
        uint256 toBeUnlistedMinTotalSupplyUSD
    );

    /// @notice Thrown when the expiry configuration provided is invalid.
    error InvalidExpiryConfiguration();

    /// @notice Thrown when attempting to pause a market that is not eligible.
    error MarketNotEligibleForPause();

    /// @notice Thrown when attempting to unlist a market that is not eligible.
    error MarketNotEligibleForUnlisting();

    constructor() Ownable2Step() {}

    /**
     * @notice Updates the global deposit threshold (in USD).
     * @dev Restricted to governance (VIP).
     *      Defines the minimum deposit level required to keep a market active.
     * @param newThreshold The new threshold value.
     */
    function setGlobalDepositThreshold(uint256 newThreshold) external onlyOwner {
        emit GlobalDepositThresholdUpdated(globalDepositThreshold, newThreshold);
        globalDepositThreshold = newThreshold;
    }

    /**
     * @notice Sets the expiry configuration for a market.
     * @param market The address of the market.
     * @param toBePausedAfterTimestamp The timestamp after which the market can be paused.
     * @param canUnlist If the market can be unlisted after being paused.
     * @param toBeUnlistedMinTotalSupplyUSD The minimum total supply (in USD) required for the market to be unlisted.
     */
    function setMarketExpiry(
        address market,
        uint256 toBePausedAfterTimestamp,
        bool canUnlist,
        uint256 toBeUnlistedMinTotalSupplyUSD
    ) external onlyOwner {
        if (toBePausedAfterTimestamp < block.timestamp) {
            revert InvalidExpiryConfiguration();
        }

        if (canUnlist && toBeUnlistedMinTotalSupplyUSD == 0) {
            revert InvalidExpiryConfiguration();
        }

        expiries[market] = Expiry({
            toBePausedAfterTimestamp: toBePausedAfterTimestamp,
            canUnlist: canUnlist,
            toBeUnlistedMinTotalSupplyUSD: toBeUnlistedMinTotalSupplyUSD,
            pauseTimestamp: 0,
            unlistTimestamp: 0
        });
        emit MarketExpiryUpdated(market, toBePausedAfterTimestamp, canUnlist, toBeUnlistedMinTotalSupplyUSD);
    }

    /**
     * @notice Pauses a market if the criteria are met.
     * @param market The address of the market to pause.
     */
    function pauseMarket(address market) external {
        if (!canPauseMarket(market)) {
            revert MarketNotEligibleForPause();
        }

        // Pause the market by setting its collateral factor to 0
        IComptroller comptroller = IVToken(market).comptroller();
        comptroller.setCollateralFactor(IVToken(market), 0, 0);

        // Pause minting, borrowing, and entering the market
        IComptroller.Action[] memory actions = new IComptroller.Action[](3);
        actions[0] = IComptroller.Action.MINT;
        actions[1] = IComptroller.Action.BORROW;
        actions[2] = IComptroller.Action.ENTER_MARKET;

        address[] memory markets = new address[](1);
        markets[0] = market;

        comptroller.setActionsPaused(markets, actions, true);

        expiries[market].pauseTimestamp = block.timestamp;

        emit MarketPaused(market);
    }

    /**
     * @notice Unlists a market if the criteria are met.
     * @param market The address of the market to unlist.
     */
    function unlistMarket(address market) external {
        if (!canUnlistMarket(market)) {
            revert MarketNotEligibleForUnlisting();
        }

        // Pause rest of the actions to effectively unlist the market
        IComptroller.Action[] memory actions = new IComptroller.Action[](6);
        actions[0] = IComptroller.Action.REDEEM;
        actions[1] = IComptroller.Action.REPAY;
        actions[2] = IComptroller.Action.SEIZE;
        actions[3] = IComptroller.Action.LIQUIDATE;
        actions[4] = IComptroller.Action.TRANSFER;
        actions[5] = IComptroller.Action.EXIT_MARKET;

        address[] memory markets = new address[](1);
        markets[0] = market;

        IComptroller comptroller = IVToken(market).comptroller();
        IComptroller(comptroller).setActionsPaused(markets, actions, true);

        // Set caps to 0 to prevent any further supply or borrow
        uint256[] memory caps = new uint256[](1);
        caps[0] = 0;

        IComptroller(comptroller).setMarketBorrowCaps(markets, caps);
        IComptroller(comptroller).setMarketSupplyCaps(markets, caps);

        IComptroller(comptroller).unlistMarket(market);

        emit MarketUnlisted(market);
    }

    /**
     * @notice Checks if a market is currently paused.
     * @param market The address of the market.
     * @return True if the market is paused
     */
    function isMarketPaused(address market) public view returns (bool) {
        IComptroller comptroller = IVToken(market).comptroller();
        (, uint256 collateralFactorMantissa, ) = IComptroller(comptroller).markets(market);

        if (
            collateralFactorMantissa == 0 &&
            IComptroller(comptroller).actionPaused(market, IComptroller.Action.MINT) &&
            IComptroller(comptroller).actionPaused(market, IComptroller.Action.BORROW) &&
            IComptroller(comptroller).actionPaused(market, IComptroller.Action.ENTER_MARKET)
        ) {
            return true;
        }

        return false;
    }

    /**
     * @notice Checks if a market can currently be paused.
     * @param market The address of the market.
     * @return True if the market’s total deposits are below the global threshold and it is not already paused.
     */
    function canPauseMarket(address market) public view returns (bool) {
        Expiry memory expiry = expiries[market];

        if (expiry.toBePausedAfterTimestamp != 0 && block.timestamp < expiry.toBePausedAfterTimestamp) {
            return false;
        }

        if (expiry.pauseTimestamp != 0) {
            return false;
        }

        IComptroller comptroller = IVToken(market).comptroller();

        if (expiry.toBePausedAfterTimestamp == 0) {
            ResilientOracleInterface oracle = comptroller.oracle();
            uint256 totalSupplied = (IVToken(market).totalSupply() * IVToken(market).exchangeRateStored()) / 1e18;
            uint256 price = oracle.getUnderlyingPrice(market);
            uint256 totalDepositsUSD = (totalSupplied * price) / 1e18;

            if (totalDepositsUSD > globalDepositThreshold) {
                return false;
            }
        }

        if (
            comptroller.actionPaused(market, IComptroller.Action.MINT) ||
            comptroller.actionPaused(market, IComptroller.Action.BORROW) ||
            comptroller.actionPaused(market, IComptroller.Action.ENTER_MARKET)
        ) {
            return false;
        }

        (, uint256 collateralFactorMantissa, ) = comptroller.markets(market);
        if (collateralFactorMantissa == 0) {
            return false;
        }

        return true;
    }

    /**
     * @notice Checks if a market can currently be unlisted.
     * @param market The address of the market.
     * @return True if the market is paused and the current block timestamp is greater than `marketExpiry()`.
     */
    function canUnlistMarket(address market) public view returns (bool) {
        if (!isMarketPaused(market)) {
            return false;
        }

        Expiry memory expiry = expiries[market];

        if (!expiry.canUnlist) {
            return false;
        }

        if (expiry.unlistTimestamp != 0) {
            return false;
        }

        IComptroller comptroller = IVToken(market).comptroller();
        ResilientOracleInterface oracle = comptroller.oracle();
        uint256 totalSupplied = (IVToken(market).totalSupply() * IVToken(market).exchangeRateStored()) / 1e18;
        uint256 price = oracle.getUnderlyingPrice(market);
        uint256 totalDepositsUSD = (totalSupplied * price) / 1e18;

        if (totalDepositsUSD > expiry.toBeUnlistedMinTotalSupplyUSD) {
            return false;
        }

        return true;
    }
}
