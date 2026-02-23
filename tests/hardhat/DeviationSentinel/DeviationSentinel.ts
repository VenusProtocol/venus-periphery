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
  const ZERO_ADDRESS = ethers.constants.AddressZero;

  // Commonly used collateral-factor / liquidation-threshold values
  const CF = parseUnits("0.8", 18);
  const LT = parseUnits("0.85", 18);

  /**
   * Deploys the DeviationSentinel behind an upgradeable proxy with all
   * required mock contracts wired up (ACM, CorePoolComptroller, oracles, vToken).
   *
   * Core-pool comptroller defaults:
   *   - corePoolId = 0, lastPoolId = 0 (single core pool, matching BSC mainnet)
   *   - poolMarkets returns "not-listed" by default
   *   - setCollateralFactor(4-arg) returns 0 (success) by default
   *
   * Override individual mocks per-test as needed.
   */
  async function deployFixture() {
    [owner, keeper, user] = await ethers.getSigners();

    // ── Mock contracts ──
    accessControlManager = await smock.fake<IAccessControlManagerV8>("IAccessControlManagerV8");
    corePoolComptroller = await smock.fake<ICorePoolComptroller>("ICorePoolComptroller");
    resilientOracle = await smock.fake<ResilientOracleInterface>("ResilientOracleInterface");
    sentinelOracle = await smock.fake<OracleInterface>("OracleInterface");
    vToken = await smock.fake<IVToken>("IVToken");

    // ACM allows all calls by default; override in access-control tests
    accessControlManager.isAllowedToCall.returns(true);

    // vToken points at the core-pool comptroller
    vToken.underlying.returns(UNDERLYING_ASSET);
    vToken.comptroller.returns(corePoolComptroller.address);

    // Core-pool defaults (single pool at index 0, market not listed)
    corePoolComptroller.corePoolId.returns(0);
    corePoolComptroller.lastPoolId.returns(0);
    corePoolComptroller["setCollateralFactor(uint96,address,uint256,uint256)"].returns(0);
    corePoolComptroller.poolMarkets.returns([false, 0, false, 0, 0, 0, false]);

    // ── Deploy proxy ──
    const Factory = await ethers.getContractFactory("DeviationSentinel");
    deviationSentinel = (await upgrades.deployProxy(Factory, [accessControlManager.address], {
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

  // ═══════════════════════════════════════════════════════════════════
  // 1. Initialization
  // ═══════════════════════════════════════════════════════════════════

  describe("Initialization", () => {
    it("should deploy to a non-zero address", async () => {
      expect(deviationSentinel.address).to.not.equal(ZERO_ADDRESS);
    });

    it("should store immutable addresses correctly", async () => {
      expect(await deviationSentinel.CORE_POOL_COMPTROLLER()).to.equal(corePoolComptroller.address);
      expect(await deviationSentinel.RESILIENT_ORACLE()).to.equal(resilientOracle.address);
      expect(await deviationSentinel.SENTINEL_ORACLE()).to.equal(sentinelOracle.address);
    });

    it("should revert when resilientOracle_ is the zero address", async () => {
      const Factory = await ethers.getContractFactory("DeviationSentinel");
      await expect(
        upgrades.deployProxy(Factory, [accessControlManager.address], {
          constructorArgs: [corePoolComptroller.address, ZERO_ADDRESS, sentinelOracle.address],
          unsafeAllow: ["constructor", "internal-function-storage"],
        }),
      ).to.be.revertedWithCustomError(deviationSentinel, "ZeroAddress");
    });

    it("should revert when sentinelOracle_ is the zero address", async () => {
      const Factory = await ethers.getContractFactory("DeviationSentinel");
      await expect(
        upgrades.deployProxy(Factory, [accessControlManager.address], {
          constructorArgs: [corePoolComptroller.address, resilientOracle.address, ZERO_ADDRESS],
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
        unknownVToken.comptroller.returns(corePoolComptroller.address);

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

      it("should call setActionsPaused([market], [BORROW], true)", async () => {
        await deviationSentinel.connect(keeper).handleDeviation(vToken.address);
        expect(corePoolComptroller.setActionsPaused).to.have.been.calledWith(
          [vToken.address],
          [2], // Action.BORROW
          true,
        );
      });

      it("should set marketStates.borrowPaused = true", async () => {
        await deviationSentinel.connect(keeper).handleDeviation(vToken.address);
        expect((await deviationSentinel.marketStates(vToken.address)).borrowPaused).to.be.true;
      });

      it("should early-return (no-op) on second call — idempotent borrow pause", async () => {
        await deviationSentinel.connect(keeper).handleDeviation(vToken.address);
        corePoolComptroller.setActionsPaused.reset();

        await deviationSentinel.connect(keeper).handleDeviation(vToken.address);
        expect(corePoolComptroller.setActionsPaused).to.not.have.been.called;
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

    describe("sentinel price lower → zero CF + pause supply (single core pool)", () => {
      beforeEach(() => {
        resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
        sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("85", 18));

        // Market listed in pool 0 (core pool, matching BSC mainnet where corePoolId = 0)
        corePoolComptroller.poolMarkets.whenCalledWith(0, vToken.address).returns([true, CF, false, LT, 0, 0, true]);
      });

      it("should emit SupplyPaused event", async () => {
        await expect(deviationSentinel.connect(keeper).handleDeviation(vToken.address))
          .to.emit(deviationSentinel, "SupplyPaused")
          .withArgs(vToken.address);
      });

      it("should call setActionsPaused([market], [MINT], true)", async () => {
        await deviationSentinel.connect(keeper).handleDeviation(vToken.address);
        expect(corePoolComptroller.setActionsPaused).to.have.been.calledWith(
          [vToken.address],
          [0], // Action.MINT
          true,
        );
      });

      it("should set CF to zero via the 4-arg overload, keeping LT unchanged", async () => {
        await deviationSentinel.connect(keeper).handleDeviation(vToken.address);
        expect(corePoolComptroller["setCollateralFactor(uint96,address,uint256,uint256)"]).to.have.been.calledWith(
          0,
          vToken.address,
          0,
          LT,
        );
      });

      it("should emit CollateralFactorUpdated(market, poolId=0, oldCF, 0)", async () => {
        await expect(deviationSentinel.connect(keeper).handleDeviation(vToken.address))
          .to.emit(deviationSentinel, "CollateralFactorUpdated")
          .withArgs(vToken.address, 0, CF, 0);
      });

      it("should set marketStates.cfModifiedAndSupplyPaused = true", async () => {
        await deviationSentinel.connect(keeper).handleDeviation(vToken.address);
        expect((await deviationSentinel.marketStates(vToken.address)).cfModifiedAndSupplyPaused).to.be.true;
      });

      it("should early-return on duplicate call — idempotent supply pause", async () => {
        await deviationSentinel.connect(keeper).handleDeviation(vToken.address);
        corePoolComptroller.setActionsPaused.reset();
        corePoolComptroller["setCollateralFactor(uint96,address,uint256,uint256)"].reset();
        corePoolComptroller["setCollateralFactor(uint96,address,uint256,uint256)"].returns(0);

        await deviationSentinel.connect(keeper).handleDeviation(vToken.address);
        expect(corePoolComptroller.setActionsPaused).to.not.have.been.called;
        expect(corePoolComptroller["setCollateralFactor(uint96,address,uint256,uint256)"]).to.not.have.been.called;
      });

      it("should revert with ComptrollerError when setCollateralFactor returns non-zero", async () => {
        corePoolComptroller["setCollateralFactor(uint96,address,uint256,uint256)"].returns(1);
        await expect(deviationSentinel.connect(keeper).handleDeviation(vToken.address)).to.be.revertedWithCustomError(
          deviationSentinel,
          "ComptrollerError",
        );
        // Restore default success return — smock stores return values in JS memory,
        // not EVM storage, so loadFixture snapshot restore does NOT reset them.
        corePoolComptroller["setCollateralFactor(uint96,address,uint256,uint256)"].returns(0);
      });
    });

    // ── Multiple emode groups ───────────────────────────────────────
    //
    // Venus core pool on BSC uses corePoolId=0. When emode groups are
    // added, lastPoolId increases (e.g. 0 and 1 for two pools). The
    // sentinel iterates from corePoolId to lastPoolId inclusive.

    describe("core pool with multiple emode groups (corePoolId=0, lastPoolId=1)", () => {
      const CF0 = parseUnits("0.8", 18);
      const LT0 = parseUnits("0.85", 18);
      const CF1 = parseUnits("0.7", 18);
      const LT1 = parseUnits("0.75", 18);

      beforeEach(() => {
        resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
        sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("85", 18));

        corePoolComptroller.corePoolId.returns(0);
        corePoolComptroller.lastPoolId.returns(1);

        // Pool 0 (core pool)
        corePoolComptroller.poolMarkets.whenCalledWith(0, vToken.address).returns([true, CF0, false, LT0, 0, 0, true]);
        // Pool 1 (emode group)
        corePoolComptroller.poolMarkets.whenCalledWith(1, vToken.address).returns([true, CF1, false, LT1, 0, 1, true]);
      });

      it("should zero CF for ALL listed emode pools", async () => {
        await deviationSentinel.connect(keeper).handleDeviation(vToken.address);
        expect(corePoolComptroller["setCollateralFactor(uint96,address,uint256,uint256)"]).to.have.been.calledWith(
          0,
          vToken.address,
          0,
          LT0,
        );
        expect(corePoolComptroller["setCollateralFactor(uint96,address,uint256,uint256)"]).to.have.been.calledWith(
          1,
          vToken.address,
          0,
          LT1,
        );
      });

      it("should restore CF for ALL pools when deviation resolves", async () => {
        await deviationSentinel.connect(keeper).handleDeviation(vToken.address);

        // Resolve deviation
        sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
        corePoolComptroller["setCollateralFactor(uint96,address,uint256,uint256)"].reset();
        corePoolComptroller["setCollateralFactor(uint96,address,uint256,uint256)"].returns(0);

        await deviationSentinel.connect(keeper).handleDeviation(vToken.address);
        expect(corePoolComptroller["setCollateralFactor(uint96,address,uint256,uint256)"]).to.have.been.calledWith(
          0,
          vToken.address,
          CF0,
          LT0,
        );
        expect(corePoolComptroller["setCollateralFactor(uint96,address,uint256,uint256)"]).to.have.been.calledWith(
          1,
          vToken.address,
          CF1,
          LT1,
        );
      });

      it("should skip unlisted pools", async () => {
        // Pool 1 is not listed for this market
        corePoolComptroller.poolMarkets.whenCalledWith(1, vToken.address).returns([false, 0, false, 0, 0, 0, false]);

        // Reset call history so we only count calls from THIS test
        corePoolComptroller["setCollateralFactor(uint96,address,uint256,uint256)"].reset();
        corePoolComptroller["setCollateralFactor(uint96,address,uint256,uint256)"].returns(0);

        await deviationSentinel.connect(keeper).handleDeviation(vToken.address);
        expect(corePoolComptroller["setCollateralFactor(uint96,address,uint256,uint256)"]).to.have.been.calledOnce;
        expect(corePoolComptroller["setCollateralFactor(uint96,address,uint256,uint256)"]).to.have.been.calledWith(
          0,
          vToken.address,
          0,
          LT0,
        );
      });
    });

    // ── Deviation resolved → unpause ────────────────────────────────

    describe("deviation resolved → unpause / restore", () => {
      it("should emit BorrowUnpaused and call setActionsPaused(false)", async () => {
        // Cause borrow pause
        resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
        sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("115", 18));
        await deviationSentinel.connect(keeper).handleDeviation(vToken.address);

        // Resolve
        sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("105", 18));
        corePoolComptroller.setActionsPaused.reset();

        await expect(deviationSentinel.connect(keeper).handleDeviation(vToken.address))
          .to.emit(deviationSentinel, "BorrowUnpaused")
          .withArgs(vToken.address);

        expect(corePoolComptroller.setActionsPaused).to.have.been.calledWith([vToken.address], [2], false);
      });

      it("should clear borrowPaused state after unpausing", async () => {
        resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
        sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("115", 18));
        await deviationSentinel.connect(keeper).handleDeviation(vToken.address);

        sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("105", 18));
        await deviationSentinel.connect(keeper).handleDeviation(vToken.address);

        expect((await deviationSentinel.marketStates(vToken.address)).borrowPaused).to.be.false;
      });

      it("should emit SupplyUnpaused and restore CF when supply was paused", async () => {
        // Market listed in pool 0
        corePoolComptroller.poolMarkets.whenCalledWith(0, vToken.address).returns([true, CF, false, LT, 0, 0, true]);

        resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
        sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("85", 18));
        await deviationSentinel.connect(keeper).handleDeviation(vToken.address);

        sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
        corePoolComptroller["setCollateralFactor(uint96,address,uint256,uint256)"].reset();
        corePoolComptroller["setCollateralFactor(uint96,address,uint256,uint256)"].returns(0);

        await expect(deviationSentinel.connect(keeper).handleDeviation(vToken.address))
          .to.emit(deviationSentinel, "SupplyUnpaused")
          .withArgs(vToken.address);

        expect(corePoolComptroller["setCollateralFactor(uint96,address,uint256,uint256)"]).to.have.been.calledWith(
          0,
          vToken.address,
          CF,
          LT,
        );
      });

      it("should clear cfModifiedAndSupplyPaused state after unpausing", async () => {
        corePoolComptroller.poolMarkets.whenCalledWith(0, vToken.address).returns([true, CF, false, LT, 0, 0, true]);

        resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
        sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("85", 18));
        await deviationSentinel.connect(keeper).handleDeviation(vToken.address);

        sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
        await deviationSentinel.connect(keeper).handleDeviation(vToken.address);

        expect((await deviationSentinel.marketStates(vToken.address)).cfModifiedAndSupplyPaused).to.be.false;
      });

      it("should be a no-op when no deviation and nothing was paused", async () => {
        resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
        sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("105", 18));

        const tx = deviationSentinel.connect(keeper).handleDeviation(vToken.address);
        await expect(tx).to.not.emit(deviationSentinel, "BorrowPaused");
        await expect(tx).to.not.emit(deviationSentinel, "BorrowUnpaused");
        await expect(tx).to.not.emit(deviationSentinel, "SupplyPaused");
        await expect(tx).to.not.emit(deviationSentinel, "SupplyUnpaused");
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

        // Market listed in pool 0
        corePoolComptroller.poolMarkets.whenCalledWith(0, vToken.address).returns([true, CF, false, LT, 0, 0, true]);

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
      // Market listed in pool 0
      corePoolComptroller.poolMarkets.whenCalledWith(0, vToken.address).returns([true, CF, false, LT, 0, 0, true]);

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
      corePoolComptroller.setActionsPaused.reset();
      await deviationSentinel.connect(keeper).handleDeviation(vToken.address);
      expect(corePoolComptroller.setActionsPaused).to.have.been.called;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 8. Access Control (ACM denials)
  //
  // NOTE: Each test resets ACM to `returns(true)` after the assertion
  // because smock fake return values persist across EVM snapshot
  // restores (they are stored in JS memory, not EVM storage).
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
  // These tests verify dangerous scenarios where governance modifies
  // protocol state (CF, pause status) while the sentinel has an active
  // market state. Without calling resetMarketState first, the sentinel's
  // cached values become stale and can override governance's intent.
  //
  // NOTE: Tests for new emode pool protection and LT=0 skip are
  // covered in the audit PR's _restoreCollateralFactor protection tests.
  // ═══════════════════════════════════════════════════════════════════

  describe("Governance Interaction Edge Cases", () => {
    const CF_OLD = parseUnits("0.8", 18);
    const LT_OLD = parseUnits("0.85", 18);

    beforeEach(async () => {
      await deviationSentinel.setTokenConfig(UNDERLYING_ASSET, { deviation: 10, enabled: true });
      await deviationSentinel.setTrustedKeeper(keeper.address, true);

      // Market listed in pool 0 (core pool)
      corePoolComptroller.poolMarkets
        .whenCalledWith(0, vToken.address)
        .returns([true, CF_OLD, false, LT_OLD, 0, 0, true]);
    });

    /**
     * Scenario: Governance changes CF while sentinel has the market paused.
     *
     * 1. Sentinel detects deviation → zeroes CF, stores CF_OLD
     * 2. Governance directly sets CF to CF_NEW via comptroller
     * 3. Deviation resolves → sentinel restores CF_OLD (stale!)
     *
     * This test proves the sentinel restores the OLD value, NOT the
     * governance-updated value. The fix is to call resetMarketState()
     * before re-enabling monitoring after governance intervention.
     */
    it("should restore stale CF (old value) when governance changed CF during pause — demonstrates need for resetMarketState", async () => {
      // Step 1: Deviation detected, CF zeroed. Sentinel stores CF_OLD internally.
      resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
      sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("85", 18));
      await deviationSentinel.connect(keeper).handleDeviation(vToken.address);

      // Step 2: Governance changes CF to CF_NEW directly on the comptroller.
      //         The sentinel's stored value is now stale — it still has CF_OLD in poolCFs[0].

      // Step 3: Deviation resolves → sentinel restores its cached CF_OLD
      sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
      corePoolComptroller["setCollateralFactor(uint96,address,uint256,uint256)"].reset();
      corePoolComptroller["setCollateralFactor(uint96,address,uint256,uint256)"].returns(0);

      await deviationSentinel.connect(keeper).handleDeviation(vToken.address);

      // The sentinel restores CF_OLD, NOT CF_NEW. This is the stale-value problem.
      expect(corePoolComptroller["setCollateralFactor(uint96,address,uint256,uint256)"]).to.have.been.calledWith(
        0,
        vToken.address,
        CF_OLD,
        LT_OLD,
      );
    });

    /**
     * Scenario: After governance changes CF during a pause, admin calls
     * resetMarketState() to wipe the sentinel's cached values, preventing
     * stale CF restoration.
     *
     * After reset, handleDeviation starts fresh and does not attempt to
     * restore a stale CF.
     */
    it("should NOT restore stale CF after resetMarketState — governance CF change is preserved", async () => {
      // Step 1: Deviation → CF zeroed
      resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
      sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("85", 18));
      await deviationSentinel.connect(keeper).handleDeviation(vToken.address);

      // Step 2: Admin resets the market state (acknowledging governance intervention)
      await deviationSentinel.resetMarketState(vToken.address);

      // Step 3: Deviation resolves → no restore happens because state was cleared
      sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
      corePoolComptroller["setCollateralFactor(uint96,address,uint256,uint256)"].reset();
      corePoolComptroller["setCollateralFactor(uint96,address,uint256,uint256)"].returns(0);

      await deviationSentinel.connect(keeper).handleDeviation(vToken.address);

      // setCollateralFactor should NOT be called — there's nothing to restore
      expect(corePoolComptroller["setCollateralFactor(uint96,address,uint256,uint256)"]).to.not.have.been.called;
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
      corePoolComptroller.setActionsPaused.reset();
      await deviationSentinel.connect(keeper).handleDeviation(vToken.address);

      // No call — sentinel thinks borrow is already paused (stale state)
      expect(corePoolComptroller.setActionsPaused).to.not.have.been.called;
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
      corePoolComptroller.setActionsPaused.reset();
      await expect(deviationSentinel.connect(keeper).handleDeviation(vToken.address)).to.emit(
        deviationSentinel,
        "BorrowPaused",
      );
      expect(corePoolComptroller.setActionsPaused).to.have.been.called;
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
      corePoolComptroller.setActionsPaused.reset();
      corePoolComptroller["setCollateralFactor(uint96,address,uint256,uint256)"].reset();
      corePoolComptroller["setCollateralFactor(uint96,address,uint256,uint256)"].returns(0);
      await deviationSentinel.connect(keeper).handleDeviation(vToken.address);

      expect(corePoolComptroller.setActionsPaused).to.not.have.been.called;
      expect(corePoolComptroller["setCollateralFactor(uint96,address,uint256,uint256)"]).to.not.have.been.called;
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
      corePoolComptroller.setActionsPaused.reset();
      corePoolComptroller["setCollateralFactor(uint96,address,uint256,uint256)"].reset();
      corePoolComptroller["setCollateralFactor(uint96,address,uint256,uint256)"].returns(0);
      await expect(deviationSentinel.connect(keeper).handleDeviation(vToken.address)).to.emit(
        deviationSentinel,
        "SupplyPaused",
      );
      expect(corePoolComptroller["setCollateralFactor(uint96,address,uint256,uint256)"]).to.have.been.called;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 10. Complex State Transitions
  // ═══════════════════════════════════════════════════════════════════

  describe("Complex State Transitions", () => {
    beforeEach(async () => {
      await deviationSentinel.setTokenConfig(UNDERLYING_ASSET, { deviation: 10, enabled: true });
      await deviationSentinel.setTrustedKeeper(keeper.address, true);

      // Market listed in pool 0 (core pool)
      corePoolComptroller.poolMarkets.whenCalledWith(0, vToken.address).returns([true, CF, false, LT, 0, 0, true]);
    });

    it("borrow pause → resolve → supply pause (deviation direction flips)", async () => {
      // Step 1: Sentinel higher → borrow paused
      resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
      sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("115", 18));
      await deviationSentinel.connect(keeper).handleDeviation(vToken.address);

      let state = await deviationSentinel.marketStates(vToken.address);
      expect(state.borrowPaused).to.be.true;
      expect(state.cfModifiedAndSupplyPaused).to.be.false;

      // Step 2: Resolve → borrow unpaused
      sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
      await deviationSentinel.connect(keeper).handleDeviation(vToken.address);
      state = await deviationSentinel.marketStates(vToken.address);
      expect(state.borrowPaused).to.be.false;

      // Step 3: Sentinel lower → supply paused + CF zeroed
      sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("85", 18));
      await deviationSentinel.connect(keeper).handleDeviation(vToken.address);
      state = await deviationSentinel.marketStates(vToken.address);
      expect(state.borrowPaused).to.be.false;
      expect(state.cfModifiedAndSupplyPaused).to.be.true;
    });

    it("supply pause → resolve → borrow pause (deviation direction flips)", async () => {
      // Step 1: Sentinel lower → supply paused + CF zeroed
      resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
      sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("85", 18));
      await deviationSentinel.connect(keeper).handleDeviation(vToken.address);

      expect((await deviationSentinel.marketStates(vToken.address)).cfModifiedAndSupplyPaused).to.be.true;

      // Step 2: Resolve
      sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
      await deviationSentinel.connect(keeper).handleDeviation(vToken.address);
      expect((await deviationSentinel.marketStates(vToken.address)).cfModifiedAndSupplyPaused).to.be.false;

      // Step 3: Sentinel higher → borrow paused
      sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("115", 18));
      await deviationSentinel.connect(keeper).handleDeviation(vToken.address);
      const state = await deviationSentinel.marketStates(vToken.address);
      expect(state.borrowPaused).to.be.true;
      expect(state.cfModifiedAndSupplyPaused).to.be.false;
    });

    it("resetMarketState allows fresh pause after admin intervention", async () => {
      resilientOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("100", 18));
      sentinelOracle.getPrice.whenCalledWith(UNDERLYING_ASSET).returns(parseUnits("115", 18));
      await deviationSentinel.connect(keeper).handleDeviation(vToken.address);

      await deviationSentinel.resetMarketState(vToken.address);

      corePoolComptroller.setActionsPaused.reset();
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
      // Ensure pool 0 is not listed so only pool 1 is tested
      corePoolComptroller.poolMarkets.whenCalledWith(0, vToken.address).returns([false, 0, 0, 0, 0, 0, 0]);
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
