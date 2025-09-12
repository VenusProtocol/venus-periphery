import { expect } from "chai";
import { Signer } from "ethers";
import { parseUnits } from "ethers/lib/utils";
import { ethers } from "hardhat";

import { ComptrollerHarness, ERC20, NativeTokenGateway, VBep20Delegator } from "../../../typechain";
import { initMainnetUser, setForkBlock } from "./utils";

const ADMIN = "0xce10739590001705F7FF231611ba4A48B2820327";
const COMPTROLLER_ADDRESS = "0x94d1820b2D1c7c7452A163983Dc888CEC546b77D";
const VWBNB = "0xd9E77847ec815E56ae2B9E69596C69b6972b0B1C";
const USDT = "0xA11c8D9DC9b66E209Ef60F0C8D969D3CD988782c";
const VUSDT = "0xb7526572FFE56AB9D7489838Bf2E18e3323b441A";
const USER1 = "0x745bCE0D540AbE9cB639b6eACb5f6Ded3Cf947C9";
const USER2 = "0xbEe5b9859B03FEefd5Ae3ce7C5d92f3b09a55149";
const BLOCK_NUMBER = 64998882;

async function configureTimeLock() {
  impersonatedTimeLock = await initMainnetUser(ADMIN, ethers.utils.parseUnits("2"));
}

const FORK = process.env.FORK === "true";
const FORKED_NETWORK = process.env.FORKED_NETWORK;

let user1: Signer;
let user2: Signer;
let impersonatedTimeLock: Signer;
let comptroller: ComptrollerHarness;
let vwbnb: VBep20Delegator;
let usdt: ERC20;
let vusdt: VBep20Delegator;
let nativeTokenGateway: NativeTokenGateway;

async function setup() {
  await configureTimeLock();

  user1 = await initMainnetUser(USER1, ethers.utils.parseEther("100"));
  user2 = await initMainnetUser(USER2, ethers.utils.parseEther("100"));

  await ethers.provider.send("hardhat_setBalance", [
    await user1.getAddress(),
    "0x56BC75E2D63100000", // 100 BNB in hex
  ]);
  await ethers.provider.send("hardhat_setBalance", [
    await user2.getAddress(),
    "0x56BC75E2D63100000", // 100 BNB in hex
  ]);

  usdt = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/ERC20.sol:ERC20", USDT);

  const comptroller = await ethers.getContractAt("ComptrollerHarness", COMPTROLLER_ADDRESS);

  vusdt = await ethers.getContractAt("VBep20Delegator", VUSDT);
  vwbnb = await ethers.getContractAt("VBep20Delegator", VWBNB);

  await comptroller.connect(impersonatedTimeLock)._supportMarket(vwbnb.address);

  await comptroller
    .connect(impersonatedTimeLock)
    ._setMarketSupplyCaps([VUSDT, VWBNB], [parseUnits("100000000000", 40), parseUnits("100000000000", 40)]);

  await comptroller
    .connect(impersonatedTimeLock)
    ._setMarketBorrowCaps([VUSDT, VWBNB], [parseUnits("100000000000", 40), parseUnits("100000000000", 40)]);

  await comptroller.connect(user1).enterMarkets([vusdt.address, vwbnb.address]);
  await comptroller.connect(user2).enterMarkets([vusdt.address, vwbnb.address]);

  const nativeTokenGatewayFactory = await ethers.getContractFactory(
    "contracts/Gateway/NativeTokenGatewayCore.sol:NativeTokenGateway",
  );
  const nativeTokenGateway = await nativeTokenGatewayFactory.deploy(VWBNB);

  return {
    usdt,
    comptroller,
    vusdt,
    vwbnb,
    nativeTokenGateway,
  };
}

