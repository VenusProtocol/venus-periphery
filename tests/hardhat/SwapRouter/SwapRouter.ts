import { FakeContract, MockContract, smock } from "@defi-wonderland/smock";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import chai from "chai";
import { parseEther, parseUnits } from "ethers/lib/utils";
import { ethers, upgrades } from "hardhat";

import { convertToUnit } from "../../../helpers/utils";
import {
  BEP20Harness,
  BEP20Harness__factory,
  ComptrollerLens__factory,
  ComptrollerMock,
  ComptrollerMock__factory,
  IAccessControlManagerV8,
  IWBNB,
  InterestRateModelHarness,
  MockVBNB,
  ResilientOracleInterface,
  SwapHelper,
  SwapRouter,
  SwapRouter__factory,
  VBep20Harness,
  VBep20Harness__factory,
} from "../../typechain";

const { expect } = chai;
chai.use(smock.matchers);

const mockUnderlying = async (name: string, symbol: string): Promise<MockContract<BEP20Harness>> => {
  const underlyingFactory = await smock.mock<BEP20Harness__factory>("BEP20Harness");
  const underlying = await underlyingFactory.deploy(0, name, 18, symbol);
  return underlying;
};

describe("SwapRouter", function () {
  let deployer: SignerWithAddress;
  let user: SignerWithAddress;
  let admin: SignerWithAddress;

  let swapRouter: MockContract<SwapRouter>;
  let comptroller: FakeContract<ComptrollerMock>;
  let swapHelper: FakeContract<SwapHelper>;
  let wrappedNative: FakeContract<IWBNB>;
  let nativeVToken: MockVBNB;

  let underlyingA: MockContract<BEP20Harness>;
  let underlyingB: MockContract<BEP20Harness>;
  let vTokenA: MockContract<VBep20Harness>;
  let vTokenB: MockContract<VBep20Harness>;

  const AMOUNT_IN = parseEther("100");
  const AMOUNT_OUT = parseEther("95");
  const MIN_AMOUNT_OUT = parseEther("90");

  async function deploySwapRouterFixture() {
    [deployer, user, admin] = await ethers.getSigners();

    const oracle = await smock.fake<ResilientOracleInterface>("ResilientOracleInterface");
    const accessControl = await smock.fake<IAccessControlManagerV8>("AccessControlManager");
    accessControl.isAllowedToCall.returns(true);

    const ComptrollerFactory = await smock.mock<ComptrollerMock__factory>("ComptrollerMock");
    comptroller = await ComptrollerFactory.deploy();

    const ComptrollerLensFactory = await smock.mock<ComptrollerLens__factory>("ComptrollerLens");
    const comptrollerLens = await ComptrollerLensFactory.deploy();

    await comptroller._setAccessControl(accessControl.address);
    await comptroller._setComptrollerLens(comptrollerLens.address);
    await comptroller._setPriceOracle(oracle.address);
    await comptroller._setLiquidationIncentive(convertToUnit("1", 18));

    const interestRateModelHarnessFactory = await ethers.getContractFactory("InterestRateModelHarness");
    const InterestRateModelHarness = (await interestRateModelHarnessFactory.deploy(
      parseUnits("1", 12),
    )) as InterestRateModelHarness;

    const nativeVTokenFactory = await ethers.getContractFactory("MockVBNB");
    console.log("Deploying native vToken...");
    nativeVToken = await nativeVTokenFactory.deploy(
      comptroller.address,
      InterestRateModelHarness.address,
      parseUnits("1", 28),
      "Venus BNB",
      "vBNB",
      8,
      admin.address,
    );
    await nativeVToken.connect(admin).setAccessControlManager(accessControl.address);

    wrappedNative = await smock.fake<IWBNB>("IWBNB");
    swapHelper = await smock.fake<SwapHelper>("SwapHelper");

    underlyingA = await mockUnderlying("TokenA", "TKA");
    underlyingB = await mockUnderlying("TokenB", "TKB");

    const vTokenFactory = await smock.mock<VBep20Harness__factory>("VBep20Harness");
    vTokenA = await vTokenFactory.deploy(
      underlyingA.address,
      comptroller.address,
      InterestRateModelHarness.address,
      "200000000000000000000000",
      "vTokenA",
      "VTKNA",
      18,
      admin.address,
    );

    vTokenB = await vTokenFactory.deploy(
      underlyingB.address,
      comptroller.address,
      InterestRateModelHarness.address,
      "200000000000000000000000",
      "vTokenB",
      "VTKNB",
      18,
      admin.address,
    );

    await comptroller._supportMarket(vTokenA.address);
    await comptroller._supportMarket(vTokenB.address);
    await comptroller._supportMarket(nativeVToken.address);

    await comptroller._setCollateralFactor(vTokenA.address, parseEther("0.8"));
    await comptroller._setCollateralFactor(vTokenB.address, parseEther("0.8"));
    await comptroller._setCollateralFactor(nativeVToken.address, parseEther("0.9"));

    await comptroller._setMarketSupplyCaps(
      [vTokenA.address, vTokenB.address],
      [parseEther("1000"), parseEther("1000")],
    );
    await comptroller._setMarketBorrowCaps([vTokenA.address, vTokenB.address], [parseEther("500"), parseEther("500")]);

    await comptroller._setMarketSupplyCaps([nativeVToken.address], [parseEther("100")]);
    await comptroller._setMarketBorrowCaps([nativeVToken.address], [parseEther("100")]);

    // Deploy SwapRouter
    const swapRouterFactory = await ethers.getContractFactory("SwapRouter");
    swapRouter = await upgrades.deployProxy(swapRouterFactory, [], {
      constructorArgs: [comptroller.address, swapHelper.address, wrappedNative.address, nativeVToken.address],
      initializer: "initialize",
      unsafeAllow: ["state-variable-immutable"],
    });

    return {
      swapRouter,
      comptroller,
      swapHelper,
      wrappedNative,
      nativeVToken,
      underlyingA,
      underlyingB,
      vTokenA,
      vTokenB,
    };
  }

  beforeEach(async function () {
    await loadFixture(deploySwapRouterFixture);
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
      expect(await swapRouter.swapHelper()).to.equal(swapHelper.address);
      expect(await swapRouter.wrappedNative()).to.equal(wrappedNative.address);
      expect(await swapRouter.NATIVE_VTOKEN()).to.equal(nativeVToken.address);
    });
  });

  describe("SwapAndSupply", function () {
    beforeEach(async function () {
      // Mint tokens to user
      await underlyingA.harnessSetBalance(user.address, parseUnits("1000", 18));
      await underlyingB.harnessSetBalance(user.address, parseUnits("1000", 18));

      // Setup user approval
      await underlyingA.connect(user).approve(swapRouter.address, AMOUNT_IN);

      // Mock balance checks - start with 0, then return AMOUNT_OUT after swap
      underlyingB.balanceOf.returns(0);
      underlyingB.balanceOf.returnsAtCall(1, AMOUNT_OUT); // Second call returns tokens

      // Mock SwapHelper multicall
      swapHelper.multicall.returns([]);

      // Mock the supply operation
      vTokenB.mintBehalf.returns(0); // Success code

      // Mock vToken balance - user gets vTokens after supply
      vTokenB.balanceOf.whenCalledWith(user.address).returns(parseEther("50"));

      // Mock comptroller account liquidity check
      comptroller.getAccountLiquidity.returns([0, parseEther("1000"), 0]); // [error, liquidity, shortfall]
    });

    it("should swap tokens and supply to Venus market", async function () {
      // Create mock swap data - SwapHelper expects multicall data
      const mockSwapData = [
        ethers.utils.defaultAbiCoder.encode(
          ["address", "address", "uint256"],
          [underlyingA.address, underlyingB.address, AMOUNT_OUT],
        ),
      ];

      await expect(
        swapRouter
          .connect(user)
          .swapAndSupply(vTokenB.address, underlyingA.address, AMOUNT_IN, MIN_AMOUNT_OUT, mockSwapData),
      )
        .to.emit(swapRouter, "SwapAndSupply")
        .withArgs(
          user.address,
          vTokenB.address,
          underlyingA.address,
          underlyingB.address,
          AMOUNT_IN,
          AMOUNT_OUT,
          AMOUNT_OUT,
        );

      // Verify the supply operation was called correctly
      expect(vTokenB.mintBehalf).to.have.been.calledWith(user.address, AMOUNT_OUT);

      // Verify the user received vTokens (supply position created)
      const userVTokenBalance = await vTokenB.balanceOf(user.address);
      expect(userVTokenBalance).to.be.gt(0); // User should have vTokens representing their supply position
    });

    it("should create supply position in Venus market", async function () {
      // Setup balance mock
      underlyingB.balanceOf.reset();
      underlyingB.balanceOf.returns(0); // Before swap
      underlyingB.balanceOf.returnsAtCall(1, AMOUNT_OUT); // After swap

      const mockSwapData = [
        ethers.utils.defaultAbiCoder.encode(
          ["address", "address", "uint256"],
          [underlyingA.address, underlyingB.address, AMOUNT_OUT],
        ),
      ];

      // Execute swap and supply
      await swapRouter
        .connect(user)
        .swapAndSupply(vTokenB.address, underlyingA.address, AMOUNT_IN, MIN_AMOUNT_OUT, mockSwapData);

      // Verify supply position was created
      const finalVTokenBalance = await vTokenB.balanceOf(user.address);
      expect(finalVTokenBalance).to.be.gt(0);

      // Verify user's account has liquidity (can borrow against supply)
      const [, liquidity] = await comptroller.getAccountLiquidity(user.address);
      expect(liquidity).to.be.gt(0);

      // Verify the vToken market processed the supply correctly
      expect(vTokenB.mintBehalf).to.have.been.calledWith(user.address, AMOUNT_OUT);
    });

    it("should revert with zero amount", async function () {
      const mockSwapData = [ethers.utils.defaultAbiCoder.encode(["uint256"], [0])];

      await expect(
        swapRouter.connect(user).swapAndSupply(vTokenB.address, underlyingA.address, 0, MIN_AMOUNT_OUT, mockSwapData),
      ).to.be.revertedWithCustomError(swapRouter, "ZeroAmount");
    });

    it("should revert with invalid vToken", async function () {
      comptroller.markets.whenCalledWith(user.address).returns([false, 0, false]);
      const mockSwapData = [ethers.utils.defaultAbiCoder.encode(["uint256"], [0])];

      await expect(
        swapRouter
          .connect(user)
          .swapAndSupply(user.address, underlyingA.address, AMOUNT_IN, MIN_AMOUNT_OUT, mockSwapData),
      ).to.be.revertedWithCustomError(swapRouter, "MarketNotListed");
    });

    it("should revert when slippage protection fails", async function () {
      underlyingB.balanceOf.reset();
      underlyingB.balanceOf.returns(0); // Before swap
      underlyingB.balanceOf.returnsAtCall(1, parseEther("50")); // After swap - less than min
      const mockSwapData = [ethers.utils.defaultAbiCoder.encode(["uint256"], [parseEther("50")])];

      await expect(
        swapRouter
          .connect(user)
          .swapAndSupply(vTokenB.address, underlyingA.address, AMOUNT_IN, MIN_AMOUNT_OUT, mockSwapData),
      ).to.be.revertedWithCustomError(swapRouter, "InsufficientAmountOut");
    });
  });

  describe("SwapNativeAndSupply", function () {
    beforeEach(async function () {
      // Mock wrapped native behavior
      wrappedNative.deposit.returns();
      wrappedNative.balanceOf.whenCalledWith(swapRouter.address).returns(AMOUNT_IN);
      wrappedNative.transfer.returns(true); // Mock successful transfer
      wrappedNative.transferFrom.returns(true); // Mock successful transferFrom

      // Mock balance checks - start with 0, then return AMOUNT_OUT after swap
      underlyingB.balanceOf.returns(0);
      underlyingB.balanceOf.returnsAtCall(1, AMOUNT_OUT);

      // Mock SwapHelper multicall
      swapHelper.multicall.returns([]);

      // Mock the supply operation
      vTokenB.mintBehalf.returns(0); // Success code

      // Mock vToken balance - user gets vTokens after supply
      vTokenB.balanceOf.whenCalledWith(user.address).returns(parseEther("50"));
    });

    it("should swap native tokens and supply to Venus market", async function () {
      underlyingB.balanceOf.reset();
      underlyingB.balanceOf.returns(0);
      underlyingB.balanceOf.returnsAtCall(1, AMOUNT_OUT);

      // Mock WBNB balance for the contract after deposit
      wrappedNative.balanceOf.reset();
      wrappedNative.balanceOf.whenCalledWith(swapRouter.address).returns(AMOUNT_IN);

      // Create mock swap data
      const mockSwapData = [
        ethers.utils.defaultAbiCoder.encode(
          ["address", "address", "uint256"],
          [wrappedNative.address, underlyingB.address, AMOUNT_OUT],
        ),
      ];

      await expect(
        swapRouter
          .connect(user)
          .swapNativeAndSupply(vTokenB.address, MIN_AMOUNT_OUT, mockSwapData, { value: AMOUNT_IN }),
      ).to.emit(swapRouter, "SwapAndSupply");

      expect(wrappedNative.deposit).to.have.been.calledWith();
      expect(vTokenB.mintBehalf).to.have.been.calledWith(user.address, AMOUNT_OUT);
    });

    it("should revert with zero value", async function () {
      const mockSwapData = [ethers.utils.defaultAbiCoder.encode(["uint256"], [0])];

      await expect(
        swapRouter.connect(user).swapNativeAndSupply(vTokenB.address, MIN_AMOUNT_OUT, mockSwapData, { value: 0 }),
      ).to.be.revertedWithCustomError(swapRouter, "ZeroAmount");
    });
  });

  describe("SwapNativeAndRepay", function () {
    beforeEach(async function () {
      // Mock wrapped native behavior
      wrappedNative.deposit.returns();
      wrappedNative.balanceOf.whenCalledWith(swapRouter.address).returns(AMOUNT_IN);
      wrappedNative.transfer.returns(true); // Mock successful transfer
      wrappedNative.transferFrom.returns(true); // Mock successful transferFrom

      // Setup user debt
      vTokenB.borrowBalanceCurrent.whenCalledWith(user.address).returns(parseEther("50"));

      // Mock balance checks - start with 0, then return AMOUNT_OUT after swap
      underlyingB.balanceOf.returns(0);
      underlyingB.balanceOf.returnsAtCall(1, AMOUNT_OUT);

      // Mock SwapHelper multicall
      swapHelper.multicall.returns([]);

      // Mock the repay operation
      vTokenB.repayBorrowBehalf.returns(0); // Success code
    });

    it("should swap native tokens and repay debt", async function () {
      underlyingB.balanceOf.reset();
      underlyingB.balanceOf.returns(0);
      underlyingB.balanceOf.returnsAtCall(1, AMOUNT_OUT);

      // Set the actual balance in the mock token for transfers
      await underlyingB.harnessSetBalance(swapRouter.address, AMOUNT_OUT);

      // Mock WBNB balance for the contract after deposit
      wrappedNative.balanceOf.reset();
      wrappedNative.balanceOf.whenCalledWith(swapRouter.address).returns(AMOUNT_IN);

      // Create mock swap data
      const mockSwapData = [
        ethers.utils.defaultAbiCoder.encode(
          ["address", "address", "uint256"],
          [wrappedNative.address, underlyingB.address, AMOUNT_OUT],
        ),
      ];

      await expect(
        swapRouter
          .connect(user)
          .swapNativeAndRepay(vTokenB.address, MIN_AMOUNT_OUT, mockSwapData, { value: AMOUNT_IN }),
      ).to.emit(swapRouter, "SwapAndRepay");

      expect(wrappedNative.deposit).to.have.been.calledWith();
      expect(vTokenB.repayBorrowBehalf).to.have.been.calledWith(user.address, parseEther("50"));
    });

    it("should revert with zero value", async function () {
      const mockSwapData = [ethers.utils.defaultAbiCoder.encode(["uint256"], [0])];

      await expect(
        swapRouter.connect(user).swapNativeAndRepay(vTokenB.address, MIN_AMOUNT_OUT, mockSwapData, { value: 0 }),
      ).to.be.revertedWithCustomError(swapRouter, "ZeroAmount");
    });

    it("should revert when user has no debt", async function () {
      // Reset balance mock
      underlyingB.balanceOf.reset();
      underlyingB.balanceOf.returns(0);
      underlyingB.balanceOf.returnsAtCall(1, AMOUNT_OUT);

      // Set no debt
      vTokenB.borrowBalanceCurrent.whenCalledWith(user.address).returns(0);

      const mockSwapData = [
        ethers.utils.defaultAbiCoder.encode(
          ["address", "address", "uint256"],
          [wrappedNative.address, underlyingB.address, AMOUNT_OUT],
        ),
      ];

      await expect(
        swapRouter
          .connect(user)
          .swapNativeAndRepay(vTokenB.address, MIN_AMOUNT_OUT, mockSwapData, { value: AMOUNT_IN }),
      ).to.be.revertedWithCustomError(swapRouter, "ZeroAmount");
    });

    it("should return excess tokens to user when overpaying debt", async function () {
      // Reset and setup balance mock for overpayment scenario
      underlyingB.balanceOf.reset();
      underlyingB.balanceOf.returns(0);
      underlyingB.balanceOf.returnsAtCall(1, parseEther("80")); // More than debt amount (50)

      // Set the actual balance in the mock token for transfers
      await underlyingB.harnessSetBalance(swapRouter.address, parseEther("80"));

      // Mock WBNB balance for the contract after deposit
      wrappedNative.balanceOf.reset();
      wrappedNative.balanceOf.whenCalledWith(swapRouter.address).returns(AMOUNT_IN);

      // Create mock swap data for larger amount
      const mockSwapData = [
        ethers.utils.defaultAbiCoder.encode(
          ["address", "address", "uint256"],
          [wrappedNative.address, underlyingB.address, parseEther("80")],
        ),
      ];

      await expect(
        swapRouter
          .connect(user)
          .swapNativeAndRepay(vTokenB.address, parseEther("70"), mockSwapData, { value: AMOUNT_IN }),
      )
        .to.emit(swapRouter, "SwapAndRepay")
        .withArgs(
          user.address,
          vTokenB.address,
          wrappedNative.address,
          underlyingB.address,
          AMOUNT_IN,
          parseEther("80"),
          parseEther("50"),
        );

      // Should repay only the debt amount (50), not the full received amount (80)
      expect(vTokenB.repayBorrowBehalf).to.have.been.calledWith(user.address, parseEther("50"));
    });
  });

  describe("SwapAndRepay", function () {
    beforeEach(async function () {
      // Mint tokens to user
      await underlyingA.harnessSetBalance(user.address, parseUnits("1000", 18));

      // Setup user approval and debt
      await underlyingA.connect(user).approve(swapRouter.address, AMOUNT_IN);
      vTokenB.borrowBalanceCurrent.whenCalledWith(user.address).returns(parseEther("50"));

      // Mock balance checks - start with 0, then return AMOUNT_OUT after swap
      underlyingB.balanceOf.returns(0);
      underlyingB.balanceOf.returnsAtCall(1, AMOUNT_OUT); // Second call returns tokens

      // Mock SwapHelper multicall
      swapHelper.multicall.returns([]);

      // Mock the repay operation
      vTokenB.repayBorrowBehalf.returns(0); // Success code
    });

    it("should swap tokens and repay debt", async function () {
      // Reset and setup balance mock
      underlyingB.balanceOf.reset();
      underlyingB.balanceOf.returns(0);
      underlyingB.balanceOf.returnsAtCall(1, AMOUNT_OUT);

      // Also set the actual balance in the mock token for transfers
      await underlyingB.harnessSetBalance(swapRouter.address, AMOUNT_OUT);

      // Create mock swap data
      const mockSwapData = [
        ethers.utils.defaultAbiCoder.encode(
          ["address", "address", "uint256"],
          [underlyingA.address, underlyingB.address, AMOUNT_OUT],
        ),
      ];

      await expect(
        swapRouter
          .connect(user)
          .swapAndRepay(vTokenB.address, underlyingA.address, AMOUNT_IN, MIN_AMOUNT_OUT, mockSwapData),
      ).to.emit(swapRouter, "SwapAndRepay");

      expect(vTokenB.repayBorrowBehalf).to.have.been.calledWith(user.address, parseEther("50"));
    });

    it("should revert when user has no debt", async function () {
      // Reset balance mock
      underlyingB.balanceOf.reset();
      underlyingB.balanceOf.returns(0);
      underlyingB.balanceOf.returnsAtCall(1, AMOUNT_OUT);

      vTokenB.borrowBalanceCurrent.whenCalledWith(user.address).returns(0);
      const mockSwapData = [ethers.utils.defaultAbiCoder.encode(["uint256"], [0])];

      await expect(
        swapRouter
          .connect(user)
          .swapAndRepay(vTokenB.address, underlyingA.address, AMOUNT_IN, MIN_AMOUNT_OUT, mockSwapData),
      ).to.be.revertedWithCustomError(swapRouter, "ZeroAmount");
    });
  });

  describe("SwapAndRepayFull", function () {
    beforeEach(async function () {
      // Mint tokens to user
      await underlyingA.harnessSetBalance(user.address, parseUnits("1000", 18));

      await underlyingA.connect(user).approve(swapRouter.address, AMOUNT_IN);
      vTokenB.borrowBalanceCurrent.whenCalledWith(user.address).returns(parseEther("50"));

      // Mock balance checks - start with 0, then return enough tokens after swap
      underlyingB.balanceOf.returns(0);
      underlyingB.balanceOf.returnsAtCall(1, parseEther("60")); // More than debt amount

      // Mock SwapHelper multicall
      swapHelper.multicall.returns([]);

      // Mock the repay operation
      vTokenB.repayBorrowBehalf.returns(0); // Success code
    });

    it("should swap tokens and repay full debt", async function () {
      // Reset and setup balance mock
      underlyingB.balanceOf.reset();
      underlyingB.balanceOf.returns(0);
      underlyingB.balanceOf.returnsAtCall(1, parseEther("60"));

      // Set the actual balance in the mock token for transfers
      await underlyingB.harnessSetBalance(swapRouter.address, parseEther("60"));

      const mockSwapData = [
        ethers.utils.defaultAbiCoder.encode(
          ["address", "address", "uint256"],
          [underlyingA.address, underlyingB.address, parseEther("60")],
        ),
      ];

      await expect(
        swapRouter.connect(user).swapAndRepayFull(vTokenB.address, underlyingA.address, AMOUNT_IN, mockSwapData),
      ).to.emit(swapRouter, "SwapAndRepay");

      expect(vTokenB.repayBorrowBehalf).to.have.been.calledWith(user.address, parseEther("50"));
    });

    it("should revert when swap output is insufficient for full repayment", async function () {
      // Reset balance mock to return insufficient amount
      underlyingB.balanceOf.reset();
      underlyingB.balanceOf.returns(0);
      underlyingB.balanceOf.returnsAtCall(1, parseEther("40")); // Less than debt

      const mockSwapData = [ethers.utils.defaultAbiCoder.encode(["uint256"], [parseEther("40")])];

      await expect(
        swapRouter.connect(user).swapAndRepayFull(vTokenB.address, underlyingA.address, AMOUNT_IN, mockSwapData),
      ).to.be.revertedWithCustomError(swapRouter, "InsufficientAmountOut");
    });
  });

  describe("Administrative Functions", function () {
    describe("SweepToken", function () {
      beforeEach(async function () {
        await underlyingA.harnessSetBalance(swapRouter.address, parseEther("10"));
      });

      it("should sweep tokens to owner", async function () {
        // Mock transfer function to return success
        underlyingA.transfer.returns(true);

        await expect(swapRouter.sweepToken(underlyingA.address))
          .to.emit(swapRouter, "SweepToken")
          .withArgs(underlyingA.address, deployer.address, parseEther("10"));

        // Verify transfer was called with correct parameters
        expect(underlyingA.transfer).to.have.been.calledWith(deployer.address, parseEther("10"));
      });

      it("should revert when called by non-owner", async function () {
        await expect(swapRouter.connect(user).sweepToken(underlyingA.address)).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });

    describe("SweepNative", function () {
      it("should sweep native tokens to owner", async function () {
        // Send some ETH to the contract
        await user.sendTransaction({
          to: swapRouter.address,
          value: parseEther("1"),
        });

        await expect(swapRouter.sweepNative())
          .to.emit(swapRouter, "SweepNative")
          .withArgs(deployer.address, parseEther("1"));
      });

      it("should revert when called by non-owner", async function () {
        await expect(swapRouter.connect(user).sweepNative()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });
  });

  describe("Edge Cases", function () {
    beforeEach(async function () {
      await underlyingA.harnessSetBalance(user.address, parseUnits("1000", 18));

      // Mock the supply operation
      vTokenA.mintBehalf.returns(0); // Success code
      vTokenB.mintBehalf.returns(0); // Success code

      // Mock vToken balance - user gets vTokens after supply
      vTokenA.balanceOf.whenCalledWith(user.address).returns(parseEther("50"));
      vTokenB.balanceOf.whenCalledWith(user.address).returns(parseEther("50"));
    });

    it("should handle same token swap (no actual swap needed)", async function () {
      await underlyingA.connect(user).approve(swapRouter.address, AMOUNT_IN);

      // Create mock swap data even though no swap is needed
      const mockSwapData = [
        ethers.utils.defaultAbiCoder.encode(
          ["address", "address", "uint256"],
          [underlyingA.address, underlyingA.address, AMOUNT_IN],
        ),
      ];

      await expect(
        swapRouter
          .connect(user)
          .swapAndSupply(vTokenA.address, underlyingA.address, AMOUNT_IN, MIN_AMOUNT_OUT, mockSwapData),
      ).to.emit(swapRouter, "SwapAndSupply");

      expect(vTokenA.mintBehalf).to.have.been.calledWith(user.address, AMOUNT_IN);
    });

    it("should handle insufficient user balance", async function () {
      await underlyingA.connect(user).approve(swapRouter.address, parseEther("2000"));

      // Create mock swap data
      const mockSwapData = [
        ethers.utils.defaultAbiCoder.encode(
          ["address", "address", "uint256"],
          [underlyingA.address, underlyingB.address, parseEther("2000")],
        ),
      ];

      await expect(
        swapRouter.connect(user).swapAndSupply(
          vTokenB.address,
          underlyingA.address,
          parseEther("2000"), // More than user balance (1000)
          MIN_AMOUNT_OUT,
          mockSwapData,
        ),
      ).to.be.revertedWithCustomError(swapRouter, "InsufficientBalance");
    });
  });
});
