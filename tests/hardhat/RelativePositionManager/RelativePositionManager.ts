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

  // Set collateral factor for markets so getUtilizationInfo does not divide by zero (actualCapitalUtilized uses dsaLTV/longLTV)
  const collateralFactorMantissa = parseEther("0.8");
  const liquidationThresholdMantissa = parseEther("0.85");
  await comptroller["setCollateralFactor(address,uint256,uint256)"](
    collateralMarket.address,
    collateralFactorMantissa,
    liquidationThresholdMantissa,
  );
  await comptroller["setCollateralFactor(address,uint256,uint256)"](
    borrowMarket.address,
    collateralFactorMantissa,
    liquidationThresholdMantissa,
  );
  await comptroller["setCollateralFactor(address,uint256,uint256)"](
    dsaMarket.address,
    collateralFactorMantissa,
    liquidationThresholdMantissa,
  );

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
 * Creates a "fake swap" multicall based only on transfers and sweeps.
 *
 * Flow:
 * - The test first transfers `amount` of `token` to `swapHelper`.
 * - This helper then builds a multicall that:
 *   - Optionally sweeps `tokenIn` from `swapHelper` to the dead address, so any amount
 *     sent by the Leverage Manager is burned instead of remaining on `swapHelper`.
 *   - Sweeps the full balance of `token` from `swapHelper` to `recipient`
 *     (typically the Leverage Manager).
 *
 * This avoids using a real AMM swap while still exercising the RPM / LM integration
 * and prevents side effects from any pre‑existing balances on `swapHelper`.
 */
