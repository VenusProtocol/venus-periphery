// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

// solhint-disable func-name-mixedcase, ordering, import-path-check, gas-custom-errors, custom-errors
// solhint-disable no-empty-blocks, immutable-vars-naming, gas-strict-inequalities

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { MockERC20 } from "./MockERC20.sol";

/// @notice Access Control Manager: a per-account allow-all switch
contract MockACM {
    mapping(address => bool) public allowAll;

    function setAllowAll(address account, bool value) external {
        allowAll[account] = value;
    }

    function isAllowedToCall(address account, string calldata) external view returns (bool) {
        return allowAll[account];
    }
}

/// @notice Liquidity Hub: 24-decimal shares over an 18-decimal asset. `pricePerShare` is the asset paid for
///         1e24 shares, so 1e18 means 1 share = 1 asset. Interest is minted to the Hub on redeem.
contract MockHub is ERC20 {
    address public immutable asset;
    uint256 public pricePerShare = 1e18;
    bool public redeemPaused;
    bool public depositPaused;

    constructor(address asset_) ERC20("Hub share", "vh") {
        asset = asset_;
    }

    function decimals() public pure override returns (uint8) {
        return 24;
    }

    function setPricePerShare(uint256 value) external {
        pricePerShare = value;
    }

    function setRedeemPaused(bool value) external {
        redeemPaused = value;
    }

    function setDepositPaused(bool value) external {
        depositPaused = value;
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        require(!depositPaused, "hub paused");
        IERC20(asset).transferFrom(msg.sender, address(this), assets);
        shares = (assets * 1e24) / pricePerShare;
        _mint(receiver, shares);
    }

    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets) {
        require(!redeemPaused, "hub paused");
        require(msg.sender == owner, "not owner");
        _burn(owner, shares);
        assets = (shares * pricePerShare) / 1e24;
        _cover(assets);
        IERC20(asset).transfer(receiver, assets);
    }

    function previewRedeem(uint256 shares) external view returns (uint256) {
        return (shares * pricePerShare) / 1e24;
    }

    function previewWithdraw(uint256 assets) external view returns (uint256) {
        return (assets * 1e24 + pricePerShare - 1) / pricePerShare;
    }

    function _cover(uint256 assets) internal {
        uint256 balance = IERC20(asset).balanceOf(address(this));
        if (balance < assets) MockERC20(asset).mint(address(this), assets - balance);
    }
}

/// @notice Core vToken: 8 decimals, `underlying = vTokens * exchangeRate / 1e18`, error codes on demand.
contract MockVToken is ERC20 {
    address public immutable underlying;
    uint256 public exchangeRate;
    uint256 public mintError;
    uint256 public redeemError;

    constructor(address underlying_, uint256 exchangeRate_) ERC20("Venus token", "vT") {
        underlying = underlying_;
        exchangeRate = exchangeRate_;
    }

    function decimals() public pure override returns (uint8) {
        return 8;
    }

    function setExchangeRate(uint256 value) external {
        exchangeRate = value;
    }

    function setErrors(uint256 mintError_, uint256 redeemError_) external {
        mintError = mintError_;
        redeemError = redeemError_;
    }

    function mint(uint256 amount) external returns (uint256) {
        if (mintError != 0) return mintError;
        IERC20(underlying).transferFrom(msg.sender, address(this), amount);
        _mint(msg.sender, (amount * 1e18) / exchangeRate);
        return 0;
    }

    function redeem(uint256 vTokens) external returns (uint256) {
        if (redeemError != 0) return redeemError;
        _burn(msg.sender, vTokens);
        uint256 amount = (vTokens * exchangeRate) / 1e18;
        uint256 balance = IERC20(underlying).balanceOf(address(this));
        if (balance < amount) MockERC20(underlying).mint(address(this), amount - balance);
        IERC20(underlying).transfer(msg.sender, amount);
        return 0;
    }

    function exchangeRateStored() external view returns (uint256) {
        return exchangeRate;
    }

    function exchangeRateCurrent() external view returns (uint256) {
        return exchangeRate;
    }
}

/// @notice Core Comptroller: listing and XVS rewards.
contract MockComptroller {
    mapping(address => bool) public listed;
    MockERC20 public immutable xvs;
    uint256 public rewardPerClaim;

    constructor() {
        xvs = new MockERC20("XVS", "XVS", 18);
    }

    function list(address vToken) external {
        listed[vToken] = true;
    }

    function setRewardPerClaim(uint256 value) external {
        rewardPerClaim = value;
    }

    function markets(address vToken) external view returns (bool, uint256, bool) {
        return (listed[vToken], 0, false);
    }

    function claimVenus(address holder, address[] calldata) external {
        xvs.mint(holder, rewardPerClaim);
    }

    function getXVSAddress() external view returns (address) {
        return address(xvs);
    }
}

contract MockHubRegistry {
    mapping(address => bool) public isHub;

    function set(address hub, bool value) external {
        isHub[hub] = value;
    }
}

/// @notice ResilientOracle: prices scaled 1e(36 - decimals)
contract MockOracle {
    mapping(address => uint256) public prices;

    function setPrice(address token, uint256 price) external {
        prices[token] = price;
    }

    function getPrice(address token) external view returns (uint256) {
        require(prices[token] != 0, "no price");
        return prices[token];
    }
}

interface ISmartDCAPairs {
    function pairs(
        uint32 pairId
    ) external view returns (address, address, bool, uint32, uint32, uint256, uint256, uint256, uint256);
}

/// @notice SwapHelper stand-in for the swap call: `swap(pairId)` reads the pair from the caller (SmartDCA) and pays
///         `rate / 1e18` of its asset per unit of stable held, less a pool fee of `feeBps`, back to the caller.
///         `quote(amountIn)` returns the same amount, as an aggregator quote would. It applies no minimum, so the
///         caller's own bound is what gets tested. With `fail` set it reverts. With `refundBps` set it sends that
///         share of the stable back to the caller unswapped, as a route that ends with a sweep of the input does.
contract MockSwapHelper {
    uint256 public rate;
    uint256 public feeBps = 25;
    uint256 public refundBps;
    bool public fail;

    function setRate(uint256 value) external {
        rate = value;
    }

    function setFeeBps(uint256 value) external {
        feeBps = value;
    }

    function setRefundBps(uint256 value) external {
        refundBps = value;
    }

    function setFail(bool value) external {
        fail = value;
    }

    function quote(uint256 amountIn) public view returns (uint256) {
        return (((amountIn * rate) / 1e18) * (10_000 - feeBps)) / 10_000;
    }

    function swap(uint32 pairId) external {
        require(!fail, "swap failed");
        (address tokenIn, address tokenOut, , , , , , , ) = ISmartDCAPairs(msg.sender).pairs(pairId);
        uint256 amountIn = IERC20(tokenIn).balanceOf(address(this));
        uint256 refund = (amountIn * refundBps) / 10_000;
        if (refund != 0) IERC20(tokenIn).transfer(msg.sender, refund);
        amountIn -= refund;
        // Spent, so the next part starts from a zero balance
        IERC20(tokenIn).transfer(address(0xdead), amountIn);
        MockERC20(tokenOut).mint(msg.sender, quote(amountIn));
    }
}
