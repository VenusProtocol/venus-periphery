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
 *
 * Functionality includes:
 *  - Pausing markets when deposits fall below a global threshold.
 *  - Unlisting markets once they are paused and have passed an expiry timestamp.
 *  - Both pausing and unlisting can be triggered permissionlessly.
 *  - Governance (via VIP) configures thresholds and expiry values.
 */
contract Undertaker is Ownable2Step {
    /**
     * @notice The global deposit threshold (in USD).
     * @dev If a market’s deposits fall below this threshold, it can be paused.
     */
    uint256 public globalDepositThreshold;

    /**
     * @notice Expiry timestamp for a market to be eligible for unlisting.
     * @dev Comptroller address => Market address => Expiry timestamp
     */
    mapping(address => mapping(address => uint256)) public marketExpiry;

    /**
     * @notice Emitted when a market is paused.
     * @param comptroller The address of the comptroller.
     * @param market The address of the market that was paused.
     */
    event MarketPaused(address indexed comptroller, address indexed market);

    /**
     * @notice Emitted when a market is unlisted.
     * @param comptroller The address of the comptroller.
     * @param market The address of the market that was unlisted.
     * @param expiryTimestamp The expiry timestamp after which the market was eligible for unlisting.
     */
    event MarketUnlisted(address indexed comptroller, address indexed market, uint256 expiryTimestamp);

    /**
     * @notice Emitted when the global deposit threshold is updated.
     * @param oldThreshold The previous global deposit threshold.
     * @param newThreshold The new global deposit threshold.
     */
    event GlobalDepositThresholdUpdated(uint256 oldThreshold, uint256 newThreshold);

    /**
     * @notice Emitted when the expiry timestamp for a market is set.
     * @param comptroller The address of the comptroller.
     * @param market The address of the market.
     * @param expiryTimestamp The new expiry timestamp for the market.
     */
    event MarketExpirySet(address indexed comptroller, address indexed market, uint256 expiryTimestamp);

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
     * @notice Sets the expiry timestamp for a market.
     * @dev Restricted to governance (VIP).
     *      The timestamp defines when the market becomes eligible for unlisting.
     * @param comptroller The address of the comptroller.
     * @param market The address of the market.
     * @param expiryTimestamp The timestamp after which the market can be unlisted.
     */
    function setMarketExpiry(address comptroller, address market, uint256 expiryTimestamp) external onlyOwner {
        marketExpiry[comptroller][market] = expiryTimestamp;
        emit MarketExpirySet(comptroller, market, expiryTimestamp);
    }

    /**
     * @notice Pauses a market if its total deposits fall below the global threshold.
     * @dev
     *  - Permissionless: can be called by anyone.
     *  - Sets the market’s Collateral Factor (CF) to 0.
     *  - Disables supplying, borrowing, and using the asset as collateral.
     *
     * Requirements:
     *  - Market must be eligible according to `canPauseMarket()`.
     *
     * @param comptroller The address of the comptroller.
     * @param market The address of the market to pause.
     */
    function pauseMarket(address comptroller, address market) external {
        if (!canPauseMarket(comptroller, market)) {
            revert MarketNotEligibleForPause();
        }

        // Pause the market by setting its collateral factor to 0
        IComptroller(comptroller).setCollateralFactor(IVToken(market), 0, 0);

        // Pause minting, borrowing, and entering the market
        IComptroller.Action[] memory actions = new IComptroller.Action[](3);
        actions[0] = IComptroller.Action.MINT;
        actions[1] = IComptroller.Action.BORROW;
        actions[2] = IComptroller.Action.ENTER_MARKET;

        address[] memory markets = new address[](1);
        markets[0] = market;

        IComptroller(comptroller).setActionsPaused(markets, actions, true);

        emit MarketPaused(comptroller, market);
    }

    /**
     * @notice Unlists a market if it has been paused and its expiry timestamp has passed.
     * @dev
     *  - Permissionless: can be called by anyone.
     *  - The market must already be in a paused state (whether paused via `pauseMarket()`
     *    or through any other valid process).
     *  - Requires that the current block timestamp is greater than `marketExpiry(comptroller, market)`.
     *
     * @param comptroller The address of the comptroller.
     * @param market The address of the market to unlist.
     */
    function unlistMarket(address comptroller, address market) external {
        if (!canUnlistMarket(comptroller, market)) {
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

        IComptroller(comptroller).setActionsPaused(markets, actions, true);

        // Set caps to 0 to prevent any further supply or borrow
        uint256[] memory caps = new uint256[](1);
        caps[0] = 0;

        IComptroller(comptroller).setMarketBorrowCaps(markets, caps);
        IComptroller(comptroller).setMarketSupplyCaps(markets, caps);

        IComptroller(comptroller).unlistMarket(market);

        emit MarketUnlisted(comptroller, market, marketExpiry[comptroller][market]);
    }

    /**
     * @notice Checks if a market is currently paused.
     * @param comptroller The address of the pool’s comptroller.
     * @param market The address of the market.
     * @return True if the market is paused
     */
    function isMarketPaused(address comptroller, address market) public view returns (bool) {
        // A market is considered paused if its collateral factor is 0 or if minting/borrowing/entering is paused
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
     * @param comptroller The address of the pool’s comptroller.
     * @param market The address of the market.
     * @return True if the market’s total deposits are below the global threshold and it is not already paused.
     */
    function canPauseMarket(address comptroller, address market) public view returns (bool) {
        // check if the deposits are below the threshold and if the market is not already paused

        ResilientOracleInterface oracle = IComptroller(comptroller).oracle();
        uint256 totalSupplied = (IVToken(market).totalSupply() * IVToken(market).exchangeRateStored()) / 1e18;
        uint256 price = oracle.getUnderlyingPrice(market);
        uint256 totalDepositsUSD = (totalSupplied * price) / 1e18;

        if (totalDepositsUSD > globalDepositThreshold) {
            return false;
        }

        if (
            IComptroller(comptroller).actionPaused(market, IComptroller.Action.MINT) ||
            IComptroller(comptroller).actionPaused(market, IComptroller.Action.BORROW) ||
            IComptroller(comptroller).actionPaused(market, IComptroller.Action.ENTER_MARKET)
        ) {
            return false;
        }

        (, uint256 collateralFactorMantissa, ) = IComptroller(comptroller).markets(market);
        if (collateralFactorMantissa == 0) {
            return false;
        }

        return true;
    }

    /**
     * @notice Checks if a market can currently be unlisted.
     * @param comptroller The address of the comptroller.
     * @param market The address of the market.
     * @return True if the market is paused and the current block timestamp is greater than `marketExpiry()`.
     */
    function canUnlistMarket(address comptroller, address market) public view returns (bool) {
        if (!isMarketPaused(comptroller, market)) {
            return false;
        }

        uint256 expiryTimestamp = marketExpiry[comptroller][market];
        if (expiryTimestamp == 0 || block.timestamp <= expiryTimestamp) {
            return false;
        }

        return true;
    }
}
