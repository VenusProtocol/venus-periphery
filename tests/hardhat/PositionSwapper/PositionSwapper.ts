import { FakeContract, MockContract, smock } from "@defi-wonderland/smock";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { BigNumber, Signer } from "ethers";
import { parseEther, parseUnits } from "ethers/lib/utils";
import { ethers, upgrades } from "hardhat";

import { convertToUnit } from "../../../helpers/utils";
import {
  ComptrollerLens__factory,
  ComptrollerMock,
  ComptrollerMock__factory,
  IAccessControlManagerV8,
  InterestRateModelHarness,
  MockVBNB,
  PositionSwapper,
  ResilientOracleInterface,
  VBep20Harness,
  WBNB,
  WBNBSwapHelper,
} from "../../../typechain";

type SetupMarketFixture = {
  comptroller: FakeContract<ComptrollerMock>;
  vBNB: MockVBNB;
  WBNB: MockContract<WBNB>;
  vWBNB: MockContract<VBep20Harness>;
  positionSwapper: PositionSwapper;
  wBNBSwapHelper: WBNBSwapHelper;
};

const setupMarketFixture = async (): Promise<SetupMarketFixture> => {
  const [admin] = await ethers.getSigners();

  const oracle = await smock.fake<ResilientOracleInterface>("ResilientOracleInterface");
  const accessControl = await smock.fake<IAccessControlManagerV8>("AccessControlManager");
  accessControl.isAllowedToCall.returns(true);

  const ComptrollerFactory = await smock.mock<ComptrollerMock__factory>("ComptrollerMock");
  const comptroller = await ComptrollerFactory.deploy();

  const ComptrollerLensFactory = await smock.mock<ComptrollerLens__factory>("ComptrollerLens");
  const comptrollerLens = await ComptrollerLensFactory.deploy();

  await comptroller._setAccessControl(accessControl.address);
  await comptroller._setComptrollerLens(comptrollerLens.address);
  await comptroller._setPriceOracle(oracle.address);
  await comptroller._setLiquidationIncentive(convertToUnit("1", 18));

  const interestRateModelHarnessFactory = await ethers.getContractFactory("InterestRateModelHarness");
  const InterestRateModelHarness = (await interestRateModelHarnessFactory.deploy(
    parseUnits("1", 12),
  )) as InterestRateModelHarness;

  const VBNBFactory = await ethers.getContractFactory("MockVBNB");
  const vBNB = await VBNBFactory.deploy(
    comptroller.address,
    InterestRateModelHarness.address,
    parseUnits("1", 28),
    "Venus BNB",
    "vBNB",
    8,
    admin.address,
  );

  await vBNB.setAccessControlManager(accessControl.address);

  const WBNBFactory = await ethers.getContractFactory("WBNB");
  const WBNB = await WBNBFactory.deploy();

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
    InterestRateModelHarness.address,
    vTokenConfig.initialExchangeRateMantissa,
    vTokenConfig.name,
    vTokenConfig.symbol,
    vTokenConfig.decimals,
    admin.address,
  );
  await vWBNB.deployed();

  await vWBNB.harnessSetReserveFactorFresh(BigNumber.from("0"));
  await vBNB._setReserveFactor(BigNumber.from("0"));

  oracle.getUnderlyingPrice.returns(() => {
    return parseEther("1");
  });

  oracle.getPrice.returns(() => {
    return parseEther("1");
  });

  await comptroller._supportMarket(vWBNB.address);
  await comptroller._setCollateralFactor(vWBNB.address, parseEther("0.9"));
  await comptroller._supportMarket(vBNB.address);
  await comptroller._setCollateralFactor(vBNB.address, parseEther("0.9"));

  await comptroller._setMarketSupplyCaps([vWBNB.address, vBNB.address], [parseEther("100"), parseEther("100")]);
  await comptroller._setMarketBorrowCaps([vWBNB.address, vBNB.address], [parseEther("100"), parseEther("100")]);

  const PositionSwapperFactory = await ethers.getContractFactory("PositionSwapper");
  const positionSwapper = await upgrades.deployProxy(PositionSwapperFactory, [], {
    constructorArgs: [comptroller.address, vBNB.address],
    initializer: "initialize",
    unsafeAllow: ["state-variable-immutable"],
  });
  const WBNBSwapHelperFactory = await ethers.getContractFactory("WBNBSwapHelper");
  const wBNBSwapHelper = await WBNBSwapHelperFactory.deploy(WBNB.address, positionSwapper.address);

  await positionSwapper.setApprovedPair(vBNB.address, vWBNB.address, wBNBSwapHelper.address, true);

  return {
    comptroller,
    vBNB,
    WBNB,
    vWBNB,
    positionSwapper,
    wBNBSwapHelper,
  };
};

