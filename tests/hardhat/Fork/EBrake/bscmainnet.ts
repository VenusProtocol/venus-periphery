import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";

import { forking, initMainnetUser } from "../utils";
import { bscmainnetConfig } from "./configs";
import { EBrakeFixture, createDeployFixture, runSharedTests } from "./shared";

const FORK_MAINNET = process.env.FORKED_NETWORK === "bscmainnet";
const config = bscmainnetConfig;
const CORE_POOL_ID = 0;
const TEST_FLASH_LOAN_ACCOUNT = "0x000000000000000000000000000000000000c0DE";

if (FORK_MAINNET) {
  const deployFixture = createDeployFixture(config);

  forking(config.forkBlock, () => {
    let fixture: EBrakeFixture;
    const get = () => fixture;

    describe(`EBrake Fork Tests (${config.label})`, () => {
      beforeEach(async () => {
        fixture = await loadFixture(deployFixture);
      });

      // Shared tests: deployment, access control, pause, caps
      runSharedTests(config, get);

      // ═════════════════════════════════════════════════════════════════════
      // BNB-ONLY: Flash Loan Pausing
      // ═════════════════════════════════════════════════════════════════════

      describe("Flash Loan Pausing", () => {
        it("should pause flash loans on comptroller", async () => {
          const { eBrake, comptroller, whitelistedUser } = get();
          await expect(eBrake.connect(whitelistedUser).pauseFlashLoan())
            .to.emit(eBrake, "FlashLoanPaused")
            .withArgs(whitelistedUser.address);
          expect(await comptroller.flashLoanPaused()).to.be.true;
        });

        it("should be a silent no-op when flash loans are already paused", async () => {
          const { eBrake, comptroller, whitelistedUser } = get();
          // First call: pauses and emits
          await eBrake.connect(whitelistedUser).pauseFlashLoan();
          expect(await comptroller.flashLoanPaused()).to.be.true;

          // Second call: must NOT emit (state unchanged), and must not revert
          const tx = eBrake.connect(whitelistedUser).pauseFlashLoan();
          await expect(tx).to.not.emit(eBrake, "FlashLoanPaused");
          expect(await comptroller.flashLoanPaused()).to.be.true;
        });
      });

      // ═════════════════════════════════════════════════════════════════════
      // BNB-ONLY: decreaseCF(address, uint256) — batch all pools
      // ═════════════════════════════════════════════════════════════════════

      describe("decreaseCF(address, uint256) — batch all pools", () => {
        it("should zero CF on core pool via batch overload", async () => {
          const { eBrake, comptroller, whitelistedUser } = get();
          const marketBefore = await comptroller.poolMarkets(CORE_POOL_ID, config.vToken1);
          expect(marketBefore.collateralFactorMantissa).to.be.gt(0);

          await expect(eBrake.connect(whitelistedUser)["decreaseCF(address,uint256)"](config.vToken1, 0))
            .to.emit(eBrake, "CollateralFactorDecreased")
            .withArgs(whitelistedUser.address, config.vToken1, CORE_POOL_ID, 0);

          const marketAfter = await comptroller.poolMarkets(CORE_POOL_ID, config.vToken1);
          expect(marketAfter.collateralFactorMantissa).to.equal(0);
          expect(marketAfter.liquidationThresholdMantissa).to.equal(marketBefore.liquidationThresholdMantissa);
        });

        it("should partially decrease CF on core pool", async () => {
          const { eBrake, comptroller, whitelistedUser } = get();
          const marketBefore = await comptroller.poolMarkets(CORE_POOL_ID, config.vToken1);
          expect(marketBefore.collateralFactorMantissa).to.be.gt(0);
          const halfCF = marketBefore.collateralFactorMantissa.div(2);

          await expect(eBrake.connect(whitelistedUser)["decreaseCF(address,uint256)"](config.vToken1, halfCF))
            .to.emit(eBrake, "CollateralFactorDecreased")
            .withArgs(whitelistedUser.address, config.vToken1, CORE_POOL_ID, halfCF);

          const marketAfter = await comptroller.poolMarkets(CORE_POOL_ID, config.vToken1);
          expect(marketAfter.collateralFactorMantissa).to.equal(halfCF);
          expect(marketAfter.liquidationThresholdMantissa).to.equal(marketBefore.liquidationThresholdMantissa);
        });

        it("should silently skip pools where currentCF is already <= newCF (no revert)", async () => {
          const { eBrake, comptroller, whitelistedUser } = get();
          const marketBefore = await comptroller.poolMarkets(CORE_POOL_ID, config.vToken1);
          // Passing newCF > currentCF must not revert — those pools are simply skipped
          await expect(
            eBrake
              .connect(whitelistedUser)
              ["decreaseCF(address,uint256)"](config.vToken1, marketBefore.collateralFactorMantissa.add(1)),
          ).to.not.be.reverted;
          // Core pool CF is unchanged (was already <= newCF so skipped)
          const marketAfter = await comptroller.poolMarkets(CORE_POOL_ID, config.vToken1);
          expect(marketAfter.collateralFactorMantissa).to.equal(marketBefore.collateralFactorMantissa);
        });

        if (config.emodeConfig) {
          const emode = config.emodeConfig;

          it(`should decrease CF on e-mode pool (poolId=${emode.poolId}) via batch overload`, async () => {
            const { eBrake, comptroller, whitelistedUser } = get();
            const marketBefore = await comptroller.poolMarkets(emode.poolId, emode.vToken);
            expect(marketBefore.isListed).to.be.true;
            expect(marketBefore.collateralFactorMantissa).to.be.gt(0);

            // Batch overload sets CF across ALL listed pools
            await expect(eBrake.connect(whitelistedUser)["decreaseCF(address,uint256)"](emode.vToken, 0))
              .to.emit(eBrake, "CollateralFactorDecreased")
              .withArgs(whitelistedUser.address, emode.vToken, emode.poolId, 0);

            const marketAfter = await comptroller.poolMarkets(emode.poolId, emode.vToken);
            expect(marketAfter.collateralFactorMantissa).to.equal(0);
            expect(marketAfter.liquidationThresholdMantissa).to.equal(marketBefore.liquidationThresholdMantissa);
          });
        }

        it("should not revert for market unlisted in some pools (skips unlisted)", async () => {
          const { eBrake, whitelistedUser } = get();
          // vToken1 may not be listed in all pools — batch overload should skip unlisted, not revert
          await expect(eBrake.connect(whitelistedUser)["decreaseCF(address,uint256)"](config.vToken1, 0)).to.not.be
            .reverted;
        });
      });

      // ═════════════════════════════════════════════════════════════════════
      // BNB-ONLY: decreaseCF(address, uint96, uint256) — targeted single pool
      // ═════════════════════════════════════════════════════════════════════

      describe("decreaseCF(address, uint96, uint256) — targeted single pool", () => {
        it("should set collateral factor to zero while preserving LT", async () => {
          const { eBrake, comptroller, whitelistedUser } = get();
          const marketBefore = await comptroller.poolMarkets(CORE_POOL_ID, config.vToken1);
          expect(marketBefore.collateralFactorMantissa).to.be.gt(0);
          expect(marketBefore.liquidationThresholdMantissa).to.be.gt(0);

          await expect(
            eBrake.connect(whitelistedUser)["decreaseCF(address,uint96,uint256)"](config.vToken1, CORE_POOL_ID, 0),
          )
            .to.emit(eBrake, "CollateralFactorDecreased")
            .withArgs(whitelistedUser.address, config.vToken1, CORE_POOL_ID, 0);

          const marketAfter = await comptroller.poolMarkets(CORE_POOL_ID, config.vToken1);
          expect(marketAfter.collateralFactorMantissa).to.equal(0);
          expect(marketAfter.liquidationThresholdMantissa).to.equal(marketBefore.liquidationThresholdMantissa);
        });

        it("should partially decrease CF on a specific pool", async () => {
          const { eBrake, comptroller, whitelistedUser } = get();
          const marketBefore = await comptroller.poolMarkets(CORE_POOL_ID, config.vToken1);
          expect(marketBefore.collateralFactorMantissa).to.be.gt(0);
          const halfCF = marketBefore.collateralFactorMantissa.div(2);

          await expect(
            eBrake.connect(whitelistedUser)["decreaseCF(address,uint96,uint256)"](config.vToken1, CORE_POOL_ID, halfCF),
          )
            .to.emit(eBrake, "CollateralFactorDecreased")
            .withArgs(whitelistedUser.address, config.vToken1, CORE_POOL_ID, halfCF);

          const marketAfter = await comptroller.poolMarkets(CORE_POOL_ID, config.vToken1);
          expect(marketAfter.collateralFactorMantissa).to.equal(halfCF);
        });

        it("should revert with CFExceedsCurrent when newCF > currentCF", async () => {
          const { eBrake, comptroller, whitelistedUser } = get();
          const marketBefore = await comptroller.poolMarkets(CORE_POOL_ID, config.vToken1);
          await expect(
            eBrake
              .connect(whitelistedUser)
              [
                "decreaseCF(address,uint96,uint256)"
              ](config.vToken1, CORE_POOL_ID, marketBefore.collateralFactorMantissa.add(1)),
          ).to.be.revertedWithCustomError(eBrake, "CFExceedsCurrent");
        });

        it("should revert for unlisted market", async () => {
          const { eBrake, whitelistedUser } = get();
          await expect(
            eBrake
              .connect(whitelistedUser)
              ["decreaseCF(address,uint96,uint256)"]("0x0000000000000000000000000000000000000001", CORE_POOL_ID, 0),
          ).to.be.revertedWithCustomError(eBrake, "MarketNotListed");
        });

        it("should revert for invalid pool ID", async () => {
          const { eBrake, whitelistedUser } = get();
          await expect(eBrake.connect(whitelistedUser)["decreaseCF(address,uint96,uint256)"](config.vToken1, 999, 0)).to
            .be.reverted;
        });

        // E-mode pool tests
        if (config.emodeConfig) {
          const emode = config.emodeConfig;

          it(`should set CF to zero on e-mode pool (poolId=${emode.poolId})`, async () => {
            const { eBrake, comptroller, whitelistedUser } = get();
            const marketBefore = await comptroller.poolMarkets(emode.poolId, emode.vToken);
            expect(marketBefore.isListed).to.be.true;
            expect(marketBefore.collateralFactorMantissa).to.be.gt(0);

            await expect(
              eBrake.connect(whitelistedUser)["decreaseCF(address,uint96,uint256)"](emode.vToken, emode.poolId, 0),
            )
              .to.emit(eBrake, "CollateralFactorDecreased")
              .withArgs(whitelistedUser.address, emode.vToken, emode.poolId, 0);

            const marketAfter = await comptroller.poolMarkets(emode.poolId, emode.vToken);
            expect(marketAfter.collateralFactorMantissa).to.equal(0);
            expect(marketAfter.liquidationThresholdMantissa).to.equal(marketBefore.liquidationThresholdMantissa);
          });

          it(`should revert decreaseCF on e-mode pool where market is not listed (poolId=${emode.unlistedPoolId})`, async () => {
            const { eBrake, whitelistedUser } = get();
            await expect(
              eBrake
                .connect(whitelistedUser)
                ["decreaseCF(address,uint96,uint256)"](emode.unlistedVToken, emode.unlistedPoolId, 0),
            ).to.be.revertedWithCustomError(eBrake, "MarketNotListed");
          });
        }
      });

      // ═════════════════════════════════════════════════════════════════════
      // BNB-ONLY: disablePoolBorrow — per-pool granular borrow disable
      // ═════════════════════════════════════════════════════════════════════

      describe("disablePoolBorrow(uint96, address)", () => {
        it("should disable borrow on core pool and emit event", async () => {
          const { eBrake, comptroller, whitelistedUser } = get();
          const marketBefore = await comptroller.poolMarkets(CORE_POOL_ID, config.vToken1);
          expect(marketBefore.isBorrowAllowed).to.be.true;

          await expect(eBrake.connect(whitelistedUser).disablePoolBorrow(CORE_POOL_ID, config.vToken1))
            .to.emit(eBrake, "PoolBorrowDisabled")
            .withArgs(whitelistedUser.address, CORE_POOL_ID, config.vToken1);

          const marketAfter = await comptroller.poolMarkets(CORE_POOL_ID, config.vToken1);
          expect(marketAfter.isBorrowAllowed).to.be.false;
        });

        it("should still emit event when borrow is already disabled (idempotent at comptroller layer)", async () => {
          const { eBrake, comptroller, whitelistedUser } = get();
          await eBrake.connect(whitelistedUser).disablePoolBorrow(CORE_POOL_ID, config.vToken1);
          expect((await comptroller.poolMarkets(CORE_POOL_ID, config.vToken1)).isBorrowAllowed).to.be.false;

          // Second call: comptroller no-ops, EBrake still emits (consistent with pauseFlashLoan behavior)
          await expect(eBrake.connect(whitelistedUser).disablePoolBorrow(CORE_POOL_ID, config.vToken1))
            .to.emit(eBrake, "PoolBorrowDisabled")
            .withArgs(whitelistedUser.address, CORE_POOL_ID, config.vToken1);
          expect((await comptroller.poolMarkets(CORE_POOL_ID, config.vToken1)).isBorrowAllowed).to.be.false;
        });

        it("should not affect global pauseBorrow flag (independent flags)", async () => {
          const { eBrake, comptroller, whitelistedUser } = get();
          const Action_BORROW = 2;
          const pausedBefore = await comptroller.actionPaused(config.vToken1, Action_BORROW);

          await eBrake.connect(whitelistedUser).disablePoolBorrow(CORE_POOL_ID, config.vToken1);

          expect(await comptroller.actionPaused(config.vToken1, Action_BORROW)).to.equal(pausedBefore);
        });

        it("should revert when market not listed in given pool", async () => {
          const { eBrake, whitelistedUser } = get();
          // Address not listed in any pool — comptroller reverts with MarketConfigNotFound
          await expect(
            eBrake
              .connect(whitelistedUser)
              .disablePoolBorrow(CORE_POOL_ID, "0x0000000000000000000000000000000000000001"),
          ).to.be.reverted;
        });

        it("should revert when poolId does not exist", async () => {
          const { eBrake, whitelistedUser } = get();
          // poolId 9999 > lastPoolId — comptroller reverts with PoolDoesNotExist
          await expect(eBrake.connect(whitelistedUser).disablePoolBorrow(9999, config.vToken1)).to.be.reverted;
        });

        if (config.emodeConfig) {
          const emode = config.emodeConfig;

          it(`should disable borrow on e-mode pool (poolId=${emode.poolId}) without affecting core pool`, async () => {
            const { eBrake, comptroller, whitelistedUser } = get();
            const emodeBefore = await comptroller.poolMarkets(emode.poolId, emode.vToken);
            const coreBefore = await comptroller.poolMarkets(CORE_POOL_ID, emode.vToken);
            expect(emodeBefore.isListed).to.be.true;
            expect(emodeBefore.isBorrowAllowed).to.be.true;

            await expect(eBrake.connect(whitelistedUser).disablePoolBorrow(emode.poolId, emode.vToken))
              .to.emit(eBrake, "PoolBorrowDisabled")
              .withArgs(whitelistedUser.address, emode.poolId, emode.vToken);

            const emodeAfter = await comptroller.poolMarkets(emode.poolId, emode.vToken);
            const coreAfter = await comptroller.poolMarkets(CORE_POOL_ID, emode.vToken);
            expect(emodeAfter.isBorrowAllowed).to.be.false;
            // Core pool flag for the same vToken is unchanged — granular surgical disable
            expect(coreAfter.isBorrowAllowed).to.equal(coreBefore.isBorrowAllowed);
          });
        }
      });

      // ═════════════════════════════════════════════════════════════════════
      // BNB-ONLY: revokeFlashLoanAccess — per-account flash loan revoke
      // ═════════════════════════════════════════════════════════════════════

      describe("revokeFlashLoanAccess(address)", () => {
        beforeEach(async () => {
          // Whitelist a test account directly via timelock so we can revoke it.
          const { comptroller } = get();
          const timelock = await initMainnetUser(config.timelock, ethers.utils.parseUnits("10"));
          await comptroller.connect(timelock).setWhiteListFlashLoanAccount(TEST_FLASH_LOAN_ACCOUNT, true);
          expect(await comptroller.authorizedFlashLoan(TEST_FLASH_LOAN_ACCOUNT)).to.be.true;
        });

        it("should revoke flash loan access and emit event", async () => {
          const { eBrake, comptroller, whitelistedUser } = get();

          await expect(eBrake.connect(whitelistedUser).revokeFlashLoanAccess(TEST_FLASH_LOAN_ACCOUNT))
            .to.emit(eBrake, "FlashLoanAccessRevoked")
            .withArgs(whitelistedUser.address, TEST_FLASH_LOAN_ACCOUNT);

          expect(await comptroller.authorizedFlashLoan(TEST_FLASH_LOAN_ACCOUNT)).to.be.false;
        });

        it("should revert on zero address", async () => {
          const { eBrake, whitelistedUser } = get();
          await expect(
            eBrake.connect(whitelistedUser).revokeFlashLoanAccess(ethers.constants.AddressZero),
          ).to.be.revertedWithCustomError(eBrake, "ZeroAddress");
        });

        it("should still emit event when account is already not whitelisted (idempotent at comptroller layer)", async () => {
          const { eBrake, comptroller, whitelistedUser } = get();
          await eBrake.connect(whitelistedUser).revokeFlashLoanAccess(TEST_FLASH_LOAN_ACCOUNT);
          expect(await comptroller.authorizedFlashLoan(TEST_FLASH_LOAN_ACCOUNT)).to.be.false;

          // Second call: comptroller no-ops, EBrake still emits
          await expect(eBrake.connect(whitelistedUser).revokeFlashLoanAccess(TEST_FLASH_LOAN_ACCOUNT))
            .to.emit(eBrake, "FlashLoanAccessRevoked")
            .withArgs(whitelistedUser.address, TEST_FLASH_LOAN_ACCOUNT);
          expect(await comptroller.authorizedFlashLoan(TEST_FLASH_LOAN_ACCOUNT)).to.be.false;
        });

        it("should not affect other whitelisted accounts (surgical revoke)", async () => {
          const { eBrake, comptroller, whitelistedUser } = get();
          const OTHER = "0x000000000000000000000000000000000000BEEF";
          const timelock = await initMainnetUser(config.timelock, ethers.utils.parseUnits("10"));
          await comptroller.connect(timelock).setWhiteListFlashLoanAccount(OTHER, true);
          expect(await comptroller.authorizedFlashLoan(OTHER)).to.be.true;

          await eBrake.connect(whitelistedUser).revokeFlashLoanAccess(TEST_FLASH_LOAN_ACCOUNT);

          expect(await comptroller.authorizedFlashLoan(TEST_FLASH_LOAN_ACCOUNT)).to.be.false;
          expect(await comptroller.authorizedFlashLoan(OTHER)).to.be.true;
        });
      });
    });
  });
}
