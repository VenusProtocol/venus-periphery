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
  oracle: FakeContract<ResilientOracleInterface>;
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
  const undertaker = (await undertakerFactory.deploy(comptroller.address)) as Undertaker;

  return {
    comptroller,
    WBNB,
    vWBNB,
    oracle,
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
  let oracle: FakeContract<ResilientOracleInterface>;

  beforeEach(async () => {
    [admin, user1] = await ethers.getSigners();
    ({ comptroller, WBNB, vWBNB, oracle, undertaker } = await loadFixture(setupMarketFixture));

    await WBNB.connect(user1).mint(await user1.getAddress(), parseEther("10"));
    await WBNB.connect(user1).approve(vWBNB.address, parseEther("5"));
    await vWBNB.connect(user1).mintBehalf(await user1.getAddress(), parseEther("5"));

    await comptroller.connect(user1).enterMarkets([vWBNB.address]);
  });

  describe("Pause Market", async () => {
    it("should pause market below global deposit threshold", async () => {
      await undertaker.setGlobalDepositThreshold(parseEther("100"));
      expect(await undertaker.canPauseMarket(vWBNB.address)).to.be.true;

      await undertaker.pauseMarket(vWBNB.address);
      expect(await undertaker.isMarketPaused(vWBNB.address)).to.be.true;
    });

    it("should pause market after expiry", async () => {
      await undertaker.setGlobalDepositThreshold(parseEther("1"));
      expect(await undertaker.canPauseMarket(vWBNB.address)).to.be.false;

      await undertaker
        .connect(admin)
        .setMarketExpiry(vWBNB.address, (await ethers.provider.getBlock("latest")).timestamp + 10, false, 0);

      expect(await undertaker.canPauseMarket(vWBNB.address)).to.be.false;

      await ethers.provider.send("evm_increaseTime", [20]);
      await ethers.provider.send("evm_mine", []);

      expect(await undertaker.canPauseMarket(vWBNB.address)).to.be.true;

      await undertaker.pauseMarket(vWBNB.address);
      expect(await undertaker.isMarketPaused(vWBNB.address)).to.be.true;
    });

    it("should not pause if pause is already processed", async () => {
      await undertaker.setGlobalDepositThreshold(parseEther("100"));
      expect(await undertaker.canPauseMarket(vWBNB.address)).to.be.true;

      await undertaker.pauseMarket(vWBNB.address);
      expect(await undertaker.isMarketPaused(vWBNB.address)).to.be.true;
      expect(await undertaker.canPauseMarket(vWBNB.address)).to.be.false;

      await comptroller["setCollateralFactor(address,uint256,uint256)"](
        vWBNB.address,
        parseEther("0.9"),
        convertToUnit("1", 18),
      );
      await comptroller.setActionsPaused([vWBNB.address], [0, 2, 7], false);

      expect(await undertaker.canPauseMarket(vWBNB.address)).to.be.false;
    });
  });

  describe("Unlist Market", async () => {
    it("should not unlist market if paused and expiry not set", async () => {
      await undertaker.setGlobalDepositThreshold(parseEther("100"));
      expect(await undertaker.canPauseMarket(vWBNB.address)).to.be.true;

      await undertaker.pauseMarket(vWBNB.address);
      expect(await undertaker.isMarketPaused(vWBNB.address)).to.be.true;

      expect(await undertaker.canUnlistMarket(vWBNB.address)).to.be.false;
    });

    it("should unlist market if paused and expiry is set", async () => {
      await undertaker.setMarketExpiry(
        vWBNB.address,
        (await ethers.provider.getBlock("latest")).timestamp + 10,
        true,
        parseEther("100"),
      );

      expect(await undertaker.canPauseMarket(vWBNB.address)).to.be.false;
      expect(await undertaker.canUnlistMarket(vWBNB.address)).to.be.false;

      await ethers.provider.send("evm_increaseTime", [20]);
      await ethers.provider.send("evm_mine", []);

      expect(await undertaker.canPauseMarket(vWBNB.address)).to.be.true;
      expect(await undertaker.canUnlistMarket(vWBNB.address)).to.be.false;

      await undertaker.pauseMarket(vWBNB.address);
      expect(await undertaker.isMarketPaused(vWBNB.address)).to.be.true;

      expect(await undertaker.canUnlistMarket(vWBNB.address)).to.be.true;

      await undertaker.unlistMarket(vWBNB.address);
      const market = await comptroller.markets(vWBNB.address);
      expect(market.isListed).to.be.false;
    });

    it("should not unlist market if paused and expiry is set but above threshold", async () => {
      await undertaker.setMarketExpiry(
        vWBNB.address,
        (await ethers.provider.getBlock("latest")).timestamp + 10,
        true,
        parseEther("100"),
      );

      expect(await undertaker.canPauseMarket(vWBNB.address)).to.be.false;
      expect(await undertaker.canUnlistMarket(vWBNB.address)).to.be.false;

      await ethers.provider.send("evm_increaseTime", [20]);
      await ethers.provider.send("evm_mine", []);

      expect(await undertaker.canPauseMarket(vWBNB.address)).to.be.true;
      expect(await undertaker.canUnlistMarket(vWBNB.address)).to.be.false;

      await undertaker.pauseMarket(vWBNB.address);
      expect(await undertaker.isMarketPaused(vWBNB.address)).to.be.true;

      expect(await undertaker.canUnlistMarket(vWBNB.address)).to.be.true;

      oracle.getUnderlyingPrice.returns(() => {
        return parseEther("1000");
      });

      oracle.getPrice.returns(() => {
        return parseEther("1000");
      });

      expect(await undertaker.canUnlistMarket(vWBNB.address)).to.be.false;
    });
  });
});
