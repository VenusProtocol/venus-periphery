import { FakeContract, smock } from "@defi-wonderland/smock";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import chai from "chai";
import { BigNumber } from "ethers";
import { parseUnits } from "ethers/lib/utils";
import { ethers } from "hardhat";

import { FixedRateVault, FundRouter, IAccessControlManagerV8, MockToken, VaultFactory } from "../../../../typechain";
import { SEVEN_DAYS, THIRTY_DAYS, VaultInitParams, deployFullSystemFixture } from "../fixtures";

const { expect } = chai;
chai.use(smock.matchers);

const State = {
  Fundraising: 0,
  PendingFill: 1,
  Locked: 2,
  Matured: 3,
  Cancelled: 4,
};

describe("FixedRateVault - Lifecycle", () => {
  let owner: SignerWithAddress;
  let alice: SignerWithAddress;
  let _bob: SignerWithAddress;
  let ceffuWallet: SignerWithAddress;
  let acm: FakeContract<IAccessControlManagerV8>;
  let usdcToken: MockToken;
  let fundRouter: FundRouter;
  let _factory: VaultFactory;
  let vault: FixedRateVault;
  let vaultAddress: string;
  let params: VaultInitParams;

  beforeEach(async () => {
    ({
      owner,
      alice,
      bob: _bob,
      ceffuWallet,
      acm,
      usdcToken,
      fundRouter,
      factory: _factory,
      vault,
      vaultAddress,
      params,
    } = await loadFixture(deployFullSystemFixture));
    acm.isAllowedToCall.returns(true);
  });

  // ── State-advancement helpers ────────────────────

  async function depositInFundraising(user: SignerWithAddress, amount: BigNumber): Promise<void> {
    await usdcToken.connect(user).approve(vault.address, amount);
    await vault.connect(user).deposit(amount, user.address);
  }

  /** Fundraising → PendingFill: deposit 2000 (>= minCap) then admin closes */
  async function advanceToPendingFill(): Promise<void> {
    await time.increaseTo(params.fundraisingStartTime);
    await depositInFundraising(alice, parseUnits("2000", 18));
    await vault.closeFundraising();
  }

  /** PendingFill → Locked: full FundRouter flow (setCeffu → transfer → confirmFill) */
  async function advanceToLocked(): Promise<void> {
    await advanceToPendingFill();
    await fundRouter.setCeffuAddressForVault(vaultAddress, ceffuWallet.address);
    await fundRouter.transferToCeffu(vaultAddress);
    await fundRouter.confirmOrderFillForVault(vaultAddress);
  }

  /** Locked → Matured: fund router with repayment tokens, then record + distribute */
  async function advanceToMatured(): Promise<void> {
    await advanceToLocked();
    const repaymentAmount = parseUnits("2100", 18); // principal(2000) + interest(100)
    await usdcToken.connect(owner).faucet(repaymentAmount);
    await usdcToken.connect(owner).transfer(fundRouter.address, repaymentAmount);
    await fundRouter.recordRepayment(vaultAddress, repaymentAmount);
    await fundRouter.distributeRepaymentToVault(vaultAddress);
  }

  // ── closeFundraising() ───────────────────────────

  describe("closeFundraising()", () => {
    describe("when totalPrincipal >= minCap (Scenario B)", () => {
      beforeEach(async () => {
        await time.increaseTo(params.fundraisingStartTime);
        await depositInFundraising(alice, parseUnits("2000", 18));
      });

      it("transitions to PendingFill", async () => {
        await vault.closeFundraising();
        expect(await vault.state()).to.equal(State.PendingFill);
      });

      it("transfers funds to FundRouter", async () => {
        const principal = parseUnits("2000", 18);
        await vault.closeFundraising();

        // Vault balance drained, FundRouter receives principal
        expect(await usdcToken.balanceOf(vaultAddress)).to.equal(0);
        expect(await usdcToken.balanceOf(fundRouter.address)).to.equal(principal);

        // Allocation recorded in FundRouter
        const allocation = await fundRouter.getVaultAllocation(vaultAddress);
        expect(allocation.fundsReceivedFromVault).to.be.true;
        expect(allocation.principalAmount).to.equal(principal);
      });

      it("emits FundraisingClosed event with totalPrincipal", async () => {
        const principal = parseUnits("2000", 18);
        await expect(vault.closeFundraising()).to.emit(vault, "FundraisingClosed").withArgs(principal);
      });
    });

    describe("when totalPrincipal < minCap", () => {
      it("transitions to Cancelled with zero deposits", async () => {
        await vault.closeFundraising();
        expect(await vault.state()).to.equal(State.Cancelled);
      });

      it("transitions to Cancelled with deposits below minCap", async () => {
        await time.increaseTo(params.fundraisingStartTime);
        await depositInFundraising(alice, parseUnits("500", 18));
        await vault.closeFundraising();
        expect(await vault.state()).to.equal(State.Cancelled);
      });

      it("emits VaultCancelled event", async () => {
        await expect(vault.closeFundraising()).to.emit(vault, "VaultCancelled");
      });

      it("does not transfer any tokens", async () => {
        await time.increaseTo(params.fundraisingStartTime);
        await depositInFundraising(alice, parseUnits("500", 18));

        const vaultBalBefore = await usdcToken.balanceOf(vaultAddress);
        await vault.closeFundraising();

        // Tokens stay in vault for user refunds
        expect(await usdcToken.balanceOf(vaultAddress)).to.equal(vaultBalBefore);
        expect(await usdcToken.balanceOf(fundRouter.address)).to.equal(0);
      });
    });

    describe("Revert conditions", () => {
      it("reverts if not in Fundraising state", async () => {
        await vault.cancelVault();

        await expect(vault.closeFundraising())
          .to.be.revertedWithCustomError(vault, "InvalidState")
          .withArgs(State.Cancelled, State.Fundraising);
      });

      it("reverts when paused", async () => {
        await vault.pause();

        await expect(vault.closeFundraising()).to.be.revertedWith("Pausable: paused");
      });
    });
  });

  // ── cancelVault() ────────────────────────────────

  describe("cancelVault()", () => {
    describe("From Fundraising (direct admin call)", () => {
      it("cancels from Fundraising state", async () => {
        await vault.cancelVault();
        expect(await vault.state()).to.equal(State.Cancelled);
      });

      it("emits VaultCancelled event", async () => {
        await expect(vault.cancelVault()).to.emit(vault, "VaultCancelled");
      });

      it("succeeds when vault is paused (no whenNotPaused modifier)", async () => {
        await vault.pause();

        await vault.cancelVault();
        expect(await vault.state()).to.equal(State.Cancelled);
      });
    });

    describe("From PendingFill (must go through FundRouter)", () => {
      it("cancels via fundRouter.returnFundsAndCancelVault (atomic fund return)", async () => {
        await advanceToPendingFill();
        const principal = parseUnits("2000", 18);
        expect(await vault.state()).to.equal(State.PendingFill);
        expect(await usdcToken.balanceOf(vaultAddress)).to.equal(0);

        await fundRouter.returnFundsAndCancelVault(vaultAddress);

        expect(await vault.state()).to.equal(State.Cancelled);
        // Funds atomically returned — vault has balance for user redemptions
        expect(await usdcToken.balanceOf(vaultAddress)).to.equal(principal);
      });

      it("reverts when admin calls cancelVault() directly in PendingFill (OnlyFundRouter)", async () => {
        await advanceToPendingFill();

        await expect(vault.cancelVault()).to.be.revertedWithCustomError(vault, "OnlyFundRouter");
      });

      it("reverts when non-FundRouter address calls cancelVault() in PendingFill", async () => {
        await advanceToPendingFill();

        await expect(vault.connect(alice).cancelVault()).to.be.revertedWithCustomError(vault, "OnlyFundRouter");
      });
    });

    describe("Revert conditions", () => {
      it("reverts from Locked state", async () => {
        await advanceToLocked();

        await expect(vault.cancelVault())
          .to.be.revertedWithCustomError(vault, "InvalidState")
          .withArgs(State.Locked, State.Fundraising);
      });

      it("reverts from Cancelled state", async () => {
        await vault.cancelVault();

        await expect(vault.cancelVault())
          .to.be.revertedWithCustomError(vault, "InvalidState")
          .withArgs(State.Cancelled, State.Fundraising);
      });

      it("reverts from Matured state", async () => {
        await advanceToMatured();

        await expect(vault.cancelVault())
          .to.be.revertedWithCustomError(vault, "InvalidState")
          .withArgs(State.Matured, State.Fundraising);
      });
    });
  });

  // ── confirmOrderFill() ──────────────────────────

  describe("confirmOrderFill()", () => {
    describe("Happy path (via FundRouter flow)", () => {
      beforeEach(async () => {
        await advanceToPendingFill();
        await fundRouter.setCeffuAddressForVault(vaultAddress, ceffuWallet.address);
        await fundRouter.transferToCeffu(vaultAddress);
      });

      it("transitions from PendingFill to Locked", async () => {
        await fundRouter.confirmOrderFillForVault(vaultAddress);
        expect(await vault.state()).to.equal(State.Locked);
      });

      it("sets lockStartAt to current block.timestamp", async () => {
        const tx = await fundRouter.confirmOrderFillForVault(vaultAddress);
        const block = await ethers.provider.getBlock(tx.blockNumber as number);

        expect(await vault.lockStartAt()).to.equal(block.timestamp);
      });

      it("sets lockPeriodEndTime = lockStartAt + lockPeriodDuration", async () => {
        const tx = await fundRouter.confirmOrderFillForVault(vaultAddress);
        const block = await ethers.provider.getBlock(tx.blockNumber as number);

        expect(await vault.lockPeriodEndTime()).to.equal(block.timestamp + THIRTY_DAYS);
      });

      it("emits OrderFillConfirmed event", async () => {
        await expect(fundRouter.confirmOrderFillForVault(vaultAddress)).to.emit(vault, "OrderFillConfirmed");
      });
    });

    it("reverts if caller is not fundRouter (OnlyFundRouter)", async () => {
      await advanceToPendingFill();

      await expect(vault.connect(alice).confirmOrderFill()).to.be.revertedWithCustomError(vault, "OnlyFundRouter");
    });

    it("reverts if vault is not in PendingFill state", async () => {
      // Impersonate fundRouter to bypass OnlyFundRouter check and test the state check
      // hardhat_setBalance used because FundRouter has no receive/fallback
      await ethers.provider.send("hardhat_impersonateAccount", [fundRouter.address]);
      await ethers.provider.send("hardhat_setBalance", [fundRouter.address, "0xDE0B6B3A7640000"]);
      const fundRouterSigner = await ethers.getSigner(fundRouter.address);

      await expect(vault.connect(fundRouterSigner).confirmOrderFill({ gasLimit: 500000 }))
        .to.be.revertedWithCustomError(vault, "InvalidState")
        .withArgs(State.Fundraising, State.PendingFill);

      await ethers.provider.send("hardhat_stopImpersonatingAccount", [fundRouter.address]);
    });
  });

  // ── emergencyUnlock() ───────────────────────────

  describe("emergencyUnlock()", () => {
    describe("Happy path", () => {
      beforeEach(async () => {
        await advanceToLocked();
      });

      it("transitions from Locked to Matured after grace period expires", async () => {
        const lockEnd = await vault.lockPeriodEndTime();
        const grace = await vault.gracePeriod();
        await time.increaseTo(lockEnd.add(grace).toNumber());

        await vault.emergencyUnlock();
        expect(await vault.state()).to.equal(State.Matured);
      });

      it("sets totalRepayment to vault token balance", async () => {
        // Vault balance = 0 after advanceToLocked (all funds sent to Ceffu)
        const lockEnd = await vault.lockPeriodEndTime();
        const grace = await vault.gracePeriod();
        await time.increaseTo(lockEnd.add(grace).toNumber());

        await vault.emergencyUnlock();
        expect(await vault.totalRepayment()).to.equal(0);
      });

      it("sets totalRepayment to actual balance when vault has partial funds", async () => {
        // Simulate partial return via direct token transfer to vault
        const partialReturn = parseUnits("500", 18);
        await usdcToken.connect(owner).faucet(partialReturn);
        await usdcToken.connect(owner).transfer(vaultAddress, partialReturn);

        const lockEnd = await vault.lockPeriodEndTime();
        const grace = await vault.gracePeriod();
        await time.increaseTo(lockEnd.add(grace).toNumber());

        await vault.emergencyUnlock();
        expect(await vault.totalRepayment()).to.equal(partialReturn);
      });

      it("does not set protocolReserve (stays 0)", async () => {
        const lockEnd = await vault.lockPeriodEndTime();
        const grace = await vault.gracePeriod();
        await time.increaseTo(lockEnd.add(grace).toNumber());

        await vault.emergencyUnlock();
        expect(await vault.protocolReserve()).to.equal(0);
      });

      it("emits EmergencyUnlocked event with vault balance", async () => {
        const lockEnd = await vault.lockPeriodEndTime();
        const grace = await vault.gracePeriod();
        await time.increaseTo(lockEnd.add(grace).toNumber());

        const balance = await usdcToken.balanceOf(vaultAddress);
        await expect(vault.emergencyUnlock()).to.emit(vault, "EmergencyUnlocked").withArgs(balance);
      });

      it("succeeds when vault is paused (no whenNotPaused modifier)", async () => {
        const lockEnd = await vault.lockPeriodEndTime();
        const grace = await vault.gracePeriod();
        await time.increaseTo(lockEnd.add(grace).toNumber());

        await vault.pause();

        await vault.emergencyUnlock();
        expect(await vault.state()).to.equal(State.Matured);
      });
    });

    describe("Revert conditions", () => {
      it("reverts if not in Locked state", async () => {
        await expect(vault.emergencyUnlock())
          .to.be.revertedWithCustomError(vault, "InvalidState")
          .withArgs(State.Fundraising, State.Locked);
      });

      it("reverts if grace period has not expired", async () => {
        await advanceToLocked();

        await expect(vault.emergencyUnlock()).to.be.revertedWithCustomError(vault, "GracePeriodNotExpired");
      });

      it("reverts at exact boundary (lockPeriodEndTime + gracePeriod - 1)", async () => {
        await advanceToLocked();

        const lockEnd = await vault.lockPeriodEndTime();
        const grace = await vault.gracePeriod();
        // increaseTo(x) mines at x, next tx mines at x+1 → sub(2) so tx runs at boundary-1
        await time.increaseTo(lockEnd.add(grace).sub(2).toNumber());

        await expect(vault.emergencyUnlock()).to.be.revertedWithCustomError(vault, "GracePeriodNotExpired");
      });
    });
  });
});
