// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.25;

// solhint-disable func-name-mixedcase, ordering, import-path-check, no-empty-blocks, gas-custom-errors

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import { IComptroller } from "../../../contracts/Interfaces/IComptroller.sol";
import { CollateralGateway } from "../../../contracts/CollateralGateway/CollateralGateway.sol";
import { ICollateralGateway } from "../../../contracts/CollateralGateway/ICollateralGateway.sol";
import { MockERC20 } from "./mocks/MockERC20.sol";

/// @notice Records membership and refuses callers that were not granted the role, standing in for
///         the Access Control Manager check in `SpokeComptroller.enterMarketBehalf`.
contract MockSpokeComptroller {
    error Unauthorized(address caller);

    mapping(address => bool) public allowed;
    mapping(address => mapping(address => bool)) public entered;

    function allow(address caller) external {
        allowed[caller] = true;
    }

    function enterMarketBehalf(address vToken, address account) external {
        if (!allowed[msg.sender]) revert Unauthorized(msg.sender);
        entered[account][vToken] = true;
    }
}

/// @notice Spoke market at a fixed 1:1 exchange rate. `mintBehalf` pulls from the caller and
///         credits the minter, as the isolated-pools `VToken` does.
contract MockSpokeVToken {
    address public immutable underlying;
    address public immutable comptroller;

    mapping(address => uint256) public balanceOf;
    bool public mintsNothing;

    constructor(address underlying_, address comptroller_) {
        underlying = underlying_;
        comptroller = comptroller_;
    }

    function setMintsNothing(bool value) external {
        mintsNothing = value;
    }

    /// @dev Credits what arrived rather than what was asked for, as `_mintFresh` does.
    function mintBehalf(address minter, uint256 mintAmount) external returns (uint256) {
        uint256 balanceBefore = IERC20(underlying).balanceOf(address(this));
        IERC20(underlying).transferFrom(msg.sender, address(this), mintAmount);
        uint256 received = IERC20(underlying).balanceOf(address(this)) - balanceBefore;

        if (!mintsNothing) balanceOf[minter] += received;
        return 0;
    }
}

/// @notice Burns 1% of every transfer, so the amount that reaches the market is smaller than the
///         amount the caller asked to supply.
contract FeeOnTransferERC20 is ERC20 {
    constructor() ERC20("Fee", "FEE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        uint256 fee = amount / 100;
        super._transfer(from, to, amount - fee);
        _burn(from, fee);
    }
}

