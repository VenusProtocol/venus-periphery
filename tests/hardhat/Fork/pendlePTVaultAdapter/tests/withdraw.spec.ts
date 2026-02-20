import "@nomicfoundation/hardhat-chai-matchers";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import chai from "chai";
import { parseUnits } from "ethers/lib/utils";
import { ethers } from "hardhat";

import { FORK_MAINNET, forking } from "../../utils";
import { BLOCK_NUMBER, BSC_CHAIN_ID, FAKE_MARKET, PT_CLISBNBX_25JUN2026, SLISBNB, WBNB } from "../utils/constants";
import { depositedFixture } from "../utils/fixtures";
import { getDummyLimitOrderData, getDummyTokenOutput } from "../utils/helpers";
import { getPendlePtToTokenParams } from "../utils/pendleApi";

const { expect } = chai;

function describeTests() {
  describe("PendlePTVaultAdapter - Withdraw", () => {
    // ── Happy Path ────────────────────────────────────────────────────
    //
    // Withdraw flow: vTokens -> redeem from Venus -> PT -> swap via Pendle AMM -> tokenOut
    //
    // Routing:
    //   tokenOut in tokensRedeemSy (slisBNB): PT -> AMM sell -> SY -> SY.redeem() -> tokenOut
    //   tokenOut NOT in tokensRedeemSy (WBNB, BNB): PT -> AMM sell -> SY -> slisBNB -> [Aggregator] -> tokenOut

    describe("withdraw happy path", () => {
      // slisBNB is the ONLY token in this market's tokensRedeemSy.
      // SY can directly redeem to slisBNB without any aggregator.
      it("should withdraw to slisBNB (direct redeemSy token) -- no aggregator", async () => {
        const { adapter, user, slisbnb, vToken, ptToken, marketAddress, depositPtAmount, depositVTokenAmount } =
          await loadFixture(depositedFixture);

        // Use 1/3 of vTokens
        const withdrawVTokenAmount = depositVTokenAmount.div(3);

        // Estimate PT from vToken redemption (ratio preserved, no interest accrued)
        const estimatedPt = withdrawVTokenAmount.mul(depositPtAmount).div(depositVTokenAmount);

        // Fetch withdraw params from Pendle API
        const { tokenOutput, limitOrderData } = await getPendlePtToTokenParams(
          BSC_CHAIN_ID,
          PT_CLISBNBX_25JUN2026,
          SLISBNB,
          estimatedPt,
          user.address,
          0.03,
          false, // no aggregator needed -- slisBNB is in tokensRedeemSy
        );

        // Verify API returned direct redeem path
        expect(tokenOutput.tokenOut.toLowerCase()).to.equal(SLISBNB.toLowerCase());
        expect(tokenOutput.tokenRedeemSy.toLowerCase()).to.equal(SLISBNB.toLowerCase());
        expect(tokenOutput.pendleSwap).to.equal(ethers.constants.AddressZero);
        expect(tokenOutput.swapData.swapType).to.equal(0);

        // Record balances before withdraw
        const userSlisbnbBefore = await slisbnb.balanceOf(user.address);
        const userVTokenBefore = await vToken.balanceOf(user.address);
        const userPtBefore = await ptToken.balanceOf(user.address);

        // Execute withdraw (delegation already active from depositedFixture)
        const tx = await adapter
          .connect(user)
          .withdraw(marketAddress, withdrawVTokenAmount, tokenOutput, limitOrderData);
        const receipt = await tx.wait();

        // Record balances after withdraw
        const userSlisbnbAfter = await slisbnb.balanceOf(user.address);
        const userVTokenAfter = await vToken.balanceOf(user.address);
        const userPtAfter = await ptToken.balanceOf(user.address);

        const slisbnbReceived = userSlisbnbAfter.sub(userSlisbnbBefore);
        const vTokensRedeemed = userVTokenBefore.sub(userVTokenAfter);

        // Assert user balance changes
        expect(vTokensRedeemed).to.equal(withdrawVTokenAmount);
        expect(slisbnbReceived).to.be.gt(0);
        expect(slisbnbReceived).to.be.gte(tokenOutput.minTokenOut);
        expect(userPtAfter).to.equal(userPtBefore); // No PT leaked

        // Assert adapter holds zero balances (stateless)
        expect(await slisbnb.balanceOf(adapter.address)).to.equal(0);
        expect(await ptToken.balanceOf(adapter.address)).to.equal(0);
        expect(await vToken.balanceOf(adapter.address)).to.equal(0);

        // Verify Withdrawn event
        const withdrawnEvent = receipt.events?.find((e: any) => e.event === "Withdrawn");
        expect(withdrawnEvent).to.not.be.undefined;

        const args = withdrawnEvent!.args!;
        expect(args.pendleMarket).to.equal(marketAddress);
        expect(args.user).to.equal(user.address);
        expect(args.vTokenAmount).to.equal(withdrawVTokenAmount);
        expect(args.ptAmount).to.be.gt(0);
        expect(args.tokenOut).to.equal(SLISBNB);
        expect(args.amountOut).to.equal(slisbnbReceived);
      });

      // WBNB is NOT in tokensRedeemSy -- requires aggregator routing.
      // Flow: vTokens -> redeem -> PT -> AMM sell -> SY -> slisBNB -> [Aggregator] -> WBNB
      it("should withdraw to WBNB (aggregator-routed) -- not in tokensRedeemSy", async () => {
        const { adapter, user, wbnb, slisbnb, vToken, ptToken, marketAddress, depositPtAmount, depositVTokenAmount } =
          await loadFixture(depositedFixture);

        const withdrawVTokenAmount = depositVTokenAmount.div(3);
        const estimatedPt = withdrawVTokenAmount.mul(depositPtAmount).div(depositVTokenAmount);

        // Fetch withdraw params from Pendle API
        const { tokenOutput, limitOrderData } = await getPendlePtToTokenParams(
          BSC_CHAIN_ID,
          PT_CLISBNBX_25JUN2026,
          WBNB,
          estimatedPt,
          user.address,
          0.03,
          true, // aggregator required -- WBNB NOT in tokensRedeemSy
        );

        // Verify API returned aggregator-routed path
        expect(tokenOutput.tokenOut.toLowerCase()).to.equal(WBNB.toLowerCase());
        expect(tokenOutput.pendleSwap).to.not.equal(ethers.constants.AddressZero);
        expect(tokenOutput.swapData.swapType).to.equal(1);

        // Record balances before withdraw
        const userWbnbBefore = await wbnb.balanceOf(user.address);
        const userVTokenBefore = await vToken.balanceOf(user.address);
        const userPtBefore = await ptToken.balanceOf(user.address);

        // Execute withdraw (delegation already active from depositedFixture)
        const tx = await adapter
          .connect(user)
          .withdraw(marketAddress, withdrawVTokenAmount, tokenOutput, limitOrderData);
        const receipt = await tx.wait();

        // Record balances after withdraw
        const userWbnbAfter = await wbnb.balanceOf(user.address);
        const userVTokenAfter = await vToken.balanceOf(user.address);
        const userPtAfter = await ptToken.balanceOf(user.address);

        const wbnbReceived = userWbnbAfter.sub(userWbnbBefore);
        const vTokensRedeemed = userVTokenBefore.sub(userVTokenAfter);

        // Assert user balance changes
        expect(vTokensRedeemed).to.equal(withdrawVTokenAmount);
        expect(wbnbReceived).to.be.gt(0);
        expect(wbnbReceived).to.be.gte(tokenOutput.minTokenOut);
        expect(userPtAfter).to.equal(userPtBefore);

        // Assert adapter holds zero balances (stateless)
        expect(await wbnb.balanceOf(adapter.address)).to.equal(0);
        expect(await slisbnb.balanceOf(adapter.address)).to.equal(0);
        expect(await ptToken.balanceOf(adapter.address)).to.equal(0);
        expect(await vToken.balanceOf(adapter.address)).to.equal(0);

        // Verify Withdrawn event
        const withdrawnEvent = receipt.events?.find((e: any) => e.event === "Withdrawn");
        expect(withdrawnEvent).to.not.be.undefined;

        const args = withdrawnEvent!.args!;
        expect(args.pendleMarket).to.equal(marketAddress);
        expect(args.user).to.equal(user.address);
        expect(args.vTokenAmount).to.equal(withdrawVTokenAmount);
        expect(args.ptAmount).to.be.gt(0);
        expect(args.tokenOut).to.equal(WBNB);
        expect(args.amountOut).to.equal(wbnbReceived);
      });

      // Native BNB is NOT in tokensRedeemSy -- requires aggregator routing.
      // Pendle Router handles the full unwrap chain and sends native BNB to the receiver.
      it("should withdraw to native BNB -- Pendle Router handles unwrapping", async () => {
        const { adapter, user, vToken, ptToken, marketAddress, depositPtAmount, depositVTokenAmount } =
          await loadFixture(depositedFixture);

        // Use half of vTokens
        const userVTokenBalance = await vToken.balanceOf(user.address);
        const withdrawVTokenAmount = userVTokenBalance.div(2);
        const estimatedPt = withdrawVTokenAmount.mul(depositPtAmount).div(depositVTokenAmount);

        // Fetch withdraw params for native BNB output
        const NATIVE = ethers.constants.AddressZero;
        const { tokenOutput, limitOrderData } = await getPendlePtToTokenParams(
          BSC_CHAIN_ID,
          PT_CLISBNBX_25JUN2026,
          NATIVE,
          estimatedPt,
          user.address,
          0.03,
          true, // aggregator required -- native BNB not in tokensRedeemSy
        );

        // Record balances before withdraw
        const userBnbBefore = await ethers.provider.getBalance(user.address);
        const userVTokenBefore = await vToken.balanceOf(user.address);
        const userPtBefore = await ptToken.balanceOf(user.address);

        // Execute withdraw (delegation already active from depositedFixture)
        const tx = await adapter
          .connect(user)
          .withdraw(marketAddress, withdrawVTokenAmount, tokenOutput, limitOrderData);
        const receipt = await tx.wait();
        const gasUsed = receipt.gasUsed.mul(receipt.effectiveGasPrice);

        // Record balances after withdraw
        const userBnbAfter = await ethers.provider.getBalance(user.address);
        const userVTokenAfter = await vToken.balanceOf(user.address);
        const userPtAfter = await ptToken.balanceOf(user.address);

        const bnbReceived = userBnbAfter.sub(userBnbBefore).add(gasUsed);
        const vTokensRedeemed = userVTokenBefore.sub(userVTokenAfter);

        // Assert user balance changes
        expect(vTokensRedeemed).to.equal(withdrawVTokenAmount);
        expect(bnbReceived).to.be.gt(0);
        expect(userPtAfter).to.equal(userPtBefore);

        // Assert adapter holds zero balances
        expect(await ptToken.balanceOf(adapter.address)).to.equal(0);
        expect(await vToken.balanceOf(adapter.address)).to.equal(0);
        expect(await ethers.provider.getBalance(adapter.address)).to.equal(0);

        // Verify Withdrawn event
        const withdrawnEvent = receipt.events?.find((e: any) => e.event === "Withdrawn");
        expect(withdrawnEvent).to.not.be.undefined;

        const args = withdrawnEvent!.args!;
        expect(args.pendleMarket).to.equal(marketAddress);
        expect(args.user).to.equal(user.address);
        expect(args.vTokenAmount).to.equal(withdrawVTokenAmount);
        expect(args.ptAmount).to.be.gt(0);
        expect(args.tokenOut).to.equal(NATIVE);
        expect(args.amountOut).to.be.gt(0);
      });
    });

    // ── Withdraw Error Cases ──────────────────────────────────────────

    describe("withdraw error cases", () => {
      const dummyLimit = getDummyLimitOrderData();
      const withdrawAmount = parseUnits("1", 18);

      it("should revert with ZeroAmount when vTokenAmount is 0", async () => {
        const { adapter, user, marketAddress } = await loadFixture(depositedFixture);
        const output = getDummyTokenOutput(SLISBNB);

        await expect(
          adapter.connect(user).withdraw(marketAddress, 0, output, dummyLimit),
        ).to.be.revertedWithCustomError(adapter, "ZeroAmount");
      });

      it("should revert with MarketNotRegistered for unregistered market", async () => {
        const { adapter, user } = await loadFixture(depositedFixture);
        const output = getDummyTokenOutput(SLISBNB);

        await expect(adapter.connect(user).withdraw(FAKE_MARKET, withdrawAmount, output, dummyLimit))
          .to.be.revertedWithCustomError(adapter, "MarketNotRegistered")
          .withArgs(FAKE_MARKET);
      });

      it("should revert when contract is paused", async () => {
        const { adapter, owner, user, marketAddress } = await loadFixture(depositedFixture);

        await adapter.connect(owner).pause();
        const output = getDummyTokenOutput(SLISBNB);

        await expect(
          adapter.connect(user).withdraw(marketAddress, withdrawAmount, output, dummyLimit),
        ).to.be.revertedWith("Pausable: paused");
      });

      it("should revert with MarketAlreadyMatured when called after maturity", async () => {
        const { adapter, user, marketAddress } = await loadFixture(depositedFixture);

        // Time travel past maturity
        const marketConfig = await adapter.getMarketConfig(marketAddress);
        const maturity = marketConfig.maturity.toNumber();
        await time.increaseTo(maturity + 1);

        const output = getDummyTokenOutput(SLISBNB);

        await expect(
          adapter.connect(user).withdraw(marketAddress, withdrawAmount, output, dummyLimit),
        ).to.be.revertedWithCustomError(adapter, "MarketAlreadyMatured");
      });

      it("should revert when user has not delegated to adapter (redeemBehalf fails)", async () => {
        const { adapter, user, comptroller, marketAddress } = await loadFixture(depositedFixture);

        // Revoke delegation
        await comptroller.connect(user).updateDelegate(adapter.address, false);
        const output = getDummyTokenOutput(SLISBNB);

        await expect(adapter.connect(user).withdraw(marketAddress, withdrawAmount, output, dummyLimit)).to.be.reverted;
      });
    });
  });
}

// Standalone: wrap in forking(). Index runner: register directly.
if (FORK_MAINNET) {
  if ((global as any).__PENDLE_INDEX_RUNNING) {
    describeTests();
  } else {
    forking(BLOCK_NUMBER, () => {
      describeTests();
    });
  }
}