// Tests require the venus-protocol package to include the latest WhitelistedExecutor changes.
// ref: https://github.com/VenusProtocol/venus-protocol/pull/606
describe.skip("PositionSwapper", () => {
  let vBNB: MockVBNB;
  let WBNB: MockContract<WBNB>;
  let vWBNB: MockContract<VBep20Harness>;
  let admin: Signer;
  let user1: Signer;
  let user2: Signer;
  let comptroller: FakeContract<ComptrollerMock>;
  let positionSwapper: PositionSwapper;
  let wBNBSwapHelper: WBNBSwapHelper;

  beforeEach(async () => {
    [admin, user1, user2] = await ethers.getSigners();
    ({ comptroller, vBNB, WBNB, vWBNB, positionSwapper, wBNBSwapHelper } = await loadFixture(setupMarketFixture));
  });

  describe("swapDebt", async () => {
    beforeEach(async () => {
      await vBNB.connect(user1).mint({ value: parseEther("5") });
      await WBNB.connect(user2).deposit({ value: parseEther("5") });
      await WBNB.connect(user2).approve(vWBNB.address, parseEther("5"));
      await vWBNB.connect(user2).mintBehalf(await user2.getAddress(), parseEther("5"));

      await comptroller.connect(user1).enterMarkets([vBNB.address, vWBNB.address]);
      await comptroller.connect(user2).enterMarkets([vBNB.address, vWBNB.address]);

      await vBNB.connect(user2).borrow(parseEther("1"));

      comptroller["borrowAllowed(address,address,address,uint256)"].returns(0);
    });

    it("should swapFullDebt from vBNB to vWBNB", async () => {
      let snapshot = await vWBNB.callStatic.getAccountSnapshot(await user2.getAddress());
      expect(snapshot[2].toString()).to.eq(parseEther("0").toString()); // borrowed amount
      await comptroller.connect(user2).updateDelegate(positionSwapper.address, true);
      await positionSwapper
        .connect(user2)
        .swapFullDebt(await user2.getAddress(), vBNB.address, vWBNB.address, wBNBSwapHelper.address);
      snapshot = await vWBNB.callStatic.getAccountSnapshot(await user2.getAddress());
      expect(snapshot[2]).to.be.closeTo(parseEther("1"), parseEther("0.00001"));
    });

    it("should swapDebtWithAmount from vBNB to vWBNB", async () => {
      const amountToSwap = parseEther("1").div(2); // 50% partial

      await comptroller.connect(user2).updateDelegate(positionSwapper.address, true);
      await positionSwapper
        .connect(user2)
        .swapDebtWithAmount(
          await user2.getAddress(),
          vBNB.address,
          vWBNB.address,
          amountToSwap,
          wBNBSwapHelper.address,
        );
      const snapshot = await vWBNB.callStatic.getAccountSnapshot(await user2.getAddress());
      expect(snapshot[2]).to.be.closeTo(parseEther("0.5"), parseEther("0.00001"));
    });

    describe("should revert on debt swap failures", async () => {
      it("should revert if caller is not user or approved delegate", async () => {
        comptroller.approvedDelegates.returns(false);

        await expect(
          positionSwapper
            .connect(user1)
            .swapFullDebt(await user2.getAddress(), vBNB.address, vWBNB.address, wBNBSwapHelper.address),
        ).to.be.revertedWithCustomError(positionSwapper, "Unauthorized");
      });

      it("should revert on swapDebtWithAmount with zero amount", async () => {
        await expect(
          positionSwapper
            .connect(user1)
            .swapDebtWithAmount(await user1.getAddress(), vBNB.address, vWBNB.address, 0, wBNBSwapHelper.address),
        ).to.be.revertedWithCustomError(positionSwapper, "ZeroAmount");
      });

      it("should revert if user borrow balance is zero", async () => {
        await expect(
          positionSwapper
            .connect(user1)
            .swapFullDebt(await user1.getAddress(), vBNB.address, vWBNB.address, wBNBSwapHelper.address),
        ).to.be.revertedWithCustomError(positionSwapper, "NoBorrowBalance");
      });

      it("should revert if swapDebtWithAmount is greater than user's borrow balance", async () => {
        const amountToSwap = parseEther("2");

        await comptroller.connect(user2).updateDelegate(positionSwapper.address, true);

        await expect(
          positionSwapper
            .connect(user2)
            .swapDebtWithAmount(
              await user2.getAddress(),
              vBNB.address,
              vWBNB.address,
              amountToSwap,
              wBNBSwapHelper.address,
            ),
        ).to.be.revertedWithCustomError(positionSwapper, "NoBorrowBalance");
      });
    });
  });

  describe("swapCollateral", async () => {
    beforeEach(async () => {
      await vBNB.connect(user1).mint({ value: parseEther("5") });

      comptroller.seizeAllowed.returns(0);
    });

    it("should swapFullCollateral from vBNB to vWBNB", async () => {
      const balanceBeforeSupplying = await vWBNB.balanceOf(await user1.getAddress());
      await expect(balanceBeforeSupplying.toString()).to.eq(parseUnits("0", 8));
      await positionSwapper
        .connect(user1)
        .swapFullCollateral(await user1.getAddress(), vBNB.address, vWBNB.address, wBNBSwapHelper.address);
      const balanceAfterSupplying = await vWBNB.balanceOf(await user1.getAddress());
      await expect(balanceAfterSupplying.toString()).to.eq(parseUnits("5", 8));
    });

    it("should swapCollateralWithAmount from vBNB to vWBNB", async () => {
      const vBNBBalance = await vBNB.balanceOf(await user1.getAddress());
      const amountToSeize = vBNBBalance.div(2); // 50% partial

      await positionSwapper
        .connect(user1)
        .swapCollateralWithAmount(
          await user1.getAddress(),
          vBNB.address,
          vWBNB.address,
          amountToSeize,
          wBNBSwapHelper.address,
        );
      const balanceAfterSupplying = await vWBNB.balanceOf(await user1.getAddress());
      await expect(balanceAfterSupplying).to.eq(amountToSeize);
    });

    describe("should revert on seize failures", async () => {
      it("should revert if caller is not user or approved delegate", async () => {
        comptroller.approvedDelegates.returns(false);

        await expect(
          positionSwapper
            .connect(admin)
            .swapFullCollateral(await user1.getAddress(), vBNB.address, vWBNB.address, wBNBSwapHelper.address),
        ).to.be.revertedWithCustomError(positionSwapper, "Unauthorized");
      });

      it("should revert on swapCollateralWithAmount with zero amount", async () => {
        await expect(
          positionSwapper
            .connect(user1)
            .swapCollateralWithAmount(await user1.getAddress(), vBNB.address, vWBNB.address, 0, wBNBSwapHelper.address),
        ).to.be.revertedWithCustomError(positionSwapper, "ZeroAmount");
      });

      it("should revert if user balance is zero", async () => {
        await expect(
          positionSwapper
            .connect(admin)
            .swapFullCollateral(await admin.getAddress(), vBNB.address, vWBNB.address, wBNBSwapHelper.address),
        ).to.be.revertedWithCustomError(positionSwapper, "NoVTokenBalance");
      });

      it("should revert if swapCollateralWithAmount is greater than user's balance", async () => {
        const userBalance = await vBNB.balanceOf(await user1.getAddress());
        const moreThanBalance = userBalance.add(1);

        await expect(
          positionSwapper
            .connect(user1)
            .swapCollateralWithAmount(
              await user1.getAddress(),
              vBNB.address,
              vWBNB.address,
              moreThanBalance,
              wBNBSwapHelper.address,
            ),
        ).to.be.revertedWithCustomError(positionSwapper, "NoVTokenBalance");
      });

      it("should revert if user becomes unsafe after swap", async () => {
        comptroller.getAccountLiquidity.returns([0, 0, 1]); // shortfall > 0

        await expect(
          positionSwapper
            .connect(user1)
            .swapFullCollateral(await user1.getAddress(), vBNB.address, vWBNB.address, wBNBSwapHelper.address),
        ).to.be.revertedWithCustomError(positionSwapper, "SwapCausesLiquidation");
        comptroller.getAccountLiquidity.reset();
      });

      it("should revert if marketFrom.seize fails", async () => {
        comptroller.seizeAllowed.returns(1); // simulate failure

        await expect(
          positionSwapper
            .connect(user1)
            .swapFullCollateral(await user1.getAddress(), vBNB.address, vWBNB.address, wBNBSwapHelper.address),
        ).to.be.revertedWithCustomError(positionSwapper, "SeizeFailed");
        comptroller.seizeAllowed.reset();
      });

      it("should revert if underlying transfer fails", async () => {
        comptroller.redeemAllowed.returns(1); // simulate redeem failure

        await expect(
          positionSwapper
            .connect(user1)
            .swapFullCollateral(await user1.getAddress(), vBNB.address, vWBNB.address, wBNBSwapHelper.address),
        ).to.be.reverted;
        comptroller.redeemAllowed.reset();
      });

      it("should revert if mintBehalf fails", async () => {
        comptroller.mintAllowed.returns(1); // simulate failure

        await expect(
          positionSwapper
            .connect(user1)
            .swapFullCollateral(await user1.getAddress(), vBNB.address, vWBNB.address, wBNBSwapHelper.address),
        ).to.be.revertedWithCustomError(positionSwapper, "MintFailed");
        comptroller.mintAllowed.reset();
      });
    });
  });

  describe("SweepToken", () => {
    it("should revert when called by non owner", async () => {
      await expect(positionSwapper.connect(user1).sweepToken(WBNB.address)).to.be.rejectedWith(
        "Ownable: caller is not the owner",
      );
    });

    it("should sweep all tokens", async () => {
      await WBNB.deposit({ value: parseUnits("2", 18) });
      await WBNB.transfer(positionSwapper.address, parseUnits("2", 18));
      const ownerPreviousBalance = await WBNB.balanceOf(await admin.getAddress());
      await positionSwapper.connect(admin).sweepToken(WBNB.address);

      expect(await WBNB.balanceOf(positionSwapper.address)).to.be.eq(0);
      expect(await WBNB.balanceOf(await admin.getAddress())).to.be.greaterThan(ownerPreviousBalance);
    });
  });
});
