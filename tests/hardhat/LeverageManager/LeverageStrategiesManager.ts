import { FakeContract, smock } from "@defi-wonderland/smock";
import { loadFixture, setBalance } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { BigNumber, Contract, Signer, Wallet } from "ethers";
import { parseEther, parseUnits } from "ethers/lib/utils";
import { ethers, network, upgrades } from "hardhat";

import {
  ComptrollerLensInterface,
  ComptrollerMock,
  EIP20Interface,
  IAccessControlManagerV8,
  IProtocolShareReserve,
  IVToken,
  InterestRateModel,
  LeverageStrategiesManager,
  MockVBNB,
  PositionSwapper,
  ResilientOracleInterface,
  SwapHelper,
  VBep20Harness,
} from "../../../typechain";

type SetupFixture = {
  comptroller: ComptrollerMock;
  leverageManager: LeverageStrategiesManager;
  protocolShareReserve: FakeContract<IProtocolShareReserve>;
  swapHelper: FakeContract<SwapHelper>;
  collateralMarket: VBep20Harness;
  collateral: EIP20Interface;
  borrowMarket: VBep20Harness;
  borrow: EIP20Interface;
  unlistedMarket: VBep20Harness;
};

async function deployVToken(
  symbol: string,
  comptroller: Contract,
  acm: string,
  irm: string,
  psr: string,
  admin: string,
  isListed: boolean = true,
): Promise<{ mockToken: EIP20Interface; vToken: VBep20Harness }> {
  const MockTokenFactory = await ethers.getContractFactory("MockToken");
  const mockToken = await MockTokenFactory.deploy(symbol, symbol, 18);

  const vTokenFactory = await ethers.getContractFactory("VBep20Harness");
  const vTokenConfig = {
    initialExchangeRateMantissa: parseUnits("1", 28),
    name: "Venus " + symbol,
    symbol: "v" + symbol,
    decimals: 8,
    becomeImplementationData: "0x",
  };

  const vToken = await vTokenFactory.deploy(
    mockToken.address,
    comptroller.address,
    irm,
    vTokenConfig.initialExchangeRateMantissa,
    vTokenConfig.name,
    vTokenConfig.symbol,
    vTokenConfig.decimals,
    admin,
  );
  await vToken.setAccessControlManager(acm);
  await vToken.setProtocolShareReserve(psr);
  await vToken.setFlashLoanEnabled(true);
  await comptroller._setMarketSupplyCaps([vToken.address], [parseUnits("1000", 18)]);
  await comptroller._setMarketBorrowCaps([vToken.address], [parseUnits("1000", 18)]);

  if (isListed) {
    await comptroller.supportMarket(vToken.address);
    await comptroller.setIsBorrowAllowed(0, vToken.address, true);
  }

  await mockToken.faucet(parseEther("100"));
  await mockToken.approve(vToken.address, parseEther("50"));

  return { mockToken, vToken };
}

