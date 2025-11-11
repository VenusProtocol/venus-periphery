import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { Signer, Wallet } from "ethers";
import { parseEther, parseUnits } from "ethers/lib/utils";
import { ethers, network, upgrades } from "hardhat";

import {
  ChainlinkOracle__factory,
  ComptrollerMock,
  ComptrollerMock__factory,
  Diamond__factory,
  IAccessControlManagerV8__factory,
  IERC20,
  IERC20__factory,
  PositionSwapper,
  SwapHelper,
  Unitroller__factory,
  VBNB,
  VBNB__factory,
  VBep20Delegator,
  VBep20Delegator__factory,
  VToken__factory,
  WBNB,
  WBNB__factory,
} from "../../../typechain";
import { forking, initMainnetUser } from "./utils";

const NORMAL_TIMELOCK = "0x939bD8d64c0A9583A7Dcea9933f7b21697ab6396";
const ACM = "0x4788629abc6cfca10f9f969efdeaa1cf70c23555";
const COMPTROLLER_ADDRESS = "0xfd36e2c2a6789db23113685031d7f16329158384";
const WBNB_ADDRESS = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const vBNB_ADDRESS = "0xA07c5b74C9B40447a954e1466938b865b6BBea36";
const vWBNB_ADDRESS = "0x6bCa74586218dB34cdB402295796b79663d816e9";

const USDC_ADDRESS = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d";
const ETH_ADDRESS = "0x2170Ed0880ac9A755fd29B2688956BD959F933F8";
const vUSDC_ADDRESS = "0xecA88125a5ADbe82614ffC12D0DB554E2e2867C8";
const vETH_ADDRESS = "0xf508fCD89b8bd15579dc79A6827cB4686A3592c8";

// Random Mainnet Users
const vBNB_HOLDER = "0x7DD0c8CeDA0dCc86E71AE6D30E505c3d30072dC8";
const vBNB_BORROWER = "0x680258C252F543Db74b3e8A16345403B2E80125A";
const vWBNB_HOLDER = "0x16C5433742ACCBB84Fa471A9a76352199Ba4c197";
const vETH_BORROWER = "0x335545620C08cE96DfC83dFcC8C91E02235E5C28";

const FORK_MAINNET = process.env.FORKED_NETWORK === "bscmainnet";

type SetupMarketFixture = {
  timelock: Signer;
  positionSwapper: PositionSwapper;
  swapHelper: SwapHelper;
  comptroller: ComptrollerMock;
  WBNB: WBNB;
  USDC: IERC20;
  ETH: IERC20;
  vBNB: VBNB;
  vWBNB: VBep20Delegator;
  vUSDC: VBep20Delegator;
  vETH: VBep20Delegator;
};

// Extracts function selectors from a contract ABI
function getSelectors(contract: any) {
  const signatures = Object.keys(contract.interface.functions);
  const selectors: any = signatures.reduce((acc: any, val) => {
    if (val !== "init(bytes)") {
      acc.push(contract.interface.getSighash(val));
    }
    return acc;
  }, []);
  selectors.contract = contract;
  return selectors;
}

// Upgrades Comptroller to support flash loans (can be removed once FlashLoan VIP is executed)
async function upgradeComptroller(timelock: Signer) {
  const FacetCutAction = { Add: 0, Replace: 1, Remove: 2 };

  const DiamondFactory = await ethers.getContractFactory("Diamond");
  const newDiamond = await DiamondFactory.deploy();

  const Unitroller = Unitroller__factory.connect(COMPTROLLER_ADDRESS, timelock);
  await Unitroller._setPendingImplementation(newDiamond.address);
  await newDiamond.connect(timelock)._become(Unitroller.address);

  const diamond = Diamond__factory.connect(COMPTROLLER_ADDRESS, timelock);

  // Remove all existing facets
  const cut: any[] = [];
  const facets = await diamond.facets();

  for (const facet of facets) {
    cut.push({
      facetAddress: ethers.constants.AddressZero,
      action: FacetCutAction.Remove,
      functionSelectors: facet.functionSelectors,
    });
  }

  await diamond.diamondCut(cut);
  cut.length = 0;

  // Deploy and add new facets including FlashLoanFacet
  const FacetNames = ["MarketFacet", "PolicyFacet", "SetterFacet", "RewardFacet", "FlashLoanFacet"];
  for (const FacetName of FacetNames) {
    const Facet = await ethers.getContractFactory(FacetName);
    const facet = await Facet.deploy();
    await facet.deployed();

    const facetInterface = await ethers.getContractAt(`I${FacetName}`, facet.address);
    cut.push({
      facetAddress: facet.address,
      action: FacetCutAction.Add,
      functionSelectors: getSelectors(facetInterface),
    });
  }

  await diamond.diamondCut(cut);
  const comptroller = ComptrollerMock__factory.connect(COMPTROLLER_ADDRESS, timelock);

  const ComptrollerLens = await ethers.getContractFactory("ComptrollerLens");
  const lens = await ComptrollerLens.deploy();
  await comptroller._setComptrollerLens(lens.address);

  const acm = IAccessControlManagerV8__factory.connect(ACM, timelock);
  await acm.giveCallPermission(COMPTROLLER_ADDRESS, "setWhiteListFlashLoanAccount(address,bool)", NORMAL_TIMELOCK);
}

