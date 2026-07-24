import { FakeContract, smock } from "@defi-wonderland/smock";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import chai from "chai";
import { BigNumber } from "ethers";
import { parseUnits } from "ethers/lib/utils";
import { ethers, upgrades } from "hardhat";

import type {
  IAccessControlManagerV8,
  IPancakeStableSwap,
  PCSStableOracle,
  ResilientOracleInterface,
} from "../../../typechain";

const { expect } = chai;
chai.use(smock.matchers);

describe("PCSStableOracle", () => {
  let pcsStableOracle: PCSStableOracle;
  let accessControlManager: FakeContract<IAccessControlManagerV8>;
  let resilientOracle: FakeContract<ResilientOracleInterface>;
  let stablePool: FakeContract<IPancakeStableSwap>;

  const LISUSD_ADDR = "0x0000000000000000000000000000000000000001"; // coins[0], 18 decimals
  const USDT_ADDR = "0x0000000000000000000000000000000000000002"; // coins[1], 18 decimals
  const OTHER_ADDR = "0x0000000000000000000000000000000000000003";

  const REF_PRICE = parseUnits("1", 18); // USDT ≈ $1 in 1e18

  // get_dy output in USDT base units (18 decimals) per 1 lisUSD (1e18)
  const DY_1_TO_1 = BigNumber.from(10).pow(18); // 1:1
  const DY_2_TO_1 = BigNumber.from(10).pow(18).mul(2); // 2:1
  const DY_HALF = BigNumber.from(10).pow(18).div(2); // 0.5:1

  async function deployFixture() {
    await ethers.getSigners(); // initializes Hardhat provider before smock
    accessControlManager = await smock.fake<IAccessControlManagerV8>("IAccessControlManagerV8");
    resilientOracle = await smock.fake<ResilientOracleInterface>("ResilientOracleInterface");
    stablePool = await smock.fake<IPancakeStableSwap>("IPancakeStableSwap");

    accessControlManager.isAllowedToCall.returns(true);
    stablePool.coins.whenCalledWith(0).returns(LISUSD_ADDR);
    stablePool.coins.whenCalledWith(1).returns(USDT_ADDR);

    const PCSStableOracleFactory = await ethers.getContractFactory("PCSStableOracle");
    pcsStableOracle = (await upgrades.deployProxy(PCSStableOracleFactory, [accessControlManager.address], {
      constructorArgs: [resilientOracle.address],
      unsafeAllow: ["constructor"],
    })) as PCSStableOracle;

    return { pcsStableOracle, accessControlManager, resilientOracle, stablePool };
  }

  beforeEach(async () => {
    ({ pcsStableOracle, accessControlManager, resilientOracle, stablePool } = await loadFixture(deployFixture));
  });

  // ═══════════════════════════════════════════════════════════════════
  // 1. Initialization
  // ═══════════════════════════════════════════════════════════════════

  describe("Initialization", () => {
    it("should deploy to a non-zero address", async () => {
      expect(pcsStableOracle.address).to.not.equal(ethers.constants.AddressZero);
    });

    it("should store RESILIENT_ORACLE immutable correctly", async () => {
      expect(await pcsStableOracle.RESILIENT_ORACLE()).to.equal(resilientOracle.address);
    });

    it("should reject re-initialization", async () => {
      await expect(pcsStableOracle.initialize(accessControlManager.address)).to.be.revertedWith(
        "Initializable: contract is already initialized",
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 2. setPoolConfig
  // ═══════════════════════════════════════════════════════════════════

  describe("setPoolConfig", () => {
    it("should store config including decimals", async () => {
      await pcsStableOracle.setPoolConfig(LISUSD_ADDR, stablePool.address, 0, 1, USDT_ADDR, 18);
      const cfg = await pcsStableOracle.poolConfigs(LISUSD_ADDR);
      expect(cfg.pool).to.equal(stablePool.address);
      expect(cfg.coinIndex).to.equal(0);
      expect(cfg.refCoinIndex).to.equal(1);
      expect(cfg.referenceToken).to.equal(USDT_ADDR);
      expect(cfg.assetDecimals).to.equal(18);
    });

    it("should emit PoolConfigUpdated event", async () => {
      await expect(pcsStableOracle.setPoolConfig(LISUSD_ADDR, stablePool.address, 0, 1, USDT_ADDR, 18))
        .to.emit(pcsStableOracle, "PoolConfigUpdated")
        .withArgs(LISUSD_ADDR, stablePool.address, 0, 1, USDT_ADDR, 18);
    });

    it("should allow updating config to a new pool", async () => {
      const newPool = await smock.fake<IPancakeStableSwap>("IPancakeStableSwap");
      newPool.coins.whenCalledWith(0).returns(LISUSD_ADDR);
      newPool.coins.whenCalledWith(1).returns(USDT_ADDR);
      await pcsStableOracle.setPoolConfig(LISUSD_ADDR, stablePool.address, 0, 1, USDT_ADDR, 18);
      await pcsStableOracle.setPoolConfig(LISUSD_ADDR, newPool.address, 0, 1, USDT_ADDR, 18);
      expect((await pcsStableOracle.poolConfigs(LISUSD_ADDR)).pool).to.equal(newPool.address);
    });

    it("should revert ZeroAddress when token is zero", async () => {
      await expect(
        pcsStableOracle.setPoolConfig(ethers.constants.AddressZero, stablePool.address, 0, 1, USDT_ADDR, 18),
      ).to.be.revertedWithCustomError(pcsStableOracle, "ZeroAddress");
    });

    it("should revert ZeroAddress when pool is zero", async () => {
      await expect(
        pcsStableOracle.setPoolConfig(LISUSD_ADDR, ethers.constants.AddressZero, 0, 1, USDT_ADDR, 18),
      ).to.be.revertedWithCustomError(pcsStableOracle, "ZeroAddress");
    });

    it("should revert ZeroAddress when referenceToken is zero", async () => {
      await expect(
        pcsStableOracle.setPoolConfig(LISUSD_ADDR, stablePool.address, 0, 1, ethers.constants.AddressZero, 18),
      ).to.be.revertedWithCustomError(pcsStableOracle, "ZeroAddress");
    });

    it("should revert AssetMismatch when pool.coins(coinIndex) != token", async () => {
      await expect(
        pcsStableOracle.setPoolConfig(USDT_ADDR, stablePool.address, 0, 1, LISUSD_ADDR, 18),
      ).to.be.revertedWithCustomError(pcsStableOracle, "AssetMismatch");
    });

    it("should revert ReferenceMismatch when pool.coins(refCoinIndex) != referenceToken", async () => {
      await expect(
        pcsStableOracle.setPoolConfig(LISUSD_ADDR, stablePool.address, 0, 1, OTHER_ADDR, 18),
      ).to.be.revertedWithCustomError(pcsStableOracle, "ReferenceMismatch");
    });

    it("should revert when caller is not authorized", async () => {
      accessControlManager.isAllowedToCall.returns(false);
      await expect(pcsStableOracle.setPoolConfig(LISUSD_ADDR, stablePool.address, 0, 1, USDT_ADDR, 18)).to.be.reverted;
      accessControlManager.isAllowedToCall.returns(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 3. getPrice — revert cases
  // ═══════════════════════════════════════════════════════════════════

  describe("getPrice — revert cases", () => {
    it("should revert TokenNotConfigured when asset has no pool", async () => {
      await expect(pcsStableOracle.getPrice(OTHER_ADDR)).to.be.revertedWithCustomError(
        pcsStableOracle,
        "TokenNotConfigured",
      );
    });

    it("should revert ZeroPrice when get_dy returns zero", async () => {
      await pcsStableOracle.setPoolConfig(LISUSD_ADDR, stablePool.address, 0, 1, USDT_ADDR, 18);
      stablePool.get_dy.returns(0);
      resilientOracle.getPrice.returns(REF_PRICE);
      await expect(pcsStableOracle.getPrice(LISUSD_ADDR)).to.be.revertedWithCustomError(pcsStableOracle, "ZeroPrice");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 4. getPrice — coinIndex=0, refCoinIndex=1
  //
  // get_dy(0, 1, 1e18) = USDT base units per 1 lisUSD
  // price = dy * refPrice / 1e18
  // ═══════════════════════════════════════════════════════════════════

  describe("getPrice — coinIndex=0 (lisUSD)", () => {
    beforeEach(async () => {
      await pcsStableOracle.setPoolConfig(LISUSD_ADDR, stablePool.address, 0, 1, USDT_ADDR, 18);
      resilientOracle.getPrice.whenCalledWith(USDT_ADDR).returns(REF_PRICE);
    });

    it("should return refPrice when dy is 1:1", async () => {
      stablePool.get_dy.returns(DY_1_TO_1);
      expect(await pcsStableOracle.getPrice(LISUSD_ADDR)).to.equal(REF_PRICE);
    });

    it("should return 2x refPrice when dy is 2:1", async () => {
      stablePool.get_dy.returns(DY_2_TO_1);
      expect(await pcsStableOracle.getPrice(LISUSD_ADDR)).to.equal(REF_PRICE.mul(2));
    });

    it("should return 0.5x refPrice when dy is 0.5:1", async () => {
      stablePool.get_dy.returns(DY_HALF);
      expect(await pcsStableOracle.getPrice(LISUSD_ADDR)).to.equal(REF_PRICE.div(2));
    });

    it("should call get_dy with (0, 1, 1e18)", async () => {
      stablePool.get_dy.returns(DY_1_TO_1);
      await pcsStableOracle.getPrice(LISUSD_ADDR);
      expect(stablePool.get_dy).to.have.been.calledWith(0, 1, BigNumber.from(10).pow(18));
    });

    it("should call resilientOracle with USDT", async () => {
      stablePool.get_dy.returns(DY_1_TO_1);
      await pcsStableOracle.getPrice(LISUSD_ADDR);
      expect(resilientOracle.getPrice).to.have.been.calledWith(USDT_ADDR);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 5. getPrice — coinIndex=1, refCoinIndex=0
  //
  // Same formula — no special-casing needed vs coinIndex=0
  // ═══════════════════════════════════════════════════════════════════

  describe("getPrice — coinIndex=1 (USDT)", () => {
    beforeEach(async () => {
      await pcsStableOracle.setPoolConfig(USDT_ADDR, stablePool.address, 1, 0, LISUSD_ADDR, 18);
      resilientOracle.getPrice.whenCalledWith(LISUSD_ADDR).returns(REF_PRICE);
    });

    it("should return refPrice when dy is 1:1", async () => {
      stablePool.get_dy.returns(DY_1_TO_1);
      expect(await pcsStableOracle.getPrice(USDT_ADDR)).to.equal(REF_PRICE);
    });

    it("should return 2x refPrice when dy is 2:1", async () => {
      stablePool.get_dy.returns(DY_2_TO_1);
      expect(await pcsStableOracle.getPrice(USDT_ADDR)).to.equal(REF_PRICE.mul(2));
    });

    it("should call get_dy with (1, 0, 1e18)", async () => {
      stablePool.get_dy.returns(DY_1_TO_1);
      await pcsStableOracle.getPrice(USDT_ADDR);
      expect(stablePool.get_dy).to.have.been.calledWith(1, 0, BigNumber.from(10).pow(18));
    });

    it("should call resilientOracle with lisUSD", async () => {
      stablePool.get_dy.returns(DY_1_TO_1);
      await pcsStableOracle.getPrice(USDT_ADDR);
      expect(resilientOracle.getPrice).to.have.been.calledWith(LISUSD_ADDR);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 6. Pool reconfiguration
  // ═══════════════════════════════════════════════════════════════════

  describe("getPrice — pool reconfiguration", () => {
    it("should use latest config after update", async () => {
      const pool2 = await smock.fake<IPancakeStableSwap>("IPancakeStableSwap");
      pool2.coins.whenCalledWith(0).returns(LISUSD_ADDR);
      pool2.coins.whenCalledWith(1).returns(USDT_ADDR);

      await pcsStableOracle.setPoolConfig(LISUSD_ADDR, stablePool.address, 0, 1, USDT_ADDR, 18);
      stablePool.get_dy.returns(DY_1_TO_1);
      resilientOracle.getPrice.whenCalledWith(USDT_ADDR).returns(REF_PRICE);
      expect(await pcsStableOracle.getPrice(LISUSD_ADDR)).to.equal(REF_PRICE);

      await pcsStableOracle.setPoolConfig(LISUSD_ADDR, pool2.address, 0, 1, USDT_ADDR, 18);
      pool2.get_dy.returns(DY_2_TO_1);
      expect(await pcsStableOracle.getPrice(LISUSD_ADDR)).to.equal(REF_PRICE.mul(2));
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 7. Varying reference prices
  // ═══════════════════════════════════════════════════════════════════

  describe("getPrice — varying reference prices", () => {
    beforeEach(async () => {
      await pcsStableOracle.setPoolConfig(LISUSD_ADDR, stablePool.address, 0, 1, USDT_ADDR, 18);
      stablePool.get_dy.returns(DY_1_TO_1);
    });

    it("should scale with high reference price ($1.01)", async () => {
      const highPrice = parseUnits("1.01", 18);
      resilientOracle.getPrice.whenCalledWith(USDT_ADDR).returns(highPrice);
      expect(await pcsStableOracle.getPrice(LISUSD_ADDR)).to.equal(highPrice);
    });

    it("should scale with low reference price ($0.01)", async () => {
      const lowPrice = parseUnits("0.01", 18);
      resilientOracle.getPrice.whenCalledWith(USDT_ADDR).returns(lowPrice);
      expect(await pcsStableOracle.getPrice(LISUSD_ADDR)).to.equal(lowPrice);
    });
  });
});
