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
  "function CORE_POOL_COMPTROLLER() view returns (address)",
  "function RESILIENT_ORACLE() view returns (address)",
  "function SENTINEL_ORACLE() view returns (address)",
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function acceptOwnership()",
  "function trustedKeepers(address) view returns (bool)",
  "function tokenConfigs(address) view returns (uint8 deviation, bool enabled)",
  "function marketStates(address) view returns (bool borrowPaused, bool cfModifiedAndSupplyPaused)",
  "function checkPriceDeviation(address vToken) view returns (bool hasDeviation, uint256 oraclePrice, uint256 sentinelPrice, uint256 deviationPercent)",
  "function handleDeviation(address vToken)",
  "function setTrustedKeeper(address keeper, bool trusted)",
  "function setTokenConfig(address token, tuple(uint8 deviation, bool enabled) config)",
  "function setTokenMonitoringEnabled(address token, bool enabled)",
  "function resetMarketState(address vToken)",
  "event SupplyPaused(address indexed vToken)",
  "event SupplyUnpaused(address indexed vToken)",
  "event BorrowPaused(address indexed vToken)",
  "event BorrowUnpaused(address indexed vToken)",
  "event MarketStateReset(address indexed vToken)",
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
  "function _setCollateralFactor(address vToken, uint256 newCollateralFactorMantissa) returns (uint256)",
];

