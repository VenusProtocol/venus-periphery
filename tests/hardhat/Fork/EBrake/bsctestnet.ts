import { smock } from "@defi-wonderland/smock";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { Contract } from "ethers";
import { parseUnits } from "ethers/lib/utils";
import { ethers, upgrades } from "hardhat";

import { EBrake } from "../../../../typechain";
import { forking, initMainnetUser } from "../utils";
import { Action } from "./shared";

const FORK_TESTNET = process.env.FORKED_NETWORK === "bsctestnet";

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS (BSC Testnet)
// ═══════════════════════════════════════════════════════════════════════════

const FORK_BLOCK = 135747000;

const ACM = "0x45f8a08F534f34A97187626E05d4b6648Eeaa9AA";
const NORMAL_TIMELOCK = "0xce10739590001705F7FF231611ba4A48B2820327"; // ACM admin
const CORE_COMPTROLLER = "0x94d1820b2D1c7c7452A163983Dc888CEC546b77D";
const HUB_SPOKE_COMPTROLLER = "0x11960c84d6c4F2a978a12372721C3A6A88C78f4c";
const QA_SPOKE_COMPTROLLER = "0xb084B5af4a040933790Cdc1b2d15ac7BB3514E50";
const DEFI_COMPTROLLER = "0x23a73971A6B9f6580c048B9CB188869B2A2aA2aD"; // an isolated pool that never granted EBrake

const vNVDAB_HUB_SPOKE = "0x41A860F11Ddb71ed7d3063aE43dF0e9741B4eed3"; // CF 0.5, LT 0.6
const vUSDT_HUB_SPOKE = "0xC88bAF0bA49a98F15A00182752f6d10bd3932F6a"; // non-zero caps, nothing paused
const vUSDC_HUB_SPOKE = "0xD05514217FD359659aE7da7740e79C11947eBB32";
const vUSDT_QA_SPOKE = "0x1AEf50b005089AeA10DE70b83250C55d6A9E9848";
const vUSDT_CORE = "0xb7526572FFE56AB9D7489838Bf2E18e3323b441A";
const vUSDT_DEFI = "0x80CC30811e362aC9aB857C3d7875CbcCc0b65750";

const NVDAB_CF = parseUnits("0.5", 18);
const NVDAB_LT = parseUnits("0.6", 18);

// Granted to EBrake on each Spoke comptroller; the isolated-pools comptroller checks uint256[] for pauses
const SPOKE_COMPTROLLER_FUNCTIONS = [
  "setActionsPaused(address[],uint256[],bool)",
  "setCollateralFactor(address,uint256,uint256)",
  "setMarketBorrowCaps(address[],uint256[])",
  "setMarketSupplyCaps(address[],uint256[])",
];

