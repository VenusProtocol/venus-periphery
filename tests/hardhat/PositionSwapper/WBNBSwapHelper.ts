import { expect } from "chai";
import { Signer } from "ethers";
import { parseUnits } from "ethers/lib/utils";
import { ethers } from "hardhat";

import { WBNB, WBNBSwapHelper } from "../../../typechain";

describe("WBNBSwapHelper", () => {
  let user1: Signer;
  let positionSwapper: Signer;
  let wbnbSwapHelper: WBNBSwapHelper;
  let WBNB: WBNB;

  beforeEach(async () => {
    [user1, positionSwapper] = await ethers.getSigners();

    const WBNBFactory = await ethers.getContractFactory("WBNB");
    WBNB = await WBNBFactory.deploy();

    const WBNBSwapHelperFactory = await ethers.getContractFactory("WBNBSwapHelper");
    wbnbSwapHelper = await WBNBSwapHelperFactory.deploy(WBNB.address, await positionSwapper.getAddress());
  });

  it("should wrap native BNB into WBNB and transfer to PositionSwapper", async () => {
    const amount = parseUnits("1", 18);
    await expect(await WBNB.balanceOf(await positionSwapper.getAddress())).to.equals(0);
    await expect(
      wbnbSwapHelper
        .connect(positionSwapper)
        .swapInternal(ethers.constants.AddressZero, ethers.constants.AddressZero, amount, { value: amount }),
    )
      .to.emit(wbnbSwapHelper, "SwappedToWBNB")
      .withArgs(amount);
    await expect(await WBNB.balanceOf(await positionSwapper.getAddress())).to.equals(amount);
  });

  it("should unwrap WBNB into native BNB and transfer to PositionSwapper", async () => {
    const amount = parseUnits("1", 18);
    await WBNB.connect(positionSwapper).deposit({ value: amount });
    await WBNB.connect(positionSwapper).approve(wbnbSwapHelper.address, amount);

    await expect(await WBNB.balanceOf(await positionSwapper.getAddress())).to.equals(amount);
    const prevBNBBalance = await ethers.provider.getBalance(await positionSwapper.getAddress());
    await expect(
      wbnbSwapHelper.connect(positionSwapper).swapInternal(WBNB.address, ethers.constants.AddressZero, amount),
    )
      .to.emit(wbnbSwapHelper, "SwappedToBNB")
      .withArgs(amount);
    const newBNBBalance = await ethers.provider.getBalance(await positionSwapper.getAddress());
    expect(newBNBBalance.sub(prevBNBBalance)).to.be.closeTo(amount, parseUnits("0.001", 18)); // Allow for minor gas cost variations
    await expect(await WBNB.balanceOf(await positionSwapper.getAddress())).to.equals(0);
  });

  it("should revert if sent value does not match amount", async () => {
    const amount = parseUnits("1", 18);
    const mismatchedValue = parseUnits("0.5", 18);

    await expect(
      wbnbSwapHelper
        .connect(positionSwapper)
        .swapInternal(ethers.constants.AddressZero, ethers.constants.AddressZero, amount, { value: mismatchedValue }),
    ).to.be.revertedWithCustomError(wbnbSwapHelper, "ValueMismatch");
  });

  it("should revert if caller is not PositionSwapper", async () => {
    const amount = parseUnits("1", 18);

    await expect(
      wbnbSwapHelper
        .connect(user1)
        .swapInternal(ethers.constants.AddressZero, ethers.constants.AddressZero, amount, { value: amount }),
    ).to.be.revertedWithCustomError(wbnbSwapHelper, "Unauthorized");
  });
});
