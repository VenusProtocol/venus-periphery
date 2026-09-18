// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

// solhint-disable func-name-mixedcase, ordering, import-path-check, no-empty-blocks

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { IComptroller } from "../../../contracts/Interfaces/IComptroller.sol";
import { CollateralGateway } from "../../../contracts/CollateralGateway/CollateralGateway.sol";
import { ICollateralGateway } from "../../../contracts/CollateralGateway/ICollateralGateway.sol";
import { IVToken } from "../../../contracts/Interfaces/IVToken.sol";
import { MockERC20 } from "./mocks/MockERC20.sol";

interface IGatewayCallback {
    function executeOperation(
        address[] calldata vTokens,
        uint256[] calldata amounts,
        uint256[] calldata premiums,
        address initiator,
        address onBehalf,
        bytes calldata param
    ) external returns (bool, uint256[] memory);
}

/// @dev Attacker-controlled stand-ins. Every address the gateway accepts is caller-supplied.
contract EvilComptroller {
    CollateralGateway public gateway;
    uint256 public constant TREASURY = 0;

    function setGateway(CollateralGateway r) external {
        gateway = r;
    }

    function getHypotheticalAccountLiquidity(
        address,
        address,
        uint256,
        uint256
    ) external pure returns (uint256, uint256, uint256) {
        return (0, 0, 1); // non-zero shortfall forces the flash-loan branch
    }

    function checkMembership(address, address) external pure returns (bool) {
        return true;
    }

    function enterMarketForAccount(address, address) external pure returns (uint256) {
        return 0;
    }

    function markets(address) external pure returns (bool, uint256, bool) {
        return (true, 0, false);
    }

    function treasuryPercent() external pure returns (uint256) {
        return TREASURY;
    }

    /// @dev Never actually lends. Calls straight back with zero amounts.
    function executeFlashLoan(
        address payable,
        address payable,
        address[] calldata,
        uint256[] calldata,
        bytes calldata
    ) external {
        address[] memory t = new address[](1);
        uint256[] memory a = new uint256[](1);
        uint256[] memory p = new uint256[](1);
        t[0] = address(this);
        IGatewayCallback(address(gateway)).executeOperation(t, a, p, address(gateway), address(gateway), "");
    }
}

contract EvilVToken {
    address public immutable underlying;
    address public immutable comptroller;
    uint256 public held = type(uint256).max;

    function setHeld(uint256 amount) external {
        held = amount;
    }

    function balanceOf(address) external view returns (uint256) {
        return held;
    }

    constructor(address underlying_, address comptroller_) {
        underlying = underlying_;
        comptroller = comptroller_;
    }

    function exchangeRateStored() external pure returns (uint256) {
        return 1e18;
    }

    bool public accrued;

    function accrueInterest() external returns (uint256) {
        accrued = true;
        return 0;
    }

    uint256 public flashLoanFeeMantissa;

    function setFlashLoanFee(uint256 mantissa) external {
        flashLoanFeeMantissa = mantissa;
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        return true;
    }

    /// @dev Pushes one wei so the gateway's NothingReceived guard passes.
    function redeemBehalf(address, uint256) external returns (uint256) {
        MockERC20(underlying).mint(msg.sender, 1);
        return 0;
    }

    function approve(address, uint256) external pure returns (bool) {
        return true;
    }
}

contract EvilHub {
    address public immutable asset;

    constructor(address asset_) {
        asset = asset_;
    }

    function deposit(uint256, address) external pure returns (uint256) {
        return 1;
    }

    function approve(address, uint256) external pure returns (bool) {
        return true;
    }

    function allowance(address, address) external pure returns (uint256) {
        return 0;
    }
}

contract EvilMarket {
    address public immutable underlying;
    mapping(address => uint256) public balanceOf;

    constructor(address underlying_) {
        underlying = underlying_;
    }

    function mintBehalf(address receiver, uint256) external returns (uint256) {
        balanceOf[receiver] += 1;
        return 0;
    }
}

