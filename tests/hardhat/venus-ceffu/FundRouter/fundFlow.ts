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

describe("FundRouter - Fund Flow", () => {
  let owner: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
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

  /** Deposit and close fundraising → PendingFill, funds in router */
  async function advanceToPendingFill(): Promise<void> {
    await time.increaseTo(params.fundraisingStartTime);
    await depositInFundraising(alice, parseUnits("2000", 18));
    await vault.closeFundraising();
  }

  /** PendingFill → set ceffu address + transfer to ceffu */
  async function advanceToFundsSentToCeffu(): Promise<void> {
    await advanceToPendingFill();
    await fundRouter.setCeffuAddressForVault(vaultAddress, ceffuWallet.address);
    await fundRouter.transferToCeffu(vaultAddress);
  }

  /** Funds sent → confirm order fill → Locked */
  async function advanceToLocked(): Promise<void> {
    await advanceToFundsSentToCeffu();
    await fundRouter.confirmOrderFillForVault(vaultAddress);
  }

  /** Locked → record repayment */
  async function advanceToRepaymentRecorded(repayment?: BigNumber): Promise<void> {
    await advanceToLocked();
    const amount = repayment ?? parseUnits("2100", 18);
    await usdcToken.connect(owner).faucet(amount);
    await usdcToken.connect(owner).transfer(fundRouter.address, amount);
    await fundRouter.recordRepayment(vaultAddress, amount);
  }

  // ══════════════════════════════════════════════════
  //  Step 1: receiveFundsFromVault()
  // ══════════════════════════════════════════════════

  describe("receiveFundsFromVault()", () => {
    describe("Happy path (via vault.closeFundraising)", () => {
      it("records allocation with correct state", async () => {
        await advanceToPendingFill();

        const alloc = await fundRouter.getVaultAllocation(vaultAddress);
        expect(alloc.supplyAsset).to.equal(usdcToken.address);
        expect(alloc.principalAmount).to.equal(parseUnits("2000", 18));
        expect(alloc.fundsReceivedFromVault).to.equal(true);
        expect(alloc.fundsSentToCeffu).to.equal(false);
        expect(alloc.orderFillConfirmed).to.equal(false);
        expect(alloc.repaymentReceived).to.equal(false);
        expect(alloc.repaymentDistributed).to.equal(false);
      });

      it("transfers tokens from vault to router", async () => {
        const routerBalBefore = await usdcToken.balanceOf(fundRouter.address);
        await advanceToPendingFill();

        expect(await usdcToken.balanceOf(fundRouter.address)).to.equal(routerBalBefore.add(parseUnits("2000", 18)));
        expect(await usdcToken.balanceOf(vaultAddress)).to.equal(0);
      });

      it("emits FundsReceivedFromVault event", async () => {
        await time.increaseTo(params.fundraisingStartTime);
        await depositInFundraising(alice, parseUnits("2000", 18));

        await expect(vault.closeFundraising())
          .to.emit(fundRouter, "FundsReceivedFromVault")
          .withArgs(vaultAddress, usdcToken.address, parseUnits("2000", 18));
      });
    });

    describe("Reverts", () => {
      it("reverts with CallerNotRegisteredVault for non-vault caller", async () => {
        await expect(fundRouter.connect(alice).receiveFundsFromVault(parseUnits("1000", 18)))
          .to.be.revertedWithCustomError(fundRouter, "CallerNotRegisteredVault")
          .withArgs(alice.address);
      });

      it("reverts with ZeroAmount", async () => {
        // Impersonate vault to call with 0
        await ethers.provider.send("hardhat_impersonateAccount", [vaultAddress]);
        await ethers.provider.send("hardhat_setBalance", [vaultAddress, "0x56BC75E2D63100000"]);
        const vaultSigner = await ethers.getSigner(vaultAddress);

        await expect(fundRouter.connect(vaultSigner).receiveFundsFromVault(0)).to.be.revertedWithCustomError(
          fundRouter,
          "ZeroAmount",
        );
      });

      it("reverts with AssetNotApproved when asset is not whitelisted", async () => {
        // Revoke USDC approval
        await fundRouter.setAssetApproval(usdcToken.address, false);

        await time.increaseTo(params.fundraisingStartTime);
        await depositInFundraising(alice, parseUnits("2000", 18));

        await expect(vault.closeFundraising())
          .to.be.revertedWithCustomError(fundRouter, "AssetNotApproved")
          .withArgs(usdcToken.address);
      });

      it("reverts with OperationAlreadyCompleted on double call", async () => {
        await advanceToPendingFill();

        // Impersonate vault to call again
        await ethers.provider.send("hardhat_impersonateAccount", [vaultAddress]);
        await ethers.provider.send("hardhat_setBalance", [vaultAddress, "0x56BC75E2D63100000"]);
        const vaultSigner = await ethers.getSigner(vaultAddress);

        await expect(
          fundRouter.connect(vaultSigner).receiveFundsFromVault(parseUnits("1000", 18), { gasLimit: 500000 }),
        ).to.be.revertedWithCustomError(fundRouter, "OperationAlreadyCompleted");
      });

      it("reverts when router is paused", async () => {
        await time.increaseTo(params.fundraisingStartTime);
        await depositInFundraising(alice, parseUnits("2000", 18));
        await fundRouter.pause();

        await expect(vault.closeFundraising()).to.be.revertedWith("Pausable: paused");
      });
    });
  });

  // ══════════════════════════════════════════════════
  //  Step 2: setCeffuAddressForVault()
  // ══════════════════════════════════════════════════

  describe("setCeffuAddressForVault()", () => {
    beforeEach(async () => {
      await advanceToPendingFill();
    });

    describe("Happy path", () => {
      it("sets ceffu sub-wallet address", async () => {
        await fundRouter.setCeffuAddressForVault(vaultAddress, ceffuWallet.address);

        const alloc = await fundRouter.getVaultAllocation(vaultAddress);
        expect(alloc.ceffuSubWalletAddress).to.equal(ceffuWallet.address);
      });

      it("emits CeffuAddressSet event", async () => {
        await expect(fundRouter.setCeffuAddressForVault(vaultAddress, ceffuWallet.address))
          .to.emit(fundRouter, "CeffuAddressSet")
          .withArgs(vaultAddress, ceffuWallet.address);
      });

      it("allows updating ceffu address (no idempotency guard)", async () => {
        await fundRouter.setCeffuAddressForVault(vaultAddress, ceffuWallet.address);
        await fundRouter.setCeffuAddressForVault(vaultAddress, bob.address);

        const alloc = await fundRouter.getVaultAllocation(vaultAddress);
        expect(alloc.ceffuSubWalletAddress).to.equal(bob.address);
      });
    });

    describe("Reverts", () => {
      it("reverts when ACM denies access", async () => {
        acm.isAllowedToCall.returns(false);
        await expect(
          fundRouter.setCeffuAddressForVault(vaultAddress, ceffuWallet.address),
        ).to.be.revertedWithCustomError(fundRouter, "Unauthorized");
      });

      it("reverts with ZeroAddressNotAllowed for zero vault", async () => {
        await expect(
          fundRouter.setCeffuAddressForVault(ethers.constants.AddressZero, ceffuWallet.address),
        ).to.be.revertedWithCustomError(fundRouter, "ZeroAddressNotAllowed");
      });

      it("reverts with ZeroAddressNotAllowed for zero ceffuAddress", async () => {
        await expect(
          fundRouter.setCeffuAddressForVault(vaultAddress, ethers.constants.AddressZero),
        ).to.be.revertedWithCustomError(fundRouter, "ZeroAddressNotAllowed");
      });

      it("reverts with AllocationNotFound when no funds received", async () => {
        // bob.address has no allocation
        await expect(fundRouter.setCeffuAddressForVault(bob.address, ceffuWallet.address))
          .to.be.revertedWithCustomError(fundRouter, "AllocationNotFound")
          .withArgs(bob.address);
      });
    });
  });

  // ══════════════════════════════════════════════════
  //  Step 3: transferToCeffu()
  // ══════════════════════════════════════════════════

  describe("transferToCeffu()", () => {
    describe("Happy path", () => {
      it("transfers tokens to ceffu wallet", async () => {
        await advanceToPendingFill();
        await fundRouter.setCeffuAddressForVault(vaultAddress, ceffuWallet.address);

        const ceffuBalBefore = await usdcToken.balanceOf(ceffuWallet.address);
        await fundRouter.transferToCeffu(vaultAddress);

        expect(await usdcToken.balanceOf(ceffuWallet.address)).to.equal(ceffuBalBefore.add(parseUnits("2000", 18)));
        expect(await usdcToken.balanceOf(fundRouter.address)).to.equal(0);
      });

      it("sets fundsSentToCeffu flag", async () => {
        await advanceToPendingFill();
        await fundRouter.setCeffuAddressForVault(vaultAddress, ceffuWallet.address);
        await fundRouter.transferToCeffu(vaultAddress);

        const alloc = await fundRouter.getVaultAllocation(vaultAddress);
        expect(alloc.fundsSentToCeffu).to.equal(true);
      });

      it("emits FundsTransferredToCeffu event", async () => {
        await advanceToPendingFill();
        await fundRouter.setCeffuAddressForVault(vaultAddress, ceffuWallet.address);

        await expect(fundRouter.transferToCeffu(vaultAddress))
          .to.emit(fundRouter, "FundsTransferredToCeffu")
          .withArgs(vaultAddress, ceffuWallet.address, parseUnits("2000", 18));
      });
    });

    describe("Reverts", () => {
      it("reverts when ACM denies access", async () => {
        acm.isAllowedToCall.returns(false);
        await expect(fundRouter.transferToCeffu(vaultAddress)).to.be.revertedWithCustomError(
          fundRouter,
          "Unauthorized",
        );
      });

      it("reverts with PrerequisiteNotMet when funds not received", async () => {
        // No funds received yet
        await expect(fundRouter.transferToCeffu(vaultAddress)).to.be.revertedWithCustomError(
          fundRouter,
          "PrerequisiteNotMet",
        );
      });

      it("reverts with OperationAlreadyCompleted on double call", async () => {
        await advanceToPendingFill();
        await fundRouter.setCeffuAddressForVault(vaultAddress, ceffuWallet.address);
        await fundRouter.transferToCeffu(vaultAddress);

        await expect(fundRouter.transferToCeffu(vaultAddress)).to.be.revertedWithCustomError(
          fundRouter,
          "OperationAlreadyCompleted",
        );
      });

      it("reverts with ZeroAddressNotAllowed when ceffu address not set", async () => {
        await advanceToPendingFill();
        // Skip setCeffuAddressForVault — ceffuSubWalletAddress is address(0)
        await expect(fundRouter.transferToCeffu(vaultAddress)).to.be.revertedWithCustomError(
          fundRouter,
          "ZeroAddressNotAllowed",
        );
      });

      it("reverts when router is paused", async () => {
        await advanceToPendingFill();
        await fundRouter.setCeffuAddressForVault(vaultAddress, ceffuWallet.address);
        await fundRouter.pause();

        await expect(fundRouter.transferToCeffu(vaultAddress)).to.be.revertedWith("Pausable: paused");
      });
    });
  });

  // ══════════════════════════════════════════════════
  //  Step 3.5: confirmOrderFillForVault()
  // ══════════════════════════════════════════════════

  describe("confirmOrderFillForVault()", () => {
    describe("Happy path", () => {
      it("sets orderFillConfirmed flag", async () => {
        await advanceToFundsSentToCeffu();
        await fundRouter.confirmOrderFillForVault(vaultAddress);

        const alloc = await fundRouter.getVaultAllocation(vaultAddress);
        expect(alloc.orderFillConfirmed).to.equal(true);
      });

      it("transitions vault to Locked state", async () => {
        await advanceToFundsSentToCeffu();
        await fundRouter.confirmOrderFillForVault(vaultAddress);

        expect(await vault.state()).to.equal(State.Locked);
      });

      it("sets lockStartAt and lockPeriodEndTime on vault", async () => {
        await advanceToFundsSentToCeffu();
        const tx = await fundRouter.confirmOrderFillForVault(vaultAddress);
        const block = await ethers.provider.getBlock(tx.blockNumber as number);

        expect(await vault.lockStartAt()).to.equal(block.timestamp);
        expect(await vault.lockPeriodEndTime()).to.equal(block.timestamp + params.lockPeriodDuration);
      });

      it("emits OrderFillConfirmedForVault event", async () => {
        await advanceToFundsSentToCeffu();

        await expect(fundRouter.confirmOrderFillForVault(vaultAddress))
          .to.emit(fundRouter, "OrderFillConfirmedForVault")
          .withArgs(vaultAddress);
      });
    });

    describe("Reverts", () => {
      it("reverts when ACM denies access", async () => {
        acm.isAllowedToCall.returns(false);
        await expect(fundRouter.confirmOrderFillForVault(vaultAddress)).to.be.revertedWithCustomError(
          fundRouter,
          "Unauthorized",
        );
      });

      it("reverts with PrerequisiteNotMet when funds not sent to ceffu", async () => {
        await advanceToPendingFill();
        // Skip transferToCeffu
        await expect(fundRouter.confirmOrderFillForVault(vaultAddress)).to.be.revertedWithCustomError(
          fundRouter,
          "PrerequisiteNotMet",
        );
      });

      it("reverts with OperationAlreadyCompleted on double call", async () => {
        await advanceToLocked();

        await expect(fundRouter.confirmOrderFillForVault(vaultAddress)).to.be.revertedWithCustomError(
          fundRouter,
          "OperationAlreadyCompleted",
        );
      });
    });
  });

  // ══════════════════════════════════════════════════
  //  Step 4: recordRepayment()
  // ══════════════════════════════════════════════════

  describe("recordRepayment()", () => {
    describe("Happy path", () => {
      it("records repayment amount", async () => {
        await advanceToLocked();
        const amount = parseUnits("2100", 18);
        await usdcToken.connect(owner).faucet(amount);
        await usdcToken.connect(owner).transfer(fundRouter.address, amount);

        await fundRouter.recordRepayment(vaultAddress, amount);

        const alloc = await fundRouter.getVaultAllocation(vaultAddress);
        expect(alloc.repaymentAmount).to.equal(amount);
        expect(alloc.repaymentReceived).to.equal(true);
      });

      it("emits RepaymentRecorded event", async () => {
        await advanceToLocked();
        const amount = parseUnits("2100", 18);
        await usdcToken.connect(owner).faucet(amount);
        await usdcToken.connect(owner).transfer(fundRouter.address, amount);

        await expect(fundRouter.recordRepayment(vaultAddress, amount))
          .to.emit(fundRouter, "RepaymentRecorded")
          .withArgs(vaultAddress, amount);
      });
    });

    describe("Reverts", () => {
      it("reverts when ACM denies access", async () => {
        acm.isAllowedToCall.returns(false);
        await expect(fundRouter.recordRepayment(vaultAddress, parseUnits("2100", 18))).to.be.revertedWithCustomError(
          fundRouter,
          "Unauthorized",
        );
      });

      it("reverts with ZeroAmount", async () => {
        await advanceToLocked();
        await expect(fundRouter.recordRepayment(vaultAddress, 0)).to.be.revertedWithCustomError(
          fundRouter,
          "ZeroAmount",
        );
      });

      it("reverts with PrerequisiteNotMet when order fill not confirmed", async () => {
        await advanceToFundsSentToCeffu();
        // Skip confirmOrderFillForVault
        await expect(fundRouter.recordRepayment(vaultAddress, parseUnits("2100", 18))).to.be.revertedWithCustomError(
          fundRouter,
          "PrerequisiteNotMet",
        );
      });

      it("reverts with OperationAlreadyCompleted on double call", async () => {
        await advanceToRepaymentRecorded();

        await expect(fundRouter.recordRepayment(vaultAddress, parseUnits("100", 18))).to.be.revertedWithCustomError(
          fundRouter,
          "OperationAlreadyCompleted",
        );
      });
    });
  });

  // ══════════════════════════════════════════════════
  //  Step 5: distributeRepaymentToVault()
  // ══════════════════════════════════════════════════

  describe("distributeRepaymentToVault()", () => {
    const repayment = parseUnits("2100", 18);

    describe("Happy path", () => {
      it("transfers tokens to vault and sets flag", async () => {
        await advanceToRepaymentRecorded(repayment);

        await fundRouter.distributeRepaymentToVault(vaultAddress);

        expect(await usdcToken.balanceOf(vaultAddress)).to.equal(repayment);
        const alloc = await fundRouter.getVaultAllocation(vaultAddress);
        expect(alloc.repaymentDistributed).to.equal(true);
      });

      it("transitions vault to Matured state", async () => {
        await advanceToRepaymentRecorded(repayment);
        await fundRouter.distributeRepaymentToVault(vaultAddress);

        expect(await vault.state()).to.equal(State.Matured);
      });

      it("sets totalRepayment and protocolReserve on vault", async () => {
        await advanceToRepaymentRecorded(repayment);
        await fundRouter.distributeRepaymentToVault(vaultAddress);

        expect(await vault.totalRepayment()).to.equal(repayment);
        // grossInterest=100, protocolReserve = 100 * 1000 / 10000 = 10
        expect(await vault.protocolReserve()).to.equal(parseUnits("10", 18));
      });

      it("emits RepaymentDistributed event", async () => {
        await advanceToRepaymentRecorded(repayment);

        await expect(fundRouter.distributeRepaymentToVault(vaultAddress))
          .to.emit(fundRouter, "RepaymentDistributed")
          .withArgs(vaultAddress, repayment);
      });
    });

    describe("Reverts", () => {
      it("reverts when ACM denies access", async () => {
        acm.isAllowedToCall.returns(false);
        await expect(fundRouter.distributeRepaymentToVault(vaultAddress)).to.be.revertedWithCustomError(
          fundRouter,
          "Unauthorized",
        );
      });

      it("reverts with PrerequisiteNotMet when repayment not recorded", async () => {
        await advanceToLocked();
        await expect(fundRouter.distributeRepaymentToVault(vaultAddress)).to.be.revertedWithCustomError(
          fundRouter,
          "PrerequisiteNotMet",
        );
      });

      it("reverts with OperationAlreadyCompleted on double call", async () => {
        await advanceToRepaymentRecorded(repayment);
        await fundRouter.distributeRepaymentToVault(vaultAddress);

        await expect(fundRouter.distributeRepaymentToVault(vaultAddress)).to.be.revertedWithCustomError(
          fundRouter,
          "OperationAlreadyCompleted",
        );
      });

      it("reverts when router is paused", async () => {
        await advanceToRepaymentRecorded(repayment);
        await fundRouter.pause();

        await expect(fundRouter.distributeRepaymentToVault(vaultAddress)).to.be.revertedWith("Pausable: paused");
      });
    });
  });

  // ══════════════════════════════════════════════════
  //  End-to-end flow
  // ══════════════════════════════════════════════════

  describe("Complete flow (Fundraising → Matured)", () => {
    it("full 6-step cycle with token balance verification", async () => {
      const depositAmount = parseUnits("2000", 18);
      const repaymentAmount = parseUnits("2100", 18);

      // Step 0: Deposit
      await time.increaseTo(params.fundraisingStartTime);
      await depositInFundraising(alice, depositAmount);
      expect(await usdcToken.balanceOf(vaultAddress)).to.equal(depositAmount);

      // Step 1: Close fundraising → receiveFundsFromVault
      await vault.closeFundraising();
      expect(await vault.state()).to.equal(State.PendingFill);
      expect(await usdcToken.balanceOf(fundRouter.address)).to.equal(depositAmount);
      expect(await usdcToken.balanceOf(vaultAddress)).to.equal(0);

      // Step 2: Set ceffu address
      await fundRouter.setCeffuAddressForVault(vaultAddress, ceffuWallet.address);

      // Step 3: Transfer to ceffu
      await fundRouter.transferToCeffu(vaultAddress);
      expect(await usdcToken.balanceOf(ceffuWallet.address)).to.equal(depositAmount);
      expect(await usdcToken.balanceOf(fundRouter.address)).to.equal(0);

      // Step 3.5: Confirm order fill → vault Locked
      await fundRouter.confirmOrderFillForVault(vaultAddress);
      expect(await vault.state()).to.equal(State.Locked);

      // Step 4: Ceffu sends repayment to router, backend records it
      await usdcToken.connect(owner).faucet(repaymentAmount);
      await usdcToken.connect(owner).transfer(fundRouter.address, repaymentAmount);
      await fundRouter.recordRepayment(vaultAddress, repaymentAmount);

      // Step 5: Distribute repayment to vault → Matured
      await fundRouter.distributeRepaymentToVault(vaultAddress);
      expect(await vault.state()).to.equal(State.Matured);
      expect(await usdcToken.balanceOf(vaultAddress)).to.equal(repaymentAmount);

      // Verify user can redeem
      const shares = await vault.balanceOf(alice.address);
      const expectedAssets = await vault.previewRedeem(shares);
      const balBefore = await usdcToken.balanceOf(alice.address);
      await vault.connect(alice).redeem(shares, alice.address, alice.address);
      expect(await usdcToken.balanceOf(alice.address)).to.equal(balBefore.add(expectedAssets));
    });

    it("full flow with multiple depositors", async () => {
      await time.increaseTo(params.fundraisingStartTime);
      await depositInFundraising(alice, parseUnits("2000", 18));
      await depositInFundraising(bob, parseUnits("1000", 18));

      // Complete flow
      await vault.closeFundraising();
      await fundRouter.setCeffuAddressForVault(vaultAddress, ceffuWallet.address);
      await fundRouter.transferToCeffu(vaultAddress);
      await fundRouter.confirmOrderFillForVault(vaultAddress);

      const repayment = parseUnits("3150", 18);
      await usdcToken.connect(owner).faucet(repayment);
      await usdcToken.connect(owner).transfer(fundRouter.address, repayment);
      await fundRouter.recordRepayment(vaultAddress, repayment);
      await fundRouter.distributeRepaymentToVault(vaultAddress);

      expect(await vault.state()).to.equal(State.Matured);
      expect(await vault.totalRepayment()).to.equal(repayment);
      // totalPrincipal=3000, grossInterest=150, protocolReserve=15
      expect(await vault.protocolReserve()).to.equal(parseUnits("15", 18));
    });

    it("full flow with loss scenario (repayment < principal)", async () => {
      await time.increaseTo(params.fundraisingStartTime);
      await depositInFundraising(alice, parseUnits("2000", 18));

      await vault.closeFundraising();
      await fundRouter.setCeffuAddressForVault(vaultAddress, ceffuWallet.address);
      await fundRouter.transferToCeffu(vaultAddress);
      await fundRouter.confirmOrderFillForVault(vaultAddress);

      // Partial repayment (loss)
      const repayment = parseUnits("1500", 18);
      await usdcToken.connect(owner).faucet(repayment);
      await usdcToken.connect(owner).transfer(fundRouter.address, repayment);
      await fundRouter.recordRepayment(vaultAddress, repayment);
      await fundRouter.distributeRepaymentToVault(vaultAddress);

      expect(await vault.state()).to.equal(State.Matured);
      expect(await vault.totalRepayment()).to.equal(repayment);
      // No interest → no protocol reserve
      expect(await vault.protocolReserve()).to.equal(0);
    });
  });

  // ══════════════════════════════════════════════════
  //  getVaultAllocation() view
  // ══════════════════════════════════════════════════

  describe("getVaultAllocation()", () => {
    it("returns default values for unknown vault", async () => {
      const alloc = await fundRouter.getVaultAllocation(alice.address);

      expect(alloc.supplyAsset).to.equal(ethers.constants.AddressZero);
      expect(alloc.fundsReceivedFromVault).to.equal(false);
      expect(alloc.fundsSentToCeffu).to.equal(false);
      expect(alloc.orderFillConfirmed).to.equal(false);
      expect(alloc.repaymentReceived).to.equal(false);
      expect(alloc.repaymentDistributed).to.equal(false);
      expect(alloc.ceffuSubWalletAddress).to.equal(ethers.constants.AddressZero);
      expect(alloc.principalAmount).to.equal(0);
      expect(alloc.repaymentAmount).to.equal(0);
    });

    it("returns complete state after full flow", async () => {
      const repayment = parseUnits("2100", 18);
      await advanceToRepaymentRecorded(repayment);
      await fundRouter.distributeRepaymentToVault(vaultAddress);

      const alloc = await fundRouter.getVaultAllocation(vaultAddress);
      expect(alloc.supplyAsset).to.equal(usdcToken.address);
      expect(alloc.fundsReceivedFromVault).to.equal(true);
      expect(alloc.fundsSentToCeffu).to.equal(true);
      expect(alloc.orderFillConfirmed).to.equal(true);
      expect(alloc.repaymentReceived).to.equal(true);
      expect(alloc.repaymentDistributed).to.equal(true);
      expect(alloc.ceffuSubWalletAddress).to.equal(ceffuWallet.address);
      expect(alloc.principalAmount).to.equal(parseUnits("2000", 18));
      expect(alloc.repaymentAmount).to.equal(repayment);
    });
  });
});
