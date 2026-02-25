// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

import { IComptroller, IVToken } from "../Interfaces.sol";

/**
 * @title IPositionAccount
 * @author Venus Protocol
 * @notice Interface for Position Account contracts
 * @dev Minimal proxy contracts that hold user funds and execute operations on behalf of users
 *      in the Venus protocol. These contracts are deployed deterministically using clones.
 */
interface IPositionAccount {
    /**
     * @notice Initializes a new position account clone
     * @dev Can only be called once per clone. Sets the owner, long/short vTokens, and delegates to manager.
     * @param owner_ Address of the position account owner
     * @param longVToken_ Address of the long market vToken
     * @param shortVToken_ Address of the short market vToken
     */
    function initialize(address owner_, address longVToken_, address shortVToken_) external;

    /**
     * @notice Forwards enterLeverage to the LeverageStrategiesManager on behalf of this position account
     * @dev Only callable by the RelativePositionManager. Ensures the position account is msg.sender to LM.
     * @param collateralMarket Collateral (e.g. long) vToken to supply after swap
     * @param collateralAmountSeed Optional seed amount of collateral (RPM uses 0; collateral from swap)
     * @param borrowedMarket Borrowed (e.g. short) vToken to flash-borrow
     * @param borrowedAmountToFlashLoan Amount to borrow via flash loan
     * @param minAmountOutAfterSwap Minimum collateral out after swap (slippage protection)
     * @param swapData Swap calldata (e.g. borrowed → collateral)
     */
    function enterLeverage(
        IVToken collateralMarket,
        uint256 collateralAmountSeed,
        IVToken borrowedMarket,
        uint256 borrowedAmountToFlashLoan,
        uint256 minAmountOutAfterSwap,
        bytes calldata swapData
    ) external;

    /**
     * @notice Forwards exitLeverage to the LeverageStrategiesManager on behalf of this position account
     * @dev Only callable by the RelativePositionManager. Enables clearer flow and better revert messages.
     * @param collateralMarket Collateral (e.g. long) vToken to redeem
     * @param collateralAmountToRedeemForSwap Amount of collateral to redeem for swap
     * @param borrowedMarket Borrowed (e.g. short) vToken to repay
     * @param borrowedAmountToFlashLoan Amount to repay via flash loan
     * @param minAmountOutAfterSwap Minimum amount out after swap (slippage protection)
     * @param swapData Swap calldata (e.g. collateral → borrowed)
     */
    function exitLeverage(
        IVToken collateralMarket,
        uint256 collateralAmountToRedeemForSwap,
        IVToken borrowedMarket,
        uint256 borrowedAmountToFlashLoan,
        uint256 minAmountOutAfterSwap,
        bytes calldata swapData
    ) external;

    /**
     * @notice Forwards exitSingleAssetLeverage to the LeverageStrategiesManager (collateral and debt are same asset)
     * @dev Only callable by the RelativePositionManager. Use when DSA == short: repay short debt by redeeming DSA vTokens, no swap.
     * @param collateralMarket vToken market for both collateral and debt (e.g. DSA when DSA == short)
     * @param collateralAmountToFlashLoan Amount to borrow via flash loan for debt repayment
     */
    function exitSingleAssetLeverage(IVToken collateralMarket, uint256 collateralAmountToFlashLoan) external;

    /**
     * @notice Transfers full balance of an ERC20 token from this position account to its owner (dust recovery)
     * @dev Only callable by the RelativePositionManager. Used to sweep dust to the position owner.
     * @param token Address of the ERC20 token to transfer
     */
    function transferDustToOwner(address token) external;

    /**
     * @notice Exits a market by calling comptroller.exitMarket with this position account as the sender
     * @dev Only callable by the RelativePositionManager. The position account directly calls the Comptroller.
     * @param vTokenToExit Address of the vToken market to exit
     */
    function exitMarket(address vTokenToExit) external;

    /**
     * @notice Executes multiple generic calls to external contracts on behalf of the position account
     * @dev Only callable by the authorized RelativePositionManager contract.
     * @param targets Array of target contract addresses
     * @param data Array of encoded function call data
     */
    function genericCalls(address[] calldata targets, bytes[] calldata data) external;

    /**
     * @notice Gets the Comptroller contract
     * @return Address of the Venus Comptroller
     */
    function COMPTROLLER() external view returns (IComptroller);

    /**
     * @notice Gets the authorized RelativePositionManager contract
     * @return Address of the RelativePositionManager contract
     */
    function RELATIVE_POSITION_MANAGER() external view returns (address);

    /**
     * @notice Gets the LeverageStrategiesManager contract
     * @return Address of the LeverageStrategiesManager contract
     */
    function LEVERAGE_MANAGER() external view returns (address);

    /**
     * @notice Gets the owner of this position account
     * @return owner Address of the position account owner
     */
    function owner() external view returns (address owner);

    /**
     * @notice Gets the long vToken for this position
     * @return longVToken Address of the long market vToken
     */
    function longVToken() external view returns (address longVToken);

    /**
     * @notice Gets the short vToken for this position
     * @return shortVToken Address of the short market vToken
     */
    function shortVToken() external view returns (address shortVToken);
}
