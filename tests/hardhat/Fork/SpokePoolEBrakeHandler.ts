import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { Contract } from "ethers";
import { parseUnits } from "ethers/lib/utils";
import { ethers, upgrades } from "hardhat";

import { EBrake, SpokePoolEBrakeHandler } from "../../../typechain";
import { forking, initMainnetUser } from "./utils";

// Run: FORKED_NETWORK=bsctestnet npx hardhat test tests/hardhat/Fork/SpokePoolEBrakeHandler.ts
const FORK_TESTNET = process.env.FORKED_NETWORK === "bsctestnet";

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS (BSC Testnet)
// ═══════════════════════════════════════════════════════════════════════════

const FORK_BLOCK = 135747000;

const ACM = "0x45f8a08F534f34A97187626E05d4b6648Eeaa9AA";
const NORMAL_TIMELOCK = "0xce10739590001705F7FF231611ba4A48B2820327"; // ACM admin
const CORE_COMPTROLLER = "0x94d1820b2D1c7c7452A163983Dc888CEC546b77D";
const SPOKE_POOL_REGISTRY = "0xeAA45288d804971e5a76f33559e629F5b2b1Cb8B";
const HUB_SPOKE_COMPTROLLER = "0x11960c84d6c4F2a978a12372721C3A6A88C78f4c";
const QA_SPOKE_COMPTROLLER = "0xb084B5af4a040933790Cdc1b2d15ac7BB3514E50";

const vNVDAB_HUB_SPOKE = "0x41A860F11Ddb71ed7d3063aE43dF0e9741B4eed3"; // CF 0.5, LT 0.6
const vUSDT_HUB_SPOKE = "0xC88bAF0bA49a98F15A00182752f6d10bd3932F6a"; // non-zero caps, nothing paused
const vUSDC_HUB_SPOKE = "0xD05514217FD359659aE7da7740e79C11947eBB32";
const vUSDT_QA_SPOKE = "0x1AEf50b005089AeA10DE70b83250C55d6A9E9848";
const vUSDT_CORE = "0xb7526572FFE56AB9D7489838Bf2E18e3323b441A";
const vUSDT_DEFI = "0x80CC30811e362aC9aB857C3d7875CbcCc0b65750"; // an isolated pool, not a Spoke pool

const NVDAB_CF = parseUnits("0.5", 18);
const NVDAB_LT = parseUnits("0.6", 18);

const Action = { MINT: 0, REDEEM: 1, BORROW: 2, REPAY: 3, TRANSFER: 6 };

// Granted to EBrake on each Spoke comptroller; the isolated-pools comptroller checks uint256[] for pauses
const SPOKE_COMPTROLLER_FUNCTIONS = [
  "setActionsPaused(address[],uint256[],bool)",
  "setCollateralFactor(address,uint256,uint256)",
  "setMarketBorrowCaps(address[],uint256[])",
  "setMarketSupplyCaps(address[],uint256[])",
];

// Granted to the handler on EBrake, and to governance on the handler
const HANDLER_FUNCTIONS = [
  "pauseActions(address[],uint8[])",
  "pauseSupply(address)",
  "pauseRedeem(address)",
  "pauseBorrow(address)",
  "pauseTransfer(address)",
  "decreaseCF(address,uint256)",
  "setMarketBorrowCaps(address[],uint256[])",
  "setMarketSupplyCaps(address[],uint256[])",
];

// Granted to governance on EBrake
const GOVERNANCE_EBRAKE_FUNCTIONS = [
  "pauseSupply(address)",
  "resetCFSnapshot(address)",
  "resetBorrowCapSnapshot(address)",
  "resetSupplyCapSnapshot(address)",
];

// ═══════════════════════════════════════════════════════════════════════════
// ABIs
// ═══════════════════════════════════════════════════════════════════════════

const ACM_ABI = [
  "function giveCallPermission(address contractAddress, string calldata functionSig, address accountToPermit)",
  "function revokeCallPermission(address contractAddress, string calldata functionSig, address accountToRevoke)",
];

