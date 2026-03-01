import { FakeContract, smock } from "@defi-wonderland/smock";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import chai from "chai";
import { BigNumber } from "ethers";
import { parseUnits } from "ethers/lib/utils";
import { ethers } from "hardhat";

import { FixedRateVault, FundRouter, IAccessControlManagerV8, MockToken, VaultFactory } from "../../../../typechain";
import { SEVEN_DAYS, THIRTY_DAYS, VaultInitParams, defaultVaultParams, deployFullSystemFixture } from "../fixtures";

const { expect } = chai;
chai.use(smock.matchers);

const State = {
  Fundraising: 0,
  PendingFill: 1,
  Locked: 2,
  Matured: 3,
  Cancelled: 4,
};

describe("FixedRateVault - Initialization & Access Control", () => {
  let owner: SignerWithAddress;
  let alice: SignerWithAddress;
  let _bob: SignerWithAddress;
  let treasury: SignerWithAddress;
  let ceffuWallet: SignerWithAddress;
  let acm: FakeContract<IAccessControlManagerV8>;
  let usdcToken: MockToken;
  let vaultImpl: FixedRateVault;
  let fundRouter: FundRouter;
  let factory: VaultFactory;
  let vault: FixedRateVault;
  let vaultAddress: string;
  let params: VaultInitParams;

  beforeEach(async () => {
    ({
      owner,
      alice,
      bob: _bob,
      treasury,
      ceffuWallet,
      acm,
      usdcToken,
      vaultImpl,
      fundRouter,
      factory,
      vault,
      vaultAddress,
      params,
    } = await loadFixture(deployFullSystemFixture));
    acm.isAllowedToCall.returns(true);
  });

  // ── Helpers ────────────────────────────────────────

  let paramCounter = 0;

  /** Deploy a new vault via factory with param overrides (auto-generates unique ceffuRequestId) */
  async function deployWithOverrides(
    overrides: Partial<VaultInitParams>,
  ): Promise<ReturnType<typeof factory.deployVault>> {
    paramCounter++;
    const p = await defaultVaultParams(usdcToken.address, {
      ceffuRequestId: `CR-INIT-${paramCounter}`,
      ...overrides,
    });
    return factory.deployVault(p);
  }

  async function depositInFundraising(user: SignerWithAddress, amount: BigNumber): Promise<void> {
    await usdcToken.connect(user).approve(vault.address, amount);
    await vault.connect(user).deposit(amount, user.address);
  }

  async function advanceToLocked(): Promise<void> {
    await time.increaseTo(params.fundraisingStartTime);
    await depositInFundraising(alice, parseUnits("2000", 18));
    await vault.closeFundraising();
    await fundRouter.setCeffuAddressForVault(vaultAddress, ceffuWallet.address);
    await fundRouter.transferToCeffu(vaultAddress);
    await fundRouter.confirmOrderFillForVault(vaultAddress);
  }

  async function advanceToMatured(): Promise<void> {
    await advanceToLocked();
    const repayment = parseUnits("2100", 18);
    await usdcToken.connect(owner).faucet(repayment);
    await usdcToken.connect(owner).transfer(fundRouter.address, repayment);
    await fundRouter.recordRepayment(vaultAddress, repayment);
    await fundRouter.distributeRepaymentToVault(vaultAddress);
  }

  // ══════════════════════════════════════════════════
  //  initialize()
  // ══════════════════════════════════════════════════

  describe("initialize()", () => {
    describe("Successful initialization", () => {
      it("defaults state to Fundraising", async () => {
        expect(await vault.state()).to.equal(State.Fundraising);
      });

      it("sets all config variables from params", async () => {
        expect(await vault.fixedAPY()).to.equal(params.fixedAPY);
        expect(await vault.minCap()).to.equal(params.minCap);
        expect(await vault.maxCap()).to.equal(params.maxCap);
        expect(await vault.fundraisingStartTime()).to.equal(params.fundraisingStartTime);
        expect(await vault.fundraisingEndTime()).to.equal(params.fundraisingEndTime);
        expect(await vault.lockPeriodDuration()).to.equal(params.lockPeriodDuration);
        expect(await vault.reserveFactorBps()).to.equal(params.reserveFactorBps);
        expect(await vault.minUserDeposit()).to.equal(params.minUserDeposit);
        expect(await vault.maxUserDeposit()).to.equal(params.maxUserDeposit);
        expect(await vault.gracePeriod()).to.equal(params.gracePeriod);
        expect(await vault.ceffuRequestId()).to.equal("CR-0001");
      });

      it("sets fundRouter from factory", async () => {
        expect(await vault.fundRouter()).to.equal(fundRouter.address);
      });

      it("initializes ERC-20 name and symbol", async () => {
        expect(await vault.name()).to.equal(params.name);
        expect(await vault.symbol()).to.equal(params.symbol);
      });

      it("initializes ERC-4626 with correct asset", async () => {
        expect(await vault.asset()).to.equal(usdcToken.address);
      });

      it("initializes runtime state to zero values", async () => {
        expect(await vault.totalPrincipal()).to.equal(0);
        expect(await vault.totalRepayment()).to.equal(0);
        expect(await vault.protocolReserve()).to.equal(0);
        expect(await vault.reservesWithdrawn()).to.equal(false);
        expect(await vault.lockStartAt()).to.equal(0);
        expect(await vault.lockPeriodEndTime()).to.equal(0);
      });

      it("reverts on re-initialization", async () => {
        const p = await defaultVaultParams(usdcToken.address);
        await expect(vault.initialize(acm.address, fundRouter.address, p)).to.be.revertedWith(
          "Initializable: contract is already initialized",
        );
      });

      it("implementation contract cannot be initialized (constructor disables initializers)", async () => {
        const p = await defaultVaultParams(usdcToken.address);
        await expect(vaultImpl.initialize(acm.address, fundRouter.address, p)).to.be.revertedWith(
          "Initializable: contract is already initialized",
        );
      });
    });

    describe("Parameter validation", () => {
      it("reverts if fixedAPY is 0", async () => {
        await expect(deployWithOverrides({ fixedAPY: 0 }))
          .to.be.revertedWithCustomError(vault, "InvalidInitParam")
          .withArgs("fixedAPY");
      });

      it("reverts if minCap is 0", async () => {
        await expect(deployWithOverrides({ minCap: "0" }))
          .to.be.revertedWithCustomError(vault, "InvalidInitParam")
          .withArgs("minCap");
      });

      it("reverts if maxCap < minCap", async () => {
        await expect(
          deployWithOverrides({
            minCap: parseUnits("5000", 18).toString(),
            maxCap: parseUnits("1000", 18).toString(),
          }),
        )
          .to.be.revertedWithCustomError(vault, "InvalidInitParam")
          .withArgs("maxCap < minCap");
      });

      it("reverts if fundraisingEndTime <= fundraisingStartTime", async () => {
        const now = await time.latest();
        await expect(
          deployWithOverrides({
            fundraisingStartTime: now + 100,
            fundraisingEndTime: now + 100, // equal
          }),
        )
          .to.be.revertedWithCustomError(vault, "InvalidInitParam")
          .withArgs("fundraisingWindow");
      });

      it("reverts if fundraisingEndTime < fundraisingStartTime", async () => {
        const now = await time.latest();
        await expect(
          deployWithOverrides({
            fundraisingStartTime: now + 200,
            fundraisingEndTime: now + 100,
          }),
        )
          .to.be.revertedWithCustomError(vault, "InvalidInitParam")
          .withArgs("fundraisingWindow");
      });

      it("reverts if lockPeriodDuration is 0", async () => {
        await expect(deployWithOverrides({ lockPeriodDuration: 0 }))
          .to.be.revertedWithCustomError(vault, "InvalidInitParam")
          .withArgs("lockPeriodDuration");
      });

      it("reverts if reserveFactorBps > MAX_BPS (10000)", async () => {
        await expect(deployWithOverrides({ reserveFactorBps: 10001 }))
          .to.be.revertedWithCustomError(vault, "InvalidInitParam")
          .withArgs("reserveFactorBps > 100%");
      });

      it("reverts if supplyAsset is zero address", async () => {
        paramCounter++;
        const p = await defaultVaultParams(ethers.constants.AddressZero, {
          ceffuRequestId: `CR-INIT-${paramCounter}`,
        });
        await expect(factory.deployVault(p)).to.be.revertedWithCustomError(vault, "ZeroAddressNotAllowed");
      });
    });

    describe("Boundary values accepted", () => {
      it("accepts reserveFactorBps == MAX_BPS (100% to protocol)", async () => {
        await expect(deployWithOverrides({ reserveFactorBps: 10000 })).to.not.be.reverted;
      });

      it("accepts reserveFactorBps == 0 (no protocol fee)", async () => {
        await expect(deployWithOverrides({ reserveFactorBps: 0 })).to.not.be.reverted;
      });

      it("accepts maxCap == minCap", async () => {
        const cap = parseUnits("5000", 18).toString();
        await expect(deployWithOverrides({ minCap: cap, maxCap: cap })).to.not.be.reverted;
      });

      it("accepts minUserDeposit == 0 (no per-user minimum)", async () => {
        await expect(deployWithOverrides({ minUserDeposit: "0" })).to.not.be.reverted;
      });

      it("accepts maxUserDeposit == 0 (no per-user cap)", async () => {
        await expect(deployWithOverrides({ maxUserDeposit: "0" })).to.not.be.reverted;
      });

      it("accepts gracePeriod == 0", async () => {
        await expect(deployWithOverrides({ gracePeriod: 0 })).to.not.be.reverted;
      });
    });
  });

  // ══════════════════════════════════════════════════
  //  Access Control
  // ══════════════════════════════════════════════════

  describe("Access Control", () => {
    // All tests: set ACM to deny, then call the function

    describe("closeFundraising()", () => {
      it("reverts when ACM denies access", async () => {
        acm.isAllowedToCall.returns(false);
        await expect(vault.closeFundraising()).to.be.revertedWithCustomError(vault, "Unauthorized");
      });

      it("succeeds when ACM allows access", async () => {
        // closeFundraising with 0 deposits → Cancelled (below minCap)
        await expect(vault.closeFundraising()).to.not.be.reverted;
      });
    });

    describe("cancelVault()", () => {
      it("reverts when ACM denies access", async () => {
        acm.isAllowedToCall.returns(false);
        await expect(vault.cancelVault()).to.be.revertedWithCustomError(vault, "Unauthorized");
      });

      it("succeeds when ACM allows access", async () => {
        await expect(vault.cancelVault()).to.not.be.reverted;
      });
    });

    describe("emergencyUnlock()", () => {
      it("reverts when ACM denies access", async () => {
        acm.isAllowedToCall.returns(false);
        await expect(vault.emergencyUnlock()).to.be.revertedWithCustomError(vault, "Unauthorized");
      });
    });

    describe("withdrawReserves()", () => {
      it("reverts when ACM denies access", async () => {
        acm.isAllowedToCall.returns(false);
        await expect(vault.withdrawReserves(treasury.address)).to.be.revertedWithCustomError(vault, "Unauthorized");
      });
    });

    describe("pause()", () => {
      it("reverts when ACM denies access", async () => {
        acm.isAllowedToCall.returns(false);
        await expect(vault.pause()).to.be.revertedWithCustomError(vault, "Unauthorized");
      });

      it("succeeds when ACM allows access", async () => {
        await expect(vault.pause()).to.not.be.reverted;
        expect(await vault.paused()).to.equal(true);
      });
    });

    describe("unpause()", () => {
      it("reverts when ACM denies access", async () => {
        await vault.pause();
        acm.isAllowedToCall.returns(false);
        await expect(vault.unpause()).to.be.revertedWithCustomError(vault, "Unauthorized");
      });

      it("succeeds when ACM allows access", async () => {
        await vault.pause();
        await expect(vault.unpause()).to.not.be.reverted;
        expect(await vault.paused()).to.equal(false);
      });
    });

    describe("ACL check ordering", () => {
      it("closeFundraising: ACL fires after whenNotPaused", async () => {
        // whenNotPaused runs before _checkAccessAllowed
        await vault.pause();
        acm.isAllowedToCall.returns(false);
        await expect(vault.closeFundraising()).to.be.revertedWith("Pausable: paused");
      });

      it("cancelVault: ACL fires first (no modifiers)", async () => {
        // cancelVault has no whenNotPaused or nonReentrant
        acm.isAllowedToCall.returns(false);
        await expect(vault.cancelVault()).to.be.revertedWithCustomError(vault, "Unauthorized");
      });

      it("emergencyUnlock: ACL fires before state check", async () => {
        // Vault is in Fundraising (wrong state for emergencyUnlock), but ACL fires first
        acm.isAllowedToCall.returns(false);
        await expect(vault.emergencyUnlock()).to.be.revertedWithCustomError(vault, "Unauthorized");
      });

      it("withdrawReserves: ACL fires before state check", async () => {
        // Vault is in Fundraising (wrong state), but ACL fires first
        acm.isAllowedToCall.returns(false);
        await expect(vault.withdrawReserves(treasury.address)).to.be.revertedWithCustomError(vault, "Unauthorized");
      });
    });
  });

  // ══════════════════════════════════════════════════
  //  Pausability
  // ══════════════════════════════════════════════════

  describe("Pausability", () => {
    it("pause() pauses the vault", async () => {
      await vault.pause();
      expect(await vault.paused()).to.equal(true);
    });

    it("unpause() unpauses the vault", async () => {
      await vault.pause();
      await vault.unpause();
      expect(await vault.paused()).to.equal(false);
    });

    it("pause reverts if already paused", async () => {
      await vault.pause();
      await expect(vault.pause()).to.be.revertedWith("Pausable: paused");
    });

    it("unpause reverts if not paused", async () => {
      await expect(vault.unpause()).to.be.revertedWith("Pausable: not paused");
    });

    it("deposit blocked when paused", async () => {
      await time.increaseTo(params.fundraisingStartTime);
      await vault.pause();
      await usdcToken.connect(alice).approve(vault.address, parseUnits("1000", 18));

      await expect(vault.connect(alice).deposit(parseUnits("1000", 18), alice.address)).to.be.revertedWith(
        "Pausable: paused",
      );
    });

    it("mint blocked when paused", async () => {
      await time.increaseTo(params.fundraisingStartTime);
      await vault.pause();
      await usdcToken.connect(alice).approve(vault.address, parseUnits("1000", 18));

      await expect(vault.connect(alice).mint(parseUnits("1000", 18), alice.address)).to.be.revertedWith(
        "Pausable: paused",
      );
    });

    it("redeem allowed when paused (user safety valve)", async () => {
      await advanceToMatured();
      await vault.pause();

      const shares = await vault.balanceOf(alice.address);
      await expect(vault.connect(alice).redeem(shares, alice.address, alice.address)).to.not.be.reverted;
    });

    it("withdraw allowed when paused (user safety valve)", async () => {
      await advanceToMatured();
      await vault.pause();

      const max = await vault.maxWithdraw(alice.address);
      await expect(vault.connect(alice).withdraw(max, alice.address, alice.address)).to.not.be.reverted;
    });
  });
});
