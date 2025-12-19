import { FakeContract, smock } from "@defi-wonderland/smock";
import { loadFixture, setBalance } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import chai from "chai";
import { BigNumber, Contract, Wallet } from "ethers";
import { parseEther, parseUnits } from "ethers/lib/utils";
import { ethers, network, upgrades } from "hardhat";

import {
  ComptrollerLens__factory,
  ComptrollerMock,
  EIP20Interface,
  IAccessControlManagerV8,
  IWBNB,
  InterestRateModel,
  MockToken,
  MockToken__factory,
  MockVBNB,
  ResilientOracleInterface,
  SwapHelper,
  SwapRouter,
  VBep20Harness,
  VBep20Harness__factory,
} from "../../../typechain";

const { expect } = chai;
chai.use(smock.matchers);

type SwapRouterFixture = {
  swapRouter: SwapRouter;
  comptroller: ComptrollerMock;
  swapHelper: SwapHelper;
  wrappedNative: FakeContract<IWBNB>;
  nativeVToken: MockVBNB;
  tokenA: MockToken;
  tokenB: MockToken;
  vTokenA: VBep20Harness;
  vTokenB: VBep20Harness;
  interestRateModel: FakeContract<InterestRateModel>;
};

async function deployMockToken(name: string, symbol: string): Promise<MockToken> {
  const MockTokenFactory = await ethers.getContractFactory("MockToken");
  return await MockTokenFactory.deploy(name, symbol, 18);
}

async function deployVToken(
  underlying: Contract,
  comptroller: Contract,
  acm: string,
  irm: string,
  admin: string,
  name: string,
  symbol: string,
): Promise<VBep20Harness> {
  const vTokenFactory = await ethers.getContractFactory("VBep20Harness");
  const vToken = await vTokenFactory.deploy(
    underlying.address,
    comptroller.address,
    irm,
    parseUnits("1", 28),
    name,
    symbol,
    8,
    admin,
  );
  return vToken;
}

