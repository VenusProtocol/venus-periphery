// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

// solhint-disable func-name-mixedcase, ordering, import-path-check

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { CollateralGateway } from "../../../contracts/CollateralGateway/CollateralGateway.sol";
import { ICollateralGateway } from "../../../contracts/CollateralGateway/ICollateralGateway.sol";

interface IComptrollerLike {
    function enterMarkets(address[] calldata vTokens) external returns (uint256[] memory);

    function updateDelegate(address delegate, bool approved) external;

    function checkMembership(address account, address vToken) external view returns (bool);

    function getAccountLiquidity(address account) external view returns (uint256, uint256, uint256);

    function authorizedFlashLoan(address account) external view returns (bool);

    function markets(address vToken) external view returns (bool, uint256, bool);
}

interface ISpokeComptrollerLike {
    function checkMembership(address account, address vToken) external view returns (bool);

    function poolRegistry() external view returns (address);
}

interface IVBep20Like {
    function mint(uint256 mintAmount) external returns (uint256);

    function borrow(uint256 borrowAmount) external returns (uint256);

    function balanceOf(address account) external view returns (uint256);

    function underlying() external view returns (address);
}

interface IHubLike {
    function previewRedeem(uint256 shares) external view returns (uint256 assets);

    function balanceOf(address account) external view returns (uint256);

    function maxWithdrawalSize() external view returns (uint256);
}

interface IAccessControlManagerLike {
    function hasRole(bytes32 role, address account) external view returns (bool);
}

/**
 * @title Fork_CollateralGatewayTestnet
 * @notice Every entry point of the gateway deployed on BNB Chain testnet, run against the live
 *         contracts it was deployed for: the Core Comptroller with `enterMarketForAccount` cut in,
 *         the Hub_USDT vault and its vh market, and the hub-funded Spoke pool.
 * @dev Runs against the deployed gateway rather than a fresh one, so the Access Control Manager
 *      grants and the flash-loan allow list are the real ones. A source change that is not
 *      redeployed is therefore not covered here; the unit tests cover the source.
 *
 *      Decimals differ per contract on this network: USDT and USDC have 6, the Hub share token has
 *      12, and the vToken markets have 8. Amounts are read back from the contracts wherever the
 *      assertion allows it.
 */
