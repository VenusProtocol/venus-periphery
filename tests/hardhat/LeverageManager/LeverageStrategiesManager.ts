import { FakeContract, MockContract, smock } from "@defi-wonderland/smock";
import { impersonateAccount, loadFixture, setBalance } from "@nomicfoundation/hardhat-network-helpers";
import chai, { expect } from "chai";
import { BigNumber, Signer } from "ethers";
import { parseEther, parseUnits } from "ethers/lib/utils";
import { ethers } from "hardhat";

import {
  ComptrollerMock,
  IProtocolShareReserve,
  IVToken,
  LeverageStrategiesManager,
  SwapHelper,
} from "../../../typechain";

chai.should();
chai.use(smock.matchers);

type SetupFixture = {
  leverageStrategiesManager: LeverageStrategiesManager;
  comptroller: FakeContract<ComptrollerMock>;
  comptrollerSigner: Signer;
  protocolShareReserve: FakeContract<IProtocolShareReserve>;
  swapHelper: FakeContract<SwapHelper>;
  collateralMarket: FakeContract<IVToken>;
  borrowMarket: FakeContract<IVToken>;
};

const setupFixture = async (): Promise<SetupFixture> => {
  const [admin] = await ethers.getSigners();

  const comptroller = await smock.fake<ComptrollerMock>("ComptrollerMock");
  const protocolShareReserve = await smock.fake<IProtocolShareReserve>(
    "contracts/Interfaces.sol:IProtocolShareReserve",
  );
  const swapHelper = await smock.fake<SwapHelper>("SwapHelper");
  const collateralMarket = await smock.fake<IVToken>("IVToken");
  const borrowMarket = await smock.fake<IVToken>("IVToken");

  const LeverageStrategiesManagerFactory = await ethers.getContractFactory("LeverageStrategiesManager");
  const leverageStrategiesManager = (await LeverageStrategiesManagerFactory.deploy(
    comptroller.address,
    protocolShareReserve.address,
    swapHelper.address,
  )) as LeverageStrategiesManager;
  await leverageStrategiesManager.deployed();

  await setBalance(comptroller.address, parseEther("10"));
  const comptrollerSigner = await ethers.getSigner(comptroller.address);

  return {
    leverageStrategiesManager,
    comptroller,
    comptrollerSigner,
    protocolShareReserve,
    swapHelper,
    collateralMarket,
    borrowMarket,
  };
};

