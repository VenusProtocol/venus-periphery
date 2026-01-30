import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { BigNumber } from "ethers";
import { parseUnits } from "ethers/lib/utils";
import { ethers, upgrades } from "hardhat";

import {
  ChainlinkOracle,
  ChainlinkOracle__factory,
  ComptrollerMock,
  ComptrollerMock__factory,
  DeviationSentinel,
  IAccessControlManagerV8,
  IAccessControlManagerV8__factory,
  PancakeSwapOracle,
  ResilientOracle,
  ResilientOracle__factory,
  SentinelOracle,
  UniswapOracle,
} from "../../../typechain";
import { forking, initMainnetUser } from "./utils";

// ═══════════════════════════════════════════════════════════════════════
// BSC Mainnet addresses
// ═══════════════════════════════════════════════════════════════════════

const COMPTROLLER = "0xfd36e2c2a6789db23113685031d7f16329158384";
const NORMAL_TIMELOCK = "0x939bD8d64c0A9583A7Dcea9933f7b21697ab6396";
const ACM = "0x4788629abc6cfca10f9f969efdeaa1cf70c23555";
const TRX = "0xCE7de646e7208a4Ef112cb6ed5038FA6cC6b12e3";
const BTCB = "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c";
const ORACLE = "0x6592b5DE802159F3E74B2486b091D11a8256ab8A";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const CHAINLINK_ORACLE = "0x1B2103441A0A108daD8848D8F5d790e4D402921F";
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const vWBNB = "0x6bCa74586218dB34cdB402295796b79663d816e9";

// PancakeSwap V3 pools on BSC
const PANCAKE_TRX_POOL = "0xF683113764E4499c473aCd38Fc4b37E71554E4aD";
const PANCAKE_USDT_POOL = "0x172fcD41E0913e95784454622d1c3724f546f849";
const PANCAKE_WBNB_POOL = "0xF683113764E4499c473aCd38Fc4b37E71554E4aD";

// Uniswap V3 pools on BSC
const UNISWAP_BTCB_POOL = "0x28dF0835942396B7a1b7aE1cd068728E6ddBbAfD";
const UNISWAP_WBNB_POOL = "0x28dF0835942396B7a1b7aE1cd068728E6ddBbAfD";

const FORK_MAINNET = process.env.FORKED_NETWORK === "bscmainnet";

type SetupMarketFixture = {
  timelock: SignerWithAddress;
  deviationSentinel: DeviationSentinel;
  coreComptroller: ComptrollerMock;
  chainlinkOracle: ChainlinkOracle;
  resilientOracle: ResilientOracle;
  sentinelOracle: SentinelOracle;
  pancakeSwapOracle: PancakeSwapOracle;
  uniswapOracle: UniswapOracle;
};

/**
 * Deploys all contracts (PancakeSwapOracle, UniswapOracle, SentinelOracle,
 * DeviationSentinel) and grants all required ACM permissions via the
 * impersonated NORMAL_TIMELOCK signer.
 */
const setupMarketFixture = async (): Promise<SetupMarketFixture> => {
  const timelock = await initMainnetUser(NORMAL_TIMELOCK, ethers.utils.parseUnits("2"));
  const coreComptroller = ComptrollerMock__factory.connect(COMPTROLLER, timelock);
  const chainlinkOracle = ChainlinkOracle__factory.connect(CHAINLINK_ORACLE, timelock);
  const resilientOracle = ResilientOracle__factory.connect(ORACLE, timelock);

  // ── Deploy DEX oracles ──
  const pancakeSwapOracleFactory = await ethers.getContractFactory("PancakeSwapOracle");
  const pancakeSwapOracle = (await upgrades.deployProxy(pancakeSwapOracleFactory, [ACM], {
    constructorArgs: [ORACLE],
    unsafeAllow: ["constructor", "internal-function-storage"],
  })) as PancakeSwapOracle;

  const uniswapOracleFactory = await ethers.getContractFactory("UniswapOracle");
  const uniswapOracle = (await upgrades.deployProxy(uniswapOracleFactory, [ACM], {
    constructorArgs: [ORACLE],
    unsafeAllow: ["constructor", "internal-function-storage"],
  })) as UniswapOracle;

  // ── Deploy SentinelOracle (aggregates DEX prices) ──
  const sentinelOracleFactory = await ethers.getContractFactory("SentinelOracle");
  const sentinelOracle = (await upgrades.deployProxy(sentinelOracleFactory, [ACM], {
    unsafeAllow: ["constructor", "internal-function-storage"],
  })) as SentinelOracle;

  // ── Deploy DeviationSentinel ──
  const deviationSentinelFactory = await ethers.getContractFactory("DeviationSentinel");
  const deviationSentinel = (await upgrades.deployProxy(deviationSentinelFactory, [ACM], {
    constructorArgs: [COMPTROLLER, ORACLE, sentinelOracle.address],
    unsafeAllow: ["constructor", "internal-function-storage"],
  })) as DeviationSentinel;

  // ── ACM permissions ──
  const acm = IAccessControlManagerV8__factory.connect(ACM, timelock) as IAccessControlManagerV8;

  // Comptroller permissions for DeviationSentinel
  await acm.giveCallPermission(
    coreComptroller.address,
    "_setActionsPaused(address[],uint8[],bool)",
    deviationSentinel.address,
  );
  await acm.giveCallPermission(
    coreComptroller.address,
    "setCollateralFactor(uint96,address,uint256,uint256)",
    deviationSentinel.address,
  );

  // Comptroller permission for timelock (governance edge case tests)
  await acm.giveCallPermission(
    coreComptroller.address,
    "setCollateralFactor(address,uint256,uint256)",
    NORMAL_TIMELOCK,
  );

  // DeviationSentinel admin permissions for timelock
  await acm.giveCallPermission(
    deviationSentinel.address,
    "setTokenConfig(address,(uint8,bool))",
    NORMAL_TIMELOCK,
  );
  await acm.giveCallPermission(
    deviationSentinel.address,
    "setTrustedKeeper(address,bool)",
    NORMAL_TIMELOCK,
  );
  await acm.giveCallPermission(
    deviationSentinel.address,
    "resetMarketState(address)",
    NORMAL_TIMELOCK,
  );
  await acm.giveCallPermission(
    deviationSentinel.address,
    "setTokenMonitoringEnabled(address,bool)",
    NORMAL_TIMELOCK,
  );

  // Oracle permissions for timelock
  await acm.giveCallPermission(sentinelOracle.address, "setTokenOracleConfig(address,address)", NORMAL_TIMELOCK);
  await acm.giveCallPermission(sentinelOracle.address, "setDirectPrice(address,uint256)", NORMAL_TIMELOCK);
  await acm.giveCallPermission(pancakeSwapOracle.address, "setPoolConfig(address,address)", NORMAL_TIMELOCK);
  await acm.giveCallPermission(uniswapOracle.address, "setPoolConfig(address,address)", NORMAL_TIMELOCK);

  // ── Set up keeper ──
  await deviationSentinel.connect(timelock).setTrustedKeeper(timelock.address, true);

  return {
    timelock,
    deviationSentinel,
    coreComptroller,
    chainlinkOracle,
    resilientOracle,
    sentinelOracle,
    pancakeSwapOracle,
    uniswapOracle,
  };
};

