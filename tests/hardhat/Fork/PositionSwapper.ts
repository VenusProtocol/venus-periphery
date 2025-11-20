import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { parseEther, parseUnits } from "ethers/lib/utils";
import { ethers, upgrades } from "hardhat";

import {
  ComptrollerMock,
  ComptrollerMock__factory,
  Diamond__factory,
  IAccessControlManagerV5,
  IAccessControlManagerV5__factory,
  PositionSwapper,
  VBNB,
  VBNB__factory,
  VBep20Delegator,
  VToken,
  WBNBSwapHelper,
  WBNB__factory,
} from "../../../typechain";
import { forking, initMainnetUser } from "./utils";

const COMPTROLLER_ADDRESS = "0xfd36e2c2a6789db23113685031d7f16329158384";
const vBNB_ADDRESS = "0xA07c5b74C9B40447a954e1466938b865b6BBea36";
const WBNB_ADDRESS = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const NORMAL_TIMELOCK = "0x939bD8d64c0A9583A7Dcea9933f7b21697ab6396";
const SUPPLIER_ADDRESSES = ["0xf50453F0C5F8B46190a4833B136282b50c7343BE", "0xd14D59ddb9Cdaa0C20a9C31369bF2fc4eeAF56CB"];
const vWBNB_HOLDER = "0x6DF9aDc1837Bf37E0B1b943d59A7E50D9678c81B";
const BORROWER_ADDRESSES = "0xF322942f644A996A617BD29c16bd7d231d9F35E9";
const ACM = "0x4788629abc6cfca10f9f969efdeaa1cf70c23555";

const FORK_MAINNET = process.env.FORKED_NETWORK === "bscmainnet";

type SetupMarketFixture = {
  positionSwapper: PositionSwapper;
  coreComptroller: ComptrollerMock;
  vBNB: VBNB;
  vWBNB: VBep20Delegator;
  wBNBSwapHelper: WBNBSwapHelper;
};

export async function deployFreshVWBNB(
  timelock: SignerWithAddress,
): Promise<{ vWBNB: VToken; coreComptroller: ComptrollerMock }> {
  const VBEP20DELEGATE = "0x6E5cFf66C7b671fA1D5782866D80BD15955d79F6";
  const INTEREST_RATE_MODEL = "0x3aa125788FC6b9F801772baEa887aA40328015e9";
  const coreComptroller = ComptrollerMock__factory.connect(COMPTROLLER_ADDRESS, timelock);
  const vBep20Factory = await ethers.getContractFactory("VBep20Delegator", timelock);
  const vTokenConfig = {
    initialExchangeRateMantissa: parseUnits("1", 28),
    name: "Venus WBNB",
    symbol: "vWBNB",
    decimals: 8,
    becomeImplementationData: "0x",
  };
  const vWBNB = await vBep20Factory.deploy(
    WBNB_ADDRESS,
    COMPTROLLER_ADDRESS,
    INTEREST_RATE_MODEL,
    vTokenConfig.initialExchangeRateMantissa,
    vTokenConfig.name,
    vTokenConfig.symbol,
    vTokenConfig.decimals,
    NORMAL_TIMELOCK,
    VBEP20DELEGATE,
    vTokenConfig.becomeImplementationData,
  );
  await vWBNB.deployed();

  // List market
  await (await coreComptroller._supportMarket(vWBNB.address)).wait();

  // Set risk parameters
  await coreComptroller._setMarketSupplyCaps([vWBNB.address], [parseUnits("20000", 18)]);
  await coreComptroller._setMarketBorrowCaps([vWBNB.address], [parseUnits("0", 18)]);
  await coreComptroller._setCollateralFactor(vWBNB.address, parseUnits("0.85", 18));
  expect(await vWBNB.underlying()).equals(WBNB_ADDRESS);
  return { vWBNB, coreComptroller };
}