if (FORK && FORKED_NETWORK === "bsctestnet") {
  describe("NativeTokenGateway", async () => {
    const supplyAmount = parseUnits("10", 18);
    beforeEach("setup", async () => {
      await setForkBlock(BLOCK_NUMBER);
      ({ usdt, comptroller, vusdt, nativeTokenGateway } = await setup());
    });

    describe("wrapAndSupply", () => {
      it("should wrap and supply bnb", async () => {
        const balanceBeforeSupplying = await vwbnb.balanceOf(await user1.getAddress());

        const tx = await nativeTokenGateway
          .connect(user1)
          .wrapAndSupply(await user1.getAddress(), { value: supplyAmount });
        const balanceAfterSupplying = await vwbnb.balanceOf(await user1.getAddress());
        await expect(balanceAfterSupplying.sub(balanceBeforeSupplying).toString()).to.closeTo(
          parseUnits("10", 8),
          parseUnits("1", 7),
        );
        await expect(tx).to.changeEtherBalances([user1], [supplyAmount.mul(-1)]);
      });
    });

    describe("redeemUnderlyingAndUnwrap", () => {
      beforeEach(async () => {
        await nativeTokenGateway.connect(user1).wrapAndSupply(await user1.getAddress(), { value: supplyAmount });
      });

      it("should redeem underlying tokens and unwrap and send it to the user", async () => {
        const redeemAmount = parseUnits("10", 18);
        await comptroller.connect(user1).updateDelegate(nativeTokenGateway.address, true);

        const bnbBalanceBefore = await user1.getBalance();
        await nativeTokenGateway.connect(user1).redeemUnderlyingAndUnwrap(redeemAmount);
        const bnbBalanceAfter = await user1.getBalance();

        await expect(bnbBalanceAfter.sub(bnbBalanceBefore)).to.closeTo(redeemAmount, parseUnits("1", 16));

        expect(await vwbnb.balanceOf(await user1.getAddress())).to.closeTo(0, 10);
      });
    });

    describe("redeemAndUnwrap", () => {
      beforeEach(async () => {
        await nativeTokenGateway.connect(user1).wrapAndSupply(await user1.getAddress(), { value: supplyAmount });
      });

      it("should redeem vTokens and unwrap and send it to the user", async () => {
        const redeemTokens = await vwbnb.balanceOf(await user1.getAddress());
        await comptroller.connect(user1).updateDelegate(nativeTokenGateway.address, true);

        const bnbBalanceBefore = await user1.getBalance();
        await nativeTokenGateway.connect(user1).redeemAndUnwrap(redeemTokens);
        const bnbBalanceAfter = await user1.getBalance();

        await expect(bnbBalanceAfter.sub(bnbBalanceBefore)).to.closeTo(parseUnits("10", 18), parseUnits("1", 16));
        expect(await vwbnb.balanceOf(await user1.getAddress())).to.eq(0);
      });
    });

    describe("borrowAndUnwrap", () => {
      beforeEach(async () => {
        await nativeTokenGateway.connect(user1).wrapAndSupply(await user1.getAddress(), { value: supplyAmount });
      });

      it("should borrow and unwrap wbnb and send it to borrower", async () => {
        await nativeTokenGateway.connect(user1).wrapAndSupply(await user1.getAddress(), { value: supplyAmount });
        await usdt.connect(user2).approve(vusdt.address, parseUnits("5000", 6));
        await vusdt.connect(user2).mint(parseUnits("500", 6));

        await comptroller.connect(user2).updateDelegate(nativeTokenGateway.address, true);

        const borrowAmount = parseUnits("2", 6);

        const tx = await nativeTokenGateway.connect(user2).borrowAndUnwrap(borrowAmount);

        await expect(tx).to.changeEtherBalances([user2], [borrowAmount]);
      });
    });

    describe("wrapAndRepay", () => {
      beforeEach(async () => {
        await nativeTokenGateway.connect(user1).wrapAndSupply(await user1.getAddress(), { value: supplyAmount });
      });

      it("should wrap and repay", async () => {
        const borrowAmount = parseUnits("0.2", 18);
        const repayAmount = parseUnits("0.2", 18);
        await usdt.connect(user2).approve(vusdt.address, parseUnits("5000", 6));
        await vusdt.connect(user2).mint(parseUnits("500", 6));

        await vwbnb.connect(user2).borrow(borrowAmount);
        const bnbBalanceBefore = await user2.getBalance();
        await nativeTokenGateway.connect(user2).wrapAndRepay({ value: repayAmount });
        const bnbBalanceAfter = await user2.getBalance();

        expect(bnbBalanceBefore.sub(bnbBalanceAfter)).to.closeTo(borrowAmount, parseUnits("1", 18));
        expect(await vwbnb.balanceOf(await user1.getAddress())).to.gt(0);
      });
    });
  });
}
