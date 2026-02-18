import "@nomicfoundation/hardhat-chai-matchers";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import chai from "chai";
import { parseUnits } from "ethers/lib/utils";
import { ethers } from "hardhat";

import { FORK_MAINNET, forking } from "../../utils";
import { BLOCK_NUMBER, CLISBNB, FAKE_MARKET, PT_CLISBNBX_25JUN2026 } from "../utils/constants";
import { baseFixture, maturedWithDepositsFixture } from "../utils/fixtures";
import { getDummyTokenOutput } from "../utils/helpers";
import { getPendlePtToTokenParams } from "../utils/pendleApi";

const { expect } = chai;

function describeTests() {
  describe("PendlePTVaultAdapter - RedeemAtMaturity", () => {
      // ── Happy Path ────────────────────────────────────────────────────
      //
      // RedeemAtMaturity flow:
      //   vTokens -> redeem from Venus -> PT -> redeem 1:1 via SY -> tokenOut
      //
      // Unlike withdraw (AMM sell with price impact), this is a pure 1:1
      // redemption -- no slippage from AMM. Uses redeemPyToToken() instead
      // of swapExactPtForToken(). No LimitOrderData needed.
      //
      // NOTE: Only clisBNB (direct redeemSy, no aggregator) is tested here.
      // WBNB and native BNB require aggregator routing, but aggregator calldata
      // contains embedded DEX swap deadlines that expire after ~1.5yr time travel.

      describe("redeemAtMaturity happy path", () => {
        // clisBNB is in tokensRedeemSy -- SY directly unwraps to clisBNB.
        // Flow: vTokens -> redeem -> PT -> redeemPyToToken() -> SY -> clisBNB
        it("should redeem to clisBNB (direct redeemSy) -- 1:1 redemption, no AMM", async () => {
          const {
            adapter,
            user,
            clisbnb,
            vToken,
            ptToken,
            marketAddress,
            depositPtAmount,
            depositVTokenAmount,
          } = await loadFixture(maturedWithDepositsFixture);

          const withdrawVTokenAmount = depositVTokenAmount.div(2);

          // Estimate PT from vToken redemption (ratio preserved, no interest accrued)
          const estimatedPt = withdrawVTokenAmount.mul(depositPtAmount).div(depositVTokenAmount);

          // Fetch TokenOutput from Pendle API.
          // NOTE: API queries the real (pre-maturity) chain, but the TokenOutput
          // routing data is the same regardless of maturity.
          const { tokenOutput } = await getPendlePtToTokenParams(
            56,
            PT_CLISBNBX_25JUN2026,
            CLISBNB,
            estimatedPt,
            user.address,
            0.03,
            false, // no aggregator needed -- clisBNB is in tokensRedeemSy
          );

          // Verify API returned direct redeem path
          expect(tokenOutput.tokenOut.toLowerCase()).to.equal(CLISBNB.toLowerCase());
          expect(tokenOutput.tokenRedeemSy.toLowerCase()).to.equal(CLISBNB.toLowerCase());
          expect(tokenOutput.pendleSwap).to.equal(ethers.constants.AddressZero);
          expect(tokenOutput.swapData.swapType).to.equal(0);

          // Record balances before redemption
          const userClisbnbBefore = await clisbnb.balanceOf(user.address);
          const userVTokenBefore = await vToken.balanceOf(user.address);
          const userPtBefore = await ptToken.balanceOf(user.address);

          // Execute redeemAtMaturity (delegation already active from fixture)
          const tx = await adapter.connect(user).redeemAtMaturity(marketAddress, withdrawVTokenAmount, tokenOutput);
          const receipt = await tx.wait();

          // Record balances after redemption
          const userClisbnbAfter = await clisbnb.balanceOf(user.address);
          const userVTokenAfter = await vToken.balanceOf(user.address);
          const userPtAfter = await ptToken.balanceOf(user.address);

          const clisbnbReceived = userClisbnbAfter.sub(userClisbnbBefore);
          const vTokensRedeemed = userVTokenBefore.sub(userVTokenAfter);

          // Assert user balance changes
          expect(vTokensRedeemed).to.equal(withdrawVTokenAmount);
          expect(clisbnbReceived).to.be.gt(0);
          expect(clisbnbReceived).to.be.gte(tokenOutput.minTokenOut);
          expect(userPtAfter).to.equal(userPtBefore); // No PT leaked

          // Assert adapter holds zero balances (stateless)
          expect(await clisbnb.balanceOf(adapter.address)).to.equal(0);
          expect(await ptToken.balanceOf(adapter.address)).to.equal(0);
          expect(await vToken.balanceOf(adapter.address)).to.equal(0);

          // Verify RedeemedAtMaturity event (NOT Withdrawn)
          const redeemEvent = receipt.events?.find((e: any) => e.event === "RedeemedAtMaturity");
          expect(redeemEvent).to.not.be.undefined;

          const args = redeemEvent!.args!;
          expect(args.pendleMarket).to.equal(marketAddress);
          expect(args.user).to.equal(user.address);
          expect(args.vTokenAmount).to.equal(withdrawVTokenAmount);
          expect(args.ptAmount).to.be.gt(0);
          expect(args.tokenOut).to.equal(CLISBNB);
          expect(args.amountOut).to.equal(clisbnbReceived);
        });
      });

      // ── RedeemAtMaturity Error Cases ──────────────────────────────────
      //
      // Modifier execution order:
      //   whenNotPaused -> nonReentrant -> onlyActiveMarket -> atOrAfterMaturity -> body
      //
      // Paused/MarketNotRegistered/MarketNotActive revert before the maturity
      // check, so they can use baseFixture (pre-maturity state).
      // ZeroAmount and delegation failure are in the function body, so they
      // need maturedWithDepositsFixture (post-maturity).

      describe("redeemAtMaturity error cases", () => {
        const redeemAmount = parseUnits("1", 18);

        it("should revert with MarketNotMatured when called before maturity", async () => {
          const { adapter, user, marketAddress } = await loadFixture(baseFixture);
          const output = getDummyTokenOutput(CLISBNB);

          await expect(
            adapter.connect(user).redeemAtMaturity(marketAddress, redeemAmount, output),
          ).to.be.revertedWithCustomError(adapter, "MarketNotMatured");
        });

        it("should revert with ZeroAmount when vTokenAmount is 0", async () => {
          // ZeroAmount is in the function body, AFTER atOrAfterMaturity modifier
          const { adapter, user, marketAddress } = await loadFixture(maturedWithDepositsFixture);
          const output = getDummyTokenOutput(CLISBNB);

          await expect(
            adapter.connect(user).redeemAtMaturity(marketAddress, 0, output),
          ).to.be.revertedWithCustomError(adapter, "ZeroAmount");
        });

        it("should revert with MarketNotRegistered for unregistered market", async () => {
          const { adapter, user } = await loadFixture(baseFixture);
          const output = getDummyTokenOutput(CLISBNB);

          await expect(adapter.connect(user).redeemAtMaturity(FAKE_MARKET, redeemAmount, output))
            .to.be.revertedWithCustomError(adapter, "MarketNotRegistered")
            .withArgs(FAKE_MARKET);
        });

        it("should revert with MarketNotActive when market is deactivated", async () => {
          const { adapter, owner, user, marketAddress } = await loadFixture(baseFixture);

          await adapter.connect(owner).deactivateMarket(marketAddress);
          const output = getDummyTokenOutput(CLISBNB);

          await expect(adapter.connect(user).redeemAtMaturity(marketAddress, redeemAmount, output))
            .to.be.revertedWithCustomError(adapter, "MarketNotActive")
            .withArgs(marketAddress);
        });

        it("should revert when contract is paused", async () => {
          const { adapter, owner, user, marketAddress } = await loadFixture(baseFixture);

          await adapter.connect(owner).pause();
          const output = getDummyTokenOutput(CLISBNB);

          await expect(
            adapter.connect(user).redeemAtMaturity(marketAddress, redeemAmount, output),
          ).to.be.revertedWith("Pausable: paused");
        });

        it("should revert when user has not delegated to adapter (redeemBehalf fails)", async () => {
          // Delegation failure is inside _redeemVTokens, after all modifiers
          const { adapter, user, comptroller, marketAddress } = await loadFixture(maturedWithDepositsFixture);

          // Revoke delegation
          await comptroller.connect(user).updateDelegate(adapter.address, false);
          const output = getDummyTokenOutput(CLISBNB);

          await expect(
            adapter.connect(user).redeemAtMaturity(marketAddress, redeemAmount, output),
          ).to.be.reverted;
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
