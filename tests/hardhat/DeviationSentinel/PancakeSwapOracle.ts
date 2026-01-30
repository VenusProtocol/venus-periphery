import { FakeContract, smock } from "@defi-wonderland/smock";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import chai from "chai";
import { BigNumber } from "ethers";
import { parseUnits } from "ethers/lib/utils";
import { ethers, upgrades } from "hardhat";

import type {
  IAccessControlManagerV8,
  IPancakeV3Pool,
  PancakeSwapOracle,
  ResilientOracleInterface,
} from "../../../typechain";

const { expect } = chai;
chai.use(smock.matchers);

// Q96 = 2^96 — the fixed-point scaling factor used by Uniswap/PancakeSwap V3
const Q96 = BigNumber.from(2).pow(96);

describe("PancakeSwapOracle", () => {
  let pancakeSwapOracle: PancakeSwapOracle;
  let accessControlManager: FakeContract<IAccessControlManagerV8>;
  let resilientOracle: FakeContract<ResilientOracleInterface>;
  let pancakePool: FakeContract<IPancakeV3Pool>;
  let owner: SignerWithAddress;
  let user: SignerWithAddress;

  const TOKEN_A = "0x0000000000000000000000000000000000000001";
  const TOKEN_B = "0x0000000000000000000000000000000000000002";
  const TOKEN_C = "0x0000000000000000000000000000000000000003";
  const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";

  /**
   * Helper: build a slot0 return tuple.
   * PancakeSwap V3 slot0 returns:
   *   (uint160 sqrtPriceX96, int24 tick, uint16 obsIndex,
   *    uint16 obsCardinality, uint16 obsCardinalityNext,
   *    uint32 feeProtocol, bool unlocked)
   */
  function slot0(sqrtPriceX96: BigNumber) {
    return [sqrtPriceX96, 0, 0, 0, 0, 0, true];
  }

  async function deployFixture() {
    [owner, user] = await ethers.getSigners();

    accessControlManager = await smock.fake<IAccessControlManagerV8>("IAccessControlManagerV8");
    resilientOracle = await smock.fake<ResilientOracleInterface>("ResilientOracleInterface");
    pancakePool = await smock.fake<IPancakeV3Pool>("IPancakeV3Pool");

    accessControlManager.isAllowedToCall.returns(true);

    const PancakeSwapOracleFactory = await ethers.getContractFactory("PancakeSwapOracle");
    pancakeSwapOracle = (await upgrades.deployProxy(PancakeSwapOracleFactory, [accessControlManager.address], {
      constructorArgs: [resilientOracle.address],
      unsafeAllow: ["constructor", "internal-function-storage"],
    })) as PancakeSwapOracle;

    return { pancakeSwapOracle, accessControlManager, resilientOracle, pancakePool, owner, user };
  }

  beforeEach(async () => {
    ({ pancakeSwapOracle, accessControlManager, resilientOracle, pancakePool, owner, user } =
      await loadFixture(deployFixture));
  });

  // ═══════════════════════════════════════════════════════════════════
  // 1. Initialization
  // ═══════════════════════════════════════════════════════════════════

  describe("Initialization", () => {
    it("should deploy with non-zero address", async () => {
      expect(pancakeSwapOracle.address).to.not.equal(ethers.constants.AddressZero);
    });

    it("should store RESILIENT_ORACLE immutable correctly", async () => {
      expect(await pancakeSwapOracle.RESILIENT_ORACLE()).to.equal(resilientOracle.address);
    });

    it("should reject re-initialization", async () => {
      await expect(pancakeSwapOracle.initialize(accessControlManager.address)).to.be.revertedWith(
        "Initializable: contract is already initialized",
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 2. setPoolConfig
  // ═══════════════════════════════════════════════════════════════════

  describe("setPoolConfig", () => {
    it("should store pool address in tokenPools mapping", async () => {
      await pancakeSwapOracle.setPoolConfig(TOKEN_A, pancakePool.address);
      expect(await pancakeSwapOracle.tokenPools(TOKEN_A)).to.equal(pancakePool.address);
    });

    it("should emit PoolConfigUpdated event", async () => {
      await expect(pancakeSwapOracle.setPoolConfig(TOKEN_A, pancakePool.address))
        .to.emit(pancakeSwapOracle, "PoolConfigUpdated")
        .withArgs(TOKEN_A, pancakePool.address);
    });

    it("should allow updating pool to a different one", async () => {
      const newPool = await smock.fake<IPancakeV3Pool>("IPancakeV3Pool");
      await pancakeSwapOracle.setPoolConfig(TOKEN_A, pancakePool.address);
      await pancakeSwapOracle.setPoolConfig(TOKEN_A, newPool.address);
      expect(await pancakeSwapOracle.tokenPools(TOKEN_A)).to.equal(newPool.address);
    });

    it("should configure multiple tokens independently", async () => {
      const pool2 = await smock.fake<IPancakeV3Pool>("IPancakeV3Pool");
      await pancakeSwapOracle.setPoolConfig(TOKEN_A, pancakePool.address);
      await pancakeSwapOracle.setPoolConfig(TOKEN_B, pool2.address);
      expect(await pancakeSwapOracle.tokenPools(TOKEN_A)).to.equal(pancakePool.address);
      expect(await pancakeSwapOracle.tokenPools(TOKEN_B)).to.equal(pool2.address);
    });

    it("should revert with ZeroAddress when token is zero", async () => {
      await expect(
        pancakeSwapOracle.setPoolConfig(ethers.constants.AddressZero, pancakePool.address),
      ).to.be.revertedWithCustomError(pancakeSwapOracle, "ZeroAddress");
    });

    it("should revert with ZeroAddress when pool is zero", async () => {
      await expect(
        pancakeSwapOracle.setPoolConfig(TOKEN_A, ethers.constants.AddressZero),
      ).to.be.revertedWithCustomError(pancakeSwapOracle, "ZeroAddress");
    });

    it("should revert with ZeroAddress when both token and pool are zero", async () => {
      await expect(
        pancakeSwapOracle.setPoolConfig(ethers.constants.AddressZero, ethers.constants.AddressZero),
      ).to.be.revertedWithCustomError(pancakeSwapOracle, "ZeroAddress");
    });

    it("should revert when caller is not authorized", async () => {
      accessControlManager.isAllowedToCall.returns(false);
      await expect(pancakeSwapOracle.setPoolConfig(TOKEN_A, pancakePool.address)).to.be.reverted;
      accessControlManager.isAllowedToCall.returns(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 3. getPrice — revert cases
  // ═══════════════════════════════════════════════════════════════════

  describe("getPrice — revert cases", () => {
    it("should revert with TokenNotConfigured when token has no pool", async () => {
      await expect(pancakeSwapOracle.getPrice(TOKEN_C)).to.be.revertedWithCustomError(
        pancakeSwapOracle,
        "TokenNotConfigured",
      );
    });

    it("should revert with InvalidPool when token is neither token0 nor token1 of the pool", async () => {
      await pancakeSwapOracle.setPoolConfig(TOKEN_A, pancakePool.address);

      // Pool's token0 and token1 are both different from TOKEN_A
      pancakePool.token0.returns(TOKEN_B);
      pancakePool.token1.returns(TOKEN_C);
      pancakePool.slot0.returns(slot0(Q96));

      await expect(pancakeSwapOracle.getPrice(TOKEN_A)).to.be.revertedWithCustomError(
        pancakeSwapOracle,
        "InvalidPool",
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 4. getPrice — target is token0 (price calculation)
  //
  // Pool: token0 = TARGET, token1 = REF (WBNB)
  // sqrtPriceX96 encodes sqrt(token1/token0) * 2^96
  //
  // When sqrtPriceX96 = Q96 → price ratio = 1:1
  //   targetTokensPerRef = Q96 * 1e18 / Q96 = 1e18
  //   price = refPrice * 1e18 / 1e18 = refPrice
  //
  // When sqrtPriceX96 = 2*Q96 → price ratio = 4:1
  //   targetTokensPerRef = Q96 * 1e18 / (4*Q96) = 0.25e18
  //   price = refPrice * 1e18 / 0.25e18 = 4 * refPrice
  // ═══════════════════════════════════════════════════════════════════

  describe("getPrice — target is token0", () => {
    const REF_PRICE = parseUnits("600", 18); // $600 reference token

    beforeEach(async () => {
      await pancakeSwapOracle.setPoolConfig(TOKEN_A, pancakePool.address);
      pancakePool.token0.returns(TOKEN_A);
      pancakePool.token1.returns(WBNB);
      resilientOracle.getPrice.whenCalledWith(WBNB).returns(REF_PRICE);
    });

    it("should return correct price when price ratio is 1:1 (sqrtPriceX96 = Q96)", async () => {
      pancakePool.slot0.returns(slot0(Q96));
      // 1 TARGET = 1 WBNB → TARGET price = WBNB price = $600
      expect(await pancakeSwapOracle.getPrice(TOKEN_A)).to.equal(REF_PRICE);
    });

    it("should return correct price when target is worth MORE than reference (sqrtPriceX96 = 2*Q96)", async () => {
      pancakePool.slot0.returns(slot0(Q96.mul(2)));
      // price ratio = 4 → 1 TARGET costs 4 WBNB → TARGET price = 4 * $600 = $2400
      expect(await pancakeSwapOracle.getPrice(TOKEN_A)).to.equal(parseUnits("2400", 18));
    });

    it("should return correct price when target is worth LESS than reference (sqrtPriceX96 = Q96/2)", async () => {
      pancakePool.slot0.returns(slot0(Q96.div(2)));
      // price ratio = 0.25 → 1 TARGET costs 0.25 WBNB → TARGET price = 0.25 * $600 = $150
      expect(await pancakeSwapOracle.getPrice(TOKEN_A)).to.equal(parseUnits("150", 18));
    });

    it("should call resilient oracle for reference token (token1) price", async () => {
      pancakePool.slot0.returns(slot0(Q96));
      await pancakeSwapOracle.getPrice(TOKEN_A);
      expect(resilientOracle.getPrice).to.have.been.calledWith(WBNB);
    });

    it("should call pool's slot0, token0, and token1", async () => {
      pancakePool.slot0.returns(slot0(Q96));
      await pancakeSwapOracle.getPrice(TOKEN_A);
      expect(pancakePool.slot0).to.have.been.called;
      expect(pancakePool.token0).to.have.been.called;
      expect(pancakePool.token1).to.have.been.called;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 5. getPrice — target is token1 (price calculation)
  //
  // Pool: token0 = REF (WBNB), token1 = TARGET
  //
  // When sqrtPriceX96 = Q96 → price ratio (token1/token0) = 1:1
  //   targetTokensPerRef = Q96 * 1e18 / Q96 = 1e18
  //   price = refPrice * 1e18 / 1e18 = refPrice
  //
  // When sqrtPriceX96 = 2*Q96 → price ratio = 4:1
  //   targetTokensPerRef = 4*Q96 * 1e18 / Q96 = 4e18
  //   price = refPrice * 1e18 / 4e18 = refPrice / 4
  // ═══════════════════════════════════════════════════════════════════

  describe("getPrice — target is token1", () => {
    const REF_PRICE = parseUnits("600", 18);

    beforeEach(async () => {
      await pancakeSwapOracle.setPoolConfig(TOKEN_A, pancakePool.address);
      pancakePool.token0.returns(WBNB);
      pancakePool.token1.returns(TOKEN_A);
      resilientOracle.getPrice.whenCalledWith(WBNB).returns(REF_PRICE);
    });

    it("should return correct price when price ratio is 1:1 (sqrtPriceX96 = Q96)", async () => {
      pancakePool.slot0.returns(slot0(Q96));
      // 1 TARGET = 1 WBNB → TARGET price = $600
      expect(await pancakeSwapOracle.getPrice(TOKEN_A)).to.equal(REF_PRICE);
    });

    it("should return correct price when target is worth LESS than reference (sqrtPriceX96 = 2*Q96)", async () => {
      pancakePool.slot0.returns(slot0(Q96.mul(2)));
      // price ratio = 4 → 4 token1 per token0 → TARGET is worth 1/4 of REF = $150
      expect(await pancakeSwapOracle.getPrice(TOKEN_A)).to.equal(parseUnits("150", 18));
    });

    it("should return correct price when target is worth MORE than reference (sqrtPriceX96 = Q96/2)", async () => {
      pancakePool.slot0.returns(slot0(Q96.div(2)));
      // price ratio = 0.25 → 0.25 token1 per token0 → TARGET is worth 4x REF = $2400
      expect(await pancakeSwapOracle.getPrice(TOKEN_A)).to.equal(parseUnits("2400", 18));
    });

    it("should call resilient oracle for reference token (token0) price", async () => {
      pancakePool.slot0.returns(slot0(Q96));
      await pancakeSwapOracle.getPrice(TOKEN_A);
      expect(resilientOracle.getPrice).to.have.been.calledWith(WBNB);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 6. getPrice — pool config update mid-flight
  // ═══════════════════════════════════════════════════════════════════

  describe("getPrice — pool reconfiguration", () => {
    it("should use the latest pool config after update", async () => {
      const pool2 = await smock.fake<IPancakeV3Pool>("IPancakeV3Pool");
      const REF_PRICE = parseUnits("600", 18);

      // First pool: 1:1 ratio
      await pancakeSwapOracle.setPoolConfig(TOKEN_A, pancakePool.address);
      pancakePool.token0.returns(TOKEN_A);
      pancakePool.token1.returns(WBNB);
      pancakePool.slot0.returns(slot0(Q96));
      resilientOracle.getPrice.whenCalledWith(WBNB).returns(REF_PRICE);
      expect(await pancakeSwapOracle.getPrice(TOKEN_A)).to.equal(REF_PRICE);

      // Reconfigure to pool2: 4:1 ratio
      await pancakeSwapOracle.setPoolConfig(TOKEN_A, pool2.address);
      pool2.token0.returns(TOKEN_A);
      pool2.token1.returns(WBNB);
      pool2.slot0.returns(slot0(Q96.mul(2)));
      expect(await pancakeSwapOracle.getPrice(TOKEN_A)).to.equal(parseUnits("2400", 18));
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 7. getPrice — different reference token prices
  // ═══════════════════════════════════════════════════════════════════

  describe("getPrice — varying reference prices", () => {
    beforeEach(async () => {
      await pancakeSwapOracle.setPoolConfig(TOKEN_A, pancakePool.address);
      pancakePool.token0.returns(TOKEN_A);
      pancakePool.token1.returns(WBNB);
      pancakePool.slot0.returns(slot0(Q96)); // 1:1 ratio
    });

    it("should scale correctly with a high reference price ($90000)", async () => {
      resilientOracle.getPrice.whenCalledWith(WBNB).returns(parseUnits("90000", 18));
      expect(await pancakeSwapOracle.getPrice(TOKEN_A)).to.equal(parseUnits("90000", 18));
    });

    it("should scale correctly with a low reference price ($0.01)", async () => {
      resilientOracle.getPrice.whenCalledWith(WBNB).returns(parseUnits("0.01", 18));
      expect(await pancakeSwapOracle.getPrice(TOKEN_A)).to.equal(parseUnits("0.01", 18));
    });

    it("should scale correctly with a very small reference price ($0.000001)", async () => {
      resilientOracle.getPrice.whenCalledWith(WBNB).returns(parseUnits("0.000001", 18));
      expect(await pancakeSwapOracle.getPrice(TOKEN_A)).to.equal(parseUnits("0.000001", 18));
    });
  });
});
