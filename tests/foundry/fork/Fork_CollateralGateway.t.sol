// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

// solhint-disable func-name-mixedcase, ordering, import-path-check

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { IComptroller } from "../../../contracts/Interfaces/IComptroller.sol";
import { CollateralGateway } from "../../../contracts/CollateralGateway/CollateralGateway.sol";
import { ICollateralGateway } from "../../../contracts/CollateralGateway/ICollateralGateway.sol";
import { IVToken } from "../../../contracts/Interfaces/IVToken.sol";

interface IComptrollerLike {
    function enterMarkets(address[] calldata vTokens) external returns (uint256[] memory);
    function checkMembership(address account, address vToken) external view returns (bool);
    function getAccountLiquidity(address account) external view returns (uint256, uint256, uint256);
    function supplyCaps(address vToken) external view returns (uint256);
    function setMarketSupplyCaps(address[] calldata vTokens, uint256[] calldata newSupplyCaps) external;
    function setWhiteListFlashLoanAccount(address account, bool isWhiteListed) external;
}

interface IVBep20Mint {
    function mint(uint256 mintAmount) external returns (uint256);
    function borrow(uint256 borrowAmount) external returns (uint256);
    function borrowBalanceCurrent(address account) external returns (uint256);
}

interface IDiamondLoupeLike {
    function facetAddress(bytes4 selector) external view returns (address);
}

interface IDiamondCutLike {
    struct FacetCut {
        address facetAddress;
        uint8 action;
        bytes4[] functionSelectors;
    }

    function diamondCut(FacetCut[] calldata cuts) external;
}

interface IAccessControlManagerLike {
    function giveCallPermission(address contractAddress, string calldata functionSig, address accountToPermit) external;
}

interface IDelegation {
    function updateDelegate(address delegate, bool approved) external;
}

interface IHubLike {
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    function previewRedeem(uint256 shares) external view returns (uint256 assets);
}

/**
 * @title Fork_CollateralGateway
 * @notice `supplyFromWallet` against the live BNB Chain deployment: the real Hub_USDT vault, the
 *         real vvhUSDT Core market, and the real Comptroller. Amounts are read back from the
 *         contracts, so assertions hold at any block.
 */
