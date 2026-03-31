import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { Contract } from "ethers";
import { ethers } from "hardhat";

import { EBrake } from "../../../../typechain";
import { forking, initMainnetUser } from "../utils";

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const COMPTROLLER = "0xfd36e2c2a6789db23113685031d7f16329158384";
const NORMAL_TIMELOCK = "0x939bD8d64c0A9583A7Dcea9933f7b21697ab6396";
const ACM = "0x4788629abc6cfca10f9f969efdeaa1cf70c23555";

const vBTCB = "0x882C173bC7Ff3b7786CA16dfeD3DFFfb9Ee7847B";
const vUSDT = "0xfD5840Cd36d94D7229439859C0112a4185BC0255";

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

const CORE_POOL_ID = 0;

const FORK_MAINNET = process.env.FORKED_NETWORK === "bscmainnet";

// ═══════════════════════════════════════════════════════════════════════════
// ABIs
// ═══════════════════════════════════════════════════════════════════════════

const ACM_ABI = [
  "function giveCallPermission(address contractAddress, string calldata functionSig, address accountToPermit)",
];

const COMPTROLLER_ABI = [
  "function actionPaused(address vToken, uint8 action) view returns (bool)",
  "function borrowCaps(address vToken) view returns (uint256)",
  "function supplyCaps(address vToken) view returns (uint256)",
  "function poolMarkets(uint96 poolId, address vToken) view returns (bool isListed, uint256 collateralFactorMantissa, bool isVenus, uint256 liquidationThresholdMantissa, uint256 liquidationIncentiveMantissa, uint96 marketPoolId, bool isBorrowAllowed)",
  "function setActionsPaused(address[] calldata markets, uint8[] calldata actions, bool paused)",
  "function setFlashLoanPaused(bool paused)",
  "function flashLoanPaused() view returns (bool)",
  "function lastPoolId() view returns (uint96)",
];

// ═══════════════════════════════════════════════════════════════════════════
// FIXTURE
// ═══════════════════════════════════════════════════════════════════════════

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
  const comptroller = new ethers.Contract(COMPTROLLER, COMPTROLLER_ABI, timelock);

  // Deploy EBrake
  const EBrakeFactory = await ethers.getContractFactory("EBrake");
  const eBrake = (await EBrakeFactory.deploy(COMPTROLLER, ACM)) as EBrake;

  // Grant whitelistedUser ACM permissions on EBrake functions
  const eBrakeFunctions = [
    "pauseActions(address[],uint8[])",
    "pauseSupply(address)",
    "pauseRedeem(address)",
    "pauseBorrow(address)",
    "pauseTransfer(address)",
    "pauseFlashLoan()",
    "setCFZero(address,uint96)",
    "setCFZeroIsolated(address)",
    "setMarketBorrowCaps(address[],uint256[])",
    "setMarketSupplyCaps(address[],uint256[])",
  ];
  for (const sig of eBrakeFunctions) {
    await acm.giveCallPermission(eBrake.address, sig, whitelistedUser.address);
  }

  // Grant EBrake permissions on comptroller (AddressZero = all comptrollers)
  const comptrollerPermissions = [
    "_setActionsPaused(address[],uint8[],bool)",
    "setCollateralFactor(uint96,address,uint256,uint256)",
    "_setMarketBorrowCaps(address[],uint256[])",
    "_setMarketSupplyCaps(address[],uint256[])",
    "setFlashLoanPaused(bool)",
  ];
  for (const sig of comptrollerPermissions) {
    await acm.giveCallPermission(ethers.constants.AddressZero, sig, eBrake.address);
  }

  return { eBrake, comptroller, whitelistedUser, randomUser };
}

// ═══════════════════════════════════════════════════════════════════════════
// FORK TESTS
// ═══════════════════════════════════════════════════════════════════════════

