import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { BigNumber, Contract } from "ethers";
import { ethers } from "hardhat";

import bscmainnetAddresses from "../../../deployments/bscmainnet_addresses.json";
import { forking, initMainnetUser } from "./utils";

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

// Deployed contract addresses from deployments/bscmainnet_addresses.json
const { addresses } = bscmainnetAddresses;
const DEVIATION_SENTINEL = addresses.DeviationSentinel;
const SENTINEL_ORACLE = addresses.SentinelOracle;
const UNISWAP_ORACLE = addresses.UniswapOracle;
const PANCAKESWAP_ORACLE = addresses.PancakeSwapOracle;

// Core protocol addresses (BSC Mainnet)
const COMPTROLLER = "0xfd36e2c2a6789db23113685031d7f16329158384";
const NORMAL_TIMELOCK = "0x939bD8d64c0A9583A7Dcea9933f7b21697ab6396";
const ACM = "0x4788629abc6cfca10f9f969efdeaa1cf70c23555";
const RESILIENT_ORACLE = "0x6592b5DE802159F3E74B2486b091D11a8256ab8A";

// Token addresses
const BTCB = "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c";
const CAKE = "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82";

// vToken addresses - use vBTCB instead of vBNB (vBNB has no ERC20 underlying)
const vBTCB = "0x882C173bC7Ff3b7786CA16dfeD3DFFfb9Ee7847B";

// DEX pools for PancakeSwap
const CAKE_PCS_POOL = "0x7f51c8AaA6B0599aBd16674e2b17FEc7a9f674A1";

// VIP-900 permission accounts
const GUARDIAN = "0x1C2CAc6ec528c20800B2fe734820D87b581eAA6B";
const FAST_TRACK_TIMELOCK = "0x555ba73dB1b006F3f2C7dB7126d6e4343aDBce02";
const CRITICAL_TIMELOCK = "0x213c446ec11e45b15a6E29C1C1b402B8897f606d";
const KEEPER_ADDRESS = "0x57fa23f591203f61cef84a7bc892df69ca95c86e";

// Comptroller action enum (Venus V2)
const Action = {
  MINT: 0,
  REDEEM: 1,
  BORROW: 2,
  REPAY: 3,
  SEIZE: 4,
  LIQUIDATE: 5,
  TRANSFER: 6,
  ENTER_MARKET: 7,
  EXIT_MARKET: 8,
};

const FORK_MAINNET = process.env.FORKED_NETWORK === "bscmainnet";

// ═══════════════════════════════════════════════════════════════════════════
// ABIs
// ═══════════════════════════════════════════════════════════════════════════

const DEVIATION_SENTINEL_ABI = [
  "function EBRAKE() view returns (address)",
  "function RESILIENT_ORACLE() view returns (address)",
  "function SENTINEL_ORACLE() view returns (address)",
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function acceptOwnership()",
  "function trustedKeepers(address) view returns (bool)",
  "function tokenConfigs(address) view returns (uint8 deviation, bool enabled)",
  "function checkPriceDeviation(address vToken) view returns (bool hasDeviation, uint256 oraclePrice, uint256 sentinelPrice, uint256 deviationPercent)",
  "function handleDeviation(address vToken)",
  "function setTrustedKeeper(address keeper, bool trusted)",
  "function setTokenConfig(address token, tuple(uint8 deviation, bool enabled) config)",
  "function setTokenMonitoringEnabled(address token, bool enabled)",
  "event SupplyPaused(address indexed vToken)",
  "event BorrowPaused(address indexed vToken)",
  "event TrustedKeeperUpdated(address indexed keeper, bool trusted)",
  "event TokenMonitoringStatusChanged(address indexed token, bool enabled)",
];

const SENTINEL_ORACLE_ABI = [
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function acceptOwnership()",
  "function getPrice(address token) view returns (uint256)",
  "function tokenConfigs(address) view returns (address)",
  "function setTokenOracleConfig(address token, address oracle)",
  "function setDirectPrice(address token, uint256 price)",
];

