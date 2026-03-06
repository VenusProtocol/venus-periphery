import "@nomicfoundation/hardhat-chai-matchers";
import { impersonateAccount, loadFixture, setBalance } from "@nomicfoundation/hardhat-network-helpers";
import chai from "chai";
import { parseUnits } from "ethers/lib/utils";
import { ethers } from "hardhat";

import { FORK_MAINNET, forking } from "../../utils";
import {
  ACCESS_CONTROL_MANAGER,
  BLOCK_NUMBER,
  COMPTROLLER,
  FAKE_MARKET,
  NORMAL_TIMELOCK,
  PENDLE_MARKET,
  PENDLE_ROUTER_V3,
  PT_CLISBNBX_25JUN2026,
  SLISBNB,
  VTOKEN_PT_CLISBNBX_25JUN2026,
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

        const config = await adapter.markets(marketAddress);
        expect(config.pt).to.equal(PT_CLISBNBX_25JUN2026);
        expect(config.vToken).to.equal(VTOKEN_PT_CLISBNBX_25JUN2026);
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

        await expect(adapter.connect(owner).addMarket(marketAddress, VTOKEN_PT_CLISBNBX_25JUN2026))
          .to.be.revertedWithCustomError(adapter, "MarketAlreadyRegistered")
          .withArgs(marketAddress);
      });

      it("should revert with VTokenNotListed when vToken is not listed in Comptroller", async () => {
        const { adapter, owner } = await loadFixture(baseFixture);

        // Any address not listed in the Comptroller
        const NOT_LISTED_VTOKEN = "0x0000000000000000000000000000000000000123";

        await expect(adapter.connect(owner).addMarket(FAKE_MARKET, NOT_LISTED_VTOKEN))
          .to.be.revertedWithCustomError(adapter, "VTokenNotListed")
          .withArgs(NOT_LISTED_VTOKEN);
      });

      it("should revert with UnderlyingMismatch when vToken underlying does not match PT", async () => {
        // Deploy a fresh adapter without any registered markets
        const [owner] = await ethers.getSigners();

        const PendlePTVaultAdapter = await ethers.getContractFactory("PendlePTVaultAdapter");
        const implementation = await PendlePTVaultAdapter.deploy(PENDLE_ROUTER_V3, COMPTROLLER);
        await implementation.deployed();

        const proxyAdminAddress = "0x0000000000000000000000000000000000000001";
        const data = implementation.interface.encodeFunctionData("initialize", [ACCESS_CONTROL_MANAGER]);
        const TransparentUpgradeableProxy = await ethers.getContractFactory(
          "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol:TransparentUpgradeableProxy",
        );
        const proxy = await TransparentUpgradeableProxy.deploy(implementation.address, proxyAdminAddress, data);
        await proxy.deployed();

        const freshAdapter = await ethers.getContractAt("PendlePTVaultAdapter", proxy.address);

        // Grant addMarket permission to owner on the fresh adapter via NORMAL_TIMELOCK (holds DEFAULT_ADMIN_ROLE)
        const acm = await ethers.getContractAt(
          ["function giveCallPermission(address, string, address) external"],
          ACCESS_CONTROL_MANAGER,
        );
        await impersonateAccount(NORMAL_TIMELOCK);
        await setBalance(NORMAL_TIMELOCK, parseUnits("1", 18));
        const timelockSigner = await ethers.getSigner(NORMAL_TIMELOCK);
        await acm
          .connect(timelockSigner)
          .giveCallPermission(freshAdapter.address, "addMarket(address,address)", owner.address);

        // vUSDT from Venus core pool — its underlying() returns USDT, not PT
        const WRONG_VTOKEN = "0xfD5840Cd36d94D7229439859C0112a4185BC0255";

        await expect(freshAdapter.connect(owner).addMarket(PENDLE_MARKET, WRONG_VTOKEN))
          .to.be.revertedWithCustomError(freshAdapter, "UnderlyingMismatch")
          .withArgs(WRONG_VTOKEN, PT_CLISBNBX_25JUN2026);
      });

      it("should revert when called by unauthorized account", async () => {
        const { adapter, user } = await loadFixture(baseFixture);

        await expect(
          adapter.connect(user).addMarket(FAKE_MARKET, VTOKEN_PT_CLISBNBX_25JUN2026),
        ).to.be.revertedWithCustomError(adapter, "Unauthorized");
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

      it("should revert pause when called by unauthorized account", async () => {
        const { adapter, user } = await loadFixture(baseFixture);

        await expect(adapter.connect(user).pause()).to.be.revertedWithCustomError(adapter, "Unauthorized");
      });

      it("should revert unpause when called by unauthorized account", async () => {
        const { adapter, owner, user } = await loadFixture(baseFixture);

        await adapter.connect(owner).pause();
        await expect(adapter.connect(user).unpause()).to.be.revertedWithCustomError(adapter, "Unauthorized");
      });
    });

    // ── sweepTokens ───────────────────────────────────────────────────

    describe("sweepTokens", () => {
      it("should sweep ERC-20 tokens from adapter to specified address", async () => {
        const { adapter, owner, user, slisbnb } = await loadFixture(baseFixture);

        const sweepAmount = parseUnits("1", 18);

        // Send tokens to the adapter directly (simulates accidental transfer)
        await slisbnb.connect(user).transfer(adapter.address, sweepAmount);
        expect(await slisbnb.balanceOf(adapter.address)).to.equal(sweepAmount);

        // Sweep tokens to owner
        const ownerBalBefore = await slisbnb.balanceOf(owner.address);
        await adapter.connect(owner).sweepTokens(SLISBNB, owner.address, sweepAmount);
        const ownerBalAfter = await slisbnb.balanceOf(owner.address);

        expect(ownerBalAfter.sub(ownerBalBefore)).to.equal(sweepAmount);
        expect(await slisbnb.balanceOf(adapter.address)).to.equal(0);
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
          adapter.connect(owner).sweepTokens(SLISBNB, ethers.constants.AddressZero, parseUnits("1", 18)),
        ).to.be.revertedWithCustomError(adapter, "ZeroAddress");
      });

      it("should revert when called by non-owner", async () => {
        const { adapter, user } = await loadFixture(baseFixture);

        await expect(adapter.connect(user).sweepTokens(SLISBNB, user.address, parseUnits("1", 18))).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
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

        await expect(adapter.connect(user).sweepNative(user.address, parseUnits("1", 18))).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
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
