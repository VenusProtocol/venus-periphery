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
  ResilientOracle,
  ResilientOracle__factory,
  SentinelOracle,
  UniswapOracle,
} from "../../../typechain";
import { forking, initMainnetUser } from "./utils";

const COMPTROLLER = "0xfd36e2c2a6789db23113685031d7f16329158384";
const NORMAL_TIMELOCK = "0x939bD8d64c0A9583A7Dcea9933f7b21697ab6396";
const ACM = "0x4788629abc6cfca10f9f969efdeaa1cf70c23555";
const ORACLE = "0x6592b5DE802159F3E74B2486b091D11a8256ab8A";
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
  uniswapOracle: UniswapOracle;
};

const setupMarketFixture = async (): Promise<SetupMarketFixture> => {
  const timelock = await initMainnetUser(NORMAL_TIMELOCK, ethers.utils.parseUnits("2"));
  const coreComptroller = ComptrollerMock__factory.connect(COMPTROLLER, timelock);
  const chainlinkOracle = ChainlinkOracle__factory.connect(CHAINLINK_ORACLE, timelock);
  const resilientOracle = ResilientOracle__factory.connect(ORACLE, timelock);

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
    .giveCallPermission(uniswapOracle.address, "setPoolConfig(address,address)", NORMAL_TIMELOCK);

  await deviationSentinel.connect(timelock).setTrustedKeeper(timelock.address, true);

  return {
    timelock,
    deviationSentinel,
    coreComptroller,
    chainlinkOracle,
    resilientOracle,
    sentinelOracle,
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
    let uniswapOracle: UniswapOracle;

    describe("DeviationSentinel", () => {
      beforeEach(async () => {
        ({
          deviationSentinel,
          timelock,
          coreComptroller,
          chainlinkOracle,
          resilientOracle,
          sentinelOracle,
          uniswapOracle,
        } = await loadFixture(setupMarketFixture));

        await uniswapOracle.connect(timelock).setPoolConfig(WBNB, "0x28dF0835942396B7a1b7aE1cd068728E6ddBbAfD");
        await sentinelOracle.connect(timelock).setTokenOracleConfig(WBNB, uniswapOracle.address);
      });

      describe("check price deviation", () => {
        beforeEach(async () => {
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
