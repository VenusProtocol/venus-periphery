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

describe("FundRouter - Admin", () => {
  let owner: SignerWithAddress;
  let alice: SignerWithAddress;
  let _bob: SignerWithAddress;
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
    ({
      owner,
      alice,
      bob: _bob,
      treasury,
      ceffuWallet,
      acm,
      usdcToken,
      fundRouter,
      factory,
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

  async function advanceToPendingFill(): Promise<void> {
    await time.increaseTo(params.fundraisingStartTime);
    await depositInFundraising(alice, parseUnits("2000", 18));
    await vault.closeFundraising();
  }

  // ══════════════════════════════════════════════════
  //  setAssetApproval()
  // ══════════════════════════════════════════════════

  describe("setAssetApproval()", () => {
    it("approves an asset", async () => {
      const MockTokenFactory = await ethers.getContractFactory("MockToken");
      const newToken = await MockTokenFactory.deploy("DAI", "DAI", 18);

      await fundRouter.setAssetApproval(newToken.address, true);
      expect(await fundRouter.approvedAssets(newToken.address)).to.equal(true);
    });

    it("revokes an asset", async () => {
      // usdcToken is already approved in fixture
      expect(await fundRouter.approvedAssets(usdcToken.address)).to.equal(true);

      await fundRouter.setAssetApproval(usdcToken.address, false);
      expect(await fundRouter.approvedAssets(usdcToken.address)).to.equal(false);
    });

    it("emits AssetApprovalUpdated event on approve", async () => {
      const MockTokenFactory = await ethers.getContractFactory("MockToken");
      const newToken = await MockTokenFactory.deploy("DAI", "DAI", 18);

      await expect(fundRouter.setAssetApproval(newToken.address, true))
        .to.emit(fundRouter, "AssetApprovalUpdated")
        .withArgs(newToken.address, true);
    });

    it("emits AssetApprovalUpdated event on revoke", async () => {
      await expect(fundRouter.setAssetApproval(usdcToken.address, false))
        .to.emit(fundRouter, "AssetApprovalUpdated")
        .withArgs(usdcToken.address, false);
    });

    it("reverts when ACM denies access", async () => {
      acm.isAllowedToCall.returns(false);
      await expect(fundRouter.setAssetApproval(usdcToken.address, true)).to.be.revertedWithCustomError(
        fundRouter,
        "Unauthorized",
      );
    });

    it("reverts with ZeroAddressNotAllowed for zero asset", async () => {
      await expect(fundRouter.setAssetApproval(ethers.constants.AddressZero, true)).to.be.revertedWithCustomError(
        fundRouter,
        "ZeroAddressNotAllowed",
      );
    });
  });

  // ══════════════════════════════════════════════════
  //  sweepToken()
  // ══════════════════════════════════════════════════

  describe("sweepToken()", () => {
    const sweepAmount = parseUnits("500", 18);

    beforeEach(async () => {
      // Send some tokens to the router (simulating stuck tokens)
      await usdcToken.connect(owner).faucet(sweepAmount);
      await usdcToken.connect(owner).transfer(fundRouter.address, sweepAmount);
    });

    it("transfers tokens to recipient", async () => {
      const treasuryBalBefore = await usdcToken.balanceOf(treasury.address);
      await fundRouter.sweepToken(usdcToken.address, treasury.address, sweepAmount);

      expect(await usdcToken.balanceOf(treasury.address)).to.equal(treasuryBalBefore.add(sweepAmount));
      expect(await usdcToken.balanceOf(fundRouter.address)).to.equal(0);
    });

    it("emits TokenSwept event", async () => {
      await expect(fundRouter.sweepToken(usdcToken.address, treasury.address, sweepAmount))
        .to.emit(fundRouter, "TokenSwept")
        .withArgs(usdcToken.address, treasury.address, sweepAmount);
    });

    it("allows partial sweep", async () => {
      const partial = parseUnits("200", 18);
      await fundRouter.sweepToken(usdcToken.address, treasury.address, partial);

      expect(await usdcToken.balanceOf(fundRouter.address)).to.equal(sweepAmount.sub(partial));
    });

    it("reverts when ACM denies access", async () => {
      acm.isAllowedToCall.returns(false);
      await expect(
        fundRouter.sweepToken(usdcToken.address, treasury.address, sweepAmount),
      ).to.be.revertedWithCustomError(fundRouter, "Unauthorized");
    });

    it("reverts with ZeroAddressNotAllowed for zero recipient", async () => {
      await expect(
        fundRouter.sweepToken(usdcToken.address, ethers.constants.AddressZero, sweepAmount),
      ).to.be.revertedWithCustomError(fundRouter, "ZeroAddressNotAllowed");
    });

    it("reverts with ZeroAmount for zero amount", async () => {
      await expect(fundRouter.sweepToken(usdcToken.address, treasury.address, 0)).to.be.revertedWithCustomError(
        fundRouter,
        "ZeroAmount",
      );
    });

    it("reverts when insufficient balance", async () => {
      const tooMuch = sweepAmount.add(1);
      await expect(fundRouter.sweepToken(usdcToken.address, treasury.address, tooMuch)).to.be.reverted;
    });
  });

  // ══════════════════════════════════════════════════
  //  pause() / unpause()
  // ══════════════════════════════════════════════════

  describe("pause()", () => {
    it("pauses the router", async () => {
      await fundRouter.pause();
      expect(await fundRouter.paused()).to.equal(true);
    });

    it("reverts when ACM denies access", async () => {
      acm.isAllowedToCall.returns(false);
      await expect(fundRouter.pause()).to.be.revertedWithCustomError(fundRouter, "Unauthorized");
    });

    it("reverts if already paused", async () => {
      await fundRouter.pause();
      await expect(fundRouter.pause()).to.be.revertedWith("Pausable: paused");
    });
  });

  describe("unpause()", () => {
    it("unpauses the router", async () => {
      await fundRouter.pause();
      await fundRouter.unpause();
      expect(await fundRouter.paused()).to.equal(false);
    });

    it("reverts when ACM denies access", async () => {
      await fundRouter.pause();
      acm.isAllowedToCall.returns(false);
      await expect(fundRouter.unpause()).to.be.revertedWithCustomError(fundRouter, "Unauthorized");
    });

    it("reverts if not paused", async () => {
      await expect(fundRouter.unpause()).to.be.revertedWith("Pausable: not paused");
    });
  });

  describe("Pausability effects on flow functions", () => {
    it("receiveFundsFromVault blocked when paused", async () => {
      await time.increaseTo(params.fundraisingStartTime);
      await depositInFundraising(alice, parseUnits("2000", 18));
      await fundRouter.pause();

      // vault.closeFundraising calls receiveFundsFromVault which is whenNotPaused
      await expect(vault.closeFundraising()).to.be.revertedWith("Pausable: paused");
    });

    it("transferToCeffu blocked when paused", async () => {
      await advanceToPendingFill();
      await fundRouter.setCeffuAddressForVault(vaultAddress, ceffuWallet.address);
      await fundRouter.pause();

      await expect(fundRouter.transferToCeffu(vaultAddress)).to.be.revertedWith("Pausable: paused");
    });

    it("distributeRepaymentToVault blocked when paused", async () => {
      await advanceToPendingFill();
      await fundRouter.setCeffuAddressForVault(vaultAddress, ceffuWallet.address);
      await fundRouter.transferToCeffu(vaultAddress);
      await fundRouter.confirmOrderFillForVault(vaultAddress);

      const repayment = parseUnits("2100", 18);
      await usdcToken.connect(owner).faucet(repayment);
      await usdcToken.connect(owner).transfer(fundRouter.address, repayment);
      await fundRouter.recordRepayment(vaultAddress, repayment);
      await fundRouter.pause();

      await expect(fundRouter.distributeRepaymentToVault(vaultAddress)).to.be.revertedWith("Pausable: paused");
    });

    it("setCeffuAddressForVault works when paused (no whenNotPaused)", async () => {
      await advanceToPendingFill();
      await fundRouter.pause();

      await expect(fundRouter.setCeffuAddressForVault(vaultAddress, ceffuWallet.address)).to.not.be.reverted;
    });

    it("confirmOrderFillForVault works when paused (no whenNotPaused)", async () => {
      await advanceToPendingFill();
      await fundRouter.setCeffuAddressForVault(vaultAddress, ceffuWallet.address);
      await fundRouter.transferToCeffu(vaultAddress);
      await fundRouter.pause();

      await expect(fundRouter.confirmOrderFillForVault(vaultAddress)).to.not.be.reverted;
    });

    it("recordRepayment works when paused (no whenNotPaused)", async () => {
      await advanceToPendingFill();
      await fundRouter.setCeffuAddressForVault(vaultAddress, ceffuWallet.address);
      await fundRouter.transferToCeffu(vaultAddress);
      await fundRouter.confirmOrderFillForVault(vaultAddress);

      const repayment = parseUnits("2100", 18);
      await usdcToken.connect(owner).faucet(repayment);
      await usdcToken.connect(owner).transfer(fundRouter.address, repayment);
      await fundRouter.pause();

      await expect(fundRouter.recordRepayment(vaultAddress, repayment)).to.not.be.reverted;
    });

    it("setAssetApproval works when paused (no whenNotPaused)", async () => {
      await fundRouter.pause();
      await expect(fundRouter.setAssetApproval(usdcToken.address, false)).to.not.be.reverted;
    });
  });

  // ══════════════════════════════════════════════════
  //  Storage getters
  // ══════════════════════════════════════════════════

  describe("Storage getters", () => {
    it("vaultFactory returns correct address", async () => {
      expect(await fundRouter.vaultFactory()).to.equal(factory.address);
    });

    it("approvedAssets returns true for approved asset", async () => {
      expect(await fundRouter.approvedAssets(usdcToken.address)).to.equal(true);
    });

    it("approvedAssets returns false for unknown asset", async () => {
      expect(await fundRouter.approvedAssets(alice.address)).to.equal(false);
    });
  });
});
