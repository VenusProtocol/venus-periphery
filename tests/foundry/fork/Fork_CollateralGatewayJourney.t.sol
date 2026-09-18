// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

// solhint-disable func-name-mixedcase, ordering, import-path-check, no-console

import { Test, console2 } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { IComptroller } from "../../../contracts/Interfaces/IComptroller.sol";
import { CollateralGateway } from "../../../contracts/CollateralGateway/CollateralGateway.sol";
import { IVToken } from "../../../contracts/Interfaces/IVToken.sol";

interface IComptrollerLike {
    function enterMarkets(address[] calldata vTokens) external returns (uint256[] memory);
    function checkMembership(address account, address vToken) external view returns (bool);
    function getAccountLiquidity(address account) external view returns (uint256, uint256, uint256);
    function setWhiteListFlashLoanAccount(address account, bool isWhiteListed) external;
}

interface IVBep20Mint {
    function mint(uint256 mintAmount) external returns (uint256);
    function redeem(uint256 redeemTokens) external returns (uint256);
    function borrow(uint256 borrowAmount) external returns (uint256);
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
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);
}

/**
 * @title Fork_CollateralGatewayJourney
 * @notice What one user signs to get a Hub position working as Core collateral, counted and
 *         printed: the gateway path against the same journey done by hand, first time and repeat.
 *         Runs against the live BNB Chain deployment.
 * @dev Run with `forge test --match-contract Fork_CollateralGatewayJourney -vv` to see the log. Without
 *      `-vv` forge hides `console2` output and only the transaction-count assertions run.
 *
 *      Transaction counts are declared by the test, not observed: `vm.prank` is not a transaction
 *      boundary, so nothing in forge can count what a user signs. Each count is asserted rather
 *      than only logged, so a change that adds a required user action fails here instead of
 *      quietly making the printed number wrong.
 *
 *      Every journey assumes an unlimited approval. An exact-amount approval makes each repeat
 *      cost one more transaction than the numbers below.
 *
 *      The gas printed alongside each transaction is there to be read, not to be won: the gateway
 *      burns more gas than the same journey done by hand. What it saves is signatures, and in the
 *      borrowing case it does something the hand path cannot do at all.
 */
