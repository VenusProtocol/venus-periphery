import { FakeContract, MockContract, smock } from "@defi-wonderland/smock";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
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

type SetupFixture = {
  leverageStrategiesManager: LeverageStrategiesManager;
  comptroller: FakeContract<ComptrollerMock>;
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

  return {
    leverageStrategiesManager,
    comptroller,
    protocolShareReserve,
    swapHelper,
    collateralMarket,
    borrowMarket,
  };
};

describe("LeverageStrategiesManager", () => {
  let leverageStrategiesManager: LeverageStrategiesManager;
  let comptroller: FakeContract<ComptrollerMock>;
  let protocolShareReserve: FakeContract<IProtocolShareReserve>;
  let swapHelper: FakeContract<SwapHelper>;
  let collateralMarket: FakeContract<IVToken>;
  let borrowMarket: FakeContract<IVToken>;
  let admin: Signer;
  let alice: Signer;
  let bob: Signer;

  beforeEach(async () => {
    [admin, alice, bob] = await ethers.getSigners();
    ({ leverageStrategiesManager, comptroller, protocolShareReserve, swapHelper, collateralMarket, borrowMarket } =
      await loadFixture(setupFixture));
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
    it("should require user delegation for enterLeveragedPosition", async () => {
      comptroller.approvedDelegates.returns(false);

      const collateralAmountSeed = parseEther("1");
      const borrowedAmountToFlashLoan = parseEther("1");
      const swapData: string[] = [];

      await expect(
        leverageStrategiesManager
          .connect(alice)
          .enterLeveragedPosition(
            collateralMarket.address,
            collateralAmountSeed,
            borrowMarket.address,
            borrowedAmountToFlashLoan,
            swapData,
          ),
      ).to.be.rejectedWith("0x82b42900"); // TODO: Change to rejectedWithCustomError Unauthorized() custom error
    });

    it("should require user delegation for exitLeveragedPosition", async () => {
      comptroller.approvedDelegates.returns(false);

      const collateralAmountToRedeemForSwap = parseEther("1");
      const borrowedAmountToFlashLoan = parseEther("1");
      const swapData: string[] = [];

      await expect(
        leverageStrategiesManager
          .connect(alice)
          .exitLeveragedPosition(
            collateralMarket.address,
            collateralAmountToRedeemForSwap,
            borrowMarket.address,
            borrowedAmountToFlashLoan,
            swapData,
          ),
      ).to.be.rejectedWith("0x82b42900"); // TODO: Change to rejectedWithCustomError Unauthorized() custom error
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
        leverageStrategiesManager
          .connect(bob)
          .enterLeveragedPosition(
            collateralMarket.address,
            collateralAmountSeed,
            borrowMarket.address,
            borrowedAmountToFlashLoan,
            swapData,
          ),
      ).to.be.rejectedWith("0x82b42900"); // TODO: Change to rejectedWithCustomError Unauthorized() custom error

      await expect(
        leverageStrategiesManager
          .connect(bob)
          .exitLeveragedPosition(
            collateralMarket.address,
            collateralAmountToRedeemForSwap,
            borrowMarket.address,
            borrowedAmountToFlashLoan,
            swapData,
          ),
      ).to.be.rejectedWith("0x82b42900"); // TODO: Change to rejectedWithCustomError Unauthorized() custom error
    });

    it("should allow approved delegates to call enterLeveragedPosition", async () => {
      comptroller.approvedDelegates
        .whenCalledWith(await alice.getAddress(), leverageStrategiesManager.address)
        .returns(true);

      comptroller.getAccountLiquidity.returns([0, parseEther("10"), 0]);

      comptroller.executeFlashLoan.returns();

      const collateralAmountSeed = parseEther("1");
      const borrowedAmountToFlashLoan = parseEther("1");
      const swapData: string[] = [];

      await leverageStrategiesManager
        .connect(alice)
        .enterLeveragedPosition(
          collateralMarket.address,
          collateralAmountSeed,
          borrowMarket.address,
          borrowedAmountToFlashLoan,
          swapData,
        );
    });

    it.skip("should allow approved delegates to call exitLeveragedPosition", async () => {});
  });

  describe("enterLeveragedPosition", () => {
    describe("Happy Path", () => {
      it("should successfully enter leveraged position with seed collateral");

      it("should enter leveraged position without seed collateral (amount = 0)");

      it("should verify flash loan execution flow");

      it("should mint collateral to user correctly");

      it("should borrow correct amount on behalf of user");
    });

    describe("Edge Cases & Reverts", () => {
      it("should revert if user not delegated (Unauthorized)");

      it("should revert if account becomes unsafe after operation (LeverageCausesLiquidation)");

      it("should revert if mint fails (EnterLeveragePositionFailed)");

      it("should revert if borrow fails (EnterLeveragePositionFailed)");

      it("should revert if swap fails (SwapCallFailed)");

      it("should handle various collateral seed amounts");
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
      it("should revert if user not delegated (Unauthorized)");

      it("should revert if repay fails (ExitLeveragePositionFailed)");

      it("should revert if redeem fails (ExitLeveragePositionFailed)");

      it("should revert if swap fails (SwapCallFailed)");

      it("should handle dust cleanup functionality");
    });
  });

  describe("executeOperation (Flash Loan Callback)", () => {
    describe("Input Validation", () => {
      it("should revert if arrays length mismatch (FlashLoanAssetOrAmountMismatch)");

      it("should handle ENTER operation type correctly");

      it("should handle EXIT operation type correctly");

      it("should return correct amounts to repay");
    });

    describe("State Management", () => {
      it("should use transient variables correctly");

      it("should switch operation type between ENTER/EXIT");
    });
  });

  describe("Internal Functions Integration", () => {
    describe("_performSwap", () => {
      it("should transfer tokens to SwapHelper");

      it("should execute multicall correctly");

      it("should handle swap failures");
    });

    describe("_transferDustToTreasury", () => {
      it("should transfer dust amounts to protocolShareReserve");

      it("should update assets state correctly");

      it("should handle zero dust amounts");
    });

    describe("_checkAccountSafe", () => {
      it("should detect account liquidity shortfall");

      it("should handle comptroller errors");

      it("should allow safe accounts");
    });
  });

  describe("Integration Tests", () => {
    it("should complete enter → exit cycle");

    it("should handle multiple leverage operations");

    it("should work with different collateral/borrow market combinations");

    it("should handle various swap scenarios");
  });

  describe("Error Handling & Edge Cases", () => {
    it("should handle flash loan execution failures");

    it("should handle market operation failures");

    it("should handle swap execution failures");

    it("should handle account safety violations");

    it("should handle unauthorized access attempts");
  });

  describe("State Consistency", () => {
    it("should reset transient variables properly");

    it("should not leave leftover state between operations");

    it("should cleanup properly on failures");
  });
});
