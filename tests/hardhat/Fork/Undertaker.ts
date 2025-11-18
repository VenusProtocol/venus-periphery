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
  Undertaker,
  VToken,
  VToken__factory,
} from "../../../typechain";
import { forking, initMainnetUser } from "./utils";

const COMPTROLLER_ADDRESS = "0xfd36e2c2a6789db23113685031d7f16329158384";
const NORMAL_TIMELOCK = "0x939bD8d64c0A9583A7Dcea9933f7b21697ab6396";
const ACM = "0x4788629abc6cfca10f9f969efdeaa1cf70c23555";
const vUSDe_ADDRESS = "0x74ca6930108F775CC667894EEa33843e691680d7";

const FORK_MAINNET = process.env.FORKED_NETWORK === "bscmainnet";

type SetupMarketFixture = {
  timelock: SignerWithAddress;
  undertaker: Undertaker;
  coreComptroller: ComptrollerMock;
  vUSDe: VToken;
};

const setupMarketFixture = async (): Promise<SetupMarketFixture> => {
  const timelock = await initMainnetUser(NORMAL_TIMELOCK, ethers.utils.parseUnits("2"));
  const coreComptroller = ComptrollerMock__factory.connect(COMPTROLLER_ADDRESS, timelock);
  const vUSDe = VToken__factory.connect(vUSDe_ADDRESS, timelock);

  const undertakerFactory = await ethers.getContractFactory("Undertaker");
  const undertaker = await undertakerFactory.connect(timelock).deploy(COMPTROLLER_ADDRESS);
  await undertaker.deployed();

  const acm = IAccessControlManagerV8__factory.connect(ACM, timelock) as IAccessControlManagerV8;
  await acm
    .connect(timelock)
    .giveCallPermission(coreComptroller.address, "_setMarketBorrowCaps(address[],uint256[])", undertaker.address);
  await acm
    .connect(timelock)
    .giveCallPermission(coreComptroller.address, "_setMarketSupplyCaps(address[],uint256[])", undertaker.address);
  await acm
    .connect(timelock)
    .giveCallPermission(coreComptroller.address, "_setActionsPaused(address[],uint8[],bool)", undertaker.address);
  await acm
    .connect(timelock)
    .giveCallPermission(
      coreComptroller.address,
      "setCollateralFactor(uint96,address,uint256,uint256)",
      undertaker.address,
    );

  await acm.connect(timelock).giveCallPermission(coreComptroller.address, "unlistMarket(address)", undertaker.address);

  return {
    timelock,
    undertaker,
    coreComptroller,
    vUSDe,
  };
};

// ---------- Main Forked Test ----------
if (FORK_MAINNET) {
  const blockNumber = 68647113;
  forking(blockNumber, () => {
    let undertaker: Undertaker;
    let vUSDe: VToken;
    let timelock: SignerWithAddress;

    describe("Undertaker", () => {
      beforeEach(async () => {
        ({ undertaker, vUSDe, timelock } = await loadFixture(setupMarketFixture));
      });

      describe("Pause", () => {
        it("pause market after expiry", async () => {
          expect(await undertaker.canPauseMarket(vUSDe.address)).to.be.false;

          await undertaker
            .connect(timelock)
            .setMarketExpiry(vUSDe.address, (await ethers.provider.getBlock(blockNumber)).timestamp + 10, false, 0);

          await ethers.provider.send("evm_increaseTime", [20]);
          await ethers.provider.send("evm_mine", []);

          expect(await undertaker.canPauseMarket(vUSDe.address)).to.be.true;

          await undertaker.pauseMarket(vUSDe.address);
          expect(await undertaker.isMarketPaused(vUSDe.address)).to.be.true;
        });

        it("pause market when deposits fall below threshold", async () => {
          await undertaker.connect(timelock).setGlobalDepositThreshold(parseEther("100"));
          expect(await undertaker.canPauseMarket(vUSDe.address)).to.be.false;

          await undertaker.connect(timelock).setGlobalDepositThreshold(parseEther("1000000000"));

          expect(await undertaker.canPauseMarket(vUSDe.address)).to.be.true;

          await undertaker.pauseMarket(vUSDe.address);
          expect(await undertaker.isMarketPaused(vUSDe.address)).to.be.true;
        });
      });

      describe("Unlist", () => {
        it("unlist a paused market", async () => {
          await undertaker
            .connect(timelock)
            .setMarketExpiry(
              vUSDe.address,
              (await ethers.provider.getBlock(blockNumber)).timestamp + 10,
              true,
              parseEther("1000000000"),
            );

          await ethers.provider.send("evm_increaseTime", [20]);
          await ethers.provider.send("evm_mine", []);

          await undertaker.pauseMarket(vUSDe.address);

          expect(await undertaker.canUnlistMarket(vUSDe.address)).to.be.true;

          await undertaker.unlistMarket(vUSDe.address);
          expect(await undertaker.canUnlistMarket(vUSDe.address)).to.be.false;
        });
      });
    });
  });
}
