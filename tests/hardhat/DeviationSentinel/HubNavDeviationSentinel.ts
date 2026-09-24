import { FakeContract, smock } from "@defi-wonderland/smock";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import chai from "chai";
import { ethers, upgrades } from "hardhat";

import type {
  HubNavDeviationSentinel,
  IAccessControlManagerV8,
  IEBrake,
  IHub,
  IHubRegistry,
  IYieldGroupNav,
} from "../../../typechain";

const { expect } = chai;
chai.use(smock.matchers);

const RESOURCE = "0x0000000000000000000000000000000000000011";
const OTHER_RESOURCE = "0x0000000000000000000000000000000000000012";
const OTHER_HUB = "0x0000000000000000000000000000000000000013";
const ZERO_ADDRESS = ethers.constants.AddressZero;

// NavGuardCheckStatus, in declaration order.
const Status = {
  MonitoringDisabled: 0,
  YieldGroupNotRegistered: 1,
  ResourceNotRegistered: 2,
  ObservedValueZero: 3,
  CentreZero: 4,
  WithinThreshold: 5,
  Breached: 6,
};

// The exact strings the two setters ask the ACM for, and therefore the exact strings an onboarding
// VIP has to grant. A typo costs nothing at compile time and silently grants nothing on chain.
const SET_CONFIG_ROLE = "setHubNavConfig(address,address,uint16,uint16)";
const SET_ENABLED_ROLE = "setNavMonitoringEnabled(address,address,bool)";

// Pause thresholds, measured from the centre: 10% down, 5% up.
const PAUSE_DOWN_BPS = 1_000;
const PAUSE_UP_BPS = 500;

// Band used throughout, consistent with the NavBand stubbed in `navBand`: anchor and centre 1500
// with 200 bps gaps either side, so the Hub's own bounds are 1470 and 1530. The thresholds are
// wider than those gaps, as a real config must be, so it trips below 1350 and above 1575.
const CENTRE = 1_500;
const MIN = 1_470;
const MAX = 1_530;

