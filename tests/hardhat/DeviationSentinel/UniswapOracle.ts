import { FakeContract, smock } from "@defi-wonderland/smock";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import chai from "chai";
import { BigNumber } from "ethers";
import { parseUnits } from "ethers/lib/utils";
import { ethers, upgrades } from "hardhat";

import type {
  IAccessControlManagerV8,
  IUniswapV3Pool,
  ResilientOracleInterface,
  UniswapOracle,
} from "../../../typechain";

const { expect } = chai;
chai.use(smock.matchers);

// Q96 = 2^96 — the fixed-point scaling factor used by Uniswap/PancakeSwap V3
const Q96 = BigNumber.from(2).pow(96);

describe("UniswapOracle", () => {
  let uniswapOracle: UniswapOracle;
  let accessControlManager: FakeContract<IAccessControlManagerV8>;
  let resilientOracle: FakeContract<ResilientOracleInterface>;
  let uniswapPool: FakeContract<IUniswapV3Pool>;
  let owner: SignerWithAddress;
  let user: SignerWithAddress;

  const TOKEN_A = "0x0000000000000000000000000000000000000001";
  const TOKEN_B = "0x0000000000000000000000000000000000000002";
  const TOKEN_C = "0x0000000000000000000000000000000000000003";
  const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";

  /**
   * Helper: build a slot0 return tuple.
   * Uniswap V3 slot0 returns:
   *   (uint160 sqrtPriceX96, int24 tick, uint16 obsIndex,
   *    uint16 obsCardinality, uint16 obsCardinalityNext,
   *    uint8 feeProtocol, bool unlocked)
   */
  function slot0(sqrtPriceX96: BigNumber) {
    return [sqrtPriceX96, 0, 0, 0, 0, 0, true];
  }

  async function deployFixture() {
    [owner, user] = await ethers.getSigners();

    accessControlManager = await smock.fake<IAccessControlManagerV8>("IAccessControlManagerV8");
    resilientOracle = await smock.fake<ResilientOracleInterface>("ResilientOracleInterface");
    uniswapPool = await smock.fake<IUniswapV3Pool>("IUniswapV3Pool");

    accessControlManager.isAllowedToCall.returns(true);

    const UniswapOracleFactory = await ethers.getContractFactory("UniswapOracle");
    uniswapOracle = (await upgrades.deployProxy(UniswapOracleFactory, [accessControlManager.address], {
      constructorArgs: [resilientOracle.address],
      unsafeAllow: ["constructor", "internal-function-storage"],
    })) as UniswapOracle;

    return { uniswapOracle, accessControlManager, resilientOracle, uniswapPool, owner, user };
  }

  beforeEach(async () => {
    ({ uniswapOracle, accessControlManager, resilientOracle, uniswapPool, owner, user } =
      await loadFixture(deployFixture));
  });

  // ═══════════════════════════════════════════════════════════════════
  // 1. Initialization
  // ═══════════════════════════════════════════════════════════════════

  describe("Initialization", () => {
    it("should deploy with non-zero address", async () => {
      expect(uniswapOracle.address).to.not.equal(ethers.constants.AddressZero);
    });

    it("should store RESILIENT_ORACLE immutable correctly", async () => {
      expect(await uniswapOracle.RESILIENT_ORACLE()).to.equal(resilientOracle.address);
    });

    it("should reject re-initialization", async () => {
      await expect(uniswapOracle.initialize(accessControlManager.address)).to.be.revertedWith(
        "Initializable: contract is already initialized",
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 2. setPoolConfig
  // ═══════════════════════════════════════════════════════════════════

  describe("setPoolConfig", () => {
    it("should store pool address in tokenPools mapping", async () => {
      await uniswapOracle.setPoolConfig(TOKEN_A, uniswapPool.address);
      expect(await uniswapOracle.tokenPools(TOKEN_A)).to.equal(uniswapPool.address);
    });

    it("should emit PoolConfigUpdated event", async () => {
      await expect(uniswapOracle.setPoolConfig(TOKEN_A, uniswapPool.address))
        .to.emit(uniswapOracle, "PoolConfigUpdated")
        .withArgs(TOKEN_A, uniswapPool.address);
    });

    it("should allow updating pool to a different one", async () => {
      const newPool = await smock.fake<IUniswapV3Pool>("IUniswapV3Pool");
      await uniswapOracle.setPoolConfig(TOKEN_A, uniswapPool.address);
      await uniswapOracle.setPoolConfig(TOKEN_A, newPool.address);
      expect(await uniswapOracle.tokenPools(TOKEN_A)).to.equal(newPool.address);
    });

    it("should configure multiple tokens independently", async () => {
      const pool2 = await smock.fake<IUniswapV3Pool>("IUniswapV3Pool");
      await uniswapOracle.setPoolConfig(TOKEN_A, uniswapPool.address);
      await uniswapOracle.setPoolConfig(TOKEN_B, pool2.address);
      expect(await uniswapOracle.tokenPools(TOKEN_A)).to.equal(uniswapPool.address);
      expect(await uniswapOracle.tokenPools(TOKEN_B)).to.equal(pool2.address);
    });

    it("should revert with ZeroAddress when token is zero", async () => {
      await expect(
        uniswapOracle.setPoolConfig(ethers.constants.AddressZero, uniswapPool.address),
      ).to.be.revertedWithCustomError(uniswapOracle, "ZeroAddress");
    });

    it("should revert with ZeroAddress when pool is zero", async () => {
      await expect(uniswapOracle.setPoolConfig(TOKEN_A, ethers.constants.AddressZero)).to.be.revertedWithCustomError(
        uniswapOracle,
        "ZeroAddress",
      );
    });

    it("should revert with ZeroAddress when both token and pool are zero", async () => {
      await expect(
        uniswapOracle.setPoolConfig(ethers.constants.AddressZero, ethers.constants.AddressZero),
      ).to.be.revertedWithCustomError(uniswapOracle, "ZeroAddress");
    });

    it("should revert when caller is not authorized", async () => {
      accessControlManager.isAllowedToCall.returns(false);
      await expect(uniswapOracle.setPoolConfig(TOKEN_A, uniswapPool.address)).to.be.reverted;
      accessControlManager.isAllowedToCall.returns(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 3. getPrice — revert cases
  // ═══════════════════════════════════════════════════════════════════

  describe("getPrice — revert cases", () => {
    it("should revert with TokenNotConfigured when token has no pool", async () => {
      await expect(uniswapOracle.getPrice(TOKEN_C)).to.be.revertedWithCustomError(uniswapOracle, "TokenNotConfigured");
    });

    it("should revert with InvalidPool when token is neither token0 nor token1 of the pool", async () => {
      await uniswapOracle.setPoolConfig(TOKEN_A, uniswapPool.address);

      uniswapPool.token0.returns(TOKEN_B);
      uniswapPool.token1.returns(TOKEN_C);
      uniswapPool.slot0.returns(slot0(Q96));

      await expect(uniswapOracle.getPrice(TOKEN_A)).to.be.revertedWithCustomError(uniswapOracle, "InvalidPool");
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
    const REF_PRICE = parseUnits("600", 18);

    beforeEach(async () => {
      await uniswapOracle.setPoolConfig(TOKEN_A, uniswapPool.address);
      uniswapPool.token0.returns(TOKEN_A);
      uniswapPool.token1.returns(WBNB);
      resilientOracle.getPrice.whenCalledWith(WBNB).returns(REF_PRICE);
    });

    it("should return correct price when price ratio is 1:1 (sqrtPriceX96 = Q96)", async () => {
      uniswapPool.slot0.returns(slot0(Q96));
      expect(await uniswapOracle.getPrice(TOKEN_A)).to.equal(REF_PRICE);
    });

    it("should return correct price when target is worth MORE than reference (sqrtPriceX96 = 2*Q96)", async () => {
      uniswapPool.slot0.returns(slot0(Q96.mul(2)));
      // price ratio = 4 → TARGET = 4 * $600 = $2400
      expect(await uniswapOracle.getPrice(TOKEN_A)).to.equal(parseUnits("2400", 18));
    });

    it("should return correct price when target is worth LESS than reference (sqrtPriceX96 = Q96/2)", async () => {
      uniswapPool.slot0.returns(slot0(Q96.div(2)));
      // price ratio = 0.25 → TARGET = 0.25 * $600 = $150
      expect(await uniswapOracle.getPrice(TOKEN_A)).to.equal(parseUnits("150", 18));
    });

    it("should call resilient oracle for reference token (token1) price", async () => {
      uniswapPool.slot0.returns(slot0(Q96));
      await uniswapOracle.getPrice(TOKEN_A);
      expect(resilientOracle.getPrice).to.have.been.calledWith(WBNB);
    });

    it("should call pool's slot0, token0, and token1", async () => {
      uniswapPool.slot0.returns(slot0(Q96));
      await uniswapOracle.getPrice(TOKEN_A);
      expect(uniswapPool.slot0).to.have.been.called;
      expect(uniswapPool.token0).to.have.been.called;
      expect(uniswapPool.token1).to.have.been.called;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 5. getPrice — target is token1 (price calculation)
  //
  // Pool: token0 = REF (WBNB), token1 = TARGET
  //
  // When sqrtPriceX96 = Q96 → price ratio = 1:1
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
      await uniswapOracle.setPoolConfig(TOKEN_A, uniswapPool.address);
      uniswapPool.token0.returns(WBNB);
      uniswapPool.token1.returns(TOKEN_A);
      resilientOracle.getPrice.whenCalledWith(WBNB).returns(REF_PRICE);
    });

    it("should return correct price when price ratio is 1:1 (sqrtPriceX96 = Q96)", async () => {
      uniswapPool.slot0.returns(slot0(Q96));
      expect(await uniswapOracle.getPrice(TOKEN_A)).to.equal(REF_PRICE);
    });

    it("should return correct price when target is worth LESS than reference (sqrtPriceX96 = 2*Q96)", async () => {
      uniswapPool.slot0.returns(slot0(Q96.mul(2)));
      // price ratio = 4 → 4 token1 per token0 → TARGET = $600 / 4 = $150
      expect(await uniswapOracle.getPrice(TOKEN_A)).to.equal(parseUnits("150", 18));
    });

    it("should return correct price when target is worth MORE than reference (sqrtPriceX96 = Q96/2)", async () => {
      uniswapPool.slot0.returns(slot0(Q96.div(2)));
      // price ratio = 0.25 → 0.25 token1 per token0 → TARGET = $600 * 4 = $2400
      expect(await uniswapOracle.getPrice(TOKEN_A)).to.equal(parseUnits("2400", 18));
    });

    it("should call resilient oracle for reference token (token0) price", async () => {
      uniswapPool.slot0.returns(slot0(Q96));
      await uniswapOracle.getPrice(TOKEN_A);
      expect(resilientOracle.getPrice).to.have.been.calledWith(WBNB);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 6. getPrice — pool config update mid-flight
  // ═══════════════════════════════════════════════════════════════════

  describe("getPrice — pool reconfiguration", () => {
    it("should use the latest pool config after update", async () => {
      const pool2 = await smock.fake<IUniswapV3Pool>("IUniswapV3Pool");
      const REF_PRICE = parseUnits("600", 18);

      // First pool: 1:1 ratio
      await uniswapOracle.setPoolConfig(TOKEN_A, uniswapPool.address);
      uniswapPool.token0.returns(TOKEN_A);
      uniswapPool.token1.returns(WBNB);
      uniswapPool.slot0.returns(slot0(Q96));
      resilientOracle.getPrice.whenCalledWith(WBNB).returns(REF_PRICE);
      expect(await uniswapOracle.getPrice(TOKEN_A)).to.equal(REF_PRICE);

      // Reconfigure to pool2: 4:1 ratio
      await uniswapOracle.setPoolConfig(TOKEN_A, pool2.address);
      pool2.token0.returns(TOKEN_A);
      pool2.token1.returns(WBNB);
      pool2.slot0.returns(slot0(Q96.mul(2)));
      expect(await uniswapOracle.getPrice(TOKEN_A)).to.equal(parseUnits("2400", 18));
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 7. getPrice — different reference token prices
  // ═══════════════════════════════════════════════════════════════════

  describe("getPrice — varying reference prices", () => {
    beforeEach(async () => {
      await uniswapOracle.setPoolConfig(TOKEN_A, uniswapPool.address);
      uniswapPool.token0.returns(TOKEN_A);
      uniswapPool.token1.returns(WBNB);
      uniswapPool.slot0.returns(slot0(Q96)); // 1:1 ratio
    });

    it("should scale correctly with a high reference price ($90000)", async () => {
      resilientOracle.getPrice.whenCalledWith(WBNB).returns(parseUnits("90000", 18));
      expect(await uniswapOracle.getPrice(TOKEN_A)).to.equal(parseUnits("90000", 18));
    });

    it("should scale correctly with a low reference price ($0.01)", async () => {
      resilientOracle.getPrice.whenCalledWith(WBNB).returns(parseUnits("0.01", 18));
      expect(await uniswapOracle.getPrice(TOKEN_A)).to.equal(parseUnits("0.01", 18));
    });

    it("should scale correctly with a very small reference price ($0.000001)", async () => {
      resilientOracle.getPrice.whenCalledWith(WBNB).returns(parseUnits("0.000001", 18));
      expect(await uniswapOracle.getPrice(TOKEN_A)).to.equal(parseUnits("0.000001", 18));
    });
  });
});
