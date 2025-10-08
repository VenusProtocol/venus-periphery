// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.25;

import { Ownable2StepUpgradeable } from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import { SafeERC20Upgradeable, IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";

import { IVToken, IComptroller, IWBNB, IVBNB } from "../Interfaces.sol";
import { SwapHelper } from "../SwapHelper/SwapHelper.sol";

/**
 * @title GenericPositionSwapper
 * @author Venus Protocol
 * @notice Generic contract to facilitate swapping collateral and debt positions between different vToken markets
 *         using SwapHelper for token swaps, supporting both native and non-native markets
 * @custom:security-contact security@venusprotocol.io
 */
contract GenericPositionSwapper is Ownable2StepUpgradeable, ReentrancyGuardUpgradeable {
    using SafeERC20Upgradeable for IERC20Upgradeable;

    /// @notice The Venus comptroller contract for market interactions
    IComptroller public immutable COMPTROLLER;

    /// @notice The swap helper contract for executing token swaps
    SwapHelper public immutable swapHelper;

    /// @notice The wrapped native token contract (e.g., WBNB)
    IWBNB public immutable wrappedNative;

    /// @notice The vToken representing the native asset (e.g., vBNB)
    address public immutable NATIVE_VTOKEN;

    /// @notice Mapping of approved swap pairs. (marketFrom => marketTo => helper => status)
    mapping(address => mapping(address => mapping(address => bool))) public approvedPairs;

    /// @notice Emitted after a successful collateral swap
    event CollateralSwapped(
        address indexed user,
        address indexed marketFrom,
        address indexed marketTo,
        uint256 amountSwapped,
        uint256 amountReceived
    );

    /// @notice Emitted when a user swaps their debt from one market to another
    event DebtSwapped(
        address indexed user,
        address indexed marketFrom,
        address indexed marketTo,
        uint256 amountSwapped,
        uint256 amountReceived
    );

    /// @notice Emitted when the owner sweeps leftover tokens
    event SweepToken(address indexed token, address indexed receiver, uint256 amount);

    /// @notice Emitted when the owner sweeps leftover native tokens
    event SweepNative(address indexed receiver, uint256 amount);

    /// @custom:error Unauthorized Caller is neither the user nor an approved delegate
    error Unauthorized(address account);

    /// @custom:error SeizeFailed
    error SeizeFailed(uint256 err);

    /// @custom:error RedeemFailed
    error RedeemFailed(uint256 err);

    /// @custom:error BorrowFailed
    error BorrowFailed(uint256 err);

    /// @custom:error MintFailed
    error MintFailed(uint256 err);

    /// @custom:error RepayFailed
    error RepayFailed(uint256 err);

    /// @custom:error NoVTokenBalance
    error NoVTokenBalance();

    /// @custom:error NoBorrowBalance
    error NoBorrowBalance();

    /// @custom:error ZeroAmount
    error ZeroAmount();

    /// @custom:error NoUnderlyingReceived
    error NoUnderlyingReceived();

    /// @custom:error SwapCausesLiquidation
    error SwapCausesLiquidation(uint256 err);

    /// @custom:error MarketNotListed
    error MarketNotListed(address market);

    /// @custom:error ZeroAddress
    error ZeroAddress();

    /// @custom:error TransferFailed
    error TransferFailed();

    /// @custom:error EnterMarketFailed
    error EnterMarketFailed(uint256 err);

    /// @custom:error NotApprovedHelper
    error NotApprovedHelper();

    /// @custom:error SwapCallFailed
    error SwapCallFailed();

    /**
     * @notice Constructor to set immutable variables
     * @param _comptroller The address of the Comptroller contract
     * @param _swapHelper The address of the SwapHelper contract
     * @param _wrappedNative The address of the wrapped native token (e.g., WBNB)
     * @param _nativeVToken The address of the native vToken (e.g., vBNB)
     * @custom:oz-upgrades-unsafe-allow constructor
     */
    constructor(IComptroller _comptroller, SwapHelper _swapHelper, IWBNB _wrappedNative, address _nativeVToken) {
        if (address(_comptroller) == address(0)) revert ZeroAddress();
        if (address(_swapHelper) == address(0)) revert ZeroAddress();
        if (address(_wrappedNative) == address(0)) revert ZeroAddress();
        if (address(_nativeVToken) == address(0)) revert ZeroAddress();

        COMPTROLLER = _comptroller;
        swapHelper = _swapHelper;
        wrappedNative = _wrappedNative;
        NATIVE_VTOKEN = _nativeVToken;
        _disableInitializers();
    }

    /**
     * @notice Initializes the contract, setting the deployer as the initial owner
     */
    function initialize() external initializer {
        __Ownable2Step_init();
        __ReentrancyGuard_init();
    }

    /**
     * @notice Accepts native tokens sent to this contract
     */
    receive() external payable {}

    /**
     * @notice Swaps the full vToken collateral of a user from one market to another
     * @param user The address whose collateral is being swapped
     * @param marketFrom The vToken market to seize from
     * @param marketTo The vToken market to mint into
     * @param swapData Array of bytes containing swap instructions for the SwapHelper
     * @custom:error NoVTokenBalance The user has no vToken balance in the marketFrom
     * @custom:event Emits CollateralSwapped event
     */
    function swapFullCollateral(
        address user,
        IVToken marketFrom,
        IVToken marketTo,
        bytes[] calldata swapData
    ) external payable nonReentrant {
        uint256 userBalance = marketFrom.balanceOf(user);
        if (userBalance == 0) revert NoVTokenBalance();

        uint256 amountReceived = _swapCollateral(user, marketFrom, marketTo, userBalance, swapData);
        emit CollateralSwapped(user, address(marketFrom), address(marketTo), userBalance, amountReceived);
    }

    /**
     * @notice Swaps a specific amount of collateral from one market to another
     * @param user The address whose collateral is being swapped
     * @param marketFrom The vToken market to seize from
     * @param marketTo The vToken market to mint into
     * @param amountToSwap The amount of vTokens to seize and swap
     * @param swapData Array of bytes containing swap instructions for the SwapHelper
     * @custom:error NoVTokenBalance The user has insufficient vToken balance in the marketFrom
     * @custom:error ZeroAmount The amountToSwap is zero
     * @custom:event Emits CollateralSwapped event
     */
    function swapCollateralWithAmount(
        address user,
        IVToken marketFrom,
        IVToken marketTo,
        uint256 amountToSwap,
        bytes[] calldata swapData
    ) external payable nonReentrant {
        if (amountToSwap == 0) revert ZeroAmount();
        if (amountToSwap > marketFrom.balanceOf(user)) revert NoVTokenBalance();

        uint256 amountReceived = _swapCollateral(user, marketFrom, marketTo, amountToSwap, swapData);
        emit CollateralSwapped(user, address(marketFrom), address(marketTo), amountToSwap, amountReceived);
    }

    /**
     * @notice Swaps the full debt of a user from one market to another
     * @param user The address whose debt is being swapped
     * @param marketFrom The vToken market from which debt is swapped
     * @param marketTo The vToken market into which the new debt is borrowed
     * @param swapData Array of bytes containing swap instructions for the SwapHelper
     * @custom:error NoBorrowBalance The user has no borrow balance in the marketFrom
     * @custom:event Emits DebtSwapped event
     */
    function swapFullDebt(
        address user,
        IVToken marketFrom,
        IVToken marketTo,
        bytes[] calldata swapData
    ) external payable nonReentrant {
        uint256 borrowBalance = marketFrom.borrowBalanceCurrent(user);
        if (borrowBalance == 0) revert NoBorrowBalance();

        uint256 amountReceived = _swapDebt(user, marketFrom, marketTo, borrowBalance, swapData);
        emit DebtSwapped(user, address(marketFrom), address(marketTo), borrowBalance, amountReceived);
    }

    /**
     * @notice Swaps a specific amount of debt from one market to another
     * @param user The address whose debt is being swapped
     * @param marketFrom The vToken market from which debt is swapped
     * @param marketTo The vToken market into which the new debt is borrowed
     * @param amountToSwap The amount of debt to swap
     * @param swapData Array of bytes containing swap instructions for the SwapHelper
     * @custom:error NoBorrowBalance The user has insufficient borrow balance in the marketFrom
     * @custom:error ZeroAmount The amountToSwap is zero
     * @custom:event Emits DebtSwapped event
     */
    function swapDebtWithAmount(
        address user,
        IVToken marketFrom,
        IVToken marketTo,
        uint256 amountToSwap,
        bytes[] calldata swapData
    ) external payable nonReentrant {
        if (amountToSwap == 0) revert ZeroAmount();
        if (amountToSwap > marketFrom.borrowBalanceCurrent(user)) revert NoBorrowBalance();

        uint256 amountReceived = _swapDebt(user, marketFrom, marketTo, amountToSwap, swapData);
        emit DebtSwapped(user, address(marketFrom), address(marketTo), amountToSwap, amountReceived);
    }

    /**
     * @notice Allows the owner to sweep leftover ERC-20 tokens from the contract
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
     * @notice Allows the owner to sweep leftover native tokens from the contract
     * @custom:event Emits SweepNative event
     */
    function sweepNative() external onlyOwner {
        uint256 balance = address(this).balance;
        if (balance > 0) {
            (bool success, ) = payable(owner()).call{ value: balance }("");
            if (!success) revert TransferFailed();
            emit SweepNative(owner(), balance);
        }
    }

    /**
     * @notice Internal function that performs the collateral swap process
     * @param user The address whose collateral is being swapped
     * @param marketFrom The vToken market from which collateral is seized
     * @param marketTo The vToken market into which the swapped collateral is minted (cannot be VBNB)
     * @param amountToSeize The amount of vTokens to seize and convert
     * @param swapData Array of bytes containing swap instructions for the SwapHelper
     * @return amountReceived The amount of underlying tokens received after the swap
     * @custom:error MarketNotListed if one of the specified markets is not listed in the Comptroller
     * @custom:error Unauthorized if the caller is neither the user nor an approved delegate
     * @custom:error SeizeFailed if the seize operation fails
     * @custom:error RedeemFailed if the redeem operation fails
     * @custom:error NoUnderlyingReceived if no underlying tokens are received from the swap
     * @custom:error MintFailed if the mint operation fails
     * @custom:error SwapCallFailed if the token swap execution fails
     */
    function _swapCollateral(
        address user,
        IVToken marketFrom,
        IVToken marketTo,
        uint256 amountToSeize,
        bytes[] calldata swapData
    ) internal returns (uint256 amountReceived) {
        if (!approvedPairs[address(marketFrom)][address(marketTo)][address(swapHelper)]) {
            revert NotApprovedHelper();
        }
        // Market listing checks
        (bool isMarketListed, , ) = COMPTROLLER.markets(address(marketFrom));
        if (!isMarketListed) revert MarketNotListed(address(marketFrom));

        (isMarketListed, , ) = COMPTROLLER.markets(address(marketTo));
        if (!isMarketListed) revert MarketNotListed(address(marketTo));

        // Authorization check
        if (user != msg.sender && !COMPTROLLER.approvedDelegates(user, msg.sender)) {
            revert Unauthorized(msg.sender);
        }

        // Check account safety before operation
        _checkAccountSafe(user);

        // Seize vTokens from user to this contract
        uint256 err = marketFrom.seize(address(this), user, amountToSeize);
        if (err != 0) revert SeizeFailed(err);

        // Get underlying tokens by redeeming vTokens
        IERC20Upgradeable fromUnderlying;
        uint256 receivedFromToken;

        if (address(marketFrom) == address(NATIVE_VTOKEN)) {
            // Handle native token market (e.g., vBNB)
            uint256 nativeBalanceBefore = address(this).balance;
            err = marketFrom.redeem(amountToSeize);
            if (err != 0) revert RedeemFailed(err);

            receivedFromToken = address(this).balance - nativeBalanceBefore;
            if (receivedFromToken == 0) revert NoUnderlyingReceived();

            // Wrap native tokens to wrapped native for swapping
            wrappedNative.deposit{ value: receivedFromToken }();
            fromUnderlying = IERC20Upgradeable(address(wrappedNative));
        } else {
            // Handle regular ERC20 token markets
            fromUnderlying = IERC20Upgradeable(marketFrom.underlying());
            uint256 fromUnderlyingBalanceBefore = fromUnderlying.balanceOf(address(this));

            err = marketFrom.redeem(amountToSeize);
            if (err != 0) revert RedeemFailed(err);

            receivedFromToken = fromUnderlying.balanceOf(address(this)) - fromUnderlyingBalanceBefore;
            if (receivedFromToken == 0) revert NoUnderlyingReceived();
        }

        // Prepare for swap
        IERC20Upgradeable toUnderlying;
        toUnderlying = IERC20Upgradeable(marketTo.underlying());

        uint256 toUnderlyingBalanceBefore = toUnderlying.balanceOf(address(this));

        // Perform swap using SwapHelper
        _performSwap(fromUnderlying, receivedFromToken, swapData);

        uint256 toUnderlyingReceived = toUnderlying.balanceOf(address(this)) - toUnderlyingBalanceBefore;
        if (toUnderlyingReceived == 0) revert NoUnderlyingReceived();

        toUnderlying.forceApprove(address(marketTo), toUnderlyingReceived);

        err = marketTo.mintBehalf(user, toUnderlyingReceived);
        if (err != 0) revert MintFailed(err);

        if (COMPTROLLER.checkMembership(user, marketFrom) && !COMPTROLLER.checkMembership(user, marketTo)) {
            err = COMPTROLLER.enterMarket(user, address(marketTo));
            if (err != 0) revert EnterMarketFailed(err);
        }

        _checkAccountSafe(user);

        return toUnderlyingReceived;
    }

    /**
     * @notice Internal function that performs the debt swap process
     * @param user The address whose debt is being swapped
     * @param marketFrom The vToken market to which debt is repaid
     * @param marketTo The vToken market into which the new debt is borrowed (cannot be VBNB)
     * @param amountToBorrow The amount of debt to borrow from marketTo
     * @param swapData Array of bytes containing swap instructions for the SwapHelper
     * @return amountReceived The amount of underlying tokens received after the swap
     * @custom:error MarketNotListed if one of the specified markets is not listed in the Comptroller
     * @custom:error Unauthorized if the caller is neither the user nor an approved delegate
     * @custom:error BorrowFailed if the borrow operation fails
     * @custom:error NoUnderlyingReceived if no underlying tokens are received from the swap
     * @custom:error RepayFailed if the repay operation fails
     * @custom:error SwapCallFailed if the token swap execution fails
     */
    function _swapDebt(
        address user,
        IVToken marketFrom,
        IVToken marketTo,
        uint256 amountToBorrow,
        bytes[] calldata swapData
    ) internal returns (uint256 amountReceived) {
        _validateSwapPair(marketFrom, marketTo);
        _validateUser(user);
        _checkAccountSafe(user);

        _borrowAndApprove(user, marketTo, amountToBorrow);
        uint256 receivedFromToken = _performDebtSwap(marketFrom, swapData);

        _repayDebtToMarket(user, marketFrom, receivedFromToken);
        _checkAccountSafe(user);

        return receivedFromToken;
    }

    /**
     * @notice Performs token swap via the SwapHelper contract
     * @dev Transfers tokens to SwapHelper and executes the swap operation.
     *      The swap operation is expected to return the output tokens to this contract.
     * @param tokenIn The input token to be swapped
     * @param amountIn The amount of input tokens to swap
     * @param swapData Array of bytes containing swap instructions for the SwapHelper
     * @custom:error SwapCallFailed if the swap execution fails
     */
    function _performSwap(IERC20Upgradeable tokenIn, uint256 amountIn, bytes[] calldata swapData) internal {
        // Transfer tokens to SwapHelper
        tokenIn.safeTransfer(address(swapHelper), amountIn);

        // Encode swap instructions for SwapHelper multicall
        bytes memory swapCallData = abi.encodeWithSelector(swapHelper.multicall.selector, swapData);

        // Execute swap
        (bool success, ) = address(swapHelper).call(swapCallData);
        if (!success) {
            revert SwapCallFailed();
        }
    }

    /**
     * @notice Checks if a user's account is safe post-swap
     * @param user The address to check
     * @custom:error SwapCausesLiquidation if the user's account is undercollateralized
     */
    function _checkAccountSafe(address user) internal view {
        (uint256 err, , uint256 shortfall) = COMPTROLLER.getAccountLiquidity(user);
        if (err != 0 || shortfall > 0) revert SwapCausesLiquidation(err);
    }

    /**
     * @notice Validates the swap pair and helper
     */
    function _validateSwapPair(IVToken marketFrom, IVToken marketTo) internal view {
        if (!approvedPairs[address(marketFrom)][address(marketTo)][address(swapHelper)]) {
            revert NotApprovedHelper();
        }

        (bool isMarketListed, , ) = COMPTROLLER.markets(address(marketFrom));
        if (!isMarketListed) revert MarketNotListed(address(marketFrom));

        (isMarketListed, , ) = COMPTROLLER.markets(address(marketTo));
        if (!isMarketListed) revert MarketNotListed(address(marketTo));
    }

    /**
     * @notice Validates user authorization
     */
    function _validateUser(address user) internal view {
        if (user != msg.sender && !COMPTROLLER.approvedDelegates(user, msg.sender)) {
            revert Unauthorized(msg.sender);
        }
    }

    /**
     * @notice Borrows tokens and approves swap helper
     */
    function _borrowAndApprove(address user, IVToken marketTo, uint256 amountToBorrow) internal returns (uint256) {
        IERC20Upgradeable toUnderlying = IERC20Upgradeable(marketTo.underlying());
        uint256 balanceBefore = toUnderlying.balanceOf(address(this));

        uint256 err = marketTo.borrowBehalf(user, amountToBorrow);
        if (err != 0) revert BorrowFailed(err);

        uint256 received = toUnderlying.balanceOf(address(this)) - balanceBefore;
        toUnderlying.forceApprove(address(swapHelper), received);

        return received;
    }

    /**
     * @notice Performs debt swap and returns received amount
     */
    function _performDebtSwap(IVToken marketFrom, bytes[] calldata swapData) internal returns (uint256) {
        bool isFromNative = address(marketFrom) == address(NATIVE_VTOKEN);
        IERC20Upgradeable fromUnderlying = isFromNative
            ? IERC20Upgradeable(address(wrappedNative))
            : IERC20Upgradeable(marketFrom.underlying());

        uint256 balanceBefore = fromUnderlying.balanceOf(address(this));

        // Execute swap instructions
        bytes memory swapCallData = abi.encodeWithSelector(swapHelper.multicall.selector, swapData);
        (bool success, ) = address(swapHelper).call(swapCallData);
        if (!success) revert SwapCallFailed();

        uint256 received = fromUnderlying.balanceOf(address(this)) - balanceBefore;
        if (received == 0) revert NoUnderlyingReceived();

        return received;
    }

    /**
     * @notice Repays debt to market
     */
    function _repayDebtToMarket(address user, IVToken marketFrom, uint256 amount) internal {
        bool isFromNative = address(marketFrom) == address(NATIVE_VTOKEN);

        if (isFromNative) {
            wrappedNative.withdraw(amount);
            IVBNB(NATIVE_VTOKEN).repayBorrowBehalf{ value: amount }(user);
        } else {
            IERC20Upgradeable fromUnderlying = IERC20Upgradeable(marketFrom.underlying());
            fromUnderlying.forceApprove(address(marketFrom), amount);
            uint256 err = marketFrom.repayBorrowBehalf(user, amount);
            if (err != 0) revert RepayFailed(err);
        }
    }

    /**
     * @notice Internal function to handle debt repayment for both native and ERC20 tokens
     * @param user The user whose debt is being repaid
     * @param marketFrom The market to repay debt to
     * @param fromUnderlying The underlying token to use for repayment
     * @param receivedFromToken The amount of tokens received to repay
     * @param isFromNative Whether the market is native token market
     * @custom:error RepayFailed if the repay operation fails
     */
    function _repayDebt(
        address user,
        IVToken marketFrom,
        IERC20Upgradeable fromUnderlying,
        uint256 receivedFromToken,
        bool isFromNative
    ) internal {
        if (isFromNative) {
            // Unwrap wrapped native tokens and repay
            wrappedNative.withdraw(receivedFromToken);
            IVBNB(NATIVE_VTOKEN).repayBorrowBehalf{ value: receivedFromToken }(user);
        } else {
            // Repay with ERC20 tokens
            fromUnderlying.forceApprove(address(marketFrom), receivedFromToken);
            uint256 err = marketFrom.repayBorrowBehalf(user, receivedFromToken);
            if (err != 0) revert RepayFailed(err);
        }
    }
}