// Upgrades vToken implementations to support flash loans
async function upgradeVTokens(timelock: Signer) {
  const UpdatedVToken = await ethers.getContractFactory("VBep20Delegate");
  const vTokenImpl = await UpdatedVToken.deploy();

  const vUSDC = VBep20Delegator__factory.connect(vUSDC_ADDRESS, ethers.provider);
  const vWBNB = VBep20Delegator__factory.connect(vWBNB_ADDRESS, ethers.provider);
  const vETH = VBep20Delegator__factory.connect(vETH_ADDRESS, ethers.provider);

  await vUSDC.connect(timelock)._setImplementation(vTokenImpl.address, false, "0x");
  await vWBNB.connect(timelock)._setImplementation(vTokenImpl.address, false, "0x");
  await vETH.connect(timelock)._setImplementation(vTokenImpl.address, false, "0x");

  const acm = IAccessControlManagerV8__factory.connect(ACM, timelock);
  for (const vTokenAddress of [vUSDC_ADDRESS, vWBNB_ADDRESS, vETH_ADDRESS]) {
    await acm.giveCallPermission(vTokenAddress, "setFlashLoanEnabled(bool)", NORMAL_TIMELOCK);
    const market = VToken__factory.connect(vTokenAddress, timelock);
    await market.setFlashLoanEnabled(true);
  }
}

async function setMaxStalePeriod() {
  const REDSTONE = "0x8455EFA4D7Ff63b8BFD96AdD889483Ea7d39B70a";
  const CHAINLINK = "0x1B2103441A0A108daD8848D8F5d790e4D402921F";
  const BINANCE = "0x594810b741d136f1960141C0d8Fb4a91bE78A820";
  const timelock = await initMainnetUser(NORMAL_TIMELOCK, parseUnits("2"));

  const redStoneOracle = ChainlinkOracle__factory.connect(REDSTONE, timelock);
  const chainlinkOracle = ChainlinkOracle__factory.connect(CHAINLINK, timelock);

  // WBNB
  await redStoneOracle.setTokenConfig({
    asset: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    feed: "0x8dd2D85C7c28F43F965AE4d9545189C7D022ED0e",
    maxStalePeriod: "31536000", // 1 year
  });
  await chainlinkOracle.setTokenConfig({
    asset: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    feed: "0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE",
    maxStalePeriod: "31536000", // 1 year
  });
}

const setupMarketFixture = async (): Promise<SetupMarketFixture> => {
  const [root] = await ethers.getSigners();
  const timelock = await initMainnetUser(NORMAL_TIMELOCK, parseUnits("2"));
  const comptroller = await ComptrollerMock__factory.connect(COMPTROLLER_ADDRESS, timelock);

  const SwapHelperFactory = await ethers.getContractFactory("SwapHelper");
  const swapHelper = await SwapHelperFactory.deploy(WBNB_ADDRESS, root.address);

  const positionSwapperFactory = await ethers.getContractFactory("PositionSwapper");
  const positionSwapper = await upgrades.deployProxy(positionSwapperFactory, [], {
    constructorArgs: [comptroller.address, swapHelper.address, WBNB_ADDRESS, vBNB_ADDRESS, vWBNB_ADDRESS],
    initializer: "initialize",
    unsafeAllow: ["state-variable-immutable"],
  });

  const WBNB = WBNB__factory.connect(WBNB_ADDRESS, root);
  const USDC = IERC20__factory.connect(USDC_ADDRESS, root);
  const ETH = IERC20__factory.connect(ETH_ADDRESS, root);

  const vBNB = VBNB__factory.connect(vBNB_ADDRESS, timelock);
  const vWBNB = VBep20Delegator__factory.connect(vWBNB_ADDRESS, timelock);
  const vUSDC = VBep20Delegator__factory.connect(vUSDC_ADDRESS, timelock);
  const vETH = VBep20Delegator__factory.connect(vETH_ADDRESS, timelock);

  return {
    timelock,
    positionSwapper,
    swapHelper,
    comptroller,
    USDC,
    ETH,
    WBNB,
    vBNB,
    vWBNB,
    vUSDC,
    vETH,
  };
};

