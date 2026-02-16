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

// Whale address with WBNB balance (Binance Hot Wallet)
const WBNB_WHALE = "0x8894E0a0c962CB723c1976a4421c95949bE2D4E3";

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

        // Swap WBNB to clisBNB using PancakeSwap
        console.log("\n=== Swapping WBNB to clisBNB ===");
        const swapAmount = parseUnits("500", 18); // Swap 500 WBNB to clisBNB (enough to get >1 clisBNB)
        const pancakeRouter = await ethers.getContractAt(
          ["function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)"],
          PANCAKE_ROUTER,
        );

        await wbnb.connect(user).approve(PANCAKE_ROUTER, swapAmount);
        const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
        await pancakeRouter.connect(user).swapExactTokensForTokens(
          swapAmount,
          0, // Accept any amount of clisBNB
          [WBNB, CLISBNB],
          user.address,
          deadline,
        );

        const clisbnbBalance = await clisbnb.balanceOf(user.address);
        console.log("User clisBNB balance after swap:", ethers.utils.formatEther(clisbnbBalance));

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

      describe("Deposit Function - Pendle Integration", () => {
        const depositAmount = parseUnits("0.02", 18); // 0.02 clisBNB (adjusted for swap output)

        it("should fetch market data and prepare for deposit", async () => {
          const userClisbnbBalance = await clisbnb.balanceOf(user.address);
          console.log("\nUser clisBNB Balance:", ethers.utils.formatEther(userClisbnbBalance));
          expect(userClisbnbBalance.gte(depositAmount)).to.be.true;
        });

        it("should successfully deposit clisBNB and receive vPT-clisBNB-25JUN2026", async () => {
          console.log("\n=== Fetching parameters from Pendle API ===" );

          const chainId = 56; // BSC Mainnet
          const slippage = 0.03; // 3% slippage tolerance

          // Get market config to extract PT token address
          const marketConfig = await adapter.getMarketConfig(marketAddress);
          const ptTokenAddress = marketConfig.pt;

          // Fetch all swap parameters from Pendle API
          const { minPtOut, approxParams, tokenInput, limitOrderData } = await getPendleSwapParams(
            chainId,
            CLISBNB,
            ptTokenAddress,
            depositAmount,
            user.address,
            slippage,
          );

          console.log("Min PT Out (from API):", ethers.utils.formatEther(minPtOut));
          console.log("ApproxParams (from API):");
          console.log("  guessMin:", ethers.utils.formatEther(approxParams.guessMin));
          console.log("  guessMax:", ethers.utils.formatEther(approxParams.guessMax));
          console.log("  guessOffchain:", ethers.utils.formatEther(approxParams.guessOffchain));
          console.log("TokenInput:", {
            tokenIn: tokenInput.tokenIn,
            netTokenIn: ethers.utils.formatEther(tokenInput.netTokenIn),
            tokenMintSy: tokenInput.tokenMintSy,
          });

          // Get balances before
          const userClisbnbBefore = await clisbnb.balanceOf(user.address);
          const userVTokenBefore = await vToken.balanceOf(user.address);
          const userPtBefore = await ptToken.balanceOf(user.address);

          console.log("\n=== Before Deposit ===");
          console.log("User clisBNB:", ethers.utils.formatEther(userClisbnbBefore));
          console.log("User vToken:", ethers.utils.formatEther(userVTokenBefore));
          console.log("User PT:", ethers.utils.formatEther(userPtBefore));

          // Approve adapter to spend clisBNB
          await clisbnb.connect(user).approve(adapter.address, depositAmount);

          // Approve adapter to act on behalf of user in Venus (for mintBehalf)
          const comptroller = await ethers.getContractAt("IMarketFacet", COMPTROLLER);
          await comptroller.connect(user).updateDelegate(adapter.address, true);

          console.log("\n=== Approvals Done ===");
          console.log("clisBNB approved to adapter");
          console.log("Adapter approved as delegate in Venus");

          // Execute deposit
          console.log("\n=== Executing Deposit ===");
          const tx = await adapter.connect(user).deposit(
            marketAddress,
            depositAmount,
            minPtOut,
            approxParams,
            tokenInput,
            limitOrderData,
          );

          const receipt = await tx.wait();
          console.log("Transaction hash:", receipt.transactionHash);
          console.log("Gas used:", receipt.gasUsed.toString());

          // Get balances after
          const userClisbnbAfter = await clisbnb.balanceOf(user.address);
          const userVTokenAfter = await vToken.balanceOf(user.address);
          const userPtAfter = await ptToken.balanceOf(user.address);

          console.log("\n=== After Deposit ===");
          console.log("User clisBNB:", ethers.utils.formatEther(userClisbnbAfter));
          console.log("User vToken:", ethers.utils.formatEther(userVTokenAfter));
          console.log("User PT:", ethers.utils.formatEther(userPtAfter));

          const clisbnbSpent = userClisbnbBefore.sub(userClisbnbAfter);
          const vTokensMinted = userVTokenAfter.sub(userVTokenBefore);
          const ptGained = userPtAfter.sub(userPtBefore);

          console.log("\n=== Changes ===");
          console.log("clisBNB Spent:", ethers.utils.formatEther(clisbnbSpent));
          console.log("vTokens Minted:", ethers.utils.formatEther(vTokensMinted));
          console.log("PT Gained (should be 0, PT stays in Venus):", ethers.utils.formatEther(ptGained));

          // Assertions
          expect(clisbnbSpent.lte(depositAmount)).to.be.true; // Should spend <= depositAmount (dust swept back)
          expect(vTokensMinted.gt(0)).to.be.true; // Should mint some vTokens
          expect(userPtAfter.eq(userPtBefore)).to.be.true; // User shouldn't have PT (it's in Venus)

          // Check that adapter has no leftover balances
          const adapterClisbnbBalance = await clisbnb.balanceOf(adapter.address);
          const adapterPtBalance = await ptToken.balanceOf(adapter.address);
          const adapterVTokenBalance = await vToken.balanceOf(adapter.address);

          console.log("\n=== Adapter Balances (should be 0) ===");
          console.log("Adapter clisBNB:", ethers.utils.formatEther(adapterClisbnbBalance));
          console.log("Adapter PT:", ethers.utils.formatEther(adapterPtBalance));
          console.log("Adapter vToken:", ethers.utils.formatEther(adapterVTokenBalance));

          expect(adapterClisbnbBalance).to.equal(0); // Dust swept back
          expect(adapterPtBalance).to.equal(0); // PT deposited to Venus
          expect(adapterVTokenBalance).to.equal(0); // vTokens minted to user

          // Parse event
          const depositedEvent = receipt.events?.find((e: any) => e.event === "Deposited");
          if (depositedEvent) {
            console.log("\n=== Deposited Event ===");
            console.log("Market:", depositedEvent.args?.pendleMarket);
            console.log("User:", depositedEvent.args?.user);
            console.log("Token In:", depositedEvent.args?.tokenIn);
            console.log("Amount In:", ethers.utils.formatEther(depositedEvent.args?.amountIn));
            console.log("PT Amount:", ethers.utils.formatEther(depositedEvent.args?.ptAmount));
            console.log("vToken Amount:", ethers.utils.formatEther(depositedEvent.args?.vTokenAmount));

            expect(depositedEvent.args?.ptAmount.gte(minPtOut)).to.be.true;
            expect(depositedEvent.args?.tokenIn).to.equal(CLISBNB);
          }
        });
      });
    });
  });
}
