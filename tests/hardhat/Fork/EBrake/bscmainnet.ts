import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";

import { forking } from "../utils";
import { bscmainnetConfig } from "./configs";
import { EBrakeFixture, createDeployFixture, runSharedTests } from "./shared";

const FORK_MAINNET = process.env.FORKED_NETWORK === "bscmainnet";
const config = bscmainnetConfig;
const CORE_POOL_ID = 0;

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
      });

      // ═════════════════════════════════════════════════════════════════════
      // BNB-ONLY: setCFZero(address) — batch zeros CF across all pools
      // ═════════════════════════════════════════════════════════════════════

      describe("setCFZero(address) — batch all pools", () => {
        it("should zero CF on core pool via batch overload", async () => {
          const { eBrake, comptroller, whitelistedUser } = get();
          const marketBefore = await comptroller.poolMarkets(CORE_POOL_ID, config.vToken1);
          expect(marketBefore.collateralFactorMantissa).to.be.gt(0);

          await expect(eBrake.connect(whitelistedUser)["setCFZero(address)"](config.vToken1))
            .to.emit(eBrake, "CollateralFactorZeroed")
            .withArgs(whitelistedUser.address, config.vToken1, CORE_POOL_ID);

          const marketAfter = await comptroller.poolMarkets(CORE_POOL_ID, config.vToken1);
          expect(marketAfter.collateralFactorMantissa).to.equal(0);
          expect(marketAfter.liquidationThresholdMantissa).to.equal(marketBefore.liquidationThresholdMantissa);
        });

        if (config.emodeConfig) {
          const emode = config.emodeConfig;

          it(`should zero CF on e-mode pool (poolId=${emode.poolId}) via batch overload`, async () => {
            const { eBrake, comptroller, whitelistedUser } = get();
            const marketBefore = await comptroller.poolMarkets(emode.poolId, emode.vToken);
            expect(marketBefore.isListed).to.be.true;
            expect(marketBefore.collateralFactorMantissa).to.be.gt(0);

            // Batch overload zeros CF across ALL listed pools
            await expect(eBrake.connect(whitelistedUser)["setCFZero(address)"](emode.vToken))
              .to.emit(eBrake, "CollateralFactorZeroed")
              .withArgs(whitelistedUser.address, emode.vToken, emode.poolId);

            const marketAfter = await comptroller.poolMarkets(emode.poolId, emode.vToken);
            expect(marketAfter.collateralFactorMantissa).to.equal(0);
            expect(marketAfter.liquidationThresholdMantissa).to.equal(marketBefore.liquidationThresholdMantissa);
          });
        }

        it("should not revert for market unlisted in some pools (skips unlisted)", async () => {
          const { eBrake, whitelistedUser } = get();
          // vToken1 may not be listed in all pools — batch overload should skip unlisted, not revert
          await expect(eBrake.connect(whitelistedUser)["setCFZero(address)"](config.vToken1)).to.not.be.reverted;
        });
      });

      // ═════════════════════════════════════════════════════════════════════
      // BNB-ONLY: setCFZero(address, uint96) — targeted single pool
      // ═════════════════════════════════════════════════════════════════════

      describe("setCFZero(address, uint96) — targeted single pool", () => {
        it("should set collateral factor to zero while preserving LT", async () => {
          const { eBrake, comptroller, whitelistedUser } = get();
          const marketBefore = await comptroller.poolMarkets(CORE_POOL_ID, config.vToken1);
          expect(marketBefore.collateralFactorMantissa).to.be.gt(0);
          expect(marketBefore.liquidationThresholdMantissa).to.be.gt(0);

          await expect(eBrake.connect(whitelistedUser)["setCFZero(address,uint96)"](config.vToken1, CORE_POOL_ID))
            .to.emit(eBrake, "CollateralFactorZeroed")
            .withArgs(whitelistedUser.address, config.vToken1, CORE_POOL_ID);

          const marketAfter = await comptroller.poolMarkets(CORE_POOL_ID, config.vToken1);
          expect(marketAfter.collateralFactorMantissa).to.equal(0);
          expect(marketAfter.liquidationThresholdMantissa).to.equal(marketBefore.liquidationThresholdMantissa);
        });

        it("should revert for unlisted market", async () => {
          const { eBrake, whitelistedUser } = get();
          await expect(
            eBrake.connect(whitelistedUser)["setCFZero(address,uint96)"]("0x0000000000000000000000000000000000000001", CORE_POOL_ID),
          ).to.be.revertedWithCustomError(eBrake, "MarketNotListed");
        });

        it("should revert for invalid pool ID", async () => {
          const { eBrake, whitelistedUser } = get();
          await expect(eBrake.connect(whitelistedUser)["setCFZero(address,uint96)"](config.vToken1, 999)).to.be.reverted;
        });

        // E-mode pool tests
        if (config.emodeConfig) {
          const emode = config.emodeConfig;

          it(`should set CF to zero on e-mode pool (poolId=${emode.poolId})`, async () => {
            const { eBrake, comptroller, whitelistedUser } = get();
            const marketBefore = await comptroller.poolMarkets(emode.poolId, emode.vToken);
            expect(marketBefore.isListed).to.be.true;
            expect(marketBefore.collateralFactorMantissa).to.be.gt(0);

            await expect(eBrake.connect(whitelistedUser)["setCFZero(address,uint96)"](emode.vToken, emode.poolId))
              .to.emit(eBrake, "CollateralFactorZeroed")
              .withArgs(whitelistedUser.address, emode.vToken, emode.poolId);

            const marketAfter = await comptroller.poolMarkets(emode.poolId, emode.vToken);
            expect(marketAfter.collateralFactorMantissa).to.equal(0);
            expect(marketAfter.liquidationThresholdMantissa).to.equal(marketBefore.liquidationThresholdMantissa);
          });

          it(`should revert setCFZero on e-mode pool where market is not listed (poolId=${emode.unlistedPoolId})`, async () => {
            const { eBrake, whitelistedUser } = get();
            await expect(
              eBrake.connect(whitelistedUser)["setCFZero(address,uint96)"](emode.unlistedVToken, emode.unlistedPoolId),
            ).to.be.revertedWithCustomError(eBrake, "MarketNotListed");
          });
        }
      });
    });
  });
}
