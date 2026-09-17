import { FakeContract, smock } from "@defi-wonderland/smock";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import chai from "chai";
import { ethers, upgrades } from "hardhat";

import type { EBrake, IAccessControlManagerV8, ICorePoolComptroller, IHub } from "../../../typechain";

const { expect } = chai;
chai.use(smock.matchers);

const ZERO_ADDRESS = ethers.constants.AddressZero;

// Only the Liquidity Hub forwarders added on top of the existing EBrake surface.
describe("EBrake — Liquidity Hub forwarders", () => {
  let eBrake: EBrake;
  let accessControlManager: FakeContract<IAccessControlManagerV8>;
  let comptroller: FakeContract<ICorePoolComptroller>;
  let hub: FakeContract<IHub>;

  async function deployFixture() {
    accessControlManager = await smock.fake<IAccessControlManagerV8>("IAccessControlManagerV8");
    comptroller = await smock.fake<ICorePoolComptroller>("ICorePoolComptroller");
    hub = await smock.fake<IHub>("IHub");

    accessControlManager.isAllowedToCall.returns(true);

    const Factory = await ethers.getContractFactory("EBrake");
    eBrake = (await upgrades.deployProxy(Factory, [accessControlManager.address], {
      constructorArgs: [comptroller.address, false],
      unsafeAllow: ["constructor", "state-variable-immutable"],
    })) as EBrake;

    return { eBrake, accessControlManager, comptroller, hub };
  }

  beforeEach(async () => {
    ({ eBrake, accessControlManager, comptroller, hub } = await loadFixture(deployFixture));

    // loadFixture restores chain state, but smock fakes are JS-side and keep their stubs and call
    // history across tests.
    accessControlManager.isAllowedToCall.reset();
    accessControlManager.isAllowedToCall.returns(true);
    hub.pauseHub.reset();
    hub.hubPaused.reset();

    hub.hubPaused.returns(false);
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

    it("is a silent no-op when the Hub is already paused", async () => {
      hub.hubPaused.returns(true);

      await expect(eBrake.pauseHub(hub.address)).to.not.emit(eBrake, "HubPaused");
      expect(hub.pauseHub).to.have.callCount(0);
    });
  });

  describe("tighten-only invariant", () => {
    // Asserting the absence of something passes just as well when the thing it guards is gone, so
    // pin the pause side too: the Hub surface is pauseHub and nothing that reverses it.
    it("exposes pauseHub and no unpause for the Hub", async () => {
      const fns = Object.keys(eBrake.interface.functions);

      expect(fns).to.include("pauseHub(address)");
      expect(fns.filter(f => f.toLowerCase().includes("unpause"))).to.deep.equal([]);
      expect(fns.filter(f => f.toLowerCase().includes("hub"))).to.deep.equal(["pauseHub(address)"]);
    });
  });
});
