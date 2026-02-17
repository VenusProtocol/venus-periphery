import "@nomicfoundation/hardhat-chai-matchers";
import { impersonateAccount, setBalance } from "@nomicfoundation/hardhat-network-helpers";
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
    ["function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)"],
    PANCAKE_ROUTER,
  );

  await wbnbToken.connect(signer).approve(PANCAKE_ROUTER, amount);
  const deadline = Math.floor(Date.now() / 1000) + 3600;
  await pancakeRouter.connect(signer).swapExactTokensForTokens(
    amount,
    0,
    [WBNB, CLISBNB],
    signer.address,
    deadline,
  );

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

  const stakeManager = await ethers.getContractAt(
    ["function deposit() external payable"],
    LISTA_STAKE_MANAGER,
  );

  await stakeManager.connect(signer).deposit({ value: amount });

  const balanceAfter = await slisbnbToken.balanceOf(signer.address);
  const received = balanceAfter.sub(balanceBefore);
  console.log("slisBNB received via ListaDAO deposit:", ethers.utils.formatEther(received));
  expect(received.gt(0)).to.be.true;
  return received;
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

        // Deploy PendlePTVaultAdapter implementation
        const PendlePTVaultAdapter = await ethers.getContractFactory("PendlePTVaultAdapter");
        const implementation = await PendlePTVaultAdapter.deploy(PENDLE_ROUTER_V3, WBNB);
        await implementation.deployed();

        // Deploy proxy with a separate admin address
        // Use a different address as proxy admin to avoid "admin cannot fallback" error
        const proxyAdminAddress = "0x0000000000000000000000000000000000000001"; // Dummy admin
        const data = implementation.interface.encodeFunctionData("initialize", [owner.address]);

        const TransparentUpgradeableProxy = await ethers.getContractFactory("@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol:TransparentUpgradeableProxy");
        const proxy = await TransparentUpgradeableProxy.deploy(implementation.address, proxyAdminAddress, data);
        await proxy.deployed();

        adapter = await ethers.getContractAt("PendlePTVaultAdapter", proxy.address);

        marketAddress = PENDLE_MARKET;

        // Add market to adapter (no underlying token constraint - accepts any token from Pendle's tokensIn)
        await adapter.connect(owner).addMarket(
          marketAddress,
          VTOKEN_PT_CLISBNBX_25JUN2026, // vToken
          COMPTROLLER, // comptroller
        );

        console.log("\n=== Market added to adapter ===");

        // Get market config from adapter (which contains PT, SY, YT addresses from Pendle)
        const marketConfig = await adapter.getMarketConfig(marketAddress);
        expect(marketConfig.pt).to.equal(PT_CLISBNBX_25JUN2026);
        console.log("Maturity:", new Date(marketConfig.maturity.toNumber() * 1000).toISOString());

        // Get PT token instance from the stored config
        ptToken = await ethers.getContractAt("IERC20", marketConfig.pt);
      });

      // ═══════════════════════════════════════════════════════════════════════
      // Deposit with slisBNB (tokenIn present in tokensMintSy)
      // ═══════════════════════════════════════════════════════════════════════
      //
      // slisBNB (0xB0b84D294e0C75A6abe60171b70edEb2EFd14A1B) is listed in the market's
      // `tokensMintSy` array. This means Pendle's SY contract can directly wrap slisBNB into
      // the Standardized Yield (SY) token without needing any external DEX aggregator swap.
      //
      // Flow: slisBNB → SY.deposit() → SY → PT (via Pendle AMM) → Venus vToken
      //
      // Because slisBNB is a direct mintSy token:
      //   - tokenInput.tokenMintSy == tokenInput.tokenIn (same token, no intermediate swap)
      //   - tokenInput.pendleSwap == address(0) (no aggregator needed)
      //   - tokenInput.swapData is empty (swapType=0, no external router call)
      //
      // In the next test we will use WBNB as tokenIn, which is in `tokensIn` but NOT in
      // `tokensMintSy`. For such tokens, Pendle's aggregator routing kicks in — the SDK
      // returns a non-zero pendleSwap address, swapData with external router calldata,
      // and tokenMintSy will differ from tokenIn (e.g. tokenIn=WBNB, tokenMintSy=slisBNB).
      // ═══════════════════════════════════════════════════════════════════════

      describe("Deposit via adapter", () => {
        // ─────────────────────────────────────────────────────────────────────
        // Test 1: slisBNB — tokenIn is in tokensMintSy (direct SY mint path)
        // ─────────────────────────────────────────────────────────────────────
        it("should deposit slisBNB (direct mintSy token) → PT → Venus", async () => {
          const depositAmount = parseUnits("1", 18); // 1 slisBNB

          // Step 1: Acquire slisBNB by staking native BNB on ListaDAO
          const mintedSlisbnb = await getSlisbnbViaListaDeposit(user, clisbnb, parseUnits("10", 18));
          expect(mintedSlisbnb).to.be.gte(depositAmount);

          // Step 2: Fetch swap parameters from Pendle API (enableAggregator=false)
          // slisBNB is in tokensMintSy — Pendle's SY contract can directly wrap it into SY
          // without any external DEX aggregator swap.
          // Flow: slisBNB → SY.deposit() → SY → PT (via Pendle AMM) → Venus vToken
          const marketConfig = await adapter.getMarketConfig(marketAddress);
          const { minPtOut, approxParams, tokenInput, limitOrderData } = await getPendleSwapParams(
            56, // BSC chainId
            CLISBNB,
            marketConfig.pt,
            depositAmount,
            user.address,
            0.03, // 3% slippage
            false, // enableAggregator — not needed for direct mintSy tokens
          );

          // Verify API returned direct mint path (no aggregator routing):
          //   - tokenIn == tokenMintSy (same token, SY can wrap it directly)
          //   - pendleSwap == address(0) (no intermediate DEX swap)
          //   - swapData.swapType == 0 (no external router call)
          expect(tokenInput.tokenIn.toLowerCase()).to.equal(CLISBNB.toLowerCase());
          expect(tokenInput.netTokenIn).to.equal(depositAmount);
          expect(tokenInput.tokenMintSy.toLowerCase()).to.equal(tokenInput.tokenIn.toLowerCase());
          expect(tokenInput.pendleSwap).to.equal(ethers.constants.AddressZero);
          expect(tokenInput.swapData.swapType).to.equal(0);

          // Step 3: Record balances before deposit
          const userSlisbnbBefore = await clisbnb.balanceOf(user.address);
          const userVTokenBefore = await vToken.balanceOf(user.address);
          const userPtBefore = await ptToken.balanceOf(user.address);

          // Step 4: Approve adapter for token transfer and Venus delegation
          await clisbnb.connect(user).approve(adapter.address, depositAmount);
          const comptroller = await ethers.getContractAt("IMarketFacet", COMPTROLLER);
          await comptroller.connect(user).updateDelegate(adapter.address, true);

          // Step 5: Execute deposit
          const tx = await adapter.connect(user).deposit(
            marketAddress,
            depositAmount,
            minPtOut,
            approxParams,
            tokenInput,
            limitOrderData,
          );
          const receipt = await tx.wait();

          // Step 6: Record balances after deposit
          const userSlisbnbAfter = await clisbnb.balanceOf(user.address);
          const userVTokenAfter = await vToken.balanceOf(user.address);
          const userPtAfter = await ptToken.balanceOf(user.address);

          const slisbnbSpent = userSlisbnbBefore.sub(userSlisbnbAfter);
          const vTokensMinted = userVTokenAfter.sub(userVTokenBefore);

          // Step 7: Assert user balance changes
          expect(slisbnbSpent).to.equal(depositAmount); // Exact amount taken from user
          expect(vTokensMinted).to.be.gt(0); // User received vTokens
          expect(userPtAfter).to.equal(userPtBefore); // No PT leaked to user (all deposited into Venus)

          // Step 8: Assert adapter holds zero balances (stateless between txs)
          expect(await clisbnb.balanceOf(adapter.address)).to.equal(0);
          expect(await ptToken.balanceOf(adapter.address)).to.equal(0);
          expect(await vToken.balanceOf(adapter.address)).to.equal(0);

          // Step 9: Verify Deposited event
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

          // Revoke delegation after test so next test can set it fresh
          await comptroller.connect(user).updateDelegate(adapter.address, false);
        });
      });
    });
  });
}