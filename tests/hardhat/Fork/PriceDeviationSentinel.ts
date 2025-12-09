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
  IAccessControlManagerV8,
  IAccessControlManagerV8__factory,
  PriceDeviationSentinel,
  ResilientOracle,
  ResilientOracle__factory,
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
  priceDeviationSentinel: PriceDeviationSentinel;
  coreComptroller: ComptrollerMock;
  chainlinkOracle: ChainlinkOracle;
  resilientOracle: ResilientOracle;
};

const setupMarketFixture = async (): Promise<SetupMarketFixture> => {
  const timelock = await initMainnetUser(NORMAL_TIMELOCK, ethers.utils.parseUnits("2"));
  const coreComptroller = ComptrollerMock__factory.connect(COMPTROLLER, timelock);
  const chainlinkOracle = ChainlinkOracle__factory.connect(CHAINLINK_ORACLE, timelock);
  const resilientOracle = ResilientOracle__factory.connect(ORACLE, timelock);

  const priceDeviationSentinelFactory = await ethers.getContractFactory("PriceDeviationSentinel");
  const priceDeviationSentinel = await upgrades.deployProxy(priceDeviationSentinelFactory, [ACM], {
    constructorArgs: [COMPTROLLER, ORACLE],
    // To allow the usage constructor & internal functions that might change storage
    unsafeAllow: ["constructor", "internal-function-storage"],
  });

  const acm = IAccessControlManagerV8__factory.connect(ACM, timelock) as IAccessControlManagerV8;
  await acm
    .connect(timelock)
    .giveCallPermission(
      coreComptroller.address,
      "_setActionsPaused(address[],uint8[],bool)",
      priceDeviationSentinel.address,
    );
  await acm
    .connect(timelock)
    .giveCallPermission(
      coreComptroller.address,
      "setCollateralFactor(uint96,address,uint256,uint256)",
      priceDeviationSentinel.address,
    );
  await acm
    .connect(timelock)
    .giveCallPermission(
      priceDeviationSentinel.address,
      "setTokenConfig(address,(uint8,uint8,address,bool))",
      NORMAL_TIMELOCK,
    );
  await acm
    .connect(timelock)
    .giveCallPermission(priceDeviationSentinel.address, "setTrustedKeeper(address,bool)", NORMAL_TIMELOCK);

  await priceDeviationSentinel.connect(timelock).setTrustedKeeper(timelock.address, true);

  return {
    timelock,
    priceDeviationSentinel,
    coreComptroller,
    chainlinkOracle,
    resilientOracle,
  };
};

// ---------- Main Forked Test ----------
if (FORK_MAINNET) {
  const blockNumber = 70909246;
  forking(blockNumber, () => {
    let priceDeviationSentinel: PriceDeviationSentinel;
    let timelock: SignerWithAddress;
    let coreComptroller: ComptrollerMock;
    let chainlinkOracle: ChainlinkOracle;
    let resilientOracle: ResilientOracle;

    describe("PriceDeviationSentinel", () => {
      beforeEach(async () => {
        ({ priceDeviationSentinel, timelock, coreComptroller, chainlinkOracle, resilientOracle } = await loadFixture(
          setupMarketFixture,
        ));
        await priceDeviationSentinel.connect(timelock).setTokenConfig(TRX, {
          deviation: 10,
          dex: 1,
          pool: "0xF683113764E4499c473aCd38Fc4b37E71554E4aD",
          enabled: true,
        });

        await priceDeviationSentinel.connect(timelock).setTokenConfig(USDT, {
          deviation: 10,
          dex: 1,
          pool: "0x172fcD41E0913e95784454622d1c3724f546f849",
          enabled: true,
        });

        await priceDeviationSentinel.connect(timelock).setTokenConfig(BTCB, {
          deviation: 10,
          dex: 0,
          pool: "0x28dF0835942396B7a1b7aE1cd068728E6ddBbAfD",
          enabled: true,
        });
      });

      describe("check DEX prices", () => {
        it("check TRX price", async () => {
          const price = await priceDeviationSentinel["getDexPrice(address)"](TRX);
          expect(price).to.be.equal(parseUnits("0.287615712885971478", 18));
        });

        it("check USDT price", async () => {
          const price = await priceDeviationSentinel["getDexPrice(address)"](USDT);
          expect(price).to.be.equal(parseUnits("0.999676428802385649", 18));
        });

        it("check BTCB price", async () => {
          const price = await priceDeviationSentinel["getDexPrice(address)"](BTCB);
          expect(price).to.be.equal(parseUnits("91784.949423700465674501", 18));
        });
      });

      describe("check price deviation", () => {
        beforeEach(async () => {
          await priceDeviationSentinel.connect(timelock).setTokenConfig(WBNB, {
            deviation: 10,
            dex: 0,
            pool: "0x28dF0835942396B7a1b7aE1cd068728E6ddBbAfD",
            enabled: true,
          });

          await resilientOracle.connect(timelock).setTokenConfig({
            asset: WBNB,
            oracles: [CHAINLINK_ORACLE, ethers.constants.AddressZero, ethers.constants.AddressZero],
            enableFlagsForOracles: [true, false, false],
            cachingEnabled: false,
          });
        });

        it("WBNB dex price lower than chainlink price", async () => {
          await chainlinkOracle.connect(timelock).setDirectPrice(WBNB, parseUnits("3000", 18));

          let isDeviated = await priceDeviationSentinel.checkPriceDeviation(vWBNB);
          expect(isDeviated.hasDeviation).to.be.equal(true);

          await priceDeviationSentinel.connect(timelock).handleDeviation(vWBNB);

          let data = await coreComptroller.poolMarkets(0, vWBNB);
          expect(data.collateralFactorMantissa).to.be.equal(0);

          await chainlinkOracle.connect(timelock).setDirectPrice(WBNB, parseUnits("900", 18));

          isDeviated = await priceDeviationSentinel.checkPriceDeviation(vWBNB);
          expect(isDeviated.hasDeviation).to.be.equal(false);

          await priceDeviationSentinel.connect(timelock).handleDeviation(vWBNB);

          data = await coreComptroller.poolMarkets(0, vWBNB);
          expect(data.collateralFactorMantissa).to.be.not.equal(0);
        });

        it("WBNB dex price higher than chainlink price", async () => {
          await chainlinkOracle.connect(timelock).setDirectPrice(WBNB, parseUnits("300", 18));

          const isDeviated = await priceDeviationSentinel.checkPriceDeviation(vWBNB);
          expect(isDeviated.hasDeviation).to.be.equal(true);

          await priceDeviationSentinel.connect(timelock).handleDeviation(vWBNB);

          let isPaused = await coreComptroller.actionPaused(vWBNB, 2);
          expect(isPaused).to.be.equal(true);

          await chainlinkOracle.connect(timelock).setDirectPrice(WBNB, parseUnits("900", 18));

          await priceDeviationSentinel.connect(timelock).handleDeviation(vWBNB);

          isPaused = await coreComptroller.actionPaused(vWBNB, 2);
          expect(isPaused).to.be.equal(false);
        });
      });
    });
  });
}