const DEX_ORACLE_ABI = [
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function acceptOwnership()",
  "function tokenPools(address) view returns (address)",
  "function setPoolConfig(address token, address pool)",
];

const ACM_ABI = [
  "function giveCallPermission(address contractAddress, string calldata functionSig, address accountToPermit)",
  "function isAllowedToCall(address account, string calldata functionSig) view returns (bool)",
];

const RESILIENT_ORACLE_ABI = ["function getPrice(address token) view returns (uint256)"];

// ChainlinkOracle ABI for extending staleness period
const CHAINLINK_ORACLE = "0x1B2103441A0A108daD8848D8F5d790e4D402921F";
const CHAINLINK_ORACLE_ABI = [
  "function tokenConfigs(address) view returns (address asset, address feed, uint256 maxStalePeriod)",
  "function setTokenConfig(tuple(address asset, address feed, uint256 maxStalePeriod) tokenConfig)",
];

// Venus V2 Comptroller ABI (BSC Mainnet)
const COMPTROLLER_ABI = [
  "function markets(address vToken) view returns (bool isListed, uint256 collateralFactorMantissa, bool isVenus)",
  "function actionPaused(address vToken, uint8 action) view returns (bool)",
  "function _setActionsPaused(address[] calldata vTokens, uint8[] calldata actions, bool paused)",
];

// ═══════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

// Proxy admin address (from DeviationSentinel_Proxy deployment args)
const PROXY_ADMIN = "0x6beb6D2695B67FEb73ad4f172E8E2975497187e4";

/**
 * Deploy EBrake and upgrade DeviationSentinel proxy to new implementation.
 * Grants all required ACM permissions for the new EBrake-integrated flow.
 */
async function deployEBrakeAndUpgradeSentinel(timelock: SignerWithAddress): Promise<{ eBrake: Contract }> {
  const acm = new ethers.Contract(ACM, ACM_ABI, timelock);

  // Deploy EBrake behind proxy (BSC = Diamond comptroller, so isIsolatedPool = false)
  const EBrakeFactory = await ethers.getContractFactory("EBrake");
  const eBrakeImpl = await EBrakeFactory.deploy(COMPTROLLER, false);

  const ProxyFactory = await ethers.getContractFactory(
    "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol:TransparentUpgradeableProxy",
  );
  const initData = eBrakeImpl.interface.encodeFunctionData("initialize", [ACM]);
  const proxy = await ProxyFactory.deploy(eBrakeImpl.address, timelock.address, initData);
  const eBrake = EBrakeFactory.attach(proxy.address);

  // Grant EBrake permissions on comptroller
  await acm.giveCallPermission(
    ethers.constants.AddressZero,
    "_setActionsPaused(address[],uint8[],bool)",
    eBrake.address,
  );
  await acm.giveCallPermission(
    ethers.constants.AddressZero,
    "setCollateralFactor(uint96,address,uint256,uint256)",
    eBrake.address,
  );

  // Grant DeviationSentinel permissions on EBrake
  await acm.giveCallPermission(eBrake.address, "pauseBorrow(address)", DEVIATION_SENTINEL);
  await acm.giveCallPermission(eBrake.address, "pauseSupply(address)", DEVIATION_SENTINEL);
  await acm.giveCallPermission(eBrake.address, "setCFZero(address)", DEVIATION_SENTINEL);

  // Deploy new DeviationSentinel implementation with EBrake
  const SentinelFactory = await ethers.getContractFactory("DeviationSentinel");
  const newImpl = await SentinelFactory.deploy(eBrake.address, RESILIENT_ORACLE, addresses.SentinelOracle);

  // Upgrade proxy via ProxyAdmin contract (owned by timelock)
  const proxyAdminContract = new ethers.Contract(
    PROXY_ADMIN,
    ["function upgrade(address proxy, address implementation)"],
    timelock,
  );
  await proxyAdminContract.upgrade(DEVIATION_SENTINEL, newImpl.address);

  console.log("EBrake deployed at:", eBrake.address);
  console.log("DeviationSentinel upgraded to new implementation:", newImpl.address);

  return { eBrake };
}