/// @dev Echoes back the exact markets and amounts the gateway recorded, so every callback guard
///      passes and the body runs. This is the shape the guards do not stop.
contract EchoingComptroller {
    CollateralGateway public gateway;
    uint256 public lastAmount;
    mapping(address => bool) public unlisted;

    function unlist(address market) external {
        unlisted[market] = true;
    }

    function setGateway(CollateralGateway r) external {
        gateway = r;
    }

    /// @dev Reports the shortfall only once the market has accrued, the way Core's own redeem
    ///      check sees it, so a caller that asks before accrual gets the stale answer.
    function getHypotheticalAccountLiquidity(
        address,
        address vToken,
        uint256,
        uint256
    ) external view returns (uint256, uint256, uint256) {
        return (0, 0, EvilVToken(vToken).accrued() ? 1 : 0);
    }

    function checkMembership(address, address) external pure returns (bool) {
        return true;
    }

    function enterMarketForAccount(address, address) external pure returns (uint256) {
        return 0;
    }

    function markets(address market) external view returns (bool, uint256, bool) {
        return (!unlisted[market], 0, false);
    }

    function treasuryPercent() external pure returns (uint256) {
        return 0;
    }

    function executeFlashLoan(
        address payable,
        address payable,
        address[] calldata vTokens,
        uint256[] calldata amounts,
        bytes calldata
    ) external {
        address[] memory t = new address[](1);
        uint256[] memory a = new uint256[](1);
        uint256[] memory p = new uint256[](1);
        lastAmount = amounts[0];
        t[0] = vTokens[0];
        a[0] = amounts[0];
        IGatewayCallback(address(gateway)).executeOperation(t, a, p, address(gateway), address(gateway), "");
    }
}

/// @dev Takes the loan call and returns without ever invoking the callback.
contract SilentComptroller {
    function getHypotheticalAccountLiquidity(
        address,
        address,
        uint256,
        uint256
    ) external pure returns (uint256, uint256, uint256) {
        return (0, 0, 1);
    }

    function checkMembership(address, address) external pure returns (bool) {
        return true;
    }

    function enterMarketForAccount(address, address) external pure returns (uint256) {
        return 0;
    }

    function markets(address) external pure returns (bool, uint256, bool) {
        return (true, 0, false);
    }

    function treasuryPercent() external pure returns (uint256) {
        return 0;
    }

    function executeFlashLoan(
        address payable,
        address payable,
        address[] calldata,
        uint256[] calldata,
        bytes calldata
    ) external {}
}

/// @dev Spends the allowance the gateway grants before `deposit`, taking whatever the gateway holds.
contract GreedyHub {
    address public immutable asset;
    address public immutable thief;

    constructor(address asset_, address thief_) {
        asset = asset_;
        thief = thief_;
    }

    function deposit(uint256 assets, address) external returns (uint256) {
        IERC20(asset).transferFrom(msg.sender, thief, assets);
        return 1;
    }

    function approve(address, uint256) external pure returns (bool) {
        return true;
    }

    function allowance(address, address) external pure returns (uint256) {
        return 0;
    }
}

