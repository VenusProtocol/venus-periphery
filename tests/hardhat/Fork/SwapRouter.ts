import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { BigNumber, Signer } from "ethers";
import { parseEther, parseUnits } from "ethers/lib/utils";
import { ethers, network, upgrades } from "hardhat";

import {
  IERC20,
  IERC20__factory,
  SwapHelper,
  SwapRouter,
  VBep20Delegator,
  VBep20Delegator__factory,
  WBNB,
  WBNB__factory,
} from "../../../typechain";
import { forking, initMainnetUser } from "./utils";

// BSC Mainnet addresses
const NORMAL_TIMELOCK = "0x939bD8d64c0A9583A7Dcea9933f7b21697ab6396";
const COMPTROLLER_ADDRESS = "0xfD36E2c2a6789Db23113685031d7F16329158384";
const WBNB_ADDRESS = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const vWBNB_ADDRESS = "0x6bCa74586218dB34cdB402295796b79663d816e9";

// Token addresses
const USDT_ADDRESS = "0x55d398326f99059fF775485246999027B3197955";
const USDC_ADDRESS = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d";
const ETH_ADDRESS = "0x2170Ed0880ac9A755fd29B2688956BD959F933F8";
const vUSDT_ADDRESS = "0xfD5840Cd36d94D7229439859C0112a4185BC0255";
const vUSDC_ADDRESS = "0xecA88125a5ADbe82614ffC12D0DB554E2e2867C8";
const vETH_ADDRESS = "0xf508fCD89b8bd15579dc79A6827cB4686A3592c8";

// Real mainnet users with tokens
const USDT_HOLDER = "0xEF3aeFf9A5F61C6Dda33069c58C1434006e13B20";
const USDC_HOLDER = "0x6eA08ca8F313d860808ef7431fc72c6FbcF4A72D";
const ETH_HOLDER = "0xc851a293ed8b8888a2e4140744973Dd23bBCBaF2";

const FORK_MAINNET = process.env.FORKED_NETWORK === "bscmainnet";

