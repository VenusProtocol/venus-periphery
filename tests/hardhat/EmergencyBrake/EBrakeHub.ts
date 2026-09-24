import { FakeContract, smock } from "@defi-wonderland/smock";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import chai from "chai";
import { ethers, upgrades } from "hardhat";

import type { EBrake, IAccessControlManagerV8, ICorePoolComptroller, IHub, IYieldGroupNav } from "../../../typechain";

const { expect } = chai;
chai.use(smock.matchers);

const ZERO_ADDRESS = ethers.constants.AddressZero;

// The exact string the Hub forwarder asks the ACM for, and therefore the exact string an onboarding
// VIP has to grant. A typo here costs nothing at compile time and silently grants nothing on chain.
const PAUSE_HUB_ROLE = "pauseHub(address)";
const PAUSE_YIELD_GROUP_ROLE = "pauseHubYieldGroup(address)";
const PAUSE_RESOURCE_ROLE = "pauseHubResource(address,address)";

const RESOURCE = "0x000000000000000000000000000000000000dEaD";

// Hub.yieldGroupConfig: (absoluteCap, percentageCapBps, paused, registered).
const yieldGroupConfig = (paused: boolean) => ({ absoluteCap: 0, percentageCapBps: 0, paused, registered: true });

// Only the Liquidity Hub forwarders added on top of the existing EBrake surface.
describe("EBrake — Liquidity Hub forwarders", () => {
  let eBrake: EBrake;
  let accessControlManager: FakeContract<IAccessControlManagerV8>;
  let comptroller: FakeContract<ICorePoolComptroller>;
  let hub: FakeContract<IHub>;
  let yieldGroup: FakeContract<IYieldGroupNav>;
  let owner: SignerWithAddress;
  let user: SignerWithAddress;

  async function deployFixture() {
    // smock needs a live provider, and it does not start one. Without a call that hits the node
    // first, this file passes in a full run — where an earlier file woke it — and fails with HH21
    // when run on its own.
    [owner, user] = await ethers.getSigners();

    accessControlManager = await smock.fake<IAccessControlManagerV8>("IAccessControlManagerV8");
    comptroller = await smock.fake<ICorePoolComptroller>("ICorePoolComptroller");
    hub = await smock.fake<IHub>("IHub");
    yieldGroup = await smock.fake<IYieldGroupNav>("IYieldGroupNav");

    accessControlManager.isAllowedToCall.returns(true);

    const Factory = await ethers.getContractFactory("EBrake");
    eBrake = (await upgrades.deployProxy(Factory, [accessControlManager.address], {
      constructorArgs: [comptroller.address, false],
      unsafeAllow: ["constructor", "state-variable-immutable"],
    })) as EBrake;

    return { eBrake, accessControlManager, comptroller, hub, yieldGroup, owner, user };
  }

  beforeEach(async () => {
    ({ eBrake, accessControlManager, comptroller, hub, yieldGroup, owner, user } = await loadFixture(deployFixture));

    // loadFixture restores chain state, but smock fakes are JS-side and keep their stubs and call
    // history across tests.
    accessControlManager.isAllowedToCall.reset();
    accessControlManager.isAllowedToCall.returns(true);
    hub.pauseHub.reset();
    hub.hubPaused.reset();
    hub.pauseYieldGroup.reset();
    hub.yieldGroupConfig.reset();
    yieldGroup.pauseResource.reset();
    yieldGroup.resourceConfig.reset();
    yieldGroup.hub.reset();

    hub.hubPaused.returns(false);
    hub.yieldGroupConfig.returns(yieldGroupConfig(false));
    yieldGroup.resourceConfig.returns([true, false, ZERO_ADDRESS]);
    yieldGroup.hub.returns(hub.address);
  });

  describe("pauseHub", () => {
    it("forwards to the Hub and emits the caller and the Hub", async () => {
      await expect(eBrake.pauseHub(hub.address)).to.emit(eBrake, "HubPaused").withArgs(owner.address, hub.address);

      expect(hub.pauseHub).to.have.been.calledOnce;
    });

    // The Hub checks its own ACM, so skipping the forward on an already-paused Hub also skips that
    // hop. Reading first is what buys that, and it has to happen before the call, not after.
    it("reads hubPaused before forwarding", async () => {
      await eBrake.pauseHub(hub.address);

      expect(hub.hubPaused).to.have.been.calledBefore(hub.pauseHub);
    });

    it("reverts on a zero Hub address without calling anything", async () => {
      await expect(eBrake.pauseHub(ZERO_ADDRESS)).to.be.revertedWithCustomError(eBrake, "ZeroAddress");

      expect(hub.hubPaused).to.have.callCount(0);
      expect(hub.pauseHub).to.have.callCount(0);
    });

    // Pins the ACM string itself, not just that some check happened. `Unauthorized` carries the
    // signature EBrake asked for, so a drift between this string and the one a VIP grants fails here
    // rather than on chain.
    it("asks the ACM for exactly pauseHub(address)", async () => {
      accessControlManager.isAllowedToCall.returns(false);

      await expect(eBrake.connect(user).pauseHub(hub.address))
        .to.be.revertedWithCustomError(eBrake, "Unauthorized")
        .withArgs(user.address, eBrake.address, PAUSE_HUB_ROLE);

      expect(hub.pauseHub).to.have.callCount(0);
    });

    it("is a silent no-op when the Hub is already paused", async () => {
      hub.hubPaused.returns(true);

      await expect(eBrake.pauseHub(hub.address)).to.not.emit(eBrake, "HubPaused");
      expect(hub.pauseHub).to.have.callCount(0);
    });

    // Second call in the same state. The Hub reports itself paused by then, so the no-op path is the
    // one a keeper actually repeats, and it must stay quiet rather than emit a second HubPaused.
    it("emits once across two calls when the first one lands", async () => {
      await expect(eBrake.pauseHub(hub.address)).to.emit(eBrake, "HubPaused");

      hub.hubPaused.returns(true);
      await expect(eBrake.pauseHub(hub.address)).to.not.emit(eBrake, "HubPaused");

      expect(hub.pauseHub).to.have.callCount(1);
    });

    // An address with no code answers a staticcall with empty returndata, which fails to decode.
    // Reverting is the wanted outcome: a typo'd Hub must not read as "already paused" and pass.
    it("reverts on an address that is not a Hub", async () => {
      await expect(eBrake.pauseHub(user.address)).to.be.reverted;
    });
  });

  describe("pauseHubYieldGroup", () => {
    it("forwards to the Hub and emits the caller, the Hub and the YieldGroup", async () => {
      await expect(eBrake.pauseHubYieldGroup(yieldGroup.address))
        .to.emit(eBrake, "HubYieldGroupPaused")
        .withArgs(owner.address, hub.address, yieldGroup.address);

      expect(hub.pauseYieldGroup).to.have.been.calledOnceWith(yieldGroup.address);
      expect(hub.yieldGroupConfig).to.have.been.calledBefore(hub.pauseYieldGroup);
    });

    it("reverts on a zero YieldGroup without calling anything", async () => {
      await expect(eBrake.pauseHubYieldGroup(ZERO_ADDRESS)).to.be.revertedWithCustomError(eBrake, "ZeroAddress");

      expect(yieldGroup.hub).to.have.callCount(0);
      expect(hub.yieldGroupConfig).to.have.callCount(0);
      expect(hub.pauseYieldGroup).to.have.callCount(0);
    });

    // The Hub comes from the YieldGroup, not the caller, so it has to be read before anything else.
    it("resolves the Hub from the YieldGroup before reading the Hub", async () => {
      await eBrake.pauseHubYieldGroup(yieldGroup.address);

      expect(yieldGroup.hub).to.have.been.calledBefore(hub.yieldGroupConfig);
    });

    // A YieldGroup that names no Hub leaves nothing to forward to, and must not read as "already paused".
    it("reverts when the YieldGroup names no Hub", async () => {
      yieldGroup.hub.returns(ZERO_ADDRESS);

      await expect(eBrake.pauseHubYieldGroup(yieldGroup.address)).to.be.reverted;
      expect(hub.pauseYieldGroup).to.have.callCount(0);
    });

    it("asks the ACM for exactly pauseHubYieldGroup(address)", async () => {
      accessControlManager.isAllowedToCall.returns(false);

      await expect(eBrake.connect(user).pauseHubYieldGroup(yieldGroup.address))
        .to.be.revertedWithCustomError(eBrake, "Unauthorized")
        .withArgs(user.address, eBrake.address, PAUSE_YIELD_GROUP_ROLE);

      expect(hub.pauseYieldGroup).to.have.callCount(0);
    });

    it("is a silent no-op when the YieldGroup is already paused", async () => {
      hub.yieldGroupConfig.returns(yieldGroupConfig(true));

      await expect(eBrake.pauseHubYieldGroup(yieldGroup.address)).to.not.emit(eBrake, "HubYieldGroupPaused");
      expect(hub.pauseYieldGroup).to.have.callCount(0);
    });

    // An unregistered YieldGroup reads as unpaused, so EBrake forwards and the Hub's revert must
    // come back rather than be swallowed into a silent success.
    it("bubbles up the Hub's revert", async () => {
      hub.pauseYieldGroup.reverts("YieldGroupNotRegistered");

      await expect(eBrake.pauseHubYieldGroup(yieldGroup.address)).to.be.revertedWith("YieldGroupNotRegistered");
    });
  });

  describe("pauseHubResource", () => {
    it("forwards to the YieldGroup and emits the caller, the YieldGroup and the resource", async () => {
      await expect(eBrake.pauseHubResource(yieldGroup.address, RESOURCE))
        .to.emit(eBrake, "HubResourcePaused")
        .withArgs(owner.address, yieldGroup.address, RESOURCE);

      expect(yieldGroup.pauseResource).to.have.been.calledOnceWith(RESOURCE);
      expect(yieldGroup.resourceConfig).to.have.been.calledBefore(yieldGroup.pauseResource);
    });

    it("reverts on a zero YieldGroup or resource without calling anything", async () => {
      await expect(eBrake.pauseHubResource(ZERO_ADDRESS, RESOURCE)).to.be.revertedWithCustomError(
        eBrake,
        "ZeroAddress",
      );
      await expect(eBrake.pauseHubResource(yieldGroup.address, ZERO_ADDRESS)).to.be.revertedWithCustomError(
        eBrake,
        "ZeroAddress",
      );

      expect(yieldGroup.resourceConfig).to.have.callCount(0);
      expect(yieldGroup.pauseResource).to.have.callCount(0);
    });

    it("asks the ACM for exactly pauseHubResource(address,address)", async () => {
      accessControlManager.isAllowedToCall.returns(false);

      await expect(eBrake.connect(user).pauseHubResource(yieldGroup.address, RESOURCE))
        .to.be.revertedWithCustomError(eBrake, "Unauthorized")
        .withArgs(user.address, eBrake.address, PAUSE_RESOURCE_ROLE);

      expect(yieldGroup.pauseResource).to.have.callCount(0);
    });

    it("is a silent no-op when the resource is already paused", async () => {
      yieldGroup.resourceConfig.returns([true, true, ZERO_ADDRESS]);

      await expect(eBrake.pauseHubResource(yieldGroup.address, RESOURCE)).to.not.emit(eBrake, "HubResourcePaused");
      expect(yieldGroup.pauseResource).to.have.callCount(0);
    });

    it("bubbles up the YieldGroup's revert", async () => {
      yieldGroup.pauseResource.reverts("ResourceNotRegistered");

      await expect(eBrake.pauseHubResource(yieldGroup.address, RESOURCE)).to.be.revertedWith("ResourceNotRegistered");
    });
  });

  describe("tighten-only invariant", () => {
    // Asserting the absence of something passes just as well when the thing it guards is gone, so
    // pin the pause side too: the Hub surface is the three pauses and nothing that reverses them.
    it("exposes the Hub pauses and no unpause for the Hub", async () => {
      const fns = Object.keys(eBrake.interface.functions);

      expect(fns.filter(f => f.toLowerCase().includes("unpause"))).to.deep.equal([]);
      expect(fns.filter(f => f.toLowerCase().includes("hub")).sort()).to.deep.equal(
        [PAUSE_HUB_ROLE, PAUSE_RESOURCE_ROLE, PAUSE_YIELD_GROUP_ROLE].sort(),
      );
    });
  });
});
