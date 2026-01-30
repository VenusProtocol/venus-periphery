import { FakeContract, smock } from "@defi-wonderland/smock";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import chai from "chai";
import { parseUnits } from "ethers/lib/utils";
import { ethers, upgrades } from "hardhat";

import type {
  DeviationSentinel,
  IAccessControlManagerV8,
  ICorePoolComptroller,
  IVToken,
  OracleInterface,
  ResilientOracleInterface,
} from "../../../typechain";

const { expect } = chai;
chai.use(smock.matchers);

describe("DeviationSentinel", () => {
  let deviationSentinel: DeviationSentinel;
  let accessControlManager: FakeContract<IAccessControlManagerV8>;
  let corePoolComptroller: FakeContract<ICorePoolComptroller>;
  let resilientOracle: FakeContract<ResilientOracleInterface>;
  let sentinelOracle: FakeContract<OracleInterface>;
  let vToken: FakeContract<IVToken>;
  let owner: SignerWithAddress;
  let keeper: SignerWithAddress;
  let user: SignerWithAddress;

  const UNDERLYING_ASSET = "0x0000000000000000000000000000000000000001";
  const POOL_ID = 0;

  async function deployFixture() {
    [owner, keeper, user] = await ethers.getSigners();

    // Create mocks
    accessControlManager = await smock.fake<IAccessControlManagerV8>("IAccessControlManagerV8");
    corePoolComptroller = await smock.fake<ICorePoolComptroller>("ICorePoolComptroller");
    resilientOracle = await smock.fake<ResilientOracleInterface>("ResilientOracleInterface");
    sentinelOracle = await smock.fake<OracleInterface>("OracleInterface");
    vToken = await smock.fake<IVToken>("IVToken");

    // Setup ACM to allow owner
    accessControlManager.isAllowedToCall.returns(true);

    // Setup vToken
    vToken.underlying.returns(UNDERLYING_ASSET);
    vToken.comptroller.returns(corePoolComptroller.address);

    // Deploy DeviationSentinel
    const DeviationSentinelFactory = await ethers.getContractFactory("DeviationSentinel");
    deviationSentinel = (await upgrades.deployProxy(DeviationSentinelFactory, [accessControlManager.address], {
      constructorArgs: [corePoolComptroller.address, resilientOracle.address, sentinelOracle.address],
      unsafeAllow: ["constructor", "internal-function-storage"],
    })) as DeviationSentinel;

    return {
      deviationSentinel,
      accessControlManager,
      corePoolComptroller,
      resilientOracle,
      sentinelOracle,
      vToken,
      owner,
      keeper,
      user,
    };
  }

  beforeEach(async () => {
    ({
      deviationSentinel,
      accessControlManager,
      corePoolComptroller,
      resilientOracle,
      sentinelOracle,
      vToken,
      owner,
      keeper,
      user,
    } = await loadFixture(deployFixture));
  });

  describe("Initialization", () => {
    it("should deploy successfully", async () => {
      expect(deviationSentinel.address).to.not.equal(ethers.constants.AddressZero);
    });

    it("should set immutable addresses correctly", async () => {
      expect(await deviationSentinel.CORE_POOL_COMPTROLLER()).to.equal(corePoolComptroller.address);
      expect(await deviationSentinel.RESILIENT_ORACLE()).to.equal(resilientOracle.address);
      expect(await deviationSentinel.SENTINEL_ORACLE()).to.equal(sentinelOracle.address);
    });
  });

  describe("setTokenConfig", () => {
    it("should set token configuration", async () => {
      await deviationSentinel.setTokenConfig(UNDERLYING_ASSET, {
        deviation: 10,
        enabled: true,
      });

      const config = await deviationSentinel.tokenConfigs(UNDERLYING_ASSET);
      expect(config.deviation).to.equal(10);
      expect(config.enabled).to.be.true;
    });

    it("should emit TokenConfigUpdated event", async () => {
      await expect(
        deviationSentinel.setTokenConfig(UNDERLYING_ASSET, {
          deviation: 10,
          enabled: true,
        }),
      )
        .to.emit(deviationSentinel, "TokenConfigUpdated")
        .withArgs(UNDERLYING_ASSET, [10, true]);
    });

    it("should revert if deviation is too high", async () => {
      await expect(
        deviationSentinel.setTokenConfig(UNDERLYING_ASSET, {
          deviation: 101,
          enabled: true,
        }),
      ).to.be.revertedWithCustomError(deviationSentinel, "ExceedsMaxDeviation");
    });
  });

  describe("setTrustedKeeper", () => {
    it("should set keeper as trusted", async () => {
      await deviationSentinel.setTrustedKeeper(keeper.address, true);
      expect(await deviationSentinel.trustedKeepers(keeper.address)).to.be.true;
    });

    it("should remove keeper from trusted", async () => {
      await deviationSentinel.setTrustedKeeper(keeper.address, true);
      await deviationSentinel.setTrustedKeeper(keeper.address, false);
      expect(await deviationSentinel.trustedKeepers(keeper.address)).to.be.false;
    });

    it("should emit TrustedKeeperUpdated event", async () => {
      await expect(deviationSentinel.setTrustedKeeper(keeper.address, true))
        .to.emit(deviationSentinel, "TrustedKeeperUpdated")
        .withArgs(keeper.address, true);
    });
  });

  describe("checkPriceDeviation", () => {
    beforeEach(async () => {
      await deviationSentinel.setTokenConfig(UNDERLYING_ASSET, {
        deviation: 10,
        enabled: true,
      });
    });

    it("should detect no deviation when prices are similar", async () => {
      resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
      sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("105", 18));

      const result = await deviationSentinel.checkPriceDeviation(vToken.address);
      expect(result.hasDeviation).to.be.false;
    });

    it("should detect deviation when sentinel price is higher", async () => {
      resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
      sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("115", 18));

      const result = await deviationSentinel.checkPriceDeviation(vToken.address);
      expect(result.hasDeviation).to.be.true;
      // sentinelPrice > oraclePrice indicates sentinel price is higher
      expect(result.sentinelPrice).to.be.gt(result.oraclePrice);
    });

    it("should detect deviation when sentinel price is lower", async () => {
      resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
      sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("85", 18));

      const result = await deviationSentinel.checkPriceDeviation(vToken.address);
      expect(result.hasDeviation).to.be.true;
      // sentinelPrice < oraclePrice indicates sentinel price is lower
      expect(result.sentinelPrice).to.be.lt(result.oraclePrice);
    });

    it("should detect deviation even if token is disabled", async () => {
      await deviationSentinel.setTokenConfig(UNDERLYING_ASSET, {
        deviation: 10,
        enabled: false,
      });

      resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
      sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("200", 18));

      const result = await deviationSentinel.checkPriceDeviation(vToken.address);
      // checkPriceDeviation is a view function that always calculates deviation
      // The enabled flag is only checked in handleDeviation
      expect(result.hasDeviation).to.be.true;
    });
  });

  describe("handleDeviation", () => {
    beforeEach(async () => {
      await deviationSentinel.setTokenConfig(UNDERLYING_ASSET, {
        deviation: 10,
        enabled: true,
      });
      await deviationSentinel.setTrustedKeeper(keeper.address, true);
    });

    it("should pause borrow when sentinel price is higher", async () => {
      resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
      sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("115", 18));

      corePoolComptroller.actionPaused.returns(false);

      await deviationSentinel.connect(keeper).handleDeviation(vToken.address);

      expect(corePoolComptroller.setActionsPaused).to.have.been.called;
    });

    it("should pause supply when sentinel price is lower", async () => {
      resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
      sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("85", 18));

      corePoolComptroller.actionPaused.returns(false);

      await deviationSentinel.connect(keeper).handleDeviation(vToken.address);

      expect(corePoolComptroller.setActionsPaused).to.have.been.called;
    });

    it("should unpause when deviation is resolved", async () => {
      // First cause deviation
      resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
      sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("115", 18));
      corePoolComptroller.actionPaused.returns(false);

      await deviationSentinel.connect(keeper).handleDeviation(vToken.address);

      // Then resolve deviation
      sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("105", 18));
      corePoolComptroller.actionPaused.returns(true);

      await deviationSentinel.connect(keeper).handleDeviation(vToken.address);

      expect(corePoolComptroller.setActionsPaused).to.have.been.called;
    });

    it("should revert if caller is not trusted keeper", async () => {
      resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
      sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("115", 18));

      await expect(deviationSentinel.connect(user).handleDeviation(vToken.address)).to.be.revertedWithCustomError(
        deviationSentinel,
        "UnauthorizedKeeper",
      );
    });
  });

  describe("_restoreCollateralFactor protection against new pools", () => {
    const NEW_POOL_ID = 2;
    const ORIGINAL_CF = parseUnits("0.7", 18);
    const ORIGINAL_LT = parseUnits("0.75", 18);
    const NEW_POOL_CF = parseUnits("0.6", 18);
    const NEW_POOL_LT = parseUnits("0.65", 18);

    beforeEach(async () => {
      await deviationSentinel.setTokenConfig(UNDERLYING_ASSET, {
        deviation: 10,
        enabled: true,
      });
      await deviationSentinel.setTrustedKeeper(keeper.address, true);

      // Setup core pool comptroller
      corePoolComptroller.corePoolId.returns(0);
      corePoolComptroller.lastPoolId.returns(1); // Initially only pools 0 and 1
      corePoolComptroller["setCollateralFactor(uint96,address,uint256,uint256)"].returns(0);

      // Setup existing pool (pool 1) with original CF and LT
      corePoolComptroller.poolMarkets
        .whenCalledWith(1, vToken.address)
        .returns([true, ORIGINAL_CF, 0, ORIGINAL_LT, 0, 0, 0]);

      corePoolComptroller.actionPaused.returns(false);
    });

    it("should skip restoring CF for new pools added after _setCollateralFactorToZero", async () => {
      // Trigger deviation to store original CF for pool 1
      resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
      sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("85", 18)); // Lower price triggers supply pause

      await deviationSentinel.connect(keeper).handleDeviation(vToken.address);

      // Simulate adding a new pool (pool 2) after deviation was triggered
      corePoolComptroller.lastPoolId.returns(2); // Now includes pool 2
      corePoolComptroller.poolMarkets
        .whenCalledWith(NEW_POOL_ID, vToken.address)
        .returns([true, NEW_POOL_CF, 0, NEW_POOL_LT, 0, 0, 0]);

      // Resolve deviation - should restore pool 1 but skip pool 2
      sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("105", 18));
      corePoolComptroller.actionPaused.returns(true);

      // Reset call count before resolution
      corePoolComptroller["setCollateralFactor(uint96,address,uint256,uint256)"].reset();

      await deviationSentinel.connect(keeper).handleDeviation(vToken.address);

      // Verify setCollateralFactor was called for pool 1 restoration
      // Should restore the original CF (0.7) that was stored during deviation
      expect(corePoolComptroller["setCollateralFactor(uint96,address,uint256,uint256)"]).to.have.been.calledWith(
        1,
        vToken.address,
        ORIGINAL_CF, // Restored original CF
        ORIGINAL_LT,
      );

      // Verify setCollateralFactor was NOT called for new pool 2
      // Check that it wasn't called with NEW_POOL_ID
      expect(corePoolComptroller["setCollateralFactor(uint96,address,uint256,uint256)"]).to.not.have.been.calledWith(
        NEW_POOL_ID,
        vToken.address,
      );
    });

    it("should skip restoring when stored LT is 0 to prevent immediate liquidation", async () => {
      // Setup a pool with CF = 0 and LT = 0 (edge case)
      corePoolComptroller.poolMarkets.whenCalledWith(1, vToken.address).returns([true, 0, 0, 0, 0, 0, 0]);

      // Trigger deviation
      resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
      sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("85", 18));

      await deviationSentinel.connect(keeper).handleDeviation(vToken.address);

      // Reset the mock to clear previous calls during deviation trigger
      corePoolComptroller["setCollateralFactor(uint96,address,uint256,uint256)"].reset();

      // Resolve deviation
      sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("105", 18));
      corePoolComptroller.actionPaused.returns(true);

      await deviationSentinel.connect(keeper).handleDeviation(vToken.address);

      // Should not attempt to restore LT = 0
      // When stored LT is 0, setCollateralFactor should not be called to prevent liquidation risk
      expect(corePoolComptroller["setCollateralFactor(uint96,address,uint256,uint256)"]).to.not.have.been.called;
    });

    it("should properly restore original CF when pool had CF=0 originally", async () => {
      // Setup a pool that originally had CF = 0 but LT > 0
      const ZERO_CF = ethers.constants.Zero;
      const VALID_LT = parseUnits("0.75", 18);

      corePoolComptroller.poolMarkets.whenCalledWith(1, vToken.address).returns([true, ZERO_CF, 0, VALID_LT, 0, 0, 0]);

      // Trigger deviation
      resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
      sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("85", 18));

      await deviationSentinel.connect(keeper).handleDeviation(vToken.address);

      // Resolve deviation
      sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("105", 18));
      corePoolComptroller.actionPaused.returns(true);

      await deviationSentinel.connect(keeper).handleDeviation(vToken.address);

      // Should restore CF = 0 (original value) because LT > 0
      expect(corePoolComptroller["setCollateralFactor(uint96,address,uint256,uint256)"]).to.have.been.calledWith(
        1,
        vToken.address,
        ZERO_CF,
        VALID_LT,
      );
    });
  });
});
