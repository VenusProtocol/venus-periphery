// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { AddressUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/AddressUpgradeable.sol";
import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { SafeERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import { IComptroller, IVToken } from "../Interfaces.sol";
import { ILeverageStrategiesManager } from "../LeverageManager/ILeverageStrategiesManager.sol";
import { IPositionAccount } from "./IPositionAccount.sol";

/**
 * @title PositionAccount
 * @author Venus Protocol
 * @notice Minimal proxy contract that holds user funds for isolated Relative Trading positions
 * @dev This contract is deployed using the clones pattern for gas efficiency.
 *      It allows the RelativePositionManager to execute calls on behalf of the user.
 *      The constructor sets immutable values shared across all clones.
 *      The initialize function sets clone-specific data.
 *
 *      DESIGN INVARIANT - External Token Transfers & Accounting Drift:
 *      Do not call mintBehalf or perform direct transfers to this contract. Use only the RelativePositionManager.
 *      External transfers to this account are not accurately tracked by the manager, causing accounting drift.
 *      No funds are lost, only accounting can drift. All operations must be routed through the RelativePositionManager
 *      to maintain accurate accounting.
 */
contract PositionAccount is Initializable, IPositionAccount {
    using AddressUpgradeable for address;
    using SafeERC20Upgradeable for IERC20Upgradeable;

    /// @notice Address of the Venus Comptroller (same for all clones)
    IComptroller public immutable COMPTROLLER;

    /// @notice Address of the authorized RelativePositionManager contract (same for all clones)
    address public immutable RELATIVE_POSITION_MANAGER;

    /// @notice Address of the LeverageStrategiesManager contract (same for all clones)
    address public immutable LEVERAGE_MANAGER;

    /// @notice Address of the position account owner (different for each clone)
    address public owner;

    /// @notice Address of the long vToken for this position
    address public longVToken;

    /// @notice Address of the short vToken for this position
    address public shortVToken;

    /**
     * @notice Emitted when a generic call is executed
     * @param target Target contract address
     * @param data Call data executed
     */
    event GenericCallExecuted(address indexed target, bytes data);

    /**
     * @notice Emitted when enterLeverage is forwarded to the LeverageManager
     * @param collateralMarket Collateral vToken market
     * @param borrowedMarket Borrowed vToken market
     * @param collateralAmountSeed Collateral seed amount (often 0)
     * @param borrowedAmount Flash loan amount
     */
    event EnterLeverageForwarded(
        address indexed collateralMarket,
        address indexed borrowedMarket,
        uint256 collateralAmountSeed,
        uint256 borrowedAmount
    );

    /**
     * @notice Emitted when exitLeverage is forwarded to the LeverageManager
     * @param collateralMarket Collateral vToken market
     * @param borrowedMarket Borrowed vToken market
     * @param collateralAmount Amount of collateral to redeem for swap
     * @param borrowedAmount Flash loan amount for repayment
     */
    event ExitLeverageForwarded(
        address indexed collateralMarket,
        address indexed borrowedMarket,
        uint256 collateralAmount,
        uint256 borrowedAmount
    );

    /**
     * @notice Emitted when exitSingleAssetLeverage is forwarded to the LeverageManager
     * @param market vToken market (collateral and debt are the same)
     * @param amount Flash loan amount for debt repayment
     */
    event ExitSingleAssetLeverageForwarded(address indexed market, uint256 amount);

    /**
     * @notice Emitted when a market is exited via the Comptroller
     * @param vToken Address of the vToken market exited
     */
    event MarketExited(address indexed vToken);

    /**
     * @notice Emitted when dust (remaining token balance) is transferred to the position owner
     * @param token Address of the ERC20 token transferred
     * @param owner Address of the position account owner receiving the dust
     * @param amount Amount of tokens transferred
     */
    event DustTransferredToOwner(address indexed token, address indexed owner, uint256 amount);

    /// @notice Thrown when caller is not the authorized RelativePositionManager
    error UnauthorizedCaller();

    /// @notice Thrown when a zero address is provided as a parameter
    error ZeroAddress();

    /// @notice Thrown when genericCalls is invoked with invalid calls length (empty or lengths mismatch)
    error InvalidCallsLength();

    /// @notice Thrown when exitMarket fails with a non-zero error code
    error ExitMarketFailed(uint256 err);

    /**
     * @notice Modifier to restrict access to only the RelativePositionManager
     */
    modifier onlyRelativePositionManager() {
        if (msg.sender != RELATIVE_POSITION_MANAGER) {
            revert UnauthorizedCaller();
        }
        _;
    }

    /**
     * @notice Constructor for the PositionAccount implementation contract
     * @dev This constructor is only called once for the implementation contract.
     *      Sets immutable values that are the same for all clones.
     * @param comptroller_ The Venus comptroller contract address
     * @param relativePositionManager_ Address of the RelativePositionManager contract
     * @param leverageManager_ Address of the LeverageStrategiesManager contract
     * @custom:error ZeroAddress if any of the addresses is zero.
     */
    constructor(IComptroller comptroller_, address relativePositionManager_, address leverageManager_) {
        if (
            address(comptroller_) == address(0) ||
            relativePositionManager_ == address(0) ||
            leverageManager_ == address(0)
        ) {
            revert ZeroAddress();
        }
        COMPTROLLER = comptroller_;
        RELATIVE_POSITION_MANAGER = relativePositionManager_;
        LEVERAGE_MANAGER = leverageManager_;

        // Prevent implementation contract from being initialized
        _disableInitializers();
    }

    /**
     * @notice Initializes a new position account clone
     * @dev Can only be called once per clone. Sets the owner, long/short vTokens, and delegates to both managers.
     * @param owner_ Address of the position account owner
     * @param longVToken_ Address of the long market vToken
     * @param shortVToken_ Address of the short market vToken
     * @custom:error ZeroAddress if any of the addresses is zero.
     */
    function initialize(address owner_, address longVToken_, address shortVToken_) external initializer {
        if (owner_ == address(0) || longVToken_ == address(0) || shortVToken_ == address(0)) {
            revert ZeroAddress();
        }

        owner = owner_;
        longVToken = longVToken_;
        shortVToken = shortVToken_;

        // Approve delegates for both managers to act on behalf of this account
        COMPTROLLER.updateDelegate(RELATIVE_POSITION_MANAGER, true);
        COMPTROLLER.updateDelegate(LEVERAGE_MANAGER, true);
    }

    /**
     * @notice Forwards enterLeverage to the LeverageStrategiesManager on behalf of this position account
     * @dev Only callable by the RelativePositionManager. Ensures the position account is msg.sender to LM,
     *      so debt/collateral and dust stay on this account. Emits EnterLeverageForwarded for debugging.
     * @param collateralMarket Collateral (e.g. long) vToken to supply after swap
     * @param collateralAmountSeed Optional seed amount of collateral (RPM uses 0)
     * @param borrowedMarket Borrowed (e.g. short) vToken to flash-borrow
     * @param borrowedAmountToFlashLoan Amount to borrow via flash loan
     * @param minAmountOutAfterSwap Minimum collateral out after swap (slippage protection)
     * @param swapData Swap calldata (e.g. borrowed → collateral)
     * @custom:error UnauthorizedCaller if caller is not the RelativePositionManager.
     */
    function enterLeverage(
        IVToken collateralMarket,
        uint256 collateralAmountSeed,
        IVToken borrowedMarket,
        uint256 borrowedAmountToFlashLoan,
        uint256 minAmountOutAfterSwap,
        bytes calldata swapData
    ) external onlyRelativePositionManager {
        emit EnterLeverageForwarded(
            address(collateralMarket),
            address(borrowedMarket),
            collateralAmountSeed,
            borrowedAmountToFlashLoan
        );
        ILeverageStrategiesManager(LEVERAGE_MANAGER).enterLeverage(
            collateralMarket,
            collateralAmountSeed,
            borrowedMarket,
            borrowedAmountToFlashLoan,
            minAmountOutAfterSwap,
            swapData
        );
    }

    /**
     * @notice Forwards exitLeverage to the LeverageStrategiesManager on behalf of this position account
     * @dev Only callable by the RelativePositionManager. Ensures the position account is msg.sender to LM,
     *      so debt/collateral and dust stay on this account. Emits ExitLeverageForwarded for debugging.
     * @param collateralMarket Collateral (e.g. long) vToken to redeem
     * @param collateralAmountToRedeemForSwap Amount of collateral to redeem for swap
     * @param borrowedMarket Borrowed (e.g. short) vToken to repay
     * @param borrowedAmountToFlashLoan Amount to repay via flash loan
     * @param minAmountOutAfterSwap Minimum amount out after swap (slippage protection)
     * @param swapData Swap calldata (e.g. collateral → borrowed)
     * @custom:error UnauthorizedCaller if caller is not the RelativePositionManager.
     */
    function exitLeverage(
        IVToken collateralMarket,
        uint256 collateralAmountToRedeemForSwap,
        IVToken borrowedMarket,
        uint256 borrowedAmountToFlashLoan,
        uint256 minAmountOutAfterSwap,
        bytes calldata swapData
    ) external onlyRelativePositionManager {
        emit ExitLeverageForwarded(
            address(collateralMarket),
            address(borrowedMarket),
            collateralAmountToRedeemForSwap,
            borrowedAmountToFlashLoan
        );
        ILeverageStrategiesManager(LEVERAGE_MANAGER).exitLeverage(
            collateralMarket,
            collateralAmountToRedeemForSwap,
            borrowedMarket,
            borrowedAmountToFlashLoan,
            minAmountOutAfterSwap,
            swapData
        );
    }

    /**
     * @notice Forwards exitSingleAssetLeverage to the LeverageStrategiesManager on behalf of this position account
     * @dev Only callable by the RelativePositionManager. Use when collateral and debt are the same asset (e.g. DSA == short).
     * @param collateralMarket vToken market for both collateral and debt
     * @param collateralAmountToFlashLoan Amount to borrow via flash loan for debt repayment
     * @custom:error UnauthorizedCaller if caller is not the RelativePositionManager.
     */
    function exitSingleAssetLeverage(
        IVToken collateralMarket,
        uint256 collateralAmountToFlashLoan
    ) external onlyRelativePositionManager {
        emit ExitSingleAssetLeverageForwarded(address(collateralMarket), collateralAmountToFlashLoan);
        ILeverageStrategiesManager(LEVERAGE_MANAGER).exitSingleAssetLeverage(
            collateralMarket,
            collateralAmountToFlashLoan
        );
    }

    /**
     * @notice Exits a market by calling comptroller.exitMarket with this position account as the sender
     * @dev Only callable by the RelativePositionManager. The position account directly calls the Comptroller.
     * @param vTokenToExit Address of the vToken market to exit
     * @custom:error UnauthorizedCaller if caller is not the RelativePositionManager.
     * @custom:error ExitMarketFailed if the exit market operation fails.
     */
    function exitMarket(address vTokenToExit) external onlyRelativePositionManager {
        uint256 err = COMPTROLLER.exitMarket(vTokenToExit);
        if (err != 0) revert ExitMarketFailed(err);
        emit MarketExited(vTokenToExit);
    }

    /**
     * @notice Transfers full balance of an ERC20 token from this position account to its owner (dust recovery)
     * @dev Only callable by the RelativePositionManager. Used to sweep dust to the position owner.
     * @param token Address of the ERC20 token to transfer
     * @custom:error UnauthorizedCaller if caller is not the RelativePositionManager.
     */
    function transferDustToOwner(address token) external onlyRelativePositionManager {
        uint256 balance = IERC20Upgradeable(token).balanceOf(address(this));
        if (balance > 0) {
            IERC20Upgradeable(token).safeTransfer(owner, balance);
            emit DustTransferredToOwner(token, owner, balance);
        }
    }

    /**
     * @notice Executes multiple generic calls to external contracts
     * @dev Only callable by the authorized RelativePositionManager contract.
     *      Uses AddressUpgradeable.functionCall for safer execution and reverts on failure.
     * @param targets Array of target contract addresses
     * @param data Array of encoded function call data
     * @custom:error UnauthorizedCaller if caller is not the RelativePositionManager.
     * @custom:error InvalidCallsLength if arrays are empty or lengths mismatch.
     */
    function genericCalls(address[] calldata targets, bytes[] calldata data) external onlyRelativePositionManager {
        uint256 length = targets.length;
        if (length == 0 || length != data.length) {
            revert InvalidCallsLength();
        }

        for (uint256 i = 0; i < length; ++i) {
            targets[i].functionCall(data[i]);
            emit GenericCallExecuted(targets[i], data[i]);
        }
    }
}