async function deploySwapRouterFixture(): Promise<SwapRouterFixture> {
  const [admin] = await ethers.getSigners();

  // Deploy access control and oracle mocks
  const accessControl = await smock.fake<IAccessControlManagerV8>("AccessControlManager");
  accessControl.isAllowedToCall.returns(true);

  const oracle = await smock.fake<ResilientOracleInterface>("ResilientOracleInterface");
  oracle.getUnderlyingPrice.returns(parseUnits("1", 18)); // 1:1 price for simplicity

  const interestRateModel = await smock.fake<InterestRateModel>("InterestRateModelHarness");
  interestRateModel.isInterestRateModel.returns(true);

  // Deploy comptroller
  const comptrollerFactory = await ethers.getContractFactory("ComptrollerMock");
  const comptroller = await comptrollerFactory.deploy();

  const comptrollerLensFactory = await smock.mock<ComptrollerLens__factory>("ComptrollerLens");
  const comptrollerLens = await comptrollerLensFactory.deploy();

  await comptroller._setAccessControl(accessControl.address);
  await comptroller._setComptrollerLens(comptrollerLens.address);
  await comptroller._setPriceOracle(oracle.address);

  // Deploy mock tokens
  const tokenA = await deployMockToken("TokenA", "TKA");
  const tokenB = await deployMockToken("TokenB", "TKB");

  // Deploy vTokens
  const vTokenA = await deployVToken(
    tokenA,
    comptroller,
    accessControl.address,
    interestRateModel.address,
    admin.address,
    "Venus TokenA",
    "vTKA",
  );

  const vTokenB = await deployVToken(
    tokenB,
    comptroller,
    accessControl.address,
    interestRateModel.address,
    admin.address,
    "Venus TokenB",
    "vTKB",
  );

  await vTokenA.connect(admin).setAccessControlManager(accessControl.address);
  await vTokenB.connect(admin).setAccessControlManager(accessControl.address);

  // Support markets and enable borrowing
  await comptroller._supportMarket(vTokenA.address);
  await comptroller._supportMarket(vTokenB.address);
  await comptroller.setIsBorrowAllowed(0, vTokenA.address, true);
  await comptroller.setIsBorrowAllowed(0, vTokenB.address, true);

  // Set collateral factors
  await comptroller["setCollateralFactor(address,uint256,uint256)"](
    vTokenA.address,
    parseEther("0.8"),
    parseEther("0.85"),
  );
  await comptroller["setCollateralFactor(address,uint256,uint256)"](
    vTokenB.address,
    parseEther("0.8"),
    parseEther("0.85"),
  );

  // Set caps
  await comptroller._setMarketSupplyCaps(
    [vTokenA.address, vTokenB.address],
    [parseEther("10000"), parseEther("10000")],
  );
  await comptroller._setMarketBorrowCaps([vTokenA.address, vTokenB.address], [parseEther("5000"), parseEther("5000")]);

  // Deploy native vToken
  const nativeVTokenFactory = await ethers.getContractFactory("MockVBNB");
  const nativeVToken = await nativeVTokenFactory.deploy(
    comptroller.address,
    interestRateModel.address,
    parseUnits("1", 28),
    "Venus BNB",
    "vBNB",
    8,
    admin.address,
  );
  await nativeVToken.connect(admin).setAccessControlManager(accessControl.address);
  await comptroller._supportMarket(nativeVToken.address);
  await comptroller["setCollateralFactor(address,uint256,uint256)"](
    nativeVToken.address,
    parseEther("0.9"),
    parseEther("0.95"),
  );

  // Setup wrapped native mock with proper behavior
  const wrappedNative = await smock.fake<IWBNB>("IWBNB");
  wrappedNative.deposit.returns();
  wrappedNative.withdraw.returns();
  wrappedNative.transfer.returns(true);
  wrappedNative.transferFrom.returns(true);
  wrappedNative.balanceOf.returns(parseEther("1000"));
  wrappedNative.approve.returns(true);

  // Deploy SwapHelper
  const swapHelperFactory = await ethers.getContractFactory("SwapHelper");
  const swapHelper = (await swapHelperFactory.deploy(admin.address)) as SwapHelper;

  // Deploy SwapRouter
  const swapRouterFactory = await ethers.getContractFactory("SwapRouter");
  const swapRouter = (await upgrades.deployProxy(swapRouterFactory, [], {
    constructorArgs: [comptroller.address, swapHelper.address, wrappedNative.address, nativeVToken.address],
    initializer: "initialize",
    unsafeAllow: ["state-variable-immutable"],
  })) as SwapRouter;

  // Mint extra tokens for test operations
  await tokenA.faucet(parseEther("10000"));
  await tokenB.faucet(parseEther("10000"));

  await tokenA.approve(vTokenA.address, parseEther("500"));
  await tokenB.approve(vTokenB.address, parseEther("500"));

  await vTokenA.mint(parseEther("500"));
  await vTokenB.mint(parseEther("500"));

  return {
    swapRouter,
    comptroller,
    swapHelper,
    wrappedNative,
    nativeVToken,
    tokenA,
    tokenB,
    vTokenA,
    vTokenB,
    interestRateModel,
  };
}

async function createSwapMulticallData(
  swapHelper: SwapHelper,
  fromToken: EIP20Interface,
  toToken: EIP20Interface,
  recipient: string,
  amountOut: BigNumber,
  signer: Wallet,
  swapRouterAddress: string, // Need this for proper caller
  salt?: string,
): Promise<string> {
  // Get tokens to swapHelper to simulate the swap result
  // We need to fund the swapHelper with the output tokens before the test

  // Encode sweep function call to send tokens to recipient
  const sweepData = swapHelper.interface.encodeFunctionData("sweep", [toToken.address, recipient]);

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
  const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
  const saltValue = salt || ethers.utils.formatBytes32String(Math.random().toString());

  const signature = await signer._signTypedData(domain, types, {
    caller: swapRouterAddress, // SwapRouter will call swapHelper
    calls,
    deadline,
    salt: saltValue,
  });

  // Encode multicall with all parameters
  const multicallData = swapHelper.interface.encodeFunctionData("multicall", [calls, deadline, saltValue, signature]);

  return multicallData;
}

