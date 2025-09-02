// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.25;

import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { SafeERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import { ResilientOracleInterface } from "@venusprotocol/oracle/contracts/interfaces/OracleInterface.sol";

import { IVToken, ILiquidator, IResilientOracle, IComptroller } from "./Interfaces.sol";

contract Liquidator_2025_09_02 {
    using SafeERC20Upgradeable for IERC20Upgradeable;

    uint256 constant MAX_ROUNDS = 20;
    uint256 constant MIN_REPAYMENT_AMOUNT = 1e12;

    address constant GUARDIAN = 0x3a3284dC0FaFfb0b5F0d074c4C704D14326C98cF;
    address constant RECEIVER = 0xC753FB97Ed8E1c6081699570b57115D28F2232FA;

    IVToken constant VUSDC = IVToken(0xecA88125a5ADbe82614ffC12D0DB554E2e2867C8);
    IVToken constant VUSDT = IVToken(0xfD5840Cd36d94D7229439859C0112a4185BC0255);
    IVToken constant VBTC = IVToken(0x882C173bC7Ff3b7786CA16dfeD3DFFfb9Ee7847B);
    IVToken constant VWBETH = IVToken(0x6CFdEc747f37DAf3b87a35a1D9c8AD3063A1A8A0);
    IVToken constant VFDUSD = IVToken(0xC4eF4229FEc74Ccfe17B2bdeF7715fAC740BA0ba);

    address constant EXPLOITER = 0x7fd8F825E905c771285F510D8e428A2b69A6202a;
    ILiquidator constant LIQUIDATOR = ILiquidator(0x0870793286aaDA55D39CE7f82fb2766e8004cF43);
    IResilientOracle constant ORACLE = IResilientOracle(0x6592b5DE802159F3E74B2486b091D11a8256ab8A);
    IComptroller constant COMPTROLLER = IComptroller(0xfD36E2c2a6789Db23113685031d7F16329158384);
    IERC20Upgradeable constant BTCB = IERC20Upgradeable(0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c);

    mapping(IVToken => uint256) prices;

    error Unauthorized();
    error TransferFailed();

    modifier onlyGuardian() {
        if (msg.sender != GUARDIAN) {
            revert Unauthorized();
        }
        _;
    }

    function runLiquidation() external onlyGuardian {
        BTCB.forceApprove(address(LIQUIDATOR), 0);
        BTCB.forceApprove(address(LIQUIDATOR), type(uint256).max);

        _fetchPrices();

        _liquidate(VUSDC);
        _liquidate(VUSDT);
        _liquidate(VWBETH);
        _liquidate(VFDUSD);

        _transferCollateral();
    }

    function borrowOnBehalfAndRepay() external onlyGuardian {
        _fetchPrice(VBTC);
        (, , uint256 shortfall) = COMPTROLLER.getAccountLiquidity(EXPLOITER);
        uint256 exploiterShortfallBtc = (shortfall * 1e18) / prices[VBTC];
        VBTC.borrowBehalf(RECEIVER, exploiterShortfallBtc);
        BTCB.forceApprove(address(VBTC), 0);
        BTCB.forceApprove(address(VBTC), type(uint256).max);
        VBTC.repayBorrowBehalf(EXPLOITER, exploiterShortfallBtc);
    }

    function _fetchPrices() internal {
        _fetchPrice(VUSDC);
        _fetchPrice(VUSDT);
        _fetchPrice(VWBETH);
        _fetchPrice(VFDUSD);
        _fetchPrice(VBTC);
    }

    function _fetchPrice(IVToken vToken) internal {
        ORACLE.updatePrice(address(vToken));
        prices[vToken] = ORACLE.getUnderlyingPrice(address(vToken));
    }

    function _liquidate(IVToken vTokenCollateral) internal {
        for (uint256 i; i < MAX_ROUNDS; ++i) {
            uint256 repayAmountBtc = _computeRepayAmount(vTokenCollateral);
            if (repayAmountBtc < MIN_REPAYMENT_AMOUNT) {
                break;
            }
            LIQUIDATOR.liquidateBorrow(address(VBTC), EXPLOITER, repayAmountBtc, vTokenCollateral);
        }
    }

    function _computeRepayAmount(IVToken vTokenCollateral) internal returns (uint256) {
        uint256 vTokenBalance = vTokenCollateral.balanceOf(EXPLOITER);
        uint256 exchangeRate = vTokenCollateral.exchangeRateCurrent();
        uint256 collateralPrice = prices[vTokenCollateral];
        uint256 btcPrice = prices[VBTC];
        uint256 liquidationIncentive = 1.1e18;

        uint256 vTokensToSeize = vTokenBalance / 2; // adjust for the close factor
        uint256 underlyingToSeize = (vTokensToSeize * exchangeRate) / 1e18;
        uint256 usdToSeize = (underlyingToSeize * collateralPrice) / 1e18;
        uint256 usdToRepay = (usdToSeize * 1e18) / liquidationIncentive;
        return (usdToRepay * 1e18) / btcPrice;
    }

    function _transferCollateral() internal {
        _transferAll(VUSDC);
        _transferAll(VUSDT);
        _transferAll(VWBETH);
        _transferAll(VFDUSD);
    }

    function _transferAll(IVToken vToken) internal {
        uint256 balance = vToken.balanceOf(address(this));
        bool success = vToken.transfer(RECEIVER, balance);
        if (!success) {
            revert TransferFailed();
        }
    }
}
