import { expect } from "chai";
import { Signer } from "ethers";
import { parseUnits } from "ethers/lib/utils";
import { ethers } from "hardhat";

import {
  Comptroller,
  ComptrollerHarness,
  ERC20,
  NativeTokenGateway,
  VBep20Delegator,
  VToken,
} from "../../../typechain";
import { initMainnetUser, setForkBlock } from "./utils";

// Core Pool Configurations
const ADMIN_CORE = "0xce10739590001705F7FF231611ba4A48B2820327";
const COMPTROLLER_ADDRESS_CORE = "0x94d1820b2D1c7c7452A163983Dc888CEC546b77D";
const VWBNB_CORE = "0xd9E77847ec815E56ae2B9E69596C69b6972b0B1C";
const USDT_CORE = "0xA11c8D9DC9b66E209Ef60F0C8D969D3CD988782c";
const VUSDT_CORE = "0xb7526572FFE56AB9D7489838Bf2E18e3323b441A";
const USER1_CORE = "0x745bCE0D540AbE9cB639b6eACb5f6Ded3Cf947C9";
const USER2_CORE = "0xbEe5b9859B03FEefd5Ae3ce7C5d92f3b09a55149";
const BLOCK_NUMBER_BNB = 64998882;

async function configureTimeLockCore() {
  impersonatedTimeLock_core = await initMainnetUser(ADMIN_CORE, ethers.utils.parseUnits("2"));
}

const FORK = process.env.FORK === "true";
const FORKED_NETWORK = process.env.FORKED_NETWORK;

let user1_core: Signer;
let user2_core: Signer;
let impersonatedTimeLock_core: Signer;
let comptroller_core: ComptrollerHarness;
let vwbnb_core: VBep20Delegator;
let usdt_core: ERC20;
let vusdt_core: VBep20Delegator;
let nativeTokenGateway_core: NativeTokenGateway;

async function setupCore() {
  await configureTimeLockCore();

  user1_core = await initMainnetUser(USER1_CORE, ethers.utils.parseEther("100"));
  user2_core = await initMainnetUser(USER2_CORE, ethers.utils.parseEther("100"));

  await ethers.provider.send("hardhat_setBalance", [
    await user1_core.getAddress(),
    "0x56BC75E2D63100000", // 100 BNB in hex
  ]);
  await ethers.provider.send("hardhat_setBalance", [
    await user2_core.getAddress(),
    "0x56BC75E2D63100000", // 100 BNB in hex
  ]);

  usdt_core = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/ERC20.sol:ERC20", USDT_CORE);

  const comptroller_core = await ethers.getContractAt("ComptrollerHarness", COMPTROLLER_ADDRESS_CORE);

  vusdt_core = await ethers.getContractAt("VBep20Delegator", VUSDT_CORE);
  vwbnb_core = await ethers.getContractAt("VBep20Delegator", VWBNB_CORE);

  await comptroller_core.connect(impersonatedTimeLock_core)._supportMarket(vwbnb_core.address);

  await comptroller_core
    .connect(impersonatedTimeLock_core)
    ._setMarketSupplyCaps([VUSDT_CORE, VWBNB_CORE], [parseUnits("100000000000", 40), parseUnits("100000000000", 40)]);

  await comptroller_core
    .connect(impersonatedTimeLock_core)
    ._setMarketBorrowCaps([VUSDT_CORE, VWBNB_CORE], [parseUnits("100000000000", 40), parseUnits("100000000000", 40)]);

  await comptroller_core.connect(user1_core).enterMarkets([vusdt_core.address, vwbnb_core.address]);
  await comptroller_core.connect(user2_core).enterMarkets([vusdt_core.address, vwbnb_core.address]);

  const nativeTokenGatewayFactory = await ethers.getContractFactory(
    "contracts/Gateway/NativeTokenGateway.sol:NativeTokenGateway",
  );
  const nativeTokenGateway_core = await nativeTokenGatewayFactory.deploy(VWBNB_CORE);

  return {
    usdt_core,
    comptroller_core,
    vusdt_core,
    vwbnb_core,
    nativeTokenGateway_core,
  };
}

// IL Pool Configurations

