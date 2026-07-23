import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { parseUnits } from "ethers/lib/utils";
import { ethers, upgrades } from "hardhat";

import { PCSStableOracle } from "../../../typechain";
import { IAccessControlManagerV8__factory } from "../../../typechain/factories/IAccessControlManagerV8__factory";
import { forking, initMainnetUser } from "./utils";

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS — BNB Chain Mainnet
// ═══════════════════════════════════════════════════════════════════════════

const NORMAL_TIMELOCK = "0x939bD8d64c0A9583A7Dcea9933f7b21697ab6396";
const ACM = "0x4788629ABc6cFCA10F9f969efdEAa1cF70c23555";
const RESILIENT_ORACLE = "0x6592b5DE802159F3E74B2486b091D11a8256ab8A";

// ListaDAO lisUSD/USDT StableSwap pool (PancakeSwap StableSwap interface) —
// coins[0]=lisUSD, coins[1]=USDT.
const LISTA_LISUSD_USDT_POOL = "0x8df7891fb2cb3e98c7ab3cfb4d9a59fbcc63c956";
const LISUSD = "0x0782b6d8c4551B9760e74c0545a9bCD90bdc41E5";
const USDT = "0x55d398326f99059fF775485246999027B3197955";

const FORK_BSCMAINNET = (process.env.FORKED_NETWORK ?? "bscmainnet") === "bscmainnet";

// ═══════════════════════════════════════════════════════════════════════════
// FORK TESTS
// ═══════════════════════════════════════════════════════════════════════════

if (FORK_BSCMAINNET) {
  const FORK_BLOCK = 111500000;

  forking(FORK_BLOCK, () => {
    let timelock: SignerWithAddress;
    let pcsStableOracle: PCSStableOracle;

    before(async () => {
      timelock = await initMainnetUser(NORMAL_TIMELOCK, parseUnits("10"));

      const acm = IAccessControlManagerV8__factory.connect(ACM, timelock);

      const PCSStableOracleFactory = await ethers.getContractFactory("PCSStableOracle");
      pcsStableOracle = (await upgrades.deployProxy(PCSStableOracleFactory, [ACM], {
        constructorArgs: [RESILIENT_ORACLE],
        unsafeAllow: ["constructor"],
      })) as PCSStableOracle;

      // Grant permission for setPoolConfig
      await acm.giveCallPermission(
        pcsStableOracle.address,
        "setPoolConfig(address,address,uint8,uint8,address,uint8)",
        NORMAL_TIMELOCK,
      );

      // Configure lisUSD: coins[0] in pool, reference = USDT (coins[1])
      // lisUSD: 18 decimals, USDT: 18 decimals
      await pcsStableOracle.connect(timelock).setPoolConfig(LISUSD, LISTA_LISUSD_USDT_POOL, 0, 1, USDT, 18);
    });

    // ═══════════════════════════════════════════════════════════════════
    // 1. Pool config stored correctly
    // ═══════════════════════════════════════════════════════════════════

    describe("1. Pool configuration", () => {
      it("should store pool config for lisUSD", async () => {
        const cfg = await pcsStableOracle.poolConfigs(LISUSD);
        expect(cfg.pool).to.equal(ethers.utils.getAddress(LISTA_LISUSD_USDT_POOL));
        expect(cfg.coinIndex).to.equal(0);
        expect(cfg.refCoinIndex).to.equal(1);
        expect(cfg.referenceToken).to.equal(USDT);
        expect(cfg.assetDecimals).to.equal(18);
      });

      it("should reject setPoolConfig with wrong coinIndex", async () => {
        // coinIndex=1 points to USDT, not lisUSD → AssetMismatch
        await expect(
          pcsStableOracle.connect(timelock).setPoolConfig(LISUSD, LISTA_LISUSD_USDT_POOL, 1, 0, USDT, 18),
        ).to.be.revertedWithCustomError(pcsStableOracle, "AssetMismatch");
      });
    });

    // ═══════════════════════════════════════════════════════════════════
    // 2. Live price — lisUSD (coins[0])
    // ═══════════════════════════════════════════════════════════════════

    describe("2. Live price — lisUSD", () => {
      it("should return a non-zero price", async () => {
        const price = await pcsStableOracle.getPrice(LISUSD);
        expect(price).to.be.gt(0);
      });

      it("should return price within 2% of ResilientOracle lisUSD price", async () => {
        const resilientOracle = await ethers.getContractAt(
          ["function getPrice(address) external view returns (uint256)"],
          RESILIENT_ORACLE,
        );
        const lisUsdPrice = await pcsStableOracle.getPrice(LISUSD);
        const resilientLisUsdPrice = await resilientOracle.getPrice(LISUSD);

        // |lisUsdPrice - resilientLisUsdPrice| / resilientLisUsdPrice < 2%
        const diff = lisUsdPrice.sub(resilientLisUsdPrice).abs();
        const threshold = resilientLisUsdPrice.mul(2).div(100);
        expect(diff).to.be.lte(threshold);
      });

      it("should return a price close to $1 (stable pool)", async () => {
        const lisUsdPrice = await pcsStableOracle.getPrice(LISUSD);
        // lisUSD is a USD stable — price within 3% of $1 (1e18).
        const one = parseUnits("1", 18);
        const diff = lisUsdPrice.sub(one).abs();
        expect(diff).to.be.lte(one.mul(3).div(100));
      });
    });

    // ═══════════════════════════════════════════════════════════════════
    // 3. Reverse config — USDT as coins[1]
    // ═══════════════════════════════════════════════════════════════════

    describe("3. Reverse config — USDT (coins[1])", () => {
      before(async () => {
        // Configure USDT: coins[1] in pool, reference = lisUSD
        await pcsStableOracle.connect(timelock).setPoolConfig(USDT, LISTA_LISUSD_USDT_POOL, 1, 0, LISUSD, 18);
      });

      it("should return USDT price close to lisUSD price (inverse relationship)", async () => {
        const lisUsdPrice = await pcsStableOracle.getPrice(LISUSD);
        const usdtPrice = await pcsStableOracle.getPrice(USDT);

        // Both priced via same pool, inverse formula — should be within 2%
        const diff = lisUsdPrice.sub(usdtPrice).abs();
        const threshold = lisUsdPrice.mul(2).div(100);
        expect(diff).to.be.lte(threshold);
      });
    });

    // ═══════════════════════════════════════════════════════════════════
    // 4. Revert — unconfigured token
    // ═══════════════════════════════════════════════════════════════════

    describe("4. Revert cases", () => {
      it("should revert TokenNotConfigured for unknown token", async () => {
        const unknown = "0x0000000000000000000000000000000000000099";
        await expect(pcsStableOracle.getPrice(unknown)).to.be.revertedWithCustomError(
          pcsStableOracle,
          "TokenNotConfigured",
        );
      });
    });
  });
}
