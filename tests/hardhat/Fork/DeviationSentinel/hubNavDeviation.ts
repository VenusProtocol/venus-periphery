// ═══════════════════════════════════════════════════════════════════════════
// Liquidity Hub NAV deviation — BSC mainnet fork
// ═══════════════════════════════════════════════════════════════════════════
import "@nomicfoundation/hardhat-chai-matchers";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { BigNumber, ContractTransaction } from "ethers";
import { parseUnits } from "ethers/lib/utils";
import { ethers } from "hardhat";

import { DeviationSentinel, EBrake } from "../../../../typechain";
import { ComptrollerInterface__factory } from "../../../../typechain/factories/ComptrollerInterface__factory";
import { DeviationSentinel__factory } from "../../../../typechain/factories/DeviationSentinel__factory";
import { EBrake__factory } from "../../../../typechain/factories/EBrake__factory";
import { IAccessControlManagerV8__factory } from "../../../../typechain/factories/IAccessControlManagerV8__factory";
import { ICorePoolComptroller__factory } from "../../../../typechain/factories/ICorePoolComptroller__factory";
import { IERC20__factory } from "../../../../typechain/factories/IERC20__factory";
import { IHubFork__factory } from "../../../../typechain/factories/IHubFork__factory";
import { IYieldGroupCentrifugeFork__factory } from "../../../../typechain/factories/IYieldGroupCentrifugeFork__factory";
import { ProxyAdmin__factory } from "../../../../typechain/factories/ProxyAdmin__factory";
import { ResilientOracle__factory } from "../../../../typechain/factories/ResilientOracle__factory";
import { SentinelOracle__factory } from "../../../../typechain/factories/SentinelOracle__factory";
import { forking, initMainnetUser } from "../utils";
import { FundControls, JTRSY, connectFund } from "./centrifuge";

const FORK_MAINNET = process.env.FORKED_NETWORK === "bscmainnet";
const FORK_BLOCK = 123130000;

// ═══════════════════════════════════════════════════════════════════════════
// ADDRESSES
// ═══════════════════════════════════════════════════════════════════════════

const ACM = "0x4788629ABc6cFCA10F9f969efdEAa1cF70c23555";
const NORMAL_TIMELOCK = "0x939bD8d64c0A9583A7Dcea9933f7b21697ab6396";
const OPERATOR = "0x83f426233B358A36953F6951161E76FB7c866a7A";
const PROXY_ADMIN = "0x6beb6D2695B67FEb73ad4f172E8E2975497187e4";

const EBRAKE = "0x35eBaBB99c7Fb7ba0C90bCc26e5d55Cdf89C23Ec";
const SENTINEL = "0x6599C15cc8407046CD91E5c0F8B7f765fF914870";
const SENTINEL_ORACLE = "0x58eae0Cf4215590E19860b66b146C5d539cb6f14";
const RESILIENT_ORACLE = "0x6592b5DE802159F3E74B2486b091D11a8256ab8A";
const HUB_REGISTRY = "0x6D93Fd479f2d37445CFBe132412e316a0364acc2";
const COMPTROLLER = "0xfD36E2c2a6789Db23113685031d7F16329158384";
const KEEPER = "0x57fa23f591203f61cef84a7bc892df69ca95c86e";

const HUB_USDT = "0x18AfDACF30F8671021dec4b78297E39d2FE87226";
const CENTRIFUGE_SOURCE = "0xDA5AFfeb43719f517676E031a727071c7D400983";
const CORE_SOURCE = "0xC9E6ceD9589363f8dC5695Be2C79AB4dDaECC94B";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const USDT_WHALE = "0x8894E0a0c962CB723c1976a4421c95949bE2D4E3";

const BTCB = "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c";
const vBTCB = "0x882C173bC7Ff3b7786CA16dfeD3DFFfb9Ee7847B";

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO PARAMETERS
// ═══════════════════════════════════════════════════════════════════════════

const PAR = parseUnits("1", 18); // one share is worth one USDT
const ALLOCATION = parseUnits("500000", 18);
const NAV_INTERVAL = 86_400;

// The Hub's own band, as VIP-661 set it for JTRSY.
const HUB_UP_GAP_BPS = 200;
const HUB_DOWN_GAP_BPS = 500;

// The sentinel's thresholds, wider than the Hub's on both sides.
const PAUSE_UP_BPS = 400;
const PAUSE_DOWN_BPS = 800;

const Status = {
  MonitoringDisabled: 0,
  YieldGroupNotRegistered: 1,
  ResourceNotRegistered: 2,
  ObservedValueZero: 3,
  CentreZero: 4,
  WithinThreshold: 5,
  Breached: 6,
};

const MINT = 0;
const BORROW = 2;

// ═══════════════════════════════════════════════════════════════════════════
// ACM GRANTS
// ═══════════════════════════════════════════════════════════════════════════

type Grant = [target: string, signature: string, account: string];

const callRole = (target: string, signature: string) =>
  ethers.utils.solidityKeccak256(["address", "string"], [target, signature]);

const EXISTING_GRANTS: Grant[] = [
  [SENTINEL, "setTokenConfig(address,(uint8,bool))", NORMAL_TIMELOCK],
  [SENTINEL, "setTokenMonitoringEnabled(address,bool)", NORMAL_TIMELOCK],
  [SENTINEL, "setTrustedKeeper(address,bool)", NORMAL_TIMELOCK],
  [SENTINEL_ORACLE, "setDirectPrice(address,uint256)", NORMAL_TIMELOCK],
  [EBRAKE, "pauseBorrow(address)", SENTINEL],
  [EBRAKE, "pauseSupply(address)", SENTINEL],
  [EBRAKE, "decreaseCF(address,uint256)", SENTINEL],
  [HUB_USDT, "unpauseHub()", NORMAL_TIMELOCK],
  [HUB_USDT, "removeYieldGroup(address)", NORMAL_TIMELOCK],
  [HUB_USDT, "emergencyReallocate((address,address,uint256)[],(address,address,uint256)[])", NORMAL_TIMELOCK],
  [CENTRIFUGE_SOURCE, "forceRemoveResource(address)", NORMAL_TIMELOCK],
  [COMPTROLLER, "_setActionsPaused(address[],uint8[],bool)", EBRAKE],
  [COMPTROLLER, "setCollateralFactor(uint96,address,uint256,uint256)", EBRAKE],
];

