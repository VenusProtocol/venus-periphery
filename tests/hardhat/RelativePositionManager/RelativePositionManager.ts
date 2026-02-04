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
  InterestRateModel,
  LeverageStrategiesManager,
  RelativePositionManager,
  ResilientOracleInterface,
  SwapHelper,
  VBep20Harness,
} from "../../../typechain";

type SetupFixture = {
  comptroller: ComptrollerMock;
  leverageManager: LeverageStrategiesManager;
  relativePositionManager: RelativePositionManager;
  swapHelper: SwapHelper;
  accessControl: FakeContract<IAccessControlManagerV8>;
  resilientOracle: FakeContract<ResilientOracleInterface>;
  collateralMarket: VBep20Harness;
  collateralToken: EIP20Interface;
  borrowMarket: VBep20Harness;
  borrowToken: EIP20Interface;
  dsaMarket: VBep20Harness;
  dsaToken: EIP20Interface;
  usdcMarket: VBep20Harness;
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

  const { mockToken: collateralToken, vToken: collateralMarket } = await deployVToken(
    "CAKE",
    comptroller,
    accessControl.address,
    interestRateModel.address,
    protocolShareReserve.address,
    admin.address,
  );

  const { mockToken: borrowToken, vToken: borrowMarket } = await deployVToken(
    "ETH",
    comptroller,
    accessControl.address,
    interestRateModel.address,
    protocolShareReserve.address,
    admin.address,
  );

  const { mockToken: dsaToken, vToken: dsaMarket } = await deployVToken(
    "USDT",
    comptroller,
    accessControl.address,
    interestRateModel.address,
    protocolShareReserve.address,
    admin.address,
  );

  const { vToken: usdcMarket } = await deployVToken(
    "USDC",
    comptroller,
    accessControl.address,
    interestRateModel.address,
    protocolShareReserve.address,
    admin.address,
  );

  const { vToken: unlistedMarket } = await deployVToken(
    "UNLISTED",
    comptroller,
    accessControl.address,
    interestRateModel.address,
    protocolShareReserve.address,
    admin.address,
    false,
  );

  const { vToken: vBNBMarket } = await deployVToken(
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

  // Supply liquidity to markets so flash loans can execute; top up admin for test transfers
  await collateralToken.connect(admin).faucet(parseEther("100"));
  await borrowToken.connect(admin).faucet(parseEther("100"));
  await collateralToken.connect(admin).approve(collateralMarket.address, parseEther("100"));
  await collateralMarket.connect(admin).mint(parseEther("100"));
  await borrowToken.connect(admin).approve(borrowMarket.address, parseEther("100"));
  await borrowMarket.connect(admin).mint(parseEther("100"));
  await dsaToken.connect(admin).faucet(parseEther("100"));
  await dsaToken.connect(admin).approve(dsaMarket.address, parseEther("100"));
  await dsaMarket.connect(admin).mint(parseEther("100"));

  // Deploy RelativePositionManager via upgrades.deployProxy, passing constructor args and initializer args
  const RelativePositionManagerFactory = await ethers.getContractFactory("RelativePositionManager");
  const relativePositionManager = (await upgrades.deployProxy(RelativePositionManagerFactory, [accessControl.address], {
    constructorArgs: [comptroller.address, leverageManager.address],
    initializer: "initialize",
    unsafeAllow: ["state-variable-immutable"],
  })) as RelativePositionManager;

  // Deploy PositionAccount implementation with the RPM proxy address
  const PositionAccountFactory = await ethers.getContractFactory("PositionAccount");
  const positionAccountImpl = await PositionAccountFactory.deploy(
    comptroller.address,
    relativePositionManager.address,
    leverageManager.address,
  );

  // Configure PositionAccount implementation via governance-controlled setter
  await (relativePositionManager as any).setPositionAccountImplementation(positionAccountImpl.address);

  await relativePositionManager.addDSAVToken(dsaMarket.address);

  return {
    comptroller,
    leverageManager,
    relativePositionManager,
    swapHelper,
    accessControl,
    resilientOracle,
    collateralMarket,
    collateralToken,
    borrowMarket,
    borrowToken,
    dsaMarket,
    dsaToken,
    usdcMarket,
    unlistedMarket,
    vBNBMarket,
  };
};

/**
 * Creates swap multicall: sweeps tokenOut to recipient; optionally consumes tokenIn by sweeping it to dead address.
 * When tokenIn is provided, the multicall includes a sweep of tokenIn from swapHelper to dead address (caller
 * must ensure tokenIn is sent to swapHelper separately). Avoids leaving tokenIn on swapHelper.
 * When sweepExactAmount is provided, uses genericCall(token.transfer(recipient, sweepExactAmount)) instead of
 * full sweep, so the rest of token stays on SwapHelper (e.g. for a second multicall in the same flow).
 */
async function createSwapMulticallData(
  swapHelper: SwapHelper,
  token: EIP20Interface,
  recipient: string,
  amount: BigNumber,
  salt: string,
  tokenIn?: EIP20Interface,
  sweepExactAmount?: BigNumber,
): Promise<string> {
  const SWAP_TOKEN_IN_CONSUME_ADDRESS = "0x000000000000000000000000000000000000dEaD";

  if (amount.gt(0)) {
    await token.transfer(swapHelper.address, amount);
  }
  const [signer] = await ethers.getSigners();
  const calls: string[] = [];
  if (tokenIn != null) {
    calls.push(swapHelper.interface.encodeFunctionData("sweep", [tokenIn.address, SWAP_TOKEN_IN_CONSUME_ADDRESS]));
  }
  if (sweepExactAmount != null) {
    const transferData = token.interface.encodeFunctionData("transfer", [recipient, sweepExactAmount]);
    calls.push(swapHelper.interface.encodeFunctionData("genericCall", [token.address, transferData]));
  } else {
    calls.push(swapHelper.interface.encodeFunctionData("sweep", [token.address, recipient]));
  }
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
  const deadline = "17627727131762772187";
  const saltValue = salt || ethers.utils.formatBytes32String(Math.random().toString());
  const signature = await (signer as Wallet)._signTypedData(domain, types, {
    caller: recipient,
    calls,
    deadline,
    salt: saltValue,
  });
  const multicallData = swapHelper.interface.encodeFunctionData("multicall", [calls, deadline, saltValue, signature]);
  return multicallData;
}

describe("RelativePositionManager", () => {
  let relativePositionManager: RelativePositionManager;
  let comptroller: ComptrollerMock;
  let leverageManager: LeverageStrategiesManager;
  let swapHelper: SwapHelper;
  let accessControl: FakeContract<IAccessControlManagerV8>;
  let resilientOracle: FakeContract<ResilientOracleInterface>;
  let collateralMarket: VBep20Harness;
  let collateralToken: EIP20Interface;
  let borrowMarket: VBep20Harness;
  let borrowToken: EIP20Interface;
  let dsaMarket: VBep20Harness;
  let dsaToken: EIP20Interface;
  let usdcMarket: VBep20Harness;
  let unlistedMarket: VBep20Harness;
  let vBNBMarket: VBep20Harness;
  let admin: Signer;
  let alice: Signer;
  let aliceAddress: string;

  const dsaIndex = 0;
  const noAdditionalPrincipal = 0;

  beforeEach(async () => {
    [admin, alice] = await ethers.getSigners();
    ({
      relativePositionManager,
      comptroller,
      leverageManager,
      swapHelper,
      accessControl,
      resilientOracle,
      collateralMarket,
      collateralToken,
      borrowMarket,
      borrowToken,
      dsaMarket,
      dsaToken,
      usdcMarket,
      unlistedMarket,
      vBNBMarket,
    } = await loadFixture(setupFixture));
    aliceAddress = await alice.getAddress();
  });

  describe("Deployment & Initialization", () => {
    it("should expose correct immutables via proxy", async () => {
      expect(await relativePositionManager.COMPTROLLER()).to.equal(comptroller.address);
      expect(await relativePositionManager.LEVERAGE_MANAGER()).to.equal(leverageManager.address);
    });

    it("should revert when implementation is deployed with zero address for any constructor parameter", async () => {
      const RPMFactory = await ethers.getContractFactory("RelativePositionManager");
      await expect(
        RPMFactory.deploy(ethers.constants.AddressZero, leverageManager.address),
      ).to.be.revertedWithCustomError(RPMFactory, "ZeroAddress");
      await expect(RPMFactory.deploy(comptroller.address, ethers.constants.AddressZero)).to.be.revertedWithCustomError(
        RPMFactory,
        "ZeroAddress",
      );
    });

    it("should revert when PositionAccount implementation is not set before usage", async () => {
      const RPMFactory = await ethers.getContractFactory("RelativePositionManager");
      const rpm = await upgrades.deployProxy(RPMFactory, [accessControl.address], {
        constructorArgs: [comptroller.address, leverageManager.address],
        initializer: "initialize",
        unsafeAllow: ["state-variable-immutable"],
      });

      await expect(
        rpm.getPositionAccountAddress(
          await (await ethers.getSigners())[0].getAddress(),
          collateralMarket.address,
          borrowMarket.address,
        ),
      ).to.be.revertedWithCustomError(rpm, "PositionAccountImplementationNotSet");
    });

    it("should update PositionAccount implementation via governance-controlled setter", async () => {
      const oldImpl = await relativePositionManager.POSITION_ACCOUNT_IMPLEMENTATION();

      const PositionAccountFactory = await ethers.getContractFactory("PositionAccount");
      const newImpl = await PositionAccountFactory.deploy(
        comptroller.address,
        relativePositionManager.address,
        leverageManager.address,
      );

      await expect(relativePositionManager.connect(admin).setPositionAccountImplementation(newImpl.address))
        .to.emit(relativePositionManager, "PositionAccountImplementationUpdated")
        .withArgs(oldImpl, newImpl.address);

      expect(await relativePositionManager.POSITION_ACCOUNT_IMPLEMENTATION()).to.equal(newImpl.address);
    });
  });

  describe("addDSAVToken", () => {
    it("should add DSA vToken and emit event", async () => {
      expect(await relativePositionManager.getDSAVTokensCount()).to.equal(1);
      await expect(relativePositionManager.connect(admin).addDSAVToken(usdcMarket.address))
        .to.emit(relativePositionManager, "DSAVTokenAdded")
        .withArgs(usdcMarket.address, 1);
      expect(await relativePositionManager.getDSAVTokensCount()).to.equal(2);
    });

    it("should revert when adding zero address", async () => {
      await expect(
        relativePositionManager.connect(admin).addDSAVToken(ethers.constants.AddressZero),
      ).to.be.revertedWithCustomError(relativePositionManager, "ZeroAddress");
    });

    it("should revert when adding unlisted market", async () => {
      await expect(
        relativePositionManager.connect(admin).addDSAVToken(unlistedMarket.address),
      ).to.be.revertedWithCustomError(relativePositionManager, "AssetNotListed");
    });

    it("should revert when caller is not allowed by ACM", async () => {
      accessControl.isAllowedToCall.returns(false);
      await expect(relativePositionManager.connect(alice).addDSAVToken(usdcMarket.address)).to.be.reverted;
      accessControl.isAllowedToCall.returns(true);
    });

    it("should revert when adding vBNB market (VBNBNotSupported)", async () => {
      await expect(
        relativePositionManager.connect(admin).addDSAVToken(vBNBMarket.address),
      ).to.be.revertedWithCustomError(relativePositionManager, "VBNBNotSupported");
    });
  });

  describe("activatePosition", () => {
    it("should revert when longVToken is zero", async () => {
      await expect(
        relativePositionManager
          .connect(alice)
          .activatePosition(ethers.constants.AddressZero, borrowMarket.address, 0, 0, parseEther("2")),
      ).to.be.revertedWithCustomError(relativePositionManager, "ZeroAddress");
    });

    it("should revert when shortVToken is zero", async () => {
      await expect(
        relativePositionManager
          .connect(alice)
          .activatePosition(collateralMarket.address, ethers.constants.AddressZero, 0, 0, parseEther("2")),
      ).to.be.revertedWithCustomError(relativePositionManager, "ZeroAddress");
    });

    it("should revert when market is not listed", async () => {
      await expect(
        relativePositionManager
          .connect(alice)
          .activatePosition(unlistedMarket.address, borrowMarket.address, 0, 0, parseEther("2")),
      ).to.be.revertedWithCustomError(relativePositionManager, "AssetNotListed");
    });

    it("should revert when longVToken is vBNB (VBNBNotSupported)", async () => {
      await expect(
        relativePositionManager
          .connect(alice)
          .activatePosition(vBNBMarket.address, borrowMarket.address, 0, 0, parseEther("2")),
      ).to.be.revertedWithCustomError(relativePositionManager, "VBNBNotSupported");
    });

    it("should revert when shortVToken is vBNB (VBNBNotSupported)", async () => {
      await expect(
        relativePositionManager
          .connect(alice)
          .activatePosition(collateralMarket.address, vBNBMarket.address, 0, 0, parseEther("2")),
      ).to.be.revertedWithCustomError(relativePositionManager, "VBNBNotSupported");
    });

    it("should revert when effective leverage is below minimum", async () => {
      await expect(
        relativePositionManager
          .connect(alice)
          .activatePosition(collateralMarket.address, borrowMarket.address, 0, 0, parseEther("0.5")),
      ).to.be.revertedWithCustomError(relativePositionManager, "InvalidLeverage");
    });

    it("should revert when effective leverage is above maximum", async () => {
      await expect(
        relativePositionManager
          .connect(alice)
          .activatePosition(collateralMarket.address, borrowMarket.address, 0, 0, parseEther("11")),
      ).to.be.revertedWithCustomError(relativePositionManager, "InvalidLeverage");
    });

    it("should activate position and deploy position account", async () => {
      const predictedAccount = await relativePositionManager.getPositionAccountAddress(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      expect(predictedAccount).to.not.equal(ethers.constants.AddressZero);

      await expect(
        relativePositionManager
          .connect(alice)
          .activatePosition(collateralMarket.address, borrowMarket.address, 0, 0, parseEther("2")),
      )
        .to.emit(relativePositionManager, "PositionActivated")
        .to.emit(relativePositionManager, "PositionAccountDeployed")
        .withArgs(aliceAddress, collateralMarket.address, borrowMarket.address, predictedAccount);

      const position = await relativePositionManager.getPosition(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      expect(position.isActive).to.be.true;
      expect(position.effectiveLeverage).to.equal(parseEther("2"));
      expect(position.cycleId).to.equal(1);
      expect(position.positionAccount).to.not.equal(ethers.constants.AddressZero);
      expect(position.dsaIndex).to.equal(0);

      // Deployed position account should match the address predicted before activation
      expect(predictedAccount).to.equal(position.positionAccount);
    });

    it("should revert when activating the same position again", async () => {
      await relativePositionManager
        .connect(alice)
        .activatePosition(collateralMarket.address, borrowMarket.address, 0, 0, parseEther("2"));
      await expect(
        relativePositionManager
          .connect(alice)
          .activatePosition(collateralMarket.address, borrowMarket.address, 0, 0, parseEther("2")),
      ).to.be.revertedWithCustomError(relativePositionManager, "PositionAlreadyExists");
    });

    it("should activate with initial principal when user approves and supplies", async () => {
      const amount = parseEther("10");
      await dsaToken.connect(admin).transfer(aliceAddress, amount);
      await dsaToken.connect(alice).approve(relativePositionManager.address, amount);

      await relativePositionManager
        .connect(alice)
        .activatePosition(collateralMarket.address, borrowMarket.address, 0, amount, parseEther("2"));

      const position = await relativePositionManager.getPosition(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      expect(position.suppliedPrincipal).to.be.gt(0);
    });

    it("should reuse existing position account when reactivating a fully closed position", async () => {
      // First activation to deploy and activate position account (no principal yet)
      await relativePositionManager
        .connect(alice)
        .activatePosition(collateralMarket.address, borrowMarket.address, 0, 0, parseEther("2"));

      const positionAfterFirst = await relativePositionManager.getPosition(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      const firstAccount = positionAfterFirst.positionAccount;
      expect(firstAccount).to.not.equal(ethers.constants.AddressZero);

      // Deactivate: with no open long/short position and no principal, this simply deactivates the position
      await relativePositionManager.connect(alice).deactivatePosition(collateralMarket.address, borrowMarket.address);

      const positionAfterDeactivation = await relativePositionManager.getPosition(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      expect(positionAfterDeactivation.isActive).to.be.false;
      expect(positionAfterDeactivation.positionAccount).to.equal(firstAccount);

      // Reactivate with same DSA index and a principal; should reuse the same position account instead of deploying a new one
      const newPrincipal = parseEther("5");
      await dsaToken.connect(admin).transfer(aliceAddress, newPrincipal);
      await dsaToken.connect(alice).approve(relativePositionManager.address, newPrincipal);

      await relativePositionManager
        .connect(alice)
        .activatePosition(collateralMarket.address, borrowMarket.address, 0, newPrincipal, parseEther("2"));

      const positionAfterSecond = await relativePositionManager.getPosition(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      expect(positionAfterSecond.positionAccount).to.equal(firstAccount);
      expect(positionAfterSecond.cycleId).to.equal(2);
      expect(positionAfterSecond.isActive).to.be.true;
    });
  });

  describe("increasePrincipal", () => {
    beforeEach(async () => {
      await relativePositionManager
        .connect(alice)
        .activatePosition(collateralMarket.address, borrowMarket.address, 0, 0, parseEther("2"));
    });

    it("should revert when amount is zero", async () => {
      await expect(
        relativePositionManager.connect(alice).increasePrincipal(collateralMarket.address, borrowMarket.address, 0, 0),
      ).to.be.revertedWithCustomError(relativePositionManager, "ZeroAmount");
    });

    it("should revert when position is not active", async () => {
      const signers = await ethers.getSigners();
      const bob = signers[2];
      const bobAddress = await bob.getAddress();
      await dsaToken.connect(admin).transfer(bobAddress, parseEther("5"));
      await dsaToken.connect(bob).approve(relativePositionManager.address, parseEther("5"));
      await expect(
        relativePositionManager
          .connect(bob)
          .increasePrincipal(collateralMarket.address, borrowMarket.address, 0, parseEther("1")),
      ).to.be.revertedWithCustomError(relativePositionManager, "PositionNotActive");
    });

    it("should revert when dsaIndex does not match position", async () => {
      await dsaToken.connect(admin).transfer(aliceAddress, parseEther("5"));
      await dsaToken.connect(alice).approve(relativePositionManager.address, parseEther("5"));
      await relativePositionManager.connect(admin).addDSAVToken(usdcMarket.address);
      await expect(
        relativePositionManager
          .connect(alice)
          .increasePrincipal(collateralMarket.address, borrowMarket.address, 1, parseEther("1")),
      ).to.be.revertedWithCustomError(relativePositionManager, "InvalidDSA");
    });

    it("should increase principal and emit event", async () => {
      const amount = parseEther("5");
      await dsaToken.connect(admin).transfer(aliceAddress, amount);
      await dsaToken.connect(alice).approve(relativePositionManager.address, amount);

      const positionBefore = await relativePositionManager.getPosition(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      const vBalanceBefore = await dsaMarket.balanceOf(positionBefore.positionAccount);

      await expect(
        relativePositionManager
          .connect(alice)
          .increasePrincipal(collateralMarket.address, borrowMarket.address, 0, amount),
      ).to.emit(relativePositionManager, "PrincipalSupplied");

      const positionAfter = await relativePositionManager.getPosition(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      expect(positionAfter.suppliedPrincipal).to.be.gt(positionBefore.suppliedPrincipal);
      expect(positionAfter.positionAccount).to.equal(positionBefore.positionAccount);

      const vBalanceAfter = await dsaMarket.balanceOf(positionAfter.positionAccount);
      expect(vBalanceAfter).to.be.gt(vBalanceBefore);
      // Supplied principal in manager storage should exactly match the DSA vToken balance
      expect(positionAfter.suppliedPrincipal).to.equal(vBalanceAfter);
    });
  });

  describe("executePositionAccountCall", () => {
    let positionAccount: string;

    beforeEach(async () => {
      await relativePositionManager
        .connect(alice)
        .activatePosition(collateralMarket.address, borrowMarket.address, 0, 0, parseEther("2"));
      const position = await relativePositionManager.getPosition(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      positionAccount = position.positionAccount;
    });

    it("should revert when caller is not allowed by ACM", async () => {
      accessControl.isAllowedToCall.returns(false);
      await expect(
        relativePositionManager
          .connect(alice)
          .executePositionAccountCall(positionAccount, collateralToken.address, "0x"),
      ).to.be.reverted;
      accessControl.isAllowedToCall.returns(true);
    });

    it("should succeed when caller is allowed and emit GenericCallExecuted", async () => {
      const transferAmount = parseEther("1");
      await collateralToken.connect(admin).transfer(positionAccount, transferAmount);

      const approveData = collateralToken.interface.encodeFunctionData("approve", [aliceAddress, transferAmount]);
      await expect(
        relativePositionManager
          .connect(admin)
          .executePositionAccountCall(positionAccount, collateralToken.address, approveData),
      ).to.emit(relativePositionManager, "GenericCallExecuted");

      const transferData = collateralToken.interface.encodeFunctionData("transfer", [aliceAddress, transferAmount]);
      await expect(
        relativePositionManager
          .connect(admin)
          .executePositionAccountCall(positionAccount, collateralToken.address, transferData),
      ).to.emit(relativePositionManager, "GenericCallExecuted");

      expect(await collateralToken.balanceOf(aliceAddress)).to.equal(transferAmount);
    });
  });

  describe("openPosition", () => {
    const shortAmount = parseEther("1");
    const minLongAmount = parseEther("0.9");

    it("should revert when position is not active", async () => {
      const swapData = await createSwapMulticallData(
        swapHelper,
        collateralToken,
        leverageManager.address,
        parseEther("0"),
        ethers.utils.formatBytes32String("open-inactive"),
      );
      await expect(
        relativePositionManager
          .connect(alice)
          .openPosition(
            collateralMarket.address,
            borrowMarket.address,
            dsaIndex,
            noAdditionalPrincipal,
            shortAmount,
            minLongAmount,
            swapData,
          ),
      ).to.be.revertedWithCustomError(relativePositionManager, "PositionNotActive");
    });

    it("should revert when short amount is zero", async () => {
      await dsaToken.connect(admin).transfer(aliceAddress, parseEther("10"));
      await dsaToken.connect(alice).approve(relativePositionManager.address, parseEther("10"));
      await relativePositionManager
        .connect(alice)
        .activatePosition(collateralMarket.address, borrowMarket.address, 0, parseEther("10"), parseEther("2"));
      const swapData = await createSwapMulticallData(
        swapHelper,
        collateralToken,
        leverageManager.address,
        parseEther("0"),
        ethers.utils.formatBytes32String("open-zero"),
      );
      await expect(
        relativePositionManager
          .connect(alice)
          .openPosition(
            collateralMarket.address,
            borrowMarket.address,
            dsaIndex,
            noAdditionalPrincipal,
            0,
            minLongAmount,
            swapData,
          ),
      ).to.be.revertedWithCustomError(relativePositionManager, "ZeroBorrowAmount");
    });

    it("should revert when no principal and no additional principal", async () => {
      await relativePositionManager
        .connect(alice)
        .activatePosition(collateralMarket.address, borrowMarket.address, 0, 0, parseEther("2"));
      const swapData = await createSwapMulticallData(
        swapHelper,
        collateralToken,
        leverageManager.address,
        parseEther("0"),
        ethers.utils.formatBytes32String("open-no-principal"),
      );
      await expect(
        relativePositionManager
          .connect(alice)
          .openPosition(
            collateralMarket.address,
            borrowMarket.address,
            dsaIndex,
            noAdditionalPrincipal,
            shortAmount,
            minLongAmount,
            swapData,
          ),
      ).to.be.revertedWithCustomError(relativePositionManager, "InsufficientPrincipal");
    });

    it("should open position successfully when swap data sweeps long to LM", async () => {
      const principalAmount = parseEther("20");
      await dsaToken.connect(admin).transfer(aliceAddress, principalAmount);
      await dsaToken.connect(alice).approve(relativePositionManager.address, principalAmount);

      await relativePositionManager
        .connect(alice)
        .activatePosition(collateralMarket.address, borrowMarket.address, 0, principalAmount, parseEther("2"));

      const swapData = await createSwapMulticallData(
        swapHelper,
        collateralToken,
        leverageManager.address,
        shortAmount,
        ethers.utils.formatBytes32String("open-success"),
      );

      const openTx = await relativePositionManager
        .connect(alice)
        .openPosition(
          collateralMarket.address,
          borrowMarket.address,
          dsaIndex,
          noAdditionalPrincipal,
          shortAmount,
          minLongAmount,
          swapData,
        );
      await expect(openTx).to.emit(relativePositionManager, "PositionOpened");

      const positionAccountAddr = await relativePositionManager.getPositionAccountAddress(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );

      const longCollateral = await collateralMarket.callStatic.balanceOfUnderlying(positionAccountAddr);
      const dsaSupplied = await dsaMarket.callStatic.balanceOfUnderlying(positionAccountAddr);
      const borrowOpened = await borrowMarket.callStatic.borrowBalanceCurrent(positionAccountAddr);

      expect(longCollateral).to.be.gte(minLongAmount);
      expect(dsaSupplied).to.equal(principalAmount);
      expect(borrowOpened).to.equal(shortAmount);
    });
  });

  describe("closePosition", () => {
    it("should revert when position is not active", async () => {
      const exitSwapData = await createSwapMulticallData(
        swapHelper,
        borrowToken,
        leverageManager.address,
        parseEther("1"),
        ethers.utils.formatBytes32String("close-inactive"),
      );
      await expect(
        relativePositionManager
          .connect(alice)
          .closePosition(
            collateralMarket.address,
            borrowMarket.address,
            parseEther("0.5"),
            parseEther("1"),
            parseEther("0.9"),
            exitSwapData,
          ),
      ).to.be.revertedWithCustomError(relativePositionManager, "PositionNotActive");
    });

    it("should revert when borrowed amount to repay is zero", async () => {
      const principalAmount = parseEther("20");
      await dsaToken.connect(admin).transfer(aliceAddress, principalAmount);
      await dsaToken.connect(alice).approve(relativePositionManager.address, principalAmount);
      await relativePositionManager
        .connect(alice)
        .activatePosition(collateralMarket.address, borrowMarket.address, 0, principalAmount, parseEther("2"));
      const openSwapData = await createSwapMulticallData(
        swapHelper,
        collateralToken,
        leverageManager.address,
        parseEther("1"),
        ethers.utils.formatBytes32String("close-open"),
      );
      await relativePositionManager
        .connect(alice)
        .openPosition(
          collateralMarket.address,
          borrowMarket.address,
          dsaIndex,
          noAdditionalPrincipal,
          parseEther("1"),
          parseEther("0.9"),
          openSwapData,
        );

      const exitSwapData = await createSwapMulticallData(
        swapHelper,
        borrowToken,
        leverageManager.address,
        parseEther("1"),
        ethers.utils.formatBytes32String("close-exit-zero"),
      );
      await expect(
        relativePositionManager
          .connect(alice)
          .closePosition(
            collateralMarket.address,
            borrowMarket.address,
            parseEther("0.5"),
            0,
            parseEther("0.9"),
            exitSwapData,
          ),
      ).to.be.revertedWithCustomError(relativePositionManager, "ZeroFlashLoanAmount");
    });

    it("should partially close position (about half) when swap data sweeps short to LM", async () => {
      const principalAmount = parseEther("20");
      await dsaToken.connect(admin).transfer(aliceAddress, principalAmount);
      await dsaToken.connect(alice).approve(relativePositionManager.address, principalAmount);
      await relativePositionManager
        .connect(alice)
        .activatePosition(collateralMarket.address, borrowMarket.address, 0, principalAmount, parseEther("2"));
      const shortAmount = parseEther("1");
      const openSwapData = await createSwapMulticallData(
        swapHelper,
        collateralToken,
        leverageManager.address,
        shortAmount,
        ethers.utils.formatBytes32String("close-full-open"),
      );
      await relativePositionManager
        .connect(alice)
        .openPosition(
          collateralMarket.address,
          borrowMarket.address,
          dsaIndex,
          noAdditionalPrincipal,
          shortAmount,
          parseEther("0.9"),
          openSwapData,
        );

      const positionAccountAddr = await relativePositionManager.getPositionAccountAddress(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      const debtBefore = await borrowMarket.callStatic.borrowBalanceCurrent(positionAccountAddr);
      const longBefore = await collateralMarket.callStatic.balanceOfUnderlying(positionAccountAddr);

      // redeem more long than we actually repay (slippage / extra collateral buffer)
      const debtToRepay = debtBefore.mul(4).div(10); // repay ~40% of current debt
      const collateralToRedeem = longBefore.mul(5).div(10); // redeem ~50% of current long collateral

      await borrowToken.connect(admin).transfer(swapHelper.address, debtToRepay);
      const exitSwapData = await createSwapMulticallData(
        swapHelper,
        borrowToken,
        leverageManager.address,
        debtToRepay,
        ethers.utils.formatBytes32String("close-full-exit"),
      );

      const closeTx = await relativePositionManager
        .connect(alice)
        .closePosition(
          collateralMarket.address,
          borrowMarket.address,
          collateralToRedeem,
          debtToRepay,
          debtToRepay,
          exitSwapData,
        );
      await expect(closeTx).to.emit(relativePositionManager, "PositionClosed");
      const debtAfter = await borrowMarket.callStatic.borrowBalanceCurrent(positionAccountAddr);
      const longAfter = await collateralMarket.callStatic.balanceOfUnderlying(positionAccountAddr);

      // Position is partially closed: exact debt/long reduced by the amounts we specified
      expect(debtAfter).to.equal(debtBefore.sub(debtToRepay));
      expect(longAfter).to.equal(longBefore.sub(collateralToRedeem));
    });
  });

  describe("closeWithProfit", () => {
    it("should fully close with profit, dust to user, position closed", async () => {
      const principalAmount = parseEther("20");
      await dsaToken.connect(admin).transfer(aliceAddress, principalAmount);
      await dsaToken.connect(alice).approve(relativePositionManager.address, principalAmount);
      await relativePositionManager
        .connect(alice)
        .activatePosition(collateralMarket.address, borrowMarket.address, 0, principalAmount, parseEther("2"));

      // Open position with same oracle price (default 1:1) for all assets
      const shortAmount = parseEther("1");
      const minLongAmount = parseEther("0.9");
      const longReceivedAfterSwap = parseEther("0.95");

      const openSwapData = await createSwapMulticallData(
        swapHelper,
        collateralToken,
        leverageManager.address,
        longReceivedAfterSwap,
        ethers.utils.formatBytes32String("profit-open"),
        borrowToken, // tokenIn: opposite token — sweep any leftover borrow from SwapHelper
      );
      await relativePositionManager
        .connect(alice)
        .openPosition(
          collateralMarket.address,
          borrowMarket.address,
          dsaIndex,
          noAdditionalPrincipal,
          shortAmount,
          minLongAmount,
          openSwapData,
        );

      // After open: set oracle so long price = 2× short (longValueUSD > borrowValueUSD, profit scenario; round numbers for easier calc)
      resilientOracle.getUnderlyingPrice.whenCalledWith(collateralMarket.address).returns(parseUnits("2", 18));
      resilientOracle.getUnderlyingPrice.whenCalledWith(borrowMarket.address).returns(parseUnits("1", 18));
      resilientOracle.getUnderlyingPrice.whenCalledWith(dsaMarket.address).returns(parseUnits("1", 18));

      const positionAccountAddr = await relativePositionManager.getPositionAccountAddress(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );

      // create swapData for profit swap
      const SLIPPAGE_BPS = 500; // 5%
      const longPrice = parseUnits("2", 18);
      const dsaPrice = parseUnits("1", 18);

      // Minimum short we need to repay (exact borrow balance)
      const currentShortDebt = await borrowMarket.callStatic.borrowBalanceCurrent(positionAccountAddr);
      // Repay swap: we pass 2% more than minimum (extra = 2% of currentShortDebt), as with exact-in we typically gets more with swapHelper
      const repaySwapAmount = currentShortDebt.mul(102).div(100);

      // Long to redeem for repay: at price long=2, short=1, 1 short needs 0.5 long (theoretical); with 5% slippage ≈ 0.526, we use 0.53
      const collateralAmountToRedeemForRepay = parseEther("0.53");
      const excessLong = longReceivedAfterSwap.sub(collateralAmountToRedeemForRepay);

      const swapDataRepay = await createSwapMulticallData(
        swapHelper,
        borrowToken,
        leverageManager.address,
        repaySwapAmount,
        ethers.utils.formatBytes32String("profit-repay"),
        collateralToken, // tokenIn: long redeemed for repay is consumed by sweep to dead
      );

      // Profit swap: exact long to spend (excess). At new price long=2, DSA=1 → theoretical DSA out = excessLong * 2. We assume 5% slippage.
      const amountToRedeemForProfitSwap = excessLong;
      const theoreticalDsaOut = amountToRedeemForProfitSwap.mul(longPrice).div(dsaPrice);
      const minAmountOutProfit = theoreticalDsaOut.mul(10000 - SLIPPAGE_BPS).div(10000); // 5%

      const dsaOutActual = minAmountOutProfit.add(parseEther("0.01")); // little extra due to swap (to test dust)
      const swapDataProfit = await createSwapMulticallData(
        swapHelper,
        dsaToken,
        relativePositionManager.address,
        dsaOutActual,
        ethers.utils.formatBytes32String("profit-realize"),
        collateralToken, // tokenIn: long is consumed by sweep to dead so no side effects
      );

      const aliceDsaTokenBalanceBefore = await dsaToken.balanceOf(aliceAddress);
      const aliceBorrowTokenBalanceBefore = await borrowToken.balanceOf(aliceAddress);

      await expect(
        relativePositionManager
          .connect(alice)
          .closeWithProfit(
            collateralMarket.address,
            borrowMarket.address,
            collateralAmountToRedeemForRepay,
            swapDataRepay,
            currentShortDebt,
            amountToRedeemForProfitSwap,
            swapDataProfit,
            minAmountOutProfit,
          ),
      ).to.emit(relativePositionManager, "PositionClosedWithProfit");

      const aliceDsaTokenBalanceAfter = await dsaToken.balanceOf(aliceAddress);
      const aliceBorrowTokenBalanceAfter = await borrowToken.balanceOf(aliceAddress);

      // Repay: currentShortDebt was repaid; swap returned repaySwapAmount → user receives the remainder (2% extra)
      expect(aliceBorrowTokenBalanceAfter.sub(aliceBorrowTokenBalanceBefore)).to.equal(
        repaySwapAmount.sub(currentShortDebt),
      );

      // Profit swap: user receives only dsaOutActual from the swap
      expect(aliceDsaTokenBalanceAfter.sub(aliceDsaTokenBalanceBefore)).to.equal(dsaOutActual);

      const position = await relativePositionManager.getPosition(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      expect(position.isActive).to.be.false;
      const debtAfter = await borrowMarket.callStatic.borrowBalanceCurrent(positionAccountAddr);
      const longAfter = await collateralMarket.callStatic.balanceOfUnderlying(positionAccountAddr);
      expect(debtAfter).to.equal(0);
      expect(longAfter).to.equal(0);
    });
  });

  describe("closeWithLoss", () => {
    it("should fully close with loss: dust to user, position closed", async () => {
      const principalAmount = parseEther("20");
      await dsaToken.connect(admin).transfer(aliceAddress, principalAmount);
      await dsaToken.connect(alice).approve(relativePositionManager.address, principalAmount);
      await relativePositionManager
        .connect(alice)
        .activatePosition(collateralMarket.address, borrowMarket.address, 0, principalAmount, parseEther("2"));

      // Open position with same oracle price (default 1:1) for all assets
      const shortAmount = parseEther("1");
      const longSuppliedToOpen = parseEther("0.9");
      const minLongAmount = parseEther("0.8");
      const openSwapData = await createSwapMulticallData(
        swapHelper,
        collateralToken,
        leverageManager.address,
        longSuppliedToOpen,
        ethers.utils.formatBytes32String("loss-open"),
        borrowToken, // tokenIn: borrow token is consumed by sweep to dead
      );
      await relativePositionManager
        .connect(alice)
        .openPosition(
          collateralMarket.address,
          borrowMarket.address,
          dsaIndex,
          noAdditionalPrincipal,
          shortAmount,
          minLongAmount,
          openSwapData,
        );

      // After open: set oracle so long price < short price → borrowValueUSD > longValueUSD (loss scenario)
      resilientOracle.getUnderlyingPrice.whenCalledWith(collateralMarket.address).returns(parseUnits("0.8", 18));
      resilientOracle.getUnderlyingPrice.whenCalledWith(borrowMarket.address).returns(parseUnits("1", 18));
      resilientOracle.getUnderlyingPrice.whenCalledWith(dsaMarket.address).returns(parseUnits("1", 18));

      const positionAccountAddr = await relativePositionManager.getPositionAccountAddress(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      const currentShortDebt = await borrowMarket.callStatic.borrowBalanceCurrent(positionAccountAddr);
      const currentLongBalance = await collateralMarket.callStatic.balanceOfUnderlying(positionAccountAddr);

      // First swap: redeem part of current long (e.g. only what is "used" in swap); remaining long is transferred to user as dust
      const longPrice = parseUnits("0.8", 18);
      const shortPrice = parseUnits("1", 18);
      const SLIPPAGE_BPS = 500; // 5%
      const LONG_PCT_FOR_FIRST_SWAP = 95; // use 95% of long in first swap, 5% remains as collateral dust to user
      const longAmountToRedeemForFirstSwap = currentLongBalance.mul(LONG_PCT_FOR_FIRST_SWAP).div(100);
      const remainingLongDust = currentLongBalance.sub(longAmountToRedeemForFirstSwap);

      const theoreticalShortFromLong = longAmountToRedeemForFirstSwap.mul(longPrice).div(shortPrice);
      const shortFromLongAfterSlippage = theoreticalShortFromLong.mul(10000 - SLIPPAGE_BPS).div(10000);

      expect(shortFromLongAfterSlippage).to.be.lt(currentShortDebt); // loss case: long can't cover full debt

      const borrowedAmountToRepayFirst = shortFromLongAfterSlippage;
      const remainingDebt = currentShortDebt.sub(borrowedAmountToRepayFirst); // rest repaid by DSA in second swap
      const minAmountOutFirst = borrowedAmountToRepayFirst;
      const repayFirstSwapAmount = borrowedAmountToRepayFirst.mul(102).div(100); // 2% buffer for fees/slippage
      const repaySecondSwapAmount = remainingDebt.mul(102).div(100); // 2% buffer for second swap

      const swapDataFirst = await createSwapMulticallData(
        swapHelper,
        borrowToken,
        leverageManager.address,
        repayFirstSwapAmount,
        ethers.utils.formatBytes32String("loss-first"),
        collateralToken, // tokenIn: long redeemed for first repay is consumed by sweep to dead
        repayFirstSwapAmount, // sweep exact amount so second swap's borrowToken stays on SwapHelper
      );

      const swapDataSecond = await createSwapMulticallData(
        swapHelper,
        borrowToken,
        leverageManager.address,
        repaySecondSwapAmount,
        ethers.utils.formatBytes32String("loss-second"),
        dsaToken, // tokenIn: DSA redeemed for second repay is consumed by sweep to dead
      );

      const minAmountOutSecond = remainingDebt;
      // Second swap DSA → short: at oracle price (dsa=1, short=1) we need remainingDebt of DSA; with 5% slippage redeem more so output ≥ remainingDebt
      const dsaPrice = parseUnits("1", 18);
      const theoreticalDsaForRemainingDebt = remainingDebt.mul(shortPrice).div(dsaPrice);
      const dsaAmountToRedeemForRepay = theoreticalDsaForRemainingDebt.mul(10000).div(10000 - SLIPPAGE_BPS);

      const aliceCollateralBalanceBefore = await collateralToken.balanceOf(aliceAddress);
      const aliceBorrowTokenBalanceBefore = await borrowToken.balanceOf(aliceAddress);

      await expect(
        relativePositionManager
          .connect(alice)
          .closeWithLoss(
            collateralMarket.address,
            borrowMarket.address,
            borrowedAmountToRepayFirst,
            longAmountToRedeemForFirstSwap,
            minAmountOutFirst,
            swapDataFirst,
            dsaAmountToRedeemForRepay,
            minAmountOutSecond,
            swapDataSecond,
          ),
      ).to.emit(relativePositionManager, "PositionClosedWithLoss");

      const aliceCollateralBalanceAfter = await collateralToken.balanceOf(aliceAddress);
      const aliceBorrowTokenBalanceAfter = await borrowToken.balanceOf(aliceAddress);

      // First swap: only longAmountToRedeemForFirstSwap was redeemed; remaining long is transferred to user as dust
      expect(aliceCollateralBalanceAfter.sub(aliceCollateralBalanceBefore)).to.equal(remainingLongDust);

      // Borrow token dust: first swap returns (repayFirstSwapAmount - borrowedAmountToRepayFirst); second returns (repaySecondSwapAmount - remainingDebt)
      const borrowDustFromFirstSwap = repayFirstSwapAmount.sub(borrowedAmountToRepayFirst);
      const borrowDustFromSecondSwap = repaySecondSwapAmount.sub(remainingDebt);
      expect(aliceBorrowTokenBalanceAfter.sub(aliceBorrowTokenBalanceBefore)).to.equal(
        borrowDustFromFirstSwap.add(borrowDustFromSecondSwap),
      );

      const position = await relativePositionManager.getPosition(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      expect(position.isActive).to.be.false;
      const debtAfter = await borrowMarket.callStatic.borrowBalanceCurrent(positionAccountAddr);
      const longAfter = await collateralMarket.callStatic.balanceOfUnderlying(positionAccountAddr);
      expect(debtAfter).to.equal(0);
      expect(longAfter).to.equal(0);
    });
  });

  describe("DSA market used as long market (USDT): longVToken == dsaMarket", () => {
    it("openPosition: should increase suppliedPrincipal when additionalPrincipal is provided", async () => {
      const initialPrincipal = parseEther("20");
      const additionalPrincipal = parseEther("5");
      const totalPrincipal = initialPrincipal.add(additionalPrincipal);
      await dsaToken.connect(admin).transfer(aliceAddress, totalPrincipal);
      await dsaToken.connect(alice).approve(relativePositionManager.address, totalPrincipal);

      await relativePositionManager
        .connect(alice)
        .activatePosition(dsaMarket.address, borrowMarket.address, dsaIndex, initialPrincipal, parseEther("2"));

      const positionAfterActivate = await relativePositionManager.getPosition(
        aliceAddress,
        dsaMarket.address,
        borrowMarket.address,
      );
      const positionAccountAddr = positionAfterActivate.positionAccount;
      const principalVTokensBeforeOpen = positionAfterActivate.suppliedPrincipal;

      const shortAmount = parseEther("1");
      const minLongAmount = parseEther("0.9");
      const longReceivedAfterSwap = parseEther("0.95");
      const openSwapData = await createSwapMulticallData(
        swapHelper,
        dsaToken,
        leverageManager.address,
        longReceivedAfterSwap,
        ethers.utils.formatBytes32String("usdt-open-principal"),
        borrowToken,
      );

      await relativePositionManager
        .connect(alice)
        .openPosition(
          dsaMarket.address,
          borrowMarket.address,
          dsaIndex,
          additionalPrincipal,
          shortAmount,
          minLongAmount,
          openSwapData,
        );

      const positionAfterOpen = await relativePositionManager.getPosition(
        aliceAddress,
        dsaMarket.address,
        borrowMarket.address,
      );
      // vToken principal should increase
      expect(positionAfterOpen.suppliedPrincipal).to.be.gt(principalVTokensBeforeOpen);

      // Underlying: split total underlying into principal part and long (leveraged) part
      const underlyingAfterOpen = await dsaMarket.callStatic.balanceOfUnderlying(positionAccountAddr);
      const principalUnderlyingAfter = underlyingAfterOpen.sub(longReceivedAfterSwap);
      expect(principalUnderlyingAfter).to.equal(totalPrincipal);
    });

    it("closePosition (partial): should reduce debt/long while keeping suppliedPrincipal vTokens unchanged", async () => {
      const principalAmount = parseEther("20");
      await dsaToken.connect(admin).transfer(aliceAddress, principalAmount);
      await dsaToken.connect(alice).approve(relativePositionManager.address, principalAmount);
      await relativePositionManager
        .connect(alice)
        .activatePosition(dsaMarket.address, borrowMarket.address, dsaIndex, principalAmount, parseEther("2"));

      const shortAmount = parseEther("1");
      const minLongAmount = parseEther("0.9");
      const longReceivedAfterSwap = parseEther("0.95");
      const openSwapData = await createSwapMulticallData(
        swapHelper,
        dsaToken,
        leverageManager.address,
        longReceivedAfterSwap,
        ethers.utils.formatBytes32String("usdt-same-market-partial-open"),
        borrowToken,
      );
      await relativePositionManager
        .connect(alice)
        .openPosition(
          dsaMarket.address,
          borrowMarket.address,
          dsaIndex,
          noAdditionalPrincipal,
          shortAmount,
          minLongAmount,
          openSwapData,
        );

      const positionAccountAddr = await relativePositionManager.getPositionAccountAddress(
        aliceAddress,
        dsaMarket.address,
        borrowMarket.address,
      );

      const positionBefore = await relativePositionManager.getPosition(
        aliceAddress,
        dsaMarket.address,
        borrowMarket.address,
      );
      const principalVTokensBefore = positionBefore.suppliedPrincipal;
      const debtBefore = await borrowMarket.callStatic.borrowBalanceCurrent(positionAccountAddr);
      const longBefore = await dsaMarket.callStatic.balanceOfUnderlying(positionAccountAddr);

      const debtToRepay = debtBefore.mul(4).div(10);
      const collateralToRedeem = longBefore.mul(5).div(10);
      const exitSwapData = await createSwapMulticallData(
        swapHelper,
        borrowToken,
        leverageManager.address,
        debtToRepay,
        ethers.utils.formatBytes32String("usdt-same-market-partial-exit"),
      );

      await relativePositionManager
        .connect(alice)
        .closePosition(
          dsaMarket.address,
          borrowMarket.address,
          collateralToRedeem,
          debtToRepay,
          debtToRepay,
          exitSwapData,
        );

      const positionAfter = await relativePositionManager.getPosition(
        aliceAddress,
        dsaMarket.address,
        borrowMarket.address,
      );
      expect(positionAfter.suppliedPrincipal).to.equal(principalVTokensBefore);

      const debtAfter = await borrowMarket.callStatic.borrowBalanceCurrent(positionAccountAddr);
      const longAfter = await dsaMarket.callStatic.balanceOfUnderlying(positionAccountAddr);
      expect(debtAfter).to.be.lt(debtBefore);
      expect(longAfter).to.be.lt(longBefore);
    });

    it("closeWithProfit: should close fully and keep suppliedPrincipal vTokens unchanged (profit realized in same underlying)", async () => {
      const principalAmount = parseEther("20");
      await dsaToken.connect(admin).transfer(aliceAddress, principalAmount);
      await dsaToken.connect(alice).approve(relativePositionManager.address, principalAmount);
      await relativePositionManager
        .connect(alice)
        .activatePosition(dsaMarket.address, borrowMarket.address, dsaIndex, principalAmount, parseEther("2"));

      const shortAmount = parseEther("1");
      const minLongAmount = parseEther("0.9");
      const longReceivedAfterSwap = parseEther("0.95");
      const openSwapData = await createSwapMulticallData(
        swapHelper,
        dsaToken,
        leverageManager.address,
        longReceivedAfterSwap,
        ethers.utils.formatBytes32String("usdt-same-market-profit-open"),
        borrowToken,
      );
      await relativePositionManager
        .connect(alice)
        .openPosition(
          dsaMarket.address,
          borrowMarket.address,
          dsaIndex,
          noAdditionalPrincipal,
          shortAmount,
          minLongAmount,
          openSwapData,
        );

      resilientOracle.getUnderlyingPrice.whenCalledWith(dsaMarket.address).returns(parseUnits("2", 18));
      resilientOracle.getUnderlyingPrice.whenCalledWith(borrowMarket.address).returns(parseUnits("1", 18));

      const positionAccountAddr = await relativePositionManager.getPositionAccountAddress(
        aliceAddress,
        dsaMarket.address,
        borrowMarket.address,
      );
      const positionBefore = await relativePositionManager.getPosition(
        aliceAddress,
        dsaMarket.address,
        borrowMarket.address,
      );
      const principalVTokensBefore = positionBefore.suppliedPrincipal;

      // Repay leg: at oracle price long=2, short=1, repaying full short debt requires
      // theoreticalLongForRepay = currentShortDebt * (shortPrice / longPrice) = debt * 0.5 long.
      // With 5% buffer we redeem slightly more long and also send 2% extra short through the swap helper
      // so there is dust that can be returned to the user.
      const currentShortDebt = await borrowMarket.callStatic.borrowBalanceCurrent(positionAccountAddr);
      const longPrice = parseUnits("2", 18);
      const shortPrice = parseUnits("1", 18);
      const SLIPPAGE_BPS = 500; // 5%
      const theoreticalLongForRepay = currentShortDebt.mul(shortPrice).div(longPrice); // debt * 0.5
      const collateralAmountToRedeemForRepay = theoreticalLongForRepay.mul(10000 + SLIPPAGE_BPS).div(10000); // +5% buffer
      const repaySwapAmount = currentShortDebt.mul(102).div(100); // 2% extra short to model exact-in swap behavior
      const swapDataRepay = await createSwapMulticallData(
        swapHelper,
        borrowToken,
        leverageManager.address,
        repaySwapAmount,
        ethers.utils.formatBytes32String("usdt-same-market-profit-repay"),
        dsaToken,
      );

      // Profit leg: use RPM's own view of long collateral (excluding principal when long and DSA share a market),
      // then subtract the long reserved for the repay leg. The remainder is the excess long available for profit.
      const longOnlyUnderlying = await relativePositionManager.callStatic.getLongCollateralBalance(
        aliceAddress,
        dsaMarket.address,
        borrowMarket.address,
      );
      const amountToRedeemForProfitSwap = longOnlyUnderlying.sub(collateralAmountToRedeemForRepay);
      // For same-market profit test we don't enforce a minimum DSA out; the primary goal is to
      // exercise the code path and verify principal/position accounting when long and DSA share a market.
      const minAmountOutProfit = amountToRedeemForProfitSwap;
      // Profit leg: when long and DSA share the same market, the contract now skips the swap path entirely
      // (handled inside _realizeProfitFromExcessLong), so we can pass empty calldata here.
      const swapDataProfit = "0x";

      await expect(
        relativePositionManager
          .connect(alice)
          .closeWithProfit(
            dsaMarket.address,
            borrowMarket.address,
            collateralAmountToRedeemForRepay,
            swapDataRepay,
            currentShortDebt,
            amountToRedeemForProfitSwap,
            swapDataProfit,
            minAmountOutProfit,
          ),
      ).to.emit(relativePositionManager, "PositionClosedWithProfit");

      const positionAfter = await relativePositionManager.getPosition(
        aliceAddress,
        dsaMarket.address,
        borrowMarket.address,
      );
      expect(positionAfter.isActive).to.be.false;
      expect(positionAfter.suppliedPrincipal).to.equal(principalVTokensBefore);
      expect(await borrowMarket.callStatic.borrowBalanceCurrent(positionAccountAddr)).to.equal(0);
      // Long market == DSA market: after closing, only principal vTokens should remain
      expect(await dsaMarket.balanceOf(positionAccountAddr)).to.equal(principalVTokensBefore);
    });

    it("closeWithLoss: should close fully; second exit uses same market as DSA/long and reduces principal vTokens", async () => {
      const principalAmount = parseEther("20");
      await dsaToken.connect(admin).transfer(aliceAddress, principalAmount);
      await dsaToken.connect(alice).approve(relativePositionManager.address, principalAmount);
      await relativePositionManager
        .connect(alice)
        .activatePosition(dsaMarket.address, borrowMarket.address, dsaIndex, principalAmount, parseEther("2"));

      const shortAmount = parseEther("1");
      const minLongAmount = parseEther("0.8");
      const longSuppliedToOpen = parseEther("0.9");
      const openSwapData = await createSwapMulticallData(
        swapHelper,
        dsaToken,
        leverageManager.address,
        longSuppliedToOpen,
        ethers.utils.formatBytes32String("usdt-same-market-loss-open"),
        borrowToken,
      );
      await relativePositionManager
        .connect(alice)
        .openPosition(
          dsaMarket.address,
          borrowMarket.address,
          dsaIndex,
          noAdditionalPrincipal,
          shortAmount,
          minLongAmount,
          openSwapData,
        );

      // Make this a loss scenario by dropping long/DSA price after open:
      // use long/DSA price = 0.8 and short price = 1 so longValueUSD < shortDebtUSD.
      resilientOracle.getUnderlyingPrice.whenCalledWith(dsaMarket.address).returns(parseUnits("0.8", 18));
      resilientOracle.getUnderlyingPrice.whenCalledWith(borrowMarket.address).returns(parseUnits("1", 18));

      const positionAccountAddr = await relativePositionManager.getPositionAccountAddress(
        aliceAddress,
        dsaMarket.address,
        borrowMarket.address,
      );
      const currentShortDebt = await borrowMarket.callStatic.borrowBalanceCurrent(positionAccountAddr);

      const SLIPPAGE_BPS = 500; // 5%
      // First exit (exact-in semantics): redeem ALL current long collateral (excluding principal) and spend it as tokenIn.
      // We use RPM's own view of long collateral so principal is not accidentally counted as long.
      const longOnlyUnderlying = await relativePositionManager.callStatic.getLongCollateralBalance(
        aliceAddress,
        dsaMarket.address,
        borrowMarket.address,
      );
      const longAmountToRedeemForFirstSwap = longOnlyUnderlying;
      const longPrice = parseUnits("0.8", 18);
      const shortPrice = parseUnits("1", 18);
      const theoreticalShortFromLong = longAmountToRedeemForFirstSwap.mul(longPrice).div(shortPrice);
      const borrowedAmountToRepayFirst = theoreticalShortFromLong.mul(10000 - SLIPPAGE_BPS).div(10000);
      const remainingDebt = currentShortDebt.sub(borrowedAmountToRepayFirst);

      const repayFirstSwapAmount = borrowedAmountToRepayFirst.mul(102).div(100); // 2% extra to model exact-in behavior
      const repaySecondSwapAmount = remainingDebt.mul(102).div(100);
      const swapDataFirst = await createSwapMulticallData(
        swapHelper,
        borrowToken,
        leverageManager.address,
        repayFirstSwapAmount,
        ethers.utils.formatBytes32String("usdt-same-market-loss-first"),
        dsaToken,
        repayFirstSwapAmount,
      );
      const swapDataSecond = await createSwapMulticallData(
        swapHelper,
        borrowToken,
        leverageManager.address,
        repaySecondSwapAmount,
        ethers.utils.formatBytes32String("usdt-same-market-loss-second"),
        dsaToken,
      );

      const positionBefore = await relativePositionManager.getPosition(
        aliceAddress,
        dsaMarket.address,
        borrowMarket.address,
      );
      const principalVTokensBefore = positionBefore.suppliedPrincipal;

      const minAmountOutFirst = borrowedAmountToRepayFirst;
      const minAmountOutSecond = remainingDebt;
      // For same-market loss test we keep the DSA leg simple: redeem exactly the remaining short debt worth of DSA
      // (prices DSA=1, short=1), without additional buffer. This keeps the amount positive and easy to reason about.
      const dsaAmountToRedeemForRepay = remainingDebt;

      await expect(
        relativePositionManager
          .connect(alice)
          .closeWithLoss(
            dsaMarket.address,
            borrowMarket.address,
            borrowedAmountToRepayFirst,
            longAmountToRedeemForFirstSwap,
            minAmountOutFirst,
            swapDataFirst,
            dsaAmountToRedeemForRepay,
            minAmountOutSecond,
            swapDataSecond,
          ),
      ).to.emit(relativePositionManager, "PositionClosedWithLoss");

      const positionAfter = await relativePositionManager.getPosition(
        aliceAddress,
        dsaMarket.address,
        borrowMarket.address,
      );
      expect(positionAfter.isActive).to.be.false;
      expect(await borrowMarket.callStatic.borrowBalanceCurrent(positionAccountAddr)).to.equal(0);
      // closeWithLoss updates suppliedPrincipal to the remaining DSA vToken balance after using DSA to repay
      expect(positionAfter.suppliedPrincipal).to.be.lt(principalVTokensBefore);
      expect(await dsaMarket.balanceOf(positionAccountAddr)).to.equal(positionAfter.suppliedPrincipal);
    });
  });

  describe("getUtilizationInfo and calculateMaxBorrow", () => {
    it("should return utilization info for active position with principal", async () => {
      const principalAmount = parseEther("10");
      await dsaToken.connect(admin).transfer(aliceAddress, principalAmount);
      await dsaToken.connect(alice).approve(relativePositionManager.address, principalAmount);
      await relativePositionManager
        .connect(alice)
        .activatePosition(collateralMarket.address, borrowMarket.address, 0, principalAmount, parseEther("2"));
      const utilization = await relativePositionManager.callStatic.getUtilizationInfo(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
        dsaMarket.address,
      );
      // With no long/short and only principal supplied:
      // - The full principal (10) is withdrawable, because there is no borrow against it yet.
      // - Only the portion allowed by the DSA collateral factor (e.g. 80%) is counted as available capital (8),
      //   since this is the amount that can be used as backing for new borrow.
      expect(utilization.availableCapitalUSD).to.equal(parseEther("8"));
      expect(utilization.withdrawableAmount).to.equal(parseEther("10"));
    });

    it("should return max borrow for active position with principal", async () => {
      const principalAmount = parseEther("10");
      await dsaToken.connect(admin).transfer(aliceAddress, principalAmount);
      await dsaToken.connect(alice).approve(relativePositionManager.address, principalAmount);
      await relativePositionManager
        .connect(alice)
        .activatePosition(collateralMarket.address, borrowMarket.address, 0, principalAmount, parseEther("2"));
      const maxBorrow = await relativePositionManager.callStatic.calculateMaxBorrow(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
        dsaMarket.address,
      );
      // Max borrow is derived from available capital and the configured effective leverage.
      // With available capital 8 (principal 10 constrained by collateral factor) and effectiveLeverage = 2,
      // this evaluates to 16 when oracle prices are 1.
      expect(maxBorrow).to.equal(parseEther("16"));
    });
  });

  describe("withdrawPrincipal", () => {
    it("should revert when position is active and amount exceeds withdrawable", async () => {
      await relativePositionManager
        .connect(alice)
        .activatePosition(collateralMarket.address, borrowMarket.address, 0, 0, parseEther("2"));
      await expect(
        relativePositionManager
          .connect(alice)
          .withdrawPrincipal(collateralMarket.address, borrowMarket.address, parseEther("1000")),
      ).to.be.revertedWithCustomError(relativePositionManager, "InsufficientWithdrawableAmount");
    });

    it("should withdraw principal when position is active and amount is withdrawable", async () => {
      const principalAmount = parseEther("20");
      await dsaToken.connect(admin).transfer(aliceAddress, principalAmount);
      await dsaToken.connect(alice).approve(relativePositionManager.address, principalAmount);
      await relativePositionManager
        .connect(alice)
        .activatePosition(collateralMarket.address, borrowMarket.address, 0, principalAmount, parseEther("2"));
      const withdrawAmount = parseEther("5");
      const balanceBefore = await dsaToken.balanceOf(aliceAddress);
      await expect(
        relativePositionManager
          .connect(alice)
          .withdrawPrincipal(collateralMarket.address, borrowMarket.address, withdrawAmount),
      ).to.emit(relativePositionManager, "PrincipalWithdrawn");
      const balanceAfter = await dsaToken.balanceOf(aliceAddress);
      expect(balanceAfter.sub(balanceBefore)).to.equal(withdrawAmount);
    });
  });

  describe("deactivatePosition", () => {
    it("should revert when position is not active", async () => {
      await expect(
        relativePositionManager.connect(alice).deactivatePosition(collateralMarket.address, borrowMarket.address),
      ).to.be.revertedWithCustomError(relativePositionManager, "PositionNotActive");
    });

    it("should revert when position is active but not fully closed", async () => {
      const principalAmount = parseEther("20");
      const shortAmount = parseEther("1");
      const minLongAmount = parseEther("0.9");

      await dsaToken.connect(admin).transfer(aliceAddress, principalAmount);
      await dsaToken.connect(alice).approve(relativePositionManager.address, principalAmount);

      await relativePositionManager
        .connect(alice)
        .activatePosition(collateralMarket.address, borrowMarket.address, 0, principalAmount, parseEther("2"));

      const openSwapData = await createSwapMulticallData(
        swapHelper,
        collateralToken,
        leverageManager.address,
        shortAmount,
        ethers.utils.formatBytes32String("deactivate-not-fully-closed"),
      );

      await relativePositionManager
        .connect(alice)
        .openPosition(
          collateralMarket.address,
          borrowMarket.address,
          dsaIndex,
          noAdditionalPrincipal,
          shortAmount,
          minLongAmount,
          openSwapData,
        );

      await expect(
        relativePositionManager.connect(alice).deactivatePosition(collateralMarket.address, borrowMarket.address),
      ).to.be.revertedWithCustomError(relativePositionManager, "PositionNotFullyClosed");
    });

    it("should succeed when position is active with no open collateral or debt", async () => {
      await relativePositionManager
        .connect(alice)
        .activatePosition(collateralMarket.address, borrowMarket.address, 0, 0, parseEther("2"));
      await expect(
        relativePositionManager.connect(alice).deactivatePosition(collateralMarket.address, borrowMarket.address),
      ).to.emit(relativePositionManager, "PositionDeactivated");

      const position = await relativePositionManager.getPosition(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      expect(position.isActive).to.be.false;
    });
  });
});
