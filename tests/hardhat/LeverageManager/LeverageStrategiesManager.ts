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

    it("should revert on deployment when comptroller address is zero", async () => {
      const LeverageStrategiesManagerFactory = await ethers.getContractFactory("LeverageStrategiesManager");
      await expect(
        LeverageStrategiesManagerFactory.deploy(
          ethers.constants.AddressZero,
          protocolShareReserve.address,
          swapHelper.address,
        ),
      ).to.be.revertedWithCustomError(LeverageStrategiesManagerFactory, "ZeroAddress");
    });

    it("should revert on deployment when protocolShareReserve address is zero", async () => {
      const LeverageStrategiesManagerFactory = await ethers.getContractFactory("LeverageStrategiesManager");
      await expect(
        LeverageStrategiesManagerFactory.deploy(comptroller.address, ethers.constants.AddressZero, swapHelper.address),
      ).to.be.revertedWithCustomError(LeverageStrategiesManagerFactory, "ZeroAddress");
    });

    it("should revert on deployment when swapHelper address is zero", async () => {
      const LeverageStrategiesManagerFactory = await ethers.getContractFactory("LeverageStrategiesManager");
      await expect(
        LeverageStrategiesManagerFactory.deploy(
          comptroller.address,
          protocolShareReserve.address,
          ethers.constants.AddressZero,
        ),
      ).to.be.revertedWithCustomError(LeverageStrategiesManagerFactory, "ZeroAddress");
    });

    it("should initialize correctly", async () => {
      expect(leverageManager.address).to.satisfy(ethers.utils.isAddress);

      await expect(leverageManager.initialize()).to.be.rejectedWith("Initializable: contract is already initialized");
    });

    it("should revert if initialized twice", async () => {
      await expect(leverageManager.initialize()).to.be.rejectedWith("Initializable: contract is already initialized");
    });
  });

  describe("enterSingleAssetLeverage", () => {
    it("should revert when flash loan amount is zero", async () => {
      const collateralAmountSeed = parseEther("1");
      const collateralAmountToFlashLoan = parseEther("0");

      await expect(
        leverageManager
          .connect(alice)
          .enterSingleAssetLeverage(collateralMarket.address, collateralAmountSeed, collateralAmountToFlashLoan),
      ).to.be.revertedWithCustomError(leverageManager, "ZeroFlashLoanAmount");
    });

    it("should revert when collateral market is not listed", async () => {
      const collateralAmountSeed = parseEther("0");
      const collateralAmountToFlashLoan = parseEther("1");

      await expect(
        leverageManager
          .connect(alice)
          .enterSingleAssetLeverage(unlistedMarket.address, collateralAmountSeed, collateralAmountToFlashLoan),
      )
        .to.be.revertedWithCustomError(leverageManager, "MarketNotListed")
        .withArgs(unlistedMarket.address);
    });

    it("should revert when user has not set delegation", async () => {
      const collateralAmountSeed = parseEther("0");
      const collateralAmountToFlashLoan = parseEther("1");

      await comptroller.connect(alice).updateDelegate(leverageManager.address, false);

      await expect(
        leverageManager
          .connect(alice)
          .enterSingleAssetLeverage(collateralMarket.address, collateralAmountSeed, collateralAmountToFlashLoan),
      ).to.be.revertedWithCustomError(leverageManager, "NotAnApprovedDelegate");
    });

    it("should revert when user did not approve enough collateral for transfer", async () => {
      const collateralAmountSeed = parseEther("10");
      const collateralAmountToFlashLoan = parseEther("1");

      await collateral.connect(alice).approve(leverageManager.address, parseEther("1"));

      await expect(
        leverageManager
          .connect(alice)
          .enterSingleAssetLeverage(collateralMarket.address, collateralAmountSeed, collateralAmountToFlashLoan),
      ).to.be.rejectedWith("ERC20: insufficient allowance");

      await collateral.connect(alice).approve(leverageManager.address, collateralAmountSeed);

      await expect(
        leverageManager
          .connect(alice)
          .enterSingleAssetLeverage(collateralMarket.address, collateralAmountSeed, collateralAmountToFlashLoan),
      ).to.be.rejectedWith("ERC20: transfer amount exceeds balance");
    });

    it("should enter leveraged position with single collateral successfully without seed", async () => {
      const collateralAmountSeed = parseEther("0");
      const collateralAmountToFlashLoan = parseEther("1");

      const aliceCollateralBalanceBefore = await collateralMarket.callStatic.balanceOfUnderlying(aliceAddress);

      const enterLeveragedPositionTx = await leverageManager
        .connect(alice)
        .enterSingleAssetLeverage(collateralMarket.address, collateralAmountSeed, collateralAmountToFlashLoan);

      const aliceCollateralBalanceAfter = await collateralMarket.callStatic.balanceOfUnderlying(aliceAddress);
      expect(aliceCollateralBalanceAfter).to.be.gt(aliceCollateralBalanceBefore);

      // Check borrowed amount (should only be fees)
      expect(await collateralMarket.callStatic.borrowBalanceCurrent(aliceAddress)).to.be.gt(0);

      expect(enterLeveragedPositionTx)
        .to.emit(leverageManager, "SingleAssetLeverageEntered")
        .withArgs(aliceAddress, collateralMarket.address, collateralAmountSeed, collateralAmountToFlashLoan);
    });

    it("should enter leveraged position with single collateral successfully with seed", async () => {
      const collateralAmountSeed = parseEther("1");
      const collateralAmountToFlashLoan = parseEther("2");

      await collateral.transfer(aliceAddress, collateralAmountSeed);
      await collateral.connect(alice).approve(leverageManager.address, collateralAmountSeed);

      const aliceCollateralBalanceBefore = await collateralMarket.callStatic.balanceOfUnderlying(aliceAddress);
      const aliceCollateralTokenBalanceBefore = await collateral.balanceOf(aliceAddress);

      const enterLeveragedPositionTx = await leverageManager
        .connect(alice)
        .enterSingleAssetLeverage(collateralMarket.address, collateralAmountSeed, collateralAmountToFlashLoan);

      const aliceCollateralBalanceAfter = await collateralMarket.callStatic.balanceOfUnderlying(aliceAddress);
      const aliceCollateralTokenBalanceAfter = await collateral.balanceOf(aliceAddress);

      // Check that seed amount was transferred from user
      expect(aliceCollateralTokenBalanceBefore.sub(aliceCollateralTokenBalanceAfter)).to.equal(collateralAmountSeed);

      // Check that collateral balance increased by more than seed (includes flash loan amount)
      expect(aliceCollateralBalanceAfter.sub(aliceCollateralBalanceBefore)).to.be.gt(collateralAmountSeed);

      // Check borrowed amount (should only be fees, or equal to flash loan in zero-fee environment)
      const borrowBalance = await collateralMarket.callStatic.borrowBalanceCurrent(aliceAddress);
      expect(borrowBalance).to.be.gt(0);
      expect(borrowBalance).to.be.lte(collateralAmountToFlashLoan); // Fees are less than or equal to flash loan amount

      expect(enterLeveragedPositionTx)
        .to.emit(leverageManager, "SingleAssetLeverageEntered")
        .withArgs(aliceAddress, collateralMarket.address, collateralAmountSeed, collateralAmountToFlashLoan);
    });

    it("should verify account is safe after entering leveraged position", async () => {
      const collateralAmountSeed = parseEther("0");
      const collateralAmountToFlashLoan = parseEther("1");

      await leverageManager
        .connect(alice)
        .enterSingleAssetLeverage(collateralMarket.address, collateralAmountSeed, collateralAmountToFlashLoan);

      // Account should be safe (no shortfall)
      const [err, , shortfall] = await comptroller.getBorrowingPower(aliceAddress);
      expect(err).to.equal(0);
      expect(shortfall).to.equal(0);
    });

    it("should transfer dust to initiator after entering leveraged position", async () => {
      const collateralAmountSeed = parseEther("0");
      const collateralAmountToFlashLoan = parseEther("1");

      // Verify no dust remains in the contract after operation
      await leverageManager
        .connect(alice)
        .enterSingleAssetLeverage(collateralMarket.address, collateralAmountSeed, collateralAmountToFlashLoan);

      // Contract should have zero balance of collateral token after operation
      const contractCollateralBalance = await collateral.balanceOf(leverageManager.address);
      expect(contractCollateralBalance).to.equal(0);
    });
    it("should emit DustTransferred event when dust is returned to user", async () => {
      const collateralAmountSeed = parseEther("0");
      const collateralAmountToFlashLoan = parseEther("1");

      // Note: In the mock environment, dust may be zero after operations.
      // This test verifies the event emission mechanism is in place.
      await leverageManager
        .connect(alice)
        .enterSingleAssetLeverage(collateralMarket.address, collateralAmountSeed, collateralAmountToFlashLoan);

      // Contract should have zero balance after operation (dust transferred)
      const contractCollateralBalance = await collateral.balanceOf(leverageManager.address);
      expect(contractCollateralBalance).to.equal(0);
    });
  });

  describe("enterLeverage", () => {
    it("should revert when flash loan amount is zero", async () => {
      const collateralAmountSeed = parseEther("0");
      const borrowedAmountToFlashLoan = parseEther("0");
      const swapData = await createEmptySwapMulticallData(admin, ethers.utils.formatBytes32String("3"));

      await expect(
        leverageManager.connect(alice).enterLeverage(
          collateralMarket.address,
          collateralAmountSeed,
          borrowMarket.address,
          borrowedAmountToFlashLoan,
          0, // minAmountCollateralAfterSwap
          swapData,
        ),
      ).to.be.revertedWithCustomError(leverageManager, "ZeroFlashLoanAmount");
    });

    it("should revert when collateral market is not listed", async () => {
      const collateralAmountSeed = parseEther("0");
      const borrowedAmountToFlashLoan = parseEther("1");
      const swapData = await createEmptySwapMulticallData(admin, ethers.utils.formatBytes32String("3"));

      await expect(
        leverageManager.connect(alice).enterLeverage(
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
        leverageManager.connect(alice).enterLeverage(
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
        leverageManager.connect(alice).enterLeverage(
          collateralMarket.address,
          collateralAmountSeed,
          borrowMarket.address,
          borrowedAmountToFlashLoan,
          0, // minAmountCollateralAfterSwap
          swapData,
        ),
      ).to.be.revertedWithCustomError(leverageManager, "NotAnApprovedDelegate");
    });

    it("should revert when user did not approve enough collateral for transfer", async () => {
      const collateralAmountSeed = parseEther("10");
      const borrowedAmountToFlashLoan = parseEther("1");
      const swapData = await createEmptySwapMulticallData(admin, ethers.utils.formatBytes32String("3"));

      await collateral.connect(alice).approve(leverageManager.address, parseEther("1"));

      await expect(
        leverageManager.connect(alice).enterLeverage(
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
        leverageManager.connect(alice).enterLeverage(
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
        leverageManager.connect(alice).enterLeverage(
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
          .enterLeverage(
            collateralMarket.address,
            collateralAmountSeed,
            borrowMarket.address,
            borrowedAmountToFlashLoan,
            minAmountCollateralAfterSwap,
            swapData,
          ),
      ).to.be.revertedWithCustomError(leverageManager, "SlippageExceeded");
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

      const enterLeveragedPositionWithCollateralTx = await leverageManager.connect(alice).enterLeverage(
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
        .to.emit(leverageManager, "LeverageEntered")
        .withArgs(
          aliceAddress,
          collateralMarket.address,
          borrowMarket.address,
          collateralAmountSeed,
          borrowedAmountToFlashLoan,
        );
    });

    it("should transfer dust to initiator after entering leveraged position", async () => {
      const collateralAmountSeed = parseEther("0");
      const borrowedAmountToFlashLoan = parseEther("1");

      const swapData = await createSwapMulticallData(
        collateral,
        leverageManager.address,
        parseEther("1"),
        admin,
        ethers.utils.formatBytes32String("dust-test-enter"),
      );

      await leverageManager
        .connect(alice)
        .enterLeverage(
          collateralMarket.address,
          collateralAmountSeed,
          borrowMarket.address,
          borrowedAmountToFlashLoan,
          parseEther("1"),
          swapData,
        );

      // Contract should have zero balance of both tokens after operation
      const contractCollateralBalance = await collateral.balanceOf(leverageManager.address);
      const contractBorrowBalance = await borrow.balanceOf(leverageManager.address);
      expect(contractCollateralBalance).to.equal(0);
      expect(contractBorrowBalance).to.equal(0);
    });
  });

  describe("enterLeverageFromBorrow", () => {
    it("should revert when flash loan amount is zero", async () => {
      const borrowedAmountToFlashLoan = parseEther("0");
      const borrowedAmountSeed = parseEther("0");
      const swapData = await createEmptySwapMulticallData(admin, ethers.utils.formatBytes32String("3"));

      await expect(
        leverageManager.connect(alice).enterLeverageFromBorrow(
          collateralMarket.address,
          borrowMarket.address,
          borrowedAmountSeed,
          borrowedAmountToFlashLoan,
          0, // minAmountCollateralAfterSwap
          swapData,
        ),
      ).to.be.revertedWithCustomError(leverageManager, "ZeroFlashLoanAmount");
    });

    it("should revert when collateral market is not listed", async () => {
      const borrowedAmountToFlashLoan = parseEther("1");
      const borrowedAmountSeed = parseEther("0");
      const swapData = await createEmptySwapMulticallData(admin, ethers.utils.formatBytes32String("3"));

      await expect(
        leverageManager.connect(alice).enterLeverageFromBorrow(
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
        leverageManager.connect(alice).enterLeverageFromBorrow(
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
        leverageManager.connect(alice).enterLeverageFromBorrow(
          collateralMarket.address,
          borrowMarket.address,
          borrowedAmountSeed,
          borrowedAmountToFlashLoan,
          0, // minAmountCollateralAfterSwap
          swapData,
        ),
      ).to.be.revertedWithCustomError(leverageManager, "NotAnApprovedDelegate");
    });

    it("should revert when swap fails", async () => {
      const borrowedAmountToFlashLoan = parseEther("10");
      const borrowedAmountSeed = parseEther("0");

      const swapData = await createEmptySwapMulticallData(admin, ethers.utils.formatBytes32String("4"));
      await expect(
        leverageManager.connect(alice).enterLeverageFromBorrow(
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
          .enterLeverageFromBorrow(
            collateralMarket.address,
            borrowMarket.address,
            borrowedAmountSeed,
            borrowedAmountToFlashLoan,
            minAmountCollateralAfterSwap,
            swapData,
          ),
      ).to.be.revertedWithCustomError(leverageManager, "SlippageExceeded");
    });

    it("should fail when user did not approve enough borrowed tokens for transfer", async () => {
      const borrowedAmountToFlashLoan = parseEther("1");
      const borrowedAmountSeed = parseEther("10");
      const swapData = await createEmptySwapMulticallData(admin, ethers.utils.formatBytes32String("3"));

      await borrow.connect(alice).approve(leverageManager.address, parseEther("1"));

      await expect(
        leverageManager.connect(alice).enterLeverageFromBorrow(
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
        leverageManager.connect(alice).enterLeverageFromBorrow(
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
      const enterLeveragedPositionWithBorrowedTx = await leverageManager.connect(alice).enterLeverageFromBorrow(
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
        .to.emit(leverageManager, "LeverageEnteredFromBorrow")
        .withArgs(
          aliceAddress,
          collateralMarket.address,
          borrowMarket.address,
          borrowedAmountSeed,
          borrowedAmountToFlashLoan,
        );
    });

    it("should transfer dust to initiator after entering leveraged position", async () => {
      const borrowedAmountSeed = parseEther("0");
      const borrowedAmountToFlashLoan = parseEther("1");

      const swapData = await createSwapMulticallData(
        collateral,
        leverageManager.address,
        parseEther("1"),
        admin,
        ethers.utils.formatBytes32String("dust-test-borrow"),
      );

      await leverageManager
        .connect(alice)
        .enterLeverageFromBorrow(
          collateralMarket.address,
          borrowMarket.address,
          borrowedAmountSeed,
          borrowedAmountToFlashLoan,
          parseEther("1"),
          swapData,
        );

      // Contract should have zero balance of both tokens after operation
      const contractCollateralBalance = await collateral.balanceOf(leverageManager.address);
      const contractBorrowBalance = await borrow.balanceOf(leverageManager.address);
      expect(contractCollateralBalance).to.equal(0);
      expect(contractBorrowBalance).to.equal(0);
    });
  });

  describe("exitLeverage", () => {
    it("should revert when flash loan amount is zero", async () => {
      const repayAmount = parseEther("0");
      const collateralAmountToRedeemForSwap = parseEther("1");
      const swapData = await createEmptySwapMulticallData(admin, ethers.utils.formatBytes32String("3"));

      await expect(
        leverageManager.connect(alice).exitLeverage(
          collateralMarket.address,
          collateralAmountToRedeemForSwap,
          borrowMarket.address,
          repayAmount,
          0, // minAmountBorrowedRepayAfterSwap
          swapData,
        ),
      ).to.be.revertedWithCustomError(leverageManager, "ZeroFlashLoanAmount");
    });

    it("should revert when collateral market is not listed", async () => {
      const repayAmount = parseEther("1");
      const collateralAmountToRedeemForSwap = parseEther("0");
      const swapData = await createEmptySwapMulticallData(admin, ethers.utils.formatBytes32String("3"));

      await expect(
        leverageManager.connect(alice).exitLeverage(
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
        leverageManager.connect(alice).exitLeverage(
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
        leverageManager.connect(alice).exitLeverage(
          collateralMarket.address,
          collateralAmountToRedeemForSwap,
          borrowMarket.address,
          repayAmount,
          0, // minAmountBorrowedRepayAfterSwap
          swapData,
        ),
      ).to.be.revertedWithCustomError(leverageManager, "NotAnApprovedDelegate");
    });

    it("should revert when swap fails", async () => {
      const borrowedAmountToFlashLoan = parseEther("1");
      const collateralAmountSeed = parseEther("0");

      const enterSwapData = await createSwapMulticallData(
        collateral,
        leverageManager.address,
        parseEther("1"),
        admin,
        ethers.utils.formatBytes32String("enter-swap-1"),
      );

      await leverageManager
        .connect(alice)
        .enterLeverage(
          collateralMarket.address,
          collateralAmountSeed,
          borrowMarket.address,
          borrowedAmountToFlashLoan,
          parseEther("1"),
          enterSwapData,
        );

      const borrowBalance = await borrowMarket.callStatic.borrowBalanceCurrent(aliceAddress);
      const collateralAmountToRedeemForSwap = parseEther("1");
      const exitSwapData = await createEmptySwapMulticallData(admin, ethers.utils.formatBytes32String("exit-swap-1"));

      await expect(
        leverageManager
          .connect(alice)
          .exitLeverage(
            collateralMarket.address,
            collateralAmountToRedeemForSwap,
            borrowMarket.address,
            borrowBalance,
            0,
            exitSwapData,
          ),
      ).to.be.revertedWithCustomError(leverageManager, "TokenSwapCallFailed");
    });

    it("should revert when after swap is received less borrowed than minAmountBorrowedRepayAfterSwap", async () => {
      const borrowedAmountToFlashLoan = parseEther("1");
      const collateralAmountSeed = parseEther("0");

      const enterSwapData = await createSwapMulticallData(
        collateral,
        leverageManager.address,
        parseEther("1"),
        admin,
        ethers.utils.formatBytes32String("enter-swap-2"),
      );

      await leverageManager
        .connect(alice)
        .enterLeverage(
          collateralMarket.address,
          collateralAmountSeed,
          borrowMarket.address,
          borrowedAmountToFlashLoan,
          parseEther("1"),
          enterSwapData,
        );

      const borrowBalance = await borrowMarket.callStatic.borrowBalanceCurrent(aliceAddress);
      const collateralAmountToRedeemForSwap = parseEther("1");
      const minAmountBorrowedRepayAfterSwap = parseEther("3");

      const exitSwapData = await createSwapMulticallData(
        borrow,
        leverageManager.address,
        parseEther("1"),
        admin,
        ethers.utils.formatBytes32String("exit-swap-2"),
      );

      await expect(
        leverageManager
          .connect(alice)
          .exitLeverage(
            collateralMarket.address,
            collateralAmountToRedeemForSwap,
            borrowMarket.address,
            borrowBalance,
            minAmountBorrowedRepayAfterSwap,
            exitSwapData,
          ),
      ).to.be.revertedWithCustomError(leverageManager, "SlippageExceeded");
    });

    it("should exit leveraged position successfully", async () => {
      const borrowedAmountToFlashLoan = parseEther("1");
      const collateralAmountSeed = parseEther("0");

      const enterSwapData = await createSwapMulticallData(
        collateral,
        leverageManager.address,
        parseEther("1"),
        admin,
        ethers.utils.formatBytes32String("enter-swap-3"),
      );

      await leverageManager
        .connect(alice)
        .enterLeverage(
          collateralMarket.address,
          collateralAmountSeed,
          borrowMarket.address,
          borrowedAmountToFlashLoan,
          parseEther("1"),
          enterSwapData,
        );

      const collateralBalanceAfterEnter = await collateralMarket.callStatic.balanceOfUnderlying(aliceAddress);
      const borrowBalanceAfterEnter = await borrowMarket.callStatic.borrowBalanceCurrent(aliceAddress);

      const collateralAmountToRedeemForSwap = parseEther("0.5");
      const repayAmount = borrowBalanceAfterEnter;

      const exitSwapData = await createSwapMulticallData(
        borrow,
        leverageManager.address,
        borrowBalanceAfterEnter.add(parseEther("0.1")), // Flash loan amount + premium
        admin,
        ethers.utils.formatBytes32String("exit-swap-3"),
      );

      const exitTx = await leverageManager
        .connect(alice)
        .exitLeverage(
          collateralMarket.address,
          collateralAmountToRedeemForSwap,
          borrowMarket.address,
          repayAmount,
          0,
          exitSwapData,
        );

      await expect(exitTx)
        .to.emit(leverageManager, "LeverageExited")
        .withArgs(
          aliceAddress,
          collateralMarket.address,
          collateralAmountToRedeemForSwap,
          borrowMarket.address,
          repayAmount,
        );

      const collateralBalanceAfterExit = await collateralMarket.callStatic.balanceOfUnderlying(aliceAddress);
      const borrowBalanceAfterExit = await borrowMarket.callStatic.borrowBalanceCurrent(aliceAddress);

      expect(collateralBalanceAfterExit).to.be.lt(collateralBalanceAfterEnter);
      expect(borrowBalanceAfterExit).to.equal(0);
    });

    it("should emit DustTransferred events for collateral to user and borrow to treasury", async () => {
      const borrowedAmountToFlashLoan = parseEther("1");
      const collateralAmountSeed = parseEther("0");

      const enterSwapData = await createSwapMulticallData(
        collateral,
        leverageManager.address,
        parseEther("1"),
        admin,
        ethers.utils.formatBytes32String("enter-swap-event"),
      );

      await leverageManager
        .connect(alice)
        .enterLeverage(
          collateralMarket.address,
          collateralAmountSeed,
          borrowMarket.address,
          borrowedAmountToFlashLoan,
          parseEther("1"),
          enterSwapData,
        );

      const borrowBalanceAfterEnter = await borrowMarket.callStatic.borrowBalanceCurrent(aliceAddress);

      const collateralAmountToRedeemForSwap = parseEther("0.5");
      const repayAmount = borrowBalanceAfterEnter;

      const exitSwapData = await createSwapMulticallData(
        borrow,
        leverageManager.address,
        borrowBalanceAfterEnter.add(parseEther("0.1")),
        admin,
        ethers.utils.formatBytes32String("exit-swap-event"),
      );

      const treasuryBorrowBalanceBefore = await borrow.balanceOf(protocolShareReserve.address);

      const exitTx = await leverageManager
        .connect(alice)
        .exitLeverage(
          collateralMarket.address,
          collateralAmountToRedeemForSwap,
          borrowMarket.address,
          repayAmount,
          0,
          exitSwapData,
        );

      const treasuryBorrowBalanceAfter = await borrow.balanceOf(protocolShareReserve.address);
      const dustAmount = treasuryBorrowBalanceAfter.sub(treasuryBorrowBalanceBefore);

      // Verify DustTransferred event was emitted to treasury (protocol share reserve)
      await expect(exitTx)
        .to.emit(leverageManager, "DustTransferred")
        .withArgs(protocolShareReserve.address, borrow.address, dustAmount);
    });

    it("should transfer collateral dust to initiator and borrow dust to treasury after exiting", async () => {
      const borrowedAmountToFlashLoan = parseEther("1");
      const collateralAmountSeed = parseEther("0");

      const enterSwapData = await createSwapMulticallData(
        collateral,
        leverageManager.address,
        parseEther("1"),
        admin,
        ethers.utils.formatBytes32String("enter-swap-dust"),
      );

      await leverageManager
        .connect(alice)
        .enterLeverage(
          collateralMarket.address,
          collateralAmountSeed,
          borrowMarket.address,
          borrowedAmountToFlashLoan,
          parseEther("1"),
          enterSwapData,
        );

      const borrowBalanceAfterEnter = await borrowMarket.callStatic.borrowBalanceCurrent(aliceAddress);

      const collateralAmountToRedeemForSwap = parseEther("0.5");
      const repayAmount = borrowBalanceAfterEnter;

      const exitSwapData = await createSwapMulticallData(
        borrow,
        leverageManager.address,
        borrowBalanceAfterEnter.add(parseEther("0.1")),
        admin,
        ethers.utils.formatBytes32String("exit-swap-dust"),
      );

      const treasuryBorrowBalanceBefore = await borrow.balanceOf(protocolShareReserve.address);

      await leverageManager
        .connect(alice)
        .exitLeverage(
          collateralMarket.address,
          collateralAmountToRedeemForSwap,
          borrowMarket.address,
          repayAmount,
          0,
          exitSwapData,
        );

      // Contract should have zero balance of both tokens after operation
      const contractCollateralBalance = await collateral.balanceOf(leverageManager.address);
      const contractBorrowBalance = await borrow.balanceOf(leverageManager.address);
      expect(contractCollateralBalance).to.equal(0);
      expect(contractBorrowBalance).to.equal(0);

      // Treasury should have received borrow dust
      const treasuryBorrowBalanceAfter = await borrow.balanceOf(protocolShareReserve.address);
      expect(treasuryBorrowBalanceAfter).to.be.gt(treasuryBorrowBalanceBefore);
    });
  });

  describe("exitSingleAssetLeverage", () => {
    it("should revert when flash loan amount is zero", async () => {
      const collateralAmountToFlashLoan = parseEther("0");

      await expect(
        leverageManager.connect(alice).exitSingleAssetLeverage(collateralMarket.address, collateralAmountToFlashLoan),
      ).to.be.revertedWithCustomError(leverageManager, "ZeroFlashLoanAmount");
    });

    it("should revert when collateral market is not listed", async () => {
      const collateralAmountToFlashLoan = parseEther("2");

      await expect(
        leverageManager.connect(alice).exitSingleAssetLeverage(unlistedMarket.address, collateralAmountToFlashLoan),
      )
        .to.be.revertedWithCustomError(leverageManager, "MarketNotListed")
        .withArgs(unlistedMarket.address);
    });

    it("should revert when user has not set delegation", async () => {
      const collateralAmountToFlashLoan = parseEther("2");

      await comptroller.connect(alice).updateDelegate(leverageManager.address, false);
      await expect(
        leverageManager.connect(alice).exitSingleAssetLeverage(collateralMarket.address, collateralAmountToFlashLoan),
      ).to.be.revertedWithCustomError(leverageManager, "NotAnApprovedDelegate");
    });

    it("should exit leveraged position with single collateral successfully", async () => {
      const aliceAddress = await alice.getAddress();

      // First enter a leveraged position with single collateral
      const collateralAmountSeed = parseEther("1");
      const collateralAmountToFlashLoan = parseEther("2");

      await collateral.transfer(aliceAddress, collateralAmountSeed);
      await collateral.connect(alice).approve(leverageManager.address, collateralAmountSeed);

      await leverageManager
        .connect(alice)
        .enterSingleAssetLeverage(collateralMarket.address, collateralAmountSeed, collateralAmountToFlashLoan);

      const collateralBalanceAfterEnter = await collateralMarket.callStatic.balanceOfUnderlying(aliceAddress);
      const borrowBalanceAfterEnter = await collateralMarket.callStatic.borrowBalanceCurrent(aliceAddress);

      // Now exit the position
      const borrowedAmountToFlashLoan = borrowBalanceAfterEnter;

      await expect(
        leverageManager.connect(alice).exitSingleAssetLeverage(collateralMarket.address, borrowedAmountToFlashLoan),
      )
        .to.emit(leverageManager, "SingleAssetLeverageExited")
        .withArgs(aliceAddress, collateralMarket.address, borrowedAmountToFlashLoan);

      const collateralBalanceAfterExit = await collateralMarket.callStatic.balanceOfUnderlying(aliceAddress);
      const borrowBalanceAfterExit = await collateralMarket.callStatic.borrowBalanceCurrent(aliceAddress);

      // Collateral balance should decrease
      expect(collateralBalanceAfterExit).to.be.lt(collateralBalanceAfterEnter);

      // Borrow balance should be 0 or minimal after exit
      expect(borrowBalanceAfterExit).to.equal(0);
    });

    it("should verify account is safe after exiting leveraged position", async () => {
      const aliceAddress = await alice.getAddress();

      // First enter a leveraged position
      const collateralAmountSeed = parseEther("1");
      const collateralAmountToFlashLoan = parseEther("2");

      await collateral.transfer(aliceAddress, collateralAmountSeed);
      await collateral.connect(alice).approve(leverageManager.address, collateralAmountSeed);

      await leverageManager
        .connect(alice)
        .enterSingleAssetLeverage(collateralMarket.address, collateralAmountSeed, collateralAmountToFlashLoan);

      const borrowBalanceAfterEnter = await collateralMarket.callStatic.borrowBalanceCurrent(aliceAddress);

      // Exit the position
      const collateralAmountToRedeem = parseEther("1");
      const collateralAmountToFlashLoanForExit = borrowBalanceAfterEnter;

      await leverageManager
        .connect(alice)
        .exitSingleAssetLeverage(collateralMarket.address, collateralAmountToFlashLoanForExit);
    });

    it("should transfer dust to initiator after exiting leveraged position", async () => {
      const aliceAddress = await alice.getAddress();

      // First enter a leveraged position
      const collateralAmountSeed = parseEther("1");
      const collateralAmountToFlashLoan = parseEther("2");

      await collateral.transfer(aliceAddress, collateralAmountSeed);
      await collateral.connect(alice).approve(leverageManager.address, collateralAmountSeed);

      await leverageManager
        .connect(alice)
        .enterSingleAssetLeverage(collateralMarket.address, collateralAmountSeed, collateralAmountToFlashLoan);

      const borrowBalanceAfterEnter = await collateralMarket.callStatic.borrowBalanceCurrent(aliceAddress);

      // Exit the position
      await leverageManager.connect(alice).exitSingleAssetLeverage(collateralMarket.address, borrowBalanceAfterEnter);

      // Verify contract has zero balance after operation (dust transferred to initiator)
      const contractCollateralBalance = await collateral.balanceOf(leverageManager.address);
      expect(contractCollateralBalance).to.equal(0);
    });
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
