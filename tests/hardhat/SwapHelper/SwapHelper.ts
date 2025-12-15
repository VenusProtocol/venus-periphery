import "@nomicfoundation/hardhat-chai-matchers";
import { expect } from "chai";
import { Signer, Wallet } from "ethers";
import { _TypedDataEncoder, parseUnits } from "ethers/lib/utils";
import { ethers, network } from "hardhat";

import { FaucetToken, MockTarget, SwapHelper } from "../../../typechain";

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
  let mockTarget: MockTarget;

  // Helper function to get EIP-712 domain
  const getDomain = () => ({
    chainId: network.config.chainId,
    name: "VenusSwap",
    verifyingContract: swapHelper.address,
    version: "1",
  });

  // Helper function to get EIP-712 types
  const getTypes = () => ({
    Multicall: [
      { name: "caller", type: "address" },
      { name: "calls", type: "bytes[]" },
      { name: "deadline", type: "uint256" },
      { name: "salt", type: "bytes32" },
    ],
  });

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

    const MockTargetFactory = await ethers.getContractFactory("MockTarget");
    mockTarget = (await MockTargetFactory.deploy()) as MockTarget;
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

    it("should allow owner to transfer ownership with two-step process", async () => {
      await swapHelper.connect(owner).transferOwnership(userAddress);
      expect(await swapHelper.owner()).to.equal(ownerAddress);
      expect(await swapHelper.pendingOwner()).to.equal(userAddress);

      await swapHelper.connect(user1).acceptOwnership();
      expect(await swapHelper.owner()).to.equal(userAddress);
      expect(await swapHelper.pendingOwner()).to.equal(constants.AddressZero);
    });

    it("should prevent non-owner from transferring ownership", async () => {
      await expect(swapHelper.connect(user1).transferOwnership(user2Address)).to.be.reverted;
    });

    it("should prevent non-pending-owner from accepting ownership", async () => {
      await swapHelper.connect(owner).transferOwnership(userAddress);
      await expect(swapHelper.connect(user2).acceptOwnership()).to.be.revertedWith(
        "Ownable2Step: caller is not the new owner",
      );
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
          { name: "caller", type: "address" },
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
      const signature = await owner._signTypedData(domain, types, { caller: userAddress, calls, deadline, salt });
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
          { name: "caller", type: "address" },
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
      const signature = await owner._signTypedData(domain, types, { caller: userAddress, calls, deadline, salt });

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

    it("should revert when token is zero address", async () => {
      await expect(swapHelper.connect(owner).sweep(constants.AddressZero, userAddress)).to.be.revertedWithCustomError(
        swapHelper,
        "ZeroAddress",
      );
    });

    it("should revert when to is zero address", async () => {
      await expect(swapHelper.connect(owner).sweep(erc20.address, constants.AddressZero)).to.be.revertedWithCustomError(
        swapHelper,
        "ZeroAddress",
      );
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
          { name: "caller", type: "address" },
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
      const signature = await owner._signTypedData(domain, types, { caller: userAddress, calls, deadline, salt });
      await swapHelper.connect(user1).multicall(calls, deadline, salt, signature);
      expect(await erc20.allowance(swapHelper.address, spender)).to.equal(maxUint256);
    });
  });

  describe("multicall", () => {
    describe("validation", () => {
      it("should revert if calls array is empty", async () => {
        const domain = {
          chainId: network.config.chainId,
          name: "VenusSwap",
          verifyingContract: swapHelper.address,
          version: "1",
        };
        const types = {
          Multicall: [
            { name: "caller", type: "address" },
            { name: "calls", type: "bytes[]" },
            { name: "deadline", type: "uint256" },
            { name: "salt", type: "bytes32" },
          ],
        };
        const calls: string[] = [];
        const deadline = maxUint256;
        const salt = ethers.utils.formatBytes32String("4");
        const signature = await owner._signTypedData(domain, types, { caller: userAddress, calls, deadline, salt });

        await expect(
          swapHelper.connect(user1).multicall(calls, deadline, salt, signature),
        ).to.be.revertedWithCustomError(swapHelper, "NoCallsProvided");
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
            { name: "caller", type: "address" },
            { name: "calls", type: "bytes[]" },
            { name: "deadline", type: "uint256" },
            { name: "salt", type: "bytes32" },
          ],
        };
        const sweepData = await swapHelper.populateTransaction.sweep(erc20.address, userAddress);
        const calls = [sweepData.data!];
        const deadline = 1234;
        const salt = ethers.utils.formatBytes32String("7");
        const signature = await owner._signTypedData(domain, types, { caller: userAddress, calls, deadline, salt });
        await expect(
          swapHelper.connect(user1).multicall(calls, deadline, salt, signature),
        ).to.be.revertedWithCustomError(swapHelper, "DeadlineReached");
      });

      it("should revert with MissingSignature when signature is empty", async () => {
        const sweepData = await swapHelper.populateTransaction.sweep(erc20.address, userAddress);
        const calls = [sweepData.data!];
        const deadline = maxUint256;
        const salt = ethers.utils.formatBytes32String("empty-sig-test");
        const emptySignature = "0x";

        await expect(
          swapHelper.connect(user1).multicall(calls, deadline, salt, emptySignature),
        ).to.be.revertedWithCustomError(swapHelper, "MissingSignature");
      });

      it("should revert with MissingSignature when signature is empty bytes", async () => {
        const sweepData = await swapHelper.populateTransaction.sweep(erc20.address, userAddress);
        const calls = [sweepData.data!];
        const deadline = maxUint256;
        const salt = ethers.utils.formatBytes32String("empty-sig-test-2");

        await expect(swapHelper.connect(user1).multicall(calls, deadline, salt, "0x")).to.be.revertedWithCustomError(
          swapHelper,
          "MissingSignature",
        );
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
            { name: "caller", type: "address" },
            { name: "calls", type: "bytes[]" },
            { name: "deadline", type: "uint256" },
            { name: "salt", type: "bytes32" },
          ],
        };
        const sweepData = await swapHelper.populateTransaction.sweep(erc20.address, userAddress);
        const calls = [sweepData.data!];
        const deadline = maxUint256;
        const salt = ethers.utils.formatBytes32String("10");
        const signature = await owner._signTypedData(domain, types, { caller: userAddress, calls, deadline, salt });

        await swapHelper.connect(user1).multicall(calls, deadline, salt, signature);

        await expect(
          swapHelper.connect(user1).multicall(calls, deadline, salt, signature),
        ).to.be.revertedWithCustomError(swapHelper, "SaltAlreadyUsed");
      });
    });

    describe("signature verification", () => {
      it("should execute with valid signature", async () => {
        const domain = {
          chainId: network.config.chainId,
          name: "VenusSwap",
          verifyingContract: swapHelper.address,
          version: "1",
        };
        const types = {
          Multicall: [
            { name: "caller", type: "address" },
            { name: "calls", type: "bytes[]" },
            { name: "deadline", type: "uint256" },
            { name: "salt", type: "bytes32" },
          ],
        };
        const sweepData = await swapHelper.populateTransaction.sweep(erc20.address, userAddress);
        const calls = [sweepData.data!, sweepData.data!, sweepData.data!];
        const deadline = maxUint256;
        const salt = ethers.utils.formatBytes32String("8");
        const signature = await owner._signTypedData(domain, types, { caller: userAddress, calls, deadline, salt });
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
            { name: "caller", type: "address" },
            { name: "calls", type: "bytes[]" },
            { name: "deadline", type: "uint256" },
            { name: "salt", type: "bytes32" },
          ],
        };
        const sweepData = await swapHelper.populateTransaction.sweep(erc20.address, userAddress);
        const deadline = maxUint256;
        const salt = ethers.utils.formatBytes32String("9");
        const signature = await owner._signTypedData(domain, types, {
          caller: userAddress,
          calls: [sweepData.data!],
          deadline,
          salt,
        });
        await expect(
          swapHelper
            .connect(user1)
            .multicall([sweepData.data!, sweepData.data!, sweepData.data!], deadline, salt, signature),
        ).to.be.revertedWithCustomError(swapHelper, "Unauthorized");
      });
    });

    describe("events", () => {
      it("should emit MulticallExecuted event", async () => {
        const domain = {
          chainId: network.config.chainId,
          name: "VenusSwap",
          verifyingContract: swapHelper.address,
          version: "1",
        };
        const types = {
          Multicall: [
            { name: "caller", type: "address" },
            { name: "calls", type: "bytes[]" },
            { name: "deadline", type: "uint256" },
            { name: "salt", type: "bytes32" },
          ],
        };
        const sweepData = await swapHelper.populateTransaction.sweep(erc20.address, userAddress);
        const calls = [sweepData.data!];
        const deadline = maxUint256;
        const salt = ethers.utils.formatBytes32String("5");
        const signature = await owner._signTypedData(domain, types, { caller: userAddress, calls, deadline, salt });

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
            { name: "caller", type: "address" },
            { name: "calls", type: "bytes[]" },
            { name: "deadline", type: "uint256" },
            { name: "salt", type: "bytes32" },
          ],
        };
        const sweepData = await swapHelper.populateTransaction.sweep(erc20.address, userAddress);
        const calls = [sweepData.data!, sweepData.data!, sweepData.data!];
        const deadline = maxUint256;
        const salt = ethers.utils.formatBytes32String("6");
        const signature = await owner._signTypedData(domain, types, { caller: userAddress, calls, deadline, salt });

        const tx = await swapHelper.connect(user1).multicall(calls, deadline, salt, signature);

        await expect(tx).to.emit(swapHelper, "MulticallExecuted").withArgs(userAddress, 3, deadline, salt);
      });
    });

    describe("error propagation", () => {
      it("should propagate custom error when internal call fails", async () => {
        const domain = getDomain();
        const types = getTypes();

        const sweepData = await swapHelper.populateTransaction.sweep(constants.AddressZero, userAddress);
        const calls = [sweepData.data!];
        const deadline = maxUint256;
        const salt = ethers.utils.formatBytes32String("error-prop-test-1");
        const signature = await owner._signTypedData(domain, types, { caller: userAddress, calls, deadline, salt });

        await expect(
          swapHelper.connect(user1).multicall(calls, deadline, salt, signature),
        ).to.be.revertedWithCustomError(swapHelper, "ZeroAddress");
      });

      it("should propagate error when one of multiple calls fails", async () => {
        const domain = getDomain();
        const types = getTypes();

        const validSweepData = await swapHelper.populateTransaction.sweep(erc20.address, userAddress);
        const invalidSweepData = await swapHelper.populateTransaction.sweep(constants.AddressZero, userAddress);
        const calls = [validSweepData.data!, invalidSweepData.data!];
        const deadline = maxUint256;
        const salt = ethers.utils.formatBytes32String("error-prop-test-2");
        const signature = await owner._signTypedData(domain, types, { caller: userAddress, calls, deadline, salt });

        await expect(
          swapHelper.connect(user1).multicall(calls, deadline, salt, signature),
        ).to.be.revertedWithCustomError(swapHelper, "ZeroAddress");
      });

      it("should propagate error from genericCall failure through multicall", async () => {
        const domain = getDomain();
        const types = getTypes();

        const revertCallData = mockTarget.interface.encodeFunctionData("alwaysReverts");
        const genericCallData = await swapHelper.populateTransaction.genericCall(mockTarget.address, revertCallData);

        const calls = [genericCallData.data!];
        const deadline = maxUint256;
        const salt = ethers.utils.formatBytes32String("error-prop-test-3");
        const signature = await owner._signTypedData(domain, types, { caller: userAddress, calls, deadline, salt });

        await expect(
          swapHelper.connect(user1).multicall(calls, deadline, salt, signature),
        ).to.be.revertedWithCustomError(mockTarget, "CustomError");
      });

      it("should propagate require error message through multicall", async () => {
        const domain = getDomain();
        const types = getTypes();

        const revertCallData = mockTarget.interface.encodeFunctionData("revertWithRequire");
        const genericCallData = await swapHelper.populateTransaction.genericCall(mockTarget.address, revertCallData);

        const calls = [genericCallData.data!];
        const deadline = maxUint256;
        const salt = ethers.utils.formatBytes32String("error-prop-test-4");
        const signature = await owner._signTypedData(domain, types, { caller: userAddress, calls, deadline, salt });

        await expect(swapHelper.connect(user1).multicall(calls, deadline, salt, signature)).to.be.revertedWith(
          "MockTarget: require failed",
        );
      });
    });
  });

  describe("genericCall", () => {
    describe("direct owner calls", () => {
      it("should allow owner to call genericCall directly", async () => {
        const callData = mockTarget.interface.encodeFunctionData("setValue", [42]);

        await swapHelper.connect(owner).genericCall(mockTarget.address, callData);

        expect(await mockTarget.value()).to.equal(42);
        expect(await mockTarget.lastCaller()).to.equal(swapHelper.address);
      });

      it("should emit GenericCallExecuted event when owner calls directly", async () => {
        const callData = mockTarget.interface.encodeFunctionData("setValue", [123]);

        await expect(swapHelper.connect(owner).genericCall(mockTarget.address, callData))
          .to.emit(swapHelper, "GenericCallExecuted")
          .withArgs(mockTarget.address, callData);
      });

      it("should revert when non-owner tries to call genericCall directly", async () => {
        const callData = mockTarget.interface.encodeFunctionData("setValue", [42]);

        await expect(swapHelper.connect(user1).genericCall(mockTarget.address, callData)).to.be.revertedWithCustomError(
          swapHelper,
          "CallerNotAuthorized",
        );
      });

      it("should revert when user2 tries to call genericCall directly", async () => {
        const callData = mockTarget.interface.encodeFunctionData("setValue", [42]);

        await expect(swapHelper.connect(user2).genericCall(mockTarget.address, callData)).to.be.revertedWithCustomError(
          swapHelper,
          "CallerNotAuthorized",
        );
      });
    });

    describe("genericCall via multicall (signed)", () => {
      it("should execute genericCall via multicall with valid signature", async () => {
        const domain = getDomain();
        const types = getTypes();

        const callData = mockTarget.interface.encodeFunctionData("setValue", [999]);
        const genericCallData = await swapHelper.populateTransaction.genericCall(mockTarget.address, callData);

        const calls = [genericCallData.data!];
        const deadline = maxUint256;
        const salt = ethers.utils.formatBytes32String("generic-multicall-1");
        const signature = await owner._signTypedData(domain, types, { caller: userAddress, calls, deadline, salt });

        await swapHelper.connect(user1).multicall(calls, deadline, salt, signature);

        expect(await mockTarget.value()).to.equal(999);
        expect(await mockTarget.lastCaller()).to.equal(swapHelper.address);
      });

      it("should emit GenericCallExecuted event via multicall", async () => {
        const domain = getDomain();
        const types = getTypes();

        const callData = mockTarget.interface.encodeFunctionData("setValue", [777]);
        const genericCallData = await swapHelper.populateTransaction.genericCall(mockTarget.address, callData);

        const calls = [genericCallData.data!];
        const deadline = maxUint256;
        const salt = ethers.utils.formatBytes32String("generic-multicall-2");
        const signature = await owner._signTypedData(domain, types, { caller: userAddress, calls, deadline, salt });

        await expect(swapHelper.connect(user1).multicall(calls, deadline, salt, signature))
          .to.emit(swapHelper, "GenericCallExecuted")
          .withArgs(mockTarget.address, callData);
      });

      it("should execute multiple genericCalls in one multicall", async () => {
        const domain = getDomain();
        const types = getTypes();

        const callData1 = mockTarget.interface.encodeFunctionData("setValue", [100]);
        const callData2 = mockTarget.interface.encodeFunctionData("setValue", [200]);
        const genericCallData1 = await swapHelper.populateTransaction.genericCall(mockTarget.address, callData1);
        const genericCallData2 = await swapHelper.populateTransaction.genericCall(mockTarget.address, callData2);

        const calls = [genericCallData1.data!, genericCallData2.data!];
        const deadline = maxUint256;
        const salt = ethers.utils.formatBytes32String("generic-multicall-3");
        const signature = await owner._signTypedData(domain, types, { caller: userAddress, calls, deadline, salt });

        await swapHelper.connect(user1).multicall(calls, deadline, salt, signature);

        expect(await mockTarget.value()).to.equal(200);
      });

      it("should combine genericCall with other calls in multicall", async () => {
        const domain = getDomain();
        const types = getTypes();

        const amount = parseUnits("500", 18);
        await erc20.connect(owner).transfer(swapHelper.address, amount);

        const genericCallData = await swapHelper.populateTransaction.genericCall(
          mockTarget.address,
          mockTarget.interface.encodeFunctionData("setValue", [555]),
        );
        const sweepData = await swapHelper.populateTransaction.sweep(erc20.address, userAddress);

        const calls = [genericCallData.data!, sweepData.data!];
        const deadline = maxUint256;
        const salt = ethers.utils.formatBytes32String("generic-multicall-4");
        const signature = await owner._signTypedData(domain, types, { caller: userAddress, calls, deadline, salt });

        await swapHelper.connect(user1).multicall(calls, deadline, salt, signature);

        expect(await mockTarget.value()).to.equal(555);
        expect(await erc20.balanceOf(userAddress)).to.equal(amount);
      });
    });

    describe("genericCall failure scenarios", () => {
      it("should revert when genericCall target is zero address", async () => {
        const callData = mockTarget.interface.encodeFunctionData("setValue", [42]);

        await expect(swapHelper.connect(owner).genericCall(constants.AddressZero, callData)).to.be.revertedWith(
          "Address: call to non-contract",
        );
      });

      it("should revert when genericCall target is EOA", async () => {
        const callData = mockTarget.interface.encodeFunctionData("setValue", [42]);

        await expect(swapHelper.connect(owner).genericCall(userAddress, callData)).to.be.revertedWith(
          "Address: low-level call failed",
        );
      });

      it("should propagate custom error from target contract", async () => {
        const callData = mockTarget.interface.encodeFunctionData("alwaysReverts");

        await expect(swapHelper.connect(owner).genericCall(mockTarget.address, callData)).to.be.revertedWithCustomError(
          mockTarget,
          "CustomError",
        );
      });

      it("should propagate ZeroValueNotAllowed error from target", async () => {
        const callData = mockTarget.interface.encodeFunctionData("revertOnZero", [0]);

        await expect(swapHelper.connect(owner).genericCall(mockTarget.address, callData)).to.be.revertedWithCustomError(
          mockTarget,
          "ZeroValueNotAllowed",
        );
      });

      it("should propagate require failure message from target", async () => {
        const callData = mockTarget.interface.encodeFunctionData("revertWithRequire");

        await expect(swapHelper.connect(owner).genericCall(mockTarget.address, callData)).to.be.revertedWith(
          "MockTarget: require failed",
        );
      });

      it("should fail when target is configured to fail", async () => {
        await mockTarget.setFailMode(true);
        const callData = mockTarget.interface.encodeFunctionData("setValue", [42]);

        await expect(swapHelper.connect(owner).genericCall(mockTarget.address, callData)).to.be.revertedWithCustomError(
          mockTarget,
          "CustomError",
        );
      });

      it("should succeed when target is reconfigured to not fail", async () => {
        await mockTarget.setFailMode(true);
        await mockTarget.setFailMode(false);
        const callData = mockTarget.interface.encodeFunctionData("setValue", [42]);

        await swapHelper.connect(owner).genericCall(mockTarget.address, callData);
        expect(await mockTarget.value()).to.equal(42);
      });
    });

    describe("genericCall calling back into SwapHelper", () => {
      it("should fail reentrancy when target calls back into multicall", async () => {
        const domain = getDomain();
        const types = getTypes();

        const sweepData = await swapHelper.populateTransaction.sweep(erc20.address, userAddress);
        const innerCalls = [sweepData.data!];
        const innerDeadline = maxUint256;
        const innerSalt = ethers.utils.formatBytes32String("reentrant-inner");
        const innerSignature = await owner._signTypedData(domain, types, {
          caller: mockTarget.address,
          calls: innerCalls,
          deadline: innerDeadline,
          salt: innerSalt,
        });

        const reentrantCallData = swapHelper.interface.encodeFunctionData("multicall", [
          innerCalls,
          innerDeadline,
          innerSalt,
          innerSignature,
        ]);

        const callbackData = mockTarget.interface.encodeFunctionData("callbackToCaller", [reentrantCallData]);
        const genericCallData = await swapHelper.populateTransaction.genericCall(mockTarget.address, callbackData);

        const calls = [genericCallData.data!];
        const deadline = maxUint256;
        const salt = ethers.utils.formatBytes32String("reentrant-outer");
        const signature = await owner._signTypedData(domain, types, { caller: userAddress, calls, deadline, salt });

        await expect(swapHelper.connect(user1).multicall(calls, deadline, salt, signature)).to.be.revertedWith(
          "Callback failed",
        );
      });

      it("should allow owner to call sweep via genericCall (not recommended but possible)", async () => {
        const amount = parseUnits("100", 18);
        await erc20.connect(owner).transfer(swapHelper.address, amount);

        const sweepCallData = swapHelper.interface.encodeFunctionData("sweep", [erc20.address, userAddress]);

        await swapHelper.connect(owner).genericCall(swapHelper.address, sweepCallData);

        expect(await erc20.balanceOf(userAddress)).to.equal(amount);
      });
    });
  });

  describe("security", () => {
    describe("malformed signatures", () => {
      it("should revert with invalid signature of wrong length (too short)", async () => {
        const sweepData = await swapHelper.populateTransaction.sweep(erc20.address, userAddress);
        const calls = [sweepData.data!];
        const deadline = maxUint256;
        const salt = ethers.utils.formatBytes32String("malformed-sig-1");

        const malformedSignature = "0x" + "aa".repeat(64);

        await expect(swapHelper.connect(user1).multicall(calls, deadline, salt, malformedSignature)).to.be.reverted;
      });

      it("should revert with invalid signature of wrong length (too long)", async () => {
        const sweepData = await swapHelper.populateTransaction.sweep(erc20.address, userAddress);
        const calls = [sweepData.data!];
        const deadline = maxUint256;
        const salt = ethers.utils.formatBytes32String("malformed-sig-2");

        const malformedSignature = "0x" + "bb".repeat(66);

        await expect(swapHelper.connect(user1).multicall(calls, deadline, salt, malformedSignature)).to.be.reverted;
      });

      it("should revert with signature from wrong signer", async () => {
        const domain = getDomain();
        const types = getTypes();

        const sweepData = await swapHelper.populateTransaction.sweep(erc20.address, userAddress);
        const calls = [sweepData.data!];
        const deadline = maxUint256;
        const salt = ethers.utils.formatBytes32String("wrong-signer");

        const randomWallet = ethers.Wallet.createRandom().connect(ethers.provider);
        const signature = await randomWallet._signTypedData(domain, types, {
          caller: userAddress,
          calls,
          deadline,
          salt,
        });

        await expect(
          swapHelper.connect(user1).multicall(calls, deadline, salt, signature),
        ).to.be.revertedWithCustomError(swapHelper, "Unauthorized");
      });

      it("should revert with signature for wrong caller", async () => {
        const domain = getDomain();
        const types = getTypes();

        const sweepData = await swapHelper.populateTransaction.sweep(erc20.address, userAddress);
        const calls = [sweepData.data!];
        const deadline = maxUint256;
        const salt = ethers.utils.formatBytes32String("wrong-caller");

        const signature = await owner._signTypedData(domain, types, { caller: user2Address, calls, deadline, salt });

        await expect(
          swapHelper.connect(user1).multicall(calls, deadline, salt, signature),
        ).to.be.revertedWithCustomError(swapHelper, "Unauthorized");
      });

      it("should revert with signature for wrong deadline", async () => {
        const domain = getDomain();
        const types = getTypes();

        const sweepData = await swapHelper.populateTransaction.sweep(erc20.address, userAddress);
        const calls = [sweepData.data!];
        const signedDeadline = maxUint256;
        const differentDeadline = ethers.BigNumber.from(Date.now() + 1000000);
        const salt = ethers.utils.formatBytes32String("wrong-deadline");

        const signature = await owner._signTypedData(domain, types, {
          caller: userAddress,
          calls,
          deadline: signedDeadline,
          salt,
        });

        await expect(
          swapHelper.connect(user1).multicall(calls, differentDeadline, salt, signature),
        ).to.be.revertedWithCustomError(swapHelper, "Unauthorized");
      });

      it("should revert with signature for wrong salt", async () => {
        const domain = getDomain();
        const types = getTypes();

        const sweepData = await swapHelper.populateTransaction.sweep(erc20.address, userAddress);
        const calls = [sweepData.data!];
        const deadline = maxUint256;
        const signedSalt = ethers.utils.formatBytes32String("signed-salt");
        const differentSalt = ethers.utils.formatBytes32String("different-salt");

        const signature = await owner._signTypedData(domain, types, {
          caller: userAddress,
          calls,
          deadline,
          salt: signedSalt,
        });

        await expect(
          swapHelper.connect(user1).multicall(calls, deadline, differentSalt, signature),
        ).to.be.revertedWithCustomError(swapHelper, "Unauthorized");
      });
    });

    describe("multiple calls with failures", () => {
      it("should revert entire multicall if first call fails", async () => {
        const domain = getDomain();
        const types = getTypes();

        const invalidSweepData = await swapHelper.populateTransaction.sweep(constants.AddressZero, userAddress);
        const validSweepData = await swapHelper.populateTransaction.sweep(erc20.address, userAddress);

        const calls = [invalidSweepData.data!, validSweepData.data!];
        const deadline = maxUint256;
        const salt = ethers.utils.formatBytes32String("first-fails");
        const signature = await owner._signTypedData(domain, types, { caller: userAddress, calls, deadline, salt });

        await expect(
          swapHelper.connect(user1).multicall(calls, deadline, salt, signature),
        ).to.be.revertedWithCustomError(swapHelper, "ZeroAddress");
      });

      it("should revert entire multicall if middle call fails", async () => {
        const domain = getDomain();
        const types = getTypes();

        const validSweepData = await swapHelper.populateTransaction.sweep(erc20.address, userAddress);
        const invalidSweepData = await swapHelper.populateTransaction.sweep(constants.AddressZero, userAddress);

        const calls = [validSweepData.data!, invalidSweepData.data!, validSweepData.data!];
        const deadline = maxUint256;
        const salt = ethers.utils.formatBytes32String("middle-fails");
        const signature = await owner._signTypedData(domain, types, { caller: userAddress, calls, deadline, salt });

        await expect(
          swapHelper.connect(user1).multicall(calls, deadline, salt, signature),
        ).to.be.revertedWithCustomError(swapHelper, "ZeroAddress");
      });

      it("should revert entire multicall if last call fails", async () => {
        const domain = getDomain();
        const types = getTypes();

        const validSweepData = await swapHelper.populateTransaction.sweep(erc20.address, userAddress);
        const invalidSweepData = await swapHelper.populateTransaction.sweep(constants.AddressZero, userAddress);

        const calls = [validSweepData.data!, validSweepData.data!, invalidSweepData.data!];
        const deadline = maxUint256;
        const salt = ethers.utils.formatBytes32String("last-fails");
        const signature = await owner._signTypedData(domain, types, { caller: userAddress, calls, deadline, salt });

        await expect(
          swapHelper.connect(user1).multicall(calls, deadline, salt, signature),
        ).to.be.revertedWithCustomError(swapHelper, "ZeroAddress");
      });

      it("should execute all calls when all succeed", async () => {
        const domain = getDomain();
        const types = getTypes();

        const amount = parseUnits("1000", 18);
        await erc20.connect(owner).transfer(swapHelper.address, amount);

        const approveData = await swapHelper.populateTransaction.approveMax(erc20.address, user2Address);
        const sweepData = await swapHelper.populateTransaction.sweep(erc20.address, userAddress);

        const calls = [approveData.data!, sweepData.data!];
        const deadline = maxUint256;
        const salt = ethers.utils.formatBytes32String("all-succeed");
        const signature = await owner._signTypedData(domain, types, { caller: userAddress, calls, deadline, salt });

        await swapHelper.connect(user1).multicall(calls, deadline, salt, signature);

        expect(await erc20.allowance(swapHelper.address, user2Address)).to.equal(maxUint256);
        expect(await erc20.balanceOf(userAddress)).to.equal(amount);
      });
    });

    describe("edge cases", () => {
      it("should handle deadline at exact current block timestamp", async () => {
        const domain = getDomain();
        const types = getTypes();

        const sweepData = await swapHelper.populateTransaction.sweep(erc20.address, userAddress);
        const calls = [sweepData.data!];
        const salt = ethers.utils.formatBytes32String("exact-deadline");

        const block = await ethers.provider.getBlock("latest");
        const deadline = block.timestamp;

        const signature = await owner._signTypedData(domain, types, { caller: userAddress, calls, deadline, salt });

        await expect(
          swapHelper.connect(user1).multicall(calls, deadline, salt, signature),
        ).to.be.revertedWithCustomError(swapHelper, "DeadlineReached");
      });

      it("should successfully execute with deadline in future", async () => {
        const domain = getDomain();
        const types = getTypes();

        const sweepData = await swapHelper.populateTransaction.sweep(erc20.address, userAddress);
        const calls = [sweepData.data!];
        const salt = ethers.utils.formatBytes32String("future-deadline");

        const block = await ethers.provider.getBlock("latest");
        const deadline = block.timestamp + 3600;

        const signature = await owner._signTypedData(domain, types, { caller: userAddress, calls, deadline, salt });

        await swapHelper.connect(user1).multicall(calls, deadline, salt, signature);
      });

      it("should track used salts correctly", async () => {
        const salt = ethers.utils.formatBytes32String("track-salt");

        expect(await swapHelper.usedSalts(salt)).to.equal(false);

        const domain = getDomain();
        const types = getTypes();
        const sweepData = await swapHelper.populateTransaction.sweep(erc20.address, userAddress);
        const calls = [sweepData.data!];
        const deadline = maxUint256;
        const signature = await owner._signTypedData(domain, types, { caller: userAddress, calls, deadline, salt });

        await swapHelper.connect(user1).multicall(calls, deadline, salt, signature);

        expect(await swapHelper.usedSalts(salt)).to.equal(true);
      });

      it("should allow different users to use same operations with different salts", async () => {
        const domain = getDomain();
        const types = getTypes();

        const sweepData = await swapHelper.populateTransaction.sweep(erc20.address, userAddress);
        const calls = [sweepData.data!];
        const deadline = maxUint256;

        const salt1 = ethers.utils.formatBytes32String("user1-salt");
        const salt2 = ethers.utils.formatBytes32String("user2-salt");

        const signature1 = await owner._signTypedData(domain, types, {
          caller: userAddress,
          calls,
          deadline,
          salt: salt1,
        });
        const signature2 = await owner._signTypedData(domain, types, {
          caller: user2Address,
          calls,
          deadline,
          salt: salt2,
        });

        await swapHelper.connect(user1).multicall(calls, deadline, salt1, signature1);
        await swapHelper.connect(user2).multicall(calls, deadline, salt2, signature2);

        expect(await swapHelper.usedSalts(salt1)).to.equal(true);
        expect(await swapHelper.usedSalts(salt2)).to.equal(true);
      });
    });
  });
});
