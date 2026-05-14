import { FakeContract, smock } from "@defi-wonderland/smock";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import chai from "chai";
import { BigNumber } from "ethers";
import { parseUnits } from "ethers/lib/utils";
import { ethers, upgrades } from "hardhat";

import type {
  AerodromeSlipstreamOracle,
  IAccessControlManagerV8,
  IAerodromeSlipstreamPool,
  ResilientOracleInterface,
} from "../../../typechain";

const { expect } = chai;
chai.use(smock.matchers);

// Q96 = 2^96 — fixed-point scaling factor used by Uniswap V3 / Aerodrome Slipstream
const Q96 = BigNumber.from(2).pow(96);

describe("AerodromeSlipstreamOracle", () => {
  let aeroOracle: AerodromeSlipstreamOracle;
  let accessControlManager: FakeContract<IAccessControlManagerV8>;
  let resilientOracle: FakeContract<ResilientOracleInterface>;
  let pool: FakeContract<IAerodromeSlipstreamPool>;
  let owner: SignerWithAddress;

  const TOKEN_A = "0x0000000000000000000000000000000000000001";
  const TOKEN_B = "0x0000000000000000000000000000000000000002";
  const TOKEN_C = "0x0000000000000000000000000000000000000003";
  const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

  // Aerodrome Slipstream slot0 returns 6 values (no feeProtocol)
  function slot0(sqrtPriceX96: BigNumber) {
    return [sqrtPriceX96, 0, 0, 1, 1, true];
  }

  async function deployFixture() {
    [owner] = await ethers.getSigners();

    accessControlManager = await smock.fake<IAccessControlManagerV8>("IAccessControlManagerV8");
    resilientOracle = await smock.fake<ResilientOracleInterface>("ResilientOracleInterface");
    pool = await smock.fake<IAerodromeSlipstreamPool>("IAerodromeSlipstreamPool");

    accessControlManager.isAllowedToCall.returns(true);

    const Factory = await ethers.getContractFactory("AerodromeSlipstreamOracle");
    aeroOracle = (await upgrades.deployProxy(Factory, [accessControlManager.address], {
      constructorArgs: [resilientOracle.address],
      unsafeAllow: ["constructor"],
    })) as AerodromeSlipstreamOracle;

    return { aeroOracle, accessControlManager, resilientOracle, pool, owner };
  }

  beforeEach(async () => {
    ({ aeroOracle, accessControlManager, resilientOracle, pool } = await loadFixture(deployFixture));
  });

  // ═══════════════════════════════════════════════════════════════════
  // 1. Initialization
  // ═══════════════════════════════════════════════════════════════════

  describe("Initialization", () => {
    it("should deploy to a non-zero address", async () => {
      expect(aeroOracle.address).to.not.equal(ethers.constants.AddressZero);
    });

    it("should store RESILIENT_ORACLE immutable correctly", async () => {
      expect(await aeroOracle.RESILIENT_ORACLE()).to.equal(resilientOracle.address);
    });

    it("should reject re-initialization", async () => {
      await expect(aeroOracle.initialize(accessControlManager.address)).to.be.revertedWith(
        "Initializable: contract is already initialized",
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 2. setPoolConfig
  // ═══════════════════════════════════════════════════════════════════

  describe("setPoolConfig", () => {
    it("should store pool in tokenPools mapping", async () => {
      await aeroOracle.setPoolConfig(TOKEN_A, pool.address);
      expect(await aeroOracle.tokenPools(TOKEN_A)).to.equal(pool.address);
    });

    it("should emit PoolConfigUpdated event", async () => {
      await expect(aeroOracle.setPoolConfig(TOKEN_A, pool.address))
        .to.emit(aeroOracle, "PoolConfigUpdated")
        .withArgs(TOKEN_A, pool.address);
    });

    it("should allow updating to a different pool", async () => {
      const pool2 = await smock.fake<IAerodromeSlipstreamPool>("IAerodromeSlipstreamPool");
      await aeroOracle.setPoolConfig(TOKEN_A, pool.address);
      await aeroOracle.setPoolConfig(TOKEN_A, pool2.address);
      expect(await aeroOracle.tokenPools(TOKEN_A)).to.equal(pool2.address);
    });

    it("should configure multiple tokens independently", async () => {
      const pool2 = await smock.fake<IAerodromeSlipstreamPool>("IAerodromeSlipstreamPool");
      await aeroOracle.setPoolConfig(TOKEN_A, pool.address);
      await aeroOracle.setPoolConfig(TOKEN_B, pool2.address);
      expect(await aeroOracle.tokenPools(TOKEN_A)).to.equal(pool.address);
      expect(await aeroOracle.tokenPools(TOKEN_B)).to.equal(pool2.address);
    });

    it("should revert ZeroAddress when token is zero", async () => {
      await expect(aeroOracle.setPoolConfig(ethers.constants.AddressZero, pool.address)).to.be.revertedWithCustomError(
        aeroOracle,
        "ZeroAddress",
      );
    });

    it("should revert ZeroAddress when pool is zero", async () => {
      await expect(aeroOracle.setPoolConfig(TOKEN_A, ethers.constants.AddressZero)).to.be.revertedWithCustomError(
        aeroOracle,
        "ZeroAddress",
      );
    });

    it("should revert when caller is not authorized", async () => {
      accessControlManager.isAllowedToCall.returns(false);
      await expect(aeroOracle.setPoolConfig(TOKEN_A, pool.address)).to.be.reverted;
      accessControlManager.isAllowedToCall.returns(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 3. getPrice — revert cases
  // ═══════════════════════════════════════════════════════════════════

  describe("getPrice — revert cases", () => {
    it("should revert TokenNotConfigured when token has no pool", async () => {
      await expect(aeroOracle.getPrice(TOKEN_C)).to.be.revertedWithCustomError(aeroOracle, "TokenNotConfigured");
    });

    it("should revert InvalidPool when token is neither token0 nor token1", async () => {
      await aeroOracle.setPoolConfig(TOKEN_A, pool.address);
      pool.token0.returns(TOKEN_B);
      pool.token1.returns(TOKEN_C);
      pool.slot0.returns(slot0(Q96));
      await expect(aeroOracle.getPrice(TOKEN_A)).to.be.revertedWithCustomError(aeroOracle, "InvalidPool");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 4. getPrice — target is token0
  //
  // Pool: token0=TARGET, token1=USDC
  // sqrtPriceX96 encodes sqrt(token1/token0) * 2^96
  //
  // sqrtPriceX96 = Q96  → ratio = 1:1  → price = refPrice
  // sqrtPriceX96 = 2*Q96 → ratio = 4:1 → price = 4 * refPrice (target worth 4x)...
  // wait: for token0 targetIsToken0=true: price = refPrice * priceX96 / Q96
  // priceX96 = 4*Q96 → price = 4 * refPrice
  // ═══════════════════════════════════════════════════════════════════

  describe("getPrice — target is token0", () => {
    const REF_PRICE = parseUnits("1", 18); // $1 USDC

    beforeEach(async () => {
      await aeroOracle.setPoolConfig(TOKEN_A, pool.address);
      pool.token0.returns(TOKEN_A);
      pool.token1.returns(USDC);
      resilientOracle.getPrice.whenCalledWith(USDC).returns(REF_PRICE);
    });

    it("should return refPrice at 1:1 ratio (sqrtPriceX96 = Q96)", async () => {
      pool.slot0.returns(slot0(Q96));
      expect(await aeroOracle.getPrice(TOKEN_A)).to.equal(REF_PRICE);
    });

    it("should return 4x refPrice when sqrtPriceX96 = 2*Q96", async () => {
      pool.slot0.returns(slot0(Q96.mul(2)));
      expect(await aeroOracle.getPrice(TOKEN_A)).to.equal(REF_PRICE.mul(4));
    });

    it("should return 0.25x refPrice when sqrtPriceX96 = Q96/2", async () => {
      pool.slot0.returns(slot0(Q96.div(2)));
      expect(await aeroOracle.getPrice(TOKEN_A)).to.equal(REF_PRICE.div(4));
    });

    it("should call resilientOracle with token1 as reference", async () => {
      pool.slot0.returns(slot0(Q96));
      await aeroOracle.getPrice(TOKEN_A);
      expect(resilientOracle.getPrice).to.have.been.calledWith(USDC);
    });

    it("should call pool slot0, token0, token1", async () => {
      pool.slot0.returns(slot0(Q96));
      await aeroOracle.getPrice(TOKEN_A);
      expect(pool.slot0).to.have.been.called;
      expect(pool.token0).to.have.been.called;
      expect(pool.token1).to.have.been.called;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 5. getPrice — target is token1
  //
  // Pool: token0=USDC, token1=TARGET
  // targetIsToken0=false: price = refPrice * Q96 / priceX96
  //
  // sqrtPriceX96 = Q96  → price = refPrice
  // sqrtPriceX96 = 2*Q96 → priceX96=4*Q96 → price = refPrice/4
  // ═══════════════════════════════════════════════════════════════════

  describe("getPrice — target is token1", () => {
    const REF_PRICE = parseUnits("1", 18);

    beforeEach(async () => {
      await aeroOracle.setPoolConfig(TOKEN_A, pool.address);
      pool.token0.returns(USDC);
      pool.token1.returns(TOKEN_A);
      resilientOracle.getPrice.whenCalledWith(USDC).returns(REF_PRICE);
    });

    it("should return refPrice at 1:1 ratio", async () => {
      pool.slot0.returns(slot0(Q96));
      expect(await aeroOracle.getPrice(TOKEN_A)).to.equal(REF_PRICE);
    });

    it("should return refPrice/4 when sqrtPriceX96 = 2*Q96", async () => {
      pool.slot0.returns(slot0(Q96.mul(2)));
      expect(await aeroOracle.getPrice(TOKEN_A)).to.equal(REF_PRICE.div(4));
    });

    it("should return 4x refPrice when sqrtPriceX96 = Q96/2", async () => {
      pool.slot0.returns(slot0(Q96.div(2)));
      expect(await aeroOracle.getPrice(TOKEN_A)).to.equal(REF_PRICE.mul(4));
    });

    it("should call resilientOracle with token0 as reference", async () => {
      pool.slot0.returns(slot0(Q96));
      await aeroOracle.getPrice(TOKEN_A);
      expect(resilientOracle.getPrice).to.have.been.calledWith(USDC);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 6. Pool reconfiguration
  // ═══════════════════════════════════════════════════════════════════

  describe("getPrice — pool reconfiguration", () => {
    it("should use latest pool after update", async () => {
      const pool2 = await smock.fake<IAerodromeSlipstreamPool>("IAerodromeSlipstreamPool");
      const REF_PRICE = parseUnits("1", 18);

      await aeroOracle.setPoolConfig(TOKEN_A, pool.address);
      pool.token0.returns(TOKEN_A);
      pool.token1.returns(USDC);
      pool.slot0.returns(slot0(Q96));
      resilientOracle.getPrice.whenCalledWith(USDC).returns(REF_PRICE);
      expect(await aeroOracle.getPrice(TOKEN_A)).to.equal(REF_PRICE);

      await aeroOracle.setPoolConfig(TOKEN_A, pool2.address);
      pool2.token0.returns(TOKEN_A);
      pool2.token1.returns(USDC);
      pool2.slot0.returns(slot0(Q96.mul(2)));
      expect(await aeroOracle.getPrice(TOKEN_A)).to.equal(REF_PRICE.mul(4));
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 7. Varying reference prices
  // ═══════════════════════════════════════════════════════════════════

  describe("getPrice — varying reference prices", () => {
    beforeEach(async () => {
      await aeroOracle.setPoolConfig(TOKEN_A, pool.address);
      pool.token0.returns(TOKEN_A);
      pool.token1.returns(USDC);
      pool.slot0.returns(slot0(Q96));
    });

    it("should scale with high reference price ($90000)", async () => {
      const highPrice = parseUnits("90000", 18);
      resilientOracle.getPrice.whenCalledWith(USDC).returns(highPrice);
      expect(await aeroOracle.getPrice(TOKEN_A)).to.equal(highPrice);
    });

    it("should scale with low reference price ($0.01)", async () => {
      const lowPrice = parseUnits("0.01", 18);
      resilientOracle.getPrice.whenCalledWith(USDC).returns(lowPrice);
      expect(await aeroOracle.getPrice(TOKEN_A)).to.equal(lowPrice);
    });
  });
});