/**
 * Execute VIP-900 commands by impersonating the timelock.
 * Sets up admin permissions, keepers, and oracle configs.
 * Note: resetMarketState permission removed — function no longer exists.
 */
async function executeVip900(timelock: SignerWithAddress): Promise<void> {
  const acm = new ethers.Contract(ACM, ACM_ABI, timelock);
  const deviationSentinel = new ethers.Contract(DEVIATION_SENTINEL, DEVIATION_SENTINEL_ABI, timelock);
  const sentinelOracle = new ethers.Contract(SENTINEL_ORACLE, SENTINEL_ORACLE_ABI, timelock);
  const pancakeSwapOracle = new ethers.Contract(PANCAKESWAP_ORACLE, DEX_ORACLE_ABI, timelock);

  console.log("Executing VIP-900...");

  // Accept ownership of all contracts
  for (const addr of [DEVIATION_SENTINEL, SENTINEL_ORACLE, UNISWAP_ORACLE, PANCAKESWAP_ORACLE]) {
    const contract = new ethers.Contract(addr, ["function acceptOwnership()"], timelock);
    await contract.acceptOwnership();
  }

  // Grant permissions for DeviationSentinel admin functions
  const permissionAccounts = [GUARDIAN, NORMAL_TIMELOCK, FAST_TRACK_TIMELOCK, CRITICAL_TIMELOCK];
  for (const account of permissionAccounts) {
    await acm.giveCallPermission(DEVIATION_SENTINEL, "setTokenConfig(address,(uint8,bool))", account);
    await acm.giveCallPermission(DEVIATION_SENTINEL, "setTrustedKeeper(address,bool)", account);
    await acm.giveCallPermission(DEVIATION_SENTINEL, "setTokenMonitoringEnabled(address,bool)", account);
  }

  // Whitelist keepers
  for (const keeper of [KEEPER_ADDRESS, GUARDIAN, ...permissionAccounts]) {
    await deviationSentinel.setTrustedKeeper(keeper, true);
  }

  // Grant permissions for SentinelOracle
  for (const account of permissionAccounts) {
    await acm.giveCallPermission(SENTINEL_ORACLE, "setTokenOracleConfig(address,address)", account);
    await acm.giveCallPermission(SENTINEL_ORACLE, "setDirectPrice(address,uint256)", account);
  }

  // Grant permissions for DEX oracles
  for (const account of permissionAccounts) {
    await acm.giveCallPermission(UNISWAP_ORACLE, "setPoolConfig(address,address)", account);
    await acm.giveCallPermission(PANCAKESWAP_ORACLE, "setPoolConfig(address,address)", account);
  }

  // Configure CAKE token
  await pancakeSwapOracle.setPoolConfig(CAKE, CAKE_PCS_POOL);
  await deviationSentinel.setTokenConfig(CAKE, { deviation: 20, enabled: true });
  await sentinelOracle.setTokenOracleConfig(CAKE, PANCAKESWAP_ORACLE);

  console.log("VIP-900 executed successfully");
}

// Cached oracle price - fetched once at setup to avoid staleness issues
let CACHED_BTCB_PRICE: BigNumber;

/**
 * Set sentinel price to match cached oracle price (no deviation)
 */
async function setSentinelPriceNoDeviation(sentinelOracle: Contract): Promise<BigNumber> {
  await sentinelOracle.setDirectPrice(BTCB, CACHED_BTCB_PRICE);
  return CACHED_BTCB_PRICE;
}

/**
 * Set sentinel price lower than oracle (triggers supply pause + CF zero)
 */
async function setSentinelPriceLower(
  sentinelOracle: Contract,
  deviationPercent: number = 50,
): Promise<{ oraclePrice: BigNumber; sentinelPrice: BigNumber }> {
  const sentinelPrice = CACHED_BTCB_PRICE.mul(100 - deviationPercent).div(100);
  await sentinelOracle.setDirectPrice(BTCB, sentinelPrice);
  return { oraclePrice: CACHED_BTCB_PRICE, sentinelPrice };
}

