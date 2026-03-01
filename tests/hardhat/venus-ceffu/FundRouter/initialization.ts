import { FakeContract, smock } from "@defi-wonderland/smock";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import chai from "chai";
import { ethers, upgrades } from "hardhat";

import { FundRouter, IAccessControlManagerV8, VaultFactory } from "../../../../typechain";
import { deployFullSystemFixture } from "../fixtures";

const { expect } = chai;
chai.use(smock.matchers);

describe("FundRouter - Initialization", () => {
  let _owner: SignerWithAddress;
  let acm: FakeContract<IAccessControlManagerV8>;
  let fundRouter: FundRouter;
  let factory: VaultFactory;

  beforeEach(async () => {
    ({ owner: _owner, acm, fundRouter, factory } = await loadFixture(deployFullSystemFixture));
    acm.isAllowedToCall.returns(true);
  });

  describe("initialize()", () => {
    it("sets vaultFactory address", async () => {
      expect(await fundRouter.vaultFactory()).to.equal(factory.address);
    });

    it("sets accessControlManager", async () => {
      expect(await fundRouter.accessControlManager()).to.equal(acm.address);
    });

    it("starts unpaused", async () => {
      expect(await fundRouter.paused()).to.equal(false);
    });

    it("reverts on re-initialization", async () => {
      await expect(fundRouter.initialize(acm.address, factory.address)).to.be.revertedWith(
        "Initializable: contract is already initialized",
      );
    });

    it("reverts if vaultFactory_ is zero address", async () => {
      const FundRouterFactory = await ethers.getContractFactory("FundRouter");
      await expect(
        upgrades.deployProxy(FundRouterFactory, [acm.address, ethers.constants.AddressZero], {
          unsafeAllow: ["constructor"],
        }),
      ).to.be.revertedWithCustomError(fundRouter, "ZeroAddressNotAllowed");
    });

    it("implementation contract cannot be initialized", async () => {
      const FundRouterFactory = await ethers.getContractFactory("FundRouter");
      const impl = (await FundRouterFactory.deploy()) as FundRouter;

      await expect(impl.initialize(acm.address, factory.address)).to.be.revertedWith(
        "Initializable: contract is already initialized",
      );
    });
  });
});