describe("LeverageStrategiesManager", () => {
  let leverageStrategiesManager: LeverageStrategiesManager;
  let comptroller: FakeContract<ComptrollerMock>;
  let comptrollerSigner: Signer;
  let protocolShareReserve: FakeContract<IProtocolShareReserve>;
  let swapHelper: FakeContract<SwapHelper>;
  let collateralMarket: FakeContract<IVToken>;
  let borrowMarket: FakeContract<IVToken>;
  let admin: Signer;
  let alice: Signer;
  let bob: Signer;

  beforeEach(async () => {
    [admin, alice, bob] = await ethers.getSigners();
    ({
      leverageStrategiesManager,
      comptroller,
      comptrollerSigner,
      protocolShareReserve,
      swapHelper,
      collateralMarket,
      borrowMarket,
    } = await loadFixture(setupFixture));
  });

  afterEach(async () => {
    await comptroller.executeFlashLoan.reset();
    await comptroller.getAccountLiquidity.reset();
    await comptroller.approvedDelegates.reset();
  });

  describe("Deployment & Initialization", () => {
    it("should deploy successfully", async () => {
      expect(leverageStrategiesManager.address).to.satisfy(ethers.utils.isAddress);
    });

    it("should deploy with correct immutable variables", async () => {
      expect(await leverageStrategiesManager.COMPTROLLER()).to.equal(comptroller.address);
      expect(await leverageStrategiesManager.protocolShareReserve()).to.equal(protocolShareReserve.address);
      expect(await leverageStrategiesManager.swapHelper()).to.equal(swapHelper.address);
    });

    it("should initialize correctly", async () => {
      expect(leverageStrategiesManager.address).to.satisfy(ethers.utils.isAddress);

      await expect(leverageStrategiesManager.initialize()).to.be.rejectedWith(
        "Initializable: contract is already initialized",
      ); // TODO: Change to rejectedWithCustomError
    });

    it("should revert if initialized twice", async () => {
      await expect(leverageStrategiesManager.initialize()).to.be.rejectedWith(
        "Initializable: contract is already initialized",
      ); // TODO: Change to rejectedWithCustomError
    });

    it("should handle ownership transfer", async () => {
      await expect(
        leverageStrategiesManager.connect(alice).transferOwnership(await bob.getAddress()),
      ).to.be.rejectedWith("Ownable: caller is not the owner"); // TODO: Change to rejectedWithCustomError

      expect(await leverageStrategiesManager.owner()).to.equal(ethers.constants.AddressZero);
    });
  });

  describe("Access Control", () => {
    it("should require user delegation for enterLeveragedPositionWithCollateral", async () => {
      comptroller.approvedDelegates.returns(false);

      const collateralAmountSeed = parseEther("1");
      const borrowedAmountToFlashLoan = parseEther("1");
      const swapData: string[] = [];

      await expect(
        leverageStrategiesManager.connect(alice).enterLeveragedPositionWithCollateral(
          collateralMarket.address,
          collateralAmountSeed,
          borrowMarket.address,
          borrowedAmountToFlashLoan,
          0, // minAmountCollateralAfterSwap
          swapData,
        ),
      ).to.be.rejectedWith("Unauthorized()");
    });

    it("should require user delegation for exitLeveragedPosition", async () => {
      comptroller.approvedDelegates.returns(false);

      const collateralAmountToRedeemForSwap = parseEther("1");
      const borrowedAmountToFlashLoan = parseEther("1");
      const swapData: string[] = [];

      await expect(
        leverageStrategiesManager.connect(alice).exitLeveragedPosition(
          collateralMarket.address,
          collateralAmountToRedeemForSwap,
          borrowMarket.address,
          borrowedAmountToFlashLoan,
          0, // minAmountCollateralAfterSwap
          swapData,
        ),
      ).to.be.rejectedWith("Unauthorized()");
    });

    it("should revert when caller is not user or approved delegate", async () => {
      comptroller.approvedDelegates
        .whenCalledWith(await alice.getAddress(), leverageStrategiesManager.address)
        .returns(false);

      const collateralAmountSeed = parseEther("1");
      const collateralAmountToRedeemForSwap = parseEther("1");
      const borrowedAmountToFlashLoan = parseEther("1");
      const swapData: string[] = [];

      await expect(
        leverageStrategiesManager.connect(bob).enterLeveragedPositionWithCollateral(
          collateralMarket.address,
          collateralAmountSeed,
          borrowMarket.address,
          borrowedAmountToFlashLoan,
          0, // minAmountCollateralAfterSwap
          swapData,
        ),
      ).to.be.rejectedWith("Unauthorized()");

      await expect(
        leverageStrategiesManager.connect(bob).exitLeveragedPosition(
          collateralMarket.address,
          collateralAmountToRedeemForSwap,
          borrowMarket.address,
          borrowedAmountToFlashLoan,
          0, // minAmountCollateralAfterSwap
          swapData,
        ),
      ).to.be.rejectedWith("Unauthorized()");
    });

    it("should allow approved delegates to call enterLeveragedPositionWithCollateral", async () => {
      comptroller.approvedDelegates
        .whenCalledWith(await alice.getAddress(), leverageStrategiesManager.address)
        .returns(true);

      comptroller.getAccountLiquidity.returns([0, parseEther("10"), 0]);

      comptroller.executeFlashLoan.returns();

      const collateralAmountSeed = parseEther("1");
      const borrowedAmountToFlashLoan = parseEther("1");
      const swapData: string[] = [];

      await leverageStrategiesManager.connect(alice).enterLeveragedPositionWithCollateral(
        collateralMarket.address,
        collateralAmountSeed,
        borrowMarket.address,
        borrowedAmountToFlashLoan,
        0, // minAmountCollateralAfterSwap
        swapData,
      );
    });

    it("should allow approved delegates to call exitLeveragedPosition", async () => {
      comptroller.approvedDelegates
        .whenCalledWith(await alice.getAddress(), leverageStrategiesManager.address)
        .returns(true);

      comptroller.getAccountLiquidity.returns([0, parseEther("10"), 0]);

      comptroller.executeFlashLoan.returns();

      const collateralAsset = await smock.fake("IERC20Upgradeable");
      const borrowedAsset = await smock.fake("IERC20Upgradeable");

      collateralMarket.underlying.returns(collateralAsset.address);
      borrowMarket.underlying.returns(borrowedAsset.address);

      collateralAsset.balanceOf.returns(0);
      borrowedAsset.balanceOf.returns(0);

      protocolShareReserve.updateAssetsState.returns();

      const collateralAmountToRedeemForSwap = parseEther("1");
      const borrowedAmountToFlashLoan = parseEther("1");
      const swapData: string[] = [];

      await leverageStrategiesManager.connect(alice).exitLeveragedPosition(
        collateralMarket.address,
        collateralAmountToRedeemForSwap,
        borrowMarket.address,
        borrowedAmountToFlashLoan,
        0, // minAmountOutAfterSwap
        swapData,
      );
    });
  });

  describe("enterLeveragedPositionWithCollateral", () => {
    describe("Happy Path", () => {
      it.skip("should successfully enter leveraged position with seed collateral");

      it.skip("should enter leveraged position without seed collateral (amount = 0)");

      it("should verify flash loan execution flow", async () => {
        comptroller.approvedDelegates
          .whenCalledWith(await alice.getAddress(), leverageStrategiesManager.address)
          .returns(true);

        comptroller.getAccountLiquidity.returns([0, parseEther("10"), 0]);

        comptroller.executeFlashLoan.returns();

        const collateralAmountSeed = parseEther("1");
        const borrowedAmountToFlashLoan = parseEther("1");
        const swapData: string[] = [];

        await leverageStrategiesManager.connect(alice).enterLeveragedPositionWithCollateral(
          collateralMarket.address,
          collateralAmountSeed,
          borrowMarket.address,
          borrowedAmountToFlashLoan,
          0, // minAmountCollateralAfterSwap
          swapData,
        );

        expect(comptroller.executeFlashLoan).to.have.been.calledOnce;
        expect(comptroller.getAccountLiquidity).to.have.been.calledTwice;
      });

      it("should call executeFlashLoan with correct arguments", async () => {
        comptroller.approvedDelegates
          .whenCalledWith(await alice.getAddress(), leverageStrategiesManager.address)
          .returns(true);

        comptroller.getAccountLiquidity.returns([0, parseEther("10"), 0]);
        comptroller.executeFlashLoan.returns();

        const collateralAmountSeed = parseEther("1");
        const borrowedAmountToFlashLoan = parseEther("2");
        const swapData: string[] = [];

        await leverageStrategiesManager.connect(alice).enterLeveragedPositionWithCollateral(
          collateralMarket.address,
          collateralAmountSeed,
          borrowMarket.address,
          borrowedAmountToFlashLoan,
          0, // minAmountCollateralAfterSwap
          swapData,
        );

        const callArgs = comptroller.executeFlashLoan.getCall(0).args;
        expect(callArgs[0]).to.equal(await alice.getAddress());
        expect(callArgs[1]).to.equal(leverageStrategiesManager.address);
        expect(callArgs[2]).to.deep.equal([borrowMarket.address]);
        expect(callArgs[3]).to.deep.equal([borrowedAmountToFlashLoan]);
        expect(callArgs[4]).to.be.a("string");
      });
    });

    describe("Edge Cases & Reverts", () => {
      it("should revert with Unauthorized when user not delegated", async () => {
        comptroller.approvedDelegates
          .whenCalledWith(await alice.getAddress(), leverageStrategiesManager.address)
          .returns(false);

        const collateralAmountSeed = parseEther("1");
        const borrowedAmountToFlashLoan = parseEther("1");
        const swapData: string[] = [];

        await expect(
          leverageStrategiesManager.connect(alice).enterLeveragedPositionWithCollateral(
            collateralMarket.address,
            collateralAmountSeed,
            borrowMarket.address,
            borrowedAmountToFlashLoan,
            0, // minAmountCollateralAfterSwap
            swapData,
          ),
        ).to.be.rejectedWith("Unauthorized()");
      });

      it("should revert with LeverageCausesLiquidation when account is unsafe before operation", async () => {
        comptroller.approvedDelegates
          .whenCalledWith(await alice.getAddress(), leverageStrategiesManager.address)
          .returns(true);

        comptroller.getAccountLiquidity.returns([0, 0, parseEther("1")]); // err=0, liquidity=0, shortfall=1

        const collateralAmountSeed = parseEther("1");
        const borrowedAmountToFlashLoan = parseEther("1");
        const swapData: string[] = [];

        await expect(
          leverageStrategiesManager.connect(alice).enterLeveragedPositionWithCollateral(
            collateralMarket.address,
            collateralAmountSeed,
            borrowMarket.address,
            borrowedAmountToFlashLoan,
            0, // minAmountCollateralAfterSwap
            swapData,
          ),
        ).to.be.rejectedWith("LeverageCausesLiquidation()");
      });

      it("should revert with LeverageCausesLiquidation when account becomes unsafe after operation", async () => {
        comptroller.approvedDelegates
          .whenCalledWith(await alice.getAddress(), leverageStrategiesManager.address)
          .returns(true);

        comptroller.getAccountLiquidity.returnsAtCall(0, [0, parseEther("10"), 0]);
        comptroller.getAccountLiquidity.returnsAtCall(1, [0, 0, parseEther("1")]);

        const collateralAmountSeed = parseEther("1");
        const borrowedAmountToFlashLoan = parseEther("1");
        const swapData: string[] = [];

        await expect(
          leverageStrategiesManager.connect(alice).enterLeveragedPositionWithCollateral(
            collateralMarket.address,
            collateralAmountSeed,
            borrowMarket.address,
            borrowedAmountToFlashLoan,
            0, // minAmountCollateralAfterSwap
            swapData,
          ),
        ).to.be.rejectedWith("LeverageCausesLiquidation()");
      });
    });
  });

  describe("enterLeveragedPositionWithBorrowed", () => {
    describe("Access Control", () => {
      it("should require user delegation for enterLeveragedPositionWithBorrowed", async () => {
        comptroller.approvedDelegates
          .whenCalledWith(await alice.getAddress(), leverageStrategiesManager.address)
          .returns(false);

        const borrowedAmountSeed = parseEther("1");
        const borrowedAmountToFlashLoan = parseEther("1");
        const swapData: string[] = [];

        await expect(
          leverageStrategiesManager.connect(alice).enterLeveragedPositionWithBorrowed(
            collateralMarket.address,
            borrowMarket.address,
            borrowedAmountSeed,
            borrowedAmountToFlashLoan,
            0, // minAmountOutAfterSwap
            swapData,
          ),
        ).to.be.rejectedWith("Unauthorized()");
      });

      it("should revert when caller is not user or approved delegate", async () => {
        comptroller.approvedDelegates
          .whenCalledWith(await alice.getAddress(), leverageStrategiesManager.address)
          .returns(false);

        const borrowedAmountSeed = parseEther("1");
        const borrowedAmountToFlashLoan = parseEther("1");
        const swapData: string[] = [];

        await expect(
          leverageStrategiesManager.connect(bob).enterLeveragedPositionWithBorrowed(
            collateralMarket.address,
            borrowMarket.address,
            borrowedAmountSeed,
            borrowedAmountToFlashLoan,
            0, // minAmountOutAfterSwap
            swapData,
          ),
        ).to.be.rejectedWith("Unauthorized()");
      });

      it("should allow approved delegates to call enterLeveragedPositionWithBorrowed", async () => {
        comptroller.approvedDelegates
          .whenCalledWith(await alice.getAddress(), leverageStrategiesManager.address)
          .returns(true);

        comptroller.getAccountLiquidity.returns([0, parseEther("10"), 0]);

        comptroller.executeFlashLoan.returns();

        const borrowedAmountSeed = parseEther("1");
        const borrowedAmountToFlashLoan = parseEther("1");
        const swapData: string[] = [];

        await leverageStrategiesManager.connect(alice).enterLeveragedPositionWithBorrowed(
          collateralMarket.address,
          borrowMarket.address,
          borrowedAmountSeed,
          borrowedAmountToFlashLoan,
          0, // minAmountOutAfterSwap
          swapData,
        );
      });
    });

    describe("Happy Path", () => {
      it.skip("should successfully enter leveraged position with borrowed asset seed");

      it.skip("should enter leveraged position without borrowed asset seed (amount = 0)");

      it("should verify flash loan execution flow", async () => {
        comptroller.approvedDelegates
          .whenCalledWith(await alice.getAddress(), leverageStrategiesManager.address)
          .returns(true);

        comptroller.getAccountLiquidity.returns([0, parseEther("10"), 0]);

        comptroller.executeFlashLoan.returns();

        const borrowedAmountSeed = parseEther("1");
        const borrowedAmountToFlashLoan = parseEther("1");
        const swapData: string[] = [];

        await leverageStrategiesManager.connect(alice).enterLeveragedPositionWithBorrowed(
          collateralMarket.address,
          borrowMarket.address,
          borrowedAmountSeed,
          borrowedAmountToFlashLoan,
          0, // minAmountOutAfterSwap
          swapData,
        );

        expect(comptroller.executeFlashLoan).to.have.been.calledOnce;
        expect(comptroller.getAccountLiquidity).to.have.been.calledTwice;
      });

      it("should call executeFlashLoan with correct arguments", async () => {
        comptroller.approvedDelegates
          .whenCalledWith(await alice.getAddress(), leverageStrategiesManager.address)
          .returns(true);

        comptroller.getAccountLiquidity.returns([0, parseEther("10"), 0]);
        comptroller.executeFlashLoan.returns();

        const borrowedAmountSeed = parseEther("1.5");
        const borrowedAmountToFlashLoan = parseEther("2.5");
        const swapData: string[] = [];

        await leverageStrategiesManager.connect(alice).enterLeveragedPositionWithBorrowed(
          collateralMarket.address,
          borrowMarket.address,
          borrowedAmountSeed,
          borrowedAmountToFlashLoan,
          0, // minAmountOutAfterSwap
          swapData,
        );

        const callArgs = comptroller.executeFlashLoan.getCall(0).args;
        expect(callArgs[0]).to.equal(await alice.getAddress());
        expect(callArgs[1]).to.equal(leverageStrategiesManager.address);
        expect(callArgs[2]).to.deep.equal([borrowMarket.address]);
        expect(callArgs[3]).to.deep.equal([borrowedAmountToFlashLoan]);
        expect(callArgs[4]).to.be.a("string");
      });
    });

    describe("Edge Cases & Reverts", () => {
      it("should revert with Unauthorized when user not delegated", async () => {
        comptroller.approvedDelegates
          .whenCalledWith(await alice.getAddress(), leverageStrategiesManager.address)
          .returns(false);

        const borrowedAmountSeed = parseEther("1");
        const borrowedAmountToFlashLoan = parseEther("1");
        const swapData: string[] = [];

        await expect(
          leverageStrategiesManager.connect(alice).enterLeveragedPositionWithBorrowed(
            collateralMarket.address,
            borrowMarket.address,
            borrowedAmountSeed,
            borrowedAmountToFlashLoan,
            0, // minAmountOutAfterSwap
            swapData,
          ),
        ).to.be.rejectedWith("Unauthorized()");
      });

      it("should revert with LeverageCausesLiquidation when account is unsafe before operation", async () => {
        comptroller.approvedDelegates
          .whenCalledWith(await alice.getAddress(), leverageStrategiesManager.address)
          .returns(true);

        comptroller.getAccountLiquidity.returns([0, 0, parseEther("1")]); // err=0, liquidity=0, shortfall=1

        const borrowedAmountSeed = parseEther("1");
        const borrowedAmountToFlashLoan = parseEther("1");
        const swapData: string[] = [];

        await expect(
          leverageStrategiesManager.connect(alice).enterLeveragedPositionWithBorrowed(
            collateralMarket.address,
            borrowMarket.address,
            borrowedAmountSeed,
            borrowedAmountToFlashLoan,
            0, // minAmountOutAfterSwap
            swapData,
          ),
        ).to.be.rejectedWith("LeverageCausesLiquidation()");
      });

      it("should revert with LeverageCausesLiquidation when account becomes unsafe after operation", async () => {
        comptroller.approvedDelegates
          .whenCalledWith(await alice.getAddress(), leverageStrategiesManager.address)
          .returns(true);

        comptroller.executeFlashLoan.returns();

        comptroller.getAccountLiquidity.returnsAtCall(0, [0, parseEther("10"), 0]);
        comptroller.getAccountLiquidity.returnsAtCall(1, [0, 0, parseEther("1")]);

        const borrowedAmountSeed = parseEther("1");
        const borrowedAmountToFlashLoan = parseEther("1");
        const swapData: string[] = [];

        await expect(
          leverageStrategiesManager.connect(alice).enterLeveragedPositionWithBorrowed(
            collateralMarket.address,
            borrowMarket.address,
            borrowedAmountSeed,
            borrowedAmountToFlashLoan,
            0, // minAmountOutAfterSwap
            swapData,
          ),
        ).to.be.rejectedWith("LeverageCausesLiquidation()");
      });
    });
  });

  describe("exitLeveragedPosition", () => {
    describe("Happy Path", () => {
      it("should successfully exit leveraged position");

      it("should repay debt correctly");

      it("should redeem collateral correctly");

      it("should transfer dust to treasury");

      it("should keep account safe after exit");
    });

    describe("Edge Cases & Reverts", () => {
      it("should revert if user not delegated (Unauthorized)", async () => {
        comptroller.approvedDelegates
          .whenCalledWith(await alice.getAddress(), leverageStrategiesManager.address)
          .returns(false);

        const collateralAmountToRedeemForSwap = parseEther("1");
        const borrowedAmountToFlashLoan = parseEther("1");
        const swapData: string[] = [];

        await expect(
          leverageStrategiesManager.connect(alice).exitLeveragedPosition(
            collateralMarket.address,
            collateralAmountToRedeemForSwap,
            borrowMarket.address,
            borrowedAmountToFlashLoan,
            0, // minAmountOutAfterSwap
            swapData,
          ),
        ).to.be.rejectedWith("Unauthorized()");
      });
    });
  });

  describe("executeOperation (Flash Loan Callback)", () => {
    describe("Input Validation", () => {
      it("should revert if not called by authorized contract (ExecuteOperationNotCalledByAuthorizedContract)", async () => {
        const vTokens = [borrowMarket.address];
        const amounts = [parseEther("1")];
        const premiums = [parseEther("0.01")];
        const initiator = await alice.getAddress();
        const onBehalf = await alice.getAddress();
        const param = "0x";

        // Call executeOperation directly (not from comptroller) which should revert
        await expect(
          leverageStrategiesManager
            .connect(alice)
            .executeOperation(vTokens, amounts, premiums, initiator, onBehalf, param),
        ).to.be.rejectedWith("ExecuteOperationNotCalledByAuthorizedContract()");
      });

      it("should revert with FlashLoanAssetOrAmountMismatch when vTokens array has multiple elements", async () => {
        const initiator = await alice.getAddress();
        const onBehalf = await alice.getAddress();
        const param = "0x";

        const vTokensMultiple = [borrowMarket.address, collateralMarket.address];
        const amountsSingle = [parseEther("1")];
        const premiumsSingle = [parseEther("0.01")];

        await expect(
          leverageStrategiesManager
            .connect(comptrollerSigner)
            .executeOperation(vTokensMultiple, amountsSingle, premiumsSingle, initiator, onBehalf, param),
        ).to.be.rejectedWith("FlashLoanAssetOrAmountMismatch()");
      });

      it("should revert with FlashLoanAssetOrAmountMismatch when amounts array has multiple elements", async () => {
        const initiator = await alice.getAddress();
        const onBehalf = await alice.getAddress();
        const param = "0x";

        const vTokensSingle = [borrowMarket.address];
        const amountsMultiple = [parseEther("1"), parseEther("2")];
        const premiumsSingle = [parseEther("0.01")];

        await expect(
          leverageStrategiesManager
            .connect(comptrollerSigner)
            .executeOperation(vTokensSingle, amountsMultiple, premiumsSingle, initiator, onBehalf, param),
        ).to.be.rejectedWith("FlashLoanAssetOrAmountMismatch()");
      });

      it("should revert with FlashLoanAssetOrAmountMismatch when premiums array has multiple elements", async () => {
        const initiator = await alice.getAddress();
        const onBehalf = await alice.getAddress();
        const param = "0x";

        const vTokensSingle = [borrowMarket.address];
        const amountsSingle = [parseEther("1")];
        const premiumsMultiple = [parseEther("0.01"), parseEther("0.02")];

        await expect(
          leverageStrategiesManager
            .connect(comptrollerSigner)
            .executeOperation(vTokensSingle, amountsSingle, premiumsMultiple, initiator, onBehalf, param),
        ).to.be.rejectedWith("FlashLoanAssetOrAmountMismatch()");
      });

      it("should revert with FlashLoanAssetOrAmountMismatch when arrays are empty", async () => {
        const initiator = await alice.getAddress();
        const onBehalf = await alice.getAddress();
        const param = "0x";

        const vTokensEmpty: string[] = [];
        const amountsEmpty: any[] = [];
        const premiumsEmpty: any[] = [];

        await expect(
          leverageStrategiesManager
            .connect(comptrollerSigner)
            .executeOperation(vTokensEmpty, amountsEmpty, premiumsEmpty, initiator, onBehalf, param),
        ).to.be.rejectedWith("FlashLoanAssetOrAmountMismatch()");
      });

      it("should revert with ExecuteOperationNotCalledCorrectly when operation type is NONE", async () => {
        const initiator = await alice.getAddress();
        const onBehalf = await alice.getAddress();
        const param = "0x";

        const vTokens = [borrowMarket.address];
        const amounts = [parseEther("1")];
        const premiums = [parseEther("0.01")];

        await expect(
          leverageStrategiesManager
            .connect(comptrollerSigner)
            .executeOperation(vTokens, amounts, premiums, initiator, onBehalf, param),
        ).to.be.rejectedWith("ExecuteOperationNotCalledCorrectly()");
      });
    });
  });
});
