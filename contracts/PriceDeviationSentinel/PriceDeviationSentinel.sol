pragma solidity ^0.8.25;

import { ICorePoolComptroller } from "../Interfaces/ICorePoolComptroller.sol";
import { IILComptroller } from "../Interfaces/IILComptroller.sol";
import { IComptroller } from "../Interfaces/IComptroller.sol";
import { IVToken } from "../Interfaces/IVToken.sol";
import { ResilientOracleInterface } from "@venusprotocol/oracle/contracts/interfaces/OracleInterface.sol";
import { AccessControlledV8 } from "@venusprotocol/governance-contracts/contracts/Governance/AccessControlledV8.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { IPancakeV2Pair } from "../Interfaces/IPancakeV2Pair.sol";
import { IUniswapV3Pool } from "../Interfaces/IUniswapV3Pool.sol";
import { FixedPoint96 } from "../Libraries/FixedPoint96.sol";
import { FullMath } from "../Libraries/FullMath.sol";

/**
 * @title PriceDeviationSentinel
 * @author Venus
 * @notice Sentinel that compares oracle and DEX prices (via keeper) and pauses
 *         specific actions (borrow, mint, collateral factor) per market when
 *         large deviations are detected.
 */
contract PriceDeviationSentinel is AccessControlledV8 {
    /// @notice Supported DEX types for price fetching
    enum DEX {
        UNISWAP_V3,
        PANCAKESWAP_V2
    }

    /// @notice Configuration for price deviation monitoring
    /// @param deviation Maximum allowed deviation percentage (e.g., 10 = 10%)
    /// @param dex The DEX type to fetch prices from
    /// @param pool The DEX pool address to fetch prices from
    struct DeviationConfig {
        uint8 deviation;
        DEX dex;
        address pool;
    }

    /// @notice State tracking for market modifications by this contract
    /// @param isPaused True if borrow is paused for this market by this contract
    /// @param cfModified True if collateral factor was modified by this contract
    /// @param originalCF Original collateral factor before modification
    /// @param originalLT Original liquidation threshold before modification
    struct MarketState {
        bool isPaused;
        bool cfModified;
        uint256 originalCF;
        uint256 originalLT;
    }

    /// @notice Maximum allowed price deviation in percentage (e.g., 10 = 10%)
    uint8 public constant MAX_DEVIATION = 100;

    /// @notice Address of the Core Pool Comptroller
    ICorePoolComptroller public immutable CORE_POOL_COMPTROLLER;

    /// @notice Resilient Oracle for getting reference prices
    ResilientOracleInterface public immutable RESILIENT_ORACLE;

    /// @notice Mapping of token addresses to their DEX configuration
    mapping (address => DeviationConfig) public tokenConfigs;

    /// @notice Mapping of trusted keeper addresses
    mapping (address => bool) public trustedKeepers;

    /// @notice Mapping to track market state changes made by this contract
    mapping (address => MarketState) public marketStates;

    /// @notice Emitted when a token's deviation configuration is updated
    /// @param token The token address
    /// @param config The new deviation configuration
    event TokenConfigUpdated(address indexed token, DeviationConfig config);

    /// @notice Emitted when a keeper's trusted status is updated
    /// @param keeper The keeper address
    /// @param isTrusted Whether the keeper is trusted
    event TrustedKeeperUpdated(address indexed keeper, bool isTrusted);
    
    /// @notice Emitted when borrow is paused for a market
    /// @param market The market address
    event BorrowPaused(address indexed market);
    
    /// @notice Emitted when borrow is unpaused for a market
    /// @param market The market address
    event BorrowUnpaused(address indexed market);
    
    /// @notice Emitted when collateral factor is updated
    /// @param market The market address
    /// @param oldCF The old collateral factor
    /// @param newCF The new collateral factor
    event CollateralFactorUpdated(address indexed market, uint256 oldCF, uint256 newCF);

    /// @notice Thrown when deviation is set to zero
    error ZeroDeviation();
    
    /// @notice Thrown when deviation exceeds maximum allowed
    error ExceedsMaxDeviation();
    
    /// @notice Thrown when a zero address is provided
    error ZeroAddress();
    
    /// @notice Thrown when an invalid pool address is provided
    error InvalidPool();
    
    /// @notice Thrown when an unsupported DEX type is used
    error UnsupportedDEX();
    
    /// @notice Thrown when price calculation fails
    error PriceCalculationError();
    
    /// @notice Thrown when caller is not an authorized keeper
    error UnauthorizedKeeper();
    
    /// @notice Thrown when market is not configured for monitoring
    error MarketNotConfigured();
    
    /// @notice Thrown when comptroller operation fails
    /// @param errorCode The error code returned by the comptroller
    error ComptrollerError(uint256 errorCode);

    modifier onlyKeeper() {
        if (!trustedKeepers[msg.sender]) revert UnauthorizedKeeper();
        _;
    }

    /// @notice Constructor for PriceDeviationSentinel
    /// @param corePoolComptroller_ Address of the core pool comptroller
    /// @param resilientOracle_ Address of the resilient oracle
    constructor(ICorePoolComptroller corePoolComptroller_, ResilientOracleInterface resilientOracle_) {
        CORE_POOL_COMPTROLLER = corePoolComptroller_;
        RESILIENT_ORACLE = resilientOracle_;

        // Note that the contract is upgradeable. Use initialize() or reinitializers
        // to set the state variables.
        _disableInitializers();
    }

    /// @notice Initialize the contract
    /// @param accessControlManager_ Address of the access control manager
    function initialize(
        address accessControlManager_
    ) external initializer {
        __AccessControlled_init(accessControlManager_);
    }

    /// @notice Set trusted status for a keeper
    /// @param keeper Address of the keeper
    /// @param isTrusted Whether the keeper should be trusted
    function setTrustedKeeper(address keeper, bool isTrusted) external {
        _checkAccessAllowed("setTrustedKeeper(address,bool)");

        if (keeper == address(0)) revert ZeroAddress();

        trustedKeepers[keeper] = isTrusted;
        emit TrustedKeeperUpdated(keeper, isTrusted);
    }

    /// @notice Set deviation configuration for a token
    /// @param token Address of the token
    /// @param config Deviation configuration containing threshold, DEX type, and pool address
    function setTokenConfig(address token, DeviationConfig calldata config) external {
        _checkAccessAllowed("setTokenConfig(address,(uint8,uint8,address))");

        if (token == address(0)) revert ZeroAddress();
        if (config.pool == address(0)) revert ZeroAddress();
        if (config.deviation == 0) revert ZeroDeviation();
        if (config.deviation > MAX_DEVIATION) revert ExceedsMaxDeviation();

        tokenConfigs[token] = config;
        emit TokenConfigUpdated(token, config);
    }

    /// @notice Check if there is a price deviation between DEX and oracle for a market
    /// @param market The vToken market to check
    /// @return hasDeviation True if deviation exceeds configured threshold
    /// @return oraclePrice The price from resilient oracle
    /// @return dexPrice The price from DEX
    /// @return deviationPercent The percentage deviation (scaled by 100)
    function checkPriceDeviation(IVToken market) public view returns (
        bool hasDeviation,
        uint256 oraclePrice,
        uint256 dexPrice,
        uint256 deviationPercent
    ) {
        address underlyingToken = market.underlying();
        DeviationConfig memory config = tokenConfigs[underlyingToken];
        
        oraclePrice = RESILIENT_ORACLE.getPrice(underlyingToken);
        dexPrice = getDexPrice(config, underlyingToken);
        
        if (oraclePrice == 0) {
            hasDeviation = true;
            deviationPercent = type(uint256).max;
            return (hasDeviation, oraclePrice, dexPrice, deviationPercent);
        }
        
        uint256 priceDiff;
        if (dexPrice > oraclePrice) {
            priceDiff = dexPrice - oraclePrice;
        } else {
            priceDiff = oraclePrice - dexPrice;
        }
        
        deviationPercent = (priceDiff * 100) / oraclePrice;
        hasDeviation = deviationPercent > config.deviation;
    }

    /// @notice Handle price deviation for a market by pausing or adjusting collateral factor
    /// @param market The vToken market to handle
    function handleDeviation(IVToken market) external onlyKeeper {
        address underlyingToken = market.underlying();
        DeviationConfig memory config = tokenConfigs[underlyingToken];
        
        if (config.pool == address(0)) revert MarketNotConfigured();
        
        (bool hasDeviation, uint256 oraclePrice, uint256 dexPrice, ) = checkPriceDeviation(market);
        
        MarketState storage state = marketStates[address(market)];
        
        if (hasDeviation) {
            if (dexPrice > oraclePrice) {
                _pauseBorrow(market, IComptroller.Action.BORROW);
                state.isPaused = true;
            } else {
                _setCollateralFactorToZero(market);
                state.cfModified = true;
            }
        } else {
            if (state.isPaused) {
                _unpauseBorrow(market, IComptroller.Action.BORROW);
                state.isPaused = false;
            }
            
            if (state.cfModified) {
                _restoreCollateralFactor(market);
                state.cfModified = false;
            }
        }
    }

    /// @notice Pause borrow action for a market
    /// @param market The market to pause borrow for
    /// @param action The action to pause
    function _pauseBorrow(IVToken market, IComptroller.Action action) internal {
        IComptroller comptroller = market.comptroller();
        
        address[] memory markets = new address[](1);
        markets[0] = address(market);
        IComptroller.Action[] memory actions = new IComptroller.Action[](1);
        actions[0] = action;
        
        comptroller.setActionsPaused(markets, actions, true);
        emit BorrowPaused(address(market));
    }

    /// @notice Unpause borrow action for a market
    /// @param market The market to unpause borrow for
    /// @param action The action to unpause
    function _unpauseBorrow(IVToken market, IComptroller.Action action) internal {
        IComptroller comptroller = market.comptroller();
        
        address[] memory markets = new address[](1);
        markets[0] = address(market);
        IComptroller.Action[] memory actions = new IComptroller.Action[](1);
        actions[0] = action;
        
        comptroller.setActionsPaused(markets, actions, false);
        emit BorrowUnpaused(address(market));
    }

    /// @notice Set collateral factor to zero and store original value
    /// @param market The market to modify
    function _setCollateralFactorToZero(IVToken market) internal {
        IComptroller comptroller = market.comptroller();
        MarketState storage state = marketStates[address(market)];
        
        if (state.cfModified) return;
        
        if (address(comptroller) == address(CORE_POOL_COMPTROLLER)) {
            (
                bool isListed,
                uint256 collateralFactorMantissa,
                ,  // isVenus
                uint256 liquidationThresholdMantissa,
                ,  // liquidationIncentiveMantissa
                ,  // marketPoolId
                   // isBorrowAllowed
            ) = ICorePoolComptroller(address(comptroller)).poolMarkets(0, address(market));
            if (isListed) {
                state.originalCF = collateralFactorMantissa;
                state.originalLT = liquidationThresholdMantissa;
                state.cfModified = true;
                uint256 result = ICorePoolComptroller(address(comptroller)).setCollateralFactor(address(market), 0, liquidationThresholdMantissa);
                if (result != 0) revert ComptrollerError(result);
                emit CollateralFactorUpdated(address(market), collateralFactorMantissa, 0);
            }
        } else {
            IILComptroller.Market memory marketData = IILComptroller(address(comptroller)).markets(address(market));
            if (marketData.isListed) {
                state.originalCF = marketData.collateralFactorMantissa;
                state.originalLT = marketData.liquidationThresholdMantissa;
                state.cfModified = true;
                IILComptroller(address(comptroller)).setCollateralFactor(address(market), 0, marketData.liquidationThresholdMantissa);
                emit CollateralFactorUpdated(address(market), marketData.collateralFactorMantissa, 0);
            }
        }
    }

    /// @notice Restore original collateral factor
    /// @param market The market to restore
    function _restoreCollateralFactor(IVToken market) internal {
        IComptroller comptroller = market.comptroller();
        MarketState storage state = marketStates[address(market)];
        
        if (!state.cfModified) return;
        
        uint256 originalCF = state.originalCF;
        
        // Check if this is a core pool or isolated pool
        if (address(comptroller) == address(CORE_POOL_COMPTROLLER)) {
            // Core pool
            uint256 originalLT = state.originalLT;
            uint256 result = ICorePoolComptroller(address(comptroller)).setCollateralFactor(address(market), originalCF, originalLT);
            if (result != 0) revert ComptrollerError(result);
            emit CollateralFactorUpdated(address(market), 0, originalCF);
            state.originalCF = 0;
            state.originalLT = 0;
            state.cfModified = false;
        } else {
            // Isolated pool
            uint256 originalLT = state.originalLT;
            IILComptroller(address(comptroller)).setCollateralFactor(address(market), originalCF, originalLT);
            emit CollateralFactorUpdated(address(market), 0, originalCF);
            state.originalCF = 0;
            state.originalLT = 0;
            state.cfModified = false;
        }
    }

    /// @notice Get USD price of a token from DEX
    /// @param config Deviation configuration containing DEX type and pool info
    /// @param token Token address to get price for
    /// @return price USD price in resilient oracle format (36 - token decimals)
    function getDexPrice(DeviationConfig memory config, address token) public view returns (uint256 price) {
        if (config.dex == DEX.UNISWAP_V3) {
            return _getUniswapV3Price(config.pool, token);
        } else if (config.dex == DEX.PANCAKESWAP_V2) {
            return _getPancakeSwapV2Price(config.pool, token);
        } else {
            revert UnsupportedDEX();
        }
    }

    /// @notice Get token price from Uniswap V3 pool
    /// @param pool Uniswap V3 pool address
    /// @param token Target token address
    /// @return price USD price in resilient oracle format
    function _getUniswapV3Price(address pool, address token) internal view returns (uint256 price) {
        if (pool == address(0)) revert InvalidPool();

        IUniswapV3Pool v3Pool = IUniswapV3Pool(pool);
        address token0 = v3Pool.token0();
        address token1 = v3Pool.token1();
        
        (uint160 sqrtPriceX96, , , , , , ) = v3Pool.slot0();
        
        uint256 priceX96 = FullMath.mulDiv(sqrtPriceX96, sqrtPriceX96, FixedPoint96.Q96);
        
        address targetToken = token;
        address referenceToken;
        bool targetIsToken0;
        
        if (token == token0) {
            targetIsToken0 = true;
            referenceToken = token1;
        } else if (token == token1) {
            targetIsToken0 = false;
            referenceToken = token0;
        } else {
            revert InvalidPool();
        }
        
        uint256 referencePrice = RESILIENT_ORACLE.getPrice(referenceToken);
        
        uint8 targetDecimals = IERC20Metadata(targetToken).decimals();
        uint8 referenceDecimals = IERC20Metadata(referenceToken).decimals();
        
        if (targetIsToken0) {
            price = FullMath.mulDiv(referencePrice * (10 ** targetDecimals), FixedPoint96.Q96, priceX96 * (10 ** referenceDecimals));
        } else {
            price = FullMath.mulDiv(referencePrice * priceX96 * (10 ** targetDecimals), 1, FixedPoint96.Q96 * (10 ** referenceDecimals));
        }
        
        uint8 oracleDecimals = 36 - targetDecimals;
        if (oracleDecimals > 18) {
            price = price * (10 ** (oracleDecimals - 18));
        } else if (oracleDecimals < 18) {
            price = price / (10 ** (18 - oracleDecimals));
        }
    }

    /// @notice Get token price from PancakeSwap V2 pair
    /// @param pair PancakeSwap V2 pair address
    /// @param token Target token address
    /// @return price USD price in resilient oracle format
    function _getPancakeSwapV2Price(address pair, address token) internal view returns (uint256 price) {
        if (pair == address(0)) revert InvalidPool();

        IPancakeV2Pair v2Pair = IPancakeV2Pair(pair);
        address token0 = v2Pair.token0();
        address token1 = v2Pair.token1();
        
        (uint112 reserve0, uint112 reserve1, ) = v2Pair.getReserves();
        
        if (reserve0 == 0 || reserve1 == 0) revert PriceCalculationError();
        
        address targetToken = token;
        address referenceToken;
        uint256 targetReserve;
        uint256 referenceReserve;
        
        if (token == token0) {
            targetReserve = uint256(reserve0);
            referenceReserve = uint256(reserve1);
            referenceToken = token1;
        } else if (token == token1) {
            targetReserve = uint256(reserve1);
            referenceReserve = uint256(reserve0);
            referenceToken = token0;
        } else {
            revert InvalidPool();
        }
        
        uint256 referencePrice = RESILIENT_ORACLE.getPrice(referenceToken);
        
        uint8 targetDecimals = IERC20Metadata(targetToken).decimals();
        uint8 referenceDecimals = IERC20Metadata(referenceToken).decimals();
        
        price = (referenceReserve * referencePrice * (10 ** targetDecimals)) / (targetReserve * (10 ** referenceDecimals));
        
        uint8 oracleDecimals = 36 - targetDecimals;
        if (oracleDecimals > 18) {
            price = price * (10 ** (oracleDecimals - 18));
        } else if (oracleDecimals < 18) {
            price = price / (10 ** (18 - oracleDecimals));
        }
    }
}