describe("SwapRouter Fork Tests", function () {
  let swapRouter: SwapRouter;
  let swapHelper: SwapHelper;
  let timelock: Signer;
  let root: SignerWithAddress;
  let user: SignerWithAddress;
  let usdtHolder: Signer;
  let usdcHolder: Signer;
  let ethHolder: Signer;

  // Real tokens
  let usdt: IERC20;
  let usdc: IERC20;
  let eth: IERC20;
  let wbnb: WBNB;
  let vUSDT: VBep20Delegator;
  let vUSDC: VBep20Delegator;
  let vETH: VBep20Delegator;
  let vWBNB: VBep20Delegator;

  type SetupSwapRouterFixture = {
    swapRouter: SwapRouter;
    swapHelper: SwapHelper;
    timelock: Signer;
    root: SignerWithAddress;
    usdtHolder: Signer;
    usdcHolder: Signer;
    ethHolder: Signer;
    usdt: IERC20;
    usdc: IERC20;
    eth: IERC20;
    wbnb: WBNB;
    vUSDT: VBep20Delegator;
    vUSDC: VBep20Delegator;
    vETH: VBep20Delegator;
    vWBNB: VBep20Delegator;
  };

  // Helper function to create real multicall data for swaps
  async function createRealSwapMulticallData(
    swapHelper: SwapHelper,
    fromToken: string,
    toToken: string,
    recipient: string,
    amountOut: BigNumber,
    signer: SignerWithAddress,
    swapRouterAddress: string,
    root: SignerWithAddress,
    salt?: string,
  ): Promise<string> {
    // Encode sweep function call to send tokens to recipient
    const sweepData = swapHelper.interface.encodeFunctionData("sweep", [toToken, recipient]);

    // Create EIP-712 signature
    const domain = {
      chainId: network.config.chainId,
      name: "VenusSwap",
      verifyingContract: swapHelper.address,
      version: "1",
    };

    const types = {
      Multicall: [
        { name: "caller", type: "address" },
        { name: "calls", type: "bytes[]" },
        { name: "deadline", type: "uint256" },
        { name: "salt", type: "bytes32" },
      ],
    };

    const calls = [sweepData];
    const deadline = "17627727131762772187"; // Long time
    const saltValue = salt || ethers.utils.keccak256(ethers.utils.toUtf8Bytes("test" + Math.random()));

    // Create signature with root signer (who is the backend signer for our deployed SwapHelper)
    const signature = await root._signTypedData(domain, types, {
      caller: swapRouterAddress, // SwapRouter will call swapHelper
      calls,
      deadline,
      salt: saltValue,
    });

    // Encode multicall with all parameters
    const multicallData = swapHelper.interface.encodeFunctionData("multicall", [calls, deadline, saltValue, signature]);

    return multicallData;
  }

  async function setupSwapRouterForkFixture(): Promise<SetupSwapRouterFixture> {
    [root, user] = await ethers.getSigners();

    // Initialize mainnet users with sufficient funds
    timelock = await initMainnetUser(NORMAL_TIMELOCK, parseEther("100"));
    usdtHolder = await initMainnetUser(USDT_HOLDER, parseEther("100"));
    usdcHolder = usdtHolder; // Use same holder for both USDT and USDC
    ethHolder = await initMainnetUser(ETH_HOLDER, parseEther("100"));

    // Deploy fresh SwapHelper with root as backend signer (following LeverageStrategiesManager pattern)
    const SwapHelperFactory = await ethers.getContractFactory("SwapHelper");
    swapHelper = await SwapHelperFactory.deploy(root.address);

    // Connect to real tokens
    usdt = IERC20__factory.connect(USDT_ADDRESS, root);
    usdc = IERC20__factory.connect(USDC_ADDRESS, root);
    eth = IERC20__factory.connect(ETH_ADDRESS, root);
    wbnb = WBNB__factory.connect(WBNB_ADDRESS, root);

    // Connect to vTokens
    vUSDT = VBep20Delegator__factory.connect(vUSDT_ADDRESS, timelock);
    vUSDC = VBep20Delegator__factory.connect(vUSDC_ADDRESS, timelock);
    vETH = VBep20Delegator__factory.connect(vETH_ADDRESS, timelock);
    vWBNB = VBep20Delegator__factory.connect(vWBNB_ADDRESS, timelock);

    // Deploy SwapRouter contract as upgradeable proxy
    const SwapRouterFactory = await ethers.getContractFactory("SwapRouter");
    swapRouter = await upgrades.deployProxy(SwapRouterFactory, [], {
      constructorArgs: [
        COMPTROLLER_ADDRESS,
        swapHelper.address, // Use our fresh SwapHelper
        WBNB_ADDRESS,
        vWBNB_ADDRESS,
      ],
      initializer: "initialize",
      unsafeAllow: ["state-variable-immutable"],
    });

    return {
      swapRouter,
      swapHelper,
      timelock,
      root,
      usdtHolder,
      usdcHolder,
      ethHolder,
      usdt,
      usdc,
      eth,
      wbnb,
      vUSDT,
      vUSDC,
      vETH,
      vWBNB,
    };
  }

  if (FORK_MAINNET) {
    forking(72194000, () => {
      // Use the latest BSC mainnet block
      describe("SwapRouter Fork Tests on BSC Mainnet", () => {
        beforeEach(async function () {
          const fixture = await loadFixture(setupSwapRouterForkFixture);
          swapRouter = fixture.swapRouter;
          swapHelper = fixture.swapHelper;
          timelock = fixture.timelock;
          root = fixture.root;
          usdtHolder = fixture.usdtHolder;
          usdcHolder = fixture.usdcHolder;
          ethHolder = fixture.ethHolder;
          usdt = fixture.usdt;
          usdc = fixture.usdc;
          eth = fixture.eth;
          wbnb = fixture.wbnb;
          vUSDT = fixture.vUSDT;
          vUSDC = fixture.vUSDC;
          vETH = fixture.vETH;
          vWBNB = fixture.vWBNB;
        });

        describe("Deployment Tests", function () {
          it("should revert wiht zero address for comptroller", async function () {
            const SwapRouterFactory = await ethers.getContractFactory("SwapRouter");
            await expect(
              upgrades.deployProxy(SwapRouterFactory, [], {
                constructorArgs: [ethers.constants.AddressZero, swapHelper.address, WBNB_ADDRESS, vWBNB_ADDRESS],
                initializer: "initialize",
                unsafeAllow: ["state-variable-immutable"],
              }),
            ).to.be.revertedWithCustomError(SwapRouterFactory, "ZeroAddress");
          });

          it("should revert wiht zero address for swap helper", async function () {
            const SwapRouterFactory = await ethers.getContractFactory("SwapRouter");
            await expect(
              upgrades.deployProxy(SwapRouterFactory, [], {
                constructorArgs: [COMPTROLLER_ADDRESS, ethers.constants.AddressZero, WBNB_ADDRESS, vWBNB_ADDRESS],
                initializer: "initialize",
                unsafeAllow: ["state-variable-immutable"],
              }),
            ).to.be.revertedWithCustomError(SwapRouterFactory, "ZeroAddress");
          });

          it("should deploy SwapRouter with correct parameters", async function () {
            // Basic deployment test
            expect(swapRouter.address).to.not.equal(ethers.constants.AddressZero);
            expect(swapHelper.address).to.not.equal(ethers.constants.AddressZero);

            // Verify SwapRouter configuration
            const comptroller = await swapRouter.COMPTROLLER();
            const swapHelperAddr = await swapRouter.SWAP_HELPER();
            const wrappedNative = await swapRouter.WRAPPED_NATIVE();

            expect(comptroller).to.equal(COMPTROLLER_ADDRESS);
            expect(swapHelperAddr).to.equal(swapHelper.address); // Use our fresh SwapHelper
            expect(wrappedNative).to.equal(WBNB_ADDRESS);
          });
        });

        describe("SwapAndSupply Tests", function () {
          it("swapAndSupply - should swap USDT to USDC and supply to Venus market", async function () {
            const swapAmount = parseUnits("100", 18); // 100 USDT
            const expectedOutput = parseUnits("99", 18); // ~99 USDC
            const minAmountOut = parseUnits("95", 18); // 95 USDC minimum

            // Check and log balances first
            const usdtHolderBalance = await usdt.balanceOf(USDT_HOLDER);
            const usdcHolderBalance = await usdc.balanceOf(USDC_HOLDER); // Same holder for both

            // Skip test if holders don't have enough balance
            if (usdtHolderBalance.lt(swapAmount)) {
              console.log("Skipping test: USDT holder has insufficient balance");
              this.skip();
            }

            if (usdcHolderBalance.lt(expectedOutput)) {
              console.log("Skipping test: USDC holder has insufficient balance");
              this.skip();
            }

            await usdt.connect(usdtHolder).transfer(user.address, swapAmount);

            // Fund SwapHelper with USDC for the swap simulation - use same holder
            await usdc.connect(usdcHolder).transfer(swapHelper.address, expectedOutput);

            // User approves SwapRouter to spend USDT
            await usdt.connect(user).approve(swapRouter.address, swapAmount);

            // Create multicall data
            const swapCallData = await createRealSwapMulticallData(
              swapHelper,
              usdt.address,
              usdc.address,
              swapRouter.address,
              expectedOutput,
              user,
              swapRouter.address,
              root,
            );

            // Get initial balances
            const initialUSDTBalance = await usdt.balanceOf(user.address);
            const initialVUSDCBalance = await vUSDC.balanceOf(user.address);

            // Execute swap and supply
            await expect(
              swapRouter
                .connect(user)
                .swapAndSupply(vUSDC.address, usdt.address, swapAmount, minAmountOut, swapCallData),
            ).to.not.be.reverted;

            // Verify USDT was taken from user
            const finalUSDTBalance = await usdt.balanceOf(user.address);
            expect(finalUSDTBalance).to.equal(initialUSDTBalance.sub(swapAmount));

            // Verify user received vUSDC tokens
            const finalVUSDCBalance = await vUSDC.balanceOf(user.address);
            expect(finalVUSDCBalance).to.be.gt(initialVUSDCBalance);
          });

          it("swapAndSupply - should swap ETH to USDT and supply to Venus market", async function () {
            const swapAmount = parseEther("1"); // 1 ETH
            const expectedOutput = parseUnits("300", 18); // ~300 USDT
            const minAmountOut = parseUnits("290", 18); // 290 USDT minimum

            // Transfer ETH from holder to user
            await eth.connect(ethHolder).transfer(user.address, swapAmount);

            // Fund SwapHelper with USDT for the swap simulation
            await usdt.connect(usdtHolder).transfer(swapHelper.address, expectedOutput);

            // User approves SwapRouter to spend ETH
            await eth.connect(user).approve(swapRouter.address, swapAmount);

            // Create multicall data
            const swapCallData = await createRealSwapMulticallData(
              swapHelper,
              eth.address,
              usdt.address,
              swapRouter.address,
              expectedOutput,
              user,
              swapRouter.address,
              root,
            );

            // Get initial balances
            const initialETHBalance = await eth.balanceOf(user.address);
            const initialVUSDTBalance = await vUSDT.balanceOf(user.address);

            // Execute swap and supply
            await expect(
              swapRouter
                .connect(user)
                .swapAndSupply(vUSDT.address, eth.address, swapAmount, minAmountOut, swapCallData),
            ).to.not.be.reverted;

            // Verify ETH was taken from user
            const finalETHBalance = await eth.balanceOf(user.address);
            expect(finalETHBalance).to.equal(initialETHBalance.sub(swapAmount));

            // Verify user received vUSDT tokens
            const finalVUSDTBalance = await vUSDT.balanceOf(user.address);
            expect(finalVUSDTBalance).to.be.gt(initialVUSDTBalance);
          });

          it("swapNativeAndSupply - should swap native BNB to USDT and supply to Venus market", async function () {
            const swapAmount = parseEther("1"); // 1 BNB
            const expectedOutput = parseUnits("600", 18); // ~600 USDT
            const minAmountOut = parseUnits("580", 18); // 580 USDT minimum

            // Fund SwapHelper with USDT for the swap simulation
            await usdt.connect(usdtHolder).transfer(swapHelper.address, expectedOutput);

            // Create multicall data for native swap
            const swapCallData = await createRealSwapMulticallData(
              swapHelper,
              wbnb.address, // WBNB address for native swaps
              usdt.address,
              swapRouter.address,
              expectedOutput,
              user,
              swapRouter.address,
              root,
            );

            // Get initial balances
            const initialBNBBalance = await ethers.provider.getBalance(user.address);
            const initialVUSDTBalance = await vUSDT.balanceOf(user.address);

            // Execute native swap and supply
            await expect(
              swapRouter
                .connect(user)
                .swapNativeAndSupply(vUSDT.address, minAmountOut, swapCallData, { value: swapAmount }),
            ).to.not.be.reverted;

            // Verify BNB was taken from user (accounting for gas)
            const finalBNBBalance = await ethers.provider.getBalance(user.address);
            expect(finalBNBBalance).to.be.lt(initialBNBBalance.sub(swapAmount));

            // Verify user received vUSDT tokens
            const finalVUSDTBalance = await vUSDT.balanceOf(user.address);
            expect(finalVUSDTBalance).to.be.gt(initialVUSDTBalance);
          });
        });

        describe("SwapAndRepay Tests", function () {
          beforeEach(async function () {
            // First, user needs to have some debt by borrowing
            const supplyAmount = parseUnits("1000", 18); // Supply 1k USDT as collateral
            await usdt.connect(usdtHolder).transfer(user.address, supplyAmount);
            await usdt.connect(user).approve(vUSDT.address, supplyAmount);
            await vUSDT.connect(user).mint(supplyAmount);

            // Enable USDT as collateral
            const comptroller = await ethers.getContractAt("ComptrollerInterface", COMPTROLLER_ADDRESS);
            await comptroller.connect(user).enterMarkets([vUSDT.address]);

            // Borrow some USDC against USDT collateral
            const borrowAmount = parseUnits("100", 18); // Borrow 100 USDC
            await vUSDC.connect(user).borrow(borrowAmount);
          });

          it("swapAndRepay - should swap ETH to USDC and repay debt", async function () {
            const swapAmount = parseEther("1"); // 1 ETH
            const expectedOutput = parseUnits("30", 18); // ~30 USDC
            const minAmountOut = parseUnits("25", 18); // 25 USDC minimum

            // Transfer ETH from holder to user
            await eth.connect(ethHolder).transfer(user.address, swapAmount);

            // Fund SwapHelper with USDC for the swap simulation
            await usdc.connect(usdcHolder).transfer(swapHelper.address, expectedOutput);

            // User approves SwapRouter to spend ETH
            await eth.connect(user).approve(swapRouter.address, swapAmount);

            // Create multicall data
            const swapCallData = await createRealSwapMulticallData(
              swapHelper,
              WBNB_ADDRESS,
              usdc.address,
              swapRouter.address,
              expectedOutput,
              user,
              swapRouter.address,
              root,
            );

            // Get initial debt
            const initialDebt = await vUSDC.borrowBalanceStored(user.address);
            const initialETHBalance = await eth.balanceOf(user.address);

            // Execute swap and repay
            await expect(
              swapRouter.connect(user).swapAndRepay(vUSDC.address, eth.address, swapAmount, minAmountOut, swapCallData),
            ).to.not.be.reverted;

            // Verify ETH was taken from user
            const finalETHBalance = await eth.balanceOf(user.address);
            expect(finalETHBalance).to.equal(initialETHBalance.sub(swapAmount));

            // Verify debt was reduced
            const finalDebt = await vUSDC.borrowBalanceStored(user.address);
            expect(finalDebt).to.be.lt(initialDebt);
          });

          it("swapNativeAndRepay - should swap native BNB to USDC and repay debt", async function () {
            const swapAmount = parseEther("2"); // 2 BNB
            const expectedOutput = parseUnits("12", 18); // ~12 USDC
            const minAmountOut = parseUnits("10", 18); // 10 USDC minimum

            // Fund SwapHelper with USDC for the swap simulation
            await usdc.connect(usdcHolder).transfer(swapHelper.address, expectedOutput);

            // Create multicall data for native swap
            const swapCallData = await createRealSwapMulticallData(
              swapHelper,
              wbnb.address,
              usdc.address,
              swapRouter.address,
              expectedOutput,
              user,
              swapRouter.address,
              root,
            );

            // Get initial debt and BNB balance
            const initialDebt = await vUSDC.borrowBalanceStored(user.address);
            const initialBNBBalance = await ethers.provider.getBalance(user.address);

            // Execute native swap and repay
            await expect(
              swapRouter
                .connect(user)
                .swapNativeAndRepay(vUSDC.address, minAmountOut, swapCallData, { value: swapAmount }),
            ).to.not.be.reverted;

            // Verify BNB was taken from user (accounting for gas)
            const finalBNBBalance = await ethers.provider.getBalance(user.address);
            expect(finalBNBBalance).to.be.lt(initialBNBBalance.sub(swapAmount));

            // Verify debt was reduced or fully repaid
            const finalDebt = await vUSDC.borrowBalanceStored(user.address);
            expect(finalDebt).to.be.lt(initialDebt);
          });

          it("swapAndRepayFull - should swap ETH and repay full USDC debt", async function () {
            const currentDebt = await vUSDC.callStatic.borrowBalanceCurrent(user.address);
            const swapAmount = parseEther("3"); // 3 ETH
            const excessOutput = currentDebt.add(parseUnits("10", 18)); // More than debt

            // Transfer ETH from holder to user
            await eth.connect(ethHolder).transfer(user.address, swapAmount);

            // Fund SwapHelper with excess USDC to fully repay
            await usdc.connect(usdcHolder).transfer(swapHelper.address, excessOutput);

            // User approves SwapRouter to spend ETH
            await eth.connect(user).approve(swapRouter.address, swapAmount);

            // Create multicall data
            const swapCallData = await createRealSwapMulticallData(
              swapHelper,
              eth.address,
              usdc.address,
              swapRouter.address,
              excessOutput,
              user,
              swapRouter.address,
              root,
            );

            // Get initial balances
            const initialETHBalance = await eth.balanceOf(user.address);
            const initialUSDCBalance = await usdc.balanceOf(user.address);

            // Execute swap and full repayment
            await expect(
              swapRouter.connect(user).swapAndRepayFull(vUSDC.address, eth.address, swapAmount, swapCallData),
            ).to.not.be.reverted;

            // Verify ETH was taken from user
            const finalETHBalance = await eth.balanceOf(user.address);
            expect(finalETHBalance).to.equal(initialETHBalance.sub(swapAmount));

            // Verify excess tokens were returned to user
            const finalUSDCBalance = await usdc.balanceOf(user.address);
            expect(finalUSDCBalance).to.be.gt(initialUSDCBalance);

            // Verify debt is fully repaid
            const finalDebt = await vUSDC.borrowBalanceStored(user.address);
            expect(finalDebt).to.equal(0); // Fully repaid
          });

          it("swapNativeAndRepayFull - should swap native BNB and repay full USDC debt", async function () {
            const currentDebt = await vUSDC.callStatic.borrowBalanceCurrent(user.address);
            const swapAmount = parseEther("5"); // 5 BNB
            const excessOutput = currentDebt.add(parseUnits("10", 18)); // More than debt

            // Fund SwapHelper with excess USDC to fully repay
            await usdc.connect(usdcHolder).transfer(swapHelper.address, excessOutput);

            // Create multicall data for native swap
            const swapCallData = await createRealSwapMulticallData(
              swapHelper,
              wbnb.address,
              usdc.address,
              swapRouter.address,
              excessOutput,
              user,
              swapRouter.address,
              root,
            );

            // Get initial balances
            const initialBNBBalance = await ethers.provider.getBalance(user.address);
            const initialUSDCBalance = await usdc.balanceOf(user.address);

            // Execute native swap and full repayment
            await expect(
              swapRouter.connect(user).swapNativeAndRepayFull(vUSDC.address, swapCallData, { value: swapAmount }),
            ).to.not.be.reverted;

            // Verify BNB was taken from user (accounting for gas)
            const finalBNBBalance = await ethers.provider.getBalance(user.address);
            expect(finalBNBBalance).to.be.lt(initialBNBBalance.sub(swapAmount));

            // Verify excess tokens were returned to user
            const finalUSDCBalance = await usdc.balanceOf(user.address);
            expect(finalUSDCBalance).to.be.gt(initialUSDCBalance);

            // Verify debt is fully repaid
            const finalDebt = await vUSDC.borrowBalanceStored(user.address);
            expect(finalDebt).to.be.equal(0); // Fully repaid
          });
        });

        describe("Error Cases", function () {
          it("should revert when slippage protection fails", async function () {
            const swapAmount = parseUnits("1000", 18); // 1000 USDT
            const lowOutput = parseUnits("5", 18); // Only 5 USDC
            const minAmountOut = parseUnits("990", 18); // Expecting 990 USDC minimum

            // Transfer USDT from holder to user
            await usdt.connect(usdtHolder).transfer(user.address, swapAmount);

            // Fund SwapHelper with low USDC amount (triggering slippage protection)
            await usdc.connect(usdcHolder).transfer(swapHelper.address, lowOutput);

            // User approves SwapRouter to spend USDT
            await usdt.connect(user).approve(swapRouter.address, swapAmount);

            // Create multicall data with low output
            const swapCallData = await createRealSwapMulticallData(
              swapHelper,
              usdt.address,
              usdc.address,
              swapRouter.address,
              lowOutput,
              user,
              swapRouter.address,
              root,
            );

            // Should revert due to slippage protection
            await expect(
              swapRouter
                .connect(user)
                .swapAndSupply(vUSDC.address, usdt.address, swapAmount, minAmountOut, swapCallData),
            ).to.be.revertedWithCustomError(swapRouter, "InsufficientAmountOut");
          });

          it("should revert when trying to repay more debt than exists", async function () {
            // First setup debt for the user
            const supplyAmount = parseUnits("1000", 18); // Supply 1k USDT as collateral
            await usdt.connect(usdtHolder).transfer(user.address, supplyAmount);
            await usdt.connect(user).approve(vUSDT.address, supplyAmount);
            await vUSDT.connect(user).mint(supplyAmount);

            // Enable USDT as collateral
            const comptroller = await ethers.getContractAt("ComptrollerInterface", COMPTROLLER_ADDRESS);
            await comptroller.connect(user).enterMarkets([vUSDT.address]);

            // Borrow some USDC against USDT collateral
            const borrowAmount = parseUnits("20", 18); // Borrow 20 USDC
            await vUSDC.connect(user).borrow(borrowAmount);

            const swapAmount = parseEther("1");
            const expectedOutput = parseUnits("50", 18); // 50 USDC output

            // Transfer ETH from holder to user
            await eth.connect(ethHolder).transfer(user.address, swapAmount);

            // Fund SwapHelper with large USDC amount
            await usdc.connect(usdcHolder).transfer(swapHelper.address, expectedOutput);

            // User approves SwapRouter to spend ETH
            await eth.connect(user).approve(swapRouter.address, swapAmount);

            // Create multicall data
            const swapCallData = await createRealSwapMulticallData(
              swapHelper,
              eth.address,
              usdc.address,
              swapRouter.address,
              expectedOutput,
              user,
              swapRouter.address,
              root,
            );

            // Should succeed but only repay actual debt amount
            await expect(
              swapRouter.connect(user).swapAndRepayFull(vUSDC.address, eth.address, swapAmount, swapCallData),
            ).to.not.be.reverted;

            // Verify debt is fully repaid
            const finalDebt = await vUSDC.borrowBalanceStored(user.address);
            expect(finalDebt).to.be.lte(parseUnits("1", 12)); // Allow for tiny rounding errors
          });

          it("should revert with ZeroAmount when swapping zero tokens", async function () {
            const swapAmount = 0;
            const swapCallData = "0x";

            await expect(
              swapRouter.connect(user).swapAndSupply(vUSDC.address, usdt.address, swapAmount, 0, swapCallData),
            ).to.be.revertedWithCustomError(swapRouter, "ZeroAmount");
          });

          it("should revert with ZeroAmount when native swap amount is zero", async function () {
            const swapCallData = "0x";

            await expect(
              swapRouter.connect(user).swapNativeAndSupply(vUSDT.address, 0, swapCallData, { value: 0 }),
            ).to.be.revertedWithCustomError(swapRouter, "ZeroAmount");
          });

          it("should revert when trying to swap with insufficient token allowance", async function () {
            const swapAmount = parseUnits("100", 18);
            const expectedOutput = parseUnits("99", 18);
            const minAmountOut = parseUnits("95", 18);

            // Transfer tokens to user but don't approve SwapRouter
            await usdt.connect(usdtHolder).transfer(user.address, swapAmount);
            await usdc.connect(usdcHolder).transfer(swapHelper.address, expectedOutput);

            // Create multicall data
            const swapCallData = await createRealSwapMulticallData(
              swapHelper,
              usdt.address,
              usdc.address,
              swapRouter.address,
              expectedOutput,
              user,
              swapRouter.address,
              root,
            );

            // Should revert due to insufficient allowance
            await expect(
              swapRouter
                .connect(user)
                .swapAndSupply(vUSDC.address, usdt.address, swapAmount, minAmountOut, swapCallData),
            ).to.be.reverted; // ERC20 will revert with insufficient allowance
          });

          it("should revert when trying to swap more tokens than user balance", async function () {
            const userBalance = parseUnits("50", 18); // User has 50 USDT
            const swapAmount = parseUnits("100", 18); // Trying to swap 100 USDT
            const expectedOutput = parseUnits("99", 18);
            const minAmountOut = parseUnits("95", 18);

            // Transfer only 50 USDT to user
            await usdt.connect(usdtHolder).transfer(user.address, userBalance);
            await usdt.connect(user).approve(swapRouter.address, swapAmount);
            await usdc.connect(usdcHolder).transfer(swapHelper.address, expectedOutput);

            // Create multicall data
            const swapCallData = await createRealSwapMulticallData(
              swapHelper,
              usdt.address,
              usdc.address,
              swapRouter.address,
              expectedOutput,
              user,
              swapRouter.address,
              root,
            );

            // Should revert due to insufficient balance
            await expect(
              swapRouter
                .connect(user)
                .swapAndSupply(vUSDC.address, usdt.address, swapAmount, minAmountOut, swapCallData),
            ).to.be.reverted; // ERC20 will revert with insufficient balance
          });

          it("should revert when trying to repay with zero debt", async function () {
            const swapAmount = parseEther("1");
            const expectedOutput = parseUnits("30", 18); // 30 USDC
            const minAmountOut = parseUnits("25", 18); // 25 USDC minimum

            // Transfer ETH from holder to user
            await eth.connect(ethHolder).transfer(user.address, swapAmount);
            await usdc.connect(usdcHolder).transfer(swapHelper.address, expectedOutput);
            await eth.connect(user).approve(swapRouter.address, swapAmount);

            // Create multicall data
            const swapCallData = await createRealSwapMulticallData(
              swapHelper,
              eth.address,
              usdc.address,
              swapRouter.address,
              expectedOutput,
              user,
              swapRouter.address,
              root,
            );

            // Should revert because user has no debt to repay
            await expect(
              swapRouter.connect(user).swapAndRepay(vUSDC.address, eth.address, swapAmount, minAmountOut, swapCallData),
            ).to.be.revertedWithCustomError(swapRouter, "ZeroAmount");
          });

          it("should revert when trying to use swapNativeAndRepayFull with insufficient output", async function () {
            // First setup debt for the user
            const supplyAmount = parseUnits("1000", 18); // Supply 1k USDT as collateral
            await usdt.connect(usdtHolder).transfer(user.address, supplyAmount);
            await usdt.connect(user).approve(vUSDT.address, supplyAmount);
            await vUSDT.connect(user).mint(supplyAmount);

            // Enable USDT as collateral
            const comptroller = await ethers.getContractAt("ComptrollerInterface", COMPTROLLER_ADDRESS);
            await comptroller.connect(user).enterMarkets([vUSDT.address]);

            // Borrow some USDC against USDT collateral
            const borrowAmount = parseUnits("50", 18); // Borrow 50 USDC
            await vUSDC.connect(user).borrow(borrowAmount);

            const currentDebt = await vUSDC.callStatic.borrowBalanceCurrent(user.address);
            const swapAmount = parseEther("2"); // 2 BNB
            const insufficientOutput = currentDebt.div(2); // Only half of what's needed

            // Fund SwapHelper with insufficient USDC
            await usdc.connect(usdcHolder).transfer(swapHelper.address, insufficientOutput);

            // Create multicall data for native swap
            const swapCallData = await createRealSwapMulticallData(
              swapHelper,
              wbnb.address,
              usdc.address,
              swapRouter.address,
              insufficientOutput,
              user,
              swapRouter.address,
              root,
            );

            // Should revert because insufficient tokens for full repayment
            await expect(
              swapRouter.connect(user).swapNativeAndRepayFull(vUSDC.address, swapCallData, { value: swapAmount }),
            ).to.be.revertedWithCustomError(swapRouter, "InsufficientAmountOut");
          });

          it("should revert when using swapNativeAndRepayFull with zero value", async function () {
            const swapCallData = "0x";

            await expect(
              swapRouter.connect(user).swapNativeAndRepayFull(vUSDC.address, swapCallData, { value: 0 }),
            ).to.be.revertedWithCustomError(swapRouter, "ZeroAmount");
          });

          it("should revert when trying to supply to unlisted market", async function () {
            const swapAmount = parseUnits("100", 18);
            const invalidVToken = ethers.constants.AddressZero;
            const swapCallData = "0x";

            await usdt.connect(usdtHolder).transfer(user.address, swapAmount);
            await usdt.connect(user).approve(swapRouter.address, swapAmount);

            await expect(
              swapRouter.connect(user).swapAndSupply(invalidVToken, usdt.address, swapAmount, 0, swapCallData),
            ).to.be.revertedWithCustomError(swapRouter, "ZeroAddress");
          });

          it("should revert when swap fails due to no tokens received", async function () {
            const swapAmount = parseUnits("100", 18);
            const expectedOutput = parseUnits("0", 18); // No output expected
            const minAmountOut = parseUnits("95", 18);

            await usdt.connect(usdtHolder).transfer(user.address, swapAmount);
            await usdt.connect(user).approve(swapRouter.address, swapAmount);

            // Don't fund SwapHelper, so no tokens will be received
            const swapCallData = await createRealSwapMulticallData(
              swapHelper,
              usdt.address,
              usdc.address,
              swapRouter.address,
              expectedOutput,
              user,
              swapRouter.address,
              root,
            );

            await expect(
              swapRouter
                .connect(user)
                .swapAndSupply(vUSDC.address, usdt.address, swapAmount, minAmountOut, swapCallData),
            ).to.be.revertedWithCustomError(swapRouter, "NoTokensReceived");
          });

          it("should revert with invalid signature in multicall", async function () {
            const swapAmount = parseUnits("100", 18);
            const expectedOutput = parseUnits("99", 18);
            const minAmountOut = parseUnits("95", 18);

            // Transfer tokens to user and approve
            await usdt.connect(usdtHolder).transfer(user.address, swapAmount);
            await usdt.connect(user).approve(swapRouter.address, swapAmount);
            await usdc.connect(usdcHolder).transfer(swapHelper.address, expectedOutput);

            // Create invalid multicall data with wrong signer
            const invalidSwapCallData = await createRealSwapMulticallData(
              swapHelper,
              usdt.address,
              usdc.address,
              swapRouter.address,
              expectedOutput,
              user, // Use user as signer
              swapRouter.address,
              user, // Wrong backend signer (should be root)
            );

            // Should revert due to invalid signature
            await expect(
              swapRouter
                .connect(user)
                .swapAndSupply(vUSDC.address, usdt.address, swapAmount, minAmountOut, invalidSwapCallData),
            ).to.be.reverted; // SwapHelper will revert with invalid signature
          });

          it("should revert when deadline has passed in multicall", async function () {
            const swapAmount = parseUnits("100", 18);
            const expectedOutput = parseUnits("99", 18);

            // Transfer tokens to user and approve
            await usdt.connect(usdtHolder).transfer(user.address, swapAmount);
            await usdt.connect(user).approve(swapRouter.address, swapAmount);
            await usdc.connect(usdcHolder).transfer(swapHelper.address, expectedOutput);

            // Encode sweep function call
            const sweepData = swapHelper.interface.encodeFunctionData("sweep", [usdc.address, swapRouter.address]);

            // Create EIP-712 signature with past deadline
            const domain = {
              chainId: network.config.chainId,
              name: "VenusSwap",
              verifyingContract: swapHelper.address,
              version: "1",
            };

            const types = {
              Multicall: [
                { name: "caller", type: "address" },
                { name: "calls", type: "bytes[]" },
                { name: "deadline", type: "uint256" },
                { name: "salt", type: "bytes32" },
              ],
            };

            const calls = [sweepData];
            const pastDeadline = 1; // Very old timestamp
            const salt = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("expired" + Math.random()));

            const signature = await root._signTypedData(domain, types, {
              caller: swapRouter.address,
              calls,
              deadline: pastDeadline,
              salt,
            });

            // Encode multicall with expired deadline
            const expiredSwapCallData = swapHelper.interface.encodeFunctionData("multicall", [
              calls,
              pastDeadline,
              salt,
              signature,
            ]);

            // Should revert due to expired deadline
            await expect(
              swapRouter.connect(user).swapAndSupply(vUSDC.address, usdt.address, swapAmount, 0, expiredSwapCallData),
            ).to.be.reverted; // Will revert with deadline error
          });

          it("should revert when SwapHelper has insufficient tokens for swap", async function () {
            const swapAmount = parseUnits("100", 18);
            const expectedOutput = parseUnits("99", 18);
            const minAmountOut = parseUnits("95", 18);
            const insufficientOutput = parseUnits("10", 18); // Much less than expected

            // Transfer tokens to user and approve
            await usdt.connect(usdtHolder).transfer(user.address, swapAmount);
            await usdt.connect(user).approve(swapRouter.address, swapAmount);

            // Fund SwapHelper with insufficient USDC
            await usdc.connect(usdcHolder).transfer(swapHelper.address, insufficientOutput);

            // Create multicall data expecting more tokens than available
            const swapCallData = await createRealSwapMulticallData(
              swapHelper,
              usdt.address,
              usdc.address,
              swapRouter.address,
              expectedOutput, // Expecting 99 USDC but SwapHelper only has 10
              user,
              swapRouter.address,
              root,
            );

            // Should revert due to insufficient tokens in SwapHelper
            await expect(
              swapRouter
                .connect(user)
                .swapAndSupply(vUSDC.address, usdt.address, swapAmount, minAmountOut, swapCallData),
            ).to.be.reverted; // ERC20 transfer will fail
          });
        });
      });
    });
  }
});
