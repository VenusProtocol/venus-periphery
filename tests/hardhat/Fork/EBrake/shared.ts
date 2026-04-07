// ═══════════════════════════════════════════════════════════════════════════
// EBrake Fork Test — Shared Test Factories
// ═══════════════════════════════════════════════════════════════════════════
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { Contract } from "ethers";
import { ethers } from "hardhat";

import { EBrake } from "../../../../typechain";
import { initMainnetUser } from "../utils";
import { NetworkConfig } from "./configs";

// ── Constants ──

const ACM_ABI = [
  "function giveCallPermission(address contractAddress, string calldata functionSig, address accountToPermit)",
];

export const Action = {
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

// ── Fixture ──

export type EBrakeFixture = {
  eBrake: EBrake;
  comptroller: Contract;
  whitelistedUser: SignerWithAddress;
  randomUser: SignerWithAddress;
};

export type FixtureGetter = () => EBrakeFixture;

export function createDeployFixture(config: NetworkConfig): () => Promise<EBrakeFixture> {
  return async function deployEBrakeFixture(): Promise<EBrakeFixture> {
    const [, randomUser] = await ethers.getSigners();
    const timelock = await initMainnetUser(config.timelock, ethers.utils.parseUnits("10"));
    const whitelistedUser = await initMainnetUser(
      "0x0000000000000000000000000000000000001234",
      ethers.utils.parseUnits("10"),
    );

    const acm = new ethers.Contract(config.acm, ACM_ABI, timelock);
    const comptroller = new ethers.Contract(config.comptroller, config.comptrollerAbi, timelock);

    const EBrakeFactory = await ethers.getContractFactory("EBrake");
    const eBrakeImpl = await EBrakeFactory.deploy(config.comptroller, config.isIsolatedPool);

    const ProxyFactory = await ethers.getContractFactory(
      "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol:TransparentUpgradeableProxy",
    );
    const initData = eBrakeImpl.interface.encodeFunctionData("initialize", [config.acm]);
    const proxy = await ProxyFactory.deploy(eBrakeImpl.address, timelock.address, initData);
    const eBrake = EBrakeFactory.attach(proxy.address) as EBrake;

    // Grant whitelistedUser per-function ACM permissions on EBrake
    for (const sig of config.eBrakeFunctions) {
      await acm.giveCallPermission(eBrake.address, sig, whitelistedUser.address);
    }

    // Grant EBrake permissions on comptroller
    for (const sig of config.comptrollerPermissions) {
      await acm.giveCallPermission(ethers.constants.AddressZero, sig, eBrake.address);
    }

    return { eBrake, comptroller, whitelistedUser, randomUser };
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// TEST FACTORIES
// ═══════════════════════════════════════════════════════════════════════════

export function deploymentTests(config: NetworkConfig, get: FixtureGetter): void {
  describe("Deployment & Constructor", () => {
    it("should set COMPTROLLER immutable correctly", async () => {
      const { eBrake } = get();
      expect((await eBrake.COMPTROLLER()).toLowerCase()).to.equal(config.comptroller.toLowerCase());
    });

    it("should set IS_ISOLATED_POOL immutable correctly", async () => {
      const { eBrake } = get();
      expect(await eBrake.IS_ISOLATED_POOL()).to.equal(config.isIsolatedPool);
    });

    it("should revert deployment with zero comptroller", async () => {
      const { eBrake } = get();
      const F = await ethers.getContractFactory("EBrake");
      await expect(F.deploy(ethers.constants.AddressZero, config.isIsolatedPool)).to.be.revertedWithCustomError(
        eBrake,
        "ZeroAddress",
      );
    });

    it("should revert on double initialization", async () => {
      const { eBrake } = get();
      await expect(eBrake.initialize(config.acm)).to.be.revertedWith("Initializable: contract is already initialized");
    });
  });
}

export function accessControlTests(config: NetworkConfig, get: FixtureGetter): void {
  describe("Access Control — ACM per-function", () => {
    it("should revert pauseActions from unauthorized caller", async () => {
      const { eBrake, randomUser } = get();
      await expect(
        eBrake.connect(randomUser).pauseActions([config.vToken1], [Action.MINT]),
      ).to.be.revertedWithCustomError(eBrake, "Unauthorized");
    });

    it("should revert pauseSupply from unauthorized caller", async () => {
      const { eBrake, randomUser } = get();
      await expect(eBrake.connect(randomUser).pauseSupply(config.vToken1)).to.be.revertedWithCustomError(
        eBrake,
        "Unauthorized",
      );
    });

    it("should revert pauseBorrow from unauthorized caller", async () => {
      const { eBrake, randomUser } = get();
      await expect(eBrake.connect(randomUser).pauseBorrow(config.vToken1)).to.be.revertedWithCustomError(
        eBrake,
        "Unauthorized",
      );
    });

    it("should revert pauseRedeem from unauthorized caller", async () => {
      const { eBrake, randomUser } = get();
      await expect(eBrake.connect(randomUser).pauseRedeem(config.vToken1)).to.be.revertedWithCustomError(
        eBrake,
        "Unauthorized",
      );
    });

    it("should revert pauseTransfer from unauthorized caller", async () => {
      const { eBrake, randomUser } = get();
      await expect(eBrake.connect(randomUser).pauseTransfer(config.vToken1)).to.be.revertedWithCustomError(
        eBrake,
        "Unauthorized",
      );
    });

    if (config.comptrollerType === "diamond") {
      it("should revert pauseFlashLoan from unauthorized caller", async () => {
        const { eBrake, randomUser } = get();
        await expect(eBrake.connect(randomUser).pauseFlashLoan()).to.be.revertedWithCustomError(eBrake, "Unauthorized");
      });

      it("should revert setCFZero(address,uint96) from unauthorized caller", async () => {
        const { eBrake, randomUser } = get();
        await expect(
          eBrake.connect(randomUser)["setCFZero(address,uint96)"](config.vToken1, 0),
        ).to.be.revertedWithCustomError(eBrake, "Unauthorized");
      });

      it("should revert disablePoolBorrow from unauthorized caller", async () => {
        const { eBrake, randomUser } = get();
        await expect(eBrake.connect(randomUser).disablePoolBorrow(0, config.vToken1)).to.be.revertedWithCustomError(
          eBrake,
          "Unauthorized",
        );
      });

      it("should revert revokeFlashLoanAccess from unauthorized caller", async () => {
        const { eBrake, randomUser } = get();
        await expect(
          eBrake.connect(randomUser).revokeFlashLoanAccess("0x0000000000000000000000000000000000001234"),
        ).to.be.revertedWithCustomError(eBrake, "Unauthorized");
      });
    }

    it("should revert setCFZero(address) from unauthorized caller", async () => {
      const { eBrake, randomUser } = get();
      await expect(eBrake.connect(randomUser)["setCFZero(address)"](config.vToken1)).to.be.revertedWithCustomError(
        eBrake,
        "Unauthorized",
      );
    });

    it("should revert setMarketBorrowCaps from unauthorized caller", async () => {
      const { eBrake, randomUser } = get();
      await expect(eBrake.connect(randomUser).setMarketBorrowCaps([config.vToken1], [0])).to.be.revertedWithCustomError(
        eBrake,
        "Unauthorized",
      );
    });

    it("should revert setMarketSupplyCaps from unauthorized caller", async () => {
      const { eBrake, randomUser } = get();
      await expect(eBrake.connect(randomUser).setMarketSupplyCaps([config.vToken1], [0])).to.be.revertedWithCustomError(
        eBrake,
        "Unauthorized",
      );
    });
  });
}

export function pauseTests(config: NetworkConfig, get: FixtureGetter): void {
  describe("Batch Pause — pauseActions", () => {
    it("should pause MINT on multiple markets", async () => {
      const { eBrake, comptroller, whitelistedUser } = get();
      await expect(eBrake.connect(whitelistedUser).pauseActions([config.vToken1, config.vToken2], [Action.MINT]))
        .to.emit(eBrake, "ActionsPaused")
        .withArgs(whitelistedUser.address, [config.vToken1, config.vToken2], [Action.MINT]);
      expect(await comptroller.actionPaused(config.vToken1, Action.MINT)).to.be.true;
      expect(await comptroller.actionPaused(config.vToken2, Action.MINT)).to.be.true;
    });

    it("should pause multiple actions on a market", async () => {
      const { eBrake, comptroller, whitelistedUser } = get();
      await expect(
        eBrake.connect(whitelistedUser).pauseActions([config.vToken1], [Action.MINT, Action.BORROW, Action.TRANSFER]),
      )
        .to.emit(eBrake, "ActionsPaused")
        .withArgs(whitelistedUser.address, [config.vToken1], [Action.MINT, Action.BORROW, Action.TRANSFER]);
      expect(await comptroller.actionPaused(config.vToken1, Action.MINT)).to.be.true;
      expect(await comptroller.actionPaused(config.vToken1, Action.BORROW)).to.be.true;
      expect(await comptroller.actionPaused(config.vToken1, Action.TRANSFER)).to.be.true;
    });

    const forbiddenActions = [
      { name: "REPAY", value: Action.REPAY },
      { name: "SEIZE", value: Action.SEIZE },
      { name: "LIQUIDATE", value: Action.LIQUIDATE },
      { name: "ENTER_MARKET", value: Action.ENTER_MARKET },
      { name: "EXIT_MARKET", value: Action.EXIT_MARKET },
    ];

    for (const { name, value } of forbiddenActions) {
      it(`should revert on forbidden action ${name}`, async () => {
        const { eBrake, whitelistedUser } = get();
        await expect(
          eBrake.connect(whitelistedUser).pauseActions([config.vToken1], [value]),
        ).to.be.revertedWithCustomError(eBrake, "ForbiddenAction");
      });
    }

    it("should revert on mixed allowed + forbidden actions in batch", async () => {
      const { eBrake, whitelistedUser } = get();
      await expect(
        eBrake.connect(whitelistedUser).pauseActions([config.vToken1], [Action.MINT, Action.REPAY]),
      ).to.be.revertedWithCustomError(eBrake, "ForbiddenAction");
    });

    it("should revert on empty markets array", async () => {
      const { eBrake, whitelistedUser } = get();
      await expect(eBrake.connect(whitelistedUser).pauseActions([], [Action.MINT])).to.be.revertedWithCustomError(
        eBrake,
        "EmptyArray",
      );
    });

    it("should revert on empty actions array", async () => {
      const { eBrake, whitelistedUser } = get();
      await expect(eBrake.connect(whitelistedUser).pauseActions([config.vToken1], [])).to.be.revertedWithCustomError(
        eBrake,
        "EmptyArray",
      );
    });
  });

  describe("Single Market Pausing", () => {
    const fns = [
      { name: "pauseSupply", action: Action.MINT, fn: "pauseSupply" as const },
      { name: "pauseRedeem", action: Action.REDEEM, fn: "pauseRedeem" as const },
      { name: "pauseBorrow", action: Action.BORROW, fn: "pauseBorrow" as const },
      { name: "pauseTransfer", action: Action.TRANSFER, fn: "pauseTransfer" as const },
    ];

    for (const { name, action, fn } of fns) {
      it(`${name} should pause and verify on comptroller`, async () => {
        const { eBrake, comptroller, whitelistedUser } = get();
        await expect(eBrake.connect(whitelistedUser)[fn](config.vToken1))
          .to.emit(eBrake, "ActionPaused")
          .withArgs(whitelistedUser.address, config.vToken1, action);
        expect(await comptroller.actionPaused(config.vToken1, action)).to.be.true;
      });
    }
  });
}

export function capTests(config: NetworkConfig, get: FixtureGetter): void {
  describe("setMarketBorrowCaps", () => {
    it("should decrease borrow cap to half", async () => {
      const { eBrake, comptroller, whitelistedUser } = get();
      const currentCap = await comptroller.borrowCaps(config.vToken1);
      expect(currentCap).to.be.gt(0);
      const newCap = currentCap.div(2);
      await expect(eBrake.connect(whitelistedUser).setMarketBorrowCaps([config.vToken1], [newCap]))
        .to.emit(eBrake, "BorrowCapsDecreased")
        .withArgs(whitelistedUser.address, [config.vToken1], [newCap]);
      expect(await comptroller.borrowCaps(config.vToken1)).to.equal(newCap);
    });

    it("should set borrow cap to zero", async () => {
      const { eBrake, comptroller, whitelistedUser } = get();
      await expect(eBrake.connect(whitelistedUser).setMarketBorrowCaps([config.vToken1], [0]))
        .to.emit(eBrake, "BorrowCapsDecreased")
        .withArgs(whitelistedUser.address, [config.vToken1], [0]);
      expect(await comptroller.borrowCaps(config.vToken1)).to.equal(0);
    });

    it("should revert when increasing borrow cap", async () => {
      const { eBrake, comptroller, whitelistedUser } = get();
      const currentCap = await comptroller.borrowCaps(config.vToken1);
      await expect(
        eBrake.connect(whitelistedUser).setMarketBorrowCaps([config.vToken1], [currentCap.add(1)]),
      ).to.be.revertedWithCustomError(eBrake, "CapExceedsCurrent");
    });

    it("should allow setting same borrow cap (no-op) without snapshot or event [I04]", async () => {
      const { eBrake, comptroller, whitelistedUser } = get();
      const currentCap = await comptroller.borrowCaps(config.vToken1);
      expect(currentCap).to.be.gt(0);

      // No-op call must not emit (entire-batch-no-op suppression)
      await expect(eBrake.connect(whitelistedUser).setMarketBorrowCaps([config.vToken1], [currentCap])).to.not.emit(
        eBrake,
        "BorrowCapsDecreased",
      );

      // Comptroller cap unchanged
      expect(await comptroller.borrowCaps(config.vToken1)).to.equal(currentCap);

      // Snapshot must NOT be polluted by the no-op call
      const snapshot = await eBrake.marketStates(config.vToken1);
      expect(snapshot.borrowCapSnapshotted).to.be.false;
      expect(snapshot.borrowCap).to.equal(0);
    });

    it("should preserve correct borrow cap snapshot across no-op then real tightening [I04]", async () => {
      const { eBrake, comptroller, whitelistedUser } = get();
      const originalCap = await comptroller.borrowCaps(config.vToken1);
      expect(originalCap).to.be.gt(1);

      // Step 1: no-op (current == new). Must not snapshot or set the sentinel.
      await eBrake.connect(whitelistedUser).setMarketBorrowCaps([config.vToken1], [originalCap]);
      const afterNoop = await eBrake.marketStates(config.vToken1);
      expect(afterNoop.borrowCapSnapshotted).to.be.false;

      // Step 2: real tightening. Snapshot must record `originalCap` (not stale, not 0).
      await eBrake.connect(whitelistedUser).setMarketBorrowCaps([config.vToken1], [0]);
      const afterTighten = await eBrake.marketStates(config.vToken1);
      expect(afterTighten.borrowCapSnapshotted).to.be.true;
      expect(afterTighten.borrowCap).to.equal(originalCap);
    });

    it("should handle multiple markets", async () => {
      const { eBrake, comptroller, whitelistedUser } = get();
      await eBrake.connect(whitelistedUser).setMarketBorrowCaps([config.vToken1, config.vToken2], [0, 0]);
      expect(await comptroller.borrowCaps(config.vToken1)).to.equal(0);
      expect(await comptroller.borrowCaps(config.vToken2)).to.equal(0);
    });

    it("should revert on empty array", async () => {
      const { eBrake, whitelistedUser } = get();
      await expect(eBrake.connect(whitelistedUser).setMarketBorrowCaps([], [])).to.be.revertedWithCustomError(
        eBrake,
        "EmptyArray",
      );
    });

    it("should revert on length mismatch", async () => {
      const { eBrake, whitelistedUser } = get();
      await expect(
        eBrake.connect(whitelistedUser).setMarketBorrowCaps([config.vToken1, config.vToken2], [0]),
      ).to.be.revertedWithCustomError(eBrake, "ArrayLengthMismatch");
    });

    it("should allow batch with already-zeroed markets", async () => {
      const { eBrake, comptroller, whitelistedUser } = get();
      await eBrake.connect(whitelistedUser).setMarketBorrowCaps([config.vToken1], [0]);
      expect(await comptroller.borrowCaps(config.vToken1)).to.equal(0);

      // Batch including already-zeroed market should not revert
      await expect(eBrake.connect(whitelistedUser).setMarketBorrowCaps([config.vToken1, config.vToken2], [0, 0])).to.not
        .be.reverted;
    });
  });

  describe("setMarketSupplyCaps", () => {
    it("should decrease supply cap to half", async () => {
      const { eBrake, comptroller, whitelistedUser } = get();
      const currentCap = await comptroller.supplyCaps(config.vToken1);
      expect(currentCap).to.be.gt(0);
      const newCap = currentCap.div(2);
      await expect(eBrake.connect(whitelistedUser).setMarketSupplyCaps([config.vToken1], [newCap]))
        .to.emit(eBrake, "SupplyCapsDecreased")
        .withArgs(whitelistedUser.address, [config.vToken1], [newCap]);
      expect(await comptroller.supplyCaps(config.vToken1)).to.equal(newCap);
    });

    it("should set supply cap to zero", async () => {
      const { eBrake, comptroller, whitelistedUser } = get();
      await expect(eBrake.connect(whitelistedUser).setMarketSupplyCaps([config.vToken1], [0]))
        .to.emit(eBrake, "SupplyCapsDecreased")
        .withArgs(whitelistedUser.address, [config.vToken1], [0]);
      expect(await comptroller.supplyCaps(config.vToken1)).to.equal(0);
    });

    it("should revert when increasing supply cap", async () => {
      const { eBrake, comptroller, whitelistedUser } = get();
      const currentCap = await comptroller.supplyCaps(config.vToken1);
      await expect(
        eBrake.connect(whitelistedUser).setMarketSupplyCaps([config.vToken1], [currentCap.add(1)]),
      ).to.be.revertedWithCustomError(eBrake, "CapExceedsCurrent");
    });

    it("should allow setting same supply cap (no-op) without snapshot or event [I04]", async () => {
      const { eBrake, comptroller, whitelistedUser } = get();
      const currentCap = await comptroller.supplyCaps(config.vToken1);
      expect(currentCap).to.be.gt(0);

      // No-op call must not emit (entire-batch-no-op suppression)
      await expect(eBrake.connect(whitelistedUser).setMarketSupplyCaps([config.vToken1], [currentCap])).to.not.emit(
        eBrake,
        "SupplyCapsDecreased",
      );

      // Comptroller cap unchanged
      expect(await comptroller.supplyCaps(config.vToken1)).to.equal(currentCap);

      // Snapshot must NOT be polluted by the no-op call
      const snapshot = await eBrake.marketStates(config.vToken1);
      expect(snapshot.supplyCapSnapshotted).to.be.false;
      expect(snapshot.supplyCap).to.equal(0);
    });

    it("should preserve correct supply cap snapshot across no-op then real tightening [I04]", async () => {
      const { eBrake, comptroller, whitelistedUser } = get();
      const originalCap = await comptroller.supplyCaps(config.vToken1);
      expect(originalCap).to.be.gt(1);

      // Step 1: no-op (current == new). Must not snapshot or set the sentinel.
      await eBrake.connect(whitelistedUser).setMarketSupplyCaps([config.vToken1], [originalCap]);
      const afterNoop = await eBrake.marketStates(config.vToken1);
      expect(afterNoop.supplyCapSnapshotted).to.be.false;

      // Step 2: real tightening. Snapshot must record `originalCap` (not stale, not 0).
      await eBrake.connect(whitelistedUser).setMarketSupplyCaps([config.vToken1], [0]);
      const afterTighten = await eBrake.marketStates(config.vToken1);
      expect(afterTighten.supplyCapSnapshotted).to.be.true;
      expect(afterTighten.supplyCap).to.equal(originalCap);
    });

    it("should handle multiple markets", async () => {
      const { eBrake, comptroller, whitelistedUser } = get();
      await eBrake.connect(whitelistedUser).setMarketSupplyCaps([config.vToken1, config.vToken2], [0, 0]);
      expect(await comptroller.supplyCaps(config.vToken1)).to.equal(0);
      expect(await comptroller.supplyCaps(config.vToken2)).to.equal(0);
    });

    it("should revert on empty array", async () => {
      const { eBrake, whitelistedUser } = get();
      await expect(eBrake.connect(whitelistedUser).setMarketSupplyCaps([], [])).to.be.revertedWithCustomError(
        eBrake,
        "EmptyArray",
      );
    });

    it("should revert on length mismatch", async () => {
      const { eBrake, whitelistedUser } = get();
      await expect(
        eBrake.connect(whitelistedUser).setMarketSupplyCaps([config.vToken1, config.vToken2], [0]),
      ).to.be.revertedWithCustomError(eBrake, "ArrayLengthMismatch");
    });

    it("should allow batch with already-zeroed markets", async () => {
      const { eBrake, comptroller, whitelistedUser } = get();
      await eBrake.connect(whitelistedUser).setMarketSupplyCaps([config.vToken1], [0]);
      expect(await comptroller.supplyCaps(config.vToken1)).to.equal(0);

      // Batch including already-zeroed market should not revert
      await expect(eBrake.connect(whitelistedUser).setMarketSupplyCaps([config.vToken1, config.vToken2], [0, 0])).to.not
        .be.reverted;
    });
  });
}

export function setCFZeroTests(config: NetworkConfig, get: FixtureGetter): void {
  describe("setCFZero(address) — unified batch", () => {
    if (config.comptrollerType === "il") {
      it("should set CF to zero while preserving LT (IL comptroller)", async () => {
        const { eBrake, comptroller, whitelistedUser } = get();
        const marketBefore = await comptroller.markets(config.vToken1);
        expect(marketBefore.isListed).to.be.true;
        expect(marketBefore.collateralFactorMantissa).to.be.gt(0);
        expect(marketBefore.liquidationThresholdMantissa).to.be.gt(0);

        await expect(eBrake.connect(whitelistedUser)["setCFZero(address)"](config.vToken1))
          .to.emit(eBrake, "CollateralFactorZeroed")
          .withArgs(whitelistedUser.address, config.vToken1, 0);

        const marketAfter = await comptroller.markets(config.vToken1);
        expect(marketAfter.collateralFactorMantissa).to.equal(0);
        expect(marketAfter.liquidationThresholdMantissa).to.equal(marketBefore.liquidationThresholdMantissa);
      });

      it("should revert for unlisted market", async () => {
        const { eBrake, whitelistedUser } = get();
        await expect(
          eBrake.connect(whitelistedUser)["setCFZero(address)"]("0x0000000000000000000000000000000000000001"),
        ).to.be.revertedWithCustomError(eBrake, "MarketNotListed");
      });
    } else {
      it("should set CF to zero while preserving LT (Diamond comptroller)", async () => {
        const { eBrake, comptroller, whitelistedUser } = get();
        const CORE_POOL_ID = 0;
        const marketBefore = await comptroller.poolMarkets(CORE_POOL_ID, config.vToken1);
        expect(marketBefore.collateralFactorMantissa).to.be.gt(0);
        expect(marketBefore.liquidationThresholdMantissa).to.be.gt(0);

        await expect(eBrake.connect(whitelistedUser)["setCFZero(address)"](config.vToken1))
          .to.emit(eBrake, "CollateralFactorZeroed")
          .withArgs(whitelistedUser.address, config.vToken1, CORE_POOL_ID);

        const marketAfter = await comptroller.poolMarkets(CORE_POOL_ID, config.vToken1);
        expect(marketAfter.collateralFactorMantissa).to.equal(0);
        expect(marketAfter.liquidationThresholdMantissa).to.equal(marketBefore.liquidationThresholdMantissa);
      });

      it("should skip e-mode pools where market is not listed", async () => {
        const { eBrake, whitelistedUser } = get();
        // vToken1 is listed in core pool; e-mode pools where it is absent are silently skipped
        await expect(eBrake.connect(whitelistedUser)["setCFZero(address)"](config.vToken1)).to.not.be.reverted;
      });

      it("should revert for unlisted market", async () => {
        const { eBrake, whitelistedUser } = get();
        await expect(
          eBrake.connect(whitelistedUser)["setCFZero(address)"]("0x0000000000000000000000000000000000000001"),
        ).to.be.revertedWithCustomError(eBrake, "MarketNotListed");
      });
    }
  });
}

export function marketStateTests(config: NetworkConfig, get: FixtureGetter): void {
  describe("MarketState Snapshots", () => {
    describe("CF Snapshot", () => {
      if (config.comptrollerType === "il") {
        it("should snapshot CF and LT when setCFZero is called (IL)", async () => {
          const { eBrake, comptroller, whitelistedUser } = get();
          const marketBefore = await comptroller.markets(config.vToken1);
          expect(marketBefore.collateralFactorMantissa).to.be.gt(0);

          await eBrake.connect(whitelistedUser)["setCFZero(address)"](config.vToken1);

          const snapshot = await eBrake.getMarketCFSnapshot(config.vToken1, 0);
          expect(snapshot.cf).to.equal(marketBefore.collateralFactorMantissa);
          expect(snapshot.lt).to.equal(marketBefore.liquidationThresholdMantissa);
        });

        it("should not overwrite CF snapshot on second call (first-write-wins)", async () => {
          const { eBrake, comptroller, whitelistedUser } = get();
          const marketBefore = await comptroller.markets(config.vToken1);

          await eBrake.connect(whitelistedUser)["setCFZero(address)"](config.vToken1);
          // Second call — CF is now 0, snapshot should NOT be overwritten
          await eBrake.connect(whitelistedUser)["setCFZero(address)"](config.vToken1);

          const snapshot = await eBrake.getMarketCFSnapshot(config.vToken1, 0);
          expect(snapshot.cf).to.equal(marketBefore.collateralFactorMantissa);
          expect(snapshot.lt).to.equal(marketBefore.liquidationThresholdMantissa);
        });
      } else {
        it("should snapshot CF and LT per pool when setCFZero(address) is called (Diamond)", async () => {
          const { eBrake, comptroller, whitelistedUser } = get();
          const CORE_POOL_ID = 0;
          const marketBefore = await comptroller.poolMarkets(CORE_POOL_ID, config.vToken1);
          expect(marketBefore.collateralFactorMantissa).to.be.gt(0);

          await eBrake.connect(whitelistedUser)["setCFZero(address)"](config.vToken1);

          const snapshot = await eBrake.getMarketCFSnapshot(config.vToken1, CORE_POOL_ID);
          expect(snapshot.cf).to.equal(marketBefore.collateralFactorMantissa);
          expect(snapshot.lt).to.equal(marketBefore.liquidationThresholdMantissa);
        });

        it("should snapshot CF when setCFZero(address,uint96) is called for a specific pool", async () => {
          const { eBrake, comptroller, whitelistedUser } = get();
          const CORE_POOL_ID = 0;
          const marketBefore = await comptroller.poolMarkets(CORE_POOL_ID, config.vToken1);
          expect(marketBefore.collateralFactorMantissa).to.be.gt(0);

          await eBrake.connect(whitelistedUser)["setCFZero(address,uint96)"](config.vToken1, CORE_POOL_ID);

          const snapshot = await eBrake.getMarketCFSnapshot(config.vToken1, CORE_POOL_ID);
          expect(snapshot.cf).to.equal(marketBefore.collateralFactorMantissa);
          expect(snapshot.lt).to.equal(marketBefore.liquidationThresholdMantissa);
        });

        it("should not overwrite CF snapshot on second call (first-write-wins, Diamond)", async () => {
          const { eBrake, comptroller, whitelistedUser } = get();
          const CORE_POOL_ID = 0;
          const marketBefore = await comptroller.poolMarkets(CORE_POOL_ID, config.vToken1);

          await eBrake.connect(whitelistedUser)["setCFZero(address)"](config.vToken1);
          await eBrake.connect(whitelistedUser)["setCFZero(address)"](config.vToken1);

          const snapshot = await eBrake.getMarketCFSnapshot(config.vToken1, CORE_POOL_ID);
          expect(snapshot.cf).to.equal(marketBefore.collateralFactorMantissa);
          expect(snapshot.lt).to.equal(marketBefore.liquidationThresholdMantissa);
        });
      }
    });

    describe("Cap Snapshots", () => {
      it("should snapshot borrow cap when setMarketBorrowCaps is called", async () => {
        const { eBrake, comptroller, whitelistedUser } = get();
        const currentCap = await comptroller.borrowCaps(config.vToken1);
        expect(currentCap).to.be.gt(0);

        await eBrake.connect(whitelistedUser).setMarketBorrowCaps([config.vToken1], [0]);

        const snapshot = await eBrake.marketStates(config.vToken1);
        expect(snapshot.borrowCap).to.equal(currentCap);
        expect(snapshot.borrowCapSnapshotted).to.be.true;
      });

      it("should not overwrite borrow cap snapshot on second call (first-write-wins)", async () => {
        const { eBrake, comptroller, whitelistedUser } = get();
        const originalCap = await comptroller.borrowCaps(config.vToken1);
        expect(originalCap).to.be.gt(0);
        const halfCap = originalCap.div(2);

        await eBrake.connect(whitelistedUser).setMarketBorrowCaps([config.vToken1], [halfCap]);
        // Second call — cap is now halfCap, snapshot should NOT be overwritten
        await eBrake.connect(whitelistedUser).setMarketBorrowCaps([config.vToken1], [0]);

        const snapshot = await eBrake.marketStates(config.vToken1);
        expect(snapshot.borrowCap).to.equal(originalCap);
        expect(snapshot.borrowCapSnapshotted).to.be.true;
      });

      it("should snapshot supply cap when setMarketSupplyCaps is called", async () => {
        const { eBrake, comptroller, whitelistedUser } = get();
        const currentCap = await comptroller.supplyCaps(config.vToken1);
        expect(currentCap).to.be.gt(0);

        await eBrake.connect(whitelistedUser).setMarketSupplyCaps([config.vToken1], [0]);

        const snapshot = await eBrake.marketStates(config.vToken1);
        expect(snapshot.supplyCap).to.equal(currentCap);
        expect(snapshot.supplyCapSnapshotted).to.be.true;
      });

      it("should not overwrite supply cap snapshot on second call (first-write-wins)", async () => {
        const { eBrake, comptroller, whitelistedUser } = get();
        const originalCap = await comptroller.supplyCaps(config.vToken1);
        expect(originalCap).to.be.gt(0);
        const halfCap = originalCap.div(2);

        await eBrake.connect(whitelistedUser).setMarketSupplyCaps([config.vToken1], [halfCap]);
        await eBrake.connect(whitelistedUser).setMarketSupplyCaps([config.vToken1], [0]);

        const snapshot = await eBrake.marketStates(config.vToken1);
        expect(snapshot.supplyCap).to.equal(originalCap);
        expect(snapshot.supplyCapSnapshotted).to.be.true;
      });

      it("should snapshot caps for multiple markets independently", async () => {
        const { eBrake, comptroller, whitelistedUser } = get();
        const cap1 = await comptroller.borrowCaps(config.vToken1);
        const cap2 = await comptroller.borrowCaps(config.vToken2);

        await eBrake.connect(whitelistedUser).setMarketBorrowCaps([config.vToken1, config.vToken2], [0, 0]);

        const snapshot1 = await eBrake.marketStates(config.vToken1);
        const snapshot2 = await eBrake.marketStates(config.vToken2);
        expect(snapshot1.borrowCap).to.equal(cap1);
        expect(snapshot2.borrowCap).to.equal(cap2);
      });
    });

    describe("resetMarketState", () => {
      it("should clear CF snapshot after reset", async () => {
        const { eBrake, whitelistedUser } = get();
        const poolId = config.comptrollerType === "il" ? 0 : 0;

        await eBrake.connect(whitelistedUser)["setCFZero(address)"](config.vToken1);
        const snapshotBefore = await eBrake.getMarketCFSnapshot(config.vToken1, poolId);
        expect(snapshotBefore.cf).to.be.gt(0);

        await expect(eBrake.connect(whitelistedUser).resetMarketState(config.vToken1))
          .to.emit(eBrake, "MarketStateReset")
          .withArgs(config.vToken1);

        const snapshotAfter = await eBrake.getMarketCFSnapshot(config.vToken1, poolId);
        expect(snapshotAfter.cf).to.equal(0);
        expect(snapshotAfter.lt).to.equal(0);
      });

      it("should clear cap snapshots after reset", async () => {
        const { eBrake, whitelistedUser } = get();

        await eBrake.connect(whitelistedUser).setMarketBorrowCaps([config.vToken1], [0]);
        await eBrake.connect(whitelistedUser).setMarketSupplyCaps([config.vToken1], [0]);

        const before = await eBrake.marketStates(config.vToken1);
        expect(before.borrowCapSnapshotted).to.be.true;
        expect(before.supplyCapSnapshotted).to.be.true;

        await eBrake.connect(whitelistedUser).resetMarketState(config.vToken1);

        const after = await eBrake.marketStates(config.vToken1);
        expect(after.borrowCap).to.equal(0);
        expect(after.supplyCap).to.equal(0);
        expect(after.borrowCapSnapshotted).to.be.false;
        expect(after.supplyCapSnapshotted).to.be.false;
      });

      it("should allow fresh snapshot after reset", async () => {
        const { eBrake, comptroller, whitelistedUser } = get();

        // First incident: snapshot original cap, partial-tighten so a real
        // second tightening is still possible after reset.
        const originalCap = await comptroller.borrowCaps(config.vToken2);
        expect(originalCap).to.be.gt(1);
        const halfCap = originalCap.div(2);

        await eBrake.connect(whitelistedUser).setMarketBorrowCaps([config.vToken2], [halfCap]);
        const snapshot1 = await eBrake.marketStates(config.vToken2);
        expect(snapshot1.borrowCap).to.equal(originalCap);
        expect(snapshot1.borrowCapSnapshotted).to.be.true;

        // Reset after governance recovery
        await eBrake.connect(whitelistedUser).resetMarketState(config.vToken2);
        const reset = await eBrake.marketStates(config.vToken2);
        expect(reset.borrowCapSnapshotted).to.be.false;
        expect(reset.borrowCap).to.equal(0);

        // Second real tightening — comptroller cap is now halfCap, so the fresh
        // snapshot must capture halfCap (proves reset cleared the sentinel and
        // a subsequent real decrease re-snapshots correctly).
        await eBrake.connect(whitelistedUser).setMarketBorrowCaps([config.vToken2], [0]);
        const snapshot2 = await eBrake.marketStates(config.vToken2);
        expect(snapshot2.borrowCap).to.equal(halfCap);
        expect(snapshot2.borrowCapSnapshotted).to.be.true;
      });

      it("should revert resetMarketState from unauthorized caller", async () => {
        const { eBrake, randomUser } = get();
        await expect(eBrake.connect(randomUser).resetMarketState(config.vToken1)).to.be.revertedWithCustomError(
          eBrake,
          "Unauthorized",
        );
      });
    });

    describe("View Functions — no snapshot exists", () => {
      it("should return zeros for CF snapshot when none exists", async () => {
        const { eBrake } = get();
        const snapshot = await eBrake.getMarketCFSnapshot(config.vToken1, 0);
        expect(snapshot.cf).to.equal(0);
        expect(snapshot.lt).to.equal(0);
      });

      it("should return zeros/false for cap snapshot when none exists", async () => {
        const { eBrake } = get();
        const snapshot = await eBrake.marketStates(config.vToken1);
        expect(snapshot.borrowCap).to.equal(0);
        expect(snapshot.supplyCap).to.equal(0);
        expect(snapshot.borrowCapSnapshotted).to.be.false;
        expect(snapshot.supplyCapSnapshotted).to.be.false;
      });
    });
  });
}

// ── Convenience wrapper ──

export function runSharedTests(config: NetworkConfig, get: FixtureGetter): void {
  deploymentTests(config, get);
  accessControlTests(config, get);
  pauseTests(config, get);
  capTests(config, get);
  setCFZeroTests(config, get);
  marketStateTests(config, get);
}
