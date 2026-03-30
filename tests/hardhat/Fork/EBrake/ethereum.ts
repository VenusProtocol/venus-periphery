import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { Contract } from "ethers";
import { ethers } from "hardhat";

import { EBrake } from "../../../../typechain";
import { forking, initMainnetUser } from "../utils";

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS — Ethereum Mainnet
// ═══════════════════════════════════════════════════════════════════════════

const COMPTROLLER = "0x687a01ecF6d3907658f7A7c714749fAC32336D1B";
const NORMAL_TIMELOCK = "0xd969E79406c35E80750aAae061D402Aab9325714";
const ACM = "0x230058da2D23eb8836EC5DB7037ef7250c56E25E";

const vToken = "0x7c8ff7d2A1372433726f879BD945fFb250B94c65"; // vWETH_Core
const vToken2 = "0x17C07e0c232f2f80DfDbd7a95b942D893A4C5ACb"; // vUSDC_Core

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

const FORK_ETHEREUM = process.env.FORKED_NETWORK === "ethereum";

// ═══════════════════════════════════════════════════════════════════════════
// ABIs
// ═══════════════════════════════════════════════════════════════════════════

const ACM_ABI = [
  "function giveCallPermission(address contractAddress, string calldata functionSig, address accountToPermit)",
];

const IL_COMPTROLLER_ABI = [
  "function markets(address vToken) view returns (bool isListed, uint256 collateralFactorMantissa, uint256 liquidationThresholdMantissa)",
  "function actionPaused(address vToken, uint8 action) view returns (bool)",
  "function borrowCaps(address vToken) view returns (uint256)",
  "function supplyCaps(address vToken) view returns (uint256)",
];

// ═══════════════════════════════════════════════════════════════════════════
// FIXTURE
// ═══════════════════════════════════════════════════════════════════════════

type EBrakeFixture = {
  eBrake: EBrake;
  comptroller: Contract;
  timelock: SignerWithAddress;
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

  // Deploy EBrake
  const EBrakeFactory = await ethers.getContractFactory("EBrake");
  const eBrake = (await EBrakeFactory.deploy(COMPTROLLER, ACM)) as EBrake;

  // Grant ACM permissions
  await acm.giveCallPermission(eBrake.address, "setWhitelist(address,bool)", NORMAL_TIMELOCK);
  await eBrake.connect(timelock).setWhitelist(whitelistedUser.address, true);

  // Grant EBrake permissions on comptroller
  const comptrollerPermissions = [
    "setActionsPaused(address[],uint256[],bool)",
    "setCollateralFactor(address,uint256,uint256)",
    "setMarketBorrowCaps(address[],uint256[])",
    "setMarketSupplyCaps(address[],uint256[])",
  ];
  for (const sig of comptrollerPermissions) {
    await acm.giveCallPermission(ethers.constants.AddressZero, sig, eBrake.address);
  }

  return { eBrake, comptroller, timelock, whitelistedUser, randomUser };
}

// ═══════════════════════════════════════════════════════════════════════════
// FORK TESTS
// ═══════════════════════════════════════════════════════════════════════════

