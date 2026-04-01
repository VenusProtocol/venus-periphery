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

    // vToken setup
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

    it("should return hasDeviation=false at 9% deviation (just under 10% threshold)", async () => {
      resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
      sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("109", 18));

      const r = await deviationSentinel.checkPriceDeviation(vToken.address);
      expect(r.hasDeviation).to.be.false;
      expect(r.deviationPercent).to.equal(9);
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
      expect(r.deviationPercent).to.equal(15);
    });

    it("should detect deviation when sentinel price is lower", async () => {
      resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
      sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("85", 18));

      const r = await deviationSentinel.checkPriceDeviation(vToken.address);
      expect(r.hasDeviation).to.be.true;
      expect(r.sentinelPrice).to.be.lt(r.oraclePrice);
      expect(r.deviationPercent).to.equal(15);
    });

    // ── Zero-price edge cases ──

    it("should flag deviation (maxUint256) when oracle price is 0", async () => {
      resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(0);
      sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));

      const r = await deviationSentinel.checkPriceDeviation(vToken.address);
      expect(r.hasDeviation).to.be.true;
      expect(r.deviationPercent).to.equal(ethers.constants.MaxUint256);
    });

    it("should flag deviation (maxUint256) when sentinel price is 0", async () => {
      resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
      sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(0);

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

    // ── Monitoring flag has NO effect on this view function ──

    it("should still calculate deviation when monitoring is disabled (view-only)", async () => {
      await deviationSentinel.setTokenMonitoringEnabled(UNDERLYING_ASSET, false);
      resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
      sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("200", 18));

      const r = await deviationSentinel.checkPriceDeviation(vToken.address);
      expect(r.hasDeviation).to.be.true;
    });

    // ── Integer-division rounding ──

    it("should round down deviationPercent due to integer division (9.5% → 9)", async () => {
      // diff = 19, base = 200 → (19 * 100) / 200 = 9 (truncated)
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

    // ── Revert cases ────────────────────────────────────────────────

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

    // ── Sentinel price HIGHER → pause borrow ────────────────────────

    describe("sentinel price higher → pause borrow", () => {
      beforeEach(() => {
        resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
        sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("115", 18));
      });

      it("should emit BorrowPaused event", async () => {
        await expect(deviationSentinel.connect(keeper).handleDeviation(vToken.address))
          .to.emit(deviationSentinel, "BorrowPaused")
          .withArgs(vToken.address);
      });

      it("should call eBrake.pauseBorrow(market)", async () => {
        await deviationSentinel.connect(keeper).handleDeviation(vToken.address);
        expect(eBrake.pauseBorrow).to.have.been.calledWith(vToken.address);
      });

      it("should set marketStates.borrowPaused = true", async () => {
        await deviationSentinel.connect(keeper).handleDeviation(vToken.address);
        expect((await deviationSentinel.marketStates(vToken.address)).borrowPaused).to.be.true;
      });

      it("should early-return (no-op) on second call — idempotent borrow pause", async () => {
        await deviationSentinel.connect(keeper).handleDeviation(vToken.address);
        eBrake.pauseBorrow.reset();

        await deviationSentinel.connect(keeper).handleDeviation(vToken.address);
        expect(eBrake.pauseBorrow).to.not.have.been.called;
      });

      it("should NOT emit BorrowPaused on duplicate call", async () => {
        await deviationSentinel.connect(keeper).handleDeviation(vToken.address);
        await expect(deviationSentinel.connect(keeper).handleDeviation(vToken.address)).to.not.emit(
          deviationSentinel,
          "BorrowPaused",
        );
      });
    });

    // ── Sentinel price LOWER → zero CF + pause supply ───────────────

    describe("sentinel price lower → zero CF + pause supply", () => {
      beforeEach(() => {
        resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
        sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("85", 18));
      });

      it("should emit SupplyPaused event", async () => {
        await expect(deviationSentinel.connect(keeper).handleDeviation(vToken.address))
          .to.emit(deviationSentinel, "SupplyPaused")
          .withArgs(vToken.address);
      });

      it("should call eBrake.setCFZero(market) and eBrake.pauseSupply(market)", async () => {
        await deviationSentinel.connect(keeper).handleDeviation(vToken.address);
        expect(eBrake["setCFZero(address)"]).to.have.been.calledWith(vToken.address);
        expect(eBrake.pauseSupply).to.have.been.calledWith(vToken.address);
      });

      it("should set marketStates.cfModifiedAndSupplyPaused = true", async () => {
        await deviationSentinel.connect(keeper).handleDeviation(vToken.address);
        expect((await deviationSentinel.marketStates(vToken.address)).cfModifiedAndSupplyPaused).to.be.true;
      });

      it("should early-return on duplicate call — idempotent supply pause", async () => {
        await deviationSentinel.connect(keeper).handleDeviation(vToken.address);
        eBrake["setCFZero(address)"].reset();
        eBrake.pauseSupply.reset();

        await deviationSentinel.connect(keeper).handleDeviation(vToken.address);
        expect(eBrake["setCFZero(address)"]).to.not.have.been.called;
        expect(eBrake.pauseSupply).to.not.have.been.called;
      });
    });

    // ── No deviation → no action (no auto-unpause) ─────────────────

    describe("no deviation → no action", () => {
      it("should be a no-op when no deviation and nothing was paused", async () => {
        resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
        sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("105", 18));

        const tx = deviationSentinel.connect(keeper).handleDeviation(vToken.address);
        await expect(tx).to.not.emit(deviationSentinel, "BorrowPaused");
        await expect(tx).to.not.emit(deviationSentinel, "SupplyPaused");
      });

      it("should NOT auto-unpause borrow when deviation resolves (pause-only contract)", async () => {
        // Step 1: Trigger borrow pause
        resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
        sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("115", 18));
        await deviationSentinel.connect(keeper).handleDeviation(vToken.address);
        expect((await deviationSentinel.marketStates(vToken.address)).borrowPaused).to.be.true;

        // Step 2: Resolve deviation — sentinel should NOT unpause
        sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("105", 18));
        eBrake.pauseBorrow.reset();

        await deviationSentinel.connect(keeper).handleDeviation(vToken.address);
        expect(eBrake.pauseBorrow).to.not.have.been.called;
        // State remains paused — recovery is via governance VIP
        expect((await deviationSentinel.marketStates(vToken.address)).borrowPaused).to.be.true;
      });

      it("should NOT auto-unpause supply when deviation resolves (pause-only contract)", async () => {
        // Step 1: Trigger supply pause
        resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
        sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("85", 18));
        await deviationSentinel.connect(keeper).handleDeviation(vToken.address);
        expect((await deviationSentinel.marketStates(vToken.address)).cfModifiedAndSupplyPaused).to.be.true;

        // Step 2: Resolve deviation — sentinel should NOT unpause
        sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
        eBrake["setCFZero(address)"].reset();
        eBrake.pauseSupply.reset();

        await deviationSentinel.connect(keeper).handleDeviation(vToken.address);
        expect(eBrake["setCFZero(address)"]).to.not.have.been.called;
        expect(eBrake.pauseSupply).to.not.have.been.called;
        // State remains paused
        expect((await deviationSentinel.marketStates(vToken.address)).cfModifiedAndSupplyPaused).to.be.true;
      });
    });

    // ── Zero-price edge cases inside handleDeviation ────────────────

    describe("zero-price edge cases in handleDeviation", () => {
      it("should pause borrow when oracle price = 0 (sentinel > oracle)", async () => {
        resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(0);
        sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));

        await expect(deviationSentinel.connect(keeper).handleDeviation(vToken.address)).to.emit(
          deviationSentinel,
          "BorrowPaused",
        );
      });

      it("should pause supply + zero CF when sentinel price = 0 (sentinel < oracle)", async () => {
        resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
        sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(0);

        await expect(deviationSentinel.connect(keeper).handleDeviation(vToken.address)).to.emit(
          deviationSentinel,
          "SupplyPaused",
        );
      });

      it("should pause supply when both prices are 0 (sentinelPrice not > oraclePrice)", async () => {
        resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(0);
        sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(0);

        // 0 > 0 is false, so it goes to the supply-pause path
        await expect(deviationSentinel.connect(keeper).handleDeviation(vToken.address)).to.emit(
          deviationSentinel,
          "SupplyPaused",
        );
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 7. resetMarketState
  // ═══════════════════════════════════════════════════════════════════

  describe("resetMarketState", () => {
    beforeEach(async () => {
      await deviationSentinel.setTokenConfig(UNDERLYING_ASSET, { deviation: 10, enabled: true });
      await deviationSentinel.setTrustedKeeper(keeper.address, true);
    });

    it("should emit MarketStateReset event", async () => {
      await expect(deviationSentinel.resetMarketState(vToken.address))
        .to.emit(deviationSentinel, "MarketStateReset")
        .withArgs(vToken.address);
    });

    it("should revert with ZeroAddress when market is address(0)", async () => {
      await expect(deviationSentinel.resetMarketState(ZERO_ADDRESS)).to.be.revertedWithCustomError(
        deviationSentinel,
        "ZeroAddress",
      );
    });

    it("should clear borrowPaused flag", async () => {
      resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
      sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("115", 18));
      await deviationSentinel.connect(keeper).handleDeviation(vToken.address);

      expect((await deviationSentinel.marketStates(vToken.address)).borrowPaused).to.be.true;

      await deviationSentinel.resetMarketState(vToken.address);
      expect((await deviationSentinel.marketStates(vToken.address)).borrowPaused).to.be.false;
    });

    it("should clear cfModifiedAndSupplyPaused flag", async () => {
      resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
      sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("85", 18));
      await deviationSentinel.connect(keeper).handleDeviation(vToken.address);

      expect((await deviationSentinel.marketStates(vToken.address)).cfModifiedAndSupplyPaused).to.be.true;

      await deviationSentinel.resetMarketState(vToken.address);
      expect((await deviationSentinel.marketStates(vToken.address)).cfModifiedAndSupplyPaused).to.be.false;
    });

    it("should allow handleDeviation to work fresh (no early-return) after reset", async () => {
      resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
      sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("115", 18));
      await deviationSentinel.connect(keeper).handleDeviation(vToken.address);

      await deviationSentinel.resetMarketState(vToken.address);

      // Same deviation → should re-trigger borrow pause (not early-return)
      eBrake.pauseBorrow.reset();
      await deviationSentinel.connect(keeper).handleDeviation(vToken.address);
      expect(eBrake.pauseBorrow).to.have.been.called;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 8. Access Control (ACM denials)
  // ═══════════════════════════════════════════════════════════════════

  describe("Access Control", () => {
    afterEach(async () => {
      // Restore ACM default so subsequent tests are not affected
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
      // First configure token while ACM allows
      await deviationSentinel.setTokenConfig(UNDERLYING_ASSET, { deviation: 10, enabled: true });
      // Then deny
      accessControlManager.isAllowedToCall.returns(false);
      await expect(deviationSentinel.setTokenMonitoringEnabled(UNDERLYING_ASSET, false)).to.be.reverted;
    });

    it("should revert resetMarketState when ACM denies", async () => {
      accessControlManager.isAllowedToCall.returns(false);
      await expect(deviationSentinel.resetMarketState(vToken.address)).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 9. Governance Interaction Edge Cases
  //
  // These tests verify scenarios where governance modifies protocol
  // state while the sentinel has an active market state. Without
  // calling resetMarketState, the sentinel's flags become stale.
  // ═══════════════════════════════════════════════════════════════════

  describe("Governance Interaction Edge Cases", () => {
    beforeEach(async () => {
      await deviationSentinel.setTokenConfig(UNDERLYING_ASSET, { deviation: 10, enabled: true });
      await deviationSentinel.setTrustedKeeper(keeper.address, true);
    });

    /**
     * Scenario: Governance manually unpauses borrow via comptroller while
     * sentinel still tracks borrowPaused = true.
     *
     * The sentinel sees borrowPaused = true (stale) and early-returns,
     * skipping the re-pause. resetMarketState fixes this.
     */
    it("should skip re-pausing borrow if sentinel state is stale (governance already unpaused) — shows need for reset", async () => {
      // Step 1: Deviation → borrow paused
      resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
      sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("115", 18));
      await deviationSentinel.connect(keeper).handleDeviation(vToken.address);

      expect((await deviationSentinel.marketStates(vToken.address)).borrowPaused).to.be.true;

      // Step 2: Governance manually unpauses borrow on the comptroller.
      //         Sentinel's borrowPaused is still true (stale).

      // Step 3: Keeper calls handleDeviation again with same deviation.
      //         Sentinel sees borrowPaused = true → early-returns.
      eBrake.pauseBorrow.reset();
      await deviationSentinel.connect(keeper).handleDeviation(vToken.address);

      // No call — sentinel thinks borrow is already paused (stale state)
      expect(eBrake.pauseBorrow).to.not.have.been.called;
    });

    /**
     * After resetMarketState, the sentinel can re-pause borrow correctly
     * even though governance had already unpaused it externally.
     */
    it("should re-pause borrow after resetMarketState clears stale borrowPaused flag", async () => {
      // Deviation → borrow paused
      resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
      sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("115", 18));
      await deviationSentinel.connect(keeper).handleDeviation(vToken.address);

      // Governance manually unpauses (external), then admin resets sentinel state
      await deviationSentinel.resetMarketState(vToken.address);

      // Same deviation → sentinel should now re-pause (fresh state)
      eBrake.pauseBorrow.reset();
      await expect(deviationSentinel.connect(keeper).handleDeviation(vToken.address)).to.emit(
        deviationSentinel,
        "BorrowPaused",
      );
      expect(eBrake.pauseBorrow).to.have.been.called;
    });

    /**
     * Scenario: Governance manually unpauses supply + restores CF externally
     * while sentinel still tracks cfModifiedAndSupplyPaused = true.
     *
     * Without reset, a new sentinel-lower deviation early-returns because
     * the sentinel thinks supply is already paused.
     */
    it("should skip re-pausing supply if sentinel state is stale (governance already unpaused supply)", async () => {
      // Deviation → supply paused + CF zeroed
      resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
      sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("85", 18));
      await deviationSentinel.connect(keeper).handleDeviation(vToken.address);

      expect((await deviationSentinel.marketStates(vToken.address)).cfModifiedAndSupplyPaused).to.be.true;

      // Governance unpauses supply + restores CF externally.
      // Sentinel state is stale: cfModifiedAndSupplyPaused = true.

      // New deviation → sentinel early-returns
      eBrake["setCFZero(address)"].reset();
      eBrake.pauseSupply.reset();
      await deviationSentinel.connect(keeper).handleDeviation(vToken.address);

      expect(eBrake["setCFZero(address)"]).to.not.have.been.called;
      expect(eBrake.pauseSupply).to.not.have.been.called;
    });

    /**
     * After resetMarketState, sentinel can re-pause supply + re-zero CF
     * even though governance had already restored things externally.
     */
    it("should re-pause supply + re-zero CF after resetMarketState clears stale flag", async () => {
      // Deviation → supply paused + CF zeroed
      resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
      sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("85", 18));
      await deviationSentinel.connect(keeper).handleDeviation(vToken.address);

      // Governance intervenes externally, admin resets sentinel state
      await deviationSentinel.resetMarketState(vToken.address);

      // Same deviation → sentinel re-pauses supply + re-zeros CF
      eBrake["setCFZero(address)"].reset();
      eBrake.pauseSupply.reset();
      await expect(deviationSentinel.connect(keeper).handleDeviation(vToken.address)).to.emit(
        deviationSentinel,
        "SupplyPaused",
      );
      expect(eBrake["setCFZero(address)"]).to.have.been.called;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 10. Complex State Transitions
  // ═══════════════════════════════════════════════════════════════════

  describe("Complex State Transitions", () => {
    beforeEach(async () => {
      await deviationSentinel.setTokenConfig(UNDERLYING_ASSET, { deviation: 10, enabled: true });
      await deviationSentinel.setTrustedKeeper(keeper.address, true);
    });

    it("direction flip: borrow paused, then deviation flips → supply pause fires on top (both flags set)", async () => {
      // Step 1: Sentinel higher → borrow paused
      resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
      sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("115", 18));
      await deviationSentinel.connect(keeper).handleDeviation(vToken.address);

      let state = await deviationSentinel.marketStates(vToken.address);
      expect(state.borrowPaused).to.be.true;
      expect(state.cfModifiedAndSupplyPaused).to.be.false;

      // Step 2: Deviation flips — sentinel lower (no auto-unpause of borrow)
      sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("85", 18));
      await deviationSentinel.connect(keeper).handleDeviation(vToken.address);

      // Both flags set — borrow still paused (no auto-unpause), supply now also paused
      state = await deviationSentinel.marketStates(vToken.address);
      expect(state.borrowPaused).to.be.true;
      expect(state.cfModifiedAndSupplyPaused).to.be.true;
    });

    it("resetMarketState allows fresh pause after admin intervention", async () => {
      resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
      sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("115", 18));
      await deviationSentinel.connect(keeper).handleDeviation(vToken.address);

      await deviationSentinel.resetMarketState(vToken.address);

      eBrake.pauseBorrow.reset();
      await expect(deviationSentinel.connect(keeper).handleDeviation(vToken.address)).to.emit(
        deviationSentinel,
        "BorrowPaused",
      );
    });

    it("no-op when no deviation and clean state", async () => {
      resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
      sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("105", 18));

      await deviationSentinel.connect(keeper).handleDeviation(vToken.address);
      const state = await deviationSentinel.marketStates(vToken.address);
      expect(state.borrowPaused).to.be.false;
      expect(state.cfModifiedAndSupplyPaused).to.be.false;
    });
  });
});