// ═══════════════════════════════════════════════════════════════════════
// Main Forked Test Suite
// ═══════════════════════════════════════════════════════════════════════

if (FORK_MAINNET) {
  const blockNumber = 70909246;
  forking(blockNumber, () => {
    let deviationSentinel: DeviationSentinel;
    let timelock: SignerWithAddress;
    let coreComptroller: ComptrollerMock;
    let chainlinkOracle: ChainlinkOracle;
    let resilientOracle: ResilientOracle;
    let sentinelOracle: SentinelOracle;
    let pancakeSwapOracle: PancakeSwapOracle;
    let uniswapOracle: UniswapOracle;

    describe("DeviationSentinel", () => {
      before(async () => {
        ({
          deviationSentinel,
          timelock,
          coreComptroller,
          chainlinkOracle,
          resilientOracle,
          sentinelOracle,
          pancakeSwapOracle,
          uniswapOracle,
        } = await loadFixture(setupMarketFixture));
      });

      // ═════════════════════════════════════════════════════════════════
      // 1. Deployment & Initialization
      // ═════════════════════════════════════════════════════════════════

      describe("Deployment & Initialization", () => {
        it("should store correct immutable addresses", async () => {
          // On-chain addresses are checksummed; compare case-insensitively
          expect((await deviationSentinel.CORE_POOL_COMPTROLLER()).toLowerCase()).to.equal(
            COMPTROLLER.toLowerCase(),
          );
          expect((await deviationSentinel.RESILIENT_ORACLE()).toLowerCase()).to.equal(ORACLE.toLowerCase());
          expect(await deviationSentinel.SENTINEL_ORACLE()).to.equal(sentinelOracle.address);
        });

        it("should have corePoolId = 0 on BSC mainnet", async () => {
          expect(await coreComptroller.corePoolId()).to.equal(0);
        });

        it("should reject re-initialization", async () => {
          await expect(deviationSentinel.initialize(ACM)).to.be.revertedWith(
            "Initializable: contract is already initialized",
          );
        });
      });

      // ═════════════════════════════════════════════════════════════════
      // Global oracle setup — extend chainlink staleness for WBNB and
      // BTCB so fork-block feeds don't revert with "invalid resilient
      // oracle price". Also configure Uniswap pool for WBNB (used by
      // sections that clear sentinel direct price back to DEX).
      // ═════════════════════════════════════════════════════════════════

      describe("Oracle setup", () => {
        before(async () => {
          // Configure WBNB on Uniswap (needed when sentinel direct price cleared)
          await uniswapOracle.connect(timelock).setPoolConfig(WBNB, UNISWAP_WBNB_POOL);
          await sentinelOracle.connect(timelock).setTokenOracleConfig(WBNB, uniswapOracle.address);

          // Ensure resilient oracle routes WBNB through chainlink only
          await resilientOracle.connect(timelock).setTokenConfig({
            asset: WBNB,
            oracles: [CHAINLINK_ORACLE, ethers.constants.AddressZero, ethers.constants.AddressZero],
            enableFlagsForOracles: [true, false, false],
            cachingEnabled: false,
          });

          // Extend chainlink staleness for both WBNB and BTCB (BTCB is the
          // reference token in the WBNB/BTCB Uniswap pool — the Uniswap oracle
          // calls RESILIENT_ORACLE.getPrice(BTCB) internally)
          let tc = await chainlinkOracle.tokenConfigs(WBNB);
          await chainlinkOracle.connect(timelock).setTokenConfig({
            asset: WBNB,
            feed: tc.feed,
            maxStalePeriod: 25 * 60 * 60,
          });

          tc = await chainlinkOracle.tokenConfigs(BTCB);
          await chainlinkOracle.connect(timelock).setTokenConfig({
            asset: BTCB,
            feed: tc.feed,
            maxStalePeriod: 25 * 60 * 60,
          });
        });

        it("should have WBNB and BTCB chainlink feeds configured", async () => {
          // Smoke test — both prices should be readable without reverting
          const wbnbPrice = await resilientOracle.getPrice(WBNB);
          expect(wbnbPrice).to.be.gt(0);
          const btcbPrice = await resilientOracle.getPrice(BTCB);
          expect(btcbPrice).to.be.gt(0);
        });
      });

      // ═════════════════════════════════════════════════════════════════
      // 2. Sentinel Oracle Price Reads
      //
      // Verifies that the SentinelOracle correctly routes price requests
      // to PancakeSwap / Uniswap DEX oracles and returns prices in the
      // expected (36 - tokenDecimals) format.
      // ═════════════════════════════════════════════════════════════════

      describe("Sentinel Oracle price reads", () => {
        before(async () => {
          // Configure PancakeSwap pools
          await pancakeSwapOracle.connect(timelock).setPoolConfig(TRX, PANCAKE_TRX_POOL);
          await pancakeSwapOracle.connect(timelock).setPoolConfig(USDT, PANCAKE_USDT_POOL);
          await pancakeSwapOracle.connect(timelock).setPoolConfig(WBNB, PANCAKE_WBNB_POOL);

          // Configure Uniswap pools
          await uniswapOracle.connect(timelock).setPoolConfig(BTCB, UNISWAP_BTCB_POOL);

          // Route tokens to their DEX oracles via SentinelOracle
          await sentinelOracle.connect(timelock).setTokenOracleConfig(TRX, pancakeSwapOracle.address);
          await sentinelOracle.connect(timelock).setTokenOracleConfig(USDT, pancakeSwapOracle.address);
          await sentinelOracle.connect(timelock).setTokenOracleConfig(BTCB, uniswapOracle.address);
          await sentinelOracle.connect(timelock).setTokenOracleConfig(WBNB, pancakeSwapOracle.address);
        });

        it("should return TRX price from PancakeSwap", async () => {
          const price = await sentinelOracle.getPrice(TRX);
          // TRX has 6 decimals → price in 30-decimal format; ~$0.28
          expect(price.gte(parseUnits("0.2", 30))).to.be.true;
          expect(price.lte(parseUnits("0.4", 30))).to.be.true;
        });

        it("should return USDT price from PancakeSwap", async () => {
          const price = await sentinelOracle.getPrice(USDT);
          // USDT should be near $1.00
          expect(price.gte(parseUnits("0.99", 18))).to.be.true;
          expect(price.lte(parseUnits("1.01", 18))).to.be.true;
        });

        it("should return WBNB price from PancakeSwap", async () => {
          const price = await sentinelOracle.getPrice(WBNB);
          // WBNB ~$900 at fork block
          expect(price.gte(parseUnits("800", 18))).to.be.true;
          expect(price.lte(parseUnits("1000", 18))).to.be.true;
        });

        it("should return BTCB price from Uniswap", async () => {
          const price = await sentinelOracle.getPrice(BTCB);
          // BTCB ~$91k at fork block
          expect(price.gte(parseUnits("85000", 18))).to.be.true;
          expect(price.lte(parseUnits("100000", 18))).to.be.true;
        });
      });

      // ═════════════════════════════════════════════════════════════════
      // 3. Token Config & Keeper Management (on-chain ACM)
      // ═════════════════════════════════════════════════════════════════

      describe("Token config & keeper management", () => {
        it("should store token config correctly", async () => {
          await deviationSentinel.connect(timelock).setTokenConfig(WBNB, { deviation: 10, enabled: true });
          const config = await deviationSentinel.tokenConfigs(WBNB);
          expect(config.deviation).to.equal(10);
          expect(config.enabled).to.be.true;
        });

        it("should revert setTokenConfig for unauthorized caller", async () => {
          const [, randomUser] = await ethers.getSigners();
          await expect(
            deviationSentinel.connect(randomUser).setTokenConfig(WBNB, { deviation: 10, enabled: true }),
          ).to.be.reverted;
        });

        it("should store trusted keeper correctly", async () => {
          expect(await deviationSentinel.trustedKeepers(timelock.address)).to.be.true;
        });

        it("should revert setTrustedKeeper for unauthorized caller", async () => {
          const [, randomUser] = await ethers.getSigners();
          await expect(deviationSentinel.connect(randomUser).setTrustedKeeper(randomUser.address, true)).to.be
            .reverted;
        });
      });

      // ═════════════════════════════════════════════════════════════════
      // 4. checkPriceDeviation (view-only)
      //
      // Uses Chainlink setDirectPrice to artificially move the resilient
      // oracle price while the sentinel oracle reads from DEX pools.
      // ═════════════════════════════════════════════════════════════════

      describe("checkPriceDeviation", () => {
        before(async () => {
          // Switch WBNB sentinel to Uniswap for these tests
          await uniswapOracle.connect(timelock).setPoolConfig(WBNB, UNISWAP_WBNB_POOL);
          await sentinelOracle.connect(timelock).setTokenOracleConfig(WBNB, uniswapOracle.address);

          // Configure WBNB token with 10% deviation threshold
          await deviationSentinel.connect(timelock).setTokenConfig(WBNB, { deviation: 10, enabled: true });

          // Ensure chainlink staleness doesn't interfere
          await resilientOracle.connect(timelock).setTokenConfig({
            asset: WBNB,
            oracles: [CHAINLINK_ORACLE, ethers.constants.AddressZero, ethers.constants.AddressZero],
            enableFlagsForOracles: [true, false, false],
            cachingEnabled: false,
          });
          const tokenConfig = await chainlinkOracle.tokenConfigs(WBNB);
          await chainlinkOracle.connect(timelock).setTokenConfig({
            asset: WBNB,
            feed: tokenConfig.feed,
            maxStalePeriod: 25 * 60 * 60,
          });
        });

        it("should report no deviation when prices are close", async () => {
          // Reset chainlink to realistic price (near DEX price ~$905)
          await chainlinkOracle.connect(timelock).setDirectPrice(WBNB, parseUnits("900", 18));

          const result = await deviationSentinel.checkPriceDeviation(vWBNB);
          expect(result.hasDeviation).to.be.false;
          // oraclePrice and sentinelPrice should both be non-zero
          expect(result.oraclePrice).to.be.gt(0);
          expect(result.sentinelPrice).to.be.gt(0);
        });

        it("should detect deviation when chainlink price is artificially high", async () => {
          // Set chainlink price far above DEX price → resilient > sentinel
          await chainlinkOracle.connect(timelock).setDirectPrice(WBNB, parseUnits("3000", 18));

          const result = await deviationSentinel.checkPriceDeviation(vWBNB);
          expect(result.hasDeviation).to.be.true;
          // Sentinel price (~905) < oracle price (3000) → sentinel lower
          expect(result.sentinelPrice).to.be.lt(result.oraclePrice);
          expect(result.deviationPercent).to.be.gt(10);
        });

        it("should detect deviation when chainlink price is artificially low", async () => {
          // Set chainlink price far below DEX price → resilient < sentinel
          await chainlinkOracle.connect(timelock).setDirectPrice(WBNB, parseUnits("300", 18));

          const result = await deviationSentinel.checkPriceDeviation(vWBNB);
          expect(result.hasDeviation).to.be.true;
          // Sentinel price (~905) > oracle price (300) → sentinel higher
          expect(result.sentinelPrice).to.be.gt(result.oraclePrice);
          expect(result.deviationPercent).to.be.gt(10);
        });

        it("should return correct deviationPercent value", async () => {
          // Set chainlink to ~50% of DEX price → expect ~100% deviation
          // DEX ≈ 905, chainlink = 450 → diff/oraclePrice = 455/450 ≈ 101%
          await chainlinkOracle.connect(timelock).setDirectPrice(WBNB, parseUnits("450", 18));

          const result = await deviationSentinel.checkPriceDeviation(vWBNB);
          expect(result.hasDeviation).to.be.true;
          // deviationPercent should be ~100 (integer division)
          expect(result.deviationPercent).to.be.gte(90);
        });
      });

      // ═════════════════════════════════════════════════════════════════
      // 5. handleDeviation — Revert Cases
      // ═════════════════════════════════════════════════════════════════

      describe("handleDeviation — revert cases", () => {
        before(async () => {
          await deviationSentinel.connect(timelock).setTokenConfig(WBNB, { deviation: 10, enabled: true });
        });

        it("should revert with UnauthorizedKeeper when caller is not trusted", async () => {
          const [, randomUser] = await ethers.getSigners();
          await expect(
            deviationSentinel.connect(randomUser).handleDeviation(vWBNB),
          ).to.be.revertedWithCustomError(deviationSentinel, "UnauthorizedKeeper");
        });

        it("should revert with TokenMonitoringDisabled when monitoring is off", async () => {
          await deviationSentinel.connect(timelock).setTokenMonitoringEnabled(WBNB, false);

          // Force deviation so the only revert reason is monitoring disabled
          await chainlinkOracle.connect(timelock).setDirectPrice(WBNB, parseUnits("3000", 18));

          await expect(
            deviationSentinel.connect(timelock).handleDeviation(vWBNB),
          ).to.be.revertedWithCustomError(deviationSentinel, "TokenMonitoringDisabled");

          // Re-enable for subsequent tests
          await deviationSentinel.connect(timelock).setTokenMonitoringEnabled(WBNB, true);
        });
      });

      // ═════════════════════════════════════════════════════════════════
      // 6. handleDeviation — Sentinel Price LOWER (CF + supply pause)
      //
      // When sentinel DEX price is lower than resilient oracle price,
      // the sentinel zeroes collateral factor and pauses MINT (supply).
      // This is the more dangerous scenario: the asset may be worth
      // less than the oracle reports, so collateral could be overvalued.
      // ═════════════════════════════════════════════════════════════════

      describe("handleDeviation — sentinel lower → zero CF + pause supply", () => {
        // Stores the original CF/LT for comparison after restore
        let originalCF: BigNumber;
        let originalLT: BigNumber;

        before(async () => {
          // Configure WBNB with 10% deviation threshold
          await deviationSentinel.connect(timelock).setTokenConfig(WBNB, { deviation: 10, enabled: true });

          // Record original pool 0 (core pool) CF and LT before any modification
          const poolData = await coreComptroller.poolMarkets(0, vWBNB);
          originalCF = poolData.collateralFactorMantissa;
          originalLT = poolData.liquidationThresholdMantissa;

          // Ensure both are non-zero so the test is meaningful
          expect(originalCF).to.be.gt(0);
          expect(originalLT).to.be.gt(0);
        });

        it("should zero CF, pause supply, and emit events on sentinel-lower deviation", async () => {
          // Artificially inflate chainlink price → resilient > sentinel → sentinel lower
          await chainlinkOracle.connect(timelock).setDirectPrice(WBNB, parseUnits("3000", 18));

          // Verify deviation exists before handling
          const check = await deviationSentinel.checkPriceDeviation(vWBNB);
          expect(check.hasDeviation).to.be.true;
          expect(check.sentinelPrice).to.be.lt(check.oraclePrice);

          // Handle deviation → should zero CF + pause supply
          const tx = deviationSentinel.connect(timelock).handleDeviation(vWBNB);
          await expect(tx).to.emit(deviationSentinel, "SupplyPaused").withArgs(vWBNB);

          // Verify on-chain state: CF zeroed in core pool (poolId=0)
          const poolData = await coreComptroller.poolMarkets(0, vWBNB);
          expect(poolData.collateralFactorMantissa).to.equal(0);

          // Verify MINT action is paused on the comptroller
          expect(await coreComptroller.actionPaused(vWBNB, 0)).to.be.true;

          // Verify sentinel's internal state tracking
          const state = await deviationSentinel.marketStates(vWBNB);
          expect(state.cfModifiedAndSupplyPaused).to.be.true;
          expect(state.borrowPaused).to.be.false;
        });

        it("should be idempotent — second call with same deviation is a no-op", async () => {
          // Same deviation still active → early return, no events
          const tx = deviationSentinel.connect(timelock).handleDeviation(vWBNB);
          await expect(tx).to.not.emit(deviationSentinel, "SupplyPaused");
        });

        it("should restore CF, unpause supply when deviation resolves", async () => {
          // Restore chainlink price to near-DEX price → no deviation
          await chainlinkOracle.connect(timelock).setDirectPrice(WBNB, parseUnits("900", 18));

          // Confirm deviation resolved
          const check = await deviationSentinel.checkPriceDeviation(vWBNB);
          expect(check.hasDeviation).to.be.false;

          // Handle → should restore CF + unpause supply
          const tx = deviationSentinel.connect(timelock).handleDeviation(vWBNB);
          await expect(tx).to.emit(deviationSentinel, "SupplyUnpaused").withArgs(vWBNB);

          // Verify CF restored to original value
          const poolData = await coreComptroller.poolMarkets(0, vWBNB);
          expect(poolData.collateralFactorMantissa).to.equal(originalCF);

          // Verify MINT action unpaused
          expect(await coreComptroller.actionPaused(vWBNB, 0)).to.be.false;

          // Verify internal state cleared
          const state = await deviationSentinel.marketStates(vWBNB);
          expect(state.cfModifiedAndSupplyPaused).to.be.false;
        });
      });

      // ═════════════════════════════════════════════════════════════════
      // 7. handleDeviation — Sentinel Price HIGHER (borrow pause)
      //
      // When sentinel DEX price is higher than resilient oracle price,
      // borrowing is paused. The asset may be worth more than reported,
      // so new borrows against it should be blocked.
      // ═════════════════════════════════════════════════════════════════

      describe("handleDeviation — sentinel higher → pause borrow", () => {
        before(async () => {
          await deviationSentinel.connect(timelock).setTokenConfig(WBNB, { deviation: 10, enabled: true });
        });

        it("should pause borrow and emit BorrowPaused on sentinel-higher deviation", async () => {
          // Artificially lower chainlink price → resilient < sentinel → sentinel higher
          await chainlinkOracle.connect(timelock).setDirectPrice(WBNB, parseUnits("300", 18));

          // Verify deviation direction
          const check = await deviationSentinel.checkPriceDeviation(vWBNB);
          expect(check.hasDeviation).to.be.true;
          expect(check.sentinelPrice).to.be.gt(check.oraclePrice);

          // Handle deviation
          const tx = deviationSentinel.connect(timelock).handleDeviation(vWBNB);
          await expect(tx).to.emit(deviationSentinel, "BorrowPaused").withArgs(vWBNB);

          // Verify BORROW action is paused (Action.BORROW = 2)
          expect(await coreComptroller.actionPaused(vWBNB, 2)).to.be.true;

          // Verify internal state
          const state = await deviationSentinel.marketStates(vWBNB);
          expect(state.borrowPaused).to.be.true;
          expect(state.cfModifiedAndSupplyPaused).to.be.false;
        });

        it("should be idempotent — second call with same deviation is a no-op", async () => {
          const tx = deviationSentinel.connect(timelock).handleDeviation(vWBNB);
          await expect(tx).to.not.emit(deviationSentinel, "BorrowPaused");
        });

        it("should unpause borrow when deviation resolves", async () => {
          // Restore price
          await chainlinkOracle.connect(timelock).setDirectPrice(WBNB, parseUnits("900", 18));

          const tx = deviationSentinel.connect(timelock).handleDeviation(vWBNB);
          await expect(tx).to.emit(deviationSentinel, "BorrowUnpaused").withArgs(vWBNB);

          expect(await coreComptroller.actionPaused(vWBNB, 2)).to.be.false;
          expect((await deviationSentinel.marketStates(vWBNB)).borrowPaused).to.be.false;
        });
      });

      // ═════════════════════════════════════════════════════════════════
      // 8. resetMarketState (on-chain)
      //
      // Verifies that resetMarketState clears the sentinel's cached
      // state and allows fresh deviation handling after governance
      // intervention.
      // ═════════════════════════════════════════════════════════════════

      describe("resetMarketState", () => {
        before(async () => {
          await deviationSentinel.connect(timelock).setTokenConfig(WBNB, { deviation: 10, enabled: true });
        });

        it("should emit MarketStateReset event", async () => {
          await expect(deviationSentinel.connect(timelock).resetMarketState(vWBNB))
            .to.emit(deviationSentinel, "MarketStateReset")
            .withArgs(vWBNB);
        });

        it("should clear borrowPaused state after borrow was paused", async () => {
          // Cause borrow pause
          await chainlinkOracle.connect(timelock).setDirectPrice(WBNB, parseUnits("300", 18));
          await deviationSentinel.connect(timelock).handleDeviation(vWBNB);
          expect((await deviationSentinel.marketStates(vWBNB)).borrowPaused).to.be.true;

          // Reset
          await deviationSentinel.connect(timelock).resetMarketState(vWBNB);
          expect((await deviationSentinel.marketStates(vWBNB)).borrowPaused).to.be.false;
        });

        it("should allow handleDeviation to re-trigger after reset (not early-return)", async () => {
          // Same deviation still active → but state was reset, so should re-pause
          const tx = deviationSentinel.connect(timelock).handleDeviation(vWBNB);
          await expect(tx).to.emit(deviationSentinel, "BorrowPaused").withArgs(vWBNB);

          // Clean up for next tests
          await chainlinkOracle.connect(timelock).setDirectPrice(WBNB, parseUnits("900", 18));
          await deviationSentinel.connect(timelock).resetMarketState(vWBNB);
        });

        it("should clear cfModifiedAndSupplyPaused state after supply was paused", async () => {
          // Cause supply pause
          await chainlinkOracle.connect(timelock).setDirectPrice(WBNB, parseUnits("3000", 18));
          await deviationSentinel.connect(timelock).handleDeviation(vWBNB);
          expect((await deviationSentinel.marketStates(vWBNB)).cfModifiedAndSupplyPaused).to.be.true;

          // Reset sentinel state (does NOT restore CF on comptroller)
          await deviationSentinel.connect(timelock).resetMarketState(vWBNB);
          expect((await deviationSentinel.marketStates(vWBNB)).cfModifiedAndSupplyPaused).to.be.false;

          // Clean up: restore chainlink price and manually restore CF on comptroller
          // (resetMarketState only clears sentinel tracking — comptroller CF stays zeroed)
          await chainlinkOracle.connect(timelock).setDirectPrice(WBNB, parseUnits("900", 18));
          const poolData = await coreComptroller.poolMarkets(0, vWBNB);
          if (poolData.collateralFactorMantissa.eq(0)) {
            const lt = poolData.liquidationThresholdMantissa;
            // Restore a reasonable CF (use 60% — below LT)
            const cf = parseUnits("0.6", 18);
            await coreComptroller
              .connect(timelock)
              ["setCollateralFactor(address,uint256,uint256)"](vWBNB, cf.lt(lt) ? cf : lt, lt);
          }
        });

        it("should revert resetMarketState for unauthorized caller", async () => {
          const [, randomUser] = await ethers.getSigners();
          await expect(deviationSentinel.connect(randomUser).resetMarketState(vWBNB)).to.be.reverted;
        });
      });

      // ═════════════════════════════════════════════════════════════════
      // 9. setTokenMonitoringEnabled (on-chain)
      // ═════════════════════════════════════════════════════════════════

      describe("setTokenMonitoringEnabled", () => {
        before(async () => {
          await deviationSentinel.connect(timelock).setTokenConfig(WBNB, { deviation: 10, enabled: true });
        });

        it("should disable monitoring and block handleDeviation", async () => {
          await deviationSentinel.connect(timelock).setTokenMonitoringEnabled(WBNB, false);
          expect((await deviationSentinel.tokenConfigs(WBNB)).enabled).to.be.false;

          // Force deviation
          await chainlinkOracle.connect(timelock).setDirectPrice(WBNB, parseUnits("3000", 18));

          await expect(
            deviationSentinel.connect(timelock).handleDeviation(vWBNB),
          ).to.be.revertedWithCustomError(deviationSentinel, "TokenMonitoringDisabled");
        });

        it("should re-enable monitoring and allow handleDeviation", async () => {
          await deviationSentinel.connect(timelock).setTokenMonitoringEnabled(WBNB, true);
          expect((await deviationSentinel.tokenConfigs(WBNB)).enabled).to.be.true;

          // Still deviated → should succeed now
          await expect(deviationSentinel.connect(timelock).handleDeviation(vWBNB))
            .to.emit(deviationSentinel, "SupplyPaused")
            .withArgs(vWBNB);

          // Clean up: restore chainlink price then resolve deviation (restores CF + unpauses supply)
          await chainlinkOracle.connect(timelock).setDirectPrice(WBNB, parseUnits("900", 18));
          await deviationSentinel.connect(timelock).handleDeviation(vWBNB); // resolve → restores CF
        });

        it("should emit TokenMonitoringStatusChanged event", async () => {
          await expect(deviationSentinel.connect(timelock).setTokenMonitoringEnabled(WBNB, false))
            .to.emit(deviationSentinel, "TokenMonitoringStatusChanged")
            .withArgs(WBNB, false);

          // Re-enable
          await deviationSentinel.connect(timelock).setTokenMonitoringEnabled(WBNB, true);
        });
      });

      // ═════════════════════════════════════════════════════════════════
      // 10. SentinelOracle Direct Price
      //
      // Uses sentinelOracle.setDirectPrice to control the sentinel
      // side independently, allowing precise deviation control without
      // relying on DEX pool states.
      // ═════════════════════════════════════════════════════════════════

      describe("SentinelOracle direct price for precise deviation control", () => {
        before(async () => {
          await deviationSentinel.connect(timelock).setTokenConfig(WBNB, { deviation: 10, enabled: true });
          // Reset chainlink to realistic price
          await chainlinkOracle.connect(timelock).setDirectPrice(WBNB, parseUnits("900", 18));
        });

        it("should detect sentinel-higher deviation via direct price override", async () => {
          // Set sentinel direct price much higher than chainlink
          await sentinelOracle.connect(timelock).setDirectPrice(WBNB, parseUnits("1500", 18));

          const result = await deviationSentinel.checkPriceDeviation(vWBNB);
          expect(result.hasDeviation).to.be.true;
          expect(result.sentinelPrice).to.be.gt(result.oraclePrice);

          // Handle → borrow pause
          await expect(deviationSentinel.connect(timelock).handleDeviation(vWBNB))
            .to.emit(deviationSentinel, "BorrowPaused")
            .withArgs(vWBNB);

          expect(await coreComptroller.actionPaused(vWBNB, 2)).to.be.true;
        });

        it("should resolve when sentinel direct price is cleared (reverts to DEX)", async () => {
          // Clear direct price (0 = use DEX oracle)
          await sentinelOracle.connect(timelock).setDirectPrice(WBNB, 0);

          // DEX price ≈ 905, chainlink = 900 → within 10% threshold
          const result = await deviationSentinel.checkPriceDeviation(vWBNB);
          expect(result.hasDeviation).to.be.false;

          // Handle → unpause borrow
          await expect(deviationSentinel.connect(timelock).handleDeviation(vWBNB))
            .to.emit(deviationSentinel, "BorrowUnpaused")
            .withArgs(vWBNB);

          expect(await coreComptroller.actionPaused(vWBNB, 2)).to.be.false;
        });

        it("should detect sentinel-lower deviation via direct price override", async () => {
          // Set sentinel direct price much lower than chainlink
          await sentinelOracle.connect(timelock).setDirectPrice(WBNB, parseUnits("400", 18));

          const result = await deviationSentinel.checkPriceDeviation(vWBNB);
          expect(result.hasDeviation).to.be.true;
          expect(result.sentinelPrice).to.be.lt(result.oraclePrice);

          // Handle → supply pause + CF zero
          await expect(deviationSentinel.connect(timelock).handleDeviation(vWBNB))
            .to.emit(deviationSentinel, "SupplyPaused")
            .withArgs(vWBNB);

          expect(await coreComptroller.actionPaused(vWBNB, 0)).to.be.true;
          expect((await coreComptroller.poolMarkets(0, vWBNB)).collateralFactorMantissa).to.equal(0);

          // Clean up
          await sentinelOracle.connect(timelock).setDirectPrice(WBNB, 0);
          await chainlinkOracle.connect(timelock).setDirectPrice(WBNB, parseUnits("900", 18));
          await deviationSentinel.connect(timelock).handleDeviation(vWBNB); // resolve
        });
      });

      // ═════════════════════════════════════════════════════════════════
      // 11. Governance Edge Cases (on-chain)
      //
      // These tests validate the stale-CF problem: if governance changes
      // the collateral factor while the sentinel has the market paused,
      // the sentinel will restore the OLD (stale) CF when deviation
      // resolves — unless resetMarketState is called first.
      // ═════════════════════════════════════════════════════════════════

      describe("Governance edge cases — stale CF restoration", () => {
        let originalCF: BigNumber;

        before(async () => {
          await deviationSentinel.connect(timelock).setTokenConfig(WBNB, { deviation: 10, enabled: true });
          // Reset any leftover state
          await deviationSentinel.connect(timelock).resetMarketState(vWBNB);
          await chainlinkOracle.connect(timelock).setDirectPrice(WBNB, parseUnits("900", 18));

          // Record original CF
          originalCF = (await coreComptroller.poolMarkets(0, vWBNB)).collateralFactorMantissa;
          expect(originalCF).to.be.gt(0);
        });

        it("should restore stale CF when governance changed CF during pause — demonstrates need for resetMarketState", async () => {
          // Step 1: Deviation → CF zeroed. Sentinel caches originalCF.
          await chainlinkOracle.connect(timelock).setDirectPrice(WBNB, parseUnits("3000", 18));
          await deviationSentinel.connect(timelock).handleDeviation(vWBNB);
          expect((await coreComptroller.poolMarkets(0, vWBNB)).collateralFactorMantissa).to.equal(0);

          // Step 2: Governance changes CF to a NEW value while sentinel has market paused.
          //         The sentinel's cached CF is now stale.
          const newGovernanceCF = parseUnits("0.5", 18);
          const currentLT = (await coreComptroller.poolMarkets(0, vWBNB)).liquidationThresholdMantissa;
          await coreComptroller
            .connect(timelock)
            ["setCollateralFactor(address,uint256,uint256)"](vWBNB, newGovernanceCF, currentLT);

          // Verify governance CF was set
          expect((await coreComptroller.poolMarkets(0, vWBNB)).collateralFactorMantissa).to.equal(newGovernanceCF);

          // Step 3: Deviation resolves → sentinel restores its CACHED (stale) CF
          await chainlinkOracle.connect(timelock).setDirectPrice(WBNB, parseUnits("900", 18));
          await deviationSentinel.connect(timelock).handleDeviation(vWBNB);

          // The sentinel restored originalCF, NOT newGovernanceCF — stale value!
          const restoredCF = (await coreComptroller.poolMarkets(0, vWBNB)).collateralFactorMantissa;
          expect(restoredCF).to.equal(originalCF);
          expect(restoredCF).to.not.equal(newGovernanceCF);
        });

        it("should NOT restore stale CF after resetMarketState — governance changes preserved", async () => {
          // Step 1: Deviation → CF zeroed
          await chainlinkOracle.connect(timelock).setDirectPrice(WBNB, parseUnits("3000", 18));
          await deviationSentinel.connect(timelock).handleDeviation(vWBNB);

          // Step 2: Governance changes CF
          const newGovernanceCF = parseUnits("0.5", 18);
          const currentLT = (await coreComptroller.poolMarkets(0, vWBNB)).liquidationThresholdMantissa;
          await coreComptroller
            .connect(timelock)
            ["setCollateralFactor(address,uint256,uint256)"](vWBNB, newGovernanceCF, currentLT);

          // Step 3: Admin resets sentinel state — clears cached CF
          await deviationSentinel.connect(timelock).resetMarketState(vWBNB);

          // Step 4: Deviation resolves → sentinel has no cached CF to restore
          await chainlinkOracle.connect(timelock).setDirectPrice(WBNB, parseUnits("900", 18));
          await deviationSentinel.connect(timelock).handleDeviation(vWBNB);

          // CF stays at governance's newGovernanceCF (sentinel didn't overwrite)
          const finalCF = (await coreComptroller.poolMarkets(0, vWBNB)).collateralFactorMantissa;
          expect(finalCF).to.equal(newGovernanceCF);
        });
      });

      // ═════════════════════════════════════════════════════════════════
      // 12. Complex State Transitions (on-chain)
      //
      // End-to-end scenarios testing deviation direction changes and
      // state machine correctness on the real comptroller.
      // ═════════════════════════════════════════════════════════════════

      describe("Complex state transitions", () => {
        before(async () => {
          await deviationSentinel.connect(timelock).setTokenConfig(WBNB, { deviation: 10, enabled: true });
          // Clean state
          await deviationSentinel.connect(timelock).resetMarketState(vWBNB);
          await chainlinkOracle.connect(timelock).setDirectPrice(WBNB, parseUnits("900", 18));
          // Ensure sentinel direct price is cleared
          await sentinelOracle.connect(timelock).setDirectPrice(WBNB, 0);
        });

        it("borrow pause → resolve → supply pause (deviation direction flips)", async () => {
          // Step 1: Sentinel higher → borrow paused
          await sentinelOracle.connect(timelock).setDirectPrice(WBNB, parseUnits("1500", 18));
          await deviationSentinel.connect(timelock).handleDeviation(vWBNB);

          let state = await deviationSentinel.marketStates(vWBNB);
          expect(state.borrowPaused).to.be.true;
          expect(state.cfModifiedAndSupplyPaused).to.be.false;
          expect(await coreComptroller.actionPaused(vWBNB, 2)).to.be.true;

          // Step 2: Resolve → borrow unpaused
          await sentinelOracle.connect(timelock).setDirectPrice(WBNB, 0); // clear → DEX price ≈ 905 ≈ chainlink 900
          await deviationSentinel.connect(timelock).handleDeviation(vWBNB);

          state = await deviationSentinel.marketStates(vWBNB);
          expect(state.borrowPaused).to.be.false;
          expect(await coreComptroller.actionPaused(vWBNB, 2)).to.be.false;

          // Step 3: Sentinel lower → supply paused + CF zeroed
          await sentinelOracle.connect(timelock).setDirectPrice(WBNB, parseUnits("400", 18));
          await deviationSentinel.connect(timelock).handleDeviation(vWBNB);

          state = await deviationSentinel.marketStates(vWBNB);
          expect(state.borrowPaused).to.be.false;
          expect(state.cfModifiedAndSupplyPaused).to.be.true;
          expect(await coreComptroller.actionPaused(vWBNB, 0)).to.be.true;
          expect((await coreComptroller.poolMarkets(0, vWBNB)).collateralFactorMantissa).to.equal(0);

          // Clean up
          await sentinelOracle.connect(timelock).setDirectPrice(WBNB, 0);
          await deviationSentinel.connect(timelock).handleDeviation(vWBNB); // resolve
        });

        it("supply pause → resolve → borrow pause (deviation direction flips)", async () => {
          // Clean state
          await deviationSentinel.connect(timelock).resetMarketState(vWBNB);

          // Step 1: Sentinel lower → supply paused + CF zeroed
          await sentinelOracle.connect(timelock).setDirectPrice(WBNB, parseUnits("400", 18));
          await deviationSentinel.connect(timelock).handleDeviation(vWBNB);

          expect((await deviationSentinel.marketStates(vWBNB)).cfModifiedAndSupplyPaused).to.be.true;

          // Step 2: Resolve
          await sentinelOracle.connect(timelock).setDirectPrice(WBNB, 0);
          await deviationSentinel.connect(timelock).handleDeviation(vWBNB);

          expect((await deviationSentinel.marketStates(vWBNB)).cfModifiedAndSupplyPaused).to.be.false;

          // Step 3: Sentinel higher → borrow paused
          await sentinelOracle.connect(timelock).setDirectPrice(WBNB, parseUnits("1500", 18));
          await deviationSentinel.connect(timelock).handleDeviation(vWBNB);

          const state = await deviationSentinel.marketStates(vWBNB);
          expect(state.borrowPaused).to.be.true;
          expect(state.cfModifiedAndSupplyPaused).to.be.false;

          // Clean up
          await sentinelOracle.connect(timelock).setDirectPrice(WBNB, 0);
          await deviationSentinel.connect(timelock).resetMarketState(vWBNB);
        });

        it("no-op when no deviation and clean state", async () => {
          // Both prices aligned → no deviation, no state changes
          const tx = deviationSentinel.connect(timelock).handleDeviation(vWBNB);
          await expect(tx).to.not.emit(deviationSentinel, "BorrowPaused");
          await expect(tx).to.not.emit(deviationSentinel, "SupplyPaused");
          await expect(tx).to.not.emit(deviationSentinel, "BorrowUnpaused");
          await expect(tx).to.not.emit(deviationSentinel, "SupplyUnpaused");

          const state = await deviationSentinel.marketStates(vWBNB);
          expect(state.borrowPaused).to.be.false;
          expect(state.cfModifiedAndSupplyPaused).to.be.false;
        });

        it("resetMarketState allows fresh pause after admin intervention", async () => {
          // Borrow pause
          await sentinelOracle.connect(timelock).setDirectPrice(WBNB, parseUnits("1500", 18));
          await deviationSentinel.connect(timelock).handleDeviation(vWBNB);
          expect((await deviationSentinel.marketStates(vWBNB)).borrowPaused).to.be.true;

          // Reset
          await deviationSentinel.connect(timelock).resetMarketState(vWBNB);

          // Same deviation → should re-trigger (not early-return)
          await expect(deviationSentinel.connect(timelock).handleDeviation(vWBNB))
            .to.emit(deviationSentinel, "BorrowPaused")
            .withArgs(vWBNB);

          // Clean up
          await sentinelOracle.connect(timelock).setDirectPrice(WBNB, 0);
          await deviationSentinel.connect(timelock).resetMarketState(vWBNB);
        });
      });

      // ═════════════════════════════════════════════════════════════════
      // 13. Emode Pool Testing
      //
      // Queries the actual lastPoolId on BSC mainnet at the fork block.
      // If emode pools exist (lastPoolId > 0), verifies CF is zeroed
      // and restored across all listed pools.
      // ═════════════════════════════════════════════════════════════════

      describe("Emode pool coverage", () => {
        let lastPoolId: number;

        before(async () => {
          lastPoolId = (await coreComptroller.lastPoolId()).toNumber();
          await deviationSentinel.connect(timelock).setTokenConfig(WBNB, { deviation: 10, enabled: true });
          // Clean state
          await deviationSentinel.connect(timelock).resetMarketState(vWBNB);
          await chainlinkOracle.connect(timelock).setDirectPrice(WBNB, parseUnits("900", 18));
          await sentinelOracle.connect(timelock).setDirectPrice(WBNB, 0);
        });

        it("should report the mainnet lastPoolId (informational)", async () => {
          const corePoolId = await coreComptroller.corePoolId();
          // Log for visibility — the number of pools determines iteration range
          // corePoolId = 0, lastPoolId = whatever exists on mainnet
          expect(corePoolId).to.equal(0);
          expect(lastPoolId).to.be.gte(0);
        });

        it("should zero CF for core pool (poolId=0) on sentinel-lower deviation", async () => {
          const originalData = await coreComptroller.poolMarkets(0, vWBNB);
          // Only run meaningful assertion if market is listed in pool 0
          if (originalData.isListed) {
            expect(originalData.collateralFactorMantissa).to.be.gt(0);

            // Cause sentinel-lower deviation
            await sentinelOracle.connect(timelock).setDirectPrice(WBNB, parseUnits("400", 18));
            await deviationSentinel.connect(timelock).handleDeviation(vWBNB);

            // Verify CF zeroed for pool 0
            const afterData = await coreComptroller.poolMarkets(0, vWBNB);
            expect(afterData.collateralFactorMantissa).to.equal(0);

            // If emode pools exist, check them too
            for (let i = 1; i <= lastPoolId; i++) {
              const poolData = await coreComptroller.poolMarkets(i, vWBNB);
              if (poolData.isListed) {
                expect(poolData.collateralFactorMantissa).to.equal(0);
              }
            }

            // Resolve and restore
            await sentinelOracle.connect(timelock).setDirectPrice(WBNB, 0);
            await deviationSentinel.connect(timelock).handleDeviation(vWBNB);

            // Verify core pool CF restored
            const restoredData = await coreComptroller.poolMarkets(0, vWBNB);
            expect(restoredData.collateralFactorMantissa).to.equal(originalData.collateralFactorMantissa);
          }
        });
      });
    });
  });
}