contract Fork_CollateralGatewayJourneyTest is Test {
    address internal constant COMPTROLLER = 0xfD36E2c2a6789Db23113685031d7F16329158384;
    address internal constant USDT = 0x55d398326f99059fF775485246999027B3197955;
    address internal constant VUSDT = 0xfD5840Cd36d94D7229439859C0112a4185BC0255;
    address internal constant HUB_USDT = 0x18AfDACF30F8671021dec4b78297E39d2FE87226;
    address internal constant VVHUSDT = 0xc0768948e668B7BacFf8b4BD1BaBe0eD2b512d3c;

    uint256 internal constant FORK_BLOCK = 121_990_000;
    uint256 internal constant SUPPLY = 1000e18;
    uint256 internal constant BORROW = 700e18;
    bytes4 internal constant ENTER_FOR_ACCOUNT = bytes4(keccak256("enterMarketForAccount(address,address)"));
    address internal constant COMPTROLLER_ADMIN = 0x939bD8d64c0A9583A7Dcea9933f7b21697ab6396;
    address internal constant ACM = 0x4788629ABc6cFCA10F9f969efdEAa1cF70c23555;

    CollateralGateway internal gateway;
    address internal user = makeAddr("gatewayUser");
    address internal manual = makeAddr("manualUser");
    bool internal forkLive;

    uint256 private _txCount;
    uint256 private _gasTotal;

    function setUp() public {
        string memory rpc = vm.envOr("ARCHIVE_NODE_bscmainnet", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc, FORK_BLOCK);
        forkLive = true;

        gateway = new CollateralGateway(IComptroller(COMPTROLLER));
        _cutInEnterMarketForAccount();
    }

    modifier onlyFork() {
        if (!forkLive) {
            vm.skip(true);
        }
        _;
    }

    // ------------------------------------------------------------- journeys

    /// @dev Underlying in the wallet, ending as Core collateral.
    function test_journey_supplyFromWallet() public onlyFork {
        _header("supplyFromWallet, first time");
        _reset();
        deal(USDT, user, SUPPLY);

        uint256 gas = gasleft();
        vm.prank(user);
        IERC20(USDT).approve(address(gateway), type(uint256).max);
        _tx("USDT.approve(gateway)", gas);

        gas = gasleft();
        vm.prank(user);
        gateway.supplyFromWallet(SUPPLY, VVHUSDT, 0);
        _tx("gateway.supplyFromWallet", gas);

        assertEq(_txCount, 2, "first-time gateway supply is two transactions");
        assertTrue(IComptrollerLike(COMPTROLLER).checkMembership(user, VVHUSDT), "collateral from the same call");
        _total();

        _header("supplyFromWallet, repeat");
        _reset();
        deal(USDT, user, SUPPLY);

        gas = gasleft();
        vm.prank(user);
        gateway.supplyFromWallet(SUPPLY, VVHUSDT, 0);
        _tx("gateway.supplyFromWallet", gas);

        assertEq(_txCount, 1, "a repeat gateway supply is one transaction");
        _total();

        _header("the same journey by hand, first time");
        _reset();
        deal(USDT, manual, SUPPLY);
        uint256 byHand = _supplyByHand(SUPPLY);

        assertEq(_txCount, 5, "by hand is five transactions");
        assertGt(byHand, 0, "the hand path ends in the same place");
        assertTrue(IComptrollerLike(COMPTROLLER).checkMembership(manual, VVHUSDT), "market entered by hand");
        _total();

        _header("the same journey by hand, repeat");
        _reset();
        deal(USDT, manual, SUPPLY);

        gas = gasleft();
        vm.prank(manual);
        uint256 shares = IHubLike(HUB_USDT).deposit(SUPPLY, manual);
        _tx("Hub.deposit", gas);

        gas = gasleft();
        vm.prank(manual);
        require(IVBep20Mint(VVHUSDT).mint(shares) == 0, "mint");
        _tx("vvhUSDT.mint", gas);

        assertEq(_txCount, 2, "a repeat by hand is two transactions, both approvals still standing");
        _total();
    }

    /// @dev An existing Core position with no debt, moved into the Hub and back into Core.
    function test_journey_supplyFromCollateral() public onlyFork {
        _header("supplyFromCollateral, first time");
        _reset();
        uint256 heldByHand = _positionInCore(SUPPLY, manual);
        uint256 held = _positionInCore(SUPPLY, user);

        uint256 gas = gasleft();
        vm.prank(user);
        IDelegation(COMPTROLLER).updateDelegate(address(gateway), true);
        _tx("Comptroller.updateDelegate(gateway)", gas);

        gas = gasleft();
        vm.prank(user);
        gateway.supplyFromCollateral(VUSDT, held, VVHUSDT, 0);
        _tx("gateway.supplyFromCollateral", gas);

        assertEq(_txCount, 2, "first-time gateway migration is two transactions");
        assertEq(IVToken(VUSDT).balanceOf(user), 0, "old position fully moved");
        _total();

        _header("supplyFromCollateral, repeat");
        _reset();
        uint256 again = _positionInCore(SUPPLY, user);

        gas = gasleft();
        vm.prank(user);
        gateway.supplyFromCollateral(VUSDT, again, VVHUSDT, 0);
        _tx("gateway.supplyFromCollateral", gas);

        assertEq(_txCount, 1, "a repeat migration is one transaction, the delegate grant still standing");
        _total();

        _header("the same migration by hand, first time");
        _reset();

        gas = gasleft();
        vm.prank(manual);
        require(IVBep20Mint(VUSDT).redeem(heldByHand) == 0, "redeem");
        _tx("vUSDT.redeem", gas);

        uint256 redeemed = IERC20(USDT).balanceOf(manual);
        _supplyByHand(redeemed);

        assertEq(_txCount, 6, "by hand is six transactions");
        _total();
    }

    /// @dev A borrowing position. The gateway routes it through a flash loan; by hand the first
    ///      step is rejected, because the collateral cannot leave before its replacement exists.
    function test_journey_supplyFromCollateral_whileBorrowing() public onlyFork {
        _header("supplyFromCollateral while borrowing, first time");
        _reset();
        uint256 held = _positionInCore(SUPPLY, user);
        vm.prank(user);
        require(IVBep20Mint(VUSDT).borrow(BORROW) == 0, "borrow");
        _whitelistGateway();

        uint256 gas = gasleft();
        vm.prank(user);
        IDelegation(COMPTROLLER).updateDelegate(address(gateway), true);
        _tx("Comptroller.updateDelegate(gateway)", gas);

        gas = gasleft();
        vm.prank(user);
        gateway.supplyFromCollateral(VUSDT, held, VVHUSDT, 0);
        _tx("gateway.supplyFromCollateral", gas);

        (, , uint256 shortfall) = IComptrollerLike(COMPTROLLER).getAccountLiquidity(user);
        assertEq(_txCount, 2, "a leveraged migration is two transactions");
        assertEq(IVToken(VUSDT).balanceOf(user), 0, "old position fully moved");
        assertEq(shortfall, 0, "no shortfall left behind");
        _total();

        _header("the same migration by hand");
        uint256 heldByHand = _positionInCore(SUPPLY, manual);
        vm.prank(manual);
        require(IVBep20Mint(VUSDT).borrow(BORROW) == 0, "borrow");

        vm.prank(manual);
        try IVBep20Mint(VUSDT).redeem(heldByHand) returns (uint256 errorCode) {
            assertTrue(errorCode != 0, "redeem rejected");
            console2.log("  tx 1: vUSDT.redeem  REJECTED, error code %s", errorCode);
        } catch {
            console2.log("  tx 1: vUSDT.redeem  REVERTED");
        }

        assertEq(IVToken(VUSDT).balanceOf(manual), heldByHand, "position cannot move by hand");
        console2.log("  no sequence of transactions completes this migration without a flash loan");
    }

    /// @dev Hub shares sitting in the wallet, taken back to underlying.
    function test_journey_withdrawFromTheWallet() public onlyFork {
        _header("withdrawPosition out of the wallet, first time");
        _reset();
        uint256 shares = _sharesInWallet(SUPPLY, user);

        uint256 gas = gasleft();
        vm.prank(user);
        IERC20(HUB_USDT).approve(address(gateway), type(uint256).max);
        _tx("vhUSDT.approve(gateway)", gas);

        gas = gasleft();
        vm.prank(user);
        gateway.withdrawPosition(VVHUSDT, shares, 0);
        _tx("gateway.withdrawPosition", gas);

        assertEq(_txCount, 2, "first-time wallet withdraw is two transactions");
        assertGt(IERC20(USDT).balanceOf(user), 0, "paid in underlying");
        _total();

        _header("withdrawPosition out of the wallet, repeat");
        _reset();
        shares = _sharesInWallet(SUPPLY, user);

        gas = gasleft();
        vm.prank(user);
        gateway.withdrawPosition(VVHUSDT, shares, 0);
        _tx("gateway.withdrawPosition", gas);

        assertEq(_txCount, 1, "a repeat wallet withdraw is one transaction");
        _total();

        _header("the same withdraw by hand");
        _reset();
        uint256 byHand = _sharesInWallet(SUPPLY, manual);

        gas = gasleft();
        vm.prank(manual);
        IHubLike(HUB_USDT).redeem(byHand, manual, manual);
        _tx("Hub.redeem", gas);

        assertEq(_txCount, 1, "by hand is one transaction, the owner needs no approval");
        _total();
    }

    /// @dev A position split across the wallet and the vh market, taken back to underlying. The
    ///      gateway covers both sides in one call.
    function test_journey_withdrawSplitPosition() public onlyFork {
        _header("withdrawPosition across wallet and market, first time");
        _reset();
        (uint256 walletShares, uint256 marketShares) = _splitPosition(user);

        uint256 gas = gasleft();
        vm.prank(user);
        IERC20(HUB_USDT).approve(address(gateway), type(uint256).max);
        _tx("vhUSDT.approve(gateway)", gas);

        gas = gasleft();
        vm.prank(user);
        IDelegation(COMPTROLLER).updateDelegate(address(gateway), true);
        _tx("Comptroller.updateDelegate(gateway)", gas);

        gas = gasleft();
        vm.prank(user);
        gateway.withdrawPosition(VVHUSDT, walletShares + marketShares, 0);
        _tx("gateway.withdrawPosition", gas);

        assertEq(_txCount, 3, "first-time split withdraw is three transactions");
        assertEq(IERC20(HUB_USDT).balanceOf(user), 0, "wallet side spent");
        assertEq(IVToken(VVHUSDT).balanceOf(user), 0, "market side freed");
        _total();

        _header("withdrawPosition across wallet and market, repeat");
        _reset();
        (walletShares, marketShares) = _splitPosition(user);

        gas = gasleft();
        vm.prank(user);
        gateway.withdrawPosition(VVHUSDT, walletShares + marketShares, 0);
        _tx("gateway.withdrawPosition", gas);

        assertEq(_txCount, 1, "a repeat split withdraw is one transaction");
        _total();

        _header("the same withdraw by hand");
        _reset();
        _splitPosition(manual);

        // Read the balances before pranking: a call inside the arguments would spend the prank
        // and leave the redeem running as this test contract, which holds nothing.
        uint256 receipts = IVToken(VVHUSDT).balanceOf(manual);

        gas = gasleft();
        vm.prank(manual);
        require(IVBep20Mint(VVHUSDT).redeem(receipts) == 0, "redeem");
        _tx("vvhUSDT.redeem", gas);

        uint256 heldShares = IERC20(HUB_USDT).balanceOf(manual);

        gas = gasleft();
        vm.prank(manual);
        IHubLike(HUB_USDT).redeem(heldShares, manual, manual);
        _tx("Hub.redeem", gas);

        assertEq(_txCount, 2, "by hand is two transactions, one per side");
        _total();
    }

    // -------------------------------------------------------------- helpers

    /// @dev Record one user transaction and print it with the gas it burned, where `gasBefore` is
    ///      `gasleft()` read immediately before the call.
    ///
    ///      The figure carries the surrounding cheatcode overhead, so read it against another
    ///      `_tx` in this file rather than as the cost of the call on its own.
    function _tx(string memory label, uint256 gasBefore) private {
        uint256 used = gasBefore - gasleft();
        _txCount++;
        _gasTotal += used;
        console2.log("  tx %s: %s", _txCount, label);
        console2.log("         gas %s", used);
    }

    function _reset() private {
        _txCount = 0;
        _gasTotal = 0;
    }

    function _header(string memory title) private pure {
        console2.log("");
        console2.log("=== %s ===", title);
    }

    function _total() private view {
        console2.log("  --- %s transactions, %s gas", _txCount, _gasTotal);
    }

    /// @dev Deposit `amount` of USDT into the Hub and supply the shares to the vh market, as the
    ///      user would with no gateway. Returns the shares minted. Counts five transactions.
    function _supplyByHand(uint256 amount) private returns (uint256 shares) {
        uint256 gas = gasleft();
        vm.prank(manual);
        IERC20(USDT).approve(HUB_USDT, type(uint256).max);
        _tx("USDT.approve(Hub)", gas);

        gas = gasleft();
        vm.prank(manual);
        shares = IHubLike(HUB_USDT).deposit(amount, manual);
        _tx("Hub.deposit", gas);

        gas = gasleft();
        vm.prank(manual);
        IERC20(HUB_USDT).approve(VVHUSDT, type(uint256).max);
        _tx("vhUSDT.approve(vvhUSDT)", gas);

        gas = gasleft();
        vm.prank(manual);
        require(IVBep20Mint(VVHUSDT).mint(shares) == 0, "mint");
        _tx("vvhUSDT.mint", gas);

        address[] memory markets = new address[](1);
        markets[0] = VVHUSDT;
        gas = gasleft();
        vm.prank(manual);
        IComptrollerLike(COMPTROLLER).enterMarkets(markets);
        _tx("Comptroller.enterMarkets", gas);
    }

    /// @dev Put `amount` of USDT into vUSDT for `account`, with the market entered. Returns the
    ///      receipts held. Not counted: this is the position the journey starts from.
    function _positionInCore(uint256 amount, address account) private returns (uint256 vTokensHeld) {
        deal(USDT, account, amount);
        vm.startPrank(account);
        IERC20(USDT).approve(VUSDT, amount);
        require(IVBep20Mint(VUSDT).mint(amount) == 0, "mint");
        address[] memory markets = new address[](1);
        markets[0] = VUSDT;
        IComptrollerLike(COMPTROLLER).enterMarkets(markets);
        vm.stopPrank();
        return IVToken(VUSDT).balanceOf(account);
    }

    /// @dev Deposit `amount` of USDT into the Hub for `account`, leaving the shares in their
    ///      wallet. Returns the shares minted. Not counted: this is the position a withdraw
    ///      journey starts from.
    function _sharesInWallet(uint256 amount, address account) private returns (uint256 shares) {
        deal(USDT, account, amount);
        vm.startPrank(account);
        IERC20(USDT).approve(HUB_USDT, type(uint256).max);
        shares = IHubLike(HUB_USDT).deposit(amount, account);
        vm.stopPrank();
    }

    /// @dev Put half of `account`'s Hub shares into the vh market and leave the rest in the
    ///      wallet. Returns the two sides. Not counted, like {_sharesInWallet}.
    function _splitPosition(address account) private returns (uint256 walletShares, uint256 marketShares) {
        uint256 shares = _sharesInWallet(SUPPLY, account);
        marketShares = shares / 2;

        vm.startPrank(account);
        IERC20(HUB_USDT).approve(VVHUSDT, type(uint256).max);
        require(IVBep20Mint(VVHUSDT).mint(marketShares) == 0, "mint");
        vm.stopPrank();

        return (IERC20(HUB_USDT).balanceOf(account), marketShares);
    }

    /// @dev Allow-lists the gateway for flash loans as the NormalTimelock.
    function _whitelistGateway() private {
        vm.prank(COMPTROLLER_ADMIN);
        IComptrollerLike(COMPTROLLER).setWhiteListFlashLoanAccount(address(gateway), true);
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
}
