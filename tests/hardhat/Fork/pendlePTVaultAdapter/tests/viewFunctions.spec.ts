import "@nomicfoundation/hardhat-chai-matchers";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import chai from "chai";
import { ethers } from "hardhat";

import { FORK_MAINNET, forking } from "../../utils";
import {
  BLOCK_NUMBER,
  COMPTROLLER,
  FAKE_MARKET,
  PENDLE_ROUTER_V3,
  PT_CLISBNBX_25JUN2026,
  VTOKEN_PT_CLISBNBX_25JUN2026,
  WBNB,
} from "../utils/constants";
import { baseFixture, maturedWithDepositsFixture } from "../utils/fixtures";

const { expect } = chai;

function describeTests() {
  describe("PendlePTVaultAdapter - View Functions", () => {
      // ── getMarketConfig ───────────────────────────────────────────────

      describe("getMarketConfig", () => {
        it("should return correct config for registered market", async () => {
          const { adapter, marketAddress } = await loadFixture(baseFixture);

          const config = await adapter.getMarketConfig(marketAddress);
          expect(config.pt).to.equal(PT_CLISBNBX_25JUN2026);
          expect(config.vToken).to.equal(VTOKEN_PT_CLISBNBX_25JUN2026);
          expect(config.comptroller).to.equal(COMPTROLLER);
          expect(config.isActive).to.be.true;
          expect(config.maturity).to.be.gt(0);
          expect(config.sy).to.not.equal(ethers.constants.AddressZero);
          expect(config.yt).to.not.equal(ethers.constants.AddressZero);
        });

        it("should return zeroed config for unregistered market", async () => {
          const { adapter } = await loadFixture(baseFixture);

          const config = await adapter.getMarketConfig(FAKE_MARKET);
          expect(config.pt).to.equal(ethers.constants.AddressZero);
          expect(config.sy).to.equal(ethers.constants.AddressZero);
          expect(config.yt).to.equal(ethers.constants.AddressZero);
          expect(config.vToken).to.equal(ethers.constants.AddressZero);
          expect(config.comptroller).to.equal(ethers.constants.AddressZero);
          expect(config.isActive).to.be.false;
          expect(config.maturity).to.equal(0);
        });
      });

      // ── getMarketCount ────────────────────────────────────────────────

      describe("getMarketCount", () => {
        it("should return 1 after adding one market", async () => {
          const { adapter } = await loadFixture(baseFixture);

          expect(await adapter.getMarketCount()).to.equal(1);
        });
      });

      // ── getAllMarkets ──────────────────────────────────────────────────

      describe("getAllMarkets", () => {
        it("should return array with one market address", async () => {
          const { adapter, marketAddress } = await loadFixture(baseFixture);

          const markets = await adapter.getAllMarkets();
          expect(markets).to.have.lengthOf(1);
          expect(markets[0]).to.equal(marketAddress);
        });
      });

      // ── isMatured ─────────────────────────────────────────────────────

      describe("isMatured", () => {
        it("should return false before maturity", async () => {
          const { adapter, marketAddress } = await loadFixture(baseFixture);

          expect(await adapter.isMatured(marketAddress)).to.be.false;
        });

        it("should return true after maturity", async () => {
          const { adapter, marketAddress } = await loadFixture(maturedWithDepositsFixture);

          expect(await adapter.isMatured(marketAddress)).to.be.true;
        });
      });

      // ── isDelegated ───────────────────────────────────────────────────

      describe("isDelegated", () => {
        it("should return false when user has not delegated", async () => {
          const { adapter, user, marketAddress } = await loadFixture(baseFixture);

          expect(await adapter.isDelegated(marketAddress, user.address)).to.be.false;
        });

        it("should return true when user has delegated", async () => {
          const { adapter, user, comptroller, marketAddress } = await loadFixture(baseFixture);

          await comptroller.connect(user).updateDelegate(adapter.address, true);
          expect(await adapter.isDelegated(marketAddress, user.address)).to.be.true;
        });
      });

      // ── Immutable State ───────────────────────────────────────────────

      describe("immutable state", () => {
        it("should return the correct PENDLE_ROUTER address", async () => {
          const { adapter } = await loadFixture(baseFixture);

          expect(await adapter.PENDLE_ROUTER()).to.equal(PENDLE_ROUTER_V3);
        });

        it("should return the correct WBNB address", async () => {
          const { adapter } = await loadFixture(baseFixture);

          expect(await adapter.WBNB()).to.equal(WBNB);
        });
      });
    });
}

// Standalone: wrap in forking(). Index runner: register directly.
if (FORK_MAINNET) {
  if ((global as any).__PENDLE_INDEX_RUNNING) {
    describeTests();
  } else {
    forking(BLOCK_NUMBER, () => {
      describeTests();
    });
  }
}
