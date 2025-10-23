import { FakeContract, MockContract, smock } from "@defi-wonderland/smock";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import chai from "chai";
import { Signer } from "ethers";
import { parseUnits } from "ethers/lib/utils";
import { ethers, upgrades } from "hardhat";

import {
  Comptroller,
  ComptrollerHarness,
  ComptrollerHarness__factory,
  ComptrollerLens__factory,
  IAccessControlManagerV5,
  IAccessControlManagerV8,
  MockPriceOracle__factory,
  MockToken,
  MockToken__factory,
  NativeTokenGateway,
  PoolRegistry,
  PoolRegistry__factory,
  PriceOracle,
  ResilientOracleInterface,
  VBep20Immutable,
  VToken,
  VTokenHarness,
  VTokenHarness__factory,
  WrappedNative,
} from "../../../typechain";
import { makeVToken } from "../util/TokenTestHelpers";

const { expect } = chai;
chai.use(smock.matchers);

type GatewayFixtureCore = {
  oracle: FakeContract<PriceOracle>;
  accessControl: FakeContract<IAccessControlManagerV8>;
  comptroller: MockContract<ComptrollerHarness>;
  usdt: MockContract<MockToken>;
  vusdt: VBep20Immutable;
  vweth: VBep20Immutable;
  weth: WrappedNative;
  nativeTokenGateway: NativeTokenGateway;
};

type GatewayFixtureIL = {
  oracle: FakeContract<ResilientOracleInterface>;
  accessControl: FakeContract<IAccessControlManagerV5>;
  comptroller: Comptroller;
  usdt: MockContract<MockToken>;
  vusdt: VTokenHarness;
  weth: WrappedNative;
  vweth: VTokenHarness;
  nativeTokenGateway: NativeTokenGateway;
};

async function configureVtoken(
  underlyingToken: MockContract<MockToken> | VBep20Immutable,
  name: string,
  symbol: string,
  comptroller: MockContract<ComptrollerHarness>,
  admin: SignerWithAddress,
) {
  const InterstRateModel = await ethers.getContractFactory("InterestRateModelHarness");
  const interestRateModel = await InterstRateModel.deploy(parseUnits("1", 12));
  await interestRateModel.deployed();

  const vTokenFactory = await ethers.getContractFactory("VBep20Immutable");
  const vToken = await vTokenFactory.deploy(
    underlyingToken.address,
    comptroller.address,
    interestRateModel.address,
    parseUnits("1", 28),
    name,
    symbol,
    18,
    admin.address,
  );
  await vToken.deployed();
  return vToken;
}

async function deployGatewayCore(): Promise<GatewayFixtureCore> {
  const [, , user2, admin] = await ethers.getSigners();

  const MockToken = await smock.mock<MockToken__factory>("MockToken");
  const usdt = await MockToken.deploy("USDT", "USDT", 18);

  const accessControl = await smock.fake<IAccessControlManagerV8>("IAccessControlManagerV8");
  accessControl.isAllowedToCall.returns(true);

  const closeFactor = parseUnits("6", 17);
  const liquidationIncentive = parseUnits("1", 18);

  const ComptrollerFactory = await smock.mock<ComptrollerHarness__factory>("ComptrollerHarness");
  const comptroller = await ComptrollerFactory.deploy();

  const ComptrollerLensFactory = await smock.mock<ComptrollerLens__factory>("ComptrollerLens");
  const comptrollerLens = await ComptrollerLensFactory.deploy();

  const fakePriceOracle = await smock.fake<PriceOracle>(
    "@venusprotocol/venus-protocol/contracts/Oracle/PriceOracle.sol:PriceOracle",
  );

  await comptroller._setPriceOracle(fakePriceOracle.address);
  await comptroller._setAccessControl(accessControl.address);
  await comptroller._setCloseFactor(closeFactor);
  await comptroller._setLiquidationIncentive(liquidationIncentive);
  await comptroller._setComptrollerLens(comptrollerLens.address);

  const wethFactory = await ethers.getContractFactory("WrappedNative");
  const weth = await wethFactory.deploy();
  weth.mint(parseUnits("100000000", 18));

  const vusdt = await configureVtoken(usdt, "Venus USDT", "vusdt", comptroller, admin);
  const vweth = await configureVtoken(weth, "Venus WETH", "vweth", comptroller, admin);

  await comptroller._supportMarket(vusdt.address);
  await comptroller._supportMarket(vweth.address);
  await comptroller._setMarketBorrowCaps(
    [vusdt.address, vweth.address],
    [parseUnits("10000", 18), parseUnits("10000", 18)],
  );
  await comptroller._setMarketSupplyCaps(
    [vusdt.address, vweth.address],
    [parseUnits("10000", 18), parseUnits("10000", 18)],
  );
  await comptroller._setCollateralFactor(vusdt.address, parseUnits("5", 17));
  await comptroller._setCollateralFactor(vweth.address, parseUnits("5", 17));

  const nativeTokenGatewayFactory = await ethers.getContractFactory(
    "contracts/Gateway/NativeTokenGateway.sol:NativeTokenGateway",
  );
  const nativeTokenGateway = await nativeTokenGatewayFactory.deploy(vweth.address);

  fakePriceOracle.getUnderlyingPrice.whenCalledWith(vusdt.address).returns(parseUnits("1", 18));
  fakePriceOracle.getUnderlyingPrice.whenCalledWith(vweth.address).returns(parseUnits("1000", 18));

  await usdt.faucet(parseUnits("100000", 18));
  await usdt.transfer(user2.address, parseUnits("10000", 18));

  return {
    oracle: fakePriceOracle,
    comptroller,
    accessControl,
    usdt,
    vusdt,
    weth,
    vweth,
    nativeTokenGateway,
  };
}