contract CollateralGateway_SpokeTest is Test {
    CollateralGateway internal gateway;
    MockSpokeComptroller internal comptroller;
    MockERC20 internal underlying;
    MockSpokeVToken internal market;

    address internal user = address(0xBEEF);

    function setUp() public {
        comptroller = new MockSpokeComptroller();
        gateway = new CollateralGateway(IComptroller(address(comptroller)));
        comptroller.allow(address(gateway));

        underlying = new MockERC20("Collateral", "COL", 18);
        market = new MockSpokeVToken(address(underlying), address(comptroller));

        underlying.mint(user, 1000e18);
        vm.prank(user);
        underlying.approve(address(gateway), type(uint256).max);
    }

    function _single(address value) internal pure returns (address[] memory list) {
        list = new address[](1);
        list[0] = value;
    }

    function _single(uint256 value) internal pure returns (uint256[] memory list) {
        list = new uint256[](1);
        list[0] = value;
    }

    function test_supplyAndEnterSpokeMarkets_creditsSupplierAndEntersForThem() public {
        vm.expectEmit(true, true, false, true, address(gateway));
        emit ICollateralGateway.SuppliedToSpoke(user, address(market), 100e18, 100e18);

        vm.prank(user);
        gateway.supplyAndEnterSpokeMarkets(_single(address(market)), _single(uint256(100e18)));

        assertEq(market.balanceOf(user), 100e18, "receipts go to the supplier");
        assertEq(market.balanceOf(address(gateway)), 0, "gateway keeps none");
        assertTrue(comptroller.entered(user, address(market)), "supplier entered");
        assertFalse(comptroller.entered(address(gateway), address(market)), "gateway did not enter itself");
    }

    function test_supplyAndEnterSpokeMarkets_leavesNothingBehind() public {
        vm.prank(user);
        gateway.supplyAndEnterSpokeMarkets(_single(address(market)), _single(uint256(100e18)));

        assertEq(underlying.balanceOf(address(gateway)), 0, "no dust held");
        assertEq(underlying.allowance(address(gateway), address(market)), 0, "allowance spent");
        assertEq(underlying.balanceOf(user), 900e18, "only the requested amount left the user");
    }

    function test_supplyAndEnterSpokeMarkets_suppliesEveryMarketInOneCall() public {
        MockERC20 second = new MockERC20("Other", "OTH", 8);
        MockSpokeVToken secondMarket = new MockSpokeVToken(address(second), address(comptroller));
        second.mint(user, 50e8);
        vm.prank(user);
        second.approve(address(gateway), type(uint256).max);

        address[] memory markets = new address[](2);
        uint256[] memory amounts = new uint256[](2);
        markets[0] = address(market);
        markets[1] = address(secondMarket);
        amounts[0] = 10e18;
        amounts[1] = 5e8;

        vm.prank(user);
        gateway.supplyAndEnterSpokeMarkets(markets, amounts);

        assertTrue(comptroller.entered(user, address(market)), "first market entered");
        assertTrue(comptroller.entered(user, address(secondMarket)), "second market entered");
        assertEq(secondMarket.balanceOf(user), 5e8, "second market credited");
    }

    function test_supplyAndEnterSpokeMarkets_suppliesOnlyWhatReachedTheGateway() public {
        FeeOnTransferERC20 feeToken = new FeeOnTransferERC20();
        MockSpokeVToken feeMarket = new MockSpokeVToken(address(feeToken), address(comptroller));
        feeToken.mint(user, 100e18);
        vm.prank(user);
        feeToken.approve(address(gateway), type(uint256).max);

        vm.prank(user);
        gateway.supplyAndEnterSpokeMarkets(_single(address(feeMarket)), _single(uint256(100e18)));

        // 1% burned on the way in, then 1% of the rest burned on the way to the market.
        assertEq(feeMarket.balanceOf(user), 98.01e18, "credited what the market received");
        assertEq(feeToken.balanceOf(address(gateway)), 0, "no residue from the short transfer");
    }

    function testRevert_supplyAndEnterSpokeMarkets_withoutTheRole() public {
        MockSpokeComptroller ungranted = new MockSpokeComptroller();
        MockSpokeVToken closedMarket = new MockSpokeVToken(address(underlying), address(ungranted));

        vm.expectRevert(abi.encodeWithSelector(MockSpokeComptroller.Unauthorized.selector, address(gateway)));
        vm.prank(user);
        gateway.supplyAndEnterSpokeMarkets(_single(address(closedMarket)), _single(uint256(100e18)));

        assertEq(underlying.balanceOf(user), 1000e18, "the whole call reverted, so nothing was pulled");
    }

    function testRevert_supplyAndEnterSpokeMarkets_lengthMismatch() public {
        address[] memory markets = new address[](2);
        markets[0] = address(market);
        markets[1] = address(market);

        vm.expectRevert(ICollateralGateway.InvalidArrayLength.selector);
        vm.prank(user);
        gateway.supplyAndEnterSpokeMarkets(markets, _single(uint256(1e18)));
    }

    function testRevert_supplyAndEnterSpokeMarkets_emptyList() public {
        vm.expectRevert(ICollateralGateway.InvalidArrayLength.selector);
        vm.prank(user);
        gateway.supplyAndEnterSpokeMarkets(new address[](0), new uint256[](0));
    }

    function testRevert_supplyAndEnterSpokeMarkets_zeroAmount() public {
        vm.expectRevert(ICollateralGateway.ZeroAmount.selector);
        vm.prank(user);
        gateway.supplyAndEnterSpokeMarkets(_single(address(market)), _single(uint256(0)));
    }

    function testRevert_supplyAndEnterSpokeMarkets_zeroMarket() public {
        vm.expectRevert(ICollateralGateway.ZeroAddress.selector);
        vm.prank(user);
        gateway.supplyAndEnterSpokeMarkets(_single(address(0)), _single(uint256(1e18)));
    }

    function testRevert_supplyAndEnterSpokeMarkets_mintCreditsNothing() public {
        market.setMintsNothing(true);

        vm.expectRevert(ICollateralGateway.NothingMinted.selector);
        vm.prank(user);
        gateway.supplyAndEnterSpokeMarkets(_single(address(market)), _single(uint256(100e18)));
    }

    function test_enterSpokeMarkets_entersForTheCaller() public {
        vm.prank(user);
        gateway.enterSpokeMarkets(_single(address(market)));

        assertTrue(comptroller.entered(user, address(market)), "caller entered");
        assertEq(underlying.balanceOf(user), 1000e18, "nothing supplied");
    }

    function test_enterSpokeMarkets_repeatIsHarmless() public {
        vm.startPrank(user);
        gateway.enterSpokeMarkets(_single(address(market)));
        gateway.enterSpokeMarkets(_single(address(market)));
        vm.stopPrank();

        assertTrue(comptroller.entered(user, address(market)), "still entered");
    }

    function testRevert_enterSpokeMarkets_emptyList() public {
        vm.expectRevert(ICollateralGateway.InvalidArrayLength.selector);
        vm.prank(user);
        gateway.enterSpokeMarkets(new address[](0));
    }
}
