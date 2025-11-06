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
  let ownerAddress: string;
  let userAddress: string;
  let user2Address: string;
  let swapHelper: SwapHelper;
  let wBNB: WBNB;
  let erc20: FaucetToken;

  beforeEach(async () => {
    [owner, user1, user2] = await ethers.getSigners();
    ownerAddress = await owner.getAddress();
    userAddress = await user1.getAddress();
    user2Address = await user2.getAddress();

    const WBNBFactory = await ethers.getContractFactory("WBNB");
    wBNB = await WBNBFactory.deploy();

    const ERC20Factory = await ethers.getContractFactory("FaucetToken");
    erc20 = await ERC20Factory.deploy(parseUnits("10000", 18), "Test Token", 18, "TEST");

    const SwapHelperFactory = await ethers.getContractFactory("SwapHelper");
    swapHelper = await SwapHelperFactory.deploy(wBNB.address, await owner.getAddress());
  });

  describe("constructor", () => {
    it("should revert when wrappedNative is zero address", async () => {
      const SwapHelperFactory = await ethers.getContractFactory("SwapHelper");
      await expect(SwapHelperFactory.deploy(ethers.constants.AddressZero, ownerAddress)).to.be.revertedWithCustomError(
        swapHelper,
        "ZeroAddress",
      );
    });

    it("should revert when backendSigner is zero address", async () => {
      const SwapHelperFactory = await ethers.getContractFactory("SwapHelper");
      await expect(SwapHelperFactory.deploy(wBNB.address, ethers.constants.AddressZero)).to.be.revertedWithCustomError(
        swapHelper,
        "ZeroAddress",
      );
    });
  });

  describe("ownership", () => {
    it("should set initial owner correctly", async () => {
      expect(await swapHelper.owner()).to.equal(ownerAddress);
    });

    it("should allow owner to transfer ownership", async () => {
      await swapHelper.connect(owner).transferOwnership(userAddress);
      expect(await swapHelper.owner()).to.equal(userAddress);
    });

    it("should prevent non-owner from transferring ownership", async () => {
      await expect(swapHelper.connect(user1).transferOwnership(user2Address)).to.be.reverted;
    });
  });

  describe("setBackendSigner", () => {
    it("should allow owner to change backend signer", async () => {
      const newSigner = userAddress;
      expect(await swapHelper.backendSigner()).to.equal(ownerAddress);

      const tx = await swapHelper.connect(owner).setBackendSigner(newSigner);
      await expect(tx).to.emit(swapHelper, "BackendSignerUpdated").withArgs(ownerAddress, newSigner);

      expect(await swapHelper.backendSigner()).to.equal(newSigner);
    });

    it("should prevent non-owner from changing backend signer", async () => {
      await expect(swapHelper.connect(user1).setBackendSigner(userAddress)).to.be.reverted;
    });

    it("should revert when setting zero address as backend signer", async () => {
      await expect(
        swapHelper.connect(owner).setBackendSigner(ethers.constants.AddressZero),
      ).to.be.revertedWithCustomError(swapHelper, "ZeroAddress");
    });
  });

  describe("wrap", () => {
    it("should only work within multicall", async () => {
      const amount = parseUnits("1", 18);
      expect(await wBNB.balanceOf(userAddress)).to.equal(0);
      const wrapData = await swapHelper.populateTransaction.wrap(amount);
      await swapHelper
        .connect(user1)
        .multicall([wrapData.data!], maxUint256, ethers.utils.formatBytes32String("1"), "0x", { value: amount });
      expect(await wBNB.balanceOf(swapHelper.address)).to.equal(amount);
    });
  });

  describe("sweep", () => {
    it("should sweep ERC20 tokens to specified address", async () => {
      const amount = parseUnits("1000", 18);
      await erc20.connect(owner).transfer(swapHelper.address, amount);
      expect(await erc20.balanceOf(swapHelper.address)).to.equal(amount);
      expect(await erc20.balanceOf(userAddress)).to.equal(0);

      await swapHelper.connect(owner).sweep(erc20.address, userAddress);
      expect(await erc20.balanceOf(swapHelper.address)).to.equal(0);
      expect(await erc20.balanceOf(userAddress)).to.equal(amount);
    });

    it("should revert if called by non-owner outside multicall", async () => {
      const amount = parseUnits("1000", 18);
      await erc20.connect(owner).transfer(swapHelper.address, amount);
      await expect(swapHelper.connect(user1).sweep(erc20.address, userAddress)).to.be.revertedWithCustomError(
        swapHelper,
        "CallerNotAuthorized",
      );
    });

    it("should work within multicall", async () => {
      const amount = parseUnits("1000", 18);
      await erc20.connect(owner).transfer(swapHelper.address, amount);
      const sweepData = await swapHelper.populateTransaction.sweep(erc20.address, userAddress);
      await swapHelper
        .connect(user1)
        .multicall([sweepData.data!], maxUint256, ethers.utils.formatBytes32String("1"), "0x");
      expect(await erc20.balanceOf(swapHelper.address)).to.equal(0);
      expect(await erc20.balanceOf(userAddress)).to.equal(amount);
    });

    it("should wrap and transfer all in a single call", async () => {
      const amount = parseUnits("1", 18);
      expect(await wBNB.balanceOf(userAddress)).to.equal(0);
      const wrapData = await swapHelper.populateTransaction.wrap(amount);
      const sweepData = await swapHelper.populateTransaction.sweep(wBNB.address, userAddress);
      await swapHelper
        .connect(user1)
        .multicall([wrapData.data!, sweepData.data!], maxUint256, ethers.utils.formatBytes32String("1"), "0x", {
          value: amount,
        });
      expect(await wBNB.balanceOf(swapHelper.address)).to.equal(0);
      expect(await wBNB.balanceOf(userAddress)).to.equal(amount);
    });
  });

  describe("approveMax", () => {
    it("should approve maximum amount to a spender", async () => {
      const spender = user2Address;
      expect(await erc20.allowance(swapHelper.address, spender)).to.equal(0);
      await swapHelper.connect(owner).approveMax(erc20.address, spender);
      expect(await erc20.allowance(swapHelper.address, spender)).to.equal(maxUint256);
    });

    it("should revert if called by non-owner outside multicall", async () => {
      const spender = user2Address;
      await expect(swapHelper.connect(user1).approveMax(erc20.address, spender)).to.be.revertedWithCustomError(
        swapHelper,
        "CallerNotAuthorized",
      );
    });

    it("should work within multicall", async () => {
      const spender = user2Address;
      const approveData = await swapHelper.populateTransaction.approveMax(erc20.address, spender);
      await swapHelper
        .connect(user1)
        .multicall([approveData.data!], maxUint256, ethers.utils.formatBytes32String("1"), "0x");
      expect(await erc20.allowance(swapHelper.address, spender)).to.equal(maxUint256);
    });
  });

  describe("multicall", () => {
    const types = {
      Multicall: [
        { name: "calls", type: "bytes[]" },
        { name: "deadline", type: "uint256" },
        { name: "salt", type: "bytes32" },
      ],
    };

    it("should revert if calls array is empty", async () => {
      const deadline = maxUint256;
      const salt = ethers.utils.formatBytes32String("1");

      await expect(swapHelper.connect(user1).multicall([], deadline, salt, "0x")).to.be.revertedWithCustomError(
        swapHelper,
        "NoCallsProvided",
      );
    });

    it("should emit MulticallExecuted event without signature", async () => {
      const amount = parseUnits("1", 18);
      const wrapData = await swapHelper.populateTransaction.wrap(amount);
      const deadline = maxUint256;
      const salt = ethers.utils.formatBytes32String("1");

      const tx = await swapHelper.connect(user1).multicall([wrapData.data!], deadline, salt, "0x", { value: amount });

      await expect(tx).to.emit(swapHelper, "MulticallExecuted").withArgs(userAddress, 1, deadline, false);
    });

    it("should emit MulticallExecuted event with signature verification", async () => {
      const domain = {
        chainId: network.config.chainId,
        name: "VenusSwap",
        verifyingContract: swapHelper.address,
        version: "1",
      };
      const amount = parseUnits("1", 18);
      const wrapData = await swapHelper.populateTransaction.wrap(amount);
      const calls = [wrapData.data!];
      const deadline = maxUint256;
      const salt = ethers.utils.formatBytes32String("1");
      const signature = await owner._signTypedData(domain, types, { calls, deadline, salt });

      const tx = await swapHelper.connect(user1).multicall(calls, deadline, salt, signature, { value: amount });

      await expect(tx).to.emit(swapHelper, "MulticallExecuted").withArgs(userAddress, 1, deadline, true);
    });

    it("should emit MulticallExecuted with correct call count", async () => {
      const amount = parseUnits("1", 18);
      const wrapData = await swapHelper.populateTransaction.wrap(amount);
      const deadline = maxUint256;
      const salt = ethers.utils.formatBytes32String("1");

      const tx = await swapHelper
        .connect(user1)
        .multicall([wrapData.data!, wrapData.data!, wrapData.data!], deadline, salt, "0x", { value: amount.mul(3) });

      await expect(tx).to.emit(swapHelper, "MulticallExecuted").withArgs(userAddress, 3, deadline, false);
    });

    it("should revert if deadline is in the past", async () => {
      const amount = parseUnits("1", 18);
      const wrapData = await swapHelper.populateTransaction.wrap(amount);
      const salt = ethers.utils.formatBytes32String("1");
      await expect(
        swapHelper.connect(user1).multicall([wrapData.data!], 1234, salt, "0x", { value: amount }),
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
      const salt = ethers.utils.formatBytes32String("1");
      const signature = await owner._signTypedData(domain, types, { calls, deadline, salt });
      await swapHelper.connect(user1).multicall(calls, deadline, salt, signature, { value: totalAmount });
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
      const salt = ethers.utils.formatBytes32String("1");
      const signature = await owner._signTypedData(domain, types, {
        // authorizing just one call, not 3
        calls: [wrapData.data!],
        deadline,
        salt,
      });
      await expect(
        swapHelper.connect(user1).multicall(
          // trying to execute 3 txs, but only 1 is authorized
          [wrapData.data!, wrapData.data!, wrapData.data!],
          deadline,
          salt,
          signature,
          { value: totalAmount },
        ),
      ).to.be.revertedWithCustomError(swapHelper, "Unauthorized");
    });

    it("should revert if salt is reused", async () => {
      const amount = parseUnits("1", 18);
      const wrapData = await swapHelper.populateTransaction.wrap(amount);
      const deadline = maxUint256;
      const salt = ethers.utils.formatBytes32String("unique");

      // First call should succeed
      await swapHelper.connect(user1).multicall([wrapData.data!], deadline, salt, "0x", { value: amount });

      // Second call with same salt should fail
      await expect(
        swapHelper.connect(user1).multicall([wrapData.data!], deadline, salt, "0x", { value: amount }),
      ).to.be.revertedWithCustomError(swapHelper, "SaltAlreadyUsed");
    });
  });
});