const ADMIN_IL = "0x285960C5B22fD66A736C7136967A3eB15e93CC67";
const COMPTROLLER_ADDRESS_IL = "0x687a01ecF6d3907658f7A7c714749fAC32336D1B";
const VWETH_IL = "0x7c8ff7d2A1372433726f879BD945fFb250B94c65";
const USDT_IL = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const VUSDT_IL = "0x8C3e3821259B82fFb32B2450A95d2dcbf161C24E";

const USER1_IL = "0xf89d7b9c864f589bbF53a82105107622B35EaA40";
const USER2_IL = "0x974CaA59e49682CdA0AD2bbe82983419A2ECC400";
const BLOCK_NUMBER_ETHEREUM = 19781700;

async function configureTimeLockIL() {
  impersonatedTimeLock_il = await initMainnetUser(ADMIN_IL, ethers.utils.parseUnits("2"));
}

let user1_il: Signer;
let user2_il: Signer;
let impersonatedTimeLock_il: Signer;
let comptroller_il: Comptroller;
let vweth_il: VToken;
let usdt_il: ERC20;
let vusdt_il: VToken;
let nativeTokenGateway_il: NativeTokenGateway;

async function setupIL() {
  await configureTimeLockIL();

  user1_il = await initMainnetUser(USER1_IL, ethers.utils.parseEther("100"));
  user2_il = await initMainnetUser(USER2_IL, ethers.utils.parseEther("100"));

  usdt_il = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/ERC20.sol:ERC20", USDT_IL);

  const comptroller_il = await ethers.getContractAt("Comptroller", COMPTROLLER_ADDRESS_IL);

  vusdt_il = await ethers.getContractAt("@venusprotocol/isolated-pools/contracts/VToken.sol:VToken", VUSDT_IL);
  vweth_il = await ethers.getContractAt("@venusprotocol/isolated-pools/contracts/VToken.sol:VToken", VWETH_IL);

  await comptroller_il
    .connect(impersonatedTimeLock_il)
    .setMarketSupplyCaps([VUSDT_IL, VWETH_IL], [parseUnits("10000", 18), parseUnits("10000", 18)]);

  await comptroller_il.connect(user1_il).enterMarkets([vusdt_il.address, vweth_il.address]);
  await comptroller_il.connect(user2_il).enterMarkets([vusdt_il.address, vweth_il.address]);

  const nativeTokenGatewayFactory = await ethers.getContractFactory(
    "contracts/Gateway/NativeTokenGateway.sol:NativeTokenGateway",
  );
  const nativeTokenGateway_il = await nativeTokenGatewayFactory.deploy(VWETH_IL);

  return {
    usdt_il,
    comptroller_il,
    vusdt_il,
    vweth_il,
    nativeTokenGateway_il,
  };
}

