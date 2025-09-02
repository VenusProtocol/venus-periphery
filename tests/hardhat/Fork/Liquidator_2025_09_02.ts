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
const EXPLOITER = "0x7fd8f825e905c771285f510d8e428a2b69a6202a";
const BTCB_HOLDER = "0xF977814e90dA44bFA03b6295A0616a897441aceC";

const VUSDC = "0xecA88125a5ADbe82614ffC12D0DB554E2e2867C8";
const VUSDT = "0xfD5840Cd36d94D7229439859C0112a4185BC0255";
const VBTC = "0x882C173bC7Ff3b7786CA16dfeD3DFFfb9Ee7847B";
const VWBETH = "0x6CFdEc747f37DAf3b87a35a1D9c8AD3063A1A8A0";
const VFDUSD = "0xC4eF4229FEc74Ccfe17B2bdeF7715fAC740BA0ba";
const BTCB = "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c";

const INITIAL_BTC = parseUnits("1", 18);
const TEMPORARY_BTCB_PRICE = parseUnits("1000000000000", 18); // 1000 trillion

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

        it("sends BTC to the contract", async () => {
          await btcb.transfer(liquidator.address, INITIAL_BTC);
        });

        it("unpauses the protocol", async () => {
          await comptroller._setProtocolPaused(false);
        });
      });

      describe("Liquidation", () => {
        it("liquidates the account VUSDC", async () => {
          await liquidator.runLiquidation(VUSDC, 20);
        });

        it("liquidates the account VUSDT", async () => {
          await liquidator.runLiquidation(VUSDT, 20);
        });

        it("liquidates the account VWBETH", async () => {
          await liquidator.runLiquidation(VWBETH, 20);
        });

        it("liquidates the account VFDUSD", async () => {
          await liquidator.runLiquidation(VFDUSD, 16);
        });
      });

      describe("Repayment", () => {
        it("restores the price for BTC", async () => {
          await chainlinkOracle.setDirectPrice(BTCB, 0);
          await redStoneOracle.setDirectPrice(BTCB, 0);
          expect(await oracle.getPrice(BTCB)).to.equal(parseUnits("111413.11412", 18));
        });

        it("borrows on behalf and repays", async () => {
          await liquidator.borrowOnBehalfAndRepay();
        });
      });

      describe("Resulting state", () => {
        it("has expected Exploiter vUSDC position", async () => {
          expect(await vUSDC.callStatic.balanceOfUnderlying(EXPLOITER)).to.equal(
            parseUnits("6.820777802687069676", 18),
          );
        });

        it("has expected Exploiter vUSDT position", async () => {
          expect(await vUSDT.callStatic.balanceOfUnderlying(EXPLOITER)).to.equal(
            parseUnits("18.908436068543799005", 18),
          );
        });

        it("has expected Exploiter vWBETH position", async () => {
          expect(await vWBETH.callStatic.balanceOfUnderlying(EXPLOITER)).to.equal(
            parseUnits("0.003570586068155202", 18),
          );
        });

        it("has expected Exploiter vFDUSD position", async () => {
          expect(await vFDUSD.callStatic.balanceOfUnderlying(EXPLOITER)).to.equal(
            parseUnits("4.755958113852844495", 18),
          );
        });

        it("has expected Exploiter vBTC debt", async () => {
          expect(await vBTC.callStatic.borrowBalanceCurrent(EXPLOITER)).to.equal(
            parseUnits("0.000339152869062238", 18),
          );
        });

        it("has expected Exploiter account liquidity", async () => {
          const [, liquidity, shortfall] = await comptroller.getAccountLiquidity(EXPLOITER);
          expect(liquidity).to.equal(0);
          expect(shortfall).to.equal(parseUnits("0.028526303037458189", 18));
        });

        it("has expected Receiver vUSDC position", async () => {
          expect(await vUSDC.callStatic.balanceOfUnderlying(RECEIVER)).to.equal(
            parseUnits("6826999.907515237717892909", 18),
          );
        });

        it("has expected Receiver vUSDT position", async () => {
          expect(await vUSDT.callStatic.balanceOfUnderlying(RECEIVER)).to.equal(
            parseUnits("18925689.407083094150852367", 18),
          );
        });

        it("has expected Receiver vWBETH position", async () => {
          expect(await vWBETH.callStatic.balanceOfUnderlying(RECEIVER)).to.equal(
            parseUnits("3573.817055542577247926", 18),
          );
        });

        it("has expected Receiver vFDUSD position", async () => {
          expect(await vFDUSD.callStatic.balanceOfUnderlying(RECEIVER)).to.equal(
            parseUnits("297514.312620078699045314", 18),
          );
        });

        it("has expected Receiver vBTC debt", async () => {
          expect(await vBTC.callStatic.borrowBalanceCurrent(RECEIVER)).to.equal(
            parseUnits("285.721734327266357527", 18),
          );
        });

        it("has expected Receiver account liquidity", async () => {
          const [, liquidity, shortfall] = await comptroller.getAccountLiquidity(RECEIVER);
          expect(liquidity).to.equal(parseUnits("2618451.254599103153302749", 18));
          expect(shortfall).to.equal(0);
        });

        it("spends 0.000040828330133855 BTC", async () => {
          const balanceAfter = await btcb.balanceOf(liquidator.address);
          expect(INITIAL_BTC.sub(balanceAfter)).to.equal(parseUnits("0.000040828330133855", 18));
        });

        it("has no vTokens", async () => {
          expect(await vBTC.balanceOf(liquidator.address)).to.equal(0);
          expect(await vFDUSD.balanceOf(liquidator.address)).to.equal(0);
          expect(await vUSDC.balanceOf(liquidator.address)).to.equal(0);
          expect(await vUSDT.balanceOf(liquidator.address)).to.equal(0);
          expect(await vWBETH.balanceOf(liquidator.address)).to.equal(0);
        });
      });

      describe("Sweep", () => {
        it("sweeps the remaining BTC to a specified address", async () => {
          const spent = parseUnits("0.000040828330133855", 18);
          await liquidator.sweepBtc(RECEIVER);
          expect(await btcb.balanceOf(liquidator.address)).to.equal(0);
          expect(await btcb.balanceOf(RECEIVER)).to.equal(INITIAL_BTC.sub(spent));
        });
      });
    });
  });
}
