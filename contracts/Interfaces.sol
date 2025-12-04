// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.25;

import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { ResilientOracleInterface } from "@venusprotocol/oracle/contracts/interfaces/OracleInterface.sol";

interface IVToken is IERC20Upgradeable {
    function accrueInterest() external returns (uint256);

    function redeem(uint256 redeemTokens) external returns (uint256);

    function redeemUnderlying(uint256 redeemAmount) external returns (uint256);

    function borrowBalanceCurrent(address borrower) external returns (uint256);

    function balanceOfUnderlying(address owner) external returns (uint256);

    function seize(address liquidator, address borrower, uint seizeTokens) external returns (uint);

    function mintBehalf(address receiver, uint mintAmount) external returns (uint);

    function borrowBehalf(address borrower, uint borrowAmount) external returns (uint256);

    function repayBorrowBehalf(address borrower, uint repayAmount) external returns (uint256);

    function redeemUnderlyingBehalf(address redeemer, uint redeemAmount) external returns (uint);

    function comptroller() external view returns (IComptroller);

    function borrowBalanceStored(address account) external view returns (uint256);

    function underlying() external view returns (address);
}

interface IVBNB is IVToken {
    function repayBorrowBehalf(address borrower) external payable;

    function liquidateBorrow(address borrower, IVToken vTokenCollateral) external payable;
}

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

    function _setActionsPaused(address[] calldata markets_, Action[] calldata actions_, bool paused_) external;

    function enterMarkets(address[] calldata vTokens) external returns (uint256[] memory);

    function enterMarketBehalf(address onBehalf, address vToken) external returns (uint256);

    function enterMarket(address user, address vToken) external returns (uint256);

    function liquidationIncentiveMantissa() external view returns (uint256);

    function vaiController() external view returns (address);

    function liquidatorContract() external view returns (address);

    function oracle() external view returns (ResilientOracleInterface);

    function actionPaused(address market, Action action) external view returns (bool);

    function markets(address) external view returns (bool, uint256, bool);

    function isForcedLiquidationEnabled(address) external view returns (bool);

    function approvedDelegates(address borrower, address delegate) external view returns (bool);

    function getAccountLiquidity(address account) external view returns (uint256, uint256, uint256);

    function checkMembership(address account, IVToken vToken) external view returns (bool);

    function getBorrowingPower(
        address account
    ) external view returns (uint256 error, uint256 liquidity, uint256 shortfall);

    function treasuryPercent() external view returns (uint256);

    function executeFlashLoan(
        address payable onBehalf,
        address payable receiver,
        IVToken[] memory vTokens,
        uint256[] memory underlyingAmounts,
        bytes memory param
    ) external;
}

interface IFlashLoanReceiver {
    /**
     * @notice Executes an operation after receiving the flash-borrowed assets.
     * @dev Implementation of this function must ensure at least the premium (fee) is repaid within the same transaction.
     *      Any unpaid balance (principal + premium - repaid amount) will be added to the onBehalf address's borrow balance.
     * @param vTokens The vToken contracts corresponding to the flash-borrowed underlying assets.
     * @param amounts The amounts of each underlying asset that were flash-borrowed.
     * @param premiums The premiums (fees) associated with each flash-borrowed asset.
     * @param initiator The address that initiated the flash loan.
     * @param onBehalf The address of the user whose debt position will be used for any unpaid flash loan balance.
     * @param param Additional parameters encoded as bytes. These can be used to pass custom data to the receiver contract.
     * @return success True if the operation succeeds (regardless of repayment amount), false if the operation fails.
     * @return repayAmounts Array of uint256 representing the amounts to be repaid for each asset. The receiver contract
     *         must approve these amounts to the respective vToken contracts before this function returns.
     */
    function executeOperation(
        IVToken[] calldata vTokens,
        uint256[] calldata amounts,
        uint256[] calldata premiums,
        address initiator,
        address onBehalf,
        bytes calldata param
    ) external returns (bool success, uint256[] memory repayAmounts);
}

interface IWBNB is IERC20Upgradeable {
    function deposit() external payable;

    function withdraw(uint256 amount) external;
}

interface IProtocolShareReserve {
    enum IncomeType {
        SPREAD,
        LIQUIDATION,
        ERC4626_WRAPPER_REWARDS,
        FLASHLOAN
    }

    function updateAssetsState(address comptroller, address asset, IncomeType incomeType) external;
}