async function deployGatewayIL(): Promise<GatewayFixtureIL> {
  const [wallet, , user2] = await ethers.getSigners();

  const MockToken = await smock.mock<MockToken__factory>("MockToken");
  const usdt = await MockToken.deploy("USDT", "USDT", 18);

  const accessControl = await smock.fake<IAccessControlManagerV5>("AccessControlManager");
  accessControl.isAllowedToCall.returns(true);

  const closeFactor = parseUnits("6", 17);
  const liquidationIncentive = parseUnits("1", 18);
  const minLiquidatableCollateral = parseUnits("100", 18);

  const PoolRegistry = await ethers.getContractFactory<PoolRegistry__factory>("PoolRegistry");
  const poolRegistry = (await upgrades.deployProxy(PoolRegistry, [accessControl.address])) as PoolRegistry;

  const Comptroller = await ethers.getContractFactory("Comptroller");
  const comptrollerBeacon = await upgrades.deployBeacon(Comptroller, { constructorArgs: [poolRegistry.address] });

  const maxLoopsLimit = 150;
  const fakePriceOracle = await smock.fake<ResilientOracleInterface>(MockPriceOracle__factory.abi);

  const comptrollerProxy = (await upgrades.deployBeaconProxy(comptrollerBeacon, Comptroller, [
    maxLoopsLimit,
    accessControl.address,
  ])) as Comptroller;

  await comptrollerProxy.setPriceOracle(fakePriceOracle.address);

  // Registering the pool
  await poolRegistry.addPool(
    "Pool 1",
    comptrollerProxy.address,
    closeFactor,
    liquidationIncentive,
    minLiquidatableCollateral,
  );

  await comptrollerProxy.setPriceOracle(fakePriceOracle.address);

  const wethFactory = await ethers.getContractFactory("WrappedNative");
  const weth = await wethFactory.deploy();
  weth.mint(parseUnits("100000000", 18));
  console.log("WETH deployed at ", weth.address);
  const vusdt = await makeVToken<VTokenHarness__factory>(
    {
      underlying: usdt,
      comptroller: comptrollerProxy,
      accessControlManager: accessControl,
      admin: wallet,
      initialExchangeRateMantissa: parseUnits("1", 28),
    },
    { kind: "VTokenHarness" },
  );
  console.log("VUSDT deployed at ", vusdt.address);

  const vweth = await makeVToken<VTokenHarness__factory>(
    {
      underlying: weth,
      comptroller: comptrollerProxy,
      accessControlManager: accessControl,
      admin: wallet,
      initialExchangeRateMantissa: parseUnits("1", 28),
    },
    { kind: "VTokenHarness" },
  );

  const nativeTokenGatewayFactory = await ethers.getContractFactory(
    "contracts/Gateway/NativeTokenGateway.sol:NativeTokenGateway",
  );
  const nativeTokenGateway = await nativeTokenGatewayFactory.deploy(vweth.address);

  fakePriceOracle.getUnderlyingPrice.whenCalledWith(vusdt.address).returns(parseUnits("1", 18));
  fakePriceOracle.getUnderlyingPrice.whenCalledWith(vweth.address).returns(parseUnits("1000", 18));

  const usdtInitialSupply = parseUnits("10", 18);
  await usdt.faucet(usdtInitialSupply);
  await usdt.approve(poolRegistry.address, usdtInitialSupply);
  await poolRegistry.addMarket({
    vToken: vusdt.address,
    collateralFactor: parseUnits("5", 17),
    liquidationThreshold: parseUnits("5", 17),
    initialSupply: usdtInitialSupply,
    vTokenReceiver: wallet.address,
    supplyCap: parseUnits("10000", 18),
    borrowCap: parseUnits("10000", 18),
  });

  const wethInitialSupply = parseUnits("10", 18);
  await weth.approve(poolRegistry.address, usdtInitialSupply);
  await poolRegistry.addMarket({
    vToken: vweth.address,
    collateralFactor: parseUnits("5", 17),
    liquidationThreshold: parseUnits("5", 17),
    initialSupply: wethInitialSupply,
    vTokenReceiver: wallet.address,
    supplyCap: parseUnits("10000", 18),
    borrowCap: parseUnits("10000", 18),
  });

  await usdt.faucet(parseUnits("100000", 18));
  await usdt.transfer(user2.address, parseUnits("10000", 18));

  return {
    oracle: fakePriceOracle,
    comptroller: comptrollerProxy,
    accessControl,
    usdt,
    vusdt,
    weth,
    vweth,
    nativeTokenGateway,
  };
}

