import { FakeContract, smock } from "@defi-wonderland/smock";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { BigNumber, Contract, ContractTransaction } from "ethers";
import { parseUnits } from "ethers/lib/utils";
import { ethers } from "hardhat";

import bscmainnetAddresses from "../../../deployments/bscmainnet_addresses.json";
import { BStockPauseHandler, EBrake, IAccessControlManagerV8, IPauseManager } from "../../../typechain";
import { BStockPauseHandler__factory } from "../../../typechain/factories/BStockPauseHandler__factory";
import { EBrake__factory } from "../../../typechain/factories/EBrake__factory";
import { IAccessControlManagerV8__factory } from "../../../typechain/factories/IAccessControlManagerV8__factory";
import { FORK_MAINNET, forking, initMainnetUser } from "./utils";

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS (BSC Mainnet)
// ═══════════════════════════════════════════════════════════════════════════

// All four bStock markets are listed in the core pool at this block
const FORK_BLOCK = 126600000;

const { addresses } = bscmainnetAddresses;
const EBRAKE = addresses.EBrake;
const COMPTROLLER = "0xfd36e2c2a6789db23113685031d7f16329158384";
const NORMAL_TIMELOCK = "0x939bD8d64c0A9583A7Dcea9933f7b21697ab6396";
const ACM = "0x4788629abc6cfca10f9f969efdeaa1cf70c23555";
const DEFAULT_PROXY_ADMIN = "0x6beb6D2695B67FEb73ad4f172E8E2975497187e4";
const PAUSE_MANAGER = "0x9fc74Be63f3589485B2423984a7a0557e0CF700a";

const vTSLAB = "0x97421799419Eb782628e73e7220d8E0A207469a3";
const vNVDAB = "0xEb8Ca841cBe1BC4832A10b15c7dAB1081eDaD371";
const vSPCXB = "0xC36dFaCc7a125859C106F29b9F2d874CCF29A55A";
const vSKHYB = "0x3E281461efb3D53EC20DB207674373Ed8Ef3BbA9";
const TSLAB = "0x5b1910eAaD6450E50f816082Aa078C41F10C292f";
const NVDAB = "0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436";
const SPCXB = "0xbe9D156892E55e7154BcD3cB0FEA677F9D3103E1";
const SKHYB = "0xCA750eF65f295BBECd685Abf54e82CAf297BDB61";

// Core pool CF/LT of each bStock market at FORK_BLOCK
const BSTOCK_MARKETS = [
  { name: "vTSLAB", vToken: vTSLAB, underlying: TSLAB, cf: parseUnits("0.6", 18), lt: parseUnits("0.7", 18) },
  { name: "vNVDAB", vToken: vNVDAB, underlying: NVDAB, cf: parseUnits("0.6", 18), lt: parseUnits("0.7", 18) },
  { name: "vSPCXB", vToken: vSPCXB, underlying: SPCXB, cf: parseUnits("0.5", 18), lt: parseUnits("0.65", 18) },
  { name: "vSKHYB", vToken: vSKHYB, underlying: SKHYB, cf: parseUnits("0.5", 18), lt: parseUnits("0.65", 18) },
];
const [TSLAB_MARKET, , SPCXB_MARKET] = BSTOCK_MARKETS;

// Highest pool id at FORK_BLOCK; the fixture's e-mode pool is the next one
const LAST_POOL_ID_AT_FORK = 16;

const vUSDT = "0xfD5840Cd36d94D7229439859C0112a4185BC0255";
const USDT = "0x55d398326f99059fF775485246999027B3197955";

// Holds ~186 TSLAB at FORK_BLOCK
const TSLAB_HOLDER = "0x8a08d98cbb218fceb318ecf3abc1ba43d8a7ab0e";

// Simulated e-mode listing (none of the bStocks is in an e-mode pool at FORK_BLOCK)
const EMODE_MARKETS = [vTSLAB, vNVDAB];
const EMODE_CF = parseUnits("0.65", 18);
const EMODE_LT = parseUnits("0.75", 18);

const MANTISSA_ONE = parseUnits("1", 18);
const DECREASE_CF = "decreaseCF(address,uint256)";
const RESET_CF_SNAPSHOT = "resetCFSnapshot(address)";
const SET_TRUSTED_KEEPER = "setTrustedKeeper(address,bool)";
const SET_MARKET_MONITORED = "setMarketMonitored(address,bool)";

// ═══════════════════════════════════════════════════════════════════════════
// ABIs
// ═══════════════════════════════════════════════════════════════════════════

