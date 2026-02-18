import "@nomicfoundation/hardhat-chai-matchers";
import { impersonateAccount, setBalance, takeSnapshot, time } from "@nomicfoundation/hardhat-network-helpers";
import chai from "chai";
import { parseUnits } from "ethers/lib/utils";
import { ethers } from "hardhat";

import { FORK_MAINNET, forking } from "./utils";
import { getPendleSwapParams, getPendlePtToTokenParams } from "./utils/pendleApi";

const { expect } = chai;

// BSC Mainnet Addresses
const PENDLE_ROUTER_V3 = "0x888888888889758F76e7103c6CbF23ABbF58F946";
const PENDLE_MARKET = "0x3C1a3D6B69A866444Fe506F7D38a00a1C2D859C5"; // PendleMarketV3 for PT-clisBNBx-25JUN2026
const PT_CLISBNBX_25JUN2026 = "0xe052823b4aefc6e230FAf46231A57d0905E30AE0";
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const CLISBNB = "0xB0b84D294e0C75A6abe60171b70edEb2EFd14A1B"; // Lista collateral BNB
const VTOKEN_PT_CLISBNBX_25JUN2026 = "0x6d3BD68E90B42615cb5abF4B8DE92b154ADc435e"; // venus market address for PT-clisBNBx-25JUN2026
const COMPTROLLER = "0xfD36E2c2a6789Db23113685031d7F16329158384";
const PANCAKE_ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E"; // PancakeSwap Router V2
const LISTA_STAKE_MANAGER = "0x1adB950d8bB3dA4bE104211D5AB038628e477fE6"; // ListaDAO StakeManager for slisBNB

// Whale address with WBNB balance (Binance Hot Wallet)
const WBNB_WHALE = "0x8894E0a0c962CB723c1976a4421c95949bE2D4E3";

// Helper: Get slisBNB via PancakeSwap (swap WBNB -> slisBNB)
async function getSlisbnbViaSwap(signer: any, wbnbToken: any, slisbnbToken: any, amount: any) {
  console.log("\n=== Getting slisBNB via PancakeSwap swap ===");
  const balanceBefore = await slisbnbToken.balanceOf(signer.address);

  const pancakeRouter = await ethers.getContractAt(
    [
      "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)",
    ],
    PANCAKE_ROUTER,
  );

  await wbnbToken.connect(signer).approve(PANCAKE_ROUTER, amount);
  const deadline = Math.floor(Date.now() / 1000) + 3600;
  await pancakeRouter.connect(signer).swapExactTokensForTokens(amount, 0, [WBNB, CLISBNB], signer.address, deadline);

  const balanceAfter = await slisbnbToken.balanceOf(signer.address);
  const received = balanceAfter.sub(balanceBefore);
  console.log("slisBNB received via swap:", ethers.utils.formatEther(received));
  expect(received.gt(0)).to.be.true;
  return received;
}

// Helper: Get slisBNB via ListaDAO deposit (deposit BNB -> slisBNB)
async function getSlisbnbViaListaDeposit(signer: any, slisbnbToken: any, amount: any) {
  console.log("\n=== Getting slisBNB via ListaDAO deposit ===");
  const balanceBefore = await slisbnbToken.balanceOf(signer.address);

  const stakeManager = await ethers.getContractAt(["function deposit() external payable"], LISTA_STAKE_MANAGER);

  await stakeManager.connect(signer).deposit({ value: amount });

  const balanceAfter = await slisbnbToken.balanceOf(signer.address);
  const received = balanceAfter.sub(balanceBefore);
  console.log("slisBNB received via ListaDAO deposit:", ethers.utils.formatEther(received));
  expect(received.gt(0)).to.be.true;
  return received;
}

// ═══════════════════════════════════════════════════════════════════════
// Dummy struct factories for error case tests
// (contract reverts before consuming these, so values don't matter)
// ═══════════════════════════════════════════════════════════════════════

function getDummyApproxParams() {
  return {
    guessMin: 0,
    guessMax: 0,
    guessOffchain: 0,
    maxIteration: 0,
    eps: 0,
  };
}

function getDummyTokenInput(tokenIn: string, netTokenIn: any) {
  return {
    tokenIn,
    netTokenIn,
    tokenMintSy: tokenIn,
    pendleSwap: ethers.constants.AddressZero,
    swapData: {
      swapType: 0,
      extRouter: ethers.constants.AddressZero,
      extCalldata: "0x",
      needScale: false,
    },
  };
}

function getDummyLimitOrderData() {
  return {
    limitRouter: ethers.constants.AddressZero,
    epsSkipMarket: 0,
    normalFills: [],
    flashFills: [],
    optData: "0x",
  };
}

function getDummyTokenOutput(tokenOut: string) {
  return {
    tokenOut,
    minTokenOut: 0,
    tokenRedeemSy: tokenOut,
    pendleSwap: ethers.constants.AddressZero,
    swapData: {
      swapType: 0,
      extRouter: ethers.constants.AddressZero,
      extCalldata: "0x",
      needScale: false,
    },
  };
}

