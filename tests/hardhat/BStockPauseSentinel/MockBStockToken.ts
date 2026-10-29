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

  it("blocks transfers involving a blocked account and reports the block like a bStock's compliance module", async () => {
    const [owner, alice, bob] = await ethers.getSigners();
    const token = (await (await ethers.getContractFactory("MockBStockToken")).deploy("Mock", "MCK")) as MockBStockToken;
    await token.faucet(100);
    await token.transfer(alice.address, 10);

    expect(await token.compliance()).to.equal(token.address);
    await token.checkIsCompliant(token.address, alice.address);

    await expect(token.connect(alice).setBlocked(alice.address, true)).to.be.revertedWith(
      "Ownable: caller is not the owner",
    );
    await expect(token.setBlocked(alice.address, true)).to.emit(token, "BlockedSet").withArgs(alice.address, true);
    await expect(token.checkIsCompliant(token.address, alice.address)).to.be.revertedWithCustomError(
      token,
      "UserBlocked",
    );
    await token.checkIsCompliant(bob.address, alice.address);

    await expect(token.transfer(alice.address, 1)).to.be.revertedWithCustomError(token, "UserBlocked");
    await expect(token.connect(alice).transfer(bob.address, 1)).to.be.revertedWithCustomError(token, "UserBlocked");
    await token.connect(alice).approve(owner.address, 1);
    await expect(token.transferFrom(alice.address, bob.address, 1)).to.be.revertedWithCustomError(token, "UserBlocked");
    await token.transfer(bob.address, 1);

    await token.setBlocked(alice.address, false);
    await token.connect(alice).transfer(bob.address, 1);
    expect(await token.balanceOf(bob.address)).to.equal(2);
  });
});
