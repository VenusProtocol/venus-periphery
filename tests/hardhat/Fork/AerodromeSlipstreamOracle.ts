import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { parseUnits } from "ethers/lib/utils";
import { ethers, upgrades } from "hardhat";

import { AerodromeSlipstreamOracle } from "../../../typechain";
import { IAccessControlManagerV8__factory } from "../../../typechain/factories/IAccessControlManagerV8__factory";
import { forking, initMainnetUser } from "./utils";

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS — Base Mainnet
// ═══════════════════════════════════════════════════════════════════════════

const NORMAL_TIMELOCK = "0x21c12f2946a1a66cBFf7eb997022a37167eCf517";
const ACM = "0x9E6CeEfDC6183e4D0DF8092A9B90cDF659687daB";
const RESILIENT_ORACLE = "0xcBBf58bD5bAdE357b634419B70b215D5E9d6FbeD";

// Aerodrome Slipstream WETH/USDC pool
// token0 = WETH (0x4200..0006), token1 = USDC (0x8335..2913)
const POOL_WETH_USDC = "0xb2cc224c1c9feE385f8ad6a55b4d94E92359DC59";
const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const FORK_BASE = process.env.FORKED_NETWORK === "basemainnet";

// ═══════════════════════════════════════════════════════════════════════════
// FORK TESTS
// ═══════════════════════════════════════════════════════════════════════════

if (FORK_BASE) {
  const FORK_BLOCK = 45300000;

  forking(FORK_BLOCK, () => {
    let timelock: SignerWithAddress;
    let aeroOracle: AerodromeSlipstreamOracle;

    before(async () => {
      timelock = await initMainnetUser(NORMAL_TIMELOCK, parseUnits("10"));

      const acm = IAccessControlManagerV8__factory.connect(ACM, timelock);

      const Factory = await ethers.getContractFactory("AerodromeSlipstreamOracle");
      aeroOracle = (await upgrades.deployProxy(Factory, [ACM], {
        constructorArgs: [RESILIENT_ORACLE],
        unsafeAllow: ["constructor"],
      })) as AerodromeSlipstreamOracle;

      await acm.giveCallPermission(aeroOracle.address, "setPoolConfig(address,address)", NORMAL_TIMELOCK);

      // Configure WETH: token0 in WETH/USDC pool, reference = USDC
      await aeroOracle.connect(timelock).setPoolConfig(WETH, POOL_WETH_USDC);
    });

    // ═══════════════════════════════════════════════════════════════════
    // 1. Pool config
    // ═══════════════════════════════════════════════════════════════════

    describe("1. Pool configuration", () => {
      it("should store pool config for WETH", async () => {
        expect(await aeroOracle.tokenPools(WETH)).to.equal(POOL_WETH_USDC);
      });
    });

    // ═══════════════════════════════════════════════════════════════════
    // 2. Live price — WETH (token0)
    // ═══════════════════════════════════════════════════════════════════

    describe("2. Live price — WETH", () => {
      it("should return a non-zero price", async () => {
        const price = await aeroOracle.getPrice(WETH);
        expect(price).to.be.gt(0);
      });

      it("should return WETH price within 5% of ResilientOracle", async () => {
        const resilientOracle = await ethers.getContractAt(
          ["function getPrice(address) external view returns (uint256)"],
          RESILIENT_ORACLE,
        );
        const aeroPrice = await aeroOracle.getPrice(WETH);
        const oraclePrice = await resilientOracle.getPrice(WETH);

        const diff = aeroPrice.sub(oraclePrice).abs();
        const threshold = oraclePrice.mul(5).div(100);
        expect(diff).to.be.lte(threshold);
      });

      it("should return WETH price well above $100 (sanity check)", async () => {
        const price = await aeroOracle.getPrice(WETH);
        // WETH price in 36-18=18 decimal format: $100 = 100e18
        expect(price).to.be.gt(parseUnits("100", 18));
      });
    });

    // ═══════════════════════════════════════════════════════════════════
    // 3. Reverse config — USDC as token1
    // ═══════════════════════════════════════════════════════════════════

    describe("3. Reverse config — USDC (token1)", () => {
      before(async () => {
        await aeroOracle.connect(timelock).setPoolConfig(USDC, POOL_WETH_USDC);
      });

      it("should return USDC price close to $1", async () => {
        const price = await aeroOracle.getPrice(USDC);
        // USDC has 6 decimals → price in 36-6=30 decimal format: $1 = 1e30
        // Allow 2% deviation from peg
        const ONE_USD = parseUnits("1", 30);
        const diff = price.sub(ONE_USD).abs();
        const threshold = ONE_USD.mul(2).div(100);
        expect(diff).to.be.lte(threshold);
      });
    });

    // ═══════════════════════════════════════════════════════════════════
    // 4. Revert — unconfigured token
    // ═══════════════════════════════════════════════════════════════════

    describe("4. Revert cases", () => {
      it("should revert TokenNotConfigured for unknown token", async () => {
        const unknown = "0x0000000000000000000000000000000000000099";
        await expect(aeroOracle.getPrice(unknown)).to.be.revertedWithCustomError(aeroOracle, "TokenNotConfigured");
      });
    });
  });
}