const setupMarketFixture = async (): Promise<SetupMarketFixture> => {
  const timelock = await initMainnetUser(NORMAL_TIMELOCK, ethers.utils.parseUnits("2"));
  const unitroller = Diamond__factory.connect(COMPTROLLER_ADDRESS, timelock);
  const vBNB = VBNB__factory.connect(vBNB_ADDRESS, timelock);
  const { vWBNB, coreComptroller } = await deployFreshVWBNB(timelock);

  const PositionSwapperFactory = await ethers.getContractFactory("PositionSwapper");
  const positionSwapper = await upgrades.deployProxy(PositionSwapperFactory, [], {
    constructorArgs: [COMPTROLLER_ADDRESS, vBNB_ADDRESS],
    initializer: "initialize",
    unsafeAllow: ["state-variable-immutable"],
  });
  const WBNBSwapHelperFactory = await ethers.getContractFactory("WBNBSwapHelper");
  const wBNBSwapHelper = await WBNBSwapHelperFactory.deploy(WBNB_ADDRESS, positionSwapper.address);

  await positionSwapper.setApprovedPair(vBNB.address, vWBNB.address, wBNBSwapHelper.address, true);

  const PolicyFacet = await ethers.getContractFactory("PolicyFacet");
  const policyFacet = await PolicyFacet.deploy();

  const selectorsReplace = [PolicyFacet.interface.getSighash("seizeAllowed(address,address,address,address,uint256)")];

  const selectorsAdd = [PolicyFacet.interface.getSighash("borrowAllowed(address,address,address,uint256)")];

  await unitroller.connect(timelock).diamondCut([
    {
      facetAddress: policyFacet.address,
      action: 1,
      functionSelectors: selectorsReplace,
    },
    {
      facetAddress: policyFacet.address,
      action: 0,
      functionSelectors: selectorsAdd,
    },
  ]);

  const SetterFacet = await ethers.getContractFactory("SetterFacet");
  const setterFacet = await SetterFacet.deploy();

  const selectors = [SetterFacet.interface.getSighash("_setWhitelistedExecutor(address,bool)")];

  await unitroller.connect(timelock).diamondCut([
    {
      facetAddress: setterFacet.address,
      action: 0,
      functionSelectors: selectors,
    },
  ]);

  const MarketFacet = await ethers.getContractFactory("MarketFacet");
  const marketFacet = await MarketFacet.deploy();

  const selectorsMarketFacet = [MarketFacet.interface.getSighash("enterMarket(address,address)")];

  await unitroller.connect(timelock).diamondCut([
    {
      facetAddress: marketFacet.address,
      action: 0,
      functionSelectors: selectorsMarketFacet,
    },
  ]);

  const acm = IAccessControlManagerV5__factory.connect(ACM, timelock) as IAccessControlManagerV5;
  await acm
    .connect(timelock)
    .giveCallPermission(coreComptroller.address, "_setWhitelistedExecutor(address,bool)", timelock.address);
  await coreComptroller.connect(timelock)._setWhitelistedExecutor(positionSwapper.address, true);

  const VBep20Delegate = await ethers.getContractFactory("VBep20Delegate");
  const vBep20Delegate = await VBep20Delegate.deploy();

  await vWBNB.connect(timelock)._setImplementation(vBep20Delegate.address, false, "0x");

  const wBNBHolder = await initMainnetUser(vWBNB_HOLDER, ethers.utils.parseEther("100"));
  const wBNB = WBNB__factory.connect(WBNB_ADDRESS, wBNBHolder);
  await wBNB.approve(vWBNB.address, ethers.utils.parseEther("0"));
  await wBNB.approve(vWBNB.address, ethers.utils.parseEther("100"));
  await vWBNB.connect(wBNBHolder).mint(ethers.utils.parseEther("100"));

  return {
    positionSwapper,
    coreComptroller,
    vBNB,
    vWBNB,
    wBNBSwapHelper,
  };
};