const SPOKE_COMPTROLLER_ABI = [
  "function markets(address vToken) view returns (bool isListed, uint256 collateralFactorMantissa, uint256 liquidationThresholdMantissa)",
  "function actionPaused(address vToken, uint8 action) view returns (bool)",
  "function borrowCaps(address vToken) view returns (uint256)",
  "function supplyCaps(address vToken) view returns (uint256)",
];

const CORE_COMPTROLLER_ABI = ["function actionPaused(address market, uint8 action) view returns (bool)"];

// ═══════════════════════════════════════════════════════════════════════════
// FIXTURE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Deploys EBrake (home: the Core comptroller) and the SpokePoolEBrakeHandler from the repo, upgrades EBrake
 * to an implementation whose SPOKE_HANDLER is the handler, and makes the grants a VIP would make.
 */
async function deployFixture() {
  const [, governance, user] = await ethers.getSigners();
  const timelock = await initMainnetUser(NORMAL_TIMELOCK, parseUnits("10", 18));
  const acm = new ethers.Contract(ACM, ACM_ABI, timelock);

  const EBrakeFactory = await ethers.getContractFactory("EBrake");
  const eBrake = (await upgrades.deployProxy(EBrakeFactory, [ACM], {
    constructorArgs: [CORE_COMPTROLLER, false, ethers.constants.AddressZero],
    unsafeAllow: ["constructor", "state-variable-immutable"],
  })) as EBrake;
  const handler = (await upgrades.deployProxy(await ethers.getContractFactory("SpokePoolEBrakeHandler"), [ACM], {
    constructorArgs: [eBrake.address, SPOKE_POOL_REGISTRY],
    unsafeAllow: ["constructor", "state-variable-immutable"],
  })) as SpokePoolEBrakeHandler;
  // The handler needs the EBrake proxy, so EBrake learns the handler through an implementation upgrade
  await upgrades.upgradeProxy(eBrake.address, EBrakeFactory, {
    constructorArgs: [CORE_COMPTROLLER, false, handler.address],
    unsafeAllow: ["constructor", "state-variable-immutable"],
  });

  for (const comptroller of [HUB_SPOKE_COMPTROLLER, QA_SPOKE_COMPTROLLER]) {
    for (const signature of SPOKE_COMPTROLLER_FUNCTIONS) {
      await acm.giveCallPermission(comptroller, signature, eBrake.address);
    }
  }
  for (const signature of HANDLER_FUNCTIONS) {
    await acm.giveCallPermission(eBrake.address, signature, handler.address);
    await acm.giveCallPermission(handler.address, signature, governance.address);
  }
  for (const signature of GOVERNANCE_EBRAKE_FUNCTIONS) {
    await acm.giveCallPermission(eBrake.address, signature, governance.address);
  }
  // The live EBrake holds this grant on the Core comptroller
  await acm.giveCallPermission(CORE_COMPTROLLER, "_setActionsPaused(address[],uint8[],bool)", eBrake.address);

  const hubSpoke = new ethers.Contract(HUB_SPOKE_COMPTROLLER, SPOKE_COMPTROLLER_ABI, ethers.provider);
  const qaSpoke = new ethers.Contract(QA_SPOKE_COMPTROLLER, SPOKE_COMPTROLLER_ABI, ethers.provider);
  const core = new ethers.Contract(CORE_COMPTROLLER, CORE_COMPTROLLER_ABI, ethers.provider);
  return { eBrake, handler, acm, hubSpoke, qaSpoke, core, governance, user };
}

// ═══════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════

