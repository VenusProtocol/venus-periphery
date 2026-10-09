import { FakeContract, smock } from "@defi-wonderland/smock";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import chai from "chai";
import { ContractTransaction } from "ethers";
import { ethers, upgrades } from "hardhat";

import type {
  BStockPauseHandler,
  IAccessControlManagerV8,
  IBStockToken,
  IEBrake,
  IPauseManager,
  IVToken,
} from "../../../typechain";

const { expect } = chai;
chai.use(smock.matchers);

describe("BStockPauseHandler", () => {
  let handler: BStockPauseHandler;
  let pauseManager: FakeContract<IPauseManager>;
  let accessControlManager: FakeContract<IAccessControlManagerV8>;
  let eBrake: FakeContract<IEBrake>;
  let vTSLAB: FakeContract<IVToken>;
  let vNVDAB: FakeContract<IVToken>;
  let vSPCXB: FakeContract<IVToken>;
  let tslab: FakeContract<IBStockToken>;
  let nvdab: FakeContract<IBStockToken>;
  let spcxb: FakeContract<IBStockToken>;
  let owner: SignerWithAddress;
  let user: SignerWithAddress;
  let keeper: SignerWithAddress;
  let otherKeeper: SignerWithAddress;

  // Underlying bStock token addresses, set from the fakes in the fixture
  let TSLAB: string;
  let NVDAB: string;
  let SPCXB: string;
  const ZERO_ADDRESS = ethers.constants.AddressZero;
  const SET_TRUSTED_KEEPER = "setTrustedKeeper(address,bool)";
  const SET_MARKET_MONITORED = "setMarketMonitored(address,bool)";

  /** Sets the pause state a fake PauseManager reports for a token. */
  const setPaused = (manager: FakeContract<IPauseManager>, token: string, paused: boolean) =>
    manager.isTokenPaused.whenCalledWith(token).returns(paused);

  /** EBrake.decreaseCF(address,uint256) fake. */
  const decreaseCF = () => eBrake["decreaseCF(address,uint256)"];

  /** Names of the events the handler emitted in a transaction, in order. */
  async function emittedEvents(tx: Promise<ContractTransaction>): Promise<string[]> {
    const receipt = await (await tx).wait();
    return receipt.logs.filter(log => log.address === handler.address).map(log => handler.interface.parseLog(log).name);
  }

  /**
   * Resets every fake's call history and behaviour: ACM allows everything, each vToken returns its underlying,
   * every token points at `pauseManager`, and no token is paused. Fakes live outside the EVM snapshot, so this
   * runs before every test.
   */
  function primeFakes() {
    accessControlManager.isAllowedToCall.reset();
    accessControlManager.isAllowedToCall.returns(true);
    decreaseCF().reset();
    for (const [vToken, token] of [
      [vTSLAB, TSLAB],
      [vNVDAB, NVDAB],
      [vSPCXB, SPCXB],
    ] as const) {
      vToken.underlying.reset();
      vToken.underlying.returns(token);
    }
    for (const token of [tslab, nvdab, spcxb]) {
      token.pauseManager.reset();
      token.pauseManager.returns(pauseManager.address);
    }
    pauseManager.isTokenPaused.reset();
    pauseManager.isTokenPaused.returns(false);
  }

  /**
   * Deploys the BStockPauseHandler behind an upgradeable proxy, wired to fake ACM, EBrake and vTokens,
   * fake bStock tokens exposing pauseManager(), and a fake PauseManager.
   */
  async function deployFixture() {
    [owner, user, keeper, otherKeeper] = await ethers.getSigners();

    accessControlManager = await smock.fake<IAccessControlManagerV8>("IAccessControlManagerV8");
    eBrake = await smock.fake<IEBrake>("IEBrake");
    vTSLAB = await smock.fake<IVToken>("contracts/Interfaces/IVToken.sol:IVToken");
    vNVDAB = await smock.fake<IVToken>("contracts/Interfaces/IVToken.sol:IVToken");
    vSPCXB = await smock.fake<IVToken>("contracts/Interfaces/IVToken.sol:IVToken");
    tslab = await smock.fake<IBStockToken>("IBStockToken");
    nvdab = await smock.fake<IBStockToken>("IBStockToken");
    spcxb = await smock.fake<IBStockToken>("IBStockToken");
    pauseManager = await smock.fake<IPauseManager>("contracts/Interfaces/IPauseManager.sol:IPauseManager");

    const Factory = await ethers.getContractFactory("BStockPauseHandler");
    handler = (await upgrades.deployProxy(Factory, [accessControlManager.address], {
      constructorArgs: [eBrake.address],
      unsafeAllow: ["constructor", "internal-function-storage"],
    })) as BStockPauseHandler;

    return {
      handler,
      pauseManager,
      accessControlManager,
      eBrake,
      vTSLAB,
      vNVDAB,
      vSPCXB,
      tslab,
      nvdab,
      spcxb,
      owner,
      user,
      keeper,
      otherKeeper,
    };
  }

  beforeEach(async () => {
    ({
      handler,
      pauseManager,
      accessControlManager,
      eBrake,
      vTSLAB,
      vNVDAB,
      vSPCXB,
      tslab,
      nvdab,
      spcxb,
      owner,
      user,
      keeper,
      otherKeeper,
    } = await loadFixture(deployFixture));
    TSLAB = tslab.address;
    NVDAB = nvdab.address;
    SPCXB = spcxb.address;
    primeFakes();
  });

  // ═══════════════════════════════════════════════════════════════════
  // 1. Initialization
  // ═══════════════════════════════════════════════════════════════════

  describe("Initialization", () => {
    it("should store the EBrake address", async () => {
      expect(await handler.EBRAKE()).to.equal(eBrake.address);
    });

    it("should set the access control manager and owner", async () => {
      expect(await handler.accessControlManager()).to.equal(accessControlManager.address);
      expect(await handler.owner()).to.equal(owner.address);
      expect(await handler.pendingOwner()).to.equal(ZERO_ADDRESS);
    });

    it("should start with no trusted keepers and no monitored markets", async () => {
      expect(await handler.trustedKeepers(keeper.address)).to.equal(false);
      expect(await handler.isMarketMonitored(vTSLAB.address)).to.equal(false);
    });

    it("should revert with ZeroAddress when eBrake_ is the zero address", async () => {
      const Factory = await ethers.getContractFactory("BStockPauseHandler");
      await expect(Factory.deploy(ZERO_ADDRESS)).to.be.revertedWithCustomError(handler, "ZeroAddress");
    });

    it("should reject re-initialization (initializer guard)", async () => {
      await expect(handler.initialize(accessControlManager.address)).to.be.revertedWith(
        "Initializable: contract is already initialized",
      );
    });

    it("should disable initializers on the implementation", async () => {
      const Factory = await ethers.getContractFactory("BStockPauseHandler");
      const implementation = await Factory.deploy(eBrake.address);
      await expect(implementation.initialize(accessControlManager.address)).to.be.revertedWith(
        "Initializable: contract is already initialized",
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 2. setTrustedKeeper
  // ═══════════════════════════════════════════════════════════════════

  describe("setTrustedKeeper", () => {
    it("should check the ACM exactly once with the caller and the function signature", async () => {
      await handler.connect(user).setTrustedKeeper(keeper.address, true);
      expect(accessControlManager.isAllowedToCall).to.have.been.calledOnceWith(user.address, SET_TRUSTED_KEEPER);
    });

    it("should revert with Unauthorized without ACM permission and leave the keeper untrusted", async () => {
      accessControlManager.isAllowedToCall.returns(false);
      await expect(handler.connect(user).setTrustedKeeper(keeper.address, true))
        .to.be.revertedWithCustomError(handler, "Unauthorized")
        .withArgs(user.address, handler.address, SET_TRUSTED_KEEPER);
      expect(await handler.trustedKeepers(keeper.address)).to.equal(false);
    });

    it("should revert with ZeroAddress when keeper is address(0)", async () => {
      await expect(handler.setTrustedKeeper(ZERO_ADDRESS, true)).to.be.revertedWithCustomError(handler, "ZeroAddress");
      expect(await handler.trustedKeepers(ZERO_ADDRESS)).to.equal(false);
    });

    it("should trust a keeper and emit exactly one TrustedKeeperUpdated(keeper, true)", async () => {
      const tx = handler.setTrustedKeeper(keeper.address, true);
      await expect(tx).to.emit(handler, "TrustedKeeperUpdated").withArgs(keeper.address, true);
      expect(await emittedEvents(tx)).to.deep.equal(["TrustedKeeperUpdated"]);
      expect(await handler.trustedKeepers(keeper.address)).to.equal(true);
    });

    it("should untrust a keeper and emit TrustedKeeperUpdated(keeper, false)", async () => {
      await handler.setTrustedKeeper(keeper.address, true);
      await expect(handler.setTrustedKeeper(keeper.address, false))
        .to.emit(handler, "TrustedKeeperUpdated")
        .withArgs(keeper.address, false);
      expect(await handler.trustedKeepers(keeper.address)).to.equal(false);
    });

    it("should accept setting the current status again (no redundancy check)", async () => {
      await handler.setTrustedKeeper(keeper.address, true);
      await expect(handler.setTrustedKeeper(keeper.address, true))
        .to.emit(handler, "TrustedKeeperUpdated")
        .withArgs(keeper.address, true);
      expect(await handler.trustedKeepers(keeper.address)).to.equal(true);
    });

    it("should only change the given keeper", async () => {
      await handler.setTrustedKeeper(keeper.address, true);
      expect(await handler.trustedKeepers(otherKeeper.address)).to.equal(false);

      await handler.setTrustedKeeper(otherKeeper.address, true);
      await handler.setTrustedKeeper(keeper.address, false);
      expect(await handler.trustedKeepers(keeper.address)).to.equal(false);
      expect(await handler.trustedKeepers(otherKeeper.address)).to.equal(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 3. setMarketMonitored
  // ═══════════════════════════════════════════════════════════════════

  describe("setMarketMonitored", () => {
    describe("access control", () => {
      it("should check the ACM exactly once with the caller and the function signature", async () => {
        await handler.connect(user).setMarketMonitored(vTSLAB.address, true);
        expect(accessControlManager.isAllowedToCall).to.have.been.calledOnceWith(user.address, SET_MARKET_MONITORED);
      });

      it("should revert with Unauthorized when adding without ACM permission", async () => {
        accessControlManager.isAllowedToCall.returns(false);
        await expect(handler.connect(user).setMarketMonitored(vTSLAB.address, true))
          .to.be.revertedWithCustomError(handler, "Unauthorized")
          .withArgs(user.address, handler.address, SET_MARKET_MONITORED);
        expect(await handler.isMarketMonitored(vTSLAB.address)).to.equal(false);
        expect(vTSLAB.underlying).to.not.have.been.called;
      });

      it("should revert with Unauthorized when removing without ACM permission", async () => {
        await handler.setMarketMonitored(vTSLAB.address, true);
        accessControlManager.isAllowedToCall.returns(false);
        await expect(handler.connect(user).setMarketMonitored(vTSLAB.address, false))
          .to.be.revertedWithCustomError(handler, "Unauthorized")
          .withArgs(user.address, handler.address, SET_MARKET_MONITORED);
        expect(await handler.isMarketMonitored(vTSLAB.address)).to.equal(true);
      });
    });

    describe("adding", () => {
      it("should monitor the market and emit exactly one MarketMonitoringUpdated(market, true)", async () => {
        const tx = handler.setMarketMonitored(vTSLAB.address, true);
        await expect(tx).to.emit(handler, "MarketMonitoringUpdated").withArgs(vTSLAB.address, true);
        expect(await emittedEvents(tx)).to.deep.equal(["MarketMonitoringUpdated"]);
        expect(await handler.isMarketMonitored(vTSLAB.address)).to.equal(true);
        expect(await handler.isMarketMonitored(vNVDAB.address)).to.equal(false);
      });

      it("should read the market's underlying and the token's PauseManager exactly once", async () => {
        await handler.setMarketMonitored(vTSLAB.address, true);
        expect(vTSLAB.underlying).to.have.been.calledOnce;
        expect(tslab.pauseManager).to.have.been.calledOnce;
        expect(nvdab.pauseManager).to.not.have.been.called;
      });

      it("should not query the PauseManager itself", async () => {
        await handler.setMarketMonitored(vTSLAB.address, true);
        expect(pauseManager.isTokenPaused).to.not.have.been.called;
      });

      it("should revert with ZeroAddress when market is address(0)", async () => {
        await expect(handler.setMarketMonitored(ZERO_ADDRESS, true)).to.be.revertedWithCustomError(
          handler,
          "ZeroAddress",
        );
        expect(await handler.isMarketMonitored(ZERO_ADDRESS)).to.equal(false);
      });

      it("should revert with MarketNotSupported when the market's underlying is address(0)", async () => {
        vTSLAB.underlying.returns(ZERO_ADDRESS);
        await expect(handler.setMarketMonitored(vTSLAB.address, true))
          .to.be.revertedWithCustomError(handler, "MarketNotSupported")
          .withArgs(vTSLAB.address);
        expect(await handler.isMarketMonitored(vTSLAB.address)).to.equal(false);
      });

      it("should revert with MarketNotSupported when the token's PauseManager is address(0)", async () => {
        tslab.pauseManager.returns(ZERO_ADDRESS);
        await expect(handler.setMarketMonitored(vTSLAB.address, true))
          .to.be.revertedWithCustomError(handler, "MarketNotSupported")
          .withArgs(vTSLAB.address);
        expect(await handler.isMarketMonitored(vTSLAB.address)).to.equal(false);
      });

      it("should bubble up a revert from the token's pauseManager()", async () => {
        tslab.pauseManager.reverts("pauseManager failure");
        await expect(handler.setMarketMonitored(vTSLAB.address, true)).to.be.revertedWith("pauseManager failure");
        expect(await handler.isMarketMonitored(vTSLAB.address)).to.equal(false);
      });

      it("should revert without a reason when the underlying has no code", async () => {
        vTSLAB.underlying.returns(user.address);
        await expect(handler.setMarketMonitored(vTSLAB.address, true)).to.be.revertedWithoutReason();
        expect(await handler.isMarketMonitored(vTSLAB.address)).to.equal(false);
      });

      it("should revert without a reason when the market has no underlying() (e.g. an EOA)", async () => {
        await expect(handler.setMarketMonitored(user.address, true)).to.be.revertedWithoutReason();
        expect(await handler.isMarketMonitored(user.address)).to.equal(false);
      });

      it("should revert with MarketMonitoringUnchanged when the market is already monitored", async () => {
        await handler.setMarketMonitored(vTSLAB.address, true);
        await expect(handler.setMarketMonitored(vTSLAB.address, true))
          .to.be.revertedWithCustomError(handler, "MarketMonitoringUnchanged")
          .withArgs(vTSLAB.address, true);
        expect(await handler.isMarketMonitored(vTSLAB.address)).to.equal(true);
      });
    });

    describe("removing", () => {
      beforeEach(async () => {
        await handler.setMarketMonitored(vTSLAB.address, true);
        await handler.setMarketMonitored(vNVDAB.address, true);
        primeFakes();
      });

      it("should stop monitoring the market and emit exactly one MarketMonitoringUpdated(market, false)", async () => {
        const tx = handler.setMarketMonitored(vTSLAB.address, false);
        await expect(tx).to.emit(handler, "MarketMonitoringUpdated").withArgs(vTSLAB.address, false);
        expect(await emittedEvents(tx)).to.deep.equal(["MarketMonitoringUpdated"]);
        expect(await handler.isMarketMonitored(vTSLAB.address)).to.equal(false);
        expect(await handler.isMarketMonitored(vNVDAB.address)).to.equal(true);
      });

      it("should not read the underlying or the token when removing", async () => {
        vTSLAB.underlying.reverts();
        tslab.pauseManager.reverts();
        await handler.setMarketMonitored(vTSLAB.address, false);
        expect(vTSLAB.underlying).to.not.have.been.called;
        expect(tslab.pauseManager).to.not.have.been.called;
        expect(await handler.isMarketMonitored(vTSLAB.address)).to.equal(false);
      });

      it("should allow adding the market back", async () => {
        await handler.setMarketMonitored(vTSLAB.address, false);
        await expect(handler.setMarketMonitored(vTSLAB.address, true))
          .to.emit(handler, "MarketMonitoringUpdated")
          .withArgs(vTSLAB.address, true);
        expect(await handler.isMarketMonitored(vTSLAB.address)).to.equal(true);
      });

      it("should revert with MarketMonitoringUnchanged when the market is not monitored", async () => {
        await expect(handler.setMarketMonitored(vSPCXB.address, false))
          .to.be.revertedWithCustomError(handler, "MarketMonitoringUnchanged")
          .withArgs(vSPCXB.address, false);
      });

      it("should revert with ZeroAddress when market is address(0)", async () => {
        await expect(handler.setMarketMonitored(ZERO_ADDRESS, false)).to.be.revertedWithCustomError(
          handler,
          "ZeroAddress",
        );
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 4. handlePause
  // ═══════════════════════════════════════════════════════════════════

  describe("handlePause", () => {
    beforeEach(async () => {
      await handler.setTrustedKeeper(keeper.address, true);
      await handler.setMarketMonitored(vTSLAB.address, true);
      await handler.setMarketMonitored(vNVDAB.address, true);
      // Drop the calls made by the setup above so call assertions only see handlePause
      primeFakes();
    });

    describe("access", () => {
      it("should revert with UnauthorizedKeeper for a caller that is not a trusted keeper", async () => {
        setPaused(pauseManager, TSLAB, true);
        await expect(handler.connect(user).handlePause(vTSLAB.address)).to.be.revertedWithCustomError(
          handler,
          "UnauthorizedKeeper",
        );
        expect(vTSLAB.underlying).to.not.have.been.called;
        expect(decreaseCF()).to.not.have.been.called;
      });

      it("should check the keeper before the market (UnauthorizedKeeper on an unmonitored market)", async () => {
        await expect(handler.connect(user).handlePause(vSPCXB.address)).to.be.revertedWithCustomError(
          handler,
          "UnauthorizedKeeper",
        );
      });

      it("should revert with UnauthorizedKeeper after the keeper is untrusted", async () => {
        setPaused(pauseManager, TSLAB, true);
        await handler.setTrustedKeeper(keeper.address, false);
        await expect(handler.connect(keeper).handlePause(vTSLAB.address)).to.be.revertedWithCustomError(
          handler,
          "UnauthorizedKeeper",
        );
        expect(decreaseCF()).to.not.have.been.called;
      });

      it("should accept any trusted keeper", async () => {
        setPaused(pauseManager, TSLAB, true);
        await handler.setTrustedKeeper(otherKeeper.address, true);
        await expect(handler.connect(otherKeeper).handlePause(vTSLAB.address))
          .to.emit(handler, "PauseBrakeApplied")
          .withArgs(vTSLAB.address, TSLAB, otherKeeper.address, pauseManager.address);
      });

      it("should gate on trusted keepers only, without an ACM check", async () => {
        setPaused(pauseManager, TSLAB, true);
        accessControlManager.isAllowedToCall.returns(false);
        await expect(handler.connect(keeper).handlePause(vTSLAB.address)).to.emit(handler, "PauseBrakeApplied");
        expect(accessControlManager.isAllowedToCall).to.not.have.been.called;
      });
    });

    describe("market and pause checks", () => {
      it("should revert with MarketNotMonitored for a market that is not monitored", async () => {
        setPaused(pauseManager, SPCXB, true);
        await expect(handler.connect(keeper).handlePause(vSPCXB.address))
          .to.be.revertedWithCustomError(handler, "MarketNotMonitored")
          .withArgs(vSPCXB.address);
        expect(vSPCXB.underlying).to.not.have.been.called;
        expect(decreaseCF()).to.not.have.been.called;
      });

      it("should revert with MarketNotMonitored after the market is removed, even while paused", async () => {
        setPaused(pauseManager, TSLAB, true);
        await handler.setMarketMonitored(vTSLAB.address, false);
        await expect(handler.connect(keeper).handlePause(vTSLAB.address))
          .to.be.revertedWithCustomError(handler, "MarketNotMonitored")
          .withArgs(vTSLAB.address);
        expect(decreaseCF()).to.not.have.been.called;
      });

      it("should revert with TokenNotPaused when the underlying is not paused", async () => {
        await expect(handler.connect(keeper).handlePause(vTSLAB.address))
          .to.be.revertedWithCustomError(handler, "TokenNotPaused")
          .withArgs(vTSLAB.address, TSLAB);
        expect(pauseManager.isTokenPaused).to.have.been.calledOnceWith(TSLAB);
        expect(decreaseCF()).to.not.have.been.called;
      });

      it("should revert with TokenNotPaused when only a different token is paused", async () => {
        setPaused(pauseManager, NVDAB, true);
        await expect(handler.connect(keeper).handlePause(vTSLAB.address))
          .to.be.revertedWithCustomError(handler, "TokenNotPaused")
          .withArgs(vTSLAB.address, TSLAB);
        expect(decreaseCF()).to.not.have.been.called;
      });

      it("should revert with TokenNotPaused again after the token is unpaused", async () => {
        setPaused(pauseManager, TSLAB, true);
        await handler.connect(keeper).handlePause(vTSLAB.address);

        setPaused(pauseManager, TSLAB, false);
        await expect(handler.connect(keeper).handlePause(vTSLAB.address))
          .to.be.revertedWithCustomError(handler, "TokenNotPaused")
          .withArgs(vTSLAB.address, TSLAB);
        expect(decreaseCF()).to.have.been.calledOnce;
      });
    });

    describe("failing dependencies", () => {
      beforeEach(async () => {
        setPaused(pauseManager, TSLAB, true);
      });

      it("should bubble up a revert from the market's underlying()", async () => {
        vTSLAB.underlying.reverts("underlying failure");
        await expect(handler.connect(keeper).handlePause(vTSLAB.address)).to.be.revertedWith("underlying failure");
        expect(decreaseCF()).to.not.have.been.called;
      });

      it("should bubble up a revert from the token's pauseManager()", async () => {
        tslab.pauseManager.reverts("pauseManager failure");
        await expect(handler.connect(keeper).handlePause(vTSLAB.address)).to.be.revertedWith("pauseManager failure");
        expect(decreaseCF()).to.not.have.been.called;
      });

      it("should revert without a reason when the token's PauseManager is now address(0)", async () => {
        tslab.pauseManager.returns(ZERO_ADDRESS);
        await expect(handler.connect(keeper).handlePause(vTSLAB.address)).to.be.revertedWithoutReason();
        expect(decreaseCF()).to.not.have.been.called;
      });

      it("should bubble up a revert from the PauseManager", async () => {
        pauseManager.isTokenPaused.whenCalledWith(TSLAB).reverts("PauseManager failure");
        await expect(handler.connect(keeper).handlePause(vTSLAB.address)).to.be.revertedWith("PauseManager failure");
        expect(decreaseCF()).to.not.have.been.called;
      });

      it("should bubble up a revert from EBrake", async () => {
        decreaseCF().reverts("EBrake failure");
        await expect(handler.connect(keeper).handlePause(vTSLAB.address)).to.be.revertedWith("EBrake failure");
      });
    });

    describe("token paused", () => {
      beforeEach(async () => {
        setPaused(pauseManager, TSLAB, true);
      });

      it("should call EBrake.decreaseCF(market, 0) exactly once", async () => {
        await handler.connect(keeper).handlePause(vTSLAB.address);
        expect(decreaseCF()).to.have.been.calledOnceWith(vTSLAB.address, 0);
      });

      it("should read the underlying, its PauseManager and the pause state exactly once", async () => {
        await handler.connect(keeper).handlePause(vTSLAB.address);
        expect(vTSLAB.underlying).to.have.been.calledOnce;
        expect(tslab.pauseManager).to.have.been.calledOnce;
        expect(pauseManager.isTokenPaused).to.have.been.calledOnceWith(TSLAB);
      });

      it("should emit exactly one PauseBrakeApplied(market, underlying, caller, pauseManager)", async () => {
        const tx = handler.connect(keeper).handlePause(vTSLAB.address);
        await expect(tx)
          .to.emit(handler, "PauseBrakeApplied")
          .withArgs(vTSLAB.address, TSLAB, keeper.address, pauseManager.address);
        expect(await emittedEvents(tx)).to.deep.equal(["PauseBrakeApplied"]);
      });

      it("should not change any handler state", async () => {
        await handler.connect(keeper).handlePause(vTSLAB.address);
        expect(await handler.isMarketMonitored(vTSLAB.address)).to.equal(true);
        expect(await handler.trustedKeepers(keeper.address)).to.equal(true);
      });

      it("should not act on other monitored markets", async () => {
        await handler.connect(keeper).handlePause(vTSLAB.address);
        expect(decreaseCF()).to.not.have.been.calledWith(vNVDAB.address, 0);
        await expect(handler.connect(keeper).handlePause(vNVDAB.address))
          .to.be.revertedWithCustomError(handler, "TokenNotPaused")
          .withArgs(vNVDAB.address, NVDAB);
      });

      it("should forward every repeat call to EBrake (EBrake makes them no-ops)", async () => {
        await handler.connect(keeper).handlePause(vTSLAB.address);
        await handler.connect(keeper).handlePause(vTSLAB.address);
        expect(decreaseCF()).to.have.been.calledTwice;
        expect(decreaseCF().getCall(0).args).to.deep.equal([vTSLAB.address, ethers.constants.Zero]);
        expect(decreaseCF().getCall(1).args).to.deep.equal([vTSLAB.address, ethers.constants.Zero]);
      });
    });

    describe("several tokens paused", () => {
      it("should zero CF for every paused monitored market", async () => {
        setPaused(pauseManager, TSLAB, true);
        setPaused(pauseManager, NVDAB, true);

        await expect(handler.connect(keeper).handlePause(vTSLAB.address))
          .to.emit(handler, "PauseBrakeApplied")
          .withArgs(vTSLAB.address, TSLAB, keeper.address, pauseManager.address);
        await expect(handler.connect(keeper).handlePause(vNVDAB.address))
          .to.emit(handler, "PauseBrakeApplied")
          .withArgs(vNVDAB.address, NVDAB, keeper.address, pauseManager.address);

        expect(decreaseCF()).to.have.been.calledTwice;
        expect(decreaseCF().getCall(0).args).to.deep.equal([vTSLAB.address, ethers.constants.Zero]);
        expect(decreaseCF().getCall(1).args).to.deep.equal([vNVDAB.address, ethers.constants.Zero]);
      });

      it("should still revert for a paused market that is not monitored", async () => {
        setPaused(pauseManager, SPCXB, true);
        await expect(handler.connect(keeper).handlePause(vSPCXB.address))
          .to.be.revertedWithCustomError(handler, "MarketNotMonitored")
          .withArgs(vSPCXB.address);
        expect(decreaseCF()).to.not.have.been.called;
      });
    });

    describe("token repointed to another PauseManager", () => {
      let otherPauseManager: FakeContract<IPauseManager>;

      beforeEach(async () => {
        otherPauseManager = await smock.fake<IPauseManager>("contracts/Interfaces/IPauseManager.sol:IPauseManager");
        otherPauseManager.isTokenPaused.returns(false);
        tslab.pauseManager.returns(otherPauseManager.address);
      });

      it("should zero CF when the token's new PauseManager pauses it", async () => {
        setPaused(otherPauseManager, TSLAB, true);
        await expect(handler.connect(keeper).handlePause(vTSLAB.address))
          .to.emit(handler, "PauseBrakeApplied")
          .withArgs(vTSLAB.address, TSLAB, keeper.address, otherPauseManager.address);
        expect(otherPauseManager.isTokenPaused).to.have.been.calledOnceWith(TSLAB);
        expect(pauseManager.isTokenPaused).to.not.have.been.called;
        expect(decreaseCF()).to.have.been.calledOnceWith(vTSLAB.address, 0);
      });

      it("should ignore a pause on the old PauseManager the token no longer checks", async () => {
        setPaused(pauseManager, TSLAB, true);
        await expect(handler.connect(keeper).handlePause(vTSLAB.address))
          .to.be.revertedWithCustomError(handler, "TokenNotPaused")
          .withArgs(vTSLAB.address, TSLAB);
        expect(pauseManager.isTokenPaused).to.not.have.been.called;
        expect(decreaseCF()).to.not.have.been.called;
      });

      it("should keep using the original PauseManager for the other tokens", async () => {
        setPaused(pauseManager, NVDAB, true);
        await expect(handler.connect(keeper).handlePause(vNVDAB.address))
          .to.emit(handler, "PauseBrakeApplied")
          .withArgs(vNVDAB.address, NVDAB, keeper.address, pauseManager.address);
        expect(otherPauseManager.isTokenPaused).to.not.have.been.called;
      });
    });
  });
});
