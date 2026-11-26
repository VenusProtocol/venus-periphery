import { FakeContract, smock } from "@defi-wonderland/smock";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import chai from "chai";
import { parseUnits } from "ethers/lib/utils";
import { ethers, upgrades } from "hardhat";

import type { EBrake, IAccessControlManagerV8, ICorePoolComptroller, IVToken } from "../../../typechain";

const { expect } = chai;
chai.use(smock.matchers);

// The exact string the per-pool reset asks the ACM for, and therefore the exact string a VIP has to grant.
const RESET_POOL_CF_SNAPSHOT_ROLE = "resetCFSnapshot(address,uint96)";

const CORE_POOL_ID = 0;
const EMODE_POOL_ID = 1;

const CORE_CF = parseUnits("0.7", 18);
const CORE_LT = parseUnits("0.75", 18);
const EMODE_CF = parseUnits("0.9", 18);
const EMODE_LT = parseUnits("0.93", 18);

// Diamond poolMarkets: (isListed, collateralFactorMantissa, isVenus, liquidationThresholdMantissa,
// liquidationIncentiveMantissa, marketPoolId, isBorrowAllowed).
const poolMarket = (poolId: number, cf: unknown, lt: unknown) => [true, cf, false, lt, 0, poolId, true];

describe("EBrake — CF snapshot reset", () => {
  let eBrake: EBrake;
  let remoteEBrake: EBrake;
  let accessControlManager: FakeContract<IAccessControlManagerV8>;
  let comptroller: FakeContract<ICorePoolComptroller>;
  let market: FakeContract<IVToken>;
  let user: SignerWithAddress;

  async function deployFixture() {
    // smock needs a live provider, and it does not start one.
    [, user] = await ethers.getSigners();

    accessControlManager = await smock.fake<IAccessControlManagerV8>("IAccessControlManagerV8");
    comptroller = await smock.fake<ICorePoolComptroller>("ICorePoolComptroller");
    market = await smock.fake<IVToken>("contracts/Interfaces/IVToken.sol:IVToken");

    const Factory = await ethers.getContractFactory("EBrake");
    const deploy = (isRemoteChain: boolean) =>
      upgrades.deployProxy(Factory, [accessControlManager.address], {
        constructorArgs: [comptroller.address, isRemoteChain],
        unsafeAllow: ["constructor", "state-variable-immutable"],
      }) as Promise<EBrake>;

    eBrake = await deploy(false);
    remoteEBrake = await deploy(true);

    return { eBrake, remoteEBrake, accessControlManager, comptroller, market, user };
  }

  beforeEach(async () => {
    ({ eBrake, remoteEBrake, accessControlManager, comptroller, market, user } = await loadFixture(deployFixture));

    // loadFixture restores chain state, but smock fakes keep their stubs across tests.
    accessControlManager.isAllowedToCall.reset();
    accessControlManager.isAllowedToCall.returns(true);
    market.comptroller.reset();
    market.comptroller.returns(comptroller.address);
    comptroller.borrowCaps.reset();
    comptroller.corePoolId.returns(CORE_POOL_ID);
    comptroller.lastPoolId.returns(EMODE_POOL_ID);
    comptroller.poolMarkets.reset();
    comptroller.poolMarkets
      .whenCalledWith(CORE_POOL_ID, market.address)
      .returns(poolMarket(CORE_POOL_ID, CORE_CF, CORE_LT));
    comptroller.poolMarkets
      .whenCalledWith(EMODE_POOL_ID, market.address)
      .returns(poolMarket(EMODE_POOL_ID, EMODE_CF, EMODE_LT));

    // Snapshot both pools.
    await eBrake["decreaseCF(address,uint256)"](market.address, 0);
  });

  describe("resetCFSnapshot(address,uint96)", () => {
    it("clears only the given pool and keeps the other pool's snapshot", async () => {
      await expect(eBrake["resetCFSnapshot(address,uint96)"](market.address, CORE_POOL_ID))
        .to.emit(eBrake, "PoolCFSnapshotReset")
        .withArgs(market.address, CORE_POOL_ID);

      const core = await eBrake.getMarketCFSnapshot(market.address, CORE_POOL_ID);
      expect(core.cf).to.equal(0);
      expect(core.lt).to.equal(0);

      const eMode = await eBrake.getMarketCFSnapshot(market.address, EMODE_POOL_ID);
      expect(eMode.cf).to.equal(EMODE_CF);
      expect(eMode.lt).to.equal(EMODE_LT);
    });

    it("lets a later decreaseCF record a fresh snapshot for the cleared pool only", async () => {
      await eBrake["resetCFSnapshot(address,uint96)"](market.address, EMODE_POOL_ID);

      const restoredCF = parseUnits("0.85", 18);
      comptroller.poolMarkets
        .whenCalledWith(EMODE_POOL_ID, market.address)
        .returns(poolMarket(EMODE_POOL_ID, restoredCF, EMODE_LT));
      await eBrake["decreaseCF(address,uint256)"](market.address, 0);

      expect((await eBrake.getMarketCFSnapshot(market.address, EMODE_POOL_ID)).cf).to.equal(restoredCF);
      expect((await eBrake.getMarketCFSnapshot(market.address, CORE_POOL_ID)).cf).to.equal(CORE_CF);
    });

    it("does not touch cap snapshots", async () => {
      comptroller.borrowCaps.returns(parseUnits("1000", 18));
      await eBrake.setMarketBorrowCaps([market.address], [0]);
      expect((await eBrake.marketStates(market.address)).borrowCapSnapshotted).to.equal(true);

      await eBrake["resetCFSnapshot(address,uint96)"](market.address, CORE_POOL_ID);

      expect((await eBrake.marketStates(market.address)).borrowCapSnapshotted).to.equal(true);
    });

    // Pins the ACM string itself. `Unauthorized` carries the signature EBrake asked for, so a drift
    // between this string and the one a VIP grants fails here rather than on chain.
    it("asks the ACM for exactly resetCFSnapshot(address,uint96)", async () => {
      accessControlManager.isAllowedToCall.returns(false);

      await expect(eBrake.connect(user)["resetCFSnapshot(address,uint96)"](market.address, CORE_POOL_ID))
        .to.be.revertedWithCustomError(eBrake, "Unauthorized")
        .withArgs(user.address, eBrake.address, RESET_POOL_CF_SNAPSHOT_ROLE);
    });

    it("reverts with NotSupportedOnRemoteChain on IL chains", async () => {
      await expect(
        remoteEBrake["resetCFSnapshot(address,uint96)"](market.address, CORE_POOL_ID),
      ).to.be.revertedWithCustomError(remoteEBrake, "NotSupportedOnRemoteChain");
    });
  });

  describe("resetCFSnapshot(address)", () => {
    it("still clears every pool of the market", async () => {
      await expect(eBrake["resetCFSnapshot(address)"](market.address))
        .to.emit(eBrake, "CFSnapshotReset")
        .withArgs(market.address);

      expect((await eBrake.getMarketCFSnapshot(market.address, CORE_POOL_ID)).cf).to.equal(0);
      expect((await eBrake.getMarketCFSnapshot(market.address, EMODE_POOL_ID)).cf).to.equal(0);
    });
  });
});
