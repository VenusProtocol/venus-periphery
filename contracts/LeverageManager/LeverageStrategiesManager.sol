// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

import { Ownable2StepUpgradeable } from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import { SafeERC20Upgradeable, IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";

import { IVToken, IComptroller, IFlashLoanReceiver, IProtocolShareReserve } from "../Interfaces.sol";
import { SwapHelper } from "../SwapHelper/SwapHelper.sol";

import { ILeverageStrategiesManager } from "./ILeverageStrategiesManager.sol";

/**
 * @title LeverageStrategiesManager
 * @author Venus Protocol
 * @notice Contract for managing leveraged positions using flash loans and token swaps
 */
contract LeverageStrategiesManager is Ownable2StepUpgradeable, ReentrancyGuardUpgradeable, IFlashLoanReceiver, ILeverageStrategiesManager {
    using SafeERC20Upgradeable for IERC20Upgradeable;

    /// @notice The Venus comptroller contract for market interactions and flash loans execution
    IComptroller public immutable COMPTROLLER;
    
    /// @notice The protocol share reserve where dust amounts are transferred
    IProtocolShareReserve public immutable protocolShareReserve;
    
    /// @notice The swap helper contract for executing token swaps during leverage operations
    SwapHelper public immutable swapHelper;

    /**
     * @notice Enumeration of operation types for flash loan callbacks
     * @param NONE Default value indicating no operation set
     * @param ENTER_WITH_COLLATERAL Operation for entering a leveraged position with collateral seed
     * @param ENTER_WITH_BORROWED Operation for entering a leveraged position with borrowed asset seed
     * @param EXIT Operation for exiting a leveraged position
     */
    enum OperationType {
        NONE,
        ENTER_WITH_COLLATERAL,
        ENTER_WITH_BORROWED,
        EXIT
    }

    /// @dev Transient variable to track the current operation type during flash loan execution
    OperationType transient operationType;

    /// @dev Transient variable to store the msg.sender during flash loan execution 
    address transient operationInitiator;
    
    /// @dev Transient variable to store the collateral market during flash loan execution
    IVToken transient collateralMarket;
    
    /// @dev Transient variable to store the collateral amount during flash loan execution
    uint256 transient collateralAmount;
    
    /// @dev Transient variable to store the borrowed amount seed during flash loan execution
    uint256 transient borrowedAmountSeed;
    
    /// @dev Transient variable to store the minimum amountOut expected after swap
    uint256 transient minAmountOutAfterSwap;

    /**
     * @notice Contract constructor
     * @dev Sets immutable variables and disables initializers for the implementation contract
     * @param _comptroller The Venus comptroller contract address
     * @param _protocolShareReserve The protocol share reserve contract address
     * @param _swapHelper The swap helper contract address
     * @custom:oz-upgrades-unsafe-allow constructor
     */
    constructor(IComptroller _comptroller,  IProtocolShareReserve _protocolShareReserve, SwapHelper _swapHelper) {
        COMPTROLLER = _comptroller;
        protocolShareReserve = _protocolShareReserve;
        swapHelper = _swapHelper;
        _disableInitializers();
    }

    /**
     * @notice Initializes the contract
     * @dev Sets up the Ownable2Step functionality. Can only be called once.
     */
    function initialize() external initializer {
        __Ownable2Step_init();
        __ReentrancyGuard_init();
    }

    /// @inheritdoc ILeverageStrategiesManager
    function enterLeveragedPositionWithCollateral(
        IVToken _collateralMarket,
        uint256 _collateralAmountSeed,
        IVToken _borrowedMarket,
        uint256 _borrowedAmountToFlashLoan,
        uint256 _minAmountOutAfterSwap,
        bytes calldata _swapData
    ) external {
        _checkMarketListed(_collateralMarket);
        _checkMarketListed(_borrowedMarket);

        _checkUserAuthorized(msg.sender);
        _checkAccountSafe(msg.sender);

        _validateAndEnterMarket(msg.sender, _collateralMarket, _borrowedMarket);
        _transferSeedAmountFromUser(_collateralMarket, msg.sender, _collateralAmountSeed);
        
        operationInitiator = msg.sender;
        collateralMarket = _collateralMarket;
        collateralAmount = _collateralAmountSeed;
        minAmountOutAfterSwap = _minAmountOutAfterSwap;
        operationType = OperationType.ENTER_WITH_COLLATERAL;

        IVToken[] memory borrowedMarkets = new IVToken[](1);
        borrowedMarkets[0] = _borrowedMarket;
        uint256[] memory flashLoanAmounts = new uint256[](1);
        flashLoanAmounts[0] = _borrowedAmountToFlashLoan;

        COMPTROLLER.executeFlashLoan(
            payable(msg.sender),
            payable(address(this)),
            borrowedMarkets,
            flashLoanAmounts,
            _swapData
        );

        emit LeveragedPositionEnteredWithCollateral(
            msg.sender,
            _collateralMarket,
            _collateralAmountSeed,
            _borrowedMarket,
            _borrowedAmountToFlashLoan
        );

        _checkAccountSafe(msg.sender);
    }

    /// @inheritdoc ILeverageStrategiesManager
    function enterLeveragedPositionWithBorrowed(
        IVToken _collateralMarket,
        IVToken _borrowedMarket,
        uint256 _borrowedAmountSeed,
        uint256 _borrowedAmountToFlashLoan,
        uint256 _minAmountOutAfterSwap,
        bytes calldata _swapData
    ) external {
        _checkMarketListed(_collateralMarket);
        _checkMarketListed(_borrowedMarket);
        
        _checkUserAuthorized(msg.sender);
        _checkAccountSafe(msg.sender);

        _validateAndEnterMarket(msg.sender, _collateralMarket, _borrowedMarket);
        _transferSeedAmountFromUser(_borrowedMarket, msg.sender, _borrowedAmountSeed);

        operationInitiator = msg.sender;
        collateralMarket = _collateralMarket;
        borrowedAmountSeed = _borrowedAmountSeed;
        minAmountOutAfterSwap = _minAmountOutAfterSwap;
        operationType = OperationType.ENTER_WITH_BORROWED;

        IVToken[] memory borrowedMarkets = new IVToken[](1);
        borrowedMarkets[0] = _borrowedMarket;
        uint256[] memory flashLoanAmounts = new uint256[](1);
        flashLoanAmounts[0] = _borrowedAmountToFlashLoan;

        COMPTROLLER.executeFlashLoan(
            payable(msg.sender),
            payable(address(this)),
            borrowedMarkets,
            flashLoanAmounts,
            _swapData
        );

        emit LeveragedPositionEnteredWithBorrowed(
            msg.sender,
            _collateralMarket,
            _borrowedMarket,
            _borrowedAmountSeed,
            _borrowedAmountToFlashLoan
        );

        _checkAccountSafe(msg.sender);
    }

    /// @inheritdoc ILeverageStrategiesManager
    function exitLeveragedPosition(
        IVToken _collateralMarket,
        uint256 _collateralAmountToRedeemForSwap,
        IVToken _borrowedMarket,
        uint256 _borrowedAmountToFlashLoan,
        uint256 _minAmountOutAfterSwap,
        bytes calldata _swapData 
    ) external {
        _checkMarketListed(_collateralMarket);
        _checkMarketListed(_borrowedMarket);

        _checkUserAuthorized(msg.sender);

        operationInitiator = msg.sender;
        collateralMarket = _collateralMarket;
        collateralAmount = _collateralAmountToRedeemForSwap;
        minAmountOutAfterSwap = _minAmountOutAfterSwap;
        operationType = OperationType.EXIT;

        IVToken[] memory borrowedMarkets = new IVToken[](1);
        borrowedMarkets[0] = _borrowedMarket;
        uint256[] memory flashLoanAmounts = new uint256[](1);
        flashLoanAmounts[0] = _borrowedAmountToFlashLoan;

        COMPTROLLER.executeFlashLoan(
            payable(msg.sender),
            payable(address(this)),
            borrowedMarkets,
            flashLoanAmounts,
            _swapData
        );

        emit LeveragedPositionExited(
            msg.sender,
            _collateralMarket,
            _collateralAmountToRedeemForSwap,
            _borrowedMarket,
            _borrowedAmountToFlashLoan
        );

        _transferDustToTreasury(_collateralMarket);
        _transferDustToTreasury(_borrowedMarket);

        _checkAccountSafe(msg.sender);
    }

    /**
     * @notice Flash loan callback entrypoint called by Comptroller.
     * @param vTokens Array with the borrowed vToken market (single element)
     * @param amounts Array with the borrowed underlying amount (single element)
     * @param premiums Array with the flash loan fee amount (single element)
     * @param initiator The address that initiated the flash loan (unused)
     * @param onBehalf The user for whome debt will be opened
     * @param param Encoded auxiliary data for the operation (e.g., swap multicall)
     * @return success Whether the execution succeeded
     * @return repayAmounts Amounts to approve for flash loan repayment
     * @custom:error InitiatorMismatch When initiator is not this contract
     * @custom:error OnBehalfMismatch When onBehalf is not the operation initiator
     * @custom:error UnauthorizedExecutor When caller is not the Comptroller
     * @custom:error FlashLoanAssetOrAmountMismatch When array lengths mismatch or > 1 element
     * @custom:error InvalidExecuteOperation When operation type is unknown
     */
    function executeOperation(
        IVToken[] calldata vTokens,
        uint256[] calldata amounts,
        uint256[] calldata premiums,
        address initiator,
        address onBehalf,
        bytes calldata param
    ) external override returns (bool success, uint256[] memory repayAmounts) {
        if (initiator != address(this)) {
            revert InitiatorMismatch();
        }

        if (onBehalf != operationInitiator) {
            revert OnBehalfMismatch();
        }

        if (msg.sender != address(COMPTROLLER)) {
            revert UnauthorizedExecutor();
        }

        if (vTokens.length != 1 || amounts.length != 1 || premiums.length != 1) {
            revert FlashLoanAssetOrAmountMismatch(); 
        }

        repayAmounts = new uint256[](1);

        if(operationType == OperationType.ENTER_WITH_COLLATERAL) {
            repayAmounts[0] = _executeEnterOperation(onBehalf, vTokens[0], amounts[0], premiums[0], param);
        } else if(operationType == OperationType.ENTER_WITH_BORROWED) {
            repayAmounts[0] = _executeEnterWithBorrowedOperation(onBehalf, vTokens[0], amounts[0], premiums[0], param);
        } else if(operationType == OperationType.EXIT) {
            repayAmounts[0] = _executeExitOperation(onBehalf,vTokens[0], amounts[0], premiums[0], param);
        } else {
            revert InvalidExecuteOperation();
        }

        return (true, repayAmounts);
    }

    /**
     * @notice Executes the enter leveraged position operation during flash loan callback
     * @dev This function performs the following steps:
     *      1. Swaps borrowed assets for collateral assets
     *      2. Transfers user's seed collateral (if any) to this contract
     *      3. Supplies all collateral to the Venus market on behalf of the user
     *      4. Borrows the repayment amount on behalf of the user
     *      5. Approves the borrowed asset for repayment to the flash loan
     * @param onBehalf Address on whose behalf the operation is performed
     * @param borrowMarket The vToken market from which assets were borrowed
     * @param borrowedAssetAmount The amount of borrowed assets received from flash loan
     * @param borrowedAssetFees The fees to be paid on the borrowed asset amount
     * @param swapCallData The encoded swap instructions for converting borrowed to collateral assets
     * @return borrowedAssetAmountToRepay The total amount of borrowed assets to repay (principal + fees)
     * @custom:error TransferFromUserFailed if transferring seed borrowed assets from user fails
     * @custom:error EnterLeveragePositionMintFailed if mint behalf operation fails
     * @custom:error EnterLeveragePositionBorrowBehalfFailed if  borrow behalf operation fails
     * @custom:error SwapCallFailed if token swap execution fails
     */
    function _executeEnterOperation(address onBehalf, IVToken borrowMarket, uint256 borrowedAssetAmount, uint256 borrowedAssetFees, bytes calldata swapCallData) internal returns (uint256 borrowedAssetAmountToRepay) {
        IERC20Upgradeable borrowedAsset = IERC20Upgradeable(borrowMarket.underlying());

        IERC20Upgradeable collateralAsset = IERC20Upgradeable(collateralMarket.underlying());
        uint256 swappedCollateralAmountOut = _performSwap(borrowedAsset, borrowedAssetAmount, collateralAsset, minAmountOutAfterSwap, swapCallData);

        uint256 mintSuccess = collateralMarket.mintBehalf(onBehalf, swappedCollateralAmountOut + collateralAmount);
        if (mintSuccess != 0) {
            revert EnterLeveragePositionMintFailed(mintSuccess);
        }

        borrowedAssetAmountToRepay = _borrowAndRepayFlashLoanFee(onBehalf, borrowMarket, borrowedAsset, borrowedAssetFees);
    }

    /**
     * @notice Executes the enter leveraged position with borrowed assets operation during flash loan callback
     * @dev This function performs the following steps:
     *      1. Transfers user's seed borrowed assets (if any) to this contract
     *      2. Swaps the total borrowed assets (seed + flash loan) for collateral assets
     *      3. Supplies all collateral to the Venus market on behalf of the user
     *      4. Borrows the repayment amount on behalf of the user
     *      5. Approves the borrowed asset for repayment to the flash loan
     * @param onBehalf Address on whose behalf the operation is performed
     * @param borrowMarket The vToken market from which assets were borrowed
     * @param borrowedAssetAmount The amount of borrowed assets received from flash loan
     * @param borrowedAssetFees The fees to be paid on the borrowed asset amount
     * @param swapCallData The encoded swap instructions for converting borrowed to collateral assets
     * @return borrowedAssetAmountToRepay The total amount of borrowed assets to repay (principal + fees)
     * @custom:error TransferFromUserFailed if transferring seed borrowed assets from user fails
     * @custom:error EnterLeveragePositionMintFailed if mint behalf operation fails
     * @custom:error EnterLeveragePositionBorrowBehalfFailed if  borrow behalf operation fails
     * @custom:error SwapCallFailed if token swap execution fails
     * @custom:error InsufficientAmountOutAfterSwap if collateral balance after swap is below minimum
     */
    function _executeEnterWithBorrowedOperation(address onBehalf, IVToken borrowMarket, uint256 borrowedAssetAmount, uint256 borrowedAssetFees, bytes calldata swapCallData) internal returns (uint256 borrowedAssetAmountToRepay) {
        IERC20Upgradeable borrowedAsset = IERC20Upgradeable(borrowMarket.underlying());
        IERC20Upgradeable collateralAsset = IERC20Upgradeable(collateralMarket.underlying());

        uint256 totalBorrowedAmountToSwap = borrowedAmountSeed + borrowedAssetAmount;

        uint256 swappedCollateralAmountOut = _performSwap(borrowedAsset, totalBorrowedAmountToSwap, collateralAsset, minAmountOutAfterSwap, swapCallData);

        uint256 mintSuccess = collateralMarket.mintBehalf(onBehalf, swappedCollateralAmountOut);
        if (mintSuccess != 0) {
            revert EnterLeveragePositionMintFailed(mintSuccess);
        }

        borrowedAssetAmountToRepay = _borrowAndRepayFlashLoanFee(onBehalf, borrowMarket, borrowedAsset, borrowedAssetFees);
    }

    /**
     * @notice Executes the exit leveraged position operation during flash loan callback
     * @dev This function performs the following steps:
     *      1. Uses borrowed assets to repay user's debt in the borrowed market
     *      2. Redeems specified amount of collateral from the Venus market
     *      3. Swaps collateral assets for borrowed assets
     *      4. Approves the borrowed asset for repayment to the flash loan
     * @param onBehalf Address on whose behalf the operation is performed
     * @param borrowMarket The vToken market from which assets were borrowed via flash loan
     * @param borrowedAssetAmountToRepayFromFlashLoan The amount borrowed via flash loan for debt repayment
     * @param borrowedAssetFees The fees to be paid on the borrowed asset amount
     * @param swapCallData The encoded swap instructions for converting collateral to borrowed assets
     * @return borrowedAssetAmountToRepay The total amount of borrowed assets to repay (principal + fees)
     * @custom:error ExitLeveragePositionRepayFailed if repayment of borrowed assets fails
     * @custom:error ExitLeveragePositionRedeemFailed if redeem operations fail
     * @custom:error SwapCallFailed if token swap execution fails
     * @custom:error InsufficientFundsToRepayFlashloan if insufficient funds are available to repay the flash loan
     */
    function _executeExitOperation(address onBehalf, IVToken borrowMarket, uint256 borrowedAssetAmountToRepayFromFlashLoan, uint256 borrowedAssetFees, bytes calldata swapCallData) internal returns (uint256 borrowedAssetAmountToRepay) {
        IERC20Upgradeable borrowedAsset = IERC20Upgradeable(borrowMarket.underlying());

        borrowedAsset.safeApprove(address(borrowMarket), borrowedAssetAmountToRepayFromFlashLoan);
        uint256 repaySuccess = borrowMarket.repayBorrowBehalf(onBehalf, borrowedAssetAmountToRepayFromFlashLoan);

        if (repaySuccess != 0) {
            revert ExitLeveragePositionRepayFailed(repaySuccess);
        }

        uint256 minCollateralAmountInForSwap = collateralAmount;

        uint256 redeemSuccess = collateralMarket.redeemUnderlyingBehalf(onBehalf, minCollateralAmountInForSwap);
        if (redeemSuccess != 0) {
            revert ExitLeveragePositionRedeemFailed(redeemSuccess);
        }
        
        IERC20Upgradeable collateralAsset = IERC20Upgradeable(collateralMarket.underlying());
        uint256 swappedBorrowedAmountOut = _performSwap(collateralAsset, minCollateralAmountInForSwap, borrowedAsset, minAmountOutAfterSwap, swapCallData);

        borrowedAssetAmountToRepay = borrowedAssetAmountToRepayFromFlashLoan + borrowedAssetFees;

        if (swappedBorrowedAmountOut < borrowedAssetAmountToRepay) {
            revert InsufficientFundsToRepayFlashloan();
        }

       borrowedAsset.safeApprove(address(borrowMarket), borrowedAssetAmountToRepay);
    }

    /**
     * @notice Performs token swap via the SwapHelper contract
     * @dev Transfers tokens to SwapHelper and executes the swap operation.
     *      The swap operation is expected to return the output tokens to this contract.
     * @param tokenIn The input token to be swapped
     * @param amountIn The amount of input tokens to swap
     * @param tokenOut The output token to receive from the swap
     * @param minAmountOut The minimum acceptable amount of output tokens
     * @param param The encoded swap instructions/calldata for the SwapHelper
     * @custom:error SwapCallFailed if the swap execution fails
     */
    function _performSwap(IERC20Upgradeable tokenIn, uint256 amountIn, IERC20Upgradeable tokenOut, uint256 minAmountOut, bytes calldata param) internal nonReentrant returns (uint256 amountOut) {
        tokenIn.safeTransfer(address(swapHelper), amountIn);

        uint256 tokenOutBalanceBefore = tokenOut.balanceOf(address(this));

        (bool success,) = address(swapHelper).call(param);
        if(!success) {
            revert TokenSwapCallFailed();
        }

        uint256 tokenOutBalanceAfter = tokenOut.balanceOf(address(this));

        amountOut = tokenOutBalanceAfter - tokenOutBalanceBefore;
        if(amountOut < minAmountOut) {
            revert InsufficientAmountOutAfterSwap();
        }

        return amountOut;
    }

    /**
     * @notice Transfers tokens from the user to this contract if amount > 0
     * @dev If the specified amount is greater than zero, transfers tokens from the user.
     *      Reverts if the actual transferred amount does not match the expected amount.
     * @param market The vToken market whose underlying asset is to be transferred
     * @param user The address of the user to transfer tokens from
     * @param amount The amount of tokens to transfer
     * @custom:error TransferFromUserFailed if the transferred amount does not match the expected amount
     */
    function _transferSeedAmountFromUser(IVToken market, address user, uint256 amount) internal {
        if(amount > 0) {
            IERC20Upgradeable token = IERC20Upgradeable(market.underlying());
            uint256 tokenBalanceBefore = token.balanceOf(address(this));

            token.safeTransferFrom(user, address(this), amount);
            uint256 tokenBalanceAfter = token.balanceOf(address(this));
            
            if(tokenBalanceAfter - tokenBalanceBefore != amount) {
                revert TransferFromUserFailed();
            }
        }
    }

    /**
     * @notice Transfers any remaining dust amounts to the protocol share reserve
     * @dev This function cleans up small remaining balances after operations and
     *      updates the protocol share reserve's asset state for proper accounting.
     * @param market The vToken market whose underlying asset dust should be transferred
     */
    function _transferDustToTreasury(IVToken market) internal {
        IERC20Upgradeable asset = IERC20Upgradeable(market.underlying());

        uint256 dustAmount = asset.balanceOf(address(this));
        if(dustAmount > 0) {
            asset.safeTransfer(address(protocolShareReserve), dustAmount);
            protocolShareReserve.updateAssetsState(address(COMPTROLLER), address(asset), IProtocolShareReserve.IncomeType.FLASHLOAN);
        }
    }

    /**
     * @notice Borrows assets on behalf of the user to repay the flash loan fee
     * @dev Borrows the total amount needed to repay the flash loan fee
     *      and approves the borrowed asset for repayment to the flash loan fee.
     * @param borrowMarket The vToken market from which assets will be borrowed
     * @param borrowedAsset The underlying asset being borrowed
     * @param borrowedAssetFees The fees to be paid on the borrowed asset amount
     * @return borrowedAssetAmountToRepay The total amount of borrowed assets to repay 
     * @custom:error InsufficientFundsToRepayFlashloan if insufficient funds are available to repay the flash loan
     * @custom:error EnterLeveragePositionBorrowBehalfFailed if  borrow behalf operation fails
     */
    function _borrowAndRepayFlashLoanFee(address onBehalf, IVToken borrowMarket, IERC20Upgradeable borrowedAsset, uint256 borrowedAssetFees) internal returns (uint256 borrowedAssetAmountToRepay) {
        borrowedAssetAmountToRepay = borrowedAssetFees;

        uint256 marketBalanceBeforeBorrow = borrowedAsset.balanceOf(address(borrowMarket));
        uint256 borrowSuccess = borrowMarket.borrowBehalf(onBehalf, borrowedAssetAmountToRepay);
        if (borrowSuccess != 0) {
            revert EnterLeveragePositionBorrowBehalfFailed(borrowSuccess);
        }
        uint256 marketBalanceAfterBorrow = borrowedAsset.balanceOf(address(borrowMarket));

        if (marketBalanceBeforeBorrow - marketBalanceAfterBorrow < borrowedAssetAmountToRepay) {
            revert InsufficientFundsToRepayFlashloan();
        }

        borrowedAsset.safeApprove(address(borrowMarket), borrowedAssetAmountToRepay);
    }

    /**
     * @notice Checks that the caller is authorized to act on behalf of the specified user.
     * @param user The address of the user for whom the action is being performed.
     * @custom:error UnauthorizedCaller If caller is neither the user nor an approved delegate
     */
    function _checkUserAuthorized(address user) internal view {
        if (user != msg.sender && !COMPTROLLER.approvedDelegates(user, msg.sender)) {
            revert UnauthorizedCaller(msg.sender);
        }
    }

    /**
     * @notice Checks if a `user` account remains safe after leverage operations
     * @dev Verifies that the user's account has no liquidity shortfall and the comptroller
     *      returned no errors when calculating account liquidity. This ensures the account
     *      won't be immediately liquidatable after the leverage operation.
     * @param user The address to check account safety for
     * @custom:error LeverageCausesLiquidation if the account has a liquidity shortfall or comptroller error
     */
    function _checkAccountSafe(address user) internal view {
        (uint256 err, , uint256 shortfall) = COMPTROLLER.getBorrowingPower(user);
        if (err != 0 || shortfall > 0) revert LeverageCausesLiquidation();
    }

    /**
     * @notice Ensures the `user` has entered the destination market before operations.
     * @dev If `user` is already a member of `marketFrom` and not of `marketTo`,
     *      this function calls Comptroller to enter `marketTo` on behalf of `user`.
     * @param user The account for which membership is validated/updated.
     * @param marketFrom The current vToken market the user participates in.
     * @param marketTo The target vToken market the user must enter.
     * @custom:error EnterMarketFailed When Comptroller.enterMarketBehalf returns a non-zero error code
     */
    function _validateAndEnterMarket(address user, IVToken marketFrom, IVToken marketTo) internal {
        if (COMPTROLLER.checkMembership(user, marketFrom) && !COMPTROLLER.checkMembership(user, marketTo)) {
            uint256 err = COMPTROLLER.enterMarketBehalf(user, address(marketTo));
            if (err != 0) revert EnterMarketFailed(err);
        }
    }

    /**
     * @dev Ensures that the given market is listed in the Comptroller.
     * @param market The vToken address to validate.
     * @custom:error MarketNotListed If the market is not listed in Comptroller
     */
    function _checkMarketListed(IVToken market) internal view {
        (bool isMarketListed, , ) = COMPTROLLER.markets(address(market));
        if (!isMarketListed) revert MarketNotListed(address(market));
    }
}
