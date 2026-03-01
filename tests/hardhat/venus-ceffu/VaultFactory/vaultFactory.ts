import { FakeContract, smock } from "@defi-wonderland/smock";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import chai from "chai";
import { parseUnits } from "ethers/lib/utils";
import { ethers, upgrades } from "hardhat";

import { FixedRateVault, FundRouter, IAccessControlManagerV8, MockToken, VaultFactory } from "../../../../typechain";
import { VaultInitParams, defaultVaultParams, deployFullSystemFixture } from "../fixtures";

const { expect } = chai;
chai.use(smock.matchers);

describe("VaultFactory", () => {
  let _owner: SignerWithAddress;
  let alice: SignerWithAddress;
  let _bob: SignerWithAddress;
  let _treasury: SignerWithAddress;
  let acm: FakeContract<IAccessControlManagerV8>;
  let usdcToken: MockToken;
  let vaultImpl: FixedRateVault;
  let fundRouter: FundRouter;
  let factory: VaultFactory;
  let vault: FixedRateVault;
  let vaultAddress: string;
  let _params: VaultInitParams;

  beforeEach(async () => {
    ({
      owner: _owner,
      alice,
      bob: _bob,
      treasury: _treasury,
      acm,
      usdcToken,
      vaultImpl,
      fundRouter,
      factory,
      vault,
      vaultAddress,
      params: _params,
    } = await loadFixture(deployFullSystemFixture));
    // Reset smock state — .returns() persists in JS memory across evm_revert snapshots
    acm.isAllowedToCall.returns(true);
  });

  // ──────────────────────────────────────────────
  //  Initialization
  // ──────────────────────────────────────────────

  describe("Initialization", () => {
    it("should set vaultImplementation correctly", async () => {
      expect(await factory.vaultImplementation()).to.equal(vaultImpl.address);
    });

    it("should set fundRouter correctly", async () => {
      expect(await factory.fundRouter()).to.equal(fundRouter.address);
    });

    it("should start with vaultCount = 1 (one vault deployed in fixture)", async () => {
      expect(await factory.vaultCount()).to.equal(1);
    });

    it("should revert on re-initialization", async () => {
      await expect(factory.initialize(acm.address, vaultImpl.address, fundRouter.address)).to.be.revertedWith(
        "Initializable: contract is already initialized",
      );
    });

    it("should revert if vaultImplementation is zero address", async () => {
      const VaultFactoryFactory = await ethers.getContractFactory("VaultFactory");
      await expect(
        upgrades.deployProxy(VaultFactoryFactory, [acm.address, ethers.constants.AddressZero, fundRouter.address], {
          unsafeAllow: ["constructor"],
        }),
      ).to.be.revertedWithCustomError(factory, "ZeroAddressNotAllowed");
    });

    it("should revert if fundRouter is zero address", async () => {
      const VaultFactoryFactory = await ethers.getContractFactory("VaultFactory");
      await expect(
        upgrades.deployProxy(VaultFactoryFactory, [acm.address, vaultImpl.address, ethers.constants.AddressZero], {
          unsafeAllow: ["constructor"],
        }),
      ).to.be.revertedWithCustomError(factory, "ZeroAddressNotAllowed");
    });
  });

  // ──────────────────────────────────────────────
  //  deployVault()
  // ──────────────────────────────────────────────

  describe("deployVault", () => {
    it("should deploy a vault clone at a non-zero address", async () => {
      expect(vaultAddress).to.not.equal(ethers.constants.AddressZero);
    });

    it("should increment vaultCount on each deployment", async () => {
      expect(await factory.vaultCount()).to.equal(1);

      const params2 = await defaultVaultParams(usdcToken.address, { ceffuRequestId: "CR-0002" });
      await factory.deployVault(params2);

      expect(await factory.vaultCount()).to.equal(2);
    });

    it("should set vaultIdByAddress correctly", async () => {
      expect(await factory.vaultIdByAddress(vaultAddress)).to.equal(1);
    });

    it("should set vaultByIndex correctly", async () => {
      expect(await factory.vaultByIndex(1)).to.equal(vaultAddress);
    });

    it("should set vaultByCeffuRequestId correctly", async () => {
      expect(await factory.vaultByCeffuRequestId("CR-0001")).to.equal(vaultAddress);
    });

    it("should emit VaultDeployed event", async () => {
      const params2 = await defaultVaultParams(usdcToken.address, { ceffuRequestId: "CR-0002" });

      await expect(factory.deployVault(params2))
        .to.emit(factory, "VaultDeployed")
        .withArgs(
          // vault address — can't predict easily, so just check event is emitted
          // We'll verify the address in the next assertion
          () => true,
          "CR-0002",
          usdcToken.address,
          2, // second vault
        );
    });

    it("should initialize the clone with correct config", async () => {
      expect(await vault.name()).to.equal("Venus Fixed Rate USDC #001");
      expect(await vault.symbol()).to.equal("vfrUSDC-001");
      expect(await vault.asset()).to.equal(usdcToken.address);
      expect(await vault.fixedAPY()).to.equal(500);
      expect(await vault.minCap()).to.equal(parseUnits("1000", 18));
      expect(await vault.maxCap()).to.equal(parseUnits("10000", 18));
      expect(await vault.lockPeriodDuration()).to.equal(30 * 24 * 60 * 60);
      expect(await vault.reserveFactorBps()).to.equal(1000);
      expect(await vault.ceffuRequestId()).to.equal("CR-0001");
      // State should be Fundraising (0)
      expect(await vault.state()).to.equal(0);
    });

    it("should set vault fundRouter to the factory's fundRouter", async () => {
      expect(await vault.fundRouter()).to.equal(fundRouter.address);
    });

    it("should produce address matching predictVaultAddress()", async () => {
      const predictedAddress = await factory.predictVaultAddress("CR-0002");
      const params2 = await defaultVaultParams(usdcToken.address, { ceffuRequestId: "CR-0002" });
      await factory.deployVault(params2);

      const actualAddress = await factory.vaultByCeffuRequestId("CR-0002");
      expect(actualAddress).to.equal(predictedAddress);
    });

    it("should revert on empty ceffuRequestId", async () => {
      const badParams = await defaultVaultParams(usdcToken.address, { ceffuRequestId: "" });
      await expect(factory.deployVault(badParams)).to.be.revertedWithCustomError(factory, "EmptyCeffuRequestId");
    });

    it("should revert on duplicate ceffuRequestId", async () => {
      // "CR-0001" already used in fixture
      const dupeParams = await defaultVaultParams(usdcToken.address, { ceffuRequestId: "CR-0001" });
      await expect(factory.deployVault(dupeParams))
        .to.be.revertedWithCustomError(factory, "DuplicateCeffuRequestId")
        .withArgs("CR-0001");
    });

    it("should revert on zero supplyAsset address", async () => {
      const badParams = await defaultVaultParams(ethers.constants.AddressZero, {
        ceffuRequestId: "CR-0002",
      });
      await expect(factory.deployVault(badParams)).to.be.revertedWithCustomError(factory, "ZeroAddressNotAllowed");
    });

    it("should revert when ACM denies access", async () => {
      acm.isAllowedToCall.returns(false);
      const newParams = await defaultVaultParams(usdcToken.address, { ceffuRequestId: "CR-0002" });
      await expect(factory.deployVault(newParams)).to.be.revertedWithCustomError(factory, "Unauthorized");
    });

    it("should deploy multiple vaults with sequential IDs", async () => {
      const params2 = await defaultVaultParams(usdcToken.address, { ceffuRequestId: "CR-0002" });
      const params3 = await defaultVaultParams(usdcToken.address, { ceffuRequestId: "CR-0003" });

      await factory.deployVault(params2);
      await factory.deployVault(params3);

      expect(await factory.vaultCount()).to.equal(3);

      const vault2Addr = await factory.vaultByIndex(2);
      const vault3Addr = await factory.vaultByIndex(3);

      expect(vault2Addr).to.not.equal(ethers.constants.AddressZero);
      expect(vault3Addr).to.not.equal(ethers.constants.AddressZero);
      expect(vault2Addr).to.not.equal(vault3Addr);
      expect(await factory.vaultIdByAddress(vault2Addr)).to.equal(2);
      expect(await factory.vaultIdByAddress(vault3Addr)).to.equal(3);
    });
  });

  // ──────────────────────────────────────────────
  //  setVaultImplementation()
  // ──────────────────────────────────────────────

  describe("setVaultImplementation", () => {
    it("should update vaultImplementation", async () => {
      const VaultImplFactory = await ethers.getContractFactory("FixedRateVault");
      const newImpl = await VaultImplFactory.deploy();

      await factory.setVaultImplementation(newImpl.address);
      expect(await factory.vaultImplementation()).to.equal(newImpl.address);
    });

    it("should emit VaultImplementationUpdated event", async () => {
      const VaultImplFactory = await ethers.getContractFactory("FixedRateVault");
      const newImpl = await VaultImplFactory.deploy();

      await expect(factory.setVaultImplementation(newImpl.address))
        .to.emit(factory, "VaultImplementationUpdated")
        .withArgs(vaultImpl.address, newImpl.address);
    });

    it("should revert on zero address", async () => {
      await expect(factory.setVaultImplementation(ethers.constants.AddressZero)).to.be.revertedWithCustomError(
        factory,
        "ZeroAddressNotAllowed",
      );
    });

    it("should revert on same address", async () => {
      await expect(factory.setVaultImplementation(vaultImpl.address)).to.be.revertedWithCustomError(
        factory,
        "ImplementationUnchanged",
      );
    });

    it("should revert when ACM denies access", async () => {
      acm.isAllowedToCall.returns(false);
      await expect(factory.setVaultImplementation(alice.address)).to.be.revertedWithCustomError(
        factory,
        "Unauthorized",
      );
    });
  });

  // ──────────────────────────────────────────────
  //  setFundRouter()
  // ──────────────────────────────────────────────

  describe("setFundRouter", () => {
    it("should update fundRouter", async () => {
      await factory.setFundRouter(alice.address);
      expect(await factory.fundRouter()).to.equal(alice.address);
    });

    it("should emit FundRouterUpdated event", async () => {
      await expect(factory.setFundRouter(alice.address))
        .to.emit(factory, "FundRouterUpdated")
        .withArgs(fundRouter.address, alice.address);
    });

    it("should revert on zero address", async () => {
      await expect(factory.setFundRouter(ethers.constants.AddressZero)).to.be.revertedWithCustomError(
        factory,
        "ZeroAddressNotAllowed",
      );
    });

    it("should revert on same address", async () => {
      await expect(factory.setFundRouter(fundRouter.address)).to.be.revertedWithCustomError(
        factory,
        "FundRouterUnchanged",
      );
    });

    it("should revert when ACM denies access", async () => {
      acm.isAllowedToCall.returns(false);
      await expect(factory.setFundRouter(alice.address)).to.be.revertedWithCustomError(factory, "Unauthorized");
    });
  });

  // ──────────────────────────────────────────────
  //  isVault()
  // ──────────────────────────────────────────────

  describe("isVault", () => {
    it("should return true for a factory-deployed vault", async () => {
      expect(await factory.isVault(vaultAddress)).to.be.true;
    });

    it("should return false for an arbitrary address", async () => {
      expect(await factory.isVault(alice.address)).to.be.false;
    });

    it("should return false for address(0)", async () => {
      expect(await factory.isVault(ethers.constants.AddressZero)).to.be.false;
    });
  });

  // ──────────────────────────────────────────────
  //  predictVaultAddress()
  // ──────────────────────────────────────────────

  describe("predictVaultAddress", () => {
    it("should predict the correct address before deployment", async () => {
      const predicted = await factory.predictVaultAddress("CR-0002");
      const params2 = await defaultVaultParams(usdcToken.address, { ceffuRequestId: "CR-0002" });
      await factory.deployVault(params2);

      const actualAddress = await factory.vaultByCeffuRequestId("CR-0002");
      expect(actualAddress).to.equal(predicted);
    });

    it("should return different addresses for different ceffuRequestIds", async () => {
      const addr1 = await factory.predictVaultAddress("CR-AAA");
      const addr2 = await factory.predictVaultAddress("CR-BBB");
      expect(addr1).to.not.equal(addr2);
    });
  });
});
