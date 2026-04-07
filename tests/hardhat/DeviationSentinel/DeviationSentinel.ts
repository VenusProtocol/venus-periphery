import { FakeContract, smock } from "@defi-wonderland/smock";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import chai from "chai";
import { parseUnits } from "ethers/lib/utils";
import { ethers, upgrades } from "hardhat";

import type {
  DeviationSentinel,
  IAccessControlManagerV8,
  IEBrake,
  IVToken,
  OracleInterface,
  ResilientOracleInterface,
} from "../../../typechain";

const { expect } = chai;
chai.use(smock.matchers);

describe("DeviationSentinel", () => {
  let deviationSentinel: DeviationSentinel;
  let accessControlManager: FakeContract<IAccessControlManagerV8>;
  let eBrake: FakeContract<IEBrake>;
  let resilientOracle: FakeContract<ResilientOracleInterface>;
  let sentinelOracle: FakeContract<OracleInterface>;
  let vToken: FakeContract<IVToken>;
  let owner: SignerWithAddress;
  let keeper: SignerWithAddress;
  let user: SignerWithAddress;

  const UNDERLYING_ASSET = "0x0000000000000000000000000000000000000001";
  const ZERO_ADDRESS = ethers.constants.AddressZero;

  /**
   * Deploys the DeviationSentinel behind an upgradeable proxy with all
   * required mock contracts wired up (ACM, EBrake, oracles, vToken).
   */
  async function deployFixture() {
    [owner, keeper, user] = await ethers.getSigners();

    // ── Mock contracts ──
    accessControlManager = await smock.fake<IAccessControlManagerV8>("IAccessControlManagerV8");
    eBrake = await smock.fake<IEBrake>("IEBrake");
    resilientOracle = await smock.fake<ResilientOracleInterface>("ResilientOracleInterface");
    sentinelOracle = await smock.fake<OracleInterface>("OracleInterface");
    vToken = await smock.fake<IVToken>("IVToken");

    // ACM allows all calls by default; override in access-control tests
    accessControlManager.isAllowedToCall.returns(true);
    vToken.underlying.returns(UNDERLYING_ASSET);

    // ── Deploy proxy ──
    const Factory = await ethers.getContractFactory("DeviationSentinel");
    deviationSentinel = (await upgrades.deployProxy(Factory, [accessControlManager.address], {
      constructorArgs: [eBrake.address, resilientOracle.address, sentinelOracle.address],
      unsafeAllow: ["constructor", "internal-function-storage"],
    })) as DeviationSentinel;

    return {
      deviationSentinel,
      accessControlManager,
      eBrake,
      resilientOracle,
      sentinelOracle,
      vToken,
      owner,
      keeper,
      user,
    };
  }

  beforeEach(async () => {
    ({ deviationSentinel, accessControlManager, eBrake, resilientOracle, sentinelOracle, vToken, owner, keeper, user } =
      await loadFixture(deployFixture));
  });

  // ═══════════════════════════════════════════════════════════════════
  // 1. Initialization
  // ═══════════════════════════════════════════════════════════════════

  describe("Initialization", () => {
    it("should deploy to a non-zero address", async () => {
      expect(deviationSentinel.address).to.not.equal(ZERO_ADDRESS);
    });

    it("should store immutable addresses correctly", async () => {
      expect(await deviationSentinel.EBRAKE()).to.equal(eBrake.address);
      expect(await deviationSentinel.RESILIENT_ORACLE()).to.equal(resilientOracle.address);
      expect(await deviationSentinel.SENTINEL_ORACLE()).to.equal(sentinelOracle.address);
    });

    it("should revert when eBrake_ is the zero address", async () => {
      const Factory = await ethers.getContractFactory("DeviationSentinel");
      await expect(
        upgrades.deployProxy(Factory, [accessControlManager.address], {
          constructorArgs: [ZERO_ADDRESS, resilientOracle.address, sentinelOracle.address],
          unsafeAllow: ["constructor", "internal-function-storage"],
        }),
      ).to.be.revertedWithCustomError(deviationSentinel, "ZeroAddress");
    });

    it("should revert when resilientOracle_ is the zero address", async () => {
      const Factory = await ethers.getContractFactory("DeviationSentinel");
      await expect(
        upgrades.deployProxy(Factory, [accessControlManager.address], {
          constructorArgs: [eBrake.address, ZERO_ADDRESS, sentinelOracle.address],
          unsafeAllow: ["constructor", "internal-function-storage"],
        }),
      ).to.be.revertedWithCustomError(deviationSentinel, "ZeroAddress");
    });

    it("should revert when sentinelOracle_ is the zero address", async () => {
      const Factory = await ethers.getContractFactory("DeviationSentinel");
      await expect(
        upgrades.deployProxy(Factory, [accessControlManager.address], {
          constructorArgs: [eBrake.address, resilientOracle.address, ZERO_ADDRESS],
          unsafeAllow: ["constructor", "internal-function-storage"],
        }),
      ).to.be.revertedWithCustomError(deviationSentinel, "ZeroAddress");
    });

    it("should reject re-initialization (initializer guard)", async () => {
      await expect(deviationSentinel.initialize(accessControlManager.address)).to.be.revertedWith(
        "Initializable: contract is already initialized",
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 2. setTokenConfig
  // ═══════════════════════════════════════════════════════════════════

  describe("setTokenConfig", () => {
    it("should store deviation and enabled flag", async () => {
      await deviationSentinel.setTokenConfig(UNDERLYING_ASSET, { deviation: 10, enabled: true });
      const config = await deviationSentinel.tokenConfigs(UNDERLYING_ASSET);
      expect(config.deviation).to.equal(10);
      expect(config.enabled).to.be.true;
    });

    it("should emit TokenConfigUpdated with correct args", async () => {
      await expect(deviationSentinel.setTokenConfig(UNDERLYING_ASSET, { deviation: 10, enabled: true }))
        .to.emit(deviationSentinel, "TokenConfigUpdated")
        .withArgs(UNDERLYING_ASSET, [10, true]);
    });

    it("should revert with ZeroDeviation when deviation is 0", async () => {
      await expect(
        deviationSentinel.setTokenConfig(UNDERLYING_ASSET, { deviation: 0, enabled: true }),
      ).to.be.revertedWithCustomError(deviationSentinel, "ZeroDeviation");
    });

    it("should revert with ExceedsMaxDeviation when deviation > 100", async () => {
      await expect(
        deviationSentinel.setTokenConfig(UNDERLYING_ASSET, { deviation: 101, enabled: true }),
      ).to.be.revertedWithCustomError(deviationSentinel, "ExceedsMaxDeviation");
    });

    it("should accept deviation == MAX_DEVIATION (100)", async () => {
      await deviationSentinel.setTokenConfig(UNDERLYING_ASSET, { deviation: 100, enabled: true });
      expect((await deviationSentinel.tokenConfigs(UNDERLYING_ASSET)).deviation).to.equal(100);
    });

    it("should accept the minimum valid deviation (1)", async () => {
      await deviationSentinel.setTokenConfig(UNDERLYING_ASSET, { deviation: 1, enabled: true });
      expect((await deviationSentinel.tokenConfigs(UNDERLYING_ASSET)).deviation).to.equal(1);
    });

    it("should revert with ZeroAddress when token is address(0)", async () => {
      await expect(
        deviationSentinel.setTokenConfig(ZERO_ADDRESS, { deviation: 10, enabled: true }),
      ).to.be.revertedWithCustomError(deviationSentinel, "ZeroAddress");
    });

    it("should overwrite a previous config with new values", async () => {
      await deviationSentinel.setTokenConfig(UNDERLYING_ASSET, { deviation: 10, enabled: true });
      await deviationSentinel.setTokenConfig(UNDERLYING_ASSET, { deviation: 50, enabled: false });
      const config = await deviationSentinel.tokenConfigs(UNDERLYING_ASSET);
      expect(config.deviation).to.equal(50);
      expect(config.enabled).to.be.false;
    });

    it("should allow setting config with enabled = false", async () => {
      await deviationSentinel.setTokenConfig(UNDERLYING_ASSET, { deviation: 5, enabled: false });
      expect((await deviationSentinel.tokenConfigs(UNDERLYING_ASSET)).enabled).to.be.false;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 3. setTrustedKeeper
  // ═══════════════════════════════════════════════════════════════════

  describe("setTrustedKeeper", () => {
    it("should mark a keeper as trusted", async () => {
      await deviationSentinel.setTrustedKeeper(keeper.address, true);
      expect(await deviationSentinel.trustedKeepers(keeper.address)).to.be.true;
    });

    it("should remove a keeper from trusted set", async () => {
      await deviationSentinel.setTrustedKeeper(keeper.address, true);
      await deviationSentinel.setTrustedKeeper(keeper.address, false);
      expect(await deviationSentinel.trustedKeepers(keeper.address)).to.be.false;
    });

    it("should emit TrustedKeeperUpdated(keeper, true) when adding", async () => {
      await expect(deviationSentinel.setTrustedKeeper(keeper.address, true))
        .to.emit(deviationSentinel, "TrustedKeeperUpdated")
        .withArgs(keeper.address, true);
    });

    it("should emit TrustedKeeperUpdated(keeper, false) when removing", async () => {
      await deviationSentinel.setTrustedKeeper(keeper.address, true);
      await expect(deviationSentinel.setTrustedKeeper(keeper.address, false))
        .to.emit(deviationSentinel, "TrustedKeeperUpdated")
        .withArgs(keeper.address, false);
    });

    it("should revert with ZeroAddress when keeper is address(0)", async () => {
      await expect(deviationSentinel.setTrustedKeeper(ZERO_ADDRESS, true)).to.be.revertedWithCustomError(
        deviationSentinel,
        "ZeroAddress",
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 4. setTokenMonitoringEnabled
  // ═══════════════════════════════════════════════════════════════════

  describe("setTokenMonitoringEnabled", () => {
    beforeEach(async () => {
      await deviationSentinel.setTokenConfig(UNDERLYING_ASSET, { deviation: 10, enabled: true });
    });

    it("should disable monitoring (keeps deviation unchanged)", async () => {
      await deviationSentinel.setTokenMonitoringEnabled(UNDERLYING_ASSET, false);
      const config = await deviationSentinel.tokenConfigs(UNDERLYING_ASSET);
      expect(config.enabled).to.be.false;
      expect(config.deviation).to.equal(10);
    });

    it("should re-enable monitoring after disabling", async () => {
      await deviationSentinel.setTokenMonitoringEnabled(UNDERLYING_ASSET, false);
      await deviationSentinel.setTokenMonitoringEnabled(UNDERLYING_ASSET, true);
      expect((await deviationSentinel.tokenConfigs(UNDERLYING_ASSET)).enabled).to.be.true;
    });

    it("should emit TokenMonitoringStatusChanged event", async () => {
      await expect(deviationSentinel.setTokenMonitoringEnabled(UNDERLYING_ASSET, false))
        .to.emit(deviationSentinel, "TokenMonitoringStatusChanged")
        .withArgs(UNDERLYING_ASSET, false);
    });

    it("should revert with ZeroAddress when token is address(0)", async () => {
      await expect(deviationSentinel.setTokenMonitoringEnabled(ZERO_ADDRESS, true)).to.be.revertedWithCustomError(
        deviationSentinel,
        "ZeroAddress",
      );
    });

    it("should revert with MarketNotConfigured when token has no config", async () => {
      const unconfigured = "0x0000000000000000000000000000000000000099";
      await expect(deviationSentinel.setTokenMonitoringEnabled(unconfigured, true)).to.be.revertedWithCustomError(
        deviationSentinel,
        "MarketNotConfigured",
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 5. checkPriceDeviation
  // ═══════════════════════════════════════════════════════════════════

  describe("checkPriceDeviation", () => {
    beforeEach(async () => {
      await deviationSentinel.setTokenConfig(UNDERLYING_ASSET, { deviation: 10, enabled: true });
    });

    it("should return hasDeviation=false and deviationPercent=0 when prices are equal", async () => {
      resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
      sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));

      const r = await deviationSentinel.checkPriceDeviation(vToken.address);
      expect(r.hasDeviation).to.be.false;
      expect(r.deviationPercent).to.equal(0);
    });

    it("should return hasDeviation=false when deviation (5%) is below threshold (10%)", async () => {
      resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
      sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("105", 18));

      const r = await deviationSentinel.checkPriceDeviation(vToken.address);
      expect(r.hasDeviation).to.be.false;
      expect(r.deviationPercent).to.equal(5);
    });

    it("should return hasDeviation=true at exactly 10% deviation (>= comparison)", async () => {
      resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
      sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("110", 18));

      const r = await deviationSentinel.checkPriceDeviation(vToken.address);
      expect(r.hasDeviation).to.be.true;
      expect(r.deviationPercent).to.equal(10);
    });

    it("should detect deviation when sentinel price is higher", async () => {
      resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
      sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("115", 18));

      const r = await deviationSentinel.checkPriceDeviation(vToken.address);
      expect(r.hasDeviation).to.be.true;
      expect(r.sentinelPrice).to.be.gt(r.oraclePrice);
    });

    it("should detect deviation when sentinel price is lower", async () => {
      resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
      sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("85", 18));

      const r = await deviationSentinel.checkPriceDeviation(vToken.address);
      expect(r.hasDeviation).to.be.true;
      expect(r.sentinelPrice).to.be.lt(r.oraclePrice);
    });

    it("should flag deviation (maxUint256) when oracle price is 0", async () => {
      resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(0);
      sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));

      const r = await deviationSentinel.checkPriceDeviation(vToken.address);
      expect(r.hasDeviation).to.be.true;
      expect(r.deviationPercent).to.equal(ethers.constants.MaxUint256);
    });

    it("should flag deviation (maxUint256) when both prices are 0", async () => {
      resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(0);
      sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(0);

      const r = await deviationSentinel.checkPriceDeviation(vToken.address);
      expect(r.hasDeviation).to.be.true;
      expect(r.deviationPercent).to.equal(ethers.constants.MaxUint256);
    });

    it("should return hasDeviation=false when monitoring is disabled", async () => {
      await deviationSentinel.setTokenMonitoringEnabled(UNDERLYING_ASSET, false);
      resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
      sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("200", 18));

      const r = await deviationSentinel.checkPriceDeviation(vToken.address);
      expect(r.hasDeviation).to.be.false;
      expect(r.oraclePrice).to.equal(0);
      expect(r.sentinelPrice).to.equal(0);
      expect(r.deviationPercent).to.equal(0);
    });

    it("should return (false, 0, 0, 0) for unconfigured market", async () => {
      const unknownVToken = await smock.fake<IVToken>("IVToken");
      unknownVToken.underlying.returns("0x0000000000000000000000000000000000000099");

      const r = await deviationSentinel.checkPriceDeviation(unknownVToken.address);
      expect(r.hasDeviation).to.be.false;
      expect(r.oraclePrice).to.equal(0);
      expect(r.sentinelPrice).to.equal(0);
      expect(r.deviationPercent).to.equal(0);
    });

    it("should return (false, 0, 0, 0) for configured but disabled market", async () => {
      await deviationSentinel.setTokenMonitoringEnabled(UNDERLYING_ASSET, false);

      const r = await deviationSentinel.checkPriceDeviation(vToken.address);
      expect(r.hasDeviation).to.be.false;
      expect(r.oraclePrice).to.equal(0);
      expect(r.sentinelPrice).to.equal(0);
      expect(r.deviationPercent).to.equal(0);
    });

    it("should round down deviationPercent due to integer division (9.5% → 9)", async () => {
      resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("200", 18));
      sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("219", 18));

      const r = await deviationSentinel.checkPriceDeviation(vToken.address);
      expect(r.deviationPercent).to.equal(9);
      expect(r.hasDeviation).to.be.false;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 6. handleDeviation
  // ═══════════════════════════════════════════════════════════════════

  describe("handleDeviation", () => {
    beforeEach(async () => {
      await deviationSentinel.setTokenConfig(UNDERLYING_ASSET, { deviation: 10, enabled: true });
      await deviationSentinel.setTrustedKeeper(keeper.address, true);
    });

    describe("revert cases", () => {
      it("should revert with UnauthorizedKeeper when caller is not trusted", async () => {
        resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
        sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("115", 18));

        await expect(deviationSentinel.connect(user).handleDeviation(vToken.address)).to.be.revertedWithCustomError(
          deviationSentinel,
          "UnauthorizedKeeper",
        );
      });

      it("should revert with MarketNotConfigured when underlying has no config", async () => {
        const unknownVToken = await smock.fake<IVToken>("IVToken");
        unknownVToken.underlying.returns("0x0000000000000000000000000000000000000099");

        await expect(
          deviationSentinel.connect(keeper).handleDeviation(unknownVToken.address),
        ).to.be.revertedWithCustomError(deviationSentinel, "MarketNotConfigured");
      });

      it("should revert with TokenMonitoringDisabled when monitoring is off", async () => {
        await deviationSentinel.setTokenMonitoringEnabled(UNDERLYING_ASSET, false);
        resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
        sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("115", 18));

        await expect(deviationSentinel.connect(keeper).handleDeviation(vToken.address)).to.be.revertedWithCustomError(
          deviationSentinel,
          "TokenMonitoringDisabled",
        );
      });
    });

    describe("sentinel price higher → pause borrow", () => {
      beforeEach(() => {
        resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
        sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("115", 18));
      });

      it("should emit DeviationHandled(market, oraclePrice, sentinelPrice, true) when sentinel price is higher", async () => {
        await expect(deviationSentinel.connect(keeper).handleDeviation(vToken.address))
          .to.emit(deviationSentinel, "DeviationHandled")
          .withArgs(vToken.address, parseUnits("100", 18), parseUnits("115", 18), true);
      });

      it("should call eBrake.pauseBorrow(market)", async () => {
        await deviationSentinel.connect(keeper).handleDeviation(vToken.address);
        expect(eBrake.pauseBorrow).to.have.been.calledWith(vToken.address);
      });

      it("should delegate to EBrake on repeat calls (EBrake handles idempotency)", async () => {
        await deviationSentinel.connect(keeper).handleDeviation(vToken.address);
        eBrake.pauseBorrow.reset();

        await deviationSentinel.connect(keeper).handleDeviation(vToken.address);
        expect(eBrake.pauseBorrow).to.have.been.calledWith(vToken.address);
      });
    });

    describe("sentinel price lower → zero CF + pause supply", () => {
      beforeEach(() => {
        resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
        sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("85", 18));
      });

      it("should emit DeviationHandled(market, oraclePrice, sentinelPrice, false) when sentinel price is lower", async () => {
        await expect(deviationSentinel.connect(keeper).handleDeviation(vToken.address))
          .to.emit(deviationSentinel, "DeviationHandled")
          .withArgs(vToken.address, parseUnits("100", 18), parseUnits("85", 18), false);
      });

      it("should call eBrake.setCFZero(market) and eBrake.pauseSupply(market)", async () => {
        await deviationSentinel.connect(keeper).handleDeviation(vToken.address);
        expect(eBrake["setCFZero(address)"]).to.have.been.calledWith(vToken.address);
        expect(eBrake.pauseSupply).to.have.been.calledWith(vToken.address);
      });

      it("should delegate to EBrake on repeat calls (EBrake handles idempotency)", async () => {
        await deviationSentinel.connect(keeper).handleDeviation(vToken.address);
        eBrake["setCFZero(address)"].reset();
        eBrake.pauseSupply.reset();

        await deviationSentinel.connect(keeper).handleDeviation(vToken.address);
        expect(eBrake["setCFZero(address)"]).to.have.been.calledWith(vToken.address);
        expect(eBrake.pauseSupply).to.have.been.calledWith(vToken.address);
      });
    });

    describe("no deviation → no action", () => {
      it("should be a no-op when no deviation", async () => {
        resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
        sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("105", 18));

        // Reset call tracking before this specific test
        eBrake.pauseBorrow.reset();
        eBrake.pauseSupply.reset();
        eBrake["setCFZero(address)"].reset();

        const tx = deviationSentinel.connect(keeper).handleDeviation(vToken.address);
        await expect(tx).to.not.emit(deviationSentinel, "DeviationHandled");
        expect(eBrake.pauseBorrow).to.not.have.been.called;
        expect(eBrake.pauseSupply).to.not.have.been.called;
        expect(eBrake["setCFZero(address)"]).to.not.have.been.called;
      });
    });

    describe("deviation direction flip", () => {
      it("should pause borrow then supply when deviation flips", async () => {
        resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
        sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("115", 18));
        await deviationSentinel.connect(keeper).handleDeviation(vToken.address);
        expect(eBrake.pauseBorrow).to.have.been.calledWith(vToken.address);

        sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("85", 18));
        await deviationSentinel.connect(keeper).handleDeviation(vToken.address);
        expect(eBrake["setCFZero(address)"]).to.have.been.calledWith(vToken.address);
        expect(eBrake.pauseSupply).to.have.been.calledWith(vToken.address);
      });
    });

    describe("zero-price edge cases", () => {
      it("should emit DeviationHandled(borrowPaused=true) when oracle price = 0 (sentinel > oracle)", async () => {
        resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(0);
        sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));

        await expect(deviationSentinel.connect(keeper).handleDeviation(vToken.address))
          .to.emit(deviationSentinel, "DeviationHandled")
          .withArgs(vToken.address, 0, parseUnits("100", 18), true);
      });

      it("should emit DeviationHandled(borrowPaused=false) when sentinel price = 0", async () => {
        resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
        sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(0);

        await expect(deviationSentinel.connect(keeper).handleDeviation(vToken.address))
          .to.emit(deviationSentinel, "DeviationHandled")
          .withArgs(vToken.address, parseUnits("100", 18), 0, false);
      });

      it("should emit DeviationHandled(borrowPaused=false) when both prices are 0", async () => {
        resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(0);
        sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(0);

        await expect(deviationSentinel.connect(keeper).handleDeviation(vToken.address))
          .to.emit(deviationSentinel, "DeviationHandled")
          .withArgs(vToken.address, 0, 0, false);
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 7. Access Control
  // ═══════════════════════════════════════════════════════════════════

  describe("Access Control", () => {
    afterEach(async () => {
      accessControlManager.isAllowedToCall.returns(true);
    });

    it("should revert setTokenConfig when ACM denies", async () => {
      accessControlManager.isAllowedToCall.returns(false);
      await expect(deviationSentinel.setTokenConfig(UNDERLYING_ASSET, { deviation: 10, enabled: true })).to.be.reverted;
    });

    it("should revert setTrustedKeeper when ACM denies", async () => {
      accessControlManager.isAllowedToCall.returns(false);
      await expect(deviationSentinel.setTrustedKeeper(keeper.address, true)).to.be.reverted;
    });

    it("should revert setTokenMonitoringEnabled when ACM denies", async () => {
      await deviationSentinel.setTokenConfig(UNDERLYING_ASSET, { deviation: 10, enabled: true });
      accessControlManager.isAllowedToCall.returns(false);
      await expect(deviationSentinel.setTokenMonitoringEnabled(UNDERLYING_ASSET, false)).to.be.reverted;
    });
  });
});
