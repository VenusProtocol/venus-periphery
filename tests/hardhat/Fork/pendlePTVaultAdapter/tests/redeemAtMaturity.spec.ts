import "@nomicfoundation/hardhat-chai-matchers";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import chai from "chai";
import { parseUnits } from "ethers/lib/utils";
import { ethers } from "hardhat";

import { FORK_MAINNET, forking } from "../../utils";
import { BLOCK_NUMBER, BSC_CHAIN_ID, FAKE_MARKET, PT_CLISBNBX_25JUN2026, SLISBNB, WBNB } from "../utils/constants";
import { baseFixture, maturedWithDepositsFixture } from "../utils/fixtures";
import { getDummyTokenOutput, replaceAggregatorWithMock } from "../utils/helpers";
import { getPendlePtToTokenParams } from "../utils/pendleApi";

const { expect } = chai;

function describeTests() {
  describe("PendlePTVaultAdapter - RedeemAtMaturity", () => {
    // Force baseFixture snapshot before maturedWithDepositsFixture time-travels.
    // Without this, the first loadFixture(baseFixture) call inherits the
    // time-traveled block.timestamp, breaking the MarketNotMatured test.
    before(async () => {
      await loadFixture(baseFixture);
    });

    // ── Happy Path ────────────────────────────────────────────────────
    //
    // RedeemAtMaturity flow:
    //   vTokens -> redeem from Venus -> PT -> redeem 1:1 via SY -> tokenOut
    //
    // Unlike withdraw (AMM sell with price impact), this is a pure 1:1
    // redemption -- no slippage from AMM. Uses redeemPyToToken() instead
    // of swapExactPtForToken(). No LimitOrderData needed.
    //
    describe("redeemAtMaturity happy path", () => {
      // slisBNB is in tokensRedeemSy -- SY directly unwraps to slisBNB.
      // Flow: vTokens -> redeem -> PT -> redeemPyToToken() -> SY -> slisBNB
      it("should redeem to slisBNB (direct redeemSy) -- 1:1 redemption, no AMM", async () => {
        const { adapter, user, slisbnb, vToken, ptToken, marketAddress, depositPtAmount, depositVTokenAmount } =
          await loadFixture(maturedWithDepositsFixture);

        const withdrawVTokenAmount = depositVTokenAmount.div(2);

        // Estimate PT from vToken redemption (ratio preserved, no interest accrued)
        const estimatedPt = withdrawVTokenAmount.mul(depositPtAmount).div(depositVTokenAmount);

        // Fetch TokenOutput from Pendle API.
        // NOTE: API queries the real (pre-maturity) chain, but the TokenOutput
        // routing data is the same regardless of maturity.
        const { tokenOutput } = await getPendlePtToTokenParams(
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

        // Record balances before redemption
        const userSlisbnbBefore = await slisbnb.balanceOf(user.address);
        const userVTokenBefore = await vToken.balanceOf(user.address);
        const userPtBefore = await ptToken.balanceOf(user.address);

        // Execute redeemAtMaturity (delegation already active from fixture)
        const tx = await adapter.connect(user).redeemAtMaturity(marketAddress, withdrawVTokenAmount, tokenOutput);
        const receipt = await tx.wait();

        // Record balances after redemption
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

        // Verify RedeemedAtMaturity event (NOT Withdrawn)
        const redeemEvent = receipt.events?.find((e: any) => e.event === "RedeemedAtMaturity");
        expect(redeemEvent).to.not.be.undefined;

        const args = redeemEvent!.args!;
        expect(args.pendleMarket).to.equal(marketAddress);
        expect(args.user).to.equal(user.address);
        expect(args.vTokenAmount).to.equal(withdrawVTokenAmount);
        expect(args.ptAmount).to.be.gt(0);
        expect(args.tokenOut).to.equal(SLISBNB);
        expect(args.amountOut).to.equal(slisbnbReceived);
      });

      // WBNB is NOT in tokensRedeemSy -- requires aggregator routing.
      // Flow: vTokens -> redeem -> PT -> redeemPyToToken() -> SY -> slisBNB -> [Aggregator] -> WBNB
      it("should redeem to WBNB (aggregator-routed) -- not in tokensRedeemSy", async () => {
        const { adapter, user, wbnb, slisbnb, vToken, ptToken, marketAddress, depositPtAmount, depositVTokenAmount } =
          await loadFixture(maturedWithDepositsFixture);

        const withdrawVTokenAmount = depositVTokenAmount.div(2);

        // Estimate PT from vToken redemption (ratio preserved, no interest accrued)
        const estimatedPt = withdrawVTokenAmount.mul(depositPtAmount).div(depositVTokenAmount);

        // Fetch TokenOutput from Pendle API.
        // NOTE: The API returns routing metadata (pendleSwap address, swapType)
        // and aggregator calldata (KyberSwap). After time travel to maturity,
        // the aggregator calldata expires — handled by AggregatorMock below.
        const { tokenOutput } = await getPendlePtToTokenParams(
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

        // The KyberSwap executor verifies a cryptographic signature over the
        // swap data (targetData). After time travel to maturity, the embedded
        // deadline expires, but we can't patch it without invalidating the
        // signature (→ InvalidSignature() revert).
        //
        // Solution: replace the KyberSwap router with AggregatorMock that
        // performs a direct PancakeSwap V2 swap, bypassing the executor.
        await replaceAggregatorWithMock(tokenOutput.swapData.extRouter);

        // Relax minTokenOut: PancakeSwap V2 direct pair may yield less than
        // KyberSwap's multi-hop route. The test still verifies amountOut > 0.
        tokenOutput.minTokenOut = ethers.BigNumber.from(0);

        // Record balances before redemption
        const userWbnbBefore = await wbnb.balanceOf(user.address);
        const userVTokenBefore = await vToken.balanceOf(user.address);
        const userPtBefore = await ptToken.balanceOf(user.address);

        // Execute redeemAtMaturity (delegation already active from fixture)
        const tx = await adapter.connect(user).redeemAtMaturity(marketAddress, withdrawVTokenAmount, tokenOutput);
        const receipt = await tx.wait();

        // Record balances after redemption
        const userWbnbAfter = await wbnb.balanceOf(user.address);
        const userVTokenAfter = await vToken.balanceOf(user.address);
        const userPtAfter = await ptToken.balanceOf(user.address);

        const wbnbReceived = userWbnbAfter.sub(userWbnbBefore);
        const vTokensRedeemed = userVTokenBefore.sub(userVTokenAfter);

        // Assert user balance changes
        expect(vTokensRedeemed).to.equal(withdrawVTokenAmount);
        expect(wbnbReceived).to.be.gt(0);
        expect(wbnbReceived).to.be.gte(tokenOutput.minTokenOut);
        expect(userPtAfter).to.equal(userPtBefore); // No PT leaked

        // Assert adapter holds zero balances (stateless)
        expect(await wbnb.balanceOf(adapter.address)).to.equal(0);
        expect(await slisbnb.balanceOf(adapter.address)).to.equal(0);
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
        expect(args.tokenOut).to.equal(WBNB);
        expect(args.amountOut).to.equal(wbnbReceived);
      });

      // Native BNB is NOT in tokensRedeemSy -- requires aggregator routing.
      // Flow: vTokens -> redeem -> PT -> redeemPyToToken() -> SY -> slisBNB -> [Aggregator] -> native BNB
      // The Pendle router receives native BNB from the aggregator, then
      // sends it to the user via _transferOut(address(0), receiver, amount).
      it("should redeem to native BNB (aggregator-routed) -- not in tokensRedeemSy", async () => {
        const { adapter, user, slisbnb, vToken, ptToken, marketAddress, depositPtAmount, depositVTokenAmount } =
          await loadFixture(maturedWithDepositsFixture);

        const withdrawVTokenAmount = depositVTokenAmount.div(2);

        // Estimate PT from vToken redemption (ratio preserved, no interest accrued)
        const estimatedPt = withdrawVTokenAmount.mul(depositPtAmount).div(depositVTokenAmount);

        // Fetch TokenOutput from Pendle API with native BNB (address(0)) as output.
        // Pendle uses address(0) for native tokens.
        const { tokenOutput } = await getPendlePtToTokenParams(
          BSC_CHAIN_ID,
          PT_CLISBNBX_25JUN2026,
          ethers.constants.AddressZero, // native BNB
          estimatedPt,
          user.address,
          0.03,
          true, // aggregator required -- native BNB NOT in tokensRedeemSy
        );

        // Verify API returned aggregator-routed path for native BNB
        expect(tokenOutput.tokenOut.toLowerCase()).to.equal(ethers.constants.AddressZero);
        expect(tokenOutput.pendleSwap).to.not.equal(ethers.constants.AddressZero);
        expect(tokenOutput.swapData.swapType).to.be.gt(0); // some aggregator type

        // Replace aggregator router with AggregatorMock (bypasses executor signature)
        await replaceAggregatorWithMock(tokenOutput.swapData.extRouter);

        // Relax minTokenOut: PancakeSwap V2 direct pair may yield less than
        // the original multi-hop route. The test still verifies amountOut > 0.
        tokenOutput.minTokenOut = ethers.BigNumber.from(0);

        // Record balances before redemption
        const userBnbBefore = await ethers.provider.getBalance(user.address);
        const userVTokenBefore = await vToken.balanceOf(user.address);
        const userPtBefore = await ptToken.balanceOf(user.address);

        // Execute redeemAtMaturity (delegation already active from fixture)
        const tx = await adapter.connect(user).redeemAtMaturity(marketAddress, withdrawVTokenAmount, tokenOutput);
        const receipt = await tx.wait();

        // Record balances after redemption
        const userBnbAfter = await ethers.provider.getBalance(user.address);
        const userVTokenAfter = await vToken.balanceOf(user.address);
        const userPtAfter = await ptToken.balanceOf(user.address);

        // Add back gas cost to isolate BNB received from the redemption
        // (user pays gas in native BNB, which reduces their balance)
        const gasUsed = receipt.gasUsed.mul(receipt.effectiveGasPrice);
        const bnbReceived = userBnbAfter.sub(userBnbBefore).add(gasUsed);
        const vTokensRedeemed = userVTokenBefore.sub(userVTokenAfter);

        // Assert user balance changes
        expect(vTokensRedeemed).to.equal(withdrawVTokenAmount);
        expect(bnbReceived).to.be.gt(0);
        expect(userPtAfter).to.equal(userPtBefore); // No PT leaked

        // Assert adapter holds zero balances (stateless)
        expect(await slisbnb.balanceOf(adapter.address)).to.equal(0);
        expect(await ptToken.balanceOf(adapter.address)).to.equal(0);
        expect(await vToken.balanceOf(adapter.address)).to.equal(0);

        // Verify RedeemedAtMaturity event
        const redeemEvent = receipt.events?.find((e: any) => e.event === "RedeemedAtMaturity");
        expect(redeemEvent).to.not.be.undefined;

        const args = redeemEvent!.args!;
        expect(args.pendleMarket).to.equal(marketAddress);
        expect(args.user).to.equal(user.address);
        expect(args.vTokenAmount).to.equal(withdrawVTokenAmount);
        expect(args.ptAmount).to.be.gt(0);
        expect(args.tokenOut).to.equal(ethers.constants.AddressZero);
        expect(args.amountOut).to.equal(bnbReceived);
      });
    });

    // ── RedeemAtMaturity Error Cases ──────────────────────────────────
    //
    // Modifier execution order:
    //   whenNotPaused -> nonReentrant -> onlyRegisteredMarket -> atOrAfterMaturity -> body
    //
    // Paused/MarketNotRegistered revert before the maturity check,
    // so they can use baseFixture (pre-maturity state).
    // ZeroAmount and delegation failure are in the function body, so they
    // need maturedWithDepositsFixture (post-maturity).

    describe("redeemAtMaturity error cases", () => {
      const redeemAmount = parseUnits("1", 18);

      it("should revert with MarketNotMatured when called before maturity", async () => {
        const { adapter, user, marketAddress } = await loadFixture(baseFixture);
        const output = getDummyTokenOutput(SLISBNB);

        await expect(
          adapter.connect(user).redeemAtMaturity(marketAddress, redeemAmount, output),
        ).to.be.revertedWithCustomError(adapter, "MarketNotMatured");
      });

      it("should revert with ZeroAmount when vTokenAmount is 0", async () => {
        // ZeroAmount is in the function body, AFTER atOrAfterMaturity modifier
        const { adapter, user, marketAddress } = await loadFixture(maturedWithDepositsFixture);
        const output = getDummyTokenOutput(SLISBNB);

        await expect(adapter.connect(user).redeemAtMaturity(marketAddress, 0, output)).to.be.revertedWithCustomError(
          adapter,
          "ZeroAmount",
        );
      });

      it("should revert with MarketNotRegistered for unregistered market", async () => {
        const { adapter, user } = await loadFixture(baseFixture);
        const output = getDummyTokenOutput(SLISBNB);

        await expect(adapter.connect(user).redeemAtMaturity(FAKE_MARKET, redeemAmount, output))
          .to.be.revertedWithCustomError(adapter, "MarketNotRegistered")
          .withArgs(FAKE_MARKET);
      });

      it("should revert when contract is paused", async () => {
        const { adapter, owner, user, marketAddress } = await loadFixture(baseFixture);

        await adapter.connect(owner).pause();
        const output = getDummyTokenOutput(SLISBNB);

        await expect(adapter.connect(user).redeemAtMaturity(marketAddress, redeemAmount, output)).to.be.revertedWith(
          "Pausable: paused",
        );
      });

      it("should revert when user has not delegated to adapter (redeemBehalf fails)", async () => {
        // Delegation failure is inside _redeemVTokens, after all modifiers
        const { adapter, user, comptroller, marketAddress } = await loadFixture(maturedWithDepositsFixture);

        // Revoke delegation
        await comptroller.connect(user).updateDelegate(adapter.address, false);
        const output = getDummyTokenOutput(SLISBNB);

        await expect(adapter.connect(user).redeemAtMaturity(marketAddress, redeemAmount, output)).to.be.reverted;
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
