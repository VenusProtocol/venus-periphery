// ═══════════════════════════════════════════════════════════════════════════
// Executor Fork Test — Shared Fixture and Test Factories
// ═══════════════════════════════════════════════════════════════════════════
/// <reference types="@openzeppelin/hardhat-upgrades" />
import "@nomicfoundation/hardhat-chai-matchers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { BigNumber, Contract } from "ethers";
import { ethers, upgrades } from "hardhat";

import { EBrake, Executor } from "../../../../typechain";
import { initMainnetUser } from "../utils";
import { ExecutorNetworkConfig } from "./configs";

// ═══════════════════════════════════════════════════════════════════════════
// ABIs
// ═══════════════════════════════════════════════════════════════════════════

const ACM_ABI = [
  "function giveCallPermission(address contractAddress, string calldata functionSig, address accountToPermit)",
];

const DIAMOND_COMPTROLLER_ABI = [
  "function poolMarkets(uint96 poolId, address vToken) view returns (bool isListed, uint256 collateralFactorMantissa, bool isVenus, uint256 liquidationThresholdMantissa, uint256 liquidationIncentiveMantissa, uint96 marketPoolId, bool isBorrowAllowed)",
  "function corePoolId() view returns (uint96)",
  "function lastPoolId() view returns (uint96)",
  "function borrowCaps(address vToken) view returns (uint256)",
  "function supplyCaps(address vToken) view returns (uint256)",
  "function actionPaused(address vToken, uint8 action) view returns (bool)",
  "function _setMarketBorrowCaps(address[] calldata, uint256[] calldata)",
  "function _setMarketSupplyCaps(address[] calldata, uint256[] calldata)",
];

const IL_COMPTROLLER_ABI = [
  "function markets(address vToken) view returns (bool isListed, uint256 collateralFactorMantissa, uint256 liquidationThresholdMantissa)",
  "function borrowCaps(address vToken) view returns (uint256)",
  "function supplyCaps(address vToken) view returns (uint256)",
  "function actionPaused(address vToken, uint8 action) view returns (bool)",
  "function setMarketBorrowCaps(address[] calldata, uint256[] calldata)",
  "function setMarketSupplyCaps(address[] calldata, uint256[] calldata)",
];

const CORE_POOL_ID = 0;

export const Action = { MINT: 0, BORROW: 2 };

// ═══════════════════════════════════════════════════════════════════════════
// COMPTROLLER HELPERS (Diamond vs IL)
// ═══════════════════════════════════════════════════════════════════════════

function comptrollerAbi(config: ExecutorNetworkConfig): string[] {
  return config.comptrollerType === "diamond" ? DIAMOND_COMPTROLLER_ABI : IL_COMPTROLLER_ABI;
}

function comptrollerPermissions(config: ExecutorNetworkConfig): string[] {
  return config.comptrollerType === "diamond"
    ? [
        "setCollateralFactor(uint96,address,uint256,uint256)",
        "_setMarketBorrowCaps(address[],uint256[])",
        "_setMarketSupplyCaps(address[],uint256[])",
        "_setActionsPaused(address[],uint8[],bool)",
      ]
    : [
        "setCollateralFactor(address,uint256,uint256)",
        "setMarketBorrowCaps(address[],uint256[])",
        "setMarketSupplyCaps(address[],uint256[])",
        "setActionsPaused(address[],uint8[],bool)",
      ];
}

async function getMarketCF(
  comptroller: Contract,
  market: string,
  config: ExecutorNetworkConfig,
): Promise<{ cf: BigNumber; lt: BigNumber }> {
  if (config.comptrollerType === "diamond") {
    const m = await comptroller.poolMarkets(CORE_POOL_ID, market);
    return { cf: m.collateralFactorMantissa, lt: m.liquidationThresholdMantissa };
  } else {
    const m = await comptroller.markets(market);
    return { cf: m.collateralFactorMantissa, lt: m.liquidationThresholdMantissa };
  }
}

