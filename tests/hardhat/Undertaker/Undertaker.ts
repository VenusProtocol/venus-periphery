import { FakeContract, MockContract, smock } from "@defi-wonderland/smock";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { BigNumber, Signer } from "ethers";
import { parseEther, parseUnits } from "ethers/lib/utils";
import { ethers } from "hardhat";

import { convertToUnit } from "../../../helpers/utils";
import {
  ComptrollerLens__factory,
  ComptrollerMock,
  ComptrollerMock__factory,
  IAccessControlManagerV8,
  InterestRateModelHarness,
  ResilientOracleInterface,
  TestToken,
  Undertaker,
  VBep20Harness,
} from "../../../typechain";

type SetupMarketFixture = {
  comptroller: FakeContract<ComptrollerMock>;
  WBNB: MockContract<TestToken>;
  vWBNB: MockContract<VBep20Harness>;
  undertaker: Undertaker;
};

const setupMarketFixture = async (): Promise<SetupMarketFixture> => {
  const [admin] = await ethers.getSigners();

  const oracle = await smock.fake<ResilientOracleInterface>("ResilientOracleInterface");
  const accessControl = await smock.fake<IAccessControlManagerV8>("IAccessControlManagerV8");
  accessControl.isAllowedToCall.returns(true);

  const ComptrollerFactory = await smock.mock<ComptrollerMock__factory>("ComptrollerMock");
  const comptroller = await ComptrollerFactory.deploy();

  const ComptrollerLensFactory = await smock.mock<ComptrollerLens__factory>("ComptrollerLens");
  const comptrollerLens = await ComptrollerLensFactory.deploy();

  await comptroller._setAccessControl(accessControl.address);
  await comptroller._setComptrollerLens(comptrollerLens.address);
  await comptroller._setPriceOracle(oracle.address);

  const interestRateModelHarnessFactory = await ethers.getContractFactory("InterestRateModelHarness");
  const InterestRateModelHarness = (await interestRateModelHarnessFactory.deploy(
    parseUnits("1", 12),
  )) as InterestRateModelHarness;

  const WBNBFactory = await ethers.getContractFactory("TestToken");
  const WBNB = await WBNBFactory.deploy("Wrapped BNB", "WBNB", 18);

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

  oracle.getUnderlyingPrice.returns(() => {
    return parseEther("1");
  });

  oracle.getPrice.returns(() => {
    return parseEther("1");
  });

  await comptroller._supportMarket(vWBNB.address);
  await comptroller["setCollateralFactor(address,uint256,uint256)"](
    vWBNB.address,
    parseEther("0.9"),
    convertToUnit("1", 18),
  );

  await comptroller._setMarketSupplyCaps([vWBNB.address], [parseEther("100")]);
  await comptroller._setMarketBorrowCaps([vWBNB.address], [parseEther("100")]);

  const undertakerFactory = await ethers.getContractFactory("Undertaker");
  const undertaker = (await undertakerFactory.deploy()) as Undertaker;

  return {
    comptroller,
    WBNB,
    vWBNB,
    undertaker,
  };
};

describe("Undertaker", () => {
  let WBNB: MockContract<TestToken>;
  let vWBNB: MockContract<VBep20Harness>;
  let admin: Signer;
  let user1: Signer;
  let comptroller: FakeContract<ComptrollerMock>;
  let undertaker: Undertaker;

  beforeEach(async () => {
    [admin, user1] = await ethers.getSigners();
    ({ comptroller, WBNB, vWBNB, undertaker } = await loadFixture(setupMarketFixture));
  });

  describe("Pause Market", async () => {
    beforeEach(async () => {
      await WBNB.connect(user1).mint(await user1.getAddress(), parseEther("10"));
      await WBNB.connect(user1).approve(vWBNB.address, parseEther("5"));
      await vWBNB.connect(user1).mintBehalf(await user1.getAddress(), parseEther("5"));

      await comptroller.connect(user1).enterMarkets([vWBNB.address]);

      await undertaker.setGlobalDepositThreshold(parseEther("100"));
    });

    it("should pause market", async () => {
      expect(await undertaker.canPauseMarket(vWBNB.address)).to.be.true;

      await undertaker.pauseMarket(vWBNB.address);
      expect(await undertaker.isMarketPaused(comptroller.address, vWBNB.address)).to.be.true;
    });
  });
});
