import { FakeContract, smock } from "@defi-wonderland/smock";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { Contract, Signer } from "ethers";
import { parseEther, parseUnits } from "ethers/lib/utils";
import { ethers, upgrades } from "hardhat";

import {
  ComptrollerLensInterface,
  ComptrollerMock,
  EIP20Interface,
  IAccessControlManagerV8,
  IProtocolShareReserve,
  InterestRateModel,
  MockVBNB,
  PositionSwapper,
  ResilientOracleInterface,
  SwapHelper,
  VBep20Harness,
  WBNB,
} from "../../../typechain";

type SetupMarketFixture = {
  comptroller: ComptrollerMock;
  vBNB: MockVBNB;
  WBNB: WBNB;
  vWBNB: VBep20Harness;
  positionSwapper: PositionSwapper;
  swapHelper: FakeContract<SwapHelper>;
  vUSDT: VBep20Harness;
  USDT: EIP20Interface;
  vBUSD: VBep20Harness;
  BUSD: EIP20Interface;
};

async function deployBNBMarkets(
  comptroller: Contract,
  acm: string,
  irm: string,
  psr: string,
  admin: string,
): Promise<{ WBNB: WBNB; vBNB: MockVBNB; vWBNB: VBep20Harness }> {
  // Deploy vBNB
  const VBNBFactory = await ethers.getContractFactory("MockVBNB");
  const vBNB = await VBNBFactory.deploy(comptroller.address, irm, parseUnits("1", 28), "Venus BNB", "vBNB", 8, admin);

  await comptroller._setMarketSupplyCaps([vBNB.address], [parseUnits("1000", 18)]);
  await comptroller._setMarketBorrowCaps([vBNB.address], [parseUnits("1000", 18)]);
  await comptroller.supportMarket(vBNB.address);
  await vBNB.setAccessControlManager(acm);

  // Deploy vWBNB
  const WBNBFactory = await ethers.getContractFactory("WBNB");
  const WBNB = await WBNBFactory.deploy();
  await WBNB.deposit({ value: parseEther("50") });

  const vTokenFactory = await ethers.getContractFactory("VBep20Harness");
  const vTokenConfig = {
    initialExchangeRateMantissa: parseUnits("1", 28),
    name: "Venus WBNB",
    symbol: "vWBNB",
    decimals: 8,
    becomeImplementationData: "0x",
  };

  const vWBNB = await vTokenFactory.deploy(
    WBNB.address,
    comptroller.address,
    irm,
    vTokenConfig.initialExchangeRateMantissa,
    vTokenConfig.name,
    vTokenConfig.symbol,
    vTokenConfig.decimals,
    admin,
  );
  await vWBNB.deployed();
  await vWBNB.setAccessControlManager(acm);
  await vWBNB.setProtocolShareReserve(psr);
  await vWBNB.setFlashLoanEnabled(true);
  await comptroller._setMarketSupplyCaps([vWBNB.address], [parseUnits("1000", 18)]);
  await comptroller._setMarketBorrowCaps([vWBNB.address], [parseUnits("1000", 18)]);
  await comptroller.supportMarket(vWBNB.address);
  await comptroller.setIsBorrowAllowed(0, vBNB.address, true);
  await comptroller.setIsBorrowAllowed(0, vWBNB.address, true);
  await WBNB.approve(vWBNB.address, parseUnits("50", 18));
  await vWBNB.mint(parseUnits("20", 18));
  return { WBNB, vBNB, vWBNB };
}

async function deployVToken(
  symbol: string,
  comptroller: Contract,
  acm: string,
  irm: string,
  psr: string,
  admin: string,
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
  await comptroller.supportMarket(vToken.address);
  await comptroller.setIsBorrowAllowed(0, vToken.address, true);
  await mockToken.faucet(parseEther("100"));
  await mockToken.approve(vToken.address, parseEther("50"));
  return { mockToken, vToken };
}