describe("HubNavDeviationSentinel", () => {
  let sentinel: HubNavDeviationSentinel;
  let accessControlManager: FakeContract<IAccessControlManagerV8>;
  let eBrake: FakeContract<IEBrake>;
  let hubRegistry: FakeContract<IHubRegistry>;
  let hub: FakeContract<IHub>;
  let yieldGroup: FakeContract<IYieldGroupNav>;
  let keeper: SignerWithAddress;
  let user: SignerWithAddress;

  function registerHub(registered: boolean) {
    hubRegistry.isHub.returns(registered);
  }

  function registerYieldGroup(registered: boolean) {
    hub.yieldGroupConfig.returns([0, 0, false, registered]);
  }

  function registerResource(registered: boolean) {
    yieldGroup.resourceConfig.returns([registered, false, ZERO_ADDRESS]);
  }

  // NavBand, in the Hub's field order: anchor, centre, anchoredAt, driftFrom, interval, driftBps,
  // upGapBps, downGapBps, capEnabled, floorEnabled. Only `centre` and `capEnabled` are read.
  function navBand(centre: number, capEnabled = true) {
    yieldGroup.navGuard.returns([centre, centre, 0, 0, 86_400, 800, 200, 200, capEnabled, true]);
  }

  function navGuardStatus(observed: number, isClamped: boolean) {
    yieldGroup.navGuardStatus.returns([observed, MIN, MAX, isClamped, isClamped ? MIN : 0]);
    navBand(CENTRE);
  }

  // The whole chain live: registry vouches for the Hub, the Hub holds the YieldGroup, the
  // YieldGroup holds the resource and names that Hub. This is what the setters demand.
  function stubLiveChain() {
    yieldGroup.hub.returns(hub.address);
    registerHub(true);
    registerYieldGroup(true);
    registerResource(true);
  }

  async function deployFixture() {
    [, keeper, user] = await ethers.getSigners();

    accessControlManager = await smock.fake<IAccessControlManagerV8>("IAccessControlManagerV8");
    eBrake = await smock.fake<IEBrake>("IEBrake");
    hubRegistry = await smock.fake<IHubRegistry>("IHubRegistry");
    hub = await smock.fake<IHub>("IHub");
    yieldGroup = await smock.fake<IYieldGroupNav>("IYieldGroupNav");

    accessControlManager.isAllowedToCall.returns(true);

    const Factory = await ethers.getContractFactory("HubNavDeviationSentinel");
    sentinel = (await upgrades.deployProxy(Factory, [accessControlManager.address], {
      constructorArgs: [eBrake.address, hubRegistry.address],
      unsafeAllow: ["constructor", "internal-function-storage"],
    })) as HubNavDeviationSentinel;

    return { sentinel, accessControlManager, eBrake, hubRegistry, hub, yieldGroup, keeper, user };
  }

  beforeEach(async () => {
    ({ sentinel, accessControlManager, eBrake, hubRegistry, hub, yieldGroup, keeper, user } =
      await loadFixture(deployFixture));

    // loadFixture restores chain state, but smock fakes are JS-side and keep their stubs and call
    // history across tests. Reset them so each test starts from the same place.
    accessControlManager.isAllowedToCall.reset();
    accessControlManager.isAllowedToCall.returns(true);
    eBrake.pauseHub.reset();
    hubRegistry.isHub.reset();
    hub.yieldGroupConfig.reset();
    yieldGroup.hub.reset();
    yieldGroup.navGuardStatus.reset();
    yieldGroup.navGuard.reset();
    yieldGroup.resourceConfig.reset();

    stubLiveChain();

    await sentinel.setTrustedKeeper(keeper.address, true);
    await sentinel.setHubNavConfig(yieldGroup.address, RESOURCE, PAUSE_UP_BPS, PAUSE_DOWN_BPS);
    await sentinel.setNavMonitoringEnabled(yieldGroup.address, RESOURCE, true);

    // The setters just read all three; clear that history so a test asserting "was not read" is
    // talking about its own call. The stubs go straight back.
    hubRegistry.isHub.reset();
    hub.yieldGroupConfig.reset();
    yieldGroup.hub.reset();
    yieldGroup.resourceConfig.reset();
    stubLiveChain();
  });

  describe("setHubNavConfig", () => {
    it("stores the thresholds and the resolved Hub, and emits", async () => {
      await expect(sentinel.setHubNavConfig(yieldGroup.address, OTHER_RESOURCE, 100, 200))
        .to.emit(sentinel, "NavGuardConfigUpdated")
        .withArgs(hub.address, yieldGroup.address, OTHER_RESOURCE, [hub.address, 100, 200, false]);

      const stored = await sentinel.navGuardConfigs(yieldGroup.address, OTHER_RESOURCE);
      expect(stored.pauseUpBps).to.equal(100);
      expect(stored.pauseDownBps).to.equal(200);
      expect(stored.hub).to.equal(hub.address);
    });

    // The Hub is never passed in. Pointed at a second Hub, so passing only because the fixture's
    // Hub is the one it would have picked anyway is not enough to make this go green.
    it("stores whichever Hub the YieldGroup names, not the fixture's", async () => {
      const otherHub = await smock.fake<IHub>("IHub");
      otherHub.yieldGroupConfig.returns([0, 0, false, true]);
      yieldGroup.hub.returns(otherHub.address);

      await expect(sentinel.setHubNavConfig(yieldGroup.address, OTHER_RESOURCE, 100, 200))
        .to.emit(sentinel, "NavGuardConfigUpdated")
        .withArgs(otherHub.address, yieldGroup.address, OTHER_RESOURCE, [otherHub.address, 100, 200, false]);

      expect((await sentinel.navGuardConfigs(yieldGroup.address, OTHER_RESOURCE)).hub).to.equal(otherHub.address);
      expect(hubRegistry.isHub).to.have.been.calledWith(otherHub.address);
      expect(otherHub.yieldGroupConfig).to.have.been.calledWith(yieldGroup.address);
    });

    // A retune re-resolves it, so a stored Hub cannot outlive the YieldGroup that named it.
    it("refreshes the stored Hub on a retune", async () => {
      const otherHub = await smock.fake<IHub>("IHub");
      otherHub.yieldGroupConfig.returns([0, 0, false, true]);
      yieldGroup.hub.returns(otherHub.address);

      await sentinel.setHubNavConfig(yieldGroup.address, RESOURCE, PAUSE_UP_BPS, PAUSE_DOWN_BPS);

      expect((await sentinel.navGuardConfigs(yieldGroup.address, RESOURCE)).hub).to.equal(otherHub.address);
    });

    // A YieldGroup naming a Hub Venus never onboarded. The registry is the only party here that
    // governance controls, which is what makes it worth asking.
    it("reverts when the registry does not list the YieldGroup's Hub", async () => {
      yieldGroup.hub.returns(OTHER_HUB);
      registerHub(false);

      await expect(sentinel.setHubNavConfig(yieldGroup.address, OTHER_RESOURCE, 100, 200))
        .to.be.revertedWithCustomError(sentinel, "HubNotRegistered")
        .withArgs(OTHER_HUB, yieldGroup.address);
    });

    // A YieldGroup naming a real Hub it has nothing to do with. The registry cannot catch that one;
    // the Hub's own registry can.
    it("reverts when that Hub does not list the YieldGroup", async () => {
      registerYieldGroup(false);

      await expect(sentinel.setHubNavConfig(yieldGroup.address, OTHER_RESOURCE, 100, 200))
        .to.be.revertedWithCustomError(sentinel, "YieldGroupNotRegistered")
        .withArgs(hub.address, yieldGroup.address);
    });

    it("reverts when the YieldGroup does not list the resource", async () => {
      registerResource(false);

      await expect(sentinel.setHubNavConfig(yieldGroup.address, OTHER_RESOURCE, 100, 200))
        .to.be.revertedWithCustomError(sentinel, "ResourceNotRegistered")
        .withArgs(yieldGroup.address, OTHER_RESOURCE);
    });

    // Retuning a threshold must not disarm a live resource, and holding this role alone must not
    // be able to arm one — that is setNavMonitoringEnabled's job.
    it("leaves the enabled flag alone", async () => {
      await sentinel.setHubNavConfig(yieldGroup.address, RESOURCE, 100, 200);
      expect((await sentinel.navGuardConfigs(yieldGroup.address, RESOURCE)).enabled).to.equal(true);

      await sentinel.setHubNavConfig(yieldGroup.address, OTHER_RESOURCE, 100, 200);
      expect((await sentinel.navGuardConfigs(yieldGroup.address, OTHER_RESOURCE)).enabled).to.equal(false);
    });

    // The NavGuard band lives in each YieldGroup's own storage, so the same resource under two
    // YieldGroups has two independent bands and must not share one config.
    it("keys on the YieldGroup and the resource together", async () => {
      const otherYieldGroup = await smock.fake<IYieldGroupNav>("IYieldGroupNav");
      otherYieldGroup.hub.returns(hub.address);
      otherYieldGroup.resourceConfig.returns([true, false, ZERO_ADDRESS]);

      await sentinel.setHubNavConfig(otherYieldGroup.address, RESOURCE, 100, 200);

      const other = await sentinel.navGuardConfigs(otherYieldGroup.address, RESOURCE);
      expect(other.pauseUpBps).to.equal(100);
      expect(other.enabled).to.equal(false);

      const original = await sentinel.navGuardConfigs(yieldGroup.address, RESOURCE);
      expect(original.pauseUpBps).to.equal(PAUSE_UP_BPS);
      expect(original.enabled).to.equal(true);
    });

    it("reverts on a zero YieldGroup or resource address", async () => {
      await expect(sentinel.setHubNavConfig(ZERO_ADDRESS, RESOURCE, 1, 1)).to.be.revertedWithCustomError(
        sentinel,
        "ZeroAddress",
      );

      await expect(sentinel.setHubNavConfig(yieldGroup.address, ZERO_ADDRESS, 1, 1)).to.be.revertedWithCustomError(
        sentinel,
        "ZeroAddress",
      );
    });

    it("reverts only when both thresholds are zero", async () => {
      await expect(sentinel.setHubNavConfig(yieldGroup.address, RESOURCE, 0, 0)).to.be.revertedWithCustomError(
        sentinel,
        "ZeroDeviation",
      );
    });

    // Zero on one side is a real configuration, not a missing one: watch the upside and let a
    // genuine loss be recorded rather than freeze the Hub over it, or the reverse.
    it("accepts a threshold on one side only", async () => {
      await sentinel.setHubNavConfig(yieldGroup.address, OTHER_RESOURCE, PAUSE_UP_BPS, 0);
      await sentinel.setNavMonitoringEnabled(yieldGroup.address, OTHER_RESOURCE, true);

      const stored = await sentinel.navGuardConfigs(yieldGroup.address, OTHER_RESOURCE);
      expect(stored.pauseUpBps).to.equal(PAUSE_UP_BPS);
      expect(stored.pauseDownBps).to.equal(0);
      expect(stored.enabled).to.equal(true);
    });

    it("reverts when either threshold exceeds MAX_DEVIATION_BPS", async () => {
      await expect(sentinel.setHubNavConfig(yieldGroup.address, RESOURCE, 10_001, 100)).to.be.revertedWithCustomError(
        sentinel,
        "ExceedsMaxDeviation",
      );

      await expect(sentinel.setHubNavConfig(yieldGroup.address, RESOURCE, 100, 10_001)).to.be.revertedWithCustomError(
        sentinel,
        "ExceedsMaxDeviation",
      );
    });

    // At 10_000 the floor computes to zero, so nothing can ever fall below it and downside
    // monitoring is silently dead. The cap is inclusive upward, where there is no such point.
    it("rejects a downside threshold of exactly MAX_DEVIATION_BPS but allows it upward", async () => {
      await expect(sentinel.setHubNavConfig(yieldGroup.address, RESOURCE, 100, 10_000)).to.be.revertedWithCustomError(
        sentinel,
        "ExceedsMaxDeviation",
      );

      await expect(sentinel.setHubNavConfig(yieldGroup.address, RESOURCE, 10_000, 100)).to.not.be.reverted;
    });

    // Pins the ACM string itself rather than just that some check ran. `Unauthorized` carries the
    // signature the contract asked for, so a drift between it and what a VIP grants fails here.
    it("asks the ACM for exactly setHubNavConfig(address,address,uint16,uint16)", async () => {
      accessControlManager.isAllowedToCall.returns(false);

      await expect(sentinel.connect(user).setHubNavConfig(yieldGroup.address, RESOURCE, 1, 1))
        .to.be.revertedWithCustomError(sentinel, "Unauthorized")
        .withArgs(user.address, sentinel.address, SET_CONFIG_ROLE);
    });
  });

  describe("setNavMonitoringEnabled", () => {
    it("toggles without touching the thresholds", async () => {
      await expect(sentinel.setNavMonitoringEnabled(yieldGroup.address, RESOURCE, false))
        .to.emit(sentinel, "NavGuardStatusChanged")
        .withArgs(hub.address, yieldGroup.address, RESOURCE, false);

      const stored = await sentinel.navGuardConfigs(yieldGroup.address, RESOURCE);
      expect(stored.enabled).to.equal(false);
      expect(stored.pauseDownBps).to.equal(PAUSE_DOWN_BPS);
    });

    // Registration can be undone between configuring a resource and arming it, so arming re-runs
    // the same three reads rather than trusting what setHubNavConfig saw. All three, not just the
    // middle one: each covers a link the other two cannot.
    it("re-checks the chain when arming — registry dropped the Hub", async () => {
      await sentinel.setNavMonitoringEnabled(yieldGroup.address, RESOURCE, false);
      registerHub(false);

      await expect(sentinel.setNavMonitoringEnabled(yieldGroup.address, RESOURCE, true))
        .to.be.revertedWithCustomError(sentinel, "HubNotRegistered")
        .withArgs(hub.address, yieldGroup.address);
    });

    it("re-checks the chain when arming — Hub dropped the YieldGroup", async () => {
      await sentinel.setNavMonitoringEnabled(yieldGroup.address, RESOURCE, false);
      registerYieldGroup(false);

      await expect(sentinel.setNavMonitoringEnabled(yieldGroup.address, RESOURCE, true))
        .to.be.revertedWithCustomError(sentinel, "YieldGroupNotRegistered")
        .withArgs(hub.address, yieldGroup.address);
    });

    it("re-checks the chain when arming — YieldGroup dropped the resource", async () => {
      await sentinel.setNavMonitoringEnabled(yieldGroup.address, RESOURCE, false);
      registerResource(false);

      await expect(sentinel.setNavMonitoringEnabled(yieldGroup.address, RESOURCE, true))
        .to.be.revertedWithCustomError(sentinel, "ResourceNotRegistered")
        .withArgs(yieldGroup.address, RESOURCE);
    });

    // And disarming re-runs none of them. A resource whose Hub has since been dropped is exactly
    // the one that must stay switchable-off; a check here would be what traps it armed.
    it("still disarms after the Hub has been dropped from the registry", async () => {
      registerHub(false);
      registerYieldGroup(false);
      registerResource(false);

      await expect(sentinel.setNavMonitoringEnabled(yieldGroup.address, RESOURCE, false)).to.not.be.reverted;
      expect((await sentinel.navGuardConfigs(yieldGroup.address, RESOURCE)).enabled).to.equal(false);
    });

    it("reverts on a zero YieldGroup or resource address", async () => {
      await expect(sentinel.setNavMonitoringEnabled(ZERO_ADDRESS, RESOURCE, true)).to.be.revertedWithCustomError(
        sentinel,
        "ZeroAddress",
      );

      await expect(
        sentinel.setNavMonitoringEnabled(yieldGroup.address, ZERO_ADDRESS, true),
      ).to.be.revertedWithCustomError(sentinel, "ZeroAddress");
    });

    // Otherwise this is a way around setHubNavConfig's refusal of zero thresholds: a never-configured
    // resource would go live armed at 0/0, tripping on any value at all.
    it("cannot arm a resource that was never configured", async () => {
      await expect(sentinel.setNavMonitoringEnabled(yieldGroup.address, OTHER_RESOURCE, true))
        .to.be.revertedWithCustomError(sentinel, "ResourceNotConfigured")
        .withArgs(yieldGroup.address, OTHER_RESOURCE);

      const stored = await sentinel.navGuardConfigs(yieldGroup.address, OTHER_RESOURCE);
      expect(stored.enabled).to.equal(false);
    });

    it("asks the ACM for exactly setNavMonitoringEnabled(address,address,bool)", async () => {
      accessControlManager.isAllowedToCall.returns(false);

      await expect(sentinel.connect(user).setNavMonitoringEnabled(yieldGroup.address, RESOURCE, false))
        .to.be.revertedWithCustomError(sentinel, "Unauthorized")
        .withArgs(user.address, sentinel.address, SET_ENABLED_ROLE);
    });
  });

  describe("handleNavGuardDeviation", () => {
    it("pauses the Hub through EBrake on a downside breach", async () => {
      navGuardStatus(800, true);

      await expect(sentinel.connect(keeper).handleNavGuardDeviation(yieldGroup.address, RESOURCE))
        .to.emit(sentinel, "NavGuardDeviationHandled")
        .withArgs(hub.address, yieldGroup.address, RESOURCE, 800, CENTRE, MIN, MAX);

      expect(eBrake.pauseHub).to.have.been.calledOnceWith(hub.address);
    });

    it("pauses the Hub on an upside breach", async () => {
      navGuardStatus(2_200, true);

      await expect(sentinel.connect(keeper).handleNavGuardDeviation(yieldGroup.address, RESOURCE))
        .to.emit(sentinel, "NavGuardDeviationHandled")
        .withArgs(hub.address, yieldGroup.address, RESOURCE, 2_200, CENTRE, MIN, MAX);

      expect(eBrake.pauseHub).to.have.been.calledOnceWith(hub.address);
    });

    // The Hub that gets paused comes from the config, not from the call. Even a YieldGroup that has
    // started reporting a different Hub cannot redirect the pause.
    it("pauses the Hub governance configured, not the one the YieldGroup reports now", async () => {
      navGuardStatus(800, true);
      yieldGroup.hub.returns(OTHER_HUB);

      await sentinel.connect(keeper).handleNavGuardDeviation(yieldGroup.address, RESOURCE);

      expect(eBrake.pauseHub).to.have.been.calledOnceWith(hub.address);
    });

    it("reverts for a caller that is not a trusted keeper", async () => {
      navGuardStatus(800, true);

      await expect(
        sentinel.connect(user).handleNavGuardDeviation(yieldGroup.address, RESOURCE),
      ).to.be.revertedWithCustomError(sentinel, "UnauthorizedKeeper");
      expect(eBrake.pauseHub).to.have.callCount(0);
    });

    it("reverts when NAV monitoring is disabled for the resource", async () => {
      navGuardStatus(800, true);
      await sentinel.setNavMonitoringEnabled(yieldGroup.address, RESOURCE, false);

      await expect(sentinel.connect(keeper).handleNavGuardDeviation(yieldGroup.address, RESOURCE))
        .to.be.revertedWithCustomError(sentinel, "NavGuardDisabled")
        .withArgs(yieldGroup.address, RESOURCE);
      expect(eBrake.pauseHub).to.have.callCount(0);
    });

    it("reverts when the resource was never configured", async () => {
      navGuardStatus(800, true);

      await expect(sentinel.connect(keeper).handleNavGuardDeviation(yieldGroup.address, OTHER_RESOURCE))
        .to.be.revertedWithCustomError(sentinel, "NavGuardDisabled")
        .withArgs(yieldGroup.address, OTHER_RESOURCE);
    });

    // A YieldGroup the Hub has since dropped. Checked at config time too, but registration can be
    // undone afterwards, so the handler does not take the earlier check on trust.
    it("reverts when the Hub does not list the YieldGroup", async () => {
      navGuardStatus(800, true);
      registerYieldGroup(false);

      await expect(sentinel.connect(keeper).handleNavGuardDeviation(yieldGroup.address, RESOURCE))
        .to.be.revertedWithCustomError(sentinel, "YieldGroupNotRegistered")
        .withArgs(hub.address, yieldGroup.address);
      expect(eBrake.pauseHub).to.have.callCount(0);
    });

    // Governance can switch a band's cap or floor off in the Hub without disarming the band, which
    // is when a pause matters most. So the break alone decides here and `isClamped` is not read.
    it("pauses on a break past the threshold even while the Hub is not clamping", async () => {
      navGuardStatus(2_500, false);

      await sentinel.connect(keeper).handleNavGuardDeviation(yieldGroup.address, RESOURCE);

      expect(eBrake.pauseHub).to.have.been.calledOnceWith(hub.address);
    });

    // A zero threshold reads as the tightest trip point there is if it is not tested for first:
    // downTripPoint lands on the centre itself, so 800 against a centre of 1500 would pause the Hub.
    it("does not fire on a side whose threshold is zero", async () => {
      await sentinel.setHubNavConfig(yieldGroup.address, RESOURCE, PAUSE_UP_BPS, 0);
      navGuardStatus(800, true);

      await expect(sentinel.connect(keeper).handleNavGuardDeviation(yieldGroup.address, RESOURCE))
        .to.be.revertedWithCustomError(sentinel, "DeviationWithinThreshold")
        .withArgs(RESOURCE, 800);
      expect(eBrake.pauseHub).to.have.callCount(0);
    });

    it("still fires on the armed side when the other is zero", async () => {
      await sentinel.setHubNavConfig(yieldGroup.address, RESOURCE, PAUSE_UP_BPS, 0);
      navGuardStatus(2_500, true);

      await sentinel.connect(keeper).handleNavGuardDeviation(yieldGroup.address, RESOURCE);

      expect(eBrake.pauseHub).to.have.been.calledOnceWith(hub.address);
    });

    it("leaves a value inside the band alone whether or not the Hub is clamping", async () => {
      navGuardStatus(1_500, false);

      await expect(sentinel.connect(keeper).handleNavGuardDeviation(yieldGroup.address, RESOURCE))
        .to.be.revertedWithCustomError(sentinel, "DeviationWithinThreshold")
        .withArgs(RESOURCE, 1_500);
      expect(eBrake.pauseHub).to.have.callCount(0);
    });

    // navGuardStatus reports a value source it could not read as observedValue == 0. A bare
    // `observed < min` would take that for a 100% drop and freeze the Hub on a transient failure.
    it("does not pause on an unreadable value source reporting zero", async () => {
      navGuardStatus(0, false);

      await expect(sentinel.connect(keeper).handleNavGuardDeviation(yieldGroup.address, RESOURCE))
        .to.be.revertedWithCustomError(sentinel, "NavGuardObservedValueZero")
        .withArgs(RESOURCE);
      expect(eBrake.pauseHub).to.have.callCount(0);
    });

    // The case that separates the two formulas. From the centre the trip point is 1350, so 1340
    // breaches. From the floor it would be 1470 less 10% = 1323, and 1340 would have passed. Any
    // value far outside the band trips under both, so only this narrow window pins the reference.
    it("measures from the centre, not from the band edge", async () => {
      navGuardStatus(1_340, true);

      await sentinel.connect(keeper).handleNavGuardDeviation(yieldGroup.address, RESOURCE);

      expect(eBrake.pauseHub).to.have.been.calledOnceWith(hub.address);
    });

    it("leaves a clamp smaller than the threshold alone", async () => {
      navGuardStatus(1_400, true);

      await expect(sentinel.connect(keeper).handleNavGuardDeviation(yieldGroup.address, RESOURCE))
        .to.be.revertedWithCustomError(sentinel, "DeviationWithinThreshold")
        .withArgs(RESOURCE, 1_400);
      expect(eBrake.pauseHub).to.have.callCount(0);
    });

    // A closed band (centre 0) that still reads a real value is the Hub's own `_guardedNav`
    // clamping this resource down to that closed cap — zero — while the position is genuinely
    // still worth 500. That understates NAV by the whole position, so it is a breach, not a no-op.
    it("pauses on a closed band whose cap is clamping a real value to zero", async () => {
      yieldGroup.navGuardStatus.returns([500, 0, 0, true, 0]);
      navBand(0);

      await sentinel.connect(keeper).handleNavGuardDeviation(yieldGroup.address, RESOURCE);

      expect(eBrake.pauseHub).to.have.been.calledOnceWith(hub.address);
    });

    // With the cap off, the same closed band passes the real value straight through the Hub
    // unclamped, so there is genuinely nothing wrong to flag.
    it("does not pause on a closed band whose cap is off", async () => {
      yieldGroup.navGuardStatus.returns([500, 0, 0, false, 0]);
      navBand(0, false);

      await expect(sentinel.connect(keeper).handleNavGuardDeviation(yieldGroup.address, RESOURCE))
        .to.be.revertedWithCustomError(sentinel, "NavGuardCentreZero")
        .withArgs(RESOURCE);
      expect(eBrake.pauseHub).to.have.callCount(0);
    });

    // A closed, capped band whose downside was left unwatched is a side governance opted out of —
    // silently forcing a pause here would override that choice, not fix the blind spot.
    it("does not pause on a closed, capped band when the downside is unwatched", async () => {
      await sentinel.setHubNavConfig(yieldGroup.address, RESOURCE, PAUSE_UP_BPS, 0);
      yieldGroup.navGuardStatus.returns([500, 0, 0, true, 0]);
      navBand(0);

      await expect(sentinel.connect(keeper).handleNavGuardDeviation(yieldGroup.address, RESOURCE))
        .to.be.revertedWithCustomError(sentinel, "NavGuardCentreZero")
        .withArgs(RESOURCE);
      expect(eBrake.pauseHub).to.have.callCount(0);
    });

    // The two zeros are different verdicts and must not collapse into one: a zero reading says
    // nothing about the position, a zero centre with the cap off says nothing to compare a real
    // reading against.
    it("tells a zero reading apart from a zero centre", async () => {
      navGuardStatus(0, false);
      expect((await sentinel.checkNavGuardDeviation(yieldGroup.address, RESOURCE)).status).to.equal(
        Status.ObservedValueZero,
      );

      yieldGroup.navGuardStatus.returns([500, 0, 0, false, 0]);
      navBand(0, false);
      expect((await sentinel.checkNavGuardDeviation(yieldGroup.address, RESOURCE)).status).to.equal(Status.CentreZero);
    });

    // An unregistered resource holds nothing, so its band cannot harm the Hub, and the check runs
    // before the band is read at all.
    it("does not pause for a resource the YieldGroup does not list", async () => {
      navGuardStatus(800, true);
      registerResource(false);

      await expect(sentinel.connect(keeper).handleNavGuardDeviation(yieldGroup.address, RESOURCE))
        .to.be.revertedWithCustomError(sentinel, "ResourceNotRegistered")
        .withArgs(yieldGroup.address, RESOURCE);

      expect(eBrake.pauseHub).to.have.callCount(0);
      expect(yieldGroup.navGuardStatus).to.not.have.been.called;
    });

    // The two sides are separate expressions — one subtracts from BPS, the other adds — so the
    // downside boundary passing says nothing about the upside one.
    it("trips exactly at the upside boundary, not one wei inside it", async () => {
      // Centre 1500 plus 5% is 1575: 1575 is inside the quiet band, 1576 is past it.
      navGuardStatus(1_575, true);
      await expect(sentinel.connect(keeper).handleNavGuardDeviation(yieldGroup.address, RESOURCE))
        .to.be.revertedWithCustomError(sentinel, "DeviationWithinThreshold")
        .withArgs(RESOURCE, 1_575);

      navGuardStatus(1_576, true);
      await expect(sentinel.connect(keeper).handleNavGuardDeviation(yieldGroup.address, RESOURCE)).to.emit(
        sentinel,
        "NavGuardDeviationHandled",
      );
      expect(eBrake.pauseHub).to.have.been.calledOnceWith(hub.address);
    });

    it("trips exactly at the downside boundary, not one wei inside it", async () => {
      // Centre 1500 less 10% is 1350: 1350 is inside the quiet band, 1349 is past it.
      navGuardStatus(1_350, true);
      await expect(
        sentinel.connect(keeper).handleNavGuardDeviation(yieldGroup.address, RESOURCE),
      ).to.be.revertedWithCustomError(sentinel, "DeviationWithinThreshold");

      navGuardStatus(1_349, true);
      await expect(sentinel.connect(keeper).handleNavGuardDeviation(yieldGroup.address, RESOURCE)).to.emit(
        sentinel,
        "NavGuardDeviationHandled",
      );
    });
  });

  describe("checkNavGuardDeviation", () => {
    // Monitoring reads this view and the handler acts on it, so the two cannot disagree. It returns
    // the reason rather than a bool, which is what tells a quiet band apart from a misconfigured one.
    // It still propagates a revert from `yieldGroup`, which the caller supplies.

    it("reports a downside breach with the Hub and the band that produced it", async () => {
      navGuardStatus(1_349, true);

      const result = await sentinel.checkNavGuardDeviation(yieldGroup.address, RESOURCE);

      expect(result.status).to.equal(Status.Breached);
      expect(result.hub).to.equal(hub.address);
      expect(result.observedValue).to.equal(1_349);
      expect(result.centre).to.equal(CENTRE);
      expect(result.minAllowedValue).to.equal(MIN);
      expect(result.maxAllowedValue).to.equal(MAX);
    });

    it("reports an upside breach", async () => {
      navGuardStatus(1_576, true);

      const { status } = await sentinel.checkNavGuardDeviation(yieldGroup.address, RESOURCE);
      expect(status).to.equal(Status.Breached);
    });

    it("agrees with handleNavGuardDeviation on the exact boundary", async () => {
      // One wei either side of the trip point, through both entrypoints. The handler calls this
      // view, so this pins that the wiring is right as much as the arithmetic.
      navGuardStatus(1_350, true);
      expect((await sentinel.checkNavGuardDeviation(yieldGroup.address, RESOURCE)).status).to.equal(
        Status.WithinThreshold,
      );
      await expect(
        sentinel.connect(keeper).handleNavGuardDeviation(yieldGroup.address, RESOURCE),
      ).to.be.revertedWithCustomError(sentinel, "DeviationWithinThreshold");

      navGuardStatus(1_349, true);
      expect((await sentinel.checkNavGuardDeviation(yieldGroup.address, RESOURCE)).status).to.equal(Status.Breached);
      await expect(sentinel.connect(keeper).handleNavGuardDeviation(yieldGroup.address, RESOURCE)).to.emit(
        sentinel,
        "NavGuardDeviationHandled",
      );
    });

    it("reports MonitoringDisabled for an unarmed resource without reading the Hub or the band", async () => {
      navGuardStatus(0, true);

      const result = await sentinel.checkNavGuardDeviation(yieldGroup.address, OTHER_RESOURCE);

      expect(result.status).to.equal(Status.MonitoringDisabled);
      expect(result.hub).to.equal(ZERO_ADDRESS);
      expect(hub.yieldGroupConfig).to.not.have.been.called;
      expect(yieldGroup.navGuardStatus).to.not.have.been.called;
    });

    it("reports YieldGroupNotRegistered without reading its band", async () => {
      registerYieldGroup(false);
      navGuardStatus(1_349, true);

      const { status } = await sentinel.checkNavGuardDeviation(yieldGroup.address, RESOURCE);

      expect(status).to.equal(Status.YieldGroupNotRegistered);
      expect(yieldGroup.navGuardStatus).to.not.have.been.called;
    });

    it("reports ObservedValueZero on an unreadable value source, and still hands back what it read", async () => {
      // A caller comparing observedValue against the floor itself would read this 0 as a total loss.
      // The band comes back anyway, so an alert can report what was actually seen.
      navGuardStatus(0, false);

      const result = await sentinel.checkNavGuardDeviation(yieldGroup.address, RESOURCE);

      expect(result.status).to.equal(Status.ObservedValueZero);
      expect(result.observedValue).to.equal(0);
      expect(result.minAllowedValue).to.equal(MIN);
    });

    it("reports ResourceNotRegistered without reading the band", async () => {
      registerResource(false);
      navGuardStatus(1_349, true);

      const { status, hub: reported } = await sentinel.checkNavGuardDeviation(yieldGroup.address, RESOURCE);

      expect(status).to.equal(Status.ResourceNotRegistered);
      expect(reported).to.equal(hub.address);
      expect(yieldGroup.navGuardStatus).to.not.have.been.called;
    });

    it("reports WithinThreshold for a break inside the threshold", async () => {
      navGuardStatus(1_400, true);

      const { status } = await sentinel.checkNavGuardDeviation(yieldGroup.address, RESOURCE);
      expect(status).to.equal(Status.WithinThreshold);
    });

    it("never reverts on a pair nobody configured", async () => {
      // Monitoring calls this for every resource on every YieldGroup it walks. A revert on an
      // unknown address would turn a resource nobody configured into a failed sweep.
      const unknown = await sentinel.checkNavGuardDeviation(ZERO_ADDRESS, OTHER_RESOURCE);
      expect(unknown.status).to.equal(Status.MonitoringDisabled);
    });

    it("is callable by anyone and pauses nothing", async () => {
      navGuardStatus(1_349, true);

      const { status } = await sentinel.connect(user).checkNavGuardDeviation(yieldGroup.address, RESOURCE);

      expect(status).to.equal(Status.Breached);
      expect(eBrake.pauseHub).to.not.have.been.called;
    });
  });

  describe("deployment", () => {
    it("stores the EBrake and Hub registry it was constructed with", async () => {
      expect(await sentinel.EBRAKE()).to.equal(eBrake.address);
      expect(await sentinel.HUB_REGISTRY()).to.equal(hubRegistry.address);
    });

    it("reverts on a zero EBrake or Hub registry", async () => {
      const Factory = await ethers.getContractFactory("HubNavDeviationSentinel");
      for (const constructorArgs of [
        [ZERO_ADDRESS, hubRegistry.address],
        [eBrake.address, ZERO_ADDRESS],
      ]) {
        await expect(
          upgrades.deployProxy(Factory, [accessControlManager.address], {
            constructorArgs,
            unsafeAllow: ["constructor", "internal-function-storage"],
          }),
        ).to.be.revertedWithCustomError(sentinel, "ZeroAddress");
      }
    });
  });

  describe("setTrustedKeeper", () => {
    it("gates the keeper function on the keeper list", async () => {
      navGuardStatus(1_349, true);
      await expect(sentinel.setTrustedKeeper(keeper.address, false))
        .to.emit(sentinel, "TrustedKeeperUpdated")
        .withArgs(keeper.address, false);

      await expect(
        sentinel.connect(keeper).handleNavGuardDeviation(yieldGroup.address, RESOURCE),
      ).to.be.revertedWithCustomError(sentinel, "UnauthorizedKeeper");
      expect(eBrake.pauseHub).to.have.callCount(0);
    });

    it("reverts on a zero keeper", async () => {
      await expect(sentinel.setTrustedKeeper(ZERO_ADDRESS, true)).to.be.revertedWithCustomError(
        sentinel,
        "ZeroAddress",
      );
    });
  });
});
