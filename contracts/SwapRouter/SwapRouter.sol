// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

import { Ownable2StepUpgradeable } from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import { SafeERC20Upgradeable, IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import { IVToken, IComptroller, IWBNB, IVBNB } from "../Interfaces.sol";
import { SwapHelper } from "../SwapHelper/SwapHelper.sol";

/**
 * @title SwapRouter
 * @author Venus Protocol
 * @notice A contract for swap features: swap-and-supply and swap-and-repay operations
 * @dev This contract allows users to:
 *      - Supply funds to Venus markets using different assets (swap-and-supply)
 *      - Repay debts using different assets (swap-and-repay)
 *      Compatible with immutable vBNB market.
 * @custom:security-contact https://github.com/VenusProtocol/venus-periphery
 */
contract SwapRouter is Ownable2StepUpgradeable, ReentrancyGuardUpgradeable {
    using SafeERC20Upgradeable for IERC20Upgradeable;

    /// @notice Address representing native token (BNB)
    address public constant NATIVE_TOKEN_ADDR = 0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB;

    /// @notice The Venus comptroller contract for market validation and operations
    IComptroller public immutable COMPTROLLER;

    /// @notice The swap helper contract for executing token swaps
    SwapHelper public immutable SWAP_HELPER;

    /// @notice The wrapped native token contract (e.g., WBNB)
    IWBNB public immutable WRAPPED_NATIVE;

    /// @notice The native vToken address (e.g., vBNB)
    IVBNB public immutable NATIVE_VTOKEN;

    /// @notice Emitted when tokens are swapped and supplied to a Venus market
    event SwapAndSupply(
        address indexed user,
        address indexed vToken,
        address indexed tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 amountSupplied
    );

    /// @notice Emitted when tokens are swapped and used to repay debt
    event SwapAndRepay(
        address indexed user,
        address indexed vToken,
        address indexed tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 amountRepaid
    );

    /// @notice Emitted when leftover ERC-20 tokens are swept by owner
    event SweepToken(address indexed token, address indexed receiver, uint256 amount);

    /// @notice Emitted when leftover native tokens are swept by owner
    event SweepNative(address indexed receiver, uint256 amount);

    /// @custom:error Thrown when a zero address is provided
    error ZeroAddress();

    /// @custom:error Thrown when zero amount is provided
    error ZeroAmount();

    /// @custom:error Thrown when supply operation fails
    error SupplyFailed(uint256 errorCode);

    /// @custom:error Thrown when repay operation fails
    error RepayFailed(uint256 errorCode);

    /// @custom:error Thrown when swap operation fails
    error SwapFailed();

    /// @custom:error Thrown when no tokens are received from swap
    error NoTokensReceived();

    /// @custom:error Thrown when native token transfer fails
    error NativeTransferFailed();

    /// @custom:error Thrown when insufficient user balance
    error InsufficientBalance();

    /// @custom:error Thrown when market is not listed in comptroller
    error MarketNotListed(address vToken);

    /// @custom:error Thrown when slippage protection fails
    error InsufficientAmountOut(uint256 amountOut, uint256 minAmountOut);

    /// @custom:error Thrown when unauthorized sender tries to send native tokens
    error UnauthorizedNativeSender(address sender);

    /**
     * @notice Constructor to set immutable variables
     * @param _comptroller The address of the Venus Comptroller contract
     * @param _swapHelper The address of the SwapHelper contract
     * @param _wrappedNative The address of the wrapped native token (e.g., WBNB)
     * @param _nativeVToken The address of the native vToken (e.g., vBNB)
     * @custom:oz-upgrades-unsafe-allow constructor
     */
    constructor(IComptroller _comptroller, SwapHelper _swapHelper, IWBNB _wrappedNative, address _nativeVToken) {
        if (address(_comptroller) == address(0)) revert ZeroAddress();
        if (address(_swapHelper) == address(0)) revert ZeroAddress();
        if (address(_wrappedNative) == address(0)) revert ZeroAddress();
        if (_nativeVToken == address(0)) revert ZeroAddress();

        COMPTROLLER = _comptroller;
        SWAP_HELPER = _swapHelper;
        WRAPPED_NATIVE = _wrappedNative;
        NATIVE_VTOKEN = IVBNB(_nativeVToken);
        _disableInitializers();
    }

    /**
     * @notice Initializes the contract, setting up the upgradeable components
     */
    function initialize() external initializer {
        __Ownable2Step_init();
        __ReentrancyGuard_init();
    }

    /**
     * @notice Accepts native tokens sent to this contract
     * @dev Only allows WBNB contract to send native tokens to prevent accidental transfers
     */
    receive() external payable {
        if (msg.sender != address(WRAPPED_NATIVE)) {
            revert UnauthorizedNativeSender(msg.sender);
        }
    }

    /**
     * @notice Swaps tokens and supplies the result to a Venus market
     * @param vToken The vToken market to supply to
     * @param tokenIn The input token to swap from
     * @param amountIn The amount of input tokens to swap
     * @param minAmountOut The minimum amount of output tokens expected
     * @param swapCallData Array of bytes containing swap instructions
     * @custom:event Emits SwapAndSupply event
     */
    function swapAndSupply(
        address vToken,
        address tokenIn,
        uint256 amountIn,
        uint256 minAmountOut,
        bytes calldata swapCallData
    ) external nonReentrant {
        if (amountIn == 0) revert ZeroAmount();
        _validateVToken(vToken);

        address tokenOut = _getUnderlyingToken(vToken);

        // Handle input token transfer
        uint256 actualAmountIn = _handleTokenInput(tokenIn, amountIn);

        // Perform swap
        uint256 amountOut = _performSwap(tokenIn, tokenOut, actualAmountIn, minAmountOut, swapCallData);

        // Supply to Venus market
        uint256 amountSupplied = _supply(vToken, tokenOut, amountOut);

        emit SwapAndSupply(msg.sender, vToken, tokenIn, tokenOut, actualAmountIn, amountOut, amountSupplied);
    }

    /**
     * @notice Swaps native tokens (BNB) and supplies to a Venus market
     * @param vToken The vToken market to supply to
     * @param minAmountOut The minimum amount of output tokens expected
     * @param swapCallData Array of bytes containing swap instructions
     * @custom:event Emits SwapAndSupply event
     */
    function swapNativeAndSupply(
        address vToken,
        uint256 minAmountOut,
        bytes calldata swapCallData
    ) external payable nonReentrant {
        if (msg.value == 0) revert ZeroAmount();
        _validateVToken(vToken);

        address tokenOut = _getUnderlyingToken(vToken);

        // Wrap native tokens
        WRAPPED_NATIVE.deposit{ value: msg.value }();

        // Perform swap
        uint256 amountOut = _performSwap(address(WRAPPED_NATIVE), tokenOut, msg.value, minAmountOut, swapCallData);

        // Supply to Venus market
        uint256 amountSupplied = _supply(vToken, tokenOut, amountOut);

        emit SwapAndSupply(msg.sender, vToken, address(WRAPPED_NATIVE), tokenOut, msg.value, amountOut, amountSupplied);
    }

    /**
     * @notice Swaps tokens and repays debt to a Venus market
     * @param vToken The vToken market to repay debt to
     * @param tokenIn The input token to swap from
     * @param amountIn The amount of input tokens to swap
     * @param minAmountOut The minimum amount of output tokens expected
     * @param swapCallData Array of bytes containing swap instructions
     * @custom:event Emits SwapAndRepay event
     */
    function swapAndRepay(
        address vToken,
        address tokenIn,
        uint256 amountIn,
        uint256 minAmountOut,
        bytes calldata swapCallData
    ) external nonReentrant {
        if (amountIn == 0) revert ZeroAmount();
        _validateVToken(vToken);

        // Check if user has debt to repay (early validation)
        uint256 debtAmount = IVToken(vToken).borrowBalanceCurrent(msg.sender);
        if (debtAmount == 0) revert ZeroAmount();

        address tokenOut = _getUnderlyingToken(vToken);

        // Handle input token transfer
        uint256 actualAmountIn = _handleTokenInput(tokenIn, amountIn);

        // Perform swap
        uint256 amountOut = _performSwap(tokenIn, tokenOut, actualAmountIn, minAmountOut, swapCallData);

        // Repay debt
        uint256 amountRepaid = _repay(vToken, tokenOut, amountOut);

        emit SwapAndRepay(msg.sender, vToken, tokenIn, tokenOut, actualAmountIn, amountOut, amountRepaid);
    }

    /**
     * @notice Swaps native tokens and repays debt to a Venus market
     * @param vToken The vToken market to repay debt to
     * @param minAmountOut The minimum amount of output tokens expected
     * @param swapCallData Array of bytes containing swap instructions
     * @custom:event Emits SwapAndRepay event
     */
    function swapNativeAndRepay(
        address vToken,
        uint256 minAmountOut,
        bytes calldata swapCallData
    ) external payable nonReentrant {
        if (msg.value == 0) revert ZeroAmount();
        _validateVToken(vToken);

        // Check if user has debt to repay (early validation)
        uint256 debtAmount = IVToken(vToken).borrowBalanceCurrent(msg.sender);
        if (debtAmount == 0) revert ZeroAmount();

        address tokenOut = _getUnderlyingToken(vToken);

        // Wrap native tokens
        WRAPPED_NATIVE.deposit{ value: msg.value }();

        // Perform swap
        uint256 amountOut = _performSwap(address(WRAPPED_NATIVE), tokenOut, msg.value, minAmountOut, swapCallData);

        // Repay debt
        uint256 amountRepaid = _repay(vToken, tokenOut, amountOut);

        emit SwapAndRepay(msg.sender, vToken, address(WRAPPED_NATIVE), tokenOut, msg.value, amountOut, amountRepaid);
    }

    /**
     * @notice Swaps tokens and repays the full debt for a user
     * @param vToken The vToken market to repay full debt to
     * @param tokenIn The input token to swap from
     * @param maxAmountIn The maximum amount of input tokens to use
     * @param swapCallData Array of bytes containing swap instructions
     * @custom:event Emits SwapAndRepay event
     */
    function swapAndRepayFull(
        address vToken,
        address tokenIn,
        uint256 maxAmountIn,
        bytes calldata swapCallData
    ) external payable nonReentrant {
        if (maxAmountIn == 0) revert ZeroAmount();
        _validateVToken(vToken);

        // Get user's current debt
        uint256 debtAmount = IVToken(vToken).borrowBalanceCurrent(msg.sender);
        if (debtAmount == 0) revert ZeroAmount();

        address tokenOut = _getUnderlyingToken(vToken);

        // Handle input token transfer
        uint256 actualAmountIn = _handleTokenInput(tokenIn, maxAmountIn);

        // Perform swap - no minAmountOut since we need exact debt amount
        uint256 amountOut = _performSwap(tokenIn, tokenOut, actualAmountIn, 0, swapCallData);

        // Ensure we have enough to cover debt
        if (amountOut < debtAmount) revert InsufficientAmountOut(amountOut, debtAmount);

        // Repay full debt
        uint256 amountRepaid = _repay(vToken, tokenOut, amountOut);

        emit SwapAndRepay(msg.sender, vToken, tokenIn, tokenOut, actualAmountIn, amountOut, amountRepaid);
    }

    /**
     * @notice Sweeps leftover ERC-20 tokens from the contract
     * @param token The token to sweep
     * @custom:event Emits SweepToken event
     */
    function sweepToken(IERC20Upgradeable token) external onlyOwner {
        uint256 balance = token.balanceOf(address(this));
        if (balance > 0) {
            token.safeTransfer(owner(), balance);
            emit SweepToken(address(token), owner(), balance);
        }
    }

    /**
     * @notice Sweeps leftover native tokens from the contract
     * @custom:event Emits SweepNative event
     */
    function sweepNative() external onlyOwner {
        uint256 balance = address(this).balance;
        if (balance > 0) {
            (bool success, ) = payable(owner()).call{ value: balance }("");
            if (!success) revert NativeTransferFailed();
            emit SweepNative(owner(), balance);
        }
    }

    /**
     * @notice Validates that a vToken is listed in the comptroller
     * @param vToken The vToken address to validate
     */
    function _validateVToken(address vToken) internal view {
        if (vToken == address(0)) revert ZeroAddress();
        (bool isListed, , ) = COMPTROLLER.markets(vToken);
        if (!isListed) revert MarketNotListed(vToken);
    }

    /**
     * @notice Gets the underlying token address for a vToken
     * @param vToken The vToken address
     * @return underlying The underlying token address
     * @dev For native vToken (vBNB), returns wrapped native token address
     */
    function _getUnderlyingToken(address vToken) internal view returns (address underlying) {
        if (vToken == address(NATIVE_VTOKEN)) {
            return address(WRAPPED_NATIVE);
        } else {
            return IVToken(vToken).underlying();
        }
    }

    /**
     * @notice Handles input token transfer (ERC20 or native)
     * @param tokenIn The input token address
     * @param amountIn The amount to transfer
     * @return actualAmountIn The actual amount transferred
     */
    function _handleTokenInput(address tokenIn, uint256 amountIn) internal returns (uint256 actualAmountIn) {
        if (tokenIn == NATIVE_TOKEN_ADDR) {
            // Native token - should use msg.value
            if (msg.value != amountIn) revert InsufficientBalance();
            WRAPPED_NATIVE.deposit{ value: msg.value }();
            return msg.value;
        } else {
            // ERC20 token - measure actual amount received
            IERC20Upgradeable token = IERC20Upgradeable(tokenIn);

            uint256 balanceBefore = token.balanceOf(address(this));
            token.safeTransferFrom(msg.sender, address(this), amountIn);
            uint256 balanceAfter = token.balanceOf(address(this));

            actualAmountIn = balanceAfter - balanceBefore;
            return actualAmountIn;
        }
    }

    /**
     * @notice Performs token swap using SwapHelper
     * @param tokenIn The input token address
     * @param tokenOut The output token address
     * @param amountIn The amount of input tokens
     * @param minAmountOut The minimum amount of output tokens expected
     * @param swapCallData The swap execution data
     * @return amountOut The actual amount of output tokens received
     */
    function _performSwap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        bytes calldata swapCallData
    ) internal returns (uint256 amountOut) {
        // If tokens are the same, no swap needed
        if (tokenIn == tokenOut) {
            if (minAmountOut > 0 && amountIn < minAmountOut) {
                revert InsufficientAmountOut(amountIn, minAmountOut);
            }
            return amountIn;
        }

        // Transfer tokens to SwapHelper
        IERC20Upgradeable(tokenIn).safeTransfer(address(SWAP_HELPER), amountIn);

        // Record balance before swap
        uint256 balanceBefore = IERC20Upgradeable(tokenOut).balanceOf(address(this));

        // Execute swap using SwapHelper multicall
        (bool success, ) = address(SWAP_HELPER).call(swapCallData);
        if (!success) revert SwapFailed();

        // Calculate amount received
        uint256 balanceAfter = IERC20Upgradeable(tokenOut).balanceOf(address(this));
        amountOut = balanceAfter - balanceBefore;

        if (amountOut == 0) revert NoTokensReceived();
        if (minAmountOut > 0 && amountOut < minAmountOut) {
            revert InsufficientAmountOut(amountOut, minAmountOut);
        }

        return amountOut;
    }

    /**
     * @notice Supplies tokens to a Venus market
     * @param vToken The vToken market to supply to
     * @param underlyingToken The underlying token to supply
     * @param amount The amount to supply
     * @return amountSupplied The actual amount supplied
     */
    function _supply(
        address vToken,
        address underlyingToken,
        uint256 amount
    ) internal returns (uint256 amountSupplied) {
        if (vToken == address(NATIVE_VTOKEN)) {
            // Handle native token supply
            IWBNB(underlyingToken).withdraw(amount);
            NATIVE_VTOKEN.mint{ value: amount }();
            amountSupplied = amount;

            // Transfer vBNB tokens to user (only needed for NATIVE_VTOKEN since it doesn't support mintBehalf)
            uint256 vTokenBalance = IERC20Upgradeable(vToken).balanceOf(address(this));
            if (vTokenBalance > 0) {
                IERC20Upgradeable(vToken).safeTransfer(msg.sender, vTokenBalance);
            }
        } else {
            // Handle ERC20 token supply
            IERC20Upgradeable(underlyingToken).forceApprove(vToken, amount);
            uint256 errorCode = IVToken(vToken).mintBehalf(msg.sender, amount);
            if (errorCode != 0) revert SupplyFailed(errorCode);
            amountSupplied = amount;
        }
    }

    /**
     * @notice Repays debt to a Venus market
     * @param vToken The vToken market to repay debt to
     * @param underlyingToken The underlying token to repay with
     * @param amount The amount to repay
     * @return amountRepaid The actual amount repaid
     */
    function _repay(address vToken, address underlyingToken, uint256 amount) internal returns (uint256 amountRepaid) {
        // Get user's current debt
        uint256 debtAmount = IVToken(vToken).borrowBalanceCurrent(msg.sender);

        // Don't repay more than owed
        uint256 repayAmount = amount > debtAmount ? debtAmount : amount;

        if (vToken == address(NATIVE_VTOKEN)) {
            // Handle native token repayment
            IWBNB(underlyingToken).withdraw(repayAmount);
            IVBNB(vToken).repayBorrowBehalf{ value: repayAmount }(msg.sender);
            amountRepaid = repayAmount;
        } else {
            // Handle ERC20 token repayment
            IERC20Upgradeable(underlyingToken).forceApprove(vToken, repayAmount);
            uint256 errorCode = IVToken(vToken).repayBorrowBehalf(msg.sender, repayAmount);
            if (errorCode != 0) revert RepayFailed(errorCode);
            amountRepaid = repayAmount;
        }

        // Return any excess tokens to user
        if (amount > repayAmount) {
            uint256 excess = amount - repayAmount;
            // For both native and ERC20 cases, excess is in the underlying token form
            // For native vToken, underlyingToken is WBNB, so transfer WBNB directly
            IERC20Upgradeable(underlyingToken).safeTransfer(msg.sender, excess);
        }

        return amountRepaid;
    }
}
