import { FakeContract, smock } from "@defi-wonderland/smock";
import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import chai from "chai";
import { Contract } from "ethers";
import { parseUnits } from "ethers/lib/utils";
import { ethers, upgrades } from "hardhat";

import type {
  IAccessControlManagerV8,
  IEBrake,
  IILComptroller,
  PoolRegistryInterface,
  SpokePoolEBrakeHandler,
} from "../../../typechain";

const { expect } = chai;
chai.use(smock.matchers);

const MINT = 0;
const BORROW = 2;
const CF = parseUnits("0.5", 18);
const CAP = parseUnits("1000", 18);
const ZERO_ADDRESS = ethers.constants.AddressZero;

// Comptrollers outside the Spoke PoolRegistry: the Core comptroller and an unregistered one
const CORE = ethers.Wallet.createRandom().address;
const UNREGISTERED = ethers.Wallet.createRandom().address;

const LISTED = { isListed: true, collateralFactorMantissa: 0, liquidationThresholdMantissa: 0 };
const NOT_LISTED = { isListed: false, collateralFactorMantissa: 0, liquidationThresholdMantissa: 0 };

/** PoolRegistry entry for `comptroller`; an empty one (comptroller 0) means "not registered". */
const pool = (comptroller: string) => ({
  name: "",
  creator: ZERO_ADDRESS,
  comptroller,
  blockPosted: 0,
  timestampPosted: 0,
});

/** Spoke comptroller that lists every market unless told otherwise. */
async function fakeSpokeComptroller() {
  const comptroller = await smock.fake<IILComptroller>("contracts/Interfaces/IILComptroller.sol:IILComptroller");
  comptroller.markets.returns(LISTED);
  return comptroller;
}

async function fakeMarket(comptroller: string) {
  const market = await smock.fake<Contract>("contracts/Interfaces/IVToken.sol:IVToken");
  market.comptroller.returns(comptroller);
  return market;
}

