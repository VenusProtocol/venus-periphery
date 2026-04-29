import { FakeContract, smock } from "@defi-wonderland/smock";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import chai from "chai";
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

// 1e18 as BigNumber
const ONE_E18 = parseUnits("1", 18);

describe("CurveOracle", () => {
  let curveOracle: CurveOracle;
  let accessControlManager: FakeContract<IAccessControlManagerV8>;
  let resilientOracle: FakeContract<ResilientOracleInterface>;
  let curvePool: FakeContract<ICurveStableSwapNG>;

  // Addresses used as stand-ins for tokens
  const EBTC = "0x0000000000000000000000000000000000000001"; // coins[0]
  const WBTC = "0x0000000000000000000000000000000000000002"; // coins[1]
  const OTHER = "0x0000000000000000000000000000000000000003"; // not in pool

  // WBTC price in 36-8=28 decimal format; use 18 decimals here for simplicity
  const REF_PRICE = parseUnits("60000", 18);

  async function deployFixture() {
    const [owner, user] = await ethers.getSigners();

    accessControlManager = await smock.fake<IAccessControlManagerV8>("IAccessControlManagerV8");
    resilientOracle = await smock.fake<ResilientOracleInterface>("ResilientOracleInterface");
    curvePool = await smock.fake<ICurveStableSwapNG>("ICurveStableSwapNG");

    accessControlManager.isAllowedToCall.returns(true);

    // Default pool setup: coins[0]=EBTC, coins[1]=WBTC
    curvePool.coins.whenCalledWith(0).returns(EBTC);
    curvePool.coins.whenCalledWith(1).returns(WBTC);

    const CurveOracleFactory = await ethers.getContractFactory("CurveOracle");
    curveOracle = (await upgrades.deployProxy(CurveOracleFactory, [accessControlManager.address], {
      constructorArgs: [resilientOracle.address],
      unsafeAllow: ["constructor"],
    })) as CurveOracle;

    return { curveOracle, accessControlManager, resilientOracle, curvePool, owner, user };
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
    it("should store config in poolConfigs mapping", async () => {
      await curveOracle.setPoolConfig(EBTC, curvePool.address, 0, WBTC);
      const cfg = await curveOracle.poolConfigs(EBTC);
      expect(cfg.pool).to.equal(curvePool.address);
      expect(cfg.coinIndex).to.equal(0);
      expect(cfg.referenceToken).to.equal(WBTC);
    });

    it("should emit PoolConfigUpdated event", async () => {
      await expect(curveOracle.setPoolConfig(EBTC, curvePool.address, 0, WBTC))
        .to.emit(curveOracle, "PoolConfigUpdated")
        .withArgs(EBTC, curvePool.address, 0, WBTC);
    });

    it("should allow updating config to a new pool", async () => {
      const newPool = await smock.fake<ICurveStableSwapNG>("ICurveStableSwapNG");
      newPool.coins.whenCalledWith(0).returns(EBTC);
      await curveOracle.setPoolConfig(EBTC, curvePool.address, 0, WBTC);
      await curveOracle.setPoolConfig(EBTC, newPool.address, 0, WBTC);
      expect((await curveOracle.poolConfigs(EBTC)).pool).to.equal(newPool.address);
    });

    it("should configure multiple tokens independently", async () => {
      const pool2 = await smock.fake<ICurveStableSwapNG>("ICurveStableSwapNG");
      pool2.coins.whenCalledWith(1).returns(WBTC);
      await curveOracle.setPoolConfig(EBTC, curvePool.address, 0, WBTC);
      await curveOracle.setPoolConfig(WBTC, pool2.address, 1, EBTC);
      expect((await curveOracle.poolConfigs(EBTC)).pool).to.equal(curvePool.address);
      expect((await curveOracle.poolConfigs(WBTC)).pool).to.equal(pool2.address);
    });

    it("should revert ZeroAddress when token is zero", async () => {
      await expect(
        curveOracle.setPoolConfig(ethers.constants.AddressZero, curvePool.address, 0, WBTC),
      ).to.be.revertedWithCustomError(curveOracle, "ZeroAddress");
    });

    it("should revert ZeroAddress when pool is zero", async () => {
      await expect(
        curveOracle.setPoolConfig(EBTC, ethers.constants.AddressZero, 0, WBTC),
      ).to.be.revertedWithCustomError(curveOracle, "ZeroAddress");
    });

    it("should revert ZeroAddress when referenceToken is zero", async () => {
      await expect(
        curveOracle.setPoolConfig(EBTC, curvePool.address, 0, ethers.constants.AddressZero),
      ).to.be.revertedWithCustomError(curveOracle, "ZeroAddress");
    });

    it("should revert AssetMismatch when pool.coins(coinIndex) != token", async () => {
      // coinIndex=0 maps to EBTC; passing WBTC as token should fail
      await expect(curveOracle.setPoolConfig(WBTC, curvePool.address, 0, EBTC)).to.be.revertedWithCustomError(
        curveOracle,
        "AssetMismatch",
      );
    });

    it("should revert when caller is not authorized", async () => {
      accessControlManager.isAllowedToCall.returns(false);
      await expect(curveOracle.setPoolConfig(EBTC, curvePool.address, 0, WBTC)).to.be.reverted;
      accessControlManager.isAllowedToCall.returns(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 3. getPrice — revert cases
  // ═══════════════════════════════════════════════════════════════════

  describe("getPrice — revert cases", () => {
    it("should revert TokenNotConfigured when asset has no pool", async () => {
      await expect(curveOracle.getPrice(OTHER)).to.be.revertedWithCustomError(curveOracle, "TokenNotConfigured");
    });

    it("should revert ZeroPrice when pool returns zero ratio", async () => {
      await curveOracle.setPoolConfig(EBTC, curvePool.address, 0, WBTC);
      curvePool.price_oracle.returns(0);
      resilientOracle.getPrice.returns(REF_PRICE);
      await expect(curveOracle.getPrice(EBTC)).to.be.revertedWithCustomError(curveOracle, "ZeroPrice");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 4. getPrice — asset is coins[0] (coinIndex=0)
  //
  // price_oracle(0) = coins[1] / coins[0] = WBTC per eBTC (in 1e18)
  // price = ratio * refPrice / 1e18
  //
  // ratio = 1e18 (1:1 peg)  → price = refPrice
  // ratio = 2e18 (eBTC worth 2x WBTC) → price = 2 * refPrice
  // ratio = 0.5e18 (eBTC worth 0.5x WBTC) → price = 0.5 * refPrice
  // ═══════════════════════════════════════════════════════════════════

  describe("getPrice — coinIndex=0 (asset is coins[0])", () => {
    beforeEach(async () => {
      await curveOracle.setPoolConfig(EBTC, curvePool.address, 0, WBTC);
      resilientOracle.getPrice.whenCalledWith(WBTC).returns(REF_PRICE);
    });

    it("should return refPrice when ratio is 1:1", async () => {
      curvePool.price_oracle.returns(ONE_E18);
      expect(await curveOracle.getPrice(EBTC)).to.equal(REF_PRICE);
    });

    it("should return 2x refPrice when ratio is 2:1 (eBTC worth more)", async () => {
      curvePool.price_oracle.returns(ONE_E18.mul(2));
      expect(await curveOracle.getPrice(EBTC)).to.equal(REF_PRICE.mul(2));
    });

    it("should return 0.5x refPrice when ratio is 0.5:1 (eBTC worth less)", async () => {
      curvePool.price_oracle.returns(ONE_E18.div(2));
      expect(await curveOracle.getPrice(EBTC)).to.equal(REF_PRICE.div(2));
    });

    it("should use a realistic eBTC/WBTC ratio (~1.0021)", async () => {
      // price_oracle(0) ≈ 1.0021e18
      const ratio = parseUnits("1.0021", 18);
      curvePool.price_oracle.returns(ratio);
      const expected = REF_PRICE.mul(ratio).div(ONE_E18);
      expect(await curveOracle.getPrice(EBTC)).to.equal(expected);
    });

    it("should call price_oracle with index 0", async () => {
      curvePool.price_oracle.returns(ONE_E18);
      await curveOracle.getPrice(EBTC);
      expect(curvePool.price_oracle).to.have.been.calledWith(0);
    });

    it("should call resilientOracle with referenceToken (WBTC)", async () => {
      curvePool.price_oracle.returns(ONE_E18);
      await curveOracle.getPrice(EBTC);
      expect(resilientOracle.getPrice).to.have.been.calledWith(WBTC);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 5. getPrice — asset is coins[1] (coinIndex=1)
  //
  // price_oracle(0) = coins[1] / coins[0] = asset / refToken (in 1e18)
  // price = refPrice * 1e18 / ratio
  //
  // ratio = 1e18 → price = refPrice
  // ratio = 2e18 (1 refToken buys 2 assets) → price = refPrice / 2
  // ratio = 0.5e18 (1 refToken buys 0.5 assets) → price = refPrice * 2
  // ═══════════════════════════════════════════════════════════════════

  describe("getPrice — coinIndex=1 (asset is coins[1])", () => {
    beforeEach(async () => {
      // WBTC as coins[1]; referenceToken = EBTC (coins[0])
      await curveOracle.setPoolConfig(WBTC, curvePool.address, 1, EBTC);
      resilientOracle.getPrice.whenCalledWith(EBTC).returns(REF_PRICE);
    });

    it("should return refPrice when ratio is 1:1", async () => {
      curvePool.price_oracle.returns(ONE_E18);
      expect(await curveOracle.getPrice(WBTC)).to.equal(REF_PRICE);
    });

    it("should return refPrice/2 when ratio is 2:1 (asset worth less than ref)", async () => {
      curvePool.price_oracle.returns(ONE_E18.mul(2));
      expect(await curveOracle.getPrice(WBTC)).to.equal(REF_PRICE.div(2));
    });

    it("should return 2x refPrice when ratio is 0.5:1 (asset worth more than ref)", async () => {
      curvePool.price_oracle.returns(ONE_E18.div(2));
      expect(await curveOracle.getPrice(WBTC)).to.equal(REF_PRICE.mul(2));
    });

    it("should call price_oracle with index 0 (coinIndex-1)", async () => {
      curvePool.price_oracle.returns(ONE_E18);
      await curveOracle.getPrice(WBTC);
      expect(curvePool.price_oracle).to.have.been.calledWith(0);
    });

    it("should call resilientOracle with referenceToken (EBTC)", async () => {
      curvePool.price_oracle.returns(ONE_E18);
      await curveOracle.getPrice(WBTC);
      expect(resilientOracle.getPrice).to.have.been.calledWith(EBTC);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 6. getPrice — pool reconfiguration
  // ═══════════════════════════════════════════════════════════════════

  describe("getPrice — pool reconfiguration", () => {
    it("should use latest config after update", async () => {
      const pool2 = await smock.fake<ICurveStableSwapNG>("ICurveStableSwapNG");
      pool2.coins.whenCalledWith(0).returns(EBTC);

      // First pool: 1:1
      await curveOracle.setPoolConfig(EBTC, curvePool.address, 0, WBTC);
      curvePool.price_oracle.returns(ONE_E18);
      resilientOracle.getPrice.whenCalledWith(WBTC).returns(REF_PRICE);
      expect(await curveOracle.getPrice(EBTC)).to.equal(REF_PRICE);

      // Reconfigure: 2:1
      await curveOracle.setPoolConfig(EBTC, pool2.address, 0, WBTC);
      pool2.price_oracle.returns(ONE_E18.mul(2));
      expect(await curveOracle.getPrice(EBTC)).to.equal(REF_PRICE.mul(2));
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 7. getPrice — varying reference prices
  // ═══════════════════════════════════════════════════════════════════

  describe("getPrice — varying reference prices", () => {
    beforeEach(async () => {
      await curveOracle.setPoolConfig(EBTC, curvePool.address, 0, WBTC);
      curvePool.price_oracle.returns(ONE_E18); // 1:1 ratio
    });

    it("should scale with a high BTC reference price ($90000)", async () => {
      const highPrice = parseUnits("90000", 18);
      resilientOracle.getPrice.whenCalledWith(WBTC).returns(highPrice);
      expect(await curveOracle.getPrice(EBTC)).to.equal(highPrice);
    });

    it("should scale with a low reference price ($0.01)", async () => {
      const lowPrice = parseUnits("0.01", 18);
      resilientOracle.getPrice.whenCalledWith(WBTC).returns(lowPrice);
      expect(await curveOracle.getPrice(EBTC)).to.equal(lowPrice);
    });
  });
});
