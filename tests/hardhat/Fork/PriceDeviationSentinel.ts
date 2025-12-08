import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { parseEther } from "ethers/lib/utils";
import { ethers } from "hardhat";

import {
  ComptrollerMock,
  ComptrollerMock__factory,
  IAccessControlManagerV8,
  IAccessControlManagerV8__factory,
  PriceDeviationSentinel,
  VToken,
  VToken__factory,
} from "../../../typechain";
import { forking, initMainnetUser } from "./utils";

const COMPTROLLER_ADDRESS = "0xfd36e2c2a6789db23113685031d7f16329158384";
const NORMAL_TIMELOCK = "0x939bD8d64c0A9583A7Dcea9933f7b21697ab6396";
const ACM = "0x4788629abc6cfca10f9f969efdeaa1cf70c23555";
const TRX_ADDRESS = "0xCE7de646e7208a4Ef112cb6ed5038FA6cC6b12e3";
const AAVE_ADDRESS = "0xfb6115445Bff7b52FeB98650C87f44907E58f802";

const FORK_MAINNET = process.env.FORKED_NETWORK === "bscmainnet";

type SetupMarketFixture = {
  timelock: SignerWithAddress;
  priceDeviationSentinel: PriceDeviationSentinel;
  coreComptroller: ComptrollerMock;
  vUSDe: VToken;
};

const setupMarketFixture = async (): Promise<SetupMarketFixture> => {
  const timelock = await initMainnetUser(NORMAL_TIMELOCK, ethers.utils.parseUnits("2"));
  const coreComptroller = ComptrollerMock__factory.connect(COMPTROLLER_ADDRESS, timelock);

  const priceDeviationSentinelFactory = await ethers.getContractFactory("PriceDeviationSentinel");
  const priceDeviationSentinel = await priceDeviationSentinelFactory.connect(timelock).deploy(COMPTROLLER_ADDRESS);
  await priceDeviationSentinel.deployed();

  const acm = IAccessControlManagerV8__factory.connect(ACM, timelock) as IAccessControlManagerV8;
  await acm
    .connect(timelock)
    .giveCallPermission(coreComptroller.address, "_setActionsPaused(address[],uint8[],bool)", priceDeviationSentinel.address);
  await acm
    .connect(timelock)
    .giveCallPermission(
      coreComptroller.address,
      "setCollateralFactor(uint96,address,uint256,uint256)",
      priceDeviationSentinel.address,
    );

  return {
    timelock,
    priceDeviationSentinel,
    coreComptroller,
  };
};

// ---------- Main Forked Test ----------
if (FORK_MAINNET) {
  const blockNumber = 70909246;
  forking(blockNumber, () => {
    let priceDeviationSentinel: PriceDeviationSentinel;
    let timelock: SignerWithAddress;

    describe("PriceDeviationSentinel", () => {
      beforeEach(async () => {
        ({ priceDeviationSentinel, timelock } = await loadFixture(setupMarketFixture));

        // setTokenConfig for TRX
        await priceDeviationSentinel
          .connect(timelock)
          .setTokenConfig(TRX_ADDRESS, {
            deviation: 10,
            dex: 1,
            pool: "0xF683113764E4499c473aCd38Fc4b37E71554E4aD"
          });
      });

      describe("check DEX prices", () => {
        it("check TRX price", async () => {
          const price = await priceDeviationSentinel["getDexPrice(address)"](TRX_ADDRESS);
          console.log("TRX DEX Price:", ethers.utils.formatUnits(price, 18));
        });
      });
    });
  });
}