describe("SpokePoolEBrakeHandler", () => {
  let handler: SpokePoolEBrakeHandler;
  let accessControlManager: FakeContract<IAccessControlManagerV8>;
  let eBrake: FakeContract<IEBrake>;
  let registry: FakeContract<PoolRegistryInterface>;
  let spoke: FakeContract<IILComptroller>;
  let otherSpoke: FakeContract<IILComptroller>;
  let spokeMarket: FakeContract<Contract>;
  let spokeMarket2: FakeContract<Contract>;
  let otherSpokeMarket: FakeContract<Contract>;
  let coreMarket: FakeContract<Contract>;
  let unregisteredMarket: FakeContract<Contract>;
  let owner: SignerWithAddress;
  let user: SignerWithAddress;

  beforeEach(async () => {
    [owner, user] = await ethers.getSigners();

    accessControlManager = await smock.fake<IAccessControlManagerV8>("IAccessControlManagerV8");
    accessControlManager.isAllowedToCall.returns(true);
    eBrake = await smock.fake<IEBrake>("IEBrake");
    registry = await smock.fake<PoolRegistryInterface>(
      "@venusprotocol/isolated-pools/contracts/Pool/PoolRegistryInterface.sol:PoolRegistryInterface",
    );
    spoke = await fakeSpokeComptroller();
    otherSpoke = await fakeSpokeComptroller();
    registry.getPoolByComptroller.returns(pool(ZERO_ADDRESS));
    registry.getPoolByComptroller.whenCalledWith(spoke.address).returns(pool(spoke.address));
    registry.getPoolByComptroller.whenCalledWith(otherSpoke.address).returns(pool(otherSpoke.address));

    spokeMarket = await fakeMarket(spoke.address);
    spokeMarket2 = await fakeMarket(spoke.address);
    otherSpokeMarket = await fakeMarket(otherSpoke.address);
    coreMarket = await fakeMarket(CORE);
    unregisteredMarket = await fakeMarket(UNREGISTERED);

    handler = (await upgrades.deployProxy(
      await ethers.getContractFactory("SpokePoolEBrakeHandler"),
      [accessControlManager.address],
      {
        constructorArgs: [eBrake.address, registry.address],
        unsafeAllow: ["constructor", "state-variable-immutable"],
      },
    )) as SpokePoolEBrakeHandler;
  });

  // ═══════════════════════════════════════════════════════════════════
  // 1. Initialization
  // ═══════════════════════════════════════════════════════════════════

  describe("Initialization", () => {
    it("should store EBRAKE and SPOKE_POOL_REGISTRY", async () => {
      expect(await handler.EBRAKE()).to.equal(eBrake.address);
      expect(await handler.SPOKE_POOL_REGISTRY()).to.equal(registry.address);
    });

    it("should set the access control manager and owner", async () => {
      expect(await handler.accessControlManager()).to.equal(accessControlManager.address);
      expect(await handler.owner()).to.equal(owner.address);
    });

    it("should revert with ZeroAddress when EBrake or the registry is address(0)", async () => {
      const Factory = await ethers.getContractFactory("SpokePoolEBrakeHandler");
      await expect(Factory.deploy(ZERO_ADDRESS, registry.address)).to.be.revertedWithCustomError(
        handler,
        "ZeroAddress",
      );
      await expect(Factory.deploy(eBrake.address, ZERO_ADDRESS)).to.be.revertedWithCustomError(handler, "ZeroAddress");
    });

    it("should revert with ZeroAddress when the access control manager is address(0)", async () => {
      const Factory = await ethers.getContractFactory("SpokePoolEBrakeHandler");
      await expect(
        upgrades.deployProxy(Factory, [ZERO_ADDRESS], {
          constructorArgs: [eBrake.address, registry.address],
          unsafeAllow: ["constructor", "state-variable-immutable"],
        }),
      ).to.be.revertedWithCustomError(handler, "ZeroAddress");
    });

    it("should reject re-initialization", async () => {
      await expect(handler.initialize(accessControlManager.address)).to.be.revertedWith(
        "Initializable: contract is already initialized",
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 2. Single-market functions
  // ═══════════════════════════════════════════════════════════════════

  // Each function: its ACM signature, a call to it, the EBrake function it forwards to, and the arguments
  // forwarded after the market
  const singleMarketFunctions = [
    {
      signature: "pauseSupply(address)",
      call: (h: SpokePoolEBrakeHandler, market: string) => h.pauseSupply(market),
      eBrakeFunction: () => eBrake.pauseSupply,
      extraArgs: [],
    },
    {
      signature: "pauseRedeem(address)",
      call: (h: SpokePoolEBrakeHandler, market: string) => h.pauseRedeem(market),
      eBrakeFunction: () => eBrake.pauseRedeem,
      extraArgs: [],
    },
    {
      signature: "pauseBorrow(address)",
      call: (h: SpokePoolEBrakeHandler, market: string) => h.pauseBorrow(market),
      eBrakeFunction: () => eBrake.pauseBorrow,
      extraArgs: [],
    },
    {
      signature: "pauseTransfer(address)",
      call: (h: SpokePoolEBrakeHandler, market: string) => h.pauseTransfer(market),
      eBrakeFunction: () => eBrake.pauseTransfer,
      extraArgs: [],
    },
    {
      signature: "decreaseCF(address,uint256)",
      call: (h: SpokePoolEBrakeHandler, market: string) => h.decreaseCF(market, CF),
      eBrakeFunction: () => eBrake["decreaseCF(address,uint256)"],
      extraArgs: [CF],
    },
  ];

  for (const { signature, call, eBrakeFunction, extraArgs } of singleMarketFunctions) {
    describe(signature, () => {
      it("should revert with Unauthorized without ACM permission", async () => {
        accessControlManager.isAllowedToCall.whenCalledWith(user.address, signature).returns(false);
        await expect(call(handler.connect(user), spokeMarket.address))
          .to.be.revertedWithCustomError(handler, "Unauthorized")
          .withArgs(user.address, handler.address, signature);
        expect(eBrakeFunction()).to.not.have.been.called;
      });

      it("should forward a registered Spoke market to EBrake", async () => {
        await call(handler, spokeMarket.address);
        expect(eBrakeFunction()).to.have.been.calledOnceWith(spokeMarket.address, ...extraArgs);
      });

      it("should revert with NotSpokeComptroller for a Core market or an unregistered comptroller", async () => {
        await expect(call(handler, coreMarket.address))
          .to.be.revertedWithCustomError(handler, "NotSpokeComptroller")
          .withArgs(CORE);
        await expect(call(handler, unregisteredMarket.address))
          .to.be.revertedWithCustomError(handler, "NotSpokeComptroller")
          .withArgs(UNREGISTERED);
        expect(eBrakeFunction()).to.not.have.been.called;
      });

      it("should revert with MarketNotListed for a market its Spoke comptroller does not list", async () => {
        spoke.markets.whenCalledWith(spokeMarket.address).returns(NOT_LISTED);
        await expect(call(handler, spokeMarket.address))
          .to.be.revertedWithCustomError(handler, "MarketNotListed")
          .withArgs(spokeMarket.address);
        expect(eBrakeFunction()).to.not.have.been.called;
      });
    });
  }

  it("should revert with NotSpokeComptroller when comptroller() returns address(0)", async () => {
    const orphanMarket = await fakeMarket(ZERO_ADDRESS);
    await expect(handler.pauseSupply(orphanMarket.address))
      .to.be.revertedWithCustomError(handler, "NotSpokeComptroller")
      .withArgs(ZERO_ADDRESS);
  });

  // ═══════════════════════════════════════════════════════════════════
  // 3. Batch functions
  // ═══════════════════════════════════════════════════════════════════

  // Each function: its ACM signature, a call to it, the EBrake function it forwards to, and the second
  // argument (actions or caps) it forwards for a given list of markets
  const batchFunctions = [
    {
      signature: "pauseActions(address[],uint8[])",
      call: (h: SpokePoolEBrakeHandler, markets: string[]) => h.pauseActions(markets, [MINT, BORROW]),
      eBrakeFunction: () => eBrake.pauseActions,
      secondArg: () => [MINT, BORROW],
    },
    {
      signature: "setMarketBorrowCaps(address[],uint256[])",
      call: (h: SpokePoolEBrakeHandler, markets: string[]) =>
        h.setMarketBorrowCaps(
          markets,
          markets.map(() => CAP),
        ),
      eBrakeFunction: () => eBrake.setMarketBorrowCaps,
      secondArg: (markets: string[]) => markets.map(() => CAP),
    },
    {
      signature: "setMarketSupplyCaps(address[],uint256[])",
      call: (h: SpokePoolEBrakeHandler, markets: string[]) =>
        h.setMarketSupplyCaps(
          markets,
          markets.map(() => CAP),
        ),
      eBrakeFunction: () => eBrake.setMarketSupplyCaps,
      secondArg: (markets: string[]) => markets.map(() => CAP),
    },
  ];

  for (const { signature, call, eBrakeFunction, secondArg } of batchFunctions) {
    describe(signature, () => {
      it("should revert with Unauthorized without ACM permission", async () => {
        accessControlManager.isAllowedToCall.whenCalledWith(user.address, signature).returns(false);
        await expect(call(handler.connect(user), [spokeMarket.address]))
          .to.be.revertedWithCustomError(handler, "Unauthorized")
          .withArgs(user.address, handler.address, signature);
        expect(eBrakeFunction()).to.not.have.been.called;
      });

      it("should forward markets of one registered Spoke comptroller to EBrake", async () => {
        const markets = [spokeMarket.address, spokeMarket2.address];
        await call(handler, markets);
        expect(eBrakeFunction()).to.have.been.calledOnceWith(markets, secondArg(markets));
      });

      it("should revert with NotSpokeComptroller when the first market is not a Spoke market", async () => {
        await expect(call(handler, [coreMarket.address, spokeMarket.address]))
          .to.be.revertedWithCustomError(handler, "NotSpokeComptroller")
          .withArgs(CORE);
        expect(eBrakeFunction()).to.not.have.been.called;
      });

      it("should revert with MarketsOnDifferentComptrollers for a mixed batch", async () => {
        await expect(call(handler, [spokeMarket.address, coreMarket.address]))
          .to.be.revertedWithCustomError(handler, "MarketsOnDifferentComptrollers")
          .withArgs(spoke.address, CORE);
        await expect(call(handler, [spokeMarket.address, otherSpokeMarket.address]))
          .to.be.revertedWithCustomError(handler, "MarketsOnDifferentComptrollers")
          .withArgs(spoke.address, otherSpoke.address);
        expect(eBrakeFunction()).to.not.have.been.called;
      });

      it("should revert with MarketNotListed when a later market is not listed", async () => {
        spoke.markets.whenCalledWith(spokeMarket2.address).returns(NOT_LISTED);
        await expect(call(handler, [spokeMarket.address, spokeMarket2.address]))
          .to.be.revertedWithCustomError(handler, "MarketNotListed")
          .withArgs(spokeMarket2.address);
        expect(eBrakeFunction()).to.not.have.been.called;
      });
    });
  }

  it("should forward an empty batch for EBrake to reject", async () => {
    await handler.pauseActions([], [MINT]);
    expect(eBrake.pauseActions).to.have.been.calledOnceWith([], [MINT]);
  });
});