// Core
if (FORK && FORKED_NETWORK === "bsctestnet") {
  describe("Core Pool's NativeTokenGateway", async () => {
    const supplyAmount = parseUnits("10", 18);
    beforeEach("setup", async () => {
      await setForkBlock(BLOCK_NUMBER_BNB);
      ({ usdt_core, comptroller_core, vusdt_core, nativeTokenGateway_core } = await setupCore());
    });

    describe("wrapAndSupply", () => {
      it("should wrap and supply bnb", async () => {
        const balanceBeforeSupplying = await vwbnb_core.balanceOf(await user1_core.getAddress());

        const tx = await nativeTokenGateway_core
          .connect(user1_core)
          .wrapAndSupply(await user1_core.getAddress(), { value: supplyAmount });
        const balanceAfterSupplying = await vwbnb_core.balanceOf(await user1_core.getAddress());
        await expect(balanceAfterSupplying.sub(balanceBeforeSupplying).toString()).to.closeTo(
          parseUnits("10", 8),
          parseUnits("1", 7),
        );
        await expect(tx).to.changeEtherBalances([user1_core], [supplyAmount.mul(-1)]);
      });
    });

    describe("redeemUnderlyingAndUnwrap", () => {
      beforeEach(async () => {
        await nativeTokenGateway_core
          .connect(user1_core)
          .wrapAndSupply(await user1_core.getAddress(), { value: supplyAmount });
      });

      it("should redeem underlying tokens and unwrap and send it to the user", async () => {
        const redeemAmount = parseUnits("10", 18);
        await comptroller_core.connect(user1_core).updateDelegate(nativeTokenGateway_core.address, true);

        const bnbBalanceBefore = await user1_core.getBalance();
        await nativeTokenGateway_core.connect(user1_core).redeemUnderlyingAndUnwrap(redeemAmount);
        const bnbBalanceAfter = await user1_core.getBalance();

        await expect(bnbBalanceAfter.sub(bnbBalanceBefore)).to.closeTo(redeemAmount, parseUnits("1", 16));

        expect(await vwbnb_core.balanceOf(await user1_core.getAddress())).to.closeTo(0, 10);
      });
    });

    describe("redeemAndUnwrap", () => {
      beforeEach(async () => {
        await nativeTokenGateway_core
          .connect(user1_core)
          .wrapAndSupply(await user1_core.getAddress(), { value: supplyAmount });
      });

      it("should redeem vTokens and unwrap and send it to the user", async () => {
        const redeemTokens = await vwbnb_core.balanceOf(await user1_core.getAddress());
        await comptroller_core.connect(user1_core).updateDelegate(nativeTokenGateway_core.address, true);

        const bnbBalanceBefore = await user1_core.getBalance();
        await nativeTokenGateway_core.connect(user1_core).redeemAndUnwrap(redeemTokens);
        const bnbBalanceAfter = await user1_core.getBalance();

        await expect(bnbBalanceAfter.sub(bnbBalanceBefore)).to.closeTo(parseUnits("10", 18), parseUnits("1", 16));
        expect(await vwbnb_core.balanceOf(await user1_core.getAddress())).to.eq(0);
      });
    });

    describe("borrowAndUnwrap", () => {
      beforeEach(async () => {
        await nativeTokenGateway_core
          .connect(user1_core)
          .wrapAndSupply(await user1_core.getAddress(), { value: supplyAmount });
      });

      it("should borrow and unwrap wbnb and send it to borrower", async () => {
        await nativeTokenGateway_core
          .connect(user1_core)
          .wrapAndSupply(await user1_core.getAddress(), { value: supplyAmount });
        await usdt_core.connect(user2_core).approve(vusdt_core.address, parseUnits("5000", 6));
        await vusdt_core.connect(user2_core).mint(parseUnits("500", 6));

        await comptroller_core.connect(user2_core).updateDelegate(nativeTokenGateway_core.address, true);

        const borrowAmount = parseUnits("2", 6);

        const tx = await nativeTokenGateway_core.connect(user2_core).borrowAndUnwrap(borrowAmount);

        await expect(tx).to.changeEtherBalances([user2_core], [borrowAmount]);
      });
    });

    describe("wrapAndRepay", () => {
      beforeEach(async () => {
        await nativeTokenGateway_core
          .connect(user1_core)
          .wrapAndSupply(await user1_core.getAddress(), { value: supplyAmount });
      });

      it("should wrap and repay", async () => {
        const borrowAmount = parseUnits("0.2", 18);
        const repayAmount = parseUnits("0.2", 18);
        await usdt_core.connect(user2_core).approve(vusdt_core.address, parseUnits("500", 6));
        await vusdt_core.connect(user2_core).mint(parseUnits("500", 6));

        await vwbnb_core.connect(user2_core).borrow(borrowAmount);
        const bnbBalanceBefore = await user2_core.getBalance();
        await nativeTokenGateway_core.connect(user2_core).wrapAndRepay({ value: repayAmount });
        const bnbBalanceAfter = await user2_core.getBalance();

        expect(bnbBalanceBefore.sub(bnbBalanceAfter)).to.closeTo(borrowAmount, parseUnits("1", 18));
        expect(await vwbnb_core.balanceOf(await user1_core.getAddress())).to.gt(0);
      });
    });
  });
}

