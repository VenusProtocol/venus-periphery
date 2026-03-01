import { FakeContract, smock } from "@defi-wonderland/smock";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import chai from "chai";
import { BigNumber } from "ethers";
import { parseUnits } from "ethers/lib/utils";
import { ethers } from "hardhat";

import { FixedRateVault, FundRouter, IAccessControlManagerV8, MockToken, VaultFactory } from "../../../../typechain";
import { VaultInitParams, deployFullSystemFixture } from "../fixtures";

const { expect } = chai;
chai.use(smock.matchers);

const State = {
  Fundraising: 0,
  PendingFill: 1,
  Locked: 2,
  Matured: 3,
  Cancelled: 4,
};

describe("FixedRateVault - Repayment", () => {
  let owner: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let treasury: SignerWithAddress;
  let ceffuWallet: SignerWithAddress;
  let acm: FakeContract<IAccessControlManagerV8>;
  let usdcToken: MockToken;
  let fundRouter: FundRouter;
  let factory: VaultFactory;
  let vault: FixedRateVault;
  let vaultAddress: string;
  let params: VaultInitParams;

  beforeEach(async () => {
    ({ owner, alice, bob, treasury, ceffuWallet, acm, usdcToken, fundRouter, factory, vault, vaultAddress, params } =
      await loadFixture(deployFullSystemFixture));
    acm.isAllowedToCall.returns(true);
  });

  // ── Helpers ────────────────────────────────────────

  async function depositInFundraising(user: SignerWithAddress, amount: BigNumber): Promise<void> {
    await usdcToken.connect(user).approve(vault.address, amount);
    await vault.connect(user).deposit(amount, user.address);
  }

  /** Fundraising → Locked: deposit, close, full FundRouter flow */
  async function advanceToLocked(): Promise<void> {
    await time.increaseTo(params.fundraisingStartTime);
    await depositInFundraising(alice, parseUnits("2000", 18));
    await vault.closeFundraising();
    await fundRouter.setCeffuAddressForVault(vaultAddress, ceffuWallet.address);
    await fundRouter.transferToCeffu(vaultAddress);
    await fundRouter.confirmOrderFillForVault(vaultAddress);
  }

  /** Fund FundRouter with tokens and distribute repayment to vault */
  async function doRepaymentViaRouter(amount: BigNumber): Promise<void> {
    await usdcToken.connect(owner).faucet(amount);
    await usdcToken.connect(owner).transfer(fundRouter.address, amount);
    await fundRouter.recordRepayment(vaultAddress, amount);
    await fundRouter.distributeRepaymentToVault(vaultAddress);
  }

  // ── receiveRepayment() ─────────────────────────────

  describe("receiveRepayment()", () => {
    // Default vault: principal = 2000, reserveFactorBps = 1000 (10%)

    describe("Happy path (via FundRouter flow)", () => {
      const repayment = parseUnits("2100", 18);
      // grossInterest = 100, protocolReserve = 100 * 10% = 10
      const expectedReserve = parseUnits("10", 18);
      const expectedUserNet = parseUnits("2090", 18);

      beforeEach(async () => {
        await advanceToLocked();
      });

      it("transitions from Locked to Matured", async () => {
        await doRepaymentViaRouter(repayment);
        expect(await vault.state()).to.equal(State.Matured);
      });

      it("sets totalRepayment to the repayment amount", async () => {
        await doRepaymentViaRouter(repayment);
        expect(await vault.totalRepayment()).to.equal(repayment);
      });

      it("calculates protocolReserve = (grossInterest * reserveFactorBps) / MAX_BPS", async () => {
        await doRepaymentViaRouter(repayment);
        expect(await vault.protocolReserve()).to.equal(expectedReserve);
      });

      it("emits RepaymentReceived event", async () => {
        // Inline the last step of doRepaymentViaRouter to capture the event
        await usdcToken.connect(owner).faucet(repayment);
        await usdcToken.connect(owner).transfer(fundRouter.address, repayment);
        await fundRouter.recordRepayment(vaultAddress, repayment);

        // distributeRepaymentToVault calls vault.receiveRepayment internally
        await expect(fundRouter.distributeRepaymentToVault(vaultAddress))
          .to.emit(vault, "RepaymentReceived")
          .withArgs(repayment, expectedReserve, expectedUserNet);
      });

      it("transfers repayment tokens to vault", async () => {
        await doRepaymentViaRouter(repayment);
        expect(await usdcToken.balanceOf(vaultAddress)).to.equal(repayment);
      });
    });

    describe("Interest edge cases", () => {
      const principal = parseUnits("2000", 18);

      beforeEach(async () => {
        await advanceToLocked();
      });

      it("protocolReserve = 0 when repayment equals principal (no interest)", async () => {
        await doRepaymentViaRouter(principal);

        expect(await vault.totalRepayment()).to.equal(principal);
        expect(await vault.protocolReserve()).to.equal(0);
      });

      it("protocolReserve = 0 when repayment < principal (loss socialized to users)", async () => {
        const partialRepayment = parseUnits("1500", 18);
        await doRepaymentViaRouter(partialRepayment);

        expect(await vault.totalRepayment()).to.equal(partialRepayment);
        expect(await vault.protocolReserve()).to.equal(0);
        expect(await vault.state()).to.equal(State.Matured);
      });

      it("protocolReserve rounds down for 1 wei of interest", async () => {
        // grossInterest = 1 wei, (1 * 1000) / 10000 = 0 (integer division)
        const repayment = principal.add(1);
        await doRepaymentViaRouter(repayment);

        expect(await vault.protocolReserve()).to.equal(0);
      });
    });

    describe("Revert conditions", () => {
      it("reverts if caller is not fundRouter (OnlyFundRouter)", async () => {
        await advanceToLocked();

        await expect(vault.connect(alice).receiveRepayment(parseUnits("2100", 18))).to.be.revertedWithCustomError(
          vault,
          "OnlyFundRouter",
        );
      });

      it("reverts if not in Locked state", async () => {
        // Impersonate fundRouter to bypass OnlyFundRouter check
        // hardhat_setBalance used because FundRouter has no receive/fallback
        await ethers.provider.send("hardhat_impersonateAccount", [fundRouter.address]);
        await ethers.provider.send("hardhat_setBalance", [fundRouter.address, "0xDE0B6B3A7640000"]);
        const routerSigner = await ethers.getSigner(fundRouter.address);

        await expect(vault.connect(routerSigner).receiveRepayment(parseUnits("2100", 18), { gasLimit: 500000 }))
          .to.be.revertedWithCustomError(vault, "InvalidState")
          .withArgs(State.Fundraising, State.Locked);

        await ethers.provider.send("hardhat_stopImpersonatingAccount", [fundRouter.address]);
      });
    });
  });

  // ── withdrawReserves() ─────────────────────────────

  describe("withdrawReserves()", () => {
    const repayment = parseUnits("2100", 18);
    const expectedReserve = parseUnits("10", 18);

    describe("Happy path", () => {
      beforeEach(async () => {
        await advanceToLocked();
        await doRepaymentViaRouter(repayment);
      });

      it("transfers protocolReserve to recipient", async () => {
        const treasuryBalBefore = await usdcToken.balanceOf(treasury.address);

        await vault.withdrawReserves(treasury.address);

        expect(await usdcToken.balanceOf(treasury.address)).to.equal(treasuryBalBefore.add(expectedReserve));
      });

      it("sets reservesWithdrawn to true", async () => {
        expect(await vault.reservesWithdrawn()).to.be.false;

        await vault.withdrawReserves(treasury.address);

        expect(await vault.reservesWithdrawn()).to.be.true;
      });

      it("emits ReservesWithdrawn event", async () => {
        await expect(vault.withdrawReserves(treasury.address))
          .to.emit(vault, "ReservesWithdrawn")
          .withArgs(treasury.address, expectedReserve);
      });

      it("totalAssets() unchanged after reserves withdrawn", async () => {
        // Before: totalAssets = balance - protocolReserve = 2100 - 10 = 2090
        // After: balance = 2090, reservesWithdrawn = true → totalAssets = balance = 2090
        const totalAssetsBefore = await vault.totalAssets();

        await vault.withdrawReserves(treasury.address);

        expect(await vault.totalAssets()).to.equal(totalAssetsBefore);
      });
    });

    describe("Revert conditions", () => {
      it("reverts if not in Matured state", async () => {
        await expect(vault.withdrawReserves(treasury.address))
          .to.be.revertedWithCustomError(vault, "InvalidState")
          .withArgs(State.Fundraising, State.Matured);
      });

      it("reverts if reserves already withdrawn (ReservesAlreadyWithdrawn)", async () => {
        await advanceToLocked();
        await doRepaymentViaRouter(repayment);
        await vault.withdrawReserves(treasury.address);

        await expect(vault.withdrawReserves(treasury.address)).to.be.revertedWithCustomError(
          vault,
          "ReservesAlreadyWithdrawn",
        );
      });

      it("reverts if protocolReserve is 0 (NoReservesToWithdraw)", async () => {
        // Repayment == principal → no interest → protocolReserve = 0
        await advanceToLocked();
        await doRepaymentViaRouter(parseUnits("2000", 18));

        await expect(vault.withdrawReserves(treasury.address)).to.be.revertedWithCustomError(
          vault,
          "NoReservesToWithdraw",
        );
      });

      it("reverts if recipient is zero address", async () => {
        await advanceToLocked();
        await doRepaymentViaRouter(repayment);

        await expect(vault.withdrawReserves(ethers.constants.AddressZero)).to.be.revertedWithCustomError(
          vault,
          "ZeroAddressNotAllowed",
        );
      });

      it("reverts when ACM denies access", async () => {
        await advanceToLocked();
        await doRepaymentViaRouter(repayment);
        acm.isAllowedToCall.returns(false);

        await expect(vault.withdrawReserves(treasury.address)).to.be.revertedWithCustomError(vault, "Unauthorized");
      });
    });

    it("succeeds when vault is paused (no whenNotPaused modifier)", async () => {
      await advanceToLocked();
      await doRepaymentViaRouter(repayment);
      await vault.pause();

      await vault.withdrawReserves(treasury.address);

      expect(await vault.reservesWithdrawn()).to.be.true;
    });
  });
});
