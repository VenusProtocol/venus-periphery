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
    /**
     * @dev Expiry configuration for a market.
     */
    struct Expiry {
        /// @notice When set (>0), the market may be paused after this UNIX timestamp.
        uint256 toBePausedAfterTimestamp;
        /// @notice Whether the market is allowed to be unlisted after being paused.
        bool canUnlist;
        /// @notice When `canUnlist` is true, the market is eligible to be unlisted only if the total value of supplied assets (in USD) falls below this threshold.
        uint256 toBeUnlistedMinTotalSupplyUSD;
        /// @notice Timestamp when the market was paused (0 if not paused).
        uint256 pauseTimestamp;
        /// @notice Timestamp when the market was unlisted (0 if still listed).
        uint256 unlistTimestamp;
    }

    /// @dev Base unit for computations, usually used in scaling (multiplications, divisions)
    uint256 private constant EXP_SCALE = 1e18;

    /**
     * @notice Global deposit threshold (denominated in USD).
     * @dev If a market does not have `toBePausedAfterTimestamp` set and its total deposits drop below this threshold,
     * the market can be paused.
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
     * @param toBeUnlistedMinTotalSupplyUSD The minimum total market supply (in USD) required to keep the market listed.
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

    /// @notice Thrown when the market is not listed.
    error MarketNotListed();

    constructor() Ownable2Step() {}

    /**
     * @notice Updates the global deposit threshold (in USD).
     * @dev Restricted to governance (VIP).
     *      Defines the minimum deposit level required to keep a market active.
     * @param newThreshold The new threshold value.
     * @custom:event Emits GlobalDepositThresholdUpdated event.
     */
    function setGlobalDepositThreshold(uint256 newThreshold) external onlyOwner {
        emit GlobalDepositThresholdUpdated(globalDepositThreshold, newThreshold);
        globalDepositThreshold = newThreshold;
    }

    /**
     * @notice Sets the expiry configuration for a market.
     * @dev Restricted to governance (VIP).
     * @param market The address of the market.
     * @param toBePausedAfterTimestamp The timestamp after which the market can be paused.
     * @param canUnlist If the market can be unlisted after being paused.
     * @param toBeUnlistedMinTotalSupplyUSD The minimum total market supply (in USD) required to keep the market listed.
     * @custom:error MarketNotListed Thrown if the market is not listed.
     * @custom:error InvalidExpiryConfiguration Thrown if the configuration is invalid.
     * @custom:event Emits MarketExpiryUpdated event.
     */
    function setMarketExpiry(
        address market,
        uint256 toBePausedAfterTimestamp,
        bool canUnlist,
        uint256 toBeUnlistedMinTotalSupplyUSD
    ) external onlyOwner {
        (bool isListed, , ) = IVToken(market).comptroller().markets(market);
        if (!isListed) {
            revert MarketNotListed();
        }

        if (toBePausedAfterTimestamp < block.timestamp) {
            revert InvalidExpiryConfiguration();
        }

        if (!canUnlist && toBeUnlistedMinTotalSupplyUSD != 0) {
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
     * @custom:error MarketNotEligibleForPause Thrown if the market is not eligible for pausing.
     * @custom:event Emits MarketPaused event.
     */
    function pauseMarket(address market) external {
        IVToken(market).accrueInterest();

        if (!canPauseMarket(market)) {
            revert MarketNotEligibleForPause();
        }

        IComptroller comptroller = IVToken(market).comptroller();
        comptroller.setCollateralFactor(IVToken(market), 0, 0);

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
     * @custom:error MarketNotEligibleForUnlisting Thrown if the market is not eligible for unlisting.
     * @custom:event Emits MarketUnlisted event.
     */
    function unlistMarket(address market) external {
        IVToken(market).accrueInterest();

        if (!canUnlistMarket(market)) {
            revert MarketNotEligibleForUnlisting();
        }

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
        comptroller.setActionsPaused(markets, actions, true);

        uint256[] memory caps = new uint256[](1);
        caps[0] = 0;

        comptroller.setMarketBorrowCaps(markets, caps);
        comptroller.setMarketSupplyCaps(markets, caps);

        comptroller.unlistMarket(market);

        expiries[market].unlistTimestamp = block.timestamp;

        emit MarketUnlisted(market);
    }

    /**
     * @notice Checks if a market is currently paused.
     * @param market The address of the market.
     * @return True if the market is paused
     */
    function isMarketPaused(address market) public view returns (bool) {
        IComptroller comptroller = IVToken(market).comptroller();
        (, uint256 collateralFactorMantissa, ) = comptroller.markets(market);

        if (
            collateralFactorMantissa == 0 &&
            comptroller.actionPaused(market, IComptroller.Action.MINT) &&
            comptroller.actionPaused(market, IComptroller.Action.BORROW) &&
            comptroller.actionPaused(market, IComptroller.Action.ENTER_MARKET)
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

        if (expiry.pauseTimestamp != 0) {
            return false;
        }

        if (expiry.toBePausedAfterTimestamp != 0 && block.timestamp < expiry.toBePausedAfterTimestamp) {
            return false;
        }

        IComptroller comptroller = IVToken(market).comptroller();

        if (expiry.toBePausedAfterTimestamp == 0) {
            uint256 totalDepositsUSD = _getTotalDeposit(market);

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
        IComptroller comptroller = IVToken(market).comptroller();
        (bool isListed, , ) = comptroller.markets(market);
        if (!isListed) {
            return false;
        }

        Expiry memory expiry = expiries[market];

        if (expiry.unlistTimestamp != 0) {
            return false;
        }

        if (!isMarketPaused(market)) {
            return false;
        }

        if (!expiry.canUnlist) {
            return false;
        }

        uint256 totalDepositsUSD = _getTotalDeposit(market);

        if (totalDepositsUSD > expiry.toBeUnlistedMinTotalSupplyUSD) {
            return false;
        }

        return true;
    }

    /**
     * @notice Returns the total deposits of a market in USD.
     * @param market The address of the market.
     * @return The total deposits in USD.
     */
    function _getTotalDeposit(address market) internal view returns (uint256) {
        IComptroller comptroller = IVToken(market).comptroller();
        ResilientOracleInterface oracle = comptroller.oracle();
        uint256 totalSupplied = (IVToken(market).totalSupply() * IVToken(market).exchangeRateStored()) / EXP_SCALE;
        uint256 price = oracle.getUnderlyingPrice(market);
        uint256 totalDepositsUSD = (totalSupplied * price) / EXP_SCALE;
        return totalDepositsUSD;
    }
}
