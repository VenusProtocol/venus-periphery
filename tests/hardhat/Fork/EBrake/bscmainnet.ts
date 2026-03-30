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
  const comptroller = new ethers.Contract(COMPTROLLER, COMPTROLLER_ABI, timelock);

  // Deploy EBrake
  const EBrakeFactory = await ethers.getContractFactory("EBrake");
  const eBrake = (await EBrakeFactory.deploy(COMPTROLLER, ACM)) as EBrake;

  // Grant ACM permissions
  await acm.giveCallPermission(eBrake.address, "setWhitelist(address,bool)", NORMAL_TIMELOCK);
  await eBrake.connect(timelock).setWhitelist(whitelistedUser.address, true);

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

  return { eBrake, comptroller, timelock, whitelistedUser, randomUser };
}

// ═══════════════════════════════════════════════════════════════════════════
// FORK TESTS
// ═══════════════════════════════════════════════════════════════════════════

if (FORK_MAINNET) {
  const FORK_BLOCK = 89587508;

  forking(FORK_BLOCK, () => {
    let eBrake: EBrake;
    let comptroller: Contract;
    let timelock: SignerWithAddress;
    let whitelistedUser: SignerWithAddress;
    let randomUser: SignerWithAddress;

    describe("EBrake Fork Tests (BSC Mainnet)", () => {
      beforeEach(async () => {
        ({ eBrake, comptroller, timelock, whitelistedUser, randomUser } = await loadFixture(deployEBrakeFixture));
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
      // 2. WHITELIST MANAGEMENT
      // ═════════════════════════════════════════════════════════════════════

      describe("Whitelist Management", () => {
        it("should whitelist an address and emit event", async () => {
          const addr = "0x0000000000000000000000000000000000005678";
          await expect(eBrake.connect(timelock).setWhitelist(addr, true))
            .to.emit(eBrake, "WhitelistUpdated")
            .withArgs(addr, true);
          expect(await eBrake.whitelist(addr)).to.be.true;
        });

        it("should remove from whitelist and emit event", async () => {
          const addr = "0x0000000000000000000000000000000000005678";
          await eBrake.connect(timelock).setWhitelist(addr, true);
          await expect(eBrake.connect(timelock).setWhitelist(addr, false))
            .to.emit(eBrake, "WhitelistUpdated")
            .withArgs(addr, false);
          expect(await eBrake.whitelist(addr)).to.be.false;
        });

        it("should revert when whitelisting zero address", async () => {
          await expect(
            eBrake.connect(timelock).setWhitelist(ethers.constants.AddressZero, true),
          ).to.be.revertedWithCustomError(eBrake, "ZeroAddress");
        });

        it("should revert when non-ACM caller tries to set whitelist", async () => {
          await expect(eBrake.connect(randomUser).setWhitelist(randomUser.address, true)).to.be.revertedWithCustomError(
            eBrake,
            "Unauthorized",
          );
        });

        it("should deny access after whitelist removal", async () => {
          const tempUser = await initMainnetUser(
            "0x0000000000000000000000000000000000009999",
            ethers.utils.parseUnits("10"),
          );
          await eBrake.connect(timelock).setWhitelist(tempUser.address, true);
          await expect(eBrake.connect(tempUser).setSupplyPaused(vBTCB, true)).to.not.be.reverted;

          await eBrake.connect(timelock).setWhitelist(tempUser.address, false);
          await expect(eBrake.connect(tempUser).setSupplyPaused(vBTCB, true)).to.be.revertedWithCustomError(
            eBrake,
            "NotWhitelisted",
          );
        });
      });

      // ═════════════════════════════════════════════════════════════════════
      // 3. ACCESS CONTROL — onlyWhitelisted
      // ═════════════════════════════════════════════════════════════════════

      describe("Access Control — onlyWhitelisted", () => {
        it("should revert setActionsPaused from non-whitelisted caller", async () => {
          await expect(
            eBrake.connect(randomUser).setActionsPaused([vBTCB], [Action.MINT], true),
          ).to.be.revertedWithCustomError(eBrake, "NotWhitelisted");
        });

        it("should revert setSupplyPaused from non-whitelisted caller", async () => {
          await expect(eBrake.connect(randomUser).setSupplyPaused(vBTCB, true)).to.be.revertedWithCustomError(
            eBrake,
            "NotWhitelisted",
          );
        });

        it("should revert setBorrowPaused from non-whitelisted caller", async () => {
          await expect(eBrake.connect(randomUser).setBorrowPaused(vBTCB, true)).to.be.revertedWithCustomError(
            eBrake,
            "NotWhitelisted",
          );
        });

        it("should revert setRedeemPaused from non-whitelisted caller", async () => {
          await expect(eBrake.connect(randomUser).setRedeemPaused(vBTCB, true)).to.be.revertedWithCustomError(
            eBrake,
            "NotWhitelisted",
          );
        });

        it("should revert setTransferPaused from non-whitelisted caller", async () => {
          await expect(eBrake.connect(randomUser).setTransferPaused(vBTCB, true)).to.be.revertedWithCustomError(
            eBrake,
            "NotWhitelisted",
          );
        });

        it("should revert setFlashLoanPaused from non-whitelisted caller", async () => {
          await expect(eBrake.connect(randomUser).setFlashLoanPaused(true)).to.be.revertedWithCustomError(
            eBrake,
            "NotWhitelisted",
          );
        });

        it("should revert setCFZero from non-whitelisted caller", async () => {
          await expect(eBrake.connect(randomUser).setCFZero(vBTCB, CORE_POOL_ID)).to.be.revertedWithCustomError(
            eBrake,
            "NotWhitelisted",
          );
        });

        it("should revert setMarketBorrowCaps from non-whitelisted caller", async () => {
          await expect(eBrake.connect(randomUser).setMarketBorrowCaps([vBTCB], [0])).to.be.revertedWithCustomError(
            eBrake,
            "NotWhitelisted",
          );
        });

        it("should revert setMarketSupplyCaps from non-whitelisted caller", async () => {
          await expect(eBrake.connect(randomUser).setMarketSupplyCaps([vBTCB], [0])).to.be.revertedWithCustomError(
            eBrake,
            "NotWhitelisted",
          );
        });
      });

      // ═════════════════════════════════════════════════════════════════════
      // 4. BATCH PAUSE — setActionsPaused
      // ═════════════════════════════════════════════════════════════════════

      describe("Batch Pause — setActionsPaused", () => {
        it("should pause MINT on multiple markets", async () => {
          await eBrake.connect(whitelistedUser).setActionsPaused([vBTCB, vUSDT], [Action.MINT], true);

          expect(await comptroller.actionPaused(vBTCB, Action.MINT)).to.be.true;
          expect(await comptroller.actionPaused(vUSDT, Action.MINT)).to.be.true;
        });

        it("should pause multiple actions on a market", async () => {
          await eBrake
            .connect(whitelistedUser)
            .setActionsPaused([vBTCB], [Action.MINT, Action.BORROW, Action.TRANSFER], true);

          expect(await comptroller.actionPaused(vBTCB, Action.MINT)).to.be.true;
          expect(await comptroller.actionPaused(vBTCB, Action.BORROW)).to.be.true;
          expect(await comptroller.actionPaused(vBTCB, Action.TRANSFER)).to.be.true;
        });

        it("should unpause actions", async () => {
          await eBrake.connect(whitelistedUser).setActionsPaused([vBTCB], [Action.MINT], true);
          expect(await comptroller.actionPaused(vBTCB, Action.MINT)).to.be.true;

          await eBrake.connect(whitelistedUser).setActionsPaused([vBTCB], [Action.MINT], false);
          expect(await comptroller.actionPaused(vBTCB, Action.MINT)).to.be.false;
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
            await expect(
              eBrake.connect(whitelistedUser).setActionsPaused([vBTCB], [value], true),
            ).to.be.revertedWithCustomError(eBrake, "ForbiddenAction");
          });
        }

        it("should revert on mixed allowed + forbidden actions in batch", async () => {
          await expect(
            eBrake.connect(whitelistedUser).setActionsPaused([vBTCB], [Action.MINT, Action.REPAY], true),
          ).to.be.revertedWithCustomError(eBrake, "ForbiddenAction");
        });

        it("should revert on empty markets array", async () => {
          await expect(
            eBrake.connect(whitelistedUser).setActionsPaused([], [Action.MINT], true),
          ).to.be.revertedWithCustomError(eBrake, "EmptyArray");
        });

        it("should revert on empty actions array", async () => {
          await expect(
            eBrake.connect(whitelistedUser).setActionsPaused([vBTCB], [], true),
          ).to.be.revertedWithCustomError(eBrake, "EmptyArray");
        });
      });

      // ═════════════════════════════════════════════════════════════════════
      // 5. SINGLE MARKET PAUSING
      // ═════════════════════════════════════════════════════════════════════

      describe("Single Market Pausing", () => {
        const pauseFunctions = [
          { name: "setSupplyPaused", action: Action.MINT, fn: "setSupplyPaused" as const },
          { name: "setRedeemPaused", action: Action.REDEEM, fn: "setRedeemPaused" as const },
          { name: "setBorrowPaused", action: Action.BORROW, fn: "setBorrowPaused" as const },
          { name: "setTransferPaused", action: Action.TRANSFER, fn: "setTransferPaused" as const },
        ];

        for (const { name, action, fn } of pauseFunctions) {
          it(`${name} should pause and verify on comptroller`, async () => {
            await eBrake.connect(whitelistedUser)[fn](vBTCB, true);
            expect(await comptroller.actionPaused(vBTCB, action)).to.be.true;
          });

          it(`${name} should unpause and verify on comptroller`, async () => {
            await eBrake.connect(whitelistedUser)[fn](vBTCB, true);
            await eBrake.connect(whitelistedUser)[fn](vBTCB, false);
            expect(await comptroller.actionPaused(vBTCB, action)).to.be.false;
          });
        }
      });

      // ═════════════════════════════════════════════════════════════════════
      // 6. FLASH LOAN PAUSING
      // ═════════════════════════════════════════════════════════════════════

      describe("Flash Loan Pausing", () => {
        it("should pause flash loans on comptroller", async () => {
          await eBrake.connect(whitelistedUser).setFlashLoanPaused(true);
          expect(await comptroller.flashLoanPaused()).to.be.true;
        });

        it("should unpause flash loans on comptroller", async () => {
          await eBrake.connect(whitelistedUser).setFlashLoanPaused(true);
          await eBrake.connect(whitelistedUser).setFlashLoanPaused(false);
          expect(await comptroller.flashLoanPaused()).to.be.false;
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