if (FORK_TESTNET) {
  forking(FORK_BLOCK, () => {
    describe("SpokePoolEBrakeHandler (bsctestnet fork)", () => {
      let eBrake: EBrake;
      let handler: SpokePoolEBrakeHandler;
      let acm: Contract;
      let hubSpoke: Contract;
      let qaSpoke: Contract;
      let core: Contract;
      let governance: SignerWithAddress;
      let user: SignerWithAddress;

      beforeEach(async () => {
        ({ eBrake, handler, acm, hubSpoke, qaSpoke, core, governance, user } = await loadFixture(deployFixture));
      });

      describe("pauses", () => {
        it("should pause each action on the Spoke comptroller", async () => {
          await expect(handler.connect(governance).pauseSupply(vUSDT_HUB_SPOKE))
            .to.emit(eBrake, "ActionPaused")
            .withArgs(handler.address, vUSDT_HUB_SPOKE, Action.MINT);
          await handler.connect(governance).pauseRedeem(vUSDT_HUB_SPOKE);
          await handler.connect(governance).pauseBorrow(vUSDT_HUB_SPOKE);
          await handler.connect(governance).pauseTransfer(vUSDT_HUB_SPOKE);

          for (const action of [Action.MINT, Action.REDEEM, Action.BORROW, Action.TRANSFER]) {
            expect(await hubSpoke.actionPaused(vUSDT_HUB_SPOKE, action)).to.equal(true);
          }
        });

        it("should pause several actions on several markets with pauseActions", async () => {
          await handler
            .connect(governance)
            .pauseActions([vUSDT_HUB_SPOKE, vUSDC_HUB_SPOKE], [Action.MINT, Action.BORROW]);

          for (const market of [vUSDT_HUB_SPOKE, vUSDC_HUB_SPOKE]) {
            expect(await hubSpoke.actionPaused(market, Action.MINT)).to.equal(true);
            expect(await hubSpoke.actionPaused(market, Action.BORROW)).to.equal(true);
            expect(await hubSpoke.actionPaused(market, Action.REDEEM)).to.equal(false);
          }
        });

        it("should still reject forbidden actions", async () => {
          await expect(handler.connect(governance).pauseActions([vUSDT_HUB_SPOKE], [Action.REPAY]))
            .to.be.revertedWithCustomError(eBrake, "ForbiddenAction")
            .withArgs(Action.REPAY);
        });

        it("should reach every registered Spoke comptroller", async () => {
          await handler.connect(governance).pauseSupply(vUSDT_QA_SPOKE);
          expect(await qaSpoke.actionPaused(vUSDT_QA_SPOKE, Action.MINT)).to.equal(true);
        });
      });

      describe("decreaseCF", () => {
        it("should set CF to 0, keep LT and snapshot both at pool id 0", async () => {
          await expect(handler.connect(governance).decreaseCF(vNVDAB_HUB_SPOKE, 0))
            .to.emit(eBrake, "CollateralFactorDecreased")
            .withArgs(handler.address, vNVDAB_HUB_SPOKE, 0, 0);

          const market = await hubSpoke.markets(vNVDAB_HUB_SPOKE);
          expect(market.collateralFactorMantissa).to.equal(0);
          expect(market.liquidationThresholdMantissa).to.equal(NVDAB_LT);
          const snapshot = await eBrake.getMarketCFSnapshot(vNVDAB_HUB_SPOKE, 0);
          expect(snapshot.cf).to.equal(NVDAB_CF);
          expect(snapshot.lt).to.equal(NVDAB_LT);
        });

        it("should revert with CFExceedsCurrent when raising CF", async () => {
          await expect(handler.connect(governance).decreaseCF(vNVDAB_HUB_SPOKE, NVDAB_CF.add(1)))
            .to.be.revertedWithCustomError(eBrake, "CFExceedsCurrent")
            .withArgs(vNVDAB_HUB_SPOKE, 0, NVDAB_CF, NVDAB_CF.add(1));
        });
      });

      describe("caps", () => {
        it("should lower borrow and supply caps and snapshot the old ones", async () => {
          const borrowCap = await hubSpoke.borrowCaps(vUSDT_HUB_SPOKE);
          const supplyCap = await hubSpoke.supplyCaps(vUSDT_HUB_SPOKE);

          await handler.connect(governance).setMarketBorrowCaps([vUSDT_HUB_SPOKE], [0]);
          await handler.connect(governance).setMarketSupplyCaps([vUSDT_HUB_SPOKE], [0]);

          expect(await hubSpoke.borrowCaps(vUSDT_HUB_SPOKE)).to.equal(0);
          expect(await hubSpoke.supplyCaps(vUSDT_HUB_SPOKE)).to.equal(0);
          const state = await eBrake.marketStates(vUSDT_HUB_SPOKE);
          expect(state.borrowCap).to.equal(borrowCap);
          expect(state.supplyCap).to.equal(supplyCap);
        });
      });

      describe("snapshot resets", () => {
        it("should let governance reset a Spoke market's snapshots on EBrake directly", async () => {
          await handler.connect(governance).decreaseCF(vNVDAB_HUB_SPOKE, 0);
          await handler.connect(governance).setMarketSupplyCaps([vUSDT_HUB_SPOKE], [0]);

          await eBrake.connect(governance).resetCFSnapshot(vNVDAB_HUB_SPOKE);
          await eBrake.connect(governance).resetSupplyCapSnapshot(vUSDT_HUB_SPOKE);

          expect((await eBrake.getMarketCFSnapshot(vNVDAB_HUB_SPOKE, 0)).cf).to.equal(0);
          expect((await eBrake.marketStates(vUSDT_HUB_SPOKE)).supplyCapSnapshotted).to.equal(false);
        });
      });

      describe("market checks", () => {
        it("should reject Core markets and isolated pools outside the Spoke registry", async () => {
          await expect(handler.connect(governance).pauseSupply(vUSDT_CORE))
            .to.be.revertedWithCustomError(handler, "NotSpokeComptroller")
            .withArgs(CORE_COMPTROLLER);
          await expect(handler.connect(governance).decreaseCF(vUSDT_DEFI, 0)).to.be.revertedWithCustomError(
            handler,
            "NotSpokeComptroller",
          );
        });

        it("should reject batches that mix comptrollers", async () => {
          await expect(handler.connect(governance).pauseActions([vUSDT_HUB_SPOKE, vUSDT_QA_SPOKE], [Action.MINT]))
            .to.be.revertedWithCustomError(handler, "MarketsOnDifferentComptrollers")
            .withArgs(HUB_SPOKE_COMPTROLLER, QA_SPOKE_COMPTROLLER);
          await expect(handler.connect(governance).setMarketBorrowCaps([vUSDT_HUB_SPOKE, vUSDT_CORE], [0, 0]))
            .to.be.revertedWithCustomError(handler, "MarketsOnDifferentComptrollers")
            .withArgs(HUB_SPOKE_COMPTROLLER, CORE_COMPTROLLER);
        });
      });

      describe("access control", () => {
        it("should revert with Unauthorized for callers without ACM permission", async () => {
          await expect(handler.connect(user).pauseSupply(vUSDT_HUB_SPOKE))
            .to.be.revertedWithCustomError(handler, "Unauthorized")
            .withArgs(user.address, handler.address, "pauseSupply(address)");
        });

        it("should need setActionsPaused(address[],uint256[],bool) on the Spoke comptroller", async () => {
          await acm.revokeCallPermission(
            HUB_SPOKE_COMPTROLLER,
            "setActionsPaused(address[],uint256[],bool)",
            eBrake.address,
          );
          await acm.giveCallPermission(
            HUB_SPOKE_COMPTROLLER,
            "setActionsPaused(address[],uint8[],bool)",
            eBrake.address,
          );

          await expect(handler.connect(governance).pauseSupply(vUSDT_HUB_SPOKE))
            .to.be.revertedWithCustomError(eBrake, "Unauthorized")
            .withArgs(eBrake.address, HUB_SPOKE_COMPTROLLER, "setActionsPaused(address[],uint256[],bool)");
        });
      });

      describe("EBrake routing", () => {
        it("should use the handler as SPOKE_HANDLER", async () => {
          expect(await eBrake.SPOKE_HANDLER()).to.equal(handler.address);
        });

        it("should send other EBrake callers to the Core comptroller, which rejects Spoke markets", async () => {
          await expect(eBrake.connect(governance).pauseSupply(vUSDT_HUB_SPOKE)).to.be.revertedWith("market not listed");
          expect(await hubSpoke.actionPaused(vUSDT_HUB_SPOKE, Action.MINT)).to.equal(false);
        });

        it("should keep Core markets on the Core comptroller", async () => {
          await eBrake.connect(governance).pauseSupply(vUSDT_CORE);
          expect(await core.actionPaused(vUSDT_CORE, Action.MINT)).to.equal(true);
        });
      });
    });
  });
}