async function createSwapMulticallData(
  swapHelper: SwapHelper,
  token: EIP20Interface,
  recipient: string,
  amount: BigNumber,
  salt: string,
  tokenIn?: EIP20Interface,
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
  // Use a genericCall to perform an exact transfer of `amount` of `token` from
  // SwapHelper to the recipient. This avoids depending on whatever residual
  // balance is on SwapHelper and makes the effective "swap output" predictable.
  const transferData = token.interface.encodeFunctionData("transfer", [recipient, amount]);
  calls.push(swapHelper.interface.encodeFunctionData("genericCall", [token.address, transferData]));
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

  const BPS_BASE = 100;
  const BPS_50_PCT = 50;
  const BPS_90_PCT = 90;
  const BPS_95_PCT = 95;
  const BPS_100_PCT = 100;

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

  describe("pause", () => {
    it("should block state-changing user operations when paused", async () => {
      await relativePositionManager.connect(admin).pause();

      await expect(
        relativePositionManager
          .connect(alice)
          .activatePosition(collateralMarket.address, borrowMarket.address, 0, 0, parseEther("2")),
      ).to.be.revertedWith("Pausable: paused");

      await expect(
        relativePositionManager
          .connect(alice)
          .supplyPrincipal(collateralMarket.address, borrowMarket.address, parseEther("1")),
      ).to.be.revertedWith("Pausable: paused");

      await expect(
        relativePositionManager
          .connect(alice)
          .openPosition(
            collateralMarket.address,
            borrowMarket.address,
            noAdditionalPrincipal,
            parseEther("1"),
            0,
            "0x",
          ),
      ).to.be.revertedWith("Pausable: paused");

      await expect(
        relativePositionManager
          .connect(alice)
          .closeWithProfit(collateralMarket.address, borrowMarket.address, BPS_100_PCT, 0, 0, "0x", 0, 0, "0x"),
      ).to.be.revertedWith("Pausable: paused");

      await expect(
        relativePositionManager
          .connect(alice)
          .closeWithLoss(collateralMarket.address, borrowMarket.address, BPS_100_PCT, 0, 0, 0, "0x", 0, 0, "0x"),
      ).to.be.revertedWith("Pausable: paused");

      await expect(
        relativePositionManager
          .connect(alice)
          .withdrawPrincipal(collateralMarket.address, borrowMarket.address, parseEther("1")),
      ).to.be.revertedWith("Pausable: paused");

      await expect(
        relativePositionManager.connect(alice).deactivatePosition(collateralMarket.address, borrowMarket.address),
      ).to.be.revertedWith("Pausable: paused");
    });

    it("should allow activation again after unpause", async () => {
      await relativePositionManager.connect(admin).pause();
      await relativePositionManager.connect(admin).unpause();

      await expect(
        relativePositionManager
          .connect(alice)
          .activatePosition(collateralMarket.address, borrowMarket.address, 0, 0, parseEther("2")),
      ).to.not.be.reverted;
    });
  });

  describe("addDSAVToken", () => {
    it("should add DSA vToken and emit event", async () => {
      expect(await relativePositionManager.dsaVTokenIndexCounter()).to.equal(1);
      await expect(relativePositionManager.connect(admin).addDSAVToken(usdcMarket.address))
        .to.emit(relativePositionManager, "DSAVTokenAdded")
        .withArgs(usdcMarket.address, 1);
      expect(await relativePositionManager.dsaVTokenIndexCounter()).to.equal(2);
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

  describe("setDSAVTokenActive", () => {
    it("should allow using DSA when active, block when disabled, and allow again when re-enabled", async () => {
      // Initial DSA (index 0) is configured in the fixture and active
      expect(await relativePositionManager.dsaVTokenIndexCounter()).to.equal(1);

      // 1) Alice can activate with DSA index 0 while it is active
      await expect(
        relativePositionManager
          .connect(alice)
          .activatePosition(dsaMarket.address, borrowMarket.address, 0, 0, parseEther("2")),
      ).to.emit(relativePositionManager, "PositionActivated");

      // 2) Governance disables this DSA for new activations
      await relativePositionManager.connect(admin).setDSAVTokenActive(0, false);

      // 3) Another user (bob) attempting to activate with the same DSA index should now fail
      const [, , bob] = await ethers.getSigners();
      await expect(
        relativePositionManager
          .connect(bob)
          .activatePosition(dsaMarket.address, borrowMarket.address, 0, 0, parseEther("2")),
      ).to.be.revertedWithCustomError(relativePositionManager, "DSAInactive");

      // 4) Re-enable the DSA and activation should succeed again for bob
      await relativePositionManager.connect(admin).setDSAVTokenActive(0, true);

      await expect(
        relativePositionManager
          .connect(bob)
          .activatePosition(dsaMarket.address, borrowMarket.address, 0, 0, parseEther("2")),
      ).to.emit(relativePositionManager, "PositionActivated");
    });
  });

  describe("activatePosition", () => {
    it("should revert when longVToken is zero", async () => {
      await expect(
        relativePositionManager
          .connect(alice)
          .activatePosition(
            ethers.constants.AddressZero,
            borrowMarket.address,
            dsaIndex,
            noAdditionalPrincipal,
            parseEther("2"),
          ),
      ).to.be.revertedWithCustomError(relativePositionManager, "ZeroAddress");
    });

    it("should revert when shortVToken is zero", async () => {
      await expect(
        relativePositionManager
          .connect(alice)
          .activatePosition(
            collateralMarket.address,
            ethers.constants.AddressZero,
            dsaIndex,
            noAdditionalPrincipal,
            parseEther("2"),
          ),
      ).to.be.revertedWithCustomError(relativePositionManager, "ZeroAddress");
    });

    it("should revert when market is not listed", async () => {
      await expect(
        relativePositionManager
          .connect(alice)
          .activatePosition(
            unlistedMarket.address,
            borrowMarket.address,
            dsaIndex,
            noAdditionalPrincipal,
            parseEther("2"),
          ),
      ).to.be.revertedWithCustomError(relativePositionManager, "AssetNotListed");
    });

    it("should revert when longVToken is vBNB (VBNBNotSupported)", async () => {
      await expect(
        relativePositionManager
          .connect(alice)
          .activatePosition(vBNBMarket.address, borrowMarket.address, dsaIndex, noAdditionalPrincipal, parseEther("2")),
      ).to.be.revertedWithCustomError(relativePositionManager, "VBNBNotSupported");
    });

    it("should revert when shortVToken is vBNB (VBNBNotSupported)", async () => {
      await expect(
        relativePositionManager
          .connect(alice)
          .activatePosition(
            collateralMarket.address,
            vBNBMarket.address,
            dsaIndex,
            noAdditionalPrincipal,
            parseEther("2"),
          ),
      ).to.be.revertedWithCustomError(relativePositionManager, "VBNBNotSupported");
    });

    it("should revert when effective leverage is below minimum", async () => {
      await expect(
        relativePositionManager
          .connect(alice)
          .activatePosition(
            collateralMarket.address,
            borrowMarket.address,
            dsaIndex,
            noAdditionalPrincipal,
            parseEther("0.5"),
          ),
      ).to.be.revertedWithCustomError(relativePositionManager, "InvalidLeverage");
    });

    it("should revert when effective leverage is above maximum", async () => {
      await expect(
        relativePositionManager
          .connect(alice)
          .activatePosition(
            collateralMarket.address,
            borrowMarket.address,
            dsaIndex,
            noAdditionalPrincipal,
            parseEther("11"),
          ),
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
          .activatePosition(
            collateralMarket.address,
            borrowMarket.address,
            dsaIndex,
            noAdditionalPrincipal,
            parseEther("2"),
          ),
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

      // Deployed position account should match the address predicted before activation
      expect(predictedAccount).to.equal(position.positionAccount);
    });

    it("should revert when activating the same position again", async () => {
      await relativePositionManager
        .connect(alice)
        .activatePosition(
          collateralMarket.address,
          borrowMarket.address,
          dsaIndex,
          noAdditionalPrincipal,
          parseEther("2"),
        );
      await expect(
        relativePositionManager
          .connect(alice)
          .activatePosition(
            collateralMarket.address,
            borrowMarket.address,
            dsaIndex,
            noAdditionalPrincipal,
            parseEther("2"),
          ),
      ).to.be.revertedWithCustomError(relativePositionManager, "PositionAlreadyExists");
    });

    it("should activate with initial principal when user approves and supplies", async () => {
      const amount = parseEther("10");
      await dsaToken.connect(admin).transfer(aliceAddress, amount);
      await dsaToken.connect(alice).approve(relativePositionManager.address, amount);

      await relativePositionManager
        .connect(alice)
        .activatePosition(collateralMarket.address, borrowMarket.address, dsaIndex, amount, parseEther("2"));

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
        .activatePosition(
          collateralMarket.address,
          borrowMarket.address,
          dsaIndex,
          noAdditionalPrincipal,
          parseEther("2"),
        );

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
        .activatePosition(collateralMarket.address, borrowMarket.address, dsaIndex, newPrincipal, parseEther("2"));

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

  describe("supplyPrincipal", () => {
    beforeEach(async () => {
      await relativePositionManager
        .connect(alice)
        .activatePosition(
          collateralMarket.address,
          borrowMarket.address,
          dsaIndex,
          noAdditionalPrincipal,
          parseEther("2"),
        );
    });

    it("should revert when amount is zero", async () => {
      await expect(
        relativePositionManager.connect(alice).supplyPrincipal(collateralMarket.address, borrowMarket.address, 0),
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
          .supplyPrincipal(collateralMarket.address, borrowMarket.address, parseEther("1")),
      ).to.be.revertedWithCustomError(relativePositionManager, "PositionNotActive");
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
        relativePositionManager.connect(alice).supplyPrincipal(collateralMarket.address, borrowMarket.address, amount),
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
      const positionAccountContract = await ethers.getContractAt("PositionAccount", positionAccount);
      await expect(
        relativePositionManager
          .connect(admin)
          .executePositionAccountCall(positionAccount, collateralToken.address, approveData),
      ).to.emit(positionAccountContract, "GenericCallExecuted");

      const transferData = collateralToken.interface.encodeFunctionData("transfer", [aliceAddress, transferAmount]);
      await expect(
        relativePositionManager
          .connect(admin)
          .executePositionAccountCall(positionAccount, collateralToken.address, transferData),
      ).to.emit(positionAccountContract, "GenericCallExecuted");

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

  describe("closeWithProfit", () => {
    it("closeWithProfit: should revert when position is not active", async () => {
      const exitSwapData = await createSwapMulticallData(
        swapHelper,
        borrowToken,
        leverageManager.address,
        parseEther("1"),
        ethers.utils.formatBytes32String("close-inactive"),
      );
      await expect(
        relativePositionManager.connect(alice).closeWithProfit(
          collateralMarket.address,
          borrowMarket.address,
          BPS_100_PCT, // 100% close
          parseEther("0.5"),
          parseEther("1"), // minAmountOutRepay
          exitSwapData,
          parseEther("0"),
          parseEther("0"),
          "0x",
        ),
      ).to.be.revertedWithCustomError(relativePositionManager, "PositionNotActive");
    });

    it("closeWithProfit: 50% BPS with repay 0 and redeem 0 (all 50% for profit) should revert as debt must be repaid", async () => {
      const principalAmount = parseEther("20");
      const effectiveLeverage = parseEther("2");
      const shortAmount = parseEther("1");
      const minLongAmount = parseEther("0.9");
      const longReceivedFromOpen = parseEther("0.9");

      await dsaToken.connect(admin).transfer(aliceAddress, principalAmount);
      await dsaToken.connect(alice).approve(relativePositionManager.address, principalAmount);
      await relativePositionManager
        .connect(alice)
        .activatePosition(collateralMarket.address, borrowMarket.address, dsaIndex, principalAmount, effectiveLeverage);

      const saltOpen = ethers.utils.formatBytes32String("profit-only-open");
      const openSwapData = await createSwapMulticallData(
        swapHelper,
        collateralToken,
        leverageManager.address,
        longReceivedFromOpen,
        saltOpen,
      );
      await relativePositionManager
        .connect(alice)
        .openPosition(
          collateralMarket.address,
          borrowMarket.address,
          noAdditionalPrincipal,
          shortAmount,
          minLongAmount,
          openSwapData,
        );

      const longBalance = await relativePositionManager.callStatic.getLongCollateralBalance(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      const closeFractionBps = BPS_50_PCT; // 50% close
      const amountToRedeemForProfitSwap = longBalance.mul(closeFractionBps).div(BPS_BASE); // 50% of long

      // Repay leg: 0 redeem → minAmountOutRepay 0 and no swap calldata (zero bytes).
      const collateralAmountToRedeem = parseEther("0");
      const minAmountOutRepay = parseEther("0");
      const swapDataRepay = "0x";

      const minAmountOutProfit = parseEther("0");
      const saltSwapDataProfit = ethers.utils.formatBytes32String("profit-only-realize");
      const profitSwapDsaOut = parseEther("0.01");
      const swapDataProfit = await createSwapMulticallData(
        swapHelper,
        dsaToken,
        relativePositionManager.address,
        profitSwapDsaOut,
        saltSwapDataProfit,
        collateralToken,
      );

      await expect(
        relativePositionManager.connect(alice).closeWithProfit(
          collateralMarket.address,
          borrowMarket.address,
          closeFractionBps,
          collateralAmountToRedeem, // 0 → causes revert: must redeem some long to repay when there is debt
          minAmountOutRepay,
          swapDataRepay,
          amountToRedeemForProfitSwap, // all 50% long for profit; none for repay
          minAmountOutProfit,
          swapDataProfit,
        ),
      ).to.be.revertedWithCustomError(relativePositionManager, "MinAmountOutRepayBelowDebt");
    });

    it("closeWithProfit (partial 50%, no profit): closed at same price, should reduce debt and long proportionally", async () => {
      const principalAmount = parseEther("20");
      const effectiveLeverage = parseEther("2");
      const shortAmount = parseEther("1");
      const minLongAmount = parseEther("0.9");

      await dsaToken.connect(admin).transfer(aliceAddress, principalAmount);
      await dsaToken.connect(alice).approve(relativePositionManager.address, principalAmount);
      await relativePositionManager
        .connect(alice)
        .activatePosition(collateralMarket.address, borrowMarket.address, dsaIndex, principalAmount, effectiveLeverage);

      const saltOpen = ethers.utils.formatBytes32String("close-full-open");
      const openSwapData = await createSwapMulticallData(
        swapHelper,
        collateralToken,
        leverageManager.address,
        shortAmount,
        saltOpen,
      );
      await relativePositionManager
        .connect(alice)
        .openPosition(
          collateralMarket.address,
          borrowMarket.address,
          noAdditionalPrincipal,
          shortAmount,
          minLongAmount,
          openSwapData,
        );

      const positionAccountAddr = await relativePositionManager.getPositionAccountAddress(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      const debtBefore = await borrowMarket.callStatic.borrowBalanceCurrent(positionAccountAddr);
      const longBefore = await collateralMarket.callStatic.balanceOfUnderlying(positionAccountAddr);

      const closeFractionBps = BPS_50_PCT;
      const debtToRepay = debtBefore.mul(closeFractionBps).div(BPS_BASE);
      const collateralToRedeem = longBefore.mul(closeFractionBps).div(BPS_BASE);

      const saltExit = ethers.utils.formatBytes32String("close-full-exit");
      const exitSwapData = await createSwapMulticallData(
        swapHelper,
        borrowToken,
        leverageManager.address,
        debtToRepay,
        saltExit,
      );

      const noProfitRedeem = parseEther("0");
      const closeTx = await relativePositionManager
        .connect(alice)
        .closeWithProfit(
          collateralMarket.address,
          borrowMarket.address,
          closeFractionBps,
          collateralToRedeem,
          debtToRepay,
          exitSwapData,
          noProfitRedeem,
          noProfitRedeem,
          "0x",
        );
      await expect(closeTx).to.emit(relativePositionManager, "PositionClosed");

      const debtAfter = await borrowMarket.callStatic.borrowBalanceCurrent(positionAccountAddr);
      const longAfter = await collateralMarket.callStatic.balanceOfUnderlying(positionAccountAddr);
      expect(debtAfter).to.equal(debtBefore.sub(debtToRepay));
      expect(longAfter).to.equal(longBefore.sub(collateralToRedeem));
    });

    it("closeWithProfit (90%): close 90% with profit swap", async () => {
      const principalAmount = parseEther("20");
      const effectiveLeverage = parseEther("2");
      const shortAmount = parseEther("1");
      const minLongAmount = parseEther("0.9");
      const longReceivedFromOpen = parseEther("1");

      await dsaToken.connect(admin).transfer(aliceAddress, principalAmount);
      await dsaToken.connect(alice).approve(relativePositionManager.address, principalAmount);
      await relativePositionManager
        .connect(alice)
        .activatePosition(collateralMarket.address, borrowMarket.address, dsaIndex, principalAmount, effectiveLeverage);

      const saltOpen = ethers.utils.formatBytes32String("profit-90-open");
      const openSwapData = await createSwapMulticallData(
        swapHelper,
        collateralToken,
        leverageManager.address,
        longReceivedFromOpen,
        saltOpen,
      );
      await relativePositionManager
        .connect(alice)
        .openPosition(
          collateralMarket.address,
          borrowMarket.address,
          noAdditionalPrincipal,
          shortAmount,
          minLongAmount,
          openSwapData,
        );

      const positionAccountAddr = (
        await relativePositionManager.getPosition(aliceAddress, collateralMarket.address, borrowMarket.address)
      ).positionAccount;
      const currentShortDebt = await borrowMarket.callStatic.borrowBalanceCurrent(positionAccountAddr);
      const longBalance = await relativePositionManager.callStatic.getLongCollateralBalance(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );

      const longPrice = parseUnits("2", 18);
      const shortPrice = parseUnits("1", 18);
      const dsaPrice = parseUnits("1", 18);
      resilientOracle.getUnderlyingPrice.whenCalledWith(collateralMarket.address).returns(longPrice);
      resilientOracle.getUnderlyingPrice.whenCalledWith(borrowMarket.address).returns(shortPrice);
      resilientOracle.getUnderlyingPrice.whenCalledWith(dsaMarket.address).returns(dsaPrice);

      const closeFractionBps = BPS_90_PCT;
      const expectedShort = currentShortDebt.mul(closeFractionBps).div(BPS_BASE);
      const expectedLong = longBalance.mul(closeFractionBps).div(BPS_BASE);

      // At long=2, short=1: repay needs expectedShort/2 long; use half + 5% buffer, rest is profit
      const collateralToRedeem = expectedShort.div(2).add(expectedShort.mul(5).div(100));
      const profitLong = expectedLong.sub(collateralToRedeem);

      const repaySwapAmount = expectedShort.mul(102).div(100);
      const saltRepay = ethers.utils.formatBytes32String("profit-90-repay");
      const exitSwapDataRepay = await createSwapMulticallData(
        swapHelper,
        borrowToken,
        leverageManager.address,
        repaySwapAmount,
        saltRepay,
      );

      const minAmountOutProfit = profitLong.mul(2).div(100);
      const profitSwapDsaOut = minAmountOutProfit.add(parseEther("0.01"));
      const saltProfit = ethers.utils.formatBytes32String("profit-90-realize");
      const swapDataProfit = await createSwapMulticallData(
        swapHelper,
        dsaToken,
        relativePositionManager.address,
        profitSwapDsaOut,
        saltProfit,
        collateralToken,
      );

      await expect(
        relativePositionManager
          .connect(alice)
          .closeWithProfit(
            collateralMarket.address,
            borrowMarket.address,
            closeFractionBps,
            collateralToRedeem,
            expectedShort,
            exitSwapDataRepay,
            profitLong,
            minAmountOutProfit,
            swapDataProfit,
          ),
      ).to.emit(relativePositionManager, "PositionClosed");

      const debtAfter = await borrowMarket.callStatic.borrowBalanceCurrent(positionAccountAddr);
      const longAfter = await collateralMarket.callStatic.balanceOfUnderlying(positionAccountAddr);
      const remainingDebt = currentShortDebt.sub(expectedShort);
      const remainingLong = longBalance.sub(expectedLong);
      expect(debtAfter).to.equal(remainingDebt);
      expect(longAfter).to.equal(remainingLong);
    });

    it("closeWithProfit (100%): full detailed — exact swap behaviour and all transfers", async () => {
      // --- Setup: activate + open ---
      const principalAmount = parseEther("20");
      const shortAmount = parseEther("1");
      const minLongAmount = parseEther("0.9");
      const longReceivedFromOpenSwap = parseEther("0.95"); // exact amount "swapped" to long in open

      await dsaToken.connect(admin).transfer(aliceAddress, principalAmount);
      await dsaToken.connect(alice).approve(relativePositionManager.address, principalAmount);
      await relativePositionManager
        .connect(alice)
        .activatePosition(collateralMarket.address, borrowMarket.address, dsaIndex, principalAmount, parseEther("2"));

      const saltOpen = ethers.utils.formatBytes32String("profit-100-open");
      const openSwapData = await createSwapMulticallData(
        swapHelper,
        collateralToken,
        leverageManager.address,
        longReceivedFromOpenSwap,
        saltOpen,
        borrowToken,
      );
      await relativePositionManager
        .connect(alice)
        .openPosition(
          collateralMarket.address,
          borrowMarket.address,
          noAdditionalPrincipal,
          shortAmount,
          minLongAmount,
          openSwapData,
        );

      // --- Oracle: profit scenario (long price 2× short) ---
      const longPrice = parseUnits("2", 18);
      const shortPrice = parseUnits("1", 18);
      const dsaPrice = parseUnits("1", 18);
      resilientOracle.getUnderlyingPrice.whenCalledWith(collateralMarket.address).returns(longPrice);
      resilientOracle.getUnderlyingPrice.whenCalledWith(borrowMarket.address).returns(shortPrice);
      resilientOracle.getUnderlyingPrice.whenCalledWith(dsaMarket.address).returns(dsaPrice);

      const positionBefore = await relativePositionManager.getPosition(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      const positionAccountAddr = positionBefore.positionAccount;

      const currentShortDebt = await borrowMarket.callStatic.borrowBalanceCurrent(positionAccountAddr);
      const longBalanceBeforeClose = await relativePositionManager.callStatic.getLongCollateralBalance(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      expect(longBalanceBeforeClose).to.equal(longReceivedFromOpenSwap);
      expect(currentShortDebt).to.be.gt(0);

      // --- Swap behaviour (mocked via createSwapMulticallData) ---
      // 1) Repay swap: Position account redeems `collateralAmountToRedeem` long and sends to LM.
      //    LM calls swapHelper multicall: tokenIn = long (swept to dead), tokenOut = borrowToken.
      //    Mock: we pre-load swapHelper with borrowToken and sweep exactly `repaySwapAmount` to LM.
      //    LM uses `amountToRepay` to repay; the rest stays on position account and is later sent to user as dust.
      const SLIPPAGE_BPS = 500;
      const collateralAmountToRedeem = parseEther("0.53"); // long used for repay leg (enough for 1 short at long=2, short=1 + slippage)
      const repaySwapAmount = currentShortDebt.mul(102).div(100); // mock: swap "returns" this much short to LM
      const saltSwapDataRepay = ethers.utils.formatBytes32String("profit-100-repay");
      const swapDataRepay = await createSwapMulticallData(
        swapHelper,
        borrowToken,
        leverageManager.address,
        repaySwapAmount,
        saltSwapDataRepay,
        collateralToken,
      );

      // 2) Profit swap: Position account redeems `amountToRedeemForProfitSwap` long and sends to swapHelper.
      //    Mock: we pre-load swapHelper with dsaToken and sweep exactly `dsaOutActual` to RPM (then to user as profit).
      const amountToRedeemForProfitSwap = longBalanceBeforeClose.sub(collateralAmountToRedeem);
      const theoreticalDsaOut = amountToRedeemForProfitSwap.mul(longPrice).div(dsaPrice);
      const minAmountOutProfit = theoreticalDsaOut.mul(10000 - SLIPPAGE_BPS).div(10000);
      const dsaOutActual = minAmountOutProfit.add(parseEther("0.01")); // mock gives this exact amount
      const saltSwapDataProfit = ethers.utils.formatBytes32String("profit-100-realize");
      const swapDataProfit = await createSwapMulticallData(
        swapHelper,
        dsaToken,
        relativePositionManager.address,
        dsaOutActual,
        saltSwapDataProfit,
        collateralToken,
      );

      // --- Balances before close ---
      const aliceBorrowBefore = await borrowToken.balanceOf(aliceAddress);
      const aliceDsaBefore = await dsaToken.balanceOf(aliceAddress);
      const aliceCollateralBefore = await collateralToken.balanceOf(aliceAddress);

      // --- Execute 100% close ---
      const closeTx = await relativePositionManager
        .connect(alice)
        .closeWithProfit(
          collateralMarket.address,
          borrowMarket.address,
          BPS_100_PCT,
          collateralAmountToRedeem,
          currentShortDebt,
          swapDataRepay,
          amountToRedeemForProfitSwap,
          minAmountOutProfit,
          swapDataProfit,
        );

      // --- Events ---
      await expect(closeTx).to.emit(relativePositionManager, "ProfitConverted");
      await expect(closeTx).to.emit(relativePositionManager, "PositionClosed");

      // --- Transfers: position account ---
      const positionLongUnderlyingAfter = await collateralMarket.callStatic.balanceOfUnderlying(positionAccountAddr);
      const positionShortDebtAfter = await borrowMarket.callStatic.borrowBalanceCurrent(positionAccountAddr);
      expect(positionLongUnderlyingAfter).to.equal(0);
      expect(positionShortDebtAfter).to.equal(0);

      // --- Transfers: user ---
      // Repay leg: LM received repaySwapAmount from mock swap; used currentShortDebt to repay; dust = repaySwapAmount - currentShortDebt → user
      const expectedBorrowDustToUser = repaySwapAmount.sub(currentShortDebt);
      const aliceBorrowAfter = await borrowToken.balanceOf(aliceAddress);
      expect(aliceBorrowAfter.sub(aliceBorrowBefore)).to.equal(expectedBorrowDustToUser);

      // Profit leg: user receives dsaOutActual (swept to RPM then transferred to user)
      const aliceDsaAfter = await dsaToken.balanceOf(aliceAddress);
      expect(aliceDsaAfter.sub(aliceDsaBefore)).to.equal(dsaOutActual);

      // No collateral dust in this setup (all long used in repay + profit swaps)
      const aliceCollateralAfter = await collateralToken.balanceOf(aliceAddress);
      expect(aliceCollateralAfter.sub(aliceCollateralBefore)).to.equal(0);

      // --- Position state: 100% close deactivates the position ---
      const positionAfter = await relativePositionManager.getPosition(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      expect(positionAfter.isActive).to.be.false;
    });

    it("closeWithProfit: when no debt but long available, 100% close redeems full long as profit and transfers to user", async () => {
      const principalAmount = parseEther("20");
      const effectiveLeverage = parseEther("2");
      const shortAmount = parseEther("1");
      const minLongAmount = parseEther("0.9");
      const longReceivedFromOpen = parseEther("0.9");

      await dsaToken.connect(admin).transfer(aliceAddress, principalAmount);
      await dsaToken.connect(alice).approve(relativePositionManager.address, principalAmount);
      await relativePositionManager
        .connect(alice)
        .activatePosition(collateralMarket.address, borrowMarket.address, dsaIndex, principalAmount, effectiveLeverage);

      const saltOpen = ethers.utils.formatBytes32String("zero-debt-open");
      const openSwapData = await createSwapMulticallData(
        swapHelper,
        collateralToken,
        leverageManager.address,
        longReceivedFromOpen,
        saltOpen,
      );
      await relativePositionManager
        .connect(alice)
        .openPosition(
          collateralMarket.address,
          borrowMarket.address,
          noAdditionalPrincipal,
          shortAmount,
          minLongAmount,
          openSwapData,
        );

      const positionAccountAddr = (
        await relativePositionManager.getPosition(aliceAddress, collateralMarket.address, borrowMarket.address)
      ).positionAccount;
      const debt = await borrowMarket.callStatic.borrowBalanceCurrent(positionAccountAddr);
      await borrowToken.connect(admin).approve(borrowMarket.address, debt);
      await borrowMarket.connect(admin).repayBorrowBehalf(positionAccountAddr, debt);

      const longBalance = await relativePositionManager.callStatic.getLongCollateralBalance(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      expect(longBalance).to.be.gt(0);
      expect(await borrowMarket.callStatic.borrowBalanceCurrent(positionAccountAddr)).to.equal(0);

      const closeFractionBps = BPS_100_PCT;
      const zeroAmount = parseEther("0");
      const collateralToRedeem = zeroAmount;
      const fullLongAsProfit = longBalance;

      // No repay leg → pass zero bytes for swap calldata.
      const swapDataRepay = "0x";

      const minAmountOutProfit = parseEther("0.01");
      const saltProfit = ethers.utils.formatBytes32String("zero-debt-profit");
      const swapDataProfit = await createSwapMulticallData(
        swapHelper,
        dsaToken,
        relativePositionManager.address,
        minAmountOutProfit,
        saltProfit,
        collateralToken,
      );

      await expect(
        relativePositionManager
          .connect(alice)
          .closeWithProfit(
            collateralMarket.address,
            borrowMarket.address,
            closeFractionBps,
            collateralToRedeem,
            zeroAmount,
            swapDataRepay,
            fullLongAsProfit,
            minAmountOutProfit,
            swapDataProfit,
          ),
      ).to.emit(relativePositionManager, "PositionClosed");

      expect(await borrowMarket.callStatic.borrowBalanceCurrent(positionAccountAddr)).to.equal(0);
      expect(await collateralMarket.callStatic.balanceOfUnderlying(positionAccountAddr)).to.equal(0);
      const positionAfter = await relativePositionManager.getPosition(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      expect(positionAfter.isActive).to.be.false;
    });
  });

  describe("closeWithLoss", () => {
    it("closeWithLoss: should revert when position is not active", async () => {
      await expect(
        relativePositionManager
          .connect(alice)
          .closeWithLoss(collateralMarket.address, borrowMarket.address, BPS_50_PCT, 0, 0, 0, "0x", 0, 0, "0x"),
      ).to.be.revertedWithCustomError(relativePositionManager, "PositionNotActive");
    });

    it("closeWithLoss: should revert when there is no debt (ZeroDebt)", async () => {
      const principalAmount = parseEther("20");
      await dsaToken.connect(admin).transfer(aliceAddress, principalAmount);
      await dsaToken.connect(alice).approve(relativePositionManager.address, principalAmount);
      await relativePositionManager
        .connect(alice)
        .activatePosition(collateralMarket.address, borrowMarket.address, dsaIndex, principalAmount, parseEther("2"));

      const shortAmount = parseEther("1");
      const longSuppliedToOpen = parseEther("0.9");
      const minLongAmount = parseEther("0.8");
      const saltOpen = ethers.utils.formatBytes32String("loss-zero-debt-open");
      const openSwapData = await createSwapMulticallData(
        swapHelper,
        collateralToken,
        leverageManager.address,
        longSuppliedToOpen,
        saltOpen,
        borrowToken,
      );
      await relativePositionManager
        .connect(alice)
        .openPosition(
          collateralMarket.address,
          borrowMarket.address,
          noAdditionalPrincipal,
          shortAmount,
          minLongAmount,
          openSwapData,
        );

      const positionAccountAddr = (
        await relativePositionManager.getPosition(aliceAddress, collateralMarket.address, borrowMarket.address)
      ).positionAccount;
      const debt = await borrowMarket.callStatic.borrowBalanceCurrent(positionAccountAddr);
      await borrowToken.connect(admin).approve(borrowMarket.address, debt);
      await borrowMarket.connect(admin).repayBorrowBehalf(positionAccountAddr, debt);

      expect(await borrowMarket.callStatic.borrowBalanceCurrent(positionAccountAddr)).to.equal(0);

      await expect(
        relativePositionManager
          .connect(alice)
          .closeWithLoss(collateralMarket.address, borrowMarket.address, BPS_100_PCT, 0, 0, 0, "0x", 0, 0, "0x"),
      ).to.be.revertedWithCustomError(relativePositionManager, "ZeroDebt");
    });

    it("closeWithLoss (partial 95%): should repay 95% of debt and redeem 95% of long; 5% remains", async () => {
      const principalAmount = parseEther("20");
      await dsaToken.connect(admin).transfer(aliceAddress, principalAmount);
      await dsaToken.connect(alice).approve(relativePositionManager.address, principalAmount);
      await relativePositionManager
        .connect(alice)
        .activatePosition(collateralMarket.address, borrowMarket.address, dsaIndex, principalAmount, parseEther("2"));

      const shortAmount = parseEther("1");
      const longSuppliedToOpen = parseEther("0.9");
      const minLongAmount = parseEther("0.8");
      const saltOpen = ethers.utils.formatBytes32String("loss-open");
      const openSwapData = await createSwapMulticallData(
        swapHelper,
        collateralToken,
        leverageManager.address,
        longSuppliedToOpen,
        saltOpen,
        borrowToken,
      );
      await relativePositionManager
        .connect(alice)
        .openPosition(
          collateralMarket.address,
          borrowMarket.address,
          noAdditionalPrincipal,
          shortAmount,
          minLongAmount,
          openSwapData,
        );

      const longPrice = parseUnits("0.8", 18);
      const shortPrice = parseUnits("1", 18);
      const dsaPrice = parseUnits("1", 18);
      resilientOracle.getUnderlyingPrice.whenCalledWith(collateralMarket.address).returns(longPrice);
      resilientOracle.getUnderlyingPrice.whenCalledWith(borrowMarket.address).returns(shortPrice);
      resilientOracle.getUnderlyingPrice.whenCalledWith(dsaMarket.address).returns(dsaPrice);

      const positionBefore = await relativePositionManager.getPosition(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      const positionAccountAddr = positionBefore.positionAccount;
      const currentShortDebt = await borrowMarket.callStatic.borrowBalanceCurrent(positionAccountAddr);
      const currentLongBalance = await collateralMarket.callStatic.balanceOfUnderlying(positionAccountAddr);

      const closeFractionBps = BPS_95_PCT;
      const expectedShort = currentShortDebt.mul(closeFractionBps).div(BPS_BASE);
      const expectedLong = currentLongBalance.mul(closeFractionBps).div(BPS_BASE);
      const SLIPPAGE_BPS = 500;
      const longAmountToRedeemForFirstSwap = expectedLong;
      const theoreticalShortFromLong = longAmountToRedeemForFirstSwap.mul(longPrice).div(shortPrice);
      const borrowedAmountToRepayFirst = theoreticalShortFromLong.mul(10000 - SLIPPAGE_BPS).div(10000);
      expect(borrowedAmountToRepayFirst).to.be.lte(expectedShort);

      const amountToRepaySecond = expectedShort.sub(borrowedAmountToRepayFirst);
      const minAmountOutFirst = borrowedAmountToRepayFirst;
      const minAmountOutSecond = amountToRepaySecond;
      const saltSwapDataFirst = ethers.utils.formatBytes32String("loss-first");
      const swapDataFirst = await createSwapMulticallData(
        swapHelper,
        borrowToken,
        leverageManager.address,
        borrowedAmountToRepayFirst.mul(102).div(100),
        saltSwapDataFirst,
        collateralToken,
      );
      const saltSwapDataSecond = ethers.utils.formatBytes32String("loss-second");
      const swapDataSecond = await createSwapMulticallData(
        swapHelper,
        borrowToken,
        leverageManager.address,
        amountToRepaySecond.mul(102).div(100),
        saltSwapDataSecond,
        dsaToken,
      );
      const theoreticalDsaForSecond = amountToRepaySecond.mul(shortPrice).div(dsaPrice);
      const dsaAmountToRedeemForRepay = theoreticalDsaForSecond.mul(10000).div(10000 - SLIPPAGE_BPS);

      await expect(
        relativePositionManager
          .connect(alice)
          .closeWithLoss(
            collateralMarket.address,
            borrowMarket.address,
            closeFractionBps,
            borrowedAmountToRepayFirst,
            longAmountToRedeemForFirstSwap,
            minAmountOutFirst,
            swapDataFirst,
            dsaAmountToRedeemForRepay,
            minAmountOutSecond,
            swapDataSecond,
          ),
      ).to.emit(relativePositionManager, "PositionClosed");

      const debtAfter = await borrowMarket.callStatic.borrowBalanceCurrent(positionAccountAddr);
      const longAfter = await collateralMarket.callStatic.balanceOfUnderlying(positionAccountAddr);
      const debtRemainingPct = currentShortDebt.sub(expectedShort);
      const longRemainingPct = currentLongBalance.sub(expectedLong);
      expect(debtAfter).to.equal(debtRemainingPct);
      expect(longAfter).to.equal(longRemainingPct);

      const position = await relativePositionManager.getPosition(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      expect(position.isActive).to.be.true;
    });

    // This can happen e.g. when long collateral was liquidated and only debt + DSA (principal) remain.
    it("closeWithLoss: repay with DSA only when there is no long remaining (first exit skipped)", async () => {
      const principalAmount = parseEther("20");
      await dsaToken.connect(admin).transfer(aliceAddress, principalAmount);
      await dsaToken.connect(alice).approve(relativePositionManager.address, principalAmount);
      await relativePositionManager
        .connect(alice)
        .activatePosition(collateralMarket.address, borrowMarket.address, dsaIndex, principalAmount, parseEther("2"));

      const shortAmount = parseEther("1");
      const minLongAmount = parseEther("0");
      const saltOpen = ethers.utils.formatBytes32String("loss-dsa-only-open");
      const openSwapData = await createSwapMulticallData(
        swapHelper,
        collateralToken,
        leverageManager.address,
        parseEther("0"),
        saltOpen,
        borrowToken,
      );
      await relativePositionManager
        .connect(alice)
        .openPosition(
          collateralMarket.address,
          borrowMarket.address,
          noAdditionalPrincipal,
          shortAmount,
          minLongAmount,
          openSwapData,
        );

      const positionAccountAddr = (
        await relativePositionManager.getPosition(aliceAddress, collateralMarket.address, borrowMarket.address)
      ).positionAccount;
      const currentShortDebt = await borrowMarket.callStatic.borrowBalanceCurrent(positionAccountAddr);
      const longBalance = await relativePositionManager.callStatic.getLongCollateralBalance(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      expect(longBalance).to.equal(0);

      resilientOracle.getUnderlyingPrice.whenCalledWith(collateralMarket.address).returns(parseUnits("0.8", 18));
      resilientOracle.getUnderlyingPrice.whenCalledWith(borrowMarket.address).returns(parseUnits("1", 18));
      resilientOracle.getUnderlyingPrice.whenCalledWith(dsaMarket.address).returns(parseUnits("1", 18));

      const closeFractionBps = BPS_100_PCT;
      const borrowedAmountToRepayFirst = 0;
      const longAmountToRedeemForFirstSwap = 0;
      const minAmountOutFirst = 0;
      const swapDataFirst = "0x";

      const amountToRepaySecond = currentShortDebt;
      const minAmountOutSecond = amountToRepaySecond;
      const dsaAmountToRedeemForRepay = amountToRepaySecond.mul(102).div(100);
      const saltSwapDataSecond = ethers.utils.formatBytes32String("loss-dsa-only-second");
      const swapDataSecond = await createSwapMulticallData(
        swapHelper,
        borrowToken,
        leverageManager.address,
        amountToRepaySecond.mul(102).div(100),
        saltSwapDataSecond,
        dsaToken,
      );

      await expect(
        relativePositionManager
          .connect(alice)
          .closeWithLoss(
            collateralMarket.address,
            borrowMarket.address,
            closeFractionBps,
            borrowedAmountToRepayFirst,
            longAmountToRedeemForFirstSwap,
            minAmountOutFirst,
            swapDataFirst,
            dsaAmountToRedeemForRepay,
            minAmountOutSecond,
            swapDataSecond,
          ),
      ).to.emit(relativePositionManager, "PositionClosed");

      expect(await borrowMarket.callStatic.borrowBalanceCurrent(positionAccountAddr)).to.equal(0);
    });

    it("closeWithLoss (100%): one swap — long covers repay proportionally; debt and long go to zero", async () => {
      const principalAmount = parseEther("20");
      await dsaToken.connect(admin).transfer(aliceAddress, principalAmount);
      await dsaToken.connect(alice).approve(relativePositionManager.address, principalAmount);
      await relativePositionManager
        .connect(alice)
        .activatePosition(collateralMarket.address, borrowMarket.address, dsaIndex, principalAmount, parseEther("2"));

      const shortAmount = parseEther("1");
      const longSuppliedToOpen = parseEther("0.9");
      const minLongAmount = parseEther("0.8");
      const saltOpen = ethers.utils.formatBytes32String("loss-full-open");
      const openSwapData = await createSwapMulticallData(
        swapHelper,
        collateralToken,
        leverageManager.address,
        longSuppliedToOpen,
        saltOpen,
        borrowToken,
      );
      await relativePositionManager
        .connect(alice)
        .openPosition(
          collateralMarket.address,
          borrowMarket.address,
          noAdditionalPrincipal,
          shortAmount,
          minLongAmount,
          openSwapData,
        );

      resilientOracle.getUnderlyingPrice.whenCalledWith(collateralMarket.address).returns(parseUnits("0.8", 18));
      resilientOracle.getUnderlyingPrice.whenCalledWith(borrowMarket.address).returns(parseUnits("1", 18));
      resilientOracle.getUnderlyingPrice.whenCalledWith(dsaMarket.address).returns(parseUnits("1", 18));

      const positionBefore = await relativePositionManager.getPosition(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      const positionAccountAddr = positionBefore.positionAccount;
      const currentShortDebt = await borrowMarket.callStatic.borrowBalanceCurrent(positionAccountAddr);
      const longAmountToRedeemForFirstSwap = await relativePositionManager.callStatic.getLongCollateralBalance(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );

      const closeFractionBps = BPS_100_PCT;
      const borrowedAmountToRepayFirst = currentShortDebt;
      const minAmountOutFirst = borrowedAmountToRepayFirst;
      const saltSwapDataFirst = ethers.utils.formatBytes32String("loss-full-first");
      const swapDataFirst = await createSwapMulticallData(
        swapHelper,
        borrowToken,
        leverageManager.address,
        currentShortDebt.mul(102).div(100),
        saltSwapDataFirst,
        collateralToken,
      );
      // Second exit skipped: first swap (long → short) covers full repay; pass 0 and zero bytes.
      const minAmountOutSecond = 0;
      const dsaAmountToRedeemForRepay = 0;
      const swapDataSecond = "0x";

      await expect(
        relativePositionManager
          .connect(alice)
          .closeWithLoss(
            collateralMarket.address,
            borrowMarket.address,
            closeFractionBps,
            borrowedAmountToRepayFirst,
            longAmountToRedeemForFirstSwap,
            minAmountOutFirst,
            swapDataFirst,
            dsaAmountToRedeemForRepay,
            minAmountOutSecond,
            swapDataSecond,
          ),
      ).to.emit(relativePositionManager, "PositionClosed");

      expect(await borrowMarket.callStatic.borrowBalanceCurrent(positionAccountAddr)).to.equal(0);
      expect(await collateralMarket.callStatic.balanceOfUnderlying(positionAccountAddr)).to.equal(0);
      const positionAfter = await relativePositionManager.getPosition(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      expect(positionAfter.isActive).to.be.false;
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
      const longCollateralAfterOpen = await relativePositionManager.callStatic.getLongCollateralBalance(
        aliceAddress,
        dsaMarket.address,
        borrowMarket.address,
      );
      const principalUnderlyingAfter = underlyingAfterOpen.sub(longCollateralAfterOpen);
      expect(principalUnderlyingAfter).to.equal(totalPrincipal);
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
          noAdditionalPrincipal,
          shortAmount,
          minLongAmount,
          openSwapData,
        );

      const longPrice = parseUnits("2", 18);
      const shortPrice = parseUnits("1", 18);
      resilientOracle.getUnderlyingPrice.whenCalledWith(dsaMarket.address).returns(longPrice);
      resilientOracle.getUnderlyingPrice.whenCalledWith(borrowMarket.address).returns(shortPrice);

      const positionBeforeProfit = await relativePositionManager.getPosition(
        aliceAddress,
        dsaMarket.address,
        borrowMarket.address,
      );
      const principalVTokensBefore = positionBeforeProfit.suppliedPrincipal;
      const positionAccountAddr = positionBeforeProfit.positionAccount;

      // Repay leg: at oracle price long=2, short=1, repaying full short debt requires
      // theoreticalLongForRepay = currentShortDebt * (shortPrice / longPrice) = debt * 0.5 long.
      // With 5% buffer we redeem slightly more long and also send 2% extra short through the swap helper
      // so there is dust that can be returned to the user.
      const currentShortDebt = await borrowMarket.callStatic.borrowBalanceCurrent(positionAccountAddr);
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
        relativePositionManager.connect(alice).closeWithProfit(
          dsaMarket.address,
          borrowMarket.address,
          BPS_100_PCT, // 100% close
          collateralAmountToRedeemForRepay,
          currentShortDebt, // minAmountOutRepay
          swapDataRepay,
          amountToRedeemForProfitSwap,
          minAmountOutProfit,
          swapDataProfit,
        ),
      ).to.emit(relativePositionManager, "PositionClosed");

      const positionAfter = await relativePositionManager.getPosition(
        aliceAddress,
        dsaMarket.address,
        borrowMarket.address,
      );
      expect(positionAfter.isActive).to.be.false;
      expect(positionAfter.suppliedPrincipal).to.equal(principalVTokensBefore);
      expect(await borrowMarket.callStatic.borrowBalanceCurrent(positionAccountAddr)).to.equal(0);
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
          noAdditionalPrincipal,
          shortAmount,
          minLongAmount,
          openSwapData,
        );

      // Make this a loss scenario by dropping long/DSA price after open:
      // use long/DSA price = 0.8 and short price = 1 so longValueUSD < shortDebtUSD.
      const longPrice = parseUnits("0.8", 18);
      const shortPrice = parseUnits("1", 18);
      resilientOracle.getUnderlyingPrice.whenCalledWith(dsaMarket.address).returns(longPrice);
      resilientOracle.getUnderlyingPrice.whenCalledWith(borrowMarket.address).returns(shortPrice);

      const positionBefore = await relativePositionManager.getPosition(
        aliceAddress,
        dsaMarket.address,
        borrowMarket.address,
      );
      const positionAccountAddr = positionBefore.positionAccount;
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
      );
      const swapDataSecond = await createSwapMulticallData(
        swapHelper,
        borrowToken,
        leverageManager.address,
        repaySecondSwapAmount,
        ethers.utils.formatBytes32String("usdt-same-market-loss-second"),
        dsaToken,
      );

      const principalVTokensBefore = positionBefore.suppliedPrincipal;
      const principalUnderlyingBefore = await relativePositionManager.callStatic.getSuppliedPrincipalBalance(
        aliceAddress,
        dsaMarket.address,
        borrowMarket.address,
      );

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
            BPS_100_PCT,
            borrowedAmountToRepayFirst,
            longAmountToRedeemForFirstSwap,
            minAmountOutFirst,
            swapDataFirst,
            dsaAmountToRedeemForRepay,
            minAmountOutSecond,
            swapDataSecond,
          ),
      ).to.emit(relativePositionManager, "PositionClosed");

      const positionAfter = await relativePositionManager.getPosition(
        aliceAddress,
        dsaMarket.address,
        borrowMarket.address,
      );
      expect(positionAfter.isActive).to.be.false;
      expect(await borrowMarket.callStatic.borrowBalanceCurrent(positionAccountAddr)).to.equal(0);
      // Second exit used DSA principal to repay the remaining short debt:
      // principal reduction in underlying terms should equal dsaAmountToRedeemForRepay.
      const principalUnderlyingAfter = await relativePositionManager.callStatic.getSuppliedPrincipalBalance(
        aliceAddress,
        dsaMarket.address,
        borrowMarket.address,
      );
      const principalUnderlyingSpent = principalUnderlyingBefore.sub(principalUnderlyingAfter);
      expect(principalUnderlyingSpent).to.equal(dsaAmountToRedeemForRepay);
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
      );
      // With no long/short and only principal supplied: available capital is capped by DSA collateral factor (e.g. 80%).
      // availableCapitalUSD = 10 * 0.8 = 8; full principal (10) is withdrawable in DSA terms.
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
      );
      // Max borrow = availableCapitalUSD * effectiveLeverage / shortPrice. With available capital 8 and effectiveLeverage = 2, maxBorrow = 16.
      expect(maxBorrow).to.equal(parseEther("16"));
    });

    it("should return utilization with different oracle prices (DSA and short)", async () => {
      const principalAmount = parseEther("10");
      await dsaToken.connect(admin).transfer(aliceAddress, principalAmount);
      await dsaToken.connect(alice).approve(relativePositionManager.address, principalAmount);
      await relativePositionManager
        .connect(alice)
        .activatePosition(collateralMarket.address, borrowMarket.address, dsaIndex, principalAmount, parseEther("2"));

      // First check output at default prices (all 1)
      const utilizationAtPrice1 = await relativePositionManager.callStatic.getUtilizationInfo(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      const maxBorrowAtPrice1 = await relativePositionManager.callStatic.calculateMaxBorrow(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      // At default prices: available capital capped by DSA collateral factor (80%) → 8; withdrawable 10 (DSA terms); maxBorrow = 8 * 2 = 16
      expect(utilizationAtPrice1.availableCapitalUSD).to.equal(parseEther("8"));
      expect(utilizationAtPrice1.withdrawableAmount).to.equal(parseEther("10"));
      expect(maxBorrowAtPrice1).to.equal(parseEther("16"));

      // Change prices: DSA = 2, short = 1, long = 1 (same account, same position)
      const dsaPrice = parseUnits("2", 18);
      const shortPrice = parseUnits("1", 18);
      const longPrice = parseUnits("1", 18);
      resilientOracle.getUnderlyingPrice.whenCalledWith(collateralMarket.address).returns(longPrice);
      resilientOracle.getUnderlyingPrice.whenCalledWith(borrowMarket.address).returns(shortPrice);
      resilientOracle.getUnderlyingPrice.whenCalledWith(dsaMarket.address).returns(dsaPrice);

      const utilizationAtPrice2 = await relativePositionManager.callStatic.getUtilizationInfo(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      const maxBorrowAtPrice2 = await relativePositionManager.callStatic.calculateMaxBorrow(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      // At DSA price 2: suppliedPrincipalUSD = 20, no borrow → availableCapitalUSD = 20; withdrawable = 20/2 = 10 (DSA terms); maxBorrow = 20 * 2 / 1 = 40
      expect(utilizationAtPrice2.availableCapitalUSD).to.equal(parseEther("20"));
      expect(utilizationAtPrice2.withdrawableAmount).to.equal(parseEther("10"));
      expect(maxBorrowAtPrice2).to.equal(parseEther("40"));

      // Same account: after price change, availableCapitalUSD and maxBorrow increased
      expect(utilizationAtPrice2.availableCapitalUSD).to.be.gt(utilizationAtPrice1.availableCapitalUSD);
      expect(maxBorrowAtPrice2).to.be.gt(maxBorrowAtPrice1);
    });

    it("should return lower available capital and max borrow when position has open borrow", async () => {
      const principalAmount = parseEther("10");
      await dsaToken.connect(admin).transfer(aliceAddress, principalAmount);
      await dsaToken.connect(alice).approve(relativePositionManager.address, principalAmount);
      await relativePositionManager
        .connect(alice)
        .activatePosition(collateralMarket.address, borrowMarket.address, dsaIndex, principalAmount, parseEther("2"));

      // Baseline: no open long/short yet
      const utilizationBefore = await relativePositionManager.callStatic.getUtilizationInfo(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      const maxBorrowBefore = await relativePositionManager.callStatic.calculateMaxBorrow(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );

      const shortAmount = parseEther("8");
      const minLongAmount = parseEther("0.1");
      const openSwapData = await createSwapMulticallData(
        swapHelper,
        collateralToken,
        leverageManager.address,
        parseEther("7"),
        ethers.utils.formatBytes32String("util-open-borrow"),
        borrowToken,
      );
      await relativePositionManager
        .connect(alice)
        .openPosition(
          collateralMarket.address,
          borrowMarket.address,
          noAdditionalPrincipal,
          shortAmount,
          minLongAmount,
          openSwapData,
        );

      const utilization = await relativePositionManager.callStatic.getUtilizationInfo(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      const maxBorrow = await relativePositionManager.callStatic.calculateMaxBorrow(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      // After opening borrow, capital is utilized so available and max borrow should be lower than before
      expect(utilization.availableCapitalUSD).to.be.lt(utilizationBefore.availableCapitalUSD);
      expect(utilization.withdrawableAmount).to.be.lt(utilizationBefore.withdrawableAmount);
      expect(maxBorrow).to.be.lt(maxBorrowBefore);
    });

    it("should return zero available capital and max borrow when position has no principal", async () => {
      await relativePositionManager
        .connect(alice)
        .activatePosition(
          collateralMarket.address,
          borrowMarket.address,
          dsaIndex,
          noAdditionalPrincipal,
          parseEther("2"),
        );

      const utilization = await relativePositionManager.callStatic.getUtilizationInfo(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      expect(utilization.availableCapitalUSD).to.equal(0);
      expect(utilization.withdrawableAmount).to.equal(0);

      const maxBorrow = await relativePositionManager.callStatic.calculateMaxBorrow(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      expect(maxBorrow).to.equal(0);
    });

    it("should show 0 available for borrow after scaling position to max (use full available capacity)", async () => {
      const principalAmount = parseEther("10");
      await dsaToken.connect(admin).transfer(aliceAddress, principalAmount);
      await dsaToken.connect(alice).approve(relativePositionManager.address, principalAmount);
      await relativePositionManager
        .connect(alice)
        .activatePosition(collateralMarket.address, borrowMarket.address, dsaIndex, principalAmount, parseEther("2"));

      // Open initial position
      const shortAmount = parseEther("2");
      const minLongAmount = parseEther("1");
      const openSwapData = await createSwapMulticallData(
        swapHelper,
        collateralToken,
        leverageManager.address,
        parseEther("1.5"),
        ethers.utils.formatBytes32String("util-scale-open"),
        borrowToken,
      );
      await relativePositionManager
        .connect(alice)
        .openPosition(
          collateralMarket.address,
          borrowMarket.address,
          noAdditionalPrincipal,
          shortAmount,
          minLongAmount,
          openSwapData,
        );

      // After initial open: principal 10, borrow 2 → availableCapitalUSD and maxBorrow from contract (used to scale position to max next)
      const utilizationAfterOpen = await relativePositionManager.callStatic.getUtilizationInfo(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      const maxBorrowAvailable = await relativePositionManager.callStatic.calculateMaxBorrow(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      expect(utilizationAfterOpen.availableCapitalUSD).to.equal(parseEther("19"));
      expect(maxBorrowAvailable).to.equal(parseEther("38"));

      // Scale position by borrowing the full available amount (use up all available capacity)
      const scaleSwapData = await createSwapMulticallData(
        swapHelper,
        collateralToken,
        leverageManager.address,
        maxBorrowAvailable,
        ethers.utils.formatBytes32String("util-scale-max"),
        borrowToken,
      );
      await relativePositionManager
        .connect(alice)
        .openPosition(
          collateralMarket.address,
          borrowMarket.address,
          noAdditionalPrincipal,
          maxBorrowAvailable,
          parseEther("1"),
          scaleSwapData,
        );

      // After scaling to max, available for borrow should be 0
      const utilizationAfterScale = await relativePositionManager.callStatic.getUtilizationInfo(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      const maxBorrowAfterScale = await relativePositionManager.callStatic.calculateMaxBorrow(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      expect(utilizationAfterScale.availableCapitalUSD).to.equal(0);
      expect(maxBorrowAfterScale).to.equal(0);
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
          noAdditionalPrincipal,
          shortAmount,
          minLongAmount,
          openSwapData,
        );

      await expect(
        relativePositionManager.connect(alice).deactivatePosition(collateralMarket.address, borrowMarket.address),
      ).to.be.revertedWithCustomError(relativePositionManager, "PositionNotFullyClosed");
    });

    it("should succeed when position is active with principal but no open collateral or debt", async () => {
      // Activate a position with some principal supplied but no open long/short; in this state
      // deactivation should be allowed and all principal should be withdrawn back to the user.
      const principalAmount = parseEther("20");
      await dsaToken.connect(admin).transfer(aliceAddress, principalAmount);
      await dsaToken.connect(alice).approve(relativePositionManager.address, principalAmount);

      await relativePositionManager
        .connect(alice)
        .activatePosition(collateralMarket.address, borrowMarket.address, dsaIndex, principalAmount, parseEther("2"));

      // After activation Alice's DSA balance is 0; deactivate will return principal to her
      const aliceBalanceBeforeDeactivate = await dsaToken.balanceOf(aliceAddress);
      expect(aliceBalanceBeforeDeactivate).to.equal(0);

      await expect(
        relativePositionManager.connect(alice).deactivatePosition(collateralMarket.address, borrowMarket.address),
      ).to.emit(relativePositionManager, "PositionDeactivated");

      const position = await relativePositionManager.getPosition(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );

      const positionAccountAddr = position.positionAccount;

      expect(position.isActive).to.be.false;
      // No principal should remain recorded on the position after deactivation
      expect(position.suppliedPrincipal).to.equal(0);

      // All three assets (collateral, borrow and DSA principal market) should have zero
      // balances for the position account after deactivation.
      const collateralAfter = await collateralMarket.callStatic.balanceOfUnderlying(positionAccountAddr);
      const borrowAfter = await borrowMarket.callStatic.borrowBalanceCurrent(positionAccountAddr);
      const dsaUnderlyingAfter = await dsaMarket.callStatic.balanceOfUnderlying(positionAccountAddr);
      expect(collateralAfter).to.equal(0);
      expect(borrowAfter).to.equal(0);
      expect(dsaUnderlyingAfter).to.equal(0);

      // Principal was withdrawn to user by deactivatePosition
      const aliceBalanceAfter = await dsaToken.balanceOf(aliceAddress);
      expect(aliceBalanceAfter.sub(aliceBalanceBeforeDeactivate)).to.equal(principalAmount);
    });
  });

  describe("DSA change on reactivation", () => {
    const principalAmount = parseEther("20");
    const SLIPPAGE_BPS = 500; // 5%
    const initialDsaIndex = 0; // first DSA (dsaMarket) from fixture
    const newDsaIndex = 1; // second DSA (usdcMarket) added in beforeEach

    beforeEach(async () => {
      // Add a second DSA market so we can switch to a different DSA on reactivation
      await relativePositionManager.connect(admin).addDSAVToken(usdcMarket.address);

      // Step 1: user activates a position with the initial DSA (index 0) and supplies principal
      await dsaToken.connect(admin).transfer(aliceAddress, principalAmount);
      await dsaToken.connect(alice).approve(relativePositionManager.address, principalAmount);

      await relativePositionManager
        .connect(alice)
        .activatePosition(
          collateralMarket.address,
          borrowMarket.address,
          initialDsaIndex,
          principalAmount,
          parseEther("2"),
        );

      // Step 2: open a leveraged position and then fully close it with profit, leaving principal supplied on the position
      const shortAmount = parseEther("1");
      const minLongAmount = parseEther("0.9");
      const longReceivedAfterSwap = parseEther("0.95");

      const openSwapData = await createSwapMulticallData(
        swapHelper,
        collateralToken,
        leverageManager.address,
        longReceivedAfterSwap,
        ethers.utils.formatBytes32String("dsa-change-open"),
        borrowToken, // tokenIn: opposite token — sweep any leftover borrow from SwapHelper
      );

      await relativePositionManager
        .connect(alice)
        .openPosition(
          collateralMarket.address,
          borrowMarket.address,
          noAdditionalPrincipal,
          shortAmount,
          minLongAmount,
          openSwapData,
        );

      // Set prices so that longValueUSD > borrowValueUSD (profit scenario)
      const longPrice = parseUnits("2", 18);
      const shortPrice = parseUnits("1", 18);
      const dsaPrice = parseUnits("1", 18);
      resilientOracle.getUnderlyingPrice.whenCalledWith(collateralMarket.address).returns(longPrice);
      resilientOracle.getUnderlyingPrice.whenCalledWith(borrowMarket.address).returns(shortPrice);
      resilientOracle.getUnderlyingPrice.whenCalledWith(dsaMarket.address).returns(dsaPrice);

      const positionBeforeClose = await relativePositionManager.getPosition(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      const positionAccountAddr = positionBeforeClose.positionAccount;

      // Minimum short we need to repay (exact borrow balance)
      const currentShortDebt = await borrowMarket.callStatic.borrowBalanceCurrent(positionAccountAddr);
      // Repay swap: 2% more than minimum, to model an exact-in swap with dust
      const repaySwapAmount = currentShortDebt.mul(102).div(100);

      // Long to redeem for repay: at price long=2, short=1, 1 short needs 0.5 long; give 5% buffer
      const collateralAmountToRedeemForRepay = parseEther("0.53");
      const excessLong = longReceivedAfterSwap.sub(collateralAmountToRedeemForRepay);

      const swapDataRepay = await createSwapMulticallData(
        swapHelper,
        borrowToken,
        leverageManager.address,
        repaySwapAmount,
        ethers.utils.formatBytes32String("dsa-change-repay"),
        collateralToken, // tokenIn: long redeemed for repay is consumed by sweep to dead
      );

      // Profit leg: exact long to spend (excess). At long=2, DSA=1 we compute a theoretical DSA out and apply 5% slippage
      const amountToRedeemForProfitSwap = excessLong;
      const theoreticalDsaOut = amountToRedeemForProfitSwap.mul(longPrice).div(dsaPrice);
      const minAmountOutProfit = theoreticalDsaOut.mul(10000 - SLIPPAGE_BPS).div(10000); // 5%

      const dsaOutActual = minAmountOutProfit.add(parseEther("0.01")); // a bit more to simulate positive dust
      const swapDataProfit = await createSwapMulticallData(
        swapHelper,
        dsaToken,
        relativePositionManager.address,
        dsaOutActual,
        ethers.utils.formatBytes32String("dsa-change-profit"),
        collateralToken, // tokenIn: long is consumed by sweep to dead so no side effects
      );

      await relativePositionManager.connect(alice).closeWithProfit(
        collateralMarket.address,
        borrowMarket.address,
        BPS_100_PCT,
        collateralAmountToRedeemForRepay,
        currentShortDebt, // minAmountOutRepay
        swapDataRepay,
        amountToRedeemForProfitSwap,
        minAmountOutProfit,
        swapDataProfit,
      );

      const positionAfterClose = await relativePositionManager.getPosition(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      expect(positionAfterClose.suppliedPrincipal).to.be.gt(0);
      expect(positionAfterClose.dsaIndex).to.equal(initialDsaIndex);
      expect(positionAfterClose.isActive).to.be.false;
    });

    it("should revert when changing DSA if principal is not withdrawn", async () => {
      // After beforeEach, position is inactive with suppliedPrincipal > 0. Activating with newDsaIndex without withdrawing reverts.
      await expect(
        relativePositionManager
          .connect(alice)
          .activatePosition(
            collateralMarket.address,
            borrowMarket.address,
            newDsaIndex,
            noAdditionalPrincipal,
            parseEther("2"),
          ),
      ).to.be.revertedWithCustomError(relativePositionManager, "WithdrawPrincipalBeforeChangingDSA");
    });

    it("should allow reactivation with new DSA after full principal withdrawal and deactivation", async () => {
      const positionBefore = await relativePositionManager.getPosition(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      expect(positionBefore.suppliedPrincipal).to.be.gt(0);
      // After 100% close in beforeEach, position is already inactive; no need to call deactivatePosition
      expect(positionBefore.isActive).to.be.false;

      const principalUnderlying = await relativePositionManager.callStatic.getSuppliedPrincipalBalance(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      await relativePositionManager
        .connect(alice)
        .withdrawPrincipal(collateralMarket.address, borrowMarket.address, principalUnderlying);

      const positionAfterWithdraw = await relativePositionManager.getPosition(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      expect(positionAfterWithdraw.suppliedPrincipal).to.equal(0);

      await expect(
        relativePositionManager
          .connect(alice)
          .activatePosition(
            collateralMarket.address,
            borrowMarket.address,
            newDsaIndex,
            noAdditionalPrincipal,
            parseEther("2"),
          ),
      ).to.emit(relativePositionManager, "PositionActivated");

      const positionAfterReactivation = await relativePositionManager.getPosition(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      expect(positionAfterReactivation.isActive).to.be.true;
      expect(positionAfterReactivation.dsaIndex).to.equal(newDsaIndex);
    });
  });
});
