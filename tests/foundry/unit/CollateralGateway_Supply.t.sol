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

/// @notice Records membership and refuses callers without the role, standing in for the Access
///         Control Manager check in `MarketFacet.enterMarketForAccount`.
contract MockCoreComptroller {
    mapping(address => bool) public allowed;
    mapping(address => mapping(address => bool)) public entered;
    mapping(address => bool) public listed;
    uint256 public enterErrorCode;

    function allow(address caller) external {
        allowed[caller] = true;
    }

    function setEnterErrorCode(uint256 code) external {
        enterErrorCode = code;
    }

    function enterMarketForAccount(address account, address vToken) external returns (uint256) {
        if (!allowed[msg.sender]) return 1;
        if (enterErrorCode != 0) return enterErrorCode;

        entered[account][vToken] = true;
        return 0;
    }

    function list(address vToken) external {
        listed[vToken] = true;
    }

    function markets(address vToken) external view returns (bool, uint256, bool) {
        return (listed[vToken], 0, false);
    }
}

/// @notice Hub share token and vault in one. One share per asset, across the 18-to-24 decimal shift.
contract MockHubVault is ERC20 {
    address public immutable asset;

    constructor(address asset_) ERC20("Hub USDT", "vhUSDT") {
        asset = asset_;
    }

    function decimals() public pure override returns (uint8) {
        return 24;
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        IERC20(asset).transferFrom(msg.sender, address(this), assets);

        shares = assets * 1e6;
        _mint(receiver, shares);
    }
}

/// @notice Core market wrapping the Hub share token.
contract MockVhMarket {
    address public immutable underlying;
    address public immutable comptroller;

    mapping(address => uint256) public balanceOf;

    constructor(address underlying_, address comptroller_) {
        underlying = underlying_;
        comptroller = comptroller_;
    }

    function mintBehalf(address minter, uint256 mintAmount) external returns (uint256) {
        IERC20(underlying).transferFrom(msg.sender, address(this), mintAmount);
        balanceOf[minter] += mintAmount / 1e16; // 24-decimal shares to 8-decimal receipts

        return 0;
    }
}

contract CollateralGateway_SupplyTest is Test {
    CollateralGateway internal gateway;
    MockERC20 internal usdt;
    MockHubVault internal hub;
    MockVhMarket internal market;
    MockCoreComptroller internal comptroller;

    address internal user = address(0xBEEF);
    address internal owner = makeAddr("owner");

    function setUp() public {
        comptroller = new MockCoreComptroller();
        gateway = new CollateralGateway(IComptroller(address(comptroller)), owner);
        usdt = new MockERC20("Tether", "USDT", 18);
        hub = new MockHubVault(address(usdt));
        market = new MockVhMarket(address(hub), address(comptroller));

        comptroller.allow(address(gateway));
        comptroller.list(address(market));

        usdt.mint(user, 1000e18);
        vm.prank(user);
        usdt.approve(address(gateway), type(uint256).max);
    }

    function test_supplyFromWallet_entersTheMarketForTheSupplier() public {
        vm.prank(user);
        gateway.supplyFromWallet(100e18, address(market), 0);

        assertGt(market.balanceOf(user), 0, "receipts credited to the supplier");
        assertTrue(comptroller.entered(user, address(market)), "supplier entered");
        assertFalse(comptroller.entered(address(gateway), address(market)), "gateway did not enter itself");
    }

    function test_supplyFromWallet_leavesNothingInTheGateway() public {
        vm.prank(user);
        gateway.supplyFromWallet(100e18, address(market), 0);

        assertEq(usdt.balanceOf(address(gateway)), 0, "no underlying held");
        assertEq(hub.balanceOf(address(gateway)), 0, "no shares held");
    }

    /// @dev The role is granted to the gateway by governance, so without it nothing should move.
    function testRevert_supplyFromWallet_withoutTheRole() public {
        MockCoreComptroller ungranted = new MockCoreComptroller();
        CollateralGateway closedGateway = new CollateralGateway(IComptroller(address(ungranted)), owner);
        MockVhMarket closedMarket = new MockVhMarket(address(hub), address(ungranted));
        ungranted.list(address(closedMarket));

        vm.prank(user);
        usdt.approve(address(closedGateway), type(uint256).max);

        vm.expectRevert(
            abi.encodeWithSelector(ICollateralGateway.EnterMarketFailed.selector, address(closedMarket), 1)
        );
        vm.prank(user);
        closedGateway.supplyFromWallet(100e18, address(closedMarket), 0);

        assertEq(usdt.balanceOf(user), 1000e18, "the whole call reverted, so nothing was pulled");
    }

    // ------------------------------------------------------------------ sweep

    function test_sweepToken_sendsTheWholeBalanceToTheOwner() public {
        usdt.mint(address(gateway), 5e18);

        vm.expectEmit(true, true, false, true, address(gateway));
        emit ICollateralGateway.TokenSwept(address(usdt), owner, 5e18);
        vm.prank(owner);
        gateway.sweepToken(IERC20(address(usdt)));

        assertEq(usdt.balanceOf(owner), 5e18, "owner received the stray balance");
        assertEq(usdt.balanceOf(address(gateway)), 0, "nothing left in the gateway");
    }

    function testRevert_sweepToken_fromANonOwner() public {
        usdt.mint(address(gateway), 5e18);

        vm.expectRevert("Ownable: caller is not the owner");
        vm.prank(user);
        gateway.sweepToken(IERC20(address(usdt)));
    }

    function testRevert_sweepToken_withNothingToSweep() public {
        vm.expectRevert(ICollateralGateway.ZeroAmount.selector);
        vm.prank(owner);
        gateway.sweepToken(IERC20(address(usdt)));
    }

    /// @dev An unlisted market is the caller's own address, and with it the hub and the asset the
    ///      rest of the call is validated against.
    function testRevert_supplyFromWallet_whenTheMarketIsNotListed() public {
        MockVhMarket rogue = new MockVhMarket(address(hub), address(comptroller));

        vm.expectRevert(abi.encodeWithSelector(ICollateralGateway.MarketNotListed.selector, address(rogue)));
        vm.prank(user);
        gateway.supplyFromWallet(100e18, address(rogue), 0);
    }

    function testRevert_supplyFromWallet_whenTheMarketRefusesTheEntry() public {
        comptroller.setEnterErrorCode(9);

        vm.expectRevert(abi.encodeWithSelector(ICollateralGateway.EnterMarketFailed.selector, address(market), 9));
        vm.prank(user);
        gateway.supplyFromWallet(100e18, address(market), 0);
    }
}