const NEW_GRANTS: Grant[] = [
  [SENTINEL, "setHubNavConfig(address,address,uint16,uint16)", NORMAL_TIMELOCK],
  [SENTINEL, "setNavMonitoringEnabled(address,address,bool)", NORMAL_TIMELOCK],
  [EBRAKE, "pauseHub(address)", SENTINEL],
  [HUB_USDT, "pauseHub()", EBRAKE],
  [HUB_USDT, "pauseYieldGroup(address)", EBRAKE],
  [CENTRIFUGE_SOURCE, "pauseResource(address)", EBRAKE],
];

// ═══════════════════════════════════════════════════════════════════════════
// FIXTURE
// ═══════════════════════════════════════════════════════════════════════════

type Fixture = Awaited<ReturnType<typeof setUpScenario>>;

async function setUpScenario() {
  const [, stranger, pauser] = await ethers.getSigners();
  const timelock = await initMainnetUser(NORMAL_TIMELOCK, parseUnits("10"));
  const operator = await initMainnetUser(OPERATOR, parseUnits("10"));
  const keeper = await initMainnetUser(KEEPER, parseUnits("10"));
  const user = await initMainnetUser(USDT_WHALE, parseUnits("10"));

  const acm = IAccessControlManagerV8__factory.connect(ACM, timelock);
  const hub = IHubFork__factory.connect(HUB_USDT, ethers.provider);
  const yieldGroup = IYieldGroupCentrifugeFork__factory.connect(CENTRIFUGE_SOURCE, ethers.provider);
  const comptroller = ComptrollerInterface__factory.connect(COMPTROLLER, ethers.provider);
  const corePool = ICorePoolComptroller__factory.connect(COMPTROLLER, ethers.provider);
  const usdt = IERC20__factory.connect(USDT, user);
  const sentinelOracle = SentinelOracle__factory.connect(SENTINEL_ORACLE, timelock);
  const resilientOracle = ResilientOracle__factory.connect(RESILIENT_ORACLE, ethers.provider);

  // ── Upgrade both live proxies to this branch's implementations ──
  const eBrakeImpl = await (await ethers.getContractFactory("EBrake")).deploy(COMPTROLLER, false);
  const sentinelImpl = await (
    await ethers.getContractFactory("DeviationSentinel")
  ).deploy(EBRAKE, RESILIENT_ORACLE, SENTINEL_ORACLE, HUB_REGISTRY);

  const proxyAdmin = ProxyAdmin__factory.connect(PROXY_ADMIN, timelock);
  await proxyAdmin.upgrade(EBRAKE, eBrakeImpl.address);
  await proxyAdmin.upgrade(SENTINEL, sentinelImpl.address);

  const sentinel: DeviationSentinel = DeviationSentinel__factory.connect(SENTINEL, keeper);
  const eBrake: EBrake = EBrake__factory.connect(EBRAKE, keeper);

  // ── The upgrade's VIP grants what the two halves still lack ──
  for (const [target, signature, account] of NEW_GRANTS) {
    await acm.giveCallPermission(target, signature, account);
  }

  // ── The pauser's own EBrake roles, which a VIP grants to whichever account holds them ──
  await acm.giveCallPermission(EBRAKE, "pauseHubYieldGroup(address)", pauser.address);
  await acm.giveCallPermission(EBRAKE, "pauseHubResource(address,address)", pauser.address);

  // ── Centrifuge admits the Venus source and pins the fund at par ──
  const cf: FundControls = await connectFund(JTRSY, USDT, CENTRIFUGE_SOURCE);
  await cf.admit();
  await cf.publishNav(PAR);
  await cf.liftRedemptionLiquidity(parseUnits("1000000", 18), user);

  // ── The Operator allocates 500k into the fund; Centrifuge fills it; the Operator claims ──
  await hub
    .connect(operator)
    .reallocate(
      [{ yieldGroup: CORE_SOURCE, resource: ethers.constants.AddressZero, amount: ALLOCATION }],
      [{ yieldGroup: CENTRIFUGE_SOURCE, resource: JTRSY.vault, amount: ALLOCATION }],
    );
  await cf.settleDeposit(ALLOCATION, cf.sharesFor(ALLOCATION, PAR), PAR);
  await yieldGroup.connect(operator).claimDeposit(JTRSY.vault);

  // ── Governance anchors the band on the position that just landed. Until the band anchors its
  //    anchor is zero, and both gaps are sized off the anchor, so it has no width at all.
  const anchoredAt = (await ethers.provider.getBlock("latest")).timestamp;
  await yieldGroup.connect(operator).setNavGuardSnapshot(JTRSY.vault, ALLOCATION, anchoredAt);

  const band = await yieldGroup.navGuard(JTRSY.vault);
  expect(band.upGapBps).to.equal(HUB_UP_GAP_BPS);
  expect(band.downGapBps).to.equal(HUB_DOWN_GAP_BPS);
  expect(band.interval).to.equal(NAV_INTERVAL);

  // ── Governance arms the sentinel ──
  await sentinel.connect(timelock).setHubNavConfig(CENTRIFUGE_SOURCE, JTRSY.vault, PAUSE_UP_BPS, PAUSE_DOWN_BPS);
  await sentinel.connect(timelock).setNavMonitoringEnabled(CENTRIFUGE_SOURCE, JTRSY.vault, true);

  return {
    acm,
    cf,
    comptroller,
    corePool,
    eBrake,
    hub,
    keeper,
    operator,
    pauser,
    resilientOracle,
    sentinel,
    sentinelOracle,
    stranger,
    timelock,
    usdt,
    user,
    yieldGroup,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/** Where the sentinel measures from: the band's own stored centre, read raw. */
const bandCentre = async (f: Fixture): Promise<BigNumber> => (await f.yieldGroup.navGuard(JTRSY.vault)).centre;

/** The share price that leaves the position `bps` away from the band's centre, and what it publishes. */
async function navAwayFromCentre(f: Fixture, bps: number): Promise<{ price: BigNumber; observed: BigNumber }> {
  const shares = await f.cf.sharesOf();
  const target = (await bandCentre(f)).mul(10_000 + bps).div(10_000);
  const price = target.mul(f.cf.shareUnit).div(shares);
  return { price, observed: shares.mul(price).div(f.cf.shareUnit) };
}

/** What one wei of published share price is worth across the position. */
const priceRounding = async (f: Fixture): Promise<BigNumber> => (await f.cf.sharesOf()).div(f.cf.shareUnit).add(1);

/** Centrifuge republishes the fund at `bps` away from the band's centre. Returns the value it now reports. */
async function fundMovesTo(f: Fixture, bps: number): Promise<BigNumber> {
  const { price, observed } = await navAwayFromCentre(f, bps);
  await f.cf.publishNav(price);
  return observed;
}

/** The keeper's pause, against the band the Hub was applying at the block that paused it. */
async function expectHubPaused(f: Fixture, tx: ContractTransaction, observed: BigNumber, centre: BigNumber) {
  const { minAllowedValue, maxAllowedValue } = await f.yieldGroup.navGuardStatus(JTRSY.vault);
  await expect(tx)
    .to.emit(f.sentinel, "NavGuardDeviationHandled")
    .withArgs(HUB_USDT, CENTRIFUGE_SOURCE, JTRSY.vault, observed, centre, minAllowedValue, maxAllowedValue)
    .and.to.emit(f.eBrake, "HubPaused")
    .withArgs(SENTINEL, HUB_USDT);
  expect(await f.hub.hubPaused()).to.be.true;
}

const runKeeper = (f: Fixture) => f.sentinel.connect(f.keeper).handleNavGuardDeviation(CENTRIFUGE_SOURCE, JTRSY.vault);

/** A plain user putting USDT into the Hub and taking it back out. */
async function depositIntoHub(f: Fixture, assets: BigNumber) {
  await f.usdt.approve(HUB_USDT, assets);
  return f.hub.connect(f.user).deposit(assets, f.user.address);
}

// ═══════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════

if (FORK_MAINNET) {
  forking(FORK_BLOCK, () => {
    let f: Fixture;

    describe("Liquidity Hub NAV deviation (BSC Mainnet)", () => {
      beforeEach(async () => {
        f = await loadFixture(setUpScenario);
      });

      // ═════════════════════════════════════════════════════════════════════
      // The protocol keeps working after the upgrade
      // ═════════════════════════════════════════════════════════════════════

      describe("the upgrade leaves everything that already worked alone", () => {
        it("still points at the same EBrake, oracles and access control", async () => {
          expect(await f.sentinel.EBRAKE()).to.equal(EBRAKE);
          expect(await f.sentinel.RESILIENT_ORACLE()).to.equal(RESILIENT_ORACLE);
          expect(await f.sentinel.SENTINEL_ORACLE()).to.equal(SENTINEL_ORACLE);
          expect(await f.sentinel.accessControlManager()).to.equal(ACM);
          expect(await f.sentinel.owner()).to.equal(NORMAL_TIMELOCK);
          expect(await f.eBrake.COMPTROLLER()).to.equal(COMPTROLLER);
          expect(await f.eBrake.IS_ISOLATED_POOL()).to.be.false;
          expect(await f.eBrake.accessControlManager()).to.equal(ACM);
        });

        it("now also knows where to look up a Hub", async () => {
          expect(await f.sentinel.HUB_REGISTRY()).to.equal(HUB_REGISTRY);
        });

        it("keeps the market configs and keepers written before the upgrade", async () => {
          const config = await f.sentinel.tokenConfigs(BTCB);
          expect(config.deviation).to.equal(10);
          expect(config.enabled).to.be.true;
          expect(await f.sentinel.trustedKeepers(KEEPER)).to.be.true;
          expect(await f.sentinel.trustedKeepers(f.stranger.address)).to.be.false;

          const unconfigured = await f.sentinel.navGuardConfigs(CORE_SOURCE, JTRSY.vault);
          expect(unconfigured.hub).to.equal(ethers.constants.AddressZero);
          expect(unconfigured.pauseUpBps).to.equal(0);
          expect(unconfigured.pauseDownBps).to.equal(0);
          expect(unconfigured.enabled).to.be.false;
        });

        it("keeps every ACM grant the protocol already carried", async () => {
          for (const [target, signature, account] of EXISTING_GRANTS) {
            expect(await f.acm.hasRole(callRole(target, signature), account), `${signature} on ${target}`).to.be.true;
          }
        });

        it("still pauses borrow on a market the sentinel prices above the oracle", async () => {
          const oraclePrice = await f.resilientOracle.getUnderlyingPrice(vBTCB);
          await f.sentinelOracle.setDirectPrice(BTCB, oraclePrice.mul(150).div(100));

          await expect(f.sentinel.handleDeviation(vBTCB)).to.emit(f.sentinel, "DeviationHandled");

          expect(await f.comptroller.actionPaused(vBTCB, BORROW)).to.be.true;
          expect(await f.hub.hubPaused()).to.be.false;
        });

        it("still zeroes the collateral factor and pauses supply when the sentinel prices below the oracle", async () => {
          const oraclePrice = await f.resilientOracle.getUnderlyingPrice(vBTCB);
          const before = await f.corePool.poolMarkets(0, vBTCB);
          expect(before.collateralFactorMantissa).to.be.gt(0);

          await f.sentinelOracle.setDirectPrice(BTCB, oraclePrice.mul(50).div(100));
          await f.sentinel.handleDeviation(vBTCB);

          const after = await f.corePool.poolMarkets(0, vBTCB);
          expect(after.collateralFactorMantissa).to.equal(0);
          expect(after.liquidationThresholdMantissa).to.equal(before.liquidationThresholdMantissa);
          expect(await f.comptroller.actionPaused(vBTCB, MINT)).to.be.true;
          expect(await f.hub.hubPaused()).to.be.false;
        });

        it("lets users deposit into and redeem from the Hub exactly as before", async () => {
          const amount = parseUnits("10000", 18);
          const priceBefore = await f.hub.convertToAssets(parseUnits("1", 18));

          await depositIntoHub(f, amount);
          const shares = await f.hub.balanceOf(f.user.address);
          expect(shares).to.be.gt(0);

          const balanceBefore = await f.usdt.balanceOf(f.user.address);
          await f.hub.connect(f.user).redeem(shares, f.user.address, f.user.address);

          expect(await f.usdt.balanceOf(f.user.address)).to.be.gt(balanceBefore);
          expect(await f.hub.convertToAssets(parseUnits("1", 18))).to.be.closeTo(priceBefore, priceBefore.div(10_000));
        });

        it("does not let a stranger arm the NAV monitoring or drive the keeper function", async () => {
          await expect(
            f.sentinel.connect(f.stranger).setHubNavConfig(CENTRIFUGE_SOURCE, JTRSY.vault, 100, 100),
          ).to.be.revertedWithCustomError(f.sentinel, "Unauthorized");
          await expect(
            f.sentinel.connect(f.stranger).setNavMonitoringEnabled(CENTRIFUGE_SOURCE, JTRSY.vault, false),
          ).to.be.revertedWithCustomError(f.sentinel, "Unauthorized");

          await expect(
            f.sentinel.connect(f.stranger).handleNavGuardDeviation(CENTRIFUGE_SOURCE, JTRSY.vault),
          ).to.be.revertedWithCustomError(f.sentinel, "UnauthorizedKeeper");
        });

        it("does not let the sentinel reach the Hub except through EBrake", async () => {
          await expect(f.hub.connect(f.stranger).pauseHub()).to.be.revertedWithCustomError(f.hub, "Unauthorized");
          await expect(f.eBrake.connect(f.stranger).pauseHub(HUB_USDT)).to.be.revertedWithCustomError(
            f.eBrake,
            "Unauthorized",
          );
          expect(await f.hub.hubPaused()).to.be.false;
        });
      });

      // ═════════════════════════════════════════════════════════════════════
      // The fund misreports its NAV
      // ═════════════════════════════════════════════════════════════════════

      describe("the fund reports a value the band did not expect", () => {
        it("starts from a healthy position the Hub is not clamping", async () => {
          const status = await f.yieldGroup.navGuardStatus(JTRSY.vault);
          expect(status.observedValue).to.be.gt(0);
          expect(status.isClamped).to.be.false;
          expect(await bandCentre(f)).to.be.gt(0);
          expect(await f.usdt.balanceOf(CENTRIFUGE_SOURCE)).to.equal(0);
          expect(await f.yieldGroup.totalAssets()).to.equal(status.observedValue);

          const check = await f.sentinel.checkNavGuardDeviation(CENTRIFUGE_SOURCE, JTRSY.vault);
          expect(check.status).to.equal(Status.WithinThreshold);
          await expect(runKeeper(f)).to.be.revertedWithCustomError(f.sentinel, "DeviationWithinThreshold");
        });

        it("tolerates a gain the Hub is already clamping, because that is the Hub doing its job", async () => {
          // 3% up: past the Hub's 2% cap, well inside the sentinel's 4%.
          const observed = await fundMovesTo(f, HUB_UP_GAP_BPS + 100);

          const status = await f.yieldGroup.navGuardStatus(JTRSY.vault);
          expect(status.isClamped, "the Hub is holding the position at its cap").to.be.true;
          expect(status.clampedValue).to.be.lt(observed);
          expect(await f.yieldGroup.totalAssets()).to.equal(status.clampedValue);

          await expect(runKeeper(f)).to.be.revertedWithCustomError(f.sentinel, "DeviationWithinThreshold");
          expect(await f.hub.hubPaused()).to.be.false;
        });

        it("tolerates a loss the Hub is already clamping", async () => {
          await fundMovesTo(f, -(HUB_DOWN_GAP_BPS + 100));

          expect((await f.yieldGroup.navGuardStatus(JTRSY.vault)).isClamped).to.be.true;
          await expect(runKeeper(f)).to.be.revertedWithCustomError(f.sentinel, "DeviationWithinThreshold");
          expect(await f.hub.hubPaused()).to.be.false;
        });

        it("trips on the clamping the Hub does routinely when its threshold is narrower than the Hub's gap", async () => {
          await f.sentinel.connect(f.timelock).setHubNavConfig(CENTRIFUGE_SOURCE, JTRSY.vault, PAUSE_UP_BPS, 100);

          await fundMovesTo(f, -(HUB_DOWN_GAP_BPS + 100));
          expect((await f.yieldGroup.navGuardStatus(JTRSY.vault)).isClamped).to.be.true;

          await runKeeper(f);
          expect(await f.hub.hubPaused()).to.be.true;
        });

        it("pauses the Hub when the fund marks the position up further than any real yield explains", async () => {
          const observed = await fundMovesTo(f, 2_000);
          const centre = await bandCentre(f);

          await expectHubPaused(f, await runKeeper(f), observed, centre);
        });

        it("pauses the Hub when the fund marks the position down hard, after it has already mispriced shares", async () => {
          const sharePriceBefore = await f.hub.convertToAssets(parseUnits("1", 18));
          const observed = await fundMovesTo(f, -2_000);
          const centre = await bandCentre(f);

          // The floor clamps what the Hub reports, but not before it has marked every share down.
          expect(await f.hub.convertToAssets(parseUnits("1", 18))).to.be.lt(sharePriceBefore);

          await expectHubPaused(f, await runKeeper(f), observed, centre);
        });

        it("leaves the Hub open at the upside trip point and pauses one step past it", async () => {
          const centre = await bandCentre(f);
          const tripPoint = centre.mul(10_000 + PAUSE_UP_BPS).div(10_000);

          const { price } = await navAwayFromCentre(f, PAUSE_UP_BPS);
          await f.cf.publishNav(price);
          expect((await f.yieldGroup.navGuardStatus(JTRSY.vault)).observedValue).to.be.closeTo(
            tripPoint,
            await priceRounding(f),
          );
          await expect(runKeeper(f)).to.be.revertedWithCustomError(f.sentinel, "DeviationWithinThreshold");

          await f.cf.publishNav(price.add(1));
          expect((await f.yieldGroup.navGuardStatus(JTRSY.vault)).observedValue).to.be.gt(tripPoint);
          await runKeeper(f);
          expect(await f.hub.hubPaused()).to.be.true;
        });

        it("leaves the Hub open at the downside trip point and pauses one step past it", async () => {
          const centre = await bandCentre(f);
          const tripPoint = centre.mul(10_000 - PAUSE_DOWN_BPS).div(10_000);

          // Land the position exactly on the trip point, then one step below it.
          const shares = await f.cf.sharesOf();
          const price = tripPoint.mul(f.cf.shareUnit).div(shares).add(1);
          await f.cf.publishNav(price);
          expect((await f.yieldGroup.navGuardStatus(JTRSY.vault)).observedValue).to.be.closeTo(
            tripPoint,
            await priceRounding(f),
          );
          await expect(runKeeper(f)).to.be.revertedWithCustomError(f.sentinel, "DeviationWithinThreshold");

          await f.cf.publishNav(price.sub(2));
          expect((await f.yieldGroup.navGuardStatus(JTRSY.vault)).observedValue).to.be.lt(tripPoint);
          await runKeeper(f);
          expect(await f.hub.hubPaused()).to.be.true;
        });

        it("refuses to pause when the fund stops publishing a price at all, even though that halts the Hub", async () => {
          await f.cf.publishNav(0);

          // With no price the position cannot be valued, so the Hub's own NAV read reverts and every
          // flow on it stops. That is the fund's failure, not a band breach, and the sentinel says so.
          await expect(f.yieldGroup.totalAssets()).to.be.revertedWithCustomError(f.yieldGroup, "ZeroSharePrice");
          await expect(f.hub.totalAssets()).to.be.reverted;

          const check = await f.sentinel.checkNavGuardDeviation(CENTRIFUGE_SOURCE, JTRSY.vault);
          expect(check.status).to.equal(Status.ObservedValueZero);
          await expect(runKeeper(f)).to.be.revertedWithCustomError(f.sentinel, "NavGuardObservedValueZero");
          expect(await f.hub.hubPaused()).to.be.false;
        });

        it("re-measures against the new centre once governance retunes the band", async () => {
          const observed = await fundMovesTo(f, 600); // past the sentinel's 4%
          const oldCentre = await bandCentre(f);
          expect((await f.sentinel.checkNavGuardDeviation(CENTRIFUGE_SOURCE, JTRSY.vault)).status).to.equal(
            Status.Breached,
          );

          await f.yieldGroup
            .connect(f.operator)
            .setNavGuardRate(JTRSY.vault, 500, 2_000, 2_000, NAV_INTERVAL, true, true);

          // A retune re-anchors on what the fund reports now, but only as far as the band already in
          // force allowed — it cannot adopt a disputed reading whole.
          const newCentre = await bandCentre(f);
          expect(newCentre).to.be.gt(oldCentre);
          expect(newCentre).to.be.lt(observed);

          await expect(runKeeper(f)).to.be.revertedWithCustomError(f.sentinel, "DeviationWithinThreshold");
          expect(await f.hub.hubPaused()).to.be.false;
        });

        it("ignores a soaring fund when only the downside is being watched", async () => {
          await f.sentinel.connect(f.timelock).setHubNavConfig(CENTRIFUGE_SOURCE, JTRSY.vault, 0, PAUSE_DOWN_BPS);

          await fundMovesTo(f, 5_000);
          await expect(runKeeper(f)).to.be.revertedWithCustomError(f.sentinel, "DeviationWithinThreshold");
          expect(await f.hub.hubPaused()).to.be.false;

          await fundMovesTo(f, -2_000);
          await runKeeper(f);
          expect(await f.hub.hubPaused()).to.be.true;
        });

        it("ignores a collapsing fund when only the upside is being watched", async () => {
          await f.sentinel.connect(f.timelock).setHubNavConfig(CENTRIFUGE_SOURCE, JTRSY.vault, PAUSE_UP_BPS, 0);

          await fundMovesTo(f, -5_000);
          await expect(runKeeper(f)).to.be.revertedWithCustomError(f.sentinel, "DeviationWithinThreshold");
          expect(await f.hub.hubPaused()).to.be.false;
        });

        it("follows the band when it re-anchors on its own schedule", async () => {
          const centreBefore = await bandCentre(f);

          // A gain the Hub clamps, then a day and a Hub touch, which moves the band onto the clamped
          // reading rather than onto the reading itself.
          await fundMovesTo(f, 1_000);
          await time.increase(NAV_INTERVAL + 1);
          await f.hub.connect(f.user).accrueFees();

          const centreAfter = await bandCentre(f);
          expect(centreAfter).to.be.gt(centreBefore);
          expect(centreAfter).to.be.lt((await f.yieldGroup.navGuardStatus(JTRSY.vault)).observedValue);

          // The sentinel measures against the moved centre, so the same reading is now a breach only
          // by what the band refused to adopt.
          const check = await f.sentinel.checkNavGuardDeviation(CENTRIFUGE_SOURCE, JTRSY.vault);
          expect(check.centre).to.equal(centreAfter);
          expect(check.status).to.equal(Status.Breached);

          await runKeeper(f);
          expect(await f.hub.hubPaused()).to.be.true;
        });

        it("still catches a breach on a Hub nobody has touched for a quarter", async () => {
          const centreBefore = await bandCentre(f);
          const bandBefore = await f.yieldGroup.navGuardStatus(JTRSY.vault);

          await time.increase(90 * 86_400);

          // The Hub's band has drifted upward with the published rate; the sentinel's reference has not.
          expect((await f.yieldGroup.navGuardStatus(JTRSY.vault)).maxAllowedValue).to.be.gt(bandBefore.maxAllowedValue);
          expect(await bandCentre(f)).to.equal(centreBefore);

          await fundMovesTo(f, -2_000);
          await runKeeper(f);
          expect(await f.hub.hubPaused()).to.be.true;
        });

        it("keeps watching after Centrifuge lets the source's memberlist entry lapse", async () => {
          // Admissions expire. An expired one blocks new share movements, but the position is still
          // there and still priced, so the sentinel must not go blind to it.
          const now = (await ethers.provider.getBlock("latest")).timestamp;
          await f.cf.admit(now + 100);
          await time.increase(200);
          expect(await f.cf.isMember()).to.be.false;

          await fundMovesTo(f, -2_000);
          await runKeeper(f);
          expect(await f.hub.hubPaused()).to.be.true;
        });

        it("pauses once and stays quiet while the price stays bad", async () => {
          await fundMovesTo(f, -2_000);

          await expect(runKeeper(f)).to.emit(f.eBrake, "HubPaused");
          await expect(runKeeper(f))
            .to.emit(f.sentinel, "NavGuardDeviationHandled")
            .and.to.not.emit(f.eBrake, "HubPaused");
          expect(await f.hub.hubPaused()).to.be.true;
        });

        it("reports the same verdict to anyone reading it as it acts on", async () => {
          await fundMovesTo(f, -2_000);

          const check = await f.sentinel.connect(f.stranger).checkNavGuardDeviation(CENTRIFUGE_SOURCE, JTRSY.vault);
          expect(check.status).to.equal(Status.Breached);
          expect(check.hub).to.equal(HUB_USDT);
          expect(await f.hub.hubPaused(), "reading the verdict pauses nothing").to.be.false;

          await runKeeper(f);
          expect(await f.hub.hubPaused()).to.be.true;
        });
      });

      // ═════════════════════════════════════════════════════════════════════
      // Venus exits the fund and the band closes behind it
      // ═════════════════════════════════════════════════════════════════════

      describe("the band closes while the fund still holds value", () => {
        // The fund gains 50%, Venus redeems what the band says the position is worth — which closes
        // the band — and the gain that was never inside the band is left stranded in the fund.
        async function exitAtTheBandsValuation() {
          const gainPrice = PAR.mul(150).div(100);
          await f.cf.publishNav(gainPrice);

          const centre = await bandCentre(f);
          const sharesToRedeem = f.cf.sharesFor(centre.mul(101).div(100), gainPrice);
          const assetsBack = f.cf.assetsFor(sharesToRedeem, gainPrice);

          await f.yieldGroup.connect(f.operator).requestRedeem(JTRSY.vault, sharesToRedeem);
          await f.cf.settleRedeem(sharesToRedeem, assetsBack, gainPrice);
          await f.yieldGroup.connect(f.operator).claimRedeem(JTRSY.vault);

          expect(await bandCentre(f), "the band closed on the way out").to.equal(0);
          expect(await f.cf.sharesOf(), "but the fund still holds shares").to.be.gt(0);
        }

        it("pauses the Hub, because the Hub is now valuing a live position at nothing", async () => {
          await exitAtTheBandsValuation();

          const { observedValue } = await f.yieldGroup.navGuardStatus(JTRSY.vault);
          expect(observedValue).to.be.gt(0);
          // Everything left in the fund is invisible to the Hub: only the redeemed cash counts.
          expect(await f.yieldGroup.totalAssets()).to.equal(await f.usdt.balanceOf(CENTRIFUGE_SOURCE));

          await expect(runKeeper(f))
            .to.emit(f.sentinel, "NavGuardDeviationHandled")
            .withArgs(HUB_USDT, CENTRIFUGE_SOURCE, JTRSY.vault, observedValue, 0, 0, 0);
          expect(await f.hub.hubPaused()).to.be.true;
        });

        it("leaves the Hub open when the cap is off, because nothing is being mis-valued", async () => {
          await exitAtTheBandsValuation();
          await f.yieldGroup.connect(f.operator).setNavGuardEnabled(JTRSY.vault, false, true);

          // With the cap off the Hub reports what the fund reports, so there is nothing to flag.
          const { observedValue } = await f.yieldGroup.navGuardStatus(JTRSY.vault);
          expect(await f.yieldGroup.totalAssets()).to.be.gte(observedValue);

          await expect(runKeeper(f)).to.be.revertedWithCustomError(f.sentinel, "NavGuardCentreZero");
          expect(await f.hub.hubPaused()).to.be.false;
        });

        it("leaves the Hub open when governance is not watching the downside", async () => {
          await exitAtTheBandsValuation();
          await f.sentinel.connect(f.timelock).setHubNavConfig(CENTRIFUGE_SOURCE, JTRSY.vault, PAUSE_UP_BPS, 0);

          await expect(runKeeper(f)).to.be.revertedWithCustomError(f.sentinel, "NavGuardCentreZero");
          expect(await f.hub.hubPaused()).to.be.false;
        });

        it("tells an empty position apart from a closed band", async () => {
          await exitAtTheBandsValuation();
          await f.cf.publishNav(0);

          await expect(runKeeper(f)).to.be.revertedWithCustomError(f.sentinel, "NavGuardObservedValueZero");
          expect(await f.hub.hubPaused()).to.be.false;
        });
      });

      // ═════════════════════════════════════════════════════════════════════
      // The whole incident, start to finish
      // ═════════════════════════════════════════════════════════════════════

      describe("an incident from normal operation through to recovery", () => {
        it("stops every user flow on the Hub the moment the keeper pauses it, without touching balances", async () => {
          await depositIntoHub(f, parseUnits("10000", 18));
          const shares = await f.hub.balanceOf(f.user.address);

          await fundMovesTo(f, -2_000);
          await runKeeper(f);

          expect(await f.hub.balanceOf(f.user.address), "the user still holds their shares").to.equal(shares);
          expect(await f.hub.maxDeposit(f.user.address)).to.equal(0);

          await f.usdt.approve(HUB_USDT, parseUnits("1000", 18));
          await expect(
            f.hub.connect(f.user).deposit(parseUnits("1000", 18), f.user.address),
          ).to.be.revertedWithCustomError(f.hub, "HubPaused");
          await expect(
            f.hub.connect(f.user).mint(parseUnits("1000", 18), f.user.address),
          ).to.be.revertedWithCustomError(f.hub, "HubPaused");
          await expect(
            f.hub.connect(f.user).withdraw(parseUnits("1000", 18), f.user.address, f.user.address),
          ).to.be.revertedWithCustomError(f.hub, "HubPaused");
          await expect(
            f.hub.connect(f.user).redeem(shares, f.user.address, f.user.address),
          ).to.be.revertedWithCustomError(f.hub, "HubPaused");
        });

        it("leaves governance its wind-down lever while the Hub is paused", async () => {
          const observed = await fundMovesTo(f, -2_000);
          await runKeeper(f);

          const shares = await f.cf.sharesOf();
          const price = observed.mul(f.cf.shareUnit).div(shares);
          await f.yieldGroup.connect(f.operator).requestRedeem(JTRSY.vault, shares);
          await f.cf.settleRedeem(shares, f.cf.assetsFor(shares, price), price);
          await f.yieldGroup.connect(f.operator).claimRedeem(JTRSY.vault);

          const idle = await f.usdt.balanceOf(CENTRIFUGE_SOURCE);
          expect(idle).to.be.gt(0);

          // The redeemed cash sits idle on the group, not in the vault, so the pull leg names no
          // resource: a leg naming the vault only reaches what the vault still holds, which is zero.
          await f.hub
            .connect(f.timelock)
            .emergencyReallocate(
              [{ yieldGroup: CENTRIFUGE_SOURCE, resource: ethers.constants.AddressZero, amount: idle }],
              [{ yieldGroup: CORE_SOURCE, resource: ethers.constants.AddressZero, amount: idle }],
            );

          expect(await f.usdt.balanceOf(CENTRIFUGE_SOURCE)).to.equal(0);
          await expect(f.hub.connect(f.operator).reallocate([], [])).to.be.revertedWithCustomError(f.hub, "HubPaused");
        });

        it("gives the keeper no way to undo what it did, and re-pauses an unpause that fixed nothing", async () => {
          await fundMovesTo(f, -2_000);
          await runKeeper(f);

          await expect(f.hub.connect(f.keeper).unpauseHub()).to.be.revertedWithCustomError(f.hub, "Unauthorized");
          expect(await f.hub.hubPaused()).to.be.true;

          await f.hub.connect(f.timelock).unpauseHub();
          await runKeeper(f);
          expect(await f.hub.hubPaused()).to.be.true;
        });

        it("comes back once the fund republishes a sane price and governance re-anchors and unpauses", async () => {
          const sharePriceBefore = await f.hub.convertToAssets(parseUnits("1", 18));

          await fundMovesTo(f, -2_000);
          await runKeeper(f);
          expect(await f.hub.hubPaused()).to.be.true;

          // The fund corrects itself, governance re-anchors the band on the corrected value, and only
          // then lifts the pause.
          await f.cf.publishNav(PAR);
          const { observedValue } = await f.yieldGroup.navGuardStatus(JTRSY.vault);
          const now = (await ethers.provider.getBlock("latest")).timestamp;
          await f.yieldGroup.connect(f.operator).setNavGuardSnapshot(JTRSY.vault, observedValue, now);

          const check = await f.sentinel.checkNavGuardDeviation(CENTRIFUGE_SOURCE, JTRSY.vault);
          expect(check.status).to.equal(Status.WithinThreshold);
          await expect(runKeeper(f)).to.be.revertedWithCustomError(f.sentinel, "DeviationWithinThreshold");

          await f.hub.connect(f.timelock).unpauseHub();

          await depositIntoHub(f, parseUnits("10000", 18));
          const shares = await f.hub.balanceOf(f.user.address);
          expect(shares).to.be.gt(0);
          await f.hub.connect(f.user).redeem(shares, f.user.address, f.user.address);

          expect(await f.hub.convertToAssets(parseUnits("1", 18))).to.be.closeTo(
            sharePriceBefore,
            sharePriceBefore.div(1_000),
          );
        });

        it("is ready to pause again the next time the fund misreports", async () => {
          await fundMovesTo(f, -2_000);
          await runKeeper(f);

          await f.cf.publishNav(PAR);
          const { observedValue } = await f.yieldGroup.navGuardStatus(JTRSY.vault);
          const now = (await ethers.provider.getBlock("latest")).timestamp;
          await f.yieldGroup.connect(f.operator).setNavGuardSnapshot(JTRSY.vault, observedValue, now);
          await f.hub.connect(f.timelock).unpauseHub();

          await fundMovesTo(f, 2_000);
          await expect(runKeeper(f)).to.emit(f.eBrake, "HubPaused").withArgs(SENTINEL, HUB_USDT);
          expect(await f.hub.hubPaused()).to.be.true;
        });

        it("goes quiet the moment governance stops watching the resource", async () => {
          await f.sentinel.connect(f.timelock).setNavMonitoringEnabled(CENTRIFUGE_SOURCE, JTRSY.vault, false);

          await fundMovesTo(f, -5_000);
          await expect(runKeeper(f))
            .to.be.revertedWithCustomError(f.sentinel, "NavGuardDisabled")
            .withArgs(CENTRIFUGE_SOURCE, JTRSY.vault);
          expect(await f.hub.hubPaused()).to.be.false;

          // Re-arming is enough to bring it back; the thresholds were never lost.
          await f.sentinel.connect(f.timelock).setNavMonitoringEnabled(CENTRIFUGE_SOURCE, JTRSY.vault, true);
          const config = await f.sentinel.navGuardConfigs(CENTRIFUGE_SOURCE, JTRSY.vault);
          expect(config.pauseUpBps).to.equal(PAUSE_UP_BPS);
          expect(config.pauseDownBps).to.equal(PAUSE_DOWN_BPS);

          await runKeeper(f);
          expect(await f.hub.hubPaused()).to.be.true;
        });

        it("stops acting on a position governance has written off, and on a group it has removed", async () => {
          await fundMovesTo(f, -2_000);
          await runKeeper(f);

          // Writing off a resource is only reachable while the Hub is paused, which it now is.
          await f.yieldGroup.connect(f.timelock).forceRemoveResource(JTRSY.vault);

          await expect(runKeeper(f))
            .to.be.revertedWithCustomError(f.sentinel, "ResourceNotRegistered")
            .withArgs(CENTRIFUGE_SOURCE, JTRSY.vault);

          // And once the emptied group leaves the Hub, the sentinel says so rather than pausing.
          await f.hub.connect(f.timelock).removeYieldGroup(CENTRIFUGE_SOURCE);

          await expect(runKeeper(f))
            .to.be.revertedWithCustomError(f.sentinel, "YieldGroupNotRegistered")
            .withArgs(HUB_USDT, CENTRIFUGE_SOURCE);

          await expect(f.sentinel.connect(f.timelock).setNavMonitoringEnabled(CENTRIFUGE_SOURCE, JTRSY.vault, false))
            .to.emit(f.sentinel, "NavGuardStatusChanged")
            .withArgs(HUB_USDT, CENTRIFUGE_SOURCE, JTRSY.vault, false);
        });
      });

      // ═════════════════════════════════════════════════════════════════════
      // A pauser narrows the pause to one YieldGroup or one resource
      // ═════════════════════════════════════════════════════════════════════

      describe("a pauser pauses one YieldGroup or one resource through EBrake", () => {
        // The same leg the fixture used to fund the position, which lands when nothing is paused.
        const routeIntoFund = (f: Fixture) =>
          f.hub
            .connect(f.operator)
            .reallocate(
              [{ yieldGroup: CORE_SOURCE, resource: ethers.constants.AddressZero, amount: parseUnits("1000", 18) }],
              [{ yieldGroup: CENTRIFUGE_SOURCE, resource: JTRSY.vault, amount: parseUnits("1000", 18) }],
            );

        it("pauses the YieldGroup on the Hub, once, and leaves the Hub itself running", async () => {
          await expect(f.eBrake.connect(f.pauser).pauseHubYieldGroup(CENTRIFUGE_SOURCE))
            .to.emit(f.eBrake, "HubYieldGroupPaused")
            .withArgs(f.pauser.address, HUB_USDT, CENTRIFUGE_SOURCE);

          expect((await f.hub.yieldGroupConfig(CENTRIFUGE_SOURCE)).paused).to.be.true;
          expect(await f.hub.hubPaused()).to.be.false;
          await expect(routeIntoFund(f))
            .to.be.revertedWithCustomError(f.hub, "YieldGroupPaused")
            .withArgs(CENTRIFUGE_SOURCE);

          await expect(f.eBrake.connect(f.pauser).pauseHubYieldGroup(CENTRIFUGE_SOURCE)).to.not.emit(
            f.eBrake,
            "HubYieldGroupPaused",
          );
        });

        it("pauses the resource on the YieldGroup, once, and leaves the YieldGroup unpaused", async () => {
          await expect(f.eBrake.connect(f.pauser).pauseHubResource(CENTRIFUGE_SOURCE, JTRSY.vault))
            .to.emit(f.eBrake, "HubResourcePaused")
            .withArgs(f.pauser.address, CENTRIFUGE_SOURCE, JTRSY.vault);

          expect((await f.yieldGroup.resourceConfig(JTRSY.vault)).paused).to.be.true;
          expect((await f.hub.yieldGroupConfig(CENTRIFUGE_SOURCE)).paused).to.be.false;
          await expect(routeIntoFund(f))
            .to.be.revertedWithCustomError(f.yieldGroup, "ResourceIsPaused")
            .withArgs(JTRSY.vault);

          await expect(f.eBrake.connect(f.pauser).pauseHubResource(CENTRIFUGE_SOURCE, JTRSY.vault)).to.not.emit(
            f.eBrake,
            "HubResourcePaused",
          );
        });

        // The Hub is read from the YieldGroup, so an address that is not one has no Hub to name.
        it("reverts on an address that is not a YieldGroup", async () => {
          await expect(f.eBrake.connect(f.pauser).pauseHubYieldGroup(f.stranger.address)).to.be.reverted;
          await expect(f.eBrake.connect(f.pauser).pauseHubYieldGroup(USDT)).to.be.reverted;
        });

        it("surfaces the YieldGroup's own revert for a resource it never registered", async () => {
          await expect(f.eBrake.connect(f.pauser).pauseHubResource(CENTRIFUGE_SOURCE, f.stranger.address))
            .to.be.revertedWithCustomError(f.yieldGroup, "ResourceNotRegistered")
            .withArgs(f.stranger.address);
        });

        it("does not let a stranger reach either pause, through EBrake or around it", async () => {
          await expect(
            f.eBrake.connect(f.stranger).pauseHubYieldGroup(CENTRIFUGE_SOURCE),
          ).to.be.revertedWithCustomError(f.eBrake, "Unauthorized");
          await expect(
            f.eBrake.connect(f.stranger).pauseHubResource(CENTRIFUGE_SOURCE, JTRSY.vault),
          ).to.be.revertedWithCustomError(f.eBrake, "Unauthorized");
          await expect(f.hub.connect(f.stranger).pauseYieldGroup(CENTRIFUGE_SOURCE)).to.be.revertedWithCustomError(
            f.hub,
            "Unauthorized",
          );
          await expect(f.yieldGroup.connect(f.stranger).pauseResource(JTRSY.vault)).to.be.reverted;

          expect((await f.hub.yieldGroupConfig(CENTRIFUGE_SOURCE)).paused).to.be.false;
          expect((await f.yieldGroup.resourceConfig(JTRSY.vault)).paused).to.be.false;
        });
      });
    });
  });
}
