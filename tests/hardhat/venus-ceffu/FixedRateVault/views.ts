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

const MAX_BPS = 10_000;
const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;

describe("FixedRateVault - Views", () => {
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

  async function advanceToPendingFill(): Promise<void> {
    await time.increaseTo(params.fundraisingStartTime);
    await depositInFundraising(alice, parseUnits("2000", 18));
    await vault.closeFundraising();
  }

  async function advanceToLocked(): Promise<void> {
    await advanceToPendingFill();
    await fundRouter.setCeffuAddressForVault(vaultAddress, ceffuWallet.address);
    await fundRouter.transferToCeffu(vaultAddress);
    await fundRouter.confirmOrderFillForVault(vaultAddress);
  }

  async function doRepaymentViaRouter(amount: BigNumber): Promise<void> {
    await usdcToken.connect(owner).faucet(amount);
    await usdcToken.connect(owner).transfer(fundRouter.address, amount);
    await fundRouter.recordRepayment(vaultAddress, amount);
    await fundRouter.distributeRepaymentToVault(vaultAddress);
  }

  async function advanceToMatured(repayment?: BigNumber): Promise<void> {
    await advanceToLocked();
    await doRepaymentViaRouter(repayment ?? parseUnits("2100", 18));
  }

  async function advanceToCancelled(): Promise<void> {
    await time.increaseTo(params.fundraisingStartTime);
    await depositInFundraising(alice, parseUnits("2000", 18));
    await vault.cancelVault();
  }

  // ── calculateExpectedInterest() ────────────────────

  describe("calculateExpectedInterest()", () => {
    // Formula: (principal * fixedAPY * lockPeriodDuration) / (SECONDS_PER_YEAR * MAX_BPS)
    // Default params: fixedAPY=500 (5%), lockPeriodDuration=30 days

    it("returns correct interest for a given principal", async () => {
      const principal = parseUnits("2000", 18);
      const expected = principal.mul(params.fixedAPY).mul(params.lockPeriodDuration).div(SECONDS_PER_YEAR).div(MAX_BPS);

      expect(await vault.calculateExpectedInterest(principal)).to.equal(expected);
    });

    it("returns 0 for zero principal", async () => {
      expect(await vault.calculateExpectedInterest(0)).to.equal(0);
    });

    it("returns correct interest for maxCap", async () => {
      const principal = parseUnits("10000", 18);
      const expected = principal.mul(params.fixedAPY).mul(params.lockPeriodDuration).div(SECONDS_PER_YEAR).div(MAX_BPS);

      expect(await vault.calculateExpectedInterest(principal)).to.equal(expected);
    });

    it("returns correct interest for 1 wei principal", async () => {
      // 1 * 500 * 2592000 / (31536000 * 10000) = 0 (integer division)
      expect(await vault.calculateExpectedInterest(1)).to.equal(0);
    });

    it("is callable regardless of vault state", async () => {
      const principal = parseUnits("1000", 18);
      const expected = principal.mul(params.fixedAPY).mul(params.lockPeriodDuration).div(SECONDS_PER_YEAR).div(MAX_BPS);

      // Fundraising (default)
      expect(await vault.calculateExpectedInterest(principal)).to.equal(expected);

      // Matured
      await advanceToMatured();
      expect(await vault.calculateExpectedInterest(principal)).to.equal(expected);
    });
  });

  // ── getVaultConfig() ───────────────────────────────

  describe("getVaultConfig()", () => {
    it("returns all initialization parameters correctly", async () => {
      const config = await vault.getVaultConfig();

      expect(config.supplyAsset).to.equal(usdcToken.address);
      expect(config.name).to.equal(params.name);
      expect(config.symbol).to.equal(params.symbol);
      expect(config.ceffuRequestId).to.equal("CR-0001");
      expect(config.fixedAPY).to.equal(params.fixedAPY);
      expect(config.minCap).to.equal(params.minCap);
      expect(config.maxCap).to.equal(params.maxCap);
      expect(config.fundraisingStartTime).to.equal(params.fundraisingStartTime);
      expect(config.fundraisingEndTime).to.equal(params.fundraisingEndTime);
      expect(config.lockPeriodDuration).to.equal(params.lockPeriodDuration);
      expect(config.reserveFactorBps).to.equal(params.reserveFactorBps);
      expect(config.minUserDeposit).to.equal(params.minUserDeposit);
      expect(config.maxUserDeposit).to.equal(params.maxUserDeposit);
      expect(config.gracePeriod).to.equal(params.gracePeriod);
    });

    it("is callable regardless of vault state", async () => {
      await advanceToMatured();
      const config = await vault.getVaultConfig();
      expect(config.fixedAPY).to.equal(params.fixedAPY);
    });
  });

  // ── totalAssets() ──────────────────────────────────

  describe("totalAssets()", () => {
    it("returns totalPrincipal in Fundraising state", async () => {
      // Before any deposits
      expect(await vault.totalAssets()).to.equal(0);

      // After deposit
      await time.increaseTo(params.fundraisingStartTime);
      await depositInFundraising(alice, parseUnits("2000", 18));
      expect(await vault.totalAssets()).to.equal(parseUnits("2000", 18));
    });

    it("returns totalPrincipal in PendingFill state", async () => {
      await advanceToPendingFill();
      // Funds transferred to FundRouter, but totalAssets still tracks totalPrincipal
      expect(await vault.totalAssets()).to.equal(parseUnits("2000", 18));
    });

    it("returns totalPrincipal in Locked state", async () => {
      await advanceToLocked();
      // Funds at Ceffu, vault balance=0, but totalAssets = totalPrincipal
      expect(await vault.totalAssets()).to.equal(parseUnits("2000", 18));
    });

    it("returns balance - protocolReserve in Matured state", async () => {
      // principal=2000, repayment=2100, grossInterest=100, protocolReserve=10
      await advanceToMatured(parseUnits("2100", 18));

      const balance = await usdcToken.balanceOf(vaultAddress);
      const reserve = await vault.protocolReserve();
      expect(await vault.totalAssets()).to.equal(balance.sub(reserve));
      expect(await vault.totalAssets()).to.equal(parseUnits("2090", 18));
    });

    it("returns balance in Matured state after reservesWithdrawn", async () => {
      await advanceToMatured(parseUnits("2100", 18));
      await vault.withdrawReserves(treasury.address);

      const balance = await usdcToken.balanceOf(vaultAddress);
      expect(await vault.totalAssets()).to.equal(balance);
      expect(await vault.totalAssets()).to.equal(parseUnits("2090", 18));
    });

    it("returns balance in Matured state with no interest (reserve=0)", async () => {
      await advanceToMatured(parseUnits("2000", 18));

      expect(await vault.protocolReserve()).to.equal(0);
      expect(await vault.totalAssets()).to.equal(parseUnits("2000", 18));
    });

    it("returns actual balance in Cancelled state", async () => {
      await advanceToCancelled();
      expect(await vault.totalAssets()).to.equal(parseUnits("2000", 18));
    });

    it("tracks balance in Cancelled state after partial withdrawal", async () => {
      await advanceToCancelled();

      const half = (await vault.balanceOf(alice.address)).div(2);
      await vault.connect(alice).redeem(half, alice.address, alice.address);

      // Balance decreased by half the deposit
      const balance = await usdcToken.balanceOf(vaultAddress);
      expect(await vault.totalAssets()).to.equal(balance);
    });
  });

  // ── maxRedeem() ────────────────────────────────────

  describe("maxRedeem()", () => {
    it("returns 0 in Fundraising state", async () => {
      await time.increaseTo(params.fundraisingStartTime);
      await depositInFundraising(alice, parseUnits("2000", 18));

      expect(await vault.maxRedeem(alice.address)).to.equal(0);
    });

    it("returns 0 in PendingFill state", async () => {
      await advanceToPendingFill();
      expect(await vault.maxRedeem(alice.address)).to.equal(0);
    });

    it("returns 0 in Locked state", async () => {
      await advanceToLocked();
      expect(await vault.maxRedeem(alice.address)).to.equal(0);
    });

    it("returns full share balance in Matured state", async () => {
      await advanceToMatured();
      const shares = await vault.balanceOf(alice.address);
      expect(await vault.maxRedeem(alice.address)).to.equal(shares);
    });

    it("returns full share balance in Cancelled state", async () => {
      await advanceToCancelled();
      const shares = await vault.balanceOf(alice.address);
      expect(await vault.maxRedeem(alice.address)).to.equal(shares);
    });

    it("returns 0 for address with no shares", async () => {
      await advanceToMatured();
      expect(await vault.maxRedeem(bob.address)).to.equal(0);
    });
  });

  // ── maxWithdraw() ──────────────────────────────────

  describe("maxWithdraw()", () => {
    it("returns 0 in Fundraising state", async () => {
      await time.increaseTo(params.fundraisingStartTime);
      await depositInFundraising(alice, parseUnits("2000", 18));

      expect(await vault.maxWithdraw(alice.address)).to.equal(0);
    });

    it("returns 0 in PendingFill state", async () => {
      await advanceToPendingFill();
      expect(await vault.maxWithdraw(alice.address)).to.equal(0);
    });

    it("returns 0 in Locked state", async () => {
      await advanceToLocked();
      expect(await vault.maxWithdraw(alice.address)).to.equal(0);
    });

    it("returns asset value of shares in Matured state", async () => {
      await advanceToMatured(parseUnits("2100", 18));

      const shares = await vault.balanceOf(alice.address);
      const expected = await vault.previewRedeem(shares);
      expect(await vault.maxWithdraw(alice.address)).to.equal(expected);
    });

    it("returns deposit amount in Cancelled state (1:1)", async () => {
      await advanceToCancelled();
      expect(await vault.maxWithdraw(alice.address)).to.equal(parseUnits("2000", 18));
    });

    it("returns 0 for address with no shares", async () => {
      await advanceToMatured();
      expect(await vault.maxWithdraw(bob.address)).to.equal(0);
    });
  });

  // ── previewRedeem() ────────────────────────────────

  describe("previewRedeem()", () => {
    it("returns assets with interest in Matured state", async () => {
      // principal=2000, repayment=2100, protocolReserve=10, totalAssets=2090
      await advanceToMatured(parseUnits("2100", 18));

      const shares = await vault.balanceOf(alice.address);
      const assets = await vault.previewRedeem(shares);

      // User receives more than principal (interest accrued)
      expect(assets).to.be.gt(parseUnits("2000", 18));
      // Verify actual redeem matches preview exactly
      const balBefore = await usdcToken.balanceOf(alice.address);
      await vault.connect(alice).redeem(shares, alice.address, alice.address);
      expect(await usdcToken.balanceOf(alice.address)).to.equal(balBefore.add(assets));
    });

    it("returns 1:1 in Cancelled state", async () => {
      await advanceToCancelled();

      const shares = await vault.balanceOf(alice.address);
      const assets = await vault.previewRedeem(shares);
      expect(assets).to.equal(parseUnits("2000", 18));
    });

    it("scales proportionally for partial shares", async () => {
      await advanceToMatured(parseUnits("2100", 18));

      const fullShares = await vault.balanceOf(alice.address);
      const halfShares = fullShares.div(2);

      const fullAssets = await vault.previewRedeem(fullShares);
      const halfAssets = await vault.previewRedeem(halfShares);

      // halfAssets should be approximately half of fullAssets (may differ by ±1 wei from rounding)
      expect(halfAssets).to.equal(fullAssets.div(2));
    });

    it("returns 0 for 0 shares", async () => {
      await advanceToMatured();
      expect(await vault.previewRedeem(0)).to.equal(0);
    });
  });

  // ── previewWithdraw() ──────────────────────────────

  describe("previewWithdraw()", () => {
    it("returns shares needed for given assets in Matured state", async () => {
      await advanceToMatured(parseUnits("2100", 18));

      const assets = parseUnits("1045", 18);
      const sharesNeeded = await vault.previewWithdraw(assets);

      // Verify round-trip: redeeming those shares gives back at least the requested assets
      const assetsBack = await vault.previewRedeem(sharesNeeded);
      expect(assetsBack).to.be.gte(assets);
    });

    it("returns 1:1 in Cancelled state", async () => {
      await advanceToCancelled();

      const assets = parseUnits("1000", 18);
      const sharesNeeded = await vault.previewWithdraw(assets);
      expect(sharesNeeded).to.equal(assets);
    });

    it("returns 0 for 0 assets", async () => {
      await advanceToMatured();
      expect(await vault.previewWithdraw(0)).to.equal(0);
    });
  });

  // ── Public storage getters ─────────────────────────

  describe("Public storage getters", () => {
    it("exposes all config variables after initialization", async () => {
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
      expect(await vault.fundRouter()).to.equal(fundRouter.address);
    });

    it("exposes runtime state variables", async () => {
      expect(await vault.state()).to.equal(State.Fundraising);
      expect(await vault.totalPrincipal()).to.equal(0);
      expect(await vault.totalRepayment()).to.equal(0);
      expect(await vault.protocolReserve()).to.equal(0);
      expect(await vault.reservesWithdrawn()).to.equal(false);
      expect(await vault.lockPeriodEndTime()).to.equal(0);
      expect(await vault.lockStartAt()).to.equal(0);
    });

    it("exposes userDeposits mapping", async () => {
      expect(await vault.userDeposits(alice.address)).to.equal(0);

      await time.increaseTo(params.fundraisingStartTime);
      await depositInFundraising(alice, parseUnits("2000", 18));

      expect(await vault.userDeposits(alice.address)).to.equal(parseUnits("2000", 18));
      expect(await vault.userDeposits(bob.address)).to.equal(0);
    });

    it("runtime variables update through lifecycle", async () => {
      await advanceToMatured(parseUnits("2100", 18));

      expect(await vault.state()).to.equal(State.Matured);
      expect(await vault.totalPrincipal()).to.equal(parseUnits("2000", 18));
      expect(await vault.totalRepayment()).to.equal(parseUnits("2100", 18));
      expect(await vault.protocolReserve()).to.equal(parseUnits("10", 18));
      expect(await vault.lockStartAt()).to.be.gt(0);
      expect(await vault.lockPeriodEndTime()).to.equal(
        (await vault.lockStartAt()).add(params.lockPeriodDuration),
      );
    });
  });

  // ── ERC-20 / ERC-4626 metadata ────────────────────

  describe("ERC-20 / ERC-4626 metadata", () => {
    it("returns correct name and symbol", async () => {
      expect(await vault.name()).to.equal("Venus Fixed Rate USDC #001");
      expect(await vault.symbol()).to.equal("vfrUSDC-001");
    });

    it("returns correct asset address", async () => {
      expect(await vault.asset()).to.equal(usdcToken.address);
    });

    it("returns 18 decimals (matches underlying)", async () => {
      expect(await vault.decimals()).to.equal(18);
    });

    it("totalSupply reflects minted shares", async () => {
      expect(await vault.totalSupply()).to.equal(0);

      await time.increaseTo(params.fundraisingStartTime);
      await depositInFundraising(alice, parseUnits("2000", 18));

      expect(await vault.totalSupply()).to.equal(parseUnits("2000", 18));
    });
  });
});