const COMPTROLLER_ABI = [
  "function oracle() view returns (address)",
  "function corePoolId() view returns (uint96)",
  "function lastPoolId() view returns (uint96)",
  "function poolMarkets(uint96 poolId, address vToken) view returns (bool isListed, uint256 collateralFactorMantissa, bool isVenus, uint256 liquidationThresholdMantissa, uint256 liquidationIncentiveMantissa, uint96 marketPoolId, bool isBorrowAllowed)",
  "function createPool(string label) returns (uint96)",
  "function addPoolMarkets(uint96[] poolIds, address[] vTokens)",
  "function setCollateralFactor(uint96 poolId, address vToken, uint256 newCollateralFactorMantissa, uint256 newLiquidationThresholdMantissa) returns (uint256)",
  "function enterMarkets(address[] vTokens) returns (uint256[])",
  "function getBorrowingPower(address account) view returns (uint256, uint256, uint256)",
  "function getAccountLiquidity(address account) view returns (uint256, uint256, uint256)",
];

const ORACLE_ABI = ["function getUnderlyingPrice(address vToken) view returns (uint256)"];

const PAUSE_MANAGER_ABI = [
  "function OPS_ROLE() view returns (bytes32)",
  "function getRoleMember(bytes32 role, uint256 index) view returns (address)",
  "function isTokenPaused(address token) view returns (bool)",
  "function pausedTokens(address token) view returns (bool)",
  "function allTokensPaused() view returns (bool)",
  "function pauseToken(address token)",
  "function unpauseToken(address token)",
  "function pauseAllTokens()",
  "function unpauseAllTokens()",
];

const ERC20_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

// bStock (SecuritiesToken): ERC20 plus the pause pointer, its admin and the error it reverts with while paused
const BSTOCK_ABI = [
  ...ERC20_ABI,
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
  "function getRoleMember(bytes32 role, uint256 index) view returns (address)",
  "function pauseManager() view returns (address)",
  "function setPauseManager(address newPauseManager)",
  "error TokenPaused()",
];

const VTOKEN_ABI = [
  "function mint(uint256 mintAmount) returns (uint256)",
  "function borrow(uint256 borrowAmount) returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function exchangeRateStored() view returns (uint256)",
  "function borrowBalanceStored(address account) view returns (uint256)",
];

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

type PoolState = { poolId: number; isListed: boolean; cf: BigNumber; lt: BigNumber };

/** CF/LT of `market` in every pool from corePoolId to lastPoolId. */
async function readPoolStates(comptroller: Contract, market: string): Promise<PoolState[]> {
  const corePoolId = (await comptroller.corePoolId()).toNumber();
  const lastPoolId = (await comptroller.lastPoolId()).toNumber();
  const states: PoolState[] = [];
  for (let poolId = corePoolId; poolId <= lastPoolId; poolId++) {
    const m = await comptroller.poolMarkets(poolId, market);
    states.push({ poolId, isListed: m.isListed, cf: m.collateralFactorMantissa, lt: m.liquidationThresholdMantissa });
  }
  return states;
}

/** Pool ids `states` lists the market in. */
const listedPools = (states: PoolState[]) => states.filter(p => p.isListed).map(p => p.poolId);

/** Asserts CF is zero, LT kept and the pre-pause CF/LT snapshotted, in every pool `before` lists the market in. */
async function expectCFZeroed(eBrake: EBrake, comptroller: Contract, market: string, before: PoolState[]) {
  const after = await readPoolStates(comptroller, market);
  expect(after.length).to.equal(before.length);
  for (const prev of before) {
    const now = after[prev.poolId];
    const snapshot = await eBrake.getMarketCFSnapshot(market, prev.poolId);
    if (prev.isListed) {
      expect(now.cf, `CF in pool ${prev.poolId}`).to.equal(0);
      expect(now.lt, `LT in pool ${prev.poolId}`).to.equal(prev.lt);
      expect(snapshot.cf, `snapshot CF in pool ${prev.poolId}`).to.equal(prev.cf);
      expect(snapshot.lt, `snapshot LT in pool ${prev.poolId}`).to.equal(prev.lt);
    } else {
      expect(now).to.deep.equal(prev);
      expect(snapshot.cf, `snapshot CF in pool ${prev.poolId}`).to.equal(0);
      expect(snapshot.lt, `snapshot LT in pool ${prev.poolId}`).to.equal(0);
    }
  }
}

/** Asserts nothing changed for `market` in any pool and EBrake holds no CF snapshot for it. */
async function expectUntouched(eBrake: EBrake, comptroller: Contract, market: string, before: PoolState[]) {
  expect(await readPoolStates(comptroller, market)).to.deep.equal(before);
  for (const prev of before) {
    const snapshot = await eBrake.getMarketCFSnapshot(market, prev.poolId);
    expect(snapshot.cf, `snapshot CF in pool ${prev.poolId}`).to.equal(0);
    expect(snapshot.lt, `snapshot LT in pool ${prev.poolId}`).to.equal(0);
  }
}

/** CollateralFactorDecreased events EBrake emitted in `tx`, as [caller, market, poolId, newCF]. */
async function cfDecreases(eBrake: EBrake, tx: Promise<ContractTransaction>): Promise<unknown[][]> {
  const receipt = await (await tx).wait();
  return receipt.logs
    .filter(log => log.address.toLowerCase() === eBrake.address.toLowerCase())
    .map(log => eBrake.interface.parseLog(log))
    .filter(event => event.name === "CollateralFactorDecreased")
    .map(event => [event.args[0], event.args[1], event.args[2].toNumber(), event.args[3].toNumber()]);
}

