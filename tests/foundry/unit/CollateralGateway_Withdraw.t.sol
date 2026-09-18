// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

// solhint-disable func-name-mixedcase, ordering, import-path-check, no-empty-blocks, gas-custom-errors

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import { IComptroller } from "../../../contracts/Interfaces/IComptroller.sol";
import { CollateralGateway } from "../../../contracts/CollateralGateway/CollateralGateway.sol";
import { ICollateralGateway } from "../../../contracts/CollateralGateway/ICollateralGateway.sol";
import { MockERC20 } from "./mocks/MockERC20.sol";

/// @notice Hub share token and vault in one. One share is worth one asset, across the 24-to-18
///         decimal shift.
contract MockHubVault is ERC20 {
    address public immutable asset;

    constructor(address asset_) ERC20("Hub USDT", "vhUSDT") {
        asset = asset_;
    }

    function decimals() public pure override returns (uint8) {
        return 24;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets) {
        _burn(owner, shares);

        assets = shares / 1e6; // 24-decimal shares to an 18-decimal asset
        MockERC20(asset).mint(receiver, assets);
    }
}

/// @notice Core market over the Hub share token. `redeemBehalf` burns the redeemer's receipts and
///         sends the freed shares to the caller, as `VBep20` does.
contract MockVhMarket {
    error NotAnApprovedDelegate();

    address public immutable underlying;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => bool)) public approvedDelegates;
    uint256 public exchangeRate = 2e34;
    uint256 public redeemFeeBps;

    constructor(address underlying_) {
        underlying = underlying_;
    }

    function setExchangeRate(uint256 rate) external {
        exchangeRate = rate;
    }

    function setRedeemFeeBps(uint256 bps) external {
        redeemFeeBps = bps;
    }

    function updateDelegate(address delegate, bool approved) external {
        approvedDelegates[msg.sender][delegate] = approved;
    }

    function mintTo(address account, uint256 vTokens) external {
        balanceOf[account] += vTokens;
    }

    function exchangeRateCurrent() external view returns (uint256) {
        return exchangeRate;
    }

    function redeemBehalf(address redeemer, uint256 redeemTokens) external returns (uint256) {
        if (!approvedDelegates[redeemer][msg.sender]) revert NotAnApprovedDelegate();

        balanceOf[redeemer] -= redeemTokens;

        uint256 shares = (redeemTokens * exchangeRate) / 1e18;
        shares -= (shares * redeemFeeBps) / 10_000;
        IERC20(underlying).transfer(msg.sender, shares);
        return 0;
    }
}

