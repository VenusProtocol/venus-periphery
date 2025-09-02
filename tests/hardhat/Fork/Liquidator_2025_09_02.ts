import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { parseUnits } from "ethers/lib/utils";
import { ethers } from "hardhat";

import {
  ChainlinkOracle,
  ChainlinkOracle__factory,
  ComptrollerMock,
  ComptrollerMock__factory,
  IERC20,
  IERC20__factory,
  Liquidator20250902,
  ResilientOracleInterface,
  ResilientOracleInterface__factory,
  VToken,
  VToken__factory,
} from "../../../typechain";
import { forking, initMainnetUser } from "./utils";

const COMPTROLLER = "0xfd36e2c2a6789db23113685031d7f16329158384";
const REDSTONE_ORACLE = "0x8455EFA4D7Ff63b8BFD96AdD889483Ea7d39B70a";
const CHAINLINK_ORACLE = "0x1B2103441A0A108daD8848D8F5d790e4D402921F";
const RESILIENT_ORACLE = "0x6592b5DE802159F3E74B2486b091D11a8256ab8A";

const GUARDIAN_2 = "0x1C2CAc6ec528c20800B2fe734820D87b581eAA6B";
const GUARDIAN_3 = "0x3a3284dC0FaFfb0b5F0d074c4C704D14326C98cF";
const RECEIVER = "0xC753FB97Ed8E1c6081699570b57115D28F2232FA";

const VUSDC = "0xecA88125a5ADbe82614ffC12D0DB554E2e2867C8";
const VUSDT = "0xfD5840Cd36d94D7229439859C0112a4185BC0255";
const VBTC = "0x882C173bC7Ff3b7786CA16dfeD3DFFfb9Ee7847B";
const VWBETH = "0x6CFdEc747f37DAf3b87a35a1D9c8AD3063A1A8A0";
const VFDUSD = "0xC4eF4229FEc74Ccfe17B2bdeF7715fAC740BA0ba";

const EXPLOITER = "0x7fd8f825e905c771285f510d8e428a2b69a6202a";
//const LIQUIDATOR = "0x0870793286aada55d39ce7f82fb2766e8004cf43";
const BTCB = "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c";
const TEMPORARY_BTCB_PRICE = parseUnits("10000000000", 18); // 10 trilion

const BTCB_HOLDER = "0xF977814e90dA44bFA03b6295A0616a897441aceC";

const FORK_MAINNET = process.env.FORKED_NETWORK === "bscmainnet";

let guardian2: SignerWithAddress;
let guardian3: SignerWithAddress;
let receiver: SignerWithAddress;
let btcbHolder: SignerWithAddress;
let btcb: IERC20;
let comptroller: ComptrollerMock;
let liquidator: Liquidator20250902;
let oracle: ResilientOracleInterface;
let chainlinkOracle: ChainlinkOracle;
let redStoneOracle: ChainlinkOracle;

let vUSDC: VToken;
let vUSDT: VToken;
let vBTC: VToken;
let vWBETH: VToken;
let vFDUSD: VToken;

