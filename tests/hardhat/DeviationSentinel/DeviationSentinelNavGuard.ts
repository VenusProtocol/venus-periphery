import { FakeContract, smock } from "@defi-wonderland/smock";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import chai from "chai";
import { ethers, upgrades } from "hardhat";

import type {
  DeviationSentinel,
  IAccessControlManagerV8,
  IEBrake,
  IHub,
  IYieldGroupNav,
  OracleInterface,
  ResilientOracleInterface,
} from "../../../typechain";

const { expect } = chai;
chai.use(smock.matchers);

const RESOURCE = "0x0000000000000000000000000000000000000011";
const OTHER_RESOURCE = "0x0000000000000000000000000000000000000012";
const ZERO_ADDRESS = ethers.constants.AddressZero;

// 10% below the band floor, 5% above the band cap.
const PAUSE_DOWN_BPS = 1_000;
const PAUSE_UP_BPS = 500;

// Band bounds used throughout: floor 1000, cap 2000.
// Trips down below 900 (1000 less 10%), trips up above 2100 (2000 plus 5%).
const MIN = 1_000;
const MAX = 2_000;

describe("DeviationSentinel — NavGuard deviation", () => {
  let deviationSentinel: DeviationSentinel;
  let accessControlManager: FakeContract<IAccessControlManagerV8>;
  let eBrake: FakeContract<IEBrake>;
  let hub: FakeContract<IHub>;
  let yieldGroup: FakeContract<IYieldGroupNav>;
  let keeper: SignerWithAddress;
  let user: SignerWithAddress;

  function registerYieldGroup(registered: boolean) {
    hub.yieldGroupConfig.returns([0, 0, false, registered]);
  }

  function registerResource(registered: boolean) {
    yieldGroup.resourceConfig.returns([registered, false, ZERO_ADDRESS]);
  }

  function navGuardStatus(observed: number, isClamped: boolean) {
    yieldGroup.navGuardStatus.returns([observed, MIN, MAX, isClamped, isClamped ? MIN : 0]);
  }

  async function deployFixture() {
    [, keeper, user] = await ethers.getSigners();

    accessControlManager = await smock.fake<IAccessControlManagerV8>("IAccessControlManagerV8");
    eBrake = await smock.fake<IEBrake>("IEBrake");
    hub = await smock.fake<IHub>("IHub");
    yieldGroup = await smock.fake<IYieldGroupNav>("IYieldGroupNav");
    const resilientOracle = await smock.fake<ResilientOracleInterface>("ResilientOracleInterface");
    const sentinelOracle = await smock.fake<OracleInterface>("OracleInterface");

    accessControlManager.isAllowedToCall.returns(true);

    const Factory = await ethers.getContractFactory("DeviationSentinel");
    deviationSentinel = (await upgrades.deployProxy(Factory, [accessControlManager.address], {
      constructorArgs: [eBrake.address, resilientOracle.address, sentinelOracle.address],
      unsafeAllow: ["constructor", "internal-function-storage"],
    })) as DeviationSentinel;

    return { deviationSentinel, accessControlManager, eBrake, hub, yieldGroup, keeper, user };
  }

  beforeEach(async () => {
    ({ deviationSentinel, accessControlManager, eBrake, hub, yieldGroup, keeper, user } =
      await loadFixture(deployFixture));

    // loadFixture restores chain state, but smock fakes are JS-side and keep their stubs and call
    // history across tests. Reset them so each test starts from the same place.
    accessControlManager.isAllowedToCall.reset();
    accessControlManager.isAllowedToCall.returns(true);
    eBrake.pauseHub.reset();
    eBrake.pauseResource.reset();
    hub.yieldGroupConfig.reset();
    yieldGroup.navGuardStatus.reset();
    yieldGroup.resourceConfig.reset();

    await deviationSentinel.setTrustedKeeper(keeper.address, true);
    await deviationSentinel.setNavGuardConfig(yieldGroup.address, RESOURCE, PAUSE_UP_BPS, PAUSE_DOWN_BPS);
    await deviationSentinel.setNavGuardEnabled(yieldGroup.address, RESOURCE, true);
    registerYieldGroup(true);
    registerResource(true);
  });

  describe("setNavGuardConfig", () => {
    it("stores the thresholds and emits", async () => {
      await expect(deviationSentinel.setNavGuardConfig(yieldGroup.address, OTHER_RESOURCE, 100, 200))
        .to.emit(deviationSentinel, "NavGuardConfigUpdated")
        .withArgs(yieldGroup.address, OTHER_RESOURCE, [100, 200, false]);

      const stored = await deviationSentinel.navGuardConfigs(yieldGroup.address, OTHER_RESOURCE);
      expect(stored.pauseUpBps).to.equal(100);
      expect(stored.pauseDownBps).to.equal(200);
    });

    // Retuning a threshold must not disarm a live resource, and holding this role alone must not
    // be able to arm one — that is setNavGuardEnabled's job.
    it("leaves the enabled flag alone", async () => {
      await deviationSentinel.setNavGuardConfig(yieldGroup.address, RESOURCE, 100, 200);
      expect((await deviationSentinel.navGuardConfigs(yieldGroup.address, RESOURCE)).enabled).to.equal(true);

      await deviationSentinel.setNavGuardConfig(yieldGroup.address, OTHER_RESOURCE, 100, 200);
      expect((await deviationSentinel.navGuardConfigs(yieldGroup.address, OTHER_RESOURCE)).enabled).to.equal(false);
    });

    // The same resource address under two YieldGroups must not share one config.
    it("keys on the YieldGroup and the resource together", async () => {
      await deviationSentinel.setNavGuardConfig(OTHER_RESOURCE, RESOURCE, 100, 200);

      const other = await deviationSentinel.navGuardConfigs(OTHER_RESOURCE, RESOURCE);
      expect(other.pauseUpBps).to.equal(100);
      expect(other.enabled).to.equal(false);

      const original = await deviationSentinel.navGuardConfigs(yieldGroup.address, RESOURCE);
      expect(original.pauseUpBps).to.equal(PAUSE_UP_BPS);
      expect(original.enabled).to.equal(true);
    });

    it("reverts on a zero YieldGroup or resource address", async () => {
      await expect(deviationSentinel.setNavGuardConfig(ZERO_ADDRESS, RESOURCE, 1, 1)).to.be.revertedWithCustomError(
        deviationSentinel,
        "ZeroAddress",
      );

      await expect(
        deviationSentinel.setNavGuardConfig(yieldGroup.address, ZERO_ADDRESS, 1, 1),
      ).to.be.revertedWithCustomError(deviationSentinel, "ZeroAddress");
    });

    it("reverts when either threshold is zero", async () => {
      await expect(
        deviationSentinel.setNavGuardConfig(yieldGroup.address, RESOURCE, 0, 100),
      ).to.be.revertedWithCustomError(deviationSentinel, "ZeroDeviation");

      await expect(
        deviationSentinel.setNavGuardConfig(yieldGroup.address, RESOURCE, 100, 0),
      ).to.be.revertedWithCustomError(deviationSentinel, "ZeroDeviation");
    });

    it("reverts when either threshold exceeds MAX_DEVIATION_BPS", async () => {
      await expect(
        deviationSentinel.setNavGuardConfig(yieldGroup.address, RESOURCE, 10_001, 100),
      ).to.be.revertedWithCustomError(deviationSentinel, "ExceedsMaxDeviation");

      await expect(
        deviationSentinel.setNavGuardConfig(yieldGroup.address, RESOURCE, 100, 10_001),
      ).to.be.revertedWithCustomError(deviationSentinel, "ExceedsMaxDeviation");
    });

    // At 10_000 the floor computes to zero, so nothing can ever fall below it and downside
    // monitoring is silently dead. The cap is inclusive upward, where there is no such point.
    it("rejects a downside threshold of exactly MAX_DEVIATION_BPS but allows it upward", async () => {
      await expect(
        deviationSentinel.setNavGuardConfig(yieldGroup.address, RESOURCE, 100, 10_000),
      ).to.be.revertedWithCustomError(deviationSentinel, "ExceedsMaxDeviation");

      await expect(deviationSentinel.setNavGuardConfig(yieldGroup.address, RESOURCE, 10_000, 100)).to.not.be.reverted;
    });

    it("is ACM gated", async () => {
      accessControlManager.isAllowedToCall.returns(false);

      await expect(deviationSentinel.setNavGuardConfig(yieldGroup.address, RESOURCE, 1, 1)).to.be.reverted;
    });
  });

  describe("setNavGuardEnabled", () => {
    it("toggles without touching the thresholds", async () => {
      await expect(deviationSentinel.setNavGuardEnabled(yieldGroup.address, RESOURCE, false))
        .to.emit(deviationSentinel, "NavGuardStatusChanged")
        .withArgs(yieldGroup.address, RESOURCE, false);

      const stored = await deviationSentinel.navGuardConfigs(yieldGroup.address, RESOURCE);
      expect(stored.enabled).to.equal(false);
      expect(stored.pauseDownBps).to.equal(PAUSE_DOWN_BPS);
    });

    it("reverts on a zero YieldGroup or resource address", async () => {
      await expect(deviationSentinel.setNavGuardEnabled(ZERO_ADDRESS, RESOURCE, true)).to.be.revertedWithCustomError(
        deviationSentinel,
        "ZeroAddress",
      );

      await expect(
        deviationSentinel.setNavGuardEnabled(yieldGroup.address, ZERO_ADDRESS, true),
      ).to.be.revertedWithCustomError(deviationSentinel, "ZeroAddress");
    });

    // Otherwise this is a way around setNavGuardConfig's refusal of zero thresholds: a never-configured
    // resource would go live armed at 0/0, tripping on any clamp at all.
    it("cannot arm a resource that was never configured", async () => {
      await expect(deviationSentinel.setNavGuardEnabled(yieldGroup.address, OTHER_RESOURCE, true))
        .to.be.revertedWithCustomError(deviationSentinel, "ResourceNotConfigured")
        .withArgs(yieldGroup.address, OTHER_RESOURCE);

      const stored = await deviationSentinel.navGuardConfigs(yieldGroup.address, OTHER_RESOURCE);
      expect(stored.enabled).to.equal(false);
    });

    it("is ACM gated", async () => {
      accessControlManager.isAllowedToCall.returns(false);

      await expect(deviationSentinel.setNavGuardEnabled(yieldGroup.address, RESOURCE, false)).to.be.reverted;
    });
  });

  describe("handleNavGuardDeviation", () => {
    it("pauses the Hub and the resource through EBrake on a downside breach", async () => {
      navGuardStatus(800, true);

      await expect(deviationSentinel.connect(keeper).handleNavGuardDeviation(hub.address, yieldGroup.address, RESOURCE))
        .to.emit(deviationSentinel, "NavGuardDeviationHandled")
        .withArgs(hub.address, yieldGroup.address, RESOURCE, 800, MIN, MAX);

      expect(eBrake.pauseHub).to.have.been.calledOnceWith(hub.address);
      expect(eBrake.pauseResource).to.have.been.calledOnceWith(yieldGroup.address, RESOURCE);
    });

    it("pauses both on an upside breach", async () => {
      navGuardStatus(2_200, true);

      await expect(deviationSentinel.connect(keeper).handleNavGuardDeviation(hub.address, yieldGroup.address, RESOURCE))
        .to.emit(deviationSentinel, "NavGuardDeviationHandled")
        .withArgs(hub.address, yieldGroup.address, RESOURCE, 2_200, MIN, MAX);

      expect(eBrake.pauseHub).to.have.been.calledOnce;
      expect(eBrake.pauseResource).to.have.been.calledOnce;
    });

    it("reverts for a caller that is not a trusted keeper", async () => {
      navGuardStatus(800, true);

      await expect(
        deviationSentinel.connect(user).handleNavGuardDeviation(hub.address, yieldGroup.address, RESOURCE),
      ).to.be.revertedWithCustomError(deviationSentinel, "UnauthorizedKeeper");
      expect(eBrake.pauseHub).to.have.callCount(0);
    });

    it("reverts when NAV monitoring is disabled for the resource", async () => {
      navGuardStatus(800, true);
      await deviationSentinel.setNavGuardEnabled(yieldGroup.address, RESOURCE, false);

      await expect(deviationSentinel.connect(keeper).handleNavGuardDeviation(hub.address, yieldGroup.address, RESOURCE))
        .to.be.revertedWithCustomError(deviationSentinel, "NavGuardDisabled")
        .withArgs(yieldGroup.address, RESOURCE);
      expect(eBrake.pauseHub).to.have.callCount(0);
    });

    it("reverts when the resource was never configured", async () => {
      navGuardStatus(800, true);

      await expect(
        deviationSentinel.connect(keeper).handleNavGuardDeviation(hub.address, yieldGroup.address, OTHER_RESOURCE),
      )
        .to.be.revertedWithCustomError(deviationSentinel, "NavGuardDisabled")
        .withArgs(yieldGroup.address, OTHER_RESOURCE);
    });

    // The spoofed-YieldGroup trap: a fake YieldGroup reporting an invented clamp, paired with the
    // real Hub address, must not be able to pause the live Hub.
    it("reverts when the Hub does not list the YieldGroup", async () => {
      navGuardStatus(800, true);
      registerYieldGroup(false);

      await expect(deviationSentinel.connect(keeper).handleNavGuardDeviation(hub.address, yieldGroup.address, RESOURCE))
        .to.be.revertedWithCustomError(deviationSentinel, "YieldGroupNotRegistered")
        .withArgs(hub.address, yieldGroup.address);
      expect(eBrake.pauseHub).to.have.callCount(0);
      expect(eBrake.pauseResource).to.have.callCount(0);
    });

    it("reverts when the band is not clamping", async () => {
      navGuardStatus(1_500, false);

      await expect(deviationSentinel.connect(keeper).handleNavGuardDeviation(hub.address, yieldGroup.address, RESOURCE))
        .to.be.revertedWithCustomError(deviationSentinel, "NavGuardNotClamped")
        .withArgs(RESOURCE);
      expect(eBrake.pauseHub).to.have.callCount(0);
    });

    // The unreadable-adapter trap: navGuardStatus reports a reverting value source as
    // observedValue == 0 with isClamped false. A bare `observed < min` would read that as a 100%
    // drop and freeze the Hub on a transient failure.
    it("does not pause on an unreadable value source reporting zero", async () => {
      navGuardStatus(0, false);

      await expect(deviationSentinel.connect(keeper).handleNavGuardDeviation(hub.address, yieldGroup.address, RESOURCE))
        .to.be.revertedWithCustomError(deviationSentinel, "NavGuardNotClamped")
        .withArgs(RESOURCE);
      expect(eBrake.pauseHub).to.have.callCount(0);
      expect(eBrake.pauseResource).to.have.callCount(0);
    });

    it("leaves a clamp smaller than the threshold alone", async () => {
      navGuardStatus(950, true);

      await expect(deviationSentinel.connect(keeper).handleNavGuardDeviation(hub.address, yieldGroup.address, RESOURCE))
        .to.be.revertedWithCustomError(deviationSentinel, "DeviationWithinThreshold")
        .withArgs(RESOURCE, 950);
      expect(eBrake.pauseHub).to.have.callCount(0);
    });

    // A never-anchored band reads as [0, 0] while clamping. Its upside threshold computes to zero,
    // so an unguarded comparison would call any value a breach and freeze the Hub on first call.
    it("does not pause on a never-anchored [0, 0] band", async () => {
      yieldGroup.navGuardStatus.returns([500, 0, 0, true, 0]);

      await expect(
        deviationSentinel.connect(keeper).handleNavGuardDeviation(hub.address, yieldGroup.address, RESOURCE),
      ).to.be.revertedWithCustomError(deviationSentinel, "NavGuardNotClamped");
      expect(eBrake.pauseHub).to.have.callCount(0);
    });

    // An unregistered resource is absent from the YieldGroup's totalAssets() sum, and the
    // YieldGroup only allows removal at a zero receipt balance — so it contributes nothing and the
    // Hub cannot be harmed by its band. Pausing would be a no-op on a live Hub.
    it("does not pause for a resource the YieldGroup does not list", async () => {
      navGuardStatus(800, true);
      registerResource(false);

      await expect(deviationSentinel.connect(keeper).handleNavGuardDeviation(hub.address, yieldGroup.address, RESOURCE))
        .to.be.revertedWithCustomError(deviationSentinel, "ResourceNotRegistered")
        .withArgs(yieldGroup.address, RESOURCE);

      expect(eBrake.pauseHub).to.have.callCount(0);
      expect(eBrake.pauseResource).to.have.callCount(0);
      expect(yieldGroup.navGuardStatus).to.not.have.been.called;
    });

    // The registered check above is what makes the unguarded pair safe: it removes the only thing
    // the YieldGroup rejects pauseResource for, so neither leg can strand the other.
    it("fires both pauses on one transaction", async () => {
      navGuardStatus(800, true);

      await deviationSentinel.connect(keeper).handleNavGuardDeviation(hub.address, yieldGroup.address, RESOURCE);

      expect(eBrake.pauseHub).to.have.been.calledOnceWith(hub.address);
      expect(eBrake.pauseResource).to.have.been.calledOnceWith(yieldGroup.address, RESOURCE);
    });

    it("trips exactly at the threshold boundary, not one wei inside it", async () => {
      // Floor 1000 less 10% is 900: 900 is inside the quiet band, 899 is past it.
      navGuardStatus(900, true);
      await expect(
        deviationSentinel.connect(keeper).handleNavGuardDeviation(hub.address, yieldGroup.address, RESOURCE),
      ).to.be.revertedWithCustomError(deviationSentinel, "DeviationWithinThreshold");

      navGuardStatus(899, true);
      await expect(
        deviationSentinel.connect(keeper).handleNavGuardDeviation(hub.address, yieldGroup.address, RESOURCE),
      ).to.emit(deviationSentinel, "NavGuardDeviationHandled");
    });
  });

  describe("checkNavGuardDeviation", () => {
    // The read-only twin monitoring actually calls. Its job is to agree with handleNavGuardDeviation
    // on every input and to never revert, so a monitor can call it for anything it discovers.

    it("reports a downside breach with the band that produced it", async () => {
      navGuardStatus(899, true);

      const result = await deviationSentinel.checkNavGuardDeviation(hub.address, yieldGroup.address, RESOURCE);

      expect(result.hasDeviation).to.equal(true);
      expect(result.observedValue).to.equal(899);
      expect(result.minAllowedValue).to.equal(MIN);
      expect(result.maxAllowedValue).to.equal(MAX);
    });

    it("reports an upside breach", async () => {
      navGuardStatus(2_101, true);

      const { hasDeviation } = await deviationSentinel.checkNavGuardDeviation(
        hub.address,
        yieldGroup.address,
        RESOURCE,
      );
      expect(hasDeviation).to.equal(true);
    });

    it("agrees with handleNavGuardDeviation on the exact boundary", async () => {
      // One wei either side of the trip point, through both entrypoints. This is the pair that
      // catches the arithmetic drifting if the predicate is ever copied again — on chain or off.
      navGuardStatus(900, true);
      expect(
        (await deviationSentinel.checkNavGuardDeviation(hub.address, yieldGroup.address, RESOURCE)).hasDeviation,
      ).to.equal(false);
      await expect(
        deviationSentinel.connect(keeper).handleNavGuardDeviation(hub.address, yieldGroup.address, RESOURCE),
      ).to.be.revertedWithCustomError(deviationSentinel, "DeviationWithinThreshold");

      navGuardStatus(899, true);
      expect(
        (await deviationSentinel.checkNavGuardDeviation(hub.address, yieldGroup.address, RESOURCE)).hasDeviation,
      ).to.equal(true);
      await expect(
        deviationSentinel.connect(keeper).handleNavGuardDeviation(hub.address, yieldGroup.address, RESOURCE),
      ).to.emit(deviationSentinel, "NavGuardDeviationHandled");
    });

    it("returns false for an unarmed resource without reading the Hub or the band", async () => {
      navGuardStatus(0, true);

      const result = await deviationSentinel.checkNavGuardDeviation(hub.address, yieldGroup.address, OTHER_RESOURCE);

      expect(result.hasDeviation).to.equal(false);
      expect(hub.yieldGroupConfig).to.not.have.been.called;
      expect(yieldGroup.navGuardStatus).to.not.have.been.called;
    });

    it("returns false for a YieldGroup the Hub does not list, without reading its band", async () => {
      registerYieldGroup(false);
      navGuardStatus(899, true);

      const { hasDeviation } = await deviationSentinel.checkNavGuardDeviation(
        hub.address,
        yieldGroup.address,
        RESOURCE,
      );

      expect(hasDeviation).to.equal(false);
      expect(yieldGroup.navGuardStatus).to.not.have.been.called;
    });

    it("returns false on an unreadable value source, and still hands back what it read", async () => {
      // observedValue 0, unclamped. A caller comparing the value against the floor itself would
      // read this as a total loss; the band is returned so an alert can say what was seen.
      navGuardStatus(0, false);

      const result = await deviationSentinel.checkNavGuardDeviation(hub.address, yieldGroup.address, RESOURCE);

      expect(result.hasDeviation).to.equal(false);
      expect(result.observedValue).to.equal(0);
      expect(result.minAllowedValue).to.equal(MIN);
    });

    it("returns false for a clamp inside the threshold", async () => {
      navGuardStatus(950, true);

      const { hasDeviation } = await deviationSentinel.checkNavGuardDeviation(
        hub.address,
        yieldGroup.address,
        RESOURCE,
      );
      expect(hasDeviation).to.equal(false);
    });

    it("never reverts, whatever it is asked about", async () => {
      // Monitoring calls this for every resource on every Hub it walks. A revert on an unknown
      // address would turn a resource nobody configured into a failed sweep.
      const unknown = await deviationSentinel.checkNavGuardDeviation(ZERO_ADDRESS, ZERO_ADDRESS, OTHER_RESOURCE);
      expect(unknown.hasDeviation).to.equal(false);
    });

    it("is callable by anyone and pauses nothing", async () => {
      navGuardStatus(899, true);

      const { hasDeviation } = await deviationSentinel
        .connect(user)
        .checkNavGuardDeviation(hub.address, yieldGroup.address, RESOURCE);

      expect(hasDeviation).to.equal(true);
      expect(eBrake.pauseHub).to.not.have.been.called;
      expect(eBrake.pauseResource).to.not.have.been.called;
    });
  });

  describe("existing price-deviation surface", () => {
    // The NAV addition is append-only; the pre-existing config must still work untouched.
    it("still stores a token config alongside a NAV config", async () => {
      await deviationSentinel.setTokenConfig(RESOURCE, { deviation: 10, enabled: true });

      const token = await deviationSentinel.tokenConfigs(RESOURCE);
      expect(token.deviation).to.equal(10);
      expect(token.enabled).to.equal(true);

      const nav = await deviationSentinel.navGuardConfigs(yieldGroup.address, RESOURCE);
      expect(nav.pauseDownBps).to.equal(PAUSE_DOWN_BPS);
      expect(nav.enabled).to.equal(true);
    });
  });
});