const setupFixture = async (): Promise<SetupFixture> => {
  const [admin] = await ethers.getSigners();

  const accessControl = await smock.fake<IAccessControlManagerV8>("AccessControlManager");
  accessControl.isAllowedToCall.returns(true);

  const comptrollerLens = await smock.fake<ComptrollerLensInterface>("ComptrollerLens");
  const protocolShareReserve = await smock.fake<IProtocolShareReserve>(
    "contracts/Interfaces.sol:IProtocolShareReserve",
  );
  const interestRateModel = await smock.fake<InterestRateModel>("InterestRateModelHarness");
  interestRateModel.isInterestRateModel.returns(true);
  const resilientOracle = await smock.fake<ResilientOracleInterface>("ResilientOracleInterface");
  resilientOracle.getUnderlyingPrice.returns(parseUnits("1", 18));

  const comptrollerFactory = await ethers.getContractFactory("ComptrollerMock");
  const comptroller = await comptrollerFactory.deploy();
  await comptroller._setAccessControl(accessControl.address);
  await comptroller._setComptrollerLens(comptrollerLens.address);
  await comptroller.setPriceOracle(resilientOracle.address);

  const { mockToken: collateral, vToken: collateralMarket } = await deployVToken(
    "USDT",
    comptroller,
    accessControl.address,
    interestRateModel.address,
    protocolShareReserve.address,
    admin.address,
  );

  const { mockToken: borrow, vToken: borrowMarket } = await deployVToken(
    "BUSD",
    comptroller,
    accessControl.address,
    interestRateModel.address,
    protocolShareReserve.address,
    admin.address,
  );

  const { mockToken, vToken: unlistedMarket } = await deployVToken(
    "UNLISTED",
    comptroller,
    accessControl.address,
    interestRateModel.address,
    protocolShareReserve.address,
    admin.address,
    false,
  );

  const SwapHelperFactory = await ethers.getContractFactory("SwapHelper");
  const swapHelper = await SwapHelperFactory.deploy(admin.address);

  const LeverageStrategiesManagerFactory = await ethers.getContractFactory("LeverageStrategiesManager");
  const leverageManager = (await LeverageStrategiesManagerFactory.deploy(
    comptroller.address,
    protocolShareReserve.address,
    swapHelper.address,
  )) as LeverageStrategiesManager;
  await leverageManager.deployed();

  await comptroller.setWhiteListFlashLoanAccount(leverageManager.address, true);

  await setBalance(comptroller.address, parseEther("10"));

  return {
    comptroller,
    leverageManager,
    protocolShareReserve,
    swapHelper,
    collateralMarket,
    collateral,
    borrowMarket,
    borrow,
    unlistedMarket,
  };
};