contract Fork_CollateralGatewayTest is Test {
    address internal constant COMPTROLLER = 0xfD36E2c2a6789Db23113685031d7F16329158384;
    address internal constant USDT = 0x55d398326f99059fF775485246999027B3197955;
    address internal constant VUSDT = 0xfD5840Cd36d94D7229439859C0112a4185BC0255;
    address internal constant HUB_USDT = 0x18AfDACF30F8671021dec4b78297E39d2FE87226;
    address internal constant VVHUSDT = 0xc0768948e668B7BacFf8b4BD1BaBe0eD2b512d3c;

    uint256 internal constant FORK_BLOCK = 121_990_000;
    uint256 internal constant SUPPLY = 1000e18;
    bytes4 internal constant ENTER_FOR_ACCOUNT = bytes4(keccak256("enterMarketForAccount(address,address)"));
    address internal constant COMPTROLLER_ADMIN = 0x939bD8d64c0A9583A7Dcea9933f7b21697ab6396;
    address internal constant ACM = 0x4788629ABc6cFCA10F9f969efdEAa1cF70c23555;

    CollateralGateway internal gateway;
    address internal user = makeAddr("user");
    address internal owner = makeAddr("owner");
    bool internal forkLive;

    function setUp() public {
        string memory rpc = vm.envOr("ARCHIVE_NODE_bscmainnet", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc, FORK_BLOCK);
        forkLive = true;

        gateway = new CollateralGateway(IComptroller(COMPTROLLER), owner);

        _cutInEnterMarketForAccount();

        deal(USDT, user, SUPPLY);
        vm.prank(user);
        IERC20(USDT).approve(address(gateway), type(uint256).max);
    }

    modifier onlyFork() {
        if (!forkLive) {
            vm.skip(true);
        }
        _;
    }

    /// @dev Cuts `enterMarketForAccount` into the live Comptroller and grants this gateway the role
    ///      for it, standing in for the upgrade and the VIP that will do both on chain.
    ///
    ///      The facet bytecode is built from VenusProtocol/venus-protocol#710 and lives in
    ///      `fixtures/MarketFacet.deployed.hex`. It has to be regenerated whenever that PR moves.
    function _cutInEnterMarketForAccount() private {
        if (IDiamondLoupeLike(COMPTROLLER).facetAddress(ENTER_FOR_ACCOUNT) != address(0)) return;

        address facet = makeAddr("patchedMarketFacet");
        vm.etch(facet, vm.parseBytes(vm.readFile("tests/foundry/fork/fixtures/MarketFacet.deployed.hex")));

        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = ENTER_FOR_ACCOUNT;
        IDiamondCutLike.FacetCut[] memory cuts = new IDiamondCutLike.FacetCut[](1);
        cuts[0] = IDiamondCutLike.FacetCut({ facetAddress: facet, action: 0, functionSelectors: selectors });

        vm.prank(COMPTROLLER_ADMIN);
        IDiamondCutLike(COMPTROLLER).diamondCut(cuts);

        vm.prank(COMPTROLLER_ADMIN);
        IAccessControlManagerLike(ACM).giveCallPermission(
            COMPTROLLER,
            "enterMarketForAccount(address,address)",
            address(gateway)
        );
    }

    // ---------------------------------------------------------------- happy path

    function test_supplyFromWallet_creditsMarketReceiptsToUser() public onlyFork {
        vm.prank(user);
        uint256 shares = gateway.supplyFromWallet(SUPPLY, VVHUSDT, 0);

        assertGt(shares, 0, "hub minted shares");
        assertEq(IERC20(USDT).balanceOf(user), 0, "underlying spent");
        assertGt(IVToken(VVHUSDT).balanceOf(user), 0, "user holds market receipts");
        assertEq(IERC20(HUB_USDT).balanceOf(user), 0, "shares went to the market, not the wallet");
    }

    function test_supplyFromWallet_leavesNoResidueInTheGateway() public onlyFork {
        vm.prank(user);
        gateway.supplyFromWallet(SUPPLY, VVHUSDT, 0);

        assertEq(IERC20(USDT).balanceOf(address(gateway)), 0, "no underlying left");
        assertEq(IERC20(HUB_USDT).balanceOf(address(gateway)), 0, "no hub shares left");
        assertEq(IVToken(VVHUSDT).balanceOf(address(gateway)), 0, "no market receipts left");
    }

    /// @dev The supply and the market entry land in one call.
    function test_supplyFromWallet_countsAsCollateralImmediately() public onlyFork {
        (, uint256 liquidityBefore, ) = IComptrollerLike(COMPTROLLER).getAccountLiquidity(user);
        assertEq(liquidityBefore, 0, "no borrow power before the supply");

        vm.prank(user);
        gateway.supplyFromWallet(SUPPLY, VVHUSDT, 0);

        assertTrue(IComptrollerLike(COMPTROLLER).checkMembership(user, VVHUSDT), "market entered by the gateway");
        (, uint256 liquidityAfter, ) = IComptrollerLike(COMPTROLLER).getAccountLiquidity(user);
        assertGt(liquidityAfter, 0, "borrow power from the same call");
    }

    // ---------------------------------------------------------------- reverts

    function test_supplyFromWallet_revertsOnUnlistedMarket() public onlyFork {
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(ICollateralGateway.MarketNotListed.selector, HUB_USDT));
        gateway.supplyFromWallet(SUPPLY, HUB_USDT, 0);
    }

    function test_supplyFromWallet_revertsOnZeroArguments() public onlyFork {
        vm.startPrank(user);

        vm.expectRevert(ICollateralGateway.ZeroAddress.selector);
        gateway.supplyFromWallet(SUPPLY, address(0), 0);

        vm.expectRevert(ICollateralGateway.ZeroAmount.selector);
        gateway.supplyFromWallet(0, VVHUSDT, 0);

        vm.stopPrank();
    }

    function test_supplyFromWallet_revertsBelowMinShares() public onlyFork {
        vm.prank(user);
        vm.expectRevert();
        gateway.supplyFromWallet(SUPPLY, VVHUSDT, type(uint128).max);
    }

    /// @dev A full supply cap reverts inside the Comptroller, so the caller keeps their underlying.
    function test_supplyFromWallet_revertsWhenSupplyCapFull() public onlyFork {
        uint256 currentCap = IComptrollerLike(COMPTROLLER).supplyCaps(VVHUSDT);
        assertGt(currentCap, 0, "market has a cap configured");

        address[] memory markets = new address[](1);
        uint256[] memory caps = new uint256[](1);
        markets[0] = VVHUSDT;
        caps[0] = 1;
        vm.prank(COMPTROLLER_ADMIN);
        IComptrollerLike(COMPTROLLER).setMarketSupplyCaps(markets, caps);

        vm.prank(user);
        vm.expectRevert(bytes("market supply cap reached"));
        gateway.supplyFromWallet(SUPPLY, VVHUSDT, 0);

        assertEq(IERC20(USDT).balanceOf(user), SUPPLY, "caller keeps their underlying");
    }

    // ------------------------------------------------- supplyFromCollateral

    /// @dev Puts `amount` of USDT into vUSDT for `user`, with the market entered.
    function _supplyToCore(uint256 amount) private returns (uint256 vTokensHeld) {
        deal(USDT, user, amount);
        vm.startPrank(user);
        IERC20(USDT).approve(VUSDT, amount);
        require(IVBep20Mint(VUSDT).mint(amount) == 0, "mint");
        address[] memory markets = new address[](1);
        markets[0] = VUSDT;
        IComptrollerLike(COMPTROLLER).enterMarkets(markets);
        IDelegation(COMPTROLLER).updateDelegate(address(gateway), true);
        vm.stopPrank();
        return IVToken(VUSDT).balanceOf(user);
    }

    function test_supplyFromCollateral_movesFullPositionWithNoBorrow() public onlyFork {
        uint256 held = _supplyToCore(SUPPLY);

        vm.prank(user);
        uint256 shares = gateway.supplyFromCollateral(VUSDT, held, VVHUSDT, 0);

        assertGt(shares, 0, "hub minted shares");
        assertEq(IVToken(VUSDT).balanceOf(user), 0, "old position fully migrated");
        assertGt(IVToken(VVHUSDT).balanceOf(user), 0, "user holds the vh market receipts");
        assertEq(IERC20(USDT).balanceOf(address(gateway)), 0, "no underlying left in the gateway");
        assertEq(IERC20(HUB_USDT).balanceOf(address(gateway)), 0, "no hub shares left in the gateway");
    }

    function test_supplyFromCollateral_movesHeadroomWhileBorrowing() public onlyFork {
        uint256 held = _supplyToCore(SUPPLY);
        vm.prank(user);
        require(IVBep20Mint(VUSDT).borrow(700e18) == 0, "borrow");

        // 1000 supplied at CF 0.8 against 700 borrowed leaves 125 USDT of headroom.
        uint256 tenth = held / 10;
        vm.prank(user);
        gateway.supplyFromCollateral(VUSDT, tenth, VVHUSDT, 0);

        assertEq(IVToken(VUSDT).balanceOf(user), held - tenth, "only the requested slice moved");
        assertGt(IVToken(VVHUSDT).balanceOf(user), 0, "user holds the vh market receipts");
    }

    // ------------------------------------------------------- flash-loan path

    /// @dev Allow-lists the gateway for flash loans as the NormalTimelock.
    function _whitelistGateway() private {
        vm.prank(COMPTROLLER_ADMIN);
        IComptrollerLike(COMPTROLLER).setWhiteListFlashLoanAccount(address(gateway), true);
    }

    function test_supplyFromCollateral_migratesLeveragedPositionInFull() public onlyFork {
        uint256 held = _supplyToCore(SUPPLY);
        vm.prank(user);
        require(IVBep20Mint(VUSDT).borrow(700e18) == 0, "borrow");
        _whitelistGateway();

        (, uint256 liquidityBefore, ) = IComptrollerLike(COMPTROLLER).getAccountLiquidity(user);
        uint256 debtBefore = IVBep20Mint(VUSDT).borrowBalanceCurrent(user);

        vm.prank(user);
        gateway.supplyFromCollateral(VUSDT, held, VVHUSDT, 0);

        (, uint256 liquidityAfter, uint256 shortfallAfter) = IComptrollerLike(COMPTROLLER).getAccountLiquidity(user);

        assertEq(IVToken(VUSDT).balanceOf(user), 0, "old position fully migrated");
        assertGt(IVToken(VVHUSDT).balanceOf(user), 0, "user holds the vh market receipts");
        assertEq(IVBep20Mint(VUSDT).borrowBalanceCurrent(user), debtBefore, "debt unchanged");
        assertEq(shortfallAfter, 0, "no shortfall after");
        assertApproxEqRel(liquidityAfter, liquidityBefore, 0.01e18, "borrow power preserved");

        assertEq(IERC20(USDT).balanceOf(address(gateway)), 0, "no underlying left in the gateway");
        assertEq(IERC20(HUB_USDT).balanceOf(address(gateway)), 0, "no hub shares left in the gateway");
    }

    /// @dev The caller never enters the vh market themselves; the gateway does it for them.
    function test_supplyFromCollateral_entersTheVhMarketForTheCaller() public onlyFork {
        uint256 held = _supplyToCore(SUPPLY);
        assertFalse(IComptrollerLike(COMPTROLLER).checkMembership(user, VVHUSDT), "not entered up front");

        vm.prank(user);
        gateway.supplyFromCollateral(VUSDT, held, VVHUSDT, 0);

        assertTrue(IComptrollerLike(COMPTROLLER).checkMembership(user, VVHUSDT), "gateway entered it");
    }

    /// @dev Both legs run on the delegate grant, so without it the migration cannot start.
    function test_supplyFromCollateral_revertsWithoutADelegateGrant() public onlyFork {
        uint256 held = _supplyToCore(SUPPLY);
        vm.prank(user);
        IDelegation(COMPTROLLER).updateDelegate(address(gateway), false);

        vm.prank(user);
        vm.expectRevert();
        gateway.supplyFromCollateral(VUSDT, held, VVHUSDT, 0);

        assertEq(IVToken(VUSDT).balanceOf(user), held, "position untouched");
    }

    function test_supplyFromCollateral_revertsWhenGatewayNotWhitelisted() public onlyFork {
        uint256 held = _supplyToCore(SUPPLY);
        vm.prank(user);
        require(IVBep20Mint(VUSDT).borrow(700e18) == 0, "borrow");

        vm.prank(user);
        vm.expectRevert();
        gateway.supplyFromCollateral(VUSDT, held, VVHUSDT, 0);

        assertEq(IVToken(VUSDT).balanceOf(user), held, "position untouched");
    }

    function test_executeOperation_revertsOutsideAMigration() public onlyFork {
        IVToken[] memory markets = new IVToken[](1);
        uint256[] memory amounts = new uint256[](1);
        uint256[] memory premiums = new uint256[](1);
        markets[0] = IVToken(VUSDT);

        vm.expectRevert(ICollateralGateway.UnexpectedCallback.selector);
        gateway.executeOperation(markets, amounts, premiums, address(gateway), address(gateway), "");
    }

    // ---------------------------------------------------------------- withdraw

    function test_withdrawPosition_paysOutOfTheWalletWithoutTouchingCore() public onlyFork {
        vm.startPrank(user);
        IERC20(USDT).approve(HUB_USDT, type(uint256).max);
        uint256 shares = IHubLike(HUB_USDT).deposit(SUPPLY, user);
        IERC20(HUB_USDT).approve(address(gateway), type(uint256).max);

        uint256 expected = IHubLike(HUB_USDT).previewRedeem(shares);
        uint256 assets = gateway.withdrawPosition(VVHUSDT, shares, expected);
        vm.stopPrank();

        assertEq(assets, expected, "paid the previewed amount");
        assertEq(IERC20(USDT).balanceOf(user), assets, "user holds the underlying");
        assertEq(IERC20(HUB_USDT).balanceOf(user), 0, "wallet shares spent");
        assertEq(IVToken(VVHUSDT).balanceOf(user), 0, "no Core position was created or touched");
    }

    function test_withdrawPosition_freesTheCorePositionWhenTheWalletIsEmpty() public onlyFork {
        vm.startPrank(user);
        uint256 shares = gateway.supplyFromWallet(SUPPLY, VVHUSDT, 0);
        assertEq(IERC20(HUB_USDT).balanceOf(user), 0, "the supply left nothing in the wallet");

        IDelegation(COMPTROLLER).updateDelegate(address(gateway), true);
        uint256 assets = gateway.withdrawPosition(VVHUSDT, shares, 0);
        vm.stopPrank();

        assertGt(assets, 0, "paid out of Core");
        assertApproxEqRel(assets, SUPPLY, 0.001e18, "round trip returns the supply within 0.1%");
        assertEq(IERC20(HUB_USDT).balanceOf(address(gateway)), 0, "no shares left in the gateway");
        assertEq(IERC20(USDT).balanceOf(address(gateway)), 0, "no underlying left in the gateway");
    }

    function test_withdrawPosition_revertsWithoutADelegateGrant() public onlyFork {
        vm.startPrank(user);
        uint256 shares = gateway.supplyFromWallet(SUPPLY, VVHUSDT, 0);

        vm.expectRevert("not an approved delegate");
        gateway.withdrawPosition(VVHUSDT, shares, 0);
        vm.stopPrank();
    }

    function test_supplyFromCollateral_revertsOnAssetMismatch() public onlyFork {
        uint256 held = _supplyToCore(SUPPLY);

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(ICollateralGateway.AssetMismatch.selector, HUB_USDT, USDT));
        gateway.supplyFromCollateral(VVHUSDT, held, VVHUSDT, 0);
    }
}