async function createSwapAPICallData(
  swapHelper: SwapHelper,
  positionSwapper: string,
  balmytarget: string,
  balmyCalldata: string,
  tokenIn: string,
  tokenOut: string,
): Promise<string> {
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

  // Encode  function call
  const approveMaxCall = swapHelper.interface.encodeFunctionData("approveMax", [tokenIn, balmytarget]);
  const genericCall = swapHelper.interface.encodeFunctionData("genericCall", [balmytarget, balmyCalldata]);
  const tokenInSweepCall = swapHelper.interface.encodeFunctionData("sweep", [tokenIn, positionSwapper]);
  const tokenOutSweepCall = swapHelper.interface.encodeFunctionData("sweep", [tokenOut, positionSwapper]);

  const calls = [approveMaxCall, genericCall, tokenInSweepCall, tokenOutSweepCall];
  const deadline = "17627727131762772187"; // Long time
  const saltValue = ethers.utils.formatBytes32String(Math.random().toString());

  const [root] = await ethers.getSigners();
  const signature = await root._signTypedData(domain, types, { calls, deadline, salt: saltValue });

  // Encode multicall with all parameters
  const multicallData = swapHelper.interface.encodeFunctionData("multicall", [calls, deadline, saltValue, signature]);
  return multicallData;
}