// ---------- Main Forked Test ----------
if (FORK_MAINNET) {
  const blockNumber = 55239594;
  forking(blockNumber, () => {
    let positionSwapper: PositionSwapper;
    let coreComptroller: ComptrollerMock;
    let vBNB: VBNB;
    let vWBNB: VBep20Delegator;
    let wBNBSwapHelper: WBNBSwapHelper;

    describe("PositionSwapper Upgrade + Swap Flow", () => {
      beforeEach(async () => {
        ({ positionSwapper, coreComptroller, vBNB, vWBNB, wBNBSwapHelper } = await loadFixture(setupMarketFixture));
      });

      describe("Collateral Swapping", () => {
        it("should revert when user has insufficient or zero vBNB balance", async () => {
          const LOW_BALANCE_USER = "0xc20A9dc2Ef57b02D97d9A41F179686887C85c71b";
          const lowBalanceUserSigner = await initMainnetUser(LOW_BALANCE_USER, ethers.utils.parseUnits("2"));
          const vBNBBalance = await vBNB.balanceOf(LOW_BALANCE_USER);
          expect(vBNBBalance).equals(0);
          await expect(
            positionSwapper
              .connect(lowBalanceUserSigner)
              .swapFullCollateral(LOW_BALANCE_USER, vBNB_ADDRESS, vWBNB.address, wBNBSwapHelper.address),
          ).to.be.revertedWithCustomError(positionSwapper, "NoVTokenBalance");

          await expect(
            positionSwapper
              .connect(lowBalanceUserSigner)
              .swapCollateralWithAmount(
                LOW_BALANCE_USER,
                vBNB_ADDRESS,
                vWBNB.address,
                ethers.utils.parseEther("0.1"),
                wBNBSwapHelper.address,
              ),
          ).to.be.revertedWithCustomError(positionSwapper, "NoVTokenBalance");
        });

        it("should enter market if not entered when swapping the collateral", async () => {
          for (const address of SUPPLIER_ADDRESSES) {
            let membership = await coreComptroller.checkMembership(address, vWBNB.address);
            expect(membership).to.be.false;
            const supplier = await initMainnetUser(address, ethers.utils.parseUnits("2"));
            await expect(
              positionSwapper
                .connect(supplier)
                .swapFullCollateral(address, vBNB_ADDRESS, vWBNB.address, wBNBSwapHelper.address),
            ).to.be.not.reverted;
            membership = await coreComptroller.checkMembership(address, vWBNB.address);
            expect(membership).to.be.true;
          }
        });

        it("should partially swap vBNB to vWBNB for a user", async () => {
          const address = SUPPLIER_ADDRESSES[0];
          const supplier = await initMainnetUser(address, ethers.utils.parseUnits("2"));

          const fullBalance = await vBNB.balanceOf(address);
          const amountToSeize = fullBalance.div(10); // 10% partial

          expect(amountToSeize).to.be.gt(0);

          const beforeVBNB = await vBNB.balanceOf(address);
          const beforeVWBNB = await vWBNB.balanceOf(address);

          await positionSwapper
            .connect(supplier)
            .swapCollateralWithAmount(address, vBNB_ADDRESS, vWBNB.address, amountToSeize, wBNBSwapHelper.address);

          const afterVBNB = await vBNB.balanceOf(address);
          const afterVWBNB = await vWBNB.balanceOf(address);

          // Assertions
          expect(afterVBNB).to.equal(beforeVBNB.sub(amountToSeize));
          expect(afterVWBNB).to.be.gt(beforeVWBNB);
        });

        it("should swap full vBNB to vWBNB for multiple suppliers", async () => {
          for (const address of SUPPLIER_ADDRESSES) {
            const supplier = await initMainnetUser(address, ethers.utils.parseUnits("2"));
            const beforeVWbnb = await vWBNB.balanceOf(address);
            // to avoid liquidations
            await coreComptroller.connect(supplier).enterMarkets([vWBNB.address]);
            await positionSwapper
              .connect(supplier)
              .swapFullCollateral(address, vBNB_ADDRESS, vWBNB.address, wBNBSwapHelper.address);

            const afterVBnb = await vBNB.balanceOf(address);
            const afterVWbnb = await vWBNB.balanceOf(address);

            expect(afterVBnb).to.equal(0);
            expect(afterVWbnb).to.be.gt(beforeVWbnb);
          }
        });
      });

      describe("Debt Swapping", () => {
        it("should partially swap vBNB to vWBNB for a user", async () => {
          const borrower = await initMainnetUser(BORROWER_ADDRESSES, ethers.utils.parseUnits("2"));
          const amountOfBorrow = parseEther("1");

          await vBNB.connect(borrower).borrow(amountOfBorrow);

          const borrowedBalanceBefore = await vWBNB.callStatic.borrowBalanceCurrent(await borrower.getAddress());
          expect(borrowedBalanceBefore).to.be.eq(0);

          await coreComptroller.connect(borrower).updateDelegate(positionSwapper.address, true);

          const amountOfBorrowToSwap = amountOfBorrow.div(2); // 50% partial

          await coreComptroller._setMarketBorrowCaps([vWBNB.address], [parseUnits("2", 18)]);

          await positionSwapper
            .connect(borrower)
            .swapDebtWithAmount(
              await borrower.getAddress(),
              vBNB.address,
              vWBNB.address,
              amountOfBorrowToSwap,
              wBNBSwapHelper.address,
            );

          const borrowedBalanceAfter = await vWBNB.callStatic.borrowBalanceCurrent(await borrower.getAddress());
          expect(borrowedBalanceAfter).to.be.eq(amountOfBorrowToSwap);
        });

        it("should swap full vBNB to vWBNB for a user", async () => {
          const borrower = await initMainnetUser(BORROWER_ADDRESSES, ethers.utils.parseUnits("2"));
          const amountOfBorrow = parseEther("1");

          await vBNB.connect(borrower).borrow(amountOfBorrow);

          const borrowedBalanceBefore = await vWBNB.callStatic.borrowBalanceCurrent(await borrower.getAddress());

          await coreComptroller.connect(borrower).updateDelegate(positionSwapper.address, true);

          await coreComptroller._setMarketBorrowCaps([vWBNB.address], [parseUnits("2", 18)]);

          await positionSwapper
            .connect(borrower)
            .swapFullDebt(await borrower.getAddress(), vBNB.address, vWBNB.address, wBNBSwapHelper.address);

          const borrowedBalanceAfter = await vWBNB.callStatic.borrowBalanceCurrent(await borrower.getAddress());
          expect(borrowedBalanceAfter).to.be.gt(borrowedBalanceBefore);
        });
      });
    });
  });
}
