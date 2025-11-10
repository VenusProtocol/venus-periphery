import { FakeContract, smock } from "@defi-wonderland/smock";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
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
  const swapHelper = await SwapHelperFactory.deploy(WBNB.address, admin.address);

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
  let admin: Wallet;
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

  async function createSweepMulticallData(
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
      const multicallData = await createSweepMulticallData(
        USDT,
        positionSwapper.address,
        parseUnits("12", 18),
        admin,
        ethers.utils.formatBytes32String("2"),
      );
      // Add some Collateral to vWBNB
      await vWBNB.mintBehalf(user1Address, parseUnits("12", 18));
      expect(await vUSDT.callStatic.balanceOf(user1Address)).to.eq(parseUnits("0", 18));
      // Swap Collateral
      await positionSwapper
        .connect(user1)
        .swapFullCollateral(user1Address, vWBNB.address, vUSDT.address, parseUnits("11", 18), [multicallData]);
      expect(await vUSDT.callStatic.balanceOfUnderlying(user1Address)).to.eq(parseUnits("12", 18));
    });

    it("should swapCollateralWithAmount from vWBNB to vUSDT (partial) and verify both balances", async () => {
      // Work Around for Unit test call sweep instead of swap calldata
      const multicallData = await createSweepMulticallData(
        USDT,
        positionSwapper.address,
        parseUnits("5", 18),
        admin,
        ethers.utils.formatBytes32String("3"),
      );
      const swapData = [multicallData];

      // Add some Collateral to vWBNB (12)
      await vWBNB.mintBehalf(user1Address, parseUnits("12", 18));
      expect(await vUSDT.callStatic.balanceOfUnderlying(user1Address)).to.eq(parseUnits("0", 18));
      expect(await vWBNB.callStatic.balanceOfUnderlying(user1Address)).to.eq(parseUnits("12", 18));

      // Swap only part of the collateral (5)
      await positionSwapper
        .connect(user1)
        .swapCollateralWithAmount(
          user1Address,
          vWBNB.address,
          vUSDT.address,
          parseUnits("5", 18),
          parseUnits("5", 18),
          swapData,
        );

      // Verify target market received 5 and source market reduced to 7
      expect(await vUSDT.callStatic.balanceOfUnderlying(user1Address)).to.eq(parseUnits("5", 18));
      expect(await vWBNB.callStatic.balanceOfUnderlying(user1Address)).to.eq(parseUnits("7", 18));
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

      const multicallData = await createSweepMulticallData(
        USDT,
        positionSwapper.address,
        parseUnits("3", 18),
        admin,
        ethers.utils.formatBytes32String("4"),
      );
      const swapData = [multicallData];

      // Swap Debt
      await positionSwapper
        .connect(user1)
        .swapFullDebt(user1Address, vUSDT.address, vBUSD.address, parseUnits("4", 18), swapData);
      expect(await vUSDT.callStatic.borrowBalanceCurrent(user1Address)).to.equals(0n);
      expect(await vBUSD.callStatic.borrowBalanceCurrent(user1Address)).to.equals(parseEther("4")); // removed debt 3, but opend new debt as 4
      expect(await BUSD.balanceOf(user1Address)).to.equals(parseEther("0")); // remember maxDebtAmountToOpen is slipage and may cause fund loose
    });

    it("should swapDebtWithAmount from vUSDT to vBUSD (partial)", async () => {
      // Create a Debt for User1 on vUSDT market
      await vWBNB.mintBehalf(user1Address, parseEther("15"));
      await comptroller.enterMarket(user1Address, vUSDT.address);
      await vUSDT.connect(user1).borrow(parseEther("3"));
      expect(await vUSDT.callStatic.borrowBalanceCurrent(user1Address)).to.equals(parseEther("3"));
      expect(await vBUSD.callStatic.borrowBalanceCurrent(user1Address)).to.equals(0n);

      // Provide USDT for the sweep to simulate swap output (repay 2)
      const multicallData = await createSweepMulticallData(
        USDT,
        positionSwapper.address,
        parseUnits("2", 18),
        admin,
        ethers.utils.formatBytes32String("5"),
      );
      const swapData = [multicallData];

      // Swap only part of the debt; repay 2 USDT, open 3 BUSD
      await positionSwapper
        .connect(user1)
        .swapDebtWithAmount(
          user1Address,
          vUSDT.address,
          vBUSD.address,
          parseUnits("2", 18),
          parseUnits("3", 18),
          swapData,
        );

      expect(await vUSDT.callStatic.borrowBalanceCurrent(user1Address)).to.equals(parseEther("1"));
      expect(await vBUSD.callStatic.borrowBalanceCurrent(user1Address)).to.equals(parseEther("3"));
      expect(await BUSD.balanceOf(user1Address)).to.equals(parseEther("0"));
    });
  });

  describe("with flash loan fee", () => {
    beforeEach(async () => {
      // Set a small flash loan fee: 1% (1e16 mantissa)
      await vWBNB.setFlashLoanFeeMantissa(parseUnits("0.01", 18), parseUnits("0.5", 18));
      await vBUSD.setFlashLoanFeeMantissa(parseUnits("0.01", 18), parseUnits("0.5", 18));
    });

    it("should swapCollateralNativeToWrapped accounting for fee", async () => {
      const vTokenBalance = await vBNB.balanceOf(user1Address);
      await vBNB.connect(user1).approve(positionSwapper.address, vTokenBalance);

      const fee = await vWBNB.flashLoanFeeMantissa();
      const amount = await vBNB.callStatic.balanceOfUnderlying(user1Address);
      const expectedMint = amount.sub(amount.mul(fee).div(parseUnits("1", 18)));

      const before = await vWBNB.callStatic.balanceOfUnderlying(user1Address);
      expect(before.toString()).to.eq(parseUnits("0", 18));

      await positionSwapper.connect(user1).swapCollateralNativeToWrapped(user1Address);

      const afterBal = await vWBNB.callStatic.balanceOfUnderlying(user1Address);
      // Allow small precision differences due to accrued interest during operations
      const tolerance = parseUnits("0.005", 18); // ±0.5% absolute (~5e15 wei)
      expect(afterBal).to.be.closeTo(expectedMint, tolerance);
    });

    it("should swapFullDebt with fee and keep target debt equal to requested amount", async () => {
      // Create a Debt for User1 on vUSDT market
      await vWBNB.mintBehalf(user1Address, parseEther("15"));
      await comptroller.enterMarket(user1Address, vUSDT.address);
      await vUSDT.connect(user1).borrow(parseEther("3"));
      expect(await vUSDT.callStatic.borrowBalanceCurrent(user1Address)).to.equals(parseEther("3"));
      expect(await vBUSD.callStatic.borrowBalanceCurrent(user1Address)).to.equals(0n);

      const multicallData = await createSweepMulticallData(
        USDT,
        positionSwapper.address,
        parseUnits("3", 18),
        admin,
        ethers.utils.formatBytes32String("6"),
      );
      const swapData = [multicallData];

      // Swap Debt: request to open 4 BUSD debt; with fee, borrowed amount > 4, but fee is repaid
      await positionSwapper
        .connect(user1)
        .swapFullDebt(user1Address, vUSDT.address, vBUSD.address, parseUnits("4", 18), swapData);
      const usdtAfter = await vUSDT.callStatic.borrowBalanceCurrent(user1Address);
      const busdAfter = await vBUSD.callStatic.borrowBalanceCurrent(user1Address);
      const targetDebt = parseEther("4");
      const feeMantissa = await vBUSD.flashLoanFeeMantissa();
      const quotedTargetDebt = await positionSwapper.quoteFlashLoanAmount(targetDebt, feeMantissa);
      // Allow small precision differences due to accrued interest during operations
      const absTolerance = parseUnits("0.005", 18); // ±0.5% absolute (~5e15 wei)
      expect(usdtAfter).to.be.closeTo(0, absTolerance);
      expect(busdAfter).to.be.closeTo(quotedTargetDebt, absTolerance);
    });
  });

  describe("quoteFlashLoanAmount", () => {
    it("should net the required amount after subtracting fee from quoted borrow", async () => {
      const required = parseEther("100");
      const fee = parseUnits("0.01", 18); // 1%
      const quoted = await positionSwapper.quoteFlashLoanAmount(required, fee);
      const feeAmount = quoted.mul(fee).div(parseUnits("1", 18));
      const net = quoted.sub(feeAmount);
      const tolerance = required.div(1_000_000);
      expect(net).to.be.closeTo(required, tolerance);
    });
  });

  describe("access and validation", () => {
    it("should revert swapCollateralWithAmount when amount is zero", async () => {
      const swapData: string[] = [];
      await expect(
        positionSwapper
          .connect(user1)
          .swapCollateralWithAmount(user1Address, vWBNB.address, vUSDT.address, 0, parseUnits("1", 18), swapData),
      ).to.be.revertedWithCustomError(positionSwapper, "ZeroAmount");
    });

    it("should revert swapDebtWithAmount when amount is zero", async () => {
      const swapData: string[] = [];
      await expect(
        positionSwapper
          .connect(user1)
          .swapDebtWithAmount(user1Address, vUSDT.address, vBUSD.address, 0, parseUnits("1", 18), swapData),
      ).to.be.revertedWithCustomError(positionSwapper, "ZeroAmount");
    });

    it("should revert swapFullCollateral when no collateral balance", async () => {
      const swapData: string[] = [];
      await expect(
        positionSwapper.connect(user1).swapFullCollateral(user1Address, vUSDT.address, vBUSD.address, 0, swapData),
      ).to.be.revertedWithCustomError(positionSwapper, "InsufficientCollateralBalance");
    });

    it("should revert swapFullDebt when no borrow balance", async () => {
      const swapData: string[] = [];
      await expect(
        positionSwapper
          .connect(user1)
          .swapFullDebt(user1Address, vUSDT.address, vBUSD.address, parseUnits("1", 18), swapData),
      ).to.be.revertedWithCustomError(positionSwapper, "InsufficientBorrowBalance");
    });

    it("owner can sweep token and native; non-owner reverts", async () => {
      // Send some USDT to PositionSwapper
      await USDT.transfer(positionSwapper.address, parseUnits("1", 18));
      // Send some native to PositionSwapper
      const [adminSigner, nonOwner] = await ethers.getSigners();
      await adminSigner.sendTransaction({ to: positionSwapper.address, value: parseEther("0.001") });

      // Non-owner sweep attempts revert
      await expect(positionSwapper.connect(nonOwner).sweepToken(USDT.address)).to.be.reverted;
      await expect(positionSwapper.connect(nonOwner).sweepNative()).to.be.reverted;

      // Owner can sweep successfully
      const ownerUSDTBefore = await USDT.balanceOf(await adminSigner.getAddress());
      await positionSwapper.connect(adminSigner).sweepToken(USDT.address);
      const ownerUSDTAfter = await USDT.balanceOf(await adminSigner.getAddress());
      expect(ownerUSDTAfter.sub(ownerUSDTBefore)).to.be.gte(parseUnits("1", 18));

      const ownerNativeBefore = await ethers.provider.getBalance(await adminSigner.getAddress());
      const tx = await positionSwapper.connect(adminSigner).sweepNative();
      const receipt = await tx.wait();
      const gasSpent = receipt.gasUsed.mul(tx.gasPrice ?? 0);
      const ownerNativeAfter = await ethers.provider.getBalance(await adminSigner.getAddress());
      // After - Before + gas >= swept amount (approximate due to gas); ensure increased
      expect(ownerNativeAfter.add(gasSpent)).to.be.gt(ownerNativeBefore);
    });
  });

  describe("negative paths: listing and authorization", () => {
    it("should revert with MarketNotListed when market is not supported", async () => {
      const fakeFrom = await smock.fake<VBep20Harness>("VBep20Harness");
      const fakeTo = await smock.fake<VBep20Harness>("VBep20Harness");
      fakeFrom.balanceOfUnderlying.returns(parseUnits("1", 18));

      const swapData: string[] = [];
      await expect(
        positionSwapper.connect(user1).swapFullCollateral(user1Address, fakeFrom.address, fakeTo.address, 0, swapData),
      ).to.be.revertedWithCustomError(positionSwapper, "MarketNotListed");
    });

    it("should revert with UnauthorizedCaller when caller is not user nor approved delegate", async () => {
      const [adminSigner, otherUser] = await ethers.getSigners();
      const {
        comptroller: c2,
        vBNB: vBNB2,
        positionSwapper: ps2,
        vWBNB: vWBNB2,
      } = await loadFixture(setupMarketFixture);
      const otherAddr = await otherUser.getAddress();

      await vBNB2.connect(otherUser).mint({ value: parseEther("1") });

      // Call on behalf of `otherUser` from admin (not delegated) → expect UnauthorizedCaller(admin)
      await expect(ps2.connect(adminSigner).swapCollateralNativeToWrapped(otherAddr))
        .to.be.revertedWithCustomError(ps2, "UnauthorizedCaller")
        .withArgs(await adminSigner.getAddress());
    });
  });
});