// ---------- Main Forked Test ----------
if (FORK_MAINNET) {
  const blockNumber = 67821494;
  forking(blockNumber, () => {
    describe("PositionSwapper Fork Tests", function () {
      this.timeout(300000); // 5 minutes
      let positionSwapper: PositionSwapper;
      let swapHelper: SwapHelper;
      let comptroller: ComptrollerMock;
      let vBNB: VBNB;
      let vWBNB: VBep20Delegator;
      let vUSDC: VBep20Delegator;
      let vETH: VBep20Delegator;
      before(async function () {
        const timelock = await initMainnetUser(NORMAL_TIMELOCK, parseUnits("2"));
        await upgradeComptroller(timelock);
        await upgradeVTokens(timelock);
        await setMaxStalePeriod();
      });

      beforeEach(async function () {
        ({ positionSwapper, comptroller, vBNB, vWBNB, vUSDC, vETH, swapHelper } = await loadFixture(
          setupMarketFixture,
        ));
        await comptroller.setWhiteListFlashLoanAccount(positionSwapper.address, true);
      });

      describe("swapCollateralNativeToWrapped", () => {
        it("should successfully migrate native collateral (vBNB) to wrapped collateral (vWBNB)", async function () {
          const vBNB_HOLDER_SIGNER = await initMainnetUser(vBNB_HOLDER, parseEther("2"));
          await comptroller.connect(vBNB_HOLDER_SIGNER).updateDelegate(positionSwapper.address, true);
          const vBNBTokenBalance = await vBNB.balanceOf(vBNB_HOLDER);
          await vBNB.connect(vBNB_HOLDER_SIGNER).approve(positionSwapper.address, vBNBTokenBalance);

          const initialBNBBalance = await vBNB.callStatic.balanceOfUnderlying(vBNB_HOLDER);
          const initialWBNBBalance = await vWBNB.callStatic.balanceOfUnderlying(vBNB_HOLDER);
          const initialVBNBTokenBalance = await vBNB.balanceOf(vBNB_HOLDER);

          expect(initialBNBBalance).to.be.gt(0);
          expect(initialWBNBBalance).to.equal(0);
          expect(initialVBNBTokenBalance).to.be.gt(0);

          const tx = await positionSwapper.connect(vBNB_HOLDER_SIGNER).swapCollateralNativeToWrapped(vBNB_HOLDER);

          const receipt = await tx.wait();
          expect(receipt.status).to.equal(1);

          const finalBNBBalance = await vBNB.callStatic.balanceOfUnderlying(vBNB_HOLDER);
          const finalWBNBBalance = await vWBNB.callStatic.balanceOfUnderlying(vBNB_HOLDER);
          const finalVBNBTokenBalance = await vBNB.balanceOf(vBNB_HOLDER);

          expect(finalBNBBalance).to.equal(0);
          const tolerance = parseUnits("0.00000001", 18);
          expect(finalWBNBBalance).to.be.closeTo(initialBNBBalance, tolerance);
          expect(finalVBNBTokenBalance).to.equal(0);
        });
      });

      describe("swapDebtNativeToWrapped", () => {
        it("should successfully migrate native debt (vBNB borrow) to wrapped debt (vWBNB borrow)", async function () {
          const vBNB_BORROWER_SIGNER = await initMainnetUser(vBNB_BORROWER, parseEther("2"));

          await comptroller.connect(vBNB_BORROWER_SIGNER).updateDelegate(positionSwapper.address, true);

          const initialBNBBorrowBalance = await vBNB.callStatic.borrowBalanceCurrent(vBNB_BORROWER);
          const initialWBNBBorrowBalance = await vWBNB.callStatic.borrowBalanceCurrent(vBNB_BORROWER);

          expect(initialBNBBorrowBalance).to.be.gt(0);
          expect(initialWBNBBorrowBalance).to.equal(0);

          await positionSwapper.connect(vBNB_BORROWER_SIGNER).swapDebtNativeToWrapped(vBNB_BORROWER);

          const finalBNBBorrowBalance = await vBNB.callStatic.borrowBalanceCurrent(vBNB_BORROWER);
          const finalWBNBBorrowBalance = await vWBNB.callStatic.borrowBalanceCurrent(vBNB_BORROWER);

          expect(finalBNBBorrowBalance).to.equal(0);
          expect(finalWBNBBorrowBalance).to.be.gt(0);
          const tolerance = parseUnits("0.00000001", 18);
          expect(finalWBNBBorrowBalance).to.be.closeTo(initialBNBBorrowBalance, tolerance);
        });
      });

      describe("swapCollateral", () => {
        it("should swapFullCollateral from vWBNB to vUSDC", async function () {
          const vWBNB_HOLDER_SIGNER = await initMainnetUser(vWBNB_HOLDER, parseEther("2"));
          await comptroller.connect(vWBNB_HOLDER_SIGNER).updateDelegate(positionSwapper.address, true);
          const initialWBNBBalance = await vWBNB.callStatic.balanceOfUnderlying(vWBNB_HOLDER); // maxSellAmount
          expect(await vUSDC.callStatic.balanceOfUnderlying(vWBNB_HOLDER)).to.equals(0);
          const minCollateralToSupply = "1944062422904312610393"; // ~1% slippage
          const balmyCalldata =
            "0x5ae401dc00000000000000000000000000000000000000000000000000000000691343800000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000124b858183f000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000800000000000000000000000001148959f1ef3b32aa8c5484393723b79c2cd2a260000000000000000000000000000000000000000000000001bc38f4c890ad8a400000000000000000000000000000000000000000000006965fbe6ad76010f7a0000000000000000000000000000000000000000000000000000000000000042bb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c00006455d398326f99059ff775485246999027b31979550000648ac76a51cc950d9822d68b83fe1ad97b32cd580d00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
          const balmyTarget = "0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2"; // uniswap

          const multicallData = await createSwapAPICallData(
            swapHelper,
            positionSwapper.address,
            balmyTarget,
            balmyCalldata,
            WBNB_ADDRESS,
            USDC_ADDRESS,
          );

          // Swap Collateral
          const tx = await positionSwapper
            .connect(vWBNB_HOLDER_SIGNER)
            .swapFullCollateral(vWBNB_HOLDER, vWBNB_ADDRESS, vUSDC_ADDRESS, minCollateralToSupply, [multicallData]);
          const receipt = await tx.wait();
          expect(receipt.status).to.equal(1);
          const tolerance = parseUnits("0.0000001", 18);
          expect(await vWBNB.callStatic.balanceOfUnderlying(vWBNB_HOLDER)).to.be.lt(initialWBNBBalance);
          expect(await vWBNB.callStatic.balanceOfUnderlying(vWBNB_HOLDER)).to.be.closeTo(0, tolerance);
          expect(await vUSDC.callStatic.balanceOfUnderlying(vWBNB_HOLDER)).to.be.gt(minCollateralToSupply);
        });

        it("should swapCollateralWithAmount from vWBNB to vUSDC (using full amount argument)", async function () {
          const vWBNB_HOLDER_SIGNER = await initMainnetUser(vWBNB_HOLDER, parseEther("2"));
          await comptroller.connect(vWBNB_HOLDER_SIGNER).updateDelegate(positionSwapper.address, true);
          const initialWBNBBalance = await vWBNB.callStatic.balanceOfUnderlying(vWBNB_HOLDER); // amount argument
          expect(await vUSDC.callStatic.balanceOfUnderlying(vWBNB_HOLDER)).to.equals(0);
          const minCollateralToSupply = "1944062422904312610393"; // ~1% slippage
          const balmyCalldata =
            "0x5ae401dc00000000000000000000000000000000000000000000000000000000691343800000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000124b858183f000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000800000000000000000000000001148959f1ef3b32aa8c5484393723b79c2cd2a260000000000000000000000000000000000000000000000001bc38f4c890ad8a400000000000000000000000000000000000000000000006965fbe6ad76010f7a0000000000000000000000000000000000000000000000000000000000000042bb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c00006455d398326f99059ff775485246999027b31979550000648ac76a51cc950d9822d68b83fe1ad97b32cd580d00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
          const balmyTarget = "0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2"; // uniswap

          const multicallData = await createSwapAPICallData(
            swapHelper,
            positionSwapper.address,
            balmyTarget,
            balmyCalldata,
            WBNB_ADDRESS,
            USDC_ADDRESS,
          );

          const tx = await positionSwapper
            .connect(vWBNB_HOLDER_SIGNER)
            .swapCollateralWithAmount(
              vWBNB_HOLDER,
              vWBNB_ADDRESS,
              vUSDC_ADDRESS,
              initialWBNBBalance,
              minCollateralToSupply,
              [multicallData],
            );
          const receipt = await tx.wait();
          expect(receipt.status).to.equal(1);
          const tolerance = parseUnits("0.0000001", 18);
          expect(await vWBNB.callStatic.balanceOfUnderlying(vWBNB_HOLDER)).to.be.closeTo(0, tolerance);
          expect(await vUSDC.callStatic.balanceOfUnderlying(vWBNB_HOLDER)).to.be.gt(minCollateralToSupply);
        });
      });

      describe("swapDebt", () => {
        it("should swapFullDebt from vETH to vUSDC", async function () {
          const vETH_BORROWER_SIGNER = await initMainnetUser(vETH_BORROWER, parseEther("2"));
          await comptroller.connect(vETH_BORROWER_SIGNER).updateDelegate(positionSwapper.address, true);
          const initialWBNBBorrow = await vETH.callStatic.borrowBalanceCurrent(vETH_BORROWER);
          const initialUSDCBorrow = await vUSDC.callStatic.borrowBalanceCurrent(vETH_BORROWER);
          expect(initialWBNBBorrow).to.be.gt(0);
          expect(initialUSDCBorrow).to.equal(0);

          const balmyCalldata =
            "0x83bd37f900018ac76a51cc950d9822d68b83fe1ad97b32cd580d00012170ed0880ac9a755fd29b2688956bd959f933f80a75524c2b08c3a8ec00000908695eee01390e8000028f5c0001da4F2e8041aa91A93B1D46Cf224Bbd4e9134a9EC000000011148959f1ef3b32AA8c5484393723B79C2Cd2a265b65fbbe3a150a3c0103b6de3b0b0101020301020104118a640a01040203010001031eab4a230105020203010f1249020e01000602000102840ecf2c010002030000000407080000000000000100000001089ffb3c2c0100020300000001070800000000000001000000010e08d2a20e010009020001309cc0f70e01000a0200014a7568f60e01000b02000143f27b970f0100020300000006000001000103e4c76f0f01000203000000640000010001b6cc29060f0100020300000002000001000117fb3a080a020c020d0001011b90ec6823020e020200011ea930340e02000f0201012222e98121021002000118000a290e0300110200011d79dcb10e0400120201011b0a8d7a0e0501130200011a6c1d660e0501140200000e0600150201032655edf600000302bb8dbf0e070016030103174ae13f0e0700170301039440f7140e0700180301032369e7cd0e07001903010304e879f50e07001a030103bd638da50e08001b0301035e00582a0e08001c030103ae23ea9b0e08001d0301020f0900031e000001f400000a000c0609000548af89970a001f0d030100052da69fad0e0000200d00054689a8ec0e0000210d00042100220d00060e0200232400080e000025260011049cfdaf0305010127240019110e91420f0e050128240011152a336b0e050129240011286079e40e05012a2400100e05012b24000f0590865e030501012c2d00190f057e18a50e05012e2d000f61ec87b80e05012f2d000f07c8ddb70e0501302d000f9ee75ff60e0501312d000f0bfeb23e0e0501322d000fb1e759a30e0501332d000e0e0501342d00010b1525ed0e05013503000108d32f360e050136030001354476c20e0501370300000c05010338040e0501393a00122c05011e380100014f073b00000000000005000001ff0000000000000000000000000000160caed03795365f3a589f10c379ffa7d75d4e768ac76a51cc950d9822d68b83fe1ad97b32cd580d55d398326f99059ff775485246999027b31979553efebc418efb585248a0d2140cfb87afcc2c63dd28ec0b36f0819ecb5005cab836f4ed5a2eca4d137491c04dc4575e086a8ee31f7ce1c6d56fb7dcc1238a358808379702088667322f80ac48bad5e6c4a0ffb9c1ce1fe56963b0321b32e7a0302114058b4f31fa980a675570939b737ebdde0471a4be40eb2c3c320d49019d4f9a92352e947c7e5acfe47d6892b7807bf19b7dddf89b706143896d05228f3121c2f5b9a3d9138ab2b74d581fc11346219ebf43fee9e7cea3dedca5984780bafc599bd69add087d561b3771a66ee31180906972580ade9b81afc5fcdc22536030b9ce783b6ddfb9a39ac7f439f568e5e66064dbd0ff10bfed5a797807042e9f63f18cfe10e1799b52c010ad415325d19af139e20b8aa8aab0f66a930ed3b004ba16ee11b3a9b142eaf2259b0dd8cc6bfdee087148c220e9141a075d18418abbac539e0ebfffd39e54a0f7e5f8fec40ade7933a664f2688fb5b81049dfb7703ada5e770543770612c49ea0f51fd2133d995cf00229bc523737415ad31847a90a2d92a8367a91efa1906bfc8c1e05bf10c4172fcd41e0913e95784454622d1c3724f546f84936696169c63e42cd08ce11f5deebbcebae6520507862d9b4be2156b15d54f41ee4ede2d5b0b455e446cf1cf8c69595804ba91dfdd8d6b960c9b0a7c4813c0decbb1097fff46d0ed6a39fb5f6a83043f4247f51881d1e3ae0f759afb801413a6c948ef4420000000000000000000000000000000000000000169f653a54acd441ab34b73da9946e2c451787efc98f01bf2141e1140ef8f8cad99d4b021d10718f4f3126d5de26413abdcf6948943fb9d0847d9818be60d4c4250438344bec816ec2dec99925deb4c7cc1c80529b483a663d869c137a1fd0cbd9855dc87130d2a12b9bcbfae4f2634d864a1ee1ce3ead9cbf72b6485e4b31601afe7b0a1210be2004d2b1d6c5f0f7b66764f6ec8c8dff7ba683102295e16409d171b26e4484402de70e3ea256be5a2630d7e88d7d1d3649232f28bf7467e9cdb27e6d902c16a1653fb2623567e21f8c50f0ae86f54ef4849b4eb47bd4dca84e1808da3354924cd243c66828cf7754704bba1018b967e59220b22ca03f68821a3276c9a674e4716e431f45807dcf19f284c7aa99f18a4fbcbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c1123e75b71019962cd4d21b0f3018a6412edb63c58f04aada1051885a3c4e296aab0a454ea1233a34fb87838a29b37598099ef5aa6b3fbeeef987c50d0e226f674bbf064f54ab47f42473ff80db98cba7d05c84581f0c41ad80ddf677a510360bae09a5a62fcb3c1794fb95bd8b1a97f6ad5d8a7e4943a1e0f338ec12d3f7c3d77a4b9fcc1f95f3fb6ad0ea68829abfa1a7b017078195c10a966d7411a0c95159f599f3d64a9d99ea21e68127bb6ce99f893da61be141893e4c6ad9272e8c04bab7e6a10604501a52170ed0880ac9a755fd29b2688956bd959f933f86cb5392b9ca52d7a0e6940e82d29087361360ec326c5e01524d2e6280a48f2c50ff6de7e52e9611cc697d2898e0d09264376196696c51d7abbbaa4a900000000";
          const balmyTarget = "0x89b8AA89FDd0507a99d334CBe3C808fAFC7d850E"; // odos

          const multicallData = await createSwapAPICallData(
            swapHelper,
            positionSwapper.address,
            balmyTarget,
            balmyCalldata,
            USDC_ADDRESS,
            ETH_ADDRESS,
          );
          const maxBorrowToOpen = parseUnits("554035", 18);
          // Swap Debt
          const tx = await positionSwapper
            .connect(vETH_BORROWER_SIGNER)
            .swapFullDebt(vETH_BORROWER, vETH_ADDRESS, vUSDC_ADDRESS, maxBorrowToOpen, [multicallData]);
          const receipt = await tx.wait();
          expect(receipt.status).to.equal(1);

          const finalETHBorrow = await vETH.callStatic.borrowBalanceCurrent(vETH_BORROWER);
          const finalUSDCBorrow = await vUSDC.callStatic.borrowBalanceCurrent(vETH_BORROWER);

          expect(finalETHBorrow).to.equal(0);
          const tolerance = parseUnits("0.0000001", 18);
          expect(finalUSDCBorrow).to.be.gt(0);
          expect(finalUSDCBorrow).to.be.closeTo(maxBorrowToOpen, tolerance);
        });

        it("should swapDebtWithAmount from vETH to vUSDC (using full amount argument)", async function () {
          const vETH_BORROWER_SIGNER = await initMainnetUser(vETH_BORROWER, parseEther("2"));
          await comptroller.connect(vETH_BORROWER_SIGNER).updateDelegate(positionSwapper.address, true);
          const initialETHBorrow = await vETH.callStatic.borrowBalanceCurrent(vETH_BORROWER);
          const initialUSDCBorrow = await vUSDC.callStatic.borrowBalanceCurrent(vETH_BORROWER);
          expect(initialETHBorrow).to.be.gt(0);
          expect(initialUSDCBorrow).to.equal(0);

          const balmyCalldata =
            "0x83bd37f900018ac76a51cc950d9822d68b83fe1ad97b32cd580d00012170ed0880ac9a755fd29b2688956bd959f933f80a75524c2b08c3a8ec00000908695eee01390e8000028f5c0001da4F2e8041aa91A93B1D46Cf224Bbd4e9134a9EC000000011148959f1ef3b32AA8c5484393723B79C2Cd2a265b65fbbe3a150a3c0103b6de3b0b0101020301020104118a640a01040203010001031eab4a230105020203010f1249020e01000602000102840ecf2c010002030000000407080000000000000100000001089ffb3c2c0100020300000001070800000000000001000000010e08d2a20e010009020001309cc0f70e01000a0200014a7568f60e01000b02000143f27b970f0100020300000006000001000103e4c76f0f01000203000000640000010001b6cc29060f0100020300000002000001000117fb3a080a020c020d0001011b90ec6823020e020200011ea930340e02000f0201012222e98121021002000118000a290e0300110200011d79dcb10e0400120201011b0a8d7a0e0501130200011a6c1d660e0501140200000e0600150201032655edf600000302bb8dbf0e070016030103174ae13f0e0700170301039440f7140e0700180301032369e7cd0e07001903010304e879f50e07001a030103bd638da50e08001b0301035e00582a0e08001c030103ae23ea9b0e08001d0301020f0900031e000001f400000a000c0609000548af89970a001f0d030100052da69fad0e0000200d00054689a8ec0e0000210d00042100220d00060e0200232400080e000025260011049cfdaf0305010127240019110e91420f0e050128240011152a336b0e050129240011286079e40e05012a2400100e05012b24000f0590865e030501012c2d00190f057e18a50e05012e2d000f61ec87b80e05012f2d000f07c8ddb70e0501302d000f9ee75ff60e0501312d000f0bfeb23e0e0501322d000fb1e759a30e0501332d000e0e0501342d00010b1525ed0e05013503000108d32f360e050136030001354476c20e0501370300000c05010338040e0501393a00122c05011e380100014f073b00000000000005000001ff0000000000000000000000000000160caed03795365f3a589f10c379ffa7d75d4e768ac76a51cc950d9822d68b83fe1ad97b32cd580d55d398326f99059ff775485246999027b31979553efebc418efb585248a0d2140cfb87afcc2c63dd28ec0b36f0819ecb5005cab836f4ed5a2eca4d137491c04dc4575e086a8ee31f7ce1c6d56fb7dcc1238a358808379702088667322f80ac48bad5e6c4a0ffb9c1ce1fe56963b0321b32e7a0302114058b4f31fa980a675570939b737ebdde0471a4be40eb2c3c320d49019d4f9a92352e947c7e5acfe47d6892b7807bf19b7dddf89b706143896d05228f3121c2f5b9a3d9138ab2b74d581fc11346219ebf43fee9e7cea3dedca5984780bafc599bd69add087d561b3771a66ee31180906972580ade9b81afc5fcdc22536030b9ce783b6ddfb9a39ac7f439f568e5e66064dbd0ff10bfed5a797807042e9f63f18cfe10e1799b52c010ad415325d19af139e20b8aa8aab0f66a930ed3b004ba16ee11b3a9b142eaf2259b0dd8cc6bfdee087148c220e9141a075d18418abbac539e0ebfffd39e54a0f7e5f8fec40ade7933a664f2688fb5b81049dfb7703ada5e770543770612c49ea0f51fd2133d995cf00229bc523737415ad31847a90a2d92a8367a91efa1906bfc8c1e05bf10c4172fcd41e0913e95784454622d1c3724f546f84936696169c63e42cd08ce11f5deebbcebae6520507862d9b4be2156b15d54f41ee4ede2d5b0b455e446cf1cf8c69595804ba91dfdd8d6b960c9b0a7c4813c0decbb1097fff46d0ed6a39fb5f6a83043f4247f51881d1e3ae0f759afb801413a6c948ef4420000000000000000000000000000000000000000169f653a54acd441ab34b73da9946e2c451787efc98f01bf2141e1140ef8f8cad99d4b021d10718f4f3126d5de26413abdcf6948943fb9d0847d9818be60d4c4250438344bec816ec2dec99925deb4c7cc1c80529b483a663d869c137a1fd0cbd9855dc87130d2a12b9bcbfae4f2634d864a1ee1ce3ead9cbf72b6485e4b31601afe7b0a1210be2004d2b1d6c5f0f7b66764f6ec8c8dff7ba683102295e16409d171b26e4484402de70e3ea256be5a2630d7e88d7d1d3649232f28bf7467e9cdb27e6d902c16a1653fb2623567e21f8c50f0ae86f54ef4849b4eb47bd4dca84e1808da3354924cd243c66828cf7754704bba1018b967e59220b22ca03f68821a3276c9a674e4716e431f45807dcf19f284c7aa99f18a4fbcbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c1123e75b71019962cd4d21b0f3018a6412edb63c58f04aada1051885a3c4e296aab0a454ea1233a34fb87838a29b37598099ef5aa6b3fbeeef987c50d0e226f674bbf064f54ab47f42473ff80db98cba7d05c84581f0c41ad80ddf677a510360bae09a5a62fcb3c1794fb95bd8b1a97f6ad5d8a7e4943a1e0f338ec12d3f7c3d77a4b9fcc1f95f3fb6ad0ea68829abfa1a7b017078195c10a966d7411a0c95159f599f3d64a9d99ea21e68127bb6ce99f893da61be141893e4c6ad9272e8c04bab7e6a10604501a52170ed0880ac9a755fd29b2688956bd959f933f86cb5392b9ca52d7a0e6940e82d29087361360ec326c5e01524d2e6280a48f2c50ff6de7e52e9611cc697d2898e0d09264376196696c51d7abbbaa4a900000000";
          const balmyTarget = "0x89b8AA89FDd0507a99d334CBe3C808fAFC7d850E"; // odos

          const multicallData = await createSwapAPICallData(
            swapHelper,
            positionSwapper.address,
            balmyTarget,
            balmyCalldata,
            USDC_ADDRESS,
            ETH_ADDRESS,
          );
          const maxBorrowToOpen = parseUnits("554035", 18);

          const tx = await positionSwapper
            .connect(vETH_BORROWER_SIGNER)
            .swapDebtWithAmount(vETH_BORROWER, vETH_ADDRESS, vUSDC_ADDRESS, initialETHBorrow, maxBorrowToOpen, [
              multicallData,
            ]);
          const receipt = await tx.wait();
          expect(receipt.status).to.equal(1);

          const finalETHBorrow = await vETH.callStatic.borrowBalanceCurrent(vETH_BORROWER);
          const finalUSDCBorrow = await vUSDC.callStatic.borrowBalanceCurrent(vETH_BORROWER);

          const tolerance = parseUnits("0.0000001", 18);
          expect(finalETHBorrow).to.be.closeTo(0, tolerance);
          expect(finalUSDCBorrow).to.be.closeTo(maxBorrowToOpen, tolerance);
        });
      });
    });
  });
}
