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
  Liquidator20250902__factory,
  ResilientOracleInterface,
  ResilientOracleInterface__factory,
  VToken,
  VToken__factory,
} from "../../../typechain";
import { forking, initMainnetUser } from "./utils";
import { BigNumber } from "ethers";

const COMPTROLLER = "0xfd36e2c2a6789db23113685031d7f16329158384";
const REDSTONE_ORACLE = "0x8455EFA4D7Ff63b8BFD96AdD889483Ea7d39B70a";
const CHAINLINK_ORACLE = "0x1B2103441A0A108daD8848D8F5d790e4D402921F";
const RESILIENT_ORACLE = "0x6592b5DE802159F3E74B2486b091D11a8256ab8A";
const CUSTOM_LIQUIDATOR = "0xe011d57eCf48c448a7601eAE30E6Bf2D22886c50";

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

const TEMPORARY_BTCB_PRICE = parseUnits("1000000000000", 18); // 1000 trillion

const Actions = {
  BORROW: 2,
  REPAY: 3,
  SEIZE: 4,
  LIQUIDATE: 5,
  TRANSFER: 6,
  ENTER_MARKET: 7,
};

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

let initialBtc: BigNumber;

let vUSDC: VToken;
let vUSDT: VToken;
let vBTC: VToken;
let vWBETH: VToken;
let vFDUSD: VToken;

if (FORK_MAINNET) {
  const blockNumber = 59794360;
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
        liquidator = Liquidator20250902__factory.connect(CUSTOM_LIQUIDATOR, guardian3);

        initialBtc = await btcb.balanceOf(liquidator.address)

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
          await comptroller._setActionsPaused([VBTC], [Actions.LIQUIDATE, Actions.BORROW], false);
          await comptroller._setActionsPaused([VUSDC, VUSDT, VWBETH, VFDUSD], [Actions.SEIZE, Actions.TRANSFER], false);
        });
      });

      describe("Liquidation", () => {
        it("liquidates the account", async () => {
          await liquidator.runLiquidation();
        });
      });

      describe("Repayment", () => {
        it("restores the price for BTC", async () => {
          await chainlinkOracle.setDirectPrice(BTCB, 0);
          await redStoneOracle.setDirectPrice(BTCB, 0);
          expect(await oracle.getPrice(BTCB)).to.equal(parseUnits("111191", 18));
        });

        it("borrows on behalf and repays", async () => {
          await liquidator.borrowOnBehalfAndRepay();
        });
      });

      describe("Resulting state", () => {
        it("has expected Exploiter vUSDC position", async () => {
          expect(await vUSDC.callStatic.balanceOfUnderlying(EXPLOITER)).to.equal(
            parseUnits("0.000000008026823316", 18),
          );
        });

        it("has expected Exploiter vUSDT position", async () => {
          expect(await vUSDT.callStatic.balanceOfUnderlying(EXPLOITER)).to.equal(
            parseUnits("0.000000691019474288", 18),
          );
        });

        it("has expected Exploiter vWBETH position", async () => {
          expect(await vWBETH.callStatic.balanceOfUnderlying(EXPLOITER)).to.equal(
            parseUnits("0.000000010035092194", 18),
          );
        });

        it("has expected Exploiter vFDUSD position", async () => {
          expect(await vFDUSD.callStatic.balanceOfUnderlying(EXPLOITER)).to.equal(
            parseUnits("0.000000544412020233", 18),
          );
        });

        it("has expected Exploiter vBTC debt", async () => {
          expect(await vBTC.callStatic.borrowBalanceCurrent(EXPLOITER)).to.equal(
            parseUnits("0.000000256351935521", 18),
          );
        });

        it("has expected Exploiter account liquidity", async () => {
          const [, liquidity, shortfall] = await comptroller.getAccountLiquidity(EXPLOITER);
          expect(liquidity).to.equal(0);
          expect(shortfall).to.equal(parseUnits("0.028465907147135046", 18));
        });

        it("has expected Receiver vUSDC position", async () => {
          expect(await vUSDC.callStatic.balanceOfUnderlying(RECEIVER)).to.equal(
            parseUnits("6827222.230310991955044699", 18),
          );
        });

        it("has expected Receiver vUSDT position", async () => {
          expect(await vUSDT.callStatic.balanceOfUnderlying(RECEIVER)).to.equal(
            parseUnits("18926381.107209793967170516", 18),
          );
        });

        it("has expected Receiver vWBETH position", async () => {
          expect(await vWBETH.callStatic.balanceOfUnderlying(RECEIVER)).to.equal(
            parseUnits("3573.820549249309589541", 18),
          );
        });

        it("has expected Receiver vFDUSD position", async () => {
          expect(await vFDUSD.callStatic.balanceOfUnderlying(RECEIVER)).to.equal(
            parseUnits("297660.501804749179020012", 18),
          );
        });

        it("has expected Receiver vBTC debt", async () => {
          expect(await vBTC.callStatic.borrowBalanceCurrent(RECEIVER)).to.equal(
            parseUnits("285.724645303307940359", 18),
          );
        });

        it("has expected Receiver account liquidity", async () => {
          const [, liquidity, shortfall] = await comptroller.getAccountLiquidity(RECEIVER);
          expect(liquidity).to.equal(parseUnits("2456493.673365073483367226", 18));
          expect(shortfall).to.equal(0);
        });

        it("spends 0.000040560357861686 BTC", async () => {
          const balanceAfter = await btcb.balanceOf(liquidator.address);
          expect(initialBtc.sub(balanceAfter)).to.equal(parseUnits("0.000040560357861686", 18));
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
          const spent = parseUnits("0.000040560357861686", 18);
          await liquidator.sweepBtc(RECEIVER);
          expect(await btcb.balanceOf(liquidator.address)).to.equal(0);
          expect(await btcb.balanceOf(RECEIVER)).to.equal(initialBtc.sub(spent));
        });
      });
    });
  });
}
