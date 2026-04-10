// ═══════════════════════════════════════════════════════════════════════════
// Executor Fork Tests — BSC Mainnet (Diamond / Core Pool)
//
// BSC's Diamond comptroller is multi-pool: a market can be listed in the core
// pool and one or more e-mode pools, each with its own (CF, LT) pair.
// EBrake.decreaseCF iterates corePoolId..lastPoolId and updates every listed
// instance, so handleLTVAdjust / handleSupplyHalt need BSC-specific assertions
// that walk the same pool range. The shared (single-pool) tests in shared.ts
// only assert CORE_POOL_ID and would miss e-mode side effects, so they live
// behind `runIsolatedPoolTests` and are not used here.
// ═══════════════════════════════════════════════════════════════════════════
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { BigNumber } from "ethers";
import { ethers } from "hardhat";

import { forking } from "../utils";
import { bscmainnetConfig } from "./configs";
import { Action, ExecutorFixture, createDeployFixture, runSharedTests } from "./shared";

const FORK_MAINNET = process.env.FORKED_NETWORK === "bscmainnet";
const config = bscmainnetConfig;

if (FORK_MAINNET) {
  const deployFixture = createDeployFixture(config);

  forking(config.forkBlock, () => {
    let fixture: ExecutorFixture;
    const get = () => fixture;

    describe(`Executor Fork Tests (${config.label} — Diamond Core Pool)`, () => {
      beforeEach(async () => {
        fixture = await loadFixture(deployFixture);
      });

      // Tests that work on both Diamond and IL comptrollers.
      runSharedTests(config, get);

      // ═════════════════════════════════════════════════════════════════════
      // Helpers — multi-pool aware reads against the Diamond comptroller
      // ═════════════════════════════════════════════════════════════════════

      const readPoolMarket = async (poolId: number, market: string) => {
        const { comptroller } = get();
        return comptroller.poolMarkets(poolId, market);
      };

      const readListedPoolIds = async (market: string): Promise<number[]> => {
        const { comptroller } = get();
        const corePoolId: BigNumber = await comptroller.corePoolId();
        const lastPoolId: BigNumber = await comptroller.lastPoolId();
        const ids: number[] = [];
        for (let i = corePoolId.toNumber(); i <= lastPoolId.toNumber(); ++i) {
          const m = await comptroller.poolMarkets(i, market);
          if (m.isListed) ids.push(i);
        }
        return ids;
      };

      // ═════════════════════════════════════════════════════════════════════
      // BSC-ONLY: handleLTVAdjust (multi-pool iteration)
      // ═════════════════════════════════════════════════════════════════════

      describe("handleLTVAdjust (Diamond multi-pool)", () => {
        it("reverts for unconfigured market", async () => {
          const { executor, hypernative } = get();
          await expect(
            executor
              .connect(hypernative)
              .handleLTVAdjust("0x0000000000000000000000000000000000000001", ethers.utils.parseUnits("0.5")),
          ).to.be.revertedWithCustomError(executor, "MarketNotConfigured");
        });

        it("no-op when adjustedLTV equals current CF — no event emitted, no pool changed", async () => {
          const { executor, hypernative, testMarket, originalLTV } = get();
          await expect(executor.connect(hypernative).handleLTVAdjust(testMarket, originalLTV)).to.not.emit(
            executor,
            "LTVAdjusted",
          );
        });

        it("decreases CF in every listed collateral pool to the requested value", async () => {
          const { executor, hypernative, testMarket, originalLTV } = get();
          const reducedLTV = originalLTV.mul(80).div(100);

          // Snapshot per-pool state up front so we can mirror EBrake's skip rule:
          // borrow-only pools (LT == 0) are intentionally skipped because the Diamond
          // comptroller rejects newCF > newLT, and a borrow-only listing has no CF to tighten.
          const listedBefore = await readListedPoolIds(testMarket);
          expect(listedBefore.length).to.be.gte(1);
          const ltBefore: Record<number, BigNumber> = {};
          for (const poolId of listedBefore) {
            ltBefore[poolId] = (await readPoolMarket(poolId, testMarket)).liquidationThresholdMantissa;
          }

          await expect(executor.connect(hypernative).handleLTVAdjust(testMarket, reducedLTV)).to.emit(
            executor,
            "LTVAdjusted",
          );

          for (const poolId of listedBefore) {
            const m = await readPoolMarket(poolId, testMarket);
            if (ltBefore[poolId].isZero()) {
              // Borrow-only listing — EBrake skips it, CF stays at its prior value (0).
              expect(m.collateralFactorMantissa, `pool ${poolId} CF (borrow-only)`).to.equal(0);
            } else {
              expect(m.collateralFactorMantissa, `pool ${poolId} CF`).to.equal(reducedLTV);
            }
          }
        });

        it("preserves liquidation threshold in every listed pool", async () => {
          const { executor, hypernative, testMarket, originalLTV } = get();

          const listedPools = await readListedPoolIds(testMarket);
          const ltsBefore: Record<number, BigNumber> = {};
          for (const poolId of listedPools) {
            ltsBefore[poolId] = (await readPoolMarket(poolId, testMarket)).liquidationThresholdMantissa;
          }

          await executor.connect(hypernative).handleLTVAdjust(testMarket, originalLTV.mul(80).div(100));

          for (const poolId of listedPools) {
            const m = await readPoolMarket(poolId, testMarket);
            expect(m.liquidationThresholdMantissa, `pool ${poolId} LT`).to.equal(ltsBefore[poolId]);
          }
        });
      });

      // ═════════════════════════════════════════════════════════════════════
      // BSC-ONLY: handleSupplyHalt (zeroes CF across every listed pool)
      // ═════════════════════════════════════════════════════════════════════

      describe("handleSupplyHalt (Diamond multi-pool)", () => {
        it("reverts when supply cap is not breached", async () => {
          const { executor, hypernative, testMarket } = get();
          await expect(executor.connect(hypernative).handleSupplyHalt(testMarket)).to.be.revertedWithCustomError(
            executor,
            "CapNotBreached",
          );
        });

        it("reverts when supply cap is not set (cap == 0 means unlimited)", async () => {
          const { executor, hypernative, comptroller, governance, testMarket } = get();
          await comptroller.connect(governance)._setMarketSupplyCaps([testMarket], [0]);
          await expect(executor.connect(hypernative).handleSupplyHalt(testMarket)).to.be.revertedWithCustomError(
            executor,
            "CapNotBreached",
          );
        });

        it("pauses MINT and zeros CF in every listed pool when cap is breached", async () => {
          const { executor, hypernative, comptroller, governance, testMarket } = get();

          const listedPools = await readListedPoolIds(testMarket);
          expect(listedPools.length).to.be.gte(1);

          // Force the supply cap below current supply so the breach check passes.
          await comptroller.connect(governance)._setMarketSupplyCaps([testMarket], [1]);

          await expect(executor.connect(hypernative).handleSupplyHalt(testMarket))
            .to.emit(executor, "SupplyHalted")
            .withArgs(hypernative.address, testMarket);

          expect(await comptroller.actionPaused(testMarket, Action.MINT)).to.be.true;

          for (const poolId of listedPools) {
            const m = await readPoolMarket(poolId, testMarket);
            expect(m.collateralFactorMantissa, `pool ${poolId} CF`).to.equal(0);
          }
        });

        it("preserves liquidation threshold in every listed pool after halt", async () => {
          const { executor, hypernative, comptroller, governance, testMarket } = get();

          const listedPools = await readListedPoolIds(testMarket);
          const ltsBefore: Record<number, BigNumber> = {};
          for (const poolId of listedPools) {
            ltsBefore[poolId] = (await readPoolMarket(poolId, testMarket)).liquidationThresholdMantissa;
          }

          await comptroller.connect(governance)._setMarketSupplyCaps([testMarket], [1]);
          await executor.connect(hypernative).handleSupplyHalt(testMarket);

          for (const poolId of listedPools) {
            const m = await readPoolMarket(poolId, testMarket);
            expect(m.liquidationThresholdMantissa, `pool ${poolId} LT`).to.equal(ltsBefore[poolId]);
          }
        });
      });
    });
  });
}