contract CollateralGateway_AdversarialTest is Test {
    CollateralGateway internal gateway;
    MockERC20 internal usdt;
    address internal attacker = makeAddr("attacker");
    address internal owner = makeAddr("owner");

    function setUp() public {
        gateway = new CollateralGateway(IComptroller(address(new EchoingComptroller())), owner);
        usdt = new MockERC20("Tether", "USDT", 18);
    }

    /// @dev A caller controlling every address the gateway accepts can still drive the flash-loan
    ///      callback, but not with arguments the gateway did not ask for. Without that check a
    ///      zero-amount callback let any caller sweep a stuck balance out of the gateway.
    /// @dev The gateway pays out change against its own redeem proceeds, so a caller who wires up
    ///      every address cannot reach a balance the gateway was already holding.
    function test_echoingCallbackCannotSweepTokensHeldByTheGateway() public {
        EchoingComptroller comptroller = new EchoingComptroller();
        gateway = new CollateralGateway(IComptroller(address(comptroller)), owner);
        comptroller.setGateway(gateway);
        usdt.mint(address(gateway), 1000e18);
        EvilVToken vToken = new EvilVToken(address(usdt), address(comptroller));
        EvilHub hub = new EvilHub(address(usdt));
        EvilMarket market = new EvilMarket(address(hub));

        vm.prank(attacker);
        gateway.supplyFromCollateral(address(vToken), 1, address(market), 0);

        assertEq(usdt.balanceOf(address(gateway)), 1000e18 + 1, "gateway keeps what it held");
        assertEq(usdt.balanceOf(attacker), 0, "attacker gained nothing");
    }

    /// @dev The caller names the receipt count, so a count they do not hold fails here rather than
    ///      inside the market, which answers an over-redeem with a bare "math error".
    function testRevert_supplyFromCollateral_moreReceiptsThanHeld() public {
        EchoingComptroller comptroller = new EchoingComptroller();
        gateway = new CollateralGateway(IComptroller(address(comptroller)), owner);
        comptroller.setGateway(gateway);
        EvilVToken vToken = new EvilVToken(address(usdt), address(comptroller));
        vToken.setHeld(5);
        EvilHub hub = new EvilHub(address(usdt));
        EvilMarket market = new EvilMarket(address(hub));

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(ICollateralGateway.InsufficientReceipts.selector, 5, 6));
        gateway.supplyFromCollateral(address(vToken), 6, address(market), 0);
    }

    /// @dev A hub is caller-supplied, so it can spend the approval the gateway grants it. The
    ///      balance check makes the whole call revert rather than let it reach a stuck balance.
    function test_greedyHubCannotSpendABalanceTheGatewayHeld() public {
        EchoingComptroller comptroller = new EchoingComptroller();
        gateway = new CollateralGateway(IComptroller(address(comptroller)), owner);
        comptroller.setGateway(gateway);
        usdt.mint(address(gateway), 1000e18);
        EvilVToken vToken = new EvilVToken(address(usdt), address(comptroller));
        GreedyHub hub = new GreedyHub(address(usdt), attacker);
        EvilMarket market = new EvilMarket(address(hub));

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(ICollateralGateway.BalanceSpent.selector, 1000e18, 1));
        gateway.supplyFromCollateral(address(vToken), 1000e18, address(market), 0);

        assertEq(usdt.balanceOf(attacker), 0, "attacker gained nothing");
        assertEq(usdt.balanceOf(address(gateway)), 1000e18, "gateway keeps what it held");
    }

    /// @dev Approvals granted to caller-supplied addresses do not outlive the call that needed them.
    function test_noApprovalsOutliveTheCall() public {
        EchoingComptroller comptroller = new EchoingComptroller();
        gateway = new CollateralGateway(IComptroller(address(comptroller)), owner);
        comptroller.setGateway(gateway);
        EvilVToken vToken = new EvilVToken(address(usdt), address(comptroller));
        EvilHub hub = new EvilHub(address(usdt));
        EvilMarket market = new EvilMarket(address(hub));

        vm.prank(attacker);
        gateway.supplyFromCollateral(address(vToken), 1, address(market), 0);

        assertEq(usdt.allowance(address(gateway), address(hub)), 0, "hub allowance cleared");
        assertEq(usdt.allowance(address(gateway), address(vToken)), 0, "repay allowance cleared");
    }

    /// @dev The market charges its flash-loan fee on top of the principal, so the principal has to
    ///      leave room for it inside what the redeem pays out.
    function test_flashAmountLeavesRoomForTheMarketFee() public {
        EchoingComptroller comptroller = new EchoingComptroller();
        gateway = new CollateralGateway(IComptroller(address(comptroller)), owner);
        comptroller.setGateway(gateway);
        EvilVToken vToken = new EvilVToken(address(usdt), address(comptroller));
        vToken.setFlashLoanFee(1e16); // 1%
        EvilHub hub = new EvilHub(address(usdt));
        EvilMarket market = new EvilMarket(address(hub));

        vm.prank(attacker);
        gateway.supplyFromCollateral(address(vToken), 100e18, address(market), 0);

        // The redeem pays out 100e18 at the mock's 1:1 rate, so the loan plus its fee must fit in it.
        uint256 borrowed = comptroller.lastAmount();
        assertEq(borrowed, 99_009_900_990_099_009_900, "principal scaled down by the fee");
        assertLe(borrowed + ((borrowed * 1e16) / 1e18), 100e18, "loan plus fee fits inside the redeem");
    }

    /// @dev The hub and the asset are read off the vh market, so it has to be one the Comptroller
    ///      lists before anything else in the call can be trusted.
    function testRevert_supplyFromCollateral_vhMarketNotListed() public {
        EchoingComptroller comptroller = new EchoingComptroller();
        gateway = new CollateralGateway(IComptroller(address(comptroller)), owner);
        comptroller.setGateway(gateway);
        EvilVToken vToken = new EvilVToken(address(usdt), address(comptroller));
        EvilHub hub = new EvilHub(address(usdt));
        EvilMarket market = new EvilMarket(address(hub));
        comptroller.unlist(address(market));

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(ICollateralGateway.MarketNotListed.selector, address(market)));
        gateway.supplyFromCollateral(address(vToken), 1, address(market), 0);
    }

    /// @dev `type(uint256).max` stands for the caller's whole balance, read when the call runs.
    function test_supplyFromCollateral_maxMigratesTheWholeBalance() public {
        EchoingComptroller comptroller = new EchoingComptroller();
        gateway = new CollateralGateway(IComptroller(address(comptroller)), owner);
        comptroller.setGateway(gateway);
        EvilVToken vToken = new EvilVToken(address(usdt), address(comptroller));
        vToken.setHeld(77e18);
        EvilHub hub = new EvilHub(address(usdt));
        EvilMarket market = new EvilMarket(address(hub));

        vm.prank(attacker);
        gateway.supplyFromCollateral(address(vToken), type(uint256).max, address(market), 0);

        assertEq(comptroller.lastAmount(), 77e18, "the whole balance was migrated");
    }

    /// @dev A caller holding nothing cannot turn the sentinel into a zero-amount call.
    function testRevert_supplyFromCollateral_maxWithNothingHeld() public {
        EchoingComptroller comptroller = new EchoingComptroller();
        gateway = new CollateralGateway(IComptroller(address(comptroller)), owner);
        comptroller.setGateway(gateway);
        EvilVToken vToken = new EvilVToken(address(usdt), address(comptroller));
        vToken.setHeld(0);
        EvilHub hub = new EvilHub(address(usdt));
        EvilMarket market = new EvilMarket(address(hub));

        vm.prank(attacker);
        vm.expectRevert(ICollateralGateway.ZeroAmount.selector);
        gateway.supplyFromCollateral(address(vToken), type(uint256).max, address(market), 0);
    }

    /// @dev The source market is caller-supplied too, so it has to be one the Comptroller lists.
    function testRevert_supplyFromCollateral_sourceMarketNotListed() public {
        EchoingComptroller comptroller = new EchoingComptroller();
        gateway = new CollateralGateway(IComptroller(address(comptroller)), owner);
        comptroller.setGateway(gateway);
        EvilVToken vToken = new EvilVToken(address(usdt), address(comptroller));
        EvilHub hub = new EvilHub(address(usdt));
        EvilMarket market = new EvilMarket(address(hub));
        comptroller.unlist(address(vToken));

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(ICollateralGateway.MarketNotListed.selector, address(vToken)));
        gateway.supplyFromCollateral(address(vToken), 1, address(market), 0);
    }

    /// @dev The market's own redeem accrues before it checks liquidity, so asking beforehand reads
    ///      a stale borrow balance and can miss a shortfall the redeem then rejects.
    function test_theShortfallCheckReadsAccruedState() public {
        EchoingComptroller comptroller = new EchoingComptroller();
        gateway = new CollateralGateway(IComptroller(address(comptroller)), owner);
        comptroller.setGateway(gateway);
        EvilVToken vToken = new EvilVToken(address(usdt), address(comptroller));
        EvilHub hub = new EvilHub(address(usdt));
        EvilMarket market = new EvilMarket(address(hub));

        vm.prank(attacker);
        gateway.supplyFromCollateral(address(vToken), 100e18, address(market), 0);

        assertTrue(vToken.accrued(), "the source market was accrued");
        assertGt(comptroller.lastAmount(), 0, "the shortfall was seen, so the flash path ran");
    }

    /// @dev A callback whose amounts do not match what the gateway recorded is rejected outright.
    function test_callbackWithMismatchedAmountsReverts() public {
        EvilComptroller comptroller = new EvilComptroller();
        gateway = new CollateralGateway(IComptroller(address(comptroller)), owner);
        comptroller.setGateway(gateway);
        usdt.mint(address(gateway), 1000e18);
        EvilVToken vToken = new EvilVToken(address(usdt), address(comptroller));
        EvilHub hub = new EvilHub(address(usdt));
        EvilMarket market = new EvilMarket(address(hub));

        vm.prank(attacker);
        vm.expectRevert(ICollateralGateway.UnexpectedCallback.selector);
        gateway.supplyFromCollateral(address(vToken), 1, address(market), 0);

        assertEq(usdt.balanceOf(address(gateway)), 1000e18, "gateway balance untouched");
        assertEq(usdt.balanceOf(attacker), 0, "attacker gained nothing");
    }

    /// @dev The callback is only reachable while a migration is in flight.
    function test_callbackRevertsOutsideAMigration() public {
        IVToken[] memory t = new IVToken[](1);
        uint256[] memory a = new uint256[](1);
        uint256[] memory p = new uint256[](1);

        vm.prank(attacker);
        vm.expectRevert(ICollateralGateway.UnexpectedCallback.selector);
        gateway.executeOperation(t, a, p, address(gateway), address(gateway), "");
    }

    /// @dev A comptroller that returns without calling back leaves nothing minted, which must fail
    ///      rather than emit a success with a stale count.
    function test_flashLoanThatNeverCallsBackReverts() public {
        SilentComptroller comptroller = new SilentComptroller();
        gateway = new CollateralGateway(IComptroller(address(comptroller)), owner);
        EvilVToken vToken = new EvilVToken(address(usdt), address(comptroller));
        EvilHub hub = new EvilHub(address(usdt));
        EvilMarket market = new EvilMarket(address(hub));

        vm.prank(attacker);
        vm.expectRevert(ICollateralGateway.UnexpectedCallback.selector);
        gateway.supplyFromCollateral(address(vToken), 1, address(market), 0);
    }
}
