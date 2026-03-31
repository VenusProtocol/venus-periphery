import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { Contract } from "ethers";
import { ethers } from "hardhat";

import { EBrake } from "../../../../typechain";
import { forking, initMainnetUser } from "../utils";

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS — Arbitrum One
// ═══════════════════════════════════════════════════════════════════════════

const COMPTROLLER = "0x317c1A5739F39046E20b08ac9BeEa3f10fD43326";
const NORMAL_TIMELOCK = "0x4b94589Cc23F618687790036726f744D602c4017";
const ACM = "0xD9dD18EB0cf10CbA837677f28A8F9Bda4bc2b157";

const vToken = "0x68a34332983f4Bf866768DD6D6E638b02eF5e1f0"; // vWETH_Core
const vToken2 = "0x7D8609f8da70fF9027E9bc5229Af4F6727662707"; // vUSDC_Core

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

const FORK_NETWORK = process.env.FORKED_NETWORK === "arbitrumone";

const ACM_ABI = [
  "function giveCallPermission(address contractAddress, string calldata functionSig, address accountToPermit)",
];

const IL_COMPTROLLER_ABI = [
  "function markets(address vToken) view returns (bool isListed, uint256 collateralFactorMantissa, uint256 liquidationThresholdMantissa)",
  "function actionPaused(address vToken, uint8 action) view returns (bool)",
  "function borrowCaps(address vToken) view returns (uint256)",
  "function supplyCaps(address vToken) view returns (uint256)",
];

type EBrakeFixture = {
  eBrake: EBrake;
  comptroller: Contract;
  whitelistedUser: SignerWithAddress;
  randomUser: SignerWithAddress;
};

async function deployEBrakeFixture(): Promise<EBrakeFixture> {
  const [, randomUser] = await ethers.getSigners();
  const timelock = await initMainnetUser(NORMAL_TIMELOCK, ethers.utils.parseUnits("10"));
  const whitelistedUser = await initMainnetUser(
    "0x0000000000000000000000000000000000001234",
    ethers.utils.parseUnits("10"),
  );

  const acm = new ethers.Contract(ACM, ACM_ABI, timelock);
  const comptroller = new ethers.Contract(COMPTROLLER, IL_COMPTROLLER_ABI, timelock);

  const EBrakeFactory = await ethers.getContractFactory("EBrake");
  const eBrake = (await EBrakeFactory.deploy(COMPTROLLER, ACM)) as EBrake;

  const eBrakeFunctions = [
    "pauseActions(address[],uint8[])",
    "pauseSupply(address)",
    "pauseRedeem(address)",
    "pauseBorrow(address)",
    "pauseTransfer(address)",
    "setCFZeroIsolated(address)",
    "setMarketBorrowCaps(address[],uint256[])",
    "setMarketSupplyCaps(address[],uint256[])",
  ];
  for (const sig of eBrakeFunctions) {
    await acm.giveCallPermission(eBrake.address, sig, whitelistedUser.address);
  }

  for (const sig of [
    "setActionsPaused(address[],uint256[],bool)",
    "setCollateralFactor(address,uint256,uint256)",
    "setMarketBorrowCaps(address[],uint256[])",
    "setMarketSupplyCaps(address[],uint256[])",
  ]) {
    await acm.giveCallPermission(ethers.constants.AddressZero, sig, eBrake.address);
  }

  return { eBrake, comptroller, whitelistedUser, randomUser };
}

if (FORK_NETWORK) {
  const FORK_BLOCK = 336000000;

  forking(FORK_BLOCK, () => {
    let eBrake: EBrake;
    let comptroller: Contract;
    let whitelistedUser: SignerWithAddress;
    let randomUser: SignerWithAddress;

    describe("EBrake Fork Tests (Arbitrum One — IL Core Pool)", () => {
      beforeEach(async () => {
        ({ eBrake, comptroller, whitelistedUser, randomUser } = await loadFixture(deployEBrakeFixture));
      });

      describe("setCFZeroIsolated", () => {
        it("should set CF to zero while preserving LT", async () => {
          const marketBefore = await comptroller.markets(vToken);
          expect(marketBefore.isListed).to.be.true;
          expect(marketBefore.collateralFactorMantissa).to.be.gt(0);

          await eBrake.connect(whitelistedUser).setCFZeroIsolated(vToken);

          const marketAfter = await comptroller.markets(vToken);
          expect(marketAfter.collateralFactorMantissa).to.equal(0);
          expect(marketAfter.liquidationThresholdMantissa).to.equal(marketBefore.liquidationThresholdMantissa);
        });

        it("should revert for unlisted market", async () => {
          await expect(
            eBrake.connect(whitelistedUser).setCFZeroIsolated("0x0000000000000000000000000000000000000001"),
          ).to.be.revertedWithCustomError(eBrake, "MarketNotListed");
        });

        it("should revert from unauthorized caller", async () => {
          await expect(eBrake.connect(randomUser).setCFZeroIsolated(vToken)).to.be.revertedWithCustomError(
            eBrake,
            "Unauthorized",
          );
        });
      });

      describe("Single Market Pausing", () => {
        it("pauseSupply should pause MINT", async () => {
          await eBrake.connect(whitelistedUser).pauseSupply(vToken);
          expect(await comptroller.actionPaused(vToken, Action.MINT)).to.be.true;
        });

        it("pauseBorrow should pause BORROW", async () => {
          await eBrake.connect(whitelistedUser).pauseBorrow(vToken);
          expect(await comptroller.actionPaused(vToken, Action.BORROW)).to.be.true;
        });
      });

      describe("Batch Pause", () => {
        it("should pause MINT on multiple markets", async () => {
          await eBrake.connect(whitelistedUser).pauseActions([vToken, vToken2], [Action.MINT]);
          expect(await comptroller.actionPaused(vToken, Action.MINT)).to.be.true;
          expect(await comptroller.actionPaused(vToken2, Action.MINT)).to.be.true;
        });
      });

      describe("setMarketBorrowCaps", () => {
        it("should set borrow cap to zero", async () => {
          await eBrake.connect(whitelistedUser).setMarketBorrowCaps([vToken], [0]);
          expect(await comptroller.borrowCaps(vToken)).to.equal(0);
        });

        it("should revert when increasing borrow cap", async () => {
          const currentCap = await comptroller.borrowCaps(vToken);
          await expect(
            eBrake.connect(whitelistedUser).setMarketBorrowCaps([vToken], [currentCap.add(1)]),
          ).to.be.revertedWithCustomError(eBrake, "CapCanOnlyDecrease");
        });
      });

      describe("setMarketSupplyCaps", () => {
        it("should set supply cap to zero", async () => {
          await eBrake.connect(whitelistedUser).setMarketSupplyCaps([vToken], [0]);
          expect(await comptroller.supplyCaps(vToken)).to.equal(0);
        });

        it("should revert when increasing supply cap", async () => {
          const currentCap = await comptroller.supplyCaps(vToken);
          await expect(
            eBrake.connect(whitelistedUser).setMarketSupplyCaps([vToken], [currentCap.add(1)]),
          ).to.be.revertedWithCustomError(eBrake, "CapCanOnlyDecrease");
        });
      });
    });
  });
}