/**
 * Set sentinel price higher than oracle (triggers borrow pause)
 */
async function setSentinelPriceHigher(
  sentinelOracle: Contract,
  deviationPercent: number = 50,
): Promise<{ oraclePrice: BigNumber; sentinelPrice: BigNumber }> {
  const sentinelPrice = CACHED_BTCB_PRICE.mul(100 + deviationPercent).div(100);
  await sentinelOracle.setDirectPrice(BTCB, sentinelPrice);
  return { oraclePrice: CACHED_BTCB_PRICE, sentinelPrice };
}

/**
 * Helper to reset test state to a clean baseline.
 * Sets sentinel price to match oracle and manually unpauses comptroller.
 */
async function resetToCleanState(sentinelOracle: Contract, coreComptroller: Contract): Promise<void> {
  await setSentinelPriceNoDeviation(sentinelOracle);

  // Manually unpause comptroller actions (sentinel can't do this)
  try {
    await coreComptroller._setActionsPaused([vBTCB], [Action.MINT], false);
    await coreComptroller._setActionsPaused([vBTCB], [Action.BORROW], false);
  } catch {
    // May fail if already unpaused, ignore
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// FORK TESTS
// ═══════════════════════════════════════════════════════════════════════════

if (FORK_MAINNET) {
  // Fork at block after contracts are deployed but before VIP is executed
  const FORK_BLOCK = 78835203;

  forking(FORK_BLOCK, () => {
    let timelock: SignerWithAddress;
    let deviationSentinel: Contract;
    let sentinelOracle: Contract;
    let _uniswapOracle: Contract;
    let coreComptroller: Contract;
    let resilientOracle: Contract;
    let eBrake: Contract;

    describe("DeviationSentinel Fork Tests (BSC Mainnet)", () => {
      before(async () => {
        // Initialize timelock signer
        timelock = await initMainnetUser(NORMAL_TIMELOCK, ethers.utils.parseUnits("10"));

        // Connect to deployed contracts
        sentinelOracle = new ethers.Contract(SENTINEL_ORACLE, SENTINEL_ORACLE_ABI, timelock);
        _uniswapOracle = new ethers.Contract(UNISWAP_ORACLE, DEX_ORACLE_ABI, timelock);
        coreComptroller = new ethers.Contract(COMPTROLLER, COMPTROLLER_ABI, timelock);
        resilientOracle = new ethers.Contract(RESILIENT_ORACLE, RESILIENT_ORACLE_ABI, timelock);

        // Execute VIP-900 (sets up admin permissions, keepers, oracle configs)
        await executeVip900(timelock);

        // Deploy EBrake and upgrade DeviationSentinel proxy to new implementation
        const deployed = await deployEBrakeAndUpgradeSentinel(timelock);
        eBrake = deployed.eBrake;

        // Connect to the upgraded DeviationSentinel (same proxy address, new ABI)
        deviationSentinel = new ethers.Contract(DEVIATION_SENTINEL, DEVIATION_SENTINEL_ABI, timelock);

        // Extend ChainlinkOracle staleness period for BTCB
        const chainlinkOracle = new ethers.Contract(CHAINLINK_ORACLE, CHAINLINK_ORACLE_ABI, timelock);
        const btcbConfig = await chainlinkOracle.tokenConfigs(BTCB);
        await chainlinkOracle.setTokenConfig({
          asset: BTCB,
          feed: btcbConfig.feed,
          maxStalePeriod: 30 * 24 * 60 * 60,
        });

        // Configure BTCB for testing
        CACHED_BTCB_PRICE = await resilientOracle.getPrice(BTCB);
        console.log("BTCB ResilientOracle price (cached):", CACHED_BTCB_PRICE.toString());
        await sentinelOracle.setDirectPrice(BTCB, CACHED_BTCB_PRICE);
        await deviationSentinel.setTokenConfig(BTCB, { deviation: 10, enabled: true });
      });

      // ═════════════════════════════════════════════════════════════════════
      // 1. CONTRACT VERIFICATION
      // ═════════════════════════════════════════════════════════════════════

      describe("1. Contract Verification", () => {
        it("should have correct immutable addresses", async () => {
          expect((await deviationSentinel.EBRAKE()).toLowerCase()).to.equal(eBrake.address.toLowerCase());
          expect((await deviationSentinel.RESILIENT_ORACLE()).toLowerCase()).to.equal(RESILIENT_ORACLE.toLowerCase());
          expect((await deviationSentinel.SENTINEL_ORACLE()).toLowerCase()).to.equal(SENTINEL_ORACLE.toLowerCase());
        });

        it("should have Normal Timelock as owner after VIP", async () => {
          expect(await deviationSentinel.owner()).to.equal(NORMAL_TIMELOCK);
          expect(await sentinelOracle.owner()).to.equal(NORMAL_TIMELOCK);
        });

        it("should have trusted keepers whitelisted", async () => {
          expect(await deviationSentinel.trustedKeepers(NORMAL_TIMELOCK)).to.be.true;
          expect(await deviationSentinel.trustedKeepers(KEEPER_ADDRESS)).to.be.true;
          expect(await deviationSentinel.trustedKeepers(GUARDIAN)).to.be.true;
        });

        it("should have BTCB token configured with 10% deviation threshold", async () => {
          const config = await deviationSentinel.tokenConfigs(BTCB);
          expect(config.deviation).to.equal(10);
          expect(config.enabled).to.be.true;
        });
      });

      // ═════════════════════════════════════════════════════════════════════
      // 2. checkPriceDeviation VIEW FUNCTION
      // ═════════════════════════════════════════════════════════════════════

      describe("2. checkPriceDeviation", () => {
        before(async () => {
          await setSentinelPriceNoDeviation(sentinelOracle);
        });

        it("should return hasDeviation=false when prices are within threshold", async () => {
          const result = await deviationSentinel.checkPriceDeviation(vBTCB);
          expect(result.hasDeviation).to.be.false;
          expect(result.oraclePrice).to.be.gt(0);
          expect(result.sentinelPrice).to.be.gt(0);
        });

        it("should return hasDeviation=true when sentinel price is lower", async () => {
          const { oraclePrice } = await setSentinelPriceLower(sentinelOracle, 50);
          const result = await deviationSentinel.checkPriceDeviation(vBTCB);
          expect(result.hasDeviation).to.be.true;
          expect(result.sentinelPrice).to.be.lt(result.oraclePrice);
          await sentinelOracle.setDirectPrice(BTCB, oraclePrice);
        });

        it("should return hasDeviation=true when sentinel price is higher", async () => {
          const { oraclePrice } = await setSentinelPriceHigher(sentinelOracle, 50);
          const result = await deviationSentinel.checkPriceDeviation(vBTCB);
          expect(result.hasDeviation).to.be.true;
          expect(result.sentinelPrice).to.be.gt(result.oraclePrice);
          await sentinelOracle.setDirectPrice(BTCB, oraclePrice);
        });
      });

      // ═════════════════════════════════════════════════════════════════════
      // 3. handleDeviation — SENTINEL LOWER (Supply Pause + CF Zero)
      // ═════════════════════════════════════════════════════════════════════

      describe("3. handleDeviation — Sentinel Lower (Supply Pause)", () => {
        before(async () => {
          await resetToCleanState(sentinelOracle, coreComptroller);
        });

        it("should pause supply when sentinel price is lower", async () => {
          await setSentinelPriceLower(sentinelOracle, 50);

          await expect(deviationSentinel.handleDeviation(vBTCB))
            .to.emit(deviationSentinel, "SupplyPaused")
            .withArgs(vBTCB);

          expect(await coreComptroller.actionPaused(vBTCB, Action.MINT)).to.be.true;
        });

        it("should NOT auto-unpause when deviation resolves (pause-only)", async () => {
          await setSentinelPriceNoDeviation(sentinelOracle);

          const tx = deviationSentinel.handleDeviation(vBTCB);
          await expect(tx).to.not.emit(deviationSentinel, "SupplyPaused");

          // Comptroller remains paused — recovery is via governance VIP
          expect(await coreComptroller.actionPaused(vBTCB, Action.MINT)).to.be.true;
        });
      });

      // ═════════════════════════════════════════════════════════════════════
      // 4. handleDeviation — SENTINEL HIGHER (Borrow Pause)
      // ═════════════════════════════════════════════════════════════════════

      describe("4. handleDeviation — Sentinel Higher (Borrow Pause)", () => {
        before(async () => {
          await resetToCleanState(sentinelOracle, coreComptroller);
        });

        it("should pause borrow when sentinel price is higher", async () => {
          await setSentinelPriceHigher(sentinelOracle, 50);

          await expect(deviationSentinel.handleDeviation(vBTCB))
            .to.emit(deviationSentinel, "BorrowPaused")
            .withArgs(vBTCB);

          expect(await coreComptroller.actionPaused(vBTCB, Action.BORROW)).to.be.true;
        });

        it("should NOT auto-unpause when deviation resolves (pause-only)", async () => {
          await setSentinelPriceNoDeviation(sentinelOracle);

          const tx = deviationSentinel.handleDeviation(vBTCB);
          await expect(tx).to.not.emit(deviationSentinel, "BorrowPaused");

          // Comptroller remains paused
          expect(await coreComptroller.actionPaused(vBTCB, Action.BORROW)).to.be.true;
        });
      });

      // ═════════════════════════════════════════════════════════════════════
      // 5. GOVERNANCE RECOVERY PROCEDURE
      //
      // Since sentinel no longer auto-unpauses, governance must:
      // 1. Unpause supply/borrow on the comptroller manually
      // 2. (Restore CF via VIP if needed)
      // No resetMarketState needed — sentinel has no internal state to clear.
      // ═════════════════════════════════════════════════════════════════════

      describe("5. Governance Recovery Procedure", () => {
        before(async () => {
          await resetToCleanState(sentinelOracle, coreComptroller);
        });

        it("should correctly recover: governance unpauses, sentinel can re-pause on new deviation", async () => {
          // SETUP: Trigger supply pause
          await setSentinelPriceLower(sentinelOracle, 50);
          await deviationSentinel.handleDeviation(vBTCB);
          expect(await coreComptroller.actionPaused(vBTCB, Action.MINT)).to.be.true;

          // STEP 1: Governance unpauses manually
          await coreComptroller._setActionsPaused([vBTCB], [Action.MINT], false);
          expect(await coreComptroller.actionPaused(vBTCB, Action.MINT)).to.be.false;

          // STEP 2: Deviation resolved — no action
          await setSentinelPriceNoDeviation(sentinelOracle);
          const tx = deviationSentinel.handleDeviation(vBTCB);
          await expect(tx).to.not.emit(deviationSentinel, "SupplyPaused");

          // STEP 3: New deviation hits — sentinel re-pauses (no stale state issue)
          await setSentinelPriceLower(sentinelOracle, 50);
          await expect(deviationSentinel.handleDeviation(vBTCB))
            .to.emit(deviationSentinel, "SupplyPaused")
            .withArgs(vBTCB);

          // Cleanup
          await resetToCleanState(sentinelOracle, coreComptroller);
        });

        it("should correctly recover borrow pause via governance", async () => {
          // SETUP: Trigger borrow pause
          await setSentinelPriceHigher(sentinelOracle, 50);
          await deviationSentinel.handleDeviation(vBTCB);
          expect(await coreComptroller.actionPaused(vBTCB, Action.BORROW)).to.be.true;

          // Governance unpauses
          await coreComptroller._setActionsPaused([vBTCB], [Action.BORROW], false);

          // Deviation resolved — no action
          await setSentinelPriceNoDeviation(sentinelOracle);
          const tx = deviationSentinel.handleDeviation(vBTCB);
          await expect(tx).to.not.emit(deviationSentinel, "BorrowPaused");
          expect(await coreComptroller.actionPaused(vBTCB, Action.BORROW)).to.be.false;
        });
      });

      // ═════════════════════════════════════════════════════════════════════
      // 6. setTokenMonitoringEnabled
      // ═════════════════════════════════════════════════════════════════════

      describe("6. setTokenMonitoringEnabled", () => {
        before(async () => {
          await resetToCleanState(sentinelOracle, coreComptroller);
        });

        it("should disable monitoring and block handleDeviation", async () => {
          await deviationSentinel.setTokenMonitoringEnabled(BTCB, false);
          expect((await deviationSentinel.tokenConfigs(BTCB)).enabled).to.be.false;

          await setSentinelPriceLower(sentinelOracle, 50);
          await expect(deviationSentinel.handleDeviation(vBTCB)).to.be.reverted;
        });

        it("should re-enable monitoring and allow handleDeviation", async () => {
          await deviationSentinel.setTokenMonitoringEnabled(BTCB, true);
          expect((await deviationSentinel.tokenConfigs(BTCB)).enabled).to.be.true;

          await expect(deviationSentinel.handleDeviation(vBTCB))
            .to.emit(deviationSentinel, "SupplyPaused")
            .withArgs(vBTCB);

          // Cleanup
          await resetToCleanState(sentinelOracle, coreComptroller);
        });

        it("should emit TokenMonitoringStatusChanged event", async () => {
          await expect(deviationSentinel.setTokenMonitoringEnabled(BTCB, false))
            .to.emit(deviationSentinel, "TokenMonitoringStatusChanged")
            .withArgs(BTCB, false);

          await deviationSentinel.setTokenMonitoringEnabled(BTCB, true);
        });
      });

      // ═════════════════════════════════════════════════════════════════════
      // 7. SENTINEL ORACLE DIRECT PRICE CONTROL
      // ═════════════════════════════════════════════════════════════════════

      describe("7. SentinelOracle Direct Price Control", () => {
        before(async () => {
          await resetToCleanState(sentinelOracle, coreComptroller);
        });

        it("should detect deviation via direct price override (sentinel higher)", async () => {
          await setSentinelPriceHigher(sentinelOracle, 50);

          const result = await deviationSentinel.checkPriceDeviation(vBTCB);
          expect(result.hasDeviation).to.be.true;
          expect(result.sentinelPrice).to.be.gt(result.oraclePrice);

          await expect(deviationSentinel.handleDeviation(vBTCB))
            .to.emit(deviationSentinel, "BorrowPaused")
            .withArgs(vBTCB);
        });

        it("should detect deviation via direct price override (sentinel lower)", async () => {
          // Reset from previous test
          await resetToCleanState(sentinelOracle, coreComptroller);

          await setSentinelPriceLower(sentinelOracle, 50);

          const result = await deviationSentinel.checkPriceDeviation(vBTCB);
          expect(result.hasDeviation).to.be.true;
          expect(result.sentinelPrice).to.be.lt(result.oraclePrice);

          await expect(deviationSentinel.handleDeviation(vBTCB))
            .to.emit(deviationSentinel, "SupplyPaused")
            .withArgs(vBTCB);

          // Cleanup
          await resetToCleanState(sentinelOracle, coreComptroller);
        });
      });

      // ═════════════════════════════════════════════════════════════════════
      // 8. ACCESS CONTROL TESTS
      // ═════════════════════════════════════════════════════════════════════

      describe("8. Access Control Tests", () => {
        it("should reject handleDeviation from non-keeper", async () => {
          const [, nonKeeper] = await ethers.getSigners();
          const sentinelAsNonKeeper = deviationSentinel.connect(nonKeeper);

          await expect(sentinelAsNonKeeper.handleDeviation(vBTCB)).to.be.reverted;
        });

        it("should allow handleDeviation from trusted keeper", async () => {
          await setSentinelPriceNoDeviation(sentinelOracle);
          // This should not revert (no-op if no deviation)
          await deviationSentinel.handleDeviation(vBTCB);
        });
      });
    });
  });
}