if (FORK_MAINNET) {
  const blockNumber = 59764220;
  forking(blockNumber, () => {
    describe("Liquidator_2025_09_02", () => {
      before(async () => {
        guardian2 = await initMainnetUser(GUARDIAN_2, ethers.utils.parseUnits("2"));
        guardian3 = await initMainnetUser(GUARDIAN_3, ethers.utils.parseUnits("2"));
        receiver = await initMainnetUser(RECEIVER, ethers.utils.parseUnits("2"));
        btcbHolder = await initMainnetUser(BTCB_HOLDER, ethers.utils.parseUnits("2"));

        chainlinkOracle = ChainlinkOracle__factory.connect(CHAINLINK_ORACLE, guardian3);
        redStoneOracle = ChainlinkOracle__factory.connect(REDSTONE_ORACLE, guardian3);
        comptroller = ComptrollerMock__factory.connect(COMPTROLLER, guardian2);
        oracle = ResilientOracleInterface__factory.connect(RESILIENT_ORACLE, guardian3);
        btcb = IERC20__factory.connect(BTCB, btcbHolder);
        const factory = await ethers.getContractFactory("Liquidator_2025_09_02");
        liquidator = await factory.connect(guardian3).deploy();

        comptroller.connect(receiver).updateDelegate(liquidator.address, true);
        comptroller.connect(receiver).enterMarkets([VUSDC, VUSDT, VBTC, VWBETH, VFDUSD]);
        await liquidator.deployed();

        vUSDC = VToken__factory.connect(VUSDC, receiver);
        vUSDT = VToken__factory.connect(VUSDT, receiver);
        vBTC = VToken__factory.connect(VBTC, receiver);
        vWBETH = VToken__factory.connect(VWBETH, receiver);
        vFDUSD = VToken__factory.connect(VFDUSD, receiver);
      });

      describe("Prerequisites", () => {
        it("configures the fake price for BTC", async () => {
          await chainlinkOracle.setDirectPrice(BTCB, TEMPORARY_BTCB_PRICE);
          await redStoneOracle.setDirectPrice(BTCB, TEMPORARY_BTCB_PRICE);
          expect(await oracle.getPrice(BTCB)).to.equal(TEMPORARY_BTCB_PRICE);
        });

        it("unpauses the protocol", async () => {
          await comptroller._setProtocolPaused(false);
        });

        it("liquidates the account", async () => {
          await btcb.transfer(liquidator.address, parseUnits("1", 18));
          await liquidator.runLiquidation();
        });

        it("restores the price for BTC", async () => {
          await chainlinkOracle.setDirectPrice(BTCB, 0);
          await redStoneOracle.setDirectPrice(BTCB, 0);
          expect(await oracle.getPrice(BTCB)).to.equal(parseUnits("111413.11412", 18));
        });

        it("borrows on behalf and repays", async () => {
          await liquidator.borrowOnBehalfAndRepay();
        });

        it("has expected EXPLOITER position", async () => {
          // Collateral
          expect(await vUSDC.callStatic.balanceOfUnderlying(EXPLOITER)).to.equal(
            parseUnits("13968.949100260402882842", 18),
          );
          expect(await vUSDT.callStatic.balanceOfUnderlying(EXPLOITER)).to.equal(
            parseUnits("19362.237841899435875077", 18),
          );
          expect(await vWBETH.callStatic.balanceOfUnderlying(EXPLOITER)).to.equal(
            parseUnits("3.656252356647592627", 18),
          );
          expect(await vFDUSD.callStatic.balanceOfUnderlying(EXPLOITER)).to.equal(
            parseUnits("19480.400091676583240617", 18),
          );

          // Debt
          expect(await vBTC.callStatic.borrowBalanceCurrent(EXPLOITER)).to.equal(
            parseUnits("0.496893295423017260", 18),
          );
        });

        it("has expected EXPLOITER account liquidity", async () => {
          const [, liquidity, shortfall] = await comptroller.getAccountLiquidity(EXPLOITER);
          expect(liquidity).to.equal(0);
          expect(shortfall).to.equal(parseUnits("0.028525794110053206", 18));
        });

        it("has expected RECEIVER position", async () => {
          // Collateral
          expect(await vUSDC.callStatic.balanceOfUnderlying(RECEIVER)).to.equal(
            parseUnits("6813672.399757996530648070", 18),
          );
          expect(await vUSDT.callStatic.balanceOfUnderlying(RECEIVER)).to.equal(
            parseUnits("18907225.252604659342784745", 18),
          );
          expect(await vWBETH.callStatic.balanceOfUnderlying(RECEIVER)).to.equal(
            parseUnits("3570.330404710996684065", 18),
          );
          expect(await vFDUSD.callStatic.balanceOfUnderlying(RECEIVER)).to.equal(
            parseUnits("278923.910403187432503802", 18),
          );

          // Debt
          expect(await vBTC.callStatic.borrowBalanceCurrent(RECEIVER)).to.equal(
            parseUnits("285.221144281425248393", 18),
          );
        });

        it("has expected RECEIVER account liquidity", async () => {
          const [, liquidity, shortfall] = await comptroller.getAccountLiquidity(RECEIVER);
          expect(liquidity).to.equal(parseUnits("2621415.543746073244517505", 18));
          expect(shortfall).to.equal(0);
        });
      });
    });
  });
}