const setupMarketFixture = async (): Promise<SetupMarketFixture> => {
  const [admin] = await ethers.getSigners();
  const accessControl = await smock.fake<IAccessControlManagerV8>("AccessControlManager");
  accessControl.isAllowedToCall.returns(true);
  const comptrollerLens = await smock.fake<ComptrollerLensInterface>("ComptrollerLens");
  const protocolShareReserve = await smock.fake<IProtocolShareReserve>("IProtocolShareReserve");
  const interestRateModel = await smock.fake<InterestRateModel>("InterestRateModelHarness");
  interestRateModel.isInterestRateModel.returns(true);
  const resilientOracle = await smock.fake<ResilientOracleInterface>("ResilientOracleInterface");
  resilientOracle.getUnderlyingPrice.returns(parseUnits("1", 18));

  const comptrollerFactory = await ethers.getContractFactory("ComptrollerMock");
  const comptroller = await comptrollerFactory.deploy();
  await comptroller._setAccessControl(accessControl.address);
  await comptroller._setComptrollerLens(comptrollerLens.address);
  await comptroller.setPriceOracle(resilientOracle.address);

  const { WBNB, vBNB, vWBNB } = await deployBNBMarkets(
    comptroller,
    accessControl.address,
    interestRateModel.address,
    protocolShareReserve.address,
    admin.address,
  );

  const { mockToken: USDT, vToken: vUSDT } = await deployVToken(
    "USDT",
    comptroller,
    accessControl.address,
    interestRateModel.address,
    protocolShareReserve.address,
    admin.address,
  );

  const { mockToken: BUSD, vToken: vBUSD } = await deployVToken(
    "BUSD",
    comptroller,
    accessControl.address,
    interestRateModel.address,
    protocolShareReserve.address,
    admin.address,
  );

  const SwapHelperFactory = await ethers.getContractFactory("SwapHelper");
  const swapHelper = await SwapHelperFactory.deploy(WBNB.address);

  const positionSwapperFactory = await ethers.getContractFactory("PositionSwapper");
  const positionSwapper = await upgrades.deployProxy(positionSwapperFactory, [], {
    constructorArgs: [comptroller.address, swapHelper.address, WBNB.address, vBNB.address, vWBNB.address],
    initializer: "initialize",
    unsafeAllow: ["state-variable-immutable"],
  });

  await comptroller.setWhiteListFlashLoanAccount(positionSwapper.address, true);

  return {
    comptroller,
    vBNB,
    WBNB,
    vWBNB,
    positionSwapper,
    swapHelper,
    vUSDT,
    USDT,
    vBUSD,
    BUSD,
  };
};