// Granted to governance on EBrake
const GOVERNANCE_EBRAKE_FUNCTIONS = [
  "pauseActions(address[],uint8[])",
  "pauseSupply(address)",
  "pauseRedeem(address)",
  "pauseBorrow(address)",
  "pauseTransfer(address)",
  "decreaseCF(address,uint256)",
  "setMarketBorrowCaps(address[],uint256[])",
  "setMarketSupplyCaps(address[],uint256[])",
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
 * Deploys EBrake (COMPTROLLER: the Core comptroller) from the repo and makes the grants a VIP would make.
 */
async function deployFixture() {
  const [, governance, user] = await ethers.getSigners();
  const timelock = await initMainnetUser(NORMAL_TIMELOCK, parseUnits("10", 18));
  const acm = new ethers.Contract(ACM, ACM_ABI, timelock);

  const eBrake = (await upgrades.deployProxy(await ethers.getContractFactory("EBrake"), [ACM], {
    constructorArgs: [CORE_COMPTROLLER, false],
    unsafeAllow: ["constructor", "state-variable-immutable"],
  })) as EBrake;

  for (const comptroller of [HUB_SPOKE_COMPTROLLER, QA_SPOKE_COMPTROLLER]) {
    for (const signature of SPOKE_COMPTROLLER_FUNCTIONS) {
      await acm.giveCallPermission(comptroller, signature, eBrake.address);
    }
  }
  for (const signature of GOVERNANCE_EBRAKE_FUNCTIONS) {
    await acm.giveCallPermission(eBrake.address, signature, governance.address);
  }
  // The live EBrake holds this grant on the Core comptroller
  await acm.giveCallPermission(CORE_COMPTROLLER, "_setActionsPaused(address[],uint8[],bool)", eBrake.address);

  const hubSpoke = new ethers.Contract(HUB_SPOKE_COMPTROLLER, SPOKE_COMPTROLLER_ABI, ethers.provider);
  const qaSpoke = new ethers.Contract(QA_SPOKE_COMPTROLLER, SPOKE_COMPTROLLER_ABI, ethers.provider);
  const core = new ethers.Contract(CORE_COMPTROLLER, CORE_COMPTROLLER_ABI, ethers.provider);
  return { eBrake, acm, hubSpoke, qaSpoke, core, governance, user };
}

// ═══════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════

if (FORK_TESTNET) {
  forking(FORK_BLOCK, () => {
    describe("EBrake Fork Tests (bsctestnet, Spoke pools)", () => {
      let eBrake: EBrake;
      let acm: Contract;
      let hubSpoke: Contract;
      let qaSpoke: Contract;
      let core: Contract;
      let governance: SignerWithAddress;
      let user: SignerWithAddress;

      beforeEach(async () => {
        ({ eBrake, acm, hubSpoke, qaSpoke, core, governance, user } = await loadFixture(deployFixture));
      });

      describe("pauses", () => {
        it("should pause each action on the Spoke comptroller", async () => {
          await expect(eBrake.connect(governance).pauseSupply(vUSDT_HUB_SPOKE))
            .to.emit(eBrake, "ActionPaused")
            .withArgs(governance.address, vUSDT_HUB_SPOKE, Action.MINT);
          await eBrake.connect(governance).pauseRedeem(vUSDT_HUB_SPOKE);
          await eBrake.connect(governance).pauseBorrow(vUSDT_HUB_SPOKE);
          await eBrake.connect(governance).pauseTransfer(vUSDT_HUB_SPOKE);

          for (const action of [Action.MINT, Action.REDEEM, Action.BORROW, Action.TRANSFER]) {
            expect(await hubSpoke.actionPaused(vUSDT_HUB_SPOKE, action)).to.equal(true);
          }
        });

        it("should pause several actions on several markets with pauseActions", async () => {
          await eBrake
            .connect(governance)
            .pauseActions([vUSDT_HUB_SPOKE, vUSDC_HUB_SPOKE], [Action.MINT, Action.BORROW]);

          for (const market of [vUSDT_HUB_SPOKE, vUSDC_HUB_SPOKE]) {
            expect(await hubSpoke.actionPaused(market, Action.MINT)).to.equal(true);
            expect(await hubSpoke.actionPaused(market, Action.BORROW)).to.equal(true);
            expect(await hubSpoke.actionPaused(market, Action.REDEEM)).to.equal(false);
          }
        });

        it("should still reject forbidden actions", async () => {
          await expect(eBrake.connect(governance).pauseActions([vUSDT_HUB_SPOKE], [Action.REPAY]))
            .to.be.revertedWithCustomError(eBrake, "ForbiddenAction")
            .withArgs(Action.REPAY);
        });

        it("should reach every Spoke comptroller that granted EBrake its permissions", async () => {
          await eBrake.connect(governance).pauseSupply(vUSDT_QA_SPOKE);
          expect(await qaSpoke.actionPaused(vUSDT_QA_SPOKE, Action.MINT)).to.equal(true);
        });
      });

      describe("decreaseCF", () => {
        it("should set CF to 0, keep LT and snapshot both at pool id 0", async () => {
          await expect(eBrake.connect(governance)["decreaseCF(address,uint256)"](vNVDAB_HUB_SPOKE, 0))
            .to.emit(eBrake, "CollateralFactorDecreased")
            .withArgs(governance.address, vNVDAB_HUB_SPOKE, 0, 0);

          const market = await hubSpoke.markets(vNVDAB_HUB_SPOKE);
          expect(market.collateralFactorMantissa).to.equal(0);
          expect(market.liquidationThresholdMantissa).to.equal(NVDAB_LT);
          const snapshot = await eBrake.getMarketCFSnapshot(vNVDAB_HUB_SPOKE, 0);
          expect(snapshot.cf).to.equal(NVDAB_CF);
          expect(snapshot.lt).to.equal(NVDAB_LT);
        });

        it("should make a repeat decreaseCF(market, 0) a no-op that keeps the snapshot", async () => {
          await eBrake.connect(governance)["decreaseCF(address,uint256)"](vNVDAB_HUB_SPOKE, 0);

          await expect(eBrake.connect(governance)["decreaseCF(address,uint256)"](vNVDAB_HUB_SPOKE, 0)).to.not.emit(
            eBrake,
            "CollateralFactorDecreased",
          );
          expect((await hubSpoke.markets(vNVDAB_HUB_SPOKE)).collateralFactorMantissa).to.equal(0);
          expect((await eBrake.getMarketCFSnapshot(vNVDAB_HUB_SPOKE, 0)).cf).to.equal(NVDAB_CF);
        });

        it("should revert with CFExceedsCurrent when raising CF", async () => {
          await expect(eBrake.connect(governance)["decreaseCF(address,uint256)"](vNVDAB_HUB_SPOKE, NVDAB_CF.add(1)))
            .to.be.revertedWithCustomError(eBrake, "CFExceedsCurrent")
            .withArgs(vNVDAB_HUB_SPOKE, 0, NVDAB_CF, NVDAB_CF.add(1));
        });
      });

      describe("caps", () => {
        it("should lower borrow and supply caps and snapshot the old ones", async () => {
          const borrowCap = await hubSpoke.borrowCaps(vUSDT_HUB_SPOKE);
          const supplyCap = await hubSpoke.supplyCaps(vUSDT_HUB_SPOKE);

          await eBrake.connect(governance).setMarketBorrowCaps([vUSDT_HUB_SPOKE], [0]);
          await eBrake.connect(governance).setMarketSupplyCaps([vUSDT_HUB_SPOKE], [0]);

          expect(await hubSpoke.borrowCaps(vUSDT_HUB_SPOKE)).to.equal(0);
          expect(await hubSpoke.supplyCaps(vUSDT_HUB_SPOKE)).to.equal(0);
          const state = await eBrake.marketStates(vUSDT_HUB_SPOKE);
          expect(state.borrowCap).to.equal(borrowCap);
          expect(state.supplyCap).to.equal(supplyCap);
        });
      });

      describe("snapshot resets", () => {
        it("should reset a Spoke market's snapshots", async () => {
          await eBrake.connect(governance)["decreaseCF(address,uint256)"](vNVDAB_HUB_SPOKE, 0);
          await eBrake.connect(governance).setMarketSupplyCaps([vUSDT_HUB_SPOKE], [0]);
          const snapshotBefore = await eBrake.getMarketCFSnapshot(vNVDAB_HUB_SPOKE, 0);
          expect(snapshotBefore.cf).to.equal(NVDAB_CF);
          expect(snapshotBefore.lt).to.equal(NVDAB_LT);
          expect((await eBrake.marketStates(vUSDT_HUB_SPOKE)).supplyCapSnapshotted).to.equal(true);

          await eBrake.connect(governance).resetCFSnapshot(vNVDAB_HUB_SPOKE);
          await eBrake.connect(governance).resetSupplyCapSnapshot(vUSDT_HUB_SPOKE);

          const snapshotAfter = await eBrake.getMarketCFSnapshot(vNVDAB_HUB_SPOKE, 0);
          expect(snapshotAfter.cf).to.equal(0);
          expect(snapshotAfter.lt).to.equal(0);
          expect((await eBrake.marketStates(vUSDT_HUB_SPOKE)).supplyCapSnapshotted).to.equal(false);
        });
      });

      describe("comptroller routing", () => {
        it("should keep Core markets on the Core comptroller", async () => {
          await eBrake.connect(governance).pauseSupply(vUSDT_CORE);
          expect(await core.actionPaused(vUSDT_CORE, Action.MINT)).to.equal(true);
        });

        it("should not reach a comptroller that never granted EBrake its permissions", async () => {
          await expect(eBrake.connect(governance).pauseSupply(vUSDT_DEFI))
            .to.be.revertedWithCustomError(eBrake, "Unauthorized")
            .withArgs(eBrake.address, DEFI_COMPTROLLER, "setActionsPaused(address[],uint256[],bool)");
        });

        it("should reject a market that claims a Spoke comptroller without being listed in it", async () => {
          const fakeMarket = await smock.fake<Contract>("contracts/Interfaces/IVToken.sol:IVToken");
          fakeMarket.comptroller.returns(HUB_SPOKE_COMPTROLLER);

          await expect(eBrake.connect(governance)["decreaseCF(address,uint256)"](fakeMarket.address, 0))
            .to.be.revertedWithCustomError(eBrake, "MarketNotListed")
            .withArgs(0, fakeMarket.address);
        });

        it("should reject a pause batch that mixes Spoke comptrollers", async () => {
          await expect(eBrake.connect(governance).pauseActions([vUSDT_HUB_SPOKE, vUSDT_QA_SPOKE], [Action.MINT]))
            .to.be.revertedWithCustomError(eBrake, "MarketsOnDifferentComptrollers")
            .withArgs(HUB_SPOKE_COMPTROLLER, QA_SPOKE_COMPTROLLER);
        });

        it("should reject a borrow cap batch that mixes a Spoke and a Core market", async () => {
          await expect(eBrake.connect(governance).setMarketBorrowCaps([vUSDT_HUB_SPOKE, vUSDT_CORE], [0, 0]))
            .to.be.revertedWithCustomError(eBrake, "MarketsOnDifferentComptrollers")
            .withArgs(HUB_SPOKE_COMPTROLLER, CORE_COMPTROLLER);
        });

        it("should reject a supply cap batch that mixes a Core and a Spoke market", async () => {
          await expect(eBrake.connect(governance).setMarketSupplyCaps([vUSDT_CORE, vUSDT_HUB_SPOKE], [0, 0]))
            .to.be.revertedWithCustomError(eBrake, "MarketsOnDifferentComptrollers")
            .withArgs(CORE_COMPTROLLER, HUB_SPOKE_COMPTROLLER);
        });
      });

      describe("access control", () => {
        it("should revert with Unauthorized for callers without ACM permission", async () => {
          await expect(eBrake.connect(user).pauseSupply(vUSDT_HUB_SPOKE))
            .to.be.revertedWithCustomError(eBrake, "Unauthorized")
            .withArgs(user.address, eBrake.address, "pauseSupply(address)");
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

          await expect(eBrake.connect(governance).pauseSupply(vUSDT_HUB_SPOKE))
            .to.be.revertedWithCustomError(eBrake, "Unauthorized")
            .withArgs(eBrake.address, HUB_SPOKE_COMPTROLLER, "setActionsPaused(address[],uint256[],bool)");
        });
      });
    });
  });
}
