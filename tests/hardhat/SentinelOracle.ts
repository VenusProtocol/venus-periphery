import { FakeContract, smock } from "@defi-wonderland/smock";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import chai from "chai";
import { parseUnits } from "ethers/lib/utils";
import { ethers, upgrades } from "hardhat";

import type { IAccessControlManagerV8, OracleInterface, SentinelOracle } from "../../typechain";

const { expect } = chai;
chai.use(smock.matchers);

describe("SentinelOracle", () => {
  let sentinelOracle: SentinelOracle;
  let accessControlManager: FakeContract<IAccessControlManagerV8>;
  let pancakeSwapOracle: FakeContract<OracleInterface>;
  let uniswapOracle: FakeContract<OracleInterface>;
  let owner: SignerWithAddress;
  let user: SignerWithAddress;

  const TOKEN_A = "0x0000000000000000000000000000000000000001";
  const TOKEN_B = "0x0000000000000000000000000000000000000002";

  async function deployFixture() {
    [owner, user] = await ethers.getSigners();

    // Create mocks
    accessControlManager = await smock.fake<IAccessControlManagerV8>("IAccessControlManagerV8");
    pancakeSwapOracle = await smock.fake<OracleInterface>("OracleInterface");
    uniswapOracle = await smock.fake<OracleInterface>("OracleInterface");

    // Setup ACM to allow owner
    accessControlManager.isAllowedToCall.returns(true);

    // Deploy SentinelOracle
    const SentinelOracleFactory = await ethers.getContractFactory("SentinelOracle");
    sentinelOracle = (await upgrades.deployProxy(SentinelOracleFactory, [accessControlManager.address], {
      unsafeAllow: ["constructor", "internal-function-storage"],
    })) as SentinelOracle;

    return {
      sentinelOracle,
      accessControlManager,
      pancakeSwapOracle,
      uniswapOracle,
      owner,
      user,
    };
  }

  beforeEach(async () => {
    ({ sentinelOracle, accessControlManager, pancakeSwapOracle, uniswapOracle, owner, user } =
      await loadFixture(deployFixture));
  });

  describe("Initialization", () => {
    it("should deploy successfully", async () => {
      expect(sentinelOracle.address).to.not.equal(ethers.constants.AddressZero);
    });
  });

  describe("setTokenOracleConfig", () => {
    it("should set oracle configuration for a token", async () => {
      await sentinelOracle.setTokenOracleConfig(TOKEN_A, pancakeSwapOracle.address);

      const config = await sentinelOracle.tokenConfigs(TOKEN_A);
      // TokenConfig struct returns a tuple [oracle]
      const configStr = config.toString().toLowerCase();
      expect(configStr).to.include(pancakeSwapOracle.address.toLowerCase());
    });

    it("should emit TokenOracleConfigUpdated event", async () => {
      await expect(sentinelOracle.setTokenOracleConfig(TOKEN_A, pancakeSwapOracle.address))
        .to.emit(sentinelOracle, "TokenOracleConfigUpdated")
        .withArgs(TOKEN_A, pancakeSwapOracle.address);
    });

    it("should allow updating oracle configuration", async () => {
      await sentinelOracle.setTokenOracleConfig(TOKEN_A, pancakeSwapOracle.address);
      await sentinelOracle.setTokenOracleConfig(TOKEN_A, uniswapOracle.address);

      const config = await sentinelOracle.tokenConfigs(TOKEN_A);
      const configStr = config.toString().toLowerCase();
      expect(configStr).to.include(uniswapOracle.address.toLowerCase());
    });

    it("should revert if oracle address is zero", async () => {
      await expect(
        sentinelOracle.setTokenOracleConfig(TOKEN_A, ethers.constants.AddressZero),
      ).to.be.revertedWithCustomError(sentinelOracle, "ZeroAddress");
    });

    it("should revert if token address is zero", async () => {
      await expect(
        sentinelOracle.setTokenOracleConfig(ethers.constants.AddressZero, pancakeSwapOracle.address),
      ).to.be.revertedWithCustomError(sentinelOracle, "ZeroAddress");
    });
  });

  describe("getPrice", () => {
    beforeEach(async () => {
      await sentinelOracle.setTokenOracleConfig(TOKEN_A, pancakeSwapOracle.address);
      await sentinelOracle.setTokenOracleConfig(TOKEN_B, uniswapOracle.address);
    });

    it("should get price from configured oracle", async () => {
      const expectedPrice = parseUnits("100", 18);
      pancakeSwapOracle.getPrice.whenCalledWith(TOKEN_A).returns(expectedPrice);

      const price = await sentinelOracle.getPrice(TOKEN_A);
      expect(price).to.equal(expectedPrice);
    });

    it("should route different tokens to different oracles", async () => {
      const priceA = parseUnits("100", 18);
      const priceB = parseUnits("200", 18);

      pancakeSwapOracle.getPrice.whenCalledWith(TOKEN_A).returns(priceA);
      uniswapOracle.getPrice.whenCalledWith(TOKEN_B).returns(priceB);

      expect(await sentinelOracle.getPrice(TOKEN_A)).to.equal(priceA);
      expect(await sentinelOracle.getPrice(TOKEN_B)).to.equal(priceB);
    });

    it("should call the oracle with correct token address", async () => {
      const expectedPrice = parseUnits("150", 18);
      pancakeSwapOracle.getPrice.returns(expectedPrice);

      await sentinelOracle.getPrice(TOKEN_A);

      expect(pancakeSwapOracle.getPrice).to.have.been.calledWith(TOKEN_A);
    });

    it("should revert if no oracle is configured for token", async () => {
      const TOKEN_C = "0x0000000000000000000000000000000000000003";
      await expect(sentinelOracle.getPrice(TOKEN_C)).to.be.revertedWithCustomError(
        sentinelOracle,
        "TokenNotConfigured",
      );
    });
  });
});
