import { expect } from "chai";
import { ethers } from "hardhat";

import { MockBStockToken } from "../../../typechain";

describe("MockBStockToken", () => {
  it("blocks transfers and mints while paused and reports the pause like a bStock", async () => {
    const [owner, alice] = await ethers.getSigners();
    const token = (await (await ethers.getContractFactory("MockBStockToken")).deploy("Mock", "MCK")) as MockBStockToken;
    await token.faucet(100);

    expect(await token.pauseManager()).to.equal(token.address);
    expect(await token.isTokenPaused(token.address)).to.equal(false);

    await expect(token.connect(alice).setPaused(true)).to.be.revertedWith("Ownable: caller is not the owner");
    await token.setPaused(true);
    expect(await token.isTokenPaused(token.address)).to.equal(true);
    expect(await token.isTokenPaused(alice.address)).to.equal(false);
    await expect(token.transfer(alice.address, 1)).to.be.revertedWithCustomError(token, "TokenPaused");
    await expect(token.connect(alice).faucet(1)).to.be.revertedWithCustomError(token, "TokenPaused");

    await token.setPaused(false);
    await token.transfer(alice.address, 1);
    expect(await token.balanceOf(alice.address)).to.equal(1);
    expect(owner.address).to.equal(await token.owner());
  });
});