if (FORK_MAINNET) {
  const FORK_BLOCK = 89587508;

  forking(FORK_BLOCK, () => {
    let eBrake: EBrake;
    let comptroller: Contract;
    let whitelistedUser: SignerWithAddress;
    let randomUser: SignerWithAddress;

    describe("EBrake Fork Tests (BSC Mainnet)", () => {
      beforeEach(async () => {
        ({ eBrake, comptroller, whitelistedUser, randomUser } = await loadFixture(deployEBrakeFixture));
      });

      // ═════════════════════════════════════════════════════════════════════
      // 1. DEPLOYMENT & CONSTRUCTOR
      // ═════════════════════════════════════════════════════════════════════

      describe("Deployment & Constructor", () => {
        it("should set COMPTROLLER immutable correctly", async () => {
          expect((await eBrake.COMPTROLLER()).toLowerCase()).to.equal(COMPTROLLER.toLowerCase());
        });

        it("should revert deployment with zero comptroller", async () => {
          const EBrakeFactory = await ethers.getContractFactory("EBrake");
          await expect(EBrakeFactory.deploy(ethers.constants.AddressZero, ACM)).to.be.revertedWithCustomError(
            eBrake,
            "ZeroAddress",
          );
        });

        it("should revert deployment with zero ACM", async () => {
          const EBrakeFactory = await ethers.getContractFactory("EBrake");
          await expect(EBrakeFactory.deploy(COMPTROLLER, ethers.constants.AddressZero)).to.be.revertedWithCustomError(
            eBrake,
            "ZeroAddress",
          );
        });
      });

      // ═════════════════════════════════════════════════════════════════════
      // 2. ACCESS CONTROL — ACM per-function
      // ═════════════════════════════════════════════════════════════════════

      describe("Access Control — ACM per-function", () => {
        it("should revert pauseActions from unauthorized caller", async () => {
          await expect(eBrake.connect(randomUser).pauseActions([vBTCB], [Action.MINT])).to.be.revertedWithCustomError(
            eBrake,
            "Unauthorized",
          );
        });

        it("should revert pauseSupply from unauthorized caller", async () => {
          await expect(eBrake.connect(randomUser).pauseSupply(vBTCB)).to.be.revertedWithCustomError(
            eBrake,
            "Unauthorized",
          );
        });

        it("should revert pauseBorrow from unauthorized caller", async () => {
          await expect(eBrake.connect(randomUser).pauseBorrow(vBTCB)).to.be.revertedWithCustomError(
            eBrake,
            "Unauthorized",
          );
        });

        it("should revert pauseRedeem from unauthorized caller", async () => {
          await expect(eBrake.connect(randomUser).pauseRedeem(vBTCB)).to.be.revertedWithCustomError(
            eBrake,
            "Unauthorized",
          );
        });

        it("should revert pauseTransfer from unauthorized caller", async () => {
          await expect(eBrake.connect(randomUser).pauseTransfer(vBTCB)).to.be.revertedWithCustomError(
            eBrake,
            "Unauthorized",
          );
        });

        it("should revert pauseFlashLoan from unauthorized caller", async () => {
          await expect(eBrake.connect(randomUser).pauseFlashLoan()).to.be.revertedWithCustomError(
            eBrake,
            "Unauthorized",
          );
        });

        it("should revert setCFZero from unauthorized caller", async () => {
          await expect(eBrake.connect(randomUser).setCFZero(vBTCB, CORE_POOL_ID)).to.be.revertedWithCustomError(
            eBrake,
            "Unauthorized",
          );
        });

        it("should revert setMarketBorrowCaps from unauthorized caller", async () => {
          await expect(eBrake.connect(randomUser).setMarketBorrowCaps([vBTCB], [0])).to.be.revertedWithCustomError(
            eBrake,
            "Unauthorized",
          );
        });

        it("should revert setMarketSupplyCaps from unauthorized caller", async () => {
          await expect(eBrake.connect(randomUser).setMarketSupplyCaps([vBTCB], [0])).to.be.revertedWithCustomError(
            eBrake,
            "Unauthorized",
          );
        });
      });

      // ═════════════════════════════════════════════════════════════════════
      // 4. BATCH PAUSE — pauseActions
      // ═════════════════════════════════════════════════════════════════════

      describe("Batch Pause — pauseActions", () => {
        it("should pause MINT on multiple markets", async () => {
          await eBrake.connect(whitelistedUser).pauseActions([vBTCB, vUSDT], [Action.MINT]);

          expect(await comptroller.actionPaused(vBTCB, Action.MINT)).to.be.true;
          expect(await comptroller.actionPaused(vUSDT, Action.MINT)).to.be.true;
        });

        it("should pause multiple actions on a market", async () => {
          await eBrake.connect(whitelistedUser).pauseActions([vBTCB], [Action.MINT, Action.BORROW, Action.TRANSFER]);

          expect(await comptroller.actionPaused(vBTCB, Action.MINT)).to.be.true;
          expect(await comptroller.actionPaused(vBTCB, Action.BORROW)).to.be.true;
          expect(await comptroller.actionPaused(vBTCB, Action.TRANSFER)).to.be.true;
        });

        // Forbidden actions — REPAY, SEIZE, LIQUIDATE, ENTER_MARKET, EXIT_MARKET
        const forbiddenActions = [
          { name: "REPAY", value: Action.REPAY },
          { name: "SEIZE", value: Action.SEIZE },
          { name: "LIQUIDATE", value: Action.LIQUIDATE },
          { name: "ENTER_MARKET", value: Action.ENTER_MARKET },
          { name: "EXIT_MARKET", value: Action.EXIT_MARKET },
        ];

        for (const { name, value } of forbiddenActions) {
          it(`should revert on forbidden action ${name}`, async () => {
            await expect(eBrake.connect(whitelistedUser).pauseActions([vBTCB], [value])).to.be.revertedWithCustomError(
              eBrake,
              "ForbiddenAction",
            );
          });
        }

        it("should revert on mixed allowed + forbidden actions in batch", async () => {
          await expect(
            eBrake.connect(whitelistedUser).pauseActions([vBTCB], [Action.MINT, Action.REPAY]),
          ).to.be.revertedWithCustomError(eBrake, "ForbiddenAction");
        });

        it("should revert on empty markets array", async () => {
          await expect(eBrake.connect(whitelistedUser).pauseActions([], [Action.MINT])).to.be.revertedWithCustomError(
            eBrake,
            "EmptyArray",
          );
        });

        it("should revert on empty actions array", async () => {
          await expect(eBrake.connect(whitelistedUser).pauseActions([vBTCB], [])).to.be.revertedWithCustomError(
            eBrake,
            "EmptyArray",
          );
        });
      });

      // ═════════════════════════════════════════════════════════════════════
      // 5. SINGLE MARKET PAUSING
      // ═════════════════════════════════════════════════════════════════════

      describe("Single Market Pausing", () => {
        const pauseFunctions = [
          { name: "pauseSupply", action: Action.MINT, fn: "pauseSupply" as const },
          { name: "pauseRedeem", action: Action.REDEEM, fn: "pauseRedeem" as const },
          { name: "pauseBorrow", action: Action.BORROW, fn: "pauseBorrow" as const },
          { name: "pauseTransfer", action: Action.TRANSFER, fn: "pauseTransfer" as const },
        ];

        for (const { name, action, fn } of pauseFunctions) {
          it(`${name} should pause and verify on comptroller`, async () => {
            await eBrake.connect(whitelistedUser)[fn](vBTCB);
            expect(await comptroller.actionPaused(vBTCB, action)).to.be.true;
          });
        }
      });

      // ═════════════════════════════════════════════════════════════════════
      // 6. FLASH LOAN PAUSING
      // ═════════════════════════════════════════════════════════════════════

      describe("Flash Loan Pausing", () => {
        it("should pause flash loans on comptroller", async () => {
          await eBrake.connect(whitelistedUser).pauseFlashLoan();
          expect(await comptroller.flashLoanPaused()).to.be.true;
        });
      });

      // ═════════════════════════════════════════════════════════════════════
      // 7. SET CF ZERO
      // ═════════════════════════════════════════════════════════════════════

      describe("setCFZero", () => {
        it("should set collateral factor to zero while preserving LT", async () => {
          const marketBefore = await comptroller.poolMarkets(CORE_POOL_ID, vBTCB);
          expect(marketBefore.collateralFactorMantissa).to.be.gt(0);
          expect(marketBefore.liquidationThresholdMantissa).to.be.gt(0);

          await eBrake.connect(whitelistedUser).setCFZero(vBTCB, CORE_POOL_ID);

          const marketAfter = await comptroller.poolMarkets(CORE_POOL_ID, vBTCB);
          expect(marketAfter.collateralFactorMantissa).to.equal(0);
          expect(marketAfter.liquidationThresholdMantissa).to.equal(marketBefore.liquidationThresholdMantissa);
        });

        it("should revert for unlisted market", async () => {
          const fakeMarket = "0x0000000000000000000000000000000000000001";
          await expect(
            eBrake.connect(whitelistedUser).setCFZero(fakeMarket, CORE_POOL_ID),
          ).to.be.revertedWithCustomError(eBrake, "MarketNotListed");
        });

        it("should revert for invalid pool ID", async () => {
          await expect(eBrake.connect(whitelistedUser).setCFZero(vBTCB, 999)).to.be.reverted;
        });

        it("should set CF to zero on e-mode pool (poolId=4, vUSDT)", async () => {
          const EMODE_POOL_ID = 4;
          const marketBefore = await comptroller.poolMarkets(EMODE_POOL_ID, vUSDT);
          expect(marketBefore.isListed).to.be.true;
          expect(marketBefore.collateralFactorMantissa).to.be.gt(0);

          await eBrake.connect(whitelistedUser).setCFZero(vUSDT, EMODE_POOL_ID);

          const marketAfter = await comptroller.poolMarkets(EMODE_POOL_ID, vUSDT);
          expect(marketAfter.collateralFactorMantissa).to.equal(0);
          expect(marketAfter.liquidationThresholdMantissa).to.equal(marketBefore.liquidationThresholdMantissa);
        });

        it("should revert setCFZero on e-mode pool where market is not listed (poolId=1, vBTCB)", async () => {
          await expect(eBrake.connect(whitelistedUser).setCFZero(vBTCB, 1)).to.be.revertedWithCustomError(
            eBrake,
            "MarketNotListed",
          );
        });
      });

      // ═════════════════════════════════════════════════════════════════════
      // 8. BORROW CAPS
      // ═════════════════════════════════════════════════════════════════════

      describe("setMarketBorrowCaps", () => {
        it("should decrease borrow cap to half", async () => {
          const currentCap = await comptroller.borrowCaps(vBTCB);
          expect(currentCap).to.be.gt(0);

          const newCap = currentCap.div(2);
          await eBrake.connect(whitelistedUser).setMarketBorrowCaps([vBTCB], [newCap]);
          expect(await comptroller.borrowCaps(vBTCB)).to.equal(newCap);
        });

        it("should set borrow cap to zero", async () => {
          await eBrake.connect(whitelistedUser).setMarketBorrowCaps([vBTCB], [0]);
          expect(await comptroller.borrowCaps(vBTCB)).to.equal(0);
        });

        it("should revert when increasing borrow cap", async () => {
          const currentCap = await comptroller.borrowCaps(vBTCB);
          await expect(
            eBrake.connect(whitelistedUser).setMarketBorrowCaps([vBTCB], [currentCap.add(1)]),
          ).to.be.revertedWithCustomError(eBrake, "CapCanOnlyDecrease");
        });

        it("should revert when setting same borrow cap", async () => {
          const currentCap = await comptroller.borrowCaps(vBTCB);
          await expect(
            eBrake.connect(whitelistedUser).setMarketBorrowCaps([vBTCB], [currentCap]),
          ).to.be.revertedWithCustomError(eBrake, "CapCanOnlyDecrease");
        });

        it("should handle multiple markets", async () => {
          await eBrake.connect(whitelistedUser).setMarketBorrowCaps([vBTCB, vUSDT], [0, 0]);
          expect(await comptroller.borrowCaps(vBTCB)).to.equal(0);
          expect(await comptroller.borrowCaps(vUSDT)).to.equal(0);
        });

        it("should revert on empty array", async () => {
          await expect(eBrake.connect(whitelistedUser).setMarketBorrowCaps([], [])).to.be.revertedWithCustomError(
            eBrake,
            "EmptyArray",
          );
        });

        it("should revert on length mismatch", async () => {
          await expect(
            eBrake.connect(whitelistedUser).setMarketBorrowCaps([vBTCB, vUSDT], [0]),
          ).to.be.revertedWithCustomError(eBrake, "ArrayLengthMismatch");
        });

        it("should skip markets where current cap is already 0", async () => {
          // Zero vBTCB cap first
          await eBrake.connect(whitelistedUser).setMarketBorrowCaps([vBTCB], [0]);
          expect(await comptroller.borrowCaps(vBTCB)).to.equal(0);

          // Batch with already-zeroed vBTCB and non-zero vUSDT — should not revert
          await expect(eBrake.connect(whitelistedUser).setMarketBorrowCaps([vBTCB, vUSDT], [0, 0])).to.not.be.reverted;
        });
      });

      // ═════════════════════════════════════════════════════════════════════
      // 9. SUPPLY CAPS
      // ═════════════════════════════════════════════════════════════════════

      describe("setMarketSupplyCaps", () => {
        it("should decrease supply cap to half", async () => {
          const currentCap = await comptroller.supplyCaps(vBTCB);
          expect(currentCap).to.be.gt(0);

          const newCap = currentCap.div(2);
          await eBrake.connect(whitelistedUser).setMarketSupplyCaps([vBTCB], [newCap]);
          expect(await comptroller.supplyCaps(vBTCB)).to.equal(newCap);
        });

        it("should set supply cap to zero", async () => {
          await eBrake.connect(whitelistedUser).setMarketSupplyCaps([vBTCB], [0]);
          expect(await comptroller.supplyCaps(vBTCB)).to.equal(0);
        });

        it("should revert when increasing supply cap", async () => {
          const currentCap = await comptroller.supplyCaps(vBTCB);
          await expect(
            eBrake.connect(whitelistedUser).setMarketSupplyCaps([vBTCB], [currentCap.add(1)]),
          ).to.be.revertedWithCustomError(eBrake, "CapCanOnlyDecrease");
        });

        it("should revert when setting same supply cap", async () => {
          const currentCap = await comptroller.supplyCaps(vBTCB);
          await expect(
            eBrake.connect(whitelistedUser).setMarketSupplyCaps([vBTCB], [currentCap]),
          ).to.be.revertedWithCustomError(eBrake, "CapCanOnlyDecrease");
        });

        it("should handle multiple markets", async () => {
          await eBrake.connect(whitelistedUser).setMarketSupplyCaps([vBTCB, vUSDT], [0, 0]);
          expect(await comptroller.supplyCaps(vBTCB)).to.equal(0);
          expect(await comptroller.supplyCaps(vUSDT)).to.equal(0);
        });

        it("should revert on empty array", async () => {
          await expect(eBrake.connect(whitelistedUser).setMarketSupplyCaps([], [])).to.be.revertedWithCustomError(
            eBrake,
            "EmptyArray",
          );
        });

        it("should revert on length mismatch", async () => {
          await expect(
            eBrake.connect(whitelistedUser).setMarketSupplyCaps([vBTCB, vUSDT], [0]),
          ).to.be.revertedWithCustomError(eBrake, "ArrayLengthMismatch");
        });

        it("should skip markets where current cap is already 0", async () => {
          await eBrake.connect(whitelistedUser).setMarketSupplyCaps([vBTCB], [0]);
          expect(await comptroller.supplyCaps(vBTCB)).to.equal(0);

          await expect(eBrake.connect(whitelistedUser).setMarketSupplyCaps([vBTCB, vUSDT], [0, 0])).to.not.be.reverted;
        });
      });
    });
  });
}
