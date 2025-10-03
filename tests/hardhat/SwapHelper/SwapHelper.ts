import { expect } from "chai";
import { Signer } from "ethers";
import { _TypedDataEncoder, parseUnits } from "ethers/lib/utils";
import { ethers, network } from "hardhat";

import { FaucetToken, SwapHelper, WBNB } from "../../../typechain";

describe("SwapHelper", () => {
  const maxUint256 = ethers.constants.MaxUint256;
  let owner: Signer;
  let user1: Signer;
  let user2: Signer;
  let userAddress: string;
  let user2Address: string;
  let swapHelper: SwapHelper;
  let wBNB: WBNB;
  let erc20: FaucetToken;

  beforeEach(async () => {
    [owner, user1, user2] = await ethers.getSigners();
    userAddress = await user1.getAddress();
    user2Address = await user2.getAddress();

    const WBNBFactory = await ethers.getContractFactory("WBNB");
    wBNB = await WBNBFactory.deploy();

    const ERC20Factory = await ethers.getContractFactory("FaucetToken");
    erc20 = await ERC20Factory.deploy(parseUnits("10000", 18), "Test Token", 18, "TEST");

    const SwapHelperFactory = await ethers.getContractFactory("SwapHelper");
    swapHelper = await SwapHelperFactory.deploy(wBNB.address, await owner.getAddress());
  });

  describe("wrap", () => {
    it("should only work within multicall", async () => {
      const amount = parseUnits("1", 18);
      expect(await wBNB.balanceOf(userAddress)).to.equal(0);
      const wrapData = await swapHelper.populateTransaction.wrap(amount);
      await swapHelper.connect(user1).multicall([wrapData.data!], maxUint256, "0x", { value: amount });
      expect(await wBNB.balanceOf(swapHelper.address)).to.equal(amount);
    });
  });

  describe("sweep", () => {
    it("should sweep ERC20 tokens to specified address", async () => {
      const amount = parseUnits("1000", 18);
      await erc20.connect(owner).transfer(swapHelper.address, amount);
      expect(await erc20.balanceOf(swapHelper.address)).to.equal(amount);
      expect(await erc20.balanceOf(userAddress)).to.equal(0);

      await swapHelper.connect(user1).sweep(erc20.address, userAddress);
      expect(await erc20.balanceOf(swapHelper.address)).to.equal(0);
      expect(await erc20.balanceOf(userAddress)).to.equal(amount);
    });

    it("should work within multicall", async () => {
      const amount = parseUnits("1000", 18);
      await erc20.connect(owner).transfer(swapHelper.address, amount);
      const sweepData = await swapHelper.populateTransaction.sweep(erc20.address, userAddress);
      await swapHelper.connect(user1).multicall([sweepData.data!], maxUint256, "0x");
      expect(await erc20.balanceOf(swapHelper.address)).to.equal(0);
      expect(await erc20.balanceOf(userAddress)).to.equal(amount);
    });

    it("should wrap and transfer all in a single call", async () => {
      const amount = parseUnits("1", 18);
      expect(await wBNB.balanceOf(userAddress)).to.equal(0);
      const wrapData = await swapHelper.populateTransaction.wrap(amount);
      const sweepData = await swapHelper.populateTransaction.sweep(wBNB.address, userAddress);
      await swapHelper.connect(user1).multicall([wrapData.data!, sweepData.data!], maxUint256, "0x", { value: amount });
      expect(await wBNB.balanceOf(swapHelper.address)).to.equal(0);
      expect(await wBNB.balanceOf(userAddress)).to.equal(amount);
    });
  });

  describe("approveMax", () => {
    it("should approve maximum amount to a spender", async () => {
      const spender = user2Address;
      expect(await erc20.allowance(swapHelper.address, spender)).to.equal(0);
      await swapHelper.connect(user1).approveMax(erc20.address, spender);
      expect(await erc20.allowance(swapHelper.address, spender)).to.equal(maxUint256);
    });

    it("should work within multicall", async () => {
      const spender = user2Address;
      const approveData = await swapHelper.populateTransaction.approveMax(erc20.address, spender);
      await swapHelper.connect(user1).multicall([approveData.data!], maxUint256, "0x");
      expect(await erc20.allowance(swapHelper.address, spender)).to.equal(maxUint256);
    });
  });

  describe("multicall", () => {
    const types = {
      Multicall: [
        { name: "calls", type: "bytes[]" },
        { name: "deadline", type: "uint256" },
      ],
    };

    it("should revert if deadline is in the past", async () => {
      const amount = parseUnits("1", 18);
      const wrapData = await swapHelper.populateTransaction.wrap(amount);
      await expect(
        swapHelper.connect(user1).multicall([wrapData.data!], 1234, "0x", { value: amount }),
      ).to.be.revertedWithCustomError(swapHelper, "DeadlineReached");
    });

    it("should check signature if provided", async () => {
      const domain = {
        chainId: network.config.chainId,
        name: "VenusSwap",
        verifyingContract: swapHelper.address,
        version: "1",
      };
      const singleAmount = parseUnits("1", 18);
      const totalAmount = singleAmount.mul(3);
      const wrapData = await swapHelper.populateTransaction.wrap(singleAmount);
      const calls = [wrapData.data!, wrapData.data!, wrapData.data!];
      const deadline = maxUint256;
      const signature = await owner._signTypedData(domain, types, { calls, deadline });
      await swapHelper.connect(user1).multicall(calls, deadline, signature, { value: totalAmount });
      expect(await wBNB.balanceOf(swapHelper.address)).to.equal(totalAmount);
    });

    it("should revert if the signature is invalid", async () => {
      const domain = {
        chainId: network.config.chainId,
        name: "VenusSwap",
        verifyingContract: swapHelper.address,
        version: "1",
      };
      const singleAmount = parseUnits("1", 18);
      const totalAmount = singleAmount.mul(3);
      const wrapData = await swapHelper.populateTransaction.wrap(singleAmount);
      const deadline = maxUint256;
      const signature = await owner._signTypedData(domain, types, {
        // authorizing just one call, not 3
        calls: [wrapData.data!],
        deadline,
      });
      await expect(
        swapHelper.connect(user1).multicall(
          // trying to execute 3 txs, but only 1 is authorized
          [wrapData.data!, wrapData.data!, wrapData.data!],
          deadline,
          signature,
          { value: totalAmount },
        ),
      ).to.be.revertedWithCustomError(swapHelper, "Unauthorized");
    });
  });
});