/** Names of the events the handler emitted in `tx`, in order. */
async function handlerEvents(handler: BStockPauseHandler, tx: Promise<ContractTransaction>): Promise<string[]> {
  const receipt = await (await tx).wait();
  return receipt.logs
    .filter(log => log.address.toLowerCase() === handler.address.toLowerCase())
    .map(log => handler.interface.parseLog(log).name);
}

/**
 * Value of `balance` vTokens weighted by `factor` (CF or LT), rounded exactly like the comptroller:
 * tokensToDenom = factor * exchangeRate * price (each product truncated to 18 decimals), times the balance.
 */
function weightedCollateralValue(factor: BigNumber, exchangeRate: BigNumber, price: BigNumber, balance: BigNumber) {
  const tokensToDenom = factor.mul(exchangeRate).div(MANTISSA_ONE).mul(price).div(MANTISSA_ONE);
  return tokensToDenom.mul(balance).div(MANTISSA_ONE);
}

// ═══════════════════════════════════════════════════════════════════════════
// FIXTURE
// ═══════════════════════════════════════════════════════════════════════════

type Fixture = {
  handler: BStockPauseHandler;
  eBrake: EBrake;
  comptroller: Contract;
  pauseManager: Contract;
  acm: IAccessControlManagerV8;
  keeper: SignerWithAddress;
  outsider: SignerWithAddress;
  emodePoolId: number;
};

/**
 * Deploys BStockPauseHandler against the live EBrake and performs what the VIP would do: grant decreaseCF on
 * EBrake, grant setTrustedKeeper and setMarketMonitored to the timelock, trust the keeper and register the four
 * bStock markets.
 * It also lists vTSLAB and vNVDAB in a new e-mode pool so the e-mode path of EBrake.decreaseCF is exercised.
 */
async function deployFixture(): Promise<Fixture> {
  const [deployer, keeper, , outsider] = await ethers.getSigners();
  const timelock = await initMainnetUser(NORMAL_TIMELOCK, parseUnits("10"));
  const acm = IAccessControlManagerV8__factory.connect(ACM, timelock);
  const comptroller = new ethers.Contract(COMPTROLLER, COMPTROLLER_ABI, timelock);
  const eBrake = EBrake__factory.connect(EBRAKE, timelock);

  // Deploy the handler behind a transparent proxy administered by the DefaultProxyAdmin
  const HandlerFactory = await ethers.getContractFactory("BStockPauseHandler", deployer);
  const implementation = await HandlerFactory.deploy(EBRAKE);
  const ProxyFactory = await ethers.getContractFactory(
    "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol:TransparentUpgradeableProxy",
    deployer,
  );
  const initData = implementation.interface.encodeFunctionData("initialize", [ACM]);
  const proxy = await ProxyFactory.deploy(implementation.address, DEFAULT_PROXY_ADMIN, initData);
  const handler = BStockPauseHandler__factory.connect(proxy.address, timelock);

  // VIP: permissions, keeper and market registration
  await acm.giveCallPermission(EBRAKE, DECREASE_CF, handler.address);
  await acm.giveCallPermission(handler.address, SET_TRUSTED_KEEPER, NORMAL_TIMELOCK);
  await acm.giveCallPermission(handler.address, SET_MARKET_MONITORED, NORMAL_TIMELOCK);
  await handler.setTrustedKeeper(keeper.address, true);
  for (const { vToken } of BSTOCK_MARKETS) {
    await handler.setMarketMonitored(vToken, true);
  }

  // Simulated e-mode pool containing vTSLAB and vNVDAB
  await comptroller.createPool("bStock e-mode (fork test)");
  const emodePoolId = (await comptroller.lastPoolId()).toNumber();
  await comptroller.addPoolMarkets(
    EMODE_MARKETS.map(() => emodePoolId),
    EMODE_MARKETS,
  );
  for (const market of EMODE_MARKETS) {
    expect(await comptroller.callStatic.setCollateralFactor(emodePoolId, market, EMODE_CF, EMODE_LT)).to.equal(0);
    await comptroller.setCollateralFactor(emodePoolId, market, EMODE_CF, EMODE_LT);
  }

  // Impersonate a current pause role holder on the real PauseManager
  const pauseManagerView = new ethers.Contract(PAUSE_MANAGER, PAUSE_MANAGER_ABI, ethers.provider);
  const pauserAddress = await pauseManagerView.getRoleMember(await pauseManagerView.OPS_ROLE(), 0);
  const pauser = await initMainnetUser(pauserAddress, parseUnits("10"));
  const pauseManager = pauseManagerView.connect(pauser);

  return { handler, eBrake, comptroller, pauseManager, acm, keeper, outsider, emodePoolId };
}

// ═══════════════════════════════════════════════════════════════════════════
// FORK TESTS
// ═══════════════════════════════════════════════════════════════════════════

