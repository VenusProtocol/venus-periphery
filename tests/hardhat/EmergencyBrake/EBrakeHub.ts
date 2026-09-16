import { FakeContract, smock } from "@defi-wonderland/smock";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import chai from "chai";
import { ethers, upgrades } from "hardhat";

import type { EBrake, IAccessControlManagerV8, ICorePoolComptroller, IHub, IYieldGroupNav } from "../../../typechain";

const { expect } = chai;
chai.use(smock.matchers);

const RESOURCE = "0x0000000000000000000000000000000000000011";
const ZERO_ADDRESS = ethers.constants.AddressZero;

// Only the Liquidity Hub forwarders added on top of the existing EBrake surface.
describe("EBrake — Liquidity Hub forwarders", () => {
  let eBrake: EBrake;
  let accessControlManager: FakeContract<IAccessControlManagerV8>;
  let comptroller: FakeContract<ICorePoolComptroller>;
  let hub: FakeContract<IHub>;
  let yieldGroup: FakeContract<IYieldGroupNav>;

  async function deployFixture() {
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

    return { eBrake, accessControlManager, comptroller, hub, yieldGroup };
  }

  beforeEach(async () => {
    ({ eBrake, accessControlManager, comptroller, hub, yieldGroup } = await loadFixture(deployFixture));

    // loadFixture restores chain state, but smock fakes are JS-side and keep their stubs and call
    // history across tests.
    accessControlManager.isAllowedToCall.reset();
    accessControlManager.isAllowedToCall.returns(true);
    hub.pauseHub.reset();
    hub.hubPaused.reset();
    yieldGroup.pauseResource.reset();
    yieldGroup.resourceConfig.reset();

    hub.hubPaused.returns(false);
    yieldGroup.resourceConfig.returns([true, false, ZERO_ADDRESS]);
  });

  describe("pauseHub", () => {
    it("forwards to the Hub and emits", async () => {
      await expect(eBrake.pauseHub(hub.address)).to.emit(eBrake, "HubPaused");
      expect(hub.pauseHub).to.have.been.calledOnce;
    });

    it("reverts on a zero Hub address", async () => {
      await expect(eBrake.pauseHub(ZERO_ADDRESS)).to.be.revertedWithCustomError(eBrake, "ZeroAddress");
    });

    it("is ACM gated", async () => {
      accessControlManager.isAllowedToCall.returns(false);

      await expect(eBrake.pauseHub(hub.address)).to.be.reverted;
      expect(hub.pauseHub).to.have.callCount(0);
    });

    // Idempotent, like pauseFlashLoan: no call and no event, so HubPaused stays a true
    // state-change signal. Skipping the call also skips the Hub's own ACM hop.
    it("is a silent no-op when the Hub is already paused", async () => {
      hub.hubPaused.returns(true);

      await expect(eBrake.pauseHub(hub.address)).to.not.emit(eBrake, "HubPaused");
      expect(hub.pauseHub).to.have.callCount(0);
    });
  });

  describe("pauseResource", () => {
    it("forwards to the YieldGroup and emits", async () => {
      await expect(eBrake.pauseResource(yieldGroup.address, RESOURCE)).to.emit(eBrake, "ResourcePaused");
      expect(yieldGroup.pauseResource).to.have.been.calledOnceWith(RESOURCE);
    });

    it("reverts on a zero YieldGroup or resource address", async () => {
      await expect(eBrake.pauseResource(ZERO_ADDRESS, RESOURCE)).to.be.revertedWithCustomError(eBrake, "ZeroAddress");
      await expect(eBrake.pauseResource(yieldGroup.address, ZERO_ADDRESS)).to.be.revertedWithCustomError(
        eBrake,
        "ZeroAddress",
      );
    });

    it("is ACM gated", async () => {
      accessControlManager.isAllowedToCall.returns(false);

      await expect(eBrake.pauseResource(yieldGroup.address, RESOURCE)).to.be.reverted;
      expect(yieldGroup.pauseResource).to.have.callCount(0);
    });

    it("is a silent no-op when the resource is already paused", async () => {
      yieldGroup.resourceConfig.returns([true, true, ZERO_ADDRESS]);

      await expect(eBrake.pauseResource(yieldGroup.address, RESOURCE)).to.not.emit(eBrake, "ResourcePaused");
      expect(yieldGroup.pauseResource).to.have.callCount(0);
    });

    // The YieldGroup's own ResourceNotRegistered check must still be reached: an unregistered
    // resource reads back paused == false, so the guard does not swallow it.
    it("still forwards an unregistered resource to the YieldGroup", async () => {
      yieldGroup.resourceConfig.returns([false, false, ZERO_ADDRESS]);

      await eBrake.pauseResource(yieldGroup.address, RESOURCE);
      expect(yieldGroup.pauseResource).to.have.been.calledOnceWith(RESOURCE);
    });
  });

  describe("tighten-only invariant", () => {
    it("adds no unpause for the Hub or a resource", async () => {
      const fns = Object.keys(eBrake.interface.functions);
      expect(fns.filter(f => f.toLowerCase().includes("unpause"))).to.deep.equal([]);
    });
  });
});