if (FORK_ETHEREUM) {
  const FORK_BLOCK = 24770919;

  forking(FORK_BLOCK, () => {
    let eBrake: EBrake;
    let comptroller: Contract;
    let timelock: SignerWithAddress;
    let whitelistedUser: SignerWithAddress;
    let randomUser: SignerWithAddress;

    describe("EBrake Fork Tests (Ethereum Mainnet — IL Core Pool)", () => {
      beforeEach(async () => {
        ({ eBrake, comptroller, timelock, whitelistedUser, randomUser } = await loadFixture(deployEBrakeFixture));
      });

      // ═════════════════════════════════════════════════════════════════════
      // 1. DEPLOYMENT
      // ═════════════════════════════════════════════════════════════════════

      describe("Deployment", () => {
        it("should set COMPTROLLER immutable correctly", async () => {
          expect((await eBrake.COMPTROLLER()).toLowerCase()).to.equal(COMPTROLLER.toLowerCase());
        });
      });

      // ═════════════════════════════════════════════════════════════════════
      // 2. setCFZeroIsolated
      // ═════════════════════════════════════════════════════════════════════

      describe("setCFZeroIsolated", () => {
        it("should set CF to zero while preserving LT", async () => {
          const marketBefore = await comptroller.markets(vToken);
          expect(marketBefore.isListed).to.be.true;
          expect(marketBefore.collateralFactorMantissa).to.be.gt(0);
          expect(marketBefore.liquidationThresholdMantissa).to.be.gt(0);

          await eBrake.connect(whitelistedUser).setCFZeroIsolated(vToken);

          const marketAfter = await comptroller.markets(vToken);
          expect(marketAfter.collateralFactorMantissa).to.equal(0);
          expect(marketAfter.liquidationThresholdMantissa).to.equal(marketBefore.liquidationThresholdMantissa);
        });

        it("should revert for unlisted market", async () => {
          const fakeMarket = "0x0000000000000000000000000000000000000001";
          await expect(eBrake.connect(whitelistedUser).setCFZeroIsolated(fakeMarket)).to.be.revertedWithCustomError(
            eBrake,
            "MarketNotListed",
          );
        });

        it("should revert from non-whitelisted caller", async () => {
          await expect(eBrake.connect(randomUser).setCFZeroIsolated(vToken)).to.be.revertedWithCustomError(
            eBrake,
            "NotWhitelisted",
          );
        });
      });

      // ═════════════════════════════════════════════════════════════════════
      // 3. SINGLE MARKET PAUSING (IL)
      // ═════════════════════════════════════════════════════════════════════

      describe("Single Market Pausing", () => {
        it("setSupplyPaused should pause MINT", async () => {
          await eBrake.connect(whitelistedUser).setSupplyPaused(vToken, true);
          expect(await comptroller.actionPaused(vToken, Action.MINT)).to.be.true;
        });

        it("setBorrowPaused should pause BORROW", async () => {
          await eBrake.connect(whitelistedUser).setBorrowPaused(vToken, true);
          expect(await comptroller.actionPaused(vToken, Action.BORROW)).to.be.true;
        });

        it("setRedeemPaused should pause REDEEM", async () => {
          await eBrake.connect(whitelistedUser).setRedeemPaused(vToken, true);
          expect(await comptroller.actionPaused(vToken, Action.REDEEM)).to.be.true;
        });

        it("setTransferPaused should pause TRANSFER", async () => {
          await eBrake.connect(whitelistedUser).setTransferPaused(vToken, true);
          expect(await comptroller.actionPaused(vToken, Action.TRANSFER)).to.be.true;
        });
      });

      // ═════════════════════════════════════════════════════════════════════
      // 4. BATCH PAUSE (IL)
      // ═════════════════════════════════════════════════════════════════════

      describe("Batch Pause", () => {
        it("should pause MINT on multiple markets", async () => {
          await eBrake.connect(whitelistedUser).setActionsPaused([vToken, vToken2], [Action.MINT], true);
          expect(await comptroller.actionPaused(vToken, Action.MINT)).to.be.true;
          expect(await comptroller.actionPaused(vToken2, Action.MINT)).to.be.true;
        });

        it("should revert on forbidden action REPAY", async () => {
          await expect(
            eBrake.connect(whitelistedUser).setActionsPaused([vToken], [Action.REPAY], true),
          ).to.be.revertedWithCustomError(eBrake, "ForbiddenAction");
        });
      });

      // ═════════════════════════════════════════════════════════════════════
      // 5. BORROW CAPS (IL)
      // ═════════════════════════════════════════════════════════════════════

      describe("setMarketBorrowCaps", () => {
        it("should decrease borrow cap", async () => {
          const currentCap = await comptroller.borrowCaps(vToken);
          if (currentCap.gt(0)) {
            const newCap = currentCap.div(2);
            await eBrake.connect(whitelistedUser).setMarketBorrowCaps([vToken], [newCap]);
            expect(await comptroller.borrowCaps(vToken)).to.equal(newCap);
          }
        });

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

      // ═════════════════════════════════════════════════════════════════════
      // 6. SUPPLY CAPS (IL)
      // ═════════════════════════════════════════════════════════════════════

      describe("setMarketSupplyCaps", () => {
        it("should decrease supply cap", async () => {
          const currentCap = await comptroller.supplyCaps(vToken);
          if (currentCap.gt(0)) {
            const newCap = currentCap.div(2);
            await eBrake.connect(whitelistedUser).setMarketSupplyCaps([vToken], [newCap]);
            expect(await comptroller.supplyCaps(vToken)).to.equal(newCap);
          }
        });

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
