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
    const eBrake = (await EBrakeFactory.deploy(config.comptroller, config.acm)) as EBrake;

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

    it("should revert deployment with zero comptroller", async () => {
      const { eBrake } = get();
      const F = await ethers.getContractFactory("EBrake");
      await expect(F.deploy(ethers.constants.AddressZero, config.acm)).to.be.revertedWithCustomError(
        eBrake,
        "ZeroAddress",
      );
    });

    it("should revert deployment with zero ACM", async () => {
      const { eBrake } = get();
      const F = await ethers.getContractFactory("EBrake");
      await expect(F.deploy(config.comptroller, ethers.constants.AddressZero)).to.be.revertedWithCustomError(
        eBrake,
        "ZeroAddress",
      );
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

      it("should revert setCFZero from unauthorized caller", async () => {
        const { eBrake, randomUser } = get();
        await expect(eBrake.connect(randomUser).setCFZero(config.vToken1, 0)).to.be.revertedWithCustomError(
          eBrake,
          "Unauthorized",
        );
      });
    }

    it("should revert setCFZeroIsolated from unauthorized caller", async () => {
      const { eBrake, randomUser } = get();
      await expect(eBrake.connect(randomUser).setCFZeroIsolated(config.vToken1)).to.be.revertedWithCustomError(
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
      await eBrake.connect(whitelistedUser).pauseActions([config.vToken1, config.vToken2], [Action.MINT]);
      expect(await comptroller.actionPaused(config.vToken1, Action.MINT)).to.be.true;
      expect(await comptroller.actionPaused(config.vToken2, Action.MINT)).to.be.true;
    });

    it("should pause multiple actions on a market", async () => {
      const { eBrake, comptroller, whitelistedUser } = get();
      await eBrake
        .connect(whitelistedUser)
        .pauseActions([config.vToken1], [Action.MINT, Action.BORROW, Action.TRANSFER]);
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
        await eBrake.connect(whitelistedUser)[fn](config.vToken1);
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
      await eBrake.connect(whitelistedUser).setMarketBorrowCaps([config.vToken1], [newCap]);
      expect(await comptroller.borrowCaps(config.vToken1)).to.equal(newCap);
    });

    it("should set borrow cap to zero", async () => {
      const { eBrake, comptroller, whitelistedUser } = get();
      await eBrake.connect(whitelistedUser).setMarketBorrowCaps([config.vToken1], [0]);
      expect(await comptroller.borrowCaps(config.vToken1)).to.equal(0);
    });

    it("should revert when increasing borrow cap", async () => {
      const { eBrake, comptroller, whitelistedUser } = get();
      const currentCap = await comptroller.borrowCaps(config.vToken1);
      await expect(
        eBrake.connect(whitelistedUser).setMarketBorrowCaps([config.vToken1], [currentCap.add(1)]),
      ).to.be.revertedWithCustomError(eBrake, "CapCanOnlyDecrease");
    });

    it("should revert when setting same borrow cap", async () => {
      const { eBrake, comptroller, whitelistedUser } = get();
      const currentCap = await comptroller.borrowCaps(config.vToken1);
      await expect(
        eBrake.connect(whitelistedUser).setMarketBorrowCaps([config.vToken1], [currentCap]),
      ).to.be.revertedWithCustomError(eBrake, "CapCanOnlyDecrease");
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

    it("should skip markets where current cap is already 0", async () => {
      const { eBrake, comptroller, whitelistedUser } = get();
      await eBrake.connect(whitelistedUser).setMarketBorrowCaps([config.vToken1], [0]);
      expect(await comptroller.borrowCaps(config.vToken1)).to.equal(0);
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
      await eBrake.connect(whitelistedUser).setMarketSupplyCaps([config.vToken1], [newCap]);
      expect(await comptroller.supplyCaps(config.vToken1)).to.equal(newCap);
    });

    it("should set supply cap to zero", async () => {
      const { eBrake, comptroller, whitelistedUser } = get();
      await eBrake.connect(whitelistedUser).setMarketSupplyCaps([config.vToken1], [0]);
      expect(await comptroller.supplyCaps(config.vToken1)).to.equal(0);
    });

    it("should revert when increasing supply cap", async () => {
      const { eBrake, comptroller, whitelistedUser } = get();
      const currentCap = await comptroller.supplyCaps(config.vToken1);
      await expect(
        eBrake.connect(whitelistedUser).setMarketSupplyCaps([config.vToken1], [currentCap.add(1)]),
      ).to.be.revertedWithCustomError(eBrake, "CapCanOnlyDecrease");
    });

    it("should revert when setting same supply cap", async () => {
      const { eBrake, comptroller, whitelistedUser } = get();
      const currentCap = await comptroller.supplyCaps(config.vToken1);
      await expect(
        eBrake.connect(whitelistedUser).setMarketSupplyCaps([config.vToken1], [currentCap]),
      ).to.be.revertedWithCustomError(eBrake, "CapCanOnlyDecrease");
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

    it("should skip markets where current cap is already 0", async () => {
      const { eBrake, comptroller, whitelistedUser } = get();
      await eBrake.connect(whitelistedUser).setMarketSupplyCaps([config.vToken1], [0]);
      expect(await comptroller.supplyCaps(config.vToken1)).to.equal(0);
      await expect(eBrake.connect(whitelistedUser).setMarketSupplyCaps([config.vToken1, config.vToken2], [0, 0])).to.not
        .be.reverted;
    });
  });
}

export function setCFZeroIsolatedTests(config: NetworkConfig, get: FixtureGetter): void {
  describe("setCFZeroIsolated", () => {
    it("should set CF to zero while preserving LT", async () => {
      const { eBrake, comptroller, whitelistedUser } = get();
      const marketBefore = await comptroller.markets(config.vToken1);
      expect(marketBefore.isListed).to.be.true;
      expect(marketBefore.collateralFactorMantissa).to.be.gt(0);
      expect(marketBefore.liquidationThresholdMantissa).to.be.gt(0);

      await eBrake.connect(whitelistedUser).setCFZeroIsolated(config.vToken1);

      const marketAfter = await comptroller.markets(config.vToken1);
      expect(marketAfter.collateralFactorMantissa).to.equal(0);
      expect(marketAfter.liquidationThresholdMantissa).to.equal(marketBefore.liquidationThresholdMantissa);
    });

    it("should revert for unlisted market", async () => {
      const { eBrake, whitelistedUser } = get();
      await expect(
        eBrake.connect(whitelistedUser).setCFZeroIsolated("0x0000000000000000000000000000000000000001"),
      ).to.be.revertedWithCustomError(eBrake, "MarketNotListed");
    });
  });
}

// ── Convenience wrapper ──

export function runSharedTests(config: NetworkConfig, get: FixtureGetter): void {
  deploymentTests(config, get);
  accessControlTests(config, get);
  pauseTests(config, get);
  capTests(config, get);
}