contract Fork_CollateralGatewayTestnetTest is Test {
    address internal constant GATEWAY = 0xbB3304B6a1eB1d48E1d2EE78eadDadD4024DF358;
    address internal constant COMPTROLLER = 0x94d1820b2D1c7c7452A163983Dc888CEC546b77D;
    address internal constant ACM = 0x45f8a08F534f34A97187626E05d4b6648Eeaa9AA;

    address internal constant USDT = 0xA11c8D9DC9b66E209Ef60F0C8D969D3CD988782c;
    address internal constant VUSDT = 0xb7526572FFE56AB9D7489838Bf2E18e3323b441A;
    address internal constant HUB_USDT = 0x7cE6ADF754D0eC81A6CF8ACd9C7454F45077dc61;
    address internal constant VH_MARKET = 0xb846eEbaC8b014296709dc660Bfcb6ea182718e8;

    address internal constant SPOKE_COMPTROLLER = 0x11960c84d6c4F2a978a12372721C3A6A88C78f4c;
    address internal constant SPOKE_POOL_REGISTRY = 0xeAA45288d804971e5a76f33559e629F5b2b1Cb8B;
    address internal constant SPOKE_VUSDC = 0xD05514217FD359659aE7da7740e79C11947eBB32;
    address internal constant SPOKE_VUSDT = 0xC88bAF0bA49a98F15A00182752f6d10bd3932F6a;
    address internal constant USDC = 0x16227D60f7a0e586C66B005219dfc887D13C9531;

    address internal constant TIMELOCK = 0xce10739590001705F7FF231611ba4A48B2820327;

    /// @dev `SpokeComptroller.SupplyNotAllowed(address vToken, address supplier)`.
    bytes4 internal constant SUPPLY_NOT_ALLOWED = 0xb75eecd4;

    uint256 internal constant FORK_BLOCK = 133_626_000;
    uint256 internal constant SUPPLY = 1000e6;

    CollateralGateway internal gateway = CollateralGateway(GATEWAY);
    address internal user = makeAddr("user");
    bool internal forkLive;

    /// @dev The Hub caps one withdrawal in asset units, so a leg is sized off that cap rather than
    ///      off {SUPPLY}. Both legs of a two-leg withdraw have to fit in one cap together.
    uint256 internal legSize;

    function setUp() public {
        string memory rpc = vm.envOr("ARCHIVE_NODE_bsctestnet", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc, FORK_BLOCK);
        forkLive = true;

        deal(USDT, user, 10 * SUPPLY);
        deal(USDC, user, SUPPLY);

        vm.startPrank(user);
        IERC20(USDT).approve(GATEWAY, type(uint256).max);
        IERC20(USDC).approve(GATEWAY, type(uint256).max);
        IERC20(HUB_USDT).approve(GATEWAY, type(uint256).max);
        IComptrollerLike(COMPTROLLER).updateDelegate(GATEWAY, true);
        vm.stopPrank();

        legSize = IHubLike(HUB_USDT).maxWithdrawalSize() / 4;
        require(legSize > 0, "hub withdrawals capped at zero");
    }

    modifier onlyFork() {
        if (!forkLive) {
            vm.skip(true);
        }
        _;
    }

    // ------------------------------------------------------------- deployment

    /// @dev The immutables and the grants the VIP made are what the rest of this file relies on.
    function test_deployment_isWiredToTheLiveContracts() public onlyFork {
        assertEq(address(gateway.COMPTROLLER()), COMPTROLLER, "Core Comptroller");
        assertEq(address(gateway.POOL_REGISTRY()), SPOKE_POOL_REGISTRY, "Spoke pool registry");
        assertEq(gateway.owner(), TIMELOCK, "owner is the Normal Timelock");

        assertEq(
            ISpokeComptrollerLike(SPOKE_COMPTROLLER).poolRegistry(),
            SPOKE_POOL_REGISTRY,
            "the Spoke pool points back at the same registry"
        );
        assertTrue(IComptrollerLike(COMPTROLLER).authorizedFlashLoan(GATEWAY), "flash-loan allow list");
        assertTrue(_hasEnterRole(COMPTROLLER), "Core enterMarketForAccount role");
        assertTrue(_hasEnterRole(SPOKE_COMPTROLLER), "Spoke enterMarketForAccount role");
    }

    // ---------------------------------------------------------------- Core supply

    function test_supplyFromWallet_mintsAndEntersTheVhMarket() public onlyFork {
        vm.prank(user);
        uint256 shares = gateway.supplyFromWallet(SUPPLY, VH_MARKET, 0);

        assertGt(shares, 0, "hub shares minted");
        assertGt(IVBep20Like(VH_MARKET).balanceOf(user), 0, "receipts credited to the user");
        assertTrue(IComptrollerLike(COMPTROLLER).checkMembership(user, VH_MARKET), "market entered for the user");
        assertEq(IERC20(USDT).balanceOf(GATEWAY), 0, "gateway holds no underlying");
        assertEq(IERC20(HUB_USDT).balanceOf(GATEWAY), 0, "gateway holds no shares");
    }

    function test_supplyFromWallet_revertsBelowMinShares() public onlyFork {
        vm.prank(user);
        vm.expectPartialRevert(ICollateralGateway.InsufficientShares.selector);
        gateway.supplyFromWallet(SUPPLY, VH_MARKET, type(uint256).max / 2);
    }

    function testRevert_supplyFromWallet_marketNotListed() public onlyFork {
        address notAMarket = makeAddr("notAMarket");

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(ICollateralGateway.MarketNotListed.selector, notAMarket));
        gateway.supplyFromWallet(SUPPLY, notAMarket, 0);
    }

    // ----------------------------------------------------------- Core migration

    function test_supplyFromCollateral_movesAPositionWithNoBorrows() public onlyFork {
        uint256 held = _supplyToCore(SUPPLY);

        vm.prank(user);
        uint256 shares = gateway.supplyFromCollateral(VUSDT, held / 2, VH_MARKET, 0);

        assertGt(shares, 0, "hub shares minted");
        assertEq(IVBep20Like(VUSDT).balanceOf(user), held - held / 2, "half the source position left");
        assertTrue(IComptrollerLike(COMPTROLLER).checkMembership(user, VH_MARKET), "vh market entered");
        assertEq(IERC20(USDT).balanceOf(GATEWAY), 0, "gateway holds no underlying");
    }

    function test_supplyFromCollateral_maxMovesTheWholePosition() public onlyFork {
        assertGt(_supplyToCore(SUPPLY), 0, "source position supplied");

        vm.prank(user);
        gateway.supplyFromCollateral(VUSDT, type(uint256).max, VH_MARKET, 0);

        assertEq(IVBep20Like(VUSDT).balanceOf(user), 0, "every receipt migrated");
        assertGt(IVBep20Like(VH_MARKET).balanceOf(user), 0, "receipts in the vh market");
    }

    /// @dev The position cannot leave before its replacement exists, so this runs through the Core
    ///      flash loan the VIP allow-listed the gateway for.
    function test_supplyFromCollateral_whileBorrowingUsesTheFlashLoan() public onlyFork {
        uint256 held = _supplyToCore(SUPPLY);
        assertGt(held, 0, "source position supplied");

        vm.prank(user);
        require(IVBep20Like(VUSDT).borrow(SUPPLY / 2) == 0, "borrow failed");

        vm.prank(user);
        gateway.supplyFromCollateral(VUSDT, held, VH_MARKET, 0);

        assertEq(IVBep20Like(VUSDT).balanceOf(user), 0, "source position migrated");
        assertGt(IVBep20Like(VH_MARKET).balanceOf(user), 0, "replacement collateral held");
        (, , uint256 shortfall) = IComptrollerLike(COMPTROLLER).getAccountLiquidity(user);
        assertEq(shortfall, 0, "no shortfall left behind");
        assertEq(IERC20(USDT).balanceOf(GATEWAY), 0, "gateway holds no underlying");
    }

    // ---------------------------------------------------------------- withdraw

    function test_withdrawPosition_fromTheWalletOnly() public onlyFork {
        uint256 shares = _hubSharesInWallet(2 * legSize);
        uint256 balanceBefore = IERC20(USDT).balanceOf(user);

        vm.prank(user);
        uint256 assets = gateway.withdrawPosition(VH_MARKET, shares / 2, 0);

        assertGt(assets, 0, "underlying paid out");
        assertEq(IERC20(USDT).balanceOf(user), balanceBefore + assets, "the user was paid");
        assertEq(IHubLike(HUB_USDT).balanceOf(user), shares - shares / 2, "half the wallet shares left");
        assertTrue(IComptrollerLike(COMPTROLLER).checkMembership(user, VH_MARKET) == false, "Core untouched");
    }

    function test_withdrawPosition_spendsWalletThenTheMarket() public onlyFork {
        uint256 walletShares = _hubSharesInWallet(legSize);
        vm.prank(user);
        uint256 marketShares = gateway.supplyFromWallet(2 * legSize, VH_MARKET, 0);
        uint256 receiptsBefore = IVBep20Like(VH_MARKET).balanceOf(user);

        vm.prank(user);
        uint256 assets = gateway.withdrawPosition(VH_MARKET, walletShares + marketShares / 2, 0);

        assertGt(assets, 0, "underlying paid out");
        assertEq(IHubLike(HUB_USDT).balanceOf(user), 0, "wallet spent first");
        uint256 receiptsAfter = IVBep20Like(VH_MARKET).balanceOf(user);
        assertLt(receiptsAfter, receiptsBefore, "the market leg was freed too");
        assertGt(receiptsAfter, 0, "only part of the market position freed");
    }

    /// @dev `type(uint256).max` empties both legs, which overflowed before the cap moved ahead of
    ///      the conversion.
    function test_withdrawPosition_maxEmptiesBothLegs() public onlyFork {
        _hubSharesInWallet(legSize);
        vm.prank(user);
        gateway.supplyFromWallet(legSize, VH_MARKET, 0);

        vm.prank(user);
        uint256 assets = gateway.withdrawPosition(VH_MARKET, type(uint256).max, 0);

        assertGt(assets, 0, "underlying paid out");
        assertEq(IHubLike(HUB_USDT).balanceOf(user), 0, "wallet shares spent");
        assertEq(IVBep20Like(VH_MARKET).balanceOf(user), 0, "every receipt burned");
    }

    function testRevert_withdrawPosition_belowMinAssets() public onlyFork {
        uint256 shares = _hubSharesInWallet(legSize);
        uint256 payout = IHubLike(HUB_USDT).previewRedeem(shares);

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(ICollateralGateway.InsufficientAssets.selector, payout, payout + 1));
        gateway.withdrawPosition(VH_MARKET, shares, payout + 1);
    }

    // ------------------------------------------------------------ Spoke markets

    function test_supplyAndEnterSpokeMarkets_suppliesAndEnters() public onlyFork {
        address[] memory markets = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        markets[0] = SPOKE_VUSDC;
        amounts[0] = SUPPLY;

        vm.prank(user);
        gateway.supplyAndEnterSpokeMarkets(markets, amounts);

        assertGt(IVBep20Like(SPOKE_VUSDC).balanceOf(user), 0, "receipts credited to the user");
        assertTrue(
            ISpokeComptrollerLike(SPOKE_COMPTROLLER).checkMembership(user, SPOKE_VUSDC),
            "Spoke market entered for the user"
        );
        assertEq(IERC20(USDC).balanceOf(GATEWAY), 0, "gateway holds no underlying");
    }

    function test_enterSpokeMarkets_entersAMarketAlreadyHeld() public onlyFork {
        address[] memory markets = new address[](1);
        markets[0] = SPOKE_VUSDC;

        vm.prank(user);
        gateway.enterSpokeMarkets(markets);

        assertTrue(ISpokeComptrollerLike(SPOKE_COMPTROLLER).checkMembership(user, SPOKE_VUSDC), "market entered");
    }

    /// @dev The registry check runs before anything is pulled, so a market no Spoke pool registered
    ///      cannot reach the caller's tokens.
    function testRevert_spokeMarketNotRegistered() public onlyFork {
        address[] memory markets = new address[](1);
        markets[0] = VUSDT;

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(ICollateralGateway.MarketNotRegistered.selector, VUSDT));
        gateway.enterSpokeMarkets(markets);
    }

    /// @dev The Spoke pool meters the account credited with the receipts, so its supply allowlist
    ///      stops the gateway as it would stop a direct supply.
    function testRevert_supplyAndEnterSpokeMarkets_supplyAllowlist() public onlyFork {
        address[] memory markets = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        markets[0] = SPOKE_VUSDT;
        amounts[0] = SUPPLY;

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(SUPPLY_NOT_ALLOWED, SPOKE_VUSDT, user));
        gateway.supplyAndEnterSpokeMarkets(markets, amounts);
    }

    // -------------------------------------------------------------- helpers

    /// @dev Supply `amount` of USDT into vUSDT for the user, with the market entered. Returns the
    ///      receipts held.
    function _supplyToCore(uint256 amount) private returns (uint256) {
        vm.startPrank(user);
        IERC20(USDT).approve(VUSDT, amount);
        require(IVBep20Like(VUSDT).mint(amount) == 0, "core mint failed");

        address[] memory markets = new address[](1);
        markets[0] = VUSDT;
        IComptrollerLike(COMPTROLLER).enterMarkets(markets);
        vm.stopPrank();

        return IVBep20Like(VUSDT).balanceOf(user);
    }

    /// @dev Deposit `amount` of USDT into the Hub, leaving the shares in the user's wallet.
    ///      Returns the shares minted.
    function _hubSharesInWallet(uint256 amount) private returns (uint256) {
        vm.startPrank(user);
        IERC20(USDT).approve(HUB_USDT, amount);
        (bool ok, ) = HUB_USDT.call(abi.encodeWithSignature("deposit(uint256,address)", amount, user));
        require(ok, "hub deposit failed");
        vm.stopPrank();

        return IHubLike(HUB_USDT).balanceOf(user);
    }

    function _hasEnterRole(address target) private view returns (bool) {
        bytes32 role = keccak256(abi.encodePacked(target, "enterMarketForAccount(address,address)"));
        return IAccessControlManagerLike(ACM).hasRole(role, GATEWAY);
    }
}