async function setBorrowCapDirect(
  comptroller: Contract,
  market: string,
  cap: BigNumber | number,
  config: ExecutorNetworkConfig,
): Promise<void> {
  if (config.comptrollerType === "diamond") {
    await comptroller._setMarketBorrowCaps([market], [cap]);
  } else {
    await comptroller.setMarketBorrowCaps([market], [cap]);
  }
}

async function setSupplyCapDirect(
  comptroller: Contract,
  market: string,
  cap: BigNumber | number,
  config: ExecutorNetworkConfig,
): Promise<void> {
  if (config.comptrollerType === "diamond") {
    await comptroller._setMarketSupplyCaps([market], [cap]);
  } else {
    await comptroller.setMarketSupplyCaps([market], [cap]);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// FIXTURE
// ═══════════════════════════════════════════════════════════════════════════

export type ExecutorFixture = {
  eBrake: EBrake;
  executor: Executor;
  comptroller: Contract;
  governance: SignerWithAddress;
  hypernative: SignerWithAddress;
  randomUser: SignerWithAddress;
  testMarket: string;
  originalLTV: BigNumber;
  originalBorrowCap: BigNumber;
  originalSupplyCap: BigNumber;
  config: ExecutorNetworkConfig;
};

export type FixtureGetter = () => ExecutorFixture;

export function createDeployFixture(config: ExecutorNetworkConfig): () => Promise<ExecutorFixture> {
  return async function deployExecutorFixture(): Promise<ExecutorFixture> {
    const [, randomUser] = await ethers.getSigners();

    const governance = await initMainnetUser(config.timelock, ethers.utils.parseUnits("10"));
    const hypernative = await initMainnetUser(
      "0x0000000000000000000000000000000000005678",
      ethers.utils.parseUnits("10"),
    );

    const acm = new ethers.Contract(config.acm, ACM_ABI, governance);
    const comptroller = new ethers.Contract(config.comptroller, comptrollerAbi(config), governance);

    // ── Deploy EBrake proxy ──
    const EBrakeFactory = await ethers.getContractFactory("EBrake");
    const eBrake = (await upgrades.deployProxy(EBrakeFactory, [config.acm], {
      constructorArgs: [config.comptroller, !config.isCorePool], // isIsolatedPool = !isCorePool
      unsafeAllow: ["constructor", "state-variable-immutable"],
      kind: "transparent",
    })) as EBrake;

    // ── Deploy Executor proxy ──
    const ExecutorFactory = await ethers.getContractFactory("Executor");
    const executor = (await upgrades.deployProxy(ExecutorFactory, [config.acm], {
      constructorArgs: [eBrake.address, config.comptroller, config.isCorePool],
      unsafeAllow: ["constructor", "state-variable-immutable"],
      kind: "transparent",
    })) as Executor;

    // ── Grant Executor permission to call EBrake functions ──
    const eBrakeExecutorFunctions = [
      "decreaseCF(address,uint256)",
      "setMarketBorrowCaps(address[],uint256[])",
      "setMarketSupplyCaps(address[],uint256[])",
      "pauseSupply(address)",
      "pauseBorrow(address)",
    ];
    for (const sig of eBrakeExecutorFunctions) {
      await acm.giveCallPermission(eBrake.address, sig, executor.address);
    }

    // ── Grant EBrake permissions on comptroller (network-specific function names) ──
    for (const sig of comptrollerPermissions(config)) {
      await acm.giveCallPermission(ethers.constants.AddressZero, sig, eBrake.address);
    }

    // ── Grant hypernative permission to call Executor handlers ──
    const handlerFunctions = [
      "handleLTVAdjust(address,uint256)",
      "handleCapAdjust(address,uint8,uint256)",
      "handleSupplyHalt(address)",
      "handleBorrowHalt(address)",
    ];
    for (const sig of handlerFunctions) {
      await acm.giveCallPermission(executor.address, sig, hypernative.address);
    }

    // ── Grant governance permission to call Executor admin functions ──
    const adminFunctions = ["setMarketConfig(address,(uint256,uint256,bool))"];
    for (const sig of adminFunctions) {
      await acm.giveCallPermission(executor.address, sig, governance.address);
    }

    // ── Read live market data at fork block ──
    const { cf: originalLTV } = await getMarketCF(comptroller, config.testMarket, config);
    const originalBorrowCap: BigNumber = await comptroller.borrowCaps(config.testMarket);
    const originalSupplyCap: BigNumber = await comptroller.supplyCaps(config.testMarket);

    // ── Configure test market in Executor ──
    await executor.connect(governance).setMarketConfig(config.testMarket, {
      minBorrowCap: originalBorrowCap.div(4),
      minSupplyCap: originalSupplyCap.div(4),
      enabled: true,
    });

    return {
      eBrake,
      executor,
      comptroller,
      governance,
      hypernative,
      randomUser,
      testMarket: config.testMarket,
      originalLTV,
      originalBorrowCap,
      originalSupplyCap,
      config,
    };
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// TEST FACTORIES
// ═══════════════════════════════════════════════════════════════════════════

export function accessControlTests(_config: ExecutorNetworkConfig, get: FixtureGetter): void {
  describe("Access Control", () => {
    it("handleLTVAdjust: reverts for unauthorized caller", async () => {
      const { executor, randomUser, testMarket, originalLTV } = get();
      await expect(executor.connect(randomUser).handleLTVAdjust(testMarket, originalLTV)).to.be.revertedWithCustomError(
        executor,
        "Unauthorized",
      );
    });

    it("handleCapAdjust: reverts for unauthorized caller", async () => {
      const { executor, randomUser, testMarket, originalBorrowCap } = get();
      await expect(
        executor.connect(randomUser).handleCapAdjust(testMarket, 0 /* BORROW */, originalBorrowCap),
      ).to.be.revertedWithCustomError(executor, "Unauthorized");
    });

    it("handleSupplyHalt: reverts for unauthorized caller", async () => {
      const { executor, randomUser, testMarket } = get();
      await expect(executor.connect(randomUser).handleSupplyHalt(testMarket)).to.be.revertedWithCustomError(
        executor,
        "Unauthorized",
      );
    });

    it("handleBorrowHalt: reverts for unauthorized caller", async () => {
      const { executor, randomUser, testMarket } = get();
      await expect(executor.connect(randomUser).handleBorrowHalt(testMarket)).to.be.revertedWithCustomError(
        executor,
        "Unauthorized",
      );
    });

    it("setMarketConfig: reverts for unauthorized caller", async () => {
      const { executor, randomUser, testMarket, originalBorrowCap, originalSupplyCap } = get();
      await expect(
        executor.connect(randomUser).setMarketConfig(testMarket, {
          minBorrowCap: originalBorrowCap.div(4),
          minSupplyCap: originalSupplyCap.div(4),
          enabled: true,
        }),
      ).to.be.revertedWithCustomError(executor, "Unauthorized");
    });
  });
}

export function setMarketConfigTests(_config: ExecutorNetworkConfig, get: FixtureGetter): void {
  describe("setMarketConfig", () => {
    it("stores config and emits MarketConfigSet", async () => {
      const { executor, governance, testMarket, originalBorrowCap, originalSupplyCap } = get();
      const marketConfig = {
        minBorrowCap: originalBorrowCap.div(4),
        minSupplyCap: originalSupplyCap.div(4),
        enabled: true,
      };
      await expect(executor.connect(governance).setMarketConfig(testMarket, marketConfig)).to.emit(
        executor,
        "MarketConfigSet",
      );

      const stored = await executor.marketConfigs(testMarket);
      expect(stored.minBorrowCap).to.equal(originalBorrowCap.div(4));
      expect(stored.enabled).to.be.true;
    });

    it("reverts on zero market address", async () => {
      const { executor, governance, originalBorrowCap, originalSupplyCap } = get();
      await expect(
        executor.connect(governance).setMarketConfig(ethers.constants.AddressZero, {
          minBorrowCap: originalBorrowCap.div(4),
          minSupplyCap: originalSupplyCap.div(4),
          enabled: true,
        }),
      ).to.be.revertedWithCustomError(executor, "ZeroAddress");
    });

    it("allows storing a disabled config (enabled=false)", async () => {
      const { executor, governance, testMarket, originalBorrowCap, originalSupplyCap } = get();
      await expect(
        executor.connect(governance).setMarketConfig(testMarket, {
          minBorrowCap: originalBorrowCap.div(4),
          minSupplyCap: originalSupplyCap.div(4),
          enabled: false,
        }),
      ).to.emit(executor, "MarketConfigSet");
    });

    it("reverts when market is not listed in comptroller", async () => {
      const { executor, governance, originalBorrowCap, originalSupplyCap } = get();
      const unlistedMarket = "0x0000000000000000000000000000000000000002";
      await expect(
        executor.connect(governance).setMarketConfig(unlistedMarket, {
          minBorrowCap: originalBorrowCap.div(4),
          minSupplyCap: originalSupplyCap.div(4),
          enabled: true,
        }),
      ).to.be.revertedWithCustomError(executor, "MarketNotListed");
    });

    it("handleLTVAdjust reverts when market is disabled", async () => {
      const { executor, governance, hypernative, testMarket, originalLTV, originalBorrowCap, originalSupplyCap } =
        get();
      await executor.connect(governance).setMarketConfig(testMarket, {
        minBorrowCap: originalBorrowCap.div(4),
        minSupplyCap: originalSupplyCap.div(4),
        enabled: false,
      });
      await expect(
        executor.connect(hypernative).handleLTVAdjust(testMarket, originalLTV.div(2)),
      ).to.be.revertedWithCustomError(executor, "MarketDisabled");
    });
  });
}

export function handleLTVAdjustTests(config: ExecutorNetworkConfig, get: FixtureGetter): void {
  describe("handleLTVAdjust", () => {
    it("reverts for unconfigured market", async () => {
      const { executor, hypernative } = get();
      await expect(
        executor
          .connect(hypernative)
          .handleLTVAdjust("0x0000000000000000000000000000000000000001", ethers.utils.parseUnits("0.5")),
      ).to.be.revertedWithCustomError(executor, "MarketNotConfigured");
    });

    it("reverts when adjustedLTV exceeds current CF", async () => {
      const { executor, eBrake, hypernative, testMarket, originalLTV } = get();
      await expect(
        executor.connect(hypernative).handleLTVAdjust(testMarket, originalLTV.add(1)),
      ).to.be.revertedWithCustomError(eBrake, "CFExceedsCurrent");
    });

    it("emits LTVAdjusted even when adjustedLTV equals current CF (EBrake is always called)", async () => {
      const { executor, hypernative, testMarket, originalLTV } = get();
      await expect(executor.connect(hypernative).handleLTVAdjust(testMarket, originalLTV)).to.emit(
        executor,
        "LTVAdjusted",
      );
    });

    it("decreases CF and verifies on comptroller", async () => {
      const { executor, hypernative, comptroller, testMarket, originalLTV } = get();
      const reducedLTV = originalLTV.mul(80).div(100);

      await expect(executor.connect(hypernative).handleLTVAdjust(testMarket, reducedLTV)).to.emit(
        executor,
        "LTVAdjusted",
      );

      const { cf } = await getMarketCF(comptroller, testMarket, config);
      expect(cf).to.equal(reducedLTV);
    });

    it("decrease preserves liquidation threshold", async () => {
      const { executor, hypernative, comptroller, testMarket, originalLTV } = get();
      const { lt: ltBefore } = await getMarketCF(comptroller, testMarket, config);
      await executor.connect(hypernative).handleLTVAdjust(testMarket, originalLTV.mul(80).div(100));
      const { lt: ltAfter } = await getMarketCF(comptroller, testMarket, config);
      expect(ltAfter).to.equal(ltBefore);
    });
  });
}

export function handleCapAdjustTests(_config: ExecutorNetworkConfig, get: FixtureGetter): void {
  describe("handleCapAdjust — Borrow Cap", () => {
    it("decreases borrow cap and emits CapAdjusted", async () => {
      const { executor, hypernative, comptroller, testMarket, originalBorrowCap } = get();
      const reducedCap = originalBorrowCap.mul(75).div(100);

      await expect(executor.connect(hypernative).handleCapAdjust(testMarket, 0 /* BORROW */, reducedCap))
        .to.emit(executor, "CapAdjusted")
        .withArgs(hypernative.address, testMarket, 0, originalBorrowCap, reducedCap);

      expect(await comptroller.borrowCaps(testMarket)).to.equal(reducedCap);
    });

    it("reverts when borrow cap below minimum", async () => {
      const { executor, hypernative, testMarket, originalBorrowCap } = get();
      await expect(
        executor.connect(hypernative).handleCapAdjust(testMarket, 0, originalBorrowCap.div(4).sub(1)),
      ).to.be.revertedWithCustomError(executor, "CapBelowMinimum");
    });

    it("reverts when borrow cap exceeds current cap", async () => {
      const { executor, eBrake, hypernative, testMarket, originalBorrowCap } = get();
      await expect(
        executor.connect(hypernative).handleCapAdjust(testMarket, 0, originalBorrowCap.add(1)),
      ).to.be.revertedWithCustomError(eBrake, "CapExceedsCurrent");
    });

    it("no-op when borrow cap is already at requested value", async () => {
      const { executor, hypernative, comptroller, testMarket, originalBorrowCap } = get();
      await executor.connect(hypernative).handleCapAdjust(testMarket, 0, originalBorrowCap);
      expect(await comptroller.borrowCaps(testMarket)).to.equal(originalBorrowCap);
    });
  });

  describe("handleCapAdjust — Supply Cap", () => {
    it("decreases supply cap and emits CapAdjusted", async () => {
      const { executor, hypernative, comptroller, testMarket, originalSupplyCap } = get();
      const reducedCap = originalSupplyCap.mul(75).div(100);

      await expect(executor.connect(hypernative).handleCapAdjust(testMarket, 1 /* SUPPLY */, reducedCap))
        .to.emit(executor, "CapAdjusted")
        .withArgs(hypernative.address, testMarket, 1, originalSupplyCap, reducedCap);

      expect(await comptroller.supplyCaps(testMarket)).to.equal(reducedCap);
    });

    it("reverts when supply cap below minimum", async () => {
      const { executor, hypernative, testMarket, originalSupplyCap } = get();
      await expect(
        executor.connect(hypernative).handleCapAdjust(testMarket, 1, originalSupplyCap.div(4).sub(1)),
      ).to.be.revertedWithCustomError(executor, "CapBelowMinimum");
    });

    it("reverts when supply cap exceeds current cap", async () => {
      const { executor, eBrake, hypernative, testMarket, originalSupplyCap } = get();
      await expect(
        executor.connect(hypernative).handleCapAdjust(testMarket, 1, originalSupplyCap.add(1)),
      ).to.be.revertedWithCustomError(eBrake, "CapExceedsCurrent");
    });
  });
}

export function handleSupplyHaltTests(config: ExecutorNetworkConfig, get: FixtureGetter): void {
  describe("handleSupplyHalt", () => {
    it("reverts when supply cap is not breached", async () => {
      const { executor, hypernative, testMarket } = get();
      await expect(executor.connect(hypernative).handleSupplyHalt(testMarket)).to.be.revertedWithCustomError(
        executor,
        "CapNotBreached",
      );
    });

    it("reverts when supply cap is not set (cap == 0 means unlimited)", async () => {
      const { executor, hypernative, comptroller, governance, testMarket } = get();
      await setSupplyCapDirect(comptroller.connect(governance), testMarket, 0, config);
      await expect(executor.connect(hypernative).handleSupplyHalt(testMarket)).to.be.revertedWithCustomError(
        executor,
        "CapNotBreached",
      );
    });

    it("pauses supply and zeros CF when cap is breached", async () => {
      const { executor, hypernative, comptroller, governance, testMarket } = get();

      await setSupplyCapDirect(comptroller.connect(governance), testMarket, 1, config);

      await expect(executor.connect(hypernative).handleSupplyHalt(testMarket))
        .to.emit(executor, "SupplyHalted")
        .withArgs(hypernative.address, testMarket);

      expect(await comptroller.actionPaused(testMarket, Action.MINT)).to.be.true;
      const { cf } = await getMarketCF(comptroller, testMarket, config);
      expect(cf).to.equal(0);
    });

    it("supply halt preserves liquidation threshold", async () => {
      const { executor, hypernative, comptroller, governance, testMarket } = get();

      const { lt: ltBefore } = await getMarketCF(comptroller, testMarket, config);
      await setSupplyCapDirect(comptroller.connect(governance), testMarket, 1, config);
      await executor.connect(hypernative).handleSupplyHalt(testMarket);

      const { lt: ltAfter } = await getMarketCF(comptroller, testMarket, config);
      expect(ltAfter).to.equal(ltBefore);
    });
  });
}

export function handleBorrowHaltTests(config: ExecutorNetworkConfig, get: FixtureGetter): void {
  describe("handleBorrowHalt", () => {
    it("reverts when borrow cap is not breached", async () => {
      const { executor, hypernative, testMarket } = get();
      await expect(executor.connect(hypernative).handleBorrowHalt(testMarket)).to.be.revertedWithCustomError(
        executor,
        "CapNotBreached",
      );
    });

    it("reverts when borrow cap is not set (cap == 0 means unlimited)", async () => {
      const { executor, hypernative, comptroller, governance, testMarket } = get();
      await setBorrowCapDirect(comptroller.connect(governance), testMarket, 0, config);
      await expect(executor.connect(hypernative).handleBorrowHalt(testMarket)).to.be.revertedWithCustomError(
        executor,
        "CapNotBreached",
      );
    });

    it("pauses borrow when cap is breached", async () => {
      const { executor, hypernative, comptroller, governance, testMarket } = get();

      await setBorrowCapDirect(comptroller.connect(governance), testMarket, 1, config);

      await expect(executor.connect(hypernative).handleBorrowHalt(testMarket))
        .to.emit(executor, "BorrowHalted")
        .withArgs(hypernative.address, testMarket);

      expect(await comptroller.actionPaused(testMarket, Action.BORROW)).to.be.true;
    });

    it("borrow halt does not zero CF", async () => {
      const { executor, hypernative, comptroller, governance, testMarket } = get();

      const { cf: cfBefore } = await getMarketCF(comptroller, testMarket, config);
      await setBorrowCapDirect(comptroller.connect(governance), testMarket, 1, config);
      await executor.connect(hypernative).handleBorrowHalt(testMarket);

      const { cf: cfAfter } = await getMarketCF(comptroller, testMarket, config);
      expect(cfAfter).to.equal(cfBefore);
    });
  });
}

// ── Convenience wrappers ──
//
// Test factories are split across two axes:
//
//   - SHARED tests work on both Diamond (BSC core pool) and IL comptrollers because they
//     either don't touch collateral factor at all, or they read state via the type-aware
//     `getMarketCF` helper.
//
//   - LTV adjust + supply halt go through EBrake.decreaseCF, which iterates every pool on
//     the BSC Diamond comptroller. The IL versions assume a single pool, so they live behind
//     `runIsolatedPoolTests`. BSC has its own multi-pool variants in bscmainnet.ts.

/// Tests that pass on both Diamond and IL comptrollers.
export function runSharedTests(config: ExecutorNetworkConfig, get: FixtureGetter): void {
  accessControlTests(config, get);
  setMarketConfigTests(config, get);
  handleCapAdjustTests(config, get);
  handleBorrowHaltTests(config, get);
}

/// Shared tests + IL-specific LTV / supply halt tests (single-pool comptroller).
export function runIsolatedPoolTests(config: ExecutorNetworkConfig, get: FixtureGetter): void {
  runSharedTests(config, get);
  handleLTVAdjustTests(config, get);
  handleSupplyHaltTests(config, get);
}
