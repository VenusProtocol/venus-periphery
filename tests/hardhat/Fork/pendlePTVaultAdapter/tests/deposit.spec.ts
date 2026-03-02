import "@nomicfoundation/hardhat-chai-matchers";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import chai from "chai";
import { parseUnits } from "ethers/lib/utils";
import { ethers } from "hardhat";

import { FORK_MAINNET, forking } from "../../utils";
import { BLOCK_NUMBER, BSC_CHAIN_ID, FAKE_MARKET, PENDLE_MARKET, SLISBNB, WBNB } from "../utils/constants";
import { baseFixture } from "../utils/fixtures";
import {
  getDummyApproxParams,
  getDummyLimitOrderData,
  getDummyTokenInput,
  increaseListaOracleTimeDeltaTolerance,
} from "../utils/helpers";
import { getPendleSwapParams } from "../utils/pendleApi";

const { expect } = chai;

function describeTests() {
  describe("PendlePTVaultAdapter - Deposit", () => {
    // ── Happy Path: ERC-20 deposit ──────────────────────────────────────

    describe("deposit (ERC-20)", () => {
      // slisBNB is in tokensMintSy -- direct SY mint path, no aggregator.
      // Flow: slisBNB -> SY.deposit() -> SY -> PT (via Pendle AMM) -> Venus vToken
      it("should deposit slisBNB (direct mintSy token) -> PT -> Venus", async () => {
        const { adapter, user, slisbnb, vToken, ptToken, comptroller, marketAddress } = await loadFixture(baseFixture);

        const depositAmount = parseUnits("1", 18);

        // Fetch swap params from Pendle API (enableAggregator=false)
        const marketConfig = await adapter.getMarketConfig(marketAddress);
        const { minPtOut, approxParams, tokenInput, limitOrderData } = await getPendleSwapParams(
          BSC_CHAIN_ID,
          SLISBNB,
          marketConfig.pt,
          depositAmount,
          user.address,
          0.03,
          false,
        );

        // Verify API returned direct mint path (no aggregator routing)
        expect(tokenInput.tokenIn.toLowerCase()).to.equal(SLISBNB.toLowerCase());
        expect(tokenInput.netTokenIn).to.equal(depositAmount);
        expect(tokenInput.tokenMintSy.toLowerCase()).to.equal(tokenInput.tokenIn.toLowerCase());
        expect(tokenInput.pendleSwap).to.equal(ethers.constants.AddressZero);
        expect(tokenInput.swapData.swapType).to.equal(0);

        // Record balances before deposit
        const userSlisbnbBefore = await slisbnb.balanceOf(user.address);
        const userVTokenBefore = await vToken.balanceOf(user.address);
        const userPtBefore = await ptToken.balanceOf(user.address);

        // Approve and delegate
        await slisbnb.connect(user).approve(adapter.address, depositAmount);
        await comptroller.connect(user).updateDelegate(adapter.address, true);

        // Execute deposit
        const tx = await adapter
          .connect(user)
          .deposit(marketAddress, minPtOut, approxParams, tokenInput, limitOrderData);
        const receipt = await tx.wait();

        // Record balances after deposit
        const userSlisbnbAfter = await slisbnb.balanceOf(user.address);
        const userVTokenAfter = await vToken.balanceOf(user.address);
        const userPtAfter = await ptToken.balanceOf(user.address);

        const slisbnbSpent = userSlisbnbBefore.sub(userSlisbnbAfter);
        const vTokensMinted = userVTokenAfter.sub(userVTokenBefore);

        // Assert user balance changes
        expect(slisbnbSpent).to.equal(depositAmount);
        expect(vTokensMinted).to.be.gt(0);
        expect(userPtAfter).to.equal(userPtBefore); // No PT leaked to user

        // Assert adapter holds zero balances (stateless)
        expect(await slisbnb.balanceOf(adapter.address)).to.equal(0);
        expect(await ptToken.balanceOf(adapter.address)).to.equal(0);
        expect(await vToken.balanceOf(adapter.address)).to.equal(0);

        // Verify Deposited event
        const depositedEvent = receipt.events?.find((e: any) => e.event === "Deposited");
        expect(depositedEvent).to.not.be.undefined;

        const args = depositedEvent!.args!;
        expect(args.pendleMarket).to.equal(marketAddress);
        expect(args.user).to.equal(user.address);
        expect(args.tokenIn).to.equal(SLISBNB);
        expect(args.amountIn).to.equal(depositAmount);
        expect(args.ptAmount).to.be.gte(minPtOut);
        expect(args.vTokenAmount).to.equal(vTokensMinted);
        expect(args.vTokenAmount).to.be.gt(0);
      });

      // WBNB is NOT in tokensMintSy -- requires aggregator routing.
      // Flow: WBNB -> [Aggregator] -> slisBNB -> SY.deposit() -> SY -> PT -> Venus vToken
      it("should deposit WBNB (aggregator-routed token) -> PT -> Venus", async () => {
        const { adapter, user, wbnb, slisbnb, vToken, ptToken, comptroller, marketAddress } =
          await loadFixture(baseFixture);

        const depositAmount = parseUnits("1", 18);

        // Verify user has enough WBNB
        const userWbnbBalance = await wbnb.balanceOf(user.address);
        expect(userWbnbBalance).to.be.gte(depositAmount);

        // Fetch swap params from Pendle API (enableAggregator=true)
        const marketConfig = await adapter.getMarketConfig(marketAddress);
        const { minPtOut, approxParams, tokenInput, limitOrderData } = await getPendleSwapParams(
          BSC_CHAIN_ID,
          WBNB,
          marketConfig.pt,
          depositAmount,
          user.address,
          0.03,
          true,
        );

        // Verify API returned aggregator-routed path
        expect(tokenInput.tokenIn.toLowerCase()).to.equal(WBNB.toLowerCase());
        expect(tokenInput.netTokenIn).to.equal(depositAmount);
        expect(tokenInput.pendleSwap).to.not.equal(ethers.constants.AddressZero);
        expect(tokenInput.swapData.swapType).to.equal(1);

        // Record balances before deposit
        const userWbnbBefore = await wbnb.balanceOf(user.address);
        const userVTokenBefore = await vToken.balanceOf(user.address);
        const userPtBefore = await ptToken.balanceOf(user.address);

        // Approve and delegate
        await wbnb.connect(user).approve(adapter.address, depositAmount);
        await comptroller.connect(user).updateDelegate(adapter.address, true);

        // Execute deposit
        const tx = await adapter
          .connect(user)
          .deposit(marketAddress, minPtOut, approxParams, tokenInput, limitOrderData);
        const receipt = await tx.wait();

        // Record balances after deposit
        const userWbnbAfter = await wbnb.balanceOf(user.address);
        const userVTokenAfter = await vToken.balanceOf(user.address);
        const userPtAfter = await ptToken.balanceOf(user.address);

        const wbnbSpent = userWbnbBefore.sub(userWbnbAfter);
        const vTokensMinted = userVTokenAfter.sub(userVTokenBefore);

        // Assert user balance changes
        expect(wbnbSpent).to.equal(depositAmount);
        expect(vTokensMinted).to.be.gt(0);
        expect(userPtAfter).to.equal(userPtBefore);

        // Assert adapter holds zero balances (stateless)
        expect(await wbnb.balanceOf(adapter.address)).to.equal(0);
        expect(await slisbnb.balanceOf(adapter.address)).to.equal(0);
        expect(await ptToken.balanceOf(adapter.address)).to.equal(0);
        expect(await vToken.balanceOf(adapter.address)).to.equal(0);

        // Verify Deposited event
        const depositedEvent = receipt.events?.find((e: any) => e.event === "Deposited");
        expect(depositedEvent).to.not.be.undefined;

        const args = depositedEvent!.args!;
        expect(args.pendleMarket).to.equal(marketAddress);
        expect(args.user).to.equal(user.address);
        expect(args.tokenIn).to.equal(WBNB);
        expect(args.amountIn).to.equal(depositAmount);
        expect(args.ptAmount).to.be.gte(minPtOut);
        expect(args.vTokenAmount).to.equal(vTokensMinted);
        expect(args.vTokenAmount).to.be.gt(0);
      });
    });

    // ── Happy Path: Native BNB deposit ──────────────────────────────────

    describe("depositNative", () => {
      // Native BNB -- adapter passes BNB to Pendle Router via {value: msg.value}.
      // Flow: BNB -> Pendle Router ({value}) -> SY -> PT -> Venus vToken
      it("should deposit native BNB -> PT -> Venus via depositNative", async () => {
        const { adapter, user, vToken, ptToken, comptroller, marketAddress } = await loadFixture(baseFixture);

        const depositAmount = parseUnits("1", 18);
        const NATIVE = ethers.constants.AddressZero;

        // Fetch swap params for native BNB
        const marketConfig = await adapter.getMarketConfig(marketAddress);
        const { minPtOut, approxParams, tokenInput, limitOrderData } = await getPendleSwapParams(
          BSC_CHAIN_ID,
          NATIVE,
          marketConfig.pt,
          depositAmount,
          user.address,
          0.03,
          false,
        );

        // Record balances before deposit
        const userBnbBefore = await ethers.provider.getBalance(user.address);
        const userVTokenBefore = await vToken.balanceOf(user.address);
        const userPtBefore = await ptToken.balanceOf(user.address);

        // Delegate (no ERC20 approval needed for native BNB)
        await comptroller.connect(user).updateDelegate(adapter.address, true);

        // Execute depositNative
        const tx = await adapter
          .connect(user)
          .depositNative(marketAddress, minPtOut, approxParams, tokenInput, limitOrderData, {
            value: depositAmount,
          });
        const receipt = await tx.wait();

        // Record balances after deposit
        const userBnbAfter = await ethers.provider.getBalance(user.address);
        const userVTokenAfter = await vToken.balanceOf(user.address);
        const userPtAfter = await ptToken.balanceOf(user.address);

        const vTokensMinted = userVTokenAfter.sub(userVTokenBefore);

        // Assert user balance changes
        expect(userBnbBefore.sub(userBnbAfter)).to.be.gte(depositAmount); // >= because of gas
        expect(vTokensMinted).to.be.gt(0);
        expect(userPtAfter).to.equal(userPtBefore);

        // Assert adapter holds zero balances (stateless)
        expect(await ptToken.balanceOf(adapter.address)).to.equal(0);
        expect(await vToken.balanceOf(adapter.address)).to.equal(0);
        expect(await ethers.provider.getBalance(adapter.address)).to.equal(0);

        // Verify Deposited event
        const depositedEvent = receipt.events?.find((e: any) => e.event === "Deposited");
        expect(depositedEvent).to.not.be.undefined;

        const args = depositedEvent!.args!;
        expect(args.pendleMarket).to.equal(marketAddress);
        expect(args.user).to.equal(user.address);
        expect(args.amountIn).to.equal(depositAmount);
        expect(args.ptAmount).to.be.gte(minPtOut);
        expect(args.vTokenAmount).to.equal(vTokensMinted);
        expect(args.vTokenAmount).to.be.gt(0);
      });
    });

    // ── Deposit After Maturity ──────────────────────────────────────────
    //
    // The adapter does NOT enforce maturity checks on deposits -- it lets
    // the Pendle Router revert naturally. After maturity, Pendle's AMM
    // pool is dissolved and swapExactTokenForPt rejects the swap.

    describe("deposit after maturity", () => {
      it("should revert with MarketExpired when Pendle market has expired", async () => {
        const { adapter, user, slisbnb, comptroller, marketAddress } = await loadFixture(baseFixture);

        const depositAmount = parseUnits("1", 18);

        // Get swap params BEFORE time travel (Pendle API queries real chain)
        const marketConfig = await adapter.getMarketConfig(marketAddress);
        const maturity = marketConfig.maturity.toNumber();
        const { minPtOut, approxParams, tokenInput, limitOrderData } = await getPendleSwapParams(
          BSC_CHAIN_ID,
          SLISBNB,
          marketConfig.pt,
          depositAmount,
          user.address,
          0.03,
          false,
        );

        // Increase Lista DAO oracle tolerance before time travel
        await increaseListaOracleTimeDeltaTolerance();

        // Time travel past maturity
        await time.increaseTo(maturity + 1);

        // Approve adapter
        await slisbnb.connect(user).approve(adapter.address, depositAmount);
        await comptroller.connect(user).updateDelegate(adapter.address, true);

        // Attempt deposit after maturity -- Pendle Market rejects with MarketExpired
        const pendleMarketContract = await ethers.getContractAt(["error MarketExpired()"], PENDLE_MARKET);

        await expect(
          adapter.connect(user).deposit(marketAddress, minPtOut, approxParams, tokenInput, limitOrderData),
        ).to.be.revertedWithCustomError(pendleMarketContract, "MarketExpired");
      });
    });

    // ── Deposit Error Cases ─────────────────────────────────────────────

    describe("deposit error cases", () => {
      const depositAmount = parseUnits("1", 18);
      const dummyApprox = getDummyApproxParams();
      const dummyLimit = getDummyLimitOrderData();

      it("should revert with ZeroAmount when netTokenIn is 0", async () => {
        const { adapter, user, marketAddress } = await loadFixture(baseFixture);
        const input = getDummyTokenInput(SLISBNB, 0);

        await expect(
          adapter.connect(user).deposit(marketAddress, 0, dummyApprox, input, dummyLimit),
        ).to.be.revertedWithCustomError(adapter, "ZeroAmount");
      });

      it("should revert with InvalidTokenInput when tokenIn is zero address", async () => {
        const { adapter, user, marketAddress } = await loadFixture(baseFixture);
        const input = getDummyTokenInput(ethers.constants.AddressZero, depositAmount);

        await expect(
          adapter.connect(user).deposit(marketAddress, 0, dummyApprox, input, dummyLimit),
        ).to.be.revertedWithCustomError(adapter, "InvalidTokenInput");
      });

      it("should revert with MarketNotRegistered for unregistered market", async () => {
        const { adapter, user } = await loadFixture(baseFixture);
        const input = getDummyTokenInput(SLISBNB, depositAmount);

        await expect(adapter.connect(user).deposit(FAKE_MARKET, 0, dummyApprox, input, dummyLimit))
          .to.be.revertedWithCustomError(adapter, "MarketNotRegistered")
          .withArgs(FAKE_MARKET);
      });

      it("should revert when contract is paused", async () => {
        const { adapter, owner, user, marketAddress } = await loadFixture(baseFixture);

        await adapter.connect(owner).pause();

        const input = getDummyTokenInput(SLISBNB, depositAmount);

        await expect(
          adapter.connect(user).deposit(marketAddress, 0, dummyApprox, input, dummyLimit),
        ).to.be.revertedWith("Pausable: paused");
      });

      it("should revert when user has not approved adapter for tokenIn", async () => {
        const { adapter, user, slisbnb, marketAddress } = await loadFixture(baseFixture);
        const input = getDummyTokenInput(SLISBNB, depositAmount);

        // Ensure zero allowance
        await slisbnb.connect(user).approve(adapter.address, 0);

        await expect(adapter.connect(user).deposit(marketAddress, 0, dummyApprox, input, dummyLimit)).to.be.reverted;
      });
    });

    // ── depositNative Error Cases ───────────────────────────────────────

    describe("depositNative error cases", () => {
      const dummyApprox = getDummyApproxParams();
      const dummyLimit = getDummyLimitOrderData();

      it("should revert with ZeroAmount when msg.value is 0", async () => {
        const { adapter, user, marketAddress } = await loadFixture(baseFixture);
        const input = getDummyTokenInput(ethers.constants.AddressZero, 0);

        await expect(
          adapter.connect(user).depositNative(marketAddress, 0, dummyApprox, input, dummyLimit, { value: 0 }),
        ).to.be.revertedWithCustomError(adapter, "ZeroAmount");
      });

      it("should revert with InputAmountMismatch when netTokenIn != msg.value", async () => {
        const { adapter, user, marketAddress } = await loadFixture(baseFixture);
        const nativeDepositAmount = parseUnits("1", 18);
        const mismatchedNetTokenIn = parseUnits("2", 18);
        const input = getDummyTokenInput(ethers.constants.AddressZero, mismatchedNetTokenIn);

        await expect(
          adapter
            .connect(user)
            .depositNative(marketAddress, 0, dummyApprox, input, dummyLimit, { value: nativeDepositAmount }),
        )
          .to.be.revertedWithCustomError(adapter, "InputAmountMismatch")
          .withArgs(mismatchedNetTokenIn, nativeDepositAmount);
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
