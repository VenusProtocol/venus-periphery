import "@nomicfoundation/hardhat-chai-matchers";
import { loadFixture, setBalance } from "@nomicfoundation/hardhat-network-helpers";
import chai from "chai";
import { parseUnits } from "ethers/lib/utils";
import { ethers } from "hardhat";

import { FORK_MAINNET, forking } from "../../utils";
import {
  BLOCK_NUMBER,
  CLISBNB,
  COMPTROLLER,
  FAKE_MARKET,
  PENDLE_MARKET,
  PENDLE_ROUTER_V3,
  VTOKEN_PT_CLISBNBX_25JUN2026,
  PT_CLISBNBX_25JUN2026,
  WBNB,
} from "../utils/constants";
import { baseFixture } from "../utils/fixtures";

const { expect } = chai;

function describeTests() {
  describe("PendlePTVaultAdapter - Admin Functions", () => {
      // ── addMarket ─────────────────────────────────────────────────────

      describe("addMarket", () => {
        it("should have added market with correct config and emitted MarketAdded", async () => {
          // baseFixture already adds the market; verify the config
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

        it("should revert with ZeroAddress when pendleMarket is zero", async () => {
          const { adapter, owner } = await loadFixture(baseFixture);

          await expect(
            adapter.connect(owner).addMarket(ethers.constants.AddressZero, VTOKEN_PT_CLISBNBX_25JUN2026),
          ).to.be.revertedWithCustomError(adapter, "ZeroAddress");
        });

        it("should revert with ZeroAddress when vToken is zero", async () => {
          const { adapter, owner } = await loadFixture(baseFixture);

          await expect(
            adapter.connect(owner).addMarket(FAKE_MARKET, ethers.constants.AddressZero),
          ).to.be.revertedWithCustomError(adapter, "ZeroAddress");
        });

        it("should revert with MarketAlreadyRegistered when adding same market twice", async () => {
          const { adapter, owner, marketAddress } = await loadFixture(baseFixture);

          await expect(
            adapter.connect(owner).addMarket(marketAddress, VTOKEN_PT_CLISBNBX_25JUN2026),
          )
            .to.be.revertedWithCustomError(adapter, "MarketAlreadyRegistered")
            .withArgs(marketAddress);
        });

        it("should revert with UnderlyingMismatch when vToken underlying does not match PT", async () => {
          // Deploy a fresh adapter without any registered markets
          const [owner] = await ethers.getSigners();

          const PendlePTVaultAdapter = await ethers.getContractFactory("PendlePTVaultAdapter");
          const implementation = await PendlePTVaultAdapter.deploy(PENDLE_ROUTER_V3, WBNB);
          await implementation.deployed();

          const proxyAdminAddress = "0x0000000000000000000000000000000000000001";
          const data = implementation.interface.encodeFunctionData("initialize", [owner.address]);
          const TransparentUpgradeableProxy = await ethers.getContractFactory(
            "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol:TransparentUpgradeableProxy",
          );
          const proxy = await TransparentUpgradeableProxy.deploy(implementation.address, proxyAdminAddress, data);
          await proxy.deployed();

          const freshAdapter = await ethers.getContractAt("PendlePTVaultAdapter", proxy.address);

          // vUSDT from Venus core pool — its underlying() returns USDT, not PT
          const WRONG_VTOKEN = "0xfD5840Cd36d94D7229439859C0112a4185BC0255";

          await expect(
            freshAdapter.connect(owner).addMarket(PENDLE_MARKET, WRONG_VTOKEN),
          )
            .to.be.revertedWithCustomError(freshAdapter, "UnderlyingMismatch")
            .withArgs(WRONG_VTOKEN, PT_CLISBNBX_25JUN2026);
        });

        it("should revert when called by non-owner", async () => {
          const { adapter, user } = await loadFixture(baseFixture);

          await expect(
            adapter.connect(user).addMarket(FAKE_MARKET, VTOKEN_PT_CLISBNBX_25JUN2026),
          ).to.be.revertedWith("Ownable: caller is not the owner");
        });
      });

      // ── deactivateMarket ──────────────────────────────────────────────

      describe("deactivateMarket", () => {
        it("should deactivate a market and emit MarketDeactivated", async () => {
          const { adapter, owner, marketAddress } = await loadFixture(baseFixture);

          await expect(adapter.connect(owner).deactivateMarket(marketAddress))
            .to.emit(adapter, "MarketDeactivated")
            .withArgs(marketAddress);

          const config = await adapter.getMarketConfig(marketAddress);
          expect(config.isActive).to.be.false;
        });

        it("should revert with MarketNotActive when market is already deactivated", async () => {
          const { adapter, owner, marketAddress } = await loadFixture(baseFixture);

          await adapter.connect(owner).deactivateMarket(marketAddress);

          await expect(adapter.connect(owner).deactivateMarket(marketAddress))
            .to.be.revertedWithCustomError(adapter, "MarketNotActive")
            .withArgs(marketAddress);
        });

        it("should revert with MarketNotRegistered for unregistered market", async () => {
          const { adapter, owner } = await loadFixture(baseFixture);

          await expect(adapter.connect(owner).deactivateMarket(FAKE_MARKET))
            .to.be.revertedWithCustomError(adapter, "MarketNotRegistered")
            .withArgs(FAKE_MARKET);
        });

        it("should revert when called by non-owner", async () => {
          const { adapter, user, marketAddress } = await loadFixture(baseFixture);

          await expect(adapter.connect(user).deactivateMarket(marketAddress)).to.be.revertedWith(
            "Ownable: caller is not the owner",
          );
        });
      });

      // ── activateMarket ────────────────────────────────────────────────

      describe("activateMarket", () => {
        it("should re-activate a deactivated market and emit MarketActivated", async () => {
          const { adapter, owner, marketAddress } = await loadFixture(baseFixture);

          // Deactivate first
          await adapter.connect(owner).deactivateMarket(marketAddress);
          expect((await adapter.getMarketConfig(marketAddress)).isActive).to.be.false;

          // Re-activate
          await expect(adapter.connect(owner).activateMarket(marketAddress))
            .to.emit(adapter, "MarketActivated")
            .withArgs(marketAddress);

          expect((await adapter.getMarketConfig(marketAddress)).isActive).to.be.true;
        });

        it("should revert with MarketAlreadyActive when market is already active", async () => {
          const { adapter, owner, marketAddress } = await loadFixture(baseFixture);

          // Market is active by default after addMarket
          await expect(adapter.connect(owner).activateMarket(marketAddress))
            .to.be.revertedWithCustomError(adapter, "MarketAlreadyActive")
            .withArgs(marketAddress);
        });

        it("should revert with MarketNotRegistered for unregistered market", async () => {
          const { adapter, owner } = await loadFixture(baseFixture);

          await expect(adapter.connect(owner).activateMarket(FAKE_MARKET))
            .to.be.revertedWithCustomError(adapter, "MarketNotRegistered")
            .withArgs(FAKE_MARKET);
        });

        it("should revert when called by non-owner", async () => {
          const { adapter, user, marketAddress } = await loadFixture(baseFixture);

          await expect(adapter.connect(user).activateMarket(marketAddress)).to.be.revertedWith(
            "Ownable: caller is not the owner",
          );
        });
      });

      // ── pause / unpause ───────────────────────────────────────────────

      describe("pause / unpause", () => {
        it("should pause the contract", async () => {
          const { adapter, owner } = await loadFixture(baseFixture);

          await adapter.connect(owner).pause();
          expect(await adapter.paused()).to.be.true;
        });

        it("should unpause the contract", async () => {
          const { adapter, owner } = await loadFixture(baseFixture);

          await adapter.connect(owner).pause();
          await adapter.connect(owner).unpause();
          expect(await adapter.paused()).to.be.false;
        });

        it("should revert pause when called by non-owner", async () => {
          const { adapter, user } = await loadFixture(baseFixture);

          await expect(adapter.connect(user).pause()).to.be.revertedWith("Ownable: caller is not the owner");
        });

        it("should revert unpause when called by non-owner", async () => {
          const { adapter, owner, user } = await loadFixture(baseFixture);

          await adapter.connect(owner).pause();
          await expect(adapter.connect(user).unpause()).to.be.revertedWith("Ownable: caller is not the owner");
        });
      });

      // ── sweepTokens ───────────────────────────────────────────────────

      describe("sweepTokens", () => {
        it("should sweep ERC-20 tokens from adapter to specified address", async () => {
          const { adapter, owner, user, clisbnb } = await loadFixture(baseFixture);

          const sweepAmount = parseUnits("1", 18);

          // Send tokens to the adapter directly (simulates accidental transfer)
          await clisbnb.connect(user).transfer(adapter.address, sweepAmount);
          expect(await clisbnb.balanceOf(adapter.address)).to.equal(sweepAmount);

          // Sweep tokens to owner
          const ownerBalBefore = await clisbnb.balanceOf(owner.address);
          await adapter.connect(owner).sweepTokens(CLISBNB, owner.address, sweepAmount);
          const ownerBalAfter = await clisbnb.balanceOf(owner.address);

          expect(ownerBalAfter.sub(ownerBalBefore)).to.equal(sweepAmount);
          expect(await clisbnb.balanceOf(adapter.address)).to.equal(0);
        });

        it("should revert with ZeroAddress when token is zero", async () => {
          const { adapter, owner } = await loadFixture(baseFixture);

          await expect(
            adapter.connect(owner).sweepTokens(ethers.constants.AddressZero, owner.address, parseUnits("1", 18)),
          ).to.be.revertedWithCustomError(adapter, "ZeroAddress");
        });

        it("should revert with ZeroAddress when to is zero", async () => {
          const { adapter, owner } = await loadFixture(baseFixture);

          await expect(
            adapter.connect(owner).sweepTokens(CLISBNB, ethers.constants.AddressZero, parseUnits("1", 18)),
          ).to.be.revertedWithCustomError(adapter, "ZeroAddress");
        });

        it("should revert when called by non-owner", async () => {
          const { adapter, user } = await loadFixture(baseFixture);

          await expect(
            adapter.connect(user).sweepTokens(CLISBNB, user.address, parseUnits("1", 18)),
          ).to.be.revertedWith("Ownable: caller is not the owner");
        });
      });

      // ── sweepNative ─────────────────────────────────────────────────

      describe("sweepNative", () => {
        it("should sweep native BNB from adapter to specified address", async () => {
          const { adapter, owner, user } = await loadFixture(baseFixture);

          const amount = parseUnits("1", 18);

          // Directly set adapter's native BNB balance (simulates accidental transfer)
          await setBalance(adapter.address, amount);
          expect(await ethers.provider.getBalance(adapter.address)).to.equal(amount);

          // Sweep native BNB to user
          const userBalBefore = await ethers.provider.getBalance(user.address);
          await adapter.connect(owner).sweepNative(user.address, amount);
          const userBalAfter = await ethers.provider.getBalance(user.address);

          expect(userBalAfter.sub(userBalBefore)).to.equal(amount);
          expect(await ethers.provider.getBalance(adapter.address)).to.equal(0);
        });

        it("should revert with ZeroAddress when to is zero", async () => {
          const { adapter, owner } = await loadFixture(baseFixture);

          await expect(
            adapter.connect(owner).sweepNative(ethers.constants.AddressZero, parseUnits("1", 18)),
          ).to.be.revertedWithCustomError(adapter, "ZeroAddress");
        });

        it("should revert when called by non-owner", async () => {
          const { adapter, user } = await loadFixture(baseFixture);

          await expect(
            adapter.connect(user).sweepNative(user.address, parseUnits("1", 18)),
          ).to.be.revertedWith("Ownable: caller is not the owner");
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