describe("LeverageStrategiesManager", () => {
  let leverageManager: LeverageStrategiesManager;
  let comptroller: ComptrollerMock;
  let swapHelper: FakeContract<SwapHelper>;
  let admin: Wallet;
  let alice: Signer;
  let aliceAddress: string;
  let bob: Signer;
  let collateralMarket: VBep20Harness;
  let collateral: EIP20Interface;
  let borrowMarket: VBep20Harness;
  let borrow: EIP20Interface;
  let protocolShareReserve: FakeContract<IProtocolShareReserve>;
  let unlistedMarket: VBep20Harness;

  beforeEach(async () => {
    [admin, alice, bob] = await ethers.getSigners();
    ({
      leverageManager,
      comptroller,
      protocolShareReserve,
      swapHelper,
      collateralMarket,
      borrowMarket,
      collateral,
      borrow,
      unlistedMarket,
    } = await loadFixture(setupFixture));

    await comptroller.connect(alice).updateDelegate(leverageManager.address, true);

    await collateralMarket.mint(parseUnits("20", 18));
    await borrowMarket.mint(parseUnits("20", 18));
    aliceAddress = await alice.getAddress();
  });

  async function createEmptySwapMulticallData(signer: Wallet, salt: string): Promise<string> {
    // Create EIP-712 signature
    const domain = {
      chainId: network.config.chainId,
      name: "VenusSwap",
      verifyingContract: swapHelper.address,
      version: "1",
    };
    const types = {
      Multicall: [
        { name: "calls", type: "bytes[]" },
        { name: "deadline", type: "uint256" },
        { name: "salt", type: "bytes32" },
      ],
    };

    const calls: string[] = [];

    const deadline = "17627727131762772187";
    const saltValue = salt || ethers.utils.formatBytes32String(Math.random().toString());
    const signature = await signer._signTypedData(domain, types, { calls, deadline, salt: saltValue });

    // Encode multicall with all parameters
    const multicallData = swapHelper.interface.encodeFunctionData("multicall", [calls, deadline, saltValue, signature]);

    return multicallData;
  }

  async function createSwapMulticallData(
    token: EIP20Interface,
    recipient: string,
    amount: BigNumber,
    signer: Wallet,
    salt: string,
  ): Promise<string> {
    const tokenAddress = token.address;

    // Transfer token to swapHelper if amount is provided
    if (amount) {
      await token.transfer(swapHelper.address, amount);
    }

    // Encode sweep function call
    const sweepData = swapHelper.interface.encodeFunctionData("sweep", [tokenAddress, recipient]);

    // Create EIP-712 signature
    const domain = {
      chainId: network.config.chainId,
      name: "VenusSwap",
      verifyingContract: swapHelper.address,
      version: "1",
    };
    const types = {
      Multicall: [
        { name: "calls", type: "bytes[]" },
        { name: "deadline", type: "uint256" },
        { name: "salt", type: "bytes32" },
      ],
    };
    const calls = [sweepData];
    const deadline = "17627727131762772187";
    const saltValue = salt || ethers.utils.formatBytes32String(Math.random().toString());
    const signature = await signer._signTypedData(domain, types, { calls, deadline, salt: saltValue });

    // Encode multicall with all parameters
    const multicallData = swapHelper.interface.encodeFunctionData("multicall", [calls, deadline, saltValue, signature]);

    return multicallData;
  }

  describe("Deployment & Initialization", () => {
    it("should deploy successfully", async () => {
      expect(leverageManager.address).to.satisfy(ethers.utils.isAddress);
    });

    it("should deploy with correct immutable variables", async () => {
      expect(await leverageManager.COMPTROLLER()).to.equal(comptroller.address);
      expect(await leverageManager.protocolShareReserve()).to.equal(protocolShareReserve.address);
      expect(await leverageManager.swapHelper()).to.equal(swapHelper.address);
    });

    it("should initialize correctly", async () => {
      expect(leverageManager.address).to.satisfy(ethers.utils.isAddress);

      await expect(leverageManager.initialize()).to.be.rejectedWith("Initializable: contract is already initialized");
    });

    it("should revert if initialized twice", async () => {
      await expect(leverageManager.initialize()).to.be.rejectedWith("Initializable: contract is already initialized");
    });
  });

  describe("enterLeveragedPositionWithCollateral", () => {
    it("should revert when collateral market is not listed", async () => {
      const collateralAmountSeed = parseEther("0");
      const borrowedAmountToFlashLoan = parseEther("1");
      const swapData = await createEmptySwapMulticallData(admin, ethers.utils.formatBytes32String("3"));

      await expect(
        leverageManager.connect(alice).enterLeveragedPositionWithCollateral(
          unlistedMarket.address,
          collateralAmountSeed,
          borrowMarket.address,
          borrowedAmountToFlashLoan,
          0, // minAmountCollateralAfterSwap
          swapData,
        ),
      )
        .to.be.revertedWithCustomError(leverageManager, "MarketNotListed")
        .withArgs(unlistedMarket.address);
    });

    it("should revert when borrow market is not listed", async () => {
      const collateralAmountSeed = parseEther("0");
      const borrowedAmountToFlashLoan = parseEther("1");
      const swapData = await createEmptySwapMulticallData(admin, ethers.utils.formatBytes32String("3"));

      await expect(
        leverageManager.connect(alice).enterLeveragedPositionWithCollateral(
          collateralMarket.address,
          collateralAmountSeed,
          unlistedMarket.address,
          borrowedAmountToFlashLoan,
          0, // minAmountCollateralAfterSwap
          swapData,
        ),
      )
        .to.be.revertedWithCustomError(leverageManager, "MarketNotListed")
        .withArgs(unlistedMarket.address);
    });

    it("should revert when user has not set delegation", async () => {
      const collateralAmountSeed = parseEther("0");
      const borrowedAmountToFlashLoan = parseEther("1");
      const swapData = await createEmptySwapMulticallData(admin, ethers.utils.formatBytes32String("3"));

      await comptroller.connect(alice).updateDelegate(leverageManager.address, false);

      await expect(
        leverageManager.connect(alice).enterLeveragedPositionWithCollateral(
          collateralMarket.address,
          collateralAmountSeed,
          borrowMarket.address,
          borrowedAmountToFlashLoan,
          0, // minAmountCollateralAfterSwap
          swapData,
        ),
      ).to.be.revertedWithCustomError(comptroller, "NotAnApprovedDelegate");
    });

    it.skip("should revert when account is not safe before leverage", async () => {
      // TODO: Setup comptroller to make account unsafe

      await expect(
        leverageManager.connect(alice).enterLeveragedPositionWithCollateral(
          collateralMarket.address,
          parseEther("0"),
          borrowMarket.address,
          parseEther("1"),
          0, // minAmountCollateralAfterSwap
          await createEmptySwapMulticallData(admin, ethers.utils.formatBytes32String("3")),
        ),
      ).to.be.revertedWithCustomError(leverageManager, "LeverageCausesLiquidation");
    });

    it.skip("should revert when uses did not entered collateral market before and enterMarketBehalf fails ", async () => {
      // TODO: Setup comptroller to make enterMarketBehalf fail
      const expectedErrorCode = 1;

      await expect(
        leverageManager.connect(alice).enterLeveragedPositionWithCollateral(
          collateralMarket.address,
          parseEther("0"),
          borrowMarket.address,
          parseEther("1"),
          0, // minAmountCollateralAfterSwap
          await createEmptySwapMulticallData(admin, ethers.utils.formatBytes32String("3")),
        ),
      )
        .to.be.revertedWithCustomError(leverageManager, "EnterMarketFailed")
        .withArgs(expectedErrorCode);
    });

    it("should revert when user did not approve enough collateral for transfer", async () => {
      const collateralAmountSeed = parseEther("10");
      const borrowedAmountToFlashLoan = parseEther("1");
      const swapData = await createEmptySwapMulticallData(admin, ethers.utils.formatBytes32String("3"));

      await collateral.connect(alice).approve(leverageManager.address, parseEther("1"));

      await expect(
        leverageManager.connect(alice).enterLeveragedPositionWithCollateral(
          collateralMarket.address,
          collateralAmountSeed,
          borrowMarket.address,
          borrowedAmountToFlashLoan,
          0, // minAmountCollateralAfterSwa
          swapData,
        ),
      ).to.be.rejectedWith("ERC20: insufficient allowance");

      await collateral.connect(alice).approve(leverageManager.address, collateralAmountSeed);

      await await expect(
        leverageManager.connect(alice).enterLeveragedPositionWithCollateral(
          collateralMarket.address,
          collateralAmountSeed,
          borrowMarket.address,
          borrowedAmountToFlashLoan,
          0, // minAmountCollateralAfterSwap
          swapData,
        ),
      ).to.be.rejectedWith("ERC20: transfer amount exceeds balance");
    });

    it("should revert when swap fails", async () => {
      const collateralAmountSeed = parseEther("0");
      const borrowedAmountToFlashLoan = parseEther("10");

      const swapData = await createEmptySwapMulticallData(admin, ethers.utils.formatBytes32String("4"));

      await expect(
        leverageManager.connect(alice).enterLeveragedPositionWithCollateral(
          collateralMarket.address,
          collateralAmountSeed,
          borrowMarket.address,
          borrowedAmountToFlashLoan,
          0, // minAmountCollateralAfterSwap
          swapData,
        ),
      ).to.be.revertedWithCustomError(leverageManager, "TokenSwapCallFailed");
    });

    it("should revert when aftrer swap, received less collateral than minAmountCollateralAfterSwap", async () => {
      const collateralAmountSeed = parseEther("0");
      const borrowedAmountToFlashLoan = parseEther("1");
      const minAmountCollateralAfterSwap = parseEther("2");

      const swapData = await createSwapMulticallData(
        collateral,
        leverageManager.address,
        parseEther("1"),
        admin,
        ethers.utils.formatBytes32String("5"),
      );
      await expect(
        leverageManager
          .connect(alice)
          .enterLeveragedPositionWithCollateral(
            collateralMarket.address,
            collateralAmountSeed,
            borrowMarket.address,
            borrowedAmountToFlashLoan,
            minAmountCollateralAfterSwap,
            swapData,
          ),
      ).to.be.revertedWithCustomError(leverageManager, "InsufficientAmountOutAfterSwap");
    });

    it("should enter leveraged position with collateral successfully", async () => {
      const collateralAmountSeed = parseEther("0");
      const borrowedAmountToFlashLoan = parseEther("1");

      const swapData = await createSwapMulticallData(
        collateral,
        leverageManager.address,
        parseEther("1"),
        admin,
        ethers.utils.formatBytes32String("6"),
      );

      const aliceCollateralBalanceBefore = await collateralMarket.callStatic.balanceOfUnderlying(aliceAddress);

      const enterLeveragedPositionWithCollateralTx = await leverageManager
        .connect(alice)
        .enterLeveragedPositionWithCollateral(
          collateralMarket.address,
          collateralAmountSeed,
          borrowMarket.address,
          borrowedAmountToFlashLoan,
          parseEther("1"), // minAmountCollateralAfterSwap
          swapData,
        );

      // TODO: Check final positions
      expect(await collateralMarket.callStatic.balanceOfUnderlying(aliceAddress)).to.be.gt(
        aliceCollateralBalanceBefore,
      );

      expect(enterLeveragedPositionWithCollateralTx)
        .to.emit(leverageManager, "LeveragedPositionEnteredWithCollateral")
        .withArgs(
          aliceAddress,
          collateralMarket.address,
          borrowMarket.address,
          collateralAmountSeed,
          borrowedAmountToFlashLoan,
        );
    });

    it.skip("should revert when account is not safe after entering leveraged position", async () => {});
  });

  describe("enterLeveragedPositionWithBorrowed", () => {
    it("should revert when collateral market is not listed", async () => {
      const borrowedAmountToFlashLoan = parseEther("1");
      const borrowedAmountSeed = parseEther("0");
      const swapData = await createEmptySwapMulticallData(admin, ethers.utils.formatBytes32String("3"));

      await expect(
        leverageManager.connect(alice).enterLeveragedPositionWithBorrowed(
          unlistedMarket.address,
          borrowMarket.address,
          borrowedAmountSeed,
          borrowedAmountToFlashLoan,
          0, // minAmountCollateralAfterSwap
          swapData,
        ),
      )
        .to.be.revertedWithCustomError(leverageManager, "MarketNotListed")
        .withArgs(unlistedMarket.address);
    });

    it("should revert when borrow market is not listed", async () => {
      const borrowedAmountToFlashLoan = parseEther("1");
      const borrowedAmountSeed = parseEther("0");
      const swapData = await createEmptySwapMulticallData(admin, ethers.utils.formatBytes32String("3"));

      await expect(
        leverageManager.connect(alice).enterLeveragedPositionWithBorrowed(
          collateralMarket.address,
          unlistedMarket.address,
          borrowedAmountSeed,
          borrowedAmountToFlashLoan,
          0, // minAmountCollateralAfterSwap
          swapData,
        ),
      )
        .to.be.revertedWithCustomError(leverageManager, "MarketNotListed")
        .withArgs(unlistedMarket.address);
    });

    it("should revert when user has not set delegation", async () => {
      const borrowedAmountToFlashLoan = parseEther("1");
      const borrowedAmountSeed = parseEther("0");
      const swapData = await createEmptySwapMulticallData(admin, ethers.utils.formatBytes32String("3"));

      await comptroller.connect(alice).updateDelegate(leverageManager.address, false);
      await expect(
        leverageManager.connect(alice).enterLeveragedPositionWithBorrowed(
          collateralMarket.address,
          borrowMarket.address,
          borrowedAmountSeed,
          borrowedAmountToFlashLoan,
          0, // minAmountCollateralAfterSwap
          swapData,
        ),
      ).to.be.revertedWithCustomError(comptroller, "NotAnApprovedDelegate");
    });

    it.skip("should revert when account is not safe before leverage", async () => {
      const borrowedAmountToFlashLoan = parseEther("1");
      const borrowedAmountSeed = parseEther("0");
      const swapData = await createEmptySwapMulticallData(admin, ethers.utils.formatBytes32String("3"));

      // TODO: Setup comptroller to make account unsafe

      await expect(
        leverageManager.connect(alice).enterLeveragedPositionWithBorrowed(
          collateralMarket.address,
          borrowMarket.address,
          borrowedAmountSeed,
          borrowedAmountToFlashLoan,
          0, // minAmountCollateralAfterSwap
          swapData,
        ),
      ).to.be.revertedWithCustomError(leverageManager, "LeverageCausesLiquidation");
    });

    it.skip("should revert when uses did not entered collateral market before and enterMarketBehalf fails ", async () => {
      const borrowedAmountToFlashLoan = parseEther("1");
      const borrowedAmountSeed = parseEther("0");
      const swapData = await createEmptySwapMulticallData(admin, ethers.utils.formatBytes32String("3"));

      // TODO: Setup comptroller to make enterMarketBehalf fail
      const expectedErrorCode = 1;

      await expect(
        leverageManager.connect(alice).enterLeveragedPositionWithBorrowed(
          collateralMarket.address,
          borrowMarket.address,
          borrowedAmountSeed,
          borrowedAmountToFlashLoan,
          0, // minAmountCollateralAfterSwap
          swapData,
        ),
      )
        .to.be.revertedWithCustomError(leverageManager, "EnterMarketFailed")
        .withArgs(expectedErrorCode);
    });

    it("should revert when swap fails", async () => {
      const borrowedAmountToFlashLoan = parseEther("10");
      const borrowedAmountSeed = parseEther("0");

      const swapData = await createEmptySwapMulticallData(admin, ethers.utils.formatBytes32String("4"));
      await expect(
        leverageManager.connect(alice).enterLeveragedPositionWithBorrowed(
          collateralMarket.address,
          borrowMarket.address,
          borrowedAmountSeed,
          borrowedAmountToFlashLoan,
          0, // minAmountCollateralAfterSwap
          swapData,
        ),
      ).to.be.revertedWithCustomError(leverageManager, "TokenSwapCallFailed");
    });

    it("should revert when aftrer swap, received less collateral than minAmountCollateralAfterSwap", async () => {
      const borrowedAmountToFlashLoan = parseEther("1");
      const borrowedAmountSeed = parseEther("0");
      const minAmountCollateralAfterSwap = parseEther("2");

      const swapData = await createSwapMulticallData(
        collateral,
        leverageManager.address,
        parseEther("1"),
        admin,
        ethers.utils.formatBytes32String("5"),
      );

      await expect(
        leverageManager
          .connect(alice)
          .enterLeveragedPositionWithBorrowed(
            collateralMarket.address,
            borrowMarket.address,
            borrowedAmountSeed,
            borrowedAmountToFlashLoan,
            minAmountCollateralAfterSwap,
            swapData,
          ),
      ).to.be.revertedWithCustomError(leverageManager, "InsufficientAmountOutAfterSwap");
    });

    it("should fail when user did not approve enough borrowed tokens for transfer", async () => {
      const borrowedAmountToFlashLoan = parseEther("1");
      const borrowedAmountSeed = parseEther("10");
      const swapData = await createEmptySwapMulticallData(admin, ethers.utils.formatBytes32String("3"));

      await borrow.connect(alice).approve(leverageManager.address, parseEther("1"));

      await expect(
        leverageManager.connect(alice).enterLeveragedPositionWithBorrowed(
          collateralMarket.address,
          borrowMarket.address,
          borrowedAmountSeed,
          borrowedAmountToFlashLoan,
          0, // minAmountCollateralAfterSwap
          swapData,
        ),
      ).to.be.rejectedWith("ERC20: insufficient allowance");

      await borrow.connect(alice).approve(leverageManager.address, borrowedAmountSeed);

      await await expect(
        leverageManager.connect(alice).enterLeveragedPositionWithBorrowed(
          collateralMarket.address,
          borrowMarket.address,
          borrowedAmountSeed,
          borrowedAmountToFlashLoan,
          0, // minAmountCollateralAfterSwap
          swapData,
        ),
      ).to.be.rejectedWith("ERC20: transfer amount exceeds balance");
    });

    it("should enter leveraged position with borrowed successfully", async () => {
      const borrowedAmountToFlashLoan = parseEther("1");
      const borrowedAmountSeed = parseEther("0");

      const swapData = await createSwapMulticallData(
        collateral,
        leverageManager.address,
        parseEther("1"),
        admin,
        ethers.utils.formatBytes32String("6"),
      );

      const aliceCollateralBalanceBefore = await collateralMarket.callStatic.balanceOfUnderlying(aliceAddress);
      const enterLeveragedPositionWithBorrowedTx = await leverageManager
        .connect(alice)
        .enterLeveragedPositionWithBorrowed(
          collateralMarket.address,
          borrowMarket.address,
          borrowedAmountSeed,
          borrowedAmountToFlashLoan,
          parseEther("1"), // minAmountCollateralAfterSwap
          swapData,
        );

      const aliceCollateralBalanceAfter = await collateralMarket.callStatic.balanceOfUnderlying(aliceAddress);
      expect(aliceCollateralBalanceAfter).to.be.gt(aliceCollateralBalanceBefore);

      expect(await borrowMarket.callStatic.borrowBalanceCurrent(aliceAddress)).to.be.gt(0);

      // Check if event was emitted
      await expect(enterLeveragedPositionWithBorrowedTx)
        .to.emit(leverageManager, "LeveragedPositionEnteredWithBorrowed")
        .withArgs(
          aliceAddress,
          collateralMarket.address,
          borrowMarket.address,
          borrowedAmountSeed,
          borrowedAmountToFlashLoan,
        );
    });

    it.skip("should revert when account is not safe after entering leveraged position", async () => {});
  });

  describe("exitLeveragedPosition", () => {
    it("should revert when collateral market is not listed", async () => {
      const repayAmount = parseEther("1");
      const collateralAmountToRedeemForSwap = parseEther("0");
      const swapData = await createEmptySwapMulticallData(admin, ethers.utils.formatBytes32String("3"));

      await expect(
        leverageManager.connect(alice).exitLeveragedPosition(
          unlistedMarket.address,
          collateralAmountToRedeemForSwap,
          borrowMarket.address,
          repayAmount,
          0, // minAmountBorrowedRepayAfterSwap
          swapData,
        ),
      )
        .to.be.revertedWithCustomError(leverageManager, "MarketNotListed")
        .withArgs(unlistedMarket.address);
    });

    it("should revert when borrow market is not listed", async () => {
      const repayAmount = parseEther("1");
      const collateralAmountToRedeemForSwap = parseEther("0");
      const swapData = await createEmptySwapMulticallData(admin, ethers.utils.formatBytes32String("3"));

      await expect(
        leverageManager.connect(alice).exitLeveragedPosition(
          collateralMarket.address,
          collateralAmountToRedeemForSwap,
          unlistedMarket.address,
          repayAmount,
          0, // minAmountBorrowedRepayAfterSwap
          swapData,
        ),
      )
        .to.be.revertedWithCustomError(leverageManager, "MarketNotListed")
        .withArgs(unlistedMarket.address);
    });

    it("should revert when user has not set delegation", async () => {
      const repayAmount = parseEther("1");
      const collateralAmountToRedeemForSwap = parseEther("0");
      const swapData = await createEmptySwapMulticallData(admin, ethers.utils.formatBytes32String("3"));

      await comptroller.connect(alice).updateDelegate(leverageManager.address, false);
      await expect(
        leverageManager.connect(alice).exitLeveragedPosition(
          collateralMarket.address,
          collateralAmountToRedeemForSwap,
          borrowMarket.address,
          repayAmount,
          0, // minAmountBorrowedRepayAfterSwap
          swapData,
        ),
      ).to.be.revertedWithCustomError(comptroller, "NotAnApprovedDelegate");
    });

    it.skip("should revert when swap fails", async () => {
      const repayAmount = parseEther("10");
      const collateralAmountToRedeemForSwap = parseEther("1");

      const swapData = await createEmptySwapMulticallData(admin, ethers.utils.formatBytes32String("4"));

      await expect(
        leverageManager.connect(alice).exitLeveragedPosition(
          collateralMarket.address,
          collateralAmountToRedeemForSwap,
          borrowMarket.address,
          repayAmount,
          0, // minAmountBorrowedRepayAfterSwap
          swapData,
        ),
      ).to.be.revertedWithCustomError(leverageManager, "TokenSwapCallFailed");
    });

    it.skip("should revert when after swap is received less borrowed than minAmountBorrowedRepayAfterSwap", async () => {
      const repayAmount = parseEther("1");
      const collateralAmountToRedeemForSwap = parseEther("1");
      const minAmountBorrowedRepayAfterSwap = parseEther("2");

      const swapData = await createSwapMulticallData(
        borrow,
        leverageManager.address,
        parseEther("1"),
        admin,
        ethers.utils.formatBytes32String("5"),
      );

      await expect(
        leverageManager
          .connect(alice)
          .exitLeveragedPosition(
            collateralMarket.address,
            collateralAmountToRedeemForSwap,
            borrowMarket.address,
            repayAmount,
            minAmountBorrowedRepayAfterSwap,
            swapData,
          ),
      ).to.be.revertedWithCustomError(leverageManager, "InsufficientAmountOutAfterSwap");
    });

    it.skip("should transfer any leftover dust collateral to treasury", async () => {});

    it.skip("should transfer any leftover dust borrowed to treasury", async () => {});

    it.skip("should revert when account is not safe after exiting leveraged position", async () => {});

    it.skip("should exit leveraged position successfully", async () => {});
  });

  describe("executeOperation", () => {
    it("should revert when caller is not comptroller", async () => {
      const vTokens = [borrowMarket.address];
      const amounts = [parseEther("1")];
      const premiums = [parseEther("0.01")];
      const initiator = await alice.getAddress(); // Wrong initiator (should be leverageStrategiesManager)
      const onBehalf = await alice.getAddress();
      const param = "0x";

      await network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [comptroller.address],
      });
      const comptrollerSigner = await ethers.getSigner(comptroller.address);

      await expect(
        leverageManager
          .connect(comptrollerSigner)
          .executeOperation(vTokens, amounts, premiums, initiator, onBehalf, param),
      ).to.be.revertedWithCustomError(leverageManager, "InitiatorMismatch");
    });

    it("should revert when onBehalf is different than operation initiator", async () => {
      const vTokens = [borrowMarket.address];
      const amounts = [parseEther("1")];
      const premiums = [parseEther("0.01")];
      const initiator = leverageManager.address;
      const onBehalf = await alice.getAddress();
      const param = "0x";

      await network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [comptroller.address],
      });
      const comptrollerSigner = await ethers.getSigner(comptroller.address);

      await expect(
        leverageManager
          .connect(comptrollerSigner)
          .executeOperation(vTokens, amounts, premiums, initiator, onBehalf, param),
      ).to.be.revertedWithCustomError(leverageManager, "OnBehalfMismatch");
    });

    it("should revert when caller is not comptroller", async () => {
      const vTokens = [borrowMarket.address];
      const amounts = [parseEther("1")];
      const premiums = [parseEther("0.01")];
      const initiator = leverageManager.address;
      const onBehalf = ethers.constants.AddressZero; // since onBehalf is transient storage it was not initialized yet so it if a zero address
      const param = "0x";

      await expect(
        leverageManager.connect(alice).executeOperation(vTokens, amounts, premiums, initiator, onBehalf, param),
      ).to.be.revertedWithCustomError(leverageManager, "UnauthorizedExecutor");
    });

    it("should revert when vTokens, amounts and premiums length is not 1", async () => {
      const vTokens = [borrowMarket.address, borrowMarket.address];
      const amounts = [parseEther("1")];
      const premiums = [parseEther("0.01")];
      const initiator = leverageManager.address;
      const onBehalf = ethers.constants.AddressZero; // since onBehalf is transient storage it was not initialized yet so it if a zero address
      const param = "0x";

      await network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [comptroller.address],
      });
      const comptrollerSigner = await ethers.getSigner(comptroller.address);
      await expect(
        leverageManager
          .connect(comptrollerSigner)
          .executeOperation(vTokens, amounts, premiums, initiator, onBehalf, param),
      ).to.be.revertedWithCustomError(leverageManager, "FlashLoanAssetOrAmountMismatch");
    });

    it("should revert when called not as a callback of a flash loan", async () => {
      const vTokens = [borrowMarket.address];
      const amounts = [parseEther("1")];
      const premiums = [parseEther("0.01")];
      const initiator = leverageManager.address;
      const onBehalf = ethers.constants.AddressZero; // since onBehalf is transient storage it was not initialized yet so it if a zero address
      const param = "0x";

      await network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [comptroller.address],
      });
      const comptrollerSigner = await ethers.getSigner(comptroller.address);

      await expect(
        leverageManager
          .connect(comptrollerSigner)
          .executeOperation(vTokens, amounts, premiums, initiator, onBehalf, param),
      ).to.be.revertedWithCustomError(leverageManager, "InvalidExecuteOperation");
    });
  });
});
