import { FakeContract, smock } from "@defi-wonderland/smock";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import chai from "chai";
import { BigNumber } from "ethers";
import { parseUnits } from "ethers/lib/utils";
import { ethers, upgrades } from "hardhat";

import type {
  CurveOracle,
  IAccessControlManagerV8,
  ICurveStableSwapNG,
  ResilientOracleInterface,
} from "../../../typechain";

const { expect } = chai;
chai.use(smock.matchers);

describe("CurveOracle", () => {
  let curveOracle: CurveOracle;
  let accessControlManager: FakeContract<IAccessControlManagerV8>;
  let resilientOracle: FakeContract<ResilientOracleInterface>;
  let curvePool: FakeContract<ICurveStableSwapNG>;

  const EBTC_ADDR = "0x0000000000000000000000000000000000000001"; // coins[0], 8 decimals
  const WBTC_ADDR = "0x0000000000000000000000000000000000000002"; // coins[1], 8 decimals
  const OTHER_ADDR = "0x0000000000000000000000000000000000000003";

  const REF_PRICE = parseUnits("60000", 18);

  // get_dy output in WBTC base units (8 decimals) per 1 eBTC (1e8)
  const DY_1_TO_1 = BigNumber.from(10).pow(8); // 1:1
  const DY_2_TO_1 = BigNumber.from(10).pow(8).mul(2); // 2:1
  const DY_HALF = BigNumber.from(10).pow(8).div(2); // 0.5:1

  async function deployFixture() {
    await ethers.getSigners(); // initializes Hardhat provider before smock
    accessControlManager = await smock.fake<IAccessControlManagerV8>("IAccessControlManagerV8");
    resilientOracle = await smock.fake<ResilientOracleInterface>("ResilientOracleInterface");
    curvePool = await smock.fake<ICurveStableSwapNG>("ICurveStableSwapNG");

    accessControlManager.isAllowedToCall.returns(true);
    curvePool.coins.whenCalledWith(0).returns(EBTC_ADDR);
    curvePool.coins.whenCalledWith(1).returns(WBTC_ADDR);

    const CurveOracleFactory = await ethers.getContractFactory("CurveOracle");
    curveOracle = (await upgrades.deployProxy(CurveOracleFactory, [accessControlManager.address], {
      constructorArgs: [resilientOracle.address],
      unsafeAllow: ["constructor"],
    })) as CurveOracle;

    return { curveOracle, accessControlManager, resilientOracle, curvePool };
  }

  beforeEach(async () => {
    ({ curveOracle, accessControlManager, resilientOracle, curvePool } = await loadFixture(deployFixture));
  });

  // ═══════════════════════════════════════════════════════════════════
  // 1. Initialization
  // ═══════════════════════════════════════════════════════════════════

  describe("Initialization", () => {
    it("should deploy to a non-zero address", async () => {
      expect(curveOracle.address).to.not.equal(ethers.constants.AddressZero);
    });

    it("should store RESILIENT_ORACLE immutable correctly", async () => {
      expect(await curveOracle.RESILIENT_ORACLE()).to.equal(resilientOracle.address);
    });

    it("should reject re-initialization", async () => {
      await expect(curveOracle.initialize(accessControlManager.address)).to.be.revertedWith(
        "Initializable: contract is already initialized",
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 2. setPoolConfig
  // ═══════════════════════════════════════════════════════════════════

  describe("setPoolConfig", () => {
    it("should store config including decimals", async () => {
      await curveOracle.setPoolConfig(EBTC_ADDR, curvePool.address, 0, 1, WBTC_ADDR, 8);
      const cfg = await curveOracle.poolConfigs(EBTC_ADDR);
      expect(cfg.pool).to.equal(curvePool.address);
      expect(cfg.coinIndex).to.equal(0);
      expect(cfg.refCoinIndex).to.equal(1);
      expect(cfg.referenceToken).to.equal(WBTC_ADDR);
      expect(cfg.assetDecimals).to.equal(8);
    });

    it("should emit PoolConfigUpdated event", async () => {
      await expect(curveOracle.setPoolConfig(EBTC_ADDR, curvePool.address, 0, 1, WBTC_ADDR, 8))
        .to.emit(curveOracle, "PoolConfigUpdated")
        .withArgs(EBTC_ADDR, curvePool.address, 0, 1, WBTC_ADDR, 8);
    });

    it("should allow updating config to a new pool", async () => {
      const newPool = await smock.fake<ICurveStableSwapNG>("ICurveStableSwapNG");
      newPool.coins.whenCalledWith(0).returns(EBTC_ADDR);
      newPool.coins.whenCalledWith(1).returns(WBTC_ADDR);
      await curveOracle.setPoolConfig(EBTC_ADDR, curvePool.address, 0, 1, WBTC_ADDR, 8);
      await curveOracle.setPoolConfig(EBTC_ADDR, newPool.address, 0, 1, WBTC_ADDR, 8);
      expect((await curveOracle.poolConfigs(EBTC_ADDR)).pool).to.equal(newPool.address);
    });

    it("should revert ZeroAddress when token is zero", async () => {
      await expect(
        curveOracle.setPoolConfig(ethers.constants.AddressZero, curvePool.address, 0, 1, WBTC_ADDR, 8),
      ).to.be.revertedWithCustomError(curveOracle, "ZeroAddress");
    });

    it("should revert ZeroAddress when pool is zero", async () => {
      await expect(
        curveOracle.setPoolConfig(EBTC_ADDR, ethers.constants.AddressZero, 0, 1, WBTC_ADDR, 8),
      ).to.be.revertedWithCustomError(curveOracle, "ZeroAddress");
    });

    it("should revert ZeroAddress when referenceToken is zero", async () => {
      await expect(
        curveOracle.setPoolConfig(EBTC_ADDR, curvePool.address, 0, 1, ethers.constants.AddressZero, 8),
      ).to.be.revertedWithCustomError(curveOracle, "ZeroAddress");
    });

    it("should revert AssetMismatch when pool.coins(coinIndex) != token", async () => {
      await expect(
        curveOracle.setPoolConfig(WBTC_ADDR, curvePool.address, 0, 1, EBTC_ADDR, 8),
      ).to.be.revertedWithCustomError(curveOracle, "AssetMismatch");
    });

    it("should revert ReferenceMismatch when pool.coins(refCoinIndex) != referenceToken", async () => {
      await expect(
        curveOracle.setPoolConfig(EBTC_ADDR, curvePool.address, 0, 1, OTHER_ADDR, 8),
      ).to.be.revertedWithCustomError(curveOracle, "ReferenceMismatch");
    });

    it("should revert when caller is not authorized", async () => {
      accessControlManager.isAllowedToCall.returns(false);
      await expect(curveOracle.setPoolConfig(EBTC_ADDR, curvePool.address, 0, 1, WBTC_ADDR, 8)).to.be.reverted;
      accessControlManager.isAllowedToCall.returns(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 3. getPrice — revert cases
  // ═══════════════════════════════════════════════════════════════════

  describe("getPrice — revert cases", () => {
    it("should revert TokenNotConfigured when asset has no pool", async () => {
      await expect(curveOracle.getPrice(OTHER_ADDR)).to.be.revertedWithCustomError(curveOracle, "TokenNotConfigured");
    });

    it("should revert ZeroPrice when get_dy returns zero", async () => {
      await curveOracle.setPoolConfig(EBTC_ADDR, curvePool.address, 0, 1, WBTC_ADDR, 8);
      curvePool.get_dy.returns(0);
      resilientOracle.getPrice.returns(REF_PRICE);
      await expect(curveOracle.getPrice(EBTC_ADDR)).to.be.revertedWithCustomError(curveOracle, "ZeroPrice");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 4. getPrice — coinIndex=0, refCoinIndex=1
  //
  // get_dy(0, 1, 1e8) = WBTC base units per 1 eBTC
  // ratio = dy * 1e18 / 1e8
  // price = ratio * refPrice / 1e18
  // ═══════════════════════════════════════════════════════════════════

  describe("getPrice — coinIndex=0 (eBTC)", () => {
    beforeEach(async () => {
      await curveOracle.setPoolConfig(EBTC_ADDR, curvePool.address, 0, 1, WBTC_ADDR, 8);
      resilientOracle.getPrice.whenCalledWith(WBTC_ADDR).returns(REF_PRICE);
    });

    it("should return refPrice when dy is 1:1", async () => {
      curvePool.get_dy.returns(DY_1_TO_1);
      expect(await curveOracle.getPrice(EBTC_ADDR)).to.equal(REF_PRICE);
    });

    it("should return 2x refPrice when dy is 2:1", async () => {
      curvePool.get_dy.returns(DY_2_TO_1);
      expect(await curveOracle.getPrice(EBTC_ADDR)).to.equal(REF_PRICE.mul(2));
    });

    it("should return 0.5x refPrice when dy is 0.5:1", async () => {
      curvePool.get_dy.returns(DY_HALF);
      expect(await curveOracle.getPrice(EBTC_ADDR)).to.equal(REF_PRICE.div(2));
    });

    it("should call get_dy with (0, 1, 1e8)", async () => {
      curvePool.get_dy.returns(DY_1_TO_1);
      await curveOracle.getPrice(EBTC_ADDR);
      expect(curvePool.get_dy).to.have.been.calledWith(0, 1, BigNumber.from(10).pow(8));
    });

    it("should call resilientOracle with WBTC", async () => {
      curvePool.get_dy.returns(DY_1_TO_1);
      await curveOracle.getPrice(EBTC_ADDR);
      expect(resilientOracle.getPrice).to.have.been.calledWith(WBTC_ADDR);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 5. getPrice — coinIndex=1, refCoinIndex=0
  //
  // Same formula — no special-casing needed vs coinIndex=0
  // ═══════════════════════════════════════════════════════════════════

  describe("getPrice — coinIndex=1 (WBTC)", () => {
    beforeEach(async () => {
      await curveOracle.setPoolConfig(WBTC_ADDR, curvePool.address, 1, 0, EBTC_ADDR, 8);
      resilientOracle.getPrice.whenCalledWith(EBTC_ADDR).returns(REF_PRICE);
    });

    it("should return refPrice when dy is 1:1", async () => {
      curvePool.get_dy.returns(DY_1_TO_1);
      expect(await curveOracle.getPrice(WBTC_ADDR)).to.equal(REF_PRICE);
    });

    it("should return 2x refPrice when dy is 2:1", async () => {
      curvePool.get_dy.returns(DY_2_TO_1);
      expect(await curveOracle.getPrice(WBTC_ADDR)).to.equal(REF_PRICE.mul(2));
    });

    it("should call get_dy with (1, 0, 1e8)", async () => {
      curvePool.get_dy.returns(DY_1_TO_1);
      await curveOracle.getPrice(WBTC_ADDR);
      expect(curvePool.get_dy).to.have.been.calledWith(1, 0, BigNumber.from(10).pow(8));
    });

    it("should call resilientOracle with EBTC", async () => {
      curvePool.get_dy.returns(DY_1_TO_1);
      await curveOracle.getPrice(WBTC_ADDR);
      expect(resilientOracle.getPrice).to.have.been.calledWith(EBTC_ADDR);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 6. Pool reconfiguration
  // ═══════════════════════════════════════════════════════════════════

  describe("getPrice — pool reconfiguration", () => {
    it("should use latest config after update", async () => {
      const pool2 = await smock.fake<ICurveStableSwapNG>("ICurveStableSwapNG");
      pool2.coins.whenCalledWith(0).returns(EBTC_ADDR);
      pool2.coins.whenCalledWith(1).returns(WBTC_ADDR);

      await curveOracle.setPoolConfig(EBTC_ADDR, curvePool.address, 0, 1, WBTC_ADDR, 8);
      curvePool.get_dy.returns(DY_1_TO_1);
      resilientOracle.getPrice.whenCalledWith(WBTC_ADDR).returns(REF_PRICE);
      expect(await curveOracle.getPrice(EBTC_ADDR)).to.equal(REF_PRICE);

      await curveOracle.setPoolConfig(EBTC_ADDR, pool2.address, 0, 1, WBTC_ADDR, 8);
      pool2.get_dy.returns(DY_2_TO_1);
      expect(await curveOracle.getPrice(EBTC_ADDR)).to.equal(REF_PRICE.mul(2));
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 7. Varying reference prices
  // ═══════════════════════════════════════════════════════════════════

  describe("getPrice — varying reference prices", () => {
    beforeEach(async () => {
      await curveOracle.setPoolConfig(EBTC_ADDR, curvePool.address, 0, 1, WBTC_ADDR, 8);
      curvePool.get_dy.returns(DY_1_TO_1);
    });

    it("should scale with high reference price ($90000)", async () => {
      const highPrice = parseUnits("90000", 18);
      resilientOracle.getPrice.whenCalledWith(WBTC_ADDR).returns(highPrice);
      expect(await curveOracle.getPrice(EBTC_ADDR)).to.equal(highPrice);
    });

    it("should scale with low reference price ($0.01)", async () => {
      const lowPrice = parseUnits("0.01", 18);
      resilientOracle.getPrice.whenCalledWith(WBTC_ADDR).returns(lowPrice);
      expect(await curveOracle.getPrice(EBTC_ADDR)).to.equal(lowPrice);
    });
  });
});