if (FORK_MAINNET) {
  const blockNumber = 81554169;
  forking(blockNumber, () => {
    describe("PendlePTVaultAdapter - Fork Tests", () => {
      let adapter: any;
      let user: any;
      let owner: any;
      let wbnb: any;
      let clisbnb: any;
      let vToken: any;
      let ptToken: any;
      let marketAddress: string;
      let comptroller: any;

      before(async () => {
        [owner] = await ethers.getSigners();

        // Get user from whale
        await impersonateAccount(WBNB_WHALE);
        await setBalance(WBNB_WHALE, parseUnits("100", 18));
        user = await ethers.getSigner(WBNB_WHALE);

        // Get contract instances
        wbnb = await ethers.getContractAt("IERC20", WBNB);
        clisbnb = await ethers.getContractAt("IERC20", CLISBNB);
        vToken = await ethers.getContractAt("IVenusVToken", VTOKEN_PT_CLISBNBX_25JUN2026);
        comptroller = await ethers.getContractAt("IMarketFacet", COMPTROLLER);

        // Deploy PendlePTVaultAdapter implementation
        const PendlePTVaultAdapter = await ethers.getContractFactory("PendlePTVaultAdapter");
        const implementation = await PendlePTVaultAdapter.deploy(PENDLE_ROUTER_V3, WBNB);
        await implementation.deployed();

        // Deploy proxy with a separate admin address
        const proxyAdminAddress = "0x0000000000000000000000000000000000000001";
        const data = implementation.interface.encodeFunctionData("initialize", [owner.address]);

        const TransparentUpgradeableProxy = await ethers.getContractFactory(
          "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol:TransparentUpgradeableProxy",
        );
        const proxy = await TransparentUpgradeableProxy.deploy(implementation.address, proxyAdminAddress, data);
        await proxy.deployed();

        adapter = await ethers.getContractAt("PendlePTVaultAdapter", proxy.address);

        marketAddress = PENDLE_MARKET;

        // Add market to adapter
        await adapter.connect(owner).addMarket(marketAddress, VTOKEN_PT_CLISBNBX_25JUN2026, COMPTROLLER);

        console.log("\n=== Market added to adapter ===");

        // Verify market config
        const marketConfig = await adapter.getMarketConfig(marketAddress);
        expect(marketConfig.pt).to.equal(PT_CLISBNBX_25JUN2026);
        console.log("Maturity:", new Date(marketConfig.maturity.toNumber() * 1000).toISOString());

        // Get PT token instance
        ptToken = await ethers.getContractAt("IERC20", marketConfig.pt);
      });

      // ═══════════════════════════════════════════════════════════════════════
      //                    TOKEN ACQUISITION HELPERS
      // ═══════════════════════════════════════════════════════════════════════
      //
      // These tests acquire slisBNB upfront so subsequent deposit tests
      // don't need to re-acquire tokens. Mocha runs tests sequentially
      // within describe blocks, so balances persist to later tests.
      // ═══════════════════════════════════════════════════════════════════════

      describe("Token acquisition helpers", () => {
        it("should acquire slisBNB via ListaDAO deposit (BNB → slisBNB)", async () => {
          const stakeAmount = parseUnits("10", 18);

          const bnbBefore = await ethers.provider.getBalance(user.address);
          const slisbnbBefore = await clisbnb.balanceOf(user.address);

          const received = await getSlisbnbViaListaDeposit(user, clisbnb, stakeAmount);

          const bnbAfter = await ethers.provider.getBalance(user.address);
          const slisbnbAfter = await clisbnb.balanceOf(user.address);

          // User spent BNB and received slisBNB
          expect(bnbBefore.sub(bnbAfter)).to.be.gte(stakeAmount); // >= stakeAmount (includes gas)
          expect(slisbnbAfter.sub(slisbnbBefore)).to.equal(received);
          expect(received).to.be.gt(0);

          console.log("User slisBNB balance:", ethers.utils.formatEther(slisbnbAfter));
        });

        it("should acquire slisBNB via PancakeSwap swap (WBNB → slisBNB)", async () => {
          const swapAmount = parseUnits("1", 18);

          const wbnbBefore = await wbnb.balanceOf(user.address);
          const slisbnbBefore = await clisbnb.balanceOf(user.address);

          const received = await getSlisbnbViaSwap(user, wbnb, clisbnb, swapAmount);

          const wbnbAfter = await wbnb.balanceOf(user.address);
          const slisbnbAfter = await clisbnb.balanceOf(user.address);

          // User spent WBNB and received slisBNB
          expect(wbnbBefore.sub(wbnbAfter)).to.equal(swapAmount);
          expect(slisbnbAfter.sub(slisbnbBefore)).to.equal(received);
          expect(received).to.be.gt(0);

          console.log("User slisBNB balance:", ethers.utils.formatEther(slisbnbAfter));
        });
      });

      // ═══════════════════════════════════════════════════════════════════════
      //                        DEPOSIT VIA ADAPTER
      // ═══════════════════════════════════════════════════════════════════════

      describe("Deposit via adapter", () => {
        // ─────────────────────────────────────────────────────────────────────
        // Test 1: slisBNB — tokenIn is in tokensMintSy (direct SY mint path)
        // ─────────────────────────────────────────────────────────────────────
        //
        // slisBNB is listed in the market's `tokensMintSy` array. Pendle's SY
        // contract can directly wrap slisBNB into SY without any DEX swap.
        //
        // Flow: slisBNB → SY.deposit() → SY → PT (via Pendle AMM) → Venus vToken
        //
        // Because slisBNB is a direct mintSy token:
        //   - tokenInput.tokenMintSy == tokenInput.tokenIn (no intermediate swap)
        //   - tokenInput.pendleSwap == address(0) (no aggregator needed)
        //   - tokenInput.swapData.swapType == 0 (no external router call)
        // ─────────────────────────────────────────────────────────────────────
        it("should deposit slisBNB (direct mintSy token) → PT → Venus", async () => {
          const depositAmount = parseUnits("1", 18);

          // Acquire slisBNB only if user doesn't have enough
          const currentBalance = await clisbnb.balanceOf(user.address);
          if (currentBalance.lt(depositAmount)) {
            await getSlisbnbViaListaDeposit(user, clisbnb, parseUnits("10", 18));
          }

          // Fetch swap parameters from Pendle API (enableAggregator=false)
          const marketConfig = await adapter.getMarketConfig(marketAddress);
          const { minPtOut, approxParams, tokenInput, limitOrderData } = await getPendleSwapParams(
            56,
            CLISBNB,
            marketConfig.pt,
            depositAmount,
            user.address,
            0.03,
            false, // enableAggregator — not needed for direct mintSy tokens
          );

          // Verify API returned direct mint path (no aggregator routing)
          expect(tokenInput.tokenIn.toLowerCase()).to.equal(CLISBNB.toLowerCase());
          expect(tokenInput.netTokenIn).to.equal(depositAmount);
          expect(tokenInput.tokenMintSy.toLowerCase()).to.equal(tokenInput.tokenIn.toLowerCase());
          expect(tokenInput.pendleSwap).to.equal(ethers.constants.AddressZero);
          expect(tokenInput.swapData.swapType).to.equal(0);

          // Record balances before deposit
          const userSlisbnbBefore = await clisbnb.balanceOf(user.address);
          const userVTokenBefore = await vToken.balanceOf(user.address);
          const userPtBefore = await ptToken.balanceOf(user.address);

          // Approve adapter for token transfer and Venus delegation
          await clisbnb.connect(user).approve(adapter.address, depositAmount);
          await comptroller.connect(user).updateDelegate(adapter.address, true);

          // Execute deposit
          const tx = await adapter
            .connect(user)
            .deposit(marketAddress, depositAmount, minPtOut, approxParams, tokenInput, limitOrderData);
          const receipt = await tx.wait();

          // Record balances after deposit
          const userSlisbnbAfter = await clisbnb.balanceOf(user.address);
          const userVTokenAfter = await vToken.balanceOf(user.address);
          const userPtAfter = await ptToken.balanceOf(user.address);

          const slisbnbSpent = userSlisbnbBefore.sub(userSlisbnbAfter);
          const vTokensMinted = userVTokenAfter.sub(userVTokenBefore);

          // Assert user balance changes
          expect(slisbnbSpent).to.equal(depositAmount);
          expect(vTokensMinted).to.be.gt(0);
          expect(userPtAfter).to.equal(userPtBefore); // No PT leaked to user

          // Assert adapter holds zero balances (stateless between txs)
          expect(await clisbnb.balanceOf(adapter.address)).to.equal(0);
          expect(await ptToken.balanceOf(adapter.address)).to.equal(0);
          expect(await vToken.balanceOf(adapter.address)).to.equal(0);

          // Verify Deposited event
          const depositedEvent = receipt.events?.find((e: any) => e.event === "Deposited");
          expect(depositedEvent).to.not.be.undefined;

          const args = depositedEvent!.args!;
          expect(args.pendleMarket).to.equal(marketAddress);
          expect(args.user).to.equal(user.address);
          expect(args.tokenIn).to.equal(CLISBNB);
          expect(args.amountIn).to.equal(depositAmount);
          expect(args.ptAmount).to.be.gte(minPtOut);
          expect(args.vTokenAmount).to.equal(vTokensMinted);
          expect(args.vTokenAmount).to.be.gt(0);

          console.log("\n=== slisBNB Deposit Results ===");
          console.log("slisBNB spent:", ethers.utils.formatEther(slisbnbSpent));
          console.log("PT minted:", ethers.utils.formatEther(args.ptAmount));
          console.log("vTokens received:", ethers.utils.formatEther(vTokensMinted));

          // Revoke delegation after test
          await comptroller.connect(user).updateDelegate(adapter.address, false);
        });

        // ─────────────────────────────────────────────────────────────────────
        // Test 2: WBNB — tokenIn is in tokensIn but NOT in tokensMintSy
        //         (aggregator-routed path)
        // ─────────────────────────────────────────────────────────────────────
        //
        // WBNB is listed in the market's `tokensIn` array but NOT in `tokensMintSy`.
        // Pendle must first swap WBNB to a tokensMintSy token via an external DEX
        // aggregator before minting SY.
        //
        // Flow: WBNB → [Aggregator] → slisBNB → SY.deposit() → SY → PT → Venus vToken
        //
        // Because WBNB requires aggregator routing:
        //   - tokenInput.tokenMintSy != tokenIn (e.g. slisBNB or native BNB)
        //   - tokenInput.pendleSwap != address(0) (Pendle's swap helper)
        //   - tokenInput.swapData.swapType > 0 (external router call)
        // ─────────────────────────────────────────────────────────────────────
        it("should deposit WBNB (aggregator-routed token) → PT → Venus", async () => {
          const depositAmount = parseUnits("1", 18);

          // Verify user has enough WBNB (whale already holds WBNB)
          const userWbnbBalance = await wbnb.balanceOf(user.address);
          expect(userWbnbBalance).to.be.gte(depositAmount);

          // Fetch swap parameters from Pendle API (enableAggregator=true)
          const marketConfig = await adapter.getMarketConfig(marketAddress);
          const { minPtOut, approxParams, tokenInput, limitOrderData } = await getPendleSwapParams(
            56,
            WBNB,
            marketConfig.pt,
            depositAmount,
            user.address,
            0.03,
            true, // enableAggregator — required for tokens not in tokensMintSy
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

          // Approve adapter for WBNB transfer and Venus delegation
          await wbnb.connect(user).approve(adapter.address, depositAmount);
          await comptroller.connect(user).updateDelegate(adapter.address, true);

          // Execute deposit
          const tx = await adapter
            .connect(user)
            .deposit(marketAddress, depositAmount, minPtOut, approxParams, tokenInput, limitOrderData);
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
          expect(userPtAfter).to.equal(userPtBefore); // No PT leaked to user

          // Assert adapter holds zero balances (stateless between txs)
          expect(await wbnb.balanceOf(adapter.address)).to.equal(0);
          expect(await clisbnb.balanceOf(adapter.address)).to.equal(0);
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

          console.log("\n=== WBNB Deposit Results ===");
          console.log("WBNB spent:", ethers.utils.formatEther(wbnbSpent));
          console.log("PT minted:", ethers.utils.formatEther(args.ptAmount));
          console.log("vTokens received:", ethers.utils.formatEther(vTokensMinted));

          // Revoke delegation after test
          await comptroller.connect(user).updateDelegate(adapter.address, false);
        });

        // ─────────────────────────────────────────────────────────────────────
        // Test 3: Native BNB — deposit via depositNative
        // ─────────────────────────────────────────────────────────────────────
        //
        // User sends native BNB directly. The adapter passes BNB to the
        // Pendle Router via {value: msg.value} without wrapping to WBNB.
        //
        // Flow: BNB → Pendle Router ({value}) → SY → PT → Venus vToken
        //
        // For native BNB deposits:
        //   - tokenInput.tokenIn == address(0) (native token in Pendle)
        //   - msg.value carries the deposit amount (no ERC20 transferFrom)
        //   - Any excess BNB is refunded via _refundNativeDust()
        // ─────────────────────────────────────────────────────────────────────
        it("should deposit native BNB → PT → Venus via depositNative", async () => {
          const depositAmount = parseUnits("1", 18);

          // Fetch swap parameters for native BNB (address(0) in Pendle)
          const NATIVE = ethers.constants.AddressZero;
          const marketConfig = await adapter.getMarketConfig(marketAddress);
          const { minPtOut, approxParams, tokenInput, limitOrderData } = await getPendleSwapParams(
            56,
            NATIVE,
            marketConfig.pt,
            depositAmount,
            user.address,
            0.03,
            false, // native BNB should be directly mintable to SY
          );

          // Record balances before deposit
          const userBnbBefore = await ethers.provider.getBalance(user.address);
          const userVTokenBefore = await vToken.balanceOf(user.address);
          const userPtBefore = await ptToken.balanceOf(user.address);

          // Set Venus delegation (no ERC20 approval needed for native BNB)
          await comptroller.connect(user).updateDelegate(adapter.address, true);

          // Execute depositNative — sends native BNB directly
          const tx = await adapter.connect(user).depositNative(
            marketAddress,
            minPtOut,
            approxParams,
            tokenInput,
            limitOrderData,
            { value: depositAmount },
          );
          const receipt = await tx.wait();

          // Record balances after deposit
          const userBnbAfter = await ethers.provider.getBalance(user.address);
          const userVTokenAfter = await vToken.balanceOf(user.address);
          const userPtAfter = await ptToken.balanceOf(user.address);

          const vTokensMinted = userVTokenAfter.sub(userVTokenBefore);

          // Assert user balance changes
          expect(userBnbBefore.sub(userBnbAfter)).to.be.gte(depositAmount); // >= because of gas
          expect(vTokensMinted).to.be.gt(0);
          expect(userPtAfter).to.equal(userPtBefore); // No PT leaked to user

          // Assert adapter holds zero balances (stateless between txs)
          expect(await ptToken.balanceOf(adapter.address)).to.equal(0);
          expect(await vToken.balanceOf(adapter.address)).to.equal(0);
          expect(await ethers.provider.getBalance(adapter.address)).to.equal(0); // No BNB dust

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

          console.log("\n=== Native BNB Deposit Results ===");
          console.log("BNB spent (incl. gas):", ethers.utils.formatEther(userBnbBefore.sub(userBnbAfter)));
          console.log("PT minted:", ethers.utils.formatEther(args.ptAmount));
          console.log("vTokens received:", ethers.utils.formatEther(vTokensMinted));

          // Revoke delegation after test
          await comptroller.connect(user).updateDelegate(adapter.address, false);
        });

        // ═══════════════════════════════════════════════════════════════════════
        //                    DEPOSIT AFTER MATURITY
        // ═══════════════════════════════════════════════════════════════════════
        //
        // The adapter does NOT enforce maturity checks on deposits — it lets
        // the Pendle Router revert naturally. After maturity, Pendle's AMM
        // pool is dissolved and swapExactTokenForPt should reject the swap.
        //
        // This test time-travels past the PT maturity and verifies that the
        // Pendle Router rejects the deposit attempt.
        // ═══════════════════════════════════════════════════════════════════════

        it("should revert with MarketExpired when Pendle market has expired", async () => {
          const depositAmount = parseUnits("1", 18);

          // Acquire slisBNB if needed
          const currentBalance = await clisbnb.balanceOf(user.address);
          if (currentBalance.lt(depositAmount)) {
            await getSlisbnbViaListaDeposit(user, clisbnb, parseUnits("10", 18));
          }

          // Get swap params BEFORE time travel (Pendle API queries real chain, not our fork)
          const marketConfig = await adapter.getMarketConfig(marketAddress);
          const maturity = marketConfig.maturity.toNumber();
          const { minPtOut, approxParams, tokenInput, limitOrderData } = await getPendleSwapParams(
            56,
            CLISBNB,
            marketConfig.pt,
            depositAmount,
            user.address,
            0.03,
            false,
          );

          // Take snapshot before time travel
          const snapshot = await takeSnapshot();

          // Time travel past maturity
          await time.increaseTo(maturity + 1);

          // Approve adapter
          await clisbnb.connect(user).approve(adapter.address, depositAmount);
          await comptroller.connect(user).updateDelegate(adapter.address, true);

          // Attempt deposit after maturity — all adapter checks pass (amount, tokenIn, market active),
          // token transfer succeeds, but Pendle Market rejects the swap with MarketExpired
          const pendleMarketContract = await ethers.getContractAt(["error MarketExpired()"], PENDLE_MARKET);

          await expect(
            adapter
              .connect(user)
              .deposit(marketAddress, depositAmount, minPtOut, approxParams, tokenInput, limitOrderData),
          ).to.be.revertedWithCustomError(pendleMarketContract, "MarketExpired");

          // Restore to pre-maturity state
          await snapshot.restore();
        });
      });

      // ═══════════════════════════════════════════════════════════════════════
      //                        DEPOSIT ERROR CASES
      // ═══════════════════════════════════════════════════════════════════════
      //
      // Tests that verify the deposit function reverts correctly for invalid
      // inputs. These use dummy structs since the contract reverts before
      // reaching the Pendle Router or token transfer.
      // ═══════════════════════════════════════════════════════════════════════

      describe("Deposit error cases", () => {
        const depositAmount = parseUnits("1", 18);
        const dummyApprox = getDummyApproxParams();
        const dummyLimit = getDummyLimitOrderData();

        it("should revert with ZeroAmount when amount is 0", async () => {
          const input = getDummyTokenInput(CLISBNB, 0);

          await expect(
            adapter.connect(user).deposit(marketAddress, 0, 0, dummyApprox, input, dummyLimit),
          ).to.be.revertedWithCustomError(adapter, "ZeroAmount");
        });

        it("should revert with InvalidTokenInput when tokenIn is zero address", async () => {
          const input = getDummyTokenInput(ethers.constants.AddressZero, depositAmount);

          await expect(
            adapter.connect(user).deposit(marketAddress, depositAmount, 0, dummyApprox, input, dummyLimit),
          ).to.be.revertedWithCustomError(adapter, "InvalidTokenInput");
        });

        it("should revert with InputAmountMismatch when netTokenIn != amount", async () => {
          const mismatchedNetTokenIn = parseUnits("2", 18); // netTokenIn=2 but amount=1
          const input = getDummyTokenInput(CLISBNB, mismatchedNetTokenIn);

          await expect(adapter.connect(user).deposit(marketAddress, depositAmount, 0, dummyApprox, input, dummyLimit))
            .to.be.revertedWithCustomError(adapter, "InputAmountMismatch")
            .withArgs(depositAmount, mismatchedNetTokenIn);
        });

        it("should revert with MarketNotRegistered for unregistered market", async () => {
          const fakeMarket = "0x0000000000000000000000000000000000001234";
          const input = getDummyTokenInput(CLISBNB, depositAmount);

          await expect(adapter.connect(user).deposit(fakeMarket, depositAmount, 0, dummyApprox, input, dummyLimit))
            .to.be.revertedWithCustomError(adapter, "MarketNotRegistered")
            .withArgs(fakeMarket);
        });

        it("should revert with MarketNotActive when market is deactivated", async () => {
          const snapshot = await takeSnapshot();

          // Deactivate the market
          await adapter.connect(owner).deactivateMarket(marketAddress);

          const input = getDummyTokenInput(CLISBNB, depositAmount);

          await expect(adapter.connect(user).deposit(marketAddress, depositAmount, 0, dummyApprox, input, dummyLimit))
            .to.be.revertedWithCustomError(adapter, "MarketNotActive")
            .withArgs(marketAddress);

          // Restore to re-activate market for subsequent tests
          await snapshot.restore();
        });

        it("should revert when contract is paused", async () => {
          const snapshot = await takeSnapshot();

          // Pause the contract
          await adapter.connect(owner).pause();

          const input = getDummyTokenInput(CLISBNB, depositAmount);

          await expect(
            adapter.connect(user).deposit(marketAddress, depositAmount, 0, dummyApprox, input, dummyLimit),
          ).to.be.revertedWith("Pausable: paused");

          // Restore to unpause for subsequent tests
          await snapshot.restore();
        });

        it("should revert when user has not approved adapter for tokenIn", async () => {
          // User has slisBNB from helper tests but has NOT approved the adapter
          // safeTransferFrom will revert due to insufficient allowance
          const input = getDummyTokenInput(CLISBNB, depositAmount);

          // Ensure zero allowance
          await clisbnb.connect(user).approve(adapter.address, 0);

          await expect(adapter.connect(user).deposit(marketAddress, depositAmount, 0, dummyApprox, input, dummyLimit))
            .to.be.reverted;
        });

        // ─── depositNative error cases ─────────────────────────────────────

        it("should revert depositNative with ZeroAmount when msg.value is 0", async () => {
          const input = getDummyTokenInput(ethers.constants.AddressZero, 0);

          await expect(
            adapter.connect(user).depositNative(marketAddress, 0, dummyApprox, input, dummyLimit, { value: 0 }),
          ).to.be.revertedWithCustomError(adapter, "ZeroAmount");
        });

        it("should revert depositNative with InputAmountMismatch when netTokenIn != msg.value", async () => {
          const nativeDepositAmount = parseUnits("1", 18);
          const mismatchedNetTokenIn = parseUnits("2", 18);
          const input = getDummyTokenInput(ethers.constants.AddressZero, mismatchedNetTokenIn);

          await expect(
            adapter
              .connect(user)
              .depositNative(marketAddress, 0, dummyApprox, input, dummyLimit, { value: nativeDepositAmount }),
          )
            .to.be.revertedWithCustomError(adapter, "InputAmountMismatch")
            .withArgs(nativeDepositAmount, mismatchedNetTokenIn);
        });
      });

      // ═══════════════════════════════════════════════════════════════════════
      //                        WITHDRAW VIA ADAPTER
      // ═══════════════════════════════════════════════════════════════════════
      //
      // Withdraw flow: vTokens → redeem from Venus → PT → swap via Pendle AMM → tokenOut to user
      //
      // KEY CONCEPT: tokensRedeemSy vs tokensOut
      //
      //   tokensRedeemSy — Tokens that the SY (Standardized Yield) contract can
      //     DIRECTLY unwrap to without any external DEX swap.
      //     For this market (PT-clisBNBx-25JUN2026): tokensRedeemSy = [clisBNB]
      //
      //   tokensOut — ALL tokens supported for withdrawal output. This is a
      //     SUPERSET of tokensRedeemSy that includes aggregator-routed tokens.
      //     For this market: tokensOut = [native BNB, clisBNB, WBNB, USDC, ...]
      //
      // Routing paths:
      //   tokenOut ∈ tokensRedeemSy (e.g. clisBNB):
      //     PT → AMM sell → SY → SY.redeem() → tokenOut directly
      //     (enableAggregator = false, output.pendleSwap = address(0))
      //
      //   tokenOut ∈ tokensOut but ∉ tokensRedeemSy (e.g. WBNB, native BNB):
      //     PT → AMM sell → SY → SY.redeem() → clisBNB → [Aggregator] → tokenOut
      //     (enableAggregator = true, output.pendleSwap != address(0))
      //
      // ═══════════════════════════════════════════════════════════════════════

      describe("Withdraw via adapter", () => {
        let depositPtAmount: any;
        let depositVTokenAmount: any;

        before(async () => {
          console.log("\n=== Setting up withdraw tests: depositing slisBNB to get vTokens ===");
          const depositAmount = parseUnits("5", 18);

          // Ensure user has enough slisBNB
          const currentBalance = await clisbnb.balanceOf(user.address);
          if (currentBalance.lt(depositAmount)) {
            await getSlisbnbViaListaDeposit(user, clisbnb, parseUnits("10", 18));
          }

          // Fetch deposit params from Pendle API
          const marketConfig = await adapter.getMarketConfig(marketAddress);
          const { minPtOut, approxParams, tokenInput, limitOrderData } = await getPendleSwapParams(
            56,
            CLISBNB,
            marketConfig.pt,
            depositAmount,
            user.address,
            0.03,
            false,
          );

          // Approve adapter and enable delegation
          await clisbnb.connect(user).approve(adapter.address, depositAmount);
          await comptroller.connect(user).updateDelegate(adapter.address, true);

          // Deposit to get vTokens
          const tx = await adapter
            .connect(user)
            .deposit(marketAddress, depositAmount, minPtOut, approxParams, tokenInput, limitOrderData);
          const receipt = await tx.wait();

          // Extract amounts from Deposited event for PT↔vToken ratio calculation
          const depositedEvent = receipt.events?.find((e: any) => e.event === "Deposited");
          depositPtAmount = depositedEvent!.args!.ptAmount;
          depositVTokenAmount = depositedEvent!.args!.vTokenAmount;

          const userVTokenBalance = await vToken.balanceOf(user.address);
          console.log("User vToken balance for withdraw tests:", ethers.utils.formatEther(userVTokenBalance));
          console.log("PT deposited:", ethers.utils.formatEther(depositPtAmount));
          console.log("vTokens minted:", ethers.utils.formatEther(depositVTokenAmount));

          // Delegation stays active for withdraw tests (redeemBehalf requires it)
        });

        // ─────────────────────────────────────────────────────────────────────
        // Test 1: clisBNB — tokenOut is in tokensRedeemSy (direct SY redeem path)
        // ─────────────────────────────────────────────────────────────────────
        //
        // clisBNB is the ONLY token in this market's `tokensRedeemSy` array.
        // The SY contract can directly redeem to clisBNB without any aggregator.
        //
        // Flow: vTokens → redeem → PT → AMM sell → SY → SY.redeem() → clisBNB to user
        //
        // Because clisBNB is a direct redeemSy token:
        //   - output.tokenRedeemSy == output.tokenOut (direct redemption)
        //   - output.pendleSwap == address(0) (no aggregator needed)
        //   - output.swapData.swapType == 0 (no external router call)
        // ─────────────────────────────────────────────────────────────────────
        it("should withdraw to clisBNB (direct redeemSy token) — no aggregator", async () => {
          // Use 1/3 of vTokens for this test
          const withdrawVTokenAmount = depositVTokenAmount.div(3);

          // Estimate PT that will be redeemed from Venus
          // Since we just deposited and no interest has accrued, the ratio is preserved
          const estimatedPt = withdrawVTokenAmount.mul(depositPtAmount).div(depositVTokenAmount);

          // Fetch withdraw params from Pendle API
          const { tokenOutput, limitOrderData } = await getPendlePtToTokenParams(
            56,
            PT_CLISBNBX_25JUN2026,
            CLISBNB,
            estimatedPt,
            user.address,
            0.03,
            false, // enableAggregator — not needed, clisBNB is in tokensRedeemSy
          );

          // Verify API returned direct redeem path (no aggregator routing)
          expect(tokenOutput.tokenOut.toLowerCase()).to.equal(CLISBNB.toLowerCase());
          expect(tokenOutput.tokenRedeemSy.toLowerCase()).to.equal(CLISBNB.toLowerCase());
          expect(tokenOutput.pendleSwap).to.equal(ethers.constants.AddressZero);
          expect(tokenOutput.swapData.swapType).to.equal(0);

          // Record balances before withdraw
          const userClisbnbBefore = await clisbnb.balanceOf(user.address);
          const userVTokenBefore = await vToken.balanceOf(user.address);
          const userPtBefore = await ptToken.balanceOf(user.address);

          // Execute withdraw
          const tx = await adapter
            .connect(user)
            .withdraw(marketAddress, withdrawVTokenAmount, tokenOutput, limitOrderData);
          const receipt = await tx.wait();

          // Record balances after withdraw
          const userClisbnbAfter = await clisbnb.balanceOf(user.address);
          const userVTokenAfter = await vToken.balanceOf(user.address);
          const userPtAfter = await ptToken.balanceOf(user.address);

          const clisbnbReceived = userClisbnbAfter.sub(userClisbnbBefore);
          const vTokensRedeemed = userVTokenBefore.sub(userVTokenAfter);

          // Assert user balance changes
          expect(vTokensRedeemed).to.equal(withdrawVTokenAmount);
          expect(clisbnbReceived).to.be.gt(0);
          expect(clisbnbReceived).to.be.gte(tokenOutput.minTokenOut);
          expect(userPtAfter).to.equal(userPtBefore); // No PT leaked to user

          // Assert adapter holds zero balances (stateless between txs)
          expect(await clisbnb.balanceOf(adapter.address)).to.equal(0);
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
          expect(args.tokenOut).to.equal(CLISBNB);
          expect(args.amountOut).to.equal(clisbnbReceived);

          console.log("\n=== clisBNB Withdraw Results ===");
          console.log("vTokens redeemed:", ethers.utils.formatEther(vTokensRedeemed));
          console.log("PT sold:", ethers.utils.formatEther(args.ptAmount));
          console.log("clisBNB received:", ethers.utils.formatEther(clisbnbReceived));
        });

        // ─────────────────────────────────────────────────────────────────────
        // Test 2: WBNB — tokenOut is in tokensOut but NOT in tokensRedeemSy
        //         (aggregator-routed path)
        // ─────────────────────────────────────────────────────────────────────
        //
        // WBNB is in the market's `tokensOut` array but NOT in `tokensRedeemSy`.
        // Pendle must redeem SY to clisBNB first, then swap clisBNB → WBNB via
        // an external DEX aggregator.
        //
        // Flow: vTokens → redeem → PT → AMM sell → SY → SY.redeem() → clisBNB
        //       → [Aggregator] → WBNB to user
        //
        // Because WBNB requires aggregator routing:
        //   - output.tokenRedeemSy != output.tokenOut (intermediate SY redemption to clisBNB)
        //   - output.pendleSwap != address(0) (Pendle's swap helper for aggregator)
        //   - output.swapData.swapType > 0 (external router call)
        // ─────────────────────────────────────────────────────────────────────
        it("should withdraw to WBNB (aggregator-routed) — not in tokensRedeemSy", async () => {
          // Use another 1/3 of the original vTokens
          const withdrawVTokenAmount = depositVTokenAmount.div(3);

          // Estimate PT from vToken redemption
          const estimatedPt = withdrawVTokenAmount.mul(depositPtAmount).div(depositVTokenAmount);

          // Fetch withdraw params from Pendle API
          const { tokenOutput, limitOrderData } = await getPendlePtToTokenParams(
            56,
            PT_CLISBNBX_25JUN2026,
            WBNB,
            estimatedPt,
            user.address,
            0.03,
            true, // enableAggregator — required, WBNB is NOT in tokensRedeemSy
          );

          // Verify API returned aggregator-routed path
          expect(tokenOutput.tokenOut.toLowerCase()).to.equal(WBNB.toLowerCase());
          expect(tokenOutput.pendleSwap).to.not.equal(ethers.constants.AddressZero);
          expect(tokenOutput.swapData.swapType).to.equal(1);

          // Record balances before withdraw
          const userWbnbBefore = await wbnb.balanceOf(user.address);
          const userVTokenBefore = await vToken.balanceOf(user.address);
          const userPtBefore = await ptToken.balanceOf(user.address);

          // Execute withdraw
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
          expect(userPtAfter).to.equal(userPtBefore); // No PT leaked to user

          // Assert adapter holds zero balances (stateless between txs)
          expect(await wbnb.balanceOf(adapter.address)).to.equal(0);
          expect(await clisbnb.balanceOf(adapter.address)).to.equal(0);
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

          console.log("\n=== WBNB Withdraw Results ===");
          console.log("vTokens redeemed:", ethers.utils.formatEther(vTokensRedeemed));
          console.log("PT sold:", ethers.utils.formatEther(args.ptAmount));
          console.log("WBNB received:", ethers.utils.formatEther(wbnbReceived));
        });

        // ─────────────────────────────────────────────────────────────────────
        // Test 3: Native BNB — withdraw to native BNB (address(0))
        // ─────────────────────────────────────────────────────────────────────
        //
        // Native BNB (address(0)) is in `tokensOut` but NOT in `tokensRedeemSy`.
        // Pendle Router handles the full unwrap chain and sends native BNB to
        // the receiver (user).
        //
        // Flow: vTokens → redeem → PT → AMM sell → SY → SY.redeem() → clisBNB
        //       → [Aggregator] → native BNB to user
        //
        // For native BNB output:
        //   - output.tokenOut == address(0) (native token in Pendle)
        //   - Pendle Router unwraps and sends native BNB to the receiver
        //   - enableAggregator = true (native BNB not in tokensRedeemSy)
        // ─────────────────────────────────────────────────────────────────────
        it("should withdraw to native BNB — Pendle Router handles unwrapping", async () => {
          // Use half of remaining vTokens (leaves some for error case tests)
          const userVTokenBalance = await vToken.balanceOf(user.address);
          const withdrawVTokenAmount = userVTokenBalance.div(2);

          // Estimate PT from vToken redemption
          const estimatedPt = withdrawVTokenAmount.mul(depositPtAmount).div(depositVTokenAmount);

          // Fetch withdraw params for native BNB output
          const NATIVE = ethers.constants.AddressZero;
          const { tokenOutput, limitOrderData } = await getPendlePtToTokenParams(
            56,
            PT_CLISBNBX_25JUN2026,
            NATIVE,
            estimatedPt,
            user.address,
            0.03,
            true, // enableAggregator — required, native BNB not in tokensRedeemSy
          );

          // Record balances before withdraw
          const userBnbBefore = await ethers.provider.getBalance(user.address);
          const userVTokenBefore = await vToken.balanceOf(user.address);
          const userPtBefore = await ptToken.balanceOf(user.address);

          // Execute withdraw
          const tx = await adapter
            .connect(user)
            .withdraw(marketAddress, withdrawVTokenAmount, tokenOutput, limitOrderData);
          const receipt = await tx.wait();
          const gasUsed = receipt.gasUsed.mul(receipt.effectiveGasPrice);

          // Record balances after withdraw
          const userBnbAfter = await ethers.provider.getBalance(user.address);
          const userVTokenAfter = await vToken.balanceOf(user.address);
          const userPtAfter = await ptToken.balanceOf(user.address);

          const bnbReceived = userBnbAfter.sub(userBnbBefore).add(gasUsed); // Add back gas to get actual amount received
          const vTokensRedeemed = userVTokenBefore.sub(userVTokenAfter);

          // Assert user balance changes
          expect(vTokensRedeemed).to.equal(withdrawVTokenAmount);
          expect(bnbReceived).to.be.gt(0);
          expect(userPtAfter).to.equal(userPtBefore); // No PT leaked to user

          // Assert adapter holds zero balances
          expect(await ptToken.balanceOf(adapter.address)).to.equal(0);
          expect(await vToken.balanceOf(adapter.address)).to.equal(0);
          expect(await ethers.provider.getBalance(adapter.address)).to.equal(0); // No BNB dust

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

          console.log("\n=== Native BNB Withdraw Results ===");
          console.log("vTokens redeemed:", ethers.utils.formatEther(vTokensRedeemed));
          console.log("PT sold:", ethers.utils.formatEther(args.ptAmount));
          console.log("BNB received:", ethers.utils.formatEther(bnbReceived));
        });
      });

      // ═══════════════════════════════════════════════════════════════════════
      //                        WITHDRAW ERROR CASES
      // ═══════════════════════════════════════════════════════════════════════
      //
      // Tests that verify the withdraw function reverts correctly for invalid
      // inputs. These use dummy structs since the contract reverts before
      // reaching the Pendle Router or vToken interaction for most cases.
      // ═══════════════════════════════════════════════════════════════════════

      describe("Withdraw error cases", () => {
        const dummyLimit = getDummyLimitOrderData();
        const withdrawAmount = parseUnits("1", 18);

        it("should revert with ZeroAmount when vTokenAmount is 0", async () => {
          const output = getDummyTokenOutput(CLISBNB);

          await expect(
            adapter.connect(user).withdraw(marketAddress, 0, output, dummyLimit),
          ).to.be.revertedWithCustomError(adapter, "ZeroAmount");
        });

        it("should revert with MarketNotRegistered for unregistered market", async () => {
          const fakeMarket = "0x0000000000000000000000000000000000001234";
          const output = getDummyTokenOutput(CLISBNB);

          await expect(adapter.connect(user).withdraw(fakeMarket, withdrawAmount, output, dummyLimit))
            .to.be.revertedWithCustomError(adapter, "MarketNotRegistered")
            .withArgs(fakeMarket);
        });

        it("should revert with MarketNotActive when market is deactivated", async () => {
          const snapshot = await takeSnapshot();

          await adapter.connect(owner).deactivateMarket(marketAddress);

          const output = getDummyTokenOutput(CLISBNB);

          await expect(adapter.connect(user).withdraw(marketAddress, withdrawAmount, output, dummyLimit))
            .to.be.revertedWithCustomError(adapter, "MarketNotActive")
            .withArgs(marketAddress);

          await snapshot.restore();
        });

        it("should revert when contract is paused", async () => {
          const snapshot = await takeSnapshot();

          await adapter.connect(owner).pause();

          const output = getDummyTokenOutput(CLISBNB);

          await expect(
            adapter.connect(user).withdraw(marketAddress, withdrawAmount, output, dummyLimit),
          ).to.be.revertedWith("Pausable: paused");

          await snapshot.restore();
        });

        it("should revert with MarketAlreadyMatured when called after maturity", async () => {
          const snapshot = await takeSnapshot();

          // Time travel past maturity
          const marketConfig = await adapter.getMarketConfig(marketAddress);
          const maturity = marketConfig.maturity.toNumber();
          await time.increaseTo(maturity + 1);

          const output = getDummyTokenOutput(CLISBNB);

          await expect(
            adapter.connect(user).withdraw(marketAddress, withdrawAmount, output, dummyLimit),
          ).to.be.revertedWithCustomError(adapter, "MarketAlreadyMatured");

          await snapshot.restore();
        });

        it("should revert when user has not delegated to adapter (redeemBehalf fails)", async () => {
          const snapshot = await takeSnapshot();

          // Revoke delegation
          await comptroller.connect(user).updateDelegate(adapter.address, false);

          const output = getDummyTokenOutput(CLISBNB);

          await expect(
            adapter.connect(user).withdraw(marketAddress, withdrawAmount, output, dummyLimit),
          ).to.be.reverted;

          await snapshot.restore();
        });
      });

      // ═══════════════════════════════════════════════════════════════════════
      //                    REDEEM AT MATURITY VIA ADAPTER
      // ═══════════════════════════════════════════════════════════════════════
      //
      // RedeemAtMaturity flow:
      //   vTokens → redeem from Venus → PT → redeem 1:1 via SY → tokenOut to user
      //
      // Unlike withdraw (which sells PT on Pendle AMM at market price with slippage),
      // redeemAtMaturity redeems PT 1:1 through the SY contract:
      //   - No AMM swap, no price impact, no slippage from AMM
      //   - Uses redeemPyToToken() instead of swapExactPtForToken()
      //   - No LimitOrderData parameter needed
      //   - Only callable at or after maturity (atOrAfterMaturity modifier)
      //
      // tokensRedeemSy vs tokensOut routing still applies for the SY → tokenOut step:
      //   clisBNB (in tokensRedeemSy): PT → SY → SY.redeem() → clisBNB directly
      //   WBNB, native BNB (not in tokensRedeemSy): PT → SY → SY.redeem() → clisBNB → [Aggregator] → tokenOut
      //
      // NOTE: Tests time-travel ~1.5 years past maturity. Aggregator routing
      // calldata from the Pendle API may contain DEX swap deadlines that expire
      // after such a large time jump. Only clisBNB (direct redeemSy, no aggregator)
      // is guaranteed to work. WBNB and native BNB tests are attempted but may
      // require fallback to manually constructed TokenOutput if aggregator
      // deadlines expire. Aggregator routing is already fully tested in the
      // withdraw section above (pre-maturity, no time travel).
      //
      // ═══════════════════════════════════════════════════════════════════════

      describe("RedeemAtMaturity via adapter", () => {
        let depositPtAmount: any;
        let depositVTokenAmount: any;
        let preMaturitySnapshot: any;

        before(async () => {
          console.log("\n=== Setting up redeemAtMaturity tests ===");
          const depositAmount = parseUnits("3", 18);

          // Ensure user has enough slisBNB
          const currentBalance = await clisbnb.balanceOf(user.address);
          if (currentBalance.lt(depositAmount)) {
            await getSlisbnbViaListaDeposit(user, clisbnb, parseUnits("10", 18));
          }

          // Fetch deposit params from Pendle API (pre-maturity — API queries real chain)
          const marketConfig = await adapter.getMarketConfig(marketAddress);
          const { minPtOut, approxParams, tokenInput, limitOrderData } = await getPendleSwapParams(
            56,
            CLISBNB,
            marketConfig.pt,
            depositAmount,
            user.address,
            0.03,
            false,
          );

          // Approve adapter and ensure delegation is active
          await clisbnb.connect(user).approve(adapter.address, depositAmount);
          const isDelegated = await adapter.isDelegated(marketAddress, user.address);
          if (!isDelegated) {
            await comptroller.connect(user).updateDelegate(adapter.address, true);
          }

          // Deposit to get vTokens (pre-maturity)
          const tx = await adapter
            .connect(user)
            .deposit(marketAddress, depositAmount, minPtOut, approxParams, tokenInput, limitOrderData);
          const receipt = await tx.wait();

          // Extract amounts from Deposited event for PT↔vToken ratio
          const depositedEvent = receipt.events?.find((e: any) => e.event === "Deposited");
          depositPtAmount = depositedEvent!.args!.ptAmount;
          depositVTokenAmount = depositedEvent!.args!.vTokenAmount;

          const userVTokenBalance = await vToken.balanceOf(user.address);
          console.log(
            "User vToken balance for redeemAtMaturity tests:",
            ethers.utils.formatEther(userVTokenBalance),
          );
          console.log("PT deposited:", ethers.utils.formatEther(depositPtAmount));

          // ── Fix oracle staleness after time travel ──────────────────────
          // redeemBehalf triggers Comptroller → Resilient Oracle → Chainlink.
          // After ~1.5yr time travel, Chainlink feeds are stale.
          // Fix: capture valid price, then replace the comptroller's oracle
          // with a SimplePriceOracle that returns the stored price.
          const comptrollerForOracle = await ethers.getContractAt(
            [
              "function oracle() view returns (address)",
              "function admin() view returns (address)",
              "function _setPriceOracle(address newOracle) external returns (uint256)",
            ],
            COMPTROLLER,
          );
          const oracleAddr = await comptrollerForOracle.oracle();
          const currentOracle = await ethers.getContractAt(
            ["function getUnderlyingPrice(address vToken) view returns (uint256)"],
            oracleAddr,
          );
          const ptVTokenPrice = await currentOracle.getUnderlyingPrice(VTOKEN_PT_CLISBNBX_25JUN2026);
          console.log("Oracle price for PT vToken (pre-travel):", ptVTokenPrice.toString());

          // Take snapshot BEFORE time travel (restored in after() for subsequent tests)
          preMaturitySnapshot = await takeSnapshot();

          // Time travel past maturity
          const maturity = marketConfig.maturity.toNumber();
          await time.increaseTo(maturity + 1);
          console.log("Time traveled past maturity:", new Date((maturity + 1) * 1000).toISOString());

          // Deploy SimplePriceOracle and set the captured price
          const SimplePriceOracle = await ethers.getContractFactory("SimplePriceOracle");
          const simpleOracle = await SimplePriceOracle.deploy();
          await simpleOracle.deployed();
          await simpleOracle.setUnderlyingPrice(VTOKEN_PT_CLISBNBX_25JUN2026, ptVTokenPrice);

          // Impersonate comptroller admin and replace oracle
          const comptrollerAdmin = await comptrollerForOracle.admin();
          await impersonateAccount(comptrollerAdmin);
          await setBalance(comptrollerAdmin, parseUnits("10", 18));
          const adminSigner = await ethers.getSigner(comptrollerAdmin);
          const result = await comptrollerForOracle.connect(adminSigner)._setPriceOracle(simpleOracle.address);
          await result.wait();

          // Verify the oracle was actually changed
          const newOracleAddr = await comptrollerForOracle.oracle();
          console.log("Oracle before:", oracleAddr);
          console.log("Oracle after: ", newOracleAddr);
          console.log("SimplePriceOracle:", simpleOracle.address);
          expect(newOracleAddr).to.equal(simpleOracle.address);
        });

        after(async () => {
          // Restore pre-maturity state for subsequent test sections
          await preMaturitySnapshot.restore();
        });

        // ─────────────────────────────────────────────────────────────────────
        // Test 1: clisBNB — direct 1:1 redemption via SY (no aggregator)
        // ─────────────────────────────────────────────────────────────────────
        //
        // After maturity, PT redeems 1:1 through SY. Since clisBNB is in
        // tokensRedeemSy, SY directly unwraps to clisBNB — no aggregator needed.
        //
        // Flow: vTokens → redeem → PT → redeemPyToToken() → SY → clisBNB to user
        //
        // Unlike pre-maturity withdraw (AMM sell with price impact),
        // this is a pure 1:1 redemption — no slippage from AMM.
        // ─────────────────────────────────────────────────────────────────────
        it("should redeem to clisBNB (direct redeemSy) — 1:1 redemption, no AMM", async () => {
          const withdrawVTokenAmount = depositVTokenAmount.div(2);

          // Estimate PT from vToken redemption (ratio preserved, no interest accrued)
          const estimatedPt = withdrawVTokenAmount.mul(depositPtAmount).div(depositVTokenAmount);

          // Fetch TokenOutput from Pendle API
          // Note: API queries the real (pre-maturity) chain, but the TokenOutput routing
          // data (tokenRedeemSy, pendleSwap, swapData) is the same regardless of maturity —
          // it describes how SY unwraps to the final tokenOut.
          const { tokenOutput } = await getPendlePtToTokenParams(
            56,
            PT_CLISBNBX_25JUN2026,
            CLISBNB,
            estimatedPt,
            user.address,
            0.03,
            false, // enableAggregator — not needed, clisBNB is in tokensRedeemSy
          );

          // Verify API returned direct redeem path (no aggregator routing)
          expect(tokenOutput.tokenOut.toLowerCase()).to.equal(CLISBNB.toLowerCase());
          expect(tokenOutput.tokenRedeemSy.toLowerCase()).to.equal(CLISBNB.toLowerCase());
          expect(tokenOutput.pendleSwap).to.equal(ethers.constants.AddressZero);
          expect(tokenOutput.swapData.swapType).to.equal(0);

          // Record balances before redemption
          const userClisbnbBefore = await clisbnb.balanceOf(user.address);
          const userVTokenBefore = await vToken.balanceOf(user.address);
          const userPtBefore = await ptToken.balanceOf(user.address);

          // Execute redeemAtMaturity (no LimitOrderData — pure 1:1 redemption)
          const tx = await adapter
            .connect(user)
            .redeemAtMaturity(marketAddress, withdrawVTokenAmount, tokenOutput);
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
          expect(userPtAfter).to.equal(userPtBefore); // No PT leaked to user

          // Assert adapter holds zero balances (stateless between txs)
          expect(await clisbnb.balanceOf(adapter.address)).to.equal(0);
          expect(await ptToken.balanceOf(adapter.address)).to.equal(0);
          expect(await vToken.balanceOf(adapter.address)).to.equal(0);

          // Verify RedeemedAtMaturity event (NOT Withdrawn — different event for post-maturity)
          const redeemEvent = receipt.events?.find((e: any) => e.event === "RedeemedAtMaturity");
          expect(redeemEvent).to.not.be.undefined;

          const args = redeemEvent!.args!;
          expect(args.pendleMarket).to.equal(marketAddress);
          expect(args.user).to.equal(user.address);
          expect(args.vTokenAmount).to.equal(withdrawVTokenAmount);
          expect(args.ptAmount).to.be.gt(0);
          expect(args.tokenOut).to.equal(CLISBNB);
          expect(args.amountOut).to.equal(clisbnbReceived);

          console.log("\n=== clisBNB RedeemAtMaturity Results ===");
          console.log("vTokens redeemed:", ethers.utils.formatEther(vTokensRedeemed));
          console.log("PT redeemed (1:1):", ethers.utils.formatEther(args.ptAmount));
          console.log("clisBNB received:", ethers.utils.formatEther(clisbnbReceived));
        });

        // ─────────────────────────────────────────────────────────────────────
        // Test 2: WBNB — 1:1 redemption via SY + aggregator routing
        // ─────────────────────────────────────────────────────────────────────
        //
        // WBNB is NOT in tokensRedeemSy. After 1:1 PT redemption through SY,
        // the Router redeems SY to clisBNB, then routes through an aggregator
        // to swap clisBNB → WBNB.
        //
        // Flow: vTokens → redeem → PT → redeemPyToToken() → SY → clisBNB
        //       → [Aggregator] → WBNB to user
        //
        // NOTE: Aggregator calldata is fetched pre-maturity from the Pendle API.
        // After time-traveling ~1.5 years to maturity, DEX swap deadlines
        // embedded in the calldata may have expired, causing this test to fail.
        // ─────────────────────────────────────────────────────────────────────
        it("should redeem to WBNB (aggregator-routed) — 1:1 redemption + DEX swap", async () => {
          // Use half of remaining vTokens
          const userVTokenBalance = await vToken.balanceOf(user.address);
          const withdrawVTokenAmount = userVTokenBalance.div(2);

          // Estimate PT from vToken redemption
          const estimatedPt = withdrawVTokenAmount.mul(depositPtAmount).div(depositVTokenAmount);

          // Fetch TokenOutput from Pendle API (enableAggregator=true for WBNB)
          const { tokenOutput } = await getPendlePtToTokenParams(
            56,
            PT_CLISBNBX_25JUN2026,
            WBNB,
            estimatedPt,
            user.address,
            0.03,
            true, // enableAggregator — required, WBNB is NOT in tokensRedeemSy
          );

          // Verify API returned aggregator-routed path
          expect(tokenOutput.tokenOut.toLowerCase()).to.equal(WBNB.toLowerCase());
          expect(tokenOutput.pendleSwap).to.not.equal(ethers.constants.AddressZero);
          expect(tokenOutput.swapData.swapType).to.equal(1);

          // Record balances before redemption
          const userWbnbBefore = await wbnb.balanceOf(user.address);
          const userVTokenBefore = await vToken.balanceOf(user.address);
          const userPtBefore = await ptToken.balanceOf(user.address);

          // Execute redeemAtMaturity
          const tx = await adapter
            .connect(user)
            .redeemAtMaturity(marketAddress, withdrawVTokenAmount, tokenOutput);
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
          expect(userPtAfter).to.equal(userPtBefore); // No PT leaked to user

          // Assert adapter holds zero balances
          expect(await wbnb.balanceOf(adapter.address)).to.equal(0);
          expect(await clisbnb.balanceOf(adapter.address)).to.equal(0);
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
          expect(args.tokenOut).to.equal(WBNB);
          expect(args.amountOut).to.equal(wbnbReceived);

          console.log("\n=== WBNB RedeemAtMaturity Results ===");
          console.log("vTokens redeemed:", ethers.utils.formatEther(vTokensRedeemed));
          console.log("PT redeemed (1:1):", ethers.utils.formatEther(args.ptAmount));
          console.log("WBNB received:", ethers.utils.formatEther(wbnbReceived));
        });

        // ─────────────────────────────────────────────────────────────────────
        // Test 3: Native BNB — 1:1 redemption via SY + aggregator unwrap
        // ─────────────────────────────────────────────────────────────────────
        //
        // Native BNB (address(0)) is NOT in tokensRedeemSy.
        // After 1:1 PT redemption through SY, the Router redeems SY to clisBNB,
        // then routes through an aggregator to unwrap to native BNB.
        //
        // Flow: vTokens → redeem → PT → redeemPyToToken() → SY → clisBNB
        //       → [Aggregator] → native BNB to user
        // ─────────────────────────────────────────────────────────────────────
        it("should redeem to native BNB — 1:1 redemption + aggregator unwrap", async () => {
          // Use half of remaining vTokens
          const userVTokenBalance = await vToken.balanceOf(user.address);
          const withdrawVTokenAmount = userVTokenBalance.div(2);

          // Estimate PT from vToken redemption
          const estimatedPt = withdrawVTokenAmount.mul(depositPtAmount).div(depositVTokenAmount);

          // Fetch TokenOutput for native BNB output
          const NATIVE = ethers.constants.AddressZero;
          const { tokenOutput } = await getPendlePtToTokenParams(
            56,
            PT_CLISBNBX_25JUN2026,
            NATIVE,
            estimatedPt,
            user.address,
            0.03,
            true, // enableAggregator — required, native BNB not in tokensRedeemSy
          );

          // Record balances before redemption
          const userBnbBefore = await ethers.provider.getBalance(user.address);
          const userVTokenBefore = await vToken.balanceOf(user.address);
          const userPtBefore = await ptToken.balanceOf(user.address);

          // Execute redeemAtMaturity
          const tx = await adapter
            .connect(user)
            .redeemAtMaturity(marketAddress, withdrawVTokenAmount, tokenOutput);
          const receipt = await tx.wait();
          const gasUsed = receipt.gasUsed.mul(receipt.effectiveGasPrice);

          // Record balances after redemption
          const userBnbAfter = await ethers.provider.getBalance(user.address);
          const userVTokenAfter = await vToken.balanceOf(user.address);
          const userPtAfter = await ptToken.balanceOf(user.address);

          const bnbReceived = userBnbAfter.sub(userBnbBefore).add(gasUsed); // Add back gas
          const vTokensRedeemed = userVTokenBefore.sub(userVTokenAfter);

          // Assert user balance changes
          expect(vTokensRedeemed).to.equal(withdrawVTokenAmount);
          expect(bnbReceived).to.be.gt(0);
          expect(userPtAfter).to.equal(userPtBefore); // No PT leaked to user

          // Assert adapter holds zero balances
          expect(await ptToken.balanceOf(adapter.address)).to.equal(0);
          expect(await vToken.balanceOf(adapter.address)).to.equal(0);
          expect(await ethers.provider.getBalance(adapter.address)).to.equal(0);

          // Verify RedeemedAtMaturity event
          const redeemEvent = receipt.events?.find((e: any) => e.event === "RedeemedAtMaturity");
          expect(redeemEvent).to.not.be.undefined;

          const args = redeemEvent!.args!;
          expect(args.pendleMarket).to.equal(marketAddress);
          expect(args.user).to.equal(user.address);
          expect(args.vTokenAmount).to.equal(withdrawVTokenAmount);
          expect(args.ptAmount).to.be.gt(0);
          expect(args.tokenOut).to.equal(NATIVE);
          expect(args.amountOut).to.be.gt(0);

          console.log("\n=== Native BNB RedeemAtMaturity Results ===");
          console.log("vTokens redeemed:", ethers.utils.formatEther(vTokensRedeemed));
          console.log("PT redeemed (1:1):", ethers.utils.formatEther(args.ptAmount));
          console.log("BNB received:", ethers.utils.formatEther(bnbReceived));
        });
      });

      // ═══════════════════════════════════════════════════════════════════════
      //                    REDEEM AT MATURITY ERROR CASES
      // ═══════════════════════════════════════════════════════════════════════
      //
      // After the above describe's after() hook, the snapshot is restored to
      // pre-maturity state. Error cases that need post-maturity use per-test
      // snapshots with time travel.
      //
      // Modifier execution order for redeemAtMaturity:
      //   whenNotPaused → nonReentrant → onlyActiveMarket → atOrAfterMaturity → body
      // This means Paused/MarketNotRegistered/MarketNotActive revert before the
      // maturity check, so they can be tested in pre-maturity state.
      // ═══════════════════════════════════════════════════════════════════════

      describe("RedeemAtMaturity error cases", () => {
        const redeemAmount = parseUnits("1", 18);

        it("should revert with MarketNotMatured when called before maturity", async () => {
          // We are in pre-maturity state (snapshot restored by the after() hook above)
          const output = getDummyTokenOutput(CLISBNB);

          await expect(
            adapter.connect(user).redeemAtMaturity(marketAddress, redeemAmount, output),
          ).to.be.revertedWithCustomError(adapter, "MarketNotMatured");
        });

        it("should revert with ZeroAmount when vTokenAmount is 0", async () => {
          // ZeroAmount check is in the function body, AFTER atOrAfterMaturity modifier
          // → must time-travel past maturity for this check to be reached
          const snapshot = await takeSnapshot();

          const marketConfig = await adapter.getMarketConfig(marketAddress);
          await time.increaseTo(marketConfig.maturity.toNumber() + 1);

          const output = getDummyTokenOutput(CLISBNB);

          await expect(
            adapter.connect(user).redeemAtMaturity(marketAddress, 0, output),
          ).to.be.revertedWithCustomError(adapter, "ZeroAmount");

          await snapshot.restore();
        });

        it("should revert with MarketNotRegistered for unregistered market", async () => {
          const fakeMarket = "0x0000000000000000000000000000000000001234";
          const output = getDummyTokenOutput(CLISBNB);

          await expect(adapter.connect(user).redeemAtMaturity(fakeMarket, redeemAmount, output))
            .to.be.revertedWithCustomError(adapter, "MarketNotRegistered")
            .withArgs(fakeMarket);
        });

        it("should revert with MarketNotActive when market is deactivated", async () => {
          const snapshot = await takeSnapshot();

          await adapter.connect(owner).deactivateMarket(marketAddress);

          const output = getDummyTokenOutput(CLISBNB);

          await expect(adapter.connect(user).redeemAtMaturity(marketAddress, redeemAmount, output))
            .to.be.revertedWithCustomError(adapter, "MarketNotActive")
            .withArgs(marketAddress);

          await snapshot.restore();
        });

        it("should revert when contract is paused", async () => {
          const snapshot = await takeSnapshot();

          await adapter.connect(owner).pause();

          const output = getDummyTokenOutput(CLISBNB);

          await expect(
            adapter.connect(user).redeemAtMaturity(marketAddress, redeemAmount, output),
          ).to.be.revertedWith("Pausable: paused");

          await snapshot.restore();
        });

        it("should revert when user has not delegated to adapter (redeemBehalf fails)", async () => {
          // Delegation check happens inside _redeemVTokens, AFTER all modifiers pass
          // → must time-travel past maturity
          const snapshot = await takeSnapshot();

          const marketConfig = await adapter.getMarketConfig(marketAddress);
          await time.increaseTo(marketConfig.maturity.toNumber() + 1);

          // Revoke delegation
          await comptroller.connect(user).updateDelegate(adapter.address, false);

          const output = getDummyTokenOutput(CLISBNB);

          await expect(
            adapter.connect(user).redeemAtMaturity(marketAddress, redeemAmount, output),
          ).to.be.reverted;

          await snapshot.restore();
        });
      });
    });
  });
}