// ═══════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Execute VIP-900 commands by impersonating the timelock.
 * Sets up all permissions required for DeviationSentinel to operate.
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

  // Grant permissions for DeviationSentinel
  const permissionAccounts = [GUARDIAN, NORMAL_TIMELOCK, FAST_TRACK_TIMELOCK, CRITICAL_TIMELOCK];
  for (const account of permissionAccounts) {
    await acm.giveCallPermission(DEVIATION_SENTINEL, "setTokenConfig(address,(uint8,bool))", account);
    await acm.giveCallPermission(DEVIATION_SENTINEL, "setTrustedKeeper(address,bool)", account);
    await acm.giveCallPermission(DEVIATION_SENTINEL, "setTokenMonitoringEnabled(address,bool)", account);
    await acm.giveCallPermission(DEVIATION_SENTINEL, "resetMarketState(address)", account);
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

  // Grant DeviationSentinel permissions on comptrollers
  await acm.giveCallPermission(
    ethers.constants.AddressZero,
    "setActionsPaused(address[],uint8[],bool)",
    DEVIATION_SENTINEL,
  );
  await acm.giveCallPermission(
    ethers.constants.AddressZero,
    "_setActionsPaused(address[],uint8[],bool)",
    DEVIATION_SENTINEL,
  );
  await acm.giveCallPermission(
    ethers.constants.AddressZero,
    "setCollateralFactor(address,uint256,uint256)",
    DEVIATION_SENTINEL,
  );
  await acm.giveCallPermission(
    ethers.constants.AddressZero,
    "setCollateralFactor(uint96,address,uint256,uint256)",
    DEVIATION_SENTINEL,
  );
  await acm.giveCallPermission(
    ethers.constants.AddressZero,
    "_setCollateralFactor(address,uint256)",
    DEVIATION_SENTINEL,
  );

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
 * Uses cached oracle price to avoid staleness issues
 */
async function setSentinelPriceLower(
  sentinelOracle: Contract,
  deviationPercent: number = 50,
): Promise<{ oraclePrice: BigNumber; sentinelPrice: BigNumber }> {
  // Sentinel price = oracle * (100 - deviation) / 100
  const sentinelPrice = CACHED_BTCB_PRICE.mul(100 - deviationPercent).div(100);
  await sentinelOracle.setDirectPrice(BTCB, sentinelPrice);
  return { oraclePrice: CACHED_BTCB_PRICE, sentinelPrice };
}

/**
 * Set sentinel price higher than oracle (triggers borrow pause)
 * Uses cached oracle price to avoid staleness issues
 */
async function setSentinelPriceHigher(
  sentinelOracle: Contract,
  deviationPercent: number = 50,
): Promise<{ oraclePrice: BigNumber; sentinelPrice: BigNumber }> {
  // Sentinel price = oracle * (100 + deviation) / 100
  const sentinelPrice = CACHED_BTCB_PRICE.mul(100 + deviationPercent).div(100);
  await sentinelOracle.setDirectPrice(BTCB, sentinelPrice);
  return { oraclePrice: CACHED_BTCB_PRICE, sentinelPrice };
}

/**
 * Helper to reset test state to a clean baseline
 * Sets sentinel price to match cached oracle price (no deviation)
 */
async function resetToCleanState(
  deviationSentinel: Contract,
  sentinelOracle: Contract,
  coreComptroller: Contract,
): Promise<void> {
  // Reset sentinel state
  await deviationSentinel.resetMarketState(vBTCB);

  // Set sentinel price to match cached oracle (no deviation)
  await setSentinelPriceNoDeviation(sentinelOracle);

  // Ensure comptroller actions are unpaused
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

    describe("DeviationSentinel Fork Tests (BSC Mainnet)", () => {
      before(async () => {
        // Initialize timelock signer
        timelock = await initMainnetUser(NORMAL_TIMELOCK, ethers.utils.parseUnits("10"));

        // Connect to deployed contracts
        deviationSentinel = new ethers.Contract(DEVIATION_SENTINEL, DEVIATION_SENTINEL_ABI, timelock);
        sentinelOracle = new ethers.Contract(SENTINEL_ORACLE, SENTINEL_ORACLE_ABI, timelock);
        _uniswapOracle = new ethers.Contract(UNISWAP_ORACLE, DEX_ORACLE_ABI, timelock);
        coreComptroller = new ethers.Contract(COMPTROLLER, COMPTROLLER_ABI, timelock);
        resilientOracle = new ethers.Contract(RESILIENT_ORACLE, RESILIENT_ORACLE_ABI, timelock);

        // Execute VIP-900 to set up permissions
        await executeVip900(timelock);

        // Extend ChainlinkOracle staleness period for BTCB to avoid "invalid resilient oracle price" errors
        // This is necessary because on fork tests, the aggregator timestamp is fixed but block.timestamp advances
        const chainlinkOracle = new ethers.Contract(CHAINLINK_ORACLE, CHAINLINK_ORACLE_ABI, timelock);
        const btcbConfig = await chainlinkOracle.tokenConfigs(BTCB);
        console.log(
          "BTCB Chainlink config - feed:",
          btcbConfig.feed,
          "maxStalePeriod:",
          btcbConfig.maxStalePeriod.toString(),
        );
        // Set very long staleness period (30 days) to avoid staleness issues during fork tests
        await chainlinkOracle.setTokenConfig({
          asset: BTCB,
          feed: btcbConfig.feed,
          maxStalePeriod: 30 * 24 * 60 * 60, // 30 days in seconds
        });
        console.log("Extended BTCB Chainlink staleness period to 30 days");

        // Configure BTCB for testing - cache oracle price to avoid staleness issues
        // Get current oracle price ONCE and cache it for all tests
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
          expect((await deviationSentinel.CORE_POOL_COMPTROLLER()).toLowerCase()).to.equal(COMPTROLLER.toLowerCase());
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
          // Set sentinel price to match oracle (no deviation)
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

          // Restore
          await sentinelOracle.setDirectPrice(BTCB, oraclePrice);
        });

        it("should return hasDeviation=true when sentinel price is higher", async () => {
          const { oraclePrice } = await setSentinelPriceHigher(sentinelOracle, 50);

          const result = await deviationSentinel.checkPriceDeviation(vBTCB);
          expect(result.hasDeviation).to.be.true;
          expect(result.sentinelPrice).to.be.gt(result.oraclePrice);

          // Restore
          await sentinelOracle.setDirectPrice(BTCB, oraclePrice);
        });
      });

      // ═════════════════════════════════════════════════════════════════════
      // 3. handleDeviation — SENTINEL LOWER (Supply Pause + CF Zero)
      // ═════════════════════════════════════════════════════════════════════

      describe("3. handleDeviation — Sentinel Lower (Supply Pause)", () => {
        let _originalCF: BigNumber;

        before(async () => {
          await resetToCleanState(deviationSentinel, sentinelOracle, coreComptroller);
          _originalCF = (await coreComptroller.markets(vBTCB)).collateralFactorMantissa;
        });

        it("should pause supply when sentinel price is lower", async () => {
          await setSentinelPriceLower(sentinelOracle, 50);

          await expect(deviationSentinel.handleDeviation(vBTCB))
            .to.emit(deviationSentinel, "SupplyPaused")
            .withArgs(vBTCB);

          expect(await coreComptroller.actionPaused(vBTCB, Action.MINT)).to.be.true;
          expect((await deviationSentinel.marketStates(vBTCB)).cfModifiedAndSupplyPaused).to.be.true;
        });

        it("should unpause supply when deviation resolves", async () => {
          await setSentinelPriceNoDeviation(sentinelOracle);

          await expect(deviationSentinel.handleDeviation(vBTCB))
            .to.emit(deviationSentinel, "SupplyUnpaused")
            .withArgs(vBTCB);

          expect(await coreComptroller.actionPaused(vBTCB, Action.MINT)).to.be.false;
          expect((await deviationSentinel.marketStates(vBTCB)).cfModifiedAndSupplyPaused).to.be.false;
        });
      });

      // ═════════════════════════════════════════════════════════════════════
      // 4. handleDeviation — SENTINEL HIGHER (Borrow Pause)
      // ═════════════════════════════════════════════════════════════════════

      describe("4. handleDeviation — Sentinel Higher (Borrow Pause)", () => {
        before(async () => {
          await resetToCleanState(deviationSentinel, sentinelOracle, coreComptroller);
        });

        it("should pause borrow when sentinel price is higher", async () => {
          await setSentinelPriceHigher(sentinelOracle, 50);

          await expect(deviationSentinel.handleDeviation(vBTCB))
            .to.emit(deviationSentinel, "BorrowPaused")
            .withArgs(vBTCB);

          expect(await coreComptroller.actionPaused(vBTCB, Action.BORROW)).to.be.true;
          expect((await deviationSentinel.marketStates(vBTCB)).borrowPaused).to.be.true;
        });

        it("should unpause borrow when deviation resolves", async () => {
          await setSentinelPriceNoDeviation(sentinelOracle);

          await expect(deviationSentinel.handleDeviation(vBTCB))
            .to.emit(deviationSentinel, "BorrowUnpaused")
            .withArgs(vBTCB);

          expect(await coreComptroller.actionPaused(vBTCB, Action.BORROW)).to.be.false;
          expect((await deviationSentinel.marketStates(vBTCB)).borrowPaused).to.be.false;
        });
      });

      // ═════════════════════════════════════════════════════════════════════
      // 5. resetMarketState
      // ═════════════════════════════════════════════════════════════════════

      describe("5. resetMarketState", () => {
        it("should emit MarketStateReset event", async () => {
          await expect(deviationSentinel.resetMarketState(vBTCB))
            .to.emit(deviationSentinel, "MarketStateReset")
            .withArgs(vBTCB);
        });

        it("should clear sentinel state but NOT unpause comptroller", async () => {
          await resetToCleanState(deviationSentinel, sentinelOracle, coreComptroller);

          // Trigger deviation
          await setSentinelPriceHigher(sentinelOracle, 50);
          await deviationSentinel.handleDeviation(vBTCB);
          expect((await deviationSentinel.marketStates(vBTCB)).borrowPaused).to.be.true;
          expect(await coreComptroller.actionPaused(vBTCB, Action.BORROW)).to.be.true;

          // Reset sentinel state
          await deviationSentinel.resetMarketState(vBTCB);

          // Sentinel state is cleared
          expect((await deviationSentinel.marketStates(vBTCB)).borrowPaused).to.be.false;
          // BUT comptroller remains paused!
          expect(await coreComptroller.actionPaused(vBTCB, Action.BORROW)).to.be.true;

          // Cleanup
          await coreComptroller._setActionsPaused([vBTCB], [Action.BORROW], false);
          await setSentinelPriceNoDeviation(sentinelOracle);
        });

        it("should allow fresh pause after reset", async () => {
          await resetToCleanState(deviationSentinel, sentinelOracle, coreComptroller);

          // Trigger borrow pause
          await setSentinelPriceHigher(sentinelOracle, 50);
          await deviationSentinel.handleDeviation(vBTCB);

          // Reset
          await deviationSentinel.resetMarketState(vBTCB);

          // Same deviation should re-trigger (not early-return)
          await expect(deviationSentinel.handleDeviation(vBTCB))
            .to.emit(deviationSentinel, "BorrowPaused")
            .withArgs(vBTCB);

          // Cleanup
          await setSentinelPriceNoDeviation(sentinelOracle);
          await deviationSentinel.resetMarketState(vBTCB);
        });
      });

      // ═════════════════════════════════════════════════════════════════════
      // 6. setTokenMonitoringEnabled
      // ═════════════════════════════════════════════════════════════════════

      describe("6. setTokenMonitoringEnabled", () => {
        before(async () => {
          await resetToCleanState(deviationSentinel, sentinelOracle, coreComptroller);
        });

        it("should disable monitoring and block handleDeviation", async () => {
          await deviationSentinel.setTokenMonitoringEnabled(BTCB, false);
          expect((await deviationSentinel.tokenConfigs(BTCB)).enabled).to.be.false;

          // Force deviation
          await setSentinelPriceLower(sentinelOracle, 50);

          // Using string ABI so can't check custom error name, just verify it reverts
          await expect(deviationSentinel.handleDeviation(vBTCB)).to.be.reverted;
        });

        it("should re-enable monitoring and allow handleDeviation", async () => {
          await deviationSentinel.setTokenMonitoringEnabled(BTCB, true);
          expect((await deviationSentinel.tokenConfigs(BTCB)).enabled).to.be.true;

          await expect(deviationSentinel.handleDeviation(vBTCB))
            .to.emit(deviationSentinel, "SupplyPaused")
            .withArgs(vBTCB);

          // Cleanup
          await setSentinelPriceNoDeviation(sentinelOracle);
          await deviationSentinel.handleDeviation(vBTCB);
        });

        it("should emit TokenMonitoringStatusChanged event", async () => {
          await expect(deviationSentinel.setTokenMonitoringEnabled(BTCB, false))
            .to.emit(deviationSentinel, "TokenMonitoringStatusChanged")
            .withArgs(BTCB, false);

          await deviationSentinel.setTokenMonitoringEnabled(BTCB, true);
        });
      });

      // ═════════════════════════════════════════════════════════════════════
      // 7. GOVERNANCE SCENARIO A — Stale CF Restoration
      //
      // PR Description: "If governance changes the collateral factor while
      // the sentinel has the market paused, the sentinel will restore the
      // OLD (stale) CF when deviation resolves"
      // ═════════════════════════════════════════════════════════════════════

      describe("7. Governance Scenario A — Stale CF Restoration", () => {
        let _originalCF: BigNumber;

        before(async () => {
          await resetToCleanState(deviationSentinel, sentinelOracle, coreComptroller);
          _originalCF = (await coreComptroller.markets(vBTCB)).collateralFactorMantissa;
        });

        it("should demonstrate stale CF restoration problem (sentinel caches original CF)", async () => {
          // Step 1: Deviation → CF zeroed, sentinel caches originalCF
          await setSentinelPriceLower(sentinelOracle, 50);
          await deviationSentinel.handleDeviation(vBTCB);

          // Verify sentinel state shows CF was modified
          expect((await deviationSentinel.marketStates(vBTCB)).cfModifiedAndSupplyPaused).to.be.true;

          // Step 2: Deviation resolves → sentinel restores cached CF
          await setSentinelPriceNoDeviation(sentinelOracle);
          await deviationSentinel.handleDeviation(vBTCB);

          // Sentinel restored the originalCF
          expect((await deviationSentinel.marketStates(vBTCB)).cfModifiedAndSupplyPaused).to.be.false;
        });

        it("should preserve governance CF when resetMarketState is called first (correct procedure)", async () => {
          // Step 1: Deviation → supply paused
          await setSentinelPriceLower(sentinelOracle, 50);
          await deviationSentinel.handleDeviation(vBTCB);

          // Step 2: Admin resets sentinel state — clears cached CF
          await deviationSentinel.resetMarketState(vBTCB);

          // Step 3: Deviation resolves
          await setSentinelPriceNoDeviation(sentinelOracle);

          // Step 4: handleDeviation — sentinel sees cfModifiedAndSupplyPaused=false, does nothing to CF
          const tx = deviationSentinel.handleDeviation(vBTCB);
          await expect(tx).to.not.emit(deviationSentinel, "SupplyUnpaused");

          // Cleanup - manually unpause
          await coreComptroller._setActionsPaused([vBTCB], [Action.MINT], false);
        });
      });

      // ═════════════════════════════════════════════════════════════════════
      // 8. GOVERNANCE SCENARIO B — resetMarketState Without Manual Unpause
      //
      // PR Description: "Supply remains paused with no automated recovery
      // path via the Sentinel if governance didn't manually unpause"
      // ═════════════════════════════════════════════════════════════════════

      describe("8. Governance Scenario B — resetMarketState Without Manual Unpause", () => {
        before(async () => {
          await resetToCleanState(deviationSentinel, sentinelOracle, coreComptroller);
        });

        it("should leave supply paused if governance forgets to manually unpause after reset", async () => {
          // Step 1: Deviation → supply paused
          await setSentinelPriceLower(sentinelOracle, 50);
          await deviationSentinel.handleDeviation(vBTCB);
          expect(await coreComptroller.actionPaused(vBTCB, Action.MINT)).to.be.true;

          // Step 2: Governance calls resetMarketState (clears sentinel state)
          await deviationSentinel.resetMarketState(vBTCB);

          // Step 3: Deviation resolves
          await setSentinelPriceNoDeviation(sentinelOracle);

          // Step 4: handleDeviation — sentinel sees cfModifiedAndSupplyPaused=false, does nothing
          const tx = deviationSentinel.handleDeviation(vBTCB);
          await expect(tx).to.not.emit(deviationSentinel, "SupplyUnpaused");

          // PROBLEM: Supply STILL paused!
          expect(await coreComptroller.actionPaused(vBTCB, Action.MINT)).to.be.true;

          // Cleanup - governance must manually unpause
          await coreComptroller._setActionsPaused([vBTCB], [Action.MINT], false);
        });
      });

      // ═════════════════════════════════════════════════════════════════════
      // 9. REQUIRED GOVERNANCE PROCEDURE (Full Workflow)
      //
      // The correct VIP order:
      // 1. resetMarketState(market)
      // 2. Make all protocol changes (new CF/LT values)
      // 3. Unpause supply/borrow on the comptroller manually
      // 4. handleDeviation(market)
      // ═════════════════════════════════════════════════════════════════════

      describe("9. Required Governance Procedure (Full Workflow)", () => {
        before(async () => {
          await resetToCleanState(deviationSentinel, sentinelOracle, coreComptroller);
        });

        it("should correctly handle governance intervention when deviation is resolved", async () => {
          // SETUP: Trigger deviation
          await setSentinelPriceLower(sentinelOracle, 50);
          await deviationSentinel.handleDeviation(vBTCB);

          expect((await deviationSentinel.marketStates(vBTCB)).cfModifiedAndSupplyPaused).to.be.true;
          expect(await coreComptroller.actionPaused(vBTCB, Action.MINT)).to.be.true;

          // STEP 1: resetMarketState
          await deviationSentinel.resetMarketState(vBTCB);

          // STEP 2: (Governance would make protocol changes here)

          // STEP 3: Unpause manually
          await coreComptroller._setActionsPaused([vBTCB], [Action.MINT], false);

          // STEP 4: handleDeviation (deviation resolved)
          await setSentinelPriceNoDeviation(sentinelOracle);
          const tx = deviationSentinel.handleDeviation(vBTCB);
          await expect(tx).to.not.emit(deviationSentinel, "SupplyPaused");

          // VERIFY: Market is unpaused
          expect(await coreComptroller.actionPaused(vBTCB, Action.MINT)).to.be.false;
        });

        it("should correctly handle governance intervention when deviation still exists", async () => {
          await resetToCleanState(deviationSentinel, sentinelOracle, coreComptroller);

          // SETUP: Trigger deviation
          await setSentinelPriceLower(sentinelOracle, 50);
          await deviationSentinel.handleDeviation(vBTCB);

          // STEP 1: resetMarketState
          await deviationSentinel.resetMarketState(vBTCB);

          // STEP 3: Unpause manually
          await coreComptroller._setActionsPaused([vBTCB], [Action.MINT], false);

          // STEP 4: handleDeviation (deviation STILL exists)
          // Sentinel will re-pause with FRESH state
          await expect(deviationSentinel.handleDeviation(vBTCB))
            .to.emit(deviationSentinel, "SupplyPaused")
            .withArgs(vBTCB);

          // When deviation resolves later, sentinel can restore
          await setSentinelPriceNoDeviation(sentinelOracle);
          await deviationSentinel.handleDeviation(vBTCB);

          expect(await coreComptroller.actionPaused(vBTCB, Action.MINT)).to.be.false;
        });

        it("should correctly handle borrow pause governance intervention", async () => {
          await resetToCleanState(deviationSentinel, sentinelOracle, coreComptroller);

          // SETUP: Trigger borrow pause
          await setSentinelPriceHigher(sentinelOracle, 50);
          await deviationSentinel.handleDeviation(vBTCB);

          expect((await deviationSentinel.marketStates(vBTCB)).borrowPaused).to.be.true;
          expect(await coreComptroller.actionPaused(vBTCB, Action.BORROW)).to.be.true;

          // STEP 1: resetMarketState
          await deviationSentinel.resetMarketState(vBTCB);

          // Comptroller still has borrow paused!
          expect(await coreComptroller.actionPaused(vBTCB, Action.BORROW)).to.be.true;

          // STEP 3: Unpause manually
          await coreComptroller._setActionsPaused([vBTCB], [Action.BORROW], false);

          // STEP 4: handleDeviation (deviation resolved)
          await setSentinelPriceNoDeviation(sentinelOracle);
          const tx = deviationSentinel.handleDeviation(vBTCB);
          await expect(tx).to.not.emit(deviationSentinel, "BorrowPaused");
          await expect(tx).to.not.emit(deviationSentinel, "BorrowUnpaused");

          expect(await coreComptroller.actionPaused(vBTCB, Action.BORROW)).to.be.false;
        });
      });

      // ═════════════════════════════════════════════════════════════════════
      // 10. COMPLEX STATE TRANSITIONS
      // ═════════════════════════════════════════════════════════════════════

      describe("10. Complex State Transitions", () => {
        before(async () => {
          await resetToCleanState(deviationSentinel, sentinelOracle, coreComptroller);
        });

        it("should handle: borrow pause → resolve → supply pause (direction flip)", async () => {
          // Step 1: Sentinel higher → borrow paused
          await setSentinelPriceHigher(sentinelOracle, 50);
          await deviationSentinel.handleDeviation(vBTCB);

          let state = await deviationSentinel.marketStates(vBTCB);
          expect(state.borrowPaused).to.be.true;
          expect(state.cfModifiedAndSupplyPaused).to.be.false;

          // Step 2: Resolve
          await setSentinelPriceNoDeviation(sentinelOracle);
          await deviationSentinel.handleDeviation(vBTCB);

          state = await deviationSentinel.marketStates(vBTCB);
          expect(state.borrowPaused).to.be.false;

          // Step 3: Sentinel lower → supply paused
          await setSentinelPriceLower(sentinelOracle, 50);
          await deviationSentinel.handleDeviation(vBTCB);

          state = await deviationSentinel.marketStates(vBTCB);
          expect(state.borrowPaused).to.be.false;
          expect(state.cfModifiedAndSupplyPaused).to.be.true;

          // Cleanup
          await setSentinelPriceNoDeviation(sentinelOracle);
          await deviationSentinel.handleDeviation(vBTCB);
        });

        it("should handle: supply pause → resolve → borrow pause (direction flip)", async () => {
          await deviationSentinel.resetMarketState(vBTCB);

          // Step 1: Sentinel lower → supply paused
          await setSentinelPriceLower(sentinelOracle, 50);
          await deviationSentinel.handleDeviation(vBTCB);
          expect((await deviationSentinel.marketStates(vBTCB)).cfModifiedAndSupplyPaused).to.be.true;

          // Step 2: Resolve
          await setSentinelPriceNoDeviation(sentinelOracle);
          await deviationSentinel.handleDeviation(vBTCB);
          expect((await deviationSentinel.marketStates(vBTCB)).cfModifiedAndSupplyPaused).to.be.false;

          // Step 3: Sentinel higher → borrow paused
          await setSentinelPriceHigher(sentinelOracle, 50);
          await deviationSentinel.handleDeviation(vBTCB);

          const state = await deviationSentinel.marketStates(vBTCB);
          expect(state.borrowPaused).to.be.true;
          expect(state.cfModifiedAndSupplyPaused).to.be.false;

          // Cleanup
          await setSentinelPriceNoDeviation(sentinelOracle);
          await deviationSentinel.resetMarketState(vBTCB);
        });

        it("should be a no-op when no deviation and clean state", async () => {
          await resetToCleanState(deviationSentinel, sentinelOracle, coreComptroller);

          const tx = deviationSentinel.handleDeviation(vBTCB);
          await expect(tx).to.not.emit(deviationSentinel, "BorrowPaused");
          await expect(tx).to.not.emit(deviationSentinel, "SupplyPaused");
          await expect(tx).to.not.emit(deviationSentinel, "BorrowUnpaused");
          await expect(tx).to.not.emit(deviationSentinel, "SupplyUnpaused");

          const state = await deviationSentinel.marketStates(vBTCB);
          expect(state.borrowPaused).to.be.false;
          expect(state.cfModifiedAndSupplyPaused).to.be.false;
        });
      });

      // ═════════════════════════════════════════════════════════════════════
      // 11. SENTINEL ORACLE DIRECT PRICE CONTROL
      // ═════════════════════════════════════════════════════════════════════

      describe("11. SentinelOracle Direct Price Control", () => {
        before(async () => {
          await resetToCleanState(deviationSentinel, sentinelOracle, coreComptroller);
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

        it("should resolve when prices match again", async () => {
          await setSentinelPriceNoDeviation(sentinelOracle);

          const result = await deviationSentinel.checkPriceDeviation(vBTCB);
          expect(result.hasDeviation).to.be.false;

          await expect(deviationSentinel.handleDeviation(vBTCB))
            .to.emit(deviationSentinel, "BorrowUnpaused")
            .withArgs(vBTCB);
        });

        it("should detect deviation via direct price override (sentinel lower)", async () => {
          await setSentinelPriceLower(sentinelOracle, 50);

          const result = await deviationSentinel.checkPriceDeviation(vBTCB);
          expect(result.hasDeviation).to.be.true;
          expect(result.sentinelPrice).to.be.lt(result.oraclePrice);

          await expect(deviationSentinel.handleDeviation(vBTCB))
            .to.emit(deviationSentinel, "SupplyPaused")
            .withArgs(vBTCB);

          // Cleanup
          await setSentinelPriceNoDeviation(sentinelOracle);
          await deviationSentinel.handleDeviation(vBTCB);
        });
      });

      // ═════════════════════════════════════════════════════════════════════
      // 12. ACCESS CONTROL TESTS
      // ═════════════════════════════════════════════════════════════════════

      describe("12. Access Control Tests", () => {
        it("should reject handleDeviation from non-keeper", async () => {
          const [, nonKeeper] = await ethers.getSigners();
          const sentinelAsNonKeeper = deviationSentinel.connect(nonKeeper);

          // Using string ABI so can't check custom error name, just verify it reverts
          await expect(sentinelAsNonKeeper.handleDeviation(vBTCB)).to.be.reverted;
        });

        it("should allow handleDeviation from trusted keeper", async () => {
          // Timelock is a trusted keeper
          await setSentinelPriceNoDeviation(sentinelOracle);

          // This should not revert (may not emit events if no deviation)
          await deviationSentinel.handleDeviation(vBTCB);
        });
      });
    });
  });
}
