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

/** Creates swap multicall that sweeps token to recipient; signer must be SwapHelper's backendSigner. */
async function createSwapMulticallData(
  swapHelper: SwapHelper,
  token: EIP20Interface,
  recipient: string,
  amount: BigNumber,
  signer: Wallet,
  salt: string,
): Promise<string> {
  if (amount.gt(0)) {
    await token.transfer(swapHelper.address, amount);
  }
  const sweepData = swapHelper.interface.encodeFunctionData("sweep", [token.address, recipient]);
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
  const deadline = "17627727131762772187";
  const saltValue = salt || ethers.utils.formatBytes32String(Math.random().toString());
  const signature = await signer._signTypedData(domain, types, {
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

  beforeEach(async () => {
    [admin, alice] = await ethers.getSigners();
    ({
      relativePositionManager,
      comptroller,
      leverageManager,
      swapHelper,
      accessControl,
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
    let position: Awaited<ReturnType<RelativePositionManager["getPosition"]>>;

    beforeEach(async () => {
      await relativePositionManager
        .connect(alice)
        .activatePosition(collateralMarket.address, borrowMarket.address, 0, 0, parseEther("2"));
      position = await relativePositionManager.getPosition(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
    });

    it("should revert when caller is not allowed by ACM", async () => {
      accessControl.isAllowedToCall.returns(false);
      await expect(
        relativePositionManager
          .connect(alice)
          .executePositionAccountCall(position.positionAccount, collateralToken.address, "0x"),
      ).to.be.reverted;
      accessControl.isAllowedToCall.returns(true);
    });

    it("should succeed when caller is allowed and emit GenericCallExecuted", async () => {
      const transferAmount = parseEther("1");
      await collateralToken.connect(admin).transfer(position.positionAccount, transferAmount);

      const approveData = collateralToken.interface.encodeFunctionData("approve", [aliceAddress, transferAmount]);
      await expect(
        relativePositionManager
          .connect(admin)
          .executePositionAccountCall(position.positionAccount, collateralToken.address, approveData),
      ).to.emit(relativePositionManager, "GenericCallExecuted");

      const transferData = collateralToken.interface.encodeFunctionData("transfer", [aliceAddress, transferAmount]);
      await expect(
        relativePositionManager
          .connect(admin)
          .executePositionAccountCall(position.positionAccount, collateralToken.address, transferData),
      ).to.emit(relativePositionManager, "GenericCallExecuted");

      expect(await collateralToken.balanceOf(aliceAddress)).to.equal(transferAmount);
    });
  });
});
