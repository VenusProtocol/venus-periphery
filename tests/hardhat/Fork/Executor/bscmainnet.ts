// ═══════════════════════════════════════════════════════════════════════════
// Executor Fork Tests — BSC Mainnet (Diamond / Core Pool)
//
// BSC's Diamond comptroller is multi-pool: a market can be listed in the core
// pool and one or more e-mode pools, each with its own (CF, LT) pair. Both
// EBrake.adjustCollateralFactor and EBrake.setCFZero iterate corePoolId..lastPoolId
// and update every listed instance, so the corresponding handlers
// (handleLTVAdjust / handleSupplyHalt) need BSC-specific assertions that walk
// the same pool range. The shared (single-pool) tests in shared.ts only assert
// CORE_POOL_ID and would miss e-mode side effects, so they live behind
// `runIsolatedPoolTests` and are not used here.
// ═══════════════════════════════════════════════════════════════════════════
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { BigNumber } from "ethers";
import { ethers } from "hardhat";

import { forking } from "../utils";
import { bscmainnetConfig } from "./configs";
import { Action, ExecutorFixture, createDeployFixture, runSharedTests } from "./shared";

const FORK_MAINNET = process.env.FORKED_NETWORK === "bscmainnet";
const config = bscmainnetConfig;
const CORE_POOL_ID = 0;

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

        it("reverts when adjustedLTV exceeds originalLTV", async () => {
          const { executor, hypernative, testMarket, originalLTV } = get();
          await expect(
            executor.connect(hypernative).handleLTVAdjust(testMarket, originalLTV.add(1)),
          ).to.be.revertedWithCustomError(executor, "AdjustedLTVExceedsOriginal");
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

        it("first increase goes through immediately (lastLTVIncreaseTime = 0)", async () => {
          const { executor, hypernative, testMarket, originalLTV } = get();

          await executor.connect(hypernative).handleLTVAdjust(testMarket, originalLTV.mul(70).div(100));
          const restored = originalLTV.mul(80).div(100);
          await expect(executor.connect(hypernative).handleLTVAdjust(testMarket, restored)).to.emit(
            executor,
            "LTVAdjusted",
          );

          const corePoolMarket = await readPoolMarket(CORE_POOL_ID, testMarket);
          expect(corePoolMarket.collateralFactorMantissa).to.equal(restored);
        });

        it("second increase within cooldown reverts with CooldownNotExpired", async () => {
          const { executor, hypernative, testMarket, originalLTV } = get();

          await executor.connect(hypernative).handleLTVAdjust(testMarket, originalLTV.mul(60).div(100));
          await executor.connect(hypernative).handleLTVAdjust(testMarket, originalLTV.mul(70).div(100));

          await expect(
            executor.connect(hypernative).handleLTVAdjust(testMarket, originalLTV.mul(80).div(100)),
          ).to.be.revertedWithCustomError(executor, "CooldownNotExpired");
        });

        it("increase succeeds after cooldown elapses", async () => {
          const { executor, governance, hypernative, testMarket, originalLTV } = get();

          // Shrink the cooldown to 1s before stamping `lastLTVIncreaseTime`. The Venus
          // resilient oracle on BSC enforces per-feed staleness on every setCollateralFactor
          // call; advancing time by `config.cooldownPeriod + 1` (1801s) blows past the
          // Chainlink heartbeat for vBTCB and reverts with "invalid resilient oracle price".
          // A 1-second cooldown is enough to exercise the cooldown branch without aging the
          // oracle feed.
          await executor.connect(governance).setCooldownPeriod(1);

          await executor.connect(hypernative).handleLTVAdjust(testMarket, originalLTV.mul(60).div(100));
          await executor.connect(hypernative).handleLTVAdjust(testMarket, originalLTV.mul(70).div(100));

          await time.increase(2);

          const target = originalLTV.mul(80).div(100);
          await expect(executor.connect(hypernative).handleLTVAdjust(testMarket, target)).to.emit(
            executor,
            "LTVAdjusted",
          );

          const corePoolMarket = await readPoolMarket(CORE_POOL_ID, testMarket);
          expect(corePoolMarket.collateralFactorMantissa).to.equal(target);
        });

        it("cannot set CF above originalLTV even after cooldown", async () => {
          const { executor, governance, hypernative, testMarket, originalLTV } = get();
          // See note in "increase succeeds after cooldown elapses" — keep the time jump small
          // to avoid blowing past the resilient oracle's staleness window.
          await executor.connect(governance).setCooldownPeriod(1);
          await time.increase(2);
          await expect(
            executor.connect(hypernative).handleLTVAdjust(testMarket, originalLTV.add(1)),
          ).to.be.revertedWithCustomError(executor, "AdjustedLTVExceedsOriginal");
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
