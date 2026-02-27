import { FakeContract, smock } from "@defi-wonderland/smock";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import chai from "chai";
import { BigNumber } from "ethers";
import { parseUnits } from "ethers/lib/utils";
import { ethers } from "hardhat";

import {
  FixedRateVault,
  FundRouter,
  IAccessControlManagerV8,
  MockToken,
  VaultFactory,
} from "../../../../typechain";
import { VaultInitParams, defaultVaultParams, deployFullSystemFixture } from "../fixtures";

const { expect } = chai;
chai.use(smock.matchers);

describe("FixedRateVault - Deposits", () => {
  let owner: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let treasury: SignerWithAddress;
  let acm: FakeContract<IAccessControlManagerV8>;
  let usdcToken: MockToken;
  let fundRouter: FundRouter;
  let factory: VaultFactory;
  let vault: FixedRateVault;
  let vaultAddress: string;
  let params: VaultInitParams;

  beforeEach(async () => {
    ({ owner, alice, bob, treasury, acm, usdcToken, fundRouter, factory, vault, vaultAddress, params } =
      await loadFixture(deployFullSystemFixture));
    acm.isAllowedToCall.returns(true);
  });

  // ── Helpers ──────────────────────────────────────

  /** Advance block time into the active fundraising window */
  async function startFundraising(): Promise<void> {
    await time.increaseTo(params.fundraisingStartTime);
  }

  /** Approve vault and deposit in one call; returns the deposit tx */
  async function approveAndDeposit(
    user: SignerWithAddress,
    amount: BigNumber,
  ): Promise<ReturnType<FixedRateVault["deposit"]>> {
    await usdcToken.connect(user).approve(vault.address, amount);
    return vault.connect(user).deposit(amount, user.address);
  }

  // ── deposit() ────────────────────────────────────

  describe("deposit()", () => {
    describe("Happy path", () => {
      beforeEach(async () => {
        await startFundraising();
      });

      it("mints shares 1:1 and transfers tokens from caller to vault", async () => {
        const depositAmount = parseUnits("1000", 18);
        await usdcToken.connect(alice).approve(vault.address, depositAmount);

        const aliceBalBefore = await usdcToken.balanceOf(alice.address);
        const vaultBalBefore = await usdcToken.balanceOf(vaultAddress);

        await vault.connect(alice).deposit(depositAmount, alice.address);

        // Shares minted 1:1
        expect(await vault.balanceOf(alice.address)).to.equal(depositAmount);
        // Tokens transferred
        expect(await usdcToken.balanceOf(alice.address)).to.equal(aliceBalBefore.sub(depositAmount));
        expect(await usdcToken.balanceOf(vaultAddress)).to.equal(vaultBalBefore.add(depositAmount));
      });

      it("updates userDeposits and totalPrincipal", async () => {
        const depositAmount = parseUnits("1000", 18);
        await approveAndDeposit(alice, depositAmount);

        expect(await vault.userDeposits(alice.address)).to.equal(depositAmount);
        expect(await vault.totalPrincipal()).to.equal(depositAmount);
      });

      it("allows multiple deposits from the same user", async () => {
        const first = parseUnits("500", 18);
        const second = parseUnits("300", 18);

        await approveAndDeposit(alice, first);
        await approveAndDeposit(alice, second);

        expect(await vault.userDeposits(alice.address)).to.equal(first.add(second));
        expect(await vault.balanceOf(alice.address)).to.equal(first.add(second));
        expect(await vault.totalPrincipal()).to.equal(first.add(second));
      });

      it("allows deposits from multiple users", async () => {
        const aliceAmt = parseUnits("1000", 18);
        const bobAmt = parseUnits("2000", 18);

        await approveAndDeposit(alice, aliceAmt);
        await approveAndDeposit(bob, bobAmt);

        expect(await vault.userDeposits(alice.address)).to.equal(aliceAmt);
        expect(await vault.userDeposits(bob.address)).to.equal(bobAmt);
        expect(await vault.totalPrincipal()).to.equal(aliceAmt.add(bobAmt));
      });

      it("accepts deposit exactly equal to minUserDeposit", async () => {
        const minDep = parseUnits("100", 18);
        await approveAndDeposit(alice, minDep);

        expect(await vault.userDeposits(alice.address)).to.equal(minDep);
      });

      it("accepts deposit exactly equal to maxUserDeposit", async () => {
        const maxDep = parseUnits("5000", 18);
        await approveAndDeposit(alice, maxDep);

        expect(await vault.userDeposits(alice.address)).to.equal(maxDep);
      });

      it("allows depositing on behalf of another user (caller != receiver)", async () => {
        const amount = parseUnits("500", 18);
        await usdcToken.connect(alice).approve(vault.address, amount);

        await vault.connect(alice).deposit(amount, bob.address);

        // Shares go to bob (receiver), not alice (caller)
        expect(await vault.balanceOf(bob.address)).to.equal(amount);
        expect(await vault.balanceOf(alice.address)).to.equal(0);
        // Deposit tracked against receiver
        expect(await vault.userDeposits(bob.address)).to.equal(amount);
      });

      it("allows small subsequent deposit once minUserDeposit is met", async () => {
        // First deposit meets minimum (100)
        await approveAndDeposit(alice, parseUnits("100", 18));

        // Second deposit is below min individually, but cumulative 110 >= 100
        await approveAndDeposit(alice, parseUnits("10", 18));

        expect(await vault.userDeposits(alice.address)).to.equal(parseUnits("110", 18));
      });

      it("emits ERC-4626 Deposit event", async () => {
        const amount = parseUnits("1000", 18);
        await usdcToken.connect(alice).approve(vault.address, amount);

        await expect(vault.connect(alice).deposit(amount, alice.address))
          .to.emit(vault, "Deposit")
          .withArgs(alice.address, alice.address, amount, amount);
      });
    });

    describe("Revert conditions", () => {
      it("reverts before fundraising start time", async () => {
        // Don't advance time — maxDeposit returns 0 before start
        const amount = parseUnits("1000", 18);
        await usdcToken.connect(alice).approve(vault.address, amount);

        await expect(
          vault.connect(alice).deposit(amount, alice.address),
        ).to.be.revertedWith("ERC4626: deposit more than max");
      });

      it("reverts after fundraising end time", async () => {
        await time.increaseTo(params.fundraisingEndTime);

        const amount = parseUnits("1000", 18);
        await usdcToken.connect(alice).approve(vault.address, amount);

        await expect(
          vault.connect(alice).deposit(amount, alice.address),
        ).to.be.revertedWith("ERC4626: deposit more than max");
      });

      it("reverts when vault is not in Fundraising state", async () => {
        await vault.cancelVault();

        const amount = parseUnits("1000", 18);
        await usdcToken.connect(alice).approve(vault.address, amount);

        await expect(
          vault.connect(alice).deposit(amount, alice.address),
        ).to.be.revertedWith("ERC4626: deposit more than max");
      });

      it("reverts below cumulative minUserDeposit", async () => {
        await startFundraising();

        const belowMin = parseUnits("50", 18);
        await usdcToken.connect(alice).approve(vault.address, belowMin);

        await expect(vault.connect(alice).deposit(belowMin, alice.address))
          .to.be.revertedWithCustomError(vault, "BelowMinUserDeposit")
          .withArgs(belowMin, parseUnits("100", 18));
      });

      it("reverts when deposit exceeds maxDeposit (per-user cap)", async () => {
        await startFundraising();

        // maxUserDeposit = 5000, try 6000
        const overMax = parseUnits("6000", 18);
        await usdcToken.connect(alice).approve(vault.address, overMax);

        await expect(
          vault.connect(alice).deposit(overMax, alice.address),
        ).to.be.revertedWith("ERC4626: deposit more than max");
      });

      it("reverts when vault is paused", async () => {
        await startFundraising();
        await vault.pause();

        const amount = parseUnits("1000", 18);
        await usdcToken.connect(alice).approve(vault.address, amount);

        // whenNotPaused modifier fires before ERC4626 maxDeposit check
        await expect(
          vault.connect(alice).deposit(amount, alice.address),
        ).to.be.revertedWith("Pausable: paused");
      });

      it("reverts with insufficient ERC20 allowance", async () => {
        await startFundraising();
        // No approve call

        const amount = parseUnits("1000", 18);

        await expect(
          vault.connect(alice).deposit(amount, alice.address),
        ).to.be.revertedWith("ERC20: insufficient allowance");
      });
    });

    describe("Auto-close on maxCap", () => {
      beforeEach(async () => {
        await startFundraising();
      });

      it("transitions to PendingFill when deposits reach maxCap", async () => {
        // maxCap = 10000, maxUserDeposit = 5000 → need two users
        await approveAndDeposit(alice, parseUnits("5000", 18));
        await approveAndDeposit(bob, parseUnits("5000", 18));

        // VaultState.PendingFill = 1
        expect(await vault.state()).to.equal(1);
      });

      it("transfers all funds to FundRouter on auto-close", async () => {
        await approveAndDeposit(alice, parseUnits("5000", 18));

        const routerBalBefore = await usdcToken.balanceOf(fundRouter.address);
        await approveAndDeposit(bob, parseUnits("5000", 18));

        const totalRaised = parseUnits("10000", 18);
        expect(await usdcToken.balanceOf(fundRouter.address)).to.equal(routerBalBefore.add(totalRaised));
        expect(await usdcToken.balanceOf(vaultAddress)).to.equal(0);
      });

      it("records allocation in FundRouter on auto-close", async () => {
        await approveAndDeposit(alice, parseUnits("5000", 18));
        await approveAndDeposit(bob, parseUnits("5000", 18));

        const allocation = await fundRouter.getVaultAllocation(vaultAddress);
        expect(allocation.fundsReceivedFromVault).to.be.true;
        expect(allocation.supplyAsset).to.equal(usdcToken.address);
        expect(allocation.principalAmount).to.equal(parseUnits("10000", 18));
      });

      it("emits FundraisingClosed event on auto-close", async () => {
        await approveAndDeposit(alice, parseUnits("5000", 18));

        const totalRaised = parseUnits("10000", 18);

        await expect(approveAndDeposit(bob, parseUnits("5000", 18)))
          .to.emit(vault, "FundraisingClosed")
          .withArgs(totalRaised);
      });
    });
  });

  // ── mint() ───────────────────────────────────────

  describe("mint()", () => {
    it("mints exact shares and pulls correct assets (1:1 ratio)", async () => {
      await startFundraising();

      const shares = parseUnits("1000", 18);
      await usdcToken.connect(alice).approve(vault.address, shares);

      await vault.connect(alice).mint(shares, alice.address);

      expect(await vault.balanceOf(alice.address)).to.equal(shares);
      expect(await vault.userDeposits(alice.address)).to.equal(shares);
    });

    it("reverts when vault is paused", async () => {
      await startFundraising();
      await vault.pause();

      const shares = parseUnits("1000", 18);
      await usdcToken.connect(alice).approve(vault.address, shares);

      // whenNotPaused modifier fires before ERC4626 maxMint check
      await expect(
        vault.connect(alice).mint(shares, alice.address),
      ).to.be.revertedWith("Pausable: paused");
    });
  });

  // ── maxDeposit() ─────────────────────────────────

  describe("maxDeposit()", () => {
    it("returns correct amount during active fundraising", async () => {
      await startFundraising();

      // globalRemaining = 10000, userRemaining = 5000 → min = 5000
      expect(await vault.maxDeposit(alice.address)).to.equal(parseUnits("5000", 18));
    });

    it("returns 0 before fundraising starts", async () => {
      expect(await vault.maxDeposit(alice.address)).to.equal(0);
    });

    it("returns 0 after fundraising ends", async () => {
      await time.increaseTo(params.fundraisingEndTime);
      expect(await vault.maxDeposit(alice.address)).to.equal(0);
    });

    it("returns 0 when paused", async () => {
      await startFundraising();
      await vault.pause();
      expect(await vault.maxDeposit(alice.address)).to.equal(0);
    });

    it("returns 0 when not in Fundraising state", async () => {
      await vault.cancelVault();
      expect(await vault.maxDeposit(alice.address)).to.equal(0);
    });

    it("decreases after user deposits (per-user maxUserDeposit)", async () => {
      await startFundraising();
      await approveAndDeposit(alice, parseUnits("2000", 18));

      // userRemaining = 5000 - 2000 = 3000, globalRemaining = 8000 → min = 3000
      expect(await vault.maxDeposit(alice.address)).to.equal(parseUnits("3000", 18));
    });

    it("accounts for global maxCap remaining", async () => {
      await startFundraising();

      await approveAndDeposit(alice, parseUnits("5000", 18));
      await approveAndDeposit(bob, parseUnits("4500", 18));

      // globalRemaining = 10000 - 9500 = 500, treasury's userRemaining = 5000 → min = 500
      expect(await vault.maxDeposit(treasury.address)).to.equal(parseUnits("500", 18));
    });

    it("returns 0 when remaining capacity < minUserDeposit for new user", async () => {
      await startFundraising();

      await approveAndDeposit(alice, parseUnits("5000", 18));
      await approveAndDeposit(bob, parseUnits("4950", 18));

      // globalRemaining = 50, treasury needs minUserDeposit = 100 → 50 < 100 → 0
      expect(await vault.maxDeposit(treasury.address)).to.equal(0);
    });

    it("returns full maxCap when maxUserDeposit is 0 (no per-user limit)", async () => {
      // Deploy a new vault with no per-user limits
      const noLimitParams = await defaultVaultParams(usdcToken.address, {
        ceffuRequestId: "CR-NO-LIMIT",
        maxUserDeposit: "0",
        minUserDeposit: "0",
      });
      await factory.deployVault(noLimitParams);
      const noLimitVaultAddr = await factory.vaultByCeffuRequestId("CR-NO-LIMIT");
      const noLimitVault = (await ethers.getContractAt("FixedRateVault", noLimitVaultAddr)) as FixedRateVault;

      await time.increaseTo(noLimitParams.fundraisingStartTime);

      // maxUserDeposit = 0 → userRemaining = uint256.max → returns globalRemaining = maxCap
      expect(await noLimitVault.maxDeposit(alice.address)).to.equal(parseUnits("10000", 18));
    });
  });

  // ── maxMint() ────────────────────────────────────

  describe("maxMint()", () => {
    it("returns shares equivalent of maxDeposit (1:1 during Fundraising)", async () => {
      await startFundraising();

      const maxDep = await vault.maxDeposit(alice.address);
      const maxMnt = await vault.maxMint(alice.address);

      expect(maxMnt).to.equal(maxDep);
    });
  });

  // ── previewDeposit() / previewMint() ─────────────

  describe("previewDeposit() / previewMint()", () => {
    it("previewDeposit returns 1:1 during Fundraising", async () => {
      const amount = parseUnits("1000", 18);
      expect(await vault.previewDeposit(amount)).to.equal(amount);
    });

    it("previewMint returns 1:1 during Fundraising", async () => {
      const shares = parseUnits("1000", 18);
      expect(await vault.previewMint(shares)).to.equal(shares);
    });
  });
});