describe("positionSwapper", () => {
  let vBNB: MockVBNB;
  let WBNB: WBNB;
  let vWBNB: VBep20Harness;
  let admin: Signer;
  let user1: Signer;
  let comptroller: ComptrollerMock;
  let positionSwapper: PositionSwapper;
  let swapHelper: FakeContract<SwapHelper>;
  let vUSDT: VBep20Harness;
  let USDT: EIP20Interface;
  let vBUSD: VBep20Harness;
  let BUSD: EIP20Interface;
  let user1Address: string;

  beforeEach(async () => {
    [admin, user1] = await ethers.getSigners();
    ({ comptroller, vBNB, WBNB, vWBNB, positionSwapper, swapHelper, vUSDT, USDT, vBUSD, BUSD } = await loadFixture(
      setupMarketFixture,
    ));
    await comptroller.connect(user1).updateDelegate(positionSwapper.address, true);
    await vBNB.connect(user1).mint({ value: parseEther("5") });
    await vUSDT.mint(parseUnits("20", 18));
    await vBUSD.mint(parseUnits("20", 18));
    user1Address = await user1.getAddress();
  });

  describe("swapCollateralNativeToWrapped", () => {
    it("should swapCollateralNativeToWrapped from vBNB to vWBNB", async () => {
      const vTokenBalance = await vBNB.balanceOf(user1Address);
      await vBNB.connect(user1).approve(positionSwapper.address, vTokenBalance);

      const balanceBeforeSwap = await vWBNB.callStatic.balanceOfUnderlying(user1Address);
      expect(balanceBeforeSwap.toString()).to.eq(parseUnits("0", 18));

      await positionSwapper.connect(user1).swapCollateralNativeToWrapped(user1Address);

      const balanceAfterSupplying = await vWBNB.callStatic.balanceOfUnderlying(user1Address);
      expect(balanceAfterSupplying.toString()).to.eq(parseUnits("5", 18));
    });
  });

  describe("swapDebtNativeToWrapped", () => {
    it("should swapDebtNativeToWrapped from vBNB to vWBNB", async () => {
      // Create a Debt for User1 on vBNB market
      await vUSDT.mintBehalf(user1Address, parseEther("15"));
      await comptroller.enterMarket(user1Address, vUSDT.address);
      await vBNB.connect(user1).borrow(parseEther("2"));
      expect(await vBNB.callStatic.borrowBalanceCurrent(user1Address)).to.equals(parseEther("2"));
      expect(await vWBNB.callStatic.borrowBalanceCurrent(user1Address)).to.equals(0n);

      // Swap debt
      await positionSwapper.connect(user1).swapDebtNativeToWrapped(user1Address);
      expect(await vWBNB.callStatic.borrowBalanceCurrent(user1Address)).to.equals(parseEther("2"));
      expect(await vBNB.callStatic.borrowBalanceCurrent(user1Address)).to.equals(0n);
    });
  });

  describe("swapCollateral", () => {
    it("should swapFullCollateral from vWBNB to vUSDT", async () => {
      // Work Around for Unit test call sweep insted of swap calldata
      await USDT.transfer(swapHelper.address, parseUnits("12", 18));
      const sweepData = swapHelper.interface.encodeFunctionData("sweep", [USDT.address, positionSwapper.address]);
      const swapData = [sweepData];

      // Add some Collateral to vWBNB
      await vWBNB.mintBehalf(user1Address, parseUnits("12", 18));
      expect(await vUSDT.callStatic.balanceOf(user1Address)).to.eq(parseUnits("0", 18));
      // Swap Collateral
      await positionSwapper
        .connect(user1)
        .swapFullCollateral(user1Address, vWBNB.address, vUSDT.address, parseUnits("11", 18), swapData);
      expect(await vUSDT.callStatic.balanceOfUnderlying(user1Address)).to.eq(parseUnits("12", 18));
    });
  });

  describe("swapDebt", () => {
    it("should swapFullDebt from vWBNB to vUSDT", async () => {
      // Create a Debt for User1 on vUSDT market
      await vWBNB.mintBehalf(user1Address, parseEther("15"));
      await comptroller.enterMarket(user1Address, vUSDT.address);
      await vUSDT.connect(user1).borrow(parseEther("3"));
      expect(await vUSDT.callStatic.borrowBalanceCurrent(user1Address)).to.equals(parseEther("3"));
      expect(await vBUSD.callStatic.borrowBalanceCurrent(user1Address)).to.equals(0n);

      await USDT.transfer(swapHelper.address, parseUnits("3", 18));
      const sweepData = swapHelper.interface.encodeFunctionData("sweep", [USDT.address, positionSwapper.address]);
      const swapData = [sweepData];

      // Swap Debt
      await positionSwapper
        .connect(user1)
        .swapFullDebt(user1Address, vUSDT.address, vBUSD.address, parseUnits("4", 18), swapData);
      expect(await vUSDT.callStatic.borrowBalanceCurrent(user1Address)).to.equals(0n);
      expect(await vBUSD.callStatic.borrowBalanceCurrent(user1Address)).to.equals(parseEther("4")); // removed debt 3, but opend new debt as 4
      expect(await BUSD.balanceOf(user1Address)).to.equals(parseEther("0")); // remember maxDebtAmountToOpen is slipage and may cause fund loose
    });
  });
});
