import { FakeContract, smock } from "@defi-wonderland/smock";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import chai from "chai";
import { BigNumber } from "ethers";
import { parseUnits } from "ethers/lib/utils";
import "hardhat";

import { FixedRateVault, FundRouter, IAccessControlManagerV8, MockToken, VaultFactory } from "../../../../typechain";
import { VaultInitParams, deployFullSystemFixture } from "../fixtures";

const { expect } = chai;
chai.use(smock.matchers);

describe("FixedRateVault - Withdrawals", () => {
  let owner: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let treasury: SignerWithAddress;
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
      bob,
      treasury,
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

  /** Fundraising → Matured: deposit, lock, repay */
  async function advanceToMatured(repayment?: BigNumber): Promise<void> {
    await advanceToLocked();
    await doRepaymentViaRouter(repayment ?? parseUnits("2100", 18));
  }

  /** Fundraising → Cancelled with alice's deposit still in vault */
  async function advanceToCancelled(): Promise<void> {
    await time.increaseTo(params.fundraisingStartTime);
    await depositInFundraising(alice, parseUnits("2000", 18));
    await vault.cancelVault();
  }

  // ── redeem() ──────────────────────────────────────

  describe("redeem()", () => {
    describe("Matured state — normal repayment", () => {
      // principal=2000, repayment=2100, grossInterest=100, protocolReserve=10, userNet=2090
      const repayment = parseUnits("2100", 18);
      // principal=2000, repayment=2100, grossInterest=100, protocolReserve=10, userNet=2090

      beforeEach(async () => {
        await advanceToMatured(repayment);
      });

      it("redeems full shares for principal + net interest", async () => {
        const shares = await vault.balanceOf(alice.address);
        const expectedAssets = await vault.previewRedeem(shares);
        const balanceBefore = await usdcToken.balanceOf(alice.address);

        await vault.connect(alice).redeem(shares, alice.address, alice.address);

        // Exact match: previewRedeem returns the precise amount transferred
        expect(await usdcToken.balanceOf(alice.address)).to.equal(balanceBefore.add(expectedAssets));
      });

      it("burns all shares on full redemption", async () => {
        const shares = await vault.balanceOf(alice.address);
        await vault.connect(alice).redeem(shares, alice.address, alice.address);

        expect(await vault.balanceOf(alice.address)).to.equal(0);
        expect(await vault.totalSupply()).to.equal(0);
      });

      it("emits Withdraw event", async () => {
        const shares = await vault.balanceOf(alice.address);
        const assets = await vault.previewRedeem(shares);

        await expect(vault.connect(alice).redeem(shares, alice.address, alice.address))
          .to.emit(vault, "Withdraw")
          .withArgs(alice.address, alice.address, alice.address, assets, shares);
      });

      it("allows partial redemption", async () => {
        const halfShares = (await vault.balanceOf(alice.address)).div(2);
        const expectedAssets = await vault.previewRedeem(halfShares);
        const balanceBefore = await usdcToken.balanceOf(alice.address);

        await vault.connect(alice).redeem(halfShares, alice.address, alice.address);

        expect(await vault.balanceOf(alice.address)).to.equal(halfShares);
        expect(await usdcToken.balanceOf(alice.address)).to.equal(balanceBefore.add(expectedAssets));
      });
    });

    describe("Matured state — loss scenario", () => {
      it("redeems for less than deposited when repayment < principal", async () => {
        const partialRepayment = parseUnits("1500", 18);
        await advanceToMatured(partialRepayment);

        const shares = await vault.balanceOf(alice.address);
        const expectedAssets = await vault.previewRedeem(shares);
        const balanceBefore = await usdcToken.balanceOf(alice.address);

        await vault.connect(alice).redeem(shares, alice.address, alice.address);

        // User receives less than deposited — loss socialized proportionally
        expect(expectedAssets).to.be.lt(parseUnits("2000", 18));
        expect(await usdcToken.balanceOf(alice.address)).to.equal(balanceBefore.add(expectedAssets));
      });
    });

    describe("Matured state — multiple users", () => {
      it("distributes proportionally across users", async () => {
        await time.increaseTo(params.fundraisingStartTime);
        await depositInFundraising(alice, parseUnits("2000", 18));
        await depositInFundraising(bob, parseUnits("1000", 18));

        // Full FundRouter flow with totalPrincipal=3000
        await vault.closeFundraising();
        await fundRouter.setCeffuAddressForVault(vaultAddress, ceffuWallet.address);
        await fundRouter.transferToCeffu(vaultAddress);
        await fundRouter.confirmOrderFillForVault(vaultAddress);

        // Repayment=3150, grossInterest=150, protocolReserve=15, totalAssets=3135
        await doRepaymentViaRouter(parseUnits("3150", 18));

        // Alice: 2000/3000 * 3135 — exact value from previewRedeem
        const aliceShares = await vault.balanceOf(alice.address);
        const aliceExpected = await vault.previewRedeem(aliceShares);
        const aliceBalBefore = await usdcToken.balanceOf(alice.address);
        await vault.connect(alice).redeem(aliceShares, alice.address, alice.address);
        expect(await usdcToken.balanceOf(alice.address)).to.equal(aliceBalBefore.add(aliceExpected));

        // Bob: 1000/3000 * 3135 — exact value from previewRedeem
        const bobShares = await vault.balanceOf(bob.address);
        const bobExpected = await vault.previewRedeem(bobShares);
        const bobBalBefore = await usdcToken.balanceOf(bob.address);
        await vault.connect(bob).redeem(bobShares, bob.address, bob.address);
        expect(await usdcToken.balanceOf(bob.address)).to.equal(bobBalBefore.add(bobExpected));
      });
    });

    describe("Cancelled state", () => {
      it("redeems 1:1 (full refund)", async () => {
        await advanceToCancelled();

        const shares = await vault.balanceOf(alice.address);
        await vault.connect(alice).redeem(shares, alice.address, alice.address);

        // Alice gets her full 2000 back → balance restored to 100k
        expect(await usdcToken.balanceOf(alice.address)).to.equal(parseUnits("100000", 18));
        expect(await vault.balanceOf(alice.address)).to.equal(0);
      });

      it("multiple users can each redeem their full deposit", async () => {
        await time.increaseTo(params.fundraisingStartTime);
        await depositInFundraising(alice, parseUnits("2000", 18));
        await depositInFundraising(bob, parseUnits("1000", 18));
        await vault.cancelVault();

        await vault.connect(alice).redeem(await vault.balanceOf(alice.address), alice.address, alice.address);
        await vault.connect(bob).redeem(await vault.balanceOf(bob.address), bob.address, bob.address);

        expect(await usdcToken.balanceOf(alice.address)).to.equal(parseUnits("100000", 18));
        expect(await usdcToken.balanceOf(bob.address)).to.equal(parseUnits("100000", 18));
      });
    });

    describe("Revert conditions", () => {
      // maxRedeem() returns 0 for non-terminal states, so OZ's base require fires
      // before _withdraw() can check state (defense-in-depth never reached)

      it("reverts in Fundraising state", async () => {
        await time.increaseTo(params.fundraisingStartTime);
        await depositInFundraising(alice, parseUnits("2000", 18));

        await expect(
          vault.connect(alice).redeem(parseUnits("100", 18), alice.address, alice.address),
        ).to.be.revertedWith("ERC4626: redeem more than max");
      });

      it("reverts in PendingFill state", async () => {
        await time.increaseTo(params.fundraisingStartTime);
        await depositInFundraising(alice, parseUnits("2000", 18));
        await vault.closeFundraising();

        await expect(
          vault.connect(alice).redeem(parseUnits("100", 18), alice.address, alice.address),
        ).to.be.revertedWith("ERC4626: redeem more than max");
      });

      it("reverts in Locked state", async () => {
        await advanceToLocked();

        await expect(
          vault.connect(alice).redeem(parseUnits("100", 18), alice.address, alice.address),
        ).to.be.revertedWith("ERC4626: redeem more than max");
      });
    });

    it("succeeds when vault is paused (no whenNotPaused modifier)", async () => {
      await advanceToMatured();
      await vault.pause();

      const shares = await vault.balanceOf(alice.address);
      await vault.connect(alice).redeem(shares, alice.address, alice.address);

      expect(await vault.balanceOf(alice.address)).to.equal(0);
    });
  });

  // ── withdraw() ────────────────────────────────────

  describe("withdraw()", () => {
    describe("Matured state", () => {
      beforeEach(async () => {
        await advanceToMatured(parseUnits("2100", 18));
      });

      it("withdraws exact asset amount and burns correct shares", async () => {
        // withdraw(1045) → shares ≈ 1000 (±1 wei from virtual shares rounding)
        const withdrawAmount = parseUnits("1045", 18);

        const sharesBefore = await vault.balanceOf(alice.address);
        const expectedSharesBurned = await vault.previewWithdraw(withdrawAmount);
        await vault.connect(alice).withdraw(withdrawAmount, alice.address, alice.address);

        expect(await vault.balanceOf(alice.address)).to.equal(sharesBefore.sub(expectedSharesBurned));
      });

      it("withdraws full maxWithdraw amount", async () => {
        const maxAmount = await vault.maxWithdraw(alice.address);
        await vault.connect(alice).withdraw(maxAmount, alice.address, alice.address);

        expect(await vault.balanceOf(alice.address)).to.equal(0);
      });
    });

    describe("Cancelled state", () => {
      it("withdraws 1:1", async () => {
        await advanceToCancelled();

        const maxAmount = await vault.maxWithdraw(alice.address);
        expect(maxAmount).to.equal(parseUnits("2000", 18));

        await vault.connect(alice).withdraw(maxAmount, alice.address, alice.address);
        expect(await usdcToken.balanceOf(alice.address)).to.equal(parseUnits("100000", 18));
      });
    });

    describe("Revert conditions", () => {
      it("reverts in Fundraising state", async () => {
        await time.increaseTo(params.fundraisingStartTime);
        await depositInFundraising(alice, parseUnits("2000", 18));

        await expect(
          vault.connect(alice).withdraw(parseUnits("100", 18), alice.address, alice.address),
        ).to.be.revertedWith("ERC4626: withdraw more than max");
      });
    });

    it("succeeds when vault is paused (no whenNotPaused modifier)", async () => {
      await advanceToCancelled();
      await vault.pause();

      const maxAmount = await vault.maxWithdraw(alice.address);
      await vault.connect(alice).withdraw(maxAmount, alice.address, alice.address);

      expect(await vault.balanceOf(alice.address)).to.equal(0);
    });
  });

  // ── Withdrawal after reserves withdrawn ───────────

  describe("Withdrawal after reserves withdrawn", () => {
    it("redemption amount unchanged after withdrawReserves", async () => {
      await advanceToMatured(parseUnits("2100", 18));

      // Before: balance=2100, totalAssets=2100-10=2090
      const redeemableBefore = await vault.maxWithdraw(alice.address);
      await vault.withdrawReserves(treasury.address);
      // After: balance=2090, reservesWithdrawn=true, totalAssets=2090
      const redeemableAfter = await vault.maxWithdraw(alice.address);

      expect(redeemableAfter).to.equal(redeemableBefore);

      await vault.connect(alice).redeem(await vault.balanceOf(alice.address), alice.address, alice.address);
      expect(await vault.balanceOf(alice.address)).to.equal(0);
    });
  });

  // ── ERC-4626 allowance ────────────────────────────

  describe("ERC-4626 allowance", () => {
    beforeEach(async () => {
      await advanceToMatured(parseUnits("2100", 18));
    });

    it("allows third-party redemption with approval", async () => {
      const shares = await vault.balanceOf(alice.address);
      const expectedAssets = await vault.previewRedeem(shares);
      await vault.connect(alice).approve(bob.address, shares);

      // Bob redeems alice's shares, assets sent to bob
      const bobBalBefore = await usdcToken.balanceOf(bob.address);
      await vault.connect(bob).redeem(shares, bob.address, alice.address);

      expect(await vault.balanceOf(alice.address)).to.equal(0);
      expect(await usdcToken.balanceOf(bob.address)).to.equal(bobBalBefore.add(expectedAssets));
    });

    it("reverts without sufficient allowance", async () => {
      const shares = await vault.balanceOf(alice.address);

      await expect(vault.connect(bob).redeem(shares, bob.address, alice.address)).to.be.revertedWith(
        "ERC20: insufficient allowance",
      );
    });
  });
});
