import "@nomicfoundation/hardhat-chai-matchers";
import { impersonateAccount, setBalance, takeSnapshot, time } from "@nomicfoundation/hardhat-network-helpers";
import chai from "chai";
import { parseUnits } from "ethers/lib/utils";
import { ethers } from "hardhat";

import { FORK_MAINNET, forking } from "./utils";
import { getPendleSwapParams } from "./utils/pendleApi";

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

        it("should revert when Pendle market has expired (Pendle Router rejects)", async () => {
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

          // Attempt deposit after maturity — Pendle Router should reject
          await expect(
            adapter
              .connect(user)
              .deposit(marketAddress, depositAmount, minPtOut, approxParams, tokenInput, limitOrderData),
          ).to.be.reverted;
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
    });
  });
}
