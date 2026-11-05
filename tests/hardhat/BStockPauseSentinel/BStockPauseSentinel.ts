import { FakeContract, smock } from "@defi-wonderland/smock";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import chai from "chai";
import { ContractTransaction } from "ethers";
import { ethers, upgrades } from "hardhat";

import type {
  BStockPauseSentinel,
  IAccessControlManagerV8,
  IBStockToken,
  ICompliance,
  IEBrake,
  IPauseManager,
  IVToken,
} from "../../../typechain";

const { expect } = chai;
chai.use(smock.matchers);

describe("BStockPauseSentinel", () => {
  let sentinel: BStockPauseSentinel;
  let pauseManager: FakeContract<IPauseManager>;
  let compliance: FakeContract<ICompliance>;
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

  /** Names of the events the sentinel emitted in a transaction, in order. */
  async function emittedEvents(tx: Promise<ContractTransaction>): Promise<string[]> {
    const receipt = await (await tx).wait();
    return receipt.logs
      .filter(log => log.address === sentinel.address)
      .map(log => sentinel.interface.parseLog(log).name);
  }

  /**
   * Resets every fake's call history and behaviour: ACM allows everything, each vToken returns its underlying,
   * every token points at `pauseManager` and `compliance`, no token is paused and the compliance module accepts
   * every account. Fakes live outside the EVM snapshot, so this runs before every test.
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
      vToken.comptroller.reset();
    }
    for (const token of [tslab, nvdab, spcxb]) {
      token.pauseManager.reset();
      token.pauseManager.returns(pauseManager.address);
      token.compliance.reset();
      token.compliance.returns(compliance.address);
    }
    pauseManager.isTokenPaused.reset();
    pauseManager.isTokenPaused.returns(false);
    compliance.checkIsCompliant.reset();
  }

  /**
   * Deploys the BStockPauseSentinel behind an upgradeable proxy, wired to fake ACM, EBrake and vTokens, fake
   * bStock tokens exposing pauseManager() and compliance(), a fake PauseManager and a fake compliance module.
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
    compliance = await smock.fake<ICompliance>("ICompliance");

    const Factory = await ethers.getContractFactory("BStockPauseSentinel");
    sentinel = (await upgrades.deployProxy(Factory, [accessControlManager.address], {
      constructorArgs: [eBrake.address],
      unsafeAllow: ["constructor", "internal-function-storage"],
    })) as BStockPauseSentinel;

    return {
      sentinel,
      pauseManager,
      compliance,
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
      sentinel,
      pauseManager,
      compliance,
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
      expect(await sentinel.EBRAKE()).to.equal(eBrake.address);
    });

    it("should set the access control manager and owner", async () => {
      expect(await sentinel.accessControlManager()).to.equal(accessControlManager.address);
      expect(await sentinel.owner()).to.equal(owner.address);
      expect(await sentinel.pendingOwner()).to.equal(ZERO_ADDRESS);
    });

    it("should start with no trusted keepers and no monitored markets", async () => {
      expect(await sentinel.trustedKeepers(keeper.address)).to.equal(false);
      expect(await sentinel.isMarketMonitored(vTSLAB.address)).to.equal(false);
      expect(await sentinel.getMonitoredMarkets()).to.deep.equal([]);
    });

    it("should revert with ZeroAddress when eBrake_ is the zero address", async () => {
      const Factory = await ethers.getContractFactory("BStockPauseSentinel");
      await expect(Factory.deploy(ZERO_ADDRESS)).to.be.revertedWithCustomError(sentinel, "ZeroAddress");
    });

    it("should reject re-initialization (initializer guard)", async () => {
      await expect(sentinel.initialize(accessControlManager.address)).to.be.revertedWith(
        "Initializable: contract is already initialized",
      );
    });

    it("should disable initializers on the implementation", async () => {
      const Factory = await ethers.getContractFactory("BStockPauseSentinel");
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
      await sentinel.connect(user).setTrustedKeeper(keeper.address, true);
      expect(accessControlManager.isAllowedToCall).to.have.been.calledOnceWith(user.address, SET_TRUSTED_KEEPER);
    });

    it("should revert with Unauthorized without ACM permission and leave the keeper untrusted", async () => {
      accessControlManager.isAllowedToCall.returns(false);
      await expect(sentinel.connect(user).setTrustedKeeper(keeper.address, true))
        .to.be.revertedWithCustomError(sentinel, "Unauthorized")
        .withArgs(user.address, sentinel.address, SET_TRUSTED_KEEPER);
      expect(await sentinel.trustedKeepers(keeper.address)).to.equal(false);
    });

    it("should revert with ZeroAddress when keeper is address(0)", async () => {
      await expect(sentinel.setTrustedKeeper(ZERO_ADDRESS, true)).to.be.revertedWithCustomError(
        sentinel,
        "ZeroAddress",
      );
      expect(await sentinel.trustedKeepers(ZERO_ADDRESS)).to.equal(false);
    });

    it("should trust a keeper and emit exactly one TrustedKeeperUpdated(keeper, true)", async () => {
      const tx = sentinel.setTrustedKeeper(keeper.address, true);
      await expect(tx).to.emit(sentinel, "TrustedKeeperUpdated").withArgs(keeper.address, true);
      expect(await emittedEvents(tx)).to.deep.equal(["TrustedKeeperUpdated"]);
      expect(await sentinel.trustedKeepers(keeper.address)).to.equal(true);
    });

    it("should untrust a keeper and emit TrustedKeeperUpdated(keeper, false)", async () => {
      await sentinel.setTrustedKeeper(keeper.address, true);
      await expect(sentinel.setTrustedKeeper(keeper.address, false))
        .to.emit(sentinel, "TrustedKeeperUpdated")
        .withArgs(keeper.address, false);
      expect(await sentinel.trustedKeepers(keeper.address)).to.equal(false);
    });

    it("should accept setting the current status again (no redundancy check)", async () => {
      await sentinel.setTrustedKeeper(keeper.address, true);
      await expect(sentinel.setTrustedKeeper(keeper.address, true))
        .to.emit(sentinel, "TrustedKeeperUpdated")
        .withArgs(keeper.address, true);
      expect(await sentinel.trustedKeepers(keeper.address)).to.equal(true);
    });

    it("should only change the given keeper", async () => {
      await sentinel.setTrustedKeeper(keeper.address, true);
      expect(await sentinel.trustedKeepers(otherKeeper.address)).to.equal(false);

      await sentinel.setTrustedKeeper(otherKeeper.address, true);
      await sentinel.setTrustedKeeper(keeper.address, false);
      expect(await sentinel.trustedKeepers(keeper.address)).to.equal(false);
      expect(await sentinel.trustedKeepers(otherKeeper.address)).to.equal(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 3. setMarketMonitored
  // ═══════════════════════════════════════════════════════════════════

  describe("setMarketMonitored", () => {
    describe("access control", () => {
      it("should check the ACM exactly once with the caller and the function signature", async () => {
        await sentinel.connect(user).setMarketMonitored(vTSLAB.address, true);
        expect(accessControlManager.isAllowedToCall).to.have.been.calledOnceWith(user.address, SET_MARKET_MONITORED);
      });

      it("should revert with Unauthorized when adding without ACM permission", async () => {
        accessControlManager.isAllowedToCall.returns(false);
        await expect(sentinel.connect(user).setMarketMonitored(vTSLAB.address, true))
          .to.be.revertedWithCustomError(sentinel, "Unauthorized")
          .withArgs(user.address, sentinel.address, SET_MARKET_MONITORED);
        expect(await sentinel.isMarketMonitored(vTSLAB.address)).to.equal(false);
        expect(vTSLAB.underlying).to.not.have.been.called;
      });

      it("should revert with Unauthorized when removing without ACM permission", async () => {
        await sentinel.setMarketMonitored(vTSLAB.address, true);
        accessControlManager.isAllowedToCall.returns(false);
        await expect(sentinel.connect(user).setMarketMonitored(vTSLAB.address, false))
          .to.be.revertedWithCustomError(sentinel, "Unauthorized")
          .withArgs(user.address, sentinel.address, SET_MARKET_MONITORED);
        expect(await sentinel.isMarketMonitored(vTSLAB.address)).to.equal(true);
      });
    });

    describe("adding", () => {
      it("should monitor the market and emit exactly one MarketMonitoringUpdated(market, true)", async () => {
        const tx = sentinel.setMarketMonitored(vTSLAB.address, true);
        await expect(tx).to.emit(sentinel, "MarketMonitoringUpdated").withArgs(vTSLAB.address, true);
        expect(await emittedEvents(tx)).to.deep.equal(["MarketMonitoringUpdated"]);
        expect(await sentinel.isMarketMonitored(vTSLAB.address)).to.equal(true);
        expect(await sentinel.isMarketMonitored(vNVDAB.address)).to.equal(false);
        expect(await sentinel.getMonitoredMarkets()).to.deep.equal([vTSLAB.address]);
      });

      it("should not read the market, its underlying or its PauseManager", async () => {
        vTSLAB.comptroller.reverts();
        await sentinel.setMarketMonitored(vTSLAB.address, true);
        expect(vTSLAB.comptroller).to.not.have.been.called;
        expect(vTSLAB.underlying).to.not.have.been.called;
        expect(tslab.pauseManager).to.not.have.been.called;
        expect(pauseManager.isTokenPaused).to.not.have.been.called;
      });

      it("should revert with ZeroAddress when market is address(0)", async () => {
        await expect(sentinel.setMarketMonitored(ZERO_ADDRESS, true)).to.be.revertedWithCustomError(
          sentinel,
          "ZeroAddress",
        );
        expect(await sentinel.isMarketMonitored(ZERO_ADDRESS)).to.equal(false);
      });

      it("should accept adding a market that is already monitored and emit again", async () => {
        await sentinel.setMarketMonitored(vTSLAB.address, true);
        await expect(sentinel.setMarketMonitored(vTSLAB.address, true))
          .to.emit(sentinel, "MarketMonitoringUpdated")
          .withArgs(vTSLAB.address, true);
        expect(await sentinel.isMarketMonitored(vTSLAB.address)).to.equal(true);
        expect(await sentinel.getMonitoredMarkets()).to.deep.equal([vTSLAB.address]);
      });
    });

    describe("removing", () => {
      beforeEach(async () => {
        await sentinel.setMarketMonitored(vTSLAB.address, true);
        await sentinel.setMarketMonitored(vNVDAB.address, true);
        primeFakes();
      });

      it("should stop monitoring the market and emit exactly one MarketMonitoringUpdated(market, false)", async () => {
        const tx = sentinel.setMarketMonitored(vTSLAB.address, false);
        await expect(tx).to.emit(sentinel, "MarketMonitoringUpdated").withArgs(vTSLAB.address, false);
        expect(await emittedEvents(tx)).to.deep.equal(["MarketMonitoringUpdated"]);
        expect(await sentinel.isMarketMonitored(vTSLAB.address)).to.equal(false);
        expect(await sentinel.isMarketMonitored(vNVDAB.address)).to.equal(true);
        expect(await sentinel.getMonitoredMarkets()).to.deep.equal([vNVDAB.address]);
      });

      it("should not read the underlying, the token or the comptroller when removing", async () => {
        vTSLAB.underlying.reverts();
        vTSLAB.comptroller.reverts();
        tslab.pauseManager.reverts();
        await sentinel.setMarketMonitored(vTSLAB.address, false);
        expect(vTSLAB.underlying).to.not.have.been.called;
        expect(vTSLAB.comptroller).to.not.have.been.called;
        expect(tslab.pauseManager).to.not.have.been.called;
        expect(await sentinel.isMarketMonitored(vTSLAB.address)).to.equal(false);
      });

      it("should allow adding the market back", async () => {
        await sentinel.setMarketMonitored(vTSLAB.address, false);
        await expect(sentinel.setMarketMonitored(vTSLAB.address, true))
          .to.emit(sentinel, "MarketMonitoringUpdated")
          .withArgs(vTSLAB.address, true);
        expect(await sentinel.isMarketMonitored(vTSLAB.address)).to.equal(true);
      });

      it("should accept removing a market that is not monitored and emit", async () => {
        await expect(sentinel.setMarketMonitored(vSPCXB.address, false))
          .to.emit(sentinel, "MarketMonitoringUpdated")
          .withArgs(vSPCXB.address, false);
        expect(await sentinel.isMarketMonitored(vSPCXB.address)).to.equal(false);
        expect(await sentinel.getMonitoredMarkets()).to.have.members([vTSLAB.address, vNVDAB.address]);
      });

      it("should revert with ZeroAddress when market is address(0)", async () => {
        await expect(sentinel.setMarketMonitored(ZERO_ADDRESS, false)).to.be.revertedWithCustomError(
          sentinel,
          "ZeroAddress",
        );
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 4. checkBStockPause
  // ═══════════════════════════════════════════════════════════════════

  describe("checkBStockPause", () => {
    beforeEach(async () => {
      await sentinel.setMarketMonitored(vTSLAB.address, true);
      primeFakes();
    });

    it("should return zeros for a market that is not monitored, without reading it", async () => {
      setPaused(pauseManager, SPCXB, true);
      const [isPaused, underlying, manager] = await sentinel.checkBStockPause(vSPCXB.address);
      expect([isPaused, underlying, manager]).to.deep.equal([false, ZERO_ADDRESS, ZERO_ADDRESS]);
      expect(vSPCXB.underlying).to.not.have.been.called;
    });

    it("should report a monitored market whose token is not paused", async () => {
      const [isPaused, underlying, manager] = await sentinel.checkBStockPause(vTSLAB.address);
      expect([isPaused, underlying, manager]).to.deep.equal([false, TSLAB, pauseManager.address]);
    });

    it("should report a monitored market whose token is paused, without reading the compliance module", async () => {
      setPaused(pauseManager, TSLAB, true);
      const [isPaused, underlying, manager] = await sentinel.checkBStockPause(vTSLAB.address);
      expect([isPaused, underlying, manager]).to.deep.equal([true, TSLAB, pauseManager.address]);
      expect(tslab.compliance).to.not.have.been.called;
    });

    it("should run the token's compliance check for the market while the token is not paused", async () => {
      await sentinel.checkBStockPause(vTSLAB.address);
      expect(compliance.checkIsCompliant).to.have.been.calledOnceWith(TSLAB, vTSLAB.address);
    });

    it("should report a market the compliance module rejects as paused", async () => {
      compliance.checkIsCompliant.whenCalledWith(TSLAB, vTSLAB.address).reverts("UserBlocked");
      const [isPaused, underlying, manager] = await sentinel.checkBStockPause(vTSLAB.address);
      expect([isPaused, underlying, manager]).to.deep.equal([true, TSLAB, pauseManager.address]);
    });

    it("should report paused on a revert without a reason (fail closed)", async () => {
      compliance.checkIsCompliant.reverts();
      const [isPaused] = await sentinel.checkBStockPause(vTSLAB.address);
      expect(isPaused).to.equal(true);
    });

    it("should ignore a rejection of another token or another account", async () => {
      compliance.checkIsCompliant.whenCalledWith(NVDAB, vTSLAB.address).reverts();
      compliance.checkIsCompliant.whenCalledWith(TSLAB, user.address).reverts();
      const [isPaused] = await sentinel.checkBStockPause(vTSLAB.address);
      expect(isPaused).to.equal(false);
    });

    it("should bubble up a revert from the token's compliance()", async () => {
      tslab.compliance.reverts("compliance getter failure");
      await expect(sentinel.checkBStockPause(vTSLAB.address)).to.be.revertedWith("compliance getter failure");
    });

    it("should report no pause for a token without a PauseManager", async () => {
      tslab.pauseManager.returns(ZERO_ADDRESS);
      const [isPaused, underlying, manager] = await sentinel.checkBStockPause(vTSLAB.address);
      expect([isPaused, underlying, manager]).to.deep.equal([false, TSLAB, ZERO_ADDRESS]);
      expect(pauseManager.isTokenPaused).to.not.have.been.called;
    });

    it("should report no pause for a market whose underlying is address(0)", async () => {
      vTSLAB.underlying.returns(ZERO_ADDRESS);
      const [isPaused, underlying, manager] = await sentinel.checkBStockPause(vTSLAB.address);
      expect([isPaused, underlying, manager]).to.deep.equal([false, ZERO_ADDRESS, ZERO_ADDRESS]);
      expect(tslab.pauseManager).to.not.have.been.called;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 5. handleBStockPause
  // ═══════════════════════════════════════════════════════════════════

  describe("handleBStockPause", () => {
    beforeEach(async () => {
      await sentinel.setTrustedKeeper(keeper.address, true);
      await sentinel.setMarketMonitored(vTSLAB.address, true);
      await sentinel.setMarketMonitored(vNVDAB.address, true);
      // Drop the calls made by the setup above so call assertions only see handleBStockPause
      primeFakes();
    });

    describe("access", () => {
      it("should revert with UnauthorizedKeeper for a caller that is not a trusted keeper", async () => {
        setPaused(pauseManager, TSLAB, true);
        await expect(sentinel.connect(user).handleBStockPause(vTSLAB.address)).to.be.revertedWithCustomError(
          sentinel,
          "UnauthorizedKeeper",
        );
        expect(vTSLAB.underlying).to.not.have.been.called;
        expect(decreaseCF()).to.not.have.been.called;
      });

      it("should check the keeper before the market (UnauthorizedKeeper on an unmonitored market)", async () => {
        await expect(sentinel.connect(user).handleBStockPause(vSPCXB.address)).to.be.revertedWithCustomError(
          sentinel,
          "UnauthorizedKeeper",
        );
      });

      it("should revert with UnauthorizedKeeper after the keeper is untrusted", async () => {
        setPaused(pauseManager, TSLAB, true);
        await sentinel.setTrustedKeeper(keeper.address, false);
        await expect(sentinel.connect(keeper).handleBStockPause(vTSLAB.address)).to.be.revertedWithCustomError(
          sentinel,
          "UnauthorizedKeeper",
        );
        expect(decreaseCF()).to.not.have.been.called;
      });

      it("should accept any trusted keeper", async () => {
        setPaused(pauseManager, TSLAB, true);
        await sentinel.setTrustedKeeper(otherKeeper.address, true);
        await expect(sentinel.connect(otherKeeper).handleBStockPause(vTSLAB.address))
          .to.emit(sentinel, "BStockPauseHandled")
          .withArgs(vTSLAB.address, TSLAB, pauseManager.address);
      });

      it("should gate on trusted keepers only, without an ACM check", async () => {
        setPaused(pauseManager, TSLAB, true);
        accessControlManager.isAllowedToCall.returns(false);
        await expect(sentinel.connect(keeper).handleBStockPause(vTSLAB.address))
          .to.emit(sentinel, "BStockPauseHandled")
          .withArgs(vTSLAB.address, TSLAB, pauseManager.address);
        expect(accessControlManager.isAllowedToCall).to.not.have.been.called;
      });
    });

    describe("market and pause checks", () => {
      it("should revert with MarketNotMonitored for a market that is not monitored", async () => {
        setPaused(pauseManager, SPCXB, true);
        await expect(sentinel.connect(keeper).handleBStockPause(vSPCXB.address))
          .to.be.revertedWithCustomError(sentinel, "MarketNotMonitored")
          .withArgs(vSPCXB.address);
        expect(vSPCXB.underlying).to.not.have.been.called;
        expect(decreaseCF()).to.not.have.been.called;
      });

      it("should revert with MarketNotMonitored after the market is removed, even while paused", async () => {
        setPaused(pauseManager, TSLAB, true);
        await sentinel.setMarketMonitored(vTSLAB.address, false);
        await expect(sentinel.connect(keeper).handleBStockPause(vTSLAB.address))
          .to.be.revertedWithCustomError(sentinel, "MarketNotMonitored")
          .withArgs(vTSLAB.address);
        expect(decreaseCF()).to.not.have.been.called;
      });

      it("should do nothing when the underlying is not paused", async () => {
        expect(await emittedEvents(sentinel.connect(keeper).handleBStockPause(vTSLAB.address))).to.deep.equal([]);
        expect(pauseManager.isTokenPaused).to.have.been.calledOnceWith(TSLAB);
        expect(decreaseCF()).to.not.have.been.called;
      });

      it("should do nothing when only a different token is paused", async () => {
        setPaused(pauseManager, NVDAB, true);
        expect(await emittedEvents(sentinel.connect(keeper).handleBStockPause(vTSLAB.address))).to.deep.equal([]);
        expect(decreaseCF()).to.not.have.been.called;
      });

      it("should do nothing again after the token is unpaused", async () => {
        setPaused(pauseManager, TSLAB, true);
        await sentinel.connect(keeper).handleBStockPause(vTSLAB.address);

        setPaused(pauseManager, TSLAB, false);
        expect(await emittedEvents(sentinel.connect(keeper).handleBStockPause(vTSLAB.address))).to.deep.equal([]);
        expect(decreaseCF()).to.have.been.calledOnce;
      });
    });

    describe("failing dependencies", () => {
      beforeEach(async () => {
        setPaused(pauseManager, TSLAB, true);
      });

      it("should bubble up a revert from the market's underlying()", async () => {
        vTSLAB.underlying.reverts("underlying failure");
        await expect(sentinel.connect(keeper).handleBStockPause(vTSLAB.address)).to.be.revertedWith(
          "underlying failure",
        );
        expect(decreaseCF()).to.not.have.been.called;
      });

      it("should bubble up a revert from the token's pauseManager()", async () => {
        tslab.pauseManager.reverts("pauseManager failure");
        await expect(sentinel.connect(keeper).handleBStockPause(vTSLAB.address)).to.be.revertedWith(
          "pauseManager failure",
        );
        expect(decreaseCF()).to.not.have.been.called;
      });

      it("should revert with MarketNotSupported when the token has no PauseManager", async () => {
        tslab.pauseManager.returns(ZERO_ADDRESS);
        await expect(sentinel.connect(keeper).handleBStockPause(vTSLAB.address))
          .to.be.revertedWithCustomError(sentinel, "MarketNotSupported")
          .withArgs(vTSLAB.address);
        expect(decreaseCF()).to.not.have.been.called;
      });

      it("should revert with MarketNotSupported when the market's underlying is address(0)", async () => {
        vTSLAB.underlying.returns(ZERO_ADDRESS);
        await expect(sentinel.connect(keeper).handleBStockPause(vTSLAB.address))
          .to.be.revertedWithCustomError(sentinel, "MarketNotSupported")
          .withArgs(vTSLAB.address);
        expect(decreaseCF()).to.not.have.been.called;
      });

      it("should revert without a reason when the underlying has no pauseManager() (not a bStock)", async () => {
        vTSLAB.underlying.returns(user.address);
        await expect(sentinel.connect(keeper).handleBStockPause(vTSLAB.address)).to.be.revertedWithoutReason();
        expect(decreaseCF()).to.not.have.been.called;
      });

      it("should bubble up a revert from the PauseManager", async () => {
        pauseManager.isTokenPaused.whenCalledWith(TSLAB).reverts("PauseManager failure");
        await expect(sentinel.connect(keeper).handleBStockPause(vTSLAB.address)).to.be.revertedWith(
          "PauseManager failure",
        );
        expect(decreaseCF()).to.not.have.been.called;
      });

      it("should bubble up a revert from EBrake", async () => {
        decreaseCF().reverts("EBrake failure");
        await expect(sentinel.connect(keeper).handleBStockPause(vTSLAB.address)).to.be.revertedWith("EBrake failure");
      });
    });

    describe("token paused", () => {
      beforeEach(async () => {
        setPaused(pauseManager, TSLAB, true);
      });

      it("should call EBrake.decreaseCF(market, 0) exactly once", async () => {
        await sentinel.connect(keeper).handleBStockPause(vTSLAB.address);
        expect(decreaseCF()).to.have.been.calledOnceWith(vTSLAB.address, 0);
      });

      it("should read the underlying, its PauseManager and the pause state exactly once", async () => {
        await sentinel.connect(keeper).handleBStockPause(vTSLAB.address);
        expect(vTSLAB.underlying).to.have.been.calledOnce;
        expect(tslab.pauseManager).to.have.been.calledOnce;
        expect(pauseManager.isTokenPaused).to.have.been.calledOnceWith(TSLAB);
        expect(tslab.compliance).to.not.have.been.called;
      });

      it("should emit exactly one BStockPauseHandled(market, underlying, caller, pauseManager)", async () => {
        const tx = sentinel.connect(keeper).handleBStockPause(vTSLAB.address);
        await expect(tx).to.emit(sentinel, "BStockPauseHandled").withArgs(vTSLAB.address, TSLAB, pauseManager.address);
        expect(await emittedEvents(tx)).to.deep.equal(["BStockPauseHandled"]);
      });

      it("should not change any sentinel state", async () => {
        await sentinel.connect(keeper).handleBStockPause(vTSLAB.address);
        expect(await sentinel.isMarketMonitored(vTSLAB.address)).to.equal(true);
        expect(await sentinel.trustedKeepers(keeper.address)).to.equal(true);
      });

      it("should not act on other monitored markets", async () => {
        await sentinel.connect(keeper).handleBStockPause(vTSLAB.address);
        expect(decreaseCF()).to.not.have.been.calledWith(vNVDAB.address, 0);
        expect(await emittedEvents(sentinel.connect(keeper).handleBStockPause(vNVDAB.address))).to.deep.equal([]);
      });

      it("should forward every repeat call to EBrake (EBrake makes them no-ops)", async () => {
        await sentinel.connect(keeper).handleBStockPause(vTSLAB.address);
        await sentinel.connect(keeper).handleBStockPause(vTSLAB.address);
        expect(decreaseCF()).to.have.been.calledTwice;
        expect(decreaseCF().getCall(0).args).to.deep.equal([vTSLAB.address, ethers.constants.Zero]);
        expect(decreaseCF().getCall(1).args).to.deep.equal([vTSLAB.address, ethers.constants.Zero]);
      });
    });

    describe("several tokens paused", () => {
      it("should zero CF for every paused monitored market", async () => {
        setPaused(pauseManager, TSLAB, true);
        setPaused(pauseManager, NVDAB, true);

        await expect(sentinel.connect(keeper).handleBStockPause(vTSLAB.address))
          .to.emit(sentinel, "BStockPauseHandled")
          .withArgs(vTSLAB.address, TSLAB, pauseManager.address);
        await expect(sentinel.connect(keeper).handleBStockPause(vNVDAB.address))
          .to.emit(sentinel, "BStockPauseHandled")
          .withArgs(vNVDAB.address, NVDAB, pauseManager.address);

        expect(decreaseCF()).to.have.been.calledTwice;
        expect(decreaseCF().getCall(0).args).to.deep.equal([vTSLAB.address, ethers.constants.Zero]);
        expect(decreaseCF().getCall(1).args).to.deep.equal([vNVDAB.address, ethers.constants.Zero]);
      });

      it("should still revert for a paused market that is not monitored", async () => {
        setPaused(pauseManager, SPCXB, true);
        await expect(sentinel.connect(keeper).handleBStockPause(vSPCXB.address))
          .to.be.revertedWithCustomError(sentinel, "MarketNotMonitored")
          .withArgs(vSPCXB.address);
        expect(decreaseCF()).to.not.have.been.called;
      });
    });

    describe("market blocked by the compliance module", () => {
      it("should zero CF for a market the compliance module rejects and emit BStockPauseHandled", async () => {
        compliance.checkIsCompliant.whenCalledWith(TSLAB, vTSLAB.address).reverts("UserSanctioned");
        await expect(sentinel.connect(keeper).handleBStockPause(vTSLAB.address))
          .to.emit(sentinel, "BStockPauseHandled")
          .withArgs(vTSLAB.address, TSLAB, pauseManager.address);
        expect(decreaseCF()).to.have.been.calledOnceWith(vTSLAB.address, 0);
      });

      it("should not act on other monitored markets", async () => {
        compliance.checkIsCompliant.whenCalledWith(TSLAB, vTSLAB.address).reverts();
        expect(await emittedEvents(sentinel.connect(keeper).handleBStockPause(vNVDAB.address))).to.deep.equal([]);
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
        await expect(sentinel.connect(keeper).handleBStockPause(vTSLAB.address))
          .to.emit(sentinel, "BStockPauseHandled")
          .withArgs(vTSLAB.address, TSLAB, otherPauseManager.address);
        expect(otherPauseManager.isTokenPaused).to.have.been.calledOnceWith(TSLAB);
        expect(pauseManager.isTokenPaused).to.not.have.been.called;
        expect(decreaseCF()).to.have.been.calledOnceWith(vTSLAB.address, 0);
      });

      it("should ignore a pause on the old PauseManager the token no longer checks", async () => {
        setPaused(pauseManager, TSLAB, true);
        expect(await emittedEvents(sentinel.connect(keeper).handleBStockPause(vTSLAB.address))).to.deep.equal([]);
        expect(pauseManager.isTokenPaused).to.not.have.been.called;
        expect(decreaseCF()).to.not.have.been.called;
      });

      it("should keep using the original PauseManager for the other tokens", async () => {
        setPaused(pauseManager, NVDAB, true);
        await expect(sentinel.connect(keeper).handleBStockPause(vNVDAB.address))
          .to.emit(sentinel, "BStockPauseHandled")
          .withArgs(vNVDAB.address, NVDAB, pauseManager.address);
        expect(otherPauseManager.isTokenPaused).to.not.have.been.called;
      });
    });
  });
});