if (FORK_MAINNET) {
  forking(FORK_BLOCK, () => {
    describe("BStockPauseHandler Fork Tests (BSC Mainnet)", () => {
      let handler: BStockPauseHandler;
      let eBrake: EBrake;
      let comptroller: Contract;
      let pauseManager: Contract;
      let acm: IAccessControlManagerV8;
      let keeper: SignerWithAddress;
      let outsider: SignerWithAddress;
      let emodePoolId: number;

      beforeEach(async () => {
        ({ handler, eBrake, comptroller, pauseManager, acm, keeper, outsider, emodePoolId } =
          await loadFixture(deployFixture));
      });

      // ═════════════════════════════════════════════════════════════════════
      // 1. SETUP
      // ═════════════════════════════════════════════════════════════════════

      describe("1. Setup", () => {
        it("should point at the live Core EBrake", async () => {
          expect(await handler.EBRAKE()).to.equal(EBRAKE);
          expect(await eBrake.IS_ISOLATED_POOL()).to.equal(false);
          expect(await eBrake.COMPTROLLER()).to.equal(ethers.utils.getAddress(COMPTROLLER));
        });

        it("should find the issuer's PauseManager behind every bStock", async () => {
          for (const { underlying } of BSTOCK_MARKETS) {
            const token = new ethers.Contract(underlying, BSTOCK_ABI, ethers.provider);
            expect(await token.pauseManager()).to.equal(PAUSE_MANAGER);
          }
        });

        it("should trust only the keeper", async () => {
          expect(await handler.trustedKeepers(keeper.address)).to.equal(true);
          expect(await handler.trustedKeepers(outsider.address)).to.equal(false);
        });

        it("should monitor exactly the four bStock markets", async () => {
          for (const { vToken } of BSTOCK_MARKETS) {
            expect(await handler.isMarketMonitored(vToken)).to.equal(true);
          }
          expect(await handler.isMarketMonitored(vUSDT)).to.equal(false);
        });

        it("should start with no bStock paused and the pinned core CF/LT, without an EBrake snapshot", async () => {
          expect(await pauseManager.allTokensPaused()).to.equal(false);
          for (const { vToken, underlying, cf, lt } of BSTOCK_MARKETS) {
            expect(await pauseManager.isTokenPaused(underlying)).to.equal(false);
            const core = await comptroller.poolMarkets(0, vToken);
            expect(core.isListed).to.equal(true);
            expect(core.collateralFactorMantissa).to.equal(cf);
            expect(core.liquidationThresholdMantissa).to.equal(lt);
            const snapshot = await eBrake.getMarketCFSnapshot(vToken, 0);
            expect(snapshot.cf).to.equal(0);
            expect(snapshot.lt).to.equal(0);
          }
        });

        it("should list vTSLAB and vNVDAB in the simulated e-mode pool only", async () => {
          expect(emodePoolId).to.equal(LAST_POOL_ID_AT_FORK + 1);
          for (const { vToken } of BSTOCK_MARKETS) {
            const expected = EMODE_MARKETS.includes(vToken) ? [0, emodePoolId] : [0];
            expect(listedPools(await readPoolStates(comptroller, vToken))).to.deep.equal(expected);
          }
          for (const market of EMODE_MARKETS) {
            const emode = await comptroller.poolMarkets(emodePoolId, market);
            expect(emode.collateralFactorMantissa).to.equal(EMODE_CF);
            expect(emode.liquidationThresholdMantissa).to.equal(EMODE_LT);
          }
        });
      });

      // ═════════════════════════════════════════════════════════════════════
      // 2. ACCESS CONTROL AND REGISTRATION
      // ═════════════════════════════════════════════════════════════════════

      describe("2. Access control and registration", () => {
        it("should reject setTrustedKeeper from an account without the ACM permission", async () => {
          await expect(handler.connect(outsider).setTrustedKeeper(outsider.address, true))
            .to.be.revertedWithCustomError(handler, "Unauthorized")
            .withArgs(outsider.address, handler.address, SET_TRUSTED_KEEPER);
          expect(await handler.trustedKeepers(outsider.address)).to.equal(false);
        });

        it("should reject setMarketMonitored from an account without the ACM permission", async () => {
          await expect(handler.connect(outsider).setMarketMonitored(vTSLAB, false))
            .to.be.revertedWithCustomError(handler, "Unauthorized")
            .withArgs(outsider.address, handler.address, SET_MARKET_MONITORED);
          expect(await handler.isMarketMonitored(vTSLAB)).to.equal(true);
        });

        it("should refuse to monitor a non-bStock market (USDT has no pauseManager())", async () => {
          await expect(handler.setMarketMonitored(vUSDT, true)).to.be.revertedWithoutReason();
          expect(await handler.isMarketMonitored(vUSDT)).to.equal(false);
        });

        it("should reject handlePause from a caller that is not a trusted keeper", async () => {
          const before = await readPoolStates(comptroller, vTSLAB);
          await pauseManager.pauseToken(TSLAB);
          await expect(handler.connect(outsider).handlePause(vTSLAB)).to.be.revertedWithCustomError(
            handler,
            "UnauthorizedKeeper",
          );
          await expectUntouched(eBrake, comptroller, vTSLAB, before);
        });

        it("should reject handlePause from a keeper that was untrusted", async () => {
          await pauseManager.pauseToken(TSLAB);
          await expect(handler.setTrustedKeeper(keeper.address, false))
            .to.emit(handler, "TrustedKeeperUpdated")
            .withArgs(keeper.address, false);
          await expect(handler.connect(keeper).handlePause(vTSLAB)).to.be.revertedWithCustomError(
            handler,
            "UnauthorizedKeeper",
          );
        });

        it("should reject handlePause for a market that is not monitored, even while all tokens are paused", async () => {
          await pauseManager.pauseAllTokens();
          await expect(handler.connect(keeper).handlePause(vUSDT))
            .to.be.revertedWithCustomError(handler, "MarketNotMonitored")
            .withArgs(vUSDT);
        });

        it("should reject handlePause for a market removed from monitoring while its token is paused", async () => {
          const before = await readPoolStates(comptroller, vTSLAB);
          await pauseManager.pauseToken(TSLAB);
          await expect(handler.setMarketMonitored(vTSLAB, false))
            .to.emit(handler, "MarketMonitoringUpdated")
            .withArgs(vTSLAB, false);
          await expect(handler.connect(keeper).handlePause(vTSLAB))
            .to.be.revertedWithCustomError(handler, "MarketNotMonitored")
            .withArgs(vTSLAB);
          await expectUntouched(eBrake, comptroller, vTSLAB, before);
        });

        it("should revert with EBrake's Unauthorized when the handler lacks the decreaseCF permission", async () => {
          const before = await readPoolStates(comptroller, vTSLAB);
          await acm.revokeCallPermission(EBRAKE, DECREASE_CF, handler.address);
          await pauseManager.pauseToken(TSLAB);
          await expect(handler.connect(keeper).handlePause(vTSLAB))
            .to.be.revertedWithCustomError(eBrake, "Unauthorized")
            .withArgs(handler.address, EBRAKE, DECREASE_CF);
          await expectUntouched(eBrake, comptroller, vTSLAB, before);
        });
      });

      // ═════════════════════════════════════════════════════════════════════
      // 3. TOKEN NOT PAUSED
      // ═════════════════════════════════════════════════════════════════════

      describe("3. Token not paused", () => {
        it("should revert handlePause with TokenNotPaused for every bStock market and change nothing", async () => {
          for (const { vToken, underlying } of BSTOCK_MARKETS) {
            const before = await readPoolStates(comptroller, vToken);
            await expect(handler.connect(keeper).handlePause(vToken))
              .to.be.revertedWithCustomError(handler, "TokenNotPaused")
              .withArgs(vToken, underlying);
            await expectUntouched(eBrake, comptroller, vToken, before);
          }
        });
      });

      // ═════════════════════════════════════════════════════════════════════
      // 4. ONE TOKEN PAUSED
      // ═════════════════════════════════════════════════════════════════════

      describe("4. One bStock paused (pauseToken)", () => {
        it("should block TSLAB transfers with TokenPaused while paused (premise of the handler)", async () => {
          const holder = await initMainnetUser(TSLAB_HOLDER, parseUnits("1"));
          const tslab = new ethers.Contract(TSLAB, BSTOCK_ABI, holder);
          await pauseManager.pauseToken(TSLAB);
          await expect(tslab.transfer(keeper.address, 1)).to.be.revertedWithCustomError(tslab, "TokenPaused");
        });

        it("should zero CF in the core pool and the e-mode pool only, keep LT and snapshot CF/LT", async () => {
          const before = await readPoolStates(comptroller, vTSLAB);
          expect(listedPools(before)).to.deep.equal([0, emodePoolId]);

          await pauseManager.pauseToken(TSLAB);
          const tx = handler.connect(keeper).handlePause(vTSLAB);

          expect(await cfDecreases(eBrake, tx)).to.deep.equal([
            [handler.address, vTSLAB, 0, 0],
            [handler.address, vTSLAB, emodePoolId, 0],
          ]);
          await expect(tx).to.emit(handler, "PauseBrakeApplied").withArgs(vTSLAB, TSLAB, keeper.address, PAUSE_MANAGER);
          expect(await handlerEvents(handler, tx)).to.deep.equal(["PauseBrakeApplied"]);
          await expectCFZeroed(eBrake, comptroller, vTSLAB, before);

          const core = await eBrake.getMarketCFSnapshot(vTSLAB, 0);
          expect([core.cf, core.lt]).to.deep.equal([TSLAB_MARKET.cf, TSLAB_MARKET.lt]);
          const emode = await eBrake.getMarketCFSnapshot(vTSLAB, emodePoolId);
          expect([emode.cf, emode.lt]).to.deep.equal([EMODE_CF, EMODE_LT]);
        });

        it("should leave the other bStock markets untouched", async () => {
          const others = BSTOCK_MARKETS.filter(m => m.vToken !== vTSLAB);
          const before = await Promise.all(others.map(m => readPoolStates(comptroller, m.vToken)));

          await pauseManager.pauseToken(TSLAB);
          await handler.connect(keeper).handlePause(vTSLAB);

          for (const [i, { vToken, underlying }] of others.entries()) {
            await expectUntouched(eBrake, comptroller, vToken, before[i]);
            await expect(handler.connect(keeper).handlePause(vToken))
              .to.be.revertedWithCustomError(handler, "TokenNotPaused")
              .withArgs(vToken, underlying);
          }
        });

        it("should make a second call a no-op in EBrake while still emitting PauseBrakeApplied", async () => {
          const before = await readPoolStates(comptroller, vTSLAB);
          await pauseManager.pauseToken(TSLAB);
          await handler.connect(keeper).handlePause(vTSLAB);
          const afterFirst = await readPoolStates(comptroller, vTSLAB);

          const tx = handler.connect(keeper).handlePause(vTSLAB);
          expect(await cfDecreases(eBrake, tx)).to.deep.equal([]);
          expect(await handlerEvents(handler, tx)).to.deep.equal(["PauseBrakeApplied"]);

          expect(await readPoolStates(comptroller, vTSLAB)).to.deep.equal(afterFirst);
          await expectCFZeroed(eBrake, comptroller, vTSLAB, before);
        });

        it("should revert again after unpauseToken, without restoring CF or touching the snapshot", async () => {
          const before = await readPoolStates(comptroller, vTSLAB);
          await pauseManager.pauseToken(TSLAB);
          await handler.connect(keeper).handlePause(vTSLAB);

          await pauseManager.unpauseToken(TSLAB);
          expect(await pauseManager.isTokenPaused(TSLAB)).to.equal(false);
          await expect(handler.connect(keeper).handlePause(vTSLAB))
            .to.be.revertedWithCustomError(handler, "TokenNotPaused")
            .withArgs(vTSLAB, TSLAB);

          // CF is restored by governance VIP from the EBrake snapshot, not by the handler
          await expectCFZeroed(eBrake, comptroller, vTSLAB, before);
        });
      });

      // ═════════════════════════════════════════════════════════════════════
      // 5. ALL TOKENS PAUSED
      // ═════════════════════════════════════════════════════════════════════

      describe("5. All tokens paused (pauseAllTokens)", () => {
        it("should let handlePause zero CF for all four bStock markets", async () => {
          const before = await Promise.all(BSTOCK_MARKETS.map(m => readPoolStates(comptroller, m.vToken)));

          await pauseManager.pauseAllTokens();

          for (const [i, { vToken, underlying }] of BSTOCK_MARKETS.entries()) {
            expect(await pauseManager.pausedTokens(underlying)).to.equal(false);
            expect(await pauseManager.isTokenPaused(underlying)).to.equal(true);

            const tx = handler.connect(keeper).handlePause(vToken);
            await expect(tx)
              .to.emit(handler, "PauseBrakeApplied")
              .withArgs(vToken, underlying, keeper.address, PAUSE_MANAGER);
            expect(await cfDecreases(eBrake, tx)).to.deep.equal(
              listedPools(before[i]).map(poolId => [handler.address, vToken, poolId, 0]),
            );
            await expectCFZeroed(eBrake, comptroller, vToken, before[i]);
          }
        });

        it("should revert again for all four after unpauseAllTokens", async () => {
          await pauseManager.pauseAllTokens();
          await pauseManager.unpauseAllTokens();

          for (const { vToken, underlying } of BSTOCK_MARKETS) {
            await expect(handler.connect(keeper).handlePause(vToken))
              .to.be.revertedWithCustomError(handler, "TokenNotPaused")
              .withArgs(vToken, underlying);
          }
        });
      });

      // ═════════════════════════════════════════════════════════════════════
      // 6. INTERPLAY WITH EBRAKE SNAPSHOTS AND GOVERNANCE RECOVERY
      // ═════════════════════════════════════════════════════════════════════

      describe("6. EBrake snapshots and governance recovery", () => {
        it("should skip a pool whose CF is already zero", async () => {
          await comptroller.setCollateralFactor(emodePoolId, vNVDAB, 0, EMODE_LT);
          await pauseManager.pauseToken(NVDAB);

          const tx = handler.connect(keeper).handlePause(vNVDAB);
          expect(await cfDecreases(eBrake, tx)).to.deep.equal([[handler.address, vNVDAB, 0, 0]]);

          const emode = await comptroller.poolMarkets(emodePoolId, vNVDAB);
          expect([emode.collateralFactorMantissa, emode.liquidationThresholdMantissa]).to.deep.equal([
            BigNumber.from(0),
            EMODE_LT,
          ]);
          const emodeSnapshot = await eBrake.getMarketCFSnapshot(vNVDAB, emodePoolId);
          expect([emodeSnapshot.cf, emodeSnapshot.lt]).to.deep.equal([BigNumber.from(0), BigNumber.from(0)]);
        });

        it("should keep an earlier EBrake snapshot (first write wins)", async () => {
          // An earlier EBrake caller lowered vSPCXB's CF, snapshotting the original value
          await acm.giveCallPermission(EBRAKE, DECREASE_CF, NORMAL_TIMELOCK);
          await eBrake[DECREASE_CF](vSPCXB, parseUnits("0.3", 18));
          expect((await comptroller.poolMarkets(0, vSPCXB)).collateralFactorMantissa).to.equal(parseUnits("0.3", 18));

          await pauseManager.pauseToken(SPCXB);
          const tx = handler.connect(keeper).handlePause(vSPCXB);
          expect(await cfDecreases(eBrake, tx)).to.deep.equal([[handler.address, vSPCXB, 0, 0]]);

          const core = await comptroller.poolMarkets(0, vSPCXB);
          expect([core.collateralFactorMantissa, core.liquidationThresholdMantissa]).to.deep.equal([
            BigNumber.from(0),
            SPCXB_MARKET.lt,
          ]);
          // The snapshot still holds the original CF, not the intermediate 0.3
          const snapshot = await eBrake.getMarketCFSnapshot(vSPCXB, 0);
          expect([snapshot.cf, snapshot.lt]).to.deep.equal([SPCXB_MARKET.cf, SPCXB_MARKET.lt]);
        });

        it("should brake again after a governance restore and snapshot reset", async () => {
          const original = await readPoolStates(comptroller, vTSLAB);
          const pools = listedPools(original);

          // First incident
          await pauseManager.pauseToken(TSLAB);
          await handler.connect(keeper).handlePause(vTSLAB);
          await pauseManager.unpauseToken(TSLAB);

          // Governance recovery: restore CF/LT from the snapshot, then clear it
          for (const poolId of pools) {
            const snapshot = await eBrake.getMarketCFSnapshot(vTSLAB, poolId);
            expect(await comptroller.callStatic.setCollateralFactor(poolId, vTSLAB, snapshot.cf, snapshot.lt)).to.equal(
              0,
            );
            await comptroller.setCollateralFactor(poolId, vTSLAB, snapshot.cf, snapshot.lt);
          }
          await acm.giveCallPermission(EBRAKE, RESET_CF_SNAPSHOT, NORMAL_TIMELOCK);
          await eBrake.resetCFSnapshot(vTSLAB);
          await expectUntouched(eBrake, comptroller, vTSLAB, original);
          await expect(handler.connect(keeper).handlePause(vTSLAB))
            .to.be.revertedWithCustomError(handler, "TokenNotPaused")
            .withArgs(vTSLAB, TSLAB);

          // Second incident brakes again and takes a fresh snapshot
          await pauseManager.pauseToken(TSLAB);
          const tx = handler.connect(keeper).handlePause(vTSLAB);
          expect(await cfDecreases(eBrake, tx)).to.deep.equal(
            pools.map(poolId => [handler.address, vTSLAB, poolId, 0]),
          );
          await expectCFZeroed(eBrake, comptroller, vTSLAB, original);
        });
      });

      // ═════════════════════════════════════════════════════════════════════
      // 7. BORROWING AGAINST bSTOCK COLLATERAL
      // ═════════════════════════════════════════════════════════════════════

      describe("7. Borrowing against bStock collateral", () => {
        it("should block new USDT borrows against TSLAB after CF is zeroed, without making the position liquidatable", async () => {
          const [, , borrower] = await ethers.getSigners();
          const supplyAmount = parseUnits("2", 18); // 2 TSLAB
          const borrowAmount = parseUnits("100", 18); // 100 USDT

          // Fund the borrower with TSLAB and supply it as collateral (before the pause, transfers still work)
          const holder = await initMainnetUser(TSLAB_HOLDER, parseUnits("1"));
          await new ethers.Contract(TSLAB, ERC20_ABI, holder).transfer(borrower.address, supplyAmount);
          await new ethers.Contract(TSLAB, ERC20_ABI, borrower).approve(vTSLAB, supplyAmount);
          const vTslab = new ethers.Contract(vTSLAB, VTOKEN_ABI, borrower);
          const vUsdt = new ethers.Contract(vUSDT, VTOKEN_ABI, borrower);
          await vTslab.mint(supplyAmount);
          await comptroller.connect(borrower).enterMarkets([vTSLAB]);
          await vUsdt.borrow(borrowAmount);
          expect(await new ethers.Contract(USDT, ERC20_ABI, borrower).balanceOf(borrower.address)).to.equal(
            borrowAmount,
          );

          // Exact expected values, computed the way the comptroller does
          const oracle = new ethers.Contract(await comptroller.oracle(), ORACLE_ABI, ethers.provider);
          const tslabPrice: BigNumber = await oracle.getUnderlyingPrice(vTSLAB);
          const usdtPrice: BigNumber = await oracle.getUnderlyingPrice(vUSDT);
          const exchangeRate: BigNumber = await vTslab.exchangeRateStored();
          const vTokenBalance: BigNumber = await vTslab.balanceOf(borrower.address);
          const borrowBalance: BigNumber = await vUsdt.borrowBalanceStored(borrower.address);
          const borrowValue = usdtPrice.mul(borrowBalance).div(MANTISSA_ONE);
          const cfValue = weightedCollateralValue(TSLAB_MARKET.cf, exchangeRate, tslabPrice, vTokenBalance);
          const ltValue = weightedCollateralValue(TSLAB_MARKET.lt, exchangeRate, tslabPrice, vTokenBalance);

          // Before the pause: CF-based borrowing power is the CF-weighted collateral minus the debt
          expect(await comptroller.getBorrowingPower(borrower.address)).to.deep.equal([
            BigNumber.from(0),
            cfValue.sub(borrowValue),
            BigNumber.from(0),
          ]);

          // Issuer pauses TSLAB, the keeper pulls the brake
          await pauseManager.pauseToken(TSLAB);
          await handler.connect(keeper).handlePause(vTSLAB);

          // CF-based borrowing power is gone: the whole debt is a CF shortfall, so any further borrow is rejected
          expect(await comptroller.getBorrowingPower(borrower.address)).to.deep.equal([
            BigNumber.from(0),
            BigNumber.from(0),
            borrowValue,
          ]);
          await expect(vUsdt.borrow(parseUnits("1", 18))).to.be.revertedWith("math error");
          expect(await vUsdt.borrowBalanceStored(borrower.address)).to.equal(borrowBalance);

          // LT is unchanged, so the existing position keeps exactly its LT-based liquidity and is not liquidatable
          expect(await comptroller.getAccountLiquidity(borrower.address)).to.deep.equal([
            BigNumber.from(0),
            ltValue.sub(borrowValue),
            BigNumber.from(0),
          ]);
        });
      });

      // ═════════════════════════════════════════════════════════════════════
      // 8. TOKEN REPOINTED TO ANOTHER PAUSEMANAGER
      // ═════════════════════════════════════════════════════════════════════

      describe("8. Token repointed to another PauseManager (setPauseManager)", () => {
        let newPauseManager: FakeContract<IPauseManager>;

        beforeEach(async () => {
          // The issuer's token admin points TSLAB at a fresh PauseManager
          newPauseManager = await smock.fake<IPauseManager>("contracts/Interfaces/IPauseManager.sol:IPauseManager");
          newPauseManager.isTokenPaused.returns(false);
          const tokenView = new ethers.Contract(TSLAB, BSTOCK_ABI, ethers.provider);
          const adminAddress = await tokenView.getRoleMember(await tokenView.DEFAULT_ADMIN_ROLE(), 0);
          const admin = await initMainnetUser(adminAddress, parseUnits("1"));
          await tokenView.connect(admin).setPauseManager(newPauseManager.address);
          expect(await tokenView.pauseManager()).to.equal(newPauseManager.address);
        });

        it("should zero CF when the new PauseManager pauses the token", async () => {
          const before = await readPoolStates(comptroller, vTSLAB);
          newPauseManager.isTokenPaused.whenCalledWith(TSLAB).returns(true);

          // The token itself now enforces the new PauseManager
          const holder = await initMainnetUser(TSLAB_HOLDER, parseUnits("1"));
          const tslab = new ethers.Contract(TSLAB, BSTOCK_ABI, holder);
          await expect(tslab.transfer(keeper.address, 1)).to.be.revertedWithCustomError(tslab, "TokenPaused");

          const tx = handler.connect(keeper).handlePause(vTSLAB);
          await expect(tx)
            .to.emit(handler, "PauseBrakeApplied")
            .withArgs(vTSLAB, TSLAB, keeper.address, newPauseManager.address);
          expect(await cfDecreases(eBrake, tx)).to.deep.equal(
            listedPools(before).map(poolId => [handler.address, vTSLAB, poolId, 0]),
          );
          await expectCFZeroed(eBrake, comptroller, vTSLAB, before);
        });

        it("should ignore a pause on the old PauseManager, which no longer blocks transfers", async () => {
          const before = await readPoolStates(comptroller, vTSLAB);
          await pauseManager.pauseToken(TSLAB);
          expect(await pauseManager.isTokenPaused(TSLAB)).to.equal(true);

          // Transfers still work: the token no longer checks the old PauseManager
          const holder = await initMainnetUser(TSLAB_HOLDER, parseUnits("1"));
          const tslab = new ethers.Contract(TSLAB, BSTOCK_ABI, holder);
          const balanceBefore: BigNumber = await tslab.balanceOf(keeper.address);
          await tslab.transfer(keeper.address, 1);
          expect(await tslab.balanceOf(keeper.address)).to.equal(balanceBefore.add(1));

          await expect(handler.connect(keeper).handlePause(vTSLAB))
            .to.be.revertedWithCustomError(handler, "TokenNotPaused")
            .withArgs(vTSLAB, TSLAB);
          await expectUntouched(eBrake, comptroller, vTSLAB, before);
        });
      });
    });
  });
}