describe("NativeTokenGateway", () => {
  describe("Core Pool", () => {
    let deployer: Signer;
    let user1: Signer;
    let user2: Signer;
    let comptroller: MockContract<ComptrollerHarness>;
    let vusdt: VBep20Immutable;
    let vweth: VBep20Immutable;
    let usdt: MockContract<MockToken>;
    let weth: WrappedNative;
    let nativeTokenGateway: NativeTokenGateway;
    const supplyAmount = parseUnits("10", 18);

    beforeEach(async () => {
      ({ comptroller, vusdt, vweth, weth, usdt, nativeTokenGateway } = await loadFixture(deployGatewayCore));
      [deployer, user1, user2] = await ethers.getSigners();

      await comptroller.connect(user1).enterMarkets([vusdt.address, vweth.address]);
      await comptroller.connect(user2).enterMarkets([vusdt.address, vweth.address]);
    });

    describe("wrapAndSupply", () => {
      it("should revert when minter address provided is zero address", async () => {
        await expect(
          nativeTokenGateway.connect(user1).wrapAndSupply(ethers.constants.AddressZero, { value: 0 }),
        ).to.be.revertedWithCustomError(nativeTokenGateway, "ZeroAddressNotAllowed");
      });

      it("should revert when zero amount is provided to mint", async () => {
        await expect(
          nativeTokenGateway.connect(user1).wrapAndSupply(await user1.getAddress(), { value: 0 }),
        ).to.be.revertedWithCustomError(nativeTokenGateway, "ZeroValueNotAllowed");
      });

      it("should wrap and supply eth", async () => {
        await nativeTokenGateway.connect(user1).wrapAndSupply(await user1.getAddress(), { value: supplyAmount });
        const balanceAfterSupplying = await vweth.balanceOf(await user1.getAddress());
        await expect(balanceAfterSupplying.toString()).to.eq(parseUnits("10", 8));
      });
    });

    describe("redeemUnderlyingAndUnwrap", () => {
      beforeEach(async () => {
        await nativeTokenGateway.connect(user1).wrapAndSupply(await user1.getAddress(), { value: supplyAmount });
      });

      it("should revert when zero value is passed", async () => {
        const tx = nativeTokenGateway.connect(user1).redeemUnderlyingAndUnwrap(0);
        await expect(tx).to.be.revertedWithCustomError(nativeTokenGateway, "ZeroValueNotAllowed");
      });

      it("should revert when sender is not approved to redeem on behalf", async () => {
        const tx = nativeTokenGateway.connect(user1).redeemUnderlyingAndUnwrap(parseUnits("10", 18));
        await expect(tx).to.be.revertedWith("not an approved delegate");
      });

      it("should redeem underlying tokens and unwrap and sent it to the user", async () => {
        const redeemAmount = parseUnits("10", 18);
        await comptroller.connect(user1).updateDelegate(nativeTokenGateway.address, true);

        await nativeTokenGateway.connect(user1).redeemUnderlyingAndUnwrap(redeemAmount);
        expect(await vweth.balanceOf(await user1.getAddress())).to.eq(0);
      });
    });

    describe("redeemAndUnwrap", () => {
      beforeEach(async () => {
        await nativeTokenGateway.connect(user1).wrapAndSupply(await user1.getAddress(), { value: supplyAmount });
      });

      it("should revert when zero value is passed", async () => {
        const tx = nativeTokenGateway.connect(user1).redeemAndUnwrap(0);
        await expect(tx).to.be.revertedWithCustomError(nativeTokenGateway, "ZeroValueNotAllowed");
      });

      it("should revert when sender is not approved to redeem on behalf", async () => {
        const tx = nativeTokenGateway.connect(user1).redeemAndUnwrap(parseUnits("10", 18));
        await expect(tx).to.be.revertedWith("not an approved delegate");
      });

      it("should redeem vTokens and unwrap and sent it to the user", async () => {
        const redeemTokens = parseUnits("10", 8);
        await comptroller.connect(user1).updateDelegate(nativeTokenGateway.address, true);

        await nativeTokenGateway.connect(user1).redeemAndUnwrap(redeemTokens);
        expect(await vweth.balanceOf(await user1.getAddress())).to.eq(0);
      });
    });

    describe("borrowAndUnwrap", () => {
      beforeEach(async () => {
        await comptroller._setCollateralFactor(vweth.address, parseUnits("5", 17));
        await comptroller._setCollateralFactor(vusdt.address, parseUnits("5", 17));
        await nativeTokenGateway.connect(user1).wrapAndSupply(await user1.getAddress(), { value: supplyAmount });
      });

      it("should revert when sender is not approved to borrow on behalf", async () => {
        const tx = nativeTokenGateway.connect(user2).borrowAndUnwrap(parseUnits("1", 18));
        await expect(tx).to.be.revertedWith("not an approved delegate");
      });

      it("should borrow and unwrap weth and sent it to borrower", async () => {
        await nativeTokenGateway.connect(user1).wrapAndSupply(await user1.getAddress(), { value: supplyAmount });
        await usdt.connect(user2).approve(vusdt.address, parseUnits("5000", 18));
        await vusdt.connect(user2).mint(parseUnits("5000", 18));

        await comptroller.connect(user2).updateDelegate(nativeTokenGateway.address, true);

        const borrowAmount = parseUnits("2", 18);
        const user2BalancePrevious = await user2.getBalance();
        await nativeTokenGateway.connect(user2).borrowAndUnwrap(borrowAmount);

        expect(await user2.getBalance()).to.closeTo(user2BalancePrevious.add(borrowAmount), parseUnits("1", 15));
      });
    });

    describe("wrapAndRepay", () => {
      it("should wrap and repay", async () => {
        await comptroller._setCollateralFactor(vweth.address, parseUnits("5", 17));
        await comptroller._setCollateralFactor(vusdt.address, parseUnits("5", 17));
        await nativeTokenGateway.connect(user1).wrapAndSupply(await user1.getAddress(), { value: supplyAmount });
        await usdt.connect(user2).approve(vusdt.address, parseUnits("5000", 18));
        await vusdt.connect(user2).mint(parseUnits("5000", 18));
        await vweth.connect(user2).borrow(parseUnits("2", 18));

        const userBalancePrevious = await user2.getBalance();
        await nativeTokenGateway.connect(user2).wrapAndRepay({ value: parseUnits("2.000002", 18) });

        expect(await user2.getBalance()).to.closeTo(userBalancePrevious.sub(parseUnits("2", 18)), parseUnits("1", 16));
        expect(await vweth.balanceOf(await user1.getAddress())).to.gt(0);
      });
    });

    describe("sweepNative", () => {
      it("should revert when called by non owener", async () => {
        await expect(nativeTokenGateway.connect(user1).sweepNative()).to.be.rejectedWith(
          "Ownable: caller is not the owner",
        );
      });

      it("should execute successfully", async () => {
        await user1.sendTransaction({ to: nativeTokenGateway.address, value: ethers.utils.parseEther("10") });

        const previousBalance = await deployer.getBalance();
        await nativeTokenGateway.sweepNative();

        expect(await deployer.getBalance()).to.be.greaterThan(previousBalance);
      });
    });

    describe("SweepToken", () => {
      it("should revert when called by non owner", async () => {
        await expect(nativeTokenGateway.connect(user1).sweepToken(weth.address)).to.be.rejectedWith(
          "Ownable: caller is not the owner",
        );
      });

      it("should sweep all tokens", async () => {
        await weth.transfer(nativeTokenGateway.address, parseUnits("2", 18));

        const ownerPreviousBalance = await weth.balanceOf(await deployer.getAddress());
        await nativeTokenGateway.sweepToken(weth.address);

        expect(await weth.balanceOf(nativeTokenGateway.address)).to.be.eq(0);
        expect(await weth.balanceOf(await deployer.getAddress())).to.be.greaterThan(ownerPreviousBalance);
      });
    });
  });

  describe("Isolated Pool", () => {
    let deployer: Signer;
    let user1: Signer;
    let user2: Signer;
    let comptroller: Comptroller;
    let vusdt: VToken;
    let vweth: VToken;
    let usdt: MockContract<MockToken>;
    let weth: WrappedNative;
    let nativeTokenGateway: NativeTokenGateway;
    const supplyAmount = parseUnits("10", 18);

    beforeEach(async () => {
      ({ comptroller, vusdt, vweth, weth, usdt, nativeTokenGateway } = await loadFixture(deployGatewayIL));
      [deployer, user1, user2] = await ethers.getSigners();

      await comptroller.connect(user1).enterMarkets([vusdt.address, vweth.address]);
      await comptroller.connect(user2).enterMarkets([vusdt.address, vweth.address]);
    });

    describe("wrapAndSupply", () => {
      it("should revert when minter address provided is zero address", async () => {
        await expect(
          nativeTokenGateway.connect(user1).wrapAndSupply(ethers.constants.AddressZero, { value: 0 }),
        ).to.be.revertedWithCustomError(nativeTokenGateway, "ZeroAddressNotAllowed");
      });

      it("should revert when zero amount is provided to mint", async () => {
        await expect(
          nativeTokenGateway.connect(user1).wrapAndSupply(await user1.getAddress(), { value: 0 }),
        ).to.be.revertedWithCustomError(nativeTokenGateway, "ZeroValueNotAllowed");
      });

      it("should wrap and supply eth", async () => {
        await nativeTokenGateway.connect(user1).wrapAndSupply(await user1.getAddress(), { value: supplyAmount });
        const balanceAfterSupplying = await vweth.balanceOf(await user1.getAddress());
        await expect(balanceAfterSupplying.toString()).to.eq(parseUnits("10", 8));
      });
    });

    describe("redeemUnderlyingAndUnwrap", () => {
      beforeEach(async () => {
        await nativeTokenGateway.connect(user1).wrapAndSupply(await user1.getAddress(), { value: supplyAmount });
      });

      it("should revert when zero value is passed", async () => {
        const tx = nativeTokenGateway.connect(user1).redeemUnderlyingAndUnwrap(0);
        await expect(tx).to.be.revertedWithCustomError(nativeTokenGateway, "ZeroValueNotAllowed");
      });

      it("should revert when sender is not approved to redeem on behalf", async () => {
        const tx = nativeTokenGateway.connect(user1).redeemUnderlyingAndUnwrap(parseUnits("10", 18));
        await expect(tx).to.be.revertedWithCustomError(vweth, "DelegateNotApproved");
      });

      it("should redeem underlying tokens and unwrap and sent it to the user", async () => {
        const redeemAmount = parseUnits("10", 18);
        await comptroller.connect(user1).updateDelegate(nativeTokenGateway.address, true);

        await nativeTokenGateway.connect(user1).redeemUnderlyingAndUnwrap(redeemAmount);
        expect(await vweth.balanceOf(await user1.getAddress())).to.eq(0);
      });
    });

    describe("redeemAndUnwrap", () => {
      beforeEach(async () => {
        await nativeTokenGateway.connect(user1).wrapAndSupply(await user1.getAddress(), { value: supplyAmount });
      });

      it("should revert when zero value is passed", async () => {
        const tx = nativeTokenGateway.connect(user1).redeemAndUnwrap(0);
        await expect(tx).to.be.revertedWithCustomError(nativeTokenGateway, "ZeroValueNotAllowed");
      });

      it("should revert when sender is not approved to redeem on behalf", async () => {
        const tx = nativeTokenGateway.connect(user1).redeemAndUnwrap(parseUnits("10", 18));
        await expect(tx).to.be.revertedWithCustomError(vweth, "DelegateNotApproved");
      });

      it("should redeem vTokens and unwrap and sent it to the user", async () => {
        const redeemTokens = parseUnits("10", 8);
        await comptroller.connect(user1).updateDelegate(nativeTokenGateway.address, true);

        await nativeTokenGateway.connect(user1).redeemAndUnwrap(redeemTokens);
        expect(await vweth.balanceOf(await user1.getAddress())).to.eq(0);
      });
    });

    describe("borrowAndUnwrap", () => {
      beforeEach(async () => {
        await nativeTokenGateway.connect(user1).wrapAndSupply(await user1.getAddress(), { value: supplyAmount });
      });

      it("should revert when sender is not approved to borrow on behalf", async () => {
        const tx = nativeTokenGateway.connect(user2).borrowAndUnwrap(parseUnits("1", 18));
        await expect(tx).to.be.revertedWithCustomError(vweth, "DelegateNotApproved");
      });

      it("should borrow and unwrap weth and sent it to borrower", async () => {
        await nativeTokenGateway.connect(user1).wrapAndSupply(await user1.getAddress(), { value: supplyAmount });
        await usdt.connect(user2).approve(vusdt.address, parseUnits("5000", 18));
        await vusdt.connect(user2).mint(parseUnits("5000", 18));

        await comptroller.connect(user2).updateDelegate(nativeTokenGateway.address, true);

        const borrowAmount = parseUnits("2", 18);
        const user2BalancePrevious = await user2.getBalance();
        await nativeTokenGateway.connect(user2).borrowAndUnwrap(borrowAmount);

        expect(await user2.getBalance()).to.closeTo(user2BalancePrevious.add(borrowAmount), parseUnits("1", 15));
      });
    });

    describe("wrapAndRepay", () => {
      it("should wrap and repay", async () => {
        await usdt.connect(user2).approve(vusdt.address, parseUnits("5000", 18));
        await vusdt.connect(user2).mint(parseUnits("5000", 18));
        await vweth.connect(user2).borrow(parseUnits("2", 18));

        const userBalancePrevious = await user2.getBalance();
        await nativeTokenGateway.connect(user2).wrapAndRepay({ value: parseUnits("10", 18) });

        expect(await user2.getBalance()).to.closeTo(userBalancePrevious.sub(parseUnits("2", 18)), parseUnits("1", 16));
        expect(await vweth.balanceOf(await user1.getAddress())).to.eq(0);
      });
    });

    describe("sweepNative", () => {
      it("should revert when called by non owener", async () => {
        await expect(nativeTokenGateway.connect(user1).sweepNative()).to.be.rejectedWith(
          "Ownable: caller is not the owner",
        );
      });

      it("should execute successfully", async () => {
        await user1.sendTransaction({ to: nativeTokenGateway.address, value: ethers.utils.parseEther("10") });

        const previousBalance = await deployer.getBalance();
        await nativeTokenGateway.sweepNative();

        expect(await deployer.getBalance()).to.be.greaterThan(previousBalance);
      });
    });

    describe("SweepToken", () => {
      it("should revert when called by non owner", async () => {
        await expect(nativeTokenGateway.connect(user1).sweepToken(weth.address)).to.be.rejectedWith(
          "Ownable: caller is not the owner",
        );
      });

      it("should sweep all tokens", async () => {
        await weth.transfer(nativeTokenGateway.address, parseUnits("2", 18));

        const ownerPreviousBalance = await weth.balanceOf(await deployer.getAddress());
        await nativeTokenGateway.sweepToken(weth.address);

        expect(await weth.balanceOf(nativeTokenGateway.address)).to.be.eq(0);
        expect(await weth.balanceOf(await deployer.getAddress())).to.be.greaterThan(ownerPreviousBalance);
      });
    });
  });
});
