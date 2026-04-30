import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { parseUnits } from "ethers/lib/utils";
import { ethers, upgrades } from "hardhat";

import { CurveOracle } from "../../../typechain";
import { IAccessControlManagerV8__factory } from "../../../typechain/factories/IAccessControlManagerV8__factory";
import { forking, initMainnetUser } from "./utils";

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS — Ethereum Mainnet
// ═══════════════════════════════════════════════════════════════════════════

const NORMAL_TIMELOCK = "0xd969E79406c35E80750aAae061D402Aab9325714";
const ACM = "0x230058da2d23eb8836ec5db7037ef7250c56e25e";
const RESILIENT_ORACLE = "0xd2ce3fb018805ef92b8C5976cb31F84b4E295F94";

// Curve eBTC/WBTC StableSwap-NG pool — coins[0]=eBTC, coins[1]=WBTC
const CURVE_EBTC_WBTC_POOL = "0x7704D01908afD31bf647d969c295BB45230cD2d6";
const EBTC = "0x657e8C867D8B37dCC18fA4Caead9C45EB088C642";
const WBTC = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599";

const FORK_ETHEREUM = process.env.FORKED_NETWORK === "ethereum";

// ═══════════════════════════════════════════════════════════════════════════
// FORK TESTS
// ═══════════════════════════════════════════════════════════════════════════

if (FORK_ETHEREUM) {
  const FORK_BLOCK = 24978000;

  forking(FORK_BLOCK, () => {
    let timelock: SignerWithAddress;
    let curveOracle: CurveOracle;

    before(async () => {
      timelock = await initMainnetUser(NORMAL_TIMELOCK, parseUnits("10"));

      const acm = IAccessControlManagerV8__factory.connect(ACM, timelock);

      const CurveOracleFactory = await ethers.getContractFactory("CurveOracle");
      curveOracle = (await upgrades.deployProxy(CurveOracleFactory, [ACM], {
        constructorArgs: [RESILIENT_ORACLE],
        unsafeAllow: ["constructor"],
      })) as CurveOracle;

      // Grant permission for setPoolConfig
      await acm.giveCallPermission(
        curveOracle.address,
        "setPoolConfig(address,address,uint8,uint8,address,uint8,uint8)",
        NORMAL_TIMELOCK,
      );

      // Configure eBTC: coins[0] in pool, reference = WBTC
      // eBTC: 8 decimals, WBTC: 8 decimals
      await curveOracle.connect(timelock).setPoolConfig(EBTC, CURVE_EBTC_WBTC_POOL, 0, 1, WBTC, 8, 8);
    });

    // ═══════════════════════════════════════════════════════════════════
    // 1. Pool config stored correctly
    // ═══════════════════════════════════════════════════════════════════

    describe("1. Pool configuration", () => {
      it("should store pool config for eBTC", async () => {
        const cfg = await curveOracle.poolConfigs(EBTC);
        expect(cfg.pool).to.equal(CURVE_EBTC_WBTC_POOL);
        expect(cfg.coinIndex).to.equal(0);
        expect(cfg.referenceToken).to.equal(WBTC);
      });

      it("should reject setPoolConfig with wrong coinIndex", async () => {
        // coinIndex=1 points to WBTC, not eBTC → AssetMismatch
        await expect(
          curveOracle.connect(timelock).setPoolConfig(EBTC, CURVE_EBTC_WBTC_POOL, 1, 0, WBTC, 8, 8),
        ).to.be.revertedWithCustomError(curveOracle, "AssetMismatch");
      });
    });

    // ═══════════════════════════════════════════════════════════════════
    // 2. Live price — eBTC (coins[0])
    // ═══════════════════════════════════════════════════════════════════

    describe("2. Live price — eBTC", () => {
      it("should return a non-zero price", async () => {
        const price = await curveOracle.getPrice(EBTC);
        expect(price).to.be.gt(0);
      });

      it("should return price within 2% of ResilientOracle WBTC price", async () => {
        // eBTC ≈ WBTC ± small premium/discount from EMA lag
        const resilientOracle = await ethers.getContractAt(
          ["function getPrice(address) external view returns (uint256)"],
          RESILIENT_ORACLE,
        );
        const eBtcPrice = await curveOracle.getPrice(EBTC);
        const wbtcPrice = await resilientOracle.getPrice(WBTC);

        // |eBtcPrice - wbtcPrice| / wbtcPrice < 2%
        const diff = eBtcPrice.sub(wbtcPrice).abs();
        const threshold = wbtcPrice.mul(2).div(100);
        expect(diff).to.be.lte(threshold);
      });

      it("eBTC price should be greater than WBTC price (eBTC is yield-bearing)", async () => {
        const resilientOracle = await ethers.getContractAt(
          ["function getPrice(address) external view returns (uint256)"],
          RESILIENT_ORACLE,
        );
        const eBtcPrice = await curveOracle.getPrice(EBTC);
        const wbtcPrice = await resilientOracle.getPrice(WBTC);
        expect(eBtcPrice).to.be.gt(wbtcPrice);
      });
    });

    // ═══════════════════════════════════════════════════════════════════
    // 3. Reverse config — WBTC as coins[1]
    // ═══════════════════════════════════════════════════════════════════

    describe("3. Reverse config — WBTC (coins[1])", () => {
      before(async () => {
        // Configure WBTC: coins[1] in pool, reference = eBTC
        await curveOracle.connect(timelock).setPoolConfig(WBTC, CURVE_EBTC_WBTC_POOL, 1, 0, EBTC, 8, 8);
      });

      it("should return WBTC price close to eBTC price (inverse relationship)", async () => {
        const eBtcPrice = await curveOracle.getPrice(EBTC);
        const wbtcPrice = await curveOracle.getPrice(WBTC);

        // Both priced via same pool, inverse formula — should be within 2%
        const diff = eBtcPrice.sub(wbtcPrice).abs();
        const threshold = eBtcPrice.mul(2).div(100);
        expect(diff).to.be.lte(threshold);
      });

      it("WBTC and eBTC prices should be within 2% of each other via same pool", async () => {
        const eBtcPrice = await curveOracle.getPrice(EBTC);
        const wbtcPrice = await curveOracle.getPrice(WBTC);
        // Direction depends on which ResilientOracle source each config uses as reference —
        // cannot reliably assert which is larger. Closeness is sufficient.
        const diff = eBtcPrice.sub(wbtcPrice).abs();
        const threshold = eBtcPrice.mul(2).div(100);
        expect(diff).to.be.lte(threshold);
      });
    });

    // ═══════════════════════════════════════════════════════════════════
    // 4. Revert — unconfigured token
    // ═══════════════════════════════════════════════════════════════════

    describe("4. Revert cases", () => {
      it("should revert TokenNotConfigured for unknown token", async () => {
        const unknown = "0x0000000000000000000000000000000000000099";
        await expect(curveOracle.getPrice(unknown)).to.be.revertedWithCustomError(curveOracle, "TokenNotConfigured");
      });
    });
  });
}
