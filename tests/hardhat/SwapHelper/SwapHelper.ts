import { expect } from "chai";
import { Signer } from "ethers";
import { parseUnits } from "ethers/lib/utils";
import { ethers } from "hardhat";

import { SwapHelper, WBNB } from "../../../typechain";

describe("SwapHelper", () => {
  let user1: Signer;
  let userAddress: string;
  let swapHelper: SwapHelper;
  let wBNB: WBNB;

  beforeEach(async () => {
    [user1] = await ethers.getSigners();
    userAddress = await user1.getAddress();

    const WBNBFactory = await ethers.getContractFactory("WBNB");
    wBNB = await WBNBFactory.deploy();

    const SwapHelperFactory = await ethers.getContractFactory("SwapHelper");
    swapHelper = await SwapHelperFactory.deploy(wBNB.address);
  });

  it("should wrap native BNB into WBNB", async () => {
    const amount = parseUnits("1", 18);
    expect(await wBNB.balanceOf(userAddress)).to.equal(0);
    const wrapData = await swapHelper.populateTransaction.wrap(amount);
    expect(await swapHelper.connect(user1).multicall([wrapData.data!], { value: amount }));
    expect(await wBNB.balanceOf(swapHelper.address)).to.equal(amount);
  });

  it("should wrap and transfer all in a single call", async () => {
    const amount = parseUnits("1", 18);
    expect(await wBNB.balanceOf(userAddress)).to.equal(0);
    const wrapData = await swapHelper.populateTransaction.wrap(amount);
    const sweepData = await swapHelper.populateTransaction.sweep(wBNB.address, userAddress);
    expect(await swapHelper.connect(user1).multicall([wrapData.data!, sweepData.data!], { value: amount }));
    expect(await wBNB.balanceOf(swapHelper.address)).to.equal(0);
    expect(await wBNB.balanceOf(userAddress)).to.equal(amount);
  });
});
