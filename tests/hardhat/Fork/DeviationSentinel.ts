import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
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

const setupMarketFixture = async (): Promise<SetupMarketFixture> => {
  const timelock = await initMainnetUser(NORMAL_TIMELOCK, ethers.utils.parseUnits("2"));
  const coreComptroller = ComptrollerMock__factory.connect(COMPTROLLER, timelock);
  const chainlinkOracle = ChainlinkOracle__factory.connect(CHAINLINK_ORACLE, timelock);
  const resilientOracle = ResilientOracle__factory.connect(ORACLE, timelock);

  // Deploy PancakeSwap Oracle
  const pancakeSwapOracleFactory = await ethers.getContractFactory("PancakeSwapOracle");
  const pancakeSwapOracle = (await upgrades.deployProxy(pancakeSwapOracleFactory, [ACM], {
    constructorArgs: [ORACLE],
    unsafeAllow: ["constructor", "internal-function-storage"],
  })) as PancakeSwapOracle;

  // Deploy Uniswap Oracle
  const uniswapOracleFactory = await ethers.getContractFactory("UniswapOracle");
  const uniswapOracle = (await upgrades.deployProxy(uniswapOracleFactory, [ACM], {
    constructorArgs: [ORACLE],
    unsafeAllow: ["constructor", "internal-function-storage"],
  })) as UniswapOracle;

  // Deploy Sentinel Oracle
  const sentinelOracleFactory = await ethers.getContractFactory("SentinelOracle");
  const sentinelOracle = (await upgrades.deployProxy(sentinelOracleFactory, [ACM], {
    unsafeAllow: ["constructor", "internal-function-storage"],
  })) as SentinelOracle;

  // Deploy Deviation Sentinel
  const deviationSentinelFactory = await ethers.getContractFactory("DeviationSentinel");
  const deviationSentinel = await upgrades.deployProxy(deviationSentinelFactory, [ACM], {
    constructorArgs: [COMPTROLLER, ORACLE, sentinelOracle.address],
    unsafeAllow: ["constructor", "internal-function-storage"],
  });

  const acm = IAccessControlManagerV8__factory.connect(ACM, timelock) as IAccessControlManagerV8;
  await acm
    .connect(timelock)
    .giveCallPermission(
      coreComptroller.address,
      "_setActionsPaused(address[],uint8[],bool)",
      deviationSentinel.address,
    );
  await acm
    .connect(timelock)
    .giveCallPermission(
      coreComptroller.address,
      "setCollateralFactor(uint96,address,uint256,uint256)",
      deviationSentinel.address,
    );
  await acm
    .connect(timelock)
    .giveCallPermission(deviationSentinel.address, "setTokenConfig(address,(uint8,bool))", NORMAL_TIMELOCK);
  await acm
    .connect(timelock)
    .giveCallPermission(deviationSentinel.address, "setTrustedKeeper(address,bool)", NORMAL_TIMELOCK);
  await acm
    .connect(timelock)
    .giveCallPermission(sentinelOracle.address, "setTokenOracleConfig(address,address)", NORMAL_TIMELOCK);
  await acm
    .connect(timelock)
    .giveCallPermission(pancakeSwapOracle.address, "setPoolConfig(address,address)", NORMAL_TIMELOCK);
  await acm
    .connect(timelock)
    .giveCallPermission(uniswapOracle.address, "setPoolConfig(address,address)", NORMAL_TIMELOCK);

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

// ---------- Main Forked Test ----------
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

        // Configure PancakeSwap pools
        await pancakeSwapOracle.connect(timelock).setPoolConfig(TRX, "0xF683113764E4499c473aCd38Fc4b37E71554E4aD");
        await pancakeSwapOracle.connect(timelock).setPoolConfig(USDT, "0x172fcD41E0913e95784454622d1c3724f546f849");

        // Configure Uniswap pools
        await uniswapOracle.connect(timelock).setPoolConfig(BTCB, "0x28dF0835942396B7a1b7aE1cd068728E6ddBbAfD");
        await uniswapOracle.connect(timelock).setPoolConfig(WBNB, "0x28dF0835942396B7a1b7aE1cd068728E6ddBbAfD");

        // Configure SentinelOracle to use appropriate DEX oracles
        await sentinelOracle.connect(timelock).setTokenOracleConfig(TRX, pancakeSwapOracle.address);
        await sentinelOracle.connect(timelock).setTokenOracleConfig(USDT, pancakeSwapOracle.address);
        await sentinelOracle.connect(timelock).setTokenOracleConfig(BTCB, uniswapOracle.address);
        await sentinelOracle.connect(timelock).setTokenOracleConfig(WBNB, uniswapOracle.address);

        // Configure DeviationSentinel with simplified configs
        await deviationSentinel.connect(timelock).setTokenConfig(TRX, {
          deviation: 10,
          enabled: true,
        });

        await deviationSentinel.connect(timelock).setTokenConfig(USDT, {
          deviation: 10,
          enabled: true,
        });

        await deviationSentinel.connect(timelock).setTokenConfig(BTCB, {
          deviation: 10,
          enabled: true,
        });
      });

      describe("check Sentinel Oracle prices", () => {
        it("check TRX price from PancakeSwap", async () => {
          const price = await sentinelOracle.getPrice(TRX);
          expect(price).to.be.equal(parseUnits("0.287615712885971478", 30));
        });

        it("check USDT price from PancakeSwap", async () => {
          const price = await sentinelOracle.getPrice(USDT);
          expect(price).to.be.equal(parseUnits("0.999676428802385649", 18));
        });

        it("check BTCB price from Uniswap", async () => {
          const price = await sentinelOracle.getPrice(BTCB);
          expect(price).to.be.equal(parseUnits("91784.949423700465674501", 18));
        });
      });

      describe("check price deviation", () => {
        before(async () => {
          await deviationSentinel.connect(timelock).setTokenConfig(WBNB, {
            deviation: 10,
            enabled: true,
          });

          await resilientOracle.connect(timelock).setTokenConfig({
            asset: WBNB,
            oracles: [CHAINLINK_ORACLE, ethers.constants.AddressZero, ethers.constants.AddressZero],
            enableFlagsForOracles: [true, false, false],
            cachingEnabled: false,
          });

          let tokenConfig = await chainlinkOracle.tokenConfigs(BTCB);
          await chainlinkOracle.connect(timelock).setTokenConfig({
            asset: BTCB,
            feed: tokenConfig.feed,
            maxStalePeriod: 25 * 60 * 60,
          });

          tokenConfig = await chainlinkOracle.tokenConfigs(WBNB);
          await chainlinkOracle.connect(timelock).setTokenConfig({
            asset: WBNB,
            feed: tokenConfig.feed,
            maxStalePeriod: 25 * 60 * 60,
          });
        });

        it("WBNB sentinel price lower than resilient oracle price", async () => {
          await chainlinkOracle.connect(timelock).setDirectPrice(WBNB, parseUnits("3000", 18));

          let isDeviated = await deviationSentinel.checkPriceDeviation(vWBNB);
          expect(isDeviated.hasDeviation).to.be.equal(true);

          await deviationSentinel.connect(timelock).handleDeviation(vWBNB);

          let data = await coreComptroller.poolMarkets(0, vWBNB);
          expect(data.collateralFactorMantissa).to.be.equal(0);

          let isPaused = await coreComptroller.actionPaused(vWBNB, 0);
          expect(isPaused).to.be.equal(true);

          await chainlinkOracle.connect(timelock).setDirectPrice(WBNB, parseUnits("900", 18));

          isDeviated = await deviationSentinel.checkPriceDeviation(vWBNB);
          expect(isDeviated.hasDeviation).to.be.equal(false);

          await deviationSentinel.connect(timelock).handleDeviation(vWBNB);

          data = await coreComptroller.poolMarkets(0, vWBNB);
          expect(data.collateralFactorMantissa).to.be.not.equal(0);

          isPaused = await coreComptroller.actionPaused(vWBNB, 0);
          expect(isPaused).to.be.equal(false);
        });

        it("WBNB sentinel price higher than resilient oracle price", async () => {
          await chainlinkOracle.connect(timelock).setDirectPrice(WBNB, parseUnits("300", 18));

          const isDeviated = await deviationSentinel.checkPriceDeviation(vWBNB);
          expect(isDeviated.hasDeviation).to.be.equal(true);

          await deviationSentinel.connect(timelock).handleDeviation(vWBNB);

          let isPaused = await coreComptroller.actionPaused(vWBNB, 2);
          expect(isPaused).to.be.equal(true);

          await chainlinkOracle.connect(timelock).setDirectPrice(WBNB, parseUnits("900", 18));

          await deviationSentinel.connect(timelock).handleDeviation(vWBNB);

          isPaused = await coreComptroller.actionPaused(vWBNB, 2);
          expect(isPaused).to.be.equal(false);
        });
      });
    });
  });
}
