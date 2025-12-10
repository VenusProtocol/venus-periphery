import "@nomicfoundation/hardhat-chai-matchers";
import { expect } from "chai";
import { Signer, Wallet } from "ethers";
import { _TypedDataEncoder, parseUnits } from "ethers/lib/utils";
import { ethers, network } from "hardhat";

import { FaucetToken, SwapHelper } from "../../../typechain";

const { constants } = ethers;

describe("SwapHelper", () => {
  const maxUint256 = constants.MaxUint256;
  let owner: Wallet;
  let user1: Signer;
  let user2: Signer;
  let ownerAddress: string;
  let userAddress: string;
  let user2Address: string;
  let swapHelper: SwapHelper;
  let erc20: FaucetToken;

  beforeEach(async () => {
    const signers = await ethers.getSigners();
    owner = signers[0] as unknown as Wallet;
    user1 = signers[1];
    user2 = signers[2];
    ownerAddress = await owner.getAddress();
    userAddress = await user1.getAddress();
    user2Address = await user2.getAddress();

    const ERC20Factory = await ethers.getContractFactory("FaucetToken");
    erc20 = (await ERC20Factory.deploy(parseUnits("10000", 18), "Test Token", 18, "TEST")) as FaucetToken;

    const SwapHelperFactory = await ethers.getContractFactory("SwapHelper");
    swapHelper = (await SwapHelperFactory.deploy(await owner.getAddress())) as SwapHelper;
  });

  describe("constructor", () => {
    it("should revert when backendSigner is zero address", async () => {
      const SwapHelperFactory = await ethers.getContractFactory("SwapHelper");
      await expect(SwapHelperFactory.deploy(constants.AddressZero)).to.be.revertedWithCustomError(
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
      const domain = {
        chainId: network.config.chainId,
        name: "VenusSwap",
        verifyingContract: swapHelper.address,
        version: "1",
      };
      const types = {
        Multicall: [
          { name: "calls", type: "bytes[]" },
          { name: "deadline", type: "uint256" },
          { name: "salt", type: "bytes32" },
        ],
      };
      const amount = parseUnits("1000", 18);
      await erc20.connect(owner).transfer(swapHelper.address, amount);
      const sweepData = await swapHelper.populateTransaction.sweep(erc20.address, userAddress);
      const calls = [sweepData.data!];
      const deadline = maxUint256;
      const salt = ethers.utils.formatBytes32String("1");
      const signature = await owner._signTypedData(domain, types, { calls, deadline, salt });
      await swapHelper.connect(user1).multicall(calls, deadline, salt, signature);
      expect(await erc20.balanceOf(swapHelper.address)).to.equal(0);
      expect(await erc20.balanceOf(userAddress)).to.equal(amount);
    });

    it("should handle sweep when balance is zero", async () => {
      const balanceBefore = await erc20.balanceOf(userAddress);
      expect(await erc20.balanceOf(swapHelper.address)).to.equal(0);

      await swapHelper.connect(owner).sweep(erc20.address, userAddress);

      expect(await erc20.balanceOf(swapHelper.address)).to.equal(0);
      expect(await erc20.balanceOf(userAddress)).to.equal(balanceBefore);
    });

    it("should emit Swept event", async () => {
      const domain = {
        chainId: network.config.chainId,
        name: "VenusSwap",
        verifyingContract: swapHelper.address,
        version: "1",
      };
      const types = {
        Multicall: [
          { name: "calls", type: "bytes[]" },
          { name: "deadline", type: "uint256" },
          { name: "salt", type: "bytes32" },
        ],
      };
      const amount = parseUnits("1000", 18);
      await erc20.connect(owner).transfer(swapHelper.address, amount);
      const sweepData = await swapHelper.populateTransaction.sweep(erc20.address, userAddress);
      const calls = [sweepData.data!];
      const deadline = maxUint256;
      const salt = ethers.utils.formatBytes32String("2");
      const signature = await owner._signTypedData(domain, types, { calls, deadline, salt });

      await expect(swapHelper.connect(user1).multicall(calls, deadline, salt, signature))
        .to.emit(swapHelper, "Swept")
        .withArgs(erc20.address, userAddress, amount);
    });

    it("should emit Swept event with zero amount when balance is zero", async () => {
      expect(await erc20.balanceOf(swapHelper.address)).to.equal(0);

      await expect(swapHelper.connect(owner).sweep(erc20.address, userAddress))
        .to.emit(swapHelper, "Swept")
        .withArgs(erc20.address, userAddress, 0);
    });
  });

  describe("approveMax", () => {
    it("should approve maximum amount to a spender", async () => {
      const spender = user2Address;
      expect(await erc20.allowance(swapHelper.address, spender)).to.equal(0);
      await swapHelper.connect(owner).approveMax(erc20.address, spender);
      expect(await erc20.allowance(swapHelper.address, spender)).to.equal(maxUint256);
    });

    it("should emit ApprovedMax event", async () => {
      const spender = user2Address;

      await expect(swapHelper.connect(owner).approveMax(erc20.address, spender))
        .to.emit(swapHelper, "ApprovedMax")
        .withArgs(erc20.address, spender);
    });

    it("should revert if called by non-owner outside multicall", async () => {
      const spender = user2Address;
      await expect(swapHelper.connect(user1).approveMax(erc20.address, spender)).to.be.revertedWithCustomError(
        swapHelper,
        "CallerNotAuthorized",
      );
    });

    it("should work within multicall", async () => {
      const domain = {
        chainId: network.config.chainId,
        name: "VenusSwap",
        verifyingContract: swapHelper.address,
        version: "1",
      };
      const types = {
        Multicall: [
          { name: "calls", type: "bytes[]" },
          { name: "deadline", type: "uint256" },
          { name: "salt", type: "bytes32" },
        ],
      };
      const spender = user2Address;
      const approveData = await swapHelper.populateTransaction.approveMax(erc20.address, spender);
      const calls = [approveData.data!];
      const deadline = maxUint256;
      const salt = ethers.utils.formatBytes32String("3");
      const signature = await owner._signTypedData(domain, types, { calls, deadline, salt });
      await swapHelper.connect(user1).multicall(calls, deadline, salt, signature);
      expect(await erc20.allowance(swapHelper.address, spender)).to.equal(maxUint256);
    });
  });

  describe("multicall", () => {
    it("should revert if calls array is empty", async () => {
      const domain = {
        chainId: network.config.chainId,
        name: "VenusSwap",
        verifyingContract: swapHelper.address,
        version: "1",
      };
      const types = {
        Multicall: [
          { name: "calls", type: "bytes[]" },
          { name: "deadline", type: "uint256" },
          { name: "salt", type: "bytes32" },
        ],
      };
      const calls: string[] = [];
      const deadline = maxUint256;
      const salt = ethers.utils.formatBytes32String("4");
      const signature = await owner._signTypedData(domain, types, { calls, deadline, salt });

      await expect(swapHelper.connect(user1).multicall(calls, deadline, salt, signature)).to.be.revertedWithCustomError(
        swapHelper,
        "NoCallsProvided",
      );
    });

    it("should emit MulticallExecuted event", async () => {
      const domain = {
        chainId: network.config.chainId,
        name: "VenusSwap",
        verifyingContract: swapHelper.address,
        version: "1",
      };
      const types = {
        Multicall: [
          { name: "calls", type: "bytes[]" },
          { name: "deadline", type: "uint256" },
          { name: "salt", type: "bytes32" },
        ],
      };
      const sweepData = await swapHelper.populateTransaction.sweep(erc20.address, userAddress);
      const calls = [sweepData.data!];
      const deadline = maxUint256;
      const salt = ethers.utils.formatBytes32String("5");
      const signature = await owner._signTypedData(domain, types, { calls, deadline, salt });

      const tx = await swapHelper.connect(user1).multicall(calls, deadline, salt, signature);

      await expect(tx).to.emit(swapHelper, "MulticallExecuted").withArgs(userAddress, 1, deadline, salt);
    });

    it("should emit MulticallExecuted with correct call count", async () => {
      const domain = {
        chainId: network.config.chainId,
        name: "VenusSwap",
        verifyingContract: swapHelper.address,
        version: "1",
      };
      const types = {
        Multicall: [
          { name: "calls", type: "bytes[]" },
          { name: "deadline", type: "uint256" },
          { name: "salt", type: "bytes32" },
        ],
      };
      const sweepData = await swapHelper.populateTransaction.sweep(erc20.address, userAddress);
      const calls = [sweepData.data!, sweepData.data!, sweepData.data!];
      const deadline = maxUint256;
      const salt = ethers.utils.formatBytes32String("6");
      const signature = await owner._signTypedData(domain, types, { calls, deadline, salt });

      const tx = await swapHelper.connect(user1).multicall(calls, deadline, salt, signature);

      await expect(tx).to.emit(swapHelper, "MulticallExecuted").withArgs(userAddress, 3, deadline, salt);
    });

    it("should revert if deadline is in the past", async () => {
      const domain = {
        chainId: network.config.chainId,
        name: "VenusSwap",
        verifyingContract: swapHelper.address,
        version: "1",
      };
      const types = {
        Multicall: [
          { name: "calls", type: "bytes[]" },
          { name: "deadline", type: "uint256" },
          { name: "salt", type: "bytes32" },
        ],
      };
      const sweepData = await swapHelper.populateTransaction.sweep(erc20.address, userAddress);
      const calls = [sweepData.data!];
      const deadline = 1234;
      const salt = ethers.utils.formatBytes32String("7");
      const signature = await owner._signTypedData(domain, types, { calls, deadline, salt });
      await expect(
        swapHelper.connect(user1).multicall(calls, deadline, salt, signature),
      ).to.be.revertedWithCustomError(swapHelper, "DeadlineReached");
    });

    it("should check signature if provided", async () => {
      const domain = {
        chainId: network.config.chainId,
        name: "VenusSwap",
        verifyingContract: swapHelper.address,
        version: "1",
      };
      const types = {
        Multicall: [
          { name: "calls", type: "bytes[]" },
          { name: "deadline", type: "uint256" },
          { name: "salt", type: "bytes32" },
        ],
      };
      const sweepData = await swapHelper.populateTransaction.sweep(erc20.address, userAddress);
      const calls = [sweepData.data!, sweepData.data!, sweepData.data!];
      const deadline = maxUint256;
      const salt = ethers.utils.formatBytes32String("8");
      const signature = await owner._signTypedData(domain, types, { calls, deadline, salt });
      await swapHelper.connect(user1).multicall(calls, deadline, salt, signature);
      expect(await erc20.balanceOf(swapHelper.address)).to.equal(0);
    });

    it("should revert if the signature is invalid", async () => {
      const domain = {
        chainId: network.config.chainId,
        name: "VenusSwap",
        verifyingContract: swapHelper.address,
        version: "1",
      };
      const types = {
        Multicall: [
          { name: "calls", type: "bytes[]" },
          { name: "deadline", type: "uint256" },
          { name: "salt", type: "bytes32" },
        ],
      };
      const sweepData = await swapHelper.populateTransaction.sweep(erc20.address, userAddress);
      const deadline = maxUint256;
      const salt = ethers.utils.formatBytes32String("9");
      const signature = await owner._signTypedData(domain, types, {
        // authorizing just one call, not 3
        calls: [sweepData.data!],
        deadline,
        salt,
      });
      await expect(
        swapHelper.connect(user1).multicall(
          // trying to execute 3 txs, but only 1 is authorized
          [sweepData.data!, sweepData.data!, sweepData.data!],
          deadline,
          salt,
          signature,
        ),
      ).to.be.revertedWithCustomError(swapHelper, "Unauthorized");
    });

    it("should revert if salt is reused", async () => {
      const domain = {
        chainId: network.config.chainId,
        name: "VenusSwap",
        verifyingContract: swapHelper.address,
        version: "1",
      };
      const types = {
        Multicall: [
          { name: "calls", type: "bytes[]" },
          { name: "deadline", type: "uint256" },
          { name: "salt", type: "bytes32" },
        ],
      };
      const sweepData = await swapHelper.populateTransaction.sweep(erc20.address, userAddress);
      const calls = [sweepData.data!];
      const deadline = maxUint256;
      const salt = ethers.utils.formatBytes32String("10");
      const signature = await owner._signTypedData(domain, types, { calls, deadline, salt });

      // First call should succeed
      await swapHelper.connect(user1).multicall(calls, deadline, salt, signature);

      // Second call with same salt should fail
      await expect(
        swapHelper.connect(user1).multicall(calls, deadline, salt, signature),
      ).to.be.revertedWithCustomError(swapHelper, "SaltAlreadyUsed");
    });
  });
});