if (FORK && FORKED_NETWORK === "ethereum") {
  describe("Isolated Pool's NativeTokenGateway", async () => {
    const supplyAmount = parseUnits("10", 18);
    beforeEach("setup", async () => {
      await setForkBlock(BLOCK_NUMBER_ETHEREUM);
      ({ usdt_il, comptroller_il, vusdt_il, nativeTokenGateway_il } = await setupIL());
    });

    describe("wrapAndSupply", () => {
      it("should wrap and supply eth", async () => {
        const balanceBeforeSupplying = await vweth_il.balanceOf(await user1_il.getAddress());
        const tx = await nativeTokenGateway_il
          .connect(user1_il)
          .wrapAndSupply(await user1_il.getAddress(), { value: supplyAmount });
        const balanceAfterSupplying = await vweth_il.balanceOf(await user1_il.getAddress());
        await expect(balanceAfterSupplying.sub(balanceBeforeSupplying).toString()).to.closeTo(
          parseUnits("10", 8),
          parseUnits("1", 7),
        );
        await expect(tx).to.changeEtherBalances([user1_il], [supplyAmount.mul(-1)]);
      });
    });

    describe("redeemUnderlyingAndUnwrap", () => {
      beforeEach(async () => {
        await nativeTokenGateway_il
          .connect(user1_il)
          .wrapAndSupply(await user1_il.getAddress(), { value: supplyAmount });
      });

      it("should redeem underlying tokens and unwrap and send it to the user", async () => {
        const redeemAmount = parseUnits("10", 18);
        await comptroller_il.connect(user1_il).updateDelegate(nativeTokenGateway_il.address, true);

        const ethBalanceBefore = await user1_il.getBalance();
        await nativeTokenGateway_il.connect(user1_il).redeemUnderlyingAndUnwrap(redeemAmount);
        const ethBalanceAfter = await user1_il.getBalance();

        await expect(ethBalanceAfter.sub(ethBalanceBefore)).to.closeTo(redeemAmount, parseUnits("1", 16));

        expect(await vweth_il.balanceOf(await user1_il.getAddress())).to.closeTo(0, 10);
      });
    });

    describe("redeemAndUnwrap", () => {
      beforeEach(async () => {
        await nativeTokenGateway_il
          .connect(user1_il)
          .wrapAndSupply(await user1_il.getAddress(), { value: supplyAmount });
      });

      it("should redeem vTokens and unwrap and send it to the user", async () => {
        const redeemTokens = await vweth_il.balanceOf(await user1_il.getAddress());
        await comptroller_il.connect(user1_il).updateDelegate(nativeTokenGateway_il.address, true);

        const ethBalanceBefore = await user1_il.getBalance();
        await nativeTokenGateway_il.connect(user1_il).redeemAndUnwrap(redeemTokens);
        const ethBalanceAfter = await user1_il.getBalance();

        await expect(ethBalanceAfter.sub(ethBalanceBefore)).to.closeTo(parseUnits("10", 18), parseUnits("1", 16));
        expect(await vweth_il.balanceOf(await user1_il.getAddress())).to.eq(0);
      });
    });

    describe("borrowAndUnwrap", () => {
      beforeEach(async () => {
        await nativeTokenGateway_il
          .connect(user1_il)
          .wrapAndSupply(await user1_il.getAddress(), { value: supplyAmount });
      });

      it("should borrow and unwrap weth and send it to borrower", async () => {
        await nativeTokenGateway_il
          .connect(user1_il)
          .wrapAndSupply(await user1_il.getAddress(), { value: supplyAmount });
        await usdt_il.connect(user2_il).approve(vusdt_il.address, parseUnits("5000", 6));

        await vusdt_il.connect(user2_il).mint(parseUnits("5000", 6));

        await comptroller_il.connect(user2_il).updateDelegate(nativeTokenGateway_il.address, true);

        const borrowAmount = parseUnits("2", 6);
        const tx = await nativeTokenGateway_il.connect(user2_il).borrowAndUnwrap(borrowAmount);

        await expect(tx).to.changeEtherBalances([user2_il], [borrowAmount]);
      });
    });

    describe("wrapAndRepay", () => {
      it("should wrap and repay", async () => {
        const borrowAmount = parseUnits("1", 18);
        const repayAmount = parseUnits("10", 18);
        await usdt_il.connect(user2_il).approve(vusdt_il.address, parseUnits("5000", 6));
        await vusdt_il.connect(user2_il).mint(parseUnits("5000", 6));
        await vweth_il.connect(user2_il).borrow(borrowAmount);

        const ethBalanceBefore = await user2_il.getBalance();
        await nativeTokenGateway_il.connect(user2_il).wrapAndRepay({ value: repayAmount });
        const ethBalanceAfter = await user2_il.getBalance();

        expect(ethBalanceBefore.sub(ethBalanceAfter)).to.closeTo(borrowAmount, parseUnits("1", 18));
        expect(await vweth_il.balanceOf(await user1_il.getAddress())).to.eq(0);
      });
    });
  });
}