async function createNativeSwapMulticallData(
  swapHelper: SwapHelper,
  wrappedNativeAddress: string,
  toToken: EIP20Interface,
  recipient: string,
  amountOut: BigNumber,
  signer: Wallet,
  swapRouterAddress: string,
  salt?: string,
): Promise<string> {
  // Encode sweep function call to send output tokens to recipient
  const sweepData = swapHelper.interface.encodeFunctionData("sweep", [toToken.address, recipient]);

  // Create EIP-712 signature for native swap (WRAPPED_NATIVE -> output token)
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
  const deadline = Math.floor(Date.now() / 1000) + 3600;
  const saltValue = salt || ethers.utils.formatBytes32String(Math.random().toString());

  const signature = await signer._signTypedData(domain, types, {
    caller: swapRouterAddress,
    calls,
    deadline,
    salt: saltValue,
  });

  const multicallData = swapHelper.interface.encodeFunctionData("multicall", [calls, deadline, saltValue, signature]);

  return multicallData;
}

describe("SwapRouter", function () {
  let user: SignerWithAddress;
  let admin: Wallet;

  let swapRouter: SwapRouter;
  let comptroller: ComptrollerMock;
  let swapHelper: SwapHelper;
  let wrappedNative: FakeContract<IWBNB>;
  let nativeVToken: MockVBNB;
  let tokenA: MockToken;
  let tokenB: MockToken;
  let vTokenA: VBep20Harness;
  let vTokenB: VBep20Harness;

  const AMOUNT_IN = parseEther("100");
  const AMOUNT_OUT = parseEther("95");
  const MIN_AMOUNT_OUT = parseEther("90");

  beforeEach(async function () {
    [admin, user] = await ethers.getSigners();
    ({ swapRouter, comptroller, swapHelper, wrappedNative, nativeVToken, tokenA, tokenB, vTokenA, vTokenB } =
      await loadFixture(deploySwapRouterFixture));
  });

  describe("Constructor", function () {
    it("should revert with zero address for comptroller", async function () {
      const swapRouterFactory = await ethers.getContractFactory("SwapRouter");
      await expect(
        swapRouterFactory.deploy(
          ethers.constants.AddressZero,
          swapHelper.address,
          wrappedNative.address,
          nativeVToken.address,
        ),
      ).to.be.revertedWithCustomError(swapRouter, "ZeroAddress");
    });

    it("should revert with zero address for swapHelper", async function () {
      const swapRouterFactory = await ethers.getContractFactory("SwapRouter");
      await expect(
        swapRouterFactory.deploy(
          comptroller.address,
          ethers.constants.AddressZero,
          wrappedNative.address,
          nativeVToken.address,
        ),
      ).to.be.revertedWithCustomError(swapRouter, "ZeroAddress");
    });

    it("should set immutable variables correctly", async function () {
      expect(await swapRouter.COMPTROLLER()).to.equal(comptroller.address);
      expect(await swapRouter.SWAP_HELPER()).to.equal(swapHelper.address);
      expect(await swapRouter.WRAPPED_NATIVE()).to.equal(wrappedNative.address);
      expect(await swapRouter.NATIVE_VTOKEN()).to.equal(nativeVToken.address);
    });
  });

  describe("SwapAndSupply", function () {
    beforeEach(async function () {
      // Give user tokens for the swap
      await tokenA.transfer(user.address, parseEther("1000"));

      // User approves SwapRouter to spend their tokens
      await tokenA.connect(user).approve(swapRouter.address, AMOUNT_IN);
    });

    it("should revert with zero amount", async function () {
      // Fund the swapHelper with output tokens to simulate swap result
      await tokenB.transfer(swapHelper.address, AMOUNT_OUT);

      const swapCallData = await createSwapMulticallData(
        swapHelper,
        tokenA,
        tokenB,
        swapRouter.address,
        AMOUNT_OUT,
        admin,
        swapRouter.address,
      );

      await expect(
        swapRouter.connect(user).swapAndSupply(vTokenB.address, tokenA.address, 0, MIN_AMOUNT_OUT, swapCallData),
      ).to.be.revertedWithCustomError(swapRouter, "ZeroAmount");
    });

    it("should revert with invalid vToken", async function () {
      // Fund the swapHelper with output tokens to simulate swap result
      await tokenB.transfer(swapHelper.address, AMOUNT_OUT);

      const swapCallData = await createSwapMulticallData(
        swapHelper,
        tokenA,
        tokenB,
        swapRouter.address,
        AMOUNT_OUT,
        admin,
        swapRouter.address,
      );

      await expect(
        swapRouter.connect(user).swapAndSupply(user.address, tokenA.address, AMOUNT_IN, MIN_AMOUNT_OUT, swapCallData),
      ).to.be.revertedWithCustomError(swapRouter, "MarketNotListed");
    });

    it("should revert when slippage protection fails", async function () {
      // Create swap data that returns less than minimum
      const lowAmountOut = parseEther("50");

      // Fund the swapHelper with lower amount
      await tokenB.transfer(swapHelper.address, lowAmountOut);

      const swapCallData = await createSwapMulticallData(
        swapHelper,
        tokenA,
        tokenB,
        swapRouter.address,
        lowAmountOut,
        admin,
        swapRouter.address,
      );

      await expect(
        swapRouter
          .connect(user)
          .swapAndSupply(vTokenB.address, tokenA.address, AMOUNT_IN, MIN_AMOUNT_OUT, swapCallData),
      ).to.be.revertedWithCustomError(swapRouter, "InsufficientAmountOut");
    });

    it("should swap tokens and supply to Venus market", async function () {
      // Fund the swapHelper with output tokens to simulate swap result
      await tokenB.transfer(swapHelper.address, AMOUNT_OUT);

      // Create multicall data that will result in AMOUNT_OUT tokens being sent to SwapRouter
      const swapCallData = await createSwapMulticallData(
        swapHelper,
        tokenA,
        tokenB,
        swapRouter.address,
        AMOUNT_OUT,
        admin,
        swapRouter.address,
      );

      const userVTokenBalanceBefore = await vTokenB.balanceOf(user.address);
      const userTokenABalanceBefore = await tokenA.balanceOf(user.address);
      const userTokenBBalanceBefore = await tokenB.balanceOf(user.address);

      await expect(
        swapRouter
          .connect(user)
          .swapAndSupply(vTokenB.address, tokenA.address, AMOUNT_IN, MIN_AMOUNT_OUT, swapCallData),
      )
        .to.emit(swapRouter, "SwapAndSupply")
        .withArgs(user.address, vTokenB.address, tokenA.address, tokenB.address, AMOUNT_IN, AMOUNT_OUT, AMOUNT_OUT);

      // Verify user spent tokenA
      const userTokenABalanceAfter = await tokenA.balanceOf(user.address);
      expect(userTokenABalanceBefore.sub(userTokenABalanceAfter)).to.equal(AMOUNT_IN);

      // Verify user didn't receive tokenB directly (it was supplied to market)
      const userTokenBBalanceAfter = await tokenB.balanceOf(user.address);
      expect(userTokenBBalanceAfter).to.equal(userTokenBBalanceBefore);

      // Verify user received vTokens
      const userVTokenBalanceAfter = await vTokenB.balanceOf(user.address);
      expect(userVTokenBalanceAfter).to.be.gt(userVTokenBalanceBefore);

      // Verify user has supply balance in the market
      const supplyBalance = await vTokenB.callStatic.balanceOfUnderlying(user.address);
      expect(supplyBalance).to.be.gt(0);
    });

    it("should create supply position in Venus market", async function () {
      // Fund the swapHelper with output tokens to simulate swap result
      await tokenB.transfer(swapHelper.address, AMOUNT_OUT);

      const swapCallData = await createSwapMulticallData(
        swapHelper,
        tokenA,
        tokenB,
        swapRouter.address,
        AMOUNT_OUT,
        admin,
        swapRouter.address,
      );

      // Execute swap and supply
      await swapRouter
        .connect(user)
        .swapAndSupply(vTokenB.address, tokenA.address, AMOUNT_IN, MIN_AMOUNT_OUT, swapCallData);

      // Verify supply position was created
      const supplyBalance = await vTokenB.callStatic.balanceOfUnderlying(user.address);
      expect(supplyBalance).to.be.gt(0);

      // Verify user's account has liquidity by checking vToken balance
      const vTokenBalance = await vTokenB.balanceOf(user.address);
      expect(vTokenBalance).to.be.gt(0);

      // Verify no tokens are stuck in the router
      expect(await tokenA.balanceOf(swapRouter.address)).to.equal(0);
      expect(await tokenB.balanceOf(swapRouter.address)).to.equal(0);
    });
  });

  describe("SwapAndRepay", function () {
    beforeEach(async function () {
      // Setup: User has borrowed tokens
      await tokenA.transfer(user.address, parseEther("1000"));
      await tokenA.connect(user).approve(vTokenA.address, parseEther("500"));
      await vTokenA.connect(user).mint(parseEther("500"));

      await comptroller.connect(user).enterMarkets([vTokenA.address]);
      await vTokenA.connect(user).borrow(parseEther("100"));

      // User gets tokenB to swap for repayment
      await tokenB.transfer(user.address, parseEther("1000"));
      await tokenB.connect(user).approve(swapRouter.address, AMOUNT_IN);
    });

    it("should revert with zero amount", async function () {
      // Fund the swapHelper with output tokens to simulate swap result
      await tokenA.transfer(swapHelper.address, AMOUNT_OUT);

      const swapCallData = await createSwapMulticallData(
        swapHelper,
        tokenB,
        tokenA,
        swapRouter.address,
        AMOUNT_OUT,
        admin,
        swapRouter.address,
      );

      await expect(
        swapRouter.connect(user).swapAndRepay(vTokenA.address, tokenB.address, 0, MIN_AMOUNT_OUT, swapCallData),
      ).to.be.revertedWithCustomError(swapRouter, "ZeroAmount");
    });

    it("should revert with invalid vToken", async function () {
      // Fund the swapHelper with output tokens to simulate swap result
      await tokenA.transfer(swapHelper.address, AMOUNT_OUT);

      const swapCallData = await createSwapMulticallData(
        swapHelper,
        tokenB,
        tokenA,
        swapRouter.address,
        AMOUNT_OUT,
        admin,
        swapRouter.address,
      );

      await expect(
        swapRouter.connect(user).swapAndRepay(user.address, tokenB.address, AMOUNT_IN, MIN_AMOUNT_OUT, swapCallData),
      ).to.be.revertedWithCustomError(swapRouter, "MarketNotListed");
    });

    it("should revert when slippage protection fails", async function () {
      // Create swap data that returns less than minimum
      const lowAmountOut = parseEther("50");

      // Fund the swapHelper with lower amount
      await tokenA.transfer(swapHelper.address, lowAmountOut);

      const swapCallData = await createSwapMulticallData(
        swapHelper,
        tokenB,
        tokenA,
        swapRouter.address,
        lowAmountOut,
        admin,
        swapRouter.address,
      );

      await expect(
        swapRouter.connect(user).swapAndRepay(vTokenA.address, tokenB.address, AMOUNT_IN, MIN_AMOUNT_OUT, swapCallData),
      ).to.be.revertedWithCustomError(swapRouter, "InsufficientAmountOut");
    });

    it("should swap tokens and repay borrow", async function () {
      // Fund the swapHelper with output tokens to simulate swap result
      await tokenA.transfer(swapHelper.address, AMOUNT_OUT);

      // Create multicall data that will result in tokenA being sent to SwapRouter for repayment
      const swapCallData = await createSwapMulticallData(
        swapHelper,
        tokenB,
        tokenA,
        swapRouter.address,
        AMOUNT_OUT,
        admin,
        swapRouter.address,
      );

      const borrowBalanceBefore = await vTokenA.callStatic.borrowBalanceCurrent(user.address);
      const userTokenBBalanceBefore = await tokenB.balanceOf(user.address);

      await expect(
        swapRouter.connect(user).swapAndRepay(vTokenA.address, tokenB.address, AMOUNT_IN, MIN_AMOUNT_OUT, swapCallData),
      )
        .to.emit(swapRouter, "SwapAndRepay")
        .withArgs(user.address, vTokenA.address, tokenB.address, tokenA.address, AMOUNT_IN, AMOUNT_OUT, AMOUNT_OUT);

      // Verify user spent tokenB
      const userTokenBBalanceAfter = await tokenB.balanceOf(user.address);
      expect(userTokenBBalanceBefore.sub(userTokenBBalanceAfter)).to.equal(AMOUNT_IN);

      // Verify borrow balance was reduced
      const borrowBalanceAfter = await vTokenA.callStatic.borrowBalanceCurrent(user.address);
      expect(borrowBalanceAfter).to.be.lt(borrowBalanceBefore);
    });

    it("should handle full repayment correctly", async function () {
      const currentBorrowBalance = await vTokenA.callStatic.borrowBalanceCurrent(user.address);

      // Fund the swapHelper with enough tokens to fully repay
      await tokenA.transfer(swapHelper.address, currentBorrowBalance);

      // Create multicall data that provides enough tokens to fully repay
      const swapCallData = await createSwapMulticallData(
        swapHelper,
        tokenB,
        tokenA,
        swapRouter.address,
        currentBorrowBalance, // Provide exact amount to repay
        admin,
        swapRouter.address,
      );

      await swapRouter
        .connect(user)
        .swapAndRepay(vTokenA.address, tokenB.address, AMOUNT_IN, currentBorrowBalance, swapCallData);

      // Verify borrow balance is now minimal (accounting for accrued interest)
      const borrowBalanceAfter = await vTokenA.callStatic.borrowBalanceCurrent(user.address);
      expect(borrowBalanceAfter).to.be.lt(parseEther("0.01")); // Very small due to rounding
    });
  });

  describe("SwapNativeAndSupply", function () {
    beforeEach(async function () {
      // Set user's native balance - need enough for tx value + gas
      await setBalance(user.address, parseEther("200"));
    });

    it("should swap native tokens and supply to Venus market", async function () {
      // Fund the swapHelper with output tokens to simulate swap result
      await tokenA.transfer(swapHelper.address, AMOUNT_OUT);

      // Create multicall data for native swap (WRAPPED_NATIVE -> tokenA)
      const swapCallData = await createNativeSwapMulticallData(
        swapHelper,
        wrappedNative.address,
        tokenA,
        swapRouter.address,
        AMOUNT_OUT,
        admin,
        swapRouter.address,
      );

      const userVTokenBalanceBefore = await vTokenA.balanceOf(user.address);
      const userNativeBalanceBefore = await ethers.provider.getBalance(user.address);

      const tx = await swapRouter.connect(user).swapNativeAndSupply(vTokenA.address, MIN_AMOUNT_OUT, swapCallData, {
        value: AMOUNT_IN,
      });

      await expect(tx)
        .to.emit(swapRouter, "SwapAndSupply")
        .withArgs(
          user.address,
          vTokenA.address,
          wrappedNative.address,
          tokenA.address,
          AMOUNT_IN,
          AMOUNT_OUT,
          AMOUNT_OUT,
        );

      // Verify user spent native tokens (plus gas)
      const userNativeBalanceAfter = await ethers.provider.getBalance(user.address);
      expect(userNativeBalanceBefore.sub(userNativeBalanceAfter)).to.be.gt(AMOUNT_IN);

      // Verify user received vTokens
      const userVTokenBalanceAfter = await vTokenA.balanceOf(user.address);
      expect(userVTokenBalanceAfter).to.be.gt(userVTokenBalanceBefore);

      // Verify supply position was created
      const supplyBalance = await vTokenA.callStatic.balanceOfUnderlying(user.address);
      expect(supplyBalance).to.be.gt(0);
    });

    it("should revert with zero amount", async function () {
      const swapCallData = await createNativeSwapMulticallData(
        swapHelper,
        wrappedNative.address,
        tokenA,
        swapRouter.address,
        AMOUNT_OUT,
        admin,
        swapRouter.address,
      );

      await expect(
        swapRouter.connect(user).swapNativeAndSupply(vTokenA.address, MIN_AMOUNT_OUT, swapCallData, {
          value: 0,
        }),
      ).to.be.revertedWithCustomError(swapRouter, "ZeroAmount");
    });

    it("should revert when slippage protection fails", async function () {
      const lowAmountOut = parseEther("50");

      // Fund the swapHelper with lower amount
      await tokenA.transfer(swapHelper.address, lowAmountOut);

      const swapCallData = await createNativeSwapMulticallData(
        swapHelper,
        wrappedNative.address,
        tokenA,
        swapRouter.address,
        lowAmountOut,
        admin,
        swapRouter.address,
      );

      await expect(
        swapRouter.connect(user).swapNativeAndSupply(vTokenA.address, MIN_AMOUNT_OUT, swapCallData, {
          value: AMOUNT_IN,
        }),
      ).to.be.revertedWithCustomError(swapRouter, "InsufficientAmountOut");
    });
  });

  describe("SwapNativeAndRepay", function () {
    beforeEach(async function () {
      // Setup: User has borrowed tokens
      await tokenA.transfer(user.address, parseEther("1000"));
      await tokenA.connect(user).approve(vTokenA.address, parseEther("500"));
      await vTokenA.connect(user).mint(parseEther("500"));

      await comptroller.connect(user).enterMarkets([vTokenA.address]);
      await vTokenA.connect(user).borrow(parseEther("100"));

      // Set user's native balance for repayment - need enough for tx value + gas
      await setBalance(user.address, parseEther("200"));
    });

    it("should swap native tokens and repay borrow", async function () {
      // Fund the swapHelper with output tokens to simulate swap result
      await tokenA.transfer(swapHelper.address, AMOUNT_OUT);

      // Create multicall data for native swap (WRAPPED_NATIVE -> tokenA)
      const swapCallData = await createNativeSwapMulticallData(
        swapHelper,
        wrappedNative.address,
        tokenA,
        swapRouter.address,
        AMOUNT_OUT,
        admin,
        swapRouter.address,
      );

      const borrowBalanceBefore = await vTokenA.callStatic.borrowBalanceCurrent(user.address);
      const userNativeBalanceBefore = await ethers.provider.getBalance(user.address);

      const tx = await swapRouter.connect(user).swapNativeAndRepay(vTokenA.address, MIN_AMOUNT_OUT, swapCallData, {
        value: AMOUNT_IN,
      });

      await expect(tx)
        .to.emit(swapRouter, "SwapAndRepay")
        .withArgs(
          user.address,
          vTokenA.address,
          wrappedNative.address,
          tokenA.address,
          AMOUNT_IN,
          AMOUNT_OUT,
          AMOUNT_OUT,
        );

      // Verify user spent native tokens (plus gas)
      const userNativeBalanceAfter = await ethers.provider.getBalance(user.address);
      expect(userNativeBalanceBefore.sub(userNativeBalanceAfter)).to.be.gt(AMOUNT_IN);

      // Verify borrow balance was reduced
      const borrowBalanceAfter = await vTokenA.callStatic.borrowBalanceCurrent(user.address);
      expect(borrowBalanceAfter).to.be.lt(borrowBalanceBefore);
    });

    it("should handle full native repayment correctly", async function () {
      const currentBorrowBalance = await vTokenA.callStatic.borrowBalanceCurrent(user.address);

      // Fund the swapHelper with enough tokens to fully repay
      await tokenA.transfer(swapHelper.address, currentBorrowBalance);

      // Create multicall data for native swap
      const swapCallData = await createNativeSwapMulticallData(
        swapHelper,
        wrappedNative.address,
        tokenA,
        swapRouter.address,
        currentBorrowBalance,
        admin,
        swapRouter.address,
      );

      await swapRouter.connect(user).swapNativeAndRepay(vTokenA.address, currentBorrowBalance, swapCallData, {
        value: AMOUNT_IN,
      });

      // Verify borrow balance is now minimal (accounting for accrued interest)
      const borrowBalanceAfter = await vTokenA.callStatic.borrowBalanceCurrent(user.address);
      expect(borrowBalanceAfter).to.be.lt(parseEther("0.01")); // Very small due to rounding
    });
  });

  describe("SwapAndRepayFull", function () {
    beforeEach(async function () {
      // Setup: User has borrowed tokens
      await tokenA.transfer(user.address, parseEther("1000"));
      await tokenA.connect(user).approve(vTokenA.address, parseEther("500"));
      await vTokenA.connect(user).mint(parseEther("500"));

      await comptroller.connect(user).enterMarkets([vTokenA.address]);
      await vTokenA.connect(user).borrow(parseEther("100"));

      // User gets tokenB to swap for repayment
      await tokenB.transfer(user.address, parseEther("1000"));
      await tokenB.connect(user).approve(swapRouter.address, parseEther("500"));
    });

    it("should swap tokens and repay full borrow balance", async function () {
      const currentBorrowBalance = await vTokenA.callStatic.borrowBalanceCurrent(user.address);

      // Fund the swapHelper with more than enough tokens to fully repay
      const excessAmount = currentBorrowBalance.add(parseEther("50"));
      await tokenA.transfer(swapHelper.address, excessAmount);

      // Create multicall data that provides excess tokens for full repayment
      const swapCallData = await createSwapMulticallData(
        swapHelper,
        tokenB,
        tokenA,
        swapRouter.address,
        excessAmount,
        admin,
        swapRouter.address,
      );

      const userTokenBBalanceBefore = await tokenB.balanceOf(user.address);
      const userTokenABalanceBefore = await tokenA.balanceOf(user.address);

      const tx = await swapRouter
        .connect(user)
        .swapAndRepayFull(vTokenA.address, tokenB.address, AMOUNT_IN, swapCallData);

      await expect(tx).to.emit(swapRouter, "SwapAndRepay").withArgs(
        user.address,
        vTokenA.address,
        tokenB.address,
        tokenA.address,
        AMOUNT_IN,
        excessAmount,
        currentBorrowBalance, // Amount actually used for repayment
      );

      // Verify user spent input tokens
      const userTokenBBalanceAfter = await tokenB.balanceOf(user.address);
      expect(userTokenBBalanceBefore.sub(userTokenBBalanceAfter)).to.equal(AMOUNT_IN);

      // Verify user received excess tokens back
      const userTokenABalanceAfter = await tokenA.balanceOf(user.address);
      const expectedExcess = excessAmount.sub(currentBorrowBalance);
      expect(userTokenABalanceAfter.sub(userTokenABalanceBefore)).to.be.gt(expectedExcess.mul(90).div(100)); // Allow for some precision loss

      // Verify borrow balance is now zero or very minimal
      const borrowBalanceAfter = await vTokenA.callStatic.borrowBalanceCurrent(user.address);
      expect(borrowBalanceAfter).to.be.lt(parseEther("0.01")); // Very small due to rounding
    });

    it("should revert with zero amount", async function () {
      const swapCallData = await createSwapMulticallData(
        swapHelper,
        tokenB,
        tokenA,
        swapRouter.address,
        AMOUNT_OUT,
        admin,
        swapRouter.address,
      );

      await expect(
        swapRouter.connect(user).swapAndRepayFull(vTokenA.address, tokenB.address, 0, swapCallData),
      ).to.be.revertedWithCustomError(swapRouter, "ZeroAmount");
    });

    it("should revert when insufficient tokens for full repayment", async function () {
      const currentBorrowBalance = await vTokenA.callStatic.borrowBalanceCurrent(user.address);
      const insufficientAmount = currentBorrowBalance.div(2); // Only half of what's needed

      // Fund the swapHelper with insufficient tokens
      await tokenA.transfer(swapHelper.address, insufficientAmount);

      const swapCallData = await createSwapMulticallData(
        swapHelper,
        tokenB,
        tokenA,
        swapRouter.address,
        insufficientAmount,
        admin,
        swapRouter.address,
      );

      await expect(
        swapRouter.connect(user).swapAndRepayFull(vTokenA.address, tokenB.address, AMOUNT_IN, swapCallData),
      ).to.be.revertedWithCustomError(swapRouter, "InsufficientAmountOut");
    });
  });
});