contract CollateralGateway_WithdrawTest is Test {
    CollateralGateway internal gateway;
    MockERC20 internal usdt;
    MockHubVault internal hub;
    MockVhMarket internal market;

    address internal user = address(0xBEEF);

    /// @dev 1 vToken frees `exchangeRate / 1e18` shares, so 50 vTokens back 100 shares.
    uint256 internal constant WALLET_SHARES = 40e24;
    uint256 internal constant MARKET_VTOKENS = 50e8;
    uint256 internal constant MARKET_SHARES = 100e24;

    function setUp() public {
        gateway = new CollateralGateway(IComptroller(makeAddr("comptroller")));
        usdt = new MockERC20("Tether", "USDT", 18);
        hub = new MockHubVault(address(usdt));
        market = new MockVhMarket(address(hub));

        hub.mint(user, WALLET_SHARES);
        hub.mint(address(market), MARKET_SHARES);
        market.mintTo(user, MARKET_VTOKENS);

        vm.startPrank(user);
        hub.approve(address(gateway), type(uint256).max);
        market.updateDelegate(address(gateway), true);
        vm.stopPrank();
    }

    function test_withdrawPosition_walletCoversItLeavesCoreUntouched() public {
        uint256 shares = 30e24;

        vm.expectEmit(true, true, true, true, address(gateway));
        emit ICollateralGateway.PositionWithdrawn(user, address(hub), address(market), shares, 0, shares / 1e6);

        vm.prank(user);
        uint256 assets = gateway.withdrawPosition(address(hub), address(market), shares, 0);

        assertEq(assets, 30e18, "paid out at the vault rate");
        assertEq(usdt.balanceOf(user), 30e18, "user paid");
        assertEq(market.balanceOf(user), MARKET_VTOKENS, "Core position untouched");
        assertEq(hub.balanceOf(user), WALLET_SHARES - shares, "only the wallet leg spent");
    }

    function test_withdrawPosition_walletCoversItWithoutADelegateGrant() public {
        vm.prank(user);
        market.updateDelegate(address(gateway), false);

        vm.prank(user);
        uint256 assets = gateway.withdrawPosition(address(hub), address(market), 30e24, 0);

        assertEq(assets, 30e18, "the Core leg was never reached");
    }

    function test_withdrawPosition_spendsWalletFirstThenCore() public {
        uint256 shares = WALLET_SHARES + 60e24;

        vm.prank(user);
        uint256 assets = gateway.withdrawPosition(address(hub), address(market), shares, 0);

        assertEq(assets, shares / 1e6, "both legs paid out");
        assertEq(hub.balanceOf(user), 0, "wallet spent first");
        assertEq(market.balanceOf(user), MARKET_VTOKENS - 30e8, "only the shortfall freed from Core");
    }

    function test_withdrawPosition_coreOnlyWhenTheWalletIsEmpty() public {
        vm.prank(user);
        hub.transfer(address(0xDEAD), WALLET_SHARES);

        vm.prank(user);
        uint256 assets = gateway.withdrawPosition(address(hub), address(market), 20e24, 0);

        assertEq(assets, 20e18, "paid entirely out of Core");
        assertEq(market.balanceOf(user), MARKET_VTOKENS - 10e8, "receipts burned for the freed shares");
    }

    function test_withdrawPosition_roundsTheReceiptCountUp() public {
        vm.prank(user);
        hub.transfer(address(0xDEAD), WALLET_SHARES);

        // One wei of shares needs a fraction of a receipt, which has to round up to one.
        vm.prank(user);
        gateway.withdrawPosition(address(hub), address(market), 1, 0);

        assertEq(market.balanceOf(user), MARKET_VTOKENS - 1, "one receipt burned");
    }

    /// @dev Asking for more than the receipts back is what a "withdraw everything" does, because the
    ///      mint that created them rounded down. The market underflows if the gateway does not cap.
    function test_withdrawPosition_capsTheReceiptsAtWhatTheCallerHolds() public {
        vm.prank(user);
        hub.transfer(address(0xDEAD), WALLET_SHARES);

        vm.prank(user);
        uint256 assets = gateway.withdrawPosition(address(hub), address(market), MARKET_SHARES + 1, 0);

        assertEq(assets, MARKET_SHARES / 1e6, "paid out the whole position");
        assertEq(market.balanceOf(user), 0, "every receipt burned, and no more");
    }

    function test_withdrawPosition_leavesNothingInTheGateway() public {
        vm.prank(user);
        gateway.withdrawPosition(address(hub), address(market), WALLET_SHARES + 20e24, 0);

        assertEq(hub.balanceOf(address(gateway)), 0, "no shares held");
        assertEq(usdt.balanceOf(address(gateway)), 0, "no assets held");
    }

    function testRevert_withdrawPosition_belowMinAssets() public {
        vm.expectRevert(abi.encodeWithSelector(ICollateralGateway.InsufficientAssets.selector, 30e18, 31e18));
        vm.prank(user);
        gateway.withdrawPosition(address(hub), address(market), 30e24, 31e18);
    }

    function testRevert_withdrawPosition_marketRedeemFeeEatsIntoThePayout() public {
        market.setRedeemFeeBps(100); // 1%

        // The Core leg frees 1% less than asked, so the payout misses a floor set on the full amount.
        vm.expectRevert(abi.encodeWithSelector(ICollateralGateway.InsufficientAssets.selector, 99.4e18, 100e18));
        vm.prank(user);
        gateway.withdrawPosition(address(hub), address(market), WALLET_SHARES + 60e24, 100e18);
    }

    function testRevert_withdrawPosition_withoutADelegateGrant() public {
        vm.prank(user);
        market.updateDelegate(address(gateway), false);

        vm.expectRevert(MockVhMarket.NotAnApprovedDelegate.selector);
        vm.prank(user);
        gateway.withdrawPosition(address(hub), address(market), WALLET_SHARES + 20e24, 0);
    }

    function testRevert_withdrawPosition_marketDoesNotWrapTheHub() public {
        MockHubVault otherHub = new MockHubVault(address(usdt));

        vm.expectRevert(
            abi.encodeWithSelector(ICollateralGateway.MarketMismatch.selector, address(hub), address(otherHub))
        );
        vm.prank(user);
        gateway.withdrawPosition(address(otherHub), address(market), 1e24, 0);
    }

    function testRevert_withdrawPosition_zeroShares() public {
        vm.expectRevert(ICollateralGateway.ZeroAmount.selector);
        vm.prank(user);
        gateway.withdrawPosition(address(hub), address(market), 0, 0);
    }

    function testRevert_withdrawPosition_zeroAddress() public {
        vm.expectRevert(ICollateralGateway.ZeroAddress.selector);
        vm.prank(user);
        gateway.withdrawPosition(address(0), address(market), 1e24, 0);
    }
}
