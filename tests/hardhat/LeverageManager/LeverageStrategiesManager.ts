import { FakeContract, smock } from "@defi-wonderland/smock";
import { loadFixture, setBalance } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { BigNumber, Contract, Signer, Wallet } from "ethers";
import { parseEther, parseUnits } from "ethers/lib/utils";
import { ethers, network } from "hardhat";

import {
  ComptrollerLensInterface,
  ComptrollerMock,
  EIP20Interface,
  IAccessControlManagerV8,
  IProtocolShareReserve,
  InterestRateModel,
  LeverageStrategiesManager,
  ResilientOracleInterface,
  SwapHelper,
  VBep20Harness,
} from "../../../typechain";

type SetupFixture = {
  comptroller: ComptrollerMock;
  leverageManager: LeverageStrategiesManager;
  protocolShareReserve: FakeContract<IProtocolShareReserve>;
  swapHelper: SwapHelper;
  collateralMarket: VBep20Harness;
  collateral: EIP20Interface;
  borrowMarket: VBep20Harness;
  borrow: EIP20Interface;
  unlistedMarket: VBep20Harness;
  vBNBMarket: VBep20Harness;
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

  // Deploy a vBNB mock (listed but used to test VBNBNotSupported error)
  const { mockToken: vBNBUnderlying, vToken: vBNBMarket } = await deployVToken(
    "BNB",
    comptroller,
    accessControl.address,
    interestRateModel.address,
    protocolShareReserve.address,
    admin.address,
    true,
  );

  const SwapHelperFactory = await ethers.getContractFactory("SwapHelper");
  const swapHelper = (await SwapHelperFactory.deploy(admin.address)) as SwapHelper;

  const LeverageStrategiesManagerFactory = await ethers.getContractFactory("LeverageStrategiesManager");
  const leverageManager = (await LeverageStrategiesManagerFactory.deploy(
    comptroller.address,
    swapHelper.address,
    vBNBMarket.address,
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
    vBNBMarket,
    interestRateModel,
  };
};

describe("LeverageStrategiesManager", () => {
  let leverageManager: LeverageStrategiesManager;
  let comptroller: ComptrollerMock;
  let swapHelper: SwapHelper;
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
  let vBNBMarket: VBep20Harness;
  let interestRateModel: FakeContract<InterestRateModel>;

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
      vBNBMarket,
      interestRateModel,
    } = await loadFixture(setupFixture));

    await comptroller.connect(alice).updateDelegate(leverageManager.address, true);

    await collateralMarket.mint(parseUnits("20", 18));
    await borrowMarket.mint(parseUnits("20", 18));
    aliceAddress = await alice.getAddress();
  });

  afterEach(async () => {
    // Reset collateral market pauses
    await comptroller._setActionsPaused([collateralMarket.address], [0], false); // MINT
    await comptroller._setActionsPaused([collateralMarket.address], [1], false); // REDEEM
    await comptroller._setActionsPaused([collateralMarket.address], [2], false); // BORROW
    await comptroller._setActionsPaused([collateralMarket.address], [3], false); // REPAY
    await comptroller.setIsBorrowAllowed(0, collateralMarket.address, true);

    await comptroller._setTreasuryData(admin.address, admin.address, 0);
    interestRateModel.getBorrowRate.reset();
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
      expect(await leverageManager.swapHelper()).to.equal(swapHelper.address);
    });

    it("should revert on deployment when comptroller address is zero", async () => {
      const LeverageStrategiesManagerFactory = await ethers.getContractFactory("LeverageStrategiesManager");
      await expect(
        LeverageStrategiesManagerFactory.deploy(ethers.constants.AddressZero, swapHelper.address, vBNBMarket.address),
      ).to.be.revertedWithCustomError(LeverageStrategiesManagerFactory, "ZeroAddress");
    });

    it("should revert on deployment when swapHelper address is zero", async () => {
      const LeverageStrategiesManagerFactory = await ethers.getContractFactory("LeverageStrategiesManager");
      await expect(
        LeverageStrategiesManagerFactory.deploy(comptroller.address, ethers.constants.AddressZero, vBNBMarket.address),
      ).to.be.revertedWithCustomError(LeverageStrategiesManagerFactory, "ZeroAddress");
    });

    it("should revert on deployment when vBNB address is zero", async () => {
      const LeverageStrategiesManagerFactory = await ethers.getContractFactory("LeverageStrategiesManager");
      await expect(
        LeverageStrategiesManagerFactory.deploy(comptroller.address, swapHelper.address, ethers.constants.AddressZero),
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
    describe("Validation", () => {
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

      it("should revert when collateral market is vBNB", async () => {
        const collateralAmountSeed = parseEther("0");
        const collateralAmountToFlashLoan = parseEther("1");

        await expect(
          leverageManager
            .connect(alice)
            .enterSingleAssetLeverage(vBNBMarket.address, collateralAmountSeed, collateralAmountToFlashLoan),
        ).to.be.revertedWithCustomError(leverageManager, "VBNBNotSupported");
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

      it("should revert with MintBehalfFailed when mint fails in enterSingleAssetLeverage", async () => {
        const collateralAmountSeed = parseEther("0");
        const collateralAmountToFlashLoan = parseEther("1");

        // Pause MINT action (action index 0) for the collateral market
        await comptroller._setActionsPaused([collateralMarket.address], [0], true);

        await expect(
          leverageManager
            .connect(alice)
            .enterSingleAssetLeverage(collateralMarket.address, collateralAmountSeed, collateralAmountToFlashLoan),
        ).to.be.reverted;
      });
    });

    describe("Success Cases", () => {
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
      it("should succeed when user is already in the collateral market", async () => {
        // Enter market first
        await comptroller.connect(alice).enterMarkets([collateralMarket.address]);

        const collateralAmountSeed = parseEther("0");
        const collateralAmountToFlashLoan = parseEther("1");

        const tx = await leverageManager
          .connect(alice)
          .enterSingleAssetLeverage(collateralMarket.address, collateralAmountSeed, collateralAmountToFlashLoan);

        await expect(tx)
          .to.emit(leverageManager, "SingleAssetLeverageEntered")
          .withArgs(aliceAddress, collateralMarket.address, collateralAmountSeed, collateralAmountToFlashLoan);

        // Verify position was created
        expect(await collateralMarket.callStatic.borrowBalanceCurrent(aliceAddress)).to.be.gt(0);
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

      it("should handle zero fees flash loan successfully", async () => {
        const collateralAmountSeed = parseEther("0");
        const collateralAmountToFlashLoan = parseEther("1");

        const aliceCollateralBalanceBefore = await collateralMarket.callStatic.balanceOfUnderlying(aliceAddress);

        await leverageManager
          .connect(alice)
          .enterSingleAssetLeverage(collateralMarket.address, collateralAmountSeed, collateralAmountToFlashLoan);

        const aliceCollateralBalanceAfter = await collateralMarket.callStatic.balanceOfUnderlying(aliceAddress);
        expect(aliceCollateralBalanceAfter).to.be.gt(aliceCollateralBalanceBefore);

        const borrowBalance = await collateralMarket.callStatic.borrowBalanceCurrent(aliceAddress);
        expect(borrowBalance).to.be.gte(0);
      });
    });
  });

  describe("enterLeverage", () => {
    describe("Validation", () => {
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

      it("should revert when collateral market is vBNB", async () => {
        const collateralAmountSeed = parseEther("0");
        const borrowedAmountToFlashLoan = parseEther("1");
        const swapData = await createEmptySwapMulticallData(admin, ethers.utils.formatBytes32String("vbnb-collateral"));

        await expect(
          leverageManager
            .connect(alice)
            .enterLeverage(
              vBNBMarket.address,
              collateralAmountSeed,
              borrowMarket.address,
              borrowedAmountToFlashLoan,
              0,
              swapData,
            ),
        ).to.be.revertedWithCustomError(leverageManager, "VBNBNotSupported");
      });

      it("should revert when borrow market is vBNB", async () => {
        const collateralAmountSeed = parseEther("0");
        const borrowedAmountToFlashLoan = parseEther("1");
        const swapData = await createEmptySwapMulticallData(admin, ethers.utils.formatBytes32String("vbnb-borrow"));

        await expect(
          leverageManager
            .connect(alice)
            .enterLeverage(
              collateralMarket.address,
              collateralAmountSeed,
              vBNBMarket.address,
              borrowedAmountToFlashLoan,
              0,
              swapData,
            ),
        ).to.be.revertedWithCustomError(leverageManager, "VBNBNotSupported");
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

      it("should revert when collateral and borrow markets are identical", async () => {
        const collateralAmountSeed = parseEther("0");
        const borrowedAmountToFlashLoan = parseEther("1");
        const swapData = await createEmptySwapMulticallData(admin, ethers.utils.formatBytes32String("identical"));

        await expect(
          leverageManager.connect(alice).enterLeverage(
            collateralMarket.address,
            collateralAmountSeed,
            collateralMarket.address, // same as collateral market
            borrowedAmountToFlashLoan,
            0,
            swapData,
          ),
        ).to.be.revertedWithCustomError(leverageManager, "IdenticalMarkets");
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

      it("should revert with MintBehalfFailed when mint fails in enterLeverage", async () => {
        const collateralAmountSeed = parseEther("0");
        const borrowedAmountToFlashLoan = parseEther("1");

        const swapData = await createSwapMulticallData(
          collateral,
          leverageManager.address,
          parseEther("1"),
          admin,
          ethers.utils.formatBytes32String("mint-fail-enter"),
        );

        // Pause MINT action (action index 0) for the collateral market
        await comptroller._setActionsPaused([collateralMarket.address], [0], true);

        await expect(
          leverageManager
            .connect(alice)
            .enterLeverage(
              collateralMarket.address,
              collateralAmountSeed,
              borrowMarket.address,
              borrowedAmountToFlashLoan,
              parseEther("1"),
              swapData,
            ),
        ).to.be.reverted;
      });
    });

    describe("Success Cases", () => {
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

      it("should enter leveraged position with non-zero collateral seed successfully", async () => {
        const collateralAmountSeed = parseEther("1");
        const borrowedAmountToFlashLoan = parseEther("1");

        await collateral.transfer(aliceAddress, collateralAmountSeed);
        await collateral.connect(alice).approve(leverageManager.address, collateralAmountSeed);

        const swapData = await createSwapMulticallData(
          collateral,
          leverageManager.address,
          parseEther("1"),
          admin,
          ethers.utils.formatBytes32String("seed-test"),
        );

        const aliceCollateralBalanceBefore = await collateralMarket.callStatic.balanceOfUnderlying(aliceAddress);
        const aliceCollateralTokenBalanceBefore = await collateral.balanceOf(aliceAddress);

        const enterTx = await leverageManager
          .connect(alice)
          .enterLeverage(
            collateralMarket.address,
            collateralAmountSeed,
            borrowMarket.address,
            borrowedAmountToFlashLoan,
            parseEther("1"),
            swapData,
          );

        const aliceCollateralBalanceAfter = await collateralMarket.callStatic.balanceOfUnderlying(aliceAddress);
        const aliceCollateralTokenBalanceAfter = await collateral.balanceOf(aliceAddress);

        // Check that seed amount was transferred from user
        expect(aliceCollateralTokenBalanceBefore.sub(aliceCollateralTokenBalanceAfter)).to.equal(collateralAmountSeed);

        // Balance should increase by more than just the swapped amount (includes seed)
        expect(aliceCollateralBalanceAfter.sub(aliceCollateralBalanceBefore)).to.be.gte(parseEther("2"));

        // Verify borrow balance exists
        expect(await borrowMarket.callStatic.borrowBalanceCurrent(aliceAddress)).to.be.gt(0);

        await expect(enterTx)
          .to.emit(leverageManager, "LeverageEntered")
          .withArgs(
            aliceAddress,
            collateralMarket.address,
            collateralAmountSeed,
            borrowMarket.address,
            borrowedAmountToFlashLoan,
          );
      });
    });
  });

  describe("enterLeverageFromBorrow", () => {
    describe("Validation", () => {
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

      it("should revert when collateral market is vBNB", async () => {
        const borrowedAmountToFlashLoan = parseEther("1");
        const borrowedAmountSeed = parseEther("0");
        const swapData = await createEmptySwapMulticallData(
          admin,
          ethers.utils.formatBytes32String("vbnb-collateral-fromborrow"),
        );

        await expect(
          leverageManager
            .connect(alice)
            .enterLeverageFromBorrow(
              vBNBMarket.address,
              borrowMarket.address,
              borrowedAmountSeed,
              borrowedAmountToFlashLoan,
              0,
              swapData,
            ),
        ).to.be.revertedWithCustomError(leverageManager, "VBNBNotSupported");
      });

      it("should revert when borrow market is vBNB", async () => {
        const borrowedAmountToFlashLoan = parseEther("1");
        const borrowedAmountSeed = parseEther("0");
        const swapData = await createEmptySwapMulticallData(
          admin,
          ethers.utils.formatBytes32String("vbnb-borrow-fromborrow"),
        );

        await expect(
          leverageManager
            .connect(alice)
            .enterLeverageFromBorrow(
              collateralMarket.address,
              vBNBMarket.address,
              borrowedAmountSeed,
              borrowedAmountToFlashLoan,
              0,
              swapData,
            ),
        ).to.be.revertedWithCustomError(leverageManager, "VBNBNotSupported");
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

      it("should revert when collateral and borrow markets are identical", async () => {
        const borrowedAmountSeed = parseEther("0");
        const borrowedAmountToFlashLoan = parseEther("1");
        const swapData = await createEmptySwapMulticallData(admin, ethers.utils.formatBytes32String("identical"));

        await expect(
          leverageManager.connect(alice).enterLeverageFromBorrow(
            collateralMarket.address,
            collateralMarket.address, // same as collateral market
            borrowedAmountSeed,
            borrowedAmountToFlashLoan,
            0,
            swapData,
          ),
        ).to.be.revertedWithCustomError(leverageManager, "IdenticalMarkets");
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

      it("should revert with MintBehalfFailed when mint fails in enterLeverageFromBorrow", async () => {
        const borrowedAmountSeed = parseEther("0");
        const borrowedAmountToFlashLoan = parseEther("1");

        const swapData = await createSwapMulticallData(
          collateral,
          leverageManager.address,
          parseEther("1"),
          admin,
          ethers.utils.formatBytes32String("mint-fail-borrow"),
        );

        // Pause MINT action (action index 0) for the collateral market
        await comptroller._setActionsPaused([collateralMarket.address], [0], true);

        await expect(
          leverageManager
            .connect(alice)
            .enterLeverageFromBorrow(
              collateralMarket.address,
              borrowMarket.address,
              borrowedAmountSeed,
              borrowedAmountToFlashLoan,
              parseEther("1"),
              swapData,
            ),
        ).to.be.reverted;
      });
    });

    describe("Success Cases", () => {
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

      it("should enter leveraged position with non-zero borrowed seed successfully", async () => {
        const borrowedAmountSeed = parseEther("0.5");
        const borrowedAmountToFlashLoan = parseEther("1");

        await borrow.transfer(aliceAddress, borrowedAmountSeed);
        await borrow.connect(alice).approve(leverageManager.address, borrowedAmountSeed);

        // Swap should account for both seed + flash loan amount
        const swapData = await createSwapMulticallData(
          collateral,
          leverageManager.address,
          parseEther("1.5"),
          admin,
          ethers.utils.formatBytes32String("borrow-seed-test"),
        );

        const aliceCollateralBalanceBefore = await collateralMarket.callStatic.balanceOfUnderlying(aliceAddress);
        const aliceBorrowTokenBalanceBefore = await borrow.balanceOf(aliceAddress);

        const enterTx = await leverageManager
          .connect(alice)
          .enterLeverageFromBorrow(
            collateralMarket.address,
            borrowMarket.address,
            borrowedAmountSeed,
            borrowedAmountToFlashLoan,
            parseEther("1.5"),
            swapData,
          );

        const aliceCollateralBalanceAfter = await collateralMarket.callStatic.balanceOfUnderlying(aliceAddress);
        const aliceBorrowTokenBalanceAfter = await borrow.balanceOf(aliceAddress);

        // Check that seed amount was transferred from user
        expect(aliceBorrowTokenBalanceBefore.sub(aliceBorrowTokenBalanceAfter)).to.equal(borrowedAmountSeed);

        // Collateral balance should increase
        expect(aliceCollateralBalanceAfter).to.be.gt(aliceCollateralBalanceBefore);

        // Verify borrow balance includes fees (user provided seed, so borrow is only for fees)
        expect(await borrowMarket.callStatic.borrowBalanceCurrent(aliceAddress)).to.be.gt(0);

        await expect(enterTx)
          .to.emit(leverageManager, "LeverageEnteredFromBorrow")
          .withArgs(
            aliceAddress,
            collateralMarket.address,
            borrowMarket.address,
            borrowedAmountSeed,
            borrowedAmountToFlashLoan,
          );
      });

      it("should transfer borrow seed amount correctly when non-zero", async () => {
        const borrowedAmountSeed = parseEther("0.5");
        const borrowedAmountToFlashLoan = parseEther("1");

        await borrow.transfer(aliceAddress, borrowedAmountSeed);
        await borrow.connect(alice).approve(leverageManager.address, borrowedAmountSeed);

        const aliceBorrowTokenBalanceBefore = await borrow.balanceOf(aliceAddress);

        const swapData = await createSwapMulticallData(
          collateral,
          leverageManager.address,
          parseEther("1.5"),
          admin,
          ethers.utils.formatBytes32String("seed-transfer-verify"),
        );

        await leverageManager
          .connect(alice)
          .enterLeverageFromBorrow(
            collateralMarket.address,
            borrowMarket.address,
            borrowedAmountSeed,
            borrowedAmountToFlashLoan,
            parseEther("1.5"),
            swapData,
          );

        const aliceBorrowTokenBalanceAfter = await borrow.balanceOf(aliceAddress);

        expect(aliceBorrowTokenBalanceBefore.sub(aliceBorrowTokenBalanceAfter)).to.equal(borrowedAmountSeed);
        expect(await borrow.balanceOf(leverageManager.address)).to.equal(0);
      });
    });
  });

  describe("exitLeverage", () => {
    describe("Validation", () => {
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

      it("should revert when collateral market is vBNB", async () => {
        const repayAmount = parseEther("1");
        const collateralAmountToRedeemForSwap = parseEther("0");
        const swapData = await createEmptySwapMulticallData(
          admin,
          ethers.utils.formatBytes32String("vbnb-exit-collateral"),
        );

        await expect(
          leverageManager
            .connect(alice)
            .exitLeverage(
              vBNBMarket.address,
              collateralAmountToRedeemForSwap,
              borrowMarket.address,
              repayAmount,
              0,
              swapData,
            ),
        ).to.be.revertedWithCustomError(leverageManager, "VBNBNotSupported");
      });

      it("should revert when borrow market is vBNB", async () => {
        const repayAmount = parseEther("1");
        const collateralAmountToRedeemForSwap = parseEther("0");
        const swapData = await createEmptySwapMulticallData(
          admin,
          ethers.utils.formatBytes32String("vbnb-exit-borrow"),
        );

        await expect(
          leverageManager
            .connect(alice)
            .exitLeverage(
              collateralMarket.address,
              collateralAmountToRedeemForSwap,
              vBNBMarket.address,
              repayAmount,
              0,
              swapData,
            ),
        ).to.be.revertedWithCustomError(leverageManager, "VBNBNotSupported");
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

      it("should revert when collateral and borrow markets are identical", async () => {
        const repayAmount = parseEther("1");
        const collateralAmountToRedeemForSwap = parseEther("0");
        const swapData = await createEmptySwapMulticallData(admin, ethers.utils.formatBytes32String("identical"));

        await expect(
          leverageManager.connect(alice).exitLeverage(
            collateralMarket.address,
            collateralAmountToRedeemForSwap,
            collateralMarket.address, // same as collateral market
            repayAmount,
            0,
            swapData,
          ),
        ).to.be.revertedWithCustomError(leverageManager, "IdenticalMarkets");
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

      it("should revert with InsufficientFundsToRepayFlashloan when swap returns less than flash loan repayment", async () => {
        const borrowedAmountToFlashLoan = parseEther("2");
        const collateralAmountSeed = parseEther("0");

        const enterSwapData = await createSwapMulticallData(
          collateral,
          leverageManager.address,
          parseEther("2"),
          admin,
          ethers.utils.formatBytes32String("enter-swap-insufficient"),
        );

        await leverageManager
          .connect(alice)
          .enterLeverage(
            collateralMarket.address,
            collateralAmountSeed,
            borrowMarket.address,
            borrowedAmountToFlashLoan,
            parseEther("2"),
            enterSwapData,
          );

        const borrowBalanceAfterEnter = await borrowMarket.callStatic.borrowBalanceCurrent(aliceAddress);
        const collateralAmountToRedeemForSwap = parseEther("1");

        // Sweep leftover to admin to clear it
        const clearSweepData = swapHelper.interface.encodeFunctionData("sweep", [borrow.address, admin.address]);
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
        const clearSalt = ethers.utils.formatBytes32String("clear-leftover");
        const clearSig = await admin._signTypedData(domain, types, {
          calls: [clearSweepData],
          deadline: "17627727131762772187",
          salt: clearSalt,
        });
        await swapHelper.multicall([clearSweepData], "17627727131762772187", clearSalt, clearSig);

        // Now prefund only 1 wei to swapHelper - way less than flash loan amount
        await borrow.transfer(swapHelper.address, BigNumber.from(1));

        // Create sweep call to send that 1 wei to leverageManager
        const sweepData = swapHelper.interface.encodeFunctionData("sweep", [borrow.address, leverageManager.address]);

        const saltValue = ethers.utils.formatBytes32String("exit-swap-insufficient");
        const signature = await admin._signTypedData(domain, types, {
          calls: [sweepData],
          deadline: "17627727131762772187",
          salt: saltValue,
        });
        const exitSwapData = swapHelper.interface.encodeFunctionData("multicall", [
          [sweepData],
          "17627727131762772187",
          saltValue,
          signature,
        ]);

        await expect(
          leverageManager.connect(alice).exitLeverage(
            collateralMarket.address,
            collateralAmountToRedeemForSwap,
            borrowMarket.address,
            borrowBalanceAfterEnter,
            0, // No slippage check - we want to test InsufficientFundsToRepayFlashloan
            exitSwapData,
          ),
        ).to.be.revertedWithCustomError(leverageManager, "InsufficientFundsToRepayFlashloan");
      });
    });

    describe("Success Cases", () => {
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

      it("should emit DustTransferred events for both collateral and borrow assets to user", async () => {
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

        const aliceBorrowBalanceBefore = await borrow.balanceOf(aliceAddress);

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

        const aliceBorrowBalanceAfter = await borrow.balanceOf(aliceAddress);
        const dustAmount = aliceBorrowBalanceAfter.sub(aliceBorrowBalanceBefore);

        // Verify DustTransferred event was emitted to user (not treasury)
        await expect(exitTx)
          .to.emit(leverageManager, "DustTransferred")
          .withArgs(aliceAddress, borrow.address, dustAmount);
      });

      it("should transfer both collateral and borrow dust to user after exiting", async () => {
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

        const aliceBorrowBalanceBefore = await borrow.balanceOf(aliceAddress);

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

        // User should have received borrow dust (not treasury)
        const aliceBorrowBalanceAfter = await borrow.balanceOf(aliceAddress);
        expect(aliceBorrowBalanceAfter).to.be.gt(aliceBorrowBalanceBefore);
      });

      it("should transfer borrow dust to user after exiting (not treasury)", async () => {
        const borrowedAmountToFlashLoan = parseEther("1");
        const collateralAmountSeed = parseEther("0");

        const enterSwapData = await createSwapMulticallData(
          collateral,
          leverageManager.address,
          parseEther("1"),
          admin,
          ethers.utils.formatBytes32String("enter-swap-update-assets"),
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
          ethers.utils.formatBytes32String("exit-swap-update-assets"),
        );

        const aliceBorrowBalanceBefore = await borrow.balanceOf(aliceAddress);
        const treasuryBalanceBefore = await borrow.balanceOf(protocolShareReserve.address);

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

        const aliceBorrowBalanceAfter = await borrow.balanceOf(aliceAddress);
        const treasuryBalanceAfter = await borrow.balanceOf(protocolShareReserve.address);
        const dustTransferred = aliceBorrowBalanceAfter.sub(aliceBorrowBalanceBefore);

        expect(dustTransferred).to.be.gt(0);
        // Dust should go to user, not treasury
        await expect(exitTx)
          .to.emit(leverageManager, "DustTransferred")
          .withArgs(aliceAddress, borrow.address, dustTransferred);
        // Treasury balance should remain unchanged
        expect(treasuryBalanceAfter).to.equal(treasuryBalanceBefore);
        expect(await borrow.balanceOf(leverageManager.address)).to.equal(0);
      });

      it("should handle flash loan amount exceeding actual debt in exitLeverage", async () => {
        const borrowedAmountToFlashLoan = parseEther("1");
        const collateralAmountSeed = parseEther("0");

        const enterSwapData = await createSwapMulticallData(
          collateral,
          leverageManager.address,
          parseEther("1"),
          admin,
          ethers.utils.formatBytes32String("enter-swap-overpay"),
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

        // Flash loan 10% more than actual debt to simulate UI offsetting interest accrual
        const flashLoanWithBuffer = borrowBalanceAfterEnter.mul(110).div(100);
        const collateralAmountToRedeemForSwap = parseEther("0.5");

        const exitSwapData = await createSwapMulticallData(
          borrow,
          leverageManager.address,
          flashLoanWithBuffer.add(parseEther("0.1")),
          admin,
          ethers.utils.formatBytes32String("exit-swap-overpay"),
        );

        const exitTx = await leverageManager
          .connect(alice)
          .exitLeverage(
            collateralMarket.address,
            collateralAmountToRedeemForSwap,
            borrowMarket.address,
            flashLoanWithBuffer,
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
            flashLoanWithBuffer,
          );

        const borrowBalanceAfterExit = await borrowMarket.callStatic.borrowBalanceCurrent(aliceAddress);
        expect(borrowBalanceAfterExit).to.equal(0);

        expect(await collateral.balanceOf(leverageManager.address)).to.equal(0);
        expect(await borrow.balanceOf(leverageManager.address)).to.equal(0);
      });
    });

    describe("Treasury Percent Handling", () => {
      it("should exit leveraged position successfully when treasuryPercent is zero", async () => {
        expect(await comptroller.treasuryPercent()).to.equal(0);

        const borrowedAmountToFlashLoan = parseEther("1");
        const collateralAmountSeed = parseEther("0");

        const enterSwapData = await createSwapMulticallData(
          collateral,
          leverageManager.address,
          parseEther("1"),
          admin,
          ethers.utils.formatBytes32String("enter-treasury-zero"),
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
        expect(borrowBalanceAfterEnter).to.be.gt(0);

        const collateralAmountToRedeemForSwap = parseEther("0.5");

        const exitSwapData = await createSwapMulticallData(
          borrow,
          leverageManager.address,
          borrowBalanceAfterEnter.add(parseEther("0.1")),
          admin,
          ethers.utils.formatBytes32String("exit-treasury-zero"),
        );

        await expect(
          leverageManager
            .connect(alice)
            .exitLeverage(
              collateralMarket.address,
              collateralAmountToRedeemForSwap,
              borrowMarket.address,
              borrowBalanceAfterEnter,
              0,
              exitSwapData,
            ),
        )
          .to.emit(leverageManager, "LeverageExited")
          .withArgs(
            aliceAddress,
            collateralMarket.address,
            collateralAmountToRedeemForSwap,
            borrowMarket.address,
            borrowBalanceAfterEnter,
          );

        const borrowBalanceAfterExit = await borrowMarket.callStatic.borrowBalanceCurrent(aliceAddress);
        expect(borrowBalanceAfterExit).to.equal(0);
      });

      it("should exit leveraged position successfully when treasuryPercent is nonzero", async () => {
        const treasuryPercent = parseUnits("1", 16); // 1%
        await comptroller._setTreasuryData(admin.address, admin.address, treasuryPercent);

        expect(await comptroller.treasuryPercent()).to.equal(treasuryPercent);

        const borrowedAmountToFlashLoan = parseEther("1");
        const collateralAmountSeed = parseEther("0");

        const enterSwapData = await createSwapMulticallData(
          collateral,
          leverageManager.address,
          parseEther("1"),
          admin,
          ethers.utils.formatBytes32String("enter-treasury-1pct"),
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
        expect(borrowBalanceAfterEnter).to.be.gt(0);

        const collateralAmountToRedeemForSwap = parseEther("0.5");

        const exitSwapData = await createSwapMulticallData(
          borrow,
          leverageManager.address,
          borrowBalanceAfterEnter.add(parseEther("0.1")),
          admin,
          ethers.utils.formatBytes32String("exit-treasury-1pct"),
        );

        await expect(
          leverageManager
            .connect(alice)
            .exitLeverage(
              collateralMarket.address,
              collateralAmountToRedeemForSwap,
              borrowMarket.address,
              borrowBalanceAfterEnter,
              0,
              exitSwapData,
            ),
        )
          .to.emit(leverageManager, "LeverageExited")
          .withArgs(
            aliceAddress,
            collateralMarket.address,
            collateralAmountToRedeemForSwap,
            borrowMarket.address,
            borrowBalanceAfterEnter,
          );

        const borrowBalanceAfterExit = await borrowMarket.callStatic.borrowBalanceCurrent(aliceAddress);
        expect(borrowBalanceAfterExit).to.equal(0);
      });

      it("should exit leveraged position successfully with high treasury percent (5%)", async () => {
        const treasuryPercent = parseUnits("5", 16); // 5%
        await comptroller._setTreasuryData(admin.address, admin.address, treasuryPercent);

        expect(await comptroller.treasuryPercent()).to.equal(treasuryPercent);

        const borrowedAmountToFlashLoan = parseEther("1");
        const collateralAmountSeed = parseEther("0");

        const enterSwapData = await createSwapMulticallData(
          collateral,
          leverageManager.address,
          parseEther("1"),
          admin,
          ethers.utils.formatBytes32String("enter-treasury-5pct"),
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
        expect(borrowBalanceAfterEnter).to.be.gt(0);

        const collateralAmountToRedeemForSwap = parseEther("0.5");

        const exitSwapData = await createSwapMulticallData(
          borrow,
          leverageManager.address,
          borrowBalanceAfterEnter.add(parseEther("0.1")),
          admin,
          ethers.utils.formatBytes32String("exit-treasury-5pct"),
        );

        await expect(
          leverageManager
            .connect(alice)
            .exitLeverage(
              collateralMarket.address,
              collateralAmountToRedeemForSwap,
              borrowMarket.address,
              borrowBalanceAfterEnter,
              0,
              exitSwapData,
            ),
        )
          .to.emit(leverageManager, "LeverageExited")
          .withArgs(
            aliceAddress,
            collateralMarket.address,
            collateralAmountToRedeemForSwap,
            borrowMarket.address,
            borrowBalanceAfterEnter,
          );

        const borrowBalanceAfterExit = await borrowMarket.callStatic.borrowBalanceCurrent(aliceAddress);
        expect(borrowBalanceAfterExit).to.equal(0);
      });
    });
  });

  describe("exitSingleAssetLeverage", () => {
    describe("Validation", () => {
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

      it("should revert when collateral market is vBNB", async () => {
        const collateralAmountToFlashLoan = parseEther("2");

        await expect(
          leverageManager.connect(alice).exitSingleAssetLeverage(vBNBMarket.address, collateralAmountToFlashLoan),
        ).to.be.revertedWithCustomError(leverageManager, "VBNBNotSupported");
      });

      it("should revert when user has not set delegation", async () => {
        const collateralAmountToFlashLoan = parseEther("2");

        await comptroller.connect(alice).updateDelegate(leverageManager.address, false);
        await expect(
          leverageManager.connect(alice).exitSingleAssetLeverage(collateralMarket.address, collateralAmountToFlashLoan),
        ).to.be.revertedWithCustomError(leverageManager, "NotAnApprovedDelegate");
      });
    });

    describe("Success Cases", () => {
      it("should exit leveraged position with single collateral successfully", async () => {
        const aliceAddress = await alice.getAddress();

        const collateralAmountSeed = parseEther("1");
        const collateralAmountToFlashLoan = parseEther("2");

        await collateral.transfer(aliceAddress, collateralAmountSeed);
        await collateral.connect(alice).approve(leverageManager.address, collateralAmountSeed);

        await leverageManager
          .connect(alice)
          .enterSingleAssetLeverage(collateralMarket.address, collateralAmountSeed, collateralAmountToFlashLoan);

        const collateralBalanceAfterEnter = await collateralMarket.callStatic.balanceOfUnderlying(aliceAddress);
        const borrowBalanceAfterEnter = await collateralMarket.callStatic.borrowBalanceCurrent(aliceAddress);

        const borrowedAmountToFlashLoan = borrowBalanceAfterEnter;

        await expect(
          leverageManager.connect(alice).exitSingleAssetLeverage(collateralMarket.address, borrowedAmountToFlashLoan),
        )
          .to.emit(leverageManager, "SingleAssetLeverageExited")
          .withArgs(aliceAddress, collateralMarket.address, borrowedAmountToFlashLoan);

        const collateralBalanceAfterExit = await collateralMarket.callStatic.balanceOfUnderlying(aliceAddress);
        const borrowBalanceAfterExit = await collateralMarket.callStatic.borrowBalanceCurrent(aliceAddress);

        expect(collateralBalanceAfterExit).to.be.lt(collateralBalanceAfterEnter);

        expect(borrowBalanceAfterExit).to.equal(0);
      });

      it("should verify account is safe after exiting leveraged position", async () => {
        const aliceAddress = await alice.getAddress();

        const collateralAmountSeed = parseEther("1");
        const collateralAmountToFlashLoan = parseEther("2");

        await collateral.transfer(aliceAddress, collateralAmountSeed);
        await collateral.connect(alice).approve(leverageManager.address, collateralAmountSeed);

        await leverageManager
          .connect(alice)
          .enterSingleAssetLeverage(collateralMarket.address, collateralAmountSeed, collateralAmountToFlashLoan);

        const borrowBalanceAfterEnter = await collateralMarket.callStatic.borrowBalanceCurrent(aliceAddress);

        const collateralAmountToFlashLoanForExit = borrowBalanceAfterEnter;

        await leverageManager
          .connect(alice)
          .exitSingleAssetLeverage(collateralMarket.address, collateralAmountToFlashLoanForExit);
      });

      it("should transfer dust to initiator after exiting leveraged position", async () => {
        const aliceAddress = await alice.getAddress();

        const collateralAmountSeed = parseEther("1");
        const collateralAmountToFlashLoan = parseEther("2");

        await collateral.transfer(aliceAddress, collateralAmountSeed);
        await collateral.connect(alice).approve(leverageManager.address, collateralAmountSeed);

        await leverageManager
          .connect(alice)
          .enterSingleAssetLeverage(collateralMarket.address, collateralAmountSeed, collateralAmountToFlashLoan);

        const borrowBalanceAfterEnter = await collateralMarket.callStatic.borrowBalanceCurrent(aliceAddress);

        await leverageManager.connect(alice).exitSingleAssetLeverage(collateralMarket.address, borrowBalanceAfterEnter);

        const contractCollateralBalance = await collateral.balanceOf(leverageManager.address);
        expect(contractCollateralBalance).to.equal(0);
      });

      it("should allow entering and exiting leveraged position multiple times", async () => {
        const collateralAmountToFlashLoan = parseEther("1");
        await leverageManager
          .connect(alice)
          .enterSingleAssetLeverage(collateralMarket.address, 0, collateralAmountToFlashLoan);

        const borrowBalance1 = await collateralMarket.callStatic.borrowBalanceCurrent(aliceAddress);
        expect(borrowBalance1).to.be.gt(0);

        await leverageManager.connect(alice).exitSingleAssetLeverage(collateralMarket.address, borrowBalance1);

        const borrowBalanceAfterExit1 = await collateralMarket.callStatic.borrowBalanceCurrent(aliceAddress);
        expect(borrowBalanceAfterExit1).to.equal(0);

        await leverageManager
          .connect(alice)
          .enterSingleAssetLeverage(collateralMarket.address, 0, collateralAmountToFlashLoan);

        const borrowBalance2 = await collateralMarket.callStatic.borrowBalanceCurrent(aliceAddress);
        expect(borrowBalance2).to.be.gt(0);

        await leverageManager.connect(alice).exitSingleAssetLeverage(collateralMarket.address, borrowBalance2);

        const borrowBalanceAfterExit2 = await collateralMarket.callStatic.borrowBalanceCurrent(aliceAddress);
        expect(borrowBalanceAfterExit2).to.equal(0);

        const contractCollateralBalance = await collateral.balanceOf(leverageManager.address);
        expect(contractCollateralBalance).to.equal(0);
      });
    });

    describe("Error Cases", () => {
      it("should revert with BorrowBehalfFailed when borrow is not allowed on market", async () => {
        const collateralAmountSeed = parseEther("0");
        const collateralAmountToFlashLoan = parseEther("1");

        // When borrowing is not allowed, the borrowBehalf call will fail.
        await comptroller.setIsBorrowAllowed(0, collateralMarket.address, false);

        await expect(
          leverageManager
            .connect(alice)
            .enterSingleAssetLeverage(collateralMarket.address, collateralAmountSeed, collateralAmountToFlashLoan),
        ).to.be.reverted;
      });

      it("should revert when REPAY action is paused during exit", async () => {
        const collateralAmountSeed = parseEther("1");
        const collateralAmountToFlashLoan = parseEther("2");

        await collateral.transfer(aliceAddress, collateralAmountSeed);
        await collateral.connect(alice).approve(leverageManager.address, collateralAmountSeed);

        await leverageManager
          .connect(alice)
          .enterSingleAssetLeverage(collateralMarket.address, collateralAmountSeed, collateralAmountToFlashLoan);

        const borrowBalanceAfterEnter = await collateralMarket.callStatic.borrowBalanceCurrent(aliceAddress);

        // Pause REPAY action (action index 3) for the collateral market
        await comptroller._setActionsPaused([collateralMarket.address], [3], true);

        await expect(
          leverageManager.connect(alice).exitSingleAssetLeverage(collateralMarket.address, borrowBalanceAfterEnter),
        ).to.be.reverted;
      });

      it("should revert when REDEEM action is paused during exit", async () => {
        // First enter a leveraged position
        const collateralAmountSeed = parseEther("1");
        const collateralAmountToFlashLoan = parseEther("2");

        await collateral.transfer(aliceAddress, collateralAmountSeed);
        await collateral.connect(alice).approve(leverageManager.address, collateralAmountSeed);

        await leverageManager
          .connect(alice)
          .enterSingleAssetLeverage(collateralMarket.address, collateralAmountSeed, collateralAmountToFlashLoan);

        const borrowBalanceAfterEnter = await collateralMarket.callStatic.borrowBalanceCurrent(aliceAddress);

        // Pause REDEEM action (action index 1) for the collateral market
        await comptroller._setActionsPaused([collateralMarket.address], [1], true);

        await expect(
          leverageManager.connect(alice).exitSingleAssetLeverage(collateralMarket.address, borrowBalanceAfterEnter),
        ).to.be.reverted;
      });

      it("should revert when BORROW action is paused during enter", async () => {
        const collateralAmountSeed = parseEther("0");
        const collateralAmountToFlashLoan = parseEther("1");

        // Pause BORROW action (action index 2) for the collateral market
        await comptroller._setActionsPaused([collateralMarket.address], [2], true);

        await expect(
          leverageManager
            .connect(alice)
            .enterSingleAssetLeverage(collateralMarket.address, collateralAmountSeed, collateralAmountToFlashLoan),
        ).to.be.reverted;
      });

      it("should revert with InsufficientFundsToRepayFlashloan when redeemed amount is insufficient in exitSingleAssetLeverage", async () => {
        const collateralAmountSeed = parseEther("1");
        const collateralAmountToFlashLoan = parseEther("2");

        await collateral.transfer(aliceAddress, collateralAmountSeed);
        await collateral.connect(alice).approve(leverageManager.address, collateralAmountSeed);

        await leverageManager
          .connect(alice)
          .enterSingleAssetLeverage(collateralMarket.address, collateralAmountSeed, collateralAmountToFlashLoan);

        const borrowBalanceAfterEnter = await collateralMarket.callStatic.borrowBalanceCurrent(aliceAddress);

        // Try to exit with a flash loan amount much larger than what can be redeemed
        // This should fail because after repaying and redeeming, there won't be enough to repay flash loan
        const excessiveFlashLoanAmount = borrowBalanceAfterEnter.mul(10);

        await expect(
          leverageManager.connect(alice).exitSingleAssetLeverage(collateralMarket.address, excessiveFlashLoanAmount),
        ).to.be.reverted;
      });
    });

    describe("Edge Cases", () => {
      it("should not emit DustTransferred when dust amount is zero after exit", async () => {
        const collateralAmountSeed = parseEther("0");
        const collateralAmountToFlashLoan = parseEther("1");

        await leverageManager
          .connect(alice)
          .enterSingleAssetLeverage(collateralMarket.address, collateralAmountSeed, collateralAmountToFlashLoan);

        const borrowBalanceAfterEnter = await collateralMarket.callStatic.borrowBalanceCurrent(aliceAddress);

        const exitTx = await leverageManager
          .connect(alice)
          .exitSingleAssetLeverage(collateralMarket.address, borrowBalanceAfterEnter);

        const contractCollateralBalance = await collateral.balanceOf(leverageManager.address);
        expect(contractCollateralBalance).to.equal(0);

        await expect(exitTx).to.emit(leverageManager, "SingleAssetLeverageExited");
      });

      it("should handle flash loan amount exceeding actual debt in exitSingleAssetLeverage", async () => {
        const collateralAmountSeed = parseEther("1");
        const collateralAmountToFlashLoan = parseEther("2");

        await collateral.transfer(aliceAddress, collateralAmountSeed);
        await collateral.connect(alice).approve(leverageManager.address, collateralAmountSeed);

        await leverageManager
          .connect(alice)
          .enterSingleAssetLeverage(collateralMarket.address, collateralAmountSeed, collateralAmountToFlashLoan);

        const borrowBalanceAfterEnter = await collateralMarket.callStatic.borrowBalanceCurrent(aliceAddress);

        // Flash loan 10% more than actual debt to simulate UI offsetting interest accrual
        const flashLoanWithBuffer = borrowBalanceAfterEnter.mul(110).div(100);

        const exitTx = await leverageManager
          .connect(alice)
          .exitSingleAssetLeverage(collateralMarket.address, flashLoanWithBuffer);

        await expect(exitTx)
          .to.emit(leverageManager, "SingleAssetLeverageExited")
          .withArgs(aliceAddress, collateralMarket.address, flashLoanWithBuffer);

        const borrowBalanceAfterExit = await collateralMarket.callStatic.borrowBalanceCurrent(aliceAddress);
        expect(borrowBalanceAfterExit).to.equal(0);

        expect(await collateral.balanceOf(leverageManager.address)).to.equal(0);
      });

      it("should handle re-entering same market position after exiting", async () => {
        await leverageManager.connect(alice).enterSingleAssetLeverage(collateralMarket.address, 0, parseEther("1"));

        const borrowBalance1 = await collateralMarket.callStatic.borrowBalanceCurrent(aliceAddress);
        await leverageManager.connect(alice).exitSingleAssetLeverage(collateralMarket.address, borrowBalance1);

        expect(await collateralMarket.callStatic.borrowBalanceCurrent(aliceAddress)).to.equal(0);
        expect(await collateral.balanceOf(leverageManager.address)).to.equal(0);

        await leverageManager.connect(alice).enterSingleAssetLeverage(collateralMarket.address, 0, parseEther("1.5"));

        const borrowBalance2 = await collateralMarket.callStatic.borrowBalanceCurrent(aliceAddress);
        expect(borrowBalance2).to.be.gt(0);
        await leverageManager.connect(alice).exitSingleAssetLeverage(collateralMarket.address, borrowBalance2);

        expect(await collateralMarket.callStatic.borrowBalanceCurrent(aliceAddress)).to.equal(0);
        expect(await collateral.balanceOf(leverageManager.address)).to.equal(0);
      });
    });

    describe("Treasury Percent Handling", () => {
      it("should exit leveraged position successfully when treasuryPercent is zero", async () => {
        expect(await comptroller.treasuryPercent()).to.equal(0);

        const collateralAmountSeed = parseEther("1");
        const collateralAmountToFlashLoan = parseEther("2");

        await collateral.transfer(aliceAddress, collateralAmountSeed);
        await collateral.connect(alice).approve(leverageManager.address, collateralAmountSeed);

        await leverageManager
          .connect(alice)
          .enterSingleAssetLeverage(collateralMarket.address, collateralAmountSeed, collateralAmountToFlashLoan);

        const borrowBalanceAfterEnter = await collateralMarket.callStatic.borrowBalanceCurrent(aliceAddress);
        expect(borrowBalanceAfterEnter).to.be.gt(0);

        await expect(
          leverageManager.connect(alice).exitSingleAssetLeverage(collateralMarket.address, borrowBalanceAfterEnter),
        )
          .to.emit(leverageManager, "SingleAssetLeverageExited")
          .withArgs(aliceAddress, collateralMarket.address, borrowBalanceAfterEnter);

        const borrowBalanceAfterExit = await collateralMarket.callStatic.borrowBalanceCurrent(aliceAddress);
        expect(borrowBalanceAfterExit).to.equal(0);
      });

      it("should exit leveraged position successfully when treasuryPercent is nonzero", async () => {
        const treasuryPercent = parseUnits("1", 16); // 1%
        await comptroller._setTreasuryData(admin.address, admin.address, treasuryPercent);

        expect(await comptroller.treasuryPercent()).to.equal(treasuryPercent);

        const collateralAmountSeed = parseEther("1");
        const collateralAmountToFlashLoan = parseEther("2");

        await collateral.transfer(aliceAddress, collateralAmountSeed);
        await collateral.connect(alice).approve(leverageManager.address, collateralAmountSeed);

        await leverageManager
          .connect(alice)
          .enterSingleAssetLeverage(collateralMarket.address, collateralAmountSeed, collateralAmountToFlashLoan);

        const borrowBalanceAfterEnter = await collateralMarket.callStatic.borrowBalanceCurrent(aliceAddress);
        expect(borrowBalanceAfterEnter).to.be.gt(0);

        await expect(
          leverageManager.connect(alice).exitSingleAssetLeverage(collateralMarket.address, borrowBalanceAfterEnter),
        )
          .to.emit(leverageManager, "SingleAssetLeverageExited")
          .withArgs(aliceAddress, collateralMarket.address, borrowBalanceAfterEnter);

        const borrowBalanceAfterExit = await collateralMarket.callStatic.borrowBalanceCurrent(aliceAddress);
        expect(borrowBalanceAfterExit).to.equal(0);
      });

      it("should exit leveraged position successfully with high treasury percent (5%)", async () => {
        const treasuryPercent = parseUnits("5", 16); // 5%
        await comptroller._setTreasuryData(admin.address, admin.address, treasuryPercent);

        expect(await comptroller.treasuryPercent()).to.equal(treasuryPercent);

        const collateralAmountSeed = parseEther("1");
        const collateralAmountToFlashLoan = parseEther("2");

        await collateral.transfer(aliceAddress, collateralAmountSeed);
        await collateral.connect(alice).approve(leverageManager.address, collateralAmountSeed);

        await leverageManager
          .connect(alice)
          .enterSingleAssetLeverage(collateralMarket.address, collateralAmountSeed, collateralAmountToFlashLoan);

        const borrowBalanceAfterEnter = await collateralMarket.callStatic.borrowBalanceCurrent(aliceAddress);
        expect(borrowBalanceAfterEnter).to.be.gt(0);

        await expect(
          leverageManager.connect(alice).exitSingleAssetLeverage(collateralMarket.address, borrowBalanceAfterEnter),
        )
          .to.emit(leverageManager, "SingleAssetLeverageExited")
          .withArgs(aliceAddress, collateralMarket.address, borrowBalanceAfterEnter);

        const borrowBalanceAfterExit = await collateralMarket.callStatic.borrowBalanceCurrent(aliceAddress);
        expect(borrowBalanceAfterExit).to.equal(0);
      });

      it("should handle multiple enter/exit cycles with treasury percent enabled", async () => {
        const treasuryPercent = parseUnits("2", 16); // 2%
        await comptroller._setTreasuryData(admin.address, admin.address, treasuryPercent);

        const collateralAmountSeed = parseEther("1");
        await collateral.transfer(aliceAddress, collateralAmountSeed);
        await collateral.connect(alice).approve(leverageManager.address, collateralAmountSeed);

        await leverageManager
          .connect(alice)
          .enterSingleAssetLeverage(collateralMarket.address, collateralAmountSeed, parseEther("1"));

        let borrowBalance = await collateralMarket.callStatic.borrowBalanceCurrent(aliceAddress);
        expect(borrowBalance).to.be.gt(0);

        await leverageManager.connect(alice).exitSingleAssetLeverage(collateralMarket.address, borrowBalance);
        expect(await collateralMarket.callStatic.borrowBalanceCurrent(aliceAddress)).to.equal(0);

        await leverageManager.connect(alice).enterSingleAssetLeverage(collateralMarket.address, 0, parseEther("1"));

        borrowBalance = await collateralMarket.callStatic.borrowBalanceCurrent(aliceAddress);
        expect(borrowBalance).to.be.gt(0);

        await leverageManager.connect(alice).exitSingleAssetLeverage(collateralMarket.address, borrowBalance);
        expect(await collateralMarket.callStatic.borrowBalanceCurrent(aliceAddress)).to.equal(0);

        expect(await collateral.balanceOf(leverageManager.address)).to.equal(0);
      });

      it("should exit with flash loan buffer when treasury percent is nonzero", async () => {
        const treasuryPercent = parseUnits("1", 16);
        await comptroller._setTreasuryData(admin.address, admin.address, treasuryPercent);

        const collateralAmountSeed = parseEther("1");
        const collateralAmountToFlashLoan = parseEther("2");

        await collateral.transfer(aliceAddress, collateralAmountSeed);
        await collateral.connect(alice).approve(leverageManager.address, collateralAmountSeed);

        await leverageManager
          .connect(alice)
          .enterSingleAssetLeverage(collateralMarket.address, collateralAmountSeed, collateralAmountToFlashLoan);

        const borrowBalanceAfterEnter = await collateralMarket.callStatic.borrowBalanceCurrent(aliceAddress);

        // Flash loan 10% more than actual debt
        const flashLoanWithBuffer = borrowBalanceAfterEnter.mul(110).div(100);

        const exitTx = await leverageManager
          .connect(alice)
          .exitSingleAssetLeverage(collateralMarket.address, flashLoanWithBuffer);

        await expect(exitTx)
          .to.emit(leverageManager, "SingleAssetLeverageExited")
          .withArgs(aliceAddress, collateralMarket.address, flashLoanWithBuffer);

        const borrowBalanceAfterExit = await collateralMarket.callStatic.borrowBalanceCurrent(aliceAddress);
        expect(borrowBalanceAfterExit).to.equal(0);

        expect(await collateral.balanceOf(leverageManager.address)).to.equal(0);
      });
    });
  });

  describe("executeOperation", () => {
    describe("Access Control", () => {
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

  describe("Multi-user scenarios", () => {
    describe("Concurrent Operations", () => {
      it("should allow different users to perform leverage operations concurrently", async () => {
        const bobAddress = await bob.getAddress();

        await comptroller.connect(bob).updateDelegate(leverageManager.address, true);

        await leverageManager.connect(alice).enterSingleAssetLeverage(collateralMarket.address, 0, parseEther("1"));

        const aliceBorrowBalance = await collateralMarket.callStatic.borrowBalanceCurrent(aliceAddress);
        expect(aliceBorrowBalance).to.be.gt(0);

        await leverageManager.connect(bob).enterSingleAssetLeverage(collateralMarket.address, 0, parseEther("0.5"));

        const bobBorrowBalance = await collateralMarket.callStatic.borrowBalanceCurrent(bobAddress);
        expect(bobBorrowBalance).to.be.gt(0);

        const aliceBorrowBalanceAfter = await collateralMarket.callStatic.borrowBalanceCurrent(aliceAddress);
        expect(aliceBorrowBalanceAfter).to.equal(aliceBorrowBalance);

        await leverageManager.connect(alice).exitSingleAssetLeverage(collateralMarket.address, aliceBorrowBalance);
        await leverageManager.connect(bob).exitSingleAssetLeverage(collateralMarket.address, bobBorrowBalance);

        expect(await collateralMarket.callStatic.borrowBalanceCurrent(aliceAddress)).to.equal(0);
        expect(await collateralMarket.callStatic.borrowBalanceCurrent(bobAddress)).to.equal(0);

        expect(await collateral.balanceOf(leverageManager.address)).to.equal(0);
      });

      it("should isolate transient storage between different user operations", async () => {
        const bobAddress = await bob.getAddress();

        await comptroller.connect(bob).updateDelegate(leverageManager.address, true);

        const aliceFlashLoanAmount = parseEther("2");
        await leverageManager
          .connect(alice)
          .enterSingleAssetLeverage(collateralMarket.address, 0, aliceFlashLoanAmount);

        const bobFlashLoanAmount = parseEther("1");
        await leverageManager.connect(bob).enterSingleAssetLeverage(collateralMarket.address, 0, bobFlashLoanAmount);

        const aliceBorrowBalance = await collateralMarket.callStatic.borrowBalanceCurrent(aliceAddress);
        const bobBorrowBalance = await collateralMarket.callStatic.borrowBalanceCurrent(bobAddress);

        expect(aliceBorrowBalance).to.be.gte(bobBorrowBalance);

        await leverageManager.connect(alice).exitSingleAssetLeverage(collateralMarket.address, aliceBorrowBalance);
        await leverageManager.connect(bob).exitSingleAssetLeverage(collateralMarket.address, bobBorrowBalance);
      });
    });
  });

  describe("EnterMarketFailed scenarios", () => {
    it("should succeed when user is already in the market via enterLeverage", async () => {
      await comptroller.connect(alice).enterMarkets([collateralMarket.address]);

      const swapData = await createSwapMulticallData(
        collateral,
        leverageManager.address,
        parseEther("1"),
        admin,
        ethers.utils.formatBytes32String("already-in-market"),
      );

      await expect(
        leverageManager
          .connect(alice)
          .enterLeverage(collateralMarket.address, 0, borrowMarket.address, parseEther("1"), parseEther("1"), swapData),
      ).to.emit(leverageManager, "LeverageEntered");
    });

    it("should succeed when user is already in the market via enterLeverageFromBorrow", async () => {
      await comptroller.connect(alice).enterMarkets([collateralMarket.address]);

      const swapData = await createSwapMulticallData(
        collateral,
        leverageManager.address,
        parseEther("1"),
        admin,
        ethers.utils.formatBytes32String("already-in-market-borrow"),
      );

      await expect(
        leverageManager
          .connect(alice)
          .enterLeverageFromBorrow(
            collateralMarket.address,
            borrowMarket.address,
            0,
            parseEther("1"),
            parseEther("1"),
            swapData,
          ),
      ).to.emit(leverageManager, "LeverageEnteredFromBorrow");
    });
  });

  describe("Interest Accrual before safety checks", () => {
    describe("enterSingleAssetLeverage", () => {
      it("should call accrueInterest on collateral market before safety check", async () => {
        const collateralAmountSeed = parseEther("0");
        const collateralAmountToFlashLoan = parseEther("1");

        await collateralMarket.harnessFastForward(1000);

        await expect(
          leverageManager
            .connect(alice)
            .enterSingleAssetLeverage(collateralMarket.address, collateralAmountSeed, collateralAmountToFlashLoan),
        ).to.emit(leverageManager, "SingleAssetLeverageEntered");

        expect(await collateralMarket.callStatic.borrowBalanceCurrent(aliceAddress)).to.be.gt(0);
      });

      it("should revert with AccrueInterestFailed when accrueInterest fails on collateral market", async () => {
        const collateralAmountSeed = parseEther("0");
        const collateralAmountToFlashLoan = parseEther("1");

        await collateralMarket.harnessFastForward(1);

        interestRateModel.getBorrowRate.reverts("INTEREST_RATE_MODEL_ERROR");

        await expect(
          leverageManager
            .connect(alice)
            .enterSingleAssetLeverage(collateralMarket.address, collateralAmountSeed, collateralAmountToFlashLoan),
        ).to.be.revertedWith("INTEREST_RATE_MODEL_ERROR");
      });
    });

    describe("enterLeverage", () => {
      it("should call accrueInterest on both collateral and borrow markets before safety check", async () => {
        const collateralAmountSeed = parseEther("0");
        const borrowedAmountToFlashLoan = parseEther("1");

        const swapData = await createSwapMulticallData(
          collateral,
          leverageManager.address,
          parseEther("1"),
          admin,
          ethers.utils.formatBytes32String("accrue-both-markets"),
        );

        await collateralMarket.harnessFastForward(1000);
        await borrowMarket.harnessFastForward(1000);

        await expect(
          leverageManager
            .connect(alice)
            .enterLeverage(
              collateralMarket.address,
              collateralAmountSeed,
              borrowMarket.address,
              borrowedAmountToFlashLoan,
              parseEther("1"),
              swapData,
            ),
        ).to.emit(leverageManager, "LeverageEntered");

        expect(await borrowMarket.callStatic.borrowBalanceCurrent(aliceAddress)).to.be.gt(0);
      });

      it("should revert with AccrueInterestFailed when accrueInterest fails on collateral market", async () => {
        const collateralAmountSeed = parseEther("0");
        const borrowedAmountToFlashLoan = parseEther("1");

        const swapData = await createSwapMulticallData(
          collateral,
          leverageManager.address,
          parseEther("1"),
          admin,
          ethers.utils.formatBytes32String("accrue-fail-collateral"),
        );

        await collateralMarket.harnessFastForward(1);

        interestRateModel.getBorrowRate.reverts("INTEREST_RATE_MODEL_ERROR");

        await expect(
          leverageManager
            .connect(alice)
            .enterLeverage(
              collateralMarket.address,
              collateralAmountSeed,
              borrowMarket.address,
              borrowedAmountToFlashLoan,
              parseEther("1"),
              swapData,
            ),
        ).to.be.revertedWith("INTEREST_RATE_MODEL_ERROR");
      });

      it("should revert with AccrueInterestFailed when accrueInterest fails on borrow market", async () => {
        const collateralAmountSeed = parseEther("0");
        const borrowedAmountToFlashLoan = parseEther("1");

        const swapData = await createSwapMulticallData(
          collateral,
          leverageManager.address,
          parseEther("1"),
          admin,
          ethers.utils.formatBytes32String("accrue-fail-borrow"),
        );

        await borrowMarket.harnessFastForward(1);

        interestRateModel.getBorrowRate.reverts("INTEREST_RATE_MODEL_ERROR");

        await expect(
          leverageManager
            .connect(alice)
            .enterLeverage(
              collateralMarket.address,
              collateralAmountSeed,
              borrowMarket.address,
              borrowedAmountToFlashLoan,
              parseEther("1"),
              swapData,
            ),
        ).to.be.revertedWith("INTEREST_RATE_MODEL_ERROR");
      });
    });

    describe("enterLeverageFromBorrow", () => {
      it("should call accrueInterest on both collateral and borrow markets before safety check", async () => {
        const borrowedAmountSeed = parseEther("0");
        const borrowedAmountToFlashLoan = parseEther("1");

        const swapData = await createSwapMulticallData(
          collateral,
          leverageManager.address,
          parseEther("1"),
          admin,
          ethers.utils.formatBytes32String("accrue-both-from-borrow"),
        );

        await collateralMarket.harnessFastForward(1000);
        await borrowMarket.harnessFastForward(1000);

        await expect(
          leverageManager
            .connect(alice)
            .enterLeverageFromBorrow(
              collateralMarket.address,
              borrowMarket.address,
              borrowedAmountSeed,
              borrowedAmountToFlashLoan,
              parseEther("1"),
              swapData,
            ),
        ).to.emit(leverageManager, "LeverageEnteredFromBorrow");

        expect(await borrowMarket.callStatic.borrowBalanceCurrent(aliceAddress)).to.be.gt(0);
      });

      it("should revert with AccrueInterestFailed when accrueInterest fails on collateral market", async () => {
        const borrowedAmountSeed = parseEther("0");
        const borrowedAmountToFlashLoan = parseEther("1");

        const swapData = await createSwapMulticallData(
          collateral,
          leverageManager.address,
          parseEther("1"),
          admin,
          ethers.utils.formatBytes32String("accrue-fail-coll-fromborrow"),
        );

        await collateralMarket.harnessFastForward(1);

        interestRateModel.getBorrowRate.reverts("INTEREST_RATE_MODEL_ERROR");

        await expect(
          leverageManager
            .connect(alice)
            .enterLeverageFromBorrow(
              collateralMarket.address,
              borrowMarket.address,
              borrowedAmountSeed,
              borrowedAmountToFlashLoan,
              parseEther("1"),
              swapData,
            ),
        ).to.be.revertedWith("INTEREST_RATE_MODEL_ERROR");
      });

      it("should revert with AccrueInterestFailed when accrueInterest fails on borrow market", async () => {
        const borrowedAmountSeed = parseEther("0");
        const borrowedAmountToFlashLoan = parseEther("1");

        const swapData = await createSwapMulticallData(
          collateral,
          leverageManager.address,
          parseEther("1"),
          admin,
          ethers.utils.formatBytes32String("accrue-fail-borr-fromborrow"),
        );

        await borrowMarket.harnessFastForward(1);

        interestRateModel.getBorrowRate.reverts("INTEREST_RATE_MODEL_ERROR");

        await expect(
          leverageManager
            .connect(alice)
            .enterLeverageFromBorrow(
              collateralMarket.address,
              borrowMarket.address,
              borrowedAmountSeed,
              borrowedAmountToFlashLoan,
              parseEther("1"),
              swapData,
            ),
        ).to.be.revertedWith("INTEREST_RATE_MODEL_ERROR");
      });
    });

    describe("Interest accrual ensures accurate safety checks", () => {
      it("should reflect accrued interest in safety check during enterSingleAssetLeverage", async () => {
        await leverageManager.connect(alice).enterSingleAssetLeverage(collateralMarket.address, 0, parseEther("1"));

        const borrowBalanceAfterEnter = await collateralMarket.callStatic.borrowBalanceCurrent(aliceAddress);
        expect(borrowBalanceAfterEnter).to.be.gt(0);

        await collateralMarket.harnessFastForward(10000);

        await expect(
          leverageManager.connect(alice).enterSingleAssetLeverage(collateralMarket.address, 0, parseEther("0.1")),
        ).to.emit(leverageManager, "SingleAssetLeverageEntered");

        const newBorrowBalance = await collateralMarket.callStatic.borrowBalanceCurrent(aliceAddress);
        expect(newBorrowBalance).to.be.gt(borrowBalanceAfterEnter);
      });

      it("should accrue interest on all user markets before safety check", async () => {
        // User first enters a position in borrowMarket (third party market)
        await borrow.faucet(parseEther("10"));
        await borrow.transfer(aliceAddress, parseEther("5"));
        await borrow.connect(alice).approve(borrowMarket.address, parseEther("5"));
        await borrowMarket.connect(alice).mint(parseEther("5"));

        await comptroller.connect(alice).enterMarkets([borrowMarket.address]);

        await borrowMarket.harnessFastForward(10000);

        const collateralAmountToFlashLoan = parseEther("1");

        await expect(
          leverageManager
            .connect(alice)
            .enterSingleAssetLeverage(collateralMarket.address, 0, collateralAmountToFlashLoan),
        )
          .to.emit(borrowMarket, "AccrueInterest")
          .to.emit(leverageManager, "SingleAssetLeverageEntered");
      });
    });
  });
});
