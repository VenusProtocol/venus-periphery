import { FakeContract, smock } from "@defi-wonderland/smock";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
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

async function fundAndApproveToken(
  token: EIP20Interface,
  from: Signer,
  to: string,
  toSigner: Signer,
  spender: string,
  amount: BigNumber,
): Promise<void> {
  await token.connect(from).transfer(to, amount);
  await token.connect(toSigner).approve(spender, amount);
}

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
  const initialPrincipal = parseEther("10"); // Required for activateAndOpenPosition

  const BPS_BASE = 10000; // 100% in basis points
  const BPS_50_PCT = 5000; // 50%
  const BPS_90_PCT = 9000; // 90%
  const BPS_95_PCT = 9500; // 95%
  const BPS_100_PCT = 10000; // 100%

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

  /**
   * ============================================================================
   * DEPLOYMENT & INITIALIZATION
   * ============================================================================
   */
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

    it("should set PositionAccount implementation via governance-controlled setter (can only be set once)", async () => {
      // Verify implementation is already set from initialization
      const currentImpl = await relativePositionManager.POSITION_ACCOUNT_IMPLEMENTATION();
      expect(currentImpl).to.not.equal(ethers.constants.AddressZero);

      // Try to set a different implementation and expect it to revert (already locked)
      const PositionAccountFactory = await ethers.getContractFactory("PositionAccount");
      const newImpl = await PositionAccountFactory.deploy(
        comptroller.address,
        relativePositionManager.address,
        leverageManager.address,
      );

      await expect(
        relativePositionManager.connect(admin).setPositionAccountImplementation(newImpl.address),
      ).to.be.revertedWithCustomError(relativePositionManager, "PositionAccountImplementationLocked");

      // Verify the implementation is still the original one
      expect(await relativePositionManager.POSITION_ACCOUNT_IMPLEMENTATION()).to.equal(currentImpl);
    });
  });

  /**
   * ============================================================================
   * PAUSE & UNPAUSE
   * ============================================================================
   */
  describe("pause", () => {
    it("should block risk-increasing operations when partially paused", async () => {
      await relativePositionManager.connect(admin).partialPause();

      await expect(
        relativePositionManager
          .connect(alice)
          .activateAndOpenPosition(
            collateralMarket.address,
            borrowMarket.address,
            dsaIndex,
            initialPrincipal,
            parseEther("2"),
            parseEther("1"),
            parseEther("0.9"),
            "0x",
          ),
      ).to.be.revertedWithCustomError(relativePositionManager, "PartiallyPaused");

      await expect(
        relativePositionManager
          .connect(alice)
          .scalePosition(
            collateralMarket.address,
            borrowMarket.address,
            noAdditionalPrincipal,
            parseEther("1"),
            0,
            "0x",
          ),
      ).to.be.revertedWithCustomError(relativePositionManager, "PartiallyPaused");

      await expect(
        relativePositionManager
          .connect(alice)
          .withdrawPrincipal(collateralMarket.address, borrowMarket.address, parseEther("1")),
      ).to.be.revertedWithCustomError(relativePositionManager, "PartiallyPaused");

      await expect(
        relativePositionManager.connect(alice).deactivatePosition(collateralMarket.address, borrowMarket.address),
      ).to.be.revertedWithCustomError(relativePositionManager, "PartiallyPaused");
    });

    it("should allow defensive operations when partially paused", async () => {
      await relativePositionManager.connect(admin).partialPause();

      // supplyPrincipal, closeWithProfit, closeWithLoss should NOT revert with PartiallyPaused.
      // They pass the pause guard but revert with PositionNotActive (no active position for alice),
      // proving the partial pause did not block them.
      await expect(
        relativePositionManager
          .connect(alice)
          .supplyPrincipal(collateralMarket.address, borrowMarket.address, parseEther("1")),
      ).to.be.revertedWithCustomError(relativePositionManager, "PositionNotActive");

      await expect(
        relativePositionManager
          .connect(alice)
          .closeWithProfit(collateralMarket.address, borrowMarket.address, BPS_100_PCT, 0, 0, "0x", 0, 0, "0x"),
      ).to.be.revertedWithCustomError(relativePositionManager, "PositionNotActive");

      await expect(
        relativePositionManager
          .connect(alice)
          .closeWithLoss(collateralMarket.address, borrowMarket.address, BPS_100_PCT, 0, 0, 0, "0x", 0, 0, "0x"),
      ).to.be.revertedWithCustomError(relativePositionManager, "PositionNotActive");
    });

    it("should block all state-changing user operations when completely paused", async () => {
      await relativePositionManager.connect(admin).completePause();

      await expect(
        relativePositionManager
          .connect(alice)
          .activateAndOpenPosition(
            collateralMarket.address,
            borrowMarket.address,
            dsaIndex,
            initialPrincipal,
            parseEther("2"),
            parseEther("1"),
            parseEther("0.9"),
            "0x",
          ),
      ).to.be.revertedWithCustomError(relativePositionManager, "CompletelyPaused");

      await expect(
        relativePositionManager
          .connect(alice)
          .supplyPrincipal(collateralMarket.address, borrowMarket.address, parseEther("1")),
      ).to.be.revertedWithCustomError(relativePositionManager, "CompletelyPaused");

      await expect(
        relativePositionManager
          .connect(alice)
          .scalePosition(
            collateralMarket.address,
            borrowMarket.address,
            noAdditionalPrincipal,
            parseEther("1"),
            0,
            "0x",
          ),
      ).to.be.revertedWithCustomError(relativePositionManager, "CompletelyPaused");

      await expect(
        relativePositionManager
          .connect(alice)
          .closeWithProfit(collateralMarket.address, borrowMarket.address, BPS_100_PCT, 0, 0, "0x", 0, 0, "0x"),
      ).to.be.revertedWithCustomError(relativePositionManager, "CompletelyPaused");

      await expect(
        relativePositionManager
          .connect(alice)
          .closeWithLoss(collateralMarket.address, borrowMarket.address, BPS_100_PCT, 0, 0, 0, "0x", 0, 0, "0x"),
      ).to.be.revertedWithCustomError(relativePositionManager, "CompletelyPaused");

      await expect(
        relativePositionManager
          .connect(alice)
          .withdrawPrincipal(collateralMarket.address, borrowMarket.address, parseEther("1")),
      ).to.be.revertedWithCustomError(relativePositionManager, "CompletelyPaused");

      await expect(
        relativePositionManager.connect(alice).deactivatePosition(collateralMarket.address, borrowMarket.address),
      ).to.be.revertedWithCustomError(relativePositionManager, "CompletelyPaused");
    });

    it("should allow activation again after complete unpause", async () => {
      await relativePositionManager.connect(admin).completePause();
      await relativePositionManager.connect(admin).completeUnpause();

      // Approve tokens for the reopened call
      await fundAndApproveToken(
        dsaToken,
        admin,
        aliceAddress,
        alice,
        relativePositionManager.address,
        initialPrincipal,
      );

      // Create proper swap data using the helper
      const swapData = await createSwapMulticallData(
        swapHelper,
        collateralToken,
        leverageManager.address,
        parseEther("1"),
        ethers.utils.formatBytes32String("unpause-test"),
      );

      await expect(
        relativePositionManager
          .connect(alice)
          .activateAndOpenPosition(
            collateralMarket.address,
            borrowMarket.address,
            dsaIndex,
            initialPrincipal,
            parseEther("2"),
            parseEther("1"),
            parseEther("0.9"),
            swapData,
          ),
      )
        .to.emit(relativePositionManager, "PositionActivated")
        .and.to.emit(relativePositionManager, "PositionOpened");
    });
  });

  /**
   * ============================================================================
   * ADD DSA V TOKEN
   * ============================================================================
   */
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

  /**
   * ============================================================================
   * SET DSA V TOKEN ACTIVE
   * ============================================================================
   */
  describe("setDSAVTokenActive", () => {
    it("should allow using DSA when active, block when disabled, and allow again when re-enabled", async () => {
      // Initial DSA (index 0) is configured in the fixture and active
      expect(await relativePositionManager.dsaVTokenIndexCounter()).to.equal(1);

      // 1) Alice can activate with DSA index 0 while it is active
      // Approve tokens for activation
      await fundAndApproveToken(
        dsaToken,
        admin,
        aliceAddress,
        alice,
        relativePositionManager.address,
        initialPrincipal,
      );

      // Create swap data for alice's activation (provide more than minLongAmount to avoid slippage)
      // NOTE: longVToken is dsaMarket, so swap output should be dsaToken!
      const swapData1 = await createSwapMulticallData(
        swapHelper,
        dsaToken, // Output token must match the long asset (dsaMarket)
        leverageManager.address,
        parseEther("1.0"), // Provide 1.0 to exceed minLongAmount of 0.9
        ethers.utils.formatBytes32String("dsa-active-alice"),
      );

      await expect(
        relativePositionManager
          .connect(alice)
          .activateAndOpenPosition(
            dsaMarket.address,
            borrowMarket.address,
            0,
            initialPrincipal,
            parseEther("2"),
            parseEther("1"),
            parseEther("0.9"),
            swapData1,
          ),
      ).to.emit(relativePositionManager, "PositionActivated");

      // 2) Governance disables this DSA for new activations
      await relativePositionManager.connect(admin).setDSAVTokenActive(0, false);

      // 3) Another user (bob) attempting to activate with the same DSA index should now fail
      const [, , bob] = await ethers.getSigners();
      const bobAddress = await bob.getAddress();
      await fundAndApproveToken(dsaToken, admin, bobAddress, bob, relativePositionManager.address, initialPrincipal);

      // Create swap data for bob's failed attempt (still provide enough to avoid slippage if it gets that far)
      // NOTE: Must match the long asset (dsaMarket/dsaToken)
      const swapData2 = await createSwapMulticallData(
        swapHelper,
        dsaToken, // Output token must match the long asset
        leverageManager.address,
        parseEther("1.0"),
        ethers.utils.formatBytes32String("dsa-inactive-bob"),
      );

      await expect(
        relativePositionManager
          .connect(bob)
          .activateAndOpenPosition(
            dsaMarket.address,
            borrowMarket.address,
            0,
            initialPrincipal,
            parseEther("2"),
            parseEther("1"),
            parseEther("0.9"),
            swapData2,
          ),
      ).to.be.revertedWithCustomError(relativePositionManager, "DSAInactive");

      // 4) Re-enable the DSA and activation should succeed again for bob
      await relativePositionManager.connect(admin).setDSAVTokenActive(0, true);

      await expect(
        relativePositionManager
          .connect(bob)
          .activateAndOpenPosition(
            dsaMarket.address,
            borrowMarket.address,
            0,
            initialPrincipal,
            parseEther("2"),
            parseEther("1"),
            parseEther("0.9"),
            swapData2,
          ),
      ).to.emit(relativePositionManager, "PositionActivated");
    });
  });

  /**
   * ============================================================================
   * ACTIVATE AND OPEN POSITION - VALIDATION
   * ============================================================================
   */
  describe("activateAndOpenPosition - validation", () => {
    it("should revert when longVToken is zero", async () => {
      await expect(
        relativePositionManager
          .connect(alice)
          .activateAndOpenPosition(
            ethers.constants.AddressZero,
            borrowMarket.address,
            dsaIndex,
            initialPrincipal,
            parseEther("2"),
            parseEther("1"),
            parseEther("0.9"),
            "0x",
          ),
      ).to.be.revertedWithCustomError(relativePositionManager, "ZeroAddress");
    });

    it("should revert when shortVToken is zero", async () => {
      await expect(
        relativePositionManager
          .connect(alice)
          .activateAndOpenPosition(
            collateralMarket.address,
            ethers.constants.AddressZero,
            dsaIndex,
            initialPrincipal,
            parseEther("2"),
            parseEther("1"),
            parseEther("0.9"),
            "0x",
          ),
      ).to.be.revertedWithCustomError(relativePositionManager, "ZeroAddress");
    });

    it("should revert when market is not listed", async () => {
      await expect(
        relativePositionManager
          .connect(alice)
          .activateAndOpenPosition(
            unlistedMarket.address,
            borrowMarket.address,
            dsaIndex,
            initialPrincipal,
            parseEther("2"),
            parseEther("1"),
            parseEther("0.9"),
            "0x",
          ),
      ).to.be.revertedWithCustomError(relativePositionManager, "AssetNotListed");
    });

    it("should revert when longVToken is vBNB (VBNBNotSupported)", async () => {
      await expect(
        relativePositionManager
          .connect(alice)
          .activateAndOpenPosition(
            vBNBMarket.address,
            borrowMarket.address,
            dsaIndex,
            initialPrincipal,
            parseEther("2"),
            parseEther("1"),
            parseEther("0.9"),
            "0x",
          ),
      ).to.be.revertedWithCustomError(relativePositionManager, "VBNBNotSupported");
    });

    it("should revert when shortVToken is vBNB (VBNBNotSupported)", async () => {
      await expect(
        relativePositionManager
          .connect(alice)
          .activateAndOpenPosition(
            collateralMarket.address,
            vBNBMarket.address,
            dsaIndex,
            initialPrincipal,
            parseEther("2"),
            parseEther("1"),
            parseEther("0.9"),
            "0x",
          ),
      ).to.be.revertedWithCustomError(relativePositionManager, "VBNBNotSupported");
    });

    it("should revert when effective leverage is below minimum", async () => {
      await expect(
        relativePositionManager
          .connect(alice)
          .activateAndOpenPosition(
            collateralMarket.address,
            borrowMarket.address,
            dsaIndex,
            initialPrincipal,
            parseEther("0.5"),
            parseEther("1"),
            parseEther("0.9"),
            "0x",
          ),
      ).to.be.revertedWithCustomError(relativePositionManager, "InvalidLeverage");
    });

    it("should revert when effective leverage is above maximum", async () => {
      await expect(
        relativePositionManager
          .connect(alice)
          .activateAndOpenPosition(
            collateralMarket.address,
            borrowMarket.address,
            dsaIndex,
            initialPrincipal,
            parseEther("11"),
            parseEther("1"),
            parseEther("0.9"),
            "0x",
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

      // Approve tokens for activation (principal uses DSA token)
      await fundAndApproveToken(
        dsaToken,
        admin,
        aliceAddress,
        alice,
        relativePositionManager.address,
        initialPrincipal,
      );

      // Create proper swap data
      const swapData = await createSwapMulticallData(
        swapHelper,
        collateralToken,
        leverageManager.address,
        parseEther("0.9"),
        ethers.utils.formatBytes32String("activate-deploy"),
      );

      await expect(
        relativePositionManager
          .connect(alice)
          .activateAndOpenPosition(
            collateralMarket.address,
            borrowMarket.address,
            dsaIndex,
            initialPrincipal,
            parseEther("2"),
            parseEther("1"),
            parseEther("0.9"),
            swapData,
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
      // Approve tokens for first activation (principal uses DSA token)
      await fundAndApproveToken(
        dsaToken,
        admin,
        aliceAddress,
        alice,
        relativePositionManager.address,
        initialPrincipal.mul(2),
      );

      // Create proper swap data for the first call
      const swapData1 = await createSwapMulticallData(
        swapHelper,
        collateralToken,
        leverageManager.address,
        parseEther("0.9"),
        ethers.utils.formatBytes32String("duplicate-1"),
      );

      await relativePositionManager
        .connect(alice)
        .activateAndOpenPosition(
          collateralMarket.address,
          borrowMarket.address,
          dsaIndex,
          initialPrincipal,
          parseEther("2"),
          parseEther("1"),
          parseEther("0.9"),
          swapData1,
        );

      // Create proper swap data for the second call (which will fail)
      const swapData2 = await createSwapMulticallData(
        swapHelper,
        collateralToken,
        leverageManager.address,
        parseEther("0.9"),
        ethers.utils.formatBytes32String("duplicate-2"),
      );

      await expect(
        relativePositionManager
          .connect(alice)
          .activateAndOpenPosition(
            collateralMarket.address,
            borrowMarket.address,
            dsaIndex,
            initialPrincipal,
            parseEther("2"),
            parseEther("1"),
            parseEther("0.9"),
            swapData2,
          ),
      ).to.be.revertedWithCustomError(relativePositionManager, "PositionAlreadyExists");
    });

    it("should activate with initial principal when user approves and supplies", async () => {
      const amount = parseEther("10");
      await fundAndApproveToken(dsaToken, admin, aliceAddress, alice, relativePositionManager.address, amount);

      // Create proper swap data
      const swapData = await createSwapMulticallData(
        swapHelper,
        collateralToken,
        leverageManager.address,
        parseEther("0.9"),
        ethers.utils.formatBytes32String("activate-principal"),
      );

      await relativePositionManager
        .connect(alice)
        .activateAndOpenPosition(
          collateralMarket.address,
          borrowMarket.address,
          dsaIndex,
          amount,
          parseEther("2"),
          parseEther("1"),
          parseEther("0.9"),
          swapData,
        );

      const position = await relativePositionManager.getPosition(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      expect(position.suppliedPrincipalVTokens).to.be.gt(0);
    });

    it("should reuse existing position account when reactivating a fully closed position", async () => {
      // First activation to deploy and activate position account
      // Approve tokens for first activation
      await fundAndApproveToken(
        dsaToken,
        admin,
        aliceAddress,
        alice,
        relativePositionManager.address,
        initialPrincipal,
      );

      // Create proper swap data for first call
      const swapData1 = await createSwapMulticallData(
        swapHelper,
        collateralToken,
        leverageManager.address,
        parseEther("0.9"),
        ethers.utils.formatBytes32String("reuse-first"),
      );

      await relativePositionManager
        .connect(alice)
        .activateAndOpenPosition(
          collateralMarket.address,
          borrowMarket.address,
          dsaIndex,
          initialPrincipal,
          parseEther("2"),
          parseEther("1"),
          parseEther("0.9"),
          swapData1,
        );

      const positionAfterFirst = await relativePositionManager.getPosition(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      const firstAccount = positionAfterFirst.positionAccount;
      expect(firstAccount).to.not.equal(ethers.constants.AddressZero);

      // Close position first (required before deactivate)
      const positionAccountAddr = firstAccount;
      const currentShortDebt = await borrowMarket.callStatic.borrowBalanceCurrent(positionAccountAddr);
      const longBalance = await collateralMarket.callStatic.balanceOfUnderlying(positionAccountAddr);

      // Close with profit (100% close)
      const repaySwapAmount = currentShortDebt.mul(102).div(100);
      const closeSwapDataRepay = await createSwapMulticallData(
        swapHelper,
        borrowToken,
        leverageManager.address,
        repaySwapAmount,
        ethers.utils.formatBytes32String("reuse-close-repay"),
        collateralToken,
      );

      await relativePositionManager
        .connect(alice)
        .closeWithProfit(
          collateralMarket.address,
          borrowMarket.address,
          BPS_100_PCT,
          longBalance,
          currentShortDebt,
          closeSwapDataRepay,
          parseEther("0"),
          parseEther("0"),
          "0x",
        );

      // Now deactivate after position is fully closed
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
      await fundAndApproveToken(dsaToken, admin, aliceAddress, alice, relativePositionManager.address, newPrincipal);

      // Create proper swap data for second call
      const swapData2 = await createSwapMulticallData(
        swapHelper,
        collateralToken,
        leverageManager.address,
        parseEther("0.9"),
        ethers.utils.formatBytes32String("reuse-second"),
      );

      await relativePositionManager
        .connect(alice)
        .activateAndOpenPosition(
          collateralMarket.address,
          borrowMarket.address,
          dsaIndex,
          newPrincipal,
          parseEther("2"),
          parseEther("1"),
          parseEther("0.9"),
          swapData2,
        );

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

  /**
   * ============================================================================
   * ACTIVATE AND OPEN POSITION
   * ============================================================================
   */
  describe("activateAndOpenPosition", () => {
    it("should activate and open in one call", async () => {
      const principalAmount = parseEther("20");
      const shortAmount = parseEther("1");
      const minLongAmount = parseEther("0.9");

      await fundAndApproveToken(dsaToken, admin, aliceAddress, alice, relativePositionManager.address, principalAmount);

      const swapData = await createSwapMulticallData(
        swapHelper,
        collateralToken,
        leverageManager.address,
        shortAmount,
        ethers.utils.formatBytes32String("activate-open-success"),
      );

      await expect(
        relativePositionManager
          .connect(alice)
          .activateAndOpenPosition(
            collateralMarket.address,
            borrowMarket.address,
            dsaIndex,
            principalAmount,
            parseEther("2"),
            shortAmount,
            minLongAmount,
            swapData,
          ),
      )
        .to.emit(relativePositionManager, "PositionActivated")
        .and.to.emit(relativePositionManager, "PositionOpened");

      const position = await relativePositionManager.getPosition(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      const positionAccount = position.positionAccount;

      const longCollateral = await collateralMarket.callStatic.balanceOfUnderlying(positionAccount);
      const dsaSupplied = await dsaMarket.callStatic.balanceOfUnderlying(positionAccount);
      const borrowOpened = await borrowMarket.callStatic.borrowBalanceCurrent(positionAccount);

      expect(position.isActive).to.be.true;
      expect(position.cycleId).to.equal(1);
      expect(longCollateral).to.be.gte(minLongAmount);
      expect(dsaSupplied).to.equal(principalAmount);
      expect(borrowOpened).to.equal(shortAmount);
    });
  });

  /**
   * ============================================================================
   * SUPPLY PRINCIPAL
   * ============================================================================
   */
  describe("supplyPrincipal", () => {
    beforeEach(async () => {
      // Approve tokens for position activation
      await fundAndApproveToken(
        dsaToken,
        admin,
        aliceAddress,
        alice,
        relativePositionManager.address,
        initialPrincipal,
      );

      // Create swap data
      const swapData = await createSwapMulticallData(
        swapHelper,
        collateralToken,
        leverageManager.address,
        parseEther("0.9"),
        ethers.utils.formatBytes32String("supply-principal-setup"),
      );

      await relativePositionManager
        .connect(alice)
        .activateAndOpenPosition(
          collateralMarket.address,
          borrowMarket.address,
          dsaIndex,
          initialPrincipal,
          parseEther("2"),
          parseEther("1"),
          parseEther("0.9"),
          swapData,
        );
    });

    it("should revert when amount is zero", async () => {
      await expect(
        relativePositionManager.connect(alice).supplyPrincipal(collateralMarket.address, borrowMarket.address, 0),
      ).to.be.revertedWithCustomError(relativePositionManager, "ZeroAmount");
    });

    it("should revert when dust amount rounds down to zero vTokens minted", async () => {
      // Exchange rate is 1e28, so vTokensMinted = floor(amount * 1e18 / 1e28) = floor(amount / 1e10).
      // Any amount < 1e10 rounds down to 0 vTokens, triggering ZeroVTokensMinted.
      const dustAmount = BigNumber.from(10).pow(10).sub(1); // 9_999_999_999 wei — one below the threshold
      await fundAndApproveToken(dsaToken, admin, aliceAddress, alice, relativePositionManager.address, dustAmount);
      await expect(
        relativePositionManager
          .connect(alice)
          .supplyPrincipal(collateralMarket.address, borrowMarket.address, dustAmount),
      ).to.be.revertedWithCustomError(relativePositionManager, "ZeroVTokensMinted");
    });

    it("should revert when position is not active", async () => {
      const signers = await ethers.getSigners();
      const bob = signers[2];
      const bobAddress = await bob.getAddress();
      await fundAndApproveToken(dsaToken, admin, bobAddress, bob, relativePositionManager.address, parseEther("5"));
      await expect(
        relativePositionManager
          .connect(bob)
          .supplyPrincipal(collateralMarket.address, borrowMarket.address, parseEther("1")),
      ).to.be.revertedWithCustomError(relativePositionManager, "PositionNotActive");
    });

    it("should increase principal and emit event", async () => {
      const amount = parseEther("5");
      await fundAndApproveToken(dsaToken, admin, aliceAddress, alice, relativePositionManager.address, amount);

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
      expect(positionAfter.suppliedPrincipalVTokens).to.be.gt(positionBefore.suppliedPrincipalVTokens);
      expect(positionAfter.positionAccount).to.equal(positionBefore.positionAccount);

      const vBalanceAfter = await dsaMarket.balanceOf(positionAfter.positionAccount);
      expect(vBalanceAfter).to.be.gt(vBalanceBefore);
      // Supplied principal in manager storage should exactly match the DSA vToken balance
      expect(positionAfter.suppliedPrincipalVTokens).to.equal(vBalanceAfter);
    });
  });

  /**
   * ============================================================================
   * EXECUTE POSITION ACCOUNT CALL
   * ============================================================================
   */
  describe("executePositionAccountCall", () => {
    let positionAccount: string;

    beforeEach(async () => {
      // Ensure alice has sufficient balance and approval
      await fundAndApproveToken(
        dsaToken,
        admin,
        aliceAddress,
        alice,
        relativePositionManager.address,
        initialPrincipal,
      );

      // Create swap data
      const swapData = await createSwapMulticallData(
        swapHelper,
        collateralToken,
        leverageManager.address,
        parseEther("0.9"),
        ethers.utils.formatBytes32String("execute-call-setup"),
      );

      await relativePositionManager
        .connect(alice)
        .activateAndOpenPosition(
          collateralMarket.address,
          borrowMarket.address,
          0,
          initialPrincipal,
          parseEther("2"),
          parseEther("1"),
          parseEther("0.9"),
          swapData,
        );
      const position = await relativePositionManager.getPosition(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      positionAccount = position.positionAccount;
    });

    it("should revert when caller is not allowed by ACM", async () => {
      accessControl.isAllowedToCall.returns(false);
      await expect(relativePositionManager.connect(alice).executePositionAccountCall(positionAccount, [], [])).to.be
        .reverted;
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
          .executePositionAccountCall(positionAccount, [collateralToken.address], [approveData]),
      ).to.emit(positionAccountContract, "GenericCallExecuted");

      const transferData = collateralToken.interface.encodeFunctionData("transfer", [aliceAddress, transferAmount]);
      await expect(
        relativePositionManager
          .connect(admin)
          .executePositionAccountCall(positionAccount, [collateralToken.address], [transferData]),
      ).to.emit(positionAccountContract, "GenericCallExecuted");

      expect(await collateralToken.balanceOf(aliceAddress)).to.equal(transferAmount);
    });
  });

  /**
   * ============================================================================
   * SCALE POSITION
   * ============================================================================
   */
  describe("scalePosition", () => {
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
          .scalePosition(
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
      await fundAndApproveToken(
        dsaToken,
        admin,
        aliceAddress,
        alice,
        relativePositionManager.address,
        parseEther("10"),
      );

      // First, activate and open position with valid swap data
      const activateSwapData = await createSwapMulticallData(
        swapHelper,
        collateralToken,
        leverageManager.address,
        parseEther("0.9"),
        ethers.utils.formatBytes32String("zero-short-activate"),
      );

      await relativePositionManager
        .connect(alice)
        .activateAndOpenPosition(
          collateralMarket.address,
          borrowMarket.address,
          0,
          parseEther("10"),
          parseEther("2"),
          parseEther("1"),
          parseEther("0.9"),
          activateSwapData,
        );

      // Now test that scalePosition with shortAmount=0 reverts
      const scaleSwapData = await createSwapMulticallData(
        swapHelper,
        collateralToken,
        leverageManager.address,
        parseEther("0"),
        ethers.utils.formatBytes32String("zero-short-scale"),
      );
      await expect(
        relativePositionManager
          .connect(alice)
          .scalePosition(
            collateralMarket.address,
            borrowMarket.address,
            noAdditionalPrincipal,
            0,
            minLongAmount,
            scaleSwapData,
          ),
      ).to.be.revertedWithCustomError(relativePositionManager, "ZeroShortAmount");
    });

    it("should open position successfully when swap data sweeps long to LM", async () => {
      const principalAmount = parseEther("20");
      await fundAndApproveToken(dsaToken, admin, aliceAddress, alice, relativePositionManager.address, principalAmount);

      const swapData = await createSwapMulticallData(
        swapHelper,
        collateralToken,
        leverageManager.address,
        shortAmount,
        ethers.utils.formatBytes32String("open-success"),
      );

      const openTx = await relativePositionManager
        .connect(alice)
        .activateAndOpenPosition(
          collateralMarket.address,
          borrowMarket.address,
          0,
          principalAmount,
          parseEther("2"),
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

    it("should scale position and increase long collateral and short debt", async () => {
      const principalAmount = parseEther("20");
      const effectiveLeverage = parseEther("2");
      const initialShortAmount = parseEther("1");
      const minLongAmount = parseEther("0.9");
      const scaleShortAmount = parseEther("0.5"); // Additional short to borrow during scale

      await fundAndApproveToken(dsaToken, admin, aliceAddress, alice, relativePositionManager.address, principalAmount);

      const positionAccountAddr = await relativePositionManager.getPositionAccountAddress(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );

      // STEP 1: Activate and open position
      const activateSwapData = await createSwapMulticallData(
        swapHelper,
        collateralToken,
        leverageManager.address,
        minLongAmount,
        ethers.utils.formatBytes32String("scale-test-activate"),
      );

      await relativePositionManager
        .connect(alice)
        .activateAndOpenPosition(
          collateralMarket.address,
          borrowMarket.address,
          0,
          principalAmount,
          effectiveLeverage,
          initialShortAmount,
          minLongAmount,
          activateSwapData,
        );

      // Get balances before scaling
      const longBeforeScale = await collateralMarket.callStatic.balanceOfUnderlying(positionAccountAddr);
      const shortBeforeScale = await borrowMarket.callStatic.borrowBalanceCurrent(positionAccountAddr);

      expect(longBeforeScale).to.be.gte(minLongAmount as any);
      expect(shortBeforeScale).to.equal(initialShortAmount as any);

      // STEP 2: Scale position (borrow more short, swap to more long)
      const scaleSwapData = await createSwapMulticallData(
        swapHelper,
        collateralToken,
        leverageManager.address,
        parseEther("0.45"), // Expect less long from smaller short amount
        ethers.utils.formatBytes32String("scale-test-scale"),
      );

      const scaleTx = await relativePositionManager.connect(alice).scalePosition(
        collateralMarket.address,
        borrowMarket.address,
        noAdditionalPrincipal,
        scaleShortAmount,
        parseEther("0.4"), // Lower min due to smaller borrow
        scaleSwapData,
      );

      await expect(scaleTx).to.emit(relativePositionManager, "PositionScaled");

      // Get balances after scaling
      const longAfterScale = await collateralMarket.callStatic.balanceOfUnderlying(positionAccountAddr);
      const shortAfterScale = await borrowMarket.callStatic.borrowBalanceCurrent(positionAccountAddr);

      // Verify scaling increased both long and short
      expect(longAfterScale).to.be.gt(longBeforeScale as any, "Long collateral should increase after scale");
      expect(shortAfterScale).to.be.gt(shortBeforeScale as any, "Short debt should increase after scale");

      // Verify short debt increased by approximately the scaled amount (within rounding tolerance)
      const shortIncrease = shortAfterScale.sub(shortBeforeScale);
      expect(shortIncrease).to.be.closeTo(
        scaleShortAmount,
        parseEther("0.01") as any,
        "Short debt increase should be close to scaled amount",
      );
    });
  });

  /**
   * ============================================================================
   * CLOSE WITH PROFIT
   * ============================================================================
   */
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

      await fundAndApproveToken(dsaToken, admin, aliceAddress, alice, relativePositionManager.address, principalAmount);

      const saltActivate = ethers.utils.formatBytes32String("profit-only-activate");
      const activateSwapData = await createSwapMulticallData(
        swapHelper,
        collateralToken,
        leverageManager.address,
        parseEther("0.9"),
        saltActivate,
      );

      await relativePositionManager
        .connect(alice)
        .activateAndOpenPosition(
          collateralMarket.address,
          borrowMarket.address,
          dsaIndex,
          principalAmount,
          effectiveLeverage,
          parseEther("1"),
          parseEther("0.9"),
          activateSwapData,
        );

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
        .scalePosition(
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

      await fundAndApproveToken(dsaToken, admin, aliceAddress, alice, relativePositionManager.address, principalAmount);

      const saltOpen = ethers.utils.formatBytes32String("close-50-open");
      const openSwapData = await createSwapMulticallData(
        swapHelper,
        collateralToken,
        leverageManager.address,
        shortAmount,
        saltOpen,
      );
      await relativePositionManager
        .connect(alice)
        .activateAndOpenPosition(
          collateralMarket.address,
          borrowMarket.address,
          dsaIndex,
          principalAmount,
          effectiveLeverage,
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

      await fundAndApproveToken(dsaToken, admin, aliceAddress, alice, relativePositionManager.address, principalAmount);

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
        .activateAndOpenPosition(
          collateralMarket.address,
          borrowMarket.address,
          dsaIndex,
          principalAmount,
          effectiveLeverage,
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

      await fundAndApproveToken(dsaToken, admin, aliceAddress, alice, relativePositionManager.address, principalAmount);

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
        .activateAndOpenPosition(
          collateralMarket.address,
          borrowMarket.address,
          dsaIndex,
          principalAmount,
          parseEther("2"),
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
      await expect(closeTx)
        .to.emit(relativePositionManager, "ProfitConverted")
        .withArgs(aliceAddress, positionAccountAddr, amountToRedeemForProfitSwap, anyValue);
      await expect(closeTx).to.emit(relativePositionManager, "PositionClosed");

      // --- Transfers: position account ---
      const positionLongUnderlyingAfter = await collateralMarket.callStatic.balanceOfUnderlying(positionAccountAddr);
      const positionShortDebtAfter = await borrowMarket.callStatic.borrowBalanceCurrent(positionAccountAddr);
      expect(positionLongUnderlyingAfter).to.equal(0);
      expect(positionShortDebtAfter).to.equal(0);

      // --- Principal / user balances ---
      // Repay leg: LM received repaySwapAmount from mock swap; used currentShortDebt to repay; dust = repaySwapAmount - currentShortDebt → user
      const expectedBorrowDustToUser = repaySwapAmount.sub(currentShortDebt);
      const aliceBorrowAfter = await borrowToken.balanceOf(aliceAddress);
      expect(aliceBorrowAfter.sub(aliceBorrowBefore)).to.equal(expectedBorrowDustToUser);

      // Profit leg: profit is now retained as additional DSA principal on the position (no DSA transfer to user)
      const aliceDsaAfter = await dsaToken.balanceOf(aliceAddress);
      expect(aliceDsaAfter.sub(aliceDsaBefore)).to.equal(0);

      // No collateral dust in this setup (all long used in repay + profit swaps)
      const aliceCollateralAfter = await collateralToken.balanceOf(aliceAddress);
      expect(aliceCollateralAfter.sub(aliceCollateralBefore)).to.equal(0);

      // --- Position state: 100% close does NOT deactivate the position automatically ---
      const positionAfter = await relativePositionManager.getPosition(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      expect(positionAfter.isActive).to.be.true;
    });

    it("closeWithProfit: when no debt but long available, 100% close redeems full long as profit and retains it as principal", async () => {
      const principalAmount = parseEther("20");
      const effectiveLeverage = parseEther("2");
      const shortAmount = parseEther("1");
      const minLongAmount = parseEther("0.9");
      const longReceivedFromOpen = parseEther("0.9");

      await fundAndApproveToken(dsaToken, admin, aliceAddress, alice, relativePositionManager.address, principalAmount);

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
        .activateAndOpenPosition(
          collateralMarket.address,
          borrowMarket.address,
          dsaIndex,
          principalAmount,
          effectiveLeverage,
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

      const closeTx = await relativePositionManager
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
        );

      await expect(closeTx)
        .to.emit(relativePositionManager, "ProfitConverted")
        .withArgs(aliceAddress, positionAccountAddr, fullLongAsProfit, anyValue);
      await expect(closeTx).to.emit(relativePositionManager, "PositionClosed");

      expect(await borrowMarket.callStatic.borrowBalanceCurrent(positionAccountAddr)).to.equal(0);
      expect(await collateralMarket.callStatic.balanceOfUnderlying(positionAccountAddr)).to.equal(0);
      const positionAfter = await relativePositionManager.getPosition(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      expect(positionAfter.isActive).to.be.true;
    });

    describe("Treasury Percent Handling", () => {
      it("closeWithProfit (90%): should NOT revert when treasuryPercent is non-zero (profit leg fix)", async () => {
        // Regression test for: _redeemLongAndSwapToDSA() previously used `amountToRedeem` for the
        // swap input, but with treasuryPercent > 0 the vToken sends only `amountToRedeem * (1 - fee)`
        // to the contract. The fix uses `amountReceived` (balance delta) instead, preventing
        // an ERC20 transfer revert when trying to send more tokens than the contract holds.
        const treasuryPercent = parseUnits("1", 16); // 1% = 1e16
        await comptroller._setTreasuryData(admin.address, admin.address, treasuryPercent);
        expect(await comptroller.treasuryPercent()).to.equal(treasuryPercent);

        const principalAmount = parseEther("20");
        const effectiveLeverage = parseEther("2");
        const shortAmount = parseEther("1");
        const minLongAmount = parseEther("0.9");
        const longReceivedFromOpen = parseEther("1");

        await fundAndApproveToken(
          dsaToken,
          admin,
          aliceAddress,
          alice,
          relativePositionManager.address,
          principalAmount,
        );

        const saltOpen = ethers.utils.formatBytes32String("treasury-pct-cwp-open");
        const openSwapData = await createSwapMulticallData(
          swapHelper,
          collateralToken,
          leverageManager.address,
          longReceivedFromOpen,
          saltOpen,
        );
        await relativePositionManager
          .connect(alice)
          .activateAndOpenPosition(
            collateralMarket.address,
            borrowMarket.address,
            dsaIndex,
            principalAmount,
            effectiveLeverage,
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

        // Repay leg: redeem enough long to cover short debt at long=2×short price, with 5% buffer
        const collateralToRedeem = expectedShort.div(2).add(expectedShort.mul(5).div(100));
        const profitLong = expectedLong.sub(collateralToRedeem);

        const repaySwapAmount = expectedShort.mul(102).div(100);
        const saltRepay = ethers.utils.formatBytes32String("treasury-pct-cwp-repay");
        const exitSwapDataRepay = await createSwapMulticallData(
          swapHelper,
          borrowToken,
          leverageManager.address,
          repaySwapAmount,
          saltRepay,
        );

        // Profit leg: with 1% treasuryPercent, the contract receives profitLong * 0.99 from the redeem.
        // The fix in _redeemLongAndSwapToDSA uses amountReceived (not amountToRedeem) for the swap,
        // so the safeTransfer to swapHelper matches the actual balance and does not revert.
        const minAmountOutProfit = profitLong.mul(2).div(100);
        const profitSwapDsaOut = minAmountOutProfit.add(parseEther("0.01"));
        const saltProfit = ethers.utils.formatBytes32String("treasury-pct-cwp-realize");
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
        )
          .to.emit(relativePositionManager, "ProfitConverted")
          .withArgs(aliceAddress, positionAccountAddr, profitLong, anyValue);
      });
    });
  });

  /**
   * ============================================================================
   * CLOSE WITH LOSS
   * ============================================================================
   */
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
      await fundAndApproveToken(dsaToken, admin, aliceAddress, alice, relativePositionManager.address, principalAmount);

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
        .activateAndOpenPosition(
          collateralMarket.address,
          borrowMarket.address,
          dsaIndex,
          principalAmount,
          parseEther("2"),
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

    it("closeWithLoss: should revert when longAmountToRedeemForFirstSwap is zero but shortAmountToRepayForFirstSwap is non-zero", async () => {
      // Regression: first leg is skipped when longAmountToRedeemForFirstSwap == 0, so a non-zero
      // shortAmountToRepayForFirstSwap would illegitimately reduce the second-leg repay without
      // any actual repayment occurring. The guard must revert early (before _getProportionalCloseAmounts).
      const principalAmount = parseEther("20");
      await fundAndApproveToken(dsaToken, admin, aliceAddress, alice, relativePositionManager.address, principalAmount);

      const saltOpen = ethers.utils.formatBytes32String("loss-zero-long-open");
      const openSwapData = await createSwapMulticallData(
        swapHelper,
        collateralToken,
        leverageManager.address,
        parseEther("0.9"),
        saltOpen,
        borrowToken,
      );
      await relativePositionManager
        .connect(alice)
        .activateAndOpenPosition(
          collateralMarket.address,
          borrowMarket.address,
          dsaIndex,
          principalAmount,
          parseEther("2"),
          parseEther("1"),
          parseEther("0.8"),
          openSwapData,
        );

      await expect(
        relativePositionManager.connect(alice).closeWithLoss(
          collateralMarket.address,
          borrowMarket.address,
          BPS_50_PCT,
          0, // longAmountToRedeemForFirstSwap = 0 → first leg skipped
          parseEther("0.1"), // shortAmountToRepayForFirstSwap != 0 → must revert
          parseEther("0.1"),
          "0x",
          0,
          0,
          "0x",
        ),
      ).to.be.revertedWithCustomError(relativePositionManager, "InvalidLongAmountToRedeem");
    });

    it("closeWithLoss (partial 95%): should repay 95% of debt and redeem 95% of long; 5% remains", async () => {
      const principalAmount = parseEther("20");
      await fundAndApproveToken(dsaToken, admin, aliceAddress, alice, relativePositionManager.address, principalAmount);

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
        .activateAndOpenPosition(
          collateralMarket.address,
          borrowMarket.address,
          dsaIndex,
          principalAmount,
          parseEther("2"),
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
        borrowedAmountToRepayFirst.mul(10050).div(10000),
        saltSwapDataFirst,
        collateralToken,
      );
      const saltSwapDataSecond = ethers.utils.formatBytes32String("loss-second");
      const swapDataSecond = await createSwapMulticallData(
        swapHelper,
        borrowToken,
        leverageManager.address,
        amountToRepaySecond.mul(10050).div(10000),
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
            longAmountToRedeemForFirstSwap,
            borrowedAmountToRepayFirst,
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
      await fundAndApproveToken(dsaToken, admin, aliceAddress, alice, relativePositionManager.address, principalAmount);

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
        .activateAndOpenPosition(
          collateralMarket.address,
          borrowMarket.address,
          dsaIndex,
          principalAmount,
          parseEther("2"),
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
      const dsaAmountToRedeemForRepay = amountToRepaySecond.mul(10050).div(10000);
      const saltSwapDataSecond = ethers.utils.formatBytes32String("loss-dsa-only-second");
      const swapDataSecond = await createSwapMulticallData(
        swapHelper,
        borrowToken,
        leverageManager.address,
        amountToRepaySecond.mul(10050).div(10000),
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
            longAmountToRedeemForFirstSwap,
            borrowedAmountToRepayFirst,
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
      await fundAndApproveToken(dsaToken, admin, aliceAddress, alice, relativePositionManager.address, principalAmount);

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
        .activateAndOpenPosition(
          collateralMarket.address,
          borrowMarket.address,
          dsaIndex,
          principalAmount,
          parseEther("2"),
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
        currentShortDebt.mul(10050).div(10000),
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
            longAmountToRedeemForFirstSwap,
            borrowedAmountToRepayFirst,
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
      // 100% close does not deactivate; explicit deactivatePosition is required to flip isActive
      expect(positionAfter.isActive).to.be.true;
    });

    describe("Treasury Percent Handling", () => {
      it("closeWithLoss: should revert with InsufficientWithdrawableAmount when treasuryPercent > 0 and grossed-up dsaAmountToRedeemForSecondSwap exceeds principal", async () => {
        // When treasuryPercent is enabled, the LM redeems a grossed-up amount on behalf of the
        // position account. _validateDsaCloseRedeemAmounts checks the effective (grossed-up) second-leg
        // amount rather than the raw user-supplied amount, so a value that passes the raw check
        // (dsaAmount < principal) but fails after grossing up (dsaAmount / (1 - fee) > principal)
        // should revert with InsufficientWithdrawableAmount.

        const principalAmount = parseEther("5");
        await fundAndApproveToken(
          dsaToken,
          admin,
          aliceAddress,
          alice,
          relativePositionManager.address,
          principalAmount,
        );

        const shortAmount = parseEther("1");
        const minLongAmount = parseEther("0.9");
        const longReceivedFromOpen = parseEther("0.95");
        const openSwapData = await createSwapMulticallData(
          swapHelper,
          dsaToken,
          leverageManager.address,
          longReceivedFromOpen,
          ethers.utils.formatBytes32String("treasury-cwl-dsa-open"),
          borrowToken,
        );
        await relativePositionManager
          .connect(alice)
          .activateAndOpenPosition(
            dsaMarket.address,
            borrowMarket.address,
            dsaIndex,
            principalAmount,
            parseEther("2"),
            shortAmount,
            minLongAmount,
            openSwapData,
          );

        // Enable 5% treasury fee AFTER opening so it only affects the close validation
        const treasuryPercent = parseUnits("5", 16); // 5% = 5e16
        await comptroller._setTreasuryData(await admin.getAddress(), await admin.getAddress(), treasuryPercent);
        expect(await comptroller.treasuryPercent()).to.equal(treasuryPercent);

        // Set a loss price so closeWithLoss is valid
        resilientOracle.getUnderlyingPrice.whenCalledWith(dsaMarket.address).returns(parseUnits("0.9", 18));
        resilientOracle.getUnderlyingPrice.whenCalledWith(borrowMarket.address).returns(parseUnits("1", 18));

        const principalUnderlying = await relativePositionManager.callStatic.getSuppliedPrincipalBalance(
          aliceAddress,
          dsaMarket.address,
          borrowMarket.address,
        );

        // dsaAmountToRedeemForSecondSwap is 98% of principal — passes the raw check (98% < 100%)
        // but grossed-up at 5% treasury: 0.98 * 5 / 0.95 ≈ 5.158 > 5 → should revert
        const dsaAmountToRedeemForSecondSwap = principalUnderlying.mul(98).div(100);

        await expect(
          relativePositionManager
            .connect(alice)
            .closeWithLoss(
              dsaMarket.address,
              borrowMarket.address,
              BPS_100_PCT,
              0,
              0,
              0,
              "0x",
              dsaAmountToRedeemForSecondSwap,
              0,
              "0x",
            ),
        ).to.be.revertedWithCustomError(relativePositionManager, "InsufficientWithdrawableAmount");
      });

      it("closeWithLoss: should revert with InsufficientWithdrawableAmount when treasuryPercent > 0 and grossed-up longAmountToRedeemForFirstSwap exceeds long collateral", async () => {
        // When DSA==long, both legs share the same vToken pool. _validateDsaCloseRedeemAmounts applies
        // treasury grossup to the first-leg amount and validates it against long collateral
        // (total pool minus principal). A value that passes the raw check (98% < 100%) but fails
        // after grossing up at 5% (0.98/0.95 ≈ 1.032 > 1.0 of long collateral) should revert.

        const principalAmount = parseEther("5");
        await fundAndApproveToken(
          dsaToken,
          admin,
          aliceAddress,
          alice,
          relativePositionManager.address,
          principalAmount,
        );

        const shortAmount = parseEther("1");
        const minLongAmount = parseEther("0.9");
        const longReceivedFromOpen = parseEther("0.95");
        const openSwapData = await createSwapMulticallData(
          swapHelper,
          dsaToken,
          leverageManager.address,
          longReceivedFromOpen,
          ethers.utils.formatBytes32String("treasury-cwl-first-leg-open"),
          borrowToken,
        );
        await relativePositionManager
          .connect(alice)
          .activateAndOpenPosition(
            dsaMarket.address,
            borrowMarket.address,
            dsaIndex,
            principalAmount,
            parseEther("2"),
            shortAmount,
            minLongAmount,
            openSwapData,
          );

        // Enable 5% treasury fee AFTER opening so it only affects the close validation
        const treasuryPercent = parseUnits("5", 16); // 5% = 5e16
        await comptroller._setTreasuryData(await admin.getAddress(), await admin.getAddress(), treasuryPercent);

        // Set a loss price so closeWithLoss is valid
        resilientOracle.getUnderlyingPrice.whenCalledWith(dsaMarket.address).returns(parseUnits("0.9", 18));
        resilientOracle.getUnderlyingPrice.whenCalledWith(borrowMarket.address).returns(parseUnits("1", 18));

        const longCollateral = await relativePositionManager.callStatic.getLongCollateralBalance(
          aliceAddress,
          dsaMarket.address,
          borrowMarket.address,
        );

        // longAmountToRedeemForFirstSwap is 98% of long collateral — passes the raw check (98% < 100%)
        // but grossed-up at 5% treasury: 0.98/0.95 ≈ 1.032 > 1.0 → should revert
        const longAmountToRedeemForFirstSwap = longCollateral.mul(98).div(100);

        await expect(
          relativePositionManager
            .connect(alice)
            .closeWithLoss(
              dsaMarket.address,
              borrowMarket.address,
              BPS_100_PCT,
              longAmountToRedeemForFirstSwap,
              0,
              0,
              "0x",
              0,
              0,
              "0x",
            ),
        ).to.be.revertedWithCustomError(relativePositionManager, "InsufficientWithdrawableAmount");
      });
    });
  });

  /**
   * ============================================================================
   * DSA MARKET AS LONG MARKET
   * ============================================================================
   */
  describe("DSA market used as long market (USDT): longVToken == dsaMarket", () => {
    it("openPosition: should increase suppliedPrincipal when additionalPrincipal is provided", async () => {
      const initialPrincipal = parseEther("20");
      const additionalPrincipal = parseEther("5");
      const totalPrincipal = initialPrincipal.add(additionalPrincipal);
      await fundAndApproveToken(dsaToken, admin, aliceAddress, alice, relativePositionManager.address, totalPrincipal);

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
        .activateAndOpenPosition(
          dsaMarket.address,
          borrowMarket.address,
          dsaIndex,
          initialPrincipal,
          parseEther("2"),
          shortAmount,
          minLongAmount,
          openSwapData,
        );

      const positionAfterActivate = await relativePositionManager.getPosition(
        aliceAddress,
        dsaMarket.address,
        borrowMarket.address,
      );
      const positionAccountAddr = positionAfterActivate.positionAccount;

      // Underlying: split total underlying into principal part and long (leveraged) part
      const underlyingAfterOpen = await dsaMarket.callStatic.balanceOfUnderlying(positionAccountAddr);

      const longCollateralAfterOpen = await relativePositionManager.callStatic.getLongCollateralBalance(
        aliceAddress,
        dsaMarket.address,
        borrowMarket.address,
      );

      await relativePositionManager
        .connect(alice)
        .supplyPrincipal(dsaMarket.address, borrowMarket.address, additionalPrincipal);

      const underlyingAfterAdditionalSupply = await dsaMarket.callStatic.balanceOfUnderlying(positionAccountAddr);
      const longCollateralAfterAdditionalSupply = await relativePositionManager.callStatic.getLongCollateralBalance(
        aliceAddress,
        dsaMarket.address,
        borrowMarket.address,
      );

      // Principal balance should increase by the additional principal supplied
      expect(underlyingAfterAdditionalSupply).to.equal(underlyingAfterOpen.add(additionalPrincipal));

      // Long collateral should remain unchanged by additional principal supply
      expect(longCollateralAfterAdditionalSupply).to.equal(longCollateralAfterOpen);
    });

    it("closeWithProfit: should close fully and increase suppliedPrincipal vTokens (profit realized in same underlying)", async () => {
      const principalAmount = parseEther("20");
      await fundAndApproveToken(dsaToken, admin, aliceAddress, alice, relativePositionManager.address, principalAmount);

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
        .activateAndOpenPosition(
          dsaMarket.address,
          borrowMarket.address,
          dsaIndex,
          principalAmount,
          parseEther("2"),
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
      const principalVTokensBefore = positionBeforeProfit.suppliedPrincipalVTokens;
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

      const closeTx = await relativePositionManager.connect(alice).closeWithProfit(
        dsaMarket.address,
        borrowMarket.address,
        BPS_100_PCT, // 100% close
        collateralAmountToRedeemForRepay,
        currentShortDebt, // minAmountOutRepay
        swapDataRepay,
        amountToRedeemForProfitSwap,
        minAmountOutProfit,
        swapDataProfit,
      );

      await expect(closeTx)
        .to.emit(relativePositionManager, "ProfitConverted")
        .withArgs(aliceAddress, positionAccountAddr, amountToRedeemForProfitSwap, anyValue);
      await expect(closeTx).to.emit(relativePositionManager, "PositionClosed");

      const positionAfter = await relativePositionManager.getPosition(
        aliceAddress,
        dsaMarket.address,
        borrowMarket.address,
      );
      expect(positionAfter.isActive).to.be.true;

      // Principal vTokens should increase by exactly the amount implied by the profit leg and current exchange rate.
      const exchangeRate = await dsaMarket.callStatic.exchangeRateCurrent();
      const MANTISSA_ONE = BigNumber.from("1000000000000000000");
      const expectedPrincipalAfter = principalVTokensBefore.add(
        amountToRedeemForProfitSwap.mul(MANTISSA_ONE).div(exchangeRate),
      );
      expect(positionAfter.suppliedPrincipalVTokens).to.equal(expectedPrincipalAfter);
      expect(await borrowMarket.callStatic.borrowBalanceCurrent(positionAccountAddr)).to.equal(0);
      expect(await dsaMarket.balanceOf(positionAccountAddr)).to.equal(positionAfter.suppliedPrincipalVTokens);
    });

    it("closeWithLoss: should close fully; second exit uses same market as DSA/long and reduces principal vTokens", async () => {
      const principalAmount = parseEther("20");
      await fundAndApproveToken(dsaToken, admin, aliceAddress, alice, relativePositionManager.address, principalAmount);

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
        .activateAndOpenPosition(
          dsaMarket.address,
          borrowMarket.address,
          dsaIndex,
          principalAmount,
          parseEther("2"),
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

      const repayFirstSwapAmount = borrowedAmountToRepayFirst.mul(10050).div(10000); // 0.5% extra to model exact-in behavior
      const repaySecondSwapAmount = remainingDebt.mul(10050).div(10000);
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

      const principalVTokensBefore = positionBefore.suppliedPrincipalVTokens;
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
            longAmountToRedeemForFirstSwap,
            borrowedAmountToRepayFirst,
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
      // 100% close does not deactivate; explicit deactivatePosition is required to flip isActive
      expect(positionAfter.isActive).to.be.true;
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

  /**
   * ============================================================================
   * UTILIZATION INFO & MAX BORROW
   * ============================================================================
   */
  describe("getUtilizationInfo and getAvailableShortCapacity", () => {
    it("should return valid utilization info for active position with principal", async () => {
      const principalAmount = parseEther("10");
      await fundAndApproveToken(dsaToken, admin, aliceAddress, alice, relativePositionManager.address, principalAmount);

      // Open and activate - activateAndOpenPosition always opens, so we'll close after
      const saltActivate = ethers.utils.formatBytes32String("utilization-info-activate");
      const activateSwapData = await createSwapMulticallData(
        swapHelper,
        collateralToken,
        leverageManager.address,
        parseEther("1.0"),
        saltActivate,
      );

      await relativePositionManager
        .connect(alice)
        .activateAndOpenPosition(
          collateralMarket.address,
          borrowMarket.address,
          0,
          principalAmount,
          parseEther("2"),
          parseEther("1"),
          parseEther("0.9"),
          activateSwapData,
        );

      // Close position with profit to return to state with principal but no open position
      const positionAccount = (
        await relativePositionManager.getPosition(aliceAddress, collateralMarket.address, borrowMarket.address)
      ).positionAccount;
      const shortDebt = await borrowMarket.callStatic.borrowBalanceCurrent(positionAccount);
      const longBalance = await collateralMarket.callStatic.balanceOfUnderlying(positionAccount);

      // Close position fully
      const closeSwapData = await createSwapMulticallData(
        swapHelper,
        borrowToken,
        leverageManager.address,
        shortDebt.mul(102).div(100),
        ethers.utils.formatBytes32String("utilization-info-close"),
      );

      await relativePositionManager
        .connect(alice)
        .closeWithProfit(
          collateralMarket.address,
          borrowMarket.address,
          BPS_100_PCT,
          longBalance,
          shortDebt,
          closeSwapData,
          0,
          0,
          "0x",
        );

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

    it("should return valid max borrow for active position with principal", async () => {
      const principalAmount = parseEther("10");
      await fundAndApproveToken(dsaToken, admin, aliceAddress, alice, relativePositionManager.address, principalAmount);

      // Open and activate - activateAndOpenPosition always opens, so we'll close after
      const saltActivate = ethers.utils.formatBytes32String("max-borrow-activate");
      const activateSwapData = await createSwapMulticallData(
        swapHelper,
        collateralToken,
        leverageManager.address,
        parseEther("1.0"),
        saltActivate,
      );

      await relativePositionManager
        .connect(alice)
        .activateAndOpenPosition(
          collateralMarket.address,
          borrowMarket.address,
          0,
          principalAmount,
          parseEther("2"),
          parseEther("1"),
          parseEther("0.9"),
          activateSwapData,
        );

      // Close position with profit to return to state with principal but no open position
      const positionAccount = (
        await relativePositionManager.getPosition(aliceAddress, collateralMarket.address, borrowMarket.address)
      ).positionAccount;
      const shortDebt = await borrowMarket.callStatic.borrowBalanceCurrent(positionAccount);
      const longBalance = await collateralMarket.callStatic.balanceOfUnderlying(positionAccount);

      // Close position fully
      const closeSwapData = await createSwapMulticallData(
        swapHelper,
        borrowToken,
        leverageManager.address,
        shortDebt.mul(102).div(100),
        ethers.utils.formatBytes32String("max-borrow-close"),
      );

      await relativePositionManager
        .connect(alice)
        .closeWithProfit(
          collateralMarket.address,
          borrowMarket.address,
          BPS_100_PCT,
          longBalance,
          shortDebt,
          closeSwapData,
          0,
          0,
          "0x",
        );

      const maxBorrow = await relativePositionManager.callStatic.getAvailableShortCapacity(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      // Max borrow = availableCapitalUSD * effectiveLeverage / shortPrice. With available capital 8 and effectiveLeverage = 2, maxBorrow = 16.
      expect(maxBorrow).to.equal(parseEther("16"));
    });

    it("should return utilization with different oracle prices (DSA and short)", async () => {
      const principalAmount = parseEther("10");
      await fundAndApproveToken(dsaToken, admin, aliceAddress, alice, relativePositionManager.address, principalAmount);

      // Set default oracle prices (1 USD per token)
      resilientOracle.getUnderlyingPrice.whenCalledWith(collateralMarket.address).returns(parseUnits("1", 18));
      resilientOracle.getUnderlyingPrice.whenCalledWith(borrowMarket.address).returns(parseUnits("1", 18));
      resilientOracle.getUnderlyingPrice.whenCalledWith(dsaMarket.address).returns(parseUnits("1", 18));

      // Activate and open position with activateAndOpenPosition
      const saltActivate = ethers.utils.formatBytes32String("utilization-prices-activate");
      const activateSwapData = await createSwapMulticallData(
        swapHelper,
        collateralToken,
        leverageManager.address,
        parseEther("1.0"),
        saltActivate,
      );

      await relativePositionManager
        .connect(alice)
        .activateAndOpenPosition(
          collateralMarket.address,
          borrowMarket.address,
          dsaIndex,
          principalAmount,
          parseEther("2"),
          parseEther("1"),
          parseEther("0.9"),
          activateSwapData,
        );

      // Check utilization at default prices (all 1)
      const utilizationAtPrice1 = await relativePositionManager.callStatic.getUtilizationInfo(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      const maxBorrowAtPrice1 = await relativePositionManager.callStatic.getAvailableShortCapacity(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      // At default prices: principal 10, withdrawable ~9.5-10 (accounting for swap slippage)
      // available = principal * CF = 10 * 0.8 = 8; maxBorrow = 8 * 2 = 16
      expect(utilizationAtPrice1.withdrawableAmount).to.be.gte(parseEther("9") as any);
      expect(utilizationAtPrice1.withdrawableAmount).to.be.lte(principalAmount as any);
      expect(utilizationAtPrice1.availableCapitalUSD).to.be.gte(parseEther("7.5") as any);
      expect(utilizationAtPrice1.availableCapitalUSD).to.be.lte(parseEther("10") as any);
      expect(maxBorrowAtPrice1).to.be.gte(parseEther("15") as any);
      expect(maxBorrowAtPrice1).to.be.lte(parseEther("20") as any);

      // Change prices: DSA = 2 (double price), short = 1, long = 1 (same position, different prices)
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
      const maxBorrowAtPrice2 = await relativePositionManager.callStatic.getAvailableShortCapacity(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      // At DSA price 2: suppliedPrincipalUSD = 10 * 2 = 20 (with CF applied)
      // Withdrawable ~9.5-10 (amount doesn't change, only valuation changes)
      expect(utilizationAtPrice2.withdrawableAmount).to.be.gte(parseEther("9") as any);
      expect(utilizationAtPrice2.withdrawableAmount).to.be.lte(principalAmount as any);
      expect(utilizationAtPrice2.availableCapitalUSD).to.be.gte(parseEther("19") as any);
      expect(maxBorrowAtPrice2).to.be.gte(parseEther("38") as any);

      // Same account: after price change (DSA doubled), availableCapitalUSD and maxBorrow increased
      expect(utilizationAtPrice2.availableCapitalUSD).to.be.gt(utilizationAtPrice1.availableCapitalUSD as any);
      expect(maxBorrowAtPrice2).to.be.gt(maxBorrowAtPrice1 as any);
    });

    it("should return lower available capital and max borrow when position has open borrow", async () => {
      const principalAmount = parseEther("10");
      await fundAndApproveToken(dsaToken, admin, aliceAddress, alice, relativePositionManager.address, principalAmount);

      // Baseline: activate first without opening (no short borrow yet)
      const saltActivateBaseline = ethers.utils.formatBytes32String("util-open-borrow-baseline");
      const activateBaselineSwapData = await createSwapMulticallData(
        swapHelper,
        collateralToken,
        leverageManager.address,
        parseEther("1.0"),
        saltActivateBaseline,
      );
      await relativePositionManager
        .connect(alice)
        .activateAndOpenPosition(
          collateralMarket.address,
          borrowMarket.address,
          dsaIndex,
          principalAmount,
          parseEther("2"),
          parseEther("1"),
          parseEther("0.9"),
          activateBaselineSwapData,
        );

      // Check utilization with minimal open position
      const utilizationBefore = await relativePositionManager.callStatic.getUtilizationInfo(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      const maxBorrowBefore = await relativePositionManager.callStatic.getAvailableShortCapacity(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );

      // Now scale the position with much more borrow
      const shortAmount = parseEther("8");
      const minLongAmount = parseEther("0.1");
      const scaleSwapData = await createSwapMulticallData(
        swapHelper,
        collateralToken,
        leverageManager.address,
        parseEther("7"),
        ethers.utils.formatBytes32String("util-open-borrow-scale"),
        borrowToken,
      );
      await relativePositionManager
        .connect(alice)
        .scalePosition(
          collateralMarket.address,
          borrowMarket.address,
          noAdditionalPrincipal,
          shortAmount,
          minLongAmount,
          scaleSwapData,
        );

      const utilization = await relativePositionManager.callStatic.getUtilizationInfo(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      const maxBorrow = await relativePositionManager.callStatic.getAvailableShortCapacity(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      // After opening more borrow, capital is more utilized so available and max borrow should be lower than before
      expect(utilization.availableCapitalUSD).to.be.lt(utilizationBefore.availableCapitalUSD);
      expect(utilization.withdrawableAmount).to.be.lt(utilizationBefore.withdrawableAmount);
      expect(maxBorrow).to.be.lt(maxBorrowBefore);
    });

    it("should return zero available capital and max borrow when position has no principal", async () => {
      // Test: position activated but fully closed (no principal, no open positions)
      // Open and then close the position to test utilization with no remaining capital
      const principalAmount = parseEther("10");
      await fundAndApproveToken(dsaToken, admin, aliceAddress, alice, relativePositionManager.address, principalAmount);

      const saltActivate = ethers.utils.formatBytes32String("no-principal-activate");
      const activateSwapData = await createSwapMulticallData(
        swapHelper,
        collateralToken,
        leverageManager.address,
        parseEther("1.0"),
        saltActivate,
      );

      await relativePositionManager
        .connect(alice)
        .activateAndOpenPosition(
          collateralMarket.address,
          borrowMarket.address,
          dsaIndex,
          principalAmount,
          parseEther("2"),
          parseEther("1"),
          parseEther("0.9"),
          activateSwapData,
        );

      // Close position fully
      const positionAccount = (
        await relativePositionManager.getPosition(aliceAddress, collateralMarket.address, borrowMarket.address)
      ).positionAccount;
      const shortDebt = await borrowMarket.callStatic.borrowBalanceCurrent(positionAccount);
      const longBalance = await collateralMarket.callStatic.balanceOfUnderlying(positionAccount);

      const closeSwapData = await createSwapMulticallData(
        swapHelper,
        borrowToken,
        leverageManager.address,
        shortDebt.mul(102).div(100),
        ethers.utils.formatBytes32String("no-principal-close"),
      );

      await relativePositionManager
        .connect(alice)
        .closeWithProfit(
          collateralMarket.address,
          borrowMarket.address,
          BPS_100_PCT,
          longBalance,
          shortDebt,
          closeSwapData,
          0,
          0,
          "0x",
        );

      // Withdraw principal to have no principal left
      const withdrawableAmount = (
        await relativePositionManager.callStatic.getUtilizationInfo(
          aliceAddress,
          collateralMarket.address,
          borrowMarket.address,
        )
      ).withdrawableAmount;
      await relativePositionManager
        .connect(alice)
        .withdrawPrincipal(collateralMarket.address, borrowMarket.address, withdrawableAmount);

      const utilization = await relativePositionManager.callStatic.getUtilizationInfo(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      expect(utilization.availableCapitalUSD).to.equal(0);
      expect(utilization.withdrawableAmount).to.equal(0);

      const maxBorrow = await relativePositionManager.callStatic.getAvailableShortCapacity(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      expect(maxBorrow).to.equal(0);
    });

    it("should show 0 available for borrow after scaling position to max (use full available capacity)", async () => {
      const principalAmount = parseEther("10");
      await fundAndApproveToken(dsaToken, admin, aliceAddress, alice, relativePositionManager.address, principalAmount);

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
        .activateAndOpenPosition(
          collateralMarket.address,
          borrowMarket.address,
          dsaIndex,
          principalAmount,
          parseEther("2"),
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
      const maxBorrowAvailable = await relativePositionManager.callStatic.getAvailableShortCapacity(
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
        .scalePosition(
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
      const maxBorrowAfterScale = await relativePositionManager.callStatic.getAvailableShortCapacity(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      expect(utilizationAfterScale.availableCapitalUSD).to.equal(0);
      expect(maxBorrowAfterScale).to.equal(0);
    });

    describe("Collateral Factor Impact on Capital Utilization", () => {
      it("should successfully scale position when collateral factors remain unchanged", async () => {
        // Baseline: open position under original CFs (longCF=0.8, dsaCF=0.8) and scale using
        // the full available borrow capacity — no CF change means the scale goes through normally.
        const principalAmount = parseEther("10");
        await fundAndApproveToken(
          dsaToken,
          admin,
          aliceAddress,
          alice,
          relativePositionManager.address,
          principalAmount,
        );

        const openSwapData = await createSwapMulticallData(
          swapHelper,
          collateralToken,
          leverageManager.address,
          parseEther("1"),
          ethers.utils.formatBytes32String("cf-success-open"),
        );

        await relativePositionManager
          .connect(alice)
          .activateAndOpenPosition(
            collateralMarket.address,
            borrowMarket.address,
            dsaIndex,
            principalAmount,
            parseEther("2"),
            parseEther("1"),
            parseEther("0.9"),
            openSwapData,
          );

        const utilization = await relativePositionManager.callStatic.getUtilizationInfo(
          aliceAddress,
          collateralMarket.address,
          borrowMarket.address,
        );
        const maxBorrow = await relativePositionManager.callStatic.getAvailableShortCapacity(
          aliceAddress,
          collateralMarket.address,
          borrowMarket.address,
        );

        // maxBorrow = availableCapitalUSD * effectiveLeverage / shortPrice
        // With shortPrice=1 and effectiveLeverage=2: maxBorrow = availableCapitalUSD * 2
        expect(maxBorrow).to.be.gt(0);
        expect(maxBorrow).to.equal(utilization.availableCapitalUSD.mul(2));

        // Scale with exactly maxBorrow — no CF change so this should succeed without reverting
        const scaleSwapData = await createSwapMulticallData(
          swapHelper,
          collateralToken,
          leverageManager.address,
          maxBorrow,
          ethers.utils.formatBytes32String("cf-success-scale"),
          borrowToken,
        );

        // Scale with full available borrow capacity — should succeed without reverting
        await relativePositionManager
          .connect(alice)
          .scalePosition(
            collateralMarket.address,
            borrowMarket.address,
            noAdditionalPrincipal,
            maxBorrow,
            parseEther("1"),
            scaleSwapData,
          );
      });

      it("should constrain available capital and max borrow when collateral factors are reduced", async () => {
        // effectiveLeverage is stored at activation but getAvailableShortCapacity re-validates it against
        // the current maxLeverageAllowed (derived from live CFs) on every call.
        // If CFs are later reduced, two things happen simultaneously:
        //   1. actualCapitalUtilized rises (lower longCF → more excessBorrowUSD; lower dsaCF → larger divisor),
        //      shrinking availableCapitalUSD.
        //   2. maxLeverageAllowed drops, and the stored leverage is clamped to it, reducing the multiplier.
        // Both effects combine to shrink maxBorrow without any explicit revalidation of effectiveLeverage.
        const principalAmount = parseEther("10");
        await fundAndApproveToken(
          dsaToken,
          admin,
          aliceAddress,
          alice,
          relativePositionManager.address,
          principalAmount,
        );

        // Open position with 2x leverage — effectiveLeverage is stored at activation under original CFs (0.8, 0.8)
        const activateSwapData = await createSwapMulticallData(
          swapHelper,
          collateralToken,
          leverageManager.address,
          parseEther("1.0"),
          ethers.utils.formatBytes32String("cf-reduction-activate"),
        );

        await relativePositionManager
          .connect(alice)
          .activateAndOpenPosition(
            collateralMarket.address,
            borrowMarket.address,
            dsaIndex,
            principalAmount,
            parseEther("2"),
            parseEther("1"),
            parseEther("0.9"),
            activateSwapData,
          );

        // Snapshot utilization under original CFs (longCF=0.8, dsaCF=0.8)
        const utilizationBefore = await relativePositionManager.callStatic.getUtilizationInfo(
          aliceAddress,
          collateralMarket.address,
          borrowMarket.address,
        );
        const maxBorrowBefore = await relativePositionManager.callStatic.getAvailableShortCapacity(
          aliceAddress,
          collateralMarket.address,
          borrowMarket.address,
        );

        // Reduce collateral factors: simulate a market risk event where Venus governance lowers CFs
        // Position's stored effectiveLeverage (2x) now exceeds what would be allowed under new CFs —
        // this is the exact scenario from the CertIK finding.
        const reducedCF = parseEther("0.5");
        const reducedLiqThreshold = parseEther("0.6");
        await comptroller["setCollateralFactor(address,uint256,uint256)"](
          collateralMarket.address, // longVToken CF reduced 0.8 → 0.5
          reducedCF,
          reducedLiqThreshold,
        );
        await comptroller["setCollateralFactor(address,uint256,uint256)"](
          dsaMarket.address, // dsaVToken CF reduced 0.8 → 0.5
          reducedCF,
          reducedLiqThreshold,
        );

        // Check utilization after CF reduction — live CFs flow through actualCapitalUtilized
        const utilizationAfter = await relativePositionManager.callStatic.getUtilizationInfo(
          aliceAddress,
          collateralMarket.address,
          borrowMarket.address,
        );
        const maxBorrowAfter = await relativePositionManager.callStatic.getAvailableShortCapacity(
          aliceAddress,
          collateralMarket.address,
          borrowMarket.address,
        );

        expect(utilizationAfter.actualCapitalUtilized).to.be.gt(utilizationBefore.actualCapitalUtilized as any);
        expect(utilizationAfter.availableCapitalUSD).to.be.lt(utilizationBefore.availableCapitalUSD as any);
        expect(maxBorrowAfter).to.be.lt(maxBorrowBefore as any);
        // After CF drop the clamped leverage < stored 2x, so maxBorrow < availableCapitalUSD * 2
        expect(maxBorrowAfter).to.be.lt(utilizationAfter.availableCapitalUSD.mul(2) as any);
      });

      it("should revert scale with BorrowAmountExceedsMaximum when CF drop reduces maxBorrow to zero", async () => {
        // Scenario: position opened under original CFs, then CFs are dropped sharply.
        // getAvailableShortCapacity clamps the stored leverage against the live maxLeverageAllowed,
        // so both the leverage multiplier and availableCapitalUSD shrink together.
        // The stored effectiveLeverage remains unchanged in storage, but the revalidation
        // against current CFs in getAvailableShortCapacity prevents over-leveraging on any new borrow.
        const principalAmount = parseEther("10");
        await fundAndApproveToken(
          dsaToken,
          admin,
          aliceAddress,
          alice,
          relativePositionManager.address,
          principalAmount,
        );

        const openSwapData = await createSwapMulticallData(
          swapHelper,
          collateralToken,
          leverageManager.address,
          parseEther("1"),
          ethers.utils.formatBytes32String("cf-scale-revert-open"),
        );

        await relativePositionManager
          .connect(alice)
          .activateAndOpenPosition(
            collateralMarket.address,
            borrowMarket.address,
            dsaIndex,
            principalAmount,
            parseEther("2"),
            parseEther("1"),
            parseEther("0.9"),
            openSwapData,
          );

        // Verify pre-drop state: getMaxLeverage > stored 2x, maxBorrow > 0
        const maxLeverageBefore = await relativePositionManager.getMaxLeverageAllowed(
          dsaMarket.address,
          collateralMarket.address,
        );
        const maxBorrowBefore = await relativePositionManager.callStatic.getAvailableShortCapacity(
          aliceAddress,
          collateralMarket.address,
          borrowMarket.address,
        );
        const storedLeverage = (
          await relativePositionManager.getPosition(aliceAddress, collateralMarket.address, borrowMarket.address)
        ).effectiveLeverage;

        expect(maxLeverageBefore).to.be.gt(parseEther("2") as any); // ~3.84x under original CFs
        expect(maxBorrowBefore).to.be.gt(0);
        expect(storedLeverage).to.equal(parseEther("2"));

        // Drop CFs sharply: longCF 0.8→0.2, dsaCF 0.8→0.08
        // stored effectiveLeverage (2x) now exceeds getMaxLeverage (~0.1x → capped at 1x MIN)
        await comptroller["setCollateralFactor(address,uint256,uint256)"](
          collateralMarket.address,
          parseEther("0.2"),
          parseEther("0.3"),
        );
        await comptroller["setCollateralFactor(address,uint256,uint256)"](
          dsaMarket.address,
          parseEther("0.08"),
          parseEther("0.1"),
        );

        const maxLeverageAfter = await relativePositionManager.getMaxLeverageAllowed(
          dsaMarket.address,
          collateralMarket.address,
        );
        const maxBorrowAfter = await relativePositionManager.callStatic.getAvailableShortCapacity(
          aliceAddress,
          collateralMarket.address,
          borrowMarket.address,
        );
        const storedLeverageAfter = (
          await relativePositionManager.getPosition(aliceAddress, collateralMarket.address, borrowMarket.address)
        ).effectiveLeverage;

        expect(maxLeverageAfter).to.equal(parseEther("1")); // capped at MIN_LEVERAGE
        expect(storedLeverageAfter).to.equal(parseEther("2")); // unchanged in storage
        expect(maxBorrowAfter).to.lt(maxBorrowBefore);

        const utilization = await relativePositionManager.callStatic.getUtilizationInfo(
          aliceAddress,
          collateralMarket.address,
          borrowMarket.address,
        );
        const availabeToWithdraw = utilization.availableCapitalUSD;

        // After CF drop the clamped leverage < stored 2x, so maxBorrow < availableCapitalUSD * 2
        expect(maxBorrowAfter).to.be.lt(availabeToWithdraw.mul(2) as any);

        await expect(
          relativePositionManager.connect(alice).scalePosition(
            collateralMarket.address,
            borrowMarket.address,
            noAdditionalPrincipal,
            availabeToWithdraw.mul(2), // shortAmount exceeds maxBorrow after CF drop
            parseEther("1"),
            "0x", // wont be used — reverts before swap
          ),
        ).to.be.revertedWithCustomError(relativePositionManager, "BorrowAmountExceedsMaximum");
      });
    });
  });

  /**
   * ============================================================================
   * WITHDRAW PRINCIPAL
   * ============================================================================
   */
  describe("withdrawPrincipal", () => {
    it("should revert when position is active and amount exceeds withdrawable", async () => {
      // Ensure alice has sufficient balance and approval
      await fundAndApproveToken(
        dsaToken,
        admin,
        aliceAddress,
        alice,
        relativePositionManager.address,
        initialPrincipal,
      );

      const saltActivate = ethers.utils.formatBytes32String("withdraw-exceed-activate");
      const activateSwapData = await createSwapMulticallData(
        swapHelper,
        collateralToken,
        leverageManager.address,
        parseEther("1.0"),
        saltActivate,
      );

      await relativePositionManager
        .connect(alice)
        .activateAndOpenPosition(
          collateralMarket.address,
          borrowMarket.address,
          0,
          initialPrincipal,
          parseEther("2"),
          parseEther("1"),
          parseEther("0.9"),
          activateSwapData,
        );
      await expect(
        relativePositionManager
          .connect(alice)
          .withdrawPrincipal(collateralMarket.address, borrowMarket.address, parseEther("1000")),
      ).to.be.revertedWithCustomError(relativePositionManager, "InsufficientWithdrawableAmount");
    });

    it("should withdraw principal when position is active and amount is withdrawable", async () => {
      const principalAmount = parseEther("20");
      await fundAndApproveToken(dsaToken, admin, aliceAddress, alice, relativePositionManager.address, principalAmount);

      const saltActivate = ethers.utils.formatBytes32String("withdraw-activte");
      const activateSwapData = await createSwapMulticallData(
        swapHelper,
        collateralToken,
        leverageManager.address,
        parseEther("1.0"),
        saltActivate,
      );

      await relativePositionManager
        .connect(alice)
        .activateAndOpenPosition(
          collateralMarket.address,
          borrowMarket.address,
          0,
          principalAmount,
          parseEther("2"),
          parseEther("1"),
          parseEther("0.9"),
          activateSwapData,
        );
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

    it("should remain usable and allow withdrawing extra principal minted via mintBehalf", async () => {
      const [, , bob] = await ethers.getSigners();
      const principalAmount = parseEther("10");
      const extraMintAmount = parseEther("3");

      await fundAndApproveToken(dsaToken, admin, aliceAddress, alice, relativePositionManager.address, principalAmount);

      const saltActivate = ethers.utils.formatBytes32String("withdraw-extra-activate");
      const activateSwapData = await createSwapMulticallData(
        swapHelper,
        collateralToken,
        leverageManager.address,
        parseEther("1.0"),
        saltActivate,
      );

      await relativePositionManager
        .connect(alice)
        .activateAndOpenPosition(
          collateralMarket.address,
          borrowMarket.address,
          dsaIndex,
          principalAmount,
          parseEther("2"),
          parseEther("1"),
          parseEther("0.9"),
          activateSwapData,
        );

      const position = await relativePositionManager.getPosition(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      const positionAccount = position.positionAccount;

      // Check how much can be withdrawn (position is open so not all principal is withdrawable)
      const utilization = await relativePositionManager.callStatic.getUtilizationInfo(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      // mint extra principal from outside
      const bobAddress = await bob.getAddress();
      await fundAndApproveToken(dsaToken, admin, bobAddress, bob, dsaMarket.address, extraMintAmount);
      await dsaMarket.connect(bob).mintBehalf(positionAccount, extraMintAmount);

      const withdrawableAmount = utilization.withdrawableAmount;
      const totalWithdrawAmount = withdrawableAmount.add(extraMintAmount);

      const balanceBefore = await dsaToken.balanceOf(aliceAddress);
      await expect(
        relativePositionManager
          .connect(alice)
          .withdrawPrincipal(collateralMarket.address, borrowMarket.address, totalWithdrawAmount),
      ).to.emit(relativePositionManager, "PrincipalWithdrawn");
      const balanceAfter = await dsaToken.balanceOf(aliceAddress);

      expect(balanceAfter.sub(balanceBefore)).to.equal(totalWithdrawAmount);
    });
  });

  /**
   * ============================================================================
   * DEACTIVATE POSITION
   * ============================================================================
   */
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

      await fundAndApproveToken(dsaToken, admin, aliceAddress, alice, relativePositionManager.address, principalAmount);

      const openSwapData = await createSwapMulticallData(
        swapHelper,
        collateralToken,
        leverageManager.address,
        shortAmount,
        ethers.utils.formatBytes32String("deactivate-not-fully-closed"),
      );

      await relativePositionManager
        .connect(alice)
        .activateAndOpenPosition(
          collateralMarket.address,
          borrowMarket.address,
          0,
          principalAmount,
          parseEther("2"),
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
      await fundAndApproveToken(dsaToken, admin, aliceAddress, alice, relativePositionManager.address, principalAmount);

      const saltActivate = ethers.utils.formatBytes32String("deactivate-principal-activate");
      const activateSwapData = await createSwapMulticallData(
        swapHelper,
        collateralToken,
        leverageManager.address,
        parseEther("1.0"),
        saltActivate,
      );

      await relativePositionManager
        .connect(alice)
        .activateAndOpenPosition(
          collateralMarket.address,
          borrowMarket.address,
          dsaIndex,
          principalAmount,
          parseEther("2"),
          parseEther("1"),
          parseEther("0.9"),
          activateSwapData,
        );

      // First close the position that was opened by activateAndOpenPosition
      const positionAccountAddr = (
        await relativePositionManager.getPosition(aliceAddress, collateralMarket.address, borrowMarket.address)
      ).positionAccount;
      const currentShortDebt = await borrowMarket.callStatic.borrowBalanceCurrent(positionAccountAddr);
      const longBalance = await collateralMarket.callStatic.balanceOfUnderlying(positionAccountAddr);

      // Set oracle prices and close
      resilientOracle.getUnderlyingPrice.whenCalledWith(collateralMarket.address).returns(parseUnits("1", 18));
      resilientOracle.getUnderlyingPrice.whenCalledWith(borrowMarket.address).returns(parseUnits("1", 18));
      resilientOracle.getUnderlyingPrice.whenCalledWith(dsaMarket.address).returns(parseUnits("1", 18));

      const repaySwapAmount = currentShortDebt.mul(102).div(100);
      const closeSwapDataRepay = await createSwapMulticallData(
        swapHelper,
        borrowToken,
        leverageManager.address,
        repaySwapAmount,
        ethers.utils.formatBytes32String("deactivate-close-repay"),
        collateralToken,
      );

      await relativePositionManager
        .connect(alice)
        .closeWithProfit(
          collateralMarket.address,
          borrowMarket.address,
          BPS_100_PCT,
          longBalance,
          currentShortDebt,
          closeSwapDataRepay,
          parseEther("0"),
          parseEther("0"),
          "0x",
        );

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

      expect(position.isActive).to.be.false;
      // No principal should remain recorded on the position after deactivation
      expect(position.suppliedPrincipalVTokens).to.equal(0);

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

  /**
   * ============================================================================
   * DSA CHANGE ON REACTIVATION
   * ============================================================================
   */
  describe("DSA change on reactivation", () => {
    const principalAmount = parseEther("20");
    const SLIPPAGE_BPS = 500; // 5%
    const initialDsaIndex = 0; // first DSA (dsaMarket) from fixture
    const newDsaIndex = 1; // second DSA (usdcMarket) added in beforeEach

    beforeEach(async () => {
      // Add a second DSA market so we can switch to a different DSA on reactivation
      await relativePositionManager.connect(admin).addDSAVToken(usdcMarket.address);

      // Step 1: user activates a position with the initial DSA (index 0) and supplies principal
      await fundAndApproveToken(dsaToken, admin, aliceAddress, alice, relativePositionManager.address, principalAmount);

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
        .activateAndOpenPosition(
          collateralMarket.address,
          borrowMarket.address,
          initialDsaIndex,
          principalAmount,
          parseEther("2"),
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
      expect(positionAfterClose.suppliedPrincipalVTokens).to.be.gt(0);
      expect(positionAfterClose.dsaIndex).to.equal(initialDsaIndex);
      // After 100% close the position remains active; principal is still supplied.
      expect(positionAfterClose.isActive).to.be.true;

      // For DSA change tests we now explicitly deactivate to enforce the invariant that
      // inactive positions have no supplied principal.
      await relativePositionManager.connect(alice).deactivatePosition(collateralMarket.address, borrowMarket.address);

      const positionAfterDeactivate = await relativePositionManager.getPosition(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      expect(positionAfterDeactivate.isActive).to.be.false;
      expect(positionAfterDeactivate.suppliedPrincipalVTokens).to.equal(0);
    });

    it("should allow reactivation with new DSA after full close and explicit deactivation", async () => {
      const positionBefore = await relativePositionManager.getPosition(
        aliceAddress,
        collateralMarket.address,
        borrowMarket.address,
      );
      expect(positionBefore.isActive).to.be.false;
      // After deactivatePosition in beforeEach, principal should have been fully withdrawn
      expect(positionBefore.suppliedPrincipalVTokens).to.equal(0);

      // Reactivating with new DSA (usdcMarket), so need to transfer and approve USDC token
      // Get the underlying token from the vToken
      const usdcUnderlyingAddr = await usdcMarket.underlying();
      const usdcToken = await ethers.getContractAt("EIP20Interface", usdcUnderlyingAddr);
      await usdcToken.connect(admin).transfer(aliceAddress, initialPrincipal);
      await usdcToken.connect(alice).approve(relativePositionManager.address, initialPrincipal);

      const saltActivate = ethers.utils.formatBytes32String("dsa-change-reactivate");
      const activateSwapData = await createSwapMulticallData(
        swapHelper,
        collateralToken,
        leverageManager.address,
        parseEther("1.0"),
        saltActivate,
      );

      await expect(
        relativePositionManager
          .connect(alice)
          .activateAndOpenPosition(
            collateralMarket.address,
            borrowMarket.address,
            newDsaIndex,
            initialPrincipal,
            parseEther("1"),
            parseEther("1"),
            parseEther("0.9"),
            activateSwapData,
